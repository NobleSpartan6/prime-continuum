import { EventEmitter } from 'node:events'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/main/control/contracts'
import { registerControlIpc } from '../../src/main/control/ipc'
import type { DesktopControlService } from '../../src/main/control/service'

type Handler = (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>

function fixture(workbenchTrusted: boolean) {
  const handlers = new Map<string, Handler>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  } as unknown as IpcMain
  const service = Object.assign(new EventEmitter(), {
    codexSubscriptionAccountRead: vi.fn(async (input: unknown) => input),
    codexSubscriptionLoginStart: vi.fn(async (input: unknown) => input),
    codexSubscriptionLoginCancel: vi.fn(async (input: unknown) => input),
    codexSubscriptionLogout: vi.fn(async (input: unknown) => input),
    codexSubscriptionConversationSnapshot: vi.fn(async (input: unknown) => input),
    codexSubscriptionTurnStart: vi.fn(async (input: unknown) => input),
    codexSubscriptionTurnInterrupt: vi.fn(async (input: unknown) => input),
    codexSubscriptionTurnReconcile: vi.fn(async (input: unknown) => input),
  }) as unknown as DesktopControlService
  const dispose = registerControlIpc({
    ipcMain,
    service,
    getWindows: () => [],
    isTrustedSender: () => true,
    isTrustedWorkbenchSender: () => workbenchTrusted,
  })
  return { handlers, service, dispose }
}

describe('Codex subscription control IPC', () => {
  it('denies the Codex bridge to a HUD sender even when the general sender is trusted', async () => {
    const { handlers, service, dispose } = fixture(false)
    const result = await handlers.get(IPC.codexSubscriptionAccountRead)!({} as IpcMainInvokeEvent, {
      expectedHostId: 'host-local',
    }) as { ok: boolean; error?: { code: string } }

    expect(result).toMatchObject({ ok: false, error: { code: 'ipc.untrusted_sender' } })
    expect(service.codexSubscriptionAccountRead).not.toHaveBeenCalled()
    dispose()
  })

  it('forwards the exact stronger turn envelope from the workbench', async () => {
    const { handlers, service, dispose } = fixture(true)
    const input = {
      expectedHostId: 'host-local',
      threadId: 'source-thread',
      expectedExecutionGenerationId: 'execution-one',
      expectedBackendIncarnationId: 'backend-one',
      expectedConversation: { state: 'present', sessionId: 'session-one', revision: 7 },
      operationId: 'turn-operation-one',
      prompt: 'Inspect the current state.',
    }

    await expect(handlers.get(IPC.codexSubscriptionTurnStart)!({} as IpcMainInvokeEvent, input))
      .resolves.toEqual({ ok: true, value: input })
    expect(service.codexSubscriptionTurnStart).toHaveBeenCalledWith(input)
    expect(JSON.stringify(input)).not.toMatch(/[A-Z]:\\|\/Users\/|workspaceDirectory|authUrl|token/i)
    dispose()
  })

  it('rejects the obsolete unfenced login envelope before the service boundary', async () => {
    const { handlers, service, dispose } = fixture(true)
    const result = await handlers.get(IPC.codexSubscriptionLoginStart)!({} as IpcMainInvokeEvent, {
      expectedHostId: 'host-local',
      operationId: 'login-operation-one',
    }) as { ok: boolean }

    expect(result.ok).toBe(false)
    expect(service.codexSubscriptionLoginStart).not.toHaveBeenCalled()
    dispose()
  })
})
