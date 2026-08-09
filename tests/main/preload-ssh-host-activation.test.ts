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

describe('preload verified SSH host activation bridge', () => {
  it('forwards only the immutable expected host identity to its dedicated channel', async () => {
    expect(exposeInMainWorld).toHaveBeenCalledOnce()
    const exposed = exposeInMainWorld.mock.calls[0]?.[1] as {
      activateVerifiedSshHost(input: { expectedHostId: string }): Promise<unknown>
    }
    const input = { expectedHostId: 'host-remote' }

    await exposed.activateVerifiedSshHost(input)

    expect(invoke).toHaveBeenCalledWith('prime:connection:activate-verified-ssh-host', input)
    expect(JSON.stringify(input)).not.toMatch(/alias|hostname|argv|path|socket|\\|\//i)
  })
})
