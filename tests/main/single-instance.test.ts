import { afterEach, describe, expect, it, vi } from 'vitest'

const originalPackageSmoke = process.env.PRIME_CONTINUIM_PACKAGE_SMOKE

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  if (originalPackageSmoke === undefined) delete process.env.PRIME_CONTINUIM_PACKAGE_SMOKE
  else process.env.PRIME_CONTINUIM_PACKAGE_SMOKE = originalPackageSmoke
})

describe('Electron single-instance lifecycle', () => {
  it('quits before readiness or application initialization when another primary owns the lock', async () => {
    const fixture = installIndexMocks(false)

    await import('../../src/main/index')

    expect(fixture.app.requestSingleInstanceLock).toHaveBeenCalledOnce()
    expect(fixture.app.quit).toHaveBeenCalledOnce()
    expect(fixture.app.whenReady).not.toHaveBeenCalled()
    expect(fixture.app.on).not.toHaveBeenCalled()
    expect(fixture.controlService).not.toHaveBeenCalled()
    expect(fixture.browserWindows).toHaveLength(0)
  })

  it('restores and focuses only the primary workbench for a second launch', async () => {
    const fixture = installIndexMocks(true)

    await import('../../src/main/index')
    await flushMicrotasks()

    const secondInstance = fixture.app.on.mock.calls.find(([event]) => event === 'second-instance')?.[1]
    expect(secondInstance).toBeTypeOf('function')
    expect(fixture.browserWindows).toHaveLength(1)

    secondInstance()
    await flushMicrotasks()

    const workbench = fixture.browserWindows[0]!
    expect(workbench.restore).toHaveBeenCalledOnce()
    expect(workbench.show).toHaveBeenCalledOnce()
    expect(workbench.focus).toHaveBeenCalledOnce()
    expect(fixture.hudWindow.restore).not.toHaveBeenCalled()
    expect(fixture.hudWindow.show).not.toHaveBeenCalled()
    expect(fixture.hudWindow.focus).not.toHaveBeenCalled()
  })
})

function installIndexMocks(ownsLock: boolean) {
  const ready = Promise.resolve()
  const app = {
    requestSingleInstanceLock: vi.fn(() => ownsLock),
    whenReady: vi.fn(() => ready),
    on: vi.fn(),
    once: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
    setAppUserModelId: vi.fn(),
    getPath: vi.fn(() => 'C:\\prime-continuim-test'),
    getVersion: vi.fn(() => '0.1.0'),
  }

  const browserWindows: FakeBrowserWindow[] = []
  class BrowserWindow extends FakeBrowserWindow {
    constructor() {
      super()
      browserWindows.push(this)
    }
  }

  const hudWindow = {
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  }
  class HudWindowController {
    initialize = vi.fn(async () => undefined)
    dispose = vi.fn(async () => undefined)
    window = vi.fn(() => hudWindow)
  }

  const controlService = vi.fn(function ControlService() {
    return {
      shutdown: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getConnectionState: vi.fn(() => ({ phase: 'offline' })),
    }
  })

  vi.doMock('electron', () => ({
    app,
    BrowserWindow,
    dialog: { showOpenDialog: vi.fn() },
    ipcMain: {},
    shell: { openExternal: vi.fn(async () => undefined) },
  }))
  vi.doMock('../../src/main/control/ipc', () => ({
    isTrustedRendererSender: vi.fn(() => true),
    registerControlIpc: vi.fn(() => vi.fn()),
  }))
  vi.doMock('../../src/main/control/local-hostd', () => ({
    stopPackageSmokeHostds: vi.fn(async () => undefined),
  }))
  vi.doMock('../../src/main/control/service', () => ({ DesktopControlService: controlService }))
  vi.doMock('../../src/main/hud-window', () => ({
    createHudWindowPreferencesStore: vi.fn(() => ({})),
    HudWindowController,
    registerHudIpc: vi.fn(() => vi.fn()),
  }))
  vi.doMock('../../src/main/orderly-quit', () => ({ installOrderlyQuitDrain: vi.fn(() => vi.fn()) }))
  vi.doMock('../../src/main/window-paths', () => ({ resolvePreloadEntry: vi.fn(() => 'preload.cjs') }))
  vi.doMock('../../src/main/window-security', () => ({ secureWebPreferences: vi.fn(() => ({})) }))

  return { app, browserWindows, controlService, hudWindow }
}

class FakeBrowserWindow {
  readonly restore = vi.fn()
  readonly show = vi.fn()
  readonly focus = vi.fn()
  readonly loadURL = vi.fn(async () => undefined)
  readonly loadFile = vi.fn(async () => undefined)
  readonly once = vi.fn()
  readonly isDestroyed = vi.fn(() => false)
  readonly isMinimized = vi.fn(() => true)
  readonly isVisible = vi.fn(() => false)
  readonly webContents = {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    getURL: vi.fn(() => ''),
    session: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      on: vi.fn(),
      webRequest: { onBeforeRequest: vi.fn() },
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
