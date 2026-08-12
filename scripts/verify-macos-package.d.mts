export function verifyMacosPackage(options?: {
  projectRoot?: string
  packageDirectory?: string
  configOnly?: boolean
}): Promise<Record<string, unknown>>
