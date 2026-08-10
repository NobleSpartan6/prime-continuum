import { createHash } from 'node:crypto'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APPCONTAINER_PROBE_OPERATION_MAX_RECORD_BYTES,
  APPCONTAINER_PROBE_OPERATION_PHASES,
  openAppContainerProbeOperationJournal,
  type AppContainerProbeOperationIdentity,
  type AppContainerProbeOperationJournal,
  type AppContainerProbeOperationPhase,
} from '../../scripts/windows-appcontainer-probe-operation.mjs'

const temporaryRoots: string[] = []
const TEST_ONLY_WINDOWS_REFERENCE_FENCE_KEY = '__testOnlyWindowsReferencePublicationFence'

interface WindowsReferenceFenceRequest {
  readonly kind: 'prime_continuim_appcontainer_probe_operation_test_publication_fence_v1'
  readonly finalPath: string
  readonly expectedIdentity: Readonly<{ device: string; inode: string }>
  readonly expectedBytes: number
  readonly expectedSha256: string
}

type WindowsReferenceFence = (request: Readonly<WindowsReferenceFenceRequest>) => void | Promise<void>

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })))
})

describe('source-reference AppContainer probe operation journal', () => {
  it('writes one canonical immutable hash-chained reference prefix and commits before the test-only invocation effect', async () => {
    const path = await operationDirectory('prime-appcontainer-operation-complete-')
    const mutableIdentity = identity()
    const journal = await openAppContainerProbeOperationJournal({
      hostPrivateOperationPath: path,
      identity: mutableIdentity,
      ...windowsReferenceFenceOptions(),
    })
    await journal.reconfirmPreInvocation({ expectedRevision: 0, confirmationSha256: evidence(200) })
    mutableIdentity.correlationId = 'f'.repeat(32)
    mutableIdentity.provenance.probePayload.bytes = 1

    let invocationCount = 0
    for (const [index, phase] of APPCONTAINER_PROBE_OPERATION_PHASES.entries()) {
      if (phase === 'invocation_committed') {
        const result = await journal.commitInvocation({
          expectedRevision: index,
          evidenceSha256: evidence(index),
        }, async () => {
          invocationCount += 1
          const observer = await openAppContainerProbeOperationJournal({
            hostPrivateOperationPath: path,
            identity: identity(),
            ...windowsReferenceFenceOptions(),
          })
          expect((await observer.readState()).finalPhase).toBe('invocation_committed')
          return 'launched-once'
        })
        expect(result).toMatchObject({
          replayed: false,
          invocation: 'performed_after_commit',
          value: 'launched-once',
        })
      } else {
        expect(await journal.advance({
          expectedRevision: index,
          phase,
          evidenceSha256: evidence(index),
        })).toMatchObject({ replayed: false, record: { phase } })
      }
    }

    const state = await journal.readState()
    expect(invocationCount).toBe(1)
    expect(state).toMatchObject({
      revision: 9,
      phases: APPCONTAINER_PROBE_OPERATION_PHASES,
      finalPhase: 'settled',
      restartDisposition: 'settled',
      operationMode: 'source_reference_only',
      invocationReplayPolicy: 'reference_only_requires_native_owner_lease_recovery_fence',
      finalReceiptPublication: 'external_host_no_replace_not_implemented',
      claims: {
        liveWindowsPhasePublication: false,
        durableNoRelaunch: false,
        nativeOwnerLeaseRecoveryFence: false,
        finalReceiptPublished: false,
      },
      identity: {
        correlationId: '1'.repeat(32),
        provenance: {
          nativeSupervisor: { role: 'native_supervisor', machine: 'x64', bytes: 6144 },
          probePayload: { role: 'launch_target', machine: 'x64', bytes: 8192 },
          nativeBuildManifest: { role: 'native_build_manifest', machine: 'x64', bytes: 1024 },
        },
      },
    })
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.identity.provenance)).toBe(true)
    expect(state.records.every((record) => Object.isFrozen(record))).toBe(true)
    expect(state.records.map((record) => record.previousRecordSha256)).toEqual([
      null,
      ...state.records.slice(0, -1).map((record) => record.recordSha256),
    ])
    expect(state.records.map((record) => record.recordSha256)).toEqual([
      // These literals freeze the canonical schema, complete v3 provenance
      // identity, and predecessor-chain algorithm for this exact fixture.
      'f3ba32ca5fe59cee40b4db6b14f381e19b7c8d5eefe98f72b098d539d592cc04',
      'de1ff6ac64c400039670b0e69cef0935956aabe438187ab53900ec145f55b83d',
      '26b2fb07a5a88b08ea60b4a17bf97430565d999663fda852f4abab4cb7296341',
      '108a9f044da75ed17b1a2069f498a55e63f5f6c3c32c0f9a4124009e245dab80',
      'ffe24c18fa9cd7c400e9cc6b31d0ef77c8861f7b78d59a1985da0fb39dbfb121',
      'dbc267f81afc31a548760e70f95e3c496e35959c5d8c77e9877b4fcf91ae3300',
      'd8bb1e00a23c9c1b5858bc0eb1c9bc170f605b2fac4878164f0c94df6913c84e',
      'f21e83788be2bbd1581a26b91838619bc910d1d6488465af236005621c073320',
      '7036486c671a1ed8c42789e0872f8a0281910afa320a2478097e66fe2fa1283b',
    ])

    const names = (await readdir(path)).sort()
    expect(names).toEqual(APPCONTAINER_PROBE_OPERATION_PHASES.map((phase, index) =>
      `${String(index + 1).padStart(2, '0')}-${phase}.json`))
    for (const name of names) {
      const text = await readFile(join(path, name), 'utf8')
      expect(text.endsWith('\n')).toBe(true)
      expect(text).not.toContain('\r')
      expect(text).toBe(`${canonicalJson(JSON.parse(text))}\n`)
    }

    const oldRetry = await journal.advance({
      expectedRevision: 0,
      phase: 'prepared',
      evidenceSha256: evidence(0),
    })
    expect(oldRetry).toMatchObject({ replayed: true, record: { revision: 1, phase: 'prepared' } })
  })

  it('requires fresh in-memory confirmation after every pre-invocation restart', async () => {
    const emptyPath = await operationDirectory('prime-appcontainer-operation-empty-reconfirm-')
    const empty = await openAppContainerProbeOperationJournal({
      hostPrivateOperationPath: emptyPath,
      identity: identity(),
      ...windowsReferenceFenceOptions(),
    })
    await expect(commitPhase(empty, 0)).rejects.toMatchObject({ code: 'RECONFIRMATION_REQUIRED' })
    await expect(empty.reconfirmPreInvocation({
      expectedRevision: 0,
      confirmationSha256: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'REQUEST_INVALID' })
    await empty.reconfirmPreInvocation({ expectedRevision: 0, confirmationSha256: evidence(89) })
    await commitPhase(empty, 0)

    const path = await operationDirectory('prime-appcontainer-operation-reconfirm-')
    const first = await openJournal(path)
    await commitPhase(first, 0)
    await commitPhase(first, 1)

    const restarted = await openJournal(path)
    await expect(commitPhase(restarted, 2)).rejects.toMatchObject({ code: 'RECONFIRMATION_REQUIRED' })
    await expect(restarted.reconfirmPreInvocation({
      expectedRevision: 1,
      confirmationSha256: evidence(90),
    })).rejects.toMatchObject({ code: 'RECONFIRMATION_NOT_APPLICABLE' })
    await restarted.reconfirmPreInvocation({
      expectedRevision: 2,
      confirmationSha256: evidence(90),
    })
    await commitPhase(restarted, 2)

    const restartedAgain = await openJournal(path)
    await expect(commitPhase(restartedAgain, 3)).rejects.toMatchObject({ code: 'RECONFIRMATION_REQUIRED' })
    await restartedAgain.reconfirmPreInvocation({
      expectedRevision: 3,
      confirmationSha256: evidence(91),
    })
    let invoked = 0
    await commitPhase(restartedAgain, 3, () => { invoked += 1 })
    expect(invoked).toBe(1)

    const postCommitRestart = await openJournal(path)
    expect((await postCommitRestart.readState()).restartDisposition).toBe('observe_retire_cleanup_only')
    const retry = await postCommitRestart.commitInvocation({
      expectedRevision: 3,
      evidenceSha256: evidence(3),
    }, () => { invoked += 1 })
    expect(retry.invocation).toBe('suppressed_existing_commit')
    expect(invoked).toBe(1)
  })

  it('keeps the host-private journal outside a deleted sandbox-visible operation root', async () => {
    const journalPath = await operationDirectory('prime-appcontainer-operation-private-journal-')
    const disposableOperationRoot = await operationDirectory('prime-appcontainer-operation-disposable-root-')
    await mkdir(join(disposableOperationRoot, 'scratch'), { mode: 0o700 })
    await mkdir(join(disposableOperationRoot, 'tool'), { mode: 0o700 })
    const journal = await openJournal(journalPath)
    for (let index = 0; index < 7; index += 1) await commitPhase(journal, index)

    await rm(disposableOperationRoot, { recursive: true })
    expect(await readdir(journalPath)).toHaveLength(7)
    await commitPhase(journal, 7)
    await commitPhase(journal, 8)

    expect(await journal.readState()).toMatchObject({
      finalPhase: 'settled',
      revision: 9,
      operationMode: 'source_reference_only',
    })
  })

  it.runIf(process.platform === 'win32')(
    'rejects ordinary Windows open before scanning, publication, or callback access',
    async () => {
      const emptyPath = await operationDirectory('prime-appcontainer-operation-windows-reference-empty-')
      const operationSlug = identity().operationId.replaceAll('-', '')
      const ownedStaleName = `.pcao-tmp-${operationSlug}-01-99999999-${'a'.repeat(16)}.tmp`
      const ownedStaleBytes = 'owned stale reference create must remain untouched\n'
      await writePrivateFile(join(emptyPath, ownedStaleName), ownedStaleBytes)
      await expect(openAppContainerProbeOperationJournal({
        hostPrivateOperationPath: emptyPath,
        identity: identity(),
      })).rejects.toMatchObject({ code: 'WINDOWS_REFERENCE_ONLY' })
      expect(await readdir(emptyPath)).toEqual([ownedStaleName])
      expect(await readFile(join(emptyPath, ownedStaleName), 'utf8')).toBe(ownedStaleBytes)

      const path = await operationDirectory('prime-appcontainer-operation-windows-reference-only-')
      await seedPrefix(path, 3)
      await expect(openAppContainerProbeOperationJournal({
        hostPrivateOperationPath: path,
        identity: identity(),
      })).rejects.toMatchObject({ code: 'WINDOWS_REFERENCE_ONLY' })
      expect((await readdir(path)).sort()).toEqual(
        APPCONTAINER_PROBE_OPERATION_PHASES.slice(0, 3).map((phase, index) =>
          `${String(index + 1).padStart(2, '0')}-${phase}.json`),
      )
    },
  )

  it.runIf(process.platform === 'win32')(
    'keeps test-only throwing or byte-mismatching publication fences fail-closed before the effect',
    async () => {
      for (const failure of ['throwing', 'mismatched'] as const) {
        const path = await operationDirectory(`prime-appcontainer-operation-windows-fence-${failure}-`)
        await seedPrefix(path, 3)
        let fenceCalls = 0
        const journal = await openJournal(path, undefined, async (request) => {
          fenceCalls += 1
          expect(request).toMatchObject({
            kind: 'prime_continuim_appcontainer_probe_operation_test_publication_fence_v1',
            expectedBytes: expect.any(Number),
            expectedSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          })
          if (failure === 'throwing') throw new Error('test fence failed')
          await writeFile(request.finalPath, 'mismatched reference bytes\n', { mode: 0o600 })
        })
        await journal.reconfirmPreInvocation({ expectedRevision: 3, confirmationSha256: evidence(93) })
        let invoked = 0
        await expect(journal.commitInvocation({
          expectedRevision: 3,
          evidenceSha256: evidence(3),
        }, () => { invoked += 1 })).rejects.toMatchObject({ code: 'COMMIT_UNCERTAIN' })
        expect(fenceCalls).toBe(1)
        expect(invoked).toBe(0)
      }
    },
  )

  it('snapshots exact option descriptor values without consulting Proxy get traps', async () => {
    const path = await operationDirectory('prime-appcontainer-operation-option-snapshot-')
    const options = {
      hostPrivateOperationPath: path,
      identity: identity(),
      faultInjector: undefined,
      ...windowsReferenceFenceOptions(),
    }
    const proxy = new Proxy(options, {
      get() {
        throw new Error('option get trap must not run')
      },
    })
    const journal = await openAppContainerProbeOperationJournal(proxy)
    await journal.reconfirmPreInvocation({ expectedRevision: 0, confirmationSha256: evidence(94) })
    expect(await commitPhase(journal, 0)).toMatchObject({ replayed: false })

    const accessorOptions = { ...options } as any
    Object.defineProperty(accessorOptions, 'hostPrivateOperationPath', {
      enumerable: true,
      get: () => path,
    })
    await expect(openAppContainerProbeOperationJournal(accessorOptions))
      .rejects.toMatchObject({ code: 'OPTIONS_INVALID' })
  })

  it('freezes only journal-owned invocation results and leaves arbitrary callback values untouched', async () => {
    const path = await operationDirectory('prime-appcontainer-operation-callback-value-')
    await seedPrefix(path, 3)
    const journal = await openJournal(path)
    await journal.reconfirmPreInvocation({ expectedRevision: 3, confirmationSha256: evidence(95) })
    const callbackValue = new Uint8Array([1, 2, 3])
    const result = await journal.commitInvocation({
      expectedRevision: 3,
      evidenceSha256: evidence(3),
    }, () => callbackValue)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(callbackValue)).toBe(false)
    callbackValue[0] = 9
    expect(result.value?.[0]).toBe(9)
  })

  it.each([
    'after_temporary_open',
    'after_temporary_write',
    'after_temporary_close',
  ] as const)('cleans and leaves no commit at the %s fault seam', async (faultPoint) => {
    const path = await operationDirectory(`prime-appcontainer-operation-fault-${faultPoint}-`)
    const journal = await openJournal(path, (point) => {
      if (point === faultPoint) throw new Error(`fault:${faultPoint}`)
    })
    await expect(commitPhase(journal, 0)).rejects.toMatchObject({ code: 'INTERRUPTED_BEFORE_COMMIT' })
    expect(await readdir(path)).toEqual([])
  })

  it('treats after_directory_sync as committed uncertainty and suppresses the reference callback', async () => {
    const path = await operationDirectory('prime-appcontainer-operation-after-directory-sync-')
    await seedPrefix(path, 3)
    const journal = await openJournal(path, (point, phase) => {
      if (point === 'after_directory_sync' && phase === 'invocation_committed') {
        throw new Error('fault:after_directory_sync')
      }
    })
    await journal.reconfirmPreInvocation({ expectedRevision: 3, confirmationSha256: evidence(96) })
    let invoked = 0
    await expect(commitPhase(journal, 3, () => { invoked += 1 }))
      .rejects.toMatchObject({ code: 'COMMIT_UNCERTAIN' })
    expect(invoked).toBe(0)
    const recovered = await openJournal(path)
    expect((await recovered.readState()).finalPhase).toBe('invocation_committed')
    expect((await commitPhase(recovered, 3, () => { invoked += 1 })).replayed).toBe(true)
    expect(invoked).toBe(0)
  })

  it('fails closed at before_existing_final_path_check after an exact concurrent winner', async () => {
    const path = await operationDirectory('prime-appcontainer-operation-existing-final-fault-')
    let releasePublisher!: () => void
    let markPublisherReady!: () => void
    const publisherReady = new Promise<void>((resolveReady) => { markPublisherReady = resolveReady })
    const publisherRelease = new Promise<void>((resolveRelease) => { releasePublisher = resolveRelease })
    const losing = await openJournal(path, async (point, phase) => {
      if (point === 'after_temporary_close' && phase === 'prepared') {
        markPublisherReady()
        await publisherRelease
      }
      if (point === 'before_existing_final_path_check' && phase === 'prepared') {
        throw new Error('fault:before_existing_final_path_check')
      }
    })
    const losingCommit = commitPhase(losing, 0)
    await publisherReady
    const winner = await openJournal(path)
    await commitPhase(winner, 0)
    releasePublisher()
    await expect(losingCommit).rejects.toMatchObject({ code: 'COMMIT_UNCERTAIN' })
    expect((await openJournal(path).then((journal) => journal.readState())).revision).toBe(1)
  })

  it.each(APPCONTAINER_PROBE_OPERATION_PHASES)(
    'converges a post-publication commit uncertainty at %s without duplicating effects',
    async (phase) => {
      const index = APPCONTAINER_PROBE_OPERATION_PHASES.indexOf(phase)
      const path = await operationDirectory(`prime-appcontainer-operation-uncertain-${index}-`)
      await seedPrefix(path, index)
      const faulting = await openJournal(path, (point, currentPhase) => {
        if (point === 'after_publish' && currentPhase === phase) throw new Error(`crash-${phase}`)
      })
      await authorizeRestartedPrefix(faulting, index)
      let invocationCount = 0

      await expect(commitPhase(faulting, index, () => { invocationCount += 1 }))
        .rejects.toMatchObject({ code: 'COMMIT_UNCERTAIN' })
      await expect(commitPhase(faulting, index, () => { invocationCount += 1 }))
        .rejects.toMatchObject({ code: 'JOURNAL_REOPEN_REQUIRED' })

      const recovered = await openJournal(path)
      const state = await recovered.readState()
      expect(state.revision).toBe(index + 1)
      expect(state.finalPhase).toBe(phase)
      expect(state.restartDisposition).toBe(
        index === 8
          ? 'settled'
          : index >= 3
            ? 'observe_retire_cleanup_only'
            : 'operator_reconfirmation_required',
      )
      const retry = await commitPhase(recovered, index, () => { invocationCount += 1 })
      expect(retry.replayed).toBe(true)
      expect(invocationCount).toBe(0)
    },
  )

  it.each(APPCONTAINER_PROBE_OPERATION_PHASES)(
    'leaves no committed phase after a pre-publication crash at %s and requires explicit recovery authority',
    async (phase) => {
      const index = APPCONTAINER_PROBE_OPERATION_PHASES.indexOf(phase)
      const path = await operationDirectory(`prime-appcontainer-operation-precommit-${index}-`)
      await seedPrefix(path, index)
      const faulting = await openJournal(path, (point, currentPhase) => {
        if (point === 'after_temporary_sync' && currentPhase === phase) throw new Error(`crash-${phase}`)
      })
      await authorizeRestartedPrefix(faulting, index)
      let invocationCount = 0

      await expect(commitPhase(faulting, index, () => { invocationCount += 1 }))
        .rejects.toMatchObject({ code: 'INTERRUPTED_BEFORE_COMMIT' })
      const recovered = await openJournal(path)
      expect((await recovered.readState()).revision).toBe(index)
      await authorizeRestartedPrefix(recovered, index)
      const committed = await commitPhase(recovered, index, () => { invocationCount += 1 })
      expect(committed.replayed).toBe(false)
      expect(invocationCount).toBe(phase === 'invocation_committed' ? 1 : 0)
    },
  )

  it('suppresses repeated callbacks after a reference invocation commitment or callback failure', async () => {
    for (const failure of ['before-effect', 'inside-effect'] as const) {
      const path = await operationDirectory(`prime-appcontainer-operation-effect-${failure}-`)
      await seedPrefix(path, 3)
      let invocationCount = 0
      const journal = await openJournal(path, (point) => {
        if (failure === 'before-effect' && point === 'before_invocation_effect') {
          throw new Error('crash before effect')
        }
      })
      await journal.reconfirmPreInvocation({ expectedRevision: 3, confirmationSha256: evidence(88) })
      await expect(journal.commitInvocation({
        expectedRevision: 3,
        evidenceSha256: evidence(3),
      }, () => {
        invocationCount += 1
        if (failure === 'inside-effect') throw new Error('effect failed')
      })).rejects.toMatchObject({
        code: failure === 'before-effect'
          ? 'INTERRUPTED_AFTER_INVOCATION_COMMIT'
          : 'INVOCATION_EFFECT_FAILED',
      })

      const recovered = await openJournal(path)
      const retry = await recovered.commitInvocation({
        expectedRevision: 3,
        evidenceSha256: evidence(3),
      }, () => { invocationCount += 1 })
      expect(retry.invocation).toBe('suppressed_existing_commit')
      expect(invocationCount).toBe(failure === 'inside-effect' ? 1 : 0)
      for (let index = 4; index < APPCONTAINER_PROBE_OPERATION_PHASES.length; index += 1) {
        await commitPhase(recovered, index)
      }
      expect((await recovered.readState()).restartDisposition).toBe('settled')
    }
  })

  it('serializes concurrent exact CAS, rejects divergent collisions, and retains one prefix', async () => {
    const exactPath = await operationDirectory('prime-appcontainer-operation-concurrent-exact-')
    const [exactA, exactB] = await Promise.all([openJournal(exactPath), openJournal(exactPath)])
    const exactResults = await Promise.all([
      commitPhase(exactA, 0),
      commitPhase(exactB, 0),
    ])
    expect(exactResults.map((result) => result.replayed).sort()).toEqual([false, true])
    expect((await openJournal(exactPath).then((journal) => journal.readState())).revision).toBe(1)

    const collisionPath = await operationDirectory('prime-appcontainer-operation-concurrent-collision-')
    const [collisionA, collisionB] = await Promise.all([openJournal(collisionPath), openJournal(collisionPath)])
    const collisionResults = await Promise.allSettled([
      collisionA.advance({ expectedRevision: 0, phase: 'prepared', evidenceSha256: evidence(0, 'a') }),
      collisionB.advance({ expectedRevision: 0, phase: 'prepared', evidenceSha256: evidence(0, 'b') }),
    ])
    expect(collisionResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = collisionResults.find((result) => result.status === 'rejected')
    expect(rejection).toMatchObject({ status: 'rejected', reason: { code: 'CAS_CONFLICT' } })
    expect((await openJournal(collisionPath).then((journal) => journal.readState())).revision).toBe(1)
  })

  it('allows only byte-exact stale retries and never permits invocation through the generic transition API', async () => {
    const path = await operationDirectory('prime-appcontainer-operation-cas-')
    const journal = await openJournal(path)
    await commitPhase(journal, 0)
    expect(await commitPhase(journal, 0)).toMatchObject({ replayed: true })
    await expect(journal.advance({
      expectedRevision: 0,
      phase: 'prepared',
      evidenceSha256: evidence(0, 'different'),
    })).rejects.toMatchObject({ code: 'CAS_CONFLICT' })
    await expect(journal.advance({
      expectedRevision: 1,
      phase: 'sandbox_created',
      evidenceSha256: evidence(2),
    })).rejects.toMatchObject({ code: 'PHASE_ORDER_INVALID' })
    await expect(journal.advance({
      expectedRevision: 1,
      phase: 'invocation_committed' as never,
      evidenceSha256: evidence(3),
    })).rejects.toMatchObject({ code: 'INVOCATION_API_REQUIRED' })
    await expect(journal.advance({
      expectedRevision: 1,
      phase: 'admitted',
      evidenceSha256: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'REQUEST_INVALID' })
  })

  it('binds operation, correlation, and provenance identity and rejects strict-schema violations', async () => {
    const path = await operationDirectory('prime-appcontainer-operation-identity-')
    const journal = await openJournal(path)
    await commitPhase(journal, 0)

    const changed = identity()
    changed.operationId = '22222222-2222-4222-8222-222222222222'
    await expect(openAppContainerProbeOperationJournal({
      hostPrivateOperationPath: path,
      identity: changed,
      ...windowsReferenceFenceOptions(),
    })).rejects.toMatchObject({ code: 'IDENTITY_COLLISION' })

    await expect(openAppContainerProbeOperationJournal({
      hostPrivateOperationPath: path,
      identity: { ...identity(), extra: true } as never,
      ...windowsReferenceFenceOptions(),
    })).rejects.toMatchObject({ code: 'IDENTITY_INVALID' })
    await expect(openAppContainerProbeOperationJournal({
      hostPrivateOperationPath: 'relative-operation',
      identity: identity(),
      ...windowsReferenceFenceOptions(),
    })).rejects.toMatchObject({ code: 'PATH_CUSTODY_INVALID' })
    for (const unsafePath of [
      join(tmpdir(), 'prime-operation-\u0130'),
      join(tmpdir(), 'prime-operation-\u212a'),
      `${path}\nforged-child`,
    ]) {
      await expect(openAppContainerProbeOperationJournal({
        hostPrivateOperationPath: unsafePath,
        identity: identity(),
        ...windowsReferenceFenceOptions(),
      })).rejects.toMatchObject({ code: 'PATH_CUSTODY_INVALID' })
    }
    await expect(journal.advance({
      expectedRevision: 1,
      phase: 'admitted',
      evidenceSha256: evidence(1),
      rawOutput: 'forbidden',
    } as never)).rejects.toMatchObject({ code: 'REQUEST_INVALID' })

    for (const mutate of [
      (value: ReturnType<typeof identity>) => { value.correlationId = '0'.repeat(32) },
      (value: ReturnType<typeof identity>) => { value.provenance.installedCandidate.sha256 = '0'.repeat(64) },
      (value: ReturnType<typeof identity>) => { value.provenance.installedCandidate.role = 'launch_target' as never },
      (value: ReturnType<typeof identity>) => { value.provenance.nativeSupervisor.role = 'launch_target' as never },
      (value: ReturnType<typeof identity>) => { value.provenance.nativeSupervisor.machine = 'arm64' as never },
      (value: ReturnType<typeof identity>) => { value.provenance.nativeSupervisor.bytes = 64 * 1024 * 1024 + 1 },
      (value: ReturnType<typeof identity>) => { value.provenance.probePayload.sha256 = value.provenance.installedCandidate.sha256 },
      (value: ReturnType<typeof identity>) => { value.provenance.nativeBuildManifest.bytes = 64 * 1024 + 1 },
      (value: ReturnType<typeof identity>) => { delete (value.provenance as any).nativeBuildManifest },
    ]) {
      const invalid = identity()
      mutate(invalid)
      const freshPath = await operationDirectory('prime-appcontainer-operation-bad-provenance-')
      await expect(openAppContainerProbeOperationJournal({
        hostPrivateOperationPath: freshPath,
        identity: invalid,
        ...windowsReferenceFenceOptions(),
      })).rejects.toMatchObject({ code: 'IDENTITY_INVALID' })
    }
  })

  it('detects noncanonical bytes, record tampering, hash-chain damage, and external hard links', async () => {
    const noncanonicalPath = await operationDirectory('prime-appcontainer-operation-noncanonical-')
    const noncanonical = await openJournal(noncanonicalPath)
    await commitPhase(noncanonical, 0)
    const firstPath = join(noncanonicalPath, '01-prepared.json')
    const firstRecord = JSON.parse(await readFile(firstPath, 'utf8'))
    await writeFile(firstPath, `${JSON.stringify(firstRecord, null, 2)}\n`, { mode: 0o600 })
    await expect(openJournal(noncanonicalPath)).rejects.toMatchObject({ code: 'JOURNAL_INVALID' })

    const tamperPath = await operationDirectory('prime-appcontainer-operation-tamper-')
    const tamper = await openJournal(tamperPath)
    await commitPhase(tamper, 0)
    const tamperFile = join(tamperPath, '01-prepared.json')
    const tampered = JSON.parse(await readFile(tamperFile, 'utf8'))
    tampered.evidenceSha256 = evidence(99)
    await writePrivateFile(tamperFile, `${canonicalJson(tampered)}\n`)
    await expect(openJournal(tamperPath)).rejects.toMatchObject({ code: 'JOURNAL_INVALID' })

    const chainPath = await operationDirectory('prime-appcontainer-operation-chain-')
    const chain = await openJournal(chainPath)
    await commitPhase(chain, 0)
    await commitPhase(chain, 1)
    const secondPath = join(chainPath, '02-admitted.json')
    const second = JSON.parse(await readFile(secondPath, 'utf8'))
    second.previousRecordSha256 = '0'.repeat(64)
    await writePrivateFile(secondPath, `${canonicalJson(second)}\n`)
    await expect(openJournal(chainPath)).rejects.toMatchObject({ code: 'JOURNAL_INVALID' })

    const currentDigestPath = await operationDirectory('prime-appcontainer-operation-current-digest-')
    const currentDigest = await openJournal(currentDigestPath)
    await commitPhase(currentDigest, 0)
    const currentDigestFile = join(currentDigestPath, '01-prepared.json')
    const currentDigestRecord = JSON.parse(await readFile(currentDigestFile, 'utf8'))
    currentDigestRecord.recordSha256 = '0'.repeat(64)
    await writePrivateFile(currentDigestFile, `${canonicalJson(currentDigestRecord)}\n`)
    await expect(openJournal(currentDigestPath)).rejects.toMatchObject({ code: 'JOURNAL_INVALID' })

    const linkedPath = await operationDirectory('prime-appcontainer-operation-link-')
    const outsidePath = await operationDirectory('prime-appcontainer-operation-link-outside-')
    const linked = await openJournal(linkedPath)
    await commitPhase(linked, 0)
    await link(join(linkedPath, '01-prepared.json'), join(outsidePath, 'outside-hardlink.json'))
    await expect(openJournal(linkedPath)).rejects.toMatchObject({ code: 'PATH_CUSTODY_INVALID' })
  })

  it('cleans only identity-owned dead-process create remnants and keeps final receipt publication external', async () => {
    const path = await operationDirectory('prime-appcontainer-operation-stale-temp-')
    const journal = await openJournal(path)
    await commitPhase(journal, 0)
    const operationSlug = identity().operationId.replaceAll('-', '')
    const stale = `.pcao-tmp-${operationSlug}-01-99999999-${'a'.repeat(16)}.tmp`
    await link(join(path, '01-prepared.json'), join(path, stale))
    expect((await readdir(path))).toContain(stale)
    expect((await openJournal(path).then((value) => value.readState())).revision).toBe(1)
    expect((await readdir(path))).not.toContain(stale)

    for (let index = 0; index < 17; index += 1) {
      const name = `.pcao-tmp-${operationSlug}-01-99999999-${index.toString(16).padStart(16, '0')}.tmp`
      await writePrivateFile(join(path, name), 'stale private create bytes\n')
    }
    expect((await openJournal(path).then((value) => value.readState())).revision).toBe(1)
    expect((await readdir(path)).filter((name) => name.startsWith('.pcao-tmp-'))).toEqual([])

    await writePrivateFile(join(path, 'receipt.json'), '{}\n')
    await expect(openJournal(path)).rejects.toMatchObject({ code: 'PATH_CUSTODY_INVALID' })
  })

  it('fails closed on oversized files, non-prefix records, and linked operation roots', async () => {
    const oversizedPath = await operationDirectory('prime-appcontainer-operation-oversized-')
    await writePrivateFile(
      join(oversizedPath, '01-prepared.json'),
      Buffer.alloc(APPCONTAINER_PROBE_OPERATION_MAX_RECORD_BYTES + 1, 0x20),
    )
    await expect(openJournal(oversizedPath)).rejects.toMatchObject({ code: 'PATH_CUSTODY_INVALID' })

    const gapPath = await operationDirectory('prime-appcontainer-operation-gap-')
    const sourcePath = await operationDirectory('prime-appcontainer-operation-gap-source-')
    const source = await openJournal(sourcePath)
    await commitPhase(source, 0)
    await commitPhase(source, 1)
    await link(join(sourcePath, '02-admitted.json'), join(gapPath, '02-admitted.json'))
    await expect(openJournal(gapPath)).rejects.toMatchObject({ code: 'JOURNAL_INVALID' })
  })

  it('rejects a deterministic parent-directory substitution after an opened record was read', async () => {
    const path = await operationDirectory('prime-appcontainer-operation-parent-swap-')
    const replacement = await operationDirectory('prime-appcontainer-operation-parent-replacement-')
    const journal = await openJournal(path)
    await commitPhase(journal, 0)
    await mkdir(join(replacement, 'nested'), { mode: 0o700 })
    const displaced = `${path}-displaced`
    temporaryRoots.push(displaced)
    let substituted = false
    try {
      await expect(openJournal(path, async (point, phase) => {
        if (!substituted && point === 'before_record_final_path_check' && phase === 'prepared') {
          substituted = true
          await rename(path, displaced)
          await symlink(replacement, path, process.platform === 'win32' ? 'junction' : 'dir')
        }
      })).rejects.toMatchObject({ code: 'PATH_CUSTODY_INVALID' })
    } finally {
      if (substituted) {
        await rm(path, { recursive: true, force: true })
        await rename(displaced, path)
      }
    }
  })

  it('never opens a substituted outside inode for write/sync while confirming an EEXIST winner', async () => {
    const path = await operationDirectory('prime-appcontainer-operation-confirm-swap-')
    const replacement = await operationDirectory('prime-appcontainer-operation-confirm-replacement-')
    const replacementRecord = join(replacement, '01-prepared.json')
    const outsideBytes = 'OUTSIDE FILE MUST REMAIN UNTOUCHED\n'
    await writePrivateFile(replacementRecord, outsideBytes)
    const displaced = `${path}-displaced`
    temporaryRoots.push(displaced)

    let releasePublisher!: () => void
    let markPublisherReady!: () => void
    const publisherReady = new Promise<void>((resolveReady) => { markPublisherReady = resolveReady })
    const publisherRelease = new Promise<void>((resolveRelease) => { releasePublisher = resolveRelease })
    let substituted = false
    const losing = await openJournal(path, async (point, phase) => {
      if (point === 'after_temporary_close' && phase === 'prepared') {
        markPublisherReady()
        await publisherRelease
      }
      if (!substituted && point === 'before_existing_sync_open' && phase === 'prepared') {
        substituted = true
        await rename(path, displaced)
        await symlink(replacement, path, process.platform === 'win32' ? 'junction' : 'dir')
      }
    })
    const losingCommit = commitPhase(losing, 0)
    await publisherReady
    const winner = await openJournal(path)
    await commitPhase(winner, 0)
    releasePublisher()
    try {
      await expect(losingCommit).rejects.toMatchObject({ code: 'COMMIT_UNCERTAIN' })
      expect(await readFile(replacementRecord, 'utf8')).toBe(outsideBytes)
    } finally {
      if (substituted) {
        await rm(path, { recursive: true, force: true })
        await rename(displaced, path)
      }
    }
    expect((await openJournal(path).then((value) => value.readState())).revision).toBe(1)
  })

  it.runIf(process.platform !== 'win32')('rejects a symlinked operation root before reading journal bytes', async () => {
    const target = await operationDirectory('prime-appcontainer-operation-root-target-')
    const parent = await operationDirectory('prime-appcontainer-operation-root-link-parent-')
    const linkedPath = join(parent, 'linked-operation')
    await symlink(target, linkedPath, 'dir')
    await expect(openJournal(linkedPath)).rejects.toMatchObject({ code: 'PATH_CUSTODY_INVALID' })
  })
})

async function operationDirectory(prefix: string) {
  const created = await mkdtemp(join(tmpdir(), prefix))
  const physical = await realpath(created)
  if (process.platform !== 'win32') await chmod(physical, 0o700)
  temporaryRoots.push(physical)
  return physical
}

function identity(): AppContainerProbeOperationIdentity & {
  correlationId: string
  operationId: string
  provenance: {
    installedCandidate: { role: 'installed_candidate_correlation'; sha256: string; bytes: number }
    nativeSupervisor: { role: 'native_supervisor'; sha256: string; bytes: number; machine: 'x64' }
    probePayload: { role: 'launch_target'; sha256: string; bytes: number; machine: 'x64' }
    nativeBuildManifest: { role: 'native_build_manifest'; sha256: string; bytes: number; machine: 'x64' }
  }
} {
  return {
    operationId: '11111111-1111-4111-8111-111111111111',
    correlationId: '1'.repeat(32),
    provenance: {
      installedCandidate: {
        role: 'installed_candidate_correlation',
        sha256: '2'.repeat(64),
        bytes: 4096,
      },
      nativeSupervisor: {
        role: 'native_supervisor',
        sha256: '3'.repeat(64),
        bytes: 6144,
        machine: 'x64',
      },
      probePayload: {
        role: 'launch_target',
        sha256: '4'.repeat(64),
        bytes: 8192,
        machine: 'x64',
      },
      nativeBuildManifest: {
        role: 'native_build_manifest',
        sha256: '5'.repeat(64),
        bytes: 1024,
        machine: 'x64',
      },
    },
  }
}

async function openJournal(
  path: string,
  faultInjector?: (
    point: 'after_temporary_open' | 'after_temporary_write' | 'after_temporary_sync' |
      'after_temporary_close' | 'after_publish' | 'after_directory_sync' | 'before_invocation_effect' |
      'before_record_final_path_check' | 'before_existing_sync_open' | 'before_existing_final_path_check',
    phase: AppContainerProbeOperationPhase,
  ) => void | Promise<void>,
  windowsReferenceFence: WindowsReferenceFence = () => undefined,
) {
  const options = {
    hostPrivateOperationPath: path,
    identity: identity(),
    faultInjector,
    ...windowsReferenceFenceOptions(windowsReferenceFence),
  }
  const journal = await openAppContainerProbeOperationJournal(options)
  if ((await journal.readState()).revision === 0) {
    await journal.reconfirmPreInvocation({ expectedRevision: 0, confirmationSha256: evidence(200) })
  }
  return journal
}

function windowsReferenceFenceOptions(
  fence: WindowsReferenceFence = () => undefined,
): Record<string, WindowsReferenceFence> {
  return process.platform === 'win32'
    ? { [TEST_ONLY_WINDOWS_REFERENCE_FENCE_KEY]: fence }
    : {}
}

async function seedPrefix(path: string, length: number) {
  const journal = await openJournal(path)
  for (let index = 0; index < length; index += 1) await commitPhase(journal, index)
}

async function authorizeRestartedPrefix(journal: AppContainerProbeOperationJournal, revision: number) {
  if (revision > 0 && revision < 4) {
    await journal.reconfirmPreInvocation({
      expectedRevision: revision,
      confirmationSha256: evidence(100 + revision),
    })
  }
}

async function commitPhase(
  journal: AppContainerProbeOperationJournal,
  index: number,
  invoke: () => unknown = () => undefined,
) {
  const phase = APPCONTAINER_PROBE_OPERATION_PHASES[index]!
  if (phase === 'invocation_committed') {
    return journal.commitInvocation({
      expectedRevision: index,
      evidenceSha256: evidence(index),
    }, invoke)
  }
  return journal.advance({
    expectedRevision: index,
    phase,
    evidenceSha256: evidence(index),
  })
}

function evidence(index: number, salt = '') {
  return createHash('sha256').update(`appcontainer-operation-evidence:${index}:${salt}`).digest('hex')
}

async function writePrivateFile(path: string, value: string | Buffer) {
  await writeFile(path, value, { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}
