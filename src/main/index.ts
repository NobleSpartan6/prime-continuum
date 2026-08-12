import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions, type Session } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isTrustedRendererSender, registerControlIpc } from './control/ipc'
import type { ConnectionState } from './control/contracts'
import { stopPackageSmokeHostds } from './control/local-hostd'
import { DesktopControlService } from './control/service'
import {
  createHudWindowPreferencesStore,
  HudWindowController,
  registerHudIpc,
} from './hud-window'
import { installOrderlyQuitDrain } from './orderly-quit'
import { installNativeMenu } from './native-menu'
import { resolvePreloadEntry } from './window-paths'
import { secureWebPreferences } from './window-security'
import { RESIDENT_LIFECYCLE_CAPABILITY } from '../shared/protocol'
import { NATIVE_SHELL_IPC, type NativeShellCommand } from '../shared/native-shell'

let mainWindow: BrowserWindow | undefined
let trustedRendererUrl = ''
let unregisterIpc: (() => void) | undefined
let unregisterHudIpc: (() => void) | undefined
let unregisterOrderlyQuit: (() => void) | undefined
let hudWindowController: HudWindowController | undefined
const configuredSessions = new WeakSet<Session>()
const PACKAGE_SMOKE_MARKER = 'PRIME_CONTINUIM_PACKAGE_SMOKE_OK'

function createWindow(loadImmediately = true, showWhenReady = true): BrowserWindow {
  const rendererFile = path.join(__dirname, '../renderer/index.html')
  trustedRendererUrl = process.env.ELECTRON_RENDERER_URL || pathToFileURL(rendererFile).href

  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#0c0d0e',
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 18 },
        }
      : {}),
    webPreferences: secureWebPreferences(resolvePreloadEntry(__dirname))
  })

  hardenRendererWindow(window)

  if (showWhenReady) window.once('ready-to-show', () => window.show())
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })

  if (loadImmediately) loadRenderer(window, rendererFile)
  return window
}

function ensureMainWindow(): BrowserWindow {
  const existing = mainWindow
  if (existing && !existing.isDestroyed()) return existing
  mainWindow = createWindow()
  return mainWindow
}

function showMainWindow(): BrowserWindow {
  const existing = mainWindow
  const window = ensureMainWindow()
  if (window.isMinimized()) window.restore()
  if (!existing || existing.isDestroyed()) {
    window.once('ready-to-show', () => window.focus())
  } else {
    if (!window.isVisible()) window.show()
    window.focus()
  }
  return window
}

function dispatchNativeShellCommand(command: NativeShellCommand): void {
  const window = showMainWindow()
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send(NATIVE_SHELL_IPC.command, command)
  }
  if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', send)
  else send()
}

function trustedRendererWindows(): BrowserWindow[] {
  const windows = [mainWindow, hudWindowController?.window()]
  return windows.filter((window): window is BrowserWindow => Boolean(window && !window.isDestroyed()))
}

function hardenRendererWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isSameDocumentNavigation(window.webContents.getURL(), url)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  configureSession(window.webContents.session)
}

function configureSession(session: Session): void {
  if (configuredSessions.has(session)) return
  configuredSessions.add(session)
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  session.on('will-download', (event) => event.preventDefault())
  session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      let allowed = false
      if (process.env.ELECTRON_RENDERER_URL) {
        try {
          const actual = new URL(details.url)
          const expected = new URL(trustedRendererUrl)
          allowed =
            actual.hostname === expected.hostname &&
            actual.port === expected.port &&
            (actual.protocol === expected.protocol ||
              (expected.protocol === 'http:' && actual.protocol === 'ws:') ||
              (expected.protocol === 'https:' && actual.protocol === 'wss:'))
        } catch {
          allowed = false
        }
      }
      callback({ cancel: !allowed })
    }
  )
}

function loadRenderer(
  window: BrowserWindow,
  rendererFile = path.join(__dirname, '../renderer/index.html'),
  query?: Readonly<Record<string, string>>,
): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL)
    for (const [key, value] of Object.entries(query ?? {})) rendererUrl.searchParams.set(key, value)
    return window.loadURL(rendererUrl.href)
  }
  return window.loadFile(rendererFile, query ? { query: { ...query } } : undefined)
}

function isSameDocumentNavigation(currentValue: string, nextValue: string): boolean {
  if (!currentValue) return false
  try {
    const current = new URL(currentValue)
    const next = new URL(nextValue)
    current.hash = ''
    next.hash = ''
    return current.href === next.href
  } catch {
    return false
  }
}

function rendererUrlIsTrusted(candidate: string): boolean {
  try {
    const expected = new URL(trustedRendererUrl)
    const actual = new URL(candidate)
    if (expected.protocol === 'file:') {
      const normalize = (value: string): string =>
        process.platform === 'win32' ? decodeURIComponent(value).toLowerCase() : decodeURIComponent(value)
      return actual.protocol === 'file:' && normalize(actual.pathname) === normalize(expected.pathname)
    }
    return (
      actual.origin === expected.origin &&
      decodeURIComponent(actual.pathname) === decodeURIComponent(expected.pathname)
    )
  } catch {
    return false
  }
}

async function runPackageSmoke(window: BrowserWindow, service: DesktopControlService): Promise<void> {
  try {
    await loadRenderer(window)
    await waitForPackageSmokeConnection(window)
    const readyHostId = await waitForPackageSmokeRuntimeReady(service)
    await waitForPackageSmokeFirstRunReady(window, service, readyHostId)
  } finally {
    await service.disconnect()
    await stopPackageSmokeHostds()
  }
  process.stdout.write(`${PACKAGE_SMOKE_MARKER}\n`)
  app.quit()
}

async function waitForPackageSmokeFirstRunReady(
  window: BrowserWindow,
  service: DesktopControlService,
  expectedHostId: string,
): Promise<void> {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const before = service.getConnectionState()
    const stage = await window.webContents.executeJavaScript(
      "document.querySelector('[data-local-setup-stage]')?.getAttribute('data-local-setup-stage') ?? null",
      true
    )
    const after = service.getConnectionState()
    if (
      stage === 'choose_workspace' &&
      isPackageSmokeFirstRunAuthorityReady(before, expectedHostId) &&
      isPackageSmokeFirstRunAuthorityReady(after, expectedHostId)
    ) return
    if (
      (before.hostId && before.hostId !== expectedHostId) ||
      (after.hostId && after.hostId !== expectedHostId)
    ) {
      throw new Error('The packaged first-run setup changed local host authority before workspace setup was ready.')
    }
    if (
      stage === 'needs_attention' &&
      isPackageSmokeTerminalRuntimeFailure(before, expectedHostId) &&
      isPackageSmokeTerminalRuntimeFailure(after, expectedHostId)
    ) {
      throw new Error('The packaged first-run setup entered a needs-attention state.')
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error('The packaged first-run setup did not reach the workspace step within its deadline.')
}

async function waitForPackageSmokeRuntimeReady(service: DesktopControlService): Promise<string> {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const connection = service.getConnectionState()
    const readiness = connection.runtimeReadiness
    if (isPackageSmokeRuntimeReady(connection)) return connection.hostId as string
    if (
      readiness?.kind === 'reported' &&
      (readiness.snapshot.status === 'failed' || readiness.snapshot.status === 'unavailable')
    ) {
      throw new Error(`The packaged runtime failed readiness (${readiness.snapshot.status}).`)
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error('The packaged runtime did not become ready within its deadline.')
}

/**
 * Accept a package-smoke readiness sample only when every signal belongs to the
 * same live, verified local-host connection. A cached observation retained
 * while offline (or one produced by another host authority) must never make a
 * packaged build look ready.
 */
export function isPackageSmokeRuntimeReady(connection: ConnectionState): boolean {
  const readiness = connection.runtimeReadiness
  return (
    connection.phase === 'online' &&
    connection.path === 'local_socket' &&
    typeof connection.hostId === 'string' &&
    connection.hostId.length > 0 &&
    readiness?.kind === 'reported' &&
    readiness.hostId === connection.hostId &&
    readiness.snapshot.status === 'ready' &&
    connection.capabilities?.includes('runtime_integrity_v1') === true
  )
}

export function isPackageSmokeFirstRunAuthorityReady(
  connection: ConnectionState,
  expectedHostId: string,
): boolean {
  return (
    connection.hostId === expectedHostId &&
    isPackageSmokeRuntimeReady(connection) &&
    connection.capabilities?.includes(RESIDENT_LIFECYCLE_CAPABILITY) === true
  )
}

function isPackageSmokeTerminalRuntimeFailure(
  connection: ConnectionState,
  expectedHostId: string,
): boolean {
  const readiness = connection.runtimeReadiness
  return (
    connection.hostId === expectedHostId &&
    readiness?.kind === 'reported' &&
    readiness.hostId === expectedHostId &&
    (readiness.snapshot.status === 'failed' || readiness.snapshot.status === 'unavailable')
  )
}

async function waitForPackageSmokeConnection(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const diagnostics = await window.webContents.executeJavaScript(
      "window.prime && typeof window.prime.diagnostics === 'function' ? window.prime.diagnostics() : null",
      true
    )
    const connection = diagnostics?.ok === true ? diagnostics.value?.connection : undefined
    if (
      connection?.phase === 'online' &&
      connection.path === 'local_socket' &&
      typeof connection.hostId === 'string'
    ) {
      return
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('The packaged renderer did not establish a verified local host connection within its deadline.')
}

const ownsSingleInstance = app.requestSingleInstanceLock()

if (!ownsSingleInstance) {
  // A second Electron main must never open the same durable control ledgers.
  // The primary instance receives `second-instance` and restores its workbench.
  app.quit()
} else {
  initializePrimaryInstance()
}

function initializePrimaryInstance(): void {
  app.on('second-instance', () => {
    // `whenReady()` also covers the narrow startup interval before the first
    // workbench exists. `showMainWindow` intentionally never targets the HUD.
    void app.whenReady().then(() => {
      showMainWindow()
    })
  })

  void app.whenReady().then(async () => {
  app.setAppUserModelId('ai.primeintellect.continuim')
  const packageSmoke = process.env.PRIME_CONTINUIM_PACKAGE_SMOKE === '1'
  const service = new DesktopControlService({
    app,
    openExternal: async (url) => {
      await shell.openExternal(url)
    },
    selectDirectory: async () => {
      const options: OpenDialogOptions = {
        title: 'Choose a workspace folder',
        buttonLabel: 'Use workspace',
        properties: ['openDirectory', 'createDirectory']
      }
      const window = mainWindow
      const result = window && !window.isDestroyed()
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length !== 1) return undefined
      return result.filePaths[0]
    }
  })
  unregisterOrderlyQuit = installOrderlyQuitDrain(app, {
    drain: async () => {
      await service.shutdown()
      await hudWindowController?.dispose()
    },
    cleanup: () => {
      unregisterIpc?.()
      unregisterIpc = undefined
      unregisterHudIpc?.()
      unregisterHudIpc = undefined
      unregisterOrderlyQuit?.()
      unregisterOrderlyQuit = undefined
    },
    onError: (error) => {
      process.stderr.write(
        `Prime Continuim could not confirm sign-in shutdown: ${error instanceof Error ? error.message : 'unknown error'}\n`
      )
      // A failed drain deliberately keeps host ownership alive. If the user
      // closed the last HUD/workbench window first, restore a visible recovery
      // surface instead of leaving that safety state as a headless process.
      if (!packageSmoke) {
        try {
          showMainWindow()
        } catch (recoveryError) {
          process.stderr.write(
            `Prime Continuim could not restore the workbench after shutdown failed: ${recoveryError instanceof Error ? recoveryError.message : 'unknown error'}\n`
          )
        }
      }
    }
  })
  mainWindow = createWindow(false, !packageSmoke)
  installNativeMenu({ dispatch: dispatchNativeShellCommand })
  hudWindowController = new HudWindowController({
    preloadPath: resolvePreloadEntry(__dirname),
    store: createHudWindowPreferencesStore(path.join(app.getPath('userData'), 'hud-window.json')),
    getMainWindow: () => mainWindow,
    restoreMainWindow: () => ensureMainWindow(),
    loadWindow: (window) => loadRenderer(window, undefined, { surface: 'hud' }),
    hardenWindow: (window) => hardenRendererWindow(window),
    onError: (error) => {
      process.stderr.write(
        `Prime Continuim could not retain desktop HUD geometry: ${error instanceof Error ? error.message : 'unknown error'}\n`
      )
    },
  })
  unregisterIpc = registerControlIpc({
    ipcMain,
    service,
    getWindows: trustedRendererWindows,
    isTrustedSender: (event) =>
      isTrustedRendererSender(event, trustedRendererWindows(), rendererUrlIsTrusted),
    isTrustedWorkbenchSender: (event) =>
      isTrustedRendererSender(event, mainWindow ? [mainWindow] : [], rendererUrlIsTrusted),
  })
  unregisterHudIpc = registerHudIpc({
    ipcMain,
    controller: hudWindowController,
    isTrustedMainSender: (event) =>
      isTrustedRendererSender(event, mainWindow ? [mainWindow] : [], rendererUrlIsTrusted),
    isTrustedHudSender: (event, window) =>
      isTrustedRendererSender(event, [window], rendererUrlIsTrusted),
  })
  if (packageSmoke) {
    try {
      await runPackageSmoke(mainWindow, service)
    } catch (error) {
      process.stderr.write(
        `Prime Continuim package smoke failed: ${error instanceof Error ? error.message : String(error)}\n`
      )
      app.exit(1)
    }
    return
  }
  void loadRenderer(mainWindow).catch(() => {
    // Keep first paint off the HUD-preference critical path without turning a
    // navigation failure into an unhandled rejection or leaking its URL.
    process.stderr.write('Prime Continuim could not load the workbench renderer.\n')
  })
  // HUD preferences are not needed to paint the workbench. Start their bounded
  // read after renderer navigation; every HUD operation that needs them still
  // awaits the controller's shared, idempotent initialization promise.
  void hudWindowController.initialize()

  app.on('activate', () => {
    showMainWindow()
  })
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
