import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stdin, stderr, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractFile, statFile, uncache } from "@electron/asar";
import {
  CHECKPOINT_ASSERTION,
  CONFIRMATION_PHRASE,
  NullDelimitedCdpDecoder,
  ProviderE2eContractError,
  assertAccountPhase,
  assertInitiallySignedOut,
  assertInteractiveAdmission,
  assertTypedConfirmation,
  createFailureReceipt,
  createFunctionalReceipt,
  encodeCdpMessage,
  fail,
  parseAccountReadResult,
  parseConversationSnapshotResult,
  serializeReceipt,
  validateCompletedTurn,
  validateElectronRestartRecovery,
  validateInterruptedTurn,
} from "./codex-subscription-provider-e2e-lib.mjs";
import {
  extractEmbeddedRuntimeAttestation,
  parseRuntimeAttestation,
} from "./runtime-attestation-lib.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_UNPACKED_ROOT = resolve(REPO_ROOT, "release", "win-unpacked");
const CANDIDATE_EXECUTABLE = resolve(CANDIDATE_UNPACKED_ROOT, "Prime Continuim.exe");
const ACCOUNT_READ_FUNCTION = "function(binding){return globalThis.prime.codexSubscription.accountRead(binding)}";
const CONVERSATION_READ_FUNCTION = "function(binding){return globalThis.prime.codexSubscription.conversationSnapshot(binding)}";
const CODEX_SWITCH_SELECTOR = 'button[aria-label="Use Codex via ChatGPT subscription"]';
const LOGIN_SELECTOR = ".codex-account-card__actions .button--primary";
const COMPOSER_SELECTOR = "#codex-composer-input";
const RUN_SELECTOR = '.codex-composer button[type="submit"]';
const STOP_SELECTOR = ".codex-composer .button--stop";
const LOGOUT_SELECTOR = ".codex-workspace__header-actions button";
const USER_MESSAGE_SELECTOR = '.codex-message[data-role="user"]';
const STREAMING_ASSISTANT_SELECTOR = '.codex-message[data-role="assistant"][data-streaming="true"]';
const CDP_REQUEST_TIMEOUT_MS = 15_000;
const RENDERER_READY_TIMEOUT_MS = 180_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const TURN_TIMEOUT_MS = 5 * 60_000;
const RESTART_TIMEOUT_MS = 180_000;
const MAX_AUTH_SCAN_ENTRIES = 20_000;
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
const FIRST_PROMPT = [
  "Do not use tools or read files.",
  "Write exactly eighty numbered short lines about careful software verification.",
  "Start immediately and keep each line distinct so streaming remains observable.",
].join(" ");
const SECOND_PROMPT = [
  "Do not use tools or read files.",
  "Begin writing five hundred numbered one-sentence observations about reliable software testing.",
  "Continue until every observation is written.",
].join(" ");

let currentStage = "admission";
const runState = {
  fixtureCreated: false,
  desktopStarted: false,
  helperMayRemain: false,
  desktop: undefined,
};

try {
  const profile = process.env.USERPROFILE;
  const integritySids = await collectTokenIntegritySids();
  const tokenUsername = await collectTokenUsername();
  const userProfileBasename = await canonicalUserProfileBasename(profile);
  const uiCulture = await collectUiCulture();
  assertInteractiveAdmission({
    platform: process.platform,
    arch: process.arch,
    stdinIsTTY: stdin.isTTY === true,
    stdoutIsTTY: stdout.isTTY === true,
    ci: process.env.CI,
    argv: process.argv.slice(2),
    checkpointAssertion: process.env.PRIME_CONTINUIM_CODEX_E2E_DISPOSABLE_CHECKPOINT,
    username: process.env.USERNAME,
    tokenUsername,
    userProfileBasename,
    uiCulture,
    integritySids,
  });
  const confirmation = createInterface({ input: stdin, output: stderr });
  let answer;
  try {
    answer = await confirmation.question(
      `This functional test uses live user-scope Codex, signs out, retains its fixture, and requires external VM destruction.\nType exactly: ${CONFIRMATION_PHRASE}\n> `,
    );
  } finally {
    confirmation.close();
  }
  assertTypedConfirmation(answer);

  currentStage = "candidate";
  const candidate = await verifyInstalledCandidate();
  currentStage = "fixture";
  const fixture = await createProductionStoreFixture(candidate);
  const environment = isolatedInstalledEnvironment(fixture);
  const startedAt = Date.now();
  const timings = {};

  currentStage = "desktop_start";
  let desktop = await startInstalledDesktop(candidate, fixture, environment);
  currentStage = "renderer";
  let controller = await attachWorkbench(desktop, candidate.rendererUrl);
  await controller.clickVisible(CODEX_SWITCH_SELECTOR, RENDERER_READY_TIMEOUT_MS);

  currentStage = "initial_account";
  const initialAccount = await waitForAccount(controller, fixture.binding, (account) =>
    account.phase === "signed_out" || account.phase === "signed_in", RENDERER_READY_TIMEOUT_MS);
  assertInitiallySignedOut(initialAccount);

  currentStage = "login";
  const loginStartedAt = Date.now();
  await controller.clickVisible(LOGIN_SELECTOR, 30_000);
  stderr.write("Complete the opened ChatGPT sign-in in the disposable Windows account. The authorization URL is not visible to this harness.\n");
  let loginOperationId;
  const signedInAccount = await waitForAccount(controller, fixture.binding, (account) => {
    if (account.phase === "opening_browser" || account.phase === "waiting_for_login") {
      if (typeof account.pendingLoginOperationId === "string") loginOperationId ??= account.pendingLoginOperationId;
      return false;
    }
    return account.phase === "signed_in";
  }, LOGIN_TIMEOUT_MS);
  if (!loginOperationId) fail("login", "LOGIN_NOT_COMPLETED");
  assertAccountPhase(signedInAccount, "signed_in", "login");
  timings.login = Date.now() - loginStartedAt;

  currentStage = "completed_turn";
  const completedStartedAt = Date.now();
  await controller.typeVisible(COMPOSER_SELECTOR, FIRST_PROMPT, 30_000);
  await controller.clickVisible(RUN_SELECTOR, 30_000);
  const completedEvidence = await observeCompletedTurn(controller, fixture.binding);
  const completedIdentity = validateCompletedTurn(completedEvidence.observations);
  await controller.waitForExactVisibleCount(USER_MESSAGE_SELECTOR, 1, 30_000);
  timings.completedTurn = Date.now() - completedStartedAt;

  currentStage = "interrupted_turn";
  const interruptedStartedAt = Date.now();
  await controller.typeVisible(COMPOSER_SELECTOR, SECOND_PROMPT, 30_000);
  await controller.clickVisible(RUN_SELECTOR, 30_000);
  const activeSecondTurn = await waitForConversation(controller, fixture.binding, (conversation) =>
    conversation?.state === "active" &&
    conversation.latestTurn?.terminal === false &&
    typeof conversation.latestTurn.turnId === "string" &&
    conversation.latestTurn.operationId !== completedIdentity.operationId,
  TURN_TIMEOUT_MS);
  await controller.clickVisible(STOP_SELECTOR, 10_000);
  const interruptedConversation = await waitForConversation(controller, fixture.binding, (conversation) =>
    conversation?.latestTurn?.terminal === true &&
    conversation.latestTurn.operationId === activeSecondTurn.latestTurn.operationId,
  TURN_TIMEOUT_MS);
  const interruptedIdentity = validateInterruptedTurn(activeSecondTurn, interruptedConversation);
  await controller.waitForExactVisibleCount(USER_MESSAGE_SELECTOR, 2, 30_000);
  timings.interruptedTurn = Date.now() - interruptedStartedAt;

  currentStage = "desktop_restart";
  const restartStartedAt = Date.now();
  await closeInstalledDesktopOrderly(desktop);
  runState.desktop = undefined;
  desktop = await startInstalledDesktop(candidate, fixture, environment);
  runState.desktop = desktop;
  controller = await attachWorkbench(desktop, candidate.rendererUrl);
  await controller.clickVisible(CODEX_SWITCH_SELECTOR, RESTART_TIMEOUT_MS);
  const restartedAccount = await waitForAccount(
    controller,
    fixture.binding,
    (account) => account.phase === "signed_in",
    RESTART_TIMEOUT_MS,
  );
  assertAccountPhase(restartedAccount, "signed_in", "desktop_restart");
  if (restartedAccount.backendIncarnationId !== signedInAccount.backendIncarnationId) {
    fail("desktop_restart", "RECOVERY_NOT_PROVEN");
  }
  const restartedConversation = await waitForConversation(
    controller,
    fixture.binding,
    (conversation) => conversation?.latestTurn?.terminal === true,
    RESTART_TIMEOUT_MS,
  );
  validateElectronRestartRecovery(
    interruptedConversation,
    restartedConversation,
    [completedIdentity.operationId, interruptedIdentity.operationId],
  );
  await controller.waitForExactVisibleCount(USER_MESSAGE_SELECTOR, 2, 30_000);
  timings.desktopRestart = Date.now() - restartStartedAt;

  currentStage = "logout";
  const logoutStartedAt = Date.now();
  await controller.clickVisible(LOGOUT_SELECTOR, 30_000);
  const signedOutAccount = await waitForAccount(
    controller,
    fixture.binding,
    (account) => account.phase === "signed_out",
    60_000,
  );
  assertAccountPhase(signedOutAccount, "signed_out", "logout");
  timings.logout = Date.now() - logoutStartedAt;

  currentStage = "auth_scan";
  await assertAuthJsonAbsent(await canonicalCodexHome(fixture.dataDirectory));
  await closeInstalledDesktopOrderly(desktop);
  runState.desktop = undefined;

  currentStage = "candidate";
  await assertCandidateArtifactsUnchanged(candidate);
  currentStage = "receipt";
  const receipt = createFunctionalReceipt({
    candidate: candidate.receiptIdentity,
    durationsMs: {
      total: Date.now() - startedAt,
      login: timings.login,
      completedTurn: timings.completedTurn,
      interruptedTurn: timings.interruptedTurn,
      desktopRestart: timings.desktopRestart,
      logout: timings.logout,
    },
    initialSignedOut: true,
    loginOperationObserved: true,
    signedIn: true,
    completedTurnStreamed: true,
    completedTurnRenderedStream: completedEvidence.renderedStreaming,
    completedTurnRenderedUserItem: true,
    completedTurnExactIdentity: true,
    interruptedTurnRenderedUserItem: true,
    interruptedTurnExactIdentity: true,
    desktopRestartRecovered: true,
    noReplay: true,
    restartSignedIn: true,
    loggedOut: true,
    authJsonAbsent: true,
  });
  stdout.write(serializeReceipt(receipt));
  process.exitCode = 2;
} catch (error) {
  const contractError = error instanceof ProviderE2eContractError
    ? error
    : new ProviderE2eContractError(currentStage, stageCode(currentStage));
  if (runState.desktop) {
    try {
      await closeInstalledDesktopOrderly(runState.desktop, { allowAlreadyExited: true });
      runState.desktop = undefined;
    } catch {
      // External VM rollback/destruction is the only cleanup authority after an uncertain close.
      abandonChildObservation(runState.desktop);
      runState.desktop = undefined;
    }
  }
  stdout.write(serializeReceipt(createFailureReceipt(contractError.stage, contractError.code, runState)));
  process.exitCode = 1;
}

async function verifyInstalledCandidate() {
  const installedConfigured = process.env.PRIME_CONTINUIM_CODEX_E2E_INSTALLED_EXE;
  if (typeof installedConfigured !== "string" || !isAbsolute(installedConfigured)) fail("candidate", "CANDIDATE_INVALID");
  const installedExecutable = await canonicalRegularFile(installedConfigured);
  const candidateExecutable = await canonicalRegularFile(CANDIDATE_EXECUTABLE);
  if (pathWithin(REPO_ROOT, installedExecutable) || basename(installedExecutable).toLowerCase() !== "prime continuim.exe") {
    fail("candidate", "CANDIDATE_INVALID");
  }
  const installedRoot = dirname(installedExecutable);
  const installedArchive = await canonicalRegularFile(resolve(installedRoot, "resources", "app.asar"));
  const installedHostd = await canonicalRegularFile(resolve(installedRoot, "resources", "hostd", "hostd.cjs"));
  const installedRuntimePointer = await canonicalRegularFile(resolve(installedRoot, "resources", "runtime-seed", "current.json"));
  const candidateArchive = await canonicalRegularFile(resolve(CANDIDATE_UNPACKED_ROOT, "resources", "app.asar"));
  const candidateHostd = await canonicalRegularFile(resolve(CANDIDATE_UNPACKED_ROOT, "resources", "hostd", "hostd.cjs"));
  const candidateRuntimePointer = await canonicalRegularFile(resolve(CANDIDATE_UNPACKED_ROOT, "resources", "runtime-seed", "current.json"));
  const [
    installedExecutableSha256,
    candidateExecutableSha256,
    applicationArchiveSha256,
    candidateArchiveSha256,
    hostdSha256,
    candidateHostdSha256,
    installedRuntimePointerSha256,
    candidateRuntimePointerSha256,
  ] = await Promise.all([
    sha256File(installedExecutable),
    sha256File(candidateExecutable),
    sha256File(installedArchive),
    sha256File(candidateArchive),
    sha256File(installedHostd),
    sha256File(candidateHostd),
    sha256File(installedRuntimePointer),
    sha256File(candidateRuntimePointer),
  ]);
  if (
    installedExecutableSha256 !== candidateExecutableSha256 ||
    applicationArchiveSha256 !== candidateArchiveSha256 ||
    hostdSha256 !== candidateHostdSha256 ||
    installedRuntimePointerSha256 !== candidateRuntimePointerSha256
  ) fail("candidate", "CANDIDATE_INVALID");

  const installedAppVersion = packagedAppVersion(installedArchive);
  if (packagedAppVersion(candidateArchive) !== installedAppVersion) fail("candidate", "CANDIDATE_INVALID");
  const installer = await canonicalRegularFile(resolve(
    REPO_ROOT,
    "release",
    `Prime-Continuim-${installedAppVersion}-windows-x64-setup.exe`,
  ));
  const installerDigest = await sha256File(installer);
  const digestSidecarPath = await canonicalRegularFile(`${installer}.sha256`);
  const digestSidecar = await readFile(digestSidecarPath, "utf8");
  const sidecarLine = `${installerDigest} *${basename(installer)}`;
  if (![sidecarLine, `${sidecarLine}\n`, `${sidecarLine}\r\n`].includes(digestSidecar)) {
    fail("candidate", "CANDIDATE_INVALID");
  }
  const digestSidecarSha256 = await sha256File(digestSidecarPath);
  const hostdBytes = await readFile(installedHostd);
  const attestation = parseRuntimeAttestation(extractEmbeddedRuntimeAttestation(hostdBytes));
  const pointer = JSON.parse(await readFile(installedRuntimePointer, "utf8"));
  if (
    attestation.runtime.platform !== "win32" ||
    attestation.runtime.arch !== "x64" ||
    pointer.platform !== "win32" ||
    pointer.arch !== "x64" ||
    pointer.manifestSha256 !== attestation.manifest.sha256 ||
    pointer.treeSha256 !== attestation.tree.sha256
  ) fail("candidate", "CANDIDATE_INVALID");
  const verificationArtifacts = Object.freeze([
    [installedExecutable, installedExecutableSha256],
    [candidateExecutable, candidateExecutableSha256],
    [installedArchive, applicationArchiveSha256],
    [candidateArchive, candidateArchiveSha256],
    [installedHostd, hostdSha256],
    [candidateHostd, candidateHostdSha256],
    [installedRuntimePointer, installedRuntimePointerSha256],
    [candidateRuntimePointer, candidateRuntimePointerSha256],
    [installer, installerDigest],
    [digestSidecarPath, digestSidecarSha256],
  ].map(([path, sha256]) => Object.freeze({ path, sha256 })));
  return Object.freeze({
    installedExecutable,
    installedRoot,
    installedHostd,
    verificationArtifacts,
    rendererUrl: pathToFileURL(resolve(installedRoot, "resources", "app.asar", "out", "renderer", "index.html")).href,
    receiptIdentity: Object.freeze({
      appVersion: installedAppVersion,
      runtimeReleaseVersion: attestation.runtime.releaseVersion,
      runtimeBuildId: attestation.runtime.runtimeBuildId,
      codexAppServerReleaseVersion: attestation.codexAppServer.releaseVersion,
      assurance: attestation.assurance,
      installerSha256: installerDigest,
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
    if (
      !archiveMetadata.isFile() ||
      archiveMetadata.isSymbolicLink() ||
      archiveMetadata.size <= 0 ||
      archiveMetadata.size > 512 * 1024 * 1024
    ) fail("candidate", "CANDIDATE_INVALID");
    const entry = statFile(archive, "package.json", false);
    if (
      !entry ||
      "link" in entry ||
      "files" in entry ||
      entry.unpacked === true ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0 ||
      entry.size > 64 * 1024 ||
      entry.integrity?.algorithm !== "SHA256" ||
      !/^[a-f0-9]{64}$/u.test(entry.integrity.hash)
    ) fail("candidate", "CANDIDATE_INVALID");
    const bytes = extractFile(archive, "package.json", false);
    if (!Buffer.isBuffer(bytes) || bytes.length !== entry.size) {
      fail("candidate", "CANDIDATE_INVALID");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== entry.integrity.hash) {
      fail("candidate", "CANDIDATE_INVALID");
    }
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (
      !manifest ||
      Array.isArray(manifest) ||
      Object.getPrototypeOf(manifest) !== Object.prototype ||
      manifest.name !== "prime-continuim" ||
      manifest.main !== "./out/main/index.js" ||
      typeof manifest.version !== "string" ||
      !/^\d+\.\d+\.\d+$/u.test(manifest.version)
    ) fail("candidate", "CANDIDATE_INVALID");
    return manifest.version;
  } catch (error) {
    if (error instanceof ProviderE2eContractError) throw error;
    fail("candidate", "CANDIDATE_INVALID");
  } finally {
    try {
      uncache(archive);
    } catch {
      // A stale ASAR cache is never retained deliberately by this harness.
    }
  }
}

async function assertCandidateArtifactsUnchanged(candidate) {
  if (!Array.isArray(candidate?.verificationArtifacts) || candidate.verificationArtifacts.length !== 10) {
    fail("candidate", "CANDIDATE_INVALID");
  }
  for (const artifact of candidate.verificationArtifacts) {
    if (!artifact || typeof artifact.path !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
      fail("candidate", "CANDIDATE_INVALID");
    }
    const canonicalBefore = await canonicalRegularFile(artifact.path);
    if (canonicalBefore !== artifact.path || await sha256File(canonicalBefore) !== artifact.sha256) {
      fail("candidate", "CANDIDATE_INVALID");
    }
    const canonicalAfter = await canonicalRegularFile(artifact.path);
    if (canonicalAfter !== artifact.path) fail("candidate", "CANDIDATE_INVALID");
  }
}

async function collectTokenIntegritySids() {
  if (process.platform !== "win32") return [];
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot)) return [];
  const executable = resolve(systemRoot, "System32", "whoami.exe");
  try {
    const metadata = await lstat(executable);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  const child = spawn(executable, ["/groups", "/fo", "csv", "/nh"], {
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    env: { SystemRoot: resolve(systemRoot), WINDIR: resolve(systemRoot) },
  });
  let bytes = Buffer.alloc(0);
  child.stdout?.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, Buffer.from(chunk)]).subarray(-64 * 1024);
  });
  child.stdout?.on("error", () => {
    bytes = Buffer.alloc(0);
  });
  const outcome = await waitForHelperExit(child, 10_000).catch(() => undefined);
  if (!outcome || outcome.code !== 0 || outcome.signal !== null) return [];
  const matches = bytes.toString("utf8").match(/S-1-16-\d+/giu) ?? [];
  return [...new Set(matches.map((value) => value.toUpperCase()))].sort();
}

async function collectTokenUsername() {
  if (process.platform !== "win32") return "";
  const bytes = await runWhoami(["/user", "/fo", "csv", "/nh"]);
  if (!bytes) return "";
  const match = /^"([^"]+)","S-1-5-[^"]+"\r?\n?$/iu.exec(bytes.toString("utf8"));
  if (!match) return "";
  return match[1].split("\\").at(-1) ?? "";
}

async function collectUiCulture() {
  if (process.platform !== "win32") return "";
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot)) return "";
  const executable = resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const metadata = await lstat(executable);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return "";
  } catch {
    return "";
  }
  const child = spawn(executable, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Globalization.CultureInfo]::CurrentUICulture.Name",
  ], {
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    env: { SystemRoot: resolve(systemRoot), WINDIR: resolve(systemRoot) },
  });
  let bytes = Buffer.alloc(0);
  let overflow = false;
  child.stdout?.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
    if (bytes.byteLength > 256) overflow = true;
  });
  child.stdout?.on("error", () => {
    overflow = true;
  });
  const outcome = await waitForHelperExit(child, 10_000).catch(() => undefined);
  if (!outcome || outcome.code !== 0 || outcome.signal !== null || overflow) return "";
  return bytes.toString("utf8").trim();
}

async function canonicalUserProfileBasename(value) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/u.test(value)) return "";
  try {
    const metadata = await lstat(value);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return "";
    return basename(await realpath(value));
  } catch {
    return "";
  }
}

async function runWhoami(argumentsList) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot)) return undefined;
  const executable = resolve(systemRoot, "System32", "whoami.exe");
  try {
    const metadata = await lstat(executable);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  const child = spawn(executable, argumentsList, {
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    env: { SystemRoot: resolve(systemRoot), WINDIR: resolve(systemRoot) },
  });
  let bytes = Buffer.alloc(0);
  child.stdout?.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
    if (bytes.byteLength > 64 * 1024) bytes = Buffer.alloc(0);
  });
  child.stdout?.on("error", () => {
    bytes = Buffer.alloc(0);
  });
  const outcome = await waitForHelperExit(child, 10_000).catch(() => undefined);
  if (!outcome || outcome.code !== 0 || outcome.signal !== null || bytes.byteLength === 0) return undefined;
  return bytes;
}

async function createProductionStoreFixture(candidate) {
  const requestedRoot = await mkdtemp(join(tmpdir(), "prime-continuim-codex-provider-e2e-"));
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
  await Promise.all(Object.values(requested).map(async (directory) => {
    await mkdir(directory, { recursive: false, mode: 0o700 });
  }));
  const canonical = Object.fromEntries(await Promise.all(Object.entries(requested).map(async ([key, value]) => [key, await realpath(value)])));
  for (const directory of Object.values(canonical)) {
    if (!pathWithin(root, directory)) fail("fixture", "FIXTURE_INVALID");
  }
  const installedRequire = createRequire(pathToFileURL(candidate.installedHostd));
  const installedHostd = installedRequire(candidate.installedHostd);
  if (typeof installedHostd.HostStore !== "function") fail("fixture", "FIXTURE_INVALID");
  const store = new installedHostd.HostStore(canonical.dataDirectory);
  await store.initialize();
  const host = await store.getHost();
  const projectId = "codex-provider-e2e-project";
  const workspaceId = "codex-provider-e2e-workspace";
  const threadId = "codex-provider-e2e-thread";
  const executionGenerationId = "codex-provider-e2e-execution-1";
  const createdAt = new Date().toISOString();
  const project = {
    projectId,
    hostId: host.hostId,
    workspaceId,
    displayName: "Codex provider E2E fixture",
    lastOpenedAt: createdAt,
  };
  const cursor = {
    threadId,
    executionGenerationId,
    generation: "codex-provider-e2e-projection-1",
    sequence: 0,
  };
  const thread = {
    threadId,
    title: "Codex provider E2E fixture",
    projectIdentity: projectId,
    currentLocation: { hostId: host.hostId, projectId, workspaceId, executionGenerationId },
    status: "idle",
    unread: false,
    updatedAt: createdAt,
    lastKnownCursor: cursor,
  };
  const projection = {
    snapshotVersion: 1,
    generatedAt: createdAt,
    thread,
    transcriptBlockIndex: [],
    materializedRecentBlocks: [],
    queueState: { pendingCommandIds: [], paused: false },
    approvals: [],
    childAgents: [],
    goals: [],
    schedules: [],
    git: { stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
    evidence: { testsPassed: 0, testsFailed: 0, artifactCount: 0 },
    pendingAttention: [],
    latestCursor: cursor,
  };
  const requestDigest = createHash("sha256").update(JSON.stringify({
    projectId,
    workspaceId,
    threadId,
    executionGenerationId,
    workspaceDirectory: canonical.workspaceDirectory,
  }), "utf8").digest("hex");
  const status = await store.bootstrapWorkspaceThread({
    operationId: "codex-provider-e2e-bootstrap-1",
    requestDigest,
    expectedHostId: host.hostId,
    project,
    thread,
    initialProjection: projection,
    workspaceDirectory: canonical.workspaceDirectory,
  });
  if (status?.phase !== "committed") fail("fixture", "FIXTURE_INVALID");
  return Object.freeze({
    root,
    ...canonical,
    binding: Object.freeze({
      expectedHostId: host.hostId,
      threadId,
      expectedExecutionGenerationId: executionGenerationId,
    }),
  });
}

function isolatedInstalledEnvironment(fixture) {
  const environment = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "SystemDrive",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "HOMEDRIVE",
    "HOMEPATH",
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
    const matches = Object.entries(process.env).filter(([key]) => key.toLowerCase() === name.toLowerCase());
    if (matches.length > 1) fail("fixture", "FIXTURE_INVALID");
    const value = matches[0]?.[1];
    if (typeof value === "string" && value.length > 0 && value.length <= 32_767 && !/[\0\r\n]/u.test(value)) {
      environment[name] = value;
    }
  }
  environment.PRIME_AGENT_DATA_DIR = fixture.dataDirectory;
  environment.APPDATA = fixture.appDataDirectory;
  environment.LOCALAPPDATA = fixture.localAppDataDirectory;
  environment.TEMP = fixture.temporaryDirectory;
  environment.TMP = fixture.temporaryDirectory;
  return Object.freeze(environment);
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
  child.primeContinuimTemporaryDirectory = fixture.temporaryDirectory;
  discardOutput(child.stdout);
  discardOutput(child.stderr);
  await new Promise((resolvePromise, rejectPromise) => {
    child.once("spawn", () => {
      runState.desktop = child;
      runState.desktopStarted = true;
      resolvePromise();
    });
    child.once("error", () => rejectPromise(new ProviderE2eContractError("desktop_start", "DESKTOP_UNAVAILABLE")));
  });
  if (!child.stdio[3]?.writable || !child.stdio[4]?.readable || !Number.isSafeInteger(child.pid)) {
    fail("desktop_start", "DESKTOP_UNAVAILABLE");
  }
  return Object.assign(child, { cdp: new CdpConnection(child.stdio[3], child.stdio[4]) });
}

async function attachWorkbench(desktop, exactRendererUrl) {
  const cdp = desktop.cdp;
  await cdp.request("Browser.getVersion", {}, undefined, 30_000);
  const deadline = Date.now() + RENDERER_READY_TIMEOUT_MS;
  let target;
  while (Date.now() < deadline) {
    const result = await cdp.request("Target.getTargets");
    const pages = Array.isArray(result.targetInfos)
      ? result.targetInfos.filter((candidate) => candidate?.type === "page")
      : [];
    if (
      pages.length === 1 &&
      pages[0]?.url === exactRendererUrl &&
      pages[0]?.title === "Prime Continuim"
    ) {
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

  async accountRead(binding) {
    const response = await this.cdp.request("Runtime.callFunctionOn", {
      functionDeclaration: ACCOUNT_READ_FUNCTION,
      executionContextId: this.executionContextId,
      arguments: [{ value: { expectedHostId: binding.expectedHostId } }],
      awaitPromise: true,
      returnByValue: true,
    }, this.sessionId);
    return parseAccountReadResult(bridgeValue(response), currentStage);
  }

  async conversationSnapshot(binding) {
    const response = await this.cdp.request("Runtime.callFunctionOn", {
      functionDeclaration: CONVERSATION_READ_FUNCTION,
      executionContextId: this.executionContextId,
      arguments: [{ value: binding }],
      awaitPromise: true,
      returnByValue: true,
    }, this.sessionId);
    const lookup = parseConversationSnapshotResult(bridgeValue(response), currentStage);
    return lookup.conversation;
  }

  async clickVisible(selector, timeoutMs) {
    const point = await this.waitForVisiblePoint(selector, timeoutMs);
    await this.cdp.request("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    }, this.sessionId);
    await this.cdp.request("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    }, this.sessionId);
  }

  async typeVisible(selector, value, timeoutMs) {
    if (typeof value !== "string" || value.length < 1 || value.length > 64 * 1024) {
      fail(currentStage, "TURN_IDENTITY_INVALID");
    }
    await this.clickVisible(selector, timeoutMs);
    await this.cdp.request("Input.insertText", { text: value }, this.sessionId);
  }

  async hasVisibleNode(selector) {
    try {
      const nodes = await this.queryNodes(selector);
      for (const nodeId of nodes) {
        try {
          if (await this.visibleNodePoint(nodeId)) return true;
        } catch {
          // A detached or hidden exact node is not visible renderer evidence.
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async waitForExactVisibleCount(selector, expected, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let visible = 0;
      try {
        const nodes = await this.queryNodes(selector);
        for (const nodeId of nodes) {
          try {
            if (await this.visibleNodePoint(nodeId)) visible += 1;
          } catch {
            // React may replace a node between the bounded DOM queries.
          }
        }
      } catch {
        visible = 0;
      }
      if (visible === expected) return true;
      if (visible > expected) fail(currentStage, stageCode(currentStage));
      await delay(50);
    }
    fail(currentStage, stageCode(currentStage));
  }

  async waitForVisiblePoint(selector, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const node = await this.queryNode(selector);
        const attributes = await this.cdp.request("DOM.getAttributes", { nodeId: node.nodeId }, this.sessionId);
        if (Array.isArray(attributes.attributes) && attributes.attributes.includes("disabled")) {
          await delay(50);
          continue;
        }
        const point = await this.visibleNodePoint(node.nodeId, true);
        if (point) return point;
      } catch {
        // The exact selector is retried while React and host readiness settle.
      }
      await delay(50);
    }
    fail("renderer", "RENDERER_UNAVAILABLE");
  }

  async queryNode(selector) {
    const document = await this.cdp.request("DOM.getDocument", { depth: 1, pierce: false }, this.sessionId);
    const nodeId = document?.root?.nodeId;
    if (!Number.isSafeInteger(nodeId)) fail("renderer", "CDP_PROTOCOL_INVALID");
    const result = await this.cdp.request("DOM.querySelector", { nodeId, selector }, this.sessionId);
    if (!Number.isSafeInteger(result.nodeId) || result.nodeId === 0) fail("renderer", "RENDERER_UNAVAILABLE");
    return result;
  }

  async queryNodes(selector) {
    const document = await this.cdp.request("DOM.getDocument", { depth: 1, pierce: false }, this.sessionId);
    const nodeId = document?.root?.nodeId;
    if (!Number.isSafeInteger(nodeId)) fail("renderer", "CDP_PROTOCOL_INVALID");
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
      !Array.isArray(quad) ||
      quad.length !== 8 ||
      !quad.every(Number.isFinite) ||
      !Number.isFinite(viewport?.clientWidth) ||
      !Number.isFinite(viewport?.clientHeight) ||
      viewport.clientWidth <= 0 ||
      viewport.clientHeight <= 0 ||
      !Number.isSafeInteger(backendNodeId) ||
      !Array.isArray(accessibility?.nodes)
    ) fail("renderer", "CDP_PROTOCOL_INVALID");
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const area = Math.abs(
      (quad[0] * quad[3] - quad[1] * quad[2]) +
      (quad[2] * quad[5] - quad[3] * quad[4]) +
      (quad[4] * quad[7] - quad[5] * quad[6]) +
      (quad[6] * quad[1] - quad[7] * quad[0])
    ) / 2;
    const x = xs.reduce((sum, value) => sum + value, 0) / 4;
    const y = ys.reduce((sum, value) => sum + value, 0) / 4;
    const exactAxNode = accessibility.nodes.find((node) => node?.backendDOMNodeId === backendNodeId);
    if (
      width <= 0 ||
      height <= 0 ||
      area <= 0 ||
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

  request(method, params = {}, sessionId, timeoutMs = CDP_REQUEST_TIMEOUT_MS) {
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
    try {
      messages = this.decoder.push(chunk);
    } catch {
      this.onClose();
      return;
    }
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
        try {
          matches = waiter.predicate(message.params);
        } catch {
          matches = false;
        }
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

async function waitForAccount(controller, binding, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const account = await controller.accountRead(binding);
      if (predicate(account)) return account;
      if (account?.phase === "error" || account?.phase === "unavailable") fail(currentStage, "ACCOUNT_STATE_INVALID");
    } catch (error) {
      if (error instanceof ProviderE2eContractError) throw error;
    }
    await delay(100);
  }
  fail(currentStage, currentStage === "login" ? "LOGIN_NOT_COMPLETED" : "ACCOUNT_STATE_INVALID");
}

async function waitForConversation(controller, binding, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const conversation = await controller.conversationSnapshot(binding);
      if (predicate(conversation)) return conversation;
    } catch (error) {
      if (error instanceof ProviderE2eContractError) throw error;
      // Production reconciliation reads are retried only within this fixed deadline.
    }
    await delay(75);
  }
  fail(currentStage, currentStage === "interrupted_turn" ? "INTERRUPT_NOT_PROVEN" : "RECOVERY_NOT_PROVEN");
}

async function observeCompletedTurn(controller, binding) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let active;
  let streaming;
  let terminal;
  let renderedStreaming = false;
  let operationId;
  while (Date.now() < deadline) {
    let conversation;
    try {
      conversation = await controller.conversationSnapshot(binding);
    } catch (error) {
      if (error instanceof ProviderE2eContractError) throw error;
      await delay(75);
      continue;
    }
    const latest = conversation?.latestTurn;
    if (!latest) {
      await delay(75);
      continue;
    }
    operationId ??= latest.operationId;
    if (latest.operationId !== operationId) fail("completed_turn", "TURN_IDENTITY_INVALID");
    if (conversation.state === "active" && latest.terminal === false && typeof latest.turnId === "string") active ??= conversation;
    if (conversation.transcript?.some((item) =>
      item.role === "assistant" &&
      item.turnOperationId === operationId &&
      item.state === "streaming" &&
      typeof item.text === "string" &&
      item.text.length > 0
    )) {
      streaming ??= conversation;
      if (await controller.hasVisibleNode(STREAMING_ASSISTANT_SELECTOR)) renderedStreaming = true;
    }
    if (latest.terminal === true) {
      terminal = conversation;
      break;
    }
    await delay(75);
  }
  if (!active || !streaming || !terminal) fail("completed_turn", "TURN_NOT_COMPLETED");
  if (!renderedStreaming) fail("completed_turn", "STREAMING_NOT_OBSERVED");
  return { observations: [active, streaming, terminal], renderedStreaming };
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
    const metadata = lstatSync(powershell);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail("cleanup", "CLEANUP_UNCONFIRMED");
    const temporaryMetadata = lstatSync(temporaryDirectory);
    if (!temporaryMetadata.isDirectory() || temporaryMetadata.isSymbolicLink()) fail("cleanup", "CLEANUP_UNCONFIRMED");
    if (await realpath(temporaryDirectory) !== temporaryDirectory) fail("cleanup", "CLEANUP_UNCONFIRMED");
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
  const encodedCommand = Buffer.from(closeScript, "utf16le").toString("base64");
  const helper = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], {
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

async function assertAuthJsonAbsent(root) {
  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      entries += 1;
      if (entries > MAX_AUTH_SCAN_ENTRIES) fail("auth_scan", "AUTH_JSON_PRESENT");
      if (child.name.toLowerCase() === "auth.json") fail("auth_scan", "AUTH_JSON_PRESENT");
      if (child.isSymbolicLink()) fail("auth_scan", "AUTH_JSON_PRESENT");
      if (child.isDirectory()) pending.push(join(directory, child.name));
    }
  }
}

async function canonicalCodexHome(dataDirectory) {
  try {
    const expected = resolve(dataDirectory, "codex-subscription", "home");
    const metadata = await lstat(expected);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("auth_scan", "AUTH_JSON_PRESENT");
    const canonical = await realpath(expected);
    if (canonical.toLowerCase() !== expected.toLowerCase() || !pathWithin(dataDirectory, canonical)) {
      fail("auth_scan", "AUTH_JSON_PRESENT");
    }
    return canonical;
  } catch (error) {
    if (error instanceof ProviderE2eContractError) throw error;
    fail("auth_scan", "AUTH_JSON_PRESENT");
  }
}

function bridgeValue(response) {
  if (response?.exceptionDetails || response?.result?.type === "undefined" || !("value" in (response?.result ?? {}))) {
    fail("renderer", "CDP_PROTOCOL_INVALID");
  }
  return response.result.value;
}

function discardOutput(stream) {
  if (!stream) return;
  stream.on("data", () => undefined);
  stream.on("error", () => undefined);
}

async function canonicalRegularFile(value) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/u.test(value)) fail("candidate", "CANDIDATE_INVALID");
  const metadata = await lstat(value);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail("candidate", "CANDIDATE_INVALID");
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

function waitForExit(child, timeoutMs, onTimeout) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      child.off("error", onError);
      try {
        onTimeout?.();
      } catch {
        runState.helperMayRemain = true;
      }
      rejectPromise(new ProviderE2eContractError("cleanup", "CLEANUP_UNCONFIRMED"));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      child.off("error", onError);
      resolvePromise({ code, signal });
    };
    const onError = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      rejectPromise(new ProviderE2eContractError("cleanup", "CLEANUP_UNCONFIRMED"));
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function waitForHelperExit(child, timeoutMs) {
  return waitForExit(child, timeoutMs, () => {
    runState.helperMayRemain = true;
    abandonChildObservation(child);
  });
}

function abandonChildObservation(child) {
  for (const stream of child?.stdio ?? []) {
    try {
      if (stream && typeof stream.destroy === "function") stream.destroy();
    } catch {
      // The receipt remains cleanup-unconfirmed regardless of observation teardown.
    }
  }
  try {
    child?.unref();
  } catch {
    runState.helperMayRemain = true;
  }
}

function stageCode(stage) {
  return ({
    admission: "INTERNAL_FAILURE",
    candidate: "CANDIDATE_INVALID",
    fixture: "FIXTURE_INVALID",
    desktop_start: "DESKTOP_UNAVAILABLE",
    renderer: "RENDERER_UNAVAILABLE",
    initial_account: "ACCOUNT_STATE_INVALID",
    login: "LOGIN_NOT_COMPLETED",
    completed_turn: "TURN_NOT_COMPLETED",
    interrupted_turn: "INTERRUPT_NOT_PROVEN",
    desktop_restart: "RECOVERY_NOT_PROVEN",
    logout: "LOGOUT_NOT_PROVEN",
    auth_scan: "AUTH_JSON_PRESENT",
    cleanup: "CLEANUP_UNCONFIRMED",
    receipt: "RECEIPT_INVALID",
  })[stage] ?? "INTERNAL_FAILURE";
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
