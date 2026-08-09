export type JsonRecord = Record<string, any>;

export interface RuntimeInputs {
  templateDirectory: string;
  packageJson: JsonRecord;
  lockfile: JsonRecord & {
    lockfileVersion: number;
    packages: Record<string, JsonRecord>;
  };
  sources: JsonRecord;
  policy: JsonRecord;
  lockfileSha256: string;
  sourcesSha256: string;
  policySha256: string;
}

export interface RuntimeSmokeResult {
  runtimeExecutable: string;
  runtimeVersions: Record<string, string>;
  hello: JsonRecord;
}

export interface CodexAppServerThreadStartPolicy {
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

export const REPO_ROOT: string;
export const RUNTIME_TEMPLATE_DIRECTORY: string;
export const CODEX_APP_SERVER_COMPANION_DIRECTORY: string;
export const CODEX_APP_SERVER_FIXED_ARGUMENTS: readonly string[];
export const CODEX_APP_SERVER_LEGAL_FILES: readonly Readonly<JsonRecord>[];
export const CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG: Readonly<JsonRecord>;
export const CODEX_APP_SERVER_THREAD_CONFIG: Readonly<Record<string, boolean | string>>;
export const CODEX_APP_SERVER_INITIALIZE_IDENTITY: Readonly<JsonRecord>;
export const CODEX_APP_SERVER_THREAD_START_POLICY: Readonly<CodexAppServerThreadStartPolicy>;
export { CODEX_APP_SERVER_ENVIRONMENT_POLICY } from "./codex-app-server-policy-lib.mjs";
export const CODEX_APP_SERVER_CODEX_HOME_POLICY: Readonly<JsonRecord>;

export class PrimeAgentRuntimeBuildError extends Error {
  constructor(message: string, options?: ErrorOptions);
}

export function loadRuntimeInputs(templateDirectory?: string): Promise<Readonly<RuntimeInputs>>;
export function validateRuntimeInputs(inputs: {
  packageJson: JsonRecord;
  lockfile: JsonRecord;
  sources: JsonRecord;
  policy: JsonRecord;
}): void;
export function verifyReleaseAssets(inputs: RuntimeInputs, cacheDirectory: string, options?: {
  fetchImpl?: typeof fetch;
  totalTimeoutMs?: number;
  noProgressTimeoutMs?: number;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<readonly string[]>;
export function codexAppServerSupportedForTarget(
  policy: JsonRecord,
  platform?: NodeJS.Platform,
  arch?: string,
): boolean;
export function discoverNpmCli(explicitPath?: string): Promise<string>;
export function installLockedRuntime(options: {
  inputs: RuntimeInputs;
  stagingDirectory: string;
  npmCli: string;
}): Promise<string>;
export function installCodexAppServerCompanion(options: JsonRecord): Promise<Readonly<JsonRecord> | undefined>;
export function extractCodexAppServerArchive(options: JsonRecord): Promise<void>;
export function verifyCodexAppServerCompanion(
  runtimeDirectory: string,
  options?: JsonRecord,
): Promise<Readonly<JsonRecord> | undefined>;
export function inspectCodexAppServerAuthenticode(
  companionDirectory: string,
  policy: JsonRecord,
): Promise<Readonly<JsonRecord>>;
export { createCodexAppServerEnvironment } from "./codex-app-server-policy-lib.mjs";
export function smokeCodexAppServerCompanion(
  runtimeDirectory: string,
  options?: JsonRecord,
): Promise<Readonly<JsonRecord> | undefined>;
export function pruneRuntimePackagingNoise(runtimeDirectory: string, policy: JsonRecord): Promise<readonly string[]>;
export function pruneRuntimeForTarget(runtimeDirectory: string): Promise<void>;
export function smokeRuntime(
  runtimeDirectory: string,
  options?: JsonRecord,
): Promise<Readonly<RuntimeSmokeResult>>;
export function createRuntimeManifest(options: {
  runtimeDirectory: string;
  inputs: JsonRecord;
  npmVersion: string;
  smoke: JsonRecord;
}): Promise<Readonly<JsonRecord>>;
export function verifyBuiltRuntime(
  runtimeDirectory: string,
  options?: JsonRecord,
): Promise<Readonly<{ root: string; manifest: JsonRecord }>>;
export function resolveVerifiedEntrypoints(
  runtimeDirectory: string,
  policy: JsonRecord,
): Promise<Readonly<{ root: string; modulePath: string; moduleUrl: string; cli: string; packageJson: string }>>;
export function writeCurrentPointer(
  outputRoot: string,
  finalDirectory: string,
  manifest: JsonRecord,
  manifestSha256: string,
): Promise<JsonRecord>;
export function removeObsoleteRuntimeInstalls(outputRoot: string, finalDirectory: string): Promise<void>;
export function verifyOnlySelectedRuntimeInstall(outputRoot: string, finalDirectory: string): Promise<void>;
export function acquireBuildLock(outputRoot: string): Promise<() => Promise<void>>;
export function runCommand(
  command: string,
  args: string[],
  options?: JsonRecord,
): Promise<{ stdout: string; stderr: string }>;
export function cleanBuildEnvironment(
  source: NodeJS.ProcessEnv,
  npmConfigPaths: { user: string; global: string },
): Record<string, string>;
export function cleanRuntimeEnvironment(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options: { electronRunAsNode: boolean },
): Record<string, string>;
export function sha256File(path: string): Promise<string>;
