export declare const NATIVE_LAUNCH_PROOF_KIND: string
export declare const NATIVE_LAUNCH_PROOF_INTEGRITY: string

export declare class NativeLaunchProofFailure extends Error {
  code: string
}

export declare function assertNativeTargetDescriptor(target: unknown): {
  url: URL
  normalizedPath: string
}

export declare function validateNativeObservation(value: unknown): {
  appVersion: string
  hostdBundleSha256: string
  runtimeTrustAnchorId: string
  runtimeTarget: Record<string, string>
  threadId: string
  hostId: string
  executionGenerationId: string
  cursor: string
  snapshotGeneratedAt: string
  outcomeObservedAt: string
  outcomeStopReason: string
  outcomeTextSha256: string
  childCount: number
  completedChildCount: number
  visibleChildCount: number
  childEvidenceSha256: string
}

export declare function createNativeLaunchProofEnvelope(input: {
  runId: string
  capturedAt: string
  selfBuildReceipt: {
    receiptSha256: string
    headCommit: string
    dirty: boolean
    sourceTreeSha256: string
  }
  app: Record<string, unknown>
  runtime: Record<string, unknown>
  observation: unknown
  captures: Array<Record<string, unknown>>
}): {
  integrity: string
  manifest: Record<string, unknown>
  manifestSha256: string
}

export declare function assertPathFreeManifest<T>(value: T): T
export declare function digestArtifactEntries(entries: Array<{
  path: string
  size: number
  sha256: string
}>): { treeSha256: string; fileCount: number; totalBytes: number }
export declare function sha256(value: string | ArrayBufferView): string
