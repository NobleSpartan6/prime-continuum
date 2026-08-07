import type { App, Event as ElectronEvent } from 'electron'

export interface OrderlyQuitDrainOptions {
  readonly drain: () => Promise<void>
  readonly cleanup?: () => void
  readonly onError?: (error: unknown) => void
}

/**
 * Electron's before-quit event is synchronous. Hold the first quit, perform
 * the host-confirmed OAuth drain, and issue one second quit only after success.
 * A failed drain deliberately leaves the app running and its host transport
 * owned so helper liveness is never reported as a clean shutdown.
 */
export function installOrderlyQuitDrain(
  app: Pick<App, 'on' | 'removeListener' | 'quit'>,
  options: OrderlyQuitDrainOptions
): () => void {
  let draining = false
  let drained = false

  const beforeQuit = (event: ElectronEvent): void => {
    if (drained) return
    event.preventDefault()
    if (draining) return
    draining = true
    void options.drain().then(
      () => {
        drained = true
        options.cleanup?.()
        app.quit()
      },
      (error) => {
        draining = false
        options.onError?.(error)
      }
    )
  }

  app.on('before-quit', beforeQuit)
  return () => app.removeListener('before-quit', beforeQuit)
}
