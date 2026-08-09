export interface HostdBuildProvenance {
  schemaVersion: 1;
  bundleSha256: string;
  inputs: string[];
}

export function parseHostdBuildProvenance(bytes: Uint8Array): HostdBuildProvenance;
