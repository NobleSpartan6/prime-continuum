import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import * as runtimeLib from "../../scripts/prime-agent-runtime-lib.mjs";
import {
  PrimeAgentRuntimeBuildError,
  acquireBuildLock,
  cleanBuildEnvironment,
  cleanRuntimeEnvironment,
  createRuntimeManifest,
  loadRuntimeInputs,
  pruneRuntimePackagingNoise,
  removeObsoleteRuntimeInstalls,
  resolveVerifiedEntrypoints,
  smokeRuntime,
  validateRuntimeInputs,
  verifyBuiltRuntime,
  verifyOnlySelectedRuntimeInstall,
  writeCurrentPointer,
} from "../../scripts/prime-agent-runtime-lib.mjs";

const runtimeNamespaceHelpers = runtimeLib as typeof runtimeLib & {
  pruneEmptyRuntimeDirectories(runtimeDirectory: string): Promise<readonly string[]>;
  removeLegacyRuntimeAssetCache(outputRoot: string, allowedFileNames: readonly string[]): Promise<boolean>;
};
const { pruneEmptyRuntimeDirectories, removeLegacyRuntimeAssetCache } = runtimeNamespaceHelpers;
const execFileAsync = promisify(execFile);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Prime Agent runtime build policy", () => {
  it("accepts the checked-in exact release graph and rejects source drift", async () => {
    const inputs = await loadRuntimeInputs();
    expect(inputs.lockfile.lockfileVersion).toBe(3);
    expect(Object.keys(inputs.lockfile.packages)).toHaveLength(202);
    const zeromq = inputs.lockfile.packages["node_modules/zeromq"];
    expect(zeromq).toMatchObject({ version: "6.5.0" });
    if (!zeromq) throw new Error("The pinned zeromq package is missing from the runtime lock.");

    const lockfile = structuredClone(inputs.lockfile);
    lockfile.packages["node_modules/zeromq"]!.integrity = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    expect(() =>
      validateRuntimeInputs({
        packageJson: inputs.packageJson,
        lockfile,
        sources: inputs.sources,
        policy: inputs.policy,
      }),
    ).toThrow(PrimeAgentRuntimeBuildError);
  });

  it("removes inherited execution roles and Node preload injection", () => {
    expect(
      cleanRuntimeEnvironment(
        {
          Path: "C:\\Windows",
          PRIME_API_KEY: "provider-key",
          PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
          PRIME_AGENT_BUILD_ID: "spoofed",
          NODE_OPTIONS: "--import=attacker.mjs",
          NODE_PATH: "shadow-modules",
          ELECTRON_RUN_AS_NODE: "0",
        },
        { electronRunAsNode: true },
      ),
    ).toEqual({ Path: "C:\\Windows", PRIME_API_KEY: "provider-key", ELECTRON_RUN_AS_NODE: "1" });
  });

  it("isolates npm from inherited configuration", () => {
    const npmConfigPaths = {
      user: resolve("runtime-build", ".prime-continuim-user-npmrc"),
      global: resolve("runtime-build", ".prime-continuim-global-npmrc"),
    };
    const environment = cleanBuildEnvironment(
      {
        Path: "C:\\Windows",
        npm_config_include: "optional",
        NPM_CONFIG_PLATFORM: "linux",
        PRIME_CONTINUIM_NPM_CLI: "unreviewed/npm-cli.js",
      },
      npmConfigPaths,
    );
    expect(environment).toMatchObject({
      Path: "C:\\Windows",
      npm_config_ignore_scripts: "true",
      npm_config_userconfig: npmConfigPaths.user,
      npm_config_globalconfig: npmConfigPaths.global,
    });
    expect(environment).not.toHaveProperty("npm_config_include");
    expect(environment).not.toHaveProperty("NPM_CONFIG_PLATFORM");
    expect(environment).not.toHaveProperty("PRIME_CONTINUIM_NPM_CLI");
  });
});

describe("Prime Agent runtime tree attestation", () => {
  it("uses file URLs for special paths and fails after any tree mutation", async () => {
    const root = await makeRuntimeFixture("Prime runtime # percent %");
    const inputs = fixtureInputs();
    const entrypoints = await resolveVerifiedEntrypoints(root, inputs.policy);
    expect(entrypoints.moduleUrl).toContain("%23");
    expect(entrypoints.moduleUrl).toContain("%25");

    const manifest = await createRuntimeManifest({
      runtimeDirectory: root,
      inputs,
      npmVersion: "10.9.8",
      smoke: {
        runtimeVersions: { node: "22.22.3", modules: "127", napi: "10", platform: process.platform, arch: process.arch },
      },
    });
    await expect(verifyBuiltRuntime(root, { inputs, policy: inputs.policy })).resolves.toMatchObject({
      manifest: { tree: { sha256: manifest.tree.sha256 } },
    });

    const manifestPath = join(root, "runtime.json");
    const manifestText = await readFile(manifestPath, "utf8");
    const tamperedManifest = JSON.parse(manifestText) as Record<string, any>;
    tamperedManifest.daemon.schemaId = "protocol-tampered";
    await writeFile(manifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`);
    await expect(verifyBuiltRuntime(root, { inputs, policy: inputs.policy })).rejects.toThrow(
      "does not match the pinned policy",
    );
    await writeFile(manifestPath, manifestText);

    await writeFile(join(root, "node_modules", "prime-agent", "dist", "index.js"), "export const changed = true;\n");
    await expect(verifyBuiltRuntime(root, { inputs, policy: inputs.policy })).rejects.toThrow(
      "Runtime tree does not match runtime.json",
    );
  });

  it("rejects an entrypoint traversal before touching the filesystem", async () => {
    const root = await makeRuntimeFixture("runtime-safe");
    const inputs = fixtureInputs();
    await expect(
      resolveVerifiedEntrypoints(root, {
        ...inputs.policy,
        entrypoints: { ...inputs.policy.entrypoints, module: "../outside.js" },
      }),
    ).rejects.toThrow("safe relative path");
  });

  it("keeps canonical containment when the runtime root is reached through a junction", async () => {
    const target = await makeRuntimeFixture("runtime-junction-target");
    const parent = await makeTemporaryDirectory();
    const linkedRoot = join(parent, "linked-runtime");
    try {
      await symlink(target, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        return;
      }
      throw error;
    }

    const entrypoints = await resolveVerifiedEntrypoints(linkedRoot, fixtureInputs().policy);
    await expect(realpath(entrypoints.modulePath)).resolves.toBe(
      await realpath(join(target, "node_modules", "prime-agent", "dist", "index.js")),
    );
    await expect(realpath(entrypoints.cli)).resolves.toBe(
      await realpath(join(target, "node_modules", "prime-agent", "dist", "bundle", "cli.js")),
    );
  });

  it("rejects unattested empty directories and converges without changing attested bytes", async () => {
    const root = await makeRuntimeFixture("runtime-empty-namespace");
    const inputs = fixtureInputs();
    await createRuntimeManifest({
      runtimeDirectory: root,
      inputs,
      npmVersion: "10.9.8",
      smoke: {
        runtimeVersions: { node: "22.22.3", modules: "127", napi: "10", platform: process.platform, arch: process.arch },
      },
    });
    const manifestPath = join(root, "runtime.json");
    const filesPath = join(root, "files.sha256");
    const attestedBytes = await Promise.all([readFile(manifestPath), readFile(filesPath)]);
    await mkdir(join(root, "node_modules", "@mariozechner"));

    await expect(verifyBuiltRuntime(root, { inputs, policy: inputs.policy })).rejects.toThrow(
      "unexpected empty directory: node_modules/@mariozechner",
    );
    await expect(pruneEmptyRuntimeDirectories(root)).resolves.toEqual(["node_modules/@mariozechner"]);
    await expect(Promise.all([readFile(manifestPath), readFile(filesPath)])).resolves.toEqual(attestedBytes);
    await expect(verifyBuiltRuntime(root, { inputs, policy: inputs.policy })).resolves.toBeDefined();
  });

  it("runs daemon-client smoke interaction in a short-lived runtime helper without importing in the builder", async () => {
    const root = await makeRuntimeFixture("runtime-smoke-helper");
    const inputs = fixtureInputs();
    const primeDirectory = join(root, "node_modules", "prime-agent");
    await writeFile(
      join(primeDirectory, "package.json"),
      '{"name":"prime-agent","version":"0.7.0","type":"module"}\n',
    );
    const entrypoints = await resolveVerifiedEntrypoints(root, inputs.policy);
    const runtimeExecutable = await realpath(process.execPath);
    const importMarker = "__primeContinuimRuntimeImportedInBuilder";
    const markerGlobal = globalThis as typeof globalThis & Record<string, unknown>;
    delete markerGlobal[importMarker];
    await writeFile(
      entrypoints.modulePath,
      [
        `globalThis[${JSON.stringify(importMarker)}] = true;`,
        "export class DaemonClient {",
        "  constructor(socketPath) {",
        "    this.hello = {",
        '      type: "daemon_hello",',
        "      socketPath,",
        `      protocol: ${JSON.stringify({ name: inputs.policy.daemon.protocolName, version: inputs.policy.daemon.protocolVersion })},`,
        `      schemaRevision: ${inputs.policy.daemon.schemaRevision},`,
        `      schemaId: ${JSON.stringify(inputs.policy.daemon.schemaId)},`,
        `      appVersion: ${JSON.stringify(inputs.policy.releaseVersion)},`,
        `      runtime: ${JSON.stringify({ buildId: inputs.policy.runtimeBuildId, executablePath: runtimeExecutable, entrypointPath: entrypoints.cli })},`,
        `      serverCapabilities: ${JSON.stringify(inputs.policy.daemon.requiredCapabilities)},`,
        "    };",
        "  }",
        "  async connect() {}",
        "  async waitForHello() { return this.hello; }",
        '  async request() { return { type: "response", command: "shutdown", success: true }; }',
        "  close() {}",
        "}",
        "export class DaemonAgentConnection { static attach() {} }",
        "",
      ].join("\n"),
    );

    const calls: Array<{ command: string; args: string[]; options: SmokeRunnerOptions }> = [];
    const commandRunner = async (
      command: string,
      args: string[],
      options: SmokeRunnerOptions,
    ): Promise<{ stdout: string; stderr: string }> => {
      calls.push({ command, args, options });
      const helperName = basename(args[0] ?? "");
      const helperSource = await readFile(args[0] ?? "", "utf8");
      expect(command).toBe(runtimeExecutable);
      expect(args[1]).toBe(entrypoints.moduleUrl);
      expect(options.env?.ELECTRON_RUN_AS_NODE).toBe("1");
      if (helperName === "runtime-probe.mjs") {
        expect(helperSource).toContain("await import(moduleUrl)");
        return {
          stdout: JSON.stringify({
            node: "22.22.3",
            modules: "127",
            napi: "10",
            platform: process.platform,
            arch: process.arch,
          }),
          stderr: "",
        };
      }
      expect(helperName).toBe("runtime-daemon-client.mjs");
      expect(helperSource).toContain("const runtime = await import(moduleUrl)");
      expect(helperSource).toContain('client.request({ type: "shutdown", force: true }, 5_000)');
      const socketPath = args[2];
      if (!socketPath) throw new Error("daemon helper socket argument missing");
      const result = await execFileAsync(command, args, {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    };

    try {
      await expect(
        smokeRuntime(root, {
          runtimeExecutable,
          electronRunAsNode: true,
          policy: inputs.policy,
          commandRunner,
        }),
      ).resolves.toMatchObject({ runtimeExecutable });
      expect(calls.map((call) => basename(call.args[0] ?? ""))).toEqual([
        "runtime-probe.mjs",
        "runtime-daemon-client.mjs",
      ]);
      expect(markerGlobal[importMarker]).toBeUndefined();

      const invalidHelloRunner = async (
        command: string,
        args: string[],
        options: SmokeRunnerOptions,
      ): Promise<{ stdout: string; stderr: string }> => {
        const result = await commandRunner(command, args, options);
        if (basename(args[0] ?? "") !== "runtime-daemon-client.mjs") return result;
        const interaction = JSON.parse(result.stdout) as { hello: { runtime: { entrypointPath: string } } };
        interaction.hello.runtime.entrypointPath = join(root, "forged-cli.js");
        return { ...result, stdout: JSON.stringify(interaction) };
      };
      await expect(
        smokeRuntime(root, {
          runtimeExecutable,
          electronRunAsNode: true,
          policy: inputs.policy,
          commandRunner: invalidHelloRunner,
        }),
      ).rejects.toThrow("incompatible or unverified hello");

      const invalidShutdownRunner = async (
        command: string,
        args: string[],
        options: SmokeRunnerOptions,
      ): Promise<{ stdout: string; stderr: string }> => {
        const result = await commandRunner(command, args, options);
        if (basename(args[0] ?? "") !== "runtime-daemon-client.mjs") return result;
        const interaction = JSON.parse(result.stdout) as { response: { success: boolean } };
        interaction.response.success = false;
        return { ...result, stdout: JSON.stringify(interaction) };
      };
      await expect(
        smokeRuntime(root, {
          runtimeExecutable,
          electronRunAsNode: true,
          policy: inputs.policy,
          commandRunner: invalidShutdownRunner,
        }),
      ).rejects.toThrow("did not confirm smoke shutdown");
      expect(markerGlobal[importMarker]).toBeUndefined();
    } finally {
      delete markerGlobal[importMarker];
    }
  });
});

interface SmokeRunnerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

describe("Prime Agent package seed selection", () => {
  it("prunes nested empty namespace directories from the leaves upward", async () => {
    const root = await makeTemporaryDirectory();
    await Promise.all([
      mkdir(join(root, "node_modules", "@empty", "nested", "leaf"), { recursive: true }),
      mkdir(join(root, "node_modules", "kept"), { recursive: true }),
    ]);
    await writeFile(join(root, "node_modules", "kept", "runtime.js"), "export {};\n");

    await expect(pruneEmptyRuntimeDirectories(root)).resolves.toEqual([
      "node_modules/@empty/nested/leaf",
      "node_modules/@empty/nested",
      "node_modules/@empty",
    ]);
    expect(await readdir(join(root, "node_modules"))).toEqual(["kept"]);
  });

  it("preserves non-empty directories and every file they contain", async () => {
    const root = await makeTemporaryDirectory();
    const nestedDirectory = join(root, "node_modules", "fixture", "nested");
    const runtimePath = join(nestedDirectory, "runtime.js");
    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(runtimePath, "export const ready = true;\n");

    await expect(pruneEmptyRuntimeDirectories(root)).resolves.toEqual([]);
    await expect(readFile(runtimePath, "utf8")).resolves.toBe("export const ready = true;\n");
    await expect(readdir(join(root, "node_modules", "fixture"))).resolves.toEqual(["nested"]);
  });

  it("rejects a symbolic-link root before traversing its target", async () => {
    const root = await makeTemporaryDirectory();
    const target = join(root, "target");
    const linkedRoot = join(root, "linked-runtime");
    await mkdir(target);
    try {
      await symlink(target, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        return;
      }
      throw error;
    }

    await expect(pruneEmptyRuntimeDirectories(linkedRoot)).rejects.toThrow("root must be a plain directory");
    await expect(readdir(target)).resolves.toEqual([]);
  });

  it("removes reviewed files and directories from the legacy in-seed asset cache", async () => {
    const workspace = await makeTemporaryDirectory();
    const root = join(workspace, "runtime");
    const assets = join(root, "cache", "assets");
    const reviewed = [
      `${"a".repeat(64)}-asset-a.tgz`,
      `${"b".repeat(64)}-asset-b.tgz`,
    ] as const;
    await mkdir(assets, { recursive: true });
    await Promise.all([
      writeFile(join(assets, reviewed[0]), "reviewed-a"),
      writeFile(join(assets, reviewed[1]), "reviewed-b"),
    ]);

    await expect(removeLegacyRuntimeAssetCache(root, reviewed)).resolves.toBe(true);
    await expect(readdir(root)).resolves.toEqual([]);
    const quarantineRoot = join(workspace, "runtime-cache");
    const quarantines = await readdir(quarantineRoot);
    expect(quarantines).toHaveLength(1);
    expect(quarantines[0]).toMatch(/^legacy-v1-/);
    const quarantinedAssets = join(quarantineRoot, quarantines[0]!, "assets");
    await expect(readdir(quarantinedAssets)).resolves.toEqual([...reviewed]);
    await expect(readFile(join(quarantinedAssets, reviewed[0]), "utf8")).resolves.toBe("reviewed-a");
  });

  it("treats an absent legacy asset cache as an idempotent no-op", async () => {
    const workspace = await makeTemporaryDirectory();
    const root = join(workspace, "runtime");
    await mkdir(root);

    await expect(removeLegacyRuntimeAssetCache(root, [`${"a".repeat(64)}-asset-a.tgz`])).resolves.toBe(false);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("rejects and preserves unknown legacy cache remnants", async () => {
    const workspace = await makeTemporaryDirectory();
    const root = join(workspace, "runtime");
    const assets = join(root, "cache", "assets");
    const reviewed = `${"a".repeat(64)}-reviewed.tgz`;
    await mkdir(assets, { recursive: true });
    await Promise.all([
      writeFile(join(assets, reviewed), "reviewed"),
      writeFile(join(assets, "unknown.bin"), "unknown"),
    ]);

    await expect(removeLegacyRuntimeAssetCache(root, [reviewed])).rejects.toThrow(
      "unexpected entry and requires inspection",
    );
    await expect(readdir(assets)).resolves.toEqual([reviewed, "unknown.bin"]);
    await expect(readFile(join(assets, "unknown.bin"), "utf8")).resolves.toBe("unknown");
  });

  it("removes package-manager placeholders that Electron excludes from resources", async () => {
    const root = await makeTemporaryDirectory();
    const packageDirectory = join(root, "node_modules", "fixture");
    await mkdir(packageDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(packageDirectory, ".gitkeep"), ""),
      writeFile(join(packageDirectory, "runtime.js"), "export {};\n"),
    ]);

    await expect(pruneRuntimePackagingNoise(root, { packaging: { excludedBasenames: [".gitkeep"] } })).resolves.toEqual([
      "node_modules/fixture/.gitkeep",
    ]);
    expect(await readdir(packageDirectory)).toEqual(["runtime.js"]);
  });

  it("keeps only the selected content-addressed install", async () => {
    const root = await makeTemporaryDirectory();
    const installs = join(root, "installs");
    const selected = join(installs, "prime-agent-selected");
    await Promise.all([
      mkdir(selected, { recursive: true }),
      mkdir(join(installs, "prime-agent-obsolete-a"), { recursive: true }),
      mkdir(join(installs, "prime-agent-obsolete-b"), { recursive: true }),
    ]);

    await removeObsoleteRuntimeInstalls(root, selected);

    expect(await readdir(installs)).toEqual(["prime-agent-selected"]);
    await expect(verifyOnlySelectedRuntimeInstall(root, selected)).resolves.toBeUndefined();
    await expect(
      writeCurrentPointer(
        root,
        selected,
        {
          release: { version: "0.7.0" },
          platform: process.platform,
          arch: process.arch,
          tree: { sha256: "d".repeat(64) },
        },
        "e".repeat(64),
      ),
    ).resolves.toMatchObject({ manifestSha256: "e".repeat(64), treeSha256: "d".repeat(64) });
  });

  it("rejects an extra install in a seed selected for packaging", async () => {
    const root = await makeTemporaryDirectory();
    const installs = join(root, "installs");
    const selected = join(installs, "prime-agent-selected");
    await Promise.all([
      mkdir(selected, { recursive: true }),
      mkdir(join(installs, "prime-agent-unselected"), { recursive: true }),
    ]);

    await expect(verifyOnlySelectedRuntimeInstall(root, selected)).rejects.toThrow("only the pointer-selected image");
  });

  it("rejects a selected directory outside the generated installs root", async () => {
    const root = await makeTemporaryDirectory();
    await mkdir(join(root, "installs"), { recursive: true });
    const outside = join(root, "outside");
    await mkdir(outside);

    await expect(removeObsoleteRuntimeInstalls(root, outside)).rejects.toThrow("not an immediate child");
  });
});

describe("Prime Agent runtime build lock", () => {
  it("blocks a live owner and recovers a dead owner", async () => {
    const root = await makeTemporaryDirectory();
    const release = await acquireBuildLock(root);
    await expect(acquireBuildLock(root)).rejects.toThrow("already held");
    await release();

    await writeFile(join(root, ".build.lock"), `${JSON.stringify({ pid: 2_147_483_647 })}\n`);
    const recoveredRelease = await acquireBuildLock(root);
    await recoveredRelease();
    await expect(readdir(root)).resolves.toEqual([]);
  });
});

async function makeRuntimeFixture(name: string): Promise<string> {
  const parent = await makeTemporaryDirectory();
  const root = join(parent, name);
  const prime = join(root, "node_modules", "prime-agent");
  await mkdir(join(prime, "dist", "bundle"), { recursive: true });
  await mkdir(join(root, "node_modules", "zeromq", "build", "fixture"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), '{"name":"fixture"}\n'),
    writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}\n'),
    writeFile(join(prime, "package.json"), '{"name":"prime-agent","version":"0.7.0"}\n'),
    writeFile(join(prime, "dist", "index.js"), "export class DaemonClient {}\n"),
    writeFile(join(prime, "dist", "bundle", "cli.js"), "process.exitCode = 0;\n"),
    writeFile(join(root, "node_modules", "zeromq", "build", "fixture", "addon.node"), "native-fixture"),
  ]);
  return root;
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "prime-continuim-runtime-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureInputs() {
  const policy = {
    releaseVersion: "0.7.0",
    runtimeBuildId: "be9e2fa-dirty",
    minimumNodeVersion: "22.8.0",
    npmVersion: "10.9.8",
    install: {
      ignoreScripts: true,
      omitDev: true,
      omitOptional: true,
      installStrategy: "hoisted",
      targetNativePrebuildsOnly: true,
    },
    packaging: { excludedBasenames: [".gitkeep"] },
    entrypoints: {
      module: "node_modules/prime-agent/dist/index.js",
      cli: "node_modules/prime-agent/dist/bundle/cli.js",
    },
    daemon: {
      protocolName: "prime-agent.daemon",
      protocolVersion: 7,
      schemaRevision: 13,
      schemaId: "protocol-7-schema-13-816309b1cd50",
      requiredCapabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
    },
  };
  return {
    policy,
    sources: {
      release: { repository: "https://github.com/PrimeIntellect-ai/prime-agent", tag: "v0.7.0", version: "0.7.0", commit: "be9e2fa" },
      assets: [],
    },
    sourcesSha256: "a".repeat(64),
    policySha256: "b".repeat(64),
    lockfileSha256: "c".repeat(64),
  };
}
