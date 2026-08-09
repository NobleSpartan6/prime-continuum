import { describe, expect, it, vi } from "vitest";
import {
  CODEX_APP_SERVER_INITIALIZE_IDENTITY,
  CODEX_APP_SERVER_THREAD_CONFIG,
} from "../../scripts/prime-agent-runtime-lib.mjs";
import {
  CodexAppServerClient,
  type CodexAppServerTransport,
} from "../../src/hostd/codex-app-server-client";

const CODEX_HOME = "C:\\PrimeData\\codex-subscription";
const USER_AGENT = "prime_continuim/0.147.0 (Windows 10.0.22631; x86_64) unknown (prime_continuim; 0.1.0)";

describe("Codex app-server JSONL client", () => {
  it("performs the strict initialize handshake and correlates bounded requests", async () => {
    const transport = new FakeTransport();
    const client = clientFor(transport);
    const initializing = client.initialize();
    expect(client.initialize()).toBe(initializing);
    await waitFor(() => transport.sent.length === 1);
    expect(transport.frame(0)).toEqual({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "prime_continuim", title: "Prime Continuim", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    });
    transport.stdout({
      id: 1,
      result: {
        userAgent: USER_AGENT,
        codexHome: CODEX_HOME,
        platformFamily: "windows",
        platformOs: "windows",
      },
    });
    await initializing;
    expect(transport.frame(1)).toEqual({ method: "initialized" });

    const account = client.readAccount();
    await waitFor(() => transport.sent.length === 3);
    expect(transport.frame(2)).toMatchObject({ id: 2, method: "account/read" });
    transport.stdout({ id: 2, result: { account: null, requiresOpenaiAuth: true } });
    await expect(account).resolves.toEqual({ account: null, requiresOpenaiAuth: true });
    await client.close();
  });

  it("denies every server-initiated request without projecting its params", async () => {
    const transport = new FakeTransport();
    const client = clientFor(transport);
    await initialize(client, transport);

    const denied = vi.fn();
    client.subscribeDeniedServerRequests(denied);
    transport.stdout({
      id: "approval-secret-id",
      method: "item/commandExecution/requestApproval",
      params: { command: "print $SECRET_PROVIDER_TOKEN" },
    });
    await waitFor(() => transport.sent.length === 3 && denied.mock.calls.length === 1);
    const denial = transport.frame(2);
    expect(denial).toEqual({
      id: "approval-secret-id",
      error: {
        code: -32_601,
        message: "Prime Continuim denies app-server initiated requests",
      },
    });
    expect(JSON.stringify(denial)).not.toContain("SECRET_PROVIDER_TOKEN");
    expect(denied).toHaveBeenCalledWith({
      id: "approval-secret-id",
      method: "item/commandExecution/requestApproval",
    });
    await client.close();
  });

  it("fails the whole connection on unknown response IDs and never leaks server errors", async () => {
    const transport = new FakeTransport();
    const client = clientFor(transport);
    await initialize(client, transport);

    const pending = client.readAccount();
    await waitFor(() => transport.sent.length === 3);
    transport.stdout({ id: 999, result: { token: "must-not-cross" } });
    await expect(pending).rejects.toMatchObject({ code: "APP_SERVER_PROTOCOL_INVALID" });
    expect(transport.terminated).toBe(true);

    const secondTransport = new FakeTransport();
    const second = clientFor(secondTransport);
    await initialize(second, secondTransport);
    const rejected = second.readAccount();
    await waitFor(() => secondTransport.sent.length === 3);
    secondTransport.stdout({
      id: 2,
      error: { code: -32_000, message: "Bearer provider-secret", data: { accessToken: "secret" } },
    });
    const error = await rejected.catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "APP_SERVER_REQUEST_REJECTED" });
    expect(JSON.stringify(error)).not.toMatch(/provider-secret|accessToken|Bearer/);
    await second.close();
  });

  it("terminates on oversized stdout or private diagnostic output", async () => {
    const stdoutTransport = new FakeTransport();
    const stdoutClient = clientFor(stdoutTransport, { maxFrameBytes: 1_024 });
    const initializing = stdoutClient.initialize();
    await waitFor(() => stdoutTransport.sent.length === 1);
    stdoutTransport.stdoutBytes(Buffer.alloc(1_025, 0x61));
    await expect(initializing).rejects.toMatchObject({ code: "APP_SERVER_RESOURCE_LIMIT" });
    expect(stdoutTransport.terminated).toBe(true);

    const stderrTransport = new FakeTransport();
    const stderrClient = clientFor(stderrTransport, { maxStderrBytes: 4 });
    const secondInitialization = stderrClient.initialize();
    await waitFor(() => stderrTransport.sent.length === 1);
    stderrTransport.stderrBytes(Buffer.from("secret"));
    await expect(secondInitialization).rejects.toMatchObject({ code: "APP_SERVER_RESOURCE_LIMIT" });
    expect(stderrTransport.terminated).toBe(true);
  });

  it("treats request timeout as an ambiguous connection failure", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const client = clientFor(transport, { requestTimeoutMs: 10 });
      const initializing = client.initialize();
      const outcome = initializing.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      await expect(outcome).resolves.toMatchObject({ code: "APP_SERVER_REQUEST_TIMEOUT" });
      expect(transport.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("latches unconfirmed process termination and surfaces it on close", async () => {
    const transport = new FakeTransport();
    transport.terminateError = new Error("private process detail");
    const client = clientFor(transport);
    const initializing = client.initialize();
    await waitFor(() => transport.sent.length === 1);
    transport.stdout({ id: 999, result: {} });
    await expect(initializing).rejects.toMatchObject({ code: "APP_SERVER_TRANSPORT_FAILED" });
    await expect(client.close()).rejects.toMatchObject({
      code: "APP_SERVER_TRANSPORT_FAILED",
      message: "Codex app-server process termination could not be confirmed",
    });
    expect(() => client.assertHealthy()).toThrowError(expect.objectContaining({
      code: "APP_SERVER_TRANSPORT_FAILED",
    }));
  });

  it("terminates a half-initialized process when the initialized acknowledgement cannot be sent", async () => {
    const transport = new FakeTransport();
    transport.failSendAt = 1;
    const client = clientFor(transport);
    const initializing = client.initialize();
    await waitFor(() => transport.sent.length === 1);
    transport.stdout({
      id: 1,
      result: {
        userAgent: USER_AGENT,
        codexHome: CODEX_HOME,
        platformFamily: "windows",
        platformOs: "windows",
      },
    });
    await expect(initializing).rejects.toMatchObject({
      code: "APP_SERVER_TRANSPORT_FAILED",
      message: "Codex app-server initialization acknowledgement could not be written",
    });
    expect(transport.terminated).toBe(true);
  });

  it("bounds each JSONL frame independently when one stdout chunk contains several frames", async () => {
    const transport = new FakeTransport();
    const client = clientFor(transport, { maxFrameBytes: 1_024 });
    await initialize(client, transport);
    const notifications = vi.fn();
    client.subscribe(notifications);
    const first = JSON.stringify({ method: "warning", params: { message: "a".repeat(600) } });
    const second = JSON.stringify({ method: "warning", params: { message: "b".repeat(600) } });
    const combined = Buffer.from(`${first}\n${second}\n`, "utf8");
    expect(combined.byteLength).toBeGreaterThan(1_024);

    transport.stdoutBytes(combined);

    expect(notifications).toHaveBeenCalledTimes(2);
    expect(() => client.assertHealthy()).not.toThrow();
    await client.close();
  });

  it("rejects malformed UTF-8 instead of accepting replacement characters", async () => {
    const transport = new FakeTransport();
    const client = clientFor(transport);
    await initialize(client, transport);
    const pending = client.readAccount();
    await waitFor(() => transport.sent.length === 3);
    transport.stdoutBytes(Buffer.concat([
      Buffer.from('{"method":"warning","params":"', "utf8"),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n', "utf8"),
    ]));
    await expect(pending).rejects.toMatchObject({ code: "APP_SERVER_PROTOCOL_INVALID" });
    expect(transport.terminated).toBe(true);
  });

  it("fails closed on unknown notifications and methods outside the frozen client surface", async () => {
    const transport = new FakeTransport();
    const client = clientFor(transport);
    await initialize(client, transport);
    const escaped = client as unknown as { request(method: string, params: unknown): Promise<unknown> };
    await expect(escaped.request("fs/readFile", { path: "C:\\private.txt" })).rejects.toMatchObject({
      code: "APP_SERVER_PROTOCOL_INVALID",
    });
    expect(transport.sent).toHaveLength(2);

    const pending = client.readAccount();
    await waitFor(() => transport.sent.length === 3);
    transport.stdout({ method: "future/unknown", params: { secret: "do-not-project" } });
    await expect(pending).rejects.toMatchObject({ code: "APP_SERVER_PROTOCOL_INVALID" });
    expect(transport.terminated).toBe(true);
  });

  it("constructs a multiline turn only through the fixed read-only request envelope", async () => {
    const transport = new FakeTransport();
    const client = clientFor(transport);
    await initialize(client, transport);
    const turn = client.startTurn({
      cwd: "C:\\work\\prime",
      threadId: "0190-thread",
      clientUserMessageId: "user-message-1",
      prompt: "Inspect the first file.\nThen explain the second.",
    });
    await waitFor(() => transport.sent.length === 3);
    expect(transport.frame(2)).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "0190-thread",
        clientUserMessageId: "user-message-1",
        input: [{
          type: "text",
          text: "Inspect the first file.\nThen explain the second.",
          text_elements: [],
        }],
        environments: [],
        cwd: "C:\\work\\prime",
        runtimeWorkspaceRoots: ["C:\\work\\prime"],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    });
    transport.stdout({ id: 2, result: { turn: { id: "turn-one" } } });
    await expect(turn).resolves.toMatchObject({ turn: { id: "turn-one" } });
    expect(() => client.startTurn({
      cwd: "C:\\work\\prime",
      threadId: "0190-thread",
      clientUserMessageId: "user-message-2",
      prompt: "bad\ud800prompt",
    })).toThrow("Turn prompt is invalid");
    await client.close();
  });
});

function clientFor(
  transport: FakeTransport,
  overrides: Partial<ConstructorParameters<typeof CodexAppServerClient>[0]> = {},
): CodexAppServerClient {
  return new CodexAppServerClient({
    transport,
      expectedCodexHome: CODEX_HOME,
      expectedReleaseVersion: "0.147.0",
      clientVersion: "0.1.0",
      initializeIdentity: CODEX_APP_SERVER_INITIALIZE_IDENTITY,
      initializeCapabilities: { experimentalApi: true },
      threadConfig: CODEX_APP_SERVER_THREAD_CONFIG,
    ...overrides,
  });
}

async function initialize(client: CodexAppServerClient, transport: FakeTransport): Promise<void> {
  const initializing = client.initialize();
  await waitFor(() => transport.sent.length === 1);
  transport.stdout({
    id: 1,
    result: {
      userAgent: USER_AGENT,
      codexHome: CODEX_HOME,
      platformFamily: "windows",
      platformOs: "windows",
    },
  });
  await initializing;
}

class FakeTransport implements CodexAppServerTransport {
  readonly sent: Uint8Array[] = [];
  terminated = false;
  terminateError: Error | undefined;
  failSendAt: number | undefined;
  private readonly stdoutListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly stderrListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly closeListeners = new Set<() => void>();

  async send(frame: Uint8Array): Promise<void> {
    if (this.terminated) throw new Error("closed");
    if (this.failSendAt === this.sent.length) throw new Error("private write failure");
    this.sent.push(Buffer.from(frame));
  }

  onStdout(listener: (chunk: Uint8Array) => void): () => void {
    this.stdoutListeners.add(listener);
    return () => this.stdoutListeners.delete(listener);
  }

  onStderr(listener: (chunk: Uint8Array) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  onClosed(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    if (this.terminateError) throw this.terminateError;
  }

  frame(index: number): unknown {
    const frame = this.sent[index];
    if (!frame) throw new Error(`Missing sent frame ${index}`);
    return JSON.parse(Buffer.from(frame).toString("utf8")) as unknown;
  }

  stdout(value: unknown): void {
    this.stdoutBytes(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
  }

  stdoutBytes(bytes: Uint8Array): void {
    for (const listener of this.stdoutListeners) listener(bytes);
  }

  stderrBytes(bytes: Uint8Array): void {
    for (const listener of this.stderrListeners) listener(bytes);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for client fixture state");
}
