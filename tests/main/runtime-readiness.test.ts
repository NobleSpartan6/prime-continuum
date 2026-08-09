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
const WARMED_RUNTIME_CAPABILITIES = [
  'runtime_model_catalog_v1',
  'resident_lifecycle_v1',
  'runtime_oauth_v1',
  'candidate_evaluation_probe_v1',
] as const

interface RequestRecord {
  method: string
  params?: unknown
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
      params?: unknown,
    ) => unknown,
  ) {
    super()
  }

  async request(method: string, params: unknown, options?: RequestRecord['options']): Promise<unknown> {
    this.requests.push({ method, params, options })
    return await this.respond(method, this.requests.length - 1, options, params)
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
  it('sends one local runtime retry and immediately fences the new initializing observation', async () => {
    const failed = runtimeSnapshot('failed')
    const initializing = { ...runtimeSnapshot('initializing'), changedAt: '2026-08-07T12:00:01.000Z', attempt: 2 }
    const connection = new TestConnection((method, _requestIndex, options, params) => {
      if (method === 'health.get') {
        return health({ runtime: failed, capabilities: ['runtime_integrity_retry_v1'] })
      }
      if (method === 'runtime.integrity.retry') {
        expect(params).toEqual({ expectedHostId: 'host-a' })
        expect(options).toEqual({ timeoutMs: 10_000, priority: 'urgent' })
        return initializing
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = await serviceForTest()
    await service.connect({ kind: 'local' })

    await expect(service.retryRuntimeIntegrity('host-a')).resolves.toEqual(initializing)
    expect(connection.requests.filter(({ method }) => method === 'runtime.integrity.retry')).toHaveLength(1)
    expect(service.getConnectionState()).toMatchObject({
      phase: 'online',
      hostId: 'host-a',
      path: 'local_socket',
      runtimeReadiness: { kind: 'reported', snapshot: { status: 'initializing', attempt: 2 } },
    })
    expect(service.getConnectionState().capabilities).not.toContain('runtime_integrity_retry_v1')

    await expect(service.retryRuntimeIntegrity('host-a')).rejects.toMatchObject({
      code: 'runtime.integrity_retry_unavailable',
    })
    await expect(service.retryRuntimeIntegrity('host-b')).rejects.toMatchObject({
      code: 'runtime.integrity_retry_authority_changed',
    })
    expect(connection.requests.filter(({ method }) => method === 'runtime.integrity.retry')).toHaveLength(1)
    await service.disconnect()
  })

  it('sends one exact local runtime repair fence and immediately retires the capability', async () => {
    const failed = repairRuntimeSnapshot()
    const initializing = { ...runtimeSnapshot('initializing'), changedAt: '2026-08-07T12:00:01.000Z', attempt: 2 }
    const expectedInput = {
      expectedHostId: 'host-a',
      expectedTrustAnchorId: failed.trustAnchorId,
      expectedTarget: failed.target,
      expectedChangedAt: failed.changedAt,
    }
    const connection = new TestConnection((method, _requestIndex, options, params) => {
      if (method === 'health.get') {
        return health({ runtime: failed, capabilities: ['runtime_integrity_repair_v1'] })
      }
      if (method === 'runtime.integrity.repair') {
        expect(params).toEqual(expectedInput)
        expect(options).toEqual({ timeoutMs: 10_000, priority: 'urgent' })
        return initializing
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = await serviceForTest()
    await service.connect({ kind: 'local' })

    await expect(service.repairRuntimeIntegrity(expectedInput)).resolves.toEqual(initializing)
    expect(connection.requests.filter(({ method }) => method === 'runtime.integrity.repair')).toHaveLength(1)
    expect(service.getConnectionState()).toMatchObject({
      phase: 'online',
      runtimeReadiness: { kind: 'reported', snapshot: { status: 'initializing', attempt: 2 } },
    })
    expect(service.getConnectionState().capabilities).not.toContain('runtime_integrity_repair_v1')
    await expect(service.repairRuntimeIntegrity(expectedInput)).rejects.toMatchObject({
      code: 'runtime.integrity_repair_unavailable',
    })
    await service.disconnect()
  })

  it('rejects a stale repair trust fence before sending the host mutation', async () => {
    const failed = repairRuntimeSnapshot()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') {
        return health({ runtime: failed, capabilities: ['runtime_integrity_repair_v1'] })
      }
      throw new Error(`Runtime repair must not be sent: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = await serviceForTest()
    await service.connect({ kind: 'local' })

    await expect(service.repairRuntimeIntegrity({
      expectedHostId: 'host-a',
      expectedTrustAnchorId: 'f'.repeat(64),
      expectedTarget: failed.target,
      expectedChangedAt: failed.changedAt,
    })).rejects.toMatchObject({ code: 'runtime.integrity_repair_state_changed' })
    expect(connection.requests.filter(({ method }) => method === 'runtime.integrity.repair')).toHaveLength(0)
    await service.disconnect()
  })

  it('refuses a retry capability received over an SSH target without sending the mutation', async () => {
    const connection = new TestConnection((method) => {
      if (method === 'health.get') {
        return health({ runtime: runtimeSnapshot('failed'), capabilities: ['runtime_integrity_retry_v1'] })
      }
      throw new Error(`Runtime retry must not cross SSH: ${method}`)
    })
    connectSshHost.mockReturnValue(connection)
    const service = await serviceForTest()
    ;(service as unknown as { discoveredAliases: Set<string> }).discoveredAliases.add('remote')
    await service.connect({ kind: 'ssh', alias: 'remote' })

    await expect(service.retryRuntimeIntegrity('host-a')).rejects.toMatchObject({
      code: 'runtime.integrity_retry_local_required',
    })
    expect(connection.requests.filter(({ method }) => method === 'runtime.integrity.retry')).toHaveLength(0)
    await service.disconnect()
  })

  it('terminates the connection when a retry response changes the verified runtime lineage', async () => {
    const failed = runtimeSnapshot('failed')
    const connection = new TestConnection((method) => {
      if (method === 'health.get') {
        return health({ runtime: failed, capabilities: ['runtime_integrity_retry_v1'] })
      }
      if (method === 'runtime.integrity.retry') {
        const initializing = runtimeSnapshot('initializing')
        return {
          ...initializing,
          target: { ...initializing.target, treeSha256: DIGEST_A },
        }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = await serviceForTest()
    await service.connect({ kind: 'local' })

    await expect(service.retryRuntimeIntegrity('host-a')).rejects.toMatchObject({
      code: 'protocol.runtime_integrity_retry_invalid',
    })
    expect(connection.terminatedWith).toMatchObject({
      code: 'protocol.runtime_integrity_retry_invalid',
    })
    expect(connection.requests.filter(({ method }) => method === 'runtime.integrity.retry')).toHaveLength(1)
    await service.disconnect()
  })

  it('publishes readiness and capabilities atomically, then suppresses heartbeat-only events', async () => {
    const samples = [
      health({ runtime: runtimeSnapshot('initializing', { phase: 'preparing' }), checkedAt: '2026-08-07T12:00:00.000Z' }),
      health({ runtime: runtimeSnapshot('initializing', { phase: 'verifying' }), checkedAt: '2026-08-07T12:00:00.500Z' }),
      health({
        runtime: runtimeSnapshot('ready'),
        capabilities: ['prime_agent_commands_v2', ...WARMED_RUNTIME_CAPABILITIES],
        checkedAt: '2026-08-07T12:00:01.000Z',
      }),
      health({
        runtime: { ...runtimeSnapshot('ready'), changedAt: '2026-08-07T12:00:16.000Z' },
        capabilities: ['prime_agent_commands_v2', ...WARMED_RUNTIME_CAPABILITIES],
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
      capabilities: expect.arrayContaining(['prime_agent_commands_v2', ...WARMED_RUNTIME_CAPABILITIES]),
      runtimeReadiness: { kind: 'reported', snapshot: { status: 'ready' } },
    })

    states.length = 0
    await vi.advanceTimersByTimeAsync(15_000)
    expect(states).toEqual([])
    expect(service.getConnectionState().runtimeReadiness?.observedAt).toBe('2026-08-07T12:00:16.000Z')
    await service.disconnect()
  })

  it('observes the model catalog promptly while its shared custody gate warms in the background', async () => {
    const samples = [
      health({
        runtime: runtimeSnapshot('ready'),
        capabilities: [
          'resident_lifecycle_v1',
          'runtime_oauth_v1',
          'candidate_evaluation_probe_v1',
        ],
      }),
      health({
        runtime: runtimeSnapshot('ready'),
        capabilities: [
          'runtime_model_catalog_v1',
          'resident_lifecycle_v1',
          'runtime_oauth_v1',
          'candidate_evaluation_probe_v1',
        ],
        checkedAt: '2026-08-07T12:00:00.500Z',
      }),
    ]
    const connection = new TestConnection((method, requestIndex) => {
      if (method === 'health.get') return samples[Math.min(requestIndex, samples.length - 1)]
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = await serviceForTest()

    await service.connect({ kind: 'local' })
    expect(connection.requests.filter(({ method }) => method === 'health.get')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(500)

    expect(connection.requests.filter(({ method }) => method === 'health.get')).toHaveLength(2)
    expect(service.getConnectionState().capabilities).toEqual(expect.arrayContaining([
      'runtime_model_catalog_v1',
      'resident_lifecycle_v1',
      'runtime_oauth_v1',
    ]))
    await service.disconnect()
  })

  it('observes the Windows candidate capability promptly after every other runtime gate is ready', async () => {
    const samples = [
      health({
        runtime: runtimeSnapshot('ready'),
        capabilities: [
          'runtime_model_catalog_v1',
          'resident_lifecycle_v1',
          'runtime_oauth_v1',
        ],
      }),
      health({
        runtime: runtimeSnapshot('ready'),
        capabilities: [
          'runtime_model_catalog_v1',
          'resident_lifecycle_v1',
          'runtime_oauth_v1',
          'candidate_evaluation_probe_v1',
        ],
        checkedAt: '2026-08-07T12:00:00.500Z',
      }),
    ]
    const connection = new TestConnection((method, requestIndex) => {
      if (method === 'health.get') return samples[Math.min(requestIndex, samples.length - 1)]
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = await serviceForTest('win32')

    await service.connect({ kind: 'local' })
    await vi.advanceTimersByTimeAsync(500)

    expect(connection.requests.filter(({ method }) => method === 'health.get')).toHaveLength(2)
    expect(service.getConnectionState().capabilities).toContain('candidate_evaluation_probe_v1')
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
    delayedPoll.resolve(health({ runtime: runtimeSnapshot('ready'), capabilities: ['prime_agent_commands_v2'] }))
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
            capabilities: ['prime_agent_commands_v2'],
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
          : health({ runtime: runtimeSnapshot('ready'), capabilities: ['prime_agent_commands_v2'] })
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
        return { ...commandReceipt(queued), status: 'completed' }
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
    const initial = health({
      runtime: runtimeSnapshot('ready'),
      capabilities: [...WARMED_RUNTIME_CAPABILITIES],
    })
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

function repairRuntimeSnapshot(): Extract<RuntimeIntegritySnapshot, { status: 'failed' }> {
  const failed = runtimeSnapshot('failed') as Extract<RuntimeIntegritySnapshot, { status: 'failed' }>
  return {
    ...failed,
    code: 'RUNTIME_REPAIR_REQUIRED',
    retryable: false,
    recoveryAction: 'repair_application',
  }
}

function followUp(
  commandId: string,
  delivery: ClientCommand['delivery'],
): ClientCommand {
  return {
    deviceId: 'device-a',
    commandId,
    expectedHostId: 'host-a',
    expectedExecutionGenerationId: 'execution-1',
    issuedAt: '2026-08-07T12:00:00.000Z',
    threadId: 'thread-a',
    kind: 'thread.follow_up',
    delivery,
    payload: { text: 'Continue' },
  }
}

function commandReceipt(command: ClientCommand) {
  return {
    protocolVersion: 1,
    receiptId: `receipt-${command.commandId}`,
    deviceId: command.deviceId,
    commandId: command.commandId,
    threadId: command.threadId,
    status: 'received' as const,
    receivedAt: '2026-08-07T12:00:00.000Z',
    updatedAt: '2026-08-07T12:00:00.000Z',
    executionGenerationId: command.expectedExecutionGenerationId,
  }
}

async function serviceForTest(platform?: NodeJS.Platform): Promise<DesktopControlService> {
  const directory = await mkdtemp(path.join(tmpdir(), 'prime-runtime-readiness-test-'))
  temporaryDirectories.push(directory)
  await mkdir(path.join(directory, 'control'), { recursive: true })
  return new DesktopControlService({ app: testApp(directory), ...(platform ? { platform } : {}) })
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
