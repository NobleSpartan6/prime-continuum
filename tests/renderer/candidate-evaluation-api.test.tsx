// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isDefinitiveCandidateEvaluationStartError,
  NativeRendererApi,
  StaleHostAuthorityError,
} from '../../src/renderer/src/api'
import type { CandidateEvaluationStartRequest } from '../../src/shared/protocol'

const authority = {
  expectedHostId: 'host-local',
  threadId: 'thread-one',
  expectedExecutionGenerationId: 'execution-one',
}

const review = {
  headCommit: 'a'.repeat(40),
  gitIndexSha256: '1'.repeat(64),
  gitIndexBytes: 1_024,
  packageManifestSha256: '2'.repeat(64),
  lockfileSha256: '3'.repeat(64),
  lockfileBytes: 32_768,
  nodeVersionPinSha256: '4'.repeat(64),
  selfBuildEntrypointSha256: '5'.repeat(64),
  launcherBootstrapSha256: 'a'.repeat(64),
  launcherBootstrapFileCount: 9 as const,
  runtimePointerSha256: '6'.repeat(64),
  nodePackageManifestSha256: '7'.repeat(64),
  nodeExecutableSha256: '8'.repeat(64),
  pnpmCliSha256: '9'.repeat(64),
  reviewAggregateSha256: '0'.repeat(64),
}

const boundary = {
  securitySandbox: false,
  mainFilesystemIsolation: false,
  providerBackedEvaluation: false,
  autonomousPromotion: false,
  candidateControlledEvaluation: true,
  packageOrInstallerGate: false,
  authenticated: false,
  integrity: 'sha256-correlation-only-not-authentication' as const,
}

const startEnvelope: CandidateEvaluationStartRequest = {
  ...authority,
  operationId: 'candidate-evaluation:11111111-1111-4111-8111-111111111111',
  requestedAt: '2026-08-09T12:00:00.000Z',
  kind: 'prime_continuim_self_build_v1',
  expectedReview: review,
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('NativeRendererApi candidate evaluation', () => {
  it.each([
    ['host.evaluation_id_conflict', true],
    ['host.evaluation_storage_full', true],
    ['transport.offline', true],
    ['host.evaluation_invocation_uncertain', false],
    ['transport.request_timeout', false],
  ] as const)('classifies candidate start error %s as definitive=%s', (code, definitive) => {
    expect(isDefinitiveCandidateEvaluationStartError({ code })).toBe(definitive)
  })

  it('passes the caller-minted start envelope through unchanged across exact retries', async () => {
    const startCandidateEvaluation = vi.fn(async (input: unknown) => ({
      ok: true,
      value: {
        statusVersion: 1,
        ...authority,
        operationId: startEnvelope.operationId,
        kind: 'prime_continuim_self_build_v1',
        requestedAt: startEnvelope.requestedAt,
        updatedAt: '2026-08-09T12:00:01.000Z',
        status: 'running',
        review,
        invocationStartedAt: '2026-08-09T12:00:01.000Z',
        boundary,
      },
    }))
    const api = new NativeRendererApi({ startCandidateEvaluation })

    await api.startCandidateEvaluation(startEnvelope)
    await api.startCandidateEvaluation(startEnvelope)

    expect(startCandidateEvaluation).toHaveBeenCalledTimes(2)
    expect(startCandidateEvaluation).toHaveBeenNthCalledWith(1, startEnvelope)
    expect(startCandidateEvaluation).toHaveBeenNthCalledWith(2, startEnvelope)
    expect(startCandidateEvaluation.mock.calls[0]?.[0]).toBe(startEnvelope)
  })

  it('rejects a schema-valid snapshot for a different exact thread generation', async () => {
    const api = new NativeRendererApi({
      candidateEvaluationSnapshot: vi.fn(async () => ({
        ok: true,
        value: {
          snapshotVersion: 1,
          ...authority,
          expectedExecutionGenerationId: 'execution-other',
          generatedAt: '2026-08-09T12:00:00.000Z',
          repeatEffectsWarningRequired: false,
          evaluations: [],
        },
      })),
    })

    await expect(api.candidateEvaluationSnapshot(authority)).rejects.toBeInstanceOf(StaleHostAuthorityError)
  })
})
