import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseHostdCli, runHostdCli } from "../../src/hostd";

describe("hostd runtime seed CLI authority", () => {
  const seed = path.resolve("test-runtime-seed");

  it("accepts one absolute runtime seed only for serve", () => {
    expect(parseHostdCli(["serve", "--runtime-seed", seed])).toMatchObject({
      mode: "serve",
      runtimeSeed: seed,
    });
  });

  it.each([
    [["serve", "--runtime-seed"], "requires one value"],
    [["serve", "--runtime-seed", "--data-dir", seed], "requires one value"],
    [["serve", "--runtime-seed", "relative/seed"], "absolute path"],
    [["serve", "--runtime-seed", seed, "--runtime-seed", seed], "only once"],
    [["connect", "--stdio", "--runtime-seed", seed], "valid only with serve"],
    [["probe", "--json", "--runtime-seed", seed], "valid only with serve"],
    [["seed", "--runtime-seed", seed], "Unknown hostd mode"],
  ] as const)("rejects invalid seed authority %#", (argv, message) => {
    expect(() => parseHostdCli([...argv])).toThrow(message);
  });

  it("rejects controlled and oversized values before path normalization", () => {
    expect(() => parseHostdCli(["serve", "--runtime-seed", `${seed}\nsecond`])).toThrow("bounded");
    expect(() => parseHostdCli(["serve", "--runtime-seed", `C:\\${"x".repeat(4_096)}`])).toThrow("bounded");
  });

  it("installs termination handling before asynchronous ownership startup settles", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "prime-hostd-early-signal-test-"));
    const priorListeners = new Set(process.listeners("SIGTERM"));
    let terminate: NodeJS.SignalsListener | undefined;
    const running = runHostdCli(["serve", "--data-dir", directory]);
    try {
      const addedListeners = process.listeners("SIGTERM").filter((listener) => !priorListeners.has(listener));
      expect(addedListeners).toHaveLength(1);
      terminate = addedListeners[0];
      terminate?.("SIGTERM");
      await expect(running).resolves.toBe(0);
      expect(process.listeners("SIGTERM").filter((listener) => !priorListeners.has(listener))).toEqual([]);
    } finally {
      terminate?.("SIGTERM");
      await running.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
