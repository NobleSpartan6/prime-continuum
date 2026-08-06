import { describe, expect, it } from "vitest";
import { InMemoryRelayGrantStore, parseBearerToken, sha256Hex } from "../src/grant-store";

describe("InMemoryRelayGrantStore", () => {
  it("stores only a SHA-256 digest and atomically consumes one-shot grants", async () => {
    const store = new InMemoryRelayGrantStore();
    const tokenBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    const token = store.issue({
      routeId: "route-a",
      endpointId: "host-a",
      role: "host",
      expiresAt: 2_000,
      tokenBytes,
    });

    expect(token).toBe(Buffer.from(tokenBytes).toString("base64url"));
    expect(store.pendingCount).toBe(1);
    const parsed = parseBearerToken(`Bearer ${token}`);
    expect(parsed).toEqual(tokenBytes);
    expect(await store.consumeSha256(sha256Hex(parsed as Uint8Array), 1_000)).toEqual({
      routeId: "route-a",
      endpointId: "host-a",
      role: "host",
      expiresAt: 2_000,
    });
    expect(store.pendingCount).toBe(0);
    expect(await store.consumeSha256(sha256Hex(tokenBytes), 1_000)).toBeNull();
  });

  it("burns expired credentials and validates canonical 256-bit bearer syntax", async () => {
    const store = new InMemoryRelayGrantStore();
    const token = store.issue({
      routeId: "route-a",
      endpointId: "device-a",
      role: "device",
      expiresAt: 999,
      tokenBytes: new Uint8Array(32).fill(7),
    });

    const parsed = parseBearerToken(`Bearer ${token}`) as Uint8Array;
    expect(await store.consumeSha256(sha256Hex(parsed), 1_000)).toBeNull();
    expect(await store.consumeSha256(sha256Hex(parsed), 0)).toBeNull();

    for (const malformed of [
      undefined,
      "",
      token,
      `bearer ${token}`,
      `Bearer  ${token}`,
      `Bearer ${token}=`,
      `Bearer ${Buffer.alloc(31).toString("base64url")}`,
      `Bearer ${Buffer.alloc(33).toString("base64url")}`,
    ]) {
      expect(parseBearerToken(malformed)).toBeNull();
    }
  });

  it("rejects weak tokens, malformed grants, and duplicate digests", () => {
    const store = new InMemoryRelayGrantStore();
    expect(() =>
      store.issue({
        routeId: "route-a",
        endpointId: "host-a",
        role: "host",
        expiresAt: 2_000,
        tokenBytes: new Uint8Array(31),
      }),
    ).toThrow(/256 bits/);

    const input = {
      routeId: "route-a",
      endpointId: "host-a",
      role: "host" as const,
      expiresAt: 2_000,
      tokenBytes: new Uint8Array(32).fill(8),
    };
    store.issue(input);
    expect(() => store.issue(input)).toThrow(/already registered/);
    expect(() => store.registerSha256("not-a-digest", input)).toThrow(/SHA-256/);
  });
});
