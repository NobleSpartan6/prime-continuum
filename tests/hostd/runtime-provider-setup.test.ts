import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MacOSRuntimeProviderSetupHandoff,
  buildMacOSRuntimeProviderSetupCommand,
  runMacOSRuntimeProviderSetupOpen,
  sanitizeRuntimeProviderSetupEnvironment,
} from "../../src/hostd/runtime-provider-setup";
import type { VerifiedInstalledRuntimeHandle } from "../../src/hostd/runtime-integrity-manager";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  ));
});

describe("macOS Prime Agent provider setup handoff", () => {
  it("builds one fixed interactive invocation without provider, login, or ambient role input", () => {
    const command = buildMacOSRuntimeProviderSetupCommand({
      executable: "/verified/node",
      cliEntrypoint: "/verified/cli.js",
      agentDirectory: "/private/prime-agent",
      handshakePath: "/private/prime-agent/status",
      commandPath: "/private/prime-agent/Open Prime Agent.command",
      nonce: "nonce-one",
    });

    expect(command).toContain("--no-session");
    expect(command).toContain("--no-context-files");
    expect(command).toContain("/verified/node");
    expect(command).toContain("/verified/cli.js");
    expect(command).not.toContain("/login");
    expect(command).not.toContain("anthropic");
    expect(command).not.toContain("--provider");

    expect(sanitizeRuntimeProviderSetupEnvironment({
      HOME: "/Users/operator",
      LANG: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "secret",
      NODE_OPTIONS: "--require attacker",
      PRIME_AGENT_INTERNAL_DAEMON_SOCKET: "/private/socket",
    })).toEqual({ HOME: "/Users/operator", LANG: "en_US.UTF-8" });
  });

  it("runs the fixed helper with injection variables removed and the exact interactive flags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-provider-helper-"));
    temporaryDirectories.push(directory);
    const cli = join(directory, "fixture-cli.mjs");
    const marker = join(directory, "fixture-result.json");
    const handshake = join(directory, "launch.status");
    const commandPath = join(directory, "Open Prime Agent.command");
    await writeFile(cli, [
      'import { writeFile } from "node:fs/promises";',
      `await writeFile(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), nodeOptions: process.env.NODE_OPTIONS ?? null, providerValue: process.env.FIXTURE_PROVIDER_KEY ?? null }));`,
    ].join("\n"), { mode: 0o600 });
    await writeFile(commandPath, buildMacOSRuntimeProviderSetupCommand({
      executable: process.execPath,
      cliEntrypoint: cli,
      agentDirectory: directory,
      handshakePath: handshake,
      commandPath,
      nonce: "fixture-nonce",
    }), { mode: 0o700 });

    const child = spawn("/bin/sh", [commandPath], {
      cwd: directory,
      env: {
        ...process.env,
        NODE_OPTIONS: "--require=/definitely/not/present.js",
        PRIME_AGENT_INTERNAL_DAEMON_SOCKET: "/private/wrong.sock",
        FIXTURE_PROVIDER_KEY: "fixture-secret",
      },
      stdio: "ignore",
    });
    const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    expect(code).toBe(0);
    expect(await readFile(handshake, "utf8")).toBe("started:fixture-nonce");
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
      argv: ["--no-session", "--cwd", directory, "--no-context-files"],
      nodeOptions: null,
      providerValue: "fixture-secret",
    });
  });

  it("returns opened only after the verified CLI child publishes the one-use handshake", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-provider-handoff-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const runOpen = vi.fn(async ({ commandPath }: { commandPath: string }) => {
      const command = await readFile(commandPath, "utf8");
      const quoted = [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
      const [handshakePath, _selfPath, nonce] = quoted.slice(-3);
      await writeFile(handshakePath!, `started:${nonce}`, { flag: "wx", mode: 0o600 });
      return "accepted" as const;
    });
    const handoff = new MacOSRuntimeProviderSetupHandoff({
      platform: "darwin",
      systemOpen: "/bin/sh",
      agentDirectory: directory,
      runtimeHandles: {
        acquireVerifiedRuntimeHandle: vi.fn(async () => runtimeHandle("0.7.2")),
      },
      credentialSecurity: {
        prepareAndVerify: vi.fn(async () => undefined),
        assertStillSecure: vi.fn(async () => undefined),
        capabilityAvailable: () => true,
      },
      runOpen: runOpen as never,
      sleep: async () => undefined,
    });

    await expect(handoff.open({
      expectedHostId: "host-local",
      providerId: "anthropic",
      expectedReleaseVersion: "0.7.2",
    })).resolves.toEqual({
      resultVersion: 1,
      state: "opened",
      expectedHostId: "host-local",
      providerId: "anthropic",
      releaseVersion: "0.7.2",
    });
    expect(runOpen).toHaveBeenCalledOnce();
    const invocation = runOpen.mock.calls[0]![0] as { commandPath: string };
    expect(await readFile(invocation.commandPath, "utf8").catch(() => "removed")).toBe("removed");
  });

  it("waits through an exact-owned empty handshake instead of inventing a retryable failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-provider-handoff-partial-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    let handshakePath = "";
    let nonce = "";
    const runOpen = vi.fn(async ({ commandPath }: { commandPath: string }) => {
      const command = await readFile(commandPath, "utf8");
      const quoted = [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
      [handshakePath, , nonce] = quoted.slice(-3) as [string, string, string];
      await writeFile(handshakePath, "", { flag: "wx", mode: 0o600 });
      return "accepted" as const;
    });
    const sleep = vi.fn(async () => {
      await writeFile(handshakePath, `started:${nonce}`, { flag: "w", mode: 0o600 });
    });
    const handoff = new MacOSRuntimeProviderSetupHandoff({
      platform: "darwin",
      systemOpen: "/bin/sh",
      agentDirectory: directory,
      runtimeHandles: {
        acquireVerifiedRuntimeHandle: vi.fn(async () => runtimeHandle("0.7.2")),
      },
      credentialSecurity: {
        prepareAndVerify: vi.fn(async () => undefined),
        assertStillSecure: vi.fn(async () => undefined),
        capabilityAvailable: () => true,
      },
      runOpen: runOpen as never,
      sleep,
    });

    await expect(handoff.open({
      expectedHostId: "host-local",
      providerId: "anthropic",
      expectedReleaseVersion: "0.7.2",
    })).resolves.toMatchObject({ state: "opened" });
    expect(sleep).toHaveBeenCalled();
  });

  it("treats output overflow after the system tool starts as indeterminate", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new (await import("node:events")).EventEmitter(), {
      stdout,
      stderr,
      kill: vi.fn(() => true),
    });
    const result = runMacOSRuntimeProviderSetupOpen({
      executable: "/usr/bin/open",
      commandPath: "/private/Open Prime Agent.command",
      environment: {},
      signal: new AbortController().signal,
      spawn: vi.fn(() => child) as never,
    });
    stdout.write(Buffer.alloc(32 * 1024 + 1));

    await expect(result).resolves.toBe("indeterminate");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects runtime release drift before creating a Terminal effect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-provider-handoff-drift-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const runOpen = vi.fn();
    const handoff = new MacOSRuntimeProviderSetupHandoff({
      platform: "darwin",
      systemOpen: "/bin/sh",
      agentDirectory: directory,
      runtimeHandles: {
        acquireVerifiedRuntimeHandle: vi.fn(async () => runtimeHandle("0.7.1")),
      },
      credentialSecurity: {
        prepareAndVerify: vi.fn(async () => undefined),
        assertStillSecure: vi.fn(async () => undefined),
        capabilityAvailable: () => true,
      },
      runOpen: runOpen as never,
    });

    await expect(handoff.open({
      expectedHostId: "host-local",
      providerId: "anthropic",
      expectedReleaseVersion: "0.7.2",
    })).resolves.toMatchObject({ state: "failed_before_launch", releaseVersion: "0.7.2" });
    expect(runOpen).not.toHaveBeenCalled();
  });
});

function runtimeHandle(releaseVersion: string): VerifiedInstalledRuntimeHandle {
  return {
    identity: { releaseVersion },
    executable: "/verified/node",
    cliEntrypoint: "/verified/cli.js",
  } as unknown as VerifiedInstalledRuntimeHandle;
}
