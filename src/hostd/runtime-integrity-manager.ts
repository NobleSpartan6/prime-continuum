import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
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

const MAX_RUNTIME_POINTER_BYTES = 64 * 1024;
const MAX_RUNTIME_MANIFEST_BYTES = 256 * 1024;
const MAX_RUNTIME_FILE_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_FILE_BYTES = 1024 * 1024 * 1024;
const COPY_BUFFER_BYTES = 256 * 1024;
const RUNTIME_FILE_CONCURRENCY = 16;
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
  readonly kind: "electron-run-as-node";
  readonly electronVersion: string;
  readonly nodeVersion: string;
  readonly modulesAbi: string;
  readonly napiVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly runAsNode: true;
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
  /** Absolute path of the identity-checked Electron RunAsNode host. */
  readonly executable: string;
  /** Absolute file URL of the verified Prime Agent module entrypoint. */
  readonly moduleUrl: string;
  /** Absolute path of the verified Prime Agent CLI entrypoint. */
  readonly cliEntrypoint: string;
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
  | "after_pointer_write";

export interface RuntimeIntegrityManagerOptions {
  readonly paths: HostDataPaths;
  readonly attestation: EmbeddedRuntimeAttestation;
  readonly ownershipLease: HostOwnershipLease;
  readonly hostRuntime?: RuntimeHostIdentity;
  readonly faultInjector?: (point: RuntimeIntegrityFaultPoint) => void | Promise<void>;
  readonly writeCurrent?: (path: string, value: InstalledPointer) => Promise<void>;
  readonly onProgress?: (phase: RuntimeIntegrityProgressPhase) => void;
}

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
  private readonly ownershipLease: HostOwnershipLease;
  private readonly faultInjector?: RuntimeIntegrityManagerOptions["faultInjector"];
  private readonly writeCurrent: NonNullable<RuntimeIntegrityManagerOptions["writeCurrent"]>;
  private readonly onProgress?: RuntimeIntegrityManagerOptions["onProgress"];
  private ensurePromise?: Promise<InstalledRuntimeIntegrityIdentity>;
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
    this.faultInjector = options.faultInjector;
    this.writeCurrent = options.writeCurrent ?? ((path, value) => atomicWriteJson(path, value));
    this.onProgress = options.onProgress;
    assertHostRuntime(this.hostRuntime, this.attestation);
    if (this.attestation.assurance !== "development-integrity") {
      throw new Error("The unsigned runtime integrity manager refuses production-authenticated claims");
    }
  }

  ensureInstalled(seedRoot?: string): Promise<InstalledRuntimeIntegrityIdentity> {
    if (this.publicationPoison) return Promise.reject(this.publicationPoison);
    if (this.ensurePromise) return this.ensurePromise;
    const attempt = this.ensureInstalledOnce(seedRoot);
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
      if (error instanceof RuntimeIntegrityCancelledError) throw error;
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
        await verifyRuntimeDirectory(sourceDirectory, this.attestation, stagingDirectory, signal);
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
    return Object.freeze({
      identity,
      executable,
      moduleUrl: pathToFileURL(moduleEntrypoint).href,
      cliEntrypoint,
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
  if (!electronVersion || !nodeVersion || !modulesAbi || !napiVersion || process.env.ELECTRON_RUN_AS_NODE !== "1") {
    throw new Error("Runtime installation requires an exact Electron RunAsNode host");
  }
  return {
    kind: "electron-run-as-node",
    electronVersion,
    nodeVersion,
    modulesAbi,
    napiVersion,
    platform: process.platform,
    arch: process.arch,
    runAsNode: true,
  };
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
  const files = parseRuntimeFileManifest(fileManifestBytes, attestation.tree.fileCount, signal);
  const payloadPaths = new Set(files.map((file) => file.path));
  for (const requiredPath of [
    manifest.entrypoints.module,
    manifest.entrypoints.cli,
    "node_modules/prime-agent/package.json",
  ]) {
    if (!payloadPaths.has(requiredPath)) throw new Error(`Runtime image is missing a required entrypoint file: ${requiredPath}`);
  }
  const expectedDirectories = runtimeDirectorySet(files, signal);
  await assertExactRuntimeNamespace(directory, files, expectedDirectories, signal);

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
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  const pathBefore = await requirePlainRegularFile(sourcePath, "runtime payload file", signal);
  if (pathBefore.size > BigInt(MAX_RUNTIME_FILE_BYTES)) throw new Error(`Runtime payload file exceeds its bound: ${sourcePath}`);
  const source = await open(sourcePath, "r");
  let destination: FileHandle | undefined;
  let destinationCreated = false;
  try {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    const sourceBefore = await source.stat({ bigint: true });
    assertSameFileIdentity(pathBefore, sourceBefore, "Runtime payload changed before open");
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
      await requirePlainRegularFile(destinationPath as string, "runtime staging file", signal);
    }
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    const sourceAfter = await source.stat({ bigint: true });
    const pathAfter = await requirePlainRegularFile(sourcePath, "runtime payload file", signal);
    assertSameFileIdentity(sourceBefore, sourceAfter, "Runtime payload changed while hashing");
    assertSameFileIdentity(sourceBefore, pathAfter, "Runtime payload path changed while hashing");
    return { size };
  } catch (error) {
    await destination?.close().catch(() => undefined);
    if (destinationCreated && destinationPath) await rm(destinationPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await source.close().catch(() => undefined);
  }
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
  if (signal) throwIfRuntimeIntegrityCancelled(signal);
  const pathBefore = await requirePlainRegularFile(path, label, signal);
  if (pathBefore.size <= 0n || pathBefore.size > BigInt(maxBytes)) {
    throw new Error(`${label} is empty or exceeds its bounded size`);
  }
  const handle = await open(path, "r");
  try {
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    const before = await handle.stat({ bigint: true });
    assertSameFileIdentity(pathBefore, before, `${label} changed before open`);
    const bytes = await handle.readFile();
    if (signal) throwIfRuntimeIntegrityCancelled(signal);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await requirePlainRegularFile(path, label, signal);
    assertSameFileIdentity(before, after, `${label} changed while reading`);
    assertSameFileIdentity(before, pathAfter, `${label} path changed while reading`);
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
    !jsonEqual(manifest.daemon, attestation.daemon) ||
    !jsonEqual(manifest.nativeAddons, attestation.nativeAddons)
  ) {
    throw new Error("Runtime manifest identity does not match the embedded attestation");
  }
  const capabilities = manifest.daemon.requiredCapabilities;
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error("Runtime manifest daemon capabilities contain duplicates");
  }
  for (const entrypoint of [manifest.entrypoints.module, manifest.entrypoints.cli]) {
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
  if (!jsonEqual(identity, attestation.hostRuntime) || identity.runAsNode !== true) {
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

function assertSameFileIdentity(left: BigIntStats, right: BigIntStats, message: string): void {
  if (
    !right.isFile() ||
    right.nlink !== 1n ||
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.size !== right.size ||
    left.mtimeNs !== right.mtimeNs ||
    left.ctimeNs !== right.ctimeNs
  ) {
    throw new Error(message);
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
