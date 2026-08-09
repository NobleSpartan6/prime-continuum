import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  RUNTIME_TEMPLATE_DIRECTORY,
  cleanRuntimeEnvironment,
  loadRuntimeInputs,
  runCommand,
  verifyBuiltRuntime,
  verifyOnlySelectedRuntimeInstall,
} from "./prime-agent-runtime-lib.mjs";

export const RUNTIME_ATTESTATION_RECORD_PREFIX = "PRIME_CONTINUIM_RUNTIME_ATTESTATION_V1:";
export const MAX_RUNTIME_ATTESTATION_BYTES = 256 * 1024;

const MAX_POINTER_BYTES = 64 * 1024;
const MAX_FILE_MANIFEST_BYTES = 16 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^[0-9A-Za-z.+_-]{1,64}$/;

export async function createRuntimeAttestation(options = {}) {
  const runtimeRoot = resolve(options.runtimeRoot ?? join(process.cwd(), "out", "runtime"));
  const electronExecutable = await requireAbsoluteRegularFile(options.electronExecutable, "Electron executable");
  const inputs = await loadRuntimeInputs(options.templateDirectory ?? RUNTIME_TEMPLATE_DIRECTORY);
  const pointerBytes = await readBoundedFile(join(runtimeRoot, "current.json"), MAX_POINTER_BYTES, "runtime pointer");
  const pointer = parseJson(pointerBytes, "runtime pointer");
  validateRuntimePointer(pointer, inputs.policy);
  const manifestPath = resolveContainedRelativePath(runtimeRoot, pointer.runtimeManifest, "runtime manifest");
  const runtimeDirectory = dirname(manifestPath);
  await verifyOnlySelectedRuntimeInstall(runtimeRoot, runtimeDirectory);
  const verified = await verifyBuiltRuntime(runtimeDirectory, { inputs, policy: inputs.policy });
  const [manifestBytes, fileManifestBytes, hostRuntime] = await Promise.all([
    readBoundedFile(manifestPath, MAX_RUNTIME_ATTESTATION_BYTES, "runtime manifest"),
    readBoundedFile(join(runtimeDirectory, "files.sha256"), MAX_FILE_MANIFEST_BYTES, "runtime file manifest"),
    readElectronRuntimeIdentity(electronExecutable),
  ]);

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
    daemon: verified.manifest.daemon,
    nativeAddons: verified.manifest.nativeAddons,
    hostRuntime,
  };

  validateRuntimeAttestation(attestation);
  assertRuntimeAttestationMatches(attestation, {
    pointer,
    manifest: verified.manifest,
    manifestBytes,
    fileManifestBytes,
    runtimeVersions: hostRuntime,
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
  const { pointer, manifest, manifestBytes, fileManifestBytes, runtimeVersions, inputs } = context;
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
  const expectedHostRuntime = {
    kind: "electron-run-as-node",
    electronVersion: runtimeVersions.electronVersion ?? runtimeVersions.electron,
    nodeVersion: runtimeVersions.nodeVersion ?? runtimeVersions.node,
    modulesAbi: runtimeVersions.modulesAbi ?? runtimeVersions.modules,
    napiVersion: runtimeVersions.napiVersion ?? runtimeVersions.napi,
    platform: runtimeVersions.platform,
    arch: runtimeVersions.arch,
    runAsNode: runtimeVersions.runAsNode === true || runtimeVersions.runAsNode === "1",
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
  invariant(jsonEqual(attestation.daemon, manifest.daemon), "Runtime attestation daemon contract drifted.");
  invariant(jsonEqual(attestation.nativeAddons, manifest.nativeAddons), "Runtime native-addon allowlist drifted.");
  invariant(jsonEqual(attestation.hostRuntime, expectedHostRuntime), "Runtime host process identity drifted.");
}

export async function readElectronRuntimeIdentity(executablePath) {
  const executable = await requireAbsoluteRegularFile(executablePath, "Electron executable");
  const source = [
    "const value = {",
    '  kind: "electron-run-as-node",',
    "  electronVersion: process.versions.electron,",
    "  nodeVersion: process.versions.node,",
    "  modulesAbi: process.versions.modules,",
    "  napiVersion: process.versions.napi,",
    "  platform: process.platform,",
    "  arch: process.arch,",
    '  runAsNode: process.env.ELECTRON_RUN_AS_NODE === "1",',
    "};",
    "process.stdout.write(JSON.stringify(value));",
  ].join("\n");
  const result = await runCommand(executable, ["-e", source], {
    env: cleanRuntimeEnvironment(process.env, { electronRunAsNode: true }),
    timeoutMs: 10_000,
  });
  const identity = parseJson(Buffer.from(result.stdout, "utf8"), "Electron runtime identity");
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
    "daemon",
    "nativeAddons",
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
  assertExactKeys(value.entrypoints, ["module", "cli"], "runtime attestation entrypoints");
  assertSafeRelativePath(value.entrypoints.module, "entrypoints.module");
  assertSafeRelativePath(value.entrypoints.cli, "entrypoints.cli");

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
  validateHostRuntime(value.hostRuntime);
}

function validateHostRuntime(value) {
  assertRecord(value, "runtime host identity");
  assertExactKeys(value, ["kind", "electronVersion", "nodeVersion", "modulesAbi", "napiVersion", "platform", "arch", "runAsNode"], "runtime host identity");
  invariant(value.kind === "electron-run-as-node", "Runtime host must be Electron RunAsNode.");
  for (const key of ["electronVersion", "nodeVersion", "modulesAbi", "napiVersion", "platform", "arch"]) {
    invariant(typeof value[key] === "string" && VERSION_PATTERN.test(value[key]), `Runtime host ${key} is invalid.`);
  }
  invariant(value.runAsNode === true, "Runtime host must require ELECTRON_RUN_AS_NODE=1.");
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
