import { createHash, verify as verifySignature } from 'node:crypto'
import { isDeepStrictEqual, types as utilTypes } from 'node:util'

export const REMOTE_HOST_KIT_SCHEMA = 'remote-host-kit/v1'
export const REMOTE_HOST_KIT_ENVELOPE_SCHEMA = 'remote-host-kit-signature-envelope/v1'
export const REMOTE_HOST_KIT_SIGNATURE_DOMAIN = 'prime-continuim.remote-host-kit.ed25519/v1'
export const REMOTE_HOST_KIT_MAX_MANIFEST_BYTES = 16 * 1024
export const REMOTE_HOST_KIT_MAX_ENVELOPE_BYTES = 32 * 1024

export const REMOTE_HOST_KIT_TARGET = deepFreeze({
  platform: 'linux',
  arch: 'x64',
  libc: 'glibc',
})

export const REMOTE_HOST_KIT_RUNTIME_IDENTITY = deepFreeze({
  kind: 'electron-run-as-node',
  electronVersion: '43.3.0',
  nodeVersion: '24.18.1',
  modulesAbi: '148',
  napiVersion: '10',
  platform: 'linux',
  arch: 'x64',
  runAsNode: true,
})

export const REMOTE_HOST_KIT_ARTIFACT_ROLES = Object.freeze([
  'hostd',
  'runtime',
  'launcher',
  'service',
])

export const REMOTE_HOST_KIT_CLAIM_KEYS = Object.freeze([
  'installImplemented',
  'liveInstallVerified',
  'remoteExecution',
  'authentication',
  'authorization',
  'upgradeSupported',
  'repairSupported',
  'downgradeSupported',
  'providerBackedEvaluation',
  'autonomousPromotion',
])

const MANIFEST_KEYS = Object.freeze([
  'schema',
  'packageId',
  'hostdVersion',
  'protocolVersion',
  'target',
  'runtimeIdentity',
  'artifacts',
  'installAction',
  'trustAnchorId',
  'signerKeyId',
  'claims',
])
const TARGET_KEYS = Object.freeze(['platform', 'arch', 'libc'])
const RUNTIME_IDENTITY_KEYS = Object.freeze([
  'kind',
  'electronVersion',
  'nodeVersion',
  'modulesAbi',
  'napiVersion',
  'platform',
  'arch',
  'runAsNode',
])
const ARTIFACT_KEYS = REMOTE_HOST_KIT_ARTIFACT_ROLES
const ARTIFACT_RECORD_KEYS = Object.freeze(['role', 'sha256', 'bytes'])
const ENVELOPE_KEYS = Object.freeze([
  'schema',
  'trustAnchorId',
  'signerKeyId',
  'manifestSha256',
  'signature',
])
const SIGNATURE_KEYS = Object.freeze(['algorithm', 'encoding', 'value'])
const TRUST_KEYS = Object.freeze(['trustAnchorId', 'signerKeyId', 'publicKey'])
const SIGNATURE_PREIMAGE_KEYS = Object.freeze([
  'domain',
  'trustAnchorId',
  'signerKeyId',
  'manifestSha256',
  'manifest',
])
const ARTIFACT_MAX_BYTES = deepFreeze({
  hostd: 64 * 1024 * 1024,
  runtime: 2 * 1024 * 1024 * 1024,
  launcher: 512 * 1024 * 1024,
  service: 1024 * 1024,
})
const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/u
const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u
const KEY_IDENTIFIER = /^[a-z][a-z0-9._-]{2,63}$/u
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/u
const TRUST_ANCHOR_ID = /^ed25519-spki-sha256-[a-f0-9]{64}$/u
const CANONICAL_BASE64URL = /^(?:[A-Za-z0-9_-]{4}){21}[A-Za-z0-9_-][AQgw]$/u

export class RemoteHostKitContractError extends Error {
  constructor(code = 'remote_host_kit_invalid', message = code) {
    super(message)
    this.name = 'RemoteHostKitContractError'
    this.code = code
  }
}

export function validateRemoteHostKitManifest(input) {
  const manifest = snapshotPlainData(input, 'manifest_shape_invalid')
  exactObject(manifest, MANIFEST_KEYS, 'manifest_shape_invalid')
  exactValue(manifest.schema, REMOTE_HOST_KIT_SCHEMA, 'manifest_schema_unsupported')
  requireIdentifier(manifest.packageId, IDENTIFIER, 'package_id_invalid')
  requireVersion(manifest.hostdVersion, 'hostd_version_invalid')
  if (!Number.isSafeInteger(manifest.protocolVersion) || manifest.protocolVersion < 1 || manifest.protocolVersion > 1_000_000) {
    fail('protocol_version_invalid')
  }

  exactObject(manifest.target, TARGET_KEYS, 'target_invalid')
  exactValue(manifest.target.platform, REMOTE_HOST_KIT_TARGET.platform, 'target_platform_unsupported')
  exactValue(manifest.target.arch, REMOTE_HOST_KIT_TARGET.arch, 'target_arch_unsupported')
  exactValue(manifest.target.libc, REMOTE_HOST_KIT_TARGET.libc, 'target_libc_unsupported')

  validateRuntimeIdentity(manifest.runtimeIdentity)
  validateArtifacts(manifest.artifacts)
  exactValue(manifest.installAction, 'fresh_install', 'install_action_unsupported')
  requireIdentifier(manifest.trustAnchorId, TRUST_ANCHOR_ID, 'trust_anchor_id_invalid')
  requireIdentifier(manifest.signerKeyId, KEY_IDENTIFIER, 'signer_key_id_invalid')
  if (manifest.trustAnchorId === manifest.signerKeyId) fail('trust_identity_ambiguous')
  validateClaims(manifest.claims)

  const canonicalBytes = Buffer.from(canonicalJson(manifest), 'utf8')
  if (canonicalBytes.byteLength > REMOTE_HOST_KIT_MAX_MANIFEST_BYTES) fail('manifest_oversize')
  return deepFreeze(manifest)
}

export function canonicalRemoteHostKitJson(input) {
  return canonicalJson(snapshotPlainData(input, 'canonical_value_invalid'))
}

export function serializeRemoteHostKitManifest(input) {
  const manifest = validateRemoteHostKitManifest(input)
  const bytes = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8')
  if (bytes.byteLength > REMOTE_HOST_KIT_MAX_MANIFEST_BYTES) fail('manifest_oversize')
  return bytes
}

export function parseRemoteHostKitManifestBytes(input) {
  const bytes = boundedBytes(input, REMOTE_HOST_KIT_MAX_MANIFEST_BYTES, 'manifest')
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('manifest_bom_forbidden')
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('manifest_utf8_invalid')
  }
  if (!text.endsWith('\n') || text.endsWith('\n\n') || text.includes('\r')) fail('manifest_framing_invalid')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('manifest_json_invalid')
  }
  const manifest = validateRemoteHostKitManifest(parsed)
  if (`${canonicalJson(manifest)}\n` !== text) fail('manifest_not_canonical')
  return manifest
}

export function createRemoteHostKitSignaturePreimage(input) {
  const manifest = validateRemoteHostKitManifest(input)
  const manifestSha256 = sha256(serializeRemoteHostKitManifest(manifest))
  return Buffer.from(canonicalJson({
    domain: REMOTE_HOST_KIT_SIGNATURE_DOMAIN,
    trustAnchorId: manifest.trustAnchorId,
    signerKeyId: manifest.signerKeyId,
    manifestSha256,
    manifest,
  }), 'utf8')
}

export function createRemoteHostKitTrustAnchorId(publicKey) {
  const validated = validateEd25519PublicKey(publicKey)
  let canonicalSpki
  try {
    canonicalSpki = validated.export({ format: 'der', type: 'spki' })
  } catch {
    fail('trust_public_key_invalid')
  }
  if (!Buffer.isBuffer(canonicalSpki)) fail('trust_public_key_invalid')
  return `ed25519-spki-sha256-${sha256(canonicalSpki)}`
}

export function createRemoteHostKitSignatureEnvelope(input, signature) {
  const manifest = validateRemoteHostKitManifest(input)
  const signatureValue = canonicalSignatureValue(signature)
  return validateEnvelope({
    schema: REMOTE_HOST_KIT_ENVELOPE_SCHEMA,
    trustAnchorId: manifest.trustAnchorId,
    signerKeyId: manifest.signerKeyId,
    manifestSha256: sha256(serializeRemoteHostKitManifest(manifest)),
    signature: {
      algorithm: 'Ed25519',
      encoding: 'base64url',
      value: signatureValue,
    },
  })
}

export function serializeRemoteHostKitSignatureEnvelope(input) {
  const envelope = validateEnvelope(input)
  const bytes = Buffer.from(`${canonicalJson(envelope)}\n`, 'utf8')
  if (bytes.byteLength > REMOTE_HOST_KIT_MAX_ENVELOPE_BYTES) fail('envelope_oversize')
  return bytes
}

export function verifyRemoteHostKitEnvelopeBytes(manifestInput, envelopeInput, independentTrust) {
  const manifestBytes = boundedBytes(manifestInput, REMOTE_HOST_KIT_MAX_MANIFEST_BYTES, 'manifest')
  const manifest = parseRemoteHostKitManifestBytes(manifestBytes)
  const envelopeBytes = boundedBytes(envelopeInput, REMOTE_HOST_KIT_MAX_ENVELOPE_BYTES, 'envelope')
  const envelope = parseCanonicalEnvelope(envelopeBytes)
  const trust = validateIndependentTrust(independentTrust)

  exactValue(envelope.trustAnchorId, manifest.trustAnchorId, 'trust_anchor_mismatch')
  exactValue(envelope.signerKeyId, manifest.signerKeyId, 'signer_key_mismatch')
  exactValue(envelope.trustAnchorId, trust.trustAnchorId, 'trust_anchor_mismatch')
  exactValue(envelope.signerKeyId, trust.signerKeyId, 'signer_key_mismatch')
  exactValue(envelope.manifestSha256, sha256(manifestBytes), 'manifest_digest_mismatch')
  const signature = Buffer.from(envelope.signature.value, 'base64url')
  let signatureValid = false
  try {
    signatureValid = verifySignature(
      null,
      createRemoteHostKitSignaturePreimage(manifest),
      trust.publicKey,
      signature,
    )
  } catch {
    fail('signature_verification_failed')
  }
  if (!signatureValid) {
    fail('signature_invalid')
  }

  return deepFreeze({
    schema: REMOTE_HOST_KIT_SCHEMA,
    packageId: manifest.packageId,
    manifestSha256: envelope.manifestSha256,
    envelopeSha256: sha256(envelopeBytes),
    trustAnchorId: envelope.trustAnchorId,
    signerKeyId: envelope.signerKeyId,
    manifest,
    verification: {
      canonicalBytes: true,
      strictSchema: true,
      ed25519SignatureVerified: true,
      independentTrustCorrelation: true,
      artifactBytesCorrelated: false,
    },
  })
}

export function verifyRemoteHostKitArtifactBytes(input, artifactBytes) {
  const manifest = validateRemoteHostKitManifest(input)
  const artifacts = snapshotArtifactBytes(artifactBytes)
  const verified = Object.create(null)

  for (const role of REMOTE_HOST_KIT_ARTIFACT_ROLES) {
    const bytes = artifacts[role]
    const declared = manifest.artifacts[role]
    if (bytes.byteLength !== declared.bytes) fail('artifact_size_mismatch')
    const digest = sha256(bytes)
    if (digest !== declared.sha256) fail('artifact_digest_mismatch')
    verified[role] = { role, sha256: digest, bytes: bytes.byteLength }
  }

  return deepFreeze({
    packageId: manifest.packageId,
    artifacts: verified,
    artifactBytesCorrelated: true,
  })
}

export function verifyRemoteHostKitBytes(manifestBytes, envelopeBytes, artifactBytes, independentTrust) {
  const envelope = verifyRemoteHostKitEnvelopeBytes(manifestBytes, envelopeBytes, independentTrust)
  const correlation = verifyRemoteHostKitArtifactBytes(envelope.manifest, artifactBytes)
  return deepFreeze({
    ...envelope,
    artifacts: correlation.artifacts,
    verification: {
      ...envelope.verification,
      artifactBytesCorrelated: true,
    },
  })
}

function parseCanonicalEnvelope(bytes) {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('envelope_bom_forbidden')
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('envelope_utf8_invalid')
  }
  if (!text.endsWith('\n') || text.endsWith('\n\n') || text.includes('\r')) fail('envelope_framing_invalid')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('envelope_json_invalid')
  }
  const envelope = validateEnvelope(parsed)
  if (`${canonicalJson(envelope)}\n` !== text) fail('envelope_not_canonical')
  return envelope
}

function validateEnvelope(input) {
  const envelope = snapshotPlainData(input, 'envelope_shape_invalid')
  exactObject(envelope, ENVELOPE_KEYS, 'envelope_shape_invalid')
  exactValue(envelope.schema, REMOTE_HOST_KIT_ENVELOPE_SCHEMA, 'envelope_schema_unsupported')
  requireIdentifier(envelope.trustAnchorId, TRUST_ANCHOR_ID, 'trust_anchor_id_invalid')
  requireIdentifier(envelope.signerKeyId, KEY_IDENTIFIER, 'signer_key_id_invalid')
  if (!SHA256.test(envelope.manifestSha256 ?? '')) fail('manifest_digest_invalid')
  exactObject(envelope.signature, SIGNATURE_KEYS, 'signature_shape_invalid')
  exactValue(envelope.signature.algorithm, 'Ed25519', 'signature_algorithm_unsupported')
  exactValue(envelope.signature.encoding, 'base64url', 'signature_encoding_unsupported')
  canonicalSignatureValue(envelope.signature.value)
  return deepFreeze(envelope)
}

function validateIndependentTrust(input) {
  if (utilTypes.isProxy(input) || input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('trust_configuration_invalid')
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) fail('trust_configuration_invalid')
  const keys = Reflect.ownKeys(input)
  if (keys.some((key) => typeof key !== 'string')) fail('trust_configuration_invalid')
  if (!isDeepStrictEqual([...keys].sort(), [...TRUST_KEYS].sort())) fail('trust_configuration_invalid')
  const values = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string') fail('trust_configuration_invalid')
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      fail('trust_configuration_invalid')
    }
    values[key] = descriptor.value
  }
  requireIdentifier(values.trustAnchorId, TRUST_ANCHOR_ID, 'trust_anchor_id_invalid')
  requireIdentifier(values.signerKeyId, KEY_IDENTIFIER, 'signer_key_id_invalid')
  if (values.trustAnchorId === values.signerKeyId) fail('trust_identity_ambiguous')
  values.publicKey = validateEd25519PublicKey(values.publicKey)
  exactValue(values.trustAnchorId, createRemoteHostKitTrustAnchorId(values.publicKey), 'trust_anchor_key_mismatch')
  return Object.freeze(values)
}

function validateRuntimeIdentity(value) {
  exactObject(value, RUNTIME_IDENTITY_KEYS, 'runtime_identity_invalid')
  for (const key of RUNTIME_IDENTITY_KEYS) {
    exactValue(value[key], REMOTE_HOST_KIT_RUNTIME_IDENTITY[key], 'runtime_identity_invalid')
  }
}

function validateArtifacts(value) {
  exactObject(value, ARTIFACT_KEYS, 'artifacts_shape_invalid')
  const digests = []
  for (const role of REMOTE_HOST_KIT_ARTIFACT_ROLES) {
    const artifact = value[role]
    exactObject(artifact, ARTIFACT_RECORD_KEYS, 'artifact_shape_invalid')
    exactValue(artifact.role, role, 'artifact_role_mismatch')
    if (!SHA256.test(artifact.sha256 ?? '')) fail('artifact_digest_invalid')
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > ARTIFACT_MAX_BYTES[role]) {
      fail('artifact_size_invalid')
    }
    digests.push(artifact.sha256)
  }
  if (new Set(digests).size !== digests.length) fail('artifact_digests_not_distinct')
}

function validateClaims(value) {
  exactObject(value, REMOTE_HOST_KIT_CLAIM_KEYS, 'claims_shape_invalid')
  for (const key of REMOTE_HOST_KIT_CLAIM_KEYS) exactValue(value[key], false, 'claim_overstated')
}

function snapshotArtifactBytes(input) {
  if (utilTypes.isProxy(input) || input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('artifact_bytes_shape_invalid')
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) fail('artifact_bytes_shape_invalid')
  const keys = Reflect.ownKeys(input)
  if (keys.some((key) => typeof key !== 'string')) fail('artifact_bytes_shape_invalid')
  if (!isDeepStrictEqual([...keys].sort(), [...ARTIFACT_KEYS].sort())) fail('artifact_bytes_shape_invalid')
  const result = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string') fail('artifact_bytes_shape_invalid')
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail('artifact_bytes_shape_invalid')
    const value = descriptor.value
    if (utilTypes.isProxy(value) || !(value instanceof Uint8Array)) fail('artifact_bytes_shape_invalid')
    result[key] = Buffer.from(value)
  }
  return result
}

function snapshotPlainData(value, code) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail(code)
    return value
  }
  if (value === undefined || utilTypes.isProxy(value) || typeof value !== 'object') fail(code)
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail(code)
    const keys = Reflect.ownKeys(value)
    const expected = [...Array.from({ length: value.length }, (_, index) => String(index)), 'length']
    if (!isDeepStrictEqual(keys, expected)) fail(code)
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail(code)
      return snapshotPlainData(descriptor.value, code)
    })
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(code)
  const result = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(code)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail(code)
    Object.defineProperty(result, key, {
      value: snapshotPlainData(descriptor.value, code),
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return result
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.normalize('NFC') !== value) fail('canonical_string_invalid')
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail('canonical_number_invalid')
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === undefined || value === null || typeof value !== 'object') fail('canonical_value_invalid')
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

function canonicalSignatureValue(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    if (value.byteLength !== 64) fail('signature_length_invalid')
    return Buffer.from(value).toString('base64url')
  }
  if (typeof value !== 'string' || !CANONICAL_BASE64URL.test(value)) fail('signature_base64url_invalid')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.byteLength !== 64 || bytes.toString('base64url') !== value) fail('signature_base64url_invalid')
  return value
}

function validateEd25519PublicKey(value) {
  if (
    utilTypes.isProxy(value) ||
    value === null ||
    typeof value !== 'object' ||
    !utilTypes.isKeyObject(value) ||
    value.type !== 'public' ||
    value.asymmetricKeyType !== 'ed25519'
  ) fail('trust_public_key_invalid')
  return value
}

function boundedBytes(input, maximum, label) {
  if (utilTypes.isProxy(input) || !(input instanceof Uint8Array)) fail(`${label}_bytes_invalid`)
  if (input.byteLength < 2 || input.byteLength > maximum) {
    fail(input.byteLength > maximum ? `${label}_oversize` : `${label}_bytes_invalid`)
  }
  return Buffer.from(input)
}

function exactObject(value, keys, code) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
  ) fail(code)
}

function exactValue(actual, expected, code) {
  if (actual !== expected) fail(code)
}

function requireIdentifier(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code)
}

function requireVersion(value, code) {
  if (typeof value !== 'string' || value.length > 64 || !SEMVER.test(value)) fail(code)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fail(code) {
  throw new RemoteHostKitContractError(code)
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
