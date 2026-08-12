/**
 * Native boundary contracts.
 *
 * These intentionally live beside the Electron main process. The shared hostd
 * protocol may evolve independently; DesktopControlService is the only adapter
 * between renderer-safe values and host protocol frames.
 */

import type {
  CandidateEvaluationPreflight,
  CandidateEvaluationPreflightRequest,
  CandidateEvaluationSnapshot,
  CandidateEvaluationStartRequest,
  CandidateEvaluationStatus,
  ResidentLifecycleLookupResult,
  ResidentLifecycleStatus,
  RuntimeIntegritySnapshot,
  RuntimeIntegrityTarget,
  RuntimeModelCatalogSnapshot,
  RuntimeOAuthSessionSnapshot
} from '../../shared/protocol'

export const IPC = {
  bootstrap: 'prime:bootstrap',
  discoverSshHosts: 'prime:ssh:discover',
  probeSshHost: 'prime:ssh:probe',
  planHostInstall: 'prime:ssh:install-plan',
  installHost: 'prime:ssh:install',
  connect: 'prime:connection:connect',
  activateVerifiedSshHost: 'prime:connection:activate-verified-ssh-host',
  reconnect: 'prime:connection:reconnect',
  disconnect: 'prime:connection:disconnect',
  hostCatalog: 'prime:catalog:hosts',
  projectCatalog: 'prime:catalog:projects',
  threadProjection: 'prime:thread:projection',
  retryRuntimeIntegrity: 'prime:runtime:integrity:retry',
  repairRuntimeIntegrity: 'prime:runtime:integrity:repair',
  runtimeModelCatalog: 'prime:runtime:model-catalog',
  startRuntimeOAuth: 'prime:runtime:oauth:start',
  runtimeOAuthStatus: 'prime:runtime:oauth:status',
  cancelRuntimeOAuth: 'prime:runtime:oauth:cancel',
  candidateEvaluationPreflight: 'prime:candidate:evaluation:preflight',
  startCandidateEvaluation: 'prime:candidate:evaluation:start',
  candidateEvaluationSnapshot: 'prime:candidate:evaluation:snapshot',
  preselectResidentWorkspace: 'prime:resident:workspace:preselect',
  completeResidentWorkspacePreselection: 'prime:resident:workspace:preselection:complete',
  cancelResidentWorkspacePreselection: 'prime:resident:workspace:preselection:cancel',
  selectResidentWorkspace: 'prime:resident:workspace:select',
  provisionResident: 'prime:resident:provision',
  prepareResidentEnd: 'prime:resident:end:prepare',
  endResident: 'prime:resident:end',
  residentLifecycleStatus: 'prime:resident:lifecycle:status',
  requestSnapshot: 'prime:thread:snapshot',
  submitCommand: 'prime:command:submit',
  approve: 'prime:approval:resolve',
  cancel: 'prime:command:cancel',
  reconcileCommands: 'prime:command:reconcile',
  planHandoff: 'prime:handoff:plan',
  commitHandoff: 'prime:handoff:commit',
  diagnostics: 'prime:diagnostics',
  connectionState: 'prime:event:connection-state',
  hostEvent: 'prime:event:host',
  snapshot: 'prime:event:snapshot',
  handoffProgress: 'prime:event:handoff-progress'
} as const

export interface StructuredError {
  code: string
  message: string
  retryable: boolean
  receiptId: string
  details?: Record<string, unknown>
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: StructuredError }

export interface SessionCursor {
  threadId: string
  executionGenerationId: string
  generation: string
  sequence: number
}

export interface SshHostAlias {
  alias: string
  effective?: {
    hostname: string
    user?: string
    port?: number
    proxyJump?: string
    canonicalizeHostname?: string
  }
  resolutionError?: StructuredError
}

export interface SshProbe {
  alias: string
  effectiveTarget: string
  protocolVersion?: string
  hostdVersion?: string
  compatible?: boolean
  payload: Record<string, unknown>
}

export interface HostInstallPlan {
  planId: string
  alias: string
  effectiveTarget: string
  executable: boolean
  argv: string[]
  deferredReason?: string
  requiresExplicitConsent: true
  expiresAt: string
}

export type ConnectionTarget =
  | { kind: 'local' }
  | { kind: 'ssh'; alias: string }

interface HostRuntimeReadinessBase {
  /** Immutable host authority that produced this observation. */
  hostId: string
  hostdVersion: string
  startedAt: string
  /** Time of the most recent successful health sample, not a state transition. */
  observedAt: string
}

export type HostRuntimeReadiness =
  | (HostRuntimeReadinessBase & {
      kind: 'not_reported'
    })
  | (HostRuntimeReadinessBase & {
      kind: 'reported'
      snapshot: RuntimeIntegritySnapshot
    })

export interface RuntimeIntegrityRepairInput {
  expectedHostId: string
  expectedTrustAnchorId: string
  expectedTarget: RuntimeIntegrityTarget
  expectedChangedAt: string
}

export interface ConnectionState {
  phase: 'offline' | 'connecting' | 'online' | 'reconnecting' | 'degraded'
  target?: ConnectionTarget
  /** Present only after this connection has verified hostd's immutable identity. */
  hostId?: string
  path?: 'local_socket' | 'ssh'
  since: string
  attempt: number
  /** Versioned features advertised by the verified host health handshake. */
  capabilities?: string[]
  /** Last integrity-readiness observation for this exact verified host authority. */
  runtimeReadiness?: HostRuntimeReadiness
  error?: StructuredError
}

/**
 * Persisted shape accepted only for crash-safe migration. Records written by
 * older builds can be missing the immutable generation or issue time; those
 * records remain quarantined and are never sent or reconciled.
 */
export interface PersistedClientCommand {
  deviceId: string
  commandId: string
  /** Authority the visible thread projection belonged to when composed. */
  expectedHostId?: string
  kind: string
  threadId?: string
  payload?: Record<string, unknown>
  delivery?: 'live_only' | 'send_when_reconnected'
  expectedExecutionGenerationId?: string
  issuedAt?: string
}

export interface ClientCommand extends PersistedClientCommand {
  expectedHostId: string
  threadId: string
  expectedExecutionGenerationId: string
  /** Stable across persistence, reconnect, and every replay attempt. */
  issuedAt: string
}

/** Renderer-safe OAuth state. Authorization URLs and challenge responses stay in main/hostd. */
export interface RuntimeOAuthSessionView {
  sessionId: string
  providerId: string
  phase: RuntimeOAuthSessionSnapshot['phase']
  expiresAt: string
  interaction?:
    | { kind: 'browser'; state: 'opened' }
    | { kind: 'manual'; state: 'unavailable' }
    | { kind: 'selection'; state: 'unavailable' }
  configured?: true
  error?: {
    code: NonNullable<RuntimeOAuthSessionSnapshot['error']>['code']
    retryable: boolean
  }
}

/**
 * A short-lived renderer authorization for one workspace. A native-selected
 * path is retained only inside main; a registered SSH selection is path-free.
 */
export interface ResidentWorkspaceSelection {
  selectionToken: string
  operationId: string
  expectedHostId: string
  suggestedName: string
  expiresAt: string
}

/**
 * A short-lived, path-free preview of a native folder choice made while the
 * local runtime is still preparing. The absolute path never leaves main.
 */
export interface ResidentWorkspacePreselection {
  preselectionToken: string
  suggestedName: string
  expiresAt: string
}

export type ResidentWorkspaceSelectionInput =
  | {
      /** Missing in older renderer calls; normalized to `local_path` in main. */
      kind?: 'local_path'
      /**
       * Re-authorize the private path for a path-free durable operation. A null
       * status resumes the exact operation; a definitive pre-effect completion
       * reuses its workspace identity under a newly minted lifecycle operation.
       */
      resumeOperationId?: string
    }
  | {
      kind: 'registered_workspace'
      /** Exact path-free saved workspace and donor-generation authority. */
      projectId: string
      workspaceId: string
      referenceThreadId: string
      referenceExecutionGenerationId: string
      /** Status-first recovery; never authorizes replay of an uncertain mutation. */
      resumeOperationId?: string
    }

/*
 * Provisioning metadata is renderer-authored display text. Main separately
 * retains all filesystem authority and registered-workspace lineage.
 */
export interface ResidentProvisionInput {
  selectionToken: string
  projectDisplayName: string
  threadTitle: string
  sessionName?: string
}

/** Exact path-free lineage reviewed before a permanent resident end. */
export interface ResidentEndPreparationInput {
  expectedHostId: string
  projectId: string
  workspaceId: string
  threadId: string
  executionGenerationId: string
  /** Re-authorize only a host-proven pre-effect `ending` operation. */
  resumeOperationId?: string
}

/** One-use, process-local confirmation authorization. */
export interface ResidentEndPreparation {
  confirmationToken: string
  operationId: string
  expectedHostId: string
  threadId: string
  executionGenerationId: string
  expiresAt: string
}

export interface ResidentEndInput {
  confirmationToken: string
  consent: true
}

interface ResidentLifecycleOperationBase {
  operationId: string
  expectedHostId: string
  projectId: string
  workspaceId: string
  threadId: string
  executionGenerationId: string
  createdAt: string
  updatedAt: string
  state:
    | 'submitted'
    | 'outcome_unknown'
    | 'requires_reselection'
    | 'terminal_refresh_pending'
    | 'terminal'
  lastStatus?: ResidentLifecycleStatus
}

/** Path-free durable provisioning state exposed during bootstrap and recovery. */
interface ResidentProvisionOperationBase extends ResidentLifecycleOperationBase {
  kind: 'provision'
  projectDisplayName: string
  threadTitle: string
  sessionName?: string
}

/** A local native-picker operation. Its private path is never persisted. */
export interface LocalResidentProvisionOperationView extends ResidentProvisionOperationBase {
  provisionMode: 'local_path'
}

/** A path-free operation against an existing workspace registered on the host. */
export interface RegisteredWorkspaceResidentProvisionOperationView
  extends ResidentProvisionOperationBase {
  provisionMode: 'registered_workspace'
  referenceThreadId: string
  referenceExecutionGenerationId: string
}

export type ResidentProvisionOperationView =
  | LocalResidentProvisionOperationView
  | RegisteredWorkspaceResidentProvisionOperationView

/** Path-free durable permanent-end intent and its exact source projection. */
export interface ResidentEndOperationView extends ResidentLifecycleOperationBase {
  kind: 'end'
  sourceCursor: SessionCursor
}

export type ResidentLifecycleOperationView =
  | ResidentProvisionOperationView
  | ResidentEndOperationView

export type CommandJournalStatus =
  | 'received'
  | 'admitted'
  | 'running'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'failed'
  | 'uncertain'

export interface CommandDiagnostic {
  code: string
  message: string
  retryable: boolean
  diagnosticId?: string
  details?: Record<string, string | number | boolean | null>
}

export interface CommandReceipt {
  commandId: string
  deviceId: string
  hostId: string
  threadId: string
  executionGenerationId: string
  status: CommandJournalStatus | 'waiting_for_connection'
  durable: boolean
  detail?: string
  error?: CommandDiagnostic
}

export interface ApprovalResolution {
  deviceId: string
  commandId: string
  expectedHostId: string
  expectedExecutionGenerationId: string
  issuedAt: string
  threadId: string
  approvalId: string
  decision: 'approve' | 'deny'
}

export interface CancelRequest {
  deviceId: string
  commandId: string
  expectedHostId: string
  expectedExecutionGenerationId: string
  issuedAt: string
  threadId: string
  targetCommandId?: string
}

export interface HandoffPlanRequest {
  threadId: string
  expectedHostId: string
  sourceGenerationId: string
  destinationHostId: string
  destinationProjectId: string
  behaviorIfRunning: 'interrupt' | 'wait_for_idle'
}

export interface HandoffCommitRequest {
  handoffId: string
  deviceId: string
  commandId: string
  expectedHostId: string
}

export interface BootstrapPayload {
  cache: unknown
  outbox: OutboxEntry[]
  /** Parseable legacy/incomplete records excluded from every actionable path. */
  quarantinedOutboxCount: number
  /** Bounded local history of host-durable outcomes that must never replay. */
  durableUncertainReceipts: CommandReceipt[]
  /** Path-free lifecycle entries; these may be queried after reconnect but are never replayed. */
  residentLifecycleOperations: ResidentLifecycleOperationView[]
  connection: ConnectionState
  appVersion: string
}

export interface OutboxEntry {
  /**
   * Immutable authority returned by hostd during a verified health handshake.
   * Missing only on quarantined entries written by pre-namespacing builds;
   * those entries are never reconciled or replayed automatically.
   */
  hostId?: string
  command: PersistedClientCommand
  /**
   * `awaiting_idle_proof` is an exact, non-replayable resident prompt that the
   * host acknowledged as running. It may only be reconciled, never submitted.
   * `awaiting_abort_idle_proof` is the corresponding accepted Stop whose ack
   * cannot itself prove that the resident runtime is idle.
   */
  state:
    | 'waiting_for_connection'
    | 'uncertain'
    | 'awaiting_reconciliation'
    | 'awaiting_idle_proof'
    | 'awaiting_abort_idle_proof'
  updatedAt: string
  quarantineReason?:
    | 'legacy_missing_authority'
    | 'legacy_missing_generation'
    | 'legacy_missing_issued_at'
    | 'legacy_invalid_issued_at'
    | 'invalid_persisted_command'
    | 'command_identity_conflict'
}

export interface Diagnostics {
  platform: NodeJS.Platform
  arch: string
  appVersion: string
  localEndpoint: string
  connection: ConnectionState
  sshExecutable: string
  outboxCount: number
  quarantinedOutboxCount: number
  latencyTraces: Array<{
    operation: string
    durationMs: number
    outcome: 'ok' | 'error'
    recordedAt: string
  }>
}

export interface PrimeBridge {
  bootstrap(): Promise<Result<BootstrapPayload>>
  discoverSshHosts(): Promise<Result<SshHostAlias[]>>
  probeSshHost(input: { alias: string }): Promise<Result<SshProbe>>
  planHostInstall(input: { alias: string }): Promise<Result<HostInstallPlan>>
  installHost(input: { planId: string; consent: true }): Promise<Result<never>>
  connect(input: ConnectionTarget): Promise<Result<ConnectionState>>
  activateVerifiedSshHost(input: { expectedHostId: string }): Promise<Result<ConnectionState>>
  reconnect(): Promise<Result<ConnectionState>>
  disconnect(): Promise<Result<void>>
  hostCatalog(): Promise<Result<unknown>>
  projectCatalog(input: { hostId: string }): Promise<Result<unknown>>
  threadProjection(input: { threadId: string; cursor?: SessionCursor }): Promise<Result<unknown>>
  retryRuntimeIntegrity(input: { expectedHostId: string }): Promise<Result<RuntimeIntegritySnapshot>>
  repairRuntimeIntegrity(input: RuntimeIntegrityRepairInput): Promise<Result<RuntimeIntegritySnapshot>>
  runtimeModelCatalog(input: { expectedHostId: string }): Promise<Result<RuntimeModelCatalogSnapshot>>
  startRuntimeOAuth(input: { expectedHostId: string; providerId: string }): Promise<Result<RuntimeOAuthSessionView>>
  runtimeOAuthStatus(input: { expectedHostId: string; sessionId: string }): Promise<Result<RuntimeOAuthSessionView>>
  cancelRuntimeOAuth(input: { expectedHostId: string; sessionId: string }): Promise<Result<RuntimeOAuthSessionView>>
  candidateEvaluationPreflight(input: CandidateEvaluationPreflightRequest): Promise<Result<CandidateEvaluationPreflight>>
  startCandidateEvaluation(input: CandidateEvaluationStartRequest): Promise<Result<CandidateEvaluationStatus>>
  candidateEvaluationSnapshot(input: CandidateEvaluationPreflightRequest): Promise<Result<CandidateEvaluationSnapshot>>
  preselectResidentWorkspace(): Promise<Result<ResidentWorkspacePreselection>>
  completeResidentWorkspacePreselection(input: {
    preselectionToken: string
  }): Promise<Result<ResidentWorkspaceSelection>>
  cancelResidentWorkspacePreselection(input: { preselectionToken: string }): Promise<Result<void>>
  selectResidentWorkspace(input?: ResidentWorkspaceSelectionInput): Promise<Result<ResidentWorkspaceSelection>>
  provisionResident(input: ResidentProvisionInput): Promise<Result<ResidentLifecycleStatus>>
  prepareResidentEnd(input: ResidentEndPreparationInput): Promise<Result<ResidentEndPreparation>>
  endResident(input: ResidentEndInput): Promise<Result<ResidentLifecycleStatus>>
  residentLifecycleStatus(input: {
    expectedHostId: string
    operationId: string
  }): Promise<Result<ResidentLifecycleLookupResult>>
  requestSnapshot(input: { threadId?: string; cursor?: SessionCursor }): Promise<Result<unknown>>
  submitCommand(input: ClientCommand): Promise<Result<CommandReceipt>>
  approve(input: ApprovalResolution): Promise<Result<CommandReceipt>>
  cancel(input: CancelRequest): Promise<Result<CommandReceipt>>
  reconcileCommands(input: { commandIds: string[] }): Promise<Result<CommandReceipt[]>>
  planHandoff(input: HandoffPlanRequest): Promise<Result<unknown>>
  commitHandoff(input: HandoffCommitRequest): Promise<Result<unknown>>
  diagnostics(): Promise<Result<Diagnostics>>
  onConnectionState(listener: (state: ConnectionState) => void): () => void
  onHostEvent(listener: (event: unknown) => void): () => void
  onSnapshot(listener: (snapshot: unknown) => void): () => void
  onHandoffProgress(listener: (progress: unknown) => void): () => void
}
