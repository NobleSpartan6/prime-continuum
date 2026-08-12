export function prepareMacosDmgArtifactDestinations(options: {
  projectRoot: string
  projectPackage: Record<string, any>
  arch?: NodeJS.Architecture
}): Promise<Record<string, any>>

export function recoverMacosDmgVerification(
  configuration: Record<string, any>,
  options?: { allowOwnerPid?: number },
): Promise<{ readonly recovered: boolean; readonly devices: readonly string[] }>

export function assertMacosDmgMountEntries(
  mountPoint: string,
  expectedApplicationPath: string,
): Promise<{
  readonly appPath: string
  readonly entries: readonly string[]
}>

export function assertDmgTrailer(trailer: Uint8Array): true

export function collectDiskImageDeviceIds(info: Record<string, any>): Set<string>

export function resolveAttachedDiskImage(options: {
  attach: Record<string, any>
  info: Record<string, any>
  artifactPath: string
  mountPoint: string
  baselineDeviceIds: ReadonlySet<string> | readonly string[]
}): {
  readonly rootDevice: string
  readonly mountedDevice: string
  readonly devices: readonly string[]
}

export function assertReadOnlyDiskInfo(
  info: Record<string, any>,
  options: { device: string; mountPoint: string; wholeDisk: boolean },
): true

export function assertDmgImageInfo(info: Record<string, any>, artifactPath: string): true

export function projectRelative(projectRoot: string, path: string): string

export function verifyMacosDmg(options: {
  projectRoot: string
  projectPackage: Record<string, any>
  arch?: NodeJS.Architecture
}): Promise<Record<string, any>>
