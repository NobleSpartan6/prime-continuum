import { bootstrapTestWorkspace } from "./test-workspace-fixture";
import { access, mkdir, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createConnection, createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicWriteAmbiguousCommitError } from "../../src/hostd/atomic-files";
import { encodeJsonFrame, LengthPrefixedJsonDecoder } from "../../src/shared/frame-codec";
import { HostIpcResponseSchema, PROTOCOL_VERSION, type HostIpcResponse } from "../../src/shared/protocol";
import { createHostOwnershipLease, type HostOwnershipLease } from "../../src/hostd/ownership-lease";
import { defaultLocalEndpoint } from "../../src/hostd/paths";
import {
  acquireUnixEndpointOwnership,
  runFramedSession,
  serveLocalSocket,
  unixEndpointOwnershipLockPath,
} from "../../src/hostd/server";
import { HostService, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";
import { canonicalTemporaryDirectory } from "../helpers/canonical-temp";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("hostd local transport", () => {
  it("flushes an accepted retirement response before cooperative endpoint shutdown", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-retire-server-test-");
    temporaryDirectories.push(directory);
    const store = new HostStore(directory);
    const identity = {
      contractVersion: 1 as const,
      bundleSha256: "a".repeat(64),
      runtimeTrustAnchorId: "b".repeat(64),
    };
    const service = new HostService(store, undefined, undefined, { hostdBuildIdentity: identity });
    await service.initialize();
    const host = await store.getHost();
    const endpoint = defaultLocalEndpoint(directory);
    const server = await serveLocalSocket({ endpoint, dataDir: directory, service });

    const response = await request(endpoint, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "retire-host-request",
      method: "host.retire",
      payload: { expectedHostId: host.hostId, expectedBuildIdentity: identity },
    });
    expect(response).toMatchObject({
      ok: true,
      method: "host.retire",
      result: { state: "accepted", expectedHostId: host.hostId },
    });
    await expect(server.closed).resolves.toBeUndefined();
    if (process.platform !== "win32") {
      await expect(access(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("continues accepted retirement when the peer drops during response write", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-retire-drop-test-");
    temporaryDirectories.push(directory);
    const store = new HostStore(directory);
    const identity = {
      contractVersion: 1 as const,
      bundleSha256: "a".repeat(64),
      runtimeTrustAnchorId: "b".repeat(64),
    };
    const service = new HostService(store, undefined, undefined, { hostdBuildIdentity: identity });
    await service.initialize();
    const host = await store.getHost();
    const readable = new PassThrough();
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("simulated peer drop"));
      },
    });
    writable.on("error", () => undefined);
    const beginRetirement = vi.fn();
    readable.end(encodeJsonFrame({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "retire-dropped-response",
      method: "host.retire",
      payload: { expectedHostId: host.hostId, expectedBuildIdentity: identity },
    }));

    await runFramedSession(
      service,
      readable,
      writable,
      TRUSTED_USER_SESSION,
      undefined,
      beginRetirement,
    );
    expect(beginRetirement).toHaveBeenCalledOnce();
    await service.close();
  });

  it("serves the same framed protocol over a named pipe or Unix socket", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-server-test-");
    temporaryDirectories.push(directory);
    const service = new HostService(new HostStore(directory));
    await service.initialize();
    const endpoint = defaultLocalEndpoint(directory);
    expect(process.platform === "win32" ? endpoint.startsWith("\\\\.\\pipe\\") : endpoint.endsWith("hostd.sock")).toBe(true);

    const server = await serveLocalSocket({ endpoint, dataDir: directory, service });
    try {
      const response = await request(endpoint, {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "health-request",
        method: "health.get",
        payload: {},
      });
      expect(response.ok).toBe(true);
      expect(response.method).toBe("health.get");
      if (response.ok && response.method === "health.get") {
        expect(response.result.protocolVersion).toBe(PROTOCOL_VERSION);
        expect(response.result.host.connectionPaths[0]?.kind).toBe("local_socket");
      }
    } finally {
      await server.close();
      await service.close();
    }
    if (process.platform !== "win32") {
      await expect(access(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(directory)).some((entry) => entry.startsWith(".p-"))).toBe(false);
    }
  });

  it("returns a correlated structured error for invalid request payloads", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-server-test-");
    temporaryDirectories.push(directory);
    const service = new HostService(new HostStore(directory));
    await service.initialize();
    const endpoint = defaultLocalEndpoint(directory);
    const server = await serveLocalSocket({ endpoint, dataDir: directory, service });
    try {
      const response = await request(endpoint, {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "bad-request",
        method: "thread.snapshot",
        payload: { threadId: "*not-valid*" },
      });
      expect(response).toMatchObject({
        requestId: "bad-request",
        method: "thread.snapshot",
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    } finally {
      await server.close();
      await service.close();
    }
  });

  it("runs authority recovery only after this process wins endpoint ownership", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-server-test-");
    temporaryDirectories.push(directory);
    const service = new HostService(new HostStore(directory));
    await service.initialize();
    const endpoint = defaultLocalEndpoint(directory);
    const server = await serveLocalSocket({ endpoint, dataDir: directory, service });
    const losingOwnerRecovery = vi.fn(async () => undefined);

    try {
      await expect(
        serveLocalSocket({
          endpoint,
          dataDir: directory,
          service,
          onOwned: losingOwnerRecovery,
        }),
      ).rejects.toThrow();
      expect(losingOwnerRecovery).not.toHaveBeenCalled();
    } finally {
      await server.close();
      await service.close();
    }
  });

  it("rejects an alternate endpoint before it can own the same durable store", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-noncanonical-endpoint-test-");
    temporaryDirectories.push(directory);
    const service = new HostService(new HostStore(directory));
    const canonicalEndpoint = defaultLocalEndpoint(directory);
    const alternateEndpoint = process.platform === "win32"
      ? `${canonicalEndpoint}-alternate`
      : join(directory, "alternate-hostd.sock");
    const onOwned = vi.fn(async () => service.initialize());

    try {
      await expect(
        serveLocalSocket({
          endpoint: alternateEndpoint,
          dataDir: directory,
          service,
          onOwned,
        }),
      ).rejects.toMatchObject({ code: "HOST_ENDPOINT_NONCANONICAL" });
      expect(onOwned).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("keeps endpoint ownership until the current service and admitted work are inert", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-server-test-");
    temporaryDirectories.push(directory);
    const service = new HostService(new HostStore(directory));
    await service.initialize();
    const endpoint = defaultLocalEndpoint(directory);
    const server = await serveLocalSocket({ endpoint, dataDir: directory, service });
    const closeStarted = deferred<void>();
    const releaseClose = deferred<void>();
    const originalClose = service.close.bind(service);
    vi.spyOn(service, "close").mockImplementation(async () => {
      closeStarted.resolve(undefined);
      await releaseClose.promise;
      await originalClose();
    });
    const closing = server.close();
    await closeStarted.promise;
    const successorRecovery = vi.fn(async () => undefined);

    try {
      await expect(
        serveLocalSocket({ endpoint, dataDir: directory, service, onOwned: successorRecovery }),
      ).rejects.toThrow();
      expect(successorRecovery).not.toHaveBeenCalled();
    } finally {
      releaseClose.resolve(undefined);
      await closing;
    }
  });

  it("holds a legitimate successor behind an admitted command publication", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-admitted-command-test-");
    temporaryDirectories.push(directory);
    const admissionPrepared = deferred<void>();
    const releaseAdmission = deferred<void>();
    let pauseAdmission = true;
    const store = new HostStore(directory, {
      admissionFaultInjector: async (point) => {
        if (point !== "after_prepare" || !pauseAdmission) return;
        pauseAdmission = false;
        admissionPrepared.resolve(undefined);
        await releaseAdmission.promise;
      },
    });
    const service = new HostService(store);
    await service.initialize();
    await bootstrapTestWorkspace(store);
    const host = await store.getHost();
    const endpoint = defaultLocalEndpoint(directory);
    const server = await serveLocalSocket({ endpoint, dataDir: directory, service });
    const command = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: "device-admitted-before-close",
      commandId: "command-admitted-before-close",
      expectedHostId: host.hostId,
      threadId: "test-thread",
      issuedAt: new Date().toISOString(),
      expectedExecutionGenerationId: "test-execution-1",
      command: { kind: "prompt", text: "Finish this admitted publication before handoff." },
    } as const;
    const requestOutcome = request(endpoint, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "admitted-command-during-close",
      method: "command.submit",
      payload: { command },
    }).catch((error: unknown) => error);
    await admissionPrepared.promise;

    const closing = server.close();
    let closeSettled = false;
    void closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    const contenderStore = new HostStore(directory);
    const contenderService = new HostService(contenderStore);
    const contenderOwned = vi.fn(async () => contenderService.initialize());

    try {
      await expect(
        serveLocalSocket({
          endpoint,
          dataDir: directory,
          service: contenderService,
          onOwned: contenderOwned,
        }),
      ).rejects.toThrow();
      expect(contenderOwned).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(closeSettled).toBe(false);
    } finally {
      await contenderService.close();
      releaseAdmission.resolve(undefined);
    }

    await expect(closing).resolves.toBeUndefined();
    expect(await requestOutcome).toBeInstanceOf(Error);

    const successorStore = new HostStore(directory);
    const successorService = new HostService(successorStore);
    const successorOwned = vi.fn(async () => successorService.initialize());
    const successor = await serveLocalSocket({
      endpoint,
      dataDir: directory,
      service: successorService,
      onOwned: successorOwned,
    });
    try {
      expect(successorOwned).toHaveBeenCalledOnce();
      expect(
        await successorStore.reconcileCommands([command]),
      ).toMatchObject({
        receipts: [
          {
            deviceId: command.deviceId,
            commandId: command.commandId,
            status: "rejected",
            error: { code: "GATEWAY_UNAVAILABLE", retryable: true },
          },
        ],
        unknown: [],
      });
    } finally {
      await successor.close();
    }
  });

  it("drains an admitted publication before releasing the endpoint to a successor", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-server-test-");
    temporaryDirectories.push(directory);
    const service = new HostService(new HostStore(directory));
    await service.initialize();
    const endpoint = defaultLocalEndpoint(directory);
    let lease!: HostOwnershipLease;
    const server = await serveLocalSocket({
      endpoint,
      dataDir: directory,
      service,
      onOwned: async (ownedLease) => {
        lease = ownedLease;
      },
    });
    const publicationEntered = deferred<void>();
    const releasePublication = deferred<void>();
    const events: string[] = [];
    const publication = lease.withPublicationPermit(async () => {
      events.push("publication:start");
      publicationEntered.resolve(undefined);
      await releasePublication.promise;
      events.push("publication:end");
      return "committed";
    });
    await publicationEntered.promise;

    const closing = server.close();
    expect(lease.signal.aborted).toBe(true);
    const latePublication = vi.fn(async () => undefined);
    expect(() => lease.withPublicationPermit(latePublication)).toThrowError(
      expect.objectContaining({ code: "HOST_OWNERSHIP_CLOSING" }),
    );
    expect(latePublication).not.toHaveBeenCalled();

    const contenderService = new HostService(new HostStore(directory));
    const contenderOwned = vi.fn(async () => undefined);
    try {
      await expect(
        serveLocalSocket({ endpoint, dataDir: directory, service: contenderService, onOwned: contenderOwned }),
      ).rejects.toThrow();
      expect(contenderOwned).not.toHaveBeenCalled();
    } finally {
      await contenderService.close();
    }

    releasePublication.resolve(undefined);
    await expect(publication).resolves.toBe("committed");
    await closing;

    const successorService = new HostService(new HostStore(directory));
    await successorService.initialize();
    const successor = await serveLocalSocket({
      endpoint,
      dataDir: directory,
      service: successorService,
      onOwned: async () => {
        events.push("successor:owned");
      },
    });
    try {
      expect(events).toEqual(["publication:start", "publication:end", "successor:owned"]);
    } finally {
      await successor.close();
      await successorService.close();
    }
  });

  it("upgrades an in-progress clean close when a publication discovers physical loss", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-close-upgrade-test-");
    temporaryDirectories.push(directory);
    const service = new HostService(new HostStore(directory));
    await service.initialize();
    const endpoint = defaultLocalEndpoint(directory);
    let lease!: HostOwnershipLease;
    let ownershipChecks = 0;
    const server = await serveLocalSocket({
      endpoint,
      dataDir: directory,
      service,
      onOwned: async (ownedLease) => {
        lease = ownedLease;
      },
      ownershipAssertion: async () => {
        ownershipChecks += 1;
        if (ownershipChecks === 2) throw new Error("simulated loss during clean close");
      },
    });
    const publicationEntered = deferred<void>();
    const releasePublication = deferred<void>();
    const publication = lease.withPublicationPermit(async () => {
      publicationEntered.resolve(undefined);
      await releasePublication.promise;
    });
    await publicationEntered.promise;

    const closing = server.close();
    expect(closing).toBe(server.closed);
    releasePublication.resolve(undefined);

    await expect(publication).rejects.toMatchObject({ code: "HOST_OWNERSHIP_PUBLICATION_UNCERTAIN" });
    await expect(closing).rejects.toMatchObject({ code: "HOST_OWNERSHIP_PUBLICATION_UNCERTAIN" });
  });

  it("fatally closes after post-publication ownership loss and holds successors behind service teardown", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-fatal-publication-test-");
    temporaryDirectories.push(directory);
    const store = new HostStore(directory);
    const service = new HostService(store);
    await service.initialize();
    const host = await store.getHost();
    const endpoint = defaultLocalEndpoint(directory);
    const serviceCloseStarted = deferred<void>();
    const releaseServiceClose = deferred<void>();
    const events: string[] = [];
    const originalClose = service.close.bind(service);
    vi.spyOn(service, "close").mockImplementation(async () => {
      events.push("service:close:start");
      serviceCloseStarted.resolve(undefined);
      await releaseServiceClose.promise;
      await originalClose();
      events.push("service:close:end");
    });
    const handle = vi.spyOn(service, "handle");
    let ownershipChecks = 0;
    let lease!: HostOwnershipLease;
    const server = await serveLocalSocket({
      endpoint,
      dataDir: directory,
      service,
      onOwned: async (ownedLease) => {
        lease = ownedLease;
      },
      ownershipAssertion: async () => {
        ownershipChecks += 1;
        if (ownershipChecks === 2) throw new Error("simulated physical ownership loss");
      },
    });

    const publication = lease.withPublicationPermit(async () => {
      events.push("publication");
      return "visible";
    });
    try {
      await expect(publication).rejects.toMatchObject({ code: "HOST_OWNERSHIP_PUBLICATION_UNCERTAIN" });
      await serviceCloseStarted.promise;
      expect(server.close()).toBe(server.closed);

      let closedSettled = false;
      void server.closed.then(
        () => {
          closedSettled = true;
        },
        () => {
          closedSettled = true;
        },
      );
      await Promise.resolve();
      expect(closedSettled).toBe(false);

      await expect(request(endpoint, healthRequest("health-after-ownership-loss"))).rejects.toThrow();
      await expect(request(endpoint, {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "mutation-after-ownership-loss",
        method: "command.submit",
        payload: {
          command: {
            protocolVersion: PROTOCOL_VERSION,
            deviceId: "device-after-ownership-loss",
            commandId: "command-after-ownership-loss",
            expectedHostId: host.hostId,
            threadId: "test-thread",
            issuedAt: new Date().toISOString(),
            command: { kind: "prompt", text: "This mutation must never be admitted." },
          },
        },
      })).rejects.toThrow();
      expect(handle).not.toHaveBeenCalled();

      const contenderService = new HostService(new HostStore(directory));
      const contenderOwned = vi.fn(async () => undefined);
      try {
        await expect(
          serveLocalSocket({ endpoint, dataDir: directory, service: contenderService, onOwned: contenderOwned }),
        ).rejects.toThrow();
        expect(contenderOwned).not.toHaveBeenCalled();
      } finally {
        await contenderService.close();
      }
    } finally {
      releaseServiceClose.resolve(undefined);
      await server.closed.catch(() => undefined);
    }

    await expect(server.closed).rejects.toMatchObject({ code: "HOST_OWNERSHIP_PUBLICATION_UNCERTAIN" });
    if (process.platform !== "win32") {
      await expect(access(endpoint)).resolves.toBeUndefined();
      await expect(access(unixEndpointOwnershipLockPath(endpoint))).rejects.toMatchObject({ code: "ENOENT" });
    }
    const successorService = new HostService(new HostStore(directory));
    await successorService.initialize();
    const successor = await serveLocalSocket({
      endpoint,
      dataDir: directory,
      service: successorService,
      onOwned: async () => {
        events.push("successor:owned");
      },
    });
    try {
      expect(events).toEqual([
        "publication",
        "service:close:start",
        "service:close:end",
        "successor:owned",
      ]);
    } finally {
      await successor.close();
      await successorService.close();
    }
  });

  it("turns verify-only ownership loss into fatal server shutdown", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-fatal-verify-test-");
    temporaryDirectories.push(directory);
    const service = new HostService(new HostStore(directory));
    await service.initialize();
    const endpoint = defaultLocalEndpoint(directory);
    let lease!: HostOwnershipLease;
    let failOwnership = false;
    const server = await serveLocalSocket({
      endpoint,
      dataDir: directory,
      service,
      onOwned: async (ownedLease) => {
        lease = ownedLease;
      },
      ownershipAssertion: async () => {
        if (failOwnership) throw new Error("simulated verify-only ownership loss");
      },
    });

    failOwnership = true;
    await expect(lease.assertActive()).rejects.toMatchObject({ code: "HOST_OWNERSHIP_LOST" });
    await expect(server.closed).rejects.toMatchObject({ code: "HOST_OWNERSHIP_LOST" });
  });

  it.skipIf(process.platform === "win32")(
    "never unlinks a replacement Unix socket after physical ownership loss",
    async () => {
      const directory = await canonicalTemporaryDirectory("prime-hostd-fatal-socket-replacement-test-");
      temporaryDirectories.push(directory);
      const service = new HostService(new HostStore(directory));
      await service.initialize();
      const endpoint = defaultLocalEndpoint(directory);
      let lease!: HostOwnershipLease;
      const server = await serveLocalSocket({
        endpoint,
        dataDir: directory,
        service,
        onOwned: async (ownedLease) => {
          lease = ownedLease;
        },
      });
      const displacedEndpoint = join(directory, "displaced-hostd.sock");
      const replacement = createNetServer((socket) => socket.end());
      try {
        await rename(endpoint, displacedEndpoint);
        await new Promise<void>((resolvePromise, rejectPromise) => {
          replacement.once("error", rejectPromise);
          replacement.listen(endpoint, resolvePromise);
        });

        await expect(lease.assertActive()).rejects.toMatchObject({ code: "HOST_OWNERSHIP_LOST" });
        await expect(server.closed).rejects.toMatchObject({ code: "HOST_OWNERSHIP_LOST" });
        await expect(connectOnce(endpoint)).resolves.toBeUndefined();
      } finally {
        await server.close().catch(() => undefined);
        await new Promise<void>((resolvePromise) => {
          if (!replacement.listening) return resolvePromise();
          replacement.close(() => resolvePromise());
        });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "never unlinks a successor Unix socket when ownership is displaced during post-listen startup",
    async () => {
      const directory = await canonicalTemporaryDirectory("prime-hostd-startup-socket-replacement-test-");
      temporaryDirectories.push(directory);
      const service = new HostService(new HostStore(directory));
      await service.initialize();
      const endpoint = defaultLocalEndpoint(directory);
      const displacedEndpoint = join(directory, "displaced-startup-hostd.sock");
      const displacedOwnership = join(directory, "displaced-startup-owner");
      const replacement = createNetServer((socket) => socket.end());
      let successorOwnership: Awaited<ReturnType<typeof acquireUnixEndpointOwnership>> | undefined;
      try {
        await expect(
          serveLocalSocket({
            endpoint,
            dataDir: directory,
            service,
            beforePostListenOwnershipProof: async () => {
              await rename(unixEndpointOwnershipLockPath(endpoint), displacedOwnership);
              successorOwnership = await acquireUnixEndpointOwnership(endpoint);
              await rename(endpoint, displacedEndpoint);
              await new Promise<void>((resolvePromise, rejectPromise) => {
                replacement.once("error", rejectPromise);
                replacement.listen(endpoint, resolvePromise);
              });
            },
          }),
        ).rejects.toMatchObject({ code: "HOST_ENDPOINT_LOCK_LOST" });

        await expect(successorOwnership?.assertOwned()).resolves.toBeUndefined();
        await expect(connectOnce(endpoint)).resolves.toBeUndefined();
      } finally {
        await new Promise<void>((resolvePromise) => {
          if (!replacement.listening) return resolvePromise();
          replacement.close(() => resolvePromise());
        });
        await successorOwnership?.release();
        await service.close();
      }
    },
  );

  it("fences every request immediately before HostService admission", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-request-fence-test-");
    temporaryDirectories.push(directory);
    const service = new HostService(new HostStore(directory));
    await service.initialize();
    const handle = vi.spyOn(service, "handle");
    const endpoint = defaultLocalEndpoint(directory);
    let failOwnership = false;
    const server = await serveLocalSocket({
      endpoint,
      dataDir: directory,
      service,
      ownershipAssertion: async () => {
        if (failOwnership) throw new Error("simulated request-admission ownership loss");
      },
    });

    failOwnership = true;
    try {
      await expect(request(endpoint, healthRequest("request-fence-loss"))).rejects.toThrow();
      expect(handle).not.toHaveBeenCalled();
      await expect(server.closed).rejects.toMatchObject({ code: "HOST_OWNERSHIP_LOST" });
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  it("keeps the base service alive after ordinary atomic publication uncertainty", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-runtime-poison-test-");
    temporaryDirectories.push(directory);
    const service = new HostService(new HostStore(directory));
    await service.initialize();
    const endpoint = defaultLocalEndpoint(directory);
    let lease!: HostOwnershipLease;
    const server = await serveLocalSocket({
      endpoint,
      dataDir: directory,
      service,
      onOwned: async (ownedLease) => {
        lease = ownedLease;
      },
    });
    const ambiguousCommit = new AtomicWriteAmbiguousCommitError(
      "runtime/current.json",
      new Error("simulated runtime pointer durability uncertainty"),
    );

    try {
      await expect(
        lease.withPublicationPermit(async () => {
          throw ambiguousCommit;
        }),
      ).rejects.toBe(ambiguousCommit);
      expect(lease.signal.aborted).toBe(true);

      const response = await request(endpoint, healthRequest("health-after-runtime-poison"));
      expect(response).toMatchObject({ ok: true, method: "health.get" });
      let closedSettled = false;
      void server.closed.then(
        () => {
          closedSettled = true;
        },
        () => {
          closedSettled = true;
        },
      );
      await Promise.resolve();
      expect(closedSettled).toBe(false);
    } finally {
      await server.close();
    }
    await expect(server.closed).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "atomically elects one owner when concurrent Unix contenders recover one stale sidecar",
    async () => {
      const directory = await canonicalTemporaryDirectory("prime-hostd-owner-test-");
      temporaryDirectories.push(directory);
      const endpoint = join(directory, "hostd.sock");
      const lockPath = unixEndpointOwnershipLockPath(endpoint);
      const staleToken = "1".repeat(64);
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(
        join(lockPath, `owner-${staleToken}.json`),
        `${JSON.stringify({
          version: 1,
          token: staleToken,
          pid: process.pid === 1 ? 2 : 1,
          createdAt: "2026-08-06T00:00:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );
      const acquisitionOptions = {
        acquisitionWaitMs: 100,
        retryDelayMs: 1,
        isProcessAlive: (pid: number) => pid === process.pid,
      };

      const results = await Promise.allSettled([
        acquireUnixEndpointOwnership(endpoint, acquisitionOptions),
        acquireUnixEndpointOwnership(endpoint, acquisitionOptions),
      ]);
      const winners = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireUnixEndpointOwnership>>> =>
          result.status === "fulfilled",
      );
      const losers = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.reason).toMatchObject({ code: "HOST_ENDPOINT_OWNED" });
      await winners[0]?.value.release();
      await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("never auto-deletes an empty Unix ownership directory, even when it is old", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-owner-test-");
    temporaryDirectories.push(directory);
    const endpoint = join(directory, "hostd.sock");
    const lockPath = unixEndpointOwnershipLockPath(endpoint);
    await mkdir(lockPath, { mode: 0o700 });
    await utimes(lockPath, new Date(0), new Date(0));

    await expect(
      acquireUnixEndpointOwnership(endpoint, {
        acquisitionWaitMs: 10,
        retryDelayMs: 2,
      }),
    ).rejects.toMatchObject({ code: "HOST_ENDPOINT_LOCK_INITIALIZING" });
    expect((await stat(lockPath)).isDirectory()).toBe(true);
    expect(await readdir(lockPath)).toEqual([]);
  });

  it("publishes only a populated candidate and rejects a delayed publisher after replacement", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-owner-test-");
    temporaryDirectories.push(directory);
    const endpoint = join(directory, "hostd.sock");
    const lockPath = unixEndpointOwnershipLockPath(endpoint);
    const candidateReady = deferred<string>();
    const releasePublisher = deferred<void>();

    const delayed = acquireUnixEndpointOwnership(endpoint, {
      beforePublish: async (candidatePath) => {
        const entries = await readdir(candidatePath);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatch(/^owner-[0-9a-f]{64}\.json$/);
        await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
        candidateReady.resolve(candidatePath);
        await releasePublisher.promise;
      },
    });
    await candidateReady.promise;
    const replacement = await acquireUnixEndpointOwnership(endpoint);
    releasePublisher.resolve(undefined);

    await expect(delayed).rejects.toMatchObject({ code: "HOST_ENDPOINT_OWNED" });
    await replacement.assertOwned();
    expect(await readdir(lockPath)).toHaveLength(1);
    await replacement.release();
  });

  it("never removes a replacement Unix owner during release", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-owner-test-");
    temporaryDirectories.push(directory);
    const endpoint = join(directory, "hostd.sock");
    const lockPath = unixEndpointOwnershipLockPath(endpoint);
    const displacedPath = `${lockPath}.displaced`;
    const first = await acquireUnixEndpointOwnership(endpoint);
    await rename(lockPath, displacedPath);
    const replacement = await acquireUnixEndpointOwnership(endpoint);

    await first.release();
    await replacement.assertOwned();
    expect((await readdir(lockPath)).some((entry) => entry.startsWith("owner-"))).toBe(true);
    await replacement.release();
  });

  it("treats an indeterminate Unix owner PID as live", async () => {
    const directory = await canonicalTemporaryDirectory("prime-hostd-owner-test-");
    temporaryDirectories.push(directory);
    const endpoint = join(directory, "hostd.sock");
    const lockPath = unixEndpointOwnershipLockPath(endpoint);
    const token = "2".repeat(64);
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(
      join(lockPath, `owner-${token}.json`),
      `${JSON.stringify({ version: 1, token, pid: 1234, createdAt: "2026-08-06T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );

    await expect(
      acquireUnixEndpointOwnership(endpoint, {
        isProcessAlive: () => {
          throw new Error("liveness unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "HOST_ENDPOINT_OWNED" });
    expect(await readdir(lockPath)).toEqual([`owner-${token}.json`]);
  });
});

describe("host endpoint ownership publication lease", () => {
  it("notifies the first physical loss once after synchronous revocation", async () => {
    const fatalLoss = vi.fn();
    let controller!: ReturnType<typeof createHostOwnershipLease>;
    controller = createHostOwnershipLease(
      async () => {
        throw new Error("simulated physical loss");
      },
      {
        generation: "9".repeat(64),
        onFatalLoss: (error) => {
          expect(controller.lease.signal.aborted).toBe(true);
          expect(() => controller.lease.withPublicationPermit(async () => undefined)).toThrowError(
            expect.objectContaining({ code: "HOST_OWNERSHIP_LOST" }),
          );
          fatalLoss(error);
        },
      },
    );

    const results = await Promise.allSettled([
      controller.lease.assertActive(),
      controller.assertOwned(),
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(fatalLoss).toHaveBeenCalledOnce();
    expect(fatalLoss).toHaveBeenCalledWith(expect.objectContaining({ code: "HOST_OWNERSHIP_LOST" }));
  });

  it("linearizes shutdown against an ownership check before invoking the publication", async () => {
    const ownershipCheckEntered = deferred<void>();
    const releaseOwnershipCheck = deferred<void>();
    const publish = vi.fn(async () => "published");
    const controller = createHostOwnershipLease(async () => {
      ownershipCheckEntered.resolve(undefined);
      await releaseOwnershipCheck.promise;
    }, { generation: "a".repeat(64) });

    const publication = controller.lease.withPublicationPermit(publish);
    await ownershipCheckEntered.promise;
    controller.closeAdmission();
    releaseOwnershipCheck.resolve(undefined);

    await expect(publication).rejects.toMatchObject({
      code: "HOST_OWNERSHIP_CLOSING",
      generation: "a".repeat(64),
    });
    expect(publish).not.toHaveBeenCalled();
    await controller.drain();
  });

  it("does not cancel an admitted callback and drains it after closing admission", async () => {
    const publicationEntered = deferred<void>();
    const releasePublication = deferred<void>();
    const assertOwned = vi.fn(async () => undefined);
    const controller = createHostOwnershipLease(assertOwned, { generation: "b".repeat(64) });
    const publication = controller.lease.withPublicationPermit(async () => {
      publicationEntered.resolve(undefined);
      await releasePublication.promise;
      return "committed";
    });
    await publicationEntered.promise;

    controller.closeAdmission();
    let drained = false;
    const draining = controller.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    releasePublication.resolve(undefined);

    await expect(publication).resolves.toBe("committed");
    await draining;
    expect(assertOwned).toHaveBeenCalledTimes(2);
    expect(drained).toBe(true);
  });

  it("poisons the ownership generation when ownership is lost after publication", async () => {
    const ownershipLoss = new Error("simulated ownership replacement");
    let ownershipChecks = 0;
    const controller = createHostOwnershipLease(async () => {
      ownershipChecks += 1;
      if (ownershipChecks === 2) throw ownershipLoss;
    }, { generation: "c".repeat(64) });
    const publish = vi.fn(async () => "visible");

    await expect(controller.lease.withPublicationPermit(publish)).rejects.toMatchObject({
      code: "HOST_OWNERSHIP_PUBLICATION_UNCERTAIN",
      generation: "c".repeat(64),
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(controller.lease.signal.aborted).toBe(true);

    const retry = vi.fn(async () => undefined);
    expect(() => controller.lease.withPublicationPermit(retry)).toThrowError(
      expect.objectContaining({ code: "HOST_OWNERSHIP_PUBLICATION_UNCERTAIN" }),
    );
    expect(retry).not.toHaveBeenCalled();
  });

  it("poisons the ownership generation after an ambiguous atomic commit", async () => {
    const controller = createHostOwnershipLease(async () => undefined, { generation: "d".repeat(64) });
    const ambiguousCommit = new AtomicWriteAmbiguousCommitError(
      "state/current.json",
      new Error("simulated directory sync failure"),
    );

    await expect(
      controller.lease.withPublicationPermit(async () => {
        throw ambiguousCommit;
      }),
    ).rejects.toBe(ambiguousCommit);
    expect(controller.lease.signal.aborted).toBe(true);

    const retry = vi.fn(async () => undefined);
    expect(() => controller.lease.withPublicationPermit(retry)).toThrowError(
      expect.objectContaining({ code: "HOST_OWNERSHIP_PUBLICATION_POISONED" }),
    );
    expect(retry).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function healthRequest(requestId: string) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method: "health.get",
    payload: {},
  } as const;
}

async function request(endpoint: string, value: unknown): Promise<HostIpcResponse> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(endpoint);
    const decoder = new LengthPrefixedJsonDecoder({ parse: (frame) => HostIpcResponseSchema.parse(frame) });
    let settled = false;
    let timer!: ReturnType<typeof setTimeout>;
    const resolve = (response: HostIpcResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(response);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    timer = setTimeout(() => {
      fail(new Error("Timed out waiting for hostd response"));
    }, 3_000);
    socket.once("error", fail);
    socket.once("close", () => fail(new Error("Hostd closed the connection without a response")));
    socket.on("data", (chunk: Buffer) => {
      try {
        const responses = decoder.push(chunk);
        const response = responses[0];
        if (!response) return;
        resolve(response);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Invalid hostd response", { cause: error }));
      }
    });
    socket.once("connect", () => socket.write(encodeJsonFrame(value)));
  });
}

async function connectOnce(endpoint: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise();
    });
    socket.once("error", rejectPromise);
  });
}
