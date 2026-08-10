import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App, IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  type ClientCommand,
  type ResidentEndOperationView,
} from '../../src/main/control/contracts'
import { ControlError } from '../../src/main/control/errors'
import { registerControlIpc } from '../../src/main/control/ipc'
import type { ResidentLifecycleStatus } from '../../src/shared/protocol'

const { connectLocalHostd } = vi.hoisted(() => ({
  connectLocalHostd: vi.fn(),
}))

vi.mock('../../src/main/control/local-hostd', () => ({
  connectSshHost: vi.fn(),
  ensureAndConnectLocalHostd: connectLocalHostd,
  localHostdEndpoint: () => 'test-endpoint',
}))

import { DesktopControlService } from '../../src/main/control/service'

const timestamp = '2026-08-08T12:00:00.000Z'
const terminalTimestamp = '2026-08-08T12:00:01.000Z'
const identity = {
  expectedHostId: 'host-a',
  projectId: 'project-a',
  workspaceId: 'workspace-a',
  threadId: 'thread-a',
  executionGenerationId: 'execution-a',
}
const cursor = {
  threadId: identity.threadId,
  executionGenerationId: identity.executionGenerationId,
  generation: 'cursor-generation-a',
  sequence: 7,
}
const temporaryDirectories: string[] = []
const services: DesktopControlService[] = []

interface RequestRecord {
  method: string
  params: unknown
  options?: { timeoutMs?: number; priority?: 'urgent' | 'normal' }
}

class TestConnection extends EventEmitter {
  isClosed = false
  readonly requests: RequestRecord[] = []

  constructor(
    private readonly respond: (
      method: string,
      params: unknown,
      requestIndex: number,
      options?: RequestRecord['options'],
    ) => unknown,
  ) {
    super()
  }

  async request(method: string, params: unknown, options?: RequestRecord['options']): Promise<unknown> {
    this.requests.push({ method, params, options })
    return await this.respond(method, params, this.requests.length - 1, options)
  }

  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    this.emit('close', new ControlError('transport.closed', 'The connection closed.', { retryable: true }))
  }

  terminate(error: unknown): void {
    if (this.isClosed) return
    this.isClosed = true
    this.emit('close', error)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(timestamp))
  connectLocalHostd.mockReset()
})

afterEach(async () => {
  for (const service of services.splice(0)) await service.disconnect().catch(() => undefined)
  vi.useRealTimers()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('DesktopControlService resident end boundary', () => {
  it('persists a path-free end before one host mutation and terminalizes only after exact projection proof', async () => {
    const directory = await testDirectory()
    let ended = false
    let endPayload: Record<string, unknown> | undefined
    const connection = new TestConnection(async (method, params) => {
      if (method === 'health.get') return health()
      if (method === 'thread.snapshot') return ended ? terminalSnapshot(String(endPayload?.operationId)) : liveSnapshot()
      if (method === 'resident.end') {
        endPayload = params as Record<string, unknown>
        const durable = await readFile(path.join(directory, 'control', 'resident-lifecycle.json'), 'utf8')
        expect(durable).toContain(String(endPayload.operationId))
        expect(durable).not.toContain('confirmationToken')
        ended = true
        return endStatus(endPayload, 'completed')
      }
      if (method === 'catalog.snapshot') return terminalCatalog()
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedServiceWithProjection(directory, connection)
    const snapshots: unknown[] = []
    service.on('snapshot', (snapshot) => snapshots.push(snapshot))

    const prepared = await service.prepareResidentEnd(identity)
    const result = await service.endResident({ confirmationToken: prepared.confirmationToken, consent: true })
    const bootstrap = await service.bootstrap()

    expect(result).toMatchObject({ kind: 'end', phase: 'completed', operationId: prepared.operationId })
    expect(endPayload).toEqual({
      operationId: prepared.operationId,
      ...identity,
      expectedSourceCursor: cursor,
    })
    expect(Object.keys(endPayload!).sort()).toEqual([
      'executionGenerationId',
      'expectedHostId',
      'expectedSourceCursor',
      'operationId',
      'projectId',
      'threadId',
      'workspaceId',
    ])
    expect(bootstrap.residentLifecycleOperations).toEqual([
      expect.objectContaining({
        kind: 'end',
        operationId: prepared.operationId,
        sourceCursor: cursor,
        state: 'terminal',
      }),
    ])
    expect(JSON.stringify({ prepared, operations: bootstrap.residentLifecycleOperations }))
      .not.toMatch(/workspaceDirectory|activeSessionId|sessionId|bindingFingerprint/)
    expect(snapshots).toContainEqual(expect.objectContaining({ host: expect.objectContaining({ hostId: 'host-a' }) }))
    expect(snapshots).toContainEqual(expect.objectContaining({
      residentLifecycle: expect.objectContaining({ operationId: prepared.operationId, state: 'ended' }),
    }))
    expect(connection.requests.filter(({ method }) => method === 'resident.end')).toHaveLength(1)
  })

  it('allows exact SSH End only through the registered-workspace lifecycle capability', async () => {
    const directory = await testDirectory()
    let ended = false
    let endPayload: Record<string, unknown> | undefined
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health(['resident_registered_workspace_lifecycle_v1'])
      if (method === 'thread.snapshot') return ended ? terminalSnapshot(String(endPayload?.operationId)) : liveSnapshot()
      if (method === 'resident.end') {
        endPayload = params as Record<string, unknown>
        ended = true
        return endStatus(endPayload, 'completed')
      }
      if (method === 'catalog.snapshot') return terminalCatalog()
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedServiceWithProjection(directory, connection)
    markAsRegisteredSsh(service, ['resident_registered_workspace_lifecycle_v1'])

    const prepared = await service.prepareResidentEnd(identity)
    await expect(service.endResident({ confirmationToken: prepared.confirmationToken, consent: true }))
      .resolves.toMatchObject({ kind: 'end', phase: 'completed' })
    expect(endPayload).toEqual({
      operationId: prepared.operationId,
      ...identity,
      expectedSourceCursor: cursor,
    })
    expect(connection.requests.filter(({ method }) => method === 'resident.end')).toHaveLength(1)

    const secondDirectory = await testDirectory()
    const secondConnection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      if (method === 'thread.snapshot') return liveSnapshot()
      throw new Error(`Unexpected request: ${method}`)
    })
    const withoutCapability = await connectedServiceWithProjection(secondDirectory, secondConnection)
    markAsRegisteredSsh(withoutCapability, [])
    await expect(withoutCapability.prepareResidentEnd(identity)).rejects.toMatchObject({
      code: 'resident.lifecycle_unavailable',
    })
    expect(secondConnection.requests.filter(({ method }) => method === 'resident.end')).toEqual([])
  })

  it.each(['idle', 'failed'] as const)(
    'preserves a terminal %s task outcome instead of synthesizing task completion',
    async (terminalStatus) => {
      const directory = await testDirectory()
      let ended = false
      let operationId = ''
      const connection = new TestConnection((method, params) => {
        if (method === 'health.get') return health()
        if (method === 'thread.snapshot') {
          return ended ? terminalSnapshot(operationId, terminalStatus) : liveSnapshot()
        }
        if (method === 'resident.end') {
          operationId = String((params as Record<string, unknown>).operationId)
          ended = true
          return endStatus(params as Record<string, unknown>, 'completed')
        }
        if (method === 'catalog.snapshot') return terminalCatalog(terminalStatus)
        throw new Error(`Unexpected request: ${method}`)
      })
      const service = await connectedServiceWithProjection(directory, connection)
      const prepared = await service.prepareResidentEnd(identity)

      await expect(service.endResident({ confirmationToken: prepared.confirmationToken, consent: true }))
        .resolves.toMatchObject({ kind: 'end', phase: 'completed' })
      expect((await service.bootstrap()).residentLifecycleOperations).toEqual([
        expect.objectContaining({ operationId, state: 'terminal' }),
      ])
      expect(connection.requests.filter(({ method }) => method === 'resident.end')).toHaveLength(1)
    },
  )

  it('retires an exact source-cursor rejection before allowing a fresh review', async () => {
    const directory = await testDirectory()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      if (method === 'thread.snapshot') return liveSnapshot()
      if (method === 'resident.end') {
        throw new ControlError(
          'host.resident_end_source_cursor_changed',
          'Resident state changed after end consent was reviewed; refresh the thread and confirm again',
        )
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedServiceWithProjection(directory, connection)
    const first = await service.prepareResidentEnd(identity)

    await expect(service.endResident({ confirmationToken: first.confirmationToken, consent: true }))
      .rejects.toMatchObject({ code: 'host.resident_end_source_cursor_changed', retryable: false })
    expect((await service.bootstrap()).residentLifecycleOperations).toEqual([])

    const second = await service.prepareResidentEnd(identity)
    expect(second.operationId).not.toBe(first.operationId)
    expect(connection.requests.filter(({ method }) => method === 'resident.end')).toHaveLength(1)
    expect(connection.requests.filter(({ method }) => method === 'resident.lifecycle.status')).toEqual([])
  })

  it('consumes a confirmation exactly once before any second mutation can start', async () => {
    const directory = await testDirectory()
    let payload: Record<string, unknown> | undefined
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health()
      if (method === 'thread.snapshot') return liveSnapshot()
      if (method === 'resident.end') {
        payload = params as Record<string, unknown>
        return endStatus(payload, 'ending')
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedServiceWithProjection(directory, connection)
    const prepared = await service.prepareResidentEnd(identity)

    await expect(service.endResident({ confirmationToken: prepared.confirmationToken, consent: true }))
      .resolves.toMatchObject({ phase: 'ending' })
    await expect(service.endResident({ confirmationToken: prepared.confirmationToken, consent: true }))
      .rejects.toMatchObject({ code: 'resident.end_confirmation_consumed' })
    expect(connection.requests.filter(({ method }) => method === 'resident.end')).toHaveLength(1)
  })

  it('expires confirmation tokens without recording or sending an end', async () => {
    const directory = await testDirectory()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      if (method === 'thread.snapshot') return liveSnapshot()
      throw new Error(`Expired confirmation must not dispatch ${method}`)
    })
    const service = await connectedServiceWithProjection(directory, connection)
    const prepared = await service.prepareResidentEnd(identity)
    vi.setSystemTime(new Date(Date.parse(prepared.expiresAt) + 1))

    await expect(service.endResident({ confirmationToken: prepared.confirmationToken, consent: true }))
      .rejects.toMatchObject({ code: 'resident.end_confirmation_expired' })
    expect(connection.requests.filter(({ method }) => method === 'resident.end')).toEqual([])
    await expect(readFile(path.join(directory, 'control', 'resident-lifecycle.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('invalidates a confirmation across an exact connection-generation replacement', async () => {
    const directory = await testDirectory()
    const firstConnection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      if (method === 'thread.snapshot') return liveSnapshot()
      throw new Error(`Old connection must not dispatch ${method}`)
    })
    const service = await connectedServiceWithProjection(directory, firstConnection)
    const prepared = await service.prepareResidentEnd(identity)

    const replacement = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`Replacement must not dispatch ${method}`)
    })
    connectLocalHostd.mockResolvedValue(replacement)
    await service.reconnect()

    await expect(service.endResident({ confirmationToken: prepared.confirmationToken, consent: true }))
      .rejects.toMatchObject({ code: 'resident.end_confirmation_authority_changed' })
    expect(firstConnection.requests.filter(({ method }) => method === 'resident.end')).toEqual([])
    expect(replacement.requests.filter(({ method }) => method === 'resident.end')).toEqual([])
  })

  it('blocks exact-lineage commands as soon as durable end admission wins', async () => {
    const directory = await testDirectory()
    const endGate = deferred<unknown>()
    const endObserved = deferred<void>()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health(['resident_lifecycle_v1', 'prime_agent_commands_v2'])
      if (method === 'thread.snapshot') return liveSnapshot()
      if (method === 'resident.end') {
        endObserved.resolve()
        return endGate.promise
      }
      if (method === 'resident.lifecycle.status') return { status: null }
      throw new Error(`Blocked command must not dispatch ${method}`)
    })
    const service = await connectedServiceWithProjection(directory, connection)
    const prepared = await service.prepareResidentEnd(identity)
    const ending = service.endResident({ confirmationToken: prepared.confirmationToken, consent: true })
    await endObserved.promise

    await expect(service.submitCommand(command('blocked-after-end'))).rejects.toMatchObject({
      code: 'command.resident_end_in_progress',
    })
    expect(connection.requests.filter(({ method }) => method === 'command.submit')).toEqual([])
    endGate.reject(new ControlError('transport.request_timeout', 'lost end response', { retryable: true }))
    await expect(ending).rejects.toMatchObject({ code: 'resident.end_outcome_unknown' })
  })

  it('consumes a raced token but cannot admit or dispatch after its connection is superseded', async () => {
    const directory = await testDirectory()
    const firstConnection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      if (method === 'thread.snapshot') return liveSnapshot()
      throw new Error(`Superseded connection must not dispatch ${method}`)
    })
    const service = await connectedServiceWithProjection(directory, firstConnection)
    const prepared = await service.prepareResidentEnd(identity)
    const ledgerGate = deferred<void>()
    const ledgerStore = (service as unknown as { residentLifecycleLedger: { tail: Promise<void> } })
      .residentLifecycleLedger
    ledgerStore.tail = ledgerGate.promise
    const ending = service.endResident({ confirmationToken: prepared.confirmationToken, consent: true })
    await waitForLedgerOperationToQueue(ledgerStore, ledgerGate.promise)

    const replacement = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`Replacement must not dispatch ${method}`)
    })
    connectLocalHostd.mockResolvedValue(replacement)
    await service.reconnect()
    ledgerGate.resolve()

    await expect(ending).rejects.toMatchObject({ code: 'connection.superseded' })
    await expect(service.endResident({ confirmationToken: prepared.confirmationToken, consent: true }))
      .rejects.toMatchObject({ code: 'resident.end_confirmation_consumed' })
    expect(firstConnection.requests.filter(({ method }) => method === 'resident.end')).toEqual([])
    expect(replacement.requests.filter(({ method }) => method === 'resident.end')).toEqual([])
    await expect(readFile(path.join(directory, 'control', 'resident-lifecycle.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restarts and reconciles an unknown end by status only without replay or minting a new identity', async () => {
    const directory = await testDirectory()
    const firstConnection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      if (method === 'thread.snapshot') return liveSnapshot()
      if (method === 'resident.end') {
        throw new ControlError('transport.request_timeout', 'lost end response', { retryable: true })
      }
      if (method === 'resident.lifecycle.status') return { status: null }
      throw new Error(`Unexpected request: ${method}`)
    })
    const first = await connectedServiceWithProjection(directory, firstConnection)
    const prepared = await first.prepareResidentEnd(identity)
    await expect(first.endResident({ confirmationToken: prepared.confirmationToken, consent: true }))
      .rejects.toMatchObject({ code: 'resident.end_outcome_unknown' })
    await first.disconnect()

    const secondConnection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      if (method === 'resident.lifecycle.status') return { status: null }
      if (method === 'thread.snapshot') return liveSnapshot()
      throw new Error(`Restart must not replay ${method}`)
    })
    connectLocalHostd.mockResolvedValue(secondConnection)
    const restarted = await serviceFor(directory)
    await restarted.connect({ kind: 'local' })
    await restarted.requestSnapshot({ threadId: identity.threadId })

    await expect(restarted.residentLifecycleStatus({
      expectedHostId: identity.expectedHostId,
      operationId: prepared.operationId,
    })).resolves.toEqual({ status: null })
    await expect(restarted.prepareResidentEnd(identity)).rejects.toMatchObject({
      code: 'resident.end_recovery_required',
    })
    expect((await restarted.bootstrap()).residentLifecycleOperations).toEqual([
      expect.objectContaining({ kind: 'end', operationId: prepared.operationId, state: 'outcome_unknown' }),
    ])
    expect(secondConnection.requests.filter(({ method }) => method === 'resident.end')).toEqual([])
  })

  it('permits the exact same operation only from host-proven pre-effect ending', async () => {
    const directory = await testDirectory()
    const operationId = 'resident-end-resume'
    const entry = endLedgerEntry(operationId, endStatus({ operationId, ...identity }, 'ending'))
    await writeEndLedger(directory, [entry])
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health()
      if (method === 'resident.lifecycle.status') return { status: entry.lastStatus }
      if (method === 'thread.snapshot') return liveSnapshot()
      if (method === 'resident.end') return endStatus(params as Record<string, unknown>, 'ending')
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedServiceWithProjection(directory, connection)

    const prepared = await service.prepareResidentEnd({ ...identity, resumeOperationId: operationId })
    expect(prepared.operationId).toBe(operationId)
    await expect(service.endResident({ confirmationToken: prepared.confirmationToken, consent: true }))
      .resolves.toMatchObject({ operationId, phase: 'ending' })
    expect(connection.requests.filter(({ method }) => method === 'resident.end')).toHaveLength(1)
  })

  it.each(['kill_dispatching', 'kill_acknowledged', 'quarantined', 'completed'] as const)(
    'keeps %s recovery check-only',
    async (phase) => {
      const directory = await testDirectory()
      const operationId = `resident-end-${phase}`
      const status = endStatus({ operationId, ...identity }, phase)
      const entry = endLedgerEntry(operationId, status)
      await writeEndLedger(directory, [entry])
      const connection = new TestConnection((method) => {
        if (method === 'health.get') return health()
        if (method === 'resident.lifecycle.status') return { status }
        if (method === 'thread.snapshot') return phase === 'completed'
          ? terminalSnapshot(operationId)
          : liveSnapshot()
        if (method === 'catalog.snapshot') return terminalCatalog()
        throw new Error(`Check-only recovery must not dispatch ${method}`)
      })
      const service = await connectedServiceWithProjection(directory, connection)

      await expect(service.prepareResidentEnd({ ...identity, resumeOperationId: operationId }))
        .rejects.toMatchObject({ code: 'resident.end_resume_not_allowed' })
      expect(connection.requests.filter(({ method }) => method === 'resident.end')).toEqual([])
    }
  )

  it('keeps completed end refresh-pending when the projection proves a different operation', async () => {
    const directory = await testDirectory()
    let ended = false
    let operationId = ''
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health()
      if (method === 'thread.snapshot') {
        return ended ? terminalSnapshot('different-end-operation') : liveSnapshot()
      }
      if (method === 'resident.end') {
        operationId = String((params as Record<string, unknown>).operationId)
        ended = true
        return endStatus(params as Record<string, unknown>, 'completed')
      }
      if (method === 'catalog.snapshot') return terminalCatalog()
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedServiceWithProjection(directory, connection)
    const prepared = await service.prepareResidentEnd(identity)

    await expect(service.endResident({ confirmationToken: prepared.confirmationToken, consent: true }))
      .rejects.toMatchObject({ code: 'protocol.resident_snapshot_identity_mismatch' })
    expect((await service.bootstrap()).residentLifecycleOperations).toEqual([
      expect.objectContaining({ operationId, state: 'terminal_refresh_pending' }),
    ])
    expect(connection.requests.filter(({ method }) => method === 'resident.end')).toHaveLength(1)
  })

  it('defaults a valid v1 provisioning ledger without kind to provision', async () => {
    const directory = await testDirectory()
    const legacy = {
      operationId: 'legacy-provision',
      expectedHostId: 'host-a',
      projectId: 'legacy-project',
      workspaceId: 'legacy-workspace',
      threadId: 'legacy-thread',
      executionGenerationId: 'legacy-execution',
      projectDisplayName: 'Legacy project',
      threadTitle: 'Legacy thread',
      createdAt: timestamp,
      updatedAt: timestamp,
      state: 'outcome_unknown',
    }
    await writeFile(
      path.join(directory, 'control', 'resident-lifecycle.json'),
      JSON.stringify({ version: 1, entries: [legacy] }),
      'utf8',
    )
    const service = await serviceFor(directory)

    expect((await service.bootstrap()).residentLifecycleOperations).toEqual([
      { ...legacy, kind: 'provision', provisionMode: 'local_path' },
    ])
  })

  it('rejects path/session-bearing IPC end DTOs and non-literal consent before service calls', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>()
    const prepareResidentEnd = vi.fn()
    const endResident = vi.fn()
    const ipcMain = {
      handle: (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => {
        handlers.set(channel, handler)
      },
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain
    const service = Object.assign(new EventEmitter(), {
      prepareResidentEnd,
      endResident,
    }) as unknown as DesktopControlService
    registerControlIpc({
      ipcMain,
      service,
      getWindows: () => [],
      isTrustedSender: () => true,
      isTrustedWorkbenchSender: () => true,
    })
    const event = {} as IpcMainInvokeEvent

    await expect(handlers.get(IPC.prepareResidentEnd)!(event, {
      ...identity,
      workspaceDirectory: 'C:\\private',
    })).resolves.toMatchObject({ ok: false })
    await expect(handlers.get(IPC.endResident)!(event, {
      confirmationToken: 'confirmation-a',
      consent: false,
      sessionId: 'private-session',
    })).resolves.toMatchObject({ ok: false })
    expect(prepareResidentEnd).not.toHaveBeenCalled()
    expect(endResident).not.toHaveBeenCalled()
  })
})

function command(commandId: string): ClientCommand {
  return {
    deviceId: 'device-a',
    commandId,
    expectedHostId: identity.expectedHostId,
    threadId: identity.threadId,
    expectedExecutionGenerationId: identity.executionGenerationId,
    issuedAt: timestamp,
    kind: 'thread.prompt',
    delivery: 'live_only',
    payload: { text: 'must remain local' },
  }
}

function health(capabilities = ['resident_lifecycle_v1']) {
  return {
    protocolVersion: 1,
    hostdVersion: '0.1.0',
    startedAt: '2026-08-08T11:59:00.000Z',
    checkedAt: timestamp,
    serviceState: 'ready',
    host: { hostId: identity.expectedHostId },
    capabilities,
  }
}

function liveSnapshot() {
  return {
    snapshotVersion: 1,
    generatedAt: timestamp,
    thread: threadSummary('idle', timestamp),
    transcriptBlockIndex: [],
    materializedRecentBlocks: [],
    queueState: { pendingCommandIds: [], paused: false },
    approvals: [],
    childAgents: [],
    goals: [],
    schedules: [],
    runtime: {
      runtime: 'prime_agent',
      residency: 'resident',
      activeSessionId: 'private-active-session',
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      steeringMode: 'all',
      followUpMode: 'all',
      messageCount: 1,
      compactionCount: 0,
      queuedActionCount: 0,
      activeToolNames: [],
    },
    git: { stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
    evidence: { testsPassed: 1, testsFailed: 0, artifactCount: 0 },
    pendingAttention: [],
    latestCursor: cursor,
  }
}

function terminalSnapshot(
  operationId: string,
  status: ResidentEndedTaskState = 'complete',
) {
  return {
    snapshotVersion: 1,
    generatedAt: terminalTimestamp,
    thread: terminalThreadSummary(status, terminalTimestamp),
    transcriptBlockIndex: [],
    materializedRecentBlocks: [],
    queueState: { pendingCommandIds: [], paused: false },
    approvals: [],
    childAgents: [],
    goals: [],
    schedules: [],
    residentLifecycle: {
      version: 1,
      state: 'ended',
      operationId,
      bindingFingerprint: 'a'.repeat(64),
      endedAt: terminalTimestamp,
      sourceCursor: cursor,
      reason: 'user_end',
    },
    git: { stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
    evidence: { testsPassed: 1, testsFailed: 0, artifactCount: 0 },
    pendingAttention: [],
    latestCursor: cursor,
  }
}

function terminalCatalog(status: ResidentEndedTaskState = 'complete') {
  return {
    snapshotVersion: 1,
    generatedAt: terminalTimestamp,
    host: {
      hostId: identity.expectedHostId,
      displayName: 'Test host',
      kind: 'local',
      connectionPaths: [{ kind: 'local_socket', priority: 0, state: 'available' }],
      reachability: 'online',
      compatibility: 'compatible',
      platform: { os: 'windows', architecture: 'x64' },
      attentionCounts: { total: 0, unread: 0, questions: 0, approvals: 0 },
    },
    projects: [{
      projectId: identity.projectId,
      hostId: identity.expectedHostId,
      workspaceId: identity.workspaceId,
      displayName: 'Project A',
      lastOpenedAt: terminalTimestamp,
    }],
    threads: [terminalThreadSummary(status, terminalTimestamp)],
  }
}

type ResidentEndedTaskState = 'idle' | 'complete' | 'failed'

function terminalThreadSummary(status: ResidentEndedTaskState, updatedAt: string) {
  return {
    ...threadSummary(status, updatedAt),
    recap: 'Resident session ended.',
  }
}

function threadSummary(status: ResidentEndedTaskState, updatedAt: string) {
  return {
    threadId: identity.threadId,
    title: 'Resident thread',
    projectIdentity: identity.projectId,
    currentLocation: {
      hostId: identity.expectedHostId,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      executionGenerationId: identity.executionGenerationId,
    },
    status,
    recap: status === 'complete' ? 'Resident session ended.' : 'Resident session active.',
    unread: false,
    updatedAt,
    lastKnownCursor: cursor,
  }
}

function endStatus(
  payload: Record<string, unknown>,
  phase: 'ending' | 'kill_dispatching' | 'kill_acknowledged' | 'quarantined' | 'completed',
): ResidentLifecycleStatus {
  return {
    version: 1,
    kind: 'end',
    operationId: String(payload.operationId),
    phase,
    expectedHostId: String(payload.expectedHostId),
    projectId: String(payload.projectId),
    workspaceId: String(payload.workspaceId),
    threadId: String(payload.threadId),
    executionGenerationId: String(payload.executionGenerationId),
    preparedAt: timestamp,
    updatedAt: phase === 'ending' ? timestamp : terminalTimestamp,
    ...(phase === 'quarantined'
      ? {
          quarantinedFrom: 'kill_dispatching' as const,
          quarantineReason: 'external_outcome_unknown' as const,
        }
      : {}),
    ...(phase === 'completed' ? { terminalAt: terminalTimestamp } : {}),
  }
}

function endLedgerEntry(
  operationId: string,
  lastStatus?: ResidentLifecycleStatus,
): ResidentEndOperationView {
  return {
    kind: 'end',
    operationId,
    ...identity,
    sourceCursor: cursor,
    createdAt: timestamp,
    updatedAt: lastStatus?.updatedAt ?? timestamp,
    state: lastStatus?.phase === 'completed'
      ? 'terminal_refresh_pending'
      : lastStatus?.phase === 'quarantined' ? 'terminal' : 'submitted',
    ...(lastStatus ? { lastStatus } : {}),
  }
}

async function writeEndLedger(directory: string, entries: ResidentEndOperationView[]): Promise<void> {
  await writeFile(
    path.join(directory, 'control', 'resident-lifecycle.json'),
    JSON.stringify({ version: 1, entries }),
    'utf8',
  )
}

function markAsRegisteredSsh(service: DesktopControlService, capabilities: string[]): void {
  const mutable = service as unknown as {
    target: { kind: 'ssh'; alias: string }
    state: ReturnType<DesktopControlService['getConnectionState']>
    authorityCapabilities: string[]
  }
  mutable.target = { kind: 'ssh', alias: 'remote' }
  mutable.state = {
    ...service.getConnectionState(),
    target: { kind: 'ssh', alias: 'remote' },
    path: 'ssh',
  }
  mutable.authorityCapabilities = capabilities
}

async function connectedServiceWithProjection(
  directory: string,
  connection: TestConnection,
): Promise<DesktopControlService> {
  connectLocalHostd.mockResolvedValue(connection)
  const service = await serviceFor(directory)
  await service.connect({ kind: 'local' })
  await service.requestSnapshot({ threadId: identity.threadId })
  return service
}

async function serviceFor(directory: string): Promise<DesktopControlService> {
  const service = new DesktopControlService({ app: testApp(directory) })
  services.push(service)
  return service
}

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'prime-resident-end-main-test-'))
  temporaryDirectories.push(directory)
  await mkdir(path.join(directory, 'control'), { recursive: true })
  return directory
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

async function waitForLedgerOperationToQueue(
  store: { tail: Promise<void> },
  blockingTail: Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < 20 && store.tail === blockingTail; attempt += 1) {
    await Promise.resolve()
  }
  expect(store.tail).not.toBe(blockingTail)
}
