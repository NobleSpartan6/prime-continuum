import { describe, expect, it, vi } from 'vitest'

const { exposeInMainWorld, invoke } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => ({ ok: true, value: undefined })),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
}))

import '../../src/preload/index'

describe('preload Codex subscription bridge', () => {
  it('exposes only renderer-safe DTO methods on the dedicated nested bridge', async () => {
    const exposed = exposeInMainWorld.mock.calls[0]?.[1] as {
      codexSubscription: Record<string, (input: unknown) => Promise<unknown>>
    }
    const login = {
      expectedHostId: 'host-local',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'login-operation-one',
    }
    const turn = {
      expectedHostId: 'host-local',
      threadId: 'source-thread',
      expectedExecutionGenerationId: 'execution-one',
      expectedBackendIncarnationId: 'backend-one',
      expectedConversation: { state: 'absent' },
      operationId: 'turn-operation-one',
      prompt: 'Inspect this workspace.',
    }

    await exposed.codexSubscription.loginStart!(login)
    await exposed.codexSubscription.turnStart!(turn)

    expect(Object.isFrozen(exposed.codexSubscription)).toBe(true)
    expect(Object.keys(exposed.codexSubscription).sort()).toEqual([
      'accountRead',
      'conversationSnapshot',
      'loginCancel',
      'loginStart',
      'logout',
      'turnInterrupt',
      'turnReconcile',
      'turnStart',
    ])
    expect(invoke).toHaveBeenNthCalledWith(1, 'prime:codex-subscription:login:start', login)
    expect(invoke).toHaveBeenNthCalledWith(2, 'prime:codex-subscription:turn:start', turn)
    expect(JSON.stringify(exposed.codexSubscription)).not.toMatch(/authUrl|authorization|token|callback/i)
  })
})
