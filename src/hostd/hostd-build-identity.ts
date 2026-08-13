import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import type { HostdBuildIdentity } from "../shared/protocol";

const MAX_HOSTD_BUNDLE_BYTES = 256 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Hashes the exact regular bundle this process loaded before it serves health. */
export async function readHostdBuildIdentity(
  bundlePath: string,
  runtimeTrustAnchorId?: string,
): Promise<HostdBuildIdentity> {
  if (runtimeTrustAnchorId !== undefined && !SHA256_PATTERN.test(runtimeTrustAnchorId)) {
    throw new TypeError("Hostd runtime trust anchor must be one SHA-256 identity");
  }
  const metadata = await lstat(bundlePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > MAX_HOSTD_BUNDLE_BYTES
  ) {
    throw new Error("The hostd bundle is not a bounded regular file");
  }
  const bundleSha256 = await hashOpenedRegularFile(bundlePath, metadata);
  return Object.freeze({
    contractVersion: 1,
    bundleSha256,
    ...(runtimeTrustAnchorId ? { runtimeTrustAnchorId } : {}),
  });
}

async function hashOpenedRegularFile(
  bundlePath: string,
  expected: Awaited<ReturnType<typeof lstat>>,
): Promise<string> {
  const handle = await open(bundlePath, "r");
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      before.size !== expected.size ||
      before.mtimeMs !== expected.mtimeMs
    ) {
      throw new Error("The hostd bundle changed before it was hashed");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - position),
        position,
      );
      if (bytesRead <= 0) throw new Error("The hostd bundle ended before its recorded size");
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    const { bytesRead: growthBytes } = await handle.read(growthProbe, 0, 1, before.size);
    const after = await handle.stat();
    if (
      growthBytes !== 0 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error("The hostd bundle changed while it was hashed");
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}
