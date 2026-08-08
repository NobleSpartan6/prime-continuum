import {
  BrowserWindow,
  screen,
  type BrowserWindowConstructorOptions,
  type IpcMain,
  type IpcMainInvokeEvent,
  type Rectangle,
  type WebContents
} from 'electron'
import { z } from 'zod'
import {
  HUD_IPC,
  type HudMode,
  type HudResult,
  type HudState,
  type HudTarget
} from '../shared/window-control'
import { IdSchema } from '../shared/protocol'
import { AtomicJsonStore } from './control/storage'
import { ControlError, toStructuredError } from './control/errors'
import { secureWebPreferences } from './window-security'

const HUD_PREFERENCES_VERSION = 1 as const
const HUD_PREFERENCES_MAX_BYTES = 16 * 1024
const BOUNDS_WRITE_DELAY_MS = 180

export const HUD_WINDOW_SIZE = {
  buddy: { width: 184, height: 64 },
  expanded: { width: 620, height: 380, minWidth: 320, minHeight: 240 }
} as const

export interface HudWindowPreferences {
  version: typeof HUD_PREFERENCES_VERSION
  lastMode: HudMode
  bounds: Partial<Record<HudMode, Rectangle>>
}

export interface HudWindowPreferencesStore {
  read(): Promise<unknown>
  write(value: HudWindowPreferences): Promise<void>
}

export interface HudDisplayProvider {
  getAllDisplays(): ReadonlyArray<{ workArea: Rectangle }>
  on?(event: 'display-added' | 'display-removed' | 'display-metrics-changed', listener: () => void): unknown
  removeListener?(event: 'display-added' | 'display-removed' | 'display-metrics-changed', listener: () => void): unknown
}

export interface HudWindowControllerOptions {
  preloadPath: string
  store: HudWindowPreferencesStore
  getMainWindow: () => BrowserWindow | undefined
  /** May recreate the workbench after the user closed it while keeping the HUD. */
  restoreMainWindow?: () => BrowserWindow | undefined
  /** The root owns the trusted renderer URL and app/session navigation policy. */
  loadWindow: (window: BrowserWindow) => Promise<void>
  hardenWindow?: (window: BrowserWindow) => void
  createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow
  displayProvider?: HudDisplayProvider
  onError?: (error: unknown) => void
}

export interface RegisterHudIpcOptions {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  controller: HudWindowController
  isTrustedMainSender: (event: IpcMainInvokeEvent) => boolean
  /** Optional URL-policy fence in addition to exact HUD webContents identity. */
  isTrustedHudSender?: (event: IpcMainInvokeEvent, window: BrowserWindow) => boolean
}

const HudTargetSchema = z
  .object({
    expectedHostId: IdSchema,
    threadId: IdSchema,
    expectedExecutionGenerationId: IdSchema
  })
  .strict()
const HudModeSchema = z.enum(['buddy', 'expanded'])

/** Build the bounded, replace-only geometry store used by the desktop HUD. */
export function createHudWindowPreferencesStore(filePath: string): HudWindowPreferencesStore {
  return new AtomicJsonStore<unknown>(
    filePath,
    defaultHudWindowPreferences,
    HUD_PREFERENCES_MAX_BYTES,
    { malformedJson: 'fallback' }
  )
}

export function defaultHudWindowPreferences(): HudWindowPreferences {
  return { version: HUD_PREFERENCES_VERSION, lastMode: 'expanded', bounds: {} }
}

/**
 * Selects a visible work area and clamps the whole HUD into it. This handles
 * negative monitor coordinates and safely rehomes bounds from removed screens.
 */
export function clampHudBounds(
  mode: HudMode,
  candidate: Rectangle | undefined,
  workAreas: readonly Rectangle[]
): Rectangle {
  const areas = workAreas.filter(isUsableWorkArea)
  const fallbackArea: Rectangle = areas[0] ?? { x: 0, y: 0, width: 1280, height: 720 }
  const workArea = candidate ? nearestWorkArea(candidate, areas) ?? fallbackArea : fallbackArea
  const desired = dimensionsForMode(mode, candidate, workArea)
  const margin = 24
  const defaultX = workArea.x + workArea.width - desired.width - margin
  const defaultY = workArea.y + workArea.height - desired.height - margin
  const requestedX = candidate && Number.isFinite(candidate.x) ? Math.round(candidate.x) : defaultX
  const requestedY = candidate && Number.isFinite(candidate.y) ? Math.round(candidate.y) : defaultY
  const maxX = workArea.x + workArea.width - desired.width
  const maxY = workArea.y + workArea.height - desired.height

  return {
    x: clamp(requestedX, workArea.x, Math.max(workArea.x, maxX)),
    y: clamp(requestedY, workArea.y, Math.max(workArea.y, maxY)),
    width: desired.width,
    height: desired.height
  }
}

export class HudWindowController {
  private readonly options: HudWindowControllerOptions
  private preferences = defaultHudWindowPreferences()
  private initializePromise: Promise<void> | undefined
  private createPromise: Promise<BrowserWindow> | undefined
  private hudWindow: BrowserWindow | undefined
  private target: HudTarget | undefined
  private mode: HudMode = 'expanded'
  private ignoresMouseEvents = false
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private displayListenersAttached = false
  private disposed = false
  private operationTail: Promise<void> = Promise.resolve()
  private readonly renderProcessesGone = new WeakSet<BrowserWindow>()
  private readonly listeners = new Set<(state: HudState) => void>()
  private readonly handleDisplaysChanged = (): void => {
    void this.runExclusive(async () => {
      if (!this.disposed) this.rehomeForDisplays()
    }).catch((error) => this.reportError(error))
  }

  constructor(options: HudWindowControllerOptions) {
    this.options = options
  }

  async initialize(): Promise<void> {
    if (this.initializePromise) return await this.initializePromise
    this.initializePromise = this.loadPreferences()
    return await this.initializePromise
  }

  open(target: HudTarget): Promise<HudState> {
    const capturedTarget = cloneTarget(target)
    return this.runExclusive(() => this.openUnlocked(capturedTarget))
  }

  private async openUnlocked(target: HudTarget): Promise<HudState> {
    this.assertUsable()
    await this.initialize()
    const window = await this.ensureWindow()
    this.target = cloneTarget(target)
    this.mode = this.preferences.lastMode
    this.ignoresMouseEvents = false
    window.setIgnoreMouseEvents(false)
    this.applyMode(window, this.mode)
    if (!window.isVisible()) window.show()
    else window.focus()
    this.emitState()
    return this.state()
  }

  state(): HudState {
    if (!this.target || !this.window()) return { state: 'closed' }
    return {
      state: this.mode,
      target: cloneTarget(this.target),
      ignoresMouseEvents: this.ignoresMouseEvents
    }
  }

  setMode(mode: HudMode): Promise<HudState> {
    return this.runExclusive(() => this.setModeUnlocked(mode))
  }

  private async setModeUnlocked(mode: HudMode): Promise<HudState> {
    const window = this.requireOpenWindow()
    this.captureBounds(window, this.mode)
    this.mode = mode
    this.preferences.lastMode = mode
    this.ignoresMouseEvents = false
    window.setIgnoreMouseEvents(false)
    this.applyMode(window, mode)
    await this.persistPreferences()
    window.focus()
    this.emitState()
    return this.state()
  }

  close(): Promise<HudState> {
    return this.runExclusive(() => this.closeUnlocked())
  }

  private async closeUnlocked(): Promise<HudState> {
    const window = this.hudWindow
    if (window && !window.isDestroyed()) {
      this.captureBounds(window, this.mode)
      window.setIgnoreMouseEvents(false)
      await this.persistPreferences()
    }
    this.target = undefined
    this.ignoresMouseEvents = false
    this.emitState()
    if (window && !window.isDestroyed()) {
      // Give the closed-state fan-out a turn before its sender disappears.
      await new Promise<void>((resolve) => setImmediate(resolve))
      window.destroy()
    }
    return { state: 'closed' }
  }

  returnToWorkbench(): Promise<void> {
    return this.runExclusive(() => this.returnToWorkbenchUnlocked())
  }

  private async returnToWorkbenchUnlocked(): Promise<void> {
    const mainWindow = (this.options.restoreMainWindow ?? this.options.getMainWindow)()
    await this.closeUnlocked()
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }

  setIgnoreMouseEvents(ignore: boolean): Promise<HudState> {
    return this.runExclusive(() => this.setIgnoreMouseEventsUnlocked(ignore))
  }

  private async setIgnoreMouseEventsUnlocked(ignore: boolean): Promise<HudState> {
    const window = this.requireOpenWindow()
    this.ignoresMouseEvents = ignore
    if (ignore) window.setIgnoreMouseEvents(true, { forward: true })
    else window.setIgnoreMouseEvents(false)
    this.emitState()
    return this.state()
  }

  window(): BrowserWindow | undefined {
    return this.hudWindow && !this.hudWindow.isDestroyed() && !this.renderProcessesGone.has(this.hudWindow)
      ? this.hudWindow
      : undefined
  }

  workbenchWindow(): BrowserWindow | undefined {
    const window = this.options.getMainWindow()
    return window && !window.isDestroyed() ? window : undefined
  }

  owns(window: BrowserWindow | undefined): boolean {
    return window !== undefined && window === this.window()
  }

  ownsWebContents(webContents: WebContents): boolean {
    return this.window()?.webContents === webContents
  }

  isHudSender(event: IpcMainInvokeEvent): boolean {
    const window = this.window()
    return Boolean(
      window &&
      !window.webContents.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame
    )
  }

  subscribe(listener: (state: HudState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): Promise<void> {
    return this.runExclusive(() => this.disposeUnlocked())
  }

  private async disposeUnlocked(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    this.detachDisplayListeners()
    const window = this.hudWindow
    if (window && !window.isDestroyed()) {
      this.captureBounds(window, this.mode)
      await this.persistPreferences()
      window.destroy()
    }
    this.hudWindow = undefined
    this.target = undefined
    this.listeners.clear()
  }

  private async loadPreferences(): Promise<void> {
    try {
      this.preferences = normalizePreferences(await this.options.store.read())
    } catch (error) {
      this.reportError(error)
      this.preferences = defaultHudWindowPreferences()
    }
    this.mode = this.preferences.lastMode
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    const existing = this.window()
    if (existing) return existing
    if (this.createPromise) return await this.createPromise
    this.createPromise = this.createHudWindow()
    try {
      return await this.createPromise
    } finally {
      this.createPromise = undefined
    }
  }

  private async createHudWindow(): Promise<BrowserWindow> {
    this.attachDisplayListeners()
    const bounds = this.boundsForMode(this.mode)
    const createWindow = this.options.createWindow ?? ((options) => new BrowserWindow(options))
    const window = createWindow({
      ...bounds,
      minWidth: Math.min(HUD_WINDOW_SIZE.expanded.minWidth, bounds.width),
      minHeight: Math.min(HUD_WINDOW_SIZE.expanded.minHeight, bounds.height),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      skipTaskbar: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      resizable: this.mode === 'expanded',
      useContentSize: true,
      title: 'Prime Continuim desktop HUD',
      webPreferences: secureWebPreferences(this.options.preloadPath)
    })
    this.hudWindow = window
    this.options.hardenWindow?.(window)

    const rememberBounds = (): void => this.scheduleBoundsPersistence()
    const settleBounds = (): void => {
      void this.runExclusive(() => this.settleLiveBounds(window)).catch((error) => this.reportError(error))
    }
    const handleRenderProcessGone = (): void => {
      this.renderProcessesGone.add(window)
      try {
        window.setIgnoreMouseEvents(false)
      } catch (error) {
        this.reportError(error)
      }
      void this.runExclusive(() => this.recoverRenderProcessGone(window)).catch((error) => this.reportError(error))
    }
    const handleClosed = (): void => {
      if (this.hudWindow !== window) return
      const wasOpen = Boolean(this.target)
      this.hudWindow = undefined
      this.target = undefined
      this.ignoresMouseEvents = false
      this.detachDisplayListeners()
      if (wasOpen) this.emitState()
    }
    window.on('move', rememberBounds)
    window.on('resize', rememberBounds)
    window.on('moved', settleBounds)
    window.on('resized', settleBounds)
    window.once('closed', handleClosed)
    window.webContents.once('render-process-gone', handleRenderProcessGone)

    try {
      await this.options.loadWindow(window)
      if (window.isDestroyed() || this.renderProcessesGone.has(window)) {
        throw new ControlError('hud.window_closed', 'The desktop HUD closed before it loaded.')
      }
      this.applyMode(window, this.mode)
      return window
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      if (this.hudWindow === window) this.hudWindow = undefined
      throw error
    }
  }

  private applyMode(window: BrowserWindow, mode: HudMode): void {
    const bounds = this.boundsForMode(mode)
    this.preferences.bounds[mode] = { ...bounds }
    if (mode === 'buddy') {
      window.setResizable(false)
      window.setMinimumSize(HUD_WINDOW_SIZE.buddy.width, HUD_WINDOW_SIZE.buddy.height)
    } else {
      window.setMinimumSize(
        Math.min(HUD_WINDOW_SIZE.expanded.minWidth, bounds.width),
        Math.min(HUD_WINDOW_SIZE.expanded.minHeight, bounds.height)
      )
      window.setResizable(true)
    }
    window.setBounds(bounds, false)
  }

  private boundsForMode(mode: HudMode): Rectangle {
    return clampHudBounds(
      mode,
      this.preferences.bounds[mode],
      this.displayProvider().getAllDisplays().map((display) => display.workArea)
    )
  }

  private captureBounds(window: BrowserWindow, mode: HudMode): void {
    if (window.isDestroyed()) return
    this.preferences.bounds[mode] = clampHudBounds(
      mode,
      window.getBounds(),
      this.displayProvider().getAllDisplays().map((display) => display.workArea)
    )
  }

  private rehomeForDisplays(): void {
    const window = this.window()
    if (!window) return
    const bounds = clampHudBounds(
      this.mode,
      window.getBounds(),
      this.displayProvider().getAllDisplays().map((display) => display.workArea)
    )
    this.preferences.bounds[this.mode] = { ...bounds }
    window.setBounds(bounds, false)
    this.scheduleBoundsPersistence()
  }

  private async settleLiveBounds(window: BrowserWindow): Promise<void> {
    if (this.disposed || this.hudWindow !== window || window.isDestroyed() || this.renderProcessesGone.has(window)) return
    const bounds = clampHudBounds(
      this.mode,
      window.getBounds(),
      this.displayProvider().getAllDisplays().map((display) => display.workArea)
    )
    this.preferences.bounds[this.mode] = { ...bounds }
    if (!sameBounds(window.getBounds(), bounds)) window.setBounds(bounds, false)
    await this.persistPreferences()
  }

  private async recoverRenderProcessGone(window: BrowserWindow): Promise<void> {
    if (this.hudWindow !== window) return
    const wasOpen = Boolean(this.target)
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    this.hudWindow = undefined
    this.target = undefined
    this.ignoresMouseEvents = false
    this.detachDisplayListeners()
    try {
      window.setIgnoreMouseEvents(false)
    } catch (error) {
      this.reportError(error)
    }
    try {
      if (!window.isDestroyed()) window.destroy()
    } catch (error) {
      this.reportError(error)
    }
    if (wasOpen) this.emitState()
  }

  private displayProvider(): HudDisplayProvider {
    return this.options.displayProvider ?? screen
  }

  private attachDisplayListeners(): void {
    if (this.displayListenersAttached) return
    const provider = this.displayProvider()
    if (!provider.on || !provider.removeListener) return
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed'] as const) {
      provider.on(event, this.handleDisplaysChanged)
    }
    this.displayListenersAttached = true
  }

  private detachDisplayListeners(): void {
    if (!this.displayListenersAttached) return
    const provider = this.displayProvider()
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed'] as const) {
      provider.removeListener?.(event, this.handleDisplaysChanged)
    }
    this.displayListenersAttached = false
  }

  private scheduleBoundsPersistence(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      void this.runExclusive(async () => {
        if (this.disposed) return
        const window = this.window()
        if (window) this.captureBounds(window, this.mode)
        await this.persistPreferences()
      }).catch((error) => this.reportError(error))
    }, BOUNDS_WRITE_DELAY_MS)
    this.persistTimer.unref?.()
  }

  private async persistPreferences(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    try {
      await this.options.store.write(clonePreferences(this.preferences))
    } catch (error) {
      this.reportError(error)
    }
  }

  private requireOpenWindow(): BrowserWindow {
    this.assertUsable()
    const window = this.window()
    if (!window || !this.target) {
      throw new ControlError('hud.closed', 'The desktop HUD is not open.')
    }
    return window
  }

  private assertUsable(): void {
    if (this.disposed) throw new ControlError('hud.disposed', 'The desktop HUD controller has shut down.')
  }

  private emitState(): void {
    const state = this.state()
    for (const listener of this.listeners) listener(state)
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error)
    } catch {
      // Diagnostics must never interrupt native HUD containment or teardown.
    }
  }
}

/** Register the narrow role-gated native HUD bridge. */
export function registerHudIpc(options: RegisterHudIpcOptions): () => void {
  const { ipcMain, controller, isTrustedMainSender, isTrustedHudSender } = options
  const channels: string[] = []

  const hudSenderIsTrusted = (event: IpcMainInvokeEvent): boolean => {
    const window = controller.window()
    return Boolean(
      window &&
      controller.isHudSender(event) &&
      (isTrustedHudSender?.(event, window) ?? true)
    )
  }
  const trustedStateReader = (event: IpcMainInvokeEvent): boolean =>
    isTrustedMainSender(event) || hudSenderIsTrusted(event)

  const handle = <TInput, TOutput>(
    channel: string,
    schema: z.ZodType<TInput>,
    authorize: (event: IpcMainInvokeEvent) => boolean,
    operation: (input: TInput) => Promise<TOutput> | TOutput
  ): void => {
    channels.push(channel)
    ipcMain.handle(channel, async (event, rawInput): Promise<HudResult<TOutput>> => {
      try {
        if (!authorize(event)) {
          throw new ControlError('ipc.untrusted_sender', 'The HUD request did not come from its authorized app surface.')
        }
        assertBoundedHudIpcInput(rawInput)
        const input = schema.parse(rawInput)
        return { ok: true, value: await operation(input) }
      } catch (error) {
        return { ok: false, error: toStructuredError(error) }
      }
    })
  }

  handle(HUD_IPC.open, HudTargetSchema, isTrustedMainSender, (target) => controller.open(target))
  handle(HUD_IPC.state, z.undefined(), trustedStateReader, () => controller.state())
  handle(HUD_IPC.setMode, HudModeSchema, hudSenderIsTrusted, (mode) => controller.setMode(mode))
  handle(HUD_IPC.close, z.undefined(), hudSenderIsTrusted, () => controller.close())
  handle(HUD_IPC.returnToWorkbench, z.undefined(), hudSenderIsTrusted, () => controller.returnToWorkbench())
  handle(HUD_IPC.setIgnoreMouseEvents, z.boolean(), hudSenderIsTrusted, (ignore) =>
    controller.setIgnoreMouseEvents(ignore)
  )

  const unsubscribe = controller.subscribe((state) => {
    const delivered = new Set<number>()
    for (const window of [options.controller.window(), options.controller.workbenchWindow()]) {
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) continue
      if (delivered.has(window.webContents.id)) continue
      delivered.add(window.webContents.id)
      window.webContents.send(HUD_IPC.stateChanged, state)
    }
  })

  return () => {
    unsubscribe()
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}

function normalizePreferences(value: unknown): HudWindowPreferences {
  if (!isRecord(value) || value.version !== HUD_PREFERENCES_VERSION) return defaultHudWindowPreferences()
  const lastMode: HudMode = value.lastMode === 'buddy' || value.lastMode === 'expanded' ? value.lastMode : 'expanded'
  const rawBounds = isRecord(value.bounds) ? value.bounds : {}
  const bounds: Partial<Record<HudMode, Rectangle>> = {}
  const buddy = normalizeRectangle(rawBounds.buddy)
  const expanded = normalizeRectangle(rawBounds.expanded)
  if (buddy) bounds.buddy = buddy
  if (expanded) bounds.expanded = expanded
  return { version: HUD_PREFERENCES_VERSION, lastMode, bounds }
}

function normalizeRectangle(value: unknown): Rectangle | undefined {
  if (!isRecord(value)) return undefined
  const values = [value.x, value.y, value.width, value.height]
  if (!values.every((entry) => typeof entry === 'number' && Number.isSafeInteger(entry))) return undefined
  const [x, y, width, height] = values as [number, number, number, number]
  if (Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000 || width < 1 || height < 1 || width > 100_000 || height > 100_000) {
    return undefined
  }
  return { x, y, width, height }
}

function clonePreferences(value: HudWindowPreferences): HudWindowPreferences {
  return {
    version: HUD_PREFERENCES_VERSION,
    lastMode: value.lastMode,
    bounds: Object.fromEntries(
      Object.entries(value.bounds).map(([mode, bounds]) => [mode, bounds ? { ...bounds } : bounds])
    ) as Partial<Record<HudMode, Rectangle>>
  }
}

function cloneTarget(target: HudTarget): HudTarget {
  return {
    expectedHostId: target.expectedHostId,
    threadId: target.threadId,
    expectedExecutionGenerationId: target.expectedExecutionGenerationId
  }
}

function dimensionsForMode(mode: HudMode, candidate: Rectangle | undefined, area: Rectangle): { width: number; height: number } {
  if (mode === 'buddy') {
    return {
      width: Math.min(HUD_WINDOW_SIZE.buddy.width, area.width),
      height: Math.min(HUD_WINDOW_SIZE.buddy.height, area.height)
    }
  }
  return {
    width: clamp(
      candidate?.width ?? HUD_WINDOW_SIZE.expanded.width,
      Math.min(HUD_WINDOW_SIZE.expanded.minWidth, area.width),
      area.width
    ),
    height: clamp(
      candidate?.height ?? HUD_WINDOW_SIZE.expanded.height,
      Math.min(HUD_WINDOW_SIZE.expanded.minHeight, area.height),
      area.height
    )
  }
}

function nearestWorkArea(candidate: Rectangle, workAreas: readonly Rectangle[]): Rectangle | undefined {
  let best: Rectangle | undefined
  let bestOverlap = -1
  let bestDistance = Number.POSITIVE_INFINITY
  const candidateCenterX = candidate.x + candidate.width / 2
  const candidateCenterY = candidate.y + candidate.height / 2

  for (const area of workAreas) {
    const overlapWidth = Math.max(0, Math.min(candidate.x + candidate.width, area.x + area.width) - Math.max(candidate.x, area.x))
    const overlapHeight = Math.max(0, Math.min(candidate.y + candidate.height, area.y + area.height) - Math.max(candidate.y, area.y))
    const overlap = overlapWidth * overlapHeight
    const centerX = area.x + area.width / 2
    const centerY = area.y + area.height / 2
    const distance = (candidateCenterX - centerX) ** 2 + (candidateCenterY - centerY) ** 2
    if (overlap > bestOverlap || (overlap === bestOverlap && distance < bestDistance)) {
      best = area
      bestOverlap = overlap
      bestDistance = distance
    }
  }
  return best
}

function isUsableWorkArea(area: Rectangle): boolean {
  return [area.x, area.y, area.width, area.height].every(Number.isFinite) && area.width > 0 && area.height > 0
}

function sameBounds(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.round(Math.min(Math.max(value, minimum), maximum))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertBoundedHudIpcInput(value: unknown): void {
  if (value === undefined) return
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch (cause) {
    throw new ControlError('ipc.invalid_payload', 'The HUD request payload is not serializable.', { cause })
  }
  if (Buffer.byteLength(serialized, 'utf8') > 4 * 1024) {
    throw new ControlError('ipc.payload_limit', 'The HUD request payload is too large.')
  }
}
