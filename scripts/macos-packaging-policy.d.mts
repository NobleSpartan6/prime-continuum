export const MACOS_PACKAGING_DENIED_ENVIRONMENT_KEYS: readonly string[]
export const MACOS_DMG_ARTIFACT_TEMPLATE: 'Prime-Continuim-${version}-macos-${arch}.${ext}'
export const MACOS_REVIEWED_SYSTEM_PATH: '/usr/bin:/bin:/usr/sbin:/sbin'

export function createMacosReviewedPath(nodeExecutable?: string): string

export function assertMacosSystemToolCustody(): Promise<void>

export function createMacosElectronBuilderArguments(options?: {
  arch?: NodeJS.Architecture
  directoryOnly?: boolean
}): readonly string[]

export function createMacosDmgBuilderPlan(options?: {
  arch?: NodeJS.Architecture
}): readonly [
  {
    readonly kind: 'node'
    readonly label: string
    readonly script: 'scripts/verify-macos-dmg.mjs'
    readonly args: readonly ['--config-only']
  },
  {
    readonly kind: 'node'
    readonly label: string
    readonly script: 'scripts/verify-macos-dmg.mjs'
    readonly args: readonly ['--prepare']
  },
  {
    readonly kind: 'pnpm'
    readonly label: string
    readonly args: readonly string[]
  },
]

export function createMacosPackagingBuilderPlan(options?: {
  arch?: NodeJS.Architecture
}): readonly [
  {
    readonly kind: 'node'
    readonly label: string
    readonly script: 'scripts/verify-macos-package.mjs'
    readonly args: readonly ['--config-only']
  },
  {
    readonly kind: 'pnpm'
    readonly label: string
    readonly args: readonly string[]
  },
]

export function createMacosPackagingEnvironment(
  source?: NodeJS.ProcessEnv,
  nodeExecutable?: string,
): NodeJS.ProcessEnv

export function resolveMacosPackageDirectory(
  projectRoot: string,
  arch?: NodeJS.Architecture,
): string

export function resolveMacosDmgArtifact(
  projectRoot: string,
  projectPackage: Record<string, any>,
  arch?: NodeJS.Architecture,
): {
  readonly artifactName: string
  readonly artifactPath: string
  readonly blockmapPath: string
  readonly checksumPath: string
  readonly updateMetadataPath: string
  readonly verificationJournalPath: string
  readonly legacyArtifactPaths: readonly string[]
}

export function assertMacosDevelopmentPackageConfiguration(
  projectPackage: Record<string, any>,
  options: { projectRoot: string },
): {
  readonly identity: 'ad-hoc'
  readonly notarized: false
  readonly directoryOnly: true
  readonly packageDirectory: string
}

export function assertMacosDmgDistributionConfiguration(
  projectPackage: Record<string, any>,
  options: { projectRoot: string; arch?: NodeJS.Architecture },
): {
  readonly identity: 'ad-hoc'
  readonly notarized: false
  readonly target: 'dmg'
  readonly arch: NodeJS.Architecture
  readonly artifactName: string
  readonly artifactPath: string
  readonly blockmapPath: string
  readonly checksumPath: string
  readonly updateMetadataPath: string
  readonly verificationJournalPath: string
  readonly legacyArtifactPaths: readonly string[]
}
