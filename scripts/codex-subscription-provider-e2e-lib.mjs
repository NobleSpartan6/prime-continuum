import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

export const EVIDENCE_KIND = "prime_continuim_codex_subscription_provider_e2e";
export const EVIDENCE_CLASS = "opt_in_functional_e2e";
export const WORKSPACE_SETUP = "production_store_fixture";
export const DEDICATED_WINDOWS_USER = "PrimeCodexE2E";
export const OPT_IN_FLAG = "--i-understand-this-will-use-and-sign-out-my-chatgpt-subscription";
export const DISPOSABLE_CHECKPOINT_FLAG = "--disposable-windows-checkpoint";
export const CHECKPOINT_ASSERTION = "DISPOSABLE_WINDOWS_CHECKPOINT_READY";
export const CONFIRMATION_PHRASE = "I AUTHORIZE LIVE CODEX USER-SCOPE TURNS, SIGN-OUT, FIXTURE RETENTION, AND DISPOSABLE VM DESTRUCTION";
export const MAX_CDP_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MAX_RECEIPT_BYTES = 12 * 1024;

export const FAILURE_STAGES = Object.freeze([
  "admission",
  "candidate",
  "fixture",
  "desktop_start",
  "renderer",
  "initial_account",
  "login",
  "completed_turn",
  "interrupted_turn",
  "desktop_restart",
  "logout",
  "auth_scan",
  "cleanup",
  "receipt",
]);

export const FAILURE_CODES = Object.freeze([
  "WRONG_PLATFORM",
  "WRONG_ARCH",
  "INTERACTIVE_REQUIRED",
  "CI_FORBIDDEN",
  "OPT_IN_REQUIRED",
  "DISPOSABLE_CHECKPOINT_REQUIRED",
  "DEDICATED_USER_REQUIRED",
  "UNSUPPORTED_UI_CULTURE",
  "ELEVATED_TOKEN_FORBIDDEN",
  "CONFIRMATION_REJECTED",
  "CANDIDATE_INVALID",
  "FIXTURE_INVALID",
  "DESKTOP_UNAVAILABLE",
  "CDP_PROTOCOL_INVALID",
  "RENDERER_UNAVAILABLE",
  "PREEXISTING_AUTHORITY",
  "ACCOUNT_STATE_INVALID",
  "LOGIN_NOT_COMPLETED",
  "TURN_IDENTITY_INVALID",
  "STREAMING_NOT_OBSERVED",
  "TURN_NOT_COMPLETED",
  "INTERRUPT_NOT_PROVEN",
  "RECOVERY_NOT_PROVEN",
  "LOGOUT_NOT_PROVEN",
  "AUTH_JSON_PRESENT",
  "CLEANUP_UNCONFIRMED",
  "RECEIPT_INVALID",
  "INTERNAL_FAILURE",
]);

const NONCLAIMS = Object.freeze([
  "not_sender_trust_or_security_evidence",
  "not_ordinary_user_authority",
  "not_installed_lifecycle_evidence",
  "not_signing_evidence",
  "not_hostd_restart_evidence",
  "not_provider_rpc_count_evidence",
  "system_browser_session_state_not_observed",
]);

const STAGE_SET = new Set(FAILURE_STAGES);
const CODE_SET = new Set(FAILURE_CODES);
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][a-z0-9._-]+)?$/iu;
const BUILD_ID = /^[a-z0-9._-]{1,128}$/iu;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const EXECUTION_DISCLOSURE = "Codex tools cannot write files or open network connections. They may read other files available to your Windows account; this is not a workspace-only sandbox. Prompts and content Codex reads—including workspace instructions and tool-read files—are sent to OpenAI for the turn.";

const IdSchema = z.string().min(1).max(128).regex(ID);
const IsoDateTimeSchema = z.string().min(20).max(40).refine((value) => Number.isFinite(Date.parse(value)));
const BackendSchema = z.object({
  id: z.literal("codex-chatgpt-subscription"),
  kind: z.literal("codex_subscription"),
  label: z.literal("Codex via ChatGPT subscription"),
}).strict();
const ExecutionPolicySchema = z.object({
  filesystem: z.literal("read_only_user_scope"),
  workspaceReadConfinement: z.literal(false),
  toolNetworkAccess: z.literal(false),
  approvalPolicy: z.literal("never"),
  disclosure: z.literal(EXECUTION_DISCLOSURE),
}).strict();
const ErrorSchema = z.object({
  code: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/u),
  message: z.string().min(1).max(1_024).regex(/^[^\0\r\n]+$/u),
  retryable: z.boolean(),
}).strict();
const TurnReadinessSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("unavailable"),
    reason: z.enum(["account_required", "login_in_progress", "backend_unavailable"]),
  }).strict(),
  z.object({ state: z.literal("ready"), verifiedAt: IsoDateTimeSchema }).strict(),
  z.object({ state: z.literal("error"), checkedAt: IsoDateTimeSchema, error: ErrorSchema }).strict(),
]);
const PlanTypeSchema = z.enum([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);
const AccountSnapshotSchema = z.object({
  backend: BackendSchema,
  backendIncarnationId: IdSchema,
  phase: z.enum(["unavailable", "signed_out", "opening_browser", "waiting_for_login", "signed_in", "error"]),
  pendingLoginId: IdSchema.optional(),
  pendingLoginOperationId: IdSchema.optional(),
  accountType: z.literal("chatgpt").optional(),
  requiresOpenaiAuth: z.literal(true).optional(),
  planType: PlanTypeSchema.optional(),
  executionPolicy: ExecutionPolicySchema,
  turnReadiness: TurnReadinessSchema,
  updatedAt: IsoDateTimeSchema,
  error: ErrorSchema.optional(),
}).strict().superRefine((snapshot, context) => {
  const pending = snapshot.phase === "opening_browser" || snapshot.phase === "waiting_for_login";
  if (pending !== (snapshot.pendingLoginId !== undefined) || pending !== (snapshot.pendingLoginOperationId !== undefined)) {
    context.addIssue({ code: "custom", path: ["pendingLoginId"], message: "invalid pending login identity" });
  }
  const signedIn = snapshot.phase === "signed_in";
  if (
    signedIn !== (snapshot.planType !== undefined) ||
    signedIn !== (snapshot.accountType !== undefined) ||
    signedIn !== (snapshot.requiresOpenaiAuth !== undefined)
  ) context.addIssue({ code: "custom", path: ["planType"], message: "invalid signed-in proof" });
  if ((snapshot.phase === "error" || snapshot.phase === "unavailable") !== (snapshot.error !== undefined)) {
    context.addIssue({ code: "custom", path: ["error"], message: "invalid account error" });
  }
  const reason = snapshot.phase === "signed_out"
    ? "account_required"
    : pending
      ? "login_in_progress"
      : snapshot.phase === "unavailable"
        ? "backend_unavailable"
        : undefined;
  if (reason !== undefined && (snapshot.turnReadiness.state !== "unavailable" || snapshot.turnReadiness.reason !== reason)) {
    context.addIssue({ code: "custom", path: ["turnReadiness"], message: "invalid readiness phase" });
  }
  if (snapshot.phase === "error" && snapshot.turnReadiness.state !== "error") {
    context.addIssue({ code: "custom", path: ["turnReadiness"], message: "invalid error readiness" });
  }
  if (
    (signedIn && snapshot.turnReadiness.state === "unavailable") ||
    (!signedIn && snapshot.turnReadiness.state === "ready") ||
    (!signedIn && snapshot.phase !== "error" && snapshot.turnReadiness.state === "error")
  ) context.addIssue({ code: "custom", path: ["turnReadiness"], message: "invalid account readiness" });
  const readinessTime = snapshot.turnReadiness.state === "ready"
    ? snapshot.turnReadiness.verifiedAt
    : snapshot.turnReadiness.state === "error"
      ? snapshot.turnReadiness.checkedAt
      : undefined;
  if (readinessTime !== undefined && Date.parse(readinessTime) > Date.parse(snapshot.updatedAt)) {
    context.addIssue({ code: "custom", path: ["turnReadiness"], message: "invalid readiness time" });
  }
});
const WorkspaceBindingSchema = z.object({
  hostId: IdSchema,
  sourceThreadId: IdSchema,
  executionGenerationId: IdSchema,
}).strict();
const TranscriptItemSchema = z.object({
  itemId: IdSchema,
  turnOperationId: IdSchema,
  turnId: IdSchema.optional(),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  role: z.enum(["user", "assistant"]),
  state: z.enum(["streaming", "completed"]),
  text: z.string().max(128 * 1_024),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict();
const ActiveTurnSchema = z.object({
  operationId: IdSchema,
  turnId: IdSchema.optional(),
  state: z.enum(["admitted", "starting_thread", "starting_turn", "running", "interrupting"]),
  terminal: z.literal(false),
  startedAt: IsoDateTimeSchema,
}).strict().superRefine((turn, context) => {
  if ((turn.state === "running" || turn.state === "interrupting") && turn.turnId === undefined) {
    context.addIssue({ code: "custom", path: ["turnId"], message: "missing active turn identity" });
  }
});
const TerminalTurnSchema = z.object({
  operationId: IdSchema,
  turnId: IdSchema.optional(),
  state: z.enum(["completed", "interrupted", "failed", "uncertain"]),
  terminal: z.literal(true),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema,
  error: ErrorSchema.optional(),
}).strict().superRefine((turn, context) => {
  const requiresError = turn.state === "failed" || turn.state === "uncertain";
  if (requiresError !== (turn.error !== undefined)) {
    context.addIssue({ code: "custom", path: ["error"], message: "invalid terminal error" });
  }
  if (Date.parse(turn.completedAt) < Date.parse(turn.startedAt)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "invalid terminal time" });
  }
  if ((turn.state === "completed" || turn.state === "interrupted") && turn.turnId === undefined) {
    context.addIssue({ code: "custom", path: ["turnId"], message: "missing terminal turn identity" });
  }
});
const TurnSchema = z.discriminatedUnion("terminal", [ActiveTurnSchema, TerminalTurnSchema]);
const ConversationSnapshotSchema = z.object({
  backend: BackendSchema,
  backendIncarnationId: IdSchema,
  binding: WorkspaceBindingSchema,
  sessionId: IdSchema,
  threadId: IdSchema.optional(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["idle", "active", "terminal", "uncertain"]),
  executionPolicy: ExecutionPolicySchema,
  activeTurn: ActiveTurnSchema.optional(),
  latestTurn: TurnSchema.optional(),
  transcript: z.array(TranscriptItemSchema).max(128),
  transcriptTruncated: z.boolean(),
  updatedAt: IsoDateTimeSchema,
}).strict().superRefine((snapshot, context) => {
  if ((snapshot.state === "active") !== (snapshot.activeTurn !== undefined)) {
    context.addIssue({ code: "custom", path: ["activeTurn"], message: "invalid active state" });
  }
  if (snapshot.activeTurn && !isDeepStrictEqual(snapshot.latestTurn, snapshot.activeTurn)) {
    context.addIssue({ code: "custom", path: ["latestTurn"], message: "active/latest mismatch" });
  }
  if (snapshot.state === "terminal" && (!snapshot.latestTurn?.terminal || snapshot.latestTurn.state === "uncertain")) {
    context.addIssue({ code: "custom", path: ["latestTurn"], message: "invalid terminal conversation" });
  }
  if (snapshot.state === "uncertain" && snapshot.latestTurn?.state !== "uncertain") {
    context.addIssue({ code: "custom", path: ["latestTurn"], message: "invalid uncertain conversation" });
  }
  if (snapshot.state === "idle" && snapshot.latestTurn !== undefined) {
    context.addIssue({ code: "custom", path: ["latestTurn"], message: "invalid idle conversation" });
  }
  const requiresThreadId = snapshot.latestTurn !== undefined && (
    (!snapshot.latestTurn.terminal && snapshot.latestTurn.state !== "admitted" && snapshot.latestTurn.state !== "starting_thread") ||
    (snapshot.latestTurn.terminal && (
      snapshot.latestTurn.state === "completed" ||
      snapshot.latestTurn.state === "interrupted" ||
      snapshot.latestTurn.turnId !== undefined
    ))
  );
  if (requiresThreadId && snapshot.threadId === undefined) {
    context.addIssue({ code: "custom", path: ["threadId"], message: "missing conversation thread" });
  }
  if (snapshot.latestTurn) {
    const latestTime = snapshot.latestTurn.terminal ? snapshot.latestTurn.completedAt : snapshot.latestTurn.startedAt;
    if (Date.parse(snapshot.updatedAt) < Date.parse(latestTime)) {
      context.addIssue({ code: "custom", path: ["updatedAt"], message: "invalid conversation time" });
    }
  }
  const itemIds = new Set();
  let previousSequence = -1;
  for (const [index, item] of snapshot.transcript.entries()) {
    if (itemIds.has(item.itemId)) context.addIssue({ code: "custom", path: ["transcript", index, "itemId"], message: "duplicate item" });
    itemIds.add(item.itemId);
    if (item.sequence <= previousSequence) context.addIssue({ code: "custom", path: ["transcript", index, "sequence"], message: "invalid sequence" });
    previousSequence = item.sequence;
    if (item.role === "user" && item.state !== "completed") {
      context.addIssue({ code: "custom", path: ["transcript", index, "state"], message: "invalid user state" });
    }
    if (Date.parse(item.updatedAt) < Date.parse(item.createdAt) || Date.parse(snapshot.updatedAt) < Date.parse(item.updatedAt)) {
      context.addIssue({ code: "custom", path: ["transcript", index, "updatedAt"], message: "invalid transcript time" });
    }
  }
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 768 * 1_024) {
    context.addIssue({ code: "custom", message: "conversation too large" });
  }
});
const ConversationLookupSchema = z.object({ conversation: ConversationSnapshotSchema.nullable() }).strict();
const AccountResultSchema = z.object({ ok: z.literal(true), value: AccountSnapshotSchema }).strict();
const ConversationResultSchema = z.object({ ok: z.literal(true), value: ConversationLookupSchema }).strict();

export class ProviderE2eContractError extends Error {
  constructor(stage, code) {
    if (!STAGE_SET.has(stage) || !CODE_SET.has(code)) {
      super("receipt:RECEIPT_INVALID");
      this.stage = "receipt";
      this.code = "RECEIPT_INVALID";
      return;
    }
    super(`${stage}:${code}`);
    this.name = "ProviderE2eContractError";
    this.stage = stage;
    this.code = code;
  }
}

export function fail(stage, code) {
  throw new ProviderE2eContractError(stage, code);
}

export function assertInteractiveAdmission(input) {
  if (input.platform !== "win32") fail("admission", "WRONG_PLATFORM");
  if (input.arch !== "x64") fail("admission", "WRONG_ARCH");
  if (!input.stdinIsTTY || !input.stdoutIsTTY) fail("admission", "INTERACTIVE_REQUIRED");
  if (input.ci !== undefined && input.ci !== false && input.ci !== "") fail("admission", "CI_FORBIDDEN");
  const argumentsSet = new Set(input.argv);
  if (
    input.argv.length !== 2 ||
    argumentsSet.size !== 2 ||
    !argumentsSet.has(OPT_IN_FLAG)
  ) fail("admission", "OPT_IN_REQUIRED");
  if (!argumentsSet.has(DISPOSABLE_CHECKPOINT_FLAG) || input.checkpointAssertion !== CHECKPOINT_ASSERTION) {
    fail("admission", "DISPOSABLE_CHECKPOINT_REQUIRED");
  }
  if (
    typeof input.username !== "string" ||
    typeof input.tokenUsername !== "string" ||
    typeof input.userProfileBasename !== "string" ||
    input.username.toLowerCase() !== DEDICATED_WINDOWS_USER.toLowerCase() ||
    input.tokenUsername.toLowerCase() !== DEDICATED_WINDOWS_USER.toLowerCase() ||
    input.userProfileBasename.toLowerCase() !== DEDICATED_WINDOWS_USER.toLowerCase()
  ) fail("admission", "DEDICATED_USER_REQUIRED");
  if (input.uiCulture !== "en-US") fail("admission", "UNSUPPORTED_UI_CULTURE");
  if (
    !Array.isArray(input.integritySids) ||
    input.integritySids.length !== 1 ||
    input.integritySids[0] !== "S-1-16-8192"
  ) fail("admission", "ELEVATED_TOKEN_FORBIDDEN");
  return Object.freeze({ admitted: true });
}

export function assertTypedConfirmation(value) {
  if (value !== CONFIRMATION_PHRASE) fail("admission", "CONFIRMATION_REJECTED");
  return true;
}

export function parseAccountReadResult(value, stage = "login") {
  const parsed = AccountResultSchema.safeParse(value);
  if (!parsed.success) fail(stage, accountResultFailureCode(stage));
  return parsed.data.value;
}

export function parseConversationSnapshotResult(value, stage = "completed_turn") {
  const parsed = ConversationResultSchema.safeParse(value);
  if (!parsed.success) fail(stage, conversationResultFailureCode(stage));
  return parsed.data.value;
}

export function assertAccountPhase(snapshot, phase, stage = "login") {
  if (!snapshot || typeof snapshot !== "object" || snapshot.phase !== phase) {
    fail(stage, phase === "signed_out" ? "LOGOUT_NOT_PROVEN" : "ACCOUNT_STATE_INVALID");
  }
  if (phase === "signed_in" && snapshot.turnReadiness?.state !== "ready") {
    fail(stage, "ACCOUNT_STATE_INVALID");
  }
  return snapshot;
}

export function assertInitiallySignedOut(snapshot) {
  if (snapshot?.phase === "signed_in") fail("initial_account", "PREEXISTING_AUTHORITY");
  if (snapshot?.phase !== "signed_out") fail("initial_account", "ACCOUNT_STATE_INVALID");
  return snapshot;
}

export function validateCompletedTurn(observations) {
  if (!Array.isArray(observations) || observations.length < 2) {
    fail("completed_turn", "TURN_IDENTITY_INVALID");
  }
  const terminal = observations.at(-1);
  const turn = terminal?.latestTurn;
  if (!turn?.terminal || turn.state !== "completed" || !boundedId(turn.operationId) || !boundedId(turn.turnId)) {
    fail("completed_turn", "TURN_NOT_COMPLETED");
  }
  const active = observations.find((snapshot) =>
    snapshot?.state === "active" &&
    snapshot.latestTurn?.terminal === false &&
    snapshot.latestTurn.operationId === turn.operationId &&
    snapshot.latestTurn.turnId === turn.turnId
  );
  if (!active) fail("completed_turn", "TURN_IDENTITY_INVALID");
  assertTurnTranscriptIdentity(terminal, turn.operationId, turn.turnId, "completed_turn");
  const streamed = observations.some((snapshot) => snapshot?.transcript?.some((item) =>
    item?.role === "assistant" &&
    item.turnOperationId === turn.operationId &&
    item.turnId === turn.turnId &&
    item.state === "streaming" &&
    typeof item.text === "string" &&
    item.text.length > 0
  ));
  if (!streamed) fail("completed_turn", "STREAMING_NOT_OBSERVED");
  const completedAssistant = terminal.transcript.some((item) =>
    item.role === "assistant" &&
    item.turnOperationId === turn.operationId &&
    item.turnId === turn.turnId &&
    item.state === "completed" &&
    typeof item.text === "string" &&
    item.text.length > 0
  );
  if (!completedAssistant) fail("completed_turn", "TURN_NOT_COMPLETED");
  return Object.freeze({ operationId: turn.operationId, turnId: turn.turnId });
}

export function validateInterruptedTurn(active, terminal) {
  const activeTurn = active?.latestTurn;
  const terminalTurn = terminal?.latestTurn;
  if (
    active?.state !== "active" ||
    activeTurn?.terminal !== false ||
    !boundedId(activeTurn.operationId) ||
    !boundedId(activeTurn.turnId)
  ) fail("interrupted_turn", "TURN_IDENTITY_INVALID");
  if (
    terminal?.state !== "terminal" ||
    terminalTurn?.terminal !== true ||
    terminalTurn.state !== "interrupted" ||
    terminalTurn.operationId !== activeTurn.operationId ||
    terminalTurn.turnId !== activeTurn.turnId
  ) fail("interrupted_turn", "INTERRUPT_NOT_PROVEN");
  assertTurnTranscriptIdentity(terminal, activeTurn.operationId, activeTurn.turnId, "interrupted_turn");
  return Object.freeze({ operationId: activeTurn.operationId, turnId: activeTurn.turnId });
}

export function validateElectronRestartRecovery(before, after, operationIds) {
  if (!before || !after || before.backendIncarnationId !== after.backendIncarnationId) {
    fail("desktop_restart", "RECOVERY_NOT_PROVEN");
  }
  if (!Number.isSafeInteger(before.revision) || !Number.isSafeInteger(after.revision) || after.revision < before.revision) {
    fail("desktop_restart", "RECOVERY_NOT_PROVEN");
  }
  if (!causallyMonotonic(before.updatedAt, after.updatedAt)) fail("desktop_restart", "RECOVERY_NOT_PROVEN");
  const beforeDurable = omitCurrentObservation(before);
  const afterDurable = omitCurrentObservation(after);
  if (!isDeepStrictEqual(beforeDurable, afterDurable)) fail("desktop_restart", "RECOVERY_NOT_PROVEN");
  if (!Array.isArray(operationIds) || operationIds.length !== 2 || operationIds[0] === operationIds[1]) {
    fail("desktop_restart", "RECOVERY_NOT_PROVEN");
  }
  const expectedOperations = [...operationIds].sort();
  const recoveredUsers = after.transcript.filter((item) => item.role === "user");
  const recoveredOperations = recoveredUsers.map((item) => item.turnOperationId).sort();
  if (recoveredUsers.length !== 2 || !isDeepStrictEqual(recoveredOperations, expectedOperations)) {
    fail("desktop_restart", "RECOVERY_NOT_PROVEN");
  }
  return Object.freeze({ recovered: true, noReplay: true });
}

export class NullDelimitedCdpDecoder {
  constructor(maxMessageBytes = MAX_CDP_MESSAGE_BYTES) {
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 128 || maxMessageBytes > MAX_CDP_MESSAGE_BYTES) {
      fail("renderer", "CDP_PROTOCOL_INVALID");
    }
    this.maxMessageBytes = maxMessageBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) fail("renderer", "CDP_PROTOCOL_INVALID");
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    if (this.buffer.byteLength > this.maxMessageBytes && this.buffer.indexOf(0) < 0) {
      fail("renderer", "CDP_PROTOCOL_INVALID");
    }
    const messages = [];
    let separator;
    while ((separator = this.buffer.indexOf(0)) >= 0) {
      const bytes = this.buffer.subarray(0, separator);
      this.buffer = this.buffer.subarray(separator + 1);
      if (bytes.byteLength < 2 || bytes.byteLength > this.maxMessageBytes) fail("renderer", "CDP_PROTOCOL_INVALID");
      let value;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        fail("renderer", "CDP_PROTOCOL_INVALID");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("renderer", "CDP_PROTOCOL_INVALID");
      messages.push(value);
    }
    if (this.buffer.byteLength > this.maxMessageBytes) fail("renderer", "CDP_PROTOCOL_INVALID");
    return messages;
  }

  finish() {
    if (this.buffer.byteLength !== 0) fail("renderer", "CDP_PROTOCOL_INVALID");
  }
}

export function encodeCdpMessage(value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_CDP_MESSAGE_BYTES) fail("renderer", "CDP_PROTOCOL_INVALID");
  return Buffer.concat([bytes, Buffer.from([0])]);
}

export function createFunctionalReceipt(input) {
  const candidate = validateCandidate(input.candidate);
  const durationsMs = validateDurations(input.durationsMs);
  for (const key of [
    "initialSignedOut",
    "loginOperationObserved",
    "signedIn",
    "completedTurnStreamed",
    "completedTurnRenderedStream",
    "completedTurnRenderedUserItem",
    "completedTurnExactIdentity",
    "interruptedTurnRenderedUserItem",
    "interruptedTurnExactIdentity",
    "desktopRestartRecovered",
    "noReplay",
    "restartSignedIn",
    "loggedOut",
    "authJsonAbsent",
  ]) {
    if (input[key] !== true) fail("receipt", "RECEIPT_INVALID");
  }
  const receipt = {
    schemaVersion: 1,
    kind: EVIDENCE_KIND,
    evidenceClass: EVIDENCE_CLASS,
    outcome: "functional_passed_cleanup_required",
    platform: "win32",
    arch: "x64",
    privilegedDebugAuthority: true,
    workspaceSetup: WORKSPACE_SETUP,
    candidate,
    boundary: {
      externalInstalledCandidateExecutable: true,
      isolatedAppAndHostData: true,
      nativePath: ["renderer", "preload", "main", "local_hostd", "attested_codex_app_server"],
      mutationInput: "visible_renderer_controls",
      desktopLifecycleDrive: "exact_process_uia_titlebar_close_button",
      bridgeUse: "production_read_reconciliation_only",
      browserAuthorizationVisibleToHarness: false,
      initialAppAccountRequiredSignedOut: true,
      ambientCodexHomeOrKeyringInjected: false,
      systemBrowserSessionObserved: false,
      providerNetworkUsed: true,
    },
    account: {
      initialSignedOut: true,
      loginOperationObserved: true,
      signedIn: true,
      restartSignedIn: true,
      finalSignedOut: true,
    },
    completedTurn: {
      durableAdmissionObserved: true,
      renderedUserItemObserved: true,
      streamedDeltaObserved: true,
      renderedStreamingAssistantObserved: true,
      terminalState: "completed",
      exactOperationIdentity: true,
    },
    interruptedTurn: {
      durableAdmissionObserved: true,
      renderedUserItemObserved: true,
      terminalState: "interrupted",
      exactOperationIdentity: true,
    },
    recovery: {
      electronRestarted: true,
      hostdRestarted: false,
      backendIncarnationPreserved: true,
      exactConversationRecovered: true,
      noReplay: true,
    },
    security: {
      codexHomeAuthJsonAbsent: true,
      rawChildOutputEmitted: false,
      rawCdpPayloadEmitted: false,
    },
    cleanup: {
      status: "cleanup_required",
      vmRollbackOrDestructionConfirmed: false,
      fixtureRetained: true,
      detachedServiceMayRemain: true,
      externalVmDisposalRequired: true,
    },
    durationsMs,
    nonclaims: [...NONCLAIMS],
  };
  return validateReceipt(receipt);
}

export function createFailureReceipt(stage, code, cleanup = {}) {
  if (!STAGE_SET.has(stage) || !CODE_SET.has(code)) {
    stage = "receipt";
    code = "RECEIPT_INVALID";
  }
  return validateReceipt({
    schemaVersion: 1,
    kind: EVIDENCE_KIND,
    evidenceClass: EVIDENCE_CLASS,
    outcome: "failed",
    stage,
    code,
    cleanup: {
      status: "cleanup_unconfirmed",
      vmRollbackOrDestructionConfirmed: false,
      fixtureRetained: cleanup.fixtureCreated === true,
      detachedServiceMayRemain: cleanup.desktopStarted === true,
      helperProcessMayRemain: cleanup.helperMayRemain === true,
      externalVmDisposalRequired:
        cleanup.fixtureCreated === true || cleanup.desktopStarted === true || cleanup.helperMayRemain === true,
    },
    nonclaims: [...NONCLAIMS],
  });
}

export function serializeReceipt(receipt) {
  validateReceipt(receipt);
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(output, "utf8") > MAX_RECEIPT_BYTES) fail("receipt", "RECEIPT_INVALID");
  return output;
}

function validateReceipt(receipt) {
  const encoded = JSON.stringify(receipt);
  if (
    Buffer.byteLength(encoded, "utf8") > MAX_RECEIPT_BYTES ||
    /(?:[a-z]:\\|\\\\|file:\/\/|https?:\/\/)/iu.test(encoded) ||
    /"(?:token|email|accountId|planType|prompt|rawError|path|url|secret|password|cookie|credential|authorization|apiKey|accessKey|privateKey|refreshToken|sessionToken)"\s*:/iu.test(encoded)
  ) fail("receipt", "RECEIPT_INVALID");
  return Object.freeze(receipt);
}

function validateCandidate(value) {
  if (
    !value ||
    !VERSION.test(value.appVersion) ||
    !VERSION.test(value.runtimeReleaseVersion) ||
    !VERSION.test(value.codexAppServerReleaseVersion) ||
    !BUILD_ID.test(value.runtimeBuildId) ||
    value.assurance !== "development-integrity" ||
    !SHA256.test(value.installerSha256) ||
    !SHA256.test(value.installedExecutableSha256) ||
    !SHA256.test(value.applicationArchiveSha256) ||
    !SHA256.test(value.hostdSha256) ||
    !SHA256.test(value.runtimeManifestSha256) ||
    !SHA256.test(value.runtimeTreeSha256)
  ) fail("receipt", "RECEIPT_INVALID");
  return Object.freeze({ ...value });
}

function validateDurations(value) {
  const keys = ["total", "login", "completedTurn", "interruptedTurn", "desktopRestart", "logout"];
  if (!value || Object.keys(value).length !== keys.length) fail("receipt", "RECEIPT_INVALID");
  for (const key of keys) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 24 * 60 * 60 * 1_000) {
      fail("receipt", "RECEIPT_INVALID");
    }
  }
  return Object.freeze({ ...value });
}

function assertTurnTranscriptIdentity(snapshot, operationId, turnId, stage) {
  const relevant = snapshot?.transcript?.filter((item) => item.turnOperationId === operationId) ?? [];
  const users = relevant.filter((item) => item.role === "user");
  if (
    users.length !== 1 ||
    users[0].turnId !== turnId ||
    users[0].state !== "completed" ||
    relevant.some((item) => item.turnId !== turnId)
  ) fail(stage, "TURN_IDENTITY_INVALID");
}

function omitCurrentObservation(snapshot) {
  const { backendIncarnationId: _backendIncarnationId, revision: _revision, updatedAt: _updatedAt, ...durable } = snapshot;
  return durable;
}

function causallyMonotonic(before, after) {
  const left = Date.parse(before);
  const right = Date.parse(after);
  return Number.isFinite(left) && Number.isFinite(right) && right >= left;
}

function boundedId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && !/[\0\r\n]/u.test(value);
}

function accountResultFailureCode(stage) {
  if (stage === "desktop_restart") return "RECOVERY_NOT_PROVEN";
  if (stage === "logout") return "LOGOUT_NOT_PROVEN";
  if (stage === "initial_account" || stage === "login") return "ACCOUNT_STATE_INVALID";
  fail("receipt", "RECEIPT_INVALID");
}

function conversationResultFailureCode(stage) {
  if (stage === "completed_turn") return "TURN_NOT_COMPLETED";
  if (stage === "interrupted_turn") return "INTERRUPT_NOT_PROVEN";
  if (stage === "desktop_restart") return "RECOVERY_NOT_PROVEN";
  fail("receipt", "RECEIPT_INVALID");
}
