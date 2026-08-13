export const EVIDENCE_KIND: "prime_continuim_prime_agent_provider_e2e";
export const EVIDENCE_CLASS: "opt_in_functional_e2e";
export const WORKSPACE_SETUP: "production_host_protocol_fixture";
export const DEDICATED_WINDOWS_USER: "PrimeAgentE2E";
export const OPT_IN_FLAG: string;
export const DISPOSABLE_CHECKPOINT_FLAG: string;
export const CHECKPOINT_ASSERTION: string;
export const CONFIRMATION_PHRASE: string;
export const MAX_CDP_MESSAGE_BYTES: number;
export const MAX_RECEIPT_BYTES: number;
export const MAX_ISOLATED_TEMP_TREE_ENTRIES: 50000;
export const POST_RESTART_OBSERVATION_INTERVAL_MS: 4000;
export const MIN_POST_RESTART_OBSERVATIONS: 3;
export const FAILURE_STAGES: readonly string[];
export const FAILURE_CODES: readonly string[];
export const NONCLAIMS: readonly string[];

export class ProviderE2eContractError extends Error {
  readonly stage: string;
  readonly code: string;
  constructor(stage: string, code: string);
}

export function fail(stage: string, code: string): never;
export function assertInteractiveAdmission(input: {
  readonly platform: string;
  readonly arch: string;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly ci?: string | boolean;
  readonly githubActions?: string | boolean;
  readonly argv: readonly string[];
  readonly checkpointAssertion?: string;
  readonly username?: string;
  readonly tokenUsername?: string;
  readonly userProfileBasename?: string;
  readonly uiCulture?: string;
  readonly groupSids?: readonly string[];
  readonly integritySids?: readonly string[];
}): Readonly<{ admitted: true }>;
export function assertNoCredentialEnvironment(environment: Readonly<NodeJS.ProcessEnv>): true;
export function credentialStrippedEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  options?: Readonly<{ electronRunAsNode?: boolean; packageSmoke?: boolean }>,
): Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
  strippedCredentialVariableCount: number;
}>;
export function assertTypedConfirmation(value: string): true;

export interface PrimeAgentProviderCatalog {
  readonly runtime: "prime_agent";
  readonly releaseVersion: string;
  readonly providers: readonly Record<string, unknown>[];
  readonly models: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

export function validateInitialPrimeAgentCatalog(value: unknown): PrimeAgentProviderCatalog;
export function validateAuthenticatedPrimeAgentCatalog(
  value: unknown,
  targetModelId: string,
): Readonly<{
  catalog: PrimeAgentProviderCatalog;
  provider: Record<string, unknown>;
  model: Record<string, unknown>;
}>;
export function validateSelectedModelProjection(snapshot: unknown, expected: {
  readonly modelId: string;
  readonly threadId?: string;
}): Record<string, unknown>;
export function hasVisibleAssistantStreamEvidence(observations: readonly Readonly<{
  blockId: string;
  streamText: string;
  visibleAssistantText: string;
}>[]): boolean;
export function uniqueExactVisibleModelRowIndex(
  rows: readonly Readonly<{
    providerId: string;
    providerDisplayName: string;
    modelId: string;
    visibleSelectActionCount: number;
  }>[],
  expected: Readonly<{ providerId: string; providerDisplayName: string; modelId: string }>,
): number | undefined;
export function parseVisibleModelRowMetadata(serializedMetadata: string): Readonly<{
  providerDisplayName: string;
  modelId: string;
}>;
export function validateStopTransition(
  active: unknown,
  terminal: unknown,
  journalEvidence: unknown,
): Readonly<{
  promptEnvelope: Record<string, unknown>;
  abortEnvelope: Record<string, unknown>;
  receipts: readonly Record<string, unknown>[];
}>;
export function validateRestartNoReplay(input: unknown): Readonly<{
  hostdRestarted: true;
  desktopRestarted: true;
  exactProjectionStable: true;
  exactJournalIdsUnchanged: true;
  exactCommandsReconciledByHarness: true;
  residentDispatchAttemptsEmpty: true;
  outboxEmpty: true;
  postRestartObservationCount: number;
  minimumPostRestartObservationSeparationMs: number;
}>;
export function validateTerminalResidentProjection(snapshot: unknown, expected: {
  readonly threadId: string;
  readonly executionGenerationId: string;
}): Record<string, unknown>;

export class NullDelimitedCdpDecoder {
  constructor(maxMessageBytes?: number);
  push(chunk: Buffer | Uint8Array): Record<string, unknown>[];
  finish(): void;
}
export function encodeCdpMessage(value: unknown): Buffer;

export interface ProviderE2eCandidateIdentity {
  readonly appVersion: string;
  readonly runtimeReleaseVersion: string;
  readonly runtimeBuildId: string;
  readonly assurance: "development-integrity";
  readonly installerSha256: string;
  readonly installedExecutableSha256: string;
  readonly applicationArchiveSha256: string;
  readonly hostdSha256: string;
  readonly runtimeManifestSha256: string;
  readonly runtimeTreeSha256: string;
}

export function createFunctionalReceipt(input: Readonly<Record<string, unknown>> & {
  readonly candidate: ProviderE2eCandidateIdentity;
  readonly durationsMs: Readonly<Record<string, number>>;
}): Readonly<Record<string, unknown>>;
export function createFailureReceipt(
  stage: string,
  code: string,
  cleanup?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>>;
export function serializeReceipt(receipt: unknown): string;
export interface BoundedRegularFileTreeDigest {
  readonly canonicalRoot: string;
  readonly sha256: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly Readonly<{
    path: string;
    relative: string;
    sha256: string;
    bytes: number;
  }>[];
}
export function digestBoundedRegularFileTree(
  root: string,
  options: Readonly<{ maxFiles: number; maxBytes: number }>,
): Promise<Readonly<BoundedRegularFileTreeDigest>>;
export function removeIsolatedTemporaryRoot(options: Readonly<{
  root: string;
  expectedPrefix: string;
  confirmedCleanShutdown: boolean;
}>): Promise<Readonly<{ removed: true; entries: number; bytes: number }>>;
