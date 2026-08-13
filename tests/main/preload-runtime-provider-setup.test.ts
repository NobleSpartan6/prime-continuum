import { describe, expect, it, vi } from 'vitest'

const { exposeInMainWorld, invoke } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => ({ ok: true, value: undefined })),
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

describe('preload runtime provider setup bridge', () => {
  it('forwards only the exact path-free host and provider authority', async () => {
    const exposed = exposeInMainWorld.mock.calls[0]?.[1] as {
      openRuntimeProviderSetup(input: unknown): Promise<unknown>
    }
    const input = { expectedHostId: 'host-local', providerId: 'anthropic' }

    await exposed.openRuntimeProviderSetup(input)

    expect(invoke).toHaveBeenCalledWith('prime:runtime:provider-setup:open', input)
    expect(JSON.stringify(input)).not.toMatch(/[A-Z]:\\|\/Users\/|workspace|socket|executable|command/i)
  })
})
