import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from '../../src/main/control/contracts'
import type { RuntimeIntegritySnapshot } from '../../src/shared/protocol'

const DIGEST_A = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const DIGEST_C = `sha256:${'c'.repeat(64)}`

const electronApp = {
  requestSingleInstanceLock: vi.fn(() => true),
  whenReady: vi.fn(() => new Promise<void>(() => undefined)),
  on: vi.fn(),
  once: vi.fn(),
  quit: vi.fn(),
  exit: vi.fn(),
  setAppUserModelId: vi.fn()
}

vi.mock('electron', () => ({
  app: electronApp,
  BrowserWindow: class {},
  ipcMain: {}
}))

let isPackageSmokeRuntimeReady: typeof import('../../src/main/index').isPackageSmokeRuntimeReady
let isPackageSmokeFirstRunAuthorityReady: typeof import('../../src/main/index').isPackageSmokeFirstRunAuthorityReady

beforeAll(async () => {
  ;({ isPackageSmokeRuntimeReady, isPackageSmokeFirstRunAuthorityReady } = await import('../../src/main/index'))
})

describe('packaged runtime smoke readiness', () => {
  it('accepts a ready observation only from the same online local host sample', () => {
    expect(isPackageSmokeRuntimeReady(readyConnection())).toBe(true)
  })

  it.each(['offline', 'reconnecting', 'degraded'] as const)(
    'rejects cached ready observations while the connection is %s',
    (phase) => {
      expect(isPackageSmokeRuntimeReady(readyConnection({ phase }))).toBe(false)
    }
  )

  it('rejects a ready observation produced by another host authority', () => {
    expect(
      isPackageSmokeRuntimeReady(
        readyConnection({
          runtimeReadiness: reportedReadiness('host-b')
        })
      )
    ).toBe(false)
  })

  it.each<Partial<ConnectionState>>([
    { path: 'ssh' },
    { capabilities: [] },
    {
      runtimeReadiness: reportedReadiness('host-a', runtimeSnapshot('initializing'))
    }
  ])('rejects incomplete readiness evidence %#', (overrides) => {
    expect(isPackageSmokeRuntimeReady(readyConnection(overrides))).toBe(false)
  })

  it('accepts first-run readiness only for the same live local authority with resident setup capability', () => {
    const connection = readyConnection({
      capabilities: ['runtime_integrity_v1', 'resident_lifecycle_v1'],
    })
    expect(isPackageSmokeFirstRunAuthorityReady(connection, 'host-a')).toBe(true)
    expect(isPackageSmokeFirstRunAuthorityReady(connection, 'host-b')).toBe(false)
    expect(isPackageSmokeFirstRunAuthorityReady({ ...connection, phase: 'reconnecting' }, 'host-a')).toBe(false)
    expect(
      isPackageSmokeFirstRunAuthorityReady(
        readyConnection({ capabilities: ['runtime_integrity_v1'] }),
        'host-a',
      ),
    ).toBe(false)
  })
})

function readyConnection(overrides: Partial<ConnectionState> = {}): ConnectionState {
  return {
    phase: 'online',
    target: { kind: 'local' },
    hostId: 'host-a',
    path: 'local_socket',
    since: '2026-08-07T12:00:00.000Z',
    attempt: 0,
    capabilities: ['runtime_integrity_v1'],
    runtimeReadiness: reportedReadiness('host-a'),
    ...overrides
  }
}

function reportedReadiness(hostId: string, snapshot = runtimeSnapshot('ready')) {
  return {
    kind: 'reported' as const,
    hostId,
    hostdVersion: '0.1.0',
    startedAt: '2026-08-07T12:00:00.000Z',
    observedAt: '2026-08-07T12:00:01.000Z',
    snapshot
  }
}

function runtimeSnapshot(status: 'ready' | 'initializing'): RuntimeIntegritySnapshot {
  const base = {
    contractVersion: 1 as const,
    changedAt: '2026-08-07T12:00:00.000Z',
    trustAnchorId: DIGEST_A,
    target: {
      runtime: 'prime-agent' as const,
      releaseVersion: '0.7.0',
      runtimeBuildId: 'fixture-build-1',
      platform: 'win32',
      arch: 'x64',
      manifestSha256: DIGEST_A,
      treeSha256: DIGEST_B,
      filesSha256: DIGEST_C
    }
  }
  return status === 'ready'
    ? { ...base, status, assurance: 'development-integrity' }
    : { ...base, status, phase: 'verifying', attempt: 1 }
}
