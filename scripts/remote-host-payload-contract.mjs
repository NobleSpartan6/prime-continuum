import { createHash } from 'node:crypto'
import { isDeepStrictEqual, types as utilTypes } from 'node:util'
import {
  REMOTE_HOST_KIT_CLAIM_KEYS,
  REMOTE_HOST_KIT_RUNTIME_IDENTITY,
  REMOTE_HOST_KIT_SCHEMA,
  REMOTE_HOST_KIT_TARGET,
  createRemoteHostKitSignaturePreimage,
  serializeRemoteHostKitManifest,
  validateRemoteHostKitManifest,
} from './remote-host-kit-lib.mjs'

export const REMOTE_HOST_PAYLOAD_INPUTS_SCHEMA = 'remote-host-payload-inputs/v1'
export const REMOTE_HOST_PAYLOAD_LAYOUT_SCHEMA = 'remote-host-payload-layout/v1'
export const REMOTE_HOST_ELECTRON_PROVENANCE_SCHEMA = 'electron-release-archive-provenance/v1'
export const REMOTE_HOST_PAYLOAD_TREE_DEFINITION = 'sha256-size-mode-path-lf/v1'
export const REMOTE_HOST_PAYLOAD_PACKAGE_ID = 'prime-continuim.remote-host'
export const REMOTE_HOST_PAYLOAD_HOSTD_VERSION = '0.1.0'
export const REMOTE_HOST_PAYLOAD_PROTOCOL_VERSION = 1
export const REMOTE_HOST_PAYLOAD_MAX_INPUT_BYTES = 64 * 1024
export const REMOTE_HOST_PAYLOAD_MAX_LAYOUT_BYTES = 64 * 1024

export const REMOTE_HOST_PAYLOAD_PRIME_AGENT = deepFreeze({
  releaseVersion: '0.7.1',
  runtimePolicySchemaVersion: 1,
  daemonProtocolVersion: 7,
  daemonSchemaRevision: 13,
  daemonSchemaId: 'protocol-7-schema-13-816309b1cd50',
  runtimeBuildId: '95afd31-dirty',
  releaseCommit: '95afd319a78ae017a41241d50b013d656a0685ce',
  runtimePolicySha256: '5e08665a0510ee2c785a910a5d665e8391fb9d2e85277f65bac43cdb6748f97c',
  sourcesSha256: '070af8b8f591240b27d33e8f9606ddc11ec6712906cfed2766c89244beebf7ea',
  packageLockSha256: '0cba345a1ebb89c6d5a3c890801200c905abe8c3ba6f5ce1c246d98557a5579a',
})

export const REMOTE_HOST_ELECTRON_PROVENANCE = deepFreeze({
  schema: REMOTE_HOST_ELECTRON_PROVENANCE_SCHEMA,
  version: '43.3.0',
  tag: 'v43.3.0',
  releaseUrl: 'https://github.com/electron/electron/releases/tag/v43.3.0',
  target: {
    platform: 'linux',
    arch: 'x64',
  },
  archive: {
    name: 'electron-v43.3.0-linux-x64.zip',
    url: 'https://github.com/electron/electron/releases/download/v43.3.0/electron-v43.3.0-linux-x64.zip',
    bytes: 125_603_646,
    sha256: 'f4987e9f045e46b117f0805d6ba4dc524e2abb2c2e33660f175bb39564bd3dae',
  },
  shasums: {
    name: 'SHASUMS256.txt',
    url: 'https://github.com/electron/electron/releases/download/v43.3.0/SHASUMS256.txt',
    bytes: 7_610,
    sha256: '43f854bd8a201a9abdf4bace97681144ec7230893462c6db7681a0f6db8cb7f9',
    archiveLine: 'f4987e9f045e46b117f0805d6ba4dc524e2abb2c2e33660f175bb39564bd3dae *electron-v43.3.0-linux-x64.zip',
  },
})

// Package/staging namespace declarations only. These are not installed paths
// and confer no relocation or filesystem authority.
export const REMOTE_HOST_PAYLOAD_DESTINATIONS = deepFreeze({
  hostd: { role: 'hostd', path: 'hostd/hostd.cjs', mode: '0644' },
  runtime: { role: 'runtime', path: 'runtime/runtime.zip', mode: '0644' },
  launcher: { role: 'launcher', path: 'launcher/prime-continuim-hostd-service', mode: '0755' },
  service: { role: 'service', path: 'service/prime-continuim-hostd.service', mode: '0644' },
})

export const REMOTE_HOST_PAYLOAD_CLAIM_KEYS = Object.freeze([
  'assemblyImplemented',
  'artifactBytesCorrelated',
  'electronArchiveVerified',
  'runtimeSeedVerified',
  'hostdAttestationCorrelated',
  'linuxExecutionVerified',
  'glibcCompatibilityVerified',
  'nativeAddonSmokeVerified',
  'systemdLifecycleVerified',
  'licensesComplete',
  'signingImplemented',
  'installationImplemented',
])

const INPUT_KEYS = Object.freeze([
  'schema',
  'packageId',
  'hostdVersion',
  'protocolVersion',
  'target',
  'runtimeIdentity',
  'primeAgent',
  'electron',
  'destinations',
  'claims',
  'assemblyAuthority',
])
const LAYOUT_KEYS = Object.freeze([
  'schema',
  'packageId',
  'hostdVersion',
  'protocolVersion',
  'target',
  'runtimeIdentity',
  'primeAgent',
  'electron',
  'destinations',
  'payloadTree',
  'externalArtifacts',
  'claims',
  'assemblyAuthority',
])
const PRIME_AGENT_KEYS = Object.freeze([
  'releaseVersion',
  'runtimePolicySchemaVersion',
  'daemonProtocolVersion',
  'daemonSchemaRevision',
  'daemonSchemaId',
  'runtimeBuildId',
  'releaseCommit',
  'runtimePolicySha256',
  'sourcesSha256',
  'packageLockSha256',
])
const PROVENANCE_KEYS = Object.freeze(['schema', 'version', 'tag', 'releaseUrl', 'target', 'archive', 'shasums'])
const PROVENANCE_TARGET_KEYS = Object.freeze(['platform', 'arch'])
const ARCHIVE_KEYS = Object.freeze(['name', 'url', 'bytes', 'sha256'])
const SHASUMS_KEYS = Object.freeze(['name', 'url', 'bytes', 'sha256', 'archiveLine'])
const DESTINATION_KEYS = Object.freeze(['role', 'path', 'mode'])
const ARTIFACT_ROLES = Object.freeze(['hostd', 'runtime', 'launcher', 'service'])
const EXTERNAL_ARTIFACT_ROLES = Object.freeze(['hostd', 'launcher', 'service'])
const ARTIFACT_KEYS = Object.freeze(['role', 'sha256', 'bytes'])
const EXTERNAL_ARTIFACT_KEYS = Object.freeze(['role', 'sha256', 'bytes', 'destination', 'mode'])
const ARTIFACT_MAX_BYTES = deepFreeze({
  hostd: 64 * 1024 * 1024,
  runtime: 2 * 1024 * 1024 * 1024,
  launcher: 512 * 1024 * 1024,
  service: 1024 * 1024,
})
const PAYLOAD_TREE_KEYS = Object.freeze([
  'definition',
  'order',
  'excludes',
  'sha256',
  'fileCount',
  'totalBytes',
])
const LAYOUT_CONSTRUCTION_KEYS = Object.freeze(['payloadTree', 'externalArtifacts'])
const PAYLOAD_TREE_CONSTRUCTION_KEYS = Object.freeze(['sha256', 'fileCount', 'totalBytes'])
const KIT_REFERENCE_KEYS = Object.freeze(['inputs', 'layout', 'artifacts', 'trustAnchorId', 'signerKeyId'])
const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/u
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype)
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'buffer').get
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'byteOffset').get
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'byteLength').get

const CLAIMS = deepFreeze(Object.fromEntries(REMOTE_HOST_PAYLOAD_CLAIM_KEYS.map((key) => [key, false])))
const KIT_CLAIMS = deepFreeze(Object.fromEntries(REMOTE_HOST_KIT_CLAIM_KEYS.map((key) => [key, false])))

const LAUNCHER_TEMPLATE = `${[
  '#!/bin/sh',
  'set -eu',
  'umask 077',
  '',
  'if [ "$#" -ne 0 ]; then',
  "  printf '%s\\n' 'Prime Continuim service launcher accepts no arguments.' >&2",
  '  exit 64',
  'fi',
  '',
  'case "${HOME-}" in',
  '  /*) ;;',
  '  *)',
  "    printf '%s\\n' 'Prime Continuim service launcher requires an absolute HOME.' >&2",
  '    exit 78',
  '    ;;',
  'esac',
  '',
  'root="${HOME}/.local/lib/prime-continuim/remote-host/v1"',
  'state="${HOME}/.local/state/prime-agent/hostd"',
  '',
  'unset NODE_OPTIONS NODE_PATH',
  'unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_PROFILE GLIBC_TUNABLES',
  'unset ELECTRON_RUN_AS_NODE',
  'unset ELECTRON_ENABLE_LOGGING ELECTRON_ENABLE_STACK_DUMPING',
  'unset PRIME_AGENT_DATA_DIR PRIME_CONTINUIM_PACKAGE_SMOKE',
  'unset PRIME_AGENT_BUILD_ID PRIME_AGENT_LAUNCHER_PATH',
  '',
  'export ELECTRON_RUN_AS_NODE=1',
  '',
  'exec "${root}/electron/electron" \\',
  '  "${root}/hostd.cjs" serve \\',
  '  --data-dir "${state}" \\',
  '  --runtime-seed "${root}/runtime-seed"',
].join('\n')}\n`

const SERVICE_TEMPLATE = `${[
  '[Unit]',
  'Description=Prime Continuim remote host service',
  '',
  '[Service]',
  'Type=simple',
  'Environment=HOME=%h',
  'UnsetEnvironment=NODE_OPTIONS NODE_PATH ELECTRON_RUN_AS_NODE LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_PROFILE GLIBC_TUNABLES ELECTRON_ENABLE_LOGGING ELECTRON_ENABLE_STACK_DUMPING PRIME_AGENT_DATA_DIR PRIME_CONTINUIM_PACKAGE_SMOKE PRIME_AGENT_BUILD_ID PRIME_AGENT_LAUNCHER_PATH',
  'ExecStart=%h/.local/lib/prime-continuim/remote-host/v1/prime-continuim-hostd-service',
  'Restart=on-failure',
  'RestartSec=5s',
  'TimeoutStopSec=45s',
  'UMask=0077',
  'NoNewPrivileges=true',
  'RestrictSUIDSGID=true',
  'StandardInput=null',
  'StandardOutput=journal',
  'StandardError=journal',
  '',
  '[Install]',
  'WantedBy=default.target',
].join('\n')}\n`

const TEMPLATE_ARTIFACTS = deepFreeze({
  launcher: {
    role: 'launcher',
    sha256: sha256(Buffer.from(LAUNCHER_TEMPLATE, 'utf8')),
    bytes: Buffer.byteLength(LAUNCHER_TEMPLATE, 'utf8'),
  },
  service: {
    role: 'service',
    sha256: sha256(Buffer.from(SERVICE_TEMPLATE, 'utf8')),
    bytes: Buffer.byteLength(SERVICE_TEMPLATE, 'utf8'),
  },
})

const INPUTS = deepFreeze({
  schema: REMOTE_HOST_PAYLOAD_INPUTS_SCHEMA,
  packageId: REMOTE_HOST_PAYLOAD_PACKAGE_ID,
  hostdVersion: REMOTE_HOST_PAYLOAD_HOSTD_VERSION,
  protocolVersion: REMOTE_HOST_PAYLOAD_PROTOCOL_VERSION,
  target: REMOTE_HOST_KIT_TARGET,
  runtimeIdentity: REMOTE_HOST_KIT_RUNTIME_IDENTITY,
  primeAgent: REMOTE_HOST_PAYLOAD_PRIME_AGENT,
  electron: REMOTE_HOST_ELECTRON_PROVENANCE,
  destinations: REMOTE_HOST_PAYLOAD_DESTINATIONS,
  claims: CLAIMS,
  assemblyAuthority: null,
})

export class RemoteHostPayloadContractError extends Error {
  constructor(code = 'remote_host_payload_contract_invalid', message = code) {
    super(message)
    this.name = 'RemoteHostPayloadContractError'
    this.code = code
  }
}

export function createRemoteHostPayloadInputs() {
  return INPUTS
}

export function validateRemoteHostPayloadInputs(input) {
  const value = snapshotPlainData(input, 'payload_inputs_shape_invalid')
  exactObject(value, INPUT_KEYS, 'payload_inputs_shape_invalid')
  exactValue(value.schema, REMOTE_HOST_PAYLOAD_INPUTS_SCHEMA, 'payload_inputs_schema_unsupported')
  validateFixedInputs(value)
  return deepFreeze(value)
}

export function serializeRemoteHostPayloadInputs(input) {
  const value = validateRemoteHostPayloadInputs(input)
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8')
  if (bytes.byteLength > REMOTE_HOST_PAYLOAD_MAX_INPUT_BYTES) fail('payload_inputs_oversize')
  return bytes
}

export function parseRemoteHostPayloadInputsBytes(input) {
  return parseCanonicalDocument(
    input,
    REMOTE_HOST_PAYLOAD_MAX_INPUT_BYTES,
    'payload_inputs',
    validateRemoteHostPayloadInputs,
  )
}

export function getRemoteHostPayloadTemplateBytes() {
  return Object.freeze({
    launcher: Buffer.from(LAUNCHER_TEMPLATE, 'utf8'),
    service: Buffer.from(SERVICE_TEMPLATE, 'utf8'),
  })
}

export function createRemoteHostPayloadLayout(input) {
  const construction = snapshotPlainData(input, 'payload_layout_construction_shape_invalid')
  exactObject(construction, LAYOUT_CONSTRUCTION_KEYS, 'payload_layout_construction_shape_invalid')
  const payloadTree = validatePayloadTreeConstruction(construction.payloadTree)
  const artifacts = snapshotPlainData(construction.externalArtifacts, 'external_artifacts_shape_invalid')
  exactObject(artifacts, EXTERNAL_ARTIFACT_ROLES, 'external_artifacts_shape_invalid')
  const externalArtifacts = {}
  for (const role of EXTERNAL_ARTIFACT_ROLES) {
    const artifact = validateArtifact(artifacts[role], role, 'external_artifact')
    const destination = REMOTE_HOST_PAYLOAD_DESTINATIONS[role]
    externalArtifacts[role] = {
      ...artifact,
      destination: destination.path,
      mode: destination.mode,
    }
  }
  requireTemplateParity(externalArtifacts)
  requireDistinctDigests(Object.values(externalArtifacts).map((artifact) => artifact.sha256))
  return validateRemoteHostPayloadLayout({
    schema: REMOTE_HOST_PAYLOAD_LAYOUT_SCHEMA,
    packageId: INPUTS.packageId,
    hostdVersion: INPUTS.hostdVersion,
    protocolVersion: INPUTS.protocolVersion,
    target: INPUTS.target,
    runtimeIdentity: INPUTS.runtimeIdentity,
    primeAgent: INPUTS.primeAgent,
    electron: INPUTS.electron,
    destinations: INPUTS.destinations,
    payloadTree: {
      definition: REMOTE_HOST_PAYLOAD_TREE_DEFINITION,
      order: 'utf8-bytewise',
      excludes: ['payload-layout.json'],
      ...payloadTree,
    },
    externalArtifacts,
    claims: CLAIMS,
    assemblyAuthority: null,
  })
}

export function validateRemoteHostPayloadLayout(input) {
  const value = snapshotPlainData(input, 'payload_layout_shape_invalid')
  exactObject(value, LAYOUT_KEYS, 'payload_layout_shape_invalid')
  exactValue(value.schema, REMOTE_HOST_PAYLOAD_LAYOUT_SCHEMA, 'payload_layout_schema_unsupported')
  validateFixedInputs(value)
  validatePayloadTree(value.payloadTree)
  exactObject(value.externalArtifacts, EXTERNAL_ARTIFACT_ROLES, 'external_artifacts_shape_invalid')
  const digests = []
  for (const role of EXTERNAL_ARTIFACT_ROLES) {
    const artifact = value.externalArtifacts[role]
    validateArtifact(artifact, role, 'external_artifact', EXTERNAL_ARTIFACT_KEYS)
    exactValue(artifact.destination, REMOTE_HOST_PAYLOAD_DESTINATIONS[role].path, 'artifact_destination_invalid')
    exactValue(artifact.mode, REMOTE_HOST_PAYLOAD_DESTINATIONS[role].mode, 'artifact_mode_invalid')
    digests.push(artifact.sha256)
  }
  requireTemplateParity(value.externalArtifacts)
  requireDistinctDigests(digests)
  return deepFreeze(value)
}

export function serializeRemoteHostPayloadLayout(input) {
  const value = validateRemoteHostPayloadLayout(input)
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8')
  if (bytes.byteLength > REMOTE_HOST_PAYLOAD_MAX_LAYOUT_BYTES) fail('payload_layout_oversize')
  return bytes
}

export function parseRemoteHostPayloadLayoutBytes(input) {
  return parseCanonicalDocument(
    input,
    REMOTE_HOST_PAYLOAD_MAX_LAYOUT_BYTES,
    'payload_layout',
    validateRemoteHostPayloadLayout,
  )
}

export function createRemoteHostPayloadKitReference(input) {
  const reference = snapshotPlainData(input, 'kit_reference_shape_invalid')
  exactObject(reference, KIT_REFERENCE_KEYS, 'kit_reference_shape_invalid')
  const inputs = validateRemoteHostPayloadInputs(reference.inputs)
  const layout = validateRemoteHostPayloadLayout(reference.layout)
  requireLayoutInputParity(layout, inputs)
  const artifacts = validateArtifacts(reference.artifacts)
  for (const role of EXTERNAL_ARTIFACT_ROLES) {
    exactValue(layout.externalArtifacts[role].sha256, artifacts[role].sha256, 'kit_layout_artifact_mismatch')
    exactValue(layout.externalArtifacts[role].bytes, artifacts[role].bytes, 'kit_layout_artifact_mismatch')
  }
  let manifest
  let manifestBytes
  let signaturePreimage
  try {
    manifest = validateRemoteHostKitManifest({
      schema: REMOTE_HOST_KIT_SCHEMA,
      packageId: inputs.packageId,
      hostdVersion: inputs.hostdVersion,
      protocolVersion: inputs.protocolVersion,
      target: inputs.target,
      runtimeIdentity: inputs.runtimeIdentity,
      artifacts,
      installAction: 'fresh_install',
      trustAnchorId: reference.trustAnchorId,
      signerKeyId: reference.signerKeyId,
      claims: KIT_CLAIMS,
    })
    manifestBytes = serializeRemoteHostKitManifest(manifest)
    signaturePreimage = createRemoteHostKitSignaturePreimage(manifest)
  } catch {
    fail('kit_reference_invalid')
  }
  return Object.freeze({
    manifest,
    manifestBytes,
    manifestSha256: sha256(manifestBytes),
    signaturePreimage,
    artifactBytesCorrelated: false,
    assemblyAuthority: null,
    signingAuthority: null,
  })
}

function validateFixedInputs(value) {
  exactValue(value.packageId, REMOTE_HOST_PAYLOAD_PACKAGE_ID, 'payload_package_id_invalid')
  exactValue(value.hostdVersion, REMOTE_HOST_PAYLOAD_HOSTD_VERSION, 'payload_hostd_version_invalid')
  exactValue(value.protocolVersion, REMOTE_HOST_PAYLOAD_PROTOCOL_VERSION, 'payload_protocol_version_invalid')
  requireCanonicalEqual(value.target, REMOTE_HOST_KIT_TARGET, 'payload_target_invalid')
  requireCanonicalEqual(value.runtimeIdentity, REMOTE_HOST_KIT_RUNTIME_IDENTITY, 'payload_runtime_identity_invalid')
  exactObject(value.primeAgent, PRIME_AGENT_KEYS, 'prime_agent_shape_invalid')
  requireCanonicalEqual(value.primeAgent, REMOTE_HOST_PAYLOAD_PRIME_AGENT, 'prime_agent_pin_invalid')
  validateElectronProvenance(value.electron)
  exactObject(value.destinations, ARTIFACT_ROLES, 'destinations_shape_invalid')
  for (const role of ARTIFACT_ROLES) {
    exactObject(value.destinations[role], DESTINATION_KEYS, 'destination_shape_invalid')
    requireCanonicalEqual(value.destinations[role], REMOTE_HOST_PAYLOAD_DESTINATIONS[role], 'destination_invalid')
  }
  validateClaims(value.claims)
  exactValue(value.assemblyAuthority, null, 'assembly_authority_forbidden')
}

function validateElectronProvenance(value) {
  exactObject(value, PROVENANCE_KEYS, 'electron_provenance_shape_invalid')
  exactObject(value.target, PROVENANCE_TARGET_KEYS, 'electron_provenance_target_invalid')
  exactObject(value.archive, ARCHIVE_KEYS, 'electron_archive_shape_invalid')
  exactObject(value.shasums, SHASUMS_KEYS, 'electron_shasums_shape_invalid')
  requireCanonicalEqual(value, REMOTE_HOST_ELECTRON_PROVENANCE, 'electron_provenance_pin_invalid')
}

function validatePayloadTreeConstruction(input) {
  const value = snapshotPlainData(input, 'payload_tree_shape_invalid')
  exactObject(value, PAYLOAD_TREE_CONSTRUCTION_KEYS, 'payload_tree_shape_invalid')
  requireSha256(value.sha256, 'payload_tree_digest_invalid')
  requireSafeInteger(value.fileCount, 1, 50_000, 'payload_tree_file_count_invalid')
  requireSafeInteger(value.totalBytes, 1, 2 * 1024 * 1024 * 1024 - 1, 'payload_tree_size_invalid')
  return value
}

function validatePayloadTree(value) {
  exactObject(value, PAYLOAD_TREE_KEYS, 'payload_tree_shape_invalid')
  exactValue(value.definition, REMOTE_HOST_PAYLOAD_TREE_DEFINITION, 'payload_tree_definition_invalid')
  exactValue(value.order, 'utf8-bytewise', 'payload_tree_order_invalid')
  if (!Array.isArray(value.excludes) || !isDeepStrictEqual(value.excludes, ['payload-layout.json'])) {
    fail('payload_tree_excludes_invalid')
  }
  validatePayloadTreeConstruction({
    sha256: value.sha256,
    fileCount: value.fileCount,
    totalBytes: value.totalBytes,
  })
}

function validateArtifacts(input) {
  const value = snapshotPlainData(input, 'artifacts_shape_invalid')
  exactObject(value, ARTIFACT_ROLES, 'artifacts_shape_invalid')
  const artifacts = {}
  for (const role of ARTIFACT_ROLES) artifacts[role] = validateArtifact(value[role], role, 'artifact')
  return artifacts
}

function validateArtifact(value, role, prefix, keys = ARTIFACT_KEYS) {
  exactObject(value, keys, `${prefix}_shape_invalid`)
  exactValue(value.role, role, `${prefix}_role_invalid`)
  requireSha256(value.sha256, `${prefix}_digest_invalid`)
  requireSafeInteger(value.bytes, 1, ARTIFACT_MAX_BYTES[role], `${prefix}_size_invalid`)
  return value
}

function requireTemplateParity(artifacts) {
  for (const role of ['launcher', 'service']) {
    exactValue(artifacts[role].sha256, TEMPLATE_ARTIFACTS[role].sha256, 'template_artifact_mismatch')
    exactValue(artifacts[role].bytes, TEMPLATE_ARTIFACTS[role].bytes, 'template_artifact_mismatch')
  }
}

function requireLayoutInputParity(layout, inputs) {
  for (const key of [
    'packageId',
    'hostdVersion',
    'protocolVersion',
    'target',
    'runtimeIdentity',
    'primeAgent',
    'electron',
    'destinations',
    'claims',
    'assemblyAuthority',
  ]) {
    requireCanonicalEqual(layout[key], inputs[key], 'kit_layout_inputs_mismatch')
  }
}

function validateClaims(value) {
  exactObject(value, REMOTE_HOST_PAYLOAD_CLAIM_KEYS, 'payload_claims_shape_invalid')
  for (const key of REMOTE_HOST_PAYLOAD_CLAIM_KEYS) exactValue(value[key], false, 'payload_claim_overstated')
}

function requireDistinctDigests(digests) {
  if (new Set(digests).size !== digests.length) fail('artifact_digests_not_distinct')
}

function parseCanonicalDocument(input, maximum, label, validate) {
  const bytes = boundedBytes(input, maximum, label)
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${label}_bom_forbidden`)
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail(`${label}_utf8_invalid`)
  }
  if (!text.endsWith('\n') || text.endsWith('\n\n') || text.includes('\r')) fail(`${label}_framing_invalid`)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    fail(`${label}_json_invalid`)
  }
  const value = validate(parsed)
  if (`${canonicalJson(value)}\n` !== text) fail(`${label}_not_canonical`)
  return value
}

function boundedBytes(input, maximum, label) {
  return copyBoundedUint8Array(input, {
    maximum,
    invalidCode: `${label}_bytes_shape_invalid`,
    belowMinimumCode: `${label}_empty`,
    aboveMaximumCode: `${label}_oversize`,
  })
}

function copyBoundedUint8Array(input, options) {
  if (utilTypes.isProxy(input) || !utilTypes.isUint8Array(input)) fail(options.invalidCode)
  let buffer
  let byteOffset
  let byteLength
  try {
    buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, input, [])
    byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET_GETTER, input, [])
    byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, input, [])
  } catch {
    fail(options.invalidCode)
  }
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || !Number.isSafeInteger(byteLength)) {
    fail(options.invalidCode)
  }
  if (byteLength < 1) fail(options.belowMinimumCode)
  if (byteLength > options.maximum) fail(options.aboveMaximumCode)
  try {
    return Buffer.from(new Uint8Array(buffer, byteOffset, byteLength))
  } catch {
    fail(options.invalidCode)
  }
}

function snapshotPlainData(value, code) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.normalize('NFC') !== value) fail(code)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail(code)
    return value
  }
  if (value === undefined || utilTypes.isProxy(value) || typeof value !== 'object') fail(code)
  let prototype
  let keys
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    fail(code)
  }
  if (keys.some((key) => typeof key !== 'string')) fail(code)
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) fail(code)
    const expected = [...Array.from({ length: value.length }, (_, index) => String(index)), 'length']
    if (!isDeepStrictEqual(keys, expected)) fail(code)
    const copy = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail(code)
      copy.push(snapshotPlainData(descriptor.value, code))
    }
    return copy
  }
  if (prototype !== Object.prototype && prototype !== null) fail(code)
  const copy = Object.create(prototype === null ? null : Object.prototype)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail(code)
    Object.defineProperty(copy, key, {
      value: snapshotPlainData(descriptor.value, code),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return copy
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
  return Object.fromEntries(Object.keys(value).sort(compareUtf8).map((key) => {
    if (key.normalize('NFC') !== key) fail('canonical_string_invalid')
    return [key, canonicalize(value[key])]
  }))
}

function compareUtf8(left, right) {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))
}

function exactObject(value, keys, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code)
  let actual
  try {
    actual = Reflect.ownKeys(value)
  } catch {
    fail(code)
  }
  if (actual.some((key) => typeof key !== 'string')) fail(code)
  if (!isDeepStrictEqual([...actual].sort(compareUtf8), [...keys].sort(compareUtf8))) fail(code)
}

function requireCanonicalEqual(actual, expected, code) {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(code)
}

function exactValue(actual, expected, code) {
  if (!Object.is(actual, expected)) fail(code)
}

function requireSha256(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code)
}

function requireSafeInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function fail(code) {
  throw new RemoteHostPayloadContractError(code)
}
