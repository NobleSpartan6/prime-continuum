import {
  CANDIDATE_EVALUATION_PROBE_CAPABILITY,
  CandidateEvaluationPreflightSchema,
  CandidateEvaluationSnapshotSchema,
  CandidateEvaluationStatusSchema,
  PRIME_CONTINUIM_SELF_BUILD_EVALUATION_CAPABILITY,
  PRIME_AGENT_COMMAND_CAPABILITY,
  RESIDENT_LIFECYCLE_CAPABILITY,
  RUNTIME_INTEGRITY_REPAIR_CAPABILITY,
  RUNTIME_INTEGRITY_RETRY_CAPABILITY,
  RUNTIME_MODEL_CATALOG_CAPABILITY,
  ResidentLifecycleLookupResultSchema,
  ResidentLifecycleStatusSchema,
  ResidentLifecycleDispositionSchema,
  RuntimeIntegritySnapshotSchema,
  RuntimeModelCatalogSnapshotSchema,
  THREAD_HANDOFF_CAPABILITY,
  type ResidentLifecycleStatus,
  type CandidateEvaluationPreflight,
  type CandidateEvaluationPreflightRequest,
  type CandidateEvaluationReviewIdentity,
  type CandidateEvaluationSnapshot,
  type CandidateEvaluationStartRequest,
  type CandidateEvaluationStatus,
  type RuntimeIntegritySnapshot,
  type RuntimeModelCatalogSnapshot,
} from '../../shared/protocol'
import type { HudMode, HudState, HudTarget } from '../../shared/window-control'

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
  role: string
  status: 'pending' | 'queued' | 'running' | 'waiting' | 'complete' | 'failed' | 'cancelled'
  hostName: string
  parentId?: string
  model?: string
  activity?: string
  durationMs?: number
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
  serviceTier?: string
  isStreaming: boolean
  isCompacting: boolean
  isBashRunning: boolean
  retryAttempt: number
  queuedActionCount: number
  messageCount: number
  compactionCount: number
  activeToolNames: string[]
  context?: {
    usedTokens: number
    maxTokens?: number
  }
}

export interface RuntimeSummary {
  session?: RuntimeSessionSummary
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
  /** Current local setup only; never contains a folder, socket, executable, or data-root path. */
  localSetup?: LocalSetupSummary
  /** Bounded, path-free desktop ledger for fresh resident lifecycle recovery. */
  residentLifecycleOperations: ResidentLifecycleOperationSummary[]
  operations: {
    submitCommands: boolean
    startResidentTurn?: boolean
    stopResidentTurn?: boolean
    provisionResident?: boolean
    crossHostHandoff: boolean
    modelCatalog?: boolean
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

export interface ResidentWorkspaceSelection {
  selectionToken: string
  operationId: string
  expectedHostId: string
  suggestedName: string
  expiresAt: string
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
  selectResidentWorkspace(input?: { resumeOperationId?: string }): Promise<ResidentWorkspaceSelection>
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

type NativePrimeBridge = object

const delay = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
const previewSimulation = (message: string) => `Preview simulation · ${message}`

const seedTranscript: TranscriptBlock[] = [
  {
    id: 'block-1',
    kind: 'checkpoint',
    time: '9:42 AM',
    body: previewSimulation('resumed from a visual-QA checkpoint; no host snapshot was read.'),
    detail: previewSimulation('fixture transcript replaced in memory; no commands were replayed'),
  },
  {
    id: 'block-2',
    kind: 'user',
    author: 'You',
    time: '9:44 AM',
    body: 'Implement the seamless remote workbench. Keep the thread durable across reconnects and make handoff semantics explicit.',
  },
  {
    id: 'block-3',
    kind: 'assistant',
    author: 'Prime Agent',
    time: '9:45 AM',
    body: 'I’m aligning the renderer around one durable thread. The project, transcript, composer, approvals, and evidence stay in place while only the run location changes.',
    detail: 'Working in the renderer and coordinating two child agents.',
  },
  {
    id: 'block-4',
    kind: 'tool',
    author: 'Renderer checks',
    time: '9:48 AM',
    body: 'pnpm test -- renderer',
    detail: previewSimulation('fixture passing receipt; no host check ran'),
    receipt: 'preview_simulation_receipt',
  },
  {
    id: 'block-5',
    kind: 'assistant',
    author: 'Prime Agent',
    time: '9:49 AM',
    body: 'The cached transcript is still available while the SSH path reconnects. I’ll reconcile this turn by command ID before sending anything again.',
    detail: 'Connection state is separate from the running task.',
  },
]

export const previewSnapshot: WorkbenchSnapshot = {
  selectedProjectId: 'project-prime',
  selectedThreadId: 'thread-seamless',
  residentLifecycleOperations: [],
  operations: {
    submitCommands: true,
    startResidentTurn: false,
    stopResidentTurn: true,
    crossHostHandoff: true,
    modelCatalog: true,
  },
  hosts: [
    {
      id: 'host-local',
      name: 'This computer',
      kind: 'local',
      connection: 'online',
      connectionPath: 'Local socket',
      latencyMs: 2,
      compatibility: 'compatible',
    },
    {
      id: 'host-devbox',
      name: 'devbox',
      kind: 'ssh',
      connection: 'reconnecting',
      connectionPath: 'SSH',
      lastSynchronized: '12 s ago',
      compatibility: 'compatible',
    },
    {
      id: 'host-gpu',
      name: 'GPU workstation',
      kind: 'paired',
      connection: 'offline',
      connectionPath: 'Relay',
      lastSynchronized: '18 min ago',
      compatibility: 'update_available',
    },
  ],
  projects: [
    {
      id: 'project-prime',
      name: 'Prime Continuim',
      repository: 'prime-agent-native',
      hostIds: ['host-local', 'host-devbox'],
      branch: 'feat/seamless-remote',
      dirtyFiles: 6,
    },
    {
      id: 'project-control',
      name: 'Control plane',
      repository: 'prime-control-plane',
      hostIds: ['host-devbox'],
      branch: 'main',
      dirtyFiles: 0,
    },
    {
      id: 'project-training',
      name: 'Training runs',
      repository: 'prime-training',
      hostIds: ['host-gpu'],
      branch: 'experiments/q3',
      dirtyFiles: 2,
    },
  ],
  threads: [
    {
      id: 'thread-seamless',
      projectId: 'project-prime',
      title: 'Seamless remote experience',
      recap: 'Building the unified workbench and durable reconnect flow.',
      hostId: 'host-devbox',
      status: 'running',
      updatedAt: 'Now',
      unread: true,
      transcript: seedTranscript,
    },
    {
      id: 'thread-protocol',
      projectId: 'project-prime',
      title: 'Frame protocol boundaries',
      recap: 'Backpressure and snapshot framing are ready for review.',
      hostId: 'host-local',
      status: 'needs_approval',
      updatedAt: '8 min',
      transcript: [
        {
          id: 'protocol-1',
          kind: 'assistant',
          author: 'Prime Agent',
          time: '9:31 AM',
          body: 'The bounded frame parser is ready. I need approval before running the interoperability harness against the local daemon.',
          detail: 'Approval is required on This computer.',
        },
      ],
    },
    {
      id: 'thread-gpu',
      projectId: 'project-training',
      title: 'Benchmark attention kernel',
      recap: 'The host is offline; the most recent snapshot is still available.',
      hostId: 'host-gpu',
      status: 'running',
      updatedAt: '18 min',
      transcript: [
        {
          id: 'gpu-1',
          kind: 'notice',
          time: '9:14 AM',
          body: 'The GPU workstation is offline. This cached transcript remains available.',
          detail: 'The task may still be running on the host.',
        },
        {
          id: 'gpu-2',
          kind: 'assistant',
          author: 'Prime Agent',
          time: '9:12 AM',
          body: 'The first benchmark batch completed with stable memory use. I started the larger context sweep before the relay path disconnected.',
        },
      ],
    },
    {
      id: 'thread-complete',
      projectId: 'project-prime',
      title: 'Audit SSH discovery',
      recap: 'Concrete aliases resolve through OpenSSH without reading keys.',
      hostId: 'host-devbox',
      status: 'complete',
      updatedAt: 'Yesterday',
      transcript: [
        {
          id: 'ssh-1',
          kind: 'assistant',
          author: 'Prime Agent',
          time: 'Yesterday',
          body: 'SSH discovery now preserves aliases as authority and delegates effective configuration to OpenSSH.',
          detail: '12 aliases discovered · wildcard entries excluded',
        },
      ],
    },
  ],
  attention: [
    {
      id: 'attention-1',
      threadId: 'thread-protocol',
      kind: 'approval',
      title: 'Review interoperability command',
      hostName: 'This computer',
    },
    {
      id: 'attention-2',
      threadId: 'thread-gpu',
      kind: 'failed',
      title: 'GPU workstation went offline',
      hostName: 'GPU workstation',
    },
  ],
  changes: [
    { path: 'src/renderer/src/App.tsx', additions: 418, deletions: 0, status: 'added' },
    { path: 'src/renderer/src/styles.css', additions: 532, deletions: 0, status: 'added' },
    { path: 'src/renderer/src/api.ts', additions: 226, deletions: 0, status: 'added' },
    { path: 'tests/renderer/App.test.tsx', additions: 94, deletions: 0, status: 'added' },
  ],
  agents: [
    { id: 'agent-1', name: 'Workbench lead', role: 'Retained subagent', status: 'running', hostName: 'devbox' },
    { id: 'agent-2', parentId: 'agent-1', name: 'Renderer', role: 'Interface implementation', status: 'running', hostName: 'This computer', toolUseCount: 18, tokenCount: 24_120 },
    { id: 'agent-3', parentId: 'agent-1', name: 'Protocol', role: 'Snapshots and command journal', status: 'waiting', hostName: 'devbox', toolUseCount: 7, tokenCount: 11_804 },
  ],
  evidence: [
    { id: 'evidence-1', label: 'Visual-QA renderer checks', detail: 'Internal fixture · passing', status: 'passed' },
    { id: 'evidence-2', label: 'Visual-QA type check', detail: 'Internal fixture · passing', status: 'passed' },
    { id: 'evidence-3', label: 'Visual-QA reconnect trace', detail: 'Internal fixture · awaiting path recovery', status: 'running' },
  ],
  runtime: {
    agentsReported: true,
    session: {
      residency: 'resident',
      appVersion: '0.18.4',
      activeSessionId: 'session-seamless-remote',
      sessionId: 'session-seamless-remote',
      sessionName: 'Seamless remote experience',
      model: 'GPT-5.6 Sol',
      thinkingLevel: 'High',
      isStreaming: true,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      queuedActionCount: 2,
      messageCount: seedTranscript.length,
      compactionCount: 1,
      activeToolNames: ['renderer'],
      context: { usedTokens: 32_000, maxTokens: 200_000 },
    },
    queue: { pendingCount: 1, paused: false },
    goals: [
      {
        id: 'goal-continuity',
        objective: 'Implement the seamless remote workbench',
        state: 'active',
      },
    ],
    schedules: [
      {
        id: 'schedule-review',
        label: 'Review overnight verification',
        state: 'active',
        nextRunAt: '2026-08-07T09:00:00.000Z',
      },
    ],
  },
  composerReceipt: { state: 'waiting_for_connection', message: previewSimulation('waiting for a fixture connection') },
}

export type PreviewVisualState =
  | 'reconnecting'
  | 'idle'
  | 'prompt-admission'
  | 'prompt-awaiting-idle-proof'
  | 'stop-awaiting-idle-proof'
  | 'nonretryable-uncertainty'
  | 'resident-start'
  | 'resident-recovery'
  | 'resident-end-review'
  | 'resident-end-pending'
  | 'candidate-evaluation-review'
  | 'hud-expanded'
  | 'hud-buddy'

const PREVIEW_VISUAL_STATES = new Set<PreviewVisualState>([
  'reconnecting',
  'idle',
  'prompt-admission',
  'prompt-awaiting-idle-proof',
  'stop-awaiting-idle-proof',
  'nonretryable-uncertainty',
  'resident-start',
  'resident-recovery',
  'resident-end-review',
  'resident-end-pending',
  'candidate-evaluation-review',
  'hud-expanded',
  'hud-buddy',
])

function previewVisualStateFromSearch(search: string): PreviewVisualState {
  const candidate = new URLSearchParams(search).get('visualState')
  return candidate && PREVIEW_VISUAL_STATES.has(candidate as PreviewVisualState)
    ? candidate as PreviewVisualState
    : 'reconnecting'
}

function previewSnapshotForVisualState(visualState: PreviewVisualState): WorkbenchSnapshot {
  const snapshot = structuredClone(previewSnapshot)
  if (visualState === 'reconnecting') return snapshot

  if (visualState === 'resident-start' || visualState === 'resident-recovery') {
    const host = snapshot.hosts[0]
    if (host) {
      host.kind = 'local'
      host.connection = 'online'
      host.connectionPath = 'Local socket'
      host.latencyMs = 2
      delete host.lastSynchronized
    }
    snapshot.selectedProjectId = ''
    snapshot.selectedThreadId = ''
    snapshot.projects = []
    snapshot.threads = []
    snapshot.attention = []
    snapshot.runtime = {}
    snapshot.operations = {
      submitCommands: false,
      startResidentTurn: false,
      stopResidentTurn: false,
      crossHostHandoff: false,
      provisionResident: true,
    }
    if (visualState === 'resident-start') {
      const runtimeReadiness: HostRuntimeReadiness = {
        kind: 'reported',
        freshness: 'live',
        observedAt: '2026-08-07T12:00:00.000Z',
        status: 'ready',
        assurance: 'development-integrity',
      }
      snapshot.localSetup = { stage: 'choose_workspace', runtimeReadiness }
      if (host) host.runtimeReadiness = runtimeReadiness
    }
    snapshot.composerReceipt = { state: 'idle', message: 'Ready to start a resident thread' }
    snapshot.residentLifecycleOperations = visualState === 'resident-recovery'
      ? [{
          kind: 'provision',
          operationId: 'resident-preview-recovery',
          expectedHostId: host?.id ?? 'local-preview',
          projectId: 'project-preview-recovery',
          workspaceId: 'workspace-preview-recovery',
          threadId: 'thread-preview-recovery',
          executionGenerationId: 'execution-preview-recovery',
          projectDisplayName: 'Continuim desktop',
          threadTitle: 'Resident setup',
          createdAt: '2026-08-07T12:00:00.000Z',
          updatedAt: '2026-08-07T12:01:00.000Z',
          state: 'requires_reselection',
        }]
      : []
    return snapshot
  }

  if (visualState === 'resident-end-review' || visualState === 'resident-end-pending') {
    const thread = snapshot.threads.find((candidate) => candidate.id === 'thread-protocol')
    const host = snapshot.hosts.find((candidate) => candidate.id === 'host-local')
    if (!thread || !host || !snapshot.runtime.session) return snapshot
    snapshot.selectedProjectId = thread.projectId
    snapshot.selectedThreadId = thread.id
    thread.status = 'idle'
    thread.workspaceId = 'workspace-preview-end'
    thread.executionGenerationId = 'execution-preview-end'
    host.connection = 'online'
    host.connectionPath = 'Local socket'
    host.latencyMs = 2
    delete host.lastSynchronized
    snapshot.runtime.session = {
      ...snapshot.runtime.session,
      residency: 'resident',
      activeSessionId: 'active-preview-end',
      sessionId: 'session-preview-end',
      sessionName: thread.title,
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      queuedActionCount: 0,
    }
    snapshot.runtime.queue = { pendingCount: 0, paused: false }
    snapshot.operations = {
      ...snapshot.operations,
      submitCommands: visualState === 'resident-end-review',
      startResidentTurn: visualState === 'resident-end-review',
      stopResidentTurn: false,
      provisionResident: true,
    }
    snapshot.residentLifecycleOperations = visualState === 'resident-end-pending'
      ? [{
          kind: 'end',
          operationId: 'resident-preview-end',
          expectedHostId: host.id,
          projectId: thread.projectId,
          workspaceId: thread.workspaceId,
          threadId: thread.id,
          executionGenerationId: thread.executionGenerationId,
          sourceCursor: {
            threadId: thread.id,
            executionGenerationId: thread.executionGenerationId,
            generation: 'daemon-preview-end',
            sequence: 4,
          },
          createdAt: '2026-08-07T12:00:00.000Z',
          updatedAt: '2026-08-07T12:00:01.000Z',
          state: 'submitted',
          lastStatus: {
            version: 1,
            kind: 'end',
            operationId: 'resident-preview-end',
            phase: 'ending',
            expectedHostId: host.id,
            projectId: thread.projectId,
            workspaceId: thread.workspaceId,
            threadId: thread.id,
            executionGenerationId: thread.executionGenerationId,
            preparedAt: '2026-08-07T12:00:00.000Z',
            updatedAt: '2026-08-07T12:00:01.000Z',
          },
        }]
      : []
    snapshot.composerReceipt = visualState === 'resident-end-pending'
      ? {
          state: 'sent',
          operation: 'end',
          message: 'Ending resident session · Prime Continuim will not send another kill automatically',
        }
      : { state: 'idle', message: 'Ready for a new prompt' }
    return snapshot
  }

  if (visualState === 'candidate-evaluation-review') {
    const thread = snapshot.threads.find((candidate) => candidate.id === 'thread-protocol')
    const host = snapshot.hosts.find((candidate) => candidate.id === 'host-local')
    if (!thread || !host) return snapshot
    snapshot.selectedProjectId = thread.projectId
    snapshot.selectedThreadId = thread.id
    thread.status = 'idle'
    thread.workspaceId = 'candidate-preview-workspace'
    thread.executionGenerationId = 'candidate-preview-generation'
    host.kind = 'local'
    host.connection = 'online'
    host.connectionPath = 'Local socket'
    host.latencyMs = 2
    delete host.lastSynchronized
    snapshot.runtime = {}
    snapshot.operations = {
      submitCommands: false,
      startResidentTurn: false,
      stopResidentTurn: false,
      crossHostHandoff: false,
      candidateEvaluationProbe: true,
    }
    snapshot.composerReceipt = { state: 'idle', message: 'Ready for a new prompt' }
    return snapshot
  }

  const selectedThread = snapshot.threads.find((thread) => thread.id === snapshot.selectedThreadId)
  const selectedHost = snapshot.hosts.find((host) => host.id === selectedThread?.hostId)
  const session = snapshot.runtime.session
  if (!selectedThread || !selectedHost || !session) return snapshot

  selectedHost.connection = 'online'
  selectedHost.connectionPath = 'SSH'
  selectedHost.latencyMs = 24
  delete selectedHost.lastSynchronized
  session.isStreaming = false
  session.isCompacting = false
  session.isBashRunning = false
  session.queuedActionCount = 0
  snapshot.runtime.queue = { pendingCount: 0, paused: false }
  snapshot.operations.submitCommands = true
  snapshot.operations.startResidentTurn = false
  snapshot.operations.stopResidentTurn = false

  const previewUpdate = selectedThread.transcript.find((block) => block.id === 'block-5')
  const setPreviewUpdate = (body: string, detail: string) => {
    if (!previewUpdate) return
    previewUpdate.body = previewSimulation(body)
    previewUpdate.detail = previewSimulation(detail)
  }

  if (visualState === 'idle' || visualState === 'hud-expanded' || visualState === 'hud-buddy') {
    if (visualState === 'hud-expanded' || visualState === 'hud-buddy') {
      selectedThread.workspaceId = 'workspace-preview-hud'
      selectedThread.executionGenerationId = 'execution-preview-hud'
    }
    selectedThread.status = 'idle'
    snapshot.operations.startResidentTurn = true
    snapshot.composerReceipt = { state: 'idle', message: 'Ready for a new prompt' }
    setPreviewUpdate(
      'fixture resident session is attached and ready for another prompt',
      'no prompt was sent to a host',
    )
    return snapshot
  }

  if (visualState === 'prompt-admission') {
    selectedThread.status = 'idle'
    // The local draft remains editable while this exact submission is being
    // admitted; only the submit action is fenced by the sending receipt.
    snapshot.operations.startResidentTurn = true
    snapshot.composerReceipt = {
      state: 'sending',
      operation: 'prompt',
      message: 'Host received the prompt · awaiting durable admission',
    }
    setPreviewUpdate(
      'fixture prompt crossed the connection and is awaiting durable host admission',
      'Prime Agent does not own this fixture prompt yet',
    )
    return snapshot
  }

  if (visualState === 'prompt-awaiting-idle-proof') {
    selectedThread.status = 'running'
    session.isStreaming = true
    session.queuedActionCount = 1
    snapshot.runtime.queue = { pendingCount: 1, paused: false }
    snapshot.operations.stopResidentTurn = true
    snapshot.composerReceipt = {
      state: 'sent',
      operation: 'prompt',
      message: 'Prime Agent owns this prompt · waiting for authoritative idle proof',
    }
    setPreviewUpdate(
      'fixture prompt was acknowledged by Prime Agent',
      'the preview retains ownership until an exact idle proof',
    )
    return snapshot
  }

  if (visualState === 'stop-awaiting-idle-proof') {
    // The projection may report idle before the exact Stop receipt completes.
    // Retained command ownership must keep the Stop surface visible meanwhile.
    selectedThread.status = 'idle'
    snapshot.composerReceipt = {
      state: 'sent',
      operation: 'abort',
      message: 'Stop accepted · waiting for authoritative idle proof',
    }
    setPreviewUpdate(
      'fixture Stop request was acknowledged at a safe boundary',
      'the Stop remains nonterminal until exact idle proof',
    )
    return snapshot
  }

  selectedThread.status = 'idle'
  snapshot.composerReceipt = {
    state: 'uncertain',
    operation: 'abort',
    retryable: false,
    message: 'Outcome unknown · recovery required; this Stop will not be replayed',
  }
  setPreviewUpdate(
    'fixture Stop outcome cannot be proven after the command boundary',
    'Prime Agent will not replay this Stop without exact recovery evidence',
  )
  return snapshot
}

const discoveredComputers: DiscoveredComputer[] = [
  {
    alias: 'devbox',
    effectiveTarget: 'ebene@devbox.internal:22',
    fingerprint: 'Visual QA fixture; no live host key was checked.',
    protocol: 'SSH · Ed25519 host key',
    platform: 'Ubuntu 24.04',
    architecture: 'arm64',
    diskFree: '186 GB free',
    gitVersion: 'Git 2.45.2',
    pythonStatus: 'Python 3.12 · IPython ready',
    agentVersion: 'Prime Agent 0.7.0',
    hostServiceVersion: 'Not installed',
    requiresInstall: true,
    installCommand: 'No signed host-service installer is available in this build.',
    recentProjects: ['~/work/prime-agent-native', '~/work/control-plane'],
    probeComplete: true,
    installAvailable: false,
    installDeferredReason: 'The signed Continuim host-service installer is not bundled in this build.',
  },
  {
    alias: 'build-linux',
    effectiveTarget: 'builder@10.24.8.17:2222',
    fingerprint: 'Visual QA fixture; no live host key was checked.',
    protocol: 'SSH via corp-bastion · Ed25519 host key',
    platform: 'Debian 13',
    architecture: 'x86_64',
    diskFree: '92 GB free',
    gitVersion: 'Git 2.47.1',
    pythonStatus: 'Python 3.13 · IPython ready',
    agentVersion: 'Prime Agent 0.7.0',
    hostServiceVersion: 'Host service 0.1.0 · running',
    requiresInstall: false,
    installCommand:
      "ssh build-linux 'prime-agent-hostd install --version 0.1.0 --user --verify-signature'",
    recentProjects: ['~/src/prime-agent-native'],
    probeComplete: true,
    installAvailable: true,
  },
]

const previewRuntimeModelCatalog: RuntimeModelCatalogSnapshot = RuntimeModelCatalogSnapshotSchema.parse({
  runtime: 'prime_agent',
  releaseVersion: '0.7.0',
  observedAt: '2026-08-07T12:00:00.000Z',
  providers: [
    {
      providerId: 'openai-codex',
      displayName: 'ChatGPT Plus/Pro (Codex Subscription)',
      oauthSupported: true,
      oauthUsesCallbackServer: true,
      configured: true,
      authSource: 'stored',
      modelCount: 3,
      availableModelCount: 3,
    },
    {
      providerId: 'anthropic',
      displayName: 'Anthropic (Claude Pro/Max)',
      oauthSupported: true,
      oauthUsesCallbackServer: true,
      configured: false,
      modelCount: 2,
      availableModelCount: 0,
    },
    {
      providerId: 'github-copilot',
      displayName: 'GitHub Copilot',
      oauthSupported: true,
      configured: false,
      modelCount: 1,
      availableModelCount: 0,
    },
    {
      providerId: 'prime-inference',
      displayName: 'Prime Inference',
      oauthSupported: false,
      configured: true,
      authSource: 'prime_cli',
      modelCount: 5,
      availableModelCount: 5,
    },
    {
      providerId: 'google',
      displayName: 'Google Gemini',
      oauthSupported: false,
      configured: false,
      modelCount: 1,
      availableModelCount: 0,
    },
    {
      providerId: 'xai',
      displayName: 'xAI',
      oauthSupported: false,
      configured: false,
      modelCount: 1,
      availableModelCount: 0,
    },
  ],
  models: [
    { providerId: 'openai-codex', modelId: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', api: 'openai-codex-responses', reasoning: true, input: ['text', 'image'], contextWindow: 272_000, maxOutputTokens: 128_000, available: true, usingOAuth: true },
    { providerId: 'openai-codex', modelId: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', api: 'openai-codex-responses', reasoning: true, input: ['text', 'image'], contextWindow: 272_000, maxOutputTokens: 128_000, available: true, usingOAuth: true },
    { providerId: 'openai-codex', modelId: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', api: 'openai-codex-responses', reasoning: true, input: ['text', 'image'], contextWindow: 272_000, maxOutputTokens: 128_000, available: true, usingOAuth: true },
    { providerId: 'anthropic', modelId: 'claude-opus-5', name: 'Claude Opus 5', api: 'anthropic-messages', reasoning: true, input: ['text', 'image'], contextWindow: 1_000_000, maxOutputTokens: 128_000, available: false, usingOAuth: false },
    { providerId: 'anthropic', modelId: 'claude-sonnet-5', name: 'Claude Sonnet 5', api: 'anthropic-messages', reasoning: true, input: ['text', 'image'], contextWindow: 1_000_000, maxOutputTokens: 128_000, available: false, usingOAuth: false },
    { providerId: 'github-copilot', modelId: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', api: 'openai-responses', reasoning: true, input: ['text', 'image'], contextWindow: 272_000, maxOutputTokens: 128_000, available: false, usingOAuth: false },
    { providerId: 'prime-inference', modelId: 'moonshotai/kimi-k3', name: 'Kimi K3', api: 'openai-completions', reasoning: true, input: ['text'], contextWindow: 1_048_576, maxOutputTokens: 1_048_576, available: true, usingOAuth: false },
    { providerId: 'prime-inference', modelId: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', api: 'openai-completions', reasoning: true, input: ['text'], contextWindow: 1_048_576, maxOutputTokens: 384_000, available: true, usingOAuth: false },
    { providerId: 'prime-inference', modelId: 'qwen/qwen3.7-flash', name: 'Qwen3.7 Flash', api: 'openai-completions', reasoning: true, input: ['text'], contextWindow: 1_000_000, maxOutputTokens: 65_536, available: true, usingOAuth: false },
    { providerId: 'prime-inference', modelId: 'z-ai/glm-5.2', name: 'GLM 5.2', api: 'openai-completions', reasoning: true, input: ['text'], contextWindow: 1_048_576, maxOutputTokens: 262_144, available: true, usingOAuth: false },
    { providerId: 'prime-inference', modelId: 'minimax/minimax-m3', name: 'MiniMax M3', api: 'openai-completions', reasoning: true, input: ['text'], contextWindow: 524_288, maxOutputTokens: 512_000, available: true, usingOAuth: false },
    { providerId: 'google', modelId: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', api: 'google-generative-ai', reasoning: true, input: ['text', 'image'], contextWindow: 1_048_576, maxOutputTokens: 65_536, available: false, usingOAuth: false },
    { providerId: 'xai', modelId: 'grok-4.5', name: 'Grok 4.5', api: 'openai-completions', reasoning: true, input: ['text', 'image'], contextWindow: 500_000, maxOutputTokens: 500_000, available: false, usingOAuth: false },
  ],
})

const previewCandidateEvaluationBoundary = {
  securitySandbox: false,
  mainFilesystemIsolation: false,
  providerBackedEvaluation: false,
  autonomousPromotion: false,
  candidateControlledEvaluation: true,
  packageOrInstallerGate: false,
  authenticated: false,
  integrity: 'sha256-correlation-only-not-authentication' as const,
}

const previewCandidateEvaluationReview: CandidateEvaluationReviewIdentity = {
  headCommit: 'a'.repeat(40),
  gitIndexSha256: '1'.repeat(64),
  gitIndexBytes: 1_024,
  packageManifestSha256: '2'.repeat(64),
  lockfileSha256: '3'.repeat(64),
  lockfileBytes: 32_768,
  nodeVersionPinSha256: '4'.repeat(64),
  selfBuildEntrypointSha256: '5'.repeat(64),
  launcherBootstrapSha256: 'a'.repeat(64),
  launcherBootstrapFileCount: 9,
  runtimePointerSha256: '6'.repeat(64),
  nodePackageManifestSha256: '7'.repeat(64),
  nodeExecutableSha256: '8'.repeat(64),
  pnpmCliSha256: '9'.repeat(64),
  reviewAggregateSha256: '0'.repeat(64),
}

const previewCandidateEvaluationAuthority: CandidateEvaluationPreflightRequest = {
  expectedHostId: 'host-local',
  threadId: 'thread-protocol',
  expectedExecutionGenerationId: 'candidate-preview-generation',
}

const previewCandidateEvaluationPreflight = CandidateEvaluationPreflightSchema.parse({
  preflightVersion: 1,
  ...previewCandidateEvaluationAuthority,
  observedAt: '2026-08-09T12:00:00.000Z',
  boundary: previewCandidateEvaluationBoundary,
  status: 'ready',
  capability: PRIME_CONTINUIM_SELF_BUILD_EVALUATION_CAPABILITY,
  review: previewCandidateEvaluationReview,
  executor: {
    kind: 'canonical_self_build',
    gateProcessContainment: 'windows_job',
    requiredNodeVersion: '24.14.0',
    requiredPnpmVersion: '11.9.0',
    verification: 'passive-structure-before-consent;canonical-toolchain-inside-evaluation',
    launcherSource: 'workspace-dependency-tree-candidate-controlled',
  },
})

const previewCandidateEvaluationSnapshot = CandidateEvaluationSnapshotSchema.parse({
  snapshotVersion: 1,
  ...previewCandidateEvaluationAuthority,
  generatedAt: '2026-08-09T12:00:01.000Z',
  repeatEffectsWarningRequired: false,
  evaluations: [],
})

class BrowserPreviewApi implements RendererApi {
  readonly environment: 'native' | 'preview'
  private previewHudState: HudState = { state: 'closed' }
  private readonly hudListeners = new Set<(state: HudState) => void>()

  constructor(private readonly visualState: PreviewVisualState = 'reconnecting') {
    this.environment = visualState === 'candidate-evaluation-review' ? 'native' : 'preview'
    if (visualState === 'hud-expanded' || visualState === 'hud-buddy') {
      this.previewHudState = {
        state: visualState === 'hud-buddy' ? 'buddy' : 'expanded',
        target: {
          expectedHostId: 'host-devbox',
          threadId: 'thread-seamless',
          expectedExecutionGenerationId: 'execution-preview-hud',
        },
        ignoresMouseEvents: false,
      }
    }
  }

  async loadWorkbench(): Promise<WorkbenchSnapshot> {
    await delay(120)
    return previewSnapshotForVisualState(this.visualState)
  }

  private publishHudState(state: HudState): HudState {
    this.previewHudState = state
    for (const listener of this.hudListeners) listener(state)
    return state
  }

  async hudOpen(target: HudTarget): Promise<HudState> {
    return this.publishHudState({ state: 'expanded', target, ignoresMouseEvents: false })
  }

  async hudState(): Promise<HudState> {
    return this.previewHudState
  }

  async hudSetMode(mode: HudMode): Promise<HudState> {
    if (this.previewHudState.state === 'closed') return this.previewHudState
    return this.publishHudState({
      state: mode,
      target: this.previewHudState.target,
      ignoresMouseEvents: false,
    })
  }

  async hudClose(): Promise<HudState> {
    return this.publishHudState({ state: 'closed' })
  }

  async hudReturnToWorkbench(): Promise<void> {
    // Browser preview has no native workbench window to focus.
  }

  async hudSetIgnoreMouseEvents(ignore: boolean): Promise<HudState> {
    if (this.previewHudState.state === 'closed') return this.previewHudState
    return this.publishHudState({ ...this.previewHudState, ignoresMouseEvents: ignore })
  }

  onHudState(listener: (state: HudState) => void): () => void {
    this.hudListeners.add(listener)
    return () => this.hudListeners.delete(listener)
  }

  async retryLocalSetup(): Promise<void> {
    throw new Error('Local setup retry is available only in the native desktop app.')
  }

  async repairLocalRuntime(): Promise<void> {
    throw new Error('Local runtime repair is available only in the native desktop app.')
  }

  async selectThread(_threadId: string): Promise<void> {
    // Browser preview data is already materialized in memory. The native
    // adapter overrides this boundary with an authoritative host request.
  }

  async activateComputer(_expectedHostId: string): Promise<WorkbenchSnapshot> {
    throw new Error('Connecting a saved computer is available only in the native desktop app.')
  }

  async loadRuntimeModelCatalog(_hostId: string): Promise<RuntimeModelCatalogSnapshot> {
    await delay(180)
    return structuredClone(previewRuntimeModelCatalog)
  }

  async selectResidentWorkspace(_input: { resumeOperationId?: string } = {}): Promise<ResidentWorkspaceSelection> {
    if (this.visualState === 'resident-start' || this.visualState === 'resident-recovery') {
      return {
        selectionToken: 'preview-selection-token',
        operationId: _input.resumeOperationId ?? 'resident-preview-create',
        expectedHostId: previewSnapshot.hosts[0]?.id ?? 'local-preview',
        suggestedName: 'Continuim desktop',
        expiresAt: '2099-08-07T12:05:00.000Z',
      }
    }
    throw new Error('Resident workspace selection is available only in the native desktop app.')
  }

  async provisionResident(_input: {
    selectionToken: string
    projectDisplayName: string
    threadTitle: string
    sessionName?: string
  }): Promise<ResidentLifecycleStatus> {
    throw new Error('Resident provisioning is unavailable in the browser preview.')
  }

  async prepareResidentEnd(_input: {
    expectedHostId: string
    projectId: string
    workspaceId: string
    threadId: string
    executionGenerationId: string
    resumeOperationId?: string
  }): Promise<ResidentEndPreparation> {
    if (this.visualState === 'resident-end-review') {
      return {
        confirmationToken: 'preview-end-confirmation',
        operationId: _input.resumeOperationId ?? 'resident-preview-end',
        expectedHostId: _input.expectedHostId,
        threadId: _input.threadId,
        executionGenerationId: _input.executionGenerationId,
        expiresAt: '2099-08-07T12:05:00.000Z',
      }
    }
    throw new Error('Resident session ending is unavailable in the browser preview.')
  }

  async endResident(_input: { confirmationToken: string; consent: true }): Promise<ResidentLifecycleStatus> {
    throw new Error('Resident session ending is unavailable in the browser preview.')
  }

  async residentLifecycleStatus(_input: {
    expectedHostId: string
    operationId: string
  }): Promise<ResidentLifecycleStatus | null> {
    return null
  }

  async candidateEvaluationPreflight(
    input: CandidateEvaluationPreflightRequest,
  ): Promise<CandidateEvaluationPreflight> {
    if (
      this.visualState !== 'candidate-evaluation-review' ||
      !candidateEvaluationAuthorityMatches(input, previewCandidateEvaluationAuthority)
    ) throw new Error('Candidate evaluation preflight is available only in its internal visual-QA state.')
    return structuredClone(previewCandidateEvaluationPreflight)
  }

  async candidateEvaluationSnapshot(
    input: CandidateEvaluationPreflightRequest,
  ): Promise<CandidateEvaluationSnapshot> {
    if (
      this.visualState !== 'candidate-evaluation-review' ||
      !candidateEvaluationAuthorityMatches(input, previewCandidateEvaluationAuthority)
    ) throw new Error('Candidate evaluation history is available only in its internal visual-QA state.')
    return structuredClone(previewCandidateEvaluationSnapshot)
  }

  async startCandidateEvaluation(_input: CandidateEvaluationStartRequest): Promise<CandidateEvaluationStatus> {
    throw new Error('The visual-QA renderer never invokes candidate code.')
  }

  async discoverComputers(): Promise<DiscoveredComputer[]> {
    await delay(180)
    return structuredClone(discoveredComputers)
  }

  async probeComputer(input: { alias?: string; hostname?: string; user?: string }): Promise<DiscoveredComputer> {
    await delay(420)
    const selected = discoveredComputers.find((computer) => computer.alias === input.alias)
    if (selected) return structuredClone(selected)

    const hostname = input.hostname?.trim() || 'manual-host.example.com'
    const user = input.user?.trim() || 'developer'
    return {
      ...structuredClone(discoveredComputers[0]!),
      alias: hostname,
      effectiveTarget: `${user}@${hostname}:22`,
      fingerprint: 'Visual QA fixture; no live host key was checked.',
      recentProjects: [],
      probeComplete: true,
      installAvailable: true,
    }
  }

  async addComputer(input: {
    alias: string
    installHostService: boolean
    installCommandAcknowledged: boolean
  }): Promise<{ host: HostSummary }> {
    await delay(520)
    return {
      host: {
        id: `host-${input.alias}`,
        name: input.alias,
        kind: 'ssh',
        connection: 'online',
        connectionPath: 'SSH',
        latencyMs: 34,
        compatibility: 'compatible',
      },
    }
  }

  async sendComposer(request: ComposerRequest): Promise<{ state: ComposerReceiptState; message: string; retryable?: boolean }> {
    await delay(240)
    return { state: 'sent', message: previewSimulation('prompt not sent to a host') }
  }

  async abortThread(_threadId: string): Promise<{ state: ComposerReceiptState; message: string }> {
    await delay(180)
    return { state: 'sent', message: previewSimulation('stop request not sent to a host') }
  }

  async planHandoff(input: {
    threadId: string
    destinationHostId: string
    behaviorIfRunning: 'interrupt' | 'wait_for_idle'
  }): Promise<HandoffPlan> {
    await delay(220)
    const sourceThread = previewSnapshot.threads.find((thread) => thread.id === input.threadId)
    const source = previewSnapshot.hosts.find((host) => host.id === sourceThread?.hostId)
    const destination = previewSnapshot.hosts.find((host) => host.id === input.destinationHostId)

    return {
      handoffId: 'preview_simulation_handoff_01J8WR50M5WQ',
      sourceHostId: source?.id ?? 'host-devbox',
      sourceName: source?.name ?? 'devbox',
      destinationHostId: destination?.id ?? input.destinationHostId,
      destinationName: destination?.name ?? 'This computer',
      repository: 'prime-agent-native',
      destinationProject: 'Prime Continuim',
      branch: 'feat/seamless-remote',
      dirtyFiles: 6,
      untrackedFiles: 2,
      transferSize: '4.8 MB',
      repositoryMatch: 'exact',
      runtimeLosses: ['Python variables', 'Running subprocesses', 'Active child processes'],
      warnings: [
        previewSimulation('no host checkpoint or transfer will run'),
        'Secrets and ignored files are excluded from the fixture transfer.',
      ],
    }
  }

  async startHandoff(
    input: { handoffId: string; behaviorIfRunning: 'interrupt' | 'wait_for_idle' },
    onProgress: (phase: HandoffPhase, message: string) => void,
  ): Promise<{ destinationHostId: string; receiptId: string }> {
    const phases: Array<[HandoffPhase, string]> = [
      ['quiescing', previewSimulation(input.behaviorIfRunning === 'interrupt' ? 'simulating an interrupted turn' : 'simulating a completed turn')],
      ['checkpointing', previewSimulation('simulating a source checkpoint; no checkpoint is created')],
      ['transferring', previewSimulation('simulating a 4.8 MB state transfer; no bytes are sent')],
      ['materializing', previewSimulation('simulating a destination worktree; no files are created')],
      ['verifying', previewSimulation('simulating hash and Git-status checks')],
      ['switching_authority', previewSimulation('simulating an authority switch; host authority is unchanged')],
      ['complete', previewSimulation('fixture handoff complete; no host state changed')],
    ]
    for (const [phase, message] of phases) {
      await delay(260)
      onProgress(phase, message)
    }
    return { destinationHostId: 'host-local', receiptId: 'preview_simulation_handoff_receipt_01J8WR8NB2' }
  }
}

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

function displayTime(value: unknown): string {
  const dateValue = asString(value)
  if (!dateValue || !Number.isFinite(Date.parse(dateValue))) return ''
  const date = new Date(dateValue)
  const delta = Date.now() - date.getTime()
  if (delta >= 0 && delta < 60_000) return 'Now'
  if (delta >= 0 && delta < 60 * 60_000) return `${Math.max(1, Math.floor(delta / 60_000))} min`
  if (delta >= 0 && delta < 24 * 60 * 60_000) return `${Math.max(1, Math.floor(delta / (60 * 60_000)))} h`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

function clockTime(value: unknown): string {
  const dateValue = asString(value)
  if (!dateValue || !Number.isFinite(Date.parse(dateValue))) return ''
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(dateValue))
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

  constructor(message: string, options: { code?: string; receiptId?: string; details?: UnknownRecord }) {
    super(message)
    this.name = 'NativeBridgeError'
    this.code = options.code
    this.receiptId = options.receiptId
    this.details = options.details
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
  const suffix = [code, receipt ? `receipt ${receipt}` : undefined].filter(Boolean).join(' · ')
  return new NativeBridgeError(suffix ? `${message} (${suffix})` : message, {
    ...(code ? { code } : {}),
    ...(receipt ? { receiptId: receipt } : {}),
    ...(asRecord(error?.details) ? { details: asRecord(error?.details) } : {}),
  })
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
    throw new Error('The native workspace picker returned an invalid path-free selection receipt.')
  }
  return { selectionToken, operationId, expectedHostId, suggestedName, expiresAt }
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
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}:${uuid}`
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
    body: text,
  }
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
      const createdAt = asString(entry.createdAt)
      const updatedAt = asString(entry.updatedAt)
      const state = asString(entry.state) as ResidentLifecycleOperationState | undefined
      const parsedStatus = entry.lastStatus === undefined
        ? undefined
        : ResidentLifecycleStatusSchema.safeParse(entry.lastStatus)
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
  const parsedResidentLifecycle = ResidentLifecycleDispositionSchema.safeParse(threadSnapshot?.residentLifecycle)
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
      transcript: isMaterialized ? recentBlocks : [],
    }
  })

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
  const selectedHostHasAuthority = Boolean(activeHostId && selectedThread?.hostId === activeHostId)
  const hostName = hosts.find((host) => host.id === selectedThread?.hostId)?.name ?? 'Execution host'
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
  const agents: AgentSummary[] = childAgents.map((agent, index) => {
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
      ...(asString(agent.model) ? { model: asString(agent.model) } : {}),
      ...(activity ? { activity } : {}),
      ...(asNumber(agent.durationMs) !== undefined ? { durationMs: asNumber(agent.durationMs) } : {}),
      ...(asNumber(agent.toolUseCount) !== undefined ? { toolUseCount: asNumber(agent.toolUseCount) } : {}),
      ...(asNumber(agent.tokenCount) !== undefined ? { tokenCount: asNumber(agent.tokenCount) } : {}),
      ...(asString(agent.recap) ? { recap: asString(agent.recap) } : {}),
      ...(asString(agent.error) ? { error: asString(agent.error) } : {}),
    }
  })

  const runtime: RuntimeSummary = {}
  if (selectedSnapshotIsMaterialized) {
    const rawSession = asRecord(threadSnapshot?.runtime)
    if (rawSession && asString(rawSession.runtime) === 'prime_agent') {
      const residency = asString(rawSession.residency)
      const rawContext = asRecord(rawSession.context)
      const usedTokens = asNumber(rawContext?.usedTokens)
      runtime.session = {
        residency: residency === 'resident' || residency === 'client_owned' ? residency : 'unknown',
        ...(asString(rawSession.appVersion) ? { appVersion: asString(rawSession.appVersion) } : {}),
        ...(asString(rawSession.activeSessionId) ? { activeSessionId: asString(rawSession.activeSessionId) } : {}),
        ...(asString(rawSession.sessionId) ? { sessionId: asString(rawSession.sessionId) } : {}),
        ...(asString(rawSession.sessionName) ? { sessionName: asString(rawSession.sessionName) } : {}),
        ...(asString(rawSession.model) ? { model: asString(rawSession.model) } : {}),
        ...(asString(rawSession.thinkingLevel) ? { thinkingLevel: asString(rawSession.thinkingLevel) } : {}),
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
        ...(usedTokens !== undefined
          ? { context: {
              usedTokens,
              ...(asNumber(rawContext?.maxTokens) !== undefined ? { maxTokens: asNumber(rawContext?.maxTokens) } : {}),
            } }
          : {}),
      }
    }

    if (runtime.session || childAgents.length > 0) runtime.agentsReported = true

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
    const matchingThread = threads.find((thread) =>
      thread.hostId === receiptHostId &&
      protocolThreadId(thread) === receiptThreadId &&
      thread.executionGenerationId === receiptExecutionGenerationId,
    )
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
      hostName: hosts.find((host) => host.id === matchingThread.hostId)?.name ?? 'Execution host',
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
    const matchingThread = threads.find((thread) =>
      thread.hostId === entryHostId &&
      protocolThreadId(thread) === commandThreadId &&
      thread.executionGenerationId === commandGenerationId
    )
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
      hostName: hosts.find((host) => host.id === entryHostId)?.name ?? 'Execution host',
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
    : { state: 'idle', message: hosts.find((host) => host.id === selectedThread?.hostId)?.connection === 'online' ? 'Ready to send' : 'Waiting for connection' }

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
  const residentSessionReady = Boolean(
    input.mutationAuthorityReady !== false &&
    selectedHostHasAuthority &&
    activePhase === 'online' &&
    selectedSnapshotIsMaterialized &&
    advertisedCapabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY) &&
    runtime.session?.residency === 'resident' &&
    runtime.session.activeSessionId &&
    runtime.session.sessionId &&
    !selectedResidentEnd &&
    selectedThread?.residentLifecycle?.state !== 'ended',
  )
  const residentProvisioningReady = Boolean(
    input.mutationAuthorityReady !== false &&
    activePhase === 'online' &&
    asString(activeTarget?.kind) === 'local' &&
    asString(rawConnection?.path) === 'local_socket' &&
    exactActiveRuntimeReadiness?.kind === 'reported' &&
    exactActiveRuntimeReadiness.freshness === 'live' &&
    exactActiveRuntimeReadiness.status === 'ready' &&
    advertisedCapabilities.includes(RESIDENT_LIFECYCLE_CAPABILITY),
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
    residentProvisioningReady,
    residentLifecycleAdvertised: advertisedCapabilities.includes(RESIDENT_LIFECYCLE_CAPABILITY),
  })
  const residentTurnActive = Boolean(
    selectedThread?.status === 'running' ||
    runtime.session?.isStreaming ||
    runtime.session?.isCompacting ||
    runtime.session?.isBashRunning ||
    (runtime.session?.queuedActionCount ?? 0) > 0,
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
    ...(localSetup ? { localSetup } : {}),
    residentLifecycleOperations,
    operations: {
      submitCommands: residentSessionReady,
      startResidentTurn:
        residentSessionReady &&
        !residentTurnActive &&
        !retainedPromptOwned &&
        !promptDispatchPending &&
        !abortCommandPending &&
        selectedThread?.status !== 'waiting' &&
        selectedThread?.status !== 'needs_approval',
      stopResidentTurn: residentSessionReady && !abortCommandPending && (residentTurnActive || retainedPromptOwned),
      ...(residentProvisioningReady ? { provisionResident: true } : {}),
      crossHostHandoff:
        selectedHostHasAuthority &&
        activePhase === 'online' &&
        advertisedCapabilities.includes(THREAD_HANDOFF_CAPABILITY),
      ...(selectedHostHasAuthority &&
      activePhase === 'online' &&
      advertisedCapabilities.includes(RUNTIME_MODEL_CATALOG_CAPABILITY)
        ? { modelCatalog: true }
        : {}),
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
          message: selectedResidentEnd.lastStatus?.phase === 'quarantined'
            ? 'End outcome unknown · this resident session stays locked for inspection'
            : selectedResidentEnd.lastStatus?.phase === 'completed'
              ? 'Resident session ended · saved thread remains available'
              : 'Ending resident session · Prime Continuim will not send another kill automatically',
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
  private readonly residentWorkspaceSelections = new Map<string, ResidentWorkspaceSelection>()
  private readonly residentEndPreparations = new Map<string, ResidentEndPreparation>()
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

  async hudOpen(target: HudTarget): Promise<HudState> {
    return this.call<HudState>('hudOpen', target)
  }

  async candidateEvaluationPreflight(
    input: CandidateEvaluationPreflightRequest,
  ): Promise<CandidateEvaluationPreflight> {
    const preflight = CandidateEvaluationPreflightSchema.parse(
      await this.call<unknown>('candidateEvaluationPreflight', input),
    )
    if (!candidateEvaluationAuthorityMatches(input, preflight)) throw new StaleHostAuthorityError()
    return preflight
  }

  async startCandidateEvaluation(
    input: CandidateEvaluationStartRequest,
  ): Promise<CandidateEvaluationStatus> {
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
    this.residentEndPreparations.clear()
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
      const parsedStatus = ResidentLifecycleStatusSchema.safeParse(entry.lastStatus)
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
    authority: { expectedHostId: string; generation: number },
  ): Promise<void> {
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
    const catalog = await this.call<unknown>('hostCatalog')
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
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
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
    if (selectionGeneration !== this.threadSelectionGeneration) throw new StaleHostAuthorityError()
    const currentThread = this.projectedResidentThread(status)
    const snapshotLocation = asRecord(asRecord(asRecord(snapshot)?.thread)?.currentLocation)
    const endDisposition = ResidentLifecycleDispositionSchema.safeParse(
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
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
    if (selectionGeneration !== this.threadSelectionGeneration) throw new StaleHostAuthorityError()
    const finalThread = this.projectedResidentThread(status)
    if (!finalThread || finalThread.id !== projectedThread.id) throw new StaleHostAuthorityError()

    this.selectedThreadId = finalThread.id
    this.threadSelectionGeneration += 1
    this.threadSnapshot = materializedSnapshot
    this.setResidentLifecycleProjectionState(status, 'terminal')
    this.publish()
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
  }

  private forceCommittedResidentMaterialization(
    status: ResidentLifecycleStatus,
    authority: { expectedHostId: string; generation: number },
  ): Promise<void> {
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
    if (this.setResidentLifecycleProjectionState(status, 'terminal_refresh_pending')) this.publish()
    const previous = this.authoritativeRefreshPromise
    const refresh = (async () => {
      // A refresh that started before the committed reply cannot prove the new
      // thread exists. Let it drain, fence its authority, then issue a distinct
      // catalog + exact-thread observation after the reply.
      if (previous) await previous.catch(() => undefined)
      this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
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
    return RuntimeModelCatalogSnapshotSchema.parse(raw)
  }

  private residentLifecycleAuthority(options: { requireCapability: boolean }): {
    expectedHostId: string
    generation: number
  } {
    const connection = asRecord(this.connection)
    const expectedHostId = asString(connection?.hostId)
    const phase = asString(connection?.phase)
    const target = asRecord(connection?.target)
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : []
    if (
      !expectedHostId ||
      phase !== 'online' ||
      asString(target?.kind) !== 'local' ||
      asString(connection?.path) !== 'local_socket' ||
      this.mutationAuthorityReadyHostId !== expectedHostId ||
      (options.requireCapability && !capabilities.includes(RESIDENT_LIFECYCLE_CAPABILITY))
    ) {
      throw new Error(options.requireCapability
        ? 'Resident lifecycle control is not ready on this verified local host.'
        : 'Reconnect this verified local host before checking resident lifecycle status.')
    }
    return { expectedHostId, generation: this.connectionGeneration }
  }

  private assertResidentLifecycleAuthority(expectedHostId: string, generation: number): void {
    const connection = asRecord(this.connection)
    if (
      generation !== this.connectionGeneration ||
      asString(connection?.phase) !== 'online' ||
      asString(connection?.hostId) !== expectedHostId ||
      asString(asRecord(connection?.target)?.kind) !== 'local' ||
      asString(connection?.path) !== 'local_socket'
    ) throw new StaleHostAuthorityError()
  }

  async selectResidentWorkspace(
    input: { resumeOperationId?: string } = {},
  ): Promise<ResidentWorkspaceSelection> {
    const authority = this.residentLifecycleAuthority({ requireCapability: true })
    const selection = residentWorkspaceSelectionFromNative(
      await this.call<unknown>('selectResidentWorkspace', input),
    )
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
    if (selection.expectedHostId !== authority.expectedHostId || Date.parse(selection.expiresAt) <= Date.now()) {
      throw new StaleHostAuthorityError()
    }
    for (const [token, retained] of this.residentWorkspaceSelections) {
      if (Date.parse(retained.expiresAt) <= Date.now()) this.residentWorkspaceSelections.delete(token)
    }
    if (this.residentWorkspaceSelections.size >= 32) {
      const oldestToken = [...this.residentWorkspaceSelections.entries()]
        .sort((left, right) => Date.parse(left[1].expiresAt) - Date.parse(right[1].expiresAt))[0]?.[0]
      if (oldestToken) this.residentWorkspaceSelections.delete(oldestToken)
    }
    this.residentWorkspaceSelections.set(selection.selectionToken, selection)
    return { ...selection }
  }

  async provisionResident(input: {
    selectionToken: string
    projectDisplayName: string
    threadTitle: string
    sessionName?: string
  }): Promise<ResidentLifecycleStatus> {
    const authority = this.residentLifecycleAuthority({ requireCapability: true })
    const selection = this.residentWorkspaceSelections.get(input.selectionToken)
    if (
      !selection ||
      selection.expectedHostId !== authority.expectedHostId ||
      Date.parse(selection.expiresAt) <= Date.now()
    ) throw new Error('Choose the workspace folder again before starting this resident thread.')

    // The main process consumes this receipt at the invocation boundary. Drop
    // the renderer copy first so no UI retry can replay an ambiguous mutation.
    this.residentWorkspaceSelections.delete(input.selectionToken)
    let status: ResidentLifecycleStatus | undefined
    let statusAccepted = false
    try {
      status = ResidentLifecycleStatusSchema.parse(
        await this.call<unknown>('provisionResident', input),
      )
      this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
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
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
    if (status.phase === 'committed') {
      await this.forceCommittedResidentMaterialization(status, authority)
    }
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
    return status
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
    const preparation = residentEndPreparationFromNative(
      await this.call<unknown>('prepareResidentEnd', input),
    )
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
    if (
      preparation.expectedHostId !== authority.expectedHostId ||
      preparation.threadId !== input.threadId ||
      preparation.executionGenerationId !== input.executionGenerationId ||
      (input.resumeOperationId && preparation.operationId !== input.resumeOperationId) ||
      Date.parse(preparation.expiresAt) <= Date.now()
    ) throw new StaleHostAuthorityError()
    this.residentEndPreparations.clear()
    this.residentEndPreparations.set(preparation.confirmationToken, preparation)
    return { ...preparation }
  }

  async endResident(input: { confirmationToken: string; consent: true }): Promise<ResidentLifecycleStatus> {
    const authority = this.residentLifecycleAuthority({ requireCapability: true })
    const preparation = this.residentEndPreparations.get(input.confirmationToken)
    if (
      !preparation ||
      preparation.expectedHostId !== authority.expectedHostId ||
      Date.parse(preparation.expiresAt) <= Date.now()
    ) throw new Error('Review this resident session again before ending it.')

    // Both renderer and main consume the authorization before the mutation
    // boundary. An ambiguous response can only be reconciled by operation ID.
    this.residentEndPreparations.delete(input.confirmationToken)
    let status: ResidentLifecycleStatus | undefined
    let statusAccepted = false
    try {
      status = ResidentLifecycleStatusSchema.parse(
        await this.call<unknown>('endResident', input),
      )
      this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
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
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
    if (status.phase === 'completed') {
      await this.forceCommittedResidentMaterialization(status, authority)
    }
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
    return status
  }

  async residentLifecycleStatus(input: {
    expectedHostId: string
    operationId: string
  }): Promise<ResidentLifecycleStatus | null> {
    const authority = this.residentLifecycleAuthority({ requireCapability: false })
    if (input.expectedHostId !== authority.expectedHostId) throw new StaleHostAuthorityError()
    const result = ResidentLifecycleLookupResultSchema.parse(
      await this.call<unknown>('residentLifecycleStatus', input),
    )
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
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
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
    if (residentLifecycleNeedsProjectionMaterialization(result.status)) {
      await this.forceCommittedResidentMaterialization(result.status, authority)
    }
    this.assertResidentLifecycleAuthority(authority.expectedHostId, authority.generation)
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

export const INTERNAL_VISUAL_QA_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 PrimeContinuimVisualQA/1'

export function isInternalVisualQaRequest(input: {
  protocol: string
  hostname: string
  userAgent: string
  search: string
}): boolean {
  return input.protocol === 'http:' &&
    input.hostname === '127.0.0.1' &&
    input.userAgent === INTERNAL_VISUAL_QA_USER_AGENT &&
    new URLSearchParams(input.search).has('visualState')
}

export function createRendererApi(options: { allowConnectionInitiation?: boolean } = {}): RendererApi {
  if (!singletonApi) {
    const nativeBridge = Reflect.get(window, 'prime') as NativePrimeBridge | undefined
    const internalVisualQa = isInternalVisualQaRequest({
      protocol: window.location.protocol,
      hostname: window.location.hostname,
      userAgent: window.navigator.userAgent,
      search: window.location.search,
    })
    if (nativeBridge) singletonApi = new NativeRendererApi(nativeBridge, options)
    else if (internalVisualQa) singletonApi = new BrowserPreviewApi(previewVisualStateFromSearch(window.location.search))
    else throw new Error('Prime Continuim requires its desktop control bridge. Close this window and reopen the installed desktop app.')
  }
  return singletonApi
}

export function createPreviewRendererApi(visualState: PreviewVisualState = 'reconnecting'): RendererApi {
  return new BrowserPreviewApi(visualState)
}
