import { EventEmitter } from 'node:events'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/main/control/contracts'
import { registerControlIpc } from '../../src/main/control/ipc'
import type { DesktopControlService } from '../../src/main/control/service'

type Handler = (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>

function fixture() {
  const handlers = new Map<string, Handler>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  } as unknown as IpcMain
  const service = Object.assign(new EventEmitter(), {
    candidateEvaluationPreflight: vi.fn(async (input: unknown) => input),
    startCandidateEvaluation: vi.fn(async (input: unknown) => input),
    candidateEvaluationSnapshot: vi.fn(async (input: unknown) => input),
  }) as unknown as DesktopControlService
  const dispose = registerControlIpc({
    ipcMain,
    service,
    getWindows: () => [],
    isTrustedSender: () => true,
    isTrustedWorkbenchSender: () => true,
  })
  return { handlers, service, dispose }
}

describe('candidate evaluation control IPC', () => {
  it('forwards the exact path-free host, thread, and generation preflight authority', async () => {
    const { handlers, service, dispose } = fixture()
    const input = {
      expectedHostId: 'host-local',
      threadId: 'thread-one',
      expectedExecutionGenerationId: 'execution-one',
    }

    await expect(handlers.get(IPC.candidateEvaluationPreflight)!({} as IpcMainInvokeEvent, input))
      .resolves.toEqual({ ok: true, value: input })
    expect(service.candidateEvaluationPreflight).toHaveBeenCalledWith(input)
    expect(JSON.stringify(input)).not.toMatch(/[A-Z]:\\|\/Users\/|workspaceDirectory|receiptPath|socketPath/i)
    dispose()
  })

  it('rejects renderer-supplied paths and unknown fields before the service boundary', async () => {
    const { handlers, service, dispose } = fixture()
    const result = await handlers.get(IPC.candidateEvaluationPreflight)!({} as IpcMainInvokeEvent, {
      expectedHostId: 'host-local',
      threadId: 'thread-one',
      expectedExecutionGenerationId: 'execution-one',
      workspaceDirectory: 'C:\\private\\workspace',
    }) as { ok: boolean; error?: { code?: string } }

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('ipc.invalid_payload')
    expect(service.candidateEvaluationPreflight).not.toHaveBeenCalled()
    dispose()
  })

  it('rejects a legacy canonical-candidate claim at the pre-consent start boundary', async () => {
    const { handlers, service, dispose } = fixture()
    const result = await handlers.get(IPC.startCandidateEvaluation)!({} as IpcMainInvokeEvent, {
      expectedHostId: 'host-local',
      threadId: 'thread-one',
      expectedExecutionGenerationId: 'execution-one',
      operationId: 'candidate-evaluation:11111111-1111-4111-8111-111111111111',
      requestedAt: '2026-08-09T12:00:00.000Z',
      kind: 'prime_continuim_self_build_v1',
      expectedReview: reviewIdentity(),
      expectedCandidate: { headCommit: 'a'.repeat(40) },
    }) as { ok: boolean; error?: { code?: string } }

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('ipc.invalid_payload')
    expect(service.startCandidateEvaluation).not.toHaveBeenCalled()
    dispose()
  })
})

function reviewIdentity() {
  return {
    headCommit: 'a'.repeat(40),
    gitIndexSha256: '1'.repeat(64),
    gitIndexBytes: 1_024,
    packageManifestSha256: '2'.repeat(64),
    lockfileSha256: '3'.repeat(64),
    lockfileBytes: 32_768,
    nodeVersionPinSha256: '4'.repeat(64),
    selfBuildEntrypointSha256: '5'.repeat(64),
    launcherBootstrapSha256: 'a'.repeat(64),
    launcherBootstrapFileCount: 9,
    runtimePointerSha256: '6'.repeat(64),
    nodePackageManifestSha256: '7'.repeat(64),
    nodeExecutableSha256: '8'.repeat(64),
    pnpmCliSha256: '9'.repeat(64),
    reviewAggregateSha256: '0'.repeat(64),
  }
}
