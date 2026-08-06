import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CommandEnvelope } from "../shared/protocol";

export type GatewayAdmissionDisposition = "accepted" | "queued" | "handled";

export interface GatewayAdmission {
  disposition: GatewayAdmissionDisposition;
  message?: string;
}

export interface PrimeAgentGatewayEvent {
  threadId: string;
  executionGenerationId: string;
  message: Readonly<Record<string, unknown>>;
}

/**
 * Adapter boundary only. The host framed protocol is not Prime Agent's wire
 * protocol. Implementations translate durable host commands into a particular
 * local AgentConnection, daemon, or RPC transport.
 */
export interface PrimeAgentGateway {
  isLive(threadId: string, executionGenerationId: string): Promise<boolean>;
  submit(command: CommandEnvelope): Promise<GatewayAdmission>;
  close(): Promise<void>;
}

export class UnavailablePrimeAgentGateway implements PrimeAgentGateway {
  async isLive(): Promise<boolean> {
    return false;
  }

  async submit(): Promise<GatewayAdmission> {
    throw new GatewayError("GATEWAY_UNAVAILABLE", "Prime Agent is not attached to this execution generation", true);
  }

  async close(): Promise<void> {}
}

export class GatewayError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly uncertain: boolean;

  constructor(code: string, message: string, retryable = false, uncertain = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewayError";
    this.code = code;
    this.retryable = retryable;
    this.uncertain = uncertain;
  }
}

export type PrimeRpcRequest =
  | { id: string; type: "prompt"; message: string }
  | { id: string; type: "steer"; message: string }
  | { id: string; type: "follow_up"; message: string }
  | { id: string; type: "abort" };

/** Explicit mapping for the documented `prime-agent --mode rpc` JSONL seam. */
export function mapHostCommandToPrimeRpc(command: CommandEnvelope): PrimeRpcRequest {
  switch (command.command.kind) {
    case "prompt":
      return { id: command.commandId, type: "prompt", message: command.command.text };
    case "steer":
      return { id: command.commandId, type: "steer", message: command.command.text };
    case "follow_up":
      return { id: command.commandId, type: "follow_up", message: command.command.text };
    case "abort":
      return { id: command.commandId, type: "abort" };
    case "approval.resolve":
      throw new GatewayError(
        "RPC_COMMAND_UNSUPPORTED",
        "Approval resolution requires a daemon adapter with approval-object support",
      );
  }
}

export interface PrimeAgentRpcGatewayOptions {
  threadId: string;
  executionGenerationId: string;
  workspaceDirectory: string;
  executable?: string;
  responseTimeoutMs?: number;
  onEvent?: (event: PrimeAgentGatewayEvent) => void;
}

interface PendingRequest {
  commandType: PrimeRpcRequest["type"];
  resolve: (value: GatewayAdmission) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A narrow, one-execution-generation RPC adapter. A future gateway manager owns
 * one of these per active session. It spawns with a fixed argument vector and
 * `shell: false`; all dynamic user content travels as bounded JSONL on stdin.
 */
export class PrimeAgentRpcGateway implements PrimeAgentGateway {
  private readonly options: Required<Pick<PrimeAgentRpcGatewayOptions, "responseTimeoutMs">> &
    Omit<PrimeAgentRpcGatewayOptions, "responseTimeoutMs">;
  private readonly pending = new Map<string, PendingRequest>();
  private process: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrTail = "";
  private closed = false;

  constructor(options: PrimeAgentRpcGatewayOptions) {
    if (!options.workspaceDirectory || options.workspaceDirectory.length > 4_096) {
      throw new Error("workspaceDirectory must be between 1 and 4096 characters");
    }
    if ((options.executable ?? "prime-agent").length > 4_096) {
      throw new Error("Prime Agent executable path is too long");
    }
    this.options = { ...options, responseTimeoutMs: options.responseTimeoutMs ?? 30_000 };
  }

  async isLive(threadId: string, executionGenerationId: string): Promise<boolean> {
    return (
      !this.closed &&
      threadId === this.options.threadId &&
      executionGenerationId === this.options.executionGenerationId &&
      this.process !== undefined &&
      this.process.exitCode === null
    );
  }

  async submit(command: CommandEnvelope): Promise<GatewayAdmission> {
    if (this.closed) throw new GatewayError("GATEWAY_CLOSED", "Prime Agent RPC adapter is closed");
    if (command.threadId !== this.options.threadId) {
      throw new GatewayError("GATEWAY_THREAD_MISMATCH", "RPC adapter belongs to another thread");
    }
    if (
      command.expectedExecutionGenerationId &&
      command.expectedExecutionGenerationId !== this.options.executionGenerationId
    ) {
      throw new GatewayError("GATEWAY_GENERATION_MISMATCH", "RPC adapter belongs to another execution generation");
    }
    if (this.pending.size >= 256) {
      throw new GatewayError("GATEWAY_QUEUE_FULL", "Prime Agent RPC request queue is full", true);
    }

    const rpc = mapHostCommandToPrimeRpc(command);
    const line = Buffer.from(`${JSON.stringify(rpc)}\n`, "utf8");
    if (line.byteLength > 128 * 1024) {
      throw new GatewayError("RPC_COMMAND_TOO_LARGE", "Prime Agent RPC command exceeds 128 KiB");
    }
    const child = this.ensureStarted();

    const admission = new Promise<GatewayAdmission>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rpc.id);
        reject(
          new GatewayError(
            "RPC_RESPONSE_TIMEOUT",
            "Prime Agent did not acknowledge the command before the bounded timeout",
            true,
            true,
          ),
        );
      }, this.options.responseTimeoutMs);
      timer.unref();
      this.pending.set(rpc.id, { commandType: rpc.type, resolve, reject, timer });
    });

    await new Promise<void>((resolve, reject) => {
      child.stdin.write(line, (error) => {
        if (error) reject(new GatewayError("RPC_WRITE_FAILED", "Could not write to Prime Agent RPC", true, true, { cause: error }));
        else resolve();
      });
    }).catch((error) => {
      const pending = this.pending.get(rpc.id);
      if (pending) clearTimeout(pending.timer);
      this.pending.delete(rpc.id);
      throw error;
    });
    return admission;
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.process;
    this.process = undefined;
    this.rejectAll(new GatewayError("GATEWAY_CLOSED", "Prime Agent RPC adapter closed", true, true));
    if (!child || child.exitCode !== null) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 2_000);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.process && this.process.exitCode === null) return this.process;
    const child = spawn(this.options.executable ?? "prime-agent", ["--mode", "rpc"], {
      cwd: this.options.workspaceDirectory,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-8_192);
    });
    child.once("error", (error) => {
      this.rejectAll(new GatewayError("RPC_START_FAILED", "Prime Agent RPC process could not start", true, false, { cause: error }));
    });
    child.once("exit", (code, signal) => {
      this.process = undefined;
      const detail = this.stderrTail.trim();
      this.rejectAll(
        new GatewayError(
          "RPC_EXITED",
          `Prime Agent RPC exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`.slice(0, 2_048),
          true,
          true,
        ),
      );
    });
    return child;
  }

  private onStdout(chunk: Buffer): void {
    if (this.stdoutBuffer.byteLength + chunk.byteLength > 1024 * 1024) {
      this.process?.kill();
      this.rejectAll(new GatewayError("RPC_OUTPUT_TOO_LARGE", "Prime Agent emitted an overlong JSONL record"));
      return;
    }
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      this.onRpcMessage(line);
    }
  }

  private onRpcMessage(line: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(line.toString("utf8")) as unknown;
    } catch {
      this.process?.kill();
      this.rejectAll(new GatewayError("RPC_INVALID_JSON", "Prime Agent emitted invalid JSONL"));
      return;
    }
    if (!isRecord(value)) return;

    if (value.type === "response" && typeof value.id === "string") {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      if (value.success !== true) {
        const message = typeof value.error === "string" ? value.error : "Prime Agent rejected the command";
        pending.reject(new GatewayError("RPC_COMMAND_REJECTED", message.slice(0, 2_048)));
        return;
      }
      const disposition: GatewayAdmissionDisposition =
        pending.commandType === "steer" || pending.commandType === "follow_up"
          ? "queued"
          : pending.commandType === "abort"
            ? "handled"
            : "accepted";
      pending.resolve({ disposition });
      return;
    }

    this.options.onEvent?.({
      threadId: this.options.threadId,
      executionGenerationId: this.options.executionGenerationId,
      message: value,
    });
  }

  private rejectAll(error: GatewayError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
