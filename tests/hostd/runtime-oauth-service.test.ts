import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostOAuthComposition, OAuthLoginCallbacks } from "../../src/hostd/oauth-session-broker";
import { plaintextRuntimeOAuthDevelopmentEnabled } from "../../src/hostd/index";
import { bridgeStdioToLocalSocket, serveLocalSocket } from "../../src/hostd/server";
import { HostService, SSH_BRIDGE_SESSION, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";
import { resolveCanonicalLocalHostTarget } from "../../src/shared/local-host-target";
import { encodeJsonFrame, LengthPrefixedJsonDecoder } from "../../src/shared/frame-codec";
import {
  PROTOCOL_VERSION,
  RUNTIME_OAUTH_CAPABILITY,
  type RuntimeIntegritySnapshot,
} from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })));
});

describe("HostService runtime OAuth boundary", () => {
  it("keeps plaintext Prime AuthStorage composition disabled unless development opt-in is exactly 1", () => {
    expect(plaintextRuntimeOAuthDevelopmentEnabled({})).toBe(false);
    expect(plaintextRuntimeOAuthDevelopmentEnabled({ PRIME_CONTINUIM_ENABLE_PLAINTEXT_OAUTH_DEV: "true" })).toBe(false);
    expect(plaintextRuntimeOAuthDevelopmentEnabled({ PRIME_CONTINUIM_ENABLE_PLAINTEXT_OAUTH_DEV: "01" })).toBe(false);
    expect(plaintextRuntimeOAuthDevelopmentEnabled({ PRIME_CONTINUIM_ENABLE_PLAINTEXT_OAUTH_DEV: "1 " })).toBe(false);
    expect(plaintextRuntimeOAuthDevelopmentEnabled({ PRIME_CONTINUIM_ENABLE_PLAINTEXT_OAUTH_DEV: "1" })).toBe(true);
  });

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

  it("advertises only the trusted-local capability, binds host/authority, and never projects credentials", async () => {
    const { service, hostId } = await temporaryService();
    try {
      const health = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "oauth-health",
        method: "health.get",
        payload: {},
      }, TRUSTED_USER_SESSION);
      expect(health).toMatchObject({
        ok: true,
        result: { capabilities: expect.arrayContaining([RUNTIME_OAUTH_CAPABILITY]) },
      });

      const started = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "oauth-start",
        method: "oauth.session.start",
        payload: {
          expectedHostId: hostId,
          authorityId: "desktop-authority-1",
          providerId: "openai-codex",
        },
      }, TRUSTED_USER_SESSION);
      expect(started).toMatchObject({
        ok: true,
        result: {
          providerId: "openai-codex",
          phase: "awaiting_user",
          authorization: { url: validAuthorizationUrl() },
        },
      });
      expect(JSON.stringify(started)).not.toMatch(/private-access|private-refresh|accessToken|refreshToken/i);
      if (!started.ok || started.method !== "oauth.session.start") throw new Error("OAuth did not start");

      const foreignAuthority = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "oauth-foreign-authority",
        method: "oauth.session.status",
        payload: {
          expectedHostId: hostId,
          authorityId: "desktop-authority-2",
          sessionId: started.result.sessionId,
        },
      }, TRUSTED_USER_SESSION);
      expect(foreignAuthority).toMatchObject({
        ok: false,
        error: { code: "OAUTH_SESSION_FORBIDDEN" },
      });

      const staleHost = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "oauth-stale-host",
        method: "oauth.session.status",
        payload: {
          expectedHostId: "replaced-host",
          authorityId: "desktop-authority-1",
          sessionId: started.result.sessionId,
        },
      }, TRUSTED_USER_SESSION);
      expect(staleHost).toMatchObject({
        ok: false,
        error: { code: "HOST_AUTHORITY_MISMATCH" },
      });
    } finally {
      await service.close();
    }
  });

  it("rejects every OAuth method over relay before considering remote scopes", async () => {
    const { service, hostId } = await temporaryService();
    try {
      const response = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "remote-oauth",
        method: "oauth.session.start",
        payload: {
          expectedHostId: hostId,
          authorityId: "remote-authority",
          providerId: "openai-codex",
        },
      }, {
        transport: "relay",
        channel: { leaseId: "A".repeat(43), channelId: "0".repeat(32) },
      });
      expect(response).toMatchObject({
        ok: false,
        error: { code: "REMOTE_OAUTH_FORBIDDEN", retryable: false },
      });
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
          payload: { expectedHostId: hostId, authorityId: "ssh-authority", providerId: "openai-codex" },
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
    } finally {
      await service.close();
    }
  });

  it("marks the official stdio bridge before remote frames reach health or OAuth dispatch", async () => {
    const { service, hostId, directory } = await temporaryService();
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
        payload: { expectedHostId: hostId, authorityId: "remote", providerId: "openai-codex" },
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
      await server.close();
      await bridge;
    } finally {
      await server.close().catch(() => undefined);
      await service.close();
    }
  });

  it("waits for abort-triggered login teardown and never releases runtime authority after unknown helper liveness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-close-order-"));
    temporaryDirectories.push(directory);
    const store = new HostStore(directory);
    const helperExit = deferred<void>();
    const abortObserved = deferred<void>();
    let terminalFailure: Error | undefined;
    const composition: HostOAuthComposition = {
      getProvider: () => ({
        id: "openai-codex",
        name: "ChatGPT Plus/Pro",
        login: async (callbacks) => {
          await new Promise<void>((resolve) => {
            callbacks.signal?.addEventListener("abort", () => {
              abortObserved.resolve();
              resolve();
            }, { once: true });
          });
          await helperExit.promise;
          terminalFailure = new Error("helper termination was not observed");
          throw terminalFailure;
        },
      }),
      set: vi.fn(),
      drainErrors: vi.fn(() => []),
      reload: vi.fn(),
      getAuthStatus: vi.fn(() => ({ configured: false })),
      close: vi.fn(async () => {
        if (terminalFailure) throw terminalFailure;
      }),
    };
    const integrityClose = vi.fn(async () => undefined);
    const service = new HostService(store, undefined, undefined, {
      runtimeOAuthComposition: composition,
      runtimeIntegrityProvider: {
        snapshot: () => readyRuntimeIntegritySnapshot(),
        close: integrityClose,
      },
    });
    await service.initialize();
    const hostId = (await store.getHost()).hostId;
    await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "close-order-start",
      method: "oauth.session.start",
      payload: { expectedHostId: hostId, authorityId: "desktop", providerId: "openai-codex" },
    }, TRUSTED_USER_SESSION);

    const closing = service.close();
    await abortObserved.promise;
    expect(composition.close).not.toHaveBeenCalled();
    expect(integrityClose).not.toHaveBeenCalled();
    helperExit.resolve();
    await expect(closing).rejects.toThrow("helper termination was not observed");
    expect(terminalFailure).toBeInstanceOf(Error);
    expect(composition.close).toHaveBeenCalledOnce();
    expect(integrityClose).not.toHaveBeenCalled();
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

function oauthComposition(): HostOAuthComposition & { getProvider: ReturnType<typeof vi.fn> } {
  return {
    getProvider: vi.fn((providerId) => providerId === "openai-codex"
      ? {
          id: "openai-codex",
          name: "ChatGPT Plus/Pro (Codex Subscription)",
          usesCallbackServer: true,
          login: async (callbacks: OAuthLoginCallbacks) => {
            callbacks.onAuth({ url: validAuthorizationUrl() });
            return await new Promise<never>((_resolve, reject) => {
              callbacks.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          },
        }
      : undefined),
    set: vi.fn(),
    drainErrors: vi.fn(() => []),
    reload: vi.fn(),
    getAuthStatus: vi.fn(() => ({ configured: false })),
    close: vi.fn(async () => undefined),
  };
}

function validAuthorizationUrl(): string {
  const url = new URL("https://auth.openai.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", "app_EMoamEEZ73f0CkXaXp7hrann");
  url.searchParams.set("redirect_uri", "http://localhost:1455/auth/callback");
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", "A".repeat(43));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "a".repeat(32));
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");
  return url.toString();
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

function readyRuntimeIntegritySnapshot(): RuntimeIntegritySnapshot {
  return {
    contractVersion: 1,
    changedAt: "2026-08-07T00:00:00.000Z",
    trustAnchorId: "1".repeat(64),
    target: {
      runtime: "prime-agent",
      releaseVersion: "0.7.0",
      runtimeBuildId: "oauth-close-test",
      platform: "win32",
      arch: "x64",
      manifestSha256: "2".repeat(64),
      treeSha256: "3".repeat(64),
      filesSha256: "4".repeat(64),
    },
    status: "ready",
    assurance: "development-integrity",
  };
}
