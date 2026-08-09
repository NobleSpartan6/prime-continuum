import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { App } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { connectLocalHostd } = vi.hoisted(() => ({ connectLocalHostd: vi.fn() }))

vi.mock('../../src/main/control/local-hostd', () => ({
  ensureAndConnectLocalHostd: connectLocalHostd,
  localHostdEndpoint: () => 'test-endpoint',
}))

import { DesktopControlService } from '../../src/main/control/service'

const directories: string[] = []
const observedAt = '2026-08-09T12:00:00.000Z'
const authority = {
  expectedHostId: 'host-local',
  threadId: 'thread-one',
  expectedExecutionGenerationId: 'execution-one',
}
const boundary = {
  securitySandbox: false,
  mainFilesystemIsolation: false,
  providerBackedEvaluation: false,
  autonomousPromotion: false,
  candidateControlledEvaluation: true,
  packageOrInstallerGate: false,
  authenticated: false,
  integrity: 'sha256-correlation-only-not-authentication',
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

class TestConnection extends EventEmitter {
  isClosed = false
  readonly requests: Array<{ method: string; payload: unknown }> = []

  constructor(private readonly responder: (method: string, payload: unknown) => unknown) {
    super()
  }

  async request(method: string, payload: unknown): Promise<unknown> {
    this.requests.push({ method, payload })
    return this.responder(method, payload)
  }

  close(): void {
    this.isClosed = true
  }
}

beforeEach(() => connectLocalHostd.mockReset())

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('DesktopControlService candidate evaluation', () => {
  it('allows preflight only through the current online local authority and verifies the reply identity', async () => {
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return health()
      if (method === 'candidate.evaluation.preflight') {
        return {
          preflightVersion: 1,
          ...authority,
          observedAt,
          boundary,
          status: 'ready',
          capability: 'prime_continuim_self_build_evaluation_v1',
          review,
          executor: {
            kind: 'canonical_self_build',
            gateProcessContainment: 'windows_job',
            requiredNodeVersion: '22.16.0',
            requiredPnpmVersion: '10.15.0',
            verification: 'passive-structure-before-consent;canonical-toolchain-inside-evaluation',
            launcherSource: 'workspace-dependency-tree-candidate-controlled',
          },
        }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: await appFixture() })

    await service.connect({ kind: 'local' })
    await expect(service.candidateEvaluationPreflight(authority)).resolves.toMatchObject({
      status: 'ready',
      ...authority,
    })
    await expect(service.candidateEvaluationPreflight({ ...authority, expectedHostId: 'host-other' }))
      .rejects.toMatchObject({ code: 'candidate.evaluation_authority_changed' })
    expect(connection.requests.filter((request) => request.method === 'candidate.evaluation.preflight')).toHaveLength(1)
    await service.disconnect()
  })

  it('rejects evaluation before transport when the verified host omits the probe capability', async () => {
    const connection = new TestConnection((method) => {
      if (method === 'health.get') return { ...health(), capabilities: [] }
      throw new Error(`Evaluation transport must stay closed: ${method}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: await appFixture() })

    await service.connect({ kind: 'local' })
    await expect(service.candidateEvaluationSnapshot(authority))
      .rejects.toMatchObject({ code: 'candidate.evaluation_unavailable' })
    expect(connection.requests.map((request) => request.method)).toEqual(['health.get'])
    await service.disconnect()
  })

  it('binds start admission to the passive review without claiming a canonical candidate before receipt', async () => {
    const input = {
      ...authority,
      operationId: 'candidate-evaluation:11111111-1111-4111-8111-111111111111',
      requestedAt: observedAt,
      kind: 'prime_continuim_self_build_v1' as const,
      expectedReview: review,
    }
    const connection = new TestConnection((method, payload) => {
      if (method === 'health.get') return health()
      if (method === 'candidate.evaluation.start') {
        return {
          statusVersion: 1,
          ...authority,
          operationId: input.operationId,
          kind: input.kind,
          requestedAt: input.requestedAt,
          updatedAt: '2026-08-09T12:00:01.000Z',
          status: 'running',
          review,
          invocationStartedAt: '2026-08-09T12:00:01.000Z',
          boundary,
        }
      }
      throw new Error(`Unexpected request: ${method} ${JSON.stringify(payload)}`)
    })
    connectLocalHostd.mockResolvedValue(connection)
    const service = new DesktopControlService({ app: await appFixture() })

    await service.connect({ kind: 'local' })
    const status = await service.startCandidateEvaluation(input)
    expect(status).toMatchObject({ status: 'running', review })
    expect(status).not.toHaveProperty('candidate')
    expect(connection.requests.find((request) => request.method === 'candidate.evaluation.start')?.payload).toEqual(input)
    await service.disconnect()
  })
})

function health() {
  return {
    protocolVersion: 1,
    hostdVersion: '0.1.0',
    startedAt: '2026-08-09T11:59:00.000Z',
    checkedAt: observedAt,
    serviceState: 'ready',
    host: { hostId: authority.expectedHostId },
    capabilities: ['candidate_evaluation_probe_v1'],
  }
}

async function appFixture(): Promise<App> {
  const directory = await mkdtemp(path.join(tmpdir(), 'prime-candidate-evaluation-service-'))
  directories.push(directory)
  return {
    getPath: vi.fn(() => directory),
    getVersion: vi.fn(() => '1.2.3'),
  } as unknown as App
}
