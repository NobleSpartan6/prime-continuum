import { describe, expect, it, vi } from "vitest";
import {
  createReliableRelayByteTunnel,
  type OpenRelayRoutingChannel,
} from "../../src/shared/reliable-relay-byte-tunnel";
import {
  MAX_RELAY_ROUTING_PAYLOAD_BYTES,
  type RelayRoutingFrame,
} from "../../src/shared/relay-routing";

describe("ReliableRelayByteTunnel", () => {
  it("fragments writes, waits for ordered receipts, and never retries accepted bytes", async () => {
    const wire = new TestWire();
    wire.onSend = (frame) => {
      wire.push(receipt(frame, 0));
    };
    const tunnel = createReliableRelayByteTunnel({ channelId: channel(1), wire });
    const payload = new Uint8Array(MAX_RELAY_ROUTING_PAYLOAD_BYTES + 7).fill(0xa5);

    await tunnel.send(payload);

    expect(wire.sent.map((frame) => frame.messageId)).toEqual([1n, 2n]);
    expect(wire.sent.every((frame) => frame.kind === "data")).toBe(true);
    expect(concat(wire.sent.map((frame) => frame.payload))).toEqual(payload);
    expect(wire.close).not.toHaveBeenCalled();
    tunnel.close();
  });

  it("does not send a later fragment until the prior fragment receipt arrives", async () => {
    const wire = new TestWire();
    const tunnel = createReliableRelayByteTunnel({ channelId: channel(11), wire });
    const pending = tunnel.send(new Uint8Array(MAX_RELAY_ROUTING_PAYLOAD_BYTES + 1).fill(0x5a));

    await vi.waitFor(() => expect(wire.sent).toHaveLength(1));
    await Promise.resolve();
    expect(wire.sent).toHaveLength(1);

    wire.push(receipt(wire.sent[0] as RelayRoutingFrame, 0));
    await vi.waitFor(() => expect(wire.sent).toHaveLength(2));
    wire.push(receipt(wire.sent[1] as RelayRoutingFrame, 0));
    await pending;

    expect(wire.sent.map((frame) => frame.messageId)).toEqual([1n, 2n]);
    tunnel.close();
  });

  it("serializes concurrent writers into one monotonic message-ID sequence", async () => {
    const wire = new TestWire();
    wire.onSend = (frame) => wire.push(receipt(frame, 0));
    const tunnel = createReliableRelayByteTunnel({ channelId: channel(2), wire });

    await Promise.all([tunnel.send(Uint8Array.of(1)), tunnel.send(Uint8Array.of(2))]);

    expect(wire.sent.map((frame) => [frame.messageId, frame.payload[0]])).toEqual([
      [1n, 1],
      [2n, 2],
    ]);
    tunnel.close();
  });

  it("makes a relay rejection terminal without retrying uncertain bytes", async () => {
    const wire = new TestWire();
    wire.onSend = (frame) => wire.push(receipt(frame, 2));
    const tunnel = createReliableRelayByteTunnel({ channelId: channel(3), wire });

    await expect(tunnel.send(Uint8Array.of(9, 8, 7))).rejects.toMatchObject({
      code: "FORWARD_REJECTED",
    });

    expect(wire.sent).toHaveLength(1);
    expect(wire.close).toHaveBeenCalledOnce();
    await expect(tunnel.send(Uint8Array.of(6))).rejects.toMatchObject({ code: "FORWARD_REJECTED" });
    expect(wire.sent).toHaveLength(1);
  });

  it("terminates a stalled connector send on receipt timeout and consumes its late rejection", async () => {
    const wire = new TestWire();
    const stalled = deferred<void>();
    wire.onSend = () => stalled.promise;
    const tunnel = createReliableRelayByteTunnel({
      channelId: channel(4),
      wire,
      receiptTimeoutMs: 5,
    });

    await expect(tunnel.send(Uint8Array.of(1))).rejects.toMatchObject({ code: "RECEIPT_TIMEOUT" });
    expect(wire.sent).toHaveLength(1);
    expect(wire.close).toHaveBeenCalledOnce();
    stalled.reject(new Error("late connector rejection"));
    await flushMicrotasks();
  });

  it("rejects an actual incoming gap before yielding bytes", async () => {
    const wire = new TestWire();
    const tunnel = createReliableRelayByteTunnel({ channelId: channel(5), wire });
    const iterator = tunnel.bytes[Symbol.asyncIterator]();
    const read = iterator.next();
    wire.push(data(channel(5), 2n, Uint8Array.of(2)));

    await expect(read).rejects.toMatchObject({ code: "INCOMING_SEQUENCE" });
    expect(wire.close).toHaveBeenCalledOnce();
  });

  it("rejects an incoming duplicate after yielding the preceding byte", async () => {
    const wire = new TestWire();
    const tunnel = createReliableRelayByteTunnel({ channelId: channel(12), wire });
    const iterator = tunnel.bytes[Symbol.asyncIterator]();
    wire.push(data(channel(12), 1n, Uint8Array.of(1)));
    await expect(iterator.next()).resolves.toEqual({ done: false, value: Uint8Array.of(1) });

    wire.push(data(channel(12), 1n, Uint8Array.of(2)));

    await expect(iterator.next()).rejects.toMatchObject({ code: "INCOMING_SEQUENCE" });
    expect(wire.close).toHaveBeenCalledOnce();
  });

  it("treats wrong-channel frames and unexpected control as terminal", async () => {
    const wrongWire = new TestWire();
    const wrongTunnel = createReliableRelayByteTunnel({ channelId: channel(6), wire: wrongWire });
    const wrongRead = wrongTunnel.bytes[Symbol.asyncIterator]().next();
    wrongWire.push(data(channel(7), 1n, Uint8Array.of(1)));
    await expect(wrongRead).rejects.toMatchObject({ code: "WRONG_ROUTING_CHANNEL" });

    const controlWire = new TestWire();
    const controlTunnel = createReliableRelayByteTunnel({ channelId: channel(8), wire: controlWire });
    const controlRead = controlTunnel.bytes[Symbol.asyncIterator]().next();
    controlWire.push({
      kind: "ready",
      channelId: channel(8),
      messageId: 0n,
      payload: new Uint8Array(),
    });
    await expect(controlRead).rejects.toMatchObject({ code: "UNEXPECTED_CONTROL" });
  });

  it("fails closed when a slow consumer exceeds the read budget", async () => {
    const wire = new TestWire();
    const tunnel = createReliableRelayByteTunnel({
      channelId: channel(9),
      wire,
      maxBufferedReadBytes: 3,
    });
    wire.push(data(channel(9), 1n, Uint8Array.of(1, 2, 3)));
    wire.push(data(channel(9), 2n, Uint8Array.of(4)));

    await vi.waitFor(() => expect(wire.close).toHaveBeenCalledOnce());
    await expect(tunnel.bytes[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "READ_BACKPRESSURE",
    });
    expect(wire.close).toHaveBeenCalledOnce();
  });

  it("rejects zero-length data and bounds a flood of tiny queued frames by item count", async () => {
    const emptyWire = new TestWire();
    const emptyTunnel = createReliableRelayByteTunnel({ channelId: channel(13), wire: emptyWire });
    const emptyRead = emptyTunnel.bytes[Symbol.asyncIterator]().next();
    emptyWire.push(data(channel(13), 1n, new Uint8Array()));
    await expect(emptyRead).rejects.toMatchObject({ code: "EMPTY_DATA" });

    const floodWire = new TestWire();
    const floodTunnel = createReliableRelayByteTunnel({
      channelId: channel(14),
      wire: floodWire,
      maxBufferedReadBytes: 100,
      maxBufferedReadItems: 2,
    });
    floodWire.push(data(channel(14), 1n, Uint8Array.of(1)));
    floodWire.push(data(channel(14), 2n, Uint8Array.of(2)));
    floodWire.push(data(channel(14), 3n, Uint8Array.of(3)));
    await vi.waitFor(() => expect(floodWire.close).toHaveBeenCalledOnce());
    await expect(floodTunnel.bytes[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "READ_BACKPRESSURE",
    });
  });

  it("permits one byte reader and one outstanding next call", async () => {
    const wire = new TestWire();
    const tunnel = createReliableRelayByteTunnel({ channelId: channel(15), wire });
    const reader = tunnel.bytes[Symbol.asyncIterator]();

    expect(() => tunnel.bytes[Symbol.asyncIterator]()).toThrowError(
      expect.objectContaining({ code: "MULTIPLE_READERS" }),
    );
    const first = reader.next();
    await expect(reader.next()).rejects.toMatchObject({ code: "READ_ALREADY_PENDING" });
    wire.push(data(channel(15), 1n, Uint8Array.of(7)));
    await expect(first).resolves.toEqual({ done: false, value: Uint8Array.of(7) });
    tunnel.close();
  });

  it("treats iterator return as local tunnel close and settles a pending read", async () => {
    const wire = new TestWire();
    const tunnel = createReliableRelayByteTunnel({ channelId: channel(16), wire });
    const reader = tunnel.bytes[Symbol.asyncIterator]();
    const pendingRead = reader.next();

    await expect(reader.return?.()).resolves.toEqual({ done: true, value: undefined });
    await expect(pendingRead).resolves.toEqual({ done: true, value: undefined });
    expect(wire.close).toHaveBeenCalledOnce();
    await expect(tunnel.send(new Uint8Array())).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("keeps the routing ID private and returns defensive copies", async () => {
    const original = channel(17);
    const wire = new TestWire();
    wire.onSend = (frame) => wire.push(receipt(frame, 0));
    const tunnel = createReliableRelayByteTunnel({ channelId: original, wire });

    original.fill(0xff);
    const exposed = tunnel.routingChannelId;
    exposed.fill(0xee);
    expect(tunnel.routingChannelId).toEqual(channel(17));

    await tunnel.send(Uint8Array.of(1));
    expect(wire.sent[0]?.channelId).toEqual(channel(17));
    tunnel.close();
  });

  it("bounds aggregate outbound bytes and write count before queueing copies", async () => {
    const byteWire = new TestWire();
    const byteStall = deferred<void>();
    byteWire.onSend = () => byteStall.promise;
    const byteTunnel = createReliableRelayByteTunnel({
      channelId: channel(18),
      wire: byteWire,
      receiptTimeoutMs: 1_000,
      maxBufferedWriteBytes: 2,
      maxBufferedWrites: 3,
    });
    const bytePending = byteTunnel.send(Uint8Array.of(1, 2));
    await vi.waitFor(() => expect(byteWire.sent).toHaveLength(1));
    await expect(byteTunnel.send(Uint8Array.of(3))).rejects.toMatchObject({
      code: "WRITE_BACKPRESSURE",
      details: expect.objectContaining({ maxBufferedBytes: 2 }),
    });
    byteTunnel.close();
    await expect(bytePending).rejects.toMatchObject({ code: "CLOSED" });
    byteStall.resolve();

    const countWire = new TestWire();
    const countStall = deferred<void>();
    countWire.onSend = () => countStall.promise;
    const countTunnel = createReliableRelayByteTunnel({
      channelId: channel(19),
      wire: countWire,
      receiptTimeoutMs: 1_000,
      maxBufferedWriteBytes: 10,
      maxBufferedWrites: 1,
    });
    const countPending = countTunnel.send(Uint8Array.of(1));
    await vi.waitFor(() => expect(countWire.sent).toHaveLength(1));
    await expect(countTunnel.send(Uint8Array.of(2))).rejects.toMatchObject({
      code: "WRITE_BACKPRESSURE",
      details: expect.objectContaining({ maxBufferedWrites: 1 }),
    });
    countTunnel.close();
    await expect(countPending).rejects.toMatchObject({ code: "CLOSED" });
    countStall.resolve();
  });

  it("settles a stalled send on abort and on local close", async () => {
    const abortWire = new TestWire();
    const abortStall = deferred<void>();
    abortWire.onSend = () => abortStall.promise;
    const controller = new AbortController();
    const abortTunnel = createReliableRelayByteTunnel({
      channelId: channel(20),
      wire: abortWire,
      signal: controller.signal,
      receiptTimeoutMs: 1_000,
    });
    const aborted = abortTunnel.send(Uint8Array.of(1));
    await vi.waitFor(() => expect(abortWire.sent).toHaveLength(1));
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "ABORTED" });
    abortStall.resolve();

    const closeWire = new TestWire();
    const closeStall = deferred<void>();
    closeWire.onSend = () => closeStall.promise;
    const closeTunnel = createReliableRelayByteTunnel({
      channelId: channel(21),
      wire: closeWire,
      receiptTimeoutMs: 1_000,
    });
    const closed = closeTunnel.send(Uint8Array.of(1));
    await vi.waitFor(() => expect(closeWire.sent).toHaveLength(1));
    closeTunnel.close();
    await expect(closed).rejects.toMatchObject({ code: "CLOSED" });
    closeStall.resolve();
  });

  it("does not enter the connector after a synchronous terminal close", async () => {
    const wire = new TestWire();
    const tunnel = createReliableRelayByteTunnel({ channelId: channel(30), wire });

    const pending = tunnel.send(Uint8Array.of(1));
    tunnel.close();

    await expect(pending).rejects.toMatchObject({ code: "CLOSED" });
    await flushMicrotasks();
    expect(wire.sent).toEqual([]);
  });

  it("settles a stalled send on peer close and wire iterator failure", async () => {
    const peerWire = new TestWire();
    const peerStall = deferred<void>();
    peerWire.onSend = () => peerStall.promise;
    const peerTunnel = createReliableRelayByteTunnel({
      channelId: channel(22),
      wire: peerWire,
      receiptTimeoutMs: 1_000,
    });
    const peerSend = peerTunnel.send(Uint8Array.of(1));
    await vi.waitFor(() => expect(peerWire.sent).toHaveLength(1));
    peerWire.push({ kind: "peer_close", channelId: channel(22), messageId: 0n, payload: new Uint8Array() });
    await expect(peerSend).rejects.toMatchObject({ code: "PEER_CLOSED" });
    peerStall.resolve();

    const failedWire = new TestWire();
    const failedStall = deferred<void>();
    failedWire.onSend = () => failedStall.promise;
    const failedTunnel = createReliableRelayByteTunnel({
      channelId: channel(23),
      wire: failedWire,
      receiptTimeoutMs: 1_000,
    });
    const failedSend = failedTunnel.send(Uint8Array.of(1));
    await vi.waitFor(() => expect(failedWire.sent).toHaveLength(1));
    failedWire.fail(new Error("iterator failed"));
    await expect(failedSend).rejects.toMatchObject({ code: "WIRE_FAILED" });
    failedStall.resolve();
  });

  it("turns connector send rejection into a terminal typed error", async () => {
    const wire = new TestWire();
    wire.onSend = async () => {
      throw new Error("socket write failed");
    };
    const tunnel = createReliableRelayByteTunnel({ channelId: channel(24), wire });

    await expect(tunnel.send(Uint8Array.of(1))).rejects.toMatchObject({ code: "SEND_FAILED" });
    expect(wire.close).toHaveBeenCalledOnce();
    expect(wire.sent).toHaveLength(1);
  });

  it("rejects stale, malformed, and duplicate receipts", async () => {
    const staleWire = new TestWire();
    const staleTunnel = createReliableRelayByteTunnel({ channelId: channel(25), wire: staleWire });
    const staleSend = staleTunnel.send(Uint8Array.of(1));
    await vi.waitFor(() => expect(staleWire.sent).toHaveLength(1));
    staleWire.push({
      kind: "forward_result",
      channelId: channel(25),
      messageId: 0n,
      payload: Uint8Array.of(0),
    });
    await expect(staleSend).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE" });

    const malformedWire = new TestWire();
    const malformedTunnel = createReliableRelayByteTunnel({ channelId: channel(26), wire: malformedWire });
    const malformedSend = malformedTunnel.send(Uint8Array.of(1));
    await vi.waitFor(() => expect(malformedWire.sent).toHaveLength(1));
    malformedWire.push({
      kind: "forward_result",
      channelId: channel(26),
      messageId: 1n,
      payload: Uint8Array.of(0, 0),
    });
    await expect(malformedSend).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE" });

    const duplicateWire = new TestWire();
    duplicateWire.onSend = (frame) => duplicateWire.push(receipt(frame, 0));
    const duplicateTunnel = createReliableRelayByteTunnel({ channelId: channel(27), wire: duplicateWire });
    await duplicateTunnel.send(Uint8Array.of(1));
    const failure = duplicateTunnel.bytes[Symbol.asyncIterator]().next();
    duplicateWire.push(receipt(duplicateWire.sent[0] as RelayRoutingFrame, 0));
    await expect(failure).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE" });
  });

  it("consumes async connector close and frame-iterator return rejections", async () => {
    const wire = new TestWire();
    wire.close.mockImplementation(async () => {
      throw new Error("async close failed");
    });
    wire.queue.returnError = new Error("async iterator return failed");
    const tunnel = createReliableRelayByteTunnel({ channelId: channel(28), wire });
    const read = tunnel.bytes[Symbol.asyncIterator]().next();

    wire.push(data(channel(29), 1n, Uint8Array.of(1)));

    await expect(read).rejects.toMatchObject({ code: "WRONG_ROUTING_CHANNEL" });
    await flushMicrotasks();
    expect(wire.close).toHaveBeenCalledOnce();
    expect(wire.queue.return).toHaveBeenCalledOnce();
  });

  it("turns channel EOF into a terminal TLS-session failure", async () => {
    const wire = new TestWire();
    const tunnel = createReliableRelayByteTunnel({ channelId: channel(10), wire });
    const read = tunnel.bytes[Symbol.asyncIterator]().next();

    wire.end();

    await expect(read).rejects.toMatchObject({ code: "WIRE_ENDED" });
    expect(wire.close).toHaveBeenCalledOnce();
  });
});

class TestWire implements OpenRelayRoutingChannel {
  readonly queue = new FrameQueue();
  readonly frames = this.queue;
  readonly sent: RelayRoutingFrame[] = [];
  readonly close = vi.fn((_reason?: string) => this.queue.end());
  onSend?: (frame: RelayRoutingFrame) => void | Promise<void>;

  async send(frame: RelayRoutingFrame): Promise<void> {
    const retained = cloneFrame(frame);
    this.sent.push(retained);
    await this.onSend?.(retained);
  }

  push(frame: RelayRoutingFrame): void {
    this.queue.push(cloneFrame(frame));
  }

  end(): void {
    this.queue.end();
  }

  fail(error: unknown): void {
    this.queue.fail(error);
  }
}

class FrameQueue implements AsyncIterable<RelayRoutingFrame>, AsyncIterator<RelayRoutingFrame> {
  readonly #items: RelayRoutingFrame[] = [];
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<RelayRoutingFrame>) => void;
    reject: (error: unknown) => void;
  }> = [];
  returnError?: Error;
  #ended = false;
  #error?: unknown;

  [Symbol.asyncIterator](): AsyncIterator<RelayRoutingFrame> {
    return this;
  }

  next(): Promise<IteratorResult<RelayRoutingFrame>> {
    if (this.#error) return Promise.reject(this.#error);
    const frame = this.#items.shift();
    if (frame) return Promise.resolve({ done: false, value: frame });
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  push(frame: RelayRoutingFrame): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: frame });
    else this.#items.push(frame);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.#ended || this.#error) return;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  readonly return = vi.fn(async (): Promise<IteratorResult<RelayRoutingFrame>> => {
    this.end();
    if (this.returnError) throw this.returnError;
    return { done: true, value: undefined };
  });
}

function channel(fill: number): Uint8Array {
  return new Uint8Array(16).fill(fill);
}

function data(channelId: Uint8Array, messageId: bigint, payload: Uint8Array): RelayRoutingFrame {
  return { kind: "data", channelId, messageId, payload };
}

function receipt(frame: RelayRoutingFrame, status: number): RelayRoutingFrame {
  return {
    kind: "forward_result",
    channelId: frame.channelId,
    messageId: frame.messageId,
    payload: Uint8Array.of(status),
  };
}

function cloneFrame(frame: RelayRoutingFrame): RelayRoutingFrame {
  return {
    ...frame,
    channelId: new Uint8Array(frame.channelId),
    payload: new Uint8Array(frame.payload),
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
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
