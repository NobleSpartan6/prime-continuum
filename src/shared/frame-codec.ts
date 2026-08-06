import type { Readable, Writable } from "node:stream";

export const FRAME_HEADER_BYTES = 4;
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_MAX_FRAMES_PER_CHUNK = 1_024;

export type FrameCodecErrorCode =
  | "EMPTY_FRAME"
  | "FRAME_TOO_LARGE"
  | "TOO_MANY_FRAMES"
  | "INVALID_UTF8"
  | "INVALID_JSON"
  | "INVALID_PAYLOAD"
  | "TRUNCATED_FRAME";

export class FrameCodecError extends Error {
  readonly code: FrameCodecErrorCode;

  constructor(code: FrameCodecErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FrameCodecError";
    this.code = code;
  }
}

export interface FrameCodecOptions<T> {
  maxFrameBytes?: number;
  maxFramesPerChunk?: number;
  parse?: (value: unknown) => T;
}

function checkedMaxFrameBytes(value: number | undefined): number {
  const result = value ?? DEFAULT_MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(result) || result < 1 || result > 0xffff_ffff) {
    throw new RangeError("maxFrameBytes must be an integer between 1 and 4294967295");
  }
  return result;
}

export function encodeJsonFrame(value: unknown, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): Buffer {
  const limit = checkedMaxFrameBytes(maxFrameBytes);
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new FrameCodecError("INVALID_PAYLOAD", "Value cannot be serialized as JSON", { cause: error });
  }

  if (json === undefined) {
    throw new FrameCodecError("INVALID_PAYLOAD", "Value cannot be serialized as a JSON document");
  }

  const payload = Buffer.from(json, "utf8");
  if (payload.byteLength === 0) {
    throw new FrameCodecError("EMPTY_FRAME", "JSON frames cannot be empty");
  }
  if (payload.byteLength > limit) {
    throw new FrameCodecError(
      "FRAME_TOO_LARGE",
      `JSON frame is ${payload.byteLength} bytes; the configured maximum is ${limit}`,
    );
  }

  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Incremental, allocation-bounded decoder for uint32be-length-prefixed JSON.
 * It keeps only one declared payload in memory and never searches for a frame
 * delimiter, so arbitrary chunk boundaries are safe.
 */
export class LengthPrefixedJsonDecoder<T = unknown> {
  readonly maxFrameBytes: number;
  readonly maxFramesPerChunk: number;

  private readonly parseValue: (value: unknown) => T;
  private readonly header = Buffer.alloc(FRAME_HEADER_BYTES);
  private readonly utf8Decoder = new TextDecoder("utf-8", { fatal: true });
  private headerBytes = 0;
  private payload: Buffer | undefined;
  private payloadBytes = 0;

  constructor(options: FrameCodecOptions<T> = {}) {
    this.maxFrameBytes = checkedMaxFrameBytes(options.maxFrameBytes);
    this.maxFramesPerChunk = options.maxFramesPerChunk ?? DEFAULT_MAX_FRAMES_PER_CHUNK;
    if (!Number.isSafeInteger(this.maxFramesPerChunk) || this.maxFramesPerChunk < 1) {
      throw new RangeError("maxFramesPerChunk must be a positive integer");
    }
    this.parseValue = options.parse ?? ((value) => value as T);
  }

  push(chunk: Uint8Array): T[] {
    const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const values: T[] = [];
    let offset = 0;

    while (offset < input.byteLength) {
      if (this.payload === undefined) {
        const headerRemaining = FRAME_HEADER_BYTES - this.headerBytes;
        const copied = Math.min(headerRemaining, input.byteLength - offset);
        input.copy(this.header, this.headerBytes, offset, offset + copied);
        this.headerBytes += copied;
        offset += copied;

        if (this.headerBytes < FRAME_HEADER_BYTES) {
          continue;
        }

        const payloadLength = this.header.readUInt32BE(0);
        this.headerBytes = 0;
        if (payloadLength === 0) {
          this.reset();
          throw new FrameCodecError("EMPTY_FRAME", "Received a zero-length JSON frame");
        }
        if (payloadLength > this.maxFrameBytes) {
          this.reset();
          throw new FrameCodecError(
            "FRAME_TOO_LARGE",
            `Declared frame length ${payloadLength} exceeds maximum ${this.maxFrameBytes}`,
          );
        }
        this.payload = Buffer.allocUnsafe(payloadLength);
        this.payloadBytes = 0;
      }

      const payload = this.payload;
      const payloadRemaining = payload.byteLength - this.payloadBytes;
      const copied = Math.min(payloadRemaining, input.byteLength - offset);
      input.copy(payload, this.payloadBytes, offset, offset + copied);
      this.payloadBytes += copied;
      offset += copied;

      if (this.payloadBytes === payload.byteLength) {
        values.push(this.decodePayload(payload));
        this.payload = undefined;
        this.payloadBytes = 0;
        if (values.length > this.maxFramesPerChunk) {
          this.reset();
          throw new FrameCodecError(
            "TOO_MANY_FRAMES",
            `One transport chunk contained more than ${this.maxFramesPerChunk} frames`,
          );
        }
      }
    }

    return values;
  }

  finish(): void {
    if (this.headerBytes !== 0 || this.payload !== undefined) {
      const received = this.payload === undefined ? this.headerBytes : this.payloadBytes + FRAME_HEADER_BYTES;
      this.reset();
      throw new FrameCodecError("TRUNCATED_FRAME", `Transport ended during a frame after ${received} bytes`);
    }
  }

  reset(): void {
    this.headerBytes = 0;
    this.payload = undefined;
    this.payloadBytes = 0;
  }

  private decodePayload(payload: Buffer): T {
    let text: string;
    try {
      text = this.utf8Decoder.decode(payload);
    } catch (error) {
      throw new FrameCodecError("INVALID_UTF8", "Frame payload is not valid UTF-8", { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new FrameCodecError("INVALID_JSON", "Frame payload is not valid JSON", { cause: error });
    }

    try {
      return this.parseValue(parsed);
    } catch (error) {
      throw new FrameCodecError("INVALID_PAYLOAD", "JSON frame does not match the expected payload", {
        cause: error,
      });
    }
  }
}

export async function* readJsonFrames<T = unknown>(
  readable: Readable,
  options: FrameCodecOptions<T> = {},
): AsyncGenerator<T, void, undefined> {
  const decoder = new LengthPrefixedJsonDecoder(options);
  for await (const chunk of readable) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Uint8Array);
    for (const value of decoder.push(bytes)) {
      yield value;
    }
  }
  decoder.finish();
}

export async function writeJsonFrame(
  writable: Writable,
  value: unknown,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): Promise<void> {
  const frame = encodeJsonFrame(value, maxFrameBytes);
  // The write callback fires only when this chunk has left the writable's
  // internal queue (or failed), which naturally bounds callers that await each
  // frame without leaving uncancellable `drain`/`error` listeners behind.
  await new Promise<void>((resolve, reject) => {
    writable.write(frame, (error) => (error ? reject(error) : resolve()));
  });
}
