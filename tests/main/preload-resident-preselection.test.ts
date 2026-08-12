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

describe('preload resident workspace preselection bridge', () => {
  it('exposes only path-free preselect, complete, and cancel envelopes', async () => {
    const exposed = exposeInMainWorld.mock.calls[0]?.[1] as {
      preselectResidentWorkspace(): Promise<unknown>
      completeResidentWorkspacePreselection(input: unknown): Promise<unknown>
      cancelResidentWorkspacePreselection(input: unknown): Promise<unknown>
    }
    const input = { preselectionToken: 'preselection-one' }

    await exposed.preselectResidentWorkspace()
    await exposed.completeResidentWorkspacePreselection(input)
    await exposed.cancelResidentWorkspacePreselection(input)

    expect(invoke.mock.calls.slice(-3)).toEqual([
      ['prime:resident:workspace:preselect', undefined],
      ['prime:resident:workspace:preselection:complete', input],
      ['prime:resident:workspace:preselection:cancel', input],
    ])
    expect(JSON.stringify(input)).not.toMatch(/[A-Z]:\\|\/Users\/|workspaceDirectory|socketPath/i)
  })
})
