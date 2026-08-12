import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { CommandEnvelopeSchema, type CommandEnvelope } from "../shared/protocol";
import type { ResidentSessionBinding } from "./resident-runtime";
import type {
  ResidentAbortIdleObservedEvent,
  ResidentAbortReconciliationLease,
  ResidentDispatchLease,
  ResidentPromptIdleObservedEvent,
  ResidentPromptReconciliationLease,
} from "./store";

export const PRIME_RPC_MAX_COMMAND_BYTES = 128 * 1024;
export const PRIME_RPC_MAX_PENDING_REQUESTS = 256;
export const PRIME_RPC_MAX_RECORD_SEGMENTS = 4_096;
/**
 * RPC stdout is intentionally bounded independently from host snapshot framing.
 * Eight MiB admits large tool/result events without allowing an unterminated
 * stdout record to grow without limit.
 */
export const PRIME_RPC_MAX_RECORD_BYTES = 8 * 1024 * 1024;

const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

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
 * Private authority passed only after HostStore has durably admitted a command.
 * It never crosses the host protocol or renderer boundary.
 */
export interface GatewayDispatchContext {
  readonly residentBinding?: ResidentSessionBinding;
  readonly residentDispatch?: ResidentDispatchLease;
}

export interface PrimeAgentProjectionChange {
  readonly threadId: string;
  readonly executionGenerationId: string;
}

/**
 * Adapter boundary only. The host framed protocol is not Prime Agent's wire
 * protocol. Implementations translate durable host commands into a particular
 * local AgentConnection, daemon, or RPC transport.
 */
export interface PrimeAgentGateway {
  /** Only durable resident adapters may be installed in HostService. */
  readonly continuity: "resident" | "unavailable";
  /** Optional nonblocking capability gate for production resident composition. */
  capabilityReady?(): Promise<boolean>;
  /** Tiny post-commit notification; consumers fetch the authoritative snapshot. */
  subscribeProjectionChanges?(listener: (change: PrimeAgentProjectionChange) => void): () => void;
  /** Dedicated post-commit signal for one proof-completed resident prompt. */
  subscribeResidentPromptIdleObserved?(
    listener: (event: ResidentPromptIdleObservedEvent) => void,
  ): () => void;
  /** Dedicated post-commit signal for one proof-completed resident Stop. */
  subscribeResidentAbortIdleObserved?(
    listener: (event: ResidentAbortIdleObservedEvent) => void,
  ): () => void;
  /** Schedule the read-only same-connection idle barrier without delaying the prompt receipt. */
  scheduleResidentPromptReconciliation?(lease: ResidentPromptReconciliationLease): void;
  /** Schedule the read-only same-connection idle barrier after an acknowledged Stop. */
  scheduleResidentAbortReconciliation?(lease: ResidentAbortReconciliationLease): void;
  isLive(threadId: string, executionGenerationId: string): Promise<boolean>;
  /**
   * Proves that this exact durable binding is the gateway's current prepared
   * connection. Callers must treat an absent implementation as unavailable;
   * generation-only liveness cannot prove resident control quiescence.
   */
  isResidentBindingLive?(binding: ResidentSessionBinding): Promise<boolean>;
  /** Exact-binding proof that the packaged browser command surface passed verification. */
  isResidentBrowserExecutionReady?(binding: ResidentSessionBinding): Promise<boolean>;
  submit(command: CommandEnvelope, context?: GatewayDispatchContext): Promise<GatewayAdmission>;
  close(): Promise<void>;
}

/** Deliberately not assignable to the host continuity gateway. */
export interface PrimeAgentDiagnosticGateway {
  readonly continuity: "diagnostic_only";
  isLive(threadId: string, executionGenerationId: string): Promise<boolean>;
  submit(command: CommandEnvelope): Promise<GatewayAdmission>;
  close(): Promise<void>;
}

export class UnavailablePrimeAgentGateway implements PrimeAgentGateway {
  readonly continuity = "unavailable" as const;

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

/** SHA-256 over the strict, key-sorted v2 envelope used by private leases. */
export function residentCommandEnvelopeFingerprint(value: CommandEnvelope): string {
  const command = CommandEnvelopeSchema.parse(value);
  return createHash("sha256")
    .update(JSON.stringify(sortGatewayJsonValue(command)))
    .digest("hex");
}

function sortGatewayJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortGatewayJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sortGatewayJsonValue((value as Record<string, unknown>)[key])]),
  );
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
    case "model.select":
      throw new GatewayError(
        "RPC_COMMAND_UNSUPPORTED",
        "Model selection requires an authority-bound resident daemon adapter",
      );
  }
}

export interface PrimeAgentRpcSpawnOptions {
  cwd: string;
  shell: false;
  windowsHide: true;
  stdio: ["pipe", "pipe", "pipe"];
}

export type PrimeAgentRpcSpawn = (
  executable: string,
  args: string[],
  options: PrimeAgentRpcSpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface PrimeAgentRpcGatewayOptions {
  threadId: string;
  executionGenerationId: string;
  workspaceDirectory: string;
  executable?: string;
  responseTimeoutMs?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** May lower, but never raise, the documented eight-MiB production bound. */
  maxRecordBytes?: number;
  onEvent?: (event: PrimeAgentGatewayEvent) => void;
  /** Process test seam. Production keeps the fixed argv and `shell: false`. */
  spawnFactory?: PrimeAgentRpcSpawn;
}

interface PendingRequest {
  commandType: PrimeRpcRequest["type"];
  resolve: (value: GatewayAdmission) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

type ResolvedPrimeAgentRpcGatewayOptions = Omit<
  PrimeAgentRpcGatewayOptions,
  "maxRecordBytes" | "responseTimeoutMs" | "shutdownTimeoutMs" | "spawnFactory" | "startupTimeoutMs"
> & {
  maxRecordBytes: number;
  responseTimeoutMs: number;
  shutdownTimeoutMs: number;
  spawnFactory: PrimeAgentRpcSpawn;
  startupTimeoutMs: number;
};

const defaultSpawnFactory: PrimeAgentRpcSpawn = (executable, args, options) =>
  spawn(executable, args, options) as ChildProcessWithoutNullStreams;

/**
 * A narrow, one-execution-generation diagnostic/fallback RPC adapter. It does
 * not claim daemon reattachment, recovery, or cross-process continuity.
 *
 * `isLive` lazily starts the fixed RPC subprocess for a matching identity and
 * returns true only after the OS reports `spawn`. That is a process probe, not
 * proof that a durable Prime Agent session was restored.
 */
export class PrimeAgentRpcGateway implements PrimeAgentDiagnosticGateway {
  readonly continuity = "diagnostic_only" as const;
  private readonly options: ResolvedPrimeAgentRpcGatewayOptions;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly retiredProcesses = new Set<ChildProcessWithoutNullStreams>();
  private process: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<ChildProcessWithoutNullStreams> | undefined;
  private stdoutSegments: Buffer[] = [];
  private stdoutRecordBytes = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: PrimeAgentRpcGatewayOptions) {
    validateBoundedString(options.workspaceDirectory, "workspaceDirectory");
    validateBoundedString(options.executable ?? "prime-agent", "Prime Agent executable path");
    const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const maxRecordBytes = options.maxRecordBytes ?? PRIME_RPC_MAX_RECORD_BYTES;
    validatePositiveInteger(responseTimeoutMs, "responseTimeoutMs", 10 * 60 * 1_000);
    validatePositiveInteger(startupTimeoutMs, "startupTimeoutMs", 120_000);
    validatePositiveInteger(shutdownTimeoutMs, "shutdownTimeoutMs", 30_000);
    validatePositiveInteger(maxRecordBytes, "maxRecordBytes", PRIME_RPC_MAX_RECORD_BYTES);
    this.options = {
      ...options,
      responseTimeoutMs,
      shutdownTimeoutMs,
      startupTimeoutMs,
      maxRecordBytes,
      spawnFactory: options.spawnFactory ?? defaultSpawnFactory,
    };
  }

  async isLive(threadId: string, executionGenerationId: string): Promise<boolean> {
    if (
      this.closed ||
      threadId !== this.options.threadId ||
      executionGenerationId !== this.options.executionGenerationId
    ) {
      return false;
    }
    try {
      const child = await this.ensureStarted();
      return !this.closed && this.process === child && child.exitCode === null;
    } catch {
      return false;
    }
  }

  async submit(command: CommandEnvelope): Promise<GatewayAdmission> {
    if (this.closed) throw new GatewayError("GATEWAY_CLOSED", "Prime Agent RPC adapter is closed");
    if (command.threadId !== this.options.threadId) {
      throw new GatewayError("GATEWAY_THREAD_MISMATCH", "RPC adapter belongs to another thread");
    }
    if (command.expectedExecutionGenerationId !== this.options.executionGenerationId) {
      throw new GatewayError("GATEWAY_GENERATION_MISMATCH", "RPC adapter belongs to another execution generation");
    }
    this.assertRequestCapacity(command.commandId);

    const rpc = mapHostCommandToPrimeRpc(command);
    const line = Buffer.from(`${JSON.stringify(rpc)}\n`, "utf8");
    if (line.byteLength > PRIME_RPC_MAX_COMMAND_BYTES) {
      throw new GatewayError(
        "RPC_COMMAND_TOO_LARGE",
        `Prime Agent RPC command exceeds ${PRIME_RPC_MAX_COMMAND_BYTES} bytes`,
      );
    }
    const child = await this.ensureStarted();
    if (this.closed || this.process !== child || child.exitCode !== null) {
      throw new GatewayError("GATEWAY_CLOSED", "Prime Agent RPC adapter closed while starting", true);
    }
    // Concurrent submits can all pass the pre-start check while sharing one
    // startup promise. Recheck after readiness before reserving a request slot.
    this.assertRequestCapacity(rpc.id);

    return new Promise<GatewayAdmission>((resolve, reject) => {
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
      try {
        child.stdin.write(line, (error) => {
          if (!error) return;
          const pending = this.pending.get(rpc.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(rpc.id);
          pending.reject(
            new GatewayError("RPC_WRITE_FAILED", "Could not write to Prime Agent RPC", true, true, {
              cause: error,
            }),
          );
        });
      } catch (cause) {
        const pending = this.pending.get(rpc.id);
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(rpc.id);
        reject(
          new GatewayError("RPC_WRITE_FAILED", "Could not write to Prime Agent RPC", true, false, {
            cause,
          }),
        );
      }
    });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    const children = new Set(this.retiredProcesses);
    if (this.process) children.add(this.process);
    this.process = undefined;
    this.resetStdoutRecord();
    this.rejectAll(new GatewayError("GATEWAY_CLOSED", "Prime Agent RPC adapter closed", true, true));
    const results = await Promise.allSettled([...children].map((child) => this.shutdownChild(child)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private async shutdownChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.stdin.end();
    } catch {
      // Continue with bounded termination if the pipe already failed.
    }
    if (await waitForChildExit(child, this.options.shutdownTimeoutMs)) return;
    safelyKill(child);
    if (await waitForChildExit(child, this.options.shutdownTimeoutMs)) return;
    safelyKill(child, "SIGKILL");
    if (await waitForChildExit(child, this.options.shutdownTimeoutMs)) return;
    throw new GatewayError(
      "RPC_CLOSE_TIMEOUT",
      "Prime Agent RPC process did not exit after bounded shutdown",
      true,
      this.pending.size > 0,
    );
  }

  private async ensureStarted(): Promise<ChildProcessWithoutNullStreams> {
    if (this.closed) throw new GatewayError("GATEWAY_CLOSED", "Prime Agent RPC adapter is closed");
    if (this.startPromise) return this.startPromise;
    if (this.process && this.process.exitCode === null) return this.process;

    const startPromise = this.spawnAndAwaitReadiness();
    this.startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = undefined;
    }
  }

  private spawnAndAwaitReadiness(): Promise<ChildProcessWithoutNullStreams> {
    this.resetStdoutRecord();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.options.spawnFactory(
        this.options.executable ?? "prime-agent",
        ["--mode", "rpc"],
        {
          cwd: this.options.workspaceDirectory,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (cause) {
      throw new GatewayError("RPC_START_FAILED", "Prime Agent RPC process could not start", true, false, { cause });
    }

    this.process = child;
    child.stdout.on("data", (chunk: unknown) => this.onStdout(child, chunk));
    child.stdout.once("end", () => this.onStdoutEnd(child));
    child.stdout.once("error", (cause: Error) => {
      this.failProcess(
        child,
        new GatewayError("RPC_STDOUT_FAILED", "Prime Agent RPC stdout failed", true, this.pending.size > 0, {
          cause,
        }),
        true,
      );
    });
    child.stdin.once("error", (cause: Error) => {
      this.failProcess(
        child,
        new GatewayError("RPC_WRITE_FAILED", "Prime Agent RPC stdin failed", true, this.pending.size > 0, {
          cause,
        }),
        true,
      );
    });
    // Drain diagnostics so a noisy child cannot block, but never copy them into
    // a durable receipt or renderer-facing error message.
    child.stderr.on("data", () => {});

    return new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const timer = setTimeout(() => {
        const error = new GatewayError(
          "RPC_START_TIMEOUT",
          "Prime Agent RPC process did not report startup before the bounded timeout",
          true,
        );
        this.failProcess(child, error, true);
        settle(() => reject(error));
      }, this.options.startupTimeoutMs);
      timer.unref();

      child.once("spawn", () => settle(() => resolve(child)));
      child.once("error", (cause: Error) => {
        const error = settled
          ? new GatewayError("RPC_PROCESS_ERROR", "Prime Agent RPC process failed", true, this.pending.size > 0, {
              cause,
            })
          : new GatewayError("RPC_START_FAILED", "Prime Agent RPC process could not start", true, false, {
              cause,
            });
        this.failProcess(child, error, settled);
        settle(() => reject(error));
      });
      child.once("exit", (code, signal) => {
        const error = new GatewayError(
          "RPC_EXITED",
          `Prime Agent RPC exited (${signal ?? code ?? "unknown"})`,
          true,
          this.pending.size > 0,
        );
        this.failProcess(child, error);
        settle(() => reject(error));
      });
    });
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: unknown): void {
    if (this.process !== child) return;
    let bytes: Buffer;
    if (Buffer.isBuffer(chunk)) bytes = chunk;
    else if (typeof chunk === "string") bytes = Buffer.from(chunk, "utf8");
    else {
      this.failProtocol(child, "RPC_INVALID_STDOUT_CHUNK", "Prime Agent emitted a non-byte stdout chunk");
      return;
    }

    let offset = 0;
    while (offset < bytes.byteLength && this.process === child) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline < 0) {
        this.appendStdoutSegment(child, bytes.subarray(offset));
        return;
      }
      if (!this.appendStdoutSegment(child, bytes.subarray(offset, newline))) return;
      if (!this.emitStdoutRecord(child)) return;
      offset = newline + 1;
    }
  }

  private appendStdoutSegment(child: ChildProcessWithoutNullStreams, segment: Buffer): boolean {
    if (segment.byteLength === 0) return true;
    if (this.stdoutRecordBytes + segment.byteLength > this.options.maxRecordBytes) {
      this.failProtocol(
        child,
        "RPC_OUTPUT_TOO_LARGE",
        `Prime Agent emitted a JSONL record larger than ${this.options.maxRecordBytes} bytes`,
      );
      return false;
    }
    if (this.stdoutSegments.length >= PRIME_RPC_MAX_RECORD_SEGMENTS) {
      this.failProtocol(
        child,
        "RPC_OUTPUT_TOO_FRAGMENTED",
        `Prime Agent emitted a JSONL record in more than ${PRIME_RPC_MAX_RECORD_SEGMENTS} segments`,
      );
      return false;
    }
    this.stdoutSegments.push(segment);
    this.stdoutRecordBytes += segment.byteLength;
    return true;
  }

  private emitStdoutRecord(child: ChildProcessWithoutNullStreams): boolean {
    if (this.stdoutRecordBytes === 0) {
      this.resetStdoutRecord();
      return true;
    }
    const finalSegment = this.stdoutSegments[this.stdoutSegments.length - 1];
    if (finalSegment?.[finalSegment.byteLength - 1] === 0x0d) {
      this.failProtocol(child, "RPC_CRLF_FORBIDDEN", "Prime Agent RPC stdout used CRLF instead of LF framing");
      return false;
    }

    const record =
      this.stdoutSegments.length === 1
        ? (this.stdoutSegments[0] as Buffer)
        : Buffer.concat(this.stdoutSegments, this.stdoutRecordBytes);
    this.resetStdoutRecord();

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(record);
    } catch (cause) {
      this.failProtocol(child, "RPC_INVALID_UTF8", "Prime Agent emitted invalid UTF-8 on RPC stdout", cause);
      return false;
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (cause) {
      this.failProtocol(child, "RPC_INVALID_JSON", "Prime Agent emitted invalid JSONL", cause);
      return false;
    }
    if (!isRecord(value)) {
      this.failProtocol(child, "RPC_INVALID_MESSAGE", "Prime Agent emitted a non-object RPC message");
      return false;
    }
    this.onRpcMessage(child, value);
    return this.process === child;
  }

  private onStdoutEnd(child: ChildProcessWithoutNullStreams): void {
    if (this.process !== child) return;
    if (this.stdoutRecordBytes > 0) {
      this.failProtocol(child, "RPC_TRUNCATED_RECORD", "Prime Agent RPC stdout ended during a JSONL record");
      return;
    }
    this.failProtocol(child, "RPC_STDOUT_CLOSED", "Prime Agent RPC stdout closed unexpectedly");
  }

  private onRpcMessage(child: ChildProcessWithoutNullStreams, value: Record<string, unknown>): void {
    if (value.type === "response") {
      if (typeof value.id !== "string") {
        this.failProtocol(child, "RPC_INVALID_RESPONSE", "Prime Agent emitted a response without a request ID");
        return;
      }
      const pending = this.pending.get(value.id);
      if (!pending) return;
      if (value.command !== pending.commandType || typeof value.success !== "boolean") {
        this.failProtocol(
          child,
          "RPC_INVALID_RESPONSE",
          "Prime Agent emitted a malformed or mismatched response",
          undefined,
          true,
        );
        return;
      }
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

    try {
      this.options.onEvent?.({
        threadId: this.options.threadId,
        executionGenerationId: this.options.executionGenerationId,
        message: value,
      });
    } catch {
      // A diagnostic observer must not be able to break transport framing.
    }
  }

  private failProtocol(
    child: ChildProcessWithoutNullStreams,
    code: string,
    message: string,
    cause?: unknown,
    uncertain = this.pending.size > 0,
  ): void {
    this.failProcess(child, new GatewayError(code, message, true, uncertain, { cause }), true);
  }

  private failProcess(child: ChildProcessWithoutNullStreams, error: GatewayError, kill = false): void {
    if (this.process !== child) return;
    this.process = undefined;
    this.resetStdoutRecord();
    this.rejectAll(error);
    if (kill && child.exitCode === null && child.signalCode === null) {
      this.retiredProcesses.add(child);
      child.once("exit", () => this.retiredProcesses.delete(child));
    }
    if (!kill || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill();
    } catch {
      // The process may have exited concurrently with protocol failure handling.
    }
  }

  private resetStdoutRecord(): void {
    this.stdoutSegments = [];
    this.stdoutRecordBytes = 0;
  }

  private assertRequestCapacity(requestId: string): void {
    if (this.pending.has(requestId)) {
      throw new GatewayError("RPC_DUPLICATE_REQUEST_ID", "Prime Agent RPC request ID is already pending");
    }
    if (this.pending.size >= PRIME_RPC_MAX_PENDING_REQUESTS) {
      throw new GatewayError("GATEWAY_QUEUE_FULL", "Prime Agent RPC request queue is full", true);
    }
  }

  private rejectAll(error: GatewayError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function validateBoundedString(value: string, label: string): void {
  if (!value || value.length > 4_096 || value.includes("\0")) {
    throw new Error(`${label} must be between 1 and 4096 characters and contain no NUL bytes`);
  }
}

function validatePositiveInteger(value: number, label: string, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

function safelyKill(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // The process may have exited concurrently with bounded shutdown.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
