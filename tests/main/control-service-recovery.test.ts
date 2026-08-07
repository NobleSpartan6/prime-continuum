import { EventEmitter } from 'node:events'
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

const temporaryDirectories: string[] = []

class TestConnection extends EventEmitter {
  isClosed = false
  terminatedWith?: unknown
  readonly requests: Array<{ method: string; params: unknown }> = []

  constructor(private readonly respond: (method: string, params: unknown) => unknown) {
    super()
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params })
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
          capabilities: ['prime_agent_commands_v1', 'invalid capability', 'prime_agent_commands_v1'],
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
      capabilities: ['prime_agent_commands_v1'],
    })
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
      capabilities: ['prime_agent_commands_v1'],
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
      capabilities: ['prime_agent_commands_v1'],
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
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      if (method === 'command.reconcile') {
        return {
          receipts: [],
          unknown: [
            { deviceId: replayable.deviceId, commandId: replayable.commandId },
            { deviceId: uncertain.deviceId, commandId: uncertain.commandId },
            { deviceId: 'different-device', commandId: mismatchedDevice.commandId },
            { deviceId: notExplicit.deviceId, commandId: notExplicit.commandId }
          ]
        }
      }
      if (method === 'command.submit') {
        return { commandId: replayable.commandId, status: 'received', durable: true }
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
        return { commandId: replayable.commandId, status: 'received', durable: true }
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

  it('publishes degraded without ever publishing online when restart reconciliation fails', async () => {
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
    await expect(service.reconnect()).resolves.toMatchObject({
      phase: 'degraded',
      error: { code: 'native.unexpected' }
    })

    expect(phases).toEqual(['reconnecting', 'degraded'])
    expect(authoritativeRefreshTriggered).toBe(false)
    expect(connection.requests.map((request) => request.method)).toEqual(['health.get', 'command.reconcile'])
    expect((await service.bootstrap()).outbox).toEqual([waiting(queued)])
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
        return { commandId: queued.commandId, status: 'received', durable: true }
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
        expect(params).toEqual({
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
        return { deviceId: queuedForB.deviceId, commandId: queuedForB.commandId, status: 'received', durable: true }
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
        expect(params).toMatchObject({
          expectedHostId: 'host-a',
          commands: [
            { deviceId: 'device-a', commandId: 'shared-command' },
            { deviceId: 'device-b', commandId: 'shared-command' }
          ]
        })
        return { receipts: [], unknown: [{ deviceId: 'device-a', commandId: 'shared-command' }] }
      }
      if (method === 'command.submit') {
        expect(params).toMatchObject({ command: { deviceId: 'device-a', commandId: 'shared-command' } })
        return { deviceId: 'device-a', commandId: 'shared-command', status: 'received', durable: true }
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
    expect(snapshots).toEqual([expect.objectContaining({ host: expect.objectContaining({ hostId: 'host-b' }) })])

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
      cache: { update: (updater: (current: unknown) => unknown) => Promise<unknown> }
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
    expect(bootstrap.connection).toMatchObject({ phase: 'online', hostId: 'host-b' })
    expect(bootstrap.cache).not.toMatchObject({ catalog: { host: { hostId: 'host-a' } } })
    expect(bootstrap.cache).toMatchObject({
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
    expect(bootstrap.connection).toMatchObject({ phase: 'offline', hostId: 'host-b' })
    expect(bootstrap.cache).toMatchObject({
      version: 3,
      activeHostId: 'host-b',
      projectionHostId: 'host-b',
      entries: {
        'host-a': {
          catalog: { host: { hostId: 'host-a', displayName: 'Test host' } },
          lastSnapshot: { thread: { threadId: 'thread-a' } }
        },
        'host-b': {
          catalog: { host: { hostId: 'host-b', displayName: 'Host B replaced' } },
          lastSnapshot: { thread: { threadId: 'thread-b' } }
        }
      }
    })
    expect(await readdir(path.join(directory, 'control', 'projections'))).toHaveLength(2)
  })
})

const timestamp = '2026-08-05T12:00:00.000Z'

function followUp(deviceId: string, commandId: string, expectedHostId = 'host-a'): ClientCommand {
  return {
    deviceId,
    commandId,
    expectedHostId,
    threadId: 'thread-1',
    kind: 'thread.follow_up',
    delivery: 'send_when_reconnected',
    payload: { text: 'Follow up' }
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
    capabilities: ['prime_agent_commands_v1'],
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
