export const APPCONTAINER_PROBE_SCHEMA_VERSION: 1
export const APPCONTAINER_PROBE_KIND: 'prime_continuim_appcontainer_probe_v1'
export const APPCONTAINER_PROBE_ENVELOPE_KIND: 'prime_continuim_appcontainer_probe_envelope_v1'
export const APPCONTAINER_PROBE_MAX_RECEIPT_BYTES: number
export const APPCONTAINER_PROBE_CONFIRMATION_PHRASE: string
export const APPCONTAINER_PROBE_PHASES: readonly [
  'prepared',
  'admitted',
  'sandbox_created',
  'invocation_committed',
  'supervisor_published',
  'tree_retired',
  'gate_evidence_observed',
  'cleanup_complete',
  'settled',
]
export const APPCONTAINER_PROBE_CLAIM_KEYS: readonly [
  'productCapability',
  'candidateEvaluation',
  'securitySandboxClaim',
  'mainFilesystemIsolationClaim',
  'authenticated',
  'providerBackedEvaluation',
  'autonomousPromotion',
]
export const APPCONTAINER_PROBE_EXIT_SEMANTICS: Readonly<{
  staticReceiptVerified: 0
  failed: 1
  functionalPassedVmDisposalRequired: 2
}>
export const APPCONTAINER_PROBE_GATE_SPECS: readonly Readonly<{
  id: string
  expected: 'present' | 'allowed' | 'denied'
}>[]
export const APPCONTAINER_PROBE_FAILURE_CODES: readonly string[]

export class AppContainerProbeContractError extends Error {
  readonly code: string
  constructor(code?: string)
}

export interface AppContainerProbeAdmissionInput {
  readonly platform: string
  readonly arch: string
  readonly stdinIsTTY: boolean
  readonly stdoutIsTTY: boolean
  readonly ci: string | boolean | undefined
  readonly githubActions: string | boolean | undefined
  readonly disposableVm: boolean
  readonly checkpointConfirmed: boolean
  readonly confirmationPhrase: string
  readonly operator: Readonly<{
    dedicatedAccount: boolean
    standardUser: boolean
    administratorsGroupAbsent: boolean
    elevated: boolean
    integrity: string
  }>
  readonly installedCandidate: AppContainerProbeAdmissionProvenance
  readonly probePayload: AppContainerProbeAdmissionProvenance
  readonly storage: Readonly<{
    boundedPrivateRoot: boolean
    freshOperationRoot: boolean
    preexistingReceiptAbsent: boolean
    sealedToolCopyPlanned: boolean
    boundedControlledSentinels: boolean
  }>
}

export interface AppContainerProbeAdmissionProvenance {
  readonly sha256: string
  readonly bytes: number
  readonly preexisting: boolean
  readonly regularFile: boolean
  readonly reparsePoint: boolean
  readonly machine: string
}

export function validateAppContainerProbeAdmission(input: AppContainerProbeAdmissionInput): Readonly<{
  status: 'admitted'
  installedCandidate: Readonly<{ sha256: string; bytes: number }>
  probePayload: Readonly<{ sha256: string; bytes: number }>
}>

export function validateAppContainerProbeReceipt(
  receipt: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>>

export function createAppContainerProbeReceiptEnvelope(
  receipt: Readonly<Record<string, unknown>>,
): Readonly<{
  schemaVersion: 1
  kind: 'prime_continuim_appcontainer_probe_envelope_v1'
  receiptSha256: string
  receipt: Readonly<Record<string, unknown>>
}>

export function serializeAppContainerProbeReceiptEnvelope(
  envelope: Readonly<Record<string, unknown>>,
): Buffer

export function verifyAppContainerProbeReceiptBytes(input: Uint8Array): Readonly<{
  receipt: Readonly<Record<string, unknown>>
  receiptSha256: string
  staticVerifierExitCode: 0
  liveProbeExitCode: 1 | 2
}>

export function canonicalAppContainerProbeJson(value: unknown): string
