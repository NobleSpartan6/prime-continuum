import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export const APPCONTAINER_PROBE_SCHEMA_VERSION = 2
export const APPCONTAINER_PROBE_KIND = 'prime_continuim_appcontainer_probe_v2'
export const APPCONTAINER_PROBE_ENVELOPE_KIND = 'prime_continuim_appcontainer_probe_envelope_v2'
export const APPCONTAINER_PROBE_MAX_RECEIPT_BYTES = 64 * 1024
export const APPCONTAINER_PROBE_CONFIRMATION_PHRASE =
  'DISPOSE THIS VM AFTER PRIME APPCONTAINER PROBE'

export const APPCONTAINER_PROBE_PHASES = Object.freeze([
  'prepared',
  'admitted',
  'sandbox_created',
  'invocation_committed',
  'supervisor_published',
  'tree_retired',
  'gate_evidence_observed',
  'cleanup_complete',
  'settled',
])

export const APPCONTAINER_PROBE_CLAIM_KEYS = Object.freeze([
  'productCapability',
  'candidateEvaluation',
  'securitySandboxClaim',
  'mainFilesystemIsolationClaim',
  'authenticated',
  'providerBackedEvaluation',
  'autonomousPromotion',
])

export const APPCONTAINER_PROBE_EXIT_SEMANTICS = Object.freeze({
  staticReceiptVerified: 0,
  failed: 1,
  functionalPassedVmDisposalRequired: 2,
})

export const APPCONTAINER_PROBE_GATE_SPECS = Object.freeze([
  gate('child_exact_appcontainer_sid', 'present'),
  gate('child_low_integrity', 'present'),
  gate('child_zero_capability_sids', 'present'),
  gate('child_lpac_policy', 'present'),
  gate('job_membership_at_process_creation', 'present'),
  gate('launch_handle_inheritance_disabled', 'present'),
  gate('child_exact_environment_allowlist', 'present'),
  gate('child_credential_shaped_environment', 'denied'),
  gate('sealed_tool_tree_read_execute', 'allowed'),
  gate('scratch_read_write', 'allowed'),
  gate('profile_read_write', 'allowed'),
  gate('no_writable_executable_closure', 'present'),
  gate('main_workspace_sentinel_read', 'denied'),
  gate('main_workspace_sentinel_write', 'denied'),
  gate('user_profile_sentinel_read', 'denied'),
  gate('user_profile_sentinel_write', 'denied'),
  gate('credential_store_sentinel_read', 'denied'),
  gate('credential_store_sentinel_write', 'denied'),
  gate('runtime_sentinel_read', 'denied'),
  gate('runtime_sentinel_write', 'denied'),
  gate('out_sentinel_read', 'denied'),
  gate('out_sentinel_write', 'denied'),
  gate('release_sentinel_read', 'denied'),
  gate('release_sentinel_write', 'denied'),
  gate('programdata_sentinel_read', 'denied'),
  gate('programdata_sentinel_write', 'denied'),
  gate('sibling_temp_sentinel_read', 'denied'),
  gate('sibling_temp_sentinel_write', 'denied'),
  gate('inherited_handle_sentinel', 'denied'),
  gate('parent_process_sentinel', 'denied'),
  gate('parent_named_pipe_sentinel', 'denied'),
  gate('loopback_network_sentinel', 'denied'),
  gate('lan_network_sentinel', 'denied'),
  gate('internet_network_sentinel', 'denied'),
])

export const APPCONTAINER_PROBE_FAILURE_CODES = Object.freeze([
  'admission_denied',
  'profile_creation_failed',
  'acl_policy_failed',
  'launch_failed',
  'supervisor_publication_failed',
  'tree_retirement_unconfirmed',
  'gate_evidence_invalid',
  'gate_mismatch',
  'cleanup_unconfirmed',
  'receipt_invalid',
  'internal_failure',
])

const SHA256 = /^[a-f0-9]{64}$/u
const CORRELATION_ID = /^[a-f0-9]{32}$/u
const FORBIDDEN_STRING = /(?:[a-z]:[\\/]|\\\\|file:\/\/|https?:\/\/|\bS-\d-\d+(?:-\d+)+\b|\b(?:stdout|stderr|command[_ -]?line|bearer|password|secret|cookie|authorization)\b)/iu
const FORBIDDEN_KEYS = /(?:path|username|userName|accountName|processId|threadId|packageSid|userSid|rawOutput|stdout|stderr|commandLine|argv|environment|secret|password|cookie|authorization|email)/u
const OUTCOMES = new Set([
  'functional_passed_vm_disposal_required',
  'failed_vm_disposal_required',
])
const OBSERVATIONS = new Set(['present', 'allowed', 'denied', 'mismatched', 'unknown'])
const FAILURE_CODES = new Set(APPCONTAINER_PROBE_FAILURE_CODES)
const PHASE_INDEX = new Map(APPCONTAINER_PROBE_PHASES.map((phase, index) => [phase, index]))
const FAILURE_RULES = Object.freeze({
  profile_creation_failed: { stage: 'admitted', forbiddenPhase: 'sandbox_created' },
  acl_policy_failed: { stage: 'admitted', forbiddenPhase: 'sandbox_created' },
  launch_failed: { stage: 'invocation_committed', forbiddenPhase: 'supervisor_published' },
  supervisor_publication_failed: { stage: 'invocation_committed', forbiddenPhase: 'supervisor_published' },
  tree_retirement_unconfirmed: { stage: 'supervisor_published', forbiddenPhase: 'tree_retired' },
  gate_evidence_invalid: { stage: 'tree_retired', forbiddenPhase: 'gate_evidence_observed' },
  gate_mismatch: { stage: 'gate_evidence_observed' },
  cleanup_unconfirmed: { stage: 'gate_evidence_observed', forbiddenPhase: 'cleanup_complete' },
  receipt_invalid: { stage: 'cleanup_complete', forbiddenPhase: 'settled' },
})

const ENVELOPE_KEYS = ['schemaVersion', 'kind', 'receiptSha256', 'receipt']
const RECEIPT_KEYS = [
  'schemaVersion',
  'kind',
  'outcome',
  'correlationId',
  'platform',
  'arch',
  'admission',
  'provenance',
  'launchPolicy',
  'state',
  'supervisorEvidence',
  'gates',
  'cleanup',
  'claims',
  'limitations',
  'failure',
]
const ADMISSION_KEYS = [
  'status',
  'interactive',
  'ciForbidden',
  'disposableVm',
  'checkpointConfirmed',
  'typedConfirmation',
  'dedicatedStandardAccount',
  'operatorNonAdmin',
  'operatorMediumIntegrity',
  'operatorNotElevated',
  'preexistingProvenanceMatched',
  'dedicatedProbePayload',
]
const ADMISSION_INPUT_KEYS = [
  'platform',
  'arch',
  'stdinIsTTY',
  'stdoutIsTTY',
  'ci',
  'githubActions',
  'disposableVm',
  'checkpointConfirmed',
  'confirmationPhrase',
  'operator',
  'installedCandidate',
  'probePayload',
  'storage',
]
const OPERATOR_KEYS = [
  'dedicatedAccount',
  'standardUser',
  'administratorsGroupAbsent',
  'elevated',
  'integrity',
]
const PROVENANCE_INPUT_KEYS = ['sha256', 'bytes', 'preexisting', 'regularFile', 'reparsePoint', 'machine']
const STORAGE_KEYS = [
  'boundedPrivateRoot',
  'freshOperationRoot',
  'preexistingReceiptAbsent',
  'sealedToolCopyPlanned',
  'boundedControlledSentinels',
]
const PROVENANCE_KEYS = ['installedCandidate', 'probePayload']
const PROVENANCE_RECORD_KEYS = ['role', 'sha256', 'bytes']
const LAUNCH_POLICY_KEYS = [
  'stableProfileApisOnly',
  'startupInfoEx',
  'securityCapabilitiesAttribute',
  'jobListAtCreateProcess',
  'inheritHandles',
  'explicitSanitizedUnicodeEnvironment',
  'allApplicationPackagesOptOut',
  'zeroCapabilities',
  'sealedToolTreeReadExecuteOnly',
  'scratchAndProfileReadWriteOnly',
  'noWritableExecutableClosure',
  'experimentalApi',
  'fallback',
]
const STATE_KEYS = ['phases', 'finalPhase']
const EVIDENCE_KEYS = ['sha256', 'bytes']
const GATE_KEYS = ['id', 'expected', 'observed']
const CLEANUP_KEYS = [
  'status',
  'treeRetired',
  'profileDeleted',
  'operationRootDeleted',
  'publicationMode',
  'externalVmDisposalRequired',
  'externalVmDisposalConfirmed',
]
const LIMITATION_KEYS = [
  'controlledSentinelsOnly',
  'windowsSystemReadsOutsideSentinelsMayRemain',
  'installedCandidateCorrelationOnly',
  'installedCandidateExecuted',
  'candidateEvaluated',
  'externalVmDisposalRequired',
]
const FAILURE_KEYS = ['stage', 'code']

export class AppContainerProbeContractError extends Error {
  constructor(code = 'receipt_invalid') {
    super(code)
    this.name = 'AppContainerProbeContractError'
    this.code = code
  }
}

export function validateAppContainerProbeAdmission(input) {
  input = snapshotPlainData(input, 'admission_invalid')
  exactObject(input, ADMISSION_INPUT_KEYS, 'admission_invalid')
  exactValue(input.platform, 'win32', 'wrong_platform')
  exactValue(input.arch, 'x64', 'wrong_arch')
  requireTrue(input.stdinIsTTY, 'interactive_required')
  requireTrue(input.stdoutIsTTY, 'interactive_required')
  if (![undefined, false, ''].includes(input.ci) || ![undefined, false, ''].includes(input.githubActions)) {
    fail('ci_forbidden')
  }
  requireTrue(input.disposableVm, 'disposable_vm_required')
  requireTrue(input.checkpointConfirmed, 'checkpoint_required')
  exactValue(input.confirmationPhrase, APPCONTAINER_PROBE_CONFIRMATION_PHRASE, 'confirmation_rejected')

  exactObject(input.operator, OPERATOR_KEYS, 'operator_invalid')
  requireTrue(input.operator.dedicatedAccount, 'dedicated_account_required')
  requireTrue(input.operator.standardUser, 'standard_user_required')
  requireTrue(input.operator.administratorsGroupAbsent, 'administrator_forbidden')
  exactValue(input.operator.elevated, false, 'elevation_forbidden')
  exactValue(input.operator.integrity, 'medium', 'medium_integrity_required')

  validateAdmissionProvenance(input.installedCandidate, 2 * 1024 * 1024 * 1024)
  validateAdmissionProvenance(input.probePayload, 64 * 1024 * 1024)
  if (input.installedCandidate.sha256 === input.probePayload.sha256) {
    fail('probe_payload_not_distinct')
  }
  exactObject(input.storage, STORAGE_KEYS, 'storage_invalid')
  for (const key of STORAGE_KEYS) requireTrue(input.storage[key], 'storage_invalid')

  return Object.freeze({
    status: 'admitted',
    installedCandidate: Object.freeze({ sha256: input.installedCandidate.sha256, bytes: input.installedCandidate.bytes }),
    probePayload: Object.freeze({ sha256: input.probePayload.sha256, bytes: input.probePayload.bytes }),
  })
}

export function validateAppContainerProbeReceipt(receipt) {
  return validateAppContainerProbeReceiptSnapshot(snapshotPlainData(receipt))
}

function validateAppContainerProbeReceiptSnapshot(receipt) {
  exactObject(receipt, RECEIPT_KEYS)
  exactValue(receipt.schemaVersion, APPCONTAINER_PROBE_SCHEMA_VERSION)
  exactValue(receipt.kind, APPCONTAINER_PROBE_KIND)
  if (!OUTCOMES.has(receipt.outcome)) fail()
  if (!CORRELATION_ID.test(receipt.correlationId ?? '')) fail()
  exactValue(receipt.platform, 'win32')
  exactValue(receipt.arch, 'x64')

  validateReceiptAdmission(receipt.admission)
  validateReceiptProvenance(receipt.provenance, receipt.admission.status)
  validateLaunchPolicy(receipt.launchPolicy)
  const phases = validatePhases(receipt.state)
  if (receipt.admission.status === 'denied' && !isDeepStrictEqual(phases, ['prepared'])) fail()
  if (receipt.admission.status === 'admitted' && !phases.includes('admitted')) fail()
  const supervisorPublished = phases.includes('supervisor_published')
  validateSupervisorEvidence(receipt.supervisorEvidence, supervisorPublished)
  validateGates(receipt.gates, phases, receipt.outcome)
  validateCleanup(receipt.cleanup, phases, receipt.outcome)
  validateClaims(receipt.claims)
  validateLimitations(receipt.limitations)
  validateFailure(receipt, phases)

  if (receipt.outcome === 'functional_passed_vm_disposal_required') {
    if (receipt.admission.status !== 'admitted') fail()
    if (!isDeepStrictEqual(phases, APPCONTAINER_PROBE_PHASES)) fail()
  }

  assertNoForbiddenMaterial(receipt)
  return deepFreeze(receipt)
}

export function createAppContainerProbeReceiptEnvelope(receipt) {
  const validated = validateAppContainerProbeReceipt(receipt)
  return deepFreeze({
    schemaVersion: APPCONTAINER_PROBE_SCHEMA_VERSION,
    kind: APPCONTAINER_PROBE_ENVELOPE_KIND,
    receiptSha256: sha256(canonicalJson(validated)),
    receipt: validated,
  })
}

export function serializeAppContainerProbeReceiptEnvelope(envelope) {
  const validated = validateEnvelope(envelope)
  const bytes = Buffer.from(`${canonicalJson(validated)}\n`, 'utf8')
  if (bytes.byteLength > APPCONTAINER_PROBE_MAX_RECEIPT_BYTES) fail('receipt_oversize')
  return bytes
}

export function verifyAppContainerProbeReceiptBytes(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (bytes.byteLength < 2 || bytes.byteLength > APPCONTAINER_PROBE_MAX_RECEIPT_BYTES) {
    fail(bytes.byteLength > APPCONTAINER_PROBE_MAX_RECEIPT_BYTES ? 'receipt_oversize' : 'receipt_invalid')
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('receipt_bom_forbidden')
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail()
  }
  if (!text.endsWith('\n') || text.endsWith('\n\n') || text.includes('\r')) fail()
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    fail()
  }
  const validated = validateEnvelope(envelope)
  if (`${canonicalJson(validated)}\n` !== text) fail('receipt_not_canonical')
  return Object.freeze({
    receipt: validated.receipt,
    receiptSha256: validated.receiptSha256,
    staticVerifierExitCode: APPCONTAINER_PROBE_EXIT_SEMANTICS.staticReceiptVerified,
    liveProbeExitCode: validated.receipt.outcome === 'functional_passed_vm_disposal_required'
      ? APPCONTAINER_PROBE_EXIT_SEMANTICS.functionalPassedVmDisposalRequired
      : APPCONTAINER_PROBE_EXIT_SEMANTICS.failed,
  })
}

export function canonicalAppContainerProbeJson(value) {
  return canonicalJson(snapshotPlainData(value))
}

function validateEnvelope(envelope) {
  envelope = snapshotPlainData(envelope)
  exactObject(envelope, ENVELOPE_KEYS)
  exactValue(envelope.schemaVersion, APPCONTAINER_PROBE_SCHEMA_VERSION)
  exactValue(envelope.kind, APPCONTAINER_PROBE_ENVELOPE_KIND)
  if (!SHA256.test(envelope.receiptSha256 ?? '')) fail()
  const receipt = validateAppContainerProbeReceiptSnapshot(envelope.receipt)
  if (sha256(canonicalJson(receipt)) !== envelope.receiptSha256) fail('receipt_digest_mismatch')
  return deepFreeze({ ...envelope, receipt })
}

function validateAdmissionProvenance(value, maxBytes) {
  exactObject(value, PROVENANCE_INPUT_KEYS, 'provenance_invalid')
  if (!SHA256.test(value.sha256 ?? '')) fail('provenance_invalid')
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > maxBytes) fail('provenance_invalid')
  requireTrue(value.preexisting, 'provenance_invalid')
  requireTrue(value.regularFile, 'provenance_invalid')
  exactValue(value.reparsePoint, false, 'provenance_invalid')
  exactValue(value.machine, 'x64', 'provenance_invalid')
}

function validateReceiptAdmission(value) {
  exactObject(value, ADMISSION_KEYS)
  if (!['admitted', 'denied'].includes(value.status)) fail()
  const facts = ADMISSION_KEYS.slice(1)
  if (facts.some((key) => typeof value[key] !== 'boolean')) fail()
  if (value.status === 'admitted' && facts.some((key) => value[key] !== true)) fail()
  if (value.status === 'denied' && facts.every((key) => value[key] === true)) fail()
}

function validateReceiptProvenance(value, admissionStatus) {
  if (value === null) {
    if (admissionStatus !== 'denied') fail()
    return
  }
  if (admissionStatus === 'denied') fail()
  exactObject(value, PROVENANCE_KEYS)
  validateReceiptProvenanceRecord(value.installedCandidate, 'correlation_only_not_executed', 2 * 1024 * 1024 * 1024)
  validateReceiptProvenanceRecord(value.probePayload, 'dedicated_probe_payload_launch_target', 64 * 1024 * 1024)
  if (value.installedCandidate.sha256 === value.probePayload.sha256) {
    fail('probe_payload_not_distinct')
  }
}

function validateReceiptProvenanceRecord(value, role, maxBytes) {
  exactObject(value, PROVENANCE_RECORD_KEYS)
  exactValue(value.role, role)
  if (!SHA256.test(value.sha256 ?? '')) fail()
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > maxBytes) fail()
}

function validateLaunchPolicy(value) {
  exactObject(value, LAUNCH_POLICY_KEYS)
  for (const key of LAUNCH_POLICY_KEYS) {
    const expected = ['inheritHandles', 'experimentalApi', 'fallback'].includes(key) ? false : true
    exactValue(value[key], expected)
  }
}

function validatePhases(value) {
  exactObject(value, STATE_KEYS)
  if (!Array.isArray(value.phases) || value.phases.length < 1 || value.phases.length > APPCONTAINER_PROBE_PHASES.length) {
    fail()
  }
  for (const [index, phase] of value.phases.entries()) {
    if (phase !== APPCONTAINER_PROBE_PHASES[index]) fail('phase_order_invalid')
  }
  exactValue(value.finalPhase, value.phases.at(-1))
  return value.phases
}

function validateSupervisorEvidence(value, published) {
  if (value === null) {
    if (published) fail()
    return
  }
  if (!published) fail()
  exactObject(value, EVIDENCE_KEYS)
  if (!SHA256.test(value.sha256 ?? '')) fail()
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 1024 * 1024) fail()
}

function validateGates(value, phases, outcome) {
  if (!Array.isArray(value)) fail()
  const evidenceObserved = phases.includes('gate_evidence_observed')
  const treeRetiredIndex = phases.indexOf('tree_retired')
  const evidenceIndex = phases.indexOf('gate_evidence_observed')
  if (evidenceObserved && (treeRetiredIndex < 0 || treeRetiredIndex >= evidenceIndex)) fail('evidence_before_tree_retired')
  if (!evidenceObserved) {
    if (value.length !== 0) fail('evidence_before_tree_retired')
    return
  }
  if (value.length !== APPCONTAINER_PROBE_GATE_SPECS.length) fail()
  for (const [index, record] of value.entries()) {
    exactObject(record, GATE_KEYS)
    const spec = APPCONTAINER_PROBE_GATE_SPECS[index]
    exactValue(record.id, spec.id)
    exactValue(record.expected, spec.expected)
    if (!OBSERVATIONS.has(record.observed)) fail()
    if (outcome === 'functional_passed_vm_disposal_required') exactValue(record.observed, spec.expected)
  }
}

function validateCleanup(value, phases, outcome) {
  exactObject(value, CLEANUP_KEYS)
  if (!['complete', 'unconfirmed'].includes(value.status)) fail()
  for (const key of ['treeRetired', 'profileDeleted', 'operationRootDeleted', 'externalVmDisposalRequired', 'externalVmDisposalConfirmed']) {
    if (typeof value[key] !== 'boolean') fail()
  }
  exactValue(value.publicationMode, 'host_no_replace')
  exactValue(value.externalVmDisposalRequired, true)
  exactValue(value.externalVmDisposalConfirmed, false)
  exactValue(value.treeRetired, phases.includes('tree_retired'))
  const cleanupComplete = phases.includes('cleanup_complete')
  if (cleanupComplete !== (value.status === 'complete')) fail()
  if (cleanupComplete && (!value.treeRetired || !value.profileDeleted || !value.operationRootDeleted)) fail()
  if (!cleanupComplete && value.treeRetired && value.profileDeleted && value.operationRootDeleted) fail()
  if (phases.includes('settled') && !cleanupComplete) fail()
  if (outcome === 'functional_passed_vm_disposal_required' && value.status !== 'complete') fail()
}

function validateClaims(value) {
  exactObject(value, APPCONTAINER_PROBE_CLAIM_KEYS)
  for (const key of APPCONTAINER_PROBE_CLAIM_KEYS) exactValue(value[key], false)
}

function validateLimitations(value) {
  exactObject(value, LIMITATION_KEYS)
  requireTrue(value.controlledSentinelsOnly)
  requireTrue(value.windowsSystemReadsOutsideSentinelsMayRemain)
  requireTrue(value.installedCandidateCorrelationOnly)
  exactValue(value.installedCandidateExecuted, false)
  exactValue(value.candidateEvaluated, false)
  requireTrue(value.externalVmDisposalRequired)
}

function validateFailure(receipt, phases) {
  const value = receipt.failure
  if (receipt.outcome === 'functional_passed_vm_disposal_required') {
    if (value !== null) fail()
    return
  }
  exactObject(value, FAILURE_KEYS)
  if (!PHASE_INDEX.has(value.stage) || !phases.includes(value.stage)) fail()
  if (!FAILURE_CODES.has(value.code)) fail()

  if (receipt.admission.status === 'denied') {
    if (value.code !== 'admission_denied' || value.stage !== 'prepared') fail()
    return
  }
  if (value.code === 'admission_denied') fail()
  if (value.code === 'internal_failure') return

  const rule = FAILURE_RULES[value.code]
  if (rule === undefined || value.stage !== rule.stage) fail()
  if (rule.forbiddenPhase !== undefined && phases.includes(rule.forbiddenPhase)) fail()
  if (value.code === 'gate_mismatch') {
    if (!receipt.gates.some((gateRecord) => gateRecord.observed !== gateRecord.expected)) fail()
  }
  if (value.code === 'cleanup_unconfirmed') {
    if (
      receipt.cleanup.status !== 'unconfirmed' ||
      (receipt.cleanup.treeRetired && receipt.cleanup.profileDeleted && receipt.cleanup.operationRootDeleted)
    ) fail()
  }
}

function assertNoForbiddenMaterial(value) {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (FORBIDDEN_KEYS.test(key)) fail('forbidden_receipt_material')
        pending.push(child)
      }
      continue
    }
    if (typeof current === 'string' && (current.includes('\n') || current.includes('\r') || FORBIDDEN_STRING.test(current))) {
      fail('forbidden_receipt_material')
    }
  }
}

function exactObject(value, keys, code = 'receipt_invalid') {
  if (!isPlainObject(value) || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) fail(code)
}

function exactValue(actual, expected, code = 'receipt_invalid') {
  if (actual !== expected) fail(code)
}

function requireTrue(value, code = 'receipt_invalid') {
  exactValue(value, true, code)
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail()
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isPlainObject(value)) fail()
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

function snapshotPlainData(value, code = 'receipt_invalid') {
  if (value === undefined) return value
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail(code)
    return value
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail(code)
    const keys = Reflect.ownKeys(value)
    const expectedKeys = [...Array.from({ length: value.length }, (_, index) => String(index)), 'length']
    if (!isDeepStrictEqual(keys, expectedKeys)) fail(code)
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail(code)
      return snapshotPlainData(descriptor.value, code)
    })
  }
  if (!isPlainObject(value)) fail(code)
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

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function gate(id, expected) {
  return Object.freeze({ id, expected })
}

function fail(code = 'receipt_invalid') {
  throw new AppContainerProbeContractError(code)
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
