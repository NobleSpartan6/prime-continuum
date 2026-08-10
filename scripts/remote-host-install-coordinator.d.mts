import type { KeyObject } from 'node:crypto'
import type {
  RemoteHostKitArtifact,
  RemoteHostKitArtifactBytes,
  RemoteHostKitIndependentTrust,
} from './remote-host-kit-lib.mjs'
import type {
  RemoteHostInstallIdentity,
  RemoteHostInstallOperation,
  RemoteHostInstallPhase,
} from './remote-host-install-operation.mjs'
import type {
  RemoteHostInstallJournalFaultPoint,
  RemoteHostInstallJournalState,
} from './remote-host-install-journal.mjs'

export const REMOTE_HOST_INSTALL_COORDINATOR_SCHEMA_VERSION: 1
export const REMOTE_HOST_INSTALL_COORDINATOR_KIND: 'prime_continuim_remote_host_install_coordinator_state_v1'
export const REMOTE_HOST_INSTALL_COORDINATOR_FAULT_POINTS: readonly [
  'after_kit_verification_before_journal_open',
  'after_dispatch_fence_confirmation_before_capability_mint',
  'after_capability_mint_before_consume',
  'after_capability_consume_before_effect',
  'after_effect_success_before_remote_prepared',
  'after_effect_throw_before_outcome_unknown',
  'after_outcome_publication',
]
export const REMOTE_HOST_INSTALL_COORDINATOR_CLAIM_KEYS: readonly [
  'powerLossDurability',
  'windowsProductionDurability',
  'hostileSameUserProtection',
  'multiProcessCustody',
  'liveRemoteInstall',
  'remoteExecution',
  'authentication',
  'authorization',
  'upgradeSupported',
  'repairSupported',
  'downgradeSupported',
  'rollbackSupported',
  'productIntegration',
  'providerBackedEvaluation',
  'autonomousPromotion',
]

export type RemoteHostInstallCoordinatorFaultPoint =
  (typeof REMOTE_HOST_INSTALL_COORDINATOR_FAULT_POINTS)[number]

export class RemoteHostInstallCoordinatorError extends Error {
  readonly code: string
  constructor(code?: string, message?: string)
}

export interface RemoteHostInstallCoordinatorState {
  readonly schemaVersion: 1
  readonly kind: 'prime_continuim_remote_host_install_coordinator_state_v1'
  readonly identity: Readonly<RemoteHostInstallIdentity>
  readonly kitCorrelation: Readonly<{
    schema: 'remote-host-kit/v1'
    packageId: string
    manifestSha256: string
    envelopeSha256: string
    trustAnchorId: string
    signerKeyId: string
    target: Readonly<{ platform: 'linux'; arch: 'x64'; libc: 'glibc' }>
    installAction: 'fresh_install'
    artifacts: Readonly<Record<'hostd' | 'runtime' | 'launcher' | 'service', RemoteHostKitArtifact>>
    verification: Readonly<{
      canonicalBytes: true
      strictSchema: true
      ed25519SignatureVerified: true
      independentTrustCorrelation: true
      artifactBytesCorrelated: true
    }>
  }>
  readonly journal: Readonly<RemoteHostInstallJournalState>
  readonly effectAuthority: null
  readonly claims: Readonly<Record<(typeof REMOTE_HOST_INSTALL_COORDINATOR_CLAIM_KEYS)[number], false>>
}

export interface RemoteHostInstallCoordinatorDispatchResult {
  readonly outcome: 'remote_prepared' | 'outcome_unknown'
  readonly record: Readonly<RemoteHostInstallOperation>
  readonly effectAuthority: null
}

export interface RemoteHostInstallCoordinator {
  readState(): Promise<Readonly<RemoteHostInstallCoordinatorState>>
  initialize(input: Readonly<{ evidenceSha256: null }>): Promise<Readonly<RemoteHostInstallCoordinatorState>>
  admit(input: Readonly<{
    expectedRevision: number
    expectedRecordSha256: string
    evidenceSha256: string
  }>): Promise<Readonly<RemoteHostInstallCoordinatorState>>
  failPreEffect(input: Readonly<{
    expectedRevision: number
    expectedRecordSha256: string
    evidenceSha256: string
  }>): Promise<Readonly<RemoteHostInstallCoordinatorState>>
  dispatch(input: Readonly<{
    expectedRevision: number
    expectedRecordSha256: string
    dispatchEvidenceSha256: string
    remotePreparedEvidenceSha256: string
    outcomeUnknownEvidenceSha256: string
    effect: () => void | Promise<void>
  }>): Promise<Readonly<RemoteHostInstallCoordinatorDispatchResult>>
  reconcile(input: Readonly<{
    expectedRevision: number
    expectedRecordSha256: string
    phase: RemoteHostInstallPhase
    evidenceSha256: string
  }>): Promise<Readonly<RemoteHostInstallCoordinatorState>>
}

export function openRemoteHostInstallCoordinator(options: Readonly<{
  journalDirectory: string
  operationId: string
  targetAuthoritySha256: string
  manifestBytes: Uint8Array
  envelopeBytes: Uint8Array
  artifactBytes: RemoteHostKitArtifactBytes
  independentTrust: RemoteHostKitIndependentTrust & Readonly<{ publicKey: KeyObject }>
  journalFaultInjector?: (point: RemoteHostInstallJournalFaultPoint) => void
  coordinatorFaultInjector?: (point: RemoteHostInstallCoordinatorFaultPoint) => void
}>): Promise<Readonly<RemoteHostInstallCoordinator>>
