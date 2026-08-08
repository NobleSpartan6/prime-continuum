import { describe, expect, it, vi } from 'vitest'
import { NativeRendererApi } from '../../src/renderer/src/api'

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
      context: { usedTokens: 12_000, maxTokens: 100_000 },
    },
    pendingAttention: [],
    git: { branch: 'main', stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
    evidence: { testsPassed: 0, testsFailed: 0, artifactCount: 0 },
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
  }
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

  it('keeps non-empty retained work reports when live session telemetry is absent', async () => {
    const catalog = recoveryCatalog()
    const snapshot = {
      ...recoverySnapshot(catalog.threads[0], 'Persisted work remains available.'),
      runtime: undefined,
      childAgents: [{ agentId: 'persisted-agent', title: 'Persisted helper', state: 'waiting' }],
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
    expect(projected.agents).toEqual([expect.objectContaining({ name: 'Persisted helper', status: 'waiting' })])
    expect(projected.runtime.goals).toEqual([
      expect.objectContaining({ objective: 'Finish First durable thread', state: 'active' }),
    ])
    expect(projected.runtime.schedules).toEqual([
      expect.objectContaining({ label: 'Review verification', state: 'active' }),
    ])
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
    await expect(api.provisionResident(request)).rejects.toThrow(/durable outcome must be checked/i)
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
