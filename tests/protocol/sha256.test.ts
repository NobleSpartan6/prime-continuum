import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Utf8Hex } from "../../src/shared/sha256";

describe("shared synchronous UTF-8 SHA-256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("matches the published SHA-256 vector for %j", (input, expected) => {
    expect(sha256Utf8Hex(input)).toBe(expected);
  });

  it("matches Node crypto across UTF-8 and padding boundaries", () => {
    const inputs = [
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(63),
      "a".repeat(64),
      "a".repeat(65),
      "café\u0000\r\n",
      "Prime Continuim — durable OAuth 🔐",
      "\ud800",
      "\udc00",
      "prefix-\ud800-suffix",
      "😀".repeat(33),
    ];

    for (const input of inputs) {
      expect(sha256Utf8Hex(input)).toBe(
        createHash("sha256").update(input, "utf8").digest("hex"),
      );
    }
  });

  it("handles a multi-block regression vector without mutable cross-call state", () => {
    const millionAs = "a".repeat(1_000_000);
    expect(sha256Utf8Hex(millionAs)).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
    expect(sha256Utf8Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("rejects non-string runtime input", () => {
    expect(() => sha256Utf8Hex(123 as unknown as string)).toThrow(TypeError);
  });
});
