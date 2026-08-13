export function readRequiredMacosFuses(bytes: Uint8Array): {
  readonly version: number
  readonly wireLength: number
}
export function verifyMacosAsarIntegrity(options: {
  asarPath: string
  infoPlistPath: string
}): Promise<Readonly<Record<string, {
  readonly algorithm: 'SHA256'
  readonly hash: string
}>>>
export function verifyAdHocMacosSignature(appPath: string): Promise<{
  readonly identity: 'ad-hoc'
  readonly teamIdentifier: null
  readonly bundleIdentifier: string
}>
export function parseAdHocCodesignDisplay(output: string): {
  readonly identity: 'ad-hoc'
  readonly teamIdentifier: null
  readonly bundleIdentifier: string
}
export function verifyPackagedApplicationCode(
  asarPath: string,
  roots: readonly { sourceRoot: string; archiveRoot: string }[],
): Promise<{ readonly fileCount: number }>
export function compareExactDirectoryTrees(
  sourceRoot: string,
  packagedRoot: string,
  label: string,
): Promise<{ readonly entries: number; readonly files: number; readonly bytes: number }>
export function assertDistinctExecutableIdentities(
  executables: readonly { label: string; path: string }[],
): Promise<readonly { readonly label: string; readonly path: string; readonly sha256: string }[]>
export function parseJsonObject(bytes: Uint8Array, label: string): Record<string, any>
export function selectPackagedMetadata(projectPackage: Record<string, any>): Record<string, unknown>
export function smokePackagedMacosApplication(
  executablePath: string,
  packageDirectory: string,
  packagedHostdPath: string,
): Promise<{
  readonly mainLoaded: true
  readonly preloadBridgeInstalled: true
  readonly rendererLoaded: true
  readonly cleanShutdown: true
  readonly residue: false
}>
export function sha256(value: Uint8Array | string): string
