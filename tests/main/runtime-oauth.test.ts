import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { App } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connectLocalHostd, connectSshHost } = vi.hoisted(() => ({
  connectLocalHostd: vi.fn(),
  connectSshHost: vi.fn(),
}));

vi.mock("../../src/main/control/local-hostd", () => ({
  connectSshHost,
  ensureAndConnectLocalHostd: connectLocalHostd,
  localHostdEndpoint: () => "test-endpoint",
}));

import { DesktopControlService } from "../../src/main/control/service";

const temporaryDirectories: string[] = [];

class TestConnection extends EventEmitter {
  isClosed = false;
  readonly requests: Array<{ method: string; params: unknown }> = [];

  constructor(private readonly respond: (method: string, params: unknown) => unknown) {
    super();
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return this.respond(method, params);
  }

  close(): void {
    this.isClosed = true;
  }

  terminate(): void {
    this.close();
  }
}

beforeEach(() => {
  connectLocalHostd.mockReset();
  connectSshHost.mockReset();
});

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

describe("DesktopControlService runtime OAuth ownership", () => {
  it("opens only the pinned URL in main and returns a secret-free renderer view", async () => {
    const authorizationUrl = validAuthorizationUrl();
    const openExternal = vi.fn(async () => undefined);
    const connection = connectionFor((method) => {
      if (method === "oauth.session.start") return oauthSnapshot("oauth-session-1", authorizationUrl);
      if (method === "oauth.session.cancel") return cancelledSnapshot("oauth-session-1");
      throw new Error(`Unexpected request: ${method}`);
    });
    const service = await connectedService(connection, openExternal);

    const view = await service.startRuntimeOAuth("host-a", "openai-codex");

    expect(openExternal).toHaveBeenCalledWith(authorizationUrl);
    expect(view).toEqual({
      sessionId: "oauth-session-1",
      providerId: "openai-codex",
      phase: "awaiting_user",
      expiresAt: "2099-08-07T18:00:00.000Z",
      interaction: { kind: "browser", state: "opened" },
    });
    expect(JSON.stringify(view)).not.toMatch(/auth\.openai|state=|code_challenge|access|refresh|token/i);
    await service.disconnect();
  });

  it("strips provider failure messages before they cross the preload boundary", async () => {
    const connection = connectionFor((method) => {
      if (method === "oauth.session.start") {
        return {
          sessionId: "oauth-session-failed",
          providerId: "openai-codex",
          phase: "failed",
          expiresAt: "2099-08-07T18:00:00.000Z",
          error: {
            code: "OAUTH_PROVIDER_FAILED",
            message: "https://secret.example/callback?token=do-not-cross",
            retryable: true,
          },
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const service = await connectedService(connection, async () => undefined);

    const view = await service.startRuntimeOAuth("host-a", "openai-codex");

    expect(view).toEqual({
      sessionId: "oauth-session-failed",
      providerId: "openai-codex",
      phase: "failed",
      expiresAt: "2099-08-07T18:00:00.000Z",
      error: { code: "OAUTH_PROVIDER_FAILED", retryable: true },
    });
    expect(JSON.stringify(view)).not.toMatch(/secret\.example|token=|do-not-cross/);
    await service.disconnect();
  });

  it("refuses a different HTTPS authorization host before invoking the system browser", async () => {
    const openExternal = vi.fn(async () => undefined);
    const connection = connectionFor((method) => {
      if (method === "oauth.session.start") {
        return oauthSnapshot("oauth-session-1", validAuthorizationUrl("https://attacker.example"));
      }
      if (method === "oauth.session.cancel") return cancelledSnapshot("oauth-session-1");
      throw new Error(`Unexpected request: ${method}`);
    });
    const service = await connectedService(connection, openExternal);

    await expect(service.startRuntimeOAuth("host-a", "openai-codex")).rejects.toBeDefined();
    expect(openExternal).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it("binds every startup poll to the session and provider returned by start", async () => {
    const openExternal = vi.fn(async () => undefined);
    const connection = connectionFor((method) => {
      if (method === "oauth.session.start") {
        return {
          sessionId: "oauth-session-1",
          providerId: "openai-codex",
          phase: "starting",
          expiresAt: "2099-08-07T18:00:00.000Z",
        };
      }
      if (method === "oauth.session.status") {
        return oauthSnapshot("oauth-session-substituted", validAuthorizationUrl());
      }
      if (method === "oauth.session.cancel") return cancelledSnapshot("oauth-session-1");
      throw new Error(`Unexpected request: ${method}`);
    });
    const service = await connectedService(connection, openExternal);

    await expect(service.startRuntimeOAuth("host-a", "openai-codex")).rejects.toMatchObject({
      code: "protocol.oauth_session_mismatch",
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(connection.requests.find(({ method }) => method === "oauth.session.status")?.params).toMatchObject({
      expectedHostId: "host-a",
      sessionId: "oauth-session-1",
    });
    await service.disconnect();
  });

  it("cancels the exact old-host session if authority drifts while the browser is opening", async () => {
    let service!: DesktopControlService;
    const openExternal = vi.fn(async () => {
      const internal = service as unknown as { reconnectGeneration: number };
      internal.reconnectGeneration += 1;
    });
    let authorityId: string | undefined;
    const connection = connectionFor((method, params) => {
      if (method === "oauth.session.start") {
        authorityId = (params as { authorityId: string }).authorityId;
        return oauthSnapshot("oauth-session-1", validAuthorizationUrl());
      }
      if (method === "oauth.session.cancel") {
        expect(params).toEqual({
          expectedHostId: "host-a",
          authorityId,
          sessionId: "oauth-session-1",
        });
        return {
          ...oauthSnapshot("oauth-session-1"),
          phase: "cancelled",
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    service = await connectedService(connection, openExternal);

    await expect(service.startRuntimeOAuth("host-a", "openai-codex")).rejects.toMatchObject({
      code: "connection.superseded",
    });
    expect(openExternal).toHaveBeenCalledOnce();
    expect(connection.requests.filter(({ method }) => method === "oauth.session.cancel")).toHaveLength(1);
    await service.disconnect();
  });

  it("linearizes concurrent browser opens so no caller observes opened before shell success", async () => {
    const authorizationUrl = validAuthorizationUrl();
    const shellGate = deferred<void>();
    const openExternal = vi.fn(() => shellGate.promise);
    const connection = connectionFor((method) => {
      if (method === "oauth.session.start" || method === "oauth.session.status") {
        return oauthSnapshot("oauth-session-1", authorizationUrl);
      }
      if (method === "oauth.session.cancel") return cancelledSnapshot("oauth-session-1");
      throw new Error(`Unexpected request: ${method}`);
    });
    const service = await connectedService(connection, openExternal);

    let startSettled = false;
    const starting = service.startRuntimeOAuth("host-a", "openai-codex").finally(() => { startSettled = true; });
    await waitFor(() => connection.requests.some(({ method }) => method === "oauth.session.start"));
    const status = service.runtimeOAuthStatus("host-a", "oauth-session-1");
    await flushMicrotasks();
    expect(openExternal).toHaveBeenCalledOnce();
    expect(startSettled).toBe(false);

    shellGate.resolve();
    await expect(Promise.all([starting, status])).resolves.toEqual([
      expect.objectContaining({ interaction: { kind: "browser", state: "opened" } }),
      expect.objectContaining({ interaction: { kind: "browser", state: "opened" } }),
    ]);
    await service.disconnect();
  });

  it("shares one failing shell launch across callers and cancels the exact session once", async () => {
    const shellGate = deferred<void>();
    const openExternal = vi.fn(() => shellGate.promise);
    const connection = connectionFor((method) => {
      if (method === "oauth.session.start" || method === "oauth.session.status") {
        return oauthSnapshot("oauth-session-1", validAuthorizationUrl());
      }
      if (method === "oauth.session.cancel") return cancelledSnapshot("oauth-session-1");
      throw new Error(`Unexpected request: ${method}`);
    });
    const service = await connectedService(connection, openExternal);
    const starting = service.startRuntimeOAuth("host-a", "openai-codex");
    await waitFor(() => connection.requests.some(({ method }) => method === "oauth.session.start"));
    const status = service.runtimeOAuthStatus("host-a", "oauth-session-1");

    shellGate.reject(new Error("shell failed"));
    const results = await Promise.allSettled([starting, status]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(openExternal).toHaveBeenCalledOnce();
    expect(connection.requests.filter(({ method }) => method === "oauth.session.cancel")).toHaveLength(1);
    await service.disconnect();
  });

  it("does not close the host connection until disconnect receives terminal cancellation", async () => {
    const cancelGate = deferred<unknown>();
    const connection = connectionFor((method) => {
      if (method === "oauth.session.start") return oauthSnapshot("oauth-session-1", validAuthorizationUrl());
      if (method === "oauth.session.cancel") return cancelGate.promise;
      throw new Error(`Unexpected request: ${method}`);
    });
    const service = await connectedService(connection, async () => undefined);
    await service.startRuntimeOAuth("host-a", "openai-codex");

    const disconnecting = service.disconnect();
    await waitFor(() => connection.requests.some(({ method }) => method === "oauth.session.cancel"));
    expect(connection.isClosed).toBe(false);
    cancelGate.resolve(cancelledSnapshot("oauth-session-1"));
    await disconnecting;
    expect(connection.isClosed).toBe(true);
  });

  it("drains the exact old host before a target switch closes its connection", async () => {
    const cancelGate = deferred<unknown>();
    const local = connectionFor((method) => {
      if (method === "oauth.session.start") return oauthSnapshot("oauth-session-1", validAuthorizationUrl());
      if (method === "oauth.session.cancel") return cancelGate.promise;
      throw new Error(`Unexpected request: ${method}`);
    });
    const remote = connectionFor(() => { throw new Error("Unexpected remote request"); }, health("host-b", []));
    connectSshHost.mockReturnValue(remote);
    const service = await connectedService(local, async () => undefined);
    (service as unknown as { discoveredAliases: Set<string> }).discoveredAliases.add("remote");
    await service.startRuntimeOAuth("host-a", "openai-codex");

    const switching = service.connect({ kind: "ssh", alias: "remote" });
    await waitFor(() => local.requests.some(({ method }) => method === "oauth.session.cancel"));
    expect(local.isClosed).toBe(false);
    expect(connectSshHost).not.toHaveBeenCalled();
    cancelGate.resolve(cancelledSnapshot("oauth-session-1"));
    await expect(switching).resolves.toMatchObject({ phase: "online", hostId: "host-b" });
    expect(local.isClosed).toBe(true);
    await service.disconnect();
  });

  it("does not adopt a pre-restart OAuth session into a fresh main authority", async () => {
    const firstConnection = connectionFor((method) => {
      if (method === "oauth.session.start") return oauthSnapshot("oauth-session-1", validAuthorizationUrl());
      if (method === "oauth.session.cancel") return cancelledSnapshot("oauth-session-1");
      throw new Error(`Unexpected request: ${method}`);
    });
    const first = await connectedService(firstConnection, async () => undefined);
    await first.startRuntimeOAuth("host-a", "openai-codex");

    const secondConnection = connectionFor((method) => { throw new Error(`Unexpected request: ${method}`); });
    const second = await connectedService(secondConnection, async () => undefined);
    await expect(second.runtimeOAuthStatus("host-a", "oauth-session-1")).rejects.toMatchObject({
      code: "runtime.oauth_session_untracked",
    });
    expect(secondConnection.requests.filter(({ method }) => method === "oauth.session.status")).toHaveLength(0);
    await first.disconnect();
    await second.disconnect();
  });

  it("reuses one start operation identity when a terminal host response is lost", async () => {
    let providerStarts = 0;
    let admittedOperationId: string | undefined;
    const connection = connectionFor((method, params) => {
      if (method !== "oauth.session.start") throw new Error(`Unexpected request: ${method}`);
      const operationId = (params as { operationId: string }).operationId;
      if (!admittedOperationId) {
        admittedOperationId = operationId;
        providerStarts += 1;
        throw new Error("terminal response was lost");
      }
      expect(operationId).toBe(admittedOperationId);
      return {
        sessionId: "oauth-session-terminal",
        providerId: "openai-codex",
        phase: "completed",
        expiresAt: "2099-08-07T18:00:00.000Z",
        configured: true,
      };
    });
    const service = await connectedService(connection, async () => undefined);

    await expect(service.startRuntimeOAuth("host-a", "openai-codex")).resolves.toMatchObject({
      sessionId: "oauth-session-terminal",
      phase: "completed",
      configured: true,
    });
    expect(providerStarts).toBe(1);
    expect(connection.requests.filter(({ method }) => method === "oauth.session.start")).toHaveLength(2);
    expect(admittedOperationId).toMatch(/^[0-9a-f-]{36}$/);
    await service.disconnect();
  });

  it("fails closed on disconnect and target switch when an admitted start response stays ambiguous", async () => {
    const connection = connectionFor((method) => {
      if (method === "oauth.session.start") throw new Error("response lost");
      throw new Error(`Unexpected request: ${method}`);
    });
    const service = await connectedService(connection, async () => undefined);
    await expect(service.startRuntimeOAuth("host-a", "openai-codex")).rejects.toMatchObject({
      code: "runtime.oauth_start_ambiguous",
    });
    expect(connection.requests.filter(({ method }) => method === "oauth.session.start")).toHaveLength(2);
    const operationIds = connection.requests
      .filter(({ method }) => method === "oauth.session.start")
      .map(({ params }) => (params as { operationId: string }).operationId);
    expect(new Set(operationIds).size).toBe(1);

    await expect(service.disconnect()).rejects.toMatchObject({ code: "runtime.oauth_drain_unconfirmed" });
    expect(connection.isClosed).toBe(false);
    await expect(service.connect({ kind: "local" })).rejects.toMatchObject({
      code: "runtime.oauth_drain_unconfirmed",
    });
    expect(connection.isClosed).toBe(false);
  });

  it("does not project malformed OAuth snapshot diagnostics or provider-controlled values", async () => {
    const secret = "https://secret.example/callback?token=must-not-cross";
    const connection = connectionFor((method) => {
      if (method === "oauth.session.start") {
        return {
          sessionId: "oauth-session-1",
          providerId: "openai-codex",
          phase: secret,
          expiresAt: "2099-08-07T18:00:00.000Z",
        };
      }
      if (method === "oauth.session.cancel") return cancelledSnapshot("oauth-session-1");
      throw new Error(`Unexpected request: ${method}`);
    });
    const service = await connectedService(connection, async () => undefined);

    const error = await service.startRuntimeOAuth("host-a", "openai-codex").catch((caught) => caught);

    expect(error).toMatchObject({
      code: "protocol.oauth_snapshot_invalid",
      message: "The host returned an invalid Prime Agent sign-in status.",
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    await service.disconnect();
  });

  it("normalizes host status failures before they can cross IPC", async () => {
    const connection = connectionFor((method) => {
      if (method === "oauth.session.start") return oauthSnapshot("oauth-session-1", validAuthorizationUrl());
      if (method === "oauth.session.status") {
        throw new Error("https://secret.example/status?access_token=must-not-cross");
      }
      if (method === "oauth.session.cancel") return cancelledSnapshot("oauth-session-1");
      throw new Error(`Unexpected request: ${method}`);
    });
    const service = await connectedService(connection, async () => undefined);
    await service.startRuntimeOAuth("host-a", "openai-codex");

    const error = await service.runtimeOAuthStatus("host-a", "oauth-session-1").catch((caught) => caught);

    expect(error).toMatchObject({
      code: "runtime.oauth_status_failed",
      message: "Prime Agent sign-in status could not be read from this host.",
      retryable: true,
    });
    expect(JSON.stringify(error)).not.toMatch(/secret\.example|access_token|must-not-cross/);
    await service.disconnect();
  });

  it("normalizes host cancellation failures before they can cross IPC", async () => {
    let cancellationAttempts = 0;
    const connection = connectionFor((method) => {
      if (method === "oauth.session.start") return oauthSnapshot("oauth-session-1", validAuthorizationUrl());
      if (method === "oauth.session.cancel") {
        cancellationAttempts += 1;
        if (cancellationAttempts === 1) {
          throw new Error("https://secret.example/cancel?refresh_token=must-not-cross");
        }
        return cancelledSnapshot("oauth-session-1");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const service = await connectedService(connection, async () => undefined);
    await service.startRuntimeOAuth("host-a", "openai-codex");

    const error = await service.cancelRuntimeOAuth("host-a", "oauth-session-1").catch((caught) => caught);

    expect(error).toMatchObject({
      code: "runtime.oauth_cancel_failed",
      message: "Prime Agent sign-in cancellation could not be confirmed by this host.",
      retryable: true,
    });
    expect(JSON.stringify(error)).not.toMatch(/secret\.example|refresh_token|must-not-cross/);
    await service.disconnect();
  });
});

function connectionFor(
  respond: (method: string, params: unknown) => unknown,
  healthResponse = health(),
): TestConnection {
  return new TestConnection((method, params) => {
    if (method === "health.get") return healthResponse;
    return respond(method, params);
  });
}

async function connectedService(
  connection: TestConnection,
  openExternal: (url: string) => Promise<void>,
): Promise<DesktopControlService> {
  const directory = await mkdtemp(path.join(tmpdir(), "prime-main-oauth-test-"));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "control"), { recursive: true });
  connectLocalHostd.mockResolvedValue(connection);
  const service = new DesktopControlService({ app: testApp(directory), openExternal });
  await service.connect({ kind: "local" });
  return service;
}

function health(hostId = "host-a", capabilities = ["runtime_oauth_v1"]) {
  return {
    protocolVersion: 1,
    hostdVersion: "0.1.0",
    startedAt: "2026-08-07T17:00:00.000Z",
    checkedAt: "2026-08-07T17:00:01.000Z",
    serviceState: "ready",
    host: { hostId },
    capabilities,
  };
}

function cancelledSnapshot(sessionId: string) {
  return { ...oauthSnapshot(sessionId), phase: "cancelled" };
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for test state");
}

function oauthSnapshot(sessionId: string, authorizationUrl?: string) {
  return {
    sessionId,
    providerId: "openai-codex",
    phase: "awaiting_user",
    expiresAt: "2099-08-07T18:00:00.000Z",
    ...(authorizationUrl ? { authorization: { url: authorizationUrl } } : {}),
  };
}

function validAuthorizationUrl(origin = "https://auth.openai.com"): string {
  const url = new URL("/oauth/authorize", origin);
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

function testApp(directory: string): App {
  return {
    getPath: () => directory,
    getVersion: () => "0.1.0",
  } as unknown as App;
}
