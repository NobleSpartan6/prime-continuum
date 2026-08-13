import { describe, expect, it } from "vitest";
import {
  browserCommandIndex,
  firstBrowserCommand,
  parseBrowserSessionName,
  rewriteBrowserCommand,
  rewriteBrowserSessionName,
} from "../../runtime/prime-agent/bridge/browser-bridge-arguments.mjs";
import {
  browserProcessStatus,
  createBrowserHostEnvironment,
} from "../../runtime/prime-agent/bridge/browser-bridge-environment.mjs";
import { withBrowserSessionLock } from "../../runtime/prime-agent/bridge/browser-bridge-session-lock.mjs";
import { retireBrowserEvidence } from "../../runtime/prime-agent/bridge/browser-bridge-evidence.mjs";
import { browserSessionStateKeys, residentBrowserAuthority } from "../../runtime/prime-agent/bridge/browser-bridge-state.mjs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const launchJournal = require("../../runtime/prime-agent/bridge/browser-bridge-launch-journal.cjs") as {
  claimBrowserLaunchOwnerSync(path: string, nonce: string, hostPid: number): Readonly<Record<string, unknown>>;
  browserMetadataRecoveryDisposition(launch: Readonly<Record<string, unknown>>, metadata: Readonly<Record<string, unknown>> | undefined, disposition: string): string;
  cleanupOrphanLaunchOwners(directory: string, options: Readonly<{ processStatus: (pid: number) => "live" | "dead" | "unknown" }>): Promise<string>;
  cleanupRetiredBrowserState(state: Readonly<{ directory: string; launchPath: string; metadataPath: string; profileDirectory: string }>, options: Readonly<{ processStatus: (pid: number) => "live" | "dead" | "unknown"; removeProfile: boolean }>): Promise<string>;
  commitBrowserLaunch(path: string, ready: Readonly<Record<string, unknown>>, metadata: Readonly<Record<string, unknown>>, now?: () => number): Promise<Readonly<Record<string, unknown>>>;
  createStartingLaunch(path: string, bridgePid: number, now?: () => number): Promise<Readonly<Record<string, unknown>>>;
  durableWrite(path: string, value: Readonly<Record<string, unknown>>): Promise<void>;
  durableRemove(path: string): Promise<void>;
  launchRecoveryDisposition(record: Readonly<Record<string, unknown>>, options: Readonly<{ processStatus: (pid: number) => "live" | "dead" | "unknown" }>): string;
  metadataMatchesCommitted(metadata: Readonly<Record<string, unknown>>, committed: Readonly<Record<string, unknown>>): boolean;
  publishClaimedLaunchSync(path: string, owner: Readonly<Record<string, unknown>>, now?: () => number): Readonly<Record<string, unknown>>;
  publishReadyLaunchSync(path: string, nonce: string, hostPid: number, controlPort: number, now?: () => number): Readonly<Record<string, unknown>>;
  readLaunchEvidence(path: string): Promise<Readonly<{ status: string; record?: Readonly<Record<string, unknown>> }>>;
  readEvidence(
    path: string,
    validator: (value: unknown) => boolean,
    options?: Readonly<{
      lstat?: (path: string) => Promise<Stats>;
      open?: (path: string, flags: number) => Promise<FileHandle>;
      maxReplacementRetries?: number;
    }>,
  ): Promise<Readonly<{ status: string; record?: Readonly<Record<string, unknown>> }>>;
  resolveStartingLaunch(path: string, starting: Readonly<Record<string, unknown>>, options: Readonly<{ now: () => number; processStatus: (pid: number) => "live" | "dead" | "unknown" }>): Promise<string>;
  syncDirectory(path: string, platform?: NodeJS.Platform): Promise<void>;
  syncDirectorySync(path: string, platform?: NodeJS.Platform): void;
};

describe("verified browser bridge arguments", () => {
  it.each([
    [["--session=review", "open", "https://example.com"], "review", 1],
    [["--session", "review", "open", "https://example.com"], "review", 2],
    [["-s=review", "close"], "review", 1],
    [["-s", "review", "close"], "review", 2],
  ] as const)("finds the command without treating a session value as one: %j", (args, session, index) => {
    expect(parseBrowserSessionName(args)).toBe(session);
    expect(browserCommandIndex(args)).toBe(index);
    expect(firstBrowserCommand(args)).toBe(args[index]);
  });

  it("rewrites only the actual command", () => {
    expect(rewriteBrowserCommand(["--session", "review", "detach"], "close")).toEqual([
      "--session",
      "review",
      "close",
    ]);
  });

  it("rewrites the official daemon session without changing the user-facing command", () => {
    expect(rewriteBrowserSessionName(["--session", "review", "click", "e2"], "pc-authority-session"))
      .toEqual(["--session", "pc-authority-session", "click", "e2"]);
    expect(rewriteBrowserSessionName(["snapshot"], "pc-authority-session"))
      .toEqual(["--session=pc-authority-session", "snapshot"]);
  });

  it("rejects path-like or unbounded session names", () => {
    expect(() => parseBrowserSessionName(["--session", "../private", "open"])).toThrow();
    expect(() => parseBrowserSessionName(["--session", `a${"b".repeat(64)}`, "open"])).toThrow();
  });
});

describe("verified browser host environment", () => {
  it("keeps cold browser startup and exact commit custody explicitly bounded", async () => {
    const [bridgeSource, hostSource] = await Promise.all([
      readFile(join(process.cwd(), "runtime", "prime-agent", "bridge", "browser-bridge.mjs"), "utf8"),
      readFile(join(process.cwd(), "runtime", "prime-agent", "bridge", "browser-host.cjs"), "utf8"),
    ]);

    expect(bridgeSource).toContain("const DOCTOR_TIMEOUT_MS = 15_000;");
    expect(bridgeSource).toContain("const START_TIMEOUT_MS = 30_000;");
    expect(bridgeSource).toContain("timeout: DOCTOR_TIMEOUT_MS");
    expect(bridgeSource).toContain("firstWindow({ timeout: DOCTOR_TIMEOUT_MS })");
    expect(hostSource).toContain("const COMMIT_TIMEOUT_MS = 60_000;");
  });

  it("routes immediate dead-lock recovery only through exact close and delete-data", async () => {
    const bridgeSource = await readFile(
      join(process.cwd(), "runtime", "prime-agent", "bridge", "browser-bridge.mjs"),
      "utf8",
    );
    const routerStart = bridgeSource.indexOf("  switch (command) {");
    const routerEnd = bridgeSource.indexOf("\n}\n\nasync function verifiedEnvironment", routerStart);
    const router = bridgeSource.slice(routerStart, routerEnd);
    const branch = (command: string) => {
      const marker = `case "${command}":`;
      const start = router.indexOf(marker);
      if (start < 0) return "";
      const boundaries = [
        router.indexOf("\n    case ", start + marker.length),
        router.indexOf("\n    default:", start + marker.length),
      ].filter((index) => index >= 0);
      return router.slice(start, boundaries.length > 0 ? Math.min(...boundaries) : undefined);
    };

    expect(router.match(/deadOwnerGraceMs: 0/g)).toHaveLength(2);
    expect(branch("close")).toContain("{ deadOwnerGraceMs: 0 }");
    expect(branch("delete-data")).toContain("{ deadOwnerGraceMs: 0 }");
    expect(branch("open")).toContain("openVerifiedBrowser");
    expect(branch("open")).not.toContain("deadOwnerGraceMs");
    expect(branch("detach")).not.toContain("deadOwnerGraceMs");
  });

  it("uses a browser-only doctor host that cannot collide with the desktop single-instance lock", async () => {
    const [bridgeSource, doctorHostSource] = await Promise.all([
      readFile(join(process.cwd(), "runtime", "prime-agent", "bridge", "browser-bridge.mjs"), "utf8"),
      readFile(join(process.cwd(), "runtime", "prime-agent", "bridge", "browser-doctor-host.cjs"), "utf8"),
    ]);

    expect(bridgeSource).toContain('join(dirname(import.meta.filename), "browser-doctor-host.cjs")');
    expect(bridgeSource).toContain("--prime-doctor-owner-pid=");
    expect(doctorHostSource).toContain('process.platform !== "win32"');
    expect(doctorHostSource).toContain("process.kill(ownerPid, 0)");
    expect(doctorHostSource).not.toContain("requestSingleInstanceLock");
  });

  it("gives the hidden verified browser host an unthrottled offscreen surface", async () => {
    const hostSource = await readFile(
      join(process.cwd(), "runtime", "prime-agent", "bridge", "browser-host.cjs"),
      "utf8",
    );
    expect(hostSource).toContain("show: false");
    expect(hostSource).toContain("backgroundThrottling: false");
    expect(hostSource).toContain("offscreen: true");
  });

  it("maps the build-smoke font marker only inside the verified CLI daemon", async () => {
    const shimSource = await readFile(
      join(process.cwd(), "runtime", "prime-agent", "bridge", "electron-node-shim.cjs"),
      "utf8",
    );
    expect(shimSource).toContain('PRIME_CONTINUIM_BROWSER_SMOKE_SKIP_FONT_READY === "1"');
    expect(shimSource).toContain('process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = "1"');
  });

  it("retains only OS launch state and excludes credentials, loaders, proxies, and agent internals", () => {
    const environment = createBrowserHostEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      TMPDIR: "/private/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      DISPLAY: ":0",
      OPENAI_API_KEY: "must-not-cross",
      GITHUB_TOKEN: "must-not-cross",
      PRIME_AGENT_SECRET: "must-not-cross",
      HTTP_PROXY: "https://user:password@example.test",
      NODE_OPTIONS: "--require must-not-cross",
      NODE_PATH: "/must-not-cross",
      ELECTRON_RUN_AS_NODE: "1",
      AWS_SESSION_TOKEN: "must-not-cross",
    });

    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      TMPDIR: "/private/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      DISPLAY: ":0",
    });
    expect(JSON.stringify(environment)).not.toContain("must-not-cross");
    expect(Object.isFrozen(environment)).toBe(true);
  });

  it("drops values containing control characters", () => {
    expect(createBrowserHostEnvironment({ PATH: "/usr/bin\nOPENAI_API_KEY=secret" })).toEqual({});
  });
});

describe("verified browser process evidence", () => {
  it("treats a Linux zombie as retired even while kill(0) still observes its PID", () => {
    expect(browserProcessStatus(4242, {
      platform: "linux",
      signal: () => undefined,
      readProcStat: () => "4242 (electron) Z 1 4242 4242 0 -1 0",
    })).toBe("dead");
  });

  it("keeps live and unreadable Linux process identities fail-closed", () => {
    expect(browserProcessStatus(4242, {
      platform: "linux",
      signal: () => undefined,
      readProcStat: () => "4242 (electron renderer) S 1 4242 4242 0 -1 0",
    })).toBe("live");
    expect(browserProcessStatus(4242, {
      platform: "linux",
      signal: () => undefined,
      readProcStat: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    })).toBe("unknown");
  });

  it("preserves the portable kill probe outside Linux", () => {
    expect(browserProcessStatus(4242, {
      platform: "darwin",
      signal: () => undefined,
      readProcStat: () => { throw new Error("must not read procfs"); },
    })).toBe("live");
    expect(browserProcessStatus(4242, {
      platform: "win32",
      signal: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
    })).toBe("dead");
  });
});

describe("verified browser launch journal", () => {
  it("durably advances the nonce-bound starting, host claim, ready, and committed phases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-launch-journal-"));
    const launchPath = join(directory, "launch.json");
    const metadataPath = join(directory, "browser.json");
    try {
      const starting = await launchJournal.createStartingLaunch(launchPath, process.pid, () => 100);
      const owner = launchJournal.claimBrowserLaunchOwnerSync(launchPath, starting.nonce as string, process.pid);
      launchJournal.publishClaimedLaunchSync(launchPath, owner, () => 110);
      const ready = launchJournal.publishReadyLaunchSync(launchPath, starting.nonce as string, process.pid, 49_321, () => 120);
      const metadata = {
        browserId: "browser-identity-1234",
        controlPort: 49_321,
        endpoint: "http://127.0.0.1:49322",
        launchNonce: starting.nonce,
        persistent: false,
        pid: process.pid,
        protocol: "prime-continuim.browser.v1",
      };
      await launchJournal.durableWrite(metadataPath, metadata);
      const committed = await launchJournal.commitBrowserLaunch(launchPath, ready, metadata, () => 130);
      expect(launchJournal.metadataMatchesCommitted(metadata, committed)).toBe(true);
      await expect(launchJournal.readLaunchEvidence(launchPath)).resolves.toMatchObject({
        status: "valid",
        record: { phase: "committed", nonce: starting.nonce, hostPid: process.pid },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("re-reads a journal replaced atomically between path inspection and open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-launch-replace-race-"));
    const launchPath = join(directory, "launch.json");
    const replacementPath = join(directory, "replacement.json");
    try {
      await writeFile(launchPath, `${JSON.stringify({ version: 1, phase: "old" })}\n`, { mode: 0o600 });
      const oldEntry = await lstat(launchPath);
      const replacement = { version: 1, phase: "ready" };
      await writeFile(replacementPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
      await rename(replacementPath, launchPath);
      let inspections = 0;

      await expect(launchJournal.readEvidence(
        launchPath,
        (value) => JSON.stringify(value) === JSON.stringify(replacement),
        {
          lstat: async (path) => {
            inspections += 1;
            return inspections === 1 ? oldEntry : lstat(path);
          },
          open,
        },
      )).resolves.toEqual({ status: "valid", record: replacement });
      expect(inspections).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("gives an atomic recovery owner priority over a paused late host claim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-claim-race-"));
    const launchPath = join(directory, "launch.json");
    try {
      const starting = await launchJournal.createStartingLaunch(launchPath, 101, () => 0);
      await expect(launchJournal.resolveStartingLaunch(launchPath, starting, {
        now: () => 20_001,
        processStatus: () => "dead",
      })).resolves.toBe("clean");
      expect(() => launchJournal.claimBrowserLaunchOwnerSync(
        launchPath,
        starting.nonce as string,
        202,
      )).toThrow("already claimed");

      const next = await launchJournal.createStartingLaunch(launchPath, 303, () => 0);
      const hostOwner = launchJournal.claimBrowserLaunchOwnerSync(launchPath, next.nonce as string, process.pid);
      await expect(launchJournal.resolveStartingLaunch(launchPath, next, {
        now: () => 20_001,
        processStatus: (pid) => pid === process.pid ? "live" : "dead",
      })).resolves.toBe("pending");
      expect(launchJournal.publishClaimedLaunchSync(launchPath, hostOwner, () => 20_002)).toMatchObject({
        phase: "claimed",
        hostPid: process.pid,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed while crash evidence is live and cleans only after exact owner death", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-launch-crash-"));
    const launchPath = join(directory, "launch.json");
    try {
      const starting = await launchJournal.createStartingLaunch(launchPath, 404, () => 0);
      await expect(launchJournal.resolveStartingLaunch(launchPath, starting, {
        now: () => 19_999,
        processStatus: () => "dead",
      })).resolves.toBe("pending");
      const owner = launchJournal.claimBrowserLaunchOwnerSync(launchPath, starting.nonce as string, 505);
      const claimed = launchJournal.publishClaimedLaunchSync(launchPath, owner, () => 20_000);
      expect(launchJournal.launchRecoveryDisposition(claimed, { processStatus: () => "live" })).toBe("pending");
      expect(launchJournal.launchRecoveryDisposition(claimed, { processStatus: () => "unknown" })).toBe("pending");
      expect(launchJournal.launchRecoveryDisposition(claimed, { processStatus: () => "dead" })).toBe("clean");
      const ready = launchJournal.publishReadyLaunchSync(launchPath, starting.nonce as string, 505, 49_323, () => 20_001);
      expect(launchJournal.launchRecoveryDisposition(ready, { processStatus: () => "live" })).toBe("active");
      expect(launchJournal.launchRecoveryDisposition(ready, { processStatus: () => "dead" })).toBe("clean");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps atomic file replacement on Windows while skipping unsupported directory fsync", async () => {
    await expect(launchJournal.syncDirectory("Z:\\missing-directory", "win32")).resolves.toBeUndefined();
    expect(() => launchJournal.syncDirectorySync("Z:\\missing-directory", "win32")).not.toThrow();
  });

  it("removes bounded dead host and recovery owner sidecars after launch retirement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-owner-cleanup-"));
    const launchPath = join(directory, "launch.json");
    try {
      const hostStarting = await launchJournal.createStartingLaunch(launchPath, 601, () => 0);
      launchJournal.claimBrowserLaunchOwnerSync(launchPath, hostStarting.nonce as string, 602);
      await launchJournal.durableRemove(launchPath);
      await expect(launchJournal.cleanupOrphanLaunchOwners(directory, {
        processStatus: () => "dead",
      })).resolves.toBe("clean");
      expect((await readdir(directory)).filter((entry) => entry.startsWith("launch.owner-"))).toEqual([]);

      const recoveryStarting = await launchJournal.createStartingLaunch(launchPath, 603, () => 0);
      await expect(launchJournal.resolveStartingLaunch(launchPath, recoveryStarting, {
        now: () => 20_001,
        processStatus: () => "dead",
      })).resolves.toBe("clean");
      await launchJournal.durableRemove(launchPath);
      await expect(launchJournal.cleanupOrphanLaunchOwners(directory, {
        processStatus: () => "unknown",
      })).resolves.toBe("clean");
      expect((await readdir(directory)).filter((entry) => entry.includes(".candidate-") || entry.startsWith("launch.owner-"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains malformed or live orphan owner evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-owner-retain-"));
    try {
      const malformed = join(directory, "launch.owner-11111111-1111-4111-8111-111111111111.json");
      await writeFile(malformed, "{malformed\n", { mode: 0o600 });
      await expect(launchJournal.cleanupOrphanLaunchOwners(directory, {
        processStatus: () => "dead",
      })).resolves.toBe("ambiguous");
      await rm(malformed);
      const launchPath = join(directory, "launch.json");
      const starting = await launchJournal.createStartingLaunch(launchPath, process.pid, () => 0);
      launchJournal.claimBrowserLaunchOwnerSync(launchPath, starting.nonce as string, process.pid);
      await launchJournal.durableRemove(launchPath);
      await expect(launchJournal.cleanupOrphanLaunchOwners(directory, {
        processStatus: () => "live",
      })).resolves.toBe("pending");
      expect((await readdir(directory)).some((entry) => entry.startsWith("launch.owner-"))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cleans a dead committed host after metadata removal plus profile-only state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-dead-commit-recovery-"));
    const launchPath = join(directory, "launch.json");
    const metadataPath = join(directory, "browser.json");
    const profileDirectory = join(directory, "profile");
    const nonce = "33333333-3333-4333-8333-333333333333";
    const deadPid = 2_147_483_647;
    try {
      await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
      await writeFile(join(profileDirectory, "cookie-state"), "private", { mode: 0o600 });
      const committed = {
        bridgePid: deadPid,
        browserId: "browser-dead-identity",
        committedAt: 30,
        controlPort: 49_330,
        createdAt: 10,
        endpoint: "http://127.0.0.1:49331",
        hostPid: deadPid,
        nonce,
        phase: "committed",
        protocol: "prime-continuim.browser.v1",
        readyAt: 20,
      };
      await writeFile(launchPath, `${JSON.stringify(committed)}\n`, { mode: 0o600 });
      await writeFile(join(directory, `launch.owner-${nonce}.json`), `${JSON.stringify({
        kind: "host",
        nonce,
        pid: deadPid,
        protocol: "prime-continuim.browser.v1",
        token: "44444444-4444-4444-8444-444444444444",
      })}\n`, { mode: 0o600 });
      const cleanDisposition = launchJournal.launchRecoveryDisposition(committed, {
        processStatus: () => "dead",
      });
      expect(launchJournal.browserMetadataRecoveryDisposition(committed, undefined, cleanDisposition)).toBe("clean");
      expect(launchJournal.browserMetadataRecoveryDisposition(committed, undefined, "active")).toBe("ambiguous");
      await expect(launchJournal.cleanupRetiredBrowserState({
        directory,
        launchPath,
        metadataPath,
        profileDirectory,
      }, {
        processStatus: () => "dead",
        removeProfile: true,
      })).resolves.toBe("clean");
      await expect(readFile(launchPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(directory, `launch.owner-${nonce}.json`))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(profileDirectory)).rejects.toMatchObject({ code: "ENOENT" });

      await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
      await writeFile(join(profileDirectory, "profile-only"), "private", { mode: 0o600 });
      await expect(launchJournal.cleanupRetiredBrowserState({
        directory,
        launchPath,
        metadataPath,
        profileDirectory,
      }, {
        processStatus: () => "unknown",
        removeProfile: true,
      })).resolves.toBe("clean");
      await expect(readdir(profileDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("classifies malformed launch evidence without deleting its profile", async () => {
    const sessionDirectory = await mkdtemp(join(tmpdir(), "prime-browser-malformed-recovery-"));
    try {
      await mkdir(join(sessionDirectory, "profile"), { recursive: true, mode: 0o700 });
      await writeFile(join(sessionDirectory, "profile", "cookie-state"), "private", { mode: 0o600 });
      await writeFile(join(sessionDirectory, "launch.json"), "{malformed\n", { mode: 0o600 });
      await expect(launchJournal.readLaunchEvidence(join(sessionDirectory, "launch.json"))).resolves.toEqual({
        status: "malformed",
      });
      await expect(readFile(join(sessionDirectory, "launch.json"), "utf8")).resolves.toBe("{malformed\n");
      await expect(readFile(join(sessionDirectory, "profile", "cookie-state"), "utf8")).resolves.toBe("private");
    } finally {
      await rm(sessionDirectory, { recursive: true, force: true });
    }
  });
});

describe("verified browser session serialization", () => {
  const operationToken = "11111111-1111-4111-8111-111111111111";
  const reclaimToken = "22222222-2222-4222-8222-222222222222";
  const operationRecord = (pid: number, token = operationToken) => `${JSON.stringify({
    kind: "operation",
    protocol: "prime-continuim.browser.v1",
    pid,
    token,
  })}\n`;
  const reclaimRecord = (pid: number, token = reclaimToken) => `${JSON.stringify({
    kind: "reclaim",
    operationToken,
    protocol: "prime-continuim.browser.v1",
    pid,
    token,
  })}\n`;

  it("rejects a concurrent open for the same exact session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-lock-"));
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const actionEntered = new Promise<void>((resolve) => { entered = resolve; });
    let first: Promise<void> | undefined;
    try {
      first = withBrowserSessionLock(directory, async () => {
        entered();
        await held;
      });
      await actionEntered;
      const contenders = await Promise.allSettled([
        withBrowserSessionLock(directory, async () => "close"),
        withBrowserSessionLock(directory, async () => "reopen"),
      ]);
      expect(contenders).toHaveLength(2);
      for (const contender of contenders) {
        expect(contender.status).toBe("rejected");
        if (contender.status === "rejected") {
          expect(contender.reason).toMatchObject({ code: "SESSION_BUSY" });
        }
      }
      release();
      await first;
    } finally {
      release();
      await first?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps an old lock busy while its recorded owner is live", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-live-lock-"));
    const lockPath = join(directory, "operation.lock");
    try {
      await writeFile(lockPath, operationRecord(process.pid), { mode: 0o600 });
      await utimes(lockPath, new Date(0), new Date(0));
      await expect(withBrowserSessionLock(directory, async () => "overlap"))
        .rejects.toMatchObject({ code: "SESSION_BUSY" });
      expect(await readFile(lockPath, "utf8")).toContain(`"pid":${process.pid}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a fresh dead lock busy by default and reclaims it only with zero grace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-fresh-dead-lock-"));
    const lockPath = join(directory, "operation.lock");
    try {
      await writeFile(lockPath, operationRecord(2_147_483_647), { mode: 0o600 });
      const freshMtimeMs = (await lstat(lockPath)).mtimeMs;
      const ownerStatus = () => "dead" as const;
      await expect(withBrowserSessionLock(directory, async () => "too-early", {
        now: () => freshMtimeMs,
        ownerStatus,
      })).rejects.toMatchObject({ code: "SESSION_BUSY" });
      await expect(readFile(lockPath, "utf8")).resolves.toContain('"kind":"operation"');

      await expect(withBrowserSessionLock(directory, async () => "recovered", {
        deadOwnerGraceMs: 0,
        now: () => freshMtimeMs,
        ownerStatus,
      })).resolves.toBe("recovered");
      await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(directory)).filter((entry) => entry.startsWith("operation.lock.reclaim-"))).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["live", "unknown"] as const)("never reclaims a fresh %s owner with zero grace", async (status) => {
    const directory = await mkdtemp(join(tmpdir(), `prime-browser-fresh-${status}-lock-`));
    const lockPath = join(directory, "operation.lock");
    try {
      await writeFile(lockPath, operationRecord(2_147_483_647), { mode: 0o600 });
      const freshMtimeMs = (await lstat(lockPath)).mtimeMs;
      await expect(withBrowserSessionLock(directory, async () => "unsafe", {
        deadOwnerGraceMs: 0,
        now: () => freshMtimeMs,
        ownerStatus: () => status,
      })).rejects.toMatchObject({ code: "SESSION_BUSY" });
      await expect(readFile(lockPath, "utf8")).resolves.toContain('"kind":"operation"');
      expect((await readdir(directory)).filter((entry) => entry.startsWith("operation.lock.reclaim-"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([-1, 120_001, 0.5, Number.NaN])("rejects an unbounded dead-owner grace: %s", async (deadOwnerGraceMs) => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-invalid-dead-grace-"));
    try {
      await expect(withBrowserSessionLock(directory, async () => "invalid", { deadOwnerGraceMs }))
        .rejects.toThrow("Browser dead-owner grace must be a bounded integer");
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reclaims an old lock only when its bounded owner is provably dead", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-dead-lock-"));
    const lockPath = join(directory, "operation.lock");
    try {
      await writeFile(lockPath, operationRecord(2_147_483_647), { mode: 0o600 });
      await utimes(lockPath, new Date(0), new Date(0));
      await expect(withBrowserSessionLock(directory, async () => "recovered", {
        ownerStatus: () => "dead",
      })).resolves.toBe("recovered");
      await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed, aliased, or permission-unknown old locks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-unsafe-lock-"));
    const lockPath = join(directory, "operation.lock");
    try {
      await writeFile(lockPath, "{malformed\n", { mode: 0o600 });
      await utimes(lockPath, new Date(0), new Date(0));
      await expect(withBrowserSessionLock(directory, async () => undefined, {
        ownerStatus: () => "dead",
      })).rejects.toMatchObject({ code: "SESSION_BUSY" });

      await rm(lockPath);
      const aliased = join(directory, "aliased-lock");
      await writeFile(aliased, operationRecord(123), { mode: 0o600 });
      await link(aliased, lockPath);
      await utimes(lockPath, new Date(0), new Date(0));
      await expect(withBrowserSessionLock(directory, async () => undefined, {
        ownerStatus: () => "dead",
      })).rejects.toMatchObject({ code: "SESSION_BUSY" });
      expect(await readFile(aliased, "utf8")).toContain('"pid":123');

      await rm(lockPath);
      await rm(aliased);
      await writeFile(lockPath, operationRecord(456), { mode: 0o600 });
      await utimes(lockPath, new Date(0), new Date(0));
      await expect(withBrowserSessionLock(directory, async () => undefined, {
        ownerStatus: () => "unknown",
      })).rejects.toMatchObject({ code: "SESSION_BUSY" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows exactly one recovery owner when two reclaimers race", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-reclaim-race-"));
    const lockPath = join(directory, "operation.lock");
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const actionEntered = new Promise<void>((resolve) => { entered = resolve; });
    let actionCount = 0;
    try {
      await writeFile(lockPath, operationRecord(987_654), { mode: 0o600 });
      await utimes(lockPath, new Date(0), new Date(0));
      const ownerStatus = (pid: number) => pid === 987_654 ? "dead" as const : "live" as const;
      const contender = (label: string) => withBrowserSessionLock(directory, async () => {
        actionCount += 1;
        entered();
        await held;
        return label;
      }, { ownerStatus });
      const resultsPromise = Promise.allSettled([contender("first"), contender("second")]);
      await actionEntered;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(actionCount).toBe(1);
      release();
      const results = await resultsPromise;
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toEqual([
        expect.objectContaining({ reason: expect.objectContaining({ code: "SESSION_BUSY" }) }),
      ]);
      const claims = (await readdir(directory)).filter((entry) => entry.startsWith("operation.lock.reclaim-"));
      expect(claims).toHaveLength(1);
    } finally {
      release();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers after a prior reclaimer crashes without deleting a later live claim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-browser-dead-reclaimer-"));
    const lockPath = join(directory, "operation.lock");
    const deadClaim = join(directory, `operation.lock.reclaim-${operationToken}-000.json`);
    try {
      await writeFile(lockPath, operationRecord(101), { mode: 0o600 });
      await utimes(lockPath, new Date(0), new Date(0));
      await writeFile(deadClaim, reclaimRecord(202), { mode: 0o600 });
      await expect(withBrowserSessionLock(directory, async () => "recovered", {
        ownerStatus: (pid) => pid === process.pid ? "live" : "dead",
      })).resolves.toBe("recovered");
      const claims = (await readdir(directory)).filter((entry) => entry.startsWith("operation.lock.reclaim-"));
      expect(claims.sort()).toEqual([
        `operation.lock.reclaim-${operationToken}-000.json`,
        `operation.lock.reclaim-${operationToken}-001.json`,
      ]);
      expect(await readFile(deadClaim, "utf8")).toBe(reclaimRecord(202));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("verified browser resident authority", () => {
  it("uses different state keys for two resident bindings in the same workspace and CLI session", () => {
    const first = browserSessionStateKeys("/workspace", "default", "active-resident-a");
    const second = browserSessionStateKeys("/workspace", "default", "active-resident-b");
    expect(first.sessionKey).toBe(second.sessionKey);
    expect(first.authorityKey).not.toBe(second.authorityKey);
    expect(residentBrowserAuthority({
      PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: "active-resident-a",
    })).toBe("active-resident-a");
    expect(() => residentBrowserAuthority({})).toThrow();
  });
});

describe("verified browser recovery evidence", () => {
  it("retains evidence on a live close failure, then removes it only after a proven retry", async () => {
    let metadataPresent = true;
    let profilePresent = true;
    let closeFails = true;
    const retire = () => retireBrowserEvidence({
      metadata: { pid: 42 },
      closeEndpoint: async () => {
        if (closeFails) throw new Error("transient close failure");
      },
      processAlive: () => true,
      removeMetadata: async () => { metadataPresent = false; },
      removeProfile: async () => { profilePresent = false; },
    });

    await expect(retire()).rejects.toThrow("transient close failure");
    expect({ metadataPresent, profilePresent }).toEqual({ metadataPresent: true, profilePresent: true });
    closeFails = false;
    await expect(retire()).resolves.toBeUndefined();
    expect({ metadataPresent, profilePresent }).toEqual({ metadataPresent: false, profilePresent: false });
  });
});
