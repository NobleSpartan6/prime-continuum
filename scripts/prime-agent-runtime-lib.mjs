import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
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
import { constants as fsConstants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const RUNTIME_METADATA_FILES = new Set(["files.sha256", "runtime.json"]);
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const DOWNLOAD_REDIRECT_LIMIT = 5;
const DOWNLOAD_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_NO_PROGRESS_TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_FETCH_ATTEMPTS = 3;
const DOWNLOAD_RETRY_BASE_DELAY_MS = 250;
const BROWSER_SMOKE_ACTION_TIMEOUT_MS = 15_000;
const REVIEWED_RUNTIME_EXCLUDED_BASENAMES = [".gitkeep"];
const REVIEWED_RUNTIME_EXCLUDED_SUFFIXES = [".d.ts", ".d.mts", ".d.cts", ".map"];
const REVIEWED_RUNTIME_PRUNED_DIRECTORIES = Object.freeze([
  Object.freeze({ relativePath: "node_modules/@mistralai/mistralai/src", package: "@mistralai/mistralai", version: "2.6.1", packageJsonSha256: "b6fad3f7b92ba6e659b3964dfc90a6a7607866f62dd1d93273c7eed39d165587", fileCount: 1173, totalBytes: 3225460, treeSha256: "0c91eac7b18ed1988ecde01d2fb184abd2e4bf9950b22e248f89fe826af19570" }),
  Object.freeze({ relativePath: "node_modules/@mistralai/mistralai/examples", package: "@mistralai/mistralai", version: "2.6.1", packageJsonSha256: "b6fad3f7b92ba6e659b3964dfc90a6a7607866f62dd1d93273c7eed39d165587", fileCount: 33, totalBytes: 53098, treeSha256: "da24af65ab0423b3ef4657dc4338a620733fb93a8ce34f8f3881b5f97b14253a" }),
  Object.freeze({ relativePath: "node_modules/openai/src", package: "openai", version: "6.47.0", packageJsonSha256: "58936a8b912670945aff7e72a2c5cf435a36448215c7a3ed06569816198be88b", fileCount: 305, totalBytes: 2701229, treeSha256: "d113ee08904222ce6566aa83dab146f9a32a23ff29eb0c80eeb98bb6f1691253" }),
  Object.freeze({ relativePath: "node_modules/zod/src", package: "zod", version: "4.4.3", packageJsonSha256: "c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e", fileCount: 286, totalBytes: 2237613, treeSha256: "69c0cc8db91a7c1072e20f4843863510c86a57975f86f46f2f927aa756111965" }),
  Object.freeze({ relativePath: "node_modules/@anthropic-ai/sdk/src", package: "@anthropic-ai/sdk", version: "0.91.1", packageJsonSha256: "28aaef57dd52864476e417dac7b0b389ca65b9e4f3ee42631e450a9c1a654f82", fileCount: 108, totalBytes: 849702, treeSha256: "196379af890a46c70704840e2eda7dbb9a4d341e45fe9892dbd7034eb9bfec35" }),
  Object.freeze({ relativePath: "node_modules/prime-agent/examples", package: "prime-agent", version: "0.7.2", packageJsonSha256: "0b45bc86527fcdb73dae76d319f6f50f6d40827a63614303664a57e8fe41c8cf", fileCount: 120, totalBytes: 920809, treeSha256: "ef04b9d444749c2e67f85caf5d3b5543c477756046adbdc611d7c4deea1c1849" }),
  Object.freeze({ relativePath: "node_modules/cmake-ts/src", package: "cmake-ts", version: "1.0.2", packageJsonSha256: "a351b1724f7c219bbe3abaf6e8557558565953464b760e4dbe0694d2165d0db6", fileCount: 26, totalBytes: 71551, treeSha256: "f1de2a37e85c5dbade19d727f177c9ec3e3d42c50952862dba98d12fd7b535a3" }),
  Object.freeze({ relativePath: "node_modules/zeromq/src", package: "zeromq", version: "6.5.0", packageJsonSha256: "9fa3e9fd40a74cdace0c4fbed3821ab5fff68e91340f16b39e567edbcbab435e", fileCount: 47, totalBytes: 229916, treeSha256: "b78dc3f71311e1bddefad17fe0db0694abadee66641a53ac5e62a1f3b9b684e2" }),
  Object.freeze({ relativePath: "node_modules/data-uri-to-buffer/src", package: "data-uri-to-buffer", version: "4.0.1", packageJsonSha256: "ad4f90a737ab5d8af4dad265e9218456e3779ca5beb70df38dd5feecf80121dd", fileCount: 1, totalBytes: 1785, treeSha256: "dbb9f6843ac7532c491c3b7d53bdf3f356c2432a4e5f2c2310509e155623a199" }),
  Object.freeze({ relativePath: "node_modules/@mistralai/mistralai/packages", package: "@mistralai/mistralai", version: "2.6.1", packageJsonSha256: "b6fad3f7b92ba6e659b3964dfc90a6a7607866f62dd1d93273c7eed39d165587", fileCount: 224, totalBytes: 523201, treeSha256: "db88bccded8005daaf593e5b3155ef2c4a2ee18f9c7d8ccda7a86bceaac25bde" }),
  Object.freeze({ relativePath: "node_modules/@mistralai/mistralai/tests", package: "@mistralai/mistralai", version: "2.6.1", packageJsonSha256: "b6fad3f7b92ba6e659b3964dfc90a6a7607866f62dd1d93273c7eed39d165587", fileCount: 16, totalBytes: 105898, treeSha256: "6d78be7e61f91e0d7d129852fde93968d87398f0fe7d63a2024bd7689801a238" }),
  Object.freeze({ relativePath: "node_modules/highlight.js/scss", package: "highlight.js", version: "10.7.3", packageJsonSha256: "4f657beb931cb9613e5173414855b2a01e698696c0661d21973bfbbd50e184cf", fileCount: 100, totalBytes: 134675, treeSha256: "d7dd896e7977d12dcb4c504b94ec5293fc5fc5c50ce903533039967086ea7700" }),
  Object.freeze({ relativePath: "node_modules/highlight.js/styles", package: "highlight.js", version: "10.7.3", packageJsonSha256: "4f657beb931cb9613e5173414855b2a01e698696c0661d21973bfbbd50e184cf", fileCount: 100, totalBytes: 134675, treeSha256: "88ccb109d9fbd658b000acfdd7372215d909d7f7519b650b3406585832e2ff20" }),
]);
const REVIEWED_RUNTIME_PROVIDER_CHUNKS = Object.freeze([
  "anthropic-6NOSCFKS.js",
  "azure-openai-responses-FMGB2C5I.js",
  "google-ESBRCJKR.js",
  "google-vertex-HHNXIE5P.js",
  "mistral-F4QFN323.js",
  "openai-codex-responses-MURTF24R.js",
  "openai-completions-7BADVXTD.js",
  "openai-responses-2NOQQGMV.js",
]);
const REVIEWED_RUNTIME_PRUNED_PACKAGE_ENTRYPOINTS = Object.freeze([
  "openai",
  "zod",
  "@anthropic-ai/sdk",
  "@mistralai/mistralai",
  "data-uri-to-buffer",
  "cmake-ts",
  "zeromq",
  "highlight.js",
]);
const PINNED_BROWSER_BRIDGE = Object.freeze({
  protocol: "prime-continuim.browser.v1",
  playwrightCoreVersion: "1.63.0-alpha-2026-08-05",
  engine: "verified-electron-host",
});
const BROWSER_BRIDGE_FILES = Object.freeze([
  Object.freeze({ relativePath: "browser-bridge.mjs", mode: 0o644 }),
  Object.freeze({ relativePath: "browser-bridge-launch-journal.cjs", mode: 0o644 }),
  Object.freeze({ relativePath: "browser-doctor-host.cjs", mode: 0o644 }),
  Object.freeze({ relativePath: "browser-host.cjs", mode: 0o644 }),
  Object.freeze({ relativePath: "electron-node-shim.cjs", mode: 0o644 }),
  Object.freeze({ relativePath: "browser-bridge-arguments.mjs", mode: 0o644 }),
  Object.freeze({ relativePath: "browser-bridge-environment.mjs", mode: 0o644 }),
  Object.freeze({ relativePath: "browser-bridge-session-lock.mjs", mode: 0o644 }),
  Object.freeze({ relativePath: "browser-bridge-state.mjs", mode: 0o644 }),
  Object.freeze({ relativePath: "playwright-cli", mode: 0o755 }),
  Object.freeze({ relativePath: "playwright-cli.cmd", mode: 0o644 }),
  Object.freeze({ relativePath: "skills/playwright-cli/SKILL.md", mode: 0o644 }),
]);

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RUNTIME_TEMPLATE_DIRECTORY = join(REPO_ROOT, "runtime", "prime-agent");
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
  if (
    Object.prototype.hasOwnProperty.call(sources, "codexAppServer") ||
    Object.prototype.hasOwnProperty.call(policy, "codexAppServer")
  ) {
    throw buildError("Prime Agent runtime inputs must not declare a companion backend.");
  }
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
  const playwrightCore = lockfile.packages["node_modules/playwright-core"];
  for (const [name, entry] of Object.entries({
    "playwright-core": playwrightCore,
    "prime-agent": prime,
    zeromq,
  })) {
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
    JSON.stringify(policy.packaging.excludedBasenames) !== JSON.stringify(REVIEWED_RUNTIME_EXCLUDED_BASENAMES) ||
    !Array.isArray(policy.packaging?.excludedSuffixes) ||
    JSON.stringify(policy.packaging.excludedSuffixes) !== JSON.stringify(REVIEWED_RUNTIME_EXCLUDED_SUFFIXES) ||
    !Array.isArray(policy.packaging?.reviewedPrunedDirectories) ||
    JSON.stringify(policy.packaging.reviewedPrunedDirectories) !== JSON.stringify(REVIEWED_RUNTIME_PRUNED_DIRECTORIES)
  ) {
    throw buildError("Runtime packaging exclusions changed without review.");
  }
  for (const entrypoint of Object.values(policy.entrypoints ?? {})) {
    assertSafeRelativePath(entrypoint, "runtime entrypoint");
  }
  if (
    packageJson.dependencies?.["playwright-core"] !== PINNED_BROWSER_BRIDGE.playwrightCoreVersion ||
    !jsonEqual(policy.browserBridge, PINNED_BROWSER_BRIDGE) ||
    policy.entrypoints?.browserBridge !== "bridge/browser-bridge.mjs" ||
    policy.entrypoints?.browserHost !== "bridge/browser-host.cjs" ||
    policy.entrypoints?.browserLauncher !== "bridge/playwright-cli" ||
    policy.entrypoints?.browserLauncherWindows !== "bridge/playwright-cli.cmd" ||
    policy.entrypoints?.browserSkill !== "bridge/skills/playwright-cli/SKILL.md"
  ) {
    throw buildError("Verified browser bridge policy changed without review.");
  }
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
  return Object.freeze(verified);
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
    const response = await fetchReleaseAssetWithRetry(asset, allowedHosts, options, limits);
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

async function fetchReleaseAssetWithRetry(asset, allowedHosts, options, limits) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  for (let attempt = 1; attempt <= DOWNLOAD_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await awaitDownloadProgress(
        fetchAllowed(asset.url, allowedHosts, { fetchImpl, signal: limits.controller.signal }),
        limits,
        asset.fileName,
        true,
      );
    } catch (error) {
      if (attempt >= DOWNLOAD_FETCH_ATTEMPTS || !hasErrorCode(error, "UND_ERR_SOCKET")) throw error;
      await awaitDownloadProgress(
        Promise.resolve(sleep(DOWNLOAD_RETRY_BASE_DELAY_MS * attempt)),
        limits,
        asset.fileName,
        true,
      );
    }
  }
  throw buildError(`Could not download ${asset.fileName}.`);
}

function hasErrorCode(error, expected) {
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    if (current.code === expected) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
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
  const bridgeSource = join(inputs.templateDirectory, "bridge");
  const bridgeDestination = join(stagingDirectory, "bridge");
  await mkdir(join(bridgeDestination, "skills", "playwright-cli"), { recursive: true });
  await Promise.all(BROWSER_BRIDGE_FILES.map(async ({ relativePath, mode }) => {
    const source = join(bridgeSource, ...relativePath.split("/"));
    const destination = join(bridgeDestination, ...relativePath.split("/"));
    await copyFile(source, destination);
    await chmod(destination, mode);
  }));
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

export async function pruneRuntimePackagingNoise(runtimeDirectory, policy) {
  const excludedBasenames = new Set(policy?.packaging?.excludedBasenames);
  const excludedSuffixes = policy?.packaging?.excludedSuffixes;
  if (excludedBasenames.size < 1 || excludedBasenames.size !== policy.packaging.excludedBasenames.length) {
    throw buildError("Runtime packaging exclusions are invalid.");
  }
  if (
    !Array.isArray(excludedSuffixes) ||
    excludedSuffixes.length < 1 ||
    new Set(excludedSuffixes).size !== excludedSuffixes.length ||
    excludedSuffixes.some((suffix) => typeof suffix !== "string" || !/^\.[a-z.]{2,16}$/.test(suffix))
  ) {
    throw buildError("Runtime packaging exclusion suffixes are invalid.");
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
      } else if (
        entry.isFile() &&
        (excludedBasenames.has(entry.name) || excludedSuffixes.some((suffix) => entry.name.endsWith(suffix)))
      ) {
        await rm(absolutePath, { force: false });
        removed.push(relativePath);
      }
    }
  }
  await visit(runtimeDirectory, "");
  return Object.freeze(removed);
}

export async function pruneReviewedRuntimeDirectories(runtimeDirectory, policy) {
  const reviewed = policy?.packaging?.reviewedPrunedDirectories;
  if (!Array.isArray(reviewed) || reviewed.length < 1) {
    throw buildError("Runtime reviewed directory pruning policy is invalid.");
  }
  const root = resolve(runtimeDirectory);
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw buildError("Runtime reviewed directory pruning root must be a plain directory.");
  }

  const validated = [];
  for (const entry of reviewed) {
    const relativePath = entry?.relativePath;
    const packageName = entry?.package;
    assertSafeRelativePath(relativePath, "reviewed runtime prune path");
    if (
      typeof packageName !== "string" ||
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(packageName) ||
      !relativePath.startsWith(`node_modules/${packageName}/`) ||
      typeof entry.version !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.packageJsonSha256) ||
      !Number.isSafeInteger(entry.fileCount) || entry.fileCount < 1 ||
      !Number.isSafeInteger(entry.totalBytes) || entry.totalBytes < 1 ||
      !/^[a-f0-9]{64}$/.test(entry.treeSha256)
    ) {
      throw buildError(`Runtime reviewed directory policy is invalid for ${relativePath ?? "(unknown)"}.`);
    }

    const packageDirectory = join(root, "node_modules", ...packageName.split("/"));
    const packageDetails = await lstat(packageDirectory);
    const target = join(root, ...relativePath.split("/"));
    const targetDetails = await lstat(target);
    if (
      !packageDetails.isDirectory() || packageDetails.isSymbolicLink() ||
      !targetDetails.isDirectory() || targetDetails.isSymbolicLink()
    ) {
      throw buildError(`Reviewed runtime prune target is not a plain package directory: ${relativePath}.`);
    }
    const packageJsonPath = join(packageDirectory, "package.json");
    const packageJsonDetails = await lstat(packageJsonPath);
    if (!packageJsonDetails.isFile() || packageJsonDetails.isSymbolicLink()) {
      throw buildError(`Reviewed runtime package manifest is not a plain file: ${packageName}.`);
    }
    const packageJsonBytes = await readFile(packageJsonPath);
    let packageJson;
    try {
      packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
    } catch (error) {
      throw buildError(`Reviewed runtime package manifest is invalid: ${packageName}.`, { cause: error });
    }
    if (
      packageJson.name !== packageName ||
      packageJson.version !== entry.version ||
      createHash("sha256").update(packageJsonBytes).digest("hex") !== entry.packageJsonSha256
    ) {
      throw buildError(`Reviewed runtime package identity drifted: ${packageName}.`);
    }

    const files = await collectRuntimeFiles(target, {
      includeRuntimeMetadata: true,
      rejectEmptyDirectories: true,
    });
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const treeSource = files.map((file) => `${file.sha256} ${file.size} ${file.path}\n`).join("");
    if (
      files.length !== entry.fileCount ||
      totalBytes !== entry.totalBytes ||
      sha256Text(treeSource) !== entry.treeSha256
    ) {
      throw buildError(`Reviewed runtime prune target drifted: ${relativePath}.`);
    }
    validated.push({ relativePath, target });
  }

  for (const entry of validated) {
    await rm(entry.target, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
  }
  return Object.freeze(validated.map((entry) => entry.relativePath));
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
  const daemonSupervisor = await requireContainedRealFile(
    entrypoints.root,
    "node_modules/prime-agent/dist/modes/daemon/daemon-supervisor.js",
    "Prime Agent daemon supervisor",
  );
  const scratchDirectory = await mkdtemp(join(tmpdir(), "prime-continuim-runtime-smoke-"));
  const probePath = join(scratchDirectory, "runtime-probe.mjs");
  const retryWorkerProbePath = join(scratchDirectory, "runtime-retry-worker-probe.mjs");
  const daemonClientPath = join(scratchDirectory, "runtime-daemon-client.mjs");
  const probeSource = [
    'import { createRequire } from "node:module";',
    'import { readdir, readFile } from "node:fs/promises";',
    'import { fileURLToPath } from "node:url";',
    "const [moduleUrl, packageJsonPath] = process.argv.slice(2);",
    "const runtime = await import(moduleUrl);",
    'if (typeof runtime.DaemonClient !== "function" || typeof runtime.DaemonAgentConnection?.attach !== "function") throw new Error("missing daemon exports");',
    "const require = createRequire(packageJsonPath);",
    `for (const packageName of ${JSON.stringify(REVIEWED_RUNTIME_PRUNED_PACKAGE_ENTRYPOINTS)}) {`,
    "  const loaded = require(packageName);",
    '  if (!loaded || (typeof loaded !== "object" && typeof loaded !== "function")) throw new Error(`reviewed package entrypoint did not load: ${packageName}`);',
    "}",
    `for (const fileName of ${JSON.stringify(REVIEWED_RUNTIME_PROVIDER_CHUNKS)}) {`,
    '  const loaded = await import(new URL(`./bundle/${fileName}`, moduleUrl));',
    '  if (!loaded || Object.keys(loaded).length < 1) throw new Error(`provider chunk did not load: ${fileName}`);',
    "}",
    'const bundleDirectory = fileURLToPath(new URL("./bundle/", moduleUrl));',
    'const bundleFiles = new Set((await readdir(bundleDirectory)).filter((fileName) => fileName.endsWith(".js")));',
    'for (const fileName of bundleFiles) {',
    '  const source = await readFile(new URL(`./bundle/${fileName}`, moduleUrl), "utf8");',
    '  for (const match of source.matchAll(/(?:from\\s*|import\\s*\\()\\s*["\'](\\.\\/[^"\']+\\.js)["\']/g)) {',
    '    const dependency = match[1].slice(2);',
    '    if (!bundleFiles.has(dependency)) throw new Error(`missing local bundle import: ${fileName} -> ${dependency}`);',
    '  }',
    '}',
    'process.stdout.write(JSON.stringify({ node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch, bundleImportGraphComplete: true, ...(process.versions.electron ? { electron: process.versions.electron, runAsNode: process.env.ELECTRON_RUN_AS_NODE === "1" } : {}) }));',
  ].join("\n");
  const retryWorkerProbeSource = [
    'import { resolve } from "node:path";',
    "const [supervisorModuleUrl, agentDir] = process.argv.slice(2);",
    'if (!supervisorModuleUrl || !agentDir) throw new Error("missing retry_worker smoke arguments");',
    "const { DaemonSupervisor } = await import(supervisorModuleUrl);",
    'if (typeof DaemonSupervisor !== "function") throw new Error("missing DaemonSupervisor export");',
    'const supervisor = new DaemonSupervisor(resolve(agentDir, "retry-probe.sock"), { defaultSessionConfig: { agentDir } });',
    "const descriptor = { workerId: \"worker-1\", rootActiveSessionId: \"active-1\", rootSessionId: \"session-1\", lifecycle: \"stopped\", stopRequestedAt: \"2026-08-09T00:00:00.000Z\", archiveOnStop: true, consecutiveFailures: 4 };",
    "const worker = { descriptor, intentionalStop: true, summaries: new Map() };",
    "supervisor.workers.set(descriptor.workerId, worker);",
    "supervisor.assertWorkerAccessibleToClient = () => undefined;",
    "const events = [];",
    "supervisor.persistWorker = (candidate) => events.push({ kind: \"persist\", intentionalStop: candidate.intentionalStop, stopRequestedAt: candidate.descriptor.stopRequestedAt, archiveOnStop: candidate.descriptor.archiveOnStop, lifecycle: candidate.descriptor.lifecycle, consecutiveFailures: candidate.descriptor.consecutiveFailures });",
    "supervisor.recoverWorker = async (candidate) => { events.push({ kind: \"recover\", stopRequestedAt: candidate.descriptor.stopRequestedAt, archiveOnStop: candidate.descriptor.archiveOnStop, lifecycle: candidate.descriptor.lifecycle }); candidate.descriptor.lifecycle = \"ready\"; };",
    'const response = await supervisor.handleCommand({}, { id: "retry-1", type: "retry_worker", activeSessionId: "active-1" });',
    'const expected = JSON.stringify([{ kind: "persist", intentionalStop: false, lifecycle: "recovering", consecutiveFailures: 0 }, { kind: "recover", lifecycle: "recovering" }]);',
    'if (JSON.stringify(events) !== expected) throw new Error(`retry_worker ordering changed: ${JSON.stringify(events)}`);',
    'if (response?.type !== "response" || response.command !== "retry_worker" || response.success !== true) throw new Error("retry_worker response changed");',
    'const disconnectedWorker = { descriptor: { lifecycle: "ready" }, client: undefined, intentionalStop: false };',
    'if (supervisor.effectiveWorkerState(disconnectedWorker) !== "recovering") throw new Error("disconnected ready worker still reports ready");',
    'const stoppingWorker = { descriptor: { lifecycle: "ready", stopRequestedAt: "2026-08-11T00:00:00.000Z" }, client: undefined, intentionalStop: false };',
    'if (supervisor.effectiveWorkerState(stoppingWorker) !== "stopping") throw new Error("stopping worker state changed");',
    'const staleDescriptor = { workerId: "worker-stale", rootActiveSessionId: "active-stale", rootSessionId: "session-stale", lifecycle: "stopping", stopRequestedAt: "2026-08-11T00:00:00.000Z", pid: 424242, processStartId: "dead-generation" };',
    'const staleWorker = { descriptor: staleDescriptor, client: undefined, recovery: undefined, intentionalStop: true, summaries: new Map() };',
    'supervisor.workers.set(staleDescriptor.workerId, staleWorker);',
    'supervisor.processIdentity = () => "gone";',
    'supervisor.scheduleWorkerStopFinalization = (candidate) => { supervisor.workers.delete(candidate.descriptor.workerId); candidate.stopFinalization = Promise.resolve(); };',
    'if ((await supervisor.reclaimStaleWorkerRegistration(staleWorker)) !== true || supervisor.workers.has(staleDescriptor.workerId)) throw new Error("stale worker registration was not reclaimed");',
    'process.stdout.write(JSON.stringify({ retryWorkerOrdering: true, disconnectedWorkerState: true, staleWorkerReclaimed: true }));',
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
      writeFile(retryWorkerProbePath, retryWorkerProbeSource, { encoding: "utf8", mode: 0o600, flag: "wx" }),
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
    if (runtimeVersions.bundleImportGraphComplete !== true) {
      throw buildError("Prime Agent runtime bundle import graph was not proven complete.");
    }

    const retryWorkerProbe = await commandRunner(
      runtimeExecutable,
      [retryWorkerProbePath, pathToFileURL(daemonSupervisor).href, scratchDirectory],
      {
        cwd: runtimeDirectory,
        env: cleanRuntimeEnvironment(process.env, { electronRunAsNode }),
        timeoutMs: 30_000,
      },
    );
    let retryWorkerResult;
    try {
      retryWorkerResult = JSON.parse(retryWorkerProbe.stdout);
    } catch (error) {
      throw buildError("Prime Agent retry_worker smoke helper returned invalid JSON.", error);
    }
    if (
      retryWorkerResult?.retryWorkerOrdering !== true ||
      retryWorkerResult?.disconnectedWorkerState !== true ||
      retryWorkerResult?.staleWorkerReclaimed !== true
    ) {
      throw buildError("Prime Agent worker recovery smoke did not prove current self-healing semantics.");
    }

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

export async function smokeBrowserBridge(runtimeDirectory, options = {}) {
  const runtimeExecutable = await requireAbsoluteRealFile(
    options.runtimeExecutable,
    "browser smoke runtime executable",
  );
  const commandRunner = options.commandRunner ?? runCommand;
  if (typeof commandRunner !== "function") throw buildError("Browser smoke command runner is invalid.");
  const entrypoints = await resolveVerifiedEntrypoints(runtimeDirectory, options.policy);
  const scratchDirectory = await mkdtemp(join(tmpdir(), "prime-continuim-browser-smoke-"));
  const stateDirectory = join(scratchDirectory, "state");
  const screenshotPath = join(scratchDirectory, "browser-smoke.png");
  const session = `runtime-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await mkdir(stateDirectory, { mode: 0o700 });
  const environment = {
    ...cleanRuntimeEnvironment(process.env, { electronRunAsNode: true }),
    PLAYWRIGHT_MCP_TIMEOUT_ACTION: String(BROWSER_SMOKE_ACTION_TIMEOUT_MS),
    // This fixture uses only native controls and verifies PNG bytes, not font rendering.
    // Font readiness can remain pending on minimal Linux runners with no installed fonts.
    PW_TEST_SCREENSHOT_NO_FONTS_READY: "1",
    PRIME_CONTINUIM_BROWSER_EXECUTABLE: runtimeExecutable,
    PRIME_CONTINUIM_BROWSER_BRIDGE: entrypoints.browserBridge,
    PRIME_CONTINUIM_BROWSER_STATE_DIR: stateDirectory,
    PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: `smoke-${session}`,
  };
  const invoke = (args, timeoutMs = 25_000) => commandRunner(
    runtimeExecutable,
    [entrypoints.browserBridge, `--session=${session}`, ...args],
    { cwd: scratchDirectory, env: environment, timeoutMs },
  );
  let opened = false;
  try {
    const doctor = await commandRunner(runtimeExecutable, [entrypoints.browserBridge, "doctor", "--json"], {
      cwd: scratchDirectory,
      env: environment,
      timeoutMs: 25_000,
    });
    let doctorResult;
    try {
      doctorResult = JSON.parse(String(doctor.stdout));
    } catch (error) {
      throw buildError("Browser bridge doctor returned invalid JSON.", error);
    }
    if (
      JSON.stringify(Object.keys(doctorResult).sort()) !==
        JSON.stringify(["bridgeVersion", "controller", "engine", "protocol", "ready"].sort()) ||
      doctorResult.protocol !== PINNED_BROWSER_BRIDGE.protocol ||
      doctorResult.bridgeVersion !== 1 ||
      doctorResult.ready !== true ||
      doctorResult.controller !== `playwright-core/${PINNED_BROWSER_BRIDGE.playwrightCoreVersion}` ||
      doctorResult.engine !== PINNED_BROWSER_BRIDGE.engine
    ) throw buildError("Browser bridge doctor returned an unexpected identity.");

    const page = encodeURIComponent([
      "<!doctype html><title>Prime browser smoke</title>",
      '<button type="button" onclick="this.textContent=\'After\'">Before</button>',
      '<input aria-label="Name">',
    ].join(""));
    await invoke(["open", `data:text/html,${page}`]);
    opened = true;
    const snapshot = await invoke(["snapshot"]);
    const snapshotText = String(snapshot.stdout);
    const reference = /button\s+"Before"[^\n]*\[ref=(e\d+)\]/.exec(snapshotText)?.[1] ??
      /\[ref=(e\d+)\][^\n]*Before/.exec(snapshotText)?.[1];
    if (!reference) throw buildError("Browser smoke did not receive a stable snapshot reference.");
    const found = await invoke(["find", "Before"]);
    if (!String(found.stdout).includes("Before")) throw buildError("Browser smoke find did not observe page content.");
    await invoke(["click", reference]);
    const read = await invoke(["eval", "document.querySelector('button')?.textContent"]);
    if (!String(read.stdout).includes("After")) throw buildError("Browser smoke interaction was not observable.");
    await invoke(["screenshot", `--filename=${screenshotPath}`]);
    const screenshot = await readFile(screenshotPath);
    if (screenshot.byteLength < 8 || !screenshot.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      throw buildError("Browser smoke screenshot is not a PNG.");
    }
    await invoke(["close"]);
    opened = false;
    await assertBrowserSmokeStateRetired(stateDirectory);
    return Object.freeze({
      verified: true,
      protocol: PINNED_BROWSER_BRIDGE.protocol,
      controller: `playwright-core/${PINNED_BROWSER_BRIDGE.playwrightCoreVersion}`,
      engine: PINNED_BROWSER_BRIDGE.engine,
      operations: Object.freeze(["doctor", "open", "snapshot", "find", "click", "eval", "screenshot", "close"]),
    });
  } finally {
    if (opened) await invoke(["close"], 10_000).catch(() => undefined);
    await rm(scratchDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function assertBrowserSmokeStateRetired(stateDirectory) {
  const pending = [stateDirectory];
  let inspected = 0;
  while (pending.length) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      inspected += 1;
      if (inspected > 4_096) throw buildError("Browser smoke state exceeded its cleanup inspection bound.");
      if (
        entry.name === "browser.json" || entry.name === "launch.json" || entry.name === "profile" ||
        entry.name.startsWith("launch.owner-") || entry.name.includes(".candidate-")
      ) throw buildError(`Browser smoke retained private lifecycle state: ${entry.name}`);
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
    }
  }
}

export async function createRuntimeManifest({ runtimeDirectory, inputs, npmVersion, smoke }) {
  const entries = await collectRuntimeFiles(runtimeDirectory);
  if (entries.some((entry) => entry.path === "companions" || entry.path.startsWith("companions/"))) {
    throw buildError("Prime Agent runtime tree must not contain a companion backend.");
  }
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
    browserBridge: inputs.policy.browserBridge,
    daemon: inputs.policy.daemon,
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
    !jsonEqual(manifest.browserBridge, options.policy?.browserBridge) ||
    !jsonEqual(manifest.daemon, options.policy?.daemon) ||
    Object.prototype.hasOwnProperty.call(manifest, "codexAppServer")
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
    manifest.smokeRuntime.bundleImportGraphComplete !== true ||
    manifest.smokeRuntime.platform !== manifest.platform ||
    manifest.smokeRuntime.arch !== manifest.arch
  ) {
    throw buildError("Runtime manifest build or smoke identity is invalid.");
  }
  assertMinimumNodeVersion(manifest.buildRuntime.node, options.policy.minimumNodeVersion);
  assertMinimumNodeVersion(manifest.smokeRuntime.node, options.policy.minimumNodeVersion);
  const entries = await collectRuntimeFiles(root, { rejectEmptyDirectories: true });
  if (entries.some((entry) => entry.path === "companions" || entry.path.startsWith("companions/"))) {
    throw buildError("Prime Agent runtime tree contains an unsupported companion backend.");
  }
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
  await resolveVerifiedEntrypoints(root, options.policy);
  return Object.freeze({ root, manifest });
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
  const browserBridge = await requireContainedRealFile(root, policy.entrypoints.browserBridge, "browser bridge");
  const browserHost = await requireContainedRealFile(root, policy.entrypoints.browserHost, "browser host");
  const browserLauncher = await requireContainedRealFile(root, policy.entrypoints.browserLauncher, "browser launcher");
  const browserLauncherWindows = await requireContainedRealFile(
    root,
    policy.entrypoints.browserLauncherWindows,
    "Windows browser launcher",
  );
  const browserSkill = await requireContainedRealFile(root, policy.entrypoints.browserSkill, "browser skill");
  if (process.platform !== "win32") await access(browserLauncher, fsConstants.X_OK);
  const packageJson = await requireContainedRealFile(root, "node_modules/prime-agent/package.json", "Prime Agent package");
  const playwrightPackageJson = await requireContainedRealFile(
    root,
    "node_modules/playwright-core/package.json",
    "Playwright package",
  );
  const packageValue = await readJson(packageJson);
  const playwrightPackageValue = await readJson(playwrightPackageJson);
  if (packageValue.name !== "prime-agent" || packageValue.version !== policy.releaseVersion) {
    throw buildError("Installed Prime Agent package identity is invalid.");
  }
  if (
    playwrightPackageValue.name !== "playwright-core" ||
    playwrightPackageValue.version !== policy.browserBridge.playwrightCoreVersion
  ) {
    throw buildError("Installed Playwright controller identity is invalid.");
  }
  return Object.freeze({
    root,
    modulePath,
    moduleUrl: pathToFileURL(modulePath).href,
    cli,
    packageJson,
    browserBridge,
    browserHost,
    browserLauncher,
    browserLauncherWindows,
    browserSkill,
    playwrightPackageJson,
  });
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
        const diagnostic = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n").slice(-4_096);
        return rejectRun(buildError(`${basename(command)} failed (${code ?? signal ?? "unknown"}): ${diagnostic}`));
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
        if (options.includeRuntimeMetadata !== true && RUNTIME_METADATA_FILES.has(relativePath)) continue;
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
