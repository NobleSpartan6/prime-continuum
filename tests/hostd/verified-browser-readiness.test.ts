import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeVerifiedBrowserExecution } from "../../src/hostd/verified-resident-gateway";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function probeScript(source: string, timeoutMs = 2_000): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "prime-browser-doctor-test-"));
  temporaryDirectories.push(directory);
  const bridge = join(directory, "doctor.cjs");
  await writeFile(bridge, source, { mode: 0o600 });
  return probeVerifiedBrowserExecution({
    executable: process.execPath,
    bridge,
    stateDirectory: directory,
    workingDirectory: directory,
    environment: {},
    timeoutMs,
  });
}

describe("verified browser doctor", () => {
  it("accepts only the exact path-free execution identity", async () => {
    await expect(probeScript(`process.stdout.write(JSON.stringify({
      protocol: "prime-continuim.browser.v1",
      bridgeVersion: 1,
      ready: true,
      controller: "playwright-core/1.63.0-alpha-2026-08-05",
      engine: "verified-electron-host"
    }));`)).resolves.toBe(true);
    await expect(probeScript(`process.stdout.write(JSON.stringify({
      protocol: "prime-continuim.browser.v1",
      bridgeVersion: 1,
      ready: true,
      controller: "playwright-core/1.63.0-alpha-2026-08-05",
      engine: "verified-electron-host",
      executable: "/private/runtime"
    }));`)).resolves.toBe(false);
  });

  it("fails closed for an error or timeout and retires the child", async () => {
    await expect(probeScript("process.exit(2)")).resolves.toBe(false);
    const startedAt = Date.now();
    await expect(probeScript("setInterval(() => {}, 1000)", 25)).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it.runIf(process.platform !== "win32")("cancels timeout escalation after SIGTERM retires the doctor", async () => {
    const kill = vi.spyOn(process, "kill");
    try {
      await expect(probeScript(`
        process.on("SIGTERM", () => process.exit(0));
        setInterval(() => {}, 1000);
      `, 25)).resolves.toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 850));
      expect(kill.mock.calls.some(([, signal]) => signal === "SIGTERM")).toBe(true);
      expect(kill.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });
});
