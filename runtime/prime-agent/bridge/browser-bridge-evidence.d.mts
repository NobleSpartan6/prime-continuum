export function retireBrowserEvidence(options: Readonly<{
  metadata?: Readonly<{ pid: number }>;
  closeEndpoint(metadata: Readonly<{ pid: number }>): Promise<void>;
  processAlive(pid: number): boolean;
  removeMetadata(): Promise<void>;
  removeProfile?: () => Promise<void>;
}>): Promise<void>;
