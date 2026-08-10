import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as PayloadContract from '../../scripts/remote-host-payload-contract.mjs'
import {
  REMOTE_HOST_KIT_CLAIM_KEYS,
  REMOTE_HOST_KIT_RUNTIME_IDENTITY,
  createRemoteHostKitSignaturePreimage,
  createRemoteHostKitTrustAnchorId,
  parseRemoteHostKitManifestBytes,
} from '../../scripts/remote-host-kit-lib.mjs'

const {
  REMOTE_HOST_ELECTRON_PROVENANCE,
  REMOTE_HOST_PAYLOAD_CLAIM_KEYS,
  REMOTE_HOST_PAYLOAD_DESTINATIONS,
  REMOTE_HOST_PAYLOAD_PRIME_AGENT,
  RemoteHostPayloadContractError,
  createRemoteHostPayloadInputs,
  createRemoteHostPayloadKitReference,
  createRemoteHostPayloadLayout,
  getRemoteHostPayloadTemplateBytes,
  parseRemoteHostPayloadInputsBytes,
  parseRemoteHostPayloadLayoutBytes,
  serializeRemoteHostPayloadInputs,
  serializeRemoteHostPayloadLayout,
  validateRemoteHostPayloadInputs,
  validateRemoteHostPayloadLayout,
} = PayloadContract

describe('remote host payload pure source contract', () => {
  it('pins the exact package, host, runtime, target, destinations, false claims, and null authority', () => {
    const inputs = createRemoteHostPayloadInputs()

    expect(inputs).toEqual({
      schema: 'remote-host-payload-inputs/v1',
      packageId: 'prime-continuim.remote-host',
      hostdVersion: '0.1.0',
      protocolVersion: 1,
      target: { platform: 'linux', arch: 'x64', libc: 'glibc' },
      runtimeIdentity: REMOTE_HOST_KIT_RUNTIME_IDENTITY,
      primeAgent: REMOTE_HOST_PAYLOAD_PRIME_AGENT,
      electron: REMOTE_HOST_ELECTRON_PROVENANCE,
      destinations: REMOTE_HOST_PAYLOAD_DESTINATIONS,
      claims: Object.fromEntries(REMOTE_HOST_PAYLOAD_CLAIM_KEYS.map((key) => [key, false])),
      assemblyAuthority: null,
    })
    expect(Object.isFrozen(inputs)).toBe(true)
    expect(Object.isFrozen(inputs.electron.archive)).toBe(true)
    expect(Object.values(inputs.claims).every((value) => value === false)).toBe(true)
    expect(inputs.destinations).toEqual({
      hostd: { role: 'hostd', path: 'hostd/hostd.cjs', mode: '0644' },
      runtime: { role: 'runtime', path: 'runtime/runtime.zip', mode: '0644' },
      launcher: { role: 'launcher', path: 'launcher/prime-continuim-hostd-service', mode: '0755' },
      service: { role: 'service', path: 'service/prime-continuim-hostd.service', mode: '0644' },
    })
  })

  it('keeps the checked-in Electron release pin canonical and exact by value', async () => {
    const path = resolve('scripts/remote-host-payload/electron-v43.3.0-linux-x64.provenance.json')
    const bytes = await readFile(path)
    const value = JSON.parse(bytes.toString('utf8'))

    expect(bytes.at(-1)).toBe(0x0a)
    expect(bytes.includes(0x0d)).toBe(false)
    expect(value).toEqual(REMOTE_HOST_ELECTRON_PROVENANCE)
    expect(value.archive).toEqual({
      name: 'electron-v43.3.0-linux-x64.zip',
      url: 'https://github.com/electron/electron/releases/download/v43.3.0/electron-v43.3.0-linux-x64.zip',
      bytes: 125_603_646,
      sha256: 'f4987e9f045e46b117f0805d6ba4dc524e2abb2c2e33660f175bb39564bd3dae',
    })
    expect(value.shasums).toEqual({
      name: 'SHASUMS256.txt',
      url: 'https://github.com/electron/electron/releases/download/v43.3.0/SHASUMS256.txt',
      bytes: 7_610,
      sha256: '43f854bd8a201a9abdf4bace97681144ec7230893462c6db7681a0f6db8cb7f9',
      archiveLine: 'f4987e9f045e46b117f0805d6ba4dc524e2abb2c2e33660f175bb39564bd3dae *electron-v43.3.0-linux-x64.zip',
    })
    expect(bytes.toString('utf8')).toBe(`${canonicalJson(REMOTE_HOST_ELECTRON_PROVENANCE)}\n`)
  })

  it('pins the checked-in Prime Agent policy, sources, lock, hostd, and daemon protocol constants', async () => {
    const [policyBytes, sourcesBytes, lockBytes, hostdPaths] = await Promise.all([
      readFile(resolve('runtime/prime-agent/runtime-policy.json')),
      readFile(resolve('runtime/prime-agent/sources.json')),
      readFile(resolve('runtime/prime-agent/package-lock.json')),
      readFile(resolve('src/hostd/paths.ts'), 'utf8'),
    ])
    const policy = JSON.parse(policyBytes.toString('utf8'))
    const sources = JSON.parse(sourcesBytes.toString('utf8'))

    expect(sha256(policyBytes)).toBe(REMOTE_HOST_PAYLOAD_PRIME_AGENT.runtimePolicySha256)
    expect(sha256(sourcesBytes)).toBe(REMOTE_HOST_PAYLOAD_PRIME_AGENT.sourcesSha256)
    expect(sha256(lockBytes)).toBe(REMOTE_HOST_PAYLOAD_PRIME_AGENT.packageLockSha256)
    expect(policy).toMatchObject({
      schemaVersion: REMOTE_HOST_PAYLOAD_PRIME_AGENT.runtimePolicySchemaVersion,
      releaseVersion: REMOTE_HOST_PAYLOAD_PRIME_AGENT.releaseVersion,
      runtimeBuildId: REMOTE_HOST_PAYLOAD_PRIME_AGENT.runtimeBuildId,
      daemon: {
        protocolVersion: REMOTE_HOST_PAYLOAD_PRIME_AGENT.daemonProtocolVersion,
        schemaRevision: REMOTE_HOST_PAYLOAD_PRIME_AGENT.daemonSchemaRevision,
        schemaId: REMOTE_HOST_PAYLOAD_PRIME_AGENT.daemonSchemaId,
      },
    })
    expect(sources.release).toMatchObject({
      version: REMOTE_HOST_PAYLOAD_PRIME_AGENT.releaseVersion,
      commit: REMOTE_HOST_PAYLOAD_PRIME_AGENT.releaseCommit,
    })
    expect(hostdPaths).toContain('export const HOSTD_VERSION = "0.1.0";')
  })

  it('rejects shape tricks, proxies, accessors, symbols, non-NFC strings, and unsafe numbers without invoking caller code', () => {
    const base = clone(createRemoteHostPayloadInputs())
    let proxyTrapRan = false
    const proxy = new Proxy(base, {
      getPrototypeOf() {
        proxyTrapRan = true
        throw new Error('caller code must not run')
      },
    })
    expectContractCode(() => validateRemoteHostPayloadInputs(proxy as any), 'payload_inputs_shape_invalid')
    expect(proxyTrapRan).toBe(false)

    let accessorRan = false
    const accessor = clone(base)
    Object.defineProperty(accessor, 'packageId', {
      enumerable: true,
      get() {
        accessorRan = true
        return 'prime-continuim.remote-host'
      },
    })
    expectContractCode(() => validateRemoteHostPayloadInputs(accessor as any), 'payload_inputs_shape_invalid')
    expect(accessorRan).toBe(false)

    const symbol = clone(base) as any
    symbol[Symbol('unexpected')] = true
    expectContractCode(() => validateRemoteHostPayloadInputs(symbol), 'payload_inputs_shape_invalid')

    for (const key of ['target', 'runtimeIdentity'] as const) {
      const protoKey = clone(base) as any
      Object.defineProperty(protoKey[key], '__proto__', {
        value: { injected: true },
        enumerable: true,
        configurable: true,
        writable: true,
      })
      expectContractCode(
        () => validateRemoteHostPayloadInputs(protoKey),
        key === 'target' ? 'payload_target_invalid' : 'payload_runtime_identity_invalid',
      )
    }
    expectContractCode(
      () => validateRemoteHostPayloadInputs({ ...clone(base), packageId: 'prime-continuim.remote-hoste\u0301' } as any),
      'payload_inputs_shape_invalid',
    )
    expectContractCode(
      () => validateRemoteHostPayloadInputs({ ...clone(base), protocolVersion: 1.5 } as any),
      'payload_inputs_shape_invalid',
    )
    expectContractCode(
      () => validateRemoteHostPayloadInputs({ ...clone(base), protocolVersion: Number.MAX_SAFE_INTEGER + 1 } as any),
      'payload_inputs_shape_invalid',
    )
  })

  it('accepts only exact canonical newline-framed input bytes using an intrinsic typed-array snapshot', () => {
    const canonical = serializeRemoteHostPayloadInputs(createRemoteHostPayloadInputs())
    expect(parseRemoteHostPayloadInputsBytes(canonical)).toEqual(createRemoteHostPayloadInputs())

    let hostileGetterRan = false
    class HostileBytes extends Uint8Array {
      override get byteLength(): number {
        hostileGetterRan = true
        throw new Error('hostile getter must not run')
      }
    }
    expect(parseRemoteHostPayloadInputsBytes(new HostileBytes(canonical))).toEqual(createRemoteHostPayloadInputs())
    expect(hostileGetterRan).toBe(false)

    const reordered = Buffer.from(`${JSON.stringify(createRemoteHostPayloadInputs())}\n`, 'utf8')
    expectContractCode(() => parseRemoteHostPayloadInputsBytes(reordered), 'payload_inputs_not_canonical')
    const duplicate = Buffer.from(canonical.toString('utf8').replace('{', '{"schema":"remote-host-payload-inputs/v1",'))
    expectContractCode(() => parseRemoteHostPayloadInputsBytes(duplicate), 'payload_inputs_not_canonical')
    expectContractCode(() => parseRemoteHostPayloadInputsBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical])), 'payload_inputs_bom_forbidden')
    expectContractCode(() => parseRemoteHostPayloadInputsBytes(Buffer.from(canonical.toString('utf8').replace(/\n$/u, '\r\n'))), 'payload_inputs_framing_invalid')
  })

  it('keeps exact checkout-stable launcher and unit bytes with service-only semantics', async () => {
    const templates = getRemoteHostPayloadTemplateBytes()
    const second = getRemoteHostPayloadTemplateBytes()
    const [launcherFile, serviceFile, attributes] = await Promise.all([
      readFile(resolve('scripts/remote-host-payload/prime-continuim-hostd-service.sh')),
      readFile(resolve('scripts/remote-host-payload/prime-continuim-hostd.service')),
      readFile(resolve('.gitattributes'), 'utf8'),
    ])

    expect(launcherFile.equals(templates.launcher)).toBe(true)
    expect(serviceFile.equals(templates.service)).toBe(true)
    expect(launcherFile.includes(0x0d)).toBe(false)
    expect(serviceFile.includes(0x0d)).toBe(false)
    expect(attributes).toContain('scripts/remote-host-payload/* text eol=lf')
    templates.launcher[0] = 0
    expect(second.launcher[0]).toBe('#'.charCodeAt(0))

    const launcher = launcherFile.toString('utf8')
    expect(launcher).toContain('if [ "$#" -ne 0 ]')
    expect(launcher).toContain('state="${HOME}/.local/state/prime-agent/hostd"')
    expect(launcher).toContain('export ELECTRON_RUN_AS_NODE=1')
    for (const variable of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_PROFILE', 'GLIBC_TUNABLES']) {
      expect(launcher).toContain(variable)
    }
    expect(launcher).toContain('"${root}/hostd.cjs" serve')
    expect(launcher).not.toContain(' connect ')
    expect(launcher).not.toContain('XDG_STATE_HOME')

    const service = serviceFile.toString('utf8')
    expect(service).toContain('Environment=HOME=%h')
    expect(service).toContain('UnsetEnvironment=NODE_OPTIONS NODE_PATH ELECTRON_RUN_AS_NODE')
    expect(service).toContain('NoNewPrivileges=true')
    expect(service).toContain('RestrictSUIDSGID=true')
    expect(service).toContain('UMask=0077')
    expect(service).not.toContain('KillMode=')
  })

  it('constructs a strict non-circular layout from a declared payload-tree digest and three final external records', () => {
    const artifacts = finalArtifacts()
    const layout = layoutFrom(artifacts)

    expect(layout.payloadTree).toEqual({
      definition: 'sha256-size-mode-path-lf/v1',
      order: 'utf8-bytewise',
      excludes: ['payload-layout.json'],
      sha256: digest('declared-payload-tree'),
      fileCount: 4,
      totalBytes: 4_096,
    })
    expect(Object.keys(layout.externalArtifacts).sort()).toEqual(['hostd', 'launcher', 'service'])
    expect((layout.externalArtifacts as any).runtime).toBeUndefined()
    for (const role of ['hostd', 'launcher', 'service'] as const) {
      expect(layout.externalArtifacts[role]).toMatchObject({
        ...artifacts[role],
        destination: REMOTE_HOST_PAYLOAD_DESTINATIONS[role].path,
        mode: REMOTE_HOST_PAYLOAD_DESTINATIONS[role].mode,
      })
    }
    expect(Object.values(layout.claims).every((value) => value === false)).toBe(true)
    expect(layout.assemblyAuthority).toBeNull()
    expect(Object.isFrozen(layout)).toBe(true)
  })

  it('round-trips only canonical layout bytes and rejects runtime/self entries, template drift, cross-feed, and invalid tree bounds', () => {
    const artifacts = finalArtifacts()
    const layout = layoutFrom(artifacts)
    const bytes = serializeRemoteHostPayloadLayout(layout)
    expect(parseRemoteHostPayloadLayoutBytes(bytes)).toEqual(layout)

    const runtimeKey = clone(layout) as any
    runtimeKey.externalArtifacts.runtime = artifacts.runtime
    expectContractCode(() => validateRemoteHostPayloadLayout(runtimeKey), 'external_artifacts_shape_invalid')

    const includedLayout = clone(layout) as any
    includedLayout.payloadTree.excludes = []
    expectContractCode(() => validateRemoteHostPayloadLayout(includedLayout), 'payload_tree_excludes_invalid')

    const templateDrift = clone(layout) as any
    templateDrift.externalArtifacts.launcher.sha256 = digest('different-launcher')
    expectContractCode(() => validateRemoteHostPayloadLayout(templateDrift), 'template_artifact_mismatch')

    expectContractCode(() => createRemoteHostPayloadLayout({
      payloadTree: { sha256: digest('tree'), fileCount: 0, totalBytes: 1 },
      externalArtifacts: externalArtifacts(artifacts),
    }), 'payload_tree_file_count_invalid')
    expectContractCode(() => createRemoteHostPayloadLayout({
      payloadTree: { sha256: artifacts.hostd.sha256, fileCount: 1, totalBytes: 1 },
      externalArtifacts: {
        ...externalArtifacts(artifacts),
        hostd: { ...artifacts.hostd, sha256: artifacts.launcher.sha256 },
      },
    }), 'artifact_digests_not_distinct')
  })

  it('constructs only an unsigned kit manifest/preimage reference from four final records and separate public trust IDs', () => {
    const artifacts = finalArtifacts()
    const inputs = createRemoteHostPayloadInputs()
    const layout = layoutFrom(artifacts)
    const { publicKey } = generateKeyPairSync('ed25519')
    const reference = createRemoteHostPayloadKitReference({
      inputs,
      layout,
      artifacts,
      trustAnchorId: createRemoteHostKitTrustAnchorId(publicKey),
      signerKeyId: 'test-only-payload-signer-01',
    })

    expect(Object.keys(reference).sort()).toEqual([
      'artifactBytesCorrelated',
      'assemblyAuthority',
      'manifest',
      'manifestBytes',
      'manifestSha256',
      'signaturePreimage',
      'signingAuthority',
    ])
    expect(parseRemoteHostKitManifestBytes(reference.manifestBytes)).toEqual(reference.manifest)
    expect(reference.manifest).toMatchObject({
      packageId: 'prime-continuim.remote-host',
      hostdVersion: '0.1.0',
      protocolVersion: 1,
      artifacts,
      installAction: 'fresh_install',
    })
    expect(reference.manifestSha256).toBe(sha256(reference.manifestBytes))
    expect(reference.signaturePreimage.equals(createRemoteHostKitSignaturePreimage(reference.manifest))).toBe(true)
    expect(Object.values(reference.manifest.claims).every((value) => value === false)).toBe(true)
    expect(Object.keys(reference.manifest.claims).sort()).toEqual([...REMOTE_HOST_KIT_CLAIM_KEYS].sort())
    expect(reference.artifactBytesCorrelated).toBe(false)
    expect(reference.assemblyAuthority).toBeNull()
    expect(reference.signingAuthority).toBeNull()
    expect(JSON.stringify(reference)).not.toContain('privateKey')
    expect(reference).not.toHaveProperty('signature')
    expect(reference).not.toHaveProperty('envelope')
  })

  it('rejects layout/final-record cross-feed, non-template roles, duplicate digests, and overstated claims', () => {
    const artifacts = finalArtifacts()
    const layout = layoutFrom(artifacts)
    const { publicKey } = generateKeyPairSync('ed25519')
    const base = {
      inputs: createRemoteHostPayloadInputs(),
      layout,
      artifacts,
      trustAnchorId: createRemoteHostKitTrustAnchorId(publicKey),
      signerKeyId: 'test-only-payload-signer-01',
    }

    const crossFed = clone(layout) as any
    crossFed.externalArtifacts.hostd.sha256 = digest('cross-fed-hostd')
    expectContractCode(() => createRemoteHostPayloadKitReference({ ...base, layout: crossFed }), 'kit_layout_artifact_mismatch')

    expectContractCode(() => createRemoteHostPayloadKitReference({
      ...base,
      artifacts: { ...artifacts, runtime: { ...artifacts.runtime, sha256: artifacts.hostd.sha256 } },
    } as any), 'kit_reference_invalid')

    const claims = clone(createRemoteHostPayloadInputs()) as any
    claims.claims.assemblyImplemented = true
    expectContractCode(() => validateRemoteHostPayloadInputs(claims), 'payload_claim_overstated')
  })

  it('exports no assembler, archive, traversal, probe, signer, envelope, or effect authority', () => {
    const names = Object.keys(PayloadContract)
    for (const forbidden of ['assemble', 'archive', 'traverse', 'probe', 'sign', 'envelope', 'install', 'publish']) {
      expect(names.some((name) => name.toLowerCase().includes(forbidden))).toBe(false)
    }
    expect(names).not.toContain('verifyRemoteHostPayload')
    expect(names).not.toContain('assembleRemoteHostPayload')
  })

  it('is absent from product, workflow, build, package, hostd, and SSH entrypoints', async () => {
    const sources = await Promise.all([
      readFile(resolve('package.json'), 'utf8'),
      readFile(resolve('scripts/run-workflow.mjs'), 'utf8'),
      readFile(resolve('scripts/build-hostd.mjs'), 'utf8'),
      readFile(resolve('scripts/verify-windows-package.mjs'), 'utf8'),
      readFile(resolve('src/main/index.ts'), 'utf8'),
      readFile(resolve('src/main/control/ssh.ts'), 'utf8'),
      readFile(resolve('src/preload/index.ts'), 'utf8'),
      readFile(resolve('src/renderer/src/App.tsx'), 'utf8'),
      readFile(resolve('src/hostd/index.ts'), 'utf8'),
    ])
    for (const source of sources) {
      expect(source).not.toContain('remote-host-payload-contract')
      expect(source).not.toContain('remote-host-payload/')
    }
  })
})

function finalArtifacts() {
  const templates = getRemoteHostPayloadTemplateBytes()
  return {
    hostd: artifact('hostd', Buffer.from('final-hostd-bytes', 'utf8')),
    runtime: artifact('runtime', Buffer.from('final-runtime-archive-bytes', 'utf8')),
    launcher: artifact('launcher', templates.launcher),
    service: artifact('service', templates.service),
  } as const
}

function externalArtifacts(artifacts: ReturnType<typeof finalArtifacts>) {
  return {
    hostd: artifacts.hostd,
    launcher: artifacts.launcher,
    service: artifacts.service,
  }
}

function layoutFrom(artifacts: ReturnType<typeof finalArtifacts>) {
  return createRemoteHostPayloadLayout({
    payloadTree: {
      sha256: digest('declared-payload-tree'),
      fileCount: 4,
      totalBytes: 4_096,
    },
    externalArtifacts: externalArtifacts(artifacts),
  })
}

function artifact<Role extends 'hostd' | 'runtime' | 'launcher' | 'service'>(role: Role, bytes: Uint8Array) {
  return { role, sha256: sha256(bytes), bytes: bytes.byteLength }
}

function digest(value: string): string {
  return sha256(Buffer.from(value, 'utf8'))
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function expectContractCode(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteHostPayloadContractError)
    expect((error as { code: string }).code).toBe(code)
    expect((error as Error).message).toBe(code)
    return
  }
  throw new Error(`Expected RemoteHostPayloadContractError: ${code}`)
}
