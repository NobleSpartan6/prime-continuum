export interface CandidateSourceIdentity {
  headCommit: string
  dirty: boolean
  statusPorcelainV2Sha256: string
  statusBytes: number
  binaryPatchSha256: string
  binaryPatchBytes: number
  untrackedManifestSha256: string
  untrackedFileCount: number
  untrackedBytes: number
  treeSha256: string
  treeFileCount: number
  treeBytes: number
  paths: string[]
  entries: Array<Record<string, unknown> & { path: string; type: string }>
  untracked: Array<Record<string, unknown> & { path: string; type: string }>
}

export class SelfBuildFailure extends Error {
  receiptPath?: string
  receiptSha256?: string
  stage?: string
}

export function runSelfBuild(options?: Record<string, unknown>): Promise<{
  receiptPath: string
  relativeReceiptPath: string
  envelope: { integrity: string; receipt: Record<string, unknown>; receiptSha256: string }
}>
export function captureGitCandidate(projectRoot: string, options?: { gitExecutable?: string }): Promise<CandidateSourceIdentity>
export function assertMaterializedContentEqual(expected: CandidateSourceIdentity, actual: CandidateSourceIdentity, message: string): void
export function captureCandidateTree(root: string, paths: string[]): Promise<{
  treeSha256: string
  fileCount: number
  totalBytes: number
  entries: Array<Record<string, unknown>>
}>
export function materializeGitCandidate(options: { sourceRoot: string; evaluationRoot: string; candidate: CandidateSourceIdentity; gitExecutable?: string }): Promise<void>
export function cleanupEvaluationWorktree(options: { projectRoot: string; evaluationRoot: string; gitExecutable?: string }): Promise<void>
export function createSelfBuildCommandPlan(options: Record<string, unknown>): Array<Record<string, unknown>>
export function createSelfBuildEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
export function runCommandSequence(options: Record<string, unknown>): Promise<{ passed: boolean; results: Array<Record<string, unknown>> }>
export function inspectToolchain(root: string): Promise<Record<string, unknown>>
export function assertEvaluationDependencyIsolation(mainRoot: string, evaluationRoot: string): Promise<void>
export function materializeEvaluationNodeRuntimeDependency(evaluationRoot: string, toolchain: {
  node: { version: string; executableSha256: string }
  pnpm: { absoluteStore: string }
}): Promise<void>
export function describeToolchainSentinelMetadata(metadata: {
  isDirectory(): boolean
  isFile(): boolean
  size: number
  mtimeMs: number
  ctimeMs: number
  dev: string | number | bigint
  ino: string | number | bigint
}): Record<string, unknown>
export function digestArtifactRoots(root: string, roots: string[]): Promise<Record<string, unknown>>
export function digestFileTree(root: string, options?: { maxFiles?: number; maxBytes?: number }): Promise<Record<string, unknown>>
export function createReceiptEnvelope(receipt: Record<string, unknown>): { integrity: string; receipt: Record<string, unknown>; receiptSha256: string }
export function writeReceiptEnvelope(receiptDirectory: string, envelope: Record<string, unknown>): Promise<string>
export function verifyReceiptFile(path: string): Promise<{ integrity: string; receipt: Record<string, unknown>; receiptSha256: string }>
export function canonicalJson(value: unknown): string
