export function createSelfBuildEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
export function verifyReceiptEnvelope(value: unknown): {
  integrity: string
  receipt: Record<string, unknown>
  receiptSha256: string
}
export function canonicalJson(value: unknown): string
