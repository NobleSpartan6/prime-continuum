import type { CodexAppServerThreadStartPolicy } from "./prime-agent-runtime-lib.mjs";

export type RuntimeCodexAppServerAttestation = Readonly<Record<string, unknown>> & Readonly<{
  threadStartPolicy: Readonly<CodexAppServerThreadStartPolicy>;
}>;

export interface RuntimeAttestation {
  readonly schemaVersion: 1;
  readonly product: "Prime Continuim";
  readonly assurance: "development-integrity";
  readonly runtimePolicySchemaVersion: 1;
  readonly runtime: Readonly<Record<string, unknown>>;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly tree: Readonly<Record<string, unknown>>;
  readonly entrypoints: Readonly<Record<string, unknown>>;
  readonly daemon: Readonly<Record<string, unknown>>;
  readonly codexAppServer?: RuntimeCodexAppServerAttestation;
  readonly nativeAddons: readonly Readonly<Record<string, unknown>>[];
  readonly hostRuntime: Readonly<Record<string, unknown>>;
}

export const RUNTIME_ATTESTATION_RECORD_PREFIX: string;
export const MAX_RUNTIME_ATTESTATION_BYTES: number;
export function createRuntimeAttestation(options: {
  runtimeRoot?: string;
  electronExecutable: string;
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
  runtimeVersions: Record<string, unknown>;
  inputs: { policy: Record<string, any> };
}): void;
export function readElectronRuntimeIdentity(executablePath: string): Promise<Record<string, unknown>>;
