import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostOAuthComposition, OAuthLoginCallbacks } from "../../src/hostd/oauth-session-broker";
import { bridgeStdioToLocalSocket, serveLocalSocket } from "../../src/hostd/server";
import { HostService, SSH_BRIDGE_SESSION, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";
import { resolveCanonicalLocalHostTarget } from "../../src/shared/local-host-target";
import { encodeJsonFrame, LengthPrefixedJsonDecoder } from "../../src/shared/frame-codec";
import {
  PROTOCOL_VERSION,
  RUNTIME_OAUTH_CAPABILITY,
} from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })));
});

describe("HostService runtime OAuth boundary", () => {
  it("does not advertise runtime OAuth when no explicitly gated composition was injected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-disabled-"));
    temporaryDirectories.push(directory);
    const service = new HostService(new HostStore(directory));
    try {
      await service.initialize();
      const health = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "oauth-disabled-health",
        method: "health.get",
        payload: {},
      }, TRUSTED_USER_SESSION);
      expect(health).toMatchObject({ ok: true });
      if (!health.ok || health.method !== "health.get") throw new Error("Health failed");
      expect(health.result.capabilities).not.toContain(RUNTIME_OAUTH_CAPABILITY);
    } finally {
      await service.close();
    }
  });

  it("keeps the core host ready while a credential-security initialization failure omits OAuth", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-security-failed-"));
    temporaryDirectories.push(directory);
    const composition = oauthComposition();
    composition.initialize = vi.fn(async () => {
      throw new Error("credential boundary unavailable");
    });
    const service = new HostService(new HostStore(directory), undefined, undefined, {
      runtimeOAuthComposition: composition,
    });
    try {
      await expect(service.initialize()).resolves.toBeUndefined();
      const health = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "oauth-security-failed-health",
        method: "health.get",
        payload: {},
      }, TRUSTED_USER_SESSION);
      expect(health).toMatchObject({ ok: true, result: { serviceState: "ready" } });
      if (!health.ok || health.method !== "health.get") throw new Error("health response was not successful");
      expect(health.result.capabilities).not.toContain(RUNTIME_OAUTH_CAPABILITY);
    } finally {
      await service.close();
    }
  });

  it("does not hold core readiness behind optional OAuth custody verification or advertise without a journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-warming-"));
    temporaryDirectories.push(directory);
    const composition = oauthComposition();
    const initialization = deferred<void>();
    const initialized = vi.fn();
    composition.initialize = vi.fn(async () => {
      await initialization.promise;
      initialized();
    });
    const service = new HostService(new HostStore(directory), undefined, undefined, {
      runtimeOAuthComposition: composition,
    });
    try {
      await expect(service.initialize()).resolves.toBeUndefined();
      const warming = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "oauth-warming-health",
        method: "health.get",
        payload: {},
      }, TRUSTED_USER_SESSION);
      expect(warming).toMatchObject({ ok: true, result: { serviceState: "ready" } });
      if (!warming.ok || warming.method !== "health.get") throw new Error("health response was not successful");
      expect(warming.result.capabilities).not.toContain(RUNTIME_OAUTH_CAPABILITY);

      initialization.resolve();
      await vi.waitFor(() => expect(initialized).toHaveBeenCalledOnce());
      const initializedHealth = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "oauth-initialized-without-journal-health",
        method: "health.get",
        payload: {},
      }, TRUSTED_USER_SESSION);
      expect(initializedHealth).toMatchObject({ ok: true, result: { serviceState: "ready" } });
      if (!initializedHealth.ok || initializedHealth.method !== "health.get") {
        throw new Error("health response was not successful");
      }
      expect(initializedHealth.result.capabilities).not.toContain(RUNTIME_OAUTH_CAPABILITY);
      expect(composition.getProvider).not.toHaveBeenCalled();
      expect(composition.login).not.toHaveBeenCalled();
      expect(composition.set).not.toHaveBeenCalled();
    } finally {
      initialization.resolve();
      await service.close();
    }
  });

  it("joins an in-flight OAuth initialization before closing and never publishes a late broker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-warming-close-"));
    temporaryDirectories.push(directory);
    const composition = oauthComposition();
    const initialization = deferred<void>();
    composition.initialize = vi.fn(async () => await initialization.promise);
    const service = new HostService(new HostStore(directory), undefined, undefined, {
      runtimeOAuthComposition: composition,
    });
    await service.initialize();

    const closing = service.close();
    await Promise.resolve();
    expect(composition.close).not.toHaveBeenCalled();
    initialization.resolve();
    await expect(closing).resolves.toBeUndefined();
    expect(composition.close).toHaveBeenCalledOnce();
    expect(composition.getProvider).not.toHaveBeenCalled();
  });

  it("keeps legacy methods schema-known but fixed-rejected without provider, storage, or browser effects", async () => {
    const { service, hostId, composition } = await temporaryService();
    try {
      const health = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "oauth-health-without-journal",
        method: "health.get",
        payload: {},
      }, TRUSTED_USER_SESSION);
      expect(health).toMatchObject({ ok: true });
      if (!health.ok || health.method !== "health.get") throw new Error("Health failed");
      expect(health.result.capabilities).not.toContain(RUNTIME_OAUTH_CAPABILITY);

      const requests = [
        {
          protocolVersion: PROTOCOL_VERSION,
          requestId: "legacy-oauth-start",
          method: "oauth.session.start",
          payload: {
            expectedHostId: hostId,
            authorityId: "desktop-authority-1",
            providerId: "openai-codex",
            operationId: "legacy-oauth-start-operation",
          },
        },
        {
          protocolVersion: PROTOCOL_VERSION,
          requestId: "legacy-oauth-status",
          method: "oauth.session.status",
          payload: {
            expectedHostId: hostId,
            authorityId: "desktop-authority-1",
            sessionId: "oauth-session-1",
          },
        },
        {
          protocolVersion: PROTOCOL_VERSION,
          requestId: "legacy-oauth-cancel",
          method: "oauth.session.cancel",
          payload: {
            expectedHostId: hostId,
            authorityId: "desktop-authority-1",
            sessionId: "oauth-session-1",
          },
        },
      ] as const;
      for (const request of requests) {
        await expect(service.handle(request, TRUSTED_USER_SESSION)).resolves.toMatchObject({
          ok: false,
          error: { code: "RUNTIME_OAUTH_LEGACY_UNAVAILABLE", retryable: false },
        });
      }

      expect(composition.getProvider).not.toHaveBeenCalled();
      expect(composition.login).not.toHaveBeenCalled();
      expect(composition.set).not.toHaveBeenCalled();
      expect(composition.drainErrors).not.toHaveBeenCalled();
      expect(composition.reload).not.toHaveBeenCalled();
      expect(composition.getAuthStatus).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("rejects every OAuth method over relay before considering remote scopes", async () => {
    const { service, hostId, composition } = await temporaryService();
    try {
      const requests = [
        {
          protocolVersion: PROTOCOL_VERSION,
          requestId: "remote-oauth-start",
          method: "oauth.session.start",
          payload: {
            expectedHostId: hostId,
            authorityId: "remote-authority",
            providerId: "openai-codex",
            operationId: "oauth-remote-operation",
          },
        },
        {
          protocolVersion: PROTOCOL_VERSION,
          requestId: "remote-oauth-status",
          method: "oauth.session.status",
          payload: { expectedHostId: hostId, authorityId: "remote-authority", sessionId: "oauth-session-1" },
        },
        {
          protocolVersion: PROTOCOL_VERSION,
          requestId: "remote-oauth-cancel",
          method: "oauth.session.cancel",
          payload: { expectedHostId: hostId, authorityId: "remote-authority", sessionId: "oauth-session-1" },
        },
      ] as const;
      for (const request of requests) {
        await expect(service.handle(request, {
          transport: "relay",
          channel: { leaseId: "A".repeat(43), channelId: "0".repeat(32) },
        })).resolves.toMatchObject({
          ok: false,
          error: { code: "REMOTE_OAUTH_FORBIDDEN", retryable: false },
        });
      }
      expect(composition.getProvider).not.toHaveBeenCalled();
      expect(composition.login).not.toHaveBeenCalled();
      expect(composition.set).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("suppresses the capability and rejects every OAuth method for an SSH bridge before broker dispatch", async () => {
    const { service, hostId, composition } = await temporaryService();
    try {
      const health = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "ssh-health",
        method: "health.get",
        payload: {},
      }, SSH_BRIDGE_SESSION);
      expect(health).toMatchObject({ ok: true });
      if (!health.ok || health.method !== "health.get") throw new Error("Health failed");
      expect(health.result.capabilities).not.toContain(RUNTIME_OAUTH_CAPABILITY);

      const requests = [
        {
          protocolVersion: PROTOCOL_VERSION,
          requestId: "ssh-oauth-start",
          method: "oauth.session.start",
          payload: {
            expectedHostId: hostId,
            authorityId: "ssh-authority",
            providerId: "openai-codex",
            operationId: "oauth-ssh-operation",
          },
        },
        {
          protocolVersion: PROTOCOL_VERSION,
          requestId: "ssh-oauth-status",
          method: "oauth.session.status",
          payload: { expectedHostId: hostId, authorityId: "ssh-authority", sessionId: "oauth-session-1" },
        },
        {
          protocolVersion: PROTOCOL_VERSION,
          requestId: "ssh-oauth-cancel",
          method: "oauth.session.cancel",
          payload: { expectedHostId: hostId, authorityId: "ssh-authority", sessionId: "oauth-session-1" },
        },
      ] as const;
      for (const request of requests) {
        await expect(service.handle(request, SSH_BRIDGE_SESSION)).resolves.toMatchObject({
          ok: false,
          error: { code: "REMOTE_OAUTH_FORBIDDEN", retryable: false },
        });
      }
      expect(composition.getProvider).not.toHaveBeenCalled();
      expect(composition.login).not.toHaveBeenCalled();
      expect(composition.set).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("marks the official stdio bridge before remote frames reach health or OAuth dispatch", async () => {
    const { service, hostId, directory, composition } = await temporaryService();
    const target = await resolveCanonicalLocalHostTarget(directory, { create: true });
    const server = await serveLocalSocket({ endpoint: target.endpoint, dataDir: directory, service });
    const input = new PassThrough();
    const output = new PassThrough();
    const decoder = new LengthPrefixedJsonDecoder();
    const responses: unknown[] = [];
    let resolveResponses!: () => void;
    const receivedResponses = new Promise<void>((resolve) => { resolveResponses = resolve; });
    output.on("data", (chunk: Buffer) => {
      responses.push(...decoder.push(chunk));
      if (responses.length >= 2) resolveResponses();
    });
    try {
      const bridge = bridgeStdioToLocalSocket(server.endpoint, input, output);
      input.write(encodeJsonFrame({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "bridge-health",
        method: "health.get",
        payload: {},
      }));
      input.write(encodeJsonFrame({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "bridge-oauth",
        method: "oauth.session.start",
        payload: {
          expectedHostId: hostId,
          authorityId: "remote",
          providerId: "openai-codex",
          operationId: "oauth-bridge-operation",
        },
      }));
      await receivedResponses;
      const [health, oauth] = responses as Array<Record<string, any>>;
      expect(health).toMatchObject({ ok: true, method: "health.get" });
      expect(health?.result?.capabilities).not.toContain(RUNTIME_OAUTH_CAPABILITY);
      expect(oauth).toMatchObject({
        ok: false,
        method: "oauth.session.start",
        error: { code: "REMOTE_OAUTH_FORBIDDEN" },
      });
      expect(composition.getProvider).not.toHaveBeenCalled();
      expect(composition.login).not.toHaveBeenCalled();
      expect(composition.set).not.toHaveBeenCalled();
      await server.close();
      await bridge;
    } finally {
      await server.close().catch(() => undefined);
      await service.close();
    }
  });

});

async function temporaryService(): Promise<{
  service: HostService;
  hostId: string;
  directory: string;
  composition: ReturnType<typeof oauthComposition>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-service-"));
  temporaryDirectories.push(directory);
  const store = new HostStore(directory);
  const composition = oauthComposition();
  const service = new HostService(store, undefined, undefined, {
    runtimeOAuthComposition: composition,
  });
  await service.initialize();
  return { service, hostId: (await store.getHost()).hostId, directory, composition };
}

function oauthComposition(): HostOAuthComposition & {
  getProvider: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
} {
  const login = vi.fn(async (_callbacks: OAuthLoginCallbacks) => {
    throw new Error("Legacy OAuth login must not run");
  });
  return {
    login,
    getProvider: vi.fn((providerId) => providerId === "openai-codex"
      ? {
          id: "openai-codex",
          name: "ChatGPT Plus/Pro (Codex Subscription)",
          usesCallbackServer: true,
          login,
        }
      : undefined),
    set: vi.fn(),
    drainErrors: vi.fn(() => []),
    reload: vi.fn(),
    getAuthStatus: vi.fn(() => ({ configured: false })),
    close: vi.fn(async () => undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
