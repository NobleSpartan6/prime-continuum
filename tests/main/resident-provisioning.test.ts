import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from 'electron'
import type {
  ResidentEndOperationView,
  ResidentLifecycleOperationView,
  ResidentProvisionOperationView,
} from '../../src/main/control/contracts'
import type { ResidentLifecycleStatus, RuntimeIntegritySnapshot } from '../../src/shared/protocol'
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
  it('withholds the native picker before live seed-validation progress', async () => {
    const directory = await testDirectory()
    const picker = vi.fn()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return initializingHealth('preparing')
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(directory, connection, picker)

    await expect(service.preselectResidentWorkspace()).rejects.toMatchObject({
      code: 'resident.workspace_preselection_not_ready',
    })
    expect(picker).not.toHaveBeenCalled()
  })

  it('keeps an initializing-runtime workspace preselection path-private and converts it once after exact readiness', async () => {
    const directory = await testDirectory()
    const selectedPath = path.join(directory, 'private-preselection-parent', 'Workspace')
    await mkdir(selectedPath, { recursive: true })
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return initializingHealth('copying')
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(directory, connection, vi.fn().mockResolvedValue(selectedPath))

    const preselection = await service.preselectResidentWorkspace()
    expect(preselection).toEqual({
      preselectionToken: expect.any(String),
      suggestedName: 'Workspace',
      expiresAt: expect.any(String),
    })
    expect(JSON.stringify({ preselection, bootstrap: await service.bootstrap() }))
      .not.toContain('private-preselection-parent')
    await expect(service.completeResidentWorkspacePreselection(preselection.preselectionToken))
      .rejects.toMatchObject({ code: 'resident.lifecycle_unavailable' })

    markLocalRuntimeReady(service)
    const selection = await service.completeResidentWorkspacePreselection(preselection.preselectionToken)
    expect(selection).toMatchObject({ expectedHostId: 'host-a', suggestedName: 'Workspace' })
    await expect(service.completeResidentWorkspacePreselection(preselection.preselectionToken))
      .rejects.toMatchObject({ code: 'resident.workspace_preselection_consumed' })
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])
    await expect(readFile(path.join(directory, 'control', 'resident-lifecycle.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('revokes early workspace choices on supersession, cancellation, expiry, and connection change', async () => {
    const directory = await testDirectory()
    const firstPath = path.join(directory, 'First')
    const secondPath = path.join(directory, 'Second')
    await Promise.all([mkdir(firstPath), mkdir(secondPath)])
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return initializingHealth('verifying')
      throw new Error(`Unexpected request: ${method}`)
    })
    const picker = vi.fn().mockResolvedValueOnce(firstPath).mockResolvedValueOnce(secondPath).mockResolvedValue(secondPath)
    const service = await connectedService(directory, connection, picker)

    const first = await service.preselectResidentWorkspace()
    const second = await service.preselectResidentWorkspace()
    markLocalRuntimeReady(service)
    await expect(service.completeResidentWorkspacePreselection(first.preselectionToken))
      .rejects.toMatchObject({ code: 'resident.workspace_preselection_superseded' })

    service.cancelResidentWorkspacePreselection(second.preselectionToken)
    await expect(service.completeResidentWorkspacePreselection(second.preselectionToken))
      .rejects.toMatchObject({ code: 'resident.workspace_preselection_cancelled' })

    markLocalRuntimeInitializing(service, 'publishing')
    const expiring = await service.preselectResidentWorkspace()
    vi.setSystemTime(new Date(Date.parse(expiring.expiresAt) + 1))
    await expect(service.completeResidentWorkspacePreselection(expiring.preselectionToken))
      .rejects.toMatchObject({ code: 'resident.workspace_preselection_expired' })

    const authorityBound = await service.preselectResidentWorkspace()
    await service.disconnect()
    await expect(service.completeResidentWorkspacePreselection(authorityBound.preselectionToken))
      .rejects.toMatchObject({ code: 'resident.workspace_preselection_authority_changed' })
  })

  it('consumes without replay when the private directory identity changes before completion', async () => {
    const directory = await testDirectory()
    const selectedPath = path.join(directory, 'Workspace')
    const movedPath = path.join(directory, 'Workspace-before-replacement')
    await mkdir(selectedPath)
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return initializingHealth('copying')
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(directory, connection, vi.fn().mockResolvedValue(selectedPath))
    const preselection = await service.preselectResidentWorkspace()
    await rename(selectedPath, movedPath)
    await mkdir(selectedPath)
    markLocalRuntimeReady(service)

    await expect(service.completeResidentWorkspacePreselection(preselection.preselectionToken))
      .rejects.toMatchObject({ code: 'resident.workspace_selection_changed' })
    await expect(service.completeResidentWorkspacePreselection(preselection.preselectionToken))
      .rejects.toMatchObject({ code: 'resident.workspace_preselection_consumed' })
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])
  })

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

  it('provisions an exact saved SSH workspace without a picker, remote path, or renderer-authored project rename', async () => {
    const directory = await testDirectory()
    const picker = vi.fn()
    let provisionPayload: Record<string, unknown> | undefined
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health(['resident_registered_workspace_lifecycle_v1'])
      if (method === 'catalog.snapshot') return registeredCatalog(provisionPayload)
      if (method === 'thread.snapshot') {
        const threadId = String((params as Record<string, unknown>).threadId)
        return threadId === registeredReference.referenceThreadId
          ? registeredReferenceSnapshot()
          : threadSnapshotFor({
              ...provisionPayload!,
              projectDisplayName: 'Remote workspace',
              threadTitle: 'Remote resident thread',
            })
      }
      if (method === 'resident.provision.registered') {
        provisionPayload = params as Record<string, unknown>
        return provisionStatus(provisionPayload, 'committed')
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(directory, connection, picker)
    markAsRegisteredSsh(service)

    const selection = await service.selectResidentWorkspace({
      kind: 'registered_workspace',
      ...registeredReference,
    })
    await expect(service.provisionResident({
      selectionToken: selection.selectionToken,
      projectDisplayName: 'Renderer attempted rename',
      threadTitle: 'Remote resident thread',
    })).resolves.toMatchObject({ kind: 'provision', phase: 'committed' })

    expect(picker).not.toHaveBeenCalled()
    expect(provisionPayload).toEqual({
      expectedHostId: 'host-a',
      operationId: selection.operationId,
      projectId: registeredReference.projectId,
      workspaceId: registeredReference.workspaceId,
      referenceThreadId: registeredReference.referenceThreadId,
      referenceExecutionGenerationId: registeredReference.referenceExecutionGenerationId,
      threadId: expect.stringMatching(/^thread-/),
      executionGenerationId: expect.stringMatching(/^execution-/),
      threadTitle: 'Remote resident thread',
      createdAt: timestamp,
    })
    expect(JSON.stringify(provisionPayload)).not.toMatch(/workspaceDirectory|projectDisplayName|private/i)
    expect((await service.bootstrap()).residentLifecycleOperations).toEqual([
      expect.objectContaining({
        kind: 'provision',
        provisionMode: 'registered_workspace',
        projectDisplayName: 'Remote workspace',
        referenceThreadId: registeredReference.referenceThreadId,
        referenceExecutionGenerationId: registeredReference.referenceExecutionGenerationId,
        state: 'terminal',
      }),
    ])
  })

  it('starts another resident task in an exact saved local workspace without reopening the picker', async () => {
    const directory = await testDirectory()
    const picker = vi.fn()
    let provisionPayload: Record<string, unknown> | undefined
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health(['resident_lifecycle_v1'])
      if (method === 'catalog.snapshot') return registeredCatalog(provisionPayload)
      if (method === 'thread.snapshot') {
        const threadId = String((params as Record<string, unknown>).threadId)
        return threadId === registeredReference.referenceThreadId
          ? registeredReferenceSnapshot()
          : threadSnapshotFor({
              ...provisionPayload!,
              projectDisplayName: 'Remote workspace',
              threadTitle: 'Local follow-up task',
            })
      }
      if (method === 'resident.provision.registered') {
        provisionPayload = params as Record<string, unknown>
        return provisionStatus(provisionPayload, 'committed')
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(directory, connection, picker)

    const selection = await service.selectResidentWorkspace({
      kind: 'registered_workspace',
      ...registeredReference,
    })
    await expect(service.provisionResident({
      selectionToken: selection.selectionToken,
      projectDisplayName: 'Renderer attempted rename',
      threadTitle: 'Local follow-up task',
    })).resolves.toMatchObject({ kind: 'provision', phase: 'committed' })

    expect(picker).not.toHaveBeenCalled()
    expect(connection.requests.some(({ method }) => method === 'resident.provision.registered')).toBe(true)
  })

  it('fails closed when the saved donor changes between authoritative catalog and thread reads', async () => {
    const directory = await testDirectory()
    const picker = vi.fn()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health(['resident_registered_workspace_lifecycle_v1'])
      if (method === 'catalog.snapshot') return registeredCatalog()
      if (method === 'thread.snapshot') {
        const snapshot = registeredReferenceSnapshot()
        return {
          ...snapshot,
          thread: { ...snapshot.thread, title: 'Changed between reads' },
        }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(directory, connection, picker)
    markAsRegisteredSsh(service)

    await expect(service.selectResidentWorkspace({
      kind: 'registered_workspace',
      ...registeredReference,
    })).rejects.toMatchObject({ code: 'resident.registered_workspace_reference_changed' })
    expect(picker).not.toHaveBeenCalled()
    expect(connection.requests.filter(({ method }) => method === 'resident.provision.registered')).toEqual([])
  })

  it('invalidates saved-workspace selection when the exact connection generation drifts', async () => {
    const directory = await testDirectory()
    const picker = vi.fn()
    let service!: DesktopControlService
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health(['resident_registered_workspace_lifecycle_v1'])
      if (method === 'catalog.snapshot') {
        ;(service as unknown as { reconnectGeneration: number }).reconnectGeneration += 1
        return registeredCatalog()
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    service = await connectedService(directory, connection, picker)
    markAsRegisteredSsh(service)

    await expect(service.selectResidentWorkspace({
      kind: 'registered_workspace',
      ...registeredReference,
    })).rejects.toMatchObject({ code: 'connection.superseded' })
    expect(picker).not.toHaveBeenCalled()
    expect(connection.requests.filter(({ method }) => method === 'resident.provision.registered')).toEqual([])
  })

  it.each([
    'prepared',
    'promoted_observed',
    'projection_committed',
  ] as const)('continues the exact saved-workspace operation only after durable %s status', async (continuationPhase) => {
    const directory = await testDirectory()
    const picker = vi.fn()
    let provisionPayload: Record<string, unknown> | undefined
    let provisionAttempts = 0
    let statusAvailable = false
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health(['resident_registered_workspace_lifecycle_v1'])
      if (method === 'catalog.snapshot') return registeredCatalog()
      if (method === 'thread.snapshot') return registeredReferenceSnapshot()
      if (method === 'resident.provision.registered') {
        provisionAttempts += 1
        if (!provisionPayload) provisionPayload = params as Record<string, unknown>
        expect(params).toEqual(provisionPayload)
        if (provisionAttempts === 1) throw new Error('response lost')
        return provisionStatus(provisionPayload, continuationPhase)
      }
      if (method === 'resident.lifecycle.status') {
        return {
          status: statusAvailable && provisionPayload
            ? provisionStatus(provisionPayload, continuationPhase)
            : null,
        }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(directory, connection, picker)
    markAsRegisteredSsh(service)
    const selectionInput = { kind: 'registered_workspace' as const, ...registeredReference }
    const selection = await service.selectResidentWorkspace(selectionInput)
    const provision = {
      selectionToken: selection.selectionToken,
      projectDisplayName: 'Remote workspace',
      threadTitle: 'Remote resident thread',
    }

    await expect(service.provisionResident(provision)).rejects.toMatchObject({
      code: 'resident.provision_outcome_unknown',
    })
    await expect(service.provisionResident(provision)).rejects.toMatchObject({
      code: 'resident.registered_workspace_replay_blocked',
    })
    statusAvailable = true
    markAsRegisteredSsh(service, [])
    await expect(service.residentLifecycleStatus({
      expectedHostId: 'host-a',
      operationId: selection.operationId,
    })).resolves.toMatchObject({ status: expect.objectContaining({ phase: continuationPhase }) })
    await expect(service.provisionResident(provision)).rejects.toMatchObject({
      code: 'resident.registered_workspace_unavailable',
    })
    markAsRegisteredSsh(service)
    const resumed = await service.selectResidentWorkspace({
      ...selectionInput,
      resumeOperationId: selection.operationId,
    })
    expect(resumed.operationId).toBe(selection.operationId)
    await expect(service.provisionResident({
      ...provision,
      selectionToken: resumed.selectionToken,
    })).resolves.toMatchObject({ phase: continuationPhase })
    expect(connection.requests.filter(({ method }) => method === 'resident.provision.registered')).toHaveLength(2)
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
      details: { durableOperationPossible: false },
    })
    vi.setSystemTime(new Date(Date.parse(second.expiresAt) + 1))
    await expect(service.provisionResident(provisionInput(second.selectionToken))).rejects.toMatchObject({
      code: 'resident.workspace_selection_expired',
      details: { durableOperationPossible: false },
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
      details: { durableOperationPossible: true },
    })
    expect(connection.requests.map(({ method }) => method)).toEqual([
      'health.get',
      'resident.provision',
      'resident.lifecycle.status',
    ])
    await expect(service.provisionResident({ ...exact, threadTitle: 'Changed retry' })).rejects.toMatchObject({
      code: 'resident.provision_identity_conflict',
      details: {
        durableOperationPossible: true,
        expectedProjectDisplayName: 'Workspace',
        expectedThreadTitle: 'New resident thread',
      },
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
    })).rejects.toMatchObject({
      code: 'resident.provision_label_invalid',
      details: { durableOperationPossible: false },
    })
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])
    await expect(readFile(path.join(directory, 'control', 'resident-lifecycle.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('shares one queued pre-admission failure across exact joiners after generation replacement', async () => {
    const directory = await testDirectory()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`A superseded queued provision must not dispatch ${method}`)
    })
    const service = await connectedService(
      directory,
      connection,
      vi.fn().mockResolvedValue(path.join(directory, 'Workspace')),
    )
    const selection = await service.selectResidentWorkspace()
    const store = residentLedgerStore(service)
    const ledgerGate = deferred<void>()
    store.tail = ledgerGate.promise
    const update = vi.spyOn(store, 'update')

    const first = service.provisionResident(provisionInput(selection.selectionToken))
    await waitForLedgerOperationToQueue(store, ledgerGate.promise)
    ;(service as unknown as { reconnectGeneration: number }).reconnectGeneration += 1
    const second = service.provisionResident(provisionInput(selection.selectionToken))
    const third = service.provisionResident(provisionInput(selection.selectionToken))
    ledgerGate.resolve()

    const errors = await rejectedValues([first, second, third])
    for (const error of errors) {
      expect(error).toMatchObject({
        code: 'connection.superseded',
        details: { durableOperationPossible: false },
      })
    }
    expect(update).toHaveBeenCalledOnce()
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])
    await expect(readFile(path.join(directory, 'control', 'resident-lifecycle.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    { existing: false, durableOperationPossible: false },
    { existing: true, durableOperationPossible: true },
  ])(
    'classifies a definite pre-rename write failure with existing=$existing as durable=$durableOperationPossible',
    async ({ existing, durableOperationPossible }) => {
      const directory = await testDirectory()
      const connection = new TestConnection((method) => {
        if (method === 'health.get') return health()
        throw new Error(`A definite ledger failure must not dispatch ${method}`)
      })
      const service = await connectedService(
        directory,
        connection,
        vi.fn().mockResolvedValue(path.join(directory, 'Workspace')),
      )
      const selection = await service.selectResidentWorkspace()
      const record = residentSelectionRecord(service, selection.selectionToken)
      if (existing) {
        await writeResidentLedger(directory, [provisionEntryForSelection(record)])
      }
      const store = residentLedgerStore(service)
      vi.spyOn(store, 'writeUnqueued').mockRejectedValue(new ControlError(
        'storage.write_limit',
        'The value is too large for the native cache.',
        { details: { stage: 'before_rename' } },
      ))

      await expect(service.provisionResident(provisionInput(selection.selectionToken))).rejects.toMatchObject({
        code: 'storage.write_limit',
        details: {
          durableOperationPossible,
          stage: 'before_rename',
        },
      })
      expect(record.durableOperationPossible).toBe(durableOperationPossible)
      expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])
    },
  )

  it('classifies a post-rename commit uncertainty as durable for every exact joiner', async () => {
    const directory = await testDirectory()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`An uncertain admission must not dispatch ${method}`)
    })
    const service = await connectedService(
      directory,
      connection,
      vi.fn().mockResolvedValue(path.join(directory, 'Workspace')),
    )
    const selection = await service.selectResidentWorkspace()
    const store = residentLedgerStore(service)
    const syncStarted = deferred<void>()
    const syncGate = deferred<void>()
    store.options.syncParentDirectory = async () => {
      syncStarted.resolve()
      await syncGate.promise
    }

    const first = service.provisionResident(provisionInput(selection.selectionToken))
    await syncStarted.promise
    const second = service.provisionResident(provisionInput(selection.selectionToken))
    const third = service.provisionResident(provisionInput(selection.selectionToken))
    syncGate.reject(new Error('directory fsync failed'))

    const errors = await rejectedValues([first, second, third])
    for (const error of errors) {
      expect(error).toMatchObject({
        code: 'storage.commit_uncertain',
        details: {
          durableOperationPossible: true,
          file: 'resident-lifecycle.json',
        },
      })
    }
    expect(residentSelectionRecord(service, selection.selectionToken).durableOperationPossible).toBe(true)
    expect(await readFile(path.join(directory, 'control', 'resident-lifecycle.json'), 'utf8'))
      .toContain(selection.operationId)
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])
  })

  it('keeps a terminal selection joinable until its shared projection refresh settles', async () => {
    const directory = await testDirectory()
    const catalogStarted = deferred<void>()
    const catalogGate = deferred<unknown>()
    let payload: Record<string, unknown> | undefined
    const connection = new TestConnection((method, params) => {
      if (method === 'health.get') return health()
      if (method === 'resident.provision') {
        payload = params as Record<string, unknown>
        return provisionStatus(payload, 'committed')
      }
      if (method === 'catalog.snapshot') {
        catalogStarted.resolve()
        return catalogGate.promise
      }
      if (method === 'thread.snapshot') return threadSnapshotFor(payload!)
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(
      directory,
      connection,
      vi.fn().mockResolvedValue(path.join(directory, 'Workspace')),
    )
    const selection = await service.selectResidentWorkspace()
    const input = provisionInput(selection.selectionToken)
    const first = service.provisionResident(input)
    await catalogStarted.promise

    const joined = service.provisionResident(input)
    catalogGate.resolve(catalogFor(payload!))
    const [firstStatus, joinedStatus] = await Promise.all([first, joined])

    expect(joinedStatus).toEqual(firstStatus)
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toHaveLength(1)
    expect(connection.requests.filter(({ method }) => method === 'catalog.snapshot')).toHaveLength(1)
    await expect(service.provisionResident(input)).rejects.toMatchObject({
      code: 'resident.workspace_selection_completed',
    })
  })

  it('bounds selection retirement when every older selection is still in flight', async () => {
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
    const original = residentSelectionRecord(service, selection.selectionToken)
    const selections = residentSelectionMap(service)
    selections.clear()
    const neverSettles = new Promise<ResidentLifecycleStatus>(() => undefined)
    for (let index = 0; index < 32; index += 1) {
      const selectionToken = `active-selection-${index}`
      selections.set(selectionToken, {
        ...original,
        selectionToken,
        selection: { ...original.selection, selectionToken },
        inFlight: neverSettles,
      })
    }
    const overflowToken = 'overflow-selection'
    selections.set(overflowToken, {
      ...original,
      selectionToken: overflowToken,
      selection: { ...original.selection, selectionToken: overflowToken },
      inFlight: undefined,
    })

    enforceResidentSelectionLimit(service)

    expect(selections.size).toBe(32)
    expect(selections.has(overflowToken)).toBe(false)
    expect([...selections.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pendingRetirement: 'superseded', inFlight: neverSettles }),
      ]),
    )
  })

  it('uses a matching refresh-pending completed End to evict its committed provision first', async () => {
    const directory = await testDirectory()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`Capacity admission must not dispatch ${method}`)
    })
    const service = await connectedService(
      directory,
      connection,
      vi.fn().mockResolvedValue(path.join(directory, 'Workspace')),
    )
    const selection = await service.selectResidentWorkspace()
    const record = residentSelectionRecord(service, selection.selectionToken)
    const committed = committedProvisionEntry('committed-before-end', 'terminal_refresh_pending')
    const end = completedEndEntry('refresh-pending-end', committed, 'terminal_refresh_pending')
    const locked = Array.from({ length: 126 }, (_, index) => ledgerEntry(`locked-pending-${index}`, {}))
    await writeResidentLedger(directory, [end, committed, ...locked])

    await recordResidentSubmission(service, record)

    const operations = (await service.bootstrap()).residentLifecycleOperations
    expect(operations).toHaveLength(128)
    expect(operations.some(({ operationId }) => operationId === committed.operationId)).toBe(false)
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: end.operationId, state: 'terminal_refresh_pending' }),
      expect.objectContaining({ operationId: selection.operationId, state: 'submitted' }),
    ]))
  })

  it('retains a terminal End until its committed provision is removed, then evicts the End next', async () => {
    const directory = await testDirectory()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`Capacity admission must not dispatch ${method}`)
    })
    const picker = vi.fn().mockResolvedValue(path.join(directory, 'Workspace'))
    const service = await connectedService(directory, connection, picker)
    const committed = committedProvisionEntry('committed-release-order')
    const end = completedEndEntry('terminal-end-proof', committed, 'terminal')
    const locked = Array.from({ length: 125 }, (_, index) => ledgerEntry(`locked-order-${index}`, {}))
    await writeResidentLedger(directory, [end, committed, ...locked])

    const first = await service.selectResidentWorkspace()
    await recordResidentSubmission(service, residentSelectionRecord(service, first.selectionToken))
    const second = await service.selectResidentWorkspace()
    await recordResidentSubmission(service, residentSelectionRecord(service, second.selectionToken))
    const afterProvisionEviction = (await service.bootstrap()).residentLifecycleOperations
    expect(afterProvisionEviction.some(({ operationId }) => operationId === committed.operationId)).toBe(false)
    expect(afterProvisionEviction.some(({ operationId }) => operationId === end.operationId)).toBe(true)

    const third = await service.selectResidentWorkspace()
    await recordResidentSubmission(service, residentSelectionRecord(service, third.selectionToken))
    const afterEndEviction = (await service.bootstrap()).residentLifecycleOperations
    expect(afterEndEviction).toHaveLength(128)
    expect(afterEndEviction.some(({ operationId }) => operationId === end.operationId)).toBe(false)
    expect(afterEndEviction).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: first.operationId }),
      expect.objectContaining({ operationId: second.operationId }),
      expect.objectContaining({ operationId: third.operationId }),
    ]))
  })

  it('evicts a terminal pre-effect provision completion at capacity', async () => {
    const directory = await testDirectory()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`Capacity admission must not dispatch ${method}`)
    })
    const service = await connectedService(
      directory,
      connection,
      vi.fn().mockResolvedValue(path.join(directory, 'Workspace')),
    )
    const selection = await service.selectResidentWorkspace()
    const completed = completedPreEffectProvisionEntry('completed-before-effect')
    const locked = Array.from({ length: 127 }, (_, index) => ledgerEntry(`locked-completed-${index}`, {}))
    await writeResidentLedger(directory, [completed, ...locked])

    await recordResidentSubmission(service, residentSelectionRecord(service, selection.selectionToken))

    const operations = (await service.bootstrap()).residentLifecycleOperations
    expect(operations).toHaveLength(128)
    expect(operations.some(({ operationId }) => operationId === completed.operationId)).toBe(false)
    expect(operations.some(({ operationId }) => operationId === selection.operationId)).toBe(true)
  })

  it('keeps quarantined and outcome-unknown entries locked when the ledger is full', async () => {
    const directory = await testDirectory()
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      throw new Error(`A full locked ledger must not dispatch ${method}`)
    })
    const service = await connectedService(
      directory,
      connection,
      vi.fn().mockResolvedValue(path.join(directory, 'Workspace')),
    )
    const selection = await service.selectResidentWorkspace()
    const quarantined = quarantinedEndEntry('quarantined-end')
    const unknown = Array.from({ length: 127 }, (_, index) => ledgerEntry(`locked-unknown-${index}`, {}))
    await writeResidentLedger(directory, [quarantined, ...unknown])

    await expect(service.provisionResident(provisionInput(selection.selectionToken))).rejects.toMatchObject({
      code: 'resident.lifecycle_ledger_full',
      details: { durableOperationPossible: false },
    })

    const operations = (await service.bootstrap()).residentLifecycleOperations
    expect(operations).toHaveLength(128)
    expect(operations.some(({ operationId }) => operationId === quarantined.operationId)).toBe(true)
    expect(operations.some(({ operationId }) => operationId === selection.operationId)).toBe(false)
    expect(connection.requests.filter(({ method }) => method === 'resident.provision')).toEqual([])
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
      provisionMode: 'local_path',
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

    // The unresolved catalog gate is the causal proof: connect must settle
    // without waiting for the background projection refresh it schedules.
    await expect(service.connect({ kind: 'local' }))
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

const registeredReference = {
  projectId: 'project-remote',
  workspaceId: 'workspace-remote',
  referenceThreadId: 'thread-reference',
  referenceExecutionGenerationId: 'execution-reference',
}

function markAsRegisteredSsh(
  service: DesktopControlService,
  capabilities = ['resident_registered_workspace_lifecycle_v1'],
): void {
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

function registeredCatalog(provisionPayload?: Record<string, unknown>) {
  const referencePayload = {
    expectedHostId: 'host-a',
    projectId: registeredReference.projectId,
    workspaceId: registeredReference.workspaceId,
    threadId: registeredReference.referenceThreadId,
    executionGenerationId: registeredReference.referenceExecutionGenerationId,
    projectDisplayName: 'Remote workspace',
    threadTitle: 'Reference thread',
  }
  const referenceThread = threadSummaryFor(referencePayload)
  return {
    snapshotVersion: 1,
    generatedAt: timestamp,
    host: {
      hostId: 'host-a',
      displayName: 'Remote host',
      kind: 'ssh',
      connectionPaths: [{ kind: 'ssh', priority: 0, state: 'available' }],
      reachability: 'online',
      compatibility: 'compatible',
      platform: { os: 'linux', architecture: 'x64' },
      attentionCounts: { total: 0, unread: 0, questions: 0, approvals: 0 },
    },
    projects: [{
      projectId: registeredReference.projectId,
      hostId: 'host-a',
      workspaceId: registeredReference.workspaceId,
      displayName: 'Remote workspace',
      lastOpenedAt: timestamp,
    }],
    threads: [
      referenceThread,
      ...(provisionPayload
        ? [threadSummaryFor({
            ...provisionPayload,
            projectDisplayName: 'Remote workspace',
            threadTitle: 'Remote resident thread',
          })]
        : []),
    ],
  }
}

function registeredReferenceSnapshot() {
  return threadSnapshotFor({
    expectedHostId: 'host-a',
    projectId: registeredReference.projectId,
    workspaceId: registeredReference.workspaceId,
    threadId: registeredReference.referenceThreadId,
    executionGenerationId: registeredReference.referenceExecutionGenerationId,
    projectDisplayName: 'Remote workspace',
    threadTitle: 'Reference thread',
  })
}

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
  const runtimeIntegrity: RuntimeIntegritySnapshot = {
    contractVersion: 1,
    status: 'ready',
    changedAt: timestamp,
    trustAnchorId: 'a'.repeat(64),
    target: {
      runtime: 'prime-agent',
      releaseVersion: '0.7.1',
      runtimeBuildId: 'resident-test-runtime',
      platform: process.platform,
      arch: process.arch,
      manifestSha256: 'a'.repeat(64),
      treeSha256: 'b'.repeat(64),
      filesSha256: 'c'.repeat(64),
    },
    assurance: 'development-integrity',
  }
  return {
    protocolVersion: 1,
    hostdVersion: '0.1.0',
    startedAt: '2026-08-08T11:59:00.000Z',
    checkedAt: timestamp,
    serviceState: 'ready',
    host: { hostId },
    capabilities: [...capabilities, 'runtime_integrity_v1'],
    runtimeIntegrity,
  }
}

function initializingHealth(phase: 'preparing' | 'validating_seed' | 'copying' | 'verifying' | 'publishing') {
  const ready = healthForHost('host-a', [])
  const { assurance: _assurance, ...runtime } = ready.runtimeIntegrity
  const runtimeIntegrity: RuntimeIntegritySnapshot = {
    ...runtime,
    status: 'initializing',
    phase,
    attempt: 1,
  }
  return {
    ...ready,
    serviceState: 'starting',
    capabilities: ['runtime_integrity_v1'],
    runtimeIntegrity,
  }
}

function markLocalRuntimeReady(service: DesktopControlService): void {
  const ready = healthForHost('host-a')
  const runtimeReadiness = {
    kind: 'reported' as const,
    hostId: 'host-a',
    hostdVersion: ready.hostdVersion,
    startedAt: ready.startedAt,
    observedAt: timestamp,
    snapshot: ready.runtimeIntegrity,
  }
  const mutable = service as unknown as {
    authorityCapabilities: string[]
    authorityRuntimeReadiness: typeof runtimeReadiness
    state: ReturnType<DesktopControlService['getConnectionState']>
  }
  mutable.authorityCapabilities = ready.capabilities
  mutable.authorityRuntimeReadiness = runtimeReadiness
  mutable.state = { ...mutable.state, capabilities: ready.capabilities, runtimeReadiness }
}

function markLocalRuntimeInitializing(
  service: DesktopControlService,
  phase: 'validating_seed' | 'copying' | 'verifying' | 'publishing',
): void {
  const initializing = initializingHealth(phase)
  const runtimeReadiness = {
    kind: 'reported' as const,
    hostId: 'host-a',
    hostdVersion: initializing.hostdVersion,
    startedAt: initializing.startedAt,
    observedAt: timestamp,
    snapshot: initializing.runtimeIntegrity,
  }
  const mutable = service as unknown as {
    authorityCapabilities: string[]
    authorityRuntimeReadiness: typeof runtimeReadiness
    state: ReturnType<DesktopControlService['getConnectionState']>
  }
  mutable.authorityCapabilities = initializing.capabilities
  mutable.authorityRuntimeReadiness = runtimeReadiness
  mutable.state = { ...mutable.state, capabilities: initializing.capabilities, runtimeReadiness }
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
  phase: 'prepared' | 'promoted_observed' | 'projection_committed' | 'committed',
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
    provisionMode: 'local_path',
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

interface TestResidentSelectionRecord {
  provisionMode: 'local_path' | 'registered_workspace'
  selectionToken: string
  selection: {
    selectionToken: string
    operationId: string
    expectedHostId: string
    suggestedName: string
    expiresAt: string
  }
  authority: unknown
  projectId: string
  workspaceId: string
  threadId: string
  executionGenerationId: string
  createdAt: string
  durableOperationPossible: boolean
  pendingRetirement?: 'expired' | 'superseded' | 'authority_changed' | 'terminal'
  inFlight?: Promise<ResidentLifecycleStatus>
}

interface TestResidentLedgerStore {
  tail: Promise<void>
  options: {
    syncParentDirectory?: (directory: string) => Promise<void>
  }
  update(update: (current: unknown) => unknown | Promise<unknown>): Promise<unknown>
  writeUnqueued(value: unknown): Promise<void>
}

function residentSelectionMap(
  service: DesktopControlService,
): Map<string, TestResidentSelectionRecord> {
  return (service as unknown as {
    residentWorkspaceSelections: Map<string, TestResidentSelectionRecord>
  }).residentWorkspaceSelections
}

function residentSelectionRecord(
  service: DesktopControlService,
  selectionToken: string,
): TestResidentSelectionRecord {
  const record = residentSelectionMap(service).get(selectionToken)
  if (!record) throw new Error(`Missing test selection record: ${selectionToken}`)
  return record
}

function residentLedgerStore(service: DesktopControlService): TestResidentLedgerStore {
  return (service as unknown as { residentLifecycleLedger: TestResidentLedgerStore })
    .residentLifecycleLedger
}

function enforceResidentSelectionLimit(service: DesktopControlService): void {
  ;(service as unknown as { enforceResidentSelectionLimit(): void }).enforceResidentSelectionLimit()
}

async function recordResidentSubmission(
  service: DesktopControlService,
  record: TestResidentSelectionRecord,
): Promise<void> {
  await (service as unknown as {
    recordResidentLifecycleSubmission(
      record: unknown,
      metadata: { projectDisplayName: string; threadTitle: string },
    ): Promise<void>
  }).recordResidentLifecycleSubmission(record, {
    projectDisplayName: 'Workspace',
    threadTitle: 'New resident thread',
  })
}

function provisionEntryForSelection(
  record: TestResidentSelectionRecord,
): ResidentProvisionOperationView {
  return {
    kind: 'provision',
    provisionMode: 'local_path',
    operationId: record.selection.operationId,
    expectedHostId: record.selection.expectedHostId,
    projectId: record.projectId,
    workspaceId: record.workspaceId,
    threadId: record.threadId,
    executionGenerationId: record.executionGenerationId,
    projectDisplayName: 'Workspace',
    threadTitle: 'New resident thread',
    createdAt: record.createdAt,
    updatedAt: timestamp,
    state: 'submitted',
  }
}

function committedProvisionEntry(
  operationId: string,
  state: 'terminal_refresh_pending' | 'terminal' = 'terminal',
): ResidentProvisionOperationView {
  const entry = ledgerEntry(operationId, {})
  return {
    ...entry,
    state,
    lastStatus: provisionStatus(ledgerPayload(entry), 'committed'),
  }
}

function completedPreEffectProvisionEntry(operationId: string): ResidentProvisionOperationView {
  const entry = ledgerEntry(operationId, {})
  return {
    ...entry,
    state: 'terminal',
    lastStatus: completedProvisionStatus(ledgerPayload(entry)),
  }
}

function completedEndEntry(
  operationId: string,
  lineage: ResidentProvisionOperationView,
  state: 'terminal_refresh_pending' | 'terminal',
): ResidentEndOperationView {
  const lastStatus: ResidentLifecycleStatus = {
    version: 1,
    kind: 'end',
    operationId,
    phase: 'completed',
    expectedHostId: lineage.expectedHostId,
    projectId: lineage.projectId,
    workspaceId: lineage.workspaceId,
    threadId: lineage.threadId,
    executionGenerationId: lineage.executionGenerationId,
    preparedAt: timestamp,
    updatedAt: timestamp,
    terminalAt: timestamp,
  }
  return {
    kind: 'end',
    operationId,
    expectedHostId: lineage.expectedHostId,
    projectId: lineage.projectId,
    workspaceId: lineage.workspaceId,
    threadId: lineage.threadId,
    executionGenerationId: lineage.executionGenerationId,
    sourceCursor: {
      threadId: lineage.threadId,
      executionGenerationId: lineage.executionGenerationId,
      generation: `cursor-${operationId}`,
      sequence: 1,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    state,
    lastStatus,
  }
}

function quarantinedEndEntry(operationId: string): ResidentEndOperationView {
  const lineage = ledgerEntry(`lineage-${operationId}`, {})
  const lastStatus: ResidentLifecycleStatus = {
    version: 1,
    kind: 'end',
    operationId,
    phase: 'quarantined',
    expectedHostId: lineage.expectedHostId,
    projectId: lineage.projectId,
    workspaceId: lineage.workspaceId,
    threadId: lineage.threadId,
    executionGenerationId: lineage.executionGenerationId,
    preparedAt: timestamp,
    updatedAt: timestamp,
    quarantinedFrom: 'kill_dispatching',
    quarantineReason: 'external_outcome_unknown',
  }
  return {
    kind: 'end',
    operationId,
    expectedHostId: lineage.expectedHostId,
    projectId: lineage.projectId,
    workspaceId: lineage.workspaceId,
    threadId: lineage.threadId,
    executionGenerationId: lineage.executionGenerationId,
    sourceCursor: {
      threadId: lineage.threadId,
      executionGenerationId: lineage.executionGenerationId,
      generation: `cursor-${operationId}`,
      sequence: 1,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    state: 'terminal',
    lastStatus,
  }
}

async function rejectedValues<T>(promises: Promise<T>[]): Promise<unknown[]> {
  return await Promise.all(promises.map(async (promise) => await promise.then(
    () => {
      throw new Error('Expected the operation to reject.')
    },
    (error: unknown) => error,
  )))
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
