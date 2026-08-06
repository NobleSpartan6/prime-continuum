import { describe, expect, it } from "vitest";
import {
  decodeRelayRoutingFrame,
  encodeRelayRoutingFrame,
  MAX_RELAY_ROUTING_FRAME_BYTES,
  MAX_RELAY_ROUTING_MESSAGE_ID,
  MAX_RELAY_ROUTING_PAYLOAD_BYTES,
  RELAY_ROUTING_HEADER_BYTES,
  RELAY_ROUTING_KINDS,
  RelayRoutingCodecError,
  type RelayRoutingCodecErrorCode,
  type RelayRoutingFrame,
} from "../../src/shared/relay-routing";

const KIND_OFFSET = 4;
const FLAGS_OFFSET = 5;
const PAYLOAD_LENGTH_OFFSET = 30;

describe("relay routing codec", () => {
  it.each(RELAY_ROUTING_KINDS)("round-trips the %s frame kind", (kind) => {
    const frame: RelayRoutingFrame = {
      kind,
      channelId: bytes(16, 0x20),
      messageId: 42n,
      payload: new Uint8Array([0, 1, 2, 127, 128, 255]),
    };

    expect(decodeRelayRoutingFrame(encodeRelayRoutingFrame(frame))).toEqual(frame);
  });

  it("supports empty and maximum-size opaque payloads", () => {
    const empty = baseFrame({ payload: new Uint8Array(0) });
    expect(encodeRelayRoutingFrame(empty)).toHaveLength(RELAY_ROUTING_HEADER_BYTES);
    expect(decodeRelayRoutingFrame(encodeRelayRoutingFrame(empty))).toEqual(empty);

    const maximum = baseFrame({
      messageId: MAX_RELAY_ROUTING_MESSAGE_ID,
      payload: bytes(MAX_RELAY_ROUTING_PAYLOAD_BYTES, 0x5a),
    });
    const encoded = encodeRelayRoutingFrame(maximum);
    expect(encoded).toHaveLength(MAX_RELAY_ROUTING_FRAME_BYTES);
    expect(decodeRelayRoutingFrame(encoded)).toEqual(maximum);
  });

  it("rejects a truncated header and a truncated payload", () => {
    expectCodecError(() => decodeRelayRoutingFrame(new Uint8Array(RELAY_ROUTING_HEADER_BYTES - 1)), "TRUNCATED_FRAME");

    const encoded = encodeRelayRoutingFrame(baseFrame({ payload: new Uint8Array([1, 2, 3]) }));
    expectCodecError(() => decodeRelayRoutingFrame(encoded.subarray(0, encoded.byteLength - 1)), "LENGTH_MISMATCH");
  });

  it("rejects bad magic", () => {
    const encoded = encodeRelayRoutingFrame(baseFrame());
    encoded[0] = (encoded[0] ?? 0) ^ 0xff;
    expectCodecError(() => decodeRelayRoutingFrame(encoded), "BAD_MAGIC");
  });

  it("rejects unknown frame kinds", () => {
    const encoded = encodeRelayRoutingFrame(baseFrame());
    encoded[KIND_OFFSET] = 0xff;
    expectCodecError(() => decodeRelayRoutingFrame(encoded), "UNKNOWN_KIND");
    expectCodecError(
      () => encodeRelayRoutingFrame({ ...baseFrame(), kind: "unknown" as RelayRoutingFrame["kind"] }),
      "UNKNOWN_KIND",
    );
  });

  it("rejects every nonzero flags value", () => {
    for (const flag of [1, 2, 0x80, 0xff]) {
      const encoded = encodeRelayRoutingFrame(baseFrame());
      encoded[FLAGS_OFFSET] = flag;
      expectCodecError(() => decodeRelayRoutingFrame(encoded), "UNSUPPORTED_FLAGS");
    }
  });

  it("rejects oversized encoded and decoded frames", () => {
    expectCodecError(
      () => encodeRelayRoutingFrame(baseFrame({ payload: new Uint8Array(MAX_RELAY_ROUTING_PAYLOAD_BYTES + 1) })),
      "FRAME_TOO_LARGE",
    );
    expectCodecError(
      () => decodeRelayRoutingFrame(new Uint8Array(MAX_RELAY_ROUTING_FRAME_BYTES + 1)),
      "FRAME_TOO_LARGE",
    );

    const declaredOversized = encodeRelayRoutingFrame(baseFrame());
    new DataView(declaredOversized.buffer).setUint32(
      PAYLOAD_LENGTH_OFFSET,
      MAX_RELAY_ROUTING_PAYLOAD_BYTES + 1,
      false,
    );
    expectCodecError(() => decodeRelayRoutingFrame(declaredOversized), "FRAME_TOO_LARGE");
  });

  it("rejects declared payload lengths that do not exactly match the message", () => {
    const tooSmall = encodeRelayRoutingFrame(baseFrame({ payload: new Uint8Array([1, 2, 3]) }));
    new DataView(tooSmall.buffer).setUint32(PAYLOAD_LENGTH_OFFSET, 2, false);
    expectCodecError(() => decodeRelayRoutingFrame(tooSmall), "LENGTH_MISMATCH");

    const tooLarge = encodeRelayRoutingFrame(baseFrame({ payload: new Uint8Array([1, 2, 3]) }));
    new DataView(tooLarge.buffer).setUint32(PAYLOAD_LENGTH_OFFSET, 4, false);
    expectCodecError(() => decodeRelayRoutingFrame(tooLarge), "LENGTH_MISMATCH");
  });

  it("enforces exact channel ID width", () => {
    for (const channelId of [new Uint8Array(0), new Uint8Array(15), new Uint8Array(17)]) {
      expectCodecError(() => encodeRelayRoutingFrame(baseFrame({ channelId })), "INVALID_CHANNEL_ID");
    }
  });

  it("accepts only unsigned 64-bit bigint message identifiers", () => {
    expect(decodeRelayRoutingFrame(encodeRelayRoutingFrame(baseFrame({ messageId: 0n }))).messageId).toBe(0n);
    expect(
      decodeRelayRoutingFrame(encodeRelayRoutingFrame(baseFrame({ messageId: MAX_RELAY_ROUTING_MESSAGE_ID }))).messageId,
    ).toBe(MAX_RELAY_ROUTING_MESSAGE_ID);

    for (const messageId of [-1n, MAX_RELAY_ROUTING_MESSAGE_ID + 1n]) {
      expectCodecError(() => encodeRelayRoutingFrame(baseFrame({ messageId })), "INVALID_MESSAGE_ID");
    }
    expectCodecError(
      () => encodeRelayRoutingFrame(baseFrame({ messageId: 1 as unknown as bigint })),
      "INVALID_MESSAGE_ID",
    );
  });

  it("does not mutate or retain aliases to caller-owned input", () => {
    const channelId = bytes(16, 0x10);
    const payload = bytes(32, 0x40);
    const channelBefore = new Uint8Array(channelId);
    const payloadBefore = new Uint8Array(payload);
    const encoded = encodeRelayRoutingFrame(baseFrame({ channelId, payload }));

    expect(channelId).toEqual(channelBefore);
    expect(payload).toEqual(payloadBefore);
    channelId.fill(0xff);
    payload.fill(0xff);

    const decoded = decodeRelayRoutingFrame(encoded);
    expect(decoded.channelId).toEqual(channelBefore);
    expect(decoded.payload).toEqual(payloadBefore);

    const wireBefore = new Uint8Array(encoded);
    encoded.fill(0, 6, 22);
    encoded.fill(0, RELAY_ROUTING_HEADER_BYTES);
    expect(decoded.channelId).toEqual(channelBefore);
    expect(decoded.payload).toEqual(payloadBefore);

    decoded.channelId.fill(0xaa);
    decoded.payload.fill(0xbb);
    expect(wireBefore.subarray(6, 22)).toEqual(channelBefore);
    expect(wireBefore.subarray(RELAY_ROUTING_HEADER_BYTES)).toEqual(payloadBefore);
  });

  it("handles views with nonzero byte offsets without reading adjacent bytes", () => {
    const encoded = encodeRelayRoutingFrame(baseFrame({ messageId: 99n, payload: new Uint8Array([7, 8, 9]) }));
    const surrounding = new Uint8Array(encoded.byteLength + 20);
    surrounding.fill(0xee);
    surrounding.set(encoded, 10);
    const view = surrounding.subarray(10, 10 + encoded.byteLength);

    expect(decodeRelayRoutingFrame(view)).toEqual(baseFrame({ messageId: 99n, payload: new Uint8Array([7, 8, 9]) }));
  });
});

function baseFrame(overrides: Partial<RelayRoutingFrame> = {}): RelayRoutingFrame {
  return {
    kind: "data",
    channelId: bytes(16, 0x20),
    messageId: 1n,
    payload: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

function bytes(length: number, start: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

function expectCodecError(operation: () => unknown, code: RelayRoutingCodecErrorCode): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayRoutingCodecError);
    expect((error as RelayRoutingCodecError).code).toBe(code);
    return;
  }
  throw new Error(`Expected relay routing codec error ${code}`);
}
