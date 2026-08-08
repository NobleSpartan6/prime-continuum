import { describe, expect, it, vi } from 'vitest'

const { exposeInMainWorld, invoke, on, removeListener } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => ({ ok: true, value: undefined })),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener }
}))

import '../../src/preload/index'
import { HUD_IPC, type HudBridge, type HudState, type HudTarget } from '../../src/shared/window-control'

describe('preload HUD bridge', () => {
  it('exposes only narrow path-free HUD operations on the frozen Prime bridge', async () => {
    expect(exposeInMainWorld).toHaveBeenCalledOnce()
    expect(exposeInMainWorld.mock.calls[0]?.[0]).toBe('prime')
    const exposed = exposeInMainWorld.mock.calls[0]?.[1] as HudBridge
    expect(Object.isFrozen(exposed)).toBe(true)
    const target: HudTarget = {
      expectedHostId: 'host-local',
      threadId: 'thread-prime',
      expectedExecutionGenerationId: 'generation-1'
    }

    await exposed.hudOpen(target)
    await exposed.hudState()
    await exposed.hudSetMode('buddy')
    await exposed.hudSetIgnoreMouseEvents(true)
    await exposed.hudClose()
    await exposed.hudReturnToWorkbench()

    expect(invoke.mock.calls.slice(-6)).toEqual([
      [HUD_IPC.open, target],
      [HUD_IPC.state],
      [HUD_IPC.setMode, 'buddy'],
      [HUD_IPC.setIgnoreMouseEvents, true],
      [HUD_IPC.close],
      [HUD_IPC.returnToWorkbench]
    ])
    expect(JSON.stringify(target)).not.toMatch(/[A-Z]:\\|\/Users\/|workspacePath|socket/i)
  })

  it('subscribes and removes the exact native HUD state listener', () => {
    const exposed = exposeInMainWorld.mock.calls[0]?.[1] as HudBridge
    const listener = vi.fn<(state: HudState) => void>()
    const unsubscribe = exposed.onHudState(listener)
    const nativeHandler = on.mock.calls.find(([channel]) => channel === HUD_IPC.stateChanged)?.[1] as
      | ((event: unknown, state: HudState) => void)
      | undefined
    expect(nativeHandler).toBeTypeOf('function')

    const state: HudState = {
      state: 'expanded',
      target: {
        expectedHostId: 'host-local',
        threadId: 'thread-prime',
        expectedExecutionGenerationId: 'generation-1'
      },
      ignoresMouseEvents: false
    }
    nativeHandler?.({}, state)
    expect(listener).toHaveBeenCalledWith(state)

    unsubscribe()
    expect(removeListener).toHaveBeenCalledWith(HUD_IPC.stateChanged, nativeHandler)
  })
})
