import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  IpcMainInvokeEvent,
  Rectangle,
  WebContents
} from 'electron'

const { electronScreen } = vi.hoisted(() => ({
  electronScreen: {
    getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1280, height: 720 } }]),
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: electronScreen
}))

import {
  HUD_WINDOW_SIZE,
  HudWindowController,
  clampHudBounds,
  registerHudIpc,
  type HudDisplayProvider,
  type HudWindowPreferences,
  type HudWindowPreferencesStore
} from '../../src/main/hud-window'
import { HUD_IPC, type HudTarget } from '../../src/shared/window-control'

const TARGET: HudTarget = {
  expectedHostId: 'host-local',
  threadId: 'thread-prime',
  expectedExecutionGenerationId: 'generation-1'
}
let nextWebContentsId = 1

describe('HUD bounds', () => {
  it('preserves negative-coordinate displays and rehomes removed-display bounds completely onscreen', () => {
    const areas = [
      { x: -1920, y: -120, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1280, height: 720 }
    ]
    expect(clampHudBounds('buddy', { x: -1840, y: 800, width: 900, height: 900 }, areas)).toEqual({
      x: -1840,
      y: 800,
      width: HUD_WINDOW_SIZE.buddy.width,
      height: HUD_WINDOW_SIZE.buddy.height
    })

    const rehomed = clampHudBounds(
      'expanded',
      { x: -1900, y: -100, width: 2_000, height: 2_000 },
      [{ x: 0, y: 0, width: 1280, height: 720 }]
    )
    expect(rehomed).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
  })
})

describe('HudWindowController', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates one secure overlay, retargets it ephemerally, and persists only bounded mode geometry', async () => {
    const store = fakeStore({
      version: 1,
      lastMode: 'buddy',
      bounds: { buddy: { x: 100, y: 200, width: 999, height: 999 } }
    })
    const created: FakeWindow[] = []
    const main = new FakeWindow({ width: 900, height: 700 })
    const controller = new HudWindowController({
      preloadPath: 'C:\\prime\\preload.cjs',
      store,
      getMainWindow: () => main.asBrowserWindow(),
      loadWindow: vi.fn(async () => undefined),
      hardenWindow: vi.fn(),
      createWindow: (options) => {
        const window = new FakeWindow(options)
        created.push(window)
        return window.asBrowserWindow()
      },
      displayProvider: staticDisplays([{ x: 0, y: 0, width: 1280, height: 720 }])
    })

    expect(await controller.open(TARGET)).toMatchObject({ state: 'buddy', target: TARGET })
    expect(created).toHaveLength(1)
    expect(created[0]?.options).toMatchObject({
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        preload: 'C:\\prime\\preload.cjs',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false
      }
    })
    expect(created[0]?.bounds).toEqual({ x: 100, y: 200, width: 184, height: 64 })

    const replacement = { ...TARGET, threadId: 'thread-replacement' }
    await controller.open(replacement)
    expect(created).toHaveLength(1)
    expect(controller.state()).toMatchObject({ state: 'buddy', target: replacement })

    await controller.setMode('expanded')
    expect(created[0]?.resizable).toBe(true)
    expect(store.write).toHaveBeenCalled()
    const serializedWrites = JSON.stringify(store.write.mock.calls)
    expect(serializedWrites).not.toContain('thread-replacement')
    expect(serializedWrites).not.toContain('host-local')
    expect(serializedWrites).not.toContain('generation-1')

    await controller.close()
    expect(controller.state()).toEqual({ state: 'closed' })
    expect(created[0]?.destroyed).toBe(true)
    expect(controller.window()).toBeUndefined()
  })

  it('reclamps a live HUD after display removal and unregisters display listeners on disposal', async () => {
    const displays = new FakeDisplays([
      { x: -1200, y: 0, width: 1200, height: 800 },
      { x: 0, y: 0, width: 1280, height: 720 }
    ])
    const store = fakeStore({
      version: 1,
      lastMode: 'expanded',
      bounds: { expanded: { x: -1100, y: 100, width: 620, height: 380 } }
    })
    const window = new FakeWindow({ width: 620, height: 380 })
    const controller = new HudWindowController({
      preloadPath: 'preload.cjs',
      store,
      getMainWindow: () => undefined,
      loadWindow: async () => undefined,
      createWindow: () => window.asBrowserWindow(),
      displayProvider: displays
    })
    await controller.open(TARGET)
    expect(window.bounds.x).toBeLessThan(0)

    displays.areas = [{ x: 0, y: 0, width: 1280, height: 720 }]
    displays.emit('display-removed')
    await controller.setIgnoreMouseEvents(false)
    expect(window.bounds).toEqual({ x: 0, y: 100, width: 620, height: 380 })

    await controller.dispose()
    expect(displays.listenerCount('display-added')).toBe(0)
    expect(displays.listenerCount('display-removed')).toBe(0)
    expect(displays.listenerCount('display-metrics-changed')).toBe(0)
  })

  it('reclamps a fully offscreen user move only after the native move-end event', async () => {
    const store = fakeStore()
    const window = new FakeWindow({ width: 620, height: 380 })
    const controller = new HudWindowController({
      preloadPath: 'preload.cjs',
      store,
      getMainWindow: () => undefined,
      loadWindow: async () => undefined,
      createWindow: () => window.asBrowserWindow(),
      displayProvider: staticDisplays([{ x: 0, y: 0, width: 1280, height: 720 }])
    })
    await controller.open(TARGET)

    window.bounds = { x: 5_000, y: 4_000, width: 620, height: 380 }
    window.emit('move')
    expect(window.bounds.x).toBe(5_000)
    window.emit('moved')
    await controller.setIgnoreMouseEvents(false)

    expect(window.bounds.x).toBeGreaterThanOrEqual(0)
    expect(window.bounds.y).toBeGreaterThanOrEqual(0)
    expect(window.bounds.x + window.bounds.width).toBeLessThanOrEqual(1280)
    expect(window.bounds.y + window.bounds.height).toBeLessThanOrEqual(720)
    expect(store.write).toHaveBeenCalledWith(expect.objectContaining({
      bounds: expect.objectContaining({ expanded: window.bounds })
    }))
  })

  it('destroys a crashed HUD once, broadcasts closed, and creates a fresh window on reopen', async () => {
    const created: FakeWindow[] = []
    const states: unknown[] = []
    const controller = new HudWindowController({
      preloadPath: 'preload.cjs',
      store: fakeStore(),
      getMainWindow: () => undefined,
      loadWindow: async () => undefined,
      createWindow: (options) => {
        const window = new FakeWindow(options)
        created.push(window)
        return window.asBrowserWindow()
      },
      displayProvider: staticDisplays([{ x: 0, y: 0, width: 1280, height: 720 }])
    })
    await controller.open(TARGET)
    await controller.setIgnoreMouseEvents(true)
    controller.subscribe((state) => states.push(state))

    created[0]?.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    const replacement = { ...TARGET, threadId: 'thread-after-crash' }
    await expect(controller.open(replacement)).resolves.toMatchObject({ state: 'expanded', target: replacement })

    expect(created).toHaveLength(2)
    expect(created[0]?.ignoresMouseEvents).toBe(false)
    expect(created[0]?.destroyed).toBe(true)
    expect(created[1]?.destroyed).toBe(false)
    expect(states.filter((state) => (state as { state?: string }).state === 'closed')).toHaveLength(1)
    expect(controller.state()).toMatchObject({ state: 'expanded', target: replacement })
  })

  it('restores or recreates the workbench and closes the HUD without quitting', async () => {
    const hud = new FakeWindow({ width: 620, height: 380 })
    const workbench = new FakeWindow({ width: 1000, height: 700 })
    workbench.visible = false
    workbench.minimized = true
    const lifecycleOrder: string[] = []
    const restoreMainWindow = vi.fn(() => {
      lifecycleOrder.push('restore-workbench')
      return workbench.asBrowserWindow()
    })
    const destroyHud = hud.destroy.bind(hud)
    hud.destroy = (): void => {
      lifecycleOrder.push('destroy-hud')
      destroyHud()
    }
    const controller = new HudWindowController({
      preloadPath: 'preload.cjs',
      store: fakeStore(),
      getMainWindow: () => undefined,
      restoreMainWindow,
      loadWindow: async () => undefined,
      createWindow: () => hud.asBrowserWindow(),
      displayProvider: staticDisplays([{ x: 0, y: 0, width: 1280, height: 720 }])
    })
    await controller.open(TARGET)
    await controller.returnToWorkbench()

    expect(restoreMainWindow).toHaveBeenCalledOnce()
    expect(workbench.restored).toBe(true)
    expect(workbench.visible).toBe(true)
    expect(workbench.focused).toBe(true)
    expect(hud.destroyed).toBe(true)
    expect(lifecycleOrder).toEqual(['restore-workbench', 'destroy-hud'])
  })

  it('finishes an in-flight close before creating a later reopened HUD', async () => {
    const writeStarted = deferred<void>()
    const allowWrite = deferred<void>()
    const store = fakeStore()
    store.write.mockImplementationOnce(async () => {
      writeStarted.resolve()
      await allowWrite.promise
    })
    const created: FakeWindow[] = []
    const controller = new HudWindowController({
      preloadPath: 'preload.cjs',
      store,
      getMainWindow: () => undefined,
      loadWindow: async () => undefined,
      createWindow: (options) => {
        const window = new FakeWindow(options)
        created.push(window)
        return window.asBrowserWindow()
      },
      displayProvider: staticDisplays([{ x: 0, y: 0, width: 1280, height: 720 }])
    })
    await controller.open(TARGET)

    const close = controller.close()
    await writeStarted.promise
    const replacement = { ...TARGET, threadId: 'thread-after-close' }
    const reopen = controller.open(replacement)
    expect(created).toHaveLength(1)
    expect(created[0]?.destroyed).toBe(false)

    allowWrite.resolve()
    await close
    await expect(reopen).resolves.toMatchObject({ state: 'expanded', target: replacement })
    expect(created).toHaveLength(2)
    expect(created[0]?.destroyed).toBe(true)
    expect(created[1]?.destroyed).toBe(false)
    expect(controller.window()).toBe(created[1]?.asBrowserWindow())
  })

  it('lets an in-flight load settle before disposal and rejects a later queued reopen', async () => {
    const loadStarted = deferred<void>()
    const allowLoad = deferred<void>()
    const created: FakeWindow[] = []
    const controller = new HudWindowController({
      preloadPath: 'preload.cjs',
      store: fakeStore(),
      getMainWindow: () => undefined,
      loadWindow: async () => {
        loadStarted.resolve()
        await allowLoad.promise
      },
      createWindow: (options) => {
        const window = new FakeWindow(options)
        created.push(window)
        return window.asBrowserWindow()
      },
      displayProvider: staticDisplays([{ x: 0, y: 0, width: 1280, height: 720 }])
    })

    const opening = controller.open(TARGET)
    await loadStarted.promise
    const disposal = controller.dispose()
    const reopenAfterDispose = controller.open({ ...TARGET, threadId: 'must-not-open' })
    allowLoad.resolve()

    await expect(opening).resolves.toMatchObject({ state: 'expanded', target: TARGET })
    await disposal
    await expect(reopenAfterDispose).rejects.toMatchObject({ code: 'hud.disposed' })
    expect(created).toHaveLength(1)
    expect(created[0]?.destroyed).toBe(true)
    expect(controller.window()).toBeUndefined()
    expect(controller.state()).toEqual({ state: 'closed' })
  })
})

describe('registerHudIpc', () => {
  it('enforces exact main/HUD roles, strict path-free targets, and bounded state fan-out', async () => {
    const main = new FakeWindow({ width: 1000, height: 700 })
    const hud = new FakeWindow({ width: 620, height: 380 })
    const controller = new HudWindowController({
      preloadPath: 'preload.cjs',
      store: fakeStore(),
      getMainWindow: () => main.asBrowserWindow(),
      loadWindow: async () => undefined,
      createWindow: () => hud.asBrowserWindow(),
      displayProvider: staticDisplays([{ x: 0, y: 0, width: 1280, height: 720 }])
    })
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>) => {
        handlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel))
    }
    const mainEvent = eventFor(main)
    const hudEvent = eventFor(hud)
    const untrustedEvent = eventFor(new FakeWindow({ width: 1, height: 1 }))
    const unregister = registerHudIpc({
      ipcMain,
      controller,
      isTrustedMainSender: (event) => event.sender === (main.webContents as unknown as WebContents),
      isTrustedHudSender: (event, window) => event.sender === window.webContents
    })

    const open = handlers.get(HUD_IPC.open)!
    await expect(open(untrustedEvent, TARGET)).resolves.toMatchObject({
      ok: false,
      error: { code: 'ipc.untrusted_sender' }
    })
    await expect(open(mainEvent, { ...TARGET, workspacePath: 'C:\\private' })).resolves.toMatchObject({ ok: false })
    await expect(open(mainEvent, TARGET)).resolves.toMatchObject({ ok: true, value: { state: 'expanded' } })

    await expect(handlers.get(HUD_IPC.setMode)!(mainEvent, 'buddy')).resolves.toMatchObject({
      ok: false,
      error: { code: 'ipc.untrusted_sender' }
    })
    await expect(handlers.get(HUD_IPC.setMode)!(hudEvent, 'buddy')).resolves.toMatchObject({
      ok: true,
      value: { state: 'buddy' }
    })
    expect(main.webContents.send).toHaveBeenCalledWith(HUD_IPC.stateChanged, expect.objectContaining({ state: 'buddy' }))
    expect(hud.webContents.send).toHaveBeenCalledWith(HUD_IPC.stateChanged, expect.objectContaining({ state: 'buddy' }))

    await expect(handlers.get(HUD_IPC.close)!(hudEvent)).resolves.toMatchObject({
      ok: true,
      value: { state: 'closed' }
    })
    expect(main.webContents.send).toHaveBeenCalledWith(HUD_IPC.stateChanged, { state: 'closed' })
    expect(hud.webContents.send).toHaveBeenCalledWith(HUD_IPC.stateChanged, { state: 'closed' })
    expect(hud.destroyed).toBe(true)

    unregister()
    expect(handlers.size).toBe(0)
  })
})

class FakeDisplays extends EventEmitter implements HudDisplayProvider {
  constructor(public areas: Rectangle[]) {
    super()
  }

  getAllDisplays(): Array<{ workArea: Rectangle }> {
    return this.areas.map((workArea) => ({ workArea }))
  }
}

class FakeWindow extends EventEmitter {
  readonly options: BrowserWindowConstructorOptions
  readonly webContents = Object.assign(new EventEmitter(), {
    id: nextWebContentsId++,
    mainFrame: { url: 'file:///renderer/index.html' },
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  })
  bounds: Rectangle
  visible = false
  minimized = false
  destroyed = false
  focused = false
  restored = false
  resizable = true
  ignoresMouseEvents = false

  constructor(options: BrowserWindowConstructorOptions) {
    super()
    this.options = options
    this.bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 800,
      height: options.height ?? 600
    }
  }

  asBrowserWindow(): BrowserWindow {
    return this as unknown as BrowserWindow
  }

  isDestroyed(): boolean { return this.destroyed }
  isVisible(): boolean { return this.visible }
  isMinimized(): boolean { return this.minimized }
  show(): void { this.visible = true; this.focused = true }
  hide(): void { this.visible = false }
  focus(): void { this.focused = true }
  restore(): void { this.minimized = false; this.restored = true }
  setResizable(value: boolean): void { this.resizable = value }
  setMinimumSize(): void {}
  setIgnoreMouseEvents(ignore: boolean): void { this.ignoresMouseEvents = ignore }
  getBounds(): Rectangle { return { ...this.bounds } }
  setBounds(bounds: Rectangle): void { this.bounds = { ...bounds } }
  destroy(): void { this.destroyed = true; this.emit('closed') }
}

function staticDisplays(areas: Rectangle[]): HudDisplayProvider {
  return { getAllDisplays: () => areas.map((workArea) => ({ workArea })) }
}

function fakeStore(initial: unknown = undefined): HudWindowPreferencesStore & {
  write: ReturnType<typeof vi.fn<(value: HudWindowPreferences) => Promise<void>>>
} {
  return {
    read: vi.fn(async () => initial),
    write: vi.fn(async () => undefined)
  }
}

function eventFor(window: FakeWindow): IpcMainInvokeEvent {
  return {
    sender: window.webContents as unknown as WebContents,
    senderFrame: window.webContents.mainFrame
  } as unknown as IpcMainInvokeEvent
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
