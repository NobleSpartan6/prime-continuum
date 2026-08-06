/**
 * Relay-visible routing frames.
 *
 * This codec deliberately knows nothing about application requests, execution
 * hosts, or device identities. A relay may inspect only bounded routing
 * metadata and an opaque payload supplied by a higher-level secure channel.
 */

export const RELAY_ROUTING_MAGIC = "PRR1" as const;
export const RELAY_ROUTING_CHANNEL_ID_BYTES = 16;
export const RELAY_ROUTING_HEADER_BYTES = 34;
export const MAX_RELAY_ROUTING_FRAME_BYTES = 68 * 1024;
export const MAX_RELAY_ROUTING_PAYLOAD_BYTES =
  MAX_RELAY_ROUTING_FRAME_BYTES - RELAY_ROUTING_HEADER_BYTES;
export const MAX_RELAY_ROUTING_MESSAGE_ID = 0xffff_ffff_ffff_ffffn;

export const RELAY_ROUTING_KINDS = [
  "ready",
  "peer_open",
  "data",
  "forward_result",
  "peer_close",
] as const;
export type RelayRoutingKind = (typeof RELAY_ROUTING_KINDS)[number];

export interface RelayRoutingFrame {
  kind: RelayRoutingKind;
  channelId: Uint8Array;
  messageId: bigint;
  payload: Uint8Array;
}

export type RelayRoutingCodecErrorCode =
  | "INVALID_INPUT"
  | "TRUNCATED_FRAME"
  | "FRAME_TOO_LARGE"
  | "BAD_MAGIC"
  | "UNKNOWN_KIND"
  | "UNSUPPORTED_FLAGS"
  | "INVALID_CHANNEL_ID"
  | "INVALID_MESSAGE_ID"
  | "LENGTH_MISMATCH";

export class RelayRoutingCodecError extends Error {
  readonly code: RelayRoutingCodecErrorCode;

  constructor(code: RelayRoutingCodecErrorCode, message: string) {
    super(message);
    this.name = "RelayRoutingCodecError";
    this.code = code;
  }
}

const MAGIC_OFFSET = 0;
const MAGIC_BYTES = new Uint8Array([0x50, 0x52, 0x52, 0x31]);
const KIND_OFFSET = 4;
const FLAGS_OFFSET = 5;
const CHANNEL_ID_OFFSET = 6;
const MESSAGE_ID_OFFSET = 22;
const PAYLOAD_LENGTH_OFFSET = 30;
const PAYLOAD_OFFSET = RELAY_ROUTING_HEADER_BYTES;

export function encodeRelayRoutingFrame(value: RelayRoutingFrame): Uint8Array {
  if (typeof value !== "object" || value === null) {
    throw new RelayRoutingCodecError("INVALID_INPUT", "A relay routing frame object is required");
  }
  if (!(value.channelId instanceof Uint8Array) || value.channelId.byteLength !== RELAY_ROUTING_CHANNEL_ID_BYTES) {
    throw new RelayRoutingCodecError(
      "INVALID_CHANNEL_ID",
      `Relay channel identifiers must contain exactly ${RELAY_ROUTING_CHANNEL_ID_BYTES} bytes`,
    );
  }
  if (typeof value.messageId !== "bigint" || value.messageId < 0n || value.messageId > MAX_RELAY_ROUTING_MESSAGE_ID) {
    throw new RelayRoutingCodecError(
      "INVALID_MESSAGE_ID",
      "Relay message identifiers must be unsigned 64-bit integers",
    );
  }
  if (!(value.payload instanceof Uint8Array)) {
    throw new RelayRoutingCodecError("INVALID_INPUT", "Relay payloads must be byte arrays");
  }
  if (value.payload.byteLength > MAX_RELAY_ROUTING_PAYLOAD_BYTES) {
    throw new RelayRoutingCodecError(
      "FRAME_TOO_LARGE",
      `Relay payload exceeds the ${MAX_RELAY_ROUTING_PAYLOAD_BYTES}-byte limit`,
    );
  }

  const frame = new Uint8Array(RELAY_ROUTING_HEADER_BYTES + value.payload.byteLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  frame.set(MAGIC_BYTES, MAGIC_OFFSET);
  frame[KIND_OFFSET] = encodeKind(value.kind);
  frame[FLAGS_OFFSET] = 0;
  frame.set(value.channelId, CHANNEL_ID_OFFSET);
  view.setBigUint64(MESSAGE_ID_OFFSET, value.messageId, false);
  view.setUint32(PAYLOAD_LENGTH_OFFSET, value.payload.byteLength, false);
  frame.set(value.payload, PAYLOAD_OFFSET);
  return frame;
}

export function decodeRelayRoutingFrame(input: Uint8Array): RelayRoutingFrame {
  if (!(input instanceof Uint8Array)) {
    throw new RelayRoutingCodecError("INVALID_INPUT", "Relay routing input must be a byte array");
  }
  if (input.byteLength > MAX_RELAY_ROUTING_FRAME_BYTES) {
    throw new RelayRoutingCodecError(
      "FRAME_TOO_LARGE",
      `Relay frame exceeds the ${MAX_RELAY_ROUTING_FRAME_BYTES}-byte limit`,
    );
  }
  if (input.byteLength < RELAY_ROUTING_HEADER_BYTES) {
    throw new RelayRoutingCodecError(
      "TRUNCATED_FRAME",
      `Relay frame ended before its ${RELAY_ROUTING_HEADER_BYTES}-byte header was complete`,
    );
  }

  for (let index = 0; index < MAGIC_BYTES.byteLength; index += 1) {
    if (input[MAGIC_OFFSET + index] !== MAGIC_BYTES[index]) {
      throw new RelayRoutingCodecError("BAD_MAGIC", "Relay frame does not begin with PRR1");
    }
  }

  const kind = decodeKind(input[KIND_OFFSET] as number);
  if (input[FLAGS_OFFSET] !== 0) {
    throw new RelayRoutingCodecError("UNSUPPORTED_FLAGS", "Relay frame flags must be zero in version 1");
  }

  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const declaredPayloadBytes = view.getUint32(PAYLOAD_LENGTH_OFFSET, false);
  if (declaredPayloadBytes > MAX_RELAY_ROUTING_PAYLOAD_BYTES) {
    throw new RelayRoutingCodecError(
      "FRAME_TOO_LARGE",
      `Relay payload declares more than ${MAX_RELAY_ROUTING_PAYLOAD_BYTES} bytes`,
    );
  }
  const expectedFrameBytes = RELAY_ROUTING_HEADER_BYTES + declaredPayloadBytes;
  if (input.byteLength !== expectedFrameBytes) {
    throw new RelayRoutingCodecError(
      "LENGTH_MISMATCH",
      `Relay frame length is ${input.byteLength} bytes but its header declares ${expectedFrameBytes}`,
    );
  }

  return {
    kind,
    channelId: new Uint8Array(input.subarray(CHANNEL_ID_OFFSET, MESSAGE_ID_OFFSET)),
    messageId: view.getBigUint64(MESSAGE_ID_OFFSET, false),
    payload: new Uint8Array(input.subarray(PAYLOAD_OFFSET)),
  };
}

function encodeKind(kind: RelayRoutingKind): number {
  switch (kind) {
    case "ready":
      return 1;
    case "peer_open":
      return 2;
    case "data":
      return 3;
    case "forward_result":
      return 4;
    case "peer_close":
      return 5;
    default:
      throw new RelayRoutingCodecError("UNKNOWN_KIND", "Relay frame kind is not supported by version 1");
  }
}

function decodeKind(code: number): RelayRoutingKind {
  switch (code) {
    case 1:
      return "ready";
    case 2:
      return "peer_open";
    case 3:
      return "data";
    case 4:
      return "forward_result";
    case 5:
      return "peer_close";
    default:
      throw new RelayRoutingCodecError("UNKNOWN_KIND", `Relay frame kind code ${code} is not supported`);
  }
}
