import { EventEmitter } from 'node:events'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/main/control/contracts'
import { ControlError } from '../../src/main/control/errors'
import { registerControlIpc } from '../../src/main/control/ipc'
import type { DesktopControlService } from '../../src/main/control/service'

const validInput = {
  selectionToken: 'selection-one',
  projectDisplayName: 'Prime GUI',
  threadTitle: 'Long-running thread',
}

function fixture(provisionResident: ReturnType<typeof vi.fn>, trusted = true) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>()
  const ipcMain = {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain
  const service = Object.assign(new EventEmitter(), { provisionResident }) as unknown as DesktopControlService
  const dispose = registerControlIpc({
    ipcMain,
    service,
    getWindows: () => [],
    isTrustedSender: () => trusted,
    isTrustedWorkbenchSender: () => true,
  })
  return {
    dispose,
    invoke: (input: unknown) => handlers.get(IPC.provisionResident)!({} as IpcMainInvokeEvent, input),
  }
}

describe('resident provision IPC durability boundary', () => {
  it('marks schema rejection definitive before the service is invoked', async () => {
    const provisionResident = vi.fn()
    const harness = fixture(provisionResident)

    await expect(harness.invoke({ ...validInput, workspaceDirectory: 'C:\\private' })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'ipc.invalid_payload',
        message: 'The native request payload is invalid.',
        details: { durableOperationPossible: false },
      },
    })
    expect(provisionResident).not.toHaveBeenCalled()
    harness.dispose()
  })

  it('returns one fixed definitive error for a non-serializable pre-service payload', async () => {
    const provisionResident = vi.fn()
    const harness = fixture(provisionResident)
    const cyclic: Record<string, unknown> = { ...validInput }
    cyclic.self = cyclic

    const result = await harness.invoke(cyclic)
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'ipc.invalid_payload',
        message: 'The native request payload is not serializable.',
        retryable: false,
        details: { durableOperationPossible: false },
      },
    })
    expect((result as { error: { details: object } }).error.details).toEqual({
      durableOperationPossible: false,
    })
    expect(provisionResident).not.toHaveBeenCalled()
    harness.dispose()
  })

  it('bounds an oversized pre-service payload before schema parsing', async () => {
    const provisionResident = vi.fn()
    const harness = fixture(provisionResident)

    const result = await harness.invoke({
      ...validInput,
      projectDisplayName: 'x'.repeat(512 * 1024),
    })
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'ipc.payload_limit',
        message: 'The native request payload is too large.',
        retryable: false,
        details: { durableOperationPossible: false },
      },
    })
    expect((result as { error: { details: object } }).error.details).toEqual({
      durableOperationPossible: false,
    })
    expect(provisionResident).not.toHaveBeenCalled()
    harness.dispose()
  })

  it('preserves a fixed untrusted-sender rejection before service entry', async () => {
    const provisionResident = vi.fn()
    const harness = fixture(provisionResident, false)

    await expect(harness.invoke(validInput)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'ipc.untrusted_sender',
        message: 'The native request did not come from the app UI.',
        details: { durableOperationPossible: false },
      },
    })
    expect(provisionResident).not.toHaveBeenCalled()
    harness.dispose()
  })

  it('preserves an explicit definitive service result and bounds the marker first', async () => {
    const extraDetails = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`detail-${index}`, index]))
    const provisionResident = vi.fn(async () => {
      throw new ControlError('resident.selection_superseded', 'Select the workspace again.', {
        details: { ...extraDetails, durableOperationPossible: false },
      })
    })
    const harness = fixture(provisionResident)

    const result = await harness.invoke(validInput)
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'resident.selection_superseded',
        message: 'Select the workspace again.',
        retryable: false,
        details: { durableOperationPossible: false, 'detail-0': 0 },
      },
    })
    expect(Object.keys((result as { error: { details: object } }).error.details)[0]).toBe('durableOperationPossible')
    expect(Object.keys((result as { error: { details: object } }).error.details)).toHaveLength(32)
    expect(provisionResident).toHaveBeenCalledOnce()
    harness.dispose()
  })

  it('defaults an untyped post-service failure to ambiguous durability', async () => {
    const provisionResident = vi.fn(async () => {
      throw new Error('The service response was interrupted.')
    })
    const harness = fixture(provisionResident)

    await expect(harness.invoke(validInput)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'native.unexpected',
        message: 'The service response was interrupted.',
        details: { durableOperationPossible: true },
      },
    })
    expect(provisionResident).toHaveBeenCalledOnce()
    harness.dispose()
  })
})
