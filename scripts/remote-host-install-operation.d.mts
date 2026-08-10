export const REMOTE_HOST_INSTALL_OPERATION_SCHEMA_VERSION: 1
export const REMOTE_HOST_INSTALL_OPERATION_KIND: 'prime_continuim_remote_host_install_operation_v1'
export const REMOTE_HOST_INSTALL_OPERATION_PHASES: readonly [
  'planned',
  'admitted',
  'dispatching',
  'outcome_unknown',
  'remote_prepared',
  'package_published',
  'service_starting',
  'ready_verified',
  'settled',
  'failed_pre_effect',
  'blocked_post_effect',
]
export const REMOTE_HOST_INSTALL_OPERATION_CLAIM_KEYS: readonly [
  'installerImplemented',
  'durablePersistenceImplemented',
  'durableNoReplayEnforced',
  'remoteStatusImplemented',
  'liveInstallVerified',
  'remoteExecution',
  'authentication',
  'authorization',
  'upgradeSupported',
  'repairSupported',
  'downgradeSupported',
  'rollbackSupported',
  'providerBackedEvaluation',
  'autonomousPromotion',
]

export type RemoteHostInstallPhase = (typeof REMOTE_HOST_INSTALL_OPERATION_PHASES)[number]

export class RemoteHostInstallOperationError extends Error {
  readonly code: string
  constructor(code?: string, message?: string)
}

export interface RemoteHostInstallIdentity {
  readonly operationId: string
  readonly packageId: string
  readonly manifestSha256: string
  readonly trustAnchorId: string
  readonly signerKeyId: string
  readonly targetAuthoritySha256: string
  readonly target: Readonly<{ platform: 'linux'; arch: 'x64'; libc: 'glibc' }>
  readonly installMode: 'fresh_install'
  readonly destinationState: 'absent'
}

export interface RemoteHostInstallOperation extends RemoteHostInstallIdentity {
  readonly schemaVersion: 1
  readonly kind: 'prime_continuim_remote_host_install_operation_v1'
  readonly revision: number
  readonly phase: RemoteHostInstallPhase
  readonly evidenceSha256: string | null
  readonly previousRecordSha256: string | null
  readonly recordSha256: string
  readonly claims: Readonly<Record<(typeof REMOTE_HOST_INSTALL_OPERATION_CLAIM_KEYS)[number], false>>
}

export interface RemoteHostInstallTransition {
  readonly expectedRevision: number
  readonly expectedRecordSha256: string
  readonly phase: RemoteHostInstallPhase
  readonly evidenceSha256: string
}

export interface RemoteHostInstallKitCorrelation {
  readonly packageId: string
  readonly manifestSha256: string
  readonly trustAnchorId: string
  readonly signerKeyId: string
  readonly target: Readonly<{ platform: 'linux'; arch: 'x64'; libc: 'glibc' }>
  readonly installAction: 'fresh_install'
  readonly artifactBytesCorrelated: true
}

export function validateRemoteHostInstallAdmission(input: RemoteHostInstallIdentity): Readonly<RemoteHostInstallIdentity>
export function createRemoteHostInstallOperation(input: RemoteHostInstallIdentity): Readonly<RemoteHostInstallOperation>
export function validateRemoteHostInstallOperation(input: RemoteHostInstallOperation): Readonly<RemoteHostInstallOperation>
export function reduceRemoteHostInstallOperation(
  currentInput: RemoteHostInstallOperation,
  transitionInput: RemoteHostInstallTransition,
): Readonly<{
  record: RemoteHostInstallOperation
  persistenceRequiredBeforeAction: true
  postPersistenceRequirement: 'future_unforgeable_persistence_capability_required' | 'none'
  effectAuthority: null
}>
export function assertRemoteHostInstallKitCorrelation(
  identityInput: RemoteHostInstallIdentity,
  correlationInput: RemoteHostInstallKitCorrelation,
): Readonly<{
  operationId: string
  packageId: string
  manifestSha256: string
  targetAuthoritySha256: string
  structuralCorrelation: true
  verificationClaimed: false
  effectAuthority: null
}>
export function recoverRemoteHostInstallOperation(input: RemoteHostInstallOperation): Readonly<{
  operationId: string
  revision: number
  recordSha256: string
  disposition: 'resume_pre_effect_reducer' | 'query_status_only' | 'terminal'
  statusOnly: boolean
  dispatchAllowed: false
  replayAllowed: false
}>
export function canonicalRemoteHostInstallOperationJson(input: unknown): string
