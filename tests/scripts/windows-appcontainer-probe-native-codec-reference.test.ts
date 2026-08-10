import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  APPCONTAINER_PROBE_CHILD_GATE_CONTRACT_SHA256,
  APPCONTAINER_PROBE_CHILD_GATE_SPECS,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_BYTES,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_FILENAME_PREFIX,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_BYTES,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_OFFSET,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_HEADER_BYTES,
  APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_MAGIC,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_FILENAME,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_HEADER_BYTES,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAGIC,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAX_BYTES,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_COUNT,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_SPECS,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_ENTRY_BYTES,
  APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_OFFSET,
  APPCONTAINER_PROBE_PAYLOAD_PARENT_NAMED_PIPE_SENTINEL_PREFIX,
  APPCONTAINER_PROBE_PAYLOAD_PROTOCOL_VERSION,
  APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS,
  APPCONTAINER_PROBE_PAYLOAD_OBSERVATION_CODES,
  APPCONTAINER_PROBE_PAYLOAD_RESULT_CODES,
  createAppContainerProbePayloadEvidence,
  createAppContainerProbePayloadManifest,
  validateAppContainerProbePayloadEvidence,
  validateAppContainerProbePayloadManifest,
} from '../../scripts/windows-appcontainer-probe-payload-protocol.mjs'

const NATIVE_ROOT = resolve('tools/windows-appcontainer-probe/native/payload')
const CONTRACT_PATH = resolve(NATIVE_ROOT, 'payload_contract.h')
const CODEC_HEADER_PATH = resolve(NATIVE_ROOT, 'payload_codec_reference.h')
const CODEC_SOURCE_PATH = resolve(NATIVE_ROOT, 'payload_codec_reference.c')
const RECIPE_PATH = resolve(NATIVE_ROOT, 'build-codec-reference.ps1')
const BUILD_MANIFEST_PATH = resolve(NATIVE_ROOT, 'codec-reference-build-manifest.json')

const contract = readFileSync(CONTRACT_PATH, 'utf8')
const codecHeader = readFileSync(CODEC_HEADER_PATH, 'utf8')
const codecSource = readFileSync(CODEC_SOURCE_PATH, 'utf8')
const recipe = readFileSync(RECIPE_PATH, 'utf8')
const wireSource = readFileSync(resolve('scripts/windows-appcontainer-probe-payload-protocol.mjs'), 'utf8')
const buildManifest = JSON.parse(readFileSync(BUILD_MANIFEST_PATH, 'utf8')) as any

const FROZEN_MANIFEST_SHA256 = '06131615d09bf989a0835a4e2d62828d2f429335f7ce02afec4163b61083e5a1'
const FROZEN_INCOMPLETE_EVIDENCE_PREFIX_SHA256 =
  'fd9d89ad738d87fb0a198502a1acdb8ba6f9a9067908fcb2d7db91fd88d8eb99'
const FROZEN_INCOMPLETE_EVIDENCE_SHA256 =
  '6e0471b5a625aadbb55233eda045e9f9eecf0a170471a902789bb35ff9fc7645'

describe('Windows AppContainer native in-memory codec reference', () => {
  it('freezes wire layout, numeric enums, manifest records, and every child gate to JS wire v2', () => {
    expect(cIntegerMacro('PCAP_PAYLOAD_PROTOCOL_VERSION')).toBe(APPCONTAINER_PROBE_PAYLOAD_PROTOCOL_VERSION)
    expect(cIntegerMacro('PCAP_MANIFEST_HEADER_BYTES')).toBe(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_HEADER_BYTES)
    expect(cIntegerMacro('PCAP_MANIFEST_TABLE_OFFSET')).toBe(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_OFFSET)
    expect(cIntegerMacro('PCAP_MANIFEST_TABLE_ENTRY_BYTES')).toBe(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_ENTRY_BYTES)
    expect(cIntegerMacro('PCAP_MANIFEST_RECORD_COUNT')).toBe(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_COUNT)
    expect(cIntegerMacro('PCAP_MANIFEST_BODY_OFFSET')).toBe(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET)
    expect(cIntegerMacro('PCAP_MANIFEST_MAX_BYTES')).toBe(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAX_BYTES)
    expect(cIntegerMacro('PCAP_PAYLOAD_MAX_BYTES')).toBe(64 * 1024 * 1024)
    expect(cIntegerMacro('PCAP_CANONICAL_PATH_MAX_CHARS')).toBe(4096)
    expect(cIntegerMacro('PCAP_CORRELATION_ID_BYTES')).toBe(16)
    expect(cIntegerMacro('PCAP_HEX_CHARS_PER_BYTE')).toBe(2)
    expect(wireSource).toContain('const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024')
    expect(cIntegerMacro('PCAP_EVIDENCE_BYTES')).toBe(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_BYTES)
    expect(cIntegerMacro('PCAP_EVIDENCE_HEADER_BYTES')).toBe(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_HEADER_BYTES)
    expect(cIntegerMacro('PCAP_EVIDENCE_GATE_OFFSET')).toBe(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_OFFSET)
    expect(cIntegerMacro('PCAP_EVIDENCE_GATE_BYTES')).toBe(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_BYTES)
    expect(cIntegerMacro('PCAP_EVIDENCE_DIGEST_OFFSET')).toBe(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET)
    expect(cIntegerMacro('PCAP_CHILD_GATE_COUNT')).toBe(APPCONTAINER_PROBE_CHILD_GATE_SPECS.length)
    expect(cWideStringMacro('PCAP_MANIFEST_FILENAME')).toBe(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_FILENAME)
    expect(cWideStringMacro('PCAP_EVIDENCE_FILENAME_PREFIX')).toBe(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_FILENAME_PREFIX)
    expect(cWideStringMacro('PCAP_EVIDENCE_FILENAME_EXTENSION')).toBe('.bin')
    expect(cWideStringMacro('PCAP_PIPE_SENTINEL_PREFIX')).toBe(
      APPCONTAINER_PROBE_PAYLOAD_PARENT_NAMED_PIPE_SENTINEL_PREFIX,
    )

    expect(cByteArray('PCAP_MANIFEST_MAGIC')).toEqual([...Buffer.from(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAGIC)])
    expect(cByteArray('PCAP_EVIDENCE_MAGIC')).toEqual([...Buffer.from(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_MAGIC)])
    expect(Buffer.from(cByteArray('PCAP_CHILD_GATE_CONTRACT_SHA256')).toString('hex'))
      .toBe(APPCONTAINER_PROBE_CHILD_GATE_CONTRACT_SHA256)

    expect(cEnum('pcap_record_encoding')).toEqual({
      PCAP_RECORD_BINARY_SID: APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.binarySid,
      PCAP_RECORD_EMPTY_UTF16LE_ENVIRONMENT:
        APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.emptyUtf16leEnvironment,
      PCAP_RECORD_UTF16LE_NULL_TERMINATED:
        APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.utf16leNullTerminated,
      PCAP_RECORD_UINT32_LE: APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.uint32LittleEndian,
      PCAP_RECORD_HANDLE_AND_RANDOM: APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.handleAndRandom,
      PCAP_RECORD_SOCKADDR_IN: APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.sockaddrIn,
    })
    expect(cEnum('pcap_observation')).toEqual(Object.fromEntries(
      Object.entries(APPCONTAINER_PROBE_PAYLOAD_OBSERVATION_CODES)
        .map(([name, code]) => [`PCAP_OBSERVATION_${name.toUpperCase()}`, code]),
    ))
    expect(cEnum('pcap_result')).toEqual(Object.fromEntries(
      Object.entries(APPCONTAINER_PROBE_PAYLOAD_RESULT_CODES)
        .map(([name, code]) => [`PCAP_RESULT_${name.toUpperCase()}`, code]),
    ))

    const cRecords = cRecordTable()
    const encodingTokens: Record<number, string> = {
      [APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.binarySid]: 'PCAP_RECORD_BINARY_SID',
      [APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.emptyUtf16leEnvironment]:
        'PCAP_RECORD_EMPTY_UTF16LE_ENVIRONMENT',
      [APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.utf16leNullTerminated]:
        'PCAP_RECORD_UTF16LE_NULL_TERMINATED',
      [APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.uint32LittleEndian]: 'PCAP_RECORD_UINT32_LE',
      [APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.handleAndRandom]: 'PCAP_RECORD_HANDLE_AND_RANDOM',
      [APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS.sockaddrIn]: 'PCAP_RECORD_SOCKADDR_IN',
    }
    expect(cRecords).toEqual(APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_SPECS.map((record) => ({
      number: record.type,
      name: record.name.toUpperCase(),
      encoding: encodingTokens[record.encoding],
    })))

    expect(cGateTable()).toEqual(APPCONTAINER_PROBE_CHILD_GATE_SPECS.map((gate, index) => ({
      index,
      id: gate.id,
      expected: gate.expected,
    })))
    expect(contract).toContain('PCAP_MANIFEST_RECORD_TABLE(PCAP_ASSERT_RECORD_INDEX)')
    expect(contract).toContain('PCAP_CHILD_GATE_TABLE(PCAP_ASSERT_GATE_INDEX)')
    expect(contract).toContain('sizeof(PCAP_EVIDENCE_FILENAME_PREFIX) / sizeof(wchar_t) - 1U')
    expect(contract).toContain('sizeof(PCAP_EVIDENCE_FILENAME_EXTENSION) / sizeof(wchar_t) - 1U')
    expect(contract).toContain('PCAP_CORRELATION_HEX_CHARS == 32')
    expect(contract).toContain('PCAP_EVIDENCE_FILENAME_EXTENSION_CHARS == 4')
    expect(contract).toContain('PCAP_EVIDENCE_FILENAME_CHARS == 78')
    expect(contract).toContain('PCAP_SCRATCH_ROOT_MAX_CHARS == 4017')
    expect(contract).not.toMatch(/\[\s*index\s*\]\s*=/u)
  })

  it('freezes the canonical manifest and exact all-not-attempted PCAPE002 golden vector', () => {
    const fixture = manifestFixture()
    const manifest = createAppContainerProbePayloadManifest(fixture)
    const manifestSummary = validateAppContainerProbePayloadManifest(manifest, manifestExpectation())
    expect(manifestSummary.sha256).toBe(FROZEN_MANIFEST_SHA256)
    expect(manifestSummary.bytes).toBe(1264)

    const binding = {
      ...manifestExpectation(),
      manifestSha256: manifestSummary.sha256,
      manifestBytes: manifestSummary.bytes,
    }
    const evidence = createAppContainerProbePayloadEvidence({
      ...binding,
      result: 'incomplete_internal',
      observations: APPCONTAINER_PROBE_CHILD_GATE_SPECS.map(() => 'not_attempted' as const),
    })
    const evidenceSummary = validateAppContainerProbePayloadEvidence(evidence, binding)

    expect(evidence.subarray(0, 8).toString('ascii')).toBe('PCAPE002')
    expect(evidence.readUInt32LE(0x74)).toBe(APPCONTAINER_PROBE_PAYLOAD_RESULT_CODES.incomplete_internal)
    expect([...evidence.subarray(0x80, 0x9f)]).toEqual(Array(31).fill(0))
    expect(evidence[0x9f]).toBe(0)
    expect(evidence.subarray(0xa0).toString('hex')).toBe(FROZEN_INCOMPLETE_EVIDENCE_PREFIX_SHA256)
    expect(sha256(evidence)).toBe(FROZEN_INCOMPLETE_EVIDENCE_SHA256)
    expect(evidenceSummary.result).toBe('incomplete_internal')
    expect(evidenceSummary.gates.every(({ observed }) => observed === 'not_attempted')).toBe(true)

    expect(codecSource).toContain('PCAP_RESULT_INCOMPLETE_INTERNAL')
    expect(codecSource).toContain('memset(evidence, 0, evidence_bytes)')
    expect(codecSource).toContain('pcap_sha256(evidence, PCAP_EVIDENCE_DIGEST_OFFSET,')
  })

  it('shares adversarial device-name path vectors and retains JS basename-trimming parity', () => {
    for (const adversarialPath of ['C:\\CON .txt', 'C:\\COM1 .txt']) {
      const fixture = manifestFixture()
      fixture.controlledFileSentinelPaths.mainWorkspace = adversarialPath
      expect(() => createAppContainerProbePayloadManifest(fixture)).toThrow(/manifest_path_invalid/u)
    }
    expect(codecSource).toMatch(
      /while \(basename_end > start &&[\s\S]*basename_end - 1U\) == \(uint16_t\)' '[\s\S]*--basename_end;/u,
    )

    const boundary = manifestFixture()
    boundary.controlledFileSentinelPaths.mainWorkspace = `C:\\${'a'.repeat(4093)}`
    expect(boundary.controlledFileSentinelPaths.mainWorkspace).toHaveLength(4096)
    expect(() => createAppContainerProbePayloadManifest(boundary)).not.toThrow()
    boundary.controlledFileSentinelPaths.mainWorkspace += 'a'
    expect(boundary.controlledFileSentinelPaths.mainWorkspace).toHaveLength(4097)
    expect(() => createAppContainerProbePayloadManifest(boundary)).toThrow(/manifest_path_invalid/u)
    expect(codecSource).toContain('path.chars > PCAP_CANONICAL_PATH_MAX_CHARS')

    const scratchBoundary = manifestFixture()
    scratchBoundary.scratchRoot = `C:\\${'s'.repeat(4014)}`
    expect(scratchBoundary.scratchRoot).toHaveLength(4017)
    expect(APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_FILENAME_PREFIX.length + 32 + 4).toBe(78)
    expect(() => createAppContainerProbePayloadManifest(scratchBoundary)).not.toThrow()
    scratchBoundary.scratchRoot += 's'
    expect(scratchBoundary.scratchRoot).toHaveLength(4018)
    expect(() => createAppContainerProbePayloadManifest(scratchBoundary)).toThrow(/manifest_path_invalid/u)
    expect(codecSource).toContain('PCAP_SCRATCH_ROOT_MAX_CHARS')
  })

  it('keeps the C17 implementation a pure codec with no probe, host, or operating-system actions', () => {
    expect(codecHeader).toContain('C17-only, source-only, in-memory codec reference')
    expect(codecHeader.match(/pcap_codec_(?:parse_manifest|emit_incomplete_evidence)\s*\(/gu)).toHaveLength(2)
    expect([...codecSource.matchAll(/^#include\s+([<"][^>"]+[>"])/gmu)].map((match) => match[1]))
      .toEqual(['"payload_codec_reference.h"', '<string.h>'])

    for (const forbidden of [
      'windows.h',
      'winsock',
      'CreateFile',
      'WriteFile',
      'OpenProcess',
      'GetTokenInformation',
      'CreateProcess',
      'LoadLibrary',
      'GetProcAddress',
      'BCrypt',
      'socket(',
      'connect(',
      'main(',
      'wmain(',
    ]) {
      expect(codecSource.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
    expect(codecSource).toContain('pcap_codec_parse_manifest(')
    expect(codecSource).toContain('PCAP_CODEC_MANIFEST_CROSS_FEED')
    expect(codecSource).toContain('pcap_paths_overlap(')
    expect(codecSource).toContain('pcap_validate_pipe(')
    expect(codecSource).toContain('pcap_network_sentinels')
    expect(codecSource).not.toContain('PCAP_OBSERVATION_ALLOWED')
    expect(codecSource).not.toContain('PCAP_OBSERVATION_DENIED')
  })

  it('pins source, recipe, declared MSVC/SDK identity, x64 archive flags, and explicit nonclaims', () => {
    expect(Reflect.ownKeys(buildManifest)).toEqual([
      'schemaVersion',
      'kind',
      'artifact',
      'toolchain',
      'inputs',
      'compileFlags',
      'archiveFlags',
      'sourceStatus',
      'limitations',
      'recipeSha256',
    ])
    expect(buildManifest).toMatchObject({
      schemaVersion: 1,
      kind: 'prime_continuim_appcontainer_payload_codec_reference_build_v1',
      artifact: {
        name: 'prime-continuim-appcontainer-payload-codec-reference-x64.lib',
        format: 'coff_static_library',
        machine: 'x64',
      },
      toolchain: {
        family: 'msvc',
        toolsetVersion: '14.44.35207',
        compilerFileVersion: '19.44.35219.0',
        archiverFileVersion: '14.44.35219.0',
        windowsSdkVersion: '10.0.26100.0',
        host: 'x64',
        target: 'x64',
        language: 'c17',
      },
      sourceStatus: {
        classification: 'source_only_codec_reference',
        compiledLocally: false,
        executedLocally: false,
        liveProbeActions: false,
        productIntegrated: false,
      },
    })
    expect(Reflect.ownKeys(buildManifest.artifact)).toEqual(['name', 'format', 'machine'])
    expect(Reflect.ownKeys(buildManifest.toolchain)).toEqual([
      'family',
      'toolsetVersion',
      'compilerFileVersion',
      'archiverFileVersion',
      'windowsSdkVersion',
      'host',
      'target',
      'language',
    ])
    expect(Reflect.ownKeys(buildManifest.sourceStatus)).toEqual([
      'classification',
      'compiledLocally',
      'executedLocally',
      'liveProbeActions',
      'productIntegrated',
    ])
    expect(buildManifest.inputs.map(({ path }: { path: string }) => path)).toEqual([
      'payload_codec_reference.c',
      'payload_codec_reference.h',
      'payload_contract.h',
    ])
    for (const input of buildManifest.inputs) {
      expect(Reflect.ownKeys(input)).toEqual(['path', 'sha256', 'bytes'])
      const path = resolve(NATIVE_ROOT, input.path)
      expect(statSync(path).size).toBe(input.bytes)
      expect(sha256(readFileSync(path))).toBe(input.sha256)
      expect(recipe).toContain(`sha256 = '${input.sha256}'`)
      expect(recipe).toContain(`bytes = ${input.bytes}`)
    }
    expect(sha256(readFileSync(RECIPE_PATH))).toBe(buildManifest.recipeSha256)
    expect(buildManifest.compileFlags).toEqual([
      '/nologo',
      '/c',
      '/TC',
      '/std:c17',
      '/O2',
      '/Oi',
      '/GL',
      '/GS',
      '/guard:cf',
      '/sdl',
      '/W4',
      '/WX',
      '/MT',
      '/ZH:SHA_256',
      '/Brepro',
      '/volatile:iso',
      '/Zc:inline',
      '/diagnostics:caret',
      '/D_CRT_SECURE_NO_WARNINGS',
    ])
    expect(buildManifest.archiveFlags).toEqual([
      '/NOLOGO',
      '/MACHINE:X64',
      '/LTCG',
      '/BREPRO',
      '/WX',
    ])
    expect(buildManifest.limitations.join(' ')).toMatch(/not executed or cited/u)
    expect(buildManifest.limitations.join(' ')).toMatch(/No PE executable/u)
    expect(buildManifest.limitations.join(' ')).toMatch(/installed candidate remains untouched/u)
  })

  it('keeps the opt-in unexecuted reference recipe outside every product and package entry point', () => {
    expect(recipe).toContain("throw 'MSVC executable version differs'")
    expect(recipe).toContain("throw 'pinned Windows SDK version is absent'")
    expect(recipe).toContain('throw "pinned input digest differs"')
    expect(recipe).toContain("throw 'output directory must not already exist'")
    expect(recipe).toContain("executed = $false")
    expect(recipe).toContain("peImportClosureInspected = $false")
    expect(recipe).not.toMatch(/&\s*\$libraryPath/u)

    const packageJson = readFileSync(resolve('package.json'), 'utf8')
    const workflow = readFileSync(resolve('scripts/run-workflow.mjs'), 'utf8')
    const selfBuild = readFileSync(resolve('scripts/self-build.mjs'), 'utf8')
    const gitAttributes = readFileSync(resolve('.gitattributes'), 'utf8')
    expect(packageJson).not.toContain('build-codec-reference')
    expect(workflow).not.toContain('build-codec-reference')
    expect(selfBuild).not.toContain('build-codec-reference')
    expect(packageJson).not.toContain('payload-codec-reference')
    expect(workflow).not.toContain('payload-codec-reference')
    expect(selfBuild).not.toContain('payload-codec-reference')
    expect(gitAttributes).toContain(
      'tools/windows-appcontainer-probe/native/payload/* text eol=lf',
    )
  })
})

function cIntegerMacro(name: string): number {
  const match = contract.match(new RegExp(`#define\\s+${name}\\s+UINT(?:16|32|64)_C\\((\\d+)\\)`, 'u'))
  if (match?.[1] === undefined) throw new Error(`missing C integer macro ${name}`)
  return Number(match[1])
}

function cWideStringMacro(name: string): string {
  const match = contract.match(new RegExp(`#define\\s+${name}\\s+L"((?:\\\\.|[^"])*)"`, 'u'))
  if (match?.[1] === undefined) throw new Error(`missing C string macro ${name}`)
  return JSON.parse(`"${match[1]}"`) as string
}

function cByteArray(name: string): number[] {
  const match = contract.match(new RegExp(
    `static const uint8_t ${name}\\[[^\\]]+\\] = \\{([\\s\\S]*?)\\n\\};`,
    'u',
  ))
  if (match?.[1] === undefined) throw new Error(`missing C byte array ${name}`)
  return [...match[1].matchAll(/0x([a-f0-9]{2})|'(.)'/giu)].map((token) => (
    token[1] === undefined ? token[2]!.charCodeAt(0) : Number.parseInt(token[1], 16)
  ))
}

function cEnum(name: string): Record<string, number> {
  const match = contract.match(new RegExp(`enum\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\};`, 'u'))
  if (match?.[1] === undefined) throw new Error(`missing C enum ${name}`)
  return Object.fromEntries(
    [...match[1].matchAll(/(PCAP_[A-Z0-9_]+)\s*=\s*(\d+)/gu)]
      .map((entry) => [entry[1]!, Number(entry[2])]),
  )
}

function cRecordTable(): Array<{ number: number; name: string; encoding: string }> {
  const block = contract.slice(
    contract.indexOf('#define PCAP_MANIFEST_RECORD_TABLE(X)'),
    contract.indexOf('enum pcap_record_index'),
  )
  return [...block.matchAll(
    /X\(\s*(\d+),\s*([A-Z0-9_]+),\s*(PCAP_RECORD_[A-Z0-9_]+)\)/gu,
  )].map((match) => ({ number: Number(match[1]), name: match[2]!, encoding: match[3]! }))
}

function cGateTable(): Array<{ index: number; id: string; expected: string }> {
  const block = contract.slice(
    contract.indexOf('#define PCAP_CHILD_GATE_TABLE(X)'),
    contract.indexOf('enum pcap_gate_index'),
  )
  return [...block.matchAll(
    /X\(\s*(\d+),\s*[A-Z0-9_]+,\s*"([a-z0-9_]+)",\s*PCAP_OBSERVATION_([A-Z_]+)\)/gu,
  )].map((match) => ({
    index: Number(match[1]),
    id: match[2]!,
    expected: match[3]!.toLowerCase(),
  }))
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

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

function manifestExpectation() {
  const fixture = manifestFixture()
  return {
    correlationId: fixture.correlationId,
    payloadSha256: fixture.payloadSha256,
    payloadBytes: fixture.payloadBytes,
  }
}
