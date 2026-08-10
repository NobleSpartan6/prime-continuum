export interface VerifiedWindowsAppContainerProbeReceiptFile {
  readonly receipt: Readonly<Record<string, unknown>>
  readonly receiptSha256: string
  readonly staticVerifierExitCode: 0
  readonly liveProbeExitCode: 1 | 2
  readonly verifierKind: 'prime_continuim_appcontainer_probe_static_verifier_v1'
  readonly receiptBytes: number
}

export function verifyWindowsAppContainerProbeReceiptFile(
  receiptPath: string,
): Promise<Readonly<VerifiedWindowsAppContainerProbeReceiptFile>>
