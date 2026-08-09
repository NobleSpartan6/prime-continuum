import { describe, expect, it, vi } from 'vitest'
import { NativeRendererApi } from '../../src/renderer/src/api'
import {
  CODEX_SUBSCRIPTION_BACKEND_ID,
  CODEX_SUBSCRIPTION_BACKEND_LABEL,
  type CodexSubscriptionAccountSnapshot,
  type CodexSubscriptionConversationSnapshot,
  type CodexSubscriptionTurnStartRequest,
} from '../../src/shared/protocol'

const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value })

describe('Native Codex subscription adapter fences', () => {
  it('retains an admitted conversation when a pre-turn null poll resolves late', async () => {
    let polledConversation: CodexSubscriptionConversationSnapshot | null = null
    const conversationSnapshot = vi.fn(() => ok({ conversation: polledConversation }))
    const admitted = activeConversation(1)
    const bridge = {
      codexSubscription: {
        conversationSnapshot,
        turnStart: vi.fn(() => ok(admitted)),
      },
    }
    const api = new NativeRendererApi(bridge).codexSubscription!
    const request = turnStartRequest()

    await expect(api.turnStart(request)).resolves.toEqual(admitted)
    await expect(api.conversationSnapshot(binding())).resolves.toEqual({ conversation: admitted })

    polledConversation = idleConversation(0)
    await expect(api.conversationSnapshot(binding())).resolves.toEqual({ conversation: admitted })
  })

  it('ignores an older same-incarnation account poll that resolves after login start', async () => {
    const lateRead = deferred<ReturnType<typeof signedOutAccount>>()
    const waiting = waitingAccount()
    const bridge = {
      codexSubscription: {
        accountRead: vi.fn(() => lateRead.promise.then((value) => ({ ok: true as const, value }))),
        loginStart: vi.fn(() => ok(waiting)),
      },
    }
    const api = new NativeRendererApi(bridge).codexSubscription!
    const reading = api.accountRead({ expectedHostId: 'host-local' })

    await expect(api.loginStart({
      expectedHostId: 'host-local',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'login-operation-one',
    })).resolves.toEqual(waiting)
    lateRead.resolve(signedOutAccount())

    await expect(reading).resolves.toEqual(waiting)
  })

  it('fails closed when equal account timestamps carry different facts', async () => {
    const first = signedOutAccount()
    const divergent = { ...first, phase: 'error' as const, error: backendError(), turnReadiness: {
      state: 'error' as const,
      checkedAt: first.updatedAt,
      error: backendError(),
    } }
    const accountRead = vi.fn()
      .mockImplementationOnce(() => ok(first))
      .mockImplementationOnce(() => ok(divergent))
    const api = new NativeRendererApi({ codexSubscription: { accountRead } }).codexSubscription!

    await expect(api.accountRead({ expectedHostId: 'host-local' })).resolves.toEqual(first)
    await expect(api.accountRead({ expectedHostId: 'host-local' })).rejects.toThrow(
      'without advancing its timestamp',
    )
  })
})

function binding() {
  return {
    expectedHostId: 'host-local',
    threadId: 'source-thread',
    expectedExecutionGenerationId: 'execution-one',
  }
}

function turnStartRequest(): CodexSubscriptionTurnStartRequest {
  return {
    ...binding(),
    expectedBackendIncarnationId: 'backend-one',
    expectedConversation: { state: 'absent' },
    operationId: 'turn-operation-one',
    prompt: 'Inspect this workspace.',
  }
}

function activeConversation(revision: number): CodexSubscriptionConversationSnapshot {
  return {
    backend: backend(),
    backendIncarnationId: 'backend-one',
    binding: {
      hostId: 'host-local',
      sourceThreadId: 'source-thread',
      executionGenerationId: 'execution-one',
    },
    sessionId: 'session-one',
    threadId: 'codex-thread-one',
    revision,
    state: 'active',
    executionPolicy: executionPolicy(),
    activeTurn: {
      operationId: 'turn-operation-one',
      turnId: 'turn-one',
      state: 'running',
      terminal: false,
      startedAt: '2026-08-09T12:00:00.000Z',
    },
    latestTurn: {
      operationId: 'turn-operation-one',
      turnId: 'turn-one',
      state: 'running',
      terminal: false,
      startedAt: '2026-08-09T12:00:00.000Z',
    },
    transcript: [{
      itemId: 'item-user-one',
      turnOperationId: 'turn-operation-one',
      turnId: 'turn-one',
      sequence: 0,
      role: 'user',
      state: 'completed',
      text: 'Inspect this workspace.',
      createdAt: '2026-08-09T12:00:00.000Z',
      updatedAt: '2026-08-09T12:00:00.000Z',
    }],
    transcriptTruncated: false,
    updatedAt: '2026-08-09T12:00:00.000Z',
  }
}

function idleConversation(revision: number): CodexSubscriptionConversationSnapshot {
  return {
    backend: backend(),
    backendIncarnationId: 'backend-one',
    binding: {
      hostId: 'host-local',
      sourceThreadId: 'source-thread',
      executionGenerationId: 'execution-one',
    },
    sessionId: 'session-one',
    revision,
    state: 'idle',
    executionPolicy: executionPolicy(),
    transcript: [],
    transcriptTruncated: false,
    updatedAt: '2026-08-09T11:59:00.000Z',
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

function backendError() {
  return { code: 'BACKEND_UNAVAILABLE' as const, message: 'Backend unavailable.', retryable: true }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}
