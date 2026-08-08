import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrimeAgentGateway } from "../../src/hostd/gateway";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  type ResidentAbortIdleAuthorityEvidence,
  type ResidentRuntimeConnection,
  type ResidentPromptIdleAuthorityEvidence,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import type { VerifiedInstalledRuntimeHandle } from "../../src/hostd/runtime-integrity-manager";
import type { VerifiedRuntimeHandleProvider } from "../../src/hostd/runtime-model-catalog";
import type {
  HostStore,
  ResidentAbortReconciliationLease,
  ResidentPromptReconciliationLease,
} from "../../src/hostd/store";
import {
  VerifiedResidentGateway,
  residentDaemonEndpoint,
  residentDaemonWorkingDirectory,
} from "../../src/hostd/verified-resident-gateway";

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

  it("never marks a binding set ready when any exact attachment fails", async () => {
    const bindings = [
      binding("thread-a", "execution-a", "active-a"),
      binding("thread-b", "execution-b", "active-b"),
    ];
    const fixture = await gatewayFixture(bindings, {
      attachResident: vi.fn(async (candidate: ResidentSessionBinding) => {
        if (candidate.threadId === "thread-b") throw new Error("resident worker unavailable");
        return connectionFor(candidate);
      }),
    });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(fixture.adapter.attachResident).toHaveBeenCalledTimes(2));
    await expect(fixture.gateway.isLive("thread-a", "execution-a")).resolves.toBe(false);
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);

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
});

async function gatewayFixture(
  bindings: readonly ResidentSessionBinding[],
  adapterOverrides: Partial<ResidentGatewayAdapter> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "prime-resident-gateway-bootstrap-test-"));
  temporaryDirectories.push(root);
  let currentBindings = [...bindings];
  const store = {
    paths: { root },
    listResidentSessionBindings: vi.fn(async () => [...currentBindings]),
    getResidentSessionBinding: vi.fn(async (threadId: string, executionGenerationId: string) =>
      currentBindings.find(
        (candidate) =>
          candidate.threadId === threadId &&
          candidate.executionGenerationId === executionGenerationId,
      )),
    persistResidentSessionBinding: vi.fn(async () => undefined),
    completeResidentSessionBinding: vi.fn(async () => undefined),
    publishResidentProjectionSnapshot: vi.fn(async () => undefined),
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
    acquireVerifiedRuntimeHandle: vi.fn(async () => verifiedHandle(root)),
  } satisfies VerifiedRuntimeHandleProvider;
  const adapter: ResidentGatewayAdapter = {
    continuity: "resident",
    isLive: vi.fn(async () => true),
    submit: vi.fn(async () => ({ disposition: "accepted" as const })),
    close: vi.fn(async () => undefined),
    attachResident: vi.fn(async (candidate: ResidentSessionBinding) => connectionFor(candidate)),
    reconcileAcknowledgedPromptIdle: vi.fn(async () => {
      throw new Error("No reconciliation lease was configured for this fixture");
    }),
    reconcileAcknowledgedAbortIdle: vi.fn(async () => {
      throw new Error("No Stop reconciliation lease was configured for this fixture");
    }),
    ...adapterOverrides,
  };
  const adapterFactory = vi.fn(() => adapter);
  const gateway = new VerifiedResidentGateway({
    store,
    runtimeHandles,
    platform: "win32",
    environment: {},
    adapterFactory,
    moduleLoaderFactory: () => async () => ({}),
  });
  return {
    gateway,
    adapter,
    adapterFactory,
    runtimeHandles,
    setBindings(next: readonly ResidentSessionBinding[]) {
      currentBindings = [...next];
    },
  };
}

type ResidentGatewayAdapter = PrimeAgentGateway & {
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
    workspaceDirectory: `C:\\workspaces\\${threadId}`,
    activeSessionId,
    sessionId: `session-${threadId}`,
    sessionFile: `C:\\sessions\\${threadId}.jsonl`,
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

function verifiedHandle(root: string): VerifiedInstalledRuntimeHandle {
  return {
    identity: {},
    executable: join(root, "node.exe"),
    moduleUrl: new URL(`file:///${join(root, "dist", "index.js").replaceAll("\\", "/")}`).href,
    cliEntrypoint: join(root, "dist", "bundle", "cli.js"),
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
