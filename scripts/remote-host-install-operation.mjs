import { createHash } from 'node:crypto'
import { isDeepStrictEqual, types as utilTypes } from 'node:util'

export const REMOTE_HOST_INSTALL_OPERATION_SCHEMA_VERSION = 1
export const REMOTE_HOST_INSTALL_OPERATION_KIND = 'prime_continuim_remote_host_install_operation_v1'
export const REMOTE_HOST_INSTALL_OPERATION_PHASES = Object.freeze([
  'planned',
  'admitted',
  'dispatching',
  'outcome_unknown',
  'remote_prepared',
  'package_published',
  'service_starting',
  'ready_verified',
  'settled',
  'failed_pre_effect',
  'blocked_post_effect',
])
export const REMOTE_HOST_INSTALL_OPERATION_CLAIM_KEYS = Object.freeze([
  'installerImplemented',
  'durablePersistenceImplemented',
  'durableNoReplayEnforced',
  'remoteStatusImplemented',
  'liveInstallVerified',
  'remoteExecution',
  'authentication',
  'authorization',
  'upgradeSupported',
  'repairSupported',
  'downgradeSupported',
  'rollbackSupported',
  'providerBackedEvaluation',
  'autonomousPromotion',
])

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u
const KEY_IDENTIFIER = /^[a-z][a-z0-9._-]{2,63}$/u
const TRUST_ANCHOR_ID = /^ed25519-spki-sha256-[a-f0-9]{64}$/u
const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/u
const TARGET_KEYS = Object.freeze(['platform', 'arch', 'libc'])
const IDENTITY_KEYS = Object.freeze([
  'operationId',
  'packageId',
  'manifestSha256',
  'trustAnchorId',
  'signerKeyId',
  'targetAuthoritySha256',
  'target',
  'installMode',
  'destinationState',
])
const RECORD_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  ...IDENTITY_KEYS,
  'revision',
  'phase',
  'evidenceSha256',
  'previousRecordSha256',
  'recordSha256',
  'claims',
])
const RECORD_HASH_KEYS = RECORD_KEYS.filter((key) => key !== 'recordSha256')
const TRANSITION_KEYS = Object.freeze([
  'expectedRevision',
  'expectedRecordSha256',
  'phase',
  'evidenceSha256',
])
const KIT_CORRELATION_KEYS = Object.freeze([
  'packageId',
  'manifestSha256',
  'trustAnchorId',
  'signerKeyId',
  'target',
  'installAction',
  'artifactBytesCorrelated',
])
const CLAIMS = deepFreeze(Object.fromEntries(
  REMOTE_HOST_INSTALL_OPERATION_CLAIM_KEYS.map((key) => [key, false]),
))
const TRANSITIONS = Object.freeze({
  planned: new Set(['admitted', 'failed_pre_effect']),
  admitted: new Set(['dispatching', 'failed_pre_effect']),
  dispatching: new Set(['outcome_unknown', 'remote_prepared', 'blocked_post_effect']),
  outcome_unknown: new Set(['remote_prepared', 'blocked_post_effect']),
  remote_prepared: new Set(['package_published', 'blocked_post_effect']),
  package_published: new Set(['service_starting', 'blocked_post_effect']),
  service_starting: new Set(['ready_verified', 'blocked_post_effect']),
  ready_verified: new Set(['settled', 'blocked_post_effect']),
  settled: new Set(),
  failed_pre_effect: new Set(),
  blocked_post_effect: new Set(),
})
const POST_DISPATCH_PHASES = new Set([
  'dispatching',
  'outcome_unknown',
  'remote_prepared',
  'package_published',
  'service_starting',
  'ready_verified',
])
const TERMINAL_PHASES = new Set(['settled', 'failed_pre_effect', 'blocked_post_effect'])

export class RemoteHostInstallOperationError extends Error {
  constructor(code = 'remote_host_install_operation_invalid', message = code) {
    super(message)
    this.name = 'RemoteHostInstallOperationError'
    this.code = code
  }
}

export function validateRemoteHostInstallAdmission(input) {
  const identity = snapshotPlainData(input, 'admission_shape_invalid')
  exactObject(identity, IDENTITY_KEYS, 'admission_shape_invalid')
  validateIdentity(identity)
  return deepFreeze(identity)
}

export function createRemoteHostInstallOperation(input) {
  const identity = validateRemoteHostInstallAdmission(input)
  return createRecord(identity, {
    revision: 0,
    phase: 'planned',
    evidenceSha256: null,
    previousRecordSha256: null,
  })
}

export function validateRemoteHostInstallOperation(input) {
  const record = snapshotPlainData(input, 'operation_shape_invalid')
  exactObject(record, RECORD_KEYS, 'operation_shape_invalid')
  exactValue(record.schemaVersion, REMOTE_HOST_INSTALL_OPERATION_SCHEMA_VERSION, 'operation_schema_unsupported')
  exactValue(record.kind, REMOTE_HOST_INSTALL_OPERATION_KIND, 'operation_kind_unsupported')
  validateIdentity(record)
  if (!Number.isSafeInteger(record.revision) || record.revision < 0 || record.revision > 16) {
    fail('operation_revision_invalid')
  }
  if (!REMOTE_HOST_INSTALL_OPERATION_PHASES.includes(record.phase)) fail('operation_phase_invalid')
  validatePhaseRevision(record.phase, record.revision)
  if (record.revision === 0) {
    exactValue(record.phase, 'planned', 'operation_phase_revision_mismatch')
    exactValue(record.evidenceSha256, null, 'operation_evidence_invalid')
    exactValue(record.previousRecordSha256, null, 'operation_predecessor_invalid')
  } else {
    requireSha256(record.evidenceSha256, 'operation_evidence_invalid')
    requireSha256(record.previousRecordSha256, 'operation_predecessor_invalid')
  }
  requireSha256(record.recordSha256, 'operation_record_digest_invalid')
  validateClaims(record.claims)
  const expected = hashRecord(record)
  exactValue(record.recordSha256, expected, 'operation_record_digest_mismatch')
  return deepFreeze(record)
}

export function reduceRemoteHostInstallOperation(currentInput, transitionInput) {
  const current = validateRemoteHostInstallOperation(currentInput)
  const transition = snapshotPlainData(transitionInput, 'transition_shape_invalid')
  exactObject(transition, TRANSITION_KEYS, 'transition_shape_invalid')
  if (!Number.isSafeInteger(transition.expectedRevision) || transition.expectedRevision < 0) {
    fail('transition_revision_invalid')
  }
  exactValue(transition.expectedRevision, current.revision, 'transition_cas_conflict')
  exactValue(transition.expectedRecordSha256, current.recordSha256, 'transition_identity_conflict')
  if (!REMOTE_HOST_INSTALL_OPERATION_PHASES.includes(transition.phase)) fail('transition_phase_invalid')
  requireSha256(transition.evidenceSha256, 'transition_evidence_invalid')
  if (!TRANSITIONS[current.phase].has(transition.phase)) fail('transition_order_invalid')

  const record = createRecord(current, {
    revision: current.revision + 1,
    phase: transition.phase,
    evidenceSha256: transition.evidenceSha256,
    previousRecordSha256: current.recordSha256,
  })
  return deepFreeze({
    record,
    persistenceRequiredBeforeAction: true,
    postPersistenceRequirement: transition.phase === 'dispatching'
      ? 'future_unforgeable_persistence_capability_required'
      : 'none',
    effectAuthority: null,
  })
}

export function assertRemoteHostInstallKitCorrelation(identityInput, correlationInput) {
  const identity = validateRemoteHostInstallAdmission(identityInput)
  const correlation = snapshotPlainData(correlationInput, 'kit_correlation_shape_invalid')
  exactObject(correlation, KIT_CORRELATION_KEYS, 'kit_correlation_shape_invalid')
  exactValue(correlation.packageId, identity.packageId, 'kit_correlation_identity_mismatch')
  exactValue(correlation.manifestSha256, identity.manifestSha256, 'kit_correlation_identity_mismatch')
  exactValue(correlation.trustAnchorId, identity.trustAnchorId, 'kit_correlation_identity_mismatch')
  exactValue(correlation.signerKeyId, identity.signerKeyId, 'kit_correlation_identity_mismatch')
  exactObject(correlation.target, TARGET_KEYS, 'kit_correlation_target_invalid')
  for (const key of TARGET_KEYS) {
    exactValue(correlation.target[key], identity.target[key], 'kit_correlation_target_mismatch')
  }
  exactValue(correlation.installAction, identity.installMode, 'kit_correlation_action_mismatch')
  exactValue(correlation.artifactBytesCorrelated, true, 'kit_artifact_correlation_required')
  return deepFreeze({
    operationId: identity.operationId,
    packageId: identity.packageId,
    manifestSha256: identity.manifestSha256,
    targetAuthoritySha256: identity.targetAuthoritySha256,
    structuralCorrelation: true,
    verificationClaimed: false,
    effectAuthority: null,
  })
}

export function recoverRemoteHostInstallOperation(input) {
  const record = validateRemoteHostInstallOperation(input)
  if (POST_DISPATCH_PHASES.has(record.phase)) {
    return deepFreeze({
      operationId: record.operationId,
      revision: record.revision,
      recordSha256: record.recordSha256,
      disposition: 'query_status_only',
      statusOnly: true,
      dispatchAllowed: false,
      replayAllowed: false,
    })
  }
  if (TERMINAL_PHASES.has(record.phase)) {
    return deepFreeze({
      operationId: record.operationId,
      revision: record.revision,
      recordSha256: record.recordSha256,
      disposition: 'terminal',
      statusOnly: false,
      dispatchAllowed: false,
      replayAllowed: false,
    })
  }
  return deepFreeze({
    operationId: record.operationId,
    revision: record.revision,
    recordSha256: record.recordSha256,
    disposition: 'resume_pre_effect_reducer',
    statusOnly: false,
    dispatchAllowed: false,
    replayAllowed: false,
  })
}

export function canonicalRemoteHostInstallOperationJson(input) {
  return canonicalJson(snapshotPlainData(input, 'canonical_value_invalid'))
}

function createRecord(identitySource, state) {
  const record = {
    schemaVersion: REMOTE_HOST_INSTALL_OPERATION_SCHEMA_VERSION,
    kind: REMOTE_HOST_INSTALL_OPERATION_KIND,
    operationId: identitySource.operationId,
    packageId: identitySource.packageId,
    manifestSha256: identitySource.manifestSha256,
    trustAnchorId: identitySource.trustAnchorId,
    signerKeyId: identitySource.signerKeyId,
    targetAuthoritySha256: identitySource.targetAuthoritySha256,
    target: {
      platform: identitySource.target.platform,
      arch: identitySource.target.arch,
      libc: identitySource.target.libc,
    },
    installMode: identitySource.installMode,
    destinationState: identitySource.destinationState,
    revision: state.revision,
    phase: state.phase,
    evidenceSha256: state.evidenceSha256,
    previousRecordSha256: state.previousRecordSha256,
    recordSha256: '',
    claims: { ...CLAIMS },
  }
  record.recordSha256 = hashRecord(record)
  return validateRemoteHostInstallOperation(record)
}

function validateIdentity(value) {
  if (!OPERATION_ID.test(value.operationId ?? '')) fail('operation_id_invalid')
  requireIdentifier(value.packageId, IDENTIFIER, 'package_id_invalid')
  requireSha256(value.manifestSha256, 'manifest_digest_invalid')
  requireIdentifier(value.trustAnchorId, TRUST_ANCHOR_ID, 'trust_anchor_id_invalid')
  requireIdentifier(value.signerKeyId, KEY_IDENTIFIER, 'signer_key_id_invalid')
  requireSha256(value.targetAuthoritySha256, 'target_authority_digest_invalid')
  exactObject(value.target, TARGET_KEYS, 'target_invalid')
  exactValue(value.target.platform, 'linux', 'target_platform_unsupported')
  exactValue(value.target.arch, 'x64', 'target_arch_unsupported')
  exactValue(value.target.libc, 'glibc', 'target_libc_unsupported')
  exactValue(value.installMode, 'fresh_install', 'install_mode_unsupported')
  exactValue(value.destinationState, 'absent', 'destination_not_fresh')
}

function validatePhaseRevision(phase, revision) {
  const ranges = {
    planned: [0, 0],
    admitted: [1, 1],
    dispatching: [2, 2],
    outcome_unknown: [3, 3],
    remote_prepared: [3, 4],
    package_published: [4, 5],
    service_starting: [5, 6],
    ready_verified: [6, 7],
    settled: [7, 8],
    failed_pre_effect: [1, 2],
    blocked_post_effect: [3, 8],
  }
  const [minimum, maximum] = ranges[phase]
  if (revision < minimum || revision > maximum) fail('operation_phase_revision_mismatch')
}

function validateClaims(value) {
  exactObject(value, REMOTE_HOST_INSTALL_OPERATION_CLAIM_KEYS, 'claims_shape_invalid')
  for (const key of REMOTE_HOST_INSTALL_OPERATION_CLAIM_KEYS) exactValue(value[key], false, 'claim_overstated')
}

function hashRecord(record) {
  const payload = Object.fromEntries(RECORD_HASH_KEYS.map((key) => [key, record[key]]))
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')
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
    if (value.normalize('NFC') !== value || value.includes('\n') || value.includes('\r')) fail('canonical_string_invalid')
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

function requireSha256(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code)
}

function fail(code) {
  throw new RemoteHostInstallOperationError(code)
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
