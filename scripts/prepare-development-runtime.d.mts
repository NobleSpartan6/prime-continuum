export interface DevelopmentRuntimeState {
  readonly pointerSha256: string
  readonly manifestSha256: string
  readonly fileManifestSha256: string
  readonly attestationSha256: string
  readonly namespaceMetadataSha256: string
  readonly namespaceEntryCount: number
}

export interface DevelopmentRuntimePreparationResult {
  readonly cached: boolean
  readonly rebuilt: boolean
  readonly runtimeRoot: string
  readonly attestationPath: string
  readonly cachePath: string
}

export function prepareDevelopmentRuntime(options?: {
  projectRoot?: string
  runtimeRoot?: string
  attestationPath?: string
  cachePath?: string
  electronExecutable?: string
  hostNodeExecutable?: string
  log?: (message: string) => void
  dependencies?: Readonly<Record<string, unknown>>
}): Promise<DevelopmentRuntimePreparationResult>

export function inspectDevelopmentRuntime(options: {
  runtimeRoot: string
  attestationPath: string
  electronExecutable: string
  hostNodeExecutable: string
}): Promise<DevelopmentRuntimeState>

export function createRuntimeNamespaceCheckpoint(runtimeDirectory: string): Promise<{
  readonly metadataSha256: string
  readonly entryCount: number
}>
