import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from 'electron'
import type { ClientCommand, OutboxEntry } from '../../src/main/control/contracts'

const { connectLocalHostd, connectSshHost } = vi.hoisted(() => ({
  connectLocalHostd: vi.fn(),
  connectSshHost: vi.fn()
}))

vi.mock('../../src/main/control/local-hostd', () => ({
  connectSshHost,
  ensureAndConnectLocalHostd: connectLocalHostd,
  localHostdEndpoint: () => 'test-endpoint'
}))

import { DesktopControlService } from '../../src/main/control/service'
import { ControlError } from '../../src/main/control/errors'

const temporaryDirectories: string[] = []

class TestConnection extends EventEmitter {
  isClosed = false
  terminatedWith?: unknown
  readonly requests: Array<{ method: string; params: unknown; options?: unknown }> = []

  constructor(private readonly respond: (method: string, params: unknown) => unknown) {
    super()
  }

  async request(method: string, params: unknown, options?: unknown): Promise<unknown> {
    this.requests.push({ method, params, options })
    return this.respond(method, params)
  }

  close(): void {
    if (this.isClosed) return
    this.isClosed = true
  }

  terminate(error: unknown): void {
    this.terminatedWith = error
    this.close()
  }
}

beforeEach(() => {
  connectLocalHostd.mockReset()
  connectSshHost.mockReset()
})

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('DesktopControlService recovery', () => {
  it('loads independent bootstrap ledgers concurrently without weakening the authority snapshot', async () => {
    const directory = await createUserData({})
    const service = new DesktopControlService({ app: testApp(directory) })
    const stores = service as unknown as {
      commandIdentities: { read: () => Promise<unknown> }
      durableUncertainReceipts: { read: () => Promise<unknown> }
      cache: { read: () => Promise<unknown> }
      outbox: { read: () => Promise<unknown> }
      residentLifecycleLedger: { read: () => Promise<unknown> }
    }
    const initialRelease = deferred<void>()
    const initialStarts: string[] = []
    const holdInitial = async <T>(name: string, value: T): Promise<T> => {
      initialStarts.push(name)
      await initialRelease.promise
      return value
    }

    stores.commandIdentities.read = vi.fn(async () =>
      await holdInitial('command-identities', { version: 1, entries: [] })
    )
    stores.durableUncertainReceipts.read = vi.fn(async () =>
      await holdInitial('uncertain-receipts', { version: 1, entries: [] })
    )
    stores.cache.read = vi.fn(async () =>
      await holdInitial('projection-cache', { version: 3, entries: {}, targetHostBindings: [] })
    )
    stores.outbox.read = vi.fn(async () =>
      await holdInitial('outbox', [])
    )
    stores.residentLifecycleLedger.read = vi.fn(async () =>
      await holdInitial('resident-lifecycle', { version: 1, entries: [] })
    )

    const bootstrapPromise = service.bootstrap()
    await Promise.resolve()
    const initialSnapshot = [...initialStarts]
    initialRelease.resolve()

    await expect(bootstrapPromise).resolves.toMatchObject({
      cache: { version: 3, entries: {}, targetHostBindings: [] },
      outbox: [],
      durableUncertainReceipts: [],
      residentLifecycleOperations: [],
      connection: { phase: 'offline' },
    })
    expect(new Set(initialSnapshot)).toEqual(new Set([
      'command-identities',
      'uncertain-receipts',
      'projection-cache',
      'outbox',
      'resident-lifecycle',
    ]))
    expect(stores.commandIdentities.read).toHaveBeenCalledTimes(1)
  })

  it('does not return a pre-reconciliation outbox after the same host becomes online', async () => {
    const command = prompt('device-a', 'bootstrap-reconciled-prompt')
    const retained = {
      hostId: 'host-a',
      command,
      state: 'awaiting_idle_proof' as const,
      updatedAt: timestamp,
    }
    const directory = await createUserData({ cache: verifiedCache('host-a'), outbox: [retained] })
    const service = new DesktopControlService({ app: testApp(directory) })
    const internals = service as unknown as {
      target?: { kind: 'local' }
      authorityHostId?: string
      setState: (state: unknown) => void
      outbox: { read: () => Promise<unknown[]> }
    }
    const firstRead = deferred<void>()
    const releaseFirstRead = deferred<void>()
    let readCount = 0
    internals.outbox.read = vi.fn(async () => {
      readCount += 1
      if (readCount === 1) {
        firstRead.resolve()
        await releaseFirstRead.promise
        return [retained]
      }
      return []
    })

    const bootstrap = service.bootstrap()
    await firstRead.promise
    internals.target = { kind: 'local' }
    internals.authorityHostId = 'host-a'
    internals.setState({
      phase: 'online',
      target: { kind: 'local' },
      hostId: 'host-a',
      path: 'local_socket',
      since: timestamp,
      attempt: 1,
      capabilities: ['prime_agent_commands_v2'],
    })
    releaseFirstRead.resolve()

    await expect(bootstrap).resolves.toMatchObject({
      connection: { phase: 'online', hostId: 'host-a' },
      outbox: [],
    })
    expect(internals.outbox.read).toHaveBeenCalledTimes(2)
  })

  it('restores the persisted last target during bootstrap and can reconnect to it', async () => {
    const directory = await createUserData({
      cache: {
        version: 1,
        lastTarget: { kind: 'local' },
        lastTargetUpdatedAt: '2026-08-05T12:00:00.000Z'
      }
    })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      if (method === 'command.reconcile') return { receipts: [], unknown: [] }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })

    const bootstrap = await service.bootstrap()

    expect(bootstrap.connection).toMatchObject({
      phase: 'offline',
      target: { kind: 'local' },
      since: '2026-08-05T12:00:00.000Z'
    })
    await expect(service.reconnect()).resolves.toMatchObject({
      phase: 'online',
      target: { kind: 'local' },
      path: 'local_socket'
    })
    expect(connectLocalHostd).toHaveBeenCalledOnce()
  })

  it('publishes only valid capabilities from the verified host health handshake', async () => {
    const directory = await createUserData({})
    const connection = new TestConnection((method) => {
      if (method === 'health.get') {
        return {
          ...health(),
          capabilities: ['prime_agent_commands_v2', 'invalid capability', 'prime_agent_commands_v2'],
        }
      }
      if (method === 'command.reconcile') return { receipts: [], unknown: [] }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })

    await service.bootstrap()
    await expect(service.connect({ kind: 'local' })).resolves.toMatchObject({
      phase: 'online',
      capabilities: ['prime_agent_commands_v2'],
    })
  })

  it('never downgrades v2 command delivery to a legacy v1 host capability', async () => {
    const queued = followUp('device-a', 'legacy-reconcile-blocked')
    const directory = await createUserData({ outbox: [waiting(queued)] })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') {
        return { ...health(), capabilities: ['prime_agent_commands_v1'] }
      }
      throw new Error(`A legacy command host must not receive ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })

    await expect(service.connect({ kind: 'local' })).resolves.toMatchObject({
      phase: 'online',
      capabilities: ['prime_agent_commands_v1'],
    })
    await expect(service.submitCommand(followUp('device-a', 'legacy-capability-blocked'))).rejects.toMatchObject({
      code: 'command.capability_unavailable',
    })

    expect(connection.requests.map((request) => request.method)).toEqual(['health.get'])
    expect((await service.bootstrap()).outbox).toEqual([
      expect.objectContaining({ command: expect.objectContaining({ commandId: queued.commandId }) }),
    ])
  })

  it('keeps the bound authority and its capabilities when a replacement binding cannot persist', async () => {
    const directory = await createUserData({ cache: verifiedCache('host-a') })
    const connectionA = new TestConnection((method) => {
      if (method === 'health.get') return { ...health('host-a'), capabilities: ['old_authority_v1'] }
      throw new Error(`Unexpected Host A request: ${method}`)
    })
    const connectionB = new TestConnection((method) => {
      if (method === 'health.get') return { ...health('host-b'), capabilities: ['new_authority_v1'] }
      throw new Error(`Unexpected Host B request: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(connectionA).mockResolvedValueOnce(connectionB)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.bootstrap()
    await expect(service.reconnect()).resolves.toMatchObject({
      phase: 'online',
      hostId: 'host-a',
      capabilities: ['old_authority_v1'],
    })

    const cacheStore = (service as unknown as {
      cache: { update: (...args: unknown[]) => Promise<unknown> }
    }).cache
    cacheStore.update = vi.fn(async () => {
      throw new Error('Binding write failed')
    })

    await expect(service.reconnect()).rejects.toThrow('Binding write failed')
    expect(service.getConnectionState()).toMatchObject({
      phase: 'offline',
      hostId: 'host-a',
      capabilities: ['old_authority_v1'],
    })
  })

  it('leaves a live same-target connection and its health poll intact when attempt persistence fails', async () => {
    const directory = await createUserData({})
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })
    const internals = service as unknown as {
      cache: { update: (...args: unknown[]) => Promise<unknown> }
      healthPollTimer?: NodeJS.Timeout
      reconnectGeneration: number
    }
    const originalTimer = internals.healthPollTimer
    const originalGeneration = internals.reconnectGeneration
    internals.cache.update = vi.fn(async () => { throw new Error('Attempt write failed') })

    await expect(service.connect({ kind: 'local' })).rejects.toThrow('Attempt write failed')

    expect(connection.isClosed).toBe(false)
    expect(internals.healthPollTimer).toBe(originalTimer)
    expect(internals.reconnectGeneration).toBe(originalGeneration)
    expect(service.getConnectionState()).toMatchObject({
      phase: 'online',
      target: { kind: 'local' },
      hostId: 'host-a',
      capabilities: ['prime_agent_commands_v2'],
    })
    await service.disconnect()
  })

  it('leaves the previous target authoritative when a target-switch attempt cannot persist', async () => {
    const directory = await createUserData({})
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })
    ;(service as unknown as { discoveredAliases: Set<string> }).discoveredAliases.add('remote')
    const internals = service as unknown as {
      cache: { update: (...args: unknown[]) => Promise<unknown> }
      healthPollTimer?: NodeJS.Timeout
      reconnectGeneration: number
    }
    const originalTimer = internals.healthPollTimer
    const originalGeneration = internals.reconnectGeneration
    internals.cache.update = vi.fn(async () => { throw new Error('Attempt write failed') })

    await expect(service.connect({ kind: 'ssh', alias: 'remote' })).rejects.toThrow('Attempt write failed')

    expect(connectSshHost).not.toHaveBeenCalled()
    expect(connection.isClosed).toBe(false)
    expect(internals.healthPollTimer).toBe(originalTimer)
    expect(internals.reconnectGeneration).toBe(originalGeneration)
    expect(service.getConnectionState()).toMatchObject({
      phase: 'online',
      target: { kind: 'local' },
      hostId: 'host-a',
      capabilities: ['prime_agent_commands_v2'],
    })
    await service.disconnect()
  })

  it('replays only explicitly queued follow-ups the host marks unknown for the exact identity', async () => {
    const replayable = followUp('device-a', 'replay-me')
    const uncertain = followUp('device-a', 'uncertain-command')
    const mismatchedDevice = followUp('device-a', 'wrong-device')
    const omittedByHost = followUp('device-a', 'not-mentioned')
    const notExplicit = { ...followUp('device-a', 'live-only'), delivery: 'live_only' as const }
    const outbox: OutboxEntry[] = [
      waiting(replayable),
      { hostId: uncertain.expectedHostId, command: uncertain, state: 'uncertain', updatedAt: timestamp },
      waiting(mismatchedDevice),
      waiting(omittedByHost),
      waiting(notExplicit)
    ]
    const directory = await createUserData({ outbox })
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health()
      if (method === 'command.reconcile') {
        const command = ((params as { commands: ClientCommand[] }).commands[0])
        if (!command) throw new Error('Expected one exact reconciliation envelope')
        const unknown = command.commandId === replayable.commandId
          ? [{ deviceId: replayable.deviceId, commandId: replayable.commandId }]
          : command.commandId === uncertain.commandId
            ? [{ deviceId: uncertain.deviceId, commandId: uncertain.commandId }]
            : command.commandId === mismatchedDevice.commandId
              ? [{ deviceId: 'different-device', commandId: mismatchedDevice.commandId }]
              : command.commandId === notExplicit.commandId
                ? [{ deviceId: notExplicit.deviceId, commandId: notExplicit.commandId }]
                : []
        return {
          receipts: [],
          unknown,
        }
      }
      if (method === 'command.submit') {
        return commandReceipt(replayable)
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })

    await service.connect({ kind: 'local' })

    const submissions = connection.requests.filter((request) => request.method === 'command.submit')
    expect(submissions).toHaveLength(1)
    expect(submissions[0]?.params).toMatchObject({
      command: {
        deviceId: replayable.deviceId,
        commandId: replayable.commandId,
        threadId: replayable.threadId,
        issuedAt: replayable.issuedAt,
        expectedExecutionGenerationId: replayable.expectedExecutionGenerationId,
        command: { kind: 'follow_up', text: 'Follow up' }
      }
    })
    expect((await service.bootstrap()).outbox.map((entry) => entry.command.commandId)).toEqual([
      uncertain.commandId,
      mismatchedDevice.commandId,
      omittedByHost.commandId,
      notExplicit.commandId
    ])
  })

  it('delivers a restart-hydrated waiting follow-up and emits its receipt before publishing online', async () => {
    const replayable = followUp('device-a', 'restart-follow-up')
    const directory = await createUserData({
      cache: {
        version: 1,
        lastTarget: { kind: 'local' },
        lastTargetUpdatedAt: timestamp
      },
      outbox: [waiting(replayable)]
    })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      if (method === 'command.reconcile') {
        return {
          receipts: [],
          unknown: [{ deviceId: replayable.deviceId, commandId: replayable.commandId }]
        }
      }
      if (method === 'command.submit') {
        return commandReceipt(replayable)
      }
      if (method === 'catalog.snapshot') return catalog()
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const timeline: string[] = []
    let receiptDelivered = false
    let onlineObservedAfterDelivery = false
    let authoritativeRefresh: Promise<unknown> | undefined
    service.on('host-event', (event: { type?: string }) => {
      if (event.type !== 'command.receipt') return
      receiptDelivered = true
      timeline.push('receipt')
    })
    service.on('connection-state', (state: { phase: string }) => {
      timeline.push(`state:${state.phase}`)
      if (state.phase !== 'online') return
      onlineObservedAfterDelivery = receiptDelivered
      // This mirrors the renderer's authoritative refresh trigger on online.
      // The request must not begin until queued delivery and its receipt event.
      authoritativeRefresh = service.hostCatalog()
    })

    await service.bootstrap()
    await expect(service.reconnect()).resolves.toMatchObject({ phase: 'online' })
    await authoritativeRefresh

    expect(onlineObservedAfterDelivery).toBe(true)
    expect(timeline).toEqual(['state:reconnecting', 'receipt', 'state:online'])
    expect(connection.requests.map((request) => request.method)).toEqual([
      'health.get',
      'command.reconcile',
      'command.submit',
      'catalog.snapshot'
    ])
  })

  it('keeps a verified connection online while a failed reconciliation remains uncertain', async () => {
    const queued = followUp('device-a', 'blocked-follow-up')
    const directory = await createUserData({
      cache: {
        version: 1,
        lastTarget: { kind: 'local' },
        lastTargetUpdatedAt: timestamp
      },
      outbox: [waiting(queued)]
    })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      if (method === 'command.reconcile') throw new Error('reconciliation unavailable')
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const phases: string[] = []
    let authoritativeRefreshTriggered = false
    service.on('connection-state', (state: { phase: string }) => {
      phases.push(state.phase)
      if (state.phase === 'online') authoritativeRefreshTriggered = true
    })

    await service.bootstrap()
    await expect(service.reconnect()).resolves.toMatchObject({ phase: 'online' })

    expect(phases).toEqual(['reconnecting', 'online'])
    expect(authoritativeRefreshTriggered).toBe(true)
    expect(connection.requests.map((request) => request.method)).toEqual(['health.get', 'command.reconcile'])
    expect((await service.bootstrap()).outbox).toEqual([
      expect.objectContaining({ command: queued, state: 'uncertain' }),
    ])
  })

  it('never discloses or replays Host A outbox identities after Host B becomes authoritative', async () => {
    const queuedForA = followUp('device-a', 'host-a-follow-up', 'host-a')
    const directory = await createUserData({ outbox: [waiting(queuedForA)] })
    const connectionB = new TestConnection((method) => {
      if (method === 'health.get') return health('host-b')
      throw new Error(`Host B must not receive Host A method: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connectionB)
    const service = new DesktopControlService({ app: testApp(directory) })

    await expect(service.connect({ kind: 'local' })).resolves.toMatchObject({
      phase: 'online',
      hostId: 'host-b'
    })

    expect(connectionB.requests.map((request) => request.method)).toEqual(['health.get'])
    expect((await service.bootstrap()).outbox).toEqual([])
    expect((await readStoredOutbox(directory)).map((entry) => entry.command.commandId)).toEqual([
      queuedForA.commandId
    ])
    await expect(service.submitCommand(queuedForA)).rejects.toMatchObject({
      code: 'command.host_authority_changed'
    })
    expect(connectionB.requests.map((request) => request.method)).toEqual(['health.get'])
  })

  it('refuses an offline follow-up until a destination host identity has been verified', async () => {
    const directory = await createUserData({})
    const service = new DesktopControlService({ app: testApp(directory) })

    await expect(service.submitCommand(followUp('device-a', 'unscoped-follow-up'))).rejects.toMatchObject({
      code: 'command.host_identity_required'
    })
    expect((await service.bootstrap()).outbox).toEqual([])
  })

  it('activates the newest private SSH binding using only its immutable host identity', async () => {
    const directory = await createUserData({
      cache: verifiedSshCache('host-a', 'current-devbox', ['retired-devbox'])
    })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      throw new Error(`Unexpected activation request: ${method}`)
    })
    connectSshHost.mockReturnValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    authorizeSshAlias(service, 'current-devbox')

    await expect(service.activateVerifiedSshHost('host-a')).resolves.toMatchObject({
      phase: 'online',
      hostId: 'host-a',
      target: { kind: 'ssh', alias: 'current-devbox' },
      path: 'ssh',
    })

    expect(connectSshHost).toHaveBeenCalledWith('current-devbox', 'ssh')
    expect(connection.requests.map(({ method }) => method)).toEqual(['health.get'])
  })

  it('requires an existing verified SSH binding before activation and never accepts a local binding as a substitute', async () => {
    const directory = await createUserData({ cache: verifiedCache('host-a') })
    const service = new DesktopControlService({ app: testApp(directory) })

    await expect(service.activateVerifiedSshHost('host-a')).rejects.toMatchObject({
      code: 'ssh.verified_host_binding_required',
      details: { expectedHostId: 'host-a' },
    })
    expect(connectSshHost).not.toHaveBeenCalled()
  })

  it('closes an SSH candidate whose health identity differs without rebinding or reconciling it', async () => {
    const directory = await createUserData({ cache: verifiedSshCache('host-a', 'devbox') })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-b')
      throw new Error(`A mismatched host must not receive ${method}`)
    })
    const reconnectCandidate = new TestConnection((method) => {
      if (method === 'health.get') return health('host-b')
      throw new Error(`A mismatched reconnect must not receive ${method}`)
    })
    connectSshHost.mockReturnValueOnce(connection).mockReturnValueOnce(reconnectCandidate)
    const service = new DesktopControlService({ app: testApp(directory) })
    authorizeSshAlias(service, 'devbox')

    await expect(service.activateVerifiedSshHost('host-a')).rejects.toMatchObject({
      code: 'ssh.host_identity_mismatch',
      details: { expectedHostId: 'host-a', receivedHostId: 'host-b' },
    })

    expect(connection.isClosed).toBe(true)
    expect(connection.requests.map(({ method }) => method)).toEqual(['health.get'])
    expect(service.getConnectionState()).toMatchObject({ phase: 'offline', hostId: 'host-a' })
    await expect(service.reconnect()).rejects.toMatchObject({
      code: 'ssh.host_identity_mismatch',
      details: { expectedHostId: 'host-a', receivedHostId: 'host-b' },
    })
    expect(reconnectCandidate.isClosed).toBe(true)
    expect(reconnectCandidate.requests.map(({ method }) => method)).toEqual(['health.get'])
    const bootstrap = await service.bootstrap()
    expect(bootstrap.cache).toMatchObject({
      projectionHostId: 'host-a',
      targetHostBindings: [expect.objectContaining({ hostId: 'host-a' })],
    })
    expect(JSON.stringify(bootstrap.cache)).not.toContain('host-b')
  })

  it('keeps the immutable SSH identity fence across automatic reconnect', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      const directory = await createUserData({ cache: verifiedSshCache('host-a', 'devbox') })
      const initial = new TestConnection((method) => {
        if (method === 'health.get') return health('host-a')
        throw new Error(`Unexpected initial request: ${method}`)
      })
      const replacement = new TestConnection((method) => {
        if (method === 'health.get') return health('host-b')
        throw new Error(`A mismatched automatic reconnect must not receive ${method}`)
      })
      connectSshHost.mockReturnValueOnce(initial).mockReturnValueOnce(replacement)
      const service = new DesktopControlService({ app: testApp(directory) })
      authorizeSshAlias(service, 'devbox')
      await service.activateVerifiedSshHost('host-a')

      initial.isClosed = true
      initial.emit('close', new ControlError('transport.closed', 'The SSH transport closed.', { retryable: true }))
      expect(service.getConnectionState()).toMatchObject({ phase: 'reconnecting', hostId: 'host-a' })
      await vi.advanceTimersByTimeAsync(500)

      expect(replacement.isClosed).toBe(true)
      expect(replacement.requests.map(({ method }) => method)).toEqual(['health.get'])
      expect(service.getConnectionState()).toMatchObject({
        phase: 'offline',
        hostId: 'host-a',
        error: { code: 'ssh.host_identity_mismatch' },
      })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(connectSshHost).toHaveBeenCalledTimes(2)
      expect(JSON.stringify((await service.bootstrap()).cache)).not.toContain('host-b')
      await service.disconnect()
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })

  it('does not let a superseded stale handshake poison the winning SSH binding across restart', async () => {
    const queuedForA = followUp('device-a', 'stale-bind-must-not-reconcile', 'host-a')
    const directory = await createUserData({ outbox: [waiting(queuedForA)] })
    const staleA = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      throw new Error(`The superseded Host A handshake must not receive ${method}`)
    })
    const winnerB = new TestConnection((method) => {
      if (method === 'health.get') return health('host-b')
      throw new Error(`The winning Host B connection must not receive Host A ${method}`)
    })
    const restartedB = new TestConnection((method) => {
      if (method === 'health.get') return health('host-b')
      throw new Error(`Restarted Host B must not receive Host A ${method}`)
    })
    connectSshHost
      .mockReturnValueOnce(staleA)
      .mockReturnValueOnce(winnerB)
      .mockReturnValueOnce(restartedB)
    const service = new DesktopControlService({ app: testApp(directory) })
    authorizeSshAlias(service, 'devbox')
    const cacheStore = (service as unknown as {
      cache: { update: (updater: (current: unknown) => unknown) => Promise<unknown> }
    }).cache
    const originalUpdate = cacheStore.update.bind(cacheStore)
    const staleBindRelease = deferred<void>()
    let updateCount = 0
    let staleBindStarted!: () => void
    const staleBindWaiting = new Promise<void>((resolve) => { staleBindStarted = resolve })
    cacheStore.update = async (updater) => {
      updateCount += 1
      if (updateCount === 2) {
        staleBindStarted()
        await staleBindRelease.promise
      }
      return await originalUpdate(updater)
    }

    const staleConnect = service.connect({ kind: 'ssh', alias: 'devbox' })
    await staleBindWaiting
    await expect(service.connect({ kind: 'ssh', alias: 'devbox' })).resolves.toMatchObject({
      phase: 'online',
      hostId: 'host-b',
    })
    staleBindRelease.resolve()
    await expect(staleConnect).rejects.toMatchObject({ code: 'connection.superseded' })

    expect(staleA.requests.map(({ method }) => method)).toEqual(['health.get'])
    expect(winnerB.requests.map(({ method }) => method)).toEqual(['health.get'])
    expect(service.getConnectionState()).toMatchObject({ phase: 'online', hostId: 'host-b' })
    const winningCache = await service.bootstrap()
    expect(winningCache.cache).toMatchObject({
      projectionHostId: 'host-b',
      targetHostBindings: [expect.objectContaining({
        target: { kind: 'ssh', alias: 'devbox' },
        hostId: 'host-b',
      })],
    })
    expect(JSON.stringify(winningCache.cache)).not.toContain('host-a')
    expect(await readStoredOutbox(directory)).toEqual([
      expect.objectContaining({ hostId: 'host-a', command: expect.objectContaining({ commandId: queuedForA.commandId }) }),
    ])
    await service.disconnect()

    const restarted = new DesktopControlService({ app: testApp(directory) })
    await expect(restarted.bootstrap()).resolves.toMatchObject({
      connection: { phase: 'offline', hostId: 'host-b', target: { kind: 'ssh', alias: 'devbox' } },
      outbox: [],
    })
    await expect(restarted.reconnect()).resolves.toMatchObject({ phase: 'online', hostId: 'host-b' })
    expect(restartedB.requests.map(({ method }) => method)).toEqual(['health.get'])
    expect(await readStoredOutbox(directory)).toEqual([
      expect.objectContaining({ hostId: 'host-a', command: expect.objectContaining({ commandId: queuedForA.commandId }) }),
    ])
    await restarted.disconnect()
  })

  it('reconciles an uncertain live-only remote prompt after activation without replaying the mutation', async () => {
    const uncertainPrompt = prompt('device-a', 'dropped-remote-prompt', 'host-a')
    const directory = await createUserData({
      cache: verifiedSshCache('host-a', 'devbox'),
      outbox: [{ hostId: 'host-a', command: uncertainPrompt, state: 'uncertain', updatedAt: timestamp }],
    })
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.reconcile') {
        expect(params).toMatchObject({
          expectedHostId: 'host-a',
          commands: [expect.objectContaining({
            deviceId: uncertainPrompt.deviceId,
            commandId: uncertainPrompt.commandId,
            expectedExecutionGenerationId: uncertainPrompt.expectedExecutionGenerationId,
          })],
        })
        return {
          receipts: [],
          unknown: [{ deviceId: uncertainPrompt.deviceId, commandId: uncertainPrompt.commandId }],
        }
      }
      throw new Error(`An uncertain live-only prompt must not invoke ${method}`)
    })
    connectSshHost.mockReturnValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    authorizeSshAlias(service, 'devbox')

    await expect(service.activateVerifiedSshHost('host-a')).resolves.toMatchObject({ phase: 'online', hostId: 'host-a' })
    expect(connection.requests.map(({ method }) => method)).toEqual(['health.get', 'command.reconcile'])
    expect(connection.requests.some(({ method }) => method === 'command.submit')).toBe(false)
    await service.disconnect()
    expect((await service.bootstrap()).outbox).toEqual([
      expect.objectContaining({
        state: 'uncertain',
        command: expect.objectContaining({ commandId: uncertainPrompt.commandId }),
      }),
    ])
  })

  it('feature-gates native dialogs and submits an exact response with urgent priority', async () => {
    const directory = await createUserData({})
    const command = extensionUiResponse('device-a', 'extension-ui-submit')
    const oldHost = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      throw new Error(`An old host must not receive ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(oldHost)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })
    await expect(service.submitCommand(command)).rejects.toMatchObject({
      code: 'command.extension_ui_capability_unavailable',
    })
    expect((await service.bootstrap()).outbox).toEqual([])
    await service.disconnect()

    const newHost = new TestConnection((method, params) => {
      if (method === 'health.get') {
        return { ...health('host-a'), capabilities: ['prime_agent_commands_v2', 'resident_extension_ui_v1'] }
      }
      if (method === 'command.submit') {
        expect(params).toMatchObject({
          command: {
            command: {
              kind: 'extension_ui.respond',
              requestId: 'dialog-one',
              requestDigest: 'a'.repeat(64),
              method: 'select',
              response: { kind: 'value', value: 'A' },
            },
          },
        })
        return commandReceipt(command)
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(newHost)
    await service.connect({ kind: 'local' })
    await expect(service.submitCommand(command)).resolves.toMatchObject({ status: 'completed' })
    expect(newHost.requests.find(({ method }) => method === 'command.submit')?.options).toEqual({ priority: 'urgent' })
    expect((await service.bootstrap()).outbox).toEqual([])
    await service.disconnect()
  })

  it('never replays an unknown live-only dialog response after reconnect', async () => {
    const command = extensionUiResponse('device-a', 'extension-ui-unknown')
    const directory = await createUserData({
      cache: verifiedCache('host-a'),
      outbox: [{ hostId: 'host-a', command, state: 'uncertain', updatedAt: timestamp }],
    })
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') {
        return { ...health('host-a'), capabilities: ['prime_agent_commands_v2', 'resident_extension_ui_v1'] }
      }
      if (method === 'command.reconcile') {
        expect(params).toMatchObject({ commands: [expect.objectContaining({ commandId: command.commandId })] })
        return { receipts: [], unknown: [{ deviceId: command.deviceId, commandId: command.commandId }] }
      }
      throw new Error(`An unknown dialog response must not invoke ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })

    await service.bootstrap()
    await service.reconnect()
    expect(connection.requests.map(({ method }) => method)).toEqual(['health.get', 'command.reconcile'])
    expect(connection.requests.some(({ method }) => method === 'command.submit')).toBe(false)
    expect((await service.bootstrap()).outbox).toEqual([])
    await service.disconnect()
  })

  it('rejects a method-mismatched dialog response before persistence or transport', async () => {
    const directory = await createUserData({ cache: verifiedCache('host-a') })
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.bootstrap()
    await expect(service.submitCommand({
      ...extensionUiResponse('device-a', 'extension-ui-invalid'),
      payload: {
        requestId: 'dialog-one',
        requestDigest: 'a'.repeat(64),
        method: 'confirm',
        response: { kind: 'value', value: 'A' },
      },
    })).rejects.toMatchObject({ code: 'command.extension_ui_response_invalid' })
    expect((await service.bootstrap()).outbox).toEqual([])
  })

  it('replays by immutable host identity when the SSH alias has changed', async () => {
    const queued = followUp('device-a', 'renamed-alias-follow-up', 'host-a')
    const directory = await createUserData({
      cache: {
        version: 2,
        lastTarget: { kind: 'ssh', alias: 'renamed-devbox' },
        lastTargetUpdatedAt: timestamp,
        projectionHostId: 'host-a',
        catalog: catalog('host-a'),
        targetHostBindings: [
          { target: { kind: 'ssh', alias: 'old-devbox' }, hostId: 'host-a', verifiedAt: timestamp }
        ]
      },
      outbox: [waiting(queued)]
    })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.reconcile') {
        return { receipts: [], unknown: [{ deviceId: queued.deviceId, commandId: queued.commandId }] }
      }
      if (method === 'command.submit') {
        return commandReceipt(queued)
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectSshHost.mockReturnValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })

    await service.bootstrap()
    await expect(service.reconnect()).resolves.toMatchObject({
      phase: 'online',
      hostId: 'host-a',
      target: { kind: 'ssh', alias: 'renamed-devbox' }
    })
    expect(connection.requests.map((request) => request.method)).toEqual([
      'health.get',
      'command.reconcile',
      'command.submit'
    ])
    const bootstrap = await service.bootstrap()
    expect(bootstrap.outbox).toEqual([])
    expect(bootstrap.cache).toMatchObject({
      projectionHostId: 'host-a',
      catalog: { host: { hostId: 'host-a' } },
      targetHostBindings: expect.arrayContaining([
        expect.objectContaining({ target: { kind: 'ssh', alias: 'old-devbox' }, hostId: 'host-a' }),
        expect.objectContaining({ target: { kind: 'ssh', alias: 'renamed-devbox' }, hostId: 'host-a' })
      ])
    })
  })

  it('does not send an A-scoped command over B when authority changes during the outbox write', async () => {
    const directory = await createUserData({})
    const connectionA = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      throw new Error(`Unexpected Host A request: ${method}`)
    })
    const connectionB = new TestConnection((method) => {
      if (method === 'health.get') return health('host-b')
      throw new Error(`Host B must not receive the raced command: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(connectionA).mockResolvedValueOnce(connectionB)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })

    const outboxStore = (service as unknown as {
      outbox: { update: (update: (current: OutboxEntry[]) => OutboxEntry[] | Promise<OutboxEntry[]>) => Promise<OutboxEntry[]> }
    }).outbox
    const originalUpdate = outboxStore.update.bind(outboxStore)
    let releaseFirstWrite!: () => void
    let signalFirstWrite!: () => void
    const firstWriteStarted = new Promise<void>((resolve) => { signalFirstWrite = resolve })
    const firstWriteRelease = new Promise<void>((resolve) => { releaseFirstWrite = resolve })
    let delayed = false
    outboxStore.update = async (update) => {
      if (!delayed) {
        delayed = true
        signalFirstWrite()
        await firstWriteRelease
      }
      return await originalUpdate(update)
    }

    const command = followUp('device-a', 'authority-race', 'host-a')
    const submission = service.submitCommand(command)
    await firstWriteStarted
    await service.connect({ kind: 'local' })
    releaseFirstWrite()

    await expect(submission).rejects.toMatchObject({ code: 'connection.superseded' })
    expect(connectionB.requests.map((request) => request.method)).toEqual(['health.get'])
    expect((await readStoredOutbox(directory))).toEqual([
      expect.objectContaining({ hostId: 'host-a', command: expect.objectContaining({ commandId: command.commandId }) })
    ])
  })

  it('clears A projections and reconciles only valid B entries when the same target now identifies B', async () => {
    const queuedForA = followUp('device-a', 'queued-a', 'host-a')
    const queuedForB = followUp('device-b', 'queued-b', 'host-b')
    const mismatched = {
      hostId: 'host-b',
      command: followUp('device-mismatch', 'mismatched', 'host-a'),
      state: 'waiting_for_connection',
      updatedAt: timestamp
    }
    const legacy = {
      command: {
        deviceId: 'legacy-device',
        commandId: 'legacy-command',
        threadId: 'thread-1',
        kind: 'thread.follow_up',
        delivery: 'send_when_reconnected',
        payload: { text: 'Legacy follow up' }
      },
      state: 'waiting_for_connection',
      updatedAt: timestamp
    }
    const directory = await createUserData({
      cache: verifiedCache('host-a'),
      outbox: [waiting(queuedForA), waiting(queuedForB), mismatched, legacy]
    })
    const connectionB = new TestConnection((method, params) => {
      if (method === 'health.get') return health('host-b')
      if (method === 'command.reconcile') {
        expect(params).toMatchObject({
          expectedHostId: 'host-b',
          commands: [{ deviceId: queuedForB.deviceId, commandId: queuedForB.commandId }]
        })
        return {
          receipts: [],
          unknown: [{ deviceId: queuedForB.deviceId, commandId: queuedForB.commandId }]
        }
      }
      if (method === 'command.submit') {
        expect(params).toMatchObject({
          command: {
            expectedHostId: 'host-b',
            deviceId: queuedForB.deviceId,
            commandId: queuedForB.commandId
          }
        })
        return commandReceipt(queuedForB)
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connectionB)
    const service = new DesktopControlService({ app: testApp(directory) })
    const states: Array<{ phase: string; hostId?: string }> = []
    service.on('connection-state', (state: { phase: string; hostId?: string }) => states.push(state))

    const before = await service.bootstrap()
    expect(before.cache).toMatchObject({ projectionHostId: 'host-a', catalog: { host: { hostId: 'host-a' } } })
    expect(before.outbox.map((entry) => entry.command.commandId)).toEqual(['queued-a'])
    await expect(service.connect({ kind: 'local' })).resolves.toMatchObject({ phase: 'online', hostId: 'host-b' })

    expect(states).toEqual([
      expect.objectContaining({ phase: 'connecting', hostId: 'host-a' }),
      expect.objectContaining({ phase: 'connecting', hostId: 'host-b' }),
      expect.objectContaining({ phase: 'online', hostId: 'host-b' })
    ])
    const after = await service.bootstrap()
    expect(after.cache).not.toHaveProperty('catalog')
    expect(after.outbox).toEqual([])
    expect((await readStoredOutbox(directory)).map((entry) => entry.command.commandId)).toEqual([
      'queued-a',
      'mismatched',
      'legacy-command'
    ])
  })

  it('keeps device identities distinct when two devices reuse a command ID', async () => {
    const first = followUp('device-a', 'shared-command', 'host-a')
    const second = followUp('device-b', 'shared-command', 'host-a')
    const directory = await createUserData({ outbox: [waiting(first), waiting(second)] })
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.reconcile') {
        const command = (params as { commands: Array<{ deviceId: string; commandId: string }> }).commands[0]
        expect(params).toMatchObject({
          expectedHostId: 'host-a',
          commands: [{ deviceId: command?.deviceId, commandId: 'shared-command' }]
        })
        return {
          receipts: [],
          unknown: command?.deviceId === 'device-a'
            ? [{ deviceId: 'device-a', commandId: 'shared-command' }]
            : [],
        }
      }
      if (method === 'command.submit') {
        expect(params).toMatchObject({ command: { deviceId: 'device-a', commandId: 'shared-command' } })
        return commandReceipt(first)
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })

    await service.connect({ kind: 'local' })

    expect(connection.requests.filter((request) => request.method === 'command.submit')).toHaveLength(1)
    expect((await service.bootstrap()).outbox).toEqual([waiting(second)])
  })

  it('ignores delayed A snapshot events and terminates a B connection that sends an A snapshot', async () => {
    const directory = await createUserData({})
    const connectionA = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      throw new Error(`Unexpected Host A request: ${method}`)
    })
    const connectionB = new TestConnection((method) => {
      if (method === 'health.get') return health('host-b')
      throw new Error(`Unexpected Host B request: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(connectionA).mockResolvedValueOnce(connectionB)
    const service = new DesktopControlService({ app: testApp(directory) })
    const snapshots: unknown[] = []
    service.on('snapshot', (snapshot) => snapshots.push(snapshot))
    await service.connect({ kind: 'local' })
    await service.connect({ kind: 'local' })

    connectionA.emit('event', { type: 'snapshot.update', payload: catalog('host-a') })
    connectionB.emit('event', { type: 'snapshot.update', payload: catalog('host-b') })
    await vi.waitFor(() => {
      expect(snapshots).toEqual([expect.objectContaining({ host: expect.objectContaining({ hostId: 'host-b' }) })])
    })

    connectionB.emit('event', { type: 'snapshot.update', payload: catalog('host-a') })
    expect(connectionB.terminatedWith).toMatchObject({ code: 'protocol.authority_mismatch' })
    expect(snapshots).toHaveLength(1)
  })

  it('rejects a different thread snapshot before cache mutation or publication', async () => {
    const directory = await createUserData({})
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'thread.snapshot') return threadSnapshot('thread-b', 'host-a')
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const snapshots: unknown[] = []
    service.on('snapshot', (snapshot) => snapshots.push(snapshot))
    await service.connect({ kind: 'local' })

    await expect(service.requestSnapshot({ threadId: 'thread-a' })).rejects.toMatchObject({
      code: 'protocol.snapshot_thread_mismatch'
    })
    expect(snapshots).toEqual([])
    expect((await service.bootstrap()).cache).not.toHaveProperty('lastSnapshot')
  })

  it('cannot persist or emit an A snapshot after a same-target B connection supersedes its cache write', async () => {
    const directory = await createUserData({ cache: verifiedCache('host-a') })
    const connectionA = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'catalog.snapshot') {
        return { ...catalog('host-a'), host: { ...catalog('host-a').host, displayName: 'Stale Host A' } }
      }
      throw new Error(`Unexpected Host A request: ${method}`)
    })
    const connectionB = new TestConnection((method) => {
      if (method === 'health.get') return health('host-b')
      throw new Error(`Unexpected Host B request: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(connectionA).mockResolvedValueOnce(connectionB)
    const service = new DesktopControlService({ app: testApp(directory) })
    const snapshots: unknown[] = []
    service.on('snapshot', (snapshot) => snapshots.push(snapshot))
    await service.connect({ kind: 'local' })

    const cacheStore = (service as unknown as {
      cache: {
        update: (updater: (current: unknown) => unknown) => Promise<unknown>
        readHydrated: () => Promise<{ entries: Record<string, unknown> }>
      }
    }).cache
    const originalUpdate = cacheStore.update.bind(cacheStore)
    const releaseSnapshotWrite = deferred<void>()
    let pauseNextWrite = true
    let snapshotWriteStarted!: () => void
    const snapshotWriteWaiting = new Promise<void>((resolve) => { snapshotWriteStarted = resolve })
    cacheStore.update = async (updater) => {
      if (pauseNextWrite) {
        pauseNextWrite = false
        snapshotWriteStarted()
        await releaseSnapshotWrite.promise
      }
      return await originalUpdate(updater)
    }

    const staleSnapshot = service.requestSnapshot({})
    await snapshotWriteWaiting
    await service.connect({ kind: 'local' })
    releaseSnapshotWrite.resolve()

    await expect(staleSnapshot).rejects.toMatchObject({ code: 'connection.superseded' })
    expect(snapshots).toEqual([])
    const bootstrap = await service.bootstrap()
    const bootstrapCache = bootstrap.cache as { entries: Record<string, unknown> }
    expect(bootstrap.connection).toMatchObject({ phase: 'online', hostId: 'host-b' })
    expect(bootstrap.cache).not.toMatchObject({ catalog: { host: { hostId: 'host-a' } } })
    expect(bootstrapCache.entries['host-a']).toBeUndefined()
    const hostAProjectionPath = path.join(
      directory,
      'control',
      'projections',
      `${createHash('sha256').update('host-a').digest('hex')}.json`,
    )
    expect(JSON.parse(await readFile(hostAProjectionPath, 'utf8'))).toMatchObject({
      hostId: 'host-a',
      catalog: { host: { hostId: 'host-a', displayName: 'Test host' } },
    })
    expect(await cacheStore.readHydrated()).toMatchObject({
      entries: { 'host-a': { catalog: { host: { hostId: 'host-a', displayName: 'Test host' } } } }
    })
  })

  it('cannot publish stale online after disconnect supersedes an in-flight reconciliation', async () => {
    const queued = followUp('device-b', 'pending-reconcile', 'host-b')
    const directory = await createUserData({
      cache: verifiedCache('host-b'),
      outbox: [waiting(queued)]
    })
    const reconciliation = deferred<unknown>()
    let reconciliationStarted!: () => void
    const started = new Promise<void>((resolve) => { reconciliationStarted = resolve })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-b')
      if (method === 'command.reconcile') {
        reconciliationStarted()
        return reconciliation.promise
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const phases: string[] = []
    service.on('connection-state', (state: { phase: string }) => phases.push(state.phase))
    await service.bootstrap()

    const reconnect = service.reconnect()
    await started
    await service.disconnect()
    reconciliation.resolve({ receipts: [], unknown: [] })

    await expect(reconnect).rejects.toMatchObject({ code: 'connection.superseded' })
    expect(phases.at(-1)).toBe('offline')
    expect(phases).not.toContain('online')
  })

  it('retries bootstrap instead of combining A cache with a concurrent B connection', async () => {
    const queuedForA = followUp('device-a', 'bootstrap-a', 'host-a')
    const directory = await createUserData({
      cache: verifiedCache('host-a'),
      outbox: [waiting(queuedForA)]
    })
    const connectionB = new TestConnection((method) => {
      if (method === 'health.get') return health('host-b')
      throw new Error(`Host B must not receive Host A data: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connectionB)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.bootstrap()

    const outboxStore = (service as unknown as { outbox: { read: () => Promise<OutboxEntry[]> } }).outbox
    const originalRead = outboxStore.read.bind(outboxStore)
    const pausedRead = deferred<void>()
    let firstRead = true
    let firstReadStarted!: () => void
    const started = new Promise<void>((resolve) => { firstReadStarted = resolve })
    outboxStore.read = async () => {
      if (firstRead) {
        firstRead = false
        firstReadStarted()
        await pausedRead.promise
      }
      return await originalRead()
    }

    const bootstrap = service.bootstrap()
    await started
    await service.connect({ kind: 'local' })
    pausedRead.resolve()
    const payload = await bootstrap

    expect(payload.connection).toMatchObject({ phase: 'online', hostId: 'host-b' })
    expect(payload.cache).not.toHaveProperty('catalog')
    expect(payload.outbox).toEqual([])
  })

  it('keeps the last verified A target and cache when a new B attempt fails before health', async () => {
    const cache = {
      ...verifiedCache('host-a'),
      lastTarget: { kind: 'ssh', alias: 'verified-a' },
      targetHostBindings: [
        { target: { kind: 'ssh', alias: 'verified-a' }, hostId: 'host-a', verifiedAt: timestamp }
      ]
    }
    const directory = await createUserData({ cache })
    const failedConnection = new TestConnection((method) => {
      if (method === 'health.get') throw new Error('Host B did not complete its health handshake')
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(failedConnection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.bootstrap()

    await expect(service.connect({ kind: 'local' })).rejects.toThrow('Host B did not complete its health handshake')

    const restarted = new DesktopControlService({ app: testApp(directory) })
    const bootstrap = await restarted.bootstrap()
    expect(bootstrap.connection).toMatchObject({
      phase: 'offline',
      hostId: 'host-a',
      target: { kind: 'ssh', alias: 'verified-a' }
    })
    expect(bootstrap.cache).toMatchObject({
      projectionHostId: 'host-a',
      catalog: { host: { hostId: 'host-a' } }
    })
  })

  it('migrates a v2 inline projection into a hashed per-host file without losing offline bootstrap data', async () => {
    const legacySnapshot = threadSnapshot('thread-a', 'host-a')
    const directory = await createUserData({
      cache: { ...verifiedCache('host-a'), lastSnapshot: legacySnapshot, updatedAt: timestamp }
    })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })

    const beforeMigration = await service.bootstrap()
    expect(beforeMigration.cache).toMatchObject({
      version: 3,
      entries: { 'host-a': { hostId: 'host-a', lastSnapshot: { thread: { threadId: 'thread-a' } } } }
    })
    await service.reconnect()

    const storedIndex = JSON.parse(
      await readFile(path.join(directory, 'control', 'projection-cache.json'), 'utf8')
    ) as { version: number; entries: Record<string, { fileName: string }> }
    expect(storedIndex.version).toBe(3)
    expect(storedIndex.entries['host-a']?.fileName).toMatch(/^[a-f0-9]{64}\.json$/)
    expect(JSON.stringify(storedIndex)).not.toContain('lastSnapshot')
    expect(await readdir(path.join(directory, 'control', 'projections'))).toEqual([
      storedIndex.entries['host-a']?.fileName
    ])

    const restarted = new DesktopControlService({ app: testApp(directory) })
    expect((await restarted.bootstrap()).cache).toMatchObject({
      entries: {
        'host-a': {
          hostId: 'host-a',
          catalog: { host: { hostId: 'host-a' } },
          lastSnapshot: { thread: { threadId: 'thread-a' } }
        }
      }
    })
  })

  it('preserves A and B independently across a host switch and offline restart', async () => {
    let catalogB = { ...catalog('host-b'), host: { ...catalog('host-b').host, displayName: 'Host B first' } }
    const connectionA = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'catalog.snapshot') return catalog('host-a')
      if (method === 'thread.snapshot') return threadSnapshot('thread-a', 'host-a')
      throw new Error(`Unexpected Host A request: ${method}`)
    })
    const connectionB = new TestConnection((method) => {
      if (method === 'health.get') return health('host-b')
      if (method === 'catalog.snapshot') return catalogB
      if (method === 'thread.snapshot') return threadSnapshot('thread-b', 'host-b')
      throw new Error(`Unexpected Host B request: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(connectionA).mockResolvedValueOnce(connectionB)
    const directory = await createUserData({})
    const service = new DesktopControlService({ app: testApp(directory) })

    await service.connect({ kind: 'local' })
    await service.hostCatalog()
    await service.requestSnapshot({ threadId: 'thread-a' })
    await service.connect({ kind: 'local' })
    await service.hostCatalog()
    await service.requestSnapshot({ threadId: 'thread-b' })
    catalogB = { ...catalogB, host: { ...catalogB.host, displayName: 'Host B replaced' } }
    await service.hostCatalog()

    const restarted = new DesktopControlService({ app: testApp(directory) })
    const bootstrap = await restarted.bootstrap()
    const bootstrapCache = bootstrap.cache as { entries: Record<string, unknown> }
    expect(bootstrap.connection).toMatchObject({ phase: 'offline', hostId: 'host-b' })
    expect(bootstrap.cache).toMatchObject({
      version: 3,
      activeHostId: 'host-b',
      projectionHostId: 'host-b',
      entries: {
        'host-b': {
          catalog: { host: { hostId: 'host-b', displayName: 'Host B replaced' } },
          lastSnapshot: { thread: { threadId: 'thread-b' } }
        }
      }
    })
    expect(bootstrapCache.entries['host-a']).toBeUndefined()
    expect(await readdir(path.join(directory, 'control', 'projections'))).toHaveLength(2)

    const restartedCache = (restarted as unknown as {
      cache: { readHydrated: () => Promise<{ entries: Record<string, unknown> }> }
    }).cache
    expect(await restartedCache.readHydrated()).toMatchObject({
      entries: {
        'host-a': {
          catalog: { host: { hostId: 'host-a', displayName: 'Test host' } },
          lastSnapshot: { thread: { threadId: 'thread-a' } },
        },
        'host-b': {
          catalog: { host: { hostId: 'host-b', displayName: 'Host B replaced' } },
          lastSnapshot: { thread: { threadId: 'thread-b' } },
        },
      },
    })
  })

  it('fences the sanitized runtime model catalog to the verified host authority', async () => {
    const runtimeCatalog = modelCatalog()
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return { ...health('host-a'), capabilities: ['runtime_model_catalog_v1'] }
      if (method === 'runtime.model_catalog') {
        expect(params).toEqual({ expectedHostId: 'host-a' })
        return runtimeCatalog
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const directory = await createUserData({})
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })

    await expect(service.runtimeModelCatalog('host-a')).resolves.toEqual(runtimeCatalog)
    await expect(service.runtimeModelCatalog('host-b')).rejects.toMatchObject({
      code: 'runtime.model_catalog_authority_changed'
    })
    expect(connection.requests.filter(({ method }) => method === 'runtime.model_catalog')).toHaveLength(1)
  })

  it('preserves and quarantines a legacy outbox record through bootstrap, connect, put, remove, and restart', async () => {
    const legacy = {
      hostId: 'host-a',
      command: {
        deviceId: 'legacy-device',
        commandId: 'legacy-command',
        expectedHostId: 'host-a',
        threadId: 'thread-1',
        kind: 'thread.follow_up',
        delivery: 'send_when_reconnected',
        payload: { text: 'Legacy follow up' },
      },
      state: 'waiting_for_connection',
      updatedAt: timestamp,
    }
    const directory = await createUserData({ cache: verifiedCache('host-a'), outbox: [legacy] })
    const modern = { ...followUp('device-a', 'modern-command'), delivery: 'live_only' as const }
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.submit') return commandReceipt(modern)
      throw new Error(`Legacy outbox must not trigger ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })

    await expect(service.bootstrap()).resolves.toMatchObject({ outbox: [], quarantinedOutboxCount: 1 })
    await expect(service.connect({ kind: 'local' })).resolves.toMatchObject({ phase: 'online' })
    await expect(service.submitCommand(modern)).resolves.toMatchObject({ commandId: modern.commandId })
    expect(connection.requests.map(({ method }) => method)).toEqual(['health.get', 'command.submit'])
    expect(await readStoredOutbox(directory)).toEqual([legacy])

    const restarted = new DesktopControlService({ app: testApp(directory) })
    await expect(restarted.bootstrap()).resolves.toMatchObject({ outbox: [], quarantinedOutboxCount: 1 })
    expect(await readStoredOutbox(directory)).toEqual([legacy])
  })

  it.each([
    ['malformed JSON', '{not-json', 'storage.malformed_json'],
    ['a non-array root', '{"commands":[]}', 'storage.invalid_root'],
  ])('fails closed for an outbox with %s and preserves its exact bytes', async (_label, contents, code) => {
    const directory = await createUserData({ cache: verifiedCache('host-a') })
    const outboxPath = path.join(directory, 'control', 'command-outbox.json')
    await writeFile(outboxPath, contents)
    const service = new DesktopControlService({ app: testApp(directory) })

    await expect(service.bootstrap()).rejects.toMatchObject({ code })
    await expect(service.submitCommand(followUp('device-a', 'must-not-overwrite'))).rejects.toMatchObject({ code })
    await expect(
      (service as unknown as { removeOutbox(identities: unknown[]): Promise<void> }).removeOutbox([]),
    ).resolves.toBeUndefined()
    await expect(
      (service as unknown as { removeOutbox(identities: unknown[]): Promise<void> }).removeOutbox([{}]),
    ).rejects.toMatchObject({ code })
    expect(await readFile(outboxPath, 'utf8')).toBe(contents)
  })

  it('rejects missing generation or issue time before an outbox write or network request', async () => {
    const directory = await createUserData({})
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      throw new Error(`Invalid commands must not trigger ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })
    const valid = followUp('device-a', 'missing-fence')
    const { expectedExecutionGenerationId: _generation, ...withoutGeneration } = valid
    const { issuedAt: _issuedAt, ...withoutIssuedAt } = valid

    await expect(service.submitCommand(withoutGeneration as ClientCommand)).rejects.toMatchObject({
      code: 'command.execution_generation_required',
    })
    await expect(service.submitCommand(withoutIssuedAt as ClientCommand)).rejects.toMatchObject({
      code: 'command.issued_at_required',
    })
    expect(connection.requests.map(({ method }) => method)).toEqual(['health.get'])
    await expect(readStoredOutbox(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never coerces a malformed approval decision into a durable rejection', async () => {
    const invalidApproval = {
      ...followUp('device-a', 'invalid-approval-decision'),
      kind: 'approval.resolve',
      delivery: 'live_only',
      payload: { approvalId: 'approval-one', decision: 'garbage' },
    } as ClientCommand
    const directory = await createUserData({ outbox: [waiting(invalidApproval)] })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      throw new Error(`Malformed approval must not trigger ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })

    await expect(service.connect({ kind: 'local' })).resolves.toMatchObject({ phase: 'online' })
    await expect(service.bootstrap()).resolves.toMatchObject({ outbox: [], quarantinedOutboxCount: 1 })
    await expect(service.submitCommand(invalidApproval)).rejects.toMatchObject({
      code: 'command.approval_decision_invalid',
    })
    await expect(service.approve({
      deviceId: 'device-a',
      commandId: 'invalid-approval-resolution',
      expectedHostId: 'host-a',
      expectedExecutionGenerationId: 'execution-1',
      issuedAt: timestamp,
      threadId: 'thread-1',
      approvalId: 'approval-one',
      decision: 'garbage',
    } as never)).rejects.toMatchObject({ code: 'command.approval_decision_invalid' })
    expect(connection.requests.map(({ method }) => method)).toEqual(['health.get'])
    expect(await readStoredOutbox(directory)).toEqual([waiting(invalidApproval)])
  })

  it('leaves a command uncertain when a durable receipt names a different generation', async () => {
    const directory = await createUserData({})
    const command = { ...followUp('device-a', 'wrong-generation-receipt'), delivery: 'live_only' as const }
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.submit') {
        return { ...commandReceipt(command), executionGenerationId: 'execution-2' }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })

    await expect(service.submitCommand(command)).rejects.toMatchObject({
      code: 'protocol.command_receipt_identity_mismatch',
    })
    expect((await service.bootstrap()).outbox).toEqual([
      expect.objectContaining({ command, state: 'uncertain' }),
    ])
  })

  it('lets a coalesced idle proof dominate the running submit continuation without recreating the prompt outbox', async () => {
    const directory = await createUserData({})
    const command = prompt('device-a', 'coalesced-prompt-proof')
    let connection!: TestConnection
    connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.submit') {
        queueMicrotask(() => connection.emit('event', {
          type: 'resident.prompt_idle_observed',
          payload: {
            eventVersion: 1,
            attemptId: residentAttemptId(command),
            receipt: commandReceipt(command, 'completed'),
          },
        }))
        return commandReceipt(command, 'running')
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const acceptResidentPromptIdleSignal = vi.spyOn(service as unknown as {
      acceptResidentPromptIdleSignal(...args: unknown[]): Promise<void>
    }, 'acceptResidentPromptIdleSignal')
    const events: Array<{ type: string; payload: unknown }> = []
    service.on('host-event', (event) => events.push(event as { type: string; payload: unknown }))
    await service.connect({ kind: 'local' })

    await service.submitCommand(command)
    expect(acceptResidentPromptIdleSignal).toHaveBeenCalledOnce()
    await Promise.all(acceptResidentPromptIdleSignal.mock.results.map(({ value }) => value))

    expect(connection.terminatedWith).toBeUndefined()
    expect(events.filter(({ type }) => type === 'resident.prompt_idle_observed')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ commandId: command.commandId, status: 'completed' }),
      }),
    ])
    expect(await readStoredOutbox(directory)).toEqual([])
    await service.disconnect()
  })

  it('supervises exact read-only cleanup when direct resident proof wins before local cleanup fails', async () => {
    vi.useFakeTimers()
    try {
      const directory = await createUserData({})
      const command = prompt('device-a', 'direct-proof-cleanup-recovery')
      const connection = new TestConnection((method) => {
        if (method === 'health.get') return health('host-a')
        if (method === 'command.submit') return commandReceipt(command, 'completed')
        if (method === 'command.reconcile') {
          return { receipts: [commandReceipt(command, 'completed')], unknown: [] }
        }
        throw new Error(`Unexpected request: ${method}`)
      })
      connectLocalHostd.mockResolvedValue(connection)
      const service = new DesktopControlService({ app: testApp(directory) })
      await service.connect({ kind: 'local' })
      const internals = service as unknown as {
        recordDurableUncertainReceipt(receipt: Record<string, unknown>, command: ClientCommand): Promise<void>
        retireDurableUncertainReceipt(receipt: Record<string, unknown>): Promise<void>
        drainNonterminalReconciliation(): Promise<void>
      }
      await internals.recordDurableUncertainReceipt({
        ...commandReceipt(command, 'uncertain'),
        hostId: 'host-a',
        durable: true,
        error: {
          code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN',
          message: 'Seeded diagnostic must be retired by exact proof.',
          retryable: false,
          diagnosticId: 'diagnostic-direct-proof-cleanup',
        },
      }, command)
      const retireDurableUncertainReceipt = internals.retireDurableUncertainReceipt.bind(service)
      let failCleanupOnce = true
      internals.retireDurableUncertainReceipt = async (receipt) => {
        if (failCleanupOnce) {
          failCleanupOnce = false
          throw new Error('Injected post-proof diagnostic cleanup failure')
        }
        await retireDurableUncertainReceipt(receipt)
      }

      await expect(service.submitCommand(command)).resolves.toMatchObject({
        commandId: command.commandId,
        status: 'completed',
      })
      await expect(service.bootstrap()).resolves.toMatchObject({
        outbox: [expect.objectContaining({ command, state: 'uncertain' })],
        durableUncertainReceipts: [expect.objectContaining({
          commandId: command.commandId,
          error: expect.objectContaining({ diagnosticId: 'diagnostic-direct-proof-cleanup' }),
        })],
      })

      await vi.advanceTimersByTimeAsync(500)
      await internals.drainNonterminalReconciliation()
      await expect(service.bootstrap()).resolves.toMatchObject({
        outbox: [],
        durableUncertainReceipts: [],
      })
      expect(connection.requests.filter(({ method }) => method === 'command.submit')).toHaveLength(1)
      expect(connection.requests.filter(({ method }) => method === 'command.reconcile')).toHaveLength(1)
      expect(connection.terminatedWith).toBeUndefined()
      await service.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('normalizes a restart-reconciled completed prompt into the dedicated idle proof event', async () => {
    const command = prompt('device-a', 'restart-completed-prompt')
    const directory = await createUserData({ outbox: [{
      hostId: 'host-a',
      command,
      state: 'awaiting_idle_proof',
      updatedAt: timestamp,
    }] })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.reconcile') {
        return { receipts: [commandReceipt(command, 'completed')], unknown: [] }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const events: Array<{ type: string; payload: unknown }> = []
    service.on('host-event', (event) => events.push(event as { type: string; payload: unknown }))

    await service.connect({ kind: 'local' })

    expect(await readStoredOutbox(directory)).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({
      type: 'resident.prompt_idle_observed',
      payload: expect.objectContaining({ commandId: command.commandId, status: 'completed' }),
    }))
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'command.receipt',
      payload: expect.objectContaining({ commandId: command.commandId }),
    }))
  })

  it('consumes duplicate exact prompt-idle signals once and ignores a different device identity', async () => {
    const command = prompt('device-a', 'duplicate-prompt-proof')
    const directory = await createUserData({ outbox: [{
      hostId: 'host-a', command, state: 'awaiting_idle_proof', updatedAt: timestamp,
    }] })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.reconcile') return { receipts: [commandReceipt(command, 'running')], unknown: [] }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const acceptResidentPromptIdleSignal = vi.spyOn(service as unknown as {
      acceptResidentPromptIdleSignal(...args: unknown[]): Promise<void>
    }, 'acceptResidentPromptIdleSignal')
    const events: Array<{ type: string; payload: unknown }> = []
    service.on('host-event', (event) => events.push(event as { type: string; payload: unknown }))
    await service.connect({ kind: 'local' })
    const proof = {
      eventVersion: 1,
      attemptId: residentAttemptId(command),
      receipt: commandReceipt(command, 'completed'),
    }

    connection.emit('event', {
      type: 'resident.prompt_idle_observed',
      payload: { ...proof, receipt: { ...proof.receipt, deviceId: 'device-b' } },
    })
    connection.emit('event', { type: 'resident.prompt_idle_observed', payload: proof })
    connection.emit('event', { type: 'resident.prompt_idle_observed', payload: proof })

    expect(acceptResidentPromptIdleSignal).toHaveBeenCalledTimes(3)
    await Promise.all(acceptResidentPromptIdleSignal.mock.results.map(({ value }) => value))
    expect(await readStoredOutbox(directory)).toEqual([])
    expect(connection.terminatedWith).toBeUndefined()
    expect(events.filter(({ type }) => type === 'resident.prompt_idle_observed')).toHaveLength(1)
    await service.disconnect()
  })

  it.each([
    ['wrong attempt', (command: ClientCommand) => ({
      attemptId: 'resident-dispatch-wrong-attempt',
      receipt: commandReceipt(command, 'completed'),
    })],
    ['wrong generation', (command: ClientCommand) => ({
      attemptId: residentAttemptId(command),
      receipt: { ...commandReceipt(command, 'completed'), executionGenerationId: 'execution-2' },
    })],
  ] as const)('terminates on an exact local prompt proof with %s without consuming ownership', async (_label, mutate) => {
    const command = prompt('device-a', `invalid-proof-${_label.replace(' ', '-')}`)
    const retained = { hostId: 'host-a', command, state: 'awaiting_idle_proof' as const, updatedAt: timestamp }
    const directory = await createUserData({ outbox: [retained] })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.reconcile') return { receipts: [commandReceipt(command, 'running')], unknown: [] }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })

    connection.emit('event', {
      type: 'resident.prompt_idle_observed',
      payload: { eventVersion: 1, ...mutate(command) },
    })

    await vi.waitFor(() => expect(connection.terminatedWith).toBeDefined())
    expect(await readStoredOutbox(directory)).toEqual([
      expect.objectContaining({ command, state: 'awaiting_idle_proof' }),
    ])
  })

  it('retains an accepted Stop without polling and consumes only its exact abort-idle proof', async () => {
    const command = abortCommand('device-a', 'accepted-stop-proof')
    const directory = await createUserData({ outbox: [{
      hostId: 'host-a', command, state: 'awaiting_abort_idle_proof', updatedAt: timestamp,
    }] })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.reconcile') return { receipts: [commandReceipt(command, 'running')], unknown: [] }
      throw new Error(`Accepted Stop must not invoke ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const events: Array<{ type: string; payload: unknown }> = []
    service.on('host-event', (event) => events.push(event as { type: string; payload: unknown }))
    await service.connect({ kind: 'local' })

    connection.emit('event', {
      type: 'resident.abort_idle_observed',
      payload: {
        eventVersion: 1,
        attemptId: residentAttemptId(command),
        receipt: commandReceipt(command, 'completed'),
      },
    })

    await vi.waitFor(async () => expect(await readStoredOutbox(directory)).toEqual([]))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'resident.abort_idle_observed',
      payload: expect.objectContaining({ commandId: command.commandId, status: 'completed' }),
    }))
    expect(connection.requests.filter(({ method }) => method === 'command.reconcile')).toHaveLength(1)
  })

  it('fails closed instead of evicting a proof fence whose submit continuation is still active', async () => {
    const command = prompt('device-a', 'proof-fence-capacity')
    const directory = await createUserData({ outbox: [{
      hostId: 'host-a', command, state: 'awaiting_idle_proof', updatedAt: timestamp,
    }] })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.reconcile') return { receipts: [commandReceipt(command, 'running')], unknown: [] }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })
    const internals = service as unknown as {
      completedResidentProofs: Map<string, unknown>
      activeCommandSubmissions: Map<string, number>
    }
    for (let index = 0; index < 1_000; index += 1) {
      const key = `active-proof-${index}`
      internals.completedResidentProofs.set(key, { commandId: key })
      internals.activeCommandSubmissions.set(key, 1)
    }

    connection.emit('event', {
      type: 'resident.prompt_idle_observed',
      payload: {
        eventVersion: 1,
        attemptId: residentAttemptId(command),
        receipt: commandReceipt(command, 'completed'),
      },
    })

    await vi.waitFor(() => expect(connection.terminatedWith).toMatchObject({
      code: 'command.proof_fence_capacity',
    }))
    expect(internals.completedResidentProofs.size).toBe(1_000)
    expect(await readStoredOutbox(directory)).toEqual([
      expect.objectContaining({ command, state: 'awaiting_idle_proof' }),
    ])
  })

  it('polls an admitted non-replayable prompt until the old dispatch publishes its completed proof', async () => {
    const command = prompt('device-a', 'admitted-old-session')
    const directory = await createUserData({ outbox: [{
      hostId: 'host-a',
      command,
      state: 'awaiting_reconciliation',
      updatedAt: timestamp,
    }] })
    let reconciliations = 0
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.reconcile') {
        reconciliations += 1
        return {
          receipts: [commandReceipt(command, reconciliations === 1 ? 'admitted' : 'completed')],
          unknown: [],
        }
      }
      throw new Error(`Pending reconciliation must never invoke ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })
    expect(reconciliations).toBe(1)
    expect(await readStoredOutbox(directory)).toEqual([
      expect.objectContaining({ state: 'awaiting_reconciliation' }),
    ])

    await vi.waitFor(() => expect(reconciliations).toBe(2), { timeout: 2_000 })
    await vi.waitFor(async () => expect(await readStoredOutbox(directory)).toEqual([]), { timeout: 2_000 })

    expect(connection.requests.filter(({ method }) => method === 'command.submit')).toEqual([])
    await service.disconnect()
  })

  it('isolates one permanent polled identity failure while a later pending command converges', async () => {
    const conflicting = followUp('device-a', 'polled-conflict')
    const transient = followUp('device-a', 'polled-transient')
    const converging = followUp('device-a', 'polled-converges')
    const directory = await createUserData({ outbox: [conflicting, transient, converging].map((command) => ({
      hostId: 'host-a', command, state: 'awaiting_reconciliation', updatedAt: timestamp,
    })) })
    const counts = new Map<string, number>()
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.reconcile') {
        const commandId = (params as { commands: Array<{ commandId: string }> }).commands[0]!.commandId
        const count = (counts.get(commandId) ?? 0) + 1
        counts.set(commandId, count)
        if (count === 1) {
          const command = commandId === conflicting.commandId ? conflicting : converging
          return { receipts: [commandReceipt(command, 'admitted')], unknown: [] }
        }
        if (commandId === conflicting.commandId) {
          throw new ControlError('host.command_identity_orphaned', 'This identity cannot be repaired safely.')
        }
        if (commandId === transient.commandId && count === 2) {
          throw new Error('One receipt lookup timed out without closing the connection.')
        }
        if (commandId === transient.commandId) {
          return { receipts: [commandReceipt(transient, 'completed')], unknown: [] }
        }
        return { receipts: [commandReceipt(converging, 'completed')], unknown: [] }
      }
      throw new Error(`Polling must never invoke ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })

    await vi.waitFor(() => expect(counts.get(converging.commandId)).toBe(2), { timeout: 2_000 })
    await vi.waitFor(() => expect(counts.get(transient.commandId)).toBe(3), { timeout: 3_000 })
    await (service as unknown as { drainNonterminalReconciliation(): Promise<void> })
      .drainNonterminalReconciliation()
    expect(await readStoredOutbox(directory)).toHaveLength(1)

    expect(service.getConnectionState().phase).toBe('online')
    expect(connection.terminatedWith).toBeUndefined()
    expect(connection.requests.filter(({ method }) => method === 'command.submit')).toEqual([])
    await expect(service.bootstrap()).resolves.toMatchObject({ outbox: [], quarantinedOutboxCount: 1 })
    expect(await readStoredOutbox(directory)).toEqual([
      expect.objectContaining({
        command: conflicting,
        quarantineReason: 'command_identity_conflict',
      }),
    ])
    await service.disconnect()
  })

  it('keeps a healthy connection online, clears exact receipts, and quarantines a conflicting envelope without replay', async () => {
    const conflicting = followUp('device-a', 'conflicting-envelope')
    const exact = followUp('device-a', 'exact-envelope')
    const directory = await createUserData({ outbox: [waiting(conflicting), waiting(exact)] })
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.reconcile') {
        const envelope = (params as { commands: Array<{ commandId: string }> }).commands[0]
        if (envelope?.commandId === conflicting.commandId) {
          throw new ControlError('host.command_identity_orphaned', 'The durable identity cannot be reconciled safely.')
        }
        if (envelope?.commandId === exact.commandId) {
          return { receipts: [commandReceipt(exact, 'completed')], unknown: [] }
        }
      }
      throw new Error(`Conflicting reconciliation must not trigger ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const receipts: unknown[] = []
    service.on('host-event', (event) => receipts.push(event))

    await expect(service.connect({ kind: 'local' })).resolves.toMatchObject({ phase: 'online' })
    expect(connection.requests.filter(({ method }) => method === 'command.submit')).toEqual([])
    await expect(service.bootstrap()).resolves.toMatchObject({ outbox: [], quarantinedOutboxCount: 1 })
    expect(await readStoredOutbox(directory)).toEqual([
      expect.objectContaining({
        command: conflicting,
        state: 'uncertain',
        quarantineReason: 'command_identity_conflict',
      }),
    ])
    expect(receipts).toContainEqual(expect.objectContaining({
      type: 'command.receipt',
      payload: expect.objectContaining({
        hostId: 'host-a',
        deviceId: exact.deviceId,
        commandId: exact.commandId,
        threadId: exact.threadId,
        executionGenerationId: exact.expectedExecutionGenerationId,
        status: 'completed',
      }),
    }))
  })

  it('keeps automatic delivery online when one unknown envelope fails and a later envelope succeeds', async () => {
    const rejected = followUp('device-a', 'rejected-after-unknown')
    const delivered = followUp('device-a', 'delivered-after-rejection')
    const directory = await createUserData({ outbox: [waiting(rejected), waiting(delivered)] })
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.reconcile') {
        const envelope = (params as { commands: Array<{ deviceId: string; commandId: string }> }).commands[0]
        return {
          receipts: [],
          unknown: envelope ? [{ deviceId: envelope.deviceId, commandId: envelope.commandId }] : [],
        }
      }
      if (method === 'command.submit') {
        const envelope = (params as { command: { commandId: string } }).command
        if (envelope.commandId === rejected.commandId) {
          throw new ControlError('host.command_receipt_generation_mismatch', 'The receipt generation is inconsistent.')
        }
        return commandReceipt(delivered, 'completed')
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })

    await expect(service.connect({ kind: 'local' })).resolves.toMatchObject({ phase: 'online' })
    expect(connection.requests.filter(({ method }) => method === 'command.submit')).toHaveLength(2)
    await expect(service.bootstrap()).resolves.toMatchObject({ outbox: [], quarantinedOutboxCount: 1 })
    expect(await readStoredOutbox(directory)).toEqual([
      expect.objectContaining({
        command: rejected,
        state: 'uncertain',
        quarantineReason: 'command_identity_conflict',
      }),
    ])
  })

  it('never replaces a stored command with the same ID and a changed issue time or payload', async () => {
    const directory = await createUserData({ cache: verifiedCache('host-a') })
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.bootstrap()
    const original = followUp('device-a', 'immutable-command')
    const changed: ClientCommand = {
      ...original,
      issuedAt: '2026-08-05T12:00:01.000Z',
      payload: { text: 'Changed follow up' },
    }

    await expect(service.submitCommand(original)).resolves.toMatchObject({ status: 'waiting_for_connection' })
    await expect(service.submitCommand(changed)).rejects.toMatchObject({ code: 'command.identity_conflict' })
    expect(await readStoredOutbox(directory)).toEqual([
      expect.objectContaining({ hostId: 'host-a', command: original, state: 'waiting_for_connection' }),
    ])
  })

  it.each(['missing', 'mismatched', 'different'] as const)(
    'treats a %s-host stored wrapper as a global command identity reservation',
    async (variant) => {
      const command = followUp('device-a', 'globally-reserved-command', 'host-b')
      const storedCommand = variant === 'different'
        ? followUp(command.deviceId, command.commandId, 'host-a')
        : command
      const stored = {
        ...(variant === 'missing' ? {} : { hostId: 'host-a' }),
        command: storedCommand,
        state: 'uncertain' as const,
        updatedAt: timestamp,
      }
      const directory = await createUserData({ cache: verifiedCache('host-b'), outbox: [stored] })
      const service = new DesktopControlService({ app: testApp(directory) })
      await service.bootstrap()

      await expect(service.submitCommand(command)).rejects.toMatchObject({ code: 'command.identity_conflict' })
      expect(await readStoredOutbox(directory)).toEqual([stored])
    },
  )

  it('quarantines every duplicate or opaque global outbox identity before bootstrap or network use', async () => {
    const original = followUp('device-a', 'duplicate-global-id')
    const changed = {
      ...original,
      issuedAt: '2026-08-05T12:00:01.000Z',
      payload: { text: 'Conflicting immutable payload' },
    }
    const directory = await createUserData({ outbox: [waiting(original), waiting(changed)] })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      throw new Error(`Quarantined duplicates must not trigger ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })

    await expect(service.connect({ kind: 'local' })).resolves.toMatchObject({ phase: 'online' })
    await expect(service.bootstrap()).resolves.toMatchObject({ outbox: [], quarantinedOutboxCount: 2 })
    expect(connection.requests.map(({ method }) => method)).toEqual(['health.get'])

    const opaque = { command: { deviceId: 'device-a', commandId: 'opaque-global-id' }, invalid: true }
    const opaqueDirectory = await createUserData({ cache: verifiedCache('host-a'), outbox: [opaque] })
    const opaqueService = new DesktopControlService({ app: testApp(opaqueDirectory) })
    await opaqueService.bootstrap()
    await expect(opaqueService.submitCommand(followUp('device-a', 'opaque-global-id'))).rejects.toMatchObject({
      code: 'command.identity_conflict',
    })
    expect(await readStoredOutbox(opaqueDirectory)).toEqual([opaque])
    await expect(opaqueService.bootstrap()).resolves.toMatchObject({ outbox: [], quarantinedOutboxCount: 1 })
  })

  it('retains a terminal identity across restart and a rejected host switch without poisoning the original retry', async () => {
    const directory = await createUserData({})
    const original = { ...followUp('device-a', 'terminal-global-id'), delivery: 'live_only' as const }
    const hostAFirst = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.submit') return commandReceipt(original, 'completed')
      throw new Error(`Unexpected Host A request: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(hostAFirst)
    const first = new DesktopControlService({ app: testApp(directory) })
    await first.connect({ kind: 'local' })
    await expect(first.submitCommand(original)).resolves.toMatchObject({ status: 'completed' })
    await first.disconnect()
    expect(await readStoredOutbox(directory)).toEqual([])

    const changedHost = {
      ...original,
      expectedHostId: 'host-b',
      payload: { text: 'Changed after host switch' },
    }
    const hostB = new TestConnection((method) => {
      if (method === 'health.get') return health('host-b')
      throw new Error(`Rejected Host B reuse must not trigger ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(hostB)
    const second = new DesktopControlService({ app: testApp(directory) })
    await second.connect({ kind: 'local' })
    await expect(second.submitCommand(changedHost)).rejects.toMatchObject({ code: 'command.identity_conflict' })
    expect(hostB.requests.map(({ method }) => method)).toEqual(['health.get'])
    await second.disconnect()

    const hostARetry = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.submit') return commandReceipt(original, 'completed')
      throw new Error(`Unexpected Host A retry request: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(hostARetry)
    const third = new DesktopControlService({ app: testApp(directory) })
    await third.connect({ kind: 'local' })
    await expect(third.submitCommand(original)).resolves.toMatchObject({ status: 'completed' })
    expect(hostARetry.requests.filter(({ method }) => method === 'command.submit')).toHaveLength(1)
    const ledger = JSON.parse(
      await readFile(path.join(directory, 'control', 'command-identities.json'), 'utf8'),
    ) as { entries: Array<{ hostId: string; commandId: string }> }
    expect(ledger.entries).toEqual([expect.objectContaining({ hostId: 'host-a', commandId: original.commandId })])
    await third.disconnect()
  })

  it('allows an exact known retry when the durable ledger is full but rejects every new identity', async () => {
    const directory = await createUserData({ cache: verifiedCache('host-a') })
    const known = followUp('device-known', 'known-at-capacity')
    const first = new DesktopControlService({ app: testApp(directory) })
    await first.bootstrap()
    await first.submitCommand(known)
    const ledgerPath = path.join(directory, 'control', 'command-identities.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      version: 1
      entries: Array<Record<string, unknown>>
    }
    for (let index = ledger.entries.length; index < 10_000; index += 1) {
      ledger.entries.push({
        deviceId: `device-cap-${index}`,
        commandId: `command-cap-${index}`,
        hostId: 'host-a',
        envelopeSha256: 'a'.repeat(64),
        reservedAt: timestamp,
      })
    }
    await writeFile(ledgerPath, JSON.stringify(ledger))

    const restarted = new DesktopControlService({ app: testApp(directory) })
    await expect(restarted.bootstrap()).resolves.toMatchObject({ outbox: [expect.objectContaining({ command: known })] })
    await expect(restarted.submitCommand(known)).resolves.toMatchObject({ status: 'waiting_for_connection' })
    await expect(restarted.submitCommand(followUp('device-new', 'blocked-at-capacity'))).rejects.toMatchObject({
      code: 'command.identity_ledger_full',
    })
    expect((await readStoredOutbox(directory)).map((entry) => entry.command.commandId)).toEqual([known.commandId])
  })

  it.each([
    ['malformed JSON', '{broken-ledger', 'storage.malformed_json'],
    ['an invalid root', '[]', 'storage.invalid_root'],
  ])('fails closed without overwriting a command identity ledger with %s', async (_label, contents, code) => {
    const directory = await createUserData({})
    const ledgerPath = path.join(directory, 'control', 'command-identities.json')
    await writeFile(ledgerPath, contents)
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      throw new Error(`Invalid ledger must not trigger ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })

    await expect(service.submitCommand(followUp('device-a', 'ledger-must-not-overwrite'))).rejects.toMatchObject({ code })
    expect(await readFile(ledgerPath, 'utf8')).toBe(contents)
    expect(connection.requests.map(({ method }) => method)).toEqual(['health.get'])
    await service.disconnect()
  })

  it('persists a newer event generation and rejects a delayed older refresh across restart', async () => {
    const directory = await createUserData({})
    const delayedCatalog = deferred<unknown>()
    const refreshRequested = deferred<void>()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'catalog.snapshot') {
        refreshRequested.resolve()
        return delayedCatalog.promise
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const published: unknown[] = []
    service.on('snapshot', (snapshot) => published.push(snapshot))
    await service.connect({ kind: 'local' })

    const catalogG1 = catalogWithThread('host-a', 'execution-1', '2026-08-05T12:00:01.000Z')
    const catalogG2 = catalogWithThread('host-a', 'execution-2', '2026-08-05T12:00:02.000Z')
    const publishedG1 = deferred<unknown>()
    service.once('snapshot', publishedG1.resolve)
    connection.emit('event', { type: 'snapshot.update', payload: catalogG1 })
    await expect(publishedG1.promise).resolves.toEqual(catalogG1)
    expect(published).toEqual([catalogG1])
    const refresh = service.requestSnapshot({})
    await refreshRequested.promise
    const publishedG2 = deferred<unknown>()
    service.once('snapshot', publishedG2.resolve)
    connection.emit('event', { type: 'snapshot.update', payload: catalogG2 })
    await expect(publishedG2.promise).resolves.toEqual(catalogG2)
    expect(published).toEqual([catalogG1, catalogG2])
    delayedCatalog.resolve(catalogWithThread('host-a', 'execution-1', '2026-08-05T12:00:03.000Z'))
    await refresh

    const cache = (await service.bootstrap()).cache as { catalog?: ReturnType<typeof catalogWithThread> }
    expect(cache.catalog?.threads[0]?.currentLocation.executionGenerationId).toBe('execution-2')
    await service.disconnect()
    const restarted = new DesktopControlService({ app: testApp(directory) })
    const restartedCache = (await restarted.bootstrap()).cache as { catalog?: ReturnType<typeof catalogWithThread> }
    expect(restartedCache.catalog?.threads[0]?.currentLocation.executionGenerationId).toBe('execution-2')
  })

  it('retires a generation when a complete catalog drops its thread', async () => {
    const directory = await createUserData({})
    const reintroduced = catalogWithThread('host-a', 'execution-2', '2026-08-05T12:00:04.000Z')
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'catalog.snapshot') return reintroduced
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const published: unknown[] = []
    service.on('snapshot', (snapshot) => published.push(snapshot))
    await service.connect({ kind: 'local' })
    connection.emit('event', {
      type: 'snapshot.update',
      payload: catalogWithThread('host-a', 'execution-2', '2026-08-05T12:00:01.000Z'),
    })
    await vi.waitFor(() => expect(published).toHaveLength(1))
    connection.emit('event', {
      type: 'snapshot.update',
      payload: { ...catalog('host-a'), generatedAt: '2026-08-05T12:00:02.000Z' },
    })
    await vi.waitFor(() => expect(published).toHaveLength(2))

    await service.requestSnapshot({})
    const cache = (await service.bootstrap()).cache as { catalog?: { threads?: unknown[] } }
    expect(cache.catalog?.threads).toEqual([])
    await service.disconnect()
  })

  it('emits live dialogs but never writes them into the desktop projection cache', async () => {
    const directory = await createUserData({})
    const snapshot = threadSnapshotWithDialogs()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') {
        return { ...health('host-a'), capabilities: ['prime_agent_commands_v2', 'resident_extension_ui_v1'] }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const published = deferred<unknown>()
    service.once('snapshot', published.resolve)
    await service.connect({ kind: 'local' })

    connection.emit('event', { type: 'snapshot.update', payload: snapshot })
    await expect(published.promise).resolves.toMatchObject({
      residentExtensionUiRequests: [
        expect.objectContaining({ method: 'select' }),
        expect.objectContaining({ method: 'confirm' }),
        expect.objectContaining({ method: 'input' }),
        expect.objectContaining({ method: 'editor' }),
      ],
    })

    const persisted = await readFile(path.join(directory, 'control', 'projection-cache.json'), 'utf8')
    expect(persisted).not.toContain('residentExtensionUiRequests')
    expect(persisted).not.toContain('private editor prefill')
    await service.disconnect()

    const restarted = new DesktopControlService({ app: testApp(directory) })
    expect(JSON.stringify((await restarted.bootstrap()).cache)).not.toContain('residentExtensionUiRequests')
  })

  it('terminates a connection that sends an invalid thread-change signal', async () => {
    const directory = await createUserData({})
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      throw new Error(`An invalid thread-change signal must not trigger ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })

    connection.emit('event', {
      type: 'thread.changed',
      payload: {
        threadId: 'thread-1',
        executionGenerationId: 'execution-1',
        unexpected: true,
      },
    })

    expect(connection.terminatedWith).toMatchObject({ code: 'protocol.invalid_thread_change' })
    expect(connection.requests.map(({ method }) => method)).toEqual(['health.get'])
    await service.disconnect()
  })

  it('coalesces a 20-signal burst into a leading and trailing authoritative thread refresh', async () => {
    const directory = await createUserData({})
    const firstRefresh = deferred<unknown>()
    const firstRefreshStarted = deferred<void>()
    let refreshCount = 0
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'thread.snapshot') {
        refreshCount += 1
        if (refreshCount === 1) {
          firstRefreshStarted.resolve()
          return firstRefresh.promise
        }
        if (refreshCount === 2) {
          return threadSnapshotAt({
            cursorGeneration: 'daemon-1',
            cursorSequence: 2,
            status: 'idle',
            updatedAt: '2026-08-05T12:00:02.000Z',
          })
        }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const snapshots: Array<ReturnType<typeof threadSnapshotAt>> = []
    service.on('snapshot', (snapshot) => snapshots.push(snapshot as ReturnType<typeof threadSnapshotAt>))
    await service.connect({ kind: 'local' })

    connection.emit('event', {
      type: 'thread.changed',
      payload: { threadId: 'thread-1', executionGenerationId: 'execution-1' },
    })
    await firstRefreshStarted.promise
    for (let index = 1; index < 20; index += 1) {
      connection.emit('event', {
        type: 'thread.changed',
        payload: { threadId: 'thread-1', executionGenerationId: 'execution-1' },
      })
    }
    firstRefresh.resolve(threadSnapshotAt({
      cursorGeneration: 'daemon-1',
      cursorSequence: 1,
      status: 'running',
      updatedAt: '2026-08-05T12:00:01.000Z',
    }))

    await vi.waitFor(() => {
      expect(refreshCount).toBe(2)
      expect(snapshots).toHaveLength(2)
      expect(snapshots[1]?.thread.status).toBe('idle')
    }, { timeout: 2_000 })
    expect(connection.requests.filter(({ method }) => method === 'thread.snapshot')).toHaveLength(2)
    await service.disconnect()
  })

  it('retries a retryable thread refresh failure and publishes the final idle snapshot', async () => {
    const directory = await createUserData({})
    let refreshCount = 0
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'thread.snapshot') {
        refreshCount += 1
        if (refreshCount === 1) {
          throw new ControlError('transport.request_failed', 'The first snapshot request failed.', {
            retryable: true,
          })
        }
        return threadSnapshotAt({
          cursorGeneration: 'daemon-1',
          cursorSequence: 3,
          status: 'idle',
          updatedAt: '2026-08-05T12:00:03.000Z',
        })
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const snapshots: Array<ReturnType<typeof threadSnapshotAt>> = []
    service.on('snapshot', (snapshot) => snapshots.push(snapshot as ReturnType<typeof threadSnapshotAt>))
    await service.connect({ kind: 'local' })

    connection.emit('event', {
      type: 'thread.changed',
      payload: { threadId: 'thread-1', executionGenerationId: 'execution-1' },
    })

    await vi.waitFor(() => {
      expect(refreshCount).toBe(2)
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]?.thread.status).toBe('idle')
    }, { timeout: 2_000 })
    expect(connection.terminatedWith).toBeUndefined()
    await service.disconnect()
  })

  it('ignores a late thread-refresh response after disconnect', async () => {
    const directory = await createUserData({})
    const refresh = deferred<unknown>()
    const refreshStarted = deferred<void>()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'thread.snapshot') {
        refreshStarted.resolve()
        return refresh.promise
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const snapshots: unknown[] = []
    service.on('snapshot', (snapshot) => snapshots.push(snapshot))
    await service.connect({ kind: 'local' })

    connection.emit('event', {
      type: 'thread.changed',
      payload: { threadId: 'thread-1', executionGenerationId: 'execution-1' },
    })
    await refreshStarted.promise
    await service.disconnect()
    refresh.resolve(threadSnapshotAt({
      cursorGeneration: 'daemon-1',
      cursorSequence: 4,
      status: 'idle',
      updatedAt: '2026-08-05T12:00:04.000Z',
    }))
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(snapshots).toEqual([])
    expect((await service.bootstrap()).cache).not.toHaveProperty('lastSnapshot')
  })

  it('releases a superseded connection full thread-refresh budget before admitting the new authority', async () => {
    const directory = await createUserData({})
    const oldConnection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'thread.snapshot') return new Promise<never>(() => undefined)
      throw new Error(`Unexpected old-connection request: ${method}`)
    })
    const newConnection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'thread.snapshot') {
        return threadSnapshotAt({
          cursorGeneration: 'daemon-new',
          cursorSequence: 1,
          status: 'idle',
          updatedAt: '2026-08-05T12:00:05.000Z',
        })
      }
      throw new Error(`Unexpected new-connection request: ${method}`)
    })
    connectLocalHostd
      .mockResolvedValueOnce(oldConnection)
      .mockResolvedValueOnce(newConnection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const snapshots: unknown[] = []
    service.on('snapshot', (snapshot) => snapshots.push(snapshot))
    await service.connect({ kind: 'local' })

    for (let index = 0; index < 1_024; index += 1) {
      oldConnection.emit('event', {
        type: 'thread.changed',
        payload: { threadId: `stale-thread-${index}`, executionGenerationId: 'execution-old' },
      })
    }

    await expect(service.reconnect()).resolves.toMatchObject({ phase: 'online', hostId: 'host-a' })
    newConnection.emit('event', {
      type: 'thread.changed',
      payload: { threadId: 'thread-1', executionGenerationId: 'execution-1' },
    })

    await vi.waitFor(() => {
      expect(newConnection.requests.filter(({ method }) => method === 'thread.snapshot')).toHaveLength(1)
      expect(snapshots).toHaveLength(1)
    }, { timeout: 2_000 })
    expect(newConnection.terminatedWith).toBeUndefined()
    await service.disconnect()
  })

  it('retires replaced cursor generations monotonically and preserves the fence across restart', async () => {
    const directory = await createUserData({})
    const responses = [
      threadSnapshotAt({
        cursorGeneration: 'cursor-a',
        cursorSequence: 100,
        status: 'running',
        updatedAt: '2026-08-05T12:00:01.000Z',
      }),
      threadSnapshotAt({
        cursorGeneration: 'cursor-b',
        cursorSequence: 0,
        status: 'running',
        updatedAt: '2026-08-05T12:00:02.000Z',
      }),
      threadSnapshotAt({
        cursorGeneration: 'cursor-a',
        cursorSequence: 101,
        status: 'running',
        updatedAt: '2026-08-05T12:00:03.000Z',
      }),
      threadSnapshotAt({
        cursorGeneration: 'cursor-b',
        cursorSequence: 1,
        status: 'idle',
        updatedAt: '2026-08-05T12:00:04.000Z',
      }),
    ]
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'thread.snapshot') {
        const response = responses.shift()
        if (!response) throw new Error('No thread snapshot response remains')
        return response
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const afterRestart = threadSnapshotAt({
      cursorGeneration: 'cursor-a',
      cursorSequence: 102,
      status: 'idle',
      updatedAt: '2026-08-05T12:00:05.000Z',
    })
    const restartedConnection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'thread.snapshot') return afterRestart
      throw new Error(`Unexpected restart request: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(connection).mockResolvedValueOnce(restartedConnection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })

    await service.requestSnapshot({ threadId: 'thread-1' })
    await service.requestSnapshot({ threadId: 'thread-1' })
    await service.requestSnapshot({ threadId: 'thread-1' })
    let cached = (await service.bootstrap()).cache as { lastSnapshot?: ReturnType<typeof threadSnapshotAt> }
    expect(cached.lastSnapshot?.latestCursor).toMatchObject({ generation: 'cursor-b', sequence: 0 })
    await service.requestSnapshot({ threadId: 'thread-1' })
    cached = (await service.bootstrap()).cache as { lastSnapshot?: ReturnType<typeof threadSnapshotAt> }
    expect(cached.lastSnapshot?.latestCursor).toMatchObject({ generation: 'cursor-b', sequence: 1 })
    await service.disconnect()

    const restarted = new DesktopControlService({ app: testApp(directory) })
    await restarted.bootstrap()
    await restarted.reconnect()
    await restarted.requestSnapshot({ threadId: 'thread-1' })
    const restartedCache = (await restarted.bootstrap()).cache as {
      lastSnapshot?: ReturnType<typeof threadSnapshotAt>
    }
    expect(restartedCache.lastSnapshot?.latestCursor).toMatchObject({ generation: 'cursor-b', sequence: 1 })
    await restarted.disconnect()
  })

  it('removes a host-durable uncertain receipt from replay and restores its bootstrap history', async () => {
    const directory = await createUserData({})
    const command = followUp('device-a', 'durable-uncertain')
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.submit') {
        return {
          ...commandReceipt(command),
          status: 'uncertain',
          message: 'The resident runtime accepted this identity, but its final outcome is unknown.',
          error: {
            code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN',
            message: 'Host restart interrupted resident delivery confirmation.',
            retryable: false,
            diagnosticId: 'diagnostic-resident-restart',
            details: { operation: 'prompt', replayed: false },
          },
        }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const restartedConnection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      throw new Error(`A durable uncertain command must not replay through ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(connection).mockResolvedValueOnce(restartedConnection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })

    await expect(service.submitCommand(command)).resolves.toMatchObject({
      hostId: 'host-a',
      commandId: command.commandId,
      status: 'uncertain',
      durable: true,
      error: expect.objectContaining({
        code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN',
        retryable: false,
        diagnosticId: 'diagnostic-resident-restart',
      }),
    })
    expect(await readStoredOutbox(directory)).toEqual([])
    expect((await service.bootstrap()).durableUncertainReceipts).toEqual([
      expect.objectContaining({
        commandId: command.commandId,
        status: 'uncertain',
        durable: true,
        error: expect.objectContaining({ code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN', retryable: false }),
      }),
    ])
    await service.disconnect()

    const restarted = new DesktopControlService({ app: testApp(directory) })
    const offlineBootstrap = await restarted.bootstrap()
    expect(offlineBootstrap.outbox).toEqual([])
    expect(offlineBootstrap.durableUncertainReceipts).toEqual([
      expect.objectContaining({
        commandId: command.commandId,
        status: 'uncertain',
        durable: true,
        error: expect.objectContaining({ code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN', retryable: false }),
      }),
    ])
    await restarted.reconnect()
    const onlineBootstrap = await restarted.bootstrap()
    expect(onlineBootstrap.outbox).toEqual([])
    expect(onlineBootstrap.durableUncertainReceipts).toEqual([
      expect.objectContaining({
        commandId: command.commandId,
        status: 'uncertain',
        durable: true,
        error: expect.objectContaining({ code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN', retryable: false }),
      }),
    ])
    expect(restartedConnection.requests.map(({ method }) => method)).toEqual(['health.get'])
    await restarted.disconnect()
  })

  it('retains a host-durable uncertain Stop and its exact diagnostic until completed proof', async () => {
    const directory = await createUserData({})
    const command = abortCommand('device-a', 'durable-uncertain-stop')
    const uncertainReceipt = {
      ...commandReceipt(command, 'uncertain'),
      message: 'The Stop outcome is unknown and will not be replayed.',
      error: {
        code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN',
        message: 'Host restart interrupted Stop confirmation.',
        retryable: false,
        diagnosticId: 'diagnostic-uncertain-stop',
      },
    }
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.submit') return uncertainReceipt
      throw new Error(`Unexpected first-session request: ${method}`)
    })
    const restartedConnection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.reconcile') return { receipts: [uncertainReceipt], unknown: [] }
      throw new Error(`An uncertain Stop must never replay through ${method}`)
    })
    const proofConnection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.reconcile') {
        return { receipts: [commandReceipt(command, 'completed')], unknown: [] }
      }
      throw new Error(`Completed Stop proof must never replay through ${method}`)
    })
    connectLocalHostd
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce(restartedConnection)
      .mockResolvedValueOnce(proofConnection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })

    await expect(service.submitCommand(command)).resolves.toMatchObject({
      status: 'uncertain',
      durable: true,
      error: expect.objectContaining({ retryable: false }),
    })
    expect(await readStoredOutbox(directory)).toEqual([
      expect.objectContaining({ command, state: 'uncertain' }),
    ])
    expect((await service.bootstrap()).durableUncertainReceipts).toEqual([
      expect.objectContaining({
        hostId: 'host-a',
        deviceId: command.deviceId,
        commandId: command.commandId,
        threadId: command.threadId,
        executionGenerationId: command.expectedExecutionGenerationId,
        error: expect.objectContaining({
          code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN',
          retryable: false,
          diagnosticId: 'diagnostic-uncertain-stop',
        }),
      }),
    ])
    await service.disconnect()

    const restarted = new DesktopControlService({ app: testApp(directory) })
    await expect(restarted.bootstrap()).resolves.toMatchObject({
      outbox: [expect.objectContaining({ command, state: 'uncertain' })],
      durableUncertainReceipts: [expect.objectContaining({
        commandId: command.commandId,
        error: expect.objectContaining({ diagnosticId: 'diagnostic-uncertain-stop' }),
      })],
    })
    await restarted.reconnect()
    await expect(restarted.bootstrap()).resolves.toMatchObject({
      outbox: [expect.objectContaining({ command, state: 'uncertain' })],
      durableUncertainReceipts: [expect.objectContaining({
        commandId: command.commandId,
        error: expect.objectContaining({ diagnosticId: 'diagnostic-uncertain-stop' }),
      })],
    })
    await expect(restarted.submitCommand(command)).rejects.toMatchObject({
      code: 'command.awaiting_reconciliation',
      retryable: false,
    })
    expect(restartedConnection.requests.filter(({ method }) => method === 'command.submit')).toEqual([])
    const events: Array<{ type: string; payload: unknown }> = []
    restarted.on('host-event', (event) => events.push(event as { type: string; payload: unknown }))
    await restarted.reconnect()
    await expect(restarted.bootstrap()).resolves.toMatchObject({
      outbox: [],
      durableUncertainReceipts: [],
    })
    expect(events).toContainEqual({
      type: 'resident.abort_idle_observed',
      payload: expect.objectContaining({
        hostId: 'host-a',
        deviceId: command.deviceId,
        commandId: command.commandId,
        status: 'completed',
      }),
    })
    expect(proofConnection.requests.filter(({ method }) => method === 'command.submit')).toEqual([])
    await restarted.disconnect()
  })

  it('adapts model selection, approval, and cancellation with one stable issue time and exact generation', async () => {
    const directory = await createUserData({})
    const submitted: Array<Record<string, unknown>> = []
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'command.submit') {
        const envelope = (params as { command: Record<string, unknown> }).command
        submitted.push(envelope)
        return receiptForEnvelope(envelope)
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    await service.connect({ kind: 'local' })
    const modelCommand: ClientCommand = {
      ...followUp('device-a', 'select-model'),
      delivery: 'live_only',
      kind: 'model.select',
      payload: { providerId: 'openai-codex', modelId: 'gpt-5.3-codex' },
    }

    await service.submitCommand(modelCommand)
    await service.approve({
      deviceId: 'device-a',
      commandId: 'approve-one',
      expectedHostId: 'host-a',
      expectedExecutionGenerationId: 'execution-1',
      issuedAt: timestamp,
      threadId: 'thread-1',
      approvalId: 'approval-one',
      decision: 'deny',
    })
    await service.cancel({
      deviceId: 'device-a',
      commandId: 'cancel-one',
      expectedHostId: 'host-a',
      expectedExecutionGenerationId: 'execution-1',
      issuedAt: timestamp,
      threadId: 'thread-1',
    })

    expect(submitted).toEqual([
      expect.objectContaining({
        issuedAt: timestamp,
        expectedExecutionGenerationId: 'execution-1',
        command: { kind: 'model.select', providerId: 'openai-codex', modelId: 'gpt-5.3-codex' },
      }),
      expect.objectContaining({
        issuedAt: timestamp,
        expectedExecutionGenerationId: 'execution-1',
        command: { kind: 'approval.resolve', approvalId: 'approval-one', decision: 'reject' },
      }),
      expect.objectContaining({
        issuedAt: timestamp,
        expectedExecutionGenerationId: 'execution-1',
        command: { kind: 'abort' },
      }),
    ])
  })
})

const timestamp = '2026-08-05T12:00:00.000Z'

function followUp(deviceId: string, commandId: string, expectedHostId = 'host-a'): ClientCommand {
  return {
    deviceId,
    commandId,
    expectedHostId,
    expectedExecutionGenerationId: 'execution-1',
    issuedAt: timestamp,
    threadId: 'thread-1',
    kind: 'thread.follow_up',
    delivery: 'send_when_reconnected',
    payload: { text: 'Follow up' }
  }
}

function prompt(deviceId: string, commandId: string, expectedHostId = 'host-a'): ClientCommand {
  return {
    ...followUp(deviceId, commandId, expectedHostId),
    kind: 'thread.prompt',
    delivery: 'live_only',
    payload: { text: 'Run the resident task' },
  }
}

function extensionUiResponse(deviceId: string, commandId: string, expectedHostId = 'host-a'): ClientCommand {
  return {
    ...followUp(deviceId, commandId, expectedHostId),
    kind: 'extension_ui.respond',
    delivery: 'live_only',
    payload: {
      requestId: 'dialog-one',
      requestDigest: 'a'.repeat(64),
      method: 'select',
      response: { kind: 'value', value: 'A' },
    },
  }
}

function abortCommand(deviceId: string, commandId: string, expectedHostId = 'host-a'): ClientCommand {
  return {
    ...followUp(deviceId, commandId, expectedHostId),
    kind: 'thread.cancel',
    delivery: 'live_only',
    payload: undefined,
  }
}

function residentAttemptId(command: ClientCommand): string {
  return `resident-dispatch-${createHash('sha256')
    .update(JSON.stringify([command.deviceId, command.commandId]))
    .digest('hex')
    .slice(0, 48)}`
}

function commandReceipt(
  command: ClientCommand,
  status: 'received' | 'admitted' | 'running' | 'completed' | 'rejected' | 'uncertain' = 'completed',
) {
  return {
    protocolVersion: 1,
    receiptId: `receipt-${command.deviceId}-${command.commandId}`,
    deviceId: command.deviceId,
    commandId: command.commandId,
    threadId: command.threadId,
    status,
    receivedAt: timestamp,
    updatedAt: timestamp,
    executionGenerationId: command.expectedExecutionGenerationId,
  }
}

function receiptForEnvelope(envelope: Record<string, unknown>) {
  return {
    protocolVersion: 1,
    receiptId: `receipt-${String(envelope.commandId)}`,
    deviceId: envelope.deviceId,
    commandId: envelope.commandId,
    threadId: envelope.threadId,
    status: 'completed',
    receivedAt: timestamp,
    updatedAt: timestamp,
    executionGenerationId: envelope.expectedExecutionGenerationId,
  }
}

function waiting(command: ClientCommand): OutboxEntry {
  return { hostId: command.expectedHostId, command, state: 'waiting_for_connection', updatedAt: timestamp }
}

function health(hostId = 'host-a') {
  return {
    protocolVersion: 1,
    hostdVersion: '0.1.0',
    startedAt: '2026-08-05T11:59:00.000Z',
    checkedAt: timestamp,
    serviceState: 'ready',
    host: { hostId },
    capabilities: ['prime_agent_commands_v2'],
  }
}

function catalog(hostId = 'host-a') {
  return {
    snapshotVersion: 1,
    generatedAt: timestamp,
    host: {
      hostId,
      displayName: 'Test host',
      kind: 'local',
      connectionPaths: [{ kind: 'local_socket', priority: 0, state: 'available' }],
      reachability: 'online',
      compatibility: 'compatible',
      platform: { os: 'windows', architecture: 'x64' },
      attentionCounts: { total: 0, unread: 0, questions: 0, approvals: 0 }
    },
    projects: [],
    threads: []
  }
}

function catalogWithThread(hostId: string, executionGenerationId: string, observedAt: string) {
  const snapshot = threadSnapshot('thread-1', hostId)
  const thread = {
    ...snapshot.thread,
    currentLocation: { ...snapshot.thread.currentLocation, executionGenerationId },
    updatedAt: observedAt,
    lastKnownCursor: {
      ...snapshot.thread.lastKnownCursor,
      executionGenerationId,
    },
  }
  return {
    ...catalog(hostId),
    generatedAt: observedAt,
    threads: [thread],
  }
}

function modelCatalog() {
  return {
    runtime: 'prime_agent',
    releaseVersion: '0.7.0',
    observedAt: timestamp,
    providers: [{
      providerId: 'openai-codex',
      displayName: 'ChatGPT Plus/Pro (Codex Subscription)',
      oauthSupported: true,
      oauthUsesCallbackServer: true,
      configured: true,
      authSource: 'stored',
      modelCount: 1,
      availableModelCount: 1
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
      usingOAuth: true
    }]
  }
}

function threadSnapshot(threadId: string, hostId: string) {
  const cursor = {
    threadId,
    executionGenerationId: 'execution-1',
    generation: 'daemon-1',
    sequence: 1
  }
  return {
    snapshotVersion: 1,
    generatedAt: timestamp,
    thread: {
      threadId,
      title: 'Thread',
      projectIdentity: 'project-1',
      currentLocation: {
        hostId,
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        executionGenerationId: 'execution-1'
      },
      status: 'idle',
      unread: false,
      updatedAt: timestamp,
      lastKnownCursor: cursor
    },
    transcriptBlockIndex: [],
    materializedRecentBlocks: [],
    queueState: { pendingCommandIds: [], paused: false },
    approvals: [],
    childAgents: [],
    goals: [],
    schedules: [],
    git: { stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
    evidence: { testsPassed: 0, testsFailed: 0, artifactCount: 0 },
    pendingAttention: [],
    latestCursor: cursor
  }
}

function threadSnapshotAt(input: {
  cursorGeneration: string
  cursorSequence: number
  status: 'idle' | 'running'
  updatedAt: string
}) {
  const snapshot = threadSnapshot('thread-1', 'host-a')
  const cursor = {
    ...snapshot.latestCursor,
    generation: input.cursorGeneration,
    sequence: input.cursorSequence,
  }
  return {
    ...snapshot,
    generatedAt: input.updatedAt,
    thread: {
      ...snapshot.thread,
      status: input.status,
      updatedAt: input.updatedAt,
      lastKnownCursor: cursor,
    },
    latestCursor: cursor,
  }
}

function threadSnapshotWithDialogs() {
  const snapshot = threadSnapshot('thread-1', 'host-a')
  const bindingFingerprint = 'b'.repeat(64)
  const authority = {
    interactionVersion: 1 as const,
    hostId: 'host-a',
    threadId: 'thread-1',
    executionGenerationId: 'execution-1',
    bindingFingerprint,
    receivedAt: timestamp,
  }
  return {
    ...snapshot,
    residentControl: {
      projectionVersion: 1 as const,
      hostId: 'host-a',
      threadId: 'thread-1',
      executionGenerationId: 'execution-1',
      bindingFingerprint,
      controlSequence: 1,
      changedAt: timestamp,
      authorityCursor: snapshot.latestCursor,
      commandReadiness: 'ready' as const,
      browserExecution: { readiness: 'unavailable' as const },
      quiescence: { state: 'idle_proven' as const },
    },
    residentExtensionUiRequests: [
      { ...authority, requestId: 'dialog-select', requestDigest: '1'.repeat(64), method: 'select' as const, title: 'Select', options: ['A', 'B'] },
      { ...authority, requestId: 'dialog-confirm', requestDigest: '2'.repeat(64), method: 'confirm' as const, title: 'Confirm', message: 'Proceed?' },
      { ...authority, requestId: 'dialog-input', requestDigest: '3'.repeat(64), method: 'input' as const, title: 'Input', placeholder: 'Value' },
      { ...authority, requestId: 'dialog-editor', requestDigest: '4'.repeat(64), method: 'editor' as const, title: 'Editor', prefill: 'private editor prefill' },
    ],
  }
}

function verifiedCache(hostId: string) {
  return {
    version: 2,
    lastTarget: { kind: 'local' },
    lastTargetUpdatedAt: timestamp,
    projectionHostId: hostId,
    catalog: catalog(hostId),
    targetHostBindings: [{ target: { kind: 'local' }, hostId, verifiedAt: timestamp }]
  }
}

function verifiedSshCache(hostId: string, alias: string, olderAliases: string[] = []) {
  return {
    version: 2,
    lastTarget: { kind: 'ssh', alias },
    lastTargetUpdatedAt: timestamp,
    projectionHostId: hostId,
    catalog: catalog(hostId),
    targetHostBindings: [
      ...olderAliases.map((olderAlias) => ({
        target: { kind: 'ssh', alias: olderAlias },
        hostId,
        verifiedAt: timestamp,
      })),
      { target: { kind: 'ssh', alias }, hostId, verifiedAt: timestamp },
    ],
  }
}

function authorizeSshAlias(service: DesktopControlService, alias: string): void {
  const internals = service as unknown as { discoveredAliases: Set<string> }
  internals.discoveredAliases.add(alias)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function createUserData(input: { cache?: unknown; outbox?: unknown }): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'prime-control-recovery-test-'))
  temporaryDirectories.push(directory)
  const controlDirectory = path.join(directory, 'control')
  await mkdir(controlDirectory, { recursive: true })
  if (input.cache) {
    await writeFile(path.join(controlDirectory, 'projection-cache.json'), JSON.stringify(input.cache))
  }
  if (input.outbox) {
    await writeFile(path.join(controlDirectory, 'command-outbox.json'), JSON.stringify(input.outbox))
  }
  return directory
}

async function readStoredOutbox(directory: string): Promise<OutboxEntry[]> {
  return JSON.parse(await readFile(path.join(directory, 'control', 'command-outbox.json'), 'utf8')) as OutboxEntry[]
}

function testApp(userData: string): App {
  return {
    getPath: vi.fn(() => userData),
    getVersion: vi.fn(() => '1.2.3')
  } as unknown as App
}
