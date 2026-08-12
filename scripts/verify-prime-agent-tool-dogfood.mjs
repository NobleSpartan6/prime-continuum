import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { open as openFile, link, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stderr, stdout } from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  BROWSER_SURFACE,
  CHECKPOINT_ASSERTION,
  CHILD_NAME,
  CONFIRMATION_PHRASE,
  DISPOSABLE_CHECKPOINT_FLAG,
  FUNCTIONAL_EXIT_CODE,
  MIN_POST_RESTART_OBSERVATIONS,
  MODEL_ID,
  OPT_IN_FLAG,
  POST_RESTART_OBSERVATION_INTERVAL_MS,
  PRIME_AGENT_RELEASE_VERSION,
  PROOF_DIRECTORY,
  PROOF_NAME,
  PROVIDER_ID,
  RECEIPT_NAME,
  RUNTIME_MODEL_ID,
  SCREENSHOT_NAME,
  ToolDogfoodContractError,
  assertBrowserStateRetired,
  assertInteractiveAdmission,
  assertNoCredentialEnvironment,
  assertTypedConfirmation,
  createDogfoodIdentity,
  createDogfoodPage,
  createDogfoodPrompt,
  createFailureReceipt,
  createFunctionalReceipt,
  fail,
  readAndValidateProof,
  resolveDogfoodHostEndpoint,
  resolveDogfoodResidentDaemonEndpoint,
  serializeReceipt,
  sha256Json,
  validateAuthenticatedCatalog,
  validateCompletedEndLifecycleStatus,
  validateCompletedProjection,
  validateDisposableLayout,
  validateEndedControlProjection,
  validateEndedProjection,
  validateInFlightProjection,
  validateInitialProjection,
  validateLoopbackEvidence,
  validateRestartNoReplay,
  validateScreenshot,
} from "./prime-agent-tool-dogfood-lib.mjs";
import { extractEmbeddedRuntimeAttestation, parseRuntimeAttestation } from "./runtime-attestation-lib.mjs";
import { verifyMacosPackage } from "./verify-macos-package.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON_CLEANUP_HELPER = join(REPO_ROOT, "scripts", "prime-agent-tool-dogfood-daemon-cleanup.mjs");
const CANDIDATE_APP_ENV = "PRIME_CONTINUIM_TOOL_DOGFOOD_CANDIDATE_APP";
const HOST_REQUEST_TIMEOUT_MS = 5_000;
const SETUP_DEADLINE_MS = 20 * 60_000;
const OPERATOR_DEADLINE_MS = 30 * 60_000;
const BROWSER_RETIREMENT_DEADLINE_MS = 15_000;
const PROCESS_EXIT_DEADLINE_MS = 5 * 60_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 4 * 1024;
const REQUIRED_HEALTH_CAPABILITIES = Object.freeze([
  "resident_control_projection_v1",
  "runtime_integrity_v1",
  "runtime_model_catalog_v1",
]);

const runState = {
  stage: "admission",
  runId: `sol-rlm-browser-${randomUUID()}`,
  root: undefined,
  receiptPath: undefined,
  server: undefined,
  loopbackConnectionsRetired: false,
  browserStateRetired: false,
  providerMayHaveBeenUsed: false,
  receiptWritten: false,
  desktop: undefined,
  hostd: undefined,
  desktopStopped: false,
  hostdStopped: false,
  residentDaemonStopped: false,
};

let primaryFailure;

try {
  assertInteractiveAdmission({
    platform: process.platform,
    stdinIsTTY: stdin.isTTY === true,
    stdoutIsTTY: stdout.isTTY === true,
    ci: process.env.CI,
    githubActions: process.env.GITHUB_ACTIONS,
    argv: process.argv.slice(2),
    checkpointAssertion: process.env.PRIME_CONTINUIM_TOOL_DOGFOOD_DISPOSABLE_CHECKPOINT,
  });
  assertNoCredentialEnvironment(process.env);

  runState.stage = "candidate";
  stderr.write("Verifying the exact packaged macOS candidate before requesting live-provider authorization…\n");
  const candidate = await readPackagedCandidate();
  stderr.write(
    `Packaged candidate verified · Prime Agent ${candidate.attestation.runtime.releaseVersion} · ` +
    `runtime ${candidate.attestation.tree.sha256.slice(0, 12)}… · three distinct executable identities\n`,
  );

  runState.stage = "admission";
  const confirmation = createInterface({ input: stdin, output: stderr });
  let answer;
  try {
    answer = await confirmation.question(
      "This explicit dogfood run uses the configured GPT-5.6 Sol provider, provider network/quota, one native RLM child, " +
      "and the verified browser tool against a deterministic loopback page. The harness never reads credentials or starts OAuth; " +
      "you must configure the isolated account through the visible app opened by this harness. Prime Agent stores OAuth material in plaintext. " +
      "The disposable root is retained on every outcome and must be removed externally after review.\n" +
      `Type exactly: ${CONFIRMATION_PHRASE}\n> `,
    );
  } finally {
    confirmation.close();
  }
  assertTypedConfirmation(answer);

  runState.stage = "fixture";
  const layout = await validateDisposableLayout({
    root: process.env.PRIME_CONTINUIM_TOOL_DOGFOOD_ROOT,
    workspace: process.env.PRIME_CONTINUIM_TOOL_DOGFOOD_WORKSPACE,
    dataDirectory: process.env.PRIME_AGENT_DATA_DIR,
  });
  runState.root = layout.root;
  runState.receiptPath = join(layout.root, RECEIPT_NAME);
  const workspaceCheckpoint = await validateDetachedWorkspace(layout.workspace);
  const identity = createDogfoodIdentity(runState.runId, randomBytes(24).toString("hex"));
  const proofDirectory = join(layout.workspace, PROOF_DIRECTORY);
  const proofPath = join(proofDirectory, PROOF_NAME);
  const screenshotPath = join(proofDirectory, SCREENSHOT_NAME);
  await mkdir(proofDirectory, { mode: 0o700 });

  const endpoint = resolveDogfoodHostEndpoint({ platform: process.platform, dataDirectory: layout.dataDirectory });
  const residentEndpoint = resolveDogfoodResidentDaemonEndpoint({
    platform: process.platform,
    dataDirectory: layout.dataDirectory,
    physicalTemporaryDirectory: await realpath(tmpdir()),
  });
  const userDataDirectory = join(layout.root, "electron-user-data");
  const hostdWrapperPath = join(layout.root, "owned-hostd-wrapper.cjs");
  await mkdir(userDataDirectory, { mode: 0o700 });
  await writeFile(hostdWrapperPath, hostdOwnedWrapperSource(), { encoding: "utf8", mode: 0o600, flag: "wx" });

  runState.stage = "host";
  let hostd = await startOwnedHostd(candidate, hostdWrapperPath, endpoint, layout.dataDirectory);
  runState.hostd = hostd;
  const zeroBindingHealth = await waitForHostHealth(endpoint, candidate.attestation, false, hostd);
  let desktop = await startOwnedDesktop(candidate, userDataDirectory, layout.dataDirectory);
  runState.desktop = desktop;
  stderr.write(
    `\nThe isolated Prime Continuim app is open. In the app:\n` +
    `1. Choose New resident thread and select this disposable workspace: ${layout.workspace}\n` +
    `2. Open Models & accounts. If needed, choose Connect ChatGPT and finish sign-in in the system browser.\n` +
    `3. Select exact ${RUNTIME_MODEL_ID} and wait until Browser reads Ready.\n` +
    `The harness does not inspect the login window or credential store. Waiting for exact read-only projections…\n`,
  );

  runState.stage = "precondition";
  const prepared = await waitForPreparedResident(endpoint, zeroBindingHealth.host.hostId, candidate.attestation, identity);
  const { threadId, initial } = prepared;

  const loopback = await startLoopbackFixture(identity);
  runState.server = loopback;
  const prompt = createDogfoodPrompt({ identity, pageUrl: loopback.pageUrl });
  runState.providerMayHaveBeenUsed = true;
  runState.stage = "operator";
  stderr.write(
    "\nThe isolated host, exact Sol model, native resident, verified browser readiness, and OAuth-backed catalog are proven.\n" +
    "Paste the task below into this resident's visible composer and choose Delegate task. Do not edit it.\n\n" +
    `${prompt}\n\nWaiting for the required live root/child observation before completion…\n`,
  );

  runState.stage = "in_flight";
  const inFlightSnapshot = await waitForInFlightProjection(endpoint, threadId, initial, identity);
  const inFlight = validateInFlightProjection(inFlightSnapshot, { initial, identity });
  stderr.write(
    `Observed the live root turn and active ${CHILD_NAME} child (${inFlight.child.state}); waiting for exact completion evidence…\n`,
  );

  const completedSnapshot = await waitForCompletedProjection(endpoint, threadId, initial, identity, inFlight);
  runState.stage = "projection";
  const projection = validateCompletedProjection(completedSnapshot, { initial, identity, inFlight });

  runState.stage = "browser";
  const loopbackEvidence = validateLoopbackEvidence(loopback.events, identity);
  const proof = await readAndValidateProof(proofPath, identity);
  const screenshot = await validateScreenshot(screenshotPath);
  await waitForLoopbackRetirement(loopback, BROWSER_RETIREMENT_DEADLINE_MS);
  runState.loopbackConnectionsRetired = true;
  await loopback.close();
  runState.server = undefined;

  runState.stage = "restart";
  const browserState = await assertBrowserStateRetired(join(layout.dataDirectory, "resident-daemon", "browser"));
  runState.browserStateRetired = true;
  const replayBefore = await inspectReplayState(layout.dataDirectory, userDataDirectory, threadId);
  const hostProcessBefore = exactHarnessProcessIdentity(hostd);
  const desktopProcessBefore = exactHarnessProcessIdentity(desktop);
  stderr.write(
    "Browser state retired. Quit the isolated Prime Continuim app now (Cmd+Q); the harness will restart the exact " +
    "packaged desktop and host, then watch the completed resident remain idle without replay.\n",
  );
  await waitForCleanChildExit(desktop, PROCESS_EXIT_DEADLINE_MS, "restart", "RESTART_NOT_PROVEN");
  runState.desktopStopped = true;
  runState.desktop = undefined;
  await stopOwnedHostd(hostd);
  runState.hostdStopped = true;
  runState.hostd = undefined;

  hostd = await startOwnedHostd(candidate, hostdWrapperPath, endpoint, layout.dataDirectory);
  runState.hostd = hostd;
  runState.hostdStopped = false;
  const restartedHealth = await waitForHostHealth(endpoint, candidate.attestation, true, hostd);
  if (restartedHealth.host.hostId !== projection.authority.hostId) fail("restart", "RESTART_NOT_PROVEN");
  desktop = await startOwnedDesktop(candidate, userDataDirectory, layout.dataDirectory);
  runState.desktop = desktop;
  runState.desktopStopped = false;
  const observations = await observeStableRestart(endpoint, threadId, initial, identity, inFlight);
  runState.stage = "no_replay";
  const replayAfter = await inspectReplayState(layout.dataDirectory, userDataDirectory, threadId);
  const restartProof = validateRestartNoReplay({
    initial,
    identity,
    inFlight,
    beforeRestart: completedSnapshot,
    observations,
    hostProcessBefore,
    hostProcessAfter: exactHarnessProcessIdentity(hostd),
    desktopProcessBefore,
    desktopProcessAfter: exactHarnessProcessIdentity(desktop),
    journalIdsBefore: replayBefore.journalIds,
    journalIdsAfter: replayAfter.journalIds,
    dispatchAttemptCountBefore: replayBefore.dispatchAttemptCount,
    dispatchAttemptCountAfter: replayAfter.dispatchAttemptCount,
    outboxEntryCountBefore: replayBefore.outboxEntryCount,
    outboxEntryCountAfter: replayAfter.outboxEntryCount,
  });

  runState.stage = "cleanup";
  stderr.write(
    "Restart and no-replay proof passed. In the reopened app, open Session, choose End resident session…, and confirm End session. " +
    "Do not quit the app yet. Waiting for exact terminal lifecycle evidence…\n",
  );
  const ended = await waitForEndedResident(
    endpoint,
    threadId,
    completedSnapshot,
    projection.authority,
    candidate.attestation,
  );
  stderr.write("Resident session ended and its durable lifecycle is complete. Quit the isolated Prime Continuim app now (Cmd+Q).\n");
  await waitForCleanChildExit(desktop, PROCESS_EXIT_DEADLINE_MS, "cleanup", "CLEANUP_UNCONFIRMED");
  runState.desktopStopped = true;
  runState.desktop = undefined;
  await stopOwnedHostd(hostd);
  runState.hostdStopped = true;
  runState.hostd = undefined;
  const daemonRetirement = await stopOwnedResidentDaemon(
    candidate,
    residentEndpoint,
    layout.dataDirectory,
  );
  runState.residentDaemonStopped = true;
  await assertBrowserStateRetired(join(layout.dataDirectory, "resident-daemon", "browser"));

  runState.stage = "receipt";
  const receipt = createFunctionalReceipt({
    platform: process.platform,
    arch: process.arch,
    runId: runState.runId,
    candidate: {
      artifact: "macos-directory-package",
      runtime: "prime-agent",
      releaseVersion: candidate.attestation.runtime.releaseVersion,
      runtimeTreeSha256: candidate.attestation.tree.sha256,
      attestationSha256: candidate.sha256,
      appAsarSha256: candidate.evidence.appAsarSha256,
      desktopExecutableSha256: candidate.evidence.desktopExecutableSha256,
      hostExecutableSha256: candidate.evidence.hostExecutableSha256,
      browserExecutableSha256: candidate.evidence.browserExecutableSha256,
      hostdSha256: candidate.evidence.hostdSha256,
    },
    workspaceCheckpoint,
    authority: projection.authority,
    proof: {
      runtimeModel: RUNTIME_MODEL_ID,
      inFlightObserved: true,
      inFlightProjectionSha256: inFlight.projectionSha256,
      inFlightRootActivity: inFlight.rootActivity,
      inFlightChildState: inFlight.child.state,
      inFlightSequence: inFlight.sequence,
      childName: CHILD_NAME,
      childAgentId: projection.child.agentId,
      childReplied: projection.child.repliedSinceTask,
      goalId: projection.goal.goalId,
      goalState: projection.goal.state,
      browserSurface: BROWSER_SURFACE,
      browserOperations: ["open", "snapshot", "fill", "click", "eval", "screenshot", "close"],
      stableReferenceCount: new Set([proof.browser.inputRef, proof.browser.buttonRef]).size,
      loopbackEventCount: loopbackEvidence.count,
      transcriptSha256: projection.transcriptSha256,
      screenshotSha256: screenshot.sha256,
      screenshotBytes: screenshot.byteLength,
      browserStateEntriesInspected: browserState.inspectedEntries,
      completionProjectionSha256: sha256Json(completedSnapshot),
      hostdRestarted: restartProof.hostdRestarted,
      desktopRestarted: restartProof.desktopRestarted,
      sameResidentReattached: restartProof.sameResidentReattached,
      exactProjectionStable: restartProof.exactProjectionStable,
      exactJournalIdsUnchanged: restartProof.exactJournalIdsUnchanged,
      residentDispatchAttemptsEmpty: restartProof.residentDispatchAttemptsEmpty,
      desktopOutboxEmpty: restartProof.desktopOutboxEmpty,
      postRestartObservationCount: restartProof.postRestartObservationCount,
      minimumPostRestartObservationSeparationMs: restartProof.minimumPostRestartObservationSeparationMs,
      residentEndProjectionSha256: ended.projectionSha256,
      residentEndLifecycleCompleted: true,
      residentDaemonSessionsAfterEnd: daemonRetirement.sessionsAfterEnd,
      residentDaemonShutdownConfirmed: daemonRetirement.shutdownConfirmed,
      residentDaemonEndpointRetired: daemonRetirement.endpointRetired,
      residentDaemonOwnerRetired: daemonRetirement.ownerRetired,
      residentDaemonIdentityCount: daemonRetirement.identityCount,
      residentDaemonTerminatedIdentityCount: daemonRetirement.terminatedIdentityCount,
      residentDaemonProcessGroupCount: daemonRetirement.processGroupCount,
      residentDaemonRetiredProcessGroupCount: daemonRetirement.retiredProcessGroupCount,
    },
    ownedProcesses: { desktopStopped: true, hostdStopped: true, residentDaemonStopped: true },
  });
  await writeReceiptNoReplace(runState.receiptPath, receipt);
  runState.receiptWritten = true;
  stderr.write(
    "Functional Sol/RLM/browser dogfood proof passed. The receipt intentionally records external disposal as pending. " +
    "Review the disposable worktree and receipt, then remove the complete disposable root.\n",
  );
  process.exitCode = FUNCTIONAL_EXIT_CODE;
} catch (error) {
  primaryFailure = error;
  process.exitCode = 1;
} finally {
  if (runState.server) {
    try {
      await waitForLoopbackRetirement(runState.server, 1_000);
      runState.loopbackConnectionsRetired = true;
    } catch {
      // A live or uncertain browser connection is material failure evidence.
    }
    await runState.server.close(true).catch(() => undefined);
    runState.server = undefined;
  }
  if (primaryFailure && runState.desktop) {
    if (runState.desktop.exitCode === null && runState.desktop.signalCode === null) {
      runState.desktop.kill("SIGTERM");
    }
    try {
      await waitForChildRetirement(runState.desktop, 10_000);
      runState.desktopStopped = true;
      runState.desktop = undefined;
    } catch {
      // Retain the host and fixture when desktop retirement is uncertain.
    }
  }
  if (primaryFailure && runState.hostd && (runState.desktopStopped || !runState.desktop)) {
    if (runState.hostd.exitCode !== null || runState.hostd.signalCode !== null) {
      runState.hostdStopped = true;
      runState.hostd = undefined;
    } else {
      try {
        await stopOwnedHostd(runState.hostd);
        runState.hostdStopped = true;
        runState.hostd = undefined;
      } catch {
        // Retain the exact host process and fixture for external cleanup.
      }
    }
  }
  if (primaryFailure && runState.receiptPath && !runState.receiptWritten) {
    const failure = primaryFailure instanceof ToolDogfoodContractError
      ? primaryFailure
      : new ToolDogfoodContractError(runState.stage, "INTERNAL_FAILURE");
    try {
      const receipt = createFailureReceipt({
        platform: process.platform,
        arch: process.arch,
        runId: runState.runId,
        stage: failure.stage,
        code: failure.code,
        browserStateRetired: runState.browserStateRetired,
        loopbackConnectionsRetired: runState.loopbackConnectionsRetired,
        providerMayHaveBeenUsed: runState.providerMayHaveBeenUsed,
        desktopStopped: runState.desktopStopped,
        hostdStopped: runState.hostdStopped,
        residentDaemonStopped: runState.residentDaemonStopped,
      });
      await writeReceiptNoReplace(runState.receiptPath, receipt);
      runState.receiptWritten = true;
    } catch {
      // Never replace an existing receipt or claim evidence publication after uncertainty.
    }
    stderr.write(
      `Dogfood failed closed at ${failure.stage}:${failure.code}. The disposable root was retained; inspect it and dispose of it externally.\n`,
    );
  }
}

async function startOwnedHostd(candidate, wrapperPath, endpoint, dataDirectory) {
  const child = spawn(candidate.hostExecutable, [
    wrapperPath,
    candidate.hostdPath,
    "serve",
    "--socket",
    endpoint,
    "--data-dir",
    dataDirectory,
    "--runtime-seed",
    candidate.runtimeSeedRoot,
    "--browser-executable",
    candidate.browserExecutable,
  ], {
    cwd: candidate.packageDirectory,
    detached: false,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "ignore", "pipe"],
    env: ownedHostEnvironment(process.env, dataDirectory),
  });
  child.dogfoodProcessIdentity = `hostd:${randomUUID()}`;
  runState.hostd = child;
  child.stderrTail = Buffer.alloc(0);
  child.stderr?.on("data", (chunk) => {
    child.stderrTail = Buffer.concat([child.stderrTail, Buffer.from(chunk)]).subarray(-64 * 1024);
  });
  child.stderr?.on("error", () => undefined);
  child.once("error", () => undefined);
  try { await waitForSpawn(child, "host", "HOST_UNAVAILABLE"); }
  catch (error) { runState.hostd = undefined; throw error; }
  if (!child.stdin?.writable) fail("host", "HOST_UNAVAILABLE");
  return child;
}

async function startOwnedDesktop(candidate, userDataDirectory, dataDirectory) {
  const environment = ownedDesktopEnvironment(process.env, dataDirectory);
  const child = spawn(candidate.desktopExecutable, [`--user-data-dir=${userDataDirectory}`, "--disable-gpu"], {
    cwd: candidate.packageDirectory,
    detached: false,
    shell: false,
    windowsHide: false,
    stdio: ["ignore", "ignore", "ignore"],
    env: environment,
  });
  child.dogfoodProcessIdentity = `desktop:${randomUUID()}`;
  runState.desktop = child;
  child.once("error", () => undefined);
  try { await waitForSpawn(child, "host", "HOST_UNAVAILABLE"); }
  catch (error) { runState.desktop = undefined; throw error; }
  return child;
}

function exactHarnessProcessIdentity(child) {
  const identity = child?.dogfoodProcessIdentity;
  if (
    !identity || typeof identity !== "string" ||
    !/^(?:hostd|desktop):[a-f0-9-]{36}$/u.test(identity) ||
    !Number.isSafeInteger(child.pid) || child.pid < 1 ||
    child.exitCode !== null || child.signalCode !== null
  ) fail("restart", "RESTART_NOT_PROVEN");
  return identity;
}

function ownedHostEnvironment(environment, dataDirectory) {
  const result = baseOwnedEnvironment(environment);
  result.PRIME_AGENT_DATA_DIR = dataDirectory;
  return result;
}

function ownedDesktopEnvironment(environment, dataDirectory) {
  const result = baseOwnedEnvironment(environment);
  result.PRIME_AGENT_DATA_DIR = dataDirectory;
  return result;
}

function baseOwnedEnvironment(environment) {
  const result = {};
  const allowed = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "DISPLAY",
    "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME", "__CF_USER_TEXT_ENCODING", "SystemRoot", "WINDIR", "SystemDrive", "USERPROFILE",
    "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH", "COMSPEC", "PATHEXT", "OS",
    "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "ProgramData", "ALLUSERSPROFILE", "PUBLIC",
    "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles", "CommonProgramFiles(x86)",
  ]);
  for (const [name, value] of Object.entries(environment)) {
    if (
      typeof value === "string" && value.length > 0 && value.length <= 32_767 && !/[\0\r\n]/u.test(value) &&
      (allowed.has(name) || name.startsWith("LC_"))
    ) result[name] = value;
  }
  return result;
}

async function waitForSpawn(child, stage, code) {
  if (child.pid) return;
  await new Promise((resolvePromise, rejectPromise) => {
    child.once("spawn", resolvePromise);
    child.once("error", rejectPromise);
  }).catch(() => fail(stage, code));
}

function assertOwnedAlive(child, stage, code) {
  if (!child || child.exitCode !== null || child.signalCode !== null) fail(stage, code);
}

async function waitForHostHealth(endpoint, attestation, requireCommands, child) {
  const deadline = Date.now() + SETUP_DEADLINE_MS;
  while (Date.now() < deadline) {
    assertOwnedAlive(child, "host", "HOST_UNAVAILABLE");
    try {
      const health = (await requestHost(endpoint, "health.get", {}, HOST_REQUEST_TIMEOUT_MS)).result;
      validateHostHealth(health, attestation, requireCommands);
      return health;
    } catch (error) {
      if (!(error instanceof ToolDogfoodContractError) || !["HOST_UNAVAILABLE"].includes(error.code)) throw error;
    }
    await delay(250);
  }
  fail("host", "HOST_UNAVAILABLE");
}

async function waitForPreparedResident(endpoint, hostId, attestation, identity) {
  const deadline = Date.now() + SETUP_DEADLINE_MS;
  while (Date.now() < deadline) {
    assertOwnedAlive(runState.hostd, "host", "HOST_UNAVAILABLE");
    assertOwnedAlive(runState.desktop, "host", "HOST_UNAVAILABLE");
    try {
      const health = (await requestHost(endpoint, "health.get", {}, HOST_REQUEST_TIMEOUT_MS)).result;
      validateHostHealth(health, attestation, true);
      if (health.host.hostId !== hostId) fail("precondition", "PRECONDITION_NOT_PROVEN");
      const catalog = (await requestHost(endpoint, "catalog.snapshot", {}, HOST_REQUEST_TIMEOUT_MS)).result;
      const threadId = exactSingleResidentThread(catalog, hostId);
      const snapshot = (await requestHost(endpoint, "thread.snapshot", { threadId }, HOST_REQUEST_TIMEOUT_MS)).result;
      const initial = validateInitialProjection(snapshot, identity);
      const models = (await requestHost(
        endpoint,
        "runtime.model_catalog",
        { expectedHostId: hostId },
        HOST_REQUEST_TIMEOUT_MS,
      )).result;
      validateAuthenticatedCatalog(models);
      return Object.freeze({ threadId, initial });
    } catch (error) {
      if (
        !(error instanceof ToolDogfoodContractError) ||
        !["HOST_UNAVAILABLE", "PRECONDITION_NOT_PROVEN", "PROJECTION_NOT_PROVEN"].includes(error.code)
      ) throw error;
    }
    await delay(500);
  }
  fail("precondition", "PRECONDITION_NOT_PROVEN");
}

async function waitForCleanChildExit(child, timeoutMs, stage, code) {
  const outcome = await waitForChildRetirement(child, timeoutMs).catch(() => fail(stage, code));
  if (outcome.code !== 0 || outcome.signal !== null) fail(stage, code);
  return outcome;
}

async function waitForChildRetirement(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Object.freeze({ code: child.exitCode, signal: child.signalCode });
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const onExit = (code, signal) => finish(undefined, Object.freeze({ code, signal }));
    const onError = () => finish(new Error("owned process failed"));
    const timer = setTimeout(() => finish(new Error("owned process did not retire")), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopOwnedHostd(child) {
  if (child.exitCode !== null || child.signalCode !== null) fail("cleanup", "CLEANUP_UNCONFIRMED");
  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) fail("cleanup", "CLEANUP_UNCONFIRMED");
  child.stdin.once("error", () => undefined);
  child.stdin.end("shutdown\n");
  await waitForCleanChildExit(child, 60_000, "cleanup", "CLEANUP_UNCONFIRMED");
}

function hostdOwnedWrapperSource() {
  return [
    '"use strict";',
    "const [hostdPath, ...hostdArguments] = process.argv.slice(2);",
    'if (!hostdPath) throw new Error("missing hostd path");',
    "const hostd = require(hostdPath);",
    'process.stdin.setEncoding("utf8");',
    "let terminal = false;",
    'const terminate = () => { if (terminal) return; terminal = true; process.emit("SIGTERM"); };',
    'process.stdin.once("data", terminate);',
    'process.stdin.once("end", terminate);',
    'process.stdin.once("close", terminate);',
    "process.stdin.resume();",
    "void Promise.resolve(hostd.runHostdCli(hostdArguments)).then(",
    "  (code) => { terminal = true; process.exitCode = code; process.stdin.destroy(); },",
    "  () => { terminal = true; process.exitCode = 1; process.stdin.destroy(); },",
    ");",
    "",
  ].join("\n");
}

async function stopOwnedResidentDaemon(candidate, socketPath, dataDirectory) {
  const daemonClientPath = await exactPackagedRuntimeFile(candidate.runtimeSeedRoot, [
    "node_modules", "prime-agent", "dist", "modes", "daemon", "daemon-client.js",
  ]);
  const helperPath = await realpath(DAEMON_CLEANUP_HELPER).catch(() => fail("candidate", "CANDIDATE_INVALID"));
  if (helperPath !== DAEMON_CLEANUP_HELPER) fail("candidate", "CANDIDATE_INVALID");
  const agentDirectory = join(dataDirectory, "prime-agent");
  const expectedIdentity = JSON.stringify({
    protocolName: candidate.attestation.daemon.protocolName,
    protocolVersion: candidate.attestation.daemon.protocolVersion,
    schemaRevision: candidate.attestation.daemon.schemaRevision,
    schemaId: candidate.attestation.daemon.schemaId,
    appVersion: candidate.attestation.runtime.releaseVersion,
    runtimeBuildId: candidate.attestation.runtime.runtimeBuildId,
  });
  const environment = ownedHostEnvironment(process.env, dataDirectory);
  environment.PRIME_AGENT_CODING_AGENT_DIR = agentDirectory;
  const result = await new Promise((resolvePromise, rejectPromise) => {
    execFile(candidate.hostExecutable, [helperPath, daemonClientPath, socketPath, agentDirectory, expectedIdentity], {
      cwd: candidate.packageDirectory,
      encoding: "utf8",
      timeout: 45_000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
      env: environment,
    }, (error, stdoutValue, stderrValue) => {
      if (error) rejectPromise(error);
      else resolvePromise({ stdout: stdoutValue, stderr: stderrValue });
    });
  }).catch(() => fail("cleanup", "CLEANUP_UNCONFIRMED"));
  let evidence;
  try { evidence = JSON.parse(result.stdout); }
  catch { fail("cleanup", "CLEANUP_UNCONFIRMED"); }
  if (
    result.stderr !== "" ||
    JSON.stringify(Object.keys(evidence ?? {}).sort()) !==
      JSON.stringify([
        "endpointRetired", "identityCount", "ownerRetired", "processGroupCount", "retiredProcessGroupCount",
        "sessionsAfterEnd", "shutdownConfirmed", "terminatedIdentityCount",
      ]) ||
    evidence.sessionsAfterEnd !== 0 ||
    evidence.shutdownConfirmed !== true ||
    evidence.endpointRetired !== true ||
    evidence.ownerRetired !== true ||
    !Number.isSafeInteger(evidence.identityCount) || evidence.identityCount < 1 ||
    evidence.terminatedIdentityCount !== evidence.identityCount ||
    !Number.isSafeInteger(evidence.processGroupCount) || evidence.processGroupCount < 1 ||
    evidence.retiredProcessGroupCount !== evidence.processGroupCount
  ) fail("cleanup", "CLEANUP_UNCONFIRMED");
  return Object.freeze(evidence);
}

async function exactPackagedRuntimeFile(runtimeSeedRoot, segments) {
  const expected = join(runtimeSeedRoot, ...segments);
  let physical;
  try { physical = await realpath(expected); }
  catch { fail("candidate", "CANDIDATE_INVALID"); }
  if (physical !== expected || !physical.startsWith(`${runtimeSeedRoot}/`)) fail("candidate", "CANDIDATE_INVALID");
  return physical;
}

async function readPackagedCandidate() {
  try {
    if (process.platform !== "darwin") fail("candidate", "UNSUPPORTED_PLATFORM");
    const requestedApp = process.env[CANDIDATE_APP_ENV];
    if (typeof requestedApp !== "string" || !isAbsolute(requestedApp) || basename(requestedApp) !== "Prime Continuim.app") {
      fail("candidate", "CANDIDATE_INVALID");
    }
    const physicalApp = await realpath(resolve(requestedApp));
    if (physicalApp !== resolve(requestedApp)) fail("candidate", "CANDIDATE_INVALID");
    const packageDirectory = dirname(physicalApp);
    const verification = await verifyMacosPackage({ projectRoot: REPO_ROOT, packageDirectory });
    if (verification.appPath !== physicalApp) fail("candidate", "CANDIDATE_INVALID");

    const resources = join(physicalApp, "Contents", "Resources");
    const desktopExecutable = join(physicalApp, "Contents", "MacOS", "Prime Continuim");
    const hostExecutable = join(resources, "host-runtime", "bin", "node");
    const browserExecutable = join(resources, "browser-runtime", "Electron.app", "Contents", "MacOS", "Electron");
    const hostdPath = join(resources, "hostd", "hostd.cjs");
    const runtimeSeedRoot = join(resources, "runtime-seed");
    const asarPath = join(resources, "app.asar");
    const [hostdBytes, appAsarBytes] = await Promise.all([readFile(hostdPath), readFile(asarPath)]);
    const bytes = extractEmbeddedRuntimeAttestation(hostdBytes);
    const attestation = parseRuntimeAttestation(bytes);
    const executableDigests = new Map(verification.executables.map((entry) => [entry.label, entry.sha256]));
    const desktopExecutableSha256 = executableDigests.get("desktop Electron");
    const hostExecutableSha256 = executableDigests.get("host Node");
    const browserExecutableSha256 = executableDigests.get("browser Electron");
    if (
      !desktopExecutableSha256 || !hostExecutableSha256 || !browserExecutableSha256 ||
      attestation.assurance !== "development-integrity" ||
      attestation.runtime.platform !== process.platform ||
      attestation.runtime.arch !== process.arch ||
      attestation.runtime.releaseVersion !== PRIME_AGENT_RELEASE_VERSION ||
      attestation.browserBridge?.protocol !== "prime-continuim.browser.v1" ||
      attestation.browserBridge?.engine !== "verified-electron-host" ||
      attestation.browserBridge?.smoke?.verified !== true ||
      JSON.stringify(attestation.browserBridge.smoke.operations) !==
        JSON.stringify(["doctor", "open", "snapshot", "find", "click", "eval", "screenshot", "close"])
    ) fail("candidate", "CANDIDATE_INVALID");
    return Object.freeze({
      attestation,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      packageDirectory,
      desktopExecutable,
      hostExecutable,
      browserExecutable,
      hostdPath,
      runtimeSeedRoot,
      evidence: Object.freeze({
        appAsarSha256: createHash("sha256").update(appAsarBytes).digest("hex"),
        desktopExecutableSha256,
        hostExecutableSha256,
        browserExecutableSha256,
        hostdSha256: verification.hostdSha256,
      }),
    });
  } catch (error) {
    if (error instanceof ToolDogfoodContractError) throw error;
    fail("candidate", "CANDIDATE_INVALID");
  }
}

function validateHostHealth(health, attestation, requireCommands = true) {
  const capabilities = Array.isArray(health?.capabilities) ? health.capabilities : [];
  const target = health?.runtimeIntegrity?.target;
  if (
    health?.protocolVersion !== 1 ||
    health?.serviceState !== "ready" ||
    !health?.host?.hostId ||
    health.runtimeIntegrity?.status !== "ready" ||
    health.runtimeIntegrity?.assurance !== attestation.assurance ||
    target?.runtime !== "prime-agent" ||
    target?.releaseVersion !== attestation.runtime.releaseVersion ||
    target?.runtimeBuildId !== attestation.runtime.runtimeBuildId ||
    target?.treeSha256 !== attestation.tree.sha256 ||
    target?.manifestSha256 !== attestation.manifest.sha256 ||
    REQUIRED_HEALTH_CAPABILITIES.some((capability) => !capabilities.includes(capability)) ||
    capabilities.includes("prime_agent_commands_v2") !== requireCommands
  ) fail("host", "HOST_UNAVAILABLE");
  return health;
}

function exactSingleResidentThread(catalog, hostId) {
  const threads = Array.isArray(catalog?.threads) ? catalog.threads : [];
  const projects = Array.isArray(catalog?.projects) ? catalog.projects : [];
  if (
    catalog?.host?.hostId !== hostId ||
    threads.length !== 1 ||
    projects.length !== 1 ||
    threads[0]?.currentLocation?.hostId !== hostId ||
    !threads[0]?.threadId
  ) fail("precondition", "PRECONDITION_NOT_PROVEN");
  return threads[0].threadId;
}

async function validateDetachedWorkspace(workspace) {
  const topLevel = await runGit(workspace, ["rev-parse", "--show-toplevel"]);
  if (await realpath(topLevel.trim()) !== workspace) fail("fixture", "FIXTURE_INVALID");
  const head = (await runGit(workspace, ["rev-parse", "HEAD"])).trim();
  if (!/^[a-f0-9]{40,64}$/u.test(head)) fail("fixture", "FIXTURE_INVALID");
  const status = await runGit(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") fail("fixture", "FIXTURE_INVALID");
  const branch = await runGitAllowExit(workspace, ["symbolic-ref", "-q", "HEAD"]);
  if (branch.code !== 1 || branch.stdout !== "") fail("fixture", "FIXTURE_INVALID");
  return Object.freeze({
    detachedHead: true,
    initiallyClean: true,
    head: createHash("sha256").update(head).digest("hex"),
  });
}

async function runGit(cwd, args) {
  const result = await runGitAllowExit(cwd, args);
  if (result.code !== 0 || result.stderr !== "") fail("fixture", "FIXTURE_INVALID");
  return result.stdout;
}

async function runGitAllowExit(cwd, args) {
  return await new Promise((resolvePromise, rejectPromise) => {
    execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env: minimalGitEnvironment(process.env),
    }, (error, stdoutValue, stderrValue) => {
      if (error && !Number.isInteger(error.code)) {
        rejectPromise(error);
        return;
      }
      resolvePromise(Object.freeze({
        code: error ? error.code : 0,
        stdout: stdoutValue,
        stderr: stderrValue,
      }));
    });
  }).catch(() => fail("fixture", "FIXTURE_INVALID"));
}

function minimalGitEnvironment(environment) {
  const result = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP"]) {
    if (typeof environment[name] === "string" && environment[name].length > 0) result[name] = environment[name];
  }
  result.GIT_CONFIG_NOSYSTEM = "1";
  result.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  result.GIT_OPTIONAL_LOCKS = "0";
  result.GIT_TERMINAL_PROMPT = "0";
  return result;
}

async function waitForInFlightProjection(endpoint, threadId, initial, identity) {
  const deadline = Date.now() + OPERATOR_DEADLINE_MS;
  while (Date.now() < deadline) {
    assertOwnedAlive(runState.hostd, "host", "HOST_UNAVAILABLE");
    assertOwnedAlive(runState.desktop, "host", "HOST_UNAVAILABLE");
    const snapshot = (await requestHost(
      endpoint,
      "thread.snapshot",
      { threadId },
      HOST_REQUEST_TIMEOUT_MS,
    )).result;
    if (snapshot?.childAgents?.some((child) => ["failed", "cancelled"].includes(child?.state))) {
      fail("in_flight", "IN_FLIGHT_NOT_PROVEN");
    }
    try {
      validateInFlightProjection(snapshot, { initial, identity });
      return snapshot;
    } catch (error) {
      if (!(error instanceof ToolDogfoodContractError) || error.code !== "IN_FLIGHT_NOT_PROVEN") throw error;
    }
    if (
      snapshot?.childAgents?.some((child) => child?.sessionName === CHILD_NAME && child?.state === "complete") ||
      snapshot?.goals?.some((goal) => goal?.objective === identity.goalObjective && goal?.state === "complete")
    ) fail("in_flight", "IN_FLIGHT_NOT_PROVEN");
    await delay(100);
  }
  fail("operator", "OPERATOR_DEADLINE_EXCEEDED");
}

async function waitForCompletedProjection(endpoint, threadId, initial, identity, inFlight) {
  const deadline = Date.now() + OPERATOR_DEADLINE_MS;
  while (Date.now() < deadline) {
    assertOwnedAlive(runState.hostd, "host", "HOST_UNAVAILABLE");
    assertOwnedAlive(runState.desktop, "host", "HOST_UNAVAILABLE");
    try {
      const snapshot = (await requestHost(
        endpoint,
        "thread.snapshot",
        { threadId },
        HOST_REQUEST_TIMEOUT_MS,
      )).result;
      if (snapshot?.childAgents?.some((child) => ["failed", "cancelled"].includes(child?.state))) {
        fail("projection", "PROJECTION_NOT_PROVEN");
      }
      try {
        validateCompletedProjection(snapshot, { initial, identity, inFlight });
        return snapshot;
      } catch (error) {
        if (!(error instanceof ToolDogfoodContractError) || error.code !== "PROJECTION_NOT_PROVEN") throw error;
      }
    } catch (error) {
      throw error;
    }
    await delay(500);
  }
  fail("operator", "OPERATOR_DEADLINE_EXCEEDED");
}

async function observeStableRestart(endpoint, threadId, initial, identity, inFlight) {
  const first = await waitForCompletedProjection(endpoint, threadId, initial, identity, inFlight);
  const observations = [{ snapshot: first, observedAtMonotonicMs: Math.floor(performance.now()) }];
  while (observations.length < MIN_POST_RESTART_OBSERVATIONS) {
    await delay(POST_RESTART_OBSERVATION_INTERVAL_MS + 25);
    assertOwnedAlive(runState.hostd, "restart", "RESTART_NOT_PROVEN");
    assertOwnedAlive(runState.desktop, "restart", "RESTART_NOT_PROVEN");
    const snapshot = (await requestHost(
      endpoint,
      "thread.snapshot",
      { threadId },
      HOST_REQUEST_TIMEOUT_MS,
    )).result;
    validateCompletedProjection(snapshot, { initial, identity, inFlight });
    observations.push({ snapshot, observedAtMonotonicMs: Math.floor(performance.now()) });
  }
  return Object.freeze(observations);
}

async function inspectReplayState(dataDirectory, userDataDirectory, threadId) {
  const [commandRecords, eventRecords, outboxEntryCount, dispatchEntries] = await Promise.all([
    readBoundedJsonLines(join(dataDirectory, "journals", "commands.jsonl"), "command"),
    readBoundedJsonLines(join(dataDirectory, "journals", "events.jsonl"), "event"),
    readOutboxEntryCount(join(userDataDirectory, "control", "command-outbox.json")),
    readdir(join(dataDirectory, "resident-dispatch-attempts"), { withFileTypes: true })
      .catch(() => fail("no_replay", "REPLAY_NOT_DISPROVEN")),
  ]);
  if (
    dispatchEntries.length > 1_024 ||
    dispatchEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) fail("no_replay", "REPLAY_NOT_DISPROVEN");
  const commandIds = commandRecords
    .filter((record) => record.threadId === threadId)
    .map((record) => `command:${record.journalId}`);
  const eventIds = eventRecords
    .filter((record) => record.threadId === threadId)
    .map((record) => `event:${record.eventId}`);
  const journalIds = [...commandIds, ...eventIds];
  if (commandIds.length < 1 || journalIds.length !== new Set(journalIds).size) {
    fail("no_replay", "REPLAY_NOT_DISPROVEN");
  }
  return Object.freeze({
    journalIds: Object.freeze(journalIds),
    outboxEntryCount,
    dispatchAttemptCount: dispatchEntries.length,
  });
}

async function readBoundedJsonLines(path, kind) {
  let bytes;
  try { bytes = await readStableOwnedFile(path, MAX_FRAME_BYTES); }
  catch (error) {
    if (error instanceof ToolDogfoodContractError) throw error;
    fail("no_replay", "REPLAY_NOT_DISPROVEN");
  }
  if (bytes.byteLength < 2 || bytes.at(-1) !== 0x0a) fail("no_replay", "REPLAY_NOT_DISPROVEN");
  const lines = bytes.toString("utf8").split("\n").filter(Boolean);
  if (lines.length < 1 || lines.length > 4_096) fail("no_replay", "REPLAY_NOT_DISPROVEN");
  const seen = new Set();
  return lines.map((line) => {
    let record;
    try { record = JSON.parse(line); }
    catch { fail("no_replay", "REPLAY_NOT_DISPROVEN"); }
    const recordId = kind === "command" ? record?.journalId : record?.eventId;
    if (
      record?.version !== 1 || !boundedDogfoodId(recordId) || seen.has(recordId) ||
      (record?.threadId !== undefined && !boundedDogfoodId(record.threadId))
    ) fail("no_replay", "REPLAY_NOT_DISPROVEN");
    seen.add(recordId);
    return record;
  });
}

async function readOutboxEntryCount(path) {
  let bytes;
  try { bytes = await readStableOwnedFile(path, 1024 * 1024); }
  catch (error) {
    if (error?.code === "ENOENT") return 0;
    if (error instanceof ToolDogfoodContractError) throw error;
    fail("no_replay", "REPLAY_NOT_DISPROVEN");
  }
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { fail("no_replay", "REPLAY_NOT_DISPROVEN"); }
  if (!Array.isArray(value) || value.length > 1_024) fail("no_replay", "REPLAY_NOT_DISPROVEN");
  return value.length;
}

async function readStableOwnedFile(path, maximumBytes) {
  const before = await lstat(path);
  if (
    !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
    before.size < 1 || before.size > maximumBytes ||
    (process.platform !== "win32" && (before.mode & 0o022) !== 0) ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  ) fail("no_replay", "REPLAY_NOT_DISPROVEN");
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    !after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino ||
    after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.byteLength !== after.size
  ) fail("no_replay", "REPLAY_NOT_DISPROVEN");
  return bytes;
}

function boundedDogfoodId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

async function waitForEndedResident(endpoint, threadId, completedSnapshot, authority, attestation) {
  const deadline = Date.now() + OPERATOR_DEADLINE_MS;
  while (Date.now() < deadline) {
    assertOwnedAlive(runState.hostd, "host", "HOST_UNAVAILABLE");
    assertOwnedAlive(runState.desktop, "host", "HOST_UNAVAILABLE");
    try {
      const snapshot = (await requestHost(
        endpoint,
        "thread.snapshot",
        { threadId },
        HOST_REQUEST_TIMEOUT_MS,
      )).result;
      const ended = validateEndedProjection(snapshot, { completedSnapshot, authority });
      const control = (await requestHost(
        endpoint,
        "thread.control.snapshot",
        {
          expectedHostId: authority.hostId,
          threadId: authority.threadId,
          expectedExecutionGenerationId: authority.executionGenerationId,
        },
        HOST_REQUEST_TIMEOUT_MS,
      )).result;
      validateEndedControlProjection(control, { authority, ended });
      const lifecycle = (await requestHost(
        endpoint,
        "resident.lifecycle.status",
        { expectedHostId: authority.hostId, operationId: ended.operationId },
        HOST_REQUEST_TIMEOUT_MS,
      )).result?.status;
      validateCompletedEndLifecycleStatus(lifecycle, { authority, operationId: ended.operationId, ended });
      const health = (await requestHost(endpoint, "health.get", {}, HOST_REQUEST_TIMEOUT_MS)).result;
      validateHostHealth(health, attestation, false);
      return ended;
    } catch (error) {
      if (
        !(error instanceof ToolDogfoodContractError) ||
        !["CLEANUP_UNCONFIRMED", "HOST_UNAVAILABLE"].includes(error.code)
      ) throw error;
    }
    await delay(500);
  }
  fail("cleanup", "CLEANUP_UNCONFIRMED");
}

async function startLoopbackFixture(identity) {
  const events = [];
  const sockets = new Set();
  const page = Buffer.from(createDogfoodPage(identity), "utf8");
  let exactAuthority;
  const server = createServer((request, response) => {
    const authority = request.headers.host;
    if (!exactAuthority || authority !== exactAuthority) {
      response.writeHead(421, { "content-type": "text/plain", connection: "close" });
      response.end("misdirected");
      return;
    }
    if (request.method === "GET" && request.url === `/dogfood/${identity.runId}`) {
      events.push(Object.freeze({ runId: identity.runId, action: "open" }));
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(page.byteLength),
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      });
      response.end(page);
      return;
    }
    if (request.method === "POST" && request.url === `/event/${identity.runId}`) {
      readBoundedRequestJson(request).then((body) => {
        if (
          body?.runId !== identity.runId ||
          !["fill", "click"].includes(body.action) ||
          body.value !== identity.fillValue ||
          events.length >= 32
        ) {
          response.writeHead(400, { connection: "close" });
          response.end();
          return;
        }
        events.push(Object.freeze({ runId: identity.runId, action: body.action, value: body.value }));
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
      }).catch(() => {
        response.writeHead(400, { connection: "close" });
        response.end();
      });
      return;
    }
    response.writeHead(404, { connection: "close" });
    response.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    fail("fixture", "FIXTURE_INVALID");
  }
  exactAuthority = `127.0.0.1:${address.port}`;
  return Object.freeze({
    events,
    sockets,
    pageUrl: `http://${exactAuthority}/dogfood/${identity.runId}`,
    close: async (force = false) => await new Promise((resolvePromise, rejectPromise) => {
      if (force) for (const socket of sockets) socket.destroy();
      server.close((error) => error ? rejectPromise(error) : resolvePromise());
    }),
  });
}

async function readBoundedRequestJson(request) {
  const type = request.headers["content-type"];
  if (type !== "application/json") throw new Error("invalid content type");
  let bytes = Buffer.alloc(0);
  for await (const chunk of request) {
    bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
    if (bytes.byteLength > MAX_HTTP_BODY_BYTES) throw new Error("body too large");
  }
  return JSON.parse(bytes.toString("utf8"));
}

async function waitForLoopbackRetirement(loopback, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (loopback.sockets.size === 0) return;
    await delay(50);
  }
  fail("cleanup", "CLEANUP_UNCONFIRMED");
}

async function writeReceiptNoReplace(path, receipt) {
  const bytes = serializeReceipt(receipt);
  const candidate = join(dirname(path), `.receipt.candidate-${randomUUID()}`);
  let handle;
  let published = false;
  try {
    handle = await openFile(candidate, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(candidate, path);
    published = true;
  } catch (error) {
    fail("receipt", "RECEIPT_INVALID");
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) await rm(candidate, { force: true }).catch(() => undefined);
  }
  await syncDirectory(dirname(path));
  try { await rm(candidate, { force: false }); }
  catch { fail("receipt", "RECEIPT_INVALID"); }
  await syncDirectory(dirname(path));
  let finalMetadata;
  try { finalMetadata = await lstat(path); }
  catch { fail("receipt", "RECEIPT_INVALID"); }
  if (
    !finalMetadata.isFile() || finalMetadata.isSymbolicLink() || finalMetadata.nlink !== 1 ||
    finalMetadata.size !== bytes.byteLength
  ) fail("receipt", "RECEIPT_INVALID");
}

async function syncDirectory(path) {
  if (process.platform !== "win32") {
    let directory;
    try {
      directory = await openFile(path, "r");
      await directory.sync();
    } catch {
      fail("receipt", "RECEIPT_INVALID");
    } finally {
      await directory?.close().catch(() => undefined);
    }
  }
}

async function requestHost(socketPath, method, requestPayload, timeoutMs) {
  const requestId = `tool-dogfood-${randomUUID()}`;
  const payload = Buffer.from(JSON.stringify({
    protocolVersion: 1,
    requestId,
    method,
    payload: requestPayload,
  }), "utf8");
  if (payload.byteLength > MAX_FRAME_BYTES) fail("host", "HOST_UNAVAILABLE");
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
    const timer = setTimeout(() => finish(new ToolDogfoodContractError("host", "HOST_UNAVAILABLE")), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_FRAME_BYTES + 4) return finish(new ToolDogfoodContractError("host", "HOST_UNAVAILABLE"));
      if (buffer.byteLength < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length < 1 || length > MAX_FRAME_BYTES) return finish(new ToolDogfoodContractError("host", "HOST_UNAVAILABLE"));
      if (buffer.byteLength < length + 4) return;
      let response;
      try { response = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")); }
      catch { return finish(new ToolDogfoodContractError("host", "HOST_UNAVAILABLE")); }
      if (response?.requestId !== requestId || response?.method !== method || response?.ok !== true) {
        return finish(new ToolDogfoodContractError("host", "HOST_UNAVAILABLE"));
      }
      finish(undefined, response);
    });
    socket.once("error", () => finish(new ToolDogfoodContractError("host", "HOST_UNAVAILABLE")));
    socket.once("close", () => {
      if (!settled) finish(new ToolDogfoodContractError("host", "HOST_UNAVAILABLE"));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
