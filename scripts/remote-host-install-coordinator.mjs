import { types as utilTypes } from 'node:util'
import { verifyRemoteHostKitBytes } from './remote-host-kit-lib.mjs'
import {
  assertRemoteHostInstallKitCorrelation,
  validateRemoteHostInstallAdmission,
} from './remote-host-install-operation.mjs'
import {
  __REMOTE_HOST_INSTALL_VITEST_ONLY_WINDOWS_REFERENCE_FENCE,
  openRemoteHostInstallJournal,
} from './remote-host-install-journal.mjs'

export const REMOTE_HOST_INSTALL_COORDINATOR_SCHEMA_VERSION = 1
export const REMOTE_HOST_INSTALL_COORDINATOR_KIND = 'prime_continuim_remote_host_install_coordinator_state_v1'
export const REMOTE_HOST_INSTALL_COORDINATOR_FAULT_POINTS = Object.freeze([
  'after_kit_verification_before_journal_open',
  'after_dispatch_fence_confirmation_before_capability_mint',
  'after_capability_mint_before_consume',
  'after_capability_consume_before_effect',
  'after_effect_success_before_remote_prepared',
  'after_effect_throw_before_outcome_unknown',
  'after_outcome_publication',
])
export const REMOTE_HOST_INSTALL_COORDINATOR_CLAIM_KEYS = Object.freeze([
  'powerLossDurability',
  'windowsProductionDurability',
  'hostileSameUserProtection',
  'multiProcessCustody',
  'liveRemoteInstall',
  'remoteExecution',
  'authentication',
  'authorization',
  'upgradeSupported',
  'repairSupported',
  'downgradeSupported',
  'rollbackSupported',
  'productIntegration',
  'providerBackedEvaluation',
  'autonomousPromotion',
])

const OPEN_REQUIRED_KEYS = Object.freeze([
  'journalDirectory',
  'operationId',
  'targetAuthoritySha256',
  'manifestBytes',
  'envelopeBytes',
  'artifactBytes',
  'independentTrust',
])
const OPEN_OPTIONAL_KEYS = Object.freeze([
  'journalFaultInjector',
  'coordinatorFaultInjector',
  '__vitestWindowsReferenceFence',
])
const INITIALIZE_KEYS = Object.freeze(['evidenceSha256'])
const TRANSITION_KEYS = Object.freeze([
  'expectedRevision',
  'expectedRecordSha256',
  'evidenceSha256',
])
const RECONCILE_KEYS = Object.freeze([
  'expectedRevision',
  'expectedRecordSha256',
  'phase',
  'evidenceSha256',
])
const DISPATCH_KEYS = Object.freeze([
  'expectedRevision',
  'expectedRecordSha256',
  'dispatchEvidenceSha256',
  'remotePreparedEvidenceSha256',
  'outcomeUnknownEvidenceSha256',
  'effect',
])
const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/u
const POST_DISPATCH_PHASES = new Set([
  'dispatching',
  'outcome_unknown',
  'remote_prepared',
  'package_published',
  'service_starting',
  'ready_verified',
])
const CLAIMS = deepFreeze(Object.fromEntries(
  REMOTE_HOST_INSTALL_COORDINATOR_CLAIM_KEYS.map((key) => [key, false]),
))

export class RemoteHostInstallCoordinatorError extends Error {
  constructor(code = 'remote_host_install_coordinator_invalid', message = code) {
    super(message)
    this.name = 'RemoteHostInstallCoordinatorError'
    this.code = code
  }
}

export async function openRemoteHostInstallCoordinator(optionsInput) {
  const options = validateOpenOptions(optionsInput)

  let verifiedKit
  let identity
  try {
    // The verifier performs the bounded owned snapshots. The coordinator retains only
    // the resulting digest/metadata correlation, never artifact or signature bytes.
    verifiedKit = verifyRemoteHostKitBytes(
      options.manifestBytes,
      options.envelopeBytes,
      options.artifactBytes,
      options.independentTrust,
    )
    identity = validateRemoteHostInstallAdmission({
      operationId: options.operationId,
      packageId: verifiedKit.packageId,
      manifestSha256: verifiedKit.manifestSha256,
      trustAnchorId: verifiedKit.trustAnchorId,
      signerKeyId: verifiedKit.signerKeyId,
      targetAuthoritySha256: options.targetAuthoritySha256,
      target: verifiedKit.manifest.target,
      installMode: verifiedKit.manifest.installAction,
      destinationState: 'absent',
    })
    assertRemoteHostInstallKitCorrelation(identity, {
      packageId: verifiedKit.packageId,
      manifestSha256: verifiedKit.manifestSha256,
      trustAnchorId: verifiedKit.trustAnchorId,
      signerKeyId: verifiedKit.signerKeyId,
      target: verifiedKit.manifest.target,
      installAction: verifiedKit.manifest.installAction,
      artifactBytesCorrelated: verifiedKit.verification.artifactBytesCorrelated,
    })
  } catch {
    fail('coordinator_kit_verification_failed')
  }

  injectFault(options.coordinatorFaultInjector, 'after_kit_verification_before_journal_open')

  const journalOptions = {
    journalDirectory: options.journalDirectory,
    identity,
    ...(options.journalFaultInjector === undefined
      ? {}
      : { faultInjector: options.journalFaultInjector }),
    ...(options.testFence === undefined
      ? {}
      : { __vitestWindowsReferenceFence: options.testFence }),
  }
  let journal
  try {
    journal = await openRemoteHostInstallJournal(journalOptions)
  } catch {
    fail('coordinator_journal_open_failed')
  }

  const kitCorrelation = deepFreeze({
    schema: verifiedKit.schema,
    packageId: verifiedKit.packageId,
    manifestSha256: verifiedKit.manifestSha256,
    envelopeSha256: verifiedKit.envelopeSha256,
    trustAnchorId: verifiedKit.trustAnchorId,
    signerKeyId: verifiedKit.signerKeyId,
    target: { ...verifiedKit.manifest.target },
    installAction: verifiedKit.manifest.installAction,
    artifacts: Object.fromEntries(Object.entries(verifiedKit.artifacts).map(([role, artifact]) => [
      role,
      { ...artifact },
    ])),
    verification: { ...verifiedKit.verification },
  })
  const coordinatorFaultInjector = options.coordinatorFaultInjector
  const capabilityBrands = new WeakMap()
  const consumedCapabilities = new WeakSet()
  let dispatchBoundaryCrossed = false
  let tail = Promise.resolve()

  const serialized = (operation) => {
    const result = tail.then(operation)
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  const state = async () => {
    let journalState
    try {
      journalState = await journal.readState()
    } catch {
      fail('coordinator_journal_read_failed')
    }
    return deepFreeze({
      schemaVersion: REMOTE_HOST_INSTALL_COORDINATOR_SCHEMA_VERSION,
      kind: REMOTE_HOST_INSTALL_COORDINATOR_KIND,
      identity,
      kitCorrelation,
      journal: journalState,
      effectAuthority: null,
      claims: { ...CLAIMS },
    })
  }

  const coordinator = {
    readState() {
      return serialized(state)
    },

    initialize(input) {
      return serialized(async () => {
        validateInitialize(input)
        try {
          await journal.initialize({ evidenceSha256: null })
          return state()
        } catch (error) {
          throw sanitizedError(error, 'coordinator_initialize_failed')
        }
      })
    },

    admit(input) {
      return serialized(async () => {
        const request = validateTransition(input, 'coordinator_admit_invalid')
        try {
          await journal.append({ ...request, phase: 'admitted' })
          return state()
        } catch (error) {
          throw sanitizedError(error, 'coordinator_admit_failed')
        }
      })
    },

    failPreEffect(input) {
      return serialized(async () => {
        const request = validateTransition(input, 'coordinator_fail_pre_effect_invalid')
        try {
          await journal.append({ ...request, phase: 'failed_pre_effect' })
          return state()
        } catch (error) {
          throw sanitizedError(error, 'coordinator_fail_pre_effect_failed')
        }
      })
    },

    dispatch(input) {
      return serialized(async () => {
        const request = validateDispatch(input)
        if (dispatchBoundaryCrossed) fail('coordinator_dispatch_already_crossed')
        const before = await state()
        if (before.journal.currentRecord?.phase !== 'admitted') fail('coordinator_dispatch_not_admitted')

        let dispatchRecord
        let capability
        try {
          const published = await journal.append({
            expectedRevision: request.expectedRevision,
            expectedRecordSha256: request.expectedRecordSha256,
            phase: 'dispatching',
            evidenceSha256: request.dispatchEvidenceSha256,
          })
          dispatchRecord = published.record
          dispatchBoundaryCrossed = true
          const confirmedState = await journal.readState()
          if (
            confirmedState.records.length !== dispatchRecord.revision + 1 ||
            confirmedState.currentRecord?.phase !== 'dispatching' ||
            confirmedState.currentRecord?.revision !== dispatchRecord.revision ||
            confirmedState.currentRecord?.recordSha256 !== dispatchRecord.recordSha256 ||
            confirmedState.currentRecord?.operationId !== identity.operationId ||
            confirmedState.currentRecord?.targetAuthoritySha256 !== identity.targetAuthoritySha256
          ) fail('coordinator_dispatch_confirmation_invalid')
          injectFault(
            coordinatorFaultInjector,
            'after_dispatch_fence_confirmation_before_capability_mint',
          )

          capability = Object.freeze(function remoteHostInstallDispatchCapability() {})
          capabilityBrands.set(capability, Object.freeze({
            operationId: identity.operationId,
            targetAuthoritySha256: identity.targetAuthoritySha256,
            revision: dispatchRecord.revision,
            recordSha256: dispatchRecord.recordSha256,
          }))
          injectFault(coordinatorFaultInjector, 'after_capability_mint_before_consume')

          const brand = capabilityBrands.get(capability)
          if (
            brand === undefined ||
            consumedCapabilities.has(capability) ||
            brand.operationId !== identity.operationId ||
            brand.targetAuthoritySha256 !== identity.targetAuthoritySha256 ||
            brand.revision !== dispatchRecord.revision ||
            brand.recordSha256 !== dispatchRecord.recordSha256
          ) fail('coordinator_capability_invalid')
          capabilityBrands.delete(capability)
          consumedCapabilities.add(capability)
          injectFault(coordinatorFaultInjector, 'after_capability_consume_before_effect')

          let callbackResult
          let callbackThrew = false
          try {
            // Consumption and invocation are synchronous and adjacent. No bytes, paths,
            // trust material, capability, or coordinator metadata are passed to effect.
            callbackResult = request.effect()
          } catch {
            callbackThrew = true
          }

          if (!callbackThrew) {
            try {
              await callbackResult
            } catch {
              callbackThrew = true
            }
          }

          if (callbackThrew) {
            injectFault(coordinatorFaultInjector, 'after_effect_throw_before_outcome_unknown')
            const outcome = await journal.append({
              expectedRevision: dispatchRecord.revision,
              expectedRecordSha256: dispatchRecord.recordSha256,
              phase: 'outcome_unknown',
              evidenceSha256: request.outcomeUnknownEvidenceSha256,
            })
            injectFault(coordinatorFaultInjector, 'after_outcome_publication')
            return deepFreeze({
              outcome: 'outcome_unknown',
              record: outcome.record,
              effectAuthority: null,
            })
          }

          injectFault(coordinatorFaultInjector, 'after_effect_success_before_remote_prepared')
          const outcome = await journal.append({
            expectedRevision: dispatchRecord.revision,
            expectedRecordSha256: dispatchRecord.recordSha256,
            phase: 'remote_prepared',
            evidenceSha256: request.remotePreparedEvidenceSha256,
          })
          injectFault(coordinatorFaultInjector, 'after_outcome_publication')
          return deepFreeze({
            outcome: 'remote_prepared',
            record: outcome.record,
            effectAuthority: null,
          })
        } catch (error) {
          if (capability !== undefined) capabilityBrands.delete(capability)
          throw sanitizedError(error, 'coordinator_dispatch_outcome_uncertain')
        }
      })
    },

    reconcile(input) {
      return serialized(async () => {
        const request = validateReconcile(input)
        const before = await state()
        const currentPhase = before.journal.currentRecord?.phase
        if (currentPhase === undefined || !POST_DISPATCH_PHASES.has(currentPhase)) {
          fail('coordinator_reconciliation_not_status_only')
        }
        try {
          await journal.append(request)
          return state()
        } catch (error) {
          throw sanitizedError(error, 'coordinator_reconciliation_failed')
        }
      })
    },
  }

  return Object.freeze(coordinator)
}

function validateOpenOptions(input) {
  const values = exactDescriptorObject(
    input,
    OPEN_REQUIRED_KEYS,
    OPEN_OPTIONAL_KEYS,
    'coordinator_options_invalid',
  )
  if (values.journalFaultInjector !== undefined) {
    requireCallable(values.journalFaultInjector, 'coordinator_journal_fault_injector_invalid')
  }
  if (values.coordinatorFaultInjector !== undefined) {
    requireCallable(values.coordinatorFaultInjector, 'coordinator_fault_injector_invalid')
  }
  if (
    values.__vitestWindowsReferenceFence !== undefined &&
    values.__vitestWindowsReferenceFence !== __REMOTE_HOST_INSTALL_VITEST_ONLY_WINDOWS_REFERENCE_FENCE
  ) fail('coordinator_test_fence_invalid')
  return {
    journalDirectory: values.journalDirectory,
    operationId: values.operationId,
    targetAuthoritySha256: values.targetAuthoritySha256,
    manifestBytes: values.manifestBytes,
    envelopeBytes: values.envelopeBytes,
    artifactBytes: values.artifactBytes,
    independentTrust: values.independentTrust,
    journalFaultInjector: values.journalFaultInjector,
    coordinatorFaultInjector: values.coordinatorFaultInjector,
    testFence: values.__vitestWindowsReferenceFence,
  }
}

function validateInitialize(input) {
  const values = exactDescriptorObject(input, INITIALIZE_KEYS, [], 'coordinator_initialize_invalid')
  if (values.evidenceSha256 !== null) fail('coordinator_initialize_invalid')
}

function validateTransition(input, code) {
  const values = exactDescriptorObject(input, TRANSITION_KEYS, [], code)
  validateCas(values)
  requireSha256(values.evidenceSha256, code)
  return values
}

function validateReconcile(input) {
  const values = exactDescriptorObject(input, RECONCILE_KEYS, [], 'coordinator_reconcile_invalid')
  validateCas(values)
  if (typeof values.phase !== 'string') fail('coordinator_reconcile_invalid')
  requireSha256(values.evidenceSha256, 'coordinator_reconcile_invalid')
  return values
}

function validateDispatch(input) {
  const values = exactDescriptorObject(input, DISPATCH_KEYS, [], 'coordinator_dispatch_invalid')
  validateCas(values)
  requireSha256(values.dispatchEvidenceSha256, 'coordinator_dispatch_invalid')
  requireSha256(values.remotePreparedEvidenceSha256, 'coordinator_dispatch_invalid')
  requireSha256(values.outcomeUnknownEvidenceSha256, 'coordinator_dispatch_invalid')
  requireCallable(values.effect, 'coordinator_dispatch_invalid')
  return values
}

function validateCas(values) {
  if (!Number.isSafeInteger(values.expectedRevision) || values.expectedRevision < 0) {
    fail('coordinator_cas_invalid')
  }
  requireSha256(values.expectedRecordSha256, 'coordinator_cas_invalid')
}

function exactDescriptorObject(input, requiredKeys, optionalKeys, code) {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    utilTypes.isProxy(input)
  ) fail(code)
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) fail(code)
  const keys = Reflect.ownKeys(input)
  if (keys.some((key) => typeof key !== 'string')) fail(code)
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  if (
    requiredKeys.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) fail(code)
  const values = Object.create(null)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail(code)
    values[key] = descriptor.value
  }
  return values
}

function requireCallable(value, code) {
  if (typeof value !== 'function' || utilTypes.isProxy(value)) fail(code)
}

function requireSha256(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code)
}

function injectFault(faultInjector, point) {
  if (faultInjector === undefined) return
  try {
    const result = faultInjector(point)
    if (result !== undefined) fail('coordinator_fault_injector_invalid')
  } catch {
    fail('coordinator_fault_injected')
  }
}

function sanitizedError(error, fallbackCode) {
  if (error instanceof RemoteHostInstallCoordinatorError) return error
  return new RemoteHostInstallCoordinatorError(fallbackCode)
}

function fail(code) {
  throw new RemoteHostInstallCoordinatorError(code)
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
