import { createHash } from "node:crypto";
import runtimePolicy from "../../runtime/prime-agent/runtime-policy.json";
import { CODEX_APP_SERVER_LEGAL_FILES } from "../../scripts/codex-app-server-policy-lib.mjs";

declare const __PRIME_CONTINUIM_RUNTIME_ATTESTATION_RECORD__: string | undefined;

export const RUNTIME_ATTESTATION_RECORD_PREFIX = "PRIME_CONTINUIM_RUNTIME_ATTESTATION_V1:";
export const MAX_RUNTIME_ATTESTATION_BYTES = 256 * 1024;

export type RuntimeAssurance = "development-integrity" | "production-authenticated";

export interface EmbeddedCodexAppServerThreadStartPolicy {
  readonly requiredCapability: "experimentalApi";
  readonly requestKeys: readonly [
    "modelProvider",
    "cwd",
    "runtimeWorkspaceRoots",
    "approvalPolicy",
    "approvalsReviewer",
    "sandbox",
    "config",
    "ephemeral",
    "environments",
    "dynamicTools",
    "selectedCapabilityRoots",
    "experimentalRawEvents",
  ];
  readonly modelProvider: "openai";
  readonly cwd: "absolute-workspace";
  readonly runtimeWorkspaceRoots: "exact-cwd-only";
  readonly approvalPolicy: "never";
  readonly approvalsReviewer: "user";
  readonly sandbox: "read-only";
  readonly config: "attested-thread-config";
  readonly ephemeral: false;
  readonly environments: readonly [];
  readonly dynamicTools: readonly [];
  readonly selectedCapabilityRoots: readonly [];
  readonly experimentalRawEvents: false;
  readonly deleteAfterSmoke: true;
  readonly expectedSecurityResponse: Readonly<{
    model: "gpt-5.6-sol";
    modelProvider: "openai";
    runtimeWorkspaceRoots: readonly [];
    instructionSources: readonly [];
    approvalPolicy: "never";
    approvalsReviewer: "user";
    sandbox: Readonly<{ type: "readOnly"; networkAccess: false }>;
    activePermissionProfile: null;
    multiAgentMode: "explicitRequestOnly";
  }>;
}

export interface EmbeddedCodexAppServerAttestation {
  readonly releaseVersion: "0.147.0";
  readonly platform: "win32";
  readonly arch: "x64";
  readonly target: "x86_64-pc-windows-msvc";
  readonly entrypoint: "companions/codex-app-server/bin/codex-app-server.exe";
  readonly fixedArguments: readonly string[];
  readonly legalFiles: readonly Readonly<{
    fileName: string;
    path: "legal/LICENSE" | "legal/NOTICE";
    url: string;
    sourceCommit: string;
    size: number;
    sha256: string;
  }>[];
  readonly sessionConfig: Readonly<Record<string, unknown>>;
  readonly threadConfig: Readonly<Record<string, boolean | string>>;
  readonly initializeIdentity: Readonly<{
    clientInfoName: "prime_continuim";
    clientInfoTitle: "Prime Continuim";
    capabilities: Readonly<{ experimentalApi: true }>;
    userAgentTemplate: "prime_continuim/0.147.0 (Windows <major>.<minor>.<build>; x86_64) unknown (prime_continuim; <clientVersion>)";
    platformFamily: "windows";
    platformOs: "windows";
  }>;
  readonly threadStartPolicy: Readonly<EmbeddedCodexAppServerThreadStartPolicy>;
  readonly environmentPolicy: Readonly<{
    inherit: "none";
    requiredSourceVariables: readonly ["SystemRoot", "WINDIR"];
    constructedVariables: readonly ["ComSpec", "TEMP", "TMP", "PATH", "PATHEXT", "CODEX_HOME"];
    privateTemporaryDirectoryRequired: true;
    pathEntries: readonly ["codex-path", "System32", "WindowsPowerShell/v1.0"];
    pathExt: ".COM;.EXE;.BAT;.CMD";
  }>;
  readonly codexHomePolicy: Readonly<{
    requireEmptyAtLaunch: true;
    allowedGeneratedSystemSkillsRoot: "skills/.system";
    forbiddenBasenames: readonly string[];
    forbiddenTopLevelDirectories: readonly string[];
    forbiddenExecutableExtensions: readonly string[];
  }>;
  readonly assetSha256: string;
  readonly publisher: Readonly<{
    subject: string;
    thumbprint: string;
    signedFiles: readonly string[];
    unsignedFiles: readonly string[];
  }>;
  readonly smoke: Readonly<{
    protocol: "jsonl-stdio";
    initialize: true;
    initializeIdentity: true;
    configRead: true;
    denyVectorEffective: true;
    windowsSandboxUnelevatedPrivateDesktop: true;
    mcpServersEmpty: true;
    hooksEmpty: true;
    pluginsEmpty: true;
    appsEmpty: true;
    threadStartReadOnly: true;
    threadNetworkAccessDisabled: true;
    threadDeleted: true;
    accountReadSignedOut: true;
    requiresOpenaiAuth: true;
    forbiddenConfigAbsent: true;
    authJsonAbsent: true;
  }>;
}

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
  readonly entrypoints: Readonly<{ module: string; cli: string }>;
  readonly daemon: Readonly<{
    protocolName: string;
    protocolVersion: number;
    schemaRevision: number;
    schemaId: string;
    requiredCapabilities: readonly string[];
  }>;
  readonly codexAppServer?: EmbeddedCodexAppServerAttestation;
  readonly nativeAddons: readonly Readonly<{ path: string; size: number; sha256: string }>[];
  readonly hostRuntime: Readonly<{
    kind: "electron-run-as-node";
    electronVersion: string;
    nodeVersion: string;
    modulesAbi: string;
    napiVersion: string;
    platform: string;
    arch: string;
    runAsNode: true;
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
  const hostRuntime = value.hostRuntime;
  return (
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
    (value.codexAppServer === undefined || isCodexAppServerAttestation(value.codexAppServer)) &&
    Array.isArray(value.nativeAddons) &&
    value.nativeAddons.length > 0 &&
    value.nativeAddons.length <= 32 &&
    value.nativeAddons.every(isNativeAddon) &&
    isRecord(hostRuntime) &&
    hostRuntime.kind === "electron-run-as-node" &&
    isBoundedString(hostRuntime.electronVersion) &&
    isBoundedString(hostRuntime.nodeVersion) &&
    isBoundedString(hostRuntime.modulesAbi) &&
    isBoundedString(hostRuntime.napiVersion) &&
    isBoundedString(hostRuntime.platform) &&
    isBoundedString(hostRuntime.arch) &&
    hostRuntime.runAsNode === true
  );
}

function isCodexAppServerAttestation(value: unknown): value is EmbeddedCodexAppServerAttestation {
  if (
    !isRecord(value) ||
    !isRecord(value.publisher) ||
    !isRecord(value.smoke) ||
    !isRecord(value.sessionConfig) ||
    !isRecord(value.threadConfig) ||
    !isRecord(value.initializeIdentity) ||
    !isRecord(value.threadStartPolicy) ||
    !isRecord(value.environmentPolicy) ||
    !isRecord(value.codexHomePolicy)
  ) return false;
  const contract = runtimePolicy.codexAppServer;
  const signedFiles = [
    "bin/codex-app-server.exe",
    "bin/codex-code-mode-host.exe",
    "codex-resources/codex-command-runner.exe",
    "codex-resources/codex-windows-sandbox-setup.exe",
  ];
  return (
    value.releaseVersion === "0.147.0" &&
    value.platform === "win32" &&
    value.arch === "x64" &&
    value.target === "x86_64-pc-windows-msvc" &&
    value.entrypoint === "companions/codex-app-server/bin/codex-app-server.exe" &&
    jsonEqual(value.fixedArguments, contract.fixedArguments) &&
    jsonEqual(value.legalFiles, CODEX_APP_SERVER_LEGAL_FILES) &&
    jsonEqual(value.sessionConfig, contract.sessionConfig) &&
    jsonEqual(value.threadConfig, contract.threadConfig) &&
    jsonEqual(value.initializeIdentity, contract.initializeIdentity) &&
    jsonEqual(value.threadStartPolicy, contract.threadStartPolicy) &&
    jsonEqual(value.environmentPolicy, contract.environmentPolicy) &&
    jsonEqual(value.codexHomePolicy, contract.codexHomePolicy) &&
    isSha256(value.assetSha256) &&
    value.publisher.subject === 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US' &&
    value.publisher.thumbprint === "8B0ADFB840E141DAD3044D2B5AC819873DDE3590" &&
    jsonEqual(value.publisher.signedFiles, signedFiles) &&
    jsonEqual(value.publisher.unsignedFiles, ["codex-path/rg.exe"]) &&
    value.smoke.protocol === "jsonl-stdio" &&
    value.smoke.initialize === true &&
    value.smoke.initializeIdentity === true &&
    value.smoke.configRead === true &&
    value.smoke.denyVectorEffective === true &&
    value.smoke.windowsSandboxUnelevatedPrivateDesktop === true &&
    value.smoke.mcpServersEmpty === true &&
    value.smoke.hooksEmpty === true &&
    value.smoke.pluginsEmpty === true &&
    value.smoke.appsEmpty === true &&
    value.smoke.threadStartReadOnly === true &&
    value.smoke.threadNetworkAccessDisabled === true &&
    value.smoke.threadDeleted === true &&
    value.smoke.accountReadSignedOut === true &&
    value.smoke.requiresOpenaiAuth === true &&
    value.smoke.forbiddenConfigAbsent === true &&
    value.smoke.authJsonAbsent === true
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
