import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  DEFAULT_MAX_FRAME_BYTES,
  FrameCodecError,
  readJsonFrames,
  writeJsonFrame,
} from "../shared/frame-codec";
import {
  HostIpcResponseSchema,
  MAX_SNAPSHOT_TRANSFER_BYTES,
  PROTOCOL_VERSION,
  SNAPSHOT_TRANSFER_CHUNK_BYTES,
  SNAPSHOT_TRANSFER_VERSION,
  type HostIpcResponse,
  type HostIpcSnapshotTransferEnvelope,
} from "../shared/protocol";
import { ensurePrivateDirectory } from "./atomic-files";
import { TRUSTED_USER_SESSION, type HostService, type HostSessionContext } from "./service";

export const MAX_HOST_CONNECTIONS = 32;
export const CONNECTION_IDLE_TIMEOUT_MS = 5 * 60_000;
export const CONNECTION_INITIALIZATION_TIMEOUT_MS = 10_000;
export const UNIX_ENDPOINT_OWNERSHIP_SUFFIX = ".owner";

const UNIX_OWNERSHIP_ACQUISITION_WAIT_MS = 10_250;
const UNIX_OWNERSHIP_RETRY_DELAY_MS = 25;
const MAX_OWNERSHIP_MARKER_BYTES = 4_096;
const OWNERSHIP_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const OWNERSHIP_MARKER_PATTERN = /^owner-([0-9a-f]{64})\.json$/;

export interface HostServer {
  endpoint: string;
  close(): Promise<void>;
}

export interface UnixEndpointOwnership {
  readonly lockPath: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

interface UnixEndpointOwnershipOptions {
  acquisitionWaitMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  beforePublish?: (candidatePath: string) => Promise<void>;
}

export class HostEndpointOwnershipError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HostEndpointOwnershipError";
    this.code = code;
  }
}

export async function serveLocalSocket(options: {
  endpoint: string;
  dataDir: string;
  service: HostService;
  /** Runs only after this process has won exclusive endpoint ownership. */
  onOwned?: () => Promise<void>;
}): Promise<HostServer> {
  const endpoint = validateLocalEndpoint(options.endpoint, options.dataDir);
  let unixOwnership: UnixEndpointOwnership | undefined;
  if (process.platform !== "win32") {
    await ensurePrivateDirectory(dirname(endpoint));
    unixOwnership = await acquireUnixEndpointOwnership(endpoint);
    try {
      await unixOwnership.assertOwned();
      await removeStaleOwnedSocket(endpoint);
      await unixOwnership.assertOwned();
    } catch (error) {
      await unixOwnership.release().catch(() => undefined);
      throw error;
    }
  }

  const sockets = new Set<Socket>();
  const pendingSockets = new Set<Socket>();
  const sessions = new Set<Promise<void>>();
  let phase: "initializing" | "accepting" | "closing" = options.onOwned === undefined ? "accepting" : "initializing";
  const startSession = (socket: Socket): void => {
    pendingSockets.delete(socket);
    if (socket.destroyed) return;
    if (sockets.size >= MAX_HOST_CONNECTIONS) {
      socket.destroy();
      return;
    }
    socket.removeAllListeners("timeout");
    socket.setKeepAlive(true, 30_000);
    socket.setTimeout(CONNECTION_IDLE_TIMEOUT_MS, () => socket.destroy());
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const session = runFramedSession(options.service, socket, socket, TRUSTED_USER_SESSION)
      .catch(() => {
        socket.destroy();
      })
      .finally(() => sessions.delete(session));
    sessions.add(session);
    socket.resume();
  };
  const server = createServer((socket) => {
    socket.pause();
    if (phase === "closing") {
      socket.destroy();
      return;
    }
    if (phase === "initializing") {
      if (pendingSockets.size + sockets.size >= MAX_HOST_CONNECTIONS) {
        socket.destroy();
        return;
      }
      pendingSockets.add(socket);
      socket.setTimeout(CONNECTION_INITIALIZATION_TIMEOUT_MS, () => socket.destroy());
      socket.once("close", () => pendingSockets.delete(socket));
      return;
    }
    if (sockets.size >= MAX_HOST_CONNECTIONS) {
      socket.destroy();
      return;
    }
    startSession(socket);
  });
  server.maxConnections = MAX_HOST_CONNECTIONS;
  let ownedSocketIdentity: SocketFileIdentity | undefined;
  try {
    await listen(server, endpoint);
    if (process.platform !== "win32") {
      await chmod(endpoint, 0o600);
      ownedSocketIdentity = await readSocketIdentity(endpoint);
      await unixOwnership?.assertOwned();
    }
  } catch (error) {
    phase = "closing";
    for (const socket of pendingSockets) socket.destroy();
    pendingSockets.clear();
    let cleanupComplete = true;
    await closeServer(server).catch(() => {
      cleanupComplete = false;
    });
    if (ownedSocketIdentity) {
      await removeSocketIfStillOwned(endpoint, ownedSocketIdentity).catch(() => {
        cleanupComplete = false;
      });
    }
    if (cleanupComplete) await unixOwnership?.release().catch(() => undefined);
    throw error;
  }
  try {
    await options.onOwned?.();
    phase = "accepting";
    for (const socket of [...pendingSockets]) startSession(socket);
  } catch (error) {
    phase = "closing";
    for (const socket of pendingSockets) socket.destroy();
    pendingSockets.clear();
    let cleanupComplete = true;
    await options.service.close().catch(() => {
      cleanupComplete = false;
    });
    await closeServer(server).catch(() => {
      cleanupComplete = false;
    });
    if (ownedSocketIdentity) {
      await removeSocketIfStillOwned(endpoint, ownedSocketIdentity).catch(() => {
        cleanupComplete = false;
      });
    }
    if (cleanupComplete) await unixOwnership?.release().catch(() => undefined);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    endpoint,
    close() {
      closePromise ??= (async () => {
        // Keep the owned endpoint bound while every admitted request and the
        // authority shut down. A successor cannot initialize against the same
        // durable state until this owner has become inert.
        phase = "closing";
        for (const socket of pendingSockets) socket.destroy();
        pendingSockets.clear();
        for (const socket of sockets) socket.destroy();
        await Promise.allSettled([...sessions]);
        let shutdownError: unknown;
        try {
          await options.service.close();
        } catch (error) {
          shutdownError = error;
        }
        try {
          await closeServer(server);
        } catch (error) {
          shutdownError ??= error;
        }
        if (ownedSocketIdentity) {
          try {
            await removeSocketIfStillOwned(endpoint, ownedSocketIdentity);
          } catch (error) {
            shutdownError ??= error;
          }
        }
        if (!shutdownError) await unixOwnership?.release();
        if (shutdownError) throw shutdownError;
      })();
      return closePromise;
    },
  };
}

export async function runFramedSession(
  service: HostService,
  readable: Readable,
  writable: Writable,
  context: HostSessionContext,
): Promise<void> {
  try {
    for await (const request of readJsonFrames(readable, {
      maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
      maxFramesPerChunk: 256,
    })) {
      const response = await service.handle(request, context);
      if (!(await writeSnapshotResponseIfRequested(writable, request, response))) {
        await writeJsonFrame(writable, response, DEFAULT_MAX_FRAME_BYTES);
      }
    }
  } catch (error) {
    if (error instanceof FrameCodecError) {
      // Framing violations are terminal; attempting to answer could desynchronize
      // the stream and amplify attacker-controlled input.
      destroyWritable(writable, error);
      return;
    }
    destroyWritable(writable, error instanceof Error ? error : new Error("Host protocol session failed"));
  }
}

async function writeSnapshotResponseIfRequested(
  writable: Writable,
  request: unknown,
  response: HostIpcResponse,
): Promise<boolean> {
  if (
    !response.ok ||
    (response.method !== "catalog.snapshot" && response.method !== "thread.snapshot") ||
    !requestsSnapshotTransfer(request, response.requestId, response.method)
  ) {
    return false;
  }

  const serialized = serializeSnapshotJson(response.result);
  if (!serialized.ok) {
    const tooLarge = HostIpcResponseSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: response.requestId,
      method: response.method,
      ok: false,
      error: {
        code: "SNAPSHOT_TOO_LARGE",
        message: `The authoritative snapshot exceeds the bounded ${MAX_SNAPSHOT_TRANSFER_BYTES / (1024 * 1024)} MiB transfer limit.`,
        retryable: false,
        details: {
          minimumBytes: serialized.minimumBytes,
          maxBytes: MAX_SNAPSHOT_TRANSFER_BYTES,
        },
      },
    });
    await writeJsonFrame(writable, tooLarge, DEFAULT_MAX_FRAME_BYTES);
    return true;
  }

  const transferId = `snapshot-${randomUUID()}`;
  const snapshotKind = response.method === "catalog.snapshot" ? "catalog" : "thread";
  const sha256 = createHash("sha256");
  for (const chunk of serialized.chunks) sha256.update(chunk);
  const digest = sha256.digest("hex");
  const chunkCount = serialized.chunks.length;
  await writeSnapshotTransferEnvelope(writable, {
    protocolVersion: PROTOCOL_VERSION,
    requestId: response.requestId,
    method: response.method,
    transfer: {
      kind: "snapshot.begin",
      transferId,
      snapshotKind,
      chunkCount,
      totalBytes: serialized.totalBytes,
      sha256: digest,
    },
  });
  for (const [index, chunk] of serialized.chunks.entries()) {
    await writeSnapshotTransferEnvelope(writable, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: response.requestId,
      method: response.method,
      transfer: {
        kind: "snapshot.chunk",
        transferId,
        index,
        dataBase64: chunk.toString("base64"),
      },
    });
  }
  await writeSnapshotTransferEnvelope(writable, {
    protocolVersion: PROTOCOL_VERSION,
    requestId: response.requestId,
    method: response.method,
    transfer: { kind: "snapshot.end", transferId, sha256: digest },
  });
  return true;
}

type SerializedSnapshot =
  | { readonly ok: true; readonly chunks: readonly Buffer[]; readonly totalBytes: number }
  | { readonly ok: false; readonly minimumBytes: number };

/**
 * Serializes protocol DTOs incrementally and stops before retaining more than
 * the transfer ceiling. This avoids creating a second monolithic snapshot
 * string or buffer in hostd solely to discover that it is too large.
 */
function serializeSnapshotJson(value: unknown): SerializedSnapshot {
  const chunks: Buffer[] = [];
  let active = Buffer.allocUnsafe(SNAPSHOT_TRANSFER_CHUNK_BYTES);
  let activeBytes = 0;
  let totalBytes = 0;
  const ancestors = new Set<object>();

  class SnapshotTooLargeError extends Error {
    constructor(readonly minimumBytes: number) {
      super("Snapshot exceeds the bounded transfer limit");
    }
  }

  const emit = (text: string): void => {
    const bytes = Buffer.from(text, "utf8");
    if (totalBytes + bytes.byteLength > MAX_SNAPSHOT_TRANSFER_BYTES) {
      throw new SnapshotTooLargeError(totalBytes + bytes.byteLength);
    }
    totalBytes += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const copied = bytes.copy(active, activeBytes, offset, Math.min(bytes.byteLength, offset + active.byteLength - activeBytes));
      activeBytes += copied;
      offset += copied;
      if (activeBytes === active.byteLength) {
        chunks.push(active);
        active = Buffer.allocUnsafe(SNAPSHOT_TRANSFER_CHUNK_BYTES);
        activeBytes = 0;
      }
    }
  };

  const writeValue = (current: unknown, arrayElement: boolean, depth: number): boolean => {
    if (depth > 64) throw new TypeError("Snapshot JSON nesting exceeds 64 levels");
    if (current === null) {
      emit("null");
      return true;
    }
    switch (typeof current) {
      case "string":
        emit(JSON.stringify(current));
        return true;
      case "boolean":
        emit(current ? "true" : "false");
        return true;
      case "number":
        emit(Number.isFinite(current) ? String(current) : "null");
        return true;
      case "undefined":
      case "function":
      case "symbol":
        if (arrayElement) emit("null");
        return arrayElement;
      case "bigint":
        throw new TypeError("Snapshot JSON cannot contain bigint values");
      case "object":
        break;
    }

    const object = current as object;
    if (ancestors.has(object)) throw new TypeError("Snapshot JSON cannot contain circular references");
    ancestors.add(object);
    try {
      if (Array.isArray(current)) {
        emit("[");
        for (let index = 0; index < current.length; index += 1) {
          if (index > 0) emit(",");
          writeValue(current[index], true, depth + 1);
        }
        emit("]");
        return true;
      }

      const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Snapshot JSON must contain only plain protocol objects");
      }
      emit("{");
      let wroteProperty = false;
      for (const key of Object.keys(object)) {
        const property = (object as Record<string, unknown>)[key];
        if (["undefined", "function", "symbol"].includes(typeof property)) continue;
        if (wroteProperty) emit(",");
        emit(JSON.stringify(key));
        emit(":");
        writeValue(property, false, depth + 1);
        wroteProperty = true;
      }
      emit("}");
      return true;
    } finally {
      ancestors.delete(object);
    }
  };

  try {
    if (!writeValue(value, false, 0)) throw new TypeError("Snapshot result is not JSON serializable");
    if (activeBytes > 0) chunks.push(active.subarray(0, activeBytes));
    if (totalBytes === 0 || chunks.length === 0) throw new TypeError("Snapshot result cannot be empty");
    return { ok: true, chunks, totalBytes };
  } catch (error) {
    if (error instanceof SnapshotTooLargeError) return { ok: false, minimumBytes: error.minimumBytes };
    throw error;
  }
}

function requestsSnapshotTransfer(request: unknown, requestId: string, method: string): boolean {
  if (!isRecord(request) || request.requestId !== requestId || request.method !== method || !isRecord(request.payload)) {
    return false;
  }
  const preference = request.payload.snapshotTransfer;
  return isRecord(preference) && preference.version === SNAPSHOT_TRANSFER_VERSION;
}

async function writeSnapshotTransferEnvelope(
  writable: Writable,
  envelope: HostIpcSnapshotTransferEnvelope,
): Promise<void> {
  await writeJsonFrame(writable, envelope, DEFAULT_MAX_FRAME_BYTES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * SSH `connect --stdio` is a bounded raw bridge to the persistent local hostd.
 * It never creates a second file-backed authority whose lifetime is tied to SSH.
 */
export async function bridgeStdioToLocalSocket(
  endpoint: string,
  readable: Readable,
  writable: Writable,
): Promise<void> {
  const socket = await connect(endpoint);
  readable.pipe(socket);
  socket.pipe(writable, { end: false });
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      readable.unpipe(socket);
      socket.unpipe(writable);
      socket.destroy();
      if (error) reject(error);
      else resolvePromise();
    };
    socket.once("end", () => finish());
    socket.once("close", () => finish());
    socket.once("error", finish);
    readable.once("error", finish);
    writable.once("error", finish);
  });
}

export function validateLocalEndpoint(endpoint: string, dataDir: string): string {
  if (!endpoint || endpoint.length > 4_096 || endpoint.includes("\0")) {
    throw new Error("Local endpoint must be between 1 and 4096 characters and contain no NUL bytes");
  }
  if (process.platform === "win32") {
    if (!endpoint.startsWith("\\\\.\\pipe\\")) throw new Error("Windows hostd must use a named pipe endpoint");
    return endpoint;
  }

  if (!isAbsolute(endpoint)) throw new Error("Unix hostd must use an absolute domain socket path");
  const root = resolve(dataDir);
  const resolved = resolve(endpoint);
  const relation = relative(root, resolved);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("Unix hostd socket must be contained in the user-owned host data directory");
  }
  return resolved;
}

async function removeStaleOwnedSocket(endpoint: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(endpoint);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (!stats.isSocket()) throw new Error(`Refusing to replace a non-socket local endpoint: ${endpoint}`);
  const staleIdentity = { dev: stats.dev, ino: stats.ino };
  const active = await canConnect(endpoint);
  if (active) throw new Error(`Another prime-agent-hostd is already listening at ${endpoint}`);
  await removeSocketIfStillOwned(endpoint, staleIdentity);
}

export function unixEndpointOwnershipLockPath(endpoint: string): string {
  return `${endpoint}${UNIX_ENDPOINT_OWNERSHIP_SUFFIX}`;
}

/**
 * Cross-process Unix startup fence. A fully populated candidate directory is
 * published by one atomic rename. Published directories are never empty, and
 * token-named markers make stale cleanup conditional on the inspected owner.
 */
export async function acquireUnixEndpointOwnership(
  endpoint: string,
  options: UnixEndpointOwnershipOptions = {},
): Promise<UnixEndpointOwnership> {
  const lockPath = unixEndpointOwnershipLockPath(endpoint);
  const token = randomBytes(32).toString("hex");
  const markerName = `owner-${token}.json`;
  const markerPath = joinOwnershipPath(lockPath, markerName);
  const candidatePath = `${lockPath}.candidate-${process.pid}-${token}`;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const isProcessAlive = options.isProcessAlive ?? isPidAliveConservatively;
  const acquisitionWaitMs = boundedNonnegativeInteger(
    options.acquisitionWaitMs,
    UNIX_OWNERSHIP_ACQUISITION_WAIT_MS,
    "acquisitionWaitMs",
  );
  const retryDelayMs = boundedPositiveInteger(options.retryDelayMs, UNIX_OWNERSHIP_RETRY_DELAY_MS, "retryDelayMs");
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new HostEndpointOwnershipError("HOST_ENDPOINT_LOCK_CLOCK_INVALID", "Endpoint ownership clock is invalid");
  }
  const deadline = startedAt + acquisitionWaitMs;
  const owner: UnixOwnershipMarker = {
    version: 1,
    token,
    pid: process.pid,
    createdAt: new Date(startedAt).toISOString(),
  };

  await prepareOwnershipCandidate(candidatePath, markerName, owner);
  try {
    await options.beforePublish?.(candidatePath);
    while (true) {
      const inspection = await inspectUnixOwnership(lockPath, isProcessAlive);
      if (inspection.state === "missing") {
        try {
          await rename(candidatePath, lockPath);
          break;
        } catch (error) {
          if (!isOwnershipPublishConflict(error)) throw error;
          await waitForOwnershipContention(endpoint, now, deadline, retryDelayMs, sleep, error);
          continue;
        }
      }
      if (inspection.state === "active") {
        throw new HostEndpointOwnershipError(
          "HOST_ENDPOINT_OWNED",
          `Another prime-agent-hostd process (${inspection.owner.pid}) owns ${endpoint}`,
        );
      }
      if (inspection.state === "invalid") {
        throw new HostEndpointOwnershipError("HOST_ENDPOINT_LOCK_INVALID", inspection.message);
      }
      if (inspection.state === "initializing") {
        if (now() >= deadline) {
          throw new HostEndpointOwnershipError(
            "HOST_ENDPOINT_LOCK_INITIALIZING",
            `Endpoint ownership for ${endpoint} is empty or incomplete; recovery is fail-closed and requires manual inspection`,
          );
        }
        await sleep(Math.min(retryDelayMs, Math.max(0, deadline - now())));
        continue;
      }

      try {
        await unlink(inspection.markerPath);
      } catch (error) {
        // Only the contender whose token-specific unlink succeeds may remove
        // the directory. An ENOENT loser loops without calling rmdir.
        if (!isErrorCode(error, "ENOENT") && !isErrorCode(error, "EPERM")) throw error;
        if (isErrorCode(error, "EPERM")) {
          await waitForOwnershipContention(endpoint, now, deadline, retryDelayMs, sleep, error);
        }
        continue;
      }
      try {
        await rmdir(lockPath);
      } catch (error) {
        if (!isErrorCode(error, "ENOENT") && !isDirectoryNotEmptyError(error)) throw error;
        if (!isErrorCode(error, "ENOENT")) {
          await waitForOwnershipContention(endpoint, now, deadline, retryDelayMs, sleep, error);
        }
      }
    }

    const identity = await readDirectoryIdentity(lockPath);
    let released = false;
    const ownership: UnixEndpointOwnership = {
        lockPath,
        assertOwned: () => assertUnixOwnership(lockPath, markerPath, identity, owner),
        async release() {
          if (released) return;
          released = true;
          if (!(await ownsUnixEndpoint(lockPath, markerPath, identity, owner))) return;
          try {
            await unlink(markerPath);
          } catch (error) {
            if (isErrorCode(error, "ENOENT")) return;
            throw error;
          }
          try {
            await rmdir(lockPath);
          } catch (error) {
            // A replacement owner always has its own marker, so non-recursive
            // rmdir cannot delete the replacement directory.
            if (!isErrorCode(error, "ENOENT") && !isDirectoryNotEmptyError(error)) throw error;
          }
        },
    };
    await ownership.assertOwned();
    return ownership;
  } finally {
    await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface UnixOwnershipMarker {
  version: 1;
  token: string;
  pid: number;
  createdAt: string;
}

type UnixOwnershipInspection =
  | { state: "missing" }
  | { state: "initializing" }
  | { state: "active"; owner: UnixOwnershipMarker }
  | { state: "stale"; markerPath: string; owner: UnixOwnershipMarker }
  | { state: "invalid"; message: string };

async function inspectUnixOwnership(
  lockPath: string,
  isProcessAlive: (pid: number) => boolean,
): Promise<UnixOwnershipInspection> {
  let lockStats;
  let entries;
  try {
    lockStats = await lstat(lockPath);
    entries = await readdir(lockPath, { withFileTypes: true });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return { state: "missing" };
    return { state: "invalid", message: `Cannot inspect endpoint ownership at ${lockPath}` };
  }
  if (!lockStats.isDirectory()) {
    return { state: "invalid", message: `Endpoint ownership path is not a directory: ${lockPath}` };
  }
  if (entries.length === 0) {
    // Current publishers never expose an empty final directory. It can only be
    // an incomplete/mixed-version owner and is never safe to auto-delete.
    return { state: "initializing" };
  }
  if (entries.length !== 1) {
    return { state: "invalid", message: `Endpoint ownership directory has unexpected entries: ${lockPath}` };
  }

  const entry = entries[0];
  const match = entry?.isFile() ? OWNERSHIP_MARKER_PATTERN.exec(entry.name) : undefined;
  if (!entry || !match) {
    return { state: "invalid", message: `Endpoint ownership marker is invalid: ${lockPath}` };
  }
  const markerPath = joinOwnershipPath(lockPath, entry.name);
  let owner: UnixOwnershipMarker | undefined;
  try {
    owner = await readOwnershipMarker(markerPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return { state: "missing" };
    return { state: "invalid", message: `Endpoint ownership marker cannot be read: ${markerPath}` };
  }
  if (!owner || owner.token !== match[1]) {
    return { state: "invalid", message: `Endpoint ownership marker does not match its token: ${markerPath}` };
  }

  let alive: boolean;
  try {
    alive = isProcessAlive(owner.pid);
  } catch {
    // An indeterminate liveness check must never authorize stale takeover.
    alive = true;
  }
  return alive ? { state: "active", owner } : { state: "stale", markerPath, owner };
}

async function prepareOwnershipCandidate(
  candidatePath: string,
  markerName: string,
  owner: UnixOwnershipMarker,
): Promise<void> {
  await mkdir(candidatePath, { mode: 0o700 });
  try {
    await writeOwnershipMarker(joinOwnershipPath(candidatePath, markerName), owner);
    if (process.platform !== "win32") await syncDirectory(candidatePath);
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeOwnershipMarker(path: string, owner: UnixOwnershipMarker): Promise<void> {
  const body = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
  if (body.byteLength > MAX_OWNERSHIP_MARKER_BYTES) {
    throw new HostEndpointOwnershipError("HOST_ENDPOINT_LOCK_INVALID", "Endpoint ownership marker is too large");
  }
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOwnershipMarker(path: string): Promise<UnixOwnershipMarker | undefined> {
  const markerStats = await lstat(path);
  if (!markerStats.isFile() || markerStats.size <= 0 || markerStats.size > MAX_OWNERSHIP_MARKER_BYTES) return undefined;
  const bytes = await readFile(path);
  if (bytes.byteLength !== markerStats.size || bytes.byteLength > MAX_OWNERSHIP_MARKER_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!isOwnershipRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "createdAt,pid,token,version") return undefined;
  if (value.version !== 1 || typeof value.token !== "string" || !OWNERSHIP_TOKEN_PATTERN.test(value.token)) {
    return undefined;
  }
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 2_147_483_647) {
    return undefined;
  }
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return undefined;
  return {
    version: 1,
    token: value.token,
    pid: value.pid,
    createdAt: value.createdAt,
  };
}

async function readDirectoryIdentity(path: string): Promise<SocketFileIdentity> {
  const stats = await lstat(path);
  if (!stats.isDirectory()) {
    throw new HostEndpointOwnershipError("HOST_ENDPOINT_LOCK_LOST", `Endpoint ownership directory was replaced: ${path}`);
  }
  return { dev: stats.dev, ino: stats.ino };
}

async function assertUnixOwnership(
  lockPath: string,
  markerPath: string,
  identity: SocketFileIdentity,
  owner: UnixOwnershipMarker,
): Promise<void> {
  if (!(await ownsUnixEndpoint(lockPath, markerPath, identity, owner))) {
    throw new HostEndpointOwnershipError(
      "HOST_ENDPOINT_LOCK_LOST",
      `Endpoint ownership changed before prime-agent-hostd became authoritative: ${lockPath}`,
    );
  }
}

async function ownsUnixEndpoint(
  lockPath: string,
  markerPath: string,
  identity: SocketFileIdentity,
  owner: UnixOwnershipMarker,
): Promise<boolean> {
  try {
    const current = await lstat(lockPath);
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) return false;
    const entries = await readdir(lockPath);
    if (entries.length !== 1 || joinOwnershipPath(lockPath, entries[0] ?? "") !== markerPath) return false;
    const currentOwner = await readOwnershipMarker(markerPath);
    return currentOwner?.token === owner.token && currentOwner.pid === owner.pid;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isOwnershipRecord(value: unknown): value is Record<string, unknown> & {
  version: unknown;
  token: unknown;
  pid: unknown;
  createdAt: unknown;
} {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPidAliveConservatively(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ESRCH")) return false;
    // EPERM and unknown platform errors mean the process may still exist.
    return true;
  }
}

function boundedNonnegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 60_000) {
    throw new HostEndpointOwnershipError("HOST_ENDPOINT_LOCK_OPTIONS_INVALID", `${name} must be an integer from 0 to 60000`);
  }
  return resolved;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = boundedNonnegativeInteger(value, fallback, name);
  if (resolved === 0) {
    throw new HostEndpointOwnershipError("HOST_ENDPOINT_LOCK_OPTIONS_INVALID", `${name} must be greater than zero`);
  }
  return resolved;
}

function joinOwnershipPath(lockPath: string, markerName: string): string {
  return join(lockPath, markerName);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function isDirectoryNotEmptyError(error: unknown): boolean {
  return isErrorCode(error, "ENOTEMPTY") || isErrorCode(error, "EEXIST") || isErrorCode(error, "EPERM");
}

function isOwnershipPublishConflict(error: unknown): boolean {
  return (
    isErrorCode(error, "EEXIST") ||
    isErrorCode(error, "ENOTEMPTY") ||
    isErrorCode(error, "EPERM") ||
    isErrorCode(error, "EACCES")
  );
}

async function waitForOwnershipContention(
  endpoint: string,
  now: () => number,
  deadline: number,
  retryDelayMs: number,
  sleep: (milliseconds: number) => Promise<void>,
  cause: unknown,
): Promise<void> {
  if (now() >= deadline) {
    throw new HostEndpointOwnershipError(
      "HOST_ENDPOINT_LOCK_INITIALIZING",
      `Endpoint ownership for ${endpoint} did not stabilize within the bounded recovery window`,
      { cause },
    );
  }
  await sleep(retryDelayMs);
}

interface SocketFileIdentity {
  dev: number;
  ino: number;
}

async function readSocketIdentity(endpoint: string): Promise<SocketFileIdentity> {
  const stats = await lstat(endpoint);
  if (!stats.isSocket()) throw new Error(`Local endpoint is not a Unix socket: ${endpoint}`);
  return { dev: stats.dev, ino: stats.ino };
}

/** Never unlink a replacement socket that another owner bound during teardown. */
async function removeSocketIfStillOwned(endpoint: string, owned: SocketFileIdentity): Promise<void> {
  let current;
  try {
    current = await lstat(endpoint);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (!current.isSocket() || current.dev !== owned.dev || current.ino !== owned.ino) return;
  await rm(endpoint);
}

async function canConnect(endpoint: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      resolvePromise(false);
    }, 250);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(false);
    });
  });
}

async function connect(endpoint: string): Promise<Socket> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to the local host service at ${endpoint}`));
    }, 2_000);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolvePromise(socket);
    });
    const onError = (error: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
  });
}

async function listen(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function destroyWritable(writable: Writable, error: Error): void {
  if ("destroy" in writable && typeof writable.destroy === "function") writable.destroy(error);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function isHostResponse(value: unknown): value is HostIpcResponse {
  return typeof value === "object" && value !== null && "ok" in value;
}
