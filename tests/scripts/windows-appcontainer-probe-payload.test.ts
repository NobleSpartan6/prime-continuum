import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  APPCONTAINER_PROBE_CHILD_GATE_CONTRACT_SHA256,
  APPCONTAINER_PROBE_CHILD_GATE_SPECS,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_BYTES,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_BYTES,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_OFFSET,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_HEADER_BYTES,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_COUNT,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_SPECS,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_ENTRY_BYTES,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_OFFSET,
  APPCONTAINER_PROBE_PAYLOAD_OBSERVATION_CODES,
  APPCONTAINER_PROBE_PAYLOAD_PIPE_PREFIX,
  APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS,
  APPCONTAINER_PROBE_PAYLOAD_RESULT_CODES,
  createAppContainerProbePayloadEvidence,
  createAppContainerProbePayloadManifest,
  validateAppContainerProbePayloadEvidence,
  validateAppContainerProbePayloadManifest,
  type AppContainerProbePayloadEvidenceExpectation,
  type AppContainerProbePayloadManifestExpectation,
  type AppContainerProbePayloadObservation,
} from '../../scripts/windows-appcontainer-probe-payload-protocol.mjs'
import { APPCONTAINER_PROBE_GATE_SPECS } from '../../scripts/windows-appcontainer-probe-lib.mjs'

const FROZEN_CHILD_GATE_CONTRACT_SHA256 = 'b56fcffe35cb6a9f7a4f5c8fb6edf523f4e075f383365dde84606968a98a766f'
const FROZEN_MANIFEST_SHA256 = '08c347ad67ee5e6d995184e05921c1442520fd780ea53245a4dfd340f32acf6f'
const FROZEN_EVIDENCE_PREFIX_SHA256 = '6ce26e4e4bdba17d0638045d87172e7b5057322a0b2147c1d222c918188374a1'
const FROZEN_EVIDENCE_SHA256 = '061f857dee7a1d17624f3d2c1fc2140f8a4a4efc217ea7418d80ff59f571a266'

describe('Windows AppContainer probe payload byte protocol', () => {
  it('freezes the exact child-gate contract, manifest records, and canonical passing vector', () => {
    const supervisorOnly = new Set([
      'job_membership_at_process_creation',
      'launch_handle_inheritance_disabled',
      'no_writable_executable_closure',
    ])
    expect(APPCONTAINER_PROBE_GATE_SPECS).toHaveLength(34)
    expect(APPCONTAINER_PROBE_CHILD_GATE_SPECS).toEqual(
      APPCONTAINER_PROBE_GATE_SPECS.filter(({ id }) => !supervisorOnly.has(id)),
    )
    expect(APPCONTAINER_PROBE_CHILD_GATE_SPECS).toHaveLength(31)
    expect(APPCONTAINER_PROBE_CHILD_GATE_CONTRACT_SHA256).toBe(FROZEN_CHILD_GATE_CONTRACT_SHA256)

    expect(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_SPECS.map(({ type }) => type))
      .toEqual(Array.from({ length: 17 }, (_, index) => index + 1))
    expect(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_SPECS.map(({ encoding }) => encoding)).toEqual([
      APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.binarySid,
      APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.emptyUtf16leEnvironment,
      ...Array(10).fill(APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.utf16leNullTerminated),
      APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.uint32LittleEndian,
      APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.handleAndRandom,
      ...Array(3).fill(APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.sockaddrIn),
    ])

    const manifest = createAppContainerProbePayloadManifest(manifestFixture())
    const summary = validateAppContainerProbePayloadManifest(manifest, manifestExpectation())
    expect(summary).toEqual({
      schemaVersion: 1,
      kind: 'prime_continuim_appcontainer_probe_payload_manifest_v1',
      sha256: FROZEN_MANIFEST_SHA256,
      bytes: 1184,
      ...manifestExpectation(),
      childGateContractSha256: FROZEN_CHILD_GATE_CONTRACT_SHA256,
      recordCount: 17,
    })

    expect(manifest.subarray(0, 8).toString('ascii')).toBe('PCAPM001')
    expect(manifest.readUInt16LE(0x08)).toBe(1)
    expect(manifest.readUInt16LE(0x0a)).toBe(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_HEADER_BYTES)
    expect(manifest.readUInt32LE(0x0c)).toBe(manifest.byteLength)
    expect(manifest.readUInt32LE(0x10)).toBe(0)
    expect(manifest.readUInt32LE(0x14)).toBe(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_COUNT)
    expect(manifest.subarray(0x18, 0x28).toString('hex')).toBe(manifestFixture().correlationId)
    expect(manifest.subarray(0x28, 0x48).toString('hex')).toBe(manifestFixture().payloadSha256)
    expect(manifest.readBigUInt64LE(0x48)).toBe(BigInt(manifestFixture().payloadBytes))
    expect(manifest.subarray(0x50, 0x70).toString('hex')).toBe(FROZEN_CHILD_GATE_CONTRACT_SHA256)
    expect(manifest.readUInt32LE(0x70)).toBe(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_OFFSET)
    expect(manifest.readUInt32LE(0x74)).toBe(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_ENTRY_BYTES)
    expect(manifest.readUInt32LE(0x78)).toBe(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET)
    expect(manifest.readUInt32LE(0x7c)).toBe(manifest.byteLength - APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET)
    expect(manifest.subarray(0x80, 0xa0)).toEqual(Buffer.alloc(32))

    expect(record(manifest, 0)).toEqual(Buffer.from([
      1, 8, 0, 0, 0, 0, 0, 15,
      2, 0, 0, 0,
      1, 0, 0, 0,
      2, 0, 0, 0,
      3, 0, 0, 0,
      4, 0, 0, 0,
      5, 0, 0, 0,
      6, 0, 0, 0,
      7, 0, 0, 0,
    ]))
    expect(record(manifest, 1)).toEqual(Buffer.alloc(4))
    expect(record(manifest, 11).toString('utf16le').replace(/\0$/u, '')).toBe(
      `${APPCONTAINER_PROBE_PAYLOAD_PIPE_PREFIX}${manifestFixture().correlationId}`,
    )
    expect(record(manifest, 14)).toEqual(Buffer.from([2, 0, 0, 9, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]))
    expect(record(manifest, 15)).toEqual(Buffer.from([2, 0, 0, 9, 192, 168, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]))
    expect(record(manifest, 16)).toEqual(Buffer.from([2, 0, 0, 9, 192, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0]))
    expect(JSON.stringify(summary)).not.toMatch(/[A-Z]:\\|S-1-15-2/u)
  })

  it('rejects noncanonical inputs, colliding paths, zero bindings, and pseudo handles', () => {
    for (const mutate of [
      (value: any) => { value.correlationId = '0'.repeat(32) },
      (value: any) => { value.payloadSha256 = '0'.repeat(64) },
      (value: any) => { value.packageSid = 'S-1-15-2-01-2-3-4-5-6-7' },
      (value: any) => { value.packageSid = 'S-1-15-3-1-2-3-4-5-6-7' },
      (value: any) => { value.profilePath = 'c:\\ProbeProfile' },
      (value: any) => { value.profilePath = 'C:/ProbeProfile' },
      (value: any) => { value.controlledFileSentinelPaths.out = value.controlledFileSentinelPaths.runtime },
      (value: any) => { value.controlledFileSentinelPaths.out = `${value.profilePath}\\sentinel.bin` },
      (value: any) => { value.inheritedHandleSentinel.handle = 0xffff_ffff_ffff_ffffn },
      (value: any) => { value.inheritedHandleSentinel.random = Buffer.alloc(32) },
      (value: any) => { value.unexpected = true },
    ]) {
      const value = manifestFixture() as any
      mutate(value)
      expect(() => createAppContainerProbePayloadManifest(value)).toThrow()
    }
  })

  it('rejects malformed, noncanonical, overlapping, padded, extended, and cross-fed manifests', () => {
    const manifest = createAppContainerProbePayloadManifest(manifestFixture())
    const expected = manifestExpectation()
    const paddingOffset = tableRecordOffset(manifest, 1) + tableRecordBytes(manifest, 1)

    const corruptions: Buffer[] = [
      changed(manifest, (value) => { value[0] = value[0]! ^ 1 }),
      changed(manifest, (value) => { value.writeUInt32LE(1, 0x10) }),
      changed(manifest, (value) => { value.fill(0, 0x18, 0x28) }),
      changed(manifest, (value) => { value.fill(0, 0x28, 0x48) }),
      changed(manifest, (value) => { value[0x50] = value[0x50]! ^ 1 }),
      changed(manifest, (value) => { value.writeUInt32LE(272, 0x74) }),
      changed(manifest, (value) => { value[0x80] = 1 }),
      changed(manifest, (value) => { value.writeUInt16LE(2, tableOffset(0)) }),
      changed(manifest, (value) => { value.writeUInt16LE(99, tableOffset(2) + 2) }),
      changed(manifest, (value) => { value.writeUInt32LE(1, tableOffset(4) + 12) }),
      changed(manifest, (value) => { value.writeUInt32LE(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET, tableOffset(1) + 4) }),
      changed(manifest, (value) => { value[paddingOffset] = 1 }),
      changed(manifest, (value) => { value[tableRecordOffset(value, 0)] = 2 }),
      changed(manifest, (value) => { value[tableRecordOffset(value, 1)] = 1 }),
      changed(manifest, (value) => { value[tableRecordOffset(value, 2) + 4] = 0x2f }),
      changed(manifest, (value) => {
        const offset = tableRecordOffset(value, 11) + 4
        value[offset] = value[offset]! ^ 1
      }),
      changed(manifest, (value) => { value.writeUInt32LE(0, tableRecordOffset(value, 12)) }),
      changed(manifest, (value) => { value.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, tableRecordOffset(value, 13)) }),
      changed(manifest, (value) => { value[tableRecordOffset(value, 15) + 4] = 10 }),
      manifest.subarray(0, manifest.byteLength - 1),
      Buffer.concat([manifest, Buffer.alloc(1)]),
      changed(Buffer.concat([manifest, Buffer.alloc(8)]), (value) => {
        value.writeUInt32LE(value.byteLength, 0x0c)
        value.writeUInt32LE(value.byteLength - APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET, 0x7c)
      }),
    ]
    for (const corrupted of corruptions) {
      expect(() => validateAppContainerProbePayloadManifest(corrupted, expected)).toThrow()
    }

    for (const crossFeed of [
      { ...expected, correlationId: '3'.repeat(32) },
      { ...expected, payloadSha256: '4'.repeat(64) },
      { ...expected, payloadBytes: expected.payloadBytes + 1 },
    ]) {
      expect(() => validateAppContainerProbePayloadManifest(manifest, crossFeed)).toThrow(/manifest_cross_feed/u)
    }
    expect(() => validateAppContainerProbePayloadManifest(manifest, {
      ...expected,
      profilePath: 'C:\\ignored-but-sensitive',
    } as any)).toThrow(/manifest_expectation_invalid/u)
  })

  it('freezes exact evidence offsets, codes, digest coverage, and path-free gate summaries', () => {
    const manifest = createAppContainerProbePayloadManifest(manifestFixture())
    const manifestSummary = validateAppContainerProbePayloadManifest(manifest, manifestExpectation())
    const binding = evidenceExpectation(manifestSummary.sha256, manifestSummary.bytes)
    const observations = matchingObservations()
    const evidence = createAppContainerProbePayloadEvidence({
      ...binding,
      result: 'complete_match',
      observations,
    })
    const summary = validateAppContainerProbePayloadEvidence(evidence, binding)

    expect(evidence.byteLength).toBe(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_BYTES)
    expect(evidence.subarray(0, 8).toString('ascii')).toBe('PCAPE001')
    expect(evidence.readUInt16LE(0x08)).toBe(1)
    expect(evidence.readUInt16LE(0x0a)).toBe(128)
    expect(evidence.readUInt32LE(0x0c)).toBe(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_BYTES)
    expect(evidence.readUInt32LE(0x10)).toBe(0)
    expect(evidence.readUInt32LE(0x14)).toBe(31)
    expect(evidence.subarray(0x18, 0x28).toString('hex')).toBe(binding.correlationId)
    expect(evidence.subarray(0x28, 0x48).toString('hex')).toBe(binding.manifestSha256)
    expect(evidence.subarray(0x48, 0x68).toString('hex')).toBe(binding.payloadSha256)
    expect(evidence.readBigUInt64LE(0x68)).toBe(BigInt(binding.payloadBytes))
    expect(evidence.readUInt32LE(0x70)).toBe(binding.manifestBytes)
    expect(evidence.readUInt32LE(0x74)).toBe(APPCONTAINER_PROBE_PAYLOAD_RESULT_CODES.complete_match)
    expect(evidence.readUInt32LE(0x78)).toBe(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_OFFSET)
    expect(evidence.readUInt32LE(0x7c)).toBe(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_BYTES)
    expect([...evidence.subarray(0x80, 0x9f)]).toEqual(
      observations.map((observed) => APPCONTAINER_PROBE_PAYLOAD_OBSERVATION_CODES[observed]),
    )
    expect(evidence[0x9f]).toBe(0)
    expect(evidence.subarray(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET).toString('hex'))
      .toBe(FROZEN_EVIDENCE_PREFIX_SHA256)
    expect(evidence.subarray(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET)).toEqual(
      createHash('sha256').update(evidence.subarray(0, APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET)).digest(),
    )
    expect(summary).toMatchObject({
      schemaVersion: 1,
      kind: 'prime_continuim_appcontainer_probe_payload_evidence_v1',
      sha256: FROZEN_EVIDENCE_SHA256,
      bytes: 192,
      ...binding,
      result: 'complete_match',
    })
    expect(Reflect.ownKeys(summary)).toEqual([
      'schemaVersion',
      'kind',
      'sha256',
      'bytes',
      'correlationId',
      'manifestSha256',
      'manifestBytes',
      'payloadSha256',
      'payloadBytes',
      'result',
      'gates',
    ])
    expect(summary.gates).toEqual(
      APPCONTAINER_PROBE_CHILD_GATE_SPECS.map(({ id, expected }) => ({ id, expected, observed: expected })),
    )
    expect(summary.gates.every((gate) => (
      Reflect.ownKeys(gate).join(',') === 'id,expected,observed'
    ))).toBe(true)
    expect(JSON.stringify(summary)).not.toMatch(/[A-Z]:\\|S-1-15-2/u)
    expect(JSON.stringify(summary)).not.toContain('PrimeContinuim.AppContainerProbe')
  })

  it('enforces complete-match, complete-nonmatch, and incomplete result coherence', () => {
    const manifest = createAppContainerProbePayloadManifest(manifestFixture())
    const manifestSummary = validateAppContainerProbePayloadManifest(manifest, manifestExpectation())
    const binding = evidenceExpectation(manifestSummary.sha256, manifestSummary.bytes)
    const matching = matchingObservations()

    const nonmatching = [...matching]
    nonmatching[0] = 'mismatched'
    expect(validateAppContainerProbePayloadEvidence(createAppContainerProbePayloadEvidence({
      ...binding,
      result: 'complete_nonmatch',
      observations: nonmatching,
    }), binding).result).toBe('complete_nonmatch')

    const incomplete = [...nonmatching]
    incomplete[1] = 'unknown'
    expect(validateAppContainerProbePayloadEvidence(createAppContainerProbePayloadEvidence({
      ...binding,
      result: 'incomplete_internal',
      observations: incomplete,
    }), binding).result).toBe('incomplete_internal')

    const notAttempted = [...matching]
    notAttempted[2] = 'not_attempted'
    expect(() => createAppContainerProbePayloadEvidence({
      ...binding,
      result: 'complete_match',
      observations: notAttempted,
    })).toThrow(/evidence_result_mismatch/u)

    expect(() => createAppContainerProbePayloadEvidence({
      ...binding,
      result: 'complete_nonmatch',
      observations: matching,
    })).toThrow(/evidence_result_mismatch/u)

    const accessorBacked = matchingObservations()
    Object.defineProperty(accessorBacked, '0', {
      enumerable: true,
      get: () => 'present',
    })
    expect(() => createAppContainerProbePayloadEvidence({
      ...binding,
      result: 'complete_match',
      observations: accessorBacked,
    })).toThrow(/evidence_input_invalid/u)
  })

  it('rejects accessors, hidden extras, and symbols across strict input shapes', () => {
    const topLevelAccessor = manifestFixture() as any
    Object.defineProperty(topLevelAccessor, 'correlationId', {
      enumerable: true,
      get: () => '1'.repeat(32),
    })
    expect(() => createAppContainerProbePayloadManifest(topLevelAccessor)).toThrow(/manifest_input_invalid/u)

    const nestedAccessor = manifestFixture() as any
    Object.defineProperty(nestedAccessor.controlledFileSentinelPaths, 'out', {
      enumerable: true,
      get: () => 'C:\\Sentinels5\\out.bin',
    })
    expect(() => createAppContainerProbePayloadManifest(nestedAccessor)).toThrow(/manifest_input_invalid/u)

    const hiddenExtra = manifestFixture() as any
    Object.defineProperty(hiddenExtra, 'hiddenPath', {
      enumerable: false,
      value: 'C:\\hidden',
    })
    expect(() => createAppContainerProbePayloadManifest(hiddenExtra)).toThrow(/manifest_input_invalid/u)

    const symbolExtra = manifestFixture() as any
    symbolExtra.controlledFileSentinelPaths[Symbol('hidden')] = 'C:\\hidden'
    expect(() => createAppContainerProbePayloadManifest(symbolExtra)).toThrow(/manifest_input_invalid/u)

    const manifest = createAppContainerProbePayloadManifest(manifestFixture())
    const manifestSummary = validateAppContainerProbePayloadManifest(manifest, manifestExpectation())
    const binding = evidenceExpectation(manifestSummary.sha256, manifestSummary.bytes)
    const evidenceAccessor = {
      ...binding,
      result: 'complete_match',
      observations: matchingObservations(),
    } as any
    Object.defineProperty(evidenceAccessor, 'result', {
      enumerable: true,
      get: () => 'complete_match',
    })
    expect(() => createAppContainerProbePayloadEvidence(evidenceAccessor)).toThrow(/evidence_input_invalid/u)

    const evidenceHidden = {
      ...binding,
      result: 'complete_match',
      observations: matchingObservations(),
    } as any
    Object.defineProperty(evidenceHidden, 'hidden', { enumerable: false, value: true })
    expect(() => createAppContainerProbePayloadEvidence(evidenceHidden)).toThrow(/evidence_input_invalid/u)

    const observationsWithSymbol = matchingObservations() as any
    observationsWithSymbol[Symbol('hidden')] = 'present'
    expect(() => createAppContainerProbePayloadEvidence({
      ...binding,
      result: 'complete_match',
      observations: observationsWithSymbol,
    })).toThrow(/evidence_input_invalid/u)
  })

  it('rejects evidence corruption, padding, stale digests, invalid codes, and every cross-feed field', () => {
    const manifest = createAppContainerProbePayloadManifest(manifestFixture())
    const manifestSummary = validateAppContainerProbePayloadManifest(manifest, manifestExpectation())
    const binding = evidenceExpectation(manifestSummary.sha256, manifestSummary.bytes)
    const evidence = createAppContainerProbePayloadEvidence({
      ...binding,
      result: 'complete_match',
      observations: matchingObservations(),
    })

    const resultMismatch = changed(evidence, (value) => {
      value.writeUInt32LE(APPCONTAINER_PROBE_PAYLOAD_RESULT_CODES.complete_nonmatch, 0x74)
      refreshEvidenceDigest(value)
    })
    const corruptions: Buffer[] = [
      changed(evidence, (value) => { value[0] = value[0]! ^ 1 }),
      changed(evidence, (value) => { value.writeUInt32LE(1, 0x10) }),
      changed(evidence, (value) => { value.fill(0, 0x18, 0x28); refreshEvidenceDigest(value) }),
      changed(evidence, (value) => { value.fill(0, 0x28, 0x48); refreshEvidenceDigest(value) }),
      changed(evidence, (value) => { value.fill(0, 0x48, 0x68); refreshEvidenceDigest(value) }),
      changed(evidence, (value) => { value.writeBigUInt64LE(0n, 0x68); refreshEvidenceDigest(value) }),
      changed(evidence, (value) => {
        value.writeUInt32LE(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET - 1, 0x70)
        refreshEvidenceDigest(value)
      }),
      changed(evidence, (value) => { value.writeUInt32LE(3, 0x74); refreshEvidenceDigest(value) }),
      changed(evidence, (value) => { value.writeUInt32LE(129, 0x78); refreshEvidenceDigest(value) }),
      changed(evidence, (value) => { value.writeUInt32LE(31, 0x7c); refreshEvidenceDigest(value) }),
      changed(evidence, (value) => { value[0x80] = 6; refreshEvidenceDigest(value) }),
      changed(evidence, (value) => { value[0x9f] = 1; refreshEvidenceDigest(value) }),
      changed(evidence, (value) => { value[0xa0] = value[0xa0]! ^ 1 }),
      resultMismatch,
      evidence.subarray(0, evidence.byteLength - 1),
      Buffer.concat([evidence, Buffer.alloc(1)]),
    ]
    for (const corrupted of corruptions) {
      expect(() => validateAppContainerProbePayloadEvidence(corrupted, binding)).toThrow()
    }

    for (const crossFeed of [
      { ...binding, correlationId: '3'.repeat(32) },
      { ...binding, manifestSha256: '4'.repeat(64) },
      { ...binding, manifestBytes: binding.manifestBytes + 1 },
      { ...binding, payloadSha256: '5'.repeat(64) },
      { ...binding, payloadBytes: binding.payloadBytes + 1 },
    ]) {
      expect(() => validateAppContainerProbePayloadEvidence(evidence, crossFeed)).toThrow(/evidence_cross_feed/u)
    }
    expect(() => validateAppContainerProbePayloadEvidence(evidence, {
      ...binding,
      profilePath: 'C:\\ignored-but-sensitive',
    } as any)).toThrow(/evidence_expectation_invalid/u)
    expect(() => validateAppContainerProbePayloadEvidence(manifest, binding)).toThrow(/evidence_size_invalid/u)
    expect(() => validateAppContainerProbePayloadManifest(evidence, manifestExpectation())).toThrow(/manifest_invalid/u)
  })
})

function manifestFixture() {
  return {
    correlationId: '1'.repeat(32),
    payloadSha256: '2'.repeat(64),
    payloadBytes: 8192,
    packageSid: 'S-1-15-2-1-2-3-4-5-6-7',
    profilePath: 'C:\\ProbeProfile',
    controlledFileSentinelPaths: {
      mainWorkspace: 'C:\\Sentinels1\\main.bin',
      userProfile: 'C:\\Sentinels2\\user.bin',
      credentialStore: 'C:\\Sentinels3\\cred.bin',
      runtime: 'C:\\Sentinels4\\runtime.bin',
      out: 'C:\\Sentinels5\\out.bin',
      release: 'C:\\Sentinels6\\release.bin',
      programData: 'C:\\Sentinels7\\program.bin',
      siblingTemp: 'C:\\Sentinels8\\temp.bin',
    },
    parentProcessId: 1234,
    inheritedHandleSentinel: {
      handle: 0x1234n,
      random: Buffer.alloc(32, 0x5a),
    },
  }
}

function manifestExpectation(): AppContainerProbePayloadManifestExpectation {
  const fixture = manifestFixture()
  return {
    correlationId: fixture.correlationId,
    payloadSha256: fixture.payloadSha256,
    payloadBytes: fixture.payloadBytes,
  }
}

function evidenceExpectation(
  manifestSha256: string,
  manifestBytes: number,
): AppContainerProbePayloadEvidenceExpectation {
  return {
    ...manifestExpectation(),
    manifestSha256,
    manifestBytes,
  }
}

function matchingObservations(): AppContainerProbePayloadObservation[] {
  return APPCONTAINER_PROBE_CHILD_GATE_SPECS.map(({ expected }) => expected)
}

function tableOffset(index: number): number {
  return APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_OFFSET
    + index * APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_ENTRY_BYTES
}

function tableRecordOffset(manifest: Buffer, index: number): number {
  return manifest.readUInt32LE(tableOffset(index) + 4)
}

function tableRecordBytes(manifest: Buffer, index: number): number {
  return manifest.readUInt32LE(tableOffset(index) + 8)
}

function record(manifest: Buffer, index: number): Buffer {
  const offset = tableRecordOffset(manifest, index)
  return manifest.subarray(offset, offset + tableRecordBytes(manifest, index))
}

function changed(input: Uint8Array, mutate: (value: Buffer) => void): Buffer {
  const value = Buffer.from(input)
  mutate(value)
  return value
}

function refreshEvidenceDigest(evidence: Buffer): void {
  createHash('sha256')
    .update(evidence.subarray(0, APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET))
    .digest()
    .copy(evidence, APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET)
}
