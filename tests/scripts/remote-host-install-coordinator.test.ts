import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as CoordinatorModule from '../../scripts/remote-host-install-coordinator.mjs'
import * as JournalModule from '../../scripts/remote-host-install-journal.mjs'
import {
  REMOTE_HOST_KIT_CLAIM_KEYS,
  REMOTE_HOST_KIT_RUNTIME_IDENTITY,
  createRemoteHostKitSignatureEnvelope,
  createRemoteHostKitSignaturePreimage,
  createRemoteHostKitTrustAnchorId,
  serializeRemoteHostKitManifest,
  serializeRemoteHostKitSignatureEnvelope,
} from '../../scripts/remote-host-kit-lib.mjs'
import type { RemoteHostKitManifest } from '../../scripts/remote-host-kit-lib.mjs'

const {
  REMOTE_HOST_INSTALL_COORDINATOR_CLAIM_KEYS,
  REMOTE_HOST_INSTALL_COORDINATOR_FAULT_POINTS,
  openRemoteHostInstallCoordinator,
} = CoordinatorModule

const JournalRuntime = JournalModule as typeof JournalModule & Readonly<{
  __REMOTE_HOST_INSTALL_VITEST_ONLY_WINDOWS_REFERENCE_FENCE: object
}>

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('verified remote host install coordinator', () => {
  it('owns verification before journal I/O and derives exact kit, target, and artifact correlation', async () => {
    const directory = await temporaryDirectory()
    const fixture = signedKit('one')
    const coordinator = await openCoordinator(directory, fixture)
    const empty = await coordinator.readState()
    expect(empty.identity).toMatchObject({
      operationId: operationId,
      packageId: fixture.manifest.packageId,
      manifestSha256: fixture.manifestSha256,
      trustAnchorId: fixture.trust.trustAnchorId,
      signerKeyId: fixture.trust.signerKeyId,
      targetAuthoritySha256,
      installMode: 'fresh_install',
      destinationState: 'absent',
    })
    expect(empty.kitCorrelation).toMatchObject({
      manifestSha256: fixture.manifestSha256,
      target: { platform: 'linux', arch: 'x64', libc: 'glibc' },
      installAction: 'fresh_install',
      verification: {
        ed25519SignatureVerified: true,
        artifactBytesCorrelated: true,
      },
    })
    expect(Object.keys(empty.kitCorrelation.artifacts).sort()).toEqual([
      'hostd',
      'launcher',
      'runtime',
      'service',
    ])
    expect(REMOTE_HOST_INSTALL_COORDINATOR_CLAIM_KEYS.every((key) => empty.claims[key] === false)).toBe(true)
    expect(empty.effectAuthority).toBeNull()
    expect(JSON.stringify(empty)).not.toContain(directory)

    const initialized = await coordinator.initialize({ evidenceSha256: null })
    expect(initialized.journal.currentRecord?.phase).toBe('planned')
    const admitted = await coordinator.admit({
      expectedRevision: initialized.journal.currentRecord!.revision,
      expectedRecordSha256: initialized.journal.currentRecord!.recordSha256,
      evidenceSha256: digest('1'),
    })
    expect(admitted.journal.currentRecord?.phase).toBe('admitted')
    expect(admitted.identity.targetAuthoritySha256).toBe(targetAuthoritySha256)
  })

  it('rejects signature, manifest, artifact, trust, and target cross-feed before journal mutation', async () => {
    const attacks: Array<(fixture: SignedKit) => Record<string, unknown>> = [
      (fixture) => ({ artifactBytes: { ...fixture.artifactBytes, service: Buffer.from('wrong-service') } }),
      (fixture) => ({ envelopeBytes: signedKit('two').envelopeBytes }),
      (fixture) => ({ manifestBytes: signedKit('three').manifestBytes }),
      (fixture) => ({ independentTrust: { ...fixture.trust, signerKeyId: 'test-only-other-signer' } }),
      () => ({ targetAuthoritySha256: '0'.repeat(64) }),
    ]

    for (const attack of attacks) {
      const directory = await temporaryDirectory()
      const fixture = signedKit('one')
      await expect(openCoordinator(directory, fixture, attack(fixture))).rejects.toMatchObject({
        code: 'coordinator_kit_verification_failed',
      })
      expect(await readdir(directory)).toEqual([])
    }
  })

  it('consumes private authority before invoking an effect exactly once and never replays after restart', async () => {
    const directory = await temporaryDirectory()
    const fixture = signedKit('dispatch')
    const { coordinator, admitted } = await admittedCoordinator(directory, fixture)
    let calls = 0
    let receivedArguments = -1

    const result = await coordinator.dispatch({
      expectedRevision: admitted.revision,
      expectedRecordSha256: admitted.recordSha256,
      dispatchEvidenceSha256: digest('2'),
      remotePreparedEvidenceSha256: digest('3'),
      outcomeUnknownEvidenceSha256: digest('4'),
      effect: ((...args: unknown[]) => {
        calls += 1
        receivedArguments = args.length
        return { privatePath: 'C:\\private\\must-not-persist', secret: 'must-not-persist' }
      }) as () => void,
    })

    expect(result).toMatchObject({ outcome: 'remote_prepared', effectAuthority: null })
    expect(result.record.phase).toBe('remote_prepared')
    expect(calls).toBe(1)
    expect(receivedArguments).toBe(0)
    expect(JSON.stringify(result)).not.toContain('must-not-persist')
    expect((await readdir(directory)).sort()).toEqual([
      'r0000.json',
      'r0001.json',
      'r0002.json',
      'r0003.json',
    ])

    await expect(coordinator.dispatch({
      expectedRevision: admitted.revision,
      expectedRecordSha256: admitted.recordSha256,
      dispatchEvidenceSha256: digest('2'),
      remotePreparedEvidenceSha256: digest('3'),
      outcomeUnknownEvidenceSha256: digest('4'),
      effect: () => { calls += 1 },
    })).rejects.toMatchObject({ code: 'coordinator_dispatch_already_crossed' })

    const restarted = await openCoordinator(directory, fixture)
    const recovered = await restarted.readState()
    expect(recovered.journal.currentRecord?.phase).toBe('remote_prepared')
    expect(recovered.journal.statusOnly).toBe(true)
    await expect(restarted.dispatch({
      expectedRevision: result.record.revision,
      expectedRecordSha256: result.record.recordSha256,
      dispatchEvidenceSha256: digest('5'),
      remotePreparedEvidenceSha256: digest('6'),
      outcomeUnknownEvidenceSha256: digest('7'),
      effect: () => { calls += 1 },
    })).rejects.toMatchObject({ code: 'coordinator_dispatch_not_admitted' })
    expect(calls).toBe(1)

    const reconciled = await restarted.reconcile({
      expectedRevision: result.record.revision,
      expectedRecordSha256: result.record.recordSha256,
      phase: 'package_published',
      evidenceSha256: digest('5'),
    })
    expect(reconciled.journal.currentRecord?.phase).toBe('package_published')
    expect(reconciled.effectAuthority).toBeNull()
  })

  it('lets at most one of two same-admission coordinators invoke and never replays the winning fence', async () => {
    const directory = await temporaryDirectory()
    const fixture = signedKit('coordinator-race')
    const first = await openCoordinator(directory, fixture)
    const planned = (await first.initialize({ evidenceSha256: null })).journal.currentRecord!
    const admitted = (await first.admit({
      expectedRevision: planned.revision,
      expectedRecordSha256: planned.recordSha256,
      evidenceSha256: digest('1'),
    })).journal.currentRecord!
    const second = await openCoordinator(directory, fixture)
    let firstCalls = 0
    let secondCalls = 0
    const dispatchInput = {
      expectedRevision: admitted.revision,
      expectedRecordSha256: admitted.recordSha256,
      dispatchEvidenceSha256: digest('2'),
      remotePreparedEvidenceSha256: digest('3'),
      outcomeUnknownEvidenceSha256: digest('4'),
    }

    const attempts = await Promise.allSettled([
      first.dispatch({ ...dispatchInput, effect: () => { firstCalls += 1 } }),
      second.dispatch({ ...dispatchInput, effect: () => { secondCalls += 1 } }),
    ])
    expect(firstCalls + secondCalls).toBeLessThanOrEqual(1)
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled').length).toBeLessThanOrEqual(1)

    const restarted = await openCoordinator(directory, fixture)
    const recovered = await restarted.readState()
    expect(recovered.journal.currentRecord!.revision).toBeGreaterThanOrEqual(2)
    expect(['dispatching', 'remote_prepared']).toContain(recovered.journal.currentRecord?.phase)
    expect(recovered.journal.statusOnly).toBe(true)
    const callsBeforeReplayAttempts = firstCalls + secondCalls
    const replay = {
      expectedRevision: recovered.journal.currentRecord!.revision,
      expectedRecordSha256: recovered.journal.currentRecord!.recordSha256,
      dispatchEvidenceSha256: digest('5'),
      remotePreparedEvidenceSha256: digest('6'),
      outcomeUnknownEvidenceSha256: digest('7'),
      effect: () => { firstCalls += 1 },
    }
    await expect(restarted.dispatch(replay)).rejects.toMatchObject({
      code: 'coordinator_dispatch_not_admitted',
    })
    await expect(first.dispatch(replay)).rejects.toMatchObject({
      name: 'RemoteHostInstallCoordinatorError',
    })
    await expect(second.dispatch(replay)).rejects.toMatchObject({
      name: 'RemoteHostInstallCoordinatorError',
    })
    expect(firstCalls + secondCalls).toBe(callsBeforeReplayAttempts)
  })

  it('records callback throw as outcome_unknown without persisting or returning its cause', async () => {
    const directory = await temporaryDirectory()
    const fixture = signedKit('throw')
    const { coordinator, admitted } = await admittedCoordinator(directory, fixture)
    const result = await coordinator.dispatch({
      expectedRevision: admitted.revision,
      expectedRecordSha256: admitted.recordSha256,
      dispatchEvidenceSha256: digest('2'),
      remotePreparedEvidenceSha256: digest('3'),
      outcomeUnknownEvidenceSha256: digest('4'),
      effect() {
        throw new Error('secret callback error /private/path')
      },
    })

    expect(result.outcome).toBe('outcome_unknown')
    expect(result.record.phase).toBe('outcome_unknown')
    expect(JSON.stringify(result)).not.toContain('secret callback')
    expect(await readFile(join(directory, 'r0003.json'), 'utf8')).not.toContain('/private/path')
    const restarted = await openCoordinator(directory, fixture)
    expect((await restarted.readState()).journal.statusOnly).toBe(true)
  })

  it('records an asynchronous callback rejection as outcome_unknown', async () => {
    const directory = await temporaryDirectory()
    const fixture = signedKit('reject')
    const { coordinator, admitted } = await admittedCoordinator(directory, fixture)
    const result = await coordinator.dispatch({
      expectedRevision: admitted.revision,
      expectedRecordSha256: admitted.recordSha256,
      dispatchEvidenceSha256: digest('2'),
      remotePreparedEvidenceSha256: digest('3'),
      outcomeUnknownEvidenceSha256: digest('4'),
      effect: async () => {
        throw new Error('async secret and /private/path')
      },
    })
    expect(result.outcome).toBe('outcome_unknown')
    expect(result.record.phase).toBe('outcome_unknown')
    expect(JSON.stringify(result)).not.toContain('async secret')
  })

  it('returns no capability or replay route at every coordinator dispatch fault boundary', async () => {
    const dispatchFaults = REMOTE_HOST_INSTALL_COORDINATOR_FAULT_POINTS.filter(
      (point) => point !== 'after_kit_verification_before_journal_open',
    )

    for (const faultPoint of dispatchFaults) {
      const directory = await temporaryDirectory()
      const fixture = signedKit(`fault-${faultPoint}`)
      const coordinator = await openCoordinator(directory, fixture, {
        coordinatorFaultInjector(point: typeof REMOTE_HOST_INSTALL_COORDINATOR_FAULT_POINTS[number]) {
          if (point === faultPoint) throw new Error('raw coordinator fault')
        },
      })
      const planned = (await coordinator.initialize({ evidenceSha256: null })).journal.currentRecord!
      const admitted = (await coordinator.admit({
        expectedRevision: planned.revision,
        expectedRecordSha256: planned.recordSha256,
        evidenceSha256: digest('1'),
      })).journal.currentRecord!
      let calls = 0
      const callbackThrows = faultPoint === 'after_effect_throw_before_outcome_unknown'

      await expect(coordinator.dispatch({
        expectedRevision: admitted.revision,
        expectedRecordSha256: admitted.recordSha256,
        dispatchEvidenceSha256: digest('2'),
        remotePreparedEvidenceSha256: digest('3'),
        outcomeUnknownEvidenceSha256: digest('4'),
        effect() {
          calls += 1
          if (callbackThrows) throw new Error('private callback failure')
        },
      })).rejects.toMatchObject({ name: 'RemoteHostInstallCoordinatorError' })

      const effectReached = [
        'after_effect_success_before_remote_prepared',
        'after_effect_throw_before_outcome_unknown',
        'after_outcome_publication',
      ].includes(faultPoint)
      expect(calls).toBe(effectReached ? 1 : 0)

      const restarted = await openCoordinator(directory, fixture)
      const recovered = await restarted.readState()
      expect(recovered.effectAuthority).toBeNull()
      expect(['dispatching', 'remote_prepared', 'outcome_unknown']).toContain(
        recovered.journal.currentRecord?.phase,
      )
      await expect(restarted.dispatch({
        expectedRevision: recovered.journal.currentRecord!.revision,
        expectedRecordSha256: recovered.journal.currentRecord!.recordSha256,
        dispatchEvidenceSha256: digest('5'),
        remotePreparedEvidenceSha256: digest('6'),
        outcomeUnknownEvidenceSha256: digest('7'),
        effect: () => { calls += 1 },
      })).rejects.toMatchObject({ code: 'coordinator_dispatch_not_admitted' })
      expect(calls).toBe(effectReached ? 1 : 0)
    }
  })

  it('does no journal I/O when verification-stage fault injection fails', async () => {
    const directory = await temporaryDirectory()
    const fixture = signedKit('verify-fault')
    await expect(openCoordinator(directory, fixture, {
      coordinatorFaultInjector(point: typeof REMOTE_HOST_INSTALL_COORDINATOR_FAULT_POINTS[number]) {
        if (point === 'after_kit_verification_before_journal_open') throw new Error('private')
      },
    })).rejects.toMatchObject({ code: 'coordinator_fault_injected' })
    expect(await readdir(directory)).toEqual([])
  })

  it('does not mint or invoke after a journal fault following a persisted dispatch fence', async () => {
    const directory = await temporaryDirectory()
    const fixture = signedKit('journal-fault')
    let armed = false
    const coordinator = await openCoordinator(directory, fixture, {
      journalFaultInjector(point: typeof JournalModule.REMOTE_HOST_INSTALL_JOURNAL_FAULT_POINTS[number]) {
        if (armed && point === 'before_append_resolve') throw new Error('uncertain')
      },
    })
    const planned = (await coordinator.initialize({ evidenceSha256: null })).journal.currentRecord!
    const admitted = (await coordinator.admit({
      expectedRevision: planned.revision,
      expectedRecordSha256: planned.recordSha256,
      evidenceSha256: digest('1'),
    })).journal.currentRecord!
    let calls = 0
    armed = true
    await expect(coordinator.dispatch({
      expectedRevision: admitted.revision,
      expectedRecordSha256: admitted.recordSha256,
      dispatchEvidenceSha256: digest('2'),
      remotePreparedEvidenceSha256: digest('3'),
      outcomeUnknownEvidenceSha256: digest('4'),
      effect: () => { calls += 1 },
    })).rejects.toMatchObject({ code: 'coordinator_dispatch_outcome_uncertain' })
    expect(calls).toBe(0)

    const restarted = await openCoordinator(directory, fixture)
    expect((await restarted.readState()).journal.currentRecord?.phase).toBe('dispatching')
  })

  it('binds one concrete target authority and rejects journal cross-feed', async () => {
    const directory = await temporaryDirectory()
    const fixture = signedKit('target')
    const coordinator = await openCoordinator(directory, fixture)
    await coordinator.initialize({ evidenceSha256: null })

    await expect(openCoordinator(directory, fixture, {
      targetAuthoritySha256: digest('9'),
    })).rejects.toMatchObject({ code: 'coordinator_journal_open_failed' })
  })

  it('rejects proxies, accessors, symbols, and fake trust objects without exposing authority APIs', async () => {
    const directory = await temporaryDirectory()
    const fixture = signedKit('strict')
    const ordinary = coordinatorOptions(directory, fixture)
    await expect(openRemoteHostInstallCoordinator(new Proxy(ordinary, {}))).rejects.toMatchObject({
      code: 'coordinator_options_invalid',
    })

    const accessor = { ...ordinary }
    Object.defineProperty(accessor, 'operationId', { enumerable: true, get: () => operationId })
    await expect(openRemoteHostInstallCoordinator(accessor)).rejects.toMatchObject({
      code: 'coordinator_options_invalid',
    })

    const symbolInput = { ...ordinary, [Symbol('extra')]: false }
    await expect(openRemoteHostInstallCoordinator(symbolInput)).rejects.toMatchObject({
      code: 'coordinator_options_invalid',
    })

    await expect(openCoordinator(directory, fixture, {
      independentTrust: {
        ...fixture.trust,
        publicKey: {
          type: 'public',
          asymmetricKeyType: 'ed25519',
          export: () => Buffer.alloc(44),
        },
      },
    })).rejects.toMatchObject({ code: 'coordinator_kit_verification_failed' })

    expect(Object.keys(CoordinatorModule)).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/capability|confirm|authority/i),
    ]))
    const declaration = await readFile('scripts/remote-host-install-coordinator.d.mts', 'utf8')
    expect(declaration).not.toContain('__vitestWindowsReferenceFence')
    expect(declaration).not.toContain('VITEST_ONLY_WINDOWS_REFERENCE_FENCE')
  })

  it('is unreachable from product/runtime/build/install entrypoints', async () => {
    const ordinarySources = await Promise.all([
      readFile(resolve('package.json'), 'utf8'),
      readFile(resolve('scripts/run-workflow.mjs'), 'utf8'),
      readFile(resolve('scripts/build-hostd.mjs'), 'utf8'),
      readFile(resolve('scripts/self-build.mjs'), 'utf8'),
      readFile(resolve('scripts/after-pack-windows.mjs'), 'utf8'),
      readFile(resolve('scripts/verify-windows-package.mjs'), 'utf8'),
      readFile(resolve('src/main/index.ts'), 'utf8'),
      readFile(resolve('src/main/control/service.ts'), 'utf8'),
      readFile(resolve('src/main/control/ipc.ts'), 'utf8'),
      readFile(resolve('src/main/control/contracts.ts'), 'utf8'),
      readFile(resolve('src/preload/index.ts'), 'utf8'),
      readFile(resolve('src/renderer/src/api.ts'), 'utf8'),
      readFile(resolve('src/renderer/src/App.tsx'), 'utf8'),
      readFile(resolve('src/hostd/index.ts'), 'utf8'),
      readFile(resolve('src/hostd/service.ts'), 'utf8'),
    ])
    for (const source of ordinarySources) {
      expect(source).not.toContain('remote-host-install-journal')
      expect(source).not.toContain('remote-host-install-coordinator')
    }
  })

  it('rejects ordinary win32 construction before filesystem I/O', async () => {
    if (process.platform !== 'win32') return
    const fixture = signedKit('win32-reject')
    const nonexistent = join(tmpdir(), `prime-coordinator-must-not-exist-${Date.now()}`)
    await expect(openRemoteHostInstallCoordinator({
      journalDirectory: nonexistent,
      operationId,
      targetAuthoritySha256,
      manifestBytes: fixture.manifestBytes,
      envelopeBytes: fixture.envelopeBytes,
      artifactBytes: fixture.artifactBytes,
      independentTrust: fixture.trust,
    })).rejects.toMatchObject({ code: 'coordinator_journal_open_failed' })
    await expect(lstat(nonexistent)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

type SignedKit = ReturnType<typeof signedKit>

async function temporaryDirectory() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'prime-remote-host-coordinator-test-')))
  temporaryDirectories.push(directory)
  return directory
}

async function admittedCoordinator(directory: string, fixture: SignedKit) {
  const coordinator = await openCoordinator(directory, fixture)
  const planned = (await coordinator.initialize({ evidenceSha256: null })).journal.currentRecord!
  const admitted = (await coordinator.admit({
    expectedRevision: planned.revision,
    expectedRecordSha256: planned.recordSha256,
    evidenceSha256: digest('1'),
  })).journal.currentRecord!
  return { coordinator, admitted }
}

function openCoordinator(
  journalDirectory: string,
  fixture: SignedKit,
  overrides: Record<string, unknown> = {},
) {
  return openRemoteHostInstallCoordinator(coordinatorOptions(journalDirectory, fixture, overrides))
}

function coordinatorOptions(
  journalDirectory: string,
  fixture: SignedKit,
  overrides: Record<string, unknown> = {},
) {
  const options: Record<string, unknown> = {
    journalDirectory,
    operationId,
    targetAuthoritySha256,
    manifestBytes: fixture.manifestBytes,
    envelopeBytes: fixture.envelopeBytes,
    artifactBytes: fixture.artifactBytes,
    independentTrust: fixture.trust,
    ...overrides,
  }
  if (process.platform === 'win32') {
    options.__vitestWindowsReferenceFence =
      JournalRuntime.__REMOTE_HOST_INSTALL_VITEST_ONLY_WINDOWS_REFERENCE_FENCE
  }
  return options as unknown as Parameters<typeof openRemoteHostInstallCoordinator>[0]
}

function signedKit(seed: string) {
  const keys = generateKeyPairSync('ed25519')
  const artifactBytes = {
    hostd: Buffer.from(`hostd-${seed}`, 'utf8'),
    runtime: Buffer.from(`runtime-${seed}`, 'utf8'),
    launcher: Buffer.from(`launcher-${seed}`, 'utf8'),
    service: Buffer.from(`service-${seed}`, 'utf8'),
  }
  const manifest: RemoteHostKitManifest = {
    schema: 'remote-host-kit/v1',
    packageId: `prime-remote-kit-${seed.replaceAll('_', '-').slice(0, 48)}`,
    hostdVersion: '0.1.0',
    protocolVersion: 1,
    target: { platform: 'linux', arch: 'x64', libc: 'glibc' },
    runtimeIdentity: { ...REMOTE_HOST_KIT_RUNTIME_IDENTITY },
    artifacts: {
      hostd: artifact('hostd', artifactBytes.hostd),
      runtime: artifact('runtime', artifactBytes.runtime),
      launcher: artifact('launcher', artifactBytes.launcher),
      service: artifact('service', artifactBytes.service),
    },
    installAction: 'fresh_install',
    trustAnchorId: createRemoteHostKitTrustAnchorId(keys.publicKey),
    signerKeyId: 'test-only-coordinator-signer',
    claims: Object.fromEntries(
      REMOTE_HOST_KIT_CLAIM_KEYS.map((key) => [key, false]),
    ) as Record<(typeof REMOTE_HOST_KIT_CLAIM_KEYS)[number], false>,
  }
  const signature = sign(null, createRemoteHostKitSignaturePreimage(manifest), keys.privateKey)
  const envelope = createRemoteHostKitSignatureEnvelope(manifest, signature)
  const manifestBytes = serializeRemoteHostKitManifest(manifest)
  const envelopeBytes = serializeRemoteHostKitSignatureEnvelope(envelope)
  return {
    manifest,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    manifestBytes,
    envelopeBytes,
    artifactBytes,
    trust: {
      trustAnchorId: manifest.trustAnchorId,
      signerKeyId: manifest.signerKeyId,
      publicKey: keys.publicKey,
    },
  }
}

function artifact<Role extends 'hostd' | 'runtime' | 'launcher' | 'service'>(role: Role, bytes: Buffer) {
  return {
    role,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
  }
}

const operationId = '12345678-1234-4234-9234-123456789abc'
const targetAuthoritySha256 = createHash('sha256').update('test-only-target-authority').digest('hex')

function digest(character: string) {
  return character.repeat(64)
}
