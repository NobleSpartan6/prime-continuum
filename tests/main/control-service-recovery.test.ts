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
import { ControlError } from '../../src/main/control/errors'

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
          return { receipts: [commandReceipt(exact, 'admitted')], unknown: [] }
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
        status: 'admitted',
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
        return commandReceipt(delivered, 'admitted')
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
      if (method === 'command.submit') return commandReceipt(original, 'admitted')
      throw new Error(`Unexpected Host A request: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(hostAFirst)
    const first = new DesktopControlService({ app: testApp(directory) })
    await first.connect({ kind: 'local' })
    await expect(first.submitCommand(original)).resolves.toMatchObject({ status: 'admitted' })
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
      if (method === 'command.submit') return commandReceipt(original, 'admitted')
      throw new Error(`Unexpected Host A retry request: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(hostARetry)
    const third = new DesktopControlService({ app: testApp(directory) })
    await third.connect({ kind: 'local' })
    await expect(third.submitCommand(original)).resolves.toMatchObject({ status: 'admitted' })
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
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'catalog.snapshot') return delayedCatalog.promise
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: testApp(directory) })
    const published: unknown[] = []
    service.on('snapshot', (snapshot) => published.push(snapshot))
    await service.connect({ kind: 'local' })

    const catalogG1 = catalogWithThread('host-a', 'execution-1', '2026-08-05T12:00:01.000Z')
    const catalogG2 = catalogWithThread('host-a', 'execution-2', '2026-08-05T12:00:02.000Z')
    connection.emit('event', { type: 'snapshot.update', payload: catalogG1 })
    await vi.waitFor(() => expect(published).toHaveLength(1))
    const refresh = service.requestSnapshot({})
    await vi.waitFor(() => expect(connection.requests.some(({ method }) => method === 'catalog.snapshot')).toBe(true))
    connection.emit('event', { type: 'snapshot.update', payload: catalogG2 })
    await vi.waitFor(() => expect(published).toHaveLength(2))
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

function commandReceipt(command: ClientCommand, status: 'received' | 'admitted' | 'rejected' = 'received') {
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
    status: 'received',
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
