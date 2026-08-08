import { describe, expect, it, vi } from "vitest";
import {
  HostOwnershipLeaseError,
  type HostOwnershipLease,
} from "../../src/hostd/ownership-lease";
import { getHostDataPaths } from "../../src/hostd/paths";
import type { EmbeddedRuntimeAttestationEnvelope } from "../../src/hostd/runtime-attestation";
import {
  RuntimeInitializationCoordinator,
  type RuntimeIntegrityInstaller,
} from "../../src/hostd/runtime-initialization-coordinator";
import {
  RuntimeIntegrityCancelledError,
  RuntimeIntegrityInstalledCorruptionError,
  RuntimeIntegrityRepairRequiredError,
  RuntimeIntegrityTransientVerificationError,
  type InstalledRuntimeIntegrityIdentity,
  type RuntimeIntegrityManagerOptions,
  type VerifiedInstalledRuntimeHandle,
} from "../../src/hostd/runtime-integrity-manager";

describe("RuntimeInitializationCoordinator", () => {
  it("publishes bounded readiness synchronously and defers all manager work", async () => {
    const scheduled: Array<() => void> = [];
    const install = deferred<InstalledRuntimeIntegrityIdentity>();
    let managerOptions: RuntimeIntegrityManagerOptions | undefined;
    const ensureInstalled = vi.fn(() => install.promise);
    const coordinator = createCoordinator({
      schedule: (work) => scheduled.push(work),
      managerFactory: (options) => {
        managerOptions = options;
        return { ensureInstalled, acquireVerifiedRuntimeHandle: async () => verifiedHandle() };
      },
    });
    const lease = createLease();

    expect(coordinator.start(lease, "C:\\runtime-seed")).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      status: "initializing",
      phase: "preparing",
      attempt: 1,
      trustAnchorId: "8".repeat(64),
      target: { runtimeBuildId: "test-build" },
    });
    expect(managerOptions).toBeUndefined();
    expect(ensureInstalled).not.toHaveBeenCalled();

    scheduled.shift()?.();
    await flushMicrotasks();
    expect(ensureInstalled).toHaveBeenCalledWith("C:\\runtime-seed");
    managerOptions?.onProgress?.("validating_seed");
    expect(coordinator.snapshot()).toMatchObject({
      status: "initializing",
      phase: "validating_seed",
      attempt: 1,
    });

    install.resolve(installedIdentity());
    await flushMicrotasks();
    expect(coordinator.snapshot()).toMatchObject({
      status: "ready",
      assurance: "development-integrity",
      target: { treeSha256: "5".repeat(64) },
    });
    expect(JSON.stringify(coordinator.snapshot())).not.toContain("runtime-seed");
    expect(Object.isFrozen(coordinator.snapshot())).toBe(true);
  });

  it("exposes fresh verified handles only while the owned generation is ready", async () => {
    const scheduled: Array<() => void> = [];
    const acquireVerifiedRuntimeHandle = vi.fn(async () => verifiedHandle());
    const coordinator = createCoordinator({
      schedule: (work) => scheduled.push(work),
      managerFactory: () => ({
        ensureInstalled: async () => installedIdentity(),
        acquireVerifiedRuntimeHandle,
      }),
    });

    await expect(coordinator.acquireVerifiedRuntimeHandle()).rejects.toMatchObject({
      code: "RUNTIME_VERIFIED_HANDLE_UNAVAILABLE",
    });
    coordinator.start(createLease());
    await expect(coordinator.acquireVerifiedRuntimeHandle()).rejects.toMatchObject({
      code: "RUNTIME_VERIFIED_HANDLE_UNAVAILABLE",
    });
    scheduled.shift()?.();
    await flushMicrotasks();

    await expect(coordinator.acquireVerifiedRuntimeHandle()).resolves.toMatchObject({
      identity: installedIdentity(),
    });
    await expect(coordinator.acquireVerifiedRuntimeHandle()).resolves.toMatchObject({
      cliEntrypoint: expect.stringContaining("prime-agent"),
    });
    expect(acquireVerifiedRuntimeHandle).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot().status).toBe("ready");
    expect(JSON.stringify(coordinator.snapshot())).not.toMatch(/Prime Continuim|cli\.js|file:\/\//);
  });

  it("revokes readiness when fresh pre-use verification detects installed-byte drift", async () => {
    const scheduled: Array<() => void> = [];
    const acquireVerifiedRuntimeHandle = vi.fn(async () => {
      throw new RuntimeIntegrityInstalledCorruptionError(new Error("C:\\private\\runtime\\cli.js drifted"));
    });
    const onFailure = vi.fn();
    const coordinator = createCoordinator({
      schedule: (work) => scheduled.push(work),
      managerFactory: () => ({
        ensureInstalled: async () => installedIdentity(),
        acquireVerifiedRuntimeHandle,
      }),
      onFailure,
    });
    coordinator.start(createLease());
    scheduled.shift()?.();
    await flushMicrotasks();

    await expect(coordinator.acquireVerifiedRuntimeHandle()).rejects.toBeInstanceOf(
      RuntimeIntegrityInstalledCorruptionError,
    );
    expect(coordinator.snapshot()).toMatchObject({
      status: "failed",
      code: "RUNTIME_INSTALLED_CORRUPTION",
      retryable: false,
      recoveryAction: "repair_application",
    });
    expect(JSON.stringify(coordinator.snapshot())).not.toMatch(/private|cli\.js|drifted/i);
    expect(onFailure).toHaveBeenCalledOnce();
    await expect(coordinator.acquireVerifiedRuntimeHandle()).rejects.toMatchObject({
      code: "RUNTIME_VERIFIED_HANDLE_UNAVAILABLE",
    });
    expect(acquireVerifiedRuntimeHandle).toHaveBeenCalledOnce();
  });

  it("revokes readiness when final coordinator ownership proof drifts", async () => {
    const scheduled: Array<() => void> = [];
    const lease = createLease();
    let ownershipChecks = 0;
    lease.assertActive = async () => {
      ownershipChecks += 1;
      if (ownershipChecks === 2) {
        throw new HostOwnershipLeaseError(
          "HOST_OWNERSHIP_LOST",
          lease.generation,
          "simulated listener ownership replacement",
        );
      }
    };
    const coordinator = createCoordinator({
      schedule: (work) => scheduled.push(work),
      managerFactory: () => ({
        ensureInstalled: async () => installedIdentity(),
        acquireVerifiedRuntimeHandle: async () => verifiedHandle(),
      }),
    });
    coordinator.start(lease);
    scheduled.shift()?.();
    await flushMicrotasks();
    expect(coordinator.snapshot().status).toBe("ready");

    await expect(coordinator.acquireVerifiedRuntimeHandle()).rejects.toMatchObject({
      code: "HOST_OWNERSHIP_LOST",
    });
    expect(ownershipChecks).toBe(2);
    expect(coordinator.snapshot()).toMatchObject({
      status: "failed",
      code: "RUNTIME_OWNERSHIP_INTERRUPTED",
      retryable: false,
    });
  });

  it("fully re-verifies one explicitly transient failure, then exposes no raw error and fences a manual retry", async () => {
    const scheduled: Array<() => void> = [];
    const attempts = [
      deferred<InstalledRuntimeIntegrityIdentity>(),
      deferred<InstalledRuntimeIntegrityIdentity>(),
      deferred<InstalledRuntimeIntegrityIdentity>(),
    ];
    let call = 0;
    const installer: RuntimeIntegrityInstaller = {
      ensureInstalled: vi.fn(() => attempts[call++]!.promise),
      acquireVerifiedRuntimeHandle: async () => verifiedHandle(),
    };
    let managerOptions: RuntimeIntegrityManagerOptions | undefined;
    const onFailure = vi.fn();
    const coordinator = createCoordinator({
      schedule: (work) => scheduled.push(work),
      managerFactory: (options) => {
        managerOptions = options;
        return installer;
      },
      onFailure,
    });

    coordinator.start(createLease(), "C:\\runtime-seed");
    scheduled.shift()?.();
    await flushMicrotasks();
    attempts[0]!.reject(new RuntimeIntegrityTransientVerificationError(
      "filesystem_contention",
      new Error("C:\\private\\seed failed with secret token"),
    ));
    await flushMicrotasks();
    expect(coordinator.snapshot()).toMatchObject({
      status: "initializing",
      phase: "preparing",
      attempt: 2,
    });
    expect(onFailure).toHaveBeenCalledOnce();

    scheduled.shift()?.();
    await flushMicrotasks();
    managerOptions?.onProgress?.("verifying");
    expect(coordinator.snapshot()).toMatchObject({
      status: "initializing",
      phase: "verifying",
      attempt: 2,
    });
    attempts[1]!.reject(new RuntimeIntegrityTransientVerificationError(
      "filesystem_contention",
      new Error("C:\\private\\seed still failed with secret token"),
    ));
    await flushMicrotasks();
    expect(coordinator.snapshot()).toMatchObject({
      status: "failed",
      code: "RUNTIME_TRANSIENT_VERIFICATION",
      retryable: true,
      recoveryAction: "retry_runtime_verification",
    });
    expect(JSON.stringify(coordinator.snapshot())).not.toMatch(/private|secret|token/i);
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({
      code: "RUNTIME_TRANSIENT_VERIFICATION",
      cause: { message: "C:\\private\\seed failed with secret token" },
    });

    expect(coordinator.retry()).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({ status: "initializing", attempt: 3 });
    scheduled.shift()?.();
    await flushMicrotasks();
    attempts[2]!.resolve(installedIdentity());
    await flushMicrotasks();
    expect(coordinator.snapshot().status).toBe("ready");
    expect(installer.ensureInstalled).toHaveBeenNthCalledWith(1, "C:\\runtime-seed");
    expect(installer.ensureInstalled).toHaveBeenNthCalledWith(2, "C:\\runtime-seed");
    expect(installer.ensureInstalled).toHaveBeenNthCalledWith(3, "C:\\runtime-seed");
  });

  it.each([
    {
      name: "present installed corruption",
      error: new RuntimeIntegrityInstalledCorruptionError(new Error("corrupt final")),
      failure: {
        code: "RUNTIME_INSTALLED_CORRUPTION",
        retryable: false,
        recoveryAction: "repair_application",
      },
    },
    {
      name: "unknown implementation failure",
      error: new Error("unexpected verifier failure"),
      failure: {
        code: "RUNTIME_INTEGRITY_FAILED",
        retryable: true,
        recoveryAction: "retry_runtime_verification",
      },
    },
    {
      name: "runtime cancellation",
      error: new RuntimeIntegrityCancelledError(),
      failure: {
        code: "RUNTIME_OWNERSHIP_INTERRUPTED",
        retryable: false,
        recoveryAction: "restart_host_service",
      },
    },
    {
      name: "unknown coded OS failure",
      error: Object.assign(new Error("runtime read failed"), { code: "EIO" }),
      failure: {
        code: "RUNTIME_INTEGRITY_FAILED",
        retryable: true,
        recoveryAction: "retry_runtime_verification",
      },
    },
    {
      name: "coded OS failure whose wrapper resembles an identity failure",
      error: new Error("host runtime verification failed", {
        cause: Object.assign(new Error("disk read failed"), { code: "EIO" }),
      }),
      failure: {
        code: "RUNTIME_INTEGRITY_FAILED",
        retryable: true,
        recoveryAction: "retry_runtime_verification",
      },
    },
    {
      name: "malformed installed pointer",
      error: new RuntimeIntegrityRepairRequiredError(
        "installed_pointer_invalid",
        new Error("malformed pointer bytes"),
      ),
      failure: {
        code: "RUNTIME_REPAIR_REQUIRED",
        retryable: false,
        recoveryAction: "repair_application",
      },
    },
    {
      name: "absent packaged seed",
      error: new RuntimeIntegrityRepairRequiredError(
        "packaged_seed_unavailable",
        new Error("missing seed bytes"),
      ),
      failure: {
        code: "RUNTIME_REPAIR_REQUIRED",
        retryable: false,
        recoveryAction: "repair_application",
      },
    },
    {
      name: "corrupt or mismatched packaged seed",
      error: new RuntimeIntegrityRepairRequiredError(
        "packaged_seed_invalid",
        new Error("seed digest mismatch"),
      ),
      failure: {
        code: "RUNTIME_REPAIR_REQUIRED",
        retryable: false,
        recoveryAction: "repair_application",
      },
    },
  ])("does not automatically retry $name", async ({ error, failure }) => {
    const scheduled: Array<() => void> = [];
    const ensureInstalled = vi.fn(async () => {
      throw error;
    });
    const coordinator = createCoordinator({
      schedule: (work) => scheduled.push(work),
      managerFactory: () => ({ ensureInstalled, acquireVerifiedRuntimeHandle: async () => verifiedHandle() }),
    });

    coordinator.start(createLease(), "C:\\runtime-seed");
    scheduled.shift()?.();
    await flushMicrotasks();

    expect(ensureInstalled).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(0);
    expect(coordinator.snapshot()).toMatchObject({ status: "failed", ...failure });
  });

  it("fails closed when a returned identity differs from the embedded target", async () => {
    const scheduled: Array<() => void> = [];
    const coordinator = createCoordinator({
      schedule: (work) => scheduled.push(work),
      managerFactory: () => ({
        ensureInstalled: async () => ({ ...installedIdentity(), treeSha256: "f".repeat(64) }),
        acquireVerifiedRuntimeHandle: async () => verifiedHandle(),
      }),
    });
    coordinator.start(createLease());
    scheduled.shift()?.();
    await flushMicrotasks();

    expect(coordinator.snapshot()).toMatchObject({
      status: "failed",
      code: "RUNTIME_IDENTITY_MISMATCH",
      retryable: false,
      recoveryAction: "repair_application",
    });
    expect(coordinator.retry()).toBe(false);
  });

  it("owns manager-construction failures without turning base startup into a rejection", async () => {
    const scheduled: Array<() => void> = [];
    const coordinator = createCoordinator({
      schedule: (work) => scheduled.push(work),
      managerFactory: () => {
        throw new Error("C:\\private\\host runtime tuple drift");
      },
    });

    expect(coordinator.start(createLease(), "C:\\runtime-seed")).toBe(true);
    scheduled.shift()?.();
    await flushMicrotasks();
    expect(coordinator.snapshot()).toMatchObject({
      status: "failed",
      code: "RUNTIME_IDENTITY_MISMATCH",
      retryable: false,
    });
    expect(JSON.stringify(coordinator.snapshot())).not.toMatch(/private|tuple|drift/i);
  });

  it("never publishes ready when the final physical ownership assertion fails", async () => {
    const scheduled: Array<() => void> = [];
    const lease = createLease();
    lease.assertActive = async () => {
      throw new HostOwnershipLeaseError(
        "HOST_OWNERSHIP_LOST",
        lease.generation,
        "simulated listener ownership loss",
      );
    };
    const coordinator = createCoordinator({
      schedule: (work) => scheduled.push(work),
      managerFactory: () => ({
        ensureInstalled: async () => installedIdentity(),
        acquireVerifiedRuntimeHandle: async () => verifiedHandle(),
      }),
    });

    coordinator.start(lease);
    scheduled.shift()?.();
    await flushMicrotasks();
    expect(coordinator.snapshot()).toMatchObject({
      status: "failed",
      code: "RUNTIME_OWNERSHIP_INTERRUPTED",
      retryable: false,
    });
    expect(coordinator.snapshot().status).not.toBe("ready");
  });

  it("waits for active cleanup and suppresses stale success after close", async () => {
    const scheduled: Array<() => void> = [];
    const install = deferred<InstalledRuntimeIntegrityIdentity>();
    const coordinator = createCoordinator({
      schedule: (work) => scheduled.push(work),
      managerFactory: () => ({
        ensureInstalled: () => install.promise,
        acquireVerifiedRuntimeHandle: async () => verifiedHandle(),
      }),
    });
    coordinator.start(createLease());
    scheduled.shift()?.();
    await flushMicrotasks();

    let closed = false;
    const close = coordinator.close().then(() => {
      closed = true;
    });
    await flushMicrotasks();
    expect(closed).toBe(false);
    install.resolve(installedIdentity());
    await close;
    expect(closed).toBe(true);
    expect(coordinator.snapshot().status).toBe("initializing");
    expect(() => coordinator.start(createLease())).toThrow("closed");
  });

  it("keeps the first seed immutable when start is called twice", () => {
    const scheduled: Array<() => void> = [];
    const ensureInstalled = vi.fn(async () => installedIdentity());
    const coordinator = createCoordinator({
      schedule: (work) => scheduled.push(work),
      managerFactory: () => ({ ensureInstalled, acquireVerifiedRuntimeHandle: async () => verifiedHandle() }),
    });
    const lease = createLease();

    expect(coordinator.start(lease, "C:\\first-seed")).toBe(true);
    expect(coordinator.start(createLease("b"), "C:\\replacement-seed")).toBe(false);
    scheduled.shift()?.();
    return flushMicrotasks().then(() => {
      expect(ensureInstalled).toHaveBeenCalledOnce();
      expect(ensureInstalled).toHaveBeenCalledWith("C:\\first-seed");
    });
  });
});

function createCoordinator(
  overrides: Pick<
    ConstructorParameters<typeof RuntimeInitializationCoordinator>[0],
    "schedule" | "managerFactory" | "onFailure"
  >,
): RuntimeInitializationCoordinator {
  let time = Date.parse("2026-08-06T12:00:00.000Z");
  return new RuntimeInitializationCoordinator({
    paths: getHostDataPaths("C:\\prime-continuim-test"),
    envelope: runtimeEnvelope(),
    now: () => new Date(time++),
    ...overrides,
  });
}

function createLease(prefix = "a"): HostOwnershipLease {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    generation: prefix.repeat(64),
    async assertActive() {
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    async withPublicationPermit<T>(publish: () => Promise<T>): Promise<T> {
      return await publish();
    },
    poisonPublication(reason: Error) {
      controller.abort(reason);
    },
  };
}

function runtimeEnvelope(): EmbeddedRuntimeAttestationEnvelope {
  return {
    trustAnchorId: "8".repeat(64),
    attestation: {
      schemaVersion: 1,
      product: "Prime Continuim",
      assurance: "development-integrity",
      runtimePolicySchemaVersion: 1,
      runtime: {
        name: "prime-agent",
        releaseVersion: "0.7.0",
        runtimeBuildId: "test-build",
        platform: "win32",
        arch: "x64",
        libc: "none",
      },
      manifest: {
        relativePath: "installs/test/runtime.json",
        sha256: "1".repeat(64),
        sourcesSha256: "2".repeat(64),
        policySha256: "3".repeat(64),
        packageLockSha256: "4".repeat(64),
      },
      tree: {
        sha256: "5".repeat(64),
        filesSha256: "6".repeat(64),
        fileCount: 3,
        totalBytes: 42,
      },
      entrypoints: {
        module: "node_modules/prime-agent/dist/index.js",
        cli: "node_modules/prime-agent/dist/bundle/cli.js",
      },
      daemon: {
        protocolName: "prime-agent.daemon",
        protocolVersion: 7,
        schemaRevision: 13,
        schemaId: "schema-test",
        requiredCapabilities: ["attach_snapshot"],
      },
      nativeAddons: [{ path: "node_modules/native/addon.node", size: 12, sha256: "7".repeat(64) }],
      hostRuntime: {
        kind: "electron-run-as-node",
        electronVersion: "43.3.0",
        nodeVersion: "24.18.1",
        modulesAbi: "148",
        napiVersion: "10",
        platform: "win32",
        arch: "x64",
        runAsNode: true,
      },
    },
  };
}

function installedIdentity(): InstalledRuntimeIntegrityIdentity {
  return {
    schemaVersion: 1,
    assurance: "development-integrity",
    runtime: "prime-agent",
    releaseVersion: "0.7.0",
    runtimeBuildId: "test-build",
    platform: "win32",
    arch: "x64",
    manifestSha256: "1".repeat(64),
    treeSha256: "5".repeat(64),
    filesSha256: "6".repeat(64),
    hostRuntime: {
      kind: "electron-run-as-node",
      electronVersion: "43.3.0",
      nodeVersion: "24.18.1",
      modulesAbi: "148",
      napiVersion: "10",
      platform: "win32",
      arch: "x64",
      runAsNode: true,
    },
    fileCount: 3,
    totalBytes: 42,
  };
}

function verifiedHandle(
  identity: InstalledRuntimeIntegrityIdentity = installedIdentity(),
): VerifiedInstalledRuntimeHandle {
  return Object.freeze({
    identity,
    executable: "C:\\Prime Continuim\\Prime Continuim.exe",
    moduleUrl: "file:///C:/Prime%20Continuim/runtime/node_modules/prime-agent/dist/index.js",
    cliEntrypoint: "C:\\Prime Continuim\\runtime\\node_modules\\prime-agent\\dist\\bundle\\cli.js",
  }) as unknown as VerifiedInstalledRuntimeHandle;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
