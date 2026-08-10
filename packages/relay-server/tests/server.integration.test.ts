import { once } from "node:events";
import WebSocket, { type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeRelayRoutingFrame,
  encodeRelayRoutingFrame,
  MAX_RELAY_ROUTING_FRAME_BYTES,
  MAX_RELAY_ROUTING_PAYLOAD_BYTES,
  type RelayRoutingFrame,
} from "../../../src/shared/relay-routing";
import { InMemoryRelayGrantStore } from "../src/grant-store";
import {
  MAX_RELAY_IDLE_CONNECTION_TIMEOUT_MS,
  MIN_RELAY_IDLE_CONNECTION_TIMEOUT_MS,
  PrimeRelayServer,
  RELAY_FORWARD_STATUS,
  RELAY_IDLE_CLOSE_CODE,
  RELAY_IDLE_CLOSE_REASON,
  RELAY_SUBPROTOCOL,
  type RelayLogEvent,
  type RelayScheduledTask,
  type RelayServerLimits,
  type RelayServerScheduler,
} from "../src/server";

const NOW = 1_000_000;
const servers: PrimeRelayServer[] = [];
const clients: RelayTestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.terminate();
  }
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe("PrimeRelayServer transport policy", () => {
  it("refuses plaintext production listeners and limits the test escape hatch to loopback", () => {
    const grantStore = new InMemoryRelayGrantStore();
    expect(() => new PrimeRelayServer({ grantStore })).toThrow(/requires TLS/);
    expect(
      () => new PrimeRelayServer({ grantStore, host: "0.0.0.0", allowInsecureLoopbackForTests: true }),
    ).toThrow(/requires TLS/);
    expect(
      () => new PrimeRelayServer({ grantStore, tls: {}, scheduler: new RacyRelayScheduler() }),
    ).toThrow(/custom relay scheduler is allowed only on loopback with the explicit test option/);
    expect(
      () => new PrimeRelayServer({
        grantStore,
        host: "0.0.0.0",
        tls: {},
        allowInsecureLoopbackForTests: true,
        scheduler: new RacyRelayScheduler(),
      }),
    ).toThrow(/custom relay scheduler is allowed only on loopback with the explicit test option/);
    expect(
      () => new PrimeRelayServer({
        grantStore,
        host: "127.0.0.1",
        allowInsecureLoopbackForTests: true,
        limits: { idleConnectionTimeoutMs: MIN_RELAY_IDLE_CONNECTION_TIMEOUT_MS - 1 },
      }),
    ).toThrow(/idleConnectionTimeoutMs must be between/);
    expect(
      () => new PrimeRelayServer({
        grantStore,
        host: "127.0.0.1",
        allowInsecureLoopbackForTests: true,
        limits: { idleConnectionTimeoutMs: MAX_RELAY_IDLE_CONNECTION_TIMEOUT_MS + 1 },
      }),
    ).toThrow(/idleConnectionTimeoutMs must be between/);
  });

  it("requires the exact binary routing subprotocol and never reads credentials from the URL", async () => {
    const harness = await startHarness();
    const token = harness.issue("host", "route-auth", "host-auth");

    expect(await rejectedStatus(`${harness.server.url}?access_token=${token}`, undefined)).toBe(400);
    expect(await rejectedStatus(harness.server.url, token, "another-protocol")).toBe(400);

    // Syntax failures do not burn the one-shot grant. The same token succeeds
    // only when supplied in the Authorization header on the exact path.
    const client = await connect(harness.server.url, token);
    expect((await client.nextKind("ready")).kind).toBe("ready");
    expect(client.protocol).toBe(RELAY_SUBPROTOCOL);
    expect(client.extensions).toBe("");
  });

  it("rejects browser-origin upgrades before consuming the one-shot native grant", async () => {
    const harness = await startHarness();
    const token = harness.issue("host", "route-origin", "host-origin");

    expect(
      await rejectedStatus(harness.server.url, token, RELAY_SUBPROTOCOL, { Origin: "https://attacker.example" }),
    ).toBe(400);

    const nativeClient = await connect(harness.server.url, token);
    expect((await nativeClient.nextKind("ready")).kind).toBe("ready");
  });

  it("returns the same non-oracular response for bad, expired, and reused grants", async () => {
    const harness = await startHarness();
    const bad = Buffer.alloc(32, 0xee).toString("base64url");
    const expired = harness.issue("host", "route-expired", "host-expired", NOW);
    const valid = harness.issue("host", "route-reused", "host-reused");

    const first = await connect(harness.server.url, valid);
    await first.nextKind("ready");
    first.terminate();
    await first.closed;

    const responses = await Promise.all([
      rejected(harness.server.url, bad),
      rejected(harness.server.url, expired),
      rejected(harness.server.url, valid),
    ]);
    expect(responses).toEqual([
      { status: 401, body: "" },
      { status: 401, body: "" },
      { status: 401, body: "" },
    ]);
  });
});

describe("PrimeRelayServer admission and isolation", () => {
  it("enforces one host, unique bounded device channels, and the global connection cap", async () => {
    const harness = await startHarness({ maxConnections: 3, maxDevicesPerRoute: 1 });
    const host = await connect(harness.server.url, harness.issue("host", "route-a", "host-a"));
    await host.nextKind("ready");

    const duplicateHostToken = harness.issue("host", "route-a", "host-b");
    expect(await rejectedStatus(harness.server.url, duplicateHostToken)).toBe(503);
    expect(await rejectedStatus(harness.server.url, duplicateHostToken)).toBe(401);

    const device = await connect(harness.server.url, harness.issue("device", "route-a", "device-a"));
    await device.nextKind("ready");
    expect(await rejectedStatus(harness.server.url, harness.issue("device", "route-a", "device-b"))).toBe(503);

    const otherHost = await connect(harness.server.url, harness.issue("host", "route-b", "host-c"));
    await otherHost.nextKind("ready");
    expect(await rejectedStatus(harness.server.url, harness.issue("host", "route-c", "host-d"))).toBe(503);

    expect(harness.server.snapshot()).toMatchObject({
      routeCount: 2,
      connectionCount: 3,
      hostConnectionCount: 2,
      deviceChannelCount: 1,
    });
  });

  it("forwards opaque data only within a grant route and never reveals another route's channel", async () => {
    const harness = await startHarness();
    const hostA = await connect(harness.server.url, harness.issue("host", "route-a", "host-a"));
    const deviceA = await connect(harness.server.url, harness.issue("device", "route-a", "device-a"));
    const hostB = await connect(harness.server.url, harness.issue("host", "route-b", "host-b"));
    const deviceB = await connect(harness.server.url, harness.issue("device", "route-b", "device-b"));

    await hostA.nextKind("ready");
    const readyA = await deviceA.nextKind("ready");
    await hostB.nextKind("ready");
    const readyB = await deviceB.nextKind("ready");
    await hostA.nextKind("peer_open");
    await deviceA.nextKind("peer_open");
    await hostB.nextKind("peer_open");
    await deviceB.nextKind("peer_open");

    const secret = new TextEncoder().encode("opaque-secret-for-route-a");
    const deviceWire = encodeRelayRoutingFrame({
      kind: "data",
      channelId: readyA.channelId,
      messageId: 41n,
      payload: secret,
    });
    deviceA.sendBinary(deviceWire);
    const deliveredToHostA = await hostA.nextKind("data");
    expect(deliveredToHostA.payload).toEqual(secret);
    expect(await deviceA.nextForwardResult(41n)).toBe(RELAY_FORWARD_STATUS.acceptedByPeerSocket);
    await hostB.expectNoKind("data");

    const hostWire = encodeRelayRoutingFrame({
      kind: "data",
      channelId: readyA.channelId,
      messageId: 42n,
      payload: new Uint8Array([9, 8, 7]),
    });
    hostA.sendBinary(hostWire);
    expect((await deviceA.nextKind("data")).payload).toEqual(new Uint8Array([9, 8, 7]));
    expect(await hostA.nextForwardResult(42n)).toBe(RELAY_FORWARD_STATUS.acceptedByPeerSocket);

    // A channel learned on route B is unavailable on route A and cannot be
    // used as a cross-route oracle or forwarding target.
    hostA.sendFrame({
      kind: "data",
      channelId: readyB.channelId,
      messageId: 43n,
      payload: new Uint8Array([6, 6, 6]),
    });
    expect(await hostA.nextForwardResult(43n)).toBe(RELAY_FORWARD_STATUS.unavailable);
    await deviceB.expectNoKind("data");

    // A device is bound to its server-assigned channel and is disconnected if
    // it attempts to claim a different one.
    deviceA.sendFrame({
      kind: "data",
      channelId: readyB.channelId,
      messageId: 44n,
      payload: new Uint8Array([1]),
    });
    expect((await deviceA.closed).code).toBe(1008);
  });
});

describe("PrimeRelayServer frame policy and offline behavior", () => {
  it("rejects text, malformed, client control, and oversized messages", async () => {
    const harness = await startHarness();

    const textClient = await connect(harness.server.url, harness.issue("host", "route-text", "host-text"));
    await textClient.nextKind("ready");
    textClient.sendText("not-binary");
    expect((await textClient.closed).code).toBe(1003);

    const malformed = await connect(harness.server.url, harness.issue("host", "route-bad", "host-bad"));
    await malformed.nextKind("ready");
    malformed.sendBinary(new Uint8Array([1, 2, 3]));
    expect((await malformed.closed).code).toBe(1008);

    const control = await connect(harness.server.url, harness.issue("host", "route-control", "host-control"));
    const controlReady = await control.nextKind("ready");
    control.sendFrame({ kind: "peer_open", channelId: controlReady.channelId, messageId: 1n, payload: new Uint8Array() });
    expect((await control.closed).code).toBe(1008);

    const oversized = await connect(harness.server.url, harness.issue("host", "route-large", "host-large"));
    await oversized.nextKind("ready");
    oversized.sendBinary(new Uint8Array(MAX_RELAY_ROUTING_FRAME_BYTES + 1));
    expect((await oversized.closed).code).toBe(1009);
  });

  it("does not queue data while a peer is offline or deliver it after reconnection", async () => {
    const harness = await startHarness();
    const host = await connect(harness.server.url, harness.issue("host", "route-offline", "host-offline"));
    await host.nextKind("ready");

    const device = await connect(harness.server.url, harness.issue("device", "route-offline", "device-offline"));
    const ready = await device.nextKind("ready");
    await host.nextKind("peer_open");
    await device.nextKind("peer_open");
    device.close();
    await device.closed;
    await host.nextKind("peer_close");

    host.sendFrame({
      kind: "data",
      channelId: ready.channelId,
      messageId: 77n,
      payload: new TextEncoder().encode("must-never-be-queued"),
    });
    expect(await host.nextForwardResult(77n)).toBe(RELAY_FORWARD_STATUS.unavailable);

    const reconnected = await connect(
      harness.server.url,
      harness.issue("device", "route-offline", "device-offline"),
    );
    const nextReady = await reconnected.nextKind("ready");
    expect(nextReady.channelId).not.toEqual(ready.channelId);
    await reconnected.nextKind("peer_open");
    await reconnected.expectNoKind("data");
  });

  it("keeps opaque plaintext out of router state and structured logs", async () => {
    const logs: RelayLogEvent[] = [];
    const harness = await startHarness(undefined, logs);
    const routeId = "sensitive-route-name";
    const endpointId = "sensitive-device-name";
    const host = await connect(harness.server.url, harness.issue("host", routeId, "host-private"));
    const device = await connect(harness.server.url, harness.issue("device", routeId, endpointId));
    await host.nextKind("ready");
    const ready = await device.nextKind("ready");
    await host.nextKind("peer_open");
    await device.nextKind("peer_open");

    const plaintext = "PLAINTEXT-MUST-NOT-ENTER-RELAY-STATE-9f31";
    device.sendFrame({
      kind: "data",
      channelId: ready.channelId,
      messageId: 99n,
      payload: new TextEncoder().encode(plaintext),
    });
    expect(new TextDecoder().decode((await host.nextKind("data")).payload)).toBe(plaintext);
    await device.nextForwardResult(99n);

    const observableRelayData = JSON.stringify({ logs, state: harness.server.snapshot() });
    expect(observableRelayData).not.toContain(plaintext);
    expect(observableRelayData).not.toContain(routeId);
    expect(observableRelayData).not.toContain(endpointId);
  });

  it("drops rather than queues when the recipient crosses the backpressure bound", async () => {
    const harness = await startHarness({
      maxBufferedBytesPerConnection: MAX_RELAY_ROUTING_FRAME_BYTES,
      maxFramesPerSecondPerConnection: 256,
    });
    const host = await connect(harness.server.url, harness.issue("host", "route-pressure", "host-pressure"));
    const device = await connect(harness.server.url, harness.issue("device", "route-pressure", "device-pressure"));
    await host.nextKind("ready");
    const ready = await device.nextKind("ready");
    await host.nextKind("peer_open");
    await device.nextKind("peer_open");

    device.pauseSocket();
    const payload = new Uint8Array(MAX_RELAY_ROUTING_PAYLOAD_BYTES).fill(0xa5);
    for (let messageId = 1n; messageId <= 96n; messageId += 1n) {
      host.sendFrame({ kind: "data", channelId: ready.channelId, messageId, payload });
    }

    const statuses = await host.collectForwardResults(96, 10_000);
    expect(statuses).toContain(RELAY_FORWARD_STATUS.backpressure);
    expect(harness.server.snapshot().bufferedBytes).toBeLessThanOrEqual(MAX_RELAY_ROUTING_FRAME_BYTES * 2);
  });
});

describe("PrimeRelayServer idle connection policy", () => {
  it("closes an idle connection with the fixed private code and metadata-only reason", async () => {
    const scheduler = new ManualRelayScheduler();
    const logs: RelayLogEvent[] = [];
    const harness = await startHarness(
      { idleConnectionTimeoutMs: MIN_RELAY_IDLE_CONNECTION_TIMEOUT_MS },
      logs,
      { scheduler, now: () => scheduler.now },
    );
    const routeId = "idle-sensitive-route";
    const endpointId = "idle-sensitive-endpoint";
    const client = await connect(harness.server.url, harness.issue("host", routeId, endpointId));
    await client.nextKind("ready");

    expect(scheduler.pendingCount).toBe(1);
    scheduler.advanceBy(MIN_RELAY_IDLE_CONNECTION_TIMEOUT_MS - 1);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    scheduler.advanceBy(1);

    expect(await client.closed).toEqual({ code: RELAY_IDLE_CLOSE_CODE, reason: RELAY_IDLE_CLOSE_REASON });
    expect(scheduler.pendingCount).toBe(0);
    expect(logs).toContainEqual({ type: "connection_idle_timeout", role: "host" });
    const observable = JSON.stringify(logs);
    expect(observable).not.toContain(routeId);
    expect(observable).not.toContain(endpointId);
  });

  it("resets only after accepted routing activity and clears the timer on policy close", async () => {
    const scheduler = new ManualRelayScheduler();
    const harness = await startHarness(
      { idleConnectionTimeoutMs: MIN_RELAY_IDLE_CONNECTION_TIMEOUT_MS },
      [],
      { scheduler, now: () => scheduler.now },
    );
    const host = await connect(harness.server.url, harness.issue("host", "route-active", "host-active"));
    await host.nextKind("ready");

    scheduler.advanceBy(MIN_RELAY_IDLE_CONNECTION_TIMEOUT_MS - 100);
    host.sendFrame({
      kind: "data",
      channelId: new Uint8Array(16).fill(0x31),
      messageId: 1n,
      payload: new Uint8Array([1]),
    });
    expect(await host.nextForwardResult(1n)).toBe(RELAY_FORWARD_STATUS.unavailable);

    scheduler.advanceBy(MIN_RELAY_IDLE_CONNECTION_TIMEOUT_MS - 1);
    expect(host.ws.readyState).toBe(WebSocket.OPEN);
    scheduler.advanceBy(1);
    expect(await host.closed).toEqual({ code: RELAY_IDLE_CLOSE_CODE, reason: RELAY_IDLE_CLOSE_REASON });

    const rejected = await connect(
      harness.server.url,
      harness.issue("host", "route-rejected-activity", "host-rejected-activity"),
    );
    await rejected.nextKind("ready");
    expect(scheduler.pendingCount).toBe(1);
    rejected.sendText("not-accepted-activity");
    expect((await rejected.closed).code).toBe(1003);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("does not let peer data or server routing controls keep a silent endpoint alive", async () => {
    const scheduler = new ManualRelayScheduler();
    const harness = await startHarness(
      { idleConnectionTimeoutMs: MIN_RELAY_IDLE_CONNECTION_TIMEOUT_MS },
      [],
      { scheduler, now: () => scheduler.now },
    );
    const host = await connect(harness.server.url, harness.issue("host", "route-control-idle", "host-control-idle"));
    await host.nextKind("ready");

    scheduler.advanceBy(MIN_RELAY_IDLE_CONNECTION_TIMEOUT_MS - 100);
    const device = await connect(
      harness.server.url,
      harness.issue("device", "route-control-idle", "device-control-idle"),
    );
    const deviceReady = await device.nextKind("ready");
    await host.nextKind("peer_open");
    await device.nextKind("peer_open");
    device.sendFrame({
      kind: "data",
      channelId: deviceReady.channelId,
      messageId: 9n,
      payload: new Uint8Array([9]),
    });
    await host.nextKind("data");
    expect(await device.nextForwardResult(9n)).toBe(RELAY_FORWARD_STATUS.acceptedByPeerSocket);

    scheduler.advanceBy(99);
    expect(host.ws.readyState).toBe(WebSocket.OPEN);
    scheduler.advanceBy(1);
    expect(await host.closed).toEqual({ code: RELAY_IDLE_CLOSE_CODE, reason: RELAY_IDLE_CLOSE_REASON });
    expect(device.ws.readyState).toBe(WebSocket.OPEN);
  });

  it.each([
    ["synchronous expiry", "expire", RELAY_IDLE_CLOSE_CODE],
    ["scheduler failure", "throw", 1006],
  ] as const)("does not forward accepted data after %s closes its sender", async (_label, mode, closeCode) => {
    const scheduler = new FaultRelayScheduler();
    const harness = await startHarness(
      { idleConnectionTimeoutMs: MIN_RELAY_IDLE_CONNECTION_TIMEOUT_MS },
      [],
      { scheduler },
    );
    const host = await connect(harness.server.url, harness.issue("host", `route-${mode}`, `host-${mode}`));
    await host.nextKind("ready");
    const device = await connect(harness.server.url, harness.issue("device", `route-${mode}`, `device-${mode}`));
    const deviceReady = await device.nextKind("ready");
    await host.nextKind("peer_open");
    await device.nextKind("peer_open");

    scheduler.mode = mode;
    host.sendFrame({
      kind: "data",
      channelId: deviceReady.channelId,
      messageId: 10n,
      payload: new Uint8Array([10]),
    });

    expect((await host.closed).code).toBe(closeCode);
    await device.expectNoKind("data");
  });

  it("does not announce a peer whose initial idle scheduling fails", async () => {
    const scheduler = new FaultRelayScheduler();
    const harness = await startHarness(
      { idleConnectionTimeoutMs: MIN_RELAY_IDLE_CONNECTION_TIMEOUT_MS },
      [],
      { scheduler },
    );
    const host = await connect(harness.server.url, harness.issue("host", "route-attach-failure", "host-attach-failure"));
    await host.nextKind("ready");

    scheduler.mode = "throw";
    const device = await connect(
      harness.server.url,
      harness.issue("device", "route-attach-failure", "device-attach-failure"),
    );
    expect((await device.closed).code).toBe(1006);
    await host.expectNoKind("peer_open");
  });

  it("ignores a canceled scheduler callback after a newer activity generation is armed even when cancellation throws", async () => {
    const scheduler = new RacyRelayScheduler();
    const harness = await startHarness(
      { idleConnectionTimeoutMs: MIN_RELAY_IDLE_CONNECTION_TIMEOUT_MS },
      [],
      { scheduler },
    );
    const host = await connect(harness.server.url, harness.issue("host", "route-stale-timer", "host-stale-timer"));
    await host.nextKind("ready");
    expect(scheduler.callbackCount).toBe(1);

    host.sendFrame({
      kind: "data",
      channelId: new Uint8Array(16).fill(0x42),
      messageId: 8n,
      payload: new Uint8Array([8]),
    });
    expect(await host.nextForwardResult(8n)).toBe(RELAY_FORWARD_STATUS.unavailable);
    expect(scheduler.callbackCount).toBeGreaterThan(1);

    scheduler.fire(0);
    expect(host.ws.readyState).toBe(WebSocket.OPEN);
    scheduler.fireLatest();
    expect(await host.closed).toEqual({ code: RELAY_IDLE_CLOSE_CODE, reason: RELAY_IDLE_CLOSE_REASON });
  });

  it("clears every scheduled idle task on connection close and server stop", async () => {
    const scheduler = new ManualRelayScheduler();
    const harness = await startHarness(
      { idleConnectionTimeoutMs: MIN_RELAY_IDLE_CONNECTION_TIMEOUT_MS },
      [],
      { scheduler, now: () => scheduler.now },
    );
    const first = await connect(harness.server.url, harness.issue("host", "route-first", "host-first"));
    const second = await connect(harness.server.url, harness.issue("host", "route-second", "host-second"));
    await first.nextKind("ready");
    await second.nextKind("ready");
    expect(scheduler.pendingCount).toBe(2);

    first.close();
    await first.closed;
    await waitForTurn(() => harness.server.snapshot().connectionCount === 1);
    expect(scheduler.pendingCount).toBe(1);

    await harness.server.stop();
    expect(scheduler.pendingCount).toBe(0);
  });
});

interface RelayHarness {
  readonly server: PrimeRelayServer;
  readonly store: InMemoryRelayGrantStore;
  issue(role: "host" | "device", routeId: string, endpointId: string, expiresAt?: number): string;
}

async function startHarness(
  limits?: Partial<RelayServerLimits>,
  logs: RelayLogEvent[] = [],
  timing: { readonly scheduler?: RelayServerScheduler; readonly now?: () => number } = {},
): Promise<RelayHarness> {
  const store = new InMemoryRelayGrantStore();
  const server = new PrimeRelayServer({
    grantStore: store,
    host: "127.0.0.1",
    port: 0,
    allowInsecureLoopbackForTests: true,
    now: timing.now ?? (() => NOW),
    scheduler: timing.scheduler,
    limits,
    logger: (event) => logs.push(event),
  });
  servers.push(server);
  await server.start();
  let tokenCounter = 0;
  return {
    server,
    store,
    issue(role, routeId, endpointId, expiresAt = NOW + 60_000) {
      tokenCounter += 1;
      const tokenBytes = new Uint8Array(32);
      new DataView(tokenBytes.buffer).setUint32(28, tokenCounter, false);
      return store.issue({ role, routeId, endpointId, expiresAt, tokenBytes });
    },
  };
}

class ManualRelayScheduler implements RelayServerScheduler {
  now = NOW;
  readonly #tasks = new Map<number, { readonly dueAt: number; readonly callback: () => void }>();
  #nextId = 0;

  get pendingCount(): number {
    return this.#tasks.size;
  }

  schedule(delayMs: number, callback: () => void): RelayScheduledTask {
    this.#nextId += 1;
    const id = this.#nextId;
    this.#tasks.set(id, { dueAt: this.now + delayMs, callback });
    return { cancel: () => this.#tasks.delete(id) };
  }

  advanceBy(durationMs: number): void {
    this.now += durationMs;
    for (;;) {
      const due = [...this.#tasks.entries()]
        .filter(([, task]) => task.dueAt <= this.now)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (due === undefined) {
        return;
      }
      this.#tasks.delete(due[0]);
      due[1].callback();
    }
  }
}

class RacyRelayScheduler implements RelayServerScheduler {
  readonly #callbacks: Array<() => void> = [];

  get callbackCount(): number {
    return this.#callbacks.length;
  }

  schedule(_delayMs: number, callback: () => void): RelayScheduledTask {
    this.#callbacks.push(callback);
    // Deliberately retain canceled callbacks to model a scheduler callback
    // already queued on another turn when cancellation races it.
    return { cancel: () => { throw new Error("simulated cancellation failure"); } };
  }

  fire(index: number): void {
    const callback = this.#callbacks[index];
    if (callback === undefined) {
      throw new Error(`Missing scheduled callback ${index}`);
    }
    callback();
  }

  fireLatest(): void {
    this.fire(this.#callbacks.length - 1);
  }
}

class FaultRelayScheduler implements RelayServerScheduler {
  mode: "hold" | "expire" | "throw" = "hold";

  schedule(_delayMs: number, callback: () => void): RelayScheduledTask {
    if (this.mode === "throw") {
      throw new Error("simulated scheduling failure");
    }
    if (this.mode === "expire") {
      callback();
    }
    return { cancel: () => undefined };
  }
}

class RelayTestClient {
  readonly ws: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #frames: RelayRoutingFrame[] = [];
  readonly #waiters: Array<() => void> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        return;
      }
      this.#frames.push(decodeRelayRoutingFrame(rawDataBytes(data)));
      for (const wake of this.#waiters.splice(0)) {
        wake();
      }
    });
  }

  get protocol(): string {
    return this.ws.protocol;
  }

  get extensions(): string {
    return this.ws.extensions;
  }

  sendFrame(frame: RelayRoutingFrame): void {
    this.sendBinary(encodeRelayRoutingFrame(frame));
  }

  sendBinary(bytes: Uint8Array): void {
    this.ws.send(bytes, { binary: true, compress: false });
  }

  sendText(text: string): void {
    this.ws.send(text);
  }

  close(): void {
    this.ws.close(1000);
  }

  terminate(): void {
    this.ws.terminate();
  }

  pauseSocket(): void {
    this.ws.pause();
  }

  async nextKind(kind: RelayRoutingFrame["kind"], timeoutMs = 2_000): Promise<RelayRoutingFrame> {
    return this.#take((frame) => frame.kind === kind, timeoutMs);
  }

  async nextForwardResult(messageId: bigint, timeoutMs = 2_000): Promise<number> {
    const frame = await this.#take((candidate) => candidate.kind === "forward_result" && candidate.messageId === messageId, timeoutMs);
    const status = frame.payload[0];
    if (frame.payload.byteLength !== 1 || status === undefined) {
      throw new Error("Malformed forward result in test");
    }
    return status;
  }

  async collectForwardResults(count: number, timeoutMs: number): Promise<number[]> {
    const results: number[] = [];
    const deadline = Date.now() + timeoutMs;
    while (results.length < count) {
      results.push(await this.nextForwardResult(BigInt(results.length + 1), Math.max(1, deadline - Date.now())));
    }
    return results;
  }

  async expectNoKind(kind: RelayRoutingFrame["kind"], durationMs = 80): Promise<void> {
    expect(this.#frames.some((frame) => frame.kind === kind)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    expect(this.#frames.some((frame) => frame.kind === kind)).toBe(false);
  }

  async #take(predicate: (frame: RelayRoutingFrame) => boolean, timeoutMs: number): Promise<RelayRoutingFrame> {
    const existing = this.#frames.findIndex(predicate);
    if (existing >= 0) {
      return this.#frames.splice(existing, 1)[0] as RelayRoutingFrame;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.#waiters.indexOf(wake);
        if (index >= 0) {
          this.#waiters.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for relay frame after ${timeoutMs}ms`));
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.#waiters.push(wake);
    });
    return this.#take(predicate, timeoutMs);
  }
}

async function connect(url: string, token: string): Promise<RelayTestClient> {
  const ws = new WebSocket(url, RELAY_SUBPROTOCOL, {
    headers: { Authorization: `Bearer ${token}` },
    perMessageDeflate: false,
    maxPayload: MAX_RELAY_ROUTING_FRAME_BYTES,
  });
  const client = new RelayTestClient(ws);
  clients.push(client);
  await Promise.race([
    once(ws, "open"),
    once(ws, "error").then(([error]) => Promise.reject(error)),
  ]);
  return client;
}

async function rejectedStatus(
  url: string,
  token: string | undefined,
  protocol: string = RELAY_SUBPROTOCOL,
  extraHeaders: Record<string, string> = {},
): Promise<number> {
  return (await rejected(url, token, protocol, extraHeaders)).status;
}

async function rejected(
  url: string,
  token: string | undefined,
  protocol: string = RELAY_SUBPROTOCOL,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const headers = { ...extraHeaders, ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) };
  const ws = new WebSocket(url, protocol, {
    headers: Object.keys(headers).length === 0 ? undefined : headers,
    perMessageDeflate: false,
  });
  ws.on("error", () => undefined);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("Timed out waiting for rejected relay upgrade"));
    }, 2_000);
    ws.once("unexpected-response", (_request, response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        clearTimeout(timeout);
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    ws.once("open", () => {
      clearTimeout(timeout);
      ws.terminate();
      reject(new Error("Expected relay upgrade to be rejected"));
    });
  });
}

function rawDataBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

async function waitForTurn(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for relay event-loop work");
}
