import {
  CandidateEvaluationPreflightSchema,
  CandidateEvaluationSnapshotSchema,
  PRIME_CONTINUIM_SELF_BUILD_EVALUATION_CAPABILITY,
  RuntimeModelCatalogSnapshotSchema,
  type CandidateEvaluationPreflight,
  type CandidateEvaluationPreflightRequest,
  type CandidateEvaluationReviewIdentity,
  type CandidateEvaluationSnapshot,
  type CandidateEvaluationStartRequest,
  type CandidateEvaluationStatus,
  type ResidentLifecycleStatus,
  type RuntimeModelCatalogSnapshot,
} from '../../shared/protocol'
import type {
  ComposerReceiptState,
  ComposerRequest,
  DiscoveredComputer,
  HandoffPhase,
  HandoffPlan,
  HostSummary,
  HostRuntimeReadiness,
  RendererApi,
  ResidentEndPreparation,
  ResidentModelSelectionRequest,
  ResidentModelSelectionResult,
  ResidentThinkingLevelSelectionRequest,
  ResidentThinkingLevelSelectionResult,
  ResidentWorkspacePreselection,
  ResidentWorkspaceSelection,
  ResidentWorkspaceSelectionInput,
  RuntimeOAuthProgress,
  RuntimeOAuthRequest,
  RuntimeOAuthResult,
  TranscriptBlock,
  WorkbenchSnapshot,
} from './api'
import type { HudMode, HudState, HudTarget } from '../../shared/window-control'

function candidateEvaluationAuthorityMatches(
  expected: CandidateEvaluationPreflightRequest,
  received: CandidateEvaluationPreflightRequest,
): boolean {
  return expected.expectedHostId === received.expectedHostId &&
    expected.threadId === received.threadId &&
    expected.expectedExecutionGenerationId === received.expectedExecutionGenerationId
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds))
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
    {
      id: 'agent-1',
      activeSessionId: 'rlm-workbench-lead',
      sessionName: 'Workbench lead',
      name: 'Workbench lead',
      role: 'Integration lead',
      status: 'running',
      hostName: 'devbox',
      model: 'openai-codex/gpt-5.6-sol',
      activity: 'Coordinating two branches',
    },
    {
      id: 'agent-2',
      parentId: 'agent-1',
      activeSessionId: 'rlm-renderer',
      sessionName: 'Renderer',
      name: 'Renderer',
      role: 'Interface implementation',
      status: 'running',
      hostName: 'This computer',
      model: 'openai-codex/gpt-5.6-sol',
      activity: 'Executing renderer tests',
      toolUseCount: 18,
      tokenCount: 24_120,
    },
    {
      id: 'agent-3',
      parentId: 'agent-1',
      sessionName: 'Protocol',
      name: 'Protocol',
      role: 'Snapshots and command journal',
      status: 'complete',
      hostName: 'devbox',
      model: 'openai-codex/gpt-5.6-sol',
      durationMs: 48_000,
      answerPreview: 'The snapshot boundary is generation-fenced and preserves completed child results across reconnects.',
      repliedSinceTask: true,
      toolUseCount: 7,
      tokenCount: 11_804,
    },
  ],
  evidence: [
    { id: 'evidence-1', label: 'Visual-QA renderer checks', detail: 'Internal fixture · passing', status: 'passed' },
    { id: 'evidence-2', label: 'Visual-QA type check', detail: 'Internal fixture · passing', status: 'passed' },
    { id: 'evidence-3', label: 'Visual-QA reconnect trace', detail: 'Internal fixture · awaiting path recovery', status: 'running' },
  ],
  runtime: {
    agentsReported: true,
    browserExecution: {
      readiness: 'ready',
      protocol: 'prime-continuim.browser.v1',
      surface: 'playwright-cli',
      controller: 'playwright-core/1.63.0-alpha-2026-08-05',
      engine: 'verified-electron-host',
    },
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
      resourceInventory: {
        skills: [
          {
            name: 'playwright-cli',
            description: 'Browser automation guidance for Prime Agent.',
            sourceKind: { scope: 'project', origin: 'top-level' },
          },
          {
            name: 'refine',
            description: 'Persist learned harness improvements.',
            sourceKind: { scope: 'user', origin: 'package' },
          },
        ],
        prompts: [],
        themes: [],
        extensions: { count: 0, sourceKinds: [] },
        contextFileCount: 1,
        diagnostics: { warningCount: 0, errorCount: 0, collisions: [] },
      },
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
  | 'rlm-activity'
  | 'extension-ui-confirm'
  | 'launchpad'
  | 'model-selection'
  | 'prime-oauth'
  | 'prompt-admission'
  | 'prompt-awaiting-idle-proof'
  | 'stop-awaiting-idle-proof'
  | 'nonretryable-uncertainty'
  | 'resident-start'
  | 'ssh-registered-workspace'
  | 'resident-recovery'
  | 'resident-end-review'
  | 'resident-end-pending'
  | 'ended-empty'
  | 'candidate-evaluation-review'
  | 'hud-expanded'
  | 'hud-buddy'

const PREVIEW_VISUAL_STATES = new Set<PreviewVisualState>([
  'reconnecting',
  'idle',
  'rlm-activity',
  'extension-ui-confirm',
  'launchpad',
  'model-selection',
  'prime-oauth',
  'prompt-admission',
  'prompt-awaiting-idle-proof',
  'stop-awaiting-idle-proof',
  'nonretryable-uncertainty',
  'resident-start',
  'ssh-registered-workspace',
  'resident-recovery',
  'resident-end-review',
  'resident-end-pending',
  'ended-empty',
  'candidate-evaluation-review',
  'hud-expanded',
  'hud-buddy',
])

export function previewVisualStateFromSearch(search: string): PreviewVisualState {
  const candidate = new URLSearchParams(search).get('visualState')
  return candidate && PREVIEW_VISUAL_STATES.has(candidate as PreviewVisualState)
    ? candidate as PreviewVisualState
    : 'reconnecting'
}

function previewSnapshotForVisualState(visualState: PreviewVisualState): WorkbenchSnapshot {
  const snapshot = structuredClone(previewSnapshot)
  if (visualState === 'reconnecting') return snapshot

  if (visualState === 'prime-oauth') {
    const thread = snapshot.threads.find((candidate) => candidate.id === 'thread-protocol')
    const host = snapshot.hosts.find((candidate) => candidate.id === 'host-local')
    if (!thread || !host || !snapshot.runtime.session) return snapshot
    snapshot.selectedProjectId = thread.projectId
    snapshot.selectedThreadId = thread.id
    thread.remoteId = 'thread-prime-oauth-preview'
    thread.workspaceId = 'workspace-prime-oauth-preview'
    thread.executionGenerationId = 'execution-prime-oauth-preview'
    thread.status = 'idle'
    host.kind = 'local'
    host.connection = 'online'
    host.connectionPath = 'Local socket'
    host.latencyMs = 2
    delete host.lastSynchronized
    snapshot.attention = []
    snapshot.runtime.session = {
      ...snapshot.runtime.session,
      activeSessionId: 'session-prime-oauth-preview',
      sessionId: 'session-prime-oauth-preview',
      sessionName: thread.title,
      isStreaming: false,
      isBashRunning: false,
      queuedActionCount: 0,
    }
    snapshot.runtime.queue = { pendingCount: 0, paused: false }
    snapshot.operations = {
      submitCommands: true,
      startResidentTurn: true,
      stopResidentTurn: false,
      crossHostHandoff: false,
      modelCatalog: true,
      runtimeOAuth: true,
    }
    snapshot.composerReceipt = { state: 'idle', message: 'Ready for a new prompt' }
    return snapshot
  }

  if (visualState === 'ssh-registered-workspace') {
    const thread = snapshot.threads.find((candidate) => candidate.id === 'thread-seamless')
    const project = snapshot.projects.find((candidate) => candidate.id === 'project-prime')
    const host = snapshot.hosts.find((candidate) => candidate.id === 'host-devbox')
    if (!thread || !project || !host || !snapshot.runtime.session) return snapshot
    snapshot.selectedProjectId = project.id
    snapshot.selectedThreadId = thread.id
    thread.remoteId = 'thread-seamless-remote'
    thread.workspaceId = 'workspace-prime-devbox'
    thread.executionGenerationId = 'execution-registered-workspace-preview'
    thread.status = 'idle'
    host.kind = 'ssh'
    host.connection = 'online'
    host.connectionPath = 'SSH'
    host.latencyMs = 24
    delete host.activationRequired
    delete host.lastSynchronized
    snapshot.attention = []
    snapshot.runtime.session = {
      ...snapshot.runtime.session,
      residency: 'client_owned',
      sessionName: thread.title,
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      queuedActionCount: 0,
    }
    delete snapshot.runtime.session.activeSessionId
    delete snapshot.runtime.session.sessionId
    snapshot.runtime.queue = { pendingCount: 0, paused: false }
    snapshot.operations = {
      submitCommands: true,
      startResidentTurn: true,
      stopResidentTurn: false,
      crossHostHandoff: false,
      provisionResident: true,
      endResident: true,
    }
    snapshot.composerReceipt = { state: 'idle', message: 'Ready for a new prompt' }
    return snapshot
  }

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

  if (visualState === 'ended-empty') {
    const thread = snapshot.threads.find((candidate) => candidate.id === 'thread-protocol')
    const host = snapshot.hosts.find((candidate) => candidate.id === 'host-local')
    if (!thread || !host || !snapshot.runtime.session) return snapshot
    snapshot.selectedProjectId = thread.projectId
    snapshot.selectedThreadId = thread.id
    thread.status = 'complete'
    thread.transcript = []
    thread.workspaceId = 'workspace-preview-ended'
    thread.executionGenerationId = 'execution-preview-ended'
    thread.residentLifecycle = {
      state: 'ended',
      reason: 'user_end',
      operationId: 'resident-preview-ended',
      endedAt: '2026-08-07T12:00:05.000Z',
    }
    host.connection = 'online'
    host.connectionPath = 'Local socket'
    host.latencyMs = 2
    delete host.lastSynchronized
    snapshot.agents = []
    snapshot.runtime.session = {
      ...snapshot.runtime.session,
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      queuedActionCount: 0,
    }
    snapshot.runtime.queue = { pendingCount: 0, paused: false }
    snapshot.operations = {
      ...snapshot.operations,
      submitCommands: false,
      startResidentTurn: false,
      stopResidentTurn: false,
      provisionResident: true,
      endResident: false,
    }
    snapshot.residentLifecycleOperations = []
    snapshot.composerReceipt = { state: 'idle', message: 'Session ended' }
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
      endResident: visualState === 'resident-end-review',
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
          retryable: true,
          message: 'Ready to finish · Prime Agent has not received an End request',
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

  if (
    visualState === 'idle' ||
    visualState === 'rlm-activity' ||
    visualState === 'extension-ui-confirm' ||
    visualState === 'launchpad' ||
    visualState === 'model-selection' ||
    visualState === 'hud-expanded' ||
    visualState === 'hud-buddy'
  ) {
    const hudActive = visualState === 'hud-expanded' || visualState === 'hud-buddy'
    if (hudActive) {
      selectedThread.workspaceId = 'workspace-preview-hud'
      selectedThread.executionGenerationId = 'execution-preview-hud'
    }
    selectedThread.status = hudActive ? 'running' : 'idle'
    session.isStreaming = hudActive
    if (!hudActive && visualState !== 'rlm-activity') snapshot.agents = []
    if (visualState === 'extension-ui-confirm') {
      const bindingFingerprint = 'a'.repeat(64)
      const executionGenerationId = selectedThread.executionGenerationId ?? 'execution-extension-ui-preview'
      selectedThread.executionGenerationId = executionGenerationId
      selectedThread.status = 'running'
      snapshot.residentExtensionUiRequests = [{
        interactionVersion: 1,
        hostId: selectedHost.id,
        threadId: selectedThread.remoteId ?? selectedThread.id,
        executionGenerationId,
        bindingFingerprint,
        requestId: 'preview-extension-confirm',
        requestDigest: 'b'.repeat(64),
        receivedAt: '2026-08-07T12:00:04.000Z',
        method: 'confirm',
        title: 'Use the verified migration plan?',
        message: 'Prime Agent needs this decision before it changes the workspace.',
      }]
      snapshot.operations.startResidentTurn = false
      snapshot.composerReceipt = { state: 'idle', message: 'Prime Agent is waiting for your response' }
      return snapshot
    }
    if (visualState === 'launchpad') {
      selectedThread.transcript = []
      session.messageCount = 0
    }
    snapshot.operations.startResidentTurn = !hudActive
    snapshot.operations.stopResidentTurn = hudActive
    if (visualState === 'model-selection') {
      snapshot.operations.modelCatalog = true
      snapshot.operations.selectResidentModel = true
      snapshot.operations.selectResidentThinkingLevel = true
      session.thinkingLevel = 'high'
      session.availableThinkingLevels = ['off', 'low', 'medium', 'high', 'max']
    }
    snapshot.composerReceipt = hudActive
      ? {
          state: 'sent',
          operation: 'prompt',
          message: 'Prime Agent owns this prompt · monitoring exact live activity',
        }
      : { state: 'idle', message: 'Ready for a new prompt' }
    if (hudActive || visualState === 'rlm-activity') {
      setPreviewUpdate(
        'fixture resident session is actively working with retained child agents',
        hudActive
          ? 'the HUD is rendering bounded host-projected activity'
          : 'the root is idle while retained RLM branches continue independently',
      )
    } else {
      setPreviewUpdate(
        'fixture resident session is attached and ready for another prompt',
        'no prompt was sent to a host',
      )
    }
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
    session.activeToolNames = []
    snapshot.agents = []
    session.queuedActionCount = 1
    snapshot.runtime.queue = { pendingCount: 1, paused: false }
    snapshot.operations.stopResidentTurn = true
    snapshot.composerReceipt = {
      state: 'sent',
      operation: 'prompt',
      message: 'Prime Agent owns this prompt · waiting for authoritative idle proof',
    }
    if (previewUpdate) {
      previewUpdate.body = '(No display text)'
      previewUpdate.detail = previewSimulation('the stream is admitted but has not emitted visible text')
      previewUpdate.streaming = true
    }
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
    agentVersion: 'Prime Agent 0.7.2',
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
    agentVersion: 'Prime Agent 0.7.2',
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
  releaseVersion: '0.7.2',
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
    this.environment = visualState === 'candidate-evaluation-review' ||
      visualState === 'model-selection' ||
      visualState === 'prime-oauth' ||
      visualState === 'ssh-registered-workspace'
      ? 'native'
      : 'preview'
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
    const catalog = structuredClone(previewRuntimeModelCatalog)
    if (this.visualState === 'prime-oauth') {
      const provider = catalog.providers.find((candidate) => candidate.providerId === 'openai-codex')
      if (provider) {
        provider.configured = false
        provider.availableModelCount = 0
        delete provider.authSource
      }
      for (const model of catalog.models) {
        if (model.providerId !== 'openai-codex') continue
        model.available = false
        model.usingOAuth = false
      }
    }
    return catalog
  }

  async selectResidentModel(_request: ResidentModelSelectionRequest): Promise<ResidentModelSelectionResult> {
    throw new Error('Resident model selection is available only in the native desktop app.')
  }

  async selectResidentThinkingLevel(
    _request: ResidentThinkingLevelSelectionRequest,
  ): Promise<ResidentThinkingLevelSelectionResult> {
    throw new Error('Resident reasoning selection is available only in the native desktop app.')
  }

  async startRuntimeOAuth(
    _request: RuntimeOAuthRequest,
    _onProgress: (progress: RuntimeOAuthProgress) => void,
  ): Promise<RuntimeOAuthResult> {
    throw new Error('Prime Agent sign-in is available only in the native desktop app.')
  }

  async cancelRuntimeOAuth(_request: RuntimeOAuthRequest): Promise<RuntimeOAuthResult | null> {
    throw new Error('Prime Agent sign-in is available only in the native desktop app.')
  }

  async preselectResidentWorkspace(): Promise<ResidentWorkspacePreselection> {
    throw new Error('Early workspace choice is available only in the native desktop app.')
  }

  async completeResidentWorkspacePreselection(
    _preselectionToken: string,
  ): Promise<ResidentWorkspaceSelection> {
    throw new Error('Early workspace choice is available only in the native desktop app.')
  }

  async cancelResidentWorkspacePreselection(_preselectionToken: string): Promise<void> {
    // Browser preview never retains a native folder authority.
  }

  async selectResidentWorkspace(
    _input: ResidentWorkspaceSelectionInput = {},
  ): Promise<ResidentWorkspaceSelection> {
    if (_input.kind === 'registered_workspace') {
      const exactVisualAuthority = this.visualState === 'ssh-registered-workspace' &&
        _input.projectId === 'project-prime' &&
        _input.workspaceId === 'workspace-prime-devbox' &&
        _input.referenceThreadId === 'thread-seamless-remote' &&
        _input.referenceExecutionGenerationId === 'execution-registered-workspace-preview'
      if (!exactVisualAuthority) {
        throw new Error('Saved-workspace resident provisioning is available only for its exact internal visual-QA authority.')
      }
      return {
        kind: 'registered_workspace',
        selectionToken: 'preview-registered-workspace-selection-token',
        operationId: _input.resumeOperationId ?? 'resident-preview-registered-create',
        expectedHostId: 'host-devbox',
        suggestedName: 'Prime Continuim',
        projectId: _input.projectId,
        workspaceId: _input.workspaceId,
        referenceThreadId: _input.referenceThreadId,
        referenceExecutionGenerationId: _input.referenceExecutionGenerationId,
        expiresAt: '2099-08-07T12:05:00.000Z',
      }
    }
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


export function createPreviewRendererApi(visualState: PreviewVisualState = 'reconnecting'): RendererApi {
  return new BrowserPreviewApi(visualState)
}
