import { access, mkdir, mkdtemp, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeJsonFrame, LengthPrefixedJsonDecoder } from "../../src/shared/frame-codec";
import { HostIpcResponseSchema, PROTOCOL_VERSION, type HostIpcResponse } from "../../src/shared/protocol";
import { defaultLocalEndpoint } from "../../src/hostd/paths";
import {
  acquireUnixEndpointOwnership,
  serveLocalSocket,
  unixEndpointOwnershipLockPath,
} from "../../src/hostd/server";
import { HostService } from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("hostd local transport", () => {
  it("serves the same framed protocol over a named pipe or Unix socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-server-test-"));
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
  });

  it("returns a correlated structured error for invalid request payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-server-test-"));
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
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-server-test-"));
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

  it("keeps endpoint ownership until the current service and admitted work are inert", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-server-test-"));
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

  it("atomically elects one owner when concurrent Unix contenders recover one stale sidecar", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-owner-test-"));
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
  });

  it("never auto-deletes an empty Unix ownership directory, even when it is old", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-owner-test-"));
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
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-owner-test-"));
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
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-owner-test-"));
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
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-owner-test-"));
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

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function request(endpoint: string, value: unknown): Promise<HostIpcResponse> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(endpoint);
    const decoder = new LengthPrefixedJsonDecoder({ parse: (frame) => HostIpcResponseSchema.parse(frame) });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for hostd response"));
    }, 3_000);
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => {
      try {
        const responses = decoder.push(chunk);
        const response = responses[0];
        if (!response) return;
        clearTimeout(timer);
        socket.destroy();
        resolvePromise(response);
      } catch (error) {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
    });
    socket.once("connect", () => socket.write(encodeJsonFrame(value)));
  });
}
