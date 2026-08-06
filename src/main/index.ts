import { app, BrowserWindow, ipcMain, type Session } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerControlIpc } from './control/ipc'
import { DesktopControlService } from './control/service'
import { resolvePreloadEntry } from './window-paths'
import { secureWebPreferences } from './window-security'

let mainWindow: BrowserWindow | undefined
let trustedRendererUrl = ''
let unregisterIpc: (() => void) | undefined
const configuredSessions = new WeakSet<Session>()

function createWindow(loadImmediately = true): BrowserWindow {
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

  window.once('ready-to-show', () => window.show())
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

function loadRenderer(window: BrowserWindow, rendererFile = path.join(__dirname, '../renderer/index.html')): void {
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(rendererFile)
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

void app.whenReady().then(() => {
  app.setAppUserModelId('ai.primeintellect.continuim')
  const service = new DesktopControlService({ app })
  mainWindow = createWindow(false)
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
  loadRenderer(mainWindow)

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

app.once('before-quit', () => {
  unregisterIpc?.()
  unregisterIpc = undefined
})
