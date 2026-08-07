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
}

export async function verifyReleaseAssets(inputs, cacheDirectory) {
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
    await downloadVerifiedAsset(asset, destination, allowedHosts);
    verified.push(destination);
  }
  return Object.freeze(verified);
}

async function downloadVerifiedAsset(asset, destination, allowedHosts) {
  const partial = `${destination}.partial-${randomUUID()}`;
  let handle;
  try {
    const response = await fetchAllowed(asset.url, allowedHosts);
    if (!response.ok || !response.body) {
      throw buildError(`Could not download ${asset.fileName}: HTTP ${response.status}.`);
    }
    handle = await open(partial, "wx", 0o600);
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > asset.size || bytes > MAX_ASSET_BYTES) {
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

async function fetchAllowed(url, allowedHosts) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= DOWNLOAD_REDIRECT_LIMIT; redirects += 1) {
    if (current.protocol !== "https:" || !allowedHosts.has(current.hostname)) {
      throw buildError(`Download redirected to a non-allowlisted host: ${current.hostname}.`);
    }
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "User-Agent": "Prime-Continuim-Runtime-Builder/0.1" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw buildError(`Download redirect from ${current.hostname} omitted Location.`);
    current = new URL(location, current);
  }
  throw buildError("Release asset exceeded the redirect limit.");
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

export async function createRuntimeManifest({ runtimeDirectory, inputs, npmVersion, smoke }) {
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
