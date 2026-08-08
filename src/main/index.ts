import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions, type Session } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerControlIpc } from './control/ipc'
import type { ConnectionState } from './control/contracts'
import { stopPackageSmokeHostds } from './control/local-hostd'
import { DesktopControlService } from './control/service'
import { installOrderlyQuitDrain } from './orderly-quit'
import { resolvePreloadEntry } from './window-paths'
import { secureWebPreferences } from './window-security'
import { RESIDENT_LIFECYCLE_CAPABILITY } from '../shared/protocol'

let mainWindow: BrowserWindow | undefined
let trustedRendererUrl = ''
let unregisterIpc: (() => void) | undefined
let unregisterOrderlyQuit: (() => void) | undefined
const configuredSessions = new WeakSet<Session>()
const PACKAGE_SMOKE_MARKER = 'PRIME_CONTINUIM_PACKAGE_SMOKE_OK'

function createWindow(loadImmediately = true, showWhenReady = true): BrowserWindow {
  const rendererFile = path.join(__dirname, '../renderer/index.html')
  trustedRendererUrl = process.env.ELECTRON_RENDERER_URL || pathToFileURL(rendererFile).href

  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0c0d0e',
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences(resolvePreloadEntry(__dirname))
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isSameDocumentNavigation(window.webContents.getURL(), url)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  configureSession(window.webContents.session)

  if (showWhenReady) window.once('ready-to-show', () => window.show())
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })

  if (loadImmediately) loadRenderer(window, rendererFile)
  return window
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
  rendererFile = path.join(__dirname, '../renderer/index.html')
): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL) return window.loadURL(process.env.ELECTRON_RENDERER_URL)
  return window.loadFile(rendererFile)
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

void app.whenReady().then(async () => {
  app.setAppUserModelId('ai.primeintellect.continuim')
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
    drain: () => service.shutdown(),
    cleanup: () => {
      unregisterIpc?.()
      unregisterIpc = undefined
      unregisterOrderlyQuit?.()
      unregisterOrderlyQuit = undefined
    },
    onError: (error) => {
      process.stderr.write(
        `Prime Continuim could not confirm sign-in shutdown: ${error instanceof Error ? error.message : 'unknown error'}\n`
      )
    }
  })
  const packageSmoke = process.env.PRIME_CONTINUIM_PACKAGE_SMOKE === '1'
  mainWindow = createWindow(false, !packageSmoke)
  unregisterIpc = registerControlIpc({
    ipcMain,
    service,
    getWindow: () => mainWindow,
    isTrustedSender: (event) => {
      const window = mainWindow
      return Boolean(
        window &&
          !window.isDestroyed() &&
          event.sender === window.webContents &&
          event.senderFrame === window.webContents.mainFrame &&
          rendererUrlIsTrusted(event.senderFrame.url)
      )
    }
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
  void loadRenderer(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
