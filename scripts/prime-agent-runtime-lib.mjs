import { createHash, randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants, createReadStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  extname,
  win32,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createGunzip } from "node:zlib";
import {
  CODEX_APP_SERVER_ENVIRONMENT_POLICY,
  CODEX_APP_SERVER_LEGAL_FILES,
  createCodexAppServerEnvironment,
} from "./codex-app-server-policy-lib.mjs";

export {
  CODEX_APP_SERVER_ENVIRONMENT_POLICY,
  CODEX_APP_SERVER_LEGAL_FILES,
  createCodexAppServerEnvironment,
} from "./codex-app-server-policy-lib.mjs";

const RUNTIME_METADATA_FILES = new Set(["files.sha256", "runtime.json"]);
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_APP_SERVER_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const DOWNLOAD_REDIRECT_LIMIT = 5;
const DOWNLOAD_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_NO_PROGRESS_TIMEOUT_MS = 30 * 1000;

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RUNTIME_TEMPLATE_DIRECTORY = join(REPO_ROOT, "runtime", "prime-agent");
export const CODEX_APP_SERVER_COMPANION_DIRECTORY = "companions/codex-app-server";
export const CODEX_APP_SERVER_FIXED_ARGUMENTS = Object.freeze([
  "--strict-config",
  "-c",
  'cli_auth_credentials_store="keyring"',
  "-c",
  'mcp_oauth_credentials_store="keyring"',
  "-c",
  'forced_login_method="chatgpt"',
  "-c",
  'web_search="disabled"',
  "-c",
  "check_for_update_on_startup=false",
  "-c",
  'shell_environment_policy.inherit="none"',
  "-c",
  "shell_environment_policy.experimental_use_profile=false",
  "-c",
  "allow_login_shell=false",
  "-c",
  'windows.sandbox="unelevated"',
  "-c",
  "windows.sandbox_private_desktop=true",
  "-c",
  "include_apps_instructions=false",
  "-c",
  "skills.include_instructions=false",
  "-c",
  "orchestrator.skills.enabled=false",
  "-c",
  "orchestrator.mcp.enabled=false",
  "-c",
  "features.plugins=false",
  "-c",
  "features.apps=false",
  "-c",
  "features.remote_plugin=false",
  "-c",
  "features.plugin_sharing=false",
  "-c",
  "features.recommended_plugins=false",
  "-c",
  "features.skill_mcp_dependency_install=false",
  "-c",
  "features.skill_search=false",
  "-c",
  "features.plugin_hooks=false",
  "-c",
  "features.hooks=false",
  "-c",
  "features.browser_use=false",
  "-c",
  "features.browser_use_full_cdp_access=false",
  "-c",
  "features.browser_use_external=false",
  "-c",
  "features.computer_use=false",
  "-c",
  "features.in_app_browser=false",
  "-c",
  "features.in_app_updates=false",
  "-c",
  "features.image_generation=false",
  "-c",
  "features.tool_suggest=false",
  "-c",
  "features.multi_agent=false",
  "-c",
  "features.multi_agent_v2=false",
  "-c",
  "features.code_mode=false",
  "-c",
  "features.code_mode_buffered_exec=false",
  "-c",
  "features.code_mode_host=false",
  "-c",
  "features.code_mode_only=false",
  "-c",
  "features.enable_mcp_apps=false",
  "-c",
  "features.mcp_2026_07_28=false",
  "-c",
  "features.non_prefixed_mcp_tool_names=false",
  "-c",
  "features.deferred_tool_world_state=false",
  "-c",
  "features.tool_call_mcp_elicitation=false",
  "-c",
  "features.auth_elicitation=false",
  "-c",
  "features.standalone_web_search=false",
  "-c",
  "features.executor_capability_discovery=false",
  "-c",
  "features.workspace_dependencies=false",
  "-c",
  "features.memories=false",
  "-c",
  "features.elevated_windows_sandbox=false",
  "--listen",
  "stdio://",
]);
export const CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG = Object.freeze({
  cli_auth_credentials_store: "keyring",
  mcp_oauth_credentials_store: "keyring",
  forced_login_method: "chatgpt",
  web_search: "disabled",
  check_for_update_on_startup: false,
  shell_environment_policy: Object.freeze({
    inherit: "none",
    experimental_use_profile: false,
  }),
  allow_login_shell: false,
  windows: Object.freeze({
    sandbox: "unelevated",
    sandbox_private_desktop: true,
  }),
  include_apps_instructions: false,
  skills: Object.freeze({ include_instructions: false }),
  orchestrator: Object.freeze({
    skills: Object.freeze({ enabled: false }),
    mcp: Object.freeze({ enabled: false }),
  }),
  features: Object.freeze({
    plugins: false,
    apps: false,
    remote_plugin: false,
    plugin_sharing: false,
    recommended_plugins: false,
    skill_mcp_dependency_install: false,
    skill_search: false,
    plugin_hooks: false,
    hooks: false,
    browser_use: false,
    browser_use_full_cdp_access: false,
    browser_use_external: false,
    computer_use: false,
    in_app_browser: false,
    in_app_updates: false,
    image_generation: false,
    tool_suggest: false,
    multi_agent: false,
    multi_agent_v2: false,
    code_mode: false,
    code_mode_buffered_exec: false,
    code_mode_host: false,
    code_mode_only: false,
    enable_mcp_apps: false,
    mcp_2026_07_28: false,
    non_prefixed_mcp_tool_names: false,
    deferred_tool_world_state: false,
    tool_call_mcp_elicitation: false,
    auth_elicitation: false,
    standalone_web_search: false,
    executor_capability_discovery: false,
    workspace_dependencies: false,
    memories: false,
    elevated_windows_sandbox: false,
  }),
});
export const CODEX_APP_SERVER_THREAD_CONFIG = Object.freeze(Object.fromEntries(
  flattenConfigLeafPaths(CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG).map((path) => [
    path,
    readConfigPath(CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG, path),
  ]),
));
export const CODEX_APP_SERVER_INITIALIZE_IDENTITY = Object.freeze({
  clientInfoName: "prime_continuim",
  clientInfoTitle: "Prime Continuim",
  capabilities: Object.freeze({ experimentalApi: true }),
  userAgentTemplate: "prime_continuim/0.147.0 (Windows <major>.<minor>.<build>; x86_64) unknown (prime_continuim; <clientVersion>)",
  platformFamily: "windows",
  platformOs: "windows",
});
export const CODEX_APP_SERVER_THREAD_START_POLICY = Object.freeze({
  requiredCapability: "experimentalApi",
  requestKeys: Object.freeze([
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
  ]),
  modelProvider: "openai",
  cwd: "absolute-workspace",
  runtimeWorkspaceRoots: "exact-cwd-only",
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: "read-only",
  config: "attested-thread-config",
  ephemeral: false,
  environments: Object.freeze([]),
  dynamicTools: Object.freeze([]),
  selectedCapabilityRoots: Object.freeze([]),
  experimentalRawEvents: false,
  deleteAfterSmoke: true,
  expectedSecurityResponse: Object.freeze({
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    runtimeWorkspaceRoots: Object.freeze([]),
    instructionSources: Object.freeze([]),
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: Object.freeze({ type: "readOnly", networkAccess: false }),
    activePermissionProfile: null,
    multiAgentMode: "explicitRequestOnly",
  }),
});
export const CODEX_APP_SERVER_CODEX_HOME_POLICY = Object.freeze({
  requireEmptyAtLaunch: true,
  allowedGeneratedSystemSkillsRoot: "skills/.system",
  forbiddenBasenames: Object.freeze([
    ".credentials.json",
    ".env",
    "AGENTS.md",
    "auth.json",
    "config.toml",
    "hooks.json",
    "managed_config.toml",
    "requirements.toml",
  ]),
  forbiddenTopLevelDirectories: Object.freeze([
    ".agents",
    ".codex",
    "agents",
    "commands",
    "marketplaces",
    "plugins",
    "prompts",
    "rules",
  ]),
  forbiddenExecutableExtensions: Object.freeze([
    ".bat",
    ".cmd",
    ".com",
    ".cjs",
    ".dll",
    ".exe",
    ".js",
    ".jsx",
    ".mjs",
    ".ps1",
    ".py",
    ".sh",
    ".ts",
    ".tsx",
  ]),
});

const CODEX_APP_SERVER_RELEASE = Object.freeze({
  repository: "https://github.com/openai/codex",
  tag: "rust-v0.147.0",
  version: "0.147.0",
  tagObject: "3ed6f04f6bf8b7c46299d1cb1ff99c74ce21a51d",
  commit: "be6e8eac029b183056b7e4402879f15d2c85f61b",
});
const CODEX_APP_SERVER_ASSET = Object.freeze({
  fileName: "codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
  url: "https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
  size: 110_054_928,
  expandedSize: 319_488_000,
  sha256: "c8908d687cf7caa3074921479726db32f96a295372c3544f1e96919a7254951f",
});
const CODEX_APP_SERVER_PACKAGE_METADATA = Object.freeze({
  layoutVersion: 1,
  version: "0.147.0",
  target: "x86_64-pc-windows-msvc",
  variant: "codex-app-server",
  entrypoint: "bin/codex-app-server.exe",
  resourcesDir: "codex-resources",
  pathDir: "codex-path",
});
const CODEX_APP_SERVER_ARCHIVE_MEMBERS = Object.freeze([
  Object.freeze({ path: "bin/", type: "directory", size: 0 }),
  Object.freeze({ path: "bin/codex-app-server.exe", type: "file", size: 247_694_640, sha256: "5f9fcc5c8cb2358908534d42ed00dff72e0295a8b76bdc69e01a8bca75e29662" }),
  Object.freeze({ path: "bin/codex-code-mode-host.exe", type: "file", size: 57_450_288, sha256: "37c23a542037e1bcfd0fa7eb4a150c697229d7ff31bf675c519d5bff7226b191" }),
  Object.freeze({ path: "codex-package.json", type: "file", size: 237, sha256: "90f75ac3f356281935567105ce486bd42fc23f25812d1629f2a048255a1b6496" }),
  Object.freeze({ path: "codex-path/", type: "directory", size: 0 }),
  Object.freeze({ path: "codex-path/rg.exe", type: "file", size: 4_218_880, sha256: "14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680" }),
  Object.freeze({ path: "codex-resources/", type: "directory", size: 0 }),
  Object.freeze({ path: "codex-resources/codex-command-runner.exe", type: "file", size: 1_300_272, sha256: "3a70491d8d588afa459a42816f05b8c2fdd6bddb0ef318f3dfccc963a30b420a" }),
  Object.freeze({ path: "codex-resources/codex-windows-sandbox-setup.exe", type: "file", size: 8_804_144, sha256: "a4df86996dfbb218d96d73a80606d89b742dfa4ddd3470614e90dde89e3250a3" }),
]);
const CODEX_APP_SERVER_AUTHENTICODE = Object.freeze({
  publisherSubject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US',
  issuer: "CN=Microsoft ID Verified CS EOC CA 04, O=Microsoft Corporation, C=US",
  signerThumbprint: "8B0ADFB840E141DAD3044D2B5AC819873DDE3590",
  signedFiles: Object.freeze([
    "bin/codex-app-server.exe",
    "bin/codex-code-mode-host.exe",
    "codex-resources/codex-command-runner.exe",
    "codex-resources/codex-windows-sandbox-setup.exe",
  ]),
  unsignedFiles: Object.freeze(["codex-path/rg.exe"]),
});

export class PrimeAgentRuntimeBuildError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "PrimeAgentRuntimeBuildError";
  }
}

export async function loadRuntimeInputs(templateDirectory = RUNTIME_TEMPLATE_DIRECTORY) {
  const [packageJson, lockfile, sources, policy] = await Promise.all([
    readJson(join(templateDirectory, "package.json")),
    readJson(join(templateDirectory, "package-lock.json")),
    readJson(join(templateDirectory, "sources.json")),
    readJson(join(templateDirectory, "runtime-policy.json")),
  ]);
  validateRuntimeInputs({ packageJson, lockfile, sources, policy });
  assertMinimumNodeVersion(process.versions.node, policy.minimumNodeVersion);
  const [lockfileSha256, sourcesSha256, policySha256] = await Promise.all([
    sha256File(join(templateDirectory, "package-lock.json")),
    sha256File(join(templateDirectory, "sources.json")),
    sha256File(join(templateDirectory, "runtime-policy.json")),
  ]);
  return Object.freeze({
    templateDirectory,
    packageJson,
    lockfile,
    sources,
    policy,
    lockfileSha256,
    sourcesSha256,
    policySha256,
  });
}

function assertMinimumNodeVersion(actual, minimum) {
  const parse = (value) => String(value).split(".").slice(0, 3).map((part) => Number(part));
  const actualParts = parse(actual);
  const minimumParts = parse(minimum);
  if (
    actualParts.length !== 3 ||
    minimumParts.length !== 3 ||
    [...actualParts, ...minimumParts].some((part) => !Number.isInteger(part) || part < 0)
  ) {
    throw buildError("Runtime Node version policy is invalid.");
  }
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] > minimumParts[index]) return;
    if (actualParts[index] < minimumParts[index]) {
      throw buildError(`Runtime assembly requires Node >=${minimum}; received ${actual}.`);
    }
  }
}

export function validateRuntimeInputs({ packageJson, lockfile, sources, policy }) {
  assertRecord(packageJson, "runtime package.json");
  assertRecord(lockfile, "runtime package-lock.json");
  assertRecord(sources, "runtime sources.json");
  assertRecord(policy, "runtime policy");
  if (packageJson.name !== "@prime-continuim/prime-agent-runtime" || packageJson.private !== true) {
    throw buildError("Runtime package identity or privacy flag is invalid.");
  }
  if (packageJson.version !== policy.releaseVersion || sources.release?.version !== policy.releaseVersion) {
    throw buildError("Runtime release versions do not agree.");
  }
  if (lockfile.lockfileVersion !== policy.lockfileVersion || lockfile.lockfileVersion !== 3) {
    throw buildError("Runtime lockfile version does not match policy.");
  }
  if (policy.npmVersion !== "10.9.8") {
    throw buildError("Runtime npm tooling changed without review.");
  }
  assertRecord(lockfile.packages, "runtime lock packages");
  const lockEntries = Object.entries(lockfile.packages);
  if (lockEntries.length !== policy.lockPackageEntries) {
    throw buildError(`Runtime lock package count changed (${lockEntries.length}).`);
  }
  const root = lockfile.packages[""];
  if (
    root?.name !== packageJson.name ||
    root?.version !== packageJson.version ||
    JSON.stringify(root?.dependencies) !== JSON.stringify(packageJson.dependencies)
  ) {
    throw buildError("Runtime lock root no longer matches package.json.");
  }

  const allowedHosts = new Set(sources.allowedDownloadHosts);
  if (allowedHosts.size !== sources.allowedDownloadHosts?.length || allowedHosts.size < 3) {
    throw buildError("Runtime download host allowlist is invalid.");
  }
  for (const [packagePath, entry] of lockEntries) {
    if (packagePath === "") continue;
    assertRecord(entry, `lock entry ${packagePath}`);
    if (typeof entry.resolved !== "string" || typeof entry.integrity !== "string") {
      throw buildError(`Lock entry ${packagePath} is not content-addressed.`);
    }
    const resolvedUrl = parseAllowedHttpsUrl(entry.resolved, allowedHosts);
    if (!resolvedUrl || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) {
      throw buildError(`Lock entry ${packagePath} has an invalid source or integrity.`);
    }
  }

  if (!Array.isArray(sources.assets) || sources.assets.length !== 4) {
    throw buildError("Exactly four Prime Agent release assets must be pinned.");
  }
  for (const asset of sources.assets) {
    assertRecord(asset, "release asset");
    parseAllowedHttpsUrl(asset.url, allowedHosts);
    if (
      !Number.isInteger(asset.size) ||
      asset.size < 1 ||
      asset.size > MAX_ASSET_BYTES ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(asset.integrity)
    ) {
      throw buildError(`Release asset ${asset.fileName ?? "(unknown)"} has invalid bounds or digests.`);
    }
    const matchingEntries = lockEntries.filter(([, entry]) => entry.resolved === asset.url);
    if (matchingEntries.length < 1 || matchingEntries.some(([, entry]) => entry.integrity !== asset.integrity)) {
      throw buildError(`Release asset ${asset.fileName} is not pinned exactly by the lockfile.`);
    }
  }

  const prime = lockfile.packages["node_modules/prime-agent"];
  const zeromq = lockfile.packages["node_modules/zeromq"];
  for (const [name, entry] of Object.entries({ "prime-agent": prime, zeromq })) {
    const expected = policy.criticalPackages?.[name];
    if (!entry || entry.version !== expected?.version || entry.integrity !== expected?.integrity) {
      throw buildError(`Critical package ${name} drifted from runtime policy.`);
    }
  }
  if (
    policy.install?.ignoreScripts !== true ||
    policy.install?.omitDev !== true ||
    policy.install?.omitOptional !== true ||
    policy.install?.installStrategy !== "hoisted" ||
    policy.install?.targetNativePrebuildsOnly !== true
  ) {
    throw buildError("Runtime install policy must disable scripts, development, and optional packages.");
  }
  if (
    !Array.isArray(policy.packaging?.excludedBasenames) ||
    JSON.stringify(policy.packaging.excludedBasenames) !== JSON.stringify([".gitkeep"])
  ) {
    throw buildError("Runtime packaging exclusions changed without review.");
  }
  for (const entrypoint of Object.values(policy.entrypoints ?? {})) {
    assertSafeRelativePath(entrypoint, "runtime entrypoint");
  }
  validateCodexAppServerInputs(sources, policy, allowedHosts);
}

function validateCodexAppServerInputs(sources, policy, allowedHosts) {
  const source = sources.codexAppServer;
  const companion = policy.codexAppServer;
  assertRecord(source, "Codex app-server source");
  assertRecord(companion, "Codex app-server policy");
  if (!jsonEqual(source.release, CODEX_APP_SERVER_RELEASE)) {
    throw buildError("Codex app-server release identity changed without review.");
  }
  if (!jsonEqual(source.asset, CODEX_APP_SERVER_ASSET)) {
    throw buildError("Codex app-server release asset changed without review.");
  }
  if (!jsonEqual(source.legalFiles, CODEX_APP_SERVER_LEGAL_FILES)) {
    throw buildError("Codex app-server legal-resource provenance changed without review.");
  }
  for (const legalFile of source.legalFiles) {
    parseAllowedHttpsUrl(legalFile.url, allowedHosts);
    assertSafeRelativePath(legalFile.path, "Codex app-server legal resource");
    if (!legalFile.path.startsWith("legal/") || legalFile.size > 64 * 1024) {
      throw buildError("Codex app-server legal resource bounds are invalid.");
    }
  }
  parseAllowedHttpsUrl(source.asset.url, allowedHosts);
  if (
    source.asset.size > MAX_CODEX_APP_SERVER_ASSET_BYTES ||
    !Number.isSafeInteger(source.asset.expandedSize) ||
    source.asset.expandedSize <= source.asset.size
  ) {
    throw buildError("Codex app-server release asset bounds are invalid.");
  }
  if (!jsonEqual(source.archiveMembers, CODEX_APP_SERVER_ARCHIVE_MEMBERS)) {
    throw buildError("Codex app-server archive member allowlist changed without review.");
  }
  if (!jsonEqual(source.packageMetadata, CODEX_APP_SERVER_PACKAGE_METADATA)) {
    throw buildError("Codex app-server package metadata changed without review.");
  }
  if (!jsonEqual(source.authenticode, CODEX_APP_SERVER_AUTHENTICODE)) {
    throw buildError("Codex app-server publisher policy changed without review.");
  }
  const expectedPolicy = {
    platform: "win32",
    arch: "x64",
    target: CODEX_APP_SERVER_PACKAGE_METADATA.target,
    directory: CODEX_APP_SERVER_COMPANION_DIRECTORY,
    entrypoint: `${CODEX_APP_SERVER_COMPANION_DIRECTORY}/${CODEX_APP_SERVER_PACKAGE_METADATA.entrypoint}`,
    packageMetadata: `${CODEX_APP_SERVER_COMPANION_DIRECTORY}/codex-package.json`,
    fixedArguments: CODEX_APP_SERVER_FIXED_ARGUMENTS,
    sessionConfig: CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG,
    threadConfig: CODEX_APP_SERVER_THREAD_CONFIG,
    initializeIdentity: CODEX_APP_SERVER_INITIALIZE_IDENTITY,
    threadStartPolicy: CODEX_APP_SERVER_THREAD_START_POLICY,
    environmentPolicy: CODEX_APP_SERVER_ENVIRONMENT_POLICY,
    codexHomePolicy: CODEX_APP_SERVER_CODEX_HOME_POLICY,
    protocol: "jsonl-stdio",
    credentialStore: "keyring",
    mcpCredentialStore: "keyring",
    forcedLoginMethod: "chatgpt",
  };
  if (!jsonEqual(companion, expectedPolicy)) {
    throw buildError("Codex app-server launch policy changed without review.");
  }
  assertSafeRelativePath(companion.directory, "Codex app-server directory");
  assertSafeRelativePath(companion.entrypoint, "Codex app-server entrypoint");
  assertSafeRelativePath(companion.packageMetadata, "Codex app-server package metadata path");
}

export async function verifyReleaseAssets(inputs, cacheDirectory, options = {}) {
  await mkdir(cacheDirectory, { recursive: true });
  const allowedHosts = new Set(inputs.sources.allowedDownloadHosts);
  const verified = [];
  for (const asset of inputs.sources.assets) {
    const destination = join(cacheDirectory, `${asset.sha256}-${asset.fileName}`);
    if (await fileMatches(destination, asset)) {
      verified.push(destination);
      continue;
    }
    await rm(destination, { force: true });
    await downloadVerifiedAsset(asset, destination, allowedHosts, { ...options, maximumBytes: MAX_ASSET_BYTES });
    verified.push(destination);
  }
  if (codexAppServerSupportedForTarget(inputs.policy, options.platform, options.arch)) {
    const asset = inputs.sources.codexAppServer.asset;
    const destination = join(cacheDirectory, `${asset.sha256}-${asset.fileName}`);
    if (!(await fileMatches(destination, asset))) {
      await rm(destination, { force: true });
      await downloadVerifiedAsset(asset, destination, allowedHosts, {
        ...options,
        maximumBytes: MAX_CODEX_APP_SERVER_ASSET_BYTES,
      });
    }
    verified.push(destination);
    for (const legalFile of inputs.sources.codexAppServer.legalFiles) {
      const legalDestination = join(cacheDirectory, `${legalFile.sha256}-${legalFile.fileName}`);
      if (!(await fileMatches(legalDestination, legalFile))) {
        await rm(legalDestination, { force: true });
        await downloadVerifiedAsset(legalFile, legalDestination, allowedHosts, {
          ...options,
          maximumBytes: 64 * 1024,
        });
      }
      verified.push(legalDestination);
    }
  }
  return Object.freeze(verified);
}

export function codexAppServerSupportedForTarget(
  policy,
  platform = process.platform,
  arch = process.arch,
) {
  return platform === policy?.codexAppServer?.platform && arch === policy?.codexAppServer?.arch;
}

async function downloadVerifiedAsset(asset, destination, allowedHosts, options) {
  const partial = `${destination}.partial-${randomUUID()}`;
  let handle;
  try {
    const controller = new AbortController();
    const limits = {
      startedAt: Date.now(),
      totalTimeoutMs: options.totalTimeoutMs ?? DOWNLOAD_TOTAL_TIMEOUT_MS,
      noProgressTimeoutMs: options.noProgressTimeoutMs ?? DOWNLOAD_NO_PROGRESS_TIMEOUT_MS,
      controller,
    };
    const response = await awaitDownloadProgress(
      fetchAllowed(asset.url, allowedHosts, { fetchImpl: options.fetchImpl ?? fetch, signal: controller.signal }),
      limits,
      asset.fileName,
      true,
    );
    if (!response.ok || !response.body) {
      throw buildError(`Could not download ${asset.fileName}: HTTP ${response.status}.`);
    }
    handle = await open(partial, "wx", 0o600);
    const digest = createHash("sha256");
    let bytes = 0;
    const reader = response.body.getReader();
    while (true) {
      const result = await awaitDownloadProgress(reader.read(), limits, asset.fileName, false);
      if (result.done) break;
      const chunk = result.value;
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > asset.size || bytes > options.maximumBytes) {
        throw buildError(`Download exceeded the pinned size for ${asset.fileName}.`);
      }
      digest.update(buffer);
      await handle.write(buffer);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    const sha256 = digest.digest("hex");
    if (bytes !== asset.size || sha256 !== asset.sha256) {
      throw buildError(`Downloaded bytes did not match the pinned ${asset.fileName} digest.`);
    }
    await rename(partial, destination);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function fetchAllowed(url, allowedHosts, { fetchImpl, signal }) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= DOWNLOAD_REDIRECT_LIMIT; redirects += 1) {
    if (current.protocol !== "https:" || !allowedHosts.has(current.hostname)) {
      throw buildError(`Download redirected to a non-allowlisted host: ${current.hostname}.`);
    }
    const response = await fetchImpl(current, {
      redirect: "manual",
      headers: { "User-Agent": "Prime-Continuim-Runtime-Builder/0.1" },
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw buildError(`Download redirect from ${current.hostname} omitted Location.`);
    current = new URL(location, current);
  }
  throw buildError("Release asset exceeded the redirect limit.");
}

async function awaitDownloadProgress(operation, limits, fileName, totalOnly) {
  const elapsed = Date.now() - limits.startedAt;
  const remainingTotal = limits.totalTimeoutMs - elapsed;
  const timeoutMs = totalOnly ? remainingTotal : Math.min(remainingTotal, limits.noProgressTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    limits.controller.abort();
    throw buildError(`Download timed out for ${fileName}; check the network or proxy and retry.`);
  }
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const totalExpired = Date.now() - limits.startedAt >= limits.totalTimeoutMs;
          reject(buildError(totalExpired
            ? `Download timed out for ${fileName}; check the network or proxy and retry.`
            : `Download made no progress for ${fileName}; check the network or proxy and retry.`));
          limits.controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function discoverNpmCli(explicitPath) {
  const candidates = [
    explicitPath,
    join(REPO_ROOT, "node_modules", "npm", "bin", "npm-cli.js"),
    typeof process.env.npm_execpath === "string" && /(?:^|[\\/])npm-cli\.js$/i.test(process.env.npm_execpath)
      ? process.env.npm_execpath
      : undefined,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    try {
      await access(resolved, fsConstants.R_OK);
      return realpath(resolved);
    } catch {
      // Continue through explicit, environment, and standard Node layouts.
    }
  }
  throw buildError("A readable absolute npm-cli.js is required; pass --npm-cli or PRIME_CONTINUIM_NPM_CLI.");
}

export async function installLockedRuntime({ inputs, stagingDirectory, npmCli }) {
  await mkdir(stagingDirectory, { recursive: false });
  await Promise.all([
    copyFile(join(inputs.templateDirectory, "package.json"), join(stagingDirectory, "package.json")),
    copyFile(join(inputs.templateDirectory, "package-lock.json"), join(stagingDirectory, "package-lock.json")),
  ]);
  const npmConfigPaths = {
    user: join(stagingDirectory, ".prime-continuim-user-npmrc"),
    global: join(stagingDirectory, ".prime-continuim-global-npmrc"),
  };
  await Promise.all([
    writeFile(npmConfigPaths.user, "", { encoding: "utf8", mode: 0o600, flag: "wx" }),
    writeFile(npmConfigPaths.global, "", { encoding: "utf8", mode: 0o600, flag: "wx" }),
  ]);
  let npmVersion;
  try {
    const environment = cleanBuildEnvironment(process.env, npmConfigPaths);
    npmVersion = (await runCommand(process.execPath, [npmCli, "--version"], {
      cwd: stagingDirectory,
      env: environment,
    })).stdout.trim();
    if (npmVersion !== inputs.policy.npmVersion) {
      throw buildError(`Runtime assembly requires reviewed npm ${inputs.policy.npmVersion}; received ${npmVersion || "unknown"}.`);
    }
    await runCommand(
      process.execPath,
      [
        npmCli,
        "ci",
        "--ignore-scripts",
        "--omit=dev",
        "--omit=optional",
        "--no-audit",
        "--no-fund",
        "--install-strategy=hoisted",
      ],
      {
        cwd: stagingDirectory,
        env: environment,
        inheritOutput: true,
        timeoutMs: 5 * 60_000,
      },
    );
  } finally {
    await Promise.all([
      rm(npmConfigPaths.user, { force: true }),
      rm(npmConfigPaths.global, { force: true }),
    ]);
  }
  await rm(join(stagingDirectory, "node_modules", ".bin"), { recursive: true, force: true });
  return npmVersion;
}

export async function installCodexAppServerCompanion({
  inputs,
  runtimeDirectory,
  verifiedAssets,
  platform = process.platform,
  arch = process.arch,
  authenticodeInspector,
}) {
  if (!codexAppServerSupportedForTarget(inputs.policy, platform, arch)) return undefined;
  if (!Array.isArray(verifiedAssets)) throw buildError("Verified runtime asset paths are required.");
  const asset = inputs.sources.codexAppServer.asset;
  const expectedBasename = `${asset.sha256}-${asset.fileName}`;
  const matches = verifiedAssets.filter((candidate) => basename(candidate) === expectedBasename);
  if (matches.length !== 1 || !(await fileMatches(matches[0], asset))) {
    throw buildError("The pinned Codex app-server asset was not verified exactly once.");
  }
  const legalAssets = [];
  for (const legalFile of inputs.sources.codexAppServer.legalFiles) {
    const legalBasename = `${legalFile.sha256}-${legalFile.fileName}`;
    const legalMatches = verifiedAssets.filter((candidate) => basename(candidate) === legalBasename);
    if (legalMatches.length !== 1 || !(await fileMatches(legalMatches[0], legalFile))) {
      throw buildError(`The pinned Codex app-server ${legalFile.path} was not verified exactly once.`);
    }
    legalAssets.push({ source: legalMatches[0], record: legalFile });
  }
  const runtimeRoot = await realpath(runtimeDirectory);
  const companionsDirectory = join(runtimeRoot, "companions");
  const companionDirectory = join(runtimeRoot, ...inputs.policy.codexAppServer.directory.split("/"));
  if (companionDirectory !== join(companionsDirectory, "codex-app-server")) {
    throw buildError("Codex app-server companion directory escaped its reviewed namespace.");
  }
  await mkdir(companionsDirectory, { recursive: false });
  await mkdir(companionDirectory, { recursive: false });
  await extractCodexAppServerArchive({
    assetPath: matches[0],
    destinationDirectory: companionDirectory,
    source: inputs.sources.codexAppServer,
  });
  const legalDirectory = join(companionDirectory, "legal");
  await mkdir(legalDirectory, { recursive: false });
  for (const legalFile of legalAssets) {
    const destination = join(companionDirectory, ...legalFile.record.path.split("/"));
    assertContainedPath(legalDirectory, destination, "Codex app-server legal resource");
    await copyFile(legalFile.source, destination, fsConstants.COPYFILE_EXCL);
    if (!(await fileMatches(destination, legalFile.record))) {
      throw buildError(`Installed Codex app-server ${legalFile.record.path} bytes drifted.`);
    }
  }
  return await verifyCodexAppServerCompanion(runtimeRoot, {
    inputs,
    policy: inputs.policy,
    platform,
    arch,
    authenticodeInspector,
  });
}

export async function extractCodexAppServerArchive({ assetPath, destinationDirectory, source }) {
  const assetDetails = await lstat(assetPath);
  if (
    !assetDetails.isFile() ||
    assetDetails.isSymbolicLink() ||
    assetDetails.size !== source?.asset?.size ||
    (await sha256File(assetPath)) !== source.asset.sha256
  ) {
    throw buildError("Codex app-server archive bytes do not match the pinned asset.");
  }
  const destinationDetails = await lstat(destinationDirectory);
  if (!destinationDetails.isDirectory() || destinationDetails.isSymbolicLink()) {
    throw buildError("Codex app-server extraction root must be a plain directory.");
  }
  const initialEntries = await readdir(destinationDirectory);
  if (initialEntries.length !== 0) throw buildError("Codex app-server extraction root must be empty.");
  const expectedMembers = source.archiveMembers;
  let logicalMemberIndex = 0;
  let totalExpandedBytes = 0;
  let state = "header";
  let headerBuffer = Buffer.alloc(0);
  let pendingPax = false;
  let current;
  let currentHandle;
  let currentDigest;
  let remaining = 0;
  let padding = 0;
  let paxChunks = [];
  let zeroBlocks = 0;
  const stream = createReadStream(assetPath).pipe(createGunzip());

  const closeCurrent = async () => {
    if (!currentHandle) return;
    await currentHandle.sync();
    await currentHandle.close();
    currentHandle = undefined;
  };

  const finishMember = async () => {
    if (current.kind === "pax") {
      const pax = Buffer.concat(paxChunks);
      validateCodexPaxHeader(pax);
      pendingPax = true;
      paxChunks = [];
    } else if (current.expected.type === "file") {
      await closeCurrent();
      const digest = currentDigest.digest("hex");
      if (digest !== current.expected.sha256) {
        throw buildError(`Codex app-server archive member digest mismatch: ${current.expected.path}.`);
      }
      logicalMemberIndex += 1;
    } else {
      logicalMemberIndex += 1;
    }
    current = undefined;
    currentDigest = undefined;
    state = padding === 0 ? "header" : "padding";
  };

  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.from(rawChunk);
      totalExpandedBytes += chunk.byteLength;
      if (totalExpandedBytes > source.asset.expandedSize) {
        throw buildError("Codex app-server archive expanded beyond its pinned bound.");
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (state === "end") {
          if (chunk.subarray(offset).some((byte) => byte !== 0)) {
            throw buildError("Codex app-server archive contains bytes after its end marker.");
          }
          offset = chunk.byteLength;
          continue;
        }
        if (state === "header") {
          const take = Math.min(512 - headerBuffer.byteLength, chunk.byteLength - offset);
          headerBuffer = Buffer.concat([headerBuffer, chunk.subarray(offset, offset + take)]);
          offset += take;
          if (headerBuffer.byteLength < 512) continue;
          const header = headerBuffer;
          headerBuffer = Buffer.alloc(0);
          if (header.every((byte) => byte === 0)) {
            if (logicalMemberIndex !== expectedMembers.length || pendingPax) {
              throw buildError("Codex app-server archive ended before its exact member set.");
            }
            zeroBlocks += 1;
            if (zeroBlocks >= 2) state = "end";
            continue;
          }
          if (zeroBlocks !== 0) throw buildError("Codex app-server archive resumed after an end marker.");
          const parsed = parseTarHeader(header);
          if (parsed.type === "pax") {
            if (pendingPax || parsed.path !== "././@PaxHeader" || parsed.size < 1 || parsed.size > 128) {
              throw buildError("Codex app-server archive has an unexpected PAX header.");
            }
            current = { kind: "pax" };
            remaining = parsed.size;
            padding = tarPadding(parsed.size);
            paxChunks = [];
            state = "data";
            continue;
          }
          const expected = expectedMembers[logicalMemberIndex];
          if (
            !expected ||
            !pendingPax ||
            parsed.path !== expected.path ||
            parsed.type !== expected.type ||
            parsed.size !== expected.size
          ) {
            throw buildError(`Codex app-server archive member ${parsed.path} is not the next pinned member.`);
          }
          pendingPax = false;
          current = { kind: "logical", expected };
          remaining = parsed.size;
          padding = tarPadding(parsed.size);
          const destination = join(destinationDirectory, ...expected.path.replace(/\/$/, "").split("/"));
          assertContainedPath(destinationDirectory, destination, "Codex app-server archive member");
          if (expected.type === "directory") {
            await mkdir(destination, { recursive: false });
            await finishMember();
          } else {
            currentDigest = createHash("sha256");
            currentHandle = await open(destination, "wx", expected.path.endsWith(".exe") ? 0o700 : 0o600);
            state = "data";
            if (remaining === 0) await finishMember();
          }
          continue;
        }
        if (state === "data") {
          const take = Math.min(remaining, chunk.byteLength - offset);
          const bytes = chunk.subarray(offset, offset + take);
          offset += take;
          remaining -= take;
          if (current.kind === "pax") {
            paxChunks.push(bytes);
          } else {
            currentDigest.update(bytes);
            await currentHandle.write(bytes);
          }
          if (remaining === 0) await finishMember();
          continue;
        }
        if (state === "padding") {
          const take = Math.min(padding, chunk.byteLength - offset);
          if (chunk.subarray(offset, offset + take).some((byte) => byte !== 0)) {
            throw buildError("Codex app-server archive member padding is non-zero.");
          }
          offset += take;
          padding -= take;
          if (padding === 0) state = "header";
        }
      }
    }
    if (
      totalExpandedBytes !== source.asset.expandedSize ||
      state !== "end" ||
      zeroBlocks < 2 ||
      logicalMemberIndex !== expectedMembers.length ||
      pendingPax ||
      headerBuffer.byteLength !== 0 ||
      currentHandle
    ) {
      throw buildError("Codex app-server archive did not match its exact bounded layout.");
    }
  } catch (error) {
    await currentHandle?.close().catch(() => undefined);
    throw error;
  }
}

export async function verifyCodexAppServerCompanion(runtimeDirectory, options = {}) {
  const policy = options.policy;
  if (!codexAppServerSupportedForTarget(policy, options.platform, options.arch)) return undefined;
  const root = await realpath(runtimeDirectory);
  const companionDirectory = join(root, ...policy.codexAppServer.directory.split("/"));
  assertContainedPath(root, companionDirectory, "Codex app-server companion directory");
  const canonicalCompanion = await realpath(companionDirectory);
  if (canonicalCompanion !== companionDirectory) {
    throw buildError("Codex app-server companion directory is not physically canonical.");
  }
  const expectedFiles = options.inputs.sources.codexAppServer.archiveMembers
    .filter((member) => member.type === "file")
    .map(({ path, size, sha256 }) => ({ path, size, sha256 }))
    .concat(options.inputs.sources.codexAppServer.legalFiles.map(({ path, size, sha256 }) => ({
      path,
      size,
      sha256,
    })));
  const actualFiles = await collectRuntimeFiles(canonicalCompanion, { rejectEmptyDirectories: true });
  if (!jsonEqual(actualFiles, expectedFiles)) {
    throw buildError("Codex app-server companion files do not match the pinned release package.");
  }
  const packageMetadataPath = await requireContainedRealFile(
    root,
    policy.codexAppServer.packageMetadata,
    "Codex app-server package metadata",
  );
  const packageMetadata = await readJson(packageMetadataPath);
  if (!jsonEqual(packageMetadata, options.inputs.sources.codexAppServer.packageMetadata)) {
    throw buildError("Codex app-server package metadata does not match the pinned layout.");
  }
  const executablePath = await requireContainedRealFile(
    root,
    policy.codexAppServer.entrypoint,
    "Codex app-server entrypoint",
  );
  const publisher = await (options.authenticodeInspector ?? inspectCodexAppServerAuthenticode)(
    canonicalCompanion,
    options.inputs.sources.codexAppServer.authenticode,
  );
  return Object.freeze({
    release: options.inputs.sources.codexAppServer.release,
    asset: options.inputs.sources.codexAppServer.asset,
    legalFiles: options.inputs.sources.codexAppServer.legalFiles.map((value) => ({ ...value })),
    platform: policy.codexAppServer.platform,
    arch: policy.codexAppServer.arch,
    target: policy.codexAppServer.target,
    directory: policy.codexAppServer.directory,
    entrypoint: policy.codexAppServer.entrypoint,
    packageMetadata: {
      path: policy.codexAppServer.packageMetadata,
      sha256: expectedFiles.find((file) => file.path === "codex-package.json")?.sha256,
      ...packageMetadata,
    },
    fixedArguments: [...policy.codexAppServer.fixedArguments],
    sessionConfig: structuredClone(CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG),
    threadConfig: { ...CODEX_APP_SERVER_THREAD_CONFIG },
    initializeIdentity: { ...policy.codexAppServer.initializeIdentity },
    threadStartPolicy: structuredClone(policy.codexAppServer.threadStartPolicy),
    environmentPolicy: {
      ...policy.codexAppServer.environmentPolicy,
      requiredSourceVariables: [...policy.codexAppServer.environmentPolicy.requiredSourceVariables],
      constructedVariables: [...policy.codexAppServer.environmentPolicy.constructedVariables],
      pathEntries: [...policy.codexAppServer.environmentPolicy.pathEntries],
    },
    codexHomePolicy: {
      ...policy.codexAppServer.codexHomePolicy,
      forbiddenBasenames: [...policy.codexAppServer.codexHomePolicy.forbiddenBasenames],
      forbiddenTopLevelDirectories: [...policy.codexAppServer.codexHomePolicy.forbiddenTopLevelDirectories],
      forbiddenExecutableExtensions: [...policy.codexAppServer.codexHomePolicy.forbiddenExecutableExtensions],
    },
    publisher,
    executablePath,
  });
}

export async function inspectCodexAppServerAuthenticode(companionDirectory, policy) {
  if (process.platform !== "win32") throw buildError("Codex app-server publisher verification requires Windows.");
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot) || /[\0\r\n]/.test(systemRoot)) {
    throw buildError("SystemRoot is required for Codex app-server publisher verification.");
  }
  const powershell = await requireAbsoluteRealFile(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "Windows PowerShell",
  );
  const securityModule = await requireAbsoluteRealFile(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules", "Microsoft.PowerShell.Security", "Microsoft.PowerShell.Security.psd1"),
    "Windows PowerShell security module",
  );
  const inspectedPaths = [...policy.signedFiles, ...policy.unsignedFiles];
  const absolutePaths = [];
  for (const relativePath of inspectedPaths) {
    absolutePaths.push(await requireContainedRealFile(companionDirectory, relativePath, "Codex Authenticode input"));
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "Import-Module -Name $env:PRIME_CONTINUIM_CODEX_SECURITY_MODULE -Force",
    "$paths = ConvertFrom-Json -InputObject $env:PRIME_CONTINUIM_CODEX_SIGNATURE_PATHS",
    "$values = foreach ($path in $paths) {",
    "  $signature = Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop",
    "  [ordered]@{ Path = [string]$path; Status = [string]$signature.Status; Subject = if ($null -eq $signature.SignerCertificate) { '' } else { [string]$signature.SignerCertificate.Subject }; Issuer = if ($null -eq $signature.SignerCertificate) { '' } else { [string]$signature.SignerCertificate.Issuer }; Thumbprint = if ($null -eq $signature.SignerCertificate) { '' } else { [string]$signature.SignerCertificate.Thumbprint } }",
    "}",
    "@($values) | ConvertTo-Json -Compress",
  ].join("; ");
  const environment = createAuthenticodeEnvironment(process.env, {
    systemRoot,
    securityModule,
    paths: absolutePaths,
  });
  const result = await runCommand(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    env: environment,
    timeoutMs: 30_000,
  });
  let values;
  try {
    values = JSON.parse(result.stdout);
  } catch (error) {
    throw buildError("Codex app-server Authenticode verifier returned invalid JSON.", error);
  }
  if (!Array.isArray(values) || values.length !== inspectedPaths.length) {
    throw buildError("Codex app-server Authenticode verifier returned an incomplete result.");
  }
  const signed = [];
  const unsigned = [];
  for (let index = 0; index < inspectedPaths.length; index += 1) {
    const relativePath = inspectedPaths[index];
    const value = values[index];
    if (value?.Path !== absolutePaths[index]) throw buildError("Codex Authenticode result path changed in transit.");
    if (index < policy.signedFiles.length) {
      if (
        value.Status !== "Valid" ||
        value.Subject !== policy.publisherSubject ||
        value.Issuer !== policy.issuer ||
        String(value.Thumbprint).toUpperCase() !== policy.signerThumbprint
      ) {
        throw buildError(`Codex app-server publisher verification failed for ${relativePath}.`);
      }
      signed.push(relativePath);
    } else {
      if (value.Status !== "NotSigned" || value.Subject !== "" || value.Issuer !== "" || value.Thumbprint !== "") {
        throw buildError(`Codex app-server unsigned-tool policy failed for ${relativePath}.`);
      }
      unsigned.push(relativePath);
    }
  }
  return Object.freeze({
    status: "valid",
    subject: policy.publisherSubject,
    issuer: policy.issuer,
    thumbprint: policy.signerThumbprint,
    signedFiles: Object.freeze(signed),
    unsignedFiles: Object.freeze(unsigned),
  });
}

export async function smokeCodexAppServerCompanion(runtimeDirectory, options = {}) {
  if (!codexAppServerSupportedForTarget(options.policy, options.platform, options.arch)) return undefined;
  const root = await realpath(runtimeDirectory);
  const executablePath = await requireContainedRealFile(
    root,
    options.policy.codexAppServer.entrypoint,
    "Codex app-server smoke entrypoint",
  );
  const scratchDirectory = await mkdtemp(join(tmpdir(), "prime-continuim-codex-app-server-smoke-"));
  const codexHome = join(scratchDirectory, "codex-home");
  const temporaryDirectory = join(scratchDirectory, "codex-temp");
  await mkdir(codexHome, { recursive: false });
  await mkdir(temporaryDirectory, { recursive: false });
  try {
    const canonicalCodexHome = await realpath(codexHome);
    const canonicalTemporaryDirectory = await realpath(temporaryDirectory);
    await assertCodexHomePolicy(canonicalCodexHome, { requireEmpty: true });
    const environment = createCodexAppServerEnvironment(options.environment ?? process.env, {
      codexHome: canonicalCodexHome,
      companionDirectory: dirname(dirname(executablePath)),
      temporaryDirectory: canonicalTemporaryDirectory,
    });
    const smoke = await runCodexAppServerProtocolSmoke({
      executablePath,
      args: options.policy.codexAppServer.fixedArguments,
      codexHome: canonicalCodexHome,
      environment,
      spawnImpl: options.spawnImpl ?? spawn,
      timeoutMs: options.timeoutMs ?? 30_000,
      teardownTimeoutMs: options.teardownTimeoutMs ?? 5_000,
    });
    await assertCodexHomePolicy(canonicalCodexHome);
    return Object.freeze(smoke);
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

export async function pruneRuntimePackagingNoise(runtimeDirectory, policy) {
  const excludedBasenames = new Set(policy?.packaging?.excludedBasenames);
  if (excludedBasenames.size < 1 || excludedBasenames.size !== policy.packaging.excludedBasenames.length) {
    throw buildError("Runtime packaging exclusions are invalid.");
  }
  const removed = [];
  async function visit(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile() && excludedBasenames.has(entry.name)) {
        await rm(absolutePath, { force: false });
        removed.push(relativePath);
      }
    }
  }
  await visit(runtimeDirectory, "");
  return Object.freeze(removed);
}

export async function pruneEmptyRuntimeDirectories(runtimeDirectory) {
  const root = resolve(runtimeDirectory);
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw buildError("Runtime empty-directory pruning root must be a plain directory.");
  }
  const removed = [];
  async function visit(directory, prefix, expectedDetails) {
    await assertSamePlainDirectory(directory, expectedDetails);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    let retainedEntry = false;
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const childDetails = await lstat(absolutePath);
        if (!childDetails.isDirectory() || childDetails.isSymbolicLink()) {
          retainedEntry = true;
        } else if (!(await visit(absolutePath, relativePath, childDetails))) {
          retainedEntry = true;
        }
      } else {
        retainedEntry = true;
      }
    }
    if (!prefix || retainedEntry) return false;
    try {
      // Re-prove the exact directory identity immediately before the
      // non-recursive mutation; never act on a stale Dirent observation.
      await assertSamePlainDirectory(directory, expectedDetails);
      // rmdir is intentionally non-recursive: if anything appears after the
      // empty-directory check, fail to remove it instead of deleting bytes.
      await rmdir(directory);
      removed.push(prefix);
      return true;
    } catch (error) {
      if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return false;
      throw error;
    }
  }
  await visit(root, "", rootDetails);
  return Object.freeze(removed);
}

async function assertSamePlainDirectory(directory, expectedDetails) {
  const current = await lstat(directory);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== expectedDetails.dev ||
    current.ino !== expectedDetails.ino
  ) {
    throw buildError("Runtime directory identity changed during empty-directory pruning.");
  }
}

export async function removeLegacyRuntimeAssetCache(outputRoot, allowedFileNames) {
  if (
    !Array.isArray(allowedFileNames) ||
    allowedFileNames.length < 1 ||
    new Set(allowedFileNames).size !== allowedFileNames.length ||
    allowedFileNames.some((name) => typeof name !== "string" || basename(name) !== name || /[\0\r\n]/.test(name))
  ) {
    throw buildError("Legacy runtime cache cleanup requires exact asset basenames.");
  }
  const legacyRoot = join(resolve(outputRoot), "cache");
  try {
    await lstat(legacyRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const allowed = new Set(allowedFileNames);
  await assertExactLegacyRuntimeAssetCache(legacyRoot, allowed);

  // Moving the reviewed cache root is atomic and never follows a racing
  // junction/symlink to delete its target. The bytes remain available for
  // inspection under the excluded build-cache namespace.
  const resolvedOutputRoot = resolve(outputRoot);
  const quarantineRoot = join(dirname(resolvedOutputRoot), `${basename(resolvedOutputRoot)}-cache`);
  await mkdir(quarantineRoot, { recursive: true });
  const quarantineDetails = await lstat(quarantineRoot);
  if (!quarantineDetails.isDirectory() || quarantineDetails.isSymbolicLink()) {
    throw buildError("Runtime cache quarantine root must be a plain directory.");
  }
  const quarantinePath = join(quarantineRoot, `legacy-v1-${randomUUID()}`);
  await rename(legacyRoot, quarantinePath);
  await assertExactLegacyRuntimeAssetCache(quarantinePath, allowed);
  return true;
}

async function assertExactLegacyRuntimeAssetCache(cacheRoot, allowed) {
  const rootDetails = await lstat(cacheRoot);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw buildError("Legacy runtime cache root must be a plain directory.");
  }
  const rootEntries = await readdir(cacheRoot, { withFileTypes: true });
  if (rootEntries.length === 0) return;
  if (
    rootEntries.length !== 1 ||
    rootEntries[0]?.name !== "assets" ||
    !rootEntries[0].isDirectory() ||
    rootEntries[0].isSymbolicLink()
  ) {
    throw buildError("Legacy runtime cache contains an unexpected entry and requires inspection.");
  }
  const assetsDirectory = join(cacheRoot, "assets");
  const assetsDetails = await lstat(assetsDirectory);
  if (!assetsDetails.isDirectory() || assetsDetails.isSymbolicLink()) {
    throw buildError("Legacy runtime cache contains an unexpected entry and requires inspection.");
  }
  const assets = await readdir(assetsDirectory, { withFileTypes: true });
  for (const asset of assets) {
    const assetPath = join(assetsDirectory, asset.name);
    const details = await lstat(assetPath);
    if (
      !asset.isFile() ||
      asset.isSymbolicLink() ||
      !details.isFile() ||
      details.isSymbolicLink() ||
      !allowed.has(asset.name)
    ) {
      throw buildError("Legacy runtime asset cache contains an unexpected entry and requires inspection.");
    }
  }
}

export async function pruneRuntimeForTarget(runtimeDirectory) {
  const buildDirectory = join(runtimeDirectory, "node_modules", "zeromq", "build");
  const manifestPath = join(buildDirectory, "manifest.json");
  const manifest = await readJson(manifestPath);
  assertRecord(manifest, "zeromq native manifest");
  const libc = targetLibcFamily();
  const compatible = [];
  for (const [rawConfig, rawPath] of Object.entries(manifest)) {
    let config;
    try {
      config = JSON.parse(rawConfig);
    } catch (error) {
      throw buildError("zeromq native manifest contains an invalid configuration.", error);
    }
    if (config.os !== process.platform || config.arch !== process.arch || config.libc !== libc) continue;
    const relativeAddon = String(rawPath).replaceAll("\\", "/");
    assertSafeRelativePath(relativeAddon, "zeromq native addon");
    const addonPath = await requireContainedRealFile(buildDirectory, relativeAddon, "zeromq native addon");
    compatible.push({
      key: JSON.stringify({ os: config.os, arch: config.arch, libc: config.libc, abi: config.abi }),
      relativeAddon,
      contents: await readFile(addonPath),
    });
  }
  if (compatible.length < 1) {
    throw buildError(`zeromq has no reviewed prebuild for ${process.platform}-${process.arch}-${libc}.`);
  }
  compatible.sort((left, right) => left.key.localeCompare(right.key, "en-US"));
  // Windows antivirus and sync providers can briefly retain a just-installed
  // native image. Node's bounded recursive-rm retry handles only the documented
  // transient EPERM/EBUSY/ENOTEMPTY class; integrity errors still fail closed.
  await rm(buildDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  await mkdir(buildDirectory, { recursive: true });
  const filteredManifest = {};
  for (const entry of compatible) {
    const destination = join(buildDirectory, ...entry.relativeAddon.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.contents, { flag: "wx", mode: 0o600 });
    filteredManifest[entry.key] = entry.relativeAddon.split("/").join(sep);
  }
  await writeFile(manifestPath, `${JSON.stringify(filteredManifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function smokeRuntime(runtimeDirectory, options = {}) {
  const runtimeExecutable = await requireAbsoluteRealFile(options.runtimeExecutable ?? process.execPath, "runtime executable");
  const electronRunAsNode = options.electronRunAsNode ?? process.env.ELECTRON_RUN_AS_NODE === "1";
  const commandRunner = options.commandRunner ?? runCommand;
  if (typeof commandRunner !== "function") throw buildError("Runtime smoke command runner is invalid.");
  const entrypoints = await resolveVerifiedEntrypoints(runtimeDirectory, options.policy);
  const scratchDirectory = await mkdtemp(join(tmpdir(), "prime-continuim-runtime-smoke-"));
  const probePath = join(scratchDirectory, "runtime-probe.mjs");
  const daemonClientPath = join(scratchDirectory, "runtime-daemon-client.mjs");
  const probeSource = [
    'import { createRequire } from "node:module";',
    "const [moduleUrl, packageJsonPath] = process.argv.slice(2);",
    "const runtime = await import(moduleUrl);",
    'if (typeof runtime.DaemonClient !== "function" || typeof runtime.DaemonAgentConnection?.attach !== "function") throw new Error("missing daemon exports");',
    "const require = createRequire(packageJsonPath);",
    'const zeromq = require("zeromq");',
    'if (!zeromq || (typeof zeromq !== "object" && typeof zeromq !== "function")) throw new Error("zeromq did not load");',
    'process.stdout.write(JSON.stringify({ node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch, ...(process.versions.electron ? { electron: process.versions.electron, runAsNode: process.env.ELECTRON_RUN_AS_NODE === "1" } : {}) }));',
  ].join("\n");
  const daemonClientSource = [
    "const [moduleUrl, socketPath] = process.argv.slice(2);",
    'if (!moduleUrl || !socketPath) throw new Error("missing daemon smoke arguments");',
    "const runtime = await import(moduleUrl);",
    'if (typeof runtime.DaemonClient !== "function") throw new Error("missing DaemonClient export");',
    "const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));",
    "let client;",
    "try {",
    "  const deadline = Date.now() + 15_000;",
    "  let lastError;",
    "  while (Date.now() < deadline) {",
    "    const candidate = new runtime.DaemonClient(socketPath);",
    "    try {",
    "      await candidate.connect(300);",
    "      client = candidate;",
    "      break;",
    "    } catch (error) {",
    "      lastError = error;",
    "      candidate.close();",
    "      await wait(30);",
    "    }",
    "  }",
    '  if (!client) throw new Error(`daemon did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);',
    "  const hello = client.hello ?? (await client.waitForHello(1_000));",
    '  const response = await client.request({ type: "shutdown", force: true }, 5_000);',
    '  if (response?.type !== "response" || response.command !== "shutdown" || response.success !== true) throw new Error("daemon did not confirm smoke shutdown");',
    "  process.stdout.write(JSON.stringify({ hello, response }));",
    "} finally {",
    "  client?.close();",
    "}",
  ].join("\n");
  let child;
  try {
    await Promise.all([
      writeFile(probePath, probeSource, { encoding: "utf8", mode: 0o600, flag: "wx" }),
      writeFile(daemonClientPath, daemonClientSource, { encoding: "utf8", mode: 0o600, flag: "wx" }),
    ]);
    const probe = await commandRunner(
      runtimeExecutable,
      [probePath, entrypoints.moduleUrl, entrypoints.packageJson],
      {
        cwd: runtimeDirectory,
        env: cleanRuntimeEnvironment(process.env, { electronRunAsNode }),
        timeoutMs: 30_000,
      },
    );
    const runtimeVersions = JSON.parse(probe.stdout);
    if (runtimeVersions.platform !== process.platform || runtimeVersions.arch !== process.arch) {
      throw buildError("Runtime smoke process target does not match the build target.");
    }
    assertMinimumNodeVersion(runtimeVersions.node, options.policy.minimumNodeVersion);

    const smokeAgentDirectory = join(scratchDirectory, "agent");
    await mkdir(smokeAgentDirectory, { recursive: false });
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\prime-continuim-runtime-${process.pid}-${randomUUID()}`
      : join(smokeAgentDirectory, "daemon.sock");
    const daemonEnvironment = cleanRuntimeEnvironment(process.env, { electronRunAsNode });
    daemonEnvironment.PRIME_AGENT_CODING_AGENT_DIR = smokeAgentDirectory;
    child = spawn(runtimeExecutable, [entrypoints.cli, "--mode", "daemon", "--daemon-socket", socketPath], {
      cwd: smokeAgentDirectory,
      detached: true,
      env: daemonEnvironment,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    const interactionResult = await commandRunner(
      runtimeExecutable,
      [daemonClientPath, entrypoints.moduleUrl, socketPath],
      {
        cwd: smokeAgentDirectory,
        env: daemonEnvironment,
        timeoutMs: 30_000,
      },
    );
    let interaction;
    try {
      interaction = JSON.parse(interactionResult.stdout);
    } catch (error) {
      throw buildError("Prime Agent daemon smoke helper returned invalid JSON.", error);
    }
    const hello = interaction?.hello;
    validateSmokeHello(hello, {
      socketPath,
      runtimeExecutable,
      cliEntrypoint: entrypoints.cli,
      policy: options.policy,
    });
    const response = interaction?.response;
    if (response?.type !== "response" || response.command !== "shutdown" || response.success !== true) {
      throw buildError("Prime Agent daemon did not confirm smoke shutdown.");
    }
    await waitForChildExit(child, 10_000);
    return Object.freeze({ runtimeExecutable, runtimeVersions, hello });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await rm(scratchDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function createRuntimeManifest({ runtimeDirectory, inputs, npmVersion, smoke, codexAppServer }) {
  const companionExpected = codexAppServerSupportedForTarget(inputs.policy);
  if (companionExpected !== Boolean(codexAppServer)) {
    throw buildError("Codex app-server companion presence does not match the build target.");
  }
  const entries = await collectRuntimeFiles(runtimeDirectory);
  const fileManifest = entries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join("");
  const treeSource = entries.map((entry) => `${entry.sha256} ${entry.size} ${entry.path}\n`).join("");
  const treeSha256 = sha256Text(treeSource);
  const fileManifestSha256 = sha256Text(fileManifest);
  const nativeAddons = entries.filter((entry) => entry.path.endsWith(".node"));
  if (nativeAddons.length < 1) throw buildError("Runtime tree contains no native addon to smoke and attest.");
  const manifest = {
    schemaVersion: 1,
    product: "Prime Continuim",
    runtime: "prime-agent",
    release: inputs.sources.release,
    runtimeBuildId: inputs.policy.runtimeBuildId,
    platform: process.platform,
    arch: process.arch,
    libc: runtimeLibcIdentity(),
    buildRuntime: {
      node: process.versions.node,
      modules: process.versions.modules,
      napi: process.versions.napi,
      npm: npmVersion,
    },
    smokeRuntime: smoke.runtimeVersions,
    sourcesSha256: inputs.sourcesSha256,
    policySha256: inputs.policySha256,
    packageLockSha256: inputs.lockfileSha256,
    installPolicy: inputs.policy.install,
    entrypoints: inputs.policy.entrypoints,
    daemon: inputs.policy.daemon,
    ...(codexAppServer
      ? { codexAppServer: codexAppServerManifestRecord(codexAppServer.verification, codexAppServer.smoke) }
      : {}),
    sources: inputs.sources.assets.map(({ packageName, fileName, url, size, sha256, integrity }) => ({
      packageName,
      fileName,
      url,
      size,
      sha256,
      integrity,
    })),
    nativeAddons,
    tree: {
      sha256: treeSha256,
      filesSha256: fileManifestSha256,
      fileCount: entries.length,
      totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
    },
  };
  await writeFile(join(runtimeDirectory, "files.sha256"), fileManifest, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await writeFile(join(runtimeDirectory, "runtime.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return Object.freeze(manifest);
}

export async function verifyBuiltRuntime(runtimeDirectory, options = {}) {
  const root = await realpath(runtimeDirectory);
  const manifest = await readJson(join(root, "runtime.json"));
  assertRecord(manifest, "runtime manifest");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.product !== "Prime Continuim" ||
    manifest.runtime !== "prime-agent" ||
    manifest.release?.version !== options.policy?.releaseVersion ||
    manifest.runtimeBuildId !== options.policy?.runtimeBuildId ||
    !jsonEqual(manifest.installPolicy, options.policy?.install) ||
    !jsonEqual(manifest.entrypoints, options.policy?.entrypoints) ||
    !jsonEqual(manifest.daemon, options.policy?.daemon)
  ) {
    throw buildError("Runtime manifest identity does not match the pinned policy.");
  }
  if (manifest.platform !== (options.platform ?? process.platform) || manifest.arch !== (options.arch ?? process.arch)) {
    throw buildError(`Runtime platform mismatch: ${manifest.platform}-${manifest.arch}.`);
  }
  if (
    typeof manifest.libc !== "string" ||
    !manifest.libc ||
    !runtimeVersionRecordIsValid(manifest.buildRuntime, { expectedNpm: options.policy?.npmVersion }) ||
    !runtimeVersionRecordIsValid(manifest.smokeRuntime, { requireNpm: false }) ||
    manifest.smokeRuntime.platform !== manifest.platform ||
    manifest.smokeRuntime.arch !== manifest.arch
  ) {
    throw buildError("Runtime manifest build or smoke identity is invalid.");
  }
  assertMinimumNodeVersion(manifest.buildRuntime.node, options.policy.minimumNodeVersion);
  assertMinimumNodeVersion(manifest.smokeRuntime.node, options.policy.minimumNodeVersion);
  const entries = await collectRuntimeFiles(root, { rejectEmptyDirectories: true });
  const fileManifest = entries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join("");
  const treeSource = entries.map((entry) => `${entry.sha256} ${entry.size} ${entry.path}\n`).join("");
  if (
    entries.length !== manifest.tree?.fileCount ||
    entries.reduce((total, entry) => total + entry.size, 0) !== manifest.tree?.totalBytes ||
    sha256Text(fileManifest) !== manifest.tree?.filesSha256 ||
    sha256Text(treeSource) !== manifest.tree?.sha256
  ) {
    throw buildError("Runtime tree does not match runtime.json.");
  }
  const recordedFiles = await readFile(join(root, "files.sha256"), "utf8");
  if (recordedFiles !== fileManifest) throw buildError("Runtime files.sha256 does not match the verified tree.");
  const nativeAddons = entries.filter((entry) => entry.path.endsWith(".node"));
  if (nativeAddons.length < 1 || !jsonEqual(manifest.nativeAddons, nativeAddons)) {
    throw buildError("Runtime native addon attestation does not match the verified tree.");
  }
  if (options.inputs) {
    const expectedSources = options.inputs.sources.assets.map(
      ({ packageName, fileName, url, size, sha256, integrity }) => ({ packageName, fileName, url, size, sha256, integrity }),
    );
    if (
      !jsonEqual(manifest.release, options.inputs.sources.release) ||
      !jsonEqual(manifest.sources, expectedSources) ||
      manifest.sourcesSha256 !== options.inputs.sourcesSha256 ||
      manifest.policySha256 !== options.inputs.policySha256 ||
      manifest.packageLockSha256 !== options.inputs.lockfileSha256
    ) {
      throw buildError("Runtime manifest does not match the checked-in source policy and lock.");
    }
  }
  const companionExpected = options.inputs
    ? codexAppServerSupportedForTarget(options.inputs.policy, options.platform, options.arch)
    : manifest.codexAppServer !== undefined;
  if (companionExpected !== (manifest.codexAppServer !== undefined)) {
    throw buildError("Runtime Codex app-server companion presence does not match the pinned target.");
  }
  if (manifest.codexAppServer !== undefined) {
    if (!options.inputs) throw buildError("Codex app-server companion verification requires checked-in inputs.");
    validateCodexAppServerSmoke(manifest.codexAppServer.smoke);
    const companion = await verifyCodexAppServerCompanion(root, {
      inputs: options.inputs,
      policy: options.policy,
      platform: options.platform,
      arch: options.arch,
      authenticodeInspector: options.authenticodeInspector,
    });
    const expectedCompanion = codexAppServerManifestRecord(companion, manifest.codexAppServer.smoke);
    if (!jsonEqual(manifest.codexAppServer, expectedCompanion)) {
      throw buildError("Runtime Codex app-server companion attestation does not match the verified files.");
    }
  }
  await resolveVerifiedEntrypoints(root, options.policy);
  return Object.freeze({ root, manifest });
}

function codexAppServerManifestRecord(verification, smoke) {
  validateCodexAppServerSmoke(smoke);
  const { executablePath: _privateExecutablePath, ...publicVerification } = verification;
  return {
    ...publicVerification,
    smoke: { ...smoke },
  };
}

function validateCodexAppServerSmoke(value) {
  if (!jsonEqual(value, {
    protocol: "jsonl-stdio",
    initialize: true,
    initializeIdentity: true,
    configRead: true,
    denyVectorEffective: true,
    windowsSandboxUnelevatedPrivateDesktop: true,
    mcpServersEmpty: true,
    hooksEmpty: true,
    pluginsEmpty: true,
    appsEmpty: true,
    threadStartReadOnly: true,
    threadNetworkAccessDisabled: true,
    threadDeleted: true,
    accountReadSignedOut: true,
    requiresOpenaiAuth: true,
    forbiddenConfigAbsent: true,
    authJsonAbsent: true,
  })) {
    throw buildError("Codex app-server signed-out smoke attestation is invalid.");
  }
}

function runtimeVersionRecordIsValid(value, { expectedNpm }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const key of ["node", "modules", "napi"]) {
    if (typeof value[key] !== "string" || value[key].length < 1) return false;
  }
  return expectedNpm === undefined || value.npm === expectedNpm;
}

export async function resolveVerifiedEntrypoints(runtimeDirectory, policy) {
  if (!policy?.entrypoints) throw buildError("Runtime entrypoint policy is required.");
  const root = await realpath(runtimeDirectory);
  const modulePath = await requireContainedRealFile(root, policy.entrypoints.module, "Prime Agent module");
  const cli = await requireContainedRealFile(root, policy.entrypoints.cli, "Prime Agent CLI");
  const packageJson = await requireContainedRealFile(root, "node_modules/prime-agent/package.json", "Prime Agent package");
  const packageValue = await readJson(packageJson);
  if (packageValue.name !== "prime-agent" || packageValue.version !== policy.releaseVersion) {
    throw buildError("Installed Prime Agent package identity is invalid.");
  }
  return Object.freeze({ root, modulePath, moduleUrl: pathToFileURL(modulePath).href, cli, packageJson });
}

export async function writeCurrentPointer(outputRoot, finalDirectory, manifest, manifestSha256) {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) throw buildError("Runtime manifest digest is invalid.");
  const relativeManifest = relative(outputRoot, join(finalDirectory, "runtime.json")).split(sep).join("/");
  assertSafeRelativePath(relativeManifest, "current runtime manifest");
  const pointer = {
    schemaVersion: 1,
    releaseVersion: manifest.release.version,
    platform: manifest.platform,
    arch: manifest.arch,
    treeSha256: manifest.tree.sha256,
    manifestSha256,
    runtimeManifest: relativeManifest,
  };
  const temporary = join(outputRoot, `.current-${randomUUID()}.json`);
  await writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, join(outputRoot, "current.json"));
  return pointer;
}

export async function removeObsoleteRuntimeInstalls(outputRoot, finalDirectory) {
  const { installsDirectory, keptName } = await resolveRuntimeInstallSelection(outputRoot, finalDirectory);
  const entries = await readdir(installsDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === keptName) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isSinglePathSegment(entry.name)) {
      throw buildError(`Runtime installs contains an unexpected entry: ${entry.name}.`);
    }
    const candidate = await realpath(join(installsDirectory, entry.name));
    const candidateName = relative(installsDirectory, candidate);
    if (candidateName !== entry.name || !isSinglePathSegment(candidateName)) {
      throw buildError(`Obsolete runtime install escapes its generated root: ${entry.name}.`);
    }
    await rm(candidate, { recursive: true, force: false });
  }
}

export async function verifyOnlySelectedRuntimeInstall(outputRoot, finalDirectory) {
  const { installsDirectory, keptName } = await resolveRuntimeInstallSelection(outputRoot, finalDirectory);
  const entries = await readdir(installsDirectory, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    entries[0]?.name !== keptName ||
    !entries[0].isDirectory() ||
    entries[0].isSymbolicLink()
  ) {
    throw buildError("Runtime installs must contain only the pointer-selected image.");
  }
}

async function resolveRuntimeInstallSelection(outputRoot, finalDirectory) {
  const canonicalOutputRoot = await realpath(outputRoot);
  const installsDirectory = await realpath(join(canonicalOutputRoot, "installs"));
  const canonicalFinalDirectory = await realpath(finalDirectory);
  const keptName = relative(installsDirectory, canonicalFinalDirectory);
  if (!isSinglePathSegment(keptName)) {
    throw buildError("The selected runtime install is not an immediate child of the installs directory.");
  }
  return { installsDirectory, keptName };
}

export async function acquireBuildLock(outputRoot) {
  await mkdir(outputRoot, { recursive: true });
  const lockPath = join(outputRoot, ".build.lock");
  let handle;
  for (let attempt = 0; attempt < 3 && !handle; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, platform: process.platform, arch: process.arch })}\n`);
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (error?.code !== "EEXIST" || !(await recoverDeadBuildLock(lockPath))) {
        throw buildError(`Runtime build lock is already held at ${lockPath}.`, error);
      }
    }
  }
  if (!handle) throw buildError(`Could not acquire runtime build lock at ${lockPath}.`);
  return async () => {
    await handle.close();
    await rm(lockPath, { force: true });
  };
}

async function recoverDeadBuildLock(lockPath) {
  let lock;
  try {
    const contents = await readFile(lockPath, "utf8");
    if (Buffer.byteLength(contents) > 4_096) return false;
    lock = JSON.parse(contents);
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(lock?.pid) || lock.pid < 1 || processIsRunning(lock.pid)) return false;
  const tombstone = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, tombstone);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
  await rm(tombstone, { force: true });
  return true;
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH" && error?.code !== "EINVAL";
  }
}

export async function runCommand(command, args, options = {}) {
  if (!isAbsolute(command)) throw buildError(`Command must be absolute: ${command}.`);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: options.inheritOutput ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    const append = (target, chunk) => {
      const text = Buffer.from(chunk).toString("utf8");
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        return target;
      }
      return target + text;
    };
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(buildError(`Could not start ${basename(command)}: ${error.message}.`, error));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return rejectRun(buildError(`${basename(command)} timed out.`));
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) return rejectRun(buildError(`${basename(command)} output exceeded its limit.`));
      if (code !== 0) {
        return rejectRun(buildError(`${basename(command)} failed (${code ?? signal ?? "unknown"}): ${stderr.trim().slice(-4_096)}`));
      }
      resolveRun({ stdout, stderr });
    });
  });
}

export function cleanBuildEnvironment(source, npmConfigPaths) {
  if (!isAbsolute(npmConfigPaths?.user) || !isAbsolute(npmConfigPaths?.global) || npmConfigPaths.user === npmConfigPaths.global) {
    throw buildError("Distinct absolute npm user and global config paths are required.");
  }
  const environment = cleanRuntimeEnvironment(source, { electronRunAsNode: false });
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("NPM_CONFIG_") || key.toUpperCase() === "PRIME_CONTINUIM_NPM_CLI") {
      delete environment[key];
    }
  }
  environment.npm_config_ignore_scripts = "true";
  environment.npm_config_audit = "false";
  environment.npm_config_fund = "false";
  environment.npm_config_install_strategy = "hoisted";
  environment.npm_config_userconfig = npmConfigPaths.user;
  environment.npm_config_globalconfig = npmConfigPaths.global;
  environment.PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL = "0";
  environment.PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = "0";
  return environment;
}

export function cleanRuntimeEnvironment(source, { electronRunAsNode }) {
  const environment = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    if (
      normalized.startsWith("PRIME_AGENT_INTERNAL_") ||
      normalized === "PRIME_AGENT_BUILD_ID" ||
      normalized === "PRIME_AGENT_LAUNCHER_PATH" ||
      normalized === "NODE_OPTIONS" ||
      normalized === "NODE_PATH" ||
      normalized === "ELECTRON_RUN_AS_NODE"
    ) {
      continue;
    }
    environment[key] = value;
  }
  if (electronRunAsNode) environment.ELECTRON_RUN_AS_NODE = "1";
  return environment;
}

function parseTarHeader(header) {
  if (!Buffer.isBuffer(header) || header.byteLength !== 512) {
    throw buildError("Codex app-server archive header is not one tar block.");
  }
  const recordedChecksum = parseTarOctal(header.subarray(148, 156), "tar checksum");
  let calculatedChecksum = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    calculatedChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (recordedChecksum !== calculatedChecksum) {
    throw buildError("Codex app-server archive header checksum is invalid.");
  }
  if (
    !header.subarray(257, 263).equals(Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0x00])) ||
    header.subarray(263, 265).toString("ascii") !== "00"
  ) {
    throw buildError("Codex app-server archive must use the reviewed POSIX tar format.");
  }
  const name = readTarText(header.subarray(0, 100), "tar member name");
  const prefix = readTarText(header.subarray(345, 500), "tar member prefix");
  const path = prefix ? `${prefix}/${name}` : name;
  if (!path || path.length > 4_096 || /[\\\0\r\n]/.test(path) || path.normalize("NFC") !== path) {
    throw buildError("Codex app-server archive contains an unsafe member path.");
  }
  const typeFlag = header[156];
  const type = typeFlag === 0 || typeFlag === 0x30
    ? "file"
    : typeFlag === 0x35
      ? "directory"
      : typeFlag === 0x78
        ? "pax"
        : undefined;
  if (!type) throw buildError(`Codex app-server archive contains unsupported tar type ${typeFlag}.`);
  const size = parseTarOctal(header.subarray(124, 136), "tar member size");
  if (!Number.isSafeInteger(size) || size < 0 || size > CODEX_APP_SERVER_ASSET.expandedSize) {
    throw buildError("Codex app-server archive member size is outside its bound.");
  }
  if ((type === "directory") !== path.endsWith("/") || (type === "directory" && size !== 0)) {
    throw buildError("Codex app-server archive directory entry is malformed.");
  }
  return { path, type, size };
}

function readTarText(bytes, label) {
  const terminator = bytes.indexOf(0);
  const end = terminator < 0 ? bytes.byteLength : terminator;
  if (terminator >= 0 && bytes.subarray(terminator).some((byte) => byte !== 0)) {
    throw buildError(`Codex app-server ${label} has non-zero bytes after its terminator.`);
  }
  const valueBytes = bytes.subarray(0, end);
  if (valueBytes.some((byte) => byte < 0x20 || byte > 0x7e)) {
    throw buildError(`Codex app-server ${label} is not printable ASCII.`);
  }
  return valueBytes.toString("ascii");
}

function parseTarOctal(bytes, label) {
  if (bytes[0] !== undefined && (bytes[0] & 0x80) !== 0) {
    throw buildError(`Codex app-server ${label} uses an unsupported base-256 value.`);
  }
  const text = bytes.toString("ascii");
  if (!/^[ 0-7]*\0?[ ]*$/.test(text)) throw buildError(`Codex app-server ${label} is not canonical octal.`);
  const digits = text.replace(/[\0 ]/g, "");
  if (!digits) return 0;
  const value = Number.parseInt(digits, 8);
  if (!Number.isSafeInteger(value)) throw buildError(`Codex app-server ${label} exceeds integer bounds.`);
  return value;
}

function validateCodexPaxHeader(bytes) {
  const text = bytes.toString("ascii");
  const match = /^(\d+) mtime=(\d+\.\d+)\n$/.exec(text);
  if (!match || Number(match[1]) !== bytes.byteLength || !Number.isFinite(Number(match[2]))) {
    throw buildError("Codex app-server archive PAX metadata is not the reviewed mtime-only record.");
  }
}

function tarPadding(size) {
  return (512 - (size % 512)) % 512;
}

function assertContainedPath(root, candidate, label) {
  const relation = relative(resolve(root), resolve(candidate));
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw buildError(`${label} escapes or aliases its reviewed root.`);
  }
}

function createAuthenticodeEnvironment(source, { systemRoot, securityModule, paths }) {
  const environment = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: join(systemRoot, "System32", "cmd.exe"),
    PATH: [
      join(systemRoot, "System32"),
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    ].join(";"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PRIME_CONTINUIM_CODEX_SECURITY_MODULE: securityModule,
    PRIME_CONTINUIM_CODEX_SIGNATURE_PATHS: JSON.stringify(paths),
  };
  for (const key of ["TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]) {
    if (typeof source[key] === "string" && !/[\0\r\n]/.test(source[key])) environment[key] = source[key];
  }
  return environment;
}

async function runCodexAppServerProtocolSmoke({
  executablePath,
  args,
  codexHome,
  environment,
  spawnImpl,
  timeoutMs,
  teardownTimeoutMs,
}) {
  const maximumOutputBytes = 512 * 1024;
  return await new Promise((resolveSmoke, rejectSmoke) => {
    const child = spawnImpl(executablePath, [...args], {
      cwd: codexHome,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuffer = Buffer.alloc(0);
    let stderr = "";
    let outputBytes = 0;
    const completedResponses = new Set();
    let terminalError;
    let settled = false;
    let inputClosed = false;
    let handshakeState = "starting";
    let activeThreadId;
    let threadStartedNotificationId;
    let threadNotLoaded = false;
    let threadDeletedNotification = false;
    let threadDeleteTimer;
    let teardownTimer;
    const timer = setTimeout(() => fail(buildError("Codex app-server signed-out smoke timed out.")), timeoutMs);
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(teardownTimer);
      clearTimeout(threadDeleteTimer);
      if (error) rejectSmoke(error);
      else resolveSmoke(value);
    };
    const fail = (error) => {
      if (settled) return;
      terminalError ??= error;
      if (!inputClosed) {
        inputClosed = true;
        child.stdin?.destroy();
      }
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (!teardownTimer) {
        teardownTimer = setTimeout(
          () => settle(buildError("Codex app-server smoke process teardown was not confirmed.", terminalError)),
          teardownTimeoutMs,
        );
      }
    };
    const beginGracefulShutdown = () => {
      if (!inputClosed) {
        inputClosed = true;
        child.stdin.end();
      }
      if (!teardownTimer) {
        teardownTimer = setTimeout(
          () => {
            teardownTimer = undefined;
            fail(buildError("Codex app-server did not exit after its stdio transport closed."));
          },
          teardownTimeoutMs,
        );
      }
    };
    const send = (message) => {
      if (settled || terminalError || inputClosed) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const validateInitialize = async (result) => {
      if (
        !isPlainObject(result) ||
        !hasExactObjectKeys(result, ["userAgent", "codexHome", "platformFamily", "platformOs"]) ||
        typeof result.codexHome !== "string" ||
        !isAbsolute(result.codexHome) ||
        /[\0\r\n]/.test(result.codexHome) ||
        result.platformFamily !== CODEX_APP_SERVER_INITIALIZE_IDENTITY.platformFamily ||
        result.platformOs !== CODEX_APP_SERVER_INITIALIZE_IDENTITY.platformOs ||
        typeof result.userAgent !== "string" ||
        !/^prime_continuim\/0\.147\.0 \(Windows [0-9]+\.[0-9]+\.[0-9]+; x86_64\) unknown \(prime_continuim; 0\.1\.0\)$/.test(result.userAgent)
      ) {
        throw buildError("Codex app-server initialize returned an incompatible identity.");
      }
      const returnedHome = await realpath(result.codexHome).catch((error) => {
        throw buildError("Codex app-server initialize returned an unavailable CODEX_HOME.", error);
      });
      if (returnedHome !== codexHome) {
        throw buildError("Codex app-server initialize returned a different physical CODEX_HOME.");
      }
    };
    const sendRequest = (id, method, params, state) => {
      handshakeState = state;
      send({ method, id, params });
    };
    const scheduleThreadDelete = () => {
      if (
        threadDeleteTimer ||
        activeThreadId === undefined ||
        threadStartedNotificationId !== activeThreadId
      ) return;
      handshakeState = "thread_delete_settling";
      threadDeleteTimer = setTimeout(() => {
        threadDeleteTimer = undefined;
        sendRequest(7, "thread/delete", { threadId: activeThreadId }, "delete_sent");
      }, 200);
    };
    const completeResponse = (id, state, label, result, validate, next) => {
      if (handshakeState !== state || completedResponses.has(id)) {
        fail(buildError(`Codex app-server ${label} response is invalid, duplicated, or out of order.`));
        return;
      }
      try {
        validate(result);
      } catch (error) {
        fail(error);
        return;
      }
      completedResponses.add(id);
      next();
    };
    const consumeFrame = (line) => {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch (error) {
        fail(buildError("Codex app-server smoke emitted invalid JSONL.", error));
        return;
      }
      if (!isPlainObject(frame)) {
        fail(buildError("Codex app-server smoke emitted a non-object frame."));
        return;
      }
      if (Object.hasOwn(frame, "id")) {
        if (!hasExactObjectKeys(frame, ["id", "result"]) || frame.error !== undefined) {
          fail(buildError("Codex app-server smoke received an invalid response or server request."));
          return;
        }
        if (frame.id === 0) {
          if (handshakeState !== "initialize_sent" || completedResponses.has(0)) {
            fail(buildError("Codex app-server initialize response is invalid or duplicated."));
            return;
          }
          handshakeState = "initialize_validating";
          void validateInitialize(frame.result).then(() => {
            if (terminalError || settled) return;
            completedResponses.add(0);
            send({ method: "initialized", params: {} });
            sendRequest(1, "config/read", { cwd: codexHome, includeLayers: true }, "config_sent");
          }).catch((error) => fail(error));
          return;
        }
        if (frame.id === 1) {
          completeResponse(1, "config_sent", "config/read", frame.result,
            (result) => validateCodexAppServerConfigRead(result, codexHome),
            () => sendRequest(2, "mcpServerStatus/list", { limit: 100, detail: "full" }, "mcp_sent"));
          return;
        }
        if (frame.id === 2) {
          completeResponse(2, "mcp_sent", "mcpServerStatus/list", frame.result,
            (result) => assertExactProtocolValue(result, { data: [], nextCursor: null }, "MCP server list"),
            () => sendRequest(3, "hooks/list", { cwds: [codexHome] }, "hooks_sent"));
          return;
        }
        if (frame.id === 3) {
          completeResponse(3, "hooks_sent", "hooks/list", frame.result,
            (result) => assertExactProtocolValue(result, {
              data: [{ cwd: codexHome, hooks: [], warnings: [], errors: [] }],
            }, "hook list"),
            () => sendRequest(4, "plugin/list", {
              cwds: [codexHome],
              marketplaceKinds: ["local"],
              forceRefetch: false,
            }, "plugins_sent"));
          return;
        }
        if (frame.id === 4) {
          completeResponse(4, "plugins_sent", "plugin/list", frame.result,
            (result) => assertExactProtocolValue(result, {
              marketplaces: [],
              marketplaceLoadErrors: [],
              featuredPluginIds: [],
            }, "plugin list"),
            () => sendRequest(5, "app/list", { limit: 100, forceRefetch: false }, "apps_sent"));
          return;
        }
        if (frame.id === 5) {
          completeResponse(5, "apps_sent", "app/list", frame.result,
            (result) => assertExactProtocolValue(result, { data: [], nextCursor: null }, "app list"),
            () => sendRequest(6, "thread/start", codexAppServerThreadStartParams(codexHome), "thread_sent"));
          return;
        }
        if (frame.id === 6) {
          completeResponse(6, "thread_sent", "thread/start", frame.result,
            (result) => {
              activeThreadId = validateCodexAppServerThreadStart(result, codexHome);
              if (threadStartedNotificationId !== undefined && threadStartedNotificationId !== activeThreadId) {
                throw buildError("Codex app-server thread/start notification did not bind the response thread.");
              }
            },
            () => {
              if (threadStartedNotificationId === activeThreadId) {
                scheduleThreadDelete();
              } else {
                handshakeState = "thread_waiting_notification";
              }
            });
          return;
        }
        if (frame.id === 7) {
          completeResponse(7, "delete_sent", "thread/delete", frame.result,
            (result) => assertExactProtocolValue(result, {}, "thread deletion"),
            () => sendRequest(8, "account/read", { refreshToken: false }, "account_sent"));
          return;
        }
        if (frame.id === 8) {
          completeResponse(8, "account_sent", "account/read", frame.result,
            (result) => assertExactProtocolValue(result, {
              account: null,
              requiresOpenaiAuth: true,
            }, "signed-out account state"),
            () => {
              handshakeState = "complete";
              beginGracefulShutdown();
            });
          return;
        }
        fail(buildError("Codex app-server smoke received an unknown response or server request id."));
        return;
      }
      if (!hasExactObjectKeys(frame, ["method", "params", "emittedAtMs"]) ||
        !Number.isSafeInteger(frame.emittedAtMs) || frame.emittedAtMs <= 0) {
        fail(buildError("Codex app-server smoke received an unexpected notification or frame."));
        return;
      }
      if (frame.method === "remoteControl/status/changed") {
        if (
          !isPlainObject(frame.params) ||
          !hasExactObjectKeys(frame.params, ["status", "serverName", "installationId", "environmentId"]) ||
          frame.params.status !== "disabled" ||
          frame.params.serverName !== "DEV" ||
          typeof frame.params.installationId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(frame.params.installationId) ||
          frame.params.environmentId !== null
        ) fail(buildError("Codex app-server smoke received an invalid remote-control notification."));
        return;
      }
      if (frame.method === "thread/started" && isPlainObject(frame.params) && hasExactObjectKeys(frame.params, ["thread"])) {
        if (threadStartedNotificationId !== undefined) {
          fail(buildError("Codex app-server smoke received a duplicate thread/started notification."));
          return;
        }
        try {
          threadStartedNotificationId = validateCodexAppServerThread(frame.params.thread, codexHome);
          if (activeThreadId !== undefined && threadStartedNotificationId !== activeThreadId) {
            throw buildError("Codex app-server thread/started notification did not bind the response thread.");
          }
          if (handshakeState === "thread_waiting_notification" && activeThreadId === threadStartedNotificationId) {
            scheduleThreadDelete();
          }
        } catch (error) {
          fail(error);
        }
        return;
      }
      if (
        frame.method === "thread/status/changed" &&
        isPlainObject(frame.params) &&
        hasExactObjectKeys(frame.params, ["threadId", "status"]) &&
        frame.params.threadId === activeThreadId &&
        jsonEqual(frame.params.status, { type: "notLoaded" }) &&
        !threadNotLoaded
      ) {
        threadNotLoaded = true;
        return;
      }
      if (
        frame.method === "thread/deleted" &&
        isPlainObject(frame.params) &&
        hasExactObjectKeys(frame.params, ["threadId"]) &&
        frame.params.threadId === activeThreadId &&
        threadNotLoaded &&
        !threadDeletedNotification
      ) {
        threadDeletedNotification = true;
        return;
      }
      fail(buildError("Codex app-server smoke received an unexpected notification or frame."));
    };
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumOutputBytes) {
        fail(buildError("Codex app-server smoke output exceeded its bound."));
        return;
      }
      stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.from(chunk)]);
      while (true) {
        const newline = stdoutBuffer.indexOf(0x0a);
        if (newline < 0) break;
        const lineBytes = stdoutBuffer.subarray(0, newline);
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        const line = lineBytes.toString("utf8").replace(/\r$/, "");
        if (line) consumeFrame(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumOutputBytes) {
        fail(buildError("Codex app-server smoke output exceeded its bound."));
        return;
      }
      stderr += Buffer.from(chunk).toString("utf8");
    });
    child.stdin.on("error", (error) => fail(buildError("Codex app-server smoke stdin failed.", error)));
    child.once("error", (error) => fail(buildError("Codex app-server smoke process could not start.", error)));
    child.once("close", (code, signal) => {
      if (terminalError) {
        settle(terminalError);
        return;
      }
      if (
        code !== 0 ||
        signal !== null ||
        stdoutBuffer.byteLength !== 0 ||
        completedResponses.size !== 9 ||
        activeThreadId === undefined ||
        threadStartedNotificationId !== activeThreadId ||
        !threadNotLoaded ||
        !threadDeletedNotification
      ) {
        settle(buildError(`Codex app-server smoke exited incompletely (${code ?? signal ?? "unknown"}): ${stderr.trim().slice(-1_024)}`));
        return;
      }
      if (handshakeState !== "complete") {
        settle(buildError("Codex app-server signed-out smoke returned an incompatible identity or account state."));
        return;
      }
      settle(undefined, Object.freeze({
        protocol: "jsonl-stdio",
        initialize: true,
        initializeIdentity: true,
        configRead: true,
        denyVectorEffective: true,
        windowsSandboxUnelevatedPrivateDesktop: true,
        mcpServersEmpty: true,
        hooksEmpty: true,
        pluginsEmpty: true,
        appsEmpty: true,
        threadStartReadOnly: true,
        threadNetworkAccessDisabled: true,
        threadDeleted: true,
        accountReadSignedOut: true,
        requiresOpenaiAuth: true,
        forbiddenConfigAbsent: true,
        authJsonAbsent: true,
      }));
    });
    child.once("spawn", () => {
      handshakeState = "initialize_sent";
      send({
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: CODEX_APP_SERVER_INITIALIZE_IDENTITY.clientInfoName,
            title: CODEX_APP_SERVER_INITIALIZE_IDENTITY.clientInfoTitle,
            version: "0.1.0",
          },
          capabilities: { ...CODEX_APP_SERVER_INITIALIZE_IDENTITY.capabilities },
        },
      });
    });
  });
}

function validateCodexAppServerConfigRead(result, codexHome) {
  if (!isPlainObject(result) || !hasExactObjectKeys(result, ["config", "origins", "layers"])) {
    throw buildError("Codex app-server config/read returned an incompatible result shape.");
  }
  if (!isPlainObject(result.config) || !isPlainObject(result.origins) || !Array.isArray(result.layers)) {
    throw buildError("Codex app-server config/read returned invalid config provenance.");
  }
  if (result.layers.length !== 3) {
    throw buildError("Codex app-server config/read returned an unexpected configuration layer.");
  }
  const [sessionLayer, userLayer, systemLayer] = result.layers;
  if (
    !isPlainObject(sessionLayer) ||
    !hasExactObjectKeys(sessionLayer, ["name", "version", "config"]) ||
    !jsonEqual(sessionLayer.name, { type: "sessionFlags" }) ||
    typeof sessionLayer.version !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(sessionLayer.version) ||
    !jsonEqual(sessionLayer.config, CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG)
  ) {
    throw buildError("Codex app-server config/read did not preserve the exact fixed session flags.");
  }
  if (
    !isPlainObject(userLayer) ||
    !hasExactObjectKeys(userLayer, ["name", "version", "config"]) ||
    !jsonEqual(userLayer.name, { type: "user", file: join(codexHome, "config.toml"), profile: null }) ||
    !/^sha256:[0-9a-f]{64}$/.test(userLayer.version) ||
    !jsonEqual(userLayer.config, {})
  ) {
    throw buildError("Codex app-server private user configuration layer was not empty.");
  }
  if (
    !isPlainObject(systemLayer) ||
    !hasExactObjectKeys(systemLayer, ["name", "version", "config"]) ||
    !isPlainObject(systemLayer.name) ||
    !hasExactObjectKeys(systemLayer.name, ["type", "file"]) ||
    systemLayer.name.type !== "system" ||
    typeof systemLayer.name.file !== "string" ||
    !win32.isAbsolute(systemLayer.name.file) ||
    /[\0\r\n]/.test(systemLayer.name.file) ||
    !/^sha256:[0-9a-f]{64}$/.test(systemLayer.version) ||
    !jsonEqual(systemLayer.config, {})
  ) {
    throw buildError("Codex app-server system configuration layer was not empty.");
  }
  const expectedOriginPaths = flattenConfigLeafPaths(CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG)
    .map((path) => path === "features.multi_agent_v2" ? "features.multi_agent_v2.enabled" : path)
    .sort();
  if (!jsonEqual(Object.keys(result.origins).sort(), expectedOriginPaths)) {
    throw buildError("Codex app-server config/read origin set drifted from the fixed session flags.");
  }
  for (const origin of Object.values(result.origins)) {
    if (
      !isPlainObject(origin) ||
      !hasExactObjectKeys(origin, ["name", "version"]) ||
      !jsonEqual(origin.name, { type: "sessionFlags" }) ||
      origin.version !== sessionLayer.version
    ) {
      throw buildError("Codex app-server config/read origin was not the fixed session-flag layer.");
    }
  }
  for (const path of flattenConfigLeafPaths(CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG)) {
    const expected = readConfigPath(CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG, path);
    const actual = readConfigPath(result.config, path);
    if (!jsonEqual(actual, expected)) {
      throw buildError(`Codex app-server effective configuration drifted at ${path}.`);
    }
  }
  for (const [path, expected] of [
    ["mcp_servers", {}],
    ["plugins", {}],
    ["marketplaces", {}],
    ["hooks", null],
    ["apps", null],
    ["tools", null],
    ["agents", null],
    ["features.network_proxy", null],
    ["features.remote_control", false],
  ]) {
    if (!jsonEqual(readConfigPath(result.config, path), expected)) {
      throw buildError(`Codex app-server effective executable surface was not empty at ${path}.`);
    }
  }
}

function codexAppServerThreadStartParams(cwd) {
  return {
    modelProvider: CODEX_APP_SERVER_THREAD_START_POLICY.modelProvider,
    cwd,
    runtimeWorkspaceRoots: [cwd],
    approvalPolicy: CODEX_APP_SERVER_THREAD_START_POLICY.approvalPolicy,
    approvalsReviewer: CODEX_APP_SERVER_THREAD_START_POLICY.approvalsReviewer,
    sandbox: CODEX_APP_SERVER_THREAD_START_POLICY.sandbox,
    config: { ...CODEX_APP_SERVER_THREAD_CONFIG },
    ephemeral: CODEX_APP_SERVER_THREAD_START_POLICY.ephemeral,
    environments: [],
    dynamicTools: [],
    selectedCapabilityRoots: [],
    experimentalRawEvents: CODEX_APP_SERVER_THREAD_START_POLICY.experimentalRawEvents,
  };
}

function validateCodexAppServerThreadStart(result, codexHome) {
  if (!isPlainObject(result) || !hasExactObjectKeys(result, [
    "thread",
    "model",
    "modelProvider",
    "serviceTier",
    "cwd",
    "runtimeWorkspaceRoots",
    "instructionSources",
    "approvalPolicy",
    "approvalsReviewer",
    "sandbox",
    "activePermissionProfile",
    "reasoningEffort",
    "multiAgentMode",
  ])) {
    throw buildError("Codex app-server thread/start returned an incompatible result shape.");
  }
  const expected = CODEX_APP_SERVER_THREAD_START_POLICY.expectedSecurityResponse;
  if (
    result.model !== expected.model ||
    result.modelProvider !== expected.modelProvider ||
    result.serviceTier !== null ||
    result.cwd !== codexHome ||
    !jsonEqual(result.runtimeWorkspaceRoots, expected.runtimeWorkspaceRoots) ||
    !jsonEqual(result.instructionSources, expected.instructionSources) ||
    result.approvalPolicy !== expected.approvalPolicy ||
    result.approvalsReviewer !== expected.approvalsReviewer ||
    !jsonEqual(result.sandbox, expected.sandbox) ||
    result.activePermissionProfile !== expected.activePermissionProfile ||
    result.reasoningEffort !== null ||
    result.multiAgentMode !== expected.multiAgentMode
  ) {
    throw buildError("Codex app-server thread/start did not preserve the reviewed read-only security policy.");
  }
  return validateCodexAppServerThread(result.thread, codexHome);
}

function validateCodexAppServerThread(thread, codexHome) {
  if (!isPlainObject(thread) || !hasExactObjectKeys(thread, [
    "id",
    "extra",
    "sessionId",
    "forkedFromId",
    "parentThreadId",
    "preview",
    "ephemeral",
    "section",
    "sectionEnteredAt",
    "historyMode",
    "modelProvider",
    "createdAt",
    "updatedAt",
    "recencyAt",
    "status",
    "path",
    "cwd",
    "cliVersion",
    "source",
    "canAcceptDirectInput",
    "threadSource",
    "agentNickname",
    "agentRole",
    "gitInfo",
    "name",
    "turns",
  ])) {
    throw buildError("Codex app-server thread/start returned an incompatible thread shape.");
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const pathRelation = typeof thread.path === "string"
    ? relative(codexHome, resolve(thread.path)).replaceAll("\\", "/")
    : "";
  if (
    typeof thread.id !== "string" || !uuid.test(thread.id) ||
    typeof thread.sessionId !== "string" || !uuid.test(thread.sessionId) ||
    thread.extra !== null ||
    thread.forkedFromId !== null ||
    thread.parentThreadId !== null ||
    thread.preview !== "" ||
    thread.ephemeral !== false ||
    thread.section !== null ||
    thread.sectionEnteredAt !== null ||
    thread.historyMode !== "legacy" ||
    thread.modelProvider !== "openai" ||
    !Number.isSafeInteger(thread.createdAt) || thread.createdAt <= 0 ||
    !Number.isSafeInteger(thread.updatedAt) || thread.updatedAt <= 0 ||
    !Number.isSafeInteger(thread.recencyAt) || thread.recencyAt <= 0 ||
    !jsonEqual(thread.status, { type: "idle" }) ||
    !/^sessions\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/rollout-[^/]+-[0-9a-f-]{36}\.jsonl$/.test(pathRelation) ||
    thread.cwd !== codexHome ||
    thread.cliVersion !== "0.147.0" ||
    thread.source !== "vscode" ||
    thread.canAcceptDirectInput !== true ||
    thread.threadSource !== null ||
    thread.agentNickname !== null ||
    thread.agentRole !== null ||
    thread.gitInfo !== null ||
    thread.name !== null ||
    !jsonEqual(thread.turns, [])
  ) {
    throw buildError("Codex app-server thread/start returned an incompatible no-turn thread.");
  }
  return thread.id;
}

function flattenConfigLeafPaths(value, prefix = "", result = []) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) flattenConfigLeafPaths(child, path, result);
    else result.push(path);
  }
  return result;
}

function readConfigPath(value, path) {
  return path.split(".").reduce((current, key) => isPlainObject(current) ? current[key] : undefined, value);
}

function assertExactProtocolValue(actual, expected, label) {
  if (!jsonEqual(actual, expected)) throw buildError(`Codex app-server ${label} response was not the reviewed empty result.`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactObjectKeys(value, expected) {
  return jsonEqual(Object.keys(value).sort(), [...expected].sort());
}

async function assertCodexHomePolicy(root, options = {}) {
  const maximumEntries = 50_000;
  const maximumDepth = 32;
  const forbiddenBasenames = new Set(
    CODEX_APP_SERVER_CODEX_HOME_POLICY.forbiddenBasenames.map((value) => value.toLowerCase()),
  );
  const forbiddenTopLevelDirectories = new Set(
    CODEX_APP_SERVER_CODEX_HOME_POLICY.forbiddenTopLevelDirectories.map((value) => value.toLowerCase()),
  );
  const forbiddenExecutableExtensions = new Set(
    CODEX_APP_SERVER_CODEX_HOME_POLICY.forbiddenExecutableExtensions.map((value) => value.toLowerCase()),
  );
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw buildError("Codex app-server private home must be one plain directory.");
  }
  if (options.requireEmpty === true && (await readdir(root)).length !== 0) {
    throw buildError("Codex app-server private home must be empty before launch.");
  }
  let visited = 0;
  async function visit(directory, depth, prefix) {
    if (depth > maximumDepth) throw buildError("Codex app-server smoke home exceeded its directory-depth bound.");
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > maximumEntries) throw buildError("Codex app-server smoke home exceeded its entry-count bound.");
      const entryPath = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const normalizedName = entry.name.toLowerCase();
      const topLevel = relativePath.split("/", 1)[0].toLowerCase();
      const isGeneratedSystemSkill = relativePath === "skills" ||
        relativePath === CODEX_APP_SERVER_CODEX_HOME_POLICY.allowedGeneratedSystemSkillsRoot ||
        relativePath.startsWith(`${CODEX_APP_SERVER_CODEX_HOME_POLICY.allowedGeneratedSystemSkillsRoot}/`);
      const details = await lstat(entryPath);
      if (/[^\S ]|[\0\r\n]/.test(entry.name) || entry.name.normalize("NFC") !== entry.name) {
        throw buildError("Codex app-server smoke home contains an unsafe entry name.");
      }
      if (entry.isSymbolicLink() || details.isSymbolicLink()) {
        throw buildError("Codex app-server smoke home contains a reparse link.");
      }
      if (forbiddenBasenames.has(normalizedName)) {
        throw buildError(`Codex app-server smoke home contains forbidden ${entry.name}.`);
      }
      if (depth === 0 && details.isDirectory() && forbiddenTopLevelDirectories.has(topLevel)) {
        throw buildError(`Codex app-server smoke home contains forbidden executable config directory ${entry.name}.`);
      }
      if (topLevel === "skills" && !isGeneratedSystemSkill) {
        throw buildError("Codex app-server smoke home contains a non-system skill.");
      }
      if (
        details.isFile() &&
        !isGeneratedSystemSkill &&
        forbiddenExecutableExtensions.has(extname(entry.name).toLowerCase())
      ) {
        throw buildError("Codex app-server smoke home contains an executable user-config file.");
      }
      if (details.isDirectory()) {
        await visit(entryPath, depth + 1, relativePath);
      } else if (!details.isFile()) {
        throw buildError("Codex app-server smoke home contains a non-regular entry.");
      }
    }
  }
  await visit(root, 0, "");
}

async function collectRuntimeFiles(root, options = {}) {
  const entries = [];
  async function visit(directory, prefix) {
    const children = await readdir(directory, { withFileTypes: true });
    if (prefix && children.length === 0 && options.rejectEmptyDirectories === true) {
      throw buildError(`Runtime contains an unexpected empty directory: ${prefix}.`);
    }
    children.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const child of children) {
      if (/[\0\r\n]/.test(child.name) || child.name.normalize("NFC") !== child.name) {
        throw buildError(`Runtime contains an unsafe file name: ${child.name}.`);
      }
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      const absolutePath = join(directory, child.name);
      if (child.isSymbolicLink()) throw buildError(`Runtime contains a symbolic link: ${relativePath}.`);
      if (child.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (child.isFile()) {
        if (RUNTIME_METADATA_FILES.has(relativePath)) continue;
        const details = await stat(absolutePath);
        entries.push({ path: relativePath, size: details.size, sha256: await sha256File(absolutePath) });
      } else {
        throw buildError(`Runtime contains a non-regular entry: ${relativePath}.`);
      }
    }
  }
  await visit(root, "");
  return entries;
}

function validateSmokeHello(hello, expected) {
  const daemon = expected.policy.daemon;
  const capabilities = new Set(hello?.serverCapabilities);
  const pathEqual = (left, right) => process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
  if (
    hello?.type !== "daemon_hello" ||
    hello.socketPath !== expected.socketPath ||
    hello.protocol?.name !== daemon.protocolName ||
    hello.protocol?.version !== daemon.protocolVersion ||
    hello.schemaRevision !== daemon.schemaRevision ||
    hello.schemaId !== daemon.schemaId ||
    hello.appVersion !== expected.policy.releaseVersion ||
    hello.runtime?.buildId !== expected.policy.runtimeBuildId ||
    !pathEqual(hello.runtime?.executablePath, expected.runtimeExecutable) ||
    !pathEqual(hello.runtime?.entrypointPath, expected.cliEntrypoint) ||
    !daemon.requiredCapabilities.every((capability) => capabilities.has(capability))
  ) {
    throw buildError("Prime Agent daemon smoke returned an incompatible or unverified hello.");
  }
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode !== 0) throw buildError(`Prime Agent daemon exited unsuccessfully (${child.exitCode ?? child.signalCode}).`);
    return;
  }
  await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(buildError("Prime Agent daemon did not exit after smoke shutdown.")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectExit(buildError(`Prime Agent daemon exited unsuccessfully (${code ?? signal ?? "unknown"}).`));
      } else {
        resolveExit();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(buildError(`Prime Agent daemon smoke process failed: ${error.message}.`, error));
    });
  });
}

async function requireContainedRealFile(root, relativePath, label) {
  assertSafeRelativePath(relativePath, label);
  const canonicalRoot = await realpath(root).catch((error) => {
    throw buildError(`Verified runtime root is unavailable: ${root}.`, error);
  });
  const candidate = await requireAbsoluteRealFile(join(canonicalRoot, ...relativePath.split("/")), label);
  const escaped = relative(canonicalRoot, candidate);
  if (escaped.startsWith(`..${sep}`) || escaped === ".." || isAbsolute(escaped)) {
    throw buildError(`${label} escapes the verified runtime root.`);
  }
  return candidate;
}

async function requireAbsoluteRealFile(path, label) {
  if (!isAbsolute(path)) throw buildError(`${label} must be absolute.`);
  const canonical = await realpath(path).catch((error) => {
    throw buildError(`${label} is unavailable: ${path}.`, error);
  });
  const details = await stat(canonical);
  if (!details.isFile()) throw buildError(`${label} is not a regular file.`);
  return canonical;
}

function assertSafeRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    value.includes("\\") ||
    /[\0\r\n]/.test(value) ||
    isAbsolute(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw buildError(`${label} is not a safe relative path.`);
  }
}

function isSinglePathSegment(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !isAbsolute(value)
  );
}

function parseAllowedHttpsUrl(value, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw buildError(`Runtime source is not a valid URL: ${value}.`, error);
  }
  if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname) || parsed.username || parsed.password) {
    throw buildError(`Runtime source is not allowlisted: ${value}.`);
  }
  return parsed;
}

async function fileMatches(path, expected) {
  try {
    const details = await stat(path);
    return details.isFile() && details.size === expected.size && (await sha256File(path)) === expected.sha256;
  } catch {
    return false;
  }
}

async function readJson(path) {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw buildError(`Invalid JSON: ${path}.`, error);
  }
}

export async function sha256File(path) {
  const contents = await readFile(path);
  return createHash("sha256").update(contents).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function runtimeLibcIdentity() {
  if (process.platform !== "linux") return "none";
  const report = process.report?.getReport?.();
  if (report?.header?.glibcVersionRuntime) return `glibc-${report.header.glibcVersionRuntime}`;
  return "linux-unknown-libc";
}

function targetLibcFamily() {
  if (process.platform === "win32") return "msvc";
  if (process.platform === "darwin") return "libc";
  if (process.platform !== "linux") return "unknown";
  return existsSync("/etc/alpine-release") ? "musl" : "glibc";
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw buildError(`${label} must be an object.`);
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildError(message, cause) {
  return new PrimeAgentRuntimeBuildError(message, cause === undefined ? undefined : { cause });
}
