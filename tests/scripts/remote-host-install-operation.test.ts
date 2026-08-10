import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as RemoteHostInstallOperationModule from '../../scripts/remote-host-install-operation.mjs'

import {
  REMOTE_HOST_INSTALL_OPERATION_CLAIM_KEYS,
  canonicalRemoteHostInstallOperationJson,
  createRemoteHostInstallOperation,
  recoverRemoteHostInstallOperation,
  reduceRemoteHostInstallOperation,
  validateRemoteHostInstallAdmission,
  validateRemoteHostInstallOperation,
} from '../../scripts/remote-host-install-operation.mjs'

describe('remote host fresh-install source operation contract', () => {
  it('creates one frozen, hash-linked, path-free planned record without effects', () => {
    const input = identity()
    const before = structuredClone(input)
    const planned = createRemoteHostInstallOperation(input)

    expect(input).toEqual(before)
    expect(planned).toMatchObject({
      schemaVersion: 1,
      kind: 'prime_continuim_remote_host_install_operation_v1',
      revision: 0,
      phase: 'planned',
      evidenceSha256: null,
      previousRecordSha256: null,
      installMode: 'fresh_install',
      destinationState: 'absent',
    })
    expect(planned.recordSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(planned)).toBe(true)
    expect(REMOTE_HOST_INSTALL_OPERATION_CLAIM_KEYS.every((key) => planned.claims[key] === false)).toBe(true)
    const serialized = canonicalRemoteHostInstallOperationJson(planned)
    expect(serialized).not.toMatch(/(?:password|privatekey|secret|token|\\|\/home\/|\/tmp\/)/iu)
  })

  it('strictly snapshots accessors and proxies and rejects unexpected secret/path fields', () => {
    const value = identity()
    expect(validateRemoteHostInstallAdmission(value)).toEqual(value)
    expect(() => validateRemoteHostInstallAdmission({ ...value, privateKey: 'secret' } as any)).toThrow(
      /admission_shape_invalid/,
    )
    expect(() => validateRemoteHostInstallAdmission({ ...value, installPath: '/srv/prime' } as any)).toThrow(
      /admission_shape_invalid/,
    )

    const accessor = { ...value } as any
    Object.defineProperty(accessor, 'packageId', {
      enumerable: true,
      get: () => { throw new Error('getter must not run') },
    })
    expect(() => validateRemoteHostInstallAdmission(accessor)).toThrow(/admission_shape_invalid/)

    let proxyTrapRan = false
    const proxy = new Proxy(value, {
      get() {
        proxyTrapRan = true
        throw new Error('proxy trap must not run')
      },
    })
    expect(() => validateRemoteHostInstallAdmission(proxy as any)).toThrow(/admission_shape_invalid/)
    expect(proxyTrapRan).toBe(false)
  })

  it.each([
    ['upgrade', { installMode: 'upgrade' }, 'install_mode_unsupported'],
    ['repair', { installMode: 'repair' }, 'install_mode_unsupported'],
    ['downgrade', { installMode: 'downgrade' }, 'install_mode_unsupported'],
    ['existing destination', { destinationState: 'present' }, 'destination_not_fresh'],
    ['unknown destination', { destinationState: 'unknown' }, 'destination_not_fresh'],
    ['Windows', { target: { platform: 'win32', arch: 'x64', libc: 'glibc' } }, 'target_platform_unsupported'],
    ['macOS', { target: { platform: 'darwin', arch: 'x64', libc: 'glibc' } }, 'target_platform_unsupported'],
    ['musl', { target: { platform: 'linux', arch: 'x64', libc: 'musl' } }, 'target_libc_unsupported'],
    ['ARM', { target: { platform: 'linux', arch: 'arm64', libc: 'glibc' } }, 'target_arch_unsupported'],
  ])('fixed-rejects %s admission', (_label, patch, code) => {
    expect(() => validateRemoteHostInstallAdmission({ ...identity(), ...patch } as any)).toThrow(code)
  })

  it('follows the exact happy-path phases with coherent revisions and predecessor hashes', () => {
    let record = createRemoteHostInstallOperation(identity())
    const phases = [
      'admitted',
      'dispatching',
      'remote_prepared',
      'package_published',
      'service_starting',
      'ready_verified',
      'settled',
    ] as const

    for (const [index, phase] of phases.entries()) {
      const previous = record
      const result = advance(record, phase, index + 1)
      record = result.record
      expect(record.revision).toBe(index + 1)
      expect(record.previousRecordSha256).toBe(previous.recordSha256)
      expect(record.phase).toBe(phase)
      expect(result.persistenceRequiredBeforeAction).toBe(true)
      expect(result.effectAuthority).toBeNull()
      expect(validateRemoteHostInstallOperation(record)).toEqual(record)
    }
    expect(record.phase).toBe('settled')
    expect(recoverRemoteHostInstallOperation(record)).toMatchObject({
      disposition: 'terminal',
      dispatchAllowed: false,
      replayAllowed: false,
    })
  })

  it('exports no dispatch advisory and never emits effect authority from any reducer state', () => {
    const planned = createRemoteHostInstallOperation(identity())
    const admitted = advance(planned, 'admitted', 1).record
    const first = advance(admitted, 'dispatching', 2)
    const second = advance(admitted, 'dispatching', 2)

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      persistenceRequiredBeforeAction: true,
      postPersistenceRequirement: 'future_unforgeable_persistence_capability_required',
      effectAuthority: null,
    })
    expect(JSON.stringify(first)).not.toMatch(/(?:advisory|authority":(?!null)|dispatch_fresh_install_once)/u)
    expect(Object.keys(RemoteHostInstallOperationModule).filter((key) => /(?:confirm|authoriz|advisory)/iu.test(key)))
      .toEqual([])
  })

  it('models ambiguity and restart as status-only reconciliation with no replay', () => {
    const planned = createRemoteHostInstallOperation(identity())
    const admitted = advance(planned, 'admitted', 1).record
    const dispatching = advance(admitted, 'dispatching', 2).record

    expect(recoverRemoteHostInstallOperation(dispatching)).toMatchObject({
      disposition: 'query_status_only',
      statusOnly: true,
      dispatchAllowed: false,
      replayAllowed: false,
    })
    const unknown = advance(dispatching, 'outcome_unknown', 3).record
    expect(recoverRemoteHostInstallOperation(unknown)).toMatchObject({
      disposition: 'query_status_only',
      statusOnly: true,
      dispatchAllowed: false,
      replayAllowed: false,
    })
    expect(() => advance(unknown, 'dispatching', 4)).toThrow(/transition_order_invalid/)

    const reconciled = advance(unknown, 'remote_prepared', 4).record
    expect(reconciled.revision).toBe(4)
    for (const phase of ['remote_prepared', 'package_published', 'service_starting', 'ready_verified'] as const) {
      let post = reconciled
      if (phase !== 'remote_prepared') {
        const order = ['package_published', 'service_starting', 'ready_verified'] as const
        for (const [index, next] of order.entries()) {
          post = advance(post, next, 10 + index).record
          if (next === phase) break
        }
      }
      expect(recoverRemoteHostInstallOperation(post)).toMatchObject({
        disposition: 'query_status_only',
        dispatchAllowed: false,
        replayAllowed: false,
      })
    }
  })

  it('supports only fixed pre-effect failure and post-effect blocking terminals', () => {
    const planned = createRemoteHostInstallOperation(identity())
    const preFailed = advance(planned, 'failed_pre_effect', 1).record
    expect(preFailed.phase).toBe('failed_pre_effect')
    expect(recoverRemoteHostInstallOperation(preFailed).disposition).toBe('terminal')

    const admitted = advance(planned, 'admitted', 2).record
    const dispatching = advance(admitted, 'dispatching', 3).record
    const blocked = advance(dispatching, 'blocked_post_effect', 4).record
    expect(blocked.phase).toBe('blocked_post_effect')
    expect(recoverRemoteHostInstallOperation(blocked)).toMatchObject({
      disposition: 'terminal',
      dispatchAllowed: false,
      replayAllowed: false,
    })
    expect(() => advance(dispatching, 'failed_pre_effect', 5)).toThrow(/transition_order_invalid/)
    expect(() => advance(admitted, 'blocked_post_effect', 6)).toThrow(/transition_order_invalid/)
  })

  it('rejects transition CAS drift, identity drift, and phase/revision drift', () => {
    const planned = createRemoteHostInstallOperation(identity())
    expect(() => reduceRemoteHostInstallOperation(planned, {
      expectedRevision: 1,
      expectedRecordSha256: planned.recordSha256,
      phase: 'admitted',
      evidenceSha256: sha(1),
    })).toThrow(/transition_cas_conflict/)
    expect(() => reduceRemoteHostInstallOperation(planned, {
      expectedRevision: 0,
      expectedRecordSha256: sha(9),
      phase: 'admitted',
      evidenceSha256: sha(1),
    })).toThrow(/transition_identity_conflict/)

    expect(() => validateRemoteHostInstallOperation({ ...planned, packageId: 'other-package' } as any)).toThrow(
      /operation_record_digest_mismatch/,
    )
    expect(() => validateRemoteHostInstallOperation({ ...planned, revision: 2 } as any)).toThrow(
      /operation_phase_revision_mismatch/,
    )
    expect(() => validateRemoteHostInstallOperation({
      ...planned,
      claims: { ...planned.claims, installerImplemented: true },
    } as any)).toThrow(/claim_overstated/)

  })
})

function identity(): any {
  return {
    operationId: '12345678-1234-4234-9234-123456789abc',
    packageId: 'prime-remote-kit-0001',
    manifestSha256: sha(7),
    trustAnchorId: `ed25519-spki-sha256-${'a'.repeat(64)}`,
    signerKeyId: 'test-only-signer-01',
    targetAuthoritySha256: sha(5),
    target: { platform: 'linux', arch: 'x64', libc: 'glibc' },
    installMode: 'fresh_install',
    destinationState: 'absent',
  }
}

function advance(record: any, phase: string, evidence: number): any {
  return reduceRemoteHostInstallOperation(record, {
    expectedRevision: record.revision,
    expectedRecordSha256: record.recordSha256,
    phase,
    evidenceSha256: sha(evidence),
  } as any)
}

function sha(value: number): string {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}
