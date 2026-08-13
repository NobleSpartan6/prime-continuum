// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import App from '../../src/renderer/src/App'
import { createPreviewRendererApi, previewSnapshot } from '../../src/renderer/src/api.preview'
import {
  ResidentProvisionError,
  StaleHostAuthorityError,
  type HostRuntimeReadiness,
  type LocalSetupSummary,
  type RendererApi,
  type ResidentLifecycleOperationSummary,
  type RuntimeModelCatalog,
  type WorkbenchSnapshot,
} from '../../src/renderer/src/api'
import type { HudMode, HudState, HudTarget } from '../../src/shared/window-control'
import type { NativeShellCommand } from '../../src/shared/native-shell'
import type {
  CandidateEvaluationPreflight,
  CandidateEvaluationSnapshot,
  CandidateEvaluationStartRequest,
  CandidateEvaluationStatus,
  ResidentExtensionUiRequest,
} from '../../src/shared/protocol'

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

function createExtensionUiAppHarness(
  responseResult: Awaited<ReturnType<NonNullable<RendererApi['respondToResidentExtensionUi']>>> = {
    state: 'completed',
    message: 'Response delivered.',
  },
) {
  const api = asNativeFixture(createPreviewRendererApi())
  let current = structuredClone(previewSnapshot)
  const listeners = new Set<(snapshot: WorkbenchSnapshot) => void>()
  const selectedThread = current.threads.find((thread) => thread.id === 'thread-protocol')!
  const selectedHost = current.hosts.find((host) => host.id === selectedThread.hostId)!
  const request: ResidentExtensionUiRequest = {
    interactionVersion: 1,
    hostId: selectedHost.id,
    threadId: selectedThread.id,
    executionGenerationId: 'generation-extension-ui',
    bindingFingerprint: 'a'.repeat(64),
    requestId: 'request-extension-ui',
    requestDigest: 'b'.repeat(64),
    receivedAt: '2026-08-12T14:00:00.000Z',
    method: 'confirm',
    title: 'Use the verified migration plan?',
    message: 'Prime Agent needs this decision to continue.',
  }
  current.selectedProjectId = selectedThread.projectId
  current.selectedThreadId = selectedThread.id
  selectedThread.status = 'idle'
  selectedThread.executionGenerationId = request.executionGenerationId
  selectedHost.connection = 'online'
  selectedHost.activationRequired = false
  current.agents = []
  current.runtime.agentsReported = true
  if (current.runtime.session) {
    current.runtime.session = {
      ...current.runtime.session,
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      queuedActionCount: 0,
      activeToolNames: [],
    }
  }
  current.operations = {
    ...current.operations,
    submitCommands: true,
    startResidentTurn: true,
    stopResidentTurn: false,
  }
  current.residentExtensionUiRequests = [request]
  current.composerReceipt = { state: 'idle', message: 'Ready to send' }
  api.loadWorkbench = vi.fn(async () => structuredClone(current))
  api.subscribe = vi.fn((listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  })
  api.respondToResidentExtensionUi = vi.fn(async () => responseResult)
  const publish = (next: WorkbenchSnapshot) => {
    current = structuredClone(next)
    listeners.forEach((listener) => listener(structuredClone(current)))
  }
  return {
    api,
    request,
    snapshot: () => structuredClone(current),
    publish,
  }
}

const candidateEvaluationBoundary = {
  securitySandbox: false,
  mainFilesystemIsolation: false,
  providerBackedEvaluation: false,
  autonomousPromotion: false,
  candidateControlledEvaluation: true,
  packageOrInstallerGate: false,
  authenticated: false,
  integrity: 'sha256-correlation-only-not-authentication' as const,
}

const candidateEvaluationSource = {
  headCommit: 'a'.repeat(40),
  dirty: true,
  statusPorcelainV2Sha256: 'b'.repeat(64),
  statusBytes: 42,
  binaryPatchSha256: 'c'.repeat(64),
  binaryPatchBytes: 512,
  untrackedManifestSha256: 'd'.repeat(64),
  untrackedFileCount: 1,
  untrackedBytes: 24,
  treeSha256: 'e'.repeat(64),
  treeFileCount: 334,
  treeBytes: 7_879_590,
}

const candidateEvaluationReview = {
  headCommit: 'a'.repeat(40),
  gitIndexSha256: '1'.repeat(64),
  gitIndexBytes: 1_024,
  packageManifestSha256: '2'.repeat(64),
  lockfileSha256: '3'.repeat(64),
  lockfileBytes: 32_768,
  nodeVersionPinSha256: '4'.repeat(64),
  selfBuildEntrypointSha256: '5'.repeat(64),
  launcherBootstrapSha256: 'a'.repeat(64),
  launcherBootstrapFileCount: 9 as const,
  runtimePointerSha256: '6'.repeat(64),
  nodePackageManifestSha256: '7'.repeat(64),
  nodeExecutableSha256: '8'.repeat(64),
  pnpmCliSha256: '9'.repeat(64),
  reviewAggregateSha256: '0'.repeat(64),
}

const candidateEvaluationUncertain: CandidateEvaluationStatus = {
  statusVersion: 1,
  expectedHostId: 'host-local',
  threadId: 'thread-protocol',
  expectedExecutionGenerationId: 'candidate-generation-one',
  operationId: 'candidate-evaluation:uncertain-one',
  kind: 'prime_continuim_self_build_v1',
  requestedAt: '2026-08-09T12:00:00.000Z',
  updatedAt: '2026-08-09T12:01:00.000Z',
  completedAt: '2026-08-09T12:01:00.000Z',
  invocationStartedAt: '2026-08-09T12:00:01.000Z',
  status: 'uncertain',
  review: candidateEvaluationReview,
  boundary: candidateEvaluationBoundary,
  error: {
    code: 'EVALUATION_OUTCOME_UNKNOWN',
    message: 'The exact invocation outcome is unknown.',
    retryable: false,
  },
}

function createCandidateEvaluationHarness(
  initialEvaluations: CandidateEvaluationStatus[] = [],
  initialRepeatEffectsWarningRequired = initialEvaluations.some((evaluation) => evaluation.status === 'uncertain'),
) {
  const api = asNativeFixture(createPreviewRendererApi())
  const listeners = new Set<(next: WorkbenchSnapshot) => void>()
  let current = structuredClone(previewSnapshot)
  const thread = current.threads.find((entry) => entry.id === 'thread-protocol')!
  const host = current.hosts.find((entry) => entry.id === 'host-local')!
  current.selectedThreadId = thread.id
  current.selectedProjectId = thread.projectId
  thread.executionGenerationId = 'candidate-generation-one'
  thread.workspaceId = 'candidate-workspace-one'
  thread.status = 'idle'
  host.connection = 'online'
  host.kind = 'local'
  host.connectionPath = 'Local socket'
  current.evidence = []
  current.operations = {
    submitCommands: false,
    crossHostHandoff: false,
    candidateEvaluationProbe: true,
  }
  current.runtime = {}
  current.composerReceipt = { state: 'idle', message: '' }
  const authority = {
    expectedHostId: host.id,
    threadId: thread.id,
    expectedExecutionGenerationId: thread.executionGenerationId,
  }
  let evaluations = structuredClone(initialEvaluations)
  let repeatEffectsWarningRequired = initialRepeatEffectsWarningRequired
  let snapshotSequence = 0
  const ready: CandidateEvaluationPreflight = {
    preflightVersion: 1,
    ...authority,
    observedAt: '2026-08-09T12:00:00.000Z',
    boundary: candidateEvaluationBoundary,
    status: 'ready',
    capability: 'prime_continuim_self_build_evaluation_v1',
    review: candidateEvaluationReview,
    executor: {
      kind: 'canonical_self_build',
      gateProcessContainment: 'windows_job',
      requiredNodeVersion: '24.14.0',
      requiredPnpmVersion: '11.9.0',
      verification: 'passive-structure-before-consent;canonical-toolchain-inside-evaluation',
      launcherSource: 'workspace-dependency-tree-candidate-controlled',
    },
  }
  const snapshot = (): CandidateEvaluationSnapshot => ({
    snapshotVersion: 1,
    ...authority,
    generatedAt: `2026-08-09T12:00:${String(snapshotSequence++).padStart(2, '0')}.000Z`,
    repeatEffectsWarningRequired,
    evaluations: structuredClone(evaluations),
  })
  api.loadWorkbench = vi.fn(async () => structuredClone(current))
  api.subscribe = vi.fn((listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  })
  api.candidateEvaluationPreflight = vi.fn(async () => structuredClone(ready))
  api.candidateEvaluationSnapshot = vi.fn(async () => snapshot())
  api.startCandidateEvaluation = vi.fn(async (input: CandidateEvaluationStartRequest) => {
    const running: CandidateEvaluationStatus = {
      statusVersion: 1,
      expectedHostId: input.expectedHostId,
      threadId: input.threadId,
      expectedExecutionGenerationId: input.expectedExecutionGenerationId,
      operationId: input.operationId,
      kind: input.kind,
      requestedAt: input.requestedAt,
      updatedAt: '2026-08-09T12:00:10.000Z',
      status: 'running',
      review: input.expectedReview,
      invocationStartedAt: '2026-08-09T12:00:10.000Z',
      boundary: candidateEvaluationBoundary,
    }
    evaluations = [running]
    return structuredClone(running)
  })
  const publish = (next: WorkbenchSnapshot) => {
    current = structuredClone(next)
    listeners.forEach((listener) => listener(structuredClone(current)))
  }
  return {
    api,
    authority,
    ready,
    snapshot: () => structuredClone(current),
    publish,
    setEvaluations(next: CandidateEvaluationStatus[]) {
      evaluations = structuredClone(next)
    },
    setRepeatEffectsWarningRequired(next: boolean) {
      repeatEffectsWarningRequired = next
    },
  }
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
    snapshot.agents = []
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

function createContinuityApi(options: {
  taskState: WorkbenchSnapshot['threads'][number]['status']
  connection?: WorkbenchSnapshot['hosts'][number]['connection']
  residency?: NonNullable<WorkbenchSnapshot['runtime']['session']>['residency']
}) {
  const api = createIdleResidentApi()
  const loadWorkbench = api.loadWorkbench.bind(api)
  api.loadWorkbench = async () => {
    const snapshot = await loadWorkbench()
    const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
    const host = snapshot.hosts.find((candidate) => candidate.id === thread?.hostId)
    if (!thread || !host || !snapshot.runtime.session) throw new Error('Expected the continuity fixture')
    thread.status = options.taskState
    host.name = 'Resident workstation'
    host.connection = options.connection ?? 'online'
    const residency = options.residency ?? 'resident'
    snapshot.runtime.session = {
      ...snapshot.runtime.session,
      residency,
      appVersion: '0.7.1',
      activeSessionId: residency === 'resident' ? 'active-continuity-one' : undefined,
      sessionId: residency === 'resident' ? 'session-continuity-one' : undefined,
      isStreaming: options.taskState === 'running',
      activeToolNames: [],
    }
    snapshot.agents = []
    snapshot.operations.startResidentTurn = options.taskState === 'idle' && host.connection === 'online'
    snapshot.operations.stopResidentTurn = options.taskState === 'running' && host.connection === 'online'
    return snapshot
  }
  return api
}

function createModelSelectionHarness(options: { runtimeOAuth?: boolean } = {}) {
  const api = asNativeFixture(createPreviewRendererApi())
  const loadRuntimeModelCatalog = api.loadRuntimeModelCatalog.bind(api)
  const listeners = new Set<(next: WorkbenchSnapshot) => void>()
  let current = structuredClone(previewSnapshot)
  const selectedThread = current.threads.find((thread) => thread.id === 'thread-seamless')
  const selectedHost = current.hosts.find((host) => host.id === selectedThread?.hostId)
  if (!selectedThread || !selectedHost || !current.runtime.session) throw new Error('Expected the resident model-selection fixture')
  selectedThread.status = 'idle'
  selectedThread.executionGenerationId = 'generation-model-selection-one'
  selectedThread.workspaceId = 'workspace-model-selection-one'
  selectedHost.connection = 'online'
  if (options.runtimeOAuth) {
    selectedHost.kind = 'local'
    selectedHost.connectionPath = 'Local socket'
  }
  current.runtime.session = {
    ...current.runtime.session,
    model: 'openai-codex/gpt-5.6-sol',
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    queuedActionCount: 0,
  }
  current.runtime.queue = { pendingCount: 0, paused: false }
  current.operations = {
    ...current.operations,
    submitCommands: true,
    startResidentTurn: true,
    stopResidentTurn: false,
    modelCatalog: true,
    selectResidentModel: true,
    ...(options.runtimeOAuth ? { runtimeOAuth: true } : {}),
  }
  current.composerReceipt = { state: 'idle', message: 'Ready for a new prompt' }
  api.loadWorkbench = vi.fn(async () => structuredClone(current))
  api.subscribe = vi.fn((listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  })
  api.loadRuntimeModelCatalog = vi.fn(async (hostId) => {
    const catalog = await loadRuntimeModelCatalog(hostId)
    if (!options.runtimeOAuth) return catalog
    const nextCatalog = structuredClone(catalog)
    const provider = nextCatalog.providers.find((candidate) => candidate.providerId === 'openai-codex')
    if (provider) {
      provider.configured = false
      provider.authSource = 'none'
      provider.availableModelCount = 0
    }
    nextCatalog.models.forEach((model) => {
      if (model.providerId !== 'openai-codex') return
      model.available = false
      model.usingOAuth = false
    })
    return nextCatalog
  })
  api.selectResidentModel = vi.fn(async () => ({
    state: 'completed' as const,
    projected: true,
    message: 'Prime Agent selected and verified this model.',
  }))

  const publish = (mutate: (snapshot: WorkbenchSnapshot) => void) => {
    const next = structuredClone(current)
    mutate(next)
    current = next
    listeners.forEach((listener) => listener(structuredClone(current)))
  }

  return {
    api,
    publish,
    publishCurrentModel(model: string) {
      publish((snapshot) => {
        if (!snapshot.runtime.session) throw new Error('Expected the resident model-selection session')
        snapshot.runtime.session.model = model
      })
    },
  }
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
    kind: 'provision',
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

function createRegisteredWorkspaceHarness(options: {
  provisionEnabled?: boolean
  endEnabled?: boolean
  activationRequired?: boolean
  connection?: 'online' | 'reconnecting'
  connectionPath?: 'SSH' | 'Relay'
  residentActive?: boolean
} = {}) {
  const api = asNativeFixture(createPreviewRendererApi())
  let snapshot = structuredClone(previewSnapshot)
  const thread = snapshot.threads.find((candidate) => candidate.id === 'thread-seamless')!
  const host = snapshot.hosts.find((candidate) => candidate.id === 'host-devbox')!
  thread.status = 'idle'
  thread.workspaceId = 'workspace-prime-ssh'
  thread.executionGenerationId = 'generation-prime-ssh'
  host.connection = options.connection ?? 'online'
  host.connectionPath = options.connectionPath ?? 'SSH'
  host.activationRequired = options.activationRequired
  snapshot.selectedThreadId = thread.id
  snapshot.selectedProjectId = thread.projectId
  snapshot.runtime.session = {
    ...snapshot.runtime.session!,
    residency: options.residentActive ? 'resident' : 'client_owned',
    ...(options.residentActive
      ? {
          activeSessionId: 'active-prime-ssh',
          sessionId: 'session-prime-ssh',
        }
      : {
          activeSessionId: undefined,
          sessionId: undefined,
        }),
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    queuedActionCount: 0,
  }
  snapshot.runtime.queue = { pendingCount: 0, paused: false }
  snapshot.residentLifecycleOperations = []
  snapshot.operations = {
    ...snapshot.operations,
    submitCommands: true,
    startResidentTurn: true,
    stopResidentTurn: false,
    provisionResident: options.provisionEnabled === false ? undefined : true,
    endResident: options.endEnabled === false ? undefined : true,
  }
  snapshot.composerReceipt = { state: 'idle', message: 'Ready for a new prompt' }
  const listeners = new Set<(next: WorkbenchSnapshot) => void>()
  api.loadWorkbench = vi.fn(async () => snapshot)
  api.subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  let residentSelectionSequence = 0
  api.selectResidentWorkspace = vi.fn(async (input) => {
    if (input?.kind !== 'registered_workspace') throw new Error('Expected one saved-workspace reference')
    residentSelectionSequence += 1
    return {
      selectionToken: residentSelectionSequence === 1 ? 'registered-selection-one' : `registered-selection-${residentSelectionSequence}`,
      operationId: 'registered-operation-one',
      expectedHostId: 'host-devbox',
      suggestedName: 'Prime Continuim',
      expiresAt: '2099-08-05T20:05:00.000Z',
      ...input,
    }
  })
  api.provisionResident = vi.fn(async () => ({
    version: 1 as const,
    kind: 'provision' as const,
    operationId: 'registered-operation-one',
    phase: 'prepared' as const,
    expectedHostId: 'host-devbox',
    projectId: thread.projectId,
    workspaceId: thread.workspaceId!,
    threadId: 'registered-new-thread',
    executionGenerationId: 'registered-new-generation',
    preparedAt: '2026-08-05T20:00:00.000Z',
    updatedAt: '2026-08-05T20:00:01.000Z',
  }))
  api.prepareResidentEnd = vi.fn(async (input) => ({
    confirmationToken: 'registered-end-confirmation-one',
    operationId: 'registered-end-operation-one',
    expectedHostId: input.expectedHostId,
    threadId: input.threadId,
    executionGenerationId: input.executionGenerationId,
    expiresAt: '2099-08-05T20:05:00.000Z',
  }))
  api.endResident = vi.fn(async () => ({
    version: 1 as const,
    kind: 'end' as const,
    operationId: 'registered-end-operation-one',
    phase: 'ending' as const,
    expectedHostId: 'host-devbox',
    projectId: thread.projectId,
    workspaceId: thread.workspaceId!,
    threadId: thread.remoteId ?? thread.id,
    executionGenerationId: thread.executionGenerationId!,
    preparedAt: '2026-08-05T20:00:00.000Z',
    updatedAt: '2026-08-05T20:00:01.000Z',
  }))
  api.residentLifecycleStatus = vi.fn(async () => null)
  return {
    api: api as RendererApi,
    getSnapshot: () => snapshot,
    publish(next: WorkbenchSnapshot) {
      snapshot = next
      listeners.forEach((listener) => listener(next))
    },
  }
}

function registeredSiblingProvisionOperation(
  phase: 'prepared' | 'committed' | 'none' = 'committed',
  state: ResidentLifecycleOperationSummary['state'] = phase === 'committed' ? 'terminal' : 'submitted',
): ResidentLifecycleOperationSummary {
  return {
    kind: 'provision',
    provisionMode: 'registered_workspace',
    operationId: 'registered-sibling-operation',
    expectedHostId: 'host-devbox',
    projectId: 'project-prime',
    workspaceId: 'workspace-prime-ssh',
    referenceThreadId: 'thread-seamless',
    referenceExecutionGenerationId: 'generation-prime-ssh',
    threadId: 'registered-sibling-thread',
    executionGenerationId: 'registered-sibling-generation',
    projectDisplayName: 'Prime Continuim',
    threadTitle: 'Sibling resident',
    createdAt: '2026-08-05T20:00:00.000Z',
    updatedAt: '2026-08-05T20:00:02.000Z',
    state,
    ...(phase === 'none'
      ? {}
      : {
          lastStatus: {
            version: 1,
            kind: 'provision',
            operationId: 'registered-sibling-operation',
            phase,
            expectedHostId: 'host-devbox',
            projectId: 'project-prime',
            workspaceId: 'workspace-prime-ssh',
            threadId: 'registered-sibling-thread',
            executionGenerationId: 'registered-sibling-generation',
            preparedAt: '2026-08-05T20:00:00.000Z',
            updatedAt: '2026-08-05T20:00:02.000Z',
            ...(phase === 'committed' ? { terminalAt: '2026-08-05T20:00:02.000Z' } : {}),
          },
        }),
  }
}

function registeredWorkspaceEndOperation(
  phase: 'ending' | 'completed',
  target: 'selected' | 'sibling' = 'sibling',
): ResidentLifecycleOperationSummary {
  const threadId = target === 'selected' ? 'thread-seamless' : 'registered-sibling-thread'
  const executionGenerationId = target === 'selected'
    ? 'generation-prime-ssh'
    : 'registered-sibling-generation'
  return {
    kind: 'end',
    operationId: target === 'selected' ? 'registered-end-operation-one' : 'registered-sibling-end-operation',
    expectedHostId: 'host-devbox',
    projectId: 'project-prime',
    workspaceId: 'workspace-prime-ssh',
    threadId,
    executionGenerationId,
    sourceCursor: {
      threadId,
      executionGenerationId,
      generation: 'registered-end-daemon-generation',
      sequence: 7,
    },
    createdAt: '2026-08-05T20:00:03.000Z',
    updatedAt: '2026-08-05T20:00:04.000Z',
    state: phase === 'completed' ? 'terminal' : 'submitted',
    lastStatus: {
      version: 1,
      kind: 'end',
      operationId: target === 'selected' ? 'registered-end-operation-one' : 'registered-sibling-end-operation',
      phase,
      expectedHostId: 'host-devbox',
      projectId: 'project-prime',
      workspaceId: 'workspace-prime-ssh',
      threadId,
      executionGenerationId,
      preparedAt: '2026-08-05T20:00:03.000Z',
      updatedAt: '2026-08-05T20:00:04.000Z',
      ...(phase === 'completed' ? { terminalAt: '2026-08-05T20:00:04.000Z' } : {}),
    },
  }
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
    hosts: previewSnapshot.hosts
      .filter((host) => host.kind === 'local')
      .map((host) => ({ ...host, connection: 'online' as const, activationRequired: false })),
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
  api.preselectResidentWorkspace = vi.fn(async () => ({
    preselectionToken: 'preselection-local-one',
    suggestedName: 'Prime workspace',
    expiresAt: '2099-08-07T12:05:00.000Z',
  }))
  api.completeResidentWorkspacePreselection = vi.fn(async () => ({
    kind: 'local_path' as const,
    selectionToken: 'selection-local-one',
    operationId: 'resident-local-one',
    expectedHostId: 'host-local',
    suggestedName: 'Prime workspace',
    expiresAt: '2099-08-07T12:05:00.000Z',
  }))
  api.cancelResidentWorkspacePreselection = vi.fn(async () => undefined)
  api.provisionResident = vi.fn(async () => {
    throw new Error('The local setup harness must not provision before explicit confirmation.')
  })
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

function residentEndStatus(
  phase: 'ending' | 'kill_dispatching' | 'kill_acknowledged' | 'completed' = 'ending',
) {
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
      endResident: true,
    }
    snapshot.composerReceipt = operation
      ? operation.lastStatus?.phase === 'quarantined'
        ? { state: 'uncertain', operation: 'end', message: 'End outcome unknown · this resident session stays locked for inspection' }
        : {
            state: 'sent',
            operation: 'end',
            retryable: operation.lastStatus?.phase === 'ending' ? true : undefined,
            message: operation.lastStatus?.phase === 'ending'
              ? 'Ready to finish · Prime Agent has not received an End request'
              : 'Finishing session · checking for completion',
          }
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
  window.localStorage.removeItem('prime.renderer.workbench-layout.v1')
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_024 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 })
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined })
  Reflect.deleteProperty(window, 'prime')
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
    const liveSession = screen.getByRole('region', { name: 'Live agent session' })
    expect(within(liveSession).getByText('GPT-5.6 Sol')).toBeVisible()
    expect(within(liveSession).getByText('2 active')).toBeVisible()
    expect(within(liveSession).getByText('Browser ready', { selector: 'dd' })).toBeVisible()

    const composer = screen.getByRole('textbox', { name: 'Task brief' })
    await waitFor(() => expect(composer).toHaveFocus())
    await user.type(composer, 'Build the HUD from this resident thread')
    await user.click(screen.getByRole('button', { name: 'Delegate task' }))
    expect(harness.api.sendComposer).toHaveBeenCalledWith({
      threadId: harness.target.threadId,
      text: 'Build the HUD from this resident thread',
    })

    await user.click(screen.getByRole('button', { name: 'Collapse to desktop buddy' }))
    const buddy = await screen.findByRole('button', { name: /Starting: Seamless remote experience\..*Open session HUD/ })
    await waitFor(() => expect(buddy).toHaveFocus())
    expect(screen.queryByRole('textbox', { name: 'Task brief' })).not.toBeInTheDocument()
    await user.click(buddy)
    expect(await screen.findByRole('heading', { name: 'Seamless remote experience' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(await screen.findByRole('button', { name: /Open session HUD/ })).toBeVisible()
  })

  it('never falls back to another thread when the HUD generation fence does not match', async () => {
    const user = userEvent.setup()
    const harness = createHudHarness({ targetGenerationId: 'generation-that-is-not-current' })
    render(<App api={harness.api} surface="hud" />)

    expect(await screen.findByRole('heading', { name: 'Desktop HUD unavailable' })).toBeVisible()
    expect(screen.getByText(/host, thread, and execution generation are not present/i)).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Task brief' })).not.toBeInTheDocument()
    expect(harness.api.selectThread).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Return to workbench' }))
    expect(harness.api.hudReturnToWorkbench).toHaveBeenCalledOnce()
    expect(harness.api.retryLocalSetup).not.toHaveBeenCalled()
    expect(harness.api.repairLocalRuntime).not.toHaveBeenCalled()
  })

  it('isolates and restores drafts by exact HUD authority and clears only the submitted authority', async () => {
    const user = userEvent.setup()
    const harness = createHudHarness()
    render(<App api={harness.api} surface="hud" />)

    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const firstComposer = screen.getByRole('textbox', { name: 'Task brief' })
    await user.type(firstComposer, 'This draft belongs only to the first thread')

    const nextSnapshot = structuredClone(harness.snapshot)
    const sourceThread = nextSnapshot.threads.find((thread) => thread.id === harness.target.threadId)!
    const sourceHost = nextSnapshot.hosts.find((host) => host.id === sourceThread.hostId)!
    const nextHost = {
      ...sourceHost,
      id: 'host-hud-two',
      name: 'Second resident workstation',
    }
    const nextThread = {
      ...structuredClone(sourceThread),
      id: 'thread-hud-two',
      remoteId: 'thread-hud-two',
      hostId: nextHost.id,
      title: 'Second HUD resident thread',
      executionGenerationId: 'generation-hud-two',
      transcript: [],
    }
    nextSnapshot.hosts.push(nextHost)
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
    const secondComposer = screen.getByRole('textbox', { name: 'Task brief' })
    await waitFor(() => expect(secondComposer).toHaveValue(''))
    expect(secondComposer).not.toHaveValue('This draft belongs only to the first thread')

    await user.type(secondComposer, 'Keep this draft while changing HUD modes')

    act(() => {
      harness.publishHudState({ state: 'expanded', target: harness.target, ignoresMouseEvents: false })
      harness.publishSnapshot(structuredClone(harness.snapshot))
    })
    expect(await screen.findByRole('heading', { name: 'Seamless remote experience' })).toBeVisible()
    expect(await screen.findByRole('textbox', { name: 'Task brief' })).toHaveValue('This draft belongs only to the first thread')

    act(() => {
      harness.publishHudState({ state: 'expanded', target: nextTarget, ignoresMouseEvents: false })
      harness.publishSnapshot(nextSnapshot)
    })
    expect(await screen.findByRole('heading', { name: 'Second HUD resident thread' })).toBeVisible()
    expect(await screen.findByRole('textbox', { name: 'Task brief' })).toHaveValue('Keep this draft while changing HUD modes')

    await user.click(screen.getByRole('button', { name: 'Collapse to desktop buddy' }))
    await user.click(await screen.findByRole('button', { name: /Open session HUD/ }))
    expect(await screen.findByRole('textbox', { name: 'Task brief' })).toHaveValue('Keep this draft while changing HUD modes')

    await user.click(screen.getByRole('button', { name: 'Delegate task' }))
    expect(harness.api.sendComposer).toHaveBeenLastCalledWith({
      threadId: nextThread.id,
      text: 'Keep this draft while changing HUD modes',
    })
    act(() => harness.publishSnapshot(nextSnapshot))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Task brief' })).toHaveValue(''))

    act(() => {
      harness.publishHudState({ state: 'expanded', target: harness.target, ignoresMouseEvents: false })
      harness.publishSnapshot(structuredClone(harness.snapshot))
    })
    expect(await screen.findByRole('textbox', { name: 'Task brief' })).toHaveValue('This draft belongs only to the first thread')

    act(() => {
      harness.publishHudState({ state: 'expanded', target: nextTarget, ignoresMouseEvents: false })
      harness.publishSnapshot(nextSnapshot)
    })
    expect(await screen.findByRole('textbox', { name: 'Task brief' })).toHaveValue('')
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

  it('isolates and restores drafts when the same HUD thread changes execution generation', async () => {
    const user = userEvent.setup()
    const harness = createHudHarness()
    render(<App api={harness.api} surface="hud" />)

    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.type(screen.getByRole('textbox', { name: 'Task brief' }), 'Draft from the first execution')

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

    const composer = await screen.findByRole('textbox', { name: 'Task brief' })
    expect(composer).toHaveValue('')
    expect(composer).not.toHaveValue('Draft from the first execution')
    await user.type(composer, 'Draft from the second execution')

    act(() => {
      harness.publishHudState({ state: 'expanded', target: harness.target, ignoresMouseEvents: false })
      harness.publishSnapshot(structuredClone(harness.snapshot))
    })
    expect(await screen.findByRole('textbox', { name: 'Task brief' })).toHaveValue('Draft from the first execution')

    act(() => {
      harness.publishHudState({ state: 'expanded', target: nextTarget, ignoresMouseEvents: false })
      harness.publishSnapshot(nextSnapshot)
    })
    expect(await screen.findByRole('textbox', { name: 'Task brief' })).toHaveValue('Draft from the second execution')
  })

  it('keeps passive HUD and transcript updates from stealing focus', async () => {
    const user = userEvent.setup()
    const harness = createHudHarness({ taskState: 'running' })
    render(<App api={harness.api} surface="hud" />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const returnButton = screen.getByRole('button', { name: 'Open Seamless remote experience in the workbench' })
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
      next.runtime.session!.activeToolNames = ['playwright-cli']
      next.agents = [{
        id: 'hud-browser-auditor',
        name: 'Browser auditor',
        role: 'Retained subagent',
        status: 'running',
        hostName: 'Resident workstation',
        activity: 'Executing browser snapshot',
      }]
      harness.publishSnapshot(next)
    })

    await screen.findByText('Passive HUD update.')
    expect(within(screen.getByRole('region', { name: 'Live agent session' })).getByText('Using playwright-cli')).toBeVisible()
    expect(screen.getByText('1 active')).toBeVisible()
    expect(returnButton).toHaveFocus()
  })

  it('opens the HUD from the workbench only with an exact materialized resident target', async () => {
    const user = userEvent.setup()
    const harness = createHudHarness()
    render(<App api={harness.api} />)

    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: 'Open floating session HUD' }))
    expect(harness.api.hudOpen).toHaveBeenCalledWith(harness.target)

    cleanup()
    render(<App api={asNativeFixture(createPreviewRendererApi())} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    expect(screen.queryByRole('button', { name: 'Open floating session HUD' })).not.toBeInTheDocument()
  })

  it('shows an upstream input request as Reply needed and routes Reply to the workbench without a fake approval control', async () => {
    const user = userEvent.setup()
    const harness = createHudHarness({ taskState: 'needs_approval' })
    render(<App api={harness.api} surface="hud" />)

    expect(await screen.findByText('Reply needed', { selector: '.hud-status strong' })).toBeVisible()
    const review = screen.getByRole('button', { name: 'Reply in workbench' })
    expect(review.closest('.hud-notice')).toHaveTextContent(/waiting for more context/i)
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()
    await user.click(review)
    expect(harness.api.hudReturnToWorkbench).toHaveBeenCalledOnce()
  })

  it('ends a live resident session with one explicit action', async () => {
    const user = userEvent.setup()
    const api = createResidentEndApi()
    const endResult = deferred<ReturnType<typeof residentEndStatus>>()
    api.endResident = vi.fn(() => endResult.promise)
    render(<App api={api} />)

    await user.click(await screen.findByRole('tab', { name: 'Session' }))
    const end = screen.getByRole('button', { name: 'End session' })
    await user.click(end)
    expect(api.prepareResidentEnd).toHaveBeenCalledTimes(1)
    expect(api.endResident).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: 'End agent session?' })).not.toBeInTheDocument()
    endResult.resolve(residentEndStatus('kill_dispatching'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Ending…' })).not.toBeInTheDocument())
    expect(api.residentLifecycleStatus).not.toHaveBeenCalled()
    expect(api.endResident).toHaveBeenCalledTimes(1)
  })

  it('carries one-click End through one safe pre-effect resume', async () => {
    const user = userEvent.setup()
    const api = createResidentEndApi()
    api.endResident = vi.fn()
      .mockResolvedValueOnce(residentEndStatus('ending'))
      .mockResolvedValueOnce(residentEndStatus('kill_dispatching'))
    render(<App api={api} />)

    await user.click(await screen.findByRole('tab', { name: 'Session' }))
    await user.click(screen.getByRole('button', { name: 'End session' }))

    await waitFor(() => expect(api.prepareResidentEnd).toHaveBeenCalledTimes(2))
    expect(api.prepareResidentEnd).toHaveBeenLastCalledWith(expect.objectContaining({
      resumeOperationId: 'resident-end-operation-one',
      expectedHostId: 'host-local',
      threadId: 'thread-protocol',
      executionGenerationId: 'generation-end-one',
    }))
    expect(api.endResident).toHaveBeenCalledTimes(2)
  })

  it('turns an unattached saved session into a clear, keyboard-reachable recovery path', async () => {
    const user = userEvent.setup()
    const api = createResidentEndApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.operations.submitCommands = false
      snapshot.operations.startResidentTurn = false
      snapshot.operations.stopResidentTurn = false
      snapshot.operations.endResident = true
      snapshot.runtime.residentControlReadiness = 'unavailable'
      if (snapshot.runtime.session) snapshot.runtime.session.activeToolNames = ['ipython']
      snapshot.composerReceipt = { state: 'waiting_for_connection', message: '' }
      const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
      if (!thread) throw new Error('Expected the selected resident thread')
      thread.title = 'Test Thread'
      thread.transcript = []
      return snapshot
    }

    render(<App api={api} />)

    const continuity = await screen.findByRole('region', { name: 'Session status' })
    expect(continuity.querySelector('.session-continuity__label')).toHaveTextContent('Restart session')
    expect(within(continuity).getByText(/could not attach this saved session/i)).toBeVisible()
    expect(within(continuity).getByText('Saved thread')).toBeVisible()
    expect(within(continuity).queryByText('Using ipython')).not.toBeInTheDocument()
    expect(within(continuity).queryByText('No active goal')).not.toBeInTheDocument()
    expect(await screen.findByText('Restart session', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.queryByText('Ready to delegate')).not.toBeInTheDocument()
    expect(await screen.findByTitle('Task state: Restart session')).toBeVisible()
    expect(screen.getByRole('button', { name: /Test Thread/i })).toHaveTextContent(/Restart session.*Test Thread/i)
    expect(screen.getByText('End this inactive session')).toBeVisible()
    expect(screen.getByText('Restart session', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Task brief' })).toBeDisabled()
    expect(screen.getByText(/saved thread stays in this project/i)).toBeVisible()
    expect(screen.queryByText('Ready to send')).not.toBeInTheDocument()

    const recover = screen.getByRole('button', { name: 'End session' })
    api.endResident = vi.fn(async () => residentEndStatus('kill_dispatching'))
    expect(recover).toBeEnabled()
    recover.focus()
    await user.keyboard('{Enter}')

    expect(api.prepareResidentEnd).toHaveBeenCalledOnce()
    expect(api.endResident).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: 'End agent session?' })).not.toBeInTheDocument()
  })

  it('dismisses an admitted End without inviting another kill', async () => {
    const user = userEvent.setup()
    const api = createResidentEndApi()
    api.endResident = vi.fn(async () => residentEndStatus('kill_dispatching'))
    render(<App api={api} />)

    await user.click(await screen.findByRole('tab', { name: 'Session' }))
    await user.click(screen.getByRole('button', { name: 'End session' }))

    await waitFor(() => expect(api.endResident).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Finish ending' })).not.toBeInTheDocument()
    expect(api.endResident).toHaveBeenCalledTimes(1)
    expect(api.residentLifecycleStatus).not.toHaveBeenCalled()
  })

  it('surfaces an exact stale-cursor rejection without opening a second confirmation', async () => {
    const user = userEvent.setup()
    const api = createResidentEndApi()
    const staleConsent = Object.assign(
      new Error('Resident state changed after end consent was reviewed; refresh the thread and confirm again'),
      { code: 'host.resident_end_source_cursor_changed' },
    )
    api.endResident = vi.fn(async () => { throw staleConsent })
    render(<App api={api} />)

    await user.click(await screen.findByRole('tab', { name: 'Session' }))
    await user.click(screen.getByRole('button', { name: 'End session' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/Resident state changed after end consent was reviewed/i)
    expect(screen.queryByRole('dialog', { name: 'End agent session?' })).not.toBeInTheDocument()
    expect(api.endResident).toHaveBeenCalledTimes(1)
    expect(api.residentLifecycleStatus).not.toHaveBeenCalled()
  })

  it('finishes an admitted pre-effect End with one explicit action', async () => {
    const user = userEvent.setup()
    const operation = residentEndOperation('submitted')
    const api = createResidentEndApi(operation)
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
      if (!thread) throw new Error('Expected the selected resident end fixture')
      thread.transcript = []
      return snapshot
    }
    const endResult = deferred<ReturnType<typeof residentEndStatus>>()
    api.endResident = vi.fn(async () => endResult.promise)
    render(<App api={api} />)

    expect(await screen.findByText('End saved', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.getByRole('form', { name: 'Resident session ending' })).toBeVisible()
    expect(screen.getByRole('main')).not.toHaveClass('thread-view--launchpad')
    expect(screen.queryByRole('region', { name: 'Session status' })).not.toBeInTheDocument()
    expect(screen.getByTitle('Task state: End saved')).toBeVisible()
    expect(screen.getByRole('button', { name: /End saved.*Frame protocol boundaries/i })).toBeVisible()
    expect(document.querySelector('.agent-launchpad')).not.toBeInTheDocument()
    expect(screen.queryByText('Ready to delegate')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delegate a task.*Coordinate bounded RLM workers/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Task brief' })).not.toBeInTheDocument()
    const finish = screen.getByRole('button', { name: 'Finish ending this resident session' })
    expect(screen.getAllByRole('button', { name: 'Finish ending this resident session' })).toHaveLength(1)
    expect(finish).toBeEnabled()
    expect(finish).toHaveTextContent('Finish ending')
    expect(api.endResident).not.toHaveBeenCalled()

    const sidebar = screen.getByLabelText('Projects and threads')
    expect(within(sidebar).queryByRole('button', { name: 'New agent' })).not.toBeInTheDocument()
    expect(within(sidebar).queryByRole('button', { name: 'Finish ending' })).not.toBeInTheDocument()
    await user.click(finish)
    expect(api.prepareResidentEnd).toHaveBeenCalledWith(expect.objectContaining({
      resumeOperationId: operation.operationId,
      expectedHostId: operation.expectedHostId,
      threadId: operation.threadId,
      executionGenerationId: operation.executionGenerationId,
    }))
    await waitFor(() => expect(api.endResident).toHaveBeenCalledWith({
      confirmationToken: 'resident-end-confirmation-one',
      consent: true,
    }))
    const finishing = screen.getByRole('button', { name: 'Finishing this resident session' })
    expect(finishing).toBeDisabled()
    expect(finishing).toHaveAttribute('aria-busy', 'true')
    expect(finishing).toHaveTextContent('Finishing…')
    await user.click(finishing)
    expect(api.endResident).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => {
      endResult.resolve(residentEndStatus('completed'))
      await endResult.promise
    })
    await waitFor(() => expect(finishing).not.toHaveAttribute('aria-busy'))
  })

  it('keeps a one-click End failure visible with the Session panel closed', async () => {
    const user = userEvent.setup()
    const operation = residentEndOperation('submitted')
    const api = createResidentEndApi(operation)
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
      if (thread) thread.transcript = []
      return snapshot
    }
    api.prepareResidentEnd = vi.fn(async () => {
      throw new Error('The saved End authorization is temporarily unavailable.')
    })
    render(<App api={api} />)

    await user.click(await screen.findByRole('button', { name: 'Finish ending this resident session' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Unable to end session')
    expect(alert).toHaveTextContent('The saved End authorization is temporarily unavailable.')
    expect(screen.queryByRole('tab', { name: 'Session', selected: true })).not.toBeInTheDocument()
    expect(api.endResident).not.toHaveBeenCalled()
    expect(screen.getByTitle('Task state: End saved')).toBeVisible()
    expect(screen.getByText('End saved', { selector: '.composer__intent' })).toBeVisible()
    expect(document.querySelector('.agent-launchpad')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'End saved; waiting for resident controls' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Finish ending this resident session' })).not.toBeInTheDocument()
  })

  it('keeps a saved End passive while resident lifecycle control is unavailable', async () => {
    const user = userEvent.setup()
    const operation = residentEndOperation('submitted')
    const api = createResidentEndApi(operation)
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.operations.endResident = false
      snapshot.runtime.residentControlReadiness = 'unavailable'
      const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
      if (thread) thread.transcript = []
      return snapshot
    }
    render(<App api={api} />)

    expect(await screen.findByTitle('Task state: End saved')).toBeVisible()
    expect(screen.getByText('End saved', { selector: '.composer__intent' })).toBeVisible()
    expect(document.querySelector('.agent-launchpad')).not.toBeInTheDocument()
    expect(screen.getByText('Waiting for resident controls', { selector: '.composer__connection span' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'End saved; waiting for resident controls' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Prime Agent received the End request/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/checked automatically|checking for completion automatically/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Finish ending/i })).not.toBeInTheDocument()
    expect(api.prepareResidentEnd).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Review status' }))
    const inspector = screen.getByLabelText('Thread inspector')
    expect(within(inspector).getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
    const card = await within(inspector).findByRole('region', { name: 'End saved' })
    expect(within(card).getByRole('button', { name: 'Check status' })).toBeEnabled()
    expect(within(card).queryByRole('button', { name: 'Finish ending' })).not.toBeInTheDocument()
  })

  it('lets the user retry the same End once when the host has no durable result', async () => {
    const user = userEvent.setup()
    const operation = {
      ...residentEndOperation('outcome_unknown'),
      lastStatus: undefined,
    }
    const api = createResidentEndApi(operation)
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.composerReceipt = {
        state: 'uncertain',
        operation: 'end',
        retryable: false,
        message: 'The host has no saved End result.',
      }
      return snapshot
    }
    render(<App api={api} />)

    await user.click(await screen.findByRole('button', { name: 'Try ending this resident session again' }))

    expect(api.prepareResidentEnd).toHaveBeenCalledWith({
      expectedHostId: 'host-local',
      projectId: 'project-prime',
      workspaceId: 'workspace-end-one',
      threadId: 'thread-protocol',
      executionGenerationId: 'generation-end-one',
      resumeOperationId: operation.operationId,
    })
    expect(api.endResident).toHaveBeenCalledWith({
      confirmationToken: 'resident-end-confirmation-one',
      consent: true,
    })
  })

  it('does not confuse detached prompt controls with an available saved End action', async () => {
    const operation = residentEndOperation('submitted')
    const api = createResidentEndApi(operation)
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.runtime.residentControlReadiness = 'unavailable'
      const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
      if (thread) thread.transcript = []
      return snapshot
    }
    render(<App api={api} />)

    expect(await screen.findByTitle('Task state: End saved')).toBeVisible()
    expect(await screen.findByText('End saved', { selector: '.composer__intent' })).toBeVisible()
    expect(document.querySelector('.agent-launchpad')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Frame protocol boundaries/i })).toHaveTextContent(/End saved/i)
    expect(screen.getByRole('button', { name: 'Finish ending this resident session' })).toBeEnabled()
    expect(screen.getAllByRole('button', { name: 'Finish ending this resident session' })).toHaveLength(1)
    expect(screen.queryByText(/Waiting for resident controls/i)).not.toBeInTheDocument()
  })

  it('offers a new agent after the selected resident End is complete', async () => {
    const user = userEvent.setup()
    const completed = {
      ...residentEndOperation('terminal'),
      lastStatus: residentEndStatus('completed'),
    }
    const api = createResidentEndApi(completed)
    api.selectResidentWorkspace = vi.fn(async () => ({
      kind: 'registered_workspace' as const,
      selectionToken: 'saved-local-selection',
      operationId: 'saved-local-operation',
      expectedHostId: 'host-local',
      suggestedName: 'Prime Continuim',
      expiresAt: '2099-08-05T20:05:00.000Z',
      projectId: 'project-prime',
      workspaceId: 'workspace-end-one',
      referenceThreadId: 'thread-protocol',
      referenceExecutionGenerationId: 'generation-end-one',
    }))
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
      if (!thread) throw new Error('Expected the selected resident end fixture')
      thread.residentLifecycle = {
        version: 1,
        state: 'ended',
        reason: 'user_end',
        operationId: completed.operationId,
        bindingFingerprint: 'a'.repeat(64),
        sourceCursor: completed.sourceCursor,
        endedAt: completed.lastStatus!.terminalAt!,
      }
      snapshot.operations.provisionResident = true
      return snapshot
    }
    render(<App api={api} />)

    await waitFor(() => {
      const terminalStatus = screen.getByRole('region', { name: 'Session status' })
      expect(terminalStatus.querySelector('.session-continuity__label')).toHaveTextContent('Session ended')
      expect(within(terminalStatus).getByText(/task, transcript, and workspace files remain available/i)).toBeVisible()
    })
    expect(screen.queryByRole('form', { name: 'Resident session ending' })).not.toBeInTheDocument()
    expect(document.querySelector('.agent-launchpad')).not.toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: 'New agent' }))
    expect(api.selectResidentWorkspace).toHaveBeenCalledWith({
      kind: 'registered_workspace',
      projectId: 'project-prime',
      workspaceId: 'workspace-end-one',
      referenceThreadId: 'thread-protocol',
      referenceExecutionGenerationId: 'generation-end-one',
    })
    expect(await screen.findByRole('dialog', { name: 'Start another task' })).toBeVisible()
  })

  it('hides a stale End recovery notice after the exact thread is authoritatively ended', async () => {
    const staleOperation = {
      ...residentEndOperation('outcome_unknown'),
      operationId: 'resident-end-operation-stale',
      lastStatus: undefined,
    }
    const api = createResidentEndApi(staleOperation)
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
      if (!thread) throw new Error('Expected the selected resident end fixture')
      thread.residentLifecycle = {
        version: 1,
        state: 'ended',
        reason: 'user_end',
        operationId: 'resident-end-operation-completed',
        bindingFingerprint: 'b'.repeat(64),
        sourceCursor: staleOperation.sourceCursor,
        endedAt: '2026-08-05T20:00:03.000Z',
      }
      return snapshot
    }
    render(<App api={api} />)

    expect(await screen.findByTitle('Task state: Session ended')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Check end status' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check status' })).not.toBeInTheDocument()
  })

  it('checks a dispatched resident End automatically without replaying it', async () => {
    const operation = {
      ...residentEndOperation('submitted'),
      updatedAt: '2026-08-05T20:00:02.000Z',
      lastStatus: residentEndStatus('kill_acknowledged'),
    }
    const api = createResidentEndApi(operation)
    Object.defineProperty(api, 'environment', { configurable: true, value: 'native' })
    render(<App api={api} />)

    expect(await screen.findByText('Ending session', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Resident session is finishing' })).not.toBeInTheDocument()
    expect(screen.getByText('Prime Continuim is checking for completion automatically')).toBeVisible()
    await waitFor(() => expect(api.residentLifecycleStatus).toHaveBeenCalledWith({
      expectedHostId: operation.expectedHostId,
      operationId: operation.operationId,
    }), { timeout: 2_000 })
    expect(api.prepareResidentEnd).not.toHaveBeenCalled()
    expect(api.endResident).not.toHaveBeenCalled()
  })

  it('keeps a quarantined resident end check-only and exposes a keyboard-copy fallback when clipboard access fails', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {
      throw new Error('Clipboard denied')
    })
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
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
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
      if (!thread) throw new Error('Expected the selected quarantined end fixture')
      thread.transcript = []
      return snapshot
    }
    render(<App api={api} />)

    expect(await screen.findByTitle('Task state: End needs review')).toBeVisible()
    expect(screen.getByRole('button', { name: /End needs review.*Frame protocol boundaries/i })).toBeVisible()
    expect(screen.getByText('End needs review', { selector: '.composer__intent' })).toBeVisible()
    expect(document.querySelector('.agent-launchpad')).not.toBeInTheDocument()
    expect(screen.queryByText('Ready to delegate')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /outcome unknown/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Review status' }))
    const card = await screen.findByRole('region', { name: 'End outcome needs inspection' })
    expect(within(card).getByText(/will not send another kill/i)).toBeVisible()
    expect(within(card).queryByRole('button', { name: /review end/i })).not.toBeInTheDocument()
    const copy = within(card).getByRole('button', { name: 'Copy diagnostic' })
    copy.focus()
    await user.keyboard('{Enter}')
    expect(await within(card).findByRole('alert')).toHaveTextContent(/Unable to copy the diagnostic.*copy it manually.*Prime Continuim support/i)
    const diagnostic = within(card).getByRole('textbox', { name: 'Resident end diagnostic' })
    await waitFor(() => expect(diagnostic).toHaveFocus())
    expect((diagnostic as HTMLTextAreaElement).value).toContain('Quarantined from: kill_dispatching')
    expect((diagnostic as HTMLTextAreaElement).selectionStart).toBe(0)
    expect((diagnostic as HTMLTextAreaElement).selectionEnd).toBe((diagnostic as HTMLTextAreaElement).value.length)
    expect(writeText).toHaveBeenCalledOnce()
    expect(api.prepareResidentEnd).not.toHaveBeenCalled()
    expect(api.endResident).not.toHaveBeenCalled()
  })

  it('creates a resident thread from the exact saved SSH workspace with one editable field at 320x256', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 256 })
    const user = userEvent.setup()
    const harness = createRegisteredWorkspaceHarness()
    render(<App api={harness.api} />)

    const create = await screen.findByRole('button', { name: 'New resident thread in this workspace' })
    expect(screen.getByText('Uses this saved workspace.')).toBeVisible()
    create.focus()
    await user.keyboard('{Enter}')
    expect(harness.api.selectResidentWorkspace).toHaveBeenCalledWith({
      kind: 'registered_workspace',
      projectId: 'project-prime',
      workspaceId: 'workspace-prime-ssh',
      referenceThreadId: 'thread-seamless',
      referenceExecutionGenerationId: 'generation-prime-ssh',
    })

    const dialog = await screen.findByRole('dialog', { name: 'Start another task' })
    await waitFor(() => expect(within(dialog).getByRole('textbox', { name: 'Task name' })).toHaveFocus())
    expect(within(dialog).getByRole('region', { name: 'Selected workspace' })).toHaveTextContent('Runs in')
    expect(within(dialog).getByText('Prime Continuim', { selector: '.resident-provision__workspace bdi' })).toBeVisible()
    expect(within(dialog).getByText('Access stays on the verified host')).toBeVisible()
    expect(within(dialog).queryByLabelText('Agent setup progress')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('textbox', { name: 'Project name' })).not.toBeInTheDocument()
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1)
    expect(dialog.textContent).not.toMatch(/folder picker|handoff|mobile/i)

    const title = within(dialog).getByRole('textbox', { name: 'Task name' })
    await user.clear(title)
    await user.type(title, 'Overnight verification')
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))
    expect(harness.api.provisionResident).toHaveBeenCalledWith({
      selectionToken: 'registered-selection-one',
      projectDisplayName: 'Prime Continuim',
      threadTitle: 'Overnight verification',
    })
    expect(within(dialog).getByRole('status')).toHaveTextContent(/durably recorded/i)
    expect(within(dialog).queryByRole('button', { name: /choose.*folder/i })).not.toBeInTheDocument()
  })

  it('shows End-first guidance instead of saved-workspace create while its exact resident authority is active', async () => {
    const user = userEvent.setup()
    const harness = createRegisteredWorkspaceHarness({ residentActive: true })
    render(<App api={harness.api} />)

    expect(await screen.findByText(/resident session already owns this workspace/i)).toBeVisible()
    expect(screen.getByText(/open or select that thread.*End session in Session/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'New resident thread in this workspace' })).not.toBeInTheDocument()
    expect(harness.api.selectResidentWorkspace).not.toHaveBeenCalled()

    await user.click(screen.getByRole('tab', { name: 'Session' }))
    expect(screen.getByRole('button', { name: 'End session' })).toBeEnabled()
  })

  it('keeps status available while a committed sibling resident suppresses create in the same saved workspace', async () => {
    const harness = createRegisteredWorkspaceHarness()
    const occupied = structuredClone(harness.getSnapshot())
    occupied.residentLifecycleOperations = [registeredSiblingProvisionOperation()]
    harness.publish(occupied)
    render(<App api={harness.api} />)

    expect(await screen.findByText(/resident session already owns this workspace/i)).toBeVisible()
    expect(screen.getByText(/open or select that thread.*End session in Session/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'New resident thread in this workspace' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh status' })).toBeEnabled()
    expect(harness.api.selectResidentWorkspace).not.toHaveBeenCalled()
  })

  it('keeps an unresolved no-status saved-workspace setup status-only and suppresses fresh create', async () => {
    const harness = createRegisteredWorkspaceHarness()
    const occupied = structuredClone(harness.getSnapshot())
    occupied.residentLifecycleOperations = [registeredSiblingProvisionOperation('none', 'outcome_unknown')]
    harness.publish(occupied)
    render(<App api={harness.api} />)

    expect(await screen.findByText(/earlier resident setup still holds this workspace/i)).toBeVisible()
    expect(screen.getByText(/continue or inspect that setup below/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'New resident thread in this workspace' })).not.toBeInTheDocument()
    const card = screen.getByRole('region', { name: 'Setup outcome needs inspection' })
    expect(within(card).getByRole('button', { name: 'Check status' })).toBeEnabled()
    expect(harness.api.selectResidentWorkspace).not.toHaveBeenCalled()
  })

  it.each(['prepared', 'quarantined'] as const)(
    'keeps a %s saved-workspace setup ahead of fresh create with setup-recovery copy',
    async (phase) => {
      const harness = createRegisteredWorkspaceHarness()
      const operation = registeredSiblingProvisionOperation('prepared', 'outcome_unknown')
      if (phase === 'quarantined') {
        operation.lastStatus = {
          ...operation.lastStatus!,
          phase,
          quarantinedFrom: 'promotion_dispatching',
          quarantineReason: 'external_outcome_unknown',
        }
      }
      const occupied = structuredClone(harness.getSnapshot())
      occupied.residentLifecycleOperations = [operation]
      harness.publish(occupied)
      render(<App api={harness.api} />)

      expect(await screen.findByText(/earlier resident setup still holds this workspace/i)).toBeVisible()
      expect(screen.getByText(/continue or inspect that setup below/i)).toBeVisible()
      expect(screen.queryByText(/resident session already owns this workspace/i)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'New resident thread in this workspace' })).not.toBeInTheDocument()
      expect(harness.api.selectResidentWorkspace).not.toHaveBeenCalled()
    },
  )

  it.each(['promoted_observed', 'projection_committed'] as const)(
    'uses active-resident guidance after a saved-workspace setup reaches %s',
    async (phase) => {
      const harness = createRegisteredWorkspaceHarness()
      const operation = registeredSiblingProvisionOperation('prepared', 'submitted')
      operation.lastStatus = { ...operation.lastStatus!, phase }
      const occupied = structuredClone(harness.getSnapshot())
      occupied.residentLifecycleOperations = [operation]
      harness.publish(occupied)
      render(<App api={harness.api} />)

      expect(await screen.findByText(/resident session already owns this workspace/i)).toBeVisible()
      expect(screen.getByText(/open or select that thread.*End session in Session/i)).toBeVisible()
      expect(screen.queryByText(/earlier resident setup still holds this workspace/i)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'New resident thread in this workspace' })).not.toBeInTheDocument()
    },
  )

  it('releases saved-workspace create only after an exact completed sibling End is projected', async () => {
    const harness = createRegisteredWorkspaceHarness()
    const released = structuredClone(harness.getSnapshot())
    released.residentLifecycleOperations = [
      registeredSiblingProvisionOperation(),
      registeredWorkspaceEndOperation('completed'),
    ]
    harness.publish(released)
    render(<App api={harness.api} />)

    expect(await screen.findByRole('button', { name: 'New resident thread in this workspace' })).toBeEnabled()
    expect(screen.queryByText(/owns this workspace|still holds this workspace/i)).not.toBeInTheDocument()
  })

  it('keeps registered fresh create suppressed while exact pre-effect End review remains usable', async () => {
    const user = userEvent.setup()
    const harness = createRegisteredWorkspaceHarness({ residentActive: true })
    const ending = structuredClone(harness.getSnapshot())
    const operation = registeredWorkspaceEndOperation('ending', 'selected')
    ending.residentLifecycleOperations = [operation]
    ending.composerReceipt = {
      state: 'sent',
      operation: 'end',
      retryable: true,
      message: 'Ready to finish · Prime Agent has not received an End request',
    }
    ending.operations.provisionResident = undefined
    ending.operations.endResident = true
    harness.api.endResident = vi.fn(async () => ({
      ...operation.lastStatus!,
      phase: 'completed',
      updatedAt: '2026-08-05T20:00:03.000Z',
      terminalAt: '2026-08-05T20:00:03.000Z',
    }))
    harness.publish(ending)
    render(<App api={harness.api} />)

    expect(await screen.findByText(/resident session already owns this workspace/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'New resident thread in this workspace' })).not.toBeInTheDocument()
    const review = screen.getByRole('button', { name: 'Finish ending this resident session' })
    expect(review).toBeEnabled()
    await user.click(review)
    expect(harness.api.prepareResidentEnd).toHaveBeenCalledWith(expect.objectContaining({
      resumeOperationId: operation.operationId,
      expectedHostId: operation.expectedHostId,
      threadId: operation.threadId,
      executionGenerationId: operation.executionGenerationId,
    }))
    await waitFor(() => expect(harness.api.endResident).toHaveBeenCalledWith({
      confirmationToken: 'registered-end-confirmation-one',
      consent: true,
    }))
    expect(harness.api.endResident).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps a remote End recovery status-only until its exact resident thread is selected', async () => {
    const harness = createRegisteredWorkspaceHarness({ provisionEnabled: false })
    const changed = structuredClone(harness.getSnapshot())
    const donor = changed.threads.find((thread) => thread.id === 'thread-seamless')!
    changed.threads.push({
      ...donor,
      id: 'thread-other-remote',
      remoteId: 'thread-other-remote',
      workspaceId: 'workspace-other-remote',
      executionGenerationId: 'generation-other-remote',
      title: 'Other remote thread',
    })
    changed.selectedThreadId = 'thread-other-remote'
    changed.residentLifecycleOperations = [registeredWorkspaceEndOperation('ending', 'selected')]
    harness.publish(changed)
    render(<App api={harness.api} />)

    const card = await screen.findByRole('region', { name: 'End saved' })
    expect(within(card).getByText(/open or select the resident thread.*End session in Session/i)).toBeVisible()
    expect(within(card).queryByRole('button', { name: 'Finish ending' })).not.toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Check status' })).toBeEnabled()
    expect(harness.api.prepareResidentEnd).not.toHaveBeenCalled()
  })

  it('reviews and submits permanent end for the exact saved SSH resident lineage', async () => {
    const user = userEvent.setup()
    const harness = createRegisteredWorkspaceHarness({ residentActive: true })
    const ending = await vi.mocked(harness.api.endResident!).getMockImplementation()!({
      confirmationToken: 'fixture-token',
      consent: true,
    })
    vi.mocked(harness.api.endResident!)
      .mockResolvedValueOnce(ending)
      .mockResolvedValueOnce({
        ...ending,
        phase: 'completed',
        updatedAt: '2026-08-05T20:00:03.000Z',
        terminalAt: '2026-08-05T20:00:03.000Z',
      })
    render(<App api={harness.api} />)

    await user.click(await screen.findByRole('tab', { name: 'Session' }))
    await user.click(screen.getByRole('button', { name: 'End session' }))
    expect(harness.api.prepareResidentEnd).toHaveBeenCalledWith({
      expectedHostId: 'host-devbox',
      projectId: 'project-prime',
      workspaceId: 'workspace-prime-ssh',
      threadId: 'thread-seamless',
      executionGenerationId: 'generation-prime-ssh',
    })
    await waitFor(() => {
      expect(harness.api.endResident).toHaveBeenCalledWith({
        confirmationToken: 'registered-end-confirmation-one',
        consent: true,
      })
      expect(harness.api.prepareResidentEnd).toHaveBeenLastCalledWith({
        expectedHostId: 'host-devbox',
        projectId: 'project-prime',
        workspaceId: 'workspace-prime-ssh',
        threadId: 'thread-seamless',
        executionGenerationId: 'generation-prime-ssh',
        resumeOperationId: 'registered-end-operation-one',
      })
      expect(harness.api.endResident).toHaveBeenCalledTimes(2)
    })
    expect(screen.queryByRole('dialog', { name: 'End agent session?' })).not.toBeInTheDocument()
  })

  it('closes a saved-workspace authorization when the selected source generation changes', async () => {
    const user = userEvent.setup()
    const harness = createRegisteredWorkspaceHarness()
    render(<App api={harness.api} />)

    const create = await screen.findByRole('button', { name: 'New resident thread in this workspace' })
    await user.click(create)
    expect(await screen.findByRole('dialog', { name: 'Start another task' })).toBeVisible()
    const changed = structuredClone(harness.getSnapshot())
    changed.threads.find((thread) => thread.id === 'thread-seamless')!.executionGenerationId = 'generation-prime-ssh-next'
    act(() => harness.publish(changed))
    await waitFor(() => expect(screen.queryByRole('dialog', {
      name: 'Start another task',
    })).not.toBeInTheDocument())
    expect(harness.api.provisionResident).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open sidebar' })).toHaveFocus())
  })

  it.each([
    ['missing capability', { provisionEnabled: false, endEnabled: false }],
    ['relay path', { provisionEnabled: false, endEnabled: false, connectionPath: 'Relay' as const }],
    ['unverified host', { provisionEnabled: false, endEnabled: false, activationRequired: true }],
  ])('withholds saved-workspace create and end actions for a %s', async (_label, options) => {
    const user = userEvent.setup()
    const harness = createRegisteredWorkspaceHarness(options)
    render(<App api={harness.api} />)

    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    expect(screen.queryByRole('button', { name: 'New resident thread in this workspace' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Session' }))
    expect(screen.queryByRole('button', { name: 'End session' })).not.toBeInTheDocument()
    expect(harness.api.selectResidentWorkspace).not.toHaveBeenCalled()
    expect(harness.api.prepareResidentEnd).not.toHaveBeenCalled()
  })

  it('keeps an unknown remote setup status-first and hides workspace retry after capability withdrawal', async () => {
    const user = userEvent.setup()
    const harness = createRegisteredWorkspaceHarness()
    harness.api.provisionResident = vi.fn(async () => {
      throw new Error('The remote resident setup outcome is not proven.')
    })
    render(<App api={harness.api} />)

    await user.click(await screen.findByRole('button', { name: 'New resident thread in this workspace' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start another task' })
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))
    expect(await within(dialog).findByText(/check the durable recovery state/i)).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))

    const card = await screen.findByRole('region', { name: 'Setup outcome needs inspection' })
    expect(within(card).getByRole('button', { name: 'Check status' })).toBeEnabled()
    expect(within(card).queryByRole('button', { name: /use saved workspace|try again/i })).not.toBeInTheDocument()
    expect(card.textContent).not.toMatch(/folder|picker/i)

    await user.click(within(card).getByRole('button', { name: 'Check status' }))
    const retainedCard = await screen.findByRole('region', { name: 'Setup outcome needs inspection' })
    expect(within(retainedCard).getByRole('button', { name: 'Check status' })).toBeEnabled()
    expect(harness.api.residentLifecycleStatus).toHaveBeenCalledWith({
      expectedHostId: 'host-devbox',
      operationId: 'registered-operation-one',
    })

    const withdrawn = structuredClone(harness.getSnapshot())
    withdrawn.operations.provisionResident = undefined
    withdrawn.operations.endResident = undefined
    act(() => harness.publish(withdrawn))
    expect(within(retainedCard).queryByRole('button', { name: /use saved workspace|try again/i })).not.toBeInTheDocument()
    expect(harness.api.provisionResident).toHaveBeenCalledTimes(1)
  })

  it('preserves exact saved-workspace lineage when fallback status becomes safely resumable', async () => {
    const user = userEvent.setup()
    const harness = createRegisteredWorkspaceHarness()
    harness.api.provisionResident = vi.fn(async () => {
      throw new Error('The remote resident setup outcome is not proven.')
    })
    harness.api.residentLifecycleStatus = vi.fn(async () => ({
      version: 1 as const,
      kind: 'provision' as const,
      operationId: 'registered-operation-one',
      phase: 'prepared' as const,
      expectedHostId: 'host-devbox',
      projectId: 'project-prime',
      workspaceId: 'workspace-prime-ssh',
      threadId: 'registered-new-thread',
      executionGenerationId: 'registered-new-generation',
      preparedAt: '2026-08-05T20:00:00.000Z',
      updatedAt: '2026-08-05T20:00:01.000Z',
    }))
    render(<App api={harness.api} />)

    await user.click(await screen.findByRole('button', { name: 'New resident thread in this workspace' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start another task' })
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Close' }))

    const fallback = await screen.findByRole('region', { name: 'Setup outcome needs inspection' })
    expect(screen.queryByRole('button', { name: 'New resident thread in this workspace' })).not.toBeInTheDocument()
    vi.mocked(harness.api.selectResidentWorkspace).mockClear()
    await user.click(within(fallback).getByRole('button', { name: 'Check status' }))

    const resumable = await screen.findByRole('region', { name: 'Setup paused safely' })
    expect(within(resumable).getByText(/continue in the saved host-owned workspace/i)).toBeVisible()
    expect(resumable.textContent).not.toMatch(/folder|picker|handoff|mobile/i)
    expect(screen.queryByRole('button', { name: 'New resident thread in this workspace' })).not.toBeInTheDocument()
    await user.click(within(resumable).getByRole('button', { name: 'Use saved workspace' }))
    expect(harness.api.selectResidentWorkspace).toHaveBeenCalledWith({
      kind: 'registered_workspace',
      projectId: 'project-prime',
      workspaceId: 'workspace-prime-ssh',
      referenceThreadId: 'thread-seamless',
      referenceExecutionGenerationId: 'generation-prime-ssh',
      resumeOperationId: 'registered-operation-one',
    })
    expect(await screen.findByRole('dialog', { name: 'Continue setup' })).toBeVisible()
    expect(harness.api.provisionResident).toHaveBeenCalledTimes(1)
  })

  it('retains ledger-missing saved-workspace recovery through Relay reconnecting authority and resumes the same lineage on SSH', async () => {
    const user = userEvent.setup()
    const harness = createRegisteredWorkspaceHarness()
    harness.api.provisionResident = vi.fn(async () => {
      throw new Error('The remote resident setup outcome is not proven.')
    })
    harness.api.residentLifecycleStatus = vi.fn(async () => ({
      version: 1 as const,
      kind: 'provision' as const,
      operationId: 'registered-operation-one',
      phase: 'prepared' as const,
      expectedHostId: 'host-devbox',
      projectId: 'project-prime',
      workspaceId: 'workspace-prime-ssh',
      threadId: 'registered-new-thread',
      executionGenerationId: 'registered-new-generation',
      preparedAt: '2026-08-05T20:00:00.000Z',
      updatedAt: '2026-08-05T20:00:01.000Z',
    }))
    render(<App api={harness.api} />)

    await user.click(await screen.findByRole('button', { name: 'New resident thread in this workspace' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start another task' })
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Close' }))
    expect(await screen.findByRole('region', { name: 'Setup outcome needs inspection' })).toBeVisible()
    vi.mocked(harness.api.selectResidentWorkspace).mockClear()

    const reconnecting = structuredClone(harness.getSnapshot())
    const reconnectingHost = reconnecting.hosts.find((host) => host.id === 'host-devbox')!
    reconnectingHost.connection = 'reconnecting'
    reconnectingHost.connectionPath = 'Relay'
    reconnecting.operations.provisionResident = undefined
    reconnecting.operations.endResident = undefined
    act(() => harness.publish(reconnecting))

    const retainedDuringMismatch = await screen.findByRole('region', { name: 'Setup outcome needs inspection' })
    expect(within(retainedDuringMismatch).getByRole('button', { name: 'Check status' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'New resident thread in this workspace' })).not.toBeInTheDocument()
    expect(harness.api.residentLifecycleStatus).not.toHaveBeenCalled()
    expect(harness.api.selectResidentWorkspace).not.toHaveBeenCalled()

    const restored = structuredClone(harness.getSnapshot())
    const restoredHost = restored.hosts.find((host) => host.id === 'host-devbox')!
    restoredHost.connection = 'online'
    restoredHost.connectionPath = 'SSH'
    restored.operations.provisionResident = true
    restored.operations.endResident = true
    act(() => harness.publish(restored))

    const restoredFallback = await screen.findByRole('region', { name: 'Setup outcome needs inspection' })
    await user.click(within(restoredFallback).getByRole('button', { name: 'Check status' }))
    expect(harness.api.residentLifecycleStatus).toHaveBeenCalledWith({
      expectedHostId: 'host-devbox',
      operationId: 'registered-operation-one',
    })
    const resumable = await screen.findByRole('region', { name: 'Setup paused safely' })
    expect(screen.queryByRole('button', { name: 'New resident thread in this workspace' })).not.toBeInTheDocument()
    await user.click(within(resumable).getByRole('button', { name: 'Use saved workspace' }))
    expect(harness.api.selectResidentWorkspace).toHaveBeenCalledWith({
      kind: 'registered_workspace',
      projectId: 'project-prime',
      workspaceId: 'workspace-prime-ssh',
      referenceThreadId: 'thread-seamless',
      referenceExecutionGenerationId: 'generation-prime-ssh',
      resumeOperationId: 'registered-operation-one',
    })
  })

  it('releases fresh create after a ledger-missing fallback proves exact clean completion', async () => {
    const user = userEvent.setup()
    const harness = createRegisteredWorkspaceHarness()
    harness.api.provisionResident = vi.fn(async () => {
      throw new Error('The remote resident setup outcome is not proven.')
    })
    harness.api.residentLifecycleStatus = vi.fn(async () => ({
      version: 1 as const,
      kind: 'provision' as const,
      operationId: 'registered-operation-one',
      phase: 'completed' as const,
      completionReason: 'owned_create_cleaned' as const,
      expectedHostId: 'host-devbox',
      projectId: 'project-prime',
      workspaceId: 'workspace-prime-ssh',
      threadId: 'registered-new-thread',
      executionGenerationId: 'registered-new-generation',
      preparedAt: '2026-08-05T20:00:00.000Z',
      updatedAt: '2026-08-05T20:00:02.000Z',
      terminalAt: '2026-08-05T20:00:02.000Z',
    }))
    render(<App api={harness.api} />)

    await user.click(await screen.findByRole('button', { name: 'New resident thread in this workspace' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start another task' })
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Close' }))
    const unresolved = await screen.findByRole('region', { name: 'Setup outcome needs inspection' })
    expect(screen.queryByRole('button', { name: 'New resident thread in this workspace' })).not.toBeInTheDocument()

    await user.click(within(unresolved).getByRole('button', { name: 'Check status' }))

    expect(await screen.findByRole('region', { name: 'Resident setup ended safely' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'New resident thread in this workspace' })).toBeEnabled()
  })

  it('keeps fallback recovery status-only after selection moves away from its exact saved-workspace donor', async () => {
    const user = userEvent.setup()
    const harness = createRegisteredWorkspaceHarness()
    harness.api.provisionResident = vi.fn(async () => {
      throw new Error('The remote resident setup outcome is not proven.')
    })
    harness.api.residentLifecycleStatus = vi.fn(async () => ({
      version: 1 as const,
      kind: 'provision' as const,
      operationId: 'registered-operation-one',
      phase: 'prepared' as const,
      expectedHostId: 'host-devbox',
      projectId: 'project-prime',
      workspaceId: 'workspace-prime-ssh',
      threadId: 'registered-new-thread',
      executionGenerationId: 'registered-new-generation',
      preparedAt: '2026-08-05T20:00:00.000Z',
      updatedAt: '2026-08-05T20:00:01.000Z',
    }))
    render(<App api={harness.api} />)

    await user.click(await screen.findByRole('button', { name: 'New resident thread in this workspace' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start another task' })
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Close' }))

    const changed = structuredClone(harness.getSnapshot())
    const donor = changed.threads.find((thread) => thread.id === 'thread-seamless')!
    const sibling = {
      ...donor,
      id: 'thread-sibling-fallback',
      remoteId: 'thread-sibling-fallback',
      workspaceId: 'workspace-sibling-fallback',
      executionGenerationId: 'generation-sibling-fallback',
      title: 'Sibling fallback workspace',
    }
    changed.threads.push(sibling)
    changed.selectedThreadId = sibling.id
    act(() => harness.publish(changed))

    const fallback = await screen.findByRole('region', { name: 'Setup outcome needs inspection' })
    await user.click(within(fallback).getByRole('button', { name: 'Check status' }))
    const statusOnly = await screen.findByRole('region', { name: 'Setup paused safely' })
    expect(within(statusOnly).getByText(/open the saved workspace and its original source thread/i)).toBeVisible()
    expect(within(statusOnly).queryByRole('button', { name: 'Use saved workspace' })).not.toBeInTheDocument()
    expect(within(statusOnly).getByRole('button', { name: 'Check status' })).toBeEnabled()
    expect(harness.api.selectResidentWorkspace).toHaveBeenCalledTimes(1)
  })

  it('explains a foreign workspace hold without misreporting lifecycle capability on fallback recovery', async () => {
    const user = userEvent.setup()
    const harness = createRegisteredWorkspaceHarness()
    harness.api.provisionResident = vi.fn(async () => {
      throw new Error('The remote resident setup outcome is not proven.')
    })
    harness.api.residentLifecycleStatus = vi.fn(async () => ({
      version: 1 as const,
      kind: 'provision' as const,
      operationId: 'registered-operation-one',
      phase: 'prepared' as const,
      expectedHostId: 'host-devbox',
      projectId: 'project-prime',
      workspaceId: 'workspace-prime-ssh',
      threadId: 'registered-new-thread',
      executionGenerationId: 'registered-new-generation',
      preparedAt: '2026-08-05T20:00:00.000Z',
      updatedAt: '2026-08-05T20:00:01.000Z',
    }))
    render(<App api={harness.api} />)

    await user.click(await screen.findByRole('button', { name: 'New resident thread in this workspace' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start another task' })
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Close' }))
    const unresolved = await screen.findByRole('region', { name: 'Setup outcome needs inspection' })
    await user.click(within(unresolved).getByRole('button', { name: 'Check status' }))

    const occupied = structuredClone(harness.getSnapshot())
    occupied.residentLifecycleOperations = [registeredSiblingProvisionOperation()]
    act(() => harness.publish(occupied))

    const fallback = await screen.findByRole('region', { name: 'Setup paused safely' })
    expect(within(fallback).getByText(/another resident session owns this workspace/i)).toBeVisible()
    expect(within(fallback).getByText(/open or select that thread.*End session in Session/i)).toBeVisible()
    expect(fallback).not.toHaveTextContent(/lifecycle control is unavailable/i)
    expect(within(fallback).queryByRole('button', { name: 'Use saved workspace' })).not.toBeInTheDocument()
    expect(within(fallback).getByRole('button', { name: 'Check status' })).toBeEnabled()
    expect(harness.api.selectResidentWorkspace).toHaveBeenCalledTimes(1)
  })

  it('turns a safe remote recovery into status-only UI while the lifecycle capability is withdrawn', async () => {
    const user = userEvent.setup()
    const harness = createRegisteredWorkspaceHarness({ provisionEnabled: false, endEnabled: false })
    const withdrawn = structuredClone(harness.getSnapshot())
    withdrawn.residentLifecycleOperations = [{
      kind: 'provision',
      provisionMode: 'registered_workspace',
      operationId: 'registered-recovery-one',
      expectedHostId: 'host-devbox',
      projectId: 'project-prime',
      workspaceId: 'workspace-prime-ssh',
      referenceThreadId: 'thread-seamless',
      referenceExecutionGenerationId: 'generation-prime-ssh',
      threadId: 'registered-new-thread',
      executionGenerationId: 'registered-new-generation',
      projectDisplayName: 'Prime Continuim',
      threadTitle: 'Recovered remote thread',
      createdAt: '2026-08-05T20:00:00.000Z',
      updatedAt: '2026-08-05T20:00:01.000Z',
      state: 'requires_reselection',
    }]
    harness.publish(withdrawn)
    render(<App api={harness.api} />)

    const card = await screen.findByRole('region', { name: 'Reconnect workspace' })
    expect(within(card).queryByRole('button', { name: /use saved workspace|try again/i })).not.toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Check status' }))
    expect(harness.api.residentLifecycleStatus).toHaveBeenCalledWith({
      expectedHostId: 'host-devbox',
      operationId: 'registered-recovery-one',
    })
    expect(harness.api.selectResidentWorkspace).not.toHaveBeenCalled()
    expect(harness.api.provisionResident).not.toHaveBeenCalled()
  })

  it('scopes a saved-workspace recovery action to its exact donor thread and generation', async () => {
    const user = userEvent.setup()
    const harness = createRegisteredWorkspaceHarness()
    const changed = structuredClone(harness.getSnapshot())
    const donor = changed.threads.find((thread) => thread.id === 'thread-seamless')!
    const sibling = {
      ...donor,
      id: 'thread-sibling-workspace',
      remoteId: 'thread-sibling-workspace',
      workspaceId: 'workspace-sibling-ssh',
      executionGenerationId: 'generation-sibling-ssh',
      title: 'Sibling workspace',
    }
    changed.threads.push(sibling)
    changed.selectedThreadId = sibling.id
    changed.residentLifecycleOperations = [{
      kind: 'provision',
      provisionMode: 'registered_workspace',
      operationId: 'registered-recovery-one',
      expectedHostId: 'host-devbox',
      projectId: 'project-prime',
      workspaceId: 'workspace-prime-ssh',
      referenceThreadId: 'thread-seamless',
      referenceExecutionGenerationId: 'generation-prime-ssh',
      threadId: 'registered-new-thread',
      executionGenerationId: 'registered-new-generation',
      projectDisplayName: 'Prime Continuim',
      threadTitle: 'Recovered remote thread',
      createdAt: '2026-08-05T20:00:00.000Z',
      updatedAt: '2026-08-05T20:00:01.000Z',
      state: 'requires_reselection',
    }]
    harness.publish(changed)
    render(<App api={harness.api} />)

    const card = await screen.findByRole('region', { name: 'Reconnect workspace' })
    expect(within(card).getByText(/open the saved workspace and its original source thread/i)).toBeVisible()
    expect(within(card).queryByRole('button', { name: /use saved workspace|try again/i })).not.toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Check status' }))
    expect(harness.api.residentLifecycleStatus).toHaveBeenCalledWith({
      expectedHostId: 'host-devbox',
      operationId: 'registered-recovery-one',
    })
    expect(harness.api.selectResidentWorkspace).not.toHaveBeenCalled()
  })

  it('resumes only the exact lifecycle operation selected from a recovery card', async () => {
    const user = userEvent.setup()
    const operation = lifecycleOperation('requires_reselection')
    const api = createResidentProvisioningApi(operation)
    render(<App api={api} />)

    await screen.findByRole('heading', { name: 'Reconnect workspace' })
    expect(api.selectResidentWorkspace).not.toHaveBeenCalled()
    expect(api.provisionResident).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Choose original folder' }))

    expect(api.selectResidentWorkspace).toHaveBeenCalledTimes(1)
    expect(api.selectResidentWorkspace).toHaveBeenCalledWith({
      resumeOperationId: operation.operationId,
    })
    expect(api.residentLifecycleStatus).not.toHaveBeenCalled()
    expect(await screen.findByRole('dialog', { name: 'Continue setup' })).toBeVisible()
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

    await user.click(await screen.findByText((_content, element) =>
      element?.classList.contains('resident-recovery-list__summary-label') === true &&
      element.textContent === '2 saved setups'
    ))
    await screen.findByRole('heading', { name: 'Setup outcome needs inspection' })
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
    expect(screen.getByRole('heading', { name: 'Start an agent' })).toBeVisible()
    expect(within(main).queryByRole('status')).not.toBeInTheDocument()
    expect(within(main).queryByText('Start local service')).not.toBeInTheDocument()
    const chooseWorkspace = screen.getByRole('button', { name: 'Choose workspace folder' })
    await waitFor(() => expect(chooseWorkspace).toHaveFocus())
  })

  it('chooses and names a path-private workspace during live runtime preparation, then waits for final confirmation', async () => {
    const user = userEvent.setup()
    const harness = createLocalSetupHarness({
      stage: 'preparing_runtime',
      runtimeReadiness: {
        kind: 'reported',
        freshness: 'live',
        status: 'initializing',
        phase: 'preparing',
      },
    })
    render(<App api={harness.api} />)

    await screen.findByRole('heading', { name: 'Getting Prime Continuim ready' })
    expect(screen.queryByRole('button', { name: 'Choose workspace while Prime finishes' })).not.toBeInTheDocument()
    act(() => harness.publish({
      stage: 'preparing_runtime',
      runtimeReadiness: {
        kind: 'reported',
        freshness: 'live',
        status: 'initializing',
        phase: 'copying',
      },
    }))

    const choose = await screen.findByRole('button', { name: 'Choose workspace while Prime finishes' })
    await user.click(choose)
    const earlyChoice = await screen.findByRole('region', { name: 'Workspace chosen' })
    expect(within(earlyChoice).getByText(/no workspace access or agent has started/i)).toBeVisible()
    const name = within(earlyChoice).getByRole('textbox', { name: 'Workspace name' })
    expect(name).toHaveValue('Prime workspace')
    await user.clear(name)
    await user.type(name, 'Renamed workspace')
    expect(harness.api.preselectResidentWorkspace).toHaveBeenCalledOnce()
    expect(harness.api.provisionResident).not.toHaveBeenCalled()

    act(() => harness.publish({
      stage: 'choose_workspace',
      runtimeReadiness: {
        kind: 'reported',
        freshness: 'live',
        status: 'ready',
        assurance: 'development-integrity',
      },
    }))
    const dialog = await screen.findByRole('dialog', { name: 'Start agent' })
    const selectedWorkspace = within(dialog).getByRole('region', { name: 'Selected workspace' })
    expect(within(selectedWorkspace).getByText('Renamed workspace')).toBeVisible()
    expect(within(dialog).getByRole('textbox', { name: /^Task name/ })).toHaveValue('Renamed workspace task')
    expect(harness.api.completeResidentWorkspacePreselection).toHaveBeenCalledOnce()
    expect(harness.api.provisionResident).not.toHaveBeenCalled()
    const readyChooser = screen.getByRole('button', { name: 'Choose workspace folder' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(readyChooser).toHaveFocus())
  })

  it('cancels an early workspace choice and never replays a failed readiness conversion', async () => {
    const user = userEvent.setup()
    const setup: LocalSetupSummary = {
      stage: 'preparing_runtime',
      runtimeReadiness: {
        kind: 'reported',
        freshness: 'live',
        status: 'initializing',
        phase: 'verifying',
      },
    }
    const harness = createLocalSetupHarness(setup)
    render(<App api={harness.api} />)
    const choose = await screen.findByRole('button', { name: 'Choose workspace while Prime finishes' })
    await user.click(choose)
    await user.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(harness.api.cancelResidentWorkspacePreselection).toHaveBeenCalledWith('preselection-local-one')
    expect(screen.queryByRole('region', { name: 'Workspace chosen' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Choose workspace while Prime finishes' }))
    vi.mocked(harness.api.completeResidentWorkspacePreselection).mockRejectedValueOnce(new Error('Selection expired'))
    const ready: LocalSetupSummary = {
      stage: 'choose_workspace',
      runtimeReadiness: {
        kind: 'reported',
        freshness: 'live',
        status: 'ready',
        assurance: 'development-integrity',
      },
    }
    act(() => harness.publish(ready))
    expect(await screen.findByRole('alert')).toHaveTextContent('Selection expired')
    act(() => harness.publish(ready))
    expect(harness.api.completeResidentWorkspacePreselection).toHaveBeenCalledOnce()
    expect(harness.api.provisionResident).not.toHaveBeenCalled()
  })

  it('opens Prime Agent accounts and starts host-scoped OAuth before a resident thread exists', async () => {
    const user = userEvent.setup()
    const harness = createModelSelectionHarness({ runtimeOAuth: true })
    const loadWorkbench = harness.api.loadWorkbench.bind(harness.api)
    harness.api.loadWorkbench = vi.fn(async () => {
      const snapshot = await loadWorkbench()
      snapshot.selectedProjectId = ''
      snapshot.selectedThreadId = ''
      snapshot.projects = []
      snapshot.threads = []
      snapshot.runtime = {}
      snapshot.operations = {
        ...snapshot.operations,
        submitCommands: false,
        startResidentTurn: false,
        stopResidentTurn: false,
        provisionResident: true,
        modelCatalog: true,
        selectResidentModel: undefined,
        runtimeOAuth: true,
      }
      return snapshot
    })
    harness.api.startRuntimeOAuth = vi.fn(async () => ({
      state: 'completed',
      message: 'ChatGPT is connected to Prime Agent.',
    }))
    harness.api.cancelRuntimeOAuth = vi.fn(async () => null)

    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Start an agent' })
    const models = screen.getByRole('button', { name: 'Models & accounts' })
    expect(screen.queryByRole('heading', { name: 'Seamless remote experience' })).not.toBeInTheDocument()
    await user.click(models)

    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    await user.click(await within(dialog).findByRole('button', { name: 'Connect ChatGPT' }))

    expect(harness.api.startRuntimeOAuth).toHaveBeenCalledWith({
      hostId: 'host-local',
      providerId: 'openai-codex',
    }, expect.any(Function))
    expect(within(dialog).getByText('ChatGPT is connected to Prime Agent.')).toHaveAttribute('role', 'status')
    expect(within(dialog).queryByRole('button', { name: /Use model/i })).not.toBeInTheDocument()
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

    expect(await screen.findByRole('heading', { name: 'Finish agent setup' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Setup outcome needs inspection' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Choose workspace folder' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use another computer' })).toBeVisible()
  })

  it('reuses the original path-free names when continuing resident setup', async () => {
    const user = userEvent.setup()
    const operation = {
      ...lifecycleOperation('requires_reselection'),
      projectDisplayName: 'Original workspace',
      threadTitle: 'Original task',
    }
    const api = createResidentProvisioningApi(operation)
    render(<App api={api} />)

    await user.click(await screen.findByRole('button', { name: 'Choose original folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Continue setup' })
    expect(within(dialog).getByText('Original workspace')).toBeVisible()
    expect(within(dialog).getByText('Original task')).toBeVisible()
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(dialog).getByText('Original setup restored')).toBeVisible()
    expect(within(dialog).getByText(/no duplicate session or task/i)).toBeVisible()
    const continueSetup = within(dialog).getByRole('button', { name: 'Continue setup' })
    await waitFor(() => expect(continueSetup).toHaveFocus())
    await user.click(continueSetup)

    expect(api.provisionResident).toHaveBeenCalledWith({
      selectionToken: 'resident-selection-one',
      projectDisplayName: 'Original workspace',
      threadTitle: 'Original task',
    })
    expect(api.selectResidentWorkspace).toHaveBeenCalledTimes(1)
  })

  it('restores immutable names inline after an identity conflict and continues without reselecting', async () => {
    const user = userEvent.setup()
    const api = createResidentProvisioningApi()
    const prepared = await vi.mocked(api.provisionResident).getMockImplementation()!({
      selectionToken: 'unused',
      projectDisplayName: 'unused',
      threadTitle: 'unused',
    })
    api.provisionResident = vi.fn()
      .mockRejectedValueOnce(new ResidentProvisionError('This setup already has names from its original attempt.', {
        durableOperationPossible: false,
        code: 'resident.provision_identity_conflict',
        details: {
          expectedProjectDisplayName: 'Original workspace',
          expectedThreadTitle: 'Original task',
        },
      }))
      .mockResolvedValueOnce(prepared)
    render(<App api={api} />)

    await user.click(await screen.findByRole('button', { name: 'Choose workspace folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start agent' })
    const taskName = within(dialog).getByRole('textbox', { name: 'Task name' })
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))
    const workspaceName = within(dialog).getByRole('textbox', { name: 'Workspace name' })
    await user.clear(workspaceName)
    await user.type(workspaceName, 'Different workspace')
    await user.clear(taskName)
    await user.type(taskName, 'Different task')
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/original setup.*restored/i)
    expect(within(dialog).getByText('Original workspace')).toBeVisible()
    expect(within(dialog).getByText('Original task')).toBeVisible()
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Continue setup' }))

    expect(api.provisionResident).toHaveBeenCalledTimes(2)
    expect(api.provisionResident).toHaveBeenLastCalledWith({
      selectionToken: 'resident-selection-one',
      projectDisplayName: 'Original workspace',
      threadTitle: 'Original task',
    })
    expect(api.selectResidentWorkspace).toHaveBeenCalledTimes(1)
  })

  it('starts a new provision attempt without rendering the prior identity conflict', async () => {
    const user = userEvent.setup()
    const api = createResidentProvisioningApi()
    api.selectResidentWorkspace = vi.fn()
      .mockResolvedValueOnce({
        selectionToken: 'resident-selection-one',
        operationId: 'resident-operation-one',
        expectedHostId: 'host-local',
        suggestedName: 'Prime GUI',
        expiresAt: '2099-08-05T20:05:00.000Z',
      })
      .mockResolvedValueOnce({
        selectionToken: 'resident-selection-two',
        operationId: 'resident-operation-two',
        expectedHostId: 'host-local',
        suggestedName: 'Fresh workspace',
        expiresAt: '2099-08-05T20:06:00.000Z',
      })
    api.provisionResident = vi.fn(async () => {
      throw new ResidentProvisionError('This setup already has names from its original attempt.', {
        durableOperationPossible: false,
        code: 'resident.provision_identity_conflict',
        details: {
          expectedProjectDisplayName: 'Original workspace',
          expectedThreadTitle: 'Original task',
        },
      })
    })
    render(<App api={api} />)

    const trigger = await screen.findByRole('button', { name: 'Choose workspace folder' })
    await user.click(trigger)
    let dialog = await screen.findByRole('dialog', { name: 'Start agent' })
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/original setup.*restored/i)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(trigger).toHaveFocus())

    await user.click(trigger)
    dialog = await screen.findByRole('dialog', { name: 'Start agent' })
    expect(within(dialog).getByRole('region', { name: 'Selected workspace' })).toHaveTextContent('Fresh workspace')
    expect(within(dialog).getByRole('textbox', { name: 'Task name' })).toHaveValue('Fresh workspace task')
    expect(within(dialog).queryByText(/original setup.*restored/i)).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))
    expect(within(dialog).getByRole('textbox', { name: 'Workspace name' })).toHaveValue('Fresh workspace')
  })

  it('admits at most one provision mutation from rapid duplicate form submissions', async () => {
    const user = userEvent.setup()
    const api = createResidentProvisioningApi()
    const provision = deferred<Awaited<ReturnType<RendererApi['provisionResident']>>>()
    api.provisionResident = vi.fn(() => provision.promise)
    render(<App api={api} />)

    await user.click(await screen.findByRole('button', { name: 'Choose workspace folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start agent' })
    const submit = within(dialog).getByRole('button', { name: 'Start agent' })
    const form = submit.closest('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form!)
    fireEvent.submit(form!)

    expect(api.provisionResident).toHaveBeenCalledTimes(1)
    expect(await within(dialog).findByRole('button', { name: 'Starting…' })).toBeDisabled()
    provision.resolve({
      version: 1,
      kind: 'provision',
      operationId: 'resident-operation-one',
      phase: 'prepared',
      expectedHostId: 'host-local',
      projectId: 'resident-project-one',
      workspaceId: 'resident-workspace-one',
      threadId: 'resident-thread-one',
      executionGenerationId: 'resident-generation-one',
      preparedAt: '2026-08-05T20:00:00.000Z',
      updatedAt: '2026-08-05T20:00:01.000Z',
    })
    expect(await within(dialog).findByText(/setup is durably recorded/i)).toBeVisible()
    expect(api.provisionResident).toHaveBeenCalledTimes(1)
  })

  it('labels and validates resident setup, keeps paths hidden, and cancels without mutation', async () => {
    const user = userEvent.setup()
    const api = createResidentProvisioningApi()
    render(<App api={api} />)

    const trigger = await screen.findByRole('button', { name: 'Choose workspace folder' })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Start agent' })
    expect(dialog).toHaveAccessibleDescription(/runs it in this folder/i)
    expect(document.body).not.toHaveTextContent('C:\\Users\\operator\\secret-workspace')

    const threadTitle = within(dialog).getByRole('textbox', { name: /^Task name/ })
    expect(threadTitle).toHaveValue('Prime GUI task')
    await waitFor(() => expect(threadTitle).toHaveFocus())
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))
    const projectName = within(dialog).getByRole('textbox', { name: /^Workspace name/ })
    expect(projectName).toHaveValue('Prime GUI')
    await waitFor(() => expect(projectName).toHaveFocus())

    await user.clear(projectName)
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))
    expect(projectName).toHaveAttribute('aria-invalid', 'true')
    expect(projectName.getAttribute('aria-describedby')).toContain('resident-provision-error')
    expect(projectName).toHaveFocus()
    expect(within(dialog).getByText('Enter a workspace name between 1 and 255 characters.')).toBeVisible()
    expect(api.provisionResident).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start agent' })).not.toBeInTheDocument())
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
    const dialog = await screen.findByRole('dialog', { name: 'Start agent' })
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))
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

    expect(screen.getByRole('dialog', { name: 'Start agent' })).toBe(dialog)
    expect(within(dialog).getByRole('button', { name: 'Starting…' })).toBeDisabled()
    await act(async () => provision.resolve(committedStatus))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start agent' })).not.toBeInTheDocument())
    const heading = await screen.findByRole('heading', { name: 'Prime GUI thread' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(api.provisionResident).toHaveBeenCalledTimes(1)
  })

  it('keeps a path-free recovery route when a nonterminal status returns before ledger hydration', async () => {
    const user = userEvent.setup()
    const api = createResidentProvisioningApi()
    render(<App api={api} />)

    await user.click(await screen.findByRole('button', { name: 'Choose workspace folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start agent' })
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))
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
    const dialog = await screen.findByRole('dialog', { name: 'Start agent' })
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))

    expect(await within(dialog).findByText('The resident setup outcome is unknown.')).toBeVisible()
    const result = within(dialog).getByRole('status')
    expect(result).toHaveTextContent('Check the durable recovery state before trying again.')
    await waitFor(() => expect(result).toHaveFocus())
    expect(within(dialog).queryByRole('button', { name: 'Start agent' })).not.toBeInTheDocument()
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
    const retainedFallback = await screen.findByRole('region', { name: 'Setup outcome needs inspection' })
    expect(within(retainedFallback).getByRole('button', { name: 'Check status' })).toBeEnabled()
    expect(within(retainedFallback).queryByRole('button', { name: 'Choose original folder' })).not.toBeInTheDocument()
    expect(screen.getByText('No durable setup record was returned. Prime Continuim will not retry it; check this host again before starting another resident thread.')).toBeInTheDocument()
    expect(api.residentLifecycleStatus).toHaveBeenCalledTimes(1)
  })

  it('does not invent a recovery operation for a definitive pre-record failure', async () => {
    const user = userEvent.setup()
    const api = createResidentProvisioningApi()
    api.provisionResident = vi.fn(async () => {
      throw new ResidentProvisionError('Enter a project name between 1 and 255 characters.', {
        durableOperationPossible: false,
        code: 'resident.provision_label_invalid',
      })
    })
    render(<App api={api} />)

    await user.click(await screen.findByRole('button', { name: 'Choose workspace folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start agent' })
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))
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

  it('announces and selects a fallback diagnostic when quarantined setup clipboard access fails', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {
      throw new Error('Clipboard denied')
    })
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const api = createResidentProvisioningApi()
    api.provisionResident = vi.fn(async () => ({
      version: 1 as const,
      kind: 'provision' as const,
      operationId: 'resident-operation-one',
      phase: 'quarantined' as const,
      expectedHostId: 'host-local',
      projectId: 'resident-project-one',
      workspaceId: 'resident-workspace-one',
      threadId: 'resident-thread-one',
      executionGenerationId: 'resident-generation-one',
      preparedAt: '2026-08-05T20:00:00.000Z',
      updatedAt: '2026-08-05T20:00:01.000Z',
      quarantinedFrom: 'promotion_dispatching' as const,
      quarantineReason: 'external_outcome_unknown' as const,
    }))
    render(<App api={api} />)

    await user.click(await screen.findByRole('button', { name: 'Choose workspace folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start agent' })
    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Close' }))

    const card = await screen.findByRole('region', { name: 'Setup needs manual recovery' })
    const copy = within(card).getByRole('button', { name: 'Copy diagnostic' })
    copy.focus()
    await user.keyboard('{Enter}')

    expect(await within(card).findByRole('alert')).toHaveTextContent(/Unable to copy the diagnostic.*copy it manually.*Prime Continuim support/i)
    const diagnostic = within(card).getByRole('textbox', { name: 'Resident setup diagnostic' })
    await waitFor(() => expect(diagnostic).toHaveFocus())
    expect((diagnostic as HTMLTextAreaElement).value).toContain('RESIDENT_LIFECYCLE_QUARANTINED')
    expect((diagnostic as HTMLTextAreaElement).selectionStart).toBe(0)
    expect((diagnostic as HTMLTextAreaElement).selectionEnd).toBe((diagnostic as HTMLTextAreaElement).value.length)
    expect(writeText).toHaveBeenCalledOnce()
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
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 256 })
    window.dispatchEvent(new Event('resize'))
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

    expect(await screen.findByText('Stop needs review', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.queryByRole('button', {
      name: 'Stop outcome unknown; inspect the current thread state',
    })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review status' })).toBeEnabled()
    expect(document.querySelector('.composer-wrap')).toHaveClass('composer-wrap--compact')
    expect(document.querySelector('.composer__connection')).toHaveClass('composer__connection--uncertain')
    expect(screen.getAllByText('Outcome unknown · recovery required; this Stop will not be replayed').some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.queryByRole('region', { name: 'Session status' })).not.toBeInTheDocument()
    expect(screen.queryByText(/try stop again/i)).not.toBeInTheDocument()
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
    expect(screen.getByText('Reconnecting', { selector: '.task-state__label' })).toBeVisible()
    expect(document.querySelector('.task-state')).toHaveClass('task-state--stale')
    expect(screen.getAllByText(/Reconnecting… Last synchronized 12 s ago/).some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.queryByRole('textbox', { name: 'Task brief' })).not.toBeInTheDocument()
    expect(document.querySelector('.composer-wrap')).toHaveClass('composer-wrap--compact')
    expect(screen.getByText('Reconnecting', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.queryByText('Active resident turn', { selector: '.composer__intent' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Prime Agent is working · Stop requests a safe boundary/i)).not.toBeInTheDocument()
    expect(screen.getAllByText(/Saved activity is available while devbox reconnects/i).some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.getByRole('button', { name: 'Reconnect to verify and control this resident turn' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reconnect to verify and control this resident turn' })).toHaveTextContent('Reconnect to verify')
    expect(screen.getByText(/cached transcript is still available/i)).toBeVisible()
    const continuity = screen.getByRole('region', { name: 'Session status' })
    expect(continuity.querySelector('.session-continuity__label')).toHaveTextContent('Reconnecting')
    expect(within(continuity).getByText('Saved activity is available while devbox reconnects.')).toBeVisible()
    expect(within(continuity).queryByText(/after this window closes/i)).not.toBeInTheDocument()
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
    expect(screen.queryByRole('textbox', { name: 'Task brief' })).not.toBeInTheDocument()
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
    await user.type(screen.getByRole('textbox', { name: 'Task brief' }), 'Keep this exact draft')
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
    expect(screen.getByRole('textbox', { name: 'Task brief' })).toHaveValue('Keep this exact draft')
    expect(harness.api.sendComposer).not.toHaveBeenCalled()
  })

  it('keeps controlled activation errors path-free, read-only, and explicitly retryable when authority is online', async () => {
    const user = userEvent.setup()
    const harness = createHostActivationHarness()
    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.type(screen.getByRole('textbox', { name: 'Task brief' }), 'Preserve after failure')
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
    expect(screen.getByRole('textbox', { name: 'Task brief' })).toHaveValue('Preserve after failure')
    expect(screen.getByRole('button', { name: 'Delegate task' })).toBeDisabled()
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
    await user.type(screen.getByRole('textbox', { name: 'Task brief' }), 'Draft stays with my current view')
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

  it('offers one accessible, task-oriented delegation action for an idle resident session', async () => {
    const user = userEvent.setup()
    const api = createIdleResidentApi()
    api.sendComposer = vi.fn(async () => ({ state: 'sent', message: 'Sent' }))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    expect(screen.queryByRole('button', { name: /steer/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /follow up/i })).not.toBeInTheDocument()
    expect(screen.getByText('Ready', { selector: '.composer__intent' })).toBeVisible()
    const composer = screen.getByRole('textbox', { name: 'Task brief' })
    const composerStatus = document.getElementById('composer-status')
    const continuityStatus = screen.getByRole('region', { name: 'Session status' })
      .querySelector('.session-continuity__label')
    expect(composer).toHaveAttribute('placeholder', 'Describe the outcome, constraints, and done criteria…')
    expect(composer).toHaveAttribute('aria-describedby', 'composer-hint composer-status')
    expect(document.getElementById('composer-hint')).toHaveTextContent('Include the outcome, constraints, and done criteria')
    expect(composerStatus).not.toHaveAttribute('role')
    expect(composerStatus).not.toHaveAttribute('aria-live')
    expect(continuityStatus).not.toHaveAttribute('role')
    expect(continuityStatus).not.toHaveAttribute('aria-live')
    expect(screen.getByRole('form', { name: 'Prime Agent prompt' })).toContainElement(composer)

    await user.type(composer, 'Summarize the approval boundary.')
    await user.click(screen.getByRole('button', { name: 'Delegate task' }))
    expect(api.sendComposer).toHaveBeenCalledWith({
      threadId: 'thread-complete',
      text: 'Summarize the approval boundary.',
    })
  })

  it('keeps the root composer actionable while a background RLM child is working', async () => {
    const api = createIdleResidentApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = vi.fn(async () => {
      const snapshot = await loadWorkbench()
      const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
      if (!thread) throw new Error('Expected the selected resident fixture')
      thread.transcript = []
      snapshot.agents = [{
        id: 'background-browser-auditor',
        name: 'Browser auditor',
        role: 'RLM branch',
        status: 'running',
        hostName: 'Resident workstation',
        activity: 'Inspecting the browser harness',
      }]
      return snapshot
    })

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })

    expect(document.querySelector('.agent-launchpad')).not.toBeInTheDocument()
    expect(screen.getByText('Working', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.getByText('Browser auditor · Inspecting the browser harness', {
      selector: '.composer__connection span',
    })).toBeVisible()
    const composer = screen.getByRole('textbox', { name: 'Task brief' })
    expect(composer).toBeEnabled()
    expect(composer).toHaveAttribute('placeholder', 'Add direction, constraints, or another outcome…')
    expect(screen.getByRole('button', { name: 'Delegate task' })).toBeEnabled()
  })

  it('prefills a generic investigation task without sending it', async () => {
    const user = userEvent.setup()
    const api = createIdleResidentApi()
    api.sendComposer = vi.fn(async () => ({ state: 'sent', message: 'Sent' }))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    const composer = screen.getByRole('textbox', { name: 'Task brief' })

    await user.click(screen.getByRole('button', { name: 'Investigate an issue' }))

    expect((composer as HTMLTextAreaElement).value).toBe('Investigate: [issue, reproduction details, expected behavior, and done criteria].')
    expect(api.sendComposer).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Investigate an issue' })).toHaveAttribute('aria-pressed', 'true')

    await user.type(composer, ' Add one more constraint.')
    expect((composer as HTMLTextAreaElement).value).toContain('Add one more constraint.')
    expect(screen.getByRole('button', { name: 'Investigate an issue' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('prefills a generic RLM delegation task without sending it', async () => {
    const user = userEvent.setup()
    const api = createIdleResidentApi()
    api.sendComposer = vi.fn(async () => ({ state: 'sent', message: 'Sent' }))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    const composer = screen.getByRole('textbox', { name: 'Task brief' })

    await user.click(screen.getByRole('button', { name: 'Delegate a task' }))

    expect((composer as HTMLTextAreaElement).value).toBe('Delegate with RLM: [outcome, constraints, and done criteria].')
    expect(api.sendComposer).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Delegate a task' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('turns a fresh resident thread into a guided agent launchpad without duplicating composer starters', async () => {
    const user = userEvent.setup()
    const api = asNativeFixture(createIdleResidentApi())
    api.sendComposer = vi.fn(async () => ({ state: 'sent', message: 'Sent' }))
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = vi.fn(async () => {
      const snapshot = await loadWorkbench()
      const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
      if (!thread || !snapshot.runtime.session) throw new Error('Expected the selected resident fixture')
      thread.transcript = []
      snapshot.runtime.session.model = 'unknown/unknown'
      snapshot.runtime.browserExecution = { readiness: 'ready' }
      return snapshot
    })

    render(<App api={api} />)
    expect(await screen.findByRole('heading', { name: 'Give Prime Agent a goal.' })).toBeVisible()
    expect(screen.getByText('It delegates focused work and folds the result back.')).toBeVisible()
    expect(screen.getByText('Choose a model', { selector: '.agent-launchpad__setup-copy strong' })).toBeVisible()
    expect(screen.getByText('Connect a provider and choose the model for this task.', {
      selector: '.agent-launchpad__setup-copy small',
    })).toBeVisible()
    expect(document.querySelector('.agent-launchpad__capabilities')).not.toBeInTheDocument()
    expect(document.querySelector('.task-starters')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Investigate an issue.*Reproduce and resolve root cause/ }))
    const composer = screen.getByRole('textbox', { name: 'Task brief' })
    await waitFor(() => expect(composer).toHaveFocus())
    expect((composer as HTMLTextAreaElement).value).toBe('Investigate: [issue, reproduction details, expected behavior, and done criteria].')
    expect(api.sendComposer).not.toHaveBeenCalled()

    expect(screen.queryByRole('button', { name: 'Open models and accounts to choose a model' })).not.toBeInTheDocument()
    const setupModel = screen.getByRole('button', { name: 'Set up model' })
    await user.click(setupModel)
    expect(await screen.findByRole('dialog', { name: 'Models & accounts' })).toBeVisible()
    expect(api.sendComposer).not.toHaveBeenCalled()
  })

  it('opens model setup from the composer instead of submitting without a selected model', async () => {
    const user = userEvent.setup()
    const api = asNativeFixture(createIdleResidentApi())
    api.sendComposer = vi.fn(async () => ({ state: 'sent', message: 'Sent' }))
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = vi.fn(async () => {
      const snapshot = await loadWorkbench()
      if (!snapshot.runtime.session) throw new Error('Expected the selected resident fixture')
      snapshot.runtime.session.model = 'unknown/unknown'
      return snapshot
    })

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    expect(document.querySelector('.agent-launchpad')).not.toBeInTheDocument()

    const setupModel = screen.getByRole('button', { name: 'Open models and accounts to choose a model' })
    expect(setupModel).toHaveTextContent('Set up model')
    await user.click(setupModel)

    expect(await screen.findByRole('dialog', { name: 'Models & accounts' })).toBeVisible()
    expect(api.sendComposer).not.toHaveBeenCalled()
  })

  it('finds task starters from the command palette and returns focus to the editable composer', async () => {
    const user = userEvent.setup()
    const api = createIdleResidentApi()
    api.sendComposer = vi.fn(async () => ({ state: 'sent', message: 'Sent' }))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    await user.click(screen.getByRole('button', { name: 'Search projects, threads, and commands' }))

    const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
    await user.type(
      within(palette).getByRole('combobox', { name: 'Search projects, threads, and commands' }),
      'Investigate an issue',
    )
    await user.click(within(palette).getByRole('option', { name: /Investigate an issue/ }))

    const composer = screen.getByRole('textbox', { name: 'Task brief' })
    await waitFor(() => expect(composer).toHaveFocus())
    expect((composer as HTMLTextAreaElement).value).toBe('Investigate: [issue, reproduction details, expected behavior, and done criteria].')
    expect(screen.queryByRole('dialog', { name: 'Search and commands' })).not.toBeInTheDocument()
    expect(api.sendComposer).not.toHaveBeenCalled()
  })

  it.each([
    { taskState: 'idle' as const, expectedStatus: 'Ready', expectedDetail: 'Prime Agent is ready for another task.' },
    { taskState: 'waiting' as const, expectedStatus: 'Reply needed', expectedDetail: 'Prime Agent is waiting for more context.' },
    { taskState: 'running' as const, connection: 'reconnecting' as const, expectedStatus: 'Reconnecting', expectedDetail: 'Saved activity is available while Resident workstation reconnects.' },
  ])('renders $expectedStatus continuity without duplicating the task-state announcement', async ({ taskState, connection, expectedStatus, expectedDetail }) => {
    render(<App api={createContinuityApi({ taskState, ...(connection ? { connection } : {}) })} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    const continuity = screen.getByRole('region', { name: 'Session status' })

    const label = continuity.querySelector('.session-continuity__label')
    expect(label).toHaveTextContent(expectedStatus)
    expect(label).not.toHaveAttribute('role')
    expect(label).not.toHaveAttribute('aria-live')
    expect(within(continuity).getByText(expectedDetail)).toBeVisible()
    expect(within(continuity).queryByText(/after this window closes/i)).not.toBeInTheDocument()
    if (connection !== 'reconnecting') {
      expect(within(continuity).getByText(/GPT-5\.6 Sol · Browser ready/)).toBeVisible()
    } else {
      expect(within(continuity).queryByText(/Exact session/)).not.toBeInTheDocument()
    }
  })

  it('opens the cohesive session manager from the live session status', async () => {
    const user = userEvent.setup()
    render(<App api={createContinuityApi({ taskState: 'idle' })} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })

    const continuity = screen.getByRole('region', { name: 'Session status' })
    const manage = within(continuity).getByRole('button', { name: 'Session' })
    await user.click(manage)

    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
    const sessionPanel = screen.getByRole('tabpanel', { name: 'Session' })
    expect(within(sessionPanel).getByRole('heading', { name: 'Agent session' })).toBeVisible()
    expect(within(sessionPanel).getByRole('heading', { name: 'Overview' })).toBeVisible()
    const runtimeVersion = within(sessionPanel).getByText('0.7.1')
    expect(runtimeVersion.closest('div')).toHaveTextContent('Prime Agent0.7.1')
    expect(within(sessionPanel).getByRole('heading', { name: 'Manage session' })).toBeVisible()
  })

  it.each([
    { residency: 'resident' as const },
    { residency: 'client_owned' as const },
  ])('uses one Working presentation for $residency execution without inventing continuity', async ({ residency }) => {
    render(<App api={createContinuityApi({ taskState: 'running', residency })} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    const continuity = screen.getByRole('region', { name: 'Session status' })

    expect(continuity.querySelector('.session-continuity__label')).toHaveTextContent('Working')
    expect(within(continuity).getAllByText('Preparing the next visible update')).toHaveLength(2)
    expect(continuity).not.toHaveTextContent(/after this window closes|while this client remains attached/i)
  })

  it('focuses and describes an empty composer submission, then clears the error while typing', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 256 })
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    const previewApi = createIdleResidentApi()
    const sendComposer = vi.fn(previewApi.sendComposer.bind(previewApi))
    const api = Object.create(previewApi) as typeof previewApi
    Object.defineProperty(api, 'sendComposer', { configurable: true, value: sendComposer })
    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })

    const composer = screen.getByRole('textbox', { name: 'Task brief' })
    await user.click(screen.getByRole('button', { name: 'Delegate task' }))

    await waitFor(() => expect(composer).toHaveFocus())
    expect(composer).toHaveAttribute('aria-invalid', 'true')
    expect(composer).toHaveAttribute('aria-describedby', 'composer-hint composer-message-error')
    expect(document.querySelector('.composer__connection')).toHaveClass('composer__connection--validation')
    expect(screen.getByRole('button', { name: 'Delegate task' })).toBeEnabled()
    expect(document.getElementById('composer-message-error')).toHaveTextContent('Describe the task before delegating to Prime Agent.')
    expect(sendComposer).not.toHaveBeenCalled()

    await user.type(composer, 'Continue from the latest checkpoint.')
    expect(composer).not.toHaveAttribute('aria-invalid')
    expect(composer).toHaveAttribute('aria-describedby', 'composer-hint composer-status')
    expect(document.getElementById('composer-message-error')).not.toBeInTheDocument()
  })

  it('keeps ordinary prompt keystrokes inside the composer render boundary', async () => {
    const user = userEvent.setup()
    const previewApi = createIdleResidentApi()
    let rootEnvironmentReads = 0
    const api = Object.create(previewApi) as typeof previewApi
    Object.defineProperty(api, 'environment', {
      configurable: true,
      get() {
        rootEnvironmentReads += 1
        return previewApi.environment
      },
    })

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    const composer = screen.getByRole('textbox', { name: 'Task brief' })
    rootEnvironmentReads = 0

    await user.type(composer, 'A bounded task brief')

    expect(composer).toHaveValue('A bounded task brief')
    expect(rootEnvironmentReads).toBe(0)
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
    const composer = screen.getByRole('textbox', { name: 'Task brief' })
    const draft = 'Keep this draft until execution is available.'
    await user.type(composer, draft)
    await user.click(screen.getByRole('button', { name: 'Delegate task' }))

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
    const composer = screen.getByRole('textbox', { name: 'Task brief' })
    const prompt = 'Wait for the resident transcript before showing this prompt.'

    await user.type(composer, prompt)
    await user.click(screen.getByRole('button', { name: 'Delegate task' }))

    await waitFor(() => expect(api.sendComposer).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Starting', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Prompt is awaiting durable host admission' })).toHaveTextContent('Submitting prompt')
    expect(screen.getByRole('form', { name: 'Prime Agent prompt' })).toHaveAttribute('aria-busy', 'true')
    expect(within(transcript).queryByText(prompt)).not.toBeInTheDocument()
    const continuity = screen.getByRole('region', { name: 'Session status' })
    expect(within(continuity).getByText('Starting')).toBeVisible()
    expect(within(continuity).getByText('Delegating the task to Prime Agent.')).toBeVisible()
    expect(continuity.querySelector('.session-continuity__state')).toHaveClass('session-continuity__state--working')
    expect(continuity.querySelector('.session-continuity__state .lucide-arrow-right')).toBeInTheDocument()

    await act(async () => {
      admission.resolve({ state: 'sent', message: 'Sent · durably admitted by host' })
      await admission.promise
    })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Task brief' })).not.toBeInTheDocument())
    expect(screen.getByText('Starting', { selector: '.composer__intent' })).toBeVisible()
    expect(document.querySelector('.composer-wrap')).toHaveClass('composer-wrap--compact')
    expect(within(continuity).getByText('Starting')).toBeVisible()
    expect(within(continuity).getByText('Prime Agent owns the task. Waiting for fresh activity.')).toBeVisible()

    const authoritative = structuredClone(snapshot)
    const selected = authoritative.threads.find((thread) => thread.id === authoritative.selectedThreadId)
    if (!selected) throw new Error('Expected the selected thread fixture')
    selected.status = 'running'
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
    expect(within(continuity).getByText('Working')).toBeVisible()
    expect(within(continuity).queryByText('Starting')).not.toBeInTheDocument()
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
    await user.type(screen.getByRole('textbox', { name: 'Task brief' }), prompt)
    await user.click(screen.getByRole('button', { name: 'Delegate task' }))

    const stop = await screen.findByRole('button', { name: 'Stop the active Prime Agent turn' })
    expect(stop).toBeEnabled()
    expect(stop).toHaveTextContent('Stop')
    expect(screen.getByText('Starting', { selector: '.composer__intent' })).toBeVisible()
    expect(within(screen.getByRole('region', { name: 'Thread transcript' })).queryByText(prompt)).not.toBeInTheDocument()

    await user.click(stop)
    expect(api.abortThread).toHaveBeenCalledOnce()
    expect(api.abortThread).toHaveBeenCalledWith('thread-complete')
    expect(await screen.findByText('Stopping', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.getAllByText('Waiting for authoritative idle proof').some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.queryByRole('button', { name: 'Stop accepted; waiting for authoritative idle proof' })).not.toBeInTheDocument()
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

    expect(await screen.findByText('Stopping', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.queryByText('Ready', { selector: '.composer__intent' })).not.toBeInTheDocument()
    expect(screen.getAllByText('Waiting for authoritative idle proof').some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.queryByRole('button', { name: 'Stop accepted; waiting for authoritative idle proof' })).not.toBeInTheDocument()
    expect(api.abortThread).not.toHaveBeenCalled()
  })

  it.each(['response', 'error'] as const)(
    'keeps an accepted Stop authoritative when an older prompt %s arrives late',
    async (promptOutcome) => {
    const user = userEvent.setup()
    const api = createIdleResidentApi()
    const snapshot = await api.loadWorkbench()
    snapshot.agents = []
    if (snapshot.runtime.session) {
      snapshot.runtime.session.isStreaming = false
      snapshot.runtime.session.isBashRunning = false
      snapshot.runtime.session.isCompacting = false
    }
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
    const composer = screen.getByRole('textbox', { name: 'Task brief' })
    await user.type(composer, 'Start, then stop, this exact resident turn.')
    await user.click(screen.getByRole('button', { name: 'Delegate task' }))
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
    expect(await screen.findByText('Stopping', { selector: '.composer__intent' })).toBeVisible()
    expect(stop).not.toBeInTheDocument()

    const delayedPromptEvent = structuredClone(active)
    delayedPromptEvent.composerReceipt = {
      state: 'sent',
      message: 'Delayed prompt running receipt',
      operation: 'prompt',
    }
    await act(async () => publish?.(delayedPromptEvent))
    expect(screen.getByText('Stopping', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Stop accepted; waiting for authoritative idle proof' })).not.toBeInTheDocument()

    await act(async () => {
      if (promptOutcome === 'response') {
        promptAdmission.resolve({ state: 'sent', message: 'Delayed direct prompt response' })
      } else {
        promptAdmission.reject(new Error('Delayed prompt transport failure'))
      }
      await promptAdmission.promise.catch(() => undefined)
    })
    expect(screen.getByText('Stopping', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Stop accepted; waiting for authoritative idle proof' })).not.toBeInTheDocument()
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
    expect(screen.queryByText('Stopping', { selector: '.composer__intent' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delegate task' })).toBeEnabled()
    if (promptOutcome === 'response') expect(screen.getByRole('textbox', { name: 'Task brief' })).toHaveValue('')
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
      await user.type(screen.getByRole('textbox', { name: 'Task brief' }), 'Fence both late IPC tails.')
      await user.click(screen.getByRole('button', { name: 'Delegate task' }))

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
      expect(screen.getByText('Stopping', { selector: '.composer__intent' })).toBeVisible()
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
      expect(screen.getByRole('button', { name: 'Delegate task' })).toBeEnabled()

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

      expect(screen.getByRole('button', { name: 'Delegate task' })).toBeEnabled()
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
    const firstComposer = screen.getByRole('textbox', { name: 'Task brief' })
    await user.type(firstComposer, 'First thread submission')
    await user.click(screen.getByRole('button', { name: 'Delegate task' }))

    const secondComposer = screen.getByRole('textbox', { name: 'Task brief' })
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

    expect(screen.getByRole('textbox', { name: 'Task brief' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delegate task' })).toBeDisabled()
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

  it('shows only the native runtime-backed model registry and keeps active-turn rows nonactionable', async () => {
    const user = userEvent.setup()
    const api = asNativeFixture(createPreviewRendererApi())
    const loadRuntimeModelCatalog = vi.spyOn(api, 'loadRuntimeModelCatalog')

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const trigger = screen.getByRole('button', { name: /Open models and accounts/ })
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    expect(await within(dialog).findByRole('complementary', { name: 'Accounts on devbox' })).toBeVisible()
    expect(dialog.querySelector('#models-description')).toHaveTextContent('Choose the model for this thread on devbox.')
    expect(within(dialog).queryByText(/illustrative|sample catalog|browser preview/i)).not.toBeInTheDocument()
    expect(loadRuntimeModelCatalog).toHaveBeenCalledWith('host-devbox')
    expect(within(dialog).getByText('2 configured')).toBeVisible()
    expect(within(dialog).getByText('3 support OAuth')).toBeVisible()
    expect(within(dialog).getByText('GPT-5.6 Sol')).toBeVisible()
    expect(within(dialog).getByText('Kimi K3')).toBeVisible()
    expect(within(dialog).getByText('Current')).toBeVisible()
    expect(within(dialog).queryByText('Claude Opus 5')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Use model/i })).not.toBeInTheDocument()
    expect(within(dialog).getByText(/Model selection is available only while this exact resident session is idle/)).toBeVisible()

    const providerToolbar = await within(dialog).findByRole('toolbar', { name: 'Filter models by provider' })
    expect(providerToolbar).toHaveClass('provider-rail__toolbar')
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
    expect(within(dialog).getByText('Sign in with Prime Agent')).toBeVisible()
    expect(within(dialog).getByText('0 available with current setup · 2 listed by the runtime')).toBeVisible()
    expect(within(dialog).getByText('/login')).toBeVisible()
    expect(within(dialog).getByText(/Credentials stay on that computer/)).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Copy setup steps' }))
    expect(await navigator.clipboard.readText()).toBe(
      'In Prime Agent on devbox, run /login, choose Anthropic (Claude Pro/Max), complete sign-in, then return to Prime Continuim and select Refresh accounts.',
    )
    expect(within(dialog).getByRole('button', { name: 'Copied setup steps' })).toBeVisible()
    expect(within(dialog).getByText('Copied provider setup steps.')).toHaveAttribute('role', 'status')
    await user.click(within(dialog).getByRole('button', { name: 'Refresh accounts' }))
    await waitFor(() => expect(loadRuntimeModelCatalog).toHaveBeenCalledTimes(2))
    expect(await within(dialog).findByText('Sign in with Prime Agent')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: /Anthropic \(Claude Pro\/Max\)/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(dialog).getByText('No available models match')).toBeVisible()

    await user.click(within(dialog).getByRole('button', { name: 'All models' }))
    expect(within(dialog).getByText('Claude Opus 5')).toBeVisible()
    expect(within(dialog).getAllByText('Setup required').length).toBeGreaterThan(0)
    expect(dialog.querySelector('.model-list')).not.toHaveAttribute('aria-live')
    const modelResultsStatus = within(dialog).getByText('Showing 2 of 2 models')
    expect(modelResultsStatus).toHaveAttribute('role', 'status')
    expect(modelResultsStatus).toHaveTextContent('Showing 2 of 2 models')
    expect(modelResultsStatus).toHaveAttribute('aria-atomic', 'true')
    expect(modelResultsStatus).not.toHaveAttribute('aria-label')

    await user.click(within(dialog).getByRole('button', { name: 'Close models and accounts' }))
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('connects ChatGPT to the selected Prime Agent runtime and replaces the catalog only after completion proof', async () => {
    const user = userEvent.setup()
    const harness = createModelSelectionHarness({ runtimeOAuth: true })
    const initialCatalog = await harness.api.loadRuntimeModelCatalog('host-devbox')
    const refreshedCatalog = structuredClone(initialCatalog)
    refreshedCatalog.observedAt = '2026-08-07T12:03:00.000Z'
    const refreshedProvider = refreshedCatalog.providers.find((provider) => provider.providerId === 'openai-codex')!
    refreshedProvider.configured = true
    refreshedProvider.authSource = 'stored'
    refreshedProvider.availableModelCount = refreshedProvider.modelCount
    refreshedCatalog.models.forEach((model) => {
      if (model.providerId !== 'openai-codex') return
      model.available = true
      model.usingOAuth = true
    })
    const completion = deferred<{
      state: 'completed'
      message: string
      catalog: RuntimeModelCatalog
    }>()
    let reportProgress: ((progress: { phase: 'awaiting_user'; message: string }) => void) | undefined
    harness.api.startRuntimeOAuth = vi.fn((_request, onProgress) => {
      reportProgress = onProgress as typeof reportProgress
      return completion.promise
    })
    harness.api.cancelRuntimeOAuth = vi.fn(async () => null)

    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: /Open models and accounts/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    await user.click(await within(dialog).findByRole('button', { name: /Browse all \d+ providers/ }))
    await user.click(await within(dialog).findByRole('button', { name: /Anthropic \(Claude Pro\/Max\)/ }))
    expect(within(dialog).queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument()
    await user.click(await within(dialog).findByRole('button', { name: /ChatGPT Plus\/Pro/ }))

    const connectButton = within(dialog).getByRole('button', { name: 'Connect ChatGPT' })
    expect(connectButton).toBeEnabled()
    expect(within(dialog).getByText(/this view never receives the authorization URL or credential/i)).toBeVisible()
    const storageDisclosure = dialog.querySelector('.provider-setup-note__storage')
    expect(storageDisclosure).not.toHaveAttribute('open')
    expect(within(dialog).getByText('Credential storage', { selector: 'summary' })).toBeVisible()
    expect(connectButton.compareDocumentPosition(storageDisclosure!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(storageDisclosure).toHaveTextContent(/Prime Agent 0\.7\.2.*stores OAuth credentials as plaintext.*auth\.json.*operating-system account’s file permissions/i)
    expect(storageDisclosure).toHaveTextContent(/Account availability is refreshed before model selection.*not keychain or keyring storage/i)
    expect(within(dialog).queryByText(/new resident session|restart/i)).not.toBeInTheDocument()

    await user.click(connectButton)
    expect(harness.api.startRuntimeOAuth).toHaveBeenCalledWith({
      hostId: 'host-devbox',
      providerId: 'openai-codex',
    }, expect.any(Function))
    expect(within(dialog).getByText(/Opening the verified ChatGPT sign-in page/)).toHaveAttribute('role', 'status')
    expect(within(dialog).getByRole('button', { name: 'Cancel sign-in' })).toBeEnabled()

    act(() => reportProgress?.({
      phase: 'awaiting_user',
      message: 'Finish signing in in your browser. This window will update automatically.',
    }))
    expect(within(dialog).getByText(/Finish signing in in your browser/)).toHaveAttribute('role', 'status')

    await act(async () => {
      completion.resolve({
        state: 'completed',
        message: 'ChatGPT is connected to Prime Agent and the model catalog is refreshed.',
        catalog: refreshedCatalog,
      })
      await completion.promise
    })
    expect(within(dialog).getByText(/connected to Prime Agent.*catalog is refreshed/i)).toHaveAttribute('role', 'status')
    expect(within(dialog).queryByRole('button', { name: 'Connect ChatGPT' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /ChatGPT Plus\/Pro/ })).toHaveTextContent('Configured')
    expect(within(dialog).getByText('RLM recommended')).toBeVisible()
  })

  it('opens an unconfigured first-run catalog directly on the supported ChatGPT setup path', async () => {
    const user = userEvent.setup()
    const harness = createModelSelectionHarness({ runtimeOAuth: true })
    const loadRuntimeModelCatalog = harness.api.loadRuntimeModelCatalog.bind(harness.api)
    harness.api.loadRuntimeModelCatalog = vi.fn(async (hostId) => {
      const catalog = await loadRuntimeModelCatalog(hostId)
      const chatGptProvider = catalog.providers.find((provider) => provider.providerId === 'openai-codex')!
      chatGptProvider.configured = false
      chatGptProvider.authSource = 'none'
      chatGptProvider.availableModelCount = 0
      catalog.models.forEach((model) => {
        if (model.providerId === 'openai-codex') {
          model.available = false
          model.usingOAuth = false
        }
      })
      return catalog
    })

    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: /Open models and accounts/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    await within(dialog).findByText('ChatGPT setup recommended')
    expect(within(dialog).queryByRole('toolbar', { name: 'Filter models by provider' })).not.toBeInTheDocument()
    expect(within(dialog).getByText('ChatGPT setup recommended')).toBeVisible()
    expect(within(dialog).getByText(/Set up GPT-5.6 Sol for native RLM/)).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Connect ChatGPT' })).toBeEnabled()
    expect(within(dialog).queryByText('No available models match')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('searchbox', { name: 'Search models' })).not.toBeInTheDocument()

    const browseProviders = within(dialog).getByRole('button', { name: /Browse all \d+ providers/ })
    expect(browseProviders).toHaveAttribute('aria-expanded', 'false')
    await user.click(browseProviders)
    expect(browseProviders).toHaveAttribute('aria-expanded', 'true')
    const providerToolbar = within(dialog).getByRole('toolbar', { name: 'Filter models by provider' })
    const chatGptProvider = within(providerToolbar).getByRole('button', { name: /ChatGPT Plus\/Pro/ })
    expect(chatGptProvider).toHaveAttribute('aria-pressed', 'true')
    expect(chatGptProvider).toHaveAttribute('tabindex', '0')
    expect(within(providerToolbar).getByRole('button', { name: /All providers/ })).toBeVisible()
    expect(within(providerToolbar).getByRole('button', { name: /Anthropic/ })).toBeVisible()
  })

  it('keeps a host-scoped Prime Agent sign-in visible and cancellable when the selected resident thread changes', async () => {
    const user = userEvent.setup()
    const harness = createModelSelectionHarness({ runtimeOAuth: true })
    const completion = deferred<{ state: 'cancelled'; message: string }>()
    harness.api.startRuntimeOAuth = vi.fn(() => completion.promise)
    harness.api.cancelRuntimeOAuth = vi.fn((_request) => {
      completion.resolve({ state: 'cancelled', message: 'ChatGPT sign-in was cancelled.' })
      return completion.promise
    })

    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: /Open models and accounts/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    await user.click(await within(dialog).findByRole('button', { name: 'Connect ChatGPT' }))

    expect(within(dialog).getByText(/Opening the verified ChatGPT sign-in page/)).toHaveAttribute('role', 'status')
    expect(within(dialog).getByRole('button', { name: 'Cancel sign-in' })).toBeEnabled()

    await act(async () => {
      harness.publish((snapshot) => {
        const nextThread = snapshot.threads.find((thread) => thread.id === 'thread-complete')
        if (!nextThread) throw new Error('Expected the second resident thread fixture')
        snapshot.selectedThreadId = nextThread.id
        snapshot.selectedProjectId = nextThread.projectId
      })
    })

    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    expect(within(dialog).getByText(/Opening the verified ChatGPT sign-in page/)).toHaveAttribute('role', 'status')
    expect(within(dialog).getByRole('button', { name: 'Cancel sign-in' })).toBeEnabled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel sign-in' }))
    await waitFor(() => expect(within(dialog).getByText('ChatGPT sign-in was cancelled.')).toHaveAttribute('role', 'status'))
    expect(harness.api.startRuntimeOAuth).toHaveBeenCalledTimes(1)
    expect(harness.api.cancelRuntimeOAuth).toHaveBeenCalledWith({
      hostId: 'host-devbox',
      providerId: 'openai-codex',
    })
  })

  it('uses the exact OAuth cancellation for both Cancel sign-in and closing Models & accounts', async () => {
    const user = userEvent.setup()
    const harness = createModelSelectionHarness({ runtimeOAuth: true })
    const first = deferred<{ state: 'cancelled'; message: string }>()
    const second = deferred<{ state: 'cancelled'; message: string }>()
    harness.api.startRuntimeOAuth = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    let cancellationCount = 0
    harness.api.cancelRuntimeOAuth = vi.fn((_request) => {
      cancellationCount += 1
      const target = cancellationCount === 1 ? first : second
      target.resolve({ state: 'cancelled', message: 'ChatGPT sign-in was cancelled.' })
      return target.promise
    })

    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const trigger = screen.getByRole('button', { name: /Open models and accounts/ })
    await user.click(trigger)
    let dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    await user.click(await within(dialog).findByRole('button', { name: 'Connect ChatGPT' }))
    await user.click(within(dialog).getByRole('button', { name: 'Cancel sign-in' }))

    await waitFor(() => expect(within(dialog).getByText('ChatGPT sign-in was cancelled.')).toHaveAttribute('role', 'status'))
    expect(harness.api.cancelRuntimeOAuth).toHaveBeenNthCalledWith(1, {
      hostId: 'host-devbox',
      providerId: 'openai-codex',
    })
    expect(within(dialog).getByRole('button', { name: 'Connect ChatGPT' })).toBeEnabled()

    await user.click(within(dialog).getByRole('button', { name: 'Connect ChatGPT' }))
    await user.click(within(dialog).getByRole('button', { name: 'Close models and accounts' }))
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(harness.api.cancelRuntimeOAuth).toHaveBeenNthCalledWith(2, {
      hostId: 'host-devbox',
      providerId: 'openai-codex',
    })
    expect(harness.api.startRuntimeOAuth).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog', { name: 'Models & accounts' })).not.toBeInTheDocument()

    await user.click(trigger)
    dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    expect(await within(dialog).findByRole('button', { name: 'Connect ChatGPT' })).toBeEnabled()
    expect(dialog.querySelector('.runtime-oauth-feedback__message--error')).toHaveTextContent('')
  })

  it('turns completed host model proof into one clear Done action while awaiting the current-model projection', async () => {
    const user = userEvent.setup()
    const harness = createModelSelectionHarness()
    const completion = deferred<{
      state: 'completed'
      projected: false
      message: string
    }>()
    harness.api.selectResidentModel = vi.fn(() => completion.promise)

    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: /Open models and accounts/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    await within(dialog).findByText('GPT-5.6 Terra')
    const feedback = dialog.querySelector<HTMLElement>('.model-selection-feedback')
    expect(feedback).not.toBeNull()

    const currentRow = within(dialog).getByText('GPT-5.6 Sol').closest('article')
    const targetRow = within(dialog).getByText('GPT-5.6 Terra').closest('article')
    expect(currentRow).not.toBeNull()
    expect(targetRow).not.toBeNull()
    expect(within(currentRow as HTMLElement).getByText('Current')).toBeVisible()
    expect(within(currentRow as HTMLElement).queryByRole('button', { name: /Use model/ })).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'All models' }))
    const unavailableRow = within(dialog).getByText('Claude Opus 5').closest('article')
    expect(unavailableRow).not.toBeNull()
    expect(within(unavailableRow as HTMLElement).getByText('Setup required')).toBeVisible()
    expect(within(unavailableRow as HTMLElement).queryByRole('button', { name: /Use model/ })).not.toBeInTheDocument()

    const useTerra = within(targetRow as HTMLElement).getByRole('button', { name: 'Use model GPT-5.6 Terra' })
    await user.click(useTerra)
    expect(harness.api.selectResidentModel).toHaveBeenCalledWith({
      threadId: 'thread-seamless',
      providerId: 'openai-codex',
      modelId: 'gpt-5.6-terra',
    })
    expect(within(feedback as HTMLElement).getByRole('status')).toHaveTextContent(
      /Selecting GPT-5\.6 Terra for this thread's next prompt/,
    )
    within(dialog).getAllByRole('button', { name: /model (GPT|Kimi|DeepSeek|Qwen|GLM|MiniMax)/i })
      .forEach((button) => expect(button).toBeDisabled())

    await act(async () => {
      completion.resolve({
        state: 'completed',
        projected: false,
        message: 'Prime Agent completed this model change, but the current thread display has not refreshed yet.',
      })
      await completion.promise
    })
    expect(within(feedback as HTMLElement).getByRole('status')).toHaveTextContent(
      /GPT-5\.6 Terra is selected on Prime Agent.*next thread refresh.*will not resend/i,
    )
    expect(within(targetRow as HTMLElement).queryByText('Current')).not.toBeInTheDocument()
    expect(within(targetRow as HTMLElement).getByText('Selected on host')).toBeVisible()
    expect(within(targetRow as HTMLElement).queryByRole('button', { name: /GPT-5\.6 Terra/ })).not.toBeInTheDocument()
    expect(within(feedback as HTMLElement).getByRole('button', { name: 'Done' })).toBeEnabled()

    act(() => harness.publishCurrentModel('openai-codex/gpt-5.6-terra'))
    await waitFor(() => expect(within(targetRow as HTMLElement).getByText('Current')).toBeVisible())
    expect(within(feedback as HTMLElement).getByRole('status')).toHaveTextContent(
      /GPT-5\.6 Terra is now shown as current for this thread/,
    )
    expect(within(feedback as HTMLElement).queryByRole('button', { name: 'Done' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Use model GPT-5.6 Luna' })).toBeEnabled()
    expect(within(dialog).getByText(/changes the resident session only; it does not send a prompt/i)).toBeVisible()
  })

  it('closes a host-completed model selection without waiting indefinitely for a label refresh', async () => {
    const user = userEvent.setup()
    const harness = createModelSelectionHarness()
    harness.api.selectResidentModel = vi.fn(async () => ({
      state: 'completed' as const,
      projected: false,
      message: 'Prime Agent selected this model.',
    }))

    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const trigger = screen.getByRole('button', { name: /Open models and accounts/ })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    await user.click(await within(dialog).findByRole('button', { name: 'Use model GPT-5.6 Terra' }))
    const done = await within(dialog).findByRole('button', { name: 'Done' })

    expect(done).toBeEnabled()
    expect(done).toHaveFocus()
    expect(within(dialog).getByText('Selected on host')).toBeVisible()
    await user.click(done)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Models & accounts' })).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('surfaces definitive rejection and permits only an explicitly retryable selection', async () => {
    const user = userEvent.setup()
    const harness = createModelSelectionHarness()
    harness.api.selectResidentModel = vi.fn()
      .mockResolvedValueOnce({ state: 'rejected', retryable: true, message: 'Prime Agent rejected this model change.' })
      .mockResolvedValueOnce({ state: 'rejected', retryable: false, message: 'This model is no longer selectable.' })

    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: /Open models and accounts/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    const useTerra = await within(dialog).findByRole('button', { name: 'Use model GPT-5.6 Terra' })
    const feedback = dialog.querySelector<HTMLElement>('.model-selection-feedback')
    expect(feedback).not.toBeNull()

    await user.click(useTerra)
    expect(within(feedback as HTMLElement).getByRole('alert')).toHaveTextContent(
      /No model change was applied.*You can choose a model again/,
    )
    expect(useTerra).toBeEnabled()

    await user.click(useTerra)
    expect(within(feedback as HTMLElement).getByRole('alert')).toHaveTextContent(
      /No model change was applied.*cannot be retried/,
    )
    expect(useTerra).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Use model GPT-5.6 Luna' })).toBeEnabled()
    expect(harness.api.selectResidentModel).toHaveBeenCalledTimes(2)
  })

  it('locks uncertain model changes without replaying them', async () => {
    const user = userEvent.setup()
    const harness = createModelSelectionHarness()
    const outcome = deferred<{
      state: 'uncertain'
      retryable: false
      message: string
    }>()
    harness.api.selectResidentModel = vi.fn(() => outcome.promise)

    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: /Open models and accounts/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    const useTerra = await within(dialog).findByRole('button', { name: 'Use model GPT-5.6 Terra' })
    const feedback = dialog.querySelector<HTMLElement>('.model-selection-feedback')
    expect(feedback).not.toBeNull()
    await user.click(useTerra)
    expect(within(dialog).getByRole('button', { name: 'Use model GPT-5.6 Luna' })).toBeDisabled()

    await act(async () => {
      outcome.resolve({
        state: 'uncertain',
        retryable: false,
        message: 'The host response ended before terminal proof arrived.',
      })
      await outcome.promise
    })
    expect(within(feedback as HTMLElement).getByRole('alert')).toHaveTextContent(
      /outcome is unknown.*will not send this model change again automatically.*Do not retry it from this dialog/i,
    )
    within(dialog).getAllByRole('button', { name: /Use model/ }).forEach((button) => expect(button).toBeDisabled())
    await user.click(within(dialog).getByRole('button', { name: 'Use model GPT-5.6 Luna' }))
    expect(harness.api.selectResidentModel).toHaveBeenCalledOnce()
  })

  it('discards late model-selection results after authority changes or dialog closure', async () => {
    const user = userEvent.setup()
    const harness = createModelSelectionHarness()
    const staleAuthorityOutcome = deferred<{
      state: 'rejected'
      retryable: true
      message: string
    }>()
    const closedDialogOutcome = deferred<{
      state: 'uncertain'
      retryable: false
      message: string
    }>()
    harness.api.selectResidentModel = vi.fn()
      .mockReturnValueOnce(staleAuthorityOutcome.promise)
      .mockReturnValueOnce(closedDialogOutcome.promise)

    render(<App api={harness.api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const trigger = screen.getByRole('button', { name: /Open models and accounts/ })
    await user.click(trigger)
    let dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    const firstUseTerra = await within(dialog).findByRole('button', { name: 'Use model GPT-5.6 Terra' })
    let feedback = dialog.querySelector<HTMLElement>('.model-selection-feedback')
    expect(feedback).not.toBeNull()
    await user.click(firstUseTerra)

    act(() => harness.publish((snapshot) => {
      const selectedThread = snapshot.threads.find((thread) => thread.id === snapshot.selectedThreadId)
      if (!selectedThread) throw new Error('Expected the selected model-selection thread')
      selectedThread.executionGenerationId = 'generation-model-selection-two'
    }))
    await act(async () => {
      staleAuthorityOutcome.resolve({ state: 'rejected', retryable: true, message: 'This late result must not render.' })
      await staleAuthorityOutcome.promise
    })
    expect(within(feedback as HTMLElement).getByRole('alert')).toHaveTextContent('')
    expect(within(dialog).getByRole('button', { name: 'Use model GPT-5.6 Terra' })).toBeEnabled()

    await user.click(within(dialog).getByRole('button', { name: 'Use model GPT-5.6 Terra' }))
    await user.click(within(dialog).getByRole('button', { name: 'Close models and accounts' }))
    await act(async () => {
      closedDialogOutcome.resolve({ state: 'uncertain', retryable: false, message: 'This closed result must not render.' })
      await closedDialogOutcome.promise
    })
    await user.click(trigger)
    dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    const reopenedUseTerra = await within(dialog).findByRole('button', { name: 'Use model GPT-5.6 Terra' })
    feedback = dialog.querySelector<HTMLElement>('.model-selection-feedback')
    expect(feedback).not.toBeNull()
    expect(reopenedUseTerra).toBeEnabled()
    expect(within(feedback as HTMLElement).getByRole('alert')).toHaveTextContent('')
    expect(harness.api.selectResidentModel).toHaveBeenCalledTimes(2)
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
    await user.click(screen.getByRole('tab', { name: 'Session' }))
    const runtimePanel = screen.getByRole('tabpanel', { name: 'Session' })

    expect(within(runtimePanel).getByText('Current thread · runtime not reported')).toBeVisible()
    expect(within(runtimePanel).getByText('Child activity isn’t reported.')).toBeVisible()
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
      await user.click(screen.getByRole('tab', { name: 'Session' }))
      const runtimePanel = screen.getByRole('tabpanel', { name: 'Session' })

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
    await user.click(screen.getByRole('tab', { name: 'Session' }))
    const runtimePanel = screen.getByRole('tabpanel', { name: 'Session' })

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

    const review = screen.getByRole('tab', { name: 'Review' })
    review.focus()
    await user.keyboard('{ArrowRight}')

    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
    const runtimePanel = screen.getByRole('tabpanel', { name: 'Session' })
    expect(within(runtimePanel).getByRole('heading', { name: 'Agent session' })).toBeVisible()
    expect(within(runtimePanel).getByText('Implement the seamless remote workbench')).toBeVisible()
    expect(within(runtimePanel).getByText('Review overnight verification')).toBeVisible()
    expect(within(runtimePanel).getByRole('heading', { name: 'RLM delegation' })).toBeVisible()
    expect(within(runtimePanel).getByText(/delegates focused work, then folds results/i)).toBeVisible()
    expect(within(runtimePanel).getByText('Coordinator · main session')).toBeVisible()
    expect(within(runtimePanel).getAllByText('via Workbench lead')).toHaveLength(2)
    const rlmSummary = within(runtimePanel).getByLabelText('RLM activity summary')
    expect(within(rlmSummary).getByText('2')).toBeVisible()
    expect(within(rlmSummary).getByText('1')).toBeVisible()
    expect(within(runtimePanel).getByText('Returned')).toBeVisible()
    const returnedResult = within(runtimePanel).getByText('View result')
    expect(returnedResult).toBeVisible()
    await user.click(returnedResult)
    expect(within(runtimePanel).getByText(/snapshot boundary is generation-fenced/i)).toBeVisible()
    const agentRows = runtimePanel.querySelectorAll<HTMLElement>('[data-runtime-agent]')
    expect(agentRows[0]).toHaveAttribute('data-rlm-depth', '0')
    expect(agentRows[1]).toHaveAttribute('data-rlm-depth', '1')
    expect(agentRows[1]?.style.getPropertyValue('--rlm-depth')).toBe('1')
    expect(within(runtimePanel).getByText(/18 tool uses/)).toBeVisible()
    expect(within(runtimePanel).getByText('Continuity')).toBeVisible()
    expect(within(runtimePanel).getByText('Last reported · runs after app closes')).toBeVisible()
    expect(within(runtimePanel).getByRole('heading', { name: 'Capabilities' })).toBeVisible()
    expect(within(runtimePanel).getByText('playwright-cli')).toBeVisible()
    expect(within(runtimePanel).getByText('Ready · clean session')).toBeVisible()
    expect(within(runtimePanel).getByText(/live isolated launch probe/i)).toBeVisible()
  })

  it('explains that unavailable browser readiness recovers without blocking the resident session', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.runtime.browserExecution = { readiness: 'unavailable' }
      return snapshot
    }

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    await user.click(screen.getByRole('tab', { name: 'Session' }))

    const runtimePanel = screen.getByRole('tabpanel', { name: 'Session' })
    expect(within(runtimePanel).getByText('Unavailable · recovering safely')).toBeVisible()
    expect(within(runtimePanel).getByText(/Readiness retries in the background/i)).toBeVisible()
  })

  it('skips closed inspector list work until the panel opens', async () => {
    const user = userEvent.setup()
    const api = createIdleResidentApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    let evidenceListReads = 0
    api.loadWorkbench = vi.fn(async () => {
      const snapshot = await loadWorkbench()
      const evidence = snapshot.evidence
      Object.defineProperty(snapshot, 'evidence', {
        configurable: true,
        get: () => {
          evidenceListReads += 1
          return evidence
        },
      })
      return snapshot
    })

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    const initialReads = evidenceListReads
    expect(initialReads).toBeGreaterThan(0)

    await user.type(screen.getByRole('textbox', { name: 'Task brief' }), 'Keep typing responsive.')
    expect(evidenceListReads).toBe(initialReads)

    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    expect(evidenceListReads).toBeGreaterThan(initialReads)
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
    await user.click(screen.getByRole('tab', { name: 'Session' }))
    const runtimePanel = screen.getByRole('tabpanel', { name: 'Session' })

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
    const reviewPanel = screen.getByRole('tabpanel', { name: 'Review' })
    expect(within(reviewPanel).queryByRole('button')).not.toBeInTheDocument()
    expect(within(reviewPanel).getByRole('region', { name: 'Latest result' })).toBeVisible()
    expect(within(reviewPanel).getByText('Not reported')).toBeVisible()
    expect(within(reviewPanel).queryByText('Working')).not.toBeInTheDocument()
    expect(within(reviewPanel).getByText('6')).toBeVisible()
    expect(within(reviewPanel).queryByText('App.tsx')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Session' }))
    expect(within(screen.getByRole('tabpanel', { name: 'Session' })).queryByRole('button')).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    expect(within(screen.getByRole('tabpanel', { name: 'Evidence' })).queryByRole('button', { name: 'Run checks' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Training runs/ }))
    await user.click(screen.getByRole('tab', { name: 'Context' }))
    const contextPanel = screen.getByRole('tabpanel', { name: 'Context' })
    expect(within(contextPanel).getByText(/Offline · Last synchronized 18 min ago/)).toBeVisible()
    expect(within(contextPanel).queryByText('Running')).not.toBeInTheDocument()
  })

  it('reviews only an exact terminal assistant outcome and labels cached authority', async () => {
    const user = userEvent.setup()
    const api: RendererApi = asNativeFixture(createPreviewRendererApi())
    const snapshot = structuredClone(previewSnapshot)
    const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)!
    const terminalBlock = thread.transcript.find((block) => block.id === 'block-5')!
    thread.status = 'idle'
    snapshot.runtime.session = {
      ...snapshot.runtime.session!,
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      queuedActionCount: 0,
      activeToolNames: [],
    }
    snapshot.agents = []
    snapshot.runtime.agentsReported = true
    snapshot.latestTurnOutcome = {
      outcomeVersion: 1,
      commandId: 'command-review-one',
      receiptId: 'receipt-review-one',
      observedAt: '2026-08-07T13:49:00.000Z',
      observedCursor: {
        threadId: thread.id,
        executionGenerationId: 'generation-review-one',
        generation: 'generation-review-one',
        sequence: 5,
      },
      terminalAssistant: { blockId: terminalBlock.id, stopReason: 'stop' },
    }
    snapshot.snapshotAuthority = {
      source: 'cached',
      generatedAt: '2026-08-07T13:49:01.000Z',
      cursor: { ...snapshot.latestTurnOutcome.observedCursor },
    }
    snapshot.gitSummary = {
      stagedFiles: 1,
      unstagedFiles: 2,
      untrackedFiles: 1,
      changedFileCount: 4,
      knownDetail: false,
    }
    api.loadWorkbench = vi.fn(async () => structuredClone(snapshot))
    api.subscribe = vi.fn(() => () => undefined)

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))

    const review = within(screen.getByRole('tabpanel', { name: 'Review' }))
    expect(review.getByText('Last reported · Ready to review')).toBeVisible()
    expect(review.getByText(terminalBlock.body)).toBeVisible()
    expect(review.getByText('4')).toBeVisible()
    expect(review.getByText('Current snapshot proof')).toBeVisible()
    expect(review.getByText('Visual-QA type check')).toBeVisible()
    expect(review.queryByText('Complete')).not.toBeInTheDocument()
  })

  it('does not attach a newer projection’s goals, branches, usage, or fixture proof to an older turn', async () => {
    const user = userEvent.setup()
    const api: RendererApi = createPreviewRendererApi()
    const snapshot = structuredClone(previewSnapshot)
    const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)!
    const terminalBlock = thread.transcript.find((block) => block.id === 'block-5')!
    thread.status = 'idle'
    snapshot.runtime.session = {
      ...snapshot.runtime.session!,
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      queuedActionCount: 0,
      activeToolNames: [],
    }
    snapshot.runtime.goals = [{
      id: 'newer-goal',
      objective: 'A later task that must not decorate the reviewed turn',
      state: 'complete',
      tokensUsed: 42_000,
      timeUsedSeconds: 90,
    }]
    snapshot.agents = [{
      id: 'newer-child',
      name: 'Later branch',
      role: 'Unrelated later work',
      status: 'complete',
      hostName: 'This computer',
      answerPreview: 'This belongs to a later projection.',
    }]
    snapshot.runtime.agentsReported = true
    snapshot.latestTurnOutcome = {
      outcomeVersion: 1,
      commandId: 'command-review-older',
      receiptId: 'receipt-review-older',
      observedAt: '2026-08-07T13:49:00.000Z',
      observedCursor: {
        threadId: thread.id,
        executionGenerationId: 'generation-review-one',
        generation: 'generation-review-one',
        sequence: 5,
      },
      terminalAssistant: { blockId: terminalBlock.id, stopReason: 'stop' },
    }
    snapshot.snapshotAuthority = {
      source: 'live',
      generatedAt: '2026-08-07T13:50:00.000Z',
      cursor: {
        ...snapshot.latestTurnOutcome.observedCursor,
        sequence: 6,
      },
    }
    snapshot.gitSummary = {
      stagedFiles: 1,
      unstagedFiles: 2,
      untrackedFiles: 1,
      changedFileCount: 4,
      knownDetail: false,
    }
    api.loadWorkbench = vi.fn(async () => structuredClone(snapshot))
    api.subscribe = vi.fn(() => () => undefined)

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))

    const review = within(screen.getByRole('tabpanel', { name: 'Review' }))
    expect(review.getByText('Ready to review')).toBeVisible()
    expect(review.getByText(terminalBlock.body)).toBeVisible()
    expect(review.getAllByText('—')).toHaveLength(4)
    expect(review.queryByText('A later task that must not decorate the reviewed turn')).not.toBeInTheDocument()
    expect(review.queryByText('This belongs to a later projection.')).not.toBeInTheDocument()
    expect(review.queryByText('Complete')).not.toBeInTheDocument()
  })

  it('withholds candidate evaluation until fresh exact preflight and restores focus when Escape cancels review', async () => {
    const user = userEvent.setup()
    const harness = createCandidateEvaluationHarness()
    const preflight = deferred<CandidateEvaluationPreflight>()
    harness.api.candidateEvaluationPreflight = vi.fn(() => preflight.promise)
    render(<App api={harness.api} />)

    await screen.findByRole('heading', { name: 'Frame protocol boundaries' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    expect(screen.queryByRole('button', { name: 'Evaluate candidate' })).not.toBeInTheDocument()

    await act(async () => preflight.resolve(structuredClone(harness.ready)))
    const trigger = await screen.findByRole('button', { name: 'Evaluate candidate' })
    expect(screen.getByText(/Passive launcher\/workspace review fingerprint ready · this is not the canonical candidate/i)).toBeVisible()
    expect(screen.getByText('Passive fingerprint')).toBeVisible()
    expect(screen.queryByText(/Includes uncommitted bytes|334 files/i)).not.toBeInTheDocument()
    trigger.focus()
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Evaluate this candidate?' })
    expect(within(dialog).getByText(/capture the canonical candidate and toolchain inside the consented self-build evaluation/i)).toBeVisible()
    expect(within(dialog).getByText(/Candidate scripts run with your user permissions/i)).toBeVisible()
    expect(within(dialog).getByText(/copied worktree does not isolate the main filesystem/i)).toBeVisible()

    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }))
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'))
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(harness.api.startCandidateEvaluation).not.toHaveBeenCalled()
  })

  it('clears an unused envelope when the pre-start read-only recheck fails and permits a fresh review', async () => {
    const user = userEvent.setup()
    const harness = createCandidateEvaluationHarness()
    const basePreflight = harness.api.candidateEvaluationPreflight!.bind(harness.api)
    let preflightCall = 0
    harness.api.candidateEvaluationPreflight = vi.fn((input) => {
      preflightCall += 1
      if (preflightCall === 2) return Promise.reject(new Error('Fresh preflight connection lost'))
      return basePreflight(input)
    })
    render(<App api={harness.api} />)

    await screen.findByRole('heading', { name: 'Frame protocol boundaries' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    await user.click(await screen.findByRole('button', { name: 'Evaluate candidate' }))
    let dialog = await screen.findByRole('dialog', { name: 'Evaluate this candidate?' })
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Run evaluation' }))

    expect(await within(dialog).findByText('Fresh preflight connection lost')).toBeVisible()
    expect(harness.api.startCandidateEvaluation).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    const retryTrigger = await screen.findByRole('button', { name: 'Evaluate candidate' })
    await user.click(retryTrigger)
    dialog = await screen.findByRole('dialog', { name: 'Evaluate this candidate?' })
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Run evaluation' }))

    await waitFor(() => expect(harness.api.startCandidateEvaluation).toHaveBeenCalledOnce())
    expect(harness.api.candidateEvaluationSnapshot).toHaveBeenCalledTimes(3)
  })

  it('reconciles a lost start acknowledgement by the one minted operation without invoking it again', async () => {
    const user = userEvent.setup()
    const harness = createCandidateEvaluationHarness()
    let invokedEnvelope: CandidateEvaluationStartRequest | undefined
    harness.api.startCandidateEvaluation = vi.fn(async (input) => {
      invokedEnvelope = input
      throw new Error('Start acknowledgement lost')
    })
    const baseSnapshot = harness.api.candidateEvaluationSnapshot!.bind(harness.api)
    let snapshotCall = 0
    harness.api.candidateEvaluationSnapshot = vi.fn(async (input) => {
      snapshotCall += 1
      if (snapshotCall < 3 || !invokedEnvelope) return baseSnapshot(input)
      const running: CandidateEvaluationStatus = {
        statusVersion: 1,
        expectedHostId: invokedEnvelope.expectedHostId,
        threadId: invokedEnvelope.threadId,
        expectedExecutionGenerationId: invokedEnvelope.expectedExecutionGenerationId,
        operationId: invokedEnvelope.operationId,
        kind: invokedEnvelope.kind,
        requestedAt: invokedEnvelope.requestedAt,
        updatedAt: '2026-08-09T12:00:20.000Z',
        status: 'running',
        review: invokedEnvelope.expectedReview,
        invocationStartedAt: '2026-08-09T12:00:10.000Z',
        boundary: candidateEvaluationBoundary,
      }
      return {
        snapshotVersion: 1,
        ...harness.authority,
        generatedAt: '2026-08-09T12:00:21.000Z',
        repeatEffectsWarningRequired: false,
        evaluations: [running],
      }
    })
    render(<App api={harness.api} />)

    await screen.findByRole('heading', { name: 'Frame protocol boundaries' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    await user.click(await screen.findByRole('button', { name: 'Evaluate candidate' }))
    const dialog = await screen.findByRole('dialog', { name: 'Evaluate this candidate?' })
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Run evaluation' }))

    expect(await screen.findByText(/start acknowledgement is unavailable/i)).toBeVisible()
    await waitFor(() => expect(harness.api.candidateEvaluationSnapshot).toHaveBeenCalledTimes(3), { timeout: 3_000 })
    expect(invokedEnvelope).toBeDefined()
    expect(screen.getByText(invokedEnvelope!.operationId)).toBeVisible()
    expect(harness.api.startCandidateEvaluation).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Evaluate candidate' })).not.toBeInTheDocument()
  })

  it('clears the pending envelope after a definitive pre-admission host rejection', async () => {
    const user = userEvent.setup()
    const harness = createCandidateEvaluationHarness()
    harness.api.startCandidateEvaluation = vi.fn(async () => {
      throw Object.assign(new Error('Another evaluation is already active.'), {
        code: 'host.evaluation_busy',
      })
    })
    render(<App api={harness.api} />)

    await screen.findByRole('heading', { name: 'Frame protocol boundaries' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    await user.click(await screen.findByRole('button', { name: 'Evaluate candidate' }))
    const dialog = await screen.findByRole('dialog', { name: 'Evaluate this candidate?' })
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Run evaluation' }))

    expect(await within(dialog).findByText('Another evaluation is already active.')).toBeVisible()
    expect(screen.getByText('The evaluation was rejected before admission. No operation was started.')).toBeVisible()
    expect(screen.queryByText(/start acknowledgement is unavailable/i)).not.toBeInTheDocument()
    expect(harness.api.startCandidateEvaluation).toHaveBeenCalledTimes(1)
    expect(harness.api.candidateEvaluationSnapshot).toHaveBeenCalledTimes(2)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('button', { name: 'Evaluate candidate' })).toBeVisible()
  })

  it('keeps an unresolved uncertain invocation behind the host-wide preflight barrier', async () => {
    const user = userEvent.setup()
    const harness = createCandidateEvaluationHarness([candidateEvaluationUncertain])
    harness.api.candidateEvaluationPreflight = vi.fn(async () => ({
      preflightVersion: 1,
      ...harness.authority,
      observedAt: '2026-08-09T12:02:00.000Z',
      boundary: candidateEvaluationBoundary,
      status: 'unavailable' as const,
      code: 'EVALUATION_OUTCOME_UNKNOWN' as const,
      message: 'The prior invocation has not been proven retired.',
      retryable: false,
    }))
    render(<App api={harness.api} />)

    await screen.findByRole('heading', { name: 'Frame protocol boundaries' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))

    expect(await screen.findByText(/EVALUATION_OUTCOME_UNKNOWN · The prior invocation has not been proven retired/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Evaluate candidate' })).not.toBeInTheDocument()
    expect(harness.api.startCandidateEvaluation).not.toHaveBeenCalled()
  })

  it('uses the authority hazard when an uncertain record is hidden beyond the 32 returned evaluations', async () => {
    const user = userEvent.setup()
    const visibleHistory = Array.from({ length: 32 }, (_, index): CandidateEvaluationStatus => ({
      statusVersion: 1,
      expectedHostId: 'host-local',
      threadId: 'thread-protocol',
      expectedExecutionGenerationId: 'candidate-generation-one',
      operationId: `candidate-evaluation:visible-failure-${index}`,
      kind: 'prime_continuim_self_build_v1',
      requestedAt: '2026-08-09T11:59:00.000Z',
      updatedAt: `2026-08-09T12:00:${String(index).padStart(2, '0')}.000Z`,
      completedAt: `2026-08-09T12:00:${String(index).padStart(2, '0')}.000Z`,
      status: 'failed',
      review: candidateEvaluationReview,
      boundary: candidateEvaluationBoundary,
      error: {
        code: 'EVALUATION_FAILED',
        message: 'Visible settled failure.',
        retryable: true,
      },
    }))
    expect(visibleHistory).toHaveLength(32)
    expect(visibleHistory.some((evaluation) => evaluation.status === 'uncertain')).toBe(false)
    const harness = createCandidateEvaluationHarness(visibleHistory, true)
    render(<App api={harness.api} />)

    await screen.findByRole('heading', { name: 'Frame protocol boundaries' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    await user.click(await screen.findByRole('button', { name: 'Evaluate candidate' }))

    const dialog = await screen.findByRole('dialog', { name: 'Evaluate this candidate?' })
    expect(within(dialog).getByText(/previous outcome is unknown/i)).toBeVisible()
    expect(within(dialog).getByText(/may repeat candidate-script effects/i)).toBeVisible()
  })

  it('requires stronger re-consent when the authority hazard appears during the submit recheck', async () => {
    const user = userEvent.setup()
    const harness = createCandidateEvaluationHarness()
    const baseSnapshot = harness.api.candidateEvaluationSnapshot!.bind(harness.api)
    let snapshotCall = 0
    harness.api.candidateEvaluationSnapshot = vi.fn(async (input) => {
      const result = await baseSnapshot(input)
      snapshotCall += 1
      return snapshotCall >= 2
        ? { ...result, repeatEffectsWarningRequired: true }
        : result
    })
    render(<App api={harness.api} />)

    await screen.findByRole('heading', { name: 'Frame protocol boundaries' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    await user.click(await screen.findByRole('button', { name: 'Evaluate candidate' }))
    const dialog = await screen.findByRole('dialog', { name: 'Evaluate this candidate?' })
    expect(within(dialog).getByText(/This is not a security sandbox/i)).toBeVisible()
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Run evaluation' }))

    expect(await within(dialog).findByText(/history now requires the repeated-effects warning/i)).toBeVisible()
    expect(within(dialog).getByText(/previous outcome is unknown/i)).toBeVisible()
    expect(within(dialog).getByRole('checkbox')).not.toBeChecked()
    await waitFor(() => expect(within(dialog).getByRole('checkbox')).toHaveFocus())
    expect(harness.api.startCandidateEvaluation).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Run evaluation' }))
    await waitFor(() => expect(harness.api.startCandidateEvaluation).toHaveBeenCalledOnce())
  })

  it('requires fresh consent and a new operation after the host retires a different uncertain passive review', async () => {
    const user = userEvent.setup()
    const differentReviewUncertain: CandidateEvaluationStatus = {
      ...candidateEvaluationUncertain,
      review: {
        ...candidateEvaluationReview,
        headCommit: 'f'.repeat(40),
        reviewAggregateSha256: 'f'.repeat(64),
      },
    }
    const harness = createCandidateEvaluationHarness([differentReviewUncertain])
    render(<App api={harness.api} />)

    await screen.findByRole('heading', { name: 'Frame protocol boundaries' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    await user.click(await screen.findByRole('button', { name: 'Evaluate candidate' }))
    const dialog = await screen.findByRole('dialog', { name: 'Evaluate this candidate?' })
    expect(within(dialog).getByText(/previous outcome is unknown/i)).toBeVisible()
    expect(within(dialog).getByText(/may repeat candidate-script effects/i)).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Run evaluation' }))
    expect(await within(dialog).findByText(/Confirm that you understand/i)).toBeVisible()
    expect(harness.api.startCandidateEvaluation).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Run evaluation' }))
    await waitFor(() => expect(harness.api.startCandidateEvaluation).toHaveBeenCalledOnce())
    const envelope = vi.mocked(harness.api.startCandidateEvaluation!).mock.calls[0]?.[0]
    expect(envelope?.operationId).not.toBe(differentReviewUncertain.operationId)
    expect(envelope?.expectedReview).toEqual(candidateEvaluationReview)
    expect(harness.api.candidateEvaluationPreflight).toHaveBeenCalledTimes(2)
  })

  it('mints one exact confirmed envelope and cancels stale polling when selection changes', async () => {
    const user = userEvent.setup()
    const harness = createCandidateEvaluationHarness()
    const baseSnapshot = harness.api.candidateEvaluationSnapshot!.bind(harness.api)
    const inFlightPoll = deferred<CandidateEvaluationSnapshot>()
    let snapshotCall = 0
    harness.api.candidateEvaluationSnapshot = vi.fn((input) => {
      snapshotCall += 1
      return snapshotCall === 3 ? inFlightPoll.promise : baseSnapshot(input)
    })
    render(<App api={harness.api} />)

    await screen.findByRole('heading', { name: 'Frame protocol boundaries' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    await user.click(await screen.findByRole('button', { name: 'Evaluate candidate' }))
    const dialog = await screen.findByRole('dialog', { name: 'Evaluate this candidate?' })
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Run evaluation' }))

    await waitFor(() => expect(harness.api.startCandidateEvaluation).toHaveBeenCalledOnce())
    const envelope = vi.mocked(harness.api.startCandidateEvaluation!).mock.calls[0]?.[0]
    expect(envelope).toMatchObject({
      ...harness.authority,
      kind: 'prime_continuim_self_build_v1',
      expectedReview: candidateEvaluationReview,
    })
    expect(envelope).not.toHaveProperty('expectedCandidate')
    expect(envelope?.operationId).toMatch(/^candidate-evaluation:/)
    expect(JSON.stringify(envelope)).not.toMatch(/[A-Z]:\\|\/Users\/|workspaceDirectory|receiptPath/i)
    expect((await screen.findAllByText('Self-build invocation started'))[0]).toBeVisible()
    await waitFor(() => expect(harness.api.candidateEvaluationSnapshot).toHaveBeenCalledTimes(3), { timeout: 3_000 })

    const next = harness.snapshot()
    const nextThread = next.threads.find((entry) => entry.id === 'thread-seamless')!
    next.selectedThreadId = nextThread.id
    next.selectedProjectId = nextThread.projectId
    next.operations.candidateEvaluationProbe = false
    await act(async () => harness.publish(next))
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    const passed: CandidateEvaluationStatus = {
      statusVersion: 1,
      ...harness.authority,
      operationId: envelope!.operationId,
      kind: 'prime_continuim_self_build_v1',
      requestedAt: envelope!.requestedAt,
      updatedAt: '2026-08-09T12:00:20.000Z',
      completedAt: '2026-08-09T12:00:20.000Z',
      invocationStartedAt: '2026-08-09T12:00:10.000Z',
      status: 'passed',
      review: candidateEvaluationReview,
      candidate: candidateEvaluationSource,
      boundary: candidateEvaluationBoundary,
      receipt: {
        receiptVersion: 1,
        kind: 'prime_continuim_candidate_evaluation_evidence',
        selfBuildRunId: '11111111-1111-4111-8111-111111111111',
        selfBuildReceiptSha256: 'f'.repeat(64),
        outcome: 'passed',
        settledGateCount: 6,
        gateCount: 6,
        artifactAggregateSha256: '0'.repeat(64),
        artifactFileCount: 2,
        completedAt: '2026-08-09T12:00:20.000Z',
        boundary: candidateEvaluationBoundary,
      },
    }
    await act(async () => inFlightPoll.resolve({
      snapshotVersion: 1,
      ...harness.authority,
      generatedAt: '2026-08-09T12:00:21.000Z',
      repeatEffectsWarningRequired: false,
      evaluations: [passed],
    }))
    expect(screen.queryByText('Candidate evaluation passed')).not.toBeInTheDocument()
  })

  it('reports only receipt-backed gates and artifacts without inventing test counts', async () => {
    const user = userEvent.setup()
    const passed: CandidateEvaluationStatus = {
      statusVersion: 1,
      expectedHostId: 'host-local',
      threadId: 'thread-protocol',
      expectedExecutionGenerationId: 'candidate-generation-one',
      operationId: 'candidate-evaluation:passed-one',
      kind: 'prime_continuim_self_build_v1',
      requestedAt: '2026-08-09T12:00:00.000Z',
      updatedAt: '2026-08-09T12:01:00.000Z',
      completedAt: '2026-08-09T12:01:00.000Z',
      invocationStartedAt: '2026-08-09T12:00:01.000Z',
      status: 'passed',
      review: candidateEvaluationReview,
      candidate: candidateEvaluationSource,
      boundary: candidateEvaluationBoundary,
      receipt: {
        receiptVersion: 1,
        kind: 'prime_continuim_candidate_evaluation_evidence',
        selfBuildRunId: '22222222-2222-4222-8222-222222222222',
        selfBuildReceiptSha256: 'f'.repeat(64),
        outcome: 'passed',
        settledGateCount: 6,
        gateCount: 6,
        artifactAggregateSha256: '0'.repeat(64),
        artifactFileCount: 2,
        completedAt: '2026-08-09T12:01:00.000Z',
        boundary: candidateEvaluationBoundary,
      },
    }
    const harness = createCandidateEvaluationHarness([passed])
    render(<App api={harness.api} />)

    await screen.findByRole('heading', { name: 'Frame protocol boundaries' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    expect(await screen.findByText('Candidate evaluation passed')).toBeVisible()
    expect(screen.getByText('6 of 6 build gates settled · 2 release artifacts')).toBeVisible()
    expect(screen.queryByText(/tests passed/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Evaluate candidate' })).not.toBeInTheDocument()
  })

  it('omits controls that do not have backing operations', async () => {
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    expect(screen.queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New thread' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reconnecting.*Seamless remote experience/i })).toBeEnabled()
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

  it('routes the native macOS menu through the path-free preload command surface', async () => {
    let listener: ((command: NativeShellCommand) => void) | undefined
    Object.defineProperty(window, 'prime', {
      configurable: true,
      value: {
        nativePlatform: 'darwin',
        onNativeShellCommand(nextListener: (command: NativeShellCommand) => void) {
          listener = nextListener
          return () => {
            if (listener === nextListener) listener = undefined
          }
        },
      },
    })

    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    expect(document.title).toBe('Seamless remote experience — Prime Continuim')
    expect(document.documentElement).toHaveAttribute('data-native-platform', 'darwin')

    act(() => listener?.('search'))
    expect(await screen.findByRole('dialog', { name: 'Search and commands' })).toBeVisible()
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
    await user.click(within(palette).getByRole('option', { name: /Manage agent session/ }))

    const inspector = await screen.findByRole('dialog', { name: 'Thread inspector' })
    await waitFor(() => expect(within(inspector).getByRole('tab', { name: 'Review' })).toHaveFocus())
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
    const composer = screen.getByRole('textbox', { name: 'Task brief' })
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

  it('renders one restrained accessible assistant stream and replaces it with the completed materialization', async () => {
    const api = createPreviewRendererApi()
    const initial = await api.loadWorkbench()
    let current = structuredClone(initial)
    const selected = current.threads.find((thread) => thread.id === current.selectedThreadId)
    if (!selected) throw new Error('Expected the selected preview thread')
    selected.transcript.push({
      id: 'authoritative-assistant-stream',
      kind: 'assistant',
      author: 'Prime Agent',
      time: 'Now',
      body: 'The authoritative assistant response has started.',
      streaming: true,
    })
    let publish: ((next: typeof current) => void) | undefined
    api.loadWorkbench = vi.fn(() => Promise.resolve(structuredClone(current)))
    api.subscribe = vi.fn((listener) => {
      publish = listener
      return () => undefined
    })

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const transcript = screen.getByRole('region', { name: 'Thread transcript' })
    const startingBody = within(transcript).getByText('The authoritative assistant response has started.')
    const streamingArticle = startingBody.closest('article')
    if (!streamingArticle) throw new Error('Expected the streaming assistant article')
    expect(streamingArticle).toHaveClass('message--assistant', 'message--streaming')
    expect(streamingArticle).toHaveAttribute('aria-busy', 'true')
    expect(within(streamingArticle).getByText('Streaming')).toBeVisible()
    expect(within(streamingArticle).queryByRole('status')).not.toBeInTheDocument()
    const oneTimeStatus = screen.getByText('Prime Agent is responding.').closest('[role="status"]')
    if (!oneTimeStatus) throw new Error('Expected the one-time assistant stream status')
    expect(oneTimeStatus).toHaveTextContent('Prime Agent is responding.')
    expect(streamingArticle.querySelector('.message__body [aria-live]')).toBeNull()

    current = structuredClone(current)
    const growingBlock = current.threads
      .find((thread) => thread.id === current.selectedThreadId)
      ?.transcript.find((block) => block.id === 'authoritative-assistant-stream')
    if (!growingBlock) throw new Error('Expected the authoritative assistant stream')
    growingBlock.body = 'The authoritative assistant response has started. Verified output keeps growing.'
    await act(async () => publish?.(structuredClone(current)))

    const growingArticle = within(transcript)
      .getByText('The authoritative assistant response has started. Verified output keeps growing.')
      .closest('article')
    expect(growingArticle).toBe(streamingArticle)
    expect(screen.getByText('Prime Agent is responding.').closest('[role="status"]')).toBe(oneTimeStatus)

    current = structuredClone(current)
    const completingThread = current.threads.find((thread) => thread.id === current.selectedThreadId)
    if (!completingThread) throw new Error('Expected the assistant stream to materialize')
    completingThread.transcript = completingThread.transcript
      .filter((block) => block.id !== 'authoritative-assistant-stream')
      .concat({
        id: 'authoritative-assistant-materialized',
        kind: 'assistant',
        author: 'Prime Agent',
        time: 'Now',
        body: 'The authoritative assistant response is complete.',
      })
    await act(async () => publish?.(structuredClone(current)))

    const completedArticle = within(transcript)
      .getByText('The authoritative assistant response is complete.')
      .closest('article')
    expect(completedArticle).not.toBe(streamingArticle)
    expect(streamingArticle).not.toBeInTheDocument()
    expect(completedArticle).toHaveClass('message--assistant')
    expect(completedArticle).not.toHaveClass('message--streaming')
    expect(completedArticle).not.toHaveAttribute('aria-busy')
    expect(within(completedArticle!).queryByRole('status')).not.toBeInTheDocument()
    expect(oneTimeStatus.textContent).toBe('')
    expect(within(transcript).queryByText('Streaming')).not.toBeInTheDocument()
    expect(within(transcript).getAllByText('The authoritative assistant response is complete.')).toHaveLength(1)
  })

  it('replaces an empty upstream stream placeholder with truthful live activity', async () => {
    const api = createPreviewRendererApi()
    const current = await api.loadWorkbench()
    const selected = current.threads.find((thread) => thread.id === current.selectedThreadId)
    const selectedHost = current.hosts.find((host) => host.id === selected?.hostId)
    if (!selected || !selectedHost || !current.runtime.session) throw new Error('Expected a selected resident thread')
    selected.status = 'idle'
    selectedHost.connection = 'online'
    current.runtime.session.isStreaming = true
    current.runtime.session.isBashRunning = false
    current.runtime.session.isCompacting = false
    current.runtime.session.activeToolNames = []
    current.agents = []
    selected.transcript.push({
      id: 'empty-authoritative-assistant-stream',
      kind: 'assistant',
      author: 'Prime Agent',
      time: 'Now',
      body: '(No display text)',
      streaming: true,
    })
    api.loadWorkbench = vi.fn(() => Promise.resolve(current))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const transcript = screen.getByRole('region', { name: 'Thread transcript' })
    expect(within(transcript).queryByText('(No display text)')).not.toBeInTheDocument()

    const thinking = transcript.querySelector('.message__thinking')
    const streamingArticle = thinking?.closest('article')
    expect(thinking).not.toBeNull()
    expect(streamingArticle).toHaveAttribute('aria-busy', 'true')
    expect(streamingArticle).toHaveAttribute('data-stream-tone', 'thinking')
    expect(within(thinking as HTMLElement).getByText('Thinking')).toBeVisible()
    expect(within(thinking as HTMLElement).getByText('Preparing the next visible update')).toBeVisible()
    expect(thinking?.querySelector('.message__thinking-track')).not.toBeNull()
    expect(document.querySelector('.task-state__label')).toHaveTextContent('Working')
    expect(document.querySelector('.agent-launchpad')).not.toBeInTheDocument()
    expect(screen.getByText('Working', { selector: '.composer__intent' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Stop the active Prime Agent turn' })).toBeEnabled()

    await userEvent.setup().click(screen.getByRole('tab', { name: 'Session' }))
    const sessionPanel = screen.getByRole('tabpanel', { name: 'Session' })
    const turnLabel = within(sessionPanel).getByText('Turn').closest('div')
    expect(turnLabel).toHaveTextContent('TurnWorking')
  })

  it('collapses and resizes desktop panels with pointer and keyboard controls, then restores the layout', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      })),
    })
    const user = userEvent.setup()
    const first = render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    const shell = document.querySelector<HTMLElement>('.app-shell')
    if (!shell) throw new Error('Expected the desktop workbench shell')
    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('280px')
    expect(shell.style.getPropertyValue('--inspector-width')).toBe('376px')

    const sidebarResizer = screen.getByRole('separator', { name: 'Resize project sidebar' })
    expect(sidebarResizer).toHaveAttribute('aria-valuenow', '280')
    fireEvent.keyDown(sidebarResizer, { key: 'ArrowRight' })
    expect(sidebarResizer).toHaveAttribute('aria-valuenow', '292')
    fireEvent.pointerDown(sidebarResizer, { button: 0, pointerId: 7, clientX: 100 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 160 })
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 160 })
    await waitFor(() => expect(sidebarResizer).toHaveAttribute('aria-valuenow', '352'))

    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    const inspectorResizer = screen.getByRole('separator', { name: 'Resize thread inspector' })
    fireEvent.keyDown(inspectorResizer, { key: 'ArrowLeft' })
    expect(inspectorResizer).toHaveAttribute('aria-valuenow', '388')

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(shell).toHaveAttribute('data-sidebar-collapsed', 'true')
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('separator', { name: 'Resize project sidebar' })).not.toBeInTheDocument()
    expect(screen.getByRole('separator', { name: 'Resize thread inspector' })).toBeInTheDocument()
    await waitFor(() => expect(JSON.parse(
      window.localStorage.getItem('prime.renderer.workbench-layout.v1') ?? '{}',
    )).toMatchObject({
      sidebarWidth: 352,
      inspectorWidth: 388,
      sidebarCollapsed: true,
      inspectorOpen: true,
    }))

    first.unmount()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const restoredShell = document.querySelector<HTMLElement>('.app-shell')
    expect(restoredShell).toHaveAttribute('data-sidebar-collapsed', 'true')
    expect(restoredShell?.style.getPropertyValue('--sidebar-width')).toBe('352px')
    expect(restoredShell?.style.getPropertyValue('--inspector-width')).toBe('388px')
    expect(screen.getByRole('separator', { name: 'Resize thread inspector' })).toHaveAttribute('aria-valuenow', '388')
  })

  it('does not restore a desktop inspector as an unexpected narrow-screen overlay', async () => {
    window.localStorage.setItem('prime.renderer.workbench-layout.v1', JSON.stringify({
      sidebarWidth: 320,
      inspectorWidth: 440,
      sidebarCollapsed: false,
      inspectorOpen: true,
    }))
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes('max-width'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      })),
    })

    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    expect(screen.getByRole('button', { name: 'Open inspector' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog', { name: 'Thread inspector' })).not.toBeInTheDocument()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('ends a panel drag when the window loses focus', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      })),
    })

    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    const shell = document.querySelector<HTMLElement>('.app-shell')
    const sidebarResizer = screen.getByRole('separator', { name: 'Resize project sidebar' })
    fireEvent.pointerDown(sidebarResizer, { button: 0, pointerId: 19, clientX: 100 })
    fireEvent.pointerMove(window, { pointerId: 19, clientX: 148 })
    expect(sidebarResizer).toHaveAttribute('aria-valuenow', '328')
    expect(shell).toHaveAttribute('data-resizing-panel', 'sidebar')

    fireEvent.blur(window)
    fireEvent.pointerMove(window, { pointerId: 19, clientX: 260 })

    await waitFor(() => expect(shell).not.toHaveAttribute('data-resizing-panel'))
    expect(sidebarResizer).toHaveAttribute('aria-valuenow', '328')
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
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Review' })).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(inspectorToggle).toHaveFocus())
    expect(inspectorToggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('places one native Prime Agent question above the visible composer and releases it on disappearance', async () => {
    const user = userEvent.setup()
    const harness = createExtensionUiAppHarness()
    render(<App api={harness.api} />)

    const title = await screen.findByRole('heading', { name: 'Use the verified migration plan?' })
    const prompt = title.closest('section')!
    const composer = screen.getByRole('contentinfo')
    expect(document.querySelectorAll('.prime-interaction')).toHaveLength(1)
    expect(prompt.compareDocumentPosition(composer)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(screen.queryByRole('textbox', { name: 'Task brief' })).not.toBeInTheDocument()
    expect(screen.queryByRole('form', { name: 'Prime Agent prompt' })).not.toBeInTheDocument()
    expect(screen.getAllByText('Response needed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Prime Agent is waiting for your answer.').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Stop the active Prime Agent turn' })).not.toBeInTheDocument()
    expect(screen.queryByText('Prime Agent is ready for another task.')).not.toBeInTheDocument()

    await user.click(within(prompt).getByRole('button', { name: 'Confirm' }))
    expect(harness.api.respondToResidentExtensionUi).toHaveBeenCalledWith(
      harness.request,
      { kind: 'confirmed', confirmed: true },
    )

    const stale = harness.snapshot()
    const next = structuredClone(stale)
    next.residentExtensionUiRequests = []
    act(() => harness.publish(next))
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Use the verified migration plan?' })).not.toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: 'Task brief' })).toBeEnabled()
    }, { timeout: 1_500 })
    act(() => harness.publish(stale))
    expect(screen.queryByRole('heading', { name: 'Use the verified migration plan?' })).not.toBeInTheDocument()
  })

  it('keeps an uncertain Prime Agent response non-actionable without reopening the composer', async () => {
    const user = userEvent.setup()
    const response = deferred<Awaited<ReturnType<NonNullable<RendererApi['respondToResidentExtensionUi']>>>>()
    const harness = createExtensionUiAppHarness()
    harness.api.respondToResidentExtensionUi = vi.fn(() => response.promise)
    render(<App api={harness.api} />)

    const title = await screen.findByRole('heading', { name: 'Use the verified migration plan?' })
    const prompt = title.closest('section')!
    await user.click(within(prompt).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(harness.api.respondToResidentExtensionUi).toHaveBeenCalledOnce())

    const withoutRequest = harness.snapshot()
    withoutRequest.residentExtensionUiRequests = []
    act(() => harness.publish(withoutRequest))
    expect(screen.getByRole('heading', { name: 'Use the verified migration plan?' })).toBeVisible()
    expect(within(prompt).getByRole('button', { name: 'Sending…' })).toBeDisabled()

    await act(async () => response.resolve({
      state: 'uncertain',
      retryable: false,
      message: 'The host acknowledgement was lost.',
    }))

    expect(await within(prompt).findByRole('button', { name: 'Outcome unknown' })).toBeDisabled()
    expect(within(prompt).getByRole('button', { name: 'Dismiss' })).toBeEnabled()
    expect(screen.queryByRole('textbox', { name: 'Task brief' })).not.toBeInTheDocument()
    expect(harness.api.respondToResidentExtensionUi).toHaveBeenCalledOnce()

    await user.click(within(prompt).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('heading', { name: 'Use the verified migration plan?' })).not.toBeInTheDocument()
  })

  it('allows a still-live Prime Agent request to recover only after its uncertain result is dismissed', async () => {
    const user = userEvent.setup()
    const harness = createExtensionUiAppHarness({
      state: 'uncertain',
      retryable: false,
      message: 'The host could not prove the acknowledgement.',
    })
    render(<App api={harness.api} />)

    const firstPrompt = (await screen.findByRole('heading', {
      name: 'Use the verified migration plan?',
    })).closest('section')!
    await user.click(within(firstPrompt).getByRole('button', { name: 'Confirm' }))
    expect(await within(firstPrompt).findByRole('button', { name: 'Dismiss' })).toBeEnabled()

    await user.click(within(firstPrompt).getByRole('button', { name: 'Dismiss' }))
    const recoveredPrompt = (await screen.findByRole('heading', {
      name: 'Use the verified migration plan?',
    })).closest('section')!
    expect(within(recoveredPrompt).getByRole('button', { name: 'Confirm' })).toBeEnabled()
    expect(harness.api.respondToResidentExtensionUi).toHaveBeenCalledOnce()
  })
})
