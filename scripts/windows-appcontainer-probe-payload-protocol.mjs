import { createHash } from 'node:crypto'
import { win32 } from 'node:path'

import { APPCONTAINER_PROBE_GATE_SPECS } from './windows-appcontainer-probe-lib.mjs'

export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAGIC = 'PCAPM002'
export const APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_MAGIC = 'PCAPE002'
export const APPCONTAINER_PROBE_PAYLOAD_PROTOCOL_VERSION = 2

export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAX_BYTES = 32 * 1024
export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_HEADER_BYTES = 160
export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_OFFSET = 160
export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_ENTRY_BYTES = 16
export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_COUNT = 18
export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET = 448

export const APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_BYTES = 192
export const APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_HEADER_BYTES = 128
export const APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_OFFSET = 128
export const APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_BYTES = 32
export const APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET = 160

export const APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS = Object.freeze({
  binarySid: 1,
  emptyUtf16leEnvironment: 2,
  utf16leNullTerminated: 3,
  uint32LittleEndian: 4,
  handleAndRandom: 5,
  sockaddrIn: 6,
})

export const APPCONTAINER_PROBE_PAYLOAD_OBSERVATION_CODES = Object.freeze({
  not_attempted: 0,
  present: 1,
  allowed: 2,
  denied: 3,
  mismatched: 4,
  unknown: 5,
})

export const APPCONTAINER_PROBE_PAYLOAD_RESULT_CODES = Object.freeze({
  complete_match: 0,
  complete_nonmatch: 1,
  incomplete_internal: 2,
})

export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_FILENAME =
  'PrimeContinuim.AppContainerProbe.PCAPM002.bin'
export const APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_FILENAME_PREFIX =
  'PrimeContinuim.AppContainerProbe.PCAPE002.'
// This is a denial sentinel only. It is never an evidence transport.
export const APPCONTAINER_PROBE_PAYLOAD_PARENT_NAMED_PIPE_SENTINEL_PREFIX =
  String.raw`\\.\pipe\LOCAL\PrimeContinuim.AppContainerProbe.DenialSentinel.v2.`

export const APPCONTAINER_PROBE_PAYLOAD_NETWORK_SENTINELS = deepFreeze([
  { id: 'loopback_network_sentinel', address: '127.0.0.1', port: 9 },
  { id: 'lan_network_sentinel', address: '192.168.0.1', port: 9 },
  { id: 'internet_network_sentinel', address: '192.0.2.1', port: 9 },
])

const SUPERVISOR_ONLY_GATES = new Set([
  'job_membership_at_process_creation',
  'launch_handle_inheritance_disabled',
  'no_writable_executable_closure',
])

export const APPCONTAINER_PROBE_CHILD_GATE_SPECS = deepFreeze(
  APPCONTAINER_PROBE_GATE_SPECS
    .filter(({ id }) => !SUPERVISOR_ONLY_GATES.has(id))
    .map(({ id, expected }) => ({ id, expected })),
)

assertChildGateContract()

export const APPCONTAINER_PROBE_CHILD_GATE_CONTRACT_SHA256 = sha256Hex(
  Buffer.from(JSON.stringify(APPCONTAINER_PROBE_CHILD_GATE_SPECS), 'utf8'),
)

export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_SPECS = deepFreeze([
  recordSpec(1, 'package_sid', 'binarySid'),
  recordSpec(2, 'environment', 'emptyUtf16leEnvironment'),
  recordSpec(3, 'profile_path', 'utf16leNullTerminated'),
  recordSpec(4, 'scratch_root_path', 'utf16leNullTerminated'),
  recordSpec(5, 'main_workspace_sentinel_path', 'utf16leNullTerminated'),
  recordSpec(6, 'user_profile_sentinel_path', 'utf16leNullTerminated'),
  recordSpec(7, 'credential_store_sentinel_path', 'utf16leNullTerminated'),
  recordSpec(8, 'runtime_sentinel_path', 'utf16leNullTerminated'),
  recordSpec(9, 'out_sentinel_path', 'utf16leNullTerminated'),
  recordSpec(10, 'release_sentinel_path', 'utf16leNullTerminated'),
  recordSpec(11, 'programdata_sentinel_path', 'utf16leNullTerminated'),
  recordSpec(12, 'sibling_temp_sentinel_path', 'utf16leNullTerminated'),
  recordSpec(13, 'parent_named_pipe_sentinel', 'utf16leNullTerminated'),
  recordSpec(14, 'parent_process_sentinel', 'uint32LittleEndian'),
  recordSpec(15, 'inherited_handle_sentinel', 'handleAndRandom'),
  recordSpec(16, 'loopback_network_sentinel', 'sockaddrIn'),
  recordSpec(17, 'lan_network_sentinel', 'sockaddrIn'),
  recordSpec(18, 'internet_network_sentinel', 'sockaddrIn'),
])

const MANIFEST_MAGIC_BYTES = Buffer.from(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAGIC, 'ascii')
const EVIDENCE_MAGIC_BYTES = Buffer.from(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_MAGIC, 'ascii')
const CHILD_GATE_CONTRACT_DIGEST = Buffer.from(APPCONTAINER_PROBE_CHILD_GATE_CONTRACT_SHA256, 'hex')
const EMPTY_ENVIRONMENT = Buffer.alloc(4)
const FIXED_SOCKADDR_BYTES = APPCONTAINER_PROBE_PAYLOAD_NETWORK_SENTINELS.map(encodeSockaddrIn)
const OBSERVATION_CODE_TO_VALUE = new Map(
  Object.entries(APPCONTAINER_PROBE_PAYLOAD_OBSERVATION_CODES).map(([observed, code]) => [code, observed]),
)
const RESULT_CODE_TO_VALUE = new Map(
  Object.entries(APPCONTAINER_PROBE_PAYLOAD_RESULT_CODES).map(([result, code]) => [code, result]),
)

const MANIFEST_INPUT_KEYS = [
  'correlationId',
  'payloadSha256',
  'payloadBytes',
  'packageSid',
  'profilePath',
  'scratchRoot',
  'controlledFileSentinelPaths',
  'parentProcessId',
  'inheritedHandleSentinel',
]
const SENTINEL_PATH_KEYS = [
  'mainWorkspace',
  'userProfile',
  'credentialStore',
  'runtime',
  'out',
  'release',
  'programData',
  'siblingTemp',
]
const HANDLE_SENTINEL_KEYS = ['handle', 'random']
const MANIFEST_EXPECTATION_KEYS = ['correlationId', 'payloadSha256', 'payloadBytes']
const EVIDENCE_INPUT_KEYS = [
  'correlationId',
  'manifestSha256',
  'manifestBytes',
  'payloadSha256',
  'payloadBytes',
  'result',
  'observations',
]
const EVIDENCE_EXPECTATION_KEYS = [
  'correlationId',
  'manifestSha256',
  'manifestBytes',
  'payloadSha256',
  'payloadBytes',
]
const SHA256 = /^[a-f0-9]{64}$/u
const CORRELATION_ID = /^[a-f0-9]{32}$/u
const UINT32_MAX = 0xffff_ffff
const CONCRETE_HANDLE_MAX = 0x7fff_ffff_ffff_ffffn
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024
const OBSERVATION_SET = new Set(Object.keys(APPCONTAINER_PROBE_PAYLOAD_OBSERVATION_CODES))
const RESULT_SET = new Set(Object.keys(APPCONTAINER_PROBE_PAYLOAD_RESULT_CODES))

export class AppContainerProbePayloadProtocolError extends Error {
  constructor(code = 'payload_protocol_invalid') {
    super(code)
    this.name = 'AppContainerProbePayloadProtocolError'
    this.code = code
  }
}

// The payload finds the manifest by this fixed sibling name relative to its own
// executable. Evidence uses one correlation-bound CREATE_NEW leaf under the
// manifest's scratch root; neither channel needs argv, environment, or an
// inherited handle.
export function deriveAppContainerProbePayloadEvidenceFilename(correlationId) {
  validateCorrelationId(correlationId, 'evidence_filename_invalid')
  return `${APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_FILENAME_PREFIX}${correlationId}.bin`
}

export function deriveAppContainerProbePayloadEvidencePath(scratchRoot, correlationId) {
  validateCanonicalWindowsPath(scratchRoot)
  const evidencePath = win32.join(
    scratchRoot,
    deriveAppContainerProbePayloadEvidenceFilename(correlationId),
  )
  validateCanonicalWindowsPath(evidencePath)
  return evidencePath
}

export function deriveAppContainerProbePayloadParentNamedPipeSentinel(correlationId) {
  validateCorrelationId(correlationId, 'manifest_pipe_invalid')
  return `${APPCONTAINER_PROBE_PAYLOAD_PARENT_NAMED_PIPE_SENTINEL_PREFIX}${correlationId}`
}

export function createAppContainerProbePayloadManifest(input) {
  const manifestInput = validateManifestInput(input)

  const sentinelPaths = manifestInput.controlledFileSentinelPaths
  const records = [
    encodePackageSid(manifestInput.packageSid),
    EMPTY_ENVIRONMENT,
    encodeUtf16leNullTerminated(manifestInput.profilePath),
    encodeUtf16leNullTerminated(manifestInput.scratchRoot),
    ...SENTINEL_PATH_KEYS.map((key) => encodeUtf16leNullTerminated(sentinelPaths[key])),
    encodeUtf16leNullTerminated(deriveAppContainerProbePayloadParentNamedPipeSentinel(manifestInput.correlationId)),
    encodeUint32(manifestInput.parentProcessId),
    encodeHandleSentinel(manifestInput.inheritedHandleSentinel),
    ...FIXED_SOCKADDR_BYTES,
  ]

  const placements = []
  let cursor = APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET
  for (const record of records) {
    cursor = align8(cursor)
    placements.push({ offset: cursor, bytes: record.byteLength })
    cursor += record.byteLength
  }
  if (cursor > APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAX_BYTES) fail('manifest_oversize')

  const manifest = Buffer.alloc(cursor)
  MANIFEST_MAGIC_BYTES.copy(manifest, 0)
  manifest.writeUInt16LE(APPCONTAINER_PROBE_PAYLOAD_PROTOCOL_VERSION, 0x08)
  manifest.writeUInt16LE(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_HEADER_BYTES, 0x0a)
  manifest.writeUInt32LE(cursor, 0x0c)
  manifest.writeUInt32LE(0, 0x10)
  manifest.writeUInt32LE(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_COUNT, 0x14)
  correlationBytes(manifestInput.correlationId).copy(manifest, 0x18)
  digestBytes(manifestInput.payloadSha256).copy(manifest, 0x28)
  manifest.writeBigUInt64LE(BigInt(manifestInput.payloadBytes), 0x48)
  CHILD_GATE_CONTRACT_DIGEST.copy(manifest, 0x50)
  manifest.writeUInt32LE(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_OFFSET, 0x70)
  manifest.writeUInt32LE(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_ENTRY_BYTES, 0x74)
  manifest.writeUInt32LE(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET, 0x78)
  manifest.writeUInt32LE(cursor - APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET, 0x7c)

  for (let index = 0; index < APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_COUNT; index += 1) {
    const spec = APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_SPECS[index]
    const placement = placements[index]
    const record = records[index]
    if (spec === undefined || placement === undefined || record === undefined) fail('manifest_input_invalid')
    const tableOffset = APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_OFFSET
      + index * APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_ENTRY_BYTES
    manifest.writeUInt16LE(spec.type, tableOffset)
    manifest.writeUInt16LE(spec.encoding, tableOffset + 2)
    manifest.writeUInt32LE(placement.offset, tableOffset + 4)
    manifest.writeUInt32LE(placement.bytes, tableOffset + 8)
    manifest.writeUInt32LE(0, tableOffset + 12)
    record.copy(manifest, placement.offset)
  }

  validateAppContainerProbePayloadManifest(manifest, {
    correlationId: manifestInput.correlationId,
    payloadSha256: manifestInput.payloadSha256,
    payloadBytes: manifestInput.payloadBytes,
  })
  return manifest
}

export function validateAppContainerProbePayloadManifest(input, expected) {
  const manifest = snapshotBytes(input, 'manifest_invalid')
  const expectation = expected === undefined ? undefined : validateManifestExpectation(expected)
  if (
    manifest.byteLength < APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET
    || manifest.byteLength > APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAX_BYTES
  ) fail(manifest.byteLength > APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAX_BYTES ? 'manifest_oversize' : 'manifest_invalid')

  requireBytes(manifest, 0x00, MANIFEST_MAGIC_BYTES, 'manifest_invalid')
  exactInteger(readU16(manifest, 0x08), APPCONTAINER_PROBE_PAYLOAD_PROTOCOL_VERSION, 'manifest_invalid')
  exactInteger(readU16(manifest, 0x0a), APPCONTAINER_PROBE_PAYLOAD_MANIFEST_HEADER_BYTES, 'manifest_invalid')
  exactInteger(readU32(manifest, 0x0c), manifest.byteLength, 'manifest_invalid')
  exactInteger(readU32(manifest, 0x10), 0, 'manifest_invalid')
  exactInteger(readU32(manifest, 0x14), APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_COUNT, 'manifest_invalid')

  const correlationId = manifest.subarray(0x18, 0x28).toString('hex')
  const payloadSha256 = manifest.subarray(0x28, 0x48).toString('hex')
  validateCorrelationId(correlationId, 'manifest_invalid')
  validateSha256(payloadSha256, 'manifest_invalid')
  const payloadBytesBigInt = readU64(manifest, 0x48)
  if (payloadBytesBigInt < 1n || payloadBytesBigInt > BigInt(MAX_PAYLOAD_BYTES)) fail('manifest_invalid')
  const payloadBytes = Number(payloadBytesBigInt)
  requireBytes(manifest, 0x50, CHILD_GATE_CONTRACT_DIGEST, 'manifest_gate_contract_mismatch')
  exactInteger(readU32(manifest, 0x70), APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_OFFSET, 'manifest_invalid')
  exactInteger(readU32(manifest, 0x74), APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_ENTRY_BYTES, 'manifest_invalid')
  exactInteger(readU32(manifest, 0x78), APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET, 'manifest_invalid')
  exactInteger(
    readU32(manifest, 0x7c),
    manifest.byteLength - APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET,
    'manifest_invalid',
  )
  requireZero(manifest, 0x80, APPCONTAINER_PROBE_PAYLOAD_MANIFEST_HEADER_BYTES, 'manifest_reserved_nonzero')

  const decoded = Object.create(null)
  let cursor = APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET
  for (let index = 0; index < APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_COUNT; index += 1) {
    const spec = APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_SPECS[index]
    if (spec === undefined) fail('manifest_invalid')
    const tableOffset = APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_OFFSET
      + index * APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_ENTRY_BYTES
    exactInteger(readU16(manifest, tableOffset), spec.type, 'manifest_record_order_invalid')
    exactInteger(readU16(manifest, tableOffset + 2), spec.encoding, 'manifest_record_encoding_invalid')
    const recordOffset = readU32(manifest, tableOffset + 4)
    const recordBytes = readU32(manifest, tableOffset + 8)
    exactInteger(readU32(manifest, tableOffset + 12), 0, 'manifest_reserved_nonzero')

    const canonicalOffset = align8(cursor)
    exactInteger(recordOffset, canonicalOffset, 'manifest_record_layout_invalid')
    if (recordBytes < 1 || recordOffset > manifest.byteLength || recordBytes > manifest.byteLength - recordOffset) {
      fail('manifest_record_layout_invalid')
    }
    requireZero(manifest, cursor, recordOffset, 'manifest_padding_nonzero')
    const record = manifest.subarray(recordOffset, recordOffset + recordBytes)
    decoded[spec.name] = validateRecord(spec, record, correlationId)
    cursor = recordOffset + recordBytes
  }
  exactInteger(cursor, manifest.byteLength, 'manifest_extension_forbidden')
  validateDecodedRecordRelationships(decoded, correlationId)

  if (expectation !== undefined) {
    if (
      correlationId !== expectation.correlationId
      || payloadSha256 !== expectation.payloadSha256
      || payloadBytes !== expectation.payloadBytes
    ) fail('manifest_cross_feed')
  }

  return deepFreeze({
    schemaVersion: APPCONTAINER_PROBE_PAYLOAD_PROTOCOL_VERSION,
    kind: 'prime_continuim_appcontainer_probe_payload_manifest_v2',
    sha256: sha256Hex(manifest),
    bytes: manifest.byteLength,
    correlationId,
    payloadSha256,
    payloadBytes,
    childGateContractSha256: APPCONTAINER_PROBE_CHILD_GATE_CONTRACT_SHA256,
    recordCount: APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_COUNT,
  })
}

export function createAppContainerProbePayloadEvidence(input) {
  const evidenceInput = validateEvidenceInput(input)
  const expectedResult = coherentResult(evidenceInput.observations)
  if (evidenceInput.result !== expectedResult) fail('evidence_result_mismatch')

  const evidence = Buffer.alloc(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_BYTES)
  EVIDENCE_MAGIC_BYTES.copy(evidence, 0x00)
  evidence.writeUInt16LE(APPCONTAINER_PROBE_PAYLOAD_PROTOCOL_VERSION, 0x08)
  evidence.writeUInt16LE(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_HEADER_BYTES, 0x0a)
  evidence.writeUInt32LE(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_BYTES, 0x0c)
  evidence.writeUInt32LE(0, 0x10)
  evidence.writeUInt32LE(APPCONTAINER_PROBE_CHILD_GATE_SPECS.length, 0x14)
  correlationBytes(evidenceInput.correlationId).copy(evidence, 0x18)
  digestBytes(evidenceInput.manifestSha256).copy(evidence, 0x28)
  digestBytes(evidenceInput.payloadSha256).copy(evidence, 0x48)
  evidence.writeBigUInt64LE(BigInt(evidenceInput.payloadBytes), 0x68)
  evidence.writeUInt32LE(evidenceInput.manifestBytes, 0x70)
  evidence.writeUInt32LE(APPCONTAINER_PROBE_PAYLOAD_RESULT_CODES[evidenceInput.result], 0x74)
  evidence.writeUInt32LE(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_OFFSET, 0x78)
  evidence.writeUInt32LE(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_BYTES, 0x7c)
  for (const [index, observation] of evidenceInput.observations.entries()) {
    evidence[APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_OFFSET + index] =
      APPCONTAINER_PROBE_PAYLOAD_OBSERVATION_CODES[observation]
  }
  sha256Buffer(evidence.subarray(0, APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET))
    .copy(evidence, APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET)

  validateAppContainerProbePayloadEvidence(evidence, {
    correlationId: evidenceInput.correlationId,
    manifestSha256: evidenceInput.manifestSha256,
    manifestBytes: evidenceInput.manifestBytes,
    payloadSha256: evidenceInput.payloadSha256,
    payloadBytes: evidenceInput.payloadBytes,
  })
  return evidence
}

export function validateAppContainerProbePayloadEvidence(input, expected) {
  const expectation = validateEvidenceExpectation(expected)
  const evidence = snapshotBytes(input, 'evidence_invalid')
  exactInteger(evidence.byteLength, APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_BYTES, 'evidence_size_invalid')

  requireBytes(evidence, 0x00, EVIDENCE_MAGIC_BYTES, 'evidence_invalid')
  exactInteger(readU16(evidence, 0x08), APPCONTAINER_PROBE_PAYLOAD_PROTOCOL_VERSION, 'evidence_invalid')
  exactInteger(readU16(evidence, 0x0a), APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_HEADER_BYTES, 'evidence_invalid')
  exactInteger(readU32(evidence, 0x0c), APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_BYTES, 'evidence_invalid')
  exactInteger(readU32(evidence, 0x10), 0, 'evidence_reserved_nonzero')
  exactInteger(readU32(evidence, 0x14), APPCONTAINER_PROBE_CHILD_GATE_SPECS.length, 'evidence_invalid')

  const correlationId = evidence.subarray(0x18, 0x28).toString('hex')
  const manifestSha256 = evidence.subarray(0x28, 0x48).toString('hex')
  const payloadSha256 = evidence.subarray(0x48, 0x68).toString('hex')
  validateCorrelationId(correlationId, 'evidence_invalid')
  validateSha256(manifestSha256, 'evidence_invalid')
  validateSha256(payloadSha256, 'evidence_invalid')
  const payloadBytesBigInt = readU64(evidence, 0x68)
  if (payloadBytesBigInt < 1n || payloadBytesBigInt > BigInt(MAX_PAYLOAD_BYTES)) fail('evidence_invalid')
  const payloadBytes = Number(payloadBytesBigInt)
  const manifestBytes = readU32(evidence, 0x70)
  if (
    manifestBytes < APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET
    || manifestBytes > APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAX_BYTES
  ) fail('evidence_invalid')

  const result = evidenceResult(readU32(evidence, 0x74), 'evidence_invalid')
  exactInteger(readU32(evidence, 0x78), APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_OFFSET, 'evidence_invalid')
  exactInteger(readU32(evidence, 0x7c), APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_BYTES, 'evidence_invalid')

  const observations = []
  for (let index = 0; index < APPCONTAINER_PROBE_CHILD_GATE_SPECS.length; index += 1) {
    observations.push(observationValue(evidence[APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_OFFSET + index], 'evidence_invalid'))
  }
  exactInteger(evidence[APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET - 1], 0, 'evidence_padding_nonzero')
  const calculatedDigest = sha256Buffer(evidence.subarray(0, APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET))
  requireBytes(evidence, APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET, calculatedDigest, 'evidence_digest_mismatch')
  if (result !== coherentResult(observations)) fail('evidence_result_mismatch')

  if (
    correlationId !== expectation.correlationId
    || manifestSha256 !== expectation.manifestSha256
    || manifestBytes !== expectation.manifestBytes
    || payloadSha256 !== expectation.payloadSha256
    || payloadBytes !== expectation.payloadBytes
  ) fail('evidence_cross_feed')

  return deepFreeze({
    schemaVersion: APPCONTAINER_PROBE_PAYLOAD_PROTOCOL_VERSION,
    kind: 'prime_continuim_appcontainer_probe_payload_evidence_v2',
    sha256: sha256Hex(evidence),
    bytes: evidence.byteLength,
    correlationId,
    manifestSha256,
    manifestBytes,
    payloadSha256,
    payloadBytes,
    result,
    gates: APPCONTAINER_PROBE_CHILD_GATE_SPECS.map((spec, index) => ({
      id: spec.id,
      expected: spec.expected,
      observed: observations[index],
    })),
  })
}

function validateManifestInput(input) {
  const topLevel = snapshotPlainObject(input, MANIFEST_INPUT_KEYS, 'manifest_input_invalid')
  const controlledFileSentinelPaths = snapshotPlainObject(
    topLevel.controlledFileSentinelPaths,
    SENTINEL_PATH_KEYS,
    'manifest_input_invalid',
  )
  const inheritedHandleFields = snapshotPlainObject(
    topLevel.inheritedHandleSentinel,
    HANDLE_SENTINEL_KEYS,
    'manifest_input_invalid',
  )
  const inheritedHandleSentinel = {
    handle: inheritedHandleFields.handle,
    random: snapshotBytes(inheritedHandleFields.random, 'manifest_input_invalid'),
  }
  const snapshot = {
    ...topLevel,
    controlledFileSentinelPaths,
    inheritedHandleSentinel,
  }

  validateCorrelationId(snapshot.correlationId, 'manifest_input_invalid')
  validateSha256(snapshot.payloadSha256, 'manifest_input_invalid')
  boundedInteger(snapshot.payloadBytes, 1, MAX_PAYLOAD_BYTES, 'manifest_input_invalid')
  validatePackageSid(snapshot.packageSid)
  validateCanonicalWindowsPath(snapshot.profilePath)
  validateCanonicalWindowsPath(snapshot.scratchRoot)
  deriveAppContainerProbePayloadEvidencePath(snapshot.scratchRoot, snapshot.correlationId)
  for (const key of SENTINEL_PATH_KEYS) validateCanonicalWindowsPath(controlledFileSentinelPaths[key])
  const paths = [
    snapshot.profilePath,
    snapshot.scratchRoot,
    ...SENTINEL_PATH_KEYS.map((key) => controlledFileSentinelPaths[key]),
  ]
  if (pathsOverlap(paths)) fail('manifest_input_invalid')
  boundedInteger(snapshot.parentProcessId, 1, UINT32_MAX, 'manifest_input_invalid')
  if (
    typeof inheritedHandleSentinel.handle !== 'bigint'
    || inheritedHandleSentinel.handle < 1n
    || inheritedHandleSentinel.handle > CONCRETE_HANDLE_MAX
  ) fail('manifest_input_invalid')
  if (inheritedHandleSentinel.random.byteLength !== 32 || isAllZero(inheritedHandleSentinel.random)) {
    fail('manifest_input_invalid')
  }
  return snapshot
}

function validateManifestExpectation(expected) {
  const snapshot = snapshotPlainObject(expected, MANIFEST_EXPECTATION_KEYS, 'manifest_expectation_invalid')
  validateCorrelationId(snapshot.correlationId, 'manifest_expectation_invalid')
  validateSha256(snapshot.payloadSha256, 'manifest_expectation_invalid')
  boundedInteger(snapshot.payloadBytes, 1, MAX_PAYLOAD_BYTES, 'manifest_expectation_invalid')
  return snapshot
}

function validateEvidenceInput(input) {
  const topLevel = snapshotPlainObject(input, EVIDENCE_INPUT_KEYS, 'evidence_input_invalid')
  const snapshot = {
    ...topLevel,
    observations: snapshotObservationArray(topLevel.observations, 'evidence_input_invalid'),
  }
  validateEvidenceBindingFields(snapshot, 'evidence_input_invalid')
  if (!RESULT_SET.has(snapshot.result)) fail('evidence_input_invalid')
  return snapshot
}

function validateEvidenceExpectation(expected) {
  const snapshot = snapshotPlainObject(expected, EVIDENCE_EXPECTATION_KEYS, 'evidence_expectation_invalid')
  validateEvidenceBindingFields(snapshot, 'evidence_expectation_invalid')
  return snapshot
}

function validateEvidenceBindingFields(expected, code) {
  validateCorrelationId(expected.correlationId, code)
  validateSha256(expected.manifestSha256, code)
  boundedInteger(
    expected.manifestBytes,
    APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET,
    APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAX_BYTES,
    code,
  )
  validateSha256(expected.payloadSha256, code)
  boundedInteger(expected.payloadBytes, 1, MAX_PAYLOAD_BYTES, code)
}

function snapshotObservationArray(value, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code)
  const expectedLength = APPCONTAINER_PROBE_CHILD_GATE_SPECS.length
  const keys = Reflect.ownKeys(value)
  const expectedKeys = [...Array.from({ length: expectedLength }, (_, index) => String(index)), 'length']
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) fail(code)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (
    lengthDescriptor === undefined
    || lengthDescriptor.enumerable
    || !('value' in lengthDescriptor)
    || lengthDescriptor.value !== expectedLength
  ) fail(code)
  const snapshot = []
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail(code)
    snapshot.push(descriptor.value)
  }
  for (const observation of snapshot) if (!OBSERVATION_SET.has(observation)) fail(code)
  return snapshot
}

function validateRecord(spec, record, correlationId) {
  switch (spec.name) {
    case 'package_sid': {
      return validateBinaryPackageSid(record)
    }
    case 'environment':
      requireBytes(record, 0, EMPTY_ENVIRONMENT, 'manifest_environment_invalid')
      exactInteger(record.byteLength, EMPTY_ENVIRONMENT.byteLength, 'manifest_environment_invalid')
      return null
    case 'profile_path':
    case 'scratch_root_path':
    case 'main_workspace_sentinel_path':
    case 'user_profile_sentinel_path':
    case 'credential_store_sentinel_path':
    case 'runtime_sentinel_path':
    case 'out_sentinel_path':
    case 'release_sentinel_path':
    case 'programdata_sentinel_path':
    case 'sibling_temp_sentinel_path': {
      const path = decodeUtf16leNullTerminated(record, 'manifest_path_invalid')
      validateCanonicalWindowsPath(path)
      return path
    }
    case 'parent_named_pipe_sentinel': {
      const expectedPipe = deriveAppContainerProbePayloadParentNamedPipeSentinel(correlationId)
      const actualPipe = decodeUtf16leNullTerminated(record, 'manifest_pipe_invalid')
      if (actualPipe !== expectedPipe) fail('manifest_pipe_invalid')
      return true
    }
    case 'parent_process_sentinel': {
      exactInteger(record.byteLength, 4, 'manifest_record_invalid')
      const processId = readU32(record, 0)
      boundedInteger(processId, 1, UINT32_MAX, 'manifest_record_invalid')
      return processId
    }
    case 'inherited_handle_sentinel': {
      exactInteger(record.byteLength, 40, 'manifest_record_invalid')
      const handle = readU64(record, 0)
      if (handle < 1n || handle > CONCRETE_HANDLE_MAX || isAllZero(record.subarray(8))) fail('manifest_record_invalid')
      return true
    }
    case 'loopback_network_sentinel':
    case 'lan_network_sentinel':
    case 'internet_network_sentinel': {
      const networkIndex = spec.type - 16
      const expected = FIXED_SOCKADDR_BYTES[networkIndex]
      if (expected === undefined) fail('manifest_record_invalid')
      requireBytes(record, 0, expected, 'manifest_sockaddr_invalid')
      exactInteger(record.byteLength, expected.byteLength, 'manifest_sockaddr_invalid')
      return true
    }
    default:
      fail('manifest_record_invalid')
  }
}

function validateDecodedRecordRelationships(decoded, correlationId) {
  const pathNames = [
    'profile_path',
    'scratch_root_path',
    'main_workspace_sentinel_path',
    'user_profile_sentinel_path',
    'credential_store_sentinel_path',
    'runtime_sentinel_path',
    'out_sentinel_path',
    'release_sentinel_path',
    'programdata_sentinel_path',
    'sibling_temp_sentinel_path',
  ]
  const paths = pathNames.map((name) => decoded[name])
  if (paths.some((path) => typeof path !== 'string') || pathsOverlap(paths)) {
    fail('manifest_path_invalid')
  }
  deriveAppContainerProbePayloadEvidencePath(decoded.scratch_root_path, correlationId)
}

function validateBinaryPackageSid(record) {
  if (record.byteLength !== 40 || record[0] !== 1 || record[1] !== 8) fail('manifest_sid_invalid')
  requireBytes(record, 2, Buffer.from([0, 0, 0, 0, 0, 15]), 'manifest_sid_invalid')
  exactInteger(readU32(record, 8), 2, 'manifest_sid_invalid')
  const subAuthorities = []
  for (let index = 1; index < 8; index += 1) subAuthorities.push(readU32(record, 8 + index * 4))
  return `S-1-15-2-${subAuthorities.join('-')}`
}

function validatePackageSid(value) {
  if (typeof value !== 'string' || !isWellFormedUnicode(value)) fail('manifest_sid_invalid')
  const pieces = value.split('-')
  if (pieces.length !== 11 || pieces[0] !== 'S' || pieces[1] !== '1' || pieces[2] !== '15' || pieces[3] !== '2') {
    fail('manifest_sid_invalid')
  }
  for (const piece of pieces.slice(4)) {
    if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(piece) || BigInt(piece) > BigInt(UINT32_MAX)) fail('manifest_sid_invalid')
  }
}

function encodePackageSid(value) {
  validatePackageSid(value)
  const pieces = value.split('-')
  const subAuthorities = [2, ...pieces.slice(4).map(Number)]
  const encoded = Buffer.alloc(8 + subAuthorities.length * 4)
  encoded[0] = 1
  encoded[1] = subAuthorities.length
  encoded[7] = 15
  for (const [index, subAuthority] of subAuthorities.entries()) encoded.writeUInt32LE(subAuthority, 8 + index * 4)
  return encoded
}

function pathsOverlap(paths) {
  const folded = paths.map(foldAsciiWindowsPath)
  for (let left = 0; left < folded.length; left += 1) {
    for (let right = left + 1; right < folded.length; right += 1) {
      const leftPath = folded[left]
      const rightPath = folded[right]
      if (
        leftPath === undefined
        || rightPath === undefined
        || leftPath === rightPath
        || leftPath.startsWith(`${rightPath}\\`)
        || rightPath.startsWith(`${leftPath}\\`)
      ) return true
    }
  }
  return false
}

function validateCanonicalWindowsPath(value) {
  if (
    typeof value !== 'string'
    || value.length < 4
    || value.length > 4096
    || !isWellFormedUnicode(value)
    || value.normalize('NFC') !== value
    || !/^[A-Z]:\\/u.test(value)
    || /[\u0000-\u001f/<>:"|?*]/u.test(value.slice(2))
    || value.endsWith('\\')
    || win32.normalize(value) !== value
  ) fail('manifest_path_invalid')
  const segments = value.slice(3).split('\\')
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..' || /[ .]$/u.test(segment))
    || segments.some((segment) => !/^[A-Za-z0-9 _.\-]+$/u.test(segment))
    || segments.some(isReservedWindowsSegment)
  ) fail('manifest_path_invalid')
}

function isReservedWindowsSegment(segment) {
  const basename = (segment.split('.')[0] ?? '').replace(/[ .]+$/u, '')
  return /^(?:CON|PRN|AUX|NUL|COM(?:[1-9]|\u00b9|\u00b2|\u00b3)|LPT(?:[1-9]|\u00b9|\u00b2|\u00b3))$/iu
    .test(basename)
}

function foldAsciiWindowsPath(value) {
  return value.replace(/[A-Z]/gu, (character) => String.fromCharCode(character.charCodeAt(0) + 0x20))
}

function encodeUtf16leNullTerminated(value) {
  if (!isWellFormedUnicode(value) || value.includes('\0')) fail('manifest_input_invalid')
  return Buffer.from(`${value}\0`, 'utf16le')
}

function decodeUtf16leNullTerminated(record, code) {
  if (record.byteLength < 4 || record.byteLength % 2 !== 0) fail(code)
  if (record[record.byteLength - 2] !== 0 || record[record.byteLength - 1] !== 0) fail(code)
  for (let offset = 0; offset < record.byteLength - 2; offset += 2) {
    if (record[offset] === 0 && record[offset + 1] === 0) fail(code)
  }
  const value = record.subarray(0, record.byteLength - 2).toString('utf16le')
  if (!isWellFormedUnicode(value) || !encodeUtf16leNullTerminated(value).equals(record)) fail(code)
  return value
}

function encodeUint32(value) {
  const encoded = Buffer.alloc(4)
  encoded.writeUInt32LE(value, 0)
  return encoded
}

function encodeHandleSentinel(value) {
  const encoded = Buffer.alloc(40)
  encoded.writeBigUInt64LE(value.handle, 0)
  value.random.copy(encoded, 8)
  return encoded
}

function encodeSockaddrIn(value) {
  const encoded = Buffer.alloc(16)
  encoded.writeUInt16LE(2, 0)
  encoded.writeUInt16BE(value.port, 2)
  const octets = value.address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    fail('payload_protocol_contract_invalid')
  }
  Buffer.from(octets).copy(encoded, 4)
  return encoded
}

function coherentResult(observations) {
  if (observations.includes('not_attempted') || observations.includes('unknown')) return 'incomplete_internal'
  const matches = observations.every((observed, index) => {
    const spec = APPCONTAINER_PROBE_CHILD_GATE_SPECS[index]
    return spec !== undefined && observed === spec.expected
  })
  return matches ? 'complete_match' : 'complete_nonmatch'
}

function observationValue(code, errorCode) {
  const observed = OBSERVATION_CODE_TO_VALUE.get(code)
  if (observed === undefined) fail(errorCode)
  return observed
}

function evidenceResult(code, errorCode) {
  const result = RESULT_CODE_TO_VALUE.get(code)
  if (result === undefined) fail(errorCode)
  return result
}

function validateCorrelationId(value, code) {
  if (typeof value !== 'string' || !CORRELATION_ID.test(value) || /^0+$/u.test(value)) fail(code)
}

function validateSha256(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value) || /^0+$/u.test(value)) fail(code)
}

function snapshotPlainObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(code)
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key !== 'string') || ownKeys.length !== keys.length) fail(code)
  const actual = ownKeys.map(String).sort(compareUtf8)
  const expected = [...keys].sort(compareUtf8)
  if (actual.some((key, index) => key !== expected[index])) fail(code)
  const snapshot = Object.create(null)
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail(code)
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return snapshot
}

function snapshotBytes(value, code) {
  if (!(value instanceof Uint8Array) || value.byteLength !== value.length) fail(code)
  return Buffer.from(value)
}

function correlationBytes(value) {
  validateCorrelationId(value, 'payload_protocol_input_invalid')
  return Buffer.from(value, 'hex')
}

function digestBytes(value) {
  validateSha256(value, 'payload_protocol_input_invalid')
  return Buffer.from(value, 'hex')
}

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code)
}

function readU16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.byteLength) fail('payload_protocol_truncated')
  return bytes.readUInt16LE(offset)
}

function readU32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.byteLength) fail('payload_protocol_truncated')
  return bytes.readUInt32LE(offset)
}

function readU64(bytes, offset) {
  if (offset < 0 || offset + 8 > bytes.byteLength) fail('payload_protocol_truncated')
  return bytes.readBigUInt64LE(offset)
}

function requireBytes(bytes, offset, expected, code) {
  if (offset < 0 || offset + expected.byteLength > bytes.byteLength) fail(code)
  if (!bytes.subarray(offset, offset + expected.byteLength).equals(expected)) fail(code)
}

function requireZero(bytes, start, end, code) {
  if (start < 0 || end < start || end > bytes.byteLength) fail(code)
  for (let offset = start; offset < end; offset += 1) if (bytes[offset] !== 0) fail(code)
}

function exactInteger(actual, expected, code) {
  if (actual !== expected) fail(code)
}

function isAllZero(bytes) {
  for (const byte of bytes) if (byte !== 0) return false
  return true
}

function isWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1)
      if (!(following >= 0xdc00 && following <= 0xdfff)) return false
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false
  }
  return true
}

function align8(value) {
  return (value + 7) & ~7
}

function recordSpec(type, name, encodingName) {
  const encoding = APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS[encodingName]
  if (encoding === undefined) fail('payload_protocol_contract_invalid')
  return { type, name, encoding }
}

function assertChildGateContract() {
  if (APPCONTAINER_PROBE_GATE_SPECS.length !== 34 || APPCONTAINER_PROBE_CHILD_GATE_SPECS.length !== 31) {
    fail('payload_protocol_contract_invalid')
  }
  const allIds = APPCONTAINER_PROBE_GATE_SPECS.map(({ id }) => id)
  if (new Set(allIds).size !== allIds.length) fail('payload_protocol_contract_invalid')
  for (const id of SUPERVISOR_ONLY_GATES) {
    if (allIds.filter((candidate) => candidate === id).length !== 1) fail('payload_protocol_contract_invalid')
  }
  if (APPCONTAINER_PROBE_CHILD_GATE_SPECS.some(({ id }) => SUPERVISOR_ONLY_GATES.has(id))) {
    fail('payload_protocol_contract_invalid')
  }
}

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest()
}

function sha256Hex(value) {
  return sha256Buffer(value).toString('hex')
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function fail(code) {
  throw new AppContainerProbePayloadProtocolError(code)
}
