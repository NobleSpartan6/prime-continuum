const ELECTRON_USER_AGENT = /\bElectron\/\d+(?:\.\d+){0,3}\b/

export function isElectronRenderer(userAgent: string): boolean {
  return ELECTRON_USER_AGENT.test(userAgent)
}

export function isNativeBridgeUnavailable(userAgent: string, hasNativeBridge: boolean): boolean {
  return isElectronRenderer(userAgent) && !hasNativeBridge
}
