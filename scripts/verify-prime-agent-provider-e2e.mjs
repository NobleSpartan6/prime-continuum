import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { stdin, stderr, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { extractFile, statFile, uncache } from "@electron/asar";
import {
  CONFIRMATION_PHRASE,
  MIN_POST_RESTART_OBSERVATIONS,
  NullDelimitedCdpDecoder,
  POST_RESTART_OBSERVATION_INTERVAL_MS,
  ProviderE2eContractError,
  assertInteractiveAdmission,
  assertNoCredentialEnvironment,
  assertTypedConfirmation,
  createFailureReceipt,
  createFunctionalReceipt,
  credentialStrippedEnvironment,
  digestBoundedRegularFileTree,
  encodeCdpMessage,
  fail,
  hasVisibleAssistantStreamEvidence,
  parseVisibleModelRowMetadata,
  removeIsolatedTemporaryRoot,
  serializeReceipt,
  uniqueExactVisibleModelRowIndex,
  validateAuthenticatedPrimeAgentCatalog,
  validateInitialPrimeAgentCatalog,
  validateRestartNoReplay,
  validateSelectedModelProjection,
  validateStopTransition,
  validateTerminalResidentProjection,
} from "./prime-agent-provider-e2e-lib.mjs";
import {
  extractEmbeddedRuntimeAttestation,
  parseRuntimeAttestation,
} from "./runtime-attestation-lib.mjs";
import { createPrimeAgentSmokeCustody } from "./prime-agent-smoke-custody-lib.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_UNPACKED_ROOT = resolve(REPO_ROOT, "release", "win-unpacked");
const CANDIDATE_EXECUTABLE = resolve(CANDIDATE_UNPACKED_ROOT, "Prime Continuim.exe");
const FIXTURE_PREFIX = "prime-continuim-prime-agent-e2e-";
const HOST_REQUEST_DEADLINE_MS = 5_000;
const LIFECYCLE_REQUEST_DEADLINE_MS = 180_000;
const READY_DEADLINE_MS = 180_000;
const RENDERER_READY_DEADLINE_MS = 180_000;
const OAUTH_DEADLINE_MS = 10 * 60_000;
const TURN_DEADLINE_MS = 10 * 60_000;
const END_DEADLINE_MS = 5 * 60_000;
const HELPER_DEADLINE_MS = 60_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_JOURNAL_RECORDS = 20_000;
// The pinned v0.7.2 image currently contains 20,764 files. Preserve room for
// bounded runtime growth without weakening exact per-file/tree equality.
const MAX_TREE_FILES = 25_000;
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024;
const PROVIDER_ID = "openai-codex";
const PROJECT_ID = "prime-agent-provider-e2e-project";
const WORKSPACE_ID = "prime-agent-provider-e2e-workspace";
const THREAD_ID = "prime-agent-provider-e2e-thread";
const EXECUTION_GENERATION_ID = "prime-agent-provider-e2e-execution-1";
const PROVISION_OPERATION_ID = "prime-agent-provider-e2e-provision-1";
const SNAPSHOT_READ_FUNCTION = "function(input){return globalThis.prime.requestSnapshot(input)}";
const MODELS_TRIGGER_TEXT = "Models & accounts";
const CONNECT_TEXT = "Connect ChatGPT";
const OPENAI_PROVIDER_SELECTOR = '[data-provider-filter][data-provider-id="openai-codex"]';
const MODEL_SEARCH_SELECTOR = 'input[placeholder="Search models"]';
const MODEL_SELECT_SELECTOR = ".model-row__select";
const MODELS_CLOSE_SELECTOR = 'button[aria-label="Close models and accounts"]';
const COMPOSER_SELECTOR = "#thread-composer";
const PRIMARY_ACTION_SELECTOR = "#resident-turn-primary";
const VISIBLE_ASSISTANT_BODY_SELECTOR = "#thread-transcript .message--assistant.message--streaming .message__body";
const INSPECTOR_OPEN_SELECTOR = 'button[aria-label="Open inspector"]';
const UIA_CLOSE_HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;

public static class PrimeContinuimExactClose
{
    private const int MaxRootChildren = 64;
    private const int MaxTitleBarNodes = 64;
    private const int MaxTitleBarDepth = 8;
    private const int InvokeTimeoutMilliseconds = 10000;

    private sealed class PendingNode
    {
        public PendingNode(AutomationElement element, int depth)
        {
            Element = element;
            Depth = depth;
        }

        public AutomationElement Element { get; private set; }
        public int Depth { get; private set; }
    }

    public static int InvokeBounded(int processId)
    {
        try
        {
            Task<int> task = Task.Factory.StartNew(
                () => InvokeCore(processId),
                CancellationToken.None,
                TaskCreationOptions.DenyChildAttach,
                TaskScheduler.Default);
            if (!task.Wait(InvokeTimeoutMilliseconds)) return 20;
            return task.Result;
        }
        catch
        {
            return 21;
        }
    }

    private static int InvokeCore(int processId)
    {
        try
        {
            if (Thread.CurrentThread.GetApartmentState() != ApartmentState.MTA) return 4;
            Process process = Process.GetProcessById(processId);
            process.Refresh();
            IntPtr handle = process.MainWindowHandle;
            if (handle == IntPtr.Zero) return 5;

            AutomationElement root = AutomationElement.FromHandle(handle);
            if (root == null || root.Current.ProcessId != processId) return 6;
            TreeWalker walker = TreeWalker.ControlViewWalker;
            List<AutomationElement> titleBars = new List<AutomationElement>();
            AutomationElement child = walker.GetFirstChild(root);
            int rootChildren = 0;
            while (child != null)
            {
                rootChildren += 1;
                if (rootChildren > MaxRootChildren) return 7;
                AutomationElement next = walker.GetNextSibling(child);
                AutomationElement.AutomationElementInformation current = child.Current;
                Rect bounds = current.BoundingRectangle;
                if (
                    current.ProcessId == processId &&
                    current.ControlType == ControlType.TitleBar &&
                    current.IsEnabled &&
                    !current.IsOffscreen &&
                    bounds.Width > 0 &&
                    bounds.Height > 0)
                {
                    titleBars.Add(child);
                }
                child = next;
            }
            if (titleBars.Count != 1) return 8;

            Queue<PendingNode> pending = new Queue<PendingNode>();
            pending.Enqueue(new PendingNode(titleBars[0], 0));
            List<InvokePattern> closeCandidates = new List<InvokePattern>();
            int visited = 0;
            int discovered = 1;
            while (pending.Count > 0)
            {
                PendingNode node = pending.Dequeue();
                visited += 1;
                if (visited > MaxTitleBarNodes || node.Depth > MaxTitleBarDepth) return 9;
                AutomationElement.AutomationElementInformation current = node.Element.Current;
                if (current.ProcessId != processId) return 10;
                if (node.Depth > 0 && current.ControlType == ControlType.Button && current.Name == "Close")
                {
                    Rect bounds = current.BoundingRectangle;
                    object pattern;
                    if (
                        current.IsEnabled &&
                        !current.IsOffscreen &&
                        bounds.Width > 0 &&
                        bounds.Height > 0 &&
                        node.Element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern) &&
                        pattern is InvokePattern)
                    {
                        closeCandidates.Add((InvokePattern)pattern);
                    }
                }

                AutomationElement descendant = walker.GetFirstChild(node.Element);
                if (descendant != null && node.Depth == MaxTitleBarDepth) return 11;
                while (descendant != null)
                {
                    discovered += 1;
                    if (discovered > MaxTitleBarNodes) return 9;
                    pending.Enqueue(new PendingNode(descendant, node.Depth + 1));
                    descendant = walker.GetNextSibling(descendant);
                }
            }
            if (closeCandidates.Count != 1) return 12;
            closeCandidates[0].Invoke();
            return 0;
        }
        catch
        {
            return 13;
        }
    }
}
`;
const DAEMON_AUDIT_HELPER_SOURCE = String.raw`
import { createConnection } from "node:net";
const [moduleUrl, socketPath, action] = process.argv.slice(2);
if (!moduleUrl || !socketPath || !["list", "shutdown"].includes(action)) throw new Error("invalid daemon audit arguments");
const { DaemonClient } = await import(moduleUrl);
const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const endpointAcceptsConnection = () => new Promise((resolveConnection) => {
  const socket = createConnection(socketPath);
  let settled = false;
  const finish = (accepted) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolveConnection(accepted);
  };
  const timer = setTimeout(() => finish(true), 500);
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});
let client;
try {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const candidate = new DaemonClient(socketPath);
    try { await candidate.connect(500); client = candidate; break; }
    catch { candidate.close(); await delay(50); }
  }
  if (!client) throw new Error("resident daemon did not accept a bounded audit connection");
  if (action === "list") {
    const response = await client.request({ type: "list", includeClientOwned: true }, 5_000);
    if (response?.type !== "response" || response.command !== "list" || response.success !== true || !Array.isArray(response.data?.sessions)) {
      throw new Error("resident daemon list response is invalid");
    }
    process.stdout.write(JSON.stringify({ auditVersion: 1, action, sessionCount: response.data.sessions.length }));
  } else {
    const response = await client.request({ type: "shutdown", force: true }, 5_000);
    if (response?.type !== "response" || response.command !== "shutdown" || response.success !== true) {
      throw new Error("resident daemon did not confirm shutdown");
    }
    client.close();
    client = undefined;
    const deadline = Date.now() + 30_000;
    let endpointTerminated = false;
    while (Date.now() < deadline) {
      endpointTerminated = !(await endpointAcceptsConnection());
      if (endpointTerminated) break;
      await delay(250);
    }
    if (!endpointTerminated) throw new Error("resident daemon endpoint did not retire");
    process.stdout.write(JSON.stringify({ auditVersion: 1, action, shutdownConfirmed: true, endpointTerminated: true }));
  }
} finally {
  client?.close();
}
`;
const LONG_NO_TOOLS_PROMPT = [
  "Do not use tools, read files, modify files, or make network requests.",
  "Write eight hundred numbered one-sentence observations about reliable software verification.",
  "Begin immediately and continue until every observation is written so the response remains streaming long enough for Stop to be exercised.",
].join(" ");

let currentStage = "admission";
const runState = {
  fixtureCreated: false,
  hostdStarted: false,
  desktopStarted: false,
  custodyObserved: false,
  daemonObserved: false,
  daemonShutdownAttempted: false,
  custodyRemovalAttempted: false,
  temporaryRootRemovalAttempted: false,
  endOutcomeUncertain: false,
  helperMayRemain: false,
  fixture: undefined,
  custody: undefined,
  hostd: undefined,
  desktop: undefined,
  daemonContext: undefined,
};

try {
  const profile = process.env.USERPROFILE;
  const tokenGroupSids = await collectTokenGroupSids();
  assertInteractiveAdmission({
    platform: process.platform,
    arch: process.arch,
    stdinIsTTY: stdin.isTTY === true,
    stdoutIsTTY: stdout.isTTY === true,
    ci: process.env.CI,
    githubActions: process.env.GITHUB_ACTIONS,
    argv: process.argv.slice(2),
    checkpointAssertion: process.env.PRIME_CONTINUIM_PROVIDER_E2E_DISPOSABLE_CHECKPOINT,
    username: process.env.USERNAME,
    tokenUsername: await collectTokenUsername(),
    userProfileBasename: await canonicalUserProfileBasename(profile),
    uiCulture: await collectUiCulture(),
    groupSids: tokenGroupSids,
    integritySids: tokenGroupSids.filter((sid) => /^S-1-16-\d+$/u.test(sid)),
  });
  assertNoCredentialEnvironment(process.env);
  const confirmation = createInterface({ input: stdin, output: stderr });
  let answer;
  try {
    answer = await confirmation.question(
      "This functional test uses live Prime Agent OAuth, provider network/quota, and the installed runtime's tool authority. " +
      "Prime Agent stores OAuth material as plaintext on this disposable host; the system-browser session is not inspected or cleaned. " +
      "Any uncertain cleanup retains the fixture, and external VM rollback or destruction remains mandatory even after a pass.\n" +
      `Type exactly: ${CONFIRMATION_PHRASE}\n> `,
    );
  } finally {
    confirmation.close();
  }
  assertTypedConfirmation(answer);

  currentStage = "candidate";
  const candidate = await verifyInstalledCandidate();
  const targetModelId = requireTargetModelId();
  currentStage = "fixture";
  const fixture = await createFixture(candidate);
  runState.fixture = fixture;
  const environments = isolatedEnvironments(fixture);
  const startedAt = Date.now();
  const timings = {};

  currentStage = "hostd_start";
  // Arm ProgramData custody cleanup before the installed host can create its
  // derived leaf; a failed startup may have crossed that mutation boundary.
  runState.custodyObserved = true;
  let hostd = await startOwnedHostd(candidate, fixture, environments.hostd);
  runState.hostd = hostd;
  const firstHealth = await waitForHostReady(hostd, fixture.hostEndpoint, false);
  const hostId = exactHostId(firstHealth);
  const hostdIdentityBefore = await collectWindowsProcessIdentity(hostd.pid, fixture.temporaryDirectory);
  await fixture.custody.captureExisting();

  currentStage = "provision";
  const provisionRequest = Object.freeze({
    expectedHostId: hostId,
    operationId: PROVISION_OPERATION_ID,
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    executionGenerationId: EXECUTION_GENERATION_ID,
    workspaceDirectory: fixture.workspaceDirectory,
    projectDisplayName: "Prime Agent provider E2E",
    threadTitle: "Prime Agent provider E2E",
    createdAt: new Date().toISOString(),
    sessionName: "Prime Continuim installed provider E2E",
  });
  runState.daemonObserved = true;
  const provision = await requestHost(
    fixture.hostEndpoint,
    "resident.provision",
    provisionRequest,
    LIFECYCLE_REQUEST_DEADLINE_MS,
  );
  assertProvisionCommitted(provision.result, provisionRequest);
  const residentHealth = await waitForHostReady(hostd, fixture.hostEndpoint, true);
  assertSameRuntimeIdentity(firstHealth.runtimeIntegrity, residentHealth.runtimeIntegrity);
  const initialProjection = await readHostSnapshot(fixture.hostEndpoint);
  assertExactResidentFixture(initialProjection, hostId);
  const initialCatalog = (await requestHost(
    fixture.hostEndpoint,
    "runtime.model_catalog",
    { expectedHostId: hostId },
    LIFECYCLE_REQUEST_DEADLINE_MS,
  )).result;
  validateInitialPrimeAgentCatalog(initialCatalog);
  const runtimeRoot = await resolveInstalledRuntimeRoot(fixture, candidate, residentHealth.runtimeIntegrity);
  runState.daemonContext = Object.freeze({
    executable: candidate.installedExecutable,
    helperPath: fixture.daemonAuditPath,
    runtimeRoot,
    endpoint: residentDaemonEndpoint(fixture.dataDirectory),
    environment: environments.hostd,
  });

  currentStage = "desktop_start";
  let desktop = await startInstalledDesktop(candidate, fixture, environments.desktop);
  runState.desktop = desktop;
  const desktopIdentityBefore = await collectWindowsProcessIdentity(desktop.pid, fixture.temporaryDirectory);
  currentStage = "renderer";
  let controller = await attachWorkbench(desktop, candidate.rendererUrl);
  await controller.waitForSnapshot({ threadId: THREAD_ID }, (snapshot) =>
    snapshot?.thread?.threadId === THREAD_ID && snapshot?.runtime?.residency === "resident",
  RENDERER_READY_DEADLINE_MS);

  currentStage = "oauth";
  const oauthStartedAt = Date.now();
  await controller.clickVisibleText("button", MODELS_TRIGGER_TEXT, RENDERER_READY_DEADLINE_MS);
  await controller.clickVisible(OPENAI_PROVIDER_SELECTOR, 30_000);
  await controller.clickVisibleText("button", CONNECT_TEXT, 30_000);
  stderr.write("Complete the Prime Agent ChatGPT sign-in in the opened system browser. No login locator or credential material is read by this harness.\n");
  const authenticated = await waitForCatalog(fixture.hostEndpoint, hostId, (catalog) => {
    try { return validateAuthenticatedPrimeAgentCatalog(catalog, targetModelId); }
    catch (error) {
      if (error instanceof ProviderE2eContractError) return undefined;
      throw error;
    }
  }, OAUTH_DEADLINE_MS);
  if (!authenticated) fail("oauth", "OAUTH_NOT_COMPLETED");
  timings.oauth = Date.now() - oauthStartedAt;

  currentStage = "model_selection";
  const modelStartedAt = Date.now();
  await controller.typeVisible(MODEL_SEARCH_SELECTOR, targetModelId, 30_000);
  await controller.clickExactVisibleModelRow({
    providerId: PROVIDER_ID,
    providerDisplayName: authenticated.provider.displayName,
    modelId: targetModelId,
  }, 30_000);
  const selectedProjection = await controller.waitForSnapshot({ threadId: THREAD_ID }, (snapshot) => {
    try { return validateSelectedModelProjection(snapshot, { modelId: targetModelId, threadId: THREAD_ID }); }
    catch (error) {
      if (error instanceof ProviderE2eContractError) return undefined;
      throw error;
    }
  }, TURN_DEADLINE_MS);
  if (!selectedProjection) fail("model_selection", "MODEL_NOT_SELECTED");
  await controller.clickVisible(MODELS_CLOSE_SELECTOR, 30_000);
  await controller.waitForNoVisibleNode("#models-title", 30_000);
  await controller.waitForVisibleNode(COMPOSER_SELECTOR, 30_000);
  timings.modelSelection = Date.now() - modelStartedAt;

  currentStage = "prompt_stream";
  const promptStartedAt = Date.now();
  await controller.typeVisible(COMPOSER_SELECTOR, LONG_NO_TOOLS_PROMPT, 30_000);
  await controller.clickVisible(PRIMARY_ACTION_SELECTOR, 30_000);
  const streamEvidence = await observeVisiblePromptStream(controller);
  currentStage = "stop";
  await controller.waitForNodeText(PRIMARY_ACTION_SELECTOR, "Stop", 30_000);
  await controller.clickVisible(PRIMARY_ACTION_SELECTOR, 30_000);
  const stoppedProjection = await controller.waitForSnapshot({ threadId: THREAD_ID }, (snapshot) =>
    snapshot?.thread?.threadId === THREAD_ID &&
    snapshot?.thread?.status === "idle" &&
    snapshot?.inProgressStream === undefined &&
    snapshot?.queueState?.pendingCommandIds?.length === 0 &&
    snapshot?.queueState?.paused === false,
  TURN_DEADLINE_MS);
  if (!stoppedProjection) fail("stop", "STOP_NOT_PROVEN");
  timings.promptAndStop = Date.now() - promptStartedAt;

  currentStage = "restart";
  const restartStartedAt = Date.now();
  await closeInstalledDesktopOrderly(desktop);
  runState.desktop = undefined;
  await stopOwnedHostd(hostd);
  runState.hostd = undefined;
  const stoppedAudit = await inspectStoppedCommandState(fixture, LONG_NO_TOOLS_PROMPT, stoppedProjection);
  validateStopTransition(streamEvidence.activeProjection, stoppedProjection, stoppedAudit);

  hostd = await startOwnedHostd(candidate, fixture, environments.hostd);
  runState.hostd = hostd;
  const restartedHealth = await waitForHostReady(hostd, fixture.hostEndpoint, true);
  assertSameRuntimeIdentity(residentHealth.runtimeIntegrity, restartedHealth.runtimeIntegrity);
  if (exactHostId(restartedHealth) !== hostId) fail("restart", "RESTART_NOT_PROVEN");
  const hostdIdentityAfter = await collectWindowsProcessIdentity(hostd.pid, fixture.temporaryDirectory);
  const reconciliation = await reconcileExactCommands(
    fixture.hostEndpoint,
    hostId,
    stoppedAudit.promptEnvelope,
    stoppedAudit.abortEnvelope,
  );
  if (!isDeepStrictEqual(reconciliation, stoppedAudit.receipts)) {
    fail("no_replay", "REPLAY_NOT_DISPROVEN");
  }

  desktop = await startInstalledDesktop(candidate, fixture, environments.desktop);
  runState.desktop = desktop;
  const desktopIdentityAfter = await collectWindowsProcessIdentity(desktop.pid, fixture.temporaryDirectory);
  controller = await attachWorkbench(desktop, candidate.rendererUrl);
  const restartedProjection = await controller.waitForSnapshot({ threadId: THREAD_ID }, (snapshot) =>
    snapshot?.thread?.threadId === THREAD_ID && snapshot?.thread?.status !== "running" && snapshot?.inProgressStream === undefined,
  RENDERER_READY_DEADLINE_MS);
  const observations = await observeStableRestart(controller, restartedProjection);
  const replayAudit = await inspectReplayState(fixture);
  const recovery = validateRestartNoReplay({
    beforeRestart: stoppedProjection,
    observations,
    hostdIdentityBefore,
    hostdIdentityAfter,
    desktopIdentityBefore,
    desktopIdentityAfter,
    journalIdsBefore: stoppedAudit.journalIds,
    journalIdsAfter: replayAudit.journalIds,
    expectedCommandIds: [stoppedAudit.promptEnvelope.commandId, stoppedAudit.abortEnvelope.commandId],
    reconciledCommandIds: reconciliation.map((receipt) => receipt.commandId),
    dispatchAttemptCount: replayAudit.dispatchAttemptCount,
    outboxEntryCount: replayAudit.outboxEntryCount,
  });
  timings.restartAndNoReplay = Date.now() - restartStartedAt;

  currentStage = "end";
  const endStartedAt = Date.now();
  if (await controller.hasVisibleNode(INSPECTOR_OPEN_SELECTOR)) {
    await controller.clickVisible(INSPECTOR_OPEN_SELECTOR, 30_000);
  }
  await controller.clickVisibleText("button", "Runtime", 30_000);
  runState.endOutcomeUncertain = true;
  await controller.clickVisibleText("button", "End session", 30_000);
  const terminalProjection = await controller.waitForSnapshot({ threadId: THREAD_ID }, (snapshot) =>
    snapshot?.residentLifecycle?.state === "ended" && snapshot?.runtime === undefined,
  END_DEADLINE_MS);
  validateTerminalResidentProjection(terminalProjection, {
    threadId: THREAD_ID,
    executionGenerationId: EXECUTION_GENERATION_ID,
  });
  await assertRetiredBinding(fixture);
  const finalDaemonAudit = await inspectResidentDaemon(runState.daemonContext, "list");
  if (finalDaemonAudit?.auditVersion !== 1 || finalDaemonAudit.action !== "list" || finalDaemonAudit.sessionCount !== 0) {
    fail("end", "END_NOT_PROVEN");
  }
  runState.endOutcomeUncertain = false;
  timings.end = Date.now() - endStartedAt;

  currentStage = "cleanup";
  await closeInstalledDesktopOrderly(desktop);
  runState.desktop = undefined;
  await stopOwnedHostd(hostd);
  runState.hostd = undefined;
  runState.daemonShutdownAttempted = true;
  const daemonShutdown = await inspectResidentDaemon(runState.daemonContext, "shutdown");
  if (daemonShutdown?.shutdownConfirmed !== true || daemonShutdown.endpointTerminated !== true) {
    fail("cleanup", "CLEANUP_UNCONFIRMED");
  }
  runState.daemonObserved = false;
  await assertCandidateArtifactsUnchanged(candidate);
  runState.custodyRemovalAttempted = true;
  const custodyCleanup = await fixture.custody.removeAfterConfirmedShutdown({ confirmedCleanShutdown: true });
  if (custodyCleanup.removed !== true) fail("cleanup", "CLEANUP_UNCONFIRMED");
  runState.custodyObserved = false;
  const totalDuration = Date.now() - startedAt;
  runState.temporaryRootRemovalAttempted = true;
  await removeIsolatedTemporaryRoot({
    root: fixture.root,
    expectedPrefix: FIXTURE_PREFIX,
    confirmedCleanShutdown: true,
  });
  runState.fixtureCreated = false;

  currentStage = "receipt";
  const receipt = createFunctionalReceipt({
    candidate: candidate.receiptIdentity,
    boundInstalledArtifactsExact: true,
    primeAgentOauthCompleted: true,
    targetModelSelected: true,
    visiblePromptSubmitted: true,
    visibleStreamObserved: streamEvidence.renderedStreamChanged,
    visibleStopInvoked: true,
    stopTerminalReceiptObserved: true,
    desktopClosedOrderlyBeforeRestart: true,
    hostdStoppedCleanly: true,
    hostdRestarted: recovery.hostdRestarted,
    desktopRestarted: recovery.desktopRestarted,
    hostdProcessIdentityChanged: hostdIdentityBefore !== hostdIdentityAfter,
    desktopProcessIdentityChanged: desktopIdentityBefore !== desktopIdentityAfter,
    harnessReconciledExactPromptAndAbortWithoutDirectSubmission: recovery.exactCommandsReconciledByHarness,
    residentDispatchAttemptsEmpty: recovery.residentDispatchAttemptsEmpty,
    outboxEmpty: recovery.outboxEmpty,
    journalIdsUnchanged: recovery.exactJournalIdsUnchanged,
    noDurableContinuimOrProviderDispatchReplayObserved: true,
    visibleEndInvoked: true,
    terminalProjectionObserved: true,
    retiredBindingObserved: true,
    zeroDaemonSessionsObserved: true,
    finalDesktopCloseOrderly: true,
    finalHostdStopCleanly: true,
    candidateArtifactsUnchanged: true,
    custodyLeafRemoved: true,
    temporaryRootRemoved: true,
    postRestartObservationCount: recovery.postRestartObservationCount,
    minimumPostRestartObservationSeparationMs: recovery.minimumPostRestartObservationSeparationMs,
    durationsMs: {
      total: totalDuration,
      oauth: timings.oauth,
      modelSelection: timings.modelSelection,
      promptAndStop: timings.promptAndStop,
      restartAndNoReplay: timings.restartAndNoReplay,
      end: timings.end,
    },
  });
  stdout.write(serializeReceipt(receipt));
  process.exitCode = 2;
} catch (error) {
  const contractError = error instanceof ProviderE2eContractError
    ? error
    : new ProviderE2eContractError(currentStage, stageCode(currentStage));
  await boundedFailureCleanup();
  stdout.write(serializeReceipt(createFailureReceipt(contractError.stage, contractError.code, runState)));
  process.exitCode = 1;
}

async function verifyInstalledCandidate() {
  const installedConfigured = process.env.PRIME_CONTINUIM_PROVIDER_E2E_INSTALLED_EXE;
  if (typeof installedConfigured !== "string" || !isAbsolute(installedConfigured)) {
    fail("candidate", "CANDIDATE_INVALID");
  }
  const installedExecutable = await canonicalRegularFile(installedConfigured);
  const candidateExecutable = await canonicalRegularFile(CANDIDATE_EXECUTABLE);
  if (pathWithin(REPO_ROOT, installedExecutable) || basename(installedExecutable).toLowerCase() !== "prime continuim.exe") {
    fail("candidate", "CANDIDATE_INVALID");
  }
  const installedRoot = dirname(installedExecutable);
  const installedArchive = await canonicalRegularFile(join(installedRoot, "resources", "app.asar"));
  const installedHostd = await canonicalRegularFile(join(installedRoot, "resources", "hostd", "hostd.cjs"));
  const installedHostNode = await canonicalRegularFile(join(installedRoot, "resources", "host-runtime", "node.exe"));
  const installedHostNodeLicense = await canonicalRegularFile(join(installedRoot, "resources", "host-runtime", "LICENSE"));
  const installedBrowserExecutable = await canonicalRegularFile(join(installedRoot, "resources", "browser-runtime", "electron.exe"));
  const installedRuntimeSeed = await canonicalDirectory(join(installedRoot, "resources", "runtime-seed"));
  const installedRuntimePointer = await canonicalRegularFile(join(installedRuntimeSeed, "current.json"));
  const candidateArchive = await canonicalRegularFile(join(CANDIDATE_UNPACKED_ROOT, "resources", "app.asar"));
  const candidateHostd = await canonicalRegularFile(join(CANDIDATE_UNPACKED_ROOT, "resources", "hostd", "hostd.cjs"));
  const candidateHostNode = await canonicalRegularFile(join(CANDIDATE_UNPACKED_ROOT, "resources", "host-runtime", "node.exe"));
  const candidateHostNodeLicense = await canonicalRegularFile(join(CANDIDATE_UNPACKED_ROOT, "resources", "host-runtime", "LICENSE"));
  const candidateBrowserExecutable = await canonicalRegularFile(join(CANDIDATE_UNPACKED_ROOT, "resources", "browser-runtime", "electron.exe"));
  const candidateRuntimeSeed = await canonicalDirectory(join(CANDIDATE_UNPACKED_ROOT, "resources", "runtime-seed"));
  const candidateRuntimePointer = await canonicalRegularFile(join(candidateRuntimeSeed, "current.json"));
  const [
    installedExecutableSha256,
    candidateExecutableSha256,
    applicationArchiveSha256,
    candidateArchiveSha256,
    hostdSha256,
    candidateHostdSha256,
    installedHostNodeSha256,
    candidateHostNodeSha256,
    installedHostNodeLicenseSha256,
    candidateHostNodeLicenseSha256,
    installedBrowserExecutableSha256,
    candidateBrowserExecutableSha256,
    installedRuntimePointerSha256,
    candidateRuntimePointerSha256,
    installedRuntimeTree,
    candidateRuntimeTree,
  ] = await Promise.all([
    sha256File(installedExecutable),
    sha256File(candidateExecutable),
    sha256File(installedArchive),
    sha256File(candidateArchive),
    sha256File(installedHostd),
    sha256File(candidateHostd),
    sha256File(installedHostNode),
    sha256File(candidateHostNode),
    sha256File(installedHostNodeLicense),
    sha256File(candidateHostNodeLicense),
    sha256File(installedBrowserExecutable),
    sha256File(candidateBrowserExecutable),
    sha256File(installedRuntimePointer),
    sha256File(candidateRuntimePointer),
    digestBoundedRegularFileTree(installedRuntimeSeed, { maxFiles: MAX_TREE_FILES, maxBytes: MAX_TREE_BYTES }),
    digestBoundedRegularFileTree(candidateRuntimeSeed, { maxFiles: MAX_TREE_FILES, maxBytes: MAX_TREE_BYTES }),
  ]);
  if (
    installedExecutableSha256 !== candidateExecutableSha256 ||
    applicationArchiveSha256 !== candidateArchiveSha256 ||
    hostdSha256 !== candidateHostdSha256 ||
    installedHostNodeSha256 !== candidateHostNodeSha256 ||
    installedHostNodeLicenseSha256 !== candidateHostNodeLicenseSha256 ||
    installedBrowserExecutableSha256 !== candidateBrowserExecutableSha256 ||
    installedExecutableSha256 === installedHostNodeSha256 ||
    installedBrowserExecutableSha256 === installedHostNodeSha256 ||
    installedRuntimePointerSha256 !== candidateRuntimePointerSha256 ||
    installedRuntimeTree.sha256 !== candidateRuntimeTree.sha256 ||
    installedRuntimeTree.fileCount !== candidateRuntimeTree.fileCount ||
    installedRuntimeTree.totalBytes !== candidateRuntimeTree.totalBytes
  ) fail("candidate", "CANDIDATE_INVALID");

  const appVersion = packagedAppVersion(installedArchive);
  if (packagedAppVersion(candidateArchive) !== appVersion) fail("candidate", "CANDIDATE_INVALID");
  const installer = await canonicalRegularFile(join(
    REPO_ROOT,
    "release",
    `Prime-Continuim-${appVersion}-windows-x64-setup.exe`,
  ));
  const installerSha256 = await sha256File(installer);
  const sidecar = await canonicalRegularFile(`${installer}.sha256`);
  const sidecarBytes = await readFile(sidecar, "utf8");
  const expectedSidecar = `${installerSha256} *${basename(installer)}`;
  if (![expectedSidecar, `${expectedSidecar}\n`, `${expectedSidecar}\r\n`].includes(sidecarBytes)) {
    fail("candidate", "CANDIDATE_INVALID");
  }

  const hostdBytes = await readFile(installedHostd);
  const attestation = parseRuntimeAttestation(extractEmbeddedRuntimeAttestation(hostdBytes));
  const pointer = parseBoundedJson(await readFile(installedRuntimePointer), 64 * 1024, "candidate");
  if (
    attestation.runtime.name !== "prime-agent" ||
    attestation.runtime.platform !== "win32" ||
    attestation.runtime.arch !== "x64" ||
    pointer.runtime !== "prime-agent" ||
    pointer.platform !== "win32" ||
    pointer.arch !== "x64" ||
    pointer.manifestSha256 !== attestation.manifest.sha256 ||
    pointer.treeSha256 !== attestation.tree.sha256 ||
    pointer.filesSha256 !== attestation.tree.filesSha256
  ) fail("candidate", "CANDIDATE_INVALID");
  if (attestation.hostRuntime.kind !== "node" || attestation.hostRuntime.executableSha256 !== installedHostNodeSha256) {
    fail("candidate", "CANDIDATE_INVALID");
  }
  if (attestation.guiRuntime.kind !== "electron" || attestation.guiRuntime.executableSha256 !== installedBrowserExecutableSha256) {
    fail("candidate", "CANDIDATE_INVALID");
  }

  const candidateFiles = [
    [installedExecutable, installedExecutableSha256],
    [candidateExecutable, candidateExecutableSha256],
    [installedArchive, applicationArchiveSha256],
    [candidateArchive, candidateArchiveSha256],
    [installedHostd, hostdSha256],
    [candidateHostd, candidateHostdSha256],
    [installedHostNode, installedHostNodeSha256],
    [candidateHostNode, candidateHostNodeSha256],
    [installedHostNodeLicense, installedHostNodeLicenseSha256],
    [candidateHostNodeLicense, candidateHostNodeLicenseSha256],
    [installedBrowserExecutable, installedBrowserExecutableSha256],
    [candidateBrowserExecutable, candidateBrowserExecutableSha256],
    [installedRuntimePointer, installedRuntimePointerSha256],
    [candidateRuntimePointer, candidateRuntimePointerSha256],
    [installer, installerSha256],
    [sidecar, await sha256File(sidecar)],
    ...installedRuntimeTree.files.map((entry) => [entry.path, entry.sha256]),
    ...candidateRuntimeTree.files.map((entry) => [entry.path, entry.sha256]),
  ];
  return Object.freeze({
    installedExecutable,
    installedRoot,
    installedArchive,
    installedHostd,
    installedHostNode,
    installedBrowserExecutable,
    installedRuntimeSeed,
    attestation,
    verificationTrees: Object.freeze([
      freezeTreeBinding(installedRuntimeTree),
      freezeTreeBinding(candidateRuntimeTree),
    ]),
    verificationArtifacts: Object.freeze(candidateFiles.map(([path, sha256]) => Object.freeze({ path, sha256 }))),
    rendererUrl: pathToFileURL(join(installedRoot, "resources", "app.asar", "out", "renderer", "index.html")).href,
    receiptIdentity: Object.freeze({
      appVersion,
      runtimeReleaseVersion: attestation.runtime.releaseVersion,
      runtimeBuildId: attestation.runtime.runtimeBuildId,
      assurance: attestation.assurance,
      installerSha256,
      installedExecutableSha256,
      applicationArchiveSha256,
      hostdSha256,
      runtimeManifestSha256: pointer.manifestSha256,
      runtimeTreeSha256: pointer.treeSha256,
    }),
  });
}

function packagedAppVersion(archive) {
  try {
    uncache(archive);
    const archiveMetadata = lstatSync(archive);
    if (!archiveMetadata.isFile() || archiveMetadata.isSymbolicLink() || archiveMetadata.size < 1 || archiveMetadata.size > 512 * 1024 * 1024) {
      fail("candidate", "CANDIDATE_INVALID");
    }
    const entry = statFile(archive, "package.json", false);
    if (
      !entry || "link" in entry || "files" in entry || entry.unpacked === true ||
      !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 64 * 1024 ||
      entry.integrity?.algorithm !== "SHA256" || !/^[a-f0-9]{64}$/u.test(entry.integrity.hash)
    ) fail("candidate", "CANDIDATE_INVALID");
    const bytes = extractFile(archive, "package.json", false);
    if (!Buffer.isBuffer(bytes) || bytes.length !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.integrity.hash) {
      fail("candidate", "CANDIDATE_INVALID");
    }
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (
      !manifest || Array.isArray(manifest) || Object.getPrototypeOf(manifest) !== Object.prototype ||
      manifest.name !== "prime-continuim" || manifest.main !== "./out/main/index.js" ||
      typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(manifest.version)
    ) fail("candidate", "CANDIDATE_INVALID");
    return manifest.version;
  } catch (error) {
    if (error instanceof ProviderE2eContractError) throw error;
    fail("candidate", "CANDIDATE_INVALID");
  } finally {
    try { uncache(archive); } catch { /* No ASAR cache is retained deliberately. */ }
  }
}

async function assertCandidateArtifactsUnchanged(candidate) {
  if (
    !Array.isArray(candidate?.verificationArtifacts) ||
    !Array.isArray(candidate?.verificationTrees) ||
    candidate.verificationTrees.length !== 2 ||
    candidate.verificationArtifacts.length < 10 ||
    candidate.verificationArtifacts.length > 2 * MAX_TREE_FILES + 10
  ) {
    fail("candidate", "CANDIDATE_INVALID");
  }
  for (const artifact of candidate.verificationArtifacts) {
    if (!artifact || typeof artifact.path !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
      fail("candidate", "CANDIDATE_INVALID");
    }
    const canonical = await canonicalRegularFile(artifact.path);
    if (canonical !== artifact.path || await sha256File(canonical) !== artifact.sha256) fail("candidate", "CANDIDATE_INVALID");
  }
  for (const binding of candidate.verificationTrees) {
    if (
      !binding || typeof binding.canonicalRoot !== "string" || !/^[a-f0-9]{64}$/u.test(binding.sha256) ||
      !Number.isSafeInteger(binding.fileCount) || binding.fileCount < 1 || binding.fileCount > MAX_TREE_FILES ||
      !Number.isSafeInteger(binding.totalBytes) || binding.totalBytes < 1 || binding.totalBytes > MAX_TREE_BYTES ||
      await canonicalDirectory(binding.canonicalRoot) !== binding.canonicalRoot
    ) fail("candidate", "CANDIDATE_INVALID");
    const observed = await digestBoundedRegularFileTree(binding.canonicalRoot, {
      maxFiles: MAX_TREE_FILES,
      maxBytes: MAX_TREE_BYTES,
    });
    if (
      observed.canonicalRoot !== binding.canonicalRoot || observed.sha256 !== binding.sha256 ||
      observed.fileCount !== binding.fileCount || observed.totalBytes !== binding.totalBytes
    ) fail("candidate", "CANDIDATE_INVALID");
  }
}

function freezeTreeBinding(tree) {
  return Object.freeze({
    canonicalRoot: tree.canonicalRoot,
    sha256: tree.sha256,
    fileCount: tree.fileCount,
    totalBytes: tree.totalBytes,
  });
}

function requireTargetModelId() {
  const value = process.env.PRIME_CONTINUIM_PROVIDER_E2E_MODEL_ID;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) {
    fail("admission", "OPT_IN_REQUIRED");
  }
  return value;
}

async function collectTokenGroupSids() {
  const bytes = await runWhoami(["/groups", "/fo", "csv", "/nh"]);
  if (!bytes) return [];
  return [...new Set((bytes.toString("utf8").match(/S-1-\d+(?:-\d+)+/giu) ?? []).map((value) => value.toUpperCase()))].sort();
}

async function collectTokenUsername() {
  const bytes = await runWhoami(["/user", "/fo", "csv", "/nh"]);
  if (!bytes) return "";
  const match = /^"([^"]+)","S-1-5-[^"]+"\r?\n?$/iu.exec(bytes.toString("utf8"));
  return match?.[1]?.split("\\").at(-1) ?? "";
}

async function runWhoami(argumentsList) {
  if (process.platform !== "win32") return undefined;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot)) return undefined;
  const executable = resolve(systemRoot, "System32", "whoami.exe");
  try {
    const metadata = await lstat(executable);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
  } catch { return undefined; }
  const result = await runBoundedProcess(executable, argumentsList, {
    environment: { SystemRoot: resolve(systemRoot), WINDIR: resolve(systemRoot) },
    timeoutMs: 10_000,
    maxStdoutBytes: 64 * 1024,
  }).catch(() => undefined);
  return result ? Buffer.from(result.stdout, "utf8") : undefined;
}

async function collectUiCulture() {
  if (process.platform !== "win32") return "";
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot)) return "";
  const executable = resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const metadata = await lstat(executable);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return "";
  } catch { return ""; }
  const result = await runBoundedProcess(executable, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Globalization.CultureInfo]::CurrentUICulture.Name",
  ], {
    environment: { SystemRoot: resolve(systemRoot), WINDIR: resolve(systemRoot) },
    timeoutMs: 10_000,
    maxStdoutBytes: 256,
  }).catch(() => undefined);
  return result?.stdout.trim() ?? "";
}

async function canonicalUserProfileBasename(value) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/u.test(value)) return "";
  try {
    const metadata = await lstat(value);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return "";
    return basename(await realpath(value));
  } catch { return ""; }
}

async function createFixture(candidate) {
  const requestedRoot = await mkdtemp(join(tmpdir(), FIXTURE_PREFIX));
  runState.fixtureCreated = true;
  const root = await realpath(requestedRoot);
  const requested = {
    dataDirectory: join(root, "host-data"),
    workspaceDirectory: join(root, "workspace"),
    userDataDirectory: join(root, "electron-user-data"),
    appDataDirectory: join(root, "app-data"),
    localAppDataDirectory: join(root, "local-app-data"),
    temporaryDirectory: join(root, "temporary"),
  };
  await Promise.all(Object.values(requested).map((directory) => mkdir(directory, { recursive: false, mode: 0o700 })));
  const canonical = Object.fromEntries(await Promise.all(Object.entries(requested).map(async ([key, value]) => [key, await realpath(value)])));
  for (const directory of Object.values(canonical)) {
    if (!pathWithin(root, directory)) fail("fixture", "FIXTURE_INVALID");
  }
  const wrapperPath = join(canonical.temporaryDirectory, "owned-hostd-wrapper.cjs");
  const daemonAuditPath = join(canonical.temporaryDirectory, "daemon-audit.mjs");
  await Promise.all([
    writeFile(wrapperPath, hostdOwnedWrapperSource(), { encoding: "utf8", mode: 0o600, flag: "wx" }),
    writeFile(daemonAuditPath, DAEMON_AUDIT_HELPER_SOURCE, { encoding: "utf8", mode: 0o600, flag: "wx" }),
  ]);

  let hostdModule;
  try {
    const installedRequire = createRequire(pathToFileURL(candidate.installedHostd));
    hostdModule = installedRequire(candidate.installedHostd);
  } catch {
    fail("fixture", "FIXTURE_INVALID");
  }
  if (
    typeof hostdModule?.runHostdCli !== "function" ||
    typeof hostdModule?.resolvePrimeAgentRuntimeDirectory !== "function" ||
    typeof hostdModule?.HostScopedPrimeAgentAuthSecurity !== "function"
  ) fail("fixture", "FIXTURE_INVALID");
  const custody = await createPrimeAgentSmokeCustody({
    hostDataRoot: canonical.dataDirectory,
    hostdModule,
    platform: process.platform,
    environment: process.env,
  });
  runState.custody = custody;
  try { await custody.assertInitiallyAbsent(); }
  catch { fail("fixture", "CUSTODY_PRECONDITION_FAILED"); }
  const hostEndpoint = localHostEndpoint(canonical.dataDirectory);
  return Object.freeze({
    root,
    ...canonical,
    wrapperPath,
    daemonAuditPath,
    hostEndpoint,
    custody,
  });
}

function isolatedEnvironments(fixture) {
  const inherited = credentialStrippedEnvironment(process.env);
  if (inherited.strippedCredentialVariableCount !== 0) fail("admission", "CREDENTIAL_ENVIRONMENT_FORBIDDEN");
  const base = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "SystemDrive",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "HOMEDRIVE",
    "HOMEPATH",
    "COMSPEC",
    "PATH",
    "PATHEXT",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "ProgramData",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
  ]) {
    const matches = Object.entries(inherited.environment).filter(([key]) => key.toLowerCase() === name.toLowerCase());
    if (matches.length > 1) fail("fixture", "FIXTURE_INVALID");
    const value = matches[0]?.[1];
    if (typeof value === "string" && value.length > 0 && value.length <= 32_767 && !/[\0\r\n]/u.test(value)) base[name] = value;
  }
  base.PRIME_AGENT_DATA_DIR = fixture.dataDirectory;
  base.APPDATA = fixture.appDataDirectory;
  base.LOCALAPPDATA = fixture.localAppDataDirectory;
  base.TEMP = fixture.temporaryDirectory;
  base.TMP = fixture.temporaryDirectory;
  const desktop = Object.freeze({ ...base });
  const hostNode = credentialStrippedEnvironment(base, { electronRunAsNode: false, packageSmoke: true });
  return Object.freeze({ desktop, hostd: hostNode.environment });
}

async function startOwnedHostd(candidate, fixture, environment) {
  const child = spawn(candidate.installedHostNode, [
    fixture.wrapperPath,
    candidate.installedHostd,
    "serve",
    "--socket",
    fixture.hostEndpoint,
    "--data-dir",
    fixture.dataDirectory,
    "--runtime-seed",
    candidate.installedRuntimeSeed,
    "--browser-executable",
    candidate.installedBrowserExecutable,
  ], {
    cwd: candidate.installedRoot,
    detached: false,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "ignore", "pipe"],
    env: environment,
  });
  // Arm failure cleanup before awaiting the spawn acknowledgement: a child
  // can exist even if a later stream/identity validation fails.
  runState.hostd = child;
  runState.hostdStarted = true;
  child.stderrTail = Buffer.alloc(0);
  child.stderr?.on("data", (chunk) => {
    child.stderrTail = Buffer.concat([child.stderrTail, Buffer.from(chunk)]).subarray(-64 * 1024);
  });
  child.stderr?.on("error", () => undefined);
  await onceSpawned(child, "hostd_start", "HOSTD_UNAVAILABLE");
  if (!child.stdin?.writable || !Number.isSafeInteger(child.pid)) fail("hostd_start", "HOSTD_UNAVAILABLE");
  return child;
}

async function waitForHostReady(child, endpoint, expectCommandCapability) {
  const deadline = Date.now() + READY_DEADLINE_MS;
  let health;
  while (Date.now() < deadline) {
    assertChildAlive(child, "hostd_start", "HOSTD_UNAVAILABLE");
    try {
      health = (await requestHost(endpoint, "health.get", {}, HOST_REQUEST_DEADLINE_MS)).result;
      const capabilities = Array.isArray(health?.capabilities) ? health.capabilities : [];
      if (
        health?.protocolVersion === 1 &&
        health.serviceState === "ready" &&
        health.runtimeIntegrity?.status === "ready" &&
        capabilities.includes("resident_lifecycle_v1") &&
        capabilities.includes("runtime_model_catalog_v1") &&
        capabilities.includes("runtime_oauth_v1") &&
        capabilities.includes("prime_agent_commands_v2") === expectCommandCapability
      ) return health;
      if (["failed", "unavailable"].includes(health?.runtimeIntegrity?.status)) fail("hostd_start", "HOSTD_UNAVAILABLE");
    } catch (error) {
      if (error instanceof ProviderE2eContractError) throw error;
    }
    await delay(100);
  }
  fail("hostd_start", "HOSTD_UNAVAILABLE");
}

function exactHostId(health) {
  const hostId = health?.host?.hostId;
  if (typeof hostId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(hostId)) {
    fail("hostd_start", "HOSTD_UNAVAILABLE");
  }
  return hostId;
}

function assertSameRuntimeIdentity(left, right) {
  const durable = (value) => ({
    contractVersion: value?.contractVersion,
    status: value?.status,
    assurance: value?.assurance,
    target: value?.target,
    installed: value?.installed,
  });
  if (JSON.stringify(durable(left)) !== JSON.stringify(durable(right))) fail("restart", "RESTART_NOT_PROVEN");
}

function assertProvisionCommitted(status, request) {
  if (
    status?.version !== 1 ||
    status.kind !== "provision" ||
    status.phase !== "committed" ||
    status.operationId !== request.operationId ||
    status.expectedHostId !== request.expectedHostId ||
    status.projectId !== request.projectId ||
    status.workspaceId !== request.workspaceId ||
    status.threadId !== request.threadId ||
    status.executionGenerationId !== request.executionGenerationId
  ) fail("provision", "PROVISION_NOT_PROVEN");
}

async function readHostSnapshot(endpoint) {
  return (await requestHost(
    endpoint,
    "thread.snapshot",
    { threadId: THREAD_ID },
    HOST_REQUEST_DEADLINE_MS,
  )).result;
}

function assertExactResidentFixture(snapshot, hostId) {
  if (
    snapshot?.thread?.threadId !== THREAD_ID ||
    snapshot.thread.projectIdentity !== PROJECT_ID ||
    snapshot.thread.currentLocation?.hostId !== hostId ||
    snapshot.thread.currentLocation?.projectId !== PROJECT_ID ||
    snapshot.thread.currentLocation?.workspaceId !== WORKSPACE_ID ||
    snapshot.thread.currentLocation?.executionGenerationId !== EXECUTION_GENERATION_ID ||
    snapshot.runtime?.runtime !== "prime_agent" ||
    snapshot.runtime?.residency !== "resident" ||
    typeof snapshot.runtime?.activeSessionId !== "string" ||
    typeof snapshot.runtime?.sessionId !== "string"
  ) fail("provision", "PROVISION_NOT_PROVEN");
}

async function waitForCatalog(endpoint, hostId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const catalog = (await requestHost(
        endpoint,
        "runtime.model_catalog",
        { expectedHostId: hostId },
        LIFECYCLE_REQUEST_DEADLINE_MS,
      )).result;
      const result = predicate(catalog);
      if (result) return result;
    } catch (error) {
      if (error instanceof ProviderE2eContractError) throw error;
    }
    await delay(500);
  }
  return undefined;
}

async function resolveInstalledRuntimeRoot(fixture, candidate, runtimeIntegrity) {
  const pointerPath = join(fixture.dataDirectory, "runtime", "current.json");
  const pointer = parseBoundedJson(await readFile(pointerPath), 64 * 1024, "hostd_start");
  const expected = {
    schemaVersion: 1,
    assurance: candidate.attestation.assurance,
    runtime: "prime-agent",
    releaseVersion: candidate.attestation.runtime.releaseVersion,
    runtimeBuildId: candidate.attestation.runtime.runtimeBuildId,
    platform: candidate.attestation.runtime.platform,
    arch: candidate.attestation.runtime.arch,
    manifestSha256: candidate.attestation.manifest.sha256,
    treeSha256: candidate.attestation.tree.sha256,
    filesSha256: candidate.attestation.tree.filesSha256,
  };
  if (JSON.stringify(pointer) !== JSON.stringify(expected) || JSON.stringify(pointer) !== JSON.stringify({
    schemaVersion: 1,
    assurance: runtimeIntegrity?.assurance,
    ...runtimeIntegrity?.target,
  })) fail("hostd_start", "HOSTD_UNAVAILABLE");
  const manifest = resolve(fixture.dataDirectory, "runtime", ...candidate.attestation.manifest.relativePath.split("/"));
  if (!pathWithin(join(fixture.dataDirectory, "runtime"), manifest)) fail("hostd_start", "HOSTD_UNAVAILABLE");
  const bytes = await readFile(manifest);
  if (createHash("sha256").update(bytes).digest("hex") !== candidate.attestation.manifest.sha256) {
    fail("hostd_start", "HOSTD_UNAVAILABLE");
  }
  return dirname(manifest);
}

function localHostEndpoint(directory) {
  const digest = createHash("sha256").update(resolve(directory).toLowerCase()).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\prime-agent-hostd-${digest}`;
}

function residentDaemonEndpoint(directory) {
  const digest = createHash("sha256").update(resolve(directory).toLowerCase()).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\prime-continuim-resident-${digest}`;
}

function hostdOwnedWrapperSource() {
  return [
    '"use strict";',
    "const [hostdPath, ...hostdArguments] = process.argv.slice(2);",
    'if (!hostdPath) throw new Error("missing installed hostd path");',
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
    ").catch(() => { terminal = true; process.exitCode = 1; process.stdin.destroy(); });",
    "",
  ].join("\n");
}

async function startInstalledDesktop(candidate, fixture, environment) {
  const child = spawn(candidate.installedExecutable, [
    "--remote-debugging-pipe",
    `--user-data-dir=${fixture.userDataDirectory}`,
    "--disable-gpu",
  ], {
    cwd: candidate.installedRoot,
    detached: false,
    shell: false,
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    env: environment,
  });
  // Arm exact-window cleanup before any post-spawn validation can reject.
  runState.desktop = child;
  runState.desktopStarted = true;
  child.primeContinuimTemporaryDirectory = fixture.temporaryDirectory;
  discardOutput(child.stdout);
  discardOutput(child.stderr);
  await onceSpawned(child, "desktop_start", "DESKTOP_UNAVAILABLE");
  if (!child.stdio[3]?.writable || !child.stdio[4]?.readable || !Number.isSafeInteger(child.pid)) {
    fail("desktop_start", "DESKTOP_UNAVAILABLE");
  }
  return Object.assign(child, { cdp: new CdpConnection(child.stdio[3], child.stdio[4]) });
}

async function attachWorkbench(desktop, exactRendererUrl) {
  const cdp = desktop.cdp;
  await cdp.request("Browser.getVersion", {}, undefined, 30_000);
  const deadline = Date.now() + RENDERER_READY_DEADLINE_MS;
  let target;
  while (Date.now() < deadline) {
    const result = await cdp.request("Target.getTargets");
    const pages = Array.isArray(result.targetInfos) ? result.targetInfos.filter((candidate) => candidate?.type === "page") : [];
    if (pages.length === 1 && pages[0]?.url === exactRendererUrl && pages[0]?.title === "Prime Continuim") {
      target = pages[0];
      break;
    }
    await delay(100);
  }
  if (!target?.targetId) fail("renderer", "RENDERER_UNAVAILABLE");
  const attached = await cdp.request("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  if (typeof attached.sessionId !== "string") fail("renderer", "CDP_PROTOCOL_INVALID");
  const sessionId = attached.sessionId;
  const contextEvent = cdp.waitForEvent(
    "Runtime.executionContextCreated",
    (event) => event?.context?.auxData?.isDefault === true,
    sessionId,
    30_000,
  );
  await cdp.request("Runtime.enable", {}, sessionId);
  await cdp.request("DOM.enable", {}, sessionId);
  await cdp.request("Page.enable", {}, sessionId);
  await cdp.request("Accessibility.enable", {}, sessionId);
  const event = await contextEvent;
  if (!Number.isSafeInteger(event.context.id)) fail("renderer", "CDP_PROTOCOL_INVALID");
  return new WorkbenchController(cdp, sessionId, event.context.id);
}

class WorkbenchController {
  constructor(cdp, sessionId, executionContextId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.executionContextId = executionContextId;
  }

  async requestSnapshot(input) {
    const response = await this.cdp.request("Runtime.callFunctionOn", {
      functionDeclaration: SNAPSHOT_READ_FUNCTION,
      executionContextId: this.executionContextId,
      arguments: [{ value: input }],
      awaitPromise: true,
      returnByValue: true,
    }, this.sessionId);
    const result = bridgeValue(response);
    if (!result || result.ok !== true || !("value" in result) || "error" in result) {
      fail(currentStage, stageCode(currentStage));
    }
    return result.value;
  }

  async waitForSnapshot(input, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const snapshot = await this.requestSnapshot(input);
        const value = predicate(snapshot);
        if (value) return value === true ? snapshot : value;
      } catch (error) {
        if (error instanceof ProviderE2eContractError) throw error;
      }
      await delay(75);
    }
    fail(currentStage, stageCode(currentStage));
  }

  async clickVisible(selector, timeoutMs) {
    const nodeId = await this.waitForVisibleNode(selector, timeoutMs);
    await this.clickNode(nodeId);
  }

  async clickVisibleText(selector, exactText, timeoutMs) {
    const nodeId = await this.waitForVisibleTextNode(selector, exactText, timeoutMs);
    await this.clickNode(nodeId);
  }

  async clickExactVisibleModelRow(expected, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const providerNodes = await this.queryNodes(OPENAI_PROVIDER_SELECTOR);
      if (providerNodes.length > 1) fail("model_selection", "MODEL_NOT_SELECTED");
      if (providerNodes.length === 1) {
        const providerAttributes = await this.nodeAttributes(providerNodes[0]);
        if (
          providerAttributes.get("data-provider-id") === expected?.providerId &&
          providerAttributes.get("aria-pressed") === "true" &&
          await this.visibleNodePoint(providerNodes[0], true)
        ) {
          const candidates = [];
          for (const rowNodeId of await this.queryNodes(".model-row")) {
            if (!(await this.visibleNodePoint(rowNodeId, true))) continue;
            const metadata = parseVisibleModelRowMetadata(await this.nodeOuterHtml(rowNodeId));
            if (!metadata) fail("model_selection", "MODEL_NOT_SELECTED");
            const visibleActions = [];
            for (const actionNodeId of await this.queryNodesWithin(rowNodeId, MODEL_SELECT_SELECTOR)) {
              if (!(await this.nodeDisabled(actionNodeId)) && await this.visibleNodePoint(actionNodeId, true)) {
                visibleActions.push(actionNodeId);
              }
            }
            candidates.push({
              providerId: expected.providerId,
              ...metadata,
              visibleSelectActionCount: visibleActions.length,
              actionNodeId: visibleActions[0],
            });
          }
          const exactIndex = uniqueExactVisibleModelRowIndex(candidates, expected);
          if (exactIndex !== undefined) {
            await this.clickNode(candidates[exactIndex].actionNodeId);
            return;
          }
        }
      }
      await delay(50);
    }
    fail("model_selection", "MODEL_NOT_SELECTED");
  }

  async clickNode(nodeId) {
    const point = await this.visibleNodePoint(nodeId, true);
    if (!point) fail("renderer", "RENDERER_UNAVAILABLE");
    await this.cdp.request("Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1,
    }, this.sessionId);
    await this.cdp.request("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1,
    }, this.sessionId);
  }

  async typeVisible(selector, value, timeoutMs) {
    if (typeof value !== "string" || value.length < 1 || value.length > 64 * 1024) fail(currentStage, stageCode(currentStage));
    const nodeId = await this.waitForVisibleNode(selector, timeoutMs);
    await this.clickNode(nodeId);
    await this.cdp.request("Input.insertText", { text: value }, this.sessionId);
  }

  async waitForNodeText(selector, exactText, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const nodeId = await this.waitForVisibleNode(selector, 500);
        if (await this.nodeText(nodeId) === exactText) return true;
      } catch (error) {
        if (error instanceof ProviderE2eContractError && error.code === "CDP_PROTOCOL_INVALID") throw error;
      }
      await delay(50);
    }
    fail("renderer", "RENDERER_UNAVAILABLE");
  }

  async hasVisibleNode(selector) {
    try {
      const nodes = await this.queryNodes(selector);
      for (const nodeId of nodes) if (await this.visibleNodePoint(nodeId)) return true;
      return false;
    } catch { return false; }
  }

  async waitForNoVisibleNode(selector, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.hasVisibleNode(selector))) return true;
      await delay(50);
    }
    fail("renderer", "RENDERER_UNAVAILABLE");
  }

  async latestVisibleNodeText(selector) {
    const nodes = await this.queryNodes(selector);
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      if (await this.visibleNodePoint(nodes[index], true)) return await this.nodeText(nodes[index]);
    }
    return undefined;
  }

  async waitForVisibleNode(selector, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const nodes = await this.queryNodes(selector);
        if (nodes.length > 1 && [PRIMARY_ACTION_SELECTOR, COMPOSER_SELECTOR].includes(selector)) {
          fail("renderer", "RENDERER_UNAVAILABLE");
        }
        for (const nodeId of nodes) {
          if (await this.nodeDisabled(nodeId)) continue;
          if (await this.visibleNodePoint(nodeId, true)) return nodeId;
        }
      } catch (error) {
        if (error instanceof ProviderE2eContractError && error.code === "CDP_PROTOCOL_INVALID") throw error;
      }
      await delay(50);
    }
    fail("renderer", "RENDERER_UNAVAILABLE");
  }

  async waitForVisibleTextNode(selector, exactText, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const nodes = await this.queryNodes(selector);
        const matches = [];
        for (const nodeId of nodes) {
          if (await this.nodeDisabled(nodeId)) continue;
          if (await this.nodeText(nodeId) !== exactText) continue;
          if (await this.visibleNodePoint(nodeId, true)) matches.push(nodeId);
        }
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) fail("renderer", "RENDERER_UNAVAILABLE");
      } catch (error) {
        if (error instanceof ProviderE2eContractError && error.code === "CDP_PROTOCOL_INVALID") throw error;
      }
      await delay(50);
    }
    fail("renderer", "RENDERER_UNAVAILABLE");
  }

  async nodeText(nodeId) {
    return htmlText(await this.nodeOuterHtml(nodeId));
  }

  async nodeDisabled(nodeId) {
    return (await this.nodeAttributes(nodeId)).has("disabled");
  }

  async nodeOuterHtml(nodeId) {
    const response = await this.cdp.request("DOM.getOuterHTML", { nodeId }, this.sessionId);
    if (typeof response.outerHTML !== "string" || response.outerHTML.length > 256 * 1024) {
      fail("renderer", "CDP_PROTOCOL_INVALID");
    }
    return response.outerHTML;
  }

  async nodeAttributes(nodeId) {
    const response = await this.cdp.request("DOM.getAttributes", { nodeId }, this.sessionId);
    if (!Array.isArray(response.attributes) || response.attributes.length % 2 !== 0) {
      fail("renderer", "CDP_PROTOCOL_INVALID");
    }
    const attributes = new Map();
    for (let index = 0; index < response.attributes.length; index += 2) {
      const name = response.attributes[index];
      const value = response.attributes[index + 1];
      if (typeof name !== "string" || typeof value !== "string" || attributes.has(name)) {
        fail("renderer", "CDP_PROTOCOL_INVALID");
      }
      attributes.set(name, value);
    }
    return attributes;
  }

  async queryNodes(selector) {
    const document = await this.cdp.request("DOM.getDocument", { depth: 1, pierce: false }, this.sessionId);
    const root = document?.root?.nodeId;
    if (!Number.isSafeInteger(root)) fail("renderer", "CDP_PROTOCOL_INVALID");
    const result = await this.cdp.request("DOM.querySelectorAll", { nodeId: root, selector }, this.sessionId);
    if (!Array.isArray(result.nodeIds) || result.nodeIds.some((nodeId) => !Number.isSafeInteger(nodeId) || nodeId <= 0)) {
      fail("renderer", "CDP_PROTOCOL_INVALID");
    }
    return result.nodeIds;
  }

  async queryNodesWithin(nodeId, selector) {
    if (!Number.isSafeInteger(nodeId) || nodeId <= 0) fail("renderer", "CDP_PROTOCOL_INVALID");
    const result = await this.cdp.request("DOM.querySelectorAll", { nodeId, selector }, this.sessionId);
    if (!Array.isArray(result.nodeIds) || result.nodeIds.some((candidate) => !Number.isSafeInteger(candidate) || candidate <= 0)) {
      fail("renderer", "CDP_PROTOCOL_INVALID");
    }
    return result.nodeIds;
  }

  async visibleNodePoint(nodeId, requireViewport = false) {
    const [box, metrics, described, accessibility] = await Promise.all([
      this.cdp.request("DOM.getBoxModel", { nodeId }, this.sessionId),
      this.cdp.request("Page.getLayoutMetrics", {}, this.sessionId),
      this.cdp.request("DOM.describeNode", { nodeId, depth: 0, pierce: false }, this.sessionId),
      this.cdp.request("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false }, this.sessionId),
    ]);
    const quad = box?.model?.border;
    const viewport = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport;
    const backendNodeId = described?.node?.backendNodeId;
    if (
      !Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite) ||
      !Number.isFinite(viewport?.clientWidth) || !Number.isFinite(viewport?.clientHeight) ||
      viewport.clientWidth <= 0 || viewport.clientHeight <= 0 ||
      !Number.isSafeInteger(backendNodeId) || !Array.isArray(accessibility?.nodes)
    ) fail("renderer", "CDP_PROTOCOL_INVALID");
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const x = xs.reduce((sum, value) => sum + value, 0) / 4;
    const y = ys.reduce((sum, value) => sum + value, 0) / 4;
    const exactAxNode = accessibility.nodes.find((node) => node?.backendDOMNodeId === backendNodeId);
    if (
      width <= 0 || height <= 0 ||
      (requireViewport && (x < 0 || y < 0 || x >= viewport.clientWidth || y >= viewport.clientHeight)) ||
      exactAxNode?.ignored !== false
    ) return undefined;
    return { x, y };
  }
}

class CdpConnection {
  constructor(writable, readable) {
    this.writable = writable;
    this.readable = readable;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Set();
    this.decoder = new NullDelimitedCdpDecoder();
    readable.on("data", (chunk) => this.onData(chunk));
    readable.once("close", () => this.onClose());
    readable.once("error", () => this.onClose());
    writable.once("error", () => this.onClose());
  }

  request(method, params = {}, sessionId, timeoutMs = 15_000) {
    const id = this.nextId++;
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new ProviderE2eContractError("renderer", "CDP_PROTOCOL_INVALID"));
      }, timeoutMs);
      this.pending.set(id, { resolvePromise, rejectPromise, timer });
      this.writable.write(encodeCdpMessage(message), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.rejectPromise(new ProviderE2eContractError("renderer", "CDP_PROTOCOL_INVALID"));
      });
    });
  }

  waitForEvent(method, predicate, sessionId, timeoutMs) {
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = { method, predicate, sessionId, resolvePromise, rejectPromise, timer: undefined };
      waiter.timer = setTimeout(() => {
        this.eventWaiters.delete(waiter);
        rejectPromise(new ProviderE2eContractError("renderer", "CDP_PROTOCOL_INVALID"));
      }, timeoutMs);
      this.eventWaiters.add(waiter);
    });
  }

  onData(chunk) {
    let messages;
    try { messages = this.decoder.push(chunk); }
    catch { this.onClose(); return; }
    for (const message of messages) {
      if (Number.isSafeInteger(message.id)) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.rejectPromise(new ProviderE2eContractError("renderer", "CDP_PROTOCOL_INVALID"));
        else pending.resolvePromise(message.result ?? {});
        continue;
      }
      if (typeof message.method !== "string") continue;
      for (const waiter of [...this.eventWaiters]) {
        if (waiter.method !== message.method || waiter.sessionId !== message.sessionId) continue;
        let matches = false;
        try { matches = waiter.predicate(message.params); } catch { matches = false; }
        if (!matches) continue;
        clearTimeout(waiter.timer);
        this.eventWaiters.delete(waiter);
        waiter.resolvePromise(message.params);
      }
    }
  }

  onClose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.rejectPromise(new ProviderE2eContractError("renderer", "CDP_PROTOCOL_INVALID"));
    }
    this.pending.clear();
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.rejectPromise(new ProviderE2eContractError("renderer", "CDP_PROTOCOL_INVALID"));
    }
    this.eventWaiters.clear();
  }
}

function bridgeValue(response) {
  if (response?.exceptionDetails || response?.result?.type === "undefined" || !("value" in (response?.result ?? {}))) {
    fail("renderer", "CDP_PROTOCOL_INVALID");
  }
  return response.result.value;
}

function htmlText(value) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&hellip;", "…")
    .replaceAll("&#x2026;", "…")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/\s+/gu, " ")
    .trim();
}

async function observeVisiblePromptStream(controller) {
  const deadline = Date.now() + TURN_DEADLINE_MS;
  const observations = [];
  let activeProjection;
  while (Date.now() < deadline) {
    const snapshot = await controller.requestSnapshot({ threadId: THREAD_ID });
    const stream = snapshot?.inProgressStream;
    if (
      snapshot?.thread?.threadId === THREAD_ID &&
      snapshot?.thread?.currentLocation?.executionGenerationId === EXECUTION_GENERATION_ID &&
      snapshot?.thread?.status === "running" &&
      snapshot?.runtime?.runtime === "prime_agent" &&
      snapshot?.runtime?.residency === "resident" &&
      typeof stream?.blockId === "string" &&
      typeof stream?.text === "string" &&
      stream.text.length > 0
    ) {
      activeProjection ??= snapshot;
      try {
        const visibleAssistantText = await controller.latestVisibleNodeText(VISIBLE_ASSISTANT_BODY_SELECTOR);
        if (visibleAssistantText) {
          observations.push(Object.freeze({
            blockId: stream.blockId,
            streamText: stream.text,
            visibleAssistantText,
          }));
        }
      } catch (error) {
        if (error instanceof ProviderE2eContractError && error.code === "CDP_PROTOCOL_INVALID") throw error;
      }
      if (hasVisibleAssistantStreamEvidence(observations)) {
        return Object.freeze({ activeProjection, renderedStreamChanged: true });
      }
    }
    await delay(75);
  }
  fail("prompt_stream", activeProjection ? "STREAMING_NOT_OBSERVED" : "PROMPT_NOT_ADMITTED");
}

async function observeStableRestart(controller, initialSnapshot) {
  const observations = [{ snapshot: initialSnapshot, observedAtMonotonicMs: Math.floor(performance.now()) }];
  while (observations.length < MIN_POST_RESTART_OBSERVATIONS) {
    await delay(POST_RESTART_OBSERVATION_INTERVAL_MS + 250);
    const snapshot = await controller.requestSnapshot({ threadId: THREAD_ID });
    observations.push({ snapshot, observedAtMonotonicMs: Math.floor(performance.now()) });
  }
  return observations;
}

async function inspectStoppedCommandState(fixture, expectedPrompt, expectedProjection) {
  const records = await readCommandJournal(fixture);
  const relevant = records.filter((record) =>
    record?.threadId === THREAD_ID && ["prompt", "abort"].includes(record.commandKind));
  const received = relevant.filter((record) => record.status === "received" && record.envelope);
  const prompts = received.filter((record) => record.commandKind === "prompt");
  const aborts = received.filter((record) => record.commandKind === "abort");
  if (
    prompts.length !== 1 || aborts.length !== 1 ||
    prompts[0].envelope?.command?.text !== expectedPrompt ||
    aborts[0].envelope?.command?.kind !== "abort"
  ) fail("stop", "STOP_NOT_PROVEN");
  const promptEnvelope = deepFreeze(prompts[0].envelope);
  const abortEnvelope = deepFreeze(aborts[0].envelope);
  for (const envelope of [promptEnvelope, abortEnvelope]) {
    const terminal = relevant.filter((record) =>
      record.commandId === envelope.commandId && record.status === "completed");
    if (terminal.length < 1) fail("stop", "STOP_NOT_PROVEN");
  }
  const receipts = await Promise.all([
    readExactCommandReceipt(fixture, promptEnvelope),
    readExactCommandReceipt(fixture, abortEnvelope),
  ]);
  const storedProjection = await readExactStoredProjection(fixture);
  if (!isDeepStrictEqual(storedProjection, expectedProjection)) fail("stop", "STOP_NOT_PROVEN");
  const outboxEntryCount = await readOutboxEntryCount(fixture);
  const dispatchAttemptCount = await readDispatchAttemptCount(fixture);
  if (outboxEntryCount !== 0 || dispatchAttemptCount !== 0) fail("stop", "STOP_NOT_PROVEN");
  return Object.freeze({
    promptEnvelope,
    abortEnvelope,
    receipts: Object.freeze(receipts),
    journalIds: await readRelevantJournalIds(fixture, records),
    outboxEntryCount,
    dispatchAttemptCount,
  });
}

async function inspectReplayState(fixture) {
  const records = await readCommandJournal(fixture);
  return Object.freeze({
    journalIds: await readRelevantJournalIds(fixture, records),
    outboxEntryCount: await readOutboxEntryCount(fixture),
    dispatchAttemptCount: await readDispatchAttemptCount(fixture),
  });
}

async function readExactCommandReceipt(fixture, envelope) {
  const path = join(
    fixture.dataDirectory,
    "receipts",
    `${durableStorageKey(envelope.deviceId, envelope.commandId)}.json`,
  );
  const receipt = parseBoundedJson(await readFile(path), 64 * 1024, "stop");
  const keys = Object.keys(receipt).sort();
  if (
    ![7, 8, 9, 10].includes(keys.length) ||
    receipt.protocolVersion !== 1 ||
    typeof receipt.receiptId !== "string" ||
    receipt.deviceId !== envelope.deviceId ||
    receipt.commandId !== envelope.commandId ||
    receipt.threadId !== envelope.threadId ||
    receipt.status !== "completed" ||
    receipt.executionGenerationId !== envelope.expectedExecutionGenerationId ||
    typeof receipt.receivedAt !== "string" || !Number.isFinite(Date.parse(receipt.receivedAt)) ||
    typeof receipt.updatedAt !== "string" || !Number.isFinite(Date.parse(receipt.updatedAt)) ||
    Date.parse(receipt.updatedAt) < Date.parse(receipt.receivedAt) ||
    receipt.queuePosition !== undefined || receipt.error !== undefined
  ) fail("stop", "STOP_NOT_PROVEN");
  return deepFreeze(receipt);
}

async function readExactStoredProjection(fixture) {
  const path = join(
    fixture.dataDirectory,
    "snapshots",
    `${durableStorageKey(THREAD_ID)}.json`,
  );
  return deepFreeze(parseBoundedJson(await readFile(path), MAX_FRAME_BYTES, "stop"));
}

async function readRelevantJournalIds(fixture, commandRecords) {
  const commandIds = commandRecords
    .filter((record) => record.threadId === THREAD_ID)
    .map((record) => `command:${record.journalId}`);
  const eventPath = join(fixture.dataDirectory, "journals", "events.jsonl");
  const bytes = await readFile(eventPath);
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_FRAME_BYTES) fail("no_replay", "REPLAY_NOT_DISPROVEN");
  const lines = bytes.toString("utf8").split("\n").filter(Boolean);
  if (lines.length > MAX_JOURNAL_RECORDS) fail("no_replay", "REPLAY_NOT_DISPROVEN");
  const eventIds = [];
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); }
    catch { fail("no_replay", "REPLAY_NOT_DISPROVEN"); }
    if (record?.threadId !== THREAD_ID) continue;
    if (record.version !== 1 || typeof record.eventId !== "string") fail("no_replay", "REPLAY_NOT_DISPROVEN");
    eventIds.push(`event:${record.eventId}`);
  }
  const ids = [...commandIds, ...eventIds];
  if (ids.length !== new Set(ids).size) fail("no_replay", "REPLAY_NOT_DISPROVEN");
  return Object.freeze(ids);
}

async function readCommandJournal(fixture) {
  const path = join(fixture.dataDirectory, "journals", "commands.jsonl");
  const bytes = await readFile(path);
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_FRAME_BYTES) fail("no_replay", "REPLAY_NOT_DISPROVEN");
  const lines = bytes.toString("utf8").split("\n").filter(Boolean);
  if (lines.length > MAX_JOURNAL_RECORDS) fail("no_replay", "REPLAY_NOT_DISPROVEN");
  const ids = new Set();
  return lines.map((line) => {
    let record;
    try { record = JSON.parse(line); }
    catch { fail("no_replay", "REPLAY_NOT_DISPROVEN"); }
    if (
      record?.version !== 1 ||
      typeof record.journalId !== "string" ||
      ids.has(record.journalId) ||
      typeof record.commandId !== "string" ||
      typeof record.threadId !== "string" ||
      typeof record.commandKind !== "string" ||
      typeof record.status !== "string"
    ) fail("no_replay", "REPLAY_NOT_DISPROVEN");
    ids.add(record.journalId);
    return record;
  });
}

async function readOutboxEntryCount(fixture) {
  const path = join(fixture.userDataDirectory, "control", "command-outbox.json");
  let bytes;
  try { bytes = await readFile(path); }
  catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  const value = parseBoundedJson(bytes, 1024 * 1024, "no_replay");
  if (!Array.isArray(value) || value.length > 1_024) fail("no_replay", "REPLAY_NOT_DISPROVEN");
  return value.length;
}

async function readDispatchAttemptCount(fixture) {
  const directory = join(fixture.dataDirectory, "resident-dispatch-attempts");
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 1_024 || entries.some((entry) => !entry.isFile())) fail("no_replay", "REPLAY_NOT_DISPROVEN");
  return entries.length;
}

async function reconcileExactCommands(endpoint, hostId, ...commands) {
  const receipts = [];
  for (const command of commands) {
    const response = await requestHost(endpoint, "command.reconcile", {
      expectedHostId: hostId,
      commands: [command],
    }, HOST_REQUEST_DEADLINE_MS);
    if (
      !Array.isArray(response.result?.receipts) || response.result.receipts.length !== 1 ||
      !Array.isArray(response.result?.unknown) || response.result.unknown.length !== 0 ||
      response.result.receipts[0]?.commandId !== command.commandId ||
      response.result.receipts[0]?.status !== "completed"
    ) fail("no_replay", "REPLAY_NOT_DISPROVEN");
    receipts.push(response.result.receipts[0]);
  }
  return Object.freeze(receipts);
}

async function assertRetiredBinding(fixture) {
  const file = parseBoundedJson(
    await readFile(join(fixture.dataDirectory, "resident-session-bindings.json")),
    1024 * 1024,
    "end",
  );
  const lineage = file?.records?.filter((record) =>
    record?.binding?.threadId === THREAD_ID &&
    record.binding.executionGenerationId === EXECUTION_GENERATION_ID);
  if (
    file?.version !== 1 || !Array.isArray(file.records) || lineage?.length !== 1 ||
    lineage[0]?.state !== "completed"
  ) fail("end", "END_NOT_PROVEN");
}

async function inspectResidentDaemon(context, action) {
  if (!context || !["list", "shutdown"].includes(action)) fail("cleanup", "CLEANUP_UNCONFIRMED");
  const daemonClientPath = join(
    context.runtimeRoot,
    "node_modules",
    "prime-agent",
    "dist",
    "modes",
    "daemon",
    "daemon-client.js",
  );
  if (!pathWithin(context.runtimeRoot, daemonClientPath)) fail("cleanup", "CLEANUP_UNCONFIRMED");
  const result = await runBoundedProcess(context.executable, [
    context.helperPath,
    pathToFileURL(daemonClientPath).href,
    context.endpoint,
    action,
  ], {
    environment: context.environment,
    timeoutMs: HELPER_DEADLINE_MS,
    maxStdoutBytes: 16 * 1024,
  });
  return parseBoundedJson(Buffer.from(result.stdout, "utf8"), 16 * 1024, "cleanup");
}

async function stopOwnedHostd(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.stdin?.writable || child.stdin.destroyed) {
    fail("cleanup", "CLEANUP_UNCONFIRMED");
  }
  if (child.primeContinuimStopAttempted === true) fail("cleanup", "CLEANUP_UNCONFIRMED");
  child.primeContinuimStopAttempted = true;
  child.stdin.once("error", () => undefined);
  child.stdin.end("shutdown\n");
  const outcome = await waitForExit(child, 30_000);
  if (outcome.code !== 0 || outcome.signal !== null) fail("cleanup", "CLEANUP_UNCONFIRMED");
}

async function closeInstalledDesktopOrderly(desktop, { allowAlreadyExited = false } = {}) {
  if (!desktop || !Number.isSafeInteger(desktop.pid)) fail("cleanup", "CLEANUP_UNCONFIRMED");
  if (desktop.exitCode !== null || desktop.signalCode !== null) {
    if (allowAlreadyExited && desktop.exitCode === 0 && desktop.signalCode === null) return;
    fail("cleanup", "CLEANUP_UNCONFIRMED");
  }
  if (desktop.primeContinuimCloseAttempted === true) fail("cleanup", "CLEANUP_UNCONFIRMED");
  desktop.primeContinuimCloseAttempted = true;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot)) fail("cleanup", "CLEANUP_UNCONFIRMED");
  const powershell = resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const temporaryDirectory = desktop.primeContinuimTemporaryDirectory;
  if (typeof temporaryDirectory !== "string" || !isAbsolute(temporaryDirectory) || /[\0\r\n]/u.test(temporaryDirectory)) {
    fail("cleanup", "CLEANUP_UNCONFIRMED");
  }
  try {
    const executableMetadata = lstatSync(powershell);
    const temporaryMetadata = lstatSync(temporaryDirectory);
    if (
      !executableMetadata.isFile() || executableMetadata.isSymbolicLink() ||
      !temporaryMetadata.isDirectory() || temporaryMetadata.isSymbolicLink() ||
      await realpath(temporaryDirectory) !== temporaryDirectory
    ) fail("cleanup", "CLEANUP_UNCONFIRMED");
  } catch (error) {
    if (error instanceof ProviderE2eContractError) throw error;
    fail("cleanup", "CLEANUP_UNCONFIRMED");
  }
  const helperSource = Buffer.from(UIA_CLOSE_HELPER_SOURCE, "utf8").toString("base64");
  const closeScript = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    "Add-Type -AssemblyName WindowsBase",
    `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${helperSource}'))`,
    "$references = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Rect].Assembly.Location, [System.Diagnostics.Process].Assembly.Location, [System.Threading.Tasks.Task].Assembly.Location) | Select-Object -Unique",
    "Add-Type -TypeDefinition $source -ReferencedAssemblies $references",
    "$result = [PrimeContinuimExactClose]::InvokeBounded([int]$env:PRIME_CONTINUIM_EXACT_CHILD_PID)",
    "exit $result",
  ].join("; ");
  const helper = spawn(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(closeScript, "utf16le").toString("base64"),
  ], {
    windowsHide: true,
    shell: false,
    stdio: "ignore",
    env: {
      SystemRoot: resolve(systemRoot),
      WINDIR: resolve(systemRoot),
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
      PRIME_CONTINUIM_EXACT_CHILD_PID: String(desktop.pid),
    },
  });
  const helperExit = await waitForHelperExit(helper, 20_000);
  const desktopExit = await waitForExit(desktop, 30_000);
  if (helperExit.code !== 0 || helperExit.signal !== null || desktopExit.code !== 0 || desktopExit.signal !== null) {
    fail("cleanup", "CLEANUP_UNCONFIRMED");
  }
}

async function boundedFailureCleanup() {
  let desktopClean = runState.desktop === undefined;
  let hostdClean = runState.hostd === undefined;
  let daemonClean = runState.daemonObserved !== true;
  if (runState.desktop) {
    if (runState.desktop.primeContinuimCloseAttempted === true) {
      abandonChildObservation(runState.desktop);
      runState.desktop = undefined;
      desktopClean = false;
    } else {
      try {
        await closeInstalledDesktopOrderly(runState.desktop, { allowAlreadyExited: true });
        runState.desktop = undefined;
        desktopClean = true;
      } catch {
        abandonChildObservation(runState.desktop);
        runState.desktop = undefined;
        desktopClean = false;
      }
    }
  }
  if (!desktopClean && runState.hostd) {
    abandonChildObservation(runState.hostd);
    runState.hostd = undefined;
    hostdClean = false;
  } else if (runState.hostd) {
    if (runState.hostd.primeContinuimStopAttempted === true) {
      abandonChildObservation(runState.hostd);
      runState.hostd = undefined;
      hostdClean = false;
    } else {
      try {
        await stopOwnedHostd(runState.hostd);
        runState.hostd = undefined;
        hostdClean = true;
      } catch {
        abandonChildObservation(runState.hostd);
        runState.hostd = undefined;
        hostdClean = false;
      }
    }
  }
  if (
    desktopClean && hostdClean && runState.daemonObserved && runState.daemonContext &&
    runState.daemonShutdownAttempted !== true
  ) {
    runState.daemonShutdownAttempted = true;
    try {
      const audit = await inspectResidentDaemon(runState.daemonContext, "shutdown");
      daemonClean = audit?.shutdownConfirmed === true && audit.endpointTerminated === true;
      if (daemonClean) runState.daemonObserved = false;
    } catch { daemonClean = false; }
  }
  const destructiveCleanupAllowed =
    desktopClean && hostdClean && daemonClean && runState.helperMayRemain !== true && runState.endOutcomeUncertain !== true;
  if (
    destructiveCleanupAllowed && runState.custodyObserved && runState.custody &&
    runState.custodyRemovalAttempted !== true
  ) {
    try {
      await runState.custody.captureExisting();
      runState.custodyRemovalAttempted = true;
      const cleanup = await runState.custody.removeAfterConfirmedShutdown({ confirmedCleanShutdown: true });
      if (cleanup?.removed !== true) throw new Error("custody removal was not confirmed");
      runState.custodyObserved = false;
    } catch { /* Fixture retention plus VM disposal is the only remaining authority. */ }
  }
  if (
    destructiveCleanupAllowed && !runState.custodyObserved && runState.fixtureCreated && runState.fixture &&
    runState.temporaryRootRemovalAttempted !== true
  ) {
    try {
      runState.temporaryRootRemovalAttempted = true;
      await removeIsolatedTemporaryRoot({
        root: runState.fixture.root,
        expectedPrefix: FIXTURE_PREFIX,
        confirmedCleanShutdown: true,
      });
      runState.fixtureCreated = false;
    } catch { /* Fixture retention plus VM disposal is the only remaining authority. */ }
  }
}

async function collectWindowsProcessIdentity(pid, temporaryDirectory) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail(currentStage, stageCode(currentStage));
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot)) fail(currentStage, stageCode(currentStage));
  const powershell = resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = await runBoundedProcess(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$p=Get-Process -Id ([int]$env:PRIME_CONTINUIM_PROCESS_ID) -ErrorAction Stop; '{0}:{1}' -f $p.Id,$p.StartTime.ToUniversalTime().ToFileTimeUtc()",
  ], {
    environment: {
      SystemRoot: resolve(systemRoot),
      WINDIR: resolve(systemRoot),
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
      PRIME_CONTINUIM_PROCESS_ID: String(pid),
    },
    timeoutMs: 10_000,
    maxStdoutBytes: 256,
  });
  const identity = result.stdout.trim();
  if (!/^\d+:\d{10,20}$/u.test(identity)) fail(currentStage, stageCode(currentStage));
  return identity;
}

async function requestHost(socketPath, method, requestPayload, timeoutMs) {
  const requestId = `prime-agent-provider-e2e-${randomUUID()}`;
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
    const timer = setTimeout(() => finish(new Error("bounded host request timed out")), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_FRAME_BYTES + 4) return finish(new Error("host response exceeded its bound"));
      if (buffer.byteLength < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length < 1 || length > MAX_FRAME_BYTES) return finish(new Error("host response frame is invalid"));
      if (buffer.byteLength < 4 + length) return;
      let response;
      try { response = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")); }
      catch { return finish(new Error("host response JSON is invalid")); }
      if (
        response?.protocolVersion !== 1 ||
        response?.requestId !== requestId ||
        response?.method !== method ||
        response.ok !== true
      ) {
        return finish(new Error("host response identity or result is invalid"));
      }
      finish(undefined, response);
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error("host closed before its bounded response"));
    });
  });
}

function runBoundedProcess(executable, argv, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, argv, {
      cwd: options.cwd,
      detached: false,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.environment,
    });
    let output = Buffer.alloc(0);
    let overflow = false;
    child.stdout?.on("data", (chunk) => {
      if (overflow) return;
      const bytes = Buffer.from(chunk);
      if (output.byteLength + bytes.byteLength > options.maxStdoutBytes) {
        overflow = true;
        output = Buffer.alloc(0);
        return;
      }
      output = Buffer.concat([output, bytes]);
    });
    child.stdout?.on("error", () => { overflow = true; });
    discardOutput(child.stderr);
    waitForExit(child, options.timeoutMs).then((outcome) => {
      if (outcome.code !== 0 || outcome.signal !== null || overflow) {
        rejectPromise(new ProviderE2eContractError(currentStage, stageCode(currentStage)));
        return;
      }
      resolvePromise({ stdout: output.toString("utf8") });
    }, () => {
      runState.helperMayRemain = true;
      abandonChildObservation(child);
      rejectPromise(new ProviderE2eContractError(currentStage, stageCode(currentStage)));
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const finish = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = (code, signal) => {
      finish();
      resolvePromise({ code, signal });
    };
    const onError = () => {
      finish();
      rejectPromise(new ProviderE2eContractError("cleanup", "CLEANUP_UNCONFIRMED"));
    };
    const timer = setTimeout(() => {
      finish();
      rejectPromise(new ProviderE2eContractError("cleanup", "CLEANUP_UNCONFIRMED"));
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function waitForHelperExit(child, timeoutMs) {
  return waitForExit(child, timeoutMs).catch((error) => {
    runState.helperMayRemain = true;
    abandonChildObservation(child);
    throw error;
  });
}

function onceSpawned(child, stage, code) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("spawn", resolvePromise);
    child.once("error", () => rejectPromise(new ProviderE2eContractError(stage, code)));
  });
}

function assertChildAlive(child, stage, code) {
  if (child.exitCode === null && child.signalCode === null) return;
  fail(stage, code);
}

function abandonChildObservation(child) {
  for (const stream of child?.stdio ?? []) {
    try { stream?.destroy?.(); } catch { /* Cleanup remains unconfirmed. */ }
  }
  try { child?.unref(); } catch { runState.helperMayRemain = true; }
}

function discardOutput(stream) {
  stream?.on("data", () => undefined);
  stream?.on("error", () => undefined);
}

function parseBoundedJson(bytes, maxBytes, stage) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 2 || bytes.byteLength > maxBytes) fail(stage, stageCode(stage));
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object") fail(stage, stageCode(stage));
    return value;
  } catch (error) {
    if (error instanceof ProviderE2eContractError) throw error;
    fail(stage, stageCode(stage));
  }
}

async function canonicalRegularFile(value) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/u.test(value)) fail("candidate", "CANDIDATE_INVALID");
  const metadata = await lstat(value);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail("candidate", "CANDIDATE_INVALID");
  return await realpath(value);
}

async function canonicalDirectory(value) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/u.test(value)) fail("candidate", "CANDIDATE_INVALID");
  const metadata = await lstat(value);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("candidate", "CANDIDATE_INVALID");
  return await realpath(value);
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function pathWithin(parent, child) {
  const fromParent = relative(resolve(parent), resolve(child));
  return fromParent !== "" && fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function durableStorageKey(...parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function stageCode(stage) {
  return ({
    admission: "INTERNAL_FAILURE",
    candidate: "CANDIDATE_INVALID",
    fixture: "FIXTURE_INVALID",
    hostd_start: "HOSTD_UNAVAILABLE",
    provision: "PROVISION_NOT_PROVEN",
    desktop_start: "DESKTOP_UNAVAILABLE",
    renderer: "RENDERER_UNAVAILABLE",
    oauth: "OAUTH_NOT_COMPLETED",
    model_selection: "MODEL_NOT_SELECTED",
    prompt_stream: "PROMPT_NOT_ADMITTED",
    stop: "STOP_NOT_PROVEN",
    restart: "RESTART_NOT_PROVEN",
    no_replay: "REPLAY_NOT_DISPROVEN",
    end: "END_NOT_PROVEN",
    cleanup: "CLEANUP_UNCONFIRMED",
    receipt: "RECEIPT_INVALID",
  })[stage] ?? "INTERNAL_FAILURE";
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
