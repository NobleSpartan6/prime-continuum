import { describe, expect, it } from 'vitest'
import { isElectronRenderer, isNativeBridgeUnavailable } from '../../src/renderer/src/runtime'

describe('renderer runtime boundary', () => {
  it('recognizes Electron renderer user agents', () => {
    expect(isElectronRenderer('Mozilla/5.0 Chrome/144.0.0.0 Electron/43.3.0 Safari/537.36')).toBe(true)
    expect(isElectronRenderer('Mozilla/5.0 Chrome/144.0.0.0 Safari/537.36')).toBe(false)
  })

  it('fails closed only when the native shell is missing its bridge', () => {
    const electron = 'Mozilla/5.0 Chrome/144.0.0.0 Electron/43.3.0 Safari/537.36'
    expect(isNativeBridgeUnavailable(electron, false)).toBe(true)
    expect(isNativeBridgeUnavailable(electron, true)).toBe(false)
    expect(isNativeBridgeUnavailable('Mozilla/5.0 Chrome/144.0.0.0 Safari/537.36', false)).toBe(false)
  })
})
