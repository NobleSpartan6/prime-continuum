import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  encodeJsonFrame,
  FrameCodecError,
  LengthPrefixedJsonDecoder,
  readJsonFrames,
  writeJsonFrame,
} from "../../src/shared/frame-codec";

describe("length-prefixed JSON framing", () => {
  it("uses a four-byte big-endian length and survives arbitrary chunk boundaries", () => {
    const first = { hello: "remote" };
    const second = { sequence: 42 };
    const bytes = Buffer.concat([encodeJsonFrame(first), encodeJsonFrame(second)]);
    expect(bytes.readUInt32BE(0)).toBe(Buffer.byteLength(JSON.stringify(first), "utf8"));

    const decoder = new LengthPrefixedJsonDecoder();
    const values: unknown[] = [];
    for (let index = 0; index < bytes.length; index += 1) {
      values.push(...decoder.push(bytes.subarray(index, index + 1)));
    }
    decoder.finish();
    expect(values).toEqual([first, second]);
  });

  it("rejects oversized declarations before allocating a payload", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(65_537);
    const decoder = new LengthPrefixedJsonDecoder({ maxFrameBytes: 65_536 });
    expect(() => decoder.push(header)).toThrowError(
      expect.objectContaining<Partial<FrameCodecError>>({ code: "FRAME_TOO_LARGE" }),
    );
  });

  it("rejects malformed JSON and truncated frames", () => {
    const invalid = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("{")]);
    expect(() => new LengthPrefixedJsonDecoder().push(invalid)).toThrowError(
      expect.objectContaining<Partial<FrameCodecError>>({ code: "INVALID_JSON" }),
    );

    const decoder = new LengthPrefixedJsonDecoder();
    decoder.push(encodeJsonFrame({ incomplete: true }).subarray(0, 7));
    expect(() => decoder.finish()).toThrowError(
      expect.objectContaining<Partial<FrameCodecError>>({ code: "TRUNCATED_FRAME" }),
    );
  });

  it("provides backpressure-aware stream helpers", async () => {
    const stream = new PassThrough();
    const received: unknown[] = [];
    const reading = (async () => {
      for await (const value of readJsonFrames(stream)) received.push(value);
    })();
    await writeJsonFrame(stream, { ok: 1 });
    await writeJsonFrame(stream, { ok: 2 });
    stream.end();
    await reading;
    expect(received).toEqual([{ ok: 1 }, { ok: 2 }]);
  });
});
