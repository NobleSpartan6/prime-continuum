import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AtomicWriteAmbiguousCommitError,
  atomicWriteJsonIfAbsent,
  pathExists,
  type AtomicCreateFaultPoint,
} from "../../src/hostd/atomic-files";

const temporaryDirectories: string[] = [];
const prePublicationFaults: AtomicCreateFaultPoint[] = [
  "after_open",
  "after_write",
  "after_sync",
  "after_close",
];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("atomic create-if-absent", () => {
  it.each(prePublicationFaults)("does not expose a destination after a fault at %s", async (faultPoint) => {
    const directory = await temporaryDirectory();
    const file = join(directory, "checkpoint.json");
    const checkpoint = { version: 1, checkpointId: "checkpoint-test" };

    await expect(
      atomicWriteJsonIfAbsent(file, checkpoint, undefined, {
        faultInjector(point) {
          if (point === faultPoint) throw new Error(`simulated ${point} failure`);
        },
      }),
    ).rejects.toThrow(`simulated ${faultPoint} failure`);

    expect(await pathExists(file)).toBe(false);
    expect(await readdir(directory)).toEqual([]);
    expect(await atomicWriteJsonIfAbsent(file, checkpoint)).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(checkpoint);
  });

  it("surfaces a post-publication failure without deleting the published destination", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "checkpoint.json");
    const checkpoint = { version: 1, checkpointId: "checkpoint-published" };

    await expect(
      atomicWriteJsonIfAbsent(file, checkpoint, undefined, {
        faultInjector(point) {
          if (point === "after_link") throw new Error("simulated publication uncertainty");
        },
      }),
    ).rejects.toBeInstanceOf(AtomicWriteAmbiguousCommitError);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(checkpoint);
    expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(await atomicWriteJsonIfAbsent(file, checkpoint)).toBe(false);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "prime-atomic-create-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
