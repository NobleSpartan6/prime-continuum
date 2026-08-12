import { describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import { IPC } from '../../src/main/control/contracts'
import { registerControlIpc } from '../../src/main/control/ipc'
import type { DesktopControlService } from '../../src/main/control/service'

describe('runtime integrity retry IPC', () => {
  it('accepts one strict trusted-renderer host identity and returns only the bounded snapshot', async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
        handlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    } as unknown as IpcMain
    const snapshot = {
      contractVersion: 1 as const,
      changedAt: '2026-08-08T12:00:00.000Z',
      trustAnchorId: 'a'.repeat(64),
      target: {
        runtime: 'prime-agent' as const,
        releaseVersion: '0.7.0',
        runtimeBuildId: 'fixture-build-1',
        platform: 'win32',
        arch: 'x64',
        manifestSha256: 'a'.repeat(64),
        treeSha256: 'b'.repeat(64),
        filesSha256: 'c'.repeat(64),
      },
      status: 'initializing' as const,
      phase: 'preparing' as const,
      attempt: 2,
    }
    const retryRuntimeIntegrity = vi.fn(async () => snapshot)
    const on = vi.fn()
    const off = vi.fn()
    const trustedEvent = {}
    const dispose = registerControlIpc({
      ipcMain,
      service: { retryRuntimeIntegrity, on, off } as unknown as DesktopControlService,
      getWindows: () => [],
      isTrustedSender: (event) => event === trustedEvent,
      isTrustedWorkbenchSender: (event) => event === trustedEvent,
    })
    const invoke = handlers.get(IPC.retryRuntimeIntegrity)
    expect(invoke).toBeTypeOf('function')

    await expect(invoke?.(trustedEvent, { expectedHostId: 'host-local' })).resolves.toEqual({
      ok: true,
      value: snapshot,
    })
    expect(retryRuntimeIntegrity).toHaveBeenCalledOnce()
    expect(retryRuntimeIntegrity).toHaveBeenCalledWith('host-local')

    await expect(invoke?.(trustedEvent, {
      expectedHostId: 'host-local',
      runtimePath: 'C:\\private\\runtime',
    })).resolves.toMatchObject({ ok: false, error: { code: 'ipc.invalid_payload' } })
    await expect(invoke?.({}, { expectedHostId: 'host-local' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ipc.untrusted_sender' },
    })
    expect(retryRuntimeIntegrity).toHaveBeenCalledOnce()

    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC.retryRuntimeIntegrity)
  })

  it('accepts only a strict path-free repair authority fence from the trusted renderer', async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
        handlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    } as unknown as IpcMain
    const target = {
      runtime: 'prime-agent' as const,
      releaseVersion: '0.7.0',
      runtimeBuildId: 'fixture-build-1',
      platform: 'win32',
      arch: 'x64',
      manifestSha256: 'a'.repeat(64),
      treeSha256: 'b'.repeat(64),
      filesSha256: 'c'.repeat(64),
    }
    const input = {
      expectedHostId: 'host-local',
      expectedTrustAnchorId: 'd'.repeat(64),
      expectedTarget: target,
      expectedChangedAt: '2026-08-08T12:00:00.000Z',
    }
    const snapshot = {
      contractVersion: 1 as const,
      changedAt: '2026-08-08T12:00:01.000Z',
      trustAnchorId: input.expectedTrustAnchorId,
      target,
      status: 'initializing' as const,
      phase: 'preparing' as const,
      attempt: 2,
    }
    const repairRuntimeIntegrity = vi.fn(async () => snapshot)
    const trustedEvent = {}
    registerControlIpc({
      ipcMain,
      service: { repairRuntimeIntegrity, on: vi.fn(), off: vi.fn() } as unknown as DesktopControlService,
      getWindows: () => [],
      isTrustedSender: (event) => event === trustedEvent,
      isTrustedWorkbenchSender: (event) => event === trustedEvent,
    })
    const invoke = handlers.get(IPC.repairRuntimeIntegrity)

    await expect(invoke?.(trustedEvent, input)).resolves.toEqual({ ok: true, value: snapshot })
    expect(repairRuntimeIntegrity).toHaveBeenCalledWith(input)
    await expect(invoke?.(trustedEvent, {
      ...input,
      runtimePath: 'C:\\private\\runtime',
    })).resolves.toMatchObject({ ok: false, error: { code: 'ipc.invalid_payload' } })
    await expect(invoke?.(trustedEvent, {
      ...input,
      expectedTrustAnchorId: 'not-a-digest',
    })).resolves.toMatchObject({ ok: false, error: { code: 'ipc.invalid_payload' } })
    await expect(invoke?.({}, input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'ipc.untrusted_sender' },
    })
    expect(repairRuntimeIntegrity).toHaveBeenCalledOnce()
  })
})
