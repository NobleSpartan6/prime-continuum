import { randomUUID } from "node:crypto";
import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { lstat, mkdir, open as openFile, readFile, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { RuntimeProviderSetupResult } from "../shared/protocol";
import type { PrimeAgentRuntimeSecurityGate } from "./prime-agent-auth-security";
import type { VerifiedRuntimeHandleProvider } from "./runtime-model-catalog";

const SYSTEM_OPEN = "/usr/bin/open";
const OPEN_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 12_000;
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;
const POLL_INTERVAL_MS = 50;

export interface RuntimeProviderSetupInput {
  readonly expectedHostId: string;
  readonly providerId: string;
  readonly expectedReleaseVersion: string;
}

export interface RuntimeProviderSetupHandoff {
  capabilityReady(): Promise<boolean>;
  open(input: RuntimeProviderSetupInput): Promise<RuntimeProviderSetupResult>;
  close?(): Promise<void>;
}

export interface MacOSRuntimeProviderSetupHandoffOptions {
  readonly runtimeHandles: VerifiedRuntimeHandleProvider;
  readonly credentialSecurity: PrimeAgentRuntimeSecurityGate;
  readonly agentDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly systemOpen?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly runOpen?: typeof runMacOSRuntimeProviderSetupOpen;
  readonly verifySystemOpen?: (path: string) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class RuntimeProviderSetupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeProviderSetupError";
  }
}

/**
 * Trusted-local handoff into Prime Agent's own interactive TUI.
 *
 * Provider identity is used only for admission/result correlation. It never
 * enters a filename, environment variable, script, or process argument.
 */
export class MacOSRuntimeProviderSetupHandoff implements RuntimeProviderSetupHandoff {
  private readonly runtimeHandles: VerifiedRuntimeHandleProvider;
  private readonly credentialSecurity: PrimeAgentRuntimeSecurityGate;
  private readonly agentDirectory: string;
  private readonly platform: NodeJS.Platform;
  private readonly systemOpen: string;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly runOpen: typeof runMacOSRuntimeProviderSetupOpen;
  private readonly verifySystemOpen: (path: string) => Promise<void>;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private active:
    | { readonly controller: AbortController; readonly result: Promise<RuntimeProviderSetupResult> }
    | undefined;
  private closed = false;

  constructor(options: MacOSRuntimeProviderSetupHandoffOptions) {
    this.runtimeHandles = options.runtimeHandles;
    this.credentialSecurity = options.credentialSecurity;
    this.agentDirectory = boundedAbsolutePath(options.agentDirectory, "Prime Agent profile");
    this.platform = options.platform ?? process.platform;
    this.systemOpen = boundedAbsolutePath(options.systemOpen ?? SYSTEM_OPEN, "macOS open tool");
    this.environment = options.environment ?? process.env;
    this.runOpen = options.runOpen ?? runMacOSRuntimeProviderSetupOpen;
    this.verifySystemOpen = options.verifySystemOpen ?? assertRootOwnedExecutable;
    this.sleep = options.sleep ?? delay;
  }

  async capabilityReady(): Promise<boolean> {
    if (
      this.closed ||
      this.platform !== "darwin" ||
      this.credentialSecurity.capabilityAvailable?.() === false
    ) return false;
    try {
      await this.verifySystemOpen(this.systemOpen);
      return true;
    } catch {
      return false;
    }
  }

  open(input: RuntimeProviderSetupInput): Promise<RuntimeProviderSetupResult> {
    if (this.closed) {
      return Promise.reject(new RuntimeProviderSetupError("Prime Agent account setup is closed"));
    }
    if (this.active) {
      return Promise.reject(new RuntimeProviderSetupError("Prime Agent account setup is already active"));
    }
    const controller = new AbortController();
    const result = this.openOnce(input, controller.signal);
    const active = Object.freeze({ controller, result });
    this.active = active;
    void result.finally(() => {
      if (this.active === active) this.active = undefined;
    }).catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    await active.result;
  }

  private async openOnce(
    input: RuntimeProviderSetupInput,
    signal: AbortSignal,
  ): Promise<RuntimeProviderSetupResult> {
    const authority = boundedProviderSetupInput(input);
    const base = {
      resultVersion: 1 as const,
      expectedHostId: authority.expectedHostId,
      providerId: authority.providerId,
      releaseVersion: authority.expectedReleaseVersion,
    };
    let artifacts: ProviderSetupArtifacts | undefined;
    let effectAccepted = false;
    try {
      if (this.platform !== "darwin") return { ...base, state: "failed_before_launch" };
      await this.verifySystemOpen(this.systemOpen);
      await this.credentialSecurity.assertStillSecure({ force: true });
      const handle = await this.runtimeHandles.acquireVerifiedRuntimeHandle();
      if (handle.identity.releaseVersion !== authority.expectedReleaseVersion) {
        return { ...base, state: "failed_before_launch" };
      }
      const executable = boundedAbsolutePath(handle.executable, "verified runtime executable");
      const cliEntrypoint = boundedAbsolutePath(handle.cliEntrypoint, "verified Prime Agent CLI");
      artifacts = await createProviderSetupArtifacts({
        agentDirectory: this.agentDirectory,
        executable,
        cliEntrypoint,
      });
      await this.credentialSecurity.assertStillSecure({ force: true });
      if (signal.aborted) return { ...base, state: "failed_before_launch" };

      const openOutcome = await this.runOpen({
        executable: this.systemOpen,
        commandPath: artifacts.commandPath,
        environment: this.environment,
        signal,
      });
      effectAccepted = openOutcome === "accepted";
      if (openOutcome === "rejected") {
        await cleanupProviderSetupArtifacts(artifacts);
        return { ...base, state: "failed_before_launch" };
      }
      if (openOutcome === "indeterminate") return { ...base, state: "indeterminate" };

      const handshake = await waitForProviderSetupHandshake(artifacts, signal, this.sleep);
      if (handshake === "started") {
        await cleanupProviderSetupArtifacts(artifacts);
        return { ...base, state: "opened" };
      }
      if (handshake === "failed") {
        await cleanupProviderSetupArtifacts(artifacts);
        return { ...base, state: "failed_before_launch" };
      }
      return { ...base, state: "indeterminate" };
    } catch (error) {
      if (!effectAccepted && artifacts) await cleanupProviderSetupArtifacts(artifacts).catch(() => undefined);
      if (effectAccepted || signal.aborted) return { ...base, state: "indeterminate" };
      if (error instanceof RuntimeProviderSetupError) return { ...base, state: "failed_before_launch" };
      return { ...base, state: "failed_before_launch" };
    }
  }
}

interface ProviderSetupArtifacts {
  readonly directory: string;
  readonly commandPath: string;
  readonly commandIdentity: FileIdentity;
  readonly handshakePath: string;
  readonly nonce: string;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export function buildMacOSRuntimeProviderSetupCommand(input: {
  readonly executable: string;
  readonly cliEntrypoint: string;
  readonly agentDirectory: string;
  readonly handshakePath: string;
  readonly commandPath: string;
  readonly nonce: string;
}): string {
  const executable = boundedAbsolutePath(input.executable, "verified runtime executable");
  const cliEntrypoint = boundedAbsolutePath(input.cliEntrypoint, "verified Prime Agent CLI");
  const agentDirectory = boundedAbsolutePath(input.agentDirectory, "Prime Agent profile");
  const handshakePath = boundedAbsolutePath(input.handshakePath, "provider setup handshake");
  const commandPath = boundedAbsolutePath(input.commandPath, "provider setup command");
  const nonce = boundedToken(input.nonce, "provider setup nonce");
  return [
    "#!/bin/sh",
    "unset NODE_OPTIONS NODE_PATH NODE_DEBUG NODE_DEBUG_NATIVE NODE_INSPECT_RESUME_ON_START NAPI_RS_NATIVE_LIBRARY_PATH ELECTRON_RENDERER_URL ELECTRON_ENABLE_LOGGING ELECTRON_ENABLE_STACK_DUMPING PRIME_AGENT_BUILD_ID PRIME_AGENT_LAUNCHER_PATH",
    "exec " + [
      executable,
      "--input-type=module",
      "--eval",
      PROVIDER_SETUP_HELPER_SOURCE,
      "--",
      cliEntrypoint,
      agentDirectory,
      handshakePath,
      commandPath,
      nonce,
    ].map(shellQuote).join(" "),
    "",
  ].join("\n");
}

export function sanitizeRuntimeProviderSetupEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> {
  const allowed = new Set(["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]);
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !allowed.has(key.toUpperCase())) continue;
    if (/[^A-Za-z0-9_]/.test(key) || /\0/.test(value) || value.length > 4_096) {
      throw new RuntimeProviderSetupError("macOS account setup environment is invalid");
    }
    output[key] = value;
  }
  return Object.freeze(output);
}

export async function runMacOSRuntimeProviderSetupOpen(input: {
  readonly executable: string;
  readonly commandPath: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly signal: AbortSignal;
  readonly spawn?: typeof spawnChildProcess;
  readonly timeoutMs?: number;
}): Promise<"accepted" | "rejected" | "indeterminate"> {
  const executable = boundedAbsolutePath(input.executable, "macOS open tool");
  const commandPath = boundedAbsolutePath(input.commandPath, "provider setup command");
  const spawn = input.spawn ?? spawnChildProcess;
  const timeoutMs = input.timeoutMs ?? OPEN_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new RuntimeProviderSetupError("macOS account setup timeout is invalid");
  }
  return await new Promise((resolveOutcome) => {
    let settled = false;
    let outputBytes = 0;
    let child: ChildProcess;
    const settle = (outcome: "accepted" | "rejected" | "indeterminate"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      resolveOutcome(outcome);
    };
    const onAbort = (): void => {
      child?.kill("SIGTERM");
      settle("indeterminate");
    };
    const timer = setTimeout(() => {
      child?.kill("SIGTERM");
      settle("indeterminate");
    }, timeoutMs);
    timer.unref?.();
    try {
      child = spawn(executable, ["-b", "com.apple.Terminal", commandPath], {
        shell: false,
        windowsHide: true,
        cwd: dirname(commandPath),
        env: sanitizeRuntimeProviderSetupEnvironment(input.environment),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      settle("rejected");
      return;
    }
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    const observeOutput = (chunk: Buffer | string): void => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_TOOL_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        // The system tool may already have handed the command to Terminal.
        // Once it has spawned, output overflow cannot prove a pre-effect failure.
        settle("indeterminate");
      }
    };
    child.stdout?.on("data", observeOutput);
    child.stderr?.on("data", observeOutput);
    child.once("error", () => settle("rejected"));
    child.once("exit", (code, signal) => {
      settle(code === 0 && signal === null ? "accepted" : "rejected");
    });
  });
}

async function createProviderSetupArtifacts(input: {
  readonly agentDirectory: string;
  readonly executable: string;
  readonly cliEntrypoint: string;
}): Promise<ProviderSetupArtifacts> {
  const directory = join(input.agentDirectory, `.continuim-provider-setup-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const nonce = randomUUID();
  const commandPath = join(directory, "Open Prime Agent.command");
  const handshakePath = join(directory, "launch.status");
  const command = buildMacOSRuntimeProviderSetupCommand({
    executable: input.executable,
    cliEntrypoint: input.cliEntrypoint,
    agentDirectory: input.agentDirectory,
    handshakePath,
    commandPath,
    nonce,
  });
  const handle = await openFile(commandPath, "wx", 0o700);
  try {
    await handle.writeFile(command, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const metadata = await lstat(commandPath, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    (metadata.mode & 0o777n) !== 0o700n
  ) {
    throw new RuntimeProviderSetupError("Private account setup command identity is invalid");
  }
  return Object.freeze({
    directory,
    commandPath,
    commandIdentity: { dev: metadata.dev, ino: metadata.ino },
    handshakePath,
    nonce,
  });
}

async function waitForProviderSetupHandshake(
  artifacts: ProviderSetupArtifacts,
  signal: AbortSignal,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<"started" | "failed" | "indeterminate"> {
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const metadata = await lstat(artifacts.handshakePath, { bigint: true });
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1n ||
        metadata.size > 128n ||
        (metadata.mode & 0o777n) !== 0o600n ||
        (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
      ) return "indeterminate";
      // Older helpers exposed the final file between open and write. Treat an
      // exact-owned empty file as transitional, never as evidence for retry.
      if (metadata.size === 0n) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const value = (await readFile(artifacts.handshakePath, "utf8")).trim();
      const current = await lstat(artifacts.handshakePath, { bigint: true });
      if (current.dev !== metadata.dev || current.ino !== metadata.ino) return "indeterminate";
      if (value === `started:${artifacts.nonce}`) return "started";
      if (value === `failed:${artifacts.nonce}`) return "failed";
      return "indeterminate";
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) return "indeterminate";
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return "indeterminate";
}

async function cleanupProviderSetupArtifacts(artifacts: ProviderSetupArtifacts): Promise<void> {
  await unlinkIfExact(artifacts.commandPath, artifacts.commandIdentity);
  try {
    const status = await lstat(artifacts.handshakePath, { bigint: true });
    if (status.isFile() && !status.isSymbolicLink() && status.nlink === 1n) {
      await unlinkIfExact(artifacts.handshakePath, { dev: status.dev, ino: status.ino });
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  try {
    await rmdir(artifacts.directory);
  } catch (error) {
    if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY")) throw error;
  }
}

async function unlinkIfExact(path: string, expected: FileIdentity): Promise<void> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (
      metadata.dev !== expected.dev ||
      metadata.ino !== expected.ino ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1n
    ) return;
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function assertRootOwnedExecutable(path: string): Promise<void> {
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0n ||
    metadata.nlink !== 1n ||
    (metadata.mode & 0o022n) !== 0n ||
    (metadata.mode & 0o111n) === 0n
  ) {
    throw new RuntimeProviderSetupError("The reviewed macOS open tool is unavailable");
  }
}

function boundedProviderSetupInput(input: RuntimeProviderSetupInput): RuntimeProviderSetupInput {
  return Object.freeze({
    expectedHostId: boundedToken(input.expectedHostId, "host identity"),
    providerId: boundedToken(input.providerId, "provider identity"),
    expectedReleaseVersion: boundedToken(input.expectedReleaseVersion, "runtime release"),
  });
}

function boundedToken(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    /[\0\r\n]/.test(value)
  ) throw new RuntimeProviderSetupError(`${label} is invalid`);
  return value;
}

function boundedAbsolutePath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    /[\0\r\n]/.test(value) ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) throw new RuntimeProviderSetupError(`${label} is invalid`);
  return value;
}

function shellQuote(value: string): string {
  if (/\0/.test(value)) throw new RuntimeProviderSetupError("Provider setup argument is invalid");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    timer.unref?.();
  });
}

const PROVIDER_SETUP_HELPER_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { open, rename, unlink } from "node:fs/promises";
const [cli, profile, handshake, commandPath, nonce] = process.argv.slice(1);
void unlink(commandPath).catch(() => undefined);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  const normalized = key.toUpperCase();
  if (normalized === "NODE_OPTIONS" || normalized === "NODE_PATH" || normalized === "NODE_DEBUG" ||
      normalized === "NODE_DEBUG_NATIVE" || normalized === "NODE_INSPECT_RESUME_ON_START" ||
      normalized === "NAPI_RS_NATIVE_LIBRARY_PATH" || normalized === "ELECTRON_RENDERER_URL" ||
      normalized === "ELECTRON_ENABLE_LOGGING" || normalized === "ELECTRON_ENABLE_STACK_DUMPING" ||
      normalized.startsWith("PRIME_AGENT_INTERNAL_") || normalized === "PRIME_AGENT_BUILD_ID" ||
      normalized === "PRIME_AGENT_LAUNCHER_PATH") delete env[key];
}
env.ELECTRON_RUN_AS_NODE = "1";
env.PRIME_AGENT_CODING_AGENT_DIR = profile;
const writeStatus = async (state) => {
  const temporary = handshake + "." + nonce + ".tmp";
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(state + ":" + nonce, "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, handshake);
  } catch {}
  finally { await unlink(temporary).catch(() => undefined); }
};
let child;
try {
  child = spawn(process.execPath, [cli, "--no-session", "--cwd", profile, "--no-context-files"], {
    cwd: profile, env, shell: false, stdio: "inherit"
  });
} catch {
  await writeStatus("failed");
  process.exit(1);
}
child.once("spawn", () => void writeStatus("started"));
child.once("error", () => void writeStatus("failed"));
child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`;
