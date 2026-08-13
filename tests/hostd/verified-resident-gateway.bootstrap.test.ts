import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrimeAgentGateway, PrimeAgentProjectionChange } from "../../src/hostd/gateway";
import type {
  PrimeAgentPublicModuleLoader,
  PrimeAgentResidentAdapterOptions,
  ResidentOwnedRuntimeCandidate,
} from "../../src/hostd/prime-agent-resident-adapter";
import type { ResidentProjectionSnapshot } from "../../src/hostd/resident-projection";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  ResidentRuntimeContractError,
  type ResidentAbortIdleAuthorityEvidence,
  type ResidentEndAcknowledgement,
  type ResidentEndReconciliationEvidence,
  type ResidentOwnedSessionCreateInput,
  type ResidentRuntimeConnection,
  type ResidentPromptIdleAuthorityEvidence,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import type { VerifiedInstalledRuntimeHandle } from "../../src/hostd/runtime-integrity-manager";
import type { VerifiedRuntimeHandleProvider } from "../../src/hostd/runtime-model-catalog";
import {
  residentDispatchAuthorityFingerprint,
  type HostStore,
  ResidentAbortReconciliationLease,
  ResidentPromptReconciliationLease,
  type ResidentKillLease,
} from "../../src/hostd/store";
import {
  VerifiedResidentGateway,
  residentDaemonEndpoint,
  residentDaemonWorkingDirectory,
  type VerifiedBrowserReadinessProbeInput,
} from "../../src/hostd/verified-resident-gateway";
import { canonicalTemporaryDirectory } from "../helpers/canonical-temp";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("VerifiedResidentGateway bootstrap gates", () => {
  it("keeps capability off and never constructs an adapter for an empty durable binding set", async () => {
    const fixture = await gatewayFixture([]);

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    expect(fixture.runtimeHandles.acquireVerifiedRuntimeHandle).not.toHaveBeenCalled();
    expect(fixture.adapterFactory).not.toHaveBeenCalled();

    await fixture.gateway.close();
  });

  it("withdraws resident execution and lifecycle readiness when the shared custody proof drifts", async () => {
    const durableBinding = binding("thread-secure", "execution-secure", "active-secure");
    let secure = true;
    const credentialSecurity = {
      prepareAndVerify: vi.fn(async () => undefined),
      assertStillSecure: vi.fn(async () => {
        if (!secure) throw new Error("simulated custody drift");
      }),
    };
    const fixture = await gatewayFixture([durableBinding], {}, { credentialSecurity });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));
    await expect(fixture.gateway.residentLifecycleCapabilityReady()).resolves.toBe(false);
    await vi.waitFor(async () => expect(await fixture.gateway.residentLifecycleCapabilityReady()).toBe(true));

    secure = false;
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await expect(fixture.gateway.residentLifecycleCapabilityReady()).resolves.toBe(false);
    await expect(fixture.gateway.isLive("thread-secure", "execution-secure")).resolves.toBe(false);

    await fixture.gateway.close();
  });

  it("proves lifecycle composition with zero bindings without advertising command readiness", async () => {
    const fixture = await gatewayFixture([]);

    await expect(fixture.gateway.residentLifecycleCapabilityReady()).resolves.toBe(false);
    await vi.waitFor(async () => expect(await fixture.gateway.residentLifecycleCapabilityReady()).toBe(true));
    expect(fixture.runtimeHandles.acquireVerifiedRuntimeHandle).toHaveBeenCalledOnce();
    expect(fixture.adapterFactory).toHaveBeenCalledOnce();
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    expect(fixture.adapter.attachResident).not.toHaveBeenCalled();

    await fixture.gateway.close();
    await expect(fixture.gateway.residentLifecycleCapabilityReady()).resolves.toBe(false);
  });

  it("fails zero-binding lifecycle readiness when the cached Worker module preflight rejects", async () => {
    const moduleLoad = deferred<unknown>();
    const moduleLoader = Object.assign(
      vi.fn(() => moduleLoad.promise),
      { close: vi.fn(async () => undefined) },
    );
    const moduleLoaderFactory = vi.fn(() => moduleLoader);
    const fixture = await gatewayFixture([], {}, { moduleLoaderFactory });

    const firstReadiness = fixture.gateway.residentLifecycleCapabilityReady();
    const concurrentReadiness = fixture.gateway.residentLifecycleCapabilityReady();
    await expect(Promise.all([firstReadiness, concurrentReadiness])).resolves.toEqual([false, false]);
    await vi.waitFor(() => expect(moduleLoader).toHaveBeenCalledOnce());
    expect(fixture.adapterFactory).not.toHaveBeenCalled();

    moduleLoad.reject(new Error("verified Worker import failed"));
    await vi.waitFor(() => expect(moduleLoader.close).toHaveBeenCalledOnce());
    await expect(fixture.gateway.residentLifecycleCapabilityReady()).resolves.toBe(false);
    expect(fixture.runtimeHandles.acquireVerifiedRuntimeHandle).toHaveBeenCalledOnce();
    expect(moduleLoaderFactory).toHaveBeenCalledOnce();
    expect(moduleLoader).toHaveBeenCalledOnce();
    expect(moduleLoader.close).toHaveBeenCalledOnce();
    expect(fixture.adapterFactory).not.toHaveBeenCalled();

    await fixture.gateway.close();
  });

  it("returns false without waiting for first attachment and becomes ready only after it settles", async () => {
    const durableBinding = binding("thread-a", "execution-a", "active-a");
    const attachment = deferred<ResidentRuntimeConnection>();
    const fixture = await gatewayFixture([durableBinding], {
      attachResident: vi.fn(() => attachment.promise),
    });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(fixture.adapter.attachResident).toHaveBeenCalledOnce());
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);

    attachment.resolve(connectionFor(durableBinding));
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));
    expect(fixture.adapter.attachResident).toHaveBeenCalledWith(durableBinding);

    await fixture.gateway.close();
  });

  it("attaches every exact durable binding before advertising readiness", async () => {
    const bindings = [
      binding("thread-a", "execution-a", "active-a"),
      binding("thread-b", "execution-b", "active-b"),
      binding("thread-c", "execution-c", "active-c"),
    ];
    const attached: ResidentSessionBinding[] = [];
    const fixture = await gatewayFixture(bindings, {
      attachResident: vi.fn(async (candidate: ResidentSessionBinding) => {
        attached.push(candidate);
        return connectionFor(candidate);
      }),
    });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(fixture.adapter.attachResident).toHaveBeenCalledTimes(bindings.length));
    expect(attached).toEqual(bindings);
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));

    await fixture.gateway.close();
  });

  it("becomes ready when attach refreshes only supervisor metadata and capability order", async () => {
    const original = binding("thread-a", "execution-a", "active-a");
    let fixture!: Awaited<ReturnType<typeof gatewayFixture>>;
    fixture = await gatewayFixture([original], {
      attachResident: vi.fn(async (candidate: ResidentSessionBinding) => {
        const refreshed: ResidentSessionBinding = {
          ...candidate,
          runtime: {
            ...candidate.runtime,
            capabilities: [...candidate.runtime.capabilities].reverse(),
            supervisorGeneration: "supervisor-refreshed-during-attach",
          },
        };
        fixture.setBindings([refreshed]);
        return connectionFor(refreshed);
      }),
    });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(fixture.adapter.attachResident).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));

    const reorderedAgain: ResidentSessionBinding = {
      ...original,
      runtime: {
        ...original.runtime,
        capabilities: [...original.runtime.capabilities],
        supervisorGeneration: "supervisor-refreshed-again",
      },
    };
    fixture.setBindings([reorderedAgain]);
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(true);
    await expect(fixture.gateway.isLive("thread-a", "execution-a")).resolves.toBe(true);
    expect(fixture.adapter.attachResident).toHaveBeenCalledOnce();

    await fixture.gateway.close();
  });

  it("drops readiness when a stable resident authority field changes", async () => {
    const original = binding("thread-a", "execution-a", "active-a");
    const fixture = await gatewayFixture([original]);
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));
    expect(fixture.adapter.attachResident).toHaveBeenCalledOnce();

    fixture.setBindings([{
      ...original,
      activeSessionId: "active-replacement",
      sessionId: "session-replacement",
    }]);
    await expect(fixture.gateway.isLive("thread-a", "execution-a")).resolves.toBe(false);
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(fixture.adapter.attachResident).toHaveBeenCalledTimes(2));

    await fixture.gateway.close();
  });

  it("keeps a healthy binding command-capable when an unrelated durable binding is missing", async () => {
    const bindings = [
      binding("thread-a", "execution-a", "active-a"),
      binding("thread-b", "execution-b", "active-b"),
    ];
    const fixture = await gatewayFixture(bindings, {
      attachResident: vi.fn(async (candidate: ResidentSessionBinding) => {
        if (candidate.threadId === "thread-b") {
          throw new ResidentRuntimeContractError(
            "PRIME_RUNTIME_SESSION_NOT_FOUND",
            "resident worker unavailable",
          );
        }
        return connectionFor(candidate);
      }),
    });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(fixture.adapter.attachResident).toHaveBeenCalledTimes(2));
    await expect(fixture.gateway.isLive("thread-a", "execution-a")).resolves.toBe(true);
    await expect(fixture.gateway.isLive("thread-b", "execution-b")).resolves.toBe(false);
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(true);
    await expect(fixture.gateway.submit(modelCommand("thread-a", "execution-a"), {
      residentBinding: bindings[0],
    })).resolves.toMatchObject({ disposition: "accepted" });
    expect(fixture.adapter.submit).toHaveBeenCalledOnce();

    await fixture.gateway.close();
  });

  it("keeps a new attachment unready until its exact projection publishes asynchronously", async () => {
    const durableBinding = binding("thread-a", "execution-a", "active-a");
    const fixture = await gatewayFixture([durableBinding], {}, {
      autoProjectBindings: false,
      projectedBindings: [],
      publishOnAttach: false,
    });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(fixture.adapter.attachResident).toHaveBeenCalledOnce());
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await expect(fixture.gateway.isLive("thread-a", "execution-a")).resolves.toBe(false);
    expect(fixture.adapter.attachResident).toHaveBeenCalledOnce();
    expect(fixture.store.hasExactResidentProjection).not.toHaveBeenCalled();

    await fixture.adapterOptions.publishProjection(durableBinding, {} as never);
    await vi.waitFor(() => expect(fixture.store.hasExactResidentProjection).toHaveBeenCalled());
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(true);
    await expect(fixture.gateway.isLive("thread-a", "execution-a")).resolves.toBe(true);

    await fixture.gateway.close();
  });

  it("does not prepare from an exact durable projection that predates this attachment", async () => {
    const durableBinding = binding("thread-a", "execution-a", "active-a");
    const fixture = await gatewayFixture([durableBinding], {}, {
      autoProjectBindings: false,
      projectedBindings: [durableBinding],
      publishOnAttach: false,
    });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(fixture.adapter.attachResident).toHaveBeenCalledOnce());
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await expect(fixture.gateway.isLive("thread-a", "execution-a")).resolves.toBe(false);
    expect(fixture.store.hasExactResidentProjection).not.toHaveBeenCalled();

    await fixture.gateway.close();
  });

  it("prepares when attach publishes a fresh exact projection before returning", async () => {
    const durableBinding = binding("thread-a", "execution-a", "active-a");
    const fixture = await gatewayFixture([durableBinding]);

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(fixture.store.publishResidentProjectionSnapshot).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));
    await expect(fixture.gateway.isLive("thread-a", "execution-a")).resolves.toBe(true);

    await fixture.gateway.close();
  });

  it("routes a proven model projection through the exact command-scoped Store boundary", async () => {
    const durableBinding = binding("thread-a", "execution-a", "active-a");
    const command = modelCommand("thread-a", "execution-a");
    const fixture = await gatewayFixture([durableBinding]);
    const changes: PrimeAgentProjectionChange[] = [];
    const unsubscribe = fixture.gateway.subscribeProjectionChanges((change) => changes.push(change));

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));
    vi.mocked(fixture.store.publishResidentProjectionSnapshot).mockClear();

    const projection = { runtime: { model: "openai/gpt-5" } } as unknown as ResidentProjectionSnapshot;
    await fixture.adapterOptions.publishModelSelectionProjection(command, durableBinding, projection);

    expect(fixture.store.publishResidentModelSelectionProjection).toHaveBeenCalledOnce();
    expect(fixture.store.publishResidentModelSelectionProjection).toHaveBeenCalledWith(
      command,
      durableBinding,
      projection,
    );
    expect(fixture.store.publishResidentProjectionSnapshot).not.toHaveBeenCalled();
    expect(changes).toContainEqual({ threadId: "thread-a", executionGenerationId: "execution-a" });
    unsubscribe();
    await fixture.gateway.close();
  });

  it("publishes an immediate live-only invalidation without persisting dialog state", async () => {
    const durableBinding = binding("thread-dialog", "execution-dialog", "active-dialog");
    const fixture = await gatewayFixture([durableBinding]);
    const changes: PrimeAgentProjectionChange[] = [];
    const unsubscribe = fixture.gateway.subscribeProjectionChanges((change) => changes.push(change));

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));
    vi.mocked(fixture.store.publishResidentProjectionSnapshot).mockClear();

    fixture.adapterOptions.publishEphemeralProjectionChange?.(durableBinding);

    expect(changes).toContainEqual({
      threadId: "thread-dialog",
      executionGenerationId: "execution-dialog",
    });
    expect(fixture.store.publishResidentProjectionSnapshot).not.toHaveBeenCalled();
    unsubscribe();
    await fixture.gateway.close();
  });

  it("proves only the exact prepared binding without retiring a healthy replacement", async () => {
    const current = binding("thread-a", "execution-a", "active-current");
    const stale = {
      ...current,
      activeSessionId: "active-stale",
      sessionId: "session-stale",
    };
    const fixture = await gatewayFixture([current]);
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));

    await expect(fixture.gateway.isResidentBindingLive(stale)).resolves.toBe(false);
    await expect(fixture.gateway.isResidentBindingLive(current)).resolves.toBe(true);
    expect(fixture.adapter.attachResident).toHaveBeenCalledOnce();
    expect(fixture.adapter.isLive).toHaveBeenCalledOnce();

    await fixture.gateway.close();
  });

  it("detaches a returned connection when post-attach readiness setup throws", async () => {
    const durableBinding = binding("thread-a", "execution-a", "active-a");
    const detach = vi.fn(async () => undefined);
    const fixture = await gatewayFixture([durableBinding], {
      attachResident: vi.fn(async () => ({
        binding: durableBinding,
        detach,
      }) as unknown as ResidentRuntimeConnection),
    });
    vi.mocked(fixture.store.hasExactResidentProjection).mockImplementation(() => {
      throw new Error("projection readiness query failed synchronously");
    });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
    expect(fixture.adapter.attachResident).toHaveBeenCalledOnce();
    await expect(fixture.gateway.isLive("thread-a", "execution-a")).resolves.toBe(false);

    await fixture.gateway.close();
  });

  it("does not accept a stale prior projection from a different active session", async () => {
    const stale = binding("thread-a", "execution-a", "active-stale");
    const current = {
      ...stale,
      activeSessionId: "active-current",
      sessionId: "session-current",
    };
    const fixture = await gatewayFixture([current], {}, {
      autoProjectBindings: false,
      projectedBindings: [stale],
      publishOnAttach: false,
    });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(fixture.adapter.attachResident).toHaveBeenCalledOnce());
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await expect(fixture.gateway.isLive("thread-a", "execution-a")).resolves.toBe(false);
    expect(fixture.store.hasExactResidentProjection).not.toHaveBeenCalled();
    expect(fixture.adapter.isLive).not.toHaveBeenCalled();

    await fixture.gateway.close();
  });

  it("keeps projected A ready while attached B is still waiting for its first projection", async () => {
    const bindingA = binding("thread-a", "execution-a", "active-a");
    const bindingB = binding("thread-b", "execution-b", "active-b");
    const fixture = await gatewayFixture([bindingA, bindingB], {}, {
      autoProjectBindings: false,
      projectedBindings: [bindingA],
      publishOnAttach: (candidate) => candidate.threadId === bindingA.threadId,
    });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(fixture.adapter.attachResident).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));
    await expect(fixture.gateway.isLive("thread-a", "execution-a")).resolves.toBe(true);
    await expect(fixture.gateway.isLive("thread-b", "execution-b")).resolves.toBe(false);

    await fixture.gateway.close();
  });

  it("retires a stale deferred attachment before preparing its replacement", async () => {
    const original = binding("thread-a", "execution-a", "active-a");
    const replacement = {
      ...original,
      activeSessionId: "active-a-replacement",
      sessionId: "session-a-replacement",
    };
    const firstAttachment = deferred<ResidentRuntimeConnection>();
    const staleDetach = vi.fn(async () => undefined);
    const fixture = await gatewayFixture([original], {
      attachResident: vi.fn(async (candidate: ResidentSessionBinding) => {
        if (candidate.activeSessionId === original.activeSessionId) return firstAttachment.promise;
        return connectionFor(candidate);
      }),
    });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(fixture.adapter.attachResident).toHaveBeenCalledOnce());
    fixture.setBindings([replacement]);
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);

    firstAttachment.resolve({ binding: original, detach: staleDetach } as unknown as ResidentRuntimeConnection);
    await vi.waitFor(() => expect(staleDetach).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(fixture.adapter.attachResident).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));
    await expect(fixture.gateway.isLive("thread-a", "execution-a")).resolves.toBe(true);

    await fixture.gateway.close();
  });

  it("detaches a removed binding and rejects its later projection publication", async () => {
    const durableBinding = binding("thread-a", "execution-a", "active-a");
    const detach = vi.fn(async () => undefined);
    const fixture = await gatewayFixture([durableBinding], {
      attachResident: vi.fn(async () => ({
        binding: durableBinding,
        detach,
      }) as unknown as ResidentRuntimeConnection),
    });
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));
    vi.mocked(fixture.store.publishResidentProjectionSnapshot).mockClear();

    fixture.setBindings([]);
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
    await fixture.adapterOptions.publishProjection(durableBinding, {} as never);
    await expect(fixture.adapterOptions.publishModelSelectionProjection(
      modelCommand("thread-a", "execution-a"),
      durableBinding,
      {} as never,
    )).rejects.toMatchObject({ code: "MODEL_SELECTION_SESSION_AUTHORITY_CHANGED" });

    expect(fixture.store.publishResidentProjectionSnapshot).not.toHaveBeenCalled();
    expect(fixture.store.publishResidentModelSelectionProjection).not.toHaveBeenCalled();
    await expect(fixture.gateway.isLive("thread-a", "execution-a")).resolves.toBe(false);

    await fixture.gateway.close();
  });

  it("derives deterministic Windows pipes and bounded private Unix endpoints from the canonical root", () => {
    const firstWindows = residentDaemonEndpoint("C:\\Prime Continuim\\hostd", "win32");
    const secondWindows = residentDaemonEndpoint("c:\\prime continuim\\HOSTD", "win32");
    expect(firstWindows).toBe(secondWindows);
    expect(firstWindows).toMatch(/^\\\\\.\\pipe\\prime-continuim-resident-[0-9a-f]{16}$/);

    const firstUnix = residentDaemonEndpoint("/var/lib/prime-continuim/hostd", "linux");
    const secondUnix = residentDaemonEndpoint("/var/lib/prime-continuim/hostd", "linux");
    expect(firstUnix).toBe(secondUnix);
    expect(Buffer.byteLength(firstUnix, "utf8")).toBeLessThanOrEqual(100);
    expect(firstUnix).toMatch(/[\\/]pc-[0-9a-f]{16}[\\/]d\.sock$/);
    expect(dirname(dirname(firstUnix))).toBe(realpathSync.native(resolve(tmpdir())));
    expect(residentDaemonWorkingDirectory("/var/lib/prime-continuim/hostd")).toMatch(
      /[\\/]resident-daemon$/,
    );
  });

  it("waits for the resident adapter close before completing gateway shutdown", async () => {
    const durableBinding = binding("thread-a", "execution-a", "active-a");
    const adapterClose = deferred<void>();
    const fixture = await gatewayFixture([durableBinding], {
      close: vi.fn(() => adapterClose.promise),
    });
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));

    let closed = false;
    const closing = fixture.gateway.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(fixture.adapter.close).toHaveBeenCalledOnce());
    expect(closed).toBe(false);

    adapterClose.resolve(undefined);
    await closing;
    expect(closed).toBe(true);
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
  });

  it("re-probes browser execution once after backoff and upgrades the exact live binding", async () => {
    const durableBinding = binding("thread-browser", "execution-browser", "active-browser");
    let now = 1_000;
    let retryCallback: (() => void) | undefined;
    const retryTimer = setTimeout(() => undefined, 60_000);
    retryTimer.unref();
    const browserReadinessProbe = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const fixture = await gatewayFixture([durableBinding], {}, {
      browserHandle: true,
      browserReadinessProbe,
      now: () => now,
      scheduleBrowserReadinessRetry: (callback) => {
        retryCallback = callback;
        return retryTimer;
      },
      cancelBrowserReadinessRetry: clearTimeout,
    });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));
    await vi.waitFor(() => expect(browserReadinessProbe).toHaveBeenCalledOnce());
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    await expect(fixture.gateway.isResidentBrowserExecutionReady(durableBinding)).resolves.toBe(false);
    expect(browserReadinessProbe).toHaveBeenCalledOnce();
    expect(fixture.adapterOptions.browserSkill).toMatch(/[\\/]bridge[\\/]skills[\\/]playwright-cli[\\/]SKILL\.md$/);
    expect(fixture.adapterOptions.environment).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      PRIME_CONTINUIM_BROWSER_EXECUTABLE: expect.any(String),
      PRIME_CONTINUIM_BROWSER_BRIDGE: expect.any(String),
      PRIME_CONTINUIM_BROWSER_STATE_DIR: expect.any(String),
    });

    const invalidation = vi.fn();
    const unsubscribe = fixture.gateway.subscribeProjectionChanges(invalidation);
    now += 30_001;
    expect(retryCallback).toBeTypeOf("function");
    retryCallback?.();
    await vi.waitFor(() => expect(browserReadinessProbe).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(invalidation).toHaveBeenCalledOnce());
    await vi.waitFor(async () => {
      expect(await fixture.gateway.isResidentBrowserExecutionReady(durableBinding)).toBe(true);
    });
    unsubscribe();
    await fixture.gateway.close();
  });

  it("does not block core resident readiness on a deferred browser doctor", async () => {
    const durableBinding = binding("thread-browser-deferred", "execution-browser-deferred", "active-browser-deferred");
    const doctor = deferred<boolean>();
    const fixture = await gatewayFixture([durableBinding], {}, {
      browserHandle: true,
      browserReadinessProbe: vi.fn(() => doctor.promise),
    });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));
    expect(fixture.adapterFactory).toHaveBeenCalledOnce();
    await expect(fixture.gateway.isResidentBrowserExecutionReady(durableBinding)).resolves.toBe(false);

    doctor.resolve(true);
    await vi.waitFor(async () => {
      expect(await fixture.gateway.isResidentBrowserExecutionReady(durableBinding)).toBe(true);
    });
    await fixture.gateway.close();
  });
});

async function gatewayFixture(
  bindings: readonly ResidentSessionBinding[],
  adapterOverrides: Partial<ResidentGatewayAdapter> = {},
  fixtureOptions: {
    readonly autoProjectBindings?: boolean;
    readonly projectedBindings?: readonly ResidentSessionBinding[];
    readonly publishOnAttach?: false | ((binding: ResidentSessionBinding) => boolean);
    readonly moduleLoaderFactory?: (
      handle: VerifiedInstalledRuntimeHandle,
    ) => PrimeAgentPublicModuleLoader;
    readonly credentialSecurity?: {
      prepareAndVerify(): Promise<void>;
      assertStillSecure(): Promise<void>;
    };
    readonly browserHandle?: boolean;
    readonly browserReadinessProbe?: (input: VerifiedBrowserReadinessProbeInput) => Promise<boolean>;
    readonly now?: () => number;
    readonly scheduleBrowserReadinessRetry?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    readonly cancelBrowserReadinessRetry?: (timer: ReturnType<typeof setTimeout>) => void;
  } = {},
) {
  const root = await canonicalTemporaryDirectory("prime-resident-gateway-bootstrap-test-");
  temporaryDirectories.push(root);
  let currentBindings = [...bindings];
  let projectedBindings = [...(fixtureOptions.projectedBindings ?? bindings)];
  const store = {
    paths: { root },
    getHost: vi.fn(async () => ({ hostId: "host-local" })),
    listResidentSessionBindings: vi.fn(async () => [...currentBindings]),
    getResidentSessionBinding: vi.fn(async (threadId: string, executionGenerationId: string) =>
      currentBindings.find(
        (candidate) =>
          candidate.threadId === threadId &&
          candidate.executionGenerationId === executionGenerationId,
      )),
    hasExactResidentProjection: vi.fn(async (candidate: ResidentSessionBinding) =>
      projectedBindings.some(
        (projected) =>
          residentDispatchAuthorityFingerprint(projected) === residentDispatchAuthorityFingerprint(candidate),
      )),
    persistResidentSessionBinding: vi.fn(async () => undefined),
    completeResidentSessionBinding: vi.fn(async () => undefined),
    publishResidentProjectionSnapshot: vi.fn(async (candidate: ResidentSessionBinding) => {
      projectedBindings = projectedBindings.filter(
        (projected) =>
          projected.threadId !== candidate.threadId ||
          projected.executionGenerationId !== candidate.executionGenerationId,
      );
      projectedBindings.push(candidate);
      return undefined;
    }),
    publishResidentModelSelectionProjection: vi.fn(async () => undefined),
    listResidentPromptReconciliationLeases: vi.fn(async () => []),
    listResidentAbortReconciliationLeases: vi.fn(async () => []),
    completeResidentPromptReconciliation: vi.fn(async () => {
      throw new Error("No reconciliation lease was configured for this fixture");
    }),
    completeResidentAbortReconciliation: vi.fn(async () => {
      throw new Error("No Stop reconciliation lease was configured for this fixture");
    }),
  } as unknown as HostStore;
  const runtimeHandles = {
    acquireVerifiedRuntimeHandle: vi.fn(async () => verifiedHandle(root, fixtureOptions.browserHandle)),
  } satisfies VerifiedRuntimeHandleProvider;
  let adapterOptions!: PrimeAgentResidentAdapterOptions;
  const {
    attachResident: attachResidentOverride,
    ...remainingAdapterOverrides
  } = adapterOverrides;
  const adapter: ResidentGatewayAdapter = {
    continuity: "resident",
    isLive: vi.fn(async () => true),
    submit: vi.fn(async () => ({ disposition: "accepted" as const })),
    close: vi.fn(async () => undefined),
    createOwnedCandidate: vi.fn(async () => {
      throw new Error("No owned candidate was configured for this fixture");
    }),
    readStableResidentProjection: vi.fn(async () => {
      throw new Error("No resident recovery projection was configured for this fixture");
    }),
    endResidentSession: vi.fn(async () => {
      throw new Error("No resident end was configured for this fixture");
    }),
    reconcileResidentEnd: vi.fn(async () => undefined),
    attachResident: vi.fn(async (candidate: ResidentSessionBinding) => {
      const connection = attachResidentOverride
        ? await attachResidentOverride(candidate)
        : connectionFor(candidate);
      const publishOnAttach = fixtureOptions.publishOnAttach;
      if (publishOnAttach !== false && (publishOnAttach === undefined || publishOnAttach(connection.binding))) {
        await adapterOptions.publishProjection(connection.binding, {} as never);
      }
      return connection;
    }),
    reconcileAcknowledgedPromptIdle: vi.fn(async () => {
      throw new Error("No reconciliation lease was configured for this fixture");
    }),
    reconcileAcknowledgedAbortIdle: vi.fn(async () => {
      throw new Error("No Stop reconciliation lease was configured for this fixture");
    }),
    ...remainingAdapterOverrides,
  };
  const adapterFactory = vi.fn((options: PrimeAgentResidentAdapterOptions) => {
    adapterOptions = options;
    return adapter;
  });
  const gateway = new VerifiedResidentGateway({
    store,
    runtimeHandles,
    platform: "win32",
    environment: {},
    adapterFactory,
    moduleLoaderFactory: fixtureOptions.moduleLoaderFactory ?? (() => async () => ({})),
    credentialSecurity: fixtureOptions.credentialSecurity,
    browserReadinessProbe: fixtureOptions.browserReadinessProbe,
    now: fixtureOptions.now,
    scheduleBrowserReadinessRetry: fixtureOptions.scheduleBrowserReadinessRetry,
    cancelBrowserReadinessRetry: fixtureOptions.cancelBrowserReadinessRetry,
  });
  return {
    gateway,
    adapter,
    adapterFactory,
    runtimeHandles,
    get adapterOptions() {
      return adapterOptions;
    },
    store,
    setBindings(next: readonly ResidentSessionBinding[]) {
      currentBindings = [...next];
      if (fixtureOptions.autoProjectBindings !== false) projectedBindings = [...next];
    },
  };
}

type ResidentGatewayAdapter = PrimeAgentGateway & {
  createOwnedCandidate(input: ResidentOwnedSessionCreateInput): Promise<ResidentOwnedRuntimeCandidate>;
  readStableResidentProjection(binding: ResidentSessionBinding): Promise<ResidentProjectionSnapshot>;
  endResidentSession(lease: ResidentKillLease): Promise<ResidentEndAcknowledgement>;
  reconcileResidentEnd(binding: ResidentSessionBinding): Promise<ResidentEndReconciliationEvidence | undefined>;
  attachResident(binding: ResidentSessionBinding): Promise<ResidentRuntimeConnection>;
  reconcileAcknowledgedPromptIdle(
    lease: ResidentPromptReconciliationLease,
  ): Promise<ResidentPromptIdleAuthorityEvidence>;
  reconcileAcknowledgedAbortIdle(
    lease: ResidentAbortReconciliationLease,
  ): Promise<ResidentAbortIdleAuthorityEvidence>;
};

function binding(
  threadId: string,
  executionGenerationId: string,
  activeSessionId: string,
): ResidentSessionBinding {
  return {
    bindingVersion: 1,
    lifecycle: "resident",
    threadId,
    executionGenerationId,
    workspaceDirectory: resolve("test-workspaces", threadId),
    activeSessionId,
    sessionId: `session-${threadId}`,
    sessionFile: resolve("test-sessions", `${threadId}.jsonl`),
    boundAt: "2026-08-07T20:00:00.000Z",
    runtime: {
      releaseVersion: PINNED_PRIME_AGENT_RUNTIME.releaseVersion,
      appVersion: PINNED_PRIME_AGENT_RUNTIME.expectedAppVersion,
      protocolName: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolName,
      protocolVersion: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolVersion,
      schemaRevision: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaRevision,
      schemaId: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaId,
      capabilities: [...REQUIRED_RESIDENT_DAEMON_CAPABILITIES],
      runtimeBuildId: PINNED_PRIME_AGENT_RUNTIME.runtimeBuildId,
      supervisorGeneration: "supervisor-1",
    },
  };
}

function connectionFor(bindingValue: ResidentSessionBinding): ResidentRuntimeConnection {
  return { binding: bindingValue } as ResidentRuntimeConnection;
}

function verifiedHandle(root: string, browser = false): VerifiedInstalledRuntimeHandle {
  return {
    identity: {},
    executable: join(root, "node.exe"),
    browserExecutable: join(root, "electron.exe"),
    moduleUrl: new URL(`file:///${join(root, "dist", "index.js").replaceAll("\\", "/")}`).href,
    cliEntrypoint: join(root, "dist", "bundle", "cli.js"),
    ...(browser ? {
      browserBridge: join(root, "bridge", "browser-bridge.mjs"),
      browserHost: join(root, "bridge", "browser-host.cjs"),
      browserLauncher: join(root, "bridge", "playwright-cli"),
      browserLauncherWindows: join(root, "bridge", "playwright-cli.cmd"),
      browserSkill: join(root, "bridge", "skills", "playwright-cli", "SKILL.md"),
    } : {}),
  } as unknown as VerifiedInstalledRuntimeHandle;
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function modelCommand(threadId: string, executionGenerationId: string) {
  return {
    protocolVersion: 1 as const,
    deviceId: "bootstrap-device",
    commandId: "bootstrap-model-command",
    expectedHostId: "bootstrap-host",
    threadId,
    issuedAt: "2026-08-08T02:00:00.000Z",
    expectedExecutionGenerationId: executionGenerationId,
    command: { kind: "model.select" as const, providerId: "openai", modelId: "gpt-5" },
  };
}
