export const EVIDENCE_KIND: "prime_continuim_sol_rlm_browser_dogfood";
export const OPT_IN_FLAG: "--i-understand-this-uses-live-sol-rlm-and-browser-tools";
export const DISPOSABLE_CHECKPOINT_FLAG: "--disposable-workspace-checkpoint";
export const CHECKPOINT_ASSERTION: "DISPOSABLE_SOL_RLM_BROWSER_DOGFOOD_READY";
export const CONFIRMATION_PHRASE: string;
export const PROVIDER_ID: "openai-codex";
export const MODEL_ID: "gpt-5.6-sol";
export const RUNTIME_MODEL_ID: "openai-codex/gpt-5.6-sol";
export const PRIME_AGENT_RELEASE_VERSION: "0.7.2";
export const CHILD_NAME: "browser-auditor";
export const BROWSER_SURFACE: "playwright-cli";
export const ROOT_PREFIX: "prime-continuim-tool-dogfood-";
export const RECEIPT_NAME: "receipt.json";
export const PROOF_DIRECTORY: ".prime-continuim-tool-dogfood";
export const PROOF_NAME: "proof.json";
export const SCREENSHOT_NAME: "browser-proof.png";
export const FUNCTIONAL_EXIT_CODE: 2;
export const MAX_RECEIPT_BYTES: number;
export const MAX_PROOF_BYTES: number;
export const MAX_BROWSER_STATE_ENTRIES: number;
export const MAX_TRANSCRIPT_TEXT_BYTES: number;
export const MAX_UNIX_SOCKET_PATH_BYTES: number;
export const POST_RESTART_OBSERVATION_INTERVAL_MS: number;
export const MIN_POST_RESTART_OBSERVATIONS: number;
export const NONCLAIMS: readonly string[];

export class ToolDogfoodContractError extends Error {
  readonly stage: string;
  readonly code: string;
  constructor(stage: string, code: string);
}

export interface DogfoodIdentity {
  readonly runId: string;
  readonly childToken: string;
  readonly fillValue: string;
  readonly finalMarker: string;
  readonly goalObjective: string;
  readonly sessionName: string;
}

export interface InitialProjectionEvidence {
  readonly hostId: string;
  readonly threadId: string;
  readonly executionGenerationId: string;
  readonly initialSequence: number;
  readonly initialGeneration: string;
  readonly activeSessionId: string | undefined;
  readonly sessionId: string | undefined;
}

export function fail(stage: string, code: string): never;
export function assertInteractiveAdmission(input: Readonly<Record<string, unknown>>): Readonly<{ admitted: true }>;
export function assertNoCredentialEnvironment(environment: Readonly<Record<string, unknown>>): true;
export function assertTypedConfirmation(value: string): true;
export function validateDisposableLayout(input: Readonly<{
  root: string;
  workspace: string;
  dataDirectory: string;
}>): Promise<Readonly<{ root: string; workspace: string; dataDirectory: string }>>;
export function resolveDogfoodHostEndpoint(input: Readonly<{
  platform: NodeJS.Platform | string;
  dataDirectory: string;
}>): string;
export function resolveDogfoodResidentDaemonEndpoint(input: Readonly<{
  platform: NodeJS.Platform | string;
  dataDirectory: string;
  physicalTemporaryDirectory: string;
}>): string;
export function createDogfoodIdentity(runId: string, nonce: string): DogfoodIdentity;
export function createDogfoodPrompt(input: Readonly<{ identity: DogfoodIdentity; pageUrl: string }>): string;
export function createDogfoodPage(identity: DogfoodIdentity): string;
export function validateInitialProjection(snapshot: unknown, identity: DogfoodIdentity): InitialProjectionEvidence;
export function validateAuthenticatedCatalog(catalog: unknown): Readonly<{ provider: any; model: any }>;
export function validateInFlightProjection(snapshot: unknown, input: Readonly<{
  initial: InitialProjectionEvidence;
  identity: DogfoodIdentity;
}>): Readonly<{
  authority: Readonly<{ hostId: string; threadId: string; executionGenerationId: string }>;
  child: any;
  goal: any;
  rootActivity: "stream" | "runtime_stream" | "compaction" | "shell" | "tool";
  sequence: number;
  projectionSha256: string;
}>;
export function validateCompletedProjection(snapshot: unknown, input: Readonly<{
  initial: InitialProjectionEvidence;
  identity: DogfoodIdentity;
  inFlight: Readonly<{ child: any; goal: any; sequence: number }>;
}>): Readonly<{
  authority: Readonly<{ hostId: string; threadId: string; executionGenerationId: string }>;
  child: any;
  goal: any;
  transcriptSha256: string;
}>;
export function validateRestartNoReplay(input: Readonly<Record<string, any>>): Readonly<{
  hostdRestarted: true;
  desktopRestarted: true;
  sameResidentReattached: true;
  exactProjectionStable: true;
  exactJournalIdsUnchanged: true;
  residentDispatchAttemptsEmpty: true;
  desktopOutboxEmpty: true;
  postRestartObservationCount: number;
  minimumPostRestartObservationSeparationMs: number;
}>;
export function validateEndedProjection(snapshot: unknown, input: Readonly<{
  completedSnapshot: any;
  authority: Readonly<{ hostId: string; threadId: string; executionGenerationId: string }>;
}>): Readonly<{
  operationId: string;
  bindingFingerprint: string;
  endedAt: string;
  sourceCursor: any;
  projectId: string;
  workspaceId: string;
  projectionSha256: string;
}>;
export function validateEndedControlProjection(control: unknown, input: Readonly<{
  authority: Readonly<{ hostId: string; threadId: string; executionGenerationId: string }>;
  ended: Readonly<{ endedAt: string; sourceCursor: any }>;
}>): true;
export function validateCompletedEndLifecycleStatus(status: unknown, input: Readonly<{
  authority: Readonly<{ hostId: string; threadId: string; executionGenerationId: string }>;
  operationId: string;
  ended: Readonly<{ projectId: string; workspaceId: string }>;
}>): true;
export function validateLoopbackEvidence(events: readonly unknown[], identity: DogfoodIdentity): Readonly<{
  openIndex: number;
  fillIndex: number;
  clickIndex: number;
  count: number;
}>;
export function parseAndValidateProof(bytes: Uint8Array | string, identity: DogfoodIdentity): any;
export function readAndValidateProof(path: string, identity: DogfoodIdentity): Promise<any>;
export function validateScreenshot(path: string): Promise<Readonly<{ byteLength: number; sha256: string }>>;
export function assertBrowserStateRetired(stateDirectory: string): Promise<Readonly<{
  retired: true;
  inspectedEntries: number;
}>>;
export function createFunctionalReceipt(input: Readonly<Record<string, any>>): Readonly<Record<string, any>>;
export function createFailureReceipt(input: Readonly<Record<string, any>>): Readonly<Record<string, any>>;
export function serializeReceipt(receipt: unknown): Buffer;
export function validateReceipt<T>(receipt: T): T;
export function sha256Json(value: unknown): string;
