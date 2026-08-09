// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/renderer/src/App'
import { CodexSubscriptionWorkspace } from '../../src/renderer/src/CodexSubscriptionWorkspace'
import {
  createPreviewRendererApi,
  previewSnapshot,
  type CodexSubscriptionRendererApi,
  type RendererApi,
  type WorkbenchSnapshot,
} from '../../src/renderer/src/api'
import {
  CODEX_SUBSCRIPTION_BACKEND_ID,
  CODEX_SUBSCRIPTION_BACKEND_LABEL,
  type CodexSubscriptionAccountSnapshot,
  type CodexSubscriptionConversationSnapshot,
  type CodexSubscriptionTurnReconciliation,
} from '../../src/shared/protocol'

afterEach(() => cleanup())

describe('Codex subscription workspace', () => {
  it('reconciles one ambiguous prompt without replay, clears only after proof, and stops the exact turn', async () => {
    const reconcileGate = deferred<CodexSubscriptionTurnReconciliation>()
    let durableConversation: CodexSubscriptionConversationSnapshot | null = null
    let admittedOperationId = ''
    const turnStart = vi.fn(async () => { throw new Error('Connection changed during admission.') })
    const turnReconcile = vi.fn(() => reconcileGate.promise)
    const turnInterrupt = vi.fn(async () => {
      durableConversation = terminalConversation(admittedOperationId)
      return durableConversation
    })
    const api: CodexSubscriptionRendererApi = {
      accountRead: vi.fn(async () => signedInAccount()),
      loginStart: vi.fn(),
      loginCancel: vi.fn(),
      logout: vi.fn(),
      conversationSnapshot: vi.fn(async () => ({ conversation: durableConversation })),
      turnStart,
      turnInterrupt,
      turnReconcile,
    }
    const user = userEvent.setup()
    render(<CodexSubscriptionWorkspace api={api} binding={binding()} />)

    const composer = await screen.findByLabelText('Ask Codex about this workspace')
    expect(screen.getByText(/including workspace instructions and tool-read files.*sent to OpenAI/i)).toBeVisible()
    expect(screen.getByText(/Workbench only/)).toBeVisible()
    await user.type(composer, 'Inspect the current state.')
    await user.click(screen.getByRole('button', { name: 'Run with Codex' }))

    await waitFor(() => expect(turnStart).toHaveBeenCalledOnce())
    expect(document.querySelector('.codex-message')).toBeNull()
    expect(composer).toHaveValue('Inspect the current state.')
    const exactEnvelope = turnStart.mock.calls[0]![0]
    admittedOperationId = exactEnvelope.operationId
    await waitFor(() => expect(turnReconcile).toHaveBeenCalledWith(exactEnvelope))
    expect(turnStart).toHaveBeenCalledTimes(1)

    durableConversation = activeConversation(exactEnvelope.operationId)
    reconcileGate.resolve({
      known: true,
      operationId: exactEnvelope.operationId,
      conversation: durableConversation,
    })

    await screen.findByRole('button', { name: 'Stop' })
    expect(composer).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Stop' }))

    await waitFor(() => expect(turnInterrupt).toHaveBeenCalledOnce())
    expect(turnInterrupt).toHaveBeenCalledWith(expect.objectContaining({
      expectedHostId: 'host-local',
      threadId: 'source-thread',
      expectedExecutionGenerationId: 'execution-one',
      expectedBackendIncarnationId: 'backend-one',
      sessionId: 'session-one',
      codexThreadId: 'codex-thread-one',
      expectedTurnOperationId: exactEnvelope.operationId,
      turnId: 'turn-one',
    }))
    expect(turnStart).toHaveBeenCalledTimes(1)
    await screen.findByText('Codex stopped.')
  })

  it('keeps Prime controls unreachable in Codex mode and resets to Prime after eligibility loss', async () => {
    let subscriber: ((snapshot: WorkbenchSnapshot) => void) | undefined
    const eligible = eligibleSnapshot()
    const api = createPreviewRendererApi() as RendererApi
    Object.defineProperty(api, 'environment', { configurable: true, value: 'native' })
    api.loadWorkbench = vi.fn(async () => eligible)
    api.subscribe = vi.fn((listener) => {
      subscriber = listener
      return () => { subscriber = undefined }
    })
    api.codexSubscription = signedOutApi()
    api.hudOpen = vi.fn(api.hudOpen.bind(api))
    api.loadRuntimeModelCatalog = vi.fn(api.loadRuntimeModelCatalog.bind(api))
    api.sendComposer = vi.fn(api.sendComposer.bind(api))
    const user = userEvent.setup()

    render(<App api={api} />)
    await user.click(await screen.findByRole('button', { name: 'Use Codex via ChatGPT subscription' }))
    await screen.findByRole('heading', { name: 'Codex via ChatGPT subscription' })

    expect(screen.queryByRole('button', { name: 'Open inspector' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show desktop HUD' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Search projects, threads, and commands' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Search projects and threads' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^Run location:/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^Compact run location:/)).not.toBeInTheDocument()
    expect(document.querySelector('#thread-composer')).toBeNull()
    expect(screen.queryByText('Models & accounts')).not.toBeInTheDocument()
    expect(screen.getByText(/Encrypted sign-in data may also live in Prime Continuim’s private app data/)).toBeVisible()

    await user.keyboard('{Control>}k{/Control}')
    expect(screen.queryByRole('dialog', { name: /command/i })).not.toBeInTheDocument()
    expect(api.hudOpen).not.toHaveBeenCalled()
    expect(api.loadRuntimeModelCatalog).not.toHaveBeenCalled()
    expect(api.sendComposer).not.toHaveBeenCalled()

    act(() => {
      subscriber?.({
        ...eligible,
        operations: { ...eligible.operations, codexSubscription: false },
      })
      subscriber?.(eligible)
    })
    await waitFor(() => expect(document.querySelector('#thread-composer')).not.toBeNull())
    const codexChoice = await screen.findByRole('button', { name: 'Use Codex via ChatGPT subscription' })
    expect(codexChoice).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Prime Agent' })).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelector('#thread-composer')).not.toBeNull()
    expect(screen.queryByRole('heading', { name: 'Codex via ChatGPT subscription' })).not.toBeInTheDocument()
  })
})

function eligibleSnapshot(): WorkbenchSnapshot {
  const snapshot = structuredClone(previewSnapshot)
  const selected = snapshot.threads.find((thread) => thread.id === 'thread-protocol')!
  selected.remoteId = 'source-thread'
  selected.executionGenerationId = 'execution-one'
  selected.status = 'idle'
  snapshot.selectedProjectId = selected.projectId
  snapshot.selectedThreadId = selected.id
  snapshot.operations = {
    ...snapshot.operations,
    startResidentTurn: true,
    stopResidentTurn: false,
    codexSubscription: true,
  }
  return snapshot
}

function signedOutApi(): CodexSubscriptionRendererApi {
  return {
    accountRead: vi.fn(async () => signedOutAccount()),
    loginStart: vi.fn(async () => waitingAccount()),
    loginCancel: vi.fn(async () => signedOutAccount()),
    logout: vi.fn(async () => signedOutAccount()),
    conversationSnapshot: vi.fn(async () => ({ conversation: null })),
    turnStart: vi.fn(),
    turnInterrupt: vi.fn(),
    turnReconcile: vi.fn(),
  }
}

function binding() {
  return {
    expectedHostId: 'host-local',
    threadId: 'source-thread',
    expectedExecutionGenerationId: 'execution-one',
  }
}

function signedInAccount(): CodexSubscriptionAccountSnapshot {
  return {
    backend: backend(),
    backendIncarnationId: 'backend-one',
    phase: 'signed_in',
    accountType: 'chatgpt',
    requiresOpenaiAuth: true,
    planType: 'plus',
    executionPolicy: executionPolicy(),
    turnReadiness: { state: 'ready', verifiedAt: '2026-08-09T12:00:00.000Z' },
    updatedAt: '2026-08-09T12:00:00.000Z',
  }
}

function signedOutAccount(): CodexSubscriptionAccountSnapshot {
  return {
    backend: backend(),
    backendIncarnationId: 'backend-one',
    phase: 'signed_out',
    executionPolicy: executionPolicy(),
    turnReadiness: { state: 'unavailable', reason: 'account_required' },
    updatedAt: '2026-08-09T12:00:00.000Z',
  }
}

function waitingAccount(): CodexSubscriptionAccountSnapshot {
  return {
    backend: backend(),
    backendIncarnationId: 'backend-one',
    phase: 'waiting_for_login',
    pendingLoginId: 'login-one',
    pendingLoginOperationId: 'login-operation-one',
    executionPolicy: executionPolicy(),
    turnReadiness: { state: 'unavailable', reason: 'login_in_progress' },
    updatedAt: '2026-08-09T12:01:00.000Z',
  }
}

function activeConversation(operationId = 'turn-operation-one'): CodexSubscriptionConversationSnapshot {
  return {
    backend: backend(),
    backendIncarnationId: 'backend-one',
    binding: { hostId: 'host-local', sourceThreadId: 'source-thread', executionGenerationId: 'execution-one' },
    sessionId: 'session-one',
    threadId: 'codex-thread-one',
    revision: 1,
    state: 'active',
    executionPolicy: executionPolicy(),
    activeTurn: {
      operationId,
      turnId: 'turn-one',
      state: 'running',
      terminal: false,
      startedAt: '2026-08-09T12:01:00.000Z',
    },
    latestTurn: {
      operationId,
      turnId: 'turn-one',
      state: 'running',
      terminal: false,
      startedAt: '2026-08-09T12:01:00.000Z',
    },
    transcript: [],
    transcriptTruncated: false,
    updatedAt: '2026-08-09T12:01:00.000Z',
  }
}

function terminalConversation(operationId: string): CodexSubscriptionConversationSnapshot {
  const active = activeConversation(operationId)
  return {
    ...active,
    revision: 2,
    state: 'terminal',
    activeTurn: undefined,
    latestTurn: {
      operationId,
      turnId: 'turn-one',
      state: 'interrupted',
      terminal: true,
      startedAt: '2026-08-09T12:01:00.000Z',
      completedAt: '2026-08-09T12:02:00.000Z',
    },
    updatedAt: '2026-08-09T12:02:00.000Z',
  }
}

function backend() {
  return {
    id: CODEX_SUBSCRIPTION_BACKEND_ID,
    kind: 'codex_subscription' as const,
    label: CODEX_SUBSCRIPTION_BACKEND_LABEL,
  }
}

function executionPolicy() {
  return {
    filesystem: 'read_only_user_scope' as const,
    workspaceReadConfinement: false as const,
    toolNetworkAccess: false as const,
    approvalPolicy: 'never' as const,
    disclosure: 'Codex tools cannot write files or open network connections. They may read other files available to your Windows account; this is not a workspace-only sandbox. Prompts and content Codex reads—including workspace instructions and tool-read files—are sent to OpenAI for the turn.' as const,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}
