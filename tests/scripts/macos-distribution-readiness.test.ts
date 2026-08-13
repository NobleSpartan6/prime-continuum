import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MACOS_PRIVACY_PURPOSE_STRINGS,
  entitlementsContainGetTaskAllow,
  evaluateCodeSignature,
  parseCodeSignatureDisplay,
  validateMacosPrivacyPurposeStrings,
  validateNotaryReceipt,
  validateSignedStageAttestation,
  verifyMacosDistributionReadiness,
} from '../../scripts/macos-distribution-readiness-lib.mjs'

const teamId = 'ABC1234XYZ'
const bundleIdentifier = 'ai.primeintellect.continuim'
const sha = (character: string): string => character.repeat(64)

describe('macOS production distribution readiness policy', () => {
  it('parses Developer ID, ad-hoc, timestamp, Team ID, and hardened-runtime evidence', () => {
    const developer = parseCodeSignatureDisplay([
      'Identifier=ai.primeintellect.continuim',
      'CodeDirectory v=20500 size=444 flags=0x10000(runtime) hashes=3+7 location=embedded',
      'Authority=Developer ID Application: Prime (ABC1234XYZ)',
      'Timestamp=Aug 11, 2026 at 2:00:00 AM',
      'TeamIdentifier=ABC1234XYZ',
      'Runtime Version=26.4.0',
    ].join('\n'))
    expect(developer).toEqual({
      signed: true,
      identifier: bundleIdentifier,
      adHoc: false,
      teamId,
      timestamp: 'Aug 11, 2026 at 2:00:00 AM',
      hardenedRuntime: true,
    })
    expect(evaluateCodeSignature(developer, { expectedTeamId: teamId })).toEqual([])

    const adHoc = parseCodeSignatureDisplay([
      'Identifier=addon.node',
      'CodeDirectory v=20400 size=9923 flags=0x20002(adhoc,linker-signed)',
      'Signature=adhoc',
      'TeamIdentifier=not set',
    ].join('\n'))
    expect(evaluateCodeSignature(adHoc, { expectedTeamId: teamId })).toEqual([
      'AD_HOC_CODE',
      'CROSS_TEAM_CODE',
      'CODE_TIMESTAMP_MISSING',
      'CODE_HARDENED_RUNTIME_MISSING',
    ])
    expect(evaluateCodeSignature(parseCodeSignatureDisplay('', { commandSucceeded: false }))).toEqual([
      'UNSIGNED_NESTED_CODE',
    ])
    expect(parseCodeSignatureDisplay('Timestamp=none').timestamp).toBeNull()
  })

  it('rejects get-task-allow and accepts only the exact reviewed privacy copy', () => {
    const entitlements = '<plist><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>'
    expect(entitlementsContainGetTaskAllow(entitlements)).toBe(true)
    expect(
      entitlementsContainGetTaskAllow(
        '[Dict]\n\t[Key] com.apple.security.get-task-allow\n\t[Value]\n\t\t[Bool] true',
      ),
    ).toBe(true)
    expect(entitlementsContainGetTaskAllow('<plist><dict/></plist>')).toBe(false)
    const signature = parseCodeSignatureDisplay([
      'Identifier=app',
      'CodeDirectory flags=0x10000(runtime)',
      'Timestamp=Aug 11, 2026',
      `TeamIdentifier=${teamId}`,
    ].join('\n'))
    expect(evaluateCodeSignature(signature, { expectedTeamId: teamId, entitlementsText: entitlements }))
      .toContain('CODE_GET_TASK_ALLOW')
    expect(validateMacosPrivacyPurposeStrings(MACOS_PRIVACY_PURPOSE_STRINGS)).toBe(true)
    expect(validateMacosPrivacyPurposeStrings({
      ...MACOS_PRIVACY_PURPOSE_STRINGS,
      NSDownloadsFolderUsageDescription: 'Access everything.',
    })).toBe(false)
  })

  it('binds the signed stage to the exact post-sign inventory and rejects reordered stages', () => {
    const expected = {
      teamId,
      bundleIdentifier,
      arch: 'arm64',
      inventory: { machOCount: 32, bundleCount: 14, sha256: sha('1') },
      application: { fileCount: 8_000, totalBytes: 900_000_000, sha256: sha('2') },
    }
    const attestation = signedStage(expected)
    expect(validateSignedStageAttestation(attestation, expected)).toEqual([])
    expect(validateSignedStageAttestation({ ...attestation, teamId: 'ZZZ9999YYY' }, expected))
      .toContain('SIGNED_STAGE_ATTESTATION_INVALID')
    expect(validateSignedStageAttestation({
      ...attestation,
      nestedCodeSignedAt: '2026-08-11T02:03:00.000Z',
      applicationSealedAt: '2026-08-11T02:02:00.000Z',
    }, expected)).toContain('SIGNED_STAGE_ORDER_INVALID')
    expect(validateSignedStageAttestation({ ...attestation, extra: true }, expected))
      .toEqual(['SIGNED_STAGE_ATTESTATION_INVALID'])
  })

  it('binds one accepted receipt to exact DMG and signed-stage bytes', () => {
    const expected = {
      teamId,
      bundleIdentifier,
      arch: 'arm64',
      artifact: { bytes: 306_243_084, sha256: sha('3') },
      signedStageAttestationSha256: sha('4'),
      signedStageAttestedAt: '2026-08-11T02:02:00.000Z',
    }
    const receipt = notaryReceipt(expected)
    expect(validateNotaryReceipt(receipt, expected)).toEqual([])
    expect(validateNotaryReceipt({ ...receipt, artifact: { ...receipt.artifact, sha256: sha('5') } }, expected))
      .toContain('NOTARY_RECEIPT_IDENTITY_MISMATCH')
    expect(validateNotaryReceipt({ ...receipt, dmgCreatedAt: '2026-08-11T02:01:00.000Z' }, expected))
      .toContain('SIGNED_STAGE_ORDER_INVALID')
    expect(validateNotaryReceipt({ ...receipt, status: 'In Progress' }, expected))
      .toEqual(['NOTARY_RECEIPT_INVALID'])
  })

  it('keeps the current ad-hoc lane separate and emits a path-free config-only block', async () => {
    const projectPackage = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
    const policy = JSON.parse(await readFile(resolve('macos-distribution-policy.json'), 'utf8'))
    const result = await verifyMacosDistributionReadiness({
      projectRoot: resolve('.'),
      projectPackage,
      policy,
      configOnly: true,
    })
    expect(result).toMatchObject({
      kind: 'prime_continuim_macos_distribution_readiness_v1',
      mode: 'config-only',
      status: 'blocked',
    })
    const codes = (result.findings as Array<{ code: string }>).map(({ code }) => code)
    expect(codes).toEqual(expect.arrayContaining(['DEVELOPMENT_LANE_ONLY', 'PRODUCTION_TEAM_UNCONFIGURED']))
    expect(codes).not.toContain('PRIVACY_METADATA_INVALID')
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(resolve('.'))
    expect(serialized).not.toContain('/Users/')
    expect(serialized).not.toContain('release/')
  })
})

function signedStage(expected: {
  teamId: string
  bundleIdentifier: string
  arch: string
  inventory: { machOCount: number; bundleCount: number; sha256: string }
  application: { fileCount: number; totalBytes: number; sha256: string }
}) {
  return {
    schemaVersion: 1,
    kind: 'prime_continuim_macos_signed_stage_attestation_v1',
    phase: 'nested_code_signed_then_application_sealed_before_dmg',
    teamId: expected.teamId,
    bundleIdentifier: expected.bundleIdentifier,
    arch: expected.arch,
    inventory: expected.inventory,
    application: expected.application,
    nestedCodeSignedAt: '2026-08-11T02:00:00.000Z',
    applicationSealedAt: '2026-08-11T02:01:00.000Z',
    attestedAt: '2026-08-11T02:02:00.000Z',
  }
}

function notaryReceipt(expected: {
  teamId: string
  bundleIdentifier: string
  arch: string
  artifact: { bytes: number; sha256: string }
  signedStageAttestationSha256: string
}) {
  return {
    schemaVersion: 1,
    kind: 'prime_continuim_macos_notary_receipt_v1',
    status: 'Accepted',
    submissionId: '00000000-0000-4000-8000-000000000000',
    teamId: expected.teamId,
    bundleIdentifier: expected.bundleIdentifier,
    arch: expected.arch,
    artifact: expected.artifact,
    signedStageAttestationSha256: expected.signedStageAttestationSha256,
    notaryLogSha256: sha('6'),
    dmgCreatedAt: '2026-08-11T02:03:00.000Z',
    submittedAt: '2026-08-11T02:04:00.000Z',
    acceptedAt: '2026-08-11T02:05:00.000Z',
  }
}
