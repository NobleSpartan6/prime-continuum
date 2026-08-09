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

describe('preload candidate evaluation bridge', () => {
  it('forwards only exact path-free evaluation envelopes to dedicated IPC channels', async () => {
    const exposed = exposeInMainWorld.mock.calls[0]?.[1] as {
      candidateEvaluationPreflight(input: unknown): Promise<unknown>
      startCandidateEvaluation(input: unknown): Promise<unknown>
      candidateEvaluationSnapshot(input: unknown): Promise<unknown>
    }
    const authority = {
      expectedHostId: 'host-local',
      threadId: 'thread-one',
      expectedExecutionGenerationId: 'execution-one',
    }
    const start = {
      ...authority,
      operationId: 'candidate-evaluation:11111111-1111-4111-8111-111111111111',
      requestedAt: '2026-08-09T12:00:00.000Z',
      kind: 'prime_continuim_self_build_v1',
      expectedReview: {
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
      },
    }

    await exposed.candidateEvaluationPreflight(authority)
    await exposed.startCandidateEvaluation(start)
    await exposed.candidateEvaluationSnapshot(authority)

    expect(invoke).toHaveBeenNthCalledWith(1, 'prime:candidate:evaluation:preflight', authority)
    expect(invoke).toHaveBeenNthCalledWith(2, 'prime:candidate:evaluation:start', start)
    expect(invoke).toHaveBeenNthCalledWith(3, 'prime:candidate:evaluation:snapshot', authority)
    expect(JSON.stringify(start)).not.toMatch(/[A-Z]:\\|\/Users\/|workspaceDirectory|receiptPath|socketPath/i)
  })
})
