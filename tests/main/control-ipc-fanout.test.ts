import { EventEmitter } from 'node:events'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/main/control/contracts'
import { isTrustedRendererSender, registerControlIpc } from '../../src/main/control/ipc'
import type { DesktopControlService } from '../../src/main/control/service'

function fakeWindow(id: number, options: { destroyed?: boolean; contentsDestroyed?: boolean } = {}) {
  const send = vi.fn()
  const mainFrame = { url: 'file:///app/out/renderer/index.html?surface=hud' }
  const webContents = {
    id,
    mainFrame,
    send,
    isDestroyed: () => options.contentsDestroyed === true,
  }
  return {
    window: {
      webContents,
      isDestroyed: () => options.destroyed === true,
    } as unknown as BrowserWindow,
    webContents,
    send,
  }
}

describe('control IPC trusted-window fan-out', () => {
  it('delivers every native event once to each live trusted renderer and skips dead windows', () => {
    const service = new EventEmitter() as DesktopControlService
    const ipcMain = {
      handle: vi.fn(),
      removeHandler: vi.fn(),
    } as unknown as IpcMain
    const main = fakeWindow(1)
    const hud = fakeWindow(2)
    const duplicateHud = { ...hud, window: hud.window }
    const destroyed = fakeWindow(3, { destroyed: true })
    const contentsDestroyed = fakeWindow(4, { contentsDestroyed: true })
    const dispose = registerControlIpc({
      ipcMain,
      service,
      getWindows: () => [main.window, hud.window, duplicateHud.window, destroyed.window, contentsDestroyed.window],
      isTrustedSender: () => true,
      isTrustedWorkbenchSender: () => true,
    })
    const registeredChannels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls
      .map(([channel]) => channel as string)
    expect(registeredChannels.some((channel) => channel.startsWith('prime:codex-subscription:'))).toBe(false)

    const events = [
      ['connection-state', IPC.connectionState],
      ['host-event', IPC.hostEvent],
      ['snapshot', IPC.snapshot],
      ['handoff-progress', IPC.handoffProgress],
    ] as const
    for (const [serviceEvent, channel] of events) {
      const payload = { serviceEvent }
      service.emit(serviceEvent, payload)
      expect(main.send).toHaveBeenCalledWith(channel, payload)
      expect(hud.send).toHaveBeenCalledWith(channel, payload)
    }
    expect(main.send).toHaveBeenCalledTimes(events.length)
    expect(hud.send).toHaveBeenCalledTimes(events.length)
    expect(destroyed.send).not.toHaveBeenCalled()
    expect(contentsDestroyed.send).not.toHaveBeenCalled()

    dispose()
    service.emit('snapshot', { after: 'dispose' })
    expect(main.send).toHaveBeenCalledTimes(events.length)
    expect(hud.send).toHaveBeenCalledTimes(events.length)
  })

  it('admits host OAuth authority only from the workbench window', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => {
        handlers.set(channel, handler)
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain
    const startRuntimeOAuth = vi.fn(async () => ({ sessionId: 'oauth-1' }))
    const runtimeOAuthStatus = vi.fn(async () => ({ sessionId: 'oauth-1' }))
    const cancelRuntimeOAuth = vi.fn(async () => ({ sessionId: 'oauth-1' }))
    const openRuntimeProviderSetup = vi.fn(async () => ({ state: 'opened' }))
    const service = Object.assign(new EventEmitter(), {
      startRuntimeOAuth,
      runtimeOAuthStatus,
      cancelRuntimeOAuth,
      openRuntimeProviderSetup,
    }) as unknown as DesktopControlService
    const workbenchEvent = {} as IpcMainInvokeEvent
    const hudEvent = {} as IpcMainInvokeEvent
    const dispose = registerControlIpc({
      ipcMain,
      service,
      getWindows: () => [],
      isTrustedSender: () => true,
      isTrustedWorkbenchSender: (event) => event === workbenchEvent,
    })
    const cases = [
      [IPC.startRuntimeOAuth, { expectedHostId: 'host-a', providerId: 'openai-codex' }, startRuntimeOAuth],
      [IPC.runtimeOAuthStatus, { expectedHostId: 'host-a', sessionId: 'oauth-1' }, runtimeOAuthStatus],
      [IPC.cancelRuntimeOAuth, { expectedHostId: 'host-a', sessionId: 'oauth-1' }, cancelRuntimeOAuth],
      [IPC.openRuntimeProviderSetup, { expectedHostId: 'host-a', providerId: 'anthropic' }, openRuntimeProviderSetup],
    ] as const

    for (const [channel, input, operation] of cases) {
      await expect(handlers.get(channel)?.(hudEvent, input)).resolves.toMatchObject({
        ok: false,
        error: { code: 'ipc.untrusted_sender' },
      })
      expect(operation).not.toHaveBeenCalled()
      await expect(handlers.get(channel)?.(workbenchEvent, input)).resolves.toMatchObject({ ok: true })
      expect(operation).toHaveBeenCalledOnce()
    }

    dispose()
  })

  it('trusts only the exact main frame of an explicitly supplied live window', () => {
    const main = fakeWindow(1)
    const hud = fakeWindow(2)
    const unknown = fakeWindow(3)
    const trustedUrl = vi.fn((url: string) => url.startsWith('file:///app/out/renderer/index.html'))
    const eventFor = (candidate: ReturnType<typeof fakeWindow>, frame = candidate.webContents.mainFrame) => ({
      sender: candidate.webContents,
      senderFrame: frame,
    }) as unknown as IpcMainInvokeEvent

    expect(isTrustedRendererSender(eventFor(main), [main.window, hud.window], trustedUrl)).toBe(true)
    expect(isTrustedRendererSender(eventFor(hud), [main.window, hud.window], trustedUrl)).toBe(true)
    expect(isTrustedRendererSender(eventFor(unknown), [main.window, hud.window], trustedUrl)).toBe(false)
    expect(isTrustedRendererSender(eventFor(main, { url: main.webContents.mainFrame.url }), [main.window], trustedUrl)).toBe(false)

    main.webContents.mainFrame.url = 'https://untrusted.example/'
    expect(isTrustedRendererSender(eventFor(main), [main.window], trustedUrl)).toBe(false)
  })
})
