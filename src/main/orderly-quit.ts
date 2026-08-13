import type { App, Event as ElectronEvent } from 'electron'

export interface OrderlyQuitDrainOptions {
  readonly drain: () => Promise<void>
  readonly cleanup?: () => void
  readonly onError?: (error: unknown) => void
}

/**
 * Electron's before-quit event is synchronous. Hold the first quit, perform
 * the host-confirmed OAuth drain, and issue one second quit only after success.
 * Renderer-facing resources stay registered until Electron reaches will-quit:
 * removing IPC handlers before that boundary can strand a visible window if
 * another listener interrupts the quit. A failed drain deliberately leaves the
 * app running and its host transport owned so helper liveness is never reported
 * as a clean shutdown.
 */
export function installOrderlyQuitDrain(
  app: Pick<App, 'on' | 'removeListener' | 'quit'>,
  options: OrderlyQuitDrainOptions
): () => void {
  let draining = false
  let drained = false
  let cleaned = false

  const willQuit = (): void => {
    if (cleaned) return
    cleaned = true
    options.cleanup?.()
  }

  const beforeQuit = (event: ElectronEvent): void => {
    if (drained) return
    event.preventDefault()
    if (draining) return
    draining = true
    void options.drain().then(
      () => {
        drained = true
        app.quit()
      },
      (error) => {
        draining = false
        options.onError?.(error)
      }
    )
  }

  app.on('before-quit', beforeQuit)
  app.on('will-quit', willQuit)
  return () => {
    app.removeListener('before-quit', beforeQuit)
    app.removeListener('will-quit', willQuit)
  }
}
