import { describe, expect, it, vi } from 'vitest'
import {
  NativeRendererApi,
  StaleHostAuthorityError,
  type ResidentLifecycleOperationSummary,
} from '../../src/renderer/src/api'

const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value })

function recoveryCatalog() {
  const repositoryIdentity = { canonicalRemotes: ['https://example.com/prime-gui.git'] }
  return {
    snapshotVersion: 1,
    generatedAt: '2026-08-05T20:00:00.000Z',
    hosts: [
      {
        hostId: 'host-local',
        displayName: 'This computer',
        kind: 'local',
        reachability: 'online',
        compatibility: 'compatible',
        connectionPaths: [{ kind: 'local_socket', priority: 0, state: 'available', latencyMs: 1 }],
      },
      {
        hostId: 'host-remote',
        displayName: 'devbox',
        kind: 'ssh',
        reachability: 'online',
        compatibility: 'compatible',
        connectionPaths: [{ kind: 'ssh', priority: 1, state: 'available', latencyMs: 24 }],
      },
    ],
    projects: [
      {
        projectId: 'project-local',
        hostId: 'host-local',
        workspaceId: 'workspace-local',
        displayName: 'Prime GUI',
        repositoryIdentity,
        lastOpenedAt: '2026-08-05T20:00:00.000Z',
      },
      {
        projectId: 'project-remote',
        hostId: 'host-remote',
        workspaceId: 'workspace-remote',
        displayName: 'Prime GUI',
        repositoryIdentity,
        lastOpenedAt: '2026-08-05T20:00:00.000Z',
      },
    ],
    threads: [
      {
        threadId: 'thread-one',
        title: 'First durable thread',
        projectIdentity: 'project-local',
        currentLocation: {
          hostId: 'host-local',
          projectId: 'project-local',
          workspaceId: 'workspace-local',
          executionGenerationId: 'generation-one',
        },
        status: 'running',
        recap: 'First recap.',
        unread: false,
        updatedAt: '2026-08-05T20:00:00.000Z',
      },
      {
        threadId: 'thread-two',
        title: 'Second durable thread',
        projectIdentity: 'project-local',
        currentLocation: {
          hostId: 'host-local',
          projectId: 'project-local',
          workspaceId: 'workspace-local',
          executionGenerationId: 'generation-two',
        },
        status: 'idle',
        recap: 'Second recap.',
        unread: false,
        updatedAt: '2026-08-05T20:00:00.000Z',
      },
    ],
  }
}

function recoverySnapshot(thread: ReturnType<typeof recoveryCatalog>['threads'][number], body: string) {
  const latestCursor = {
    threadId: thread.threadId,
    executionGenerationId: thread.currentLocation.executionGenerationId,
    generation: `daemon-${thread.threadId}`,
    sequence: 1,
  }
  return {
    snapshotVersion: 1,
    generatedAt: '2026-08-05T20:00:01.000Z',
    thread: { ...thread, lastKnownCursor: latestCursor },
    materializedRecentBlocks: [
      {
        blockId: `block-${thread.threadId}`,
        kind: 'assistant',
        text: body,
        createdAt: '2026-08-05T20:00:01.000Z',
        sequence: 1,
      },
    ],
    queueState: { pendingCommandIds: ['queued-command'], paused: false },
    childAgents: [],
    goals: [
      {
        goalId: `goal-${thread.threadId}`,
        objective: `Finish ${thread.title}`,
        state: 'active',
        tokenBudget: 100_000,
        tokensUsed: 12_000,
      },
    ],
    schedules: [
      {
        scheduleId: `schedule-${thread.threadId}`,
        label: 'Review verification',
        state: 'active',
        source: 'heartbeat',
        nextRunAt: '2026-08-06T21:00:00.000Z',
      },
    ],
    runtime: {
      runtime: 'prime_agent',
      residency: 'resident',
      activeSessionId: `active-${thread.threadId}`,
      sessionId: `session-${thread.threadId}`,
      sessionName: thread.title,
      model: 'prime-rlm',
      thinkingLevel: 'high',
      isStreaming: thread.status === 'running',
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      steeringMode: 'all',
      followUpMode: 'all',
      messageCount: 1,
      compactionCount: 0,
      queuedActionCount: thread.status === 'running' ? 2 : 0,
      activeToolNames: [],
      resourceInventory: {
        skills: [{
          name: 'playwright-cli',
          description: 'Browser automation guidance.',
          sourceKind: { scope: 'project', origin: 'top-level' },
        }],
        prompts: [],
        themes: [],
        extensions: { count: 0, sourceKinds: [] },
        contextFileCount: 1,
        diagnostics: { warningCount: 0, errorCount: 0, collisions: [] },
      },
      context: { usedTokens: 12_000, maxTokens: 100_000 },
    },
    pendingAttention: [],
    git: { branch: 'main', stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
    evidence: { testsPassed: 0, testsFailed: 0, artifactCount: 0 },
    residentControl: {
      projectionVersion: 1,
      hostId: thread.currentLocation.hostId,
      threadId: thread.threadId,
      executionGenerationId: thread.currentLocation.executionGenerationId,
      bindingFingerprint: 'a'.repeat(64),
      controlSequence: 1,
      changedAt: '2026-08-05T20:00:01.000Z',
      authorityCursor: latestCursor,
      commandReadiness: 'ready',
      browserExecution: {
        readiness: 'ready',
        protocol: 'prime-continuim.browser.v1',
        surface: 'playwright-cli',
        controller: 'playwright-core/1.63.0-alpha-2026-08-05',
        engine: 'verified-electron-host',
      },
      quiescence: thread.status === 'running'
        ? { state: 'uncertain', reason: 'active_without_operation' }
        : { state: 'idle_proven' },
    },
    latestCursor,
  }
}

function onlineConnection() {
  return {
    phase: 'online',
    target: { kind: 'local' },
    hostId: 'host-local',
    path: 'local_socket',
    since: '2026-08-05T20:00:00.000Z',
    attempt: 1,
    capabilities: ['prime_agent_commands_v2'],
  }
}

function residentLifecycleConnection() {
  return {
    ...onlineConnection(),
    capabilities: ['prime_agent_commands_v2', 'resident_lifecycle_v1'],
    runtimeReadiness: {
      kind: 'reported',
      hostId: 'host-local',
      hostdVersion: '0.1.0',
      startedAt: '2026-08-05T19:59:00.000Z',
      observedAt: '2026-08-05T20:00:00.000Z',
      snapshot: {
        status: 'ready',
        assurance: 'development-integrity',
      },
    },
  }
}

function registeredWorkspaceConnection(capabilities = [
  'prime_agent_commands_v2',
  'resident_registered_workspace_lifecycle_v1',
]) {
  return {
    phase: 'online',
    target: { kind: 'ssh', alias: 'saved-build-host' },
    hostId: 'host-b',
    path: 'ssh',
    since: '2026-08-05T20:00:00.000Z',
    attempt: 2,
    capabilities,
  }
}

function registeredWorkspaceFixture(residentActive = false) {
  const catalog = sshActivationCatalog('registered-generation', '2026-08-05T20:00:00.000Z')
  const thread = catalog.threads[0]
  const snapshot = recoverySnapshot(thread, 'Saved SSH workspace authority.')
  if (!residentActive) {
    snapshot.runtime.residency = 'client_owned'
    delete snapshot.runtime.activeSessionId
    delete snapshot.runtime.sessionId
  }
  const connection = registeredWorkspaceConnection()
  const cache = {
    version: 3,
    activeHostId: 'host-b',
    entries: {
      'host-b': { hostId: 'host-b', catalog, lastSnapshot: snapshot },
    },
  }
  return { catalog, thread, snapshot, connection, cache }
}

function registeredLocalWorkspaceFixture() {
  const fixture = registeredWorkspaceFixture()
  const connection = residentLifecycleConnection()
  const catalog = structuredClone(fixture.catalog)
  catalog.host = {
    ...catalog.host,
    hostId: 'host-local',
    kind: 'local',
    connectionPaths: [{ kind: 'local_socket', priority: 0, state: 'available' }],
  }
  catalog.projects = catalog.projects.map((project) => ({ ...project, hostId: 'host-local' }))
  catalog.threads = catalog.threads.map((thread) => ({
    ...thread,
    currentLocation: { ...thread.currentLocation, hostId: 'host-local' },
  }))
  const thread = catalog.threads[0]
  const snapshot = recoverySnapshot(thread, 'Saved local workspace authority.')
  snapshot.runtime.residency = 'client_owned'
  delete snapshot.runtime.activeSessionId
  delete snapshot.runtime.sessionId
  const cache = {
    version: 3,
    activeHostId: 'host-local',
    entries: {
      'host-local': { hostId: 'host-local', catalog, lastSnapshot: snapshot },
    },
  }
  return { catalog, thread, snapshot, connection, cache }
}

function registeredWorkspaceSelection() {
  return {
    selectionToken: 'registered-selection-one',
    operationId: 'registered-operation-one',
    expectedHostId: 'host-b',
    suggestedName: 'Prime GUI',
    expiresAt: '2099-08-05T20:05:00.000Z',
  }
}

function registeredProvisionStatus() {
  return {
    version: 1 as const,
    kind: 'provision' as const,
    operationId: 'registered-operation-one',
    phase: 'prepared' as const,
    expectedHostId: 'host-b',
    projectId: 'registered-project-one',
    workspaceId: 'registered-workspace-one',
    threadId: 'registered-thread-one',
    executionGenerationId: 'registered-thread-generation-one',
    preparedAt: '2026-08-05T20:00:01.000Z',
    updatedAt: '2026-08-05T20:00:02.000Z',
  }
}

function registeredSiblingProvisionOperation(
  fixture: ReturnType<typeof registeredWorkspaceFixture>,
  phase: 'prepared' | 'committed' | 'completed' = 'committed',
) {
  return {
    kind: 'provision' as const,
    provisionMode: 'registered_workspace' as const,
    operationId: 'registered-sibling-operation',
    expectedHostId: 'host-b',
    projectId: fixture.thread.currentLocation.projectId,
    workspaceId: fixture.thread.currentLocation.workspaceId,
    referenceThreadId: fixture.thread.threadId,
    referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    threadId: 'registered-sibling-thread',
    executionGenerationId: 'registered-sibling-generation',
    projectDisplayName: 'Prime GUI',
    threadTitle: 'Sibling resident',
    createdAt: '2026-08-05T20:00:01.000Z',
    updatedAt: '2026-08-05T20:00:02.000Z',
    state: (phase === 'prepared' ? 'submitted' : 'terminal') as 'terminal' | 'submitted',
    lastStatus: {
      version: 1 as const,
      kind: 'provision' as const,
      operationId: 'registered-sibling-operation',
      phase,
      expectedHostId: 'host-b',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      threadId: 'registered-sibling-thread',
      executionGenerationId: 'registered-sibling-generation',
      preparedAt: '2026-08-05T20:00:01.000Z',
      updatedAt: '2026-08-05T20:00:02.000Z',
      ...(phase === 'committed' || phase === 'completed'
        ? { terminalAt: '2026-08-05T20:00:02.000Z' }
        : {}),
      ...(phase === 'completed' ? { completionReason: 'owned_create_failed_before_effect' as const } : {}),
    },
  }
}

function registeredSiblingEndOperation(
  fixture: ReturnType<typeof registeredWorkspaceFixture>,
  phase: 'ending' | 'completed',
) {
  return {
    kind: 'end' as const,
    operationId: 'registered-sibling-end-operation',
    expectedHostId: 'host-b',
    projectId: fixture.thread.currentLocation.projectId,
    workspaceId: fixture.thread.currentLocation.workspaceId,
    threadId: 'registered-sibling-thread',
    executionGenerationId: 'registered-sibling-generation',
    sourceCursor: {
      threadId: 'registered-sibling-thread',
      executionGenerationId: 'registered-sibling-generation',
      generation: 'registered-sibling-daemon-generation',
      sequence: 7,
    },
    createdAt: '2026-08-05T20:00:03.000Z',
    updatedAt: '2026-08-05T20:00:04.000Z',
    state: (phase === 'completed' ? 'terminal' : 'submitted') as 'terminal' | 'submitted',
    lastStatus: {
      version: 1 as const,
      kind: 'end' as const,
      operationId: 'registered-sibling-end-operation',
      phase,
      expectedHostId: 'host-b',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      threadId: 'registered-sibling-thread',
      executionGenerationId: 'registered-sibling-generation',
      preparedAt: '2026-08-05T20:00:03.000Z',
      updatedAt: '2026-08-05T20:00:04.000Z',
      ...(phase === 'completed' ? { terminalAt: '2026-08-05T20:00:04.000Z' } : {}),
    },
  }
}

function runtimeIntegritySnapshot(status: 'failed' | 'initializing') {
  const base = {
    contractVersion: 1 as const,
    changedAt: status === 'failed' ? '2026-08-05T20:00:00.000Z' : '2026-08-05T20:00:01.000Z',
    trustAnchorId: 'a'.repeat(64),
    target: {
      runtime: 'prime-agent' as const,
      releaseVersion: '0.7.0',
      runtimeBuildId: 'fixture-build-1',
      platform: 'win32',
      arch: 'x64',
      manifestSha256: 'a'.repeat(64),
      treeSha256: 'b'.repeat(64),
      filesSha256: 'c'.repeat(64),
    },
  }
  return status === 'failed'
    ? {
        ...base,
        status,
        code: 'RUNTIME_INTEGRITY_FAILED',
        retryable: true,
        recoveryAction: 'retry_runtime_verification',
      }
    : { ...base, status, phase: 'preparing' as const, attempt: 2 }
}

function residentSelection() {
  return {
    selectionToken: 'resident-selection-one',
    operationId: 'resident-operation-one',
    expectedHostId: 'host-local',
    suggestedName: 'Prime GUI',
    expiresAt: '2099-08-05T20:05:00.000Z',
  }
}

function residentLifecycleOperation(state: 'submitted' | 'outcome_unknown' | 'requires_reselection' = 'outcome_unknown') {
  return {
    operationId: 'resident-operation-one',
    expectedHostId: 'host-local',
    projectId: 'resident-project-one',
    workspaceId: 'resident-workspace-one',
    threadId: 'resident-thread-one',
    executionGenerationId: 'resident-generation-one',
    projectDisplayName: 'Prime GUI',
    threadTitle: 'Prime GUI thread',
    createdAt: '2026-08-05T20:00:00.000Z',
    updatedAt: '2026-08-05T20:00:01.000Z',
    state,
  }
}

function committedResidentLifecycleStatus() {
  return {
    version: 1 as const,
    kind: 'provision' as const,
    operationId: 'resident-operation-one',
    phase: 'committed' as const,
    expectedHostId: 'host-local',
    projectId: 'resident-project-one',
    workspaceId: 'resident-workspace-one',
    threadId: 'resident-thread-one',
    executionGenerationId: 'resident-generation-one',
    preparedAt: '2026-08-05T20:00:00.000Z',
    updatedAt: '2026-08-05T20:00:02.000Z',
    terminalAt: '2026-08-05T20:00:02.000Z',
  }
}

function residentEndStatus(phase: 'ending' | 'completed' = 'ending') {
  return {
    version: 1 as const,
    kind: 'end' as const,
    operationId: 'resident-end-operation-one',
    phase,
    expectedHostId: 'host-local',
    projectId: 'project-local',
    workspaceId: 'workspace-local',
    threadId: 'thread-one',
    executionGenerationId: 'generation-one',
    preparedAt: '2026-08-05T20:00:01.000Z',
    updatedAt: phase === 'completed' ? '2026-08-05T20:00:04.000Z' : '2026-08-05T20:00:02.000Z',
    ...(phase === 'completed' ? { terminalAt: '2026-08-05T20:00:04.000Z' } : {}),
  }
}

function residentEndPreparation() {
  return {
    confirmationToken: 'resident-end-confirmation-one',
    operationId: 'resident-end-operation-one',
    expectedHostId: 'host-local',
    threadId: 'thread-one',
    executionGenerationId: 'generation-one',
    expiresAt: '2099-08-05T20:05:00.000Z',
  }
}

function residentEndOperation(
  state: 'submitted' | 'outcome_unknown' | 'terminal_refresh_pending' | 'terminal' = 'submitted',
  status = residentEndStatus(state === 'terminal' || state === 'terminal_refresh_pending' ? 'completed' : 'ending'),
) {
  return {
    kind: 'end' as const,
    operationId: 'resident-end-operation-one',
    expectedHostId: 'host-local',
    projectId: 'project-local',
    workspaceId: 'workspace-local',
    threadId: 'thread-one',
    executionGenerationId: 'generation-one',
    sourceCursor: recoverySnapshot(recoveryCatalog().threads[0], 'Source cursor.').latestCursor,
    createdAt: '2026-08-05T20:00:01.000Z',
    updatedAt: status.updatedAt,
    state,
    lastStatus: status,
  }
}

function endedResidentSnapshot() {
  const catalog = recoveryCatalog()
  const source = recoverySnapshot(catalog.threads[0], 'Saved resident transcript remains readable.')
  const { runtime: _runtime, goals: _goals, schedules: _schedules, ...retained } = source
  return {
    ...retained,
    generatedAt: '2026-08-05T20:00:05.000Z',
    thread: {
      ...retained.thread,
      status: 'idle',
      recap: 'Resident session ended.',
      updatedAt: '2026-08-05T20:00:05.000Z',
    },
    queueState: { pendingCommandIds: [], paused: false },
    childAgents: [],
    goals: [],
    schedules: [],
    pendingAttention: [],
    residentLifecycle: {
      version: 1,
      state: 'ended',
      operationId: 'resident-end-operation-one',
      bindingFingerprint: 'a'.repeat(64),
      endedAt: '2026-08-05T20:00:04.000Z',
      sourceCursor: retained.latestCursor,
      reason: 'user_end',
    },
  }
}

function catalogWithCommittedResidentThread() {
  const catalog = recoveryCatalog()
  return {
    ...catalog,
    generatedAt: '2026-08-05T20:00:03.000Z',
    projects: [
      ...catalog.projects,
      {
        projectId: 'resident-project-one',
        hostId: 'host-local',
        workspaceId: 'resident-workspace-one',
        displayName: 'Prime GUI resident',
        lastOpenedAt: '2026-08-05T20:00:03.000Z',
      },
    ],
    threads: [
      ...catalog.threads,
      {
        threadId: 'resident-thread-one',
        title: 'Prime GUI thread',
        projectIdentity: 'resident-project-one',
        currentLocation: {
          hostId: 'host-local',
          projectId: 'resident-project-one',
          workspaceId: 'resident-workspace-one',
          executionGenerationId: 'resident-generation-one',
        },
        status: 'idle',
        recap: 'Resident thread is ready.',
        unread: false,
        updatedAt: '2026-08-05T20:00:03.000Z',
      },
    ],
  }
}

function committedResidentSnapshot(body = 'Authoritative committed resident thread.') {
  const catalog = catalogWithCommittedResidentThread()
  const thread = catalog.threads.find((candidate) => candidate.threadId === 'resident-thread-one')!
  return {
    ...recoverySnapshot(thread, body),
    generatedAt: '2026-08-05T20:00:04.000Z',
  }
}

describe('NativeRendererApi', () => {
  it('projects exact latest-turn evidence, snapshot freshness, and aggregate Git facts', async () => {
    const catalog = recoveryCatalog()
    const cachedSnapshot = recoverySnapshot(catalog.threads[0]!, 'Cached outcome materialization.')
    cachedSnapshot.git = { branch: 'main', stagedFiles: 2, unstagedFiles: 3, untrackedFiles: 1 }
    const observedCursor = { ...cachedSnapshot.latestCursor }
    const terminalAssistant = { blockId: 'block-thread-one', stopReason: 'stop' }
    Object.assign(cachedSnapshot, {
      latestTurnOutcome: {
        outcomeVersion: 1,
        commandId: 'command-outcome-one',
        receiptId: 'receipt-outcome-one',
        observedAt: '2026-08-05T20:00:01.000Z',
        observedCursor,
        terminalAssistant,
      },
    })
    const freshSnapshot = structuredClone(cachedSnapshot)
    freshSnapshot.generatedAt = '2026-08-05T20:00:02.000Z'
    let snapshotReads = 0
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: cachedSnapshot },
        outbox: [],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn(() => {
        snapshotReads += 1
        return ok(freshSnapshot)
      }),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))

    const cached = await api.loadWorkbench()
    expect(cached.snapshotAuthority).toEqual({
      source: 'cached',
      generatedAt: cachedSnapshot.generatedAt,
      cursor: cachedSnapshot.latestCursor,
    })
    expect(cached.latestTurnOutcome).toEqual({
      outcomeVersion: 1,
      commandId: 'command-outcome-one',
      receiptId: 'receipt-outcome-one',
      observedAt: '2026-08-05T20:00:01.000Z',
      observedCursor,
      terminalAssistant,
    })
    expect(cached.gitSummary).toEqual({
      stagedFiles: 2,
      unstagedFiles: 3,
      untrackedFiles: 1,
      changedFileCount: 6,
      knownDetail: false,
    })
    expect(cached.gitSummary).not.toHaveProperty('files')

    await vi.waitFor(() => {
      expect(snapshotReads).toBe(1)
      expect(published.at(-1)?.snapshotAuthority?.source).toBe('live')
    })
    expect(published.at(-1)?.snapshotAuthority).toEqual({
      source: 'live',
      generatedAt: freshSnapshot.generatedAt,
      cursor: freshSnapshot.latestCursor,
    })
    unsubscribe()
  })

  it('fails closed on malformed or foreign latest-turn and Git evidence', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0]!, 'Only exact evidence should project.')
    Object.assign(snapshot, {
      latestTurnOutcome: {
        outcomeVersion: 1,
        commandId: 'command-foreign',
        receiptId: 'receipt-foreign',
        observedAt: '2026-08-05T20:00:02.000Z',
        observedCursor: {
          ...snapshot.latestCursor,
          executionGenerationId: 'foreign-generation',
        },
      },
      git: { branch: 'main', stagedFiles: -1, unstagedFiles: 0, untrackedFiles: 0 },
    })
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }

    const view = await new NativeRendererApi(bridge).loadWorkbench()
    expect(view.snapshotAuthority?.source).toBe('cached')
    expect(view.latestTurnOutcome).toBeUndefined()
    expect(view.gitSummary).toBeUndefined()
  })

  it('cleans historical RLM protocol blocks before they reach the transcript', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(
      catalog.threads[0]!,
      "rlm\nRLMSpawnHandle(agent_id='opaque-child', session_dir=PosixPath('/Users/operator/Library/Application Support/PrimeAgent/private'), model='openai-codex/gpt-5.6-sol')",
    )
    snapshot.materializedRecentBlocks.push({
      blockId: 'block-agent-message',
      kind: 'status',
      text: [
        'agent_message',
        '[from child:reviewer]',
        'Agent-to-agent message received.',
        'From: reviewer, active opaque-active, session opaque-session',
        'To: Prime Agent, active root-active, session root-session',
        'Message id: agentmsg_opaque',
        '',
        'Review complete.',
      ].join('\n'),
      createdAt: '2026-08-05T20:00:02.000Z',
      sequence: 2,
    })
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }

    const loaded = await new NativeRendererApi(bridge).loadWorkbench()
    const transcript = loaded.threads[0]?.transcript ?? []

    expect(transcript.map((block) => block.body)).toEqual([
      'rlm\nDelegated to RLM child · openai-codex/gpt-5.6-sol',
      'Agent message\nFrom reviewer\nReview complete.',
    ])
    expect(loaded.runtime.agentsReported).toBe(true)
    expect(loaded.agents).toEqual([{
      id: 'transcript-agent-block-agent-message',
      name: 'reviewer',
      sessionName: 'reviewer',
      role: 'Retained subagent',
      status: 'complete',
      hostName: 'This computer',
      answerPreview: 'Review complete.',
      repliedSinceTask: true,
    }])
    expect(JSON.stringify(transcript)).not.toMatch(/Users|Application Support|opaque-session|agentmsg_opaque|RLMSpawnHandle/)
  })

  it('keeps early workspace choice path-free and consumes conversion before an interrupted reply', async () => {
    const initializingConnection = {
      phase: 'online',
      target: { kind: 'local' },
      hostId: 'host-local',
      path: 'local_socket',
      since: '2026-08-05T20:00:00.000Z',
      attempt: 1,
      capabilities: ['runtime_integrity_v1'],
      runtimeReadiness: {
        kind: 'reported',
        hostId: 'host-local',
        hostdVersion: '0.1.0',
        startedAt: '2026-08-05T19:59:00.000Z',
        observedAt: '2026-08-05T20:00:00.000Z',
        snapshot: { status: 'initializing', phase: 'copying' },
      },
    }
    const preselection = {
      preselectionToken: 'preselection-one',
      suggestedName: 'Workspace',
      expiresAt: '2099-08-07T12:05:00.000Z',
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 3, entries: {} },
        outbox: [],
        connection: initializingConnection,
        appVersion: '0.1.0',
      })),
      preselectResidentWorkspace: vi.fn(() => ok(preselection)),
      completeResidentWorkspacePreselection: vi.fn(() => Promise.reject(new Error('reply interrupted'))),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()

    await expect(api.preselectResidentWorkspace()).resolves.toEqual(preselection)
    expect(JSON.stringify(preselection)).not.toMatch(/[/\\]|Users|private/i)
    const readyConnection = {
      ...initializingConnection,
      capabilities: ['runtime_integrity_v1', 'resident_lifecycle_v1'],
      runtimeReadiness: {
        ...initializingConnection.runtimeReadiness,
        snapshot: { status: 'ready', assurance: 'development-integrity' },
      },
    }
    const mutable = api as unknown as {
      connection: unknown
      mutationAuthorityReadyHostId?: string
    }
    mutable.connection = readyConnection
    mutable.mutationAuthorityReadyHostId = 'host-local'

    await expect(api.completeResidentWorkspacePreselection(preselection.preselectionToken))
      .rejects.toThrow('reply interrupted')
    await expect(api.completeResidentWorkspacePreselection(preselection.preselectionToken))
      .rejects.toThrow('Choose the workspace folder again')
    expect(bridge.completeResidentWorkspacePreselection).toHaveBeenCalledOnce()
  })

  it('rejects native early workspace receipts that expose any additional path field', async () => {
    const connection = {
      phase: 'online',
      target: { kind: 'local' },
      hostId: 'host-local',
      path: 'local_socket',
      since: '2026-08-05T20:00:00.000Z',
      attempt: 1,
      capabilities: ['runtime_integrity_v1'],
      runtimeReadiness: {
        kind: 'reported',
        hostId: 'host-local',
        hostdVersion: '0.1.0',
        startedAt: '2026-08-05T19:59:00.000Z',
        observedAt: '2026-08-05T20:00:00.000Z',
        snapshot: { status: 'initializing', phase: 'verifying' },
      },
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({ cache: { version: 3, entries: {} }, outbox: [], connection, appVersion: '0.1.0' })),
      preselectResidentWorkspace: vi.fn(() => ok({
        preselectionToken: 'preselection-one',
        suggestedName: 'Workspace',
        expiresAt: '2099-08-07T12:05:00.000Z',
        workspaceDirectory: '/Users/operator/private',
      })),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()
    await expect(api.preselectResidentWorkspace()).rejects.toThrow('invalid path-free early workspace choice')
  })

  it('forwards the narrow HUD bridge without mixing window state into workbench projection', async () => {
    const target = {
      expectedHostId: 'host-local',
      threadId: 'thread-one',
      expectedExecutionGenerationId: 'generation-one',
    }
    const expanded = { state: 'expanded' as const, target, ignoresMouseEvents: false }
    let hudListener: ((state: typeof expanded) => void) | undefined
    const bridge = {
      hudOpen: vi.fn(() => ok(expanded)),
      hudState: vi.fn(() => ok(expanded)),
      hudSetMode: vi.fn(() => ok({ ...expanded, state: 'buddy' as const })),
      hudClose: vi.fn(() => ok({ state: 'closed' as const })),
      hudReturnToWorkbench: vi.fn(() => ok(undefined)),
      hudSetIgnoreMouseEvents: vi.fn(() => ok({ ...expanded, ignoresMouseEvents: true })),
      onHudState: vi.fn((listener: (state: typeof expanded) => void) => {
        hudListener = listener
        return () => { hudListener = undefined }
      }),
    }
    const api = new NativeRendererApi(bridge)
    expect(api).not.toHaveProperty('codexSubscription')
    const observed = vi.fn()
    const unsubscribe = api.onHudState(observed)

    await expect(api.hudOpen(target)).resolves.toEqual(expanded)
    await expect(api.hudState()).resolves.toEqual(expanded)
    await expect(api.hudSetMode('buddy')).resolves.toMatchObject({ state: 'buddy', target })
    await expect(api.hudSetIgnoreMouseEvents(true)).resolves.toMatchObject({ ignoresMouseEvents: true })
    await expect(api.hudReturnToWorkbench()).resolves.toBeUndefined()
    await expect(api.hudClose()).resolves.toEqual({ state: 'closed' })
    hudListener?.(expanded)
    expect(observed).toHaveBeenCalledWith(expanded)
    unsubscribe()
    expect(hudListener).toBeUndefined()
    expect(bridge.hudOpen).toHaveBeenCalledWith(target)
    expect(bridge.hudSetMode).toHaveBeenCalledWith('buddy')
    expect(bridge.hudSetIgnoreMouseEvents).toHaveBeenCalledWith(true)
  })

  it('uses one exact idle saved SSH workspace authority without accepting renderer project edits', async () => {
    const fixture = registeredWorkspaceFixture()
    const reference = {
      kind: 'registered_workspace' as const,
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      selectResidentWorkspace: vi.fn(() => ok(registeredWorkspaceSelection())),
      provisionResident: vi.fn(() => ok(registeredProvisionStatus())),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const unsubscribe = api.subscribe(() => undefined)
    const initial = await api.loadWorkbench()

    expect(initial.operations.provisionResident).toBe(true)
    expect(initial.operations.endResident).toBeUndefined()
    const selection = await api.selectResidentWorkspace(reference)
    expect(selection).toEqual(expect.objectContaining({
      ...reference,
      expectedHostId: 'host-b',
      suggestedName: 'Prime GUI',
    }))
    expect(bridge.selectResidentWorkspace).toHaveBeenCalledWith(reference)

    await expect(api.provisionResident({
      selectionToken: selection.selectionToken,
      projectDisplayName: 'Renderer must not rename this project',
      threadTitle: 'New saved-workspace thread',
    })).resolves.toEqual(registeredProvisionStatus())
    expect(bridge.provisionResident).toHaveBeenCalledWith({
      selectionToken: selection.selectionToken,
      projectDisplayName: selection.suggestedName,
      threadTitle: 'New saved-workspace thread',
    })
    await expect(api.provisionResident({
      selectionToken: selection.selectionToken,
      projectDisplayName: selection.suggestedName,
      threadTitle: 'New saved-workspace thread',
    })).rejects.toThrow(/select this saved workspace again/i)
    expect(bridge.provisionResident).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it('starts another task from an ended saved local workspace without reopening the folder picker', async () => {
    const fixture = registeredLocalWorkspaceFixture()
    const selection = {
      ...registeredWorkspaceSelection(),
      expectedHostId: 'host-local',
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      selectResidentWorkspace: vi.fn(() => ok(selection)),
      provisionResident: vi.fn(() => ok({ ...registeredProvisionStatus(), expectedHostId: 'host-local' })),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()
    const reference = {
      kind: 'registered_workspace' as const,
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    }

    await expect(api.selectResidentWorkspace(reference)).resolves.toMatchObject({
      ...reference,
      expectedHostId: 'host-local',
    })
    expect(bridge.selectResidentWorkspace).toHaveBeenCalledWith(reference)
  })

  it('withholds saved-workspace create while the exact selected resident authority remains endable', async () => {
    const fixture = registeredWorkspaceFixture(true)
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      selectResidentWorkspace: vi.fn(() => ok(registeredWorkspaceSelection())),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const snapshot = await api.loadWorkbench()

    expect(snapshot.operations.provisionResident).toBe(true)
    expect(snapshot.operations.endResident).toBe(true)
    await expect(api.selectResidentWorkspace({
      kind: 'registered_workspace',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    })).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
    expect(bridge.selectResidentWorkspace).not.toHaveBeenCalled()
  })

  it('withholds saved-workspace create for an exact committed sibling resident in the same workspace', async () => {
    const fixture = registeredWorkspaceFixture()
    const operation = registeredSiblingProvisionOperation(fixture)
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [operation],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      selectResidentWorkspace: vi.fn(() => ok(registeredWorkspaceSelection())),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const snapshot = await api.loadWorkbench()

    expect(snapshot.operations.provisionResident).toBe(true)
    expect(snapshot.residentLifecycleOperations).toEqual([
      expect.objectContaining({ operationId: operation.operationId, lastStatus: expect.objectContaining({ phase: 'committed' }) }),
    ])
    await expect(api.selectResidentWorkspace({
      kind: 'registered_workspace',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    })).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
    expect(bridge.selectResidentWorkspace).not.toHaveBeenCalled()
  })

  it('denies fresh create but permits only the exact prepared saved-workspace continuation', async () => {
    const fixture = registeredWorkspaceFixture()
    const operation: ResidentLifecycleOperationSummary = registeredSiblingProvisionOperation(fixture, 'prepared')
    const selection = { ...registeredWorkspaceSelection(), operationId: operation.operationId }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [operation],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      selectResidentWorkspace: vi.fn(() => ok(selection)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()
    const reference = {
      kind: 'registered_workspace' as const,
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    }

    await expect(api.selectResidentWorkspace(reference)).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
    await expect(api.selectResidentWorkspace({
      ...reference,
      resumeOperationId: operation.operationId,
    })).resolves.toMatchObject({ operationId: operation.operationId, ...reference })
    expect(bridge.selectResidentWorkspace).toHaveBeenCalledTimes(1)
  })

  it.each([
    'owned_create_dispatching',
    'owned_observed',
    'promotion_dispatching',
    'promoted_observed',
    'projection_committed',
    'quarantined',
  ] as const)('denies fresh create while a foreign saved-workspace provision is %s', async (phase) => {
    const fixture = registeredWorkspaceFixture()
    const operation: ResidentLifecycleOperationSummary = registeredSiblingProvisionOperation(fixture, 'prepared')
    operation.state = 'outcome_unknown'
    operation.lastStatus = {
      ...operation.lastStatus!,
      phase,
      ...(phase === 'quarantined'
        ? {
            quarantinedFrom: 'promotion_dispatching' as const,
            quarantineReason: 'external_outcome_unknown' as const,
          }
        : {}),
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [operation],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      selectResidentWorkspace: vi.fn(() => ok(registeredWorkspaceSelection())),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()

    await expect(api.selectResidentWorkspace({
      kind: 'registered_workspace',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    })).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
    expect(bridge.selectResidentWorkspace).not.toHaveBeenCalled()
  })

  it.each(['outcome_unknown', 'quarantined', 'committed'] as const)(
    'keeps a visible %s saved-workspace operation check-only instead of deferring it to main validation',
    async (state) => {
      const fixture = registeredWorkspaceFixture()
      const operation: ResidentLifecycleOperationSummary = registeredSiblingProvisionOperation(
        fixture,
        state === 'committed' ? 'committed' : 'prepared',
      )
      if (state === 'outcome_unknown') {
        operation.state = 'outcome_unknown'
        operation.lastStatus = undefined
      } else if (state === 'quarantined') {
        operation.state = 'outcome_unknown'
        operation.lastStatus = {
          ...operation.lastStatus!,
          phase: 'quarantined',
          quarantinedFrom: 'promotion_dispatching',
          quarantineReason: 'external_outcome_unknown',
        }
      }
      const bridge = {
        bootstrap: vi.fn(() => ok({
          cache: fixture.cache,
          outbox: [],
          residentLifecycleOperations: [operation],
          connection: fixture.connection,
          appVersion: '0.1.0',
        })),
        hostCatalog: vi.fn(() => ok(fixture.catalog)),
        requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
        selectResidentWorkspace: vi.fn(() => ok({
          ...registeredWorkspaceSelection(),
          operationId: operation.operationId,
        })),
        onConnectionState: vi.fn(() => () => undefined),
        onSnapshot: vi.fn(() => () => undefined),
        onHandoffProgress: vi.fn(() => () => undefined),
      }
      const api = new NativeRendererApi(bridge)
      await api.loadWorkbench()

      await expect(api.selectResidentWorkspace({
        kind: 'registered_workspace',
        projectId: fixture.thread.currentLocation.projectId,
        workspaceId: fixture.thread.currentLocation.workspaceId,
        referenceThreadId: fixture.thread.threadId,
        referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
        resumeOperationId: operation.operationId,
      })).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
      expect(bridge.selectResidentWorkspace).not.toHaveBeenCalled()
    },
  )

  it('mints a fresh registered operation after an exact completed pre-effect setup', async () => {
    const fixture = registeredWorkspaceFixture()
    const operation = registeredSiblingProvisionOperation(fixture, 'completed')
    const selection = { ...registeredWorkspaceSelection(), operationId: 'registered-safe-retry-operation' }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [operation],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      selectResidentWorkspace: vi.fn(() => ok(selection)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()

    await expect(api.selectResidentWorkspace({
      kind: 'registered_workspace',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
      resumeOperationId: operation.operationId,
    })).resolves.toMatchObject({ operationId: selection.operationId })
    expect(selection.operationId).not.toBe(operation.operationId)
  })

  it('defers a missing projected saved-workspace continuation to the main durable ledger', async () => {
    const fixture = registeredWorkspaceFixture()
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      selectResidentWorkspace: vi.fn(() => ok(registeredWorkspaceSelection())),
      provisionResident: vi.fn(() => ok(registeredProvisionStatus())),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()
    const reference = {
      kind: 'registered_workspace' as const,
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    }
    const selection = await api.selectResidentWorkspace(reference)
    await expect(api.provisionResident({
      selectionToken: selection.selectionToken,
      projectDisplayName: selection.suggestedName,
      threadTitle: 'Prepared fallback thread',
    })).resolves.toMatchObject({ phase: 'prepared', operationId: selection.operationId })

    await expect(api.selectResidentWorkspace({
      ...reference,
      resumeOperationId: selection.operationId,
    })).resolves.toMatchObject({ operationId: selection.operationId, ...reference })
    expect(bridge.selectResidentWorkspace).toHaveBeenCalledTimes(2)
  })

  it('does not let main-ledger validation bypass a visible resident runtime hold', async () => {
    const fixture = registeredWorkspaceFixture(true)
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      selectResidentWorkspace: vi.fn(() => ok({
        ...registeredWorkspaceSelection(),
        operationId: 'missing-from-renderer-hydration',
      })),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()

    await expect(api.selectResidentWorkspace({
      kind: 'registered_workspace',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
      resumeOperationId: 'missing-from-renderer-hydration',
    })).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
    expect(bridge.selectResidentWorkspace).not.toHaveBeenCalled()
  })

  it('keeps unresolved no-status saved-workspace authority closed to fresh create', async () => {
    const fixture = registeredWorkspaceFixture()
    const operation = {
      ...registeredSiblingProvisionOperation(fixture, 'prepared'),
      state: 'outcome_unknown' as const,
      lastStatus: undefined,
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [operation],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      selectResidentWorkspace: vi.fn(() => ok(registeredWorkspaceSelection())),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()

    await expect(api.selectResidentWorkspace({
      kind: 'registered_workspace',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    })).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
    expect(bridge.selectResidentWorkspace).not.toHaveBeenCalled()
  })

  it('does not let one recovery operation bypass a different same-workspace resident authority', async () => {
    const fixture = registeredWorkspaceFixture()
    const recovery = registeredSiblingProvisionOperation(fixture, 'prepared')
    const conflict = {
      ...registeredSiblingProvisionOperation(fixture, 'committed'),
      operationId: 'registered-conflicting-operation',
      threadId: 'registered-conflicting-thread',
      executionGenerationId: 'registered-conflicting-generation',
      lastStatus: {
        ...registeredSiblingProvisionOperation(fixture, 'committed').lastStatus!,
        operationId: 'registered-conflicting-operation',
        threadId: 'registered-conflicting-thread',
        executionGenerationId: 'registered-conflicting-generation',
      },
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [recovery, conflict],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      selectResidentWorkspace: vi.fn(() => ok({ ...registeredWorkspaceSelection(), operationId: recovery.operationId })),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()

    await expect(api.selectResidentWorkspace({
      kind: 'registered_workspace',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
      resumeOperationId: recovery.operationId,
    })).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
    expect(bridge.selectResidentWorkspace).not.toHaveBeenCalled()
  })

  it('releases committed sibling authority only for an exact completed End record', async () => {
    const fixture = registeredWorkspaceFixture()
    const provision = registeredSiblingProvisionOperation(fixture)
    const completedEnd = registeredSiblingEndOperation(fixture, 'completed')
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [provision, completedEnd],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      selectResidentWorkspace: vi.fn(() => ok(registeredWorkspaceSelection())),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()

    await expect(api.selectResidentWorkspace({
      kind: 'registered_workspace',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    })).resolves.toMatchObject({ kind: 'registered_workspace' })
    expect(bridge.selectResidentWorkspace).toHaveBeenCalledTimes(1)
  })

  it('does not release a saved workspace for a completed End from another resident lineage', async () => {
    const fixture = registeredWorkspaceFixture()
    const provision = registeredSiblingProvisionOperation(fixture)
    const completedEnd = registeredSiblingEndOperation(fixture, 'completed')
    completedEnd.executionGenerationId = 'different-resident-generation'
    completedEnd.sourceCursor.executionGenerationId = 'different-resident-generation'
    completedEnd.lastStatus = {
      ...completedEnd.lastStatus!,
      executionGenerationId: 'different-resident-generation',
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [provision, completedEnd],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      selectResidentWorkspace: vi.fn(() => ok(registeredWorkspaceSelection())),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()

    await expect(api.selectResidentWorkspace({
      kind: 'registered_workspace',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    })).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
    expect(bridge.selectResidentWorkspace).not.toHaveBeenCalled()
  })

  it('keeps exact registered End review available while fresh create is occupied', async () => {
    const fixture = registeredWorkspaceFixture(true)
    const threadId = fixture.thread.threadId
    const executionGenerationId = fixture.thread.currentLocation.executionGenerationId
    const operation = {
      kind: 'end' as const,
      operationId: 'registered-end-operation-one',
      expectedHostId: 'host-b',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      threadId,
      executionGenerationId,
      sourceCursor: {
        threadId,
        executionGenerationId,
        generation: 'registered-end-daemon-generation',
        sequence: 7,
      },
      createdAt: '2026-08-05T20:00:01.000Z',
      updatedAt: '2026-08-05T20:00:02.000Z',
      state: 'submitted' as const,
      lastStatus: {
        version: 1 as const,
        kind: 'end' as const,
        operationId: 'registered-end-operation-one',
        phase: 'ending' as const,
        expectedHostId: 'host-b',
        projectId: fixture.thread.currentLocation.projectId,
        workspaceId: fixture.thread.currentLocation.workspaceId,
        threadId,
        executionGenerationId,
        preparedAt: '2026-08-05T20:00:01.000Z',
        updatedAt: '2026-08-05T20:00:02.000Z',
      },
    }
    const preparation = {
      confirmationToken: 'registered-end-confirmation-one',
      operationId: operation.operationId,
      expectedHostId: 'host-b',
      threadId,
      executionGenerationId,
      expiresAt: '2099-08-05T20:05:00.000Z',
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [operation],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      prepareResidentEnd: vi.fn(() => ok(preparation)),
      selectResidentWorkspace: vi.fn(() => ok(registeredWorkspaceSelection())),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const snapshot = await api.loadWorkbench()

    expect(snapshot.operations.provisionResident).toBe(true)
    expect(snapshot.operations.endResident).toBe(true)
    await expect(api.prepareResidentEnd({
      expectedHostId: operation.expectedHostId,
      projectId: operation.projectId,
      workspaceId: operation.workspaceId,
      threadId: operation.threadId,
      executionGenerationId: operation.executionGenerationId,
      resumeOperationId: operation.operationId,
    })).resolves.toEqual(preparation)
    expect(bridge.prepareResidentEnd).toHaveBeenCalledTimes(1)
    await expect(api.selectResidentWorkspace({
      kind: 'registered_workspace',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    })).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
  })

  it('invalidates a saved-workspace selection across connection and source-generation fences without mutation', async () => {
    const fixture = registeredWorkspaceFixture()
    let connectionListener: ((state: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn((input: { threadId: string }) => {
        const thread = fixture.catalog.threads.find((candidate) => candidate.threadId === input.threadId)!
        const selected = recoverySnapshot(thread, 'Exact selected SSH source.')
        selected.runtime.residency = 'client_owned'
        delete selected.runtime.activeSessionId
        delete selected.runtime.sessionId
        return ok(selected)
      }),
      selectResidentWorkspace: vi.fn(() => ok(registeredWorkspaceSelection())),
      provisionResident: vi.fn(() => ok(registeredProvisionStatus())),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const unsubscribe = api.subscribe(() => undefined)
    await api.loadWorkbench()
    const input = {
      kind: 'registered_workspace' as const,
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    }
    const first = await api.selectResidentWorkspace(input)
    await api.selectThread(fixture.catalog.threads[1].threadId)
    await expect(api.provisionResident({
      selectionToken: first.selectionToken,
      projectDisplayName: first.suggestedName,
      threadTitle: 'Stale source must not start',
    })).rejects.toMatchObject({ durableOperationPossible: false })

    await api.selectThread(fixture.thread.threadId)
    const second = await api.selectResidentWorkspace(input)
    connectionListener?.({ ...fixture.connection, phase: 'reconnecting' })
    connectionListener?.(fixture.connection)
    await expect(api.provisionResident({
      selectionToken: second.selectionToken,
      projectDisplayName: second.suggestedName,
      threadTitle: 'Stale connection must not start',
    })).rejects.toMatchObject({ durableOperationPossible: false })
    expect(bridge.provisionResident).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('keeps exact SSH status checkable after capability withdrawal while denying every new lifecycle mutation', async () => {
    const fixture = registeredWorkspaceFixture()
    let connectionListener: ((state: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [],
        connection: fixture.connection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      residentLifecycleStatus: vi.fn(() => ok({ status: null })),
      selectResidentWorkspace: vi.fn(() => ok(registeredWorkspaceSelection())),
      provisionResident: vi.fn(() => ok(registeredProvisionStatus())),
      prepareResidentEnd: vi.fn(),
      endResident: vi.fn(),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    const initial = await api.loadWorkbench()
    expect(initial.operations.provisionResident).toBe(true)
    expect(initial.operations.endResident).toBeUndefined()

    connectionListener?.(registeredWorkspaceConnection(['prime_agent_commands_v2']))
    expect(published.at(-1)?.operations.provisionResident).toBeUndefined()
    expect(published.at(-1)?.operations.endResident).toBeUndefined()
    await expect(api.residentLifecycleStatus({
      expectedHostId: 'host-b',
      operationId: 'registered-operation-one',
    })).resolves.toBeNull()
    await expect(api.selectResidentWorkspace({
      kind: 'registered_workspace',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    })).rejects.toThrow(/not ready on this verified host/i)
    await expect(api.prepareResidentEnd({
      expectedHostId: 'host-b',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      threadId: fixture.thread.threadId,
      executionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    })).rejects.toThrow(/not ready on this verified host/i)
    expect(bridge.residentLifecycleStatus).toHaveBeenCalledOnce()
    expect(bridge.selectResidentWorkspace).not.toHaveBeenCalled()
    expect(bridge.provisionResident).not.toHaveBeenCalled()
    expect(bridge.prepareResidentEnd).not.toHaveBeenCalled()
    expect(bridge.endResident).not.toHaveBeenCalled()
    unsubscribe()
  })

  it.each([
    ['missing capability', registeredWorkspaceConnection(['prime_agent_commands_v2'])],
    ['relay path', { ...registeredWorkspaceConnection(), path: 'relay' }],
    ['unverified connection', { ...registeredWorkspaceConnection(), phase: 'reconnecting' }],
  ])('does not advertise saved-workspace lifecycle on a %s', async (_label, connection) => {
    const fixture = registeredWorkspaceFixture()
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        residentLifecycleOperations: [],
        connection,
        appVersion: '0.1.0',
      })),
      connect: vi.fn(),
      hostCatalog: vi.fn(() => ok(fixture.catalog)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshot)),
      selectResidentWorkspace: vi.fn(),
    }
    const api = new NativeRendererApi(bridge, { allowConnectionInitiation: false })
    const snapshot = await api.loadWorkbench()
    expect(snapshot.operations.provisionResident).toBeUndefined()
    expect(snapshot.operations.endResident).toBeUndefined()
    await expect(api.selectResidentWorkspace({
      kind: 'registered_workspace',
      projectId: fixture.thread.currentLocation.projectId,
      workspaceId: fixture.thread.currentLocation.workspaceId,
      referenceThreadId: fixture.thread.threadId,
      referenceExecutionGenerationId: fixture.thread.currentLocation.executionGenerationId,
    })).rejects.toThrow()
    expect(bridge.selectResidentWorkspace).not.toHaveBeenCalled()
  })

  it('consumes one exact resident end confirmation before the mutation and never retries it', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Resident end admission.')
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        durableUncertainReceipts: [],
        residentLifecycleOperations: [],
        connection: residentLifecycleConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn(() => ok(snapshot)),
      prepareResidentEnd: vi.fn(() => ok(residentEndPreparation())),
      endResident: vi.fn(() => ok(residentEndStatus('ending'))),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const unsubscribe = api.subscribe(() => undefined)
    await api.loadWorkbench()

    const preparation = await api.prepareResidentEnd({
      expectedHostId: 'host-local',
      projectId: 'project-local',
      workspaceId: 'workspace-local',
      threadId: 'thread-one',
      executionGenerationId: 'generation-one',
    })
    await expect(api.endResident({
      confirmationToken: preparation.confirmationToken,
      consent: true,
    })).resolves.toEqual(residentEndStatus('ending'))
    await expect(api.endResident({
      confirmationToken: preparation.confirmationToken,
      consent: true,
    })).rejects.toThrow(/review this resident session again/i)

    expect(bridge.prepareResidentEnd).toHaveBeenCalledTimes(1)
    expect(bridge.endResident).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('exposes a pre-dispatch resident End as a resumable action instead of passive progress', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Resident end recovery.')
    snapshot.runtime.residency = 'client_owned'
    delete snapshot.runtime.activeSessionId
    delete snapshot.runtime.sessionId
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        durableUncertainReceipts: [],
        residentLifecycleOperations: [residentEndOperation('submitted')],
        connection: residentLifecycleConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn(() => ok(snapshot)),
      prepareResidentEnd: vi.fn(() => ok(residentEndPreparation())),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const view = await api.loadWorkbench()

    expect(view.composerReceipt).toEqual({
      state: 'sent',
      operation: 'end',
      retryable: true,
      message: 'Ready to finish · Prime Agent has not received an End request',
    })
    expect(view.operations.endResident).toBe(true)
    await expect(api.prepareResidentEnd({
      expectedHostId: 'host-local',
      projectId: 'project-local',
      workspaceId: 'workspace-local',
      threadId: 'thread-one',
      executionGenerationId: 'generation-one',
      resumeOperationId: 'resident-end-operation-one',
    })).resolves.toEqual(residentEndPreparation())
    expect(bridge.prepareResidentEnd).toHaveBeenCalledOnce()
  })

  it('offers the same-operation End retry when the exact host has no durable result', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Resident End result is missing.')
    snapshot.runtime.residency = 'client_owned'
    delete snapshot.runtime.activeSessionId
    delete snapshot.runtime.sessionId
    const operation = {
      ...residentEndOperation('outcome_unknown'),
      lastStatus: undefined,
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        durableUncertainReceipts: [],
        residentLifecycleOperations: [operation],
        connection: residentLifecycleConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn(() => ok(snapshot)),
      prepareResidentEnd: vi.fn(() => ok(residentEndPreparation())),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const view = await api.loadWorkbench()

    expect(view.operations.endResident).toBe(true)
    expect(view.composerReceipt).toMatchObject({ state: 'uncertain', operation: 'end' })
    await expect(api.prepareResidentEnd({
      expectedHostId: operation.expectedHostId,
      projectId: operation.projectId,
      workspaceId: operation.workspaceId,
      threadId: operation.threadId,
      executionGenerationId: operation.executionGenerationId,
      resumeOperationId: operation.operationId,
    })).resolves.toEqual(residentEndPreparation())
  })

  it('does not expose a fresh resident End from a non-exact saved operation after runtime detach', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Detached resident session.')
    snapshot.runtime.residency = 'client_owned'
    delete snapshot.runtime.activeSessionId
    delete snapshot.runtime.sessionId
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        durableUncertainReceipts: [],
        residentLifecycleOperations: [{
          ...residentEndOperation('submitted'),
          workspaceId: 'other-workspace',
        }],
        connection: residentLifecycleConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn(() => ok(snapshot)),
      prepareResidentEnd: vi.fn(() => ok(residentEndPreparation())),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const view = await api.loadWorkbench()

    expect(view.operations.endResident).toBeUndefined()
    await expect(api.prepareResidentEnd({
      expectedHostId: 'host-local',
      projectId: 'project-local',
      workspaceId: 'workspace-local',
      threadId: 'thread-one',
      executionGenerationId: 'generation-one',
    })).rejects.toThrow(/not ready on this verified host/i)
    expect(bridge.prepareResidentEnd).not.toHaveBeenCalled()
  })

  it('materializes only an exact same-lineage ended disposition after a completed resident end', async () => {
    const catalog = recoveryCatalog()
    const source = recoverySnapshot(catalog.threads[0], 'Resident end source.')
    const ended = endedResidentSnapshot()
    const completed = residentEndStatus('completed')
    let bootstrapReads = 0
    const bridge = {
      bootstrap: vi.fn(() => {
        bootstrapReads += 1
        return ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: source },
          outbox: [],
          quarantinedOutboxCount: 0,
          durableUncertainReceipts: [],
          residentLifecycleOperations: bootstrapReads === 1 ? [] : [residentEndOperation('terminal', completed)],
          connection: residentLifecycleConnection(),
          appVersion: '0.1.0',
        })
      }),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn(() => ok(ended)),
      prepareResidentEnd: vi.fn(() => ok(residentEndPreparation())),
      endResident: vi.fn(() => ok(completed)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((next) => published.push(next))
    await api.loadWorkbench()
    const preparation = await api.prepareResidentEnd({
      expectedHostId: 'host-local',
      projectId: 'project-local',
      workspaceId: 'workspace-local',
      threadId: 'thread-one',
      executionGenerationId: 'generation-one',
    })

    await expect(api.endResident({ confirmationToken: preparation.confirmationToken, consent: true }))
      .resolves.toEqual(completed)
    const view = published.at(-1)!
    expect(view.selectedThreadId).toBe('thread-one')
    expect(view.threads.find((thread) => thread.id === 'thread-one')?.residentLifecycle).toEqual({
      state: 'ended',
      operationId: 'resident-end-operation-one',
      endedAt: '2026-08-05T20:00:04.000Z',
      reason: 'user_end',
    })
    expect(view.operations.startResidentTurn).toBe(false)
    expect(view.operations.stopResidentTurn).toBe(false)
    expect(view.composerReceipt).toMatchObject({ operation: 'end', state: 'idle' })
    expect(bridge.endResident).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('returns an empty cold cache immediately, then publishes the local catalog and thread snapshot', async () => {
    const catalog = {
      snapshotVersion: 1,
      generatedAt: '2026-08-05T20:00:00.000Z',
      host: {
        hostId: 'host-local',
        displayName: 'This computer',
        kind: 'local',
        reachability: 'online',
        compatibility: 'compatible',
        connectionPaths: [{ kind: 'local_socket', priority: 0, state: 'available', latencyMs: 1 }],
      },
      projects: [
        {
          projectId: 'project-prime',
          hostId: 'host-local',
          workspaceId: 'workspace-prime',
          displayName: 'Prime GUI',
          lastOpenedAt: '2026-08-05T20:00:00.000Z',
        },
      ],
      threads: [
        {
          threadId: 'thread-seamless',
          title: 'Seamless remote experience',
          projectIdentity: 'project-prime',
          currentLocation: {
            hostId: 'host-local',
            projectId: 'project-prime',
            workspaceId: 'workspace-prime',
            executionGenerationId: 'generation-1',
          },
          status: 'running',
          recap: 'Continuing from durable state.',
          unread: false,
          updatedAt: '2026-08-05T20:00:00.000Z',
        },
      ],
    }
    const threadSnapshot = {
      snapshotVersion: 1,
      generatedAt: '2026-08-05T20:00:01.000Z',
      thread: catalog.threads[0],
      materializedRecentBlocks: [
        {
          blockId: 'block-1',
          kind: 'assistant',
          text: 'Loaded from the authoritative local host.',
          createdAt: '2026-08-05T20:00:01.000Z',
          sequence: 1,
        },
      ],
      queueState: { pendingCommandIds: [], paused: false },
      childAgents: [],
      goals: [],
      schedules: [],
      pendingAttention: [],
      git: { branch: 'main', stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
      evidence: { testsPassed: 0, testsFailed: 0, artifactCount: 0 },
      latestCursor: {
        threadId: 'thread-seamless',
        executionGenerationId: 'generation-1',
        generation: 'daemon-thread-seamless',
        sequence: 1,
      },
    }

    const calls: string[] = []
    const bridge = {
      bootstrap: vi.fn(() => {
        calls.push('bootstrap')
        return ok({
          cache: { version: 1 },
          outbox: [],
          connection: { phase: 'offline', since: '2026-08-05T20:00:00.000Z', attempt: 0 },
          appVersion: '0.1.0',
        })
      }),
      connect: vi.fn(() => {
        calls.push('connect')
        return ok({
          phase: 'online',
          target: { kind: 'local' },
          hostId: 'host-local',
          path: 'local_socket',
          since: '2026-08-05T20:00:00.000Z',
          attempt: 1,
        })
      }),
      hostCatalog: vi.fn(() => {
        calls.push('hostCatalog')
        return ok(catalog)
      }),
      requestSnapshot: vi.fn(() => {
        calls.push('requestSnapshot')
        return ok(threadSnapshot)
      }),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }

    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    const cached = await api.loadWorkbench()

    expect(cached.projects).toEqual([])
    expect(cached.threads).toEqual([])

    await vi.waitFor(() => {
      expect(published.at(-1)?.selectedThreadId).toBe('thread-seamless')
      expect(published.at(-1)?.threads[0]?.transcript[0]?.body).toBe('Loaded from the authoritative local host.')
    })
    expect(calls).toEqual(['bootstrap', 'connect', 'bootstrap', 'hostCatalog', 'requestSnapshot'])
    expect(bridge.connect).toHaveBeenCalledWith({ kind: 'local' })
    expect(published.at(-1)?.runtime.goals).toBeUndefined()
    expect(published.at(-1)?.runtime.schedules).toBeUndefined()
    expect(published.at(-1)?.operations).toEqual({
      submitCommands: false,
      startResidentTurn: false,
      stopResidentTurn: false,
      crossHostHandoff: false,
    })
    unsubscribe()
  })

  it('projects one exact generation-bound assistant stream and preserves its identity while the body grows', async () => {
    const catalog = recoveryCatalog()
    const initial = {
      ...recoverySnapshot(catalog.threads[0], 'The admitted user turn is retained.'),
      inProgressStream: {
        blockId: 'assistant-stream-one',
        text: 'First authoritative assistant fragment.',
        startedAt: '2026-08-05T20:00:02.000Z',
      },
    }
    let snapshotListener: ((snapshot: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: initial },
        outbox: [],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn((listener: (snapshot: unknown) => void) => {
        snapshotListener = listener
        return () => undefined
      }),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    const loaded = await api.loadWorkbench()

    expect(loaded.threads[0]?.transcript.at(-1)).toMatchObject({
      id: 'assistant-stream-one',
      kind: 'assistant',
      author: 'Prime Agent',
      body: 'First authoritative assistant fragment.',
      streaming: true,
    })

    const growing = structuredClone(initial)
    growing.generatedAt = '2026-08-05T20:00:03.000Z'
    growing.latestCursor.sequence = 2
    growing.inProgressStream.text = 'First authoritative assistant fragment. Then the verified continuation.'
    snapshotListener?.(growing)

    const projectedGrowth = published.at(-1)?.threads[0]?.transcript
    expect(projectedGrowth).toHaveLength(2)
    expect(projectedGrowth?.at(-1)).toMatchObject({
      id: 'assistant-stream-one',
      body: 'First authoritative assistant fragment. Then the verified continuation.',
      streaming: true,
    })

    const completed = structuredClone(growing)
    completed.generatedAt = '2026-08-05T20:00:04.000Z'
    completed.latestCursor.sequence = 3
    completed.materializedRecentBlocks.push({
      blockId: 'assistant-materialized-one',
      kind: 'assistant',
      text: 'First authoritative assistant fragment. Then the completed answer.',
      createdAt: '2026-08-05T20:00:02.000Z',
      sequence: 2,
    })
    delete (completed as Partial<typeof completed>).inProgressStream
    snapshotListener?.(completed)

    const projectedCompletion = published.at(-1)?.threads[0]?.transcript ?? []
    expect(projectedCompletion.some((block) => block.id === 'assistant-stream-one')).toBe(false)
    const materializedCompletion = projectedCompletion.filter((block) => block.id === 'assistant-materialized-one')
    expect(materializedCompletion).toHaveLength(1)
    expect(materializedCompletion[0]).toMatchObject({
      body: 'First authoritative assistant fragment. Then the completed answer.',
    })
    expect(materializedCompletion[0]?.streaming).toBeUndefined()
    unsubscribe()
  })

  it('fails closed for malformed, colliding, or cross-generation assistant streams', async () => {
    const catalog = recoveryCatalog()
    const loadCached = async (snapshot: unknown, cachedCatalog: unknown = catalog) => {
      const bridge = {
        bootstrap: vi.fn(() => ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog: cachedCatalog, lastSnapshot: snapshot },
          outbox: [],
          connection: onlineConnection(),
          appVersion: '0.1.0',
        })),
        hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
        requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
        onConnectionState: vi.fn(() => () => undefined),
        onSnapshot: vi.fn(() => () => undefined),
        onHandoffProgress: vi.fn(() => () => undefined),
      }
      return new NativeRendererApi(bridge).loadWorkbench()
    }

    const malformed = {
      ...recoverySnapshot(catalog.threads[0], 'Only the materialized answer is safe.'),
      inProgressStream: {
        blockId: 'malformed-stream',
        text: 'This must not render.',
        startedAt: 'not-an-iso-date',
      },
    }
    expect((await loadCached(malformed)).threads[0]?.transcript.map((block) => block.id))
      .toEqual(['block-thread-one'])

    const colliding = {
      ...recoverySnapshot(catalog.threads[0], 'The materialized block wins the collision.'),
      inProgressStream: {
        blockId: 'block-thread-one',
        text: 'A conflicting transient duplicate must not render.',
        startedAt: '2026-08-05T20:00:02.000Z',
      },
    }
    const collisionProjection = await loadCached(colliding)
    expect(collisionProjection.threads[0]?.transcript).toHaveLength(1)
    expect(collisionProjection.threads[0]?.transcript[0]).toMatchObject({
      id: 'block-thread-one',
      body: 'The materialized block wins the collision.',
    })
    expect(collisionProjection.threads[0]?.transcript[0]?.streaming).toBeUndefined()

    const advancedCatalog = structuredClone(catalog)
    advancedCatalog.threads[0].currentLocation.executionGenerationId = 'generation-advanced'
    const staleGeneration = {
      ...recoverySnapshot(catalog.threads[0], 'Retired generation materialization.'),
      inProgressStream: {
        blockId: 'retired-generation-stream',
        text: 'A different execution generation must never project.',
        startedAt: '2026-08-05T20:00:02.000Z',
      },
    }
    expect((await loadCached(staleGeneration, advancedCatalog)).threads[0]?.transcript).toEqual([])
  })

  it('keeps non-empty retained work reports when live session telemetry is absent', async () => {
    const catalog = recoveryCatalog()
    const snapshot = {
      ...recoverySnapshot(catalog.threads[0], 'Persisted work remains available.'),
      runtime: undefined,
      childAgents: [{
        agentId: 'persisted-agent',
        activeSessionId: 'active-persisted-agent',
        sessionName: 'Persisted helper session',
        title: 'Persisted helper',
        state: 'complete',
        answerPreview: 'Returned a bounded result.',
        repliedSinceTask: true,
      }],
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 1, catalog, lastSnapshot: snapshot },
        outbox: [],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)

    const projected = await api.loadWorkbench()

    expect(projected.runtime.session).toBeUndefined()
    expect(projected.runtime.agentsReported).toBe(true)
    expect(projected.agents).toEqual([expect.objectContaining({
      name: 'Persisted helper',
      status: 'complete',
      activeSessionId: 'active-persisted-agent',
      sessionName: 'Persisted helper session',
      answerPreview: 'Returned a bounded result.',
      repliedSinceTask: true,
    })])
    expect(projected.runtime.goals).toEqual([
      expect.objectContaining({ objective: 'Finish First durable thread', state: 'active' }),
    ])
    expect(projected.runtime.schedules).toEqual([
      expect.objectContaining({ label: 'Review verification', state: 'active' }),
    ])
  })

  it('projects only the validated path-free resource inventory for the exact session', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Resource inventory projection.')
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 1, catalog, lastSnapshot: snapshot },
        outbox: [],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }

    const projected = await new NativeRendererApi(bridge).loadWorkbench()

    expect(projected.runtime.session?.resourceInventory).toEqual(snapshot.runtime.resourceInventory)
    expect(JSON.stringify(projected.runtime.session?.resourceInventory)).not.toMatch(/\/Users\/|credential|artifact/i)
    expect(projected.runtime.browserExecution).toEqual(snapshot.residentControl.browserExecution)
    expect(JSON.stringify(projected.runtime.browserExecution)).not.toMatch(/\/Users\/|path|credential|artifact/i)
  })

  it('unwraps structured bridge failures instead of treating them as projection data', async () => {
    const api = new NativeRendererApi({
      bootstrap: () =>
        Promise.resolve({
          ok: false as const,
          error: {
            code: 'cache.read_failed',
            message: 'Unable to read the projection cache.',
            retryable: true,
            receiptId: 'receipt-123',
          },
        }),
    })

    await expect(api.loadWorkbench()).rejects.toThrow(/Unable to read the projection cache.*receipt receipt-123/)
  })

  it('accepts only path-free workspace receipts and fences a picker result when authority changes', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Resident picker authority.')
    const selectionResult = deferred<unknown>()
    let connectionListener: ((state: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        durableUncertainReceipts: [],
        residentLifecycleOperations: [],
        connection: residentLifecycleConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      selectResidentWorkspace: vi.fn(() => selectionResult.promise),
      provisionResident: vi.fn(),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const unsubscribe = api.subscribe(() => undefined)
    await api.loadWorkbench()

    const leakedReceipt = api.selectResidentWorkspace()
    selectionResult.resolve(ok({
      ...residentSelection(),
      workspaceDirectory: 'C:\\Users\\operator\\secret-workspace',
    }))
    await expect(leakedReceipt).rejects.toThrow(/invalid path-free selection receipt/i)

    const fencedSelection = deferred<unknown>()
    bridge.selectResidentWorkspace.mockImplementationOnce(() => fencedSelection.promise)
    const pending = api.selectResidentWorkspace()
    connectionListener?.({
      phase: 'connecting',
      target: { kind: 'ssh', alias: 'replacement-host' },
      since: '2026-08-05T20:00:02.000Z',
      attempt: 2,
    })
    fencedSelection.resolve(ok(residentSelection()))

    await expect(pending).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
    expect(bridge.provisionResident).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('rehydrates an ambiguous resident provision as outcome unknown without replaying the mutation', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Resident provision recovery.')
    let bootstrapReads = 0
    const provisionResident = vi.fn(() => Promise.resolve({
      ok: false as const,
      error: {
        code: 'RESIDENT_PROVISION_OUTCOME_UNKNOWN',
        message: 'The durable outcome must be checked.',
        retryable: false,
      },
    }))
    const bridge = {
      bootstrap: vi.fn(() => {
        bootstrapReads += 1
        return ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
          outbox: [],
          quarantinedOutboxCount: 0,
          durableUncertainReceipts: [],
          residentLifecycleOperations: bootstrapReads === 1 ? [] : [residentLifecycleOperation('outcome_unknown')],
          connection: residentLifecycleConnection(),
          appVersion: '0.1.0',
        })
      }),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      selectResidentWorkspace: vi.fn(() => ok(residentSelection())),
      provisionResident,
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((next) => published.push(next))
    await api.loadWorkbench()
    const selection = await api.selectResidentWorkspace()

    const request = {
      selectionToken: selection.selectionToken,
      projectDisplayName: 'Prime GUI',
      threadTitle: 'Prime GUI thread',
    }
    await expect(api.provisionResident(request)).rejects.toMatchObject({
      durableOperationPossible: true,
    })
    await vi.waitFor(() => {
      expect(published.at(-1)?.residentLifecycleOperations).toEqual([
        expect.objectContaining({
          operationId: 'resident-operation-one',
          expectedHostId: 'host-local',
          state: 'outcome_unknown',
        }),
      ])
    })
    expect(provisionResident).toHaveBeenCalledTimes(1)

    await expect(api.provisionResident(request)).rejects.toThrow(/choose the workspace folder again/i)
    expect(provisionResident).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('mints a fresh local operation after an exact completed pre-effect setup', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Completed local resident retry.')
    const operation = {
      ...residentLifecycleOperation('terminal'),
      kind: 'provision' as const,
      lastStatus: {
        ...committedResidentLifecycleStatus(),
        phase: 'completed' as const,
        completionReason: 'owned_create_cleaned' as const,
      },
    }
    const freshOperationId = 'resident-operation-safe-retry'
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        durableUncertainReceipts: [],
        residentLifecycleOperations: [operation],
        connection: residentLifecycleConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn(() => ok(snapshot)),
      selectResidentWorkspace: vi.fn(() => ok({ ...residentSelection(), operationId: freshOperationId })),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()

    await expect(api.selectResidentWorkspace({
      resumeOperationId: operation.operationId,
    })).resolves.toMatchObject({ operationId: freshOperationId, kind: 'local_path' })
    expect(freshOperationId).not.toBe(operation.operationId)
  })

  it('honors only an explicit native pre-record durability result after invoking main', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Definitive resident rejection.')
    const provisionResident = vi.fn(() => Promise.resolve({
      ok: false as const,
      error: {
        code: 'resident.provision_label_invalid',
        message: 'The project display name is invalid.',
        retryable: false,
        details: { durableOperationPossible: false },
      },
    }))
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        durableUncertainReceipts: [],
        residentLifecycleOperations: [],
        connection: residentLifecycleConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      selectResidentWorkspace: vi.fn(() => ok(residentSelection())),
      provisionResident,
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()
    const selection = await api.selectResidentWorkspace()

    await expect(api.provisionResident({
      selectionToken: selection.selectionToken,
      projectDisplayName: 'Prime GUI',
      threadTitle: 'Prime GUI thread',
    })).rejects.toMatchObject({
      code: 'resident.provision_label_invalid',
      durableOperationPossible: false,
      retryable: false,
    })
    expect(provisionResident).toHaveBeenCalledOnce()
  })

  it('rejects a completed provision when authority changes during ledger rehydration', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Resident authority refresh fence.')
    const rehydration = deferred<unknown>()
    let bootstrapReads = 0
    let connectionListener: ((state: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => {
        bootstrapReads += 1
        return bootstrapReads === 1
          ? ok({
              cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
              outbox: [],
              quarantinedOutboxCount: 0,
              durableUncertainReceipts: [],
              residentLifecycleOperations: [],
              connection: residentLifecycleConnection(),
              appVersion: '0.1.0',
            })
          : rehydration.promise
      }),
      hostCatalog: vi.fn(() => Promise.reject(new Error('No post-authority refresh expected.'))),
      requestSnapshot: vi.fn(() => Promise.reject(new Error('No post-authority refresh expected.'))),
      selectResidentWorkspace: vi.fn(() => ok(residentSelection())),
      provisionResident: vi.fn(() => ok(committedResidentLifecycleStatus())),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const unsubscribe = api.subscribe(() => undefined)
    await api.loadWorkbench()
    const selection = await api.selectResidentWorkspace()
    bridge.hostCatalog.mockClear()
    bridge.requestSnapshot.mockClear()

    const pending = api.provisionResident({
      selectionToken: selection.selectionToken,
      projectDisplayName: 'Prime GUI',
      threadTitle: 'Prime GUI thread',
    })
    await vi.waitFor(() => expect(bridge.bootstrap).toHaveBeenCalledTimes(2))
    connectionListener?.({
      phase: 'connecting',
      target: { kind: 'ssh', alias: 'replacement-host' },
      since: '2026-08-05T20:00:03.000Z',
      attempt: 2,
    })
    rehydration.resolve(ok({
      cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
      outbox: [],
      quarantinedOutboxCount: 0,
      durableUncertainReceipts: [],
      residentLifecycleOperations: [{
        ...residentLifecycleOperation('submitted'),
        state: 'terminal',
        lastStatus: committedResidentLifecycleStatus(),
      }],
      connection: residentLifecycleConnection(),
      appVersion: '0.1.0',
    }))

    await expect(pending).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
    expect(bridge.hostCatalog).not.toHaveBeenCalled()
    expect(bridge.requestSnapshot).not.toHaveBeenCalled()
    expect(bridge.provisionResident).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('drains a refresh started before commit and then forces a fresh exact resident observation', async () => {
    const catalog = recoveryCatalog()
    const oldSnapshot = recoverySnapshot(catalog.threads[0], 'Pre-commit selected thread.')
    const committedCatalog = catalogWithCommittedResidentThread()
    const committedSnapshot = committedResidentSnapshot()
    const staleCatalog = deferred<unknown>()
    let bootstrapReads = 0
    let catalogReads = 0
    const bridge = {
      bootstrap: vi.fn(() => {
        bootstrapReads += 1
        return ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: oldSnapshot },
          outbox: [],
          quarantinedOutboxCount: 0,
          durableUncertainReceipts: [],
          residentLifecycleOperations: bootstrapReads === 1
            ? []
            : [{
                ...residentLifecycleOperation('submitted'),
                state: 'terminal',
                lastStatus: committedResidentLifecycleStatus(),
              }],
          connection: residentLifecycleConnection(),
          appVersion: '0.1.0',
        })
      }),
      hostCatalog: vi.fn(() => {
        catalogReads += 1
        return catalogReads === 1 ? staleCatalog.promise : ok(committedCatalog)
      }),
      requestSnapshot: vi.fn((input: unknown) =>
        ok((input as { threadId?: string }).threadId === 'resident-thread-one'
          ? committedSnapshot
          : oldSnapshot),
      ),
      selectResidentWorkspace: vi.fn(() => ok(residentSelection())),
      provisionResident: vi.fn(() => ok(committedResidentLifecycleStatus())),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()
    await vi.waitFor(() => expect(bridge.hostCatalog).toHaveBeenCalledTimes(1))
    const selection = await api.selectResidentWorkspace()
    const provision = api.provisionResident({
      selectionToken: selection.selectionToken,
      projectDisplayName: 'Prime GUI',
      threadTitle: 'Prime GUI thread',
    })
    await vi.waitFor(() => expect(bridge.bootstrap).toHaveBeenCalledTimes(2))
    expect(bridge.hostCatalog).toHaveBeenCalledTimes(1)

    staleCatalog.resolve(ok(catalog))
    await expect(provision).resolves.toEqual(committedResidentLifecycleStatus())
    expect(bridge.hostCatalog).toHaveBeenCalledTimes(2)
    expect(bridge.requestSnapshot.mock.calls.map(([input]) => input)).toEqual([
      { threadId: 'thread-one' },
      { threadId: 'resident-thread-one' },
    ])
    const view = published.at(-1)!
    expect(view.selectedThreadId).toBe('resident-thread-one')
    expect(view.threads.find((thread) => thread.id === 'resident-thread-one')?.transcript[0]?.body)
      .toBe('Authoritative committed resident thread.')
    unsubscribe()
  })

  it('selects the exact committed resident thread instead of the previously selected thread', async () => {
    const catalog = recoveryCatalog()
    const oldSnapshot = recoverySnapshot(catalog.threads[0], 'Existing selected thread.')
    const committedCatalog = catalogWithCommittedResidentThread()
    const committedSnapshot = committedResidentSnapshot('New committed resident thread.')
    let bootstrapReads = 0
    let liveCatalog: unknown = catalog
    const bridge = {
      bootstrap: vi.fn(() => {
        bootstrapReads += 1
        return ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: oldSnapshot },
          outbox: [],
          quarantinedOutboxCount: 0,
          durableUncertainReceipts: [],
          residentLifecycleOperations: bootstrapReads === 1
            ? []
            : [{
                ...residentLifecycleOperation('submitted'),
                state: 'terminal',
                lastStatus: committedResidentLifecycleStatus(),
              }],
          connection: residentLifecycleConnection(),
          appVersion: '0.1.0',
        })
      }),
      hostCatalog: vi.fn(() => ok(liveCatalog)),
      requestSnapshot: vi.fn((input: unknown) =>
        ok((input as { threadId?: string }).threadId === 'resident-thread-one'
          ? committedSnapshot
          : oldSnapshot),
      ),
      residentLifecycleStatus: vi.fn(() => ok({ status: committedResidentLifecycleStatus() })),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    const initial = await api.loadWorkbench()
    await vi.waitFor(() => expect(bridge.requestSnapshot).toHaveBeenCalledTimes(1))
    expect(initial.selectedThreadId).toBe('thread-one')
    bridge.hostCatalog.mockClear()
    bridge.requestSnapshot.mockClear()
    liveCatalog = committedCatalog

    await expect(api.residentLifecycleStatus({
      expectedHostId: 'host-local',
      operationId: 'resident-operation-one',
    })).resolves.toEqual(committedResidentLifecycleStatus())
    expect(bridge.hostCatalog).toHaveBeenCalledTimes(1)
    expect(bridge.requestSnapshot).toHaveBeenCalledWith({ threadId: 'resident-thread-one' })
    const view = published.at(-1)!
    expect(view.selectedThreadId).toBe('resident-thread-one')
    expect(view.threads.find((thread) => thread.id === view.selectedThreadId)).toMatchObject({
      hostId: 'host-local',
      executionGenerationId: 'resident-generation-one',
    })
    unsubscribe()
  })

  it('fences committed resident selection when authority changes during the exact snapshot request', async () => {
    const catalog = recoveryCatalog()
    const oldSnapshot = recoverySnapshot(catalog.threads[0], 'Original authority thread.')
    const committedCatalog = catalogWithCommittedResidentThread()
    const committedSnapshot = committedResidentSnapshot()
    const exactSnapshot = deferred<unknown>()
    let bootstrapReads = 0
    let postLoad = false
    let connectionListener: ((state: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => {
        bootstrapReads += 1
        return ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: oldSnapshot },
          outbox: [],
          quarantinedOutboxCount: 0,
          durableUncertainReceipts: [],
          residentLifecycleOperations: bootstrapReads === 1
            ? []
            : [{
                ...residentLifecycleOperation('submitted'),
                state: 'terminal',
                lastStatus: committedResidentLifecycleStatus(),
              }],
          connection: residentLifecycleConnection(),
          appVersion: '0.1.0',
        })
      }),
      hostCatalog: vi.fn(() => ok(postLoad ? committedCatalog : catalog)),
      requestSnapshot: vi.fn((input: unknown) =>
        (input as { threadId?: string }).threadId === 'resident-thread-one'
          ? exactSnapshot.promise
          : ok(oldSnapshot),
      ),
      selectResidentWorkspace: vi.fn(() => ok(residentSelection())),
      provisionResident: vi.fn(() => ok(committedResidentLifecycleStatus())),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()
    await vi.waitFor(() => expect(bridge.requestSnapshot).toHaveBeenCalledTimes(1))
    postLoad = true
    const selection = await api.selectResidentWorkspace()
    const provision = api.provisionResident({
      selectionToken: selection.selectionToken,
      projectDisplayName: 'Prime GUI',
      threadTitle: 'Prime GUI thread',
    })
    await vi.waitFor(() => {
      expect(bridge.requestSnapshot).toHaveBeenCalledWith({ threadId: 'resident-thread-one' })
    })
    connectionListener?.({
      phase: 'connecting',
      target: { kind: 'ssh', alias: 'replacement-host' },
      since: '2026-08-05T20:00:05.000Z',
      attempt: 2,
    })
    exactSnapshot.resolve(ok(committedSnapshot))

    await expect(provision).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
    expect(published.at(-1)?.selectedThreadId).not.toBe('resident-thread-one')
    unsubscribe()
  })

  it('keeps a committed ledger actionable when the exact resident snapshot cannot materialize', async () => {
    const catalog = recoveryCatalog()
    const oldSnapshot = recoverySnapshot(catalog.threads[0], 'Still selected old thread.')
    const committedCatalog = catalogWithCommittedResidentThread()
    let bootstrapReads = 0
    let liveCatalog: unknown = catalog
    const bridge = {
      bootstrap: vi.fn(() => {
        bootstrapReads += 1
        return ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: oldSnapshot },
          outbox: [],
          quarantinedOutboxCount: 0,
          durableUncertainReceipts: [],
          residentLifecycleOperations: bootstrapReads === 1
            ? []
            : [{
                ...residentLifecycleOperation('submitted'),
                state: 'terminal',
                lastStatus: committedResidentLifecycleStatus(),
              }],
          connection: residentLifecycleConnection(),
          appVersion: '0.1.0',
        })
      }),
      hostCatalog: vi.fn(() => ok(liveCatalog)),
      requestSnapshot: vi.fn(() => ok(oldSnapshot)),
      residentLifecycleStatus: vi.fn(() => ok({ status: committedResidentLifecycleStatus() })),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()
    await vi.waitFor(() => expect(bridge.requestSnapshot).toHaveBeenCalledTimes(1))
    bridge.requestSnapshot.mockClear()
    liveCatalog = committedCatalog

    await expect(api.residentLifecycleStatus({
      expectedHostId: 'host-local',
      operationId: 'resident-operation-one',
    })).rejects.toThrow(/does not prove this exact resident lifecycle operation/i)
    expect(bridge.requestSnapshot).toHaveBeenCalledWith({ threadId: 'resident-thread-one' })
    expect(published.at(-1)?.selectedThreadId).toBe('thread-one')
    expect(published.at(-1)?.residentLifecycleOperations).toEqual([
      expect.objectContaining({
        operationId: 'resident-operation-one',
        state: 'terminal_refresh_pending',
        lastStatus: committedResidentLifecycleStatus(),
      }),
    ])
    unsubscribe()
  })

  it('refreshes the catalog and selected snapshot once after an offline-to-online transition', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Authoritative first thread.')
    let connectionListener: ((state: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() =>
        ok({
          cache: { version: 1, catalog, lastSnapshot: snapshot },
          outbox: [],
          connection: onlineConnection(),
          appVersion: '0.1.0',
        }),
      ),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn(() => ok(snapshot)),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const unsubscribe = api.subscribe(() => undefined)
    await api.loadWorkbench()
    await vi.waitFor(() => expect(bridge.requestSnapshot).toHaveBeenCalledTimes(1))

    connectionListener?.({ ...onlineConnection(), phase: 'offline' })
    connectionListener?.({ ...onlineConnection(), phase: 'reconnecting' })
    connectionListener?.(onlineConnection())
    await vi.waitFor(() => {
      expect(bridge.hostCatalog).toHaveBeenCalledTimes(2)
      expect(bridge.requestSnapshot).toHaveBeenCalledTimes(2)
    })

    connectionListener?.(onlineConnection())
    await Promise.resolve()
    await Promise.resolve()
    expect(bridge.hostCatalog).toHaveBeenCalledTimes(2)
    expect(bridge.requestSnapshot).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('requests and publishes the authoritative snapshot for a native thread selection', async () => {
    const catalog = recoveryCatalog()
    const firstSnapshot = recoverySnapshot(catalog.threads[0], 'Authoritative first thread.')
    const secondSnapshot = recoverySnapshot(catalog.threads[1], 'Authoritative second thread.')
    const bridge = {
      bootstrap: vi.fn(() =>
        ok({
          cache: { version: 1, catalog, lastSnapshot: firstSnapshot },
          outbox: [],
          connection: onlineConnection(),
          appVersion: '0.1.0',
        }),
      ),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn((input: { threadId: string }) =>
        ok(input.threadId === 'thread-two' ? secondSnapshot : firstSnapshot),
      ),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()
    await vi.waitFor(() => expect(bridge.requestSnapshot).toHaveBeenCalledWith({ threadId: 'thread-one' }))

    await api.selectThread('thread-two')

    expect(bridge.requestSnapshot).toHaveBeenLastCalledWith({ threadId: 'thread-two' })
    expect(published.at(-1)?.selectedThreadId).toBe('thread-two')
    expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-two')?.transcript[0]?.body).toBe(
      'Authoritative second thread.',
    )
    unsubscribe()
  })

  it('never relabels stale materialization during a failed thread switch and restores the prior thread', async () => {
    const catalog = recoveryCatalog()
    const firstSnapshot = {
      ...recoverySnapshot(catalog.threads[0], 'Authoritative first thread.'),
      childAgents: [{ agentId: 'agent-a', title: 'Agent A', state: 'running' }],
      evidence: { testsPassed: 2, testsFailed: 0, artifactCount: 1 },
      pendingAttention: [
        {
          attentionId: 'question-a',
          kind: 'question',
          title: 'Answer the host question',
          createdAt: '2026-08-05T20:00:02.000Z',
          read: false,
        },
        {
          attentionId: 'offline-a',
          kind: 'host_offline',
          title: 'Host A went offline',
          createdAt: '2026-08-05T20:00:03.000Z',
          read: false,
        },
        {
          attentionId: 'complete-a',
          kind: 'complete',
          title: 'Normal completion is not an error',
          createdAt: '2026-08-05T20:00:04.000Z',
          read: false,
        },
        {
          attentionId: 'read-failure-a',
          kind: 'failed',
          title: 'Already read failure',
          createdAt: '2026-08-05T20:00:05.000Z',
          read: true,
        },
      ],
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 1, catalog, lastSnapshot: firstSnapshot },
        outbox: [],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn((input: { threadId: string }) =>
        input.threadId === 'thread-two'
          ? Promise.resolve({
              ok: false as const,
              error: { code: 'snapshot.unavailable', message: 'Host B snapshot is unavailable.', retryable: true },
            })
          : ok(firstSnapshot),
      ),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()
    await vi.waitFor(() => expect(bridge.requestSnapshot).toHaveBeenCalledWith({ threadId: 'thread-one' }))
    published.length = 0

    await expect(api.selectThread('thread-two')).rejects.toThrow('Host B snapshot is unavailable.')

    const inFlight = published.find((snapshot) => snapshot.selectedThreadId === 'thread-two')
    expect(inFlight?.threads.find((thread) => thread.id === 'thread-two')?.transcript).toEqual([])
    expect(inFlight?.evidence).toEqual([])
    expect(inFlight?.agents).toEqual([])
    expect(inFlight?.attention).toEqual([])
    expect(inFlight?.runtime).toEqual({})

    const restored = published.at(-1)
    expect(restored?.selectedThreadId).toBe('thread-one')
    expect(restored?.threads.find((thread) => thread.id === 'thread-one')?.transcript[0]?.body).toBe(
      'Authoritative first thread.',
    )
    expect(restored?.evidence).toHaveLength(2)
    expect(restored?.agents).toHaveLength(1)
    expect(restored?.runtime.session).toMatchObject({
      residency: 'resident',
      activeSessionId: 'active-thread-one',
      sessionId: 'session-thread-one',
      model: 'prime-rlm',
      queuedActionCount: 2,
    })
    expect(restored?.runtime.queue).toEqual({ pendingCount: 1, paused: false })
    expect(restored?.runtime.goals).toEqual([
      expect.objectContaining({ objective: 'Finish First durable thread', state: 'active', tokensUsed: 12_000 }),
    ])
    expect(restored?.runtime.schedules).toEqual([
      expect.objectContaining({ label: 'Review verification', state: 'active', source: 'heartbeat' }),
    ])
    expect(restored?.attention.map((item) => [item.title, item.kind])).toEqual([
      ['Answer the host question', 'question'],
      ['Host A went offline', 'failed'],
    ])
    unsubscribe()
  })

  it('hydrates restart outbox identities, applies their receipts, and scopes pending state to its thread', async () => {
    const catalog = recoveryCatalog()
    const firstSnapshot = recoverySnapshot(catalog.threads[0], 'Authoritative first thread.')
    const secondSnapshot = recoverySnapshot(catalog.threads[1], 'Authoritative second thread.')
    let hostEventListener: ((event: unknown) => void) | undefined
    let deviceId = ''
    const bridge = {
      bootstrap: vi.fn(() =>
        ok({
          cache: { version: 1, catalog, lastSnapshot: firstSnapshot },
          outbox: [
            {
              hostId: 'host-local',
              command: {
                deviceId,
                commandId: 'command-one',
                expectedHostId: 'host-local',
                threadId: 'thread-one',
                kind: 'thread.cancel',
                delivery: 'live_only',
                expectedExecutionGenerationId: 'generation-one',
                issuedAt: '2026-08-05T20:00:00.000Z',
              },
              state: 'waiting_for_connection',
              updatedAt: '2026-08-05T20:00:00.000Z',
            },
            {
              hostId: 'host-local',
              command: {
                deviceId,
                commandId: 'command-two',
                expectedHostId: 'host-local',
                threadId: 'thread-two',
                kind: 'thread.prompt',
                payload: { text: 'Continue two' },
                delivery: 'live_only',
                expectedExecutionGenerationId: 'generation-two',
                issuedAt: '2026-08-05T20:00:00.000Z',
              },
              state: 'waiting_for_connection',
              updatedAt: '2026-08-05T20:00:00.000Z',
            },
          ],
          connection: onlineConnection(),
          appVersion: '0.1.0',
        }),
      ),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn((input: { threadId: string }) =>
        ok(input.threadId === 'thread-two' ? secondSnapshot : firstSnapshot),
      ),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn((listener: (event: unknown) => void) => {
        hostEventListener = listener
        return () => undefined
      }),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    deviceId = (api as unknown as { deviceId: string }).deviceId
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    const cached = await api.loadWorkbench()
    expect(cached.composerReceipt.state).toBe('waiting_for_connection')
    await vi.waitFor(() => expect(bridge.requestSnapshot).toHaveBeenCalled())

    hostEventListener?.({
      type: 'command.receipt',
      payload: {
        hostId: 'host-local',
        deviceId,
        commandId: 'command-one',
        threadId: 'thread-one',
        executionGenerationId: 'generation-one',
        status: 'admitted',
        durable: true,
      },
    })
    expect(published.at(-1)?.composerReceipt.state).toBe('sent')

    await api.selectThread('thread-two')
    hostEventListener?.({
      type: 'command.receipt',
      payload: {
        hostId: 'host-local',
        deviceId,
        commandId: 'command-two',
        threadId: 'thread-two',
        executionGenerationId: 'generation-two',
        status: 'uncertain',
        durable: false,
      },
    })
    expect(published.at(-1)?.composerReceipt.state).toBe('uncertain')

    await api.selectThread('thread-one')
    expect(published.at(-1)?.composerReceipt.state).toBe('sent')
    unsubscribe()
  })

  it.each([
    ['prompt-first', 'awaiting_abort_idle_proof'],
    ['abort-first', 'awaiting_abort_idle_proof'],
    ['prompt-first', 'uncertain'],
    ['abort-first', 'uncertain'],
  ] as const)(
    'derives restart ownership from every exact outbox entry and chooses newer abort state %s/%s',
    async (order, abortState) => {
      const catalog = recoveryCatalog()
      catalog.threads[0].status = 'idle'
      const snapshot = recoverySnapshot(catalog.threads[0], 'Retained resident control.')
      let deviceId = ''
      const promptEntry = {
        hostId: 'host-local',
        command: {
          deviceId,
          commandId: 'retained-prompt',
          expectedHostId: 'host-local',
          threadId: 'thread-one',
          kind: 'thread.prompt',
          payload: { text: 'Retained prompt' },
          delivery: 'live_only',
          expectedExecutionGenerationId: 'generation-one',
          issuedAt: '2026-08-05T20:00:00.000Z',
        },
        state: 'awaiting_idle_proof',
        updatedAt: '2026-08-05T20:00:00.000Z',
      }
      const abortEntry = {
        hostId: 'host-local',
        command: {
          deviceId,
          commandId: 'retained-abort',
          expectedHostId: 'host-local',
          threadId: 'thread-one',
          kind: 'thread.cancel',
          delivery: 'live_only',
          expectedExecutionGenerationId: 'generation-one',
          issuedAt: '2026-08-05T20:00:01.000Z',
        },
        state: abortState,
        updatedAt: '2026-08-05T20:00:01.000Z',
      }
      const bridge = {
        bootstrap: vi.fn(() => ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
          outbox: (order === 'prompt-first' ? [promptEntry, abortEntry] : [abortEntry, promptEntry])
            .map((entry) => ({ ...entry, command: { ...entry.command, deviceId } })),
          connection: onlineConnection(),
          appVersion: '0.1.0',
        })),
        hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
        requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
        onConnectionState: vi.fn(() => () => undefined),
        onSnapshot: vi.fn(() => () => undefined),
        onHostEvent: vi.fn(() => () => undefined),
        onHandoffProgress: vi.fn(() => () => undefined),
      }
      const api = new NativeRendererApi(bridge)
      deviceId = (api as unknown as { deviceId: string }).deviceId

      const view = await api.loadWorkbench()

      expect(view.composerReceipt).toMatchObject({
        state: abortState === 'uncertain' ? 'uncertain' : 'sent',
        operation: 'abort',
      })
      expect(view.composerReceipt.message).toContain(
        abortState === 'uncertain' ? 'Outcome unknown' : 'Stop accepted',
      )
      expect(view.operations).toMatchObject({ startResidentTurn: false, stopResidentTurn: false })
      if (abortState === 'uncertain') {
        expect(view.attention).toContainEqual(expect.objectContaining({
          title: expect.stringContaining('recovery required'),
        }))
      }
    },
  )

  it('ignores an A bootstrap payload when a newer B connection event wins the race', async () => {
    const catalogA = recoveryCatalog()
    const snapshotA = recoverySnapshot(catalogA.threads[0], 'Cached on Host A.')
    const bootstrapResult = deferred<unknown>()
    let connectionListener: ((state: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => bootstrapResult.promise),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const unsubscribe = api.subscribe(() => undefined)

    const loading = api.loadWorkbench()
    connectionListener?.({ ...onlineConnection(), hostId: 'host-b' })
    bootstrapResult.resolve({
      ok: true,
      value: {
        cache: { version: 2, projectionHostId: 'host-local', catalog: catalogA, lastSnapshot: snapshotA },
        outbox: [],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      },
    })

    const loaded = await loading
    expect(loaded.threads).toEqual([])
    expect(loaded.hosts).toEqual([])
    unsubscribe()
  })

  it('rehydrates the exact durable outbox before restoring mutations when authority switches A to B to A', async () => {
    const catalogA = singleHostCatalog('host-a', 'Host A', 'thread-a', 'project-a')
    const catalogB = singleHostCatalog('host-b', 'Host B', 'thread-b', 'project-b')
    const snapshotA = recoverySnapshot(catalogA.threads[0], 'Owned on A.')
    const snapshotB = recoverySnapshot(catalogB.threads[0], 'Idle on B.')
    let connectionListener: ((state: unknown) => void) | undefined
    let deviceId = ''
    let currentHost: 'host-a' | 'host-b' = 'host-a'
    const connectionFor = (hostId: 'host-a' | 'host-b') => ({
      ...onlineConnection(),
      hostId,
      target: { kind: 'local' },
    })
    const promptA = {
      deviceId,
      commandId: 'owned-a-prompt',
      expectedHostId: 'host-a',
      threadId: 'thread-a',
      kind: 'thread.prompt',
      payload: { text: 'Owned A work' },
      delivery: 'live_only',
      expectedExecutionGenerationId: 'generation-host-a',
      issuedAt: '2026-08-05T20:00:00.000Z',
    }
    const bootstrap = vi.fn(() => ok({
      cache: {
        version: 3,
        activeHostId: currentHost,
        entries: {
          'host-a': { hostId: 'host-a', catalog: catalogA, lastSnapshot: snapshotA },
          'host-b': { hostId: 'host-b', catalog: catalogB, lastSnapshot: snapshotB },
        },
      },
      outbox: currentHost === 'host-a'
        ? [{
            hostId: 'host-a',
            command: { ...promptA, deviceId },
            state: 'awaiting_idle_proof',
            updatedAt: '2026-08-05T20:00:00.000Z',
          }]
        : [],
      connection: connectionFor(currentHost),
      appVersion: '0.1.0',
    }))
    const submitCommand = vi.fn()
    const bridge = {
      bootstrap,
      hostCatalog: vi.fn(() => ok(currentHost === 'host-a' ? catalogA : catalogB)),
      requestSnapshot: vi.fn(() => ok(currentHost === 'host-a' ? snapshotA : snapshotB)),
      submitCommand,
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    deviceId = (api as unknown as { deviceId: string }).deviceId
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    api.subscribe((next) => published.push(next))
    const initial = await api.loadWorkbench()
    expect(initial.composerReceipt).toMatchObject({ state: 'sent', operation: 'prompt' })
    expect(initial.operations).toMatchObject({ startResidentTurn: false, stopResidentTurn: true })

    currentHost = 'host-b'
    connectionListener?.(connectionFor('host-b'))
    expect(published.at(-1)?.operations).toMatchObject({ startResidentTurn: false, stopResidentTurn: false })
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2))

    currentHost = 'host-a'
    connectionListener?.(connectionFor('host-a'))
    expect(published.at(-1)?.operations).toMatchObject({ startResidentTurn: false, stopResidentTurn: false })
    await vi.waitFor(() => {
      expect(bootstrap).toHaveBeenCalledTimes(3)
      expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'sent', operation: 'prompt' })
      expect(published.at(-1)?.operations).toMatchObject({ startResidentTurn: false, stopResidentTurn: true })
    })
    await expect(api.sendComposer({ threadId: 'thread-a', text: 'Must not duplicate A.' }))
      .resolves.toMatchObject({ state: 'rejected' })
    expect(submitCommand).not.toHaveBeenCalled()
  })

  it('keeps a same-target A projection as read-only cache when native state verifies Host B', async () => {
    const catalogA = recoveryCatalog()
    const snapshotA = recoverySnapshot(catalogA.threads[0], 'Cached on Host A.')
    let connectionListener: ((state: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog: catalogA, lastSnapshot: snapshotA },
        outbox: [],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    const cached = await api.loadWorkbench()
    expect(cached.threads).toHaveLength(2)

    connectionListener?.({ ...onlineConnection(), phase: 'connecting', hostId: 'host-b' })

    expect(published.at(-1)?.threads.map((thread) => thread.id)).toEqual(['thread-one', 'thread-two'])
    expect(published.at(-1)?.threads.every((thread) => thread.transcript.length === 0)).toBe(true)
    expect(published.at(-1)?.hosts.map((host) => host.id)).toEqual(['host-local'])
    unsubscribe()
  })

  it('scopes composer requests to the visible host and suppresses an A receipt while B is still unverified', async () => {
    const catalogA = recoveryCatalog()
    catalogA.threads[0].status = 'idle'
    const snapshotA = recoverySnapshot(catalogA.threads[0], 'Cached on Host A.')
    const submission = deferred<unknown>()
    let connectionListener: ((state: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog: catalogA, lastSnapshot: snapshotA },
        outbox: [],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      submitCommand: vi.fn(() => submission.promise),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()

    const sending = api.sendComposer({
      threadId: 'thread-one',
      text: 'Continue on A',
    })
    expect(bridge.submitCommand).toHaveBeenCalledWith(expect.objectContaining({
      expectedHostId: 'host-local',
      threadId: 'thread-one',
    }))
    connectionListener?.({
      phase: 'connecting',
      target: { kind: 'ssh', alias: 'new-b' },
      since: '2026-08-05T20:00:02.000Z',
      attempt: 2,
    })
    submission.resolve({
      ok: true,
      value: { hostId: 'host-local', commandId: 'command-from-a', status: 'admitted', durable: true },
    })

    await expect(sending).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
    expect(published.at(-1)?.threads.map((thread) => thread.id)).toEqual(['thread-one', 'thread-two'])
    expect(published.at(-1)?.composerReceipt.state).not.toBe('uncertain')
    unsubscribe()
  })

  it('aggregates offline host caches while isolating live B updates and mutations from cached A', async () => {
    const catalogA = singleHostCatalog('host-a', 'Host A', 'thread-a', 'project-a')
    const catalogB = singleHostCatalog('host-b', 'Host B', 'thread-b', 'project-b')
    const snapshotA = recoverySnapshot(catalogA.threads[0], 'Cached transcript A.')
    const snapshotB = recoverySnapshot(catalogB.threads[0], 'Cached transcript B.')
    let snapshotListener: ((snapshot: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: {
          version: 3,
          activeHostId: 'host-b',
          entries: {
            'host-a': { hostId: 'host-a', catalog: catalogA, lastSnapshot: snapshotA, updatedAt: '2026-08-05T19:00:00.000Z' },
            'host-b': { hostId: 'host-b', catalog: catalogB, lastSnapshot: snapshotB, updatedAt: '2026-08-05T20:00:00.000Z' },
          },
        },
        outbox: [],
        connection: {
          phase: 'offline',
          target: { kind: 'ssh', alias: 'host-b' },
          hostId: 'host-b',
          path: 'ssh',
          since: '2026-08-05T20:00:00.000Z',
          attempt: 1,
          capabilities: ['prime_agent_commands_v2', 'thread_handoff_v1'],
        },
        appVersion: '0.1.0',
      })),
      connect: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      submitCommand: vi.fn(() => ok({ status: 'admitted', durable: true })),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn((listener: (snapshot: unknown) => void) => {
        snapshotListener = listener
        return () => undefined
      }),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))

    const cached = await api.loadWorkbench()
    expect(cached.hosts.map((host) => host.id)).toEqual(['host-b', 'host-a'])
    expect(cached.projects.map((project) => project.id).sort()).toEqual(['project-a', 'project-b'])
    expect(cached.threads.map((thread) => thread.id).sort()).toEqual(['thread-a', 'thread-b'])
    expect(cached.selectedThreadId).toBe('thread-b')
    expect(cached.operations).toEqual({
      submitCommands: false,
      startResidentTurn: false,
      stopResidentTurn: false,
      crossHostHandoff: false,
    })
    expect(cached.threads.find((thread) => thread.id === 'thread-b')?.transcript[0]?.body).toBe('Cached transcript B.')

    snapshotListener?.({ ...catalogA, host: { ...catalogA.host, displayName: 'Stale A overwrite' } })
    expect(cached.hosts.find((host) => host.id === 'host-a')?.name).toBe('Host A')

    const refreshedB = { ...catalogB, host: { ...catalogB.host, displayName: 'Host B refreshed' } }
    snapshotListener?.(refreshedB)
    expect(published.at(-1)?.hosts.find((host) => host.id === 'host-b')?.name).toBe('Host B refreshed')
    expect(published.at(-1)?.hosts.find((host) => host.id === 'host-a')?.name).toBe('Host A')

    await api.selectThread('thread-a')
    expect(published.at(-1)?.operations).toEqual({
      submitCommands: false,
      startResidentTurn: false,
      stopResidentTurn: false,
      crossHostHandoff: false,
    })
    expect(bridge.requestSnapshot).not.toHaveBeenCalled()
    await expect(api.sendComposer({
      threadId: 'thread-a',
      text: 'Must not cross to B',
    })).resolves.toMatchObject({ state: 'rejected' })
    expect(bridge.submitCommand).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('explicitly activates only the selected cached SSH host and preserves its exact thread generation', async () => {
    const cachedCatalog = sshActivationCatalog('generation-stable', '2026-08-05T20:00:00.000Z')
    const authoritativeCatalog = sshActivationCatalog('generation-stable', '2026-08-05T20:01:00.000Z')
    const cachedSnapshot = recoverySnapshot(cachedCatalog.threads[0], 'Cached first thread.')
    const authoritativeSnapshot = recoverySnapshot(authoritativeCatalog.threads[1], 'Fresh selected thread.')
    const authoritativeSnapshotReply = deferred<unknown>()
    const offlineConnection = {
      phase: 'offline',
      target: { kind: 'ssh', alias: 'private-config-name' },
      hostId: 'host-b',
      path: 'ssh',
      since: '2026-08-05T20:00:00.000Z',
      attempt: 1,
      capabilities: ['prime_agent_commands_v2'],
    }
    const onlineConnection = {
      ...offlineConnection,
      phase: 'online',
      since: '2026-08-05T20:01:00.000Z',
      attempt: 2,
    }
    const cache = {
      version: 3,
      activeHostId: 'host-b',
      entries: {
        'host-b': {
          hostId: 'host-b',
          catalog: cachedCatalog,
          lastSnapshot: cachedSnapshot,
          updatedAt: '2026-08-05T20:00:01.000Z',
        },
      },
    }
    const bridge = {
      bootstrap: vi.fn()
        .mockImplementationOnce(() => ok({ cache, outbox: [], connection: offlineConnection, appVersion: '0.1.0' }))
        .mockImplementationOnce(() => ok({ cache, outbox: [], connection: onlineConnection, appVersion: '0.1.0' })),
      connect: vi.fn(),
      activateVerifiedSshHost: vi.fn(() => ok(onlineConnection)),
      hostCatalog: vi.fn(() => ok(authoritativeCatalog)),
      requestSnapshot: vi.fn(() => authoritativeSnapshotReply.promise),
      submitCommand: vi.fn(() => ok({ status: 'admitted', durable: true })),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    const cached = await api.loadWorkbench()
    expect(cached.selectedThreadId).toBe('thread-one')
    await Promise.resolve()
    expect(bridge.connect).not.toHaveBeenCalled()

    await api.selectThread('thread-two')
    const activation = api.activateComputer('host-b')
    await vi.waitFor(() => expect(bridge.requestSnapshot).toHaveBeenCalledWith({ threadId: 'thread-two' }))
    expect(published.at(-1)?.operations.startResidentTurn).toBe(false)
    authoritativeSnapshotReply.resolve(ok(authoritativeSnapshot))
    const activated = await activation

    expect(bridge.activateVerifiedSshHost).toHaveBeenCalledWith({ expectedHostId: 'host-b' })
    expect(bridge.connect).not.toHaveBeenCalled()
    expect(bridge.submitCommand).not.toHaveBeenCalled()
    expect(activated.selectedThreadId).toBe('thread-two')
    expect(activated.threads.find((thread) => thread.id === 'thread-two')).toMatchObject({
      hostId: 'host-b',
      executionGenerationId: 'generation-stable-thread-two',
      transcript: [expect.objectContaining({ body: 'Fresh selected thread.' })],
    })
    expect(activated.operations.startResidentTurn).toBe(true)
    unsubscribe()
  })

  it('rejects a cached SSH activation identity mismatch before refresh and keeps cached mutations read-only', async () => {
    const cachedCatalog = sshActivationCatalog('generation-stable', '2026-08-05T20:00:00.000Z')
    const cachedSnapshot = recoverySnapshot(cachedCatalog.threads[0], 'Cached transcript remains.')
    const offlineConnection = {
      phase: 'offline',
      target: { kind: 'ssh', alias: 'private-config-name' },
      hostId: 'host-b',
      path: 'ssh',
      since: '2026-08-05T20:00:00.000Z',
      attempt: 1,
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: {
          version: 3,
          activeHostId: 'host-b',
          entries: {
            'host-b': { hostId: 'host-b', catalog: cachedCatalog, lastSnapshot: cachedSnapshot },
          },
        },
        outbox: [],
        connection: offlineConnection,
        appVersion: '0.1.0',
      })),
      connect: vi.fn(),
      activateVerifiedSshHost: vi.fn(() => ok({
        phase: 'online',
        target: { kind: 'ssh', alias: 'different-private-name' },
        hostId: 'host-c',
        path: 'ssh',
        since: '2026-08-05T20:01:00.000Z',
        attempt: 2,
      })),
      hostCatalog: vi.fn(),
      requestSnapshot: vi.fn(),
      submitCommand: vi.fn(),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    const cached = await api.loadWorkbench()

    await expect(api.activateComputer('host-b')).rejects.toBeInstanceOf(StaleHostAuthorityError)

    expect(bridge.activateVerifiedSshHost).toHaveBeenCalledWith({ expectedHostId: 'host-b' })
    expect(bridge.hostCatalog).not.toHaveBeenCalled()
    expect(bridge.requestSnapshot).not.toHaveBeenCalled()
    expect(bridge.submitCommand).not.toHaveBeenCalled()
    expect(published.at(-1) ?? cached).toMatchObject({
      selectedThreadId: 'thread-one',
      operations: { submitCommands: false, startResidentTurn: false },
    })
    expect((published.at(-1) ?? cached).threads[0]?.transcript[0]?.body).toBe('Cached transcript remains.')
    unsubscribe()
  })

  it('fails closed when the selected cached execution generation advanced before activation refresh', async () => {
    const cachedCatalog = sshActivationCatalog('generation-cached', '2026-08-05T20:00:00.000Z')
    const authoritativeCatalog = sshActivationCatalog('generation-advanced', '2026-08-05T20:01:00.000Z')
    const cachedSnapshot = recoverySnapshot(cachedCatalog.threads[1], 'Cached selected generation.')
    const advancedSnapshot = recoverySnapshot(authoritativeCatalog.threads[1], 'Advanced generation.')
    const offlineConnection = {
      phase: 'offline',
      target: { kind: 'ssh', alias: 'private-config-name' },
      hostId: 'host-b',
      path: 'ssh',
      since: '2026-08-05T20:00:00.000Z',
      attempt: 1,
      capabilities: ['prime_agent_commands_v2'],
    }
    const onlineConnection = { ...offlineConnection, phase: 'online', attempt: 2 }
    const cache = {
      version: 3,
      activeHostId: 'host-b',
      entries: {
        'host-b': { hostId: 'host-b', catalog: cachedCatalog, lastSnapshot: cachedSnapshot },
      },
    }
    const advancedCache = {
      version: 3,
      activeHostId: 'host-b',
      entries: {
        'host-b': {
          hostId: 'host-b',
          catalog: authoritativeCatalog,
          lastSnapshot: advancedSnapshot,
          updatedAt: '2026-08-05T20:01:01.000Z',
        },
      },
    }
    const bridge = {
      bootstrap: vi.fn()
        .mockImplementationOnce(() => ok({ cache, outbox: [], connection: offlineConnection, appVersion: '0.1.0' }))
        .mockImplementationOnce(() => ok({ cache, outbox: [], connection: onlineConnection, appVersion: '0.1.0' }))
        .mockImplementationOnce(() => ok({ cache: advancedCache, outbox: [], connection: onlineConnection, appVersion: '0.1.0' })),
      connect: vi.fn(),
      activateVerifiedSshHost: vi.fn(() => ok(onlineConnection)),
      hostCatalog: vi.fn(() => ok(authoritativeCatalog)),
      requestSnapshot: vi.fn(() => ok(advancedSnapshot)),
      submitCommand: vi.fn(),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()

    await expect(api.activateComputer('host-b')).rejects.toBeInstanceOf(StaleHostAuthorityError)

    expect(bridge.requestSnapshot).toHaveBeenCalledWith({ threadId: 'thread-two' })
    expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-two')?.executionGenerationId)
      .toBe('generation-advanced-thread-two')
    expect(published.at(-1)?.hosts.find((host) => host.id === 'host-b')?.activationRequired).toBe(true)
    expect(published.at(-1)?.operations).toMatchObject({ submitCommands: false, startResidentTurn: false })
    await expect(api.sendComposer({ threadId: 'thread-two', text: 'Do not replay this draft' }))
      .resolves.toMatchObject({ state: 'rejected' })
    expect(bridge.submitCommand).not.toHaveBeenCalled()

    const retried = await api.activateComputer('host-b')
    expect(bridge.activateVerifiedSshHost).toHaveBeenCalledTimes(2)
    expect(retried.hosts.find((host) => host.id === 'host-b')?.activationRequired).toBeUndefined()
    expect(retried.threads.find((thread) => thread.id === 'thread-two')?.executionGenerationId)
      .toBe('generation-advanced-thread-two')
    expect(retried.operations.startResidentTurn).toBe(true)
    unsubscribe()
  })

  it('lets a newer native connection observation supersede a delayed cached-host activation reply', async () => {
    const cachedCatalog = sshActivationCatalog('generation-stable', '2026-08-05T20:00:00.000Z')
    const cachedSnapshot = recoverySnapshot(cachedCatalog.threads[0], 'Cached transcript remains.')
    const activationReply = deferred<unknown>()
    let connectionListener: ((state: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: {
          version: 3,
          activeHostId: 'host-b',
          entries: {
            'host-b': { hostId: 'host-b', catalog: cachedCatalog, lastSnapshot: cachedSnapshot },
          },
        },
        outbox: [],
        connection: {
          phase: 'offline',
          target: { kind: 'ssh', alias: 'private-config-name' },
          hostId: 'host-b',
          path: 'ssh',
          since: '2026-08-05T20:00:00.000Z',
          attempt: 1,
        },
        appVersion: '0.1.0',
      })),
      connect: vi.fn(),
      activateVerifiedSshHost: vi.fn(() => activationReply.promise),
      hostCatalog: vi.fn(),
      requestSnapshot: vi.fn(),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const unsubscribe = api.subscribe(() => undefined)
    await api.loadWorkbench()
    const activating = api.activateComputer('host-b')
    await vi.waitFor(() => expect(bridge.activateVerifiedSshHost).toHaveBeenCalledOnce())
    connectionListener?.({
      phase: 'connecting',
      target: { kind: 'local' },
      since: '2026-08-05T20:01:00.000Z',
      attempt: 2,
    })
    activationReply.resolve(ok({
      phase: 'online',
      target: { kind: 'ssh', alias: 'private-config-name' },
      hostId: 'host-b',
      path: 'ssh',
      since: '2026-08-05T20:00:30.000Z',
      attempt: 2,
    }))

    await expect(activating).rejects.toBeInstanceOf(StaleHostAuthorityError)
    expect(bridge.hostCatalog).not.toHaveBeenCalled()
    expect(bridge.requestSnapshot).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('restores the unchanged prior online authority when activation fails before observing a replacement', async () => {
    const fixture = twoHostActivationCache()
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        connection: fixture.connectionA,
        appVersion: '0.1.0',
      })),
      activateVerifiedSshHost: vi.fn(() => Promise.resolve({
        ok: false as const,
        error: {
          code: 'ssh.verified_host_binding_required',
          message: 'This computer has no previously verified configured SSH binding. Add it again before connecting.',
        },
      })),
      hostCatalog: vi.fn(() => ok(fixture.catalogA)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshotA)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()
    await vi.waitFor(() => expect(bridge.requestSnapshot).toHaveBeenCalled())
    await api.selectThread('thread-b')

    await expect(api.activateComputer('host-b')).rejects.toThrow(/Add it again before connecting/)
    await api.selectThread('thread-a')

    expect(published.at(-1)?.selectedThreadId).toBe('thread-a')
    expect(published.at(-1)?.hosts.find((host) => host.id === 'host-a')?.connection).toBe('online')
    expect(published.at(-1)?.operations.submitCommands).toBe(true)
    expect(published.at(-1)?.hosts.some((host) => host.activationRequired)).toBe(false)
    unsubscribe()
  })

  it('observes an exact activation reply but never overwrites a newer user thread selection', async () => {
    const fixture = twoHostActivationCache()
    const activationReply = deferred<unknown>()
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: fixture.cache,
        outbox: [],
        connection: fixture.connectionA,
        appVersion: '0.1.0',
      })),
      activateVerifiedSshHost: vi.fn(() => activationReply.promise),
      hostCatalog: vi.fn(() => ok(fixture.catalogA)),
      requestSnapshot: vi.fn(() => ok(fixture.snapshotA)),
      submitCommand: vi.fn(),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()
    await vi.waitFor(() => expect(bridge.requestSnapshot).toHaveBeenCalled())
    await api.selectThread('thread-b')
    const activating = api.activateComputer('host-b')
    await vi.waitFor(() => expect(bridge.activateVerifiedSshHost).toHaveBeenCalledOnce())

    await api.selectThread('thread-a')
    activationReply.resolve(ok(fixture.connectionB))
    await expect(activating).rejects.toBeInstanceOf(StaleHostAuthorityError)

    expect(published.at(-1)?.selectedThreadId).toBe('thread-a')
    expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-a')?.transcript[0]?.body)
      .toBe('Authoritative A transcript.')
    expect(published.at(-1)?.hosts.find((host) => host.id === 'host-b')).toMatchObject({
      connection: 'online',
      activationRequired: true,
    })
    expect(published.at(-1)?.operations).toMatchObject({ submitCommands: false, startResidentTurn: false })
    expect(bridge.submitCommand).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('does not let delayed activation bootstrap replace a thread selected after the exact reply', async () => {
    const catalog = sshActivationCatalog('generation-stable', '2026-08-05T20:00:00.000Z')
    const firstSnapshot = recoverySnapshot(catalog.threads[0], 'Cached first thread.')
    const secondSnapshot = recoverySnapshot(catalog.threads[1], 'Selected second thread.')
    const offlineConnection = {
      phase: 'offline',
      target: { kind: 'ssh', alias: 'private-config-name' },
      hostId: 'host-b',
      path: 'ssh',
      since: '2026-08-05T20:00:00.000Z',
      attempt: 1,
      capabilities: ['prime_agent_commands_v2'],
    }
    const onlineConnection = { ...offlineConnection, phase: 'online', attempt: 2 }
    const cache = {
      version: 3,
      activeHostId: 'host-b',
      entries: {
        'host-b': { hostId: 'host-b', catalog, lastSnapshot: firstSnapshot },
      },
    }
    const delayedBootstrap = deferred<unknown>()
    const bridge = {
      bootstrap: vi.fn()
        .mockImplementationOnce(() => ok({ cache, outbox: [], connection: offlineConnection, appVersion: '0.1.0' }))
        .mockImplementationOnce(() => delayedBootstrap.promise),
      connect: vi.fn(),
      activateVerifiedSshHost: vi.fn(() => ok(onlineConnection)),
      hostCatalog: vi.fn(),
      requestSnapshot: vi.fn((input: { threadId: string }) =>
        input.threadId === 'thread-two' ? ok(secondSnapshot) : ok(firstSnapshot),
      ),
      submitCommand: vi.fn(),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()
    const activating = api.activateComputer('host-b')
    await vi.waitFor(() => expect(bridge.bootstrap).toHaveBeenCalledTimes(2))

    await api.selectThread('thread-two')
    expect(published.at(-1)?.selectedThreadId).toBe('thread-two')
    const afterSelection = published.length
    delayedBootstrap.resolve(ok({ cache, outbox: [], connection: onlineConnection, appVersion: '0.1.0' }))
    await expect(activating).rejects.toBeInstanceOf(StaleHostAuthorityError)

    expect(published.slice(afterSelection).every((snapshot) => snapshot.selectedThreadId === 'thread-two')).toBe(true)
    expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-two')?.transcript[0]?.body)
      .toBe('Selected second thread.')
    expect(published.at(-1)?.hosts.find((host) => host.id === 'host-b')?.activationRequired).toBe(true)
    expect(published.at(-1)?.operations).toMatchObject({ submitCommands: false, startResidentTurn: false })
    expect(bridge.hostCatalog).not.toHaveBeenCalled()
    await expect(api.sendComposer({ threadId: 'thread-two', text: 'Never replay this draft' }))
      .resolves.toMatchObject({ state: 'rejected' })
    expect(bridge.submitCommand).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('does not treat a rejected regressed catalog as fresh activation proof', async () => {
    const cachedCatalog = sshActivationCatalog('generation-stable', '2026-08-05T20:02:00.000Z')
    const regressedCatalog = sshActivationCatalog('generation-stable', '2026-08-05T20:01:00.000Z')
    const cachedSnapshot = recoverySnapshot(cachedCatalog.threads[0], 'Cached transcript only.')
    const onlineConnection = {
      phase: 'online',
      target: { kind: 'ssh', alias: 'private-config-name' },
      hostId: 'host-b',
      path: 'ssh',
      since: '2026-08-05T20:03:00.000Z',
      attempt: 2,
      capabilities: ['prime_agent_commands_v2'],
    }
    const cache = {
      version: 3,
      activeHostId: 'host-b',
      entries: {
        'host-b': { hostId: 'host-b', catalog: cachedCatalog, lastSnapshot: cachedSnapshot },
      },
    }
    const bridge = {
      bootstrap: vi.fn()
        .mockImplementationOnce(() => ok({
          cache,
          outbox: [],
          connection: { ...onlineConnection, phase: 'offline', attempt: 1 },
          appVersion: '0.1.0',
        }))
        .mockImplementationOnce(() => ok({ cache, outbox: [], connection: onlineConnection, appVersion: '0.1.0' })),
      connect: vi.fn(),
      activateVerifiedSshHost: vi.fn(() => ok(onlineConnection)),
      hostCatalog: vi.fn(() => ok(regressedCatalog)),
      requestSnapshot: vi.fn(() => ok(cachedSnapshot)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()

    await expect(api.activateComputer('host-b')).rejects.toBeInstanceOf(StaleHostAuthorityError)

    expect(bridge.hostCatalog).toHaveBeenCalledOnce()
    expect(bridge.requestSnapshot).not.toHaveBeenCalled()
    expect(published.at(-1)?.hosts.find((host) => host.id === 'host-b')?.activationRequired).toBe(true)
    expect(published.at(-1)?.operations).toMatchObject({ submitCommands: false, startResidentTurn: false })
    unsubscribe()
  })

  it('projects fresh local setup only from exact live runtime and local lifecycle authority', async () => {
    const readyRuntime = (hostId = 'host-local') => ({
      kind: 'reported',
      hostId,
      hostdVersion: '0.1.0',
      startedAt: '2026-08-05T19:59:00.000Z',
      observedAt: '2026-08-05T20:00:00.000Z',
      snapshot: {
        status: 'ready',
        assurance: 'development-integrity',
      },
    })
    const load = async (connection: Record<string, unknown>) => {
      const bridge = {
        bootstrap: vi.fn(() => ok({
          cache: { version: 3, entries: {} },
          outbox: [],
          connection,
          appVersion: '0.1.0',
        })),
        connect: vi.fn(() => new Promise<never>(() => undefined)),
        hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      }
      const api = new NativeRendererApi(bridge)
      return await api.loadWorkbench()
    }
    const exactConnection = {
      phase: 'online',
      target: { kind: 'local' },
      hostId: 'host-local',
      path: 'local_socket',
      since: '2026-08-05T20:00:00.000Z',
      attempt: 1,
      capabilities: ['runtime_integrity_v1', 'resident_lifecycle_v1'],
      runtimeReadiness: readyRuntime(),
    }

    const exact = await load(exactConnection)
    expect(exact.localSetup).toMatchObject({
      stage: 'choose_workspace',
      runtimeReadiness: { kind: 'reported', freshness: 'live', status: 'ready' },
    })
    expect(exact.operations.provisionResident).toBe(true)

    const missingLifecycle = await load({
      ...exactConnection,
      capabilities: ['runtime_integrity_v1'],
    })
    expect(missingLifecycle.localSetup).toMatchObject({
      stage: 'needs_attention',
      issue: { code: 'resident_lifecycle_unavailable', action: 'review_diagnostics' },
    })
    expect(missingLifecycle.operations.provisionResident).toBeUndefined()

    const warmingLifecycle = await load({
      ...exactConnection,
      capabilities: ['runtime_integrity_v1'],
      runtimeReadiness: {
        ...readyRuntime(),
        observedAt: new Date().toISOString(),
      },
    })
    expect(warmingLifecycle.localSetup).toMatchObject({
      stage: 'preparing_runtime',
      runtimeReadiness: { status: 'ready' },
    })
    expect(warmingLifecycle.localSetup?.issue).toBeUndefined()
    expect(warmingLifecycle.operations.provisionResident).toBeUndefined()

    const degraded = await load({ ...exactConnection, phase: 'degraded' })
    expect(degraded.localSetup).toMatchObject({
      stage: 'needs_attention',
      issue: { area: 'local_service', action: 'review_diagnostics' },
    })
    expect(degraded.operations.provisionResident).toBeUndefined()

    const wrongRuntimeAuthority = await load({
      ...exactConnection,
      runtimeReadiness: readyRuntime('host-other'),
    })
    expect(wrongRuntimeAuthority.localSetup).toMatchObject({
      stage: 'needs_attention',
      issue: { code: 'runtime_readiness_unavailable', action: 'review_diagnostics' },
    })
    expect(wrongRuntimeAuthority.operations.provisionResident).toBeUndefined()

    const wrongPath = await load({ ...exactConnection, path: 'ssh' })
    expect(wrongPath.localSetup).toMatchObject({
      stage: 'needs_attention',
      issue: { code: 'local_socket_required', action: 'review_diagnostics' },
    })
    expect(wrongPath.operations.provisionResident).toBeUndefined()
  })

  it('keeps local setup connection failures path-free and ignores native error details', async () => {
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 3, entries: {} },
        outbox: [],
        connection: {
          phase: 'offline',
          target: { kind: 'local' },
          since: '2026-08-05T20:00:00.000Z',
          attempt: 1,
          error: {
            code: 'hostd.start_timeout',
            message: 'Timed out at C:\\Users\\operator\\private\\host.sock',
            retryable: true,
            details: {
              endpoint: 'C:\\Users\\operator\\private\\host.sock',
              hostdScript: 'C:\\Program Files\\Prime Continuim\\resources\\hostd.cjs',
            },
          },
        },
        appVersion: '0.1.0',
      })),
      connect: vi.fn(() => new Promise<never>(() => undefined)),
    }
    const view = await new NativeRendererApi(bridge).loadWorkbench()
    expect(view.localSetup).toEqual({
      stage: 'needs_attention',
      issue: {
        area: 'local_service',
        action: 'retry_connection',
        message: 'The local service did not become ready in time.',
        retryable: true,
        code: 'hostd.start_timeout',
      },
    })
    expect(JSON.stringify(view.localSetup)).not.toContain('operator')
    expect(JSON.stringify(view.localSetup)).not.toContain('host.sock')
    expect(JSON.stringify(view.localSetup)).not.toContain('Program Files')
  })

  it('retries only an explicitly retryable local setup connection through the existing local target', async () => {
    const offline = {
      phase: 'offline',
      target: { kind: 'local' },
      since: '2026-08-05T20:00:00.000Z',
      attempt: 1,
      error: { code: 'hostd.start_timeout', message: 'Timed out.', retryable: true },
    }
    const connected = {
      ...residentLifecycleConnection(),
      capabilities: ['runtime_integrity_v1', 'resident_lifecycle_v1'],
    }
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('Automatic retry remains visible as failed.'))
      .mockReturnValueOnce(ok(connected))
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 3, entries: {} },
        outbox: [],
        connection: offline,
        appVersion: '0.1.0',
      })),
      connect,
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
    }
    const api = new NativeRendererApi(bridge)
    const view = await api.loadWorkbench()
    expect(view.localSetup?.issue?.action).toBe('retry_connection')
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1))

    await expect(api.retryLocalSetup()).resolves.toBeUndefined()
    expect(connect).toHaveBeenNthCalledWith(1, { kind: 'local' })
    expect(connect).toHaveBeenNthCalledWith(2, { kind: 'local' })
  })

  it('hydrates a HUD projection without initiating a shared service connection', async () => {
    const connect = vi.fn(() => new Promise<never>(() => undefined))
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 3, entries: {} },
        outbox: [],
        connection: {
          phase: 'offline',
          target: { kind: 'local' },
          since: '2026-08-05T20:00:00.000Z',
          attempt: 1,
          error: { code: 'hostd.start_timeout', message: 'Timed out.', retryable: true },
        },
        appVersion: '0.1.0',
      })),
      connect,
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
    }

    const view = await new NativeRendererApi(bridge, { allowConnectionInitiation: false }).loadWorkbench()
    expect(view.localSetup?.stage).toBe('needs_attention')
    await Promise.resolve()
    await Promise.resolve()
    expect(connect).not.toHaveBeenCalled()
    expect(bridge.hostCatalog).not.toHaveBeenCalled()
  })

  it('offers and sends one exact runtime retry only for the negotiated local failed authority', async () => {
    const failed = runtimeIntegritySnapshot('failed')
    const initializing = runtimeIntegritySnapshot('initializing')
    const retryRuntimeIntegrity = vi.fn(() => ok(initializing))
    const connect = vi.fn()
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 3, entries: {} },
        outbox: [],
        connection: {
          phase: 'online',
          target: { kind: 'local' },
          hostId: 'host-local',
          path: 'local_socket',
          since: '2026-08-05T20:00:00.000Z',
          attempt: 1,
          capabilities: ['runtime_integrity_v1', 'runtime_integrity_retry_v1'],
          runtimeReadiness: {
            kind: 'reported',
            hostId: 'host-local',
            hostdVersion: '0.1.0',
            startedAt: '2026-08-05T19:59:00.000Z',
            observedAt: '2026-08-05T20:00:00.000Z',
            snapshot: failed,
          },
        },
        appVersion: '0.1.0',
      })),
      connect,
      retryRuntimeIntegrity,
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    const view = await api.loadWorkbench()
    expect(view.localSetup).toMatchObject({
      stage: 'needs_attention',
      runtimeReadiness: { status: 'failed', retryable: true, recovery: 'retry' },
      issue: { area: 'runtime', action: 'retry_runtime', retryable: true },
    })

    await expect(api.retryLocalSetup()).resolves.toBeUndefined()
    expect(retryRuntimeIntegrity).toHaveBeenCalledOnce()
    expect(retryRuntimeIntegrity).toHaveBeenCalledWith({ expectedHostId: 'host-local' })
    expect(connect).not.toHaveBeenCalled()
    expect(published.at(-1)?.localSetup).toMatchObject({
      stage: 'preparing_runtime',
      runtimeReadiness: { status: 'initializing', phase: 'preparing' },
    })
    expect(published.at(-1)?.localSetup?.issue).toBeUndefined()
    unsubscribe()
  })

  it('offers and sends one path-free runtime repair fence only for the negotiated local authority', async () => {
    const failed = {
      ...runtimeIntegritySnapshot('failed'),
      code: 'RUNTIME_REPAIR_REQUIRED',
      retryable: false,
      recoveryAction: 'repair_application',
    }
    const initializing = runtimeIntegritySnapshot('initializing')
    const repairRuntimeIntegrity = vi.fn(() => ok(initializing))
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 3, entries: {} },
        outbox: [],
        connection: {
          phase: 'degraded',
          target: { kind: 'local' },
          hostId: 'host-local',
          path: 'local_socket',
          since: '2026-08-05T20:00:00.000Z',
          attempt: 1,
          capabilities: ['runtime_integrity_v1', 'runtime_integrity_repair_v1'],
          runtimeReadiness: {
            kind: 'reported',
            hostId: 'host-local',
            hostdVersion: '0.1.0',
            startedAt: '2026-08-05T19:59:00.000Z',
            observedAt: '2026-08-05T20:00:00.000Z',
            snapshot: failed,
          },
        },
        appVersion: '0.1.0',
      })),
      repairRuntimeIntegrity,
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    const view = await api.loadWorkbench()
    expect(view.localSetup).toMatchObject({
      stage: 'needs_attention',
      runtimeReadiness: { status: 'failed', retryable: false, recovery: 'repair' },
      issue: { area: 'runtime', action: 'repair_runtime', retryable: false },
    })
    expect(JSON.stringify(view.localSetup)).not.toMatch(/[A-Z]:\\|\/Users\//)

    await expect(api.repairLocalRuntime()).resolves.toBeUndefined()
    expect(repairRuntimeIntegrity).toHaveBeenCalledOnce()
    expect(repairRuntimeIntegrity).toHaveBeenCalledWith({
      expectedHostId: 'host-local',
      expectedTrustAnchorId: failed.trustAnchorId,
      expectedTarget: failed.target,
      expectedChangedAt: failed.changedAt,
    })
    expect(published.at(-1)?.localSetup).toMatchObject({
      stage: 'preparing_runtime',
      runtimeReadiness: { status: 'initializing', phase: 'preparing' },
    })
    unsubscribe()
  })

  it('keeps repair manual when the host does not advertise the exact repair capability', async () => {
    const failed = {
      ...runtimeIntegritySnapshot('failed'),
      code: 'RUNTIME_REPAIR_REQUIRED',
      retryable: false,
      recoveryAction: 'repair_application',
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 3, entries: {} },
        outbox: [],
        connection: {
          phase: 'degraded',
          target: { kind: 'local' },
          hostId: 'host-local',
          path: 'local_socket',
          since: '2026-08-05T20:00:00.000Z',
          attempt: 1,
          capabilities: ['runtime_integrity_v1'],
          runtimeReadiness: {
            kind: 'reported',
            hostId: 'host-local',
            hostdVersion: '0.1.0',
            startedAt: '2026-08-05T19:59:00.000Z',
            observedAt: '2026-08-05T20:00:00.000Z',
            snapshot: failed,
          },
        },
        appVersion: '0.1.0',
      })),
      repairRuntimeIntegrity: vi.fn(),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
    }
    const api = new NativeRendererApi(bridge)
    const view = await api.loadWorkbench()
    expect(view.localSetup).toMatchObject({
      stage: 'needs_attention',
      issue: { action: 'manual_recovery', retryable: false },
    })
    await expect(api.repairLocalRuntime()).rejects.toThrow('does not allow runtime repair')
    expect(bridge.repairRuntimeIntegrity).not.toHaveBeenCalled()
  })

  it('does not offer runtime retry without the exact negotiated capability', async () => {
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 3, entries: {} },
        outbox: [],
        connection: {
          phase: 'online',
          target: { kind: 'local' },
          hostId: 'host-local',
          path: 'local_socket',
          since: '2026-08-05T20:00:00.000Z',
          attempt: 1,
          capabilities: ['runtime_integrity_v1'],
          runtimeReadiness: {
            kind: 'reported',
            hostId: 'host-local',
            hostdVersion: '0.1.0',
            startedAt: '2026-08-05T19:59:00.000Z',
            observedAt: '2026-08-05T20:00:00.000Z',
            snapshot: runtimeIntegritySnapshot('failed'),
          },
        },
        appVersion: '0.1.0',
      })),
      retryRuntimeIntegrity: vi.fn(),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
    }
    const api = new NativeRendererApi(bridge)
    const view = await api.loadWorkbench()
    expect(view.localSetup).toMatchObject({
      stage: 'needs_attention',
      issue: { action: 'review_diagnostics', retryable: false },
    })
    await expect(api.retryLocalSetup()).rejects.toThrow('does not allow a retry')
    expect(bridge.retryRuntimeIntegrity).not.toHaveBeenCalled()
  })

  it('does not let a delayed background local-connect reply overwrite a newer reconnecting observation', async () => {
    const connectResult = deferred<unknown>()
    let connectionListener: ((state: unknown) => void) | undefined
    const hostCatalog = vi.fn(() => new Promise<never>(() => undefined))
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 3, entries: {} },
        outbox: [],
        connection: {
          phase: 'offline',
          target: { kind: 'local' },
          since: '2026-08-05T20:00:00.000Z',
          attempt: 1,
        },
        appVersion: '0.1.0',
      })),
      connect: vi.fn(() => connectResult.promise),
      hostCatalog,
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    const initial = await api.loadWorkbench()
    expect(initial.localSetup?.stage).toBe('starting_local_service')
    await vi.waitFor(() => expect(bridge.connect).toHaveBeenCalledTimes(1))

    connectionListener?.({
      phase: 'reconnecting',
      target: { kind: 'local' },
      path: 'local_socket',
      since: '2026-08-05T20:00:01.000Z',
      attempt: 2,
    })
    expect(published.at(-1)?.localSetup?.stage).toBe('starting_local_service')

    connectResult.resolve(ok({
      ...residentLifecycleConnection(),
      capabilities: ['runtime_integrity_v1', 'resident_lifecycle_v1'],
    }))
    await connectResult.promise
    await Promise.resolve()

    expect(published.some((snapshot) => snapshot.localSetup?.stage === 'choose_workspace')).toBe(false)
    expect(published.at(-1)?.localSetup?.stage).toBe('starting_local_service')
    expect(published.at(-1)?.operations.provisionResident).toBeUndefined()
    expect(hostCatalog).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('does not let a delayed user retry overwrite a newer SSH observation', async () => {
    const retryResult = deferred<unknown>()
    let connectionListener: ((state: unknown) => void) | undefined
    const offline = {
      phase: 'offline',
      target: { kind: 'local' },
      since: '2026-08-05T20:00:00.000Z',
      attempt: 1,
      error: { code: 'hostd.start_timeout', message: 'Timed out.', retryable: true },
    }
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('Automatic retry remains visible as failed.'))
      .mockImplementationOnce(() => retryResult.promise)
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 3, entries: {} },
        outbox: [],
        connection: offline,
        appVersion: '0.1.0',
      })),
      connect,
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    const initial = await api.loadWorkbench()
    expect(initial.localSetup?.issue?.action).toBe('retry_connection')
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1))

    const retry = api.retryLocalSetup()
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
    connectionListener?.({
      phase: 'reconnecting',
      target: { kind: 'ssh', alias: 'devbox' },
      path: 'ssh',
      since: '2026-08-05T20:00:01.000Z',
      attempt: 2,
    })
    retryResult.resolve(ok({
      ...residentLifecycleConnection(),
      capabilities: ['runtime_integrity_v1', 'resident_lifecycle_v1'],
    }))
    await expect(retry).resolves.toBeUndefined()

    expect(published.some((snapshot) => snapshot.localSetup?.stage === 'choose_workspace')).toBe(false)
    expect(published.at(-1)?.localSetup).toBeUndefined()
    expect(published.at(-1)?.operations.provisionResident).toBeUndefined()
    unsubscribe()
  })

  it('rejects a delayed Add computer SSH reply after a newer local observation', async () => {
    const sshResult = deferred<unknown>()
    let connectionListener: ((state: unknown) => void) | undefined
    const connect = vi.fn(() => sshResult.promise)
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 3, entries: {} },
        outbox: [],
        connection: residentLifecycleConnection(),
        appVersion: '0.1.0',
      })),
      connect,
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()

    const adding = api.addComputer({
      alias: 'devbox',
      installHostService: false,
      installCommandAcknowledged: false,
    })
    await vi.waitFor(() => expect(connect).toHaveBeenCalledWith({ kind: 'ssh', alias: 'devbox' }))
    connectionListener?.({
      ...residentLifecycleConnection(),
      since: '2026-08-05T20:00:02.000Z',
      attempt: 2,
    })
    expect(published.at(-1)?.localSetup?.stage).toBe('choose_workspace')

    sshResult.resolve(ok({
      phase: 'online',
      target: { kind: 'ssh', alias: 'devbox' },
      hostId: 'host-remote',
      path: 'ssh',
      since: '2026-08-05T20:00:01.000Z',
      attempt: 1,
    }))

    await expect(adding).rejects.toBeInstanceOf(StaleHostAuthorityError)
    expect(published.at(-1)?.localSetup?.stage).toBe('choose_workspace')
    expect(published.at(-1)?.operations.provisionResident).toBe(true)
    unsubscribe()
  })

  it('accepts its own connecting and online SSH events before the Add computer reply', async () => {
    const sshResult = deferred<unknown>()
    let connectionListener: ((state: unknown) => void) | undefined
    const remoteCatalog = {
      snapshotVersion: 1,
      generatedAt: '2026-08-05T20:00:03.000Z',
      host: {
        hostId: 'host-remote',
        displayName: 'devbox',
        kind: 'ssh',
        reachability: 'online',
        compatibility: 'update_available',
        connectionPaths: [{ kind: 'ssh', priority: 0, state: 'available', latencyMs: 24 }],
      },
      projects: [],
      threads: [],
    }
    const sshConnection = {
      phase: 'online',
      target: { kind: 'ssh', alias: 'devbox' },
      hostId: 'host-remote',
      path: 'ssh',
      since: '2026-08-05T20:00:02.000Z',
      attempt: 1,
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 3, entries: {} },
        outbox: [],
        connection: residentLifecycleConnection(),
        appVersion: '0.1.0',
      })),
      connect: vi.fn(() => sshResult.promise),
      hostCatalog: vi.fn(() => ok(remoteCatalog)),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const unsubscribe = api.subscribe(() => undefined)
    await api.loadWorkbench()

    const adding = api.addComputer({
      alias: 'devbox',
      installHostService: false,
      installCommandAcknowledged: false,
    })
    await vi.waitFor(() => expect(bridge.connect).toHaveBeenCalledWith({ kind: 'ssh', alias: 'devbox' }))
    connectionListener?.({
      phase: 'connecting',
      target: { kind: 'ssh', alias: 'devbox' },
      path: 'ssh',
      since: '2026-08-05T20:00:01.000Z',
      attempt: 1,
    })
    connectionListener?.(sshConnection)
    sshResult.resolve(ok(sshConnection))

    await expect(adding).resolves.toEqual({
      host: {
        id: 'host-remote',
        name: 'devbox',
        kind: 'ssh',
        connection: 'online',
        connectionPath: 'SSH',
        latencyMs: 24,
        compatibility: 'update_available',
      },
    })
    expect(bridge.hostCatalog).toHaveBeenCalled()
    unsubscribe()
  })

  it('projects runtime readiness only onto its active immutable host without inferring command support', async () => {
    const catalog = singleHostCatalog('host-local', 'This computer', 'thread-local', 'project-local')
    const remoteCatalog = singleHostCatalog('host-remote', 'devbox', 'thread-remote', 'project-remote')
    const threadSnapshot = recoverySnapshot(catalog.threads[0], 'Verified host transcript.')
    let connectionListener: ((state: unknown) => void) | undefined
    const runtimeReadiness = {
      kind: 'reported',
      hostId: 'host-local',
      hostdVersion: '0.1.0',
      startedAt: '2026-08-05T19:59:00.000Z',
      observedAt: '2026-08-05T20:00:00.000Z',
      snapshot: {
        status: 'ready',
        assurance: 'development-integrity',
      },
    }
    const connection = {
      ...onlineConnection(),
      capabilities: ['runtime_integrity_v1'],
      runtimeReadiness,
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: {
          version: 3,
          activeHostId: 'host-local',
          entries: {
            'host-local': { hostId: 'host-local', catalog, lastSnapshot: threadSnapshot },
            'host-remote': { hostId: 'host-remote', catalog: remoteCatalog },
          },
        },
        outbox: [],
        connection,
        appVersion: '0.1.0',
      })),
      connect: vi.fn(() => new Promise<never>(() => undefined)),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn(() => ok(threadSnapshot)),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))

    const live = await api.loadWorkbench()
    expect(live.hosts.find((host) => host.id === 'host-local')?.runtimeReadiness).toEqual({
      kind: 'reported',
      freshness: 'live',
      observedAt: '2026-08-05T20:00:00.000Z',
      status: 'ready',
      assurance: 'development-integrity',
    })
    expect(live.hosts.find((host) => host.id === 'host-remote')?.runtimeReadiness).toBeUndefined()
    expect(live.operations.submitCommands).toBe(false)

    connectionListener?.({ ...connection, phase: 'degraded' })
    expect(published.at(-1)?.hosts.find((host) => host.id === 'host-local')?.runtimeReadiness).toMatchObject({
      kind: 'reported',
      freshness: 'live',
    })

    connectionListener?.({ ...connection, phase: 'offline' })
    expect(published.at(-1)?.hosts.find((host) => host.id === 'host-local')?.runtimeReadiness).toMatchObject({
      kind: 'reported',
      freshness: 'cached',
      status: 'ready',
    })

    connectionListener?.({
      ...connection,
      runtimeReadiness: {
        ...runtimeReadiness,
        snapshot: { status: 'failed', recoveryAction: 'future_recovery_action' },
      },
    })
    expect(published.at(-1)?.hosts.find((host) => host.id === 'host-local')?.runtimeReadiness).toMatchObject({
      kind: 'reported',
      freshness: 'live',
      status: 'failed',
      recovery: 'diagnostics',
    })

    connectionListener?.({
      ...connection,
      runtimeReadiness: { ...runtimeReadiness, hostId: 'host-remote' },
    })
    expect(published.at(-1)?.hosts.every((host) => host.runtimeReadiness === undefined)).toBe(true)
    unsubscribe()
  })

  it('surfaces the first blocking host warning for a non-executable handoff plan', async () => {
    const catalog = singleHostCatalog('host-local', 'This computer', 'thread-one', 'project-local')
    const destinationCatalog = singleHostCatalog('host-remote', 'devbox', 'thread-remote', 'project-remote')
    const firstSnapshot = recoverySnapshot(catalog.threads[0], 'Authoritative first thread.')
    const bridge = {
      bootstrap: vi.fn(() =>
        ok({
          cache: {
            version: 3,
            activeHostId: 'host-local',
            entries: {
              'host-local': { hostId: 'host-local', catalog, lastSnapshot: firstSnapshot },
              'host-remote': { hostId: 'host-remote', catalog: destinationCatalog },
            },
          },
          outbox: [],
          connection: {
            ...onlineConnection(),
            capabilities: ['prime_agent_commands_v2', 'thread_handoff_v1'],
          },
          appVersion: '0.1.0',
        }),
      ),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn(() => ok(firstSnapshot)),
      planHandoff: vi.fn(() =>
        ok({
          executable: false,
          warnings: [
            { blocking: false, message: 'This is informational.' },
            { blocking: true, message: 'The destination branch has diverged.' },
          ],
        }),
      ),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    await api.loadWorkbench()

    await expect(
      api.planHandoff({
        threadId: 'thread-one',
        destinationHostId: 'host-remote',
        behaviorIfRunning: 'interrupt',
      }),
    ).rejects.toThrow('The destination branch has diverged.')
  })

  it('loads only the verified authority model catalog through the capability-gated bridge', async () => {
    const runtimeCatalog = {
      runtime: 'prime_agent',
      releaseVersion: '0.7.0',
      observedAt: '2026-08-07T12:00:00.000Z',
      providers: [{
        providerId: 'openai-codex',
        displayName: 'ChatGPT Plus/Pro (Codex Subscription)',
        oauthSupported: true,
        oauthUsesCallbackServer: true,
        configured: true,
        authSource: 'stored',
        modelCount: 1,
        availableModelCount: 1,
      }],
      models: [{
        providerId: 'openai-codex',
        modelId: 'gpt-5.3-codex',
        name: 'GPT-5.3 Codex',
        api: 'openai-codex-responses',
        reasoning: true,
        input: ['text'],
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        available: true,
        usingOAuth: true,
      }],
    }
    const runtimeModelCatalog = vi.fn(() => ok(runtimeCatalog))
    const api = new NativeRendererApi({
      bootstrap: () => ok({
        cache: { version: 3, activeHostId: 'host-local', entries: {} },
        outbox: [],
        connection: {
          ...onlineConnection(),
          capabilities: ['runtime_model_catalog_v1'],
        },
        appVersion: '0.1.0',
      }),
      runtimeModelCatalog,
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    })
    await api.loadWorkbench()

    await expect(api.loadRuntimeModelCatalog('host-local')).resolves.toEqual(runtimeCatalog)
    expect(runtimeModelCatalog).toHaveBeenCalledWith({ expectedHostId: 'host-local' })
    await expect(api.loadRuntimeModelCatalog('host-remote')).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
    expect(runtimeModelCatalog).toHaveBeenCalledOnce()
  })

  it.each([
    {
      label: 'legacy start eligibility without the durable family',
      capabilities: ['runtime_model_catalog_v1', 'runtime_oauth_v1'],
    },
    {
      label: 'durable reconciliation without new-start eligibility',
      capabilities: ['runtime_model_catalog_v1', 'runtime_oauth_attempt_v1'],
    },
  ])('withholds a new Prime OAuth start for $label', async ({ capabilities }) => {
    const catalog = recoveryCatalog()
    const startRuntimeOAuth = vi.fn()
    const api = new NativeRendererApi({
      bootstrap: vi.fn(() => ok({
        cache: {
          version: 2,
          projectionHostId: 'host-local',
          catalog,
          lastSnapshot: recoverySnapshot(catalog.threads[0], 'OAuth capability split.'),
        },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: { ...onlineConnection(), capabilities },
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      startRuntimeOAuth,
    })

    const projection = await api.loadWorkbench()
    expect(projection.operations.runtimeOAuth).toBeUndefined()
    expect(() => api.startRuntimeOAuth({
      hostId: 'host-local',
      providerId: 'openai-codex',
    }, () => undefined)).toThrow(StaleHostAuthorityError)
    expect(startRuntimeOAuth).not.toHaveBeenCalled()
  })

  it('runs one sequential Prime OAuth poll chain after new-start eligibility withdraws and refreshes the catalog', async () => {
    vi.useFakeTimers()
    try {
      let connectionListener: ((state: unknown) => void) | undefined
      const catalog = recoveryCatalog()
      catalog.threads[0].status = 'idle'
      const snapshot = recoverySnapshot(catalog.threads[0], 'Prime OAuth authority.')
      const unavailableCatalog = {
        runtime: 'prime_agent',
        releaseVersion: '0.7.0',
        observedAt: '2026-08-07T12:00:00.000Z',
        providers: [{
          providerId: 'openai-codex',
          displayName: 'ChatGPT Plus/Pro (Codex Subscription)',
          oauthSupported: true,
          oauthUsesCallbackServer: true,
          configured: false,
          authSource: 'none',
          modelCount: 1,
          availableModelCount: 0,
        }],
        models: [{
          providerId: 'openai-codex',
          modelId: 'gpt-5.3-codex',
          name: 'GPT-5.3 Codex',
          api: 'openai-codex-responses',
          reasoning: true,
          input: ['text'],
          contextWindow: 400_000,
          maxOutputTokens: 128_000,
          available: false,
          usingOAuth: false,
        }],
      }
      const refreshedCatalog = structuredClone(unavailableCatalog)
      refreshedCatalog.observedAt = '2026-08-07T12:01:00.000Z'
      refreshedCatalog.providers[0]!.configured = true
      refreshedCatalog.providers[0]!.authSource = 'stored'
      refreshedCatalog.providers[0]!.availableModelCount = 1
      refreshedCatalog.models[0]!.available = true
      refreshedCatalog.models[0]!.usingOAuth = true
      const expiresAt = '2099-08-07T12:10:00.000Z'
      const startRuntimeOAuth = vi.fn(() => ok({
        sessionId: 'oauth-session-one',
        providerId: 'openai-codex',
        phase: 'awaiting_user',
        expiresAt,
        interaction: { kind: 'browser', state: 'opened' },
      }))
      const statuses = [
        {
          sessionId: 'oauth-session-one',
          providerId: 'openai-codex',
          phase: 'committing',
          expiresAt,
        },
        {
          sessionId: 'oauth-session-one',
          providerId: 'openai-codex',
          phase: 'completed',
          expiresAt,
          configured: true,
        },
      ]
      let concurrentStatuses = 0
      let maxConcurrentStatuses = 0
      const runtimeOAuthStatus = vi.fn(async () => {
        concurrentStatuses += 1
        maxConcurrentStatuses = Math.max(maxConcurrentStatuses, concurrentStatuses)
        await Promise.resolve()
        concurrentStatuses -= 1
        return { ok: true as const, value: statuses.shift() }
      })
      const runtimeModelCatalog = vi.fn(() => ok(refreshedCatalog))
      const api = new NativeRendererApi({
        bootstrap: vi.fn(() => ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
          outbox: [],
          quarantinedOutboxCount: 0,
          connection: {
            ...onlineConnection(),
            capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1', 'runtime_oauth_attempt_v1', 'runtime_oauth_v1'],
          },
          appVersion: '0.1.0',
        })),
        hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
        requestSnapshot: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
        runtimeModelCatalog,
        startRuntimeOAuth,
        runtimeOAuthStatus,
        cancelRuntimeOAuth: vi.fn(),
        onConnectionState: vi.fn((listener: (state: unknown) => void) => {
          connectionListener = listener
          return () => undefined
        }),
      })

      const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
      const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
      const projection = await api.loadWorkbench()
      expect(projection.operations.runtimeOAuth).toBe(true)
      const progress: string[] = []
      const pending = api.startRuntimeOAuth({
        hostId: 'host-local',
        providerId: 'openai-codex',
      }, (update) => progress.push(`${update.phase}:${update.message}`))
      await Promise.resolve()
      await Promise.resolve()
      expect(startRuntimeOAuth).toHaveBeenCalledOnce()
      connectionListener?.({
        ...onlineConnection(),
        capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1', 'runtime_oauth_attempt_v1'],
      })
      expect(published.at(-1)?.operations.runtimeOAuth).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1_000)

      await expect(pending).resolves.toEqual({
        state: 'completed',
        message: 'ChatGPT is connected to Prime Agent and the model catalog is refreshed.',
        catalog: refreshedCatalog,
      })
      expect(startRuntimeOAuth).toHaveBeenCalledOnce()
      expect(startRuntimeOAuth).toHaveBeenCalledWith({
        expectedHostId: 'host-local',
        providerId: 'openai-codex',
      })
      expect(runtimeOAuthStatus).toHaveBeenCalledTimes(2)
      expect(runtimeOAuthStatus).toHaveBeenNthCalledWith(1, {
        expectedHostId: 'host-local',
        sessionId: 'oauth-session-one',
      })
      expect(maxConcurrentStatuses).toBe(1)
      expect(runtimeModelCatalog).toHaveBeenCalledOnce()
      expect(runtimeModelCatalog).toHaveBeenCalledWith({ expectedHostId: 'host-local' })
      expect(progress.join(' ')).toMatch(/awaiting_user:Finish signing in in your browser/)
      expect(progress.join(' ')).toMatch(/committing:Saving the Prime Agent account/)
      unsubscribe()
    } finally {
      vi.useRealTimers()
    }
  })

  it('admits host-scoped Prime OAuth before any resident thread exists', async () => {
    const catalog = recoveryCatalog()
    catalog.projects = []
    catalog.threads = []
    const expiresAt = '2099-08-07T12:10:00.000Z'
    const refreshedCatalog = {
      runtime: 'prime_agent',
      releaseVersion: '0.7.0',
      observedAt: '2026-08-07T12:01:00.000Z',
      providers: [],
      models: [],
    }
    const startRuntimeOAuth = vi.fn(() => ok({
      sessionId: 'oauth-first-run',
      providerId: 'openai-codex',
      phase: 'completed',
      expiresAt,
      configured: true,
    }))
    const runtimeModelCatalog = vi.fn(() => ok(refreshedCatalog))
    const api = new NativeRendererApi({
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: {
          ...onlineConnection(),
          capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1', 'runtime_oauth_attempt_v1', 'runtime_oauth_v1'],
        },
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot: vi.fn(() => Promise.reject(new Error('No resident thread exists yet.'))),
      runtimeModelCatalog,
      startRuntimeOAuth,
      runtimeOAuthStatus: vi.fn(),
      cancelRuntimeOAuth: vi.fn(),
    })

    const projection = await api.loadWorkbench()
    expect(projection.projects).toEqual([])
    expect(projection.threads).toEqual([])
    expect(projection.operations.modelCatalog).toBe(true)
    expect(projection.operations.runtimeOAuth).toBe(true)

    await expect(api.startRuntimeOAuth({
      hostId: 'host-local',
      providerId: 'openai-codex',
    }, () => undefined)).resolves.toEqual({
      state: 'completed',
      message: 'ChatGPT is connected to Prime Agent and the model catalog is refreshed.',
      catalog: refreshedCatalog,
    })
    expect(startRuntimeOAuth).toHaveBeenCalledWith({
      expectedHostId: 'host-local',
      providerId: 'openai-codex',
    })
    expect(runtimeModelCatalog).toHaveBeenCalledWith({ expectedHostId: 'host-local' })
  })

  it('keeps a host-scoped Prime OAuth session owned while the selected resident thread changes', async () => {
    vi.useFakeTimers()
    try {
      const catalog = recoveryCatalog()
      catalog.threads[0].status = 'idle'
      const firstSnapshot = recoverySnapshot(catalog.threads[0], 'Prime OAuth starts here.')
      const secondSnapshot = recoverySnapshot(catalog.threads[1], 'Another resident thread is selected.')
      const expiresAt = '2099-08-07T12:10:00.000Z'
      const startRuntimeOAuth = vi.fn(() => ok({
        sessionId: 'oauth-host-scoped',
        providerId: 'openai-codex',
        phase: 'awaiting_user',
        expiresAt,
        interaction: { kind: 'browser', state: 'opened' },
      }))
      const runtimeOAuthStatus = vi.fn(() => ok({
        sessionId: 'oauth-host-scoped',
        providerId: 'openai-codex',
        phase: 'completed',
        expiresAt,
        configured: true,
      }))
      const api = new NativeRendererApi({
        bootstrap: vi.fn(() => ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: firstSnapshot },
          outbox: [],
          quarantinedOutboxCount: 0,
          connection: {
            ...onlineConnection(),
            capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1', 'runtime_oauth_attempt_v1', 'runtime_oauth_v1'],
          },
          appVersion: '0.1.0',
        })),
        hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
        requestSnapshot: vi.fn((input: { threadId?: string }) =>
          ok(input.threadId === 'thread-two' ? secondSnapshot : firstSnapshot)),
        runtimeModelCatalog: vi.fn(() => ok({
          runtime: 'prime_agent',
          releaseVersion: '0.7.0',
          observedAt: '2026-08-07T12:01:00.000Z',
          providers: [],
          models: [],
        })),
        startRuntimeOAuth,
        runtimeOAuthStatus,
        cancelRuntimeOAuth: vi.fn(),
      })
      await api.loadWorkbench()

      const pending = api.startRuntimeOAuth({
        hostId: 'host-local',
        providerId: 'openai-codex',
      }, () => undefined)
      await Promise.resolve()
      await api.selectThread('thread-two')
      await vi.advanceTimersByTimeAsync(500)

      await expect(pending).resolves.toMatchObject({ state: 'completed' })
      expect(runtimeOAuthStatus).toHaveBeenCalledOnce()
      expect(startRuntimeOAuth).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the one admitted Prime OAuth session without polling or issuing another start', async () => {
    const catalog = recoveryCatalog()
    catalog.threads[0].status = 'idle'
    const snapshot = recoverySnapshot(catalog.threads[0], 'Prime OAuth cancellation authority.')
    const expiresAt = '2099-08-07T12:10:00.000Z'
    const startRuntimeOAuth = vi.fn(() => ok({
      sessionId: 'oauth-session-cancel',
      providerId: 'openai-codex',
      phase: 'awaiting_user',
      expiresAt,
      interaction: { kind: 'browser', state: 'opened' },
    }))
    const runtimeOAuthStatus = vi.fn()
    const cancelRuntimeOAuth = vi.fn(() => ok({
      sessionId: 'oauth-session-cancel',
      providerId: 'openai-codex',
      phase: 'cancelled',
      expiresAt,
    }))
    const api = new NativeRendererApi({
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: {
          ...onlineConnection(),
          capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1', 'runtime_oauth_attempt_v1', 'runtime_oauth_v1'],
        },
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      startRuntimeOAuth,
      runtimeOAuthStatus,
      cancelRuntimeOAuth,
    })
    await api.loadWorkbench()

    const request = { hostId: 'host-local', providerId: 'openai-codex' }
    const pending = api.startRuntimeOAuth(request, () => undefined)
    await Promise.resolve()
    const cancellation = api.cancelRuntimeOAuth(request)

    await expect(Promise.all([pending, cancellation])).resolves.toEqual([
      { state: 'cancelled', message: 'ChatGPT sign-in was cancelled.' },
      { state: 'cancelled', message: 'ChatGPT sign-in was cancelled.' },
    ])
    expect(startRuntimeOAuth).toHaveBeenCalledOnce()
    expect(runtimeOAuthStatus).not.toHaveBeenCalled()
    expect(cancelRuntimeOAuth).toHaveBeenCalledOnce()
    expect(cancelRuntimeOAuth).toHaveBeenCalledWith({
      expectedHostId: 'host-local',
      sessionId: 'oauth-session-cancel',
    })
  })

  it('sanitizes an ambiguous Prime OAuth start and never retries it inside the operation', async () => {
    const catalog = recoveryCatalog()
    catalog.threads[0].status = 'idle'
    const snapshot = recoverySnapshot(catalog.threads[0], 'Ambiguous Prime OAuth start.')
    const startRuntimeOAuth = vi.fn(() => Promise.reject(new Error('https://secret.example/callback?token=do-not-render')))
    const runtimeOAuthStatus = vi.fn()
    const api = new NativeRendererApi({
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: {
          ...onlineConnection(),
          capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1', 'runtime_oauth_attempt_v1', 'runtime_oauth_v1'],
        },
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      startRuntimeOAuth,
      runtimeOAuthStatus,
      cancelRuntimeOAuth: vi.fn(),
    })
    await api.loadWorkbench()

    const result = await api.startRuntimeOAuth({
      hostId: 'host-local',
      providerId: 'openai-codex',
    }, () => undefined)
    expect(result).toEqual({
      state: 'uncertain',
      retryable: false,
      message: 'Prime Agent may have started sign-in, but its session could not be verified. Prime Continuim will not start it again automatically.',
    })
    expect(JSON.stringify(result)).not.toMatch(/secret\.example|token=|do-not-render/)
    expect(startRuntimeOAuth).toHaveBeenCalledOnce()
    expect(runtimeOAuthStatus).not.toHaveBeenCalled()
  })

  it('withholds Prime OAuth from a non-local connection even when that host advertises the capability', async () => {
    const catalog = recoveryCatalog()
    catalog.threads[0].status = 'idle'
    const snapshot = recoverySnapshot(catalog.threads[0], 'Non-local OAuth authority.')
    const startRuntimeOAuth = vi.fn()
    const api = new NativeRendererApi({
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: {
          ...onlineConnection(),
          target: { kind: 'ssh', alias: 'host-local-over-ssh' },
          path: 'ssh',
          capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1', 'runtime_oauth_attempt_v1', 'runtime_oauth_v1'],
        },
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      startRuntimeOAuth,
    })

    const projection = await api.loadWorkbench()
    expect(projection.operations.runtimeOAuth).toBeUndefined()
    expect(() => api.startRuntimeOAuth({
      hostId: 'host-local',
      providerId: 'openai-codex',
    }, () => undefined)).toThrow(StaleHostAuthorityError)
    expect(startRuntimeOAuth).not.toHaveBeenCalled()
  })

  it('offers resident model selection only for the exact authoritative idle turn while preserving Stop', async () => {
    const modelConnection = {
      ...onlineConnection(),
      capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1'],
    }
    const idleCatalog = recoveryCatalog()
    idleCatalog.threads[0].status = 'idle'
    const idleSnapshot = recoverySnapshot(idleCatalog.threads[0], 'Idle model-selection authority.')
    const idleApi = new NativeRendererApi({
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog: idleCatalog, lastSnapshot: idleSnapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: modelConnection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
    })

    await expect(idleApi.loadWorkbench()).resolves.toMatchObject({
      runtime: { residentControlReadiness: 'ready' },
      operations: {
        startResidentTurn: true,
        stopResidentTurn: false,
        modelCatalog: true,
        selectResidentModel: true,
      },
    })

    const runningCatalog = recoveryCatalog()
    const runningSnapshot = recoverySnapshot(runningCatalog.threads[0], 'Running model-selection authority.')
    const runningApi = new NativeRendererApi({
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog: runningCatalog, lastSnapshot: runningSnapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: modelConnection,
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
    })
    const runningProjection = await runningApi.loadWorkbench()

    expect(runningProjection.operations).toMatchObject({
      startResidentTurn: false,
      stopResidentTurn: true,
      modelCatalog: true,
    })
    expect(runningProjection.operations.selectResidentModel).toBeUndefined()
    expect(() => runningApi.selectResidentModel({
      threadId: 'thread-one',
      providerId: 'openai-codex',
      modelId: 'gpt-5.3-codex',
    })).toThrow(StaleHostAuthorityError)
  })

  it('fails resident commands closed when exact per-thread readiness is absent or unavailable', async () => {
    const catalog = recoveryCatalog()
    catalog.threads[0].status = 'idle'
    const ready = recoverySnapshot(catalog.threads[0], 'Per-thread command authority.')
    const { residentControl: _residentControl, ...absent } = ready
    const unavailable = {
      ...ready,
      residentControl: { ...ready.residentControl, commandReadiness: 'unavailable' },
    }

    for (const [snapshot, expectedReadiness] of [
      [absent, undefined],
      [unavailable, 'unavailable'],
    ] as const) {
      const api = new NativeRendererApi({
        bootstrap: vi.fn(() => ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
          outbox: [],
          quarantinedOutboxCount: 0,
          connection: {
            ...onlineConnection(),
            capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1'],
          },
          appVersion: '0.1.0',
        })),
        hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
        requestSnapshot: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      })

      const projection = await api.loadWorkbench()
      expect(projection.operations).toMatchObject({
        submitCommands: false,
        startResidentTurn: false,
        stopResidentTurn: false,
      })
      expect(projection.runtime.residentControlReadiness).toBe(expectedReadiness)
      expect(projection.operations.selectResidentModel).toBeUndefined()
    }
  })

  it('submits one exact live-only model command and completes only after the refreshed model projects', async () => {
    const catalog = recoveryCatalog()
    catalog.threads[0].status = 'idle'
    const initialSnapshot = recoverySnapshot(catalog.threads[0], 'Before model selection.')
    const selectedSnapshot = structuredClone(initialSnapshot)
    selectedSnapshot.generatedAt = '2026-08-05T20:00:02.000Z'
    selectedSnapshot.latestCursor.sequence = 2
    selectedSnapshot.thread.lastKnownCursor = selectedSnapshot.latestCursor
    selectedSnapshot.runtime.model = 'openai-codex/gpt-5.3-codex'
    const submittedReceipt = deferred<unknown>()
    const submitCommand = vi.fn(() => submittedReceipt.promise)
    const requestSnapshot = vi.fn(() => ok(selectedSnapshot))
    const api = new NativeRendererApi({
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: initialSnapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: {
          ...onlineConnection(),
          capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1'],
        },
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot,
      submitCommand,
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    })
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()

    const request = {
      threadId: 'thread-one',
      providerId: 'openai-codex',
      modelId: 'gpt-5.3-codex',
    }
    const first = api.selectResidentModel(request)
    const duplicate = api.selectResidentModel(request)
    const conflicting = api.selectResidentModel({ ...request, modelId: 'gpt-5.2-codex' })
    expect(duplicate).toBe(first)
    await expect(conflicting).resolves.toEqual({
      state: 'rejected',
      retryable: true,
      message: 'Another resident model change is already being verified. Try again after it finishes.',
    })
    expect(submitCommand).toHaveBeenCalledOnce()
    const command = submitCommand.mock.calls[0]![0] as Record<string, unknown>
    expect(command).toMatchObject({
      expectedHostId: 'host-local',
      threadId: 'thread-one',
      expectedExecutionGenerationId: 'generation-one',
      kind: 'model.select',
      payload: { providerId: 'openai-codex', modelId: 'gpt-5.3-codex' },
      delivery: 'live_only',
    })
    expect(typeof command.commandId).toBe('string')
    expect(typeof command.issuedAt).toBe('string')
    submittedReceipt.resolve(ok({
      hostId: command.expectedHostId,
      deviceId: command.deviceId,
      commandId: command.commandId,
      threadId: command.threadId,
      executionGenerationId: command.expectedExecutionGenerationId,
      status: 'completed',
      durable: true,
      message: 'Selected GPT-5.3 Codex.',
    }))

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { state: 'completed', projected: true, message: 'Selected GPT-5.3 Codex.' },
      { state: 'completed', projected: true, message: 'Selected GPT-5.3 Codex.' },
    ])
    expect(requestSnapshot).toHaveBeenCalledOnce()
    expect(requestSnapshot).toHaveBeenCalledWith({ threadId: 'thread-one' })
    expect(published.at(-1)?.runtime.session?.model).toBe('openai-codex/gpt-5.3-codex')
    unsubscribe()
  })

  it('does not share an old-generation model promise with the same visible thread and target', async () => {
    const catalog = recoveryCatalog()
    catalog.threads[0].status = 'idle'
    const snapshot = recoverySnapshot(catalog.threads[0], 'Original model-selection generation.')
    const submittedReceipt = deferred<unknown>()
    let snapshotListener: ((snapshot: unknown) => void) | undefined
    const submitCommand = vi.fn(() => submittedReceipt.promise)
    const requestSnapshot = vi.fn(() => ok(snapshot))
    const api = new NativeRendererApi({
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: {
          ...onlineConnection(),
          capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1'],
        },
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot,
      submitCommand,
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn((listener: (next: unknown) => void) => {
        snapshotListener = listener
        return () => undefined
      }),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    })
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((projection) => published.push(projection))
    await api.loadWorkbench()

    const request = {
      threadId: 'thread-one',
      providerId: 'openai-codex',
      modelId: 'gpt-5.3-codex',
    }
    const original = api.selectResidentModel(request)
    const command = submitCommand.mock.calls[0]![0] as Record<string, unknown>
    const nextCatalog = structuredClone(catalog)
    nextCatalog.generatedAt = '2026-08-05T20:00:03.000Z'
    nextCatalog.threads[0].updatedAt = nextCatalog.generatedAt
    nextCatalog.threads[0].currentLocation.executionGenerationId = 'generation-one-next'
    snapshotListener?.(nextCatalog)
    expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-one')?.executionGenerationId)
      .toBe('generation-one-next')

    const reopened = api.selectResidentModel(request)
    expect(reopened).not.toBe(original)
    await expect(reopened).resolves.toMatchObject({ state: 'rejected', retryable: true })
    expect(submitCommand).toHaveBeenCalledOnce()

    submittedReceipt.resolve(ok({
      hostId: command.expectedHostId,
      deviceId: command.deviceId,
      commandId: command.commandId,
      threadId: command.threadId,
      executionGenerationId: command.expectedExecutionGenerationId,
      status: 'completed',
      durable: true,
    }))
    await expect(original).resolves.toMatchObject({ state: 'completed', projected: false })
    expect(requestSnapshot).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('keeps exact completed model proof dominant when the post-receipt refresh is unavailable', async () => {
    const catalog = recoveryCatalog()
    catalog.threads[0].status = 'idle'
    const snapshot = recoverySnapshot(catalog.threads[0], 'Completed model proof.')
    const requestSnapshot = vi.fn(() => Promise.reject(new Error('Snapshot refresh unavailable.')))
    const submitCommand = vi.fn((command: Record<string, unknown>) => ok({
      hostId: command.expectedHostId,
      deviceId: command.deviceId,
      commandId: command.commandId,
      threadId: command.threadId,
      executionGenerationId: command.expectedExecutionGenerationId,
      status: 'completed',
      durable: true,
      message: 'Model selected on the resident runtime.',
    }))
    const api = new NativeRendererApi({
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: {
          ...onlineConnection(),
          capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1'],
        },
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot,
      submitCommand,
    })
    await api.loadWorkbench()

    await expect(api.selectResidentModel({
      threadId: 'thread-one',
      providerId: 'openai-codex',
      modelId: 'gpt-5.3-codex',
    })).resolves.toEqual({
      state: 'completed',
      projected: false,
      message: 'Prime Agent completed this model change, but the current thread display has not refreshed yet.',
    })
    expect(submitCommand).toHaveBeenCalledOnce()
    expect(requestSnapshot).toHaveBeenCalledOnce()
  })

  it('does not replay an ambiguous model receipt and never projects it', async () => {
    const catalog = recoveryCatalog()
    catalog.threads[0].status = 'idle'
    const snapshot = recoverySnapshot(catalog.threads[0], 'Ambiguous model receipt.')
    const requestSnapshot = vi.fn(() => ok(snapshot))
    const submitCommand = vi.fn((command: Record<string, unknown>) => ok({
      hostId: command.expectedHostId,
      deviceId: command.deviceId,
      commandId: 'another-command',
      threadId: command.threadId,
      executionGenerationId: command.expectedExecutionGenerationId,
      status: 'completed',
      durable: true,
    }))
    const api = new NativeRendererApi({
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: {
          ...onlineConnection(),
          capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1'],
        },
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot,
      submitCommand,
    })
    await api.loadWorkbench()

    await expect(api.selectResidentModel({
      threadId: 'thread-one',
      providerId: 'openai-codex',
      modelId: 'gpt-5.3-codex',
    })).resolves.toEqual({
      state: 'uncertain',
      retryable: false,
      message: 'The host returned a receipt for another command authority. Prime Continuim will not replay this model change.',
    })
    expect(submitCommand).toHaveBeenCalledOnce()
    expect(requestSnapshot).not.toHaveBeenCalled()
  })

  it('preserves post-dispatch uncertainty and exact terminal rejection across authority replacement', async () => {
    const startAuthorityRace = async () => {
      const catalog = recoveryCatalog()
      catalog.threads[0].status = 'idle'
      const snapshot = recoverySnapshot(catalog.threads[0], 'Authority changes after dispatch.')
      const submittedReceipt = deferred<unknown>()
      let connectionListener: ((state: unknown) => void) | undefined
      const requestSnapshot = vi.fn(() => ok(snapshot))
      const submitCommand = vi.fn(() => submittedReceipt.promise)
      const api = new NativeRendererApi({
        bootstrap: vi.fn(() => ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
          outbox: [],
          quarantinedOutboxCount: 0,
          connection: {
            ...onlineConnection(),
            capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1'],
          },
          appVersion: '0.1.0',
        })),
        hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
        requestSnapshot,
        submitCommand,
        onConnectionState: vi.fn((listener: (state: unknown) => void) => {
          connectionListener = listener
          return () => undefined
        }),
        onSnapshot: vi.fn(() => () => undefined),
        onHostEvent: vi.fn(() => () => undefined),
        onHandoffProgress: vi.fn(() => () => undefined),
      })
      const unsubscribe = api.subscribe(() => undefined)
      await api.loadWorkbench()
      const pending = api.selectResidentModel({
        threadId: 'thread-one',
        providerId: 'openai-codex',
        modelId: 'gpt-5.3-codex',
      })
      const command = submitCommand.mock.calls[0]![0] as Record<string, unknown>
      connectionListener?.({
        phase: 'connecting',
        target: { kind: 'ssh', alias: 'replacement-host' },
        since: '2026-08-05T20:00:02.000Z',
        attempt: 2,
      })
      return { api, command, pending, requestSnapshot, submitCommand, submittedReceipt, unsubscribe }
    }

    const ambiguous = await startAuthorityRace()
    await expect(ambiguous.api.selectResidentModel({
      threadId: 'thread-one',
      providerId: 'openai-codex',
      modelId: 'gpt-5.2-codex',
    })).resolves.toMatchObject({ state: 'rejected', retryable: true })
    ambiguous.submittedReceipt.reject(new Error('Connection changed after dispatch.'))
    await expect(ambiguous.pending).resolves.toEqual({
      state: 'uncertain',
      retryable: false,
      message: 'Connection changed after dispatch. Prime Continuim will not replay this model change without terminal proof.',
    })
    expect(ambiguous.submitCommand).toHaveBeenCalledOnce()
    expect(ambiguous.requestSnapshot).not.toHaveBeenCalled()
    ambiguous.unsubscribe()

    const rejected = await startAuthorityRace()
    rejected.submittedReceipt.resolve(ok({
      hostId: rejected.command.expectedHostId,
      deviceId: rejected.command.deviceId,
      commandId: rejected.command.commandId,
      threadId: rejected.command.threadId,
      executionGenerationId: rejected.command.expectedExecutionGenerationId,
      status: 'rejected',
      durable: true,
      error: { retryable: true, message: 'The selected model is no longer available.' },
    }))
    await expect(rejected.pending).resolves.toEqual({
      state: 'rejected',
      retryable: true,
      message: 'The selected model is no longer available.',
    })
    expect(rejected.submitCommand).toHaveBeenCalledOnce()
    expect(rejected.requestSnapshot).not.toHaveBeenCalled()
    rejected.unsubscribe()
  })

  it('returns completed refresh-pending proof without mutating a replacement authority', async () => {
    const catalog = recoveryCatalog()
    catalog.threads[0].status = 'idle'
    const snapshot = recoverySnapshot(catalog.threads[0], 'Authority changes after selection.')
    const submittedReceipt = deferred<unknown>()
    let connectionListener: ((state: unknown) => void) | undefined
    const requestSnapshot = vi.fn(() => ok(snapshot))
    const submitCommand = vi.fn(() => submittedReceipt.promise)
    const api = new NativeRendererApi({
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: {
          ...onlineConnection(),
          capabilities: ['prime_agent_commands_v2', 'runtime_model_catalog_v1'],
        },
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => Promise.reject(new Error('Background refresh intentionally unavailable.'))),
      requestSnapshot,
      submitCommand,
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    })
    const unsubscribe = api.subscribe(() => undefined)
    await api.loadWorkbench()

    const pending = api.selectResidentModel({
      threadId: 'thread-one',
      providerId: 'openai-codex',
      modelId: 'gpt-5.3-codex',
    })
    const command = submitCommand.mock.calls[0]![0] as Record<string, unknown>
    connectionListener?.({
      phase: 'connecting',
      target: { kind: 'ssh', alias: 'replacement-host' },
      since: '2026-08-05T20:00:02.000Z',
      attempt: 2,
    })
    submittedReceipt.resolve(ok({
      hostId: command.expectedHostId,
      deviceId: command.deviceId,
      commandId: command.commandId,
      threadId: command.threadId,
      executionGenerationId: command.expectedExecutionGenerationId,
      status: 'completed',
      durable: true,
    }))

    await expect(pending).resolves.toMatchObject({ state: 'completed', projected: false })
    expect(submitCommand).toHaveBeenCalledOnce()
    expect(requestSnapshot).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('captures one stable issue time and exact generation for a composer command', async () => {
    const catalog = recoveryCatalog()
    catalog.threads[0].status = 'idle'
    const snapshot = recoverySnapshot(catalog.threads[0], 'Generation one transcript.')
    let submitted: Record<string, unknown> | undefined
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn(() => ok(snapshot)),
      submitCommand: vi.fn((input: Record<string, unknown>) => {
        submitted = input
        return ok({
          hostId: input.expectedHostId,
          deviceId: input.deviceId,
          commandId: input.commandId,
          threadId: input.threadId,
          executionGenerationId: input.expectedExecutionGenerationId,
          status: 'admitted',
          durable: true,
        })
      }),
      cancel: vi.fn((input: Record<string, unknown>) => ok({
        hostId: input.expectedHostId,
        deviceId: input.deviceId,
        commandId: input.commandId,
        threadId: input.threadId,
        executionGenerationId: input.expectedExecutionGenerationId,
        status: 'running',
        durable: true,
      })),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    api.subscribe((next) => published.push(next))
    await api.loadWorkbench()

    await expect(api.sendComposer({
      threadId: 'thread-one',
      text: 'Continue exactly here',
    })).resolves.toMatchObject({ state: 'sent' })

    expect(submitted).toMatchObject({
      expectedHostId: 'host-local',
      threadId: 'thread-one',
      expectedExecutionGenerationId: 'generation-one',
      kind: 'thread.prompt',
      payload: { text: 'Continue exactly here' },
    })
    expect(typeof submitted?.issuedAt).toBe('string')
    expect(Number.isFinite(Date.parse(String(submitted?.issuedAt)))).toBe(true)
    expect(bridge.submitCommand).toHaveBeenCalledOnce()
    expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-one')?.status).toBe('idle')
    expect(published.at(-1)?.operations).toMatchObject({ startResidentTurn: false, stopResidentTurn: true })
    expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'sent', operation: 'prompt' })

    await expect(api.abortThread('thread-one')).resolves.toMatchObject({
      state: 'sent',
      message: 'Stop accepted · waiting for authoritative idle proof',
    })
    expect(bridge.cancel).toHaveBeenCalledWith(expect.objectContaining({
      expectedHostId: 'host-local',
      threadId: 'thread-one',
      expectedExecutionGenerationId: 'generation-one',
    }))
    expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-one')?.status).toBe('idle')
    expect(published.at(-1)?.operations.stopResidentTurn).toBe(false)
    expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'sent', operation: 'abort' })
  })

  it('treats a direct exact completed prompt response as idle proof even when its parallel event is missed', async () => {
    const catalog = recoveryCatalog()
    catalog.threads[0].status = 'idle'
    const snapshot = recoverySnapshot(catalog.threads[0], 'Idle before direct proof.')
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(catalog)),
      requestSnapshot: vi.fn(() => ok(snapshot)),
      submitCommand: vi.fn((input: Record<string, unknown>) => ok({
        hostId: input.expectedHostId,
        deviceId: input.deviceId,
        commandId: input.commandId,
        threadId: input.threadId,
        executionGenerationId: input.expectedExecutionGenerationId,
        status: 'completed',
        durable: true,
      })),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    api.subscribe((next) => published.push(next))
    await api.loadWorkbench()

    await expect(api.sendComposer({ threadId: 'thread-one', text: 'Complete before the event.' }))
      .resolves.toMatchObject({ state: 'idle' })

    expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'idle' })
    expect(published.at(-1)?.operations).toMatchObject({ startResidentTurn: true, stopResidentTurn: false })
  })

  it.each(['waiting', 'needs_approval'] as const)(
    'keeps an exact idle resident %s state replyable through the ordinary durable prompt path',
    async (status) => {
      const catalog = recoveryCatalog()
      catalog.threads[0].status = status
      const snapshot = recoverySnapshot(catalog.threads[0], 'Prime Agent asked for more input.')
      const bridge = {
        bootstrap: vi.fn(() => ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
          outbox: [],
          connection: onlineConnection(),
          appVersion: '0.1.0',
        })),
        hostCatalog: vi.fn(() => ok(catalog)),
        requestSnapshot: vi.fn(() => ok(snapshot)),
        submitCommand: vi.fn((input: Record<string, unknown>) => ok({
          hostId: input.expectedHostId,
          deviceId: input.deviceId,
          commandId: input.commandId,
          threadId: input.threadId,
          executionGenerationId: input.expectedExecutionGenerationId,
          status: 'admitted',
          durable: true,
        })),
        onConnectionState: vi.fn(() => () => undefined),
        onSnapshot: vi.fn(() => () => undefined),
        onHostEvent: vi.fn(() => () => undefined),
        onHandoffProgress: vi.fn(() => () => undefined),
      }
      const api = new NativeRendererApi(bridge)
      const view = await api.loadWorkbench()

      expect(view.operations).toMatchObject({ startResidentTurn: true, stopResidentTurn: false })
      await expect(api.sendComposer({ threadId: 'thread-one', text: 'Here is the missing context.' }))
        .resolves.toMatchObject({ state: 'sent' })
      expect(bridge.submitCommand).toHaveBeenCalledOnce()
      expect(bridge.submitCommand).toHaveBeenCalledWith(expect.objectContaining({
        threadId: 'thread-one',
        kind: 'thread.prompt',
        payload: { text: 'Here is the missing context.' },
      }))
    },
  )

  it.each(['response', 'error'] as const)(
    'keeps a newer Stop through prompt idle proof and retires it only after abort proof despite a late %s',
    async (stopOutcome) => {
      const catalog = recoveryCatalog()
      catalog.threads[0].status = 'idle'
      const snapshot = recoverySnapshot(catalog.threads[0], 'Owned prompt before Stop.')
      const stopResponse = deferred<unknown>()
      let hostEventListener: ((event: unknown) => void) | undefined
      let deviceId = ''
      const promptCommand = {
        deviceId,
        commandId: 'owned-prompt-before-stop',
        expectedHostId: 'host-local',
        threadId: 'thread-one',
        kind: 'thread.prompt',
        payload: { text: 'Owned prompt' },
        delivery: 'live_only',
        expectedExecutionGenerationId: 'generation-one',
        issuedAt: '2026-08-05T20:00:00.000Z',
      }
      const bridge = {
        bootstrap: vi.fn(() => ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
          outbox: [{
            hostId: 'host-local',
            command: { ...promptCommand, deviceId },
            state: 'awaiting_idle_proof',
            updatedAt: '2026-08-05T20:00:00.000Z',
          }],
          connection: onlineConnection(),
          appVersion: '0.1.0',
        })),
        hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
        requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
        cancel: vi.fn(() => stopResponse.promise),
        onConnectionState: vi.fn(() => () => undefined),
        onSnapshot: vi.fn(() => () => undefined),
        onHostEvent: vi.fn((listener: (event: unknown) => void) => {
          hostEventListener = listener
          return () => undefined
        }),
        onHandoffProgress: vi.fn(() => () => undefined),
      }
      const api = new NativeRendererApi(bridge)
      deviceId = (api as unknown as { deviceId: string }).deviceId
      const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
      api.subscribe((next) => published.push(next))
      await api.loadWorkbench()

      const stop = api.abortThread('thread-one')
      expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'sending', operation: 'abort' })
      hostEventListener?.({
        type: 'resident.prompt_idle_observed',
        payload: {
          hostId: 'host-local',
          deviceId,
          commandId: promptCommand.commandId,
          threadId: promptCommand.threadId,
          executionGenerationId: promptCommand.expectedExecutionGenerationId,
          status: 'completed',
          durable: true,
        },
      })
      expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'sending', operation: 'abort' })

      const stopInput = bridge.cancel.mock.calls[0]?.[0] as unknown as Record<string, unknown>

      if (stopOutcome === 'response') {
        stopResponse.resolve({ ok: true, value: {
          hostId: stopInput.expectedHostId,
          deviceId: stopInput.deviceId,
          commandId: stopInput.commandId,
          threadId: stopInput.threadId,
          executionGenerationId: stopInput.expectedExecutionGenerationId,
          status: 'running',
          durable: true,
        } })
        await expect(stop).resolves.toMatchObject({ state: 'sent' })
        expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'sent', operation: 'abort' })
      } else {
        stopResponse.reject(new Error('Late Stop transport error'))
        await expect(stop).rejects.toThrow('Late Stop transport error')
        expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'uncertain', operation: 'abort' })
      }

      hostEventListener?.({
        type: 'resident.abort_idle_observed',
        payload: {
          hostId: stopInput.expectedHostId,
          deviceId: stopInput.deviceId,
          commandId: stopInput.commandId,
          threadId: stopInput.threadId,
          executionGenerationId: stopInput.expectedExecutionGenerationId,
          status: 'completed',
          durable: true,
        },
      })
      expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'idle' })
      expect(published.at(-1)?.operations).toMatchObject({ startResidentTurn: true, stopResidentTurn: false })
    },
  )

  it.each(['response', 'error'] as const)(
    'keeps a newer stop authoritative over a delayed prompt %s and host receipt until idle',
    async (promptOutcome) => {
    const catalog = recoveryCatalog()
    catalog.threads[0].status = 'idle'
    const initialSnapshot = recoverySnapshot(catalog.threads[0], 'Idle before the prompt.')
    const promptResponse = deferred<unknown>()
    let promptCommand: Record<string, unknown> | undefined
    let snapshotListener: ((snapshot: unknown) => void) | undefined
    let hostEventListener: ((event: unknown) => void) | undefined
    const cancel = vi.fn((input: Record<string, unknown>) => ok({
      hostId: input.expectedHostId,
      deviceId: input.deviceId,
      commandId: input.commandId,
      threadId: input.threadId,
      executionGenerationId: input.expectedExecutionGenerationId,
      status: 'running',
      durable: true,
      detail: 'Stop accepted · waiting for authoritative idle proof',
    }))
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: initialSnapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      submitCommand: vi.fn((input: Record<string, unknown>) => {
        promptCommand = input
        return promptResponse.promise
      }),
      cancel,
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn((listener: (snapshot: unknown) => void) => {
        snapshotListener = listener
        return () => undefined
      }),
      onHostEvent: vi.fn((listener: (event: unknown) => void) => {
        hostEventListener = listener
        return () => undefined
      }),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    api.subscribe((next) => published.push(next))
    await api.loadWorkbench()

    const prompt = api.sendComposer({ threadId: 'thread-one', text: 'Start the exact resident turn.' })
    expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'sending', operation: 'prompt' })

    const activeSnapshot = structuredClone(initialSnapshot)
    activeSnapshot.generatedAt = '2026-08-05T20:00:02.000Z'
    activeSnapshot.thread = {
      ...activeSnapshot.thread,
      status: 'running',
      updatedAt: activeSnapshot.generatedAt,
    }
    activeSnapshot.latestCursor = { ...activeSnapshot.latestCursor, sequence: 2 }
    activeSnapshot.thread.lastKnownCursor = { ...activeSnapshot.latestCursor }
    activeSnapshot.runtime = {
      ...activeSnapshot.runtime,
      isStreaming: true,
      queuedActionCount: 1,
    }
    snapshotListener?.(activeSnapshot)
    expect(published.at(-1)?.operations.stopResidentTurn).toBe(true)

    await expect(api.abortThread('thread-one')).resolves.toMatchObject({
      state: 'sent',
      message: 'Stop accepted · waiting for authoritative idle proof',
    })
    const stopCommand = cancel.mock.calls[0]?.[0]
    expect(Date.parse(String(stopCommand?.issuedAt))).toBeGreaterThan(
      Date.parse(String(promptCommand?.issuedAt)),
    )
    expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'sent', operation: 'abort' })
    expect(published.at(-1)?.operations.stopResidentTurn).toBe(false)

    hostEventListener?.({
      type: 'command.receipt',
      payload: {
        hostId: promptCommand?.expectedHostId,
        deviceId: promptCommand?.deviceId,
        commandId: promptCommand?.commandId,
        threadId: promptCommand?.threadId,
        executionGenerationId: promptCommand?.expectedExecutionGenerationId,
        status: 'running',
        durable: true,
        detail: 'Delayed prompt running receipt',
      },
    })
    expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'sent', operation: 'abort' })

    if (promptOutcome === 'response') {
      promptResponse.resolve({
        ok: true,
        value: {
          hostId: promptCommand?.expectedHostId,
          deviceId: promptCommand?.deviceId,
          commandId: promptCommand?.commandId,
          threadId: promptCommand?.threadId,
          executionGenerationId: promptCommand?.expectedExecutionGenerationId,
          status: 'running',
          durable: true,
          detail: 'Delayed direct prompt response',
        },
      })
      await expect(prompt).resolves.toMatchObject({ state: 'sent' })
    } else {
      promptResponse.reject(new Error('Delayed prompt transport failure'))
      await expect(prompt).rejects.toThrow('Delayed prompt transport failure')
    }
    expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'sent', operation: 'abort' })
    await expect(api.abortThread('thread-one')).resolves.toMatchObject({ state: 'rejected' })
    expect(cancel).toHaveBeenCalledOnce()

    const idleSnapshot = structuredClone(activeSnapshot)
    idleSnapshot.generatedAt = '2026-08-05T20:00:03.000Z'
    idleSnapshot.thread = {
      ...idleSnapshot.thread,
      status: 'idle',
      updatedAt: idleSnapshot.generatedAt,
    }
    idleSnapshot.latestCursor = { ...idleSnapshot.latestCursor, sequence: 3 }
    idleSnapshot.thread.lastKnownCursor = { ...idleSnapshot.latestCursor }
    idleSnapshot.runtime = {
      ...idleSnapshot.runtime,
      isStreaming: false,
      queuedActionCount: 0,
    }
    snapshotListener?.(idleSnapshot)
    expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'sent', operation: 'abort' })
    expect(published.at(-1)?.operations).toMatchObject({ startResidentTurn: false, stopResidentTurn: false })
    hostEventListener?.({
      type: 'resident.abort_idle_observed',
      payload: {
        hostId: stopCommand?.expectedHostId,
        deviceId: stopCommand?.deviceId,
        commandId: stopCommand?.commandId,
        threadId: stopCommand?.threadId,
        executionGenerationId: stopCommand?.expectedExecutionGenerationId,
        status: 'completed',
        durable: true,
      },
    })
    expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'idle' })
    expect(published.at(-1)?.operations).toMatchObject({ startResidentTurn: true, stopResidentTurn: false })
    },
  )

  it('suppresses delayed G1 snapshots and receipts after the same host advances the thread to G2', async () => {
    const catalogG1 = recoveryCatalog()
    const threadG1 = catalogG1.threads[0]
    threadG1.status = 'idle'
    const snapshotG1 = recoverySnapshot(threadG1, 'Generation one transcript.')
    const threadG2 = {
      ...threadG1,
      currentLocation: { ...threadG1.currentLocation, executionGenerationId: 'generation-next' },
      updatedAt: '2026-08-05T20:00:02.000Z',
    }
    const catalogG2 = { ...catalogG1, threads: [threadG2, catalogG1.threads[1]] }
    const snapshotG2 = recoverySnapshot(threadG2, 'Generation two transcript.')
    const submission = deferred<unknown>()
    let submitted: Record<string, unknown> | undefined
    let deviceId = ''
    let snapshotListener: ((snapshot: unknown) => void) | undefined
    let hostEventListener: ((event: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog: catalogG1, lastSnapshot: snapshotG1 },
        outbox: [{
          hostId: 'host-local',
          command: {
            deviceId,
            commandId: 'older-generation-outbox',
            expectedHostId: 'host-local',
            threadId: 'thread-one',
            kind: 'thread.follow_up',
            payload: { text: 'Older queued work' },
            delivery: 'send_when_reconnected',
            expectedExecutionGenerationId: 'generation-one',
            issuedAt: '2026-08-05T20:00:00.000Z',
          },
          state: 'uncertain',
          updatedAt: '2026-08-05T20:00:00.000Z',
        }],
        quarantinedOutboxCount: 0,
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      submitCommand: vi.fn((input: Record<string, unknown>) => {
        submitted = input
        return submission.promise
      }),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn((listener: (snapshot: unknown) => void) => {
        snapshotListener = listener
        return () => undefined
      }),
      onHostEvent: vi.fn((listener: (event: unknown) => void) => {
        hostEventListener = listener
        return () => undefined
      }),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    deviceId = (api as unknown as { deviceId: string }).deviceId
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()

    const sending = api.sendComposer({
      threadId: 'thread-one',
      text: 'Continue G1',
    })
    expect(submitted).toMatchObject({ expectedExecutionGenerationId: 'generation-one' })

    snapshotListener?.(catalogG2)
    expect(published.at(-1)?.operations.submitCommands).toBe(false)
    expect(published.at(-1)?.composerReceipt.state).toBe('idle')
    snapshotListener?.(snapshotG1)
    expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-one')?.transcript).toEqual([])
    snapshotListener?.(snapshotG2)
    expect(published.at(-1)?.operations.submitCommands).toBe(true)
    expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-one')?.transcript[0]?.body).toBe('Generation two transcript.')

    submission.resolve({
      ok: true,
      value: {
        hostId: submitted?.expectedHostId,
        deviceId: submitted?.deviceId,
        commandId: submitted?.commandId,
        threadId: submitted?.threadId,
        executionGenerationId: submitted?.expectedExecutionGenerationId,
        status: 'admitted',
        durable: true,
      },
    })
    await expect(sending).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })

    hostEventListener?.({
      type: 'command.receipt',
      payload: {
        hostId: submitted?.expectedHostId,
        deviceId: submitted?.deviceId,
        commandId: submitted?.commandId,
        threadId: submitted?.threadId,
        executionGenerationId: submitted?.expectedExecutionGenerationId,
        status: 'admitted',
        durable: true,
      },
    })
    expect(published.at(-1)?.composerReceipt.state).toBe('idle')
    expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-one')?.transcript[0]?.body).toBe('Generation two transcript.')

    const delayedThreadG1 = {
      ...threadG1,
      updatedAt: '2026-08-05T20:00:04.000Z',
    }
    const delayedCatalogG1 = {
      ...catalogG1,
      generatedAt: '2026-08-05T20:00:04.000Z',
      threads: [delayedThreadG1, catalogG1.threads[1]],
    }
    snapshotListener?.(delayedCatalogG1)
    snapshotListener?.(recoverySnapshot(delayedThreadG1, 'Delayed generation one transcript.'))
    expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-one')?.executionGenerationId).toBe('generation-next')
    expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-one')?.transcript[0]?.body).toBe('Generation two transcript.')
    unsubscribe()
  })

  it('keeps a same-connection G2 event authoritative over a delayed G1 bootstrap', async () => {
    const catalogG1 = recoveryCatalog()
    const threadG1 = catalogG1.threads[0]
    const snapshotG1 = recoverySnapshot(threadG1, 'Bootstrap generation one.')
    const threadG2 = {
      ...threadG1,
      currentLocation: { ...threadG1.currentLocation, executionGenerationId: 'generation-bootstrap-g2' },
      updatedAt: '2026-08-05T20:00:02.000Z',
    }
    const catalogG2 = {
      ...catalogG1,
      generatedAt: '2026-08-05T20:00:02.000Z',
      threads: [threadG2, catalogG1.threads[1]],
    }
    const snapshotG2 = recoverySnapshot(threadG2, 'Event generation two wins.')
    const bootstrap = deferred<unknown>()
    let connectionListener: ((state: unknown) => void) | undefined
    let snapshotListener: ((snapshot: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => bootstrap.promise),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn((listener: (state: unknown) => void) => {
        connectionListener = listener
        return () => undefined
      }),
      onSnapshot: vi.fn((listener: (snapshot: unknown) => void) => {
        snapshotListener = listener
        return () => undefined
      }),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const deviceId = (api as unknown as { deviceId: string }).deviceId
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    connectionListener?.(onlineConnection())
    const loading = api.loadWorkbench()

    snapshotListener?.(catalogG2)
    snapshotListener?.(snapshotG2)
    bootstrap.resolve({
      ok: true,
      value: {
        cache: { version: 2, projectionHostId: 'host-local', catalog: catalogG1, lastSnapshot: snapshotG1 },
        outbox: [{
          hostId: 'host-local',
          command: {
            deviceId,
            commandId: 'bootstrap-race-command',
            expectedHostId: 'host-local',
            threadId: 'thread-one',
            kind: 'thread.follow_up',
            payload: { text: 'Preserve pending work' },
            delivery: 'send_when_reconnected',
            expectedExecutionGenerationId: 'generation-bootstrap-g2',
            issuedAt: '2026-08-05T20:00:02.000Z',
          },
          state: 'uncertain',
          updatedAt: '2026-08-05T20:00:02.000Z',
        }],
        quarantinedOutboxCount: 2,
        connection: onlineConnection(),
        appVersion: '0.1.0',
      },
    })
    const loaded = await loading

    expect(loaded.threads.find((thread) => thread.id === 'thread-one')?.executionGenerationId).toBe('generation-bootstrap-g2')
    expect(loaded.threads.find((thread) => thread.id === 'thread-one')?.transcript[0]?.body).toBe('Event generation two wins.')
    expect(loaded.composerReceipt.state).toBe('uncertain')
    expect(loaded.attention).toContainEqual(expect.objectContaining({ id: 'native-quarantined-outbox' }))
    expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-one')?.transcript[0]?.body).toBe('Event generation two wins.')
    unsubscribe()
  })

  it('does not let a delayed refresh snapshot overwrite the generation that advanced while awaiting it', async () => {
    const catalogG2 = recoveryCatalog()
    const threadG2 = catalogG2.threads[0]
    const snapshotG2 = recoverySnapshot(threadG2, 'Refresh generation two.')
    const threadG3 = {
      ...threadG2,
      currentLocation: { ...threadG2.currentLocation, executionGenerationId: 'generation-refresh-g3' },
      updatedAt: '2026-08-05T20:00:03.000Z',
    }
    const catalogG3 = {
      ...catalogG2,
      generatedAt: '2026-08-05T20:00:03.000Z',
      threads: [threadG3, catalogG2.threads[1]],
    }
    const snapshotG3 = recoverySnapshot(threadG3, 'Refresh generation three wins.')
    const request = deferred<unknown>()
    let snapshotListener: ((snapshot: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog: catalogG2, lastSnapshot: snapshotG2 },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => ok(catalogG2)),
      requestSnapshot: vi.fn(() => request.promise),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn((listener: (snapshot: unknown) => void) => {
        snapshotListener = listener
        return () => undefined
      }),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    await api.loadWorkbench()
    await vi.waitFor(() => expect(bridge.requestSnapshot).toHaveBeenCalledOnce())

    snapshotListener?.(catalogG3)
    snapshotListener?.(snapshotG3)
    request.resolve({ ok: true, value: snapshotG2 })
    await vi.waitFor(() => {
      expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-one')?.transcript[0]?.body)
        .toBe('Refresh generation three wins.')
    })
    expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-one')?.executionGenerationId).toBe('generation-refresh-g3')
    unsubscribe()
  })

  it.each(['success', 'failure'] as const)(
    'does not restore or apply a delayed G2 selection %s after the catalog advances to G3',
    async (outcome) => {
      const catalogG2 = recoveryCatalog()
      const threadG2 = catalogG2.threads[0]
      const snapshotG2 = recoverySnapshot(threadG2, 'Selection generation two.')
      const threadG3 = {
        ...threadG2,
        currentLocation: { ...threadG2.currentLocation, executionGenerationId: 'generation-selection-g3' },
        updatedAt: '2026-08-05T20:00:03.000Z',
      }
      const catalogG3 = {
        ...catalogG2,
        generatedAt: '2026-08-05T20:00:03.000Z',
        threads: [threadG3, catalogG2.threads[1]],
      }
      const snapshotG3 = recoverySnapshot(threadG3, 'Selection generation three wins.')
      const request = deferred<unknown>()
      let snapshotListener: ((snapshot: unknown) => void) | undefined
      const bridge = {
        bootstrap: vi.fn(() => ok({
          cache: { version: 2, projectionHostId: 'host-local', catalog: catalogG2, lastSnapshot: snapshotG2 },
          outbox: [],
          quarantinedOutboxCount: 0,
          connection: onlineConnection(),
          appVersion: '0.1.0',
        })),
        hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
        requestSnapshot: vi.fn(() => request.promise),
        onConnectionState: vi.fn(() => () => undefined),
        onSnapshot: vi.fn((listener: (snapshot: unknown) => void) => {
          snapshotListener = listener
          return () => undefined
        }),
        onHostEvent: vi.fn(() => () => undefined),
        onHandoffProgress: vi.fn(() => () => undefined),
      }
      const api = new NativeRendererApi(bridge)
      const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
      const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
      await api.loadWorkbench()
      const selection = api.selectThread('thread-one')
      await vi.waitFor(() => expect(bridge.requestSnapshot).toHaveBeenCalledOnce())
      snapshotListener?.(catalogG3)
      snapshotListener?.(snapshotG3)
      if (outcome === 'success') request.resolve({ ok: true, value: snapshotG2 })
      else request.reject(new Error('Delayed G2 selection failed'))
      await expect(selection).resolves.toBeUndefined()

      expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-one')?.executionGenerationId)
        .toBe('generation-selection-g3')
      expect(published.at(-1)?.threads.find((thread) => thread.id === 'thread-one')?.transcript[0]?.body)
        .toBe('Selection generation three wins.')
      unsubscribe()
    },
  )

  it('keeps conflicting hydrated command fingerprints visible and ignores an old receipt', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Current transcript.')
    let deviceId = ''
    let hostEventListener: ((event: unknown) => void) | undefined
    const command = {
      deviceId,
      commandId: 'hydrated-fingerprint-conflict',
      expectedHostId: 'host-local',
      threadId: 'thread-one',
      kind: 'thread.follow_up',
      payload: { text: 'First immutable command' },
      delivery: 'send_when_reconnected',
      expectedExecutionGenerationId: 'generation-one',
      issuedAt: '2026-08-05T20:00:00.000Z',
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [
          { hostId: 'host-local', command: { ...command, deviceId }, state: 'uncertain', updatedAt: command.issuedAt },
          {
            hostId: 'host-local',
            command: { ...command, deviceId, issuedAt: '2026-08-05T20:00:01.000Z' },
            state: 'uncertain',
            updatedAt: '2026-08-05T20:00:01.000Z',
          },
        ],
        quarantinedOutboxCount: 0,
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn((listener: (event: unknown) => void) => {
        hostEventListener = listener
        return () => undefined
      }),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    deviceId = (api as unknown as { deviceId: string }).deviceId
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((view) => published.push(view))
    const loaded = await api.loadWorkbench()
    expect(loaded.composerReceipt.state).toBe('uncertain')

    hostEventListener?.({
      type: 'command.receipt',
      payload: {
        hostId: 'host-local',
        deviceId,
        commandId: command.commandId,
        threadId: command.threadId,
        executionGenerationId: command.expectedExecutionGenerationId,
        status: 'admitted',
        durable: true,
      },
    })
    expect((api as unknown as { projection?: { composerReceipt: { state: string } } }).projection?.composerReceipt.state)
      .toBe('uncertain')
    expect((api as unknown as { outbox: unknown[] }).outbox).toHaveLength(2)
    unsubscribe()
  })

  it('does not reintroduce a retired generation after a complete catalog drops its thread', async () => {
    const catalogG1 = recoveryCatalog()
    const snapshotG1 = recoverySnapshot(catalogG1.threads[0], 'Generation one.')
    let snapshotListener: ((snapshot: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog: catalogG1, lastSnapshot: snapshotG1 },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn((listener: (snapshot: unknown) => void) => {
        snapshotListener = listener
        return () => undefined
      }),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((view) => published.push(view))
    await api.loadWorkbench()
    const withoutThreadOne = {
      ...catalogG1,
      generatedAt: '2026-08-05T20:00:02.000Z',
      threads: [catalogG1.threads[1]],
    }
    snapshotListener?.(withoutThreadOne)
    expect(published.at(-1)?.threads.some((thread) => thread.id === 'thread-one')).toBe(false)
    snapshotListener?.({
      ...catalogG1,
      generatedAt: '2026-08-05T20:00:04.000Z',
      threads: [{ ...catalogG1.threads[0], updatedAt: '2026-08-05T20:00:04.000Z' }, catalogG1.threads[1]],
    })
    expect(published.at(-1)?.threads.some((thread) => thread.id === 'thread-one')).toBe(false)
    unsubscribe()
  })

  it('accepts a new resident cursor generation with a reset sequence and rejects the retired cursor', async () => {
    const catalog = recoveryCatalog()
    const snapshotA = recoverySnapshot(catalog.threads[0], 'Cursor A at sequence 100.')
    snapshotA.latestCursor.generation = 'cursor-a'
    snapshotA.latestCursor.sequence = 100
    snapshotA.thread.lastKnownCursor = { ...snapshotA.latestCursor }
    let snapshotListener: ((snapshot: unknown) => void) | undefined
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshotA },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn((listener: (snapshot: unknown) => void) => {
        snapshotListener = listener
        return () => undefined
      }),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    api.subscribe((view) => published.push(view))
    await api.loadWorkbench()

    const snapshotB = structuredClone(snapshotA)
    snapshotB.generatedAt = '2026-08-05T20:00:02.000Z'
    snapshotB.thread.updatedAt = snapshotB.generatedAt
    snapshotB.latestCursor = { ...snapshotB.latestCursor, generation: 'cursor-b', sequence: 0 }
    snapshotB.thread.lastKnownCursor = { ...snapshotB.latestCursor }
    snapshotB.materializedRecentBlocks[0]!.text = 'Cursor B at sequence 0.'
    snapshotListener?.(snapshotB)
    expect(published.at(-1)?.threads[0]?.transcript[0]?.body).toBe('Cursor B at sequence 0.')

    const delayedA = structuredClone(snapshotA)
    delayedA.generatedAt = '2026-08-05T20:00:03.000Z'
    delayedA.thread.updatedAt = delayedA.generatedAt
    delayedA.latestCursor.sequence = 101
    delayedA.thread.lastKnownCursor = { ...delayedA.latestCursor }
    delayedA.materializedRecentBlocks[0]!.text = 'Retired cursor A must not return.'
    snapshotListener?.(delayedA)
    expect(published.at(-1)?.threads[0]?.transcript[0]?.body).toBe('Cursor B at sequence 0.')

    const snapshotB1 = structuredClone(snapshotB)
    snapshotB1.generatedAt = '2026-08-05T20:00:04.000Z'
    snapshotB1.thread.updatedAt = snapshotB1.generatedAt
    snapshotB1.latestCursor.sequence = 1
    snapshotB1.thread.lastKnownCursor = { ...snapshotB1.latestCursor }
    snapshotB1.materializedRecentBlocks[0]!.text = 'Cursor B at sequence 1.'
    snapshotListener?.(snapshotB1)
    expect(published.at(-1)?.threads[0]?.transcript[0]?.body).toBe('Cursor B at sequence 1.')
  })

  it('surfaces parseable legacy commands as held instead of composer work', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Current transcript.')
    const api = new NativeRendererApi({
      bootstrap: () => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 2,
        connection: onlineConnection(),
        appVersion: '0.1.0',
      }),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    })

    const view = await api.loadWorkbench()
    expect(view.attention).toContainEqual(expect.objectContaining({
      id: 'native-quarantined-outbox',
      title: '2 older or invalid commands are held locally and won’t be sent automatically',
    }))
    expect(view.composerReceipt.state).toBe('idle')
  })

  it('preserves a host-durable uncertainty diagnostic for operator recovery', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Current transcript.')
    const api = new NativeRendererApi({
      bootstrap: () => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [{
          state: 'uncertain',
          hostId: 'host-local',
          command: {
            kind: 'thread.abort',
            expectedHostId: 'host-local',
            deviceId: 'device-local',
            commandId: 'command-restart-uncertain',
            threadId: 'thread-one',
            expectedExecutionGenerationId: 'generation-one',
            issuedAt: '2026-08-05T20:00:00.000Z',
          },
        }],
        quarantinedOutboxCount: 0,
        durableUncertainReceipts: [{
          hostId: 'host-local',
          deviceId: 'device-local',
          commandId: 'command-restart-uncertain',
          threadId: 'thread-one',
          executionGenerationId: 'generation-one',
          status: 'uncertain',
          durable: true,
          error: {
            code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN',
            message: 'The Prime Agent outcome cannot be proven after the host process identity changed',
            retryable: false,
            diagnosticId: 'resident-dispatch-diagnostic-1',
          },
        }],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      }),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    })

    const view = await api.loadWorkbench()
    const exactCommandAttention = view.attention.filter((item) =>
      item.id.endsWith('command-restart-uncertain')
    )
    expect(exactCommandAttention).toHaveLength(1)
    expect(exactCommandAttention[0]).toEqual(expect.objectContaining({
      id: 'durable-uncertain-command-restart-uncertain',
      diagnostic: {
        code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN',
        message: 'The Prime Agent outcome cannot be proven after the host process identity changed',
        retryable: false,
        diagnosticId: 'resident-dispatch-diagnostic-1',
      },
    }))
  })

  it('retires only the exact durable resident diagnostic when completed Stop proof arrives', async () => {
    const catalog = recoveryCatalog()
    catalog.threads[0].status = 'idle'
    const snapshot = recoverySnapshot(catalog.threads[0], 'Waiting for exact Stop proof.')
    snapshot.thread.status = 'idle'
    let deviceId = ''
    let hostEventListener: ((event: unknown) => void) | undefined
    const commandId = 'uncertain-stop-with-diagnostic'
    const exactIdentity = {
      hostId: 'host-local',
      deviceId,
      commandId,
      threadId: 'thread-one',
      executionGenerationId: 'generation-one',
    }
    const bridge = {
      bootstrap: vi.fn(() => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [{
          state: 'awaiting_abort_idle_proof',
          hostId: 'host-local',
          command: {
            kind: 'thread.cancel',
            expectedHostId: 'host-local',
            deviceId,
            commandId,
            threadId: 'thread-one',
            expectedExecutionGenerationId: 'generation-one',
            issuedAt: '2026-08-05T20:00:00.000Z',
          },
        }],
        durableUncertainReceipts: [{
          ...exactIdentity,
          deviceId,
          status: 'uncertain',
          durable: true,
          error: {
            code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN',
            message: 'The Stop outcome requires exact reconciliation.',
            retryable: false,
            diagnosticId: 'diagnostic-stop-proof',
          },
        }],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      })),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn((listener: (event: unknown) => void) => {
        hostEventListener = listener
        return () => undefined
      }),
      onHandoffProgress: vi.fn(() => () => undefined),
    }
    const api = new NativeRendererApi(bridge)
    deviceId = (api as unknown as { deviceId: string }).deviceId
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    api.subscribe((view) => published.push(view))

    const retained = await api.loadWorkbench()
    expect(retained.attention.filter((item) => item.id.endsWith(commandId))).toEqual([
      expect.objectContaining({
        id: `durable-uncertain-${commandId}`,
        diagnostic: expect.objectContaining({ diagnosticId: 'diagnostic-stop-proof' }),
      }),
    ])
    expect(retained.composerReceipt).toMatchObject({ state: 'sent', operation: 'abort' })
    expect(retained.operations).toMatchObject({ startResidentTurn: false, stopResidentTurn: false })

    hostEventListener?.({
      type: 'resident.abort_idle_observed',
      payload: {
        hostId: 'host-local',
        deviceId,
        commandId,
        threadId: 'thread-one',
        executionGenerationId: 'generation-one',
        status: 'completed',
        durable: true,
      },
    })

    expect(published.at(-1)?.attention.some((item) => item.id.endsWith(commandId))).toBe(false)
    expect(published.at(-1)?.composerReceipt.state).toBe('idle')
    expect(published.at(-1)?.operations).toMatchObject({ startResidentTurn: true, stopResidentTurn: false })
  })

  it('surfaces current background-thread uncertainty and rejects a stale generation', async () => {
    const catalog = recoveryCatalog()
    const snapshot = recoverySnapshot(catalog.threads[0], 'Current transcript.')
    const durableReceipt = (commandId: string, executionGenerationId: string) => ({
      hostId: 'host-local',
      deviceId: 'device-local',
      commandId,
      threadId: 'thread-two',
      executionGenerationId,
      status: 'uncertain',
      durable: true,
      error: {
        code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN',
        message: 'The Prime Agent outcome cannot be proven after the host process identity changed',
        retryable: false,
        diagnosticId: `diagnostic-${commandId}`,
      },
    })
    const api = new NativeRendererApi({
      bootstrap: () => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: snapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        durableUncertainReceipts: [
          durableReceipt('background-current', 'generation-two'),
          durableReceipt('background-stale', 'generation-two-retired'),
        ],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      }),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    })

    const view = await api.loadWorkbench()
    expect(view.selectedThreadId).toBe('thread-one')
    expect(view.attention).toContainEqual(expect.objectContaining({
      id: 'durable-uncertain-background-current',
      threadId: 'thread-two',
      hostName: 'This computer',
    }))
    expect(view.attention).not.toContainEqual(expect.objectContaining({
      id: 'durable-uncertain-background-stale',
    }))
  })

  it('indexes uncertain commands by the exact host, thread, and generation tuple', async () => {
    const catalog = recoveryCatalog()
    const localThread = catalog.threads[0]
    localThread.currentLocation.executionGenerationId = 'shared-generation'
    const remoteThread = structuredClone(localThread)
    remoteThread.currentLocation = {
      hostId: 'host-remote',
      projectId: 'project-remote',
      workspaceId: 'workspace-remote',
      executionGenerationId: 'shared-generation',
    }
    remoteThread.title = 'Remote duplicate thread identity'
    catalog.threads = [localThread, remoteThread]
    const snapshot = recoverySnapshot(localThread, 'Exact local transcript.')
    const api = new NativeRendererApi({
      bootstrap: () => ok({
        cache: {
          version: 3,
          activeHostId: 'host-local',
          entries: {
            'host-local': { hostId: 'host-local', catalog, lastSnapshot: snapshot },
            'host-remote': { hostId: 'host-remote', catalog },
          },
        },
        outbox: [{
          state: 'uncertain',
          hostId: 'host-local',
          command: {
            kind: 'thread.prompt',
            expectedHostId: 'host-local',
            deviceId: 'device-local',
            commandId: 'local-exact-outbox',
            threadId: 'thread-one',
            expectedExecutionGenerationId: 'shared-generation',
            issuedAt: '2026-08-05T20:00:00.000Z',
          },
        }],
        durableUncertainReceipts: [
          {
            hostId: 'host-remote',
            deviceId: 'device-remote',
            commandId: 'remote-exact-receipt',
            threadId: 'thread-one',
            executionGenerationId: 'shared-generation',
            status: 'uncertain',
            durable: true,
            error: {
              code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN',
              message: 'Remote exact outcome is unknown.',
              retryable: false,
            },
          },
          {
            hostId: 'host-remote',
            deviceId: 'device-remote',
            commandId: 'remote-stale-receipt',
            threadId: 'thread-one',
            executionGenerationId: 'retired-generation',
            status: 'uncertain',
            durable: true,
            error: {
              code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN',
              message: 'Retired generation must not correlate.',
              retryable: false,
            },
          },
        ],
        connection: onlineConnection(),
        appVersion: '0.1.0',
      }),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn(() => () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    })

    const view = await api.loadWorkbench()
    const localRendererThread = view.threads.find((thread) => thread.hostId === 'host-local')
    const remoteRendererThread = view.threads.find((thread) => thread.hostId === 'host-remote')
    expect(localRendererThread?.id).not.toBe(remoteRendererThread?.id)
    expect(view.attention).toContainEqual(expect.objectContaining({
      id: 'resident-uncertain-local-exact-outbox',
      threadId: localRendererThread?.id,
      hostName: 'This computer',
    }))
    expect(view.attention).toContainEqual(expect.objectContaining({
      id: 'durable-uncertain-remote-exact-receipt',
      threadId: remoteRendererThread?.id,
      hostName: 'devbox',
    }))
    expect(view.attention).not.toContainEqual(expect.objectContaining({
      id: 'durable-uncertain-remote-stale-receipt',
    }))
  })

  it('keeps a non-retryable Stop uncertainty blocked across generic cursor activity', async () => {
    const catalog = recoveryCatalog()
    const initialSnapshot = recoverySnapshot(catalog.threads[0], 'Active resident turn.')
    let snapshotListener: ((snapshot: unknown) => void) | undefined
    const cancel = vi.fn((input: Record<string, unknown>) => ok({
      hostId: input.expectedHostId,
      deviceId: input.deviceId,
      commandId: input.commandId,
      threadId: input.threadId,
      executionGenerationId: input.expectedExecutionGenerationId,
      status: 'uncertain',
      durable: true,
      detail: 'The Stop outcome is unknown and was not replayed.',
      error: {
        code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN',
        message: 'The Stop outcome cannot be proven after restart',
        retryable: false,
        diagnosticId: 'abort-attempt-1',
      },
    }))
    const api = new NativeRendererApi({
      bootstrap: () => ok({
        cache: { version: 2, projectionHostId: 'host-local', catalog, lastSnapshot: initialSnapshot },
        outbox: [],
        quarantinedOutboxCount: 0,
        connection: onlineConnection(),
        appVersion: '0.1.0',
      }),
      hostCatalog: vi.fn(() => new Promise<never>(() => undefined)),
      requestSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
      cancel,
      onConnectionState: vi.fn(() => () => undefined),
      onSnapshot: vi.fn((listener: (snapshot: unknown) => void) => {
        snapshotListener = listener
        return () => undefined
      }),
      onHostEvent: vi.fn(() => () => undefined),
      onHandoffProgress: vi.fn(() => () => undefined),
    })
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    api.subscribe((next) => published.push(next))
    await api.loadWorkbench()

    await expect(api.abortThread('thread-one')).resolves.toMatchObject({
      state: 'uncertain',
      retryable: false,
    })
    expect(published.at(-1)?.operations.stopResidentTurn).toBe(false)
    expect(published.at(-1)?.composerReceipt).toMatchObject({
      state: 'uncertain',
      operation: 'abort',
      retryable: false,
    })
    await expect(api.abortThread('thread-one')).resolves.toMatchObject({ state: 'rejected' })
    expect(cancel).toHaveBeenCalledOnce()

    const advancedActiveSnapshot = structuredClone(initialSnapshot)
    advancedActiveSnapshot.generatedAt = '2026-08-05T20:00:02.000Z'
    advancedActiveSnapshot.latestCursor.sequence = 2
    advancedActiveSnapshot.thread.lastKnownCursor = advancedActiveSnapshot.latestCursor
    snapshotListener?.(advancedActiveSnapshot)
    expect(published.at(-1)?.operations.stopResidentTurn).toBe(false)
    expect(published.at(-1)?.composerReceipt).toMatchObject({ state: 'uncertain', operation: 'abort' })
    await expect(api.abortThread('thread-one')).resolves.toMatchObject({ state: 'rejected' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function singleHostCatalog(hostId: string, displayName: string, threadId: string, projectId: string) {
  const base = recoveryCatalog()
  const host = { ...base.hosts[0], hostId, displayName }
  const project = { ...base.projects[0], hostId, projectId, workspaceId: `workspace-${hostId}` }
  const thread = {
    ...base.threads[0],
    threadId,
    projectIdentity: projectId,
    currentLocation: {
      hostId,
      projectId,
      workspaceId: `workspace-${hostId}`,
      executionGenerationId: `generation-${hostId}`,
    },
  }
  return { ...base, hosts: undefined, host, projects: [project], threads: [thread] }
}

function sshActivationCatalog(generationPrefix: string, generatedAt: string) {
  const base = recoveryCatalog()
  const host = {
    ...base.hosts[1],
    hostId: 'host-b',
    displayName: 'Build computer',
    kind: 'ssh',
    reachability: 'online',
    connectionPaths: [{ kind: 'ssh', priority: 0, state: 'available', latencyMs: 18 }],
  }
  const project = {
    ...base.projects[0],
    projectId: 'project-b',
    hostId: 'host-b',
    workspaceId: 'workspace-b',
  }
  const threads = base.threads.map((thread) => ({
    ...thread,
    projectIdentity: 'project-b',
    updatedAt: generatedAt,
    currentLocation: {
      hostId: 'host-b',
      projectId: 'project-b',
      workspaceId: 'workspace-b',
      executionGenerationId: `${generationPrefix}-${thread.threadId}`,
    },
  }))
  return {
    snapshotVersion: 1,
    generatedAt,
    host,
    projects: [project],
    threads,
  }
}

function twoHostActivationCache() {
  const catalogA = singleHostCatalog('host-a', 'Host A', 'thread-a', 'project-a')
  const baseB = singleHostCatalog('host-b', 'Host B', 'thread-b', 'project-b')
  const catalogB = {
    ...baseB,
    host: {
      ...baseB.host,
      kind: 'ssh',
      connectionPaths: [{ kind: 'ssh', priority: 0, state: 'available', latencyMs: 20 }],
    },
  }
  const snapshotA = recoverySnapshot(catalogA.threads[0], 'Authoritative A transcript.')
  const snapshotB = recoverySnapshot(catalogB.threads[0], 'Cached B transcript.')
  const connectionA = {
    phase: 'online',
    target: { kind: 'local' },
    hostId: 'host-a',
    path: 'local_socket',
    since: '2026-08-05T20:00:00.000Z',
    attempt: 1,
    capabilities: ['prime_agent_commands_v2'],
  }
  const connectionB = {
    phase: 'online',
    target: { kind: 'ssh', alias: 'private-config-name' },
    hostId: 'host-b',
    path: 'ssh',
    since: '2026-08-05T20:01:00.000Z',
    attempt: 2,
    capabilities: ['prime_agent_commands_v2'],
  }
  const cache = {
    version: 3,
    activeHostId: 'host-a',
    entries: {
      'host-a': { hostId: 'host-a', catalog: catalogA, lastSnapshot: snapshotA },
      'host-b': { hostId: 'host-b', catalog: catalogB, lastSnapshot: snapshotB },
    },
  }
  return { catalogA, catalogB, snapshotA, snapshotB, connectionA, connectionB, cache }
}
