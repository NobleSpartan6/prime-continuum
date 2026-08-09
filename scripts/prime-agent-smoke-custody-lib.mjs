import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const WINDOWS_LEAF_NAME = /^PrimeContinuim-PrimeAgent-[a-f0-9]{32}$/;
const MAX_TREE_ENTRIES = 10_000;
const MAX_TREE_DEPTH = 32;
const MAX_TREE_BYTES = 128 * 1024 * 1024;

/**
 * Binds a package smoke to the exact Prime Agent custody implementation
 * exported by the hostd bundle under test. This helper never creates the
 * custody leaf: production hostd must create and prove it through its atomic
 * security boundary before the smoke may capture or seed it.
 */
export async function createPrimeAgentSmokeCustody(options) {
  assertOptions(options);
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const canonicalHostDataRoot = await canonicalDirectory(options.hostDataRoot, platform);
  const programDataRoot = platform === "win32" ? requireProgramDataRoot(environment) : undefined;
  const agentDirectory = resolve(options.hostdModule.resolvePrimeAgentRuntimeDirectory(
    canonicalHostDataRoot,
    {
      platform,
      ...(programDataRoot ? { programDataRoot } : {}),
    },
  ));
  await assertExactResolvedLeaf({
    platform,
    canonicalHostDataRoot,
    programDataRoot,
    agentDirectory,
    hostdModule: options.hostdModule,
  });

  const security = new options.hostdModule.HostScopedPrimeAgentAuthSecurity({
    platform,
    ...(programDataRoot ? { programDataRoot } : {}),
  });
  let proof;
  let initialAbsenceConfirmed = false;

  const assertInitiallyAbsent = async () => {
      if (await pathExists(agentDirectory)) {
        throw new Error("Prime Agent package-smoke custody leaf already exists; refusing to reuse or remove it");
      }
      initialAbsenceConfirmed = true;
  };

  const captureExisting = async () => {
      if (!initialAbsenceConfirmed) {
        throw new Error("Prime Agent package-smoke custody absence was not established before host startup");
      }
      if (!(await pathExists(agentDirectory))) return undefined;
      const beforeIdentity = await plainDirectoryIdentity(agentDirectory);
      const observed = await security.prepareAndVerify(canonicalHostDataRoot, agentDirectory);
      assertExactProof(observed, {
        platform,
        canonicalHostDataRoot,
        agentDirectory,
        programDataRoot,
      });
      if (observed.agentDirectoryIdentity !== beforeIdentity) {
        throw new Error("Prime Agent package-smoke custody identity changed while its proof was captured");
      }
      if (proof) assertSameProofIdentity(observed, proof);
      proof = observed;
      await security.assertStillSecure(proof);
      return proof;
  };

  const removeAfterConfirmedShutdown = async ({ confirmedCleanShutdown }) => {
      if (confirmedCleanShutdown !== true) {
        throw new Error("Prime Agent package-smoke custody cleanup requires confirmed clean host shutdown");
      }
      if (!initialAbsenceConfirmed) {
        throw new Error("Prime Agent package-smoke custody cleanup has no pre-start absence proof");
      }
      if (!(await pathExists(agentDirectory))) return Object.freeze({ removed: false, entries: 0, bytes: 0 });
      if (!proof) await captureExisting();
      if (!proof) throw new Error("Prime Agent package-smoke custody identity could not be captured");

      await assertExactResolvedLeaf({
        platform,
        canonicalHostDataRoot,
        programDataRoot,
        agentDirectory,
        hostdModule: options.hostdModule,
      });
      await security.assertStillSecure(proof);
      const tree = await inspectBoundedUnlinkedTree(agentDirectory, platform);
      await security.assertStillSecure(proof);
      await assertIdentity(agentDirectory, proof.agentDirectoryIdentity);
      await assertIdentity(proof.canonicalCustodyParent, proof.custodyParentIdentity);

      await rm(agentDirectory, {
        recursive: true,
        force: false,
        maxRetries: 5,
        retryDelay: 100,
      });
      if (await pathExists(agentDirectory)) {
        throw new Error("Prime Agent package-smoke custody leaf remained after bounded cleanup");
      }
      await assertIdentity(proof.canonicalCustodyParent, proof.custodyParentIdentity);
      return Object.freeze({ removed: true, ...tree });
  };

  return Object.freeze({
    agentDirectory,
    assertInitiallyAbsent,
    captureExisting,
    removeAfterConfirmedShutdown,
  });
}

function assertOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Prime Agent package-smoke custody options are invalid");
  }
  if (typeof options.hostDataRoot !== "string" || options.hostDataRoot.length < 1) {
    throw new TypeError("Prime Agent package-smoke host data root is invalid");
  }
  if (
    !options.hostdModule ||
    typeof options.hostdModule !== "object" ||
    typeof options.hostdModule.resolvePrimeAgentRuntimeDirectory !== "function" ||
    typeof options.hostdModule.HostScopedPrimeAgentAuthSecurity !== "function"
  ) {
    throw new TypeError("Prime Agent package-smoke hostd custody exports are unavailable");
  }
}

async function assertExactResolvedLeaf({
  platform,
  canonicalHostDataRoot,
  programDataRoot,
  agentDirectory,
  hostdModule,
}) {
  const expected = resolve(hostdModule.resolvePrimeAgentRuntimeDirectory(
    canonicalHostDataRoot,
    {
      platform,
      ...(programDataRoot ? { programDataRoot } : {}),
    },
  ));
  if (!samePath(platform, expected, agentDirectory)) {
    throw new Error("Prime Agent package-smoke custody resolver changed identity");
  }
  if (platform === "win32") {
    if (!programDataRoot || !WINDOWS_LEAF_NAME.test(basename(agentDirectory))) {
      throw new Error("Prime Agent package-smoke custody leaf name is invalid");
    }
    const canonicalProgramData = await canonicalDirectory(programDataRoot, platform);
    if (!samePath(platform, dirname(agentDirectory), canonicalProgramData)) {
      throw new Error("Prime Agent package-smoke custody leaf is not a direct ProgramData child");
    }
    return;
  }
  if (!samePath(platform, dirname(agentDirectory), canonicalHostDataRoot) || basename(agentDirectory) !== "prime-agent") {
    throw new Error("Prime Agent package-smoke custody leaf is not a direct host-data child");
  }
}

function assertExactProof(proof, expected) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    throw new Error("Prime Agent package-smoke custody proof is invalid");
  }
  if (
    proof.platform !== expected.platform ||
    !samePath(expected.platform, proof.canonicalHostDataRoot, expected.canonicalHostDataRoot) ||
    !samePath(expected.platform, proof.canonicalAgentDirectory, expected.agentDirectory) ||
    typeof proof.custodyParentIdentity !== "string" ||
    typeof proof.agentDirectoryIdentity !== "string" ||
    proof.custodyParentIdentity.length < 3 ||
    proof.agentDirectoryIdentity.length < 3
  ) {
    throw new Error("Prime Agent package-smoke custody proof does not match its isolated host");
  }
  if (
    expected.platform === "win32" &&
    (!expected.programDataRoot || !samePath(expected.platform, proof.canonicalCustodyParent, expected.programDataRoot))
  ) {
    throw new Error("Prime Agent package-smoke custody proof does not bind the ProgramData parent");
  }
  if (
    expected.platform !== "win32" &&
    !samePath(expected.platform, proof.canonicalCustodyParent, expected.canonicalHostDataRoot)
  ) {
    throw new Error("Prime Agent package-smoke custody proof does not bind the host-data parent");
  }
}

function assertSameProofIdentity(left, right) {
  if (
    left.custodyParentIdentity !== right.custodyParentIdentity ||
    left.agentDirectoryIdentity !== right.agentDirectoryIdentity ||
    !samePath(left.platform, left.canonicalAgentDirectory, right.canonicalAgentDirectory)
  ) {
    throw new Error("Prime Agent package-smoke custody identity changed during the smoke");
  }
}

async function inspectBoundedUnlinkedTree(root, platform) {
  const canonicalRoot = await canonicalDirectory(root, platform);
  if (!samePath(platform, canonicalRoot, resolve(root))) {
    throw new Error("Prime Agent package-smoke custody leaf resolves through a link");
  }
  const pending = [{ directory: canonicalRoot, depth: 0 }];
  let entries = 1;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.depth > MAX_TREE_DEPTH) {
      throw new Error("Prime Agent package-smoke custody tree exceeds its cleanup depth bound");
    }
    const children = await readdir(current.directory, { withFileTypes: true });
    for (const child of children) {
      entries += 1;
      if (entries > MAX_TREE_ENTRIES) {
        throw new Error("Prime Agent package-smoke custody tree exceeds its cleanup entry bound");
      }
      if (!child.name || child.name === "." || child.name === ".." || child.name.includes("\0") || child.name.includes("/") || child.name.includes("\\")) {
        throw new Error("Prime Agent package-smoke custody tree contains an invalid entry name");
      }
      const path = resolve(current.directory, child.name);
      assertDescendant(canonicalRoot, path, platform);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error("Prime Agent package-smoke custody cleanup refuses linked entries");
      }
      if (metadata.isDirectory()) {
        const physical = await realpath(path);
        if (!samePath(platform, physical, path)) {
          throw new Error("Prime Agent package-smoke custody cleanup refuses reparse directories");
        }
        pending.push({ directory: path, depth: current.depth + 1 });
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error("Prime Agent package-smoke custody cleanup refuses non-regular or multiply-linked entries");
      }
      bytes += metadata.size;
      if (!Number.isSafeInteger(bytes) || bytes > MAX_TREE_BYTES) {
        throw new Error("Prime Agent package-smoke custody tree exceeds its cleanup byte bound");
      }
    }
  }
  return Object.freeze({ entries, bytes });
}

function assertDescendant(parent, child, platform) {
  const value = relative(parent, child);
  if (
    !value ||
    value === ".." ||
    value.startsWith(`..${sep}`) ||
    isAbsolute(value) ||
    (platform === "win32" && value.includes(":"))
  ) {
    throw new Error("Prime Agent package-smoke custody cleanup escaped its exact leaf");
  }
}

async function assertIdentity(path, expected) {
  if (await plainDirectoryIdentity(path) !== expected) {
    throw new Error("Prime Agent package-smoke custody filesystem identity changed");
  }
}

async function plainDirectoryIdentity(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Prime Agent package-smoke custody filesystem identity is not a plain directory");
  }
  return `${metadata.dev}:${metadata.ino}`;
}

async function canonicalDirectory(path, platform) {
  const lexical = resolve(path);
  const canonical = await realpath(lexical);
  if (!samePath(platform, lexical, canonical)) {
    throw new Error("Prime Agent package-smoke custody path resolves through a link");
  }
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Prime Agent package-smoke custody path is not a plain directory");
  }
  return canonical;
}

function requireProgramDataRoot(environment) {
  const values = Object.entries(environment)
    .filter(([name]) => name.toUpperCase() === "PROGRAMDATA")
    .map(([, value]) => value);
  if (
    values.length < 1 ||
    values.some((value) => typeof value !== "string" || value.length < 3 || value.length > 32_767 || /[\0\r\n]/.test(value))
  ) {
    throw new Error("Prime Agent package-smoke custody requires a bounded ProgramData root");
  }
  const roots = [...new Set(values.map((value) => resolve(value).replaceAll("/", "\\").toLowerCase()))];
  if (roots.length !== 1) {
    throw new Error("Prime Agent package-smoke custody found conflicting ProgramData roots");
  }
  return resolve(values[0]);
}

function samePath(platform, left, right) {
  return platform === "win32"
    ? resolve(left).replaceAll("/", "\\").toLowerCase() === resolve(right).replaceAll("/", "\\").toLowerCase()
    : resolve(left) === resolve(right);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
