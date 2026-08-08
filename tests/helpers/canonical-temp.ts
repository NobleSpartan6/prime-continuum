import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a test-owned directory using its physical platform spelling.
 *
 * Windows runners can report TEMP through an 8.3 alias and macOS exposes
 * /var through /private/var. Security-sensitive tests must not accidentally
 * exercise those aliases when the production boundary requires one physical
 * host-data identity.
 */
export async function canonicalTemporaryDirectory(prefix: string): Promise<string> {
  // macOS's per-user TMPDIR spelling is longer than the native Unix-socket
  // path limit for several descriptive fixture names. `/tmp` is test-owned via
  // mkdtemp and resolves to its physical `/private/tmp` spelling there.
  const temporaryRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const physicalTemporaryRoot = await realpath(temporaryRoot);
  return realpath(await mkdtemp(join(physicalTemporaryRoot, prefix)));
}
