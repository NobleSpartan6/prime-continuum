/**
 * Renderer-safe control surface for Prime Continuim's singleton desktop HUD.
 *
 * The target is deliberately path-free and ephemeral. Native persistence is
 * limited to window mode and geometry; it must never contain this identity.
 */

export const HUD_IPC = {
  open: 'prime:hud:open',
  state: 'prime:hud:state',
  setMode: 'prime:hud:mode',
  close: 'prime:hud:close',
  returnToWorkbench: 'prime:hud:return-to-workbench',
  setIgnoreMouseEvents: 'prime:hud:ignore-mouse-events',
  stateChanged: 'prime:event:hud-state'
} as const

export type HudMode = 'buddy' | 'expanded'

export interface HudTarget {
  expectedHostId: string
  threadId: string
  expectedExecutionGenerationId: string
}

export type HudState =
  | { state: 'closed' }
  | {
      state: HudMode
      target: HudTarget
      ignoresMouseEvents: boolean
    }

export interface HudStructuredError {
  code: string
  message: string
  retryable: boolean
  receiptId: string
  details?: Record<string, unknown>
}

export type HudResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HudStructuredError }

export interface HudBridge {
  hudOpen(target: HudTarget): Promise<HudResult<HudState>>
  hudState(): Promise<HudResult<HudState>>
  hudSetMode(mode: HudMode): Promise<HudResult<HudState>>
  hudClose(): Promise<HudResult<HudState>>
  hudReturnToWorkbench(): Promise<HudResult<void>>
  hudSetIgnoreMouseEvents(ignore: boolean): Promise<HudResult<HudState>>
  onHudState(listener: (state: HudState) => void): () => void
}
