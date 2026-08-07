/**
 * Native boundary contracts.
 *
 * These intentionally live beside the Electron main process. The shared hostd
 * protocol may evolve independently; DesktopControlService is the only adapter
 * between renderer-safe values and host protocol frames.
 */

export const IPC = {
  bootstrap: 'prime:bootstrap',
  discoverSshHosts: 'prime:ssh:discover',
  probeSshHost: 'prime:ssh:probe',
  planHostInstall: 'prime:ssh:install-plan',
  installHost: 'prime:ssh:install',
  connect: 'prime:connection:connect',
  reconnect: 'prime:connection:reconnect',
  disconnect: 'prime:connection:disconnect',
  hostCatalog: 'prime:catalog:hosts',
  projectCatalog: 'prime:catalog:projects',
  threadProjection: 'prime:thread:projection',
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
  error?: StructuredError
}

export interface ClientCommand {
  deviceId: string
  commandId: string
  /** Authority the visible thread projection belonged to when composed. */
  expectedHostId: string
  kind: string
  threadId?: string
  payload?: Record<string, unknown>
  delivery?: 'live_only' | 'send_when_reconnected'
  expectedExecutionGenerationId?: string
}

export type CommandJournalStatus =
  | 'received'
  | 'admitted'
  | 'running'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'failed'
  | 'uncertain'

export interface CommandReceipt {
  commandId: string
  deviceId?: string
  hostId?: string
  status: CommandJournalStatus | 'waiting_for_connection'
  durable: boolean
  detail?: string
}

export interface ApprovalResolution {
  deviceId: string
  commandId: string
  expectedHostId: string
  threadId: string
  approvalId: string
  decision: 'approve' | 'deny'
}

export interface CancelRequest {
  deviceId: string
  commandId: string
  expectedHostId: string
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
  command: ClientCommand
  state: 'waiting_for_connection' | 'uncertain'
  updatedAt: string
}

export interface Diagnostics {
  platform: NodeJS.Platform
  arch: string
  appVersion: string
  localEndpoint: string
  connection: ConnectionState
  sshExecutable: string
  outboxCount: number
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
  reconnect(): Promise<Result<ConnectionState>>
  disconnect(): Promise<Result<void>>
  hostCatalog(): Promise<Result<unknown>>
  projectCatalog(input: { hostId: string }): Promise<Result<unknown>>
  threadProjection(input: { threadId: string; cursor?: SessionCursor }): Promise<Result<unknown>>
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
