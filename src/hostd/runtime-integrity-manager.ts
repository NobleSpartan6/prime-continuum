import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  AtomicWriteAmbiguousCommitError,
  atomicWriteJson,
  ensurePrivateDirectory,
} from "./atomic-files";
import {
  HostOwnershipPublicationAmbiguousError,
  type HostOwnershipLease,
} from "./ownership-lease";
import { getHostDataPaths, type HostDataPaths } from "./paths";
import type { EmbeddedRuntimeAttestation } from "./runtime-attestation";
import {
  assertSameRuntimeFileIdentity,
  isCtimeOnlyRuntimeFileIdentityChange,
  retryOnceAfterCtimeOnlyIdentityChange,
} from "./runtime-file-identity";

const MAX_RUNTIME_POINTER_BYTES = 64 * 1024;
const MAX_RUNTIME_MANIFEST_BYTES = 256 * 1024;
const MAX_RUNTIME_FILE_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_FILE_BYTES = 1024 * 1024 * 1024;
const COPY_BUFFER_BYTES = 256 * 1024;
const RUNTIME_FILE_CONCURRENCY = 16;
const MACOS_CLONE_TOOL = "/bin/cp";
const MACOS_XATTR_TOOL = "/usr/bin/xattr";
const MAX_RUNTIME_REPAIR_QUARANTINES = 2;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_SHORT_NAME_PATTERN = /~[0-9]+(?:\.[^.]*)?$/i;
const TRANSIENT_RUNTIME_FILESYSTEM_CODES = new Set(["EACCES", "EAGAIN", "EBUSY", "EMFILE", "ENFILE", "EPERM"]);
const REPAIR_REQUIRED_RUNTIME_FILESYSTEM_CODES = new Set(["EISDIR", "ENOENT", "ENOTDIR"]);

const Sha256Schema = z.string().regex(SHA256_PATTERN);
const BoundedStringSchema = z.string().min(1).max(4_096).refine((value) => !/[\0\r\n]/.test(value));
const RuntimeVersionSchema = z.object({
  node: BoundedStringSchema,
  modules: BoundedStringSchema,
  napi: BoundedStringSchema,
}).strict();
const RuntimeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  product: z.literal("Prime Continuim"),
  runtime: z.literal("prime-agent"),
  release: z.object({
    repository: BoundedStringSchema,
    tag: BoundedStringSchema,
    version: BoundedStringSchema,
    commit: BoundedStringSchema,
  }).strict(),
  runtimeBuildId: BoundedStringSchema,
  platform: BoundedStringSchema,
  arch: BoundedStringSchema,
  libc: BoundedStringSchema,
  buildRuntime: RuntimeVersionSchema.extend({ npm: BoundedStringSchema }).strict(),
  smokeRuntime: RuntimeVersionSchema.extend({
    platform: BoundedStringSchema,
    arch: BoundedStringSchema,
  }).strict(),
  sourcesSha256: Sha256Schema,
  policySha256: Sha256Schema,
  packageLockSha256: Sha256Schema,
  installPolicy: z.object({
    ignoreScripts: z.literal(true),
    omitDev: z.literal(true),
    omitOptional: z.literal(true),
    installStrategy: z.literal("hoisted"),
    targetNativePrebuildsOnly: z.literal(true),
  }).strict(),
  entrypoints: z.object({
    module: BoundedStringSchema,
    cli: BoundedStringSchema,
    browserBridge: BoundedStringSchema,
    browserHost: BoundedStringSchema,
    browserLauncher: BoundedStringSchema,
    browserLauncherWindows: BoundedStringSchema,
    browserSkill: BoundedStringSchema,
  }).strict(),
  browserBridge: z.object({
    protocol: z.literal("prime-continuim.browser.v1"),
    playwrightCoreVersion: z.literal("1.63.0-alpha-2026-08-05"),
    engine: z.literal("verified-electron-host"),
  }).strict(),
  daemon: z.object({
    protocolName: BoundedStringSchema,
    protocolVersion: z.number().int().positive(),
    schemaRevision: z.number().int().positive(),
    schemaId: BoundedStringSchema,
    requiredCapabilities: z.array(BoundedStringSchema).min(1).max(32),
  }).strict(),
  sources: z.array(z.object({
    packageName: BoundedStringSchema,
    fileName: BoundedStringSchema,
    url: BoundedStringSchema,
    size: z.number().int().positive().max(MAX_RUNTIME_FILE_BYTES),
    sha256: Sha256Schema,
    integrity: BoundedStringSchema,
  }).strict()).min(1).max(32),
  nativeAddons: z.array(z.object({
    path: BoundedStringSchema,
    size: z.number().int().positive().max(MAX_RUNTIME_FILE_BYTES),
    sha256: Sha256Schema,
  }).strict()).min(1).max(32),
  tree: z.object({
    sha256: Sha256Schema,
    filesSha256: Sha256Schema,
    fileCount: z.number().int().positive().max(100_000),
    totalBytes: z.number().int().positive().max(8 * 1024 * 1024 * 1024),
  }).strict(),
}).strict();

const SeedPointerSchema = z.object({
  schemaVersion: z.literal(1),
  releaseVersion: BoundedStringSchema,
  platform: BoundedStringSchema,
  arch: BoundedStringSchema,
  treeSha256: Sha256Schema,
  manifestSha256: Sha256Schema,
  runtimeManifest: BoundedStringSchema,
}).strict();

const InstalledPointerSchema = z.object({
  schemaVersion: z.literal(1),
  assurance: z.literal("development-integrity"),
  runtime: z.literal("prime-agent"),
  releaseVersion: BoundedStringSchema,
  runtimeBuildId: BoundedStringSchema,
  platform: BoundedStringSchema,
  arch: BoundedStringSchema,
  manifestSha256: Sha256Schema,
  treeSha256: Sha256Schema,
  filesSha256: Sha256Schema,
}).strict();

type RuntimeManifest = z.infer<typeof RuntimeManifestSchema>;
type InstalledPointer = z.infer<typeof InstalledPointerSchema>;

export interface RuntimeHostIdentity {
  readonly kind: "node";
  readonly nodeVersion: string;
  readonly modulesAbi: string;
  readonly napiVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly executableSha256: string;
}

export interface InstalledRuntimeIntegrityIdentity extends InstalledPointer {
  readonly hostRuntime: RuntimeHostIdentity;
  readonly fileCount: number;
  readonly totalBytes: number;
}

declare const verifiedInstalledRuntimeHandleBrand: unique symbol;

/**
 * Process-local proof that the exact installed runtime tree was freshly
 * verified while this host still owned its endpoint generation.
 *
 * The private brand keeps path-bearing launch material out of structural IPC
 * contracts. This value must stay inside hostd and be acquired immediately
 * before constructing a resident adapter.
 */
export interface VerifiedInstalledRuntimeHandle {
  readonly [verifiedInstalledRuntimeHandleBrand]: never;
  /** Path-free identity suitable for comparison and diagnostics. */
  readonly identity: InstalledRuntimeIntegrityIdentity;
  /** Absolute path of the identity-checked standalone Node host. */
  readonly executable: string;
  /** Exact independently attested Electron executable used only by the browser bridge. */
  readonly browserExecutable: string;
  /** Absolute file URL of the verified Prime Agent module entrypoint. */
  readonly moduleUrl: string;
  /** Absolute path of the verified Prime Agent CLI entrypoint. */
  readonly cliEntrypoint: string;
  /** Absolute path of the attested browser bridge program. */
  readonly browserBridge: string;
  /** Absolute path of the attested POSIX browser launcher. */
  readonly browserLauncher: string;
  /** Absolute path of the attested Windows browser launcher. */
  readonly browserLauncherWindows: string;
  /** Absolute path of the attested resident browser skill. */
  readonly browserSkill: string;
}

export const RUNTIME_INTEGRITY_CANCELLED = "RUNTIME_INTEGRITY_CANCELLED" as const;

export class RuntimeIntegrityCancelledError extends Error {
  readonly code = RUNTIME_INTEGRITY_CANCELLED;

  constructor(options?: ErrorOptions) {
    super("Runtime integrity work was cancelled", options);
    this.name = "RuntimeIntegrityCancelledError";
  }
}

export class RuntimeIntegrityPublicationPoisonedError extends Error {
  readonly code = "RUNTIME_INTEGRITY_PUBLICATION_POISONED" as const;
  readonly generation: string;

  constructor(generation: string, cause: Error) {
    super("Runtime integrity publication is poisoned until endpoint ownership is reacquired", { cause });
    this.name = "RuntimeIntegrityPublicationPoisonedError";
    this.generation = generation;
  }
}

export class RuntimeIntegrityInstalledCorruptionError extends Error {
  readonly code = "RUNTIME_INSTALLED_CORRUPTION" as const;

  constructor(cause: Error) {
    super("The installed runtime image failed integrity verification", { cause });
    this.name = "RuntimeIntegrityInstalledCorruptionError";
  }
}

export class RuntimeIntegrityTransientVerificationError extends Error {
  readonly code = "RUNTIME_TRANSIENT_VERIFICATION" as const;
  readonly reason: "filesystem_contention" | "final_disappeared";

  constructor(reason: "filesystem_contention" | "final_disappeared", cause: Error) {
    super(
      reason === "filesystem_contention"
        ? "Installed runtime verification encountered transient filesystem contention"
        : "The installed runtime disappeared during its final verification",
      { cause },
    );
    this.name = "RuntimeIntegrityTransientVerificationError";
    this.reason = reason;
  }
}

export type RuntimeIntegrityRepairReason =
  | "installed_pointer_invalid"
  | "packaged_seed_unavailable"
  | "packaged_seed_invalid";

export class RuntimeIntegrityRepairRequiredError extends Error {
  readonly code = "RUNTIME_REPAIR_REQUIRED" as const;
  readonly reason: RuntimeIntegrityRepairReason;

  constructor(reason: RuntimeIntegrityRepairReason, cause: Error) {
    const message = reason === "installed_pointer_invalid"
      ? "The installed runtime pointer requires application repair"
      : reason === "packaged_seed_unavailable"
        ? "The packaged runtime seed is unavailable and requires application repair"
        : "The packaged runtime seed failed integrity validation and requires application repair";
    super(message, { cause });
    this.name = "RuntimeIntegrityRepairRequiredError";
    this.reason = reason;
  }
}

export type RuntimeIntegrityProgressPhase =
  | "preparing"
  | "validating_seed"
  | "copying"
  | "verifying"
  | "publishing";

export type RuntimeIntegrityFaultPoint =
  | "before_copy"
  | "after_copy"
  | "before_final_verify"
  | "before_final_rename"
  | "after_final_rename"
  | "before_pointer_write"
  | "after_pointer_write"
  | "before_repair_quarantine_prune";

export interface RuntimeIntegrityManagerOptions {
  readonly paths: HostDataPaths;
  readonly attestation: EmbeddedRuntimeAttestation;
  readonly ownershipLease: HostOwnershipLease;
  readonly hostRuntime?: RuntimeHostIdentity;
  readonly browserExecutable?: string;
  /** Deterministic test seam; production always hashes browserExecutable directly. */
  readonly browserExecutableSha256?: string;
  readonly faultInjector?: (point: RuntimeIntegrityFaultPoint) => void | Promise<void>;
  readonly writeCurrent?: (path: string, value: InstalledPointer) => Promise<void>;
  readonly onProgress?: (phase: RuntimeIntegrityProgressPhase) => void;
  /** Deterministic test seam. Production uses the root-owned macOS clone tool only for a macOS runtime. */
  readonly cloneRuntimeTree?: RuntimeTreeCloner;
}

export type RuntimeTreeCloner = (
  sourceDirectory: string,
  destinationDirectory: string,
  signal: AbortSignal,
) => Promise<boolean>;

interface RuntimeFileEntry {
  readonly path: string;
  readonly sha256: string;
}

/**
 * Development-integrity installer for the current unsigned package.
 *
 * This code rejects static links, hard links, namespace ambiguity, corruption,
 * and non-racing replacement. Node does not expose Windows no-follow/openat
 * handles, so this class deliberately makes no claim against a concurrent
 * same-user reparse-point attacker. Production authorization must remain
 * blocked until a signed outer chain and native handle verifier replace this
 * assurance level.
 */
export class RuntimeIntegrityManager {
  private readonly paths: HostDataPaths;
  private readonly attestation: EmbeddedRuntimeAttestation;
  private readonly hostRuntime: RuntimeHostIdentity;
  private readonly browserExecutable: string;
  private readonly ownershipLease: HostOwnershipLease;
  private readonly faultInjector?: RuntimeIntegrityManagerOptions["faultInjector"];
  private readonly writeCurrent: NonNullable<RuntimeIntegrityManagerOptions["writeCurrent"]>;
  private readonly onProgress?: RuntimeIntegrityManagerOptions["onProgress"];
  private readonly cloneRuntimeTree?: RuntimeTreeCloner;
  private ensurePromise?: Promise<InstalledRuntimeIntegrityIdentity>;
  private repairPromise?: Promise<InstalledRuntimeIntegrityIdentity>;
  private publicationPoison?: RuntimeIntegrityPublicationPoisonedError;

  constructor(options: RuntimeIntegrityManagerOptions) {
    const canonicalPaths = getHostDataPaths(options.paths.root);
    for (const key of ["root", "runtime", "runtimeCurrent", "runtimeInstalls", "runtimeStaging"] as const) {
      if (options.paths[key] !== canonicalPaths[key]) {
        throw new Error(`Runtime integrity path topology is not canonical: ${key}`);
      }
    }
    this.paths = Object.freeze(canonicalPaths);
    this.attestation = options.attestation;
    this.ownershipLease = options.ownershipLease;
    this.hostRuntime = options.hostRuntime ?? currentRuntimeHostIdentity();
    this.browserExecutable = boundedAbsoluteRuntimeLocation(
      options.browserExecutable ?? process.execPath,
      "browser Electron executable",
    );
    this.faultInjector = options.faultInjector;
    this.writeCurrent = options.writeCurrent ?? ((path, value) => atomicWriteJson(path, value));
    this.onProgress = options.onProgress;
    this.cloneRuntimeTree = options.cloneRuntimeTree ?? (
      process.platform === "darwin" && this.attestation.runtime.platform === "darwin"
        ? cloneMacOSRuntimeTree
        : undefined
    );
    assertHostRuntime(this.hostRuntime, this.attestation);
    const browserExecutableSha256 = options.browserExecutableSha256 ?? hashExecutable(this.browserExecutable);
    if (
      browserExecutableSha256 !== this.attestation.guiRuntime.executableSha256 ||
      browserExecutableSha256 === this.hostRuntime.executableSha256
    ) {
      throw new Error("Browser Electron executable does not match the embedded runtime attestation");
    }
    if (this.attestation.assurance !== "development-integrity") {
      throw new Error("The unsigned runtime integrity manager refuses production-authenticated claims");
    }
  }

  ensureInstalled(seedRoot?: string): Promise<InstalledRuntimeIntegrityIdentity> {
    if (this.publicationPoison) return Promise.reject(this.publicationPoison);
    if (this.repairPromise) return Promise.reject(new Error("Runtime repair is already active"));
    if (this.ensurePromise) return this.ensurePromise;
    const attempt = this.ensureInstalledOnce(seedRoot).then(async (identity) => {
      await this.pruneRuntimeRepairQuarantines();
      return identity;
    });
    this.ensurePromise = attempt;
    attempt.then(
      () => {
        if (this.ensurePromise === attempt) this.ensurePromise = undefined;
      },
      () => {
        if (this.ensurePromise === attempt) this.ensurePromise = undefined;
      },
    );
    return attempt;
  }

  /**
   * Replaces only this build's exact content-addressed installed image from
   * the embedded-attestation seed. Existing pointer/image bytes are retained
   * under the host runtime directory for support inspection; project, thread,
   * workspace, credential, and resident state are never addressed here.
   *
   * Callers must separately prove that no verified runtime handle or resident
   * lifecycle can still be active. RuntimeIntegrityManager intentionally has
   * no access to those higher-level authorities.
   */
  repairInstalled(seedRoot: string): Promise<InstalledRuntimeIntegrityIdentity> {
    if (this.publicationPoison) return Promise.reject(this.publicationPoison);
    if (this.ensurePromise || this.repairPromise) {
      return Promise.reject(new Error("Runtime integrity work is already active"));
    }
    const attempt = this.repairInstalledOnce(seedRoot).then(async (identity) => {
      await this.pruneRuntimeRepairQuarantines();
      return identity;
    });
    this.repairPromise = attempt;
    attempt.then(
      () => {
        if (this.repairPromise === attempt) this.repairPromise = undefined;
      },
      () => {
        if (this.repairPromise === attempt) this.repairPromise = undefined;
      },
    );
    return attempt;
  }

  async verifyInstalled(): Promise<InstalledRuntimeIntegrityIdentity> {
    this.assertManagerUsable();
    await this.ownershipLease.assertActive();
    throwIfRuntimeIntegrityCancelled(this.ownershipLease.signal);
    this.reportProgress("verifying");
    return await this.verifyInstalledUnderLease();
  }

  /**
   * Re-hashes the complete installed image and proves active endpoint
   * ownership before materializing the private paths required for resident
   * launch. No successful initialization result or earlier handle is reused.
   *
   * This remains a development-integrity proof: these are verified path
   * strings, not race-free native file handles. Ordinary Node filesystem APIs
   * cannot close the documented same-user Windows reparse-point/TOCTOU window;
   * production authorization still requires a signed outer chain and native
   * handle verifier.
   */
  async acquireVerifiedRuntimeHandle(): Promise<VerifiedInstalledRuntimeHandle> {
    this.assertManagerUsable();
    await this.ownershipLease.assertActive();
    throwIfRuntimeIntegrityCancelled(this.ownershipLease.signal);
    const identity = await this.verifyInstalledUnderLease();

    // verifyInstalledUnderLease performs the final physical ownership proof.
    // Keep path derivation synchronous so there is no additional asynchronous
    // gap between that proof and returning the process-local capability.
    return this.runtimeHandle(identity);
  }

  private async verifyInstalledUnderLease(): Promise<InstalledRuntimeIntegrityIdentity> {
    const signal = this.ownershipLease.signal;
    const expectedPointer = installedPointerFromAttestation(this.attestation);
    const pointer = await readRequiredJson(
      this.paths.runtimeCurrent,
      InstalledPointerSchema,
      MAX_RUNTIME_POINTER_BYTES,
      signal,
    );
    if (!jsonEqual(pointer, expectedPointer)) {
      throw new Error("Installed runtime pointer belongs to a different runtime image");
    }
    const verified = await this.verifyFinalDirectory(this.finalDirectory(), signal);
    throwIfRuntimeIntegrityCancelled(signal);
    await this.ownershipLease.assertActive();
    throwIfRuntimeIntegrityCancelled(signal);
    return this.identity(expectedPointer, verified.manifest);
  }

  private async ensureInstalledOnce(seedRoot?: string): Promise<InstalledRuntimeIntegrityIdentity> {
    this.assertManagerUsable();
    await this.ownershipLease.assertActive();
    const signal = this.ownershipLease.signal;
    throwIfRuntimeIntegrityCancelled(signal);
    this.reportProgress("preparing");
    throwIfRuntimeIntegrityCancelled(signal);
    await this.prepareRuntimeDirectories(signal);
    const expectedPointer = installedPointerFromAttestation(this.attestation);
    const finalDirectory = this.finalDirectory();
    let existingPointer: InstalledPointer | undefined;
    try {
      existingPointer = await readOptionalJson(this.paths.runtimeCurrent, InstalledPointerSchema, signal);
    } catch (error) {
      throw classifyRuntimeRepairFailure(
        "installed_pointer_invalid",
        error,
        "Installed runtime pointer is malformed or unreadable",
      );
    }
    this.reportProgress("verifying");
    throwIfRuntimeIntegrityCancelled(signal);
    if (existingPointer) {
      if (!jsonEqual(existingPointer, expectedPointer)) {
        // This unsigned development-integrity checkpoint cannot distinguish a
        // strictly valid older pointer from same-user edits. The old pointer is
        // never dereferenced: only this build's embedded attestation plus an
        // already-verified exact image or seed may authorize the new identity.
        // Authenticated releases must bind allowed predecessor identities in
        // signed updater metadata.
        if (await entryExists(finalDirectory, signal)) {
          await this.verifyFinalDirectory(finalDirectory, signal);
          await this.publishCurrentPointer(expectedPointer);
        } else {
          if (!seedRoot) {
            throw new RuntimeIntegrityRepairRequiredError(
              "packaged_seed_unavailable",
              new Error("Installed runtime pointer belongs to a different runtime image and no attested rollover seed is available"),
            );
          }
          const sourceDirectory = await this.resolveAndValidateSeed(seedRoot, signal);
          await this.promoteSeed(sourceDirectory, finalDirectory, expectedPointer);
        }
        return await this.verifyInstalledUnderLease();
      }
      let verified: { manifest: RuntimeManifest };
      try {
        verified = await this.verifyFinalDirectory(finalDirectory, signal);
      } catch (error) {
        // Windows cannot durably flush directory renames through Node. If a
        // trusted pointer survived power loss but its content-addressed final
        // did not, the still-attested packaged seed can recreate only that
        // missing identity. A present-but-corrupt final is never overwritten.
        if (
          error instanceof RuntimeIntegrityCancelledError ||
          error instanceof RuntimeIntegrityInstalledCorruptionError ||
          (error instanceof RuntimeIntegrityTransientVerificationError && error.reason === "filesystem_contention")
        ) {
          throw error;
        }
        const filesystemCode = firstErrorCodeInChain(error);
        if (
          !(error instanceof RuntimeIntegrityTransientVerificationError) &&
          filesystemCode !== undefined &&
          !REPAIR_REQUIRED_RUNTIME_FILESYSTEM_CODES.has(filesystemCode)
        ) {
          // A coded OS fault outside the closed repair-required set is not
          // evidence that either the installed image or packaged seed is bad.
          throw error;
        }
        if (
          !(error instanceof RuntimeIntegrityTransientVerificationError) ||
          error.reason !== "final_disappeared"
        ) {
          // Recovery is authorized only when verification established that the
          // exact final disappeared. Unclassified failures retain their type.
          throw error;
        }
        if (!seedRoot) {
          throw new RuntimeIntegrityRepairRequiredError(
            "packaged_seed_unavailable",
            new Error("Installed runtime image is missing and no attested recovery seed is available", { cause: error }),
          );
        }
        const sourceDirectory = await this.resolveAndValidateSeed(seedRoot, signal);
        await this.promoteSeed(sourceDirectory, finalDirectory);
        verified = await this.verifyFinalDirectory(finalDirectory, signal);
      }
      throwIfRuntimeIntegrityCancelled(signal);
      await this.ownershipLease.assertActive();
      throwIfRuntimeIntegrityCancelled(signal);
      return this.identity(expectedPointer, verified.manifest);
    }

    if (await entryExists(finalDirectory, signal)) {
      await this.verifyFinalDirectory(finalDirectory, signal);
      await this.publishCurrentPointer(expectedPointer);
    } else {
      if (!seedRoot) {
        throw new RuntimeIntegrityRepairRequiredError(
          "packaged_seed_unavailable",
          new Error("No installed runtime or packaged runtime seed is available"),
        );
      }
      const sourceDirectory = await this.resolveAndValidateSeed(seedRoot, signal);
      await this.promoteSeed(sourceDirectory, finalDirectory, expectedPointer);
    }

    return await this.verifyInstalledUnderLease();
  }

  private async repairInstalledOnce(seedRoot: string): Promise<InstalledRuntimeIntegrityIdentity> {
    this.assertManagerUsable();
    await this.ownershipLease.assertActive();
    const signal = this.ownershipLease.signal;
    throwIfRuntimeIntegrityCancelled(signal);
    this.reportProgress("preparing");
    await this.prepareRuntimeDirectories(signal);

    // Prove the complete packaged source before moving a single installed
    // byte. promoteSeed repeats the verification while copying, closing a
    // later seed-change window without trusting this preflight result.
    const sourceDirectory = await this.resolveAndValidateSeed(seedRoot, signal);
    this.reportProgress("verifying");
    try {
      await verifyRuntimeDirectory(sourceDirectory, this.attestation, undefined, signal);
    } catch (error) {
      throw classifyRuntimeRepairFailure(
        errorCodeInChain(error, "ENOENT") ? "packaged_seed_unavailable" : "packaged_seed_invalid",
        error,
        "Packaged runtime repair source verification failed",
      );
    }

    const expectedPointer = installedPointerFromAttestation(this.attestation);
    const finalDirectory = this.finalDirectory();
    await this.quarantineInstalledTarget(finalDirectory, signal);
    await this.promoteSeed(sourceDirectory, finalDirectory, expectedPointer);
    return await this.verifyInstalledUnderLease();
  }

  private async quarantineInstalledTarget(finalDirectory: string, signal: AbortSignal): Promise<void> {
    throwIfRuntimeIntegrityCancelled(signal);
    const pointerExists = await entryExists(this.paths.runtimeCurrent, signal);
    const finalExists = await entryExists(finalDirectory, signal);
    if (!pointerExists && !finalExists) return;

    const quarantineRoot = join(this.paths.runtime, "quarantine");
    assertContainedPath(this.paths.runtime, quarantineRoot, "runtime repair quarantine");
    await ensurePrivateDirectory(quarantineRoot);
    await assertPlainDirectory(quarantineRoot, "runtime repair quarantine", signal);
    const existing = await readPlainDirectory(quarantineRoot, "runtime repair quarantine", signal);
    if (existing.length > MAX_RUNTIME_REPAIR_QUARANTINES) {
      throw new Error("Runtime repair quarantine limit reached");
    }
    for (const entry of existing) {
      if (!/^repair-[A-Za-z0-9_-]{6,64}$/.test(entry.name)) {
        throw new Error("Runtime repair quarantine contains an unexpected entry");
      }
      await assertPlainDirectory(join(quarantineRoot, entry.name), "runtime repair quarantine entry", signal);
    }

    const quarantineDirectory = await mkdtemp(join(quarantineRoot, "repair-"));
    assertContainedPath(quarantineRoot, quarantineDirectory, "runtime repair quarantine entry");
    let moved = false;
    try {
      await this.withPublicationPermit(async () => {
        // Cancellation is deliberately not observed after permit admission.
        // The content-addressed final is the only install directory moved;
        // other versions remain untouched.
        try {
          if (finalExists) {
            await rename(finalDirectory, join(quarantineDirectory, "installed-image"));
            moved = true;
          }
          if (pointerExists) {
            await rename(this.paths.runtimeCurrent, join(quarantineDirectory, "current.json"));
            moved = true;
          }
          await syncParentDirectory(finalDirectory);
          await syncParentDirectory(this.paths.runtimeCurrent);
          await syncParentDirectory(join(quarantineDirectory, "installed-image"));
        } catch (error) {
          if (moved) throw new AtomicWriteAmbiguousCommitError(quarantineDirectory, error);
          throw error;
        }
      });
    } catch (error) {
      throw error;
    } finally {
      if (!moved) await rmdir(quarantineDirectory).catch(() => undefined);
    }
  }

  private async pruneRuntimeRepairQuarantines(): Promise<void> {
    const signal = this.ownershipLease.signal;
    throwIfRuntimeIntegrityCancelled(signal);
    const quarantineRoot = join(this.paths.runtime, "quarantine");
    assertContainedPath(this.paths.runtime, quarantineRoot, "runtime repair quarantine");
    if (!(await entryExists(quarantineRoot, signal))) return;
    await assertPlainDirectory(quarantineRoot, "runtime repair quarantine", signal);
    const entries = await readPlainDirectory(quarantineRoot, "runtime repair quarantine", signal);
    const candidates: Array<{ path: string; name: string; mtimeNs: bigint; empty: boolean }> = [];
    for (const entry of entries) {
      if (!/^repair-[A-Za-z0-9_-]{6,64}$/.test(entry.name) || !entry.isDirectory()) {
        throw new Error("Runtime repair quarantine contains an unexpected entry");
      }
      const path = join(quarantineRoot, entry.name);
      assertContainedPath(quarantineRoot, path, "runtime repair quarantine entry");
      const topLevel = await validateRepairQuarantineTree(path, signal);
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("Runtime repair quarantine entry must remain a plain directory");
      }
      candidates.push({ path, name: entry.name, mtimeNs: metadata.mtimeNs, empty: topLevel === 0 });
    }

    const nonempty = candidates.filter((candidate) => !candidate.empty);
    const excess = Math.max(0, nonempty.length - MAX_RUNTIME_REPAIR_QUARANTINES);
    const selected = [
      ...candidates.filter((candidate) => candidate.empty),
      ...nonempty
        .sort((left, right) => left.mtimeNs === right.mtimeNs
          ? compareRuntimePaths(left.name, right.name)
          : left.mtimeNs < right.mtimeNs ? -1 : 1)
        .slice(0, excess),
    ];
    if (selected.length === 0) return;
    await this.faultInjector?.("before_repair_quarantine_prune");
    await this.withPublicationPermit(async () => {
      try {
        for (const candidate of selected) {
          await removeValidatedRepairQuarantineTree(candidate.path, quarantineRoot);
        }
        await syncParentDirectory(join(quarantineRoot, "repair-prune-boundary"));
      } catch (error) {
        throw new AtomicWriteAmbiguousCommitError(quarantineRoot, error);
      }
    });
  }

  private async prepareRuntimeDirectories(signal: AbortSignal): Promise<void> {
    for (const directory of [this.paths.runtime, this.paths.runtimeInstalls, this.paths.runtimeStaging]) {
      throwIfRuntimeIntegrityCancelled(signal);
      await ensurePrivateDirectory(directory);
      throwIfRuntimeIntegrityCancelled(signal);
      await assertPlainDirectory(directory, "host runtime directory", signal);
      assertContainedPath(this.paths.root, directory, "host runtime directory");
    }
    await cleanupAbandonedStaging(this.paths.runtimeStaging, signal);
  }

  private async resolveAndValidateSeed(seedRoot: string, signal: AbortSignal): Promise<string> {
    try {
      return await this.resolveAndValidateSeedUnchecked(seedRoot, signal);
    } catch (error) {
      throw classifyRuntimeRepairFailure(
        errorCodeInChain(error, "ENOENT") ? "packaged_seed_unavailable" : "packaged_seed_invalid",
        error,
        "Packaged runtime seed validation failed",
      );
    }
  }

  private async resolveAndValidateSeedUnchecked(seedRoot: string, signal: AbortSignal): Promise<string> {
    this.reportProgress("validating_seed");
    throwIfRuntimeIntegrityCancelled(signal);
    if (!isAbsolute(seedRoot) || seedRoot.length > 4_096 || /[\0\r\n]/.test(seedRoot)) {
      throw new Error("Runtime seed root must be a bounded absolute path");
    }
    const root = resolve(seedRoot);
    await assertPlainDirectory(root, "runtime seed root", signal);
    const segments = this.attestation.manifest.relativePath.split("/");
    if (segments.length !== 3 || segments[0] !== "installs" || segments[2] !== "runtime.json") {
      throw new Error("Embedded runtime attestation has an unsupported seed locator");
    }
    const installName = segments[1];
    if (!installName || !isSafeRuntimePath(installName)) throw new Error("Runtime seed install name is unsafe");
    const topLevel = await readPlainDirectory(root, "runtime seed root", signal);
    assertDirectoryNames(topLevel, ["current.json", "installs"], "runtime seed root");
    const installs = join(root, "installs");
    await assertPlainDirectory(installs, "runtime seed installs directory", signal);
    const installEntries = await readPlainDirectory(installs, "runtime seed installs directory", signal);
    assertDirectoryNames(installEntries, [installName], "runtime seed installs directory");
    const sourceDirectory = join(installs, installName);
    await assertPlainDirectory(sourceDirectory, "runtime seed image", signal);

    const seedPointer = await readRequiredJson(
      join(root, "current.json"),
      SeedPointerSchema,
      MAX_RUNTIME_POINTER_BYTES,
      signal,
    );
    const expectedSeedPointer = {
      schemaVersion: 1,
      releaseVersion: this.attestation.runtime.releaseVersion,
      platform: this.attestation.runtime.platform,
      arch: this.attestation.runtime.arch,
      treeSha256: this.attestation.tree.sha256,
      manifestSha256: this.attestation.manifest.sha256,
      runtimeManifest: this.attestation.manifest.relativePath,
    } as const;
    if (!jsonEqual(seedPointer, expectedSeedPointer)) {
      throw new Error("Packaged runtime pointer does not match the embedded attestation");
    }
    return sourceDirectory;
  }

  private async verifyFinalDirectory(
    finalDirectory: string,
    signal: AbortSignal,
  ): Promise<{ manifest: RuntimeManifest }> {
    try {
      await this.faultInjector?.("before_final_verify");
      return await verifyRuntimeDirectory(finalDirectory, this.attestation, undefined, signal);
    } catch (error) {
      const cause = asError(error, "Installed runtime verification failed");
      if (
        error instanceof RuntimeIntegrityCancelledError ||
        error instanceof RuntimeIntegrityTransientVerificationError
      ) {
        throw error;
      }
      if (isTransientRuntimeFilesystemError(error)) {
        throw new RuntimeIntegrityTransientVerificationError("filesystem_contention", cause);
      }
      let finalExists: boolean;
      try {
        finalExists = await entryExists(finalDirectory, signal);
      } catch (inspectionError) {
        if (inspectionError instanceof RuntimeIntegrityCancelledError) throw inspectionError;
        if (isTransientRuntimeFilesystemError(inspectionError)) {
          throw new RuntimeIntegrityTransientVerificationError(
            "filesystem_contention",
            asError(inspectionError, "Installed runtime presence check encountered filesystem contention"),
          );
        }
        throw inspectionError;
      }
      if (finalExists) {
        // Unknown coded OS failures say the verifier could not establish
        // integrity. The closed structural set is different: against a
        // still-present root, it means required runtime topology is corrupt.
        const filesystemCode = firstErrorCodeInChain(error);
        if (
          filesystemCode !== undefined &&
          !REPAIR_REQUIRED_RUNTIME_FILESYSTEM_CODES.has(filesystemCode)
        ) {
          throw cause;
        }
        throw new RuntimeIntegrityInstalledCorruptionError(cause);
      }
      // A final that disappeared between publication and the pre-use check is
      // recoverable from the same attested seed on one complete retry.
      throw new RuntimeIntegrityTransientVerificationError("final_disappeared", cause);
    }
  }

  private async promoteSeed(
    sourceDirectory: string,
    finalDirectory: string,
    pointer?: InstalledPointer,
  ): Promise<void> {
    const signal = this.ownershipLease.signal;
    throwIfRuntimeIntegrityCancelled(signal);
    const stagingDirectory = await mkdtemp(join(this.paths.runtimeStaging, "image-"));
    assertContainedPath(this.paths.runtimeStaging, stagingDirectory, "runtime staging directory");
    let published = false;
    try {
      this.reportProgress("copying");
      throwIfRuntimeIntegrityCancelled(signal);
      await this.faultInjector?.("before_copy");
      throwIfRuntimeIntegrityCancelled(signal);
      try {
        let cloned = false;
        if (this.cloneRuntimeTree) {
          // The clone is an optimization, never an authority shortcut. Hash the
          // complete source before invoking the system tool, and hash it again
          // after the tool retires so a moving packaged seed cannot be
          // promoted through a successful destination verification alone.
          await verifyRuntimeDirectory(sourceDirectory, this.attestation, undefined, signal);
          try {
            cloned = await this.cloneRuntimeTree(sourceDirectory, stagingDirectory, signal);
          } catch (error) {
            if (error instanceof RuntimeIntegrityCancelledError || signal.aborted) throw error;
            cloned = false;
          }
          throwIfRuntimeIntegrityCancelled(signal);
          if (cloned) {
            await verifyRuntimeDirectory(sourceDirectory, this.attestation, undefined, signal);
            await normalizeAndSyncClonedRuntimeTree(stagingDirectory, this.attestation, signal);
          } else {
            await recreateEmptyStagingDirectory(stagingDirectory, signal);
          }
        }
        if (!cloned) {
          await verifyRuntimeDirectory(sourceDirectory, this.attestation, stagingDirectory, signal);
        }
      } catch (error) {
        throw classifyRuntimeRepairFailure(
          errorCodeInChain(error, "ENOENT") ? "packaged_seed_unavailable" : "packaged_seed_invalid",
          error,
          "Packaged runtime payload verification failed",
        );
      }
      await this.faultInjector?.("after_copy");
      throwIfRuntimeIntegrityCancelled(signal);
      this.reportProgress("verifying");
      throwIfRuntimeIntegrityCancelled(signal);
      await verifyRuntimeDirectory(stagingDirectory, this.attestation, undefined, signal);

      if (await entryExists(finalDirectory, signal)) {
        await this.verifyFinalDirectory(finalDirectory, signal);
        if (pointer) await this.publishCurrentPointer(pointer);
        return;
      }

      await this.faultInjector?.("before_final_rename");
      throwIfRuntimeIntegrityCancelled(signal);
      this.reportProgress("publishing");
      throwIfRuntimeIntegrityCancelled(signal);
      const outcome = await this.withPublicationPermit(async (): Promise<PublicationOutcome> => {
        // Cancellation is deliberately not observed after permit admission.
        if (await entryExists(finalDirectory)) return { kind: "retained" };
        try {
          await rename(stagingDirectory, finalDirectory);
          published = true;
        } catch (error) {
          return { kind: "failed", error: asError(error, "Runtime final publication failed") };
        }

        try {
          await syncParentDirectory(stagingDirectory);
          await syncParentDirectory(finalDirectory);
          await this.faultInjector?.("after_final_rename");
        } catch (error) {
          throw new AtomicWriteAmbiguousCommitError(finalDirectory, error);
        }

        if (pointer) {
          const pointerOutcome = await this.writeCurrentWithinPermit(pointer);
          if (pointerOutcome) return pointerOutcome;
        }
        return { kind: "published" };
      });

      if (outcome.kind === "failed") throw outcome.error;
      if (outcome.kind === "retained") {
        throwIfRuntimeIntegrityCancelled(signal);
        await this.verifyFinalDirectory(finalDirectory, signal);
        if (pointer) await this.publishCurrentPointer(pointer);
      }
    } finally {
      if (!published) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async publishCurrentPointer(pointer: InstalledPointer): Promise<void> {
    const signal = this.ownershipLease.signal;
    throwIfRuntimeIntegrityCancelled(signal);
    this.reportProgress("publishing");
    throwIfRuntimeIntegrityCancelled(signal);
    const outcome = await this.withPublicationPermit(async (): Promise<PublicationOutcome> => {
      // Cancellation is deliberately not observed after permit admission.
      const pointerOutcome = await this.writeCurrentWithinPermit(pointer);
      return pointerOutcome ?? { kind: "published" };
    });
    if (outcome.kind === "failed") throw outcome.error;
  }

  private async writeCurrentWithinPermit(pointer: InstalledPointer): Promise<PublicationOutcome | undefined> {
    let pointerWritten = false;
    try {
      await this.faultInjector?.("before_pointer_write");
      await this.writeCurrent(this.paths.runtimeCurrent, pointer);
      pointerWritten = true;
      await this.faultInjector?.("after_pointer_write");
    } catch (error) {
      if (error instanceof AtomicWriteAmbiguousCommitError) throw error;
      if (pointerWritten) throw new AtomicWriteAmbiguousCommitError(this.paths.runtimeCurrent, error);
      return { kind: "failed", error: asError(error, "Runtime pointer publication failed") };
    }
    return undefined;
  }

  private async withPublicationPermit<T>(publish: () => Promise<T>): Promise<T> {
    try {
      return await this.ownershipLease.withPublicationPermit(publish);
    } catch (error) {
      if (isPublicationUncertain(error)) {
        this.poisonPublication(asError(error, "Runtime publication became uncertain"));
      }
      throw error;
    }
  }

  private poisonPublication(cause: Error): void {
    if (!this.publicationPoison) {
      this.publicationPoison = new RuntimeIntegrityPublicationPoisonedError(
        this.ownershipLease.generation,
        cause,
      );
    }
    this.ownershipLease.poisonPublication(cause);
  }

  private assertManagerUsable(): void {
    if (this.publicationPoison) throw this.publicationPoison;
  }

  private reportProgress(phase: RuntimeIntegrityProgressPhase): void {
    try {
      this.onProgress?.(phase);
    } catch {
      // Progress is diagnostic-only and cannot alter integrity behavior.
    }
  }

  private finalDirectory(): string {
    const installName = runtimeInstallName(this.attestation);
    const directory = join(this.paths.runtimeInstalls, installName);
    assertContainedPath(this.paths.runtimeInstalls, directory, "runtime install directory");
    return directory;
  }

  private identity(pointer: InstalledPointer, manifest: RuntimeManifest): InstalledRuntimeIntegrityIdentity {
    return deepFreeze({
      ...pointer,
      hostRuntime: this.hostRuntime,
      fileCount: manifest.tree.fileCount,
      totalBytes: manifest.tree.totalBytes,
    });
  }

  private runtimeHandle(identity: InstalledRuntimeIntegrityIdentity): VerifiedInstalledRuntimeHandle {
    const executable = boundedAbsoluteRuntimeLocation(process.execPath, "runtime host executable");
    const finalDirectory = this.finalDirectory();
    const moduleEntrypoint = this.entrypointLocation(finalDirectory, this.attestation.entrypoints.module, "module");
    const cliEntrypoint = this.entrypointLocation(finalDirectory, this.attestation.entrypoints.cli, "CLI");
    const browserBridge = this.entrypointLocation(finalDirectory, this.attestation.entrypoints.browserBridge, "browser bridge");
    const browserLauncher = this.entrypointLocation(finalDirectory, this.attestation.entrypoints.browserLauncher, "browser launcher");
    const browserLauncherWindows = this.entrypointLocation(
      finalDirectory,
      this.attestation.entrypoints.browserLauncherWindows,
      "Windows browser launcher",
    );
    const browserSkill = this.entrypointLocation(finalDirectory, this.attestation.entrypoints.browserSkill, "browser skill");
    return Object.freeze({
      identity,
      executable,
      browserExecutable: this.browserExecutable,
      moduleUrl: pathToFileURL(moduleEntrypoint).href,
      cliEntrypoint,
      browserBridge,
      browserLauncher,
      browserLauncherWindows,
      browserSkill,
    }) as VerifiedInstalledRuntimeHandle;
  }

  private entrypointLocation(directory: string, relativePath: string, label: string): string {
    const location = join(directory, ...relativePath.split("/"));
    assertContainedPath(directory, location, `runtime ${label} entrypoint`);
    return boundedAbsoluteRuntimeLocation(location, `runtime ${label} entrypoint`);
  }
}

type PublicationOutcome =
  | { readonly kind: "published" }
  | { readonly kind: "retained" }
  | { readonly kind: "failed"; readonly error: Error };

function isPublicationUncertain(error: unknown): boolean {
  return error instanceof AtomicWriteAmbiguousCommitError ||
    error instanceof HostOwnershipPublicationAmbiguousError ||
    isErrorCode(error, "HOST_OWNERSHIP_PUBLICATION_UNCERTAIN");
}

function asError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

function boundedAbsoluteRuntimeLocation(value: string, label: string): string {
  if (!isAbsolute(value) || value.length === 0 || value.length > 4_096 || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be a bounded absolute path`);
  }
  return value;
}

function classifyRuntimeRepairFailure(
  reason: RuntimeIntegrityRepairReason,
  error: unknown,
  message: string,
): Error {
  if (
    error instanceof RuntimeIntegrityRepairRequiredError ||
    error instanceof RuntimeIntegrityTransientVerificationError ||
    error instanceof RuntimeIntegrityCancelledError
  ) {
    return error;
  }
  const cause = asError(error, message);
  if (isTransientRuntimeFilesystemError(error)) {
    return new RuntimeIntegrityTransientVerificationError("filesystem_contention", cause);
  }
  const filesystemCode = firstErrorCodeInChain(error);
  if (filesystemCode !== undefined && !REPAIR_REQUIRED_RUNTIME_FILESYSTEM_CODES.has(filesystemCode)) {
    // Unknown coded OS faults are not evidence that package bytes are bad.
    return cause;
  }
  return new RuntimeIntegrityRepairRequiredError(reason, cause);
}

function throwIfRuntimeIntegrityCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const cause = signal.reason;
  throw new RuntimeIntegrityCancelledError(cause === undefined ? undefined : { cause });
}

export function currentRuntimeHostIdentity(): RuntimeHostIdentity {
  const { electron: electronVersion, node: nodeVersion, modules: modulesAbi, napi: napiVersion } = process.versions;
  if (electronVersion || !nodeVersion || !modulesAbi || !napiVersion) {
    throw new Error("Runtime installation requires an exact standalone Node host");
  }
  return {
    kind: "node",
    nodeVersion,
    modulesAbi,
    napiVersion,
    platform: process.platform,
    arch: process.arch,
    executableSha256: hashExecutable(process.execPath),
  };
}

function hashExecutable(executable: string): string {
  const descriptor = openSync(executable, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > 512n * 1024n * 1024n) {
      throw new Error("Runtime host executable is outside its bounded size");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0n;
    while (position < before.size) {
      const requested = Number((before.size - position) < BigInt(buffer.byteLength) ? before.size - position : BigInt(buffer.byteLength));
      const bytesRead = readSync(descriptor, buffer, 0, requested, Number(position));
      if (bytesRead <= 0) throw new Error("Runtime host executable ended before its recorded size");
      digest.update(buffer.subarray(0, bytesRead));
      position += BigInt(bytesRead);
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error("Runtime host executable changed while it was hashed");
    }
    return digest.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

export function parseRuntimeFileManifest(
  value: Uint8Array | string,
  expectedCount: number,
  signal?: AbortSignal,
): readonly RuntimeFileEntry[] {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RUNTIME_FILE_MANIFEST_BYTES) {
    throw new Error("Runtime file manifest is empty or exceeds its bounded size");
  }
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\0")) {
    throw new Error("Runtime file manifest is not canonical newline-delimited UTF-8");
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== expectedCount || lines.length === 0 || lines.length > 100_000) {
    throw new Error("Runtime file manifest count does not match its attestation");
  }
  const entries: RuntimeFileEntry[] = [];
  const exactPaths = new Set<string>();
  const foldedPaths = new Set<string>();
  const foldedDirectories = new Map<string, string>();
  let previous: string | undefined;
  for (const line of lines) {
    if (signal && entries.length % 256 === 0) throwIfRuntimeIntegrityCancelled(signal);
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match?.[1] || !match[2] || !isSafeRuntimePath(match[2])) {
      throw new Error("Runtime file manifest contains an invalid digest or path");
    }
    const path = match[2];
    if (path === "files.sha256" || path === "runtime.json") {
      throw new Error("Runtime metadata cannot attest itself as a payload file");
    }
    if (/\.(?:dll|exe|dylib|so)$/i.test(path)) {
      throw new Error("Runtime file manifest contains an unattested native executable or library");
    }
    const folded = windowsFoldPath(path);
    if (exactPaths.has(path) || foldedPaths.has(folded)) {
      throw new Error("Runtime file manifest contains a duplicate or case-fold collision");
    }
    if (previous !== undefined && compareRuntimeTraversalPaths(previous, path) >= 0) {
      throw new Error("Runtime file manifest paths are not in canonical traversal order");
    }
    exactPaths.add(path);
    foldedPaths.add(folded);
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join("/");
      const foldedDirectory = windowsFoldPath(directory);
      const priorDirectory = foldedDirectories.get(foldedDirectory);
      if (priorDirectory !== undefined && priorDirectory !== directory) {
        throw new Error("Runtime file manifest contains a case-folded directory collision");
      }
      foldedDirectories.set(foldedDirectory, directory);
    }
    previous = path;
    entries.push({ path, sha256: match[1] });
  }
  const sortedFolded = [...foldedPaths].sort();
  for (let index = 1; index < sortedFolded.length; index += 1) {
    if (signal && index % 256 === 0) throwIfRuntimeIntegrityCancelled(signal);
    const prior = sortedFolded[index - 1];
    const current = sortedFolded[index];
    if (prior && current?.startsWith(`${prior}/`)) {
      throw new Error("Runtime file manifest contains a file/directory prefix collision");
    }
  }
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

async function verifyRuntimeDirectory(
  directory: string,
  attestation: EmbeddedRuntimeAttestation,
  copyDestination?: string,
  signal?: AbortSignal,
): Promise<{ manifest: RuntimeManifest }> {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  await assertPlainDirectory(directory, "runtime image", signal);
  const [manifestBytes, fileManifestBytes] = await Promise.all([
    readBoundedRegularFile(join(directory, "runtime.json"), MAX_RUNTIME_MANIFEST_BYTES, "runtime manifest", signal),
    readBoundedRegularFile(join(directory, "files.sha256"), MAX_RUNTIME_FILE_MANIFEST_BYTES, "runtime file manifest", signal),
  ]);
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  if (sha256(manifestBytes) !== attestation.manifest.sha256) {
    throw new Error("Runtime manifest does not match the embedded attestation");
  }
  if (sha256(fileManifestBytes) !== attestation.tree.filesSha256) {
    throw new Error("Runtime file manifest does not match the embedded attestation");
  }
  const manifest = RuntimeManifestSchema.parse(parseJson(manifestBytes, "runtime manifest"));
  assertManifestMatchesAttestation(manifest, attestation);
  const files = parseRuntimeFileManifest(
    fileManifestBytes,
    attestation.tree.fileCount,
    signal,
  );
  const payloadPaths = new Set(files.map((file) => file.path));
  for (const requiredPath of [
    manifest.entrypoints.module,
    manifest.entrypoints.cli,
    manifest.entrypoints.browserBridge,
    manifest.entrypoints.browserHost,
    manifest.entrypoints.browserLauncher,
    manifest.entrypoints.browserLauncherWindows,
    manifest.entrypoints.browserSkill,
    "node_modules/prime-agent/package.json",
    "node_modules/playwright-core/package.json",
  ]) {
    if (!payloadPaths.has(requiredPath)) throw new Error(`Runtime image is missing a required entrypoint file: ${requiredPath}`);
  }
  const expectedDirectories = runtimeDirectorySet(files, signal);
  await assertExactRuntimeNamespace(directory, files, expectedDirectories, signal);
  if (process.platform !== "win32") {
    const launcher = await lstat(join(directory, ...manifest.entrypoints.browserLauncher.split("/")));
    if (!launcher.isFile() || (launcher.mode & 0o111) === 0) {
      throw new Error("Runtime browser launcher is not executable");
    }
  }

  if (copyDestination) {
    await assertPlainDirectory(copyDestination, "runtime staging image", signal);
    await createRuntimeDirectories(copyDestination, expectedDirectories, signal);
    await Promise.all([
      copyAndHashRegularFile(
        join(directory, "runtime.json"),
        join(copyDestination, "runtime.json"),
        attestation.manifest.sha256,
        manifestBytes.byteLength,
        signal,
      ),
      copyAndHashRegularFile(
        join(directory, "files.sha256"),
        join(copyDestination, "files.sha256"),
        attestation.tree.filesSha256,
        fileManifestBytes.byteLength,
        signal,
      ),
    ]);
  }

  const tree = createHash("sha256");
  let totalBytes = 0;
  const nativeAddons: Array<{ path: string; size: number; sha256: string }> = [];
  const verifiedFiles = await mapConcurrentOrdered(files, RUNTIME_FILE_CONCURRENCY, async (file) => {
    const source = join(directory, ...file.path.split("/"));
    const destination = copyDestination ? join(copyDestination, ...file.path.split("/")) : undefined;
    return await hashRegularFile(source, file.sha256, destination, signal);
  }, signal);
  for (let index = 0; index < files.length; index += 1) {
    if (signal && index % 256 === 0) throwIfRuntimeIntegrityCancelled(signal);
    const file = files[index] as RuntimeFileEntry;
    const verified = verifiedFiles[index] as { size: number };
    totalBytes += verified.size;
    if (totalBytes > attestation.tree.totalBytes) throw new Error("Runtime image exceeds its attested byte count");
    tree.update(`${file.sha256} ${verified.size} ${file.path}\n`);
    if (file.path.endsWith(".node")) nativeAddons.push({ path: file.path, size: verified.size, sha256: file.sha256 });
  }
  if (
    totalBytes !== attestation.tree.totalBytes ||
    tree.digest("hex") !== attestation.tree.sha256 ||
    !jsonEqual(nativeAddons, manifest.nativeAddons)
  ) {
    throw new Error("Runtime payload tree or native-addon allowlist does not match its attestation");
  }
  if (copyDestination) await syncRuntimeTreeDirectories(copyDestination, expectedDirectories, signal);
  return { manifest };
}

async function mapConcurrentOrdered<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed) {
      try {
        if (signal) throwIfRuntimeIntegrityCancelled(signal);
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        results[index] = await operation(values[index] as T, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
  return results;
}

async function cloneMacOSRuntimeTree(
  sourceDirectory: string,
  destinationDirectory: string,
  signal: AbortSignal,
): Promise<boolean> {
  throwIfRuntimeIntegrityCancelled(signal);
  if (
    !await isTrustedMacOSSystemTool(MACOS_CLONE_TOOL) ||
    !await isTrustedMacOSSystemTool(MACOS_XATTR_TOOL)
  ) return false;
  const cloned = await runMacOSRuntimeUtility(
    MACOS_CLONE_TOOL,
    ["-c", "-R", `${sourceDirectory}${sep}.`, destinationDirectory],
    signal,
  );
  if (!cloned) return false;
  // clonefile preserves extended attributes. The byte-copy installer did not,
  // and retaining quarantine/provenance metadata can change launch behavior,
  // so clear all cloned attributes before any image is considered successful.
  return await runMacOSRuntimeUtility(
    MACOS_XATTR_TOOL,
    ["-c", "-r", destinationDirectory],
    signal,
  );
}

async function runMacOSRuntimeUtility(
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<boolean> {
  throwIfRuntimeIntegrityCancelled(signal);
  const completed = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(
        executable,
        args,
        {
          cwd: sep,
          env: { LANG: "C", LC_ALL: "C" },
          stdio: "ignore",
          windowsHide: true,
        },
      );
    } catch {
      finish(false);
      return;
    }
    child.once("error", () => finish(false));
    child.once("close", (code, terminationSignal) => {
      finish(code === 0 && terminationSignal === null);
    });
  });
  // Do not signal an opaque OS process by PID on cancellation. The bounded
  // clone normally retires in milliseconds; waiting for its owned ChildProcess
  // close avoids PID-reuse risk and guarantees no helper remains before
  // staging cleanup begins.
  throwIfRuntimeIntegrityCancelled(signal);
  return completed;
}

async function isTrustedMacOSSystemTool(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path, { bigint: true });
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.uid === 0n &&
      metadata.nlink === 1n &&
      (metadata.mode & 0o022n) === 0n &&
      (metadata.mode & 0o111n) !== 0n
    );
  } catch {
    return false;
  }
}

async function recreateEmptyStagingDirectory(path: string, signal?: AbortSignal): Promise<void> {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  const current = await lstat(path, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new Error("Runtime clone staging root is not a plain directory");
  }
  await rm(path, { recursive: true, force: false });
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  await mkdir(path, { recursive: false, mode: 0o700 });
  await assertPlainDirectory(path, "runtime staging image", signal);
}

async function normalizeAndSyncClonedRuntimeTree(
  directory: string,
  attestation: EmbeddedRuntimeAttestation,
  signal?: AbortSignal,
): Promise<void> {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  const [manifestBytes, fileManifestBytes] = await Promise.all([
    readBoundedRegularFile(join(directory, "runtime.json"), MAX_RUNTIME_MANIFEST_BYTES, "runtime manifest", signal),
    readBoundedRegularFile(join(directory, "files.sha256"), MAX_RUNTIME_FILE_MANIFEST_BYTES, "runtime file manifest", signal),
  ]);
  if (
    sha256(manifestBytes) !== attestation.manifest.sha256 ||
    sha256(fileManifestBytes) !== attestation.tree.filesSha256
  ) {
    throw new Error("Cloned runtime metadata does not match the embedded attestation");
  }
  const manifest = RuntimeManifestSchema.parse(parseJson(manifestBytes, "runtime manifest"));
  assertManifestMatchesAttestation(manifest, attestation);
  const files = parseRuntimeFileManifest(fileManifestBytes, attestation.tree.fileCount, signal);
  const directories = runtimeDirectorySet(files, signal);
  await assertExactRuntimeNamespace(directory, files, directories, signal);

  await chmod(directory, 0o700);
  const shallowestFirst = [...directories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || compareRuntimePaths(left, right);
  });
  for (const path of shallowestFirst) {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    const absolute = join(directory, ...path.split("/"));
    await chmod(absolute, 0o700);
    await assertPlainDirectory(absolute, "cloned runtime directory", signal);
  }

  const filePaths = [
    ...files.map((entry) => entry.path),
    "files.sha256",
    "runtime.json",
  ];
  await mapConcurrentOrdered(filePaths, RUNTIME_FILE_CONCURRENCY, async (path) => {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    const absolute = join(directory, ...path.split("/"));
    await chmod(absolute, isBrowserLauncherPath(absolute) ? 0o700 : 0o600);
    const pathBefore = await requirePlainRegularFile(absolute, "cloned runtime file", signal);
    const handle = await open(absolute, "r");
    try {
      const opened = await handle.stat({ bigint: true });
      assertSameRuntimeFileIdentity(pathBefore, opened, "Cloned runtime file changed before sync");
      if (signal) throwIfRuntimeIntegrityCancelled(signal);
      await handle.sync();
      if (signal) throwIfRuntimeIntegrityCancelled(signal);
      const openedAfter = await handle.stat({ bigint: true });
      const pathAfter = await requirePlainRegularFile(absolute, "cloned runtime file", signal);
      assertSameRuntimeFileIdentity(opened, openedAfter, "Cloned runtime file changed while syncing");
      assertSameRuntimeFileIdentity(opened, pathAfter, "Cloned runtime file path changed while syncing");
    } finally {
      await handle.close().catch(() => undefined);
    }
    return undefined;
  }, signal);
  await syncRuntimeTreeDirectories(directory, directories, signal);
}

async function cleanupAbandonedStaging(stagingRoot: string, signal?: AbortSignal): Promise<void> {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  const entries = await readdir(stagingRoot, { withFileTypes: true });
  const abandoned: string[] = [];
  for (const entry of entries) {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    if (!/^image-[A-Za-z0-9_-]{6,64}$/.test(entry.name)) {
      throw new Error(`Runtime staging contains an unexpected entry: ${entry.name}`);
    }
    const path = join(stagingRoot, entry.name);
    assertContainedPath(stagingRoot, path, "abandoned runtime staging image");
    await assertDisposableStagingTree(path, signal);
    abandoned.push(path);
  }
  for (const path of abandoned) {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    await rm(path, { recursive: true, force: false });
  }
}

async function validateRepairQuarantineTree(path: string, signal?: AbortSignal): Promise<number> {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  await assertPlainDirectory(path, "runtime repair quarantine entry", signal);
  const children = await readdir(path);
  for (const child of children) {
    if (child !== "current.json" && child !== "installed-image") {
      throw new Error("Runtime repair quarantine entry contains an unexpected top-level name");
    }
    await assertDisposableRepairQuarantineEntry(join(path, child), path, signal);
  }
  return children.length;
}

async function assertDisposableRepairQuarantineEntry(
  path: string,
  quarantineDirectory: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  assertContainedPath(quarantineDirectory, path, "runtime repair quarantine content");
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || metadata.isFile()) return;
  if (!metadata.isDirectory()) {
    throw new Error("Runtime repair quarantine contains an unsupported filesystem entry");
  }
  const children = await readdir(path);
  for (const child of children) {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    if (!isSafeRuntimePath(child) || child.includes("/")) {
      throw new Error("Runtime repair quarantine contains an unsafe entry name");
    }
    await assertDisposableRepairQuarantineEntry(join(path, child), quarantineDirectory, signal);
  }
}

async function removeValidatedRepairQuarantineTree(path: string, quarantineRoot: string): Promise<void> {
  assertContainedPath(quarantineRoot, path, "runtime repair quarantine entry");
  await validateRepairQuarantineTree(path);
  await removeRepairQuarantineEntryNoFollow(path, quarantineRoot);
}

async function removeRepairQuarantineEntryNoFollow(path: string, quarantineRoot: string): Promise<void> {
  assertContainedPath(quarantineRoot, path, "runtime repair quarantine content");
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || metadata.isFile()) {
    await unlink(path);
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error("Runtime repair quarantine contains an unsupported filesystem entry");
  }
  const children = await readdir(path);
  for (const child of children) {
    if (!isSafeRuntimePath(child) || child.includes("/")) {
      throw new Error("Runtime repair quarantine contains an unsafe entry name");
    }
    await removeRepairQuarantineEntryNoFollow(join(path, child), quarantineRoot);
  }
  await rmdir(path);
}

async function assertDisposableStagingTree(path: string, signal?: AbortSignal): Promise<void> {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink()) throw new Error(`Runtime staging contains a symbolic link or junction: ${path}`);
  if (metadata.isFile()) {
    if (metadata.nlink !== 1n) throw new Error(`Runtime staging contains a hard-linked file: ${path}`);
    return;
  }
  if (!metadata.isDirectory()) throw new Error(`Runtime staging contains a non-regular entry: ${path}`);
  const children = await readdir(path);
  for (const child of children) {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    if (!isSafeRuntimePath(child)) throw new Error(`Runtime staging contains an unsafe entry: ${child}`);
    await assertDisposableStagingTree(join(path, child), signal);
  }
}

async function assertExactRuntimeNamespace(
  root: string,
  files: readonly RuntimeFileEntry[],
  directories: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<void> {
  const actualFiles: string[] = [];
  const actualDirectories: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareRuntimePaths(left.name, right.name));
    for (const child of children) {
      if (signal) throwIfRuntimeIntegrityCancelled(signal);
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (!isSafeRuntimePath(path)) throw new Error(`Runtime image contains an unsafe path: ${path}`);
      const absolute = join(directory, child.name);
      const metadata = await lstat(absolute, { bigint: true });
      if (metadata.isSymbolicLink()) throw new Error(`Runtime image contains a symbolic link or junction: ${path}`);
      if (metadata.isDirectory()) {
        actualDirectories.push(path);
        await visit(absolute, path);
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1n) throw new Error(`Runtime image contains a hard-linked file: ${path}`);
        actualFiles.push(path);
      } else {
        throw new Error(`Runtime image contains a non-regular entry: ${path}`);
      }
    }
  };
  await visit(root, "");
  const expectedFiles = [...files.map((entry) => entry.path), "files.sha256", "runtime.json"]
    .sort(compareRuntimePaths);
  const expectedDirectories = [...directories].sort(compareRuntimePaths);
  actualFiles.sort(compareRuntimePaths);
  actualDirectories.sort(compareRuntimePaths);
  if (!jsonEqual(actualFiles, expectedFiles) || !jsonEqual(actualDirectories, expectedDirectories)) {
    throw new Error("Runtime image contains missing, extra, or ambiguous filesystem entries");
  }
}

async function createRuntimeDirectories(
  root: string,
  directories: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<void> {
  const ordered = [...directories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || compareRuntimePaths(left, right);
  });
  for (const path of ordered) {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    const absolute = join(root, ...path.split("/"));
    await mkdir(absolute, { recursive: false, mode: 0o700 });
    await assertPlainDirectory(absolute, "runtime staging subdirectory", signal);
  }
}

async function hashRegularFile(
  sourcePath: string,
  expectedSha256: string,
  destinationPath?: string,
  signal?: AbortSignal,
): Promise<{ size: number }> {
  return await retryCtimeRefreshOnce(async () =>
    await hashRegularFileOnce(sourcePath, expectedSha256, destinationPath, signal)
  );
}

async function hashRegularFileOnce(
  sourcePath: string,
  expectedSha256: string,
  destinationPath?: string,
  signal?: AbortSignal,
): Promise<{ size: number }> {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  const pathBefore = await requirePlainRegularFile(sourcePath, "runtime payload file", signal);
  if (pathBefore.size > BigInt(MAX_RUNTIME_FILE_BYTES)) throw new Error(`Runtime payload file exceeds its bound: ${sourcePath}`);
  const source = await open(sourcePath, "r");
  let destination: FileHandle | undefined;
  let destinationCreated = false;
  try {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    const sourceBefore = await source.stat({ bigint: true });
    assertSameRuntimeFileIdentity(pathBefore, sourceBefore, "Runtime payload changed before open");
    if (destinationPath) {
      destination = await open(destinationPath, "wx", 0o600);
      destinationCreated = true;
    }
    const size = Number(sourceBefore.size);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, Math.max(1, size)));
    let position = 0;
    while (position < size) {
      if (signal) throwIfRuntimeIntegrityCancelled(signal);
      const requested = Math.min(buffer.byteLength, size - position);
      const { bytesRead } = await source.read(buffer, 0, requested, position);
      if (signal) throwIfRuntimeIntegrityCancelled(signal);
      if (bytesRead <= 0) throw new Error(`Runtime payload ended early: ${sourcePath}`);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (destination) await writeAll(destination, chunk, signal);
      position += bytesRead;
    }
    if (hash.digest("hex") !== expectedSha256) throw new Error(`Runtime payload digest mismatch: ${sourcePath}`);
    if (destination) {
      if (signal) throwIfRuntimeIntegrityCancelled(signal);
      await destination.sync();
      const target = await destination.stat({ bigint: true });
      if (!target.isFile() || target.nlink !== 1n || target.size !== sourceBefore.size) {
        throw new Error(`Runtime staging file identity is invalid: ${destinationPath}`);
      }
      await destination.close();
      destination = undefined;
      if (process.platform !== "win32" && isBrowserLauncherPath(destinationPath as string)) {
        await chmod(destinationPath as string, 0o700);
      }
      await requirePlainRegularFile(destinationPath as string, "runtime staging file", signal);
    }
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    const sourceAfter = await source.stat({ bigint: true });
    const pathAfter = await requirePlainRegularFile(sourcePath, "runtime payload file", signal);
    assertSameRuntimeFileIdentity(sourceBefore, sourceAfter, "Runtime payload changed while hashing");
    assertSameRuntimeFileIdentity(sourceBefore, pathAfter, "Runtime payload path changed while hashing");
    return { size };
  } catch (error) {
    await destination?.close().catch(() => undefined);
    if (destinationCreated && destinationPath) await rm(destinationPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await source.close().catch(() => undefined);
  }
}

function isBrowserLauncherPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized.endsWith("/bridge/playwright-cli");
}

async function copyAndHashRegularFile(
  source: string,
  destination: string,
  expectedSha256: string,
  expectedSize: number,
  signal?: AbortSignal,
): Promise<void> {
  const result = await hashRegularFile(source, expectedSha256, destination, signal);
  if (result.size !== expectedSize) throw new Error(`Runtime metadata size changed while copying: ${source}`);
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    if (bytesWritten <= 0) throw new Error("Runtime staging write made no progress");
    offset += bytesWritten;
  }
}

async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  return await retryCtimeRefreshOnce(async () =>
    await readBoundedRegularFileOnce(path, maxBytes, label, signal)
  );
}

async function readBoundedRegularFileOnce(
  path: string,
  maxBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  const pathBefore = await requirePlainRegularFile(path, label, signal);
  if (pathBefore.size <= 0n || pathBefore.size > BigInt(maxBytes)) {
    throw new Error(`${label} is empty or exceeds its bounded size`);
  }
  const handle = await open(path, "r");
  try {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    const before = await handle.stat({ bigint: true });
    assertSameRuntimeFileIdentity(pathBefore, before, `${label} changed before open`);
    const bytes = await handle.readFile();
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await requirePlainRegularFile(path, label, signal);
    assertSameRuntimeFileIdentity(before, after, `${label} changed while reading`);
    assertSameRuntimeFileIdentity(before, pathAfter, `${label} path changed while reading`);
    if (bytes.byteLength !== Number(before.size)) throw new Error(`${label} changed size while reading`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function requirePlainRegularFile(path: string, label: string, signal?: AbortSignal): Promise<BigIntStats> {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  const metadata = await lstat(path, { bigint: true });
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1n) {
    throw new Error(`${label} must be one non-linked regular file: ${path}`);
  }
  return metadata;
}

async function assertPlainDirectory(path: string, label: string, signal?: AbortSignal): Promise<void> {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  const metadata = await lstat(path, { bigint: true });
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a plain directory: ${path}`);
  }
}

async function readPlainDirectory(path: string, label: string, signal?: AbortSignal) {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  const entries = await readdir(path, { withFileTypes: true });
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`${label} contains a symbolic link or junction: ${entry.name}`);
  }
  return entries;
}

function assertDirectoryNames(
  entries: Awaited<ReturnType<typeof readPlainDirectory>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = entries.map((entry) => entry.name).sort(compareRuntimePaths);
  const wanted = [...expected].sort(compareRuntimePaths);
  if (!jsonEqual(actual, wanted)) throw new Error(`${label} contains unexpected entries`);
}

function assertManifestMatchesAttestation(
  manifest: RuntimeManifest,
  attestation: EmbeddedRuntimeAttestation,
): void {
  const manifestIdentity = {
    name: manifest.runtime,
    releaseVersion: manifest.release.version,
    runtimeBuildId: manifest.runtimeBuildId,
    platform: manifest.platform,
    arch: manifest.arch,
    libc: manifest.libc,
  };
  if (
    !jsonEqual(manifestIdentity, attestation.runtime) ||
    manifest.sourcesSha256 !== attestation.manifest.sourcesSha256 ||
    manifest.policySha256 !== attestation.manifest.policySha256 ||
    manifest.packageLockSha256 !== attestation.manifest.packageLockSha256 ||
    !jsonEqual(manifest.tree, attestation.tree) ||
    !jsonEqual(manifest.entrypoints, attestation.entrypoints) ||
    !jsonEqual(manifest.browserBridge, {
      protocol: attestation.browserBridge.protocol,
      playwrightCoreVersion: attestation.browserBridge.playwrightCoreVersion,
      engine: attestation.browserBridge.engine,
    }) ||
    attestation.browserBridge.smoke.verified !== true ||
    !jsonEqual(attestation.browserBridge.smoke.operations, [
      "doctor", "open", "snapshot", "find", "click", "eval", "screenshot", "close",
    ]) ||
    !jsonEqual(manifest.daemon, attestation.daemon) ||
    !jsonEqual(manifest.nativeAddons, attestation.nativeAddons)
  ) {
    throw new Error("Runtime manifest identity does not match the embedded attestation");
  }
  const capabilities = manifest.daemon.requiredCapabilities;
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error("Runtime manifest daemon capabilities contain duplicates");
  }
  for (const entrypoint of [
    manifest.entrypoints.module,
    manifest.entrypoints.cli,
    manifest.entrypoints.browserBridge,
    manifest.entrypoints.browserHost,
    manifest.entrypoints.browserLauncher,
    manifest.entrypoints.browserLauncherWindows,
    manifest.entrypoints.browserSkill,
  ]) {
    if (!isSafeRuntimePath(entrypoint)) throw new Error("Runtime manifest contains an unsafe entrypoint");
  }
  const addonPaths = manifest.nativeAddons.map((addon) => windowsFoldPath(addon.path));
  if (new Set(addonPaths).size !== addonPaths.length || manifest.nativeAddons.some((addon) => !isSafeRuntimePath(addon.path))) {
    throw new Error("Runtime manifest native-addon allowlist is ambiguous");
  }
}

function runtimeDirectorySet(files: readonly RuntimeFileEntry[], signal?: AbortSignal): ReadonlySet<string> {
  const result = new Set<string>();
  for (const file of files) {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    const segments = file.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      result.add(segments.slice(0, index).join("/"));
    }
  }
  return result;
}

function runtimeInstallName(attestation: EmbeddedRuntimeAttestation): string {
  return [
    "prime-agent",
    attestation.runtime.releaseVersion,
    attestation.runtime.platform,
    attestation.runtime.arch,
    attestation.tree.sha256.slice(0, 16),
    attestation.manifest.sha256.slice(0, 16),
  ].join("-");
}

function installedPointerFromAttestation(attestation: EmbeddedRuntimeAttestation): InstalledPointer {
  return InstalledPointerSchema.parse({
    schemaVersion: 1,
    assurance: "development-integrity",
    runtime: "prime-agent",
    releaseVersion: attestation.runtime.releaseVersion,
    runtimeBuildId: attestation.runtime.runtimeBuildId,
    platform: attestation.runtime.platform,
    arch: attestation.runtime.arch,
    manifestSha256: attestation.manifest.sha256,
    treeSha256: attestation.tree.sha256,
    filesSha256: attestation.tree.filesSha256,
  });
}

function assertHostRuntime(identity: RuntimeHostIdentity, attestation: EmbeddedRuntimeAttestation): void {
  if (!jsonEqual(identity, attestation.hostRuntime) || identity.kind !== "node") {
    throw new Error("Current host runtime does not match the embedded runtime attestation");
  }
}

function isSafeRuntimePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.startsWith("/") ||
    /[^\x20-\x7e]/.test(value) ||
    /[\\:]/.test(value) ||
    value.normalize("NFC") !== value
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => {
    if (
      segment.length === 0 ||
      segment.length > 255 ||
      segment === "." ||
      segment === ".." ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      WINDOWS_RESERVED_NAME.test(segment) ||
      WINDOWS_SHORT_NAME_PATTERN.test(segment)
    ) {
      return false;
    }
    return true;
  });
}

function windowsFoldPath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function compareRuntimePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** Mirrors the build verifier's sorted depth-first directory traversal. */
function compareRuntimeTraversalPaths(left: string, right: string): number {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const shared = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < shared; index += 1) {
    const compared = compareRuntimePaths(leftSegments[index] as string, rightSegments[index] as string);
    if (compared !== 0) return compared;
  }
  return leftSegments.length - rightSegments.length;
}

function assertContainedPath(root: string, target: string, label: string): void {
  const relation = relative(resolve(root), resolve(target));
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} must be a strict descendant of its configured root`);
  }
}

async function retryCtimeRefreshOnce<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await retryOnceAfterCtimeOnlyIdentityChange(operation);
  } catch (error) {
    if (isCtimeOnlyRuntimeFileIdentityChange(error)) {
      throw new RuntimeIntegrityTransientVerificationError("filesystem_contention", error);
    }
    throw error;
  }
}

async function readOptionalJson<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  try {
    return await readRequiredJson(path, schema, MAX_RUNTIME_POINTER_BYTES, signal);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readRequiredJson<T>(
  path: string,
  schema: z.ZodType<T>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<T> {
  const bytes = await readBoundedRegularFile(path, maxBytes, "runtime JSON state", signal);
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  return schema.parse(parseJson(bytes, "runtime JSON state"));
}

async function entryExists(path: string, signal?: AbortSignal): Promise<boolean> {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  try {
    await lstat(path);
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const parent = await open(resolve(path, ".."), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

async function syncRuntimeTreeDirectories(
  root: string,
  directories: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  if (process.platform === "win32") return;
  const deepestFirst = [...directories].sort((left, right) => {
    const depth = right.split("/").length - left.split("/").length;
    return depth || compareRuntimePaths(left, right);
  });
  for (const path of deepestFirst) {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    await syncDirectory(join(root, ...path.split("/")), signal);
  }
  await syncDirectory(root, signal);
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  await syncParentDirectory(root);
}

async function syncDirectory(path: string, signal?: AbortSignal): Promise<void> {
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  const directory = await open(path, "r");
  try {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    await directory.sync();
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
  } finally {
    await directory.close();
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isTransientRuntimeFilesystemError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (
      "code" in current &&
      typeof current.code === "string" &&
      TRANSIENT_RUNTIME_FILESYSTEM_CODES.has(current.code)
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function errorCodeInChain(error: unknown, expected: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if ("code" in current && current.code === expected) return true;
    current = current.cause;
  }
  return false;
}

function firstErrorCodeInChain(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = current.cause;
  }
  return undefined;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
