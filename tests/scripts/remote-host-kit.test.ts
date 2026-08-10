import { execFile } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  REMOTE_HOST_KIT_CLAIM_KEYS,
  REMOTE_HOST_KIT_MAX_MANIFEST_BYTES,
  REMOTE_HOST_KIT_RUNTIME_IDENTITY,
  canonicalRemoteHostKitJson,
  createRemoteHostKitSignatureEnvelope,
  createRemoteHostKitSignaturePreimage,
  createRemoteHostKitTrustAnchorId,
  serializeRemoteHostKitManifest,
  serializeRemoteHostKitSignatureEnvelope,
  validateRemoteHostKitManifest,
  verifyRemoteHostKitArtifactBytes,
  verifyRemoteHostKitBytes,
  verifyRemoteHostKitEnvelopeBytes,
} from '../../scripts/remote-host-kit-lib.mjs'
import { assertRemoteHostInstallKitCorrelation } from '../../scripts/remote-host-install-operation.mjs'
// @ts-expect-error The bounded static CLI intentionally has no public declaration surface.
import { verifyRemoteHostKitFiles } from '../../scripts/verify-remote-host-kit.mjs'

const execFileAsync = promisify(execFile)
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('remote-host-kit/v1 signed static contract', () => {
  it('accepts only the exact path-free shape and snapshots hostile inputs', () => {
    const keys = generateKeyPairSync('ed25519')
    const value = manifest(keys.publicKey)
    const validated = validateRemoteHostKitManifest(value)

    expect(validated).toEqual(value)
    expect(Object.isFrozen(validated)).toBe(true)
    expect(Object.isFrozen(validated.runtimeIdentity)).toBe(true)
    expect(validated.runtimeIdentity).toEqual(REMOTE_HOST_KIT_RUNTIME_IDENTITY)
    expect(validated.installAction).toBe('fresh_install')
    expect(REMOTE_HOST_KIT_CLAIM_KEYS.every((key) => validated.claims[key] === false)).toBe(true)

    expect(() => validateRemoteHostKitManifest({ ...value, extra: false } as any)).toThrow(/manifest_shape_invalid/)
    expect(() => validateRemoteHostKitManifest({ ...value, packageId: '/tmp/remote-kit' } as any)).toThrow(
      /package_id_invalid/,
    )
    expect(() => validateRemoteHostKitManifest({
      ...value,
      artifacts: { ...value.artifacts, hostd: { ...value.artifacts.hostd, path: '/srv/hostd' } },
    } as any)).toThrow(/artifact_shape_invalid/)

    const accessor = structuredClone(value) as any
    Object.defineProperty(accessor, 'packageId', {
      enumerable: true,
      get: () => { throw new Error('getter must not run') },
    })
    expect(() => validateRemoteHostKitManifest(accessor)).toThrow(/manifest_shape_invalid/)

    let proxyTrapRan = false
    const proxy = new Proxy(value, {
      get() {
        proxyTrapRan = true
        throw new Error('proxy trap must not run')
      },
    })
    expect(() => validateRemoteHostKitManifest(proxy as any)).toThrow(/manifest_shape_invalid/)
    expect(() => canonicalRemoteHostKitJson(proxy)).toThrow(/canonical_value_invalid/)
    expect(proxyTrapRan).toBe(false)
  })

  it.each([
    ['platform', { target: { platform: 'win32', arch: 'x64', libc: 'glibc' } }, 'target_platform_unsupported'],
    ['macOS', { target: { platform: 'darwin', arch: 'x64', libc: 'glibc' } }, 'target_platform_unsupported'],
    ['ARM', { target: { platform: 'linux', arch: 'arm64', libc: 'glibc' } }, 'target_arch_unsupported'],
    ['musl', { target: { platform: 'linux', arch: 'x64', libc: 'musl' } }, 'target_libc_unsupported'],
    ['upgrade', { installAction: 'upgrade' }, 'install_action_unsupported'],
    ['repair', { installAction: 'repair' }, 'install_action_unsupported'],
    ['downgrade', { installAction: 'downgrade' }, 'install_action_unsupported'],
  ])('fixed-rejects the unsupported %s target/action', (_label, patch, code) => {
    const keys = generateKeyPairSync('ed25519')
    expect(() => validateRemoteHostKitManifest({ ...manifest(keys.publicKey), ...patch } as any)).toThrow(code)
  })

  it('pins the exact Electron RunAsNode tuple and four distinct bounded artifact roles', () => {
    const keys = generateKeyPairSync('ed25519')
    const value = manifest(keys.publicKey)
    for (const field of ['electronVersion', 'nodeVersion', 'modulesAbi', 'napiVersion', 'kind', 'runAsNode'] as const) {
      const runtimeIdentity = { ...value.runtimeIdentity, [field]: field === 'runAsNode' ? false : 'drifted' }
      expect(() => validateRemoteHostKitManifest({ ...value, runtimeIdentity } as any)).toThrow(/runtime_identity_invalid/)
    }
    expect(() => validateRemoteHostKitManifest({
      ...value,
      artifacts: { ...value.artifacts, launcher: { ...value.artifacts.launcher, role: 'runtime' } },
    } as any)).toThrow(/artifact_role_mismatch/)
    expect(() => validateRemoteHostKitManifest({
      ...value,
      artifacts: {
        ...value.artifacts,
        launcher: { ...value.artifacts.launcher, sha256: value.artifacts.runtime.sha256 },
      },
    } as any)).toThrow(/artifact_digests_not_distinct/)

    expect(() => verifyRemoteHostKitArtifactBytes(value, {
      ...artifactBytes(),
      service: new Uint8Array((1024 * 1024) + 1),
    })).toThrow(/artifact_size_invalid/)

    let hostileGetterRan = false
    class HostileUint8Array extends Uint8Array {
      override get byteLength(): number {
        hostileGetterRan = true
        throw new Error('overridable byteLength must not run')
      }

      override get length(): number {
        hostileGetterRan = true
        throw new Error('overridable length must not run')
      }
    }
    const safeServiceSnapshot = new HostileUint8Array(artifactBytes().service)
    expect(verifyRemoteHostKitArtifactBytes(value, {
      ...artifactBytes(),
      service: safeServiceSnapshot,
    }).artifactBytesCorrelated).toBe(true)
    expect(hostileGetterRan).toBe(false)
  })

  it('verifies a domain-separated detached Ed25519 signature against independently derived trust', () => {
    const keys = generateKeyPairSync('ed25519')
    const value = manifest(keys.publicKey)
    const signature = sign(null, createRemoteHostKitSignaturePreimage(value), keys.privateKey)
    const trust = {
      trustAnchorId: value.trustAnchorId,
      signerKeyId: value.signerKeyId,
      publicKey: keys.publicKey,
    }
    const attackerKeys = generateKeyPairSync('ed25519')
    let hostileGetterRan = false
    class HostileUint8Array extends Uint8Array {
      override get byteLength(): number {
        hostileGetterRan = true
        trust.publicKey = attackerKeys.publicKey
        throw new Error('hostile byteLength getter must not run')
      }

      override get length(): number {
        hostileGetterRan = true
        trust.signerKeyId = 'test-only-attacker-signer'
        throw new Error('hostile length getter must not run')
      }
    }
    const envelope = createRemoteHostKitSignatureEnvelope(
      value,
      new HostileUint8Array(signature),
    )
    const manifestBytes = serializeRemoteHostKitManifest(value)
    const envelopeBytes = serializeRemoteHostKitSignatureEnvelope(envelope)

    expect(envelope.signature).toMatchObject({ algorithm: 'Ed25519', encoding: 'base64url' })
    expect(envelope.signature.value).toHaveLength(86)
    expect(envelope.signature.value).not.toContain('=')
    expect(envelope).not.toHaveProperty('manifest')
    expect(manifestBytes.at(-1)).toBe(0x0a)
    expect(envelopeBytes.at(-1)).toBe(0x0a)
    expect(verifyRemoteHostKitEnvelopeBytes(
      new HostileUint8Array(manifestBytes),
      new HostileUint8Array(envelopeBytes),
      trust,
    )).toMatchObject({
      packageId: value.packageId,
      trustAnchorId: createRemoteHostKitTrustAnchorId(keys.publicKey),
      verification: {
        canonicalBytes: true,
        strictSchema: true,
        ed25519SignatureVerified: true,
        independentTrustCorrelation: true,
        artifactBytesCorrelated: false,
      },
    })
    expect(hostileGetterRan).toBe(false)
    expect(trust.publicKey).toBe(keys.publicKey)
    expect(trust.signerKeyId).toBe(value.signerKeyId)

    const combined = verifyRemoteHostKitBytes(manifestBytes, envelopeBytes, artifactBytes(), trust)
    expect(combined.verification.artifactBytesCorrelated).toBe(true)
    expect(Object.isFrozen(combined)).toBe(true)
    const installIdentity = operationIdentityFromKit(combined)
    expect(assertRemoteHostInstallKitCorrelation(installIdentity, kitCorrelationFrom(combined))).toMatchObject({
      operationId: installIdentity.operationId,
      structuralCorrelation: true,
      verificationClaimed: false,
      effectAuthority: null,
    })
    expect(() => assertRemoteHostInstallKitCorrelation(
      { ...installIdentity, packageId: 'cross-fed-package' },
      kitCorrelationFrom(combined),
    )).toThrow(/kit_correlation_identity_mismatch/)
    expect(() => assertRemoteHostInstallKitCorrelation(
      installIdentity,
      { ...kitCorrelationFrom(combined), artifactBytesCorrelated: false },
    )).toThrow(/kit_artifact_correlation_required/)
  })

  it('rejects KeyObject lookalikes before invoking spoofed crypto methods', () => {
    let exportCalled = false
    const fakeKey = {
      type: 'public',
      asymmetricKeyType: 'ed25519',
      export() {
        exportCalled = true
        throw new Error('spoofed export must not run')
      },
    }
    expect(() => createRemoteHostKitTrustAnchorId(fakeKey as any)).toThrow(/trust_public_key_invalid/)
    expect(exportCalled).toBe(false)
  })

  it('rejects oversized bytes and symbol-bearing exact-key inputs with fixed contract errors', async () => {
    const keys = generateKeyPairSync('ed25519')
    const value = manifest(keys.publicKey)
    const manifestBytes = serializeRemoteHostKitManifest(value)
    const envelopeBytes = serializeRemoteHostKitSignatureEnvelope(
      createRemoteHostKitSignatureEnvelope(
        value,
        sign(null, createRemoteHostKitSignaturePreimage(value), keys.privateKey),
      ),
    )
    const trustWithSymbol: any = {
      trustAnchorId: value.trustAnchorId,
      signerKeyId: value.signerKeyId,
      publicKey: keys.publicKey,
      [Symbol('unexpected')]: false,
    }
    expect(() => verifyRemoteHostKitEnvelopeBytes(manifestBytes, envelopeBytes, trustWithSymbol)).toThrow(
      /trust_configuration_invalid/,
    )
    expect(() => verifyRemoteHostKitEnvelopeBytes(
      Buffer.alloc(REMOTE_HOST_KIT_MAX_MANIFEST_BYTES + 1),
      envelopeBytes,
      { trustAnchorId: value.trustAnchorId, signerKeyId: value.signerKeyId, publicKey: keys.publicKey },
    )).toThrow(/manifest_oversize/)

    const artifactBytesWithSymbol: any = { ...artifactBytes(), [Symbol('unexpected')]: false }
    expect(() => verifyRemoteHostKitArtifactBytes(value, artifactBytesWithSymbol)).toThrow(
      /artifact_bytes_shape_invalid/,
    )
    const optionsWithSymbol: any = {
      manifestPath: 'manifest',
      envelopePath: 'envelope',
      hostdPath: 'hostd',
      runtimePath: 'runtime',
      launcherPath: 'launcher',
      servicePath: 'service',
      publicKeySpkiPath: 'key',
      trustAnchorId: value.trustAnchorId,
      signerKeyId: value.signerKeyId,
      [Symbol('unexpected')]: false,
    }
    await expect(verifyRemoteHostKitFiles(optionsWithSymbol)).rejects.toThrow(/options_invalid/)
  })

  it('rejects trust, package, signer, signature, and artifact cross-feeds', () => {
    const first = generateKeyPairSync('ed25519')
    const second = generateKeyPairSync('ed25519')
    const firstManifest = manifest(first.publicKey)
    const firstManifestBytes = serializeRemoteHostKitManifest(firstManifest)
    const firstSignature = sign(null, createRemoteHostKitSignaturePreimage(firstManifest), first.privateKey)
    const firstBytes = serializeRemoteHostKitSignatureEnvelope(
      createRemoteHostKitSignatureEnvelope(firstManifest, firstSignature),
    )

    expect(() => verifyRemoteHostKitEnvelopeBytes(firstManifestBytes, firstBytes, {
      trustAnchorId: createRemoteHostKitTrustAnchorId(second.publicKey),
      signerKeyId: firstManifest.signerKeyId,
      publicKey: second.publicKey,
    })).toThrow(/trust_anchor_mismatch/)
    expect(() => verifyRemoteHostKitEnvelopeBytes(firstManifestBytes, firstBytes, {
      trustAnchorId: firstManifest.trustAnchorId,
      signerKeyId: 'test-only-signer-02',
      publicKey: first.publicKey,
    })).toThrow(/signer_key_mismatch/)
    expect(() => verifyRemoteHostKitEnvelopeBytes(firstManifestBytes, firstBytes, {
      trustAnchorId: `ed25519-spki-sha256-${'f'.repeat(64)}`,
      signerKeyId: firstManifest.signerKeyId,
      publicKey: first.publicKey,
    })).toThrow(/trust_anchor_key_mismatch|trust_anchor_mismatch/)

    const fedManifest = { ...firstManifest, packageId: 'prime-remote-kit-fed' }
    const fedManifestBytes = serializeRemoteHostKitManifest(fedManifest)
    const fedBytes = serializeRemoteHostKitSignatureEnvelope(
      createRemoteHostKitSignatureEnvelope(fedManifest, firstSignature),
    )
    expect(() => verifyRemoteHostKitEnvelopeBytes(fedManifestBytes, fedBytes, {
      trustAnchorId: firstManifest.trustAnchorId,
      signerKeyId: firstManifest.signerKeyId,
      publicKey: first.publicKey,
    })).toThrow(/signature_invalid/)
    expect(() => verifyRemoteHostKitEnvelopeBytes(fedManifestBytes, firstBytes, {
      trustAnchorId: firstManifest.trustAnchorId,
      signerKeyId: firstManifest.signerKeyId,
      publicKey: first.publicKey,
    })).toThrow(/manifest_digest_mismatch/)

    const swapped = artifactBytes()
    ;[swapped.hostd, swapped.runtime] = [swapped.runtime, swapped.hostd]
    expect(() => verifyRemoteHostKitArtifactBytes(firstManifest, swapped)).toThrow(/artifact_digest_mismatch/)
  })

  it('rejects noncanonical, duplicate-key, malformed signature, and overstated claim bytes', () => {
    const keys = generateKeyPairSync('ed25519')
    const value = manifest(keys.publicKey)
    const signature = sign(null, createRemoteHostKitSignaturePreimage(value), keys.privateKey)
    const envelope = createRemoteHostKitSignatureEnvelope(value, signature)
    const manifestBytes = serializeRemoteHostKitManifest(value)
    const envelopeBytes = serializeRemoteHostKitSignatureEnvelope(envelope)
    const trust = { trustAnchorId: value.trustAnchorId, signerKeyId: value.signerKeyId, publicKey: keys.publicKey }

    expect(() => verifyRemoteHostKitEnvelopeBytes(
      manifestBytes,
      Buffer.from(` ${envelopeBytes.toString('utf8')}`),
      trust,
    )).toThrow(
      /envelope_not_canonical/,
    )
    expect(() => verifyRemoteHostKitEnvelopeBytes(
      manifestBytes,
      envelopeBytes.subarray(0, -1),
      trust,
    )).toThrow(/envelope_framing_invalid/)
    const duplicateEnvelope = Buffer.from(
      `{"schema":"remote-host-kit-signature-envelope/v1",${envelopeBytes.toString('utf8').slice(1)}`,
      'utf8',
    )
    expect(() => verifyRemoteHostKitEnvelopeBytes(manifestBytes, duplicateEnvelope, trust)).toThrow(
      /envelope_not_canonical/,
    )
    expect(() => verifyRemoteHostKitEnvelopeBytes(
      Buffer.from(` ${manifestBytes.toString('utf8')}`, 'utf8'),
      envelopeBytes,
      trust,
    )).toThrow(/manifest_not_canonical/)
    const duplicateManifest = Buffer.from(
      `{"schema":"remote-host-kit/v1",${manifestBytes.toString('utf8').slice(1)}`,
      'utf8',
    )
    expect(() => verifyRemoteHostKitEnvelopeBytes(duplicateManifest, envelopeBytes, trust)).toThrow(
      /manifest_not_canonical/,
    )
    expect(() => createRemoteHostKitSignatureEnvelope(value, signature.subarray(0, 63))).toThrow(
      /signature_length_invalid/,
    )
    expect(() => validateRemoteHostKitManifest({
      ...value,
      claims: { ...value.claims, installImplemented: true },
    } as any)).toThrow(/claim_overstated/)
  })

  it('runs only a read-only static CLI and remains unreachable from product and build entrypoints', async () => {
    const keys = generateKeyPairSync('ed25519')
    const value = manifest(keys.publicKey)
    const manifestBytes = serializeRemoteHostKitManifest(value)
    const envelopeBytes = serializeRemoteHostKitSignatureEnvelope(
      createRemoteHostKitSignatureEnvelope(
        value,
        sign(null, createRemoteHostKitSignaturePreimage(value), keys.privateKey),
      ),
    )
    const root = await mkdtemp(join(tmpdir(), 'prime-remote-host-kit-test-'))
    temporaryRoots.push(root)
    const paths = {
      manifestPath: join(root, 'manifest.json'),
      envelopePath: join(root, 'envelope.json'),
      hostdPath: join(root, 'hostd.bin'),
      runtimePath: join(root, 'runtime.bin'),
      launcherPath: join(root, 'launcher.bin'),
      servicePath: join(root, 'service.bin'),
      publicKeySpkiPath: join(root, 'public-key.der'),
    }
    const artifacts = artifactBytes()
    await Promise.all([
      writeFile(paths.manifestPath, manifestBytes, { flag: 'wx' }),
      writeFile(paths.envelopePath, envelopeBytes, { flag: 'wx' }),
      writeFile(paths.hostdPath, artifacts.hostd, { flag: 'wx' }),
      writeFile(paths.runtimePath, artifacts.runtime, { flag: 'wx' }),
      writeFile(paths.launcherPath, artifacts.launcher, { flag: 'wx' }),
      writeFile(paths.servicePath, artifacts.service, { flag: 'wx' }),
      writeFile(paths.publicKeySpkiPath, keys.publicKey.export({ format: 'der', type: 'spki' }), { flag: 'wx' }),
    ])

    const verified = await verifyRemoteHostKitFiles({
      ...paths,
      trustAnchorId: value.trustAnchorId,
      signerKeyId: value.signerKeyId,
    })
    expect(verified.verification.artifactBytesCorrelated).toBe(true)

    const script = resolve('scripts/verify-remote-host-kit.mjs')
    const args = [
      '--manifest', paths.manifestPath,
      '--envelope', paths.envelopePath,
      '--hostd', paths.hostdPath,
      '--runtime', paths.runtimePath,
      '--launcher', paths.launcherPath,
      '--service', paths.servicePath,
      '--public-key-spki', paths.publicKeySpkiPath,
      '--trust-anchor-id', value.trustAnchorId,
      '--signer-key-id', value.signerKeyId,
    ]
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args])
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toMatchObject({
      kind: 'prime_continuim_remote_host_kit_static_verifier_v1',
      packageId: value.packageId,
      verification: { ed25519SignatureVerified: true, artifactBytesCorrelated: true },
    })
    for (const path of Object.values(paths)) expect(stdout).not.toContain(path)
    await expect(execFileAsync(process.execPath, [script, '--install', paths.envelopePath])).rejects.toMatchObject({
      code: 1,
      stderr: 'Prime Continuim remote host kit static verification failed.\n',
    })
    await expect(execFileAsync(process.execPath, [script, ...args.slice(2)])).rejects.toMatchObject({
      code: 1,
      stderr: 'Prime Continuim remote host kit static verification failed.\n',
    })

    const ordinarySources = await Promise.all([
      readFile(resolve('package.json'), 'utf8'),
      readFile(resolve('scripts/run-workflow.mjs'), 'utf8'),
      readFile(resolve('src/main/index.ts'), 'utf8'),
      readFile(resolve('src/preload/index.ts'), 'utf8'),
    ])
    for (const source of ordinarySources) {
      expect(source).not.toContain('verify-remote-host-kit')
      expect(source).not.toContain('remote-host-install-operation')
      expect(source).not.toContain('remote-host-kit-lib')
    }
  })
})

function artifactBytes() {
  return {
    hostd: Buffer.from('hostd-v1', 'utf8'),
    runtime: Buffer.from('runtime1', 'utf8'),
    launcher: Buffer.from('launcher', 'utf8'),
    service: Buffer.from('service1', 'utf8'),
  }
}

function manifest(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): any {
  const bytes = artifactBytes()
  return {
    schema: 'remote-host-kit/v1',
    packageId: 'prime-remote-kit-0001',
    hostdVersion: '0.1.0',
    protocolVersion: 1,
    target: { platform: 'linux', arch: 'x64', libc: 'glibc' },
    runtimeIdentity: { ...REMOTE_HOST_KIT_RUNTIME_IDENTITY },
    artifacts: {
      hostd: artifact('hostd', bytes.hostd),
      runtime: artifact('runtime', bytes.runtime),
      launcher: artifact('launcher', bytes.launcher),
      service: artifact('service', bytes.service),
    },
    installAction: 'fresh_install',
    trustAnchorId: createRemoteHostKitTrustAnchorId(publicKey),
    signerKeyId: 'test-only-signer-01',
    claims: Object.fromEntries(REMOTE_HOST_KIT_CLAIM_KEYS.map((key) => [key, false])),
  }
}

function artifact(role: string, bytes: Buffer) {
  return {
    role,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
  }
}

function operationIdentityFromKit(kit: any): any {
  return {
    operationId: '12345678-1234-4234-9234-123456789abc',
    packageId: kit.packageId,
    manifestSha256: kit.manifestSha256,
    trustAnchorId: kit.trustAnchorId,
    signerKeyId: kit.signerKeyId,
    targetAuthoritySha256: createHash('sha256').update('test-only-target-authority').digest('hex'),
    target: { ...kit.manifest.target },
    installMode: kit.manifest.installAction,
    destinationState: 'absent',
  }
}

function kitCorrelationFrom(kit: any): any {
  return {
    packageId: kit.packageId,
    manifestSha256: kit.manifestSha256,
    trustAnchorId: kit.trustAnchorId,
    signerKeyId: kit.signerKeyId,
    target: { ...kit.manifest.target },
    installAction: kit.manifest.installAction,
    artifactBytesCorrelated: kit.verification.artifactBytesCorrelated,
  }
}
