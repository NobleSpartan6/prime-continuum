import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  WindowsJobCodexAppServerTransport,
  codexAppServerOwnershipJobName,
  codexAppServerOwnershipMutexName,
} from "../../src/hostd/codex-app-server-process";

describe("Codex app-server Windows Job transport", () => {
  it("uses stdin EOF and waits for the wrapper's drained-Job close proof", async () => {
    const child = fakeChild();
    child.stdin.once("finish", () => child.emit("close", 0, null));
    const transport = new WindowsJobCodexAppServerTransport(child);

    await expect(transport.terminate()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not force-kill the Job holder or claim retirement when EOF never drains", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const transport = new WindowsJobCodexAppServerTransport(child);
      const terminating = transport.terminate();
      const outcome = terminating.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(outcome).resolves.toMatchObject({
        message: "Codex app-server Job retirement timed out",
      });
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a nonzero wrapper exit instead of treating holder close as Job retirement", async () => {
    const child = fakeChild();
    child.stdin.once("finish", () => child.emit("close", 1, null));
    const transport = new WindowsJobCodexAppServerTransport(child);

    await expect(transport.terminate()).rejects.toThrow(
      "Codex app-server Job wrapper did not prove a drained process tree",
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("reports pre-listener output overflow and contains an unconfirmed retirement rejection", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const transport = new WindowsJobCodexAppServerTransport(child);
      (child.stdout as PassThrough).write(Buffer.alloc(1024 * 1024 + 1));
      await Promise.resolve();

      const closed = vi.fn();
      transport.onClosed(closed);
      await Promise.resolve();
      expect(closed).toHaveBeenCalledOnce();

      const outcome = transport.terminate().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(outcome).resolves.toMatchObject({
        message: "Codex app-server Job retirement timed out",
      });
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.runIf(process.platform === "win32")(
    "derives one stable ownership namespace from the protected home and Windows user",
    () => {
      const first = codexAppServerOwnershipMutexName({
        canonicalHome: "C:\\Prime\\Codex\\home",
        currentUserSid: "S-1-5-21-1-2-3-1001",
      });
      expect(first).toMatch(/^Global\\PrimeContinuim\.CodexAppServer\.[0-9a-f]{64}$/);
      const job = codexAppServerOwnershipJobName({
        canonicalHome: "C:\\Prime\\Codex\\home",
        currentUserSid: "S-1-5-21-1-2-3-1001",
      });
      expect(job).toBe(first.replace(".CodexAppServer.", ".CodexAppServer.Job."));
      expect(codexAppServerOwnershipMutexName({
        canonicalHome: "c:/prime/codex/home",
        currentUserSid: "s-1-5-21-1-2-3-1001",
      })).toBe(first);
      expect(codexAppServerOwnershipMutexName({
        canonicalHome: "C:\\Prime\\Codex\\other-home",
        currentUserSid: "S-1-5-21-1-2-3-1001",
      })).not.toBe(first);
      expect(() => codexAppServerOwnershipMutexName({
        canonicalHome: "C:\\Prime\\Codex\\home",
        currentUserSid: "not-a-sid",
      })).toThrow("ownership identity is invalid");
    },
  );

  it.runIf(process.platform === "win32")(
    "holds Codex ownership across host processes until the exact Job is empty",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "prime-codex-job-owner-"));
      const marker = join(root, "child-ready");
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!systemRoot) throw new Error("Windows root is unavailable");
      const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const supervisor = resolve("scripts/windows-job-supervisor.ps1");
      const ownershipMutexName = `Global\\PrimeContinuim.CodexAppServer.${createHash("sha256")
        .update(randomUUID())
        .digest("hex")}`;
      const ownershipJobName = ownershipMutexName.replace(".CodexAppServer.", ".CodexAppServer.Job.");
      const childScript = `[IO.File]::WriteAllText('${marker.replace(/'/g, "''")}', 'ready'); [Console]::In.ReadLine() | Out-Null`;
      const childCommandLine = [
        powershell,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(childScript, "utf16le").toString("base64"),
      ].map(quoteWindowsArgument).join(" ");
      const ownedPayload = supervisorPayload({
        executable: powershell,
        commandLine: childCommandLine,
        cwd: root,
        ownershipMutexName,
        ownershipJobName,
      });
      const first = spawnSupervisor(powershell, supervisor, ownedPayload);
      try {
        await waitForFile(marker);

        const blocked = spawnSupervisor(powershell, supervisor, ownedPayload);
        const blockedResult = await waitForExit(blocked, 5_000);
        expect(blockedResult.code).toBe(1);
        expect(blockedResult.signal).toBeNull();
        expect(blockedResult.stderr).toContain("already owns this protected home");

        // Payloads used by candidate evaluation do not carry Codex ownership
        // and retain their independent Job semantics.
        const generic = spawnSupervisor(powershell, supervisor, supervisorPayload({
          executable: process.env.ComSpec ?? join(systemRoot, "System32", "cmd.exe"),
          commandLine: `${quoteWindowsArgument(process.env.ComSpec ?? join(systemRoot, "System32", "cmd.exe"))} /d /c exit 0`,
          cwd: root,
        }));
        await expect(waitForExit(generic, 5_000)).resolves.toMatchObject({ code: 0, signal: null });

        first.stdin.end();
        await expect(waitForExit(first, 5_000)).resolves.toMatchObject({ code: 0, signal: null });

        const replacement = spawnSupervisor(powershell, supervisor, supervisorPayload({
          executable: process.env.ComSpec ?? join(systemRoot, "System32", "cmd.exe"),
          commandLine: `${quoteWindowsArgument(process.env.ComSpec ?? join(systemRoot, "System32", "cmd.exe"))} /d /c exit 0`,
          cwd: root,
          ownershipMutexName,
          ownershipJobName,
        }));
        await expect(waitForExit(replacement, 5_000)).resolves.toMatchObject({ code: 0, signal: null });
      } finally {
        if (first.exitCode === null) {
          first.stdin.end();
          first.kill();
        }
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.runIf(process.platform === "win32")(
    "recovers a named predecessor Job after forced supervisor death before starting a successor",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "prime-codex-job-recovery-"));
      const predecessorMarker = join(root, "predecessor-pid");
      const successorMarker = join(root, "successor-state");
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!systemRoot) throw new Error("Windows root is unavailable");
      const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const supervisor = resolve("scripts/windows-job-supervisor.ps1");
      const digest = createHash("sha256").update(randomUUID()).digest("hex");
      const ownershipMutexName = `Global\\PrimeContinuim.CodexAppServer.${digest}`;
      const ownershipJobName = `Global\\PrimeContinuim.CodexAppServer.Job.${digest}`;
      const predecessorScript = `[IO.File]::WriteAllText('${predecessorMarker.replace(/'/g, "''")}', [string]$PID); [Console]::In.ReadLine() | Out-Null`;
      const predecessor = spawnSupervisor(powershell, supervisor, supervisorPayload({
        executable: powershell,
        commandLine: powershellCommandLine(powershell, predecessorScript),
        cwd: root,
        ownershipMutexName,
        ownershipJobName,
      }));
      try {
        await waitForFile(predecessorMarker);
        const predecessorPid = Number.parseInt(await readFile(predecessorMarker, "utf8"), 10);
        expect(Number.isSafeInteger(predecessorPid) && predecessorPid > 0).toBe(true);

        const predecessorExit = waitForSupervisorExit(predecessor, 5_000);
        const predecessorClose = waitForExit(predecessor, 10_000);
        expect(predecessor.kill()).toBe(true);
        await predecessorExit;

        const successorScript = [
          `$old=Get-Process -Id ${predecessorPid} -ErrorAction SilentlyContinue`,
          `$state=if($null -eq $old){'drained'}else{'overlap'}`,
          `[IO.File]::WriteAllText('${successorMarker.replace(/'/g, "''")}', $state)`,
        ].join("; ");
        const successor = spawnSupervisor(powershell, supervisor, supervisorPayload({
          executable: powershell,
          commandLine: powershellCommandLine(powershell, successorScript),
          cwd: root,
          ownershipMutexName,
          ownershipJobName,
        }));
        await expect(waitForExit(successor, 10_000)).resolves.toMatchObject({ code: 0, signal: null });
        await expect(readFile(successorMarker, "utf8")).resolves.toBe("drained");
        await predecessorClose;
      } finally {
        if (predecessor.exitCode === null) {
          predecessor.stdin.end();
          predecessor.kill();
        }
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

type FakeChild = ChildProcessWithoutNullStreams & EventEmitter & { kill: ReturnType<typeof vi.fn> };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child;
}

interface SupervisorPayload {
  readonly executable: string;
  readonly commandLine: string;
  readonly cwd: string;
  readonly ownershipMutexName?: string;
  readonly ownershipJobName?: string;
}

function supervisorPayload(value: SupervisorPayload): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function spawnSupervisor(powershell: string, supervisor: string, payload: string): ChildProcessWithoutNullStreams {
  return spawn(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    supervisor,
    "-Payload",
    payload,
  ], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error("Windows Job supervisor did not exit before the test timeout"));
    }, timeoutMs);
    const onError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolvePromise({ code, signal, stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const onStderr = (chunk: Buffer) => stderr.push(Buffer.from(chunk));
    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("close", onClose);
      child.stderr.off("data", onStderr);
    };
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function waitForSupervisorExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error("Windows Job supervisor did not terminate before the test timeout"));
    }, timeoutMs);
    const onError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };
    const onExit = () => {
      cleanup();
      resolvePromise();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
  throw new Error("The contained child did not publish its readiness marker");
}

function quoteWindowsArgument(value: string): string {
  if (value && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
}

function powershellCommandLine(powershell: string, source: string): string {
  return [
    powershell,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(source, "utf16le").toString("base64"),
  ].map(quoteWindowsArgument).join(" ");
}
