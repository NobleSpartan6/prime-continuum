import { createHash } from "node:crypto";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  RUNTIME_TEMPLATE_DIRECTORY,
  cleanRuntimeEnvironment,
  loadRuntimeInputs,
  runCommand,
  smokeBrowserBridge,
  verifyBuiltRuntime,
  verifyOnlySelectedRuntimeInstall,
} from "./prime-agent-runtime-lib.mjs";
import { readPinnedDevelopmentNodeVersion } from "./development-node-runtime.mjs";

export const RUNTIME_ATTESTATION_RECORD_PREFIX = "PRIME_CONTINUIM_RUNTIME_ATTESTATION_V1:";
export const MAX_RUNTIME_ATTESTATION_BYTES = 256 * 1024;

const MAX_POINTER_BYTES = 64 * 1024;
const MAX_FILE_MANIFEST_BYTES = 16 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^[0-9A-Za-z.+_-]{1,64}$/;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;

export async function createRuntimeAttestation(options = {}) {
  const runtimeRoot = resolve(options.runtimeRoot ?? join(process.cwd(), "out", "runtime"));
  const electronExecutable = await requireAbsoluteRegularFile(options.electronExecutable, "Electron executable");
  const hostNodeExecutable = await requireAbsoluteRegularFile(options.hostNodeExecutable, "Host Node executable");
  invariant(electronExecutable !== hostNodeExecutable, "GUI Electron and host Node must be different executable files.");
  const inputs = await loadRuntimeInputs(options.templateDirectory ?? RUNTIME_TEMPLATE_DIRECTORY);
  const expectedHostNodeVersion = options.hostNodeVersion ?? readPinnedDevelopmentNodeVersion(resolve(import.meta.dirname, ".."));
  const pointerBytes = await readBoundedFile(join(runtimeRoot, "current.json"), MAX_POINTER_BYTES, "runtime pointer");
  const pointer = parseJson(pointerBytes, "runtime pointer");
  validateRuntimePointer(pointer, inputs.policy);
  const manifestPath = resolveContainedRelativePath(runtimeRoot, pointer.runtimeManifest, "runtime manifest");
  const runtimeDirectory = dirname(manifestPath);
  await verifyOnlySelectedRuntimeInstall(runtimeRoot, runtimeDirectory);
  const verified = await verifyBuiltRuntime(runtimeDirectory, { inputs, policy: inputs.policy });
  const [manifestBytes, fileManifestBytes, guiRuntime, hostRuntime] = await Promise.all([
    readBoundedFile(manifestPath, MAX_RUNTIME_ATTESTATION_BYTES, "runtime manifest"),
    readBoundedFile(join(runtimeDirectory, "files.sha256"), MAX_FILE_MANIFEST_BYTES, "runtime file manifest"),
    readElectronRuntimeIdentity(electronExecutable),
    readNodeRuntimeIdentity(hostNodeExecutable),
  ]);
  invariant(hostRuntime.nodeVersion === expectedHostNodeVersion, `Host Node must be the exact pinned v${expectedHostNodeVersion} runtime.`);
  invariant(guiRuntime.executableSha256 !== hostRuntime.executableSha256, "GUI Electron and host Node executable identities must be unequal.");
  invariant(guiRuntime.platform === hostRuntime.platform && guiRuntime.arch === hostRuntime.arch, "GUI Electron and host Node must target the same platform and architecture.");
  const browserSmoke = await smokeBrowserBridge(runtimeDirectory, {
    runtimeExecutable: electronExecutable,
    policy: inputs.policy,
  });

  const attestation = {
    schemaVersion: 1,
    product: "Prime Continuim",
    assurance: "development-integrity",
    runtimePolicySchemaVersion: inputs.policy.schemaVersion,
    runtime: {
      name: "prime-agent",
      releaseVersion: verified.manifest.release.version,
      runtimeBuildId: verified.manifest.runtimeBuildId,
      platform: verified.manifest.platform,
      arch: verified.manifest.arch,
      libc: verified.manifest.libc,
    },
    manifest: {
      relativePath: pointer.runtimeManifest,
      sha256: pointer.manifestSha256,
      sourcesSha256: verified.manifest.sourcesSha256,
      policySha256: verified.manifest.policySha256,
      packageLockSha256: verified.manifest.packageLockSha256,
    },
    tree: verified.manifest.tree,
    entrypoints: verified.manifest.entrypoints,
    browserBridge: {
      ...verified.manifest.browserBridge,
      smoke: {
        verified: browserSmoke.verified,
        operations: browserSmoke.operations,
      },
    },
    daemon: verified.manifest.daemon,
    nativeAddons: verified.manifest.nativeAddons,
    guiRuntime,
    hostRuntime,
  };

  validateRuntimeAttestation(attestation);
  assertRuntimeAttestationMatches(attestation, {
    pointer,
    manifest: verified.manifest,
    manifestBytes,
    fileManifestBytes,
    guiRuntime,
    hostRuntime,
    inputs,
  });
  return Object.freeze(attestation);
}

export function serializeRuntimeAttestation(attestation) {
  validateRuntimeAttestation(attestation);
  const bytes = Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_RUNTIME_ATTESTATION_BYTES) {
    throw new Error("Runtime attestation exceeds its bounded size.");
  }
  return bytes;
}

export function parseRuntimeAttestation(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RUNTIME_ATTESTATION_BYTES) {
    throw new Error("Runtime attestation is empty or exceeds its bounded size.");
  }
  const attestation = parseJson(bytes, "runtime attestation");
  validateRuntimeAttestation(attestation);
  return attestation;
}

export function createEmbeddedRuntimeAttestationRecord(value) {
  const bytes = Buffer.isBuffer(value) ? value : serializeRuntimeAttestation(value);
  parseRuntimeAttestation(bytes);
  return `${RUNTIME_ATTESTATION_RECORD_PREFIX}${bytes.toString("base64")}`;
}

export function extractEmbeddedRuntimeAttestation(bundle) {
  const text = typeof bundle === "string" ? bundle : Buffer.from(bundle).toString("utf8");
  const pattern = /PRIME_CONTINUIM_RUNTIME_ATTESTATION_V1:([A-Za-z0-9+/]{32,}={0,2})/g;
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error("Host daemon must contain exactly one embedded runtime attestation.");
  }
  const encoded = matches[0][1];
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error("Embedded runtime attestation is not canonical base64.");
  }
  parseRuntimeAttestation(bytes);
  return bytes;
}

export function assertRuntimeAttestationMatches(attestation, context) {
  validateRuntimeAttestation(attestation);
  const { pointer, manifest, manifestBytes, fileManifestBytes, guiRuntime, hostRuntime, inputs } = context;
  validateRuntimePointer(pointer, inputs.policy);
  const expectedRuntime = {
    name: "prime-agent",
    releaseVersion: manifest.release.version,
    runtimeBuildId: manifest.runtimeBuildId,
    platform: manifest.platform,
    arch: manifest.arch,
    libc: manifest.libc,
  };
  const expectedManifest = {
    relativePath: pointer.runtimeManifest,
    sha256: sha256(manifestBytes),
    sourcesSha256: manifest.sourcesSha256,
    policySha256: manifest.policySha256,
    packageLockSha256: manifest.packageLockSha256,
  };

  invariant(attestation.schemaVersion === 1, "Runtime attestation schema drifted.");
  invariant(attestation.product === "Prime Continuim", "Runtime attestation product drifted.");
  invariant(attestation.assurance === "development-integrity", "Unsigned runtime assurance is overstated.");
  invariant(
    attestation.runtimePolicySchemaVersion === inputs.policy.schemaVersion,
    "Runtime attestation policy schema drifted.",
  );
  invariant(jsonEqual(attestation.runtime, expectedRuntime), "Runtime attestation identity does not match the seed.");
  invariant(jsonEqual(attestation.manifest, expectedManifest), "Runtime attestation manifest does not match the seed.");
  invariant(pointer.manifestSha256 === expectedManifest.sha256, "Runtime pointer manifest digest is stale.");
  invariant(jsonEqual(attestation.tree, manifest.tree), "Runtime attestation tree does not match the seed.");
  invariant(sha256(fileManifestBytes) === manifest.tree.filesSha256, "Runtime file-manifest digest is stale.");
  invariant(jsonEqual(attestation.entrypoints, manifest.entrypoints), "Runtime attestation entrypoints drifted.");
  invariant(jsonEqual({
    protocol: attestation.browserBridge.protocol,
    playwrightCoreVersion: attestation.browserBridge.playwrightCoreVersion,
    engine: attestation.browserBridge.engine,
  }, manifest.browserBridge), "Runtime browser bridge identity drifted.");
  invariant(
    attestation.browserBridge.smoke?.verified === true &&
      jsonEqual(attestation.browserBridge.smoke.operations, [
        "doctor", "open", "snapshot", "find", "click", "eval", "screenshot", "close",
      ]),
    "Runtime browser bridge smoke evidence drifted.",
  );
  invariant(jsonEqual(attestation.daemon, manifest.daemon), "Runtime attestation daemon contract drifted.");
  invariant(jsonEqual(attestation.nativeAddons, manifest.nativeAddons), "Runtime native-addon allowlist drifted.");
  invariant(jsonEqual(attestation.guiRuntime, guiRuntime), "GUI Electron executable identity drifted.");
  invariant(jsonEqual(attestation.hostRuntime, hostRuntime), "Runtime host process identity drifted.");
  invariant(attestation.guiRuntime.executableSha256 !== attestation.hostRuntime.executableSha256, "GUI Electron and host Node executable identities must be unequal.");
}

export async function readElectronRuntimeIdentity(executablePath) {
  const executable = await requireAbsoluteRegularFile(executablePath, "Electron executable");
  const source = [
    "const value = {",
    '  kind: "electron",',
    "  electronVersion: process.versions.electron,",
    "  nodeVersion: process.versions.node,",
    "  modulesAbi: process.versions.modules,",
    "  napiVersion: process.versions.napi,",
    "  platform: process.platform,",
    "  arch: process.arch,",
    "};",
    "process.stdout.write(JSON.stringify(value));",
  ].join("\n");
  const [result, executableSha256] = await Promise.all([
    runCommand(executable, ["-e", source], {
      env: cleanRuntimeEnvironment(process.env, { electronRunAsNode: true }),
      timeoutMs: 10_000,
    }),
    sha256Executable(executable, "Electron executable"),
  ]);
  const identity = { ...parseJson(Buffer.from(result.stdout, "utf8"), "Electron runtime identity"), executableSha256 };
  validateGuiRuntime(identity);
  return identity;
}

export async function readNodeRuntimeIdentity(executablePath) {
  const executable = await requireAbsoluteRegularFile(executablePath, "Host Node executable");
  const source = [
    'if (process.versions.electron) throw new Error("host executable unexpectedly exposes Electron");',
    "const value = {",
    '  kind: "node",',
    "  nodeVersion: process.versions.node,",
    "  modulesAbi: process.versions.modules,",
    "  napiVersion: process.versions.napi,",
    "  platform: process.platform,",
    "  arch: process.arch,",
    "};",
    "process.stdout.write(JSON.stringify(value));",
  ].join("\n");
  const [result, executableSha256] = await Promise.all([
    runCommand(executable, ["-e", source], {
      env: cleanRuntimeEnvironment(process.env, { electronRunAsNode: false }),
      timeoutMs: 10_000,
    }),
    sha256Executable(executable, "Host Node executable"),
  ]);
  const identity = { ...parseJson(Buffer.from(result.stdout, "utf8"), "Host Node runtime identity"), executableSha256 };
  validateHostRuntime(identity);
  return identity;
}

function validateRuntimeAttestation(value) {
  assertRecord(value, "runtime attestation");
  const expectedKeys = [
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
  ];
  assertExactKeys(value, expectedKeys, "runtime attestation");
  invariant(value.schemaVersion === 1, "Unsupported runtime attestation schema.");
  invariant(value.product === "Prime Continuim", "Runtime attestation product is invalid.");
  invariant(value.assurance === "development-integrity", "Runtime attestation assurance is invalid.");
  invariant(value.runtimePolicySchemaVersion === 1, "Runtime attestation policy schema is invalid.");

  assertRecord(value.runtime, "runtime attestation identity");
  assertExactKeys(value.runtime, ["name", "releaseVersion", "runtimeBuildId", "platform", "arch", "libc"], "runtime attestation identity");
  invariant(value.runtime.name === "prime-agent", "Runtime attestation names an unsupported runtime.");
  for (const key of ["releaseVersion", "runtimeBuildId", "platform", "arch", "libc"]) {
    assertBoundedString(value.runtime[key], `runtime.${key}`);
  }

  assertRecord(value.manifest, "runtime attestation manifest");
  assertExactKeys(value.manifest, ["relativePath", "sha256", "sourcesSha256", "policySha256", "packageLockSha256"], "runtime attestation manifest");
  assertSafeRelativePath(value.manifest.relativePath, "manifest.relativePath");
  invariant(value.manifest.relativePath.endsWith("/runtime.json"), "Runtime manifest locator is invalid.");
  for (const key of ["sha256", "sourcesSha256", "policySha256", "packageLockSha256"]) {
    assertSha256(value.manifest[key], `manifest.${key}`);
  }

  assertRecord(value.tree, "runtime attestation tree");
  assertExactKeys(value.tree, ["sha256", "filesSha256", "fileCount", "totalBytes"], "runtime attestation tree");
  assertSha256(value.tree.sha256, "tree.sha256");
  assertSha256(value.tree.filesSha256, "tree.filesSha256");
  assertBoundedInteger(value.tree.fileCount, 1, 100_000, "tree.fileCount");
  assertBoundedInteger(value.tree.totalBytes, 1, 8 * 1024 * 1024 * 1024, "tree.totalBytes");

  assertRecord(value.entrypoints, "runtime attestation entrypoints");
  assertExactKeys(
    value.entrypoints,
    ["module", "cli", "browserBridge", "browserHost", "browserLauncher", "browserLauncherWindows", "browserSkill"],
    "runtime attestation entrypoints",
  );
  assertSafeRelativePath(value.entrypoints.module, "entrypoints.module");
  assertSafeRelativePath(value.entrypoints.cli, "entrypoints.cli");
  assertSafeRelativePath(value.entrypoints.browserBridge, "entrypoints.browserBridge");
  assertSafeRelativePath(value.entrypoints.browserHost, "entrypoints.browserHost");
  assertSafeRelativePath(value.entrypoints.browserLauncher, "entrypoints.browserLauncher");
  assertSafeRelativePath(value.entrypoints.browserLauncherWindows, "entrypoints.browserLauncherWindows");
  assertSafeRelativePath(value.entrypoints.browserSkill, "entrypoints.browserSkill");

  assertRecord(value.browserBridge, "runtime attestation browser bridge");
  assertExactKeys(
    value.browserBridge,
    ["protocol", "playwrightCoreVersion", "engine", "smoke"],
    "runtime attestation browser bridge",
  );
  invariant(value.browserBridge.protocol === "prime-continuim.browser.v1", "Runtime browser bridge protocol is invalid.");
  invariant(
    value.browserBridge.playwrightCoreVersion === "1.63.0-alpha-2026-08-05",
    "Runtime browser bridge controller identity is invalid.",
  );
  invariant(value.browserBridge.engine === "verified-electron-host", "Runtime browser bridge engine is invalid.");
  assertRecord(value.browserBridge.smoke, "runtime attestation browser bridge smoke");
  assertExactKeys(value.browserBridge.smoke, ["verified", "operations"], "runtime attestation browser bridge smoke");
  invariant(value.browserBridge.smoke.verified === true, "Runtime browser bridge smoke is not verified.");
  invariant(
    jsonEqual(value.browserBridge.smoke.operations, [
      "doctor", "open", "snapshot", "find", "click", "eval", "screenshot", "close",
    ]),
    "Runtime browser bridge smoke operations are invalid.",
  );

  assertRecord(value.daemon, "runtime attestation daemon");
  assertExactKeys(value.daemon, ["protocolName", "protocolVersion", "schemaRevision", "schemaId", "requiredCapabilities"], "runtime attestation daemon");
  assertBoundedString(value.daemon.protocolName, "daemon.protocolName");
  assertBoundedInteger(value.daemon.protocolVersion, 1, 1_000_000, "daemon.protocolVersion");
  assertBoundedInteger(value.daemon.schemaRevision, 1, 1_000_000, "daemon.schemaRevision");
  assertBoundedString(value.daemon.schemaId, "daemon.schemaId");
  invariant(Array.isArray(value.daemon.requiredCapabilities) && value.daemon.requiredCapabilities.length > 0 && value.daemon.requiredCapabilities.length <= 32, "Runtime daemon capability list is invalid.");
  const capabilities = new Set();
  for (const capability of value.daemon.requiredCapabilities) {
    assertBoundedString(capability, "daemon.requiredCapabilities[]");
    invariant(!capabilities.has(capability), "Runtime daemon capability list contains duplicates.");
    capabilities.add(capability);
  }

  invariant(Array.isArray(value.nativeAddons) && value.nativeAddons.length > 0 && value.nativeAddons.length <= 32, "Runtime native-addon allowlist is invalid.");
  const addonPaths = new Set();
  for (const addon of value.nativeAddons) {
    assertRecord(addon, "runtime native-addon entry");
    assertExactKeys(addon, ["path", "size", "sha256"], "runtime native-addon entry");
    assertSafeRelativePath(addon.path, "nativeAddons[].path");
    invariant(addon.path.endsWith(".node") && !addonPaths.has(addon.path), "Runtime native-addon path is invalid or duplicated.");
    addonPaths.add(addon.path);
    assertBoundedInteger(addon.size, 1, 1024 * 1024 * 1024, "nativeAddons[].size");
    assertSha256(addon.sha256, "nativeAddons[].sha256");
  }
  validateGuiRuntime(value.guiRuntime);
  validateHostRuntime(value.hostRuntime);
  invariant(value.guiRuntime.executableSha256 !== value.hostRuntime.executableSha256, "GUI Electron and host Node executable identities must be unequal.");
  invariant(value.guiRuntime.platform === value.hostRuntime.platform && value.guiRuntime.arch === value.hostRuntime.arch, "GUI Electron and host Node targets must match.");
}

function validateGuiRuntime(value) {
  assertRecord(value, "GUI Electron identity");
  assertExactKeys(value, ["kind", "electronVersion", "nodeVersion", "modulesAbi", "napiVersion", "platform", "arch", "executableSha256"], "GUI Electron identity");
  invariant(value.kind === "electron", "GUI runtime must be Electron.");
  for (const key of ["electronVersion", "nodeVersion", "modulesAbi", "napiVersion", "platform", "arch"]) {
    invariant(typeof value[key] === "string" && VERSION_PATTERN.test(value[key]), `GUI Electron ${key} is invalid.`);
  }
  assertSha256(value.executableSha256, "GUI Electron executable digest");
}

function validateHostRuntime(value) {
  assertRecord(value, "runtime host identity");
  assertExactKeys(value, ["kind", "nodeVersion", "modulesAbi", "napiVersion", "platform", "arch", "executableSha256"], "runtime host identity");
  invariant(value.kind === "node", "Runtime host must be standalone Node.");
  for (const key of ["nodeVersion", "modulesAbi", "napiVersion", "platform", "arch"]) {
    invariant(typeof value[key] === "string" && VERSION_PATTERN.test(value[key]), `Runtime host ${key} is invalid.`);
  }
  assertSha256(value.executableSha256, "Runtime host executable digest");
}

function validateRuntimePointer(pointer, policy) {
  assertRecord(pointer, "runtime pointer");
  assertExactKeys(pointer, ["schemaVersion", "releaseVersion", "platform", "arch", "treeSha256", "manifestSha256", "runtimeManifest"], "runtime pointer");
  invariant(pointer.schemaVersion === 1, "Runtime pointer schema is invalid.");
  invariant(pointer.releaseVersion === policy.releaseVersion, "Runtime pointer release is not pinned.");
  invariant(pointer.platform === process.platform && pointer.arch === process.arch, "Runtime pointer target is incompatible.");
  assertSha256(pointer.treeSha256, "runtime pointer tree digest");
  assertSha256(pointer.manifestSha256, "runtime pointer manifest digest");
  assertSafeRelativePath(pointer.runtimeManifest, "runtime pointer manifest path");
  invariant(pointer.runtimeManifest.endsWith("/runtime.json"), "Runtime pointer manifest path is invalid.");
}

function resolveContainedRelativePath(root, relativePath, label) {
  assertSafeRelativePath(relativePath, label);
  const target = resolve(root, ...relativePath.split("/"));
  const relation = relative(root, target);
  invariant(relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation), `${label} escapes its root.`);
  return target;
}

function assertSafeRelativePath(value, label) {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 4_096, `${label} is not bounded.`);
  invariant(!value.includes("\\") && !value.includes("\0") && !value.includes("\r") && !value.includes("\n"), `${label} contains unsafe characters.`);
  invariant(value.normalize("NFC") === value, `${label} is not NFC-normalized.`);
  const segments = value.split("/");
  invariant(segments.every((segment) => segment && segment !== "." && segment !== ".." && segment.length <= 255), `${label} contains an unsafe segment.`);
}

async function requireAbsoluteRegularFile(path, label) {
  invariant(typeof path === "string" && isAbsolute(path), `${label} must be an absolute path.`);
  const resolved = await realpath(path);
  const metadata = await stat(resolved);
  invariant(metadata.isFile() && metadata.size > 0, `${label} must be a non-empty regular file.`);
  return resolved;
}

async function sha256Executable(path, label) {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    invariant(before.isFile() && before.size > 0 && before.size <= MAX_EXECUTABLE_BYTES, `${label} is outside its executable size bound.`);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, before.size - position), position);
      invariant(bytesRead > 0, `${label} ended before its recorded size.`);
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: growthBytes } = await handle.read(probe, 0, 1, before.size);
    const after = await handle.stat();
    invariant(growthBytes === 0 && before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs, `${label} changed while it was hashed.`);
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

async function readBoundedFile(path, maxBytes, label) {
  const metadata = await stat(path);
  invariant(metadata.isFile() && metadata.size > 0 && metadata.size <= maxBytes, `${label} is empty, non-regular, or exceeds its size limit.`);
  const bytes = await readFile(path);
  invariant(bytes.byteLength === metadata.size, `${label} changed while it was read.`);
  return bytes;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertRecord(value, label) {
  invariant(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object.`);
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  invariant(jsonEqual(actual, expected), `${label} contains unexpected or missing fields.`);
}

function assertSha256(value, label) {
  invariant(typeof value === "string" && SHA256_PATTERN.test(value), `${label} is not a canonical SHA-256 digest.`);
}

function assertBoundedString(value, label) {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value), `${label} is not a bounded string.`);
}

function assertBoundedInteger(value, minimum, maximum, label) {
  invariant(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${label} is outside its allowed range.`);
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
