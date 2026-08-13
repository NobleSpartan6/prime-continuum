import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readHostdBuildIdentity } from "../../src/hostd/hostd-build-identity";

describe("hostd build identity", () => {
  it("binds health identity to the exact loaded bundle and runtime trust anchor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-identity-"));
    try {
      const bundle = join(directory, "hostd.cjs");
      await writeFile(bundle, "module.exports = {};\n", "utf8");
      const trustAnchor = "b".repeat(64);
      await expect(readHostdBuildIdentity(bundle, trustAnchor)).resolves.toEqual({
        contractVersion: 1,
        bundleSha256: createHash("sha256").update("module.exports = {};\n").digest("hex"),
        runtimeTrustAnchorId: trustAnchor,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects symlinked bundles and malformed trust anchors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-hostd-identity-link-"));
    try {
      const target = join(directory, "target.cjs");
      const link = join(directory, "hostd.cjs");
      await writeFile(target, "module.exports = {};\n", "utf8");
      await symlink(target, link);
      await expect(readHostdBuildIdentity(link, "b".repeat(64))).rejects.toThrow("bounded regular file");
      await expect(readHostdBuildIdentity(target, "not-a-digest")).rejects.toThrow("SHA-256 identity");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
