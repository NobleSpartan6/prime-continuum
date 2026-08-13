export const REVIEWED_ELECTRON_BUILDER_VERSION: '26.15.3'
export const WINDOWS_PACKAGING_DENIED_ENVIRONMENT_KEYS: readonly string[]

export function createWindowsElectronBuilderArguments(options?: {
  directoryOnly?: boolean
}): readonly string[]

export function createWindowsPackagingBuilderPlan(options?: {
  directoryOnly?: boolean
}): readonly [
  {
    readonly kind: 'node'
    readonly label: string
    readonly script: 'scripts/verify-windows-installer.mjs'
    readonly args: readonly ['--config-only']
  },
  {
    readonly kind: 'pnpm'
    readonly label: string
    readonly args: readonly string[]
  },
]

export function createWindowsPackagingEnvironment(
  source?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv

export function assertWindowsInstallerConfiguration(
  projectPackage: Record<string, unknown>,
  options: { projectRoot: string },
): {
  artifactName: string
  artifactPath: string
  checksumPath: string
}

export function assertReviewedBuildResources(options: {
  projectRoot: string
}): Promise<void>
