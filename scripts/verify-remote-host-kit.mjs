import { createHash, createPublicKey } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual, types as utilTypes } from 'node:util'

import {
  REMOTE_HOST_KIT_ARTIFACT_ROLES,
  REMOTE_HOST_KIT_MAX_ENVELOPE_BYTES,
  REMOTE_HOST_KIT_MAX_MANIFEST_BYTES,
  RemoteHostKitContractError,
  verifyRemoteHostKitEnvelopeBytes,
} from './remote-host-kit-lib.mjs'

const VERIFIER_KIND = 'prime_continuim_remote_host_kit_static_verifier_v1'
const OPTION_KEYS = Object.freeze([
  'manifestPath',
  'envelopePath',
  'hostdPath',
  'runtimePath',
  'launcherPath',
  'servicePath',
  'publicKeySpkiPath',
  'trustAnchorId',
  'signerKeyId',
])
const ARGUMENT_NAMES = Object.freeze({
  '--manifest': 'manifestPath',
  '--envelope': 'envelopePath',
  '--hostd': 'hostdPath',
  '--runtime': 'runtimePath',
  '--launcher': 'launcherPath',
  '--service': 'servicePath',
  '--public-key-spki': 'publicKeySpkiPath',
  '--trust-anchor-id': 'trustAnchorId',
  '--signer-key-id': 'signerKeyId',
})

export async function verifyRemoteHostKitFiles(input) {
  const options = validateOptions(input)
  const [manifestBytes, envelopeBytes, publicKeySpki] = await Promise.all([
    readBoundedRegularFile(options.manifestPath, 2, REMOTE_HOST_KIT_MAX_MANIFEST_BYTES),
    readBoundedRegularFile(options.envelopePath, 2, REMOTE_HOST_KIT_MAX_ENVELOPE_BYTES),
    readBoundedRegularFile(options.publicKeySpkiPath, 32, 1024),
  ])
  const publicKey = parseCanonicalEd25519Spki(publicKeySpki)
  const verified = verifyRemoteHostKitEnvelopeBytes(manifestBytes, envelopeBytes, {
    trustAnchorId: options.trustAnchorId,
    signerKeyId: options.signerKeyId,
    publicKey,
  })

  const artifacts = Object.create(null)
  for (const role of REMOTE_HOST_KIT_ARTIFACT_ROLES) {
    const declared = verified.manifest.artifacts[role]
    const observed = await hashExactRegularFile(options[`${role}Path`], declared.bytes)
    if (observed.sha256 !== declared.sha256) fail('artifact_digest_mismatch')
    artifacts[role] = Object.freeze({ role, sha256: observed.sha256, bytes: observed.bytes })
  }

  return deepFreeze({
    kind: VERIFIER_KIND,
    schema: verified.schema,
    packageId: verified.packageId,
    manifestSha256: verified.manifestSha256,
    envelopeSha256: verified.envelopeSha256,
    trustAnchorId: verified.trustAnchorId,
    signerKeyId: verified.signerKeyId,
    artifacts,
    verification: {
      canonicalBytes: true,
      strictSchema: true,
      ed25519SignatureVerified: true,
      independentTrustCorrelation: true,
      artifactBytesCorrelated: true,
    },
    claims: verified.manifest.claims,
  })
}

function validateOptions(input) {
  if (utilTypes.isProxy(input) || input === null || typeof input !== 'object' || Array.isArray(input)) fail('options_invalid')
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) fail('options_invalid')
  const keys = Reflect.ownKeys(input)
  if (keys.some((key) => typeof key !== 'string')) fail('options_invalid')
  if (!isDeepStrictEqual([...keys].sort(), [...OPTION_KEYS].sort())) fail('options_invalid')
  const options = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string') fail('options_invalid')
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail('options_invalid')
    if (typeof descriptor.value !== 'string' || descriptor.value.length < 1 || descriptor.value.length > 4096 || descriptor.value.includes('\0')) {
      fail('options_invalid')
    }
    options[key] = descriptor.value
  }
  return options
}

function parseCanonicalEd25519Spki(bytes) {
  let key
  try {
    key = createPublicKey({ key: bytes, format: 'der', type: 'spki' })
  } catch {
    fail('trust_public_key_invalid')
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') fail('trust_public_key_invalid')
  const canonical = key.export({ format: 'der', type: 'spki' })
  if (!Buffer.isBuffer(canonical) || !canonical.equals(bytes)) fail('trust_public_key_not_canonical')
  return key
}

async function readBoundedRegularFile(path, minimum, maximum) {
  const identity = await lstat(path, { bigint: true }).catch(() => fail('input_file_invalid'))
  if (!identity.isFile() || identity.isSymbolicLink() || identity.size < BigInt(minimum) || identity.size > BigInt(maximum)) {
    fail('input_file_invalid')
  }
  const handle = await open(path, 'r').catch(() => fail('input_file_invalid'))
  try {
    const opened = await handle.stat({ bigint: true })
    requireSameFile(identity, opened)
    const size = Number(opened.size)
    const buffer = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset)
      if (bytesRead === 0) fail('input_file_changed')
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    requireSameFile(opened, after)
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) fail('input_file_changed')
    return buffer
  } finally {
    await handle.close()
  }
}

async function hashExactRegularFile(path, expectedBytes) {
  const identity = await lstat(path, { bigint: true }).catch(() => fail('artifact_file_invalid'))
  if (!identity.isFile() || identity.isSymbolicLink() || identity.size !== BigInt(expectedBytes)) {
    fail('artifact_size_mismatch')
  }
  const handle = await open(path, 'r').catch(() => fail('artifact_file_invalid'))
  try {
    const opened = await handle.stat({ bigint: true })
    requireSameFile(identity, opened)
    if (opened.size !== BigInt(expectedBytes)) fail('artifact_size_mismatch')
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, expectedBytes))
    let offset = 0
    while (offset < expectedBytes) {
      const length = Math.min(chunk.byteLength, expectedBytes - offset)
      const { bytesRead } = await handle.read(chunk, 0, length, offset)
      if (bytesRead < 1) fail('artifact_file_changed')
      hash.update(chunk.subarray(0, bytesRead))
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    requireSameFile(opened, after)
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) fail('artifact_file_changed')
    return Object.freeze({ bytes: offset, sha256: hash.digest('hex') })
  } finally {
    await handle.close()
  }
}

function requireSameFile(left, right) {
  if (!right.isFile() || left.dev !== right.dev || left.ino !== right.ino) fail('input_file_changed')
}

function parseArguments(argv) {
  if (argv.length !== OPTION_KEYS.length * 2) fail('usage_invalid')
  const options = Object.create(null)
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    const key = ARGUMENT_NAMES[name]
    if (key === undefined || options[key] !== undefined || typeof value !== 'string' || value.length < 1) {
      fail('usage_invalid')
    }
    options[key] = value
  }
  if (!isDeepStrictEqual(Object.keys(options).sort(), [...OPTION_KEYS].sort())) fail('usage_invalid')
  return options
}

function fail(code) {
  throw new RemoteHostKitContractError(code)
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

async function main() {
  try {
    const verified = await verifyRemoteHostKitFiles(parseArguments(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(verified)}\n`)
  } catch {
    process.stderr.write('Prime Continuim remote host kit static verification failed.\n')
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
