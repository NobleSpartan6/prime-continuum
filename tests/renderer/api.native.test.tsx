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
  return {
    snapshotVersion: 1,
    generatedAt: '2026-08-05T20:00:01.000Z',
    thread,
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
      queuedActionCount: 2,
      activeToolNames: [],
      context: { usedTokens: 12_000, maxTokens: 100_000 },
    },
    pendingAttention: [],
    git: { branch: 'main', stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
    evidence: { testsPassed: 0, testsFailed: 0, artifactCount: 0 },
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
  }
}

describe('NativeRendererApi', () => {
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
      childAgents: [],
      pendingAttention: [],
      git: { branch: 'main', stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
      evidence: { testsPassed: 0, testsFailed: 0, artifactCount: 0 },
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
    expect(calls).toEqual(['bootstrap', 'connect', 'hostCatalog', 'requestSnapshot'])
    expect(bridge.connect).toHaveBeenCalledWith({ kind: 'local' })
    unsubscribe()
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
    const bridge = {
      bootstrap: vi.fn(() =>
        ok({
          cache: { version: 1, catalog, lastSnapshot: firstSnapshot },
          outbox: [
            {
              command: { commandId: 'command-one', threadId: 'thread-one' },
              state: 'waiting_for_connection',
              updatedAt: '2026-08-05T20:00:00.000Z',
            },
            {
              command: { commandId: 'command-two', threadId: 'thread-two' },
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
    const published: Array<Awaited<ReturnType<typeof api.loadWorkbench>>> = []
    const unsubscribe = api.subscribe((snapshot) => published.push(snapshot))
    const cached = await api.loadWorkbench()
    expect(cached.composerReceipt.state).toBe('waiting_for_connection')
    await vi.waitFor(() => expect(bridge.requestSnapshot).toHaveBeenCalled())

    hostEventListener?.({
      type: 'command.receipt',
      payload: { commandId: 'command-one', status: 'admitted', durable: true },
    })
    expect(published.at(-1)?.composerReceipt.state).toBe('sent')

    await api.selectThread('thread-two')
    hostEventListener?.({
      type: 'command.receipt',
      payload: { commandId: 'command-two', status: 'uncertain', durable: false },
    })
    expect(published.at(-1)?.composerReceipt.state).toBe('uncertain')

    await api.selectThread('thread-one')
    expect(published.at(-1)?.composerReceipt.state).toBe('idle')
    unsubscribe()
  })

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
      intent: 'follow_up',
      sendWhenReconnected: false,
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
    expect(cached.threads.find((thread) => thread.id === 'thread-b')?.transcript[0]?.body).toBe('Cached transcript B.')

    snapshotListener?.({ ...catalogA, host: { ...catalogA.host, displayName: 'Stale A overwrite' } })
    expect(cached.hosts.find((host) => host.id === 'host-a')?.name).toBe('Host A')

    const refreshedB = { ...catalogB, host: { ...catalogB.host, displayName: 'Host B refreshed' } }
    snapshotListener?.(refreshedB)
    expect(published.at(-1)?.hosts.find((host) => host.id === 'host-b')?.name).toBe('Host B refreshed')
    expect(published.at(-1)?.hosts.find((host) => host.id === 'host-a')?.name).toBe('Host A')

    await api.selectThread('thread-a')
    expect(bridge.requestSnapshot).not.toHaveBeenCalled()
    await expect(api.sendComposer({
      threadId: 'thread-a',
      text: 'Must not cross to B',
      intent: 'follow_up',
      sendWhenReconnected: true,
    })).rejects.toMatchObject({ code: 'STALE_HOST_AUTHORITY' })
    expect(bridge.submitCommand).not.toHaveBeenCalled()
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
          connection: onlineConnection(),
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
