import { describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import { IPC } from '../../src/main/control/contracts'
import { registerControlIpc } from '../../src/main/control/ipc'
import type { DesktopControlService } from '../../src/main/control/service'

describe('verified SSH host activation IPC', () => {
  it('accepts only one path-free immutable host identity from a trusted renderer', async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
        handlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    } as unknown as IpcMain
    const connection = {
      phase: 'online' as const,
      target: { kind: 'ssh' as const, alias: 'private-main-locator' },
      hostId: 'host-remote',
      path: 'ssh' as const,
      since: '2026-08-08T12:00:00.000Z',
      attempt: 1,
    }
    const activateVerifiedSshHost = vi.fn(async () => connection)
    const trustedEvent = {}
    const dispose = registerControlIpc({
      ipcMain,
      service: {
        activateVerifiedSshHost,
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as DesktopControlService,
      getWindows: () => [],
      isTrustedSender: (event) => event === trustedEvent,
      isTrustedWorkbenchSender: (event) => event === trustedEvent,
    })
    const invoke = handlers.get(IPC.activateVerifiedSshHost)

    await expect(invoke?.(trustedEvent, { expectedHostId: 'host-remote' })).resolves.toEqual({
      ok: true,
      value: connection,
    })
    expect(activateVerifiedSshHost).toHaveBeenCalledOnce()
    expect(activateVerifiedSshHost).toHaveBeenCalledWith('host-remote')

    for (const input of [
      { expectedHostId: 'host-remote', alias: 'renderer-controlled' },
      { expectedHostId: 'host-remote', hostname: 'example.invalid' },
      { expectedHostId: 'host-remote', argv: ['ssh', 'example.invalid'] },
      { expectedHostId: 'host-remote', path: 'C:\\private\\key' },
      { expectedHostId: '' },
    ]) {
      await expect(invoke?.(trustedEvent, input)).resolves.toMatchObject({
        ok: false,
        error: { code: 'native.unexpected' },
      })
    }
    await expect(invoke?.({}, { expectedHostId: 'host-remote' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ipc.untrusted_sender' },
    })
    expect(activateVerifiedSshHost).toHaveBeenCalledOnce()

    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC.activateVerifiedSshHost)
  })
})
