import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { gzipSync } from "node:zlib";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG,
  CODEX_APP_SERVER_FIXED_ARGUMENTS,
  CODEX_APP_SERVER_THREAD_CONFIG,
  CODEX_APP_SERVER_THREAD_START_POLICY,
  codexAppServerSupportedForTarget,
  createCodexAppServerEnvironment,
  extractCodexAppServerArchive,
  loadRuntimeInputs,
  smokeCodexAppServerCompanion,
  validateRuntimeInputs,
} from "../../scripts/prime-agent-runtime-lib.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    if (!resolve(directory).startsWith(resolve(tmpdir()))) throw new Error("Refusing to clean a non-temporary test path.");
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("Codex app-server companion provenance", () => {
  it("pins the dedicated direct app-server release and strict keyring launch contract", async () => {
    const inputs = await loadRuntimeInputs();
    expect(codexAppServerSupportedForTarget(inputs.policy, "win32", "x64")).toBe(true);
    expect(codexAppServerSupportedForTarget(inputs.policy, "darwin", "arm64")).toBe(false);
    expect(inputs.sources.codexAppServer).toMatchObject({
      release: {
        tag: "rust-v0.147.0",
        version: "0.147.0",
        commit: "be6e8eac029b183056b7e4402879f15d2c85f61b",
      },
      asset: {
        size: 110_054_928,
        expandedSize: 319_488_000,
        sha256: "c8908d687cf7caa3074921479726db32f96a295372c3544f1e96919a7254951f",
      },
      packageMetadata: {
        variant: "codex-app-server",
        entrypoint: "bin/codex-app-server.exe",
      },
      legalFiles: [
        {
          path: "legal/LICENSE",
          sourceCommit: "be6e8eac029b183056b7e4402879f15d2c85f61b",
          sha256: "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc",
        },
        {
          path: "legal/NOTICE",
          sourceCommit: "be6e8eac029b183056b7e4402879f15d2c85f61b",
          sha256: "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915",
        },
      ],
    });
    expect(inputs.sources.codexAppServer.archiveMembers).toHaveLength(9);
    expect(inputs.policy.codexAppServer.fixedArguments).toEqual(CODEX_APP_SERVER_FIXED_ARGUMENTS);
    expect(inputs.policy.codexAppServer.sessionConfig).toEqual(CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG);
    expect(inputs.policy.codexAppServer.threadConfig).toEqual(CODEX_APP_SERVER_THREAD_CONFIG);
    expect(inputs.policy.codexAppServer.threadStartPolicy).toEqual(CODEX_APP_SERVER_THREAD_START_POLICY);
    expect(inputs.policy.codexAppServer.threadStartPolicy.expectedSecurityResponse.model).toBe("gpt-5.6-sol");
    expect(inputs.policy.codexAppServer.fixedArguments).not.toContain("app-server");

    const sources = structuredClone(inputs.sources);
    sources.codexAppServer.archiveMembers[1].sha256 = "0".repeat(64);
    expect(() => validateRuntimeInputs({
      packageJson: inputs.packageJson,
      lockfile: inputs.lockfile,
      sources,
      policy: inputs.policy,
    })).toThrow("Codex app-server archive member allowlist changed without review");

    const policy = structuredClone(inputs.policy);
    policy.codexAppServer.threadStartPolicy.expectedSecurityResponse.model = "drift";
    expect(() => validateRuntimeInputs({
      packageJson: inputs.packageJson,
      lockfile: inputs.lockfile,
      sources: inputs.sources,
      policy,
    })).toThrow("Codex app-server launch policy changed without review");
  });

  it("strips ambient provider, proxy, certificate, credential, and Node injection state", () => {
    const codexHome = resolve("private-codex-home");
    const companionDirectory = resolve("verified-codex-companion");
    const temporaryDirectory = resolve("private-codex-temp");
    const systemRoot = resolve(process.env.SystemRoot ?? "C:\\Windows");
    const environment = createCodexAppServerEnvironment({
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: "C:\\ambient-temp",
      TMP: "C:\\ambient-tmp",
      Path: "C:\\ambient-path",
      CODEX_HOME: "C:\\ambient-codex",
      OPENAI_API_KEY: "openai-secret",
      CHATGPT_ACCESS_TOKEN: "chatgpt-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GITHUB_TOKEN: "github-secret",
      HTTPS_PROXY: "https://user:password@proxy.invalid",
      NODE_EXTRA_CA_CERTS: "C:\\unreviewed-ca.pem",
      SSH_AUTH_SOCK: "agent-socket",
      NODE_OPTIONS: "--import=attacker.mjs",
      NODE_PATH: "shadow-modules",
      PRIME_CONTINUIM_SAFE_INPUT: "preserved",
      DATABASE_URL: "postgres://secret",
      SENTRY_DSN: "https://secret@sentry.invalid/1",
      MYSTERY_CONNECTION: "unreviewed-secret",
    }, { codexHome, companionDirectory, temporaryDirectory });

    expect(environment).toEqual({
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      ComSpec: join(systemRoot, "System32", "cmd.exe"),
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
      PATH: [
        join(companionDirectory, "codex-path"),
        join(systemRoot, "System32"),
        join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
      ].join(";"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      CODEX_HOME: codexHome,
    });
  });
});

describe("Codex app-server exact archive extraction", () => {
  it("extracts only the logical allowlist behind mtime-only PAX headers", async () => {
    const fixture = await archiveFixture([
      { path: "bin/", type: "directory", bytes: Buffer.alloc(0) },
      { path: "bin/codex-app-server.exe", type: "file", bytes: Buffer.from("signed fixture") },
    ]);
    await extractCodexAppServerArchive(fixture);
    await expect(readFile(join(fixture.destinationDirectory, "bin", "codex-app-server.exe"), "utf8"))
      .resolves.toBe("signed fixture");
  });

  it("rejects a PAX path override instead of allowing metadata to redirect extraction", async () => {
    const fixture = await archiveFixture(
      [{ path: "bin/", type: "directory", bytes: Buffer.alloc(0) }],
      { paxBody: paxRecord("path=../../escape") },
    );
    await expect(extractCodexAppServerArchive(fixture)).rejects.toThrow("mtime-only record");
  });

  it("rejects extra logical members and link-like tar types", async () => {
    const extra = await archiveFixture(
      [
        { path: "bin/", type: "directory", bytes: Buffer.alloc(0) },
        { path: "extra", type: "file", bytes: Buffer.from("extra") },
      ],
      { expectedMemberCount: 1 },
    );
    await expect(extractCodexAppServerArchive(extra)).rejects.toThrow("not the next pinned member");

    const link = await archiveFixture(
      [{ path: "link", type: "file", bytes: Buffer.alloc(0) }],
      { rawType: "2" },
    );
    await expect(extractCodexAppServerArchive(link)).rejects.toThrow("unsupported tar type");
  });
});

describe("Codex app-server signed-out protocol smoke", () => {
  it("performs a causal initialize handshake before account/read and exits through closed stdio", async () => {
    const root = await companionFixture();
    const messages: Array<Record<string, unknown>> = [];
    const spawnImpl = scriptedSpawn({ messages });
    await expect(smokeCodexAppServerCompanion(root, smokeOptions(spawnImpl))).resolves.toEqual({
      protocol: "jsonl-stdio",
      initialize: true,
      initializeIdentity: true,
      configRead: true,
      denyVectorEffective: true,
      windowsSandboxUnelevatedPrivateDesktop: true,
      mcpServersEmpty: true,
      hooksEmpty: true,
      pluginsEmpty: true,
      appsEmpty: true,
      threadStartReadOnly: true,
      threadNetworkAccessDisabled: true,
      threadDeleted: true,
      accountReadSignedOut: true,
      requiresOpenaiAuth: true,
      forbiddenConfigAbsent: true,
      authJsonAbsent: true,
    });
    expect(messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "config/read",
      "mcpServerStatus/list",
      "hooks/list",
      "plugin/list",
      "app/list",
      "thread/start",
      "thread/delete",
      "account/read",
    ]);
    expect(messages[0]).toMatchObject({
      params: { capabilities: { experimentalApi: true } },
    });
  });

  it.runIf(process.platform !== "win32")(
    "passes the canonical private home to the app-server environment through a temporary-directory alias",
    async () => {
      const root = await companionFixture();
      const aliasedRoot = await temporaryDirectory("prime-codex-smoke-aliased-temp-");
      const physicalTemporary = join(aliasedRoot, "physical");
      const aliasedTemporary = join(aliasedRoot, "alias");
      await mkdir(physicalTemporary);
      await symlink(physicalTemporary, aliasedTemporary, "dir");
      const spawn = scriptedSpawn();
      const spawnImpl: ReturnType<typeof scriptedSpawn> = (executable, args, options) => {
        const launchedCodexHome = options.env.CODEX_HOME;
        if (!launchedCodexHome) throw new Error("Codex smoke fixture launched without CODEX_HOME");
        expect(launchedCodexHome).toBe(realpathSync(launchedCodexHome));
        return spawn(executable, args, options);
      };
      const previousTemporary = process.env.TMPDIR;
      process.env.TMPDIR = aliasedTemporary;
      try {
        await expect(smokeCodexAppServerCompanion(root, smokeOptions(spawnImpl)))
          .resolves.toMatchObject({ initialize: true, accountReadSignedOut: true });
      } finally {
        if (previousTemporary === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTemporary;
      }
    },
  );

  it("rejects unknown response ids and confirms failed-process teardown", async () => {
    const root = await companionFixture();
    const spawnImpl = scriptedSpawn({
      onInitialize: ({ emitFrame }) => emitFrame({ id: 99, result: {} }),
    });
    await expect(smokeCodexAppServerCompanion(root, smokeOptions(spawnImpl)))
      .rejects.toThrow("unknown response or server request id");
  });

  it("fails within a second bounded deadline when kill never produces close", async () => {
    const root = await companionFixture();
    const spawnImpl = scriptedSpawn({ neverClose: true });
    const startedAt = Date.now();
    await expect(smokeCodexAppServerCompanion(root, {
      ...smokeOptions(spawnImpl),
      timeoutMs: 100,
      teardownTimeoutMs: 10,
    })).rejects.toThrow("teardown was not confirmed");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("fails closed when the private CODEX_HOME gains credential, config, or executable authority", async () => {
    for (const [name, expected] of [
      ["auth.json", "forbidden auth.json"],
      [".credentials.json", "forbidden .credentials.json"],
      ["config.toml", "forbidden config.toml"],
      ["startup.ps1", "executable user-config file"],
    ] as const) {
      const root = await companionFixture();
      const spawnImpl = scriptedSpawn({
        beforeAccountResponse: async ({ codexHome }) => {
          await writeFile(join(codexHome, name), "forbidden\n");
        },
      });
      await expect(smokeCodexAppServerCompanion(root, smokeOptions(spawnImpl))).rejects.toThrow(expected);
    }
  });

  it("allows encrypted keyring state and signed-generated system skill data", async () => {
    const root = await companionFixture();
    const spawnImpl = scriptedSpawn({
      beforeAccountResponse: async ({ codexHome }) => {
        await mkdir(join(codexHome, "secrets"));
        await writeFile(join(codexHome, "secrets", "codex_auth.age"), "encrypted fixture");
        await mkdir(join(codexHome, "skills", ".system", "fixture", "scripts"), { recursive: true });
        await writeFile(join(codexHome, "skills", ".system", "fixture", "SKILL.md"), "signed-generated fixture");
        await writeFile(join(codexHome, "skills", ".system", "fixture", "scripts", "helper.py"), "pass\n");
      },
    });
    await expect(smokeCodexAppServerCompanion(root, smokeOptions(spawnImpl))).resolves.toMatchObject({
      forbiddenConfigAbsent: true,
      authJsonAbsent: true,
    });
  });

  it("fails closed when the private CODEX_HOME gains a reparse link", async () => {
    const linkRoot = await companionFixture();
    const linkSpawn = scriptedSpawn({
      beforeAccountResponse: async ({ codexHome }) => {
        const target = join(dirname(codexHome), "external-directory");
        await mkdir(target);
        await symlink(target, join(codexHome, "reparse-directory"), "junction");
      },
    });

    await expect(smokeCodexAppServerCompanion(linkRoot, smokeOptions(linkSpawn)))
      .rejects.toThrow("reparse link");
  });
});

type LogicalTarMember = {
  path: string;
  type: "file" | "directory";
  bytes: Buffer;
};

async function archiveFixture(
  logicalMembers: LogicalTarMember[],
  options: { paxBody?: Buffer; expectedMemberCount?: number; rawType?: string } = {},
) {
  const root = await temporaryDirectory("prime-codex-archive-");
  const destinationDirectory = join(root, "destination");
  await mkdir(destinationDirectory);
  const blocks: Buffer[] = [];
  for (const [index, member] of logicalMembers.entries()) {
    const pax = index === 0 && options.paxBody ? options.paxBody : paxRecord("mtime=1.0");
    blocks.push(tarEntry("././@PaxHeader", "x", pax));
    const type = index === 0 && options.rawType ? options.rawType : member.type === "directory" ? "5" : "0";
    blocks.push(tarEntry(member.path, type, member.bytes));
  }
  blocks.push(Buffer.alloc(1024));
  let tar = Buffer.concat(blocks);
  const recordPadding = (10_240 - (tar.byteLength % 10_240)) % 10_240;
  tar = Buffer.concat([tar, Buffer.alloc(recordPadding)]);
  const compressed = gzipSync(tar);
  const assetPath = join(root, "fixture.tar.gz");
  await writeFile(assetPath, compressed);
  const expected = logicalMembers.slice(0, options.expectedMemberCount ?? logicalMembers.length);
  return {
    assetPath,
    destinationDirectory,
    source: {
      asset: {
        size: compressed.byteLength,
        expandedSize: tar.byteLength,
        sha256: sha256(compressed),
      },
      archiveMembers: expected.map((member) => ({
        path: member.path,
        type: member.type,
        size: member.bytes.byteLength,
        ...(member.type === "file" ? { sha256: sha256(member.bytes) } : {}),
      })),
    },
  };
}

function tarEntry(path: string, type: string, bytes: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "ascii");
  writeOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, bytes.byteLength);
  writeOctal(header, 136, 12, 1);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc((512 - (bytes.byteLength % 512)) % 512);
  return Buffer.concat([header, bytes, padding]);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  target.write(text, offset, length - 1, "ascii");
  target[offset + length - 1] = 0;
}

function paxRecord(body: string): Buffer {
  let length = body.length + 3;
  while (`${length} ${body}\n`.length !== length) length = `${length} ${body}\n`.length;
  return Buffer.from(`${length} ${body}\n`, "ascii");
}

async function companionFixture(): Promise<string> {
  const root = await temporaryDirectory("prime-codex-smoke-");
  const bin = join(root, "companions", "codex-app-server", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "codex-app-server.exe"), "fake executable");
  return root;
}

function smokeOptions(spawnImpl: ReturnType<typeof scriptedSpawn>) {
  const systemRoot = resolve("fixture-system-root");
  return {
    policy: {
      codexAppServer: {
        platform: "win32",
        arch: "x64",
        entrypoint: "companions/codex-app-server/bin/codex-app-server.exe",
        fixedArguments: CODEX_APP_SERVER_FIXED_ARGUMENTS,
      },
    },
    platform: "win32",
    arch: "x64",
    environment: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
    },
    spawnImpl,
    timeoutMs: 500,
    teardownTimeoutMs: 50,
  };
}

function scriptedSpawn(options: {
  messages?: Array<Record<string, unknown>>;
  neverClose?: boolean;
  onInitialize?: (context: ScriptContext) => void | Promise<void>;
  beforeAccountResponse?: (context: ScriptContext) => void | Promise<void>;
} = {}) {
  return (_executable: string, _args: string[], spawnOptions: { env: Record<string, string> }) => {
    const child = new EventEmitter() as EventEmitter & Record<string, any>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    const emitFrame = (frame: unknown) => child.stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
    const codexHome = spawnOptions.env.CODEX_HOME;
    if (codexHome === undefined) throw new Error("Fixture launch omitted CODEX_HOME");
    const context: ScriptContext = {
      codexHome,
      emitFrame,
    };
    const close = (code: number | null, signal: string | null) => {
      if (options.neverClose || child.exitCode !== null || child.signalCode !== null) return;
      child.exitCode = code;
      child.signalCode = signal;
      queueMicrotask(() => child.emit("close", code, signal));
    };
    child.kill = () => {
      if (!options.neverClose) close(null, "SIGTERM");
      return true;
    };
    child.stdin = new EventEmitter() as EventEmitter & Record<string, any>;
    child.stdin.write = (value: string) => {
      const message = JSON.parse(value.trim()) as Record<string, unknown>;
      options.messages?.push(message);
      void (async () => {
        if (message.method === "initialize") {
          if (options.onInitialize) {
            await options.onInitialize(context);
          } else {
            emitFrame({
              id: 0,
              result: {
                userAgent: "prime_continuim/0.147.0 (Windows 10.0.22631; x86_64) unknown (prime_continuim; 0.1.0)",
                codexHome: context.codexHome,
                platformFamily: "windows",
                platformOs: "windows",
              },
            });
            emitFrame({
              method: "remoteControl/status/changed",
              params: {
                status: "disabled",
                serverName: "DEV",
                installationId: "3b3d09df-e1db-4cd1-83be-7e7cf12d259c",
                environmentId: null,
              },
              emittedAtMs: 1_786_256_685_519,
            });
          }
        } else if (message.method === "config/read") {
          emitFrame({ id: 1, result: configReadFixture(context.codexHome) });
        } else if (message.method === "mcpServerStatus/list") {
          emitFrame({ id: 2, result: { data: [], nextCursor: null } });
        } else if (message.method === "hooks/list") {
          emitFrame({
            id: 3,
            result: { data: [{ cwd: context.codexHome, hooks: [], warnings: [], errors: [] }] },
          });
        } else if (message.method === "plugin/list") {
          emitFrame({
            id: 4,
            result: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
          });
        } else if (message.method === "app/list") {
          emitFrame({ id: 5, result: { data: [], nextCursor: null } });
        } else if (message.method === "thread/start") {
          const thread = threadFixture(context.codexHome);
          emitFrame({ method: "thread/started", params: { thread }, emittedAtMs: 1_786_256_685_520 });
          emitFrame({
            id: 6,
            result: {
              thread,
              model: CODEX_APP_SERVER_THREAD_START_POLICY.expectedSecurityResponse.model,
              modelProvider: "openai",
              serviceTier: null,
              cwd: context.codexHome,
              runtimeWorkspaceRoots: [],
              instructionSources: [],
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandbox: { type: "readOnly", networkAccess: false },
              activePermissionProfile: null,
              reasoningEffort: null,
              multiAgentMode: "explicitRequestOnly",
            },
          });
        } else if (message.method === "thread/delete") {
          const threadId = (message.params as { threadId: string }).threadId;
          emitFrame({
            method: "thread/status/changed",
            params: { threadId, status: { type: "notLoaded" } },
            emittedAtMs: 1_786_256_685_521,
          });
          emitFrame({
            method: "thread/deleted",
            params: { threadId },
            emittedAtMs: 1_786_256_685_522,
          });
          emitFrame({ id: 7, result: {} });
        } else if (message.method === "account/read") {
          await options.beforeAccountResponse?.(context);
          emitFrame({ id: 8, result: { account: null, requiresOpenaiAuth: true } });
        }
      })().catch((error) => child.emit("error", error));
      return true;
    };
    child.stdin.end = () => close(0, null);
    child.stdin.destroy = () => undefined;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
}

function threadFixture(codexHome: string) {
  return {
    id: "019fe542-8164-7fb0-b85b-eb9c3389dc9a",
    extra: null,
    sessionId: "019fe542-8164-7fb0-b85b-eb9c3389dc9a",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    path: join(codexHome, "sessions", "2026", "08", "09", "rollout-2026-08-09T02-42-48-019fe542-8164-7fb0-b85b-eb9c3389dc9a.jsonl"),
    cwd: codexHome,
    cliVersion: "0.147.0",
    source: "vscode",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function configReadFixture(codexHome: string) {
  const sessionConfig = structuredClone(CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG);
  const effectiveConfig = structuredClone(sessionConfig) as Record<string, any>;
  effectiveConfig.mcp_servers = {};
  effectiveConfig.plugins = {};
  effectiveConfig.marketplaces = {};
  effectiveConfig.hooks = null;
  effectiveConfig.apps = null;
  effectiveConfig.tools = null;
  effectiveConfig.agents = null;
  effectiveConfig.features.network_proxy = null;
  effectiveConfig.features.remote_control = false;
  const version = `sha256:${"1".repeat(64)}`;
  const origins = Object.fromEntries(flattenConfigPaths(sessionConfig).map((path) => [
    path === "features.multi_agent_v2" ? "features.multi_agent_v2.enabled" : path,
    { name: { type: "sessionFlags" }, version },
  ]));
  return {
    config: effectiveConfig,
    origins,
    layers: [
      { name: { type: "sessionFlags" }, version, config: sessionConfig },
      {
        name: { type: "user", file: join(codexHome, "config.toml"), profile: null },
        version: `sha256:${"2".repeat(64)}`,
        config: {},
      },
      {
        name: { type: "system", file: "C:\\ProgramData\\OpenAI\\Codex\\config.toml" },
        version: `sha256:${"3".repeat(64)}`,
        config: {},
      },
    ],
  };
}

function flattenConfigPaths(value: Record<string, any>, prefix = "", result: string[] = []): string[] {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "object" && child !== null && !Array.isArray(child)) {
      flattenConfigPaths(child, path, result);
    } else {
      result.push(path);
    }
  }
  return result;
}

interface ScriptContext {
  codexHome: string;
  emitFrame(frame: unknown): void;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
