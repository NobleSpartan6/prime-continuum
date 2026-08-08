import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  extractEmbeddedRuntimeAttestation,
  parseRuntimeAttestation,
} from "./runtime-attestation-lib.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOSTD_PATH = resolve(REPO_ROOT, "out", "hostd", "hostd.cjs");
const RUNTIME_SEED_ROOT = resolve(
  process.env.PRIME_CONTINUIM_RUNTIME_SEED_ROOT ?? resolve(REPO_ROOT, "out", "runtime"),
);
const ATTESTATION_PATH = resolve(REPO_ROOT, "out", "main", "runtime-attestation.json");
const HOST_REQUEST_DEADLINE_MS = 3_000;
const LIFECYCLE_REQUEST_DEADLINE_MS = 180_000;
const READY_DEADLINE_MS = 180_000;
const HELPER_DEADLINE_MS = 60_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const PROJECT_ID = "resident-smoke-project";
const WORKSPACE_ID = "resident-smoke-workspace";
const THREAD_ID = "resident-smoke-thread";
const EXECUTION_GENERATION_ID = "resident-smoke-execution-1";
const PROVISION_OPERATION_ID = "resident-smoke-provision-1";
const STALE_END_OPERATION_ID = "resident-smoke-end-stale-cursor-1";
const END_OPERATION_ID = "resident-smoke-end-1";
const STALE_END_ERROR = Object.freeze({
  code: "RESIDENT_END_SOURCE_CURSOR_CHANGED",
  message: "Resident state changed after end consent was reviewed; refresh the thread and confirm again",
  retryable: false,
});
const RESIDENT_COMMAND_CAPABILITY = "prime_agent_commands_v2";
const RESIDENT_LIFECYCLE_CAPABILITY = "resident_lifecycle_v1";
const EXPECTED_BASE_CAPABILITIES = Object.freeze([
  RESIDENT_LIFECYCLE_CAPABILITY,
  "runtime_integrity_v1",
  "runtime_model_catalog_v1",
  "snapshot_chunks_v1",
].sort());

const require = createRequire(import.meta.url);
const electronExecutable = resolve(require("electron"));
const temporaryRoot = await mkdtemp(join(tmpdir(), "prime-continuim-resident-lifecycle-smoke-"));
const hostdWrapperPath = join(temporaryRoot, "hostd-smoke-wrapper.cjs");
const daemonAuditPath = join(temporaryRoot, "daemon-audit.mjs");
const requestedDataDirectory = join(temporaryRoot, "host-data");
const requestedWorkspaceDirectory = join(temporaryRoot, "workspace");
const agentDirectory = join(temporaryRoot, "prime-agent-home");

await Promise.all([
  mkdir(requestedDataDirectory, { recursive: true, mode: 0o700 }),
  mkdir(requestedWorkspaceDirectory, { recursive: true, mode: 0o700 }),
  mkdir(agentDirectory, { recursive: true, mode: 0o700 }),
]);
const dataDirectory = await realpath(requestedDataDirectory);
const workspaceDirectory = await realpath(requestedWorkspaceDirectory);
const hostEndpoint = localHostEndpoint(dataDirectory);
const residentEndpoint = residentDaemonEndpoint(dataDirectory);
await Promise.all([
  writeFile(hostdWrapperPath, hostdSmokeWrapperSource(), { encoding: "utf8", mode: 0o600, flag: "wx" }),
  writeFile(daemonAuditPath, daemonAuditSource(), { encoding: "utf8", mode: 0o600, flag: "wx" }),
]);

const attestationBytes = await readFile(ATTESTATION_PATH);
const attestation = parseRuntimeAttestation(attestationBytes);
const embeddedBytes = extractEmbeddedRuntimeAttestation(await readFile(HOSTD_PATH));
if (!embeddedBytes.equals(attestationBytes)) {
  throw new Error("Release hostd does not embed the exact generated runtime attestation bytes");
}
if (attestation.runtime.platform !== process.platform || attestation.runtime.arch !== process.arch) {
  throw new Error("Runtime attestation does not target this smoke platform and architecture");
}
await assertExactSeedRoot(RUNTIME_SEED_ROOT);
await stat(electronExecutable);

const credentialFree = credentialFreeRunAsNodeEnvironment(process.env, agentDirectory);
const createdAt = new Date().toISOString();
let hostdChild;
let runtimeRoot;
let daemonObserved = false;
let credentialFileState = "absent";

const provisionRequest = Object.freeze({
  expectedHostId: "pending-host-identity",
  operationId: PROVISION_OPERATION_ID,
  projectId: PROJECT_ID,
  workspaceId: WORKSPACE_ID,
  threadId: THREAD_ID,
  executionGenerationId: EXECUTION_GENERATION_ID,
  workspaceDirectory,
  projectDisplayName: "Resident lifecycle smoke",
  threadTitle: "Credential-free resident lifecycle",
  createdAt,
  sessionName: "Continuim production lifecycle smoke",
});
const endRequest = Object.freeze({
  expectedHostId: "pending-host-identity",
  operationId: END_OPERATION_ID,
  projectId: PROJECT_ID,
  workspaceId: WORKSPACE_ID,
  threadId: THREAD_ID,
  executionGenerationId: EXECUTION_GENERATION_ID,
});

try {
  // Pass 1: a release-built, empty host must advertise lifecycle readiness
  // before any resident binding exists.
  hostdChild = await startReleaseHostd(credentialFree.environment);
  const zeroBinding = await waitForResidentReadiness(hostdChild, false);
  const hostId = zeroBinding.health.host?.hostId;
  if (typeof hostId !== "string" || hostId.length < 1) {
    throw new Error("Empty release hostd did not publish a stable host identity");
  }
  const exactProvisionRequest = Object.freeze({ ...provisionRequest, expectedHostId: hostId });
  const emptyCatalog = await requestHost(
    hostEndpoint,
    "catalog.snapshot",
    {},
    HOST_REQUEST_DEADLINE_MS,
  );
  assertEmptyCatalog(emptyCatalog.result, hostId);
  await assertBindingRegistry("empty");
  assertPathFree(emptyCatalog.result, "empty catalog");

  runtimeRoot = await resolveInstalledRuntimeRoot(zeroBinding.health.runtimeIntegrity);
  credentialFileState = await assertCredentialStoreEmpty();

  // Provision may start the private daemon before returning. Arm cleanup at
  // the mutation boundary so even a failed/unknown response cannot leak it.
  daemonObserved = true;
  const provision = await requestHost(
    hostEndpoint,
    "resident.provision",
    exactProvisionRequest,
    LIFECYCLE_REQUEST_DEADLINE_MS,
  );
  const committed = assertLifecycleStatus(
    provision.result,
    "provision",
    "committed",
    exactProvisionRequest,
  );
  assertPathFree(committed, "resident provision result");
  const provisionLookup = await lookupLifecycle(hostId, PROVISION_OPERATION_ID);
  assertExactJson(provisionLookup, committed, "Committed provision status changed on lookup");

  const firstReady = await waitForResidentReadiness(hostdChild, true);
  assertSameRuntimeIdentity(zeroBinding.health, firstReady.health);
  const firstCatalog = await requestHost(hostEndpoint, "catalog.snapshot", {}, HOST_REQUEST_DEADLINE_MS);
  assertMaterializedCatalog(firstCatalog.result, hostId, "idle");
  const firstSnapshotResponse = await requestHost(
    hostEndpoint,
    "thread.snapshot",
    { threadId: THREAD_ID },
    HOST_REQUEST_DEADLINE_MS,
  );
  const firstProjection = assertActiveProjection(firstSnapshotResponse.result, hostId);
  assertPathFree(firstCatalog.result, "materialized catalog");
  assertPathFree(firstProjection, "active resident projection");
  const activeBinding = await assertBindingRegistry("active", firstProjection.runtime);
  const firstDaemonAudit = await inspectResidentDaemon(runtimeRoot, "list", credentialFree.environment);
  assertSingleDaemonSession(firstDaemonAudit, activeBinding);
  credentialFileState = await assertCredentialStoreEmpty();

  await stopHostd(hostdChild);
  hostdChild = undefined;

  // Pass 2: restart must attach the exact existing resident. Replaying the
  // immutable provision request must return the durable terminal result and
  // must not create an orphan or replacement upstream session.
  hostdChild = await startReleaseHostd(credentialFree.environment);
  const restartedReady = await waitForResidentReadiness(hostdChild, true);
  assertSameRuntimeIdentity(firstReady.health, restartedReady.health);
  if (restartedReady.health.host.hostId !== hostId) {
    throw new Error("Release host authority changed across resident restart");
  }
  const restartedProjectionResponse = await requestHost(
    hostEndpoint,
    "thread.snapshot",
    { threadId: THREAD_ID },
    HOST_REQUEST_DEADLINE_MS,
  );
  const restartedProjection = assertActiveProjection(restartedProjectionResponse.result, hostId);
  assertSameResidentIdentity(firstProjection.runtime, restartedProjection.runtime, "restart attachment");
  const replayedProvision = await requestHost(
    hostEndpoint,
    "resident.provision",
    exactProvisionRequest,
    LIFECYCLE_REQUEST_DEADLINE_MS,
  );
  assertExactJson(replayedProvision.result, committed, "Provision replay changed its terminal result");
  const restartDaemonAudit = await inspectResidentDaemon(runtimeRoot, "list", credentialFree.environment);
  assertSingleDaemonSession(restartDaemonAudit, activeBinding);
  await assertBindingRegistry("active", firstProjection.runtime, activeBinding);

  // End uses the same trusted-user protocol and production coordinator. The
  // only direct daemon access below is read-only audit plus final cleanup.
  const preEndSnapshotResponse = await requestHost(
    hostEndpoint,
    "thread.snapshot",
    { threadId: THREAD_ID },
    HOST_REQUEST_DEADLINE_MS,
  );
  const preEndProjection = assertActiveProjection(preEndSnapshotResponse.result, hostId);
  assertSameResidentIdentity(firstProjection.runtime, preEndProjection.runtime, "pre-end authority fence");
  const reviewedSourceCursor = freezeExactSourceCursor(preEndProjection.latestCursor);
  const preStaleLifecycleDurability = await snapshotResidentLifecycleDurability();
  const staleEndRequest = Object.freeze({
    ...endRequest,
    expectedHostId: hostId,
    operationId: STALE_END_OPERATION_ID,
    expectedSourceCursor: driftSourceCursor(reviewedSourceCursor),
  });
  await assertHostProtocolError(
    requestHost(
      hostEndpoint,
      "resident.end",
      staleEndRequest,
      LIFECYCLE_REQUEST_DEADLINE_MS,
    ),
    STALE_END_ERROR,
  );
  if (await lookupLifecycleOptional(hostId, STALE_END_OPERATION_ID) !== null) {
    throw new Error("Stale resident end consent created a lifecycle WAL record");
  }
  assertExactJson(
    await snapshotResidentLifecycleDurability(),
    preStaleLifecycleDurability,
    "Stale resident end consent changed lifecycle or retirement durability",
  );
  const postStaleSnapshotResponse = await requestHost(
    hostEndpoint,
    "thread.snapshot",
    { threadId: THREAD_ID },
    HOST_REQUEST_DEADLINE_MS,
  );
  assertExactJson(
    postStaleSnapshotResponse.result,
    preEndProjection,
    "Stale resident end consent changed the authoritative projection",
  );
  const postStaleHealth = await requestHost(hostEndpoint, "health.get", {}, HOST_REQUEST_DEADLINE_MS);
  assertReadyRuntimeHealth(postStaleHealth.result, true);
  await assertBindingRegistry("active", firstProjection.runtime, activeBinding);
  const staleEndDaemonAudit = await inspectResidentDaemon(runtimeRoot, "list", credentialFree.environment);
  assertSingleDaemonSession(staleEndDaemonAudit, activeBinding);

  const expectedSourceCursor = freezeExactSourceCursor(postStaleSnapshotResponse.result.latestCursor);
  const exactEndRequest = Object.freeze({
    ...endRequest,
    expectedHostId: hostId,
    expectedSourceCursor,
  });
  const discardedEndResponse = await requestHostAndDiscardResponse(
    hostEndpoint,
    "resident.end",
    exactEndRequest,
    LIFECYCLE_REQUEST_DEADLINE_MS,
  );
  const recoveredEndStatus = await lookupLifecycle(hostId, END_OPERATION_ID);
  const completed = assertLifecycleStatus(
    recoveredEndStatus,
    "end",
    "completed",
    exactEndRequest,
  );
  assertPathFree(completed, "resident end result");
  const endLookup = await lookupLifecycle(hostId, END_OPERATION_ID);
  assertExactJson(endLookup, completed, "Completed end status changed on lookup");
  const replayedEnd = await requestHost(
    hostEndpoint,
    "resident.end",
    exactEndRequest,
    LIFECYCLE_REQUEST_DEADLINE_MS,
  );
  assertExactJson(replayedEnd.result, completed, "Resident end replay changed its terminal result");

  const endedReady = await waitForResidentReadiness(hostdChild, false);
  const terminalSnapshotResponse = await requestHost(
    hostEndpoint,
    "thread.snapshot",
    { threadId: THREAD_ID },
    HOST_REQUEST_DEADLINE_MS,
  );
  const terminalProjection = assertTerminalProjection(
    terminalSnapshotResponse.result,
    hostId,
    preEndProjection,
    activeBinding,
  );
  assertExactJson(
    terminalProjection.residentLifecycle.sourceCursor,
    expectedSourceCursor,
    "Terminal resident disposition changed its reviewed source cursor",
  );
  const terminalCatalog = await requestHost(hostEndpoint, "catalog.snapshot", {}, HOST_REQUEST_DEADLINE_MS);
  assertMaterializedCatalog(terminalCatalog.result, hostId, "idle");
  const terminalCatalogThread = terminalCatalog.result.threads.find(
    (candidate) => candidate.threadId === THREAD_ID,
  );
  if (!isDeepStrictEqual(terminalCatalogThread, terminalProjection.thread)) {
    throw new Error("Terminal catalog thread differs from the exact terminal snapshot thread");
  }
  assertPathFree(terminalProjection, "terminal resident projection");
  assertPathFree(terminalCatalog.result, "terminal catalog");
  await assertBindingRegistry("completed", firstProjection.runtime, activeBinding);
  const endedDaemonAudit = await inspectResidentDaemon(runtimeRoot, "list", credentialFree.environment);
  assertNoDaemonSessions(endedDaemonAudit);

  await stopHostd(hostdChild);
  hostdChild = undefined;

  // Pass 3: completed state must survive a second restart. Both immutable
  // lifecycle requests are deliberately retried; neither may restore command
  // authority, a binding, a runtime projection, or an upstream session.
  hostdChild = await startReleaseHostd(credentialFree.environment);
  const terminalRestartReady = await waitForResidentReadiness(hostdChild, false);
  assertSameRuntimeIdentity(endedReady.health, terminalRestartReady.health);
  if (terminalRestartReady.health.host.hostId !== hostId) {
    throw new Error("Release host authority changed across terminal restart");
  }
  assertExactJson(
    await lookupLifecycle(hostId, PROVISION_OPERATION_ID),
    committed,
    "Provision terminal status changed across final restart",
  );
  assertExactJson(
    await lookupLifecycle(hostId, END_OPERATION_ID),
    completed,
    "End terminal status changed across final restart",
  );
  if (await lookupLifecycleOptional(hostId, STALE_END_OPERATION_ID) !== null) {
    throw new Error("Rejected stale resident end consent appeared after restart");
  }
  const terminalProvisionReplay = await requestHost(
    hostEndpoint,
    "resident.provision",
    exactProvisionRequest,
    LIFECYCLE_REQUEST_DEADLINE_MS,
  );
  assertExactJson(
    terminalProvisionReplay.result,
    committed,
    "Completed binding was recreated by provision replay",
  );
  const terminalEndReplay = await requestHost(
    hostEndpoint,
    "resident.end",
    exactEndRequest,
    LIFECYCLE_REQUEST_DEADLINE_MS,
  );
  assertExactJson(terminalEndReplay.result, completed, "Completed end replay crossed root kill again");
  const finalHealth = await requestHost(hostEndpoint, "health.get", {}, HOST_REQUEST_DEADLINE_MS);
  assertReadyRuntimeHealth(finalHealth.result, false);
  const finalSnapshotResponse = await requestHost(
    hostEndpoint,
    "thread.snapshot",
    { threadId: THREAD_ID },
    HOST_REQUEST_DEADLINE_MS,
  );
  const finalProjection = assertTerminalProjection(
    finalSnapshotResponse.result,
    hostId,
    preEndProjection,
    activeBinding,
  );
  assertExactJson(
    finalProjection,
    terminalProjection,
    "Terminal resident projection changed across restart and replay",
  );
  const finalCatalog = await requestHost(hostEndpoint, "catalog.snapshot", {}, HOST_REQUEST_DEADLINE_MS);
  const finalCatalogThread = finalCatalog.result.threads.find(
    (candidate) => candidate.threadId === THREAD_ID,
  );
  if (!isDeepStrictEqual(finalCatalogThread, finalProjection.thread)) {
    throw new Error("Restarted catalog thread differs from the exact terminal snapshot thread");
  }
  assertExactJson(
    durableCatalogProjection(finalCatalog.result),
    durableCatalogProjection(terminalCatalog.result),
    "Terminal resident catalog changed across restart and replay",
  );
  assertPathFree(finalProjection, "terminal projection after restart and replay");
  assertPathFree(finalCatalog.result, "terminal catalog after restart and replay");
  await assertBindingRegistry("completed", firstProjection.runtime, activeBinding);
  const finalDaemonAudit = await inspectResidentDaemon(runtimeRoot, "list", credentialFree.environment);
  assertNoDaemonSessions(finalDaemonAudit);
  credentialFileState = await assertCredentialStoreEmpty();

  await stopHostd(hostdChild);
  hostdChild = undefined;
  const daemonShutdown = await inspectResidentDaemon(runtimeRoot, "shutdown", credentialFree.environment);
  daemonObserved = false;
  if (daemonShutdown.shutdownConfirmed !== true) {
    throw new Error("Resident daemon did not confirm final smoke cleanup");
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 2,
    assurance: attestation.assurance,
    runtime: {
      releaseVersion: attestation.runtime.releaseVersion,
      runtimeBuildId: attestation.runtime.runtimeBuildId,
      treeSha256: attestation.tree.sha256,
      manifestSha256: attestation.manifest.sha256,
    },
    credentialIsolation: {
      isolatedAgentDirectory: true,
      credentialFileState,
      credentialMaterialPresent: false,
      strippedCredentialVariableCount: credentialFree.strippedCredentialVariableCount,
      promptSent: false,
    },
    zeroBindingReadiness: {
      capability: RESIDENT_LIFECYCLE_CAPABILITY,
      residentCommandCapabilityAbsent: true,
      emptyCatalog: true,
      readyMs: zeroBinding.readyMs,
      healthSamples: zeroBinding.samples,
    },
    productionLifecycle: {
      transport: "trusted_user_local_protocol",
      parentProcessIsolationAcrossPasses: true,
      provisionPhase: committed.phase,
      exactProjectionCommitted: true,
      pinnedRuntimeCompatibilityVerified: true,
      commandCapabilityAfterProvision: true,
      restartedAndReattached: true,
      provisionReplaySuppressed: true,
      staleSourceCursorRejectedBeforeWal: true,
      staleSourceCursorPreservedBindingAndSession: true,
      staleSourceCursorRemainedAbsentAfterRestart: true,
      endPhase: completed.phase,
      endResponseDiscardedAfterFirstByte: discardedEndResponse.responseBytesObserved >= 1,
      completedRecoveredByStatus: true,
      terminalProjectionMaterialized: true,
      activeBindingAbsentAfterEnd: true,
      commandCapabilityAfterEnd: false,
      endReplaySuppressed: true,
      terminalRestartVerified: true,
    },
    upstreamAudit: {
      mode: "read_only_list",
      sessionsAfterProvision: firstDaemonAudit.sessions.length,
      sessionsAfterRestart: restartDaemonAudit.sessions.length,
      sessionsAfterStaleEndConsent: staleEndDaemonAudit.sessions.length,
      sessionsAfterEnd: endedDaemonAudit.sessions.length,
      sessionsAfterTerminalRestart: finalDaemonAudit.sessions.length,
      daemonShutdownConfirmed: true,
    },
  }, null, 2)}\n`);
} finally {
  if (hostdChild) await stopHostd(hostdChild).catch(() => hostdChild?.kill());
  if (daemonObserved && runtimeRoot) {
    await inspectResidentDaemon(runtimeRoot, "shutdown", credentialFree.environment).catch(() => undefined);
  }
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  }).catch(() => undefined);
}

async function startReleaseHostd(environment) {
  const child = spawn(
    electronExecutable,
    [
      hostdWrapperPath,
      HOSTD_PATH,
      "serve",
      "--socket",
      hostEndpoint,
      "--data-dir",
      dataDirectory,
      "--runtime-seed",
      RUNTIME_SEED_ROOT,
    ],
    {
      cwd: REPO_ROOT,
      detached: false,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
      env: environment,
    },
  );
  child.stderrTail = Buffer.alloc(0);
  child.stderr?.on("data", (chunk) => {
    child.stderrTail = Buffer.concat([child.stderrTail, Buffer.from(chunk)]).subarray(-64 * 1024);
  });
  await onceSpawned(child);
  return child;
}

async function waitForResidentReadiness(child, expectCommandCapability) {
  const startedAt = Date.now();
  const deadline = startedAt + READY_DEADLINE_MS;
  let samples = 0;
  let lastHealth;
  let lastError;
  while (Date.now() < deadline) {
    assertChildAlive(child);
    try {
      const response = await requestHost(hostEndpoint, "health.get", {}, HOST_REQUEST_DEADLINE_MS);
      samples += 1;
      lastHealth = response.result;
      const runtime = lastHealth?.runtimeIntegrity;
      if (runtime?.status === "failed" || runtime?.status === "unavailable") {
        throw new Error(`Runtime initialization failed with ${runtime.code ?? runtime.status}`);
      }
      if (
        runtime?.status === "ready" &&
        lastHealth.capabilities?.includes(RESIDENT_LIFECYCLE_CAPABILITY) &&
        lastHealth.capabilities.includes(RESIDENT_COMMAND_CAPABILITY) === expectCommandCapability
      ) {
        assertReadyRuntimeHealth(lastHealth, expectCommandCapability);
        return {
          health: lastHealth,
          readyMs: Date.now() - startedAt,
          samples,
        };
      }
    } catch (error) {
      lastError = error;
      if (/Runtime initialization failed/.test(errorMessage(error))) throw error;
    }
    await delay(100);
  }
  throw new Error(
    `Release hostd did not reach resident readiness with command capability ${expectCommandCapability ? "present" : "absent"}; ` +
      `${errorMessage(lastError)}; ${child.stderrTail.toString("utf8")}`,
  );
}

function assertReadyRuntimeHealth(health, expectCommandCapability) {
  if (!health || health.protocolVersion !== 1 || health.serviceState !== "ready") {
    throw new Error("Release hostd returned an invalid ready health identity");
  }
  const runtime = health.runtimeIntegrity;
  if (!runtime || runtime.contractVersion !== 1 || runtime.status !== "ready") {
    throw new Error("Release hostd runtime integrity is not ready");
  }
  const expectedTarget = {
    runtime: "prime-agent",
    releaseVersion: attestation.runtime.releaseVersion,
    runtimeBuildId: attestation.runtime.runtimeBuildId,
    platform: attestation.runtime.platform,
    arch: attestation.runtime.arch,
    manifestSha256: attestation.manifest.sha256,
    treeSha256: attestation.tree.sha256,
    filesSha256: attestation.tree.filesSha256,
  };
  if (JSON.stringify(runtime.target) !== JSON.stringify(expectedTarget)) {
    throw new Error("Ready runtime target differs from the embedded attestation");
  }
  const expectedTrustAnchor = createHash("sha256").update(attestationBytes).digest("hex");
  if (runtime.trustAnchorId !== expectedTrustAnchor || runtime.assurance !== attestation.assurance) {
    throw new Error("Ready runtime trust identity differs from the embedded attestation");
  }
  if (!Array.isArray(health.capabilities)) throw new Error("Ready health capabilities are invalid");
  const hasCommands = health.capabilities.includes(RESIDENT_COMMAND_CAPABILITY);
  if (hasCommands !== expectCommandCapability) {
    throw new Error("Ready health resident command capability differs from exact binding state");
  }
  const base = health.capabilities.filter((capability) => capability !== RESIDENT_COMMAND_CAPABILITY).sort();
  if (JSON.stringify(base) !== JSON.stringify(EXPECTED_BASE_CAPABILITIES)) {
    throw new Error(`Ready health capabilities changed: ${health.capabilities.join(", ")}`);
  }
  assertPathFree(health, "ready health");
}

function assertSameRuntimeIdentity(leftHealth, rightHealth) {
  const identity = (health) => JSON.stringify({
    hostId: health.host?.hostId,
    assurance: health.runtimeIntegrity?.assurance,
    trustAnchorId: health.runtimeIntegrity?.trustAnchorId,
    target: health.runtimeIntegrity?.target,
  });
  if (identity(leftHealth) !== identity(rightHealth)) {
    throw new Error("Release runtime or host identity changed across restart");
  }
}

function assertEmptyCatalog(catalog, hostId) {
  if (
    !catalog ||
    catalog.snapshotVersion !== 1 ||
    catalog.host?.hostId !== hostId ||
    !Array.isArray(catalog.projects) ||
    catalog.projects.length !== 0 ||
    !Array.isArray(catalog.threads) ||
    catalog.threads.length !== 0
  ) {
    throw new Error("Release hostd did not start with an exact empty catalog");
  }
}

function assertMaterializedCatalog(catalog, hostId, expectedStatus) {
  const project = catalog?.projects?.find((candidate) => candidate.projectId === PROJECT_ID);
  const thread = catalog?.threads?.find((candidate) => candidate.threadId === THREAD_ID);
  if (
    catalog?.snapshotVersion !== 1 ||
    catalog.host?.hostId !== hostId ||
    catalog.projects?.length !== 1 ||
    catalog.threads?.length !== 1 ||
    project?.hostId !== hostId ||
    project.workspaceId !== WORKSPACE_ID ||
    thread?.projectIdentity !== PROJECT_ID ||
    thread.status !== expectedStatus ||
    thread.currentLocation?.hostId !== hostId ||
    thread.currentLocation.projectId !== PROJECT_ID ||
    thread.currentLocation.workspaceId !== WORKSPACE_ID ||
    thread.currentLocation.executionGenerationId !== EXECUTION_GENERATION_ID
  ) {
    throw new Error(`Release catalog did not materialize the exact ${expectedStatus} resident thread`);
  }
}

function durableCatalogProjection(catalog) {
  return {
    snapshotVersion: catalog?.snapshotVersion,
    hostId: catalog?.host?.hostId,
    projects: catalog?.projects,
    threads: catalog?.threads,
  };
}

function assertActiveProjection(snapshot, hostId) {
  if (
    !snapshot ||
    snapshot.thread?.threadId !== THREAD_ID ||
    snapshot.thread?.projectIdentity !== PROJECT_ID ||
    snapshot.thread?.currentLocation?.hostId !== hostId ||
    snapshot.thread.currentLocation.projectId !== PROJECT_ID ||
    snapshot.thread.currentLocation.workspaceId !== WORKSPACE_ID ||
    snapshot.thread.currentLocation.executionGenerationId !== EXECUTION_GENERATION_ID ||
    snapshot.thread.status !== "idle" ||
    snapshot.runtime?.runtime !== "prime_agent" ||
    snapshot.runtime.residency !== "resident" ||
    snapshot.residentLifecycle !== undefined ||
    typeof snapshot.runtime.activeSessionId !== "string" ||
    snapshot.runtime.activeSessionId.length < 1 ||
    typeof snapshot.runtime.sessionId !== "string" ||
    snapshot.runtime.sessionId.length < 1 ||
    snapshot.latestCursor?.threadId !== THREAD_ID ||
    snapshot.latestCursor.executionGenerationId !== EXECUTION_GENERATION_ID
  ) {
    throw new Error("Release hostd did not publish the exact active resident projection");
  }
  return snapshot;
}

function assertTerminalProjection(snapshot, hostId, sourceProjection, binding) {
  const expectedBindingFingerprint = residentBindingFingerprint(binding);
  const expectedThreadStatus = sourceProjection.thread.status === "complete" ||
    sourceProjection.thread.status === "failed"
    ? sourceProjection.thread.status
    : "idle";
  const expectedThread = {
    ...sourceProjection.thread,
    status: expectedThreadStatus,
    recap: "Resident session ended.",
    updatedAt: snapshot?.residentLifecycle?.endedAt,
    lastKnownCursor: sourceProjection.latestCursor,
  };
  const dispositionKeys = Object.keys(snapshot?.residentLifecycle ?? {}).sort();
  const expectedDispositionKeys = [
    "bindingFingerprint",
    "endedAt",
    "operationId",
    "reason",
    "sourceCursor",
    "state",
    "version",
  ];
  if (
    !snapshot ||
    snapshot.thread?.threadId !== THREAD_ID ||
    snapshot.thread?.projectIdentity !== PROJECT_ID ||
    snapshot.thread?.currentLocation?.hostId !== hostId ||
    snapshot.thread.currentLocation.projectId !== PROJECT_ID ||
    snapshot.thread.currentLocation.workspaceId !== WORKSPACE_ID ||
    snapshot.thread.currentLocation.executionGenerationId !== EXECUTION_GENERATION_ID ||
    snapshot.thread.status !== expectedThreadStatus ||
    snapshot.thread.recap !== "Resident session ended." ||
    !isDeepStrictEqual(snapshot.thread, expectedThread) ||
    snapshot.runtime !== undefined ||
    snapshot.inProgressStream !== undefined ||
    snapshot.queueState?.paused !== false ||
    snapshot.queueState.pendingCommandIds?.length !== 0 ||
    snapshot.approvals?.length !== 0 ||
    snapshot.childAgents?.length !== 0 ||
    snapshot.goals?.length !== 0 ||
    snapshot.schedules?.length !== 0 ||
    snapshot.pendingAttention?.length !== 0 ||
    JSON.stringify(dispositionKeys) !== JSON.stringify(expectedDispositionKeys) ||
    snapshot.residentLifecycle?.version !== 1 ||
    snapshot.residentLifecycle.state !== "ended" ||
    snapshot.residentLifecycle.operationId !== END_OPERATION_ID ||
    snapshot.residentLifecycle.bindingFingerprint !== expectedBindingFingerprint ||
    snapshot.residentLifecycle.activeSessionId !== undefined ||
    snapshot.residentLifecycle.sessionId !== undefined ||
    snapshot.residentLifecycle.endedAt !== snapshot.generatedAt ||
    snapshot.residentLifecycle.endedAt !== snapshot.thread.updatedAt ||
    snapshot.residentLifecycle.reason !== "user_end" ||
    JSON.stringify(snapshot.residentLifecycle.sourceCursor) !== JSON.stringify(sourceProjection.latestCursor) ||
    JSON.stringify(snapshot.latestCursor) !== JSON.stringify(sourceProjection.latestCursor) ||
    JSON.stringify(snapshot.thread.lastKnownCursor) !== JSON.stringify(sourceProjection.latestCursor) ||
    JSON.stringify(snapshot.transcriptBlockIndex) !== JSON.stringify(sourceProjection.transcriptBlockIndex) ||
    JSON.stringify(snapshot.materializedRecentBlocks) !== JSON.stringify(sourceProjection.materializedRecentBlocks) ||
    JSON.stringify(snapshot.git) !== JSON.stringify(sourceProjection.git) ||
    JSON.stringify(snapshot.evidence) !== JSON.stringify(sourceProjection.evidence)
  ) {
    throw new Error("Release hostd did not materialize the exact terminal resident projection");
  }
  return snapshot;
}

function residentBindingFingerprint(binding) {
  const authority = {
    bindingVersion: binding.bindingVersion,
    lifecycle: binding.lifecycle,
    threadId: binding.threadId,
    executionGenerationId: binding.executionGenerationId,
    workspaceDirectory: process.platform === "win32"
      ? resolve(binding.workspaceDirectory).toLocaleLowerCase("en-US")
      : resolve(binding.workspaceDirectory),
    activeSessionId: binding.activeSessionId,
    sessionId: binding.sessionId,
    sessionFile: binding.sessionFile,
    boundAt: binding.boundAt,
    runtime: {
      releaseVersion: binding.runtime.releaseVersion,
      appVersion: binding.runtime.appVersion,
      protocolName: binding.runtime.protocolName,
      protocolVersion: binding.runtime.protocolVersion,
      schemaRevision: binding.runtime.schemaRevision,
      schemaId: binding.runtime.schemaId,
      runtimeBuildId: binding.runtime.runtimeBuildId,
      capabilities: [...binding.runtime.capabilities].sort(),
    },
  };
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

function assertLifecycleStatus(status, kind, phase, request) {
  if (
    !status ||
    status.version !== 1 ||
    status.kind !== kind ||
    status.phase !== phase ||
    status.operationId !== request.operationId ||
    status.expectedHostId !== request.expectedHostId ||
    status.projectId !== request.projectId ||
    status.workspaceId !== request.workspaceId ||
    status.threadId !== request.threadId ||
    status.executionGenerationId !== request.executionGenerationId ||
    typeof status.preparedAt !== "string" ||
    typeof status.updatedAt !== "string" ||
    typeof status.terminalAt !== "string" ||
    status.terminalAt !== status.updatedAt ||
    status.quarantinedFrom !== undefined ||
    status.quarantineReason !== undefined ||
    status.completionReason !== undefined
  ) {
    throw new Error(
      `Resident ${kind} did not reach exact terminal ${phase} state: ` +
        `${JSON.stringify(status)}`,
    );
  }
  return status;
}

async function lookupLifecycle(hostId, operationId) {
  const status = await lookupLifecycleOptional(hostId, operationId);
  if (status === null) {
    throw new Error(`Resident lifecycle status ${operationId} is missing`);
  }
  return status;
}

async function lookupLifecycleOptional(hostId, operationId) {
  const response = await requestHost(
    hostEndpoint,
    "resident.lifecycle.status",
    { expectedHostId: hostId, operationId },
    HOST_REQUEST_DEADLINE_MS,
  );
  if (!response.result || !("status" in response.result)) {
    throw new Error(`Resident lifecycle lookup ${operationId} is invalid`);
  }
  assertPathFree(response.result, "resident lifecycle lookup");
  return response.result.status;
}

async function snapshotResidentLifecycleDurability() {
  const operationsDirectory = join(dataDirectory, "resident-lifecycle-operations");
  const entries = (await readdir(operationsDirectory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const operations = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error("Resident lifecycle operations contain a non-file entry");
    }
    operations.push(Object.freeze({
      name: entry.name,
      fingerprint: await boundedFileFingerprint(join(operationsDirectory, entry.name)),
    }));
  }
  return Object.freeze({
    operations: Object.freeze(operations),
    retiredFence: await optionalBoundedFileFingerprint(
      join(dataDirectory, "resident-lifecycle-retired-fence.json"),
    ),
    retirement: await optionalBoundedFileFingerprint(
      join(dataDirectory, "resident-lifecycle-retirement.json"),
    ),
  });
}

async function optionalBoundedFileFingerprint(path) {
  try {
    return await boundedFileFingerprint(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

async function boundedFileFingerprint(path) {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_FRAME_BYTES) {
    throw new Error("Resident lifecycle durability file exceeds its smoke inspection bound");
  }
  return Object.freeze({
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function assertBindingRegistry(expectedState, expectedRuntime, expectedBinding) {
  const file = JSON.parse(await readFile(join(dataDirectory, "resident-session-bindings.json"), "utf8"));
  if (file?.version !== 1 || !Array.isArray(file.records)) {
    throw new Error("Resident binding registry has an invalid durable envelope");
  }
  if (expectedState === "empty") {
    if (file.records.length !== 0) throw new Error("Empty host unexpectedly has a resident binding record");
    return undefined;
  }
  if (file.records.length !== 1 || file.records[0]?.state !== expectedState) {
    throw new Error(`Resident binding registry did not contain one exact ${expectedState} record`);
  }
  const record = file.records[0];
  const binding = record.binding;
  if (
    binding?.bindingVersion !== 1 ||
    binding.lifecycle !== "resident" ||
    binding.threadId !== THREAD_ID ||
    binding.executionGenerationId !== EXECUTION_GENERATION_ID ||
    !samePath(binding.workspaceDirectory, workspaceDirectory) ||
    (expectedRuntime && (
      binding.activeSessionId !== expectedRuntime.activeSessionId ||
      binding.sessionId !== expectedRuntime.sessionId
    )) ||
    (expectedBinding && JSON.stringify(binding) !== JSON.stringify(expectedBinding))
  ) {
    throw new Error(`Resident binding registry ${expectedState} record changed exact identity`);
  }
  assertResidentBindingCompatibility(binding);
  if (expectedState === "active" && record.operationId !== PROVISION_OPERATION_ID) {
    throw new Error("Active binding lost its provisioning operation provenance");
  }
  if (
    expectedState === "completed" &&
    (record.operationId !== END_OPERATION_ID || typeof record.completedAt !== "string")
  ) {
    throw new Error("Completed binding lost its end operation provenance");
  }
  return binding;
}

function assertResidentBindingCompatibility(binding) {
  const expectedCompatibility = {
    releaseVersion: attestation.runtime.releaseVersion,
    appVersion: attestation.runtime.releaseVersion,
    protocolName: attestation.daemon.protocolName,
    protocolVersion: attestation.daemon.protocolVersion,
    schemaRevision: attestation.daemon.schemaRevision,
    schemaId: attestation.daemon.schemaId,
    runtimeBuildId: attestation.runtime.runtimeBuildId,
  };
  for (const [key, expected] of Object.entries(expectedCompatibility)) {
    if (binding.runtime?.[key] !== expected) {
      throw new Error(`Resident binding runtime compatibility changed: ${key}`);
    }
  }
  if (!Array.isArray(binding.runtime.capabilities)) {
    throw new Error("Resident binding runtime capabilities are invalid");
  }
  for (const capability of attestation.daemon.requiredCapabilities) {
    if (!binding.runtime.capabilities.includes(capability)) {
      throw new Error(`Resident binding omitted required capability: ${capability}`);
    }
  }
}

async function inspectResidentDaemon(installedRuntimeRoot, action, environment) {
  const daemonClientPath = join(
    installedRuntimeRoot,
    "node_modules",
    "prime-agent",
    "dist",
    "modes",
    "daemon",
    "daemon-client.js",
  );
  assertPathWithin(installedRuntimeRoot, daemonClientPath);
  const result = await runProcess(
    electronExecutable,
    [daemonAuditPath, pathToFileURL(daemonClientPath).href, residentEndpoint, action],
    { cwd: REPO_ROOT, environment, timeoutMs: HELPER_DEADLINE_MS },
  );
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Resident daemon ${action} audit returned invalid JSON`, { cause: error });
  }
}

function assertSingleDaemonSession(audit, expectedBinding) {
  const session = audit?.sessions?.[0];
  if (
    audit?.auditVersion !== 1 ||
    audit.action !== "list" ||
    !Array.isArray(audit.sessions) ||
    audit.sessions.length !== 1 ||
    session?.activeSessionId !== expectedBinding.activeSessionId ||
    session.sessionId !== expectedBinding.sessionId ||
    session.lifecycle !== "draft" ||
    session.workerState !== "ready" ||
    session.attachedClients !== 1 ||
    typeof session.cwd !== "string" ||
    !samePath(session.cwd, expectedBinding.workspaceDirectory) ||
    (expectedBinding.sessionFile !== undefined && (
      typeof session.sessionFile !== "string" ||
      !samePath(session.sessionFile, expectedBinding.sessionFile)
    ))
  ) {
    throw new Error("Read-only daemon audit did not find the exact single resident session");
  }
}

function assertNoDaemonSessions(audit) {
  if (
    audit?.auditVersion !== 1 ||
    audit.action !== "list" ||
    !Array.isArray(audit.sessions) ||
    audit.sessions.length !== 0
  ) {
    throw new Error("Read-only daemon audit found a replayed or unended resident session");
  }
}

function assertSameResidentIdentity(left, right, label) {
  for (const key of ["runtime", "residency", "activeSessionId", "sessionId"]) {
    if (left?.[key] !== right?.[key]) throw new Error(`Resident identity changed during ${label}: ${key}`);
  }
}

function freezeExactSourceCursor(cursor) {
  if (
    cursor?.threadId !== THREAD_ID ||
    cursor.executionGenerationId !== EXECUTION_GENERATION_ID ||
    typeof cursor.generation !== "string" ||
    cursor.generation.length < 1 ||
    !Number.isSafeInteger(cursor.sequence) ||
    cursor.sequence < 0
  ) {
    throw new Error("Pre-end projection did not provide exact resident source-cursor authority");
  }
  return Object.freeze({
    threadId: cursor.threadId,
    executionGenerationId: cursor.executionGenerationId,
    generation: cursor.generation,
    sequence: cursor.sequence,
  });
}

function driftSourceCursor(cursor) {
  return Object.freeze({
    threadId: cursor.threadId,
    executionGenerationId: cursor.executionGenerationId,
    generation: cursor.generation,
    sequence: cursor.sequence === Number.MAX_SAFE_INTEGER
      ? cursor.sequence - 1
      : cursor.sequence + 1,
  });
}

function assertExactJson(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

async function assertHostProtocolError(request, expected) {
  let failure;
  try {
    await request;
  } catch (error) {
    failure = error;
  }
  const protocolError = failure?.protocolError;
  if (
    !protocolError ||
    protocolError.code !== expected.code ||
    protocolError.message !== expected.message ||
    protocolError.retryable !== expected.retryable
  ) {
    throw new Error(
      `Host protocol did not return exact ${expected.code} rejection: ${errorMessage(failure)}`,
    );
  }
  return protocolError;
}

function assertPathFree(value, label) {
  const forbiddenValues = [temporaryRoot, dataDirectory, workspaceDirectory, agentDirectory]
    .map((path) => normalizedPathText(path));
  const pending = [value];
  const seen = new Set();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object") continue;
    if (seen.has(candidate)) throw new Error(`${label} contains a cyclic object graph`);
    seen.add(candidate);
    for (const [key, child] of Object.entries(candidate)) {
      if (/^(?:workspaceDirectory|sessionFile|cwd)$/i.test(key)) {
        throw new Error(`${label} exposed private runtime property ${key}`);
      }
      if (typeof child === "string") {
        const normalized = normalizedPathText(child);
        if (forbiddenValues.some((path) => normalized.includes(path))) {
          throw new Error(`${label} exposed a private filesystem path`);
        }
      } else if (child && typeof child === "object") {
        pending.push(child);
      }
    }
  }
}

function normalizedPathText(value) {
  return value.replaceAll("\\", "/").toLowerCase();
}

async function resolveInstalledRuntimeRoot(runtimeIntegrity) {
  const pointerPath = join(dataDirectory, "runtime", "current.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  const expectedPointer = {
    schemaVersion: 1,
    assurance: attestation.assurance,
    runtime: "prime-agent",
    releaseVersion: attestation.runtime.releaseVersion,
    runtimeBuildId: attestation.runtime.runtimeBuildId,
    platform: attestation.runtime.platform,
    arch: attestation.runtime.arch,
    manifestSha256: attestation.manifest.sha256,
    treeSha256: attestation.tree.sha256,
    filesSha256: attestation.tree.filesSha256,
  };
  if (JSON.stringify(pointer) !== JSON.stringify(expectedPointer)) {
    throw new Error("Installed runtime pointer differs from the embedded attestation");
  }
  if (JSON.stringify(pointer) !== JSON.stringify(runtimeIntegrity.target && {
    schemaVersion: 1,
    assurance: runtimeIntegrity.assurance,
    ...runtimeIntegrity.target,
  })) {
    throw new Error("Installed runtime pointer differs from ready health");
  }

  const manifestLocation = join(dataDirectory, "runtime", ...attestation.manifest.relativePath.split("/"));
  assertPathWithin(join(dataDirectory, "runtime"), manifestLocation);
  const manifestBytes = await readFile(manifestLocation);
  if (createHash("sha256").update(manifestBytes).digest("hex") !== attestation.manifest.sha256) {
    throw new Error("Installed runtime manifest differs from the embedded attestation");
  }
  const root = dirname(manifestLocation);
  for (const entrypoint of [attestation.entrypoints.module, attestation.entrypoints.cli]) {
    const location = join(root, ...entrypoint.split("/"));
    assertPathWithin(root, location);
    const entry = await stat(location);
    if (!entry.isFile()) throw new Error("Installed runtime entrypoint is not a regular file");
  }
  return root;
}

async function assertCredentialStoreEmpty() {
  const credentialPath = join(agentDirectory, "auth.json");
  let bytes;
  let state = "empty";
  try {
    bytes = await readFile(credentialPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") state = "absent";
    else throw error;
  }
  if (bytes) {
    if (bytes.byteLength > 64 * 1024) throw new Error("Credential-free auth.json exceeds its inspection bound");
    let auth;
    try {
      auth = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error("Credential-free auth.json is not valid JSON", { cause: error });
    }
    if (!auth || typeof auth !== "object" || Array.isArray(auth) || Object.keys(auth).length !== 0) {
      throw new Error("Credential-free resident smoke found credential material in auth.json");
    }
  }
  try {
    await readFile(join(agentDirectory, "oauth.json"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return state;
    throw error;
  }
  throw new Error("Credential-free resident smoke found legacy oauth.json material");
}

/**
 * Exercise the caller's unknown-response path without a test seam in hostd.
 * A dedicated trusted-user connection discards its response as soon as the
 * first byte arrives. HostService has therefore completed the request, while
 * this caller intentionally consumes no response identity or lifecycle result.
 */
async function requestHostAndDiscardResponse(socketPath, method, requestPayload, timeoutMs) {
  const requestId = `resident-lifecycle-discard-${randomUUID()}`;
  const payload = Buffer.from(JSON.stringify({
    protocolVersion: 1,
    requestId,
    method,
    payload: requestPayload,
  }), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);

  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`${method} did not begin its deliberately discarded response`)),
      timeoutMs,
    );
    timer.unref?.();
    socket.once("connect", () => socket.write(frame));
    socket.once("data", (chunk) => {
      finish(undefined, Object.freeze({
        requestId,
        responseBytesObserved: Buffer.byteLength(chunk),
      }));
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error(`hostd closed before beginning the discarded ${method} response`));
    });
  });
}

async function requestHost(socketPath, method, requestPayload, timeoutMs) {
  const requestId = `resident-lifecycle-smoke-${randomUUID()}`;
  const payload = Buffer.from(JSON.stringify({
    protocolVersion: 1,
    requestId,
    method,
    payload: requestPayload,
  }), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);

  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(new Error(`${method} request timed out`)), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_FRAME_BYTES + 4) {
        finish(new Error(`${method} response exceeded its frame bound`));
        return;
      }
      if (buffer.byteLength < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length < 1 || length > MAX_FRAME_BYTES) {
        finish(new Error(`${method} frame length is invalid`));
        return;
      }
      if (buffer.byteLength < 4 + length) return;
      let response;
      try {
        response = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      } catch (error) {
        finish(new Error(`${method} response is not valid JSON`, { cause: error }));
        return;
      }
      if (response?.requestId !== requestId || response?.method !== method) {
        finish(new Error(`${method} response identity is invalid`));
        return;
      }
      if (!response.ok) {
        const detail = response?.error?.message ? `: ${response.error.message}` : "";
        const code = response?.error?.code ?? "HOST_PROTOCOL_ERROR";
        const failure = new Error(`${method} failed with ${code}${detail}`);
        Object.defineProperty(failure, "protocolError", {
          value: response?.error,
          enumerable: false,
        });
        finish(failure);
        return;
      }
      finish(undefined, response);
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error(`hostd closed before returning ${method}`));
    });
  });
}

async function stopHostd(processHandle) {
  if (!processHandle) return;
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    throw new Error(
      `Release hostd exited before graceful shutdown (${processHandle.exitCode ?? processHandle.signalCode}); ` +
        `${processHandle.stderrTail?.toString("utf8") ?? "no diagnostic"}`,
    );
  }
  if (!processHandle.stdin || processHandle.stdin.destroyed || !processHandle.stdin.writable) {
    throw new Error("Release hostd has no writable graceful-shutdown control pipe");
  }
  processHandle.stdin.once("error", () => undefined);
  processHandle.stdin.end("shutdown\n");
  const outcome = await waitForProcessExit(processHandle, 10_000).catch(async (error) => {
    if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill();
    await waitForProcessExit(processHandle, 10_000).catch(() => undefined);
    throw error;
  });
  if (outcome.code !== 0 || outcome.signal !== null) {
    throw new Error(
      `Release hostd did not shut down cleanly (${outcome.code ?? outcome.signal ?? "unknown"}); ` +
        `${processHandle.stderrTail?.toString("utf8") ?? "no diagnostic"}`,
    );
  }
}

function runProcess(executable, argv, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, argv, {
      cwd: options.cwd,
      detached: false,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.environment,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Helper timed out: ${argv[0] ?? executable}`));
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]).subarray(-8 * 1024 * 1024);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(-64 * 1024);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal !== null) {
        finish(new Error(`Helper failed (${code ?? signal ?? "unknown"}): ${stderr.toString("utf8")}`));
        return;
      }
      finish(undefined, { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    });
  });
}

function waitForProcessExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return Promise.resolve({ code: processHandle.exitCode, signal: processHandle.signalCode });
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const finish = () => {
      clearTimeout(timer);
      processHandle.off("exit", onExit);
      processHandle.off("error", onError);
    };
    const onExit = (code, signal) => {
      finish();
      resolvePromise({ code, signal });
    };
    const onError = (error) => {
      finish();
      rejectPromise(error);
    };
    const timer = setTimeout(() => {
      finish();
      rejectPromise(new Error("Release hostd did not complete graceful shutdown within its deadline"));
    }, timeoutMs);
    processHandle.once("exit", onExit);
    processHandle.once("error", onError);
  });
}

function onceSpawned(processHandle) {
  return new Promise((resolvePromise, rejectPromise) => {
    processHandle.once("spawn", resolvePromise);
    processHandle.once("error", rejectPromise);
  });
}

function assertChildAlive(processHandle) {
  if (processHandle.exitCode === null && processHandle.signalCode === null) return;
  throw new Error(`Release hostd exited before readiness: ${processHandle.stderrTail.toString("utf8")}`);
}

function credentialFreeRunAsNodeEnvironment(source, isolatedAgentDirectory) {
  const environment = {};
  let strippedCredentialVariableCount = 0;
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalized = name.toUpperCase();
    if (
      normalized === "NODE_OPTIONS" ||
      normalized === "NODE_PATH" ||
      normalized === "ELECTRON_RUN_AS_NODE" ||
      normalized === "PRIME_CONTINUIM_ENABLE_PLAINTEXT_OAUTH_DEV" ||
      normalized.startsWith("PRIME_AGENT_INTERNAL_") ||
      normalized === "PRIME_AGENT_BUILD_ID" ||
      normalized === "PRIME_AGENT_LAUNCHER_PATH"
    ) {
      continue;
    }
    if (isCredentialVariable(normalized)) {
      strippedCredentialVariableCount += 1;
      continue;
    }
    environment[name] = value;
  }
  environment.ELECTRON_RUN_AS_NODE = "1";
  environment.PRIME_AGENT_CODING_AGENT_DIR = isolatedAgentDirectory;
  environment.PRIME_CONTINUIM_PACKAGE_SMOKE = "1";
  return Object.freeze({
    environment: Object.freeze(environment),
    strippedCredentialVariableCount,
  });
}

function isCredentialVariable(name) {
  return /(?:^|_)(?:API_?KEY|ACCESS_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTHORIZATION)(?:_|$)/.test(name) ||
    /^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE_GENERATIVE_AI|PRIME|AZURE_OPENAI|AWS|MISTRAL|GROQ|CEREBRAS|COHERE|TOGETHER|DEEPSEEK|OPENROUTER|PERPLEXITY|XAI)(?:_|$)/.test(name);
}

function localHostEndpoint(directory) {
  if (process.platform === "win32") {
    const digest = createHash("sha256").update(resolve(directory).toLowerCase()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\prime-agent-hostd-${digest}`;
  }
  return join(directory, "hostd.sock");
}

function residentDaemonEndpoint(directory) {
  const root = resolve(directory);
  const identity = createHash("sha256")
    .update(process.platform === "win32" ? root.toLowerCase() : root)
    .digest("hex")
    .slice(0, 16);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\prime-continuim-resident-${identity}`
    : join(resolve(tmpdir()), `pc-${identity}`, "d.sock");
}

async function assertExactSeedRoot(root) {
  const entries = (await readdir(root)).sort();
  if (JSON.stringify(entries) !== JSON.stringify(["current.json", "installs"])) {
    throw new Error(`Development runtime seed is not an exact packaging view: ${entries.join(", ")}`);
  }
}

function assertPathWithin(parent, child) {
  const childRelative = relative(resolve(parent), resolve(child));
  if (
    childRelative === "" ||
    childRelative === ".." ||
    childRelative.startsWith(`..${sep}`) ||
    resolve(childRelative) === resolve(child)
  ) {
    throw new Error("Runtime path escaped its expected root");
  }
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function hostdSmokeWrapperSource() {
  return [
    '"use strict";',
    "const [hostdPath, ...hostdArguments] = process.argv.slice(2);",
    'if (!hostdPath) throw new Error("missing hostd smoke path");',
    'const handlerEvents = ["SIGINT", "SIGTERM"];',
    "const handlerSnapshot = new Map(handlerEvents.map((event) => [event, [...process.rawListeners(event)]]));",
    "const processEmitBefore = process.emit;",
    "const processReallyExitBefore = process.reallyExit;",
    "const assertParentIsolation = () => {",
    "  for (const event of handlerEvents) {",
    "    const before = handlerSnapshot.get(event);",
    "    const after = process.rawListeners(event);",
    "    if (before.length !== after.length || before.some((listener, index) => listener !== after[index])) {",
    '      throw new Error(`release hostd changed parent ${event} handlers`);',
    "    }",
    "  }",
    '  if (process.emit !== processEmitBefore) throw new Error("release hostd changed parent process.emit");',
    '  if (process.reallyExit !== processReallyExitBefore) throw new Error("release hostd changed parent process.reallyExit");',
    "};",
    "const hostd = require(hostdPath);",
    'process.stdin.setEncoding("utf8");',
    "const run = hostd.runHostdCli(hostdArguments);",
    "const runningHandlerSnapshot = new Map(handlerEvents.map((event) => [event, [...process.rawListeners(event)]]));",
    "let runningIsolationFailure;",
    "const inspectRunningIsolation = () => {",
    "  for (const event of handlerEvents) {",
    "    const before = runningHandlerSnapshot.get(event);",
    "    const after = process.rawListeners(event);",
    "    if (before.length !== after.length || before.some((listener, index) => listener !== after[index])) {",
    '      throw new Error(`resident Worker changed live parent ${event} handlers`);',
    "    }",
    "  }",
    '  if (process.emit !== processEmitBefore) throw new Error("resident Worker changed live parent process.emit");',
    '  if (process.reallyExit !== processReallyExitBefore) throw new Error("resident Worker changed live parent process.reallyExit");',
    "};",
    "const isolationInterval = setInterval(() => {",
    "  try { inspectRunningIsolation(); } catch (error) { runningIsolationFailure ??= error; }",
    "}, 10);",
    "isolationInterval.unref?.();",
    'process.stdin.once("data", () => { clearInterval(isolationInterval); process.emit("SIGTERM"); });',
    "process.stdin.resume();",
    "void Promise.resolve(run).then(",
    "  (code) => {",
    "    clearInterval(isolationInterval);",
    "    if (runningIsolationFailure) throw runningIsolationFailure;",
    "    assertParentIsolation();",
    "    process.exitCode = code; process.stdin.destroy();",
    "  },",
    ").catch((error) => {",
    "    const errors = error instanceof AggregateError ? [error, ...error.errors] : [error];",
    '    const details = errors.map((value) => value instanceof Error ? `${value.name}: ${value.message}` : String(value)).join(" <- ").slice(0, 8192);',
    '    process.stderr.write(`Hostd resident lifecycle smoke wrapper failed: ${details}\\n`); process.exitCode = 1; process.stdin.destroy();',
    "});",
    "",
  ].join("\n");
}

function daemonAuditSource() {
  return [
    "const [moduleUrl, socketPath, action] = process.argv.slice(2);",
    'if (!moduleUrl || !socketPath || (action !== "list" && action !== "shutdown")) throw new Error("missing daemon audit argument");',
    "const { DaemonClient } = await import(moduleUrl);",
    "const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));",
    "let client;",
    "try {",
    "  const deadline = Date.now() + 10_000;",
    "  let lastError;",
    "  while (Date.now() < deadline) {",
    "    const candidate = new DaemonClient(socketPath);",
    "    try {",
    "      await candidate.connect(500);",
    "      client = candidate;",
    "      break;",
    "    } catch (error) {",
    "      lastError = error;",
    "      candidate.close();",
    "      await delay(50);",
    "    }",
    "  }",
    '  if (!client) throw new Error(`resident daemon did not accept audit connection: ${lastError instanceof Error ? lastError.message : String(lastError)}`);',
    '  if (action === "shutdown") {',
    '    const response = await client.request({ type: "shutdown", force: true }, 5_000);',
    '    const shutdownConfirmed = response?.type === "response" && response.command === "shutdown" && response.success === true;',
    '    if (!shutdownConfirmed) throw new Error("resident daemon did not confirm shutdown");',
    '    process.stdout.write(JSON.stringify({ auditVersion: 1, action, shutdownConfirmed }));',
    "  } else {",
    '    const response = await client.request({ type: "list", includeClientOwned: true }, 5_000);',
    '    if (response?.type !== "response" || response.command !== "list" || response.success !== true || !Array.isArray(response.data?.sessions)) throw new Error("resident daemon list response is invalid");',
    "    const sessions = response.data.sessions.map((session) => ({",
    "      activeSessionId: session.activeSessionId,",
    "      ...(typeof session.sessionId === \"string\" ? { sessionId: session.sessionId } : {}),",
    "      ...(typeof session.lifecycle === \"string\" ? { lifecycle: session.lifecycle } : {}),",
    "      ...(typeof session.cwd === \"string\" ? { cwd: session.cwd } : {}),",
    "      ...(typeof session.sessionFile === \"string\" ? { sessionFile: session.sessionFile } : {}),",
    "      ...(typeof session.attachedClients === \"number\" ? { attachedClients: session.attachedClients } : {}),",
    "      ...(typeof session.workerState === \"string\" ? { workerState: session.workerState } : {}),",
    "    }));",
    '    process.stdout.write(JSON.stringify({ auditVersion: 1, action, sessions }));',
    "  }",
    "} finally {",
    "  client?.close();",
    "}",
    "",
  ].join("\n");
}
