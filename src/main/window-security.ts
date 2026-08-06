import type { WebPreferences } from 'electron'

/** Auditable BrowserWindow defaults; keep this renderer boundary deny-by-default. */
export function secureWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    backgroundThrottling: true,
    spellcheck: true
  }
}
