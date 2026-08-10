import type {
  RemoteHostInstallIdentity,
  RemoteHostInstallOperation,
  RemoteHostInstallPhase,
} from './remote-host-install-operation.mjs'

export const REMOTE_HOST_INSTALL_JOURNAL_SCHEMA_VERSION: 1
export const REMOTE_HOST_INSTALL_JOURNAL_KIND: 'prime_continuim_remote_host_install_journal_state_v1'
export const REMOTE_HOST_INSTALL_JOURNAL_MAX_RECORD_BYTES: number
export const REMOTE_HOST_INSTALL_JOURNAL_MAX_RECORDS: 9
export const REMOTE_HOST_INSTALL_JOURNAL_FAULT_POINTS: readonly [
  'after_temp_create',
  'after_temp_write',
  'after_temp_stat',
  'after_temp_file_sync',
  'after_temp_close',
  'after_no_replace_link',
  'after_publish_parent_sync',
  'after_temp_unlink',
  'after_cleanup_parent_sync',
  'after_final_open',
  'after_final_verify',
  'after_final_file_sync',
  'after_final_close',
  'after_final_parent_sync',
  'after_full_rescan',
  'before_append_resolve',
]
export const REMOTE_HOST_INSTALL_JOURNAL_CLAIM_KEYS: readonly [
  'powerLossDurability',
  'windowsProductionDurability',
  'hostileSameUserProtection',
  'multiProcessCustody',
  'liveRemoteInstall',
  'productIntegration',
]

export type RemoteHostInstallJournalFaultPoint =
  (typeof REMOTE_HOST_INSTALL_JOURNAL_FAULT_POINTS)[number]

export class RemoteHostInstallJournalError extends Error {
  readonly code: string
  constructor(code?: string, message?: string)
}

export interface RemoteHostInstallJournalState {
  readonly schemaVersion: 1
  readonly kind: 'prime_continuim_remote_host_install_journal_state_v1'
  readonly records: readonly RemoteHostInstallOperation[]
  readonly currentRecord: RemoteHostInstallOperation | null
  readonly disposition: 'empty' | 'resume_pre_effect_reducer' | 'query_status_only' | 'terminal'
  readonly statusOnly: boolean
  readonly effectAuthority: null
  readonly claims: Readonly<Record<(typeof REMOTE_HOST_INSTALL_JOURNAL_CLAIM_KEYS)[number], false>>
}

export interface RemoteHostInstallJournalAppendResult {
  readonly record: RemoteHostInstallOperation
  readonly effectAuthority: null
}

export interface RemoteHostInstallJournal {
  readState(): Promise<Readonly<RemoteHostInstallJournalState>>
  initialize(input: Readonly<{ evidenceSha256: null }>): Promise<Readonly<RemoteHostInstallJournalAppendResult>>
  append(input: Readonly<{
    expectedRevision: number
    expectedRecordSha256: string
    phase: RemoteHostInstallPhase
    evidenceSha256: string
  }>): Promise<Readonly<RemoteHostInstallJournalAppendResult>>
}

export function openRemoteHostInstallJournal(options: Readonly<{
  journalDirectory: string
  identity: RemoteHostInstallIdentity
  faultInjector?: (point: RemoteHostInstallJournalFaultPoint) => void
}>): Promise<Readonly<RemoteHostInstallJournal>>
