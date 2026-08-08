import {
  RuntimeFileIdentityChangedError,
  assertSameRuntimeFileIdentity,
  isCtimeOnlyRuntimeFileIdentityChange,
  retryOnceAfterCtimeOnlyIdentityChange,
  type RuntimeFileIdentity,
} from "../../src/hostd/runtime-file-identity";
import { describe, expect, it } from "vitest";

describe("runtime file identity fencing", () => {
  it("retains every stable identity and content-metadata field", () => {
    const baseline = identity();
    expect(() => assertSameRuntimeFileIdentity(baseline, identity(), "changed")).not.toThrow();

    const mutations = [
      { isFile: () => false, field: "fileType" },
      { nlink: 2n, field: "nlink" },
      { dev: 2n, field: "dev" },
      { ino: 3n, field: "ino" },
      { size: 5n, field: "size" },
      { mtimeNs: 7n, field: "mtimeNs" },
      { ctimeNs: 11n, field: "ctimeNs" },
    ] as const;

    for (const mutation of mutations) {
      let failure: unknown;
      try {
        assertSameRuntimeFileIdentity(baseline, identity(mutation), "changed");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(RuntimeFileIdentityChangedError);
      expect(failure).toMatchObject({ changedFields: [mutation.field] });
    }
  });

  it("repeats one complete operation after ctime-only refresh and accepts only its stable pass", async () => {
    let calls = 0;
    const result = await retryOnceAfterCtimeOnlyIdentityChange(async () => {
      calls += 1;
      const before = identity({ ctimeNs: BigInt(calls) });
      const after = calls === 1 ? identity({ ctimeNs: 2n }) : identity({ ctimeNs: BigInt(calls) });
      assertSameRuntimeFileIdentity(before, after, "changed while reading");
      return "verified";
    });

    expect(result).toBe("verified");
    expect(calls).toBe(2);
  });

  it("returns a repeated ctime-only refresh after exactly two operations", async () => {
    let calls = 0;
    const failure = await retryOnceAfterCtimeOnlyIdentityChange(async () => {
      calls += 1;
      assertSameRuntimeFileIdentity(
        identity({ ctimeNs: BigInt(calls) }),
        identity({ ctimeNs: BigInt(calls + 1) }),
        "changed while reading",
      );
    }).catch((error: unknown) => error);

    expect(calls).toBe(2);
    expect(isCtimeOnlyRuntimeFileIdentityChange(failure)).toBe(true);
  });

  it.each([
    ["inode replacement", { ino: 44n }],
    ["content metadata mutation", { mtimeNs: 44n }],
    ["ctime plus content metadata mutation", { ctimeNs: 44n, mtimeNs: 44n }],
  ] as const)("never retries %s", async (_label, mutation) => {
    let calls = 0;
    const failure = await retryOnceAfterCtimeOnlyIdentityChange(async () => {
      calls += 1;
      assertSameRuntimeFileIdentity(identity(), identity(mutation), "changed while reading");
    }).catch((error: unknown) => error);

    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(RuntimeFileIdentityChangedError);
    expect(isCtimeOnlyRuntimeFileIdentityChange(failure)).toBe(false);
  });
});

function identity(
  overrides: Partial<RuntimeFileIdentity> = {},
): RuntimeFileIdentity {
  return {
    isFile: () => true,
    nlink: 1n,
    dev: 1n,
    ino: 2n,
    size: 4n,
    mtimeNs: 6n,
    ctimeNs: 8n,
    ...overrides,
  };
}
