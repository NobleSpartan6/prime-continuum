export const APPCONTAINER_PROBE_OPERATION_SCHEMA_VERSION: 1
export const APPCONTAINER_PROBE_OPERATION_RECORD_KIND:
  'prime_continuim_appcontainer_probe_operation_reference_phase_v1'
export const APPCONTAINER_PROBE_OPERATION_MAX_RECORD_BYTES: number
export const APPCONTAINER_PROBE_OPERATION_MAX_DIRECTORY_ENTRIES: number

export const APPCONTAINER_PROBE_OPERATION_PHASES: readonly [
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

export type AppContainerProbeOperationPhase = typeof APPCONTAINER_PROBE_OPERATION_PHASES[number]
export type AppContainerProbeOperationAdvancePhase = Exclude<
  AppContainerProbeOperationPhase,
  'invocation_committed'
>

export const APPCONTAINER_PROBE_OPERATION_FAULT_POINTS: readonly [
  'after_temporary_open',
  'after_temporary_write',
  'after_temporary_sync',
  'after_temporary_close',
  'after_publish',
  'after_directory_sync',
  'before_invocation_effect',
  'before_record_final_path_check',
  'before_existing_sync_open',
  'before_existing_final_path_check',
]

export type AppContainerProbeOperationFaultPoint =
  typeof APPCONTAINER_PROBE_OPERATION_FAULT_POINTS[number]

export class AppContainerProbeOperationError extends Error {
  readonly code: string
  constructor(code: string, message?: string, options?: ErrorOptions)
}

export interface AppContainerProbeOperationProvenanceRecord {
  readonly role: string
  readonly sha256: string
  readonly bytes: number
}

export interface AppContainerProbeOperationIdentity {
  readonly operationId: string
  readonly correlationId: string
  readonly provenance: Readonly<{
    installedCandidate: Readonly<AppContainerProbeOperationProvenanceRecord & {
      role: 'installed_candidate_correlation'
    }>
    nativeSupervisor: Readonly<AppContainerProbeOperationProvenanceRecord & {
      role: 'native_supervisor'
      machine: 'x64'
    }>
    probePayload: Readonly<AppContainerProbeOperationProvenanceRecord & {
      role: 'launch_target'
      machine: 'x64'
    }>
    nativeBuildManifest: Readonly<AppContainerProbeOperationProvenanceRecord & {
      role: 'native_build_manifest'
      machine: 'x64'
    }>
  }>
}

export interface AppContainerProbeOperationPhaseRecord {
  readonly schemaVersion: 1
  readonly kind: 'prime_continuim_appcontainer_probe_operation_reference_phase_v1'
  readonly operationId: string
  readonly correlationId: string
  readonly provenance: AppContainerProbeOperationIdentity['provenance']
  readonly revision: number
  readonly phase: AppContainerProbeOperationPhase
  readonly evidenceSha256: string
  readonly previousRecordSha256: string | null
  readonly recordSha256: string
}

export interface AppContainerProbeOperationState {
  readonly identity: Readonly<AppContainerProbeOperationIdentity>
  readonly revision: number
  readonly phases: readonly AppContainerProbeOperationPhase[]
  readonly finalPhase: AppContainerProbeOperationPhase | null
  readonly records: readonly Readonly<AppContainerProbeOperationPhaseRecord>[]
  readonly restartDisposition:
    | 'operator_reconfirmation_required'
    | 'observe_retire_cleanup_only'
    | 'settled'
  readonly operationMode: 'source_reference_only'
  readonly invocationReplayPolicy: 'reference_only_requires_native_owner_lease_recovery_fence'
  readonly finalReceiptPublication: 'external_host_no_replace_not_implemented'
  readonly claims: Readonly<{
    liveWindowsPhasePublication: false
    durableNoRelaunch: false
    nativeOwnerLeaseRecoveryFence: false
    finalReceiptPublished: false
  }>
}

export interface AppContainerProbeOperationJournal {
  readState(): Promise<Readonly<AppContainerProbeOperationState>>
  reconfirmPreInvocation(input: Readonly<{
    expectedRevision: number
    confirmationSha256: string
  }>): Promise<Readonly<{
    operationId: string
    revision: number
    confirmationSha256: string
  }>>
  advance(input: Readonly<{
    expectedRevision: number
    phase: AppContainerProbeOperationAdvancePhase
    evidenceSha256: string
  }>): Promise<Readonly<{
    record: Readonly<AppContainerProbeOperationPhaseRecord>
    replayed: boolean
  }>>
  commitInvocation<T>(input: Readonly<{
    expectedRevision: number
    evidenceSha256: string
  }>, invoke: () => T | Promise<T>): Promise<Readonly<{
    record: Readonly<AppContainerProbeOperationPhaseRecord>
    replayed: boolean
    invocation: 'performed_after_commit' | 'suppressed_existing_commit'
    value: T | undefined
  }>>
}

export interface OpenAppContainerProbeOperationJournalOptions {
  /**
   * A host-private journal directory outside the disposable sandbox-visible
   * operation, scratch, and tool roots. The caller keeps this directory after
   * deleting those roots so cleanup_complete and settled can be recorded.
   */
  readonly hostPrivateOperationPath: string
  readonly identity: Readonly<AppContainerProbeOperationIdentity>
  readonly faultInjector?: (
    point: AppContainerProbeOperationFaultPoint,
    phase: AppContainerProbeOperationPhase,
  ) => void | Promise<void>
}

export function openAppContainerProbeOperationJournal(
  options: Readonly<OpenAppContainerProbeOperationJournalOptions>,
): Promise<AppContainerProbeOperationJournal>
