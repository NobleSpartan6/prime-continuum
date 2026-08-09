export const EVIDENCE_KIND: string
export const EVIDENCE_CLASS: string
export const WORKSPACE_SETUP: string
export const DEDICATED_WINDOWS_USER: string
export const OPT_IN_FLAG: string
export const DISPOSABLE_CHECKPOINT_FLAG: string
export const CHECKPOINT_ASSERTION: string
export const CONFIRMATION_PHRASE: string
export const MAX_CDP_MESSAGE_BYTES: number
export const MAX_RECEIPT_BYTES: number
export const RENDERER_TERMINAL_POLL_INTERVAL_MS: number
export const MIN_POST_RESTART_CONVERSATION_OBSERVATIONS: number
export const FAILURE_STAGES: readonly string[]
export const FAILURE_CODES: readonly string[]

export class ProviderE2eContractError extends Error {
  readonly stage: string
  readonly code: string
  constructor(stage: string, code: string)
}

export function fail(stage: string, code: string): never
export function assertInteractiveAdmission(input: {
  platform: string
  arch: string
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  ci?: string | boolean
  argv: string[]
  checkpointAssertion?: string
  username?: string
  tokenUsername?: string
  userProfileBasename?: string
  uiCulture?: string
  integritySids?: string[]
}): Readonly<{ admitted: true }>
export function assertTypedConfirmation(value: string): true
export function parseAccountReadResult(value: unknown, stage?: string): Record<string, unknown>
export function parseConversationSnapshotResult(
  value: unknown,
  stage?: string,
): { conversation: Record<string, unknown> | null }
export function assertAccountPhase<T>(snapshot: T, phase: string, stage?: string): T
export function assertInitiallySignedOut<T>(snapshot: T): T
export function validateCompletedTurn(observations: unknown[]): Readonly<{ operationId: string; turnId: string }>
export function validateInterruptedTurn(active: unknown, terminal: unknown): Readonly<{ operationId: string; turnId: string }>
export function validateElectronRestartRecovery(
  before: unknown,
  observations: Array<{
    snapshot: unknown
    observedAtMonotonicMs: number
  }>,
  operationIds: string[],
): Readonly<{
  recovered: true
  noAdditionalDurableAdmissionObserved: true
  postRestartConversationObservationCount: number
  minimumPostRestartObservationSeparationMs: number
  rendererTerminalPollIntervalMs: number
  rendererTerminalPollIntervalSizedObservationGapCount: number
}>

export class NullDelimitedCdpDecoder {
  constructor(maxMessageBytes?: number)
  push(chunk: Buffer | Uint8Array): Record<string, unknown>[]
  finish(): void
}
export function encodeCdpMessage(value: unknown): Buffer
export function createFunctionalReceipt(input: Record<string, unknown>): Readonly<Record<string, unknown>>
export function createFailureReceipt(
  stage: string,
  code: string,
  cleanup?: { fixtureCreated?: boolean; desktopStarted?: boolean; helperMayRemain?: boolean },
): Readonly<Record<string, unknown>>
export function serializeReceipt(receipt: unknown): string
