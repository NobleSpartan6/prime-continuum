// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import App from '../../src/renderer/src/App'
import {
  createPreviewRendererApi,
  previewSnapshot,
  StaleHostAuthorityError,
  type HostRuntimeReadiness,
  type LocalSetupSummary,
  type RendererApi,
  type ResidentLifecycleOperationSummary,
  type RuntimeModelCatalog,
  type WorkbenchSnapshot,
} from '../../src/renderer/src/api'
import type { HudMode, HudState, HudTarget } from '../../src/shared/window-control'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function asNativeFixture<T extends RendererApi>(api: T): T {
  Object.defineProperty(api, 'environment', { configurable: true, value: 'native' })
  return api
}

function createNativeUiFixture(): RendererApi {
  const api = asNativeFixture(createPreviewRendererApi())
  const discoverComputers = api.discoverComputers.bind(api)
  const probeComputer = api.probeComputer.bind(api)
  const verified = <T extends Awaited<ReturnType<RendererApi['probeComputer']>>>(computer: T): T => ({
    ...computer,
    fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  })
  api.discoverComputers = async () => (await discoverComputers()).map(verified)
  api.probeComputer = async (input) => verified(await probeComputer(input))
  return api
}

function createHostActivationHarness() {
  const api = asNativeFixture(createPreviewRendererApi())
  const base = structuredClone(previewSnapshot)
  const activationReply = deferred<WorkbenchSnapshot>()
  const listeners = new Set<(next: WorkbenchSnapshot) => void>()
  const snapshotFor = (
    connection: WorkbenchSnapshot['hosts'][number]['connection'],
    activationRequired = false,
  ): WorkbenchSnapshot => {
    const snapshot = structuredClone(base)
    const thread = snapshot.threads.find((candidate) => candidate.id === 'thread-seamless')
    const host = snapshot.hosts.find((candidate) => candidate.id === thread?.hostId)
    if (!thread || !host || !snapshot.runtime.session) throw new Error('Expected the SSH resident fixture')
    snapshot.selectedThreadId = thread.id
    snapshot.selectedProjectId = thread.projectId
    thread.status = 'idle'
    thread.executionGenerationId = 'generation-activation-one'
    thread.workspaceId = 'workspace-activation-one'
    host.name = 'Build computer'
    host.kind = 'ssh'
    host.connection = connection
    host.connectionPath = 'SSH'
    host.activationRequired = activationRequired || undefined
    snapshot.runtime.session = {
      ...snapshot.runtime.session,
      residency: 'resident',
      activeSessionId: 'active-activation-one',
      sessionId: 'session-activation-one',
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      queuedActionCount: 0,
    }
    snapshot.runtime.queue = { pendingCount: 0, paused: false }
    const writable = connection === 'online' && !activationRequired
    snapshot.operations = {
      submitCommands: writable,
      startResidentTurn: writable,
      stopResidentTurn: false,
      crossHostHandoff: false,
    }
    snapshot.composerReceipt = writable
      ? { state: 'idle', message: 'Ready for a new prompt' }
      : { state: 'waiting_for_connection', message: 'Waiting for connection' }
    return snapshot
  }
  let current = snapshotFor('online')
  api.loadWorkbench = vi.fn(async () => structuredClone(current))
  api.subscribe = vi.fn((listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  })
  api.activateComputer = vi.fn(() => activationReply.promise)
  api.selectThread = vi.fn(async () => undefined)
  api.sendComposer = vi.fn(async () => ({ state: 'sent', message: 'Sent' }))
  const publish = (next: WorkbenchSnapshot) => {
    current = structuredClone(next)
    listeners.forEach((listener) => listener(structuredClone(current)))
  }
  return {
    api: api as RendererApi,
    activationReply,
    snapshotFor,
    publish,
  }
}

function withLargeModelCatalog(catalog: RuntimeModelCatalog): RuntimeModelCatalog {
  const providers = catalog.providers.slice(0, 2).map((provider) => ({
    ...provider,
    configured: true,
    modelCount: 90,
    availableModelCount: 90,
  }))
  const template = catalog.models.find((model) => model.available)!
  return {
    ...catalog,
    providers,
    models: Array.from({ length: 180 }, (_, index) => {
      const provider = providers[index < 90 ? 0 : 1]!
      const sequence = String(index + 1).padStart(3, '0')
      return {
        ...template,
        providerId: provider.providerId,
        modelId: `catalog-model-${sequence}`,
        name: `Catalog model ${sequence}`,
        available: true,
        usingOAuth: provider.oauthSupported,
      }
    }),
  }
}

function createIdleResidentApi() {
  const api = createPreviewRendererApi()
  const loadWorkbench = api.loadWorkbench.bind(api)
  api.loadWorkbench = async () => {
    const snapshot = await loadWorkbench()
    const thread = snapshot.threads.find((candidate) => candidate.id === 'thread-complete')
    const host = snapshot.hosts.find((candidate) => candidate.id === thread?.hostId)
    if (!thread || !host || !snapshot.runtime.session) throw new Error('Expected the resident preview fixture')
    snapshot.selectedThreadId = thread.id
    snapshot.selectedProjectId = thread.projectId
    thread.status = 'idle'
    host.connection = 'online'
    snapshot.runtime.session = {
      ...snapshot.runtime.session,
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      queuedActionCount: 0,
    }
    snapshot.runtime.queue = { pendingCount: 0, paused: false }
    snapshot.operations = {
      ...snapshot.operations,
      submitCommands: true,
      startResidentTurn: true,
      stopResidentTurn: false,
    }
    snapshot.composerReceipt = { state: 'idle', message: 'Ready for a new prompt' }
    return snapshot
  }
  return api
}

function createHudHarness(options: {
  taskState?: WorkbenchSnapshot['threads'][number]['status']
  connection?: WorkbenchSnapshot['hosts'][number]['connection']
  targetGenerationId?: string
} = {}) {
  const api = asNativeFixture(createPreviewRendererApi())
  const snapshot = structuredClone(previewSnapshot)
  const thread = snapshot.threads.find((candidate) => candidate.id === 'thread-seamless')
  const host = snapshot.hosts.find((candidate) => candidate.id === thread?.hostId)
  if (!thread || !host || !snapshot.runtime.session) throw new Error('Expected the HUD resident fixture')
  thread.executionGenerationId = 'generation-hud-one'
  thread.workspaceId = 'workspace-hud-one'
  thread.status = options.taskState ?? 'idle'
  host.connection = options.connection ?? 'online'
  snapshot.selectedThreadId = thread.id
  snapshot.selectedProjectId = thread.projectId
  snapshot.runtime.session = {
    ...snapshot.runtime.session,
    residency: 'resident',
    activeSessionId: 'active-hud-one',
    sessionId: 'session-hud-one',
    isStreaming: thread.status === 'running',
  }
  snapshot.operations = {
    ...snapshot.operations,
    submitCommands: true,
    startResidentTurn: thread.status === 'idle',
    stopResidentTurn: thread.status === 'running',
  }
  snapshot.composerReceipt = { state: 'idle', message: 'Ready for a new prompt' }

  const target: HudTarget = {
    expectedHostId: host.id,
    threadId: thread.id,
    expectedExecutionGenerationId: options.targetGenerationId ?? thread.executionGenerationId,
  }
  let state: HudState = { state: 'expanded', target, ignoresMouseEvents: false }
  const workbenchListeners = new Set<(next: WorkbenchSnapshot) => void>()
  const hudListeners = new Set<(next: HudState) => void>()
  api.loadWorkbench = vi.fn(async () => structuredClone(snapshot))
  api.subscribe = vi.fn((listener) => {
    workbenchListeners.add(listener)
    return () => workbenchListeners.delete(listener)
  })
  api.hudState = vi.fn(async () => state)
  api.hudOpen = vi.fn(async (nextTarget) => {
    state = { state: 'expanded', target: nextTarget, ignoresMouseEvents: false }
    return state
  })
  api.hudSetMode = vi.fn(async (mode: HudMode) => {
    if (state.state === 'closed') return state
    state = { state: mode, target: state.target, ignoresMouseEvents: false }
    return state
  })
  api.hudClose = vi.fn(async () => {
    state = { state: 'closed' }
    return state
  })
  api.hudReturnToWorkbench = vi.fn(async () => undefined)
  api.hudSetIgnoreMouseEvents = vi.fn(async (ignore) => state.state === 'closed'
    ? state
    : { ...state, ignoresMouseEvents: ignore })
  api.onHudState = vi.fn((listener) => {
    hudListeners.add(listener)
    return () => hudListeners.delete(listener)
  })
  api.sendComposer = vi.fn(async () => ({ state: 'sent', message: 'Sent' }))
  api.abortThread = vi.fn(async () => ({ state: 'sent', message: 'Stop accepted' }))
  api.selectThread = vi.fn(async () => undefined)
  api.retryLocalSetup = vi.fn(async () => undefined)
  api.repairLocalRuntime = vi.fn(async () => undefined)
  return {
    api: api as RendererApi,
    snapshot,
    target,
    publishSnapshot(next: WorkbenchSnapshot = structuredClone(snapshot)) {
      workbenchListeners.forEach((listener) => listener(next))
    },
    publishHudState(next: HudState) {
      state = next
      hudListeners.forEach((listener) => listener(next))
    },
  }
}

function lifecycleOperation(
  state: ResidentLifecycleOperationSummary['state'],
): ResidentLifecycleOperationSummary {
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

function createResidentProvisioningApi(operation?: ResidentLifecycleOperationSummary) {
  const api = createPreviewRendererApi()
  const loadWorkbench = api.loadWorkbench.bind(api)
  api.loadWorkbench = async () => {
    const snapshot = await loadWorkbench()
    snapshot.selectedProjectId = ''
    snapshot.selectedThreadId = ''
    snapshot.projects = []
    snapshot.threads = []
    snapshot.residentLifecycleOperations = operation ? [operation] : []
    snapshot.operations = {
      ...snapshot.operations,
      submitCommands: false,
      startResidentTurn: false,
      stopResidentTurn: false,
      provisionResident: true,
    }
    return snapshot
  }
  api.selectResidentWorkspace = vi.fn(async () => ({
    selectionToken: 'resident-selection-one',
    operationId: 'resident-operation-one',
    expectedHostId: 'host-local',
    suggestedName: 'Prime GUI',
    expiresAt: '2099-08-05T20:05:00.000Z',
  }))
  api.provisionResident = vi.fn(async () => ({
    version: 1 as const,
    kind: 'provision' as const,
    operationId: 'resident-operation-one',
    phase: 'prepared' as const,
    expectedHostId: 'host-local',
    projectId: 'resident-project-one',
    workspaceId: 'resident-workspace-one',
    threadId: 'resident-thread-one',
    executionGenerationId: 'resident-generation-one',
    preparedAt: '2026-08-05T20:00:00.000Z',
    updatedAt: '2026-08-05T20:00:01.000Z',
  }))
  api.residentLifecycleStatus = vi.fn(async () => null)
  return api
}

function createLocalSetupHarness(
  initialSetup: LocalSetupSummary,
  options: { lifecycleOperations?: ResidentLifecycleOperationSummary[] } = {},
) {
  const api = asNativeFixture(createPreviewRendererApi())
  let snapshot: WorkbenchSnapshot = structuredClone(previewSnapshot)
  snapshot = {
    ...snapshot,
    selectedProjectId: '',
    selectedThreadId: '',
    projects: [],
    threads: [],
    hosts: [],
    runtime: {},
    localSetup: initialSetup,
    residentLifecycleOperations: options.lifecycleOperations ?? [],
    operations: {
      submitCommands: false,
      startResidentTurn: false,
      stopResidentTurn: false,
      ...(initialSetup.stage === 'choose_workspace' ? { provisionResident: true } : {}),
      crossHostHandoff: false,
    },
    composerReceipt: { state: 'idle' },
  }
  const listeners = new Set<(next: WorkbenchSnapshot) => void>()
  api.loadWorkbench = vi.fn(async () => snapshot)
  api.subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  api.retryLocalSetup = vi.fn(async () => undefined)
  api.repairLocalRuntime = vi.fn(async () => undefined)
  const publish = (setup: LocalSetupSummary) => {
    snapshot = {
      ...snapshot,
      localSetup: setup,
      operations: {
        ...snapshot.operations,
        provisionResident: setup.stage === 'choose_workspace' ? true : undefined,
      },
    }
    listeners.forEach((listener) => listener(snapshot))
  }
  return { api: api as RendererApi, publish }
}

function residentEndStatus(phase: 'ending' | 'completed' = 'ending') {
  return {
    version: 1 as const,
    kind: 'end' as const,
    operationId: 'resident-end-operation-one',
    phase,
    expectedHostId: 'host-local',
    projectId: 'project-prime',
    workspaceId: 'workspace-end-one',
    threadId: 'thread-protocol',
    executionGenerationId: 'generation-end-one',
    preparedAt: '2026-08-05T20:00:00.000Z',
    updatedAt: phase === 'completed' ? '2026-08-05T20:00:03.000Z' : '2026-08-05T20:00:01.000Z',
    ...(phase === 'completed' ? { terminalAt: '2026-08-05T20:00:03.000Z' } : {}),
  }
}

function residentEndOperation(
  state: ResidentLifecycleOperationSummary['state'] = 'submitted',
): ResidentLifecycleOperationSummary {
  return {
    kind: 'end',
    operationId: 'resident-end-operation-one',
    expectedHostId: 'host-local',
    projectId: 'project-prime',
    workspaceId: 'workspace-end-one',
    threadId: 'thread-protocol',
    executionGenerationId: 'generation-end-one',
    sourceCursor: {
      threadId: 'thread-protocol',
      executionGenerationId: 'generation-end-one',
      generation: 'daemon-end-one',
      sequence: 7,
    },
    createdAt: '2026-08-05T20:00:00.000Z',
    updatedAt: '2026-08-05T20:00:01.000Z',
    state,
    lastStatus: residentEndStatus('ending'),
  }
}

function createResidentEndApi(operation?: ResidentLifecycleOperationSummary) {
  const api = createPreviewRendererApi()
  const loadWorkbench = api.loadWorkbench.bind(api)
  api.loadWorkbench = async () => {
    const snapshot = await loadWorkbench()
    const thread = snapshot.threads.find((candidate) => candidate.id === 'thread-protocol')
    const host = snapshot.hosts.find((candidate) => candidate.id === 'host-local')
    if (!thread || !host || !snapshot.runtime.session) throw new Error('Expected the local resident preview fixture')
    snapshot.selectedThreadId = thread.id
    snapshot.selectedProjectId = thread.projectId
    thread.status = 'idle'
    thread.workspaceId = 'workspace-end-one'
    thread.executionGenerationId = 'generation-end-one'
    host.connection = 'online'
    snapshot.runtime.session = {
      ...snapshot.runtime.session,
      residency: 'resident',
      activeSessionId: 'active-end-one',
      sessionId: 'session-end-one',
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      queuedActionCount: 0,
    }
    snapshot.runtime.queue = { pendingCount: 0, paused: false }
    snapshot.residentLifecycleOperations = operation ? [operation] : []
    snapshot.operations = {
      ...snapshot.operations,
      submitCommands: !operation,
      startResidentTurn: !operation,
      stopResidentTurn: false,
      provisionResident: true,
    }
    snapshot.composerReceipt = operation
      ? operation.lastStatus?.phase === 'quarantined'
        ? { state: 'uncertain', operation: 'end', message: 'End outcome unknown · this resident session stays locked for inspection' }
        : { state: 'sent', operation: 'end', message: 'Ending resident session · no kill will be replayed automatically' }
      : { state: 'idle', message: 'Ready for a new prompt' }
    return snapshot
  }
  api.prepareResidentEnd = vi.fn(async () => ({
    confirmationToken: 'resident-end-confirmation-one',
    operationId: 'resident-end-operation-one',
    expectedHostId: 'host-local',
    threadId: 'thread-protocol',
    executionGenerationId: 'generation-end-one',
    expiresAt: '2099-08-05T20:05:00.000Z',
  }))
  api.endResident = vi.fn(async () => residentEndStatus('ending'))
  api.residentLifecycleStatus = vi.fn(async () => residentEndStatus('completed'))
  return api
}

beforeAll(() => {
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
  })

  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '')
    },
  })

  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    },
  })
})

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_024 })
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined })
})

describe('Prime Continuim renderer', () => {
  it('renders the exact resident thread in the desktop HUD and uses the authoritative composer path', async () => {
    const user = userEvent.setup()
    const harness = createHudHarness()
    render(<App api={harness.api} surface="hud" />)

    const heading = await screen.findByRole('heading', { name: 'Seamless remote experience' })
    expect(heading).toBeVisible()
    await waitFor(() => expect(document.title).toBe('Prime Continuim HUD — Seamless remote experience'))
    expect(screen.getByLabelText('Thread transcript')).toBeVisible()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Repair runtime' })).not.toBeInTheDocument()

    const composer = screen.getByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(composer).toHaveFocus())
    await user.type(composer, 'Build the HUD from this resident thread')
    await user.click(screen.getByRole('button', { name: 'Run prompt' }))
    expect(harness.api.sendComposer).toHaveBeenCalledWith({
      threadId: harness.target.threadId,
      text: 'Build the HUD from this resident thread',
    })

    await user.click(screen.getByRole('button', { name: 'Keep as desktop buddy' }))
    const buddy = await screen.findByRole('button', { name: /Working: Seamless remote experience\. Open conversation/ })
    await waitFor(() => expect(buddy).toHaveFocus())
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    await user.click(buddy)
    expect(await screen.findByRole('heading', { name: 'Seamless remote experience' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(await screen.findByRole('button', { name: /Open conversation/ })).toBeVisible()
  })

  it('never falls back to another thread when the HUD generation fence does not match', async () => {
    const user = userEvent.setup()
    const harness = createHudHarness({ targetGenerationId: 'generation-that-is-not-current' })
    render(<App api={harness.api} surface="hud" />)

    expect(await screen.findByRole('heading', { name: 'Desktop HUD unavailable' })).toBeVisible()
    expect(screen.getByText(/host, thread, and execution generation are not present/i)).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    expect(harness.api.selectThread).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Return to workbench' }))
    expect(harness.api.hudReturnToWorkbench).toHaveBeenCalledOnce()
    expect(harness.api.retryLocalSetup).not.toHaveBeenCalled()
    expect(harness.api.repairLocalRuntime).not.toHaveBeenCalled()
  })

  it('clears a draft when the native HUD is retargeted and preserves it across modes for one target', async () => {
    const user = userEvent.setup()
    const harness = createHudHarness()
    render(<App api={harness.api} surface="hud" />)

    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const firstComposer = screen.getByRole('textbox', { name: 'Message' })
    await user.type(firstComposer, 'This draft belongs only to the first thread')

    const nextSnapshot = structuredClone(harness.snapshot)
    const sourceThread = nextSnapshot.threads.find((thread) => thread.id === harness.target.threadId)!
    const nextThread = {
      ...structuredClone(sourceThread),
      id: 'thread-hud-two',
      remoteId: 'thread-hud-two',
      title: 'Second HUD resident thread',
      executionGenerationId: 'generation-hud-two',
      transcript: [],
    }
    nextSnapshot.threads.push(nextThread)
    nextSnapshot.selectedThreadId = nextThread.id
    nextSnapshot.selectedProjectId = nextThread.projectId
    const nextTarget: HudTarget = {
      expectedHostId: nextThread.hostId,
      threadId: nextThread.remoteId,
      expectedExecutionGenerationId: nextThread.executionGenerationId,
    }

    act(() => {
      harness.publishHudState({ state: 'expanded', target: nextTarget, ignoresMouseEvents: false })
      harness.publishSnapshot(nextSnapshot)
    })

    expect(await screen.findByRole('heading', { name: 'Second HUD resident thread' })).toBeVisible()
    const secondComposer = screen.getByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(secondComposer).toHaveValue(''))
    expect(secondComposer).not.toHaveValue('This draft belongs only to the first thread')

    await user.type(secondComposer, 'Keep this draft while changing HUD modes')
    await user.click(screen.getByRole('button', { name: 'Keep as desktop buddy' }))
    await user.click(await screen.findByRole('button', { name: /Open conversation/ }))
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('Keep this draft while changing HUD modes')

    await user.click(screen.getByRole('button', { name: 'Run prompt' }))
    expect(harness.api.sendComposer).toHaveBeenLastCalledWith({
      threadId: nextThread.id,
      text: 'Keep this draft while changing HUD modes',
    })
  })

  it('uses the resident Stop authority and explicit close path from the expanded HUD', async () => {
    const user = userEvent.setup()
    const harness = createHudHarness({ taskState: 'running' })
    render(<App api={harness.api} surface="hud" />)

    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: 'Stop the active Prime Agent turn' }))
    expect(harness.api.abortThread).toHaveBeenCalledOnce()
    expect(harness.api.abortThread).toHaveBeenCalledWith(harness.target.threadId)

    await user.click(screen.getByRole('button', { name: 'Close desktop HUD' }))
    expect(harness.api.hudClose).toHaveBeenCalledOnce()
  })

  it('clears the draft before paint when the same HUD thread advances to a new execution generation', async () => {
    const user = userEvent.setup()
    const harness = createHudHarness()
    render(<App api={harness.api} surface="hud" />)

    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Draft from the retired execution')

    const nextSnapshot = structuredClone(harness.snapshot)
    const thread = nextSnapshot.threads.find((candidate) => candidate.id === harness.target.threadId)!
    thread.executionGenerationId = 'generation-hud-two'
    const nextTarget: HudTarget = {
      ...harness.target,
      expectedExecutionGenerationId: thread.executionGenerationId,
    }
    act(() => {
      harness.publishHudState({ state: 'expanded', target: nextTarget, ignoresMouseEvents: false })
      harness.publishSnapshot(nextSnapshot)
    })

    const composer = await screen.findByRole('textbox', { name: 'Message' })
    expect(composer).toHaveValue('')
    expect(composer).not.toHaveValue('Draft from the retired execution')
  })

  it('keeps passive HUD and transcript updates from stealing focus', async () => {
    const user = userEvent.setup()
    const harness = createHudHarness()
    render(<App api={harness.api} surface="hud" />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const returnButton = screen.getByRole('button', { name: 'Workbench' })
    await user.click(returnButton)
    expect(returnButton).toHaveFocus()

    act(() => {
      harness.publishHudState({
        state: 'expanded',
        target: harness.target,
        ignoresMouseEvents: true,
      })
      const next = structuredClone(harness.snapshot)
      next.threads[0]!.transcript = [
        ...next.threads[0]!.transcript,
        {
          id: 'hud-passive-update',
          kind: 'assistant',
          author: 'Prime Agent',
          time: 'Now',
          body: 'Passive HUD update.',
        },
      ]
      harness.publishSnapshot(next)
    })

    await screen.findByText('Passive HUD update.')
    expect(returnButton).toHaveFocus()
  })

  it('opens the HUD from the workbench only with an exact materialized resident target', async () => {
    const user = userEvent.setup()
    const harness = createHudHarness()
    render(<App api={harness.api} />)

    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: 'Show desktop HUD' }))
    expect(harness.api.hudOpen).toHaveBeenCalledWith(harness.target)

    cleanup()
    render(<App api={asNativeFixture(createPreviewRendererApi())} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    expect(screen.queryByRole('button', { name: 'Show desktop HUD' })).not.toBeInTheDocument()
  })

  it('shows approval as Needs you and routes review to the workbench without a fake approval control', async () => {
    const user = userEvent.setup()
    const harness = createHudHarness({ taskState: 'needs_approval' })
    render(<App api={harness.api} surface="hud" />)

    expect(await screen.findByText('Needs you')).toBeVisible()
    expect(screen.getByText(/approval needs review in the full workbench/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Review in workbench' }))
    expect(harness.api.hudReturnToWorkbench).toHaveBeenCalledOnce()
  })

  it('requires explicit confirmation for permanent resident ending and checks an ambiguous result without replay', async () => {
    const user = userEvent.setup()
    const api = createResidentEndApi()
    const endResult = deferred<ReturnType<typeof residentEndStatus>>()
    api.endResident = vi.fn(() => endResult.promise)
    render(<App api={api} />)

    await user.click(await screen.findByRole('tab', { name: 'Runtime' }))
    await user.click(screen.getByRole('button', { name: 'End resident session…' }))
    const dialog = await screen.findByRole('dialog', { name: 'End resident session?' })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus())
    expect(within(dialog).getByText('Closing is different from ending.')).toBeVisible()

    await user.click(within(dialog).getByRole('button', { name: 'End resident session' }))
    const confirmation = within(dialog).getByRole('checkbox', { name: /cannot be resumed/i })
    expect(confirmation).toHaveFocus()
    expect(api.endResident).not.toHaveBeenCalled()

    await user.click(confirmation)
    await user.click(within(dialog).getByRole('button', { name: 'End resident session' }))
    expect(api.endResident).toHaveBeenCalledTimes(1)
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(dialog).toBeVisible()

    endResult.resolve(residentEndStatus('ending'))
    const check = await within(dialog).findByRole('button', { name: 'Check status' })
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveFocus())
    await user.click(check)
    expect(api.residentLifecycleStatus).toHaveBeenCalledWith({
      expectedHostId: 'host-local',
      operationId: 'resident-end-operation-one',
    })
    expect(await within(dialog).findByText(/Resident session ended/i)).toBeVisible()
    expect(api.endResident).toHaveBeenCalledTimes(1)
  })

  it('keeps a null end-status observation outcome-unknown and never invites another kill', async () => {
    const user = userEvent.setup()
    const api = createResidentEndApi()
    api.residentLifecycleStatus = vi.fn(async () => null)
    render(<App api={api} />)

    await user.click(await screen.findByRole('tab', { name: 'Runtime' }))
    await user.click(screen.getByRole('button', { name: 'End resident session…' }))
    const dialog = await screen.findByRole('dialog', { name: 'End resident session?' })
    await user.click(within(dialog).getByRole('checkbox', { name: /cannot be resumed/i }))
    await user.click(within(dialog).getByRole('button', { name: 'End resident session' }))
    const check = await within(dialog).findByRole('button', { name: 'Check status' })
    await user.click(check)

    expect(await within(dialog).findByText(/end outcome remains unknown/i)).toBeVisible()
    expect(within(dialog).getByText(/will not send another kill/i)).toBeVisible()
    expect(within(dialog).queryByRole('button', { name: 'Check status' })).not.toBeInTheDocument()
    expect(api.endResident).toHaveBeenCalledTimes(1)
    expect(api.residentLifecycleStatus).toHaveBeenCalledTimes(1)
  })

  it('allows a fresh review only after the exact stale-cursor rejection', async () => {
    const user = userEvent.setup()
    const api = createResidentEndApi()
    const staleConsent = Object.assign(
      new Error('Resident state changed after end consent was reviewed; refresh the thread and confirm again'),
      { code: 'host.resident_end_source_cursor_changed' },
    )
    api.endResident = vi.fn(async () => { throw staleConsent })
    render(<App api={api} />)

    await user.click(await screen.findByRole('tab', { name: 'Runtime' }))
    await user.click(screen.getByRole('button', { name: 'End resident session…' }))
    const dialog = await screen.findByRole('dialog', { name: 'End resident session?' })
    await user.click(within(dialog).getByRole('checkbox', { name: /cannot be resumed/i }))
    await user.click(within(dialog).getByRole('button', { name: 'End resident session' }))

    expect(await within(dialog).findByText(/No end was admitted/i)).toBeVisible()
    expect(within(dialog).getByText(/refresh the thread.*review the permanent action again/i)).toBeVisible()
    expect(within(dialog).queryByRole('button', { name: 'Check status' })).not.toBeInTheDocument()
    expect(api.endResident).toHaveBeenCalledTimes(1)
    expect(api.residentLifecycleStatus).not.toHaveBeenCalled()
  })

  it('keeps an admitted resident end in a compact locked composer and resumes only its pre-effect review', async () => {
    const user = userEvent.setup()
    const operation = residentEndOperation('submitted')
    const api = createResidentEndApi(operation)
    render(<App api={api} />)

    expect(await screen.findByText('Ending resident session', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resident session end is durably pending' })).toBeDisabled()
    expect(api.endResident).not.toHaveBeenCalled()

    const review = screen.getByRole('button', { name: 'Review end again' })
    await user.click(review)
    expect(api.prepareResidentEnd).toHaveBeenCalledWith(expect.objectContaining({
      resumeOperationId: operation.operationId,
      expectedHostId: operation.expectedHostId,
      threadId: operation.threadId,
      executionGenerationId: operation.executionGenerationId,
    }))
    expect(await screen.findByRole('dialog', { name: 'End resident session?' })).toBeVisible()
    expect(api.endResident).not.toHaveBeenCalled()
  })

  it('keeps a quarantined resident end check-only with a copyable path-free diagnostic', async () => {
    const user = userEvent.setup()
    const operation = {
      ...residentEndOperation('terminal'),
      updatedAt: '2026-08-05T20:00:02.000Z',
      lastStatus: {
        ...residentEndStatus('ending'),
        phase: 'quarantined' as const,
        updatedAt: '2026-08-05T20:00:02.000Z',
        quarantinedFrom: 'kill_dispatching' as const,
        quarantineReason: 'external_outcome_unknown' as const,
      },
    }
    const api = createResidentEndApi(operation)
    render(<App api={api} />)

    const card = await screen.findByRole('region', { name: 'End outcome needs inspection' })
    expect(within(card).getByText(/will not send another kill/i)).toBeVisible()
    expect(within(card).queryByRole('button', { name: /review end/i })).not.toBeInTheDocument()
    const copy = within(card).getByRole('button', { name: 'Copy diagnostic' })
    await user.click(copy)
    expect(api.prepareResidentEnd).not.toHaveBeenCalled()
    expect(api.endResident).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /outcome unknown/i })).toBeDisabled()
  })

  it('resumes only the exact lifecycle operation selected from a recovery card', async () => {
    const user = userEvent.setup()
    const operation = lifecycleOperation('requires_reselection')
    const api = createResidentProvisioningApi(operation)
    render(<App api={api} />)

    await screen.findByRole('heading', { name: 'Workspace confirmation needed' })
    expect(api.selectResidentWorkspace).not.toHaveBeenCalled()
    expect(api.provisionResident).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Choose original folder' }))

    expect(api.selectResidentWorkspace).toHaveBeenCalledTimes(1)
    expect(api.selectResidentWorkspace).toHaveBeenCalledWith({
      resumeOperationId: operation.operationId,
    })
    expect(api.residentLifecycleStatus).not.toHaveBeenCalled()
    expect(await screen.findByRole('dialog', { name: 'Start resident thread' })).toBeVisible()
  })

  it('checks the exact uncertain lifecycle status without reselecting or retrying provision', async () => {
    const user = userEvent.setup()
    const operation = lifecycleOperation('outcome_unknown')
    const api = createResidentProvisioningApi(operation)
    api.residentLifecycleStatus = vi.fn(async () => ({
      version: 1 as const,
      kind: 'provision' as const,
      operationId: operation.operationId,
      phase: 'prepared' as const,
      expectedHostId: operation.expectedHostId,
      projectId: operation.projectId,
      workspaceId: operation.workspaceId,
      threadId: operation.threadId,
      executionGenerationId: operation.executionGenerationId,
      preparedAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    }))
    render(<App api={api} />)

    await screen.findByRole('heading', { name: 'Setup outcome needs inspection' })
    expect(api.residentLifecycleStatus).not.toHaveBeenCalled()
    const checkStatus = screen.getByRole('button', { name: 'Check status' })
    await user.click(checkStatus)

    expect(api.residentLifecycleStatus).toHaveBeenCalledTimes(1)
    expect(api.residentLifecycleStatus).toHaveBeenCalledWith({
      expectedHostId: operation.expectedHostId,
      operationId: operation.operationId,
    })
    expect(api.selectResidentWorkspace).not.toHaveBeenCalled()
    expect(api.provisionResident).not.toHaveBeenCalled()
    expect(screen.getByText('Status checked. The durable setup is still in progress and no mutation was replayed.')).toBeInTheDocument()
    expect(checkStatus).toHaveFocus()
  })

  it('keeps an older unresolved lifecycle operation visible after an unrelated setup commits', async () => {
    const user = userEvent.setup()
    const api = createIdleResidentApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    const unresolved = lifecycleOperation('outcome_unknown')
    const olderRecovery = {
      ...lifecycleOperation('requires_reselection'),
      operationId: 'resident-operation-older',
      projectId: 'resident-project-older',
      workspaceId: 'resident-workspace-older',
      threadId: 'resident-thread-older',
      executionGenerationId: 'resident-generation-older',
      updatedAt: '2026-08-05T19:59:00.000Z',
    }
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.operations.provisionResident = true
      const projectedThread = snapshot.threads.find((thread) => thread.id === snapshot.selectedThreadId) ?? snapshot.threads[0]!
      const projectedThreadId = projectedThread.remoteId ?? projectedThread.id
      const projectedGenerationId = projectedThread.executionGenerationId!
      const projectedWorkspaceId = projectedThread.workspaceId ?? 'workspace-projected'
      snapshot.residentLifecycleOperations = [
        {
          ...lifecycleOperation('terminal'),
          operationId: 'resident-operation-newer',
          expectedHostId: projectedThread.hostId,
          projectId: projectedThread.projectId,
          workspaceId: projectedWorkspaceId,
          threadId: projectedThreadId,
          executionGenerationId: projectedGenerationId,
          updatedAt: '2026-08-05T20:05:00.000Z',
          lastStatus: {
            version: 1,
            kind: 'provision',
            operationId: 'resident-operation-newer',
            phase: 'committed',
            expectedHostId: projectedThread.hostId,
            projectId: projectedThread.projectId,
            workspaceId: projectedWorkspaceId,
            threadId: projectedThreadId,
            executionGenerationId: projectedGenerationId,
            preparedAt: '2026-08-05T20:04:00.000Z',
            updatedAt: '2026-08-05T20:05:00.000Z',
            terminalAt: '2026-08-05T20:05:00.000Z',
          },
        },
        unresolved,
        olderRecovery,
      ]
      return snapshot
    }
    api.residentLifecycleStatus = vi.fn(async () => null)
    render(<App api={api} />)

    await screen.findByRole('heading', { name: 'Setup outcome needs inspection' })
    await user.click(screen.getByText('1 other setup needs attention'))
    expect(screen.getByRole('button', { name: 'Choose original folder' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    expect(api.residentLifecycleStatus).toHaveBeenCalledWith({
      expectedHostId: unresolved.expectedHostId,
      operationId: unresolved.operationId,
    })
  })

  it('moves a fresh empty workbench through local service, runtime verification, and workspace choice', async () => {
    const harness = createLocalSetupHarness({ stage: 'starting_local_service' })
    render(<App api={harness.api} />)

    const main = await screen.findByRole('main')
    expect(main).toHaveAttribute('data-local-setup-stage', 'starting_local_service')
    expect(screen.getByRole('heading', { name: 'Getting Prime Continuim ready' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'No projects yet' })).not.toBeInTheDocument()
    expect(within(main).getByRole('status')).toHaveTextContent('Starting the local service')
    expect(screen.queryByRole('button', { name: 'Choose workspace folder' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use another computer' })).toHaveClass('button--secondary')
    expect(within(main).getByText('Start local service').closest('li')).toHaveAttribute('aria-current', 'step')

    act(() => harness.publish({
      stage: 'preparing_runtime',
      runtimeReadiness: {
        kind: 'reported',
        freshness: 'live',
        status: 'initializing',
        phase: 'copying',
      },
    }))
    expect(main).toHaveAttribute('data-local-setup-stage', 'preparing_runtime')
    expect(within(main).getByRole('status')).toHaveTextContent('Installing verified files')
    expect(within(main).getByText('Verify Prime Agent runtime').closest('li')).toHaveAttribute('aria-current', 'step')

    act(() => harness.publish({
      stage: 'choose_workspace',
      runtimeReadiness: {
        kind: 'reported',
        freshness: 'live',
        status: 'ready',
        assurance: 'development-integrity',
      },
    }))
    expect(main).toHaveAttribute('data-local-setup-stage', 'choose_workspace')
    expect(screen.getByRole('heading', { name: 'Choose a workspace' })).toBeVisible()
    expect(within(main).getByRole('status')).toHaveTextContent('bundled Prime Agent runtime is verified')
    const chooseWorkspace = screen.getByRole('button', { name: 'Choose workspace folder' })
    await waitFor(() => expect(chooseWorkspace).toHaveFocus())
  })

  it('announces and focuses a terminal local-service failure, then retries only the local connection', async () => {
    const user = userEvent.setup()
    const harness = createLocalSetupHarness({ stage: 'starting_local_service' })
    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Getting Prime Continuim ready' })

    act(() => harness.publish({
      stage: 'needs_attention',
      issue: {
        area: 'local_service',
        action: 'retry_connection',
        message: 'The local service did not become ready in time.',
        retryable: true,
        code: 'hostd.start_timeout',
      },
    }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('hostd.start_timeout')
    await waitFor(() => expect(alert).toHaveFocus())
    const retry = screen.getByRole('button', { name: 'Retry local service' })
    await user.click(retry)
    expect(harness.api.retryLocalSetup).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Use another computer' })).toHaveClass('button--secondary')
  })

  it('offers one explicit runtime verification retry and exposes its busy state', async () => {
    const user = userEvent.setup()
    const harness = createLocalSetupHarness({
      stage: 'needs_attention',
      runtimeReadiness: {
        kind: 'reported',
        freshness: 'live',
        status: 'failed',
        retryable: true,
        recovery: 'retry',
      },
      issue: {
        area: 'runtime',
        action: 'retry_runtime',
        message: 'Runtime verification did not finish. Retry verification to run the same checks again.',
        retryable: true,
        code: 'RUNTIME_TRANSIENT_VERIFICATION',
      },
    })
    const retry = deferred<void>()
    harness.api.retryLocalSetup = vi.fn(() => retry.promise)
    render(<App api={harness.api} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Runtime verification stopped')
    expect(alert).toHaveTextContent('RUNTIME_TRANSIENT_VERIFICATION')
    await waitFor(() => expect(alert).toHaveFocus())
    const button = screen.getByRole('button', { name: 'Retry runtime verification' })
    await user.click(button)
    expect(harness.api.retryLocalSetup).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Retrying verification…' })).toBeDisabled()

    retry.resolve()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry runtime verification' })).toBeEnabled())
    expect(harness.api.retryLocalSetup).toHaveBeenCalledOnce()
  })

  it('keeps runtime corruption recovery manual and does not promise that reinstall will clear it', async () => {
    const harness = createLocalSetupHarness({
      stage: 'needs_attention',
      runtimeReadiness: {
        kind: 'reported',
        freshness: 'live',
        status: 'failed',
        recovery: 'repair',
      },
      issue: {
        area: 'runtime',
        action: 'manual_recovery',
        message: 'The installed runtime did not pass verification. Record the diagnostic code and contact support before changing local runtime data; this screen will not replace it.',
        retryable: false,
        code: 'RUNTIME_INSTALLED_CORRUPTION',
      },
    })
    render(<App api={harness.api} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('contact support')
    expect(alert).toHaveTextContent('this screen will not replace it')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(screen.queryByRole('button', { name: /retry|repair|reinstall/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use another computer' })).toBeVisible()
  })

  it('offers one primary scoped runtime repair and keeps diagnostic copy secondary', async () => {
    const user = userEvent.setup()
    const harness = createLocalSetupHarness({
      stage: 'needs_attention',
      runtimeReadiness: {
        kind: 'reported',
        freshness: 'live',
        status: 'failed',
        retryable: false,
        recovery: 'repair',
      },
      issue: {
        area: 'runtime',
        action: 'repair_runtime',
        message: 'Prime Continuim can quarantine the failed local runtime copy and restore it from this app’s verified bundle. Saved projects, threads, and workspace files will remain unchanged.',
        retryable: false,
        code: 'RUNTIME_REPAIR_REQUIRED',
      },
    })
    const admission = deferred<void>()
    harness.api.repairLocalRuntime = vi.fn(() => admission.promise)
    render(<App api={harness.api} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Runtime repair required')
    expect(alert).toHaveTextContent('Saved projects, threads, and workspace files will remain unchanged')
    const repair = screen.getByRole('button', { name: 'Repair runtime' })
    const copy = screen.getByRole('button', { name: 'Copy setup diagnostic' })
    expect(repair).toHaveClass('button--primary')
    expect(copy).toHaveClass('button--secondary')

    await user.click(repair)
    expect(harness.api.repairLocalRuntime).toHaveBeenCalledOnce()
    expect(harness.api.retryLocalSetup).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Repairing runtime…' })).toBeDisabled()
    admission.resolve()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Repair runtime' })).toBeEnabled())
  })

  it('says a scoped repair could not start when admission fails', async () => {
    const user = userEvent.setup()
    const harness = createLocalSetupHarness({
      stage: 'needs_attention',
      issue: {
        area: 'runtime',
        action: 'repair_runtime',
        message: 'The local runtime copy can be repaired from the verified app bundle.',
        retryable: false,
        code: 'RUNTIME_REPAIR_REQUIRED',
      },
    })
    harness.api.repairLocalRuntime = vi.fn(async () => {
      throw new Error('admission rejected')
    })
    render(<App api={harness.api} />)

    await user.click(await screen.findByRole('button', { name: 'Repair runtime' }))
    expect(await screen.findByText(/Runtime repair could not start/)).toBeVisible()
    expect(screen.queryByText(/could not finish/)).not.toBeInTheDocument()
  })

  it('copies a bounded path-free diagnostic from an initial nonretryable setup state with the keyboard', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const harness = createLocalSetupHarness({
      stage: 'needs_attention',
      issue: {
        area: 'local_service',
        action: 'review_diagnostics',
        message: 'Private native cause: C:\\Users\\operator\\secret-workspace\\host.sock with session-key-one.',
        retryable: false,
        code: 'hostd.bundle_missing',
      },
    })
    render(<App api={harness.api} />)

    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(alert).toHaveFocus())
    await user.tab()
    const copy = screen.getByRole('button', { name: 'Copy setup diagnostic' })
    expect(copy).toHaveFocus()
    expect(copy).toHaveClass('button--primary')
    await user.keyboard('{Enter}')

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    const diagnostic = writeText.mock.calls[0]?.[0]
    expect(diagnostic).toBe([
      'PRIME_CONTINUIM_SETUP_DIAGNOSTIC',
      'Stage: needs_attention',
      'Area: local_service',
      'Code: hostd.bundle_missing',
      'Next step: Share this diagnostic with Prime Continuim support.',
    ].join('\n'))
    expect(diagnostic).not.toMatch(/[A-Z]:\\|\/Users\/|operator|secret-workspace|host\.sock|session-key-one/i)
    expect(screen.getByText('Setup diagnostic copied. Share it with Prime Continuim support.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Setup diagnostic copied' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Use another computer' })).toHaveClass('button--secondary')
    expect(screen.queryByRole('button', { name: /restart|repair|reinstall/i })).not.toBeInTheDocument()
  })

  it('reveals and selects the bounded diagnostic when clipboard copy fails', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {
      throw new Error('Clipboard denied')
    })
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const harness = createLocalSetupHarness({
      stage: 'needs_attention',
      runtimeReadiness: {
        kind: 'reported',
        freshness: 'live',
        status: 'failed',
        recovery: 'repair',
      },
      issue: {
        area: 'runtime',
        action: 'manual_recovery',
        message: 'The installed runtime did not pass verification.',
        retryable: false,
        code: 'RUNTIME_INSTALLED_CORRUPTION',
      },
    })
    render(<App api={harness.api} />)

    await user.click(await screen.findByRole('button', { name: 'Copy setup diagnostic' }))
    const diagnostic = await screen.findByRole('textbox', { name: 'Setup diagnostic' })
    await waitFor(() => expect(diagnostic).toHaveFocus())
    expect(diagnostic).toHaveValue([
      'PRIME_CONTINUIM_SETUP_DIAGNOSTIC',
      'Stage: needs_attention',
      'Area: runtime',
      'Code: RUNTIME_INSTALLED_CORRUPTION',
      'Next step: Share this diagnostic with Prime Continuim support.',
    ].join('\n'))
    expect((diagnostic as HTMLTextAreaElement).selectionStart).toBe(0)
    expect((diagnostic as HTMLTextAreaElement).selectionEnd).toBe((diagnostic as HTMLTextAreaElement).value.length)
    expect(screen.getByText(/Unable to copy the setup diagnostic.*copy it manually.*share it with Prime Continuim support/i)).toBeInTheDocument()
    expect(screen.getByText('Clipboard unavailable')).toBeVisible()
    expect(screen.queryByRole('button', { name: /restart|repair|reinstall/i })).not.toBeInTheDocument()
  })

  it('puts durable resident recovery before onboarding and withholds a second create mutation', async () => {
    const operation = lifecycleOperation('outcome_unknown')
    const harness = createLocalSetupHarness({
      stage: 'choose_workspace',
      runtimeReadiness: {
        kind: 'reported',
        freshness: 'live',
        status: 'ready',
        assurance: 'development-integrity',
      },
    }, { lifecycleOperations: [operation] })
    render(<App api={harness.api} />)

    expect(await screen.findByRole('heading', { name: 'Finish resident setup' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Setup outcome needs inspection' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Choose workspace folder' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use another computer' })).toBeVisible()
  })

  it('labels and validates resident setup, keeps paths hidden, and cancels without mutation', async () => {
    const user = userEvent.setup()
    const api = createResidentProvisioningApi()
    render(<App api={api} />)

    const trigger = await screen.findByRole('button', { name: 'Choose workspace folder' })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Start resident thread' })
    expect(dialog).toHaveAccessibleDescription(/verified local host keeps its folder location/i)
    expect(document.body).not.toHaveTextContent('C:\\Users\\operator\\secret-workspace')

    const projectName = within(dialog).getByRole('textbox', { name: /^Project name/ })
    const threadTitle = within(dialog).getByRole('textbox', { name: /^Thread title/ })
    expect(projectName).toHaveValue('Prime GUI')
    expect(threadTitle).toHaveValue('Prime GUI thread')
    await waitFor(() => expect(projectName).toHaveFocus())

    await user.clear(projectName)
    await user.click(within(dialog).getByRole('button', { name: 'Start resident thread' }))
    expect(projectName).toHaveAttribute('aria-invalid', 'true')
    expect(projectName.getAttribute('aria-describedby')).toContain('resident-provision-error')
    expect(projectName).toHaveFocus()
    expect(within(dialog).getByText('Enter a project name between 1 and 255 characters.')).toBeVisible()
    expect(api.provisionResident).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start resident thread' })).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(api.provisionResident).not.toHaveBeenCalled()
  })

  it('keeps one submitting dialog across catalog materialization and focuses the exact committed thread', async () => {
    const user = userEvent.setup()
    const api = createResidentProvisioningApi()
    const initial = await api.loadWorkbench()
    api.loadWorkbench = vi.fn(async () => structuredClone(initial))
    let publishSnapshot: ((snapshot: typeof initial) => void) | undefined
    api.subscribe = vi.fn((listener) => {
      publishSnapshot = listener
      return () => undefined
    })
    const committedStatus = {
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
    const provision = deferred<typeof committedStatus>()
    api.provisionResident = vi.fn(() => provision.promise)
    render(<App api={api} />)

    await user.click(await screen.findByRole('button', { name: 'Choose workspace folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start resident thread' })
    await user.click(within(dialog).getByRole('button', { name: 'Start resident thread' }))
    expect(within(dialog).getByRole('button', { name: 'Starting…' })).toBeDisabled()

    const projected = structuredClone(initial)
    projected.projects = [{
      id: committedStatus.projectId,
      name: 'Prime GUI',
      repository: 'prime-gui',
      hostIds: [committedStatus.expectedHostId],
      branch: 'main',
      dirtyFiles: 0,
    }]
    projected.threads = [{
      id: 'host-local:resident-thread-one',
      remoteId: committedStatus.threadId,
      projectId: committedStatus.projectId,
      workspaceId: committedStatus.workspaceId,
      title: 'Prime GUI thread',
      recap: 'Resident thread ready',
      hostId: committedStatus.expectedHostId,
      status: 'idle',
      updatedAt: committedStatus.updatedAt,
      executionGenerationId: committedStatus.executionGenerationId,
      transcript: [],
    }]
    projected.selectedProjectId = committedStatus.projectId
    projected.selectedThreadId = projected.threads[0]!.id
    act(() => publishSnapshot?.(projected))

    expect(screen.getByRole('dialog', { name: 'Start resident thread' })).toBe(dialog)
    expect(within(dialog).getByRole('button', { name: 'Starting…' })).toBeDisabled()
    await act(async () => provision.resolve(committedStatus))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start resident thread' })).not.toBeInTheDocument())
    const heading = await screen.findByRole('heading', { name: 'Prime GUI thread' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(api.provisionResident).toHaveBeenCalledTimes(1)
  })

  it('keeps a path-free recovery route when a nonterminal status returns before ledger hydration', async () => {
    const user = userEvent.setup()
    const api = createResidentProvisioningApi()
    render(<App api={api} />)

    await user.click(await screen.findByRole('button', { name: 'Choose workspace folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start resident thread' })
    await user.click(within(dialog).getByRole('button', { name: 'Start resident thread' }))
    expect(await within(dialog).findByText(/setup is durably recorded/i)).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))

    expect(await screen.findByRole('heading', { name: 'Setup paused safely' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Choose original folder' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Check status' })).not.toBeInTheDocument()
    expect(api.provisionResident).toHaveBeenCalledTimes(1)
  })

  it('settles an ambiguous provision failure without automatically retrying it', async () => {
    const user = userEvent.setup()
    const api = createResidentProvisioningApi()
    api.provisionResident = vi.fn(async () => {
      throw new Error('The resident setup outcome is unknown.')
    })
    render(<App api={api} />)

    await user.click(await screen.findByRole('button', { name: 'Choose workspace folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start resident thread' })
    await user.click(within(dialog).getByRole('button', { name: 'Start resident thread' }))

    expect(await within(dialog).findByText('The resident setup outcome is unknown.')).toBeVisible()
    const result = within(dialog).getByRole('status')
    expect(result).toHaveTextContent('Check the durable recovery state before trying again.')
    await waitFor(() => expect(result).toHaveFocus())
    expect(within(dialog).queryByRole('button', { name: 'Start resident thread' })).not.toBeInTheDocument()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.provisionResident).toHaveBeenCalledTimes(1)
    expect(api.selectResidentWorkspace).toHaveBeenCalledTimes(1)
    expect(api.residentLifecycleStatus).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await screen.findByRole('heading', { name: 'Setup outcome needs inspection' })
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Setup outcome needs inspection' })).not.toBeInTheDocument())
    expect(screen.getByText('No durable setup was found. You can start a new resident thread.')).toBeInTheDocument()
    expect(api.residentLifecycleStatus).toHaveBeenCalledTimes(1)
  })

  it('does not invent a recovery operation for a definitive pre-record failure', async () => {
    const user = userEvent.setup()
    const api = createResidentProvisioningApi()
    api.provisionResident = vi.fn(async () => {
      throw Object.assign(new Error('Enter a project name between 1 and 255 characters.'), {
        code: 'resident.provision_label_invalid',
      })
    })
    render(<App api={api} />)

    await user.click(await screen.findByRole('button', { name: 'Choose workspace folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start resident thread' })
    await user.click(within(dialog).getByRole('button', { name: 'Start resident thread' }))
    expect(await within(dialog).findByText(/correct the issue, and choose the workspace folder again/i)).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))

    expect(screen.queryByRole('heading', { name: 'Setup outcome needs inspection' })).not.toBeInTheDocument()
    expect(api.residentLifecycleStatus).not.toHaveBeenCalled()
  })

  it('surfaces a copyable path-free diagnostic for quarantined setup instead of a no-op retry', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const operation: ResidentLifecycleOperationSummary = {
      ...lifecycleOperation('terminal'),
      lastStatus: {
        version: 1,
        kind: 'provision',
        operationId: 'resident-operation-one',
        phase: 'quarantined',
        expectedHostId: 'host-local',
        projectId: 'resident-project-one',
        workspaceId: 'resident-workspace-one',
        threadId: 'resident-thread-one',
        executionGenerationId: 'resident-generation-one',
        preparedAt: '2026-08-05T20:00:00.000Z',
        updatedAt: '2026-08-05T20:00:01.000Z',
        quarantinedFrom: 'promotion_dispatching',
        quarantineReason: 'external_outcome_unknown',
      },
    }
    const api = createResidentProvisioningApi(operation)
    render(<App api={api} />)

    await screen.findByRole('heading', { name: 'Setup needs manual recovery' })
    expect(screen.getByText(/external mutation boundary whose outcome cannot be proven/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Check status' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy diagnostic' }))

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0]?.[0]).toContain('RESIDENT_LIFECYCLE_QUARANTINED')
    expect(writeText.mock.calls[0]?.[0]).toContain('Operation ID: resident-operation-one')
    expect(writeText.mock.calls[0]?.[0]).not.toMatch(/[A-Z]:\\|\/Users\//)
  })

  it('shows a copyable durable diagnostic with explicit no-retry guidance', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.attention.unshift({
        id: 'restart-uncertain',
        threadId: snapshot.selectedThreadId,
        kind: 'failed',
        title: 'Outcome unknown · Prime Agent did not replay this command',
        hostName: 'devbox',
        diagnostic: {
          code: 'RESIDENT_DISPATCH_RESTART_UNCERTAIN',
          message: 'The Prime Agent outcome cannot be proven after the host process identity changed',
          retryable: false,
          diagnosticId: 'resident-dispatch-diagnostic-1',
        },
      })
      return snapshot
    }

    render(<App api={api} />)

    expect(await screen.findByText(/RESIDENT_DISPATCH_RESTART_UNCERTAIN · resident-dispatch-diagnostic-1/)).toBeVisible()
    expect(screen.getByText('The Prime Agent outcome cannot be proven after the host process identity changed')).toBeVisible()
    expect(screen.getByText('Do not retry automatically. Inspect the current thread state.')).toBeVisible()
    expect(screen.queryByText(/try stop again/i)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy diagnostic RESIDENT_DISPATCH_RESTART_UNCERTAIN' }))
    expect(writeText).toHaveBeenCalledWith([
      'RESIDENT_DISPATCH_RESTART_UNCERTAIN',
      'Diagnostic ID: resident-dispatch-diagnostic-1',
      'The Prime Agent outcome cannot be proven after the host process identity changed',
      'Retryable: no',
    ].join('\n'))
    expect(screen.getByRole('button', { name: 'Diagnostic copied' })).toBeVisible()
  })

  it('keeps a non-retryable Stop uncertainty disabled until exact recovery evidence arrives', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
      const host = snapshot.hosts.find((candidate) => candidate.id === thread?.hostId)
      if (!thread || !host || !snapshot.runtime.session) throw new Error('Expected preview resident authority')
      thread.status = 'running'
      host.connection = 'online'
      snapshot.runtime.session.residency = 'resident'
      snapshot.runtime.session.activeSessionId = 'active-preview'
      snapshot.runtime.session.sessionId = 'session-preview'
      snapshot.operations.startResidentTurn = false
      snapshot.operations.stopResidentTurn = true
      snapshot.composerReceipt = {
        state: 'uncertain',
        operation: 'abort',
        retryable: false,
        message: 'Outcome unknown · recovery required; this Stop will not be replayed',
      }
      return snapshot
    }
    api.abortThread = vi.fn(async () => ({ state: 'sent', message: 'Stop accepted' }))

    render(<App api={api} />)

    const stop = await screen.findByRole('button', {
      name: 'Stop outcome unknown; inspect the current thread state',
    })
    expect(stop).toHaveTextContent('Outcome unknown')
    expect(stop).toBeDisabled()
    expect(screen.getAllByText('Outcome unknown · recovery required; this Stop will not be replayed').some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.queryByText(/try stop again/i)).not.toBeInTheDocument()
    await user.click(stop)
    expect(api.abortThread).not.toHaveBeenCalled()
  })

  it.each([390, 320])(
    'keeps disconnected cached-running copy explicitly unverified at %ipx',
    async (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)

    expect(await screen.findByRole('heading', { name: 'Seamless remote experience' })).toBeVisible()
    expect(document.querySelector('.topbar__brand-name')).toHaveTextContent('Prime Continuim')
    expect(screen.getByText('Last seen running', { selector: '.task-state__label' })).toBeVisible()
    expect(document.querySelector('.task-state')).toHaveClass('task-state--stale')
    expect(screen.getAllByText(/Reconnecting… Last synchronized 12 s ago/).some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    expect(document.querySelector('.composer-wrap')).toHaveClass('composer-wrap--compact')
    expect(screen.getByText('Resident status unverified', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.queryByText('Active resident turn', { selector: '.composer__intent' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Prime Agent is working · Stop requests a safe boundary/i)).not.toBeInTheDocument()
    expect(screen.getAllByText(/Last reported running on devbox · current status unverified/i).some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.getByRole('button', { name: 'Reconnect to verify and control this resident turn' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reconnect to verify and control this resident turn' })).toHaveTextContent('Reconnect to verify')
    expect(screen.getByText(/cached transcript is still available/i)).toBeVisible()
    const continuity = screen.getByRole('region', { name: 'Session status' })
    expect(within(continuity).getByText(/Last reported resident on devbox · current status unverified/i)).toBeVisible()
    expect(within(continuity).queryByText(/Continues on devbox when this window closes/i)).not.toBeInTheDocument()
    const receiptDetails = screen.getByText('Receipt details').closest('details')
    expect(receiptDetails).not.toHaveAttribute('open')
    await user.click(screen.getByText('Receipt details'))
    expect(receiptDetails).toHaveAttribute('open')
    expect(within(receiptDetails as HTMLElement).getByText('preview_simulation_receipt')).toBeVisible()
  })

  it('preserves the cached transcript without queuing a blind offline mutation', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    await user.click(screen.getByRole('button', { name: /Training runs/ }))

    expect(await screen.findByRole('heading', { name: 'Benchmark attention kernel' })).toBeVisible()
    expect(screen.getAllByText(/Offline · Last synchronized 18 min ago/).some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.getAllByText(/cached transcript remains available/i).some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    expect(document.querySelector('.composer-wrap')).toHaveClass('composer-wrap--compact')
    expect(screen.getByRole('button', { name: 'Reconnect to verify and control this resident turn' })).toBeDisabled()
    expect(screen.queryByText(/send when reconnected/i)).not.toBeInTheDocument()
  })

  it('connects a cached SSH computer by keyboard, stays busy once, and preserves the draft at narrow width', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    const harness = createHostActivationHarness()
    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Keep this exact draft')
    await act(async () => harness.publish(harness.snapshotFor('offline')))

    const connect = screen.getByRole('button', { name: 'Connect to this computer' })
    expect(connect).toBeVisible()
    connect.focus()
    await user.keyboard('{Enter}')

    expect(harness.api.activateComputer).toHaveBeenCalledWith('host-devbox')
    expect(harness.api.activateComputer).toHaveBeenCalledTimes(1)
    expect(connect).toBeDisabled()
    expect(connect).toHaveAttribute('aria-busy', 'true')
    expect(connect).toHaveTextContent('Connect to this computer')
    expect(document.querySelector('#connection-status')).toHaveTextContent('Connecting to this computer.')
    expect(screen.getByText(/aligning the renderer around one durable thread/i)).toBeVisible()
    expect(harness.api.sendComposer).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    expect(harness.api.activateComputer).toHaveBeenCalledTimes(1)

    await act(async () => {
      harness.activationReply.resolve(harness.snapshotFor('online'))
      await harness.activationReply.promise
    })

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Connect to this computer' })).not.toBeInTheDocument())
    expect(document.querySelector('#connection-status')).toHaveTextContent('Connected to this computer.')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this exact draft')
    expect(harness.api.sendComposer).not.toHaveBeenCalled()
  })

  it('keeps controlled activation errors path-free, read-only, and explicitly retryable when authority is online', async () => {
    const user = userEvent.setup()
    const harness = createHostActivationHarness()
    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Preserve after failure')
    await act(async () => harness.publish(harness.snapshotFor('offline')))
    await user.click(screen.getByRole('button', { name: 'Connect to this computer' }))

    const privateLocator = 'secret-build-alias'
    await act(async () => {
      harness.activationReply.reject(Object.assign(
        new Error(`OpenSSH could not reach ${privateLocator}.`),
        { code: 'ssh.unreachable' },
      ))
      await harness.activationReply.promise.catch(() => undefined)
    })

    const retry = await screen.findByRole('button', { name: 'Connect to this computer' })
    expect(retry).toBeEnabled()
    expect(document.querySelector('#connection-status')).toHaveTextContent(
      'Unable to connect to this computer. The connection could not be verified. Check this computer, then try again. No command was sent.',
    )
    expect(document.body).not.toHaveTextContent(privateLocator)
    expect(harness.api.sendComposer).not.toHaveBeenCalled()

    await act(async () => harness.publish(harness.snapshotFor('online', true)))
    expect(screen.getByRole('button', { name: 'Connect to this computer' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Preserve after failure')
    expect(screen.getByRole('button', { name: 'Run prompt' })).toBeDisabled()
    expect(harness.api.sendComposer).not.toHaveBeenCalled()
  })

  it('directs a missing verified binding back through Add computer without exposing native details', async () => {
    const user = userEvent.setup()
    const harness = createHostActivationHarness()
    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await act(async () => harness.publish(harness.snapshotFor('offline')))
    await user.click(screen.getByRole('button', { name: 'Connect to this computer' }))

    await act(async () => {
      harness.activationReply.reject(Object.assign(
        new Error('private-user@private-host could not be opened'),
        { code: 'ssh.verified_host_binding_required' },
      ))
      await harness.activationReply.promise.catch(() => undefined)
    })

    expect(document.querySelector('#connection-status')).toHaveTextContent(/Add the computer again before connecting\. No command was sent\./)
    expect(document.body).not.toHaveTextContent('private-user@private-host')
  })

  it('ignores a late activation result after the user selects another host and never sends the preserved draft', async () => {
    const user = userEvent.setup()
    const harness = createHostActivationHarness()
    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Draft stays with my current view')
    await act(async () => harness.publish(harness.snapshotFor('offline')))
    await user.click(screen.getByRole('button', { name: 'Connect to this computer' }))

    await user.click(screen.getByRole('button', { name: /Frame protocol boundaries/ }))
    expect(await screen.findByRole('heading', { name: 'Frame protocol boundaries' })).toBeVisible()
    await act(async () => {
      harness.activationReply.resolve(harness.snapshotFor('online'))
      await harness.activationReply.promise
    })

    expect(screen.getByRole('heading', { name: 'Frame protocol boundaries' })).toBeVisible()
    expect(document.querySelector('#connection-status')).not.toHaveTextContent('Connected to this computer.')
    expect(harness.api.sendComposer).not.toHaveBeenCalled()
  })

  it('does not expose cached-host activation in preview or while native SSH is already reconnecting', async () => {
    const previewApi = createPreviewRendererApi()
    const previewLoad = previewApi.loadWorkbench.bind(previewApi)
    previewApi.loadWorkbench = async () => {
      const snapshot = await previewLoad()
      const host = snapshot.hosts.find((candidate) => candidate.id === 'host-devbox')
      if (!host) throw new Error('Expected preview SSH host')
      host.connection = 'offline'
      return snapshot
    }
    render(<App api={previewApi} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    expect(screen.queryByRole('button', { name: 'Connect to this computer' })).not.toBeInTheDocument()
    cleanup()

    const nativeHarness = createHostActivationHarness()
    nativeHarness.publish(nativeHarness.snapshotFor('reconnecting'))
    render(<App api={nativeHarness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    expect(screen.queryByRole('button', { name: 'Connect to this computer' })).not.toBeInTheDocument()
  })

  it('offers one honest prompt action for an idle resident session', async () => {
    const user = userEvent.setup()
    const api = createIdleResidentApi()
    api.sendComposer = vi.fn(async () => ({ state: 'sent', message: 'Sent' }))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    expect(screen.queryByRole('button', { name: /steer/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /follow up/i })).not.toBeInTheDocument()
    expect(screen.getByText('New resident prompt', { selector: '.composer__intent' })).toBeVisible()

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Summarize the approval boundary.')
    await user.click(screen.getByRole('button', { name: 'Run prompt' }))
    expect(api.sendComposer).toHaveBeenCalledWith({
      threadId: 'thread-complete',
      text: 'Summarize the approval boundary.',
    })
  })

  it('focuses and describes an empty composer submission, then clears the error while typing', async () => {
    const user = userEvent.setup()
    const previewApi = createIdleResidentApi()
    const sendComposer = vi.fn(previewApi.sendComposer.bind(previewApi))
    const api = Object.create(previewApi) as typeof previewApi
    Object.defineProperty(api, 'sendComposer', { configurable: true, value: sendComposer })
    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })

    const composer = screen.getByRole('textbox', { name: 'Message' })
    await user.click(screen.getByRole('button', { name: 'Run prompt' }))

    await waitFor(() => expect(composer).toHaveFocus())
    expect(composer).toHaveAttribute('aria-invalid', 'true')
    expect(composer).toHaveAttribute('aria-describedby', 'composer-hint composer-message-error')
    expect(document.getElementById('composer-message-error')).toHaveTextContent('Write a prompt before running Prime Agent.')
    expect(sendComposer).not.toHaveBeenCalled()

    await user.type(composer, 'Continue from the latest checkpoint.')
    expect(composer).not.toHaveAttribute('aria-invalid')
    expect(composer).toHaveAttribute('aria-describedby', 'composer-hint composer-status')
    expect(document.getElementById('composer-message-error')).not.toBeInTheDocument()
  })

  it('preserves a draft when the host rejects command admission', async () => {
    const user = userEvent.setup()
    const api = createIdleResidentApi()
    api.sendComposer = vi.fn(async () => ({
      state: 'rejected',
      message: 'Prime Agent execution is not attached in this build.',
    }))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    const composer = screen.getByRole('textbox', { name: 'Message' })
    const draft = 'Keep this draft until execution is available.'
    await user.type(composer, draft)
    await user.click(screen.getByRole('button', { name: 'Run prompt' }))

    await screen.findAllByText('Prime Agent execution is not attached in this build.')
    expect(composer).toHaveValue(draft)
    expect(document.querySelector('.composer__connection')).toHaveClass('composer__connection--rejected')
    expect(within(screen.getByRole('region', { name: 'Thread transcript' })).queryByText(draft)).not.toBeInTheDocument()
  })

  it('waits for an authoritative host snapshot before rendering an admitted prompt', async () => {
    const user = userEvent.setup()
    const api = createIdleResidentApi()
    const snapshot = await api.loadWorkbench()
    let publish: ((next: typeof snapshot) => void) | undefined
    api.loadWorkbench = vi.fn(() => Promise.resolve(structuredClone(snapshot)))
    api.subscribe = vi.fn((listener) => {
      publish = listener
      return () => undefined
    })
    const admission = deferred<{ state: 'sent'; message: string }>()
    api.sendComposer = vi.fn(() => admission.promise)

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    const transcript = screen.getByRole('region', { name: 'Thread transcript' })
    const composer = screen.getByRole('textbox', { name: 'Message' })
    const prompt = 'Wait for the resident transcript before showing this prompt.'

    await user.type(composer, prompt)
    await user.click(screen.getByRole('button', { name: 'Run prompt' }))

    await waitFor(() => expect(api.sendComposer).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Admitting resident prompt', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Prompt is awaiting durable host admission' })).toHaveTextContent('Submitting prompt')
    expect(screen.getByRole('form', { name: 'Prime Agent prompt' })).toHaveAttribute('aria-busy', 'true')
    expect(within(transcript).queryByText(prompt)).not.toBeInTheDocument()

    await act(async () => {
      admission.resolve({ state: 'sent', message: 'Sent · durably admitted by host' })
      await admission.promise
    })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument())
    expect(screen.getByText('Prompt owned by Prime Agent', { selector: '.composer__intent' })).toBeVisible()
    expect(document.querySelector('.composer-wrap')).toHaveClass('composer-wrap--compact')

    const authoritative = structuredClone(snapshot)
    const selected = authoritative.threads.find((thread) => thread.id === authoritative.selectedThreadId)
    if (!selected) throw new Error('Expected the selected thread fixture')
    selected.transcript.push({
      id: 'authoritative-user-prompt',
      kind: 'user',
      author: 'You',
      time: 'Now',
      body: prompt,
    })
    authoritative.composerReceipt = { state: 'sent', message: 'Sent · durably admitted by host' }

    await act(async () => publish?.(authoritative))
    expect(await within(transcript).findByText(prompt)).toBeVisible()
  })

  it('turns an owned prompt receipt into an enabled Stop control without inventing transcript state', async () => {
    const user = userEvent.setup()
    const api = createIdleResidentApi()
    const snapshot = await api.loadWorkbench()
    let publish: ((next: typeof snapshot) => void) | undefined
    api.loadWorkbench = vi.fn(() => Promise.resolve(structuredClone(snapshot)))
    api.subscribe = vi.fn((listener) => {
      publish = listener
      return () => undefined
    })
    api.sendComposer = vi.fn(async () => {
      const owned = structuredClone(snapshot)
      owned.operations.startResidentTurn = false
      owned.operations.stopResidentTurn = true
      owned.composerReceipt = {
        state: 'sent',
        message: 'Prompt accepted · waiting for authoritative resident activity',
        operation: 'prompt',
      }
      publish?.(owned)
      return { state: 'sent', message: 'Prompt accepted · waiting for authoritative resident activity' }
    })
    api.abortThread = vi.fn(async () => ({
      state: 'sent',
      message: 'Stop request accepted · waiting for authoritative idle state',
    }))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    const prompt = 'Keep the projection honest while starting this turn.'
    await user.type(screen.getByRole('textbox', { name: 'Message' }), prompt)
    await user.click(screen.getByRole('button', { name: 'Run prompt' }))

    const stop = await screen.findByRole('button', { name: 'Stop the active Prime Agent turn' })
    expect(stop).toBeEnabled()
    expect(stop).toHaveTextContent('Stop')
    expect(screen.getByText('Prompt owned by Prime Agent')).toBeVisible()
    expect(within(screen.getByRole('region', { name: 'Thread transcript' })).queryByText(prompt)).not.toBeInTheDocument()

    await user.click(stop)
    expect(api.abortThread).toHaveBeenCalledOnce()
    expect(api.abortThread).toHaveBeenCalledWith('thread-complete')
    expect(await screen.findByText('Stop accepted', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Stop accepted; waiting for authoritative idle proof' })).toBeDisabled()
  })

  it('keeps an accepted Stop in pending mode across a lagging idle projection until exact proof', async () => {
    const api = createIdleResidentApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      const selected = snapshot.threads.find((thread) => thread.id === snapshot.selectedThreadId)
      if (!selected) throw new Error('Expected selected resident thread')
      selected.status = 'idle'
      snapshot.operations.startResidentTurn = false
      snapshot.operations.stopResidentTurn = false
      snapshot.composerReceipt = {
        state: 'sent',
        operation: 'abort',
        message: 'Stop accepted · waiting for authoritative idle proof',
      }
      return snapshot
    }
    api.abortThread = vi.fn(async () => ({ state: 'sent', message: 'Duplicate Stop' }))

    render(<App api={api} />)

    expect(await screen.findByText('Stop accepted', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.queryByText('New resident prompt', { selector: '.composer__intent' })).not.toBeInTheDocument()
    const pendingStop = screen.getByRole('button', { name: 'Stop accepted; waiting for authoritative idle proof' })
    expect(pendingStop).toHaveTextContent('Stop accepted')
    expect(pendingStop).toBeDisabled()
    expect(api.abortThread).not.toHaveBeenCalled()
  })

  it.each(['response', 'error'] as const)(
    'keeps an accepted Stop authoritative when an older prompt %s arrives late',
    async (promptOutcome) => {
    const user = userEvent.setup()
    const api = createIdleResidentApi()
    const snapshot = await api.loadWorkbench()
    const promptAdmission = deferred<{ state: 'sent'; message: string }>()
    let publish: ((next: typeof snapshot) => void) | undefined
    api.loadWorkbench = vi.fn(() => Promise.resolve(structuredClone(snapshot)))
    api.subscribe = vi.fn((listener) => {
      publish = listener
      return () => undefined
    })
    api.sendComposer = vi.fn(() => promptAdmission.promise)
    api.abortThread = vi.fn(async () => ({
      state: 'sent',
      message: 'Stop request accepted · waiting for authoritative idle state',
    }))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    const composer = screen.getByRole('textbox', { name: 'Message' })
    await user.type(composer, 'Start, then stop, this exact resident turn.')
    await user.click(screen.getByRole('button', { name: 'Run prompt' }))
    await waitFor(() => expect(api.sendComposer).toHaveBeenCalledOnce())

    const active = structuredClone(snapshot)
    const activeThread = active.threads.find((thread) => thread.id === active.selectedThreadId)
    if (!activeThread || !active.runtime.session) throw new Error('Expected the selected resident thread')
    activeThread.status = 'running'
    active.runtime.session = {
      ...active.runtime.session,
      isStreaming: true,
      queuedActionCount: 1,
    }
    active.operations.startResidentTurn = false
    active.operations.stopResidentTurn = true
    active.composerReceipt = {
      state: 'sent',
      message: 'Prompt accepted · resident activity is authoritative',
      operation: 'prompt',
    }
    await act(async () => publish?.(active))

    const stop = await screen.findByRole('button', { name: 'Stop the active Prime Agent turn' })
    expect(stop).toBeEnabled()
    await user.click(stop)
    expect(api.abortThread).toHaveBeenCalledOnce()
    expect(await screen.findByText('Stop accepted', { selector: '.composer__intent' })).toBeVisible()
    expect(stop).toBeDisabled()

    const delayedPromptEvent = structuredClone(active)
    delayedPromptEvent.composerReceipt = {
      state: 'sent',
      message: 'Delayed prompt running receipt',
      operation: 'prompt',
    }
    await act(async () => publish?.(delayedPromptEvent))
    expect(screen.getByText('Stop accepted', { selector: '.composer__intent' })).toBeVisible()
    expect(stop).toBeDisabled()

    await act(async () => {
      if (promptOutcome === 'response') {
        promptAdmission.resolve({ state: 'sent', message: 'Delayed direct prompt response' })
      } else {
        promptAdmission.reject(new Error('Delayed prompt transport failure'))
      }
      await promptAdmission.promise.catch(() => undefined)
    })
    expect(screen.getByText('Stop accepted', { selector: '.composer__intent' })).toBeVisible()
    expect(stop).toBeDisabled()
    await user.click(stop)
    expect(api.abortThread).toHaveBeenCalledOnce()

    const idle = structuredClone(active)
    const idleThread = idle.threads.find((thread) => thread.id === idle.selectedThreadId)
    if (!idleThread || !idle.runtime.session) throw new Error('Expected the selected resident thread')
    idleThread.status = 'idle'
    idle.runtime.session = {
      ...idle.runtime.session,
      isStreaming: false,
      queuedActionCount: 0,
    }
    idle.operations.startResidentTurn = true
    idle.operations.stopResidentTurn = false
    idle.composerReceipt = { state: 'idle', message: 'Ready for a new prompt' }
    await act(async () => publish?.(idle))
    expect(screen.queryByText('Stop accepted', { selector: '.composer__intent' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run prompt' })).toBeEnabled()
    if (promptOutcome === 'response') expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    },
  )

  it.each(['response', 'error'] as const)(
    'keeps authoritative idle after both deferred Run and Stop tails settle with a late %s',
    async (outcome) => {
      const user = userEvent.setup()
      const api = createIdleResidentApi()
      const snapshot = await api.loadWorkbench()
      const promptTail = deferred<{ state: 'sent'; message: string }>()
      const stopTail = deferred<{ state: 'sent'; message: string }>()
      let publish: ((next: typeof snapshot) => void) | undefined
      api.loadWorkbench = vi.fn(() => Promise.resolve(structuredClone(snapshot)))
      api.subscribe = vi.fn((listener) => {
        publish = listener
        return () => undefined
      })
      api.sendComposer = vi.fn(() => promptTail.promise)
      api.abortThread = vi.fn(() => stopTail.promise)

      render(<App api={api} />)
      await screen.findByRole('heading', { name: 'Audit SSH discovery' })
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Fence both late IPC tails.')
      await user.click(screen.getByRole('button', { name: 'Run prompt' }))

      const active = structuredClone(snapshot)
      const activeThread = active.threads.find((thread) => thread.id === active.selectedThreadId)
      if (!activeThread || !active.runtime.session) throw new Error('Expected the selected resident thread')
      activeThread.status = 'running'
      active.runtime.session = { ...active.runtime.session, isStreaming: true, queuedActionCount: 1 }
      active.operations.startResidentTurn = false
      active.operations.stopResidentTurn = true
      active.composerReceipt = { state: 'sent', message: 'Prompt owned', operation: 'prompt' }
      await act(async () => publish?.(active))
      await user.click(screen.getByRole('button', { name: 'Stop the active Prime Agent turn' }))
      expect(screen.getByText('Requesting safe stop', { selector: '.composer__intent' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Safe Stop request is being sent' })).toHaveTextContent('Requesting stop')

      const idle = structuredClone(active)
      const idleThread = idle.threads.find((thread) => thread.id === idle.selectedThreadId)
      if (!idleThread || !idle.runtime.session) throw new Error('Expected the selected resident thread')
      idleThread.status = 'idle'
      idle.runtime.session = { ...idle.runtime.session, isStreaming: false, queuedActionCount: 0 }
      idle.operations.startResidentTurn = true
      idle.operations.stopResidentTurn = false
      idle.composerReceipt = { state: 'idle', message: 'Ready for a new prompt' }
      await act(async () => publish?.(idle))
      expect(screen.getByRole('button', { name: 'Run prompt' })).toBeEnabled()

      await act(async () => {
        if (outcome === 'response') {
          promptTail.resolve({ state: 'sent', message: 'Late prompt response' })
          stopTail.resolve({ state: 'sent', message: 'Late Stop response' })
        } else {
          promptTail.reject(new Error('Late prompt error'))
          stopTail.reject(new Error('Late Stop error'))
        }
        await Promise.allSettled([promptTail.promise, stopTail.promise])
      })

      expect(screen.getByRole('button', { name: 'Run prompt' })).toBeEnabled()
      expect(screen.queryByText(/Late prompt|Late Stop/)).not.toBeInTheDocument()
    },
  )

  it('does not let a same-host in-flight receipt clear a newer thread draft', async () => {
    const user = userEvent.setup()
    const api = createIdleResidentApi()
    const admission = deferred<{ state: 'sent'; message: string }>()
    api.sendComposer = vi.fn(() => admission.promise)

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    const firstComposer = screen.getByRole('textbox', { name: 'Message' })
    await user.type(firstComposer, 'First thread submission')
    await user.click(screen.getByRole('button', { name: 'Run prompt' }))

    const secondComposer = screen.getByRole('textbox', { name: 'Message' })
    await user.clear(secondComposer)
    await user.type(secondComposer, 'Newer draft for the second thread')

    await act(async () => {
      admission.resolve({ state: 'sent', message: 'Sent' })
      await admission.promise
    })

    expect(secondComposer).toHaveValue('Newer draft for the second thread')
    expect(within(screen.getByRole('region', { name: 'Thread transcript' })).queryByText('First thread submission')).not.toBeInTheDocument()
  })

  it('disables native execution affordances when the host did not negotiate them', async () => {
    const api = createIdleResidentApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.operations = {
        submitCommands: false,
        startResidentTurn: false,
        stopResidentTurn: false,
        crossHostHandoff: false,
      }
      return snapshot
    }
    api.sendComposer = vi.fn(async () => ({ state: 'sent', message: 'Sent' }))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })

    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run prompt' })).toBeDisabled()
    const location = screen.getByLabelText(/^Run location: devbox\. Moving threads between computers is unavailable$/)
    expect(location).toHaveTextContent('devboxMove unavailable')
    expect(screen.getAllByText(/resident session is not ready for a new prompt/i).some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(api.sendComposer).not.toHaveBeenCalled()
  })

  it('asks the adapter for the authoritative snapshot when a thread is selected', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const selectThread = vi.spyOn(api, 'selectThread')
    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    await user.click(screen.getByRole('button', { name: /Training runs/ }))

    expect(selectThread).toHaveBeenCalledWith('thread-gpu')
  })

  it('shows only the native runtime-backed model registry and preserves its read-only metadata controls', async () => {
    const user = userEvent.setup()
    const api = asNativeFixture(createPreviewRendererApi())
    const loadRuntimeModelCatalog = vi.spyOn(api, 'loadRuntimeModelCatalog')

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const trigger = screen.getByRole('button', { name: /Open models and accounts/ })
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    expect(await within(dialog).findByRole('complementary', { name: 'Accounts on devbox' })).toBeVisible()
    expect(dialog.querySelector('#models-description')).toHaveTextContent(/reported by Prime Agent on devbox/i)
    expect(within(dialog).queryByText(/illustrative|sample catalog|browser preview/i)).not.toBeInTheDocument()
    expect(loadRuntimeModelCatalog).toHaveBeenCalledWith('host-devbox')
    expect(within(dialog).getByText('2 configured')).toBeVisible()
    expect(within(dialog).getByText(/OAuth-capable providers · Prime Agent 0\.7\.0/)).toBeVisible()
    expect(within(dialog).getByText('GPT-5.6 Sol')).toBeVisible()
    expect(within(dialog).getByText('Kimi K3')).toBeVisible()
    expect(within(dialog).getByText('Current')).toBeVisible()
    expect(within(dialog).queryByText('Claude Opus 5')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /connect|select/i })).not.toBeInTheDocument()
    expect(within(dialog).getByText(/This registry view is read-only/)).toBeVisible()

    const providerToolbar = within(dialog).getByRole('toolbar', { name: 'Filter models by provider' })
    const allProviders = within(providerToolbar).getByRole('button', { name: /All providers/ })
    const codexProvider = within(providerToolbar).getByRole('button', { name: /ChatGPT Plus\/Pro/ })
    expect(providerToolbar).toHaveAttribute('aria-orientation', 'horizontal')
    expect(providerToolbar).toHaveAccessibleDescription(/Use Left and Right Arrow keys to select a provider/)
    expect(allProviders).toHaveAttribute('tabindex', '0')
    expect(codexProvider).toHaveAttribute('tabindex', '-1')
    allProviders.focus()
    await user.keyboard('{ArrowRight}')
    expect(codexProvider).toHaveFocus()
    expect(codexProvider).toHaveAttribute('aria-pressed', 'true')
    expect(codexProvider).toHaveAttribute('tabindex', '0')
    await user.keyboard('{End}')
    expect(within(providerToolbar).getByRole('button', { name: /^xAI/ })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(allProviders).toHaveFocus()

    await user.click(within(dialog).getByRole('button', { name: /Anthropic \(Claude Pro\/Max\)/ }))
    expect(within(dialog).getByText('OAuth is supported by Prime Agent')).toBeVisible()
    expect(within(dialog).getByText('0 available with current setup · 2 listed by the runtime')).toBeVisible()
    expect(within(dialog).getByText('/login')).toBeVisible()
    expect(within(dialog).getByText(/Credential material stays on this host/)).toBeVisible()
    expect(within(dialog).getByText('No available models match')).toBeVisible()

    await user.click(within(dialog).getByRole('button', { name: 'All models' }))
    expect(within(dialog).getByText('Claude Opus 5')).toBeVisible()
    expect(within(dialog).getAllByText('Setup required').length).toBeGreaterThan(0)
    expect(dialog.querySelector('.model-list')).not.toHaveAttribute('aria-live')
    expect(within(dialog).getByRole('status')).toHaveAttribute('aria-atomic', 'true')

    await user.click(within(dialog).getByRole('button', { name: 'Close models and accounts' }))
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('reveals every matching model in explicit batches and resets the batch when filters or the dialog change', async () => {
    const user = userEvent.setup()
    const api = asNativeFixture(createPreviewRendererApi())
    const catalog = withLargeModelCatalog(await api.loadRuntimeModelCatalog('host-devbox'))
    api.loadRuntimeModelCatalog = vi.fn(async () => structuredClone(catalog))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const trigger = screen.getByRole('button', { name: /Open models and accounts/ })
    await user.click(trigger)

    let dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    expect(await within(dialog).findByText('Showing 80 of 180 models')).toBeVisible()
    expect(within(dialog).getByText('Catalog model 080')).toBeVisible()
    expect(within(dialog).queryByText('Catalog model 081')).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Show 80 more models' }))
    expect(within(dialog).getByText('Showing 160 of 180 models')).toBeVisible()
    expect(within(dialog).getByText('Catalog model 160')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Show 20 more models' })).toBeVisible()

    await user.click(within(dialog).getByRole('button', { name: /ChatGPT Plus\/Pro/ }))
    expect(within(dialog).getByText('Showing 80 of 90 models')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Show 10 more models' }))
    expect(within(dialog).getByText('Showing 90 of 90 models')).toBeVisible()

    await user.type(within(dialog).getByRole('searchbox', { name: 'Search models' }), 'Catalog')
    expect(within(dialog).getByText('Showing 80 of 90 models')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Show 10 more models' }))
    await user.click(within(dialog).getByRole('button', { name: 'All models' }))
    expect(within(dialog).getByText('Showing 80 of 90 models')).toBeVisible()

    await user.click(within(dialog).getByRole('button', { name: 'Close models and accounts' }))
    await user.click(trigger)
    dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    expect(await within(dialog).findByText('Showing 80 of 180 models')).toBeVisible()
    expect(api.loadRuntimeModelCatalog).toHaveBeenCalledTimes(2)
  })

  it('retries a recoverable catalog load without enabling model mutation controls', async () => {
    const user = userEvent.setup()
    const api = asNativeFixture(createPreviewRendererApi())
    const catalog = await api.loadRuntimeModelCatalog('host-devbox')
    const loadRuntimeModelCatalog = vi.fn()
      .mockRejectedValueOnce(new Error('The catalog request timed out.'))
      .mockResolvedValue(catalog)
    api.loadRuntimeModelCatalog = loadRuntimeModelCatalog

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: /Open models and accounts/ }))

    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    expect(await within(dialog).findByText('The catalog request timed out.')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Retry loading catalog' }))
    expect(await within(dialog).findByText('Models reported by this host')).toBeVisible()
    expect(loadRuntimeModelCatalog).toHaveBeenCalledTimes(2)
    expect(within(dialog).queryByRole('button', { name: /select model|use model|switch model/i })).not.toBeInTheDocument()
  })

  it('does not retry a catalog request captured for stale host authority', async () => {
    const user = userEvent.setup()
    const api = asNativeFixture(createPreviewRendererApi())
    const loadRuntimeModelCatalog = vi.fn(async () => {
      throw new StaleHostAuthorityError()
    })
    api.loadRuntimeModelCatalog = loadRuntimeModelCatalog

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const trigger = screen.getByRole('button', { name: /Open models and accounts/ })
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    expect(await within(dialog).findByText(/Close this dialog, confirm the active computer, then reopen Models & accounts/)).toBeVisible()
    expect(within(dialog).queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Close dialog' }))
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(loadRuntimeModelCatalog).toHaveBeenCalledOnce()
  })

  it('shows Add computer as one keyboard-operable sheet with exact connection and install details', async () => {
    const user = userEvent.setup()
    render(<App api={createNativeUiFixture()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const sidebarToggle = screen.getByRole('button', { name: 'Open sidebar' })
    await user.click(sidebarToggle)
    const sidebar = await screen.findByRole('dialog', { name: 'Projects and threads' })
    const trigger = within(sidebar).getByRole('button', { name: 'Add computer' })

    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Add computer' })
    expect(within(dialog).getByText('Discovered aliases')).toBeVisible()
    expect((await within(dialog).findAllByText('ebene@devbox.internal:22')).length).toBeGreaterThan(0)
    expect(within(dialog).getByText('Verified by OpenSSH')).toBeVisible()
    expect(within(dialog).getByText('Host-key fingerprint')).toBeVisible()
    expect(within(dialog).queryByText(/sample|browser preview|manual host/i)).not.toBeInTheDocument()
    expect(within(dialog).getByText('Readiness check')).toBeVisible()

    await user.click(within(dialog).getByText('Show exact install command'))
    expect(within(dialog).getByText(/No signed host-service installer is available in this build/)).toBeVisible()
    expect(within(dialog).getByRole('checkbox', { name: /Install the signed Continuim host service/ })).toBeDisabled()
    const unavailableInstaller = within(dialog).getByRole('button', { name: 'Host-service installer unavailable' })
    expect(unavailableInstaller).toBeDisabled()
    expect(unavailableInstaller).toHaveAttribute('aria-describedby', 'add-computer-install-unavailable')
    await user.click(within(dialog).getByText('Install Prime Agent on macOS or Linux'))
    expect(within(dialog).getByText('curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh')).toBeVisible()
    expect(within(dialog).getByText(/never runs this command automatically/i)).toBeVisible()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(sidebarToggle).toHaveFocus())
  })

  it('announces official installer clipboard results', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      render(<App api={createNativeUiFixture()} />)
      await screen.findByRole('heading', { name: 'Seamless remote experience' })
      await user.click(screen.getByRole('button', { name: 'Open sidebar' }))
      const sidebar = await screen.findByRole('dialog', { name: 'Projects and threads' })
      await user.click(within(sidebar).getByRole('button', { name: 'Add computer' }))
      const dialog = await screen.findByRole('dialog', { name: 'Add computer' })
      await within(dialog).findByText('Readiness check')
      await user.click(within(dialog).getByText('Install Prime Agent on macOS or Linux'))
      await user.click(within(dialog).getByRole('button', { name: 'Copy official Prime Agent install command' }))

      await waitFor(() => expect(writeText).toHaveBeenCalledWith('curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh'))
      expect(within(dialog).getByText('Prime Agent install command copied to the clipboard.')).toBeVisible()
      await user.click(within(dialog).getByRole('button', { name: 'Copy official Prime Agent install command' }))
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    }
  })

  it('labels absent runtime telemetry as not reported instead of zero', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.runtime = { queue: { pendingCount: 0, paused: false } }
      snapshot.agents = []
      return snapshot
    }

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    expect(within(screen.getByRole('region', { name: 'Session status' })).getByText('Goal state unavailable')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Runtime' }))
    const runtimePanel = screen.getByRole('tabpanel', { name: 'Runtime' })

    expect(within(runtimePanel).getByText('Current thread · runtime not reported')).toBeVisible()
    expect(within(runtimePanel).getByText('Agent activity isn’t reported in this snapshot.')).toBeVisible()
    expect(within(runtimePanel).getByText('Goals aren’t reported in this snapshot.')).toBeVisible()
    expect(within(runtimePanel).getByText('Schedules aren’t reported in this snapshot.')).toBeVisible()
    expect(within(runtimePanel).getByText('Goals not reported · Agents not reported')).toBeVisible()
    expect(within(runtimePanel).queryByText('0 active · 0 agents')).not.toBeInTheDocument()
  })

  it.each([
    [
      'unreported verification',
      { kind: 'not_reported', freshness: 'live' },
      'This host service doesn’t report runtime verification.',
      undefined,
    ],
    [
      'runtime preparation',
      { kind: 'reported', freshness: 'live', status: 'initializing', phase: 'verifying' },
      'Preparing verified Prime Agent runtime · Verifying files',
      undefined,
    ],
    [
      'cached verification failure',
      {
        kind: 'reported',
        freshness: 'cached',
        observedAt: '2026-08-05T20:00:00.000Z',
        status: 'failed',
        recovery: 'repair',
      },
      'Last reported · Runtime verification failed',
      'Record diagnostics and contact support before changing local runtime data.',
    ],
    [
      'ready development integrity',
      { kind: 'reported', freshness: 'live', status: 'ready', assurance: 'development-integrity' },
      'Development integrity',
      undefined,
    ],
    [
      'ready runtime without an assurance claim',
      { kind: 'reported', freshness: 'live', status: 'ready' },
      'Runtime files verified',
      undefined,
    ],
  ] satisfies Array<[string, HostRuntimeReadiness, string, string | undefined]>) (
    'renders compact, honest host %s in the Runtime facts',
    async (_caseName, readiness, summary, detail) => {
      const user = userEvent.setup()
      const api = createPreviewRendererApi()
      const loadWorkbench = api.loadWorkbench.bind(api)
      api.loadWorkbench = async () => {
        const snapshot = await loadWorkbench()
        const activeHost = snapshot.hosts.find((host) => host.id === snapshot.threads.find((thread) => thread.id === snapshot.selectedThreadId)?.hostId)
        if (activeHost) activeHost.runtimeReadiness = readiness
        return snapshot
      }

      render(<App api={api} />)
      await screen.findByRole('heading', { name: 'Seamless remote experience' })
      await user.click(screen.getByRole('tab', { name: 'Runtime' }))
      const runtimePanel = screen.getByRole('tabpanel', { name: 'Runtime' })

      expect(within(runtimePanel).getByText('Runtime verification')).toBeVisible()
      expect(within(runtimePanel).getByText(summary)).toBeVisible()
      if (detail) expect(within(runtimePanel).getByText(detail)).toBeVisible()
      if (readiness.freshness === 'cached') {
        const observed = runtimePanel.querySelector(`time[datetime="${readiness.observedAt}"]`)
        expect(observed).toBeVisible()
        expect(observed).toHaveTextContent(/^Observed /)
      }
      expect(within(runtimePanel).queryByText(/RUNTIME_INTEGRITY_/)).not.toBeInTheDocument()
    },
  )

  it('renders persisted work reports independently from live session telemetry', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.runtime = {
        agentsReported: true,
        goals: [{ id: 'persisted-goal', objective: 'Finish the persisted review', state: 'paused' }],
        schedules: [{ id: 'persisted-schedule', label: 'Resume the review tomorrow', state: 'paused' }],
      }
      snapshot.agents = [{
        id: 'persisted-agent',
        name: 'Review helper',
        role: 'Retained subagent',
        status: 'waiting',
        hostName: 'devbox',
      }]
      return snapshot
    }

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    expect(within(screen.getByRole('region', { name: 'Session status' })).getByText('Finish the persisted review')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Runtime' }))
    const runtimePanel = screen.getByRole('tabpanel', { name: 'Runtime' })

    expect(within(runtimePanel).getByText('Current thread · session not reported')).toBeVisible()
    expect(within(runtimePanel).getByText('Finish the persisted review')).toBeVisible()
    expect(within(runtimePanel).getByText('Resume the review tomorrow')).toBeVisible()
    expect(within(runtimePanel).getByText('Review helper')).toBeVisible()
  })

  it('omits arbitrary host entry and focuses and clears install-consent errors', async () => {
    const user = userEvent.setup()
    const api = createNativeUiFixture()
    const discoverComputers = api.discoverComputers.bind(api)
    api.discoverComputers = vi.fn(async () => (await discoverComputers()).map((computer, index) => ({
      ...computer,
      probeComplete: true,
      requiresInstall: index === 0,
      installAvailable: true,
      installCommand: "ssh devbox 'continuim-hostd install --user'",
      installDeferredReason: undefined,
    })))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: 'Open sidebar' }))
    const sidebar = await screen.findByRole('dialog', { name: 'Projects and threads' })
    await user.click(within(sidebar).getByRole('button', { name: 'Add computer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add computer' })

    expect(within(dialog).queryByRole('textbox', { name: 'Hostname or SSH alias' })).not.toBeInTheDocument()
    expect(within(dialog).getByText('Alias not listed?')).toBeVisible()

    const consent = await within(dialog).findByRole('checkbox', { name: /Install the signed Continuim host service/ })
    await waitFor(() => expect(consent).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: /Install and add/ }))
    expect(consent).toHaveFocus()
    expect(consent).toHaveAttribute('aria-invalid', 'true')
    expect(consent).toHaveAttribute('aria-describedby', 'add-computer-error')
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/Allow installation/i)

    await user.click(consent)
    expect(consent).toHaveAttribute('aria-invalid', 'false')
    expect(consent).not.toHaveAttribute('aria-describedby')
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reviews and completes a checkpoint handoff without changing the reviewed source', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    await user.selectOptions(screen.getByRole('combobox', { name: /Run location:/ }), 'host-local')
    const dialog = await screen.findByRole('dialog', { name: 'Move thread' })
    expect(await within(dialog).findByText('Move review')).toBeVisible()
    expect(dialog).toHaveTextContent(/devbox remains authoritative/i)
    expect(within(dialog).getByText('Running subprocesses')).toBeVisible()
    expect(within(dialog).getByText(/checkpoint transfer, not a live process migration/i)).toBeVisible()

    await user.click(within(dialog).getByRole('radio', { name: /Interrupt this turn/ }))
    const moveButton = within(dialog).getByRole('button', { name: 'Move thread to This computer' })
    await waitFor(() => expect(moveButton).toBeEnabled())
    await user.click(moveButton)

    await waitFor(() => expect(dialog).toHaveTextContent(/Moved from devbox to This computer/i), { timeout: 4_000 })
    expect(dialog).not.toHaveTextContent(/Moved from This computer to This computer/i)
    expect(within(dialog).getByText(/Runtime-local Python state restarted/i)).toBeVisible()
  }, 6_000)

  it('implements arrow-key navigation for inspector tabs', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    const inspectorToggle = screen.getByRole('button', { name: 'Open inspector' })
    expect(inspectorToggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(inspectorToggle)

    const changes = screen.getByRole('tab', { name: 'Changes' })
    changes.focus()
    await user.keyboard('{ArrowRight}')

    expect(screen.getByRole('tab', { name: 'Runtime' })).toHaveAttribute('aria-selected', 'true')
    const runtimePanel = screen.getByRole('tabpanel', { name: 'Runtime' })
    expect(within(runtimePanel).getByRole('heading', { name: 'Reported runtime' })).toBeVisible()
    expect(within(runtimePanel).getByText('Implement the seamless remote workbench')).toBeVisible()
    expect(within(runtimePanel).getByText('Review overnight verification')).toBeVisible()
    expect(within(runtimePanel).getAllByText('Subagent of Workbench lead')).toHaveLength(2)
    expect(within(runtimePanel).getByText(/18 tool uses/)).toBeVisible()
  })

  it('progressively mounts large retained-subagent projections in bounded windows', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.agents = Array.from({ length: 120 }, (_, index) => ({
        id: `agent-${index}`,
        ...(index > 0 ? { parentId: 'agent-0' } : {}),
        name: `Agent ${index + 1}`,
        role: 'Retained subagent',
        status: index % 3 === 0 ? 'running' as const : 'waiting' as const,
        hostName: 'devbox',
      }))
      return snapshot
    }

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    await user.click(screen.getByRole('tab', { name: 'Runtime' }))
    const runtimePanel = screen.getByRole('tabpanel', { name: 'Runtime' })

    expect(runtimePanel.querySelectorAll('[data-runtime-agent]')).toHaveLength(50)
    await user.click(within(runtimePanel).getByRole('button', { name: 'Show 50 more subagents' }))
    expect(runtimePanel.querySelectorAll('[data-runtime-agent]')).toHaveLength(100)
    await user.click(within(runtimePanel).getByRole('button', { name: 'Show 20 more subagents' }))
    expect(runtimePanel.querySelectorAll('[data-runtime-agent]')).toHaveLength(120)
    expect(within(runtimePanel).queryByRole('button', { name: /more subagents/ })).not.toBeInTheDocument()
  })

  it('keeps projection-only inspector data non-interactive and reports the real connection state', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    const changesPanel = screen.getByRole('tabpanel', { name: 'Changes' })
    expect(within(changesPanel).queryByRole('button')).not.toBeInTheDocument()
    expect(within(changesPanel).queryByText('App.tsx')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Runtime' }))
    expect(within(screen.getByRole('tabpanel', { name: 'Runtime' })).queryByRole('button')).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    expect(within(screen.getByRole('tabpanel', { name: 'Evidence' })).queryByRole('button', { name: 'Run checks' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Training runs/ }))
    await user.click(screen.getByRole('tab', { name: 'Context' }))
    const contextPanel = screen.getByRole('tabpanel', { name: 'Context' })
    expect(within(contextPanel).getByText(/Offline · Last synchronized 18 min ago/)).toBeVisible()
    expect(within(contextPanel).queryByText('Running')).not.toBeInTheDocument()
  })

  it('omits controls that do not have backing operations', async () => {
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    expect(screen.queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New thread' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Running.*Seamless remote experience/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Search projects and threads' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Attach files' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })

  it('labels verification-only host identity results without inventing a fingerprint', async () => {
    const user = userEvent.setup()
    const api = asNativeFixture(createPreviewRendererApi())
    api.discoverComputers = async () => [
      {
        alias: 'verification-only',
        effectiveTarget: 'developer@build.example.com:22',
        fingerprint: 'Host identity was checked by system OpenSSH; the exact fingerprint was not returned by this probe.',
        protocol: 'System OpenSSH',
        platform: 'Ubuntu 24.04',
        architecture: 'x86_64',
        diskFree: '80 GB free',
        gitVersion: 'Git 2.45.2',
        pythonStatus: 'Python 3.12',
        agentVersion: 'Prime Agent 0.7.0',
        hostServiceVersion: 'Host service 0.1.0',
        requiresInstall: false,
        installCommand: "ssh verification-only 'prime-agent-hostd install --user'",
        recentProjects: [],
        probeComplete: true,
        installAvailable: true,
      },
    ]

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: 'Add computer' }))

    const dialog = await screen.findByRole('dialog', { name: 'Add computer' })
    expect(await within(dialog).findByText('Host verification')).toBeVisible()
    expect(within(dialog).queryByText('Host-key fingerprint')).not.toBeInTheDocument()
    expect(within(dialog).getByText(/Host identity was checked by system OpenSSH/)).toBeVisible()
    expect(within(dialog).queryByText(/sample|browser preview/i)).not.toBeInTheDocument()
  })

  it('opens a real command palette and navigates to a matching durable thread', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const selectThread = vi.spyOn(api, 'selectThread')
    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    await user.keyboard('{Control>}k{/Control}')
    const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
    const search = within(palette).getByRole('combobox', { name: 'Search projects, threads, and commands' })
    expect(search).toHaveFocus()
    expect(search).toHaveAttribute('aria-autocomplete', 'list')
    await user.type(search, 'Benchmark attention')
    expect(within(palette).queryByText('New thread')).not.toBeInTheDocument()
    const matchingOption = within(palette).getByRole('option', { name: /Benchmark attention kernel/ })
    expect(matchingOption).toHaveAttribute('tabindex', '-1')
    await user.click(matchingOption)

    expect(await screen.findByRole('heading', { name: 'Benchmark attention kernel' })).toBeVisible()
    expect(selectThread).toHaveBeenCalledWith('thread-gpu')

    await user.keyboard('{Control>}k{/Control}')
    const reopenedPalette = await screen.findByRole('dialog', { name: 'Search and commands' })
    const reopenedSearch = within(reopenedPalette).getByRole('combobox', { name: 'Search projects, threads, and commands' })
    await user.type(reopenedSearch, 'Companion')
    expect(within(reopenedPalette).getByText('No matching thread, project, or available command.')).toBeVisible()
    expect(within(reopenedPalette).queryByRole('option', { name: /companion|mobile|phone/i })).not.toBeInTheDocument()
  })

  it('does not expose deferred mobile controls or honor the retired Companion route', async () => {
    window.history.replaceState({}, '', '/?surface=companion')
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)

    expect(await screen.findByRole('heading', { name: 'Seamless remote experience' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Needs you' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open sidebar' }))
    const sidebar = await screen.findByRole('dialog', { name: 'Projects and threads' })
    expect(within(sidebar).queryByRole('button', { name: /companion|mobile|phone/i })).not.toBeInTheDocument()
  })

  it('closes the command palette with an explicit touch target and ignores its shortcut over another sheet', async () => {
    const user = userEvent.setup()
    render(<App api={createNativeUiFixture()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    const sidebarTrigger = screen.getByRole('button', { name: 'Open sidebar' })
    await user.click(sidebarTrigger)
    const sidebar = await screen.findByRole('dialog', { name: 'Projects and threads' })
    await user.keyboard('{Control>}k{/Control}')
    expect(sidebar).toHaveAttribute('aria-modal', 'true')
    expect(screen.queryByRole('dialog', { name: 'Search and commands' })).not.toBeInTheDocument()
    await user.click(within(sidebar).getByRole('button', { name: 'Close sidebar' }))
    await waitFor(() => expect(sidebarTrigger).toHaveFocus())

    const paletteTrigger = screen.getByRole('button', { name: 'Search projects, threads, and commands' })
    await user.click(paletteTrigger)
    const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
    expect(palette).toHaveAttribute('open')

    await user.click(within(palette).getByRole('button', { name: 'Close search and commands' }))
    await waitFor(() => expect(paletteTrigger).toHaveFocus())
    expect(screen.queryByRole('dialog', { name: 'Search and commands' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add computer' }))
    const addComputer = await screen.findByRole('dialog', { name: 'Add computer' })
    await user.keyboard('{Control>}k{/Control}')

    expect(addComputer).toHaveAttribute('open')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: 'Search and commands' })).not.toBeInTheDocument()
  })
  it('keeps an in-flight handoff visible when Escape or the backdrop is used', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const handoff = deferred<{ destinationHostId: string; receiptId: string }>()
    api.startHandoff = vi.fn(async (_input, onProgress) => {
      onProgress('quiescing', 'Preparing the source')
      return handoff.promise
    })

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.selectOptions(screen.getByRole('combobox', { name: /Run location:/ }), 'host-local')

    const dialog = await screen.findByRole('dialog', { name: 'Move thread' })
    const moveButton = await within(dialog).findByRole('button', { name: 'Move thread to This computer' })
    await waitFor(() => expect(moveButton).toBeEnabled())
    await user.click(moveButton)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Moving thread…' })).toBeDisabled())
    const progressHeading = within(dialog).getByRole('heading', { name: 'Move progress' })
    await waitFor(() => expect(progressHeading).toHaveFocus())
    expect(within(dialog).getByText('Prepare source').closest('li')).toHaveAttribute('aria-current', 'step')

    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }))
    fireEvent.click(dialog)
    expect(dialog).toHaveAttribute('open')
    expect(within(dialog).getByRole('button', { name: 'Close Move thread' })).toBeDisabled()
    expect(within(dialog).getByRole('radio', { name: /Wait for this turn/ })).toBeDisabled()

    await act(async () => {
      handoff.resolve({ destinationHostId: 'host-local', receiptId: 'handoff_receipt_guarded' })
      await handoff.promise
    })
    const continueThread = await within(dialog).findByRole('button', { name: 'Continue thread' })
    expect(continueThread).toBeEnabled()
    await waitFor(() => expect(continueThread).toHaveFocus())
  })

  it('keeps responsive drawers mutually exclusive when a sidebar command opens the inspector', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    await user.click(screen.getByRole('button', { name: 'Open sidebar' }))
    const sidebar = await screen.findByRole('dialog', { name: 'Projects and threads' })
    await user.click(within(sidebar).getByRole('button', { name: 'Search projects and threads' }))

    const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toHaveAttribute('aria-expanded', 'false')
    await user.click(within(palette).getByRole('option', { name: /Open changes and evidence/ }))

    const inspector = await screen.findByRole('dialog', { name: 'Thread inspector' })
    await waitFor(() => expect(within(inspector).getByRole('tab', { name: 'Changes' })).toHaveFocus())
    expect(document.querySelector('.app-shell')).toHaveAttribute('data-sidebar-open', 'false')
    expect(document.querySelector('.app-shell')).toHaveAttribute('data-inspector-open', 'true')
    expect(screen.queryByRole('dialog', { name: 'Projects and threads' })).not.toBeInTheDocument()
  })

  it('keeps notices in one stable grid row when an offline thread refresh also fails', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    api.selectThread = vi.fn(async () => {
      throw new Error('Host unavailable')
    })

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: /Training runs/ }))
    await screen.findByText(/Couldn’t refresh Benchmark attention kernel. Host unavailable/)

    const threadView = document.querySelector('.thread-view')
    expect(threadView).not.toBeNull()
    expect(Array.from(threadView?.children ?? []).map((element) => element.classList[0])).toEqual([
      'thread-notices',
      'transcript',
      'composer-wrap',
    ])
    expect(threadView?.querySelectorAll('.thread-notices .connection-notice')).toHaveLength(2)
  })

  it('scrolls the command palette active descendant into view during keyboard navigation', async () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    const scrolledOptions: HTMLElement[] = []
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: HTMLElement) {
        scrolledOptions.push(this)
      },
    })

    try {
      const user = userEvent.setup()
      render(<App api={createPreviewRendererApi()} />)
      await screen.findByRole('heading', { name: 'Seamless remote experience' })
      await user.keyboard('{Control>}k{/Control}')
      const input = await screen.findByRole('combobox', { name: 'Search projects, threads, and commands' })
      await waitFor(() => expect(scrolledOptions.length).toBeGreaterThan(0))
      scrolledOptions.length = 0

      await user.keyboard('{ArrowDown}')
      await waitFor(() => expect(scrolledOptions.length).toBeGreaterThan(0))
      const activeId = input.getAttribute('aria-activedescendant')
      expect(activeId).toBeTruthy()
      expect(scrolledOptions[scrolledOptions.length - 1]).toHaveAttribute('id', activeId)
    } finally {
      if (previousDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousDescriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    }
  })

  it('mounts recent transcript activity in bounded increments and preserves the reading anchor', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.threads[0]!.transcript = Array.from({ length: 450 }, (_, index) => ({
        id: `history-${index + 1}`,
        kind: 'assistant' as const,
        author: 'Prime Agent',
        time: 'Now',
        body: `Activity ${index + 1}`,
      }))
      return snapshot
    }

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const transcript = screen.getByRole('region', { name: 'Thread transcript' })
    let scrollTop = 300
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: {
        configurable: true,
        get: () => transcript.querySelectorAll('[data-transcript-block]').length * 10,
      },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value },
      },
    })
    fireEvent.scroll(transcript)

    expect(transcript.querySelectorAll('[data-transcript-block]')).toHaveLength(200)
    expect(within(transcript).queryByText('Activity 250')).not.toBeInTheDocument()
    expect(within(transcript).getByText('Activity 251')).toBeVisible()

    await user.click(within(transcript).getByRole('button', { name: 'Load earlier activity' }))
    expect(transcript.querySelectorAll('[data-transcript-block]')).toHaveLength(400)
    expect(within(transcript).getByText('Activity 51')).toBeVisible()
    expect(scrollTop).toBe(2_300)

    await user.click(within(transcript).getByRole('button', { name: 'Load earlier activity' }))
    expect(transcript.querySelectorAll('[data-transcript-block]')).toHaveLength(450)
    expect(within(transcript).getByText('Activity 1')).toBeVisible()
    expect(within(transcript).getByRole('button', { name: 'All activity loaded' })).toBeDisabled()
  })

  it('follows new transcript messages only near the bottom and resets on thread changes', async () => {
    const user = userEvent.setup()
    const api = createIdleResidentApi()
    const initialSnapshot = await api.loadWorkbench()
    let authoritative = structuredClone(initialSnapshot)
    let publish: ((next: typeof initialSnapshot) => void) | undefined
    api.loadWorkbench = vi.fn(() => Promise.resolve(structuredClone(initialSnapshot)))
    api.subscribe = vi.fn((listener) => {
      publish = listener
      return () => undefined
    })

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    const transcript = screen.getByRole('region', { name: 'Thread transcript' })
    let scrollHeight = 1_000
    let scrollTop = 600
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value },
      },
    })

    fireEvent.scroll(transcript)
    scrollHeight = 1_200
    expect(within(transcript).queryByText('Follow the first response.')).not.toBeInTheDocument()
    authoritative = structuredClone(authoritative)
    authoritative.threads.find((thread) => thread.id === authoritative.selectedThreadId)?.transcript.push({
      id: 'authoritative-follow-response',
      kind: 'user',
      author: 'You',
      time: 'Now',
      body: 'Follow the first response.',
    })
    await act(async () => publish?.(authoritative))
    await screen.findByText('Follow the first response.')
    await waitFor(() => expect(scrollTop).toBe(1_200))

    scrollTop = 200
    fireEvent.scroll(transcript)
    scrollHeight = 1_400
    expect(within(transcript).queryByText('Do not steal my reading position.')).not.toBeInTheDocument()
    authoritative = structuredClone(authoritative)
    authoritative.threads.find((thread) => thread.id === authoritative.selectedThreadId)?.transcript.push({
      id: 'authoritative-reading-position',
      kind: 'user',
      author: 'You',
      time: 'Now',
      body: 'Do not steal my reading position.',
    })
    const composer = screen.getByRole('textbox', { name: 'Message' })
    composer.focus()
    await act(async () => publish?.(authoritative))
    await screen.findByText('Do not steal my reading position.')
    expect(scrollTop).toBe(200)
    expect(composer).toHaveFocus()

    const jumpToLatest = await screen.findByRole('button', { name: 'New activity · Jump to latest' })
    await user.click(jumpToLatest)
    expect(scrollTop).toBe(1_400)
    expect(screen.queryByRole('button', { name: 'New activity · Jump to latest' })).not.toBeInTheDocument()
    expect(transcript).toHaveFocus()

    scrollHeight = 800
    await user.click(screen.getByRole('button', { name: /Training runs/ }))
    await screen.findByRole('heading', { name: 'Benchmark attention kernel' })
    expect(scrollTop).toBe(800)
  })

  it('continues following same-block streaming growth while the reader stays near the bottom', async () => {
    const api = createPreviewRendererApi()
    const snapshot = await api.loadWorkbench()
    let publish: ((next: typeof snapshot) => void) | undefined
    api.loadWorkbench = vi.fn(() => Promise.resolve(snapshot))
    api.subscribe = vi.fn((listener) => {
      publish = listener
      return () => undefined
    })

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const transcript = screen.getByRole('region', { name: 'Thread transcript' })
    let scrollHeight = 1_000
    let scrollTop = 600
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value },
      },
    })
    fireEvent.scroll(transcript)

    const next = structuredClone(snapshot)
    const selected = next.threads.find((thread) => thread.id === next.selectedThreadId)
    const last = selected?.transcript.at(-1)
    if (!last) throw new Error('Expected a final transcript block')
    last.body = `${last.body} Streaming continuation in the same block.`
    scrollHeight = 1_180
    await act(async () => publish?.(next))

    expect(scrollTop).toBe(1_180)
  })

  it('contains focus in narrow drawers, closes with Escape, and restores each trigger', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    const sidebarToggle = screen.getByRole('button', { name: 'Open sidebar' })
    await user.click(sidebarToggle)
    const sidebar = screen.getByRole('dialog', { name: 'Projects and threads' })
    expect(sidebar).toHaveAttribute('aria-modal', 'true')
    const firstSidebarAction = within(sidebar).getByRole('button', { name: 'Close sidebar' })
    await waitFor(() => expect(firstSidebarAction).toHaveFocus())
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(within(sidebar).getByRole('combobox', { name: /Compact run location/ })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(sidebarToggle).toHaveFocus())
    expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(sidebarToggle)
    const reopenedSidebar = screen.getByRole('dialog', { name: 'Projects and threads' })
    await user.click(within(reopenedSidebar).getByRole('button', { name: 'Close sidebar' }))
    await waitFor(() => expect(sidebarToggle).toHaveFocus())

    const inspectorToggle = screen.getByRole('button', { name: 'Open inspector' })
    await user.click(inspectorToggle)
    expect(screen.getByRole('dialog', { name: 'Thread inspector' })).toHaveAttribute('aria-modal', 'true')
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Changes' })).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(inspectorToggle).toHaveFocus())
    expect(inspectorToggle).toHaveAttribute('aria-expanded', 'false')
  })
})
