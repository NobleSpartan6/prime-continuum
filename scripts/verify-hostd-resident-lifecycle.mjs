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
const COMMAND_DEVICE_ID = "resident-smoke-device";
const BASELINE_MODEL_SELECT_COMMAND_ID = "resident-smoke-model-select-baseline-1";
const MODEL_SELECT_COMMAND_ID = "resident-smoke-model-select-1";
const COMPLETED_PROMPT_COMMAND_ID = "resident-smoke-prompt-complete-1";
const PACED_PROMPT_COMMAND_ID = "resident-smoke-prompt-paced-1";
const STOP_COMMAND_ID = "resident-smoke-stop-1";
const CANARY_PROMPT_COMMAND_ID = "resident-smoke-prompt-stop-replay-canary-1";
const CANARY_STOP_COMMAND_ID = "resident-smoke-stop-canary-1";
const FAUX_PROVIDER_ID = "continuim-smoke-faux";
const FAUX_BASELINE_MODEL_ID = "deterministic-baseline-v0";
const FAUX_MODEL_ID = "deterministic-local-v1";
const FAUX_API_ID = "continuim-smoke-faux-api";
const FAUX_MODEL_RUNTIME_ID = `${FAUX_PROVIDER_ID}/${FAUX_MODEL_ID}`;
const FAUX_BASELINE_MODEL_RUNTIME_ID = `${FAUX_PROVIDER_ID}/${FAUX_BASELINE_MODEL_ID}`;
const COMPLETED_PROMPT_TEXT = "Complete the deterministic packaged resident provider prompt.";
const COMPLETED_RESPONSE_TEXT = "Deterministic resident provider completed the packaged prompt.";
const COMPLETED_COMPACTION_STATUS_TEXT = "compaction_outcome\nAuto-compaction skipped: Session is too short to compact — try again once it grows";
const PACED_PROMPT_TEXT = "Begin the paced deterministic packaged resident provider prompt.";
const PACED_RESPONSE_TEXT = `Paced deterministic resident response: ${"0123456789".repeat(200)}`;
const STOP_REASON = "Verify urgent Stop against the paced deterministic provider response.";
const CANARY_PROMPT_TEXT = "Keep streaming while the completed Stop receipt is replayed.";
const CANARY_RESPONSE_TEXT = `Stop replay canary response: ${"abcdefghijklmnopqrstuvwxyz".repeat(80)}`;
const CANARY_STOP_REASON = "Cleanly stop the deterministic replay canary response.";
const MAX_FAUX_LEDGER_BYTES = 32 * 1024;
const MAX_FAUX_LEDGER_RECORDS = 12;
const MAX_DAEMON_PROCESS_IDENTITIES = 16;
const STALE_END_ERROR = Object.freeze({
  code: "RESIDENT_END_SOURCE_CURSOR_CHANGED",
  message: "Resident state changed after end consent was reviewed; refresh the thread and confirm again",
  retryable: false,
});
const RESIDENT_COMMAND_CAPABILITY = "prime_agent_commands_v2";
const RESIDENT_LIFECYCLE_CAPABILITY = "resident_lifecycle_v1";
const CANDIDATE_EVALUATION_CAPABILITY = "candidate_evaluation_probe_v1";
const CODEX_SUBSCRIPTION_CAPABILITY = "codex_subscription_v1";
const EXPECTED_BASE_CAPABILITIES = Object.freeze([
  CANDIDATE_EVALUATION_CAPABILITY,
  CODEX_SUBSCRIPTION_CAPABILITY,
  "resident_control_projection_v1",
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
const fauxLedgerPath = join(temporaryRoot, "faux-provider-ledger.jsonl");
const requestedDataDirectory = join(temporaryRoot, "host-data");
const requestedWorkspaceDirectory = join(temporaryRoot, "workspace");
const agentDirectory = join(temporaryRoot, "prime-agent-home");
const extensionDirectory = join(agentDirectory, "extensions");
const fauxExtensionPath = join(extensionDirectory, "continuim-smoke-faux.ts");

await Promise.all([
  mkdir(requestedDataDirectory, { recursive: true, mode: 0o700 }),
  mkdir(requestedWorkspaceDirectory, { recursive: true, mode: 0o700 }),
  mkdir(agentDirectory, { recursive: true, mode: 0o700 }),
  mkdir(extensionDirectory, { recursive: true, mode: 0o700 }),
]);
const dataDirectory = await realpath(requestedDataDirectory);
const workspaceDirectory = await realpath(requestedWorkspaceDirectory);
const hostEndpoint = localHostEndpoint(dataDirectory);
const residentEndpoint = residentDaemonEndpoint(dataDirectory);
await Promise.all([
  writeFile(hostdWrapperPath, hostdSmokeWrapperSource(), { encoding: "utf8", mode: 0o600, flag: "wx" }),
  writeFile(daemonAuditPath, daemonAuditSource(), { encoding: "utf8", mode: 0o600, flag: "wx" }),
  writeFile(fauxExtensionPath, fauxProviderExtensionSource(), { encoding: "utf8", mode: 0o600, flag: "wx" }),
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
let daemonProcessIdentities = Object.freeze([]);
let successReport;
let primaryFailure;

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
  assertSingleDaemonSession(firstDaemonAudit, activeBinding, "draft");
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
  const expectedActiveToolNames = [...restartedProjection.runtime.activeToolNames];
  const replayedProvision = await requestHost(
    hostEndpoint,
    "resident.provision",
    exactProvisionRequest,
    LIFECYCLE_REQUEST_DEADLINE_MS,
  );
  assertExactJson(replayedProvision.result, committed, "Provision replay changed its terminal result");
  const restartDaemonAudit = await inspectResidentDaemon(runtimeRoot, "list", credentialFree.environment);
  assertSingleDaemonSession(restartDaemonAudit, activeBinding, "draft");
  await assertBindingRegistry("active", firstProjection.runtime, activeBinding);

  // The deterministic provider is installed only in this smoke's isolated
  // Prime extension directory. Every command below still crosses the release
  // HostService, verified gateway, resident Worker, daemon, and Store journals.
  const baselineModelSelectCommand = freezeCommandEnvelope(hostId, BASELINE_MODEL_SELECT_COMMAND_ID, {
    kind: "model.select",
    providerId: FAUX_PROVIDER_ID,
    modelId: FAUX_BASELINE_MODEL_ID,
  });
  const modelSelectCommand = freezeCommandEnvelope(hostId, MODEL_SELECT_COMMAND_ID, {
    kind: "model.select",
    providerId: FAUX_PROVIDER_ID,
    modelId: FAUX_MODEL_ID,
  });
  const completedPromptCommand = freezeCommandEnvelope(hostId, COMPLETED_PROMPT_COMMAND_ID, {
    kind: "prompt",
    text: COMPLETED_PROMPT_TEXT,
  });
  const pacedPromptCommand = freezeCommandEnvelope(hostId, PACED_PROMPT_COMMAND_ID, {
    kind: "prompt",
    text: PACED_PROMPT_TEXT,
  });
  const stopCommand = freezeCommandEnvelope(hostId, STOP_COMMAND_ID, {
    kind: "abort",
    reason: STOP_REASON,
  });
  const canaryPromptCommand = freezeCommandEnvelope(hostId, CANARY_PROMPT_COMMAND_ID, {
    kind: "prompt",
    text: CANARY_PROMPT_TEXT,
  });
  const canaryStopCommand = freezeCommandEnvelope(hostId, CANARY_STOP_COMMAND_ID, {
    kind: "abort",
    reason: CANARY_STOP_REASON,
  });

  const baselineModelSelectReceipt = assertCommandReceipt(
    await submitCommand(baselineModelSelectCommand),
    baselineModelSelectCommand,
    "completed",
    "Prime Agent selected and verified the requested model",
  );
  const baselineModelProjection = assertIdleCommandProjection(
    (await requestHost(
      hostEndpoint,
      "thread.snapshot",
      { threadId: THREAD_ID },
      HOST_REQUEST_DEADLINE_MS,
    )).result,
    hostId,
    FAUX_BASELINE_MODEL_RUNTIME_ID,
    expectedActiveToolNames,
  );
  assertExactJson(
    baselineModelProjection.latestCursor,
    restartedProjection.latestCursor,
    "Baseline model selection unexpectedly changed the transcript-derived resident cursor",
  );
  const modelSelectResult = await submitCommand(modelSelectCommand);
  let modelSelectReceipt;
  try {
    modelSelectReceipt = assertCommandReceipt(
      modelSelectResult,
      modelSelectCommand,
      "completed",
      "Prime Agent selected and verified the requested model",
    );
  } catch (error) {
    const diagnosticProjection = (await requestHost(
      hostEndpoint,
      "thread.snapshot",
      { threadId: THREAD_ID },
      HOST_REQUEST_DEADLINE_MS,
    )).result;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; authoritative projection: ` +
        JSON.stringify({
          runtime: diagnosticProjection?.runtime,
          latestCursor: diagnosticProjection?.latestCursor,
          threadCursor: diagnosticProjection?.thread?.lastKnownCursor,
        }),
    );
  }
  const selectedProjection = assertIdleCommandProjection(
    (await requestHost(
      hostEndpoint,
      "thread.snapshot",
      { threadId: THREAD_ID },
      HOST_REQUEST_DEADLINE_MS,
    )).result,
    hostId,
    FAUX_MODEL_RUNTIME_ID,
    expectedActiveToolNames,
  );
  assertExactJson(
    selectedProjection.latestCursor,
    baselineModelProjection.latestCursor,
    "Model selection unexpectedly changed the transcript-derived resident cursor",
  );

  const completedPromptAcknowledgedReceipt = assertCommandReceipt(
    await submitCommand(completedPromptCommand),
    completedPromptCommand,
    "running",
    "Prime Agent owns the prompt; turn completion follows from authoritative runtime state",
  );
  await waitForFauxLedgerRecord("call", 1);
  const completedPromptReceipt = await waitForCompletedCommand(
    completedPromptCommand,
    "Prime Agent is authoritatively idle after the acknowledged prompt",
  );
  await waitForFauxLedgerRecord("result", 1);
  const completedPromptProjection = assertIdleCommandProjection(
    (await requestHost(
      hostEndpoint,
      "thread.snapshot",
      { threadId: THREAD_ID },
      HOST_REQUEST_DEADLINE_MS,
    )).result,
    hostId,
    FAUX_MODEL_RUNTIME_ID,
    expectedActiveToolNames,
  );
  assertCursorAdvanced(
    selectedProjection.latestCursor,
    completedPromptProjection.latestCursor,
    "completed prompt",
  );
  assertExactCompletedTurn(completedPromptProjection);

  const pacedPromptAcknowledgedReceipt = assertCommandReceipt(
    await submitCommand(pacedPromptCommand),
    pacedPromptCommand,
    "running",
    "Prime Agent owns the prompt; turn completion follows from authoritative runtime state",
  );
  await waitForFauxLedgerRecord("call", 2);
  const pacedStreamingProjection = await waitForPacedStreamingProjection(
    hostId,
    activeBinding,
    PACED_RESPONSE_TEXT,
    0,
    "paced provider Prompt",
  );
  assertCursorAdvanced(
    completedPromptProjection.latestCursor,
    pacedStreamingProjection.latestCursor,
    "paced provider first delta",
  );
  const stopAcknowledgedReceipt = assertCommandReceipt(
    await submitCommand(stopCommand),
    stopCommand,
    "running",
    "Prime Agent accepted the stop request; authoritative runtime state will confirm idleness",
  );
  const [pacedPromptReceipt, stopReceipt] = await Promise.all([
    waitForCompletedCommand(
      pacedPromptCommand,
      "Prime Agent is authoritatively idle after the acknowledged prompt",
    ),
    waitForCompletedCommand(
      stopCommand,
      "Prime Agent is authoritatively idle after the acknowledged stop request",
    ),
  ]);
  await waitForFauxLedgerRecord("result", 2);
  const stoppedProjection = assertIdleCommandProjection(
    (await requestHost(
      hostEndpoint,
      "thread.snapshot",
      { threadId: THREAD_ID },
      HOST_REQUEST_DEADLINE_MS,
    )).result,
    hostId,
    FAUX_MODEL_RUNTIME_ID,
    expectedActiveToolNames,
  );
  assertCursorAdvanced(
    pacedStreamingProjection.latestCursor,
    stoppedProjection.latestCursor,
    "urgent Stop idle proof",
  );
  const stoppedPartialCharacters = assertExactStoppedTurn(stoppedProjection);
  const canaryPromptAcknowledgedReceipt = assertCommandReceipt(
    await submitCommand(canaryPromptCommand),
    canaryPromptCommand,
    "running",
    "Prime Agent owns the prompt; turn completion follows from authoritative runtime state",
  );
  await waitForFauxLedgerRecord("call", 3);
  const canaryStreamingBeforeReplay = await waitForPacedStreamingProjection(
    hostId,
    activeBinding,
    CANARY_RESPONSE_TEXT,
    0,
    "Stop replay canary Prompt",
  );
  assertCursorAdvanced(
    stoppedProjection.latestCursor,
    canaryStreamingBeforeReplay.latestCursor,
    "Stop replay canary first delta",
  );
  const canaryPartialBeforeReplay = canaryStreamingBeforeReplay.inProgressStream.text.length;
  assertExactJson(
    await submitCommand(stopCommand),
    stopReceipt,
    "Replaying the completed Stop while a new Prompt streamed did not return its exact old receipt",
  );
  const canaryStreamingAfterReplay = await waitForPacedStreamingProjection(
    hostId,
    activeBinding,
    CANARY_RESPONSE_TEXT,
    canaryPartialBeforeReplay,
    "Stop replay canary Prompt after old Stop replay",
  );
  assertCursorAdvanced(
    canaryStreamingBeforeReplay.latestCursor,
    canaryStreamingAfterReplay.latestCursor,
    "canary continuation after completed Stop replay",
  );
  if (canaryStreamingAfterReplay.runtime.isStreaming !== true) {
    throw new Error("Replayed completed Stop aborted the active canary Prompt");
  }
  const canaryStopAcknowledgedReceipt = assertCommandReceipt(
    await submitCommand(canaryStopCommand),
    canaryStopCommand,
    "running",
    "Prime Agent accepted the stop request; authoritative runtime state will confirm idleness",
  );
  const [canaryPromptReceipt, canaryStopReceipt] = await Promise.all([
    waitForCompletedCommand(
      canaryPromptCommand,
      "Prime Agent is authoritatively idle after the acknowledged prompt",
    ),
    waitForCompletedCommand(
      canaryStopCommand,
      "Prime Agent is authoritatively idle after the acknowledged stop request",
    ),
  ]);
  await waitForFauxLedgerRecord("result", 3);
  const canaryStoppedProjection = assertIdleCommandProjection(
    (await requestHost(
      hostEndpoint,
      "thread.snapshot",
      { threadId: THREAD_ID },
      HOST_REQUEST_DEADLINE_MS,
    )).result,
    hostId,
    FAUX_MODEL_RUNTIME_ID,
    expectedActiveToolNames,
  );
  assertCursorAdvanced(
    canaryStreamingAfterReplay.latestCursor,
    canaryStoppedProjection.latestCursor,
    "canary Stop idle proof",
  );
  const canaryStoppedPartialCharacters = assertExactCanaryStoppedTurn(
    canaryStoppedProjection,
    stoppedPartialCharacters,
  );
  const idleProofExpectations = [
    {
      type: "resident.prompt_idle_observed",
      command: completedPromptCommand,
      acknowledgedReceipt: completedPromptAcknowledgedReceipt,
      receipt: completedPromptReceipt,
      observedCursor: completedPromptProjection.latestCursor,
    },
    {
      type: "resident.prompt_idle_observed",
      command: pacedPromptCommand,
      acknowledgedReceipt: pacedPromptAcknowledgedReceipt,
      receipt: pacedPromptReceipt,
      observedCursor: stoppedProjection.latestCursor,
    },
    {
      type: "resident.abort_idle_observed",
      command: stopCommand,
      acknowledgedReceipt: stopAcknowledgedReceipt,
      receipt: stopReceipt,
      observedCursor: stoppedProjection.latestCursor,
    },
    {
      type: "resident.prompt_idle_observed",
      command: canaryPromptCommand,
      acknowledgedReceipt: canaryPromptAcknowledgedReceipt,
      receipt: canaryPromptReceipt,
      observedCursor: canaryStoppedProjection.latestCursor,
    },
    {
      type: "resident.abort_idle_observed",
      command: canaryStopCommand,
      acknowledgedReceipt: canaryStopAcknowledgedReceipt,
      receipt: canaryStopReceipt,
      observedCursor: canaryStoppedProjection.latestCursor,
    },
  ];
  await assertResidentDispatchAttemptsEmpty();
  credentialFileState = await assertCredentialStoreEmpty();

  // Restart after all three provider calls, then reconcile and replay the exact
  // immutable commands. Store receipts and projection must survive byte-for-
  // byte while the extension ledger proves no Prompt replay crossed upstream.
  await stopHostd(hostdChild);
  hostdChild = undefined;
  hostdChild = await startReleaseHostd(credentialFree.environment);
  const commandRestartReady = await waitForResidentReadiness(hostdChild, true);
  assertSameRuntimeIdentity(restartedReady.health, commandRestartReady.health);
  if (commandRestartReady.health.host.hostId !== hostId) {
    throw new Error("Release host authority changed across command replay restart");
  }
  const commandRestartProjection = assertIdleCommandProjection(
    (await requestHost(
      hostEndpoint,
      "thread.snapshot",
      { threadId: THREAD_ID },
      HOST_REQUEST_DEADLINE_MS,
    )).result,
    hostId,
    FAUX_MODEL_RUNTIME_ID,
    expectedActiveToolNames,
  );
  assertDurableIdleProjectionTransition(
    canaryStoppedProjection,
    commandRestartProjection,
    "Durable authoritative idle projection changed across command replay restart",
  );
  for (const [command, receipt] of [
    [baselineModelSelectCommand, baselineModelSelectReceipt],
    [modelSelectCommand, modelSelectReceipt],
    [completedPromptCommand, completedPromptReceipt],
    [pacedPromptCommand, pacedPromptReceipt],
    [stopCommand, stopReceipt],
    [canaryPromptCommand, canaryPromptReceipt],
    [canaryStopCommand, canaryStopReceipt],
  ]) {
    assertExactJson(
      await reconcileCommand(command),
      receipt,
      `Completed ${command.command.kind} receipt changed across restart`,
    );
    assertExactJson(
      await submitCommand(command),
      receipt,
      `Completed ${command.command.kind} command replay crossed upstream`,
    );
  }
  const commandReplayProjection = assertIdleCommandProjection(
    (await requestHost(
      hostEndpoint,
      "thread.snapshot",
      { threadId: THREAD_ID },
      HOST_REQUEST_DEADLINE_MS,
    )).result,
    hostId,
    FAUX_MODEL_RUNTIME_ID,
    expectedActiveToolNames,
  );
  assertDurableIdleProjectionUnchanged(
    commandRestartProjection,
    commandReplayProjection,
    "Exact command replay changed the durable authoritative idle projection",
  );
  await assertResidentDispatchAttemptsEmpty();
  const preDrainCommandRestartDaemonAudit = await inspectResidentDaemon(
    runtimeRoot,
    "list",
    credentialFree.environment,
  );
  assertSingleDaemonSession(preDrainCommandRestartDaemonAudit, activeBinding, "live");
  await assertBindingRegistry("active", firstProjection.runtime, activeBinding);

  // Drain the upstream owner before freezing the provider ledger and host idle-
  // proof journal. A delayed duplicate dispatch can no longer hide behind a
  // successful replay response once this barrier has completed.
  await stopHostd(hostdChild);
  hostdChild = undefined;
  const commandLedger = await assertExactFauxLedger(
    stoppedPartialCharacters,
    canaryStoppedPartialCharacters,
  );
  const idleProofEvents = await assertExactIdleProofEvents(idleProofExpectations, activeBinding);

  hostdChild = await startReleaseHostd(credentialFree.environment);
  const postDrainReplayReady = await waitForResidentReadiness(hostdChild, true);
  assertSameRuntimeIdentity(commandRestartReady.health, postDrainReplayReady.health);
  if (postDrainReplayReady.health.host.hostId !== hostId) {
    throw new Error("Release host authority changed across post-replay drain restart");
  }
  const postDrainReplayProjection = assertIdleCommandProjection(
    (await requestHost(
      hostEndpoint,
      "thread.snapshot",
      { threadId: THREAD_ID },
      HOST_REQUEST_DEADLINE_MS,
    )).result,
    hostId,
    FAUX_MODEL_RUNTIME_ID,
    expectedActiveToolNames,
  );
  assertDurableIdleProjectionTransition(
    commandReplayProjection,
    postDrainReplayProjection,
    "Durable authoritative idle projection changed after the replay drain barrier",
  );
  assertExactJson(
    await assertExactFauxLedger(stoppedPartialCharacters, canaryStoppedPartialCharacters),
    commandLedger,
    "Provider ledger changed after the replay drain barrier",
  );
  assertExactJson(
    await assertExactIdleProofEvents(idleProofExpectations, activeBinding),
    idleProofEvents,
    "Attempt-scoped idle proof events changed after the replay drain barrier",
  );
  await assertResidentDispatchAttemptsEmpty();
  const commandRestartDaemonAudit = await inspectResidentDaemon(
    runtimeRoot,
    "list",
    credentialFree.environment,
  );
  assertSingleDaemonSession(commandRestartDaemonAudit, activeBinding, "live");
  await assertBindingRegistry("active", firstProjection.runtime, activeBinding);

  // End uses the same trusted-user protocol and production coordinator. The
  // only direct daemon access below is read-only audit plus final cleanup.
  const preEndSnapshotResponse = await requestHost(
    hostEndpoint,
    "thread.snapshot",
    { threadId: THREAD_ID },
    HOST_REQUEST_DEADLINE_MS,
  );
  const preEndProjection = assertIdleCommandProjection(
    preEndSnapshotResponse.result,
    hostId,
    FAUX_MODEL_RUNTIME_ID,
    expectedActiveToolNames,
  );
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
  assertSingleDaemonSession(staleEndDaemonAudit, activeBinding, "live");

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
  assertDaemonTermination(daemonShutdown);
  daemonObserved = false;

  successReport = {
    schemaVersion: 3,
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
      promptSent: true,
      providerTransport: "smoke_extension_custom_stream",
      providerNetworkUsed: false,
      providerCredentialKind: "fixed_non_secret_sentinel",
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
    productionCommands: {
      transport: "trusted_user_local_protocol",
      providerRegistration: "prime_extension_api",
      selectedModel: FAUX_MODEL_RUNTIME_ID,
      baselineModelSelectionStatus: baselineModelSelectReceipt.status,
      modelSelectionStatus: modelSelectReceipt.status,
      completedPromptIdleProofStatus: completedPromptReceipt.status,
      pacedPromptIdleProofStatus: pacedPromptReceipt.status,
      urgentStopIdleProofStatus: stopReceipt.status,
      stopReplayCanaryPromptIdleProofStatus: canaryPromptReceipt.status,
      stopReplayCanaryStopIdleProofStatus: canaryStopReceipt.status,
      completedAssistantProjectionExact: true,
      pacedProviderStopReason: "aborted",
      completedStopReplayReturnedExactReceipt: true,
      completedStopReplayPreservedActiveCanary: true,
      canaryPartialAdvancedAfterStopReplay: true,
      canaryProviderStopReason: "aborted",
      idleProjectionExact: true,
      hostRestartVerified: true,
      replayDrainBarrierVerified: true,
      exactReceiptReplaySuppressed: true,
      providerCallCount: commandLedger.records.filter((record) => record.type === "call").length,
      providerLedgerRecordCount: commandLedger.records.length,
      promptIdleProofEventCount: idleProofEvents.filter(
        (record) => record.type === "resident.prompt_idle_observed",
      ).length,
      abortIdleProofEventCount: idleProofEvents.filter(
        (record) => record.type === "resident.abort_idle_observed",
      ).length,
    },
    upstreamAudit: {
      mode: "read_only_list",
      sessionsAfterProvision: firstDaemonAudit.sessions.length,
      sessionsAfterRestart: restartDaemonAudit.sessions.length,
      sessionsAfterCommandRestart: commandRestartDaemonAudit.sessions.length,
      sessionsAfterStaleEndConsent: staleEndDaemonAudit.sessions.length,
      sessionsAfterEnd: endedDaemonAudit.sessions.length,
      sessionsAfterTerminalRestart: finalDaemonAudit.sessions.length,
      daemonShutdownConfirmed: true,
      daemonEndpointTerminated: daemonShutdown.endpointTerminated,
      daemonOwnerRetired: daemonShutdown.ownerRetired,
      daemonProcessIdentityCount: daemonShutdown.processIdentityCount,
      terminatedDaemonProcessIdentityCount: daemonShutdown.terminatedProcessIdentityCount,
    },
  };
} catch (error) {
  primaryFailure = error;
}

const cleanupFailures = [];
if (hostdChild) {
  try {
    await stopHostd(hostdChild);
  } catch (error) {
    cleanupFailures.push(new Error("Release hostd cleanup failed", { cause: error }));
  } finally {
    hostdChild = undefined;
  }
}
if (daemonObserved && runtimeRoot) {
  try {
    const cleanupAudit = await inspectResidentDaemon(
      runtimeRoot,
      "shutdown",
      credentialFree.environment,
    );
    assertDaemonTermination(cleanupAudit);
    daemonObserved = false;
  } catch (error) {
    cleanupFailures.push(new Error("Resident daemon cleanup failed", { cause: error }));
  }
}
try {
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
} catch (error) {
  cleanupFailures.push(new Error("Resident lifecycle smoke temporary-root cleanup failed", {
    cause: error,
  }));
}

if (primaryFailure) {
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      "Resident lifecycle smoke failed and cleanup was incomplete",
    );
  }
  throw primaryFailure;
}
if (cleanupFailures.length > 0) {
  throw new AggregateError(cleanupFailures, "Resident lifecycle smoke cleanup was incomplete");
}
if (!successReport) {
  throw new Error("Resident lifecycle smoke completed without an assurance report");
}
process.stdout.write(`${JSON.stringify(successReport, null, 2)}\n`);

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

function freezeCommandEnvelope(hostId, commandId, command) {
  return Object.freeze({
    protocolVersion: 1,
    deviceId: COMMAND_DEVICE_ID,
    commandId,
    expectedHostId: hostId,
    threadId: THREAD_ID,
    issuedAt: new Date().toISOString(),
    expectedExecutionGenerationId: EXECUTION_GENERATION_ID,
    command: Object.freeze({ ...command }),
  });
}

async function submitCommand(command) {
  const response = await requestHost(
    hostEndpoint,
    "command.submit",
    { command },
    LIFECYCLE_REQUEST_DEADLINE_MS,
  );
  assertPathFree(response.result, `${command.command.kind} command receipt`);
  return response.result;
}

async function reconcileCommand(command) {
  const response = await requestHost(
    hostEndpoint,
    "command.reconcile",
    { expectedHostId: command.expectedHostId, commands: [command] },
    HOST_REQUEST_DEADLINE_MS,
  );
  const reconciliation = response.result;
  if (
    !reconciliation ||
    !Array.isArray(reconciliation.receipts) ||
    !Array.isArray(reconciliation.unknown) ||
    reconciliation.receipts.length !== 1 ||
    reconciliation.unknown.length !== 0
  ) {
    throw new Error(`Completed ${command.command.kind} command reconciled as unknown`);
  }
  assertCommandReceiptIdentity(reconciliation.receipts[0], command);
  assertPathFree(reconciliation, `${command.command.kind} command reconciliation`);
  return reconciliation.receipts[0];
}

async function waitForCompletedCommand(command, expectedMessage) {
  const deadline = Date.now() + READY_DEADLINE_MS;
  let lastReceipt;
  while (Date.now() < deadline) {
    lastReceipt = await reconcileCommand(command);
    if (lastReceipt.status === "completed") {
      return assertCommandReceipt(lastReceipt, command, "completed", expectedMessage);
    }
    if (!new Set(["received", "admitted", "running"]).has(lastReceipt.status)) {
      throw new Error(
        `${command.command.kind} command reached unexpected ${lastReceipt.status}: ` +
          `${JSON.stringify(lastReceipt)}`,
      );
    }
    await delay(50);
  }
  throw new Error(
    `${command.command.kind} command did not complete from authoritative idle proof: ` +
      `${JSON.stringify(lastReceipt)}`,
  );
}

function assertCommandReceipt(receipt, command, expectedStatus, expectedMessage) {
  assertCommandReceiptIdentity(receipt, command);
  if (
    receipt.status !== expectedStatus ||
    receipt.message !== expectedMessage ||
    receipt.queuePosition !== undefined ||
    receipt.error !== undefined
  ) {
    throw new Error(
      `${command.command.kind} command did not return exact ${expectedStatus} receipt: ` +
        `${JSON.stringify(receipt)}`,
    );
  }
  return receipt;
}

function assertCommandReceiptIdentity(receipt, command) {
  if (
    !receipt ||
    receipt.protocolVersion !== 1 ||
    typeof receipt.receiptId !== "string" ||
    receipt.receiptId.length < 1 ||
    receipt.deviceId !== command.deviceId ||
    receipt.commandId !== command.commandId ||
    receipt.threadId !== command.threadId ||
    receipt.executionGenerationId !== command.expectedExecutionGenerationId ||
    typeof receipt.receivedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.receivedAt)) ||
    typeof receipt.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.updatedAt)) ||
    Date.parse(receipt.updatedAt) < Date.parse(receipt.receivedAt)
  ) {
    throw new Error(`${command.command.kind} command returned an invalid receipt identity`);
  }
}

function assertIdleCommandProjection(snapshot, hostId, expectedModel, expectedActiveToolNames) {
  assertActiveProjection(snapshot, hostId);
  if (
    snapshot.runtime.model !== expectedModel ||
    snapshot.runtime.isStreaming !== false ||
    snapshot.runtime.isCompacting !== false ||
    snapshot.runtime.isBashRunning !== false ||
    snapshot.runtime.queuedActionCount !== 0 ||
    !isDeepStrictEqual(snapshot.runtime.activeToolNames, expectedActiveToolNames) ||
    snapshot.inProgressStream !== undefined ||
    snapshot.queueState?.paused !== false ||
    snapshot.queueState.pendingCommandIds?.length !== 0 ||
    snapshot.approvals?.length !== 0 ||
    snapshot.childAgents?.length !== 0 ||
    snapshot.goals?.length !== 0 ||
    snapshot.schedules?.length !== 0 ||
    snapshot.pendingAttention?.length !== 0 ||
    !isDeepStrictEqual(snapshot.thread.lastKnownCursor, snapshot.latestCursor)
  ) {
    throw new Error(
      "Release hostd did not publish an exact idle provider-command projection: " +
        JSON.stringify({
          expectedModel,
          runtime: snapshot.runtime,
          inProgressStream: snapshot.inProgressStream,
          queueState: snapshot.queueState,
          approvals: snapshot.approvals,
          childAgents: snapshot.childAgents,
          goals: snapshot.goals,
          schedules: snapshot.schedules,
          pendingAttention: snapshot.pendingAttention,
          threadCursor: snapshot.thread.lastKnownCursor,
          latestCursor: snapshot.latestCursor,
        }),
    );
  }
  return snapshot;
}

async function waitForPacedStreamingProjection(
  hostId,
  binding,
  expectedResponse,
  minimumCharacters,
  label,
) {
  if (
    typeof expectedResponse !== "string" ||
    expectedResponse.length < 2 ||
    !Number.isSafeInteger(minimumCharacters) ||
    minimumCharacters < 0 ||
    minimumCharacters >= expectedResponse.length ||
    typeof label !== "string" ||
    label.length < 1
  ) {
    throw new Error("Paced streaming projection assertion received an invalid boundary");
  }
  const deadline = Date.now() + READY_DEADLINE_MS;
  let lastProjection;
  while (Date.now() < deadline) {
    if (hostdChild) assertChildAlive(hostdChild);
    lastProjection = (await requestHost(
      hostEndpoint,
      "thread.snapshot",
      { threadId: THREAD_ID },
      HOST_REQUEST_DEADLINE_MS,
    )).result;
    const partial = lastProjection?.inProgressStream?.text;
    if (
      lastProjection?.thread?.threadId === THREAD_ID &&
      lastProjection.thread.projectIdentity === PROJECT_ID &&
      lastProjection.thread.currentLocation?.hostId === hostId &&
      lastProjection.thread.currentLocation.projectId === PROJECT_ID &&
      lastProjection.thread.currentLocation.workspaceId === WORKSPACE_ID &&
      lastProjection.thread.currentLocation.executionGenerationId === EXECUTION_GENERATION_ID &&
      lastProjection.runtime?.runtime === "prime_agent" &&
      lastProjection.runtime.residency === "resident" &&
      lastProjection.runtime.activeSessionId === binding.activeSessionId &&
      lastProjection.runtime.sessionId === binding.sessionId &&
      lastProjection.runtime.model === FAUX_MODEL_RUNTIME_ID &&
      lastProjection.runtime.isStreaming === true &&
      typeof partial === "string" &&
      partial.length > minimumCharacters &&
      partial.length < expectedResponse.length &&
      expectedResponse.startsWith(partial) &&
      lastProjection.residentLifecycle === undefined
    ) {
      assertPathFree(lastProjection, `${label} streaming projection`);
      return lastProjection;
    }
    await delay(25);
  }
  throw new Error(
    `${label} did not publish a strict same-binding partial beyond ${minimumCharacters} characters: ` +
      `${JSON.stringify(lastProjection)}`,
  );
}

function durableIdleCommandProjection(snapshot) {
  const { updatedAt: _updatedAt, lastKnownCursor: _lastKnownCursor, ...thread } = snapshot.thread;
  return {
    snapshotVersion: snapshot.snapshotVersion,
    thread,
    transcriptBlockIndex: snapshot.transcriptBlockIndex,
    materializedRecentBlocks: snapshot.materializedRecentBlocks,
    queueState: snapshot.queueState,
    approvals: snapshot.approvals,
    childAgents: snapshot.childAgents,
    goals: snapshot.goals,
    schedules: snapshot.schedules,
    runtime: snapshot.runtime,
    git: snapshot.git,
    evidence: snapshot.evidence,
    pendingAttention: snapshot.pendingAttention,
  };
}

function assertDurableIdleProjectionTransition(before, after, message) {
  assertExactJson(
    durableIdleCommandProjection(after),
    durableIdleCommandProjection(before),
    message,
  );
  const beforeCursor = before.latestCursor;
  const afterCursor = after.latestCursor;
  const sameAuthority = beforeCursor.threadId === afterCursor.threadId &&
    beforeCursor.executionGenerationId === afterCursor.executionGenerationId &&
    beforeCursor.generation === afterCursor.generation;
  const beforeUpdatedAt = Date.parse(before.thread.updatedAt);
  const afterUpdatedAt = Date.parse(after.thread.updatedAt);
  const cursorAdvanced = afterCursor.sequence > beforeCursor.sequence;
  if (
    !sameAuthority ||
    afterCursor.sequence < beforeCursor.sequence ||
    !isDeepStrictEqual(after.thread.lastKnownCursor, afterCursor) ||
    !Number.isFinite(beforeUpdatedAt) ||
    !Number.isFinite(afterUpdatedAt) ||
    afterUpdatedAt < beforeUpdatedAt ||
    (cursorAdvanced && afterUpdatedAt <= beforeUpdatedAt) ||
    (!cursorAdvanced && after.thread.updatedAt !== before.thread.updatedAt)
  ) {
    throw new Error(`${message}: causal resident cursor metadata is invalid`);
  }
}

function assertDurableIdleProjectionUnchanged(before, after, message) {
  assertExactJson(
    durableIdleCommandProjection(after),
    durableIdleCommandProjection(before),
    message,
  );
  if (
    !isDeepStrictEqual(after.latestCursor, before.latestCursor) ||
    !isDeepStrictEqual(after.thread.lastKnownCursor, before.thread.lastKnownCursor) ||
    after.thread.updatedAt !== before.thread.updatedAt
  ) {
    throw new Error(`${message}: command replay advanced causal resident metadata`);
  }
}

function assertCursorAdvanced(before, after, label) {
  const sameAuthority = before?.threadId === THREAD_ID &&
    after?.threadId === THREAD_ID &&
    before.executionGenerationId === EXECUTION_GENERATION_ID &&
    after.executionGenerationId === EXECUTION_GENERATION_ID;
  const advanced = before.generation === after.generation
    ? after.sequence > before.sequence
    : typeof after.generation === "string" && after.generation.length > 0;
  if (!sameAuthority || !advanced) {
    throw new Error(`Authoritative resident cursor did not advance after ${label}`);
  }
}

function assertExactCompletedTurn(snapshot, options = {}) {
  const blocks = snapshot.materializedRecentBlocks;
  const userIndex = blocks.findLastIndex(
    (block) => block.kind === "user" && block.text === COMPLETED_PROMPT_TEXT,
  );
  const user = blocks[userIndex];
  const assistant = blocks[userIndex + 1];
  const compactionStatus = blocks[userIndex + 2];
  if (
    userIndex !== 0 ||
    assistant?.kind !== "assistant" ||
    assistant.text !== COMPLETED_RESPONSE_TEXT ||
    assistant.sequence !== user.sequence + 1 ||
    compactionStatus?.kind !== "status" ||
    compactionStatus.text !== COMPLETED_COMPACTION_STATUS_TEXT ||
    compactionStatus.sequence !== assistant.sequence + 1 ||
    (!options.allowFollowingTurns && blocks.length !== userIndex + 3) ||
    blocks.filter(
      (block) => block.kind === "user" && block.text === COMPLETED_PROMPT_TEXT,
    ).length !== 1 ||
    blocks.filter(
      (block) => block.kind === "assistant" && block.text === COMPLETED_RESPONSE_TEXT,
    ).length !== 1
  ) {
    throw new Error("Completed provider Prompt did not materialize its exact transcript turn");
  }
  assertExactMaterializedIndex(snapshot, user);
  assertExactMaterializedIndex(snapshot, assistant);
  assertExactMaterializedIndex(snapshot, compactionStatus);
}

function assertExactStoppedTurn(snapshot, options = {}) {
  assertExactCompletedTurn(snapshot, { allowFollowingTurns: true });
  const blocks = snapshot.materializedRecentBlocks;
  const completedUserIndex = blocks.findLastIndex(
    (block) => block.kind === "user" && block.text === COMPLETED_PROMPT_TEXT,
  );
  const pacedUserIndex = blocks.findLastIndex(
    (block) => block.kind === "user" && block.text === PACED_PROMPT_TEXT,
  );
  if (pacedUserIndex !== completedUserIndex + 4) {
    throw new Error("Urgently stopped provider Prompt did not follow its exact compaction boundary");
  }
  return assertExactAbortedTurn(
    snapshot,
    PACED_PROMPT_TEXT,
    PACED_RESPONSE_TEXT,
    "Urgently stopped provider Prompt",
    { ...options, requirePreTurnCompactionStatus: true },
  );
}

function assertExactCanaryStoppedTurn(snapshot, expectedPacedCharacters) {
  assertExactCompletedTurn(snapshot, { allowFollowingTurns: true });
  const blocks = snapshot.materializedRecentBlocks;
  const pacedUserIndex = blocks.findLastIndex(
    (block) => block.kind === "user" && block.text === PACED_PROMPT_TEXT,
  );
  const pacedCharacters = assertExactStoppedTurn(snapshot, { allowFollowingTurns: true });
  const canaryUserIndex = blocks.findLastIndex(
    (block) => block.kind === "user" && block.text === CANARY_PROMPT_TEXT,
  );
  if (
    pacedCharacters !== expectedPacedCharacters ||
    pacedUserIndex < 0 ||
    canaryUserIndex !== pacedUserIndex + 3
  ) {
    throw new Error("Stop replay canary changed the exact previously stopped transcript turn");
  }
  return assertExactAbortedTurn(
    snapshot,
    CANARY_PROMPT_TEXT,
    CANARY_RESPONSE_TEXT,
    "Canary Stop",
    { requirePreTurnCompactionStatus: true },
  );
}

function assertExactAbortedTurn(
  snapshot,
  expectedPrompt,
  expectedResponse,
  label,
  options = {},
) {
  const blocks = snapshot.materializedRecentBlocks;
  const userIndex = blocks.findLastIndex(
    (block) => block.kind === "user" && block.text === expectedPrompt,
  );
  const user = blocks[userIndex];
  const assistant = blocks[userIndex + 1];
  const preTurnCompactionStatus = blocks[userIndex - 1];
  const abortedText = assistant?.text;
  const exactError = "Error: Request was aborted";
  const partial = typeof abortedText === "string" && abortedText.endsWith(`\n\n${exactError}`)
    ? abortedText.slice(0, -(`\n\n${exactError}`).length)
    : abortedText === exactError
      ? ""
      : undefined;
  if (
    userIndex < 0 ||
    assistant?.kind !== "assistant" ||
    assistant.sequence !== user.sequence + 1 ||
    (options.requirePreTurnCompactionStatus && (
      preTurnCompactionStatus?.kind !== "status" ||
      preTurnCompactionStatus.text !== COMPLETED_COMPACTION_STATUS_TEXT ||
      preTurnCompactionStatus.sequence !== user.sequence - 1
    )) ||
    partial === undefined ||
    partial.length < 1 ||
    !expectedResponse.startsWith(partial) ||
    partial === expectedResponse ||
    blocks.filter(
      (block) => block.kind === "user" && block.text === expectedPrompt,
    ).length !== 1 ||
    (!options.allowFollowingTurns && blocks.length !== userIndex + 2)
  ) {
    throw new Error(`${label} did not materialize its exact aborted transcript turn`);
  }
  assertExactMaterializedIndex(snapshot, user);
  assertExactMaterializedIndex(snapshot, assistant);
  if (options.requirePreTurnCompactionStatus) {
    assertExactMaterializedIndex(snapshot, preTurnCompactionStatus);
  }
  return partial.length;
}

function assertExactMaterializedIndex(snapshot, block) {
  const entries = snapshot.transcriptBlockIndex.filter((entry) => entry.blockId === block.blockId);
  const expected = {
    blockId: block.blockId,
    kind: block.kind,
    sequence: block.sequence,
    byteLength: Buffer.byteLength(block.text, "utf8"),
    materialized: true,
  };
  if (entries.length !== 1 || !isDeepStrictEqual(entries[0], expected)) {
    throw new Error("Resident transcript materialization index changed exact block identity");
  }
}

async function waitForFauxLedgerRecord(type, ordinal) {
  const deadline = Date.now() + READY_DEADLINE_MS;
  let records = [];
  while (Date.now() < deadline) {
    if (hostdChild) assertChildAlive(hostdChild);
    records = await readFauxLedger();
    const failure = records.find((record) => record.type === "failure");
    if (failure) {
      throw new Error(`Deterministic provider stream result failed for invocation ${failure.ordinal}`);
    }
    if (records.some((record) => record.type === type && record.ordinal === ordinal)) return records;
    await delay(25);
  }
  throw new Error(
    `Deterministic provider ledger did not record ${type} ${ordinal}: ${JSON.stringify(records)}`,
  );
}

async function assertExactFauxLedger(expectedPacedCharacters, expectedCanaryCharacters) {
  const records = await readFauxLedger();
  const pacedResult = records[3];
  const canaryResult = records[5];
  if (
    pacedResult?.type !== "result" ||
    !Number.isSafeInteger(pacedResult.emittedChars) ||
    pacedResult.emittedChars !== expectedPacedCharacters ||
    pacedResult.emittedChars >= PACED_RESPONSE_TEXT.length
  ) {
    throw new Error("Deterministic provider ledger lost the strict paced partial boundary");
  }
  if (
    canaryResult?.type !== "result" ||
    !Number.isSafeInteger(canaryResult.emittedChars) ||
    canaryResult.emittedChars !== expectedCanaryCharacters ||
    canaryResult.emittedChars >= CANARY_RESPONSE_TEXT.length
  ) {
    throw new Error("Deterministic provider ledger lost the strict Stop replay canary boundary");
  }
  const expected = [
    {
      version: 1,
      type: "call",
      ordinal: 1,
      promptIdentity: promptIdentity(COMPLETED_PROMPT_TEXT),
      apiId: FAUX_API_ID,
      providerId: FAUX_PROVIDER_ID,
      modelId: FAUX_MODEL_ID,
      signalPresent: true,
    },
    {
      version: 1,
      type: "result",
      ordinal: 1,
      promptIdentity: promptIdentity(COMPLETED_PROMPT_TEXT),
      apiId: FAUX_API_ID,
      providerId: FAUX_PROVIDER_ID,
      modelId: FAUX_MODEL_ID,
      signalAborted: false,
      emittedChars: COMPLETED_RESPONSE_TEXT.length,
      stopReason: "stop",
    },
    {
      version: 1,
      type: "call",
      ordinal: 2,
      promptIdentity: promptIdentity(PACED_PROMPT_TEXT),
      apiId: FAUX_API_ID,
      providerId: FAUX_PROVIDER_ID,
      modelId: FAUX_MODEL_ID,
      signalPresent: true,
    },
    {
      version: 1,
      type: "result",
      ordinal: 2,
      promptIdentity: promptIdentity(PACED_PROMPT_TEXT),
      apiId: FAUX_API_ID,
      providerId: FAUX_PROVIDER_ID,
      modelId: FAUX_MODEL_ID,
      signalAborted: true,
      emittedChars: pacedResult.emittedChars,
      stopReason: "aborted",
    },
    {
      version: 1,
      type: "call",
      ordinal: 3,
      promptIdentity: promptIdentity(CANARY_PROMPT_TEXT),
      apiId: FAUX_API_ID,
      providerId: FAUX_PROVIDER_ID,
      modelId: FAUX_MODEL_ID,
      signalPresent: true,
    },
    {
      version: 1,
      type: "result",
      ordinal: 3,
      promptIdentity: promptIdentity(CANARY_PROMPT_TEXT),
      apiId: FAUX_API_ID,
      providerId: FAUX_PROVIDER_ID,
      modelId: FAUX_MODEL_ID,
      signalAborted: true,
      emittedChars: canaryResult.emittedChars,
      stopReason: "aborted",
    },
  ];
  if (!isDeepStrictEqual(records, expected)) {
    throw new Error(`Deterministic provider call ledger changed: ${JSON.stringify(records)}`);
  }
  const bytes = await readFile(fauxLedgerPath);
  if (bytes.byteLength > MAX_FAUX_LEDGER_BYTES) {
    throw new Error("Deterministic provider ledger exceeded its smoke-owned bound");
  }
  return Object.freeze({
    records: Object.freeze(records),
    bytes: bytes.toString("utf8"),
  });
}

async function readFauxLedger() {
  let bytes;
  try {
    bytes = await readFile(fauxLedgerPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  }
  if (bytes.byteLength > MAX_FAUX_LEDGER_BYTES) {
    throw new Error("Deterministic provider ledger exceeded its smoke-owned bound");
  }
  if (bytes.byteLength === 0) return [];
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("Deterministic provider ledger has a partial record");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > MAX_FAUX_LEDGER_RECORDS) {
    throw new Error("Deterministic provider ledger exceeded its record bound");
  }
  return lines.map((line, index) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`Deterministic provider ledger record ${index} is invalid JSON`, { cause: error });
    }
    if (record?.type === "failure") {
      if (
        record.version !== 1 ||
        !Number.isSafeInteger(record.ordinal) ||
        record.ordinal < 1 ||
        record.ordinal > 3 ||
        !isDeepStrictEqual(Object.keys(record).sort(), ["ordinal", "type", "version"])
      ) {
        throw new Error(`Deterministic provider failure record ${index} changed its bounded schema`);
      }
      return record;
    }
    const expectedKeys = record?.type === "call"
      ? [
          "apiId",
          "modelId",
          "ordinal",
          "promptIdentity",
          "providerId",
          "signalPresent",
          "type",
          "version",
        ]
      : record?.type === "result"
        ? [
            "apiId",
            "emittedChars",
            "modelId",
            "ordinal",
            "promptIdentity",
            "providerId",
            "signalAborted",
            "stopReason",
            "type",
            "version",
          ]
        : [];
    if (
      record?.version !== 1 ||
      !Number.isSafeInteger(record.ordinal) ||
      record.ordinal < 1 ||
      record.ordinal > 3 ||
      !isDeepStrictEqual(Object.keys(record).sort(), expectedKeys) ||
      record.apiId !== FAUX_API_ID ||
      record.providerId !== FAUX_PROVIDER_ID ||
      record.modelId !== FAUX_MODEL_ID ||
      ![
        promptIdentity(COMPLETED_PROMPT_TEXT),
        promptIdentity(PACED_PROMPT_TEXT),
        promptIdentity(CANARY_PROMPT_TEXT),
      ]
        .includes(record.promptIdentity) ||
      (record.type === "call" && (
        record.signalPresent !== true
      )) ||
      (record.type === "result" && (
        typeof record.signalAborted !== "boolean" ||
        !Number.isSafeInteger(record.emittedChars) ||
        record.emittedChars < 0 ||
        !["stop", "aborted"].includes(record.stopReason)
      ))
    ) {
      throw new Error(`Deterministic provider ledger record ${index} changed its bounded schema`);
    }
    return record;
  });
}

function promptIdentity(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function assertExactIdleProofEvents(expectations, binding) {
  const eventJournalPath = join(dataDirectory, "journals", "events.jsonl");
  const bytes = await readFile(eventJournalPath);
  if (bytes.byteLength > MAX_FRAME_BYTES) {
    throw new Error("Host event journal exceeded its packaged smoke inspection bound");
  }
  const records = bytes.toString("utf8").split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Host event journal record ${index} is invalid JSON`, { cause: error });
    }
  });
  const proofRecords = records.filter((record) =>
    record?.threadId === THREAD_ID &&
    ["resident.prompt_idle_observed", "resident.abort_idle_observed"].includes(record.type));
  if (proofRecords.length !== expectations.length) {
    throw new Error(
      `Host event journal has ${proofRecords.length} resident idle proofs; expected ${expectations.length}`,
    );
  }
  const fingerprint = residentBindingFingerprint(binding);
  for (const expected of expectations) {
    const matches = proofRecords.filter((record) => record.detail === expected.command.commandId);
    const record = matches[0];
    const property = expected.type === "resident.prompt_idle_observed"
      ? "residentPromptIdleObserved"
      : "residentAbortIdleObserved";
    const otherProperty = expected.type === "resident.prompt_idle_observed"
      ? "residentAbortIdleObserved"
      : "residentPromptIdleObserved";
    const observation = record?.[property];
    if (
      matches.length !== 1 ||
      record.version !== 1 ||
      record.type !== expected.type ||
      record.threadId !== THREAD_ID ||
      record.sequence !== expected.observedCursor.sequence ||
      record.recordedAt !== observation?.observedAt ||
      record[otherProperty] !== undefined ||
      observation?.eventVersion !== 1 ||
      typeof observation.attemptId !== "string" ||
      observation.attemptId.length < 1 ||
      !isDeepStrictEqual(observation.command, expected.command) ||
      !isDeepStrictEqual(observation.acknowledgedReceipt, expected.acknowledgedReceipt) ||
      !isDeepStrictEqual(observation.receipt, expected.receipt) ||
      !isDeepStrictEqual(observation.binding, binding) ||
      observation.bindingFingerprint !== fingerprint ||
      !isDeepStrictEqual(observation.observedCursor, expected.observedCursor) ||
      observation.receipt.updatedAt !== observation.observedAt ||
      observation.acknowledgedReceipt.status !== "running" ||
      observation.receipt.status !== "completed" ||
      observation.acknowledgedReceipt.receiptId !== observation.receipt.receiptId ||
      observation.acknowledgedReceipt.receivedAt !== observation.receipt.receivedAt ||
      observation.observedCursor.threadId !== THREAD_ID ||
      observation.observedCursor.executionGenerationId !== EXECUTION_GENERATION_ID
    ) {
      throw new Error(
        `Host event journal lost exact attempt-scoped idle proof for ${expected.command.commandId}`,
      );
    }
  }
  return Object.freeze(
    proofRecords.slice().sort((left, right) => left.detail.localeCompare(right.detail)),
  );
}

async function assertResidentDispatchAttemptsEmpty() {
  const attemptsDirectory = join(dataDirectory, "resident-dispatch-attempts");
  const entries = await readdir(attemptsDirectory, { withFileTypes: true });
  if (entries.length !== 0) {
    throw new Error(
      `Settled resident dispatch attempts were not retired: ${entries.map((entry) => entry.name).join(", ")}`,
    );
  }
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
  const expectedProcessIdentities = action === "shutdown" ? daemonProcessIdentities : [];
  const result = await runProcess(
    electronExecutable,
    [
      daemonAuditPath,
      pathToFileURL(daemonClientPath).href,
      residentEndpoint,
      action,
      agentDirectory,
      JSON.stringify(expectedProcessIdentities),
    ],
    { cwd: REPO_ROOT, environment, timeoutMs: HELPER_DEADLINE_MS },
  );
  let audit;
  try {
    audit = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Resident daemon ${action} audit returned invalid JSON`, { cause: error });
  }
  recordDaemonProcessIdentities(audit, action === "list");
  return audit;
}

function recordDaemonProcessIdentities(audit, requireSingleSupervisor) {
  const identities = audit?.processIdentities;
  if (!Array.isArray(identities) || identities.length < 1 || identities.length > MAX_DAEMON_PROCESS_IDENTITIES) {
    throw new Error("Read-only daemon audit did not return bounded exact process identities");
  }
  const seen = new Set();
  let supervisorCount = 0;
  for (const identity of identities) {
    const keys = Object.keys(identity ?? {}).sort();
    const key = `${identity?.pid}:${identity?.processStartId}`;
    if (
      !isDeepStrictEqual(keys, ["pid", "processStartId", "role"]) ||
      !["supervisor", "worker"].includes(identity.role) ||
      !Number.isSafeInteger(identity.pid) ||
      identity.pid < 1 ||
      typeof identity.processStartId !== "string" ||
      identity.processStartId.length < 1 ||
      identity.processStartId.length > 512 ||
      seen.has(key)
    ) {
      throw new Error("Read-only daemon audit returned an invalid exact process identity");
    }
    seen.add(key);
    if (identity.role === "supervisor") supervisorCount += 1;
  }
  if ((requireSingleSupervisor && supervisorCount !== 1) || supervisorCount < 1) {
    throw new Error("Daemon audit did not identify the required exact supervisor process identity");
  }
  const merged = new Map(
    daemonProcessIdentities.map((identity) => [`${identity.pid}:${identity.processStartId}`, identity]),
  );
  for (const identity of identities) {
    merged.set(
      `${identity.pid}:${identity.processStartId}`,
      Object.freeze({
        role: identity.role,
        pid: identity.pid,
        processStartId: identity.processStartId,
      }),
    );
  }
  if (merged.size > MAX_DAEMON_PROCESS_IDENTITIES) {
    throw new Error("Resident daemon exceeded the smoke-owned process identity bound");
  }
  daemonProcessIdentities = Object.freeze(
    [...merged.values()].sort((left, right) =>
      left.role.localeCompare(right.role) ||
      left.pid - right.pid ||
      left.processStartId.localeCompare(right.processStartId)),
  );
}

function assertSingleDaemonSession(audit, expectedBinding, expectedLifecycle) {
  const session = audit?.sessions?.[0];
  if (
    audit?.auditVersion !== 1 ||
    audit.action !== "list" ||
    !Array.isArray(audit.sessions) ||
    audit.sessions.length !== 1 ||
    audit.processIdentities.filter((identity) => identity.role === "worker").length < 1 ||
    session?.activeSessionId !== expectedBinding.activeSessionId ||
    session.sessionId !== expectedBinding.sessionId ||
    !["draft", "live"].includes(expectedLifecycle) ||
    session.lifecycle !== expectedLifecycle ||
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

function assertDaemonTermination(audit) {
  const keys = Object.keys(audit ?? {}).sort();
  if (
    !isDeepStrictEqual(keys, [
      "action",
      "auditVersion",
      "endpointTerminated",
      "ownerRetired",
      "processIdentities",
      "processIdentityCount",
      "shutdownConfirmed",
      "terminatedProcessIdentityCount",
    ]) ||
    audit?.auditVersion !== 1 ||
    audit.action !== "shutdown" ||
    audit.shutdownConfirmed !== true ||
    audit.endpointTerminated !== true ||
    audit.ownerRetired !== true ||
    !Number.isSafeInteger(audit.processIdentityCount) ||
    audit.processIdentityCount !== daemonProcessIdentities.length ||
    audit.processIdentityCount < 1 ||
    audit.terminatedProcessIdentityCount !== audit.processIdentityCount
  ) {
    throw new Error("Resident daemon cleanup did not prove exact endpoint, owner, and process termination");
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

function fauxProviderExtensionSource() {
  const baselineModelDefinition = {
    id: FAUX_BASELINE_MODEL_ID,
    name: "Continuim deterministic baseline model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 4_096,
  };
  const modelDefinition = {
    id: FAUX_MODEL_ID,
    name: "Continuim deterministic smoke model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 4_096,
  };
  return [
    'import { createHash } from "node:crypto";',
    'import { closeSync, fsyncSync, openSync, statSync, writeSync } from "node:fs";',
    'import { fauxAssistantMessage, getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai";',
    `const LEDGER_PATH = ${JSON.stringify(fauxLedgerPath)};`,
    `const MAX_LEDGER_BYTES = ${MAX_FAUX_LEDGER_BYTES};`,
    `const PROVIDER_ID = ${JSON.stringify(FAUX_PROVIDER_ID)};`,
    `const BASELINE_MODEL_ID = ${JSON.stringify(FAUX_BASELINE_MODEL_ID)};`,
    `const MODEL_ID = ${JSON.stringify(FAUX_MODEL_ID)};`,
    `const API_ID = ${JSON.stringify(FAUX_API_ID)};`,
    `const COMPLETED_PROMPT = ${JSON.stringify(COMPLETED_PROMPT_TEXT)};`,
    `const COMPLETED_RESPONSE = ${JSON.stringify(COMPLETED_RESPONSE_TEXT)};`,
    `const PACED_PROMPT = ${JSON.stringify(PACED_PROMPT_TEXT)};`,
    `const PACED_RESPONSE = ${JSON.stringify(PACED_RESPONSE_TEXT)};`,
    `const CANARY_PROMPT = ${JSON.stringify(CANARY_PROMPT_TEXT)};`,
    `const CANARY_RESPONSE = ${JSON.stringify(CANARY_RESPONSE_TEXT)};`,
    `const BASELINE_MODEL = Object.freeze(${JSON.stringify(baselineModelDefinition)});`,
    `const MODEL = Object.freeze(${JSON.stringify(modelDefinition)});`,
    "const promptIdentity = (text) => createHash(\"sha256\").update(text, \"utf8\").digest(\"hex\");",
    "const boundedIdentityPart = (value) => typeof value === \"string\" && value.length <= 256 && !/[\\0\\r\\n]/u.test(value)",
    "  ? value",
    "  : `invalid-${promptIdentity(typeof value === \"string\" ? value.slice(0, 4096) : `<${typeof value}>`)}`;",
    "const boundedPromptIdentity = (value) => promptIdentity(",
    "  typeof value === \"string\" ? value.slice(0, 4096) : `<${typeof value}>`,",
    ");",
    "const displayedUserText = (context) => {",
    "  const messages = Array.isArray(context?.messages) ? context.messages : [];",
    "  const message = [...messages].reverse().find((candidate) => candidate?.role === \"user\");",
    "  if (!message) return undefined;",
    "  if (typeof message.content === \"string\") return message.content.slice(0, 4097);",
    "  if (!Array.isArray(message.content)) return undefined;",
    "  const parts = [];",
    "  let capturedCharacters = 0;",
    "  for (const item of message.content) {",
    "    if (item?.type !== \"text\" || typeof item.text !== \"string\") continue;",
    "    const separator = parts.length > 0 ? \"\\n\\n\" : \"\";",
    "    const addition = `${separator}${item.text}`.slice(0, Math.max(0, 4097 - capturedCharacters));",
    "    parts.push(addition);",
    "    capturedCharacters += addition.length;",
    "    if (capturedCharacters >= 4097) break;",
    "  }",
    "  return parts.join(\"\");",
    "};",
    "const emittedTextCharacters = (message) => Array.isArray(message?.content)",
    "  ? message.content.reduce((total, item) => total + (item?.type === \"text\" ? item.text.length : 0), 0)",
    "  : 0;",
    "const appendDurableRecord = (record) => {",
    "  const bytes = Buffer.from(`${JSON.stringify(record)}\\n`, \"utf8\");",
    "  let existingBytes = 0;",
    "  try { existingBytes = statSync(LEDGER_PATH).size; } catch (error) { if (error?.code !== \"ENOENT\") throw error; }",
    "  if (bytes.byteLength > 2048 || existingBytes + bytes.byteLength > MAX_LEDGER_BYTES) {",
    '    throw new Error("Continuim smoke provider ledger exceeded its bound");',
    "  }",
    '  const descriptor = openSync(LEDGER_PATH, "a", 0o600);',
    "  try {",
    "    let offset = 0;",
    "    while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);",
    "    fsyncSync(descriptor);",
    "  } finally {",
    "    closeSync(descriptor);",
    "  }",
    "};",
    "const captureFauxStream = (tokensPerSecond) => {",
    "  const registration = registerFauxProvider({",
    "    api: API_ID,",
    "    provider: PROVIDER_ID,",
    "    models: [MODEL],",
    "    ...(tokensPerSecond ? { tokensPerSecond } : {}),",
    "    tokenSize: { min: 1, max: 1 },",
    "  });",
    "  const streamSimple = getApiProvider(API_ID)?.streamSimple;",
    '  if (!streamSimple) throw new Error("Continuim smoke faux stream registration failed");',
    "  return Object.freeze({ registration, streamSimple });",
    "};",
    "const completed = captureFauxStream(undefined);",
    "const paced = captureFauxStream(1);",
    "let invocationCount = 0;",
    "export default function registerContinuimSmokeProvider(pi) {",
    "  pi.registerProvider(PROVIDER_ID, {",
    '    name: "Continuim deterministic smoke provider",',
    '    baseUrl: "http://127.0.0.1:1/continuim-smoke-never-used",',
    '    apiKey: "continuim-fixed-non-secret-sentinel",',
    "    api: API_ID,",
    "    authHeader: false,",
    "    models: [BASELINE_MODEL, MODEL],",
    "    streamSimple(model, context, options) {",
    "      invocationCount += 1;",
    "      const ordinal = invocationCount;",
    "      const prompt = displayedUserText(context);",
    "      const promptId = boundedPromptIdentity(prompt);",
    "      appendDurableRecord({",
    "        version: 1, type: \"call\", ordinal, promptIdentity: promptId, apiId: boundedIdentityPart(model?.api),",
    "        providerId: boundedIdentityPart(model?.provider), modelId: boundedIdentityPart(model?.id),",
    "        signalPresent: typeof AbortSignal !== \"undefined\" && options?.signal instanceof AbortSignal,",
    "      });",
    "      const expectedPrompt = ordinal === 1",
    "        ? COMPLETED_PROMPT",
    "        : ordinal === 2",
    "          ? PACED_PROMPT",
    "          : ordinal === 3",
    "            ? CANARY_PROMPT",
    "            : undefined;",
    "      if (model?.api !== API_ID || model?.provider !== PROVIDER_ID || model?.id !== MODEL_ID || prompt !== expectedPrompt) {",
    '        throw new Error("Continuim smoke provider received an unexpected invocation");',
    "      }",
    "      const selected = ordinal === 1 ? completed : paced;",
    "      const response = ordinal === 1 ? COMPLETED_RESPONSE : ordinal === 2 ? PACED_RESPONSE : CANARY_RESPONSE;",
    "      selected.registration.setResponses([fauxAssistantMessage(response)]);",
    "      const stream = selected.streamSimple(model, context, options);",
    "      // result() observes completion without iterating or consuming the stream delivered to Prime.",
    "      void stream.result().then((message) => appendDurableRecord({",
    "        version: 1, type: \"result\", ordinal, promptIdentity: promptId, apiId: model.api,",
    "        providerId: model.provider, modelId: model.id, signalAborted: options?.signal?.aborted === true,",
    "        emittedChars: emittedTextCharacters(message), stopReason: message.stopReason,",
    "      })).catch(() => appendDurableRecord({ version: 1, type: \"failure\", ordinal }));",
    "      return stream;",
    "    },",
    "  });",
    "}",
    "",
  ].join("\n");
}

function daemonAuditSource() {
  return [
    'import { createHash } from "node:crypto";',
    'import { readdir, readFile, stat } from "node:fs/promises";',
    'import { createConnection } from "node:net";',
    'import { join, resolve } from "node:path";',
    "const [moduleUrl, socketPath, action, agentDir, expectedIdentitiesJson] = process.argv.slice(2);",
    'if (!moduleUrl || !socketPath || !agentDir || (action !== "list" && action !== "shutdown")) throw new Error("missing daemon audit argument");',
    `const MAX_PROCESS_IDENTITIES = ${MAX_DAEMON_PROCESS_IDENTITIES};`,
    "const MAX_AUDIT_FILE_BYTES = 32 * 1024;",
    "const { DaemonClient } = await import(moduleUrl);",
    'const { defaultDaemonSocketDir } = await import(new URL("./daemon-socket.js", moduleUrl));',
    'const { getProcessStartId } = await import(new URL("../../core/session-lease.js", moduleUrl));',
    "const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));",
    "const normalizeSocketPath = (value) => process.platform === \"win32\" ? value.toLowerCase() : resolve(value);",
    "const normalizeFilesystemPath = (value) => {",
    "  const normalized = resolve(value);",
    "  return process.platform === \"win32\" ? normalized.toLowerCase() : normalized;",
    "};",
    "const descriptorKey = createHash(\"sha256\").update(socketPath).digest(\"hex\").slice(0, 12);",
    "const expectedDescriptorDir = join(agentDir, \"daemon-workers\", descriptorKey);",
    "const registryDir = process.env.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR",
    "  ?? resolve(defaultDaemonSocketDir(), \"supervisor-owners\");",
    "const readBoundedJson = async (path) => {",
    "  const metadata = await stat(path);",
    '  if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_AUDIT_FILE_BYTES) throw new Error("daemon audit file exceeded its bound");',
    "  return JSON.parse(await readFile(path, \"utf8\"));",
    "};",
    "const readDirectory = async (path) => {",
    "  try { return await readdir(path, { withFileTypes: true }); }",
    "  catch (error) { if (error?.code === \"ENOENT\") return []; throw error; }",
    "};",
    "const readMatchingOwners = async () => {",
    "  const entries = await readDirectory(registryDir);",
    '  if (entries.length > 128) throw new Error("daemon owner registry exceeded its audit bound");',
    "  const owners = [];",
    "  for (const entry of entries) {",
    "    if (!entry.isDirectory() || !entry.name.endsWith(\".owner\")) continue;",
    "    let owner;",
    "    try { owner = await readBoundedJson(join(registryDir, entry.name, \"owner.json\")); }",
    "    catch (error) { if (error?.code !== \"ENOENT\") throw error; }",
    "    let scope;",
    "    try { scope = await readBoundedJson(join(registryDir, entry.name, \"scope.json\")); }",
    "    catch (error) { if (error?.code !== \"ENOENT\") throw error; }",
    "    const ownerMatches = typeof owner?.socketPath === \"string\" && normalizeSocketPath(owner.socketPath) === normalizeSocketPath(socketPath);",
    "    const scopeMatches = typeof scope?.socketPath === \"string\" && normalizeSocketPath(scope.socketPath) === normalizeSocketPath(socketPath);",
    "    if (!ownerMatches && !scopeMatches) continue;",
    "    if (",
    "      !ownerMatches || !scopeMatches || scope.version !== 1 || scope.role !== \"supervisor\" ||",
    "      typeof scope.token !== \"string\" || scope.token !== owner?.token ||",
    "      typeof scope.generation !== \"string\" || scope.generation !== owner?.generation ||",
    "      typeof scope.descriptorDir !== \"string\" ||",
    "      owner.version !== 1 || owner.role !== \"supervisor\" ||",
    "      typeof owner.token !== \"string\" || owner.token.length < 1 ||",
    "      typeof owner.generation !== \"string\" || owner.generation.length < 1 ||",
    "      ![\"starting\", \"owner\", \"stopping\"].includes(owner.phase) ||",
    "      !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||",
    "      typeof owner.processStartId !== \"string\" || owner.processStartId.length < 1 || owner.processStartId.length > 512 ||",
    "      typeof owner.descriptorDir !== \"string\" || typeof owner.agentDir !== \"string\" ||",
    "      normalizeFilesystemPath(scope.descriptorDir) !== normalizeFilesystemPath(owner.descriptorDir) ||",
    "      normalizeFilesystemPath(owner.agentDir) !== normalizeFilesystemPath(agentDir) ||",
    "      normalizeFilesystemPath(owner.descriptorDir) !== normalizeFilesystemPath(expectedDescriptorDir)",
    "    ) throw new Error(\"resident daemon owner record changed exact scope or process identity\");",
    "    owners.push(owner);",
    "  }",
    "  if (owners.length > 1) throw new Error(\"multiple resident daemon owners matched one endpoint\");",
    "  return owners;",
    "};",
    "const readWorkerIdentities = async (owner) => {",
    "  const entries = await readDirectory(owner.descriptorDir);",
    '  if (entries.length > 128) throw new Error("resident daemon worker descriptor directory exceeded its audit bound");',
    "  const identities = [];",
    "  for (const entry of entries) {",
    "    if (!entry.isFile() || !entry.name.endsWith(\".json\")) continue;",
    "    const descriptor = await readBoundedJson(join(owner.descriptorDir, entry.name));",
    "    if (descriptor?.supervisorSocketPath === undefined) continue;",
    "    if (",
    "      descriptor.version !== 1 ||",
    "      typeof descriptor.supervisorSocketPath !== \"string\" ||",
    "      normalizeSocketPath(descriptor.supervisorSocketPath) !== normalizeSocketPath(socketPath) ||",
    "      !Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1 ||",
    "      typeof descriptor.processStartId !== \"string\" || descriptor.processStartId.length < 1 ||",
    "      getProcessStartId(descriptor.pid) !== descriptor.processStartId",
    "    ) throw new Error(\"resident daemon worker descriptor changed exact process identity\");",
    "    identities.push({ role: \"worker\", pid: descriptor.pid, processStartId: descriptor.processStartId });",
    "  }",
    "  return identities;",
    "};",
    "const captureProcessIdentities = async () => {",
    "  const owners = await readMatchingOwners();",
    '  if (owners.length !== 1) throw new Error("resident daemon did not retain one exact supervisor owner");',
    "  const owner = owners[0];",
    "  if (getProcessStartId(owner.pid) !== owner.processStartId) throw new Error(\"resident daemon supervisor process identity is not live\");",
    "  const identities = [",
    "    { role: \"supervisor\", pid: owner.pid, processStartId: owner.processStartId },",
    "    ...await readWorkerIdentities(owner),",
    "  ];",
    '  if (identities.length > MAX_PROCESS_IDENTITIES) throw new Error("resident daemon process identity count exceeded its bound");',
    "  const keys = new Set(identities.map((identity) => `${identity.pid}:${identity.processStartId}`));",
    '  if (keys.size !== identities.length) throw new Error("resident daemon process identities were not unique");',
    "  return identities.sort((left, right) => left.role.localeCompare(right.role) || left.pid - right.pid || left.processStartId.localeCompare(right.processStartId));",
    "};",
    "const parseExpectedProcessIdentities = () => {",
    "  const identities = JSON.parse(expectedIdentitiesJson ?? \"[]\");",
    '  if (!Array.isArray(identities) || identities.length > MAX_PROCESS_IDENTITIES) throw new Error("expected daemon process identities changed their bound");',
    "  const keys = new Set();",
    "  for (const identity of identities) {",
    "    const identityKeys = Object.keys(identity ?? {}).sort();",
    "    const key = `${identity?.pid}:${identity?.processStartId}`;",
    "    if (",
    "      JSON.stringify(identityKeys) !== JSON.stringify([\"pid\", \"processStartId\", \"role\"]) ||",
    "      ![\"supervisor\", \"worker\"].includes(identity.role) ||",
    "      !Number.isSafeInteger(identity.pid) || identity.pid < 1 ||",
    "      typeof identity.processStartId !== \"string\" || identity.processStartId.length < 1 ||",
    "      keys.has(key)",
    '    ) throw new Error("expected daemon process identity changed its exact schema");',
    "    keys.add(key);",
    "  }",
    "  return identities;",
    "};",
    "const mergeProcessIdentities = (left, right) => {",
    "  const merged = new Map();",
    "  for (const identity of [...left, ...right]) {",
    "    const key = `${identity.pid}:${identity.processStartId}`;",
    "    const previous = merged.get(key);",
    '    if (previous && previous.role !== identity.role) throw new Error("daemon process identity changed role");',
    "    merged.set(key, identity);",
    "  }",
    '  if (merged.size > MAX_PROCESS_IDENTITIES) throw new Error("daemon process identity union exceeded its bound");',
    "  return [...merged.values()];",
    "};",
    "const exactProcessIdentityTerminated = (identity) => {",
    "  const observedStartId = getProcessStartId(identity.pid);",
    "  if (observedStartId === identity.processStartId) return false;",
    "  if (observedStartId !== undefined) return true;",
    "  try { process.kill(identity.pid, 0); return false; }",
    "  catch (error) { return error?.code === \"ESRCH\"; }",
    "};",
    "const endpointAcceptsConnection = () => new Promise((resolveConnection) => {",
    "  const socket = createConnection(socketPath);",
    "  let settled = false;",
    "  const finish = (accepted) => {",
    "    if (settled) return;",
    "    settled = true;",
    "    clearTimeout(timer);",
    "    socket.destroy();",
    "    resolveConnection(accepted);",
    "  };",
    "  // A local connect timeout is inconclusive, so conservatively treat it as an accepting endpoint.",
    "  const timer = setTimeout(() => finish(true), 500);",
    "  socket.once(\"connect\", () => finish(true));",
    "  socket.once(\"error\", () => finish(false));",
    "});",
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
    "  const currentProcessIdentities = await captureProcessIdentities();",
    '  if (action === "shutdown") {',
    "    const expectedProcessIdentities = parseExpectedProcessIdentities();",
    "    const processIdentities = mergeProcessIdentities(expectedProcessIdentities, currentProcessIdentities);",
    '    const response = await client.request({ type: "shutdown", force: true }, 5_000);',
    '    const shutdownConfirmed = response?.type === "response" && response.command === "shutdown" && response.success === true;',
    '    if (!shutdownConfirmed) throw new Error("resident daemon did not confirm shutdown");',
    "    client.close();",
    "    client = undefined;",
    "    const deadline = Date.now() + 30_000;",
    "    let endpointTerminated = false;",
    "    let ownerRetired = false;",
    "    let terminatedProcessIdentityCount = 0;",
    "    while (Date.now() < deadline) {",
    "      endpointTerminated = !(await endpointAcceptsConnection());",
    "      ownerRetired = (await readMatchingOwners()).length === 0;",
    "      terminatedProcessIdentityCount = processIdentities.filter(",
    "        (identity) => exactProcessIdentityTerminated(identity),",
    "      ).length;",
    "      if (endpointTerminated && ownerRetired && terminatedProcessIdentityCount === processIdentities.length) break;",
    "      await delay(250);",
    "    }",
    "    if (!endpointTerminated || !ownerRetired || terminatedProcessIdentityCount !== processIdentities.length) {",
    '      throw new Error("resident daemon termination proof did not converge");',
    "    }",
    "    process.stdout.write(JSON.stringify({",
    "      auditVersion: 1, action, shutdownConfirmed, endpointTerminated, ownerRetired,",
    "      processIdentities, processIdentityCount: processIdentities.length, terminatedProcessIdentityCount,",
    "    }));",
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
    '    process.stdout.write(JSON.stringify({ auditVersion: 1, action, sessions, processIdentities: currentProcessIdentities }));',
    "  }",
    "} finally {",
    "  client?.close();",
    "}",
    "",
  ].join("\n");
}
