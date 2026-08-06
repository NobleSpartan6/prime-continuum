import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  GatewayError,
  PRIME_RPC_MAX_COMMAND_BYTES,
  PRIME_RPC_MAX_PENDING_REQUESTS,
  PRIME_RPC_MAX_RECORD_SEGMENTS,
  PrimeAgentRpcGateway,
  mapHostCommandToPrimeRpc,
  type PrimeAgentRpcGatewayOptions,
  type PrimeAgentRpcSpawn,
  type PrimeAgentRpcSpawnOptions,
} from "../../src/hostd/gateway";
import { PROTOCOL_VERSION, type CommandEnvelope } from "../../src/shared/protocol";

const gateways: PrimeAgentRpcGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

describe("Prime Agent RPC command mapping", () => {
  it("maps prompt, steer, follow-up, and abort without forwarding host-only fields", () => {
    expect(mapHostCommandToPrimeRpc(command("prompt-1", { kind: "prompt", text: "Start work" }))).toEqual({
      id: "prompt-1",
      type: "prompt",
      message: "Start work",
    });
    expect(mapHostCommandToPrimeRpc(command("steer-1", { kind: "steer", text: "Change direction" }))).toEqual({
      id: "steer-1",
      type: "steer",
      message: "Change direction",
    });
    expect(mapHostCommandToPrimeRpc(command("follow-1", { kind: "follow_up", text: "Then verify" }))).toEqual({
      id: "follow-1",
      type: "follow_up",
      message: "Then verify",
    });
    expect(mapHostCommandToPrimeRpc(command("abort-1", { kind: "abort", reason: "Stop locally" }))).toEqual({
      id: "abort-1",
      type: "abort",
    });
  });

  it("keeps approval objects out of the narrow RPC fallback", () => {
    expect(() =>
      mapHostCommandToPrimeRpc(
        command("approval-1", {
          kind: "approval.resolve",
          approvalId: "approval-object-1",
          decision: "approve",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "RPC_COMMAND_UNSUPPORTED" }));
  });
});

describe("PrimeAgentRpcGateway process lifecycle", () => {
  it("lazily performs one bounded spawn probe for matching early isLive calls", async () => {
    const harness = createHarness({ autoSpawn: false, executable: "C:\\Prime Agent\\prime-agent.exe" });

    await expect(harness.gateway.isLive("other-thread", "generation-1")).resolves.toBe(false);
    await expect(harness.gateway.isLive("thread-1", "other-generation")).resolves.toBe(false);
    expect(harness.spawnCalls).toHaveLength(0);

    const first = harness.gateway.isLive("thread-1", "generation-1");
    const second = harness.gateway.isLive("thread-1", "generation-1");
    let secondSettled = false;
    void second.finally(() => {
      secondSettled = true;
    });
    await flushTasks();
    expect(harness.spawnCalls).toHaveLength(1);
    expect(secondSettled).toBe(false);
    expect(harness.spawnCalls[0]).toEqual({
      executable: "C:\\Prime Agent\\prime-agent.exe",
      args: ["--mode", "rpc"],
      options: {
        cwd: "C:\\workspace",
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    });

    harness.processes[0]?.signalSpawn();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it("returns false on a spawn error and permits a later diagnostic retry", async () => {
    const harness = createHarness({ autoSpawn: false });
    const first = harness.gateway.isLive("thread-1", "generation-1");
    await flushTasks();
    harness.processes[0]?.signalError(new Error("executable missing"));
    await expect(first).resolves.toBe(false);

    const retry = harness.gateway.isLive("thread-1", "generation-1");
    await flushTasks();
    expect(harness.processes).toHaveLength(2);
    harness.processes[1]?.signalSpawn();
    await expect(retry).resolves.toBe(true);
  });

  it("bounds startup when the child never reports spawn", async () => {
    const harness = createHarness({ autoSpawn: false, startupTimeoutMs: 5 });

    await expect(harness.gateway.isLive("thread-1", "generation-1")).resolves.toBe(false);
    expect(requiredProcess(harness.processes[0]).killed).toBe(true);
  });

  it("rejects pending requests on exit, isolates stderr from events, and can start a fresh process", async () => {
    const events: Array<Record<string, unknown>> = [];
    const harness = createHarness({ onEvent: (event) => events.push(event.message) });
    await expect(harness.gateway.isLive("thread-1", "generation-1")).resolves.toBe(true);
    const child = requiredProcess(harness.processes[0]);
    const pending = harness.gateway.submit(command("exit-command", { kind: "prompt", text: "Run" }));
    const outcome = captureOutcome(pending);
    await flushTasks();

    child.stderr.write('{"type":"must-not-be-an-event"}\nprivate diagnostic tail');
    expect(events).toEqual([]);
    child.exit(7);
    const result = await outcome;
    expect(result).toMatchObject({
      status: "rejected",
      error: {
        code: "RPC_EXITED",
        retryable: true,
        uncertain: true,
        message: "Prime Agent RPC exited (7)",
      },
    });
    expect(result.status === "rejected" ? result.error.message : "").not.toContain("private diagnostic tail");
    expect(events).toEqual([]);

    await expect(harness.gateway.isLive("thread-1", "generation-1")).resolves.toBe(true);
    expect(harness.processes).toHaveLength(2);
  });

  it("marks a child-process error after spawn uncertain when a request is pending", async () => {
    const harness = createHarness();
    await harness.gateway.isLive("thread-1", "generation-1");
    const child = requiredProcess(harness.processes[0]);
    const outcome = captureOutcome(
      harness.gateway.submit(command("process-error", { kind: "prompt", text: "Run" })),
    );
    await flushTasks();
    child.signalError(new Error("runtime pipe failure"));

    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "RPC_PROCESS_ERROR", retryable: true, uncertain: true },
    });
    expect(child.killed).toBe(true);
  });

  it("shares close completion and escalates a resistant child before resolving", async () => {
    const harness = createHarness({ exitOnStdinFinish: false, ignoredKillCount: 1, shutdownTimeoutMs: 5 });
    await harness.gateway.isLive("thread-1", "generation-1");
    const child = requiredProcess(harness.processes[0]);

    const first = harness.gateway.close();
    const second = harness.gateway.close();
    expect(first).toBe(second);
    await first;

    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
  });
});

describe("PrimeAgentRpcGateway strict JSONL", () => {
  it("accepts fragmented UTF-8 and coalesced LF-only records", async () => {
    const events: Array<Record<string, unknown>> = [];
    const harness = createHarness({ onEvent: (event) => events.push(event.message) });
    await harness.gateway.isLive("thread-1", "generation-1");
    const child = requiredProcess(harness.processes[0]);
    const first = Buffer.from(JSON.stringify({ type: "message_update", text: "one 😀\u2028two\u2029three" }) + "\n");
    const emoji = first.indexOf(Buffer.from("😀"));
    child.stdout.write(first.subarray(0, emoji + 1));
    child.stdout.write(first.subarray(emoji + 1, emoji + 3));
    child.stdout.write(first.subarray(emoji + 3));
    child.stdout.write(
      Buffer.from(
        `${JSON.stringify({ type: "agent_start", value: 1 })}\n${JSON.stringify({ type: "agent_end", value: 2 })}\n`,
      ),
    );

    expect(events).toEqual([
      { type: "message_update", text: "one 😀\u2028two\u2029three" },
      { type: "agent_start", value: 1 },
      { type: "agent_end", value: 2 },
    ]);
    expect(child.killed).toBe(false);
  });

  it("accepts a record larger than the former one-MiB accumulator across many chunks", async () => {
    const events: Array<Record<string, unknown>> = [];
    const harness = createHarness({ onEvent: (event) => events.push(event.message) });
    await harness.gateway.isLive("thread-1", "generation-1");
    const child = requiredProcess(harness.processes[0]);
    const payload = "x".repeat(1_100_000);
    const record = Buffer.from(`${JSON.stringify({ type: "large_tool_result", payload })}\n`);
    for (let offset = 0; offset < record.byteLength; offset += 4_093) {
      child.stdout.write(record.subarray(offset, Math.min(record.byteLength, offset + 4_093)));
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "large_tool_result" });
    expect(events[0]?.payload).toBe(payload);
    expect(child.killed).toBe(false);
  });

  it("correlates concurrent responses by ID even when they arrive out of order", async () => {
    const harness = createHarness();
    await harness.gateway.isLive("thread-1", "generation-1");
    const child = requiredProcess(harness.processes[0]);
    const prompt = harness.gateway.submit(command("prompt-concurrent", { kind: "prompt", text: "Start" }));
    const steer = harness.gateway.submit(command("steer-concurrent", { kind: "steer", text: "Adjust" }));
    await flushTasks();

    child.stdout.write(
      Buffer.from(
        `${JSON.stringify({ type: "response", id: "steer-concurrent", command: "steer", success: true })}\n` +
          `${JSON.stringify({ type: "response", id: "prompt-concurrent", command: "prompt", success: true })}\n`,
      ),
    );

    await expect(prompt).resolves.toEqual({ disposition: "accepted" });
    await expect(steer).resolves.toEqual({ disposition: "queued" });
  });

  it("rejects CRLF framing as uncertain after a command was written", async () => {
    const { child, outcome } = await pendingCommandHarness("crlf-command");
    child.stdout.write(
      Buffer.from(
        `${JSON.stringify({ type: "response", id: "crlf-command", command: "prompt", success: true })}\r\n`,
      ),
    );

    await expectProtocolFailure(outcome, "RPC_CRLF_FORBIDDEN");
    expect(child.killed).toBe(true);
  });

  it("rejects invalid UTF-8 instead of accepting replacement characters", async () => {
    const { child, outcome } = await pendingCommandHarness("utf8-command");
    child.stdout.write(
      Buffer.concat([
        Buffer.from('{"type":"response","id":"utf8-command","value":"'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}\n'),
      ]),
    );

    await expectProtocolFailure(outcome, "RPC_INVALID_UTF8");
    expect(child.killed).toBe(true);
  });

  it("rejects malformed JSON and terminates the diagnostic process", async () => {
    const { child, outcome } = await pendingCommandHarness("json-command");
    child.stdout.write(Buffer.from('{"type":"response","id":}\n'));

    await expectProtocolFailure(outcome, "RPC_INVALID_JSON");
    expect(child.killed).toBe(true);
  });

  it("rejects an incrementally overlong unterminated record at the configured lower bound", async () => {
    const harness = createHarness({ maxRecordBytes: 64 });
    await harness.gateway.isLive("thread-1", "generation-1");
    const child = requiredProcess(harness.processes[0]);
    const pending = harness.gateway.submit(command("oversize-command", { kind: "prompt", text: "Run" }));
    const outcome = captureOutcome(pending);
    await flushTasks();
    child.stdout.write(Buffer.alloc(40, 0x61));
    child.stdout.write(Buffer.alloc(25, 0x62));

    await expectProtocolFailure(outcome, "RPC_OUTPUT_TOO_LARGE");
    expect(child.killed).toBe(true);
  });

  it("bounds segment metadata for pathologically fragmented records", async () => {
    const { child, outcome } = await pendingCommandHarness("fragmented-command");
    for (let index = 0; index <= PRIME_RPC_MAX_RECORD_SEGMENTS; index += 1) {
      child.stdout.write(Buffer.from(" "));
    }

    await expectProtocolFailure(outcome, "RPC_OUTPUT_TOO_FRAGMENTED");
    expect(child.killed).toBe(true);
  });

  it("retires the transport on clean or truncated stdout EOF", async () => {
    const clean = await pendingCommandHarness("clean-eof-command");
    clean.child.stdout.end();
    await expectProtocolFailure(clean.outcome, "RPC_STDOUT_CLOSED");

    const truncated = await pendingCommandHarness("truncated-eof-command");
    truncated.child.stdout.write(Buffer.from('{"type":"response"'));
    truncated.child.stdout.end();
    await expectProtocolFailure(truncated.outcome, "RPC_TRUNCATED_RECORD");
  });

  it("requires the response command discriminator and boolean success", async () => {
    const { child, outcome } = await pendingCommandHarness("malformed-response-command");
    child.stdout.write(
      Buffer.from(
        `${JSON.stringify({ type: "response", id: "malformed-response-command", success: true })}\n`,
      ),
    );

    await expectProtocolFailure(outcome, "RPC_INVALID_RESPONSE");
    expect(child.killed).toBe(true);
  });
});

describe("PrimeAgentRpcGateway bounds and receipts", () => {
  it("maps successful and rejected acknowledgements to truthful admission outcomes", async () => {
    const harness = createHarness();
    await harness.gateway.isLive("thread-1", "generation-1");
    const child = requiredProcess(harness.processes[0]);
    const followUp = harness.gateway.submit(command("follow-success", { kind: "follow_up", text: "Later" }));
    const abort = harness.gateway.submit(command("abort-success", { kind: "abort" }));
    const rejected = harness.gateway.submit(command("prompt-rejected", { kind: "prompt", text: "No" }));
    await flushTasks();
    child.stdout.write(
      Buffer.from(
        `${JSON.stringify({ type: "response", id: "follow-success", command: "follow_up", success: true })}\n` +
          `${JSON.stringify({ type: "response", id: "abort-success", command: "abort", success: true })}\n` +
          `${JSON.stringify({ type: "response", id: "prompt-rejected", command: "prompt", success: false, error: "Not accepted" })}\n`,
      ),
    );

    await expect(followUp).resolves.toEqual({ disposition: "queued" });
    await expect(abort).resolves.toEqual({ disposition: "handled" });
    await expect(rejected).rejects.toMatchObject({ code: "RPC_COMMAND_REJECTED", uncertain: false });
  });

  it("marks acknowledgement timeouts uncertain", async () => {
    const harness = createHarness({ responseTimeoutMs: 5 });
    await harness.gateway.isLive("thread-1", "generation-1");
    const pending = harness.gateway.submit(command("timeout-command", { kind: "prompt", text: "Run" }));

    await expect(pending).rejects.toMatchObject({
      code: "RPC_RESPONSE_TIMEOUT",
      retryable: true,
      uncertain: true,
    });
  });

  it("bounds submit even when stdin never completes a backpressured write", async () => {
    const harness = createHarness({ responseTimeoutMs: 5 });
    await harness.gateway.isLive("thread-1", "generation-1");
    requiredProcess(harness.processes[0]).stallStdinWrites();

    await expect(
      harness.gateway.submit(command("backpressured-command", { kind: "prompt", text: "Run" })),
    ).rejects.toMatchObject({ code: "RPC_RESPONSE_TIMEOUT", uncertain: true });
  });

  it("rejects duplicate IDs and caps the pending request queue", async () => {
    const harness = createHarness({ responseTimeoutMs: 60_000 });
    const pending = Array.from({ length: PRIME_RPC_MAX_PENDING_REQUESTS }, (_, index) =>
      harness.gateway.submit(command(`queued-${index}`, { kind: "prompt", text: `Task ${index}` })),
    );
    const overflow = captureOutcome(
      harness.gateway.submit(command("queue-overflow", { kind: "prompt", text: "Overflow" })),
    );
    const settlements = Promise.allSettled(pending);
    await flushTasks();
    const child = requiredProcess(harness.processes[0]);
    expect(harness.processes).toHaveLength(1);

    await expect(
      harness.gateway.submit(command("queued-0", { kind: "prompt", text: "Duplicate" })),
    ).rejects.toMatchObject({ code: "RPC_DUPLICATE_REQUEST_ID" });
    await expect(overflow).resolves.toMatchObject({
      status: "rejected",
      error: { code: "GATEWAY_QUEUE_FULL", retryable: true, uncertain: false },
    });

    child.exit(9);
    const results = await settlements;
    expect(results).toHaveLength(PRIME_RPC_MAX_PENDING_REQUESTS);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
  });

  it("rejects oversized commands before starting a subprocess", async () => {
    const harness = createHarness();
    const oversized = command("large-command", {
      kind: "prompt",
      text: "x".repeat(PRIME_RPC_MAX_COMMAND_BYTES),
    });

    await expect(harness.gateway.submit(oversized)).rejects.toMatchObject({ code: "RPC_COMMAND_TOO_LARGE" });
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it("validates subprocess paths and numeric bounds without invoking the spawn factory", () => {
    expect(() => createUnregisteredGateway({ workspaceDirectory: "" })).toThrow(/workspaceDirectory/);
    expect(() => createUnregisteredGateway({ workspaceDirectory: "bad\0path" })).toThrow(/NUL/);
    expect(() => createUnregisteredGateway({ executable: "x".repeat(4_097) })).toThrow(/executable path/);
    expect(() => createUnregisteredGateway({ responseTimeoutMs: 0 })).toThrow(/responseTimeoutMs/);
    expect(() => createUnregisteredGateway({ startupTimeoutMs: 0 })).toThrow(/startupTimeoutMs/);
    expect(() => createUnregisteredGateway({ shutdownTimeoutMs: 0 })).toThrow(/shutdownTimeoutMs/);
    expect(() => createUnregisteredGateway({ maxRecordBytes: 8 * 1024 * 1024 + 1 })).toThrow(/maxRecordBytes/);
  });
});

interface HarnessOptions
  extends Partial<
    Omit<
      PrimeAgentRpcGatewayOptions,
      "executionGenerationId" | "spawnFactory" | "threadId" | "workspaceDirectory"
    >
  > {
  autoSpawn?: boolean;
  exitOnStdinFinish?: boolean;
  ignoredKillCount?: number;
}

interface SpawnCall {
  executable: string;
  args: string[];
  options: PrimeAgentRpcSpawnOptions;
}

function createHarness(options: HarnessOptions = {}): {
  gateway: PrimeAgentRpcGateway;
  processes: FakeRpcProcess[];
  spawnCalls: SpawnCall[];
} {
  const processes: FakeRpcProcess[] = [];
  const spawnCalls: SpawnCall[] = [];
  const autoSpawn = options.autoSpawn ?? true;
  const exitOnStdinFinish = options.exitOnStdinFinish ?? true;
  const ignoredKillCount = options.ignoredKillCount ?? 0;
  const spawnFactory: PrimeAgentRpcSpawn = (executable, args, spawnOptions) => {
    spawnCalls.push({ executable, args: [...args], options: { ...spawnOptions, stdio: [...spawnOptions.stdio] } });
    const child = new FakeRpcProcess(autoSpawn, exitOnStdinFinish, ignoredKillCount);
    processes.push(child);
    return child.asChildProcess();
  };
  const {
    autoSpawn: _autoSpawn,
    exitOnStdinFinish: _exitOnStdinFinish,
    ignoredKillCount: _ignoredKillCount,
    ...gatewayOptions
  } = options;
  const gateway = new PrimeAgentRpcGateway({
    threadId: "thread-1",
    executionGenerationId: "generation-1",
    workspaceDirectory: "C:\\workspace",
    ...gatewayOptions,
    spawnFactory,
  });
  gateways.push(gateway);
  return { gateway, processes, spawnCalls };
}

function createUnregisteredGateway(options: Partial<PrimeAgentRpcGatewayOptions>): PrimeAgentRpcGateway {
  return new PrimeAgentRpcGateway({
    threadId: "thread-1",
    executionGenerationId: "generation-1",
    workspaceDirectory: "C:\\workspace",
    ...options,
    spawnFactory: () => {
      throw new Error("spawn must not run during construction");
    },
  });
}

class FakeRpcProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdinWrites: Buffer[] = [];
  readonly killSignals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private exited = false;

  constructor(autoSpawn: boolean, exitOnStdinFinish: boolean, private ignoredKillCount: number) {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.stdinWrites.push(Buffer.from(chunk)));
    if (exitOnStdinFinish) this.stdin.once("finish", () => queueMicrotask(() => this.exit(0)));
    if (autoSpawn) queueMicrotask(() => this.signalSpawn());
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  signalSpawn(): void {
    if (!this.exited) this.emit("spawn");
  }

  signalError(error: Error): void {
    if (!this.exited) this.emit("error", error);
  }

  stallStdinWrites(): void {
    this.stdin.write = (() => true) as typeof this.stdin.write;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  kill(signal: number | NodeJS.Signals = "SIGTERM"): boolean {
    const normalizedSignal = typeof signal === "string" ? signal : "SIGTERM";
    this.killed = true;
    this.killSignals.push(normalizedSignal);
    if (this.ignoredKillCount > 0) {
      this.ignoredKillCount -= 1;
      return true;
    }
    this.exit(null, normalizedSignal);
    return true;
  }
}

function command(commandId: string, payload: CommandEnvelope["command"]): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "device-1",
    commandId,
    expectedHostId: "host-1",
    threadId: "thread-1",
    issuedAt: "2026-08-06T12:00:00.000Z",
    expectedExecutionGenerationId: "generation-1",
    command: payload,
  };
}

async function pendingCommandHarness(commandId: string): Promise<{
  child: FakeRpcProcess;
  outcome: Promise<Outcome<unknown>>;
}> {
  const harness = createHarness();
  await harness.gateway.isLive("thread-1", "generation-1");
  const child = requiredProcess(harness.processes[0]);
  const outcome = captureOutcome(
    harness.gateway.submit(command(commandId, { kind: "prompt", text: "Run diagnostic adapter" })),
  );
  await flushTasks();
  return { child, outcome };
}

type Outcome<T> = { status: "fulfilled"; value: T } | { status: "rejected"; error: GatewayError };

function captureOutcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (error: unknown) => ({
      status: "rejected",
      error: error instanceof GatewayError ? error : new GatewayError("UNEXPECTED_TEST_ERROR", String(error)),
    }),
  );
}

async function expectProtocolFailure(outcome: Promise<Outcome<unknown>>, code: string): Promise<void> {
  await expect(outcome).resolves.toMatchObject({
    status: "rejected",
    error: { code, retryable: true, uncertain: true },
  });
}

function requiredProcess(process: FakeRpcProcess | undefined): FakeRpcProcess {
  if (!process) throw new Error("Expected the fake RPC process to exist");
  return process;
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
