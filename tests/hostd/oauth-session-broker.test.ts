import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostOAuthSessionBroker,
  type HostOAuthProvider,
  type HostOAuthStorage,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
} from "../../src/hostd/oauth-session-broker";
import { OAuthAttemptStore, OAuthAttemptStoreError } from "../../src/hostd/oauth-attempt-store";
import { atomicWriteJson, AtomicWriteAmbiguousCommitError } from "../../src/hostd/atomic-files";
import {
  createRuntimeOAuthAttemptTerminalV1,
  createRuntimeOAuthAttemptV1,
} from "../../src/shared/runtime-oauth-attempt";
import {
  RuntimeOAuthAttemptAcknowledgeResultSchema,
  RuntimeOAuthAttemptCancelResultSchema,
  RuntimeOAuthAttemptStartResultSchema,
  RuntimeOAuthAttemptStatusResultSchema,
} from "../../src/shared/protocol";

const HOST_ID = "prime-host-1";
const AUTHORITY_ID = "trusted-desktop";
const SECRET_CREDENTIALS: OAuthCredentials = {
  access: "access-secret-that-must-never-cross-the-boundary",
  refresh: "refresh-secret-that-must-never-cross-the-boundary",
  expires: 2_000_000_000_000,
  type: "api_key",
};
const ATTEMPT_NOW = Date.parse("2026-08-10T12:00:00.000Z");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })));
});

describe("host OAuth session broker", () => {
  it("runs callback/manual login and confirms durable storage without projecting credentials", async () => {
    const storage = storagePort();
    const provider: HostOAuthProvider = {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      usesCallbackServer: true,
      login: vi.fn(async (callbacks) => {
        callbacks.onAuth({
          url: "https://auth.example.test/authorize?state=public-ephemeral-state",
          instructions: "Continue in your browser",
        });
        const code = await callbacks.onManualCodeInput?.();
        expect(code).toBe("redirect-code");
        return SECRET_CREDENTIALS;
      }),
    };
    const broker = brokerFor(provider, storage);

    const started = broker.start(binding({ providerId: provider.id }));
    expect(started).toMatchObject({
      phase: "awaiting_user",
      authorization: { url: "https://auth.example.test/authorize?state=public-ephemeral-state" },
      challenge: { kind: "manual_redirect" },
    });
    expect(JSON.stringify(started)).not.toContain("access-secret");

    const challengeId = requiredChallengeId(started);
    broker.respond(binding({ sessionId: started.sessionId, challengeId, value: "redirect-code" }));
    await waitFor(() => broker.status(binding({ sessionId: started.sessionId })).phase === "completed");

    const completed = broker.status(binding({ sessionId: started.sessionId }));
    expect(completed).toMatchObject({ phase: "completed", configured: true });
    expect(JSON.stringify(completed)).not.toMatch(
      /access-secret|refresh-secret|initialAuthorityId|cancelIntent|recoveryReason|oauthAttempts|argv|environment/i,
    );
    expect(storage.set).toHaveBeenCalledWith(provider.id, { ...SECRET_CREDENTIALS, type: "oauth" });
    expect(storage.calls).toEqual(["set", "drainErrors", "reload", "getAuthStatus"]);
    expect(() => broker.respond(binding({
      sessionId: started.sessionId,
      challengeId,
      value: "replayed-code",
    }))).toThrowError(expect.objectContaining({ code: "OAUTH_CHALLENGE_STALE" }));
  });

  it("retires manual input when a callback-server authorization wins the provider race", async () => {
    const storage = storagePort();
    const provider: HostOAuthProvider = {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      usesCallbackServer: true,
      login: async (callbacks) => {
        callbacks.onAuth({ url: "https://auth.example.test/authorize" });
        void callbacks.onManualCodeInput?.();
        return SECRET_CREDENTIALS;
      },
    };
    const broker = brokerFor(provider, storage);
    const started = broker.start(binding({ providerId: provider.id }));
    expect(started.challenge?.kind).toBe("manual_redirect");

    await waitFor(() => broker.status(binding({ sessionId: started.sessionId })).phase === "completed");
    expect(storage.set).toHaveBeenCalledOnce();
    expect(broker.status(binding({ sessionId: started.sessionId }))).not.toHaveProperty("challenge");
  });

  it("settles an ignored manual-input race when the session is cancelled", async () => {
    const credentials = deferred<OAuthCredentials>();
    const storage = storagePort();
    const provider: HostOAuthProvider = {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      usesCallbackServer: true,
      login: async (callbacks) => {
        callbacks.onAuth({ url: "https://auth.example.test/authorize" });
        // Real callback-server providers may deliberately leave this promise
        // unobserved while a browser callback and manual paste race.
        void callbacks.onManualCodeInput?.();
        return credentials.promise;
      },
    };
    const broker = brokerFor(provider, storage);
    const started = broker.start(binding({ providerId: provider.id }));
    expect(started.challenge?.kind).toBe("manual_redirect");

    await expect(broker.cancel(binding({ sessionId: started.sessionId }))).resolves.toMatchObject({
      phase: "cancelled",
    });
    await flushMicrotasks();
    credentials.resolve(SECRET_CREDENTIALS);
    await flushMicrotasks();

    expect(storage.set).not.toHaveBeenCalled();
    expect(broker.status(binding({ sessionId: started.sessionId })).phase).toBe("cancelled");
  });

  it("supports bounded prompt and selection challenges with single-use identifiers", async () => {
    const storage = storagePort();
    const provider: HostOAuthProvider = {
      id: "github-copilot",
      name: "GitHub Copilot",
      login: async (callbacks) => {
        const enterprise = await callbacks.onPrompt({
          message: "GitHub Enterprise domain (optional)",
          placeholder: "github.example.com",
          allowEmpty: true,
        });
        expect(enterprise).toBe("");
        const selected = await callbacks.onSelect?.({
          message: "Choose an account",
          options: [
            { id: "personal", label: "Personal" },
            { id: "work", label: "Work" },
          ],
        });
        expect(selected).toBe("work");
        return SECRET_CREDENTIALS;
      },
    };
    const broker = brokerFor(provider, storage);

    const started = broker.start(binding({ providerId: provider.id }));
    expect(started.challenge).toMatchObject({ kind: "text", allowEmpty: true });
    const promptId = requiredChallengeId(started);
    broker.respond(binding({ sessionId: started.sessionId, challengeId: promptId, value: "" }));
    await waitFor(() => broker.status(binding({ sessionId: started.sessionId })).challenge?.kind === "select");

    const selecting = broker.status(binding({ sessionId: started.sessionId }));
    const selectId = requiredChallengeId(selecting);
    expect(() => broker.respond(binding({
      sessionId: started.sessionId,
      challengeId: selectId,
      value: "unknown-account",
    }))).toThrowError(expect.objectContaining({ code: "OAUTH_RESPONSE_INVALID" }));
    broker.respond(binding({ sessionId: started.sessionId, challengeId: selectId, value: "work" }));
    await waitFor(() => broker.status(binding({ sessionId: started.sessionId })).phase === "completed");
  });

  it("rejects non-HTTPS authorization URLs before any credentials can be persisted", async () => {
    const storage = storagePort();
    const provider: HostOAuthProvider = {
      id: "anthropic",
      name: "Anthropic",
      login: async (callbacks) => {
        // A provider cannot bypass the broker by swallowing callback validation.
        try {
          callbacks.onAuth({ url: "http://attacker.invalid/authorize?token=sentinel" });
        } catch {
          // Intentionally ignored by this adversarial fixture.
        }
        return SECRET_CREDENTIALS;
      },
    };
    const broker = brokerFor(provider, storage);
    const started = broker.start(binding({ providerId: provider.id }));

    await waitFor(() => broker.status(binding({ sessionId: started.sessionId })).phase === "failed");
    const failed = broker.status(binding({ sessionId: started.sessionId }));
    expect(failed).toMatchObject({
      phase: "failed",
      error: { code: "OAUTH_PROVIDER_CONTRACT_INVALID", retryable: false },
    });
    expect(JSON.stringify(failed)).not.toContain("sentinel");
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("binds sessions to both the expected host and initiating authority", () => {
    const provider = pendingProvider("openai-codex");
    const resolver = vi.fn(() => provider.provider);
    const broker = new HostOAuthSessionBroker({
      hostId: HOST_ID,
      providers: { getProvider: resolver },
      storage: storagePort(),
      idFactory: sequentialIds(),
    });

    expect(() => broker.start({
      expectedHostId: "stale-host",
      authorityId: AUTHORITY_ID,
      providerId: provider.provider.id,
      operationId: "oauth-operation-stale-host",
    })).toThrowError(expect.objectContaining({ code: "HOST_AUTHORITY_MISMATCH" }));
    expect(resolver).not.toHaveBeenCalled();

    const started = broker.start(binding({ providerId: provider.provider.id }));
    expect(() => broker.status({
      expectedHostId: HOST_ID,
      authorityId: "different-device",
      sessionId: started.sessionId,
    })).toThrowError(expect.objectContaining({ code: "OAUTH_SESSION_FORBIDDEN" }));
    provider.credentials.resolve(SECRET_CREDENTIALS);
  });

  it("cancels before commit and discards credentials returned by a non-abortable provider", async () => {
    const provider = pendingProvider("openai-codex");
    const storage = storagePort();
    const broker = brokerFor(provider.provider, storage);
    const started = broker.start(binding({ providerId: provider.provider.id }));

    const cancelled = await broker.cancel(binding({ sessionId: started.sessionId }));
    expect(cancelled.phase).toBe("cancelled");
    expect(provider.signal?.aborted).toBe(true);

    provider.credentials.resolve(SECRET_CREDENTIALS);
    await flushMicrotasks();
    expect(storage.set).not.toHaveBeenCalled();
    expect(broker.status(binding({ sessionId: started.sessionId })).phase).toBe("cancelled");
  });

  it("serializes a provider until its underlying non-abortable run has settled", async () => {
    const provider = pendingProvider("anthropic");
    const broker = brokerFor(provider.provider, storagePort());
    const started = broker.start(binding({ providerId: provider.provider.id }));

    // Lost start responses are reconciled by returning the same live session
    // for the exact host + authority + provider binding.
    expect(broker.start(binding({ providerId: provider.provider.id }))).toEqual(started);
    expect(() => broker.start(binding({
      providerId: provider.provider.id,
      operationId: "oauth-operation-must-not-alias",
    }))).toThrowError(
      expect.objectContaining({ code: "OAUTH_PROVIDER_BUSY" }),
    );
    expect(() => broker.start({
      ...binding({ providerId: provider.provider.id }),
      authorityId: "different-authority",
    })).toThrowError(
      expect.objectContaining({ code: "OAUTH_PROVIDER_BUSY" }),
    );
    await expect(broker.cancel(binding({ sessionId: started.sessionId }))).resolves.toMatchObject({ phase: "cancelled" });
    expect(() => broker.start(binding({
      providerId: provider.provider.id,
      operationId: "oauth-operation-while-provider-drains",
    }))).toThrowError(
      expect.objectContaining({ code: "OAUTH_PROVIDER_BUSY" }),
    );

    provider.credentials.resolve(SECRET_CREDENTIALS);
    await flushMicrotasks();
    const restarted = broker.start(binding({
      providerId: provider.provider.id,
      operationId: "oauth-operation-restart",
    }));
    await waitFor(() => broker.status(binding({ sessionId: restarted.sessionId })).phase === "completed");
  });

  it("returns the exact terminal tombstone for a retried start operation", async () => {
    const provider: HostOAuthProvider = {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      login: vi.fn(async () => SECRET_CREDENTIALS),
    };
    const broker = brokerFor(provider, storagePort());
    const request = binding({ providerId: provider.id, operationId: "oauth-operation-lost-response" });

    const started = broker.start(request);
    await waitFor(() => broker.status(binding({ sessionId: started.sessionId })).phase === "completed");
    const completed = broker.status(binding({ sessionId: started.sessionId }));

    expect(broker.start(request)).toEqual(completed);
    expect(provider.login).toHaveBeenCalledOnce();
  });

  it("does not acknowledge cancellation after credential commit has linearized", async () => {
    const commitGate = deferred<void>();
    const storage = storagePort({
      set: async function set(this: ReturnType<typeof storagePort>) {
        this.calls.push("set");
        await commitGate.promise;
        this.configured = true;
      },
    });
    const provider: HostOAuthProvider = {
      id: "github-copilot",
      name: "GitHub Copilot",
      login: async () => SECRET_CREDENTIALS,
    };
    const broker = brokerFor(provider, storage);
    const started = broker.start(binding({ providerId: provider.id }));
    await waitFor(() => broker.status(binding({ sessionId: started.sessionId })).phase === "committing");

    let cancelSettled = false;
    const cancellation = broker.cancel(binding({ sessionId: started.sessionId })).then((snapshot) => {
      cancelSettled = true;
      return snapshot;
    });
    await flushMicrotasks();
    expect(cancelSettled).toBe(false);

    commitGate.resolve();
    await expect(cancellation).resolves.toMatchObject({ phase: "completed", configured: true });
  });

  it("fails closed after the complete persistence confirmation sequence and sanitizes errors", async () => {
    const storage = storagePort({
      drainErrors: function drainErrors(this: ReturnType<typeof storagePort>) {
        this.calls.push("drainErrors");
        return [new Error("Bearer storage-secret")];
      },
    });
    const provider: HostOAuthProvider = {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      login: async () => SECRET_CREDENTIALS,
    };
    const broker = brokerFor(provider, storage);
    const started = broker.start(binding({ providerId: provider.id }));

    await waitFor(() => broker.status(binding({ sessionId: started.sessionId })).phase === "failed");
    const failed = broker.status(binding({ sessionId: started.sessionId }));
    expect(storage.calls).toEqual(["set", "drainErrors", "reload", "getAuthStatus"]);
    expect(failed).toMatchObject({
      phase: "failed",
      error: { code: "OAUTH_PERSISTENCE_UNCONFIRMED", retryable: true },
    });
    expect(JSON.stringify(failed)).not.toMatch(/storage-secret|access-secret|refresh-secret/);
  });

  it("sanitizes provider failures instead of forwarding exception bodies", async () => {
    const storage = storagePort();
    const provider: HostOAuthProvider = {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      login: async () => {
        throw new Error("token exchange failed: access_token=provider-secret");
      },
    };
    const broker = brokerFor(provider, storage);
    const started = broker.start(binding({ providerId: provider.id }));

    await waitFor(() => broker.status(binding({ sessionId: started.sessionId })).phase === "failed");
    const serialized = JSON.stringify(broker.status(binding({ sessionId: started.sessionId })));
    expect(serialized).toContain("OAuth provider login failed");
    expect(serialized).not.toContain("provider-secret");
  });

  it("expires active sessions, retains bounded tombstones, then forgets them", async () => {
    let nowMs = 0;
    const provider = pendingProvider("openai-codex");
    const storage = storagePort();
    const broker = new HostOAuthSessionBroker({
      hostId: HOST_ID,
      providers: { getProvider: () => provider.provider },
      storage,
      activeTtlMs: 1_000,
      tombstoneTtlMs: 500,
      now: () => nowMs,
      idFactory: sequentialIds(),
    });
    const started = broker.start(binding({ providerId: provider.provider.id }));

    nowMs = 1_000;
    expect(broker.status(binding({ sessionId: started.sessionId }))).toMatchObject({
      phase: "failed",
      error: { code: "OAUTH_SESSION_EXPIRED" },
    });
    expect(provider.signal?.aborted).toBe(true);

    nowMs = 1_499;
    expect(broker.status(binding({ sessionId: started.sessionId })).phase).toBe("failed");
    nowMs = 1_500;
    expect(() => broker.status(binding({ sessionId: started.sessionId }))).toThrowError(
      expect.objectContaining({ code: "OAUTH_SESSION_NOT_FOUND" }),
    );

    provider.credentials.resolve(SECRET_CREDENTIALS);
    await flushMicrotasks();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("expires and aborts an idle provider from its host-owned timer without a status poll", async () => {
    vi.useFakeTimers();
    try {
      const provider = pendingProvider("openai-codex");
      const broker = new HostOAuthSessionBroker({
        hostId: HOST_ID,
        providers: { getProvider: () => provider.provider },
        storage: storagePort(),
        activeTtlMs: 100,
        tombstoneTtlMs: 500,
        idFactory: sequentialIds(),
      });
      const started = broker.start(binding({ providerId: provider.provider.id }));

      await vi.advanceTimersByTimeAsync(100);

      expect(provider.signal?.aborted).toBe(true);
      expect(broker.status(binding({ sessionId: started.sessionId }))).toMatchObject({
        phase: "failed",
        error: { code: "OAUTH_SESSION_EXPIRED" },
      });
      provider.credentials.resolve(SECRET_CREDENTIALS);
      await flushMicrotasks();
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes in-flight work and refuses new sessions after broker close", async () => {
    const provider = pendingProvider("openai-codex");
    const broker = brokerFor(provider.provider, storagePort());
    broker.start(binding({ providerId: provider.provider.id }));

    const closing = broker.close();
    expect(provider.signal?.aborted).toBe(true);
    provider.credentials.resolve(SECRET_CREDENTIALS);
    await closing;

    expect(() => broker.start(binding({ providerId: provider.provider.id }))).toThrowError(
      expect.objectContaining({ code: "OAUTH_REQUEST_INVALID" }),
    );
  });

  it("globally serializes the complete AuthStorage confirmation chain", async () => {
    const firstSet = deferred<void>();
    const calls: string[] = [];
    const configured = new Set<string>();
    const storage: HostOAuthStorage = {
      set: async (providerId) => {
        calls.push(`set:${providerId}`);
        if (providerId === "provider-a") await firstSet.promise;
        configured.add(providerId);
      },
      drainErrors: () => {
        calls.push("drainErrors");
        return [];
      },
      reload: () => {
        calls.push("reload");
      },
      getAuthStatus: (providerId) => {
        calls.push(`getAuthStatus:${providerId}`);
        return { configured: configured.has(providerId) };
      },
    };
    const providers = new Map<string, HostOAuthProvider>([
      ["provider-a", { id: "provider-a", name: "A", login: async () => SECRET_CREDENTIALS }],
      ["provider-b", { id: "provider-b", name: "B", login: async () => SECRET_CREDENTIALS }],
    ]);
    const broker = new HostOAuthSessionBroker({
      hostId: HOST_ID,
      providers: { getProvider: (providerId) => providers.get(providerId) },
      storage,
      idFactory: sequentialIds(),
    });
    const first = broker.start(binding({ providerId: "provider-a" }));
    await waitFor(() => calls[0] === "set:provider-a");
    const second = broker.start(binding({ providerId: "provider-b" }));
    await flushMicrotasks();
    expect(calls).toEqual(["set:provider-a"]);

    firstSet.resolve();
    await waitFor(() => broker.status(binding({ sessionId: first.sessionId })).phase === "completed");
    await waitFor(() => broker.status(binding({ sessionId: second.sessionId })).phase === "completed");
    expect(calls).toEqual([
      "set:provider-a",
      "drainErrors",
      "reload",
      "getAuthStatus:provider-a",
      "set:provider-b",
      "drainErrors",
      "reload",
      "getAuthStatus:provider-b",
    ]);
  });

  it("durably fences login and persistence before each effect and never replays a retained digest", async () => {
    const store = await attemptStore();
    const attempt = durableAttempt("11111111-1111-4111-8111-111111111111");
    const credentials = deferred<OAuthCredentials>();
    const order: string[] = [];
    const originalLoginBoundary = store.markLoginDispatching.bind(store);
    vi.spyOn(store, "markLoginDispatching").mockImplementation(async (...args) => {
      order.push("login-boundary:begin");
      const record = await originalLoginBoundary(...args);
      order.push("login-boundary:end");
      return record;
    });
    const originalPersistenceBoundary = store.markPersistenceDispatching.bind(store);
    vi.spyOn(store, "markPersistenceDispatching").mockImplementation(async (...args) => {
      order.push("persistence-boundary:begin");
      const record = await originalPersistenceBoundary(...args);
      order.push("persistence-boundary:end");
      return record;
    });
    let configured = false;
    const storage: HostOAuthStorage = {
      set: vi.fn(async () => { order.push("storage:set"); configured = true; }),
      drainErrors: vi.fn(async () => []),
      reload: vi.fn(async () => undefined),
      getAuthStatus: vi.fn(async () => ({ configured })),
    };
    const provider: HostOAuthProvider = {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      login: vi.fn(() => {
        order.push("provider:login");
        return credentials.promise;
      }),
    };
    const broker = durableBroker(store, provider, storage);

    await vi.waitFor(async () => {
      await expect(broker.attemptEffectAdmissionReady()).resolves.toBe(true);
    });
    const started = await broker.startAttempt({ authorityId: AUTHORITY_ID, attempt });
    expect(started).toMatchObject({
      attemptDigest: attempt.attemptDigest,
      record: { phase: "login_dispatching", sessionId: started.live?.sessionId },
      live: { phase: "starting" },
    });
    expect(() => RuntimeOAuthAttemptStartResultSchema.parse(started)).not.toThrow();
    expect(JSON.stringify(started)).not.toMatch(/initialAuthorityId|cancelIntent|recoveryReason/i);
    expect(order).toEqual(["login-boundary:begin", "login-boundary:end", "provider:login"]);
    await expect(broker.startAttempt({ authorityId: AUTHORITY_ID, attempt })).rejects.toMatchObject({
      code: "OAUTH_ATTEMPT_RECONCILE_REQUIRED",
    });
    await expect(broker.startAttempt({
      authorityId: AUTHORITY_ID,
      attempt: durableAttempt("22222222-2222-4222-8222-222222222222"),
    })).rejects.toMatchObject({ code: "OAUTH_PROVIDER_BUSY" });
    expect(provider.login).toHaveBeenCalledOnce();
    await expect(broker.attemptEffectAdmissionReady()).resolves.toBe(false);

    credentials.resolve(SECRET_CREDENTIALS);
    await vi.waitFor(async () => {
      expect((await broker.statusAttempt({ attempt })).record?.phase).toBe("completed");
    });
    expect(order).toEqual([
      "login-boundary:begin",
      "login-boundary:end",
      "provider:login",
      "persistence-boundary:begin",
      "persistence-boundary:end",
      "storage:set",
    ]);
    const completed = await broker.statusAttempt({ attempt });
    expect(() => RuntimeOAuthAttemptStatusResultSchema.parse(completed)).not.toThrow();
    expect(completed.record?.terminal?.body).toMatchObject({
      phase: "completed",
      resolution: "persistence_confirmed",
      configuredObserved: true,
    });
    await vi.waitFor(async () => {
      await expect(broker.attemptEffectAdmissionReady()).resolves.toBe(true);
    });
    expect(JSON.stringify(completed)).not.toMatch(
      /access-secret|refresh-secret|initialAuthorityId|cancelIntent|recoveryReason|oauthAttempts|argv|environment/i,
    );
  });

  it("joins an admitted durable start on close and never starts login after shutdown authority", async () => {
    const store = await attemptStore();
    const attempt = durableAttempt("12121212-1212-4212-8212-121212121212");
    const dispatchPublished = deferred<void>();
    const releaseDispatch = deferred<void>();
    const originalLoginBoundary = store.markLoginDispatching.bind(store);
    vi.spyOn(store, "markLoginDispatching").mockImplementation(async (...args) => {
      const record = await originalLoginBoundary(...args);
      dispatchPublished.resolve();
      await releaseDispatch.promise;
      return record;
    });
    const provider = pendingProvider("openai-codex");
    const storage = storagePort();
    const broker = durableBroker(store, provider.provider, storage);

    const starting = broker.startAttempt({ authorityId: AUTHORITY_ID, attempt });
    await dispatchPublished.promise;
    let closeSettled = false;
    const closing = broker.close().then(() => {
      closeSettled = true;
    });
    await flushMicrotasks();

    expect(closeSettled).toBe(false);
    expect(provider.signal).toBeUndefined();
    const rejectedStart = expect(starting).rejects.toMatchObject({ code: "OAUTH_REQUEST_INVALID" });
    releaseDispatch.resolve();
    await rejectedStart;
    await closing;

    expect(provider.signal).toBeUndefined();
    expect(storage.set).not.toHaveBeenCalled();
    const retained = await store.get(attempt);
    expect(retained?.phase).toBe("login_dispatching");
    expect(retained?.terminal).toBeUndefined();
  });

  it("keeps durable status store-only and read-only", async () => {
    const store = await attemptStore();
    const attempt = durableAttempt("33333333-3333-4333-8333-333333333333");
    const prepared = await store.prepare({
      attempt,
      sessionId: "durable-status-session",
      initialAuthorityId: AUTHORITY_ID,
      observedAt: attempt.identity.requestedAt,
      expiresAt: "2026-08-10T12:15:00.000Z",
    });
    const before = JSON.stringify(await store.list());
    const getProvider = vi.fn(() => { throw new Error("provider lookup must not run"); });
    const broker = new HostOAuthSessionBroker({
      hostId: HOST_ID,
      providers: { getProvider },
      storage: storagePort(),
      attemptStore: store,
      now: () => { throw new Error("clock must not run"); },
    });

    expect(() => broker.start(binding({ providerId: "openai-codex" }))).toThrowError(
      expect.objectContaining({ code: "OAUTH_ATTEMPT_RECONCILE_REQUIRED" }),
    );
    await expect(broker.statusAttempt({ attempt })).resolves.toEqual({
      attemptDigest: attempt.attemptDigest,
      record: {
        recordVersion: 1,
        attempt,
        revision: prepared.record.revision,
        sessionId: prepared.record.sessionId,
        phase: prepared.record.phase,
        createdAt: prepared.record.createdAt,
        updatedAt: prepared.record.updatedAt,
        expiresAt: prepared.record.expiresAt,
      },
    });
    expect(getProvider).not.toHaveBeenCalled();
    expect(JSON.stringify(await store.list())).toBe(before);
  });

  it("rejects an older connection start after a newer connection observed exact absence", async () => {
    const store = await attemptStore();
    const attempt = durableAttempt("34343434-3434-4434-8434-343434343434");
    const provider = pendingProvider("openai-codex");
    const storage = storagePort();
    const broker = durableBroker(store, provider.provider, storage);
    const olderAdmission = { generation: 1n, isInputOpen: () => true };
    const replacementAdmission = { generation: 2n, isInputOpen: () => true };

    await expect(broker.statusAttempt({ attempt }, replacementAdmission)).resolves.toEqual({
      attemptDigest: attempt.attemptDigest,
      record: null,
    });
    await expect(broker.startAttempt(
      { authorityId: AUTHORITY_ID, attempt },
      olderAdmission,
    )).rejects.toMatchObject({ code: "OAUTH_ATTEMPT_CONNECTION_SUPERSEDED" });

    expect(await store.get(attempt)).toBeUndefined();
    expect(provider.signal).toBeUndefined();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("persists cancelling, waits for positive provider retirement, then emits exact terminal evidence", async () => {
    const store = await attemptStore();
    const attempt = durableAttempt("44444444-4444-4444-8444-444444444444");
    const pending = pendingProvider("openai-codex");
    const storage = storagePort();
    const broker = durableBroker(store, pending.provider, storage);
    await broker.startAttempt({ authorityId: AUTHORITY_ID, attempt });

    let cancellationSettled = false;
    const cancellation = broker.cancelAttempt({ attempt }).then((result) => {
      cancellationSettled = true;
      return result;
    });
    await vi.waitFor(async () => {
      expect((await store.get(attempt))?.phase).toBe("cancelling");
    });
    expect(pending.signal?.aborted).toBe(true);
    expect(cancellationSettled).toBe(false);
    pending.credentials.resolve(SECRET_CREDENTIALS);

    const cancelled = await cancellation;
    expect(cancelled).toMatchObject({
      record: {
        phase: "cancelled",
        terminal: { body: { resolution: "user_cancelled", configuredObserved: null } },
      },
      live: { phase: "cancelled" },
    });
    expect(() => RuntimeOAuthAttemptCancelResultSchema.parse(cancelled)).not.toThrow();
    expect(JSON.stringify(cancelled)).not.toMatch(/initialAuthorityId|cancelIntent|recoveryReason/i);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("waits for a linearized durable persistence run and returns its terminal outcome", async () => {
    const store = await attemptStore();
    const attempt = durableAttempt("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const persistence = deferred<void>();
    let configured = false;
    const storage: HostOAuthStorage = {
      set: vi.fn(async () => {
        await persistence.promise;
        configured = true;
      }),
      drainErrors: vi.fn(async () => []),
      reload: vi.fn(async () => undefined),
      getAuthStatus: vi.fn(async () => ({ configured })),
    };
    const provider: HostOAuthProvider = {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      login: vi.fn(async () => SECRET_CREDENTIALS),
    };
    const broker = durableBroker(store, provider, storage);
    await broker.startAttempt({ authorityId: AUTHORITY_ID, attempt });
    await vi.waitFor(async () => {
      expect((await store.get(attempt))?.phase).toBe("persistence_dispatching");
    });

    let settled = false;
    const cancellation = broker.cancelAttempt({ attempt }).then((result) => {
      settled = true;
      return result;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    persistence.resolve();
    await expect(cancellation).resolves.toMatchObject({
      record: {
        phase: "completed",
        terminal: { body: { resolution: "persistence_confirmed", configuredObserved: true } },
      },
    });
  });

  it("expires a durable login before accepting late credentials even if its timer callback was delayed", async () => {
    const store = await attemptStore();
    const attempt = durableAttempt("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const credentials = deferred<OAuthCredentials>();
    const provider: HostOAuthProvider = {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      login: vi.fn(() => credentials.promise),
    };
    const storage = storagePort();
    let nowMs = ATTEMPT_NOW;
    const broker = new HostOAuthSessionBroker({
      hostId: HOST_ID,
      providers: { getProvider: () => provider },
      storage,
      attemptStore: store,
      activeTtlMs: 1_000,
      now: () => nowMs,
      idFactory: sequentialIds(),
    });
    await broker.startAttempt({ authorityId: AUTHORITY_ID, attempt });
    nowMs += 1_000;
    credentials.resolve(SECRET_CREDENTIALS);

    await vi.waitFor(async () => {
      expect(await broker.statusAttempt({ attempt })).toMatchObject({
        record: {
          phase: "failed",
          terminal: { body: { resolution: "expired", configuredObserved: null } },
        },
      });
    });
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("retains the provider barrier and requires reconciliation when helper retirement is uncertain", async () => {
    const store = await attemptStore();
    const attempt = durableAttempt("55555555-5555-4555-8555-555555555555");
    const terminationError = Object.assign(new Error("private helper detail"), {
      name: "RuntimeOAuthHelperTerminationError",
      code: "RUNTIME_OAUTH_HELPER_FAILED",
      terminationObserved: false,
    });
    const provider: HostOAuthProvider = {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      login: vi.fn((callbacks) => new Promise<OAuthCredentials>((_resolve, reject) => {
        callbacks.signal?.addEventListener("abort", () => reject(terminationError), { once: true });
      })),
    };
    const broker = durableBroker(store, provider, storagePort());
    await broker.startAttempt({ authorityId: AUTHORITY_ID, attempt });

    await expect(broker.cancelAttempt({ attempt })).rejects.toMatchObject({
      code: "OAUTH_ATTEMPT_RECONCILE_REQUIRED",
    });
    await expect(broker.statusAttempt({ attempt })).resolves.toMatchObject({
      record: {
        phase: "recovery_required",
      },
    });
    expect(await store.get(attempt)).toMatchObject({
      phase: "recovery_required",
      recoveryReason: "cancelling_helper_liveness_unconfirmed",
    });
    expect(JSON.stringify(await broker.statusAttempt({ attempt }))).not.toMatch(
      /initialAuthorityId|cancelIntent|recoveryReason|private helper detail/i,
    );
    await expect(broker.startAttempt({
      authorityId: AUTHORITY_ID,
      attempt: durableAttempt("66666666-6666-4666-8666-666666666666"),
    })).rejects.toMatchObject({ code: "OAUTH_PROVIDER_BUSY" });
    expect(provider.login).toHaveBeenCalledOnce();
  });

  it("maps login and storage liveness uncertainty to their exact durable recovery barriers", async () => {
    const loginStore = await attemptStore();
    const loginAttempt = durableAttempt("99999999-9999-4999-8999-999999999999");
    const loginProvider: HostOAuthProvider = {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      login: vi.fn(async () => { throw helperTerminationError(); }),
    };
    const loginBroker = durableBroker(loginStore, loginProvider, storagePort());
    await loginBroker.startAttempt({ authorityId: AUTHORITY_ID, attempt: loginAttempt });
    await vi.waitFor(async () => {
      expect(await loginBroker.statusAttempt({ attempt: loginAttempt })).toMatchObject({
        record: {
          phase: "recovery_required",
        },
      });
    });
    expect(await loginStore.get(loginAttempt)).toMatchObject({
      recoveryReason: "login_helper_liveness_unconfirmed",
    });
    await expect(loginBroker.attemptEffectAdmissionReady()).resolves.toBe(false);

    const storageStore = await attemptStore();
    const storageAttempt = durableAttempt("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const storageError = helperTerminationError();
    const storage: HostOAuthStorage = {
      set: vi.fn(async () => undefined),
      drainErrors: vi.fn(async () => []),
      reload: vi.fn(async () => undefined),
      getAuthStatus: vi.fn(async () => { throw storageError; }),
    };
    const storageProvider: HostOAuthProvider = {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      login: vi.fn(async () => SECRET_CREDENTIALS),
    };
    const storageBroker = durableBroker(storageStore, storageProvider, storage);
    await storageBroker.startAttempt({ authorityId: AUTHORITY_ID, attempt: storageAttempt });
    await vi.waitFor(async () => {
      expect(await storageBroker.statusAttempt({ attempt: storageAttempt })).toMatchObject({
        record: {
          phase: "recovery_required",
        },
      });
    });
    expect(await storageStore.get(storageAttempt)).toMatchObject({
      recoveryReason: "storage_helper_liveness_unconfirmed",
    });
    expect(storage.set).toHaveBeenCalledOnce();
    await expect(storageBroker.attemptEffectAdmissionReady()).resolves.toBe(false);
  });

  it("emits fixed durable provider and persistence failure evidence without forwarding secrets", async () => {
    const providerStore = await attemptStore();
    const providerAttempt = durableAttempt("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    const provider: HostOAuthProvider = {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      login: vi.fn(async () => { throw new Error("token exchange access_token=provider-secret"); }),
    };
    const providerBroker = durableBroker(providerStore, provider, storagePort());
    await providerBroker.startAttempt({ authorityId: AUTHORITY_ID, attempt: providerAttempt });
    let providerFailure: Awaited<ReturnType<typeof providerBroker.statusAttempt>> | undefined;
    await vi.waitFor(async () => {
      providerFailure = await providerBroker.statusAttempt({ attempt: providerAttempt });
      expect(providerFailure.record?.phase).toBe("failed");
    });
    expect(providerFailure?.record?.terminal?.body).toMatchObject({
      resolution: "provider_login_failed",
      configuredObserved: null,
    });
    expect(JSON.stringify(providerFailure)).not.toContain("provider-secret");

    const persistenceStore = await attemptStore();
    const persistenceAttempt = durableAttempt("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    const storage = storagePort({
      drainErrors: function drainErrors(this: ReturnType<typeof storagePort>) {
        this.calls.push("drainErrors");
        return [new Error("refresh_token=persistence-secret")];
      },
    });
    const persistenceProvider: HostOAuthProvider = {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro",
      login: vi.fn(async () => SECRET_CREDENTIALS),
    };
    const persistenceBroker = durableBroker(persistenceStore, persistenceProvider, storage);
    await persistenceBroker.startAttempt({ authorityId: AUTHORITY_ID, attempt: persistenceAttempt });
    let persistenceFailure: Awaited<ReturnType<typeof persistenceBroker.statusAttempt>> | undefined;
    await vi.waitFor(async () => {
      persistenceFailure = await persistenceBroker.statusAttempt({ attempt: persistenceAttempt });
      expect(persistenceFailure.record?.phase).toBe("failed");
    });
    expect(persistenceFailure?.record?.terminal?.body).toMatchObject({
      resolution: "persistence_failed",
      configuredObserved: null,
    });
    expect(JSON.stringify(persistenceFailure)).not.toMatch(/persistence-secret|access-secret|refresh-secret/);
  });

  it("never dispatches login and withdraws readiness after an ambiguous journal commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-oauth-broker-ambiguous-"));
    temporaryDirectories.push(directory);
    const paths = { oauthAttempts: join(directory, "attempts") };
    const store = new OAuthAttemptStore(paths, {
      async writeJson(path, value, maxBytes) {
        await atomicWriteJson(path, value, maxBytes);
        throw new AtomicWriteAmbiguousCommitError(path, new Error("simulated directory sync failure"));
      },
    });
    await store.initialize(new Date(ATTEMPT_NOW).toISOString());
    const provider = pendingProvider("openai-codex");
    const broker = durableBroker(store, provider.provider, storagePort());
    const attempt = durableAttempt("88888888-8888-4888-8888-888888888888");

    await expect(broker.startAttempt({ authorityId: AUTHORITY_ID, attempt }))
      .rejects.toBeInstanceOf(AtomicWriteAmbiguousCommitError);
    expect(provider.signal).toBeUndefined();
    await expect(broker.attemptEffectAdmissionReady())
      .rejects.toBeInstanceOf(AtomicWriteAmbiguousCommitError);
    await expect(broker.statusAttempt({ attempt }))
      .rejects.toBeInstanceOf(AtomicWriteAmbiguousCommitError);
  });

  it("uses identity plus expected revision for restart-stable terminal acknowledgement", async () => {
    const store = await attemptStore();
    const attempt = durableAttempt("77777777-7777-4777-8777-777777777777");
    const prepared = await store.prepare({
      attempt,
      sessionId: "durable-ack-session",
      initialAuthorityId: AUTHORITY_ID,
      observedAt: attempt.identity.requestedAt,
      expiresAt: "2026-08-10T12:15:00.000Z",
    });
    const dispatching = await store.markLoginDispatching(prepared.record, "2026-08-10T12:01:00.000Z");
    const failed = await store.settle(dispatching, createRuntimeOAuthAttemptTerminalV1({
      version: 1,
      attemptDigest: attempt.attemptDigest,
      phase: "failed",
      resolution: "provider_login_failed",
      configuredObserved: null,
      terminalAt: "2026-08-10T12:02:00.000Z",
    }));
    const request = {
      attempt,
      expectedRevision: failed.revision,
      terminalDigest: failed.terminal!.terminalDigest,
      acknowledgedAt: "2026-08-10T12:03:00.000Z",
    };
    const firstBroker = durableBroker(store, pendingProvider("openai-codex").provider, storagePort());
    const acknowledged = await firstBroker.acknowledgeAttempt(request);
    expect(acknowledged.record).toMatchObject({
      revision: failed.revision + 1,
      desktopAcknowledgedAt: request.acknowledgedAt,
    });
    expect(() => RuntimeOAuthAttemptAcknowledgeResultSchema.parse(acknowledged)).not.toThrow();
    expect(JSON.stringify(acknowledged)).not.toMatch(/initialAuthorityId|cancelIntent|recoveryReason/i);

    const restarted = new OAuthAttemptStore(store.paths);
    await restarted.initialize("2026-08-10T12:04:00.000Z");
    const restartedBroker = durableBroker(restarted, pendingProvider("openai-codex").provider, storagePort());
    await expect(restartedBroker.acknowledgeAttempt(request)).resolves.toEqual(acknowledged);
    await expect(restartedBroker.acknowledgeAttempt({
      ...request,
      acknowledgedAt: "2026-08-10T12:03:01.000Z",
    })).rejects.toBeInstanceOf(OAuthAttemptStoreError);
    await expect(restartedBroker.acknowledgeAttempt({
      ...request,
      expectedRevision: failed.revision + 1,
    })).rejects.toBeInstanceOf(OAuthAttemptStoreError);
    await expect(restartedBroker.acknowledgeAttempt({
      ...request,
      attempt: durableAttempt("ffffffff-ffff-4fff-8fff-ffffffffffff"),
    })).rejects.toMatchObject({ code: "OAUTH_ATTEMPT_ID_CONFLICT" });
    await expect(restartedBroker.attemptEffectAdmissionReady()).resolves.toBe(true);
  });
});

function brokerFor(provider: HostOAuthProvider, storage: HostOAuthStorage & { calls: string[] }) {
  return new HostOAuthSessionBroker({
    hostId: HOST_ID,
    providers: { getProvider: (providerId) => providerId === provider.id ? provider : undefined },
    storage,
    idFactory: sequentialIds(),
  });
}

function durableBroker(
  attemptStore: OAuthAttemptStore,
  provider: HostOAuthProvider,
  storage: HostOAuthStorage,
): HostOAuthSessionBroker {
  return new HostOAuthSessionBroker({
    hostId: HOST_ID,
    providers: { getProvider: (providerId) => providerId === provider.id ? provider : undefined },
    storage,
    attemptStore,
    now: () => ATTEMPT_NOW,
    idFactory: sequentialIds(),
  });
}

async function attemptStore(): Promise<OAuthAttemptStore> {
  const directory = await mkdtemp(join(tmpdir(), "prime-oauth-broker-attempt-"));
  temporaryDirectories.push(directory);
  const store = new OAuthAttemptStore({ oauthAttempts: join(directory, "attempts") });
  await store.initialize(new Date(ATTEMPT_NOW).toISOString());
  return store;
}

function durableAttempt(operationId: string) {
  return createRuntimeOAuthAttemptV1({
    version: 1,
    expectedHostId: HOST_ID,
    providerId: "openai-codex",
    operationId,
    requestedAt: new Date(ATTEMPT_NOW).toISOString(),
  });
}

function helperTerminationError() {
  return Object.assign(new Error("private helper detail"), {
    name: "RuntimeOAuthHelperTerminationError",
    code: "RUNTIME_OAUTH_HELPER_FAILED",
    terminationObserved: false,
  });
}

function binding<T extends Record<string, unknown>>(request: T): T & {
  expectedHostId: string;
  authorityId: string;
  operationId: string;
} {
  return {
    expectedHostId: HOST_ID,
    authorityId: AUTHORITY_ID,
    operationId: "oauth-operation-default",
    ...request,
  };
}

function storagePort(overrides: Partial<HostOAuthStorage> = {}) {
  const port = {
    calls: [] as string[],
    configured: false,
    set: vi.fn(async function set(this: typeof port) {
      this.calls.push("set");
      this.configured = true;
    }),
    drainErrors: vi.fn(function drainErrors(this: typeof port) {
      this.calls.push("drainErrors");
      return [];
    }),
    reload: vi.fn(async function reload(this: typeof port) {
      this.calls.push("reload");
    }),
    getAuthStatus: vi.fn(function getAuthStatus(this: typeof port) {
      this.calls.push("getAuthStatus");
      return { configured: this.configured };
    }),
  };
  Object.assign(port, overrides);
  return port;
}

function pendingProvider(id: string): {
  provider: HostOAuthProvider;
  credentials: ReturnType<typeof deferred<OAuthCredentials>>;
  signal?: AbortSignal;
} {
  const credentials = deferred<OAuthCredentials>();
  const result: {
    provider: HostOAuthProvider;
    credentials: ReturnType<typeof deferred<OAuthCredentials>>;
    signal?: AbortSignal;
  } = {
    credentials,
    provider: {
      id,
      name: id,
      login: (callbacks: OAuthLoginCallbacks) => {
        result.signal = callbacks.signal;
        return credentials.promise;
      },
    },
  };
  return result;
}

function sequentialIds(): () => string {
  let next = 0;
  return () => `oauth-test-${++next}`;
}

function requiredChallengeId(snapshot: { challenge?: { id: string } }): string {
  if (!snapshot.challenge) throw new Error("Expected an OAuth challenge");
  return snapshot.challenge.id;
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
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await flushMicrotasks();
  }
  throw new Error("Timed out waiting for OAuth broker state");
}
