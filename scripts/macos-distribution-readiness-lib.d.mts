export const MACOS_PRIVACY_PURPOSE_STRINGS: Readonly<Record<string, string>>

export function parseCodeSignatureDisplay(
  text: unknown,
  options?: { commandSucceeded?: boolean },
): Readonly<{
  signed: boolean
  identifier: string | null
  adHoc: boolean
  teamId: string | null
  timestamp: string | null
  hardenedRuntime: boolean
}>

export function entitlementsContainGetTaskAllow(text: unknown): boolean

export function evaluateCodeSignature(
  signature: ReturnType<typeof parseCodeSignatureDisplay>,
  options?: { expectedTeamId?: string; entitlementsText?: string; requireHardenedRuntime?: boolean },
): readonly string[]

export function validateMacosPrivacyPurposeStrings(value: unknown): boolean

export function validateSignedStageAttestation(value: unknown, expected: Record<string, any>): readonly string[]

export function validateNotaryReceipt(value: unknown, expected: Record<string, any>): readonly string[]

export function verifyMacosDistributionReadiness(options: {
  projectRoot: string
  projectPackage: Record<string, any>
  policy: Record<string, any>
  configOnly?: boolean
}): Promise<Readonly<Record<string, any>>>
