import { describe, expect, it, vi } from "vitest";
import {
  HostOAuthSessionBroker,
  type HostOAuthProvider,
  type HostOAuthStorage,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
} from "../../src/hostd/oauth-session-broker";

const HOST_ID = "prime-host-1";
const AUTHORITY_ID = "trusted-desktop";
const SECRET_CREDENTIALS: OAuthCredentials = {
  access: "access-secret-that-must-never-cross-the-boundary",
  refresh: "refresh-secret-that-must-never-cross-the-boundary",
  expires: 2_000_000_000_000,
  type: "api_key",
};

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
    expect(JSON.stringify(completed)).not.toMatch(/access-secret|refresh-secret/);
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
});

function brokerFor(provider: HostOAuthProvider, storage: HostOAuthStorage & { calls: string[] }) {
  return new HostOAuthSessionBroker({
    hostId: HOST_ID,
    providers: { getProvider: (providerId) => providerId === provider.id ? provider : undefined },
    storage,
    idFactory: sequentialIds(),
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
