export interface ElectronRuntimeInspection {
  ready: boolean
  electronPackageDirectory: string
  executablePath: string
  expectedExecutable: string
  packageVersion?: string
  reasons: string[]
}

export interface ElectronInstallerOutcome {
  status: number | null
  signal?: NodeJS.Signals | null
  error?: Error
  timedOut?: boolean
}

export interface ElectronRuntimeOptions {
  electronPackageDirectory?: string
  platform?: NodeJS.Platform | 'mas'
  arch?: NodeJS.Architecture
}

export class ElectronRuntimeSetupError extends Error {}

export function expectedElectronExecutable(platform?: NodeJS.Platform | 'mas'): string
export function resolveElectronPackageDirectory(): string
export function inspectElectronRuntime(
  options?: ElectronRuntimeOptions
): Promise<ElectronRuntimeInspection>
export function ensureElectronRuntime(
  options?: ElectronRuntimeOptions & {
    log?: (message: string) => void
    runInstaller?: (options: {
      electronPackageDirectory: string
      timeoutMs: number
    }) => ElectronInstallerOutcome | Promise<ElectronInstallerOutcome>
    installerTimeoutMs?: number
  }
): Promise<ElectronRuntimeInspection>
export function runElectronInstaller(options: {
  electronPackageDirectory: string
  timeoutMs?: number
}): Promise<ElectronInstallerOutcome>
export function hostElectronInstallEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
