import { createHash } from "node:crypto";

declare const __PRIME_CONTINUIM_RUNTIME_ATTESTATION_RECORD__: string | undefined;

export const RUNTIME_ATTESTATION_RECORD_PREFIX = "PRIME_CONTINUIM_RUNTIME_ATTESTATION_V1:";
export const MAX_RUNTIME_ATTESTATION_BYTES = 256 * 1024;

export type RuntimeAssurance = "development-integrity" | "production-authenticated";

export interface EmbeddedRuntimeAttestation {
  readonly schemaVersion: 1;
  readonly product: "Prime Continuim";
  readonly assurance: RuntimeAssurance;
  readonly runtimePolicySchemaVersion: number;
  readonly runtime: Readonly<{
    name: string;
    releaseVersion: string;
    runtimeBuildId: string;
    platform: string;
    arch: string;
    libc: string;
  }>;
  readonly manifest: Readonly<{
    relativePath: string;
    sha256: string;
    sourcesSha256: string;
    policySha256: string;
    packageLockSha256: string;
  }>;
  readonly tree: Readonly<{
    sha256: string;
    filesSha256: string;
    fileCount: number;
    totalBytes: number;
  }>;
  readonly entrypoints: Readonly<{
    module: string;
    cli: string;
    browserBridge: string;
    browserHost: string;
    browserLauncher: string;
    browserLauncherWindows: string;
    browserSkill: string;
  }>;
  readonly browserBridge: Readonly<{
    protocol: "prime-continuim.browser.v1";
    playwrightCoreVersion: "1.63.0-alpha-2026-08-05";
    engine: "verified-electron-host";
    smoke: Readonly<{
      verified: true;
      operations: readonly ["doctor", "open", "snapshot", "find", "click", "eval", "screenshot", "close"];
    }>;
  }>;
  readonly daemon: Readonly<{
    protocolName: string;
    protocolVersion: number;
    schemaRevision: number;
    schemaId: string;
    requiredCapabilities: readonly string[];
  }>;
  readonly nativeAddons: readonly Readonly<{ path: string; size: number; sha256: string }>[];
  readonly guiRuntime: Readonly<{
    kind: "electron";
    electronVersion: string;
    nodeVersion: string;
    modulesAbi: string;
    napiVersion: string;
    platform: string;
    arch: string;
    executableSha256: string;
  }>;
  readonly hostRuntime: Readonly<{
    kind: "node";
    nodeVersion: string;
    modulesAbi: string;
    napiVersion: string;
    platform: string;
    arch: string;
    executableSha256: string;
  }>;
}

export interface EmbeddedRuntimeAttestationEnvelope {
  /** The parsed, release-generated attestation bound into this exact hostd. */
  readonly attestation: EmbeddedRuntimeAttestation;
  /** SHA-256 of the exact canonical attestation bytes embedded in hostd. */
  readonly trustAnchorId: string;
}

/**
 * Returns the release-generated runtime attestation embedded in hostd.
 * Development hostd builds intentionally return undefined; release builds
 * must be rejected by packaging verification unless this record is present.
 */
export function readEmbeddedRuntimeAttestation(): EmbeddedRuntimeAttestation | undefined {
  return readEmbeddedRuntimeAttestationEnvelope()?.attestation;
}

/**
 * Returns both the attestation and its byte-exact trust-anchor identifier.
 * The identifier deliberately hashes the embedded bytes rather than a parsed
 * object so health clients can bind readiness to the same release artifact.
 */
export function readEmbeddedRuntimeAttestationEnvelope(): EmbeddedRuntimeAttestationEnvelope | undefined {
  const record = typeof __PRIME_CONTINUIM_RUNTIME_ATTESTATION_RECORD__ === "undefined"
    ? undefined
    : __PRIME_CONTINUIM_RUNTIME_ATTESTATION_RECORD__;
  if (record === undefined) return undefined;
  return parseEmbeddedRuntimeAttestationRecord(record);
}

/** Parses one bounded embedded record. Exported for release-verifier tests. */
export function parseEmbeddedRuntimeAttestationRecord(record: string): EmbeddedRuntimeAttestationEnvelope {
  if (!record.startsWith(RUNTIME_ATTESTATION_RECORD_PREFIX)) {
    throw new Error("The embedded runtime attestation record is malformed");
  }
  const encoded = record.slice(RUNTIME_ATTESTATION_RECORD_PREFIX.length);
  if (!/^[A-Za-z0-9+/]{32,}={0,2}$/.test(encoded)) {
    throw new Error("The embedded runtime attestation is not canonical base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_RUNTIME_ATTESTATION_BYTES ||
    bytes.toString("base64") !== encoded
  ) {
    throw new Error("The embedded runtime attestation is empty, oversized, or non-canonical");
  }
  return parseEmbeddedRuntimeAttestationBytes(bytes);
}

/** Strictly validates the exact bytes used by the embedded hostd record. */
export function parseEmbeddedRuntimeAttestationBytes(bytes: Buffer): EmbeddedRuntimeAttestationEnvelope {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RUNTIME_ATTESTATION_BYTES) {
    throw new Error("The runtime attestation is empty or oversized");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("The embedded runtime attestation is not valid JSON", { cause: error });
  }
  if (!isEmbeddedRuntimeAttestation(value)) {
    throw new Error("The embedded runtime attestation has an invalid identity");
  }
  return deepFreeze({
    attestation: value,
    trustAnchorId: createHash("sha256").update(bytes).digest("hex"),
  });
}

function isEmbeddedRuntimeAttestation(value: unknown): value is EmbeddedRuntimeAttestation {
  if (!isRecord(value)) return false;
  const runtime = value.runtime;
  const manifest = value.manifest;
  const tree = value.tree;
  const entrypoints = value.entrypoints;
  const daemon = value.daemon;
  const guiRuntime = value.guiRuntime;
  const hostRuntime = value.hostRuntime;
  return (
    jsonEqual(Object.keys(value).sort(), [
      "schemaVersion",
      "product",
      "assurance",
      "runtimePolicySchemaVersion",
      "runtime",
      "manifest",
      "tree",
      "entrypoints",
      "browserBridge",
      "daemon",
      "nativeAddons",
      "guiRuntime",
      "hostRuntime",
    ].sort()) &&
    value.schemaVersion === 1 &&
    value.product === "Prime Continuim" &&
    (value.assurance === "development-integrity" || value.assurance === "production-authenticated") &&
    value.runtimePolicySchemaVersion === 1 &&
    isRecord(runtime) &&
    runtime.name === "prime-agent" &&
    isBoundedString(runtime.releaseVersion) &&
    isBoundedString(runtime.runtimeBuildId) &&
    isBoundedString(runtime.platform) &&
    isBoundedString(runtime.arch) &&
    isBoundedString(runtime.libc) &&
    isRecord(manifest) &&
    isSafeRelativePath(manifest.relativePath) &&
    typeof manifest.relativePath === "string" &&
    manifest.relativePath.endsWith("/runtime.json") &&
    isSha256(manifest.sha256) &&
    isSha256(manifest.sourcesSha256) &&
    isSha256(manifest.policySha256) &&
    isSha256(manifest.packageLockSha256) &&
    isRecord(tree) &&
    isSha256(tree.sha256) &&
    isSha256(tree.filesSha256) &&
    isBoundedInteger(tree.fileCount, 1, 100_000) &&
    isBoundedInteger(tree.totalBytes, 1, 8 * 1024 * 1024 * 1024) &&
    isRecord(entrypoints) &&
    isSafeRelativePath(entrypoints.module) &&
    isSafeRelativePath(entrypoints.cli) &&
    isSafeRelativePath(entrypoints.browserBridge) &&
    isSafeRelativePath(entrypoints.browserHost) &&
    isSafeRelativePath(entrypoints.browserLauncher) &&
    isSafeRelativePath(entrypoints.browserLauncherWindows) &&
    isSafeRelativePath(entrypoints.browserSkill) &&
    isRecord(value.browserBridge) &&
    value.browserBridge.protocol === "prime-continuim.browser.v1" &&
    value.browserBridge.playwrightCoreVersion === "1.63.0-alpha-2026-08-05" &&
    value.browserBridge.engine === "verified-electron-host" &&
    isRecord(value.browserBridge.smoke) &&
    value.browserBridge.smoke.verified === true &&
    jsonEqual(value.browserBridge.smoke.operations, [
      "doctor", "open", "snapshot", "find", "click", "eval", "screenshot", "close",
    ]) &&
    isRecord(daemon) &&
    isBoundedString(daemon.protocolName) &&
    isBoundedInteger(daemon.protocolVersion, 1, 1_000_000) &&
    isBoundedInteger(daemon.schemaRevision, 1, 1_000_000) &&
    isBoundedString(daemon.schemaId) &&
    Array.isArray(daemon.requiredCapabilities) &&
    daemon.requiredCapabilities.length > 0 &&
    daemon.requiredCapabilities.length <= 32 &&
    daemon.requiredCapabilities.every(isBoundedString) &&
    new Set(daemon.requiredCapabilities).size === daemon.requiredCapabilities.length &&
    Array.isArray(value.nativeAddons) &&
    value.nativeAddons.length > 0 &&
    value.nativeAddons.length <= 32 &&
    value.nativeAddons.every(isNativeAddon) &&
    isRecord(guiRuntime) &&
    guiRuntime.kind === "electron" &&
    isBoundedString(guiRuntime.electronVersion) &&
    isBoundedString(guiRuntime.nodeVersion) &&
    isBoundedString(guiRuntime.modulesAbi) &&
    isBoundedString(guiRuntime.napiVersion) &&
    isBoundedString(guiRuntime.platform) &&
    isBoundedString(guiRuntime.arch) &&
    isSha256(guiRuntime.executableSha256) &&
    isRecord(hostRuntime) &&
    hostRuntime.kind === "node" &&
    isBoundedString(hostRuntime.nodeVersion) &&
    isBoundedString(hostRuntime.modulesAbi) &&
    isBoundedString(hostRuntime.napiVersion) &&
    isBoundedString(hostRuntime.platform) &&
    isBoundedString(hostRuntime.arch) &&
    isSha256(hostRuntime.executableSha256) &&
    guiRuntime.executableSha256 !== hostRuntime.executableSha256 &&
    guiRuntime.platform === hostRuntime.platform &&
    guiRuntime.arch === hostRuntime.arch
  );
}

function isNativeAddon(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSafeRelativePath(value.path) &&
    typeof value.path === "string" &&
    value.path.endsWith(".node") &&
    isBoundedInteger(value.size, 1, 1024 * 1024 * 1024) &&
    isSha256(value.sha256)
  );
}

function isSafeRelativePath(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    /[\\\0\r\n]/.test(value) ||
    value.normalize("NFC") !== value
  ) {
    return false;
  }
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && segment.length <= 255);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
