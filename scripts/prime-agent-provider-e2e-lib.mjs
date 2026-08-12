import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const EVIDENCE_KIND = "prime_continuim_prime_agent_provider_e2e";
export const EVIDENCE_CLASS = "opt_in_functional_e2e";
export const WORKSPACE_SETUP = "production_host_protocol_fixture";
export const DEDICATED_WINDOWS_USER = "PrimeAgentE2E";
export const OPT_IN_FLAG = "--i-understand-this-uses-live-prime-agent-oauth-and-provider";
export const DISPOSABLE_CHECKPOINT_FLAG = "--disposable-windows-checkpoint";
export const CHECKPOINT_ASSERTION = "DISPOSABLE_WINDOWS_CHECKPOINT_READY";
export const CONFIRMATION_PHRASE = "I AUTHORIZE LIVE PRIME AGENT OAUTH AND PROVIDER USE, TOOL AUTHORITY, PLAINTEXT AUTH CLEANUP, FIXTURE RETENTION ON UNCERTAINTY, AND DISPOSABLE VM DESTRUCTION";
export const MAX_CDP_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MAX_RECEIPT_BYTES = 12 * 1024;
// The retained verified v0.7.2 runtime root has 20,771 files and 1,699
// directories; the isolated root also contains bounded host/desktop journals.
export const MAX_ISOLATED_TEMP_TREE_ENTRIES = 50_000;
export const POST_RESTART_OBSERVATION_INTERVAL_MS = 4_000;
export const MIN_POST_RESTART_OBSERVATIONS = 3;

export const FAILURE_STAGES = Object.freeze([
  "admission",
  "candidate",
  "fixture",
  "hostd_start",
  "provision",
  "desktop_start",
  "renderer",
  "oauth",
  "model_selection",
  "prompt_stream",
  "stop",
  "restart",
  "no_replay",
  "end",
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
  "CREDENTIAL_ENVIRONMENT_FORBIDDEN",
  "CONFIRMATION_REJECTED",
  "CANDIDATE_INVALID",
  "FIXTURE_INVALID",
  "CUSTODY_PRECONDITION_FAILED",
  "HOSTD_UNAVAILABLE",
  "PROVISION_NOT_PROVEN",
  "DESKTOP_UNAVAILABLE",
  "CDP_PROTOCOL_INVALID",
  "RENDERER_UNAVAILABLE",
  "PREEXISTING_AUTHORITY",
  "OAUTH_NOT_COMPLETED",
  "MODEL_NOT_SELECTED",
  "PROMPT_NOT_ADMITTED",
  "STREAMING_NOT_OBSERVED",
  "STOP_NOT_PROVEN",
  "RESTART_NOT_PROVEN",
  "REPLAY_NOT_DISPROVEN",
  "END_NOT_PROVEN",
  "CLEANUP_UNCONFIRMED",
  "RECEIPT_INVALID",
  "INTERNAL_FAILURE",
]);

export const NONCLAIMS = Object.freeze([
  "not_sender_trust_or_security_evidence",
  "not_ordinary_user_authority",
  "not_installer_lifecycle_evidence",
  "not_signing_evidence",
  "not_native_picker_or_provision_ui_evidence",
  "not_provider_rpc_count_evidence",
  "not_browser_session_cleanup_evidence",
  "not_coding_tool_or_sandbox_evidence",
  "not_release_readiness_evidence",
  "not_vm_disposal_completion_evidence",
  "system_browser_session_state_not_observed",
  "desktop_command_submit_attempt_count_not_observed",
]);

const STAGES = new Set(FAILURE_STAGES);
const CODES = new Set(FAILURE_CODES);
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const PROVIDER_ID = "openai-codex";
const RECEIPT_KEYS = new Set([
  "schemaVersion", "kind", "evidenceClass", "outcome", "platform", "arch", "workspaceSetup",
  "candidate", "boundary", "proof", "cleanup", "disclosures", "durationsMs", "nonclaims", "stage", "code",
  "appVersion", "runtimeReleaseVersion", "runtimeBuildId", "assurance", "installerSha256",
  "installedExecutableSha256", "applicationArchiveSha256", "hostdSha256", "runtimeManifestSha256", "runtimeTreeSha256",
  "externalInstalledCandidateExecutable", "isolatedAppHostUserTemporaryAndWorkspaceData", "productionPrimeAgentRuntime",
  "productionHostProtocolFixtureProvision", "mutationInput", "desktopLifecycleDrive", "bridgeUse", "hostdLifecycleDrive",
  "browserLoginManual", "providerNetworkAndQuotaUsed", "oauthCompleted", "exactTargetModelSelected",
  "promptStreamAndStopObserved", "hostdAndDesktopRestartedWithChangedIdentities",
  "harnessReconciledExactPromptAndAbortWithoutDirectSubmission", "exactDurableProjectionStable",
  "noDurableContinuimOrProviderDispatchReplayObserved",
  "visibleEndReachedTerminalRetirement", "postRestartObservationCount", "minimumPostRestartObservationSeparationMs",
  "appDesktopAndOwnedHostdStoppedCleanly", "primeAgentCustodyLeafRemoved", "isolatedTemporaryRootRemoved",
  "externalVmDisposalRequired", "externalVmDisposalConfirmed", "status", "desktopMayRemain", "ownedHostdMayRemain",
  "custodyLeafMayRemain", "fixtureMayRemain", "helperMayRemain", "total", "oauth", "modelSelection", "promptAndStop",
  "restartAndNoReplay", "end",
]);
const SECRET_ENV = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTHORIZATION|COOKIE|PRIVATE_?KEY|REFRESH_?TOKEN|SESSION_?TOKEN)(?:_|$)/u;
const PROVIDER_ENV = /^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE_GENERATIVE_AI|AZURE_OPENAI|AWS|MISTRAL|GROQ|CEREBRAS|COHERE|TOGETHER|DEEPSEEK|OPENROUTER|PERPLEXITY|XAI)(?:_|$)/u;

export class ProviderE2eContractError extends Error {
  constructor(stage, code) {
    const valid = STAGES.has(stage) && CODES.has(code);
    super(valid ? `${stage}:${code}` : "receipt:RECEIPT_INVALID");
    this.name = "ProviderE2eContractError";
    this.stage = valid ? stage : "receipt";
    this.code = valid ? code : "RECEIPT_INVALID";
  }
}

export function fail(stage, code) {
  throw new ProviderE2eContractError(stage, code);
}

export function assertInteractiveAdmission(input) {
  if (input?.platform !== "win32") fail("admission", "WRONG_PLATFORM");
  if (input?.arch !== "x64") fail("admission", "WRONG_ARCH");
  if (input.stdinIsTTY !== true || input.stdoutIsTTY !== true) fail("admission", "INTERACTIVE_REQUIRED");
  if (input.ci !== undefined && input.ci !== false && input.ci !== "") fail("admission", "CI_FORBIDDEN");
  if (input.githubActions !== undefined && input.githubActions !== false && input.githubActions !== "") {
    fail("admission", "CI_FORBIDDEN");
  }
  const argv = Array.isArray(input.argv) ? input.argv : [];
  const flags = new Set(argv);
  if (argv.length !== 2 || flags.size !== 2 || !flags.has(OPT_IN_FLAG)) fail("admission", "OPT_IN_REQUIRED");
  if (!flags.has(DISPOSABLE_CHECKPOINT_FLAG) || input.checkpointAssertion !== CHECKPOINT_ASSERTION) {
    fail("admission", "DISPOSABLE_CHECKPOINT_REQUIRED");
  }
  for (const value of [input.username, input.tokenUsername, input.userProfileBasename]) {
    if (typeof value !== "string" || value.toLowerCase() !== DEDICATED_WINDOWS_USER.toLowerCase()) {
      fail("admission", "DEDICATED_USER_REQUIRED");
    }
  }
  if (input.uiCulture !== "en-US") fail("admission", "UNSUPPORTED_UI_CULTURE");
  if (
    !Array.isArray(input.groupSids) || input.groupSids.length < 1 || input.groupSids.length > 512 ||
    input.groupSids.some((sid) => typeof sid !== "string" || !/^S-1-\d+(?:-\d+)+$/u.test(sid)) ||
    input.groupSids.length !== new Set(input.groupSids).size ||
    input.groupSids.includes("S-1-5-32-544")
  ) fail("admission", "ELEVATED_TOKEN_FORBIDDEN");
  if (!Array.isArray(input.integritySids) || input.integritySids.length !== 1 || input.integritySids[0] !== "S-1-16-8192") {
    fail("admission", "ELEVATED_TOKEN_FORBIDDEN");
  }
  if (!isDeepStrictEqual(input.groupSids.filter((sid) => /^S-1-16-\d+$/u.test(sid)), input.integritySids)) {
    fail("admission", "ELEVATED_TOKEN_FORBIDDEN");
  }
  return Object.freeze({ admitted: true });
}

export function assertNoCredentialEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    fail("admission", "CREDENTIAL_ENVIRONMENT_FORBIDDEN");
  }
  const forbidden = Object.entries(environment).filter(([name, value]) =>
    value !== undefined && value !== "" && isCredentialVariable(name.toUpperCase()));
  if (forbidden.length > 0) fail("admission", "CREDENTIAL_ENVIRONMENT_FORBIDDEN");
  return true;
}

export function credentialStrippedEnvironment(source, options = {}) {
  const environment = {};
  let stripped = 0;
  for (const [name, value] of Object.entries(source ?? {})) {
    if (value === undefined) continue;
    const normalized = name.toUpperCase();
    if (
      isCredentialVariable(normalized) ||
      normalized === "NODE_OPTIONS" ||
      normalized === "NODE_PATH" ||
      normalized === "ELECTRON_RUN_AS_NODE" ||
      normalized === "PRIME_AGENT_CODING_AGENT_DIR" ||
      normalized === "PRIME_CONTINUIM_ENABLE_PLAINTEXT_OAUTH_DEV" ||
      normalized.startsWith("PRIME_AGENT_INTERNAL_") ||
      normalized === "PRIME_AGENT_BUILD_ID" ||
      normalized === "PRIME_AGENT_LAUNCHER_PATH"
    ) {
      if (isCredentialVariable(normalized)) stripped += 1;
      continue;
    }
    environment[name] = value;
  }
  if (options.electronRunAsNode === true) environment.ELECTRON_RUN_AS_NODE = "1";
  if (options.packageSmoke === true) environment.PRIME_CONTINUIM_PACKAGE_SMOKE = "1";
  return Object.freeze({ environment: Object.freeze(environment), strippedCredentialVariableCount: stripped });
}

export function assertTypedConfirmation(value) {
  if (value !== CONFIRMATION_PHRASE) fail("admission", "CONFIRMATION_REJECTED");
  return true;
}

export function validateInitialPrimeAgentCatalog(value) {
  const catalog = validateCatalog(value, "oauth", "OAUTH_NOT_COMPLETED");
  const provider = exactProvider(catalog);
  if (provider.configured !== false || provider.oauthSupported !== true || provider.availableModelCount !== 0) {
    fail("oauth", "PREEXISTING_AUTHORITY");
  }
  if (catalog.models.some((model) => model.providerId === PROVIDER_ID && model.available === true)) {
    fail("oauth", "PREEXISTING_AUTHORITY");
  }
  return catalog;
}

export function validateAuthenticatedPrimeAgentCatalog(value, targetModelId) {
  if (!MODEL_ID.test(targetModelId ?? "")) fail("model_selection", "MODEL_NOT_SELECTED");
  const catalog = validateCatalog(value, "oauth", "OAUTH_NOT_COMPLETED");
  const provider = exactProvider(catalog);
  const model = catalog.models.find((candidate) =>
    candidate?.providerId === PROVIDER_ID && candidate?.modelId === targetModelId);
  if (
    provider.configured !== true ||
    provider.oauthSupported !== true ||
    provider.availableModelCount < 1 ||
    !model ||
    model.available !== true ||
    model.usingOAuth !== true
  ) fail("oauth", "OAUTH_NOT_COMPLETED");
  return Object.freeze({ catalog, provider, model });
}

export function validateSelectedModelProjection(snapshot, expected) {
  const projection = validateResidentProjection(snapshot, "model_selection", "MODEL_NOT_SELECTED");
  if (!MODEL_ID.test(expected?.modelId ?? "") || projection.runtime?.model !== `${PROVIDER_ID}/${expected.modelId}`) {
    fail("model_selection", "MODEL_NOT_SELECTED");
  }
  if (expected?.threadId && projection.thread.threadId !== expected.threadId) fail("model_selection", "MODEL_NOT_SELECTED");
  return projection;
}

export function hasVisibleAssistantStreamEvidence(observations) {
  if (!Array.isArray(observations) || observations.length < 2 || observations.length > 1_024) return false;
  const first = observations[0];
  if (!validVisibleStreamObservation(first)) return false;
  for (let index = 1; index < observations.length; index += 1) {
    const candidate = observations[index];
    if (
      !validVisibleStreamObservation(candidate) ||
      candidate.blockId !== first.blockId ||
      candidate.streamText.length <= first.streamText.length ||
      !candidate.streamText.startsWith(first.streamText) ||
      candidate.visibleAssistantText.length <= first.visibleAssistantText.length ||
      !candidate.visibleAssistantText.startsWith(first.visibleAssistantText)
    ) continue;
    return true;
  }
  return false;
}

export function uniqueExactVisibleModelRowIndex(rows, expected) {
  if (
    !Array.isArray(rows) || rows.length > 4_096 || expected?.providerId !== PROVIDER_ID ||
    typeof expected?.providerDisplayName !== "string" || expected.providerDisplayName.length < 1 ||
    expected.providerDisplayName.length > 255 || !MODEL_ID.test(expected?.modelId ?? "")
  ) fail("model_selection", "MODEL_NOT_SELECTED");
  const identityMatches = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (
      !row || typeof row !== "object" || row.providerId !== PROVIDER_ID ||
      typeof row.providerDisplayName !== "string" || !MODEL_ID.test(row.modelId ?? "") ||
      !Number.isSafeInteger(row.visibleSelectActionCount) || row.visibleSelectActionCount < 0 || row.visibleSelectActionCount > 1
    ) fail("model_selection", "MODEL_NOT_SELECTED");
    if (
      row.providerDisplayName === expected.providerDisplayName && row.modelId === expected.modelId
    ) identityMatches.push(index);
  }
  if (identityMatches.length > 1) fail("model_selection", "MODEL_NOT_SELECTED");
  const exact = identityMatches[0];
  return exact !== undefined && rows[exact].visibleSelectActionCount === 1 ? exact : undefined;
}

export function parseVisibleModelRowMetadata(markup) {
  if (typeof markup !== "string" || markup.length < 1 || markup.length > 256 * 1024) {
    fail("model_selection", "MODEL_NOT_SELECTED");
  }
  const metadata = [...markup.matchAll(/<bdi(?:\s[^>]*)?>([\s\S]*?)<\/bdi>/giu)]
    .map((match) => visibleHtmlText(match[1] ?? ""));
  if (
    metadata.length !== 2 || metadata[0].length < 1 || metadata[0].length > 255 ||
    !MODEL_ID.test(metadata[1])
  ) fail("model_selection", "MODEL_NOT_SELECTED");
  return Object.freeze({ providerDisplayName: metadata[0], modelId: metadata[1] });
}

export function validateStopTransition(active, terminal, journalEvidence) {
  const before = validateResidentProjection(active, "stop", "STOP_NOT_PROVEN");
  const after = validateResidentProjection(terminal, "stop", "STOP_NOT_PROVEN");
  if (
    before.thread.threadId !== after.thread.threadId ||
    before.thread.currentLocation?.executionGenerationId !== after.thread.currentLocation?.executionGenerationId ||
    before.thread.status !== "running" ||
    after.thread.status !== "idle" ||
    !before.inProgressStream ||
    after.inProgressStream !== undefined ||
    !Array.isArray(after.queueState?.pendingCommandIds) || after.queueState.pendingCommandIds.length !== 0 ||
    after.queueState.paused !== false
  ) fail("stop", "STOP_NOT_PROVEN");
  const prompt = journalEvidence?.promptEnvelope;
  const abort = journalEvidence?.abortEnvelope;
  const receipts = journalEvidence?.receipts;
  if (
    !commandEnvelope(prompt, "prompt", before.thread.threadId) ||
    !commandEnvelope(abort, "abort", before.thread.threadId) ||
    prompt.commandId === abort.commandId ||
    !Array.isArray(receipts) || receipts.length !== 2 ||
    !receipts.every((receipt) => receipt?.status === "completed" && boundedId(receipt.commandId)) ||
    !receipts.some((receipt) => receipt.commandId === prompt.commandId) ||
    !receipts.some((receipt) => receipt.commandId === abort.commandId)
  ) fail("stop", "STOP_NOT_PROVEN");
  return Object.freeze({ promptEnvelope: prompt, abortEnvelope: abort, receipts: Object.freeze([...receipts]) });
}

export function validateRestartNoReplay(input) {
  if (
    !input ||
    !boundedId(input.hostdIdentityBefore) ||
    !boundedId(input.hostdIdentityAfter) ||
    input.hostdIdentityBefore === input.hostdIdentityAfter ||
    !boundedId(input.desktopIdentityBefore) ||
    !boundedId(input.desktopIdentityAfter) ||
    input.desktopIdentityBefore === input.desktopIdentityAfter ||
    !Array.isArray(input.observations) ||
    input.observations.length < MIN_POST_RESTART_OBSERVATIONS ||
    input.observations.length > 128
  ) fail("restart", "RESTART_NOT_PROVEN");

  const expected = durableProjection(input.beforeRestart);
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
    if (!isDeepStrictEqual(durableProjection(observation.snapshot), expected)) fail("restart", "RESTART_NOT_PROVEN");
    previousTime = observation.observedAtMonotonicMs;
  }
  if (
    !sameIdSet(input.journalIdsBefore, input.journalIdsAfter) ||
    !sameIdSet(input.reconciledCommandIds, input.expectedCommandIds) ||
    input.dispatchAttemptCount !== 0 ||
    input.outboxEntryCount !== 0
  ) fail("no_replay", "REPLAY_NOT_DISPROVEN");
  return Object.freeze({
    hostdRestarted: true,
    desktopRestarted: true,
    exactProjectionStable: true,
    exactJournalIdsUnchanged: true,
    exactCommandsReconciledByHarness: true,
    residentDispatchAttemptsEmpty: true,
    outboxEmpty: true,
    postRestartObservationCount: input.observations.length,
    minimumPostRestartObservationSeparationMs: minimumGap,
  });
}

export function validateTerminalResidentProjection(snapshot, expected) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) fail("end", "END_NOT_PROVEN");
  if (
    snapshot.thread?.threadId !== expected?.threadId ||
    snapshot.thread?.currentLocation?.executionGenerationId !== expected?.executionGenerationId ||
    snapshot.runtime !== undefined ||
    snapshot.inProgressStream !== undefined ||
    snapshot.residentLifecycle?.state !== "ended" ||
    snapshot.residentLifecycle?.reason !== "user_end" ||
    snapshot.queueState?.pendingCommandIds?.length !== 0
  ) fail("end", "END_NOT_PROVEN");
  return snapshot;
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
    const messages = [];
    let separator;
    while ((separator = this.buffer.indexOf(0)) >= 0) {
      const bytes = this.buffer.subarray(0, separator);
      this.buffer = this.buffer.subarray(separator + 1);
      if (bytes.byteLength < 2 || bytes.byteLength > this.maxMessageBytes) fail("renderer", "CDP_PROTOCOL_INVALID");
      try {
        const value = JSON.parse(bytes.toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) fail("renderer", "CDP_PROTOCOL_INVALID");
        messages.push(value);
      } catch (error) {
        if (error instanceof ProviderE2eContractError) throw error;
        fail("renderer", "CDP_PROTOCOL_INVALID");
      }
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
  const candidate = validateCandidate(input?.candidate);
  const facts = [
    "boundInstalledArtifactsExact",
    "primeAgentOauthCompleted",
    "targetModelSelected",
    "visiblePromptSubmitted",
    "visibleStreamObserved",
    "visibleStopInvoked",
    "stopTerminalReceiptObserved",
    "desktopClosedOrderlyBeforeRestart",
    "hostdStoppedCleanly",
    "hostdRestarted",
    "desktopRestarted",
    "hostdProcessIdentityChanged",
    "desktopProcessIdentityChanged",
    "harnessReconciledExactPromptAndAbortWithoutDirectSubmission",
    "residentDispatchAttemptsEmpty",
    "outboxEmpty",
    "journalIdsUnchanged",
    "noDurableContinuimOrProviderDispatchReplayObserved",
    "visibleEndInvoked",
    "terminalProjectionObserved",
    "retiredBindingObserved",
    "zeroDaemonSessionsObserved",
    "finalDesktopCloseOrderly",
    "finalHostdStopCleanly",
    "candidateArtifactsUnchanged",
    "custodyLeafRemoved",
    "temporaryRootRemoved",
  ];
  for (const fact of facts) if (input?.[fact] !== true) fail("receipt", "RECEIPT_INVALID");
  if (
    !Number.isSafeInteger(input.postRestartObservationCount) ||
    input.postRestartObservationCount < MIN_POST_RESTART_OBSERVATIONS ||
    !Number.isSafeInteger(input.minimumPostRestartObservationSeparationMs) ||
    input.minimumPostRestartObservationSeparationMs < POST_RESTART_OBSERVATION_INTERVAL_MS
  ) fail("receipt", "RECEIPT_INVALID");
  const durationsMs = validateDurations(input.durationsMs);
  return validateReceipt({
    schemaVersion: 1,
    kind: EVIDENCE_KIND,
    evidenceClass: EVIDENCE_CLASS,
    outcome: "functional_passed_vm_disposal_required",
    platform: "win32",
    arch: "x64",
    workspaceSetup: WORKSPACE_SETUP,
    candidate,
    boundary: {
      externalInstalledCandidateExecutable: true,
      isolatedAppHostUserTemporaryAndWorkspaceData: true,
      productionPrimeAgentRuntime: true,
      productionHostProtocolFixtureProvision: true,
      mutationInput: "visible_renderer_controls",
      desktopLifecycleDrive: "exact_process_uia_titlebar_close_button",
      bridgeUse: "production_snapshot_call_may_persist_projection_cache",
      hostdLifecycleDrive: "owned_stdin_to_sigterm_wrapper",
      browserLoginManual: true,
      providerNetworkAndQuotaUsed: true,
    },
    proof: {
      oauthCompleted: true,
      exactTargetModelSelected: true,
      promptStreamAndStopObserved: true,
      hostdAndDesktopRestartedWithChangedIdentities: true,
      harnessReconciledExactPromptAndAbortWithoutDirectSubmission: true,
      exactDurableProjectionStable: true,
      noDurableContinuimOrProviderDispatchReplayObserved: true,
      visibleEndReachedTerminalRetirement: true,
      postRestartObservationCount: input.postRestartObservationCount,
      minimumPostRestartObservationSeparationMs: input.minimumPostRestartObservationSeparationMs,
    },
    cleanup: {
      appDesktopAndOwnedHostdStoppedCleanly: true,
      primeAgentCustodyLeafRemoved: true,
      isolatedTemporaryRootRemoved: true,
      externalVmDisposalRequired: true,
      externalVmDisposalConfirmed: false,
    },
    disclosures: [
      "live_prime_agent_oauth_provider_network_and_quota_used",
      "prime_agent_tool_authority_is_not_a_workspace_only_sandbox",
      "plaintext_oauth_material_removed_only_with_proven_custody_leaf_cleanup",
      "system_browser_session_may_persist_until_external_vm_disposal",
      "external_vm_rollback_or_destruction_remains_mandatory",
    ],
    durationsMs,
    nonclaims: [...NONCLAIMS],
  });
}

export function createFailureReceipt(stage, code, cleanup = {}) {
  if (!STAGES.has(stage) || !CODES.has(code)) {
    stage = "receipt";
    code = "RECEIPT_INVALID";
  }
  return validateReceipt({
    schemaVersion: 1,
    kind: EVIDENCE_KIND,
    evidenceClass: EVIDENCE_CLASS,
    outcome: "failed_vm_disposal_required",
    stage,
    code,
    cleanup: {
      status: "cleanup_unconfirmed",
      desktopMayRemain: cleanup.desktopStarted === true,
      ownedHostdMayRemain: cleanup.hostdStarted === true,
      custodyLeafMayRemain: cleanup.custodyObserved === true,
      fixtureMayRemain: cleanup.fixtureCreated === true,
      helperMayRemain: cleanup.helperMayRemain === true,
      externalVmDisposalRequired: true,
      externalVmDisposalConfirmed: false,
    },
    disclosures: [
      "live_prime_agent_oauth_provider_authority_may_have_been_used",
      "plaintext_oauth_material_or_system_browser_state_may_remain",
      "external_vm_rollback_or_destruction_is_mandatory",
    ],
    nonclaims: [...NONCLAIMS],
  });
}

export function serializeReceipt(receipt) {
  validateReceipt(receipt);
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(output, "utf8") > MAX_RECEIPT_BYTES) fail("receipt", "RECEIPT_INVALID");
  return output;
}

/**
 * Remove only a harness-created, physically canonical temporary root after all
 * owned processes have positively completed. Any link, escape, size overflow,
 * or shutdown uncertainty makes the fixture retention/VM-destruction path the
 * only permitted cleanup authority.
 */
export async function removeIsolatedTemporaryRoot(options) {
  const root = options?.root;
  const expectedPrefix = options?.expectedPrefix;
  if (
    options?.confirmedCleanShutdown !== true ||
    typeof root !== "string" || !isAbsolute(root) || /[\0\r\n]/u.test(root) ||
    typeof expectedPrefix !== "string" || !/^[a-z0-9-]{8,64}$/u.test(expectedPrefix)
  ) fail("cleanup", "CLEANUP_UNCONFIRMED");
  let canonical;
  try {
    canonical = await realpath(root);
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("cleanup", "CLEANUP_UNCONFIRMED");
  } catch (error) {
    if (error instanceof ProviderE2eContractError) throw error;
    fail("cleanup", "CLEANUP_UNCONFIRMED");
  }
  const leaf = canonical.split(/[\\/]/u).at(-1) ?? "";
  if (!leaf.startsWith(expectedPrefix) || canonical !== resolve(root)) fail("cleanup", "CLEANUP_UNCONFIRMED");
  const pending = [{ directory: canonical, depth: 0 }];
  let entries = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > 32) fail("cleanup", "CLEANUP_UNCONFIRMED");
    const children = await readdir(current.directory, { withFileTypes: true });
    for (const child of children) {
      entries += 1;
      if (entries > MAX_ISOLATED_TEMP_TREE_ENTRIES) fail("cleanup", "CLEANUP_UNCONFIRMED");
      const path = resolve(current.directory, child.name);
      const fromRoot = relative(canonical, path);
      if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        fail("cleanup", "CLEANUP_UNCONFIRMED");
      }
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        fail("cleanup", "CLEANUP_UNCONFIRMED");
      }
      if (metadata.isDirectory()) pending.push({ directory: path, depth: current.depth + 1 });
      else {
        bytes += metadata.size;
        if (bytes > 512 * 1024 * 1024) fail("cleanup", "CLEANUP_UNCONFIRMED");
      }
    }
  }
  await rm(canonical, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
  return Object.freeze({ removed: true, entries, bytes });
}

export async function digestBoundedRegularFileTree(root, options) {
  const maxFiles = options?.maxFiles;
  const maxBytes = options?.maxBytes;
  if (
    typeof root !== "string" || !isAbsolute(root) || /[\0\r\n]/u.test(root) ||
    !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024 * 1024
  ) fail("candidate", "CANDIDATE_INVALID");
  const rootMetadata = await lstat(root);
  const canonicalRoot = await realpath(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || canonicalRoot !== resolve(root)) {
    fail("candidate", "CANDIDATE_INVALID");
  }
  const pending = [canonicalRoot];
  const directories = [];
  const files = [];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        fail("candidate", "CANDIDATE_INVALID");
      }
      if (metadata.isDirectory()) {
        if (directories.length >= maxFiles) fail("candidate", "CANDIDATE_INVALID");
        directories.push(relative(canonicalRoot, path).replaceAll("\\", "/"));
        pending.push(path);
        continue;
      }
      totalBytes += metadata.size;
      if (files.length >= maxFiles || totalBytes > maxBytes) fail("candidate", "CANDIDATE_INVALID");
      files.push(Object.freeze({
        path: await realpath(path),
        relative: relative(canonicalRoot, path).replaceAll("\\", "/"),
        sha256: await sha256File(path),
        bytes: metadata.size,
      }));
    }
  }
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  directories.sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const directory of directories) hash.update(`directory\0${directory}\n`, "utf8");
  for (const file of files) hash.update(`${file.relative}\0${file.bytes}\0${file.sha256}\n`, "utf8");
  return Object.freeze({
    canonicalRoot,
    sha256: hash.digest("hex"),
    fileCount: files.length,
    totalBytes,
    files: Object.freeze(files),
  });
}

function validateCatalog(value, stage, code) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    value.runtime !== "prime_agent" ||
    !VERSION.test(value.releaseVersion ?? "") ||
    !Array.isArray(value.providers) || value.providers.length > 256 ||
    !Array.isArray(value.models) || value.models.length > 4_096
  ) fail(stage, code);
  return value;
}

function validVisibleStreamObservation(value) {
  return value && boundedId(value.blockId) &&
    typeof value.streamText === "string" && value.streamText.length > 0 && value.streamText.length <= 1024 * 1024 &&
    typeof value.visibleAssistantText === "string" && value.visibleAssistantText.length > 0 && value.visibleAssistantText.length <= 1024 * 1024;
}

function visibleHtmlText(value) {
  return value
    .replace(/<[^>]+>/gu, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/\s+/gu, " ")
    .trim();
}

async function sha256File(path) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}

function exactProvider(catalog) {
  const providers = catalog.providers.filter((provider) => provider?.providerId === PROVIDER_ID);
  if (providers.length !== 1) fail("oauth", "OAUTH_NOT_COMPLETED");
  return providers[0];
}

function validateResidentProjection(value, stage, code) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    !boundedId(value.thread?.threadId) ||
    !boundedId(value.thread?.currentLocation?.executionGenerationId) ||
    value.runtime?.runtime !== "prime_agent" ||
    value.runtime?.residency !== "resident" ||
    !boundedId(value.runtime?.activeSessionId) ||
    !boundedId(value.runtime?.sessionId)
  ) fail(stage, code);
  return value;
}

function commandEnvelope(value, kind, threadId) {
  return value && value.protocolVersion === 1 && boundedId(value.commandId) && value.threadId === threadId &&
    value.command?.kind === kind && (kind !== "prompt" || typeof value.command.text === "string") &&
    (kind !== "abort" || typeof value.command.reason === "string");
}

function durableProjection(snapshot) {
  const projection = validateResidentProjection(snapshot, "restart", "RESTART_NOT_PROVEN");
  return {
    snapshotVersion: projection.snapshotVersion,
    thread: projection.thread,
    transcriptBlockIndex: projection.transcriptBlockIndex,
    materializedRecentBlocks: projection.materializedRecentBlocks,
    inProgressStream: projection.inProgressStream,
    queueState: projection.queueState,
    approvals: projection.approvals,
    childAgents: projection.childAgents,
    goals: projection.goals,
    schedules: projection.schedules,
    runtime: projection.runtime,
    residentLifecycle: projection.residentLifecycle,
    git: projection.git,
    evidence: projection.evidence,
    pendingAttention: projection.pendingAttention,
    latestCursor: projection.latestCursor,
  };
}

function sameIdSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.some((id) => !boundedId(id)) || right.some((id) => !boundedId(id))) {
    return false;
  }
  return left.length === new Set(left).size && right.length === new Set(right).size &&
    isDeepStrictEqual([...left].sort(), [...right].sort());
}

function validateCandidate(value) {
  const keys = [
    "appVersion",
    "runtimeReleaseVersion",
    "runtimeBuildId",
    "assurance",
    "installerSha256",
    "installedExecutableSha256",
    "applicationArchiveSha256",
    "hostdSha256",
    "runtimeManifestSha256",
    "runtimeTreeSha256",
  ];
  if (
    !value ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()) ||
    !VERSION.test(value.appVersion ?? "") ||
    !VERSION.test(value.runtimeReleaseVersion ?? "") ||
    !boundedId(value.runtimeBuildId) ||
    value.assurance !== "development-integrity"
  ) fail("receipt", "RECEIPT_INVALID");
  for (const key of keys.slice(4)) if (!SHA256.test(value[key] ?? "")) fail("receipt", "RECEIPT_INVALID");
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

function validateDurations(value) {
  const keys = ["total", "oauth", "modelSelection", "promptAndStop", "restartAndNoReplay", "end"];
  if (!value || Object.keys(value).length !== keys.length) fail("receipt", "RECEIPT_INVALID");
  for (const key of keys) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 24 * 60 * 60 * 1_000) {
      fail("receipt", "RECEIPT_INVALID");
    }
  }
  return Object.freeze({ ...value });
}

function validateReceipt(receipt) {
  assertExactReceiptShape(receipt);
  assertReceiptValuesAllowed(receipt, new Set());
  const encoded = JSON.stringify(receipt);
  if (
    Buffer.byteLength(encoded, "utf8") > MAX_RECEIPT_BYTES ||
    /(?:[a-z]:\\|\\\\|file:\/\/|https?:\/\/)/iu.test(encoded) ||
    /"(?:token|email|accountId|planType|prompt|rawError|path|url|secret|password|cookie|credential|authorization|apiKey|accessKey|privateKey|refreshToken|sessionToken|modelId|providerId)"\s*:/iu.test(encoded)
  ) fail("receipt", "RECEIPT_INVALID");
  return Object.freeze(receipt);
}

function assertExactReceiptShape(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) fail("receipt", "RECEIPT_INVALID");
  const base = {
    schemaVersion: 1,
    kind: EVIDENCE_KIND,
    evidenceClass: EVIDENCE_CLASS,
  };
  for (const [key, value] of Object.entries(base)) if (receipt[key] !== value) fail("receipt", "RECEIPT_INVALID");
  if (receipt.outcome === "functional_passed_vm_disposal_required") {
    requireExactKeys(receipt, [
      "schemaVersion", "kind", "evidenceClass", "outcome", "platform", "arch", "workspaceSetup", "candidate",
      "boundary", "proof", "cleanup", "disclosures", "durationsMs", "nonclaims",
    ]);
    if (receipt.platform !== "win32" || receipt.arch !== "x64" || receipt.workspaceSetup !== WORKSPACE_SETUP) {
      fail("receipt", "RECEIPT_INVALID");
    }
    validateCandidate(receipt.candidate);
    requireExactObject(receipt.boundary, {
      externalInstalledCandidateExecutable: true,
      isolatedAppHostUserTemporaryAndWorkspaceData: true,
      productionPrimeAgentRuntime: true,
      productionHostProtocolFixtureProvision: true,
      mutationInput: "visible_renderer_controls",
      desktopLifecycleDrive: "exact_process_uia_titlebar_close_button",
      bridgeUse: "production_snapshot_call_may_persist_projection_cache",
      hostdLifecycleDrive: "owned_stdin_to_sigterm_wrapper",
      browserLoginManual: true,
      providerNetworkAndQuotaUsed: true,
    });
    requireExactKeys(receipt.proof, [
      "oauthCompleted", "exactTargetModelSelected", "promptStreamAndStopObserved",
      "hostdAndDesktopRestartedWithChangedIdentities", "harnessReconciledExactPromptAndAbortWithoutDirectSubmission",
      "exactDurableProjectionStable", "noDurableContinuimOrProviderDispatchReplayObserved", "visibleEndReachedTerminalRetirement",
      "postRestartObservationCount", "minimumPostRestartObservationSeparationMs",
    ]);
    for (const key of [
      "oauthCompleted", "exactTargetModelSelected", "promptStreamAndStopObserved",
      "hostdAndDesktopRestartedWithChangedIdentities", "harnessReconciledExactPromptAndAbortWithoutDirectSubmission",
      "exactDurableProjectionStable", "noDurableContinuimOrProviderDispatchReplayObserved", "visibleEndReachedTerminalRetirement",
    ]) if (receipt.proof[key] !== true) fail("receipt", "RECEIPT_INVALID");
    if (
      !Number.isSafeInteger(receipt.proof.postRestartObservationCount) ||
      receipt.proof.postRestartObservationCount < MIN_POST_RESTART_OBSERVATIONS ||
      !Number.isSafeInteger(receipt.proof.minimumPostRestartObservationSeparationMs) ||
      receipt.proof.minimumPostRestartObservationSeparationMs < POST_RESTART_OBSERVATION_INTERVAL_MS
    ) fail("receipt", "RECEIPT_INVALID");
    requireExactObject(receipt.cleanup, {
      appDesktopAndOwnedHostdStoppedCleanly: true,
      primeAgentCustodyLeafRemoved: true,
      isolatedTemporaryRootRemoved: true,
      externalVmDisposalRequired: true,
      externalVmDisposalConfirmed: false,
    });
    if (!isDeepStrictEqual(receipt.disclosures, [
      "live_prime_agent_oauth_provider_network_and_quota_used",
      "prime_agent_tool_authority_is_not_a_workspace_only_sandbox",
      "plaintext_oauth_material_removed_only_with_proven_custody_leaf_cleanup",
      "system_browser_session_may_persist_until_external_vm_disposal",
      "external_vm_rollback_or_destruction_remains_mandatory",
    ])) fail("receipt", "RECEIPT_INVALID");
    validateDurations(receipt.durationsMs);
  } else if (receipt.outcome === "failed_vm_disposal_required") {
    requireExactKeys(receipt, [
      "schemaVersion", "kind", "evidenceClass", "outcome", "stage", "code", "cleanup", "disclosures", "nonclaims",
    ]);
    if (!STAGES.has(receipt.stage) || !CODES.has(receipt.code)) fail("receipt", "RECEIPT_INVALID");
    requireExactKeys(receipt.cleanup, [
      "status", "desktopMayRemain", "ownedHostdMayRemain", "custodyLeafMayRemain", "fixtureMayRemain",
      "helperMayRemain", "externalVmDisposalRequired", "externalVmDisposalConfirmed",
    ]);
    if (
      receipt.cleanup.status !== "cleanup_unconfirmed" ||
      receipt.cleanup.externalVmDisposalRequired !== true || receipt.cleanup.externalVmDisposalConfirmed !== false ||
      ["desktopMayRemain", "ownedHostdMayRemain", "custodyLeafMayRemain", "fixtureMayRemain", "helperMayRemain"]
        .some((key) => typeof receipt.cleanup[key] !== "boolean")
    ) fail("receipt", "RECEIPT_INVALID");
    if (!isDeepStrictEqual(receipt.disclosures, [
      "live_prime_agent_oauth_provider_authority_may_have_been_used",
      "plaintext_oauth_material_or_system_browser_state_may_remain",
      "external_vm_rollback_or_destruction_is_mandatory",
    ])) fail("receipt", "RECEIPT_INVALID");
  } else {
    fail("receipt", "RECEIPT_INVALID");
  }
  if (!isDeepStrictEqual(receipt.nonclaims, [...NONCLAIMS])) fail("receipt", "RECEIPT_INVALID");
}

function requireExactObject(value, expected) {
  requireExactKeys(value, Object.keys(expected));
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) fail("receipt", "RECEIPT_INVALID");
  }
}

function requireExactKeys(value, keys) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
  ) fail("receipt", "RECEIPT_INVALID");
}

function assertReceiptValuesAllowed(value, ancestors) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (
      value.length > 1_024 || value.startsWith("/") || value.startsWith("~/") ||
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value) ||
      /^(?:Bearer\s+|(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs])[-_])[A-Za-z0-9._-]{8,}$/iu.test(value) ||
      /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)
    ) fail("receipt", "RECEIPT_INVALID");
    return;
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) fail("receipt", "RECEIPT_INVALID");
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (value.length > 128) fail("receipt", "RECEIPT_INVALID");
    for (const entry of value) assertReceiptValuesAllowed(entry, ancestors);
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail("receipt", "RECEIPT_INVALID");
    for (const [key, entry] of Object.entries(value)) {
      if (!RECEIPT_KEYS.has(key)) fail("receipt", "RECEIPT_INVALID");
      assertReceiptValuesAllowed(entry, ancestors);
    }
  }
  ancestors.delete(value);
}

function boundedId(value) {
  return typeof value === "string" && ID.test(value);
}

function isCredentialVariable(name) {
  return SECRET_ENV.test(name) || PROVIDER_ENV.test(name);
}
