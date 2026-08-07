import {
  PRIME_AGENT_COMMAND_CAPABILITY,
  RUNTIME_MODEL_CATALOG_CAPABILITY,
  RuntimeModelCatalogSnapshotSchema,
  THREAD_HANDOFF_CAPABILITY,
  type RuntimeModelCatalogSnapshot,
} from '../../shared/protocol'
import { isNativeBridgeUnavailable } from './runtime'

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
      recovery?: 'restart' | 'repair' | 'diagnostics'
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
  operations: {
    submitCommands: boolean
    crossHostHandoff: boolean
    modelCatalog?: boolean
  }
  composerReceipt: {
    state: ComposerReceiptState
    message?: string
  }
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
  intent: 'follow_up' | 'steer'
  sendWhenReconnected: boolean
}

export interface RendererApi {
  environment: 'native' | 'preview'
  loadWorkbench(): Promise<WorkbenchSnapshot>
  subscribe?(listener: (snapshot: WorkbenchSnapshot) => void): () => void
  selectThread(threadId: string): Promise<void>
  loadRuntimeModelCatalog(hostId: string): Promise<RuntimeModelCatalogSnapshot>
  discoverComputers(): Promise<DiscoveredComputer[]>
  probeComputer(input: { alias?: string; hostname?: string; user?: string }): Promise<DiscoveredComputer>
  addComputer(input: {
    alias: string
    installHostService: boolean
    installCommandAcknowledged: boolean
  }): Promise<{ host: HostSummary }>
  sendComposer(request: ComposerRequest): Promise<{ state: ComposerReceiptState; message: string }>
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
    body: previewSimulation('resumed from a sample checkpoint; no host snapshot was read.'),
    detail: previewSimulation('sample transcript replaced in memory; no commands were replayed'),
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
    detail: previewSimulation('sample passing receipt; no host check ran'),
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
  operations: {
    submitCommands: true,
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
    { id: 'evidence-1', label: 'Sample renderer checks', detail: 'Preview fixture · passing', status: 'passed' },
    { id: 'evidence-2', label: 'Sample type check', detail: 'Preview fixture · passing', status: 'passed' },
    { id: 'evidence-3', label: 'Sample reconnect trace', detail: 'Preview fixture · awaiting path recovery', status: 'running' },
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
  composerReceipt: { state: 'waiting_for_connection', message: previewSimulation('waiting for a sample connection') },
}

const discoveredComputers: DiscoveredComputer[] = [
  {
    alias: 'devbox',
    effectiveTarget: 'ebene@devbox.internal:22',
    fingerprint: 'Sample browser preview only; no live host key was checked.',
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
    fingerprint: 'Sample browser preview only; no live host key was checked.',
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

class BrowserPreviewApi implements RendererApi {
  readonly environment = 'preview' as const

  async loadWorkbench(): Promise<WorkbenchSnapshot> {
    await delay(120)
    return structuredClone(previewSnapshot)
  }

  async selectThread(_threadId: string): Promise<void> {
    // Browser preview data is already materialized in memory. The native
    // adapter overrides this boundary with an authoritative host request.
  }

  async loadRuntimeModelCatalog(_hostId: string): Promise<RuntimeModelCatalogSnapshot> {
    await delay(180)
    return structuredClone(previewRuntimeModelCatalog)
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
      fingerprint: 'Sample browser preview only; no live host key was checked.',
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

  async sendComposer(request: ComposerRequest): Promise<{ state: ComposerReceiptState; message: string }> {
    await delay(240)
    if (request.sendWhenReconnected) {
      return {
        state: 'waiting_for_connection',
        message: previewSimulation('command saved only in the in-memory preview outbox'),
      }
    }
    return { state: 'sent', message: previewSimulation('command not sent to a host') }
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
        'Secrets and ignored files are excluded from the sample transfer.',
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
      ['complete', previewSimulation('sample handoff complete; no host state changed')],
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
  const recoveryAction = asString(snapshot?.recoveryAction)
  const recovery = recoveryAction === 'retry_runtime_initialization' || recoveryAction === 'restart_host_service'
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
    ...(recovery ? { recovery } : {}),
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

function createStableId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}:${uuid}`
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
  updatedAt?: unknown
  selectedThreadId?: string
}

interface NativeProjectionCacheEntry {
  hostId: string
  catalog?: unknown
  lastSnapshot?: unknown
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

function protocolThreadId(thread: ThreadSummary): string {
  return thread.remoteId ?? thread.id
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
  const advertisedCapabilities = Array.isArray(rawConnection?.capabilities)
    ? rawConnection.capabilities.filter((capability): capability is string => typeof capability === 'string')
    : []
  const updatedAt = asString(input.updatedAt)
  const snapshotThread = asRecord(threadSnapshot?.thread)
  const snapshotLocation = asRecord(snapshotThread?.currentLocation)

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
    const synchronizedAt = asString(host.cacheUpdatedAt) ?? asString(host.lastSeenAt) ?? (isActive ? updatedAt : undefined)
    const runtimeReadiness =
      isActive && asString(rawRuntimeReadiness?.hostId) === hostId
        ? runtimeReadinessFromNative(rawRuntimeReadiness, activePhase)
        : undefined
    return {
      id: hostId,
      name: hostName,
      kind: rawKind === 'local' || rawKind === 'paired' ? rawKind : 'ssh',
      connection: state,
      connectionPath: pathKind === 'local_socket' ? 'Local socket' : pathKind === 'relay' ? 'Relay' : 'SSH',
      lastSynchronized: state === 'online' ? undefined : displayTime(synchronizedAt) || 'not yet',
      latencyMs: asNumber(firstPath?.latencyMs),
      compatibility:
        host.compatibility === 'update_available' || host.compatibility === 'upgrade_required'
          ? host.compatibility
          : 'compatible',
      ...(runtimeReadiness ? { runtimeReadiness } : {}),
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
    const isMaterialized = threadId === snapshotThreadId && threadHostId === materializedHostId
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
      executionGenerationId: asString(location?.executionGenerationId),
      workspaceId: asString(location?.workspaceId),
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
    selectedThread.hostId === materializedHostId,
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

  const outbox = records(input.outbox)
  const pending = selectedThread
    ? outbox.find((entry) => asString(asRecord(entry.command)?.threadId) === protocolThreadId(selectedThread))
    : outbox[0]
  const pendingState = asString(pending?.state)
  const composerReceipt: WorkbenchSnapshot['composerReceipt'] = pending
    ? {
        state: pendingState === 'uncertain' ? 'uncertain' : 'waiting_for_connection',
        message: pendingState === 'uncertain' ? 'Receipt uncertain · reconciling by command ID' : 'Waiting for connection',
      }
    : { state: 'idle', message: hosts.find((host) => host.id === selectedThread?.hostId)?.connection === 'online' ? 'Ready to send' : 'Waiting for connection' }

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
    operations: {
      submitCommands: selectedHostHasAuthority && advertisedCapabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY),
      crossHostHandoff:
        selectedHostHasAuthority &&
        activePhase === 'online' &&
        advertisedCapabilities.includes(THREAD_HANDOFF_CAPABILITY),
      ...(selectedHostHasAuthority &&
      activePhase === 'online' &&
      advertisedCapabilities.includes(RUNTIME_MODEL_CATALOG_CAPABILITY)
        ? { modelCatalog: true }
        : {}),
    },
    composerReceipt,
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

function nativeComposerReceipt(raw: UnknownRecord): { state: ComposerReceiptState; message: string; terminal: boolean } {
  const status = asString(raw.status)
  const detail = asString(raw.detail) ?? asString(raw.message)
  if (status === 'waiting_for_connection') {
    return { state: 'waiting_for_connection', message: detail ?? 'Waiting for connection · saved in this device’s outbox', terminal: false }
  }
  if (status === 'uncertain') {
    return { state: 'uncertain', message: detail ?? 'Receipt uncertain · reconciling by command ID', terminal: false }
  }
  if (status === 'received') return { state: 'sending', message: detail ?? 'Received by host · awaiting durable admission', terminal: false }
  if (status === 'rejected' || status === 'failed' || status === 'cancelled') {
    return { state: 'rejected', message: detail ?? 'The host rejected this command.', terminal: true }
  }
  return { state: 'sent', message: detail ?? 'Sent · durably admitted by host', terminal: true }
}

export class NativeRendererApi implements RendererApi {
  readonly environment = 'native' as const
  private readonly deviceId = getDeviceId()
  private projectionEntries: Record<string, NativeProjectionCacheEntry> = {}
  private catalog?: unknown
  private threadSnapshot?: unknown
  private connection?: unknown
  private outbox?: unknown
  private cacheUpdatedAt?: unknown
  private projection?: WorkbenchSnapshot
  private activeProgress?: (phase: HandoffPhase, message: string) => void
  private readonly installPlans = new Map<string, UnknownRecord>()
  private readonly discoveredComputers = new Map<string, DiscoveredComputer>()
  private readonly handoffDestinations = new Map<string, string>()
  private readonly handoffSources = new Map<string, string>()
  private readonly composerCommands = new Map<string, string>()
  private readonly composerHosts = new Map<string, string>()
  private readonly listeners = new Set<(snapshot: WorkbenchSnapshot) => void>()
  private nativeSubscriptionsStarted = false
  private nativeUnsubscribers: Array<() => void> = []
  private reconciliationStarted = false
  private workbenchLoaded = false
  private selectedThreadId?: string
  private threadSelectionGeneration = 0
  private connectionGeneration = 0
  private authoritativeRefreshGeneration?: number
  private authoritativeRefreshPromise?: Promise<void>
  private composerOverride?: { threadId: string; state: ComposerReceiptState; message: string }

  constructor(private readonly bridge: NativePrimeBridge) {}

  private async call<T>(method: string, payload?: unknown): Promise<T> {
    const candidate = (this.bridge as Record<string, unknown>)[method]
    if (typeof candidate !== 'function') {
      throw new Error(`The native Prime bridge does not expose ${method}.`)
    }
    const raw = await (candidate as (input?: unknown) => Promise<unknown>)(payload)
    return unwrapResult<T>(raw)
  }

  private updateProjection(): WorkbenchSnapshot {
    this.projection = nativeProjection({
      catalog: this.catalog,
      threadSnapshot: this.threadSnapshot,
      connection: this.connection,
      outbox: this.outbox,
      updatedAt: this.cacheUpdatedAt,
      selectedThreadId: this.selectedThreadId,
    })
    if (this.composerOverride && this.projection.selectedThreadId === this.composerOverride.threadId) {
      this.projection = {
        ...this.projection,
        composerReceipt: { state: this.composerOverride.state, message: this.composerOverride.message },
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

  private connectionTargetKey(state: unknown): string {
    const target = asRecord(asRecord(state)?.target)
    const kind = asString(target?.kind)
    if (!kind) return ''
    return [kind, asString(target?.alias) ?? ''].join('|')
  }

  private rebuildCatalog(): void {
    const activeHostId = asString(asRecord(this.connection)?.hostId)
    this.catalog = aggregateProjectionCatalog(this.projectionEntries, activeHostId)
  }

  private replaceCatalogEntry(hostId: string, catalog: unknown, updatedAt?: string): void {
    const previous = this.projectionEntries[hostId]
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
  }

  private replaceSnapshotEntry(hostId: string, snapshot: unknown, updatedAt?: string): void {
    const previous = this.projectionEntries[hostId]
    this.projectionEntries = {
      ...this.projectionEntries,
      [hostId]: {
        ...previous,
        hostId,
        lastSnapshot: snapshot,
        updatedAt: updatedAt ?? new Date().toISOString(),
      },
    }
  }

  private cachedSnapshotForThread(threadId: string, hostId: string): unknown {
    const snapshot = this.projectionEntries[hostId]?.lastSnapshot
    return snapshotThreadId(snapshot) === threadId && snapshotHostId(snapshot) === hostId
      ? snapshot
      : undefined
  }

  private clearAuthorityMutationState(): void {
    this.outbox = []
    this.composerOverride = undefined
    this.composerCommands.clear()
    this.composerHosts.clear()
    this.handoffDestinations.clear()
    this.handoffSources.clear()
    this.activeProgress = undefined
    this.threadSelectionGeneration += 1
  }

  private applyConnectionState(state: unknown): void {
    const previousPhase = asString(asRecord(this.connection)?.phase)
    const nextPhase = asString(asRecord(state)?.phase)
    const previousTarget = this.connectionTargetKey(this.connection)
    const nextTarget = this.connectionTargetKey(state)
    const previousHostId = asString(asRecord(this.connection)?.hostId)
    const verifiedHostId = asString(asRecord(state)?.hostId)
    const targetChanged = Boolean(previousTarget && nextTarget && previousTarget !== nextTarget)
    const authorityChanged = Boolean(verifiedHostId && previousHostId && verifiedHostId !== previousHostId)
    if (targetChanged || authorityChanged) this.clearAuthorityMutationState()
    const connectionChanged = this.connectionKey(this.connection) !== this.connectionKey(state)
    this.connection = state
    if (connectionChanged) this.connectionGeneration += 1
    if (authorityChanged && verifiedHostId) {
      const cached = this.projectionEntries[verifiedHostId]?.lastSnapshot
      this.threadSnapshot = cached
      this.selectedThreadId = undefined
    }
    this.rebuildCatalog()
    if (authorityChanged && verifiedHostId) {
      const cachedThreadId = snapshotThreadId(this.threadSnapshot)
      if (cachedThreadId) {
        this.selectedThreadId = this.updateProjection().threads.find(
          (thread) => thread.hostId === verifiedHostId && protocolThreadId(thread) === cachedThreadId,
        )?.id
      }
    }
    this.publish()

    if (this.workbenchLoaded && nextPhase === 'online' && previousPhase !== 'online') {
      void this.refreshFromAuthoritativeHost().catch(() => undefined)
    }
  }

  private hydrateComposerCommands(outbox: unknown): void {
    this.composerCommands.clear()
    for (const entry of records(outbox)) {
      const command = asRecord(entry.command)
      const commandId = asString(command?.commandId)
      const threadId = asString(command?.threadId)
      const hostId = asString(command?.expectedHostId) ?? asString(entry.hostId)
      if (commandId && threadId) {
        this.composerCommands.set(commandId, threadId)
        if (hostId) this.composerHosts.set(commandId, hostId)
      }
    }
  }

  private updateOutboxFromReceipt(
    commandId: string,
    receipt: { state: ComposerReceiptState; terminal: boolean },
  ): void {
    const entries = records(this.outbox)
    if (receipt.terminal) {
      this.outbox = entries.filter((entry) => asString(asRecord(entry.command)?.commandId) !== commandId)
      return
    }

    const nextState =
      receipt.state === 'uncertain'
        ? 'uncertain'
        : receipt.state === 'waiting_for_connection'
          ? 'waiting_for_connection'
          : undefined
    if (!nextState) return
    this.outbox = entries.map((entry) =>
      asString(asRecord(entry.command)?.commandId) === commandId ? { ...entry, state: nextState } : entry,
    )
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
        this.replaceCatalogEntry(activeHostId, snapshot)
      } else {
        const incomingThreadId = asString(asRecord(value?.thread)?.threadId)
        const selectedThread = this.projection?.threads.find((thread) => thread.id === this.selectedThreadId)
        if (
          incomingThreadId &&
          selectedThread &&
          (selectedThread.hostId !== activeHostId || protocolThreadId(selectedThread) !== incomingThreadId)
        ) return
        this.replaceSnapshotEntry(activeHostId, snapshot)
        this.threadSnapshot = snapshot
        if (!this.selectedThreadId && incomingThreadId) {
          this.selectedThreadId = this.updateProjection().threads.find(
            (thread) => thread.hostId === activeHostId && protocolThreadId(thread) === incomingThreadId,
          )?.id
        }
      }
      this.publish()
    })
    subscribe('onHostEvent', (event) => {
      const hostEvent = asRecord(event)
      if (asString(hostEvent?.type) !== 'command.receipt') return
      const receipt = asRecord(hostEvent?.payload)
      const commandId = asString(receipt?.commandId)
      const storedThreadId = commandId ? this.composerCommands.get(commandId) : undefined
      const expectedHostId = commandId ? this.composerHosts.get(commandId) : undefined
      const threadId = storedThreadId
        ? this.projection?.threads.find(
            (thread) =>
              thread.hostId === expectedHostId &&
              (thread.id === storedThreadId || protocolThreadId(thread) === storedThreadId),
          )?.id ?? storedThreadId
        : undefined
      const receiptHostId = asString(receipt?.hostId)
      const activeHostId = asString(asRecord(this.connection)?.hostId)
      if (
        (receiptHostId && expectedHostId && receiptHostId !== expectedHostId) ||
        (receiptHostId && activeHostId && receiptHostId !== activeHostId)
      ) return
      if (!receipt || !commandId || !threadId) return
      const mapped = nativeComposerReceipt(receipt)
      this.composerOverride = { threadId, state: mapped.state, message: mapped.message }
      this.updateOutboxFromReceipt(commandId, mapped)
      if (mapped.terminal) {
        this.composerCommands.delete(commandId)
        this.composerHosts.delete(commandId)
      }
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

    this.replaceCatalogEntry(authorityHostId, catalog)
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
        ? this.cachedSnapshotForThread(remoteThreadId, selectedThread.hostId)
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
    if (incomingThreadId !== remoteThreadId || snapshotHostId(snapshot) !== authorityHostId) return
    this.replaceSnapshotEntry(authorityHostId, snapshot)
    this.threadSnapshot = snapshot
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

  private async reconcileInBackground(): Promise<void> {
    if (this.reconciliationStarted) return
    this.reconciliationStarted = true
    try {
      const connection = asRecord(this.connection)
      const phase = asString(connection?.phase)
      const existingTarget = asRecord(connection?.target)
      if (phase !== 'online') {
        const target =
          existingTarget?.kind === 'ssh' && asString(existingTarget.alias)
            ? { kind: 'ssh', alias: asString(existingTarget.alias) }
            : { kind: 'local' }
        this.applyConnectionState(await this.call<unknown>('connect', target))
      }

      await this.refreshFromAuthoritativeHost()
    } catch {
      // Cache remains the visible source of context. Native connection events
      // carry actionable structured errors without replacing the projection.
    }
  }

  async loadWorkbench(): Promise<WorkbenchSnapshot> {
    const loadConnectionGeneration = this.connectionGeneration
    const bootstrap = asRecord(await this.call<unknown>('bootstrap'))
    if (loadConnectionGeneration !== this.connectionGeneration) {
      // A newer native connection event won the race. Never hydrate its state
      // with a bootstrap payload captured for the previous authority.
      this.workbenchLoaded = true
      const currentProjection = this.updateProjection()
      queueMicrotask(() => void this.reconcileInBackground())
      return currentProjection
    }
    const cache = asRecord(bootstrap?.cache)
    const bootstrapConnection = asRecord(bootstrap?.connection)
    const connectionHostId = asString(bootstrapConnection?.hostId)
    this.projectionEntries = projectionEntriesFromCache(cache)
    const connectionChanged = this.connectionKey(this.connection) !== this.connectionKey(bootstrap?.connection)
    this.connection = bootstrap?.connection
    if (connectionChanged) this.connectionGeneration += 1
    this.rebuildCatalog()
    const preferredSnapshot = connectionHostId
      ? this.projectionEntries[connectionHostId]?.lastSnapshot
      : Object.values(this.projectionEntries)
          .sort((left, right) => (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0))[0]
          ?.lastSnapshot
    this.threadSnapshot = preferredSnapshot
    this.outbox = bootstrap?.outbox
    this.hydrateComposerCommands(this.outbox)
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

  async selectThread(threadId: string): Promise<void> {
    if (!threadId) throw new Error('Choose a thread before requesting its snapshot.')
    const previousThreadId = this.selectedThreadId
    const previousSnapshot = this.threadSnapshot
    const selectionConnectionGeneration = this.connectionGeneration
    const selectedThread = this.projection?.threads.find((thread) => thread.id === threadId)
    const expectedHostId = selectedThread?.hostId
    const remoteThreadId = selectedThread ? protocolThreadId(selectedThread) : undefined
    const activeHostId = asString(asRecord(this.connection)?.hostId)
    this.selectedThreadId = threadId
    const selectionGeneration = ++this.threadSelectionGeneration
    // A snapshot is authoritative for exactly one thread. Do not retain the
    // previous thread's evidence, agents, or attention while the new request
    // is in flight.
    this.threadSnapshot = expectedHostId && remoteThreadId
      ? this.cachedSnapshotForThread(remoteThreadId, expectedHostId)
      : undefined
    this.publish()

    // Catalogs from inactive hosts remain useful offline, but selecting one is
    // read-only until that exact immutable host becomes the verified authority.
    if (
      !expectedHostId ||
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

      const incomingThreadId = asString(asRecord(asRecord(snapshot)?.thread)?.threadId)
      if (incomingThreadId !== remoteThreadId || snapshotHostId(snapshot) !== expectedHostId) {
        throw new Error('The host returned a snapshot for a different thread. Try again.')
      }
      this.replaceSnapshotEntry(expectedHostId, snapshot)
      this.threadSnapshot = snapshot
      this.publish()
    } catch (error) {
      if (
        selectionGeneration !== this.threadSelectionGeneration ||
        threadId !== this.selectedThreadId ||
        selectionConnectionGeneration !== this.connectionGeneration
      ) return
      this.selectedThreadId = previousThreadId
      this.threadSnapshot = previousSnapshot
      this.publish()
      throw error
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
    const connection = asRecord(await this.call<unknown>('connect', { kind: 'ssh', alias: input.alias }))
    this.applyConnectionState(connection)
    await this.refreshFromAuthoritativeHost()
    return {
      host: {
        id: `ssh:${input.alias}`,
        name: input.alias,
        kind: 'ssh',
        connection: connectionFromNative(connection?.phase),
        connectionPath: 'SSH',
        compatibility: 'compatible',
      },
    }
  }

  async sendComposer(request: ComposerRequest): Promise<{ state: ComposerReceiptState; message: string }> {
    if (!this.projection?.operations.submitCommands) {
      return {
        state: 'rejected',
        message: 'Prime Agent isn’t attached to this host, so commands are unavailable.',
      }
    }
    const commandId = createStableId('command')
    const thread = this.projection?.threads.find((item) => item.id === request.threadId)
    if (!thread?.hostId) throw new Error('Refresh this thread before sending so its host identity can be verified.')
    const expectedHostId = thread.hostId
    const remoteThreadId = protocolThreadId(thread)
    if (asString(asRecord(this.connection)?.hostId) !== expectedHostId) {
      throw new StaleHostAuthorityError()
    }
    this.composerCommands.set(commandId, remoteThreadId)
    this.composerHosts.set(commandId, expectedHostId)
    let receipt: UnknownRecord | undefined
    try {
      receipt = asRecord(await this.call<unknown>('submitCommand', {
        deviceId: this.deviceId,
        commandId,
        expectedHostId,
        threadId: remoteThreadId,
        kind: request.intent === 'steer' ? 'thread.steer' : 'thread.follow_up',
        payload: { text: request.text },
        delivery: request.sendWhenReconnected ? 'send_when_reconnected' : 'live_only',
        ...(thread?.executionGenerationId ? { expectedExecutionGenerationId: thread.executionGenerationId } : {}),
      }))
    } catch (error) {
      if (error instanceof StaleHostAuthorityError) throw error
      if (!this.hasComposerAuthority(request.threadId, expectedHostId)) {
        this.composerCommands.delete(commandId)
        this.composerHosts.delete(commandId)
        throw new StaleHostAuthorityError()
      }
      this.composerOverride = {
        threadId: request.threadId,
        state: 'uncertain',
        message: error instanceof Error ? `${error.message} Reconciling by command ID.` : 'Receipt uncertain · reconciling by command ID',
      }
      this.publish()
      throw error
    }
    if (!this.hasComposerAuthority(request.threadId, expectedHostId)) {
      this.composerCommands.delete(commandId)
      this.composerHosts.delete(commandId)
      throw new StaleHostAuthorityError()
    }
    const mapped = nativeComposerReceipt(receipt ?? {})
    this.composerOverride = { threadId: request.threadId, state: mapped.state, message: mapped.message }
    if (mapped.terminal) {
      this.composerCommands.delete(commandId)
      this.composerHosts.delete(commandId)
    }
    this.publish()
    return { state: mapped.state, message: mapped.message }
  }

  private hasComposerAuthority(threadId: string, expectedHostId: string): boolean {
    const activeHostId = asString(asRecord(this.connection)?.hostId)
    const activeThread = this.projection?.threads.find((item) => item.id === threadId)
    if (activeHostId) {
      return activeHostId === expectedHostId && (!activeThread || activeThread.hostId === expectedHostId)
    }
    return false
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

export function createRendererApi(): RendererApi {
  if (!singletonApi) {
    const nativeBridge = Reflect.get(window, 'prime') as NativePrimeBridge | undefined
    if (nativeBridge) singletonApi = new NativeRendererApi(nativeBridge)
    else if (isNativeBridgeUnavailable(window.navigator.userAgent, false)) {
      throw new Error('The native control bridge did not load. Prime Continuim will not substitute sample data in the desktop app.')
    } else singletonApi = new BrowserPreviewApi()
  }
  return singletonApi
}

export function createPreviewRendererApi(): RendererApi {
  return new BrowserPreviewApi()
}
