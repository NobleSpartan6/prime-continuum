import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type ServerOptions as HttpsServerOptions } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  decodeRelayRoutingFrame,
  encodeRelayRoutingFrame,
  MAX_RELAY_ROUTING_FRAME_BYTES,
  RELAY_ROUTING_CHANNEL_ID_BYTES,
  type RelayRoutingFrame,
} from "../../../src/shared/relay-routing";
import {
  parseBearerToken,
  sha256Hex,
  type RelayEndpointRole,
  type RelayGrant,
  type RelayGrantStore,
} from "./grant-store";

export const RELAY_SUBPROTOCOL = "prime-relay-routing.v1" as const;
export const RELAY_PATH = "/relay" as const;

export const RELAY_FORWARD_STATUS = {
  acceptedByPeerSocket: 0,
  unavailable: 1,
  backpressure: 2,
} as const;

export interface RelayServerLimits {
  readonly maxConnections: number;
  readonly maxRoutes: number;
  readonly maxDevicesPerRoute: number;
  readonly maxBufferedBytesPerConnection: number;
  readonly maxFramesPerSecondPerConnection: number;
  readonly maxGrantRemainingLifetimeMs: number;
}

export type RelayLogEvent =
  | { readonly type: "server_started"; readonly secure: boolean }
  | { readonly type: "server_stopped" }
  | { readonly type: "grant_store_error" }
  | { readonly type: "connection_open"; readonly role: RelayEndpointRole }
  | { readonly type: "connection_close"; readonly role: RelayEndpointRole; readonly code: number }
  | { readonly type: "connection_error"; readonly role: RelayEndpointRole }
  | { readonly type: "frame_rejected"; readonly role: RelayEndpointRole; readonly category: "binary" | "size" | "codec" | "policy" | "rate" }
  | { readonly type: "frame_forwarded"; readonly direction: "host_to_device" | "device_to_host"; readonly bytes: number }
  | { readonly type: "frame_dropped"; readonly reason: "unavailable" | "backpressure"; readonly bytes: number };

export interface RelayServerOptions {
  readonly grantStore: RelayGrantStore;
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly tls?: HttpsServerOptions;
  /**
   * Test-only escape hatch. Without TLS, the relay refuses to start unless
   * this is true and the listen address is loopback.
   */
  readonly allowInsecureLoopbackForTests?: boolean;
  readonly limits?: Partial<RelayServerLimits>;
  readonly now?: () => number;
  readonly logger?: (event: RelayLogEvent) => void;
}

export interface RelayServerStateSnapshot {
  readonly routeCount: number;
  readonly connectionCount: number;
  readonly hostConnectionCount: number;
  readonly deviceChannelCount: number;
  readonly bufferedBytes: number;
}

interface ConnectionState {
  readonly ws: WebSocket;
  readonly grant: RelayGrant;
  readonly channelId: Uint8Array;
  readonly channelKey: string;
  frameWindowStartedAt: number;
  framesInWindow: number;
  acceptingFrames: boolean;
  closed: boolean;
}

interface RouteState {
  host: ConnectionState | undefined;
  readonly devices: Map<string, ConnectionState>;
  readonly deviceEndpoints: Set<string>;
}

const DEFAULT_LIMITS: RelayServerLimits = {
  maxConnections: 1_024,
  maxRoutes: 256,
  maxDevicesPerRoute: 8,
  maxBufferedBytesPerConnection: 256 * 1024,
  maxFramesPerSecondPerConnection: 128,
  maxGrantRemainingLifetimeMs: 5 * 60 * 1_000,
};

const ZERO_CHANNEL_ID = new Uint8Array(RELAY_ROUTING_CHANNEL_ID_BYTES);

/**
 * Content-blind WebSocket router. It authenticates ephemeral route grants and
 * inspects only the fixed routing header. Application payloads are forwarded
 * byte-for-byte and are never retained, queued offline, or logged.
 */
export class PrimeRelayServer {
  readonly #options: RelayServerOptions;
  readonly #host: string;
  readonly #path: string;
  readonly #limits: RelayServerLimits;
  readonly #now: () => number;
  readonly #log: (event: RelayLogEvent) => void;
  readonly #secure: boolean;
  readonly #httpServer: HttpServer;
  readonly #webSocketServer: WebSocketServer;
  readonly #routes = new Map<string, RouteState>();
  readonly #connections = new Set<ConnectionState>();
  #pendingUpgrades = 0;
  #started = false;

  constructor(options: RelayServerOptions) {
    this.#options = options;
    this.#host = options.host ?? "127.0.0.1";
    this.#path = validatePath(options.path ?? RELAY_PATH);
    this.#limits = mergeLimits(options.limits);
    this.#now = options.now ?? Date.now;
    this.#log = options.logger ?? (() => undefined);
    this.#secure = options.tls !== undefined;

    if (!this.#secure && (!options.allowInsecureLoopbackForTests || !isLoopback(this.#host))) {
      throw new Error("The relay requires TLS; insecure ws:// is allowed only on loopback with the explicit test option");
    }

    const requestHandler = (_request: IncomingMessage, response: import("node:http").ServerResponse) => {
      response.statusCode = 404;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("Not found\n");
    };
    this.#httpServer = this.#secure
      ? createHttpsServer(options.tls as HttpsServerOptions, requestHandler)
      : createHttpServer(requestHandler);
    this.#httpServer.maxHeadersCount = 32;
    this.#httpServer.headersTimeout = 5_000;
    this.#httpServer.requestTimeout = 5_000;

    this.#webSocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: MAX_RELAY_ROUTING_FRAME_BYTES,
      handleProtocols(protocols) {
        return protocols.has(RELAY_SUBPROTOCOL) ? RELAY_SUBPROTOCOL : false;
      },
    });

    this.#httpServer.on("upgrade", (request, socket, head) => {
      void this.#handleUpgrade(request, socket, head).catch(() => {
        if (!socket.destroyed) {
          rejectUpgrade(socket, 503);
        }
      });
    });
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#httpServer.off("error", onError);
        resolve();
      };
      this.#httpServer.once("error", onError);
      this.#httpServer.once("listening", onListening);
      this.#httpServer.listen(this.#options.port ?? 0, this.#host);
    });
    this.#started = true;
    this.#log({ type: "server_started", secure: this.#secure });
  }

  async stop(): Promise<void> {
    if (!this.#started) {
      return;
    }
    this.#started = false;
    for (const connection of [...this.#connections]) {
      connection.ws.terminate();
    }
    await Promise.all([
      new Promise<void>((resolve) => this.#webSocketServer.close(() => resolve())),
      new Promise<void>((resolve, reject) => {
        this.#httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
    ]);
    this.#routes.clear();
    this.#connections.clear();
    this.#log({ type: "server_stopped" });
  }

  get url(): string {
    const address = this.#httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Relay server is not listening");
    }
    const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
    return `${this.#secure ? "wss" : "ws"}://${displayHost}:${address.port}${this.#path}`;
  }

  get address(): AddressInfo {
    const address = this.#httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Relay server is not listening");
    }
    return address;
  }

  snapshot(): RelayServerStateSnapshot {
    let hostConnectionCount = 0;
    let deviceChannelCount = 0;
    let bufferedBytes = 0;
    for (const connection of this.#connections) {
      if (connection.grant.role === "host") {
        hostConnectionCount += 1;
      } else {
        deviceChannelCount += 1;
      }
      bufferedBytes += connection.ws.bufferedAmount;
    }
    return {
      routeCount: this.#routes.size,
      connectionCount: this.#connections.size,
      hostConnectionCount,
      deviceChannelCount,
      bufferedBytes,
    };
  }

  async #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!isAllowedUpgradeRequest(request, this.#path)) {
      rejectUpgrade(socket, 400);
      return;
    }

    if (countRawHeader(request, "authorization") !== 1) {
      rejectUpgrade(socket, 401);
      return;
    }
    const tokenBytes = parseBearerToken(request.headers.authorization);
    if (tokenBytes === null) {
      rejectUpgrade(socket, 401);
      return;
    }
    scrubRawHeader(request, "authorization");

    if (this.#connections.size + this.#pendingUpgrades >= this.#limits.maxConnections) {
      tokenBytes.fill(0);
      rejectUpgrade(socket, 503);
      return;
    }

    this.#pendingUpgrades += 1;
    let grant: RelayGrant | null;
    try {
      grant = await this.#options.grantStore.consumeSha256(sha256Hex(tokenBytes), this.#now());
    } catch {
      this.#log({ type: "grant_store_error" });
      rejectUpgrade(socket, 503);
      return;
    } finally {
      tokenBytes.fill(0);
      this.#pendingUpgrades -= 1;
    }

    const now = this.#now();
    if (grant === null || !isResolvedGrantValid(grant, now, this.#limits.maxGrantRemainingLifetimeMs)) {
      rejectUpgrade(socket, 401);
      return;
    }
    if (!this.#started) {
      rejectUpgrade(socket, 503);
      return;
    }
    if (!this.#canAdmit(grant)) {
      rejectUpgrade(socket, 503);
      return;
    }

    this.#webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      this.#attach(ws, grant as RelayGrant);
    });
  }

  #canAdmit(grant: RelayGrant): boolean {
    if (this.#connections.size >= this.#limits.maxConnections) {
      return false;
    }
    const route = this.#routes.get(grant.routeId);
    if (route === undefined) {
      return this.#routes.size < this.#limits.maxRoutes;
    }
    if (grant.role === "host") {
      return route.host === undefined;
    }
    return route.devices.size < this.#limits.maxDevicesPerRoute && !route.deviceEndpoints.has(grant.endpointId);
  }

  #attach(ws: WebSocket, grant: RelayGrant): void {
    // Admission is checked again synchronously at attachment so an unusual
    // upgrade interleaving cannot exceed route limits.
    if (!this.#canAdmit(grant)) {
      ws.close(1013);
      return;
    }

    const route = this.#routes.get(grant.routeId) ?? {
      host: undefined,
      devices: new Map<string, ConnectionState>(),
      deviceEndpoints: new Set<string>(),
    };
    this.#routes.set(grant.routeId, route);

    const channelId = grant.role === "host" ? new Uint8Array(ZERO_CHANNEL_ID) : this.#newChannelId(route);
    const state: ConnectionState = {
      ws,
      grant,
      channelId,
      channelKey: channelKey(channelId),
      frameWindowStartedAt: this.#now(),
      framesInWindow: 0,
      acceptingFrames: true,
      closed: false,
    };
    if (grant.role === "host") {
      route.host = state;
    } else {
      route.devices.set(state.channelKey, state);
      route.deviceEndpoints.add(grant.endpointId);
    }
    this.#connections.add(state);
    ws.binaryType = "arraybuffer";

    ws.on("message", (data, isBinary) => this.#onMessage(state, data, isBinary));
    ws.on("close", (code) => this.#onClose(state, code));
    ws.on("error", () => this.#log({ type: "connection_error", role: grant.role }));
    this.#log({ type: "connection_open", role: grant.role });

    this.#sendControl(state, "ready", state.channelId, 0n);
    if (grant.role === "host") {
      for (const device of route.devices.values()) {
        this.#sendControl(state, "peer_open", device.channelId, 0n);
        this.#sendControl(device, "peer_open", device.channelId, 0n);
      }
    } else if (route.host !== undefined) {
      this.#sendControl(route.host, "peer_open", state.channelId, 0n);
      this.#sendControl(state, "peer_open", state.channelId, 0n);
    }
  }

  #onMessage(sender: ConnectionState, data: RawData, isBinary: boolean): void {
    if (sender.closed || !sender.acceptingFrames || sender.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (!isBinary) {
      this.#rejectFrame(sender, "binary", 1003);
      return;
    }
    const bytes = toUint8Array(data);
    if (bytes.byteLength > MAX_RELAY_ROUTING_FRAME_BYTES) {
      this.#rejectFrame(sender, "size", 1009);
      return;
    }
    if (!this.#consumeRateBudget(sender)) {
      this.#rejectFrame(sender, "rate", 1008);
      return;
    }

    let frame: RelayRoutingFrame;
    try {
      frame = decodeRelayRoutingFrame(bytes);
    } catch {
      this.#rejectFrame(sender, "codec", 1008);
      return;
    }
    if (frame.kind !== "data") {
      this.#rejectFrame(sender, "policy", 1008);
      return;
    }

    const route = this.#routes.get(sender.grant.routeId);
    if (route === undefined) {
      this.#sendForwardResult(sender, frame, RELAY_FORWARD_STATUS.unavailable);
      return;
    }

    if (sender.grant.role === "device") {
      if (!equalChannelIds(frame.channelId, sender.channelId)) {
        this.#rejectFrame(sender, "policy", 1008);
        return;
      }
      this.#forward(sender, route.host, frame, bytes, "device_to_host");
      return;
    }

    this.#forward(sender, route.devices.get(channelKey(frame.channelId)), frame, bytes, "host_to_device");
  }

  #forward(
    sender: ConnectionState,
    recipient: ConnectionState | undefined,
    frame: RelayRoutingFrame,
    wireBytes: Uint8Array,
    direction: "host_to_device" | "device_to_host",
  ): void {
    if (recipient === undefined || recipient.closed || recipient.ws.readyState !== WebSocket.OPEN) {
      this.#log({ type: "frame_dropped", reason: "unavailable", bytes: wireBytes.byteLength });
      this.#sendForwardResult(sender, frame, RELAY_FORWARD_STATUS.unavailable);
      return;
    }
    if (recipient.ws.bufferedAmount + wireBytes.byteLength > this.#limits.maxBufferedBytesPerConnection) {
      this.#log({ type: "frame_dropped", reason: "backpressure", bytes: wireBytes.byteLength });
      this.#sendForwardResult(sender, frame, RELAY_FORWARD_STATUS.backpressure);
      return;
    }

    try {
      recipient.ws.send(wireBytes, { binary: true, compress: false }, (error) => {
        if (error != null && !recipient.closed) {
          recipient.ws.terminate();
        }
      });
      // This receipt means only that the bounded peer socket accepted the
      // frame. End-to-end delivery remains the encrypted protocol's job.
      this.#log({ type: "frame_forwarded", direction, bytes: wireBytes.byteLength });
      this.#sendForwardResult(sender, frame, RELAY_FORWARD_STATUS.acceptedByPeerSocket);
    } catch {
      this.#log({ type: "frame_dropped", reason: "unavailable", bytes: wireBytes.byteLength });
      this.#sendForwardResult(sender, frame, RELAY_FORWARD_STATUS.unavailable);
    }
  }

  #sendForwardResult(sender: ConnectionState, original: RelayRoutingFrame, status: number): void {
    this.#sendControl(sender, "forward_result", original.channelId, original.messageId, Uint8Array.of(status));
  }

  #sendControl(
    recipient: ConnectionState,
    kind: "ready" | "peer_open" | "forward_result" | "peer_close",
    channelId: Uint8Array,
    messageId: bigint,
    payload: Uint8Array = new Uint8Array(0),
  ): void {
    if (recipient.closed || recipient.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      const wire = encodeRelayRoutingFrame({ kind, channelId, messageId, payload });
      if (recipient.ws.bufferedAmount + wire.byteLength > this.#limits.maxBufferedBytesPerConnection) {
        recipient.ws.close(1013);
        return;
      }
      recipient.ws.send(wire, { binary: true, compress: false }, (error) => {
        if (error != null && !recipient.closed) recipient.ws.terminate();
      });
    } catch {
      if (!recipient.closed) recipient.ws.terminate();
    }
  }

  #consumeRateBudget(connection: ConnectionState): boolean {
    const now = this.#now();
    if (now - connection.frameWindowStartedAt >= 1_000 || now < connection.frameWindowStartedAt) {
      connection.frameWindowStartedAt = now;
      connection.framesInWindow = 0;
    }
    connection.framesInWindow += 1;
    return connection.framesInWindow <= this.#limits.maxFramesPerSecondPerConnection;
  }

  #rejectFrame(connection: ConnectionState, category: Extract<RelayLogEvent, { type: "frame_rejected" }>["category"], code: number): void {
    connection.acceptingFrames = false;
    this.#log({ type: "frame_rejected", role: connection.grant.role, category });
    connection.ws.close(code);
  }

  #onClose(connection: ConnectionState, code: number): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    this.#connections.delete(connection);
    const route = this.#routes.get(connection.grant.routeId);
    if (route !== undefined) {
      if (connection.grant.role === "host") {
        if (route.host === connection) {
          route.host = undefined;
          for (const device of route.devices.values()) {
            this.#sendControl(device, "peer_close", device.channelId, 0n);
          }
        }
      } else {
        route.devices.delete(connection.channelKey);
        route.deviceEndpoints.delete(connection.grant.endpointId);
        if (route.host !== undefined) {
          this.#sendControl(route.host, "peer_close", connection.channelId, 0n);
        }
      }
      if (route.host === undefined && route.devices.size === 0) {
        this.#routes.delete(connection.grant.routeId);
      }
    }
    this.#log({ type: "connection_close", role: connection.grant.role, code });
  }

  #newChannelId(route: RouteState): Uint8Array {
    for (;;) {
      const candidate = new Uint8Array(randomBytes(RELAY_ROUTING_CHANNEL_ID_BYTES));
      if (!route.devices.has(channelKey(candidate))) {
        return candidate;
      }
    }
  }
}

function mergeLimits(overrides: Partial<RelayServerLimits> | undefined): RelayServerLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (limits.maxBufferedBytesPerConnection < MAX_RELAY_ROUTING_FRAME_BYTES) {
    throw new TypeError("maxBufferedBytesPerConnection must permit one maximum relay frame");
  }
  return limits;
}

function validatePath(path: string): string {
  if (!/^\/[A-Za-z0-9/_-]*$/.test(path) || path.length > 128) {
    throw new TypeError("Relay path must be a bounded absolute path without a query string");
  }
  return path;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host.toLowerCase() === "localhost";
}

function isAllowedUpgradeRequest(request: IncomingMessage, path: string): boolean {
  if (request.method !== "GET" || request.url !== path) {
    return false;
  }
  // This endpoint is for native clients, never ambient browser credentials.
  // Rejecting Origin-bearing upgrades also prevents a future bearer-token leak
  // from becoming a cross-site WebSocket control path.
  if (countRawHeader(request, "origin") !== 0) {
    return false;
  }
  if (countRawHeader(request, "sec-websocket-protocol") !== 1) {
    return false;
  }
  return request.headers["sec-websocket-protocol"] === RELAY_SUBPROTOCOL;
}

function scrubRawHeader(request: IncomingMessage, wantedName: string): void {
  if (wantedName === "authorization") {
    delete request.headers.authorization;
  }
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === wantedName && index + 1 < request.rawHeaders.length) {
      request.rawHeaders[index + 1] = "[redacted]";
    }
  }
}

function countRawHeader(request: IncomingMessage, wantedName: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === wantedName) {
      count += 1;
    }
  }
  return count;
}

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 503): void {
  if (socket.destroyed) {
    return;
  }
  const statusText = status === 400 ? "Bad Request" : status === 401 ? "Unauthorized" : "Service Unavailable";
  const authenticate = status === 401 ? "WWW-Authenticate: Bearer\r\n" : "";
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nCache-Control: no-store\r\n${authenticate}Content-Length: 0\r\n\r\n`,
  );
}

function isResolvedGrantValid(grant: RelayGrant, now: number, maxRemainingLifetimeMs: number): boolean {
  return (
    typeof grant.routeId === "string" &&
    grant.routeId.length >= 1 &&
    grant.routeId.length <= 128 &&
    typeof grant.endpointId === "string" &&
    grant.endpointId.length >= 1 &&
    grant.endpointId.length <= 128 &&
    (grant.role === "host" || grant.role === "device") &&
    Number.isSafeInteger(grant.expiresAt) &&
    grant.expiresAt > now &&
    grant.expiresAt - now <= maxRemainingLifetimeMs
  );
}

function channelKey(channelId: Uint8Array): string {
  return Buffer.from(channelId).toString("hex");
}

function equalChannelIds(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data);
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
