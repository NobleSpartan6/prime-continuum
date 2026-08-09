import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicWriteAmbiguousCommitError, atomicWriteJson } from "../../src/hostd/atomic-files";
import {
  createHostOwnershipLease,
  type HostOwnershipLease,
} from "../../src/hostd/ownership-lease";
import { getHostDataPaths } from "../../src/hostd/paths";
import type { EmbeddedRuntimeAttestation } from "../../src/hostd/runtime-attestation";
import {
  RuntimeIntegrityManager,
  RuntimeIntegrityCancelledError,
  RuntimeIntegrityInstalledCorruptionError,
  RuntimeIntegrityRepairRequiredError,
  RuntimeIntegrityTransientVerificationError,
  parseRuntimeFileManifest,
  type RuntimeIntegrityProgressPhase,
  type RuntimeHostIdentity,
  type RuntimeIntegrityFaultPoint,
} from "../../src/hostd/runtime-integrity-manager";

const temporaryDirectories: string[] = [];
const DIGEST = "a".repeat(64);
const FINAL_VERIFICATION_FAILURES = [
  {
    name: "cancellation",
    createError: () => new RuntimeIntegrityCancelledError(),
  },
  {
    name: "an unknown coded OS failure",
    createError: () => Object.assign(new Error("simulated final read failure"), { code: "EIO" }),
  },
] as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runtime integrity manager", () => {
  it("promotes an exact seed, publishes a path-free pointer, and survives loss of the seed", async () => {
    const fixture = await createFixture();
    const manager = createManager(fixture);

    const installed = await manager.ensureInstalled(fixture.seedRoot);
    expect(installed).toMatchObject({
      assurance: "development-integrity",
      releaseVersion: "0.7.0",
      manifestSha256: fixture.attestation.manifest.sha256,
      treeSha256: fixture.attestation.tree.sha256,
      fileCount: fixture.payloads.length,
    });
    expect(installed).not.toHaveProperty("root");
    expect(installed).not.toHaveProperty("moduleEntrypoint");
    expect(installed).not.toHaveProperty("runtimeManifest");

    const pointer = JSON.parse(await readFile(fixture.paths.runtimeCurrent, "utf8")) as Record<string, unknown>;
    expect(pointer).not.toHaveProperty("path");
    expect(pointer).not.toHaveProperty("runtimeManifest");
    expect(await readdir(fixture.paths.runtimeInstalls)).toEqual([fixture.finalInstallName]);

    await rm(fixture.seedRoot, { recursive: true, force: true });
    await expect(createManager(fixture).ensureInstalled()).resolves.toEqual(installed);
  });

  it("issues a host-only launch handle only after a fresh full-tree verification", async () => {
    const fixture = await createFixture();
    const installed = await createManager(fixture).ensureInstalled(fixture.seedRoot);
    const finalDirectory = join(fixture.paths.runtimeInstalls, fixture.finalInstallName);
    let fullVerifications = 0;
    const verifier = createManager(fixture, {
      faultInjector(point) {
        if (point === "before_final_verify") fullVerifications += 1;
      },
    });

    const first = await verifier.acquireVerifiedRuntimeHandle();
    expect(first.identity).toEqual(installed);
    expect(first.executable).toBe(process.execPath);
    expect(isAbsolute(first.executable)).toBe(true);
    expect(first.moduleUrl).toBe(pathToFileURL(join(
      finalDirectory,
      "node_modules",
      "prime-agent",
      "dist",
      "index.js",
    )).href);
    expect(first.cliEntrypoint).toBe(join(
      finalDirectory,
      "node_modules",
      "prime-agent",
      "dist",
      "bundle",
      "cli.js",
    ));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.identity)).toBe(true);
    expect(JSON.stringify(first.identity)).not.toContain(fixture.root);
    expect(fullVerifications).toBe(1);

    await expect(verifier.acquireVerifiedRuntimeHandle()).resolves.toMatchObject({ identity: installed });
    expect(fullVerifications).toBe(2);

    await writeFile(first.cliEntrypoint, "export const cli = 'tampered';\n");
    await expect(verifier.acquireVerifiedRuntimeHandle()).rejects.toBeInstanceOf(
      RuntimeIntegrityInstalledCorruptionError,
    );
    expect(fullVerifications).toBe(3);
  });

  it("returns no launch handle when ownership drifts after the fresh tree scan", async () => {
    const fixture = await createFixture();
    await createManager(fixture).ensureInstalled(fixture.seedRoot);
    let ownershipChecks = 0;
    const ownershipLease = createTestOwnershipLease(async () => {
      ownershipChecks += 1;
      if (ownershipChecks === 2) throw new Error("simulated post-verification ownership loss");
    });

    await expect(createManager(fixture, { ownershipLease }).acquireVerifiedRuntimeHandle()).rejects.toMatchObject({
      code: "HOST_OWNERSHIP_LOST",
    });
    expect(ownershipChecks).toBe(2);
  });

  it("recreates only a missing attested final when a durable pointer and seed remain", async () => {
    const fixture = await createFixture();
    const installed = await createManager(fixture).ensureInstalled(fixture.seedRoot);
    const finalPath = join(fixture.paths.runtimeInstalls, fixture.finalInstallName);

    await rm(finalPath, { recursive: true });
    await expect(createManager(fixture).ensureInstalled(fixture.seedRoot)).resolves.toEqual(installed);
    expect(await readdir(fixture.paths.runtimeInstalls)).toEqual([fixture.finalInstallName]);

    await rm(finalPath, { recursive: true });
    const recoveryFailure = await createManager(fixture).ensureInstalled().catch((error: unknown) => error);
    expect(recoveryFailure).toBeInstanceOf(RuntimeIntegrityRepairRequiredError);
    expect(recoveryFailure).toMatchObject({ reason: "packaged_seed_unavailable" });
    expect(await readFile(fixture.paths.runtimeCurrent, "utf8")).toContain(fixture.attestation.tree.sha256);
  });

  it("atomically rolls forward and back between exact attested images while retaining both installs", async () => {
    const original = await createFixture("original");
    const replacement = await createFixture("replacement");
    const replacementOnOriginalHost = { ...replacement, paths: original.paths };

    await createManager(original).ensureInstalled(original.seedRoot);
    const rolloverFailure = await createManager(replacementOnOriginalHost)
      .ensureInstalled()
      .catch((error: unknown) => error);
    expect(rolloverFailure).toBeInstanceOf(RuntimeIntegrityRepairRequiredError);
    expect(rolloverFailure).toMatchObject({ reason: "packaged_seed_unavailable" });

    const upgraded = await createManager(replacementOnOriginalHost).ensureInstalled(replacement.seedRoot);
    expect(upgraded.runtimeBuildId).toBe("fixture-build-replacement");
    expect((await readdir(original.paths.runtimeInstalls)).sort()).toEqual(
      [original.finalInstallName, replacement.finalInstallName].sort(),
    );
    expect(await readFile(original.paths.runtimeCurrent, "utf8")).toContain(replacement.attestation.tree.sha256);

    const rolledBack = await createManager(original).ensureInstalled();
    expect(rolledBack.runtimeBuildId).toBe("fixture-build-original");
    expect(await readFile(original.paths.runtimeCurrent, "utf8")).toContain(original.attestation.tree.sha256);

    const rolledForwardAgain = await createManager(replacementOnOriginalHost).ensureInstalled();
    expect(rolledForwardAgain.runtimeBuildId).toBe("fixture-build-replacement");
  });

  it("removes a safe abandoned staging tree before promotion", async () => {
    const fixture = await createFixture();
    const abandoned = join(fixture.paths.runtimeStaging, "image-abcdef");
    await mkdir(abandoned, { recursive: true });
    await writeFile(join(abandoned, "partial.txt"), "incomplete copy");

    await expect(createManager(fixture).ensureInstalled(fixture.seedRoot)).resolves.toMatchObject({
      treeSha256: fixture.attestation.tree.sha256,
    });
    expect(await readdir(fixture.paths.runtimeStaging)).toEqual([]);
  });

  it("rejects an abandoned staging junction without touching its external target", async () => {
    const fixture = await createFixture();
    const external = join(fixture.root, "external-staging-target");
    const sentinel = join(external, "keep.txt");
    await mkdir(fixture.paths.runtimeStaging, { recursive: true });
    await mkdir(external);
    await writeFile(sentinel, "preserve external data");
    await symlink(
      external,
      join(fixture.paths.runtimeStaging, "image-abcdef"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(createManager(fixture).ensureInstalled(fixture.seedRoot)).rejects.toThrow(/symbolic link|junction/i);
    expect(await readFile(sentinel, "utf8")).toBe("preserve external data");
  });

  it("fails closed on an unexpected staging name before deleting a valid abandoned image", async () => {
    const fixture = await createFixture();
    const abandoned = join(fixture.paths.runtimeStaging, "image-abcdef");
    await mkdir(abandoned, { recursive: true });
    await writeFile(join(abandoned, "partial.txt"), "preserve until validation completes");
    await writeFile(join(fixture.paths.runtimeStaging, "unexpected.txt"), "untrusted entry");

    await expect(createManager(fixture).ensureInstalled(fixture.seedRoot)).rejects.toThrow("unexpected entry");
    expect(await readFile(join(abandoned, "partial.txt"), "utf8")).toBe("preserve until validation completes");
  });

  it("rejects tampered metadata and a hard-linked payload", async () => {
    const tampered = await createFixture();
    await writeFile(join(tampered.seedImage, "runtime.json"), "{}\n");
    await expect(createManager(tampered).ensureInstalled(tampered.seedRoot)).rejects.toBeInstanceOf(
      RuntimeIntegrityRepairRequiredError,
    );

    const linked = await createFixture();
    const payload = join(linked.seedImage, ...linked.payloads[0]!.path.split("/"));
    await link(payload, join(linked.root, "outside-hardlink"));
    await expect(createManager(linked).ensureInstalled(linked.seedRoot)).rejects.toBeInstanceOf(
      RuntimeIntegrityRepairRequiredError,
    );
  });

  it("rejects missing, extra, and content-tampered payload files", async () => {
    const missing = await createFixture();
    await rm(join(missing.seedImage, ...missing.payloads[0]!.path.split("/")));
    await expect(createManager(missing).ensureInstalled(missing.seedRoot)).rejects.toBeInstanceOf(
      RuntimeIntegrityRepairRequiredError,
    );

    const extra = await createFixture();
    await writeFile(join(extra.seedImage, "unexpected.txt"), "unexpected");
    await expect(createManager(extra).ensureInstalled(extra.seedRoot)).rejects.toBeInstanceOf(
      RuntimeIntegrityRepairRequiredError,
    );

    const changed = await createFixture();
    await writeFile(join(changed.seedImage, ...changed.payloads[0]!.path.split("/")), "changed-content");
    await expect(createManager(changed).ensureInstalled(changed.seedRoot)).rejects.toBeInstanceOf(
      RuntimeIntegrityRepairRequiredError,
    );
  });

  it("requires repair for an absent packaged seed and malformed or mismatched seed pointer bytes", async () => {
    const absent = await createFixture();
    await rm(absent.seedRoot, { recursive: true, force: true });
    const absentFailure = await createManager(absent)
      .ensureInstalled(absent.seedRoot)
      .catch((error: unknown) => error);
    expect(absentFailure).toBeInstanceOf(RuntimeIntegrityRepairRequiredError);
    expect(absentFailure).toMatchObject({ reason: "packaged_seed_unavailable" });

    const malformed = await createFixture();
    await writeFile(join(malformed.seedRoot, "current.json"), "{not-json\n");
    const malformedFailure = await createManager(malformed)
      .ensureInstalled(malformed.seedRoot)
      .catch((error: unknown) => error);
    expect(malformedFailure).toBeInstanceOf(RuntimeIntegrityRepairRequiredError);
    expect(malformedFailure).toMatchObject({ reason: "packaged_seed_invalid" });

    const mismatched = await createFixture();
    const seedPointerPath = join(mismatched.seedRoot, "current.json");
    const seedPointer = JSON.parse(await readFile(seedPointerPath, "utf8")) as Record<string, unknown>;
    await writeFile(seedPointerPath, `${JSON.stringify({ ...seedPointer, treeSha256: "f".repeat(64) })}\n`);
    const mismatchedFailure = await createManager(mismatched)
      .ensureInstalled(mismatched.seedRoot)
      .catch((error: unknown) => error);
    expect(mismatchedFailure).toBeInstanceOf(RuntimeIntegrityRepairRequiredError);
    expect(mismatchedFailure).toMatchObject({ reason: "packaged_seed_invalid" });
  });

  it("rejects host tuple drift and any unsigned production-authenticated claim", async () => {
    const fixture = await createFixture();
    expect(() => createManager(fixture, {
      hostRuntime: { ...fixture.hostRuntime, nodeVersion: "24.18.2" },
    })).toThrow("host runtime");
    expect(() => new RuntimeIntegrityManager({
      paths: fixture.paths,
      attestation: { ...fixture.attestation, assurance: "production-authenticated" },
      ownershipLease: createTestOwnershipLease(),
      hostRuntime: fixture.hostRuntime,
    })).toThrow("refuses production-authenticated");
  });

  it("rejects a directory junction or symbolic-link replacement", async () => {
    const fixture = await createFixture();
    const nativeDirectory = join(fixture.seedImage, "node_modules", "native");
    const external = join(fixture.root, "external-native");
    const addon = fixture.payloads.find((entry) => entry.path.endsWith("addon.node"));
    if (!addon) throw new Error("fixture addon missing");
    await mkdir(external);
    await writeFile(join(external, "addon.node"), addon.bytes);
    await rm(nativeDirectory, { recursive: true });
    await symlink(external, nativeDirectory, process.platform === "win32" ? "junction" : "dir");

    await expect(createManager(fixture).ensureInstalled(fixture.seedRoot)).rejects.toBeInstanceOf(
      RuntimeIntegrityRepairRequiredError,
    );
  });

  it("leaves no pointer or staging image when copying fails", async () => {
    const fixture = await createFixture();
    const manager = createManager(fixture, {
      faultInjector(point) {
        if (point === "after_copy") throw new Error("simulated copy boundary failure");
      },
    });

    await expect(manager.ensureInstalled(fixture.seedRoot)).rejects.toThrow("simulated copy boundary failure");
    await expect(readFile(fixture.paths.runtimeCurrent)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(fixture.paths.runtimeStaging)).toEqual([]);
    expect(await readdir(fixture.paths.runtimeInstalls)).toEqual([]);
  });

  it("cancels cooperatively with a stable error, phase-only progress, and complete staging cleanup", async () => {
    const fixture = await createFixture();
    const ownership = createHostOwnershipLease(async () => undefined, { generation: "b".repeat(64) });
    const progress = vi.fn((phase: RuntimeIntegrityProgressPhase) => {
      if (phase === "copying") ownership.closeAdmission();
    });
    const manager = createManager(fixture, {
      ownershipLease: ownership.lease,
      onProgress: progress,
    });

    const cancellation = await manager.ensureInstalled(fixture.seedRoot).catch((error: unknown) => error);
    expect(cancellation).toBeInstanceOf(RuntimeIntegrityCancelledError);
    expect(cancellation).toMatchObject({
      name: "RuntimeIntegrityCancelledError",
      code: "RUNTIME_INTEGRITY_CANCELLED",
    });
    expect(progress.mock.calls.every((call) => call.length === 1 && typeof call[0] === "string")).toBe(true);
    expect(progress.mock.calls.map(([phase]) => phase)).toEqual([
      "preparing",
      "verifying",
      "validating_seed",
      "copying",
    ]);
    await expect(readFile(fixture.paths.runtimeCurrent)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(fixture.paths.runtimeStaging)).toEqual([]);
    expect(await readdir(fixture.paths.runtimeInstalls)).toEqual([]);
  });

  it("publishes a new final and its pointer under one ownership permit", async () => {
    const fixture = await createFixture();
    const underlying = createTestOwnershipLease();
    let permits = 0;
    const ownershipLease: HostOwnershipLease = {
      signal: underlying.signal,
      generation: underlying.generation,
      assertActive: () => underlying.assertActive(),
      poisonPublication: (reason) => underlying.poisonPublication(reason),
      withPublicationPermit: async <T>(publish: () => Promise<T>): Promise<T> => {
        permits += 1;
        return await underlying.withPublicationPermit(publish);
      },
    };

    await expect(createManager(fixture, { ownershipLease }).ensureInstalled(fixture.seedRoot)).resolves.toMatchObject({
      treeSha256: fixture.attestation.tree.sha256,
    });
    expect(permits).toBe(1);
    expect(await readdir(fixture.paths.runtimeInstalls)).toEqual([fixture.finalInstallName]);
    expect(await readFile(fixture.paths.runtimeCurrent, "utf8")).toContain(fixture.attestation.tree.sha256);
  });

  it("does not observe cancellation inside an admitted final-and-pointer publication", async () => {
    const fixture = await createFixture();
    const ownership = createHostOwnershipLease(async () => undefined, { generation: "c".repeat(64) });
    const manager = createManager(fixture, {
      ownershipLease: ownership.lease,
      faultInjector(point) {
        if (point === "before_pointer_write") ownership.closeAdmission();
      },
    });

    await expect(manager.ensureInstalled(fixture.seedRoot)).rejects.toMatchObject({
      code: "RUNTIME_INTEGRITY_CANCELLED",
    });
    expect(await readdir(fixture.paths.runtimeStaging)).toEqual([]);
    expect(await readdir(fixture.paths.runtimeInstalls)).toEqual([fixture.finalInstallName]);
    expect(await readFile(fixture.paths.runtimeCurrent, "utf8")).toContain(fixture.attestation.tree.sha256);

    await expect(createManager(fixture).ensureInstalled()).resolves.toMatchObject({
      treeSha256: fixture.attestation.tree.sha256,
    });
  });

  it("keeps deterministic pre-publication writer failures retryable on the same lease", async () => {
    const fixture = await createFixture();
    let failOnce = true;
    const manager = createManager(fixture, {
      writeCurrent: async (path, value) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("transient pointer writer failure");
        }
        await atomicWriteJson(path, value);
      },
    });

    await expect(manager.ensureInstalled(fixture.seedRoot)).rejects.toThrow("transient pointer writer failure");
    await expect(manager.ensureInstalled()).resolves.toMatchObject({
      treeSha256: fixture.attestation.tree.sha256,
    });
  });

  it("single-flights only in-flight work and allows the same manager to retry after failure", async () => {
    const fixture = await createFixture();
    let failOnce = true;
    const manager = createManager(fixture, {
      faultInjector(point) {
        if (point === "after_copy" && failOnce) {
          failOnce = false;
          throw new Error("transient copy boundary failure");
        }
      },
    });

    await expect(manager.ensureInstalled(fixture.seedRoot)).rejects.toThrow("transient copy boundary failure");
    await expect(manager.ensureInstalled(fixture.seedRoot)).resolves.toMatchObject({
      treeSha256: fixture.attestation.tree.sha256,
    });
  });

  it("re-verifies after success on the same manager and exposes an uncached pre-use check", async () => {
    const fixture = await createFixture();
    const manager = createManager(fixture);
    await manager.ensureInstalled(fixture.seedRoot);

    const finalPath = join(fixture.paths.runtimeInstalls, fixture.finalInstallName);
    await writeFile(join(finalPath, ...fixture.payloads[0]!.path.split("/")), "tampered after installation");

    await expect(manager.ensureInstalled()).rejects.toBeInstanceOf(RuntimeIntegrityInstalledCorruptionError);
    await expect(manager.verifyInstalled()).rejects.toBeInstanceOf(RuntimeIntegrityInstalledCorruptionError);
  });

  it.each(FINAL_VERIFICATION_FAILURES)(
    "preserves $name while directly verifying a still-present final",
    async ({ createError }) => {
      const fixture = await createFixture();
      await createManager(fixture).ensureInstalled(fixture.seedRoot);
      const injected = createError();
      const manager = createManager(fixture, {
        faultInjector(point) {
          if (point === "before_final_verify") throw injected;
        },
      });

      const failure = await manager.verifyInstalled().catch((error: unknown) => error);
      expect(failure).toBe(injected);
      expect(failure).not.toBeInstanceOf(RuntimeIntegrityInstalledCorruptionError);
    },
  );

  it.each(FINAL_VERIFICATION_FAILURES)(
    "does not convert $name into a no-seed repair requirement",
    async ({ createError }) => {
      const fixture = await createFixture();
      await createManager(fixture).ensureInstalled(fixture.seedRoot);
      const injected = createError();
      const manager = createManager(fixture, {
        faultInjector(point) {
          if (point === "before_final_verify") throw injected;
        },
      });

      const failure = await manager.ensureInstalled().catch((error: unknown) => error);
      expect(failure).toBe(injected);
      expect(failure).not.toBeInstanceOf(RuntimeIntegrityRepairRequiredError);
    },
  );

  it("recovers a fully verified orphan after an ambiguous final publication", async () => {
    const fixture = await createFixture();
    let ownershipChecks = 0;
    const ownershipLease = createTestOwnershipLease(async () => {
      ownershipChecks += 1;
    });
    const manager = createManager(fixture, {
      ownershipLease,
      faultInjector(point) {
        if (point === "after_final_rename") throw new Error("simulated final publication uncertainty");
      },
    });

    await expect(manager.ensureInstalled(fixture.seedRoot)).rejects.toBeInstanceOf(AtomicWriteAmbiguousCommitError);
    expect(await readdir(fixture.paths.runtimeInstalls)).toEqual([fixture.finalInstallName]);
    await expect(readFile(fixture.paths.runtimeCurrent)).rejects.toMatchObject({ code: "ENOENT" });

    const checksAfterPoison = ownershipChecks;
    await expect(manager.ensureInstalled()).rejects.toMatchObject({
      code: "RUNTIME_INTEGRITY_PUBLICATION_POISONED",
    });
    await expect(createManager(fixture, { ownershipLease }).ensureInstalled()).rejects.toMatchObject({
      code: "HOST_OWNERSHIP_PUBLICATION_POISONED",
    });
    expect(ownershipChecks).toBe(checksAfterPoison);

    await expect(createManager(fixture).ensureInstalled()).resolves.toMatchObject({
      manifestSha256: fixture.attestation.manifest.sha256,
    });
  });

  it("returns no handle after an ambiguous pointer commit and recovers on restart", async () => {
    const fixture = await createFixture();
    let ownershipChecks = 0;
    const ownershipLease = createTestOwnershipLease(async () => {
      ownershipChecks += 1;
    });
    const manager = createManager(fixture, {
      ownershipLease,
      writeCurrent: async (path, value) => {
        await atomicWriteJson(path, value);
        throw new AtomicWriteAmbiguousCommitError(path, new Error("simulated pointer uncertainty"));
      },
    });

    await expect(manager.ensureInstalled(fixture.seedRoot)).rejects.toBeInstanceOf(AtomicWriteAmbiguousCommitError);
    expect(await readdir(fixture.paths.runtimeInstalls)).toEqual([fixture.finalInstallName]);
    expect(await readFile(fixture.paths.runtimeCurrent, "utf8")).toContain(fixture.attestation.tree.sha256);

    const checksAfterPoison = ownershipChecks;
    await expect(manager.ensureInstalled()).rejects.toMatchObject({
      code: "RUNTIME_INTEGRITY_PUBLICATION_POISONED",
    });
    await expect(createManager(fixture, { ownershipLease }).ensureInstalled()).rejects.toMatchObject({
      code: "HOST_OWNERSHIP_PUBLICATION_POISONED",
    });
    expect(ownershipChecks).toBe(checksAfterPoison);

    await expect(createManager(fixture).ensureInstalled()).resolves.toMatchObject({
      treeSha256: fixture.attestation.tree.sha256,
    });
  });

  it("poisons the manager and lease when ownership becomes uncertain after publication", async () => {
    const fixture = await createFixture();
    let ownershipChecks = 0;
    const ownershipLease = createTestOwnershipLease(async () => {
      ownershipChecks += 1;
      if (ownershipChecks === 3) throw new Error("simulated post-publication ownership loss");
    });
    const manager = createManager(fixture, { ownershipLease });

    await expect(manager.ensureInstalled(fixture.seedRoot)).rejects.toMatchObject({
      code: "HOST_OWNERSHIP_PUBLICATION_UNCERTAIN",
    });
    expect(await readdir(fixture.paths.runtimeInstalls)).toEqual([fixture.finalInstallName]);
    expect(await readFile(fixture.paths.runtimeCurrent, "utf8")).toContain(fixture.attestation.tree.sha256);

    const checksAfterPoison = ownershipChecks;
    await expect(manager.verifyInstalled()).rejects.toMatchObject({
      code: "RUNTIME_INTEGRITY_PUBLICATION_POISONED",
    });
    await expect(createManager(fixture, { ownershipLease }).ensureInstalled()).rejects.toMatchObject({
      code: "HOST_OWNERSHIP_PUBLICATION_POISONED",
    });
    expect(ownershipChecks).toBe(checksAfterPoison);

    await expect(createManager(fixture).ensureInstalled()).resolves.toMatchObject({
      treeSha256: fixture.attestation.tree.sha256,
    });
  });

  it("returns no identity when a pointer writer reports success without publishing", async () => {
    const fixture = await createFixture();
    const manager = createManager(fixture, {
      writeCurrent: async () => undefined,
    });

    await expect(manager.ensureInstalled(fixture.seedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(fixture.paths.runtimeInstalls)).toEqual([fixture.finalInstallName]);
  });

  it("never overwrites a corrupt content-addressed final or a corrupt pointer", async () => {
    const corruptFinal = await createFixture();
    await mkdir(corruptFinal.paths.runtimeInstalls, { recursive: true });
    const finalPath = join(corruptFinal.paths.runtimeInstalls, corruptFinal.finalInstallName);
    await mkdir(finalPath);
    await writeFile(join(finalPath, "do-not-overwrite.txt"), "preserve evidence");
    const corruptFinalFailure = await createManager(corruptFinal)
      .ensureInstalled(corruptFinal.seedRoot)
      .catch((error: unknown) => error);
    expect(corruptFinalFailure).toBeInstanceOf(RuntimeIntegrityInstalledCorruptionError);
    expect(corruptFinalFailure).toMatchObject({
      name: "RuntimeIntegrityInstalledCorruptionError",
      code: "RUNTIME_INSTALLED_CORRUPTION",
    });
    expect(await readFile(join(finalPath, "do-not-overwrite.txt"), "utf8")).toBe("preserve evidence");

    const corruptPointer = await createFixture();
    await mkdir(corruptPointer.paths.runtime, { recursive: true });
    await writeFile(corruptPointer.paths.runtimeCurrent, `${JSON.stringify({
      schemaVersion: 1,
      assurance: "development-integrity",
      runtime: "prime-agent",
      releaseVersion: "0.7.0",
      runtimeBuildId: "fixture-build",
      platform: "win32",
      arch: "x64",
      manifestSha256: "not-a-digest",
      treeSha256: corruptPointer.attestation.tree.sha256,
      filesSha256: corruptPointer.attestation.tree.filesSha256,
    })}\n`);
    const corruptPointerFailure = await createManager(corruptPointer)
      .ensureInstalled(corruptPointer.seedRoot)
      .catch((error: unknown) => error);
    expect(corruptPointerFailure).toBeInstanceOf(RuntimeIntegrityRepairRequiredError);
    expect(corruptPointerFailure).toMatchObject({ reason: "installed_pointer_invalid" });
    expect(await readdir(corruptPointer.paths.runtimeInstalls)).toEqual([]);
  });

  it("quarantines only the exact installed runtime target and re-promotes verified seed bytes", async () => {
    const fixture = await createFixture();
    const manager = createManager(fixture);
    await manager.ensureInstalled(fixture.seedRoot);
    const finalPath = join(fixture.paths.runtimeInstalls, fixture.finalInstallName);
    const tamperedPayload = join(finalPath, ...fixture.payloads[0]!.path.split("/"));
    await writeFile(tamperedPayload, "preserve corrupt runtime evidence");
    const unrelatedInstall = join(fixture.paths.runtimeInstalls, "unrelated-install-evidence");
    await mkdir(unrelatedInstall);
    await writeFile(join(unrelatedInstall, "keep.txt"), "keep unrelated runtime evidence");
    await writeFile(fixture.paths.projects, "project data remains untouched");

    await expect(manager.verifyInstalled()).rejects.toBeInstanceOf(RuntimeIntegrityInstalledCorruptionError);
    await expect(manager.repairInstalled(fixture.seedRoot)).resolves.toMatchObject({
      treeSha256: fixture.attestation.tree.sha256,
    });

    const quarantineRoot = join(fixture.paths.runtime, "quarantine");
    const quarantines = await readdir(quarantineRoot);
    expect(quarantines).toHaveLength(1);
    const quarantine = join(quarantineRoot, quarantines[0]!);
    expect(await readFile(join(quarantine, "installed-image", ...fixture.payloads[0]!.path.split("/")), "utf8"))
      .toBe("preserve corrupt runtime evidence");
    expect(await readFile(join(quarantine, "current.json"), "utf8"))
      .toContain(fixture.attestation.tree.sha256);
    expect(await readFile(tamperedPayload)).toEqual(fixture.payloads[0]!.bytes);
    expect(await readFile(join(unrelatedInstall, "keep.txt"), "utf8"))
      .toBe("keep unrelated runtime evidence");
    expect(await readFile(fixture.paths.projects, "utf8")).toBe("project data remains untouched");
  });

  it("repairs a malformed pointer without deleting its evidence", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.paths.runtime, { recursive: true });
    await writeFile(fixture.paths.runtimeCurrent, "{malformed-pointer\n");
    const manager = createManager(fixture);

    await expect(manager.ensureInstalled(fixture.seedRoot)).rejects.toMatchObject({
      code: "RUNTIME_REPAIR_REQUIRED",
      reason: "installed_pointer_invalid",
    });
    await expect(manager.repairInstalled(fixture.seedRoot)).resolves.toMatchObject({
      treeSha256: fixture.attestation.tree.sha256,
    });

    const quarantines = await readdir(join(fixture.paths.runtime, "quarantine"));
    expect(quarantines).toHaveLength(1);
    expect(await readFile(join(fixture.paths.runtime, "quarantine", quarantines[0]!, "current.json"), "utf8"))
      .toBe("{malformed-pointer\n");
    expect(await readFile(fixture.paths.runtimeCurrent, "utf8"))
      .toContain(fixture.attestation.tree.sha256);
  });

  it("fully validates the repair seed before quarantining installed bytes", async () => {
    const fixture = await createFixture();
    await createManager(fixture).ensureInstalled(fixture.seedRoot);
    const finalPath = join(fixture.paths.runtimeInstalls, fixture.finalInstallName);
    const installedPayload = join(finalPath, ...fixture.payloads[0]!.path.split("/"));
    await writeFile(installedPayload, "installed evidence remains in place");
    await writeFile(join(fixture.seedImage, ...fixture.payloads[0]!.path.split("/")), "invalid repair seed");

    await expect(createManager(fixture).repairInstalled(fixture.seedRoot)).rejects.toMatchObject({
      code: "RUNTIME_REPAIR_REQUIRED",
      reason: "packaged_seed_invalid",
    });
    expect(await readFile(installedPayload, "utf8")).toBe("installed evidence remains in place");
    expect(await readFile(fixture.paths.runtimeCurrent, "utf8")).toContain(fixture.attestation.tree.sha256);
    await expect(readdir(join(fixture.paths.runtime, "quarantine"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains at most two exact repair quarantines and resumes pruning after restart", async () => {
    const fixture = await createFixture();
    await createManager(fixture).ensureInstalled(fixture.seedRoot);
    let interruptPrune = true;
    const manager = createManager(fixture, {
      faultInjector(point) {
        if (point === "before_repair_quarantine_prune" && interruptPrune) {
          interruptPrune = false;
          throw new Error("simulated process loss before quarantine pruning");
        }
      },
    });

    await manager.repairInstalled(fixture.seedRoot);
    await manager.repairInstalled(fixture.seedRoot);
    await expect(manager.repairInstalled(fixture.seedRoot)).rejects.toThrow(
      "simulated process loss before quarantine pruning",
    );
    const quarantineRoot = join(fixture.paths.runtime, "quarantine");
    expect(await readdir(quarantineRoot)).toHaveLength(3);
    await expect(createManager(fixture).ensureInstalled()).resolves.toMatchObject({
      treeSha256: fixture.attestation.tree.sha256,
    });
    expect(await readdir(quarantineRoot)).toHaveLength(2);

    await createManager(fixture).repairInstalled(fixture.seedRoot);
    expect(await readdir(quarantineRoot)).toHaveLength(2);
  });

  it("removes empty repair tokens but fails closed on unknown quarantine entries", async () => {
    const fixture = await createFixture();
    await createManager(fixture).ensureInstalled(fixture.seedRoot);
    const quarantineRoot = join(fixture.paths.runtime, "quarantine");
    await mkdir(join(quarantineRoot, "repair-abcdef"), { recursive: true });

    await expect(createManager(fixture).ensureInstalled()).resolves.toMatchObject({
      treeSha256: fixture.attestation.tree.sha256,
    });
    expect(await readdir(quarantineRoot)).toEqual([]);

    await writeFile(join(quarantineRoot, "unknown-evidence.txt"), "do not delete");
    await expect(createManager(fixture).ensureInstalled()).rejects.toThrow("unexpected entry");
    expect(await readFile(join(quarantineRoot, "unknown-evidence.txt"), "utf8")).toBe("do not delete");
  });

  it("types a final that disappears during pre-use verification as transient and fully recovers it", async () => {
    const fixture = await createFixture();
    const finalPath = join(fixture.paths.runtimeInstalls, fixture.finalInstallName);
    let removeAfterPointer = true;
    const manager = createManager(fixture, {
      async faultInjector(point) {
        if (point === "after_pointer_write" && removeAfterPointer) {
          removeAfterPointer = false;
          await rm(finalPath, { recursive: true, force: true });
        }
      },
    });

    await expect(manager.ensureInstalled(fixture.seedRoot)).rejects.toBeInstanceOf(
      RuntimeIntegrityTransientVerificationError,
    );
    await expect(manager.ensureInstalled(fixture.seedRoot)).resolves.toMatchObject({
      runtimeBuildId: fixture.attestation.runtime.runtimeBuildId,
      treeSha256: fixture.attestation.tree.sha256,
    });
  });

  it("rejects a non-canonical mutable path topology at construction", async () => {
    const fixture = await createFixture();
    const unsafePaths = {
      ...fixture.paths,
      runtimeCurrent: join(fixture.root, "outside-current.json"),
    };

    expect(() => new RuntimeIntegrityManager({
      paths: unsafePaths,
      attestation: fixture.attestation,
      ownershipLease: createTestOwnershipLease(),
      hostRuntime: fixture.hostRuntime,
    })).toThrow("path topology is not canonical");
  });

  it("single-flights concurrent promotion in one endpoint owner", async () => {
    const fixture = await createFixture();
    let writes = 0;
    const manager = createManager(fixture, {
      writeCurrent: async (path, value) => {
        writes += 1;
        await atomicWriteJson(path, value);
      },
    });

    const [first, second, third] = await Promise.all([
      manager.ensureInstalled(fixture.seedRoot),
      manager.ensureInstalled(fixture.seedRoot),
      manager.ensureInstalled(fixture.seedRoot),
    ]);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(writes).toBe(1);
  });
});

describe("runtime file-manifest namespace", () => {
  it.each([
    `${DIGEST}  ../escape.js\n`,
    `${DIGEST}  C:/drive.js\n`,
    `${DIGEST}  file.js:stream\n`,
    `${DIGEST}  CON.txt\n`,
    `${DIGEST}  PACKAGE~1/file.js\n`,
    `${DIGEST}  native.dll\n`,
    `${DIGEST}  file.js\n${DIGEST}  file.js/child.js\n`,
    `${DIGEST}  A.js\n${DIGEST}  a.js\n`,
    `${DIGEST}  A/x.js\n${DIGEST}  a/y.js\n`,
  ])("rejects an unsafe or ambiguous Windows namespace", (manifest) => {
    const count = manifest.trimEnd().split("\n").length;
    expect(() => parseRuntimeFileManifest(manifest, count)).toThrow();
  });

  it("requires canonical byte order and a trailing newline", () => {
    expect(() => parseRuntimeFileManifest(`${DIGEST}  z.js\n${DIGEST}  a.js\n`, 2)).toThrow("canonical");
    expect(() => parseRuntimeFileManifest(`${DIGEST}  a.js`, 1)).toThrow("canonical");
  });

  it("rejects native executable payloads now that the runtime has no companion allowlist", () => {
    expect(() => parseRuntimeFileManifest(
      `${DIGEST}  companions/legacy/bin/backend.exe\n`,
      1,
    )).toThrow("unattested native executable");
  });
});

interface Fixture {
  readonly root: string;
  readonly seedRoot: string;
  readonly seedImage: string;
  readonly paths: ReturnType<typeof getHostDataPaths>;
  readonly attestation: EmbeddedRuntimeAttestation;
  readonly hostRuntime: RuntimeHostIdentity;
  readonly finalInstallName: string;
  readonly payloads: readonly { path: string; bytes: Buffer }[];
}

async function createFixture(variant = ""): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "prime-runtime-integrity-"));
  temporaryDirectories.push(root);
  const seedRoot = join(root, "seed");
  const dataRoot = join(root, "data");
  const sourceInstallName = "fixture-image";
  const seedImage = join(seedRoot, "installs", sourceInstallName);
  const payloads = [
    { path: "node_modules/native/addon.node", bytes: Buffer.from(`native-addon-fixture${variant}`) },
    { path: "node_modules/prime-agent/dist/bundle/cli.js", bytes: Buffer.from("export const cli = true;\n") },
    { path: "node_modules/prime-agent/dist/index.js", bytes: Buffer.from("export const api = true;\n") },
    { path: "node_modules/prime-agent/package.json", bytes: Buffer.from('{"name":"prime-agent","version":"0.7.0"}\n') },
  ].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const fileRecords = payloads.map((entry) => ({
    path: entry.path,
    size: entry.bytes.byteLength,
    sha256: sha256(entry.bytes),
  }));
  const filesText = fileRecords.map((entry) => `${entry.sha256}  ${entry.path}\n`).join("");
  const treeText = fileRecords.map((entry) => `${entry.sha256} ${entry.size} ${entry.path}\n`).join("");
  const tree = {
    sha256: sha256(Buffer.from(treeText)),
    filesSha256: sha256(Buffer.from(filesText)),
    fileCount: fileRecords.length,
    totalBytes: fileRecords.reduce((total, entry) => total + entry.size, 0),
  };
  const nativeAddons = fileRecords.filter((entry) => entry.path.endsWith(".node"));
  const manifest = {
    schemaVersion: 1,
    product: "Prime Continuim",
    runtime: "prime-agent",
    release: {
      repository: "https://example.test/prime-agent",
      tag: "v0.7.0",
      version: "0.7.0",
      commit: "fixture",
    },
    runtimeBuildId: variant ? `fixture-build-${variant}` : "fixture-build",
    platform: "win32",
    arch: "x64",
    libc: "none",
    buildRuntime: { node: "22.22.3", modules: "127", napi: "10", npm: "10.9.8" },
    smokeRuntime: { node: "22.22.3", modules: "127", napi: "10", platform: "win32", arch: "x64" },
    sourcesSha256: "1".repeat(64),
    policySha256: "2".repeat(64),
    packageLockSha256: "3".repeat(64),
    installPolicy: {
      ignoreScripts: true,
      omitDev: true,
      omitOptional: true,
      installStrategy: "hoisted",
      targetNativePrebuildsOnly: true,
    },
    entrypoints: {
      module: "node_modules/prime-agent/dist/index.js",
      cli: "node_modules/prime-agent/dist/bundle/cli.js",
    },
    daemon: {
      protocolName: "prime-agent.daemon",
      protocolVersion: 7,
      schemaRevision: 13,
      schemaId: "fixture-schema",
      requiredCapabilities: ["attach_snapshot"],
    },
    sources: [{
      packageName: "prime-agent",
      fileName: "fixture.tgz",
      url: "https://example.test/fixture.tgz",
      size: 10,
      sha256: "4".repeat(64),
      integrity: "sha512-fixture",
    }],
    nativeAddons,
    tree,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const hostRuntime = {
    kind: "electron-run-as-node",
    electronVersion: "43.3.0",
    nodeVersion: "24.18.1",
    modulesAbi: "148",
    napiVersion: "10",
    platform: "win32",
    arch: "x64",
    runAsNode: true,
  } as const;
  const attestation = {
    schemaVersion: 1,
    product: "Prime Continuim",
    assurance: "development-integrity",
    runtimePolicySchemaVersion: 1,
    runtime: {
      name: "prime-agent",
      releaseVersion: "0.7.0",
      runtimeBuildId: manifest.runtimeBuildId,
      platform: "win32",
      arch: "x64",
      libc: "none",
    },
    manifest: {
      relativePath: `installs/${sourceInstallName}/runtime.json`,
      sha256: sha256(manifestBytes),
      sourcesSha256: manifest.sourcesSha256,
      policySha256: manifest.policySha256,
      packageLockSha256: manifest.packageLockSha256,
    },
    tree,
    entrypoints: manifest.entrypoints,
    daemon: manifest.daemon,
    nativeAddons,
    hostRuntime,
  } as const satisfies EmbeddedRuntimeAttestation;
  const finalInstallName = [
    "prime-agent",
    attestation.runtime.releaseVersion,
    attestation.runtime.platform,
    attestation.runtime.arch,
    attestation.tree.sha256.slice(0, 16),
    attestation.manifest.sha256.slice(0, 16),
  ].join("-");

  for (const payload of payloads) {
    const destination = join(seedImage, ...payload.path.split("/"));
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, payload.bytes);
  }
  await writeFile(join(seedImage, "files.sha256"), filesText);
  await writeFile(join(seedImage, "runtime.json"), manifestBytes);
  await writeFile(join(seedRoot, "current.json"), `${JSON.stringify({
    schemaVersion: 1,
    releaseVersion: "0.7.0",
    platform: "win32",
    arch: "x64",
    treeSha256: tree.sha256,
    manifestSha256: attestation.manifest.sha256,
    runtimeManifest: attestation.manifest.relativePath,
  }, null, 2)}\n`);

  return {
    root,
    seedRoot,
    seedImage,
    paths: getHostDataPaths(dataRoot),
    attestation,
    hostRuntime,
    finalInstallName,
    payloads,
  };
}

function createManager(
  fixture: Fixture,
  options: {
    ownershipLease?: HostOwnershipLease;
    faultInjector?: (point: RuntimeIntegrityFaultPoint) => void | Promise<void>;
    writeCurrent?: (path: string, value: Parameters<typeof atomicWriteJson>[1] & Record<string, unknown>) => Promise<void>;
    hostRuntime?: RuntimeHostIdentity;
    onProgress?: (phase: RuntimeIntegrityProgressPhase) => void;
  } = {},
): RuntimeIntegrityManager {
  return new RuntimeIntegrityManager({
    paths: fixture.paths,
    attestation: fixture.attestation,
    ownershipLease: options.ownershipLease ?? createTestOwnershipLease(),
    hostRuntime: options.hostRuntime ?? fixture.hostRuntime,
    faultInjector: options.faultInjector,
    writeCurrent: options.writeCurrent,
    onProgress: options.onProgress,
  });
}

function createTestOwnershipLease(assertOwned: () => Promise<void> = async () => undefined): HostOwnershipLease {
  return createHostOwnershipLease(assertOwned, { generation: "a".repeat(64) }).lease;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
