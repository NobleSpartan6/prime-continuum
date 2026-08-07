import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrimeAgentGateway } from "../../src/hostd/gateway";
import {
  HostService,
  TRUSTED_USER_SESSION,
  type RuntimeIntegrityReadinessProvider,
} from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";
import {
  HealthSnapshotSchema,
  PROTOCOL_VERSION,
  RUNTIME_INTEGRITY_CAPABILITY,
  RuntimeIntegritySnapshotSchema,
  type HealthSnapshot,
  type RuntimeIntegritySnapshot,
} from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runtime integrity health contract", () => {
  it("parses legacy health and unrelated additive capabilities without runtime integrity", () => {
    const legacy = HealthSnapshotSchema.parse({
      ...healthBase(),
      capabilities: ["future_health_signal_v7"],
    });

    expect(legacy.runtimeIntegrity).toBeUndefined();
    expect(legacy.capabilities).toEqual(["future_health_signal_v7"]);
  });

  it("requires the runtime integrity capability if and only if the snapshot is present", () => {
    const runtimeIntegrity = runtimeSnapshot("ready");

    expect(
      HealthSnapshotSchema.safeParse({
        ...healthBase(),
        capabilities: [RUNTIME_INTEGRITY_CAPABILITY],
      }).success,
    ).toBe(false);
    expect(
      HealthSnapshotSchema.safeParse({
        ...healthBase(),
        runtimeIntegrity,
      }).success,
    ).toBe(false);
    expect(
      HealthSnapshotSchema.safeParse({
        ...healthBase(),
        serviceState: "ready",
        capabilities: [RUNTIME_INTEGRITY_CAPABILITY, "future_health_signal_v7"],
        runtimeIntegrity,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["initializing", "ready"],
    ["ready", "degraded"],
    ["failed", "ready"],
    ["unavailable", "starting"],
  ] as const)("rejects %s integrity paired with %s service health", (status, serviceState) => {
    expect(
      HealthSnapshotSchema.safeParse({
        ...healthBase(),
        serviceState,
        capabilities: [RUNTIME_INTEGRITY_CAPABILITY],
        runtimeIntegrity: runtimeSnapshot(status),
      }).success,
    ).toBe(false);
  });

  it("keeps every status bounded and path-free and permits assurance only when ready", () => {
    const initializing = runtimeSnapshot("initializing");

    expect(RuntimeIntegritySnapshotSchema.safeParse(initializing).success).toBe(true);
    expect(RuntimeIntegritySnapshotSchema.safeParse({ ...initializing, attempt: 0 }).success).toBe(false);
    expect(RuntimeIntegritySnapshotSchema.safeParse({ ...initializing, attempt: 33 }).success).toBe(false);
    expect(RuntimeIntegritySnapshotSchema.safeParse({ ...initializing, phase: "loading" }).success).toBe(false);
    expect(RuntimeIntegritySnapshotSchema.safeParse({ ...initializing, assurance: "development-integrity" }).success).toBe(
      false,
    );
    expect(RuntimeIntegritySnapshotSchema.safeParse({ ...initializing, installPath: "C:\\runtime" }).success).toBe(false);
    expect(RuntimeIntegritySnapshotSchema.safeParse({ ...initializing, error: "C:\\private\\runtime failed" }).success).toBe(
      false,
    );
    expect(
      RuntimeIntegritySnapshotSchema.safeParse({
        ...runtimeSnapshot("failed"),
        recoveryAction: "open/C:/private/runtime",
      }).success,
    ).toBe(false);
    expect(
      RuntimeIntegritySnapshotSchema.safeParse({
        ...runtimeSnapshot("ready"),
        trustAnchorId: `sha256:${DIGEST_A}`,
      }).success,
    ).toBe(false);
  });
});

describe("HostService runtime integrity readiness", () => {
  it.each([
    ["initializing", "starting"],
    ["ready", "ready"],
    ["failed", "degraded"],
    ["unavailable", "degraded"],
  ] as const)("maps %s integrity to %s host service health", async (status, expectedServiceState) => {
    const runtimeIntegrity = runtimeSnapshot(status);
    const provider: RuntimeIntegrityReadinessProvider = { snapshot: () => runtimeIntegrity };
    const { service } = await temporaryService(provider);

    const health = await healthSnapshot(service);

    expect(health.serviceState).toBe(expectedServiceState);
    expect(health.capabilities).toEqual(["snapshot_chunks_v1", RUNTIME_INTEGRITY_CAPABILITY]);
    expect(health.runtimeIntegrity).toEqual(runtimeIntegrity);
    await service.close();
  });

  it("preserves legacy service health when no provider is installed", async () => {
    const { service } = await temporaryService();

    const health = await healthSnapshot(service);

    expect(health.serviceState).toBe("ready");
    expect(health.runtimeIntegrity).toBeUndefined();
    expect(health.capabilities).not.toContain(RUNTIME_INTEGRITY_CAPABILITY);
    await service.close();
  });

  it("waits for runtime integrity shutdown and closes other resources even when it fails", async () => {
    let settleProviderClose: ((reason?: Error) => void) | undefined;
    const providerClose = new Promise<void>((resolve, reject) => {
      settleProviderClose = (reason) => (reason ? reject(reason) : resolve());
    });
    const provider: RuntimeIntegrityReadinessProvider = {
      snapshot: () => runtimeSnapshot("initializing"),
      close: vi.fn(() => providerClose),
    };
    const gateway = unavailableGateway();
    const { service } = await temporaryService(provider, gateway);

    let settled = false;
    const serviceClose = service.close();
    expect(service.close()).toBe(serviceClose);
    const closing = serviceClose.finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(provider.close).toHaveBeenCalledOnce());
    expect(gateway.close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    settleProviderClose?.(new Error("synthetic close failure"));
    await expect(closing).rejects.toThrow("One or more host service resources failed to close");
    expect(settled).toBe(true);
    expect(gateway.close).toHaveBeenCalledOnce();
  });
});

function runtimeSnapshot(status: RuntimeIntegritySnapshot["status"]): RuntimeIntegritySnapshot {
  const base = {
    contractVersion: 1 as const,
    changedAt: "2026-08-06T00:00:01.000Z",
    trustAnchorId: DIGEST_A,
    target: {
      runtime: "prime-agent" as const,
      releaseVersion: "0.7.0",
      runtimeBuildId: "fixture-build-1",
      platform: "win32",
      arch: "x64",
      manifestSha256: DIGEST_A,
      treeSha256: DIGEST_B,
      filesSha256: DIGEST_C,
    },
  };
  switch (status) {
    case "initializing":
      return { ...base, status, phase: "preparing", attempt: 1 };
    case "ready":
      return { ...base, status, assurance: "development-integrity" };
    case "failed":
      return {
        ...base,
        status,
        code: "RUNTIME_INTEGRITY_FAILED",
        retryable: true,
        recoveryAction: "retry_runtime_initialization",
      };
    case "unavailable":
      return {
        ...base,
        status,
        code: "RUNTIME_INTEGRITY_UNAVAILABLE",
        retryable: false,
        recoveryAction: "reinstall_application",
      };
  }
}

function healthBase(): Omit<HealthSnapshot, "runtimeIntegrity"> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    hostdVersion: "0.1.0",
    startedAt: "2026-08-06T00:00:00.000Z",
    checkedAt: "2026-08-06T00:00:01.000Z",
    serviceState: "ready",
    host: {
      hostId: "host-1",
      displayName: "Local computer",
      kind: "local",
      connectionPaths: [],
      reachability: "online",
      compatibility: "compatible",
      platform: { os: "windows", architecture: "x64" },
      attentionCounts: { total: 0, unread: 0, questions: 0, approvals: 0 },
    },
    capabilities: [],
  };
}

async function temporaryService(
  runtimeIntegrityProvider?: RuntimeIntegrityReadinessProvider,
  gateway?: PrimeAgentGateway,
): Promise<{ service: HostService; store: HostStore }> {
  const directory = await mkdtemp(join(tmpdir(), "prime-hostd-runtime-health-test-"));
  temporaryDirectories.push(directory);
  const store = new HostStore(directory);
  const service = new HostService(store, gateway, undefined, { runtimeIntegrityProvider });
  await service.initialize({ seed: true });
  return { service, store };
}

async function healthSnapshot(service: HostService): Promise<HealthSnapshot> {
  const response = await service.handle(
    {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "runtime-integrity-health",
      method: "health.get",
      payload: {},
    },
    TRUSTED_USER_SESSION,
  );
  if (!response.ok || response.method !== "health.get") throw new Error("health request failed");
  return response.result;
}

function unavailableGateway(): PrimeAgentGateway & { close: ReturnType<typeof vi.fn> } {
  return {
    continuity: "unavailable",
    isLive: vi.fn(async () => false),
    submit: vi.fn(async () => {
      throw new Error("unavailable");
    }),
    close: vi.fn(async () => undefined),
  };
}
