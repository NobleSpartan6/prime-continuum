import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  APPCONTAINER_PROBE_CHILD_GATE_CONTRACT_SHA256,
  APPCONTAINER_PROBE_CHILD_GATE_SPECS,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_BYTES,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_FILENAME_PREFIX,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_BYTES,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_OFFSET,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_MAGIC,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_FILENAME,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_HEADER_BYTES,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAGIC,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_COUNT,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_SPECS,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_ENTRY_BYTES,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_OFFSET,
  APPCONTAINER_PROBE_PAYLOAD_OBSERVATION_CODES,
  APPCONTAINER_PROBE_PAYLOAD_PARENT_NAMED_PIPE_SENTINEL_PREFIX,
  APPCONTAINER_PROBE_PAYLOAD_PROTOCOL_VERSION,
  APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS,
  APPCONTAINER_PROBE_PAYLOAD_RESULT_CODES,
  createAppContainerProbePayloadEvidence,
  createAppContainerProbePayloadManifest,
  deriveAppContainerProbePayloadEvidenceFilename,
  deriveAppContainerProbePayloadEvidencePath,
  deriveAppContainerProbePayloadParentNamedPipeSentinel,
  validateAppContainerProbePayloadEvidence,
  validateAppContainerProbePayloadManifest,
  type AppContainerProbePayloadEvidenceExpectation,
  type AppContainerProbePayloadManifestExpectation,
  type AppContainerProbePayloadObservation,
} from '../../scripts/windows-appcontainer-probe-payload-protocol.mjs'
import { APPCONTAINER_PROBE_GATE_SPECS } from '../../scripts/windows-appcontainer-probe-lib.mjs'

const FROZEN_CHILD_GATE_CONTRACT_SHA256 = 'b56fcffe35cb6a9f7a4f5c8fb6edf523f4e075f383365dde84606968a98a766f'
const FROZEN_MANIFEST_SHA256 = '06131615d09bf989a0835a4e2d62828d2f429335f7ce02afec4163b61083e5a1'
const FROZEN_EVIDENCE_PREFIX_SHA256 = 'd6613b80826a713b15481fdd77a1f02feb0db6a86a920e52fc1d2d60b8d7133d'
const FROZEN_EVIDENCE_SHA256 = 'fd35acbe52da5a4e6a319c6889bfccdb1d62c9169acd089da911e9f55583143e'

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

    expect(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET).toBe(
      APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_OFFSET
        + APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_COUNT
          * APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_ENTRY_BYTES,
    )
    expect(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_SPECS.map(({ type }) => type))
      .toEqual(Array.from({ length: 18 }, (_, index) => index + 1))
    expect(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_SPECS.map(({ name }) => name)).toEqual([
      'package_sid',
      'environment',
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
      'parent_named_pipe_sentinel',
      'parent_process_sentinel',
      'inherited_handle_sentinel',
      'loopback_network_sentinel',
      'lan_network_sentinel',
      'internet_network_sentinel',
    ])
    expect(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_SPECS.map(({ encoding }) => encoding)).toEqual([
      APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.binarySid,
      APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.emptyUtf16leEnvironment,
      ...Array(11).fill(APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.utf16leNullTerminated),
      APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.uint32LittleEndian,
      APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.handleAndRandom,
      ...Array(3).fill(APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.sockaddrIn),
    ])

    const manifest = createAppContainerProbePayloadManifest(manifestFixture())
    const summary = validateAppContainerProbePayloadManifest(manifest, manifestExpectation())
    expect(summary).toEqual({
      schemaVersion: 2,
      kind: 'prime_continuim_appcontainer_probe_payload_manifest_v2',
      sha256: FROZEN_MANIFEST_SHA256,
      bytes: 1264,
      ...manifestExpectation(),
      childGateContractSha256: FROZEN_CHILD_GATE_CONTRACT_SHA256,
      recordCount: 18,
    })

    expect(manifest.subarray(0, 8).toString('ascii')).toBe(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAGIC)
    expect(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAGIC).toBe('PCAPM002')
    expect(manifest.readUInt16LE(0x08)).toBe(APPCONTAINER_PROBE_PAYLOAD_PROTOCOL_VERSION)
    expect(APPCONTAINER_PROBE_PAYLOAD_PROTOCOL_VERSION).toBe(2)
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
    expect(record(manifest, 3).toString('utf16le').replace(/\0$/u, '')).toBe(manifestFixture().scratchRoot)
    expect(record(manifest, 12).toString('utf16le').replace(/\0$/u, '')).toBe(
      deriveAppContainerProbePayloadParentNamedPipeSentinel(manifestFixture().correlationId),
    )
    expect(record(manifest, 15)).toEqual(Buffer.from([2, 0, 0, 9, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]))
    expect(record(manifest, 16)).toEqual(Buffer.from([2, 0, 0, 9, 192, 168, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]))
    expect(record(manifest, 17)).toEqual(Buffer.from([2, 0, 0, 9, 192, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0]))
    expect(JSON.stringify(summary)).not.toMatch(/[A-Z]:\\|S-1-15-2/u)
    expect(summary).not.toHaveProperty('scratchRoot')
  })

  it('freezes a file-only output contract and keeps the correlation pipe solely as a denial sentinel', () => {
    const { correlationId, scratchRoot } = manifestFixture()
    const evidenceFilename = deriveAppContainerProbePayloadEvidenceFilename(correlationId)
    const evidencePath = deriveAppContainerProbePayloadEvidencePath(scratchRoot, correlationId)
    const denialPipe = deriveAppContainerProbePayloadParentNamedPipeSentinel(correlationId)

    expect(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_FILENAME)
      .toBe('PrimeContinuim.AppContainerProbe.PCAPM002.bin')
    expect(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_FILENAME).not.toMatch(/[\\/]/u)
    expect(evidenceFilename).toBe(`${APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_FILENAME_PREFIX}${correlationId}.bin`)
    expect(evidenceFilename).not.toMatch(/[\\/]/u)
    expect(evidenceFilename).not.toBe(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_FILENAME)
    expect(evidencePath).toBe(`${scratchRoot}\\${evidenceFilename}`)
    expect(evidencePath.startsWith(`${scratchRoot}\\`)).toBe(true)
    expect(denialPipe).toBe(`${APPCONTAINER_PROBE_PAYLOAD_PARENT_NAMED_PIPE_SENTINEL_PREFIX}${correlationId}`)
    expect(APPCONTAINER_PROBE_PAYLOAD_PARENT_NAMED_PIPE_SENTINEL_PREFIX).toContain('DenialSentinel.v2')
    expect(evidencePath).not.toContain('\\.\\pipe')
    expect(denialPipe).not.toContain('PCAPE002')

    expect(() => deriveAppContainerProbePayloadEvidenceFilename('0'.repeat(32))).toThrow()
    expect(() => deriveAppContainerProbePayloadEvidencePath('C:\\ProbeScratch\\', correlationId)).toThrow()
    expect(() => deriveAppContainerProbePayloadParentNamedPipeSentinel('g'.repeat(32))).toThrow()
  })

  it('rejects noncanonical inputs, colliding paths, zero bindings, and pseudo handles', () => {
    for (const mutate of [
      (value: any) => { value.correlationId = '0'.repeat(32) },
      (value: any) => { value.payloadSha256 = '0'.repeat(64) },
      (value: any) => { value.packageSid = 'S-1-15-2-01-2-3-4-5-6-7' },
      (value: any) => { value.packageSid = 'S-1-15-3-1-2-3-4-5-6-7' },
      (value: any) => { value.profilePath = 'c:\\ProbeProfile' },
      (value: any) => { value.profilePath = 'C:/ProbeProfile' },
      (value: any) => { value.profilePath = 'C:\\ProbeΣ' },
      (value: any) => { value.profilePath = 'C:\\COM¹' },
      (value: any) => { value.scratchRoot = 'c:\\ProbeScratch' },
      (value: any) => { value.scratchRoot = 'C:\\LPT².ext' },
      (value: any) => { value.scratchRoot = value.profilePath },
      (value: any) => { value.scratchRoot = `${value.profilePath}\\scratch` },
      (value: any) => { value.scratchRoot = 'C:\\PROBEPROFILE\\scratch' },
      (value: any) => { value.scratchRoot = value.controlledFileSentinelPaths.runtime },
      (value: any) => { value.controlledFileSentinelPaths.runtime = `${value.scratchRoot}\\sentinel.bin` },
      (value: any) => { value.controlledFileSentinelPaths.runtime = 'C:\\Safe\\COM³.bin' },
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
        Buffer.from('C:\\Sentinels1\\COM¹.bin\0', 'utf16le').copy(record(value, 4))
      }),
      changed(manifest, (value) => {
        const source = tableRecordOffset(value, 2)
        const target = tableRecordOffset(value, 3)
        value.copy(value, target, source, source + tableRecordBytes(value, 2))
      }),
      changed(manifest, (value) => {
        const offset = tableRecordOffset(value, 12) + 4
        value[offset] = value[offset]! ^ 1
      }),
      changed(manifest, (value) => { value.writeUInt32LE(0, tableRecordOffset(value, 13)) }),
      changed(manifest, (value) => { value.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, tableRecordOffset(value, 14)) }),
      changed(manifest, (value) => { value[tableRecordOffset(value, 16) + 4] = 10 }),
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

  it('binds the path-private scratch root through the manifest digest and evidence cross-feed fence', () => {
    const firstManifest = createAppContainerProbePayloadManifest(manifestFixture())
    const firstSummary = validateAppContainerProbePayloadManifest(firstManifest, manifestExpectation())
    const secondFixture = { ...manifestFixture(), scratchRoot: 'C:\\SecondScratch' }
    const secondManifest = createAppContainerProbePayloadManifest(secondFixture)
    const secondSummary = validateAppContainerProbePayloadManifest(secondManifest, manifestExpectation())
    const firstBinding = evidenceExpectation(firstSummary.sha256, firstSummary.bytes)
    const evidence = createAppContainerProbePayloadEvidence({
      ...firstBinding,
      result: 'complete_match',
      observations: matchingObservations(),
    })

    expect(firstSummary.sha256).not.toBe(secondSummary.sha256)
    expect(firstSummary).not.toHaveProperty('scratchRoot')
    expect(secondSummary).not.toHaveProperty('scratchRoot')
    expect(() => validateAppContainerProbePayloadEvidence(evidence, {
      ...firstBinding,
      manifestSha256: secondSummary.sha256,
      manifestBytes: secondSummary.bytes,
    })).toThrow(/evidence_cross_feed/u)
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
    expect(evidence.subarray(0, 8).toString('ascii')).toBe(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_MAGIC)
    expect(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_MAGIC).toBe('PCAPE002')
    expect(evidence.readUInt16LE(0x08)).toBe(APPCONTAINER_PROBE_PAYLOAD_PROTOCOL_VERSION)
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
      schemaVersion: 2,
      kind: 'prime_continuim_appcontainer_probe_payload_evidence_v2',
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
    const manifestExpectationAccessor = manifestExpectation() as any
    Object.defineProperty(manifestExpectationAccessor, 'payloadBytes', {
      enumerable: true,
      get: () => 8192,
    })
    expect(() => validateAppContainerProbePayloadManifest(manifest, manifestExpectationAccessor))
      .toThrow(/manifest_expectation_invalid/u)

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

    const evidence = createAppContainerProbePayloadEvidence({
      ...binding,
      result: 'complete_match',
      observations: matchingObservations(),
    })
    const evidenceExpectationAccessor = { ...binding } as any
    Object.defineProperty(evidenceExpectationAccessor, 'manifestBytes', {
      enumerable: true,
      get: () => binding.manifestBytes,
    })
    expect(() => validateAppContainerProbePayloadEvidence(evidence, evidenceExpectationAccessor))
      .toThrow(/evidence_expectation_invalid/u)

    const observationsWithSymbol = matchingObservations() as any
    observationsWithSymbol[Symbol('hidden')] = 'present'
    expect(() => createAppContainerProbePayloadEvidence({
      ...binding,
      result: 'complete_match',
      observations: observationsWithSymbol,
    })).toThrow(/evidence_input_invalid/u)
  })

  it('snapshots proxy descriptor values once across manifest, nested, expectation, and observation inputs', () => {
    const fixture = manifestFixture() as any
    const controlledTarget = fixture.controlledFileSentinelPaths
    fixture.controlledFileSentinelPaths = new Proxy(controlledTarget, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        return key === 'out' && descriptor !== undefined
          ? { ...descriptor, value: 'C:\\DescriptorOut\\out.bin' }
          : descriptor
      },
      get(target, key, receiver) {
        return key === 'out' ? 'C:\\GetterOut\\out.bin' : Reflect.get(target, key, receiver)
      },
    })

    const descriptorRandom = Buffer.alloc(32, 0x6a)
    const handleTarget = fixture.inheritedHandleSentinel
    fixture.inheritedHandleSentinel = new Proxy(handleTarget, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        if (descriptor === undefined) return descriptor
        if (key === 'handle') return { ...descriptor, value: 0x1111n }
        if (key === 'random') return { ...descriptor, value: descriptorRandom }
        return descriptor
      },
      get(target, key, receiver) {
        if (key === 'handle') return 0x2222n
        if (key === 'random') return Buffer.alloc(32, 0x6b)
        return Reflect.get(target, key, receiver)
      },
    })

    const manifestInput = new Proxy(fixture, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        return key === 'payloadBytes' && descriptor !== undefined
          ? { ...descriptor, value: 1 }
          : descriptor
      },
      get(target, key, receiver) {
        return key === 'payloadBytes' ? 8192 : Reflect.get(target, key, receiver)
      },
    })
    const manifest = createAppContainerProbePayloadManifest(manifestInput)
    expect(manifest.readBigUInt64LE(0x48)).toBe(1n)
    expect(record(manifest, 8).toString('utf16le').replace(/\0$/u, '')).toBe('C:\\DescriptorOut\\out.bin')
    expect(record(manifest, 14).readBigUInt64LE(0)).toBe(0x1111n)
    expect(record(manifest, 14).subarray(8)).toEqual(descriptorRandom)

    const manifestExpectationTarget = { ...manifestExpectation(), payloadBytes: 1 }
    const manifestExpectationProxy = new Proxy(manifestExpectationTarget, {
      get(target, key, receiver) {
        return key === 'payloadBytes' ? 8192 : Reflect.get(target, key, receiver)
      },
    })
    const manifestSummary = validateAppContainerProbePayloadManifest(manifest, manifestExpectationProxy)
    expect(manifestSummary.payloadBytes).toBe(1)

    const binding = {
      ...evidenceExpectation(manifestSummary.sha256, manifestSummary.bytes),
      payloadBytes: 1,
    }
    const observationTarget = matchingObservations()
    const observations = new Proxy(observationTarget, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        return key === '0' && descriptor !== undefined
          ? { ...descriptor, value: 'unknown' }
          : descriptor
      },
    })
    const evidenceInputTarget = {
      ...binding,
      result: 'complete_match',
      observations,
    }
    const evidenceInput = new Proxy(evidenceInputTarget, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        return key === 'result' && descriptor !== undefined
          ? { ...descriptor, value: 'incomplete_internal' }
          : descriptor
      },
    })
    const evidence = createAppContainerProbePayloadEvidence(evidenceInput as any)
    expect(evidence.readUInt32LE(0x74)).toBe(APPCONTAINER_PROBE_PAYLOAD_RESULT_CODES.incomplete_internal)
    expect(evidence[APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_OFFSET])
      .toBe(APPCONTAINER_PROBE_PAYLOAD_OBSERVATION_CODES.unknown)

    const evidenceExpectationProxy = new Proxy({ ...binding }, {
      get(target, key, receiver) {
        return key === 'manifestBytes' ? binding.manifestBytes + 1 : Reflect.get(target, key, receiver)
      },
    })
    expect(validateAppContainerProbePayloadEvidence(evidence, evidenceExpectationProxy).result)
      .toBe('incomplete_internal')
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

  it('rejects all never-live v1 magic and version byte combinations', () => {
    const manifest = createAppContainerProbePayloadManifest(manifestFixture())
    const manifestExpected = manifestExpectation()
    const manifestLegacyMagic = changed(manifest, (value) => { value.write('PCAPM001', 0, 'ascii') })
    const manifestLegacyVersion = changed(manifest, (value) => { value.writeUInt16LE(1, 0x08) })
    expect(() => validateAppContainerProbePayloadManifest(manifestLegacyMagic, manifestExpected))
      .toThrow(/manifest_invalid/u)
    expect(() => validateAppContainerProbePayloadManifest(manifestLegacyVersion, manifestExpected))
      .toThrow(/manifest_invalid/u)

    const manifestSummary = validateAppContainerProbePayloadManifest(manifest, manifestExpected)
    const binding = evidenceExpectation(manifestSummary.sha256, manifestSummary.bytes)
    const evidence = createAppContainerProbePayloadEvidence({
      ...binding,
      result: 'complete_match',
      observations: matchingObservations(),
    })
    const evidenceLegacyMagic = changed(evidence, (value) => {
      value.write('PCAPE001', 0, 'ascii')
      refreshEvidenceDigest(value)
    })
    const evidenceLegacyVersion = changed(evidence, (value) => {
      value.writeUInt16LE(1, 0x08)
      refreshEvidenceDigest(value)
    })
    expect(() => validateAppContainerProbePayloadEvidence(evidenceLegacyMagic, binding))
      .toThrow(/evidence_invalid/u)
    expect(() => validateAppContainerProbePayloadEvidence(evidenceLegacyVersion, binding))
      .toThrow(/evidence_invalid/u)
  })
})

function manifestFixture() {
  return {
    correlationId: '1'.repeat(32),
    payloadSha256: '2'.repeat(64),
    payloadBytes: 8192,
    packageSid: 'S-1-15-2-1-2-3-4-5-6-7',
    profilePath: 'C:\\ProbeProfile',
    scratchRoot: 'C:\\ProbeScratch',
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
