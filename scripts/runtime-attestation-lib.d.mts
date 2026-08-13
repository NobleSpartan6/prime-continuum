export interface RuntimeAttestation {
  readonly schemaVersion: 1;
  readonly product: "Prime Continuim";
  readonly assurance: "development-integrity";
  readonly runtimePolicySchemaVersion: 1;
  readonly runtime: Readonly<Record<string, unknown>>;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly tree: Readonly<Record<string, unknown>>;
  readonly entrypoints: Readonly<Record<string, unknown>>;
  readonly browserBridge: Readonly<Record<string, unknown>>;
  readonly daemon: Readonly<Record<string, unknown>>;
  readonly nativeAddons: readonly Readonly<Record<string, unknown>>[];
  readonly guiRuntime: Readonly<Record<string, unknown>>;
  readonly hostRuntime: Readonly<Record<string, unknown>>;
}

export const RUNTIME_ATTESTATION_RECORD_PREFIX: string;
export const MAX_RUNTIME_ATTESTATION_BYTES: number;
export function createRuntimeAttestation(options: {
  runtimeRoot?: string;
  electronExecutable: string;
  hostNodeExecutable: string;
  hostNodeVersion?: string;
  templateDirectory?: string;
}): Promise<RuntimeAttestation>;
export function serializeRuntimeAttestation(attestation: RuntimeAttestation): Buffer;
export function parseRuntimeAttestation(value: Uint8Array | string): RuntimeAttestation;
export function createEmbeddedRuntimeAttestationRecord(value: Uint8Array | RuntimeAttestation): string;
export function extractEmbeddedRuntimeAttestation(bundle: Uint8Array | string): Buffer;
export function assertRuntimeAttestationMatches(attestation: RuntimeAttestation, context: {
  pointer: Record<string, unknown>;
  manifest: Record<string, any>;
  manifestBytes: Uint8Array;
  fileManifestBytes: Uint8Array;
  guiRuntime: Record<string, unknown>;
  hostRuntime: Record<string, unknown>;
  inputs: { policy: Record<string, any> };
}): void;
export function readElectronRuntimeIdentity(executablePath: string): Promise<Record<string, unknown>>;
export function readNodeRuntimeIdentity(executablePath: string): Promise<Record<string, unknown>>;
