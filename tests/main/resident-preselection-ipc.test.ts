import { EventEmitter } from 'node:events'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/main/control/contracts'
import { registerControlIpc } from '../../src/main/control/ipc'
import type { DesktopControlService } from '../../src/main/control/service'

describe('resident workspace preselection IPC', () => {
  it('accepts only an exact path-free token for completion and cancellation', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>()
    const ipcMain = {
      handle: (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => {
        handlers.set(channel, handler)
      },
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain
    const completeResidentWorkspacePreselection = vi.fn(async () => ({ selectionToken: 'selection-one' }))
    const cancelResidentWorkspacePreselection = vi.fn()
    const service = Object.assign(new EventEmitter(), {
      preselectResidentWorkspace: vi.fn(),
      completeResidentWorkspacePreselection,
      cancelResidentWorkspacePreselection,
    }) as unknown as DesktopControlService
    const dispose = registerControlIpc({
      ipcMain,
      service,
      getWindows: () => [],
      isTrustedSender: () => true,
      isTrustedWorkbenchSender: () => true,
    })
    const event = {} as IpcMainInvokeEvent
    const valid = { preselectionToken: 'preselection-one' }

    await expect(handlers.get(IPC.completeResidentWorkspacePreselection)!(event, valid))
      .resolves.toMatchObject({ ok: true })
    await expect(handlers.get(IPC.cancelResidentWorkspacePreselection)!(event, valid))
      .resolves.toMatchObject({ ok: true })
    const rejected = await handlers.get(IPC.completeResidentWorkspacePreselection)!(event, {
      ...valid,
      workspaceDirectory: '/Users/operator/private',
    })
    expect(rejected).toMatchObject({ ok: false, error: { code: 'ipc.invalid_payload' } })
    expect(JSON.stringify(rejected)).not.toContain('/Users/operator/private')
    expect(completeResidentWorkspacePreselection).toHaveBeenCalledOnce()
    expect(cancelResidentWorkspacePreselection).toHaveBeenCalledOnce()
    dispose()
  })
})
