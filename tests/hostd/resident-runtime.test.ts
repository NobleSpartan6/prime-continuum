import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  RESIDENT_RUNTIME_LAUNCH_STRATEGY,
  ResidentRuntimeContractError,
  buildResidentDaemonCreateRequest,
  buildResidentDaemonStartInvocation,
  sanitizeResidentDaemonEnvironment,
  validateResidentDaemonHello,
  validateResidentSessionBinding,
} from "../../src/hostd/resident-runtime";

function validHello(): Record<string, unknown> {
  return {
    type: "daemon_hello",
    socketPath: "\\\\.\\pipe\\prime-agent-daemon",
    protocol: { name: "prime-agent.daemon", version: 7 },
    schemaId: "protocol-7-schema-13-816309b1cd50",
    schemaRevision: 13,
    appVersion: "0.7.0",
    runtime: {
      buildId: "be9e2fa-dirty",
      executablePath: "C:\\Prime Agent\\prime-agent.exe",
      entrypointPath: "C:\\Prime Agent\\cli.js",
    },
    supervisorGeneration: "supervisor-generation-1",
    supervisorPid: 42,
    clientId: "daemon-client:test",
    serverCapabilities: [...REQUIRED_RESIDENT_DAEMON_CAPABILITIES, "session_input_admission"],
  };
}

function expectContractError(operation: () => unknown, code: string): ResidentRuntimeContractError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ResidentRuntimeContractError);
    expect(error).toMatchObject({ code, retryable: false });
    return error as ResidentRuntimeContractError;
  }
  throw new Error(`Expected ${code}`);
}

describe("resident Prime Agent runtime pin", () => {
  it("pins the immutable v0.7.0 release asset and verified checksum", () => {
    expect(PINNED_PRIME_AGENT_RUNTIME).toEqual({
      repository: "https://github.com/PrimeIntellect-ai/prime-agent",
      releaseTag: "v0.7.0",
      releaseVersion: "0.7.0",
      packageName: "prime-agent",
      assetFileName: "prime-agent-0.7.0.tgz",
      assetUrl:
        "https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.7.0/prime-agent-0.7.0.tgz",
      sha256: "88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b",
      expectedAppVersion: "0.7.0",
      runtimeBuildId: "be9e2fa-dirty",
      daemon: {
        protocolName: "prime-agent.daemon",
        protocolVersion: 7,
        schemaRevision: 13,
        schemaId: "protocol-7-schema-13-816309b1cd50",
      },
    });
    expect(REQUIRED_RESIDENT_DAEMON_CAPABILITIES).toEqual([
      "attach_snapshot",
      "event_sequence",
      "slim_attach",
      "chunked_snapshot",
    ]);
    expect(Object.isFrozen(PINNED_PRIME_AGENT_RUNTIME)).toBe(true);
    expect(Object.isFrozen(PINNED_PRIME_AGENT_RUNTIME.daemon)).toBe(true);
    expect(Object.isFrozen(REQUIRED_RESIDENT_DAEMON_CAPABILITIES)).toBe(true);
  });
});

describe("resident daemon compatibility", () => {
  it("accepts the exact pinned hello and returns only host-owned compatibility data", () => {
    const compatibility = validateResidentDaemonHello(validHello());

    expect(compatibility).toEqual({
      releaseVersion: "0.7.0",
      appVersion: "0.7.0",
      protocolName: "prime-agent.daemon",
      protocolVersion: 7,
      schemaRevision: 13,
      schemaId: "protocol-7-schema-13-816309b1cd50",
      capabilities: [...REQUIRED_RESIDENT_DAEMON_CAPABILITIES, "session_input_admission"],
      runtimeBuildId: "be9e2fa-dirty",
      supervisorGeneration: "supervisor-generation-1",
    });
    expect(compatibility).not.toHaveProperty("socketPath");
    expect(compatibility).not.toHaveProperty("clientId");
    expect(Object.isFrozen(compatibility)).toBe(true);
    expect(Object.isFrozen(compatibility.capabilities)).toBe(true);
  });

  it.each([
    ["protocol name", { protocol: { name: "other.daemon", version: 7 } }, "PRIME_RUNTIME_PROTOCOL_NAME_MISMATCH"],
    ["protocol version", { protocol: { name: "prime-agent.daemon", version: 8 } }, "PRIME_RUNTIME_PROTOCOL_VERSION_MISMATCH"],
    ["app version", { appVersion: "0.7.1" }, "PRIME_RUNTIME_APP_VERSION_MISMATCH"],
    ["schema revision", { schemaRevision: 14 }, "PRIME_RUNTIME_SCHEMA_REVISION_MISMATCH"],
    ["schema identity", { schemaId: "protocol-7-schema-14-other" }, "PRIME_RUNTIME_SCHEMA_ID_MISMATCH"],
  ])("fails fast on a %s mismatch", (_label, override, code) => {
    expectContractError(() => validateResidentDaemonHello({ ...validHello(), ...override }), code);
  });

  it("rejects a daemon missing any continuity capability", () => {
    const hello = validHello();
    hello.serverCapabilities = ["attach_snapshot", "event_sequence"];

    const error = expectContractError(
      () => validateResidentDaemonHello(hello),
      "PRIME_RUNTIME_CAPABILITY_MISSING",
    );
    expect(error.toJSON()).toMatchObject({
      code: "PRIME_RUNTIME_CAPABILITY_MISSING",
      retryable: false,
      details: { missingCapabilities: "slim_attach,chunked_snapshot" },
    });
  });

  it("binds an accepted hello to the exact requested socket path", () => {
    expect(
      validateResidentDaemonHello(validHello(), { expectedSocketPath: "\\\\.\\pipe\\prime-agent-daemon" }),
    ).toMatchObject({ appVersion: "0.7.0" });
    expectContractError(
      () => validateResidentDaemonHello(validHello(), { expectedSocketPath: "\\\\.\\pipe\\other-daemon" }),
      "PRIME_RUNTIME_SOCKET_MISMATCH",
    );
  });

  it("binds an accepted hello to the verified executable, entrypoint, and release build", () => {
    expect(
      validateResidentDaemonHello(validHello(), {
        expectedExecutablePath: "C:\\Prime Agent\\prime-agent.exe",
        expectedEntrypointPath: "C:\\Prime Agent\\cli.js",
      }),
    ).toMatchObject({ runtimeBuildId: "be9e2fa-dirty" });
    expectContractError(
      () =>
        validateResidentDaemonHello(validHello(), {
          expectedExecutablePath: "C:\\other\\node.exe",
          expectedEntrypointPath: "C:\\Prime Agent\\cli.js",
        }),
      "PRIME_RUNTIME_IDENTITY_MISMATCH",
    );
    expectContractError(
      () => validateResidentDaemonHello({ ...validHello(), runtime: undefined }),
      "PRIME_RUNTIME_HELLO_INVALID",
    );
    expectContractError(
      () =>
        validateResidentDaemonHello({
          ...validHello(),
          runtime: { ...(validHello().runtime as Record<string, unknown>), buildId: "other-build" },
        }),
      "PRIME_RUNTIME_HELLO_INVALID",
    );
  });

  it("rejects malformed or expanded pinned hello shapes before compatibility checks", () => {
    expectContractError(
      () => validateResidentDaemonHello({ ...validHello(), unexpectedWireField: true }),
      "PRIME_RUNTIME_HELLO_INVALID",
    );
    expectContractError(
      () => validateResidentDaemonHello({ ...validHello(), serverCapabilities: ["attach_snapshot", 42] }),
      "PRIME_RUNTIME_HELLO_INVALID",
    );
  });
});

describe("resident launch and create plans", () => {
  it("builds a fixed daemon argv vector without shell interpolation", () => {
    const executable = resolve("Prime Agent & tools", "node.exe");
    const cliEntrypoint = resolve("Prime Agent & tools", "prime-agent", "dist", "bundle", "cli.js");
    const socketPath = process.platform === "win32"
      ? "\\\\.\\pipe\\prime-agent-$(whoami)&daemon"
      : resolve(tmpdir(), "prime-agent-$(whoami)&daemon.sock");
    const daemonWorkingDirectory = resolve("Prime Agent & tools", "data");
    const invocation = buildResidentDaemonStartInvocation({
      executable,
      cliEntrypoint,
      socketPath,
      daemonWorkingDirectory,
      environment: {
        Path: "C:\\Windows",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--import=C:\\attacker.mjs",
        PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
      },
    });

    expect(invocation).toEqual({
      executable,
      argv: [cliEntrypoint, "--mode", "daemon", "--daemon-socket", socketPath],
      spawn: {
        shell: false,
        windowsHide: true,
        detached: true,
        cwd: daemonWorkingDirectory,
        env: { Path: "C:\\Windows", ELECTRON_RUN_AS_NODE: "1" },
        stdio: "ignore",
      },
    });
    expect(invocation.argv).toHaveLength(5);
    expect(invocation.argv[4]).toBe(socketPath);
    expect(invocation.argv.join(" ")).not.toContain("cmd /c");
    expect(invocation.argv.join(" ")).not.toContain("powershell");
    expect(Object.isFrozen(invocation.argv)).toBe(true);
  });

  it("launches a verified package CLI entrypoint through an explicit Node executable", () => {
    const executable = resolve("runtime", "node.exe");
    const cliEntrypoint = resolve("runtime", "prime-agent", "dist", "bundle", "cli.js");
    const socketPath = process.platform === "win32"
      ? "\\\\.\\pipe\\prime-agent-daemon"
      : resolve(tmpdir(), "prime-agent-daemon.sock");
    const daemonWorkingDirectory = resolve("runtime", "data");
    const invocation = buildResidentDaemonStartInvocation({
      executable,
      cliEntrypoint,
      socketPath,
      daemonWorkingDirectory,
      environment: {},
    });

    expect(invocation).toEqual({
      executable,
      argv: [
        cliEntrypoint,
        "--mode",
        "daemon",
        "--daemon-socket",
        socketPath,
      ],
      spawn: {
        shell: false,
        windowsHide: true,
        detached: true,
        cwd: daemonWorkingDirectory,
        env: {},
        stdio: "ignore",
      },
    });
    expectContractError(
      () =>
        buildResidentDaemonStartInvocation({
          executable: "",
          cliEntrypoint,
          socketPath,
          daemonWorkingDirectory,
        }),
      "PRIME_RUNTIME_ARGUMENT_INVALID",
    );
    expectContractError(
      () =>
        buildResidentDaemonStartInvocation({
          executable: "node",
          cliEntrypoint: "..\\prime-agent\\dist\\bundle\\cli.js",
          socketPath,
          daemonWorkingDirectory,
        }),
      "PRIME_RUNTIME_ARGUMENT_INVALID",
    );
  });

  it("strips inherited role and Node injection state from the detached supervisor", () => {
    expect(
      sanitizeResidentDaemonEnvironment({
        Path: "C:\\Windows",
        PRIME_API_KEY: "provider-secret",
        PRIME_AGENT_INTERNAL_DAEMON_CATALOG: "1",
        prime_agent_internal_session_leases: "1",
        PRIME_AGENT_BUILD_ID: "spoofed",
        PRIME_AGENT_LAUNCHER_PATH: "C:\\spoofed.exe",
        NODE_OPTIONS: "--require=C:\\attacker.cjs",
        node_path: "C:\\shadow-modules",
        ELECTRON_RUN_AS_NODE: "0",
      }),
    ).toEqual({ Path: "C:\\Windows", PRIME_API_KEY: "provider-secret" });
  });

  it("creates resident work through DaemonClient semantics, never client-owned RPC semantics", () => {
    const workspaceDirectory = "C:\\work & review\\$(project)";
    const request = buildResidentDaemonCreateRequest({
      threadId: "thread-1",
      executionGenerationId: "execution-1",
      workspaceDirectory,
      session: { kind: "resume", sessionPath: "C:\\sessions & history\\thread.jsonl" },
      sessionName: " Prime Continuim ",
    });

    expect(RESIDENT_RUNTIME_LAUNCH_STRATEGY).toEqual({
      daemonStart: "pinned_cli_daemon_mode",
      sessionCreate: "daemon_client",
      sessionAttach: "daemon_agent_connection",
      sessionLifecycle: "resident",
      shell: false,
    });
    expect(request).toEqual({
      type: "create",
      config: { cwd: workspaceDirectory },
      lifecycle: "resident",
      noSession: false,
      sessionPath: "C:\\sessions & history\\thread.jsonl",
      name: "Prime Continuim",
    });
    expect(JSON.stringify(request)).not.toContain("client_owned");
    expect(JSON.stringify(request)).not.toContain("--mode");
    expect(JSON.stringify(request)).not.toContain("rpc");
  });

  it("represents continue-recent as a bounded resident daemon request", () => {
    expect(
      buildResidentDaemonCreateRequest({
        threadId: "thread-2",
        executionGenerationId: "execution-2",
        workspaceDirectory: "/srv/prime/project",
        session: { kind: "continue_recent" },
      }),
    ).toEqual({
      type: "create",
      config: { cwd: "/srv/prime/project" },
      lifecycle: "resident",
      noSession: false,
      continueRecent: true,
    });
  });

  it("rejects control characters rather than placing them in process arguments", () => {
    expectContractError(
      () =>
        buildResidentDaemonStartInvocation({
          executable: resolve("runtime", "node.exe"),
          cliEntrypoint: resolve("runtime", "prime-agent", "dist", "bundle", "cli.js"),
          socketPath: `${resolve(tmpdir(), "valid.sock")}\n--mode rpc`,
          daemonWorkingDirectory: resolve("runtime", "data"),
        }),
      "PRIME_RUNTIME_ARGUMENT_INVALID",
    );
    expectContractError(
      () =>
        buildResidentDaemonStartInvocation({
          executable: resolve("runtime", "node.exe"),
          cliEntrypoint: resolve("runtime", "prime-agent", "dist", "bundle", "cli.js"),
          socketPath: "relative-daemon.sock",
          daemonWorkingDirectory: resolve("runtime", "data"),
        }),
      "PRIME_RUNTIME_ARGUMENT_INVALID",
    );
    expectContractError(
      () =>
        buildResidentDaemonCreateRequest({
          threadId: "thread-3",
          executionGenerationId: "execution-3",
          workspaceDirectory: "C:\\work\0other",
        }),
      "PRIME_RUNTIME_ARGUMENT_INVALID",
    );
  });
});

describe("durable resident bindings", () => {
  it("revalidates the complete persisted identity and exact runtime fence", () => {
    const value = {
      bindingVersion: 1,
      lifecycle: "resident",
      threadId: "thread-1",
      executionGenerationId: "generation-1",
      workspaceDirectory: "C:\\work\\project",
      activeSessionId: "active-1",
      sessionId: "session-1",
      sessionFile: "C:\\sessions\\session-1.jsonl",
      boundAt: "2026-08-06T17:00:00.000Z",
      runtime: validateResidentDaemonHello(validHello()),
    };

    const parsed = validateResidentSessionBinding(value);

    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.runtime)).toBe(true);
    expectContractError(
      () =>
        validateResidentSessionBinding({
          ...value,
          runtime: { ...value.runtime, appVersion: "0.7.1" },
        }),
      "PRIME_RUNTIME_BINDING_INVALID",
    );
    expectContractError(
      () => validateResidentSessionBinding({ ...value, unexpected: true }),
      "PRIME_RUNTIME_BINDING_INVALID",
    );
  });
});
