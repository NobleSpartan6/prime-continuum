import {
  MAX_RELAY_ROUTING_MESSAGE_ID,
  MAX_RELAY_ROUTING_PAYLOAD_BYTES,
  RELAY_ROUTING_CHANNEL_ID_BYTES,
  type RelayRoutingFrame,
} from "./relay-routing";

export const RELIABLE_RELAY_BYTE_TUNNEL_VERSION = 1 as const;
export const MAX_RELIABLE_TUNNEL_WRITE_BYTES = 8 * 1024 * 1024;
export const MAX_RELIABLE_TUNNEL_BUFFERED_READ_BYTES = 2 * 1024 * 1024;
export const DEFAULT_RELIABLE_TUNNEL_MAX_BUFFERED_READ_ITEMS = 4_096;
export const DEFAULT_RELIABLE_TUNNEL_MAX_BUFFERED_WRITE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_RELIABLE_TUNNEL_MAX_BUFFERED_WRITES = 64;
export const DEFAULT_RELAY_RECEIPT_TIMEOUT_MS = 15_000;

export type ReliableRelayByteTunnelErrorCode =
  | "ABORTED"
  | "CLOSED"
  | "EMPTY_DATA"
  | "FORWARD_REJECTED"
  | "INCOMING_SEQUENCE"
  | "MESSAGE_ID_EXHAUSTED"
  | "MULTIPLE_READERS"
  | "PEER_CLOSED"
  | "READ_ALREADY_PENDING"
  | "READ_BACKPRESSURE"
  | "RECEIPT_SEQUENCE"
  | "RECEIPT_TIMEOUT"
  | "SEND_FAILED"
  | "UNEXPECTED_CONTROL"
  | "WIRE_ENDED"
  | "WIRE_FAILED"
  | "WRONG_ROUTING_CHANNEL"
  | "WRITE_BACKPRESSURE"
  | "WRITE_TOO_LARGE";

export class ReliableRelayByteTunnelError extends Error {
  readonly code: ReliableRelayByteTunnelErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: ReliableRelayByteTunnelErrorCode,
    message: string,
    options: {
      cause?: unknown;
      details?: Readonly<Record<string, string | number | boolean>>;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ReliableRelayByteTunnelError";
    this.code = code;
    this.details = options.details;
  }
}

/**
 * A connector-owned, already-open relay channel. `frames` must be exclusively
 * owned by this adapter and already demultiplexed to this routing channel; the
 * adapter still validates every frame's channel ID as a fail-closed defense.
 * The iterator's optional `return()` and `close()` must be safe to call during
 * a pending `next()`. Its routing channel ID is relay-visible metadata and must
 * never be used as an authenticated secure-channel ID or peer principal.
 */
export interface OpenRelayRoutingChannel {
  readonly frames: AsyncIterable<RelayRoutingFrame>;
  send(frame: RelayRoutingFrame): Promise<void>;
  close(reason?: string): void | Promise<void>;
}

export interface ReliableRelayByteTunnel {
  readonly version: typeof RELIABLE_RELAY_BYTE_TUNNEL_VERSION;
  readonly routingChannelId: Uint8Array;
  readonly bytes: AsyncIterable<Uint8Array>;
  send(bytes: Uint8Array): Promise<void>;
  close(reason?: string): void;
}

export interface ReliableRelayByteTunnelOptions {
  readonly channelId: Uint8Array;
  readonly wire: OpenRelayRoutingChannel;
  readonly signal?: AbortSignal;
  readonly receiptTimeoutMs?: number;
  readonly maxBufferedReadBytes?: number;
  readonly maxBufferedReadItems?: number;
  readonly maxBufferedWriteBytes?: number;
  readonly maxBufferedWrites?: number;
}

interface PendingReceipt {
  readonly messageId: bigint;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: ReliableRelayByteTunnelError) => void;
  received: boolean;
  sendSettled: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Adapts acknowledged relay routing frames into the reliable, in-order byte
 * stream required by a future TLS implementation. There is deliberately no
 * retry path: any uncertain send, rejection, missing receipt, gap, duplicate,
 * disconnect, or malformed control frame terminates this tunnel. Reconnects
 * must construct a new routing channel and a new TLS session.
 */
export function createReliableRelayByteTunnel(
  options: ReliableRelayByteTunnelOptions,
): ReliableRelayByteTunnel {
  return new ReliableRelayByteTunnelImpl(options);
}

class ReliableRelayByteTunnelImpl implements ReliableRelayByteTunnel {
  readonly version = RELIABLE_RELAY_BYTE_TUNNEL_VERSION;
  readonly bytes: AsyncIterable<Uint8Array>;

  readonly #routingChannelId: Uint8Array;
  readonly #wire: OpenRelayRoutingChannel;
  readonly #readQueue: BoundedAsyncByteQueue;
  readonly #receiptTimeoutMs: number;
  readonly #maxBufferedWriteBytes: number;
  readonly #maxBufferedWrites: number;
  readonly #signal?: AbortSignal;
  #nextOutgoingMessageId = 1n;
  #nextIncomingMessageId = 1n;
  #pendingReceipt?: PendingReceipt;
  #sendTail: Promise<void> = Promise.resolve();
  #bufferedWriteBytes = 0;
  #bufferedWrites = 0;
  #frameIterator?: AsyncIterator<RelayRoutingFrame>;
  #frameIteratorReturnRequested = false;
  #failure?: ReliableRelayByteTunnelError;
  #closed = false;

  constructor(options: ReliableRelayByteTunnelOptions) {
    if (!(options.channelId instanceof Uint8Array) || options.channelId.byteLength !== RELAY_ROUTING_CHANNEL_ID_BYTES) {
      throw new TypeError(`Relay routing channel IDs must contain exactly ${RELAY_ROUTING_CHANNEL_ID_BYTES} bytes`);
    }
    const receiptTimeoutMs = options.receiptTimeoutMs ?? DEFAULT_RELAY_RECEIPT_TIMEOUT_MS;
    const maxBufferedReadBytes = options.maxBufferedReadBytes ?? MAX_RELIABLE_TUNNEL_BUFFERED_READ_BYTES;
    const maxBufferedReadItems =
      options.maxBufferedReadItems ?? DEFAULT_RELIABLE_TUNNEL_MAX_BUFFERED_READ_ITEMS;
    const maxBufferedWriteBytes =
      options.maxBufferedWriteBytes ?? DEFAULT_RELIABLE_TUNNEL_MAX_BUFFERED_WRITE_BYTES;
    const maxBufferedWrites = options.maxBufferedWrites ?? DEFAULT_RELIABLE_TUNNEL_MAX_BUFFERED_WRITES;
    if (!Number.isSafeInteger(receiptTimeoutMs) || receiptTimeoutMs < 1 || receiptTimeoutMs > 120_000) {
      throw new RangeError("Relay receipt timeout must be between 1 and 120000 milliseconds");
    }
    if (!Number.isSafeInteger(maxBufferedReadBytes) || maxBufferedReadBytes < 1 || maxBufferedReadBytes > 64 * 1024 * 1024) {
      throw new RangeError("Relay read buffer limit must be between 1 byte and 64 MiB");
    }
    if (!Number.isSafeInteger(maxBufferedReadItems) || maxBufferedReadItems < 1 || maxBufferedReadItems > 65_536) {
      throw new RangeError("Relay read item limit must be between 1 and 65536 items");
    }
    if (!Number.isSafeInteger(maxBufferedWriteBytes) || maxBufferedWriteBytes < 1 || maxBufferedWriteBytes > 64 * 1024 * 1024) {
      throw new RangeError("Relay write buffer limit must be between 1 byte and 64 MiB");
    }
    if (!Number.isSafeInteger(maxBufferedWrites) || maxBufferedWrites < 1 || maxBufferedWrites > 4_096) {
      throw new RangeError("Relay queued write limit must be between 1 and 4096 writes");
    }

    this.#routingChannelId = copyBytes(options.channelId);
    this.#wire = options.wire;
    this.#receiptTimeoutMs = receiptTimeoutMs;
    this.#maxBufferedWriteBytes = maxBufferedWriteBytes;
    this.#maxBufferedWrites = maxBufferedWrites;
    this.#readQueue = new BoundedAsyncByteQueue(maxBufferedReadBytes, maxBufferedReadItems, () => {
      this.close("byte reader closed");
    });
    this.bytes = this.#readQueue;
    this.#signal = options.signal;
    if (this.#signal?.aborted) {
      this.#fail(new ReliableRelayByteTunnelError("ABORTED", "The relay byte tunnel was aborted before opening."));
      return;
    }
    this.#signal?.addEventListener("abort", this.#onAbort, { once: true });
    void this.#pump();
  }

  get routingChannelId(): Uint8Array {
    return copyBytes(this.#routingChannelId);
  }

  send(bytes: Uint8Array): Promise<void> {
    if (!(bytes instanceof Uint8Array)) {
      return Promise.reject(new TypeError("Reliable relay writes must be byte arrays"));
    }
    if (bytes.byteLength > MAX_RELIABLE_TUNNEL_WRITE_BYTES) {
      return Promise.reject(
        new ReliableRelayByteTunnelError("WRITE_TOO_LARGE", "A single relay byte-stream write exceeds its safe bound.", {
          details: { bytes: bytes.byteLength, maxBytes: MAX_RELIABLE_TUNNEL_WRITE_BYTES },
        }),
      );
    }
    try {
      this.#assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    if (bytes.byteLength === 0) return Promise.resolve();
    if (
      this.#bufferedWrites >= this.#maxBufferedWrites ||
      this.#bufferedWriteBytes + bytes.byteLength > this.#maxBufferedWriteBytes
    ) {
      return Promise.reject(
        new ReliableRelayByteTunnelError(
          "WRITE_BACKPRESSURE",
          "The relay byte producer exceeded its bounded outbound write queue.",
          {
            details: {
              bufferedBytes: this.#bufferedWriteBytes,
              bufferedWrites: this.#bufferedWrites,
              requestedBytes: bytes.byteLength,
              maxBufferedBytes: this.#maxBufferedWriteBytes,
              maxBufferedWrites: this.#maxBufferedWrites,
            },
          },
        ),
      );
    }
    const retained = copyBytes(bytes);
    this.#bufferedWriteBytes += retained.byteLength;
    this.#bufferedWrites += 1;
    const operation = this.#sendTail.then(async () => {
      this.#assertOpen();
      for (let offset = 0; offset < retained.byteLength; offset += MAX_RELAY_ROUTING_PAYLOAD_BYTES) {
        await this.#sendChunk(retained.subarray(offset, Math.min(retained.byteLength, offset + MAX_RELAY_ROUTING_PAYLOAD_BYTES)));
      }
    });
    this.#sendTail = operation.catch(() => undefined);
    return operation.finally(() => {
      this.#bufferedWriteBytes -= retained.byteLength;
      this.#bufferedWrites -= 1;
    });
  }

  close(reason = "local close"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#signal?.removeEventListener("abort", this.#onAbort);
    const error = new ReliableRelayByteTunnelError("CLOSED", "The relay byte tunnel was closed locally.");
    this.#rejectPending(error);
    this.#readQueue.end();
    this.#requestWireClose(reason);
    this.#cancelFrameIterator();
  }

  async #sendChunk(chunk: Uint8Array): Promise<void> {
    this.#assertOpen();
    if (this.#nextOutgoingMessageId > MAX_RELAY_ROUTING_MESSAGE_ID) {
      throw this.#fail(
        new ReliableRelayByteTunnelError("MESSAGE_ID_EXHAUSTED", "The relay routing message ID space is exhausted."),
      );
    }
    const messageId = this.#nextOutgoingMessageId;
    this.#nextOutgoingMessageId += 1n;
    const receipt = this.#createReceipt(messageId);
    this.#pendingReceipt = receipt;
    const sendPromise = Promise.resolve().then(() => {
      // close()/abort may run synchronously after send() queues this operation
      // but before the connector microtask begins. Never put bytes on a route
      // after that terminal boundary.
      if (receipt.settled || this.#pendingReceipt !== receipt || this.#closed) return;
      return this.#wire.send({
        kind: "data",
        channelId: copyBytes(this.#routingChannelId),
        messageId,
        payload: copyBytes(chunk),
      });
    });
    void sendPromise.then(
      () => {
        receipt.sendSettled = true;
        this.#resolvePendingIfComplete(receipt);
      },
      (cause: unknown) => {
        if (receipt.settled) return;
        this.#fail(
          new ReliableRelayByteTunnelError("SEND_FAILED", "The relay connector could not accept an outgoing byte frame.", {
            cause,
            details: { messageId: messageId.toString() },
          }),
        );
      },
    );

    try {
      await receipt.promise;
    } finally {
      clearTimeout(receipt.timer);
      if (this.#pendingReceipt === receipt) this.#pendingReceipt = undefined;
    }
  }

  #createReceipt(messageId: bigint): PendingReceipt {
    let resolve!: () => void;
    let reject!: (error: ReliableRelayByteTunnelError) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const receipt = {
      messageId,
      promise,
      resolve,
      reject,
      received: false,
      sendSettled: false,
      settled: false,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    receipt.timer = setTimeout(() => {
      this.#fail(
        new ReliableRelayByteTunnelError("RECEIPT_TIMEOUT", "The relay did not confirm socket acceptance in time.", {
          details: { messageId: messageId.toString(), timeoutMs: this.#receiptTimeoutMs },
        }),
      );
    }, this.#receiptTimeoutMs);
    return receipt;
  }

  async #pump(): Promise<void> {
    try {
      const iterator = this.#wire.frames[Symbol.asyncIterator]();
      this.#frameIterator = iterator;
      this.#frameIteratorReturnRequested = false;
      if (this.#closed) {
        this.#cancelFrameIterator();
        return;
      }
      while (!this.#closed) {
        const result = await iterator.next();
        if (this.#closed) return;
        if (result.done) {
          this.#fail(
            new ReliableRelayByteTunnelError(
              "WIRE_ENDED",
              "The relay channel ended without a terminal control frame.",
            ),
          );
          return;
        }
        this.#handleFrame(result.value);
      }
    } catch (cause) {
      if (!this.#closed) {
        this.#fail(new ReliableRelayByteTunnelError("WIRE_FAILED", "The relay channel failed.", { cause }));
      }
    } finally {
      this.#frameIterator = undefined;
    }
  }

  #handleFrame(frame: RelayRoutingFrame): void {
    if (!equalBytes(frame.channelId, this.#routingChannelId)) {
      throw this.#fail(
        new ReliableRelayByteTunnelError("WRONG_ROUTING_CHANNEL", "The relay delivered a frame for another routing channel."),
      );
    }
    if (frame.kind === "data") {
      if (frame.payload.byteLength === 0) {
        throw this.#fail(
          new ReliableRelayByteTunnelError("EMPTY_DATA", "Relay byte frames must contain at least one byte."),
        );
      }
      if (frame.messageId !== this.#nextIncomingMessageId) {
        throw this.#fail(
          new ReliableRelayByteTunnelError("INCOMING_SEQUENCE", "Relay byte frames contain a gap, duplicate, or reorder.", {
            details: {
              expectedMessageId: this.#nextIncomingMessageId.toString(),
              receivedMessageId: frame.messageId.toString(),
            },
          }),
        );
      }
      const payload = copyBytes(frame.payload);
      if (!this.#readQueue.push(payload)) {
        throw this.#fail(
          new ReliableRelayByteTunnelError("READ_BACKPRESSURE", "The relay byte consumer exceeded its bounded read queue."),
        );
      }
      this.#nextIncomingMessageId += 1n;
      return;
    }
    if (frame.kind === "forward_result") {
      const receipt = this.#pendingReceipt;
      if (!receipt || receipt.messageId !== frame.messageId || receipt.received || frame.payload.byteLength !== 1) {
        throw this.#fail(
          new ReliableRelayByteTunnelError("RECEIPT_SEQUENCE", "The relay sent a missing, duplicate, malformed, or out-of-order receipt."),
        );
      }
      receipt.received = true;
      const status = frame.payload[0];
      if (status !== 0) {
        throw this.#fail(
          new ReliableRelayByteTunnelError("FORWARD_REJECTED", "The relay could not accept the byte frame for the peer socket.", {
            details: { messageId: frame.messageId.toString(), status: status ?? -1 },
          }),
        );
      }
      this.#resolvePendingIfComplete(receipt);
      return;
    }
    if (frame.kind === "peer_close") {
      if (frame.messageId !== 0n || frame.payload.byteLength !== 0) {
        throw this.#fail(
          new ReliableRelayByteTunnelError("UNEXPECTED_CONTROL", "The relay sent a malformed peer-close frame."),
        );
      }
      throw this.#fail(new ReliableRelayByteTunnelError("PEER_CLOSED", "The relay peer disconnected."));
    }
    throw this.#fail(
      new ReliableRelayByteTunnelError("UNEXPECTED_CONTROL", "The open relay channel received an unexpected control frame."),
    );
  }

  #assertOpen(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw new ReliableRelayByteTunnelError("CLOSED", "The relay byte tunnel is closed.");
  }

  #fail(error: ReliableRelayByteTunnelError): ReliableRelayByteTunnelError {
    if (this.#failure) return this.#failure;
    this.#failure = error;
    this.#closed = true;
    this.#signal?.removeEventListener("abort", this.#onAbort);
    this.#rejectPending(error);
    this.#readQueue.fail(error);
    this.#requestWireClose(error.code);
    this.#cancelFrameIterator();
    return error;
  }

  #resolvePendingIfComplete(receipt: PendingReceipt): void {
    if (receipt.settled || !receipt.received || !receipt.sendSettled) return;
    receipt.settled = true;
    clearTimeout(receipt.timer);
    if (this.#pendingReceipt === receipt) this.#pendingReceipt = undefined;
    receipt.resolve();
  }

  #rejectPending(error: ReliableRelayByteTunnelError): void {
    const receipt = this.#pendingReceipt;
    if (!receipt) return;
    clearTimeout(receipt.timer);
    this.#pendingReceipt = undefined;
    receipt.settled = true;
    receipt.reject(error);
  }

  #requestWireClose(reason: string): void {
    try {
      const completion = this.#wire.close(reason.slice(0, 123));
      if (completion !== undefined) void Promise.resolve(completion).catch(() => undefined);
    } catch {
      // Tunnel termination remains authoritative if connector teardown fails.
    }
  }

  #cancelFrameIterator(): void {
    const iterator = this.#frameIterator;
    if (!iterator?.return || this.#frameIteratorReturnRequested) return;
    this.#frameIteratorReturnRequested = true;
    try {
      void Promise.resolve(iterator.return()).catch(() => undefined);
    } catch {
      // A failing iterator return cannot make a terminal tunnel live again.
    }
  }

  readonly #onAbort = (): void => {
    this.#fail(new ReliableRelayByteTunnelError("ABORTED", "The relay byte tunnel was aborted."));
  };
}

class BoundedAsyncByteQueue implements AsyncIterable<Uint8Array> {
  readonly #maxBytes: number;
  readonly #maxItems: number;
  readonly #onReaderReturn: () => void;
  readonly #items: Uint8Array[] = [];
  #waiter?: {
    resolve: (result: IteratorResult<Uint8Array>) => void;
    reject: (error: unknown) => void;
  };
  #bufferedBytes = 0;
  #readerClaimed = false;
  #readerReturned = false;
  #ended = false;
  #error?: unknown;

  constructor(maxBytes: number, maxItems: number, onReaderReturn: () => void) {
    this.#maxBytes = maxBytes;
    this.#maxItems = maxItems;
    this.#onReaderReturn = onReaderReturn;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    if (this.#readerClaimed) {
      throw new ReliableRelayByteTunnelError(
        "MULTIPLE_READERS",
        "Reliable relay bytes permit exactly one iterator reader.",
      );
    }
    this.#readerClaimed = true;
    const queue = this;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        return queue.#next();
      },
      return() {
        return queue.#returnReader();
      },
    };
  }

  #next(): Promise<IteratorResult<Uint8Array>> {
    if (this.#error) return Promise.reject(this.#error);
    if (this.#readerReturned || this.#ended) return Promise.resolve({ done: true, value: undefined });
    if (this.#waiter) {
      return Promise.reject(
        new ReliableRelayByteTunnelError(
          "READ_ALREADY_PENDING",
          "Reliable relay bytes permit only one outstanding iterator next() call.",
        ),
      );
    }
    const item = this.#items.shift();
    if (item) {
      this.#bufferedBytes -= item.byteLength;
      return Promise.resolve({ done: false, value: item });
    }
    return new Promise((resolve, reject) => {
      this.#waiter = {
        resolve: (result) => {
          this.#waiter = undefined;
          resolve(result);
        },
        reject: (error) => {
          this.#waiter = undefined;
          reject(error);
        },
      };
    });
  }

  push(bytes: Uint8Array): boolean {
    if (this.#ended || this.#error || bytes.byteLength === 0) return false;
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter.resolve({ done: false, value: bytes });
      return true;
    }
    if (
      this.#items.length >= this.#maxItems ||
      this.#bufferedBytes + bytes.byteLength > this.#maxBytes
    ) {
      return false;
    }
    this.#items.push(bytes);
    this.#bufferedBytes += bytes.byteLength;
    return true;
  }

  #returnReader(): Promise<IteratorResult<Uint8Array>> {
    if (!this.#readerReturned) {
      this.#readerReturned = true;
      this.end();
      this.#onReaderReturn();
    }
    return Promise.resolve({ done: true, value: undefined });
  }

  end(): void {
    if (this.#ended || this.#error) return;
    this.#ended = true;
    this.#items.length = 0;
    this.#bufferedBytes = 0;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.#ended || this.#error) return;
    this.#error = error;
    this.#items.length = 0;
    this.#bufferedBytes = 0;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.reject(error);
  }
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
