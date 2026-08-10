import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APPCONTAINER_PROBE_CONFIRMATION_PHRASE,
  APPCONTAINER_PROBE_EXIT_SEMANTICS,
  APPCONTAINER_PROBE_GATE_SPECS,
  APPCONTAINER_PROBE_MAX_RECEIPT_BYTES,
  APPCONTAINER_PROBE_PHASES,
  createAppContainerProbeReceiptEnvelope,
  serializeAppContainerProbeReceiptEnvelope,
  validateAppContainerProbeAdmission,
  validateAppContainerProbeReceipt,
  verifyAppContainerProbeReceiptBytes,
} from '../../scripts/windows-appcontainer-probe-lib.mjs'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('source-only Windows AppContainer probe contract', () => {
  it('admits only an interactive disposable x64 VM under a dedicated standard medium-integrity operator', () => {
    const admitted = validateAppContainerProbeAdmission(admissionFixture())
    expect(admitted).toEqual({
      status: 'admitted',
      installedCandidate: { sha256: '1'.repeat(64), bytes: 4096 },
      probePayload: { sha256: '2'.repeat(64), bytes: 8192 },
    })

    const absentCiEnvironment = {
      ...admissionFixture(),
      ci: undefined,
      githubActions: undefined,
    }
    expect(validateAppContainerProbeAdmission(absentCiEnvironment)).toMatchObject({ status: 'admitted' })

    for (const mutate of [
      (value: any) => { value.platform = 'linux' },
      (value: any) => { value.arch = 'arm64' },
      (value: any) => { value.ci = 'true' },
      (value: any) => { value.operator.administratorsGroupAbsent = false },
      (value: any) => { value.operator.elevated = true },
      (value: any) => { value.operator.integrity = 'high' },
      (value: any) => { value.probePayload.reparsePoint = true },
      (value: any) => { value.probePayload.sha256 = value.installedCandidate.sha256 },
      (value: any) => { value.confirmationPhrase = 'close enough' },
      (value: any) => { value.storage.boundedControlledSentinels = false },
      (value: any) => { value.unreviewed = true },
    ]) {
      const value = admissionFixture() as any
      mutate(value)
      expect(() => validateAppContainerProbeAdmission(value)).toThrow()
    }
  })

  it('round-trips only canonical bounded correlation evidence and preserves distinct exit semantics', async () => {
    const envelope = createAppContainerProbeReceiptEnvelope(functionalReceipt())
    const encoded = serializeAppContainerProbeReceiptEnvelope(envelope)
    const root = await mkdtemp(join(tmpdir(), 'prime-appcontainer-contract-'))
    temporaryRoots.push(root)
    const receiptPath = join(root, 'receipt.json')
    await writeFile(receiptPath, encoded, { flag: 'wx' })

    const verified = verifyAppContainerProbeReceiptBytes(await readFile(receiptPath))
    expect(verified).toMatchObject({
      receiptSha256: envelope.receiptSha256,
      staticVerifierExitCode: APPCONTAINER_PROBE_EXIT_SEMANTICS.staticReceiptVerified,
      liveProbeExitCode: APPCONTAINER_PROBE_EXIT_SEMANTICS.functionalPassedVmDisposalRequired,
    })
    expect(verified.receipt).toMatchObject({
      outcome: 'functional_passed_vm_disposal_required',
      claims: {
        productCapability: false,
        candidateEvaluation: false,
        securitySandboxClaim: false,
        mainFilesystemIsolationClaim: false,
        authenticated: false,
        providerBackedEvaluation: false,
        autonomousPromotion: false,
      },
    })
  })

  it('requires exact monotonic phases and refuses gate evidence before the whole tree is retired', () => {
    const reordered = functionalReceipt()
    ;[reordered.state.phases[5], reordered.state.phases[6]] = [
      reordered.state.phases[6]!,
      reordered.state.phases[5]!,
    ]
    expect(() => validateAppContainerProbeReceipt(reordered)).toThrow(/phase_order_invalid/)

    const premature = failureReceipt()
    premature.admission = admittedFacts()
    premature.provenance = functionalReceipt().provenance
    premature.state = {
      phases: APPCONTAINER_PROBE_PHASES.slice(0, 5),
      finalPhase: 'supervisor_published',
    }
    premature.supervisorEvidence = { sha256: '3'.repeat(64), bytes: 1024 }
    premature.gates = gateRecords()
    premature.failure = { stage: 'supervisor_published', code: 'gate_evidence_invalid' }
    expect(() => validateAppContainerProbeReceipt(premature)).toThrow(/evidence_before_tree_retired/)
  })

  it('rejects unknown or identity-bearing fields and path-shaped receipt material', () => {
    const unknown = functionalReceipt() as any
    unknown.rawOutput = 'bounded but forbidden'
    expect(() => validateAppContainerProbeReceipt(unknown)).toThrow()

    const nested = functionalReceipt() as any
    nested.cleanup.path = 'C:\\Users\\operator\\scratch'
    expect(() => validateAppContainerProbeReceipt(nested)).toThrow()

    const identity = functionalReceipt() as any
    identity.admission.userName = 'operator'
    expect(() => validateAppContainerProbeReceipt(identity)).toThrow()
  })

  it('rejects oversized, noncanonical, corrupted, and recomputed-with-unknown-field envelopes', () => {
    const envelope = createAppContainerProbeReceiptEnvelope(functionalReceipt())
    const encoded = serializeAppContainerProbeReceiptEnvelope(envelope)
    const oversized = Buffer.concat([
      encoded,
      Buffer.alloc(APPCONTAINER_PROBE_MAX_RECEIPT_BYTES, 0x20),
    ])
    expect(() => verifyAppContainerProbeReceiptBytes(oversized)).toThrow(/receipt_oversize/)

    const pretty = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
    expect(() => verifyAppContainerProbeReceiptBytes(pretty)).toThrow(/receipt_not_canonical/)

    const corrupted = JSON.parse(encoded.toString('utf8')) as any
    corrupted.receipt.provenance.probePayload.bytes += 1
    expect(() => verifyAppContainerProbeReceiptBytes(Buffer.from(`${JSON.stringify(corrupted)}\n`))).toThrow(
      /receipt_digest_mismatch/,
    )

    const recomputedUnknown = functionalReceipt() as any
    recomputedUnknown.launchPolicy.nativeFallback = false
    expect(() => createAppContainerProbeReceiptEnvelope(recomputedUnknown)).toThrow()
  })

  it('cannot turn any nonclaim into a claim or call an unclean attempt a functional pass', () => {
    for (const key of [
      'productCapability',
      'candidateEvaluation',
      'securitySandboxClaim',
      'mainFilesystemIsolationClaim',
      'authenticated',
      'providerBackedEvaluation',
      'autonomousPromotion',
    ]) {
      const receipt = functionalReceipt() as any
      receipt.claims[key] = true
      expect(() => validateAppContainerProbeReceipt(receipt)).toThrow()
    }

    for (const key of ['treeRetired', 'profileDeleted', 'operationRootDeleted']) {
      const receipt = functionalReceipt() as any
      receipt.cleanup[key] = false
      expect(() => validateAppContainerProbeReceipt(receipt)).toThrow()
    }
  })

  it('accepts a bounded fail-closed receipt without converting it into functional evidence', () => {
    const receipt = failureReceipt()
    const envelope = createAppContainerProbeReceiptEnvelope(receipt)
    const verified = verifyAppContainerProbeReceiptBytes(serializeAppContainerProbeReceiptEnvelope(envelope))
    expect(verified.staticVerifierExitCode).toBe(0)
    expect(verified.liveProbeExitCode).toBe(1)
    expect(verified.receipt).toMatchObject({
      outcome: 'failed_vm_disposal_required',
      state: { phases: ['prepared'], finalPhase: 'prepared' },
      cleanup: { status: 'unconfirmed', externalVmDisposalRequired: true },
    })
  })

  it('binds admission status to the exact state prefix and rejects the stale provider claim key', () => {
    const deniedWithProgress = failureReceipt()
    deniedWithProgress.state = { phases: ['prepared', 'admitted'], finalPhase: 'admitted' }
    expect(() => validateAppContainerProbeReceipt(deniedWithProgress)).toThrow()

    const admittedWithoutPhase = failureReceipt()
    admittedWithoutPhase.admission = admittedFacts()
    admittedWithoutPhase.provenance = functionalReceipt().provenance
    expect(() => validateAppContainerProbeReceipt(admittedWithoutPhase)).toThrow()

    const staleClaim = functionalReceipt()
    staleClaim.claims.providerBacked = false
    delete staleClaim.claims.providerBackedEvaluation
    expect(() => validateAppContainerProbeReceipt(staleClaim)).toThrow()
  })

  it('snapshots ordinary enumerable data and rejects accessors, hidden fields, symbols, and prototype keys', () => {
    const accessor = functionalReceipt()
    Object.defineProperty(accessor.claims, 'productCapability', {
      enumerable: true,
      get: () => false,
    })
    expect(() => validateAppContainerProbeReceipt(accessor)).toThrow()

    const hidden = functionalReceipt()
    Object.defineProperty(hidden.cleanup, 'hiddenPath', { value: 'C:\\hidden', enumerable: false })
    expect(() => validateAppContainerProbeReceipt(hidden)).toThrow()

    const symbol = functionalReceipt()
    Object.defineProperty(symbol, Symbol('secret'), { value: 'opaque', enumerable: true })
    expect(() => validateAppContainerProbeReceipt(symbol)).toThrow()

    const prototypeKey = functionalReceipt()
    Object.defineProperty(prototypeKey, '__proto__', { value: null, enumerable: true })
    expect(() => validateAppContainerProbeReceipt(prototypeKey)).toThrow()

    const original = functionalReceipt()
    const validated = validateAppContainerProbeReceipt(original)
    original.claims.productCapability = true
    expect((validated as any).claims.productCapability).toBe(false)
  })

  it('binds every specific failure code to coherent admission, evidence, and cleanup state', () => {
    const deniedWithProvenance = failureReceipt()
    deniedWithProvenance.provenance = functionalReceipt().provenance
    expect(() => validateAppContainerProbeReceipt(deniedWithProvenance)).toThrow()

    const candidateAsProbe = functionalReceipt()
    candidateAsProbe.provenance.probePayload.sha256 = candidateAsProbe.provenance.installedCandidate.sha256
    expect(() => validateAppContainerProbeReceipt(candidateAsProbe)).toThrow(/probe_payload_not_distinct/)

    const staleAdmissionFailure = functionalReceipt()
    staleAdmissionFailure.outcome = 'failed_vm_disposal_required'
    staleAdmissionFailure.failure = { stage: 'prepared', code: 'admission_denied' }
    expect(() => validateAppContainerProbeReceipt(staleAdmissionFailure)).toThrow()

    const matchingGateFailure = functionalReceipt()
    matchingGateFailure.outcome = 'failed_vm_disposal_required'
    matchingGateFailure.failure = { stage: 'gate_evidence_observed', code: 'gate_mismatch' }
    expect(() => validateAppContainerProbeReceipt(matchingGateFailure)).toThrow()
    matchingGateFailure.gates[0].observed = 'unknown'
    expect((validateAppContainerProbeReceipt(matchingGateFailure) as any).failure.code).toBe('gate_mismatch')

    const cleanupFailure = functionalReceipt()
    cleanupFailure.outcome = 'failed_vm_disposal_required'
    cleanupFailure.state = {
      phases: APPCONTAINER_PROBE_PHASES.slice(0, 7),
      finalPhase: 'gate_evidence_observed',
    }
    cleanupFailure.cleanup.status = 'unconfirmed'
    cleanupFailure.failure = { stage: 'gate_evidence_observed', code: 'cleanup_unconfirmed' }
    expect(() => validateAppContainerProbeReceipt(cleanupFailure)).toThrow()
    cleanupFailure.cleanup.operationRootDeleted = false
    expect((validateAppContainerProbeReceipt(cleanupFailure) as any).failure.code).toBe('cleanup_unconfirmed')

    const recoveredRetirement = functionalReceipt()
    recoveredRetirement.outcome = 'failed_vm_disposal_required'
    recoveredRetirement.failure = { stage: 'supervisor_published', code: 'tree_retirement_unconfirmed' }
    expect(() => validateAppContainerProbeReceipt(recoveredRetirement)).toThrow()
  })
})

function admissionFixture() {
  return {
    platform: 'win32',
    arch: 'x64',
    stdinIsTTY: true,
    stdoutIsTTY: true,
    ci: false,
    githubActions: false,
    disposableVm: true,
    checkpointConfirmed: true,
    confirmationPhrase: APPCONTAINER_PROBE_CONFIRMATION_PHRASE,
    operator: {
      dedicatedAccount: true,
      standardUser: true,
      administratorsGroupAbsent: true,
      elevated: false,
      integrity: 'medium',
    },
    installedCandidate: provenance('1', 4096),
    probePayload: provenance('2', 8192),
    storage: {
      boundedPrivateRoot: true,
      freshOperationRoot: true,
      preexistingReceiptAbsent: true,
      sealedToolCopyPlanned: true,
      boundedControlledSentinels: true,
    },
  }
}

function provenance(character: string, bytes: number) {
  return {
    sha256: character.repeat(64),
    bytes,
    preexisting: true,
    regularFile: true,
    reparsePoint: false,
    machine: 'x64',
  }
}

function functionalReceipt(): any {
  return {
    schemaVersion: 1,
    kind: 'prime_continuim_appcontainer_probe_v1',
    outcome: 'functional_passed_vm_disposal_required',
    correlationId: '4'.repeat(32),
    platform: 'win32',
    arch: 'x64',
    admission: admittedFacts(),
    provenance: {
      installedCandidate: { role: 'correlation_only_not_executed', sha256: '1'.repeat(64), bytes: 4096 },
      probePayload: { role: 'dedicated_probe_payload_executed', sha256: '2'.repeat(64), bytes: 8192 },
    },
    launchPolicy: launchPolicy(),
    state: { phases: [...APPCONTAINER_PROBE_PHASES], finalPhase: 'settled' },
    supervisorEvidence: { sha256: '3'.repeat(64), bytes: 1024 },
    gates: gateRecords(),
    cleanup: {
      status: 'complete',
      treeRetired: true,
      profileDeleted: true,
      operationRootDeleted: true,
      publicationMode: 'host_no_replace',
      externalVmDisposalRequired: true,
      externalVmDisposalConfirmed: false,
    },
    claims: falseClaims(),
    limitations: limitations(),
    failure: null,
  }
}

function failureReceipt(): any {
  const admission = admittedFacts()
  admission.status = 'denied'
  admission.preexistingProvenanceMatched = false
  return {
    ...functionalReceipt(),
    outcome: 'failed_vm_disposal_required',
    admission,
    provenance: null,
    state: { phases: ['prepared'], finalPhase: 'prepared' },
    supervisorEvidence: null,
    gates: [],
    cleanup: {
      status: 'unconfirmed',
      treeRetired: false,
      profileDeleted: false,
      operationRootDeleted: false,
      publicationMode: 'host_no_replace',
      externalVmDisposalRequired: true,
      externalVmDisposalConfirmed: false,
    },
    failure: { stage: 'prepared', code: 'admission_denied' },
  }
}

function admittedFacts(): any {
  return {
    status: 'admitted',
    interactive: true,
    ciForbidden: true,
    disposableVm: true,
    checkpointConfirmed: true,
    typedConfirmation: true,
    dedicatedStandardAccount: true,
    operatorNonAdmin: true,
    operatorMediumIntegrity: true,
    operatorNotElevated: true,
    preexistingProvenanceMatched: true,
    dedicatedProbePayload: true,
  }
}

function launchPolicy() {
  return {
    stableProfileApisOnly: true,
    startupInfoEx: true,
    securityCapabilitiesAttribute: true,
    jobListAtCreateProcess: true,
    inheritHandles: false,
    allApplicationPackagesOptOut: true,
    zeroCapabilities: true,
    sealedToolTreeReadExecuteOnly: true,
    scratchAndProfileReadWriteOnly: true,
    noWritableExecutableClosure: true,
    experimentalApi: false,
    fallback: false,
  }
}

function gateRecords() {
  return APPCONTAINER_PROBE_GATE_SPECS.map(({ id, expected }) => ({ id, expected, observed: expected }))
}

function falseClaims() {
  return {
    productCapability: false,
    candidateEvaluation: false,
    securitySandboxClaim: false,
    mainFilesystemIsolationClaim: false,
    authenticated: false,
    providerBackedEvaluation: false,
    autonomousPromotion: false,
  }
}

function limitations() {
  return {
    controlledSentinelsOnly: true,
    windowsSystemReadsOutsideSentinelsMayRemain: true,
    installedCandidateCorrelationOnly: true,
    installedCandidateExecuted: false,
    candidateEvaluated: false,
    externalVmDisposalRequired: true,
  }
}
