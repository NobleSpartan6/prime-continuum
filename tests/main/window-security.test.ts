import { describe, expect, it } from 'vitest'
import { PRELOAD_ENTRY, resolvePreloadEntry } from '../../src/main/window-paths'
import { secureWebPreferences } from '../../src/main/window-security'

describe('BrowserWindow security defaults', () => {
  it('isolates and sandboxes the renderer without Node or webviews', () => {
    const preferences = secureWebPreferences('C:\\app\\preload.js')
    expect(preferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    })
  })

  it('loads the ESM preload entry emitted by electron-vite', () => {
    expect(PRELOAD_ENTRY).toBe('../preload/index.cjs')
    expect(resolvePreloadEntry('C:\\app\\out\\main')).toBe('C:\\app\\out\\preload\\index.cjs')
    expect(resolvePreloadEntry('/opt/prime-continuim/out/main')).toBe('/opt/prime-continuim/out/preload/index.cjs')
  })
})
