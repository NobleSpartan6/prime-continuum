import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from 'electron'
import type { ClientCommand, OutboxEntry } from '../../src/main/control/contracts'
import { ControlError } from '../../src/main/control/errors'
import type { RuntimeIntegritySnapshot } from '../../src/shared/protocol'

const { connectLocalHostd, connectSshHost } = vi.hoisted(() => ({
  connectLocalHostd: vi.fn(),
  connectSshHost: vi.fn(),
}))

vi.mock('../../src/main/control/local-hostd', () => ({
  connectSshHost,
  ensureAndConnectLocalHostd: connectLocalHostd,
  localHostdEndpoint: () => 'test-endpoint',
}))

import { DesktopControlService } from '../../src/main/control/service'

const temporaryDirectories: string[] = []
const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)
const DIGEST_C = 'c'.repeat(64)

interface RequestRecord {
  method: string
  options?: { timeoutMs?: number; priority?: 'urgent' | 'normal' }
}

class TestConnection extends EventEmitter {
  isClosed = false
  terminatedWith?: unknown
  readonly requests: RequestRecord[] = []

  constructor(
    private readonly respond: (
      method: string,
      requestIndex: number,
      options?: RequestRecord['options'],
    ) => unknown,
  ) {
    super()
  }

  async request(method: string, _params: unknown, options?: RequestRecord['options']): Promise<unknown> {
    this.requests.push({ method, options })
    return await this.respond(method, this.requests.length - 1, options)
  }

  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    this.emit('close', new ControlError('transport.closed', 'The connection closed.', { retryable: true }))
  }

  terminate(error: unknown): void {
    if (this.isClosed) return
    this.terminatedWith = error
    this.isClosed = true
    this.emit('close', error)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-07T12:00:00.000Z'))
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  connectLocalHostd.mockReset()
  connectSshHost.mockReset()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('DesktopControlService runtime readiness', () => {
  it('publishes readiness and capabilities atomically, then suppresses heartbeat-only events', async () => {
    const samples = [
      health({ runtime: runtimeSnapshot('initializing', { phase: 'preparing' }), checkedAt: '2026-08-07T12:00:00.000Z' }),
      health({ runtime: runtimeSnapshot('initializing', { phase: 'verifying' }), checkedAt: '2026-08-07T12:00:00.500Z' }),
      health({
        runtime: runtimeSnapshot('ready'),
        capabilities: ['prime_agent_commands_v1'],
        checkedAt: '2026-08-07T12:00:01.000Z',
      }),
      health({
        runtime: { ...runtimeSnapshot('ready'), changedAt: '2026-08-07T12:00:16.000Z' },
        capabilities: ['prime_agent_commands_v1'],
        checkedAt: '2026-08-07T12:00:16.000Z',
      }),
    ]
    const connection = new TestConnection((method, requestIndex) => {
      if (method === 'health.get') return samples[requestIndex]
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = await serviceForTest()
    await service.connect({ kind: 'local' })
    const states: ReturnType<typeof service.getConnectionState>[] = []
    service.on('connection-state', (state) => states.push(state))

    await vi.advanceTimersByTimeAsync(500)
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({
      phase: 'online',
      runtimeReadiness: { kind: 'reported', snapshot: { status: 'initializing', phase: 'verifying' } },
    })
    expect(states[0]?.capabilities).toEqual(['runtime_integrity_v1'])

    await vi.advanceTimersByTimeAsync(500)
    expect(states).toHaveLength(2)
    expect(states[1]).toMatchObject({
      phase: 'online',
      capabilities: ['prime_agent_commands_v1', 'runtime_integrity_v1'],
      runtimeReadiness: { kind: 'reported', snapshot: { status: 'ready' } },
    })

    states.length = 0
    await vi.advanceTimersByTimeAsync(15_000)
    expect(states).toEqual([])
    expect(service.getConnectionState().runtimeReadiness?.observedAt).toBe('2026-08-07T12:00:16.000Z')
    await service.disconnect()
  })

  it('classifies a host that omits runtime integrity as not reported and retains it while offline', async () => {
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = await serviceForTest()

    await service.connect({ kind: 'local' })
    expect(service.getConnectionState().runtimeReadiness).toEqual({
      kind: 'not_reported',
      hostId: 'host-a',
      hostdVersion: '0.1.0',
      startedAt: '2026-08-07T11:59:00.000Z',
      observedAt: '2026-08-07T12:00:00.000Z',
    })

    await service.disconnect()
    expect(service.getConnectionState()).toMatchObject({
      phase: 'offline',
      hostId: 'host-a',
      runtimeReadiness: { kind: 'not_reported', hostId: 'host-a' },
    })
  })

  it('clears the previous authority observation on a target switch and ignores its delayed poll', async () => {
    const delayedPoll = deferred<unknown>()
    const hostA = new TestConnection((method, requestIndex) => {
      if (method !== 'health.get') throw new Error(`Unexpected Host A request: ${method}`)
      return requestIndex === 0
        ? health({ runtime: runtimeSnapshot('initializing') })
        : delayedPoll.promise
    })
    const hostBHealth = deferred<unknown>()
    let hostBHealthStarted!: () => void
    const hostBStarted = new Promise<void>((resolve) => { hostBHealthStarted = resolve })
    const hostB = new TestConnection((method) => {
      if (method !== 'health.get') throw new Error(`Unexpected Host B request: ${method}`)
      hostBHealthStarted()
      return hostBHealth.promise
    })
    connectLocalHostd.mockResolvedValue(hostA)
    connectSshHost.mockReturnValue(hostB)
    const service = await serviceForTest()
    await service.connect({ kind: 'local' })
    await vi.advanceTimersByTimeAsync(500)
    expect(hostA.requests).toHaveLength(2)
    ;(service as unknown as { discoveredAliases: Set<string> }).discoveredAliases.add('remote')

    const switching = service.connect({ kind: 'ssh', alias: 'remote' })
    await hostBStarted
    expect(service.getConnectionState()).toEqual(expect.objectContaining({
      phase: 'connecting',
      target: { kind: 'ssh', alias: 'remote' },
    }))
    expect(service.getConnectionState()).not.toHaveProperty('hostId')
    expect(service.getConnectionState()).not.toHaveProperty('capabilities')
    expect(service.getConnectionState()).not.toHaveProperty('runtimeReadiness')

    hostBHealth.resolve(health({ hostId: 'host-b' }))
    await expect(switching).resolves.toMatchObject({
      phase: 'online',
      hostId: 'host-b',
      runtimeReadiness: { kind: 'not_reported', hostId: 'host-b' },
    })
    delayedPoll.resolve(health({ runtime: runtimeSnapshot('ready'), capabilities: ['prime_agent_commands_v1'] }))
    await Promise.resolve()
    expect(service.getConnectionState()).toMatchObject({
      hostId: 'host-b',
      runtimeReadiness: { kind: 'not_reported', hostId: 'host-b' },
    })
    expect(service.getConnectionState()).not.toHaveProperty('capabilities')
    await service.disconnect()
  })

  it('never overlaps health requests while an initializing sample is outstanding', async () => {
    const delayedPoll = deferred<unknown>()
    const connection = new TestConnection((method, requestIndex) => {
      if (method !== 'health.get') throw new Error(`Unexpected request: ${method}`)
      return requestIndex === 0 ? health({ runtime: runtimeSnapshot('initializing') }) : delayedPoll.promise
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = await serviceForTest()
    await service.connect({ kind: 'local' })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(connection.requests.filter(({ method }) => method === 'health.get')).toHaveLength(2)
    delayedPoll.resolve(health({ runtime: runtimeSnapshot('ready') }))
    await Promise.resolve()
    expect(connection.requests.filter(({ method }) => method === 'health.get')).toHaveLength(2)
    await service.disconnect()
  })

  it.each(['initializing', 'failed', 'unavailable'] as const)(
    'rejects a command capability paired with a reported %s runtime',
    async (status) => {
      const connection = new TestConnection((method) => {
        if (method === 'health.get') {
          return health({
            runtime: runtimeSnapshot(status),
            capabilities: ['prime_agent_commands_v1'],
          })
        }
        throw new Error(`Unexpected request: ${method}`)
      })
      connectLocalHostd.mockResolvedValue(connection)
      const service = await serviceForTest()

      await expect(service.connect({ kind: 'local' })).rejects.toMatchObject({
        code: 'protocol.runtime_command_capability_mismatch',
      })
      expect(connection.requests.some(({ method }) => method === 'command.submit')).toBe(false)
      await service.disconnect()
    },
  )

  it('keeps commands local until readiness gains resident admission, then reconciles before delivery', async () => {
    const queued = followUp('queued-after-ready', 'send_when_reconnected')
    const live = followUp('blocked-before-ready', 'live_only')
    let healthCount = 0
    const connection = new TestConnection((method) => {
      if (method === 'health.get') {
        const sample = healthCount === 0
          ? health({ runtime: runtimeSnapshot('initializing') })
          : health({ runtime: runtimeSnapshot('ready'), capabilities: ['prime_agent_commands_v1'] })
        healthCount += 1
        return sample
      }
      if (method === 'command.reconcile') {
        return {
          receipts: [],
          unknown: [{ deviceId: queued.deviceId, commandId: queued.commandId }],
        }
      }
      if (method === 'command.submit') {
        return { deviceId: queued.deviceId, commandId: queued.commandId, status: 'received', durable: true }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = await serviceForTest()
    await (service as unknown as { putOutbox(entry: OutboxEntry): Promise<void> }).putOutbox({
      hostId: queued.expectedHostId,
      command: queued,
      state: 'waiting_for_connection',
      updatedAt: '2026-08-07T12:00:00.000Z',
    })

    await service.connect({ kind: 'local' })
    await expect(service.submitCommand(live)).rejects.toMatchObject({
      code: 'command.capability_unavailable',
      retryable: true,
    })
    expect(connection.requests.filter(({ method }) => method === 'command.submit')).toHaveLength(0)

    const internals = service as unknown as {
      reconnectGeneration: number
      stopHealthPolling(): void
      pollHealth(
        connection: TestConnection,
        target: { kind: 'local' },
        hostId: string,
        generation: number,
      ): Promise<void>
    }
    internals.stopHealthPolling()
    await internals.pollHealth(connection, { kind: 'local' }, 'host-a', internals.reconnectGeneration)

    expect(connection.requests.map(({ method }) => method)).toEqual([
      'health.get',
      'command.reconcile',
      'health.get',
      'command.reconcile',
      'command.submit',
    ])
    expect((await service.bootstrap()).outbox).toEqual([])
    await service.disconnect()
  })

  it('keeps the previous authority readiness when replacement binding persistence fails', async () => {
    const hostA = new TestConnection((method) => {
      if (method === 'health.get') return health({ runtime: runtimeSnapshot('ready') })
      throw new Error(`Unexpected Host A request: ${method}`)
    })
    const hostB = new TestConnection((method) => {
      if (method === 'health.get') {
        return health({
          hostId: 'host-b',
          runtime: runtimeSnapshot('unavailable'),
          hostdVersion: '0.2.0',
        })
      }
      throw new Error(`Unexpected Host B request: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(hostA).mockResolvedValueOnce(hostB)
    const service = await serviceForTest()
    await service.connect({ kind: 'local' })
    const cache = (service as unknown as { cache: { update: (...args: unknown[]) => Promise<unknown> } }).cache
    cache.update = vi.fn(async () => { throw new Error('Binding write failed') })

    await expect(service.reconnect()).rejects.toThrow('Binding write failed')
    expect(service.getConnectionState()).toMatchObject({
      phase: 'offline',
      hostId: 'host-a',
      runtimeReadiness: {
        kind: 'reported',
        hostId: 'host-a',
        hostdVersion: '0.1.0',
        snapshot: { status: 'ready' },
      },
    })
    await service.disconnect()
  })

  it.each([
    ['host identity', 'hostId', (sample: ReturnType<typeof health>) => ({ ...sample, host: { hostId: 'host-b' } })],
    ['host service version', 'hostdVersion', (sample: ReturnType<typeof health>) => ({ ...sample, hostdVersion: '0.2.0' })],
    ['host service start', 'startedAt', (sample: ReturnType<typeof health>) => ({ ...sample, startedAt: '2026-08-07T11:58:00.000Z' })],
    ['runtime reporting support', 'reportsRuntimeIntegrity', (sample: ReturnType<typeof health>) => ({
      ...sample,
      serviceState: 'ready',
      capabilities: [],
      runtimeIntegrity: undefined,
    })],
    ['runtime trust anchor', 'runtimeTrustAnchorId', (sample: ReturnType<typeof health>) => ({
      ...sample,
      runtimeIntegrity: { ...sample.runtimeIntegrity!, trustAnchorId: DIGEST_B },
    })],
    ['runtime target', 'runtimeTargetKey', (sample: ReturnType<typeof health>) => ({
      ...sample,
      runtimeIntegrity: {
        ...sample.runtimeIntegrity!,
        target: { ...sample.runtimeIntegrity!.target, treeSha256: DIGEST_A },
      },
    })],
  ] as const)('terminates and reconnects when the %s changes within one connection', async (_label, field, mutate) => {
    const initial = health({ runtime: runtimeSnapshot('ready') })
    const connection = new TestConnection((method, requestIndex) => {
      if (method !== 'health.get') throw new Error(`Unexpected request: ${method}`)
      return requestIndex === 0 ? initial : mutate(initial)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = await serviceForTest()
    await service.connect({ kind: 'local' })

    await vi.advanceTimersByTimeAsync(15_000)

    expect(connection.terminatedWith).toMatchObject({
      code: 'protocol.health_lineage_changed',
      details: { field },
    })
    expect(service.getConnectionState()).toMatchObject({
      phase: 'reconnecting',
      hostId: 'host-a',
      runtimeReadiness: { kind: 'reported', hostId: 'host-a', snapshot: { status: 'ready' } },
    })
    await service.disconnect()
  })

  it('terminates and reconnects when a health poll times out', async () => {
    const connection = new TestConnection((method, requestIndex, options) => {
      if (method !== 'health.get') throw new Error(`Unexpected request: ${method}`)
      if (requestIndex === 0) return health()
      expect(options).toMatchObject({ timeoutMs: 10_000, priority: 'urgent' })
      throw new ControlError('transport.request_timeout', 'The host did not answer in time.', { retryable: true })
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = await serviceForTest()
    await service.connect({ kind: 'local' })

    await vi.advanceTimersByTimeAsync(15_000)

    expect(connection.terminatedWith).toMatchObject({ code: 'transport.request_timeout' })
    expect(service.getConnectionState()).toMatchObject({
      phase: 'reconnecting',
      runtimeReadiness: { kind: 'not_reported', hostId: 'host-a' },
      error: { code: 'transport.request_timeout', retryable: true },
    })
    await service.disconnect()
  })
})

function health(options: {
  hostId?: string
  hostdVersion?: string
  checkedAt?: string
  runtime?: RuntimeIntegritySnapshot
  capabilities?: string[]
} = {}) {
  const capabilities = [
    ...(options.capabilities ?? []),
    ...(options.runtime ? ['runtime_integrity_v1'] : []),
  ]
  return {
    protocolVersion: 1,
    hostdVersion: options.hostdVersion ?? '0.1.0',
    startedAt: '2026-08-07T11:59:00.000Z',
    checkedAt: options.checkedAt ?? '2026-08-07T12:00:00.000Z',
    serviceState: options.runtime?.status === 'initializing'
      ? 'starting'
      : options.runtime?.status === 'failed' || options.runtime?.status === 'unavailable'
        ? 'degraded'
        : 'ready',
    host: { hostId: options.hostId ?? 'host-a' },
    capabilities,
    ...(options.runtime ? { runtimeIntegrity: options.runtime } : {}),
  }
}

function runtimeSnapshot(
  status: RuntimeIntegritySnapshot['status'],
  options: { phase?: Extract<RuntimeIntegritySnapshot, { status: 'initializing' }>['phase'] } = {},
): RuntimeIntegritySnapshot {
  const base = {
    contractVersion: 1 as const,
    changedAt: '2026-08-07T12:00:00.000Z',
    trustAnchorId: DIGEST_A,
    target: {
      runtime: 'prime-agent' as const,
      releaseVersion: '0.7.0',
      runtimeBuildId: 'fixture-build-1',
      platform: 'win32',
      arch: 'x64',
      manifestSha256: DIGEST_A,
      treeSha256: DIGEST_B,
      filesSha256: DIGEST_C,
    },
  }
  if (status === 'initializing') return { ...base, status, phase: options.phase ?? 'preparing', attempt: 1 }
  if (status === 'ready') return { ...base, status, assurance: 'development-integrity' }
  if (status === 'failed') {
    return { ...base, status, code: 'RUNTIME_INTEGRITY_FAILED', retryable: true, recoveryAction: 'retry_runtime_initialization' }
  }
  return { ...base, status, code: 'RUNTIME_INTEGRITY_UNAVAILABLE', retryable: false, recoveryAction: 'reinstall_application' }
}

function followUp(
  commandId: string,
  delivery: ClientCommand['delivery'],
): ClientCommand {
  return {
    deviceId: 'device-a',
    commandId,
    expectedHostId: 'host-a',
    threadId: 'thread-a',
    kind: 'thread.follow_up',
    delivery,
    payload: { text: 'Continue' },
  }
}

async function serviceForTest(): Promise<DesktopControlService> {
  const directory = await mkdtemp(path.join(tmpdir(), 'prime-runtime-readiness-test-'))
  temporaryDirectories.push(directory)
  await mkdir(path.join(directory, 'control'), { recursive: true })
  return new DesktopControlService({ app: testApp(directory) })
}

function testApp(directory: string): App {
  return {
    getPath: () => directory,
    getVersion: () => '0.1.0',
  } as unknown as App
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
