import {
  type ExtensionUiDialogResponse,
  type ResidentExtensionUiRequest,
  type ResidentLifecycleStatus,
  type CandidateEvaluationPreflight,
  type CandidateEvaluationPreflightRequest,
  type CandidateEvaluationReviewIdentity,
  type CandidateEvaluationSnapshot,
  type CandidateEvaluationStartRequest,
  type CandidateEvaluationStatus,
  type RuntimeIntegritySnapshot,
  type RuntimeModelCatalogSnapshot,
  type RuntimeResourceInventory,
  type ResidentBrowserExecution,
} from '../../shared/protocol'
import {
  CANDIDATE_EVALUATION_PROBE_CAPABILITY,
  PRIME_CONTINUIM_SELF_BUILD_EVALUATION_CAPABILITY,
  PRIME_AGENT_COMMAND_CAPABILITY,
  PRIME_AGENT_THINKING_LEVELS_CAPABILITY,
  RESIDENT_EXTENSION_UI_CAPABILITY,
  RESIDENT_LIFECYCLE_CAPABILITY,
  RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY,
  RUNTIME_INTEGRITY_REPAIR_CAPABILITY,
  RUNTIME_INTEGRITY_RETRY_CAPABILITY,
  RUNTIME_MODEL_CATALOG_CAPABILITY,
  RUNTIME_OAUTH_ATTEMPT_CAPABILITY,
  RUNTIME_OAUTH_CAPABILITY,
  RUNTIME_PROVIDER_SETUP_HANDOFF_CAPABILITY,
  THREAD_HANDOFF_CAPABILITY,
} from '../../shared/capabilities'
import {
  parseInProgressStream,
  parseResidentExtensionUiRequest,
  parseResidentBrowserExecution,
  parseResidentLifecycleDisposition,
  parseResidentLifecycleLookupResult,
  parseResidentLifecycleStatus,
  parseRuntimeResourceInventory,
} from './protocol-guards'
import type { HudMode, HudState, HudTarget } from '../../shared/window-control'
import { sanitizeResidentDisplayText } from '../../shared/resident-display'

export type ConnectionState = 'online' | 'reconnecting' | 'offline'
export type RuntimeModelCatalog = RuntimeModelCatalogSnapshot
export type TaskState = 'idle' | 'running' | 'waiting' | 'needs_approval' | 'complete' | 'failed'
export type ComposerReceiptState =
  | 'idle'
  | 'sending'
  | 'sent'
  | 'queued'
  | 'waiting_for_connection'
  | 'uncertain'
  | 'rejected'

const RESIDENT_LIFECYCLE_WARMUP_GRACE_MS = 15_000

// Mutation-only validators stay behind the action boundary. Startup uses the
// small path-free guards above and does not fetch OAuth, hashing, or candidate
// evaluation schemas before the user asks for those capabilities.
const loadProtocolSchemas = () => import('../../shared/protocol')

function requireResidentLifecycleStatus(value: unknown): ResidentLifecycleStatus {
  const parsed = parseResidentLifecycleStatus(value)
  if (!parsed.success) throw new Error('The native service returned an invalid resident lifecycle status.')
  return parsed.data
}

export type HostRuntimeReadiness =
  | {
      kind: 'not_reported'
      freshness: 'live' | 'cached'
      observedAt?: string
    }
  | {
      kind: 'reported'
      freshness: 'live' | 'cached'
      observedAt?: string
      status: 'initializing' | 'ready' | 'failed' | 'unavailable'
      phase?: 'preparing' | 'validating_seed' | 'copying' | 'verifying' | 'publishing'
      assurance?: 'development-integrity' | 'production-authenticated'
      retryable?: boolean
      recovery?: 'retry' | 'restart' | 'repair' | 'diagnostics'
    }

export type LocalSetupStage =
  | 'starting_local_service'
  | 'preparing_runtime'
  | 'choose_workspace'
  | 'needs_attention'

export interface LocalSetupIssue {
  area: 'local_service' | 'runtime'
  action: 'retry_connection' | 'retry_runtime' | 'repair_runtime' | 'manual_recovery' | 'review_diagnostics'
  message: string
  retryable: boolean
  code?: string
}

/** Path-free first-run state derived only from the current native local authority. */
export interface LocalSetupSummary {
  stage: LocalSetupStage
  runtimeReadiness?: HostRuntimeReadiness
  issue?: LocalSetupIssue
}

export interface HostSummary {
  id: string
  name: string
  kind: 'local' | 'ssh' | 'paired'
  connection: ConnectionState
  connectionPath: 'Local socket' | 'SSH' | 'Relay'
  lastSynchronized?: string
  latencyMs?: number
  compatibility: 'compatible' | 'update_available' | 'upgrade_required'
  /** Integrity readiness is projected only for the currently verified host authority. */
  runtimeReadiness?: HostRuntimeReadiness
  /** Exact SSH authority is online but remains mutation-gated until explicit verification finishes. */
  activationRequired?: boolean
}

export interface TranscriptBlock {
  id: string
  kind: 'user' | 'assistant' | 'tool' | 'checkpoint' | 'notice'
  author?: string
  time: string
  body: string
  detail?: string
  receipt?: string
  /** Authoritative, generation-bound assistant output that has not materialized yet. */
  streaming?: true
}

export interface ThreadSummary {
  id: string
  /** Host-protocol identifier when the renderer needs a host-scoped UI key. */
  remoteId?: string
  projectId: string
  title: string
  recap: string
  hostId: string
  status: TaskState
  updatedAt: string
  unread?: boolean
  executionGenerationId?: string
  workspaceId?: string
  residentLifecycle?: {
    state: 'ended'
    operationId: string
    endedAt: string
    reason: 'user_end'
  }
  transcript: TranscriptBlock[]
}

export interface ProjectSummary {
  id: string
  name: string
  repository: string
  hostIds: string[]
  branch: string
  dirtyFiles: number
}

export interface AttentionItem {
  id: string
  threadId: string
  kind: 'approval' | 'question' | 'failed'
  title: string
  hostName: string
  diagnostic?: {
    code: string
    message: string
    retryable: boolean
    diagnosticId?: string
  }
}

export interface ChangeSummary {
  path: string
  additions: number
  deletions: number
  status: 'modified' | 'added'
}

export interface AgentSummary {
  id: string
  name: string
  sessionName?: string
  role: string
  status: 'pending' | 'queued' | 'running' | 'waiting' | 'complete' | 'failed' | 'cancelled'
  hostName: string
  parentId?: string
  activeSessionId?: string
  model?: string
  activity?: string
  durationMs?: number
  answerPreview?: string
  repliedSinceTask?: boolean
  toolUseCount?: number
  tokenCount?: number
  recap?: string
  error?: string
}

export interface RuntimeGoalSummary {
  id: string
  objective: string
  state: 'active' | 'paused' | 'budget_limited' | 'complete' | 'error'
  tokenBudget?: number
  tokensUsed?: number
  timeUsedSeconds?: number
  continuationsUsed?: number
  detail?: string
}

export interface RuntimeScheduleSummary {
  id: string
  label: string
  state: 'active' | 'paused' | 'completed' | 'cancelled'
  kind?: 'once' | 'cron' | 'interval'
  source?: 'cron' | 'heartbeat' | 'rlm_heartbeat'
  nextRunAt?: string
  runCount?: number
  detail?: string
}

export interface RuntimeSessionSummary {
  residency: 'resident' | 'client_owned' | 'unknown'
  appVersion?: string
  activeSessionId?: string
  sessionId?: string
  sessionName?: string
  model?: string
  thinkingLevel?: string
  availableThinkingLevels?: string[]
  serviceTier?: string
  isStreaming: boolean
  isCompacting: boolean
  isBashRunning: boolean
  retryAttempt: number
  queuedActionCount: number
  messageCount: number
  compactionCount: number
  activeToolNames: string[]
  /** Path-free resources discovered by this exact resident Prime Agent session. */
  resourceInventory?: RuntimeResourceInventory
  context?: {
    usedTokens: number
    maxTokens?: number
  }
}

export interface RuntimeSummary {
  session?: RuntimeSessionSummary
  /** Exact-generation resident command readiness. Undefined means the projection was absent or foreign. */
  residentControlReadiness?: 'ready' | 'unavailable'
  /** Exact-binding browser execution proof. Skill discovery alone never populates this field. */
  browserExecution?: ResidentBrowserExecution
  /** True only when retained-agent data is reported, including an authoritative empty list. */
  agentsReported?: boolean
  /** Undefined means the selected host snapshot did not project this capability. */
  queue?: {
    pendingCount: number
    paused: boolean
  }
  /** Undefined means unavailable; an empty array is an authoritative empty state. */
  goals?: RuntimeGoalSummary[]
  /** Undefined means unavailable; an empty array is an authoritative empty state. */
  schedules?: RuntimeScheduleSummary[]
}

export interface EvidenceSummary {
  id: string
  label: string
  detail: string
  status: 'passed' | 'running' | 'warning'
  duration?: string
}

export interface OutcomeCursorSummary {
  threadId: string
  executionGenerationId: string
  generation: string
  sequence: number
}

/** Exact host-owned completion evidence for the latest acknowledged resident turn. */
export interface LatestTurnOutcomeSummary {
  outcomeVersion: 1
  commandId: string
  receiptId: string
  observedAt: string
  observedCursor: OutcomeCursorSummary
  terminalAssistant?: {
    blockId: string
    stopReason: 'stop' | 'length' | 'error' | 'aborted'
  }
}

/** Freshness of the exact selected thread snapshot, never mutation authority. */
export interface SnapshotAuthoritySummary {
  source: 'live' | 'cached'
  generatedAt: string
  cursor: OutcomeCursorSummary
}

/** Aggregate Git facts only. The native snapshot does not disclose a file list. */
export interface GitAggregateSummary {
  stagedFiles: number
  unstagedFiles: number
  untrackedFiles: number
  changedFileCount: number
  knownDetail: false
}

export interface WorkbenchSnapshot {
  selectedProjectId: string
  selectedThreadId: string
  projects: ProjectSummary[]
  threads: ThreadSummary[]
  hosts: HostSummary[]
  attention: AttentionItem[]
  changes: ChangeSummary[]
  agents: AgentSummary[]
  evidence: EvidenceSummary[]
  runtime: RuntimeSummary
  /** Exact latest acknowledged turn outcome when the host reported one. */
  latestTurnOutcome?: LatestTurnOutcomeSummary
  /** Exact snapshot lineage and whether it was freshly materialized from the connected host. */
  snapshotAuthority?: SnapshotAuthoritySummary
  /** Aggregate change counts from the selected snapshot; paths are never invented. */
  gitSummary?: GitAggregateSummary
  /** Current local setup only; never contains a folder, socket, executable, or data-root path. */
  localSetup?: LocalSetupSummary
  /** Bounded, path-free desktop ledger for fresh resident lifecycle recovery. */
  residentLifecycleOperations: ResidentLifecycleOperationSummary[]
  /** Exact live Prime Agent dialog requests for the selected resident attachment. */
  residentExtensionUiRequests?: ResidentExtensionUiRequest[]
  operations: {
    submitCommands: boolean
    startResidentTurn?: boolean
    stopResidentTurn?: boolean
    provisionResident?: boolean
    endResident?: boolean
    crossHostHandoff: boolean
    modelCatalog?: boolean
    /** Eligibility only; the native action revalidates the exact idle resident authority. */
    selectResidentModel?: boolean
    /** Eligibility only; the native action revalidates the exact idle resident authority and reported level. */
    selectResidentThinkingLevel?: boolean
    /** Eligibility only; native OAuth revalidates the exact trusted local host connection. */
    runtimeOAuth?: boolean
    /** Eligibility only; the native action revalidates the exact trusted local runtime. */
    runtimeProviderSetup?: boolean
    /** Capability-derived probe availability only; never an action authorization. */
    candidateEvaluationProbe?: boolean
  }
  composerReceipt: {
    state: ComposerReceiptState
    message?: string
    operation?: 'prompt' | 'abort' | 'end'
    retryable?: boolean
  }
}

export type ResidentLifecycleOperationState =
  | 'submitted'
  | 'outcome_unknown'
  | 'requires_reselection'
  | 'terminal_refresh_pending'
  | 'terminal'

interface ResidentLifecycleOperationBase {
  operationId: string
  expectedHostId: string
  projectId: string
  workspaceId: string
  threadId: string
  executionGenerationId: string
  createdAt: string
  updatedAt: string
  state: ResidentLifecycleOperationState
  lastStatus?: ResidentLifecycleStatus
}

export interface ResidentProvisionOperationSummary extends ResidentLifecycleOperationBase {
  kind: 'provision'
  projectDisplayName: string
  threadTitle: string
  sessionName?: string
  provisionMode?: 'local_path' | 'registered_workspace'
  referenceThreadId?: string
  referenceExecutionGenerationId?: string
}

export interface ResidentEndOperationSummary extends ResidentLifecycleOperationBase {
  kind: 'end'
  sourceCursor: {
    threadId: string
    executionGenerationId: string
    generation: string
    sequence: number
  }
}

export type ResidentLifecycleOperationSummary =
  | ResidentProvisionOperationSummary
  | ResidentEndOperationSummary

const RESIDENT_PROVISION_PHASE_RESERVES_WORKSPACE: Record<ResidentLifecycleStatus['phase'], boolean> = {
  prepared: true,
  owned_create_dispatching: true,
  owned_observed: true,
  promotion_dispatching: true,
  promoted_observed: true,
  projection_committed: true,
  committed: true,
  quarantined: true,
  completed: false,
  ending: false,
  kill_dispatching: false,
  kill_acknowledged: false,
  detached: false,
}

export function registeredWorkspaceProvisionHoldsAuthority(
  operation: ResidentLifecycleOperationSummary,
  operations: ResidentLifecycleOperationSummary[],
  threads: ThreadSummary[],
): boolean {
  if (
    operation.kind !== 'provision' ||
    operation.provisionMode !== 'registered_workspace'
  ) return false

  const statusHoldsAuthority = operation.lastStatus?.kind === 'provision'
    ? RESIDENT_PROVISION_PHASE_RESERVES_WORKSPACE[operation.lastStatus.phase]
    : true
  if (!statusHoldsAuthority) return false

  const exactThreadIsEnded = threads.some((thread) =>
    thread.hostId === operation.expectedHostId &&
    (thread.remoteId ?? thread.id) === operation.threadId &&
    thread.executionGenerationId === operation.executionGenerationId &&
    thread.residentLifecycle?.state === 'ended',
  )
  const exactCompletedEnd = operations.some((candidate) =>
    candidate.kind === 'end' &&
    candidate.expectedHostId === operation.expectedHostId &&
    candidate.projectId === operation.projectId &&
    candidate.workspaceId === operation.workspaceId &&
    candidate.threadId === operation.threadId &&
    candidate.executionGenerationId === operation.executionGenerationId &&
    candidate.lastStatus?.kind === 'end' &&
    candidate.lastStatus.phase === 'completed',
  )
  return !exactThreadIsEnded && !exactCompletedEnd
}

type ResidentProvisionResumeMode = 'continue' | 'retry' | 'main_validated'

function residentProvisionResumeMode(operation: ResidentProvisionOperationSummary): ResidentProvisionResumeMode | undefined {
  if (operation.state === 'requires_reselection') return 'continue'
  const status = operation.lastStatus
  if (status?.kind !== 'provision') return undefined
  if (status.phase === 'completed') {
    return status.completionReason === 'owned_create_failed_before_effect' ||
      status.completionReason === 'owned_create_cleaned'
      ? 'retry'
      : undefined
  }
  return operation.state === 'submitted' && (
    status.phase === 'prepared' ||
    status.phase === 'promoted_observed' ||
    status.phase === 'projection_committed'
  )
    ? 'continue'
    : undefined
}

interface ResidentWorkspaceSelectionBase {
  selectionToken: string
  operationId: string
  expectedHostId: string
  suggestedName: string
  expiresAt: string
}

export type ResidentWorkspaceSelection =
  | (ResidentWorkspaceSelectionBase & { kind?: 'local_path' })
  | (ResidentWorkspaceSelectionBase & {
      kind: 'registered_workspace'
      projectId: string
      workspaceId: string
      referenceThreadId: string
      referenceExecutionGenerationId: string
    })

export interface ResidentWorkspacePreselection {
  preselectionToken: string
  suggestedName: string
  expiresAt: string
}

export type ResidentWorkspaceSelectionInput =
  | { kind?: 'local_path'; resumeOperationId?: string }
  | {
      kind: 'registered_workspace'
      projectId: string
      workspaceId: string
      referenceThreadId: string
      referenceExecutionGenerationId: string
      resumeOperationId?: string
    }

export interface ResidentEndPreparation {
  confirmationToken: string
  operationId: string
  expectedHostId: string
  threadId: string
  executionGenerationId: string
  expiresAt: string
}

export interface DiscoveredComputer {
  alias: string
  effectiveTarget: string
  fingerprint: string
  protocol: string
  platform: string
  architecture: string
  diskFree: string
  gitVersion: string
  pythonStatus: string
  agentVersion: string
  hostServiceVersion?: string
  requiresInstall: boolean
  installCommand: string
  recentProjects: string[]
  probeComplete: boolean
  installAvailable: boolean
  installDeferredReason?: string
}

export interface HandoffPlan {
  handoffId: string
  sourceHostId: string
  sourceName: string
  destinationHostId: string
  destinationName: string
  repository: string
  destinationProject: string
  branch: string
  dirtyFiles: number
  untrackedFiles: number
  transferSize: string
  repositoryMatch: 'exact' | 'user_confirmed'
  runtimeLosses: string[]
  warnings: string[]
}

export type HandoffPhase =
  | 'quiescing'
  | 'checkpointing'
  | 'transferring'
  | 'materializing'
  | 'verifying'
  | 'switching_authority'
  | 'complete'

export interface ComposerRequest {
  threadId: string
  text: string
}

export interface ResidentModelSelectionRequest {
  threadId: string
  providerId: string
  modelId: string
}

export interface ResidentThinkingLevelSelectionRequest {
  threadId: string
  level: string
}

export type ResidentModelSelectionResult =
  | { state: 'completed'; message: string; projected: boolean }
  | { state: 'rejected'; message: string; retryable: boolean }
  | { state: 'uncertain'; message: string; retryable: false }

export type ResidentThinkingLevelSelectionResult = ResidentModelSelectionResult

export type ResidentExtensionUiResponseResult =
  | { state: 'completed'; message: string }
  | { state: 'rejected'; message: string; retryable: boolean }
  | { state: 'uncertain'; message: string; retryable: false }

export interface RuntimeOAuthRequest {
  hostId: string
  providerId: string
}

export type RuntimeOAuthProgress = {
  phase: 'starting' | 'awaiting_user' | 'committing' | 'cancelling'
  message: string
}

export type RuntimeOAuthResult =
  | { state: 'completed'; message: string; catalog?: RuntimeModelCatalog }
  | { state: 'cancelled'; message: string }
  | { state: 'failed'; message: string; retryable: boolean }
  | { state: 'uncertain'; message: string; retryable: false }

export interface RuntimeProviderSetupRequest {
  hostId: string
  providerId: string
}

export type RuntimeProviderSetupResult =
  | { state: 'opened'; message: string; retryable: false }
  | { state: 'failed_before_launch'; message: string; retryable: true }
  | { state: 'indeterminate'; message: string; retryable: false }

export interface RendererApi {
  environment: 'native' | 'preview'
  loadWorkbench(): Promise<WorkbenchSnapshot>
  subscribe?(listener: (snapshot: WorkbenchSnapshot) => void): () => void
  hudOpen(target: HudTarget): Promise<HudState>
  hudState(): Promise<HudState>
  hudSetMode(mode: HudMode): Promise<HudState>
  hudClose(): Promise<HudState>
  hudReturnToWorkbench(): Promise<void>
  hudSetIgnoreMouseEvents(ignore: boolean): Promise<HudState>
  onHudState(listener: (state: HudState) => void): () => void
  retryLocalSetup(): Promise<void>
  repairLocalRuntime(): Promise<void>
  selectThread(threadId: string): Promise<void>
  activateComputer(expectedHostId: string): Promise<WorkbenchSnapshot>
  loadRuntimeModelCatalog(hostId: string): Promise<RuntimeModelCatalogSnapshot>
  selectResidentModel(request: ResidentModelSelectionRequest): Promise<ResidentModelSelectionResult>
  selectResidentThinkingLevel?(
    request: ResidentThinkingLevelSelectionRequest,
  ): Promise<ResidentThinkingLevelSelectionResult>
  respondToResidentExtensionUi?(
    request: ResidentExtensionUiRequest,
    response: ExtensionUiDialogResponse,
  ): Promise<ResidentExtensionUiResponseResult>
  startRuntimeOAuth?(
    request: RuntimeOAuthRequest,
    onProgress: (progress: RuntimeOAuthProgress) => void,
  ): Promise<RuntimeOAuthResult>
  cancelRuntimeOAuth?(request: RuntimeOAuthRequest): Promise<RuntimeOAuthResult | null>
  openRuntimeProviderSetup?(
    request: RuntimeProviderSetupRequest,
  ): Promise<RuntimeProviderSetupResult>
  preselectResidentWorkspace(): Promise<ResidentWorkspacePreselection>
  completeResidentWorkspacePreselection(preselectionToken: string): Promise<ResidentWorkspaceSelection>
  cancelResidentWorkspacePreselection(preselectionToken: string): Promise<void>
  selectResidentWorkspace(input?: ResidentWorkspaceSelectionInput): Promise<ResidentWorkspaceSelection>
  provisionResident(input: {
    selectionToken: string
    projectDisplayName: string
    threadTitle: string
    sessionName?: string
  }): Promise<ResidentLifecycleStatus>
  prepareResidentEnd(input: {
    expectedHostId: string
    projectId: string
    workspaceId: string
    threadId: string
    executionGenerationId: string
    resumeOperationId?: string
  }): Promise<ResidentEndPreparation>
  endResident(input: { confirmationToken: string; consent: true }): Promise<ResidentLifecycleStatus>
  residentLifecycleStatus(input: {
    expectedHostId: string
    operationId: string
  }): Promise<ResidentLifecycleStatus | null>
  candidateEvaluationPreflight?(input: CandidateEvaluationPreflightRequest): Promise<CandidateEvaluationPreflight>
  startCandidateEvaluation?(input: CandidateEvaluationStartRequest): Promise<CandidateEvaluationStatus>
  candidateEvaluationSnapshot?(input: CandidateEvaluationPreflightRequest): Promise<CandidateEvaluationSnapshot>
  discoverComputers(): Promise<DiscoveredComputer[]>
  probeComputer(input: { alias?: string; hostname?: string; user?: string }): Promise<DiscoveredComputer>
  addComputer(input: {
    alias: string
    installHostService: boolean
    installCommandAcknowledged: boolean
  }): Promise<{ host: HostSummary }>
  sendComposer(request: ComposerRequest): Promise<{ state: ComposerReceiptState; message: string; retryable?: boolean }>
  abortThread(threadId: string): Promise<{ state: ComposerReceiptState; message: string; retryable?: boolean }>
  planHandoff(input: {
    threadId: string
    destinationHostId: string
    behaviorIfRunning: 'interrupt' | 'wait_for_idle'
  }): Promise<HandoffPlan>
  startHandoff(
    input: {
      handoffId: string
      behaviorIfRunning: 'interrupt' | 'wait_for_idle'
    },
    onProgress: (phase: HandoffPhase, message: string) => void,
  ): Promise<{ destinationHostId: string; receiptId: string }>
}

export class StaleHostAuthorityError extends Error {
  readonly code = 'STALE_HOST_AUTHORITY'

  constructor() {
    super('The active host changed while the command was being delivered.')
    this.name = 'StaleHostAuthorityError'
  }
}

export function isStaleHostAuthorityError(value: unknown): value is StaleHostAuthorityError {
  return value instanceof StaleHostAuthorityError
}

export class ResidentProvisionError extends Error {
  readonly durableOperationPossible: boolean
  readonly code?: string
  readonly receiptId?: string
  readonly details?: UnknownRecord
  readonly retryable?: boolean

  constructor(message: string, options: {
    durableOperationPossible: boolean
    code?: string
    receiptId?: string
    details?: UnknownRecord
    retryable?: boolean
    cause?: unknown
  }) {
    super(message, { cause: options.cause })
    this.name = 'ResidentProvisionError'
    this.durableOperationPossible = options.durableOperationPossible
    this.code = options.code
    this.receiptId = options.receiptId
    this.details = options.details
    this.retryable = options.retryable
  }
}

export function residentProvisionMayHaveDurableOperation(value: unknown): boolean {
  return value instanceof ResidentProvisionError
    ? value.durableOperationPossible
    : true
}

type NativePrimeBridge = object

const delay = (milliseconds: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds))

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is UnknownRecord => Boolean(item)) : []
}

function canonicalRendererJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize)
    const record = asRecord(candidate)
    if (!record) return candidate
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, normalize(record[key])]),
    )
  }
  return JSON.stringify(normalize(value))
}

function sameRuntimeIntegrityLineage(
  current: RuntimeIntegritySnapshot,
  next: RuntimeIntegritySnapshot,
): boolean {
  return (
    current.contractVersion === next.contractVersion &&
    current.trustAnchorId === next.trustAnchorId &&
    canonicalRendererJson(current.target) === canonicalRendererJson(next.target)
  )
}

const DISPLAY_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const CLOCK_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function displayTime(value: unknown): string {
  const dateValue = asString(value)
  if (!dateValue || !Number.isFinite(Date.parse(dateValue))) return ''
  const date = new Date(dateValue)
  const delta = Date.now() - date.getTime()
  if (delta >= 0 && delta < 60_000) return 'Now'
  if (delta >= 0 && delta < 60 * 60_000) return `${Math.max(1, Math.floor(delta / 60_000))} min`
  if (delta >= 0 && delta < 24 * 60 * 60_000) return `${Math.max(1, Math.floor(delta / (60 * 60_000)))} h`
  return DISPLAY_DATE_FORMATTER.format(date)
}

function clockTime(value: unknown): string {
  const dateValue = asString(value)
  if (!dateValue || !Number.isFinite(Date.parse(dateValue))) return ''
  return CLOCK_TIME_FORMATTER.format(new Date(dateValue))
}

function formatBytes(value: unknown): string {
  const bytes = asNumber(value)
  if (bytes === undefined) return 'Size calculated by destination'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let amount = bytes / 1024
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`
}

function commandLine(argv: unknown): string {
  if (!Array.isArray(argv)) return ''
  return argv
    .filter((part): part is string => typeof part === 'string')
    .map((part) => (/^[A-Za-z0-9_./:@=-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`))
    .join(' ')
}

function connectionFromNative(value: unknown): ConnectionState {
  if (value === 'online') return 'online'
  if (value === 'connecting' || value === 'reconnecting' || value === 'degraded') return 'reconnecting'
  return 'offline'
}

function runtimeReadinessFromNative(value: unknown, activePhase: string | undefined): HostRuntimeReadiness | undefined {
  const readiness = asRecord(value)
  const kind = asString(readiness?.kind)
  const freshness = activePhase === 'online' || activePhase === 'degraded' ? 'live' : 'cached'
  const observedAt = asString(readiness?.observedAt)
  if (kind === 'not_reported') {
    return { kind, freshness, ...(observedAt ? { observedAt } : {}) }
  }
  if (kind !== 'reported') return undefined
  const snapshot = asRecord(readiness?.snapshot)
  const status = asString(snapshot?.status)
  if (status !== 'initializing' && status !== 'ready' && status !== 'failed' && status !== 'unavailable') {
    return undefined
  }
  const phase = asString(snapshot?.phase)
  const validPhase =
    phase === 'preparing' ||
    phase === 'validating_seed' ||
    phase === 'copying' ||
    phase === 'verifying' ||
    phase === 'publishing'
      ? phase
      : undefined
  const assurance = asString(snapshot?.assurance)
  const validAssurance =
    assurance === 'development-integrity' || assurance === 'production-authenticated'
      ? assurance
      : undefined
  const retryable = snapshot?.retryable === true
  const recoveryAction = asString(snapshot?.recoveryAction)
  const recovery = recoveryAction === 'retry_runtime_verification'
    ? 'retry'
    : recoveryAction === 'retry_runtime_initialization' || recoveryAction === 'restart_host_service'
    ? 'restart'
    : recoveryAction === 'reinstall_application' || recoveryAction === 'repair_application'
      ? 'repair'
      : status === 'failed' || status === 'unavailable'
        ? 'diagnostics'
        : undefined
  return {
    kind,
    freshness,
    ...(observedAt ? { observedAt } : {}),
    status,
    ...(validPhase ? { phase: validPhase } : {}),
    ...(validAssurance ? { assurance: validAssurance } : {}),
    ...((status === 'failed' || status === 'unavailable') ? { retryable } : {}),
    ...(recovery ? { recovery } : {}),
  }
}

function localSetupDiagnosticCode(value: unknown): string | undefined {
  const code = asString(value)
  return code && /^[A-Za-z0-9._-]{1,96}$/.test(code) ? code : undefined
}

function localConnectionIssueFromNative(value: unknown): LocalSetupIssue | undefined {
  const error = asRecord(value)
  if (!error) return undefined
  const code = localSetupDiagnosticCode(error.code)
  const retryable = error.retryable === true
  const message = code === 'hostd.start_timeout'
    ? 'The local service did not become ready in time.'
    : code === 'hostd.bundle_missing'
      ? 'The bundled local service is missing from this installation.'
      : code === 'hostd.spawn_failed'
        ? 'Prime Continuim could not start the bundled local service.'
        : code === 'hostd.endpoint_mismatch'
          ? 'The local service could not verify its private endpoint.'
          : 'Prime Continuim could not connect to the local service.'
  return {
    area: 'local_service',
    action: retryable ? 'retry_connection' : 'review_diagnostics',
    message,
    retryable,
    ...(code ? { code } : {}),
  }
}

function runtimeSetupIssue(
  readiness: Extract<HostRuntimeReadiness, { kind: 'reported' }>,
  runtimeRetryAdvertised: boolean,
  runtimeRepairAdvertised: boolean,
  code?: string,
): LocalSetupIssue {
  if (
    readiness.freshness === 'live' &&
    readiness.status === 'failed' &&
    readiness.retryable === true &&
    runtimeRetryAdvertised
  ) {
    return {
      area: 'runtime',
      action: 'retry_runtime',
      message: 'Runtime verification did not finish. Retry verification to run the same checks again.',
      retryable: true,
      ...(code ? { code } : {}),
    }
  }
  if (readiness.recovery === 'restart') {
    return {
      area: 'runtime',
      action: 'review_diagnostics',
      message: 'Runtime verification could not finish. Record the diagnostic code and contact support; Prime Continuim cannot restart the detached host service from this screen.',
      retryable: false,
      ...(code ? { code } : {}),
    }
  }
  if (readiness.recovery === 'repair') {
    if (
      readiness.freshness === 'live' &&
      readiness.status === 'failed' &&
      readiness.retryable === false &&
      runtimeRepairAdvertised
    ) {
      return {
        area: 'runtime',
        action: 'repair_runtime',
        message: 'Prime Continuim can quarantine the failed local runtime copy and restore it from this app’s verified bundle. Saved projects, threads, and workspace files will remain unchanged.',
        retryable: false,
        ...(code ? { code } : {}),
      }
    }
    return {
      area: 'runtime',
      action: 'manual_recovery',
      message: 'The installed runtime did not pass verification. Record the diagnostic code and contact support before changing local runtime data; this screen will not replace it.',
      retryable: false,
      ...(code ? { code } : {}),
    }
  }
  return {
    area: 'runtime',
    action: 'review_diagnostics',
    message: 'Prime Continuim could not verify the bundled runtime. Review the diagnostic code before continuing.',
    retryable: false,
    ...(code ? { code } : {}),
  }
}

function localSetupFromNative(input: {
  rawConnection: UnknownRecord | undefined
  runtimeReadiness: HostRuntimeReadiness | undefined
  runtimeCode?: string
  runtimeRetryAdvertised: boolean
  runtimeRepairAdvertised: boolean
  residentProvisioningReady: boolean
  residentLifecycleAdvertised: boolean
}): LocalSetupSummary | undefined {
  const phase = asString(input.rawConnection?.phase)
  const targetKind = asString(asRecord(input.rawConnection?.target)?.kind)
  const verifiedHostId = asString(input.rawConnection?.hostId)
  const localIntent = targetKind === 'local' || (!targetKind && !verifiedHostId && (!phase || phase === 'offline'))
  if (!localIntent) return undefined

  const runtimeIsExactlyReady = input.runtimeReadiness?.kind === 'reported' &&
    input.runtimeReadiness.freshness === 'live' &&
    input.runtimeReadiness.status === 'ready'
  if (
    input.residentProvisioningReady &&
    input.residentLifecycleAdvertised &&
    phase === 'online' &&
    asString(input.rawConnection?.path) === 'local_socket' &&
    runtimeIsExactlyReady
  ) {
    return {
      stage: 'choose_workspace',
      ...(input.runtimeReadiness ? { runtimeReadiness: input.runtimeReadiness } : {}),
    }
  }

  const connectionIssue = localConnectionIssueFromNative(input.rawConnection?.error)
  if (!phase || phase === 'connecting' || phase === 'reconnecting') {
    return { stage: 'starting_local_service' }
  }
  if (phase === 'offline') {
    return connectionIssue
      ? { stage: 'needs_attention', issue: connectionIssue }
      : { stage: 'starting_local_service' }
  }

  const liveReadiness = input.runtimeReadiness?.freshness === 'live' ? input.runtimeReadiness : undefined
  if (phase === 'degraded') {
    if (liveReadiness?.kind === 'reported' && liveReadiness.status === 'initializing') {
      return { stage: 'preparing_runtime', runtimeReadiness: liveReadiness }
    }
    if (
      liveReadiness?.kind === 'reported' &&
      (liveReadiness.status === 'failed' || liveReadiness.status === 'unavailable')
    ) {
      return {
        stage: 'needs_attention',
        runtimeReadiness: liveReadiness,
        issue: runtimeSetupIssue(
          liveReadiness,
          input.runtimeRetryAdvertised,
          input.runtimeRepairAdvertised,
          input.runtimeCode,
        ),
      }
    }
    const issue = connectionIssue ?? {
      area: 'local_service' as const,
      action: 'review_diagnostics' as const,
      message: 'The local service connected, but setup could not finish safely.',
      retryable: false,
    }
    return {
      stage: 'needs_attention',
      ...(liveReadiness ? { runtimeReadiness: liveReadiness } : {}),
      issue,
    }
  }
  if (liveReadiness?.kind === 'reported') {
    if (liveReadiness.status === 'failed' || liveReadiness.status === 'unavailable') {
      return {
        stage: 'needs_attention',
        runtimeReadiness: liveReadiness,
        issue: runtimeSetupIssue(
          liveReadiness,
          input.runtimeRetryAdvertised,
          input.runtimeRepairAdvertised,
          input.runtimeCode,
        ),
      }
    }
    if (liveReadiness.status === 'ready' && !input.residentLifecycleAdvertised) {
      const runtimeReadyAt = liveReadiness.observedAt ? Date.parse(liveReadiness.observedAt) : Number.NaN
      if (Number.isFinite(runtimeReadyAt) && Date.now() - runtimeReadyAt < RESIDENT_LIFECYCLE_WARMUP_GRACE_MS) {
        return { stage: 'preparing_runtime', runtimeReadiness: liveReadiness }
      }
      return {
        stage: 'needs_attention',
        runtimeReadiness: liveReadiness,
        issue: {
          area: 'local_service',
          action: 'review_diagnostics',
          message: 'This local host service is incompatible with resident workspace setup. Review the diagnostic code and use a compatible host service before continuing.',
          retryable: false,
          code: 'resident_lifecycle_unavailable',
        },
      }
    }
    if (liveReadiness.status === 'ready' && asString(input.rawConnection?.path) !== 'local_socket') {
      return {
        stage: 'needs_attention',
        runtimeReadiness: liveReadiness,
        issue: {
          area: 'local_service',
          action: 'review_diagnostics',
          message: 'The verified local host is not connected through its private local socket. Review diagnostics before continuing.',
          retryable: false,
          code: 'local_socket_required',
        },
      }
    }
    return { stage: 'preparing_runtime', runtimeReadiness: liveReadiness }
  }
  if (liveReadiness?.kind === 'not_reported') {
    return {
      stage: 'needs_attention',
      runtimeReadiness: liveReadiness,
      issue: {
        area: 'runtime',
        action: 'review_diagnostics',
        message: 'This local host service does not report verified runtime readiness. Review diagnostics and use a compatible host service before continuing.',
        retryable: false,
        code: 'runtime_readiness_not_reported',
      },
    }
  }
  return {
    stage: 'needs_attention',
    issue: {
      area: 'runtime',
      action: 'review_diagnostics',
      message: 'The local service did not report runtime readiness for its verified host identity. Review diagnostics before continuing.',
      retryable: false,
      code: 'runtime_readiness_unavailable',
    },
  }
}

function taskFromNative(value: unknown): TaskState {
  if (value === 'running' || value === 'waiting' || value === 'needs_approval' || value === 'complete' || value === 'failed') {
    return value
  }
  return 'idle'
}

class NativeBridgeError extends Error {
  readonly code?: string
  readonly receiptId?: string
  readonly details?: UnknownRecord
  readonly durableOperationPossible?: boolean
  readonly retryable?: boolean

  constructor(message: string, options: {
    code?: string
    receiptId?: string
    details?: UnknownRecord
    durableOperationPossible?: boolean
    retryable?: boolean
  }) {
    super(message)
    this.name = 'NativeBridgeError'
    this.code = options.code
    this.receiptId = options.receiptId
    this.details = options.details
    this.durableOperationPossible = options.durableOperationPossible
    this.retryable = options.retryable
  }
}

const DEFINITIVE_CANDIDATE_EVALUATION_START_CODES = new Set([
  'candidate.evaluation_live_connection_required',
  'candidate.evaluation_authority_changed',
  'candidate.evaluation_local_required',
  'candidate.evaluation_unavailable',
  'host.evaluation_busy',
  'host.evaluation_outcome_unknown',
  'host.candidate_changed',
  'host.request_expired',
  'host.evaluation_id_conflict',
  'host.evaluation_storage_full',
  'host.host_id_mismatch',
  'host.evaluator_not_ready',
  'host.evaluation_closed',
  'host.invalid_request',
  'host.incompatible_protocol',
  'transport.offline',
  'ipc.untrusted_sender',
  'ipc.invalid_payload',
  'ipc.payload_limit',
])

export function isDefinitiveCandidateEvaluationStartError(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const code = 'code' in value ? (value as { code?: unknown }).code : undefined
  return typeof code === 'string' && DEFINITIVE_CANDIDATE_EVALUATION_START_CODES.has(code)
}

function bridgeError(raw: unknown): Error {
  const error = asRecord(raw)
  const message = asString(error?.message) ?? 'The native Prime service could not complete this request.'
  const code = asString(error?.code)
  const receipt = asString(error?.receiptId)
  const details = asRecord(error?.details)
  const durableOperationPossible = asBoolean(error?.durableOperationPossible) ??
    asBoolean(details?.durableOperationPossible)
  const retryable = asBoolean(error?.retryable) ?? asBoolean(details?.retryable)
  const suffix = [code, receipt ? `receipt ${receipt}` : undefined].filter(Boolean).join(' · ')
  return new NativeBridgeError(suffix ? `${message} (${suffix})` : message, {
    ...(code ? { code } : {}),
    ...(receipt ? { receiptId: receipt } : {}),
    ...(details ? { details } : {}),
    ...(durableOperationPossible !== undefined ? { durableOperationPossible } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  })
}

function residentProvisionErrorFrom(
  error: unknown,
  defaultDurableOperationPossible: boolean,
): ResidentProvisionError {
  if (error instanceof ResidentProvisionError) return error
  const nativeError = error instanceof NativeBridgeError ? error : undefined
  const code = nativeError?.code ?? (
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  )
  const durableOperationPossible = nativeError?.durableOperationPossible ?? defaultDurableOperationPossible
  const retryable = nativeError?.retryable ?? (
    error && typeof error === 'object' && 'retryable' in error && typeof error.retryable === 'boolean'
      ? error.retryable
      : undefined
  )
  return new ResidentProvisionError(
    error instanceof Error ? error.message : 'Resident setup did not finish.',
    {
      durableOperationPossible,
      ...(code ? { code } : {}),
      ...(nativeError?.receiptId ? { receiptId: nativeError.receiptId } : {}),
      ...(nativeError?.details ? { details: nativeError.details } : {}),
      ...(retryable !== undefined ? { retryable } : {}),
      cause: error,
    },
  )
}

function unwrapResult<T>(raw: unknown): T {
  const envelope = asRecord(raw)
  if (envelope && typeof envelope.ok === 'boolean') {
    if (envelope.ok) return envelope.value as T
    throw bridgeError(envelope.error)
  }
  throw new Error('The native Prime bridge returned an invalid result envelope.')
}

const RESIDENT_WORKSPACE_SELECTION_KEYS = new Set([
  'selectionToken',
  'operationId',
  'expectedHostId',
  'suggestedName',
  'expiresAt',
])

function residentWorkspaceSelectionFromNative(value: unknown): ResidentWorkspaceSelection {
  const raw = asRecord(value)
  const selectionToken = asString(raw?.selectionToken)
  const operationId = asString(raw?.operationId)
  const expectedHostId = asString(raw?.expectedHostId)
  const suggestedName = asString(raw?.suggestedName)
  const expiresAt = asString(raw?.expiresAt)
  if (
    !raw ||
    Object.keys(raw).some((key) => !RESIDENT_WORKSPACE_SELECTION_KEYS.has(key)) ||
    !selectionToken ||
    selectionToken.length > 512 ||
    /[\0\r\n]/.test(selectionToken) ||
    !operationId ||
    operationId.length > 512 ||
    /[\0\r\n]/.test(operationId) ||
    !expectedHostId ||
    expectedHostId.length > 512 ||
    /[\0\r\n]/.test(expectedHostId) ||
    !suggestedName ||
    suggestedName.length > 255 ||
    /[\0\r\n/\\]/.test(suggestedName) ||
    /^[A-Za-z]:/.test(suggestedName) ||
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new Error('The native service returned an invalid path-free selection receipt for a workspace.')
  }
  return { selectionToken, operationId, expectedHostId, suggestedName, expiresAt }
}

const RESIDENT_WORKSPACE_PRESELECTION_KEYS = new Set([
  'preselectionToken',
  'suggestedName',
  'expiresAt',
])

function residentWorkspacePreselectionFromNative(value: unknown): ResidentWorkspacePreselection {
  const raw = asRecord(value)
  const preselectionToken = asString(raw?.preselectionToken)
  const suggestedName = asString(raw?.suggestedName)
  const expiresAt = asString(raw?.expiresAt)
  if (
    !raw ||
    Object.keys(raw).some((key) => !RESIDENT_WORKSPACE_PRESELECTION_KEYS.has(key)) ||
    !preselectionToken ||
    preselectionToken.length > 512 ||
    /[\0\r\n]/.test(preselectionToken) ||
    !suggestedName ||
    suggestedName.length > 255 ||
    /[\0\r\n/\\]/.test(suggestedName) ||
    /^[A-Za-z]:/.test(suggestedName) ||
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new Error('The native service returned an invalid path-free early workspace choice.')
  }
  return { preselectionToken, suggestedName, expiresAt }
}

const RESIDENT_END_PREPARATION_KEYS = new Set([
  'confirmationToken',
  'operationId',
  'expectedHostId',
  'threadId',
  'executionGenerationId',
  'expiresAt',
])

function residentEndPreparationFromNative(value: unknown): ResidentEndPreparation {
  const raw = asRecord(value)
  const confirmationToken = asString(raw?.confirmationToken)
  const operationId = asString(raw?.operationId)
  const expectedHostId = asString(raw?.expectedHostId)
  const threadId = asString(raw?.threadId)
  const executionGenerationId = asString(raw?.executionGenerationId)
  const expiresAt = asString(raw?.expiresAt)
  if (
    !raw ||
    Object.keys(raw).some((key) => !RESIDENT_END_PREPARATION_KEYS.has(key)) ||
    !confirmationToken || confirmationToken.length > 512 || /[\0\r\n]/.test(confirmationToken) ||
    !operationId || operationId.length > 512 || /[\0\r\n]/.test(operationId) ||
    !expectedHostId || expectedHostId.length > 512 || /[\0\r\n]/.test(expectedHostId) ||
    !threadId || threadId.length > 512 || /[\0\r\n]/.test(threadId) ||
    !executionGenerationId || executionGenerationId.length > 512 || /[\0\r\n]/.test(executionGenerationId) ||
    !expiresAt || !Number.isFinite(Date.parse(expiresAt))
  ) throw new Error('The native service returned an invalid resident end confirmation.')
  return { confirmationToken, operationId, expectedHostId, threadId, executionGenerationId, expiresAt }
}

function createStableId(prefix: string): string {
  const secureRandom = globalThis.crypto
  if (!secureRandom || typeof secureRandom.randomUUID !== 'function') {
    throw new Error('Secure identity generation is unavailable in this renderer.')
  }
  return `${prefix}:${secureRandom.randomUUID()}`
}

function candidateEvaluationAuthorityMatches(
  expected: CandidateEvaluationPreflightRequest,
  received: CandidateEvaluationPreflightRequest,
): boolean {
  return expected.expectedHostId === received.expectedHostId &&
    expected.threadId === received.threadId &&
    expected.expectedExecutionGenerationId === received.expectedExecutionGenerationId
}

function candidateEvaluationReviewMatches(
  expected: CandidateEvaluationReviewIdentity,
  received: CandidateEvaluationReviewIdentity,
): boolean {
  return expected.headCommit === received.headCommit &&
    expected.gitIndexSha256 === received.gitIndexSha256 &&
    expected.gitIndexBytes === received.gitIndexBytes &&
    expected.packageManifestSha256 === received.packageManifestSha256 &&
    expected.lockfileSha256 === received.lockfileSha256 &&
    expected.lockfileBytes === received.lockfileBytes &&
    expected.nodeVersionPinSha256 === received.nodeVersionPinSha256 &&
    expected.selfBuildEntrypointSha256 === received.selfBuildEntrypointSha256 &&
    expected.launcherBootstrapSha256 === received.launcherBootstrapSha256 &&
    expected.launcherBootstrapFileCount === received.launcherBootstrapFileCount &&
    expected.runtimePointerSha256 === received.runtimePointerSha256 &&
    expected.nodePackageManifestSha256 === received.nodePackageManifestSha256 &&
    expected.nodeExecutableSha256 === received.nodeExecutableSha256 &&
    expected.pnpmCliSha256 === received.pnpmCliSha256 &&
    expected.reviewAggregateSha256 === received.reviewAggregateSha256
}

function getDeviceId(): string {
  const storageKey = 'prime.renderer.device-id'
  try {
    if (typeof window === 'undefined') return createStableId('device')
    const existing = window.localStorage.getItem(storageKey)
    if (existing) return existing
    const created = createStableId('device')
    window.localStorage.setItem(storageKey, created)
    return created
  } catch {
    return createStableId('device')
  }
}

function nativeTranscriptBlock(raw: UnknownRecord): TranscriptBlock | undefined {
  const id = asString(raw.blockId)
  const text = asString(raw.text)
  if (!id || text === undefined) return undefined
  const nativeKind = asString(raw.kind)
  const kind: TranscriptBlock['kind'] =
    nativeKind === 'user' || nativeKind === 'assistant' || nativeKind === 'tool' ? nativeKind : 'notice'
  return {
    id,
    kind,
    author: kind === 'user' ? 'You' : kind === 'assistant' ? 'Prime Agent' : kind === 'tool' ? 'Host tool' : undefined,
    time: clockTime(raw.createdAt),
    body: sanitizeResidentDisplayText(text),
  }
}

function nativeInProgressTranscriptBlock(
  value: unknown,
  materializedBlockIds: ReadonlySet<string>,
): TranscriptBlock | undefined {
  const parsed = parseInProgressStream(value)
  if (!parsed.success || materializedBlockIds.has(parsed.data.blockId)) return undefined
  return {
    id: parsed.data.blockId,
    kind: 'assistant',
    author: 'Prime Agent',
    time: clockTime(parsed.data.startedAt),
    body: sanitizeResidentDisplayText(parsed.data.text),
    streaming: true,
  }
}

function retainedTranscriptAgents(
  blocks: readonly TranscriptBlock[],
  existingAgents: readonly AgentSummary[],
  hostName: string,
): AgentSummary[] {
  const existingNames = new Set(existingAgents.flatMap((agent) => [agent.sessionName, agent.name].filter(Boolean)))
  const delegations = new Map<string, { model?: string; blockId: string }>()
  const retained = new Map<string, AgentSummary>()

  for (const block of blocks) {
    const delegation = /(?:^|\n)Delegated to ([^\n·]+?)(?: · ([^\n]+))?$/.exec(block.body)
    if (delegation?.[1]) {
      const name = delegation[1].trim()
      delegations.set(name, {
        ...(delegation[2]?.trim() ? { model: delegation[2].trim() } : {}),
        blockId: block.id,
      })
    }

    const reply = /^Agent message\nFrom ([^\n]+)(?:\n([\s\S]*))?$/.exec(block.body)
    if (!reply?.[1]) continue
    const name = reply[1].trim()
    if (existingNames.has(name)) continue
    const delegationEvidence = delegations.get(name)
    retained.set(name, {
      id: `transcript-agent-${delegationEvidence?.blockId ?? block.id}`,
      name,
      sessionName: name,
      role: 'Retained subagent',
      status: 'complete',
      hostName,
      ...(delegationEvidence?.model ? { model: delegationEvidence.model } : {}),
      ...(reply[2]?.trim() ? { answerPreview: reply[2].trim() } : {}),
      repliedSinceTask: true,
    })
  }

  return [...retained.values()]
}

interface NativeProjectionInput {
  catalog?: unknown
  threadSnapshot?: unknown
  connection?: unknown
  outbox?: unknown
  quarantinedOutboxCount?: unknown
  durableUncertainReceipts?: unknown
  residentLifecycleOperations?: unknown
  updatedAt?: unknown
  selectedThreadId?: string
  deviceId?: string
  mutationAuthorityReady?: boolean
  activationRequiredHostId?: string
  connectionGeneration?: number
  authoritativeMaterialization?: {
    connectionGeneration: number
    hostId: string
    threadId: string
    executionGenerationId: string
  }
}

function outcomeCursorFromNative(value: unknown): OutcomeCursorSummary | undefined {
  const cursor = asRecord(value)
  const threadId = asString(cursor?.threadId)
  const executionGenerationId = asString(cursor?.executionGenerationId)
  const generation = asString(cursor?.generation)
  const sequence = asNumber(cursor?.sequence)
  if (
    !threadId ||
    !executionGenerationId ||
    !generation ||
    sequence === undefined ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0
  ) return undefined
  return { threadId, executionGenerationId, generation, sequence }
}

function latestTurnOutcomeFromNative(
  value: unknown,
  latestCursor: OutcomeCursorSummary,
  snapshotGeneratedAt: string,
  materializedRecentBlocks: unknown,
): LatestTurnOutcomeSummary | undefined {
  const outcome = asRecord(value)
  if (!outcome || outcome.outcomeVersion !== 1) return undefined
  const commandId = asString(outcome.commandId)
  const receiptId = asString(outcome.receiptId)
  const observedAt = asString(outcome.observedAt)
  const observedCursor = outcomeCursorFromNative(outcome.observedCursor)
  if (
    !commandId ||
    !receiptId ||
    !observedAt ||
    !Number.isFinite(Date.parse(observedAt)) ||
    !observedCursor ||
    observedCursor.threadId !== latestCursor.threadId ||
    observedCursor.executionGenerationId !== latestCursor.executionGenerationId ||
    (observedCursor.generation === latestCursor.generation && observedCursor.sequence > latestCursor.sequence) ||
    Date.parse(observedAt) > Date.parse(snapshotGeneratedAt)
  ) return undefined

  const terminal = asRecord(outcome.terminalAssistant)
  if (!terminal) {
    return { outcomeVersion: 1, commandId, receiptId, observedAt, observedCursor }
  }
  const blockId = asString(terminal.blockId)
  const stopReason = asString(terminal.stopReason)
  if (
    !blockId ||
    (stopReason !== 'stop' && stopReason !== 'length' && stopReason !== 'error' && stopReason !== 'aborted')
  ) return undefined
  const terminalBlock = records(materializedRecentBlocks).find((block) => asString(block.blockId) === blockId)
  if (
    !terminalBlock ||
    asString(terminalBlock.kind) !== 'assistant' ||
    !asString(terminalBlock.createdAt) ||
    !Number.isFinite(Date.parse(asString(terminalBlock.createdAt)!)) ||
    Date.parse(asString(terminalBlock.createdAt)!) > Date.parse(observedAt)
  ) return undefined
  return {
    outcomeVersion: 1,
    commandId,
    receiptId,
    observedAt,
    observedCursor,
    terminalAssistant: { blockId, stopReason },
  }
}

function gitAggregateFromNative(value: unknown): GitAggregateSummary | undefined {
  const git = asRecord(value)
  const stagedFiles = asNumber(git?.stagedFiles)
  const unstagedFiles = asNumber(git?.unstagedFiles)
  const untrackedFiles = asNumber(git?.untrackedFiles)
  if (
    stagedFiles === undefined ||
    unstagedFiles === undefined ||
    untrackedFiles === undefined ||
    !Number.isSafeInteger(stagedFiles) ||
    !Number.isSafeInteger(unstagedFiles) ||
    !Number.isSafeInteger(untrackedFiles) ||
    stagedFiles < 0 ||
    unstagedFiles < 0 ||
    untrackedFiles < 0
  ) return undefined
  return {
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    changedFileCount: stagedFiles + unstagedFiles + untrackedFiles,
    knownDetail: false,
  }
}

const RESIDENT_LIFECYCLE_OPERATION_STATES = new Set<ResidentLifecycleOperationState>([
  'submitted',
  'outcome_unknown',
  'requires_reselection',
  'terminal_refresh_pending',
  'terminal',
])

function residentLifecycleOperationsFromNative(
  value: unknown,
  activeHostId: string | undefined,
): ResidentLifecycleOperationSummary[] {
  return records(value)
    .slice(-128)
    .flatMap((entry): ResidentLifecycleOperationSummary[] => {
      const operationId = asString(entry.operationId)
      const expectedHostId = asString(entry.expectedHostId)
      const projectId = asString(entry.projectId)
      const workspaceId = asString(entry.workspaceId)
      const threadId = asString(entry.threadId)
      const executionGenerationId = asString(entry.executionGenerationId)
      const kind = asString(entry.kind) === 'end' ? 'end' : 'provision'
      const projectDisplayName = asString(entry.projectDisplayName)
      const threadTitle = asString(entry.threadTitle)
      const sessionName = asString(entry.sessionName)
      const provisionMode = asString(entry.provisionMode)
      const referenceThreadId = asString(entry.referenceThreadId)
      const referenceExecutionGenerationId = asString(entry.referenceExecutionGenerationId)
      const createdAt = asString(entry.createdAt)
      const updatedAt = asString(entry.updatedAt)
      const state = asString(entry.state) as ResidentLifecycleOperationState | undefined
      const parsedStatus = entry.lastStatus === undefined
        ? undefined
        : parseResidentLifecycleStatus(entry.lastStatus)
      const sourceCursor = nativeSessionCursor(entry.sourceCursor)
      if (
        !operationId ||
        !expectedHostId ||
        expectedHostId !== activeHostId ||
        !projectId ||
        !workspaceId ||
        !threadId ||
        !executionGenerationId ||
        !createdAt ||
        !updatedAt ||
        !state ||
        !RESIDENT_LIFECYCLE_OPERATION_STATES.has(state) ||
        (parsedStatus !== undefined && !parsedStatus.success) ||
        (parsedStatus?.success && parsedStatus.data.kind !== kind) ||
        (kind === 'provision' && (!projectDisplayName || !threadTitle)) ||
        (kind === 'provision' && provisionMode !== undefined &&
          provisionMode !== 'local_path' && provisionMode !== 'registered_workspace') ||
        (kind === 'provision' && provisionMode === 'registered_workspace' &&
          (!referenceThreadId || !referenceExecutionGenerationId)) ||
        (kind === 'end' && !sourceCursor)
      ) return []
      const base = {
        operationId,
        expectedHostId,
        projectId,
        workspaceId,
        threadId,
        executionGenerationId,
        createdAt,
        updatedAt,
        state,
        ...(parsedStatus?.success ? { lastStatus: parsedStatus.data } : {}),
      }
      return kind === 'end'
        ? [{ ...base, kind, sourceCursor: sourceCursor! }]
        : [{
            ...base,
            kind,
            projectDisplayName: projectDisplayName!,
            threadTitle: threadTitle!,
            ...(sessionName ? { sessionName } : {}),
            ...(provisionMode === 'local_path' || provisionMode === 'registered_workspace'
              ? { provisionMode }
              : {}),
            ...(provisionMode === 'registered_workspace'
              ? {
                  referenceThreadId: referenceThreadId!,
                  referenceExecutionGenerationId: referenceExecutionGenerationId!,
                }
              : {}),
          }]
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
}

function nativeSessionCursor(value: unknown): ResidentEndOperationSummary['sourceCursor'] | undefined {
  const cursor = asRecord(value)
  const threadId = asString(cursor?.threadId)
  const executionGenerationId = asString(cursor?.executionGenerationId)
  const generation = asString(cursor?.generation)
  const sequence = asNumber(cursor?.sequence)
  if (!threadId || !executionGenerationId || !generation || sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 0) {
    return undefined
  }
  return { threadId, executionGenerationId, generation, sequence }
}

function residentLifecycleMaterializationKey(value: unknown): string {
  const entry = asRecord(value)
  return JSON.stringify([
    asString(entry?.operationId) ?? '',
    asString(entry?.expectedHostId) ?? '',
    asString(entry?.projectId) ?? '',
    asString(entry?.workspaceId) ?? '',
    asString(entry?.threadId) ?? '',
    asString(entry?.executionGenerationId) ?? '',
  ])
}

function residentLifecycleNeedsProjectionMaterialization(
  status: ResidentLifecycleStatus | null | undefined,
): status is ResidentLifecycleStatus {
  return status?.kind === 'provision'
    ? status.phase === 'committed'
    : status?.kind === 'end' && status.phase === 'completed'
}

interface NativeProjectionCacheEntry {
  hostId: string
  catalog?: unknown
  lastSnapshot?: unknown
  retiredExecutionGenerations?: Record<string, string[]>
  updatedAt?: string
}

function catalogHostIds(value: unknown): string[] {
  const catalog = asRecord(value)
  const ids = records(catalog?.hosts)
    .map((host) => asString(host.hostId))
    .filter((hostId): hostId is string => Boolean(hostId))
  const singleHostId = asString(asRecord(catalog?.host)?.hostId)
  if (singleHostId) ids.unshift(singleHostId)
  return [...new Set(ids)]
}

function snapshotHostId(value: unknown): string | undefined {
  return asString(asRecord(asRecord(asRecord(value)?.thread)?.currentLocation)?.hostId)
}

function snapshotThreadId(value: unknown): string | undefined {
  return asString(asRecord(asRecord(value)?.thread)?.threadId)
}

function snapshotExecutionGenerationId(value: unknown): string | undefined {
  const snapshot = asRecord(value)
  const locationGenerationId = asString(
    asRecord(asRecord(snapshot?.thread)?.currentLocation)?.executionGenerationId,
  )
  const cursorGenerationId = asString(asRecord(snapshot?.latestCursor)?.executionGenerationId)
  return locationGenerationId && locationGenerationId === cursorGenerationId
    ? locationGenerationId
    : undefined
}

function snapshotCursorGeneration(value: unknown): string | undefined {
  return asString(asRecord(asRecord(value)?.latestCursor)?.generation)
}

function protocolThreadId(thread: ThreadSummary): string {
  return thread.remoteId ?? thread.id
}

function residentThreadBindingKey(
  hostId: string,
  threadId: string,
  executionGenerationId: string,
): string {
  return JSON.stringify([hostId, threadId, executionGenerationId])
}

function catalogGenerationLineages(
  value: unknown,
  hostId: string,
): Map<string, { generationId: string | undefined; updatedAt: number }> {
  const catalog = asRecord(value)
  return new Map(
    records(catalog?.threads)
      .map((thread) => {
        const location = asRecord(thread.currentLocation)
        if (asString(location?.hostId) !== hostId) return undefined
        const threadId = asString(thread.threadId)
        if (!threadId) return undefined
        return [threadId, {
          generationId: asString(location?.executionGenerationId),
          updatedAt: Date.parse(asString(thread.updatedAt) ?? ''),
        }] as const
      })
      .filter((entry): entry is readonly [string, { generationId: string | undefined; updatedAt: number }] => Boolean(entry)),
  )
}

function catalogRegressesForHost(previous: unknown, incoming: unknown, hostId: string): boolean {
  const previousCatalog = asRecord(previous)
  const incomingCatalog = asRecord(incoming)
  const previousGeneratedAt = Date.parse(asString(previousCatalog?.generatedAt) ?? '')
  const incomingGeneratedAt = Date.parse(asString(incomingCatalog?.generatedAt) ?? '')
  if (
    Number.isFinite(previousGeneratedAt) &&
    Number.isFinite(incomingGeneratedAt) &&
    incomingGeneratedAt < previousGeneratedAt
  ) return true

  const previousLineages = catalogGenerationLineages(previousCatalog, hostId)
  const incomingLineages = catalogGenerationLineages(incomingCatalog, hostId)
  for (const [threadId, previousLineage] of previousLineages) {
    const incomingLineage = incomingLineages.get(threadId)
    if (!incomingLineage) continue
    if (
      Number.isFinite(previousLineage.updatedAt) &&
      Number.isFinite(incomingLineage.updatedAt) &&
      incomingLineage.updatedAt < previousLineage.updatedAt
    ) return true
    if (
      incomingLineage.updatedAt === previousLineage.updatedAt &&
      previousLineage.generationId &&
      incomingLineage.generationId !== previousLineage.generationId
    ) return true
  }
  return false
}

function snapshotRegresses(previous: unknown, incoming: unknown): boolean {
  if (
    snapshotThreadId(previous) !== snapshotThreadId(incoming) ||
    snapshotHostId(previous) !== snapshotHostId(incoming) ||
    snapshotExecutionGenerationId(previous) !== snapshotExecutionGenerationId(incoming)
  ) return false
  if (snapshotCursorGeneration(previous) !== snapshotCursorGeneration(incoming)) return false
  const previousSequence = asNumber(asRecord(asRecord(previous)?.latestCursor)?.sequence)
  const incomingSequence = asNumber(asRecord(asRecord(incoming)?.latestCursor)?.sequence)
  return previousSequence !== undefined && incomingSequence !== undefined && incomingSequence < previousSequence
}

function projectionEntriesFromCache(cache: unknown): Record<string, NativeProjectionCacheEntry> {
  const raw = asRecord(cache) ?? {}
  const entries: Record<string, NativeProjectionCacheEntry> = {}
  const rawEntries = asRecord(raw.entries)
  if (raw.version === 3 && rawEntries) {
    for (const hostId of Object.keys(rawEntries).sort().slice(0, 128)) {
      const candidate = asRecord(rawEntries[hostId])
      if (!candidate || asString(candidate.hostId) !== hostId) continue
      const catalog = candidate.catalog
      const snapshot = candidate.lastSnapshot
      const catalogMatches = catalogHostIds(catalog).includes(hostId)
      const snapshotMatches = snapshotHostId(snapshot) === hostId
      if (!catalogMatches && !snapshotMatches) continue
      entries[hostId] = {
        hostId,
        ...(catalogMatches ? { catalog } : {}),
        ...(snapshotMatches ? { lastSnapshot: snapshot } : {}),
        ...(asRecord(candidate.retiredExecutionGenerations)
          ? { retiredExecutionGenerations: normalizedRetiredGenerations(candidate.retiredExecutionGenerations) }
          : {}),
        ...(asString(candidate.updatedAt) ? { updatedAt: asString(candidate.updatedAt) } : {}),
      }
    }
  }

  const legacyCatalog = raw.catalog
  const legacySnapshot = raw.lastSnapshot
  const legacyHostId =
    asString(raw.projectionHostId) ??
    catalogHostIds(legacyCatalog)[0] ??
    snapshotHostId(legacySnapshot)
  if (legacyHostId && !entries[legacyHostId]) {
    const catalogMatches = catalogHostIds(legacyCatalog).includes(legacyHostId)
    const snapshotMatches = snapshotHostId(legacySnapshot) === legacyHostId
    if (catalogMatches || snapshotMatches) {
      entries[legacyHostId] = {
        hostId: legacyHostId,
        ...(catalogMatches ? { catalog: legacyCatalog } : {}),
        ...(snapshotMatches ? { lastSnapshot: legacySnapshot } : {}),
        ...(asString(raw.updatedAt) ? { updatedAt: asString(raw.updatedAt) } : {}),
      }
    }
  }
  return entries
}

function normalizedRetiredGenerations(value: unknown): Record<string, string[]> {
  const raw = asRecord(value)
  if (!raw) return {}
  const normalized: Record<string, string[]> = {}
  for (const [threadId, generations] of Object.entries(raw).slice(0, 10_000)) {
    if (!threadId || threadId.length > 128 || !Array.isArray(generations)) continue
    const bounded = [...new Set(generations.filter(
      (generation): generation is string =>
        typeof generation === 'string' && generation.length > 0 && generation.length <= 128,
    ))].slice(-64)
    if (bounded.length > 0) normalized[threadId] = bounded
  }
  return normalized
}

function aggregateProjectionCatalog(
  entries: Record<string, NativeProjectionCacheEntry>,
  activeHostId?: string,
): unknown {
  const orderedEntries = Object.values(entries).sort((left, right) => {
    if (left.hostId === activeHostId) return 1
    if (right.hostId === activeHostId) return -1
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0
    return (leftTime - rightTime) || left.hostId.localeCompare(right.hostId)
  })
  const hosts = new Map<string, UnknownRecord>()
  const projects = new Map<string, UnknownRecord>()
  const threads = new Map<string, UnknownRecord>()
  let generatedAt: string | undefined
  for (const entry of orderedEntries) {
    const catalog = asRecord(entry.catalog)
    if (!catalog) continue
    generatedAt = asString(catalog.generatedAt) ?? generatedAt
    const rawHosts = records(catalog.hosts)
    const singleHost = asRecord(catalog.host)
    if (singleHost) rawHosts.unshift(singleHost)
    for (const host of rawHosts) {
      const hostId = asString(host.hostId)
      if (hostId === entry.hostId) {
        hosts.set(hostId, { ...host, ...(entry.updatedAt ? { cacheUpdatedAt: entry.updatedAt } : {}) })
      }
    }
    for (const project of records(catalog.projects)) {
      const projectId = asString(project.projectId)
      const hostId = asString(project.hostId)
      if (projectId && hostId === entry.hostId) projects.set(`${hostId}\u0000${projectId}`, project)
    }
    for (const thread of records(catalog.threads)) {
      const threadId = asString(thread.threadId)
      const hostId = asString(asRecord(thread.currentLocation)?.hostId)
      if (threadId && hostId === entry.hostId) threads.set(`${hostId}\u0000${threadId}`, thread)
    }
  }
  const orderedHosts = [...hosts.values()].sort((left, right) => {
    const leftId = asString(left.hostId) ?? ''
    const rightId = asString(right.hostId) ?? ''
    if (leftId === activeHostId) return -1
    if (rightId === activeHostId) return 1
    return leftId.localeCompare(rightId)
  })
  return {
    ...(generatedAt ? { generatedAt } : {}),
    hosts: orderedHosts,
    projects: [...projects.values()],
    threads: [...threads.values()],
  }
}

function nativeProjection(input: NativeProjectionInput): WorkbenchSnapshot {
  const catalog = asRecord(input.catalog)
  const threadSnapshot = asRecord(input.threadSnapshot)
  const rawConnection = asRecord(input.connection)
  const activePhase = asString(rawConnection?.phase)
  const activeHostId = asString(rawConnection?.hostId)
  const activeTarget = asRecord(rawConnection?.target)
  const rawRuntimeReadiness = asRecord(rawConnection?.runtimeReadiness)
  const exactActiveRuntimeReadiness = activeHostId && asString(rawRuntimeReadiness?.hostId) === activeHostId
    ? runtimeReadinessFromNative(rawRuntimeReadiness, activePhase)
    : undefined
  const exactActiveRuntimeCode = exactActiveRuntimeReadiness
    ? localSetupDiagnosticCode(asRecord(rawRuntimeReadiness?.snapshot)?.code)
    : undefined
  const advertisedCapabilities = Array.isArray(rawConnection?.capabilities)
    ? rawConnection.capabilities.filter((capability): capability is string => typeof capability === 'string')
    : []
  const updatedAt = asString(input.updatedAt)
  const snapshotThread = asRecord(threadSnapshot?.thread)
  const snapshotLocation = asRecord(snapshotThread?.currentLocation)
  const snapshotLocationGenerationId = asString(snapshotLocation?.executionGenerationId)
  const snapshotCursorGenerationId = asString(asRecord(threadSnapshot?.latestCursor)?.executionGenerationId)
  const snapshotExecutionGenerationId =
    snapshotLocationGenerationId && snapshotLocationGenerationId === snapshotCursorGenerationId
      ? snapshotLocationGenerationId
      : undefined
  const snapshotCursor = outcomeCursorFromNative(threadSnapshot?.latestCursor)
  const snapshotGeneratedAt = asString(threadSnapshot?.generatedAt)
  const exactMaterialization = input.authoritativeMaterialization
  const snapshotIsLive = Boolean(
    exactMaterialization &&
    input.connectionGeneration === exactMaterialization.connectionGeneration &&
    activePhase === 'online' &&
    activeHostId === exactMaterialization.hostId &&
    asString(snapshotLocation?.hostId) === exactMaterialization.hostId &&
    asString(snapshotThread?.threadId) === exactMaterialization.threadId &&
    snapshotExecutionGenerationId === exactMaterialization.executionGenerationId
  )
  const snapshotAuthority = snapshotCursor && snapshotGeneratedAt && Number.isFinite(Date.parse(snapshotGeneratedAt))
    ? {
        source: snapshotIsLive ? 'live' as const : 'cached' as const,
        generatedAt: snapshotGeneratedAt,
        cursor: snapshotCursor,
      }
    : undefined
  const latestTurnOutcome = snapshotCursor
    && snapshotGeneratedAt
    && Number.isFinite(Date.parse(snapshotGeneratedAt))
    ? latestTurnOutcomeFromNative(
        threadSnapshot?.latestTurnOutcome,
        snapshotCursor,
        snapshotGeneratedAt,
        threadSnapshot?.materializedRecentBlocks,
      )
    : undefined
  const gitSummary = gitAggregateFromNative(threadSnapshot?.git)

  const rawHosts = records(catalog?.hosts)
  const singleHost = asRecord(catalog?.host)
  if (singleHost) rawHosts.unshift(singleHost)
  if (rawHosts.length === 0 && snapshotLocation) {
    const hostId = asString(snapshotLocation.hostId)
    if (hostId) {
      rawHosts.push({
        hostId,
        displayName:
          asString(activeTarget?.alias) ?? (asString(activeTarget?.kind) === 'local' ? 'This computer' : `Host ${hostId}`),
        kind: asString(activeTarget?.kind) === 'local' ? 'local' : 'ssh',
        reachability: activePhase ?? 'offline',
        compatibility: 'compatible',
        connectionPaths: [],
      })
    }
  }

  const hosts: HostSummary[] = rawHosts.map((host, index) => {
    const firstPath = records(host.connectionPaths)[0]
    const pathKind = asString(firstPath?.kind) ?? asString(rawConnection?.path)
    const hostId = asString(host.hostId) ?? `native-host-${index}`
    const hostName = asString(host.displayName) ?? `Host ${hostId}`
    const isActive = Boolean(activeHostId && activeHostId === hostId)
    // A cached host's last reported reachability is historical projection
    // data. Only the currently verified connection may render as online.
    const state = connectionFromNative(isActive && activePhase ? activePhase : 'offline')
    const rawKind = asString(host.kind)
    const projectedKind = rawKind === 'local' || rawKind === 'paired' ? rawKind : 'ssh'
    const synchronizedAt = asString(host.cacheUpdatedAt) ?? asString(host.lastSeenAt) ?? (isActive ? updatedAt : undefined)
    const runtimeReadiness = isActive ? exactActiveRuntimeReadiness : undefined
    return {
      id: hostId,
      name: hostName,
      kind: projectedKind,
      connection: state,
      connectionPath: pathKind === 'local_socket' ? 'Local socket' : pathKind === 'relay' ? 'Relay' : 'SSH',
      lastSynchronized: state === 'online' ? undefined : displayTime(synchronizedAt) || 'not yet',
      latencyMs: asNumber(firstPath?.latencyMs),
      compatibility:
        host.compatibility === 'update_available' || host.compatibility === 'upgrade_required'
          ? host.compatibility
          : 'compatible',
      ...(runtimeReadiness ? { runtimeReadiness } : {}),
      ...(projectedKind === 'ssh' && isActive && state === 'online' && input.activationRequiredHostId === hostId
        ? { activationRequired: true }
        : {}),
    }
  })

  const rawProjects = records(catalog?.projects)
  if (rawProjects.length === 0 && snapshotLocation) {
    const projectId = asString(snapshotLocation.projectId)
    const hostId = asString(snapshotLocation.hostId)
    if (projectId && hostId) {
      rawProjects.push({ projectId, hostId, displayName: `Project ${projectId}` })
    }
  }

  const git = asRecord(threadSnapshot?.git)
  const snapshotThreadId = asString(snapshotThread?.threadId)
  const snapshotProjectId = asString(snapshotLocation?.projectId)
  const dirtyFiles =
    (asNumber(git?.stagedFiles) ?? 0) + (asNumber(git?.unstagedFiles) ?? 0) + (asNumber(git?.untrackedFiles) ?? 0)

  const projects: ProjectSummary[] = rawProjects.map((project, index) => {
    const repositoryIdentity = asRecord(project.repositoryIdentity)
    const remotes = Array.isArray(repositoryIdentity?.canonicalRemotes)
      ? repositoryIdentity.canonicalRemotes.filter((remote): remote is string => typeof remote === 'string')
      : []
    const displayName = asString(project.displayName) ?? asString(project.projectId) ?? `Project ${index + 1}`
    const remote = remotes[0]
    const repository = remote ? remote.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).at(-1) ?? displayName : displayName
    const projectId = asString(project.projectId) ?? `native-project-${index}`
    return {
      id: projectId,
      name: displayName,
      repository,
      hostIds: [asString(project.hostId)].filter((id): id is string => Boolean(id)),
      branch: projectId === snapshotProjectId ? asString(git?.branch) ?? 'Branch unavailable' : 'Branch unavailable',
      dirtyFiles: projectId === snapshotProjectId ? dirtyFiles : 0,
    }
  })

  const recentBlocks = records(threadSnapshot?.materializedRecentBlocks)
    .map(nativeTranscriptBlock)
    .filter((block): block is TranscriptBlock => Boolean(block))
  const inProgressBlock = nativeInProgressTranscriptBlock(
    threadSnapshot?.inProgressStream,
    new Set(recentBlocks.map((block) => block.id)),
  )
  const parsedResidentLifecycle = parseResidentLifecycleDisposition(threadSnapshot?.residentLifecycle)
  const rawThreads = records(catalog?.threads)
  if (rawThreads.length === 0 && snapshotThread) rawThreads.push(snapshotThread)
  const threadIdCounts = new Map<string, number>()
  for (const thread of rawThreads) {
    const threadId = asString(thread.threadId)
    if (threadId) threadIdCounts.set(threadId, (threadIdCounts.get(threadId) ?? 0) + 1)
  }
  const materializedHostId = asString(snapshotLocation?.hostId)
  const threads: ThreadSummary[] = rawThreads.map((thread, index) => {
    const location = asRecord(thread.currentLocation)
    const threadId = asString(thread.threadId) ?? `native-thread-${index}`
    const threadHostId = asString(location?.hostId) ?? hosts[0]?.id ?? ''
    const duplicateId = (threadIdCounts.get(threadId) ?? 0) > 1
    const rendererId = duplicateId ? `host:${threadHostId.length}:${threadHostId}:${threadId}` : threadId
    const threadExecutionGenerationId = asString(location?.executionGenerationId)
    const isMaterialized =
      threadId === snapshotThreadId &&
      threadHostId === materializedHostId &&
      Boolean(
        threadExecutionGenerationId &&
        snapshotExecutionGenerationId &&
        threadExecutionGenerationId === snapshotExecutionGenerationId
      )
    return {
      id: rendererId,
      ...(duplicateId ? { remoteId: threadId } : {}),
      projectId: asString(location?.projectId) ?? asString(thread.projectIdentity) ?? projects[0]?.id ?? '',
      title: asString(thread.title) ?? `Thread ${threadId}`,
      recap: asString(thread.recap) ?? (isMaterialized ? 'Loaded from the host snapshot.' : 'Open this thread to load its transcript.'),
      hostId: threadHostId,
      status: taskFromNative(thread.status),
      updatedAt: displayTime(thread.updatedAt) || 'Updated',
      unread: asBoolean(thread.unread) ?? false,
      executionGenerationId: threadExecutionGenerationId,
      workspaceId: asString(location?.workspaceId),
      ...(isMaterialized && parsedResidentLifecycle.success
        ? {
            residentLifecycle: {
              state: parsedResidentLifecycle.data.state,
              operationId: parsedResidentLifecycle.data.operationId,
              endedAt: parsedResidentLifecycle.data.endedAt,
              reason: parsedResidentLifecycle.data.reason,
            },
          }
        : {}),
      transcript: isMaterialized
        ? inProgressBlock
          ? [...recentBlocks, inProgressBlock]
          : recentBlocks
        : [],
    }
  })

  const threadByResidentBinding = new Map<string, ThreadSummary>()
  for (const thread of threads) {
    if (!thread.executionGenerationId) continue
    const key = residentThreadBindingKey(
      thread.hostId,
      protocolThreadId(thread),
      thread.executionGenerationId,
    )
    // Preserve Array.find's first-match behavior if malformed catalog bytes
    // repeat one exact binding. Validation remains fail-closed downstream.
    if (!threadByResidentBinding.has(key)) threadByResidentBinding.set(key, thread)
  }
  const hostNameById = new Map<string, string>()
  for (const host of hosts) {
    if (!hostNameById.has(host.id)) hostNameById.set(host.id, host.name)
  }

  const snapshotRendererThreadId = threads.find(
    (thread) => protocolThreadId(thread) === snapshotThreadId && thread.hostId === materializedHostId,
  )?.id
  const selectedThreadId =
    (input.selectedThreadId && threads.some((thread) => thread.id === input.selectedThreadId)
      ? input.selectedThreadId
      : undefined) ??
    snapshotRendererThreadId ??
    threads[0]?.id ??
    ''
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId)
  const selectedProjectId = selectedThread?.projectId ?? projects[0]?.id ?? ''
  const selectedProject = projects.find((project) => project.id === selectedProjectId)
  const selectedHostHasAuthority = Boolean(activeHostId && selectedThread?.hostId === activeHostId)
  const activeHostHasAuthority = Boolean(
    activeHostId && hosts.some((host) => host.id === activeHostId && host.connection === 'online'),
  )
  const hostName = selectedThread
    ? hostNameById.get(selectedThread.hostId) ?? 'Execution host'
    : 'Execution host'
  const selectedSnapshotIsMaterialized = Boolean(
    snapshotThreadId &&
    selectedThread &&
    protocolThreadId(selectedThread) === snapshotThreadId &&
    selectedThread.hostId === materializedHostId &&
    Boolean(
      selectedThread.executionGenerationId &&
      snapshotExecutionGenerationId &&
      selectedThread.executionGenerationId === snapshotExecutionGenerationId
    ),
  )

  const childAgents = selectedSnapshotIsMaterialized ? records(threadSnapshot?.childAgents) : []
  const reportedChildAgents: AgentSummary[] = childAgents.map((agent, index) => {
    const state = asString(agent.state)
    const status: AgentSummary['status'] =
      state === 'pending' ||
      state === 'queued' ||
      state === 'running' ||
      state === 'waiting' ||
      state === 'complete' ||
      state === 'failed' ||
      state === 'cancelled'
        ? state
        : 'running'
    const rawActivity = asRecord(agent.activity)
    const activityKind = asString(rawActivity?.kind)
    const toolName = asString(rawActivity?.toolName)
    const activity = activityKind === 'executing' && toolName
      ? `Executing ${toolName}`
      : activityKind === 'executing'
        ? 'Executing a tool'
        : activityKind === 'writing'
          ? 'Writing'
          : activityKind === 'waiting'
            ? 'Waiting'
            : undefined
    return {
      id: asString(agent.agentId) ?? `native-agent-${index}`,
      name: asString(agent.title) ?? `Agent ${index + 1}`,
      role: 'Retained subagent',
      status,
      hostName,
      ...(asString(agent.parentAgentId) ? { parentId: asString(agent.parentAgentId) } : {}),
      ...(asString(agent.activeSessionId) ? { activeSessionId: asString(agent.activeSessionId) } : {}),
      ...(asString(agent.sessionName) ? { sessionName: asString(agent.sessionName) } : {}),
      ...(asString(agent.model) ? { model: asString(agent.model) } : {}),
      ...(activity ? { activity } : {}),
      ...(asNumber(agent.durationMs) !== undefined ? { durationMs: asNumber(agent.durationMs) } : {}),
      ...(asString(agent.answerPreview) ? { answerPreview: asString(agent.answerPreview) } : {}),
      ...(typeof agent.repliedSinceTask === 'boolean' ? { repliedSinceTask: agent.repliedSinceTask } : {}),
      ...(asNumber(agent.toolUseCount) !== undefined ? { toolUseCount: asNumber(agent.toolUseCount) } : {}),
      ...(asNumber(agent.tokenCount) !== undefined ? { tokenCount: asNumber(agent.tokenCount) } : {}),
      ...(asString(agent.recap) ? { recap: asString(agent.recap) } : {}),
      ...(asString(agent.error) ? { error: asString(agent.error) } : {}),
    }
  })
  const transcriptAgents = retainedTranscriptAgents(recentBlocks, reportedChildAgents, hostName)
  const agents = [...reportedChildAgents, ...transcriptAgents]

  const runtime: RuntimeSummary = {}
  if (selectedSnapshotIsMaterialized) {
    const rawSession = asRecord(threadSnapshot?.runtime)
    if (rawSession && asString(rawSession.runtime) === 'prime_agent') {
      const residency = asString(rawSession.residency)
      const rawContext = asRecord(rawSession.context)
      const usedTokens = asNumber(rawContext?.usedTokens)
      const resourceInventory = parseRuntimeResourceInventory(rawSession.resourceInventory)
      const rawAvailableThinkingLevels = rawSession.availableThinkingLevels
      const availableThinkingLevels = Array.isArray(rawAvailableThinkingLevels) &&
        rawAvailableThinkingLevels.length <= 128 &&
        rawAvailableThinkingLevels.every((level): level is string =>
          typeof level === 'string' &&
          level.length >= 1 &&
          level.length <= 64 &&
          !/[\0\r\n]/.test(level),
        ) &&
        new Set(rawAvailableThinkingLevels).size === rawAvailableThinkingLevels.length
          ? [...rawAvailableThinkingLevels]
          : undefined
      runtime.session = {
        residency: residency === 'resident' || residency === 'client_owned' ? residency : 'unknown',
        ...(asString(rawSession.appVersion) ? { appVersion: asString(rawSession.appVersion) } : {}),
        ...(asString(rawSession.activeSessionId) ? { activeSessionId: asString(rawSession.activeSessionId) } : {}),
        ...(asString(rawSession.sessionId) ? { sessionId: asString(rawSession.sessionId) } : {}),
        ...(asString(rawSession.sessionName) ? { sessionName: asString(rawSession.sessionName) } : {}),
        ...(asString(rawSession.model) ? { model: asString(rawSession.model) } : {}),
        ...(asString(rawSession.thinkingLevel) ? { thinkingLevel: asString(rawSession.thinkingLevel) } : {}),
        ...(availableThinkingLevels ? { availableThinkingLevels } : {}),
        ...(asString(rawSession.serviceTier) ? { serviceTier: asString(rawSession.serviceTier) } : {}),
        isStreaming: asBoolean(rawSession.isStreaming) ?? false,
        isCompacting: asBoolean(rawSession.isCompacting) ?? false,
        isBashRunning: asBoolean(rawSession.isBashRunning) ?? false,
        retryAttempt: asNumber(rawSession.retryAttempt) ?? 0,
        queuedActionCount: asNumber(rawSession.queuedActionCount) ?? 0,
        messageCount: asNumber(rawSession.messageCount) ?? 0,
        compactionCount: asNumber(rawSession.compactionCount) ?? 0,
        activeToolNames: Array.isArray(rawSession.activeToolNames)
          ? rawSession.activeToolNames.filter((tool): tool is string => typeof tool === 'string')
          : [],
        ...(resourceInventory.success ? { resourceInventory: resourceInventory.data } : {}),
        ...(usedTokens !== undefined
          ? { context: {
              usedTokens,
              ...(asNumber(rawContext?.maxTokens) !== undefined ? { maxTokens: asNumber(rawContext?.maxTokens) } : {}),
            } }
          : {}),
      }
    }

    if (runtime.session || agents.length > 0) runtime.agentsReported = true

    const rawQueue = asRecord(threadSnapshot?.queueState)
    if (rawQueue && Array.isArray(rawQueue.pendingCommandIds)) {
      runtime.queue = {
        pendingCount: rawQueue.pendingCommandIds.filter((commandId) => typeof commandId === 'string').length,
        paused: asBoolean(rawQueue.paused) ?? false,
      }
    }

    if (Array.isArray(threadSnapshot?.goals) && (runtime.session || threadSnapshot.goals.length > 0)) {
      runtime.goals = records(threadSnapshot.goals).flatMap((goal, index) => {
        const state = asString(goal.state)
        const objective = asString(goal.objective)
        if (
          !objective ||
          (state !== 'active' && state !== 'paused' && state !== 'budget_limited' && state !== 'complete' && state !== 'error')
        ) return []
        return [{
          id: asString(goal.goalId) ?? `native-goal-${index}`,
          objective,
          state,
          ...(asNumber(goal.tokenBudget) !== undefined ? { tokenBudget: asNumber(goal.tokenBudget) } : {}),
          ...(asNumber(goal.tokensUsed) !== undefined ? { tokensUsed: asNumber(goal.tokensUsed) } : {}),
          ...(asNumber(goal.timeUsedSeconds) !== undefined ? { timeUsedSeconds: asNumber(goal.timeUsedSeconds) } : {}),
          ...(asNumber(goal.continuationsUsed) !== undefined ? { continuationsUsed: asNumber(goal.continuationsUsed) } : {}),
          ...(asString(goal.lastError) || asString(goal.lastReason)
            ? { detail: asString(goal.lastError) ?? asString(goal.lastReason) }
            : {}),
        }]
      })
    }

    if (Array.isArray(threadSnapshot?.schedules) && (runtime.session || threadSnapshot.schedules.length > 0)) {
      runtime.schedules = records(threadSnapshot.schedules).flatMap((schedule, index) => {
        const state = asString(schedule.state)
        const label = asString(schedule.label)
        if (!label || (state !== 'active' && state !== 'paused' && state !== 'completed' && state !== 'cancelled')) return []
        const nextRunAt = asString(schedule.nextRunAt)
        const kind = asString(schedule.kind)
        const source = asString(schedule.source)
        return [{
          id: asString(schedule.scheduleId) ?? `native-schedule-${index}`,
          label,
          state,
          ...(kind === 'once' || kind === 'cron' || kind === 'interval' ? { kind } : {}),
          ...(source === 'cron' || source === 'heartbeat' || source === 'rlm_heartbeat' ? { source } : {}),
          ...(nextRunAt ? { nextRunAt } : {}),
          ...(asNumber(schedule.runCount) !== undefined ? { runCount: asNumber(schedule.runCount) } : {}),
          ...(asString(schedule.lastError) ? { detail: asString(schedule.lastError) } : {}),
        }]
      })
    }
  }

  const rawEvidence = selectedSnapshotIsMaterialized ? asRecord(threadSnapshot?.evidence) : undefined
  const testsPassed = asNumber(rawEvidence?.testsPassed) ?? 0
  const testsFailed = asNumber(rawEvidence?.testsFailed) ?? 0
  const artifactCount = asNumber(rawEvidence?.artifactCount) ?? 0
  const evidence: EvidenceSummary[] = []
  if (testsPassed > 0 || testsFailed > 0) {
    evidence.push({
      id: 'native-tests',
      label: 'Host test receipt',
      detail: `${testsPassed} passed · ${testsFailed} failed`,
      status: testsFailed > 0 ? 'warning' : 'passed',
    })
  }
  if (artifactCount > 0) {
    evidence.push({
      id: 'native-artifacts',
      label: 'Artifacts',
      detail: `${artifactCount} durable ${artifactCount === 1 ? 'artifact' : 'artifacts'}`,
      status: 'passed',
    })
  }

  const attention: AttentionItem[] = (selectedSnapshotIsMaterialized ? records(threadSnapshot?.pendingAttention) : [])
    .flatMap((item, index) => {
      if (asBoolean(item.read) === true) return []
      const kind = asString(item.kind)
      const actionableKind: AttentionItem['kind'] | undefined =
        kind === 'approval'
          ? 'approval'
          : kind === 'question'
            ? 'question'
            : kind === 'failed' || kind === 'host_offline'
              ? 'failed'
              : undefined
      if (!actionableKind) return []
      return [{
        id: asString(item.attentionId) ?? `native-attention-${index}`,
        threadId: selectedThreadId,
        kind: actionableKind,
        title: asString(item.title) ?? 'Thread needs attention',
        hostName,
      }]
    })
  const quarantinedOutboxCount = asNumber(input.quarantinedOutboxCount) ?? 0
  if (quarantinedOutboxCount > 0 && selectedThreadId) {
    attention.push({
      id: 'native-quarantined-outbox',
      threadId: selectedThreadId,
      kind: 'failed',
      title: `${quarantinedOutboxCount} older or invalid ${quarantinedOutboxCount === 1 ? 'command is' : 'commands are'} held locally and won’t be sent automatically`,
      hostName,
    })
  }
  const durableUncertainAttentionIdentities = new Set<string>()
  for (const [index, receipt] of records(input.durableUncertainReceipts).slice(-20).entries()) {
    if (asString(receipt.status) !== 'uncertain') continue
    const receiptHostId = asString(receipt.hostId)
    const receiptThreadId = asString(receipt.threadId)
    const receiptExecutionGenerationId = asString(receipt.executionGenerationId)
    const matchingThread = receiptHostId && receiptThreadId && receiptExecutionGenerationId
      ? threadByResidentBinding.get(residentThreadBindingKey(
          receiptHostId,
          receiptThreadId,
          receiptExecutionGenerationId,
        ))
      : undefined
    if (!matchingThread) continue
    const error = asRecord(receipt.error)
    const errorCode = asString(error?.code)?.slice(0, 64)
    const errorMessage = asString(error?.message)?.slice(0, 2_048)
    const errorRetryable = asBoolean(error?.retryable)
    const diagnosticId = asString(error?.diagnosticId)?.slice(0, 128)
    const receiptDeviceId = asString(receipt.deviceId)
    const receiptCommandId = asString(receipt.commandId)
    if (receiptHostId && receiptDeviceId && receiptCommandId && receiptThreadId && receiptExecutionGenerationId) {
      durableUncertainAttentionIdentities.add(JSON.stringify([
        receiptHostId,
        receiptDeviceId,
        receiptCommandId,
        receiptThreadId,
        receiptExecutionGenerationId,
      ]))
    }
    attention.push({
      id: `durable-uncertain-${receiptCommandId ?? index}`,
      threadId: matchingThread.id,
      kind: 'failed',
      title: 'Outcome unknown · Prime Agent did not replay this command',
      hostName: hostNameById.get(matchingThread.hostId) ?? 'Execution host',
      ...(errorCode && errorMessage && errorRetryable !== undefined
        ? {
            diagnostic: {
              code: errorCode,
              message: errorMessage,
              retryable: errorRetryable,
              ...(diagnosticId ? { diagnosticId } : {}),
            },
          }
        : {}),
    })
  }

  const outbox = records(input.outbox)
  for (const [index, entry] of outbox.entries()) {
    if (asString(entry.state) !== 'uncertain') continue
    const command = asRecord(entry.command)
    const entryHostId = asString(entry.hostId)
    const commandHostId = asString(command?.expectedHostId)
    const commandThreadId = asString(command?.threadId)
    const commandGenerationId = asString(command?.expectedExecutionGenerationId)
    const commandDeviceId = asString(command?.deviceId)
    const commandId = asString(command?.commandId)
    const kind = asString(command?.kind)
    const operation = kind === 'thread.prompt' || kind === 'prompt'
      ? 'prompt'
      : kind === 'thread.cancel' || kind === 'thread.abort' || kind === 'abort'
        ? 'abort'
        : undefined
    if (!operation || !entryHostId || entryHostId !== commandHostId) continue
    const matchingThread = commandThreadId && commandGenerationId
      ? threadByResidentBinding.get(residentThreadBindingKey(
          entryHostId,
          commandThreadId,
          commandGenerationId,
        ))
      : undefined
    if (!matchingThread) continue
    if (
      commandDeviceId && commandId && commandThreadId && commandGenerationId &&
      durableUncertainAttentionIdentities.has(JSON.stringify([
        entryHostId,
        commandDeviceId,
        commandId,
        commandThreadId,
        commandGenerationId,
      ]))
    ) continue
    attention.push({
      id: `resident-uncertain-${commandId ?? index}`,
      threadId: matchingThread.id,
      kind: 'failed',
      title: operation === 'prompt'
        ? 'Prompt outcome unknown · reconnect to reconcile this exact command'
        : 'Outcome unknown · recovery required; this Stop will not be replayed',
      hostName: hostNameById.get(entryHostId) ?? 'Execution host',
    })
  }
  const pendingEntries = selectedThread
    ? selectedThread.executionGenerationId
      ? outbox.flatMap((entry, index) => {
        const command = asRecord(entry.command)
        const issuedAt = asString(command?.issuedAt)
        const issuedAtEpoch = issuedAt ? Date.parse(issuedAt) : Number.NaN
        return (
          asString(entry.hostId) === selectedThread.hostId &&
          asString(command?.deviceId) === input.deviceId &&
          asString(command?.expectedHostId) === selectedThread.hostId &&
          asString(command?.threadId) === protocolThreadId(selectedThread) &&
          asString(command?.expectedExecutionGenerationId) === selectedThread.executionGenerationId &&
          Number.isFinite(issuedAtEpoch)
        )
          ? [{ entry, index, issuedAtEpoch }]
          : []
      }).sort((left, right) =>
        right.issuedAtEpoch - left.issuedAtEpoch || right.index - left.index
      )
      : []
    : []
  const pending = pendingEntries[0]?.entry
  const pendingState = asString(pending?.state)
  const pendingCommandKind = asString(asRecord(pending?.command)?.kind)
  const pendingIsPrompt = pendingCommandKind === 'thread.prompt' || pendingCommandKind === 'prompt'
  const retainedPromptOwned = pendingEntries.some(({ entry }) => {
    const state = asString(entry.state)
    const kind = asString(asRecord(entry.command)?.kind)
    return (kind === 'thread.prompt' || kind === 'prompt') &&
      (state === 'awaiting_idle_proof' || state === 'uncertain')
  })
  const promptDispatchPending = pendingEntries.some(({ entry }) => {
    const kind = asString(asRecord(entry.command)?.kind)
    return (kind === 'thread.prompt' || kind === 'prompt') && asString(entry.state) === 'awaiting_reconciliation'
  })
  const abortCommandPending = pendingEntries.some(({ entry }) => {
    const kind = asString(asRecord(entry.command)?.kind)
    return kind === 'thread.cancel' || kind === 'thread.abort' || kind === 'abort'
  })
  const composerReceipt: WorkbenchSnapshot['composerReceipt'] = pending
    ? {
        state: pendingState === 'uncertain'
          ? 'uncertain'
          : pendingState === 'awaiting_idle_proof' || pendingState === 'awaiting_reconciliation'
            ? 'sent'
            : pendingState === 'awaiting_abort_idle_proof'
              ? 'sent'
            : 'waiting_for_connection',
        message: pendingState === 'uncertain'
          ? pendingIsPrompt
            ? 'Prompt outcome unknown · Prime Agent will not replay it without proof'
            : 'Outcome unknown · recovery required; this Stop will not be replayed'
          : pendingState === 'awaiting_idle_proof'
            ? 'Prime Agent owns this prompt · waiting for authoritative idle proof'
            : pendingState === 'awaiting_abort_idle_proof'
              ? 'Stop accepted · waiting for authoritative idle proof'
            : pendingState === 'awaiting_reconciliation'
              ? 'Delivery crossed a non-replayable boundary · reconciling the final acknowledgement'
            : 'Waiting for connection',
        ...(pendingIsPrompt
          ? { operation: 'prompt' as const }
          : asString(asRecord(pending.command)?.kind) === 'thread.cancel' ||
              asString(asRecord(pending.command)?.kind) === 'thread.abort' ||
              asString(asRecord(pending.command)?.kind) === 'abort'
            ? { operation: 'abort' as const }
            : {}),
      }
    : {
        state: 'idle',
        message: selectedThread && hosts.find((host) => host.id === selectedThread.hostId)?.connection === 'online'
          ? 'Ready to send'
          : 'Waiting for connection',
      }

  const residentLifecycleOperations = residentLifecycleOperationsFromNative(
    input.residentLifecycleOperations,
    activeHostId,
  )
  const selectedResidentEnd = selectedThread?.executionGenerationId
    ? residentLifecycleOperations.find((operation) =>
        operation.kind === 'end' &&
        operation.expectedHostId === selectedThread.hostId &&
        operation.threadId === protocolThreadId(selectedThread) &&
        operation.executionGenerationId === selectedThread.executionGenerationId,
      )
    : undefined
  const selectedResidentLineageIsExact = Boolean(
    selectedHostHasAuthority &&
    selectedSnapshotIsMaterialized &&
    selectedThread?.workspaceId &&
    selectedThread.executionGenerationId &&
    selectedProject?.hostIds.includes(selectedThread.hostId),
  )
  const rawResidentControl = asRecord(threadSnapshot?.residentControl)
  const residentControlIsExact = Boolean(
    selectedSnapshotIsMaterialized &&
    rawResidentControl &&
    asString(rawResidentControl.hostId) === selectedThread?.hostId &&
    asString(rawResidentControl.threadId) === (selectedThread ? protocolThreadId(selectedThread) : undefined) &&
    asString(rawResidentControl.executionGenerationId) === selectedThread?.executionGenerationId,
  )
  const browserExecution = parseResidentBrowserExecution(rawResidentControl?.browserExecution)
  if (residentControlIsExact && browserExecution.success) {
    runtime.browserExecution = browserExecution.data
  }
  const residentControlReady = Boolean(
    residentControlIsExact &&
    asString(rawResidentControl?.commandReadiness) === 'ready',
  )
  if (residentControlIsExact) {
    runtime.residentControlReadiness = residentControlReady ? 'ready' : 'unavailable'
  }
  const residentExtensionUiRequests: ResidentExtensionUiRequest[] = []
  const rawExtensionUiRequests = threadSnapshot?.residentExtensionUiRequests
  const residentBindingFingerprint = asString(rawResidentControl?.bindingFingerprint)
  if (
    snapshotIsLive &&
    advertisedCapabilities.includes(RESIDENT_EXTENSION_UI_CAPABILITY) &&
    residentControlIsExact &&
    residentBindingFingerprint &&
    Array.isArray(rawExtensionUiRequests) &&
    rawExtensionUiRequests.length <= 16
  ) {
    const seen = new Set<string>()
    for (const candidate of rawExtensionUiRequests) {
      const parsed = parseResidentExtensionUiRequest(candidate)
      if (!parsed.success) continue
      const request = parsed.data
      if (
        request.hostId !== selectedThread?.hostId ||
        request.threadId !== (selectedThread ? protocolThreadId(selectedThread) : undefined) ||
        request.executionGenerationId !== selectedThread?.executionGenerationId ||
        request.bindingFingerprint !== residentBindingFingerprint
      ) continue
      const identity = canonicalRendererJson([
        request.executionGenerationId,
        request.bindingFingerprint,
        request.requestId,
        request.requestDigest,
        request.method,
      ])
      if (seen.has(identity)) continue
      seen.add(identity)
      residentExtensionUiRequests.push(request)
    }
  }
  const residentSessionReady = Boolean(
    input.mutationAuthorityReady !== false &&
    selectedHostHasAuthority &&
    activePhase === 'online' &&
    selectedSnapshotIsMaterialized &&
    advertisedCapabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY) &&
    residentControlReady &&
    runtime.session?.residency === 'resident' &&
    runtime.session.activeSessionId &&
    runtime.session.sessionId &&
    !selectedResidentEnd &&
    selectedThread?.residentLifecycle?.state !== 'ended',
  )
  const localResidentLifecycleReady = Boolean(
    input.mutationAuthorityReady !== false &&
    activePhase === 'online' &&
    asString(activeTarget?.kind) === 'local' &&
    asString(rawConnection?.path) === 'local_socket' &&
    advertisedCapabilities.includes(RESIDENT_LIFECYCLE_CAPABILITY),
  )
  const localResidentProvisioningReady = Boolean(
    localResidentLifecycleReady &&
    exactActiveRuntimeReadiness?.kind === 'reported' &&
    exactActiveRuntimeReadiness.freshness === 'live' &&
    exactActiveRuntimeReadiness.status === 'ready',
  )
  const registeredWorkspaceLifecycleReady = Boolean(
    input.mutationAuthorityReady !== false &&
    selectedHostHasAuthority &&
    activePhase === 'online' &&
    asString(activeTarget?.kind) === 'ssh' &&
    asString(rawConnection?.path) === 'ssh' &&
    advertisedCapabilities.includes(RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY),
  )
  const registeredWorkspaceProvisioningReady = Boolean(
    registeredWorkspaceLifecycleReady &&
    selectedResidentLineageIsExact,
  )
  const residentProvisioningReady = Boolean(
    localResidentProvisioningReady || registeredWorkspaceProvisioningReady,
  )
  const residentEndReady = Boolean(
    (localResidentLifecycleReady || registeredWorkspaceLifecycleReady) &&
    selectedResidentLineageIsExact &&
    (
      (
        runtime.session?.residency === 'resident' &&
        runtime.session.activeSessionId &&
        runtime.session.sessionId
      ) ||
      (
        localResidentLifecycleReady &&
        selectedResidentEnd !== undefined &&
        selectedThread !== undefined &&
        selectedResidentEnd.projectId === selectedThread.projectId &&
        selectedResidentEnd.workspaceId === selectedThread.workspaceId &&
        (
          (
            selectedResidentEnd.lastStatus?.kind === 'end' &&
            selectedResidentEnd.lastStatus.phase === 'ending'
          ) ||
          (
            selectedResidentEnd.state === 'outcome_unknown' &&
            selectedResidentEnd.lastStatus === undefined
          )
        )
      )
    ) &&
    selectedThread?.residentLifecycle?.state !== 'ended',
  )
  const localSetup = localSetupFromNative({
    rawConnection,
    runtimeReadiness: exactActiveRuntimeReadiness,
    runtimeCode: exactActiveRuntimeCode,
    runtimeRetryAdvertised: Boolean(
      (activePhase === 'online' || activePhase === 'degraded') &&
      asString(activeTarget?.kind) === 'local' &&
      asString(rawConnection?.path) === 'local_socket' &&
      advertisedCapabilities.includes(RUNTIME_INTEGRITY_RETRY_CAPABILITY)
    ),
    runtimeRepairAdvertised: Boolean(
      (activePhase === 'online' || activePhase === 'degraded') &&
      asString(activeTarget?.kind) === 'local' &&
      asString(rawConnection?.path) === 'local_socket' &&
      advertisedCapabilities.includes(RUNTIME_INTEGRITY_REPAIR_CAPABILITY)
    ),
    residentProvisioningReady: localResidentProvisioningReady,
    residentLifecycleAdvertised: advertisedCapabilities.includes(RESIDENT_LIFECYCLE_CAPABILITY),
  })
  const residentTurnActive = Boolean(
    selectedThread?.status === 'running' ||
    runtime.session?.isStreaming ||
    runtime.session?.isCompacting ||
    runtime.session?.isBashRunning ||
    (runtime.session?.queuedActionCount ?? 0) > 0,
  )
  const residentTurnStartReady = Boolean(
    residentSessionReady &&
    !residentTurnActive &&
    !retainedPromptOwned &&
    !promptDispatchPending &&
    !abortCommandPending,
  )
  const activeAccountHostReady = Boolean(
    activeHostHasAuthority && (!selectedThread || selectedHostHasAuthority),
  )
  const modelCatalogReady = Boolean(
    activeAccountHostReady &&
    activePhase === 'online' &&
    advertisedCapabilities.includes(RUNTIME_MODEL_CATALOG_CAPABILITY),
  )
  const thinkingLevelSelectionReady = Boolean(
    residentTurnStartReady &&
    advertisedCapabilities.includes(PRIME_AGENT_THINKING_LEVELS_CAPABILITY) &&
    (runtime.session?.availableThinkingLevels?.length ?? 0) > 0,
  )
  const runtimeOAuthReady = Boolean(
    input.mutationAuthorityReady !== false &&
    activeAccountHostReady &&
    activePhase === 'online' &&
    asString(activeTarget?.kind) === 'local' &&
    asString(rawConnection?.path) === 'local_socket' &&
    advertisedCapabilities.includes(RUNTIME_OAUTH_ATTEMPT_CAPABILITY) &&
    advertisedCapabilities.includes(RUNTIME_OAUTH_CAPABILITY),
  )
  const runtimeProviderSetupReady = Boolean(
    input.mutationAuthorityReady !== false &&
    activeAccountHostReady &&
    activePhase === 'online' &&
    asString(activeTarget?.kind) === 'local' &&
    asString(rawConnection?.path) === 'local_socket' &&
    advertisedCapabilities.includes(RUNTIME_MODEL_CATALOG_CAPABILITY) &&
    advertisedCapabilities.includes(RUNTIME_PROVIDER_SETUP_HANDOFF_CAPABILITY),
  )
  return {
    selectedProjectId,
    selectedThreadId,
    projects,
    threads,
    hosts,
    attention,
    changes: [],
    agents,
    evidence,
    runtime,
    ...(latestTurnOutcome ? { latestTurnOutcome } : {}),
    ...(snapshotAuthority ? { snapshotAuthority } : {}),
    ...(gitSummary ? { gitSummary } : {}),
    ...(localSetup ? { localSetup } : {}),
    residentLifecycleOperations,
    residentExtensionUiRequests,
    operations: {
      submitCommands: residentSessionReady,
      startResidentTurn: residentTurnStartReady,
      stopResidentTurn: residentSessionReady && !abortCommandPending && (residentTurnActive || retainedPromptOwned),
      ...(residentProvisioningReady ? { provisionResident: true } : {}),
      ...(residentEndReady ? { endResident: true } : {}),
      crossHostHandoff:
        selectedHostHasAuthority &&
        activePhase === 'online' &&
        advertisedCapabilities.includes(THREAD_HANDOFF_CAPABILITY),
      ...(modelCatalogReady
        ? {
            modelCatalog: true,
            ...(residentTurnStartReady ? { selectResidentModel: true } : {}),
          }
        : {}),
      ...(thinkingLevelSelectionReady ? { selectResidentThinkingLevel: true } : {}),
      ...(runtimeOAuthReady ? { runtimeOAuth: true } : {}),
      ...(runtimeProviderSetupReady ? { runtimeProviderSetup: true } : {}),
      ...(selectedHostHasAuthority &&
      selectedSnapshotIsMaterialized &&
      activePhase === 'online' &&
      asString(activeTarget?.kind) === 'local' &&
      asString(rawConnection?.path) === 'local_socket' &&
      advertisedCapabilities.includes(CANDIDATE_EVALUATION_PROBE_CAPABILITY)
        ? { candidateEvaluationProbe: true }
        : {}),
    },
    composerReceipt: selectedResidentEnd
      ? {
          state: selectedResidentEnd.lastStatus?.phase === 'completed'
            ? 'idle'
            : selectedResidentEnd.state === 'outcome_unknown' || selectedResidentEnd.lastStatus?.phase === 'quarantined'
              ? 'uncertain'
              : 'sent',
          operation: 'end',
          ...(selectedResidentEnd.lastStatus?.phase === 'ending' ? { retryable: true } : {}),
          message: selectedResidentEnd.lastStatus?.phase === 'quarantined'
            ? 'End outcome unknown · this resident session stays locked for inspection'
            : selectedResidentEnd.lastStatus?.phase === 'completed'
              ? 'Resident session ended · saved thread remains available'
              : selectedResidentEnd.lastStatus?.phase === 'ending'
                ? 'Ready to finish · Prime Agent has not received an End request'
                : 'Finishing session · checking for completion',
        }
      : composerReceipt,
  }
}

function progressCopy(raw: UnknownRecord): { phase?: HandoffPhase; message: string; failed?: Error } {
  const phase = asString(raw.phase)
  if (phase === 'failed') {
    return { message: 'The move failed. The source remains authoritative.', failed: bridgeError(raw.error) }
  }
  if (phase === 'quiescing') return { phase, message: asString(raw.detail) ?? 'Preparing the source thread' }
  if (phase === 'checkpointing') return { phase, message: 'Creating an immutable source checkpoint' }
  if (phase === 'transferring') {
    const bytes = asNumber(raw.bytes)
    const total = asNumber(raw.totalBytes)
    return { phase, message: total ? `Transferred ${formatBytes(bytes)} of ${formatBytes(total)}` : `Transferred ${formatBytes(bytes)}` }
  }
  if (phase === 'materializing') return { phase, message: asString(raw.detail) ?? 'Creating the destination worktree' }
  if (phase === 'verifying') return { phase, message: asString(raw.detail) ?? 'Verifying hashes and Git status equivalence' }
  if (phase === 'switching_authority') return { phase, message: 'Making the destination authoritative' }
  if (phase === 'complete') return { phase, message: 'Thread moved and verified' }
  return { message: 'Updating move progress' }
}

function nativeComposerReceipt(
  raw: UnknownRecord,
  operation?: ComposerOperation,
): { state: ComposerReceiptState; message: string; terminal: boolean; retryable?: boolean } {
  const status = asString(raw.status)
  const detail = asString(raw.detail) ?? asString(raw.message)
  if (status === 'waiting_for_connection') {
    return { state: 'waiting_for_connection', message: detail ?? 'Waiting for connection · saved in this device’s outbox', terminal: false }
  }
  if (status === 'uncertain') {
    const durable = asBoolean(raw.durable) === true
    const retryable = asBoolean(asRecord(raw.error)?.retryable) ?? false
    return {
      state: 'uncertain',
      message: operation === 'abort'
        ? 'Outcome unknown · recovery required; this Stop will not be replayed'
        : detail ?? (durable ? 'Outcome unknown · command was not replayed' : 'Receipt uncertain · verifying with host'),
      terminal: operation === 'prompt' || operation === 'abort' ? false : durable,
      retryable,
    }
  }
  if (status === 'received') return { state: 'sending', message: detail ?? 'Received by host · awaiting durable admission', terminal: false }
  if (status === 'admitted') {
    return {
      state: 'sent',
      message: detail ?? 'Delivery crossed a non-replayable boundary · reconciling the final acknowledgement',
      terminal: false,
    }
  }
  if (status === 'running') {
    return {
      state: 'sent',
      message: detail ?? (operation === 'abort'
        ? 'Stop accepted · waiting for authoritative idle proof'
        : 'Prime Agent owns this prompt · waiting for authoritative idle proof'),
      terminal: false,
    }
  }
  if (status === 'rejected' || status === 'failed' || status === 'cancelled') {
    return { state: 'rejected', message: detail ?? 'The host rejected this command.', terminal: true }
  }
  if (status === 'completed' && operation === 'prompt') {
    return { state: 'idle', message: detail ?? 'Prime Agent is ready for a new prompt', terminal: true }
  }
  if (status === 'completed' && operation === 'abort') {
    return { state: 'idle', message: detail ?? 'Prime Agent stopped safely', terminal: true }
  }
  return { state: 'sent', message: detail ?? 'Sent · durably admitted by host', terminal: true }
}

type ComposerOperation = 'prompt' | 'abort'

interface ComposerActionFence {
  commandId: string
  expectedHostId: string
  threadId: string
  expectedExecutionGenerationId: string
  operation: ComposerOperation
  issuedAt: string
  sequence: number
}

interface ResidentPreferenceSelectionAuthority {
  localThreadId: string
  remoteThreadId: string
  expectedHostId: string
  expectedExecutionGenerationId: string
  connectionGeneration: number
}

interface ResidentExtensionUiResponseAuthority {
  localThreadId: string
  remoteThreadId: string
  expectedHostId: string
  expectedExecutionGenerationId: string
  bindingFingerprint: string
  requestId: string
  requestDigest: string
  method: ResidentExtensionUiRequest['method']
  connectionGeneration: number
}

interface ActiveResidentPreferenceSelection {
  kind: 'model' | 'thinking'
  bindingKey: string
  result: Promise<ResidentModelSelectionResult>
}

interface ResidentExtensionUiResponseAttempt {
  responseFingerprint: string
  promise: Promise<ResidentExtensionUiResponseResult>
}

interface RuntimeOAuthAuthority {
  expectedHostId: string
  connectionGeneration: number
}

interface NativeRuntimeOAuthView {
  sessionId: string
  providerId: string
  phase: 'starting' | 'awaiting_user' | 'committing' | 'completed' | 'cancelled' | 'failed'
  expiresAt: string
  interaction?: 'browser' | 'manual' | 'selection'
  configured: boolean
  retryable: boolean
}

interface ActiveRuntimeOAuth {
  bindingKey: string
  request: RuntimeOAuthRequest
  authority: RuntimeOAuthAuthority
  onProgress: (progress: RuntimeOAuthProgress) => void
  cancelRequested: boolean
  sessionId?: string
  result?: Promise<RuntimeOAuthResult>
}

type ResidentLifecycleWorkspaceKind = 'local_path' | 'registered_workspace'

interface ResidentLifecycleAuthority {
  expectedHostId: string
  generation: number
  connectionKind: 'local' | 'ssh'
  workspaceKind: ResidentLifecycleWorkspaceKind
  capabilityRequired: boolean
}

interface ResidentWorkspaceReference {
  projectId: string
  workspaceId: string
  referenceThreadId: string
  referenceExecutionGenerationId: string
}

interface RetainedResidentWorkspaceSelection {
  selection: ResidentWorkspaceSelection
  connectionGeneration: number
}

interface RetainedResidentWorkspacePreselection {
  preselection: ResidentWorkspacePreselection
  expectedHostId: string
  connectionGeneration: number
}

interface RetainedResidentEndPreparation {
  preparation: ResidentEndPreparation
  connectionGeneration: number
  workspaceKind: ResidentLifecycleWorkspaceKind
  reference?: ResidentWorkspaceReference
}

const PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID = 'openai-codex'
const RUNTIME_OAUTH_POLL_INTERVAL_MS = 500
const RUNTIME_OAUTH_MAX_POLLS = 600
const RUNTIME_OAUTH_MAX_DURATION_MS = 5 * 60 * 1_000

const RUNTIME_OAUTH_VIEW_KEYS = new Set([
  'sessionId',
  'providerId',
  'phase',
  'expiresAt',
  'interaction',
  'configured',
  'error',
])

function runtimeOAuthViewFromNative(value: unknown): NativeRuntimeOAuthView {
  const raw = asRecord(value)
  const sessionId = asString(raw?.sessionId)
  const providerId = asString(raw?.providerId)
  const phase = asString(raw?.phase)
  const expiresAt = asString(raw?.expiresAt)
  const interaction = asRecord(raw?.interaction)
  const interactionKind = asString(interaction?.kind)
  const interactionState = asString(interaction?.state)
  const error = asRecord(raw?.error)
  const errorKeys = error ? Object.keys(error) : []
  if (
    !raw ||
    Object.keys(raw).some((key) => !RUNTIME_OAUTH_VIEW_KEYS.has(key)) ||
    !sessionId ||
    sessionId.length > 512 ||
    /[\0\r\n]/.test(sessionId) ||
    !providerId ||
    providerId.length > 128 ||
    /[\0\r\n]/.test(providerId) ||
    !phase ||
    !['starting', 'awaiting_user', 'committing', 'completed', 'cancelled', 'failed'].includes(phase) ||
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    (raw.configured !== undefined && raw.configured !== true) ||
    (interaction !== undefined && (
      !interaction ||
      Object.keys(interaction).some((key) => key !== 'kind' && key !== 'state') ||
      !['browser', 'manual', 'selection'].includes(interactionKind ?? '') ||
      !['opened', 'unavailable'].includes(interactionState ?? '') ||
      (interactionKind === 'browser' ? interactionState !== 'opened' : interactionState !== 'unavailable')
    )) ||
    (error !== undefined && (
      !error ||
      errorKeys.some((key) => key !== 'code' && key !== 'retryable') ||
      typeof error.code !== 'string' ||
      typeof error.retryable !== 'boolean'
    ))
  ) {
    throw new Error('The native Prime OAuth bridge returned an invalid renderer-safe status.')
  }
  return {
    sessionId,
    providerId,
    phase: phase as NativeRuntimeOAuthView['phase'],
    expiresAt,
    ...(interactionKind ? { interaction: interactionKind as NativeRuntimeOAuthView['interaction'] } : {}),
    configured: raw.configured === true,
    retryable: asBoolean(error?.retryable) ?? false,
  }
}

export class NativeRendererApi implements RendererApi {
  readonly environment = 'native' as const
  private readonly deviceId = getDeviceId()
  private projectionEntries: Record<string, NativeProjectionCacheEntry> = {}
  private catalog?: unknown
  private threadSnapshot?: unknown
  private connection?: unknown
  private outbox?: unknown
  private quarantinedOutboxCount = 0
  private durableUncertainReceipts: unknown = []
  private residentLifecycleOperations: unknown = []
  private cacheUpdatedAt?: unknown
  private projection?: WorkbenchSnapshot
  private activeProgress?: (phase: HandoffPhase, message: string) => void
  private readonly installPlans = new Map<string, UnknownRecord>()
  private readonly discoveredComputers = new Map<string, DiscoveredComputer>()
  private readonly residentWorkspaceSelections = new Map<string, RetainedResidentWorkspaceSelection>()
  private readonly residentWorkspacePreselections = new Map<string, RetainedResidentWorkspacePreselection>()
  private readonly residentEndPreparations = new Map<string, RetainedResidentEndPreparation>()
  private readonly consumedRegisteredWorkspaceSelectionTokens = new Set<string>()
  private readonly pendingResidentMaterializations = new Set<string>()
  private readonly handoffDestinations = new Map<string, string>()
  private readonly handoffSources = new Map<string, string>()
  private readonly composerCommands = new Map<string, string>()
  private readonly composerDevices = new Map<string, string>()
  private readonly composerHosts = new Map<string, string>()
  private readonly composerGenerations = new Map<string, string>()
  private readonly composerFingerprints = new Map<string, string>()
  private readonly composerOperations = new Map<string, ComposerOperation>()
  private readonly composerBaselineCursors = new Map<string, string>()
  private readonly composerActionFences = new Map<string, ComposerActionFence>()
  private readonly latestComposerActions = new Map<string, ComposerActionFence>()
  private readonly composerIssuedAtEpochs = new Map<string, number>()
  private readonly composerIdentityConflicts = new Set<string>()
  private readonly retiredExecutionGenerations = new Map<string, Set<string>>()
  private readonly retiredCursorGenerations = new Map<string, Set<string>>()
  private readonly listeners = new Set<(snapshot: WorkbenchSnapshot) => void>()
  private nativeSubscriptionsStarted = false
  private nativeUnsubscribers: Array<() => void> = []
  private reconciliationStarted = false
  private workbenchLoaded = false
  private selectedThreadId?: string
  private threadSelectionGeneration = 0
  private userThreadSelectionRevision = 0
  private connectionGeneration = 0
  private connectionObservationRevision = 0
  private projectionRevision = 0
  private composerActionSequence = 0
  private authoritativeRefreshGeneration?: number
  private authoritativeRefreshPromise?: Promise<void>
  private activeResidentPreferenceSelection?: ActiveResidentPreferenceSelection
  private readonly residentExtensionUiResponseAttempts = new Map<string, ResidentExtensionUiResponseAttempt>()
  private activeRuntimeOAuth?: ActiveRuntimeOAuth
  private mutationAuthorityReadyHostId?: string
  private mutationAuthorityHydrationGeneration?: number
  private mutationAuthorityHydrationPromise?: Promise<void>
  private explicitHostActivationExpectedHostId?: string
  private explicitHostActivationSelectionRevision?: number
  private readonly activationRetryRequiredHostIds = new Set<string>()
  private latestAuthoritativeMaterialization?: {
    connectionGeneration: number
    hostId: string
    threadId: string
    executionGenerationId: string
  }
  private composerOverride?: {
    threadId: string
    expectedHostId: string
    expectedExecutionGenerationId: string
    operation: ComposerOperation
    baselineSnapshotCursor: string
    state: ComposerReceiptState
    message: string
    retryable?: boolean
  }

  constructor(
    private readonly bridge: NativePrimeBridge,
    private readonly options: { allowConnectionInitiation?: boolean } = {},
  ) {}

  private async call<T>(method: string, payload?: unknown): Promise<T> {
    const candidate = (this.bridge as Record<string, unknown>)[method]
    if (typeof candidate !== 'function') {
      throw new Error(`The native Prime bridge does not expose ${method}.`)
    }
    const raw = await (candidate as (input?: unknown) => Promise<unknown>)(payload)
    return unwrapResult<T>(raw)
  }

  private async callAtInvocationBoundary<T>(
    method: string,
    payload: unknown,
    onInvoke: () => void,
  ): Promise<T> {
    const candidate = (this.bridge as Record<string, unknown>)[method]
    if (typeof candidate !== 'function') {
      throw new Error(`The native Prime bridge does not expose ${method}.`)
    }
    onInvoke()
    const raw = await (candidate as (input?: unknown) => Promise<unknown>)(payload)
    return unwrapResult<T>(raw)
  }

  async hudOpen(target: HudTarget): Promise<HudState> {
    return this.call<HudState>('hudOpen', target)
  }

  async candidateEvaluationPreflight(
    input: CandidateEvaluationPreflightRequest,
  ): Promise<CandidateEvaluationPreflight> {
    const { CandidateEvaluationPreflightSchema } = await loadProtocolSchemas()
    const preflight = CandidateEvaluationPreflightSchema.parse(
      await this.call<unknown>('candidateEvaluationPreflight', input),
    )
    if (!candidateEvaluationAuthorityMatches(input, preflight)) throw new StaleHostAuthorityError()
    return preflight
  }

  async startCandidateEvaluation(
    input: CandidateEvaluationStartRequest,
  ): Promise<CandidateEvaluationStatus> {
    const { CandidateEvaluationStatusSchema } = await loadProtocolSchemas()
    const status = CandidateEvaluationStatusSchema.parse(
      await this.call<unknown>('startCandidateEvaluation', input),
    )
    if (
      !candidateEvaluationAuthorityMatches(input, status) ||
      status.operationId !== input.operationId ||
      !candidateEvaluationReviewMatches(input.expectedReview, status.review)
    ) throw new StaleHostAuthorityError()
    return status
  }

  async candidateEvaluationSnapshot(
    input: CandidateEvaluationPreflightRequest,
  ): Promise<CandidateEvaluationSnapshot> {
    const { CandidateEvaluationSnapshotSchema } = await loadProtocolSchemas()
    const snapshot = CandidateEvaluationSnapshotSchema.parse(
      await this.call<unknown>('candidateEvaluationSnapshot', input),
    )
    if (!candidateEvaluationAuthorityMatches(input, snapshot)) throw new StaleHostAuthorityError()
    return snapshot
  }

  async hudState(): Promise<HudState> {
    return this.call<HudState>('hudState')
  }

  async hudSetMode(mode: HudMode): Promise<HudState> {
    return this.call<HudState>('hudSetMode', mode)
  }

  async hudClose(): Promise<HudState> {
    return this.call<HudState>('hudClose')
  }

  async hudReturnToWorkbench(): Promise<void> {
    await this.call<void>('hudReturnToWorkbench')
  }

  async hudSetIgnoreMouseEvents(ignore: boolean): Promise<HudState> {
    return this.call<HudState>('hudSetIgnoreMouseEvents', ignore)
  }

  onHudState(listener: (state: HudState) => void): () => void {
    const candidate = (this.bridge as Record<string, unknown>).onHudState
    if (typeof candidate !== 'function') return () => undefined
    const unsubscribe = (candidate as (listener: (state: HudState) => void) => unknown).call(this.bridge, listener)
    return typeof unsubscribe === 'function' ? unsubscribe as () => void : () => undefined
  }

  private updateProjection(): WorkbenchSnapshot {
    this.projection = nativeProjection({
      catalog: this.catalog,
      threadSnapshot: this.threadSnapshot,
      connection: this.connection,
      outbox: this.outbox,
      quarantinedOutboxCount: this.quarantinedOutboxCount,
      durableUncertainReceipts: this.durableUncertainReceipts,
      residentLifecycleOperations: this.residentLifecycleOperations,
      updatedAt: this.cacheUpdatedAt,
      selectedThreadId: this.selectedThreadId,
      deviceId: this.deviceId,
      mutationAuthorityReady:
        this.mutationAuthorityReadyHostId === asString(asRecord(this.connection)?.hostId),
      activationRequiredHostId: this.activationRetryRequiredHostIds.has(
        asString(asRecord(this.connection)?.hostId) ?? '',
      )
        ? asString(asRecord(this.connection)?.hostId)
        : undefined,
      connectionGeneration: this.connectionGeneration,
      authoritativeMaterialization: this.authoritativeMaterializationProof(),
    })
    const selectedThread = this.projection.threads.find((thread) => thread.id === this.projection?.selectedThreadId)
    if (
      this.composerOverride &&
      selectedThread?.id === this.composerOverride.threadId &&
      selectedThread.hostId === this.composerOverride.expectedHostId &&
      selectedThread.executionGenerationId === this.composerOverride.expectedExecutionGenerationId
    ) {
      // Resident prompt and Stop ownership are exact receipt identities. Prime
      // cursor movement—even an idle projection—cannot consume either one;
      // only its operation-matching completed idle proof may clear it.
      const pending = this.composerOverride.state === 'sending' ||
        this.composerOverride.state === 'sent' ||
        this.composerOverride.state === 'uncertain' ||
        this.composerOverride.state === 'waiting_for_connection'
      const blockStart = pending && (
        this.composerOverride.operation === 'prompt' || this.composerOverride.operation === 'abort'
      )
      const blockStop = pending && this.composerOverride.operation === 'abort' && (
        this.composerOverride.state !== 'uncertain' || this.composerOverride.retryable === false
      )
      const promptMayBeOwned = this.composerOverride.operation === 'prompt' &&
        (this.composerOverride.state === 'sent' || this.composerOverride.state === 'uncertain')
      this.projection = {
        ...this.projection,
        operations: {
          ...this.projection.operations,
          startResidentTurn: blockStart ? false : this.projection.operations.startResidentTurn,
          stopResidentTurn: blockStop
            ? false
            : promptMayBeOwned
              ? this.projection.operations.submitCommands
              : this.projection.operations.stopResidentTurn,
        },
        composerReceipt: {
          state: this.composerOverride.state,
          message: this.composerOverride.message,
          operation: this.composerOverride.operation,
          ...(this.composerOverride.retryable !== undefined
            ? { retryable: this.composerOverride.retryable }
            : {}),
          },
        }
    }
    return this.projection
  }

  private publish(): WorkbenchSnapshot {
    const projection = this.updateProjection()
    for (const listener of this.listeners) listener(projection)
    return projection
  }

  private connectionKey(state: unknown): string {
    const connection = asRecord(state)
    const target = asRecord(connection?.target)
    return [
      asString(connection?.phase) ?? '',
      asString(connection?.path) ?? '',
      asString(connection?.hostId) ?? '',
      asString(target?.kind) ?? '',
      asString(target?.alias) ?? '',
    ].join('|')
  }

  private connectionObservationKey(state: unknown): string {
    const connection = asRecord(state)
    const readiness = asRecord(connection?.runtimeReadiness)
    const runtime = asRecord(readiness?.snapshot)
    const error = asRecord(connection?.error)
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string').sort()
      : []
    return [
      capabilities.join(','),
      asString(readiness?.kind) ?? '',
      asString(readiness?.hostId) ?? '',
      asString(runtime?.status) ?? '',
      asString(runtime?.phase) ?? '',
      asString(runtime?.assurance) ?? '',
      asString(runtime?.recoveryAction) ?? '',
      runtime?.retryable === true ? 'runtime-retryable' : '',
      localSetupDiagnosticCode(runtime?.code) ?? '',
      localSetupDiagnosticCode(error?.code) ?? '',
      error?.retryable === true ? 'retryable' : '',
    ].join('|')
  }

  private connectionTargetKey(state: unknown): string {
    const target = asRecord(asRecord(state)?.target)
    const kind = asString(target?.kind)
    if (!kind) return ''
    return [kind, asString(target?.alias) ?? ''].join('|')
  }

  private beginConnectionReplyFence(target: UnknownRecord): {
    revision: number
    observedTargetKey: string
    requestedTargetKey: string
  } {
    return {
      // Beginning another connect supersedes every older reply, just as a
      // native connection event does. The bridge reply is only an observation;
      // it never outranks an event or request that the renderer saw later.
      revision: ++this.connectionObservationRevision,
      observedTargetKey: this.connectionTargetKey(this.connection),
      requestedTargetKey: this.connectionTargetKey({ target }),
    }
  }

  private connectionReplyIsCurrent(
    fence: { revision: number; observedTargetKey: string; requestedTargetKey: string },
    state: unknown,
  ): boolean {
    return (
      fence.revision === this.connectionObservationRevision &&
      fence.observedTargetKey === this.connectionTargetKey(this.connection) &&
      fence.requestedTargetKey === this.connectionTargetKey(state)
    )
  }

  private beginHostActivationReplyFence(): { revision: number; observedConnectionKey: string } {
    return {
      // An activation request carries only the immutable host identity. The
      // configured SSH locator stays in the main process and is never accepted
      // from renderer input.
      revision: ++this.connectionObservationRevision,
      observedConnectionKey: this.connectionKey(this.connection),
    }
  }

  private hostActivationReplyIsCurrent(
    fence: { revision: number; observedConnectionKey: string },
  ): boolean {
    return (
      fence.revision === this.connectionObservationRevision &&
      fence.observedConnectionKey === this.connectionKey(this.connection)
    )
  }

  private isExactSshAuthority(state: unknown, expectedHostId: string): boolean {
    const connection = asRecord(state)
    const target = asRecord(connection?.target)
    return (
      asString(connection?.phase) === 'online' &&
      asString(connection?.path) === 'ssh' &&
      asString(connection?.hostId) === expectedHostId &&
      asString(target?.kind) === 'ssh'
    )
  }

  private restoreSelectedHostThread(
    expectedHostId: string,
    remoteThreadId: string,
    expectedExecutionGenerationId: string,
  ): void {
    const selectedThread = this.updateProjection().threads.find(
      (thread) =>
        thread.hostId === expectedHostId &&
        protocolThreadId(thread) === remoteThreadId &&
        thread.executionGenerationId === expectedExecutionGenerationId,
    )
    if (!selectedThread) return
    if (this.selectedThreadId !== selectedThread.id) this.threadSelectionGeneration += 1
    this.selectedThreadId = selectedThread.id
    this.threadSnapshot = this.cachedSnapshotForThread(
      remoteThreadId,
      expectedHostId,
      selectedThread.executionGenerationId,
    )
    this.publish()
  }

  private authoritativeMaterializationProof(): typeof this.latestAuthoritativeMaterialization {
    return this.latestAuthoritativeMaterialization
  }

  private rebuildCatalog(): void {
    const activeHostId = asString(asRecord(this.connection)?.hostId)
    this.catalog = aggregateProjectionCatalog(this.projectionEntries, activeHostId)
  }

  private replaceCatalogEntry(hostId: string, catalog: unknown, updatedAt?: string): boolean {
    const previous = this.projectionEntries[hostId]
    const incomingLineages = catalogGenerationLineages(catalog, hostId)
    for (const [threadId, lineage] of incomingLineages) {
      if (
        lineage.generationId &&
        this.retiredExecutionGenerations.get(`${hostId}\u0000${threadId}`)?.has(lineage.generationId)
      ) return false
    }
    if (catalogRegressesForHost(previous?.catalog, catalog, hostId)) return false
    const previousLineages = catalogGenerationLineages(previous?.catalog, hostId)
    for (const [threadId, previousLineage] of previousLineages) {
      if (incomingLineages.has(threadId) || !previousLineage.generationId) continue
      if (!this.retireRendererExecutionGeneration(hostId, threadId, previousLineage.generationId)) return false
    }
    for (const [threadId, lineage] of incomingLineages) {
      const previousGenerationId = previousLineages.get(threadId)?.generationId
      if (
        !previousGenerationId ||
        !lineage.generationId ||
        previousGenerationId === lineage.generationId
      ) continue
      if (!this.retireRendererExecutionGeneration(hostId, threadId, previousGenerationId)) return false
    }
    this.projectionEntries = {
      ...this.projectionEntries,
      [hostId]: {
        ...previous,
        hostId,
        catalog,
        updatedAt: updatedAt ?? new Date().toISOString(),
      },
    }
    this.rebuildCatalog()
    this.projectionRevision += 1
    return true
  }

  private replaceSnapshotEntry(hostId: string, snapshot: unknown, updatedAt?: string): boolean {
    const previous = this.projectionEntries[hostId]
    const threadId = snapshotThreadId(snapshot)
    const incomingGenerationId = snapshotExecutionGenerationId(snapshot)
    if (!threadId || !incomingGenerationId || snapshotHostId(snapshot) !== hostId) return false
    const catalogLineage = catalogGenerationLineages(previous?.catalog, hostId).get(threadId)
    if (catalogLineage?.generationId !== incomingGenerationId) return false
    if (this.retiredExecutionGenerations.get(`${hostId}\u0000${threadId}`)?.has(incomingGenerationId)) return false
    const cursorGeneration = snapshotCursorGeneration(snapshot)
    if (!cursorGeneration) return false
    const cursorLineageKey = `${hostId}\u0000${threadId}\u0000${incomingGenerationId}`
    if (this.retiredCursorGenerations.get(cursorLineageKey)?.has(cursorGeneration)) return false
    const previousCursorGeneration = snapshotExecutionGenerationId(previous?.lastSnapshot) === incomingGenerationId
      ? snapshotCursorGeneration(previous?.lastSnapshot)
      : undefined
    if (previousCursorGeneration && previousCursorGeneration !== cursorGeneration) {
      const previousGeneratedAt = Date.parse(asString(asRecord(previous?.lastSnapshot)?.generatedAt) ?? '')
      const incomingGeneratedAt = Date.parse(asString(asRecord(snapshot)?.generatedAt) ?? '')
      if (
        Number.isFinite(previousGeneratedAt) &&
        Number.isFinite(incomingGeneratedAt) &&
        incomingGeneratedAt <= previousGeneratedAt
      ) return false
      if (!this.retireRendererCursorGeneration(cursorLineageKey, previousCursorGeneration)) return false
    }
    if (snapshotRegresses(previous?.lastSnapshot, snapshot)) return false
    const previousGenerationId = snapshotExecutionGenerationId(previous?.lastSnapshot)
    if (
      snapshotThreadId(previous?.lastSnapshot) === threadId &&
      previousGenerationId &&
      previousGenerationId !== incomingGenerationId
    ) {
      if (!this.retireRendererExecutionGeneration(hostId, threadId, previousGenerationId)) return false
    }
    this.projectionEntries = {
      ...this.projectionEntries,
      [hostId]: {
        ...previous,
        hostId,
        lastSnapshot: snapshot,
        updatedAt: updatedAt ?? new Date().toISOString(),
      },
    }
    this.projectionRevision += 1
    return true
  }

  private retireRendererExecutionGeneration(hostId: string, threadId: string, generationId: string): boolean {
    const key = `${hostId}\u0000${threadId}`
    let retired = this.retiredExecutionGenerations.get(key)
    if (!retired) {
      if (this.retiredExecutionGenerations.size >= 512) {
        return false
      }
      retired = new Set<string>()
      this.retiredExecutionGenerations.set(key, retired)
    }
    if (retired.has(generationId)) return true
    if (retired.size >= 64) return false
    retired.add(generationId)
    return true
  }

  private retireRendererCursorGeneration(lineageKey: string, generationId: string): boolean {
    let retired = this.retiredCursorGenerations.get(lineageKey)
    if (!retired) {
      if (this.retiredCursorGenerations.size >= 512) return false
      retired = new Set<string>()
      this.retiredCursorGenerations.set(lineageKey, retired)
    }
    if (retired.has(generationId)) return true
    if (retired.size >= 16) return false
    retired.add(generationId)
    return true
  }

  private hydrateRetiredExecutionGenerations(): void {
    this.retiredExecutionGenerations.clear()
    for (const [hostId, entry] of Object.entries(this.projectionEntries)) {
      for (const [threadId, generations] of Object.entries(entry.retiredExecutionGenerations ?? {})) {
        for (const generationId of generations) {
          if (!this.retireRendererExecutionGeneration(hostId, threadId, generationId)) {
            throw new StaleHostAuthorityError()
          }
        }
      }
    }
  }

  private cachedSnapshotForThread(threadId: string, hostId: string, executionGenerationId?: string): unknown {
    const snapshot = this.projectionEntries[hostId]?.lastSnapshot
    return (
      executionGenerationId &&
      snapshotThreadId(snapshot) === threadId &&
      snapshotHostId(snapshot) === hostId &&
      snapshotExecutionGenerationId(snapshot) === executionGenerationId
    )
      ? snapshot
      : undefined
  }

  private clearAuthorityMutationState(): void {
    this.outbox = []
    this.residentLifecycleOperations = []
    this.composerOverride = undefined
    this.composerCommands.clear()
    this.composerDevices.clear()
    this.composerHosts.clear()
    this.composerGenerations.clear()
    this.composerFingerprints.clear()
    this.composerOperations.clear()
    this.composerBaselineCursors.clear()
    this.composerActionFences.clear()
    this.latestComposerActions.clear()
    this.composerIssuedAtEpochs.clear()
    this.composerIdentityConflicts.clear()
    this.handoffDestinations.clear()
    this.handoffSources.clear()
    this.residentWorkspaceSelections.clear()
    this.residentWorkspacePreselections.clear()
    this.residentEndPreparations.clear()
    this.consumedRegisteredWorkspaceSelectionTokens.clear()
    this.pendingResidentMaterializations.clear()
    this.activeProgress = undefined
    this.mutationAuthorityReadyHostId = undefined
    this.threadSelectionGeneration += 1
  }

  private applyConnectionState(state: unknown): void {
    this.connectionObservationRevision += 1
    const previousPhase = asString(asRecord(this.connection)?.phase)
    const nextPhase = asString(asRecord(state)?.phase)
    const previousTarget = this.connectionTargetKey(this.connection)
    const nextTarget = this.connectionTargetKey(state)
    const previousHostId = asString(asRecord(this.connection)?.hostId)
    const verifiedHostId = asString(asRecord(state)?.hostId)
    const targetChanged = Boolean(previousTarget && nextTarget && previousTarget !== nextTarget)
    const authorityChanged = Boolean(verifiedHostId && previousHostId && verifiedHostId !== previousHostId)
    const preserveNewerExplicitSelection = Boolean(
      verifiedHostId &&
      this.explicitHostActivationExpectedHostId === verifiedHostId &&
      this.explicitHostActivationSelectionRevision !== undefined &&
      this.userThreadSelectionRevision !== this.explicitHostActivationSelectionRevision,
    )
    if (targetChanged || authorityChanged) this.clearAuthorityMutationState()
    const connectionChanged = this.connectionKey(this.connection) !== this.connectionKey(state)
    const observationChanged = this.connectionObservationKey(this.connection) !== this.connectionObservationKey(state)
    this.connection = state
    if (connectionChanged) {
      this.connectionGeneration += 1
      this.projectionRevision += 1
    } else if (observationChanged) {
      // Readiness and structured setup errors are projection state, but they do
      // not replace host authority. Fence an in-flight bootstrap without
      // invalidating exact host-bound mutations.
      this.projectionRevision += 1
    }
    if (authorityChanged && verifiedHostId && !preserveNewerExplicitSelection) {
      const cached = this.projectionEntries[verifiedHostId]?.lastSnapshot
      this.threadSnapshot = cached
      this.selectedThreadId = undefined
    }
    this.rebuildCatalog()
    if (authorityChanged && verifiedHostId && !preserveNewerExplicitSelection) {
      const cachedThreadId = snapshotThreadId(this.threadSnapshot)
      if (cachedThreadId) {
        this.selectedThreadId = this.updateProjection().threads.find(
          (thread) => thread.hostId === verifiedHostId && protocolThreadId(thread) === cachedThreadId,
        )?.id
      }
    }
    this.publish()

    if (
      this.workbenchLoaded &&
      nextPhase === 'online' &&
      verifiedHostId &&
      this.explicitHostActivationExpectedHostId !== verifiedHostId &&
      !this.activationRetryRequiredHostIds.has(verifiedHostId)
    ) {
      if (this.mutationAuthorityReadyHostId !== verifiedHostId) {
        void this.rehydrateAuthorityMutationState(verifiedHostId, this.connectionGeneration)
          .then(async () => await this.refreshFromAuthoritativeHost())
          .catch(() => undefined)
      } else if (previousPhase !== 'online') {
        void this.refreshFromAuthoritativeHost().catch(() => undefined)
      }
    }
  }

  private rehydrateAuthorityMutationState(hostId: string, generation: number): Promise<void> {
    if (
      this.mutationAuthorityHydrationPromise &&
      this.mutationAuthorityHydrationGeneration === generation
    ) return this.mutationAuthorityHydrationPromise
    const previous = this.mutationAuthorityHydrationPromise
    const hydration = (async () => {
      if (previous) await previous.catch(() => undefined)
      const bootstrap = asRecord(await this.call<unknown>('bootstrap'))
      const bootstrapHostId = asString(asRecord(bootstrap?.connection)?.hostId)
      if (
        generation !== this.connectionGeneration ||
        asString(asRecord(this.connection)?.phase) !== 'online' ||
        asString(asRecord(this.connection)?.hostId) !== hostId ||
        bootstrapHostId !== hostId
      ) throw new StaleHostAuthorityError()
      if (
        this.explicitHostActivationExpectedHostId === hostId &&
        this.explicitHostActivationSelectionRevision !== undefined &&
        this.userThreadSelectionRevision !== this.explicitHostActivationSelectionRevision
      ) throw new StaleHostAuthorityError()
      const bootstrapEntry = projectionEntriesFromCache(asRecord(bootstrap?.cache))[hostId]
      if (bootstrapEntry) {
        for (const [threadId, generations] of Object.entries(bootstrapEntry.retiredExecutionGenerations ?? {})) {
          for (const generationId of generations) {
            if (!this.retireRendererExecutionGeneration(hostId, threadId, generationId)) {
              throw new StaleHostAuthorityError()
            }
          }
        }
        if (bootstrapEntry.catalog !== undefined) {
          this.replaceCatalogEntry(hostId, bootstrapEntry.catalog, bootstrapEntry.updatedAt)
        }
        if (bootstrapEntry.lastSnapshot !== undefined) {
          this.replaceSnapshotEntry(hostId, bootstrapEntry.lastSnapshot, bootstrapEntry.updatedAt)
          this.threadSnapshot = this.projectionEntries[hostId]?.lastSnapshot
        }
        this.rebuildCatalog()
      }
      this.outbox = bootstrap?.outbox
      this.quarantinedOutboxCount = asNumber(bootstrap?.quarantinedOutboxCount) ?? 0
      this.durableUncertainReceipts = bootstrap?.durableUncertainReceipts
      this.residentLifecycleOperations = bootstrap?.residentLifecycleOperations
      this.applyPendingResidentMaterializations()
      this.hydrateComposerCommands(this.outbox)
      // An explicit cached-host activation keeps every mutation gated until
      // that exact selected thread generation has also survived the fresh
      // authoritative catalog and snapshot refresh.
      const explicitActivationDefersMutations = this.explicitHostActivationExpectedHostId === hostId
      this.mutationAuthorityReadyHostId = explicitActivationDefersMutations ? undefined : hostId
      if (!explicitActivationDefersMutations) this.activationRetryRequiredHostIds.delete(hostId)
      this.projectionRevision += 1
      const hydratedThreadId = snapshotThreadId(this.threadSnapshot)
      const hydratedGenerationId = snapshotExecutionGenerationId(this.threadSnapshot)
      if (hydratedThreadId && hydratedGenerationId) {
        this.selectedThreadId = this.updateProjection().threads.find((thread) =>
          thread.hostId === hostId &&
          protocolThreadId(thread) === hydratedThreadId &&
          thread.executionGenerationId === hydratedGenerationId,
        )?.id ?? this.selectedThreadId
      }
      this.publish()
    })()
    this.mutationAuthorityHydrationGeneration = generation
    this.mutationAuthorityHydrationPromise = hydration
    void hydration.finally(() => {
      if (this.mutationAuthorityHydrationPromise === hydration) {
        this.mutationAuthorityHydrationPromise = undefined
        this.mutationAuthorityHydrationGeneration = undefined
      }
    }).catch(() => undefined)
    return hydration
  }

  private composerActionKey(expectedHostId: string, threadId: string): string {
    return `${expectedHostId}\u0000${threadId}`
  }

  private nextComposerIssuedAt(expectedHostId: string, threadId: string): string {
    const key = this.composerActionKey(expectedHostId, threadId)
    const previous = this.composerIssuedAtEpochs.get(key) ?? 0
    const epoch = Math.max(Date.now(), previous + 1)
    this.composerIssuedAtEpochs.set(key, epoch)
    return new Date(epoch).toISOString()
  }

  private registerComposerAction(input: Omit<ComposerActionFence, 'sequence'>): ComposerActionFence {
    const action: ComposerActionFence = {
      ...input,
      sequence: ++this.composerActionSequence,
    }
    this.composerActionFences.set(action.commandId, action)
    const key = this.composerActionKey(action.expectedHostId, action.threadId)
    this.latestComposerActions.set(key, action)
    const issuedAtEpoch = Date.parse(action.issuedAt)
    if (Number.isFinite(issuedAtEpoch)) {
      this.composerIssuedAtEpochs.set(key, Math.max(this.composerIssuedAtEpochs.get(key) ?? 0, issuedAtEpoch))
    }
    return action
  }

  private isLatestComposerAction(
    commandId: string,
    expectedHostId: string,
    threadId: string,
    expectedExecutionGenerationId: string,
  ): boolean {
    const action = this.composerActionFences.get(commandId)
    const latest = this.latestComposerActions.get(this.composerActionKey(expectedHostId, threadId))
    return Boolean(
      action &&
      latest &&
      latest.commandId === commandId &&
      latest.sequence === action.sequence &&
      action.expectedHostId === expectedHostId &&
      action.threadId === threadId &&
      action.expectedExecutionGenerationId === expectedExecutionGenerationId,
    )
  }

  private hydrateComposerCommands(outbox: unknown): void {
    this.composerCommands.clear()
    this.composerDevices.clear()
    this.composerHosts.clear()
    this.composerGenerations.clear()
    this.composerFingerprints.clear()
    this.composerOperations.clear()
    this.composerBaselineCursors.clear()
    this.composerActionFences.clear()
    this.latestComposerActions.clear()
    this.composerIssuedAtEpochs.clear()
    this.composerIdentityConflicts.clear()
    const orderedEntries = records(outbox)
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => {
        const leftIssuedAt = Date.parse(asString(asRecord(left.entry.command)?.issuedAt) ?? '')
        const rightIssuedAt = Date.parse(asString(asRecord(right.entry.command)?.issuedAt) ?? '')
        if (Number.isFinite(leftIssuedAt) && Number.isFinite(rightIssuedAt) && leftIssuedAt !== rightIssuedAt) {
          return leftIssuedAt - rightIssuedAt
        }
        return left.index - right.index
      })
    for (const { entry } of orderedEntries) {
      const command = asRecord(entry.command)
      const commandId = asString(command?.commandId)
      const deviceId = asString(command?.deviceId)
      const threadId = asString(command?.threadId)
      const hostId = asString(command?.expectedHostId)
      const entryHostId = asString(entry.hostId)
      const generationId = asString(command?.expectedExecutionGenerationId)
      const issuedAt = asString(command?.issuedAt)
      const commandKind = asString(command?.kind)
      const operation = commandKind === 'thread.prompt' || commandKind === 'prompt'
        ? 'prompt'
        : commandKind === 'thread.cancel' || commandKind === 'thread.abort' || commandKind === 'abort'
          ? 'abort'
          : undefined
      if (
        commandId &&
        deviceId === this.deviceId &&
        threadId &&
        hostId &&
        hostId === entryHostId &&
        generationId &&
        issuedAt &&
        operation
      ) {
        const fingerprint = canonicalRendererJson(command)
        const previousFingerprint = this.composerFingerprints.get(commandId)
        if (this.composerIdentityConflicts.has(commandId)) continue
        if (previousFingerprint && previousFingerprint !== fingerprint) {
          this.forgetComposerCommand(commandId)
          this.composerIdentityConflicts.add(commandId)
          continue
        }
        this.composerCommands.set(commandId, threadId)
        this.composerDevices.set(commandId, deviceId)
        this.composerHosts.set(commandId, hostId)
        this.composerGenerations.set(commandId, generationId)
        this.composerFingerprints.set(commandId, fingerprint)
        this.composerOperations.set(commandId, operation)
        this.composerBaselineCursors.set(
          commandId,
          canonicalRendererJson(asRecord(asRecord(this.threadSnapshot)?.latestCursor) ?? {}),
        )
        this.registerComposerAction({
          commandId,
          expectedHostId: hostId,
          threadId,
          expectedExecutionGenerationId: generationId,
          operation,
          issuedAt,
        })
      }
    }
  }

  private updateOutboxFromReceipt(
    commandId: string,
    deviceId: string,
    expectedHostId: string,
    threadId: string,
    expectedExecutionGenerationId: string,
    expectedCommandFingerprint: string,
    receipt: { state: ComposerReceiptState; terminal: boolean },
    operation: ComposerOperation,
    receiptStatus?: string,
  ): void {
    const entries = records(this.outbox)
    const matches = (entry: UnknownRecord): boolean => {
      const command = asRecord(entry.command)
      return (
        asString(entry.hostId) === expectedHostId &&
        asString(command?.deviceId) === deviceId &&
        asString(command?.commandId) === commandId &&
        asString(command?.expectedHostId) === expectedHostId &&
        asString(command?.threadId) === threadId &&
        asString(command?.expectedExecutionGenerationId) === expectedExecutionGenerationId &&
        canonicalRendererJson(command) === expectedCommandFingerprint
      )
    }
    if (receipt.terminal) {
      this.outbox = entries.filter((entry) => !matches(entry))
      return
    }

    const nextState =
      receipt.state === 'uncertain'
        ? 'uncertain'
        : receiptStatus === 'running' && operation === 'prompt'
          ? 'awaiting_idle_proof'
          : receiptStatus === 'running' && operation === 'abort'
            ? 'awaiting_abort_idle_proof'
          : receiptStatus === 'received' || receiptStatus === 'admitted' || receiptStatus === 'running'
            ? 'awaiting_reconciliation'
        : receipt.state === 'waiting_for_connection'
          ? 'waiting_for_connection'
          : undefined
    if (!nextState) return
    this.outbox = entries.map((entry) =>
      matches(entry) ? { ...entry, state: nextState } : entry,
    )
  }

  private retireDurableUncertainReceipt(receipt: UnknownRecord): void {
    const hostId = asString(receipt.hostId)
    const deviceId = asString(receipt.deviceId)
    const commandId = asString(receipt.commandId)
    const threadId = asString(receipt.threadId)
    const executionGenerationId = asString(receipt.executionGenerationId)
    if (!hostId || !deviceId || !commandId || !threadId || !executionGenerationId) return
    this.durableUncertainReceipts = records(this.durableUncertainReceipts).filter((candidate) => !(
      asString(candidate.hostId) === hostId &&
      asString(candidate.deviceId) === deviceId &&
      asString(candidate.commandId) === commandId &&
      asString(candidate.threadId) === threadId &&
      asString(candidate.executionGenerationId) === executionGenerationId
    ))
  }

  private forgetComposerCommand(commandId: string): void {
    this.composerCommands.delete(commandId)
    this.composerDevices.delete(commandId)
    this.composerHosts.delete(commandId)
    this.composerGenerations.delete(commandId)
    this.composerFingerprints.delete(commandId)
    this.composerOperations.delete(commandId)
    this.composerBaselineCursors.delete(commandId)
    this.composerActionFences.delete(commandId)
  }

  private startNativeSubscriptions(): void {
    if (this.nativeSubscriptionsStarted) return
    this.nativeSubscriptionsStarted = true
    const subscribe = (method: string, handler: (payload: unknown) => void) => {
      const candidate = (this.bridge as Record<string, unknown>)[method]
      if (typeof candidate !== 'function') return
      const unsubscribe = (candidate as (callback: (payload: unknown) => void) => unknown)(handler)
      if (typeof unsubscribe === 'function') this.nativeUnsubscribers.push(unsubscribe as () => void)
    }

    subscribe('onConnectionState', (state) => this.applyConnectionState(state))
    subscribe('onSnapshot', (snapshot) => {
      const value = asRecord(snapshot)
      const activeHostId = asString(asRecord(this.connection)?.hostId)
      const incomingCatalogHostIds = catalogHostIds(snapshot)
      const incomingHostId = incomingCatalogHostIds[0] ?? snapshotHostId(snapshot)
      // IPC delivery may lag a connection-state event. A snapshot is allowed
      // to replace only the currently verified authority's cache entry.
      if (!activeHostId || incomingHostId !== activeHostId) return
      if (value && incomingCatalogHostIds.length > 0) {
        if (!incomingCatalogHostIds.includes(activeHostId)) return
        if (!this.replaceCatalogEntry(activeHostId, snapshot)) return
      } else {
        const incomingThreadId = asString(asRecord(value?.thread)?.threadId)
        const selectedThread = this.projection?.threads.find((thread) => thread.id === this.selectedThreadId)
        const incomingExecutionGenerationId = snapshotExecutionGenerationId(snapshot)
        const projectedThread = this.projection?.threads.find(
          (thread) => thread.hostId === activeHostId && protocolThreadId(thread) === incomingThreadId,
        )
        if (
          !incomingThreadId ||
          !projectedThread?.executionGenerationId ||
          incomingExecutionGenerationId !== projectedThread.executionGenerationId ||
          (selectedThread && selectedThread.id !== projectedThread.id)
        ) return
        if (!this.replaceSnapshotEntry(activeHostId, snapshot)) return
        this.threadSnapshot = snapshot
        if (!this.selectedThreadId) this.selectedThreadId = projectedThread.id
      }
      this.publish()
    })
    subscribe('onHostEvent', (event) => {
      const hostEvent = asRecord(event)
      const hostEventType = asString(hostEvent?.type)
      const promptIdleObserved = hostEventType === 'resident.prompt_idle_observed'
      const abortIdleObserved = hostEventType === 'resident.abort_idle_observed'
      if (!promptIdleObserved && !abortIdleObserved && hostEventType !== 'command.receipt') return
      const receipt = asRecord(hostEvent?.payload)
      const commandId = asString(receipt?.commandId)
      const storedThreadId = commandId ? this.composerCommands.get(commandId) : undefined
      const expectedDeviceId = commandId ? this.composerDevices.get(commandId) : undefined
      const expectedHostId = commandId ? this.composerHosts.get(commandId) : undefined
      const expectedGenerationId = commandId ? this.composerGenerations.get(commandId) : undefined
      const expectedCommandFingerprint = commandId ? this.composerFingerprints.get(commandId) : undefined
      const operation = commandId ? this.composerOperations.get(commandId) : undefined
      const baselineSnapshotCursor = commandId ? this.composerBaselineCursors.get(commandId) : undefined
      const threadId = storedThreadId
        ? this.projection?.threads.find(
            (thread) =>
              thread.hostId === expectedHostId &&
              (thread.id === storedThreadId || protocolThreadId(thread) === storedThreadId),
          )?.id ?? storedThreadId
        : undefined
      const receiptHostId = asString(receipt?.hostId)
      const receiptDeviceId = asString(receipt?.deviceId)
      const receiptThreadId = asString(receipt?.threadId)
      const receiptGenerationId = asString(receipt?.executionGenerationId)
      const activeHostId = asString(asRecord(this.connection)?.hostId)
      if (
        !expectedDeviceId ||
        !expectedHostId ||
        !expectedGenerationId ||
        !expectedCommandFingerprint ||
        !operation ||
        !baselineSnapshotCursor ||
        receiptDeviceId !== expectedDeviceId ||
        receiptThreadId !== storedThreadId ||
        receiptGenerationId !== expectedGenerationId ||
        receiptHostId !== expectedHostId ||
        activeHostId !== expectedHostId
      ) return
      if (!receipt || !commandId || !threadId || !storedThreadId) return
      if (!this.hasComposerAuthority(threadId, expectedHostId, expectedGenerationId)) {
        this.forgetComposerCommand(commandId)
        if (
          this.composerOverride?.expectedHostId === expectedHostId &&
          this.composerOverride.expectedExecutionGenerationId === expectedGenerationId
        ) this.composerOverride = undefined
        return
      }
      const mapped = nativeComposerReceipt(receipt, operation)
      const isExactResidentIdleProof = Boolean(
        asString(receipt.status) === 'completed' &&
        (operation === 'prompt' || operation === 'abort'),
      )
      if (
        (promptIdleObserved && operation !== 'prompt') ||
        (abortIdleObserved && operation !== 'abort') ||
        ((promptIdleObserved || abortIdleObserved) && !isExactResidentIdleProof)
      ) return
      if (isExactResidentIdleProof) {
        this.retireDurableUncertainReceipt(receipt)
        const actionKey = this.composerActionKey(expectedHostId, storedThreadId)
        const latest = this.latestComposerActions.get(actionKey)
        if (
          latest?.expectedExecutionGenerationId === expectedGenerationId &&
          latest.operation === operation
        ) {
          // A resident proof retires only its own operation. Prompt-idle can
          // race with a newer accepted Stop, whose ownership remains until the
          // distinct abort-idle proof arrives.
          this.latestComposerActions.delete(actionKey)
        }
        if (
          this.composerOverride?.expectedHostId === expectedHostId &&
          this.composerOverride.expectedExecutionGenerationId === expectedGenerationId &&
          this.composerOverride.operation === operation &&
          (this.composerOverride.state === 'sending' ||
            this.composerOverride.state === 'sent' ||
            this.composerOverride.state === 'uncertain')
        ) {
          this.composerOverride = undefined
        }
      } else if (
        this.isLatestComposerAction(
          commandId,
          expectedHostId,
          storedThreadId,
          expectedGenerationId,
        )
      ) {
        this.composerOverride = {
          threadId,
          expectedHostId,
          expectedExecutionGenerationId: expectedGenerationId,
          operation,
          baselineSnapshotCursor,
          state: mapped.state,
          message: mapped.message,
          ...(mapped.retryable !== undefined ? { retryable: mapped.retryable } : {}),
        }
      }
      this.updateOutboxFromReceipt(
        commandId,
        expectedDeviceId,
        expectedHostId,
        storedThreadId,
        expectedGenerationId,
        expectedCommandFingerprint,
        mapped,
        operation,
        asString(receipt.status),
      )
      if (mapped.terminal) {
        this.forgetComposerCommand(commandId)
      }
      this.projectionRevision += 1
      this.publish()
    })
    subscribe('onHandoffProgress', (progress) => {
      const mapped = progressCopy(asRecord(progress) ?? {})
      if (mapped.failed) return
      if (mapped.phase) this.activeProgress?.(mapped.phase, mapped.message)
    })
  }

  private async performAuthoritativeRefresh(connectionGeneration: number): Promise<void> {
    const authorityHostId = asString(asRecord(this.connection)?.hostId)
    if (
      connectionGeneration !== this.connectionGeneration ||
      asString(asRecord(this.connection)?.phase) !== 'online' ||
      !authorityHostId
    ) {
      return
    }

    const catalog = await this.call<unknown>('hostCatalog')
    if (
      connectionGeneration !== this.connectionGeneration ||
      asString(asRecord(this.connection)?.phase) !== 'online' ||
      asString(asRecord(this.connection)?.hostId) !== authorityHostId ||
      !catalogHostIds(catalog).includes(authorityHostId)
    ) {
      return
    }

    if (!this.replaceCatalogEntry(authorityHostId, catalog)) return
    const catalogProjection = this.publish()
    if (!this.selectedThreadId || !catalogProjection.threads.some((thread) => thread.id === this.selectedThreadId)) {
      this.selectedThreadId = catalogProjection.selectedThreadId || catalogProjection.threads[0]?.id
    }
    const selectedThreadId = this.selectedThreadId
    if (!selectedThreadId) return
    const selectedThread = catalogProjection.threads.find((thread) => thread.id === selectedThreadId)
    const remoteThreadId = selectedThread ? protocolThreadId(selectedThread) : undefined
    if (selectedThread?.hostId !== authorityHostId) {
      this.threadSnapshot = remoteThreadId && selectedThread
        ? this.cachedSnapshotForThread(
            remoteThreadId,
            selectedThread.hostId,
            selectedThread.executionGenerationId,
          )
        : undefined
      this.publish()
      return
    }
    if (!remoteThreadId) return

    const selectionGeneration = this.threadSelectionGeneration
    const snapshot = await this.call<unknown>('requestSnapshot', { threadId: remoteThreadId })
    if (
      connectionGeneration !== this.connectionGeneration ||
      selectionGeneration !== this.threadSelectionGeneration ||
      selectedThreadId !== this.selectedThreadId ||
      asString(asRecord(this.connection)?.phase) !== 'online' ||
      asString(asRecord(this.connection)?.hostId) !== authorityHostId
    ) {
      return
    }

    const incomingThreadId = asString(asRecord(asRecord(snapshot)?.thread)?.threadId)
    const currentSelectedThread = this.projection?.threads.find((thread) => thread.id === selectedThreadId)
    if (
      incomingThreadId !== remoteThreadId ||
      snapshotHostId(snapshot) !== authorityHostId ||
      !selectedThread.executionGenerationId ||
      currentSelectedThread?.hostId !== authorityHostId ||
      protocolThreadId(currentSelectedThread) !== remoteThreadId ||
      currentSelectedThread.executionGenerationId !== selectedThread.executionGenerationId ||
      snapshotExecutionGenerationId(snapshot) !== currentSelectedThread.executionGenerationId
    ) return
    if (!this.replaceSnapshotEntry(authorityHostId, snapshot)) return
    this.threadSnapshot = snapshot
    this.latestAuthoritativeMaterialization = {
      connectionGeneration,
      hostId: authorityHostId,
      threadId: remoteThreadId,
      executionGenerationId: currentSelectedThread.executionGenerationId,
    }
    this.publish()
  }

  private refreshFromAuthoritativeHost(): Promise<void> {
    const connectionGeneration = this.connectionGeneration
    if (
      this.authoritativeRefreshPromise &&
      this.authoritativeRefreshGeneration === connectionGeneration
    ) {
      return this.authoritativeRefreshPromise
    }

    const previous = this.authoritativeRefreshPromise
    const refresh = (async () => {
      if (previous) await previous.catch(() => undefined)
      await this.performAuthoritativeRefresh(connectionGeneration)
    })()
    this.authoritativeRefreshGeneration = connectionGeneration
    this.authoritativeRefreshPromise = refresh
    void refresh.then(
      () => {
        if (this.authoritativeRefreshPromise === refresh) {
          this.authoritativeRefreshPromise = undefined
          this.authoritativeRefreshGeneration = undefined
        }
      },
      () => {
        if (this.authoritativeRefreshPromise === refresh) {
          this.authoritativeRefreshPromise = undefined
          this.authoritativeRefreshGeneration = undefined
        }
      },
    )
    return refresh
  }

  private setResidentLifecycleProjectionState(
    status: ResidentLifecycleStatus,
    state: ResidentLifecycleOperationState,
  ): boolean {
    const identityKey = residentLifecycleMaterializationKey(status)
    if (state === 'terminal_refresh_pending') {
      this.pendingResidentMaterializations.delete(identityKey)
      this.pendingResidentMaterializations.add(identityKey)
      while (this.pendingResidentMaterializations.size > 128) {
        const oldest = this.pendingResidentMaterializations.values().next().value as string | undefined
        if (!oldest) break
        this.pendingResidentMaterializations.delete(oldest)
      }
    } else if (state === 'terminal') {
      this.pendingResidentMaterializations.delete(identityKey)
    }
    let changed = false
    this.residentLifecycleOperations = records(this.residentLifecycleOperations).map((entry) => {
      if (
        asString(entry.operationId) !== status.operationId ||
        asString(entry.expectedHostId) !== status.expectedHostId ||
        asString(entry.projectId) !== status.projectId ||
        asString(entry.workspaceId) !== status.workspaceId ||
        asString(entry.threadId) !== status.threadId ||
        asString(entry.executionGenerationId) !== status.executionGenerationId
      ) return entry
      changed = true
      return { ...entry, state, lastStatus: status }
    })
    if (changed) this.projectionRevision += 1
    return changed
  }

  private applyPendingResidentMaterializations(): void {
    this.residentLifecycleOperations = records(this.residentLifecycleOperations).map((entry) => {
      const parsedStatus = parseResidentLifecycleStatus(entry.lastStatus)
      return this.pendingResidentMaterializations.has(residentLifecycleMaterializationKey(entry)) &&
        residentLifecycleNeedsProjectionMaterialization(parsedStatus.success ? parsedStatus.data : undefined)
          ? { ...entry, state: 'terminal_refresh_pending' }
          : entry
    })
  }

  private projectedResidentThread(status: ResidentLifecycleStatus): ThreadSummary | undefined {
    return this.projection?.threads.find((thread) =>
      thread.hostId === status.expectedHostId &&
      protocolThreadId(thread) === status.threadId &&
      thread.executionGenerationId === status.executionGenerationId
    )
  }

  private async performCommittedResidentMaterialization(
    status: ResidentLifecycleStatus,
    authority: ResidentLifecycleAuthority,
  ): Promise<void> {
    this.assertResidentLifecycleAuthority(authority)
    const catalog = await this.call<unknown>('hostCatalog')
    this.assertResidentLifecycleAuthority(authority)
    if (!catalogHostIds(catalog).includes(authority.expectedHostId)) {
      throw new StaleHostAuthorityError()
    }
    const exactLineage = catalogGenerationLineages(catalog, authority.expectedHostId).get(status.threadId)
    if (exactLineage?.generationId !== status.executionGenerationId) {
      throw new Error(
        'The committed resident thread is not present in the authoritative catalog yet. Check its durable status and try again.',
      )
    }
    if (!this.replaceCatalogEntry(authority.expectedHostId, catalog)) {
      throw new Error(
        'The authoritative catalog could not safely materialize the committed resident thread. Check its durable status and try again.',
      )
    }
    this.publish()
    const projectedThread = this.projectedResidentThread(status)
    if (!projectedThread) {
      throw new Error(
        'The committed resident thread could not be selected from the authoritative catalog. Check its durable status and try again.',
      )
    }

    const selectionGeneration = this.threadSelectionGeneration
    const snapshot = await this.call<unknown>('requestSnapshot', { threadId: status.threadId })
    this.assertResidentLifecycleAuthority(authority)
    if (selectionGeneration !== this.threadSelectionGeneration) throw new StaleHostAuthorityError()
    const currentThread = this.projectedResidentThread(status)
    const snapshotLocation = asRecord(asRecord(asRecord(snapshot)?.thread)?.currentLocation)
    const endDisposition = parseResidentLifecycleDisposition(
      asRecord(snapshot)?.residentLifecycle,
    )
    if (
      !currentThread ||
      currentThread.id !== projectedThread.id ||
      snapshotThreadId(snapshot) !== status.threadId ||
      snapshotHostId(snapshot) !== status.expectedHostId ||
      snapshotExecutionGenerationId(snapshot) !== status.executionGenerationId ||
      asString(snapshotLocation?.projectId) !== status.projectId ||
      asString(snapshotLocation?.workspaceId) !== status.workspaceId ||
      (status.kind === 'end' && (
        !endDisposition.success ||
        endDisposition.data.operationId !== status.operationId ||
        asRecord(snapshot)?.runtime !== undefined ||
        asRecord(snapshot)?.inProgressStream !== undefined
      )) ||
      (status.kind === 'provision' && endDisposition.success)
    ) {
      throw new Error(
        'The host returned a snapshot that does not prove this exact resident lifecycle operation. Check its durable status before trying again.',
      )
    }

    let materializedSnapshot = snapshot
    if (!this.replaceSnapshotEntry(authority.expectedHostId, snapshot)) {
      const retained = this.projectionEntries[authority.expectedHostId]?.lastSnapshot
      if (
        snapshotThreadId(retained) !== status.threadId ||
        snapshotHostId(retained) !== status.expectedHostId ||
        snapshotExecutionGenerationId(retained) !== status.executionGenerationId
      ) {
        throw new Error(
          'The committed resident snapshot could not be materialized safely. Check its durable setup status before trying again.',
        )
      }
      materializedSnapshot = retained
    }
    this.assertResidentLifecycleAuthority(authority)
    if (selectionGeneration !== this.threadSelectionGeneration) throw new StaleHostAuthorityError()
    const finalThread = this.projectedResidentThread(status)
    if (!finalThread || finalThread.id !== projectedThread.id) throw new StaleHostAuthorityError()

    this.selectedThreadId = finalThread.id
    this.threadSelectionGeneration += 1
    this.threadSnapshot = materializedSnapshot
    this.setResidentLifecycleProjectionState(status, 'terminal')
    this.publish()
    this.assertResidentLifecycleAuthority(authority)
  }

  private forceCommittedResidentMaterialization(
    status: ResidentLifecycleStatus,
    authority: ResidentLifecycleAuthority,
  ): Promise<void> {
    this.assertResidentLifecycleAuthority(authority)
    if (this.setResidentLifecycleProjectionState(status, 'terminal_refresh_pending')) this.publish()
    const previous = this.authoritativeRefreshPromise
    const refresh = (async () => {
      // A refresh that started before the committed reply cannot prove the new
      // thread exists. Let it drain, fence its authority, then issue a distinct
      // catalog + exact-thread observation after the reply.
      if (previous) await previous.catch(() => undefined)
      this.assertResidentLifecycleAuthority(authority)
      await this.performCommittedResidentMaterialization(status, authority)
    })()
    this.authoritativeRefreshGeneration = authority.generation
    this.authoritativeRefreshPromise = refresh
    void refresh.finally(() => {
      if (this.authoritativeRefreshPromise === refresh) {
        this.authoritativeRefreshPromise = undefined
        this.authoritativeRefreshGeneration = undefined
      }
    }).catch(() => undefined)
    return refresh
  }

  private async reconcileInBackground(): Promise<void> {
    if (this.reconciliationStarted) return
    this.reconciliationStarted = true
    try {
      const connection = asRecord(this.connection)
      const phase = asString(connection?.phase)
      const existingTarget = asRecord(connection?.target)
      if (phase !== 'online') {
        if (this.options.allowConnectionInitiation === false) return
        // A cached SSH locator can only be activated by an explicit user
        // action carrying its previously verified immutable host ID. Generic
        // alias-bearing connect remains limited to first-time Add Computer.
        if (existingTarget?.kind === 'ssh') return
        const target = { kind: 'local' }
        const fence = this.beginConnectionReplyFence(target)
        const state = await this.call<unknown>('connect', target)
        if (!this.connectionReplyIsCurrent(fence, state)) return
        this.applyConnectionState(state)
      }

      await this.refreshFromAuthoritativeHost()
    } catch {
      // Cache remains the visible source of context. Native connection events
      // carry actionable structured errors without replacing the projection.
    }
  }

  async loadWorkbench(): Promise<WorkbenchSnapshot> {
    let bootstrap: UnknownRecord | undefined
    for (let retry = 0; retry < 16; retry += 1) {
      const loadConnectionGeneration = this.connectionGeneration
      const loadProjectionRevision = this.projectionRevision
      const candidate = asRecord(await this.call<unknown>('bootstrap'))
      if (
        loadConnectionGeneration === this.connectionGeneration &&
        loadProjectionRevision === this.projectionRevision
      ) {
        bootstrap = candidate
        break
      }
    }
    if (!bootstrap) {
      throw new StaleHostAuthorityError()
    }
    const cache = asRecord(bootstrap?.cache)
    const bootstrapConnection = asRecord(bootstrap?.connection)
    const connectionHostId = asString(bootstrapConnection?.hostId)
    const currentVerifiedHostId = asString(asRecord(this.connection)?.hostId)
    if (currentVerifiedHostId && connectionHostId && currentVerifiedHostId !== connectionHostId) {
      // A stable but older bootstrap can still describe the authority that was
      // superseded while its first read was in flight. Its outbox and cache are
      // scoped to that host and must not hydrate the newly verified authority.
      this.workbenchLoaded = true
      const currentProjection = this.updateProjection()
      const generation = this.connectionGeneration
      queueMicrotask(() => {
        void this.rehydrateAuthorityMutationState(currentVerifiedHostId, generation)
          .then(async () => await this.reconcileInBackground())
          .catch(() => undefined)
      })
      return currentProjection
    }
    const bootstrapEntries = projectionEntriesFromCache(cache)
    if (Object.keys(this.projectionEntries).length === 0) {
      this.projectionEntries = bootstrapEntries
      this.hydrateRetiredExecutionGenerations()
    } else {
      for (const [hostId, entry] of Object.entries(bootstrapEntries)) {
        for (const [threadId, generations] of Object.entries(entry.retiredExecutionGenerations ?? {})) {
          for (const generationId of generations) {
            if (!this.retireRendererExecutionGeneration(hostId, threadId, generationId)) {
              throw new StaleHostAuthorityError()
            }
          }
        }
        if (!this.projectionEntries[hostId]) {
          this.projectionEntries = { ...this.projectionEntries, [hostId]: entry }
          continue
        }
        if (entry.catalog !== undefined) this.replaceCatalogEntry(hostId, entry.catalog, entry.updatedAt)
        if (entry.lastSnapshot !== undefined) this.replaceSnapshotEntry(hostId, entry.lastSnapshot, entry.updatedAt)
      }
    }
    const connectionChanged = this.connectionKey(this.connection) !== this.connectionKey(bootstrap?.connection)
    this.connectionObservationRevision += 1
    this.connection = bootstrap?.connection
    if (connectionChanged) {
      this.connectionGeneration += 1
      this.projectionRevision += 1
    }
    this.rebuildCatalog()
    const preferredSnapshot = connectionHostId
      ? this.projectionEntries[connectionHostId]?.lastSnapshot
      : Object.values(this.projectionEntries)
          .sort((left, right) => (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0))[0]
          ?.lastSnapshot
    this.threadSnapshot = preferredSnapshot
    this.outbox = bootstrap?.outbox
    this.quarantinedOutboxCount = asNumber(bootstrap?.quarantinedOutboxCount) ?? 0
    this.durableUncertainReceipts = bootstrap?.durableUncertainReceipts
    this.residentLifecycleOperations = bootstrap?.residentLifecycleOperations
    this.applyPendingResidentMaterializations()
    this.hydrateComposerCommands(this.outbox)
    this.mutationAuthorityReadyHostId = connectionHostId
    this.cacheUpdatedAt = connectionHostId
      ? this.projectionEntries[connectionHostId]?.updatedAt
      : asString(cache?.updatedAt)
    const cachedProjection = this.updateProjection()
    this.selectedThreadId = cachedProjection.selectedThreadId || undefined
    this.workbenchLoaded = true
    queueMicrotask(() => void this.reconcileInBackground())
    return cachedProjection
  }

  async loadRuntimeModelCatalog(hostId: string): Promise<RuntimeModelCatalogSnapshot> {
    const generation = this.connectionGeneration
    const connection = asRecord(this.connection)
    const connectedHostId = asString(connection?.hostId)
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    if (connectedHostId !== hostId) throw new StaleHostAuthorityError()
    if (!capabilities.includes(RUNTIME_MODEL_CATALOG_CAPABILITY)) {
      throw new Error('The selected host has not advertised a verified Prime Agent model catalog.')
    }
    const raw = await this.call<unknown>('runtimeModelCatalog', { expectedHostId: hostId })
    if (
      generation !== this.connectionGeneration ||
      asString(asRecord(this.connection)?.hostId) !== hostId
    ) {
      throw new StaleHostAuthorityError()
    }
    const { RuntimeModelCatalogSnapshotSchema } = await loadProtocolSchemas()
    return RuntimeModelCatalogSnapshotSchema.parse(raw)
  }

  async openRuntimeProviderSetup(
    request: RuntimeProviderSetupRequest,
  ): Promise<RuntimeProviderSetupResult> {
    const generation = this.connectionGeneration
    const connection = asRecord(this.connection)
    const target = asRecord(connection?.target)
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    if (
      asString(connection?.hostId) !== request.hostId ||
      asString(connection?.phase) !== 'online' ||
      asString(connection?.path) !== 'local_socket' ||
      asString(target?.kind) !== 'local' ||
      !capabilities.includes(RUNTIME_MODEL_CATALOG_CAPABILITY) ||
      !capabilities.includes(RUNTIME_PROVIDER_SETUP_HANDOFF_CAPABILITY)
    ) {
      throw new StaleHostAuthorityError()
    }
    const raw = await this.call<unknown>('openRuntimeProviderSetup', {
      expectedHostId: request.hostId,
      providerId: request.providerId,
    })
    const { RuntimeProviderSetupResultSchema } = await loadProtocolSchemas()
    const result = RuntimeProviderSetupResultSchema.parse(raw)
    if (
      generation !== this.connectionGeneration ||
      asString(asRecord(this.connection)?.hostId) !== request.hostId ||
      result.expectedHostId !== request.hostId ||
      result.providerId !== request.providerId
    ) {
      throw new StaleHostAuthorityError()
    }
    switch (result.state) {
      case 'opened':
        return {
          state: 'opened',
          message: 'Prime Agent opened. Run /login, choose your provider, then return here.',
          retryable: false,
        }
      case 'failed_before_launch':
        return {
          state: 'failed_before_launch',
          message: 'Prime Agent could not be opened. No window was launched.',
          retryable: true,
        }
      case 'indeterminate':
        return {
          state: 'indeterminate',
          message: 'Prime Agent may already be open. Check your windows first; Prime Continuim won’t repeat this request.',
          retryable: false,
        }
    }
  }

  startRuntimeOAuth(
    request: RuntimeOAuthRequest,
    onProgress: (progress: RuntimeOAuthProgress) => void,
  ): Promise<RuntimeOAuthResult> {
    const frozenRequest = { ...request }
    const active = this.activeRuntimeOAuth
    if (active) {
      const currentBinding = this.currentRuntimeOAuthBindingKey(frozenRequest)
      if (currentBinding && active.bindingKey === currentBinding && active.result) return active.result
      return Promise.resolve({
        state: 'failed',
        retryable: true,
        message: 'Another Prime Agent sign-in is already active on this computer.',
      })
    }

    const authority = this.captureRuntimeOAuthAuthority(frozenRequest)
    const bindingKey = this.runtimeOAuthBindingKey(authority, frozenRequest.providerId)
    const tracked: ActiveRuntimeOAuth = {
      bindingKey,
      request: frozenRequest,
      authority,
      onProgress,
      cancelRequested: false,
    }
    const result = this.performRuntimeOAuth(tracked)
    tracked.result = result
    this.activeRuntimeOAuth = tracked
    const clear = (): void => {
      if (this.activeRuntimeOAuth === tracked) this.activeRuntimeOAuth = undefined
    }
    void result.then(clear, clear)
    return result
  }

  cancelRuntimeOAuth(request: RuntimeOAuthRequest): Promise<RuntimeOAuthResult | null> {
    const active = this.activeRuntimeOAuth
    if (
      !active ||
      active.request.hostId !== request.hostId ||
      active.request.providerId !== request.providerId
    ) return Promise.resolve(null)
    active.cancelRequested = true
    this.publishRuntimeOAuthProgress(active, {
      phase: 'cancelling',
      message: 'Cancelling ChatGPT sign-in…',
    })
    return active.result ?? Promise.resolve(null)
  }

  private runtimeOAuthBindingKey(authority: RuntimeOAuthAuthority, providerId: string): string {
    return canonicalRendererJson([
      authority.expectedHostId,
      authority.connectionGeneration,
      providerId,
    ])
  }

  private currentRuntimeOAuthBindingKey(request: RuntimeOAuthRequest): string | undefined {
    if (request.providerId !== PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID) return undefined
    const connection = asRecord(this.connection)
    const target = asRecord(connection?.target)
    const expectedHostId = asString(connection?.hostId)
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    if (
      !expectedHostId ||
      request.hostId !== expectedHostId ||
      !['online', 'degraded'].includes(asString(connection?.phase) ?? '') ||
      asString(target?.kind) !== 'local' ||
      asString(connection?.path) !== 'local_socket' ||
      this.mutationAuthorityReadyHostId !== expectedHostId ||
      !capabilities.includes(RUNTIME_OAUTH_ATTEMPT_CAPABILITY)
    ) return undefined
    return canonicalRendererJson([
      expectedHostId,
      this.connectionGeneration,
      request.providerId,
    ])
  }

  private captureRuntimeOAuthAuthority(request: RuntimeOAuthRequest): RuntimeOAuthAuthority {
    if (
      request.providerId !== PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID ||
      request.hostId.length < 1 ||
      request.hostId.length > 512 ||
      /[\0\r\n]/.test(request.hostId)
    ) throw new Error('Choose the ChatGPT OAuth provider reported by this Prime Agent runtime.')

    const projection = this.projection
    const connection = asRecord(this.connection)
    const target = asRecord(connection?.target)
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    const expectedHostId = request.hostId
    const selectedHost = projection?.hosts.find((candidate) => candidate.id === expectedHostId)
    if (
      !this.workbenchLoaded ||
      !projection ||
      projection.operations.runtimeOAuth !== true ||
      !expectedHostId ||
      selectedHost?.kind !== 'local' ||
      selectedHost.connection !== 'online' ||
      asString(connection?.phase) !== 'online' ||
      asString(connection?.hostId) !== expectedHostId ||
      asString(target?.kind) !== 'local' ||
      asString(connection?.path) !== 'local_socket' ||
      this.mutationAuthorityReadyHostId !== expectedHostId ||
      !capabilities.includes(RUNTIME_OAUTH_ATTEMPT_CAPABILITY) ||
      !capabilities.includes(RUNTIME_OAUTH_CAPABILITY) ||
      !capabilities.includes(RUNTIME_MODEL_CATALOG_CAPABILITY)
    ) throw new StaleHostAuthorityError()

    return {
      expectedHostId,
      connectionGeneration: this.connectionGeneration,
    }
  }

  private runtimeOAuthAuthorityIsCurrent(authority: RuntimeOAuthAuthority): boolean {
    const connection = asRecord(this.connection)
    const target = asRecord(connection?.target)
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    return Boolean(
      authority.connectionGeneration === this.connectionGeneration &&
      asString(connection?.phase) === 'online' &&
      asString(connection?.hostId) === authority.expectedHostId &&
      asString(target?.kind) === 'local' &&
      asString(connection?.path) === 'local_socket' &&
      this.mutationAuthorityReadyHostId === authority.expectedHostId &&
      capabilities.includes(RUNTIME_OAUTH_ATTEMPT_CAPABILITY)
    )
  }

  private publishRuntimeOAuthProgress(active: ActiveRuntimeOAuth, progress: RuntimeOAuthProgress): void {
    if (!this.runtimeOAuthAuthorityIsCurrent(active.authority)) return
    try {
      active.onProgress(progress)
    } catch {
      // A renderer callback cannot change the native OAuth operation outcome.
    }
  }

  private acceptRuntimeOAuthView(
    active: ActiveRuntimeOAuth,
    raw: unknown,
    expectedSessionId?: string,
  ): NativeRuntimeOAuthView {
    const view = runtimeOAuthViewFromNative(raw)
    if (
      view.providerId !== active.request.providerId ||
      (expectedSessionId !== undefined && view.sessionId !== expectedSessionId)
    ) {
      throw new Error('Prime Agent returned sign-in status for a different authorization session.')
    }
    return view
  }

  private runtimeOAuthIntermediateProgress(view: NativeRuntimeOAuthView): RuntimeOAuthProgress {
    if (view.phase === 'committing') {
      return { phase: 'committing', message: 'Saving the Prime Agent account on this computer…' }
    }
    if (view.phase === 'awaiting_user') {
      return view.interaction === 'browser'
        ? { phase: 'awaiting_user', message: 'Finish signing in in your browser. This window will update automatically.' }
        : { phase: 'awaiting_user', message: 'Prime Agent is waiting for sign-in to finish.' }
    }
    return { phase: 'starting', message: 'Opening the verified ChatGPT sign-in page…' }
  }

  private async terminalRuntimeOAuthResult(
    active: ActiveRuntimeOAuth,
    view: NativeRuntimeOAuthView,
  ): Promise<RuntimeOAuthResult | undefined> {
    if (view.phase === 'cancelled') {
      return { state: 'cancelled', message: 'ChatGPT sign-in was cancelled.' }
    }
    if (view.phase === 'failed') {
      return {
        state: 'failed',
        retryable: view.retryable,
        message: view.retryable
          ? 'Prime Agent could not complete ChatGPT sign-in. Check the browser flow, then try again.'
          : 'Prime Agent could not safely store this ChatGPT account on the selected computer.',
      }
    }
    if (view.phase !== 'completed') return undefined
    if (!view.configured) {
      return {
        state: 'failed',
        retryable: false,
        message: 'Prime Agent ended sign-in without confirming that the account was stored.',
      }
    }

    let catalog: RuntimeModelCatalog | undefined
    if (this.runtimeOAuthAuthorityIsCurrent(active.authority)) {
      try {
        const refreshed = await this.loadRuntimeModelCatalog(active.authority.expectedHostId)
        if (this.runtimeOAuthAuthorityIsCurrent(active.authority)) catalog = refreshed
      } catch {
        // Exact completion proof remains dominant over a later catalog refresh failure.
      }
    }
    return {
      state: 'completed',
      message: catalog
        ? 'ChatGPT is connected to Prime Agent and the model catalog is refreshed.'
        : 'ChatGPT is connected to Prime Agent. Reopen Models & accounts to refresh the catalog.',
      ...(catalog ? { catalog } : {}),
    }
  }

  private async cancelActiveRuntimeOAuth(active: ActiveRuntimeOAuth): Promise<RuntimeOAuthResult> {
    const sessionId = active.sessionId
    if (!sessionId || !this.runtimeOAuthAuthorityIsCurrent(active.authority)) {
      return {
        state: 'uncertain',
        retryable: false,
        message: 'Sign-in outcome is unknown. Prime Continuim did not repeat or replace the authorization request.',
      }
    }
    this.publishRuntimeOAuthProgress(active, {
      phase: 'cancelling',
      message: 'Cancelling ChatGPT sign-in…',
    })
    try {
      const raw = await this.call<unknown>('cancelRuntimeOAuth', {
        expectedHostId: active.authority.expectedHostId,
        sessionId,
      })
      if (!this.runtimeOAuthAuthorityIsCurrent(active.authority)) {
        return {
          state: 'uncertain',
          retryable: false,
          message: 'Sign-in outcome is unknown because the active computer changed during cancellation.',
        }
      }
      const view = this.acceptRuntimeOAuthView(active, raw, sessionId)
      const terminal = await this.terminalRuntimeOAuthResult(active, view)
      return terminal ?? {
        state: 'uncertain',
        retryable: false,
        message: 'Prime Agent did not confirm that sign-in was cancelled. Prime Continuim will not send another cancellation.',
      }
    } catch {
      return {
        state: 'uncertain',
        retryable: false,
        message: 'Prime Agent did not confirm that sign-in was cancelled. Prime Continuim will not send another cancellation.',
      }
    }
  }

  private async performRuntimeOAuth(active: ActiveRuntimeOAuth): Promise<RuntimeOAuthResult> {
    this.publishRuntimeOAuthProgress(active, {
      phase: 'starting',
      message: 'Opening the verified ChatGPT sign-in page…',
    })

    let view: NativeRuntimeOAuthView
    try {
      const raw = await this.call<unknown>('startRuntimeOAuth', {
        expectedHostId: active.authority.expectedHostId,
        providerId: active.request.providerId,
      })
      if (!this.runtimeOAuthAuthorityIsCurrent(active.authority)) {
        return {
          state: 'uncertain',
          retryable: false,
          message: 'Sign-in outcome is unknown because the active computer changed after authorization started.',
        }
      }
      view = this.acceptRuntimeOAuthView(active, raw)
      active.sessionId = view.sessionId
    } catch {
      return {
        state: 'uncertain',
        retryable: false,
        message: 'Prime Agent may have started sign-in, but its session could not be verified. Prime Continuim will not start it again automatically.',
      }
    }

    const expiresAt = Date.parse(view.expiresAt)
    const deadline = Math.min(expiresAt, Date.now() + RUNTIME_OAUTH_MAX_DURATION_MS)
    let polls = 0
    while (true) {
      const terminal = await this.terminalRuntimeOAuthResult(active, view)
      if (terminal) return terminal
      this.publishRuntimeOAuthProgress(active, this.runtimeOAuthIntermediateProgress(view))

      if (active.cancelRequested) return this.cancelActiveRuntimeOAuth(active)
      if (polls >= RUNTIME_OAUTH_MAX_POLLS || Date.now() >= deadline) {
        active.cancelRequested = true
        const cancellation = await this.cancelActiveRuntimeOAuth(active)
        return cancellation.state === 'cancelled'
          ? {
              state: 'failed',
              retryable: true,
              message: 'ChatGPT sign-in expired before it completed. Start a new sign-in when you are ready.',
            }
          : cancellation
      }

      await delay(RUNTIME_OAUTH_POLL_INTERVAL_MS)
      if (active.cancelRequested) return this.cancelActiveRuntimeOAuth(active)
      if (!this.runtimeOAuthAuthorityIsCurrent(active.authority)) {
        return {
          state: 'uncertain',
          retryable: false,
          message: 'Sign-in outcome is unknown because the active computer connection changed.',
        }
      }
      try {
        const raw = await this.call<unknown>('runtimeOAuthStatus', {
          expectedHostId: active.authority.expectedHostId,
          sessionId: active.sessionId,
        })
        if (!this.runtimeOAuthAuthorityIsCurrent(active.authority)) {
          return {
            state: 'uncertain',
            retryable: false,
            message: 'Sign-in outcome is unknown because the active computer connection changed.',
          }
        }
        view = this.acceptRuntimeOAuthView(active, raw, active.sessionId)
      } catch {
        return {
          state: 'uncertain',
          retryable: false,
          message: 'Prime Agent sign-in status could not be verified. Prime Continuim will not repeat the authorization request.',
        }
      }
      polls += 1
    }
  }

  selectResidentModel(request: ResidentModelSelectionRequest): Promise<ResidentModelSelectionResult> {
    const frozenRequest = { ...request }
    const active = this.activeResidentPreferenceSelection
    if (active) {
      if (
        active.kind === 'model' &&
        active.bindingKey === this.currentResidentModelSelectionBindingKey(frozenRequest)
      ) return active.result
      return Promise.resolve({
        state: 'rejected',
        retryable: true,
        message: active.kind === 'model'
          ? 'Another resident model change is already being verified. Try again after it finishes.'
          : 'Another resident session setting is already being verified. Try again after it finishes.',
      })
    }

    const authority = this.captureResidentModelSelectionAuthority(frozenRequest)
    const bindingKey = canonicalRendererJson([
      authority.expectedHostId,
      authority.remoteThreadId,
      authority.expectedExecutionGenerationId,
      frozenRequest.providerId,
      frozenRequest.modelId,
    ])
    const result = this.performResidentModelSelection(frozenRequest, authority)
    const tracked: ActiveResidentPreferenceSelection = { kind: 'model', bindingKey, result }
    this.activeResidentPreferenceSelection = tracked
    const clear = (): void => {
      if (this.activeResidentPreferenceSelection === tracked) this.activeResidentPreferenceSelection = undefined
    }
    void result.then(clear, clear)
    return result
  }

  selectResidentThinkingLevel(
    request: ResidentThinkingLevelSelectionRequest,
  ): Promise<ResidentThinkingLevelSelectionResult> {
    const frozenRequest = { ...request }
    const active = this.activeResidentPreferenceSelection
    if (active) {
      if (
        active.kind === 'thinking' &&
        active.bindingKey === this.currentResidentThinkingLevelSelectionBindingKey(frozenRequest)
      ) return active.result
      return Promise.resolve({
        state: 'rejected',
        retryable: true,
        message: 'Another resident session setting is already being verified. Try again after it finishes.',
      })
    }

    const authority = this.captureResidentThinkingLevelSelectionAuthority(frozenRequest)
    if (this.projection?.runtime.session?.thinkingLevel === frozenRequest.level) {
      return Promise.resolve({
        state: 'completed',
        projected: true,
        message: `Reasoning is already set to ${frozenRequest.level}.`,
      })
    }
    const bindingKey = canonicalRendererJson([
      authority.expectedHostId,
      authority.remoteThreadId,
      authority.expectedExecutionGenerationId,
      frozenRequest.level,
    ])
    const result = this.performResidentThinkingLevelSelection(frozenRequest, authority)
    const tracked: ActiveResidentPreferenceSelection = { kind: 'thinking', bindingKey, result }
    this.activeResidentPreferenceSelection = tracked
    const clear = (): void => {
      if (this.activeResidentPreferenceSelection === tracked) this.activeResidentPreferenceSelection = undefined
    }
    void result.then(clear, clear)
    return result
  }

  private currentResidentThinkingLevelSelectionBindingKey(
    request: ResidentThinkingLevelSelectionRequest,
  ): string | undefined {
    const thread = this.projection?.threads.find((candidate) => candidate.id === request.threadId)
    const expectedHostId = thread?.hostId
    const remoteThreadId = thread ? protocolThreadId(thread) : undefined
    const expectedExecutionGenerationId = thread?.executionGenerationId
    if (!expectedHostId || !remoteThreadId || !expectedExecutionGenerationId) return undefined
    return canonicalRendererJson([
      expectedHostId,
      remoteThreadId,
      expectedExecutionGenerationId,
      request.level,
    ])
  }

  private captureResidentThinkingLevelSelectionAuthority(
    request: ResidentThinkingLevelSelectionRequest,
  ): ResidentPreferenceSelectionAuthority {
    if (
      request.level.length < 1 ||
      request.level.length > 64 ||
      /[\0\r\n]/.test(request.level)
    ) throw new Error('Choose a reasoning level reported by this Prime Agent session.')

    const projection = this.projection
    const thread = projection?.threads.find((candidate) => candidate.id === request.threadId)
    const connection = asRecord(this.connection)
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    const expectedHostId = thread?.hostId
    const expectedExecutionGenerationId = thread?.executionGenerationId
    const remoteThreadId = thread ? protocolThreadId(thread) : undefined
    if (
      !this.workbenchLoaded ||
      !projection ||
      projection.selectedThreadId !== request.threadId ||
      projection.operations.startResidentTurn !== true ||
      projection.operations.selectResidentThinkingLevel !== true ||
      !projection.runtime.session?.availableThinkingLevels?.includes(request.level) ||
      !thread ||
      !expectedHostId ||
      !expectedExecutionGenerationId ||
      !remoteThreadId ||
      asString(connection?.phase) !== 'online' ||
      asString(connection?.hostId) !== expectedHostId ||
      this.mutationAuthorityReadyHostId !== expectedHostId ||
      !capabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY) ||
      !capabilities.includes(PRIME_AGENT_THINKING_LEVELS_CAPABILITY) ||
      snapshotHostId(this.threadSnapshot) !== expectedHostId ||
      snapshotThreadId(this.threadSnapshot) !== remoteThreadId ||
      snapshotExecutionGenerationId(this.threadSnapshot) !== expectedExecutionGenerationId
    ) throw new StaleHostAuthorityError()

    return {
      localThreadId: request.threadId,
      remoteThreadId,
      expectedHostId,
      expectedExecutionGenerationId,
      connectionGeneration: this.connectionGeneration,
    }
  }

  private residentThinkingLevelSelectionAuthorityIsCurrent(
    authority: ResidentPreferenceSelectionAuthority,
    level: string,
  ): boolean {
    const projection = this.projection
    const thread = projection?.threads.find((candidate) => candidate.id === authority.localThreadId)
    const connection = asRecord(this.connection)
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    return Boolean(
      projection &&
      authority.connectionGeneration === this.connectionGeneration &&
      projection.selectedThreadId === authority.localThreadId &&
      projection.operations.startResidentTurn === true &&
      projection.operations.selectResidentThinkingLevel === true &&
      projection.runtime.session?.availableThinkingLevels?.includes(level) &&
      thread?.hostId === authority.expectedHostId &&
      protocolThreadId(thread) === authority.remoteThreadId &&
      thread.executionGenerationId === authority.expectedExecutionGenerationId &&
      asString(connection?.phase) === 'online' &&
      asString(connection?.hostId) === authority.expectedHostId &&
      this.mutationAuthorityReadyHostId === authority.expectedHostId &&
      capabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY) &&
      capabilities.includes(PRIME_AGENT_THINKING_LEVELS_CAPABILITY) &&
      snapshotHostId(this.threadSnapshot) === authority.expectedHostId &&
      snapshotThreadId(this.threadSnapshot) === authority.remoteThreadId &&
      snapshotExecutionGenerationId(this.threadSnapshot) === authority.expectedExecutionGenerationId
    )
  }

  private currentResidentModelSelectionBindingKey(request: ResidentModelSelectionRequest): string | undefined {
    const thread = this.projection?.threads.find((candidate) => candidate.id === request.threadId)
    const expectedHostId = thread?.hostId
    const remoteThreadId = thread ? protocolThreadId(thread) : undefined
    const expectedExecutionGenerationId = thread?.executionGenerationId
    if (!expectedHostId || !remoteThreadId || !expectedExecutionGenerationId) return undefined
    return canonicalRendererJson([
      expectedHostId,
      remoteThreadId,
      expectedExecutionGenerationId,
      request.providerId,
      request.modelId,
    ])
  }

  private captureResidentModelSelectionAuthority(
    request: ResidentModelSelectionRequest,
  ): ResidentPreferenceSelectionAuthority {
    if (
      request.providerId.length < 1 ||
      request.providerId.length > 128 ||
      request.modelId.length < 1 ||
      request.modelId.length > 512 ||
      /[\0\r\n]/.test(request.providerId) ||
      /[\0\r\n]/.test(request.modelId)
    ) throw new Error('Choose a valid provider and model from the verified runtime catalog.')

    const projection = this.projection
    const thread = projection?.threads.find((candidate) => candidate.id === request.threadId)
    const connection = asRecord(this.connection)
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    const expectedHostId = thread?.hostId
    const expectedExecutionGenerationId = thread?.executionGenerationId
    const remoteThreadId = thread ? protocolThreadId(thread) : undefined
    if (
      !this.workbenchLoaded ||
      !projection ||
      projection.selectedThreadId !== request.threadId ||
      projection.operations.startResidentTurn !== true ||
      projection.operations.selectResidentModel !== true ||
      !thread ||
      !expectedHostId ||
      !expectedExecutionGenerationId ||
      !remoteThreadId ||
      asString(connection?.phase) !== 'online' ||
      asString(connection?.hostId) !== expectedHostId ||
      this.mutationAuthorityReadyHostId !== expectedHostId ||
      !capabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY) ||
      !capabilities.includes(RUNTIME_MODEL_CATALOG_CAPABILITY) ||
      snapshotHostId(this.threadSnapshot) !== expectedHostId ||
      snapshotThreadId(this.threadSnapshot) !== remoteThreadId ||
      snapshotExecutionGenerationId(this.threadSnapshot) !== expectedExecutionGenerationId
    ) throw new StaleHostAuthorityError()

    return {
      localThreadId: request.threadId,
      remoteThreadId,
      expectedHostId,
      expectedExecutionGenerationId,
      connectionGeneration: this.connectionGeneration,
    }
  }

  private residentModelSelectionAuthorityIsCurrent(authority: ResidentPreferenceSelectionAuthority): boolean {
    const projection = this.projection
    const thread = projection?.threads.find((candidate) => candidate.id === authority.localThreadId)
    const connection = asRecord(this.connection)
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    return Boolean(
      projection &&
      authority.connectionGeneration === this.connectionGeneration &&
      projection.selectedThreadId === authority.localThreadId &&
      projection.operations.startResidentTurn === true &&
      projection.operations.selectResidentModel === true &&
      thread?.hostId === authority.expectedHostId &&
      protocolThreadId(thread) === authority.remoteThreadId &&
      thread.executionGenerationId === authority.expectedExecutionGenerationId &&
      asString(connection?.phase) === 'online' &&
      asString(connection?.hostId) === authority.expectedHostId &&
      this.mutationAuthorityReadyHostId === authority.expectedHostId &&
      capabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY) &&
      capabilities.includes(RUNTIME_MODEL_CATALOG_CAPABILITY) &&
      snapshotHostId(this.threadSnapshot) === authority.expectedHostId &&
      snapshotThreadId(this.threadSnapshot) === authority.remoteThreadId &&
      snapshotExecutionGenerationId(this.threadSnapshot) === authority.expectedExecutionGenerationId
    )
  }

  private async performResidentThinkingLevelSelection(
    request: ResidentThinkingLevelSelectionRequest,
    authority: ResidentPreferenceSelectionAuthority,
  ): Promise<ResidentThinkingLevelSelectionResult> {
    const commandId = createStableId('command')
    const clientCommand = {
      deviceId: this.deviceId,
      commandId,
      expectedHostId: authority.expectedHostId,
      threadId: authority.remoteThreadId,
      kind: 'thinking.select',
      payload: { level: request.level },
      delivery: 'live_only',
      expectedExecutionGenerationId: authority.expectedExecutionGenerationId,
      issuedAt: this.nextComposerIssuedAt(authority.expectedHostId, authority.remoteThreadId),
    }

    let receipt: UnknownRecord | undefined
    try {
      receipt = asRecord(await this.call<unknown>('submitCommand', clientCommand))
    } catch (error) {
      return {
        state: 'uncertain',
        retryable: false,
        message: error instanceof Error
          ? `${error.message} Prime Continuim will not replay this reasoning change without terminal proof.`
          : 'Reasoning-change outcome unknown. Prime Continuim will not replay it without terminal proof.',
      }
    }

    if (
      !receipt ||
      asString(receipt.deviceId) !== this.deviceId ||
      asString(receipt.commandId) !== commandId ||
      asString(receipt.hostId) !== authority.expectedHostId ||
      asString(receipt.threadId) !== authority.remoteThreadId ||
      asString(receipt.executionGenerationId) !== authority.expectedExecutionGenerationId
    ) {
      return {
        state: 'uncertain',
        retryable: false,
        message: 'The host returned a receipt for another command authority. Prime Continuim will not replay this reasoning change.',
      }
    }

    const status = asString(receipt.status)
    const error = asRecord(receipt.error)
    const detail = asString(receipt.detail) ?? asString(receipt.message) ?? asString(error?.message)
    if (status === 'completed') {
      let projected = false
      if (this.residentThinkingLevelSelectionAuthorityIsCurrent(authority, request.level)) {
        try {
          projected = await this.refreshResidentThinkingLevelSelectionProjection(authority, request)
        } catch {
          projected = false
        }
      }
      return {
        state: 'completed',
        projected,
        message: projected
          ? detail ?? 'Prime Agent selected and verified this reasoning level.'
          : 'Prime Agent completed this reasoning change, but the current thread display has not refreshed yet.',
      }
    }
    if (status === 'rejected' || status === 'failed' || status === 'cancelled') {
      return {
        state: 'rejected',
        retryable: asBoolean(error?.retryable) ?? false,
        message: detail ?? 'Prime Agent rejected this reasoning change before completion.',
      }
    }
    return {
      state: 'uncertain',
      retryable: false,
      message: detail
        ? `${detail} Prime Continuim will not replay this reasoning change without terminal proof.`
        : 'Reasoning-change outcome unknown. Prime Continuim will not replay it without terminal proof.',
    }
  }

  private async refreshResidentThinkingLevelSelectionProjection(
    authority: ResidentPreferenceSelectionAuthority,
    request: ResidentThinkingLevelSelectionRequest,
  ): Promise<boolean> {
    let snapshot: unknown
    try {
      snapshot = await this.call<unknown>('requestSnapshot', { threadId: authority.remoteThreadId })
    } catch {
      if (!this.residentThinkingLevelSelectionAuthorityIsCurrent(authority, request.level)) {
        throw new StaleHostAuthorityError()
      }
      return false
    }
    if (!this.residentThinkingLevelSelectionAuthorityIsCurrent(authority, request.level)) {
      throw new StaleHostAuthorityError()
    }
    const runtime = asRecord(asRecord(snapshot)?.runtime)
    if (
      snapshotHostId(snapshot) !== authority.expectedHostId ||
      snapshotThreadId(snapshot) !== authority.remoteThreadId ||
      snapshotExecutionGenerationId(snapshot) !== authority.expectedExecutionGenerationId ||
      asString(runtime?.thinkingLevel) !== request.level
    ) return false

    if (this.replaceSnapshotEntry(authority.expectedHostId, snapshot)) {
      this.threadSnapshot = snapshot
      this.publish()
    }
    if (!this.residentThinkingLevelSelectionAuthorityIsCurrent(authority, request.level)) {
      throw new StaleHostAuthorityError()
    }
    return this.projection?.runtime.session?.thinkingLevel === request.level
  }

  private async performResidentModelSelection(
    request: ResidentModelSelectionRequest,
    authority: ResidentPreferenceSelectionAuthority,
  ): Promise<ResidentModelSelectionResult> {
    const commandId = createStableId('command')
    const clientCommand = {
      deviceId: this.deviceId,
      commandId,
      expectedHostId: authority.expectedHostId,
      threadId: authority.remoteThreadId,
      kind: 'model.select',
      payload: { providerId: request.providerId, modelId: request.modelId },
      delivery: 'live_only',
      expectedExecutionGenerationId: authority.expectedExecutionGenerationId,
      issuedAt: this.nextComposerIssuedAt(authority.expectedHostId, authority.remoteThreadId),
    }

    let receipt: UnknownRecord | undefined
    try {
      receipt = asRecord(await this.call<unknown>('submitCommand', clientCommand))
    } catch (error) {
      return {
        state: 'uncertain',
        retryable: false,
        message: error instanceof Error
          ? `${error.message} Prime Continuim will not replay this model change without terminal proof.`
          : 'Model-change outcome unknown. Prime Continuim will not replay it without terminal proof.',
      }
    }

    if (
      !receipt ||
      asString(receipt.deviceId) !== this.deviceId ||
      asString(receipt.commandId) !== commandId ||
      asString(receipt.hostId) !== authority.expectedHostId ||
      asString(receipt.threadId) !== authority.remoteThreadId ||
      asString(receipt.executionGenerationId) !== authority.expectedExecutionGenerationId
    ) {
      return {
        state: 'uncertain',
        retryable: false,
        message: 'The host returned a receipt for another command authority. Prime Continuim will not replay this model change.',
      }
    }

    const status = asString(receipt.status)
    const error = asRecord(receipt.error)
    const detail = asString(receipt.detail) ?? asString(receipt.message) ?? asString(error?.message)
    if (status === 'completed') {
      let projected = false
      if (this.residentModelSelectionAuthorityIsCurrent(authority)) {
        try {
          projected = await this.refreshResidentModelSelectionProjection(authority, request)
        } catch {
          // The exact terminal receipt is stronger proof than any later display-refresh failure.
          projected = false
        }
      }
      return {
        state: 'completed',
        projected,
        message: projected
          ? detail ?? 'Prime Agent selected and verified this model.'
          : 'Prime Agent completed this model change, but the current thread display has not refreshed yet.',
      }
    }
    if (status === 'rejected' || status === 'failed' || status === 'cancelled') {
      return {
        state: 'rejected',
        retryable: asBoolean(error?.retryable) ?? false,
        message: detail ?? 'Prime Agent rejected this model change before completion.',
      }
    }
    return {
      state: 'uncertain',
      retryable: false,
      message: detail
        ? `${detail} Prime Continuim will not replay this model change without terminal proof.`
        : 'Model-change outcome unknown. Prime Continuim will not replay it without terminal proof.',
    }
  }

  private async refreshResidentModelSelectionProjection(
    authority: ResidentPreferenceSelectionAuthority,
    request: ResidentModelSelectionRequest,
  ): Promise<boolean> {
    let snapshot: unknown
    try {
      snapshot = await this.call<unknown>('requestSnapshot', { threadId: authority.remoteThreadId })
    } catch {
      if (!this.residentModelSelectionAuthorityIsCurrent(authority)) throw new StaleHostAuthorityError()
      return false
    }
    if (!this.residentModelSelectionAuthorityIsCurrent(authority)) throw new StaleHostAuthorityError()
    const runtime = asRecord(asRecord(snapshot)?.runtime)
    if (
      snapshotHostId(snapshot) !== authority.expectedHostId ||
      snapshotThreadId(snapshot) !== authority.remoteThreadId ||
      snapshotExecutionGenerationId(snapshot) !== authority.expectedExecutionGenerationId ||
      asString(runtime?.model) !== `${request.providerId}/${request.modelId}`
    ) return false

    if (this.replaceSnapshotEntry(authority.expectedHostId, snapshot)) {
      this.threadSnapshot = snapshot
      this.publish()
    }
    if (!this.residentModelSelectionAuthorityIsCurrent(authority)) throw new StaleHostAuthorityError()
    return this.projection?.runtime.session?.model === `${request.providerId}/${request.modelId}`
  }

  async respondToResidentExtensionUi(
    request: ResidentExtensionUiRequest,
    response: ExtensionUiDialogResponse,
  ): Promise<ResidentExtensionUiResponseResult> {
    const { ExtensionUiDialogResponseSchema, ResidentExtensionUiRequestSchema } = await loadProtocolSchemas()
    const parsedRequest = ResidentExtensionUiRequestSchema.safeParse(request)
    const parsedResponse = ExtensionUiDialogResponseSchema.safeParse(response)
    if (!parsedRequest.success || !parsedResponse.success) {
      return {
        state: 'rejected',
        retryable: false,
        message: 'This Prime Agent question or response is no longer valid.',
      }
    }
    if (
      (parsedRequest.data.method === 'confirm' && parsedResponse.data.kind === 'value') ||
      (parsedRequest.data.method !== 'confirm' && parsedResponse.data.kind === 'confirmed')
    ) {
      return {
        state: 'rejected',
        retryable: false,
        message: 'This response does not match the Prime Agent question.',
      }
    }

    let authority: ResidentExtensionUiResponseAuthority
    try {
      authority = this.captureResidentExtensionUiResponseAuthority(parsedRequest.data)
    } catch {
      return {
        state: 'rejected',
        retryable: false,
        message: 'This Prime Agent question is no longer active on the selected session.',
      }
    }
    const attemptKey = canonicalRendererJson([
      authority.expectedHostId,
      authority.remoteThreadId,
      authority.expectedExecutionGenerationId,
      authority.bindingFingerprint,
      authority.requestId,
      authority.requestDigest,
      authority.method,
    ])
    const responseFingerprint = canonicalRendererJson(parsedResponse.data)
    const existing = this.residentExtensionUiResponseAttempts.get(attemptKey)
    if (existing) {
      return existing.responseFingerprint === responseFingerprint
        ? existing.promise
        : Promise.resolve({
            state: 'rejected',
            retryable: false,
            message: 'A different response is already being delivered for this Prime Agent question.',
          })
    }
    const attempt = this.performResidentExtensionUiResponse(
      parsedRequest.data,
      parsedResponse.data,
      authority,
    )
    const tracked = { responseFingerprint, promise: attempt }
    this.residentExtensionUiResponseAttempts.set(attemptKey, tracked)
    void attempt.then(() => {
      if (this.residentExtensionUiResponseAttempts.get(attemptKey) !== tracked) return
      this.residentExtensionUiResponseAttempts.delete(attemptKey)
    }, () => {
      if (this.residentExtensionUiResponseAttempts.get(attemptKey) === tracked) {
        this.residentExtensionUiResponseAttempts.delete(attemptKey)
      }
    })
    return attempt
  }

  private captureResidentExtensionUiResponseAuthority(
    request: ResidentExtensionUiRequest,
  ): ResidentExtensionUiResponseAuthority {
    const projection = this.projection
    const thread = projection?.threads.find((candidate) => candidate.id === projection.selectedThreadId)
    const remoteThreadId = thread ? protocolThreadId(thread) : undefined
    const connection = asRecord(this.connection)
    const residentControl = asRecord(asRecord(this.threadSnapshot)?.residentControl)
    const materialization = this.authoritativeMaterializationProof()
    const currentRequest = projection?.residentExtensionUiRequests?.find((candidate) =>
      candidate.requestId === request.requestId &&
      candidate.requestDigest === request.requestDigest &&
      candidate.method === request.method
    )
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    if (
      !this.workbenchLoaded ||
      !projection ||
      projection.snapshotAuthority?.source !== 'live' ||
      !thread ||
      !remoteThreadId ||
      !thread.executionGenerationId ||
      request.hostId !== thread.hostId ||
      request.threadId !== remoteThreadId ||
      request.executionGenerationId !== thread.executionGenerationId ||
      !currentRequest ||
      canonicalRendererJson(currentRequest) !== canonicalRendererJson(request) ||
      asString(connection?.phase) !== 'online' ||
      asString(connection?.hostId) !== thread.hostId ||
      this.mutationAuthorityReadyHostId !== thread.hostId ||
      !capabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY) ||
      !capabilities.includes(RESIDENT_EXTENSION_UI_CAPABILITY) ||
      !materialization ||
      materialization.connectionGeneration !== this.connectionGeneration ||
      materialization.hostId !== thread.hostId ||
      materialization.threadId !== remoteThreadId ||
      materialization.executionGenerationId !== thread.executionGenerationId ||
      asString(residentControl?.hostId) !== thread.hostId ||
      asString(residentControl?.threadId) !== remoteThreadId ||
      asString(residentControl?.executionGenerationId) !== thread.executionGenerationId ||
      asString(residentControl?.bindingFingerprint) !== request.bindingFingerprint ||
      asString(residentControl?.commandReadiness) !== 'ready'
    ) throw new StaleHostAuthorityError()

    return {
      localThreadId: thread.id,
      remoteThreadId,
      expectedHostId: thread.hostId,
      expectedExecutionGenerationId: thread.executionGenerationId,
      bindingFingerprint: request.bindingFingerprint,
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      method: request.method,
      connectionGeneration: this.connectionGeneration,
    }
  }

  private residentExtensionUiResponseAuthorityIsCurrent(
    authority: ResidentExtensionUiResponseAuthority,
  ): boolean {
    const projection = this.projection
    const thread = projection?.threads.find((candidate) => candidate.id === projection.selectedThreadId)
    const connection = asRecord(this.connection)
    const residentControl = asRecord(asRecord(this.threadSnapshot)?.residentControl)
    const materialization = this.authoritativeMaterializationProof()
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    return Boolean(
      projection &&
      projection.snapshotAuthority?.source === 'live' &&
      authority.connectionGeneration === this.connectionGeneration &&
      thread?.id === authority.localThreadId &&
      thread.hostId === authority.expectedHostId &&
      protocolThreadId(thread) === authority.remoteThreadId &&
      thread.executionGenerationId === authority.expectedExecutionGenerationId &&
      projection.residentExtensionUiRequests?.some((request) =>
        request.hostId === authority.expectedHostId &&
        request.threadId === authority.remoteThreadId &&
        request.executionGenerationId === authority.expectedExecutionGenerationId &&
        request.bindingFingerprint === authority.bindingFingerprint &&
        request.requestId === authority.requestId &&
        request.requestDigest === authority.requestDigest &&
        request.method === authority.method
      ) &&
      asString(connection?.phase) === 'online' &&
      asString(connection?.hostId) === authority.expectedHostId &&
      this.mutationAuthorityReadyHostId === authority.expectedHostId &&
      capabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY) &&
      capabilities.includes(RESIDENT_EXTENSION_UI_CAPABILITY) &&
      materialization?.connectionGeneration === authority.connectionGeneration &&
      materialization.hostId === authority.expectedHostId &&
      materialization.threadId === authority.remoteThreadId &&
      materialization.executionGenerationId === authority.expectedExecutionGenerationId &&
      asString(residentControl?.hostId) === authority.expectedHostId &&
      asString(residentControl?.threadId) === authority.remoteThreadId &&
      asString(residentControl?.executionGenerationId) === authority.expectedExecutionGenerationId &&
      asString(residentControl?.bindingFingerprint) === authority.bindingFingerprint &&
      asString(residentControl?.commandReadiness) === 'ready'
    )
  }

  private async performResidentExtensionUiResponse(
    request: ResidentExtensionUiRequest,
    response: ExtensionUiDialogResponse,
    authority: ResidentExtensionUiResponseAuthority,
  ): Promise<ResidentExtensionUiResponseResult> {
    if (!this.residentExtensionUiResponseAuthorityIsCurrent(authority)) {
      return {
        state: 'rejected',
        retryable: false,
        message: 'This Prime Agent question is no longer active on the selected session.',
      }
    }
    const commandId = createStableId('command')
    const clientCommand = {
      deviceId: this.deviceId,
      commandId,
      expectedHostId: authority.expectedHostId,
      threadId: authority.remoteThreadId,
      kind: 'extension_ui.respond',
      payload: {
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        method: request.method,
        response,
      },
      delivery: 'live_only',
      expectedExecutionGenerationId: authority.expectedExecutionGenerationId,
      issuedAt: this.nextComposerIssuedAt(authority.expectedHostId, authority.remoteThreadId),
    }
    let invoked = false
    let receipt: UnknownRecord | undefined
    try {
      receipt = asRecord(await this.callAtInvocationBoundary<unknown>(
        'submitCommand',
        clientCommand,
        () => { invoked = true },
      ))
    } catch (error) {
      if (!invoked) {
        return {
          state: 'rejected',
          retryable: true,
          message: error instanceof Error ? error.message : 'Prime Agent responses are unavailable in this build.',
        }
      }
      return {
        state: 'uncertain',
        retryable: false,
        message: error instanceof Error
          ? `${error.message} Prime Continuim will not send this response again.`
          : 'Response outcome unknown. Prime Continuim will not send it again.',
      }
    }
    if (
      !receipt ||
      asString(receipt.deviceId) !== this.deviceId ||
      asString(receipt.commandId) !== commandId ||
      asString(receipt.hostId) !== authority.expectedHostId ||
      asString(receipt.threadId) !== authority.remoteThreadId ||
      asString(receipt.executionGenerationId) !== authority.expectedExecutionGenerationId
    ) {
      return {
        state: 'uncertain',
        retryable: false,
        message: 'The host returned a receipt for another command authority. Prime Continuim will not send this response again.',
      }
    }
    const status = asString(receipt.status)
    const error = asRecord(receipt.error)
    const detail = asString(receipt.detail) ?? asString(receipt.message) ?? asString(error?.message)
    if (status === 'completed') {
      return { state: 'completed', message: detail ?? 'Response delivered to Prime Agent.' }
    }
    if (status === 'rejected' || status === 'failed' || status === 'cancelled') {
      return {
        state: 'rejected',
        retryable: false,
        message: detail ?? 'Prime Agent rejected this response.',
      }
    }
    return {
      state: 'uncertain',
      retryable: false,
      message: detail
        ? `${detail} Prime Continuim will not send this response again.`
        : 'Response outcome unknown. Prime Continuim will not send it again.',
    }
  }

  private residentLifecycleAuthority(options: {
    requireCapability: boolean
    expectedWorkspaceKind?: ResidentLifecycleWorkspaceKind
  }): ResidentLifecycleAuthority {
    const connection = asRecord(this.connection)
    const expectedHostId = asString(connection?.hostId)
    const phase = asString(connection?.phase)
    const target = asRecord(connection?.target)
    const targetKind = asString(target?.kind)
    const path = asString(connection?.path)
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    const connectionKind: ResidentLifecycleAuthority['connectionKind'] | undefined =
      targetKind === 'local' && path === 'local_socket'
        ? 'local'
        : targetKind === 'ssh' && path === 'ssh'
          ? 'ssh'
          : undefined
    const workspaceKind = options.expectedWorkspaceKind ??
      (connectionKind === 'local' ? 'local_path' : connectionKind === 'ssh' ? 'registered_workspace' : undefined)
    const requiredCapability = connectionKind === 'ssh'
      ? RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY
      : RESIDENT_LIFECYCLE_CAPABILITY
    if (
      !expectedHostId ||
      phase !== 'online' ||
      !connectionKind ||
      !workspaceKind ||
      (workspaceKind === 'local_path' && connectionKind !== 'local') ||
      this.mutationAuthorityReadyHostId !== expectedHostId ||
      (options.requireCapability && !capabilities.includes(requiredCapability))
    ) {
      throw new Error(options.requireCapability
        ? 'Resident lifecycle control is not ready on this verified host.'
        : 'Reconnect this verified host before checking resident lifecycle status.')
    }
    return {
      expectedHostId,
      generation: this.connectionGeneration,
      connectionKind,
      workspaceKind,
      capabilityRequired: options.requireCapability,
    }
  }

  private assertResidentLifecycleAuthority(authority: ResidentLifecycleAuthority): void {
    const connection = asRecord(this.connection)
    const targetKind = authority.connectionKind
    const path = authority.connectionKind === 'local' ? 'local_socket' : 'ssh'
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    const requiredCapability = authority.connectionKind === 'local'
      ? RESIDENT_LIFECYCLE_CAPABILITY
      : RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY
    if (
      authority.generation !== this.connectionGeneration ||
      asString(connection?.phase) !== 'online' ||
      asString(connection?.hostId) !== authority.expectedHostId ||
      this.mutationAuthorityReadyHostId !== authority.expectedHostId ||
      asString(asRecord(connection?.target)?.kind) !== targetKind ||
      asString(connection?.path) !== path ||
      (authority.capabilityRequired && !capabilities.includes(requiredCapability))
    ) throw new StaleHostAuthorityError()
  }

  private registeredWorkspaceReferenceIsCurrent(
    reference: ResidentWorkspaceReference,
    expectedHostId: string,
    operation: 'provisionResident' | 'endResident',
  ): boolean {
    const projection = this.projection ?? this.updateProjection()
    const thread = projection.threads.find((candidate) =>
      candidate.hostId === expectedHostId &&
      protocolThreadId(candidate) === reference.referenceThreadId &&
      candidate.executionGenerationId === reference.referenceExecutionGenerationId,
    )
    const project = projection.projects.find((candidate) => candidate.id === reference.projectId)
    return Boolean(
      projection.operations[operation] === true &&
      thread &&
      projection.selectedThreadId === thread.id &&
      projection.selectedProjectId === reference.projectId &&
      thread.projectId === reference.projectId &&
      thread.workspaceId === reference.workspaceId &&
      project?.hostIds.includes(expectedHostId) &&
      snapshotHostId(this.threadSnapshot) === expectedHostId &&
      snapshotThreadId(this.threadSnapshot) === reference.referenceThreadId &&
      snapshotExecutionGenerationId(this.threadSnapshot) === reference.referenceExecutionGenerationId,
    )
  }

  private registeredWorkspaceReferenceHasResidentAuthority(
    reference: ResidentWorkspaceReference,
    expectedHostId: string,
    exemptOperationId?: string,
  ): boolean {
    const projection = this.projection ?? this.updateProjection()
    const thread = projection.threads.find((candidate) =>
      candidate.hostId === expectedHostId &&
      protocolThreadId(candidate) === reference.referenceThreadId &&
      candidate.executionGenerationId === reference.referenceExecutionGenerationId,
    )
    return Boolean(
      thread &&
      (
        (
          projection.runtime.session?.residency === 'resident' &&
          thread.residentLifecycle?.state !== 'ended'
        ) ||
        projection.residentLifecycleOperations.some((operation) =>
          operation.operationId !== exemptOperationId &&
          operation.expectedHostId === expectedHostId &&
          operation.projectId === reference.projectId &&
          operation.workspaceId === reference.workspaceId &&
          registeredWorkspaceProvisionHoldsAuthority(
            operation,
            projection.residentLifecycleOperations,
            projection.threads,
          )
        )
      ),
    )
  }

  private residentProvisionResumeMode(
    operationId: string,
    expectedHostId: string,
    reference?: ResidentWorkspaceReference,
  ): ResidentProvisionResumeMode | undefined {
    const projection = this.projection ?? this.updateProjection()
    const operation = projection.residentLifecycleOperations.find((candidate) =>
      candidate.operationId === operationId &&
      candidate.expectedHostId === expectedHostId,
    )
    if (!operation) return 'main_validated'
    if (
      operation.kind !== 'provision' ||
      (reference
        ? operation.provisionMode !== 'registered_workspace' ||
          operation.projectId !== reference.projectId ||
          operation.workspaceId !== reference.workspaceId ||
          operation.referenceThreadId !== reference.referenceThreadId ||
          operation.referenceExecutionGenerationId !== reference.referenceExecutionGenerationId
        : operation.provisionMode === 'registered_workspace')
    ) return undefined
    // Only a genuinely missing renderer projection is deferred to the main
    // durable ledger. A visible operation with an unsafe phase is definitive
    // renderer evidence and must remain check-only.
    const mode = residentProvisionResumeMode(operation)
    return reference && operation.state === 'requires_reselection' ? undefined : mode
  }

  async preselectResidentWorkspace(): Promise<ResidentWorkspacePreselection> {
    const connection = asRecord(this.connection)
    const hostId = asString(connection?.hostId)
    const runtimeReadiness = asRecord(connection?.runtimeReadiness)
    const runtimeSnapshot = asRecord(runtimeReadiness?.snapshot)
    const phase = asString(runtimeSnapshot?.phase)
    const runtimeHasProgress = asString(runtimeReadiness?.kind) === 'reported' &&
      asString(runtimeReadiness?.hostId) === hostId &&
      asString(runtimeSnapshot?.status) === 'initializing' &&
      ['validating_seed', 'copying', 'verifying', 'publishing'].includes(phase ?? '')
    if (
      !hostId ||
      asString(connection?.phase) !== 'online' ||
      asString(asRecord(connection?.target)?.kind) !== 'local' ||
      asString(connection?.path) !== 'local_socket' ||
      !runtimeHasProgress
    ) {
      throw new Error('Workspace choice is available after verified runtime preparation starts.')
    }
    const generation = this.connectionGeneration
    const preselection = residentWorkspacePreselectionFromNative(
      await this.call<unknown>('preselectResidentWorkspace'),
    )
    const current = asRecord(this.connection)
    if (
      generation !== this.connectionGeneration ||
      !['online', 'degraded'].includes(asString(current?.phase) ?? '') ||
      asString(current?.hostId) !== hostId ||
      asString(asRecord(current?.target)?.kind) !== 'local' ||
      asString(current?.path) !== 'local_socket' ||
      Date.parse(preselection.expiresAt) <= Date.now()
    ) throw new StaleHostAuthorityError()
    this.residentWorkspacePreselections.clear()
    this.residentWorkspacePreselections.set(preselection.preselectionToken, {
      preselection,
      expectedHostId: hostId,
      connectionGeneration: generation,
    })
    return { ...preselection }
  }

  async completeResidentWorkspacePreselection(
    preselectionToken: string,
  ): Promise<ResidentWorkspaceSelection> {
    const retained = this.residentWorkspacePreselections.get(preselectionToken)
    if (!retained || Date.parse(retained.preselection.expiresAt) <= Date.now()) {
      this.residentWorkspacePreselections.delete(preselectionToken)
      throw new Error('Choose the workspace folder again before continuing.')
    }
    const authority = this.residentLifecycleAuthority({
      requireCapability: true,
      expectedWorkspaceKind: 'local_path',
    })
    if (
      authority.expectedHostId !== retained.expectedHostId ||
      authority.generation !== retained.connectionGeneration
    ) throw new StaleHostAuthorityError()

    // Main consumes this token at the invocation boundary. Drop the renderer
    // copy first so a rejected or interrupted reply is never replayed.
    this.residentWorkspacePreselections.delete(preselectionToken)
    const nativeSelection = residentWorkspaceSelectionFromNative(
      await this.call<unknown>('completeResidentWorkspacePreselection', { preselectionToken }),
    )
    this.assertResidentLifecycleAuthority(authority)
    if (
      nativeSelection.expectedHostId !== authority.expectedHostId ||
      Date.parse(nativeSelection.expiresAt) <= Date.now()
    ) throw new StaleHostAuthorityError()
    const selection: ResidentWorkspaceSelection = { ...nativeSelection, kind: 'local_path' }
    this.residentWorkspaceSelections.set(selection.selectionToken, {
      selection,
      connectionGeneration: authority.generation,
    })
    return { ...selection }
  }

  async cancelResidentWorkspacePreselection(preselectionToken: string): Promise<void> {
    this.residentWorkspacePreselections.delete(preselectionToken)
    await this.call<void>('cancelResidentWorkspacePreselection', { preselectionToken })
  }

  async selectResidentWorkspace(
    input: ResidentWorkspaceSelectionInput = {},
  ): Promise<ResidentWorkspaceSelection> {
    const requestedWorkspaceKind = input.kind ?? 'local_path'
    const authority = this.residentLifecycleAuthority({
      requireCapability: true,
      expectedWorkspaceKind: requestedWorkspaceKind,
    })
    const reference = input.kind === 'registered_workspace'
      ? {
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          referenceThreadId: input.referenceThreadId,
          referenceExecutionGenerationId: input.referenceExecutionGenerationId,
        }
      : undefined
    const resumeMode = input.resumeOperationId
      ? this.residentProvisionResumeMode(input.resumeOperationId, authority.expectedHostId, reference)
      : undefined
    if (input.resumeOperationId && !resumeMode) throw new StaleHostAuthorityError()
    if (reference) {
      if (
        !this.registeredWorkspaceReferenceIsCurrent(reference, authority.expectedHostId, 'provisionResident') ||
        (input.resumeOperationId
          ? this.registeredWorkspaceReferenceHasResidentAuthority(
              reference,
              authority.expectedHostId,
              input.resumeOperationId,
            )
          : this.registeredWorkspaceReferenceHasResidentAuthority(reference, authority.expectedHostId))
      ) throw new StaleHostAuthorityError()
    }
    if (!reference && (this.projection ?? this.updateProjection()).operations.provisionResident !== true) {
      throw new Error('Resident lifecycle control is not ready on this verified host.')
    }
    const nativeSelection = residentWorkspaceSelectionFromNative(
      await this.call<unknown>('selectResidentWorkspace', input),
    )
    this.assertResidentLifecycleAuthority(authority)
    const postSelectionResumeMode = input.resumeOperationId
      ? this.residentProvisionResumeMode(input.resumeOperationId, authority.expectedHostId, reference)
      : undefined
    if (
      nativeSelection.expectedHostId !== authority.expectedHostId ||
      (input.resumeOperationId && !postSelectionResumeMode) ||
      (resumeMode !== 'main_validated' && postSelectionResumeMode !== resumeMode) ||
      (postSelectionResumeMode === 'continue' && nativeSelection.operationId !== input.resumeOperationId) ||
      (postSelectionResumeMode === 'retry' && nativeSelection.operationId === input.resumeOperationId) ||
      Date.parse(nativeSelection.expiresAt) <= Date.now() ||
      (reference && (
        !this.registeredWorkspaceReferenceIsCurrent(reference, authority.expectedHostId, 'provisionResident') ||
        (input.resumeOperationId
          ? this.registeredWorkspaceReferenceHasResidentAuthority(
              reference,
              authority.expectedHostId,
              input.resumeOperationId,
            )
          : this.registeredWorkspaceReferenceHasResidentAuthority(reference, authority.expectedHostId))
      ))
    ) {
      throw new StaleHostAuthorityError()
    }
    const selection: ResidentWorkspaceSelection = reference
      ? { ...nativeSelection, kind: 'registered_workspace', ...reference }
      : { ...nativeSelection, kind: 'local_path' }
    for (const [token, retained] of this.residentWorkspaceSelections) {
      if (Date.parse(retained.selection.expiresAt) <= Date.now()) this.residentWorkspaceSelections.delete(token)
    }
    if (this.residentWorkspaceSelections.size >= 32) {
      const oldestToken = [...this.residentWorkspaceSelections.entries()]
        .sort((left, right) =>
          Date.parse(left[1].selection.expiresAt) - Date.parse(right[1].selection.expiresAt)
        )[0]?.[0]
      if (oldestToken) this.residentWorkspaceSelections.delete(oldestToken)
    }
    this.residentWorkspaceSelections.set(selection.selectionToken, {
      selection,
      connectionGeneration: authority.generation,
    })
    return { ...selection }
  }

  async provisionResident(input: {
    selectionToken: string
    projectDisplayName: string
    threadTitle: string
    sessionName?: string
  }): Promise<ResidentLifecycleStatus> {
    let mainInvocationStarted = false
    try {
    const retained = this.residentWorkspaceSelections.get(input.selectionToken)
    const expectedWorkspaceKind = retained?.selection.kind === 'registered_workspace'
      ? 'registered_workspace'
      : this.consumedRegisteredWorkspaceSelectionTokens.has(input.selectionToken)
        ? 'registered_workspace'
        : 'local_path'
    const authority = this.residentLifecycleAuthority({ requireCapability: true, expectedWorkspaceKind })
    const selection = retained?.selection
    const reference = selection?.kind === 'registered_workspace'
      ? {
          projectId: selection.projectId,
          workspaceId: selection.workspaceId,
          referenceThreadId: selection.referenceThreadId,
          referenceExecutionGenerationId: selection.referenceExecutionGenerationId,
        }
      : undefined
    if (
      !selection ||
      selection.expectedHostId !== authority.expectedHostId ||
      retained?.connectionGeneration !== authority.generation ||
      (reference && !this.registeredWorkspaceReferenceIsCurrent(reference, authority.expectedHostId, 'provisionResident')) ||
      Date.parse(selection.expiresAt) <= Date.now()
    ) throw new Error(expectedWorkspaceKind === 'registered_workspace'
      ? 'Select this saved workspace again before starting the resident thread.'
      : 'Choose the workspace folder again before starting this resident thread.')

    // The main process consumes this receipt at the invocation boundary. Drop
    // the renderer copy first so no UI retry can replay an ambiguous mutation.
    this.residentWorkspaceSelections.delete(input.selectionToken)
    if (selection.kind === 'registered_workspace') {
      this.consumedRegisteredWorkspaceSelectionTokens.add(input.selectionToken)
      if (this.consumedRegisteredWorkspaceSelectionTokens.size > 32) {
        const oldestToken = this.consumedRegisteredWorkspaceSelectionTokens.values().next().value
        if (oldestToken) this.consumedRegisteredWorkspaceSelectionTokens.delete(oldestToken)
      }
    }
    let status: ResidentLifecycleStatus | undefined
    let statusAccepted = false
    try {
      status = requireResidentLifecycleStatus(
        await this.callAtInvocationBoundary<unknown>(
          'provisionResident',
          selection.kind === 'registered_workspace'
            ? { ...input, projectDisplayName: selection.suggestedName }
            : input,
          () => { mainInvocationStarted = true },
        ),
      )
      this.assertResidentLifecycleAuthority(authority)
      if (
        status.operationId !== selection.operationId ||
        status.expectedHostId !== authority.expectedHostId ||
        status.kind !== 'provision'
      ) throw new StaleHostAuthorityError()
      statusAccepted = true
    } finally {
      // Main persists an exact path-free recovery entry before an ambiguous
      // outcome is returned. Rehydrate it even on error so the same open app
      // cannot lose the only safe recovery route or invent a new operation.
      if (
        authority.generation === this.connectionGeneration &&
        asString(asRecord(this.connection)?.hostId) === authority.expectedHostId
      ) {
        const hydration = this.rehydrateAuthorityMutationState(
          authority.expectedHostId,
          authority.generation,
        )
        if (statusAccepted && status?.phase === 'committed') await hydration
        else await hydration.catch(() => undefined)
      }
    }
    if (!status) throw new Error('The native resident provision response was unavailable.')
    this.assertResidentLifecycleAuthority(authority)
    if (status.phase === 'committed') {
      await this.forceCommittedResidentMaterialization(status, authority)
    }
    this.assertResidentLifecycleAuthority(authority)
    return status
    } catch (error) {
      throw residentProvisionErrorFrom(error, mainInvocationStarted)
    }
  }

  async prepareResidentEnd(input: {
    expectedHostId: string
    projectId: string
    workspaceId: string
    threadId: string
    executionGenerationId: string
    resumeOperationId?: string
  }): Promise<ResidentEndPreparation> {
    const authority = this.residentLifecycleAuthority({ requireCapability: true })
    if (input.expectedHostId !== authority.expectedHostId) throw new StaleHostAuthorityError()
    const projection = this.projection ?? this.updateProjection()
    const exactEndOperation = projection.residentLifecycleOperations.find((operation) =>
      operation.kind === 'end' &&
      operation.expectedHostId === input.expectedHostId &&
      operation.projectId === input.projectId &&
      operation.workspaceId === input.workspaceId &&
      operation.threadId === input.threadId &&
      operation.executionGenerationId === input.executionGenerationId,
    )
    if (input.resumeOperationId) {
      const resumeIsPreDispatch = Boolean(
        exactEndOperation?.lastStatus?.kind === 'end' &&
        exactEndOperation.lastStatus.phase === 'ending',
      )
      const resumeIsMissingStatus = Boolean(
        exactEndOperation?.state === 'outcome_unknown' &&
        exactEndOperation.lastStatus === undefined,
      )
      if (
        exactEndOperation?.operationId !== input.resumeOperationId ||
        (!resumeIsPreDispatch && !resumeIsMissingStatus)
      ) throw new StaleHostAuthorityError()
    } else if (exactEndOperation) {
      throw new Error('Review the existing resident end operation before starting another one.')
    }
    const reference: ResidentWorkspaceReference = {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      referenceThreadId: input.threadId,
      referenceExecutionGenerationId: input.executionGenerationId,
    }
    if (authority.workspaceKind === 'registered_workspace') {
      if (!this.registeredWorkspaceReferenceIsCurrent(reference, authority.expectedHostId, 'endResident')) {
        throw new StaleHostAuthorityError()
      }
    } else if ((this.projection ?? this.updateProjection()).operations.endResident !== true) {
      throw new Error('Resident lifecycle control is not ready on this verified host.')
    }
    const preparation = residentEndPreparationFromNative(
      await this.call<unknown>('prepareResidentEnd', input),
    )
    this.assertResidentLifecycleAuthority(authority)
    if (
      preparation.expectedHostId !== authority.expectedHostId ||
      preparation.threadId !== input.threadId ||
      preparation.executionGenerationId !== input.executionGenerationId ||
      (input.resumeOperationId && preparation.operationId !== input.resumeOperationId) ||
      Date.parse(preparation.expiresAt) <= Date.now() ||
      (authority.workspaceKind === 'registered_workspace' &&
        !this.registeredWorkspaceReferenceIsCurrent(reference, authority.expectedHostId, 'endResident'))
    ) throw new StaleHostAuthorityError()
    this.residentEndPreparations.clear()
    this.residentEndPreparations.set(preparation.confirmationToken, {
      preparation,
      connectionGeneration: authority.generation,
      workspaceKind: authority.workspaceKind,
      ...(authority.workspaceKind === 'registered_workspace' ? { reference } : {}),
    })
    return { ...preparation }
  }

  async endResident(input: { confirmationToken: string; consent: true }): Promise<ResidentLifecycleStatus> {
    const retained = this.residentEndPreparations.get(input.confirmationToken)
    const authority = this.residentLifecycleAuthority({
      requireCapability: true,
      ...(retained ? { expectedWorkspaceKind: retained.workspaceKind } : {}),
    })
    const preparation = retained?.preparation
    if (
      !preparation ||
      preparation.expectedHostId !== authority.expectedHostId ||
      retained?.connectionGeneration !== authority.generation ||
      (retained.reference &&
        !this.registeredWorkspaceReferenceIsCurrent(retained.reference, authority.expectedHostId, 'endResident')) ||
      Date.parse(preparation.expiresAt) <= Date.now()
    ) throw new Error('Review this resident session again before ending it.')

    // Both renderer and main consume the authorization before the mutation
    // boundary. An ambiguous response can only be reconciled by operation ID.
    this.residentEndPreparations.delete(input.confirmationToken)
    let status: ResidentLifecycleStatus | undefined
    let statusAccepted = false
    try {
      status = requireResidentLifecycleStatus(
        await this.call<unknown>('endResident', input),
      )
      this.assertResidentLifecycleAuthority(authority)
      if (
        status.kind !== 'end' ||
        status.operationId !== preparation.operationId ||
        status.expectedHostId !== authority.expectedHostId ||
        status.threadId !== preparation.threadId ||
        status.executionGenerationId !== preparation.executionGenerationId
      ) throw new StaleHostAuthorityError()
      statusAccepted = true
    } finally {
      if (
        authority.generation === this.connectionGeneration &&
        asString(asRecord(this.connection)?.hostId) === authority.expectedHostId
      ) {
        const hydration = this.rehydrateAuthorityMutationState(
          authority.expectedHostId,
          authority.generation,
        )
        if (statusAccepted && status?.phase === 'completed') await hydration
        else await hydration.catch(() => undefined)
      }
    }
    if (!status) throw new Error('The native resident end response was unavailable.')
    this.assertResidentLifecycleAuthority(authority)
    if (status.phase === 'completed') {
      await this.forceCommittedResidentMaterialization(status, authority)
    }
    this.assertResidentLifecycleAuthority(authority)
    return status
  }

  async residentLifecycleStatus(input: {
    expectedHostId: string
    operationId: string
  }): Promise<ResidentLifecycleStatus | null> {
    const authority = this.residentLifecycleAuthority({ requireCapability: false })
    if (input.expectedHostId !== authority.expectedHostId) throw new StaleHostAuthorityError()
    const result = parseResidentLifecycleLookupResult(
      await this.call<unknown>('residentLifecycleStatus', input),
    )
    this.assertResidentLifecycleAuthority(authority)
    if (
      result.status &&
      (result.status.expectedHostId !== authority.expectedHostId || result.status.operationId !== input.operationId)
    ) throw new StaleHostAuthorityError()

    const hydration = this.rehydrateAuthorityMutationState(
      authority.expectedHostId,
      authority.generation,
    )
    if (residentLifecycleNeedsProjectionMaterialization(result.status)) await hydration
    else await hydration.catch(() => undefined)
    this.assertResidentLifecycleAuthority(authority)
    if (residentLifecycleNeedsProjectionMaterialization(result.status)) {
      await this.forceCommittedResidentMaterialization(result.status, authority)
    }
    this.assertResidentLifecycleAuthority(authority)
    return result.status
  }

  subscribe(listener: (snapshot: WorkbenchSnapshot) => void): () => void {
    this.listeners.add(listener)
    this.startNativeSubscriptions()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.nativeSubscriptionsStarted) {
        this.nativeUnsubscribers.forEach((unsubscribe) => unsubscribe())
        this.nativeUnsubscribers = []
        this.nativeSubscriptionsStarted = false
      }
    }
  }

  async retryLocalSetup(): Promise<void> {
    const current = this.projection ?? this.updateProjection()
    const issue = current.localSetup?.issue
    if (
      current.localSetup?.stage !== 'needs_attention' ||
      !issue?.retryable
    ) {
      throw new Error('The current local setup state does not allow a retry.')
    }
    if (issue.action === 'retry_runtime') {
      const connection = asRecord(this.connection)
      const expectedHostId = asString(connection?.hostId)
      const targetKind = asString(asRecord(connection?.target)?.kind)
      const path = asString(connection?.path)
      const phase = asString(connection?.phase)
      const capabilities = Array.isArray(connection?.capabilities)
        ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
        : []
      const readiness = asRecord(connection?.runtimeReadiness)
      const { RuntimeIntegritySnapshotSchema } = await loadProtocolSchemas()
      const previousSnapshot = RuntimeIntegritySnapshotSchema.safeParse(readiness?.snapshot)
      if (
        !expectedHostId ||
        (phase !== 'online' && phase !== 'degraded') ||
        targetKind !== 'local' ||
        path !== 'local_socket' ||
        !capabilities.includes(RUNTIME_INTEGRITY_RETRY_CAPABILITY) ||
        asString(readiness?.hostId) !== expectedHostId ||
        !previousSnapshot.success ||
        previousSnapshot.data.status !== 'failed' ||
        !previousSnapshot.data.retryable
      ) {
        throw new StaleHostAuthorityError()
      }
      const generation = this.connectionGeneration
      const observationRevision = this.connectionObservationRevision
      const result = RuntimeIntegritySnapshotSchema.parse(
        await this.call<unknown>('retryRuntimeIntegrity', { expectedHostId }),
      )
      const latestConnection = asRecord(this.connection)
      if (
        generation !== this.connectionGeneration ||
        asString(latestConnection?.hostId) !== expectedHostId ||
        asString(asRecord(latestConnection?.target)?.kind) !== 'local' ||
        asString(latestConnection?.path) !== 'local_socket'
      ) {
        throw new StaleHostAuthorityError()
      }
      if (
        result.status !== 'initializing' ||
        !sameRuntimeIntegrityLineage(previousSnapshot.data, result)
      ) {
        throw new Error('The native runtime retry returned an invalid verification state.')
      }
      // A native connection event outranks the bridge reply. Applying the
      // response only when no newer observation arrived keeps a fast ready
      // transition from being overwritten by this earlier initializing state.
      if (observationRevision !== this.connectionObservationRevision) return
      const latestCapabilities = Array.isArray(latestConnection?.capabilities)
        ? latestConnection.capabilities.filter((capability): capability is string => typeof capability === 'string')
        : []
      this.applyConnectionState({
        ...latestConnection,
        capabilities: latestCapabilities.filter(
          (capability) => capability !== RUNTIME_INTEGRITY_RETRY_CAPABILITY,
        ),
        runtimeReadiness: {
          ...readiness,
          observedAt: result.changedAt,
          snapshot: result,
        },
      })
      return
    }
    if (issue.action !== 'retry_connection') {
      throw new Error('The current local setup state does not allow a connection retry.')
    }
    const targetKind = asString(asRecord(asRecord(this.connection)?.target)?.kind)
    if (targetKind && targetKind !== 'local') throw new StaleHostAuthorityError()
    const target = { kind: 'local' }
    const fence = this.beginConnectionReplyFence(target)
    const state = await this.call<unknown>('connect', target)
    if (!this.connectionReplyIsCurrent(fence, state)) return
    this.applyConnectionState(state)
  }

  async repairLocalRuntime(): Promise<void> {
    const current = this.projection ?? this.updateProjection()
    const issue = current.localSetup?.issue
    if (
      current.localSetup?.stage !== 'needs_attention' ||
      issue?.action !== 'repair_runtime' ||
      issue.retryable
    ) {
      throw new Error('The current local setup state does not allow runtime repair.')
    }
    const connection = asRecord(this.connection)
    const expectedHostId = asString(connection?.hostId)
    const targetKind = asString(asRecord(connection?.target)?.kind)
    const path = asString(connection?.path)
    const phase = asString(connection?.phase)
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    const readiness = asRecord(connection?.runtimeReadiness)
    const { RuntimeIntegritySnapshotSchema } = await loadProtocolSchemas()
    const previousSnapshot = RuntimeIntegritySnapshotSchema.safeParse(readiness?.snapshot)
    if (
      !expectedHostId ||
      (phase !== 'online' && phase !== 'degraded') ||
      targetKind !== 'local' ||
      path !== 'local_socket' ||
      !capabilities.includes(RUNTIME_INTEGRITY_REPAIR_CAPABILITY) ||
      asString(readiness?.hostId) !== expectedHostId ||
      !previousSnapshot.success ||
      previousSnapshot.data.status !== 'failed' ||
      previousSnapshot.data.retryable ||
      previousSnapshot.data.recoveryAction !== 'repair_application'
    ) {
      throw new StaleHostAuthorityError()
    }

    const failedSnapshot = previousSnapshot.data
    const generation = this.connectionGeneration
    const observationRevision = this.connectionObservationRevision
    const result = RuntimeIntegritySnapshotSchema.parse(
      await this.call<unknown>('repairRuntimeIntegrity', {
        expectedHostId,
        expectedTrustAnchorId: failedSnapshot.trustAnchorId,
        expectedTarget: failedSnapshot.target,
        expectedChangedAt: failedSnapshot.changedAt,
      }),
    )
    const latestConnection = asRecord(this.connection)
    if (
      generation !== this.connectionGeneration ||
      asString(latestConnection?.hostId) !== expectedHostId ||
      asString(asRecord(latestConnection?.target)?.kind) !== 'local' ||
      asString(latestConnection?.path) !== 'local_socket'
    ) {
      throw new StaleHostAuthorityError()
    }
    if (result.status !== 'initializing' || !sameRuntimeIntegrityLineage(failedSnapshot, result)) {
      throw new Error('The native runtime repair returned an invalid verification state.')
    }
    // A newer native connection event is authoritative over this earlier
    // initializing reply, including a repair that already reached ready.
    if (observationRevision !== this.connectionObservationRevision) return
    const latestCapabilities = Array.isArray(latestConnection?.capabilities)
      ? latestConnection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    this.applyConnectionState({
      ...latestConnection,
      capabilities: latestCapabilities.filter(
        (capability) => capability !== RUNTIME_INTEGRITY_REPAIR_CAPABILITY,
      ),
      runtimeReadiness: {
        ...readiness,
        observedAt: result.changedAt,
        snapshot: result,
      },
    })
  }

  async selectThread(threadId: string): Promise<void> {
    if (!threadId) throw new Error('Choose a thread before requesting its snapshot.')
    this.userThreadSelectionRevision += 1
    const previousThreadId = this.selectedThreadId
    const previousSnapshot = this.threadSnapshot
    const selectionConnectionGeneration = this.connectionGeneration
    const selectedThread = this.projection?.threads.find((thread) => thread.id === threadId)
    const expectedHostId = selectedThread?.hostId
    const expectedExecutionGenerationId = selectedThread?.executionGenerationId
    const remoteThreadId = selectedThread ? protocolThreadId(selectedThread) : undefined
    const activeHostId = asString(asRecord(this.connection)?.hostId)
    this.selectedThreadId = threadId
    const selectionGeneration = ++this.threadSelectionGeneration
    // A snapshot is authoritative for exactly one thread. Do not retain the
    // previous thread's evidence, agents, or attention while the new request
    // is in flight.
    this.threadSnapshot = expectedHostId && remoteThreadId
      ? this.cachedSnapshotForThread(remoteThreadId, expectedHostId, expectedExecutionGenerationId)
      : undefined
    this.publish()

    // Catalogs from inactive hosts remain useful offline, but selecting one is
    // read-only until that exact immutable host becomes the verified authority.
    if (
      !expectedHostId ||
      !expectedExecutionGenerationId ||
      !remoteThreadId ||
      expectedHostId !== activeHostId ||
      asString(asRecord(this.connection)?.phase) !== 'online'
    ) {
      return
    }

    try {
      const snapshot = await this.call<unknown>('requestSnapshot', { threadId: remoteThreadId })
      if (
        selectionGeneration !== this.threadSelectionGeneration ||
        threadId !== this.selectedThreadId ||
        selectionConnectionGeneration !== this.connectionGeneration
      ) return

      const currentSelectedThread = this.projection?.threads.find((thread) => thread.id === threadId)
      if (
        currentSelectedThread?.hostId !== expectedHostId ||
        protocolThreadId(currentSelectedThread) !== remoteThreadId ||
        currentSelectedThread.executionGenerationId !== expectedExecutionGenerationId
      ) return

      const incomingThreadId = asString(asRecord(asRecord(snapshot)?.thread)?.threadId)
      if (
        incomingThreadId !== remoteThreadId ||
        snapshotHostId(snapshot) !== expectedHostId ||
        snapshotExecutionGenerationId(snapshot) !== expectedExecutionGenerationId
      ) {
        throw new Error('The host returned a snapshot for a different thread. Try again.')
      }
      if (!this.replaceSnapshotEntry(expectedHostId, snapshot)) return
      this.threadSnapshot = snapshot
      this.publish()
    } catch (error) {
      if (
        selectionGeneration !== this.threadSelectionGeneration ||
        threadId !== this.selectedThreadId ||
        selectionConnectionGeneration !== this.connectionGeneration
      ) return
      const currentSelectedThread = this.projection?.threads.find((thread) => thread.id === threadId)
      if (
        currentSelectedThread?.hostId !== expectedHostId ||
        protocolThreadId(currentSelectedThread) !== remoteThreadId ||
        currentSelectedThread.executionGenerationId !== expectedExecutionGenerationId
      ) return
      this.selectedThreadId = previousThreadId
      this.threadSnapshot = previousSnapshot
      this.publish()
      throw error
    }
  }

  async activateComputer(expectedHostId: string): Promise<WorkbenchSnapshot> {
    if (this.options.allowConnectionInitiation === false) {
      throw new Error('Connecting a saved computer is unavailable from this surface.')
    }
    const cachedHost = this.projection?.hosts.find((host) => host.id === expectedHostId)
    if (!cachedHost || cachedHost.kind !== 'ssh') {
      throw new Error('Choose a saved SSH computer before connecting.')
    }
    if (cachedHost.connection !== 'offline' && cachedHost.activationRequired !== true) {
      throw new Error('Only an offline saved computer can be connected from this action.')
    }
    if (this.explicitHostActivationExpectedHostId) {
      throw new Error('Another saved computer is already being connected.')
    }

    const selectedBeforeActivation = this.projection?.threads.find(
      (thread) => thread.id === this.selectedThreadId && thread.hostId === expectedHostId,
    )
    const selectedRemoteThreadId = selectedBeforeActivation
      ? protocolThreadId(selectedBeforeActivation)
      : undefined
    const selectedExecutionGenerationId = selectedBeforeActivation?.executionGenerationId
    if (!selectedRemoteThreadId || !selectedExecutionGenerationId) {
      throw new Error('Choose a saved thread with a verified execution generation before connecting.')
    }
    const activationSelectionRevision = this.userThreadSelectionRevision
    const previousConnectionGeneration = this.connectionGeneration
    const previousMutationAuthorityReadyHostId = this.mutationAuthorityReadyHostId
    const fence = this.beginHostActivationReplyFence()
    this.explicitHostActivationExpectedHostId = expectedHostId
    this.explicitHostActivationSelectionRevision = activationSelectionRevision
    try {
      // The cached bootstrap is read-only until a fresh exact-host bootstrap
      // completes under the newly verified online authority.
      this.mutationAuthorityReadyHostId = undefined
      this.latestAuthoritativeMaterialization = undefined
      const reply = await this.call<unknown>('activateVerifiedSshHost', { expectedHostId })
      if (!this.isExactSshAuthority(reply, expectedHostId)) throw new StaleHostAuthorityError()

      if (this.hostActivationReplyIsCurrent(fence)) {
        this.applyConnectionState(reply)
      } else if (!this.isExactSshAuthority(this.connection, expectedHostId)) {
        // A later native observation outranks the bridge reply. Only an exact
        // already-online observation for this immutable host corroborates it.
        throw new StaleHostAuthorityError()
      }
      if (this.userThreadSelectionRevision !== activationSelectionRevision) throw new StaleHostAuthorityError()

      if (!this.isExactSshAuthority(this.connection, expectedHostId)) throw new StaleHostAuthorityError()
      const generation = this.connectionGeneration
      this.restoreSelectedHostThread(expectedHostId, selectedRemoteThreadId, selectedExecutionGenerationId)
      await this.rehydrateAuthorityMutationState(expectedHostId, generation)
      if (
        generation !== this.connectionGeneration ||
        !this.isExactSshAuthority(this.connection, expectedHostId) ||
        this.userThreadSelectionRevision !== activationSelectionRevision
      ) throw new StaleHostAuthorityError()

      // Bootstrap may prefer that host's last materialized thread. Restore the
      // user's exact cached selection before asking for authoritative state.
      this.restoreSelectedHostThread(expectedHostId, selectedRemoteThreadId, selectedExecutionGenerationId)
      await this.refreshFromAuthoritativeHost()
      const current = this.projection
      const host = current?.hosts.find((candidate) => candidate.id === expectedHostId)
      const selected = current?.threads.find((thread) => thread.id === current.selectedThreadId)
      const materialization = this.authoritativeMaterializationProof()
      if (
        generation !== this.connectionGeneration ||
        !this.isExactSshAuthority(this.connection, expectedHostId) ||
        this.userThreadSelectionRevision !== activationSelectionRevision ||
        !current ||
        !host ||
        host.kind !== 'ssh' ||
        host.connection !== 'online' ||
        host.connectionPath !== 'SSH' ||
        selected?.hostId !== expectedHostId ||
        protocolThreadId(selected) !== selectedRemoteThreadId ||
        selected.executionGenerationId !== selectedExecutionGenerationId ||
        !materialization ||
        materialization.connectionGeneration !== generation ||
        materialization.hostId !== expectedHostId ||
        materialization.threadId !== selectedRemoteThreadId ||
        materialization.executionGenerationId !== selectedExecutionGenerationId
      ) throw new StaleHostAuthorityError()
      this.mutationAuthorityReadyHostId = expectedHostId
      this.activationRetryRequiredHostIds.delete(expectedHostId)
      this.projectionRevision += 1
      return this.publish()
    } catch (error) {
      const current = asRecord(this.connection)
      if (
        previousMutationAuthorityReadyHostId &&
        previousConnectionGeneration === this.connectionGeneration &&
        asString(current?.phase) === 'online' &&
        asString(current?.hostId) === previousMutationAuthorityReadyHostId
      ) {
        this.mutationAuthorityReadyHostId = previousMutationAuthorityReadyHostId
        this.projectionRevision += 1
        this.publish()
      } else if (
        this.isExactSshAuthority(this.connection, expectedHostId) &&
        this.mutationAuthorityReadyHostId !== expectedHostId
      ) {
        this.activationRetryRequiredHostIds.add(expectedHostId)
        this.projectionRevision += 1
        this.publish()
      }
      throw error
    } finally {
      if (this.explicitHostActivationExpectedHostId === expectedHostId) {
        this.explicitHostActivationExpectedHostId = undefined
        this.explicitHostActivationSelectionRevision = undefined
      }
    }
  }

  async discoverComputers(): Promise<DiscoveredComputer[]> {
    const aliases = await this.call<unknown[]>('discoverSshHosts')
    const discovered = records(aliases).map((host) => {
      const effective = asRecord(host.effective)
      const hostname = asString(effective?.hostname) ?? asString(host.alias) ?? 'Unresolved host'
      const user = asString(effective?.user)
      const port = asNumber(effective?.port) ?? 22
      const resolutionError = asRecord(host.resolutionError)
      return {
        alias: asString(host.alias) ?? hostname,
        effectiveTarget: resolutionError ? asString(resolutionError.message) ?? 'Unable to resolve' : `${user ? `${user}@` : ''}${hostname}:${port}`,
        fingerprint: 'Run the connection check to verify this host through system OpenSSH.',
        protocol: asString(effective?.proxyJump) ? `SSH via ${asString(effective?.proxyJump)}` : 'System OpenSSH',
        platform: 'Run check to detect',
        architecture: 'Not checked',
        diskFree: 'Not checked',
        gitVersion: 'Not checked',
        pythonStatus: 'Not checked',
        agentVersion: 'Not checked',
        hostServiceVersion: 'Not checked',
        requiresInstall: false,
        installCommand: '',
        recentProjects: [],
        probeComplete: false,
        installAvailable: false,
        ...(resolutionError ? { installDeferredReason: asString(resolutionError.message) ?? 'Resolve this alias before connecting.' } : {}),
      }
    })
    this.discoveredComputers.clear()
    for (const computer of discovered) this.discoveredComputers.set(computer.alias, computer)
    return discovered
  }

  async probeComputer(input: { alias?: string; hostname?: string; user?: string }): Promise<DiscoveredComputer> {
    const alias = input.alias ?? input.hostname
    if (!alias) throw new Error('Choose an SSH alias before checking the connection.')
    let probe: UnknownRecord
    try {
      probe = asRecord(await this.call<unknown>('probeSshHost', { alias })) ?? {}
    } catch (error) {
      if (error instanceof NativeBridgeError && error.code === 'ssh.alias_not_discovered' && input.hostname) {
        throw new Error('Add this host as a concrete alias in your SSH configuration, refresh discovery, then check the connection again.')
      }
      const diagnostic = asString(error instanceof NativeBridgeError ? error.details?.diagnostic : undefined) ?? ''
      const hostServiceMissing =
        error instanceof NativeBridgeError &&
        error.code === 'ssh.failed' &&
        /(prime-agent-hostd|command not found|not recognized|no such file)/i.test(diagnostic)
      if (!hostServiceMissing) throw error

      const plan = asRecord(await this.call<unknown>('planHostInstall', { alias }))
      if (plan) this.installPlans.set(alias, plan)
      const discovered = this.discoveredComputers.get(alias)
      const executable = asBoolean(plan?.executable) ?? false
      return {
        alias,
        effectiveTarget: discovered?.effectiveTarget ?? alias,
        fingerprint: 'Host identity was checked by system OpenSSH; the exact fingerprint was not returned after the missing-service probe.',
        protocol: discovered?.protocol ?? 'System OpenSSH',
        platform: 'Available after host-service installation',
        architecture: 'Available after installation',
        diskFree: 'Available after installation',
        gitVersion: 'Available after installation',
        pythonStatus: 'Available after installation',
        agentVersion: 'Available after installation',
        hostServiceVersion: 'Not installed',
        requiresInstall: true,
        installCommand: commandLine(plan?.argv) || 'No executable install command is available in this build.',
        recentProjects: [],
        probeComplete: true,
        installAvailable: executable,
        ...(!executable ? { installDeferredReason: asString(plan?.deferredReason) ?? 'The signed host-service installer is unavailable.' } : {}),
      }
    }
    const payload = asRecord(probe.payload) ?? {}
    const platform = asRecord(payload.platform) ?? payload
    const tools = asRecord(payload.tools) ?? {}
    const hostd = asRecord(payload.hostd)
    const hostdVersion = asString(probe.hostdVersion) ?? asString(hostd?.runningVersion) ?? asString(hostd?.installedVersion)
    const requiresInstall = !hostdVersion
    let plan: UnknownRecord | undefined
    if (requiresInstall) {
      plan = asRecord(await this.call<unknown>('planHostInstall', { alias }))
      if (plan) this.installPlans.set(alias, plan)
    }
    const fingerprint =
      asString(payload.hostKeyFingerprint) ??
      asString(payload.fingerprint) ??
      'System OpenSSH accepted the configured host key; this probe did not report a literal fingerprint.'
    const os = asString(platform.os) ?? asString(payload.operatingSystem) ?? 'Operating system detected'
    const architecture = asString(platform.architecture) ?? asString(payload.architecture) ?? 'Architecture unavailable'
    const git = asRecord(tools.git)
    const python = asRecord(tools.python)
    const ipython = asRecord(tools.ipython)
    const primeAgent = asRecord(tools.primeAgent)
    const disk = asNumber(payload.availableDiskBytes)
    const recentProjects = records(payload.recentProjects)
      .map((project) => asString(project.displayName) ?? asString(project.relativeSubdirectory))
      .filter((project): project is string => Boolean(project))
    const executable = asBoolean(plan?.executable) ?? !requiresInstall
    return {
      alias,
      effectiveTarget: asString(probe.effectiveTarget) ?? alias,
      fingerprint,
      protocol: `SSH · protocol ${asString(probe.protocolVersion) ?? 'negotiated by host'}`,
      platform: os,
      architecture,
      diskFree: disk === undefined ? 'Disk space unavailable' : `${formatBytes(disk)} free`,
      gitVersion: asString(git?.version) ? `Git ${asString(git?.version)}` : asBoolean(git?.available) ? 'Git available' : 'Git unavailable',
      pythonStatus: [
        asString(python?.version) ? `Python ${asString(python?.version)}` : asBoolean(python?.available) ? 'Python available' : 'Python unavailable',
        asBoolean(ipython?.available) ? 'IPython ready' : 'IPython unavailable',
      ].join(' · '),
      agentVersion: asString(primeAgent?.version) ? `Prime Agent ${asString(primeAgent?.version)}` : asBoolean(primeAgent?.available) ? 'Prime Agent available' : 'Prime Agent unavailable',
      hostServiceVersion: hostdVersion ? `Host service ${hostdVersion}` : 'Not installed',
      requiresInstall,
      installCommand: commandLine(plan?.argv) || (requiresInstall ? 'No executable install command is available in this build.' : ''),
      recentProjects,
      probeComplete: true,
      installAvailable: executable,
      ...(!executable ? { installDeferredReason: asString(plan?.deferredReason) ?? 'The signed host-service installer is unavailable.' } : {}),
    }
  }

  async addComputer(input: {
    alias: string
    installHostService: boolean
    installCommandAcknowledged: boolean
  }): Promise<{ host: HostSummary }> {
    if (input.installHostService) {
      const plan = this.installPlans.get(input.alias) ?? asRecord(await this.call<unknown>('planHostInstall', { alias: input.alias }))
      if (!plan || !asBoolean(plan.executable)) {
        throw new Error(asString(plan?.deferredReason) ?? 'The signed host-service installer is unavailable in this build.')
      }
      if (!input.installCommandAcknowledged) throw new Error('Review and consent to the exact install command before continuing.')
      const planId = asString(plan.planId)
      if (!planId) throw new Error('The host installation plan is missing its identifier. Run the connection check again.')
      await this.call<never>('installHost', { planId, consent: true })
    }
    const target = { kind: 'ssh', alias: input.alias }
    const fence = this.beginConnectionReplyFence(target)
    const connection = asRecord(await this.call<unknown>('connect', target))
    const replyHostId = asString(connection?.hostId)
    if (this.connectionReplyIsCurrent(fence, connection)) {
      this.applyConnectionState(connection)
    } else {
      const current = asRecord(this.connection)
      const currentTarget = asRecord(current?.target)
      const replyTarget = asRecord(connection?.target)
      const corroboratesCurrentSshAuthority = Boolean(
        replyHostId &&
        asString(current?.phase) === 'online' &&
        asString(current?.path) === 'ssh' &&
        asString(currentTarget?.kind) === 'ssh' &&
        asString(currentTarget?.alias) === input.alias &&
        asString(current?.hostId) === replyHostId &&
        asString(replyTarget?.kind) === 'ssh' &&
        asString(replyTarget?.alias) === input.alias
      )
      if (!corroboratesCurrentSshAuthority) throw new StaleHostAuthorityError()
    }
    if (!replyHostId) throw new StaleHostAuthorityError()
    await this.refreshFromAuthoritativeHost()
    const current = asRecord(this.connection)
    const currentTarget = asRecord(current?.target)
    const host = this.projection?.hosts.find((candidate) => candidate.id === replyHostId)
    if (
      asString(current?.phase) !== 'online' ||
      asString(current?.path) !== 'ssh' ||
      asString(currentTarget?.kind) !== 'ssh' ||
      asString(currentTarget?.alias) !== input.alias ||
      asString(current?.hostId) !== replyHostId ||
      !host ||
      host.connection !== 'online' ||
      host.connectionPath !== 'SSH' ||
      host.kind !== 'ssh'
    ) throw new StaleHostAuthorityError()
    return { host }
  }

  async sendComposer(request: ComposerRequest): Promise<{ state: ComposerReceiptState; message: string; retryable?: boolean }> {
    if (!this.projection?.operations.startResidentTurn) {
      return {
        state: 'rejected',
        message: 'This resident session is not ready for a new prompt. Refresh the thread or reconnect its host.',
      }
    }
    const commandId = createStableId('command')
    const thread = this.projection?.threads.find((item) => item.id === request.threadId)
    if (!thread?.hostId) throw new Error('Refresh this thread before sending so its host identity can be verified.')
    const expectedHostId = thread.hostId
    const expectedExecutionGenerationId = thread.executionGenerationId
    if (!expectedExecutionGenerationId) {
      throw new Error('Refresh this thread before sending so its exact execution generation can be verified.')
    }
    const remoteThreadId = protocolThreadId(thread)
    if (asString(asRecord(this.connection)?.hostId) !== expectedHostId) {
      throw new StaleHostAuthorityError()
    }
    const issuedAt = this.nextComposerIssuedAt(expectedHostId, remoteThreadId)
    const clientCommand = {
      deviceId: this.deviceId,
      commandId,
      expectedHostId,
      threadId: remoteThreadId,
      kind: 'thread.prompt',
      payload: { text: request.text },
      delivery: 'live_only',
      expectedExecutionGenerationId,
      issuedAt,
    }
    this.composerCommands.set(commandId, remoteThreadId)
    this.composerDevices.set(commandId, this.deviceId)
    this.composerHosts.set(commandId, expectedHostId)
    this.composerGenerations.set(commandId, expectedExecutionGenerationId)
    this.composerFingerprints.set(commandId, canonicalRendererJson(clientCommand))
    this.composerOperations.set(commandId, 'prompt')
    const baselineSnapshotCursor = canonicalRendererJson(asRecord(asRecord(this.threadSnapshot)?.latestCursor) ?? {})
    this.composerBaselineCursors.set(commandId, baselineSnapshotCursor)
    this.registerComposerAction({
      commandId,
      expectedHostId,
      threadId: remoteThreadId,
      expectedExecutionGenerationId,
      operation: 'prompt',
      issuedAt,
    })
    this.composerOverride = {
      threadId: request.threadId,
      expectedHostId,
      expectedExecutionGenerationId,
      operation: 'prompt',
      baselineSnapshotCursor,
      state: 'sending',
      message: 'Starting Prime Agent…',
    }
    this.publish()
    let receipt: UnknownRecord | undefined
    try {
      receipt = asRecord(await this.call<unknown>('submitCommand', clientCommand))
      if (
        asString(receipt?.deviceId) !== this.deviceId ||
        asString(receipt?.commandId) !== commandId ||
        asString(receipt?.hostId) !== expectedHostId ||
        asString(receipt?.threadId) !== remoteThreadId ||
        asString(receipt?.executionGenerationId) !== expectedExecutionGenerationId
      ) {
        throw new Error('The host returned a receipt for a different command generation. The original receipt remains uncertain.')
      }
    } catch (error) {
      if (error instanceof StaleHostAuthorityError) throw error
      if (!this.hasComposerAuthority(request.threadId, expectedHostId, expectedExecutionGenerationId)) {
        this.forgetComposerCommand(commandId)
        throw new StaleHostAuthorityError()
      }
      if (
        this.isLatestComposerAction(
          commandId,
          expectedHostId,
          remoteThreadId,
          expectedExecutionGenerationId,
        )
      ) {
        this.composerOverride = {
          threadId: request.threadId,
          expectedHostId,
          expectedExecutionGenerationId,
          operation: 'prompt',
          baselineSnapshotCursor,
          state: 'uncertain',
          message: error instanceof Error ? `${error.message} Verifying the exact envelope with the host.` : 'Receipt uncertain · verifying with host',
        }
        this.publish()
      }
      throw error
    }
    if (!this.hasComposerAuthority(request.threadId, expectedHostId, expectedExecutionGenerationId)) {
      this.forgetComposerCommand(commandId)
      throw new StaleHostAuthorityError()
    }
    const mapped = nativeComposerReceipt(receipt ?? {}, 'prompt')
    const actionIsLatest = this.isLatestComposerAction(
      commandId,
      expectedHostId,
      remoteThreadId,
      expectedExecutionGenerationId,
    )
    const completedPromptProof = asString(receipt?.status) === 'completed'
    if (completedPromptProof) this.retireDurableUncertainReceipt(receipt ?? {})
    if (actionIsLatest && completedPromptProof) {
      this.latestComposerActions.delete(this.composerActionKey(expectedHostId, remoteThreadId))
      if (
        this.composerOverride?.expectedHostId === expectedHostId &&
        this.composerOverride.expectedExecutionGenerationId === expectedExecutionGenerationId
      ) this.composerOverride = undefined
    } else if (actionIsLatest) {
      this.composerOverride = {
        threadId: request.threadId,
        expectedHostId,
        expectedExecutionGenerationId,
        operation: 'prompt',
        baselineSnapshotCursor,
        state: mapped.state,
        message: mapped.message,
        ...(mapped.retryable !== undefined ? { retryable: mapped.retryable } : {}),
      }
    }
    if (mapped.terminal) {
      this.forgetComposerCommand(commandId)
    }
    if (actionIsLatest) this.publish()
    return {
      state: mapped.state,
      message: mapped.message,
      ...(mapped.retryable !== undefined ? { retryable: mapped.retryable } : {}),
    }
  }

  async abortThread(threadId: string): Promise<{ state: ComposerReceiptState; message: string; retryable?: boolean }> {
    if (!this.projection?.operations.stopResidentTurn) {
      return {
        state: 'rejected',
        message: 'Prime Agent does not report an active resident turn that can be stopped.',
      }
    }
    const commandId = createStableId('command')
    const thread = this.projection.threads.find((item) => item.id === threadId)
    if (!thread?.hostId) throw new Error('Refresh this thread before stopping so its host identity can be verified.')
    const expectedHostId = thread.hostId
    const expectedExecutionGenerationId = thread.executionGenerationId
    if (!expectedExecutionGenerationId) {
      throw new Error('Refresh this thread before stopping so its exact execution generation can be verified.')
    }
    const remoteThreadId = protocolThreadId(thread)
    if (asString(asRecord(this.connection)?.hostId) !== expectedHostId) {
      throw new StaleHostAuthorityError()
    }
    const issuedAt = this.nextComposerIssuedAt(expectedHostId, remoteThreadId)
    const clientCommand = {
      deviceId: this.deviceId,
      commandId,
      expectedHostId,
      threadId: remoteThreadId,
      kind: 'thread.cancel',
      delivery: 'live_only',
      expectedExecutionGenerationId,
      issuedAt,
    }
    this.composerCommands.set(commandId, remoteThreadId)
    this.composerDevices.set(commandId, this.deviceId)
    this.composerHosts.set(commandId, expectedHostId)
    this.composerGenerations.set(commandId, expectedExecutionGenerationId)
    this.composerFingerprints.set(commandId, canonicalRendererJson(clientCommand))
    this.composerOperations.set(commandId, 'abort')
    const baselineSnapshotCursor = canonicalRendererJson(asRecord(asRecord(this.threadSnapshot)?.latestCursor) ?? {})
    this.composerBaselineCursors.set(commandId, baselineSnapshotCursor)
    this.registerComposerAction({
      commandId,
      expectedHostId,
      threadId: remoteThreadId,
      expectedExecutionGenerationId,
      operation: 'abort',
      issuedAt,
    })
    this.composerOverride = {
      threadId,
      expectedHostId,
      expectedExecutionGenerationId,
      operation: 'abort',
      baselineSnapshotCursor,
      state: 'sending',
      message: 'Requesting a safe stop…',
    }
    this.publish()
    let receipt: UnknownRecord | undefined
    try {
      receipt = asRecord(await this.call<unknown>('cancel', {
        deviceId: this.deviceId,
        commandId,
        expectedHostId,
        expectedExecutionGenerationId,
        issuedAt,
        threadId: remoteThreadId,
      }))
      if (
        asString(receipt?.deviceId) !== this.deviceId ||
        asString(receipt?.commandId) !== commandId ||
        asString(receipt?.hostId) !== expectedHostId ||
        asString(receipt?.threadId) !== remoteThreadId ||
        asString(receipt?.executionGenerationId) !== expectedExecutionGenerationId
      ) {
        throw new Error('The host returned a stop receipt for a different command generation. The original outcome remains uncertain.')
      }
    } catch (error) {
      if (error instanceof StaleHostAuthorityError) throw error
      if (!this.hasComposerAuthority(threadId, expectedHostId, expectedExecutionGenerationId)) {
        this.forgetComposerCommand(commandId)
        throw new StaleHostAuthorityError()
      }
      if (
        this.isLatestComposerAction(
          commandId,
          expectedHostId,
          remoteThreadId,
          expectedExecutionGenerationId,
        )
      ) {
        this.composerOverride = {
          threadId,
          expectedHostId,
          expectedExecutionGenerationId,
          operation: 'abort',
          baselineSnapshotCursor,
          state: 'uncertain',
          retryable: false,
          message: error instanceof Error
            ? `${error.message} Prime Agent will not replay this stop request without proof.`
            : 'Stop outcome unknown · Prime Agent will not replay this request without proof.',
        }
        this.publish()
      }
      throw error
    }
    if (!this.hasComposerAuthority(threadId, expectedHostId, expectedExecutionGenerationId)) {
      this.forgetComposerCommand(commandId)
      throw new StaleHostAuthorityError()
    }
    const mapped = nativeComposerReceipt(receipt ?? {}, 'abort')
    const actionIsLatest = this.isLatestComposerAction(
      commandId,
      expectedHostId,
      remoteThreadId,
      expectedExecutionGenerationId,
    )
    const completedAbortProof = asString(receipt?.status) === 'completed'
    if (completedAbortProof) this.retireDurableUncertainReceipt(receipt ?? {})
    if (actionIsLatest && completedAbortProof) {
      this.latestComposerActions.delete(this.composerActionKey(expectedHostId, remoteThreadId))
      if (
        this.composerOverride?.expectedHostId === expectedHostId &&
        this.composerOverride.expectedExecutionGenerationId === expectedExecutionGenerationId
      ) this.composerOverride = undefined
    } else if (actionIsLatest) {
      this.composerOverride = {
        threadId,
        expectedHostId,
        expectedExecutionGenerationId,
        operation: 'abort',
        baselineSnapshotCursor,
        state: mapped.state,
        message: mapped.message,
        ...(mapped.retryable !== undefined ? { retryable: mapped.retryable } : {}),
      }
    }
    if (mapped.terminal) this.forgetComposerCommand(commandId)
    if (actionIsLatest) this.publish()
    return {
      state: mapped.state,
      message: mapped.message,
      ...(mapped.retryable !== undefined ? { retryable: mapped.retryable } : {}),
    }
  }

  private hasComposerAuthority(
    threadId: string,
    expectedHostId: string,
    expectedExecutionGenerationId: string,
  ): boolean {
    const activeHostId = asString(asRecord(this.connection)?.hostId)
    const activeThread = this.projection?.threads.find((item) => item.id === threadId)
    return Boolean(
      activeHostId === expectedHostId &&
      activeThread &&
      activeThread.hostId === expectedHostId &&
      activeThread.executionGenerationId === expectedExecutionGenerationId
    )
  }

  async planHandoff(input: {
    threadId: string
    destinationHostId: string
    behaviorIfRunning: 'interrupt' | 'wait_for_idle'
  }): Promise<HandoffPlan> {
    if (!this.projection?.operations.crossHostHandoff) {
      throw new Error('Cross-host handoff is not available because the connected host has not advertised a destination coordinator.')
    }
    const rawCatalog = asRecord(this.catalog)
    const selectedThread = this.projection?.threads.find((thread) => thread.id === input.threadId)
    const remoteThreadId = selectedThread ? protocolThreadId(selectedThread) : undefined
    const selectedHostId = selectedThread?.hostId
    const cachedSnapshotThread = asRecord(asRecord(this.threadSnapshot)?.thread)
    const cachedSnapshotLocation = asRecord(cachedSnapshotThread?.currentLocation)
    const rawThread = records(rawCatalog?.threads).find(
      (thread) =>
        asString(thread.threadId) === remoteThreadId &&
        asString(asRecord(thread.currentLocation)?.hostId) === selectedHostId,
    ) ?? (
      asString(cachedSnapshotThread?.threadId) === remoteThreadId &&
      asString(cachedSnapshotLocation?.hostId) === selectedHostId
        ? cachedSnapshotThread
        : undefined
    )
    const source = asRecord(asRecord(rawThread)?.currentLocation)
    const sourceGenerationId = asString(source?.executionGenerationId)
    const sourceProjectId = asString(source?.projectId)
    const expectedHostId = asString(source?.hostId)
    if (!sourceGenerationId || !sourceProjectId || !expectedHostId) {
      throw new Error('Open an authoritative thread snapshot before moving this thread.')
    }
    const rawProjects = records(rawCatalog?.projects)
    const sourceProject = rawProjects.find(
      (project) =>
        asString(project.projectId) === sourceProjectId &&
        asString(project.hostId) === expectedHostId,
    )
    const sourceIdentity = JSON.stringify(asRecord(sourceProject?.repositoryIdentity) ?? {})
    const destinationProject = rawProjects.find(
      (project) =>
        asString(project.hostId) === input.destinationHostId &&
        (sourceIdentity === '{}' || JSON.stringify(asRecord(project.repositoryIdentity) ?? {}) === sourceIdentity),
    )
    const destinationProjectId = asString(destinationProject?.projectId)
    if (!destinationProjectId) {
      throw new Error('No compatible saved project was found on the destination host.')
    }
    const rawPlan = asRecord(
      await this.call<unknown>('planHandoff', {
        threadId: remoteThreadId,
        expectedHostId,
        sourceGenerationId,
        destinationHostId: input.destinationHostId,
        destinationProjectId,
        behaviorIfRunning: input.behaviorIfRunning,
      }),
    )
    const rawWarnings = records(rawPlan?.warnings)
    if (asBoolean(rawPlan?.executable) === false) {
      const blockingWarning = rawWarnings.find((warning) => asBoolean(warning.blocking)) ?? rawWarnings[0]
      throw new Error(
        asString(blockingWarning?.message) ?? 'The host cannot execute this move plan. Review the destination and try again.',
      )
    }
    const handoffId = asString(rawPlan?.handoffId)
    if (!handoffId) throw new Error('The host returned a move plan without an identifier.')
    const sourceLocation = asRecord(rawPlan?.source) ?? source
    const destinationLocation = asRecord(rawPlan?.destination)
    const sourceHostId = asString(sourceLocation?.hostId) ?? asString(source?.hostId) ?? ''
    const destinationHostId = asString(destinationLocation?.hostId) ?? input.destinationHostId
    const sourceHost = this.projection?.hosts.find((host) => host.id === sourceHostId)
    const destinationHost = this.projection?.hosts.find((host) => host.id === destinationHostId)
    const branchPlan = asRecord(rawPlan?.branchPlan)
    const repositoryMatch = asString(rawPlan?.repositoryMatch)
    if (repositoryMatch === 'none') {
      throw new Error('The destination repository is not compatible with this thread.')
    }
    this.handoffDestinations.set(handoffId, destinationHostId)
    this.handoffSources.set(handoffId, sourceHostId)
    return {
      handoffId,
      sourceHostId,
      sourceName: sourceHost?.name ?? `Host ${sourceHostId}`,
      destinationHostId,
      destinationName: destinationHost?.name ?? `Host ${destinationHostId}`,
      repository: this.projection?.projects.find(
        (project) => project.id === sourceProjectId && project.hostIds.includes(sourceHostId),
      )?.repository ?? asString(sourceProject?.displayName) ?? sourceProjectId,
      destinationProject: asString(destinationProject?.displayName) ?? destinationProjectId,
      branch: asString(branchPlan?.destinationBranch) ?? asString(branchPlan?.sourceBranch) ?? 'Branch resolved by host',
      dirtyFiles: this.projection?.projects.find(
        (project) => project.id === sourceProjectId && project.hostIds.includes(sourceHostId),
      )?.dirtyFiles ?? 0,
      untrackedFiles: asBoolean(rawPlan?.includesUntrackedFiles) ? asNumber(asRecord(asRecord(this.threadSnapshot)?.git)?.untrackedFiles) ?? 0 : 0,
      transferSize: formatBytes(rawPlan?.transferBytesEstimate),
      repositoryMatch: repositoryMatch === 'user_confirmed' ? 'user_confirmed' : 'exact',
      runtimeLosses: Array.isArray(rawPlan?.runtimeStateLosses)
        ? rawPlan.runtimeStateLosses.filter((loss): loss is string => typeof loss === 'string')
        : [],
      warnings: rawWarnings.map((warning) => asString(warning.message)).filter((message): message is string => Boolean(message)),
    }
  }

  async startHandoff(
    input: { handoffId: string; behaviorIfRunning: 'interrupt' | 'wait_for_idle' },
    onProgress: (phase: HandoffPhase, message: string) => void,
  ): Promise<{ destinationHostId: string; receiptId: string }> {
    if (!this.projection?.operations.crossHostHandoff) {
      throw new Error('Cross-host handoff is not available because the connected host has not advertised a destination coordinator.')
    }
    this.activeProgress = onProgress
    onProgress('quiescing', input.behaviorIfRunning === 'interrupt' ? 'Interrupting the current turn safely' : 'Waiting for the current turn to finish')
    try {
      const expectedHostId = this.handoffSources.get(input.handoffId)
      if (!expectedHostId) throw new Error('The reviewed move plan no longer has a verified source host. Plan it again.')
      const result = asRecord(
        await this.call<unknown>('commitHandoff', {
          handoffId: input.handoffId,
          deviceId: this.deviceId,
          commandId: createStableId('command'),
          expectedHostId,
        }),
      )
      for (const raw of records(result?.progress)) {
        const mapped = progressCopy(raw)
        if (mapped.failed) throw mapped.failed
        if (mapped.phase) onProgress(mapped.phase, mapped.message)
      }
      const receipt = asRecord(result?.receipt) ?? result
      const destination = asRecord(receipt?.destination)
      const destinationHostId = asString(destination?.hostId) ?? this.handoffDestinations.get(input.handoffId)
      if (!destinationHostId) throw new Error('The move receipt did not identify the destination host.')
      const receiptId = asString(receipt?.handoffId) ?? input.handoffId
      onProgress('complete', 'Thread moved and verified')
      return { destinationHostId, receiptId }
    } finally {
      this.activeProgress = undefined
    }
  }
}

let singletonApi: RendererApi | undefined

export function createRendererApi(options: { allowConnectionInitiation?: boolean } = {}): RendererApi {
  if (!singletonApi) {
    const nativeBridge = Reflect.get(window, 'prime') as NativePrimeBridge | undefined
    if (nativeBridge) singletonApi = new NativeRendererApi(nativeBridge, options)
    else throw new Error('Prime Continuim requires its desktop control bridge. Close this window and reopen the installed desktop app.')
  }
  return singletonApi
}
