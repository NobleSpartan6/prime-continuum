import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";

export const EVIDENCE_KIND = "prime_continuim_sol_rlm_browser_dogfood";
export const OPT_IN_FLAG = "--i-understand-this-uses-live-sol-rlm-and-browser-tools";
export const DISPOSABLE_CHECKPOINT_FLAG = "--disposable-workspace-checkpoint";
export const CHECKPOINT_ASSERTION = "DISPOSABLE_SOL_RLM_BROWSER_DOGFOOD_READY";
export const CONFIRMATION_PHRASE =
  "I AUTHORIZE LIVE GPT-5.6 SOL PROVIDER USE, ONE NATIVE RLM CHILD, VERIFIED BROWSER TOOLS, PLAINTEXT OAUTH STORAGE, FAIL-CLOSED FIXTURE RETENTION, AND EXTERNAL DISPOSAL";
export const PROVIDER_ID = "openai-codex";
export const MODEL_ID = "gpt-5.6-sol";
export const RUNTIME_MODEL_ID = `${PROVIDER_ID}/${MODEL_ID}`;
export const PRIME_AGENT_RELEASE_VERSION = "0.7.2";
export const CHILD_NAME = "browser-auditor";
export const BROWSER_SURFACE = "playwright-cli";
export const ROOT_PREFIX = "prime-continuim-tool-dogfood-";
export const RECEIPT_NAME = "receipt.json";
export const PROOF_DIRECTORY = ".prime-continuim-tool-dogfood";
export const PROOF_NAME = "proof.json";
export const SCREENSHOT_NAME = "browser-proof.png";
export const FUNCTIONAL_EXIT_CODE = 2;
export const MAX_RECEIPT_BYTES = 24 * 1024;
export const MAX_PROOF_BYTES = 32 * 1024;
export const MAX_BROWSER_STATE_ENTRIES = 4_096;
export const MAX_TRANSCRIPT_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_UNIX_SOCKET_PATH_BYTES = 100;
export const POST_RESTART_OBSERVATION_INTERVAL_MS = 4_000;
export const MIN_POST_RESTART_OBSERVATIONS = 3;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const STABLE_REF = /^e[1-9][0-9]{0,8}$/u;
const CREDENTIAL_ENV = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTHORIZATION|COOKIE|PRIVATE_?KEY|REFRESH_?TOKEN|SESSION_?TOKEN)(?:_|$)/u;
const PROVIDER_ENV = /^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE_GENERATIVE_AI|AZURE_OPENAI|AWS|MISTRAL|GROQ|CEREBRAS|COHERE|TOGETHER|DEEPSEEK|OPENROUTER|PERPLEXITY|XAI)(?:_|$)/u;
const ALLOWED_HARNESS_ENV = new Set([
  "PRIME_AGENT_DATA_DIR",
  "PRIME_CONTINUIM_TOOL_DOGFOOD_CANDIDATE_APP",
  "PRIME_CONTINUIM_TOOL_DOGFOOD_ROOT",
  "PRIME_CONTINUIM_TOOL_DOGFOOD_WORKSPACE",
  "PRIME_CONTINUIM_TOOL_DOGFOOD_DISPOSABLE_CHECKPOINT",
]);

const STAGES = new Set([
  "admission",
  "fixture",
  "candidate",
  "host",
  "precondition",
  "operator",
  "in_flight",
  "projection",
  "browser",
  "restart",
  "no_replay",
  "cleanup",
  "receipt",
]);

const CODES = new Set([
  "INTERACTIVE_REQUIRED",
  "CI_FORBIDDEN",
  "OPT_IN_REQUIRED",
  "DISPOSABLE_CHECKPOINT_REQUIRED",
  "CONFIRMATION_REJECTED",
  "CREDENTIAL_ENVIRONMENT_FORBIDDEN",
  "UNSUPPORTED_PLATFORM",
  "FIXTURE_INVALID",
  "CANDIDATE_INVALID",
  "HOST_UNAVAILABLE",
  "PRECONDITION_NOT_PROVEN",
  "OPERATOR_DEADLINE_EXCEEDED",
  "IN_FLIGHT_NOT_PROVEN",
  "PROJECTION_NOT_PROVEN",
  "BROWSER_PROOF_INVALID",
  "BROWSER_RESIDUE_RETAINED",
  "RESTART_NOT_PROVEN",
  "REPLAY_NOT_DISPROVEN",
  "CLEANUP_UNCONFIRMED",
  "RECEIPT_INVALID",
  "INTERNAL_FAILURE",
]);

export const NONCLAIMS = Object.freeze([
  "not_release_readiness_evidence",
  "not_installer_or_signing_evidence",
  "not_provider_rpc_count_evidence",
  "not_desktop_command_submit_attempt_count_evidence",
  "not_sender_trust_or_security_evidence",
  "not_browser_credential_isolation_evidence",
  "not_hostile_same_user_custody_evidence",
  "not_external_disposal_completion_evidence",
  "not_a_general_tool_sandbox",
]);

export class ToolDogfoodContractError extends Error {
  constructor(stage, code) {
    const valid = STAGES.has(stage) && CODES.has(code);
    super(valid ? `${stage}:${code}` : "receipt:RECEIPT_INVALID");
    this.name = "ToolDogfoodContractError";
    this.stage = valid ? stage : "receipt";
    this.code = valid ? code : "RECEIPT_INVALID";
  }
}

export function fail(stage, code) {
  throw new ToolDogfoodContractError(stage, code);
}

export function assertInteractiveAdmission(input) {
  if (!["darwin", "linux", "win32"].includes(input?.platform)) fail("admission", "UNSUPPORTED_PLATFORM");
  if (input.stdinIsTTY !== true || input.stdoutIsTTY !== true) fail("admission", "INTERACTIVE_REQUIRED");
  if (input.ci !== undefined && input.ci !== false && input.ci !== "") fail("admission", "CI_FORBIDDEN");
  if (input.githubActions !== undefined && input.githubActions !== false && input.githubActions !== "") {
    fail("admission", "CI_FORBIDDEN");
  }
  const argv = Array.isArray(input.argv) ? input.argv : [];
  const flags = new Set(argv);
  if (
    argv.length !== 2 ||
    flags.size !== 2 ||
    !flags.has(OPT_IN_FLAG) ||
    !flags.has(DISPOSABLE_CHECKPOINT_FLAG)
  ) fail("admission", "OPT_IN_REQUIRED");
  if (input.checkpointAssertion !== CHECKPOINT_ASSERTION) {
    fail("admission", "DISPOSABLE_CHECKPOINT_REQUIRED");
  }
  return Object.freeze({ admitted: true });
}

export function assertNoCredentialEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    fail("admission", "CREDENTIAL_ENVIRONMENT_FORBIDDEN");
  }
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || value === "") continue;
    const normalized = name.toUpperCase();
    if (ALLOWED_HARNESS_ENV.has(normalized)) continue;
    if (CREDENTIAL_ENV.test(normalized) || PROVIDER_ENV.test(normalized)) {
      fail("admission", "CREDENTIAL_ENVIRONMENT_FORBIDDEN");
    }
  }
  return true;
}

export function assertTypedConfirmation(value) {
  if (value !== CONFIRMATION_PHRASE) fail("admission", "CONFIRMATION_REJECTED");
  return true;
}

export async function validateDisposableLayout(input) {
  const requestedRoot = requireAbsolutePath(input?.root);
  const requestedWorkspace = requireAbsolutePath(input?.workspace);
  const requestedDataDirectory = requireAbsolutePath(input?.dataDirectory);
  let root;
  let workspace;
  let dataDirectory;
  let temporaryDirectories;
  try {
    [root, workspace, dataDirectory, temporaryDirectories] = await Promise.all([
      realpath(requestedRoot),
      realpath(requestedWorkspace),
      realpath(requestedDataDirectory),
      approvedTemporaryDirectories(),
    ]);
    const [rootMetadata, workspaceMetadata, dataMetadata] = await Promise.all([
      lstat(requestedRoot),
      lstat(requestedWorkspace),
      lstat(requestedDataDirectory),
    ]);
    if (
      rootMetadata.isSymbolicLink() || workspaceMetadata.isSymbolicLink() || dataMetadata.isSymbolicLink() ||
      !rootMetadata.isDirectory() || !workspaceMetadata.isDirectory() || !dataMetadata.isDirectory()
    ) fail("fixture", "FIXTURE_INVALID");
  } catch (error) {
    if (error instanceof ToolDogfoodContractError) throw error;
    fail("fixture", "FIXTURE_INVALID");
  }
  if (
    !basename(root).startsWith(ROOT_PREFIX) ||
    !temporaryDirectories.some((temporaryDirectory) => isStrictDescendant(temporaryDirectory, root)) ||
    !isStrictDescendant(root, workspace) ||
    !isStrictDescendant(root, dataDirectory) ||
    workspace === dataDirectory ||
    isStrictDescendant(workspace, dataDirectory) ||
    isStrictDescendant(dataDirectory, workspace)
  ) fail("fixture", "FIXTURE_INVALID");
  if (process.platform !== "win32") {
    const [rootMode, dataMode] = await Promise.all([stat(root), stat(dataDirectory)]);
    if ((rootMode.mode & 0o077) !== 0 || (dataMode.mode & 0o077) !== 0) fail("fixture", "FIXTURE_INVALID");
  }
  let dataEntries;
  let rootEntries;
  try {
    [dataEntries, rootEntries] = await Promise.all([readdir(dataDirectory), readdir(root)]);
  }
  catch { fail("fixture", "FIXTURE_INVALID"); }
  if (
    dataEntries.length !== 0 ||
    JSON.stringify(rootEntries.sort()) !== JSON.stringify([basename(dataDirectory), basename(workspace)].sort())
  ) fail("fixture", "FIXTURE_INVALID");
  return Object.freeze({ root, workspace, dataDirectory });
}

export function resolveDogfoodHostEndpoint(input) {
  const platform = input?.platform;
  const dataDirectory = requireAbsolutePathForPlatform(input?.dataDirectory, platform);
  if (platform === "win32") {
    const digest = createHash("sha256").update(win32.resolve(dataDirectory).toLowerCase()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\prime-agent-hostd-${digest}`;
  }
  const endpoint = posix.join(dataDirectory, "hostd.sock");
  if (Buffer.byteLength(endpoint, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES) {
    fail("fixture", "FIXTURE_INVALID");
  }
  return endpoint;
}

export function resolveDogfoodResidentDaemonEndpoint(input) {
  const platform = input?.platform;
  const dataDirectory = requireAbsolutePathForPlatform(input?.dataDirectory, platform);
  const identity = createHash("sha256")
    .update(platform === "win32" ? win32.resolve(dataDirectory).toLowerCase() : dataDirectory)
    .digest("hex")
    .slice(0, 16);
  if (platform === "win32") return `\\\\.\\pipe\\prime-continuim-resident-${identity}`;
  const temporaryDirectory = requireAbsolutePathForPlatform(input?.physicalTemporaryDirectory, platform);
  const endpoint = posix.join(temporaryDirectory, `pc-${identity}`, "d.sock");
  if (Buffer.byteLength(endpoint, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES) {
    fail("fixture", "FIXTURE_INVALID");
  }
  return endpoint;
}

async function approvedTemporaryDirectories() {
  const requested = process.platform === "darwin" ? [tmpdir(), "/private/tmp"] : [tmpdir()];
  return [...new Set(await Promise.all(requested.map((directory) => realpath(directory))))];
}

export function createDogfoodIdentity(runId, nonce) {
  if (!ID.test(runId) || !/^[a-f0-9]{24,64}$/u.test(nonce)) fail("fixture", "FIXTURE_INVALID");
  const short = createHash("sha256").update(`${runId}\0${nonce}`).digest("hex").slice(0, 20);
  return Object.freeze({
    runId,
    childToken: `CHILD_REPORT:${short}`,
    fillValue: `sol-browser-${short}`,
    finalMarker: `DOGFOOD_COMPLETE:${short}`,
    goalObjective: `Verify GPT-5.6 Sol native RLM and browser execution ${short}`,
    sessionName: `sol-dogfood-${short}`,
  });
}

export function createDogfoodPrompt(input) {
  const identity = input?.identity;
  const pageUrl = input?.pageUrl;
  if (!identity || typeof pageUrl !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/dogfood\/[A-Za-z0-9._:-]+$/u.test(pageUrl)) {
    fail("fixture", "FIXTURE_INVALID");
  }
  return [
    `This is an explicitly authorized disposable dogfood run ${identity.runId}.`,
    `Create exactly one goal with the exact objective: ${identity.goalObjective}`,
    `Spawn exactly one native RLM child with name ${CHILD_NAME}. Give it a bounded read-only review of this task contract.`,
    `Keep the root turn and that child active until the child has begun the verified browser sequence; do not complete the child immediately after spawning it.`,
    `Require that child to reply to its parent through agent_message with the exact token ${identity.childToken}.`,
    `Confirm that the root and child runtime model is exactly ${RUNTIME_MODEL_ID}; do not use a fallback model.`,
    `Do not accept an rlm() return value as the child result; wait for the explicit agent_message reply.`,
    `Use only the verified ${BROWSER_SURFACE} surface with named session ${identity.sessionName}; do not attach, use a system profile, request persistence, or access any credential.`,
    `Browser sequence: open ${pageUrl}; snapshot; record the stable e-ref for the Dogfood value textbox and Commit dogfood proof button; fill the textbox with ${identity.fillValue}; click the button by its stable ref; eval/read [data-dogfood-result] text and require exactly clicked:${identity.fillValue}; screenshot to ${PROOF_DIRECTORY}/${SCREENSHOT_NAME}; close the named session.`,
    `Always close the named browser session, including on failure.`,
    `Write ${PROOF_DIRECTORY}/${PROOF_NAME} as strict JSON with exactly: schemaVersion=1, runId, runtimeModel=${RUNTIME_MODEL_ID}, childName=${CHILD_NAME}, childToken, browser.sessionName, browser.inputRef, browser.buttonRef, browser.fillValue, browser.evalResult, browser.screenshot, browser.closed=true.`,
    `Use the exact relative screenshot path ${PROOF_DIRECTORY}/${SCREENSHOT_NAME}.`,
    `After the child reply and browser proof are complete, complete the goal and end your final answer with ${identity.finalMarker}.`,
    `Do not start OAuth, inspect auth files, access ambient browser state, create another child, or modify files outside ${PROOF_DIRECTORY}.`,
  ].join("\n");
}

export function createDogfoodPage(identity) {
  if (!identity?.runId || !identity?.fillValue) fail("fixture", "FIXTURE_INVALID");
  const runId = JSON.stringify(identity.runId);
  const fillValue = JSON.stringify(identity.fillValue);
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Prime Continuim tool dogfood</title>',
    '<style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:1rem}label,input,button,output{display:block;margin:.75rem 0}input{padding:.6rem;width:100%}button{padding:.7rem 1rem}</style>',
    "</head><body>",
    '<main><h1>Verified browser dogfood</h1>',
    '<label for="dogfood-value">Dogfood value</label>',
    '<input id="dogfood-value" aria-label="Dogfood value" autocomplete="off">',
    '<button id="commit-proof" type="button">Commit dogfood proof</button>',
    '<output data-dogfood-result>pending</output></main>',
    "<script>",
    `const runId=${runId};const expected=${fillValue};`,
    "const input=document.querySelector('#dogfood-value');const button=document.querySelector('#commit-proof');const output=document.querySelector('[data-dogfood-result]');let fillProof=Promise.resolve();",
    "const record=(action,value)=>fetch(`/event/${encodeURIComponent(runId)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runId,action,value}),keepalive:false});",
    "input.addEventListener('input',()=>{fillProof=record('fill',input.value)});",
    "button.addEventListener('click',async()=>{const value=input.value;if(value!==expected){output.textContent='invalid';return}await fillProof;await record('click',value);output.textContent=`clicked:${value}`;button.textContent='Proof committed'});",
    "</script></body></html>",
  ].join("");
}

export function validateInitialProjection(snapshot, identity) {
  const authority = exactProjectionAuthority(snapshot, "precondition", "PRECONDITION_NOT_PROVEN");
  if (
    snapshot.thread.status !== "idle" ||
    snapshot.runtime?.runtime !== "prime_agent" ||
    snapshot.runtime?.residency !== "resident" ||
    snapshot.runtime?.model !== RUNTIME_MODEL_ID ||
    snapshot.inProgressStream !== undefined ||
    snapshot.queueState?.pendingCommandIds?.length !== 0 ||
    snapshot.queueState?.paused !== false ||
    snapshot.childAgents?.length !== 0 ||
    snapshot.goals?.length !== 0 ||
    snapshot.residentControl?.browserExecution?.readiness !== "ready" ||
    snapshot.residentControl?.browserExecution?.surface !== BROWSER_SURFACE
  ) fail("precondition", "PRECONDITION_NOT_PROVEN");
  const inventory = snapshot.runtime?.resourceInventory;
  if (
    !Array.isArray(inventory?.skills) ||
    inventory.skills.filter((skill) => skill?.name === BROWSER_SURFACE).length !== 1 ||
    inventory?.diagnostics?.errorCount !== 0 ||
    !Array.isArray(inventory?.diagnostics?.collisions) ||
    inventory.diagnostics.collisions.some((collision) =>
      collision?.resourceType === "skill" && collision?.name === BROWSER_SURFACE)
  ) fail("precondition", "PRECONDITION_NOT_PROVEN");
  if (!identity?.goalObjective || !identity?.finalMarker) fail("precondition", "PRECONDITION_NOT_PROVEN");
  return Object.freeze({
    ...authority,
    initialSequence: snapshot.latestCursor.sequence,
    initialGeneration: snapshot.latestCursor.generation,
    activeSessionId: snapshot.runtime.activeSessionId,
    sessionId: snapshot.runtime.sessionId,
  });
}

export function validateAuthenticatedCatalog(catalog) {
  if (catalog?.runtime !== "prime_agent") fail("precondition", "PRECONDITION_NOT_PROVEN");
  const providers = Array.isArray(catalog.providers) ? catalog.providers : [];
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const provider = providers.filter((candidate) => candidate?.providerId === PROVIDER_ID);
  const model = models.filter((candidate) => candidate?.providerId === PROVIDER_ID && candidate?.modelId === MODEL_ID);
  if (
    provider.length !== 1 || model.length !== 1 ||
    provider[0].configured !== true || provider[0].oauthSupported !== true ||
    model[0].available !== true || model[0].usingOAuth !== true
  ) fail("precondition", "PRECONDITION_NOT_PROVEN");
  return Object.freeze({ provider: provider[0], model: model[0] });
}

export function validateInFlightProjection(snapshot, input) {
  const authority = exactProjectionAuthority(snapshot, "in_flight", "IN_FLIGHT_NOT_PROVEN");
  const initial = input?.initial;
  const identity = input?.identity;
  const runtime = snapshot?.runtime;
  const activeToolNames = Array.isArray(runtime?.activeToolNames) ? runtime.activeToolNames : [];
  const rootActivity = snapshot?.inProgressStream !== undefined
    ? "stream"
    : runtime?.isStreaming === true
      ? "runtime_stream"
      : runtime?.isCompacting === true
        ? "compaction"
        : runtime?.isBashRunning === true
          ? "shell"
          : activeToolNames.length > 0
            ? "tool"
            : undefined;
  if (
    !initial || !identity ||
    authority.hostId !== initial.hostId ||
    authority.threadId !== initial.threadId ||
    authority.executionGenerationId !== initial.executionGenerationId ||
    snapshot.latestCursor.generation !== initial.initialGeneration ||
    snapshot.latestCursor.sequence <= initial.initialSequence ||
    snapshot.thread.status !== "running" ||
    runtime?.runtime !== "prime_agent" ||
    runtime?.residency !== "resident" ||
    runtime?.activeSessionId !== initial.activeSessionId ||
    runtime?.sessionId !== initial.sessionId ||
    runtime?.model !== RUNTIME_MODEL_ID ||
    rootActivity === undefined ||
    snapshot.queueState?.paused !== false ||
    snapshot.residentControl?.browserExecution?.readiness !== "ready" ||
    snapshot.residentControl?.browserExecution?.surface !== BROWSER_SURFACE
  ) fail("in_flight", "IN_FLIGHT_NOT_PROVEN");

  const children = Array.isArray(snapshot.childAgents) ? snapshot.childAgents : [];
  if (children.length !== 1) fail("in_flight", "IN_FLIGHT_NOT_PROVEN");
  const child = children[0];
  if (
    child?.sessionName !== CHILD_NAME ||
    !["running", "waiting"].includes(child.state) ||
    child.model !== RUNTIME_MODEL_ID ||
    child.repliedSinceTask === true ||
    !ID.test(child.agentId)
  ) fail("in_flight", "IN_FLIGHT_NOT_PROVEN");

  const goals = Array.isArray(snapshot.goals) ? snapshot.goals : [];
  if (goals.length !== 1) fail("in_flight", "IN_FLIGHT_NOT_PROVEN");
  const goal = goals[0];
  if (goal?.objective !== identity.goalObjective || goal.state !== "active" || !ID.test(goal.goalId)) {
    fail("in_flight", "IN_FLIGHT_NOT_PROVEN");
  }
  return Object.freeze({
    authority,
    child,
    goal,
    rootActivity,
    sequence: snapshot.latestCursor.sequence,
    projectionSha256: sha256Json(snapshot),
  });
}

export function validateCompletedProjection(snapshot, input) {
  const authority = exactProjectionAuthority(snapshot, "projection", "PROJECTION_NOT_PROVEN");
  const initial = input?.initial;
  const identity = input?.identity;
  const inFlight = input?.inFlight;
  if (
    !initial || !identity || !inFlight ||
    authority.hostId !== initial.hostId ||
    authority.threadId !== initial.threadId ||
    authority.executionGenerationId !== initial.executionGenerationId ||
    snapshot.latestCursor.generation !== initial.initialGeneration ||
    snapshot.latestCursor.sequence <= inFlight.sequence ||
    snapshot.thread.status !== "idle" ||
    snapshot.runtime?.runtime !== "prime_agent" ||
    snapshot.runtime?.residency !== "resident" ||
    snapshot.runtime?.activeSessionId !== initial.activeSessionId ||
    snapshot.runtime?.sessionId !== initial.sessionId ||
    snapshot.runtime?.model !== RUNTIME_MODEL_ID ||
    snapshot.inProgressStream !== undefined ||
    snapshot.queueState?.pendingCommandIds?.length !== 0 ||
    snapshot.queueState?.paused !== false ||
    snapshot.residentControl?.browserExecution?.readiness !== "ready" ||
    snapshot.residentControl?.browserExecution?.surface !== BROWSER_SURFACE
  ) fail("projection", "PROJECTION_NOT_PROVEN");

  const children = Array.isArray(snapshot.childAgents) ? snapshot.childAgents : [];
  if (children.length !== 1) fail("projection", "PROJECTION_NOT_PROVEN");
  const child = children[0];
  if (
    child?.sessionName !== CHILD_NAME ||
    child.agentId !== inFlight.child.agentId ||
    child.state !== "complete" ||
    child.model !== RUNTIME_MODEL_ID ||
    child.repliedSinceTask !== true ||
    !ID.test(child.agentId)
  ) fail("projection", "PROJECTION_NOT_PROVEN");

  const goals = Array.isArray(snapshot.goals) ? snapshot.goals : [];
  if (goals.length !== 1) fail("projection", "PROJECTION_NOT_PROVEN");
  const goal = goals[0];
  if (
    goal?.objective !== identity.goalObjective || goal.state !== "complete" ||
    goal.goalId !== inFlight.goal.goalId || !ID.test(goal.goalId)
  ) {
    fail("projection", "PROJECTION_NOT_PROVEN");
  }

  const transcript = boundedTranscript(snapshot.materializedRecentBlocks);
  for (const required of [
    identity.childToken,
    identity.finalMarker,
    identity.fillValue,
    `clicked:${identity.fillValue}`,
    BROWSER_SURFACE,
    "snapshot",
    "screenshot",
    "close",
  ]) {
    if (!transcript.includes(required)) fail("projection", "PROJECTION_NOT_PROVEN");
  }
  if (!/\[ref=e[1-9][0-9]{0,8}\]/u.test(transcript) && !/\be[1-9][0-9]{0,8}\b/u.test(transcript)) {
    fail("projection", "PROJECTION_NOT_PROVEN");
  }
  return Object.freeze({ authority, child, goal, transcriptSha256: sha256Text(transcript) });
}

export function validateRestartNoReplay(input) {
  const initial = input?.initial;
  const identity = input?.identity;
  const beforeRestart = input?.beforeRestart;
  if (
    !ID.test(input?.hostProcessBefore) || !ID.test(input?.hostProcessAfter) ||
    input.hostProcessBefore === input.hostProcessAfter ||
    !ID.test(input?.desktopProcessBefore) || !ID.test(input?.desktopProcessAfter) ||
    input.desktopProcessBefore === input.desktopProcessAfter ||
    !Array.isArray(input?.observations) ||
    input.observations.length < MIN_POST_RESTART_OBSERVATIONS ||
    input.observations.length > 128
  ) fail("restart", "RESTART_NOT_PROVEN");

  validateCompletedProjection(beforeRestart, { initial, identity, inFlight: input?.inFlight });
  const expected = durableCompletedProjection(beforeRestart);
  let previousTime;
  let minimumGap = Number.MAX_SAFE_INTEGER;
  for (const observation of input.observations) {
    if (!Number.isSafeInteger(observation?.observedAtMonotonicMs) || observation.observedAtMonotonicMs < 0) {
      fail("restart", "RESTART_NOT_PROVEN");
    }
    if (previousTime !== undefined) {
      const gap = observation.observedAtMonotonicMs - previousTime;
      if (gap < POST_RESTART_OBSERVATION_INTERVAL_MS) fail("restart", "RESTART_NOT_PROVEN");
      minimumGap = Math.min(minimumGap, gap);
    }
    validateCompletedProjection(observation.snapshot, { initial, identity, inFlight: input?.inFlight });
    if (!isDeepStrictEqual(durableCompletedProjection(observation.snapshot), expected)) {
      fail("restart", "RESTART_NOT_PROVEN");
    }
    previousTime = observation.observedAtMonotonicMs;
  }

  if (
    !sameIdSet(input.journalIdsBefore, input.journalIdsAfter) ||
    input.journalIdsBefore.length < 1 ||
    input.dispatchAttemptCountBefore !== 0 || input.dispatchAttemptCountAfter !== 0 ||
    input.outboxEntryCountBefore !== 0 || input.outboxEntryCountAfter !== 0
  ) fail("no_replay", "REPLAY_NOT_DISPROVEN");

  return Object.freeze({
    hostdRestarted: true,
    desktopRestarted: true,
    sameResidentReattached: true,
    exactProjectionStable: true,
    exactJournalIdsUnchanged: true,
    residentDispatchAttemptsEmpty: true,
    desktopOutboxEmpty: true,
    postRestartObservationCount: input.observations.length,
    minimumPostRestartObservationSeparationMs: minimumGap,
  });
}

export function validateEndedProjection(snapshot, input) {
  const completed = input?.completedSnapshot;
  const authority = input?.authority;
  const location = snapshot?.thread?.currentLocation;
  const lifecycle = snapshot?.residentLifecycle;
  const sourceCursor = completed?.latestCursor;
  const endedThreadStatus = completed?.thread?.status === "complete" || completed?.thread?.status === "failed"
    ? completed.thread.status
    : "idle";
  const expectedThread = completed?.thread && lifecycle?.endedAt ? {
    ...completed.thread,
    status: endedThreadStatus,
    recap: "Resident session ended.",
    updatedAt: lifecycle.endedAt,
    lastKnownCursor: sourceCursor,
  } : undefined;
  const noLiveState =
    snapshot?.runtime === undefined &&
    snapshot?.inProgressStream === undefined &&
    Array.isArray(snapshot?.queueState?.pendingCommandIds) &&
    snapshot.queueState.pendingCommandIds.length === 0 &&
    snapshot.queueState.paused === false &&
    Array.isArray(snapshot?.approvals) && snapshot.approvals.length === 0 &&
    Array.isArray(snapshot?.childAgents) && snapshot.childAgents.length === 0 &&
    Array.isArray(snapshot?.goals) && snapshot.goals.length === 0 &&
    Array.isArray(snapshot?.schedules) && snapshot.schedules.length === 0 &&
    Array.isArray(snapshot?.pendingAttention) && snapshot.pendingAttention.length === 0;
  if (
    !completed || !authority ||
    !isDeepStrictEqual(snapshot?.thread, expectedThread) ||
    snapshot.thread.threadId !== authority.threadId ||
    location?.hostId !== authority.hostId ||
    location?.executionGenerationId !== authority.executionGenerationId ||
    !ID.test(location?.projectId) || !ID.test(location?.workspaceId) ||
    !["idle", "complete", "failed"].includes(snapshot?.thread?.status) ||
    snapshot.thread.recap !== "Resident session ended." ||
    lifecycle?.version !== 1 || lifecycle.state !== "ended" || lifecycle.reason !== "user_end" ||
    !ID.test(lifecycle.operationId) || !SHA256.test(lifecycle.bindingFingerprint) ||
    typeof lifecycle.endedAt !== "string" || lifecycle.endedAt !== snapshot.generatedAt ||
    !isDeepStrictEqual(snapshot.latestCursor, sourceCursor) ||
    !isDeepStrictEqual(lifecycle.sourceCursor, sourceCursor) ||
    !isDeepStrictEqual(snapshot.thread.lastKnownCursor, sourceCursor) ||
    !isDeepStrictEqual(snapshot.transcriptBlockIndex, completed.transcriptBlockIndex) ||
    !isDeepStrictEqual(snapshot.materializedRecentBlocks, completed.materializedRecentBlocks) ||
    !isDeepStrictEqual(snapshot.git, completed.git) ||
    !isDeepStrictEqual(snapshot.evidence, completed.evidence) ||
    !noLiveState
  ) fail("cleanup", "CLEANUP_UNCONFIRMED");
  return Object.freeze({
    operationId: lifecycle.operationId,
    bindingFingerprint: lifecycle.bindingFingerprint,
    endedAt: lifecycle.endedAt,
    sourceCursor,
    projectId: location.projectId,
    workspaceId: location.workspaceId,
    projectionSha256: sha256Json(snapshot),
  });
}

export function validateEndedControlProjection(control, input) {
  const authority = input?.authority;
  const ended = input?.ended;
  if (
    !authority || !ended ||
    control?.projectionVersion !== 1 ||
    control.hostId !== authority.hostId ||
    control.threadId !== authority.threadId ||
    control.executionGenerationId !== authority.executionGenerationId ||
    control.bindingFingerprint !== ended.bindingFingerprint ||
    control.commandReadiness !== "unavailable" ||
    control.browserExecution?.readiness !== "unavailable" ||
    control.operation !== undefined ||
    control.quiescence?.state !== "ended" ||
    control.quiescence.endedAt !== ended.endedAt ||
    !isDeepStrictEqual(control.authorityCursor, ended.sourceCursor)
  ) fail("cleanup", "CLEANUP_UNCONFIRMED");
  return true;
}

export function validateCompletedEndLifecycleStatus(status, input) {
  const authority = input?.authority;
  const operationId = input?.operationId;
  const ended = input?.ended;
  if (
    !authority || !ended || !ID.test(operationId) ||
    status?.version !== 1 || status.kind !== "end" || status.phase !== "completed" ||
    status.operationId !== operationId ||
    status.expectedHostId !== authority.hostId ||
    status.projectId !== ended.projectId || status.workspaceId !== ended.workspaceId ||
    status.threadId !== authority.threadId ||
    status.executionGenerationId !== authority.executionGenerationId ||
    typeof status.preparedAt !== "string" || typeof status.updatedAt !== "string" ||
    status.terminalAt !== status.updatedAt ||
    status.quarantinedFrom !== undefined || status.quarantineReason !== undefined ||
    status.completionReason !== undefined
  ) fail("cleanup", "CLEANUP_UNCONFIRMED");
  return true;
}

export function validateLoopbackEvidence(events, identity) {
  if (!Array.isArray(events) || events.length < 3 || events.length > 32) fail("browser", "BROWSER_PROOF_INVALID");
  const openIndex = events.findIndex((event) => event?.action === "open" && event.runId === identity.runId);
  const fillIndex = events.findIndex((event, index) =>
    index > openIndex && event?.action === "fill" && event.runId === identity.runId && event.value === identity.fillValue);
  const clickIndex = events.findIndex((event, index) =>
    index > fillIndex && event?.action === "click" && event.runId === identity.runId && event.value === identity.fillValue);
  if (openIndex < 0 || fillIndex < 0 || clickIndex < 0) fail("browser", "BROWSER_PROOF_INVALID");
  return Object.freeze({ openIndex, fillIndex, clickIndex, count: events.length });
}

export function parseAndValidateProof(bytes, identity) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "");
  if (buffer.byteLength < 2 || buffer.byteLength > MAX_PROOF_BYTES) fail("browser", "BROWSER_PROOF_INVALID");
  let proof;
  try { proof = JSON.parse(buffer.toString("utf8")); }
  catch { fail("browser", "BROWSER_PROOF_INVALID"); }
  const exactTop = ["browser", "childName", "childToken", "runId", "runtimeModel", "schemaVersion"];
  const exactBrowser = ["buttonRef", "closed", "evalResult", "fillValue", "inputRef", "screenshot", "sessionName"];
  if (
    !proof || typeof proof !== "object" || Array.isArray(proof) ||
    JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify(exactTop) ||
    !proof.browser || typeof proof.browser !== "object" || Array.isArray(proof.browser) ||
    JSON.stringify(Object.keys(proof.browser).sort()) !== JSON.stringify(exactBrowser) ||
    proof.schemaVersion !== 1 ||
    proof.runId !== identity.runId ||
    proof.runtimeModel !== RUNTIME_MODEL_ID ||
    proof.childName !== CHILD_NAME ||
    proof.childToken !== identity.childToken ||
    proof.browser.sessionName !== identity.sessionName ||
    !STABLE_REF.test(proof.browser.inputRef) ||
    !STABLE_REF.test(proof.browser.buttonRef) ||
    proof.browser.inputRef === proof.browser.buttonRef ||
    proof.browser.fillValue !== identity.fillValue ||
    proof.browser.evalResult !== `clicked:${identity.fillValue}` ||
    proof.browser.screenshot !== `${PROOF_DIRECTORY}/${SCREENSHOT_NAME}` ||
    proof.browser.closed !== true
  ) fail("browser", "BROWSER_PROOF_INVALID");
  return Object.freeze(proof);
}

export async function readAndValidateProof(path, identity) {
  return parseAndValidateProof(await readStablePrivateFile(path, MAX_PROOF_BYTES, 2), identity);
}

export async function validateScreenshot(path) {
  const bytes = await readStablePrivateFile(path, 64 * 1024 * 1024, 8);
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    fail("browser", "BROWSER_PROOF_INVALID");
  }
  return Object.freeze({ byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
}

async function readStablePrivateFile(path, maximumBytes, minimumBytes) {
  let handle;
  try {
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0));
    handle = await open(path, flags);
    const before = await handle.stat({ bigint: true });
    const pathBefore = await lstat(path, { bigint: true });
    if (!samePrivateRegularFile(before, pathBefore, maximumBytes, minimumBytes)) {
      fail("browser", "BROWSER_PROOF_INVALID");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      !samePrivateRegularFile(after, pathAfter, maximumBytes, minimumBytes) ||
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
      bytes.byteLength !== Number(after.size)
    ) fail("browser", "BROWSER_PROOF_INVALID");
    return bytes;
  } catch (error) {
    if (error instanceof ToolDogfoodContractError) throw error;
    fail("browser", "BROWSER_PROOF_INVALID");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function samePrivateRegularFile(handleStat, pathStat, maximumBytes, minimumBytes) {
  const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  return (
    handleStat.isFile() && pathStat.isFile() && !pathStat.isSymbolicLink() &&
    handleStat.nlink === 1n && pathStat.nlink === 1n &&
    handleStat.dev === pathStat.dev && handleStat.ino === pathStat.ino &&
    handleStat.size === pathStat.size &&
    handleStat.size >= BigInt(minimumBytes) && handleStat.size <= BigInt(maximumBytes) &&
    (process.platform === "win32" || ((Number(handleStat.mode) & 0o022) === 0 && (Number(pathStat.mode) & 0o022) === 0)) &&
    (expectedUid === undefined || (handleStat.uid === expectedUid && pathStat.uid === expectedUid))
  );
}

export async function assertBrowserStateRetired(stateDirectory) {
  let root;
  try { root = await realpath(stateDirectory); }
  catch { fail("cleanup", "CLEANUP_UNCONFIRMED"); }
  const pending = [root];
  let inspected = 0;
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { fail("cleanup", "CLEANUP_UNCONFIRMED"); }
    for (const entry of entries) {
      inspected += 1;
      if (inspected > MAX_BROWSER_STATE_ENTRIES) fail("cleanup", "CLEANUP_UNCONFIRMED");
      if (
        entry.isSymbolicLink() ||
        entry.name === "browser.json" ||
        entry.name === "launch.json" ||
        entry.name === "profile" ||
        entry.name.startsWith("operation.lock") ||
        entry.name.startsWith("launch.owner-") ||
        entry.name.includes(".candidate-")
      ) fail("cleanup", "BROWSER_RESIDUE_RETAINED");
      if (entry.isDirectory()) pending.push(resolve(directory, entry.name));
    }
  }
  return Object.freeze({ retired: true, inspectedEntries: inspected });
}

export function createFunctionalReceipt(input) {
  const receipt = {
    schemaVersion: 4,
    kind: EVIDENCE_KIND,
    outcome: "functional_passed_external_disposal_required",
    platform: input.platform,
    arch: input.arch,
    runId: input.runId,
    candidate: input.candidate,
    workspaceCheckpoint: input.workspaceCheckpoint,
    authority: input.authority,
    proof: input.proof,
    ownedProcesses: input.ownedProcesses,
    cleanup: {
      browserStateRetired: true,
      loopbackConnectionsRetired: true,
      disposableRootRemoved: false,
      externalDisposalRequired: true,
      externalDisposalConfirmed: false,
    },
    disclosures: {
      providerNetworkAndQuotaUsed: true,
      plaintextOauthStorageDisclosed: true,
      harnessReadCredentialMaterial: false,
      harnessStartedOauth: false,
    },
    nonclaims: [...NONCLAIMS],
  };
  return validateReceipt(receipt);
}

export function createFailureReceipt(input) {
  const receipt = {
    schemaVersion: 4,
    kind: EVIDENCE_KIND,
    outcome: "failed_fixture_retained",
    platform: input.platform,
    arch: input.arch,
    runId: input.runId,
    stage: STAGES.has(input.stage) ? input.stage : "receipt",
    code: CODES.has(input.code) ? input.code : "INTERNAL_FAILURE",
    ownedProcesses: {
      desktopStopped: input.desktopStopped === true,
      hostdStopped: input.hostdStopped === true,
      residentDaemonStopped: input.residentDaemonStopped === true,
    },
    cleanup: {
      browserStateRetired: input.browserStateRetired === true,
      loopbackConnectionsRetired: input.loopbackConnectionsRetired === true,
      disposableRootRemoved: false,
      externalDisposalRequired: true,
      externalDisposalConfirmed: false,
    },
    disclosures: {
      providerNetworkAndQuotaMayHaveBeenUsed: input.providerMayHaveBeenUsed === true,
      plaintextOauthStorageDisclosed: true,
      harnessReadCredentialMaterial: false,
      harnessStartedOauth: false,
    },
    nonclaims: [...NONCLAIMS],
  };
  return validateReceipt(receipt);
}

export function serializeReceipt(receipt) {
  const valid = validateReceipt(receipt);
  const bytes = Buffer.from(`${JSON.stringify(valid, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_RECEIPT_BYTES) fail("receipt", "RECEIPT_INVALID");
  return bytes;
}

export function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) fail("receipt", "RECEIPT_INVALID");
  if (
    receipt.schemaVersion !== 4 || receipt.kind !== EVIDENCE_KIND ||
    !["darwin", "linux", "win32"].includes(receipt.platform) ||
    typeof receipt.arch !== "string" || receipt.arch.length < 1 || receipt.arch.length > 32 ||
    !ID.test(receipt.runId) ||
    !Array.isArray(receipt.nonclaims) || JSON.stringify(receipt.nonclaims) !== JSON.stringify(NONCLAIMS) ||
    receipt.cleanup?.disposableRootRemoved !== false ||
    receipt.cleanup?.externalDisposalRequired !== true ||
    receipt.cleanup?.externalDisposalConfirmed !== false ||
    receipt.disclosures?.harnessReadCredentialMaterial !== false ||
    receipt.disclosures?.harnessStartedOauth !== false
  ) fail("receipt", "RECEIPT_INVALID");
  if (receipt.outcome === "functional_passed_external_disposal_required") {
    assertExactKeys(receipt, [
      "arch", "authority", "candidate", "cleanup", "disclosures", "kind", "nonclaims", "outcome",
      "ownedProcesses", "platform", "proof", "runId", "schemaVersion", "workspaceCheckpoint",
    ]);
    assertExactKeys(receipt.candidate, [
      "appAsarSha256", "artifact", "attestationSha256", "browserExecutableSha256",
      "desktopExecutableSha256", "hostExecutableSha256", "hostdSha256", "releaseVersion",
      "runtime", "runtimeTreeSha256",
    ]);
    assertExactKeys(receipt.workspaceCheckpoint, ["detachedHead", "head", "initiallyClean"]);
    assertExactKeys(receipt.authority, ["executionGenerationId", "hostId", "threadId"]);
    assertExactKeys(receipt.ownedProcesses, ["desktopStopped", "hostdStopped", "residentDaemonStopped"]);
    assertExactKeys(receipt.cleanup, [
      "browserStateRetired", "disposableRootRemoved", "externalDisposalConfirmed",
      "externalDisposalRequired", "loopbackConnectionsRetired",
    ]);
    assertExactKeys(receipt.disclosures, [
      "harnessReadCredentialMaterial", "harnessStartedOauth", "plaintextOauthStorageDisclosed",
      "providerNetworkAndQuotaUsed",
    ]);
    assertExactKeys(receipt.proof, [
      "browserOperations", "browserStateEntriesInspected", "browserSurface", "childAgentId", "childName",
      "childReplied", "completionProjectionSha256", "goalId", "goalState", "loopbackEventCount",
      "inFlightChildState", "inFlightObserved", "inFlightProjectionSha256", "inFlightRootActivity", "inFlightSequence",
      "desktopOutboxEmpty", "desktopRestarted", "exactJournalIdsUnchanged", "exactProjectionStable",
      "hostdRestarted", "minimumPostRestartObservationSeparationMs", "postRestartObservationCount",
      "residentDaemonEndpointRetired", "residentDaemonIdentityCount", "residentDaemonOwnerRetired",
      "residentDaemonProcessGroupCount", "residentDaemonRetiredProcessGroupCount",
      "residentDaemonSessionsAfterEnd", "residentDaemonShutdownConfirmed", "residentDaemonTerminatedIdentityCount",
      "residentDispatchAttemptsEmpty", "residentEndLifecycleCompleted", "residentEndProjectionSha256", "runtimeModel",
      "sameResidentReattached", "screenshotBytes",
      "screenshotSha256", "stableReferenceCount", "transcriptSha256",
    ]);
    if (
      receipt.cleanup.browserStateRetired !== true ||
      receipt.cleanup.loopbackConnectionsRetired !== true ||
      receipt.ownedProcesses?.desktopStopped !== true ||
      receipt.ownedProcesses?.hostdStopped !== true ||
      receipt.ownedProcesses?.residentDaemonStopped !== true ||
      receipt.disclosures.providerNetworkAndQuotaUsed !== true ||
      receipt.disclosures.plaintextOauthStorageDisclosed !== true ||
      !validateFunctionalReceiptRecords(receipt)
    ) fail("receipt", "RECEIPT_INVALID");
  } else if (receipt.outcome === "failed_fixture_retained") {
    assertExactKeys(receipt, [
      "arch", "cleanup", "code", "disclosures", "kind", "nonclaims", "outcome", "ownedProcesses",
      "platform", "runId", "schemaVersion", "stage",
    ]);
    assertExactKeys(receipt.ownedProcesses, ["desktopStopped", "hostdStopped", "residentDaemonStopped"]);
    assertExactKeys(receipt.cleanup, [
      "browserStateRetired", "disposableRootRemoved", "externalDisposalConfirmed",
      "externalDisposalRequired", "loopbackConnectionsRetired",
    ]);
    assertExactKeys(receipt.disclosures, [
      "harnessReadCredentialMaterial", "harnessStartedOauth", "plaintextOauthStorageDisclosed",
      "providerNetworkAndQuotaMayHaveBeenUsed",
    ]);
    if (
      !STAGES.has(receipt.stage) || !CODES.has(receipt.code) ||
      typeof receipt.ownedProcesses.desktopStopped !== "boolean" ||
      typeof receipt.ownedProcesses.hostdStopped !== "boolean" ||
      typeof receipt.ownedProcesses.residentDaemonStopped !== "boolean" ||
      typeof receipt.cleanup.browserStateRetired !== "boolean" ||
      typeof receipt.cleanup.loopbackConnectionsRetired !== "boolean" ||
      typeof receipt.disclosures.providerNetworkAndQuotaMayHaveBeenUsed !== "boolean" ||
      receipt.disclosures.plaintextOauthStorageDisclosed !== true
    ) fail("receipt", "RECEIPT_INVALID");
  } else {
    fail("receipt", "RECEIPT_INVALID");
  }
  assertPathFree(receipt);
  return Object.freeze(receipt);
}

export function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateFunctionalReceiptRecords(receipt) {
  const candidate = receipt.candidate;
  const checkpoint = receipt.workspaceCheckpoint;
  const authority = receipt.authority;
  const proof = receipt.proof;
  return (
    candidate?.runtime === "prime-agent" &&
    candidate?.artifact === "macos-directory-package" &&
    candidate.releaseVersion === PRIME_AGENT_RELEASE_VERSION &&
    SHA256.test(candidate.runtimeTreeSha256) &&
    SHA256.test(candidate.attestationSha256) &&
    SHA256.test(candidate.appAsarSha256) &&
    SHA256.test(candidate.desktopExecutableSha256) &&
    SHA256.test(candidate.hostExecutableSha256) &&
    SHA256.test(candidate.browserExecutableSha256) &&
    SHA256.test(candidate.hostdSha256) &&
    new Set([
      candidate.desktopExecutableSha256,
      candidate.hostExecutableSha256,
      candidate.browserExecutableSha256,
    ]).size === 3 &&
    checkpoint?.detachedHead === true && checkpoint?.initiallyClean === true && SHA256.test(checkpoint.head) &&
    ID.test(authority?.hostId) && ID.test(authority?.threadId) && ID.test(authority?.executionGenerationId) &&
    proof?.runtimeModel === RUNTIME_MODEL_ID &&
    proof?.inFlightObserved === true &&
    SHA256.test(proof?.inFlightProjectionSha256) &&
    ["stream", "runtime_stream", "compaction", "shell", "tool"].includes(proof?.inFlightRootActivity) &&
    ["running", "waiting"].includes(proof?.inFlightChildState) &&
    Number.isSafeInteger(proof?.inFlightSequence) && proof.inFlightSequence >= 0 &&
    proof?.childName === CHILD_NAME && ID.test(proof?.childAgentId) && proof?.childReplied === true &&
    proof?.goalState === "complete" && ID.test(proof?.goalId) &&
    proof?.browserSurface === BROWSER_SURFACE &&
    Array.isArray(proof?.browserOperations) &&
    JSON.stringify(proof.browserOperations) === JSON.stringify(["open", "snapshot", "fill", "click", "eval", "screenshot", "close"]) &&
    proof?.stableReferenceCount === 2 &&
    Number.isSafeInteger(proof?.loopbackEventCount) && proof.loopbackEventCount >= 3 && proof.loopbackEventCount <= 32 &&
    SHA256.test(proof?.transcriptSha256) &&
    SHA256.test(proof?.screenshotSha256) &&
    Number.isSafeInteger(proof?.screenshotBytes) && proof.screenshotBytes >= 8 && proof.screenshotBytes <= 64 * 1024 * 1024 &&
    Number.isSafeInteger(proof?.browserStateEntriesInspected) && proof.browserStateEntriesInspected >= 0 &&
    proof.browserStateEntriesInspected <= MAX_BROWSER_STATE_ENTRIES &&
    SHA256.test(proof?.completionProjectionSha256) &&
    proof?.hostdRestarted === true &&
    proof?.desktopRestarted === true &&
    proof?.sameResidentReattached === true &&
    proof?.exactProjectionStable === true &&
    proof?.exactJournalIdsUnchanged === true &&
    proof?.residentDispatchAttemptsEmpty === true &&
    proof?.desktopOutboxEmpty === true &&
    Number.isSafeInteger(proof?.postRestartObservationCount) &&
    proof.postRestartObservationCount >= MIN_POST_RESTART_OBSERVATIONS &&
    proof.postRestartObservationCount <= 128 &&
    Number.isSafeInteger(proof?.minimumPostRestartObservationSeparationMs) &&
    proof.minimumPostRestartObservationSeparationMs >= POST_RESTART_OBSERVATION_INTERVAL_MS &&
    SHA256.test(proof?.residentEndProjectionSha256) &&
    proof?.residentEndLifecycleCompleted === true &&
    proof?.residentDaemonSessionsAfterEnd === 0 &&
    proof?.residentDaemonShutdownConfirmed === true &&
    proof?.residentDaemonEndpointRetired === true &&
    proof?.residentDaemonOwnerRetired === true &&
    Number.isSafeInteger(proof?.residentDaemonIdentityCount) &&
    proof.residentDaemonIdentityCount >= 1 && proof.residentDaemonIdentityCount <= 128 &&
    proof?.residentDaemonTerminatedIdentityCount === proof.residentDaemonIdentityCount &&
    Number.isSafeInteger(proof?.residentDaemonProcessGroupCount) &&
    proof.residentDaemonProcessGroupCount >= 1 &&
    proof.residentDaemonProcessGroupCount <= proof.residentDaemonIdentityCount &&
    proof?.residentDaemonRetiredProcessGroupCount === proof.residentDaemonProcessGroupCount
  );
}

function durableCompletedProjection(snapshot) {
  return {
    snapshotVersion: snapshot?.snapshotVersion,
    thread: snapshot?.thread,
    transcriptBlockIndex: snapshot?.transcriptBlockIndex,
    materializedRecentBlocks: snapshot?.materializedRecentBlocks,
    inProgressStream: snapshot?.inProgressStream,
    queueState: snapshot?.queueState,
    approvals: snapshot?.approvals,
    childAgents: snapshot?.childAgents,
    goals: snapshot?.goals,
    schedules: snapshot?.schedules,
    runtime: snapshot?.runtime,
    residentLifecycle: snapshot?.residentLifecycle,
    git: snapshot?.git,
    evidence: snapshot?.evidence,
    pendingAttention: snapshot?.pendingAttention,
    latestCursor: snapshot?.latestCursor,
  };
}

function sameIdSet(left, right) {
  if (
    !Array.isArray(left) || !Array.isArray(right) ||
    left.some((value) => !ID.test(value)) || right.some((value) => !ID.test(value))
  ) return false;
  return left.length === new Set(left).size && right.length === new Set(right).size &&
    isDeepStrictEqual([...left].sort(), [...right].sort());
}

function requireAbsolutePathForPlatform(value, platform) {
  if (typeof value !== "string" || /[\0\r\n]/u.test(value)) fail("fixture", "FIXTURE_INVALID");
  if (platform === "win32") {
    // Root-relative paths depend on the caller's current drive. Require an
    // explicit drive or UNC authority so endpoint identity is deterministic
    // even when this pure target contract is tested off Windows.
    if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/u.test(value)) {
      fail("fixture", "FIXTURE_INVALID");
    }
    return value;
  }
  if ((platform !== "darwin" && platform !== "linux") || !posix.isAbsolute(value)) {
    fail("fixture", "FIXTURE_INVALID");
  }
  return value;
}

function exactProjectionAuthority(snapshot, stage, code) {
  const hostId = snapshot?.thread?.currentLocation?.hostId;
  const threadId = snapshot?.thread?.threadId;
  const executionGenerationId = snapshot?.thread?.currentLocation?.executionGenerationId;
  const control = snapshot?.residentControl;
  const cursor = snapshot?.latestCursor;
  if (
    !ID.test(hostId) || !ID.test(threadId) || !ID.test(executionGenerationId) ||
    control?.hostId !== hostId || control?.threadId !== threadId || control?.executionGenerationId !== executionGenerationId ||
    cursor?.threadId !== threadId || cursor?.executionGenerationId !== executionGenerationId ||
    typeof cursor.generation !== "string" || cursor.generation.length < 1 ||
    !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0
  ) fail(stage, code);
  return Object.freeze({ hostId, threadId, executionGenerationId });
}

function boundedTranscript(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 2_000) {
    fail("projection", "PROJECTION_NOT_PROVEN");
  }
  let total = 0;
  const texts = [];
  for (const block of blocks) {
    if (!block || typeof block.text !== "string" || !Number.isSafeInteger(block.sequence)) {
      fail("projection", "PROJECTION_NOT_PROVEN");
    }
    total += Buffer.byteLength(block.text, "utf8");
    if (total > MAX_TRANSCRIPT_TEXT_BYTES) fail("projection", "PROJECTION_NOT_PROVEN");
    texts.push(block.text);
  }
  return texts.join("\n");
}

function assertPathFree(value) {
  const text = JSON.stringify(value);
  if (text.length > MAX_RECEIPT_BYTES) fail("receipt", "RECEIPT_INVALID");
  const pending = [value];
  const seen = new Set();
  while (pending.length) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object") continue;
    if (seen.has(candidate)) fail("receipt", "RECEIPT_INVALID");
    seen.add(candidate);
    for (const [key, child] of Object.entries(candidate)) {
      if (/(?:path|directory|environment|argv|prompt|url)/iu.test(key)) {
        fail("receipt", "RECEIPT_INVALID");
      }
      if (typeof child === "string") {
        if (/^(?:\/|\\\\|[A-Za-z]:\\|file:)/u.test(child) || /(?:auth|oauth)\.json/iu.test(child)) {
          fail("receipt", "RECEIPT_INVALID");
        }
      } else if (child && typeof child === "object") {
        pending.push(child);
      }
    }
  }
}

function assertExactKeys(value, keys) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) fail("receipt", "RECEIPT_INVALID");
}

function requireAbsolutePath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || /[\0\r\n]/u.test(value)) {
    fail("fixture", "FIXTURE_INVALID");
  }
  const absolute = resolve(value);
  if (absolute !== value) fail("fixture", "FIXTURE_INVALID");
  return absolute;
}

function isStrictDescendant(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}
