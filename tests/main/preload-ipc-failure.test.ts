import { describe, expect, it, vi } from 'vitest'
import type { PrimeBridge } from '../../src/main/control/contracts'

const { exposeInMainWorld, invoke } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: {
    invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))

import '../../src/preload/index'

describe('preload IPC failure boundary', () => {
  it('turns a missing native handler into a fixed path-free restart result', async () => {
    invoke.mockRejectedValueOnce(
      new Error("No handler registered for 'prime:bootstrap' at /Users/private/workspace"),
    )
    const exposed = exposeInMainWorld.mock.calls[0]?.[1] as PrimeBridge

    const result = await exposed.bootstrap()

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'desktop.ipc_unavailable',
        message: 'The desktop connection closed. Reopen Prime Continuim.',
        retryable: false,
        receiptId: 'local-ipc-boundary',
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/prime:bootstrap|\/Users\/|No handler registered/i)
  })
})
