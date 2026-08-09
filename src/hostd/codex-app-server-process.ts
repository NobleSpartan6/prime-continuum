import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createCodexAppServerEnvironment } from "../../scripts/codex-app-server-policy-lib.mjs";
import type { CodexAppServerTransport } from "./codex-app-server-client";
import type { CodexHomeSecurityProof } from "./codex-home-security";
import type { VerifiedCodexAppServerLaunchDescriptor } from "./runtime-integrity-manager";

declare const __PRIME_CONTINUIM_WINDOWS_JOB_SUPERVISOR__: string | undefined;

const MAX_BUFFERED_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_TIMEOUT_MS = 10_000;

export interface CodexAppServerProcessLauncher {
  launch(
    descriptor: VerifiedCodexAppServerLaunchDescriptor,
    home: CodexHomeSecurityProof,
  ): Promise<CodexAppServerTransport>;
}

export interface WindowsJobCodexAppServerProcessLauncherOptions {
  readonly platform?: NodeJS.Platform;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
}

/** Launches only the branded runtime companion in the attested hostd Job supervisor. */
export class WindowsJobCodexAppServerProcessLauncher implements CodexAppServerProcessLauncher {
  private readonly platform: NodeJS.Platform;
  private readonly sourceEnvironment: NodeJS.ProcessEnv;

  constructor(options: WindowsJobCodexAppServerProcessLauncherOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.sourceEnvironment = options.sourceEnvironment ?? process.env;
  }

  async launch(
    descriptor: VerifiedCodexAppServerLaunchDescriptor,
    home: CodexHomeSecurityProof,
  ): Promise<CodexAppServerTransport> {
    if (
      this.platform !== "win32" ||
      descriptor.releaseVersion !== "0.147.0" ||
      descriptor.target !== "x86_64-pc-windows-msvc" ||
      !isSafeAbsolutePath(descriptor.executable) ||
      !isSafeAbsolutePath(descriptor.companionDirectory) ||
      !isSafeAbsolutePath(home.canonicalHome) ||
      !isSafeAbsolutePath(home.canonicalTemporaryDirectory) ||
      typeof __PRIME_CONTINUIM_WINDOWS_JOB_SUPERVISOR__ !== "string" ||
      __PRIME_CONTINUIM_WINDOWS_JOB_SUPERVISOR__.length === 0 ||
      __PRIME_CONTINUIM_WINDOWS_JOB_SUPERVISOR__.length > 256 * 1024
    ) {
      throw new Error("The verified Codex app-server Windows launch boundary is unavailable");
    }
    const executable = await requireExactRegularFile(descriptor.executable);
    const companionDirectory = await realpath(descriptor.companionDirectory);
    if (!sameWindowsPath(executable, descriptor.executable) ||
      !sameWindowsPath(companionDirectory, descriptor.companionDirectory)) {
      throw new Error("The verified Codex app-server launch paths changed before spawn");
    }
    const fixedArguments = descriptor.fixedArguments.map((argument) => boundedArgument(argument));
    const environment = createCodexAppServerEnvironment(this.sourceEnvironment, {
      codexHome: home.canonicalHome,
      companionDirectory,
      temporaryDirectory: home.canonicalTemporaryDirectory,
    });
    const systemRoot = environment.SystemRoot;
    if (!systemRoot || !isSafeAbsolutePath(systemRoot)) {
      throw new Error("The Codex app-server environment does not contain a verified Windows root");
    }
    const powershell = await requireExactRegularFile(
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    );
    const payload = Buffer.from(JSON.stringify({
      executable,
      commandLine: [executable, ...fixedArguments].map(quoteWindowsArgument).join(" "),
      cwd: home.canonicalHome,
      ownershipMutexName: codexAppServerOwnershipMutexName(home),
      ownershipJobName: codexAppServerOwnershipJobName(home),
    }), "utf8").toString("base64");
    const command = `& { ${__PRIME_CONTINUIM_WINDOWS_JOB_SUPERVISOR__} } -Payload '${payload}'`;
    if (command.length > 300_000) throw new Error("The Codex app-server Job command exceeds its bound");
    const child = spawn(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ], {
      cwd: home.canonicalHome,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const transport = new WindowsJobCodexAppServerTransport(child);
    try {
      await transport.waitForSpawn();
      return transport;
    } catch (error) {
      try {
        await transport.terminate();
      } catch {
        throw new Error("The Codex app-server Job could not be retired after launch failure");
      }
      throw error;
    }
  }
}

/**
 * Stable, non-secret cross-process ownership identity for one protected Codex
 * home. The Windows Job supervisor holds this mutex for the entire process-tree
 * lifetime, so a replacement hostd cannot overlap an app-server left behind by
 * a crashed predecessor.
 */
export function codexAppServerOwnershipMutexName(home: Pick<
  CodexHomeSecurityProof,
  "canonicalHome" | "currentUserSid"
>): string {
  return `Global\\PrimeContinuim.CodexAppServer.${codexAppServerOwnershipDigest(home)}`;
}

export function codexAppServerOwnershipJobName(home: Pick<
  CodexHomeSecurityProof,
  "canonicalHome" | "currentUserSid"
>): string {
  return `Global\\PrimeContinuim.CodexAppServer.Job.${codexAppServerOwnershipDigest(home)}`;
}

function codexAppServerOwnershipDigest(home: Pick<
  CodexHomeSecurityProof,
  "canonicalHome" | "currentUserSid"
>): string {
  if (!isSafeAbsolutePath(home.canonicalHome) || !isSafeWindowsSid(home.currentUserSid)) {
    throw new Error("The Codex app-server ownership identity is invalid");
  }
  const identity = [
    "prime-continuim-codex-app-server-owner-v1",
    home.currentUserSid.toUpperCase(),
    normalizedWindowsPath(home.canonicalHome),
  ].join("\0");
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

export class WindowsJobCodexAppServerTransport implements CodexAppServerTransport {
  private readonly stdoutListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly stderrListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly closedListeners = new Set<() => void>();
  private readonly stdoutQueue: Buffer[] = [];
  private readonly stderrQueue: Buffer[] = [];
  private bufferedBytes = 0;
  private spawned = false;
  private closed = false;
  private closeConfirmed = false;
  private processCloseObserved = false;
  private processCloseCode: number | null | undefined;
  private processCloseSignal: NodeJS.Signals | null | undefined;
  private readonly processClosePromise: Promise<void>;
  private resolveProcessClose!: () => void;
  private spawnError: Error | undefined;
  private terminationPromise: Promise<void> | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.processClosePromise = new Promise<void>((resolvePromise) => {
      this.resolveProcessClose = resolvePromise;
    });
    child.stdout.on("data", (chunk: Buffer) => this.publish(this.stdoutListeners, this.stdoutQueue, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.publish(this.stderrListeners, this.stderrQueue, chunk));
    child.once("spawn", () => {
      this.spawned = true;
    });
    child.once("error", () => {
      this.spawnError = new Error("The Codex app-server Job process could not be created");
    });
    child.once("close", (code, signal) => {
      this.processCloseObserved = true;
      this.processCloseCode = code;
      this.processCloseSignal = signal;
      this.closed = true;
      this.closeConfirmed = code === 0 && signal === null;
      this.resolveProcessClose();
      this.publishClosed();
    });
  }

  async waitForSpawn(): Promise<void> {
    if (this.spawned) return;
    if (this.spawnError) throw this.spawnError;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onSpawn = () => {
        cleanup();
        resolvePromise();
      };
      const onError = () => {
        cleanup();
        rejectPromise(new Error("The Codex app-server Job process could not be created"));
      };
      const cleanup = () => {
        this.child.off("spawn", onSpawn);
        this.child.off("error", onError);
      };
      this.child.once("spawn", onSpawn);
      this.child.once("error", onError);
    });
  }

  send(frame: Uint8Array): Promise<void> {
    if (this.closed || this.child.stdin.destroyed) {
      return Promise.reject(new Error("The Codex app-server Job stdin is closed"));
    }
    return new Promise((resolvePromise, rejectPromise) => {
      this.child.stdin.write(Buffer.from(frame), (error) => {
        if (error) rejectPromise(new Error("The Codex app-server Job stdin write failed"));
        else resolvePromise();
      });
    });
  }

  onStdout(listener: (chunk: Uint8Array) => void): () => void {
    this.stdoutListeners.add(listener);
    this.flush(this.stdoutQueue, listener);
    return () => this.stdoutListeners.delete(listener);
  }

  onStderr(listener: (chunk: Uint8Array) => void): () => void {
    this.stderrListeners.add(listener);
    this.flush(this.stderrQueue, listener);
    return () => this.stderrListeners.delete(listener);
  }

  onClosed(listener: () => void): () => void {
    if (this.closed) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  terminate(): Promise<void> {
    this.terminationPromise ??= (async () => {
      if (!this.closeConfirmed) {
        this.closed = true;
        try {
          // EOF lets app-server exit inside the attested Job wrapper. The
          // wrapper itself then TerminateJobObject()s and proves active==0
          // before it exits; only that outer close is accepted below.
          this.child.stdin.end();
        } catch {
          // Still wait for the wrapper's positive retirement proof. Never
          // kill the holder and mistake its close for a drained Job.
        }
        await this.waitForConfirmedClose();
      }
      if (!this.closeConfirmed) throw new Error("Codex app-server Job retirement was not confirmed");
    })();
    return this.terminationPromise;
  }

  private publish(
    listeners: Set<(chunk: Uint8Array) => void>,
    queue: Buffer[],
    chunk: Buffer,
  ): void {
    if (listeners.size > 0) {
      for (const listener of listeners) listener(chunk);
      return;
    }
    this.bufferedBytes += chunk.byteLength;
    if (this.bufferedBytes > MAX_BUFFERED_OUTPUT_BYTES) {
      this.closed = true;
      this.publishClosed();
      // The client observes the fatal close signal and awaits the same
      // retirement promise. This catch prevents a timeout from becoming an
      // unhandled rejection if the overflow precedes client subscription.
      void this.terminate().catch(() => undefined);
      return;
    }
    queue.push(Buffer.from(chunk));
  }

  private flush(queue: Buffer[], listener: (chunk: Uint8Array) => void): void {
    while (queue.length > 0) {
      const chunk = queue.shift()!;
      this.bufferedBytes -= chunk.byteLength;
      listener(chunk);
    }
  }

  private waitForConfirmedClose(): Promise<void> {
    if (this.processCloseObserved) {
      this.requireSuccessfulWrapperExit();
      return Promise.resolve();
    }
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(new Error("Codex app-server Job retirement timed out"));
      }, TERMINATION_TIMEOUT_MS);
      timer.unref?.();
      void this.processClosePromise.then(() => {
        clearTimeout(timer);
        try {
          this.requireSuccessfulWrapperExit();
          resolvePromise();
        } catch (error) {
          rejectPromise(error);
        }
      });
    });
  }

  private requireSuccessfulWrapperExit(): void {
    if (
      !this.processCloseObserved ||
      this.processCloseCode !== 0 ||
      this.processCloseSignal !== null
    ) {
      throw new Error("Codex app-server Job wrapper did not prove a drained process tree");
    }
    this.closeConfirmed = true;
  }

  private publishClosed(): void {
    for (const listener of this.closedListeners) listener();
    this.closedListeners.clear();
  }
}

async function requireExactRegularFile(path: string): Promise<string> {
  if (!isSafeAbsolutePath(path)) throw new Error("Codex app-server launch file path is invalid");
  const physical = await realpath(path);
  const metadata = await lstat(physical);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !sameWindowsPath(path, physical)) {
    throw new Error("Codex app-server launch file is not one canonical regular file");
  }
  return physical;
}

function boundedArgument(value: string): string {
  if (value.length === 0 || value.length > 4_096 || /[\0\r\n]/.test(value)) {
    throw new Error("Codex app-server fixed argument is invalid");
  }
  return value;
}

function quoteWindowsArgument(value: string): string {
  if (value && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
}

function isSafeAbsolutePath(value: string): boolean {
  return isAbsolute(value) && /^[A-Za-z]:[\\/]/.test(value) && value.length <= 2_048 && !/[\0\r\n]/.test(value);
}

function sameWindowsPath(first: string, second: string): boolean {
  return normalizedWindowsPath(first) === normalizedWindowsPath(second);
}

function normalizedWindowsPath(value: string): string {
  return value.replace(/\//g, "\\").toLowerCase();
}

function isSafeWindowsSid(value: string): boolean {
  return value.length <= 184 && /^S-\d+(?:-\d+)+$/i.test(value);
}
