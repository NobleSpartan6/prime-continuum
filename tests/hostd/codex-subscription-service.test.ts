import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexSubscriptionBackendError,
  type CodexSubscriptionBackend,
} from "../../src/hostd/codex-subscription-backend";
import {
  deriveNoisePublicKeyFingerprint,
  type PairingAuthority,
} from "../../src/hostd/pairing/authority";
import {
  HostService,
  SSH_BRIDGE_SESSION,
  TRUSTED_USER_SESSION,
  type HostSessionContext,
  type RuntimeIntegrityReadinessProvider,
} from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";
import {
  CODEX_SUBSCRIPTION_CAPABILITY,
  PROTOCOL_VERSION,
  RUNTIME_INTEGRITY_REPAIR_CAPABILITY,
  type RuntimeIntegritySnapshot,
} from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];
const activeServices: HostService[] = [];
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

afterEach(async () => {
  await Promise.allSettled(activeServices.splice(0).map(async (service) => await service.close()));
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("HostService Codex via ChatGPT subscription containment", () => {
  it("advertises the capability only to the trusted local desktop", async () => {
    const fixture = await temporaryService();
    fixture.backend.capabilityReady.mockClear();

    const local = await health(fixture.service, TRUSTED_USER_SESSION, "codex-local-health");
    expect(local.capabilities).toContain(CODEX_SUBSCRIPTION_CAPABILITY);
    expect(fixture.backend.capabilityReady).toHaveBeenCalledOnce();

    fixture.backend.capabilityReady.mockClear();
    const ssh = await health(fixture.service, SSH_BRIDGE_SESSION, "codex-ssh-health");
    const relay = await health(fixture.service, relaySession(), "codex-relay-health");
    expect(ssh.capabilities).not.toContain(CODEX_SUBSCRIPTION_CAPABILITY);
    expect(relay.capabilities).not.toContain(CODEX_SUBSCRIPTION_CAPABILITY);
    expect(fixture.backend.capabilityReady).not.toHaveBeenCalled();
  });

  it("rejects every Codex method over SSH and relay before backend readiness or dispatch", async () => {
    const fixture = await temporaryService();
    const requests = codexRequests(fixture.hostId);
    fixture.backend.capabilityReady.mockClear();
    for (const method of CODEX_BACKEND_METHODS) fixture.backend[method].mockClear();

    for (const context of [SSH_BRIDGE_SESSION, relaySession()]) {
      for (const [index, request] of requests.entries()) {
        const response = await fixture.service.handle({
          protocolVersion: PROTOCOL_VERSION,
          requestId: `${context.transport}-codex-${index}`,
          method: request.method,
          payload: request.payload,
        }, context);
        expect(response).toMatchObject({
          ok: false,
          error: {
            code: "REMOTE_CODEX_SUBSCRIPTION_FORBIDDEN",
            retryable: false,
          },
        });
      }
    }

    expect(fixture.backend.capabilityReady).not.toHaveBeenCalled();
    for (const method of CODEX_BACKEND_METHODS) expect(fixture.backend[method]).not.toHaveBeenCalled();
  });

  it("routes all eight trusted-local methods to the matching backend operation", async () => {
    const fixture = await temporaryService();

    for (const [index, request] of codexRequests(fixture.hostId).entries()) {
      fixture.backend.capabilityReady.mockClear();
      fixture.backend[request.backendMethod].mockClear();
      const response = await fixture.service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: `local-codex-${index}`,
        method: request.method,
        payload: request.payload,
      }, TRUSTED_USER_SESSION);

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "CODEX_RUNTIME_BUSY",
          message: `sentinel ${request.backendMethod}`,
          retryable: true,
        },
      });
      expect(fixture.backend.capabilityReady).toHaveBeenCalledOnce();
      expect(fixture.backend[request.backendMethod]).toHaveBeenCalledOnce();
      expect(fixture.backend[request.backendMethod]).toHaveBeenCalledWith(request.payload);
    }
  });

  it("drains Codex before beginning a runtime integrity retry", async () => {
    let current = runtimeSnapshot("failed");
    const retry = vi.fn(() => {
      current = runtimeSnapshot("initializing");
      return true;
    });
    const provider: RuntimeIntegrityReadinessProvider = {
      snapshot: () => current,
      retry,
    };
    const fixture = await temporaryService(provider);
    fixture.backend.drainForRuntimeMutation.mockClear();

    const response = await fixture.service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "codex-runtime-retry",
      method: "runtime.integrity.retry",
      payload: { expectedHostId: fixture.hostId },
    }, TRUSTED_USER_SESSION);

    expect(response).toMatchObject({ ok: true, result: { status: "initializing" } });
    expect(fixture.backend.drainForRuntimeMutation).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(fixture.backend.drainForRuntimeMutation.mock.invocationCallOrder[0])
      .toBeLessThan(retry.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
  });

  it("requires Codex and host quiescence for repair advertisement, then drains before repair", async () => {
    let current: RuntimeIntegritySnapshot = repairRuntimeSnapshot();
    const repairAvailable = vi.fn(() => true);
    const repair = vi.fn(() => {
      current = runtimeSnapshot("initializing");
      return true;
    });
    const provider: RuntimeIntegrityReadinessProvider = {
      snapshot: () => current,
      repairAvailable,
      repair,
    };
    const fixture = await temporaryService(provider);
    const hostQuiescence = vi.spyOn(fixture.store, "assertRuntimeRepairQuiescent");
    fixture.backend.assertQuiescent.mockClear();
    fixture.backend.drainForRuntimeMutation.mockClear();

    const snapshot = await health(fixture.service, TRUSTED_USER_SESSION, "codex-repair-health");
    expect(snapshot.capabilities).toContain(RUNTIME_INTEGRITY_REPAIR_CAPABILITY);
    expect(hostQuiescence).toHaveBeenCalledOnce();
    expect(fixture.backend.assertQuiescent).toHaveBeenCalledOnce();

    const failed = current as Extract<RuntimeIntegritySnapshot, { status: "failed" }>;
    const response = await fixture.service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "codex-runtime-repair",
      method: "runtime.integrity.repair",
      payload: {
        expectedHostId: fixture.hostId,
        expectedTrustAnchorId: failed.trustAnchorId,
        expectedTarget: failed.target,
        expectedChangedAt: failed.changedAt,
      },
    }, TRUSTED_USER_SESSION);

    expect(response).toMatchObject({ ok: true, result: { status: "initializing" } });
    expect(hostQuiescence).toHaveBeenCalledTimes(2);
    expect(fixture.backend.drainForRuntimeMutation).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledOnce();
    expect(fixture.backend.drainForRuntimeMutation.mock.invocationCallOrder[0])
      .toBeLessThan(repair.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
  });
});

const CODEX_BACKEND_METHODS = [
  "accountRead",
  "loginStart",
  "loginCancel",
  "logout",
  "conversationSnapshot",
  "turnStart",
  "turnInterrupt",
  "turnReconcile",
] as const;

function codexRequests(hostId: string) {
  const binding = {
    expectedHostId: hostId,
    threadId: "source-thread-1",
    expectedExecutionGenerationId: "execution-generation-1",
  };
  const turnStart = {
    ...binding,
    expectedBackendIncarnationId: "backend-incarnation-1",
    expectedConversation: { state: "absent" as const },
    operationId: "turn-operation-1",
    prompt: "Explain the selected code.",
  };
  return [
    {
      method: "codex.subscription.account.read" as const,
      backendMethod: "accountRead" as const,
      payload: { expectedHostId: hostId },
    },
    {
      method: "codex.subscription.login.start" as const,
      backendMethod: "loginStart" as const,
      payload: {
        expectedHostId: hostId,
        expectedBackendIncarnationId: "backend-incarnation-1",
        operationId: "login-operation-1",
      },
    },
    {
      method: "codex.subscription.login.cancel" as const,
      backendMethod: "loginCancel" as const,
      payload: {
        expectedHostId: hostId,
        expectedBackendIncarnationId: "backend-incarnation-1",
        loginOperationId: "login-operation-1",
        loginId: "login-attempt-1",
      },
    },
    {
      method: "codex.subscription.logout" as const,
      backendMethod: "logout" as const,
      payload: {
        expectedHostId: hostId,
        expectedBackendIncarnationId: "backend-incarnation-1",
        operationId: "logout-operation-1",
      },
    },
    {
      method: "codex.subscription.conversation.snapshot" as const,
      backendMethod: "conversationSnapshot" as const,
      payload: binding,
    },
    {
      method: "codex.subscription.turn.start" as const,
      backendMethod: "turnStart" as const,
      payload: turnStart,
    },
    {
      method: "codex.subscription.turn.interrupt" as const,
      backendMethod: "turnInterrupt" as const,
      payload: {
        ...binding,
        expectedBackendIncarnationId: "backend-incarnation-1",
        sessionId: "codex-session-1",
        codexThreadId: "codex-thread-1",
        operationId: "interrupt-operation-1",
        expectedTurnOperationId: "turn-operation-1",
        turnId: "codex-turn-1",
      },
    },
    {
      method: "codex.subscription.turn.reconcile" as const,
      backendMethod: "turnReconcile" as const,
      payload: { ...turnStart, operationId: "reconcile-operation-1" },
    },
  ];
}

type FakeBackend = ReturnType<typeof fakeBackend>;

function fakeBackend() {
  const fail = (method: string) => vi.fn(async () => {
    throw new CodexSubscriptionBackendError("CODEX_RUNTIME_BUSY", `sentinel ${method}`, true);
  });
  return {
    initialize: vi.fn(async () => undefined),
    capabilityReady: vi.fn(async () => true),
    accountRead: fail("accountRead"),
    loginStart: fail("loginStart"),
    loginCancel: fail("loginCancel"),
    logout: fail("logout"),
    conversationSnapshot: fail("conversationSnapshot"),
    turnStart: fail("turnStart"),
    turnInterrupt: fail("turnInterrupt"),
    turnReconcile: fail("turnReconcile"),
    assertQuiescent: vi.fn(async () => undefined),
    drainForRuntimeMutation: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

async function temporaryService(
  runtimeIntegrityProvider: RuntimeIntegrityReadinessProvider = { snapshot: () => runtimeSnapshot("ready") },
): Promise<{
  service: HostService;
  store: HostStore;
  hostId: string;
  backend: FakeBackend;
}> {
  const directory = await mkdtemp(join(tmpdir(), "prime-codex-service-test-"));
  temporaryDirectories.push(directory);
  const store = new HostStore(directory);
  const backend = fakeBackend();
  const publicKeyB64u = Buffer.alloc(32, 0x41).toString("base64url");
  const identityInput = {
    identityEpoch: 1,
    algorithm: "Noise_25519" as const,
    publicKeyB64u,
    secretRef: "test-only://codex-service-host-key",
  };
  const identity = {
    ...identityInput,
    fingerprint: deriveNoisePublicKeyFingerprint(publicKeyB64u),
  };
  const pairingAuthority = {
    initialize: vi.fn(async () => ({ identity })),
    withAuthorizedChannel: vi.fn(async (
      _channel: unknown,
      _scope: unknown,
      operation: (device: { deviceId: string }) => Promise<unknown>,
    ) => operation({ deviceId: "relay-device-1" })),
    close: vi.fn(async () => undefined),
  } as unknown as PairingAuthority;
  const service = new HostService(store, undefined, pairingAuthority, {
    runtimeIntegrityProvider,
    codexSubscriptionBackend: backend as unknown as CodexSubscriptionBackend,
    hostIdentityProvider: {
      backend: "test-secure-store",
      async loadExisting({ hostId }) {
        return { status: "ready", hostId, identity: identityInput };
      },
      close() {},
    },
  });
  activeServices.push(service);
  await service.initialize();
  const host = await store.getHost();
  expect(backend.initialize).toHaveBeenCalledWith(host.hostId);
  return { service, store, hostId: host.hostId, backend };
}

async function health(service: HostService, context: HostSessionContext, requestId: string) {
  const response = await service.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method: "health.get",
    payload: {},
  }, context);
  if (!response.ok || response.method !== "health.get") throw new Error("health request failed");
  return response.result;
}

function relaySession(): HostSessionContext {
  return {
    transport: "relay",
    channel: {
      leaseId: "A".repeat(43),
      channelId: "0".repeat(32),
    },
  };
}

function runtimeSnapshot(status: RuntimeIntegritySnapshot["status"]): RuntimeIntegritySnapshot {
  const base = {
    contractVersion: 1 as const,
    changedAt: "2026-08-09T12:00:00.000Z",
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

function repairRuntimeSnapshot(): Extract<RuntimeIntegritySnapshot, { status: "failed" }> {
  return {
    ...(runtimeSnapshot("failed") as Extract<RuntimeIntegritySnapshot, { status: "failed" }>),
    code: "RUNTIME_REPAIR_REQUIRED",
    retryable: false,
    recoveryAction: "repair_application",
  };
}
