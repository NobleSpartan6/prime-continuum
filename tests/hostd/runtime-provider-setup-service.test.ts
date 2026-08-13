import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostService, SSH_BRIDGE_SESSION, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";
import {
  PROTOCOL_VERSION,
  RUNTIME_PROVIDER_SETUP_HANDOFF_CAPABILITY,
  type HostIpcRequest,
  type RuntimeIntegritySnapshot,
  type RuntimeModelCatalogSnapshot,
  type RuntimeProviderSetupResult,
} from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];
const RELEASE_VERSION = "0.7.2";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }));
});

describe("HostService Prime Agent provider setup boundary", () => {
  it("advertises setup only to the trusted local transport with an exact ready runtime, catalog, and launcher", async () => {
    const fixture = await temporaryService();
    try {
      expect(await capabilities(fixture.service, TRUSTED_USER_SESSION, "provider-setup-health-local"))
        .toContain(RUNTIME_PROVIDER_SETUP_HANDOFF_CAPABILITY);
      expect(await capabilities(fixture.service, SSH_BRIDGE_SESSION, "provider-setup-health-ssh"))
        .not.toContain(RUNTIME_PROVIDER_SETUP_HANDOFF_CAPABILITY);

      fixture.catalog.capabilityReady.mockResolvedValueOnce(false);
      expect(await capabilities(fixture.service, TRUSTED_USER_SESSION, "provider-setup-health-catalog-unready"))
        .not.toContain(RUNTIME_PROVIDER_SETUP_HANDOFF_CAPABILITY);

      fixture.handoff.capabilityReady.mockResolvedValueOnce(false);
      expect(await capabilities(fixture.service, TRUSTED_USER_SESSION, "provider-setup-health-launcher-unready"))
        .not.toContain(RUNTIME_PROVIDER_SETUP_HANDOFF_CAPABILITY);

      fixture.runtime.snapshot.mockReturnValue(initializingRuntime());
      expect(await capabilities(fixture.service, TRUSTED_USER_SESSION, "provider-setup-health-runtime-unready"))
        .not.toContain(RUNTIME_PROVIDER_SETUP_HANDOFF_CAPABILITY);
    } finally {
      await fixture.service.close();
    }

    const withoutRuntime = await temporaryService({ includeRuntimeIntegrity: false });
    try {
      expect(await capabilities(withoutRuntime.service, TRUSTED_USER_SESSION, "provider-setup-health-runtime-absent"))
        .not.toContain(RUNTIME_PROVIDER_SETUP_HANDOFF_CAPABILITY);
    } finally {
      await withoutRuntime.service.close();
    }
  });

  it("rejects SSH and relay requests before catalog or launcher dispatch", async () => {
    const fixture = await temporaryService();
    try {
      const ssh = await fixture.service.handle(
        providerSetupRequest(fixture.hostId, "anthropic", "provider-setup-ssh"),
        SSH_BRIDGE_SESSION,
      );
      expect(ssh).toMatchObject({
        ok: false,
        error: { code: "REMOTE_PROVIDER_SETUP_FORBIDDEN", retryable: false },
      });

      const relay = await fixture.service.handle(
        providerSetupRequest(fixture.hostId, "anthropic", "provider-setup-relay"),
        {
          transport: "relay",
          channel: { leaseId: "A".repeat(43), channelId: "0".repeat(32) },
        },
      );
      expect(relay).toMatchObject({
        ok: false,
        error: { code: "REMOTE_PROVIDER_SETUP_FORBIDDEN", retryable: false },
      });
      expect(fixture.catalog.invalidate).not.toHaveBeenCalled();
      expect(fixture.catalog.read).not.toHaveBeenCalled();
      expect(fixture.handoff.capabilityReady).not.toHaveBeenCalled();
      expect(fixture.handoff.open).not.toHaveBeenCalled();
    } finally {
      await fixture.service.close();
    }
  });

  it("refreshes the catalog, admits one known unconfigured non-Codex provider, and returns the exact result", async () => {
    const fixture = await temporaryService();
    try {
      const response = await fixture.service.handle(
        providerSetupRequest(fixture.hostId, "anthropic", "provider-setup-open"),
        TRUSTED_USER_SESSION,
      );

      expect(response).toEqual({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "provider-setup-open",
        method: "runtime.provider_setup.open",
        ok: true,
        result: openedResult(fixture.hostId, "anthropic"),
      });
      expect(fixture.catalog.invalidate).toHaveBeenCalledOnce();
      expect(fixture.catalog.read).toHaveBeenCalledOnce();
      expect(fixture.catalog.invalidate.mock.invocationCallOrder[0])
        .toBeLessThan(fixture.catalog.read.mock.invocationCallOrder[0]!);
      expect(fixture.handoff.open).toHaveBeenCalledOnce();
      expect(fixture.handoff.open).toHaveBeenCalledWith({
        expectedHostId: fixture.hostId,
        providerId: "anthropic",
        expectedReleaseVersion: RELEASE_VERSION,
      });
    } finally {
      await fixture.service.close();
    }
  });

  it("rejects configured, unknown, and native-Codex providers without launching", async () => {
    const fixture = await temporaryService();
    try {
      const cases = [
        ["configured-provider", "RUNTIME_PROVIDER_ALREADY_CONFIGURED"],
        ["unknown-provider", "RUNTIME_PROVIDER_UNKNOWN"],
        ["openai-codex", "RUNTIME_PROVIDER_SETUP_NATIVE_OAUTH_REQUIRED"],
      ] as const;

      for (const [providerId, code] of cases) {
        const response = await fixture.service.handle(
          providerSetupRequest(fixture.hostId, providerId, `provider-setup-reject-${providerId}`),
          TRUSTED_USER_SESSION,
        );
        expect(response).toMatchObject({
          ok: false,
          error: { code, retryable: false },
        });
      }

      expect(fixture.catalog.invalidate).toHaveBeenCalledTimes(cases.length);
      expect(fixture.catalog.read).toHaveBeenCalledTimes(cases.length);
      expect(fixture.handoff.open).not.toHaveBeenCalled();
    } finally {
      await fixture.service.close();
    }
  });

  it("rejects a concurrent setup request as BUSY instead of coalescing or opening twice", async () => {
    const release = deferred<RuntimeProviderSetupResult>();
    const fixture = await temporaryService({
      open: async () => await release.promise,
    });
    try {
      const first = fixture.service.handle(
        providerSetupRequest(fixture.hostId, "anthropic", "provider-setup-first"),
        TRUSTED_USER_SESSION,
      );
      await vi.waitFor(() => expect(fixture.handoff.open).toHaveBeenCalledOnce());

      const second = await fixture.service.handle(
        providerSetupRequest(fixture.hostId, "configured-provider", "provider-setup-second"),
        TRUSTED_USER_SESSION,
      );
      expect(second).toMatchObject({
        ok: false,
        error: { code: "RUNTIME_PROVIDER_SETUP_BUSY", retryable: true },
      });
      expect(fixture.handoff.open).toHaveBeenCalledOnce();

      release.resolve(openedResult(fixture.hostId, "anthropic"));
      await expect(first).resolves.toMatchObject({
        ok: true,
        result: openedResult(fixture.hostId, "anthropic"),
      });
    } finally {
      release.resolve(openedResult(fixture.hostId, "anthropic"));
      await fixture.service.close();
    }
  });

  it("closes the handoff and drains an active setup before releasing runtime authority", async () => {
    const release = deferred<RuntimeProviderSetupResult>();
    const events: string[] = [];
    let activeInput: ProviderSetupInput | undefined;
    const fixture = await temporaryService({
      open: async (input) => {
        events.push("open");
        activeInput = input;
        return await release.promise;
      },
      closeHandoff: async () => {
        events.push("handoff.close");
        if (!activeInput) throw new Error("handoff closed before the active request reached the launcher");
        release.resolve(openedResult(activeInput.expectedHostId, activeInput.providerId));
      },
      closeRuntime: async () => {
        events.push("runtime.close");
      },
    });

    const active = fixture.service.handle(
      providerSetupRequest(fixture.hostId, "anthropic", "provider-setup-close-active"),
      TRUSTED_USER_SESSION,
    );
    await vi.waitFor(() => expect(fixture.handoff.open).toHaveBeenCalledOnce());

    const closing = fixture.service.close();
    await expect(closing).resolves.toBeUndefined();
    await expect(active).resolves.toMatchObject({
      ok: true,
      result: openedResult(fixture.hostId, "anthropic"),
    });
    expect(fixture.handoff.close).toHaveBeenCalledOnce();
    expect(fixture.runtime.close).toHaveBeenCalledOnce();
    expect(events).toEqual(["open", "handoff.close", "runtime.close"]);
  });
});

interface ProviderSetupInput {
  readonly expectedHostId: string;
  readonly providerId: string;
  readonly expectedReleaseVersion: string;
}

interface TemporaryServiceOptions {
  readonly includeRuntimeIntegrity?: boolean;
  readonly catalogReady?: boolean;
  readonly handoffReady?: boolean;
  readonly open?: (input: ProviderSetupInput) => Promise<RuntimeProviderSetupResult>;
  readonly closeHandoff?: () => Promise<void>;
  readonly closeRuntime?: () => Promise<void>;
}

async function temporaryService(options: TemporaryServiceOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "prime-provider-setup-service-"));
  temporaryDirectories.push(directory);
  const store = new HostStore(directory);
  await store.initialize();
  const hostId = (await store.getHost()).hostId;
  const runtime = {
    snapshot: vi.fn<() => RuntimeIntegritySnapshot>(() => readyRuntime()),
    close: vi.fn(options.closeRuntime ?? (async () => undefined)),
  };
  const catalog = {
    capabilityReady: vi.fn(async () => options.catalogReady ?? true),
    invalidate: vi.fn(),
    read: vi.fn(async () => modelCatalog()),
  };
  const handoff = {
    capabilityReady: vi.fn(async () => options.handoffReady ?? true),
    open: vi.fn(async (input: ProviderSetupInput) => options.open
      ? await options.open(input)
      : openedResult(input.expectedHostId, input.providerId)),
    close: vi.fn(options.closeHandoff ?? (async () => undefined)),
  };
  const service = new HostService(store, undefined, undefined, {
    ...(options.includeRuntimeIntegrity === false ? {} : { runtimeIntegrityProvider: runtime }),
    runtimeModelCatalogProvider: catalog,
    runtimeProviderSetupHandoff: handoff,
  });
  await service.initialize();
  return { service, store, hostId, runtime, catalog, handoff };
}

async function capabilities(
  service: HostService,
  context: typeof TRUSTED_USER_SESSION | typeof SSH_BRIDGE_SESSION,
  requestId: string,
): Promise<string[]> {
  const response = await service.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method: "health.get",
    payload: {},
  }, context);
  if (!response.ok || response.method !== "health.get") throw new Error("Health request failed");
  return response.result.capabilities;
}

function providerSetupRequest(hostId: string, providerId: string, requestId: string): HostIpcRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method: "runtime.provider_setup.open",
    payload: { expectedHostId: hostId, providerId },
  };
}

function openedResult(expectedHostId: string, providerId: string): RuntimeProviderSetupResult {
  return {
    resultVersion: 1,
    state: "opened",
    expectedHostId,
    providerId,
    releaseVersion: RELEASE_VERSION,
  };
}

function modelCatalog(): RuntimeModelCatalogSnapshot {
  return {
    runtime: "prime_agent",
    releaseVersion: RELEASE_VERSION,
    observedAt: "2026-08-13T12:00:00.000Z",
    providers: [
      {
        providerId: "anthropic",
        displayName: "Anthropic",
        oauthSupported: false,
        configured: false,
        modelCount: 1,
        availableModelCount: 0,
      },
      {
        providerId: "configured-provider",
        displayName: "Configured provider",
        oauthSupported: false,
        configured: true,
        authSource: "stored",
        modelCount: 1,
        availableModelCount: 1,
      },
      {
        providerId: "openai-codex",
        displayName: "ChatGPT Plus/Pro",
        oauthSupported: true,
        configured: false,
        modelCount: 1,
        availableModelCount: 0,
      },
    ],
    models: [],
  };
}

function readyRuntime(): RuntimeIntegritySnapshot {
  return {
    contractVersion: 1,
    changedAt: "2026-08-13T12:00:00.000Z",
    trustAnchorId: DIGEST_A,
    target: {
      runtime: "prime-agent",
      releaseVersion: RELEASE_VERSION,
      runtimeBuildId: "83a0f9f-dirty",
      platform: "darwin",
      arch: "arm64",
      manifestSha256: DIGEST_A,
      treeSha256: DIGEST_B,
      filesSha256: DIGEST_C,
    },
    status: "ready",
    assurance: "development-integrity",
  };
}

function initializingRuntime(): RuntimeIntegritySnapshot {
  const ready = readyRuntime();
  return {
    contractVersion: ready.contractVersion,
    changedAt: ready.changedAt,
    trustAnchorId: ready.trustAnchorId,
    target: ready.target,
    status: "initializing",
    phase: "verifying",
    attempt: 1,
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}
