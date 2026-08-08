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

describe('preload runtime repair bridge', () => {
  it('forwards only the caller-supplied path-free repair fence to its dedicated IPC channel', async () => {
    expect(exposeInMainWorld).toHaveBeenCalledOnce()
    const exposed = exposeInMainWorld.mock.calls[0]?.[1] as {
      repairRuntimeIntegrity(input: unknown): Promise<unknown>
    }
    const input = {
      expectedHostId: 'host-local',
      expectedTrustAnchorId: 'a'.repeat(64),
      expectedTarget: {
        runtime: 'prime-agent',
        releaseVersion: '0.7.0',
        runtimeBuildId: 'fixture-build-1',
        platform: 'win32',
        arch: 'x64',
        manifestSha256: 'b'.repeat(64),
        treeSha256: 'c'.repeat(64),
        filesSha256: 'd'.repeat(64),
      },
      expectedChangedAt: '2026-08-08T12:00:00.000Z',
    }

    await exposed.repairRuntimeIntegrity(input)
    expect(invoke).toHaveBeenCalledWith('prime:runtime:integrity:repair', input)
    expect(JSON.stringify(input)).not.toMatch(/[A-Z]:\\|\/Users\/|workspace|socket/i)
  })
})
