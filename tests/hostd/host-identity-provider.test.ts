import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PairingAuthority, type HostIdentityInput } from "../../src/hostd/pairing/authority";
import type {
  HostIdentityKeyProvider,
  HostIdentityProviderLoadResult,
} from "../../src/hostd/pairing/host-identity-provider";
import { HostService, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";
import { PROTOCOL_VERSION, type HealthSnapshot } from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HostService host identity custody readiness", () => {
  it("does not touch a credential provider when durable identity is not configured", async () => {
    const fixture = await serviceFixture({ configuredIdentity: false });

    expect(fixture.provider.loadExisting).not.toHaveBeenCalled();
    expect(fixture.provider.close).not.toHaveBeenCalled();
    const health = await healthSnapshot(fixture.service);
    expect(health.pairingIdentity).toEqual({ state: "not_configured" });
    expect(health.capabilities).not.toContain("relay_pairing_v1");

    await fixture.service.close();
    expect(fixture.provider.close).not.toHaveBeenCalled();
  });

  it("reports ready only after the provider verifies the exact durable identity", async () => {
    const fixture = await serviceFixture({
      loadResult: { status: "ready", identity: identity(1, 0x41) },
    });

    const health = await healthSnapshot(fixture.service);
    expect(health.pairingIdentity).toEqual({
      state: "ready",
      algorithm: "Noise_25519",
      fingerprint: fixture.snapshot.identity?.fingerprint,
      identityEpoch: 1,
    });
    expect(health.capabilities).toContain("snapshot_chunks_v1");
    expect(health.capabilities).not.toContain("relay_pairing_v1");
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("test-secret-ref");
    expect(serialized).not.toContain(identity(1, 0x41).publicKeyB64u);

    await fixture.service.close();
    expect(fixture.provider.close).toHaveBeenCalledOnce();
  });

  it("keeps local health available and fails pairing closed when a credential is missing", async () => {
    const fixture = await serviceFixture({
      loadResult: {
        status: "unavailable",
        code: "credential_missing",
        recoveryAction: "restore_identity",
      },
    });
    const revisionBefore = fixture.snapshot.revision;

    const health = await healthSnapshot(fixture.service);
    expect(health.serviceState).toBe("ready");
    expect(health.pairingIdentity).toEqual({
      state: "unavailable",
      code: "credential_missing",
      recoveryAction: "restore_identity",
    });
    expect((await fixture.authority.getSnapshot()).revision).toBe(revisionBefore);
    expect(health.capabilities).toContain("snapshot_chunks_v1");
    expect(health.capabilities).not.toContain("relay_pairing_v1");
  });

  it("does not replace durable metadata when a provider returns another identity", async () => {
    const fixture = await serviceFixture({
      loadResult: { status: "ready", identity: identity(1, 0x52) },
    });

    const health = await healthSnapshot(fixture.service);
    expect(health.pairingIdentity).toEqual({
      state: "unavailable",
      code: "metadata_mismatch",
      recoveryAction: "review_identity",
    });
    expect((await fixture.authority.getSnapshot()).identity).toEqual(fixture.snapshot.identity);
  });

  it("rejects a provider result bound to another host without touching durable identity", async () => {
    const fixture = await serviceFixture({
      loadResult: { status: "ready", hostId: "other-host", identity: identity(1, 0x41) },
    });

    expect((await healthSnapshot(fixture.service)).pairingIdentity).toEqual({
      state: "unavailable",
      code: "metadata_mismatch",
      recoveryAction: "review_identity",
    });
    expect((await fixture.authority.getSnapshot()).identity).toEqual(fixture.snapshot.identity);
  });

  it("degrades safely when a native adapter returns malformed runtime data", async () => {
    const fixture = await serviceFixture({
      load: async () => null as never,
    });

    const health = await healthSnapshot(fixture.service);
    expect(health.serviceState).toBe("ready");
    expect(health.pairingIdentity).toEqual({
      state: "unavailable",
      code: "provider_error",
      recoveryAction: "restart_host_service",
    });
  });

  it("bounds a nonresponsive provider, aborts it, and exposes no provider error text", async () => {
    let observedSignal: AbortSignal | undefined;
    const fixture = await serviceFixture({
      identityLoadTimeoutMs: 10,
      load: ({ signal }) => {
        observedSignal = signal;
        return new Promise<HostIdentityProviderLoadResult>(() => undefined);
      },
    });

    expect(observedSignal?.aborted).toBe(true);
    const health = await healthSnapshot(fixture.service);
    expect(health.pairingIdentity).toEqual({
      state: "unavailable",
      code: "provider_timeout",
      recoveryAction: "restart_host_service",
    });
    expect(JSON.stringify(health)).not.toMatch(/secretRef|privateKey|timed out/i);
  });
});

async function serviceFixture(options: {
  configuredIdentity?: boolean;
  loadResult?:
    | Exclude<HostIdentityProviderLoadResult, { status: "ready" }>
    | { status: "ready"; hostId?: string; identity: HostIdentityInput };
  load?: HostIdentityKeyProvider["loadExisting"];
  identityLoadTimeoutMs?: number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "prime-host-identity-provider-"));
  temporaryDirectories.push(directory);
  const store = new HostStore(directory);
  await store.initialize({ seed: false });
  const host = await store.getHost();
  const authority = new PairingAuthority(store.paths.pairingAuthority);
  const configuredIdentity = options.configuredIdentity ?? true;
  const snapshot = await authority.initialize({
    hostId: host.hostId,
    ...(configuredIdentity ? { identity: identity(1, 0x41) } : {}),
  });
  const provider: HostIdentityKeyProvider & {
    loadExisting: ReturnType<typeof vi.fn<HostIdentityKeyProvider["loadExisting"]>>;
    close: ReturnType<typeof vi.fn<HostIdentityKeyProvider["close"]>>;
  } = {
    backend: "test-secure-store",
    loadExisting: vi.fn(
      options.load ??
        (async () => {
          const result = options.loadResult ?? {
            status: "unavailable",
            code: "provider_not_installed",
            recoveryAction: "install_provider",
          };
          return result.status === "ready" ? { ...result, hostId: result.hostId ?? host.hostId } : result;
        }),
    ),
    close: vi.fn(() => undefined),
  };
  const service = new HostService(store, undefined, authority, {
    hostIdentityProvider: provider,
    identityLoadTimeoutMs: options.identityLoadTimeoutMs,
  });
  await service.initialize({ seed: false });
  return { service, store, authority, provider, snapshot };
}

async function healthSnapshot(service: HostService): Promise<HealthSnapshot> {
  const response = await service.handle(
    {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "identity-readiness-health",
      method: "health.get",
      payload: {},
    },
    TRUSTED_USER_SESSION,
  );
  if (!response.ok || response.method !== "health.get") throw new Error("health request failed");
  return response.result;
}

function identity(identityEpoch: number, byte: number): HostIdentityInput {
  return {
    identityEpoch,
    algorithm: "Noise_25519",
    publicKeyB64u: Buffer.alloc(32, byte).toString("base64url"),
    secretRef: `test-secret-ref-${identityEpoch}`,
  };
}
