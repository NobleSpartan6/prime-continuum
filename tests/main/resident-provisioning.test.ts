import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from 'electron'
import type {
  ResidentLifecycleOperationView,
  ResidentProvisionOperationView,
} from '../../src/main/control/contracts'
import type { ResidentLifecycleStatus } from '../../src/shared/protocol'
import { ControlError } from '../../src/main/control/errors'

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

describe('DesktopControlService resident provisioning boundary', () => {
  it('keeps the selected absolute path out of renderer results, events, and durable caches', async () => {
    const directory = await testDirectory()
    const selectedPath = path.join(directory, 'private-parent-never-render', 'Workspace')
    let provisionPayload: Record<string, unknown> | undefined
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health()
      if (method === 'resident.provision') {
        provisionPayload = params as Record<string, unknown>
        return provisionStatus(provisionPayload, 'committed')
      }
      if (method === 'catalog.snapshot') return catalogFor(provisionPayload!)
      if (method === 'thread.snapshot') return threadSnapshotFor(provisionPayload!)
      throw new Error(`Unexpected request: ${method}`)
    })
    const picker = vi.fn().mockResolvedValue(selectedPath)
    const service = await connectedService(directory, connection, picker)
    const rendererEvents: unknown[] = []
    service.on('connection-state', (event) => rendererEvents.push(event))
    service.on('host-event', (event) => rendererEvents.push(event))
    service.on('snapshot', (event) => rendererEvents.push(event))

    const selection = await service.selectResidentWorkspace()
    const result = await service.provisionResident({
      selectionToken: selection.selectionToken,
      projectDisplayName: 'Workspace',
      threadTitle: 'New resident thread',
    })
    const bootstrap = await service.bootstrap()

    expect(selection.suggestedName).toBe('Workspace')
    expect((provisionPayload as { workspaceDirectory?: string }).workspaceDirectory).toBe(path.resolve(selectedPath))
    expect(result.phase).toBe('committed')
    expect(JSON.stringify({ selection, result, bootstrap, rendererEvents })).not.toContain('private-parent-never-render')
    const lifecycleLedger = await readFile(path.join(directory, 'control', 'resident-lifecycle.json'), 'utf8')
    expect(lifecycleLedger).not.toContain('private-parent-never-render')
    expect(lifecycleLedger).not.toContain(selection.selectionToken)
    expect(await readFile(path.join(directory, 'control', 'projection-cache.json'), 'utf8'))
      .not.toContain('private-parent-never-render')
    expect(bootstrap.residentLifecycleOperations).toEqual([
      expect.objectContaining({ operationId: selection.operationId, state: 'terminal' }),
    ])
  })

  it('rejects SSH authority before opening the native picker', async () => {
    const directory = await testDirectory()
    const picker = vi.fn().mockResolvedValue(path.join(directory, 'Workspace'))
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(directory, connection, picker)
    const mutable = service as unknown as {
      target: { kind: 'ssh'; alias: string }
      state: ReturnType<DesktopControlService['getConnectionState']>
    }
    mutable.target = { kind: 'ssh', alias: 'remote' }
    mutable.state = {
      ...service.getConnectionState(),
      target: { kind: 'ssh', alias: 'remote' },
      path: 'ssh',
    }

    await expect(service.selectResidentWorkspace()).rejects.toMatchObject({
      code: 'resident.lifecycle_local_required',
    })
    expect(picker).not.toHaveBeenCalled()
  })

  it('rejects superseded and expired selection tokens', async () => {
    const directory = await testDirectory()
    const picker = vi.fn()
      .mockResolvedValueOnce(path.join(directory, 'First'))
      .mockResolvedValueOnce(path.join(directory, 'Second'))
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(directory, connection, picker)
    const first = await service.selectResidentWorkspace()
    const second = await service.selectResidentWorkspace()

    await expect(service.provisionResident(provisionInput(first.selectionToken))).rejects.toMatchObject({
      code: 'resident.workspace_selection_superseded',
    })
    vi.setSystemTime(new Date(Date.parse(second.expiresAt) + 1))
    await expect(service.provisionResident(provisionInput(second.selectionToken))).rejects.toMatchObject({
      code: 'resident.workspace_selection_expired',
    })
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])
  })

  it('binds immutable labels on first attempt and permits only the exact retry after an unknown response', async () => {
    const directory = await testDirectory()
    const provisionPayloads: Array<Record<string, unknown>> = []
    let provisionAttempts = 0
    const connection = new TestConnection((method, params, _index, options) => {
      if (method === 'health.get') return health()
      if (method === 'resident.provision') {
        expect(options?.timeoutMs).toBe(120_000)
        provisionPayloads.push(params as Record<string, unknown>)
        provisionAttempts += 1
        if (provisionAttempts === 1) {
          throw new ControlError('transport.request_timeout', 'lost response', { retryable: true })
        }
        return provisionStatus(params as Record<string, unknown>, 'prepared')
      }
      if (method === 'resident.lifecycle.status') return { status: null }
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(
      directory,
      connection,
      vi.fn().mockResolvedValue(path.join(directory, 'Workspace')),
    )
    const selection = await service.selectResidentWorkspace()
    const padded = {
      selectionToken: selection.selectionToken,
      projectDisplayName: '  Workspace  ',
      threadTitle: '  New resident thread  ',
    }
    const exact = provisionInput(selection.selectionToken)

    await expect(service.provisionResident(padded)).rejects.toMatchObject({
      code: 'resident.provision_outcome_unknown',
      retryable: true,
    })
    expect(connection.requests.map(({ method }) => method)).toEqual([
      'health.get',
      'resident.provision',
      'resident.lifecycle.status',
    ])
    await expect(service.provisionResident({ ...exact, threadTitle: 'Changed retry' })).rejects.toMatchObject({
      code: 'resident.provision_identity_conflict',
    })
    await expect(service.provisionResident(exact)).resolves.toMatchObject({ phase: 'prepared' })

    expect(provisionPayloads).toHaveLength(2)
    expect(provisionPayloads[1]).toEqual(provisionPayloads[0])
    expect(provisionPayloads[0]).toMatchObject({
      operationId: selection.operationId,
      expectedHostId: selection.expectedHostId,
      projectDisplayName: 'Workspace',
      threadTitle: 'New resident thread',
    })
  })

  it('rejects all-whitespace labels before ledger persistence or host submission', async () => {
    const directory = await testDirectory()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(
      directory,
      connection,
      vi.fn().mockResolvedValue(path.join(directory, 'Workspace')),
    )
    const selection = await service.selectResidentWorkspace()

    await expect(service.provisionResident({
      selectionToken: selection.selectionToken,
      projectDisplayName: '   ',
      threadTitle: 'Thread',
    })).rejects.toMatchObject({ code: 'resident.provision_label_invalid' })
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])
    await expect(readFile(path.join(directory, 'control', 'resident-lifecycle.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reconciles an ambiguous provision response through status without replaying provision', async () => {
    const directory = await testDirectory()
    let provisionPayload: Record<string, unknown> | undefined
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health()
      if (method === 'resident.provision') {
        provisionPayload = params as Record<string, unknown>
        throw new ControlError('transport.request_timeout', 'lost response', { retryable: true })
      }
      if (method === 'resident.lifecycle.status') {
        return { status: provisionStatus(provisionPayload!, 'committed') }
      }
      if (method === 'catalog.snapshot') return catalogFor(provisionPayload!)
      if (method === 'thread.snapshot') return threadSnapshotFor(provisionPayload!)
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(
      directory,
      connection,
      vi.fn().mockResolvedValue(path.join(directory, 'Workspace')),
    )
    const selection = await service.selectResidentWorkspace()

    await expect(service.provisionResident(provisionInput(selection.selectionToken)))
      .resolves.toMatchObject({ phase: 'committed' })
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toHaveLength(1)
    expect(connection.requests.map(({ method }) => method)).toEqual([
      'health.get',
      'resident.provision',
      'resident.lifecycle.status',
      'catalog.snapshot',
      'thread.snapshot',
    ])
  })

  it('keeps a newer committed status when an older prepared response arrives later', async () => {
    const directory = await testDirectory()
    const entry = ledgerEntry('out-of-order-status', { state: 'outcome_unknown' })
    const payload = ledgerPayload(entry)
    const olderGate = deferred<unknown>()
    const newerGate = deferred<unknown>()
    let statusRequestCount = 0
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health([])
      if (method === 'resident.lifecycle.status') {
        statusRequestCount += 1
        return statusRequestCount === 1 ? olderGate.promise : newerGate.promise
      }
      if (method === 'catalog.snapshot') return catalogFor(payload)
      if (method === 'thread.snapshot') return threadSnapshotFor(payload)
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(directory, connection, vi.fn())
    await writeResidentLedger(directory, [entry])
    const older = service.residentLifecycleStatus({
      expectedHostId: entry.expectedHostId,
      operationId: entry.operationId,
    })
    const newer = service.residentLifecycleStatus({
      expectedHostId: entry.expectedHostId,
      operationId: entry.operationId,
    })
    const committed = provisionStatus(
      payload,
      'committed',
      new Date(Date.parse(timestamp) + 2_000).toISOString(),
    )
    newerGate.resolve({ status: committed })
    await expect(newer).resolves.toEqual({ status: committed })

    olderGate.resolve({ status: provisionStatus(payload, 'prepared', timestamp) })
    await expect(older).resolves.toEqual({ status: committed })
    expect((await service.bootstrap()).residentLifecycleOperations).toEqual([
      expect.objectContaining({
        operationId: entry.operationId,
        state: 'terminal',
        lastStatus: committed,
      }),
    ])
  })

  it('fails closed when equal status timestamps carry different lifecycle facts', async () => {
    const directory = await testDirectory()
    const entry = ledgerEntry('equal-status-conflict', { state: 'outcome_unknown' })
    const payload = ledgerPayload(entry)
    const prepared = provisionStatus(payload, 'prepared', timestamp)
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health([])
      if (method === 'resident.lifecycle.status') {
        return { status: { ...prepared, phase: 'promoted_observed' } }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(directory, connection, vi.fn())
    await writeResidentLedger(directory, [
      { ...entry, state: 'submitted', lastStatus: prepared },
    ])

    await expect(service.residentLifecycleStatus({
      expectedHostId: entry.expectedHostId,
      operationId: entry.operationId,
    })).rejects.toMatchObject({ code: 'protocol.resident_lifecycle_status_conflict' })
    expect((await service.bootstrap()).residentLifecycleOperations).toEqual([
      expect.objectContaining({ state: 'submitted', lastStatus: prepared }),
    ])
  })

  it('retains a newer known status and fails closed when an older lookup returns null', async () => {
    const directory = await testDirectory()
    const entry = ledgerEntry('null-after-newer', { state: 'outcome_unknown' })
    const payload = ledgerPayload(entry)
    const nullGate = deferred<unknown>()
    const newerGate = deferred<unknown>()
    let statusRequestCount = 0
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health([])
      if (method === 'resident.lifecycle.status') {
        statusRequestCount += 1
        return statusRequestCount === 1 ? nullGate.promise : newerGate.promise
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(directory, connection, vi.fn())
    await writeResidentLedger(directory, [entry])
    const staleNull = service.residentLifecycleStatus({
      expectedHostId: entry.expectedHostId,
      operationId: entry.operationId,
    })
    const newer = service.residentLifecycleStatus({
      expectedHostId: entry.expectedHostId,
      operationId: entry.operationId,
    })
    const prepared = provisionStatus(
      payload,
      'prepared',
      new Date(Date.parse(timestamp) + 1_000).toISOString(),
    )
    newerGate.resolve({ status: prepared })
    await expect(newer).resolves.toEqual({ status: prepared })

    nullGate.resolve({ status: null })
    await expect(staleNull).rejects.toMatchObject({
      code: 'protocol.resident_lifecycle_status_missing',
    })
    expect((await service.bootstrap()).residentLifecycleOperations).toEqual([
      expect.objectContaining({ state: 'submitted', lastStatus: prepared }),
    ])
  })

  it('rejects an old generation while its status merge is queued behind the ledger lock', async () => {
    const directory = await testDirectory()
    const entry = ledgerEntry('generation-replaced-status', { state: 'outcome_unknown' })
    const payload = ledgerPayload(entry)
    const oldConnection = new TestConnection((method) => {
      if (method === 'health.get') return health([])
      if (method === 'resident.lifecycle.status') {
        return { status: provisionStatus(payload, 'prepared') }
      }
      throw new Error(`Unexpected old-generation request: ${method}`)
    })
    const service = await connectedService(directory, oldConnection, vi.fn())
    await writeResidentLedger(directory, [entry])

    const ledgerGate = deferred<void>()
    const ledgerStore = (service as unknown as {
      residentLifecycleLedger: { tail: Promise<void> }
    }).residentLifecycleLedger
    ledgerStore.tail = ledgerGate.promise
    const staleLookup = service.residentLifecycleStatus({
      expectedHostId: entry.expectedHostId,
      operationId: entry.operationId,
    })
    await waitForLedgerOperationToQueue(ledgerStore, ledgerGate.promise)

    const replacement = new TestConnection((method) => {
      if (method === 'health.get') return health([])
      if (method === 'resident.lifecycle.status') {
        throw new ControlError('transport.request_timeout', 'replacement lookup unavailable')
      }
      throw new Error(`Unexpected replacement request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(replacement)
    await service.reconnect()
    ledgerGate.resolve()

    await expect(staleLookup).rejects.toMatchObject({ code: 'connection.superseded' })
    const operations = (await service.bootstrap()).residentLifecycleOperations
    expect(operations).toEqual([
      expect.objectContaining({
        operationId: entry.operationId,
        state: 'outcome_unknown',
      }),
    ])
    expect(operations[0]).not.toHaveProperty('lastStatus')
  })

  it('does not let a delayed provision failure downgrade a committed status', async () => {
    const directory = await testDirectory()
    const provisionGate = deferred<unknown>()
    const provisionObserved = deferred<void>()
    let payload: Record<string, unknown> | undefined
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health()
      if (method === 'resident.provision') {
        payload = params as Record<string, unknown>
        provisionObserved.resolve()
        return provisionGate.promise
      }
      if (method === 'resident.lifecycle.status') {
        return {
          status: provisionStatus(
            payload!,
            'committed',
            new Date(Date.parse(timestamp) + 1_000).toISOString(),
          ),
        }
      }
      if (method === 'catalog.snapshot') return catalogFor(payload!)
      if (method === 'thread.snapshot') return threadSnapshotFor(payload!)
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(
      directory,
      connection,
      vi.fn().mockResolvedValue(path.join(directory, 'Workspace')),
    )
    const selection = await service.selectResidentWorkspace()
    const provision = service.provisionResident(provisionInput(selection.selectionToken))
    await provisionObserved.promise
    const committed = await service.residentLifecycleStatus({
      expectedHostId: selection.expectedHostId,
      operationId: selection.operationId,
    })
    expect(committed.status?.phase).toBe('committed')

    provisionGate.reject(new ControlError('transport.request_timeout', 'late lost response'))
    await expect(provision).resolves.toMatchObject({ phase: 'committed' })
    expect((await service.bootstrap()).residentLifecycleOperations).toEqual([
      expect.objectContaining({
        operationId: selection.operationId,
        state: 'terminal',
        lastStatus: committed.status,
      }),
    ])
  })

  it('does not let a delayed submission overwrite a committed ledger entry', async () => {
    const directory = await testDirectory()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`Delayed admission must not dispatch ${method}`)
    })
    const service = await connectedService(
      directory,
      connection,
      vi.fn().mockResolvedValue(path.join(directory, 'Workspace')),
    )
    const selection = await service.selectResidentWorkspace()
    type PrivateRecord = {
      selection: typeof selection
      authority: unknown
      projectId: string
      workspaceId: string
      threadId: string
      executionGenerationId: string
      createdAt: string
    }
    const privateService = service as unknown as {
      residentWorkspaceSelections: Map<string, PrivateRecord>
      residentLifecycleLedger: { tail: Promise<void> }
      recordResidentLifecycleSubmission(
        record: PrivateRecord,
        metadata: { projectDisplayName: string; threadTitle: string },
      ): Promise<void>
    }
    const record = privateService.residentWorkspaceSelections.get(selection.selectionToken)
    expect(record).toBeDefined()
    const ledgerGate = deferred<void>()
    privateService.residentLifecycleLedger.tail = ledgerGate.promise
    const delayedSubmission = privateService.recordResidentLifecycleSubmission(record!, {
      projectDisplayName: 'Workspace',
      threadTitle: 'New resident thread',
    })
    await waitForLedgerOperationToQueue(privateService.residentLifecycleLedger, ledgerGate.promise)

    const committed = provisionStatus({
      operationId: selection.operationId,
      expectedHostId: selection.expectedHostId,
      projectId: record!.projectId,
      workspaceId: record!.workspaceId,
      threadId: record!.threadId,
      executionGenerationId: record!.executionGenerationId,
    }, 'committed', new Date(Date.parse(timestamp) + 1_000).toISOString())
    await writeResidentLedger(directory, [{
      kind: 'provision',
      operationId: selection.operationId,
      expectedHostId: selection.expectedHostId,
      projectId: record!.projectId,
      workspaceId: record!.workspaceId,
      threadId: record!.threadId,
      executionGenerationId: record!.executionGenerationId,
      projectDisplayName: 'Workspace',
      threadTitle: 'New resident thread',
      createdAt: record!.createdAt,
      updatedAt: committed.updatedAt,
      state: 'terminal',
      lastStatus: committed,
    }])
    ledgerGate.resolve()
    await delayedSubmission

    expect((await service.bootstrap()).residentLifecycleOperations).toEqual([
      expect.objectContaining({ state: 'terminal', lastStatus: committed }),
    ])
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])
  })

  it('rejects capability absence without opening the picker', async () => {
    const directory = await testDirectory()
    const picker = vi.fn().mockResolvedValue(path.join(directory, 'Workspace'))
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health([])
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(directory, connection, picker)

    await expect(service.selectResidentWorkspace()).rejects.toMatchObject({
      code: 'resident.lifecycle_unavailable',
      retryable: true,
    })
    expect(picker).not.toHaveBeenCalled()
  })

  it('allows only safe path-free lifecycle phases to be explicitly reselected', async () => {
    const directory = await testDirectory()
    const phaseCases = [
      ['prepared-op', 'prepared', true],
      ['promoted-op', 'promoted_observed', true],
      ['projection-op', 'projection_committed', true],
      ['owned-op', 'owned_observed', false],
      ['create-dispatch-op', 'owned_create_dispatching', false],
      ['promotion-dispatch-op', 'promotion_dispatching', false],
    ] as const
    const entries = phaseCases.map(([operationId, phase]) =>
      ledgerEntry(operationId, {
        state: 'submitted',
        lastStatus: lifecycleStatusForOperation(operationId, phase),
      })
    )
    entries.push(ledgerEntry('unknown-op', { state: 'outcome_unknown' }))
    await writeResidentLedger(directory, entries)
    const statuses = new Map(entries.map((entry) => [entry.operationId, entry.lastStatus ?? null]))
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health()
      if (method === 'resident.lifecycle.status') {
        const operationId = String((params as { operationId?: unknown }).operationId)
        return { status: statuses.get(operationId) ?? null }
      }
      throw new Error(`Explicit reselection must not dispatch ${method}`)
    })
    const picker = vi.fn().mockResolvedValue(path.join(directory, 'Workspace'))
    const service = await connectedService(directory, connection, picker)

    for (const [operationId, _phase, allowed] of phaseCases) {
      const pickerCalls = picker.mock.calls.length
      if (allowed) {
        await expect(service.selectResidentWorkspace({ resumeOperationId: operationId }))
          .resolves.toMatchObject({ operationId })
        expect(picker).toHaveBeenCalledTimes(pickerCalls + 1)
      } else {
        await expect(service.selectResidentWorkspace({ resumeOperationId: operationId }))
          .rejects.toMatchObject({ code: 'resident.workspace_resume_not_allowed' })
        expect(picker).toHaveBeenCalledTimes(pickerCalls)
      }
    }
    await expect(service.selectResidentWorkspace({ resumeOperationId: 'unknown-op' }))
      .resolves.toMatchObject({ operationId: 'unknown-op' })
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])
  })

  it('bounds and isolates the automatic reconnect status-only sweep', async () => {
    const directory = await testDirectory()
    const entries = Array.from({ length: 10 }, (_unused, index) =>
      ledgerEntry(`pending-${index}`, {
        state: 'outcome_unknown',
        updatedAt: new Date(Date.parse(timestamp) + index).toISOString(),
      })
    )
    await writeResidentLedger(directory, entries)
    let lookupCount = 0
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health([])
      if (method === 'resident.lifecycle.status') {
        lookupCount += 1
        if (lookupCount === 1) throw new ControlError('transport.request_timeout', 'one lookup failed')
        return { status: null }
      }
      throw new Error(`Reconnect recovery must not dispatch ${method}`)
    })
    const service = await connectedService(directory, connection, vi.fn())

    expect(service.getConnectionState().phase).toBe('online')
    expect(lookupCount).toBe(8)
    const after = (await service.bootstrap()).residentLifecycleOperations
    expect(after.filter((entry) => entry.state === 'requires_reselection')).toHaveLength(7)
    expect(after.filter((entry) => entry.state === 'outcome_unknown')).toHaveLength(3)
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])
  })

  it('materializes a committed operation during reconnect even when provisioning capability is withdrawn', async () => {
    const directory = await testDirectory()
    const entry = ledgerEntry('committed-after-reconnect', { state: 'outcome_unknown' })
    await writeResidentLedger(directory, [entry])
    const payload = ledgerPayload(entry)
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health([])
      if (method === 'resident.lifecycle.status') {
        return { status: provisionStatus(payload, 'committed') }
      }
      if (method === 'catalog.snapshot') return catalogFor(payload)
      if (method === 'thread.snapshot') return threadSnapshotFor(payload)
      throw new Error(`Reconnect recovery must not dispatch ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = await serviceFor(directory, vi.fn())
    const snapshots: unknown[] = []
    service.on('snapshot', (snapshot) => snapshots.push(snapshot))
    await service.connect({ kind: 'local' })
    await waitForResidentProjectionRefresh(service)
    const bootstrap = await service.bootstrap()

    expect(bootstrap.residentLifecycleOperations).toEqual([
      expect.objectContaining({ operationId: entry.operationId, state: 'terminal' }),
    ])
    expect(JSON.stringify(bootstrap.cache)).toContain(entry.threadId)
    expect(JSON.stringify(snapshots)).toContain(entry.threadId)
    expect(connection.requests.map(({ method }) => method)).toEqual([
      'health.get',
      'resident.lifecycle.status',
      'catalog.snapshot',
      'thread.snapshot',
    ])
  })

  it('publishes online before eight committed projection refreshes and coalesces their catalog fetch', async () => {
    vi.useRealTimers()
    const directory = await testDirectory()
    const entries = Array.from({ length: 8 }, (_unused, index) =>
      ledgerEntry(`committed-deferred-${index}`, { state: 'outcome_unknown' })
    )
    await writeResidentLedger(directory, entries)
    const byOperation = new Map(entries.map((entry) => [entry.operationId, entry]))
    const catalogGate = deferred<unknown>()
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health([])
      if (method === 'resident.lifecycle.status') {
        const operationId = String((params as { operationId?: unknown }).operationId)
        const entry = byOperation.get(operationId)
        return { status: entry ? provisionStatus(ledgerPayload(entry), 'committed') : null }
      }
      if (method === 'catalog.snapshot') return catalogGate.promise
      throw new Error(`Deferred refresh must not reach ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = await serviceFor(directory, vi.fn())

    await expect(withWallTimeout(service.connect({ kind: 'local' }), 1_000))
      .resolves.toMatchObject({ phase: 'online' })
    expect((await service.bootstrap()).residentLifecycleOperations.every(
      (entry) => entry.state === 'terminal_refresh_pending'
    )).toBe(true)
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])

    catalogGate.resolve({ invalid: true })
    await waitForResidentProjectionRefresh(service)
    expect(connection.requests.filter(({ method }) => method === 'catalog.snapshot')).toHaveLength(1)
    expect(connection.requests.filter(({ method }) => method === 'thread.snapshot')).toHaveLength(0)
  })

  it('never queues provisioning after disconnect', async () => {
    const directory = await testDirectory()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(
      directory,
      connection,
      vi.fn().mockResolvedValue(path.join(directory, 'Workspace')),
    )
    const selection = await service.selectResidentWorkspace()
    await service.disconnect()

    await expect(service.provisionResident(provisionInput(selection.selectionToken))).rejects.toMatchObject({
      code: 'resident.workspace_selection_authority_changed',
    })
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])
    await expect(readFile(path.join(directory, 'control', 'resident-lifecycle.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reselects a bootstrap-only operation after restart and reuses every immutable identifier', async () => {
    const directory = await testDirectory()
    const selectedPath = path.join(directory, 'Workspace')
    let originalPayload: Record<string, unknown> | undefined
    const firstConnection = new TestConnection((method, params) => {
      if (method === 'health.get') return health()
      if (method === 'resident.provision') {
        originalPayload = params as Record<string, unknown>
        throw new ControlError('transport.request_timeout', 'lost response', { retryable: true })
      }
      if (method === 'resident.lifecycle.status') {
        throw new ControlError('transport.request_timeout', 'status unavailable', { retryable: true })
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const first = await connectedService(
      directory,
      firstConnection,
      vi.fn().mockResolvedValue(selectedPath),
    )
    const originalSelection = await first.selectResidentWorkspace()
    await expect(first.provisionResident(provisionInput(originalSelection.selectionToken)))
      .rejects.toMatchObject({ code: 'resident.provision_outcome_unknown' })
    await first.disconnect()

    let resumedPayload: Record<string, unknown> | undefined
    const secondConnection = new TestConnection((method, params) => {
      if (method === 'health.get') return health()
      if (method === 'resident.lifecycle.status') return { status: null }
      if (method === 'resident.provision') {
        resumedPayload = params as Record<string, unknown>
        return provisionStatus(resumedPayload, 'committed')
      }
      if (method === 'catalog.snapshot') return catalogFor(resumedPayload!)
      if (method === 'thread.snapshot') return threadSnapshotFor(resumedPayload!)
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(secondConnection)
    const restarted = await serviceFor(directory, vi.fn().mockResolvedValue(selectedPath))
    await restarted.connect({ kind: 'local' })
    expect((await restarted.bootstrap()).residentLifecycleOperations).toEqual([
      expect.objectContaining({ operationId: originalSelection.operationId, state: 'requires_reselection' }),
    ])

    const resumed = await restarted.selectResidentWorkspace({
      resumeOperationId: originalSelection.operationId,
    })
    expect(resumed.operationId).toBe(originalSelection.operationId)
    const beforeProvision = secondConnection.requests.length
    await expect(restarted.provisionResident({
      ...provisionInput(resumed.selectionToken),
      threadTitle: 'Different identity',
    })).rejects.toMatchObject({ code: 'resident.provision_identity_conflict' })
    expect(secondConnection.requests).toHaveLength(beforeProvision)
    await expect(restarted.provisionResident(provisionInput(resumed.selectionToken)))
      .resolves.toMatchObject({ phase: 'committed' })

    expect(resumedPayload).toEqual(originalPayload)
    expect(secondConnection.requests.filter(({ method }) => method === 'resident.provision')).toHaveLength(1)
  })

  it('recovers a definitive pre-effect completion with workspace identity reuse and a new lifecycle operation', async () => {
    const directory = await testDirectory()
    const selectedPath = path.join(directory, 'Workspace')
    const wrongPath = path.join(directory, 'Wrong-workspace')
    const payloads: Array<Record<string, unknown>> = []
    const firstConnection = new TestConnection((method, params) => {
      if (method === 'health.get') return health()
      if (method === 'resident.provision') {
        const payload = params as Record<string, unknown>
        payloads.push(payload)
        return completedProvisionStatus(payload)
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const first = await connectedService(
      directory,
      firstConnection,
      vi.fn().mockResolvedValue(selectedPath),
    )
    const originalSelection = await first.selectResidentWorkspace()
    await expect(first.provisionResident(provisionInput(originalSelection.selectionToken)))
      .resolves.toMatchObject({
        phase: 'completed',
        completionReason: 'owned_create_failed_before_effect',
      })
    await first.disconnect()

    const wrongHostPicker = vi.fn().mockResolvedValue(selectedPath)
    const wrongHostConnection = new TestConnection((method) => {
      if (method === 'health.get') return healthForHost('host-b')
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(wrongHostConnection)
    const wrongHostService = await serviceFor(directory, wrongHostPicker)
    await wrongHostService.connect({ kind: 'local' })
    await expect(wrongHostService.selectResidentWorkspace({
      resumeOperationId: originalSelection.operationId,
    })).rejects.toMatchObject({ code: 'resident.workspace_resume_authority_changed' })
    expect(wrongHostPicker).not.toHaveBeenCalled()
    await wrongHostService.disconnect()

    let activePayload: Record<string, unknown> | undefined
    let residentMutationCount = 0
    const recoveryConnection = new TestConnection((method, params) => {
      if (method === 'health.get') return health()
      if (method === 'resident.provision') {
        activePayload = params as Record<string, unknown>
        payloads.push(activePayload)
        if (String(activePayload.workspaceDirectory).endsWith('Wrong-workspace')) {
          throw new ControlError('host.workspace_bootstrap_conflict', 'wrong private path')
        }
        residentMutationCount += 1
        return provisionStatus(activePayload, 'committed')
      }
      if (method === 'resident.lifecycle.status') return { status: null }
      if (method === 'catalog.snapshot') return catalogFor(activePayload!)
      if (method === 'thread.snapshot') return threadSnapshotFor(activePayload!)
      throw new Error(`Unexpected request: ${method}`)
    })
    const recoveryPicker = vi.fn()
      .mockResolvedValueOnce(wrongPath)
      .mockResolvedValueOnce(selectedPath)
    connectLocalHostd.mockResolvedValue(recoveryConnection)
    const recovered = await serviceFor(directory, recoveryPicker)
    await recovered.connect({ kind: 'local' })

    const wrongSelection = await recovered.selectResidentWorkspace({
      resumeOperationId: originalSelection.operationId,
    })
    expect(wrongSelection.operationId).not.toBe(originalSelection.operationId)
    const requestsBeforeConflict = recoveryConnection.requests.length
    await expect(recovered.provisionResident({
      ...provisionInput(wrongSelection.selectionToken),
      projectDisplayName: 'Changed project',
    })).rejects.toMatchObject({ code: 'resident.provision_identity_conflict' })
    expect(recoveryConnection.requests).toHaveLength(requestsBeforeConflict)
    await expect(recovered.provisionResident(provisionInput(wrongSelection.selectionToken)))
      .rejects.toMatchObject({ code: 'resident.provision_outcome_unknown' })
    expect(residentMutationCount).toBe(0)

    const correctSelection = await recovered.selectResidentWorkspace({
      resumeOperationId: wrongSelection.operationId,
    })
    expect(correctSelection.operationId).toBe(wrongSelection.operationId)
    await expect(recovered.provisionResident(provisionInput(correctSelection.selectionToken)))
      .resolves.toMatchObject({ phase: 'committed' })
    expect(residentMutationCount).toBe(1)

    const [original, wrong, correct] = payloads
    expect(wrong?.operationId).not.toBe(original?.operationId)
    expect(correct?.operationId).toBe(wrong?.operationId)
    for (const key of [
      'projectId',
      'workspaceId',
      'threadId',
      'executionGenerationId',
      'projectDisplayName',
      'threadTitle',
      'createdAt',
    ]) {
      expect(wrong?.[key]).toBe(original?.[key])
      expect(correct?.[key]).toBe(original?.[key])
    }
    await expect(recovered.selectResidentWorkspace({
      resumeOperationId: correctSelection.operationId,
    })).rejects.toMatchObject({ code: 'resident.workspace_resume_not_allowed' })
    expect(recoveryPicker).toHaveBeenCalledTimes(2)
  })

  it('persists a path-free unknown ledger and reconciles after restart without runtime capability or replay', async () => {
    const directory = await testDirectory()
    const selectedPath = path.join(directory, 'private-restart-parent', 'Workspace')
    const firstConnection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      if (method === 'resident.provision') {
        throw new ControlError('transport.request_timeout', 'lost response', { retryable: true })
      }
      if (method === 'resident.lifecycle.status') {
        throw new ControlError('transport.request_timeout', 'status unavailable', { retryable: true })
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const first = await connectedService(
      directory,
      firstConnection,
      vi.fn().mockResolvedValue(selectedPath),
    )
    const selection = await first.selectResidentWorkspace()
    await expect(first.provisionResident(provisionInput(selection.selectionToken))).rejects.toMatchObject({
      code: 'resident.provision_outcome_unknown',
    })
    await first.disconnect()

    const secondConnection = new TestConnection((method) => {
      if (method === 'health.get') return health([])
      if (method === 'resident.lifecycle.status') return { status: null }
      throw new Error(`A restarted desktop must not replay ${method}`)
    })
    connectLocalHostd.mockResolvedValue(secondConnection)
    const restarted = await serviceFor(directory, vi.fn())
    expect((await restarted.bootstrap()).residentLifecycleOperations).toEqual([
      expect.objectContaining({
        operationId: selection.operationId,
        state: 'outcome_unknown',
      }),
    ])
    await restarted.connect({ kind: 'local' })
    await expect(restarted.residentLifecycleStatus({
      expectedHostId: selection.expectedHostId,
      operationId: selection.operationId,
    })).resolves.toEqual({ status: null })

    const after = await restarted.bootstrap()
    expect(after.residentLifecycleOperations).toEqual([
      expect.objectContaining({ operationId: selection.operationId, state: 'requires_reselection' }),
    ])
    expect(secondConnection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])
    expect(await readFile(path.join(directory, 'control', 'resident-lifecycle.json'), 'utf8'))
      .not.toContain('private-restart-parent')
  })
})

function provisionInput(selectionToken: string) {
  return {
    selectionToken,
    projectDisplayName: 'Workspace',
    threadTitle: 'New resident thread',
  }
}

function health(capabilities = ['resident_lifecycle_v1']) {
  return healthForHost('host-a', capabilities)
}

function healthForHost(hostId: string, capabilities = ['resident_lifecycle_v1']) {
  return {
    protocolVersion: 1,
    hostdVersion: '0.1.0',
    startedAt: '2026-08-08T11:59:00.000Z',
    checkedAt: timestamp,
    serviceState: 'ready',
    host: { hostId },
    capabilities,
  }
}

function completedProvisionStatus(payload: Record<string, unknown>): ResidentLifecycleStatus {
  return {
    ...provisionStatus(payload, 'prepared'),
    phase: 'completed',
    updatedAt: timestamp,
    completionReason: 'owned_create_failed_before_effect',
    terminalAt: timestamp,
  }
}

function provisionStatus(
  payload: Record<string, unknown>,
  phase: 'prepared' | 'committed',
  statusTimestamp = timestamp,
): ResidentLifecycleStatus {
  return {
    version: 1,
    kind: 'provision',
    operationId: String(payload.operationId),
    phase,
    expectedHostId: String(payload.expectedHostId),
    projectId: String(payload.projectId),
    workspaceId: String(payload.workspaceId),
    threadId: String(payload.threadId),
    executionGenerationId: String(payload.executionGenerationId),
    preparedAt: timestamp,
    updatedAt: statusTimestamp,
    ...(phase === 'committed' ? { terminalAt: statusTimestamp } : {}),
  }
}

function catalogFor(payload: Record<string, unknown>) {
  const thread = threadSummaryFor(payload)
  return {
    snapshotVersion: 1,
    generatedAt: timestamp,
    host: {
      hostId: String(payload.expectedHostId),
      displayName: 'Test host',
      kind: 'local',
      connectionPaths: [{ kind: 'local_socket', priority: 0, state: 'available' }],
      reachability: 'online',
      compatibility: 'compatible',
      platform: { os: 'windows', architecture: 'x64' },
      attentionCounts: { total: 0, unread: 0, questions: 0, approvals: 0 },
    },
    projects: [{
      projectId: String(payload.projectId),
      hostId: String(payload.expectedHostId),
      workspaceId: String(payload.workspaceId),
      displayName: String(payload.projectDisplayName),
      lastOpenedAt: timestamp,
    }],
    threads: [thread],
  }
}

function threadSummaryFor(payload: Record<string, unknown>) {
  const cursor = {
    threadId: String(payload.threadId),
    executionGenerationId: String(payload.executionGenerationId),
    generation: 'resident-generation-1',
    sequence: 0,
  }
  return {
    threadId: String(payload.threadId),
    title: String(payload.threadTitle),
    projectIdentity: String(payload.projectId),
    currentLocation: {
      hostId: String(payload.expectedHostId),
      projectId: String(payload.projectId),
      workspaceId: String(payload.workspaceId),
      executionGenerationId: String(payload.executionGenerationId),
    },
    status: 'idle',
    unread: false,
    updatedAt: timestamp,
    lastKnownCursor: cursor,
  }
}

function threadSnapshotFor(payload: Record<string, unknown>) {
  const thread = threadSummaryFor(payload)
  return {
    snapshotVersion: 1,
    generatedAt: timestamp,
    thread,
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
    latestCursor: thread.lastKnownCursor,
  }
}

function ledgerEntry(
  operationId: string,
  overrides: Partial<ResidentProvisionOperationView>,
): ResidentProvisionOperationView {
  return {
    kind: 'provision',
    operationId,
    expectedHostId: 'host-a',
    projectId: `project-${operationId}`,
    workspaceId: `workspace-${operationId}`,
    threadId: `thread-${operationId}`,
    executionGenerationId: `execution-${operationId}`,
    projectDisplayName: `Project ${operationId}`,
    threadTitle: `Thread ${operationId}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    state: 'outcome_unknown',
    ...overrides,
  }
}

function lifecycleStatusForOperation(
  operationId: string,
  phase: 'prepared' | 'owned_create_dispatching' | 'owned_observed' | 'promotion_dispatching' | 'promoted_observed' | 'projection_committed',
): ResidentLifecycleStatus {
  const entry = ledgerEntry(operationId, {})
  return {
    version: 1,
    kind: 'provision',
    operationId,
    phase,
    expectedHostId: entry.expectedHostId,
    projectId: entry.projectId,
    workspaceId: entry.workspaceId,
    threadId: entry.threadId,
    executionGenerationId: entry.executionGenerationId,
    preparedAt: timestamp,
    updatedAt: timestamp,
  }
}

function ledgerPayload(entry: ResidentProvisionOperationView): Record<string, unknown> {
  return {
    expectedHostId: entry.expectedHostId,
    operationId: entry.operationId,
    projectId: entry.projectId,
    workspaceId: entry.workspaceId,
    threadId: entry.threadId,
    executionGenerationId: entry.executionGenerationId,
    projectDisplayName: entry.projectDisplayName,
    threadTitle: entry.threadTitle,
    createdAt: entry.createdAt,
  }
}

async function writeResidentLedger(
  directory: string,
  entries: ResidentLifecycleOperationView[],
): Promise<void> {
  await writeFile(
    path.join(directory, 'control', 'resident-lifecycle.json'),
    JSON.stringify({ version: 1, entries }),
    'utf8',
  )
}

async function waitForResidentProjectionRefresh(service: DesktopControlService): Promise<void> {
  const operation = (service as unknown as { residentProjectionRefreshPromise?: Promise<void> })
    .residentProjectionRefreshPromise
  if (operation) await operation
}

async function connectedService(
  directory: string,
  connection: TestConnection,
  selectDirectory: () => Promise<string | undefined>,
): Promise<DesktopControlService> {
  connectLocalHostd.mockResolvedValue(connection)
  const service = await serviceFor(directory, selectDirectory)
  await service.connect({ kind: 'local' })
  return service
}

async function serviceFor(
  directory: string,
  selectDirectory: () => Promise<string | undefined>,
): Promise<DesktopControlService> {
  const service = new DesktopControlService({ app: testApp(directory), selectDirectory })
  services.push(service)
  return service
}

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'prime-resident-main-test-'))
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

async function withWallTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('wall timeout')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
