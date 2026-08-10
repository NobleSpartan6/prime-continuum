import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthAttemptStore } from "../../src/hostd/oauth-attempt-store";
import type {
  HostOAuthComposition,
  HostOAuthSessionBroker,
  OAuthAttemptSessionAdmission,
} from "../../src/hostd/oauth-session-broker";
import {
  AtomicWriteAmbiguousCommitError,
  atomicWriteJson,
} from "../../src/hostd/atomic-files";
import {
  createHostOwnershipLease,
  type HostOwnershipLease,
} from "../../src/hostd/ownership-lease";
import {
  HostService,
  SSH_BRIDGE_SESSION,
  TRUSTED_USER_SESSION,
  type HostSessionContext,
} from "../../src/hostd/service";
import { runFramedSession } from "../../src/hostd/server";
import { HostStore } from "../../src/hostd/store";
import { encodeJsonFrame, LengthPrefixedJsonDecoder } from "../../src/shared/frame-codec";
import { createRuntimeOAuthAttemptV1 } from "../../src/shared/runtime-oauth-attempt";
import {
  PROTOCOL_VERSION,
  RUNTIME_OAUTH_ATTEMPT_CAPABILITY,
  RUNTIME_OAUTH_CAPABILITY,
} from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })));
});

describe("HostService durable runtime OAuth attempt boundary", () => {
  it("advertises the two-cap start contract and completes start, status, cancel, and ack exactly once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-attempt-effects-"));
    temporaryDirectories.push(directory);
    const hostStore = new HostStore(directory);
    const attemptStore = new OAuthAttemptStore(hostStore.paths);
    const compact = vi.spyOn(attemptStore, "compact");
    const login = vi.fn(async (callbacks: Parameters<NonNullable<ReturnType<HostOAuthComposition["getProvider"]>>["login"]>[0]) => {
      callbacks.onAuth({ url: validAuthorizationUrl() });
      return await new Promise<never>((_resolve, reject) => {
        callbacks.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    });
    const service = new HostService(hostStore, undefined, undefined, {
      runtimeOAuthAttemptStore: attemptStore,
      runtimeOAuthComposition: availableOAuthComposition(login),
    });
    try {
      await service.initialize(testOwnershipLease());
      expect(compact).toHaveBeenCalledOnce();
      await vi.waitFor(async () => {
        const capabilities = (await readHealth(service, TRUSTED_USER_SESSION, "attempt-effects-ready")).capabilities;
        expect(capabilities).toContain(RUNTIME_OAUTH_ATTEMPT_CAPABILITY);
        expect(capabilities).toContain(RUNTIME_OAUTH_CAPABILITY);
      });
      const hostId = (await hostStore.getHost()).hostId;
      const attempt = createRuntimeOAuthAttemptV1({
        version: 1,
        expectedHostId: hostId,
        providerId: "openai-codex",
        operationId: "44444444-4444-4444-8444-444444444444",
        requestedAt: new Date().toISOString(),
      });

      const legacy = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "attempt-legacy-rejected",
        method: "oauth.session.start",
        payload: {
          expectedHostId: hostId,
          authorityId: "desktop-authority-one",
          providerId: "openai-codex",
          operationId: "legacy-operation-one",
        },
      }, TRUSTED_USER_SESSION);
      expect(legacy).toMatchObject({
        ok: false,
        error: { code: "RUNTIME_OAUTH_LEGACY_UNAVAILABLE", retryable: false },
      });
      expect(login).not.toHaveBeenCalled();

      const started = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "attempt-start",
        method: "oauth.attempt.start",
        payload: { authorityId: "desktop-authority-one", attempt },
      }, TRUSTED_USER_SESSION);
      expect(started).toMatchObject({
        ok: true,
        result: {
          attemptDigest: attempt.attemptDigest,
          record: { attempt, phase: "login_dispatching", revision: 1 },
          live: { phase: "awaiting_user", authorization: { url: validAuthorizationUrl() } },
        },
      });
      expect(login).toHaveBeenCalledOnce();
      expect(JSON.stringify(started)).not.toMatch(/initialAuthorityId|cancelIntent|recoveryReason|accessToken|refreshToken|path|argv|environment/i);
      const busyCapabilities = (await readHealth(service, TRUSTED_USER_SESSION, "attempt-effects-busy")).capabilities;
      expect(busyCapabilities).toContain(RUNTIME_OAUTH_ATTEMPT_CAPABILITY);
      expect(busyCapabilities).not.toContain(RUNTIME_OAUTH_CAPABILITY);

      const status = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "attempt-status",
        method: "oauth.attempt.status",
        payload: { attempt },
      }, TRUSTED_USER_SESSION);
      expect(status).toMatchObject({
        ok: true,
        result: { record: { phase: "login_dispatching" }, live: { phase: "awaiting_user" } },
      });

      const cancelled = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "attempt-cancel",
        method: "oauth.attempt.cancel",
        payload: { attempt },
      }, TRUSTED_USER_SESSION);
      expect(cancelled).toMatchObject({
        ok: true,
        result: { record: { phase: "cancelled", revision: 3 } },
      });
      if (!cancelled.ok || cancelled.method !== "oauth.attempt.cancel") throw new Error("Cancel failed");
      const terminal = cancelled.result.record.terminal!;
      const acknowledged = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "attempt-ack",
        method: "oauth.attempt.acknowledge",
        payload: {
          attempt,
          expectedRevision: cancelled.result.record.revision,
          terminalDigest: terminal.terminalDigest,
          acknowledgedAt: terminal.body.terminalAt,
        },
      }, TRUSTED_USER_SESSION);
      expect(acknowledged).toMatchObject({
        ok: true,
        result: {
          record: {
            phase: "cancelled",
            revision: cancelled.result.record.revision + 1,
            desktopAcknowledgedAt: terminal.body.terminalAt,
          },
        },
      });
      await vi.waitFor(async () => {
        const capabilities = (await readHealth(service, TRUSTED_USER_SESSION, "attempt-effects-retired")).capabilities;
        expect(capabilities).toContain(RUNTIME_OAUTH_ATTEMPT_CAPABILITY);
        expect(capabilities).toContain(RUNTIME_OAUTH_CAPABILITY);
      });
    } finally {
      await service.close();
    }
  });

  it("rejects an older trusted connection after replacement status proves exact absence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-attempt-replacement-fence-"));
    temporaryDirectories.push(directory);
    const hostStore = new HostStore(directory);
    const attemptStore = new OAuthAttemptStore(hostStore.paths);
    const login = vi.fn(async () => {
      throw new Error("A superseded connection must not start provider login");
    });
    const service = new HostService(hostStore, undefined, undefined, {
      runtimeOAuthAttemptStore: attemptStore,
      runtimeOAuthComposition: availableOAuthComposition(login),
    });
    try {
      await service.initialize(testOwnershipLease());
      const hostId = (await hostStore.getHost()).hostId;
      const attempt = attemptFor(hostId, "12121212-3434-4567-8123-121212121212");
      const older = trustedAdmission(1n);
      const replacement = trustedAdmission(2n);

      await expect(service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "replacement-absence-status",
        method: "oauth.attempt.status",
        payload: { attempt },
      }, replacement.context)).resolves.toMatchObject({
        ok: true,
        result: { attemptDigest: attempt.attemptDigest, record: null },
      });
      await expect(service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "older-connection-start",
        method: "oauth.attempt.start",
        payload: { authorityId: "desktop-authority-old", attempt },
      }, older.context)).resolves.toMatchObject({
        ok: false,
        error: { code: "OAUTH_ATTEMPT_CONNECTION_SUPERSEDED", retryable: false },
      });

      expect(await attemptStore.get(attempt)).toBeUndefined();
      expect(login).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("never admits a disconnected framed start after replacement status returns null", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-attempt-cross-connection-"));
    temporaryDirectories.push(directory);
    const hostStore = new HostStore(directory);
    const attemptStore = new OAuthAttemptStore(hostStore.paths);
    const login = vi.fn(async () => {
      throw new Error("The disconnected connection must not start provider login");
    });
    const service = new HostService(hostStore, undefined, undefined, {
      runtimeOAuthAttemptStore: attemptStore,
      runtimeOAuthComposition: availableOAuthComposition(login),
    });
    const oldInput = new PassThrough();
    const oldOutput = new PassThrough();
    const replacementInput = new PassThrough();
    const replacementOutput = new PassThrough();
    const ownershipEntered = deferred<void>();
    const releaseOwnership = deferred<void>();
    const oldInputEnded = deferred<void>();
    oldInput.once("end", () => oldInputEnded.resolve(undefined));
    let oldSession: Promise<void> | undefined;
    let replacementSession: Promise<void> | undefined;
    try {
      await service.initialize(testOwnershipLease());
      const hostId = (await hostStore.getHost()).hostId;
      const attempt = attemptFor(hostId, "56565656-3434-4567-8123-565656565656");
      oldSession = runFramedSession(
        service,
        oldInput,
        oldOutput,
        TRUSTED_USER_SESSION,
        async () => {
          ownershipEntered.resolve(undefined);
          await releaseOwnership.promise;
        },
      );
      oldInput.write(encodeJsonFrame({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "disconnected-old-start",
        method: "oauth.attempt.start",
        payload: { authorityId: "desktop-authority-old", attempt },
      }));
      await ownershipEntered.promise;
      oldInput.end();
      await oldInputEnded.promise;

      const decoder = new LengthPrefixedJsonDecoder<Record<string, unknown>>();
      const replacementResponse = deferred<Record<string, unknown>>();
      replacementOutput.on("data", (chunk: Buffer) => {
        const [frame] = decoder.push(chunk);
        if (frame) replacementResponse.resolve(frame);
      });
      replacementSession = runFramedSession(
        service,
        replacementInput,
        replacementOutput,
        TRUSTED_USER_SESSION,
      );
      replacementInput.write(encodeJsonFrame({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "replacement-null-status",
        method: "oauth.attempt.status",
        payload: { attempt },
      }));
      await expect(replacementResponse.promise).resolves.toMatchObject({
        ok: true,
        result: { attemptDigest: attempt.attemptDigest, record: null },
      });

      releaseOwnership.resolve(undefined);
      await oldSession;
      replacementInput.end();
      await replacementSession;
      expect(await attemptStore.get(attempt)).toBeUndefined();
      expect(login).not.toHaveBeenCalled();
    } finally {
      releaseOwnership.resolve(undefined);
      if (!oldInput.writableEnded) oldInput.end();
      if (!replacementInput.writableEnded) replacementInput.end();
      await Promise.allSettled([oldSession, replacementSession].filter(
        (session): session is Promise<void> => session !== undefined,
      ));
      await service.close();
    }
  });

  it("holds replacement status behind an already-reserved start until the retained record exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-attempt-service-lane-"));
    temporaryDirectories.push(directory);
    const hostStore = new HostStore(directory);
    const attemptStore = new OAuthAttemptStore(hostStore.paths);
    const login = vi.fn(async (callbacks: Parameters<NonNullable<ReturnType<HostOAuthComposition["getProvider"]>>["login"]>[0]) =>
      await new Promise<never>((_resolve, reject) => {
        callbacks.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }));
    const service = new HostService(hostStore, undefined, undefined, {
      runtimeOAuthAttemptStore: attemptStore,
      runtimeOAuthComposition: availableOAuthComposition(login),
    });
    try {
      await service.initialize(testOwnershipLease());
      const internals = service as unknown as { oauthSessionBroker?: HostOAuthSessionBroker };
      await vi.waitFor(() => expect(internals.oauthSessionBroker).toBeDefined());
      const broker = internals.oauthSessionBroker!;
      const readinessEntered = deferred<void>();
      const releaseReadiness = deferred<void>();
      const originalReadiness = broker.attemptEffectAdmissionReady.bind(broker);
      vi.spyOn(broker, "attemptEffectAdmissionReady").mockImplementationOnce(async () => {
        readinessEntered.resolve(undefined);
        await releaseReadiness.promise;
        return await originalReadiness();
      });
      const hostId = (await hostStore.getHost()).hostId;
      const attempt = createRuntimeOAuthAttemptV1({
        version: 1,
        expectedHostId: hostId,
        providerId: "openai-codex",
        operationId: "90909090-3434-4567-8123-909090909090",
        requestedAt: new Date().toISOString(),
      });
      const older = trustedAdmission(10n);
      const replacement = trustedAdmission(11n);

      const starting = service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "reserved-start",
        method: "oauth.attempt.start",
        payload: { authorityId: "desktop-authority-old", attempt },
      }, older.context);
      await readinessEntered.promise;
      let statusSettled = false;
      const status = service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "replacement-status-behind-start",
        method: "oauth.attempt.status",
        payload: { attempt },
      }, replacement.context).finally(() => {
        statusSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(statusSettled).toBe(false);

      releaseReadiness.resolve(undefined);
      const started = await starting;
      if (!started.ok) throw new Error(JSON.stringify(started.error));
      expect(started).toMatchObject({
        ok: true,
        result: { record: { phase: "login_dispatching" } },
      });
      await expect(status).resolves.toMatchObject({
        ok: true,
        result: { record: { phase: "login_dispatching" } },
      });
      expect(login).toHaveBeenCalledOnce();
      expect((await attemptStore.get(attempt))?.phase).toBe("login_dispatching");
    } finally {
      await service.close();
    }
  });

  it("advertises trusted-local reconciliation after journal initialization and keeps status read-only", async () => {
    const { service, hostStore, attemptStore } = await temporaryService();
    try {
      await vi.waitFor(async () => {
        const health = await readHealth(service, TRUSTED_USER_SESSION, "attempt-health-ready");
        expect(health.capabilities).toContain(RUNTIME_OAUTH_ATTEMPT_CAPABILITY);
        expect(health.capabilities).not.toContain(RUNTIME_OAUTH_CAPABILITY);
      });

      const hostId = (await hostStore.getHost()).hostId;
      const attempt = attemptFor(hostId, "11111111-1111-4111-8111-111111111111");
      const first = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "attempt-status-miss",
        method: "oauth.attempt.status",
        payload: { attempt },
      }, TRUSTED_USER_SESSION);
      expect(first).toEqual({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "attempt-status-miss",
        method: "oauth.attempt.status",
        ok: true,
        result: { attemptDigest: attempt.attemptDigest, record: null },
      });
      expect(await attemptStore.list()).toEqual([]);

      const prepared = await attemptStore.prepare({
        attempt,
        sessionId: "oauth-session-one",
        initialAuthorityId: "desktop-authority-one",
        observedAt: attempt.identity.requestedAt,
        expiresAt: "2026-08-10T12:15:00.000Z",
      });
      const recordPath = join(hostStore.paths.oauthAttempts, `${attempt.attemptDigest}.json`);
      const bytesBeforeStatus = await readFile(recordPath);
      const identityBeforeStatus = fileIdentity(await lstat(recordPath));
      const second = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "attempt-status-hit",
        method: "oauth.attempt.status",
        payload: { attempt },
      }, TRUSTED_USER_SESSION);
      expect(second).toMatchObject({
        ok: true,
        result: {
          attemptDigest: attempt.attemptDigest,
          record: {
            attempt,
            revision: prepared.record.revision,
            sessionId: "oauth-session-one",
            phase: "prepared",
          },
        },
      });
      expect(JSON.stringify(second)).not.toMatch(/desktop-authority-one|initialAuthorityId|accessToken|refreshToken|path|argv|environment/i);
      expect(await attemptStore.list()).toEqual([prepared.record]);
      expect(await readFile(recordPath)).toEqual(bytesBeforeStatus);
      expect(fileIdentity(await lstat(recordPath))).toEqual(identityBeforeStatus);
    } finally {
      await service.close();
    }
  });

  it("keeps core health online and withholds reconciliation when journal initialization fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-attempt-poison-"));
    temporaryDirectories.push(directory);
    const poisonedPath = join(directory, "oauth-attempts");
    await writeFile(poisonedPath, "not a private directory", "utf8");
    const attemptStore = new OAuthAttemptStore({ oauthAttempts: poisonedPath });
    const initialize = vi.spyOn(attemptStore, "initialize");
    const service = new HostService(new HostStore(directory), undefined, undefined, {
      runtimeOAuthAttemptStore: attemptStore,
    });
    try {
      await expect(service.initialize(testOwnershipLease())).resolves.toBeUndefined();
      await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
      const health = await readHealth(service, TRUSTED_USER_SESSION, "attempt-health-poisoned");
      expect(health.serviceState).toBe("ready");
      expect(health.capabilities).not.toContain(RUNTIME_OAUTH_ATTEMPT_CAPABILITY);
      expect(await readFile(poisonedPath, "utf8")).toBe("not a private directory");
    } finally {
      await service.close();
    }
  });

  it("withdraws both capabilities after a post-initialization journal read failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-attempt-read-failure-"));
    temporaryDirectories.push(directory);
    const hostStore = new HostStore(directory);
    const attemptStore = new OAuthAttemptStore(hostStore.paths);
    const login = vi.fn(async () => ({ access: "never", refresh: "never", expires: 1 }));
    const service = new HostService(hostStore, undefined, undefined, {
      runtimeOAuthAttemptStore: attemptStore,
      runtimeOAuthComposition: availableOAuthComposition(login),
    });
    try {
      await service.initialize(testOwnershipLease());
      await vi.waitFor(async () => {
        const capabilities = (await readHealth(service, TRUSTED_USER_SESSION, "attempt-read-ready")).capabilities;
        expect(capabilities).toContain(RUNTIME_OAUTH_ATTEMPT_CAPABILITY);
        expect(capabilities).toContain(RUNTIME_OAUTH_CAPABILITY);
      });
      const hostId = (await hostStore.getHost()).hostId;
      const attempt = createRuntimeOAuthAttemptV1({
        version: 1,
        expectedHostId: hostId,
        providerId: "openai-codex",
        operationId: "55555555-5555-4555-8555-555555555555",
        requestedAt: new Date().toISOString(),
      });
      vi.spyOn(attemptStore, "get").mockRejectedValueOnce(new Error("simulated journal read failure"));
      const failedStatus = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "attempt-read-failed",
        method: "oauth.attempt.status",
        payload: { attempt },
      }, TRUSTED_USER_SESSION);
      expect(failedStatus).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });

      const capabilities = (await readHealth(service, TRUSTED_USER_SESSION, "attempt-read-withdrawn")).capabilities;
      expect(capabilities).not.toContain(RUNTIME_OAUTH_ATTEMPT_CAPABILITY);
      expect(capabilities).not.toContain(RUNTIME_OAUTH_CAPABILITY);
      const rejectedStart = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "attempt-start-after-read-failure",
        method: "oauth.attempt.start",
        payload: { authorityId: "desktop-authority-one", attempt },
      }, TRUSTED_USER_SESSION);
      expect(rejectedStart).toMatchObject({
        ok: false,
        error: { code: "RUNTIME_OAUTH_ATTEMPT_UNAVAILABLE", retryable: false },
      });
      expect(login).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("withholds the capability and rejects attempt reconciliation over SSH and relay", async () => {
    const { service, hostStore } = await temporaryService();
    try {
      await vi.waitFor(async () => {
        expect((await readHealth(service, TRUSTED_USER_SESSION, "attempt-local-ready")).capabilities)
          .toContain(RUNTIME_OAUTH_ATTEMPT_CAPABILITY);
      });
      const hostId = (await hostStore.getHost()).hostId;
      const attempt = attemptFor(hostId, "22222222-2222-4222-8222-222222222222");
      const sshHealth = await readHealth(service, SSH_BRIDGE_SESSION, "attempt-ssh-health");
      expect(sshHealth.capabilities).not.toContain(RUNTIME_OAUTH_ATTEMPT_CAPABILITY);

      const requests = [
        { method: "oauth.attempt.start", payload: { authorityId: "desktop-one", attempt } },
        { method: "oauth.attempt.status", payload: { attempt } },
        { method: "oauth.attempt.cancel", payload: { attempt } },
        {
          method: "oauth.attempt.acknowledge",
          payload: {
            attempt,
            expectedRevision: 0,
            terminalDigest: "a".repeat(64),
            acknowledgedAt: "2026-08-10T12:01:00.000Z",
          },
        },
      ] as const;
      for (const [index, request] of requests.entries()) {
        await expect(service.handle({
          protocolVersion: PROTOCOL_VERSION,
          requestId: `attempt-ssh-${index}`,
          ...request,
        }, SSH_BRIDGE_SESSION)).resolves.toMatchObject({
          ok: false,
          error: { code: "REMOTE_OAUTH_FORBIDDEN", retryable: false },
        });
        await expect(service.handle({
          protocolVersion: PROTOCOL_VERSION,
          requestId: `attempt-relay-${index}`,
          ...request,
        }, {
          transport: "relay",
          channel: { leaseId: "A".repeat(43), channelId: "0".repeat(32) },
        })).resolves.toMatchObject({
          ok: false,
          error: { code: "REMOTE_OAUTH_FORBIDDEN", retryable: false },
        });
      }
    } finally {
      await service.close();
    }
  });

  it("requires endpoint ownership and rejects a journal recovery whose ownership is lost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-attempt-lease-"));
    temporaryDirectories.push(directory);
    const hostStore = new HostStore(directory);
    const attemptStore = new OAuthAttemptStore(hostStore.paths);
    const originalInitialize = attemptStore.initialize.bind(attemptStore);
    let releaseRecovery!: () => void;
    let enteredRecovery!: () => void;
    const recoveryEntered = new Promise<void>((resolvePromise) => {
      enteredRecovery = resolvePromise;
    });
    const recoveryReleased = new Promise<void>((resolvePromise) => {
      releaseRecovery = resolvePromise;
    });
    const initialize = vi.spyOn(attemptStore, "initialize").mockImplementation(async (now) => {
      enteredRecovery();
      await recoveryReleased;
      return await originalInitialize(now);
    });
    const service = new HostService(hostStore, undefined, undefined, {
      runtimeOAuthAttemptStore: attemptStore,
    });
    let owned = true;
    const ownership = createHostOwnershipLease(async () => {
      if (!owned) throw new Error("simulated endpoint replacement");
    });
    try {
      await expect(service.initialize()).rejects.toMatchObject({ code: "HOST_OWNERSHIP_REQUIRED" });
      expect(initialize).not.toHaveBeenCalled();

      const initialization = service.initialize(ownership.lease);
      await recoveryEntered;
      owned = false;
      releaseRecovery();
      await expect(initialization).rejects.toMatchObject({
        code: "HOST_OWNERSHIP_PUBLICATION_UNCERTAIN",
      });
      expect((await readHealth(service, TRUSTED_USER_SESSION, "attempt-health-lost")).capabilities)
        .not.toContain(RUNTIME_OAUTH_ATTEMPT_CAPABILITY);
    } finally {
      releaseRecovery?.();
      await service.close();
    }
  });

  it("poisons endpoint publication when restart classification cannot confirm durability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-attempt-ambiguous-init-"));
    temporaryDirectories.push(directory);
    const seedHostStore = new HostStore(directory);
    await seedHostStore.initialize();
    const seedAttemptStore = new OAuthAttemptStore(seedHostStore.paths);
    await seedAttemptStore.initialize("2026-08-10T12:00:00.000Z");
    const attempt = attemptFor(
      (await seedHostStore.getHost()).hostId,
      "33333333-3333-4333-8333-333333333333",
    );
    await seedAttemptStore.prepare({
      attempt,
      sessionId: "oauth-session-ambiguous",
      initialAuthorityId: "desktop-authority-ambiguous",
      observedAt: attempt.identity.requestedAt,
      expiresAt: "2026-08-10T12:15:00.000Z",
    });

    const attemptStore = new OAuthAttemptStore(seedHostStore.paths, {
      async writeJson(path, value, maxBytes) {
        await atomicWriteJson(path, value, maxBytes);
        throw new AtomicWriteAmbiguousCommitError(path, new Error("simulated directory sync failure"));
      },
    });
    const service = new HostService(new HostStore(directory), undefined, undefined, {
      runtimeOAuthAttemptStore: attemptStore,
    });
    const ownership = createHostOwnershipLease(async () => undefined);
    try {
      await expect(service.initialize(ownership.lease)).rejects.toMatchObject({
        code: "HOST_OWNERSHIP_PUBLICATION_POISONED",
      });
      expect((await readHealth(service, TRUSTED_USER_SESSION, "attempt-health-ambiguous-init")).capabilities)
        .not.toContain(RUNTIME_OAUTH_ATTEMPT_CAPABILITY);
    } finally {
      await service.close();
    }
  });
});

async function temporaryService() {
  const directory = await mkdtemp(join(tmpdir(), "prime-hostd-oauth-attempt-service-"));
  temporaryDirectories.push(directory);
  const hostStore = new HostStore(directory);
  const attemptStore = new OAuthAttemptStore(hostStore.paths);
  const service = new HostService(hostStore, undefined, undefined, {
    runtimeOAuthAttemptStore: attemptStore,
    runtimeOAuthComposition: unavailableOAuthComposition(),
  });
  await service.initialize(testOwnershipLease());
  return { service, hostStore, attemptStore };
}

function testOwnershipLease(): HostOwnershipLease {
  return createHostOwnershipLease(async () => undefined).lease;
}

function unavailableOAuthComposition(): HostOAuthComposition {
  return {
    getProvider() {
      return undefined;
    },
    async set() {
      throw new Error("Provider storage is unavailable");
    },
    async drainErrors() {
      return [];
    },
    async reload() {
      return undefined;
    },
    async getAuthStatus() {
      return { configured: false };
    },
  };
}

function availableOAuthComposition(
  login: NonNullable<ReturnType<HostOAuthComposition["getProvider"]>>["login"],
): HostOAuthComposition {
  return {
    getProvider(providerId) {
      return providerId === "openai-codex"
        ? { id: "openai-codex", name: "ChatGPT Plus/Pro (Codex Subscription)", login }
        : undefined;
    },
    async set() {
      throw new Error("Storage must not run during cancellation");
    },
    async drainErrors() {
      return [];
    },
    async reload() {
      return undefined;
    },
    async getAuthStatus() {
      return { configured: false };
    },
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

async function readHealth(
  service: HostService,
  context: typeof TRUSTED_USER_SESSION | typeof SSH_BRIDGE_SESSION,
  requestId: string,
) {
  const response = await service.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method: "health.get",
    payload: {},
  }, context);
  if (!response.ok || response.method !== "health.get") throw new Error("Health request failed");
  return response.result;
}

function attemptFor(expectedHostId: string, operationId: string) {
  return createRuntimeOAuthAttemptV1({
    version: 1,
    expectedHostId,
    providerId: "openai-codex",
    operationId,
    requestedAt: "2026-08-10T12:00:00.000Z",
  });
}

function trustedAdmission(generation: bigint): {
  readonly context: HostSessionContext;
  close(): void;
} {
  let inputOpen = true;
  const admission: OAuthAttemptSessionAdmission = {
    generation,
    isInputOpen: () => inputOpen,
  };
  return {
    context: { transport: "trusted_user", scopes: "*", oauthAttemptAdmission: admission },
    close() {
      inputOpen = false;
    },
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

function fileIdentity(metadata: Awaited<ReturnType<typeof lstat>>) {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    nlink: metadata.nlink,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
}
