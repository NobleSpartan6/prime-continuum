import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runtimeLib from "../../scripts/prime-agent-runtime-lib.mjs";
import {
  PrimeAgentRuntimeBuildError,
  acquireBuildLock,
  applyPinnedPrimeAgentSecurityPatches,
  cleanBuildEnvironment,
  cleanRuntimeEnvironment,
  createRuntimeManifest,
  loadRuntimeInputs,
  pruneRuntimePackagingNoise,
  pruneReviewedRuntimeDirectories,
  removeObsoleteRuntimeInstalls,
  resolveVerifiedEntrypoints,
  smokeRuntime,
  validateRuntimeInputs,
  verifyBuiltRuntime,
  verifyOnlySelectedRuntimeInstall,
  verifyReleaseAssets,
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
    expect(inputs.sources.release).toEqual({
      repository: "https://github.com/PrimeIntellect-ai/prime-agent",
      tag: "v0.7.2",
      version: "0.7.2",
      commit: "83a0f9f9566219551fcb6ffaf7f519a815749a58",
    });
    expect(inputs.policy).toMatchObject({
      releaseVersion: "0.7.2",
      runtimeBuildId: "83a0f9f-dirty",
      criticalPackages: {
        "prime-agent": {
          version: "0.7.2",
          integrity: "sha512-kRAuworIlI55Lwh1O5Mofc8jNvhtmYB89dBy6h+LHXWTw8SbJ9dQ3+/mmgrhzlpuvBy7LNmLpQIzA0KLfyJarg==",
        },
      },
    });
    expect(inputs.packageJson).toMatchObject({
      version: "0.7.2",
      dependencies: {
        "extract-zip": "npm:@electron-internal/extract-zip@1.0.5",
        "prime-agent":
          "https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.7.2/prime-agent-0.7.2.tgz",
      },
    });
    expect(inputs.sources).not.toHaveProperty("codexAppServer");
    expect(inputs.policy).not.toHaveProperty("codexAppServer");
    expect(inputs.sources.assets).toHaveLength(4);
    expect(inputs.sources.assets[0]).toEqual({
      packageName: "prime-agent",
      fileName: "prime-agent-0.7.2.tgz",
      url: "https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.7.2/prime-agent-0.7.2.tgz",
      size: 9_387_295,
      sha256: "bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e",
      integrity: "sha512-kRAuworIlI55Lwh1O5Mofc8jNvhtmYB89dBy6h+LHXWTw8SbJ9dQ3+/mmgrhzlpuvBy7LNmLpQIzA0KLfyJarg==",
    });
    expect(inputs.sources.assets.every((asset: { url: string }) => !asset.url.includes("openai/codex"))).toBe(true);
    expect(inputs.sources.allowedDownloadHosts).not.toContain("raw.githubusercontent.com");
    expect(inputs.lockfile.lockfileVersion).toBe(3);
    expect(Object.keys(inputs.lockfile.packages)).toHaveLength(202);
    expect(inputs.lockfile.packages["node_modules/extract-zip"]).toMatchObject({
      name: "@electron-internal/extract-zip",
      version: "1.0.5",
    });
    expect(Object.keys(inputs.lockfile.packages).filter((path) => path.endsWith("/node_modules/extract-zip"))).toEqual([]);
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

    const nestedVulnerableLock = structuredClone(inputs.lockfile);
    nestedVulnerableLock.packages["node_modules/prime-agent/node_modules/extract-zip"] = {
      version: "2.0.1",
      resolved: "https://registry.npmjs.org/extract-zip/-/extract-zip-2.0.1.tgz",
      integrity: "sha512-GDhU9ntwuKyGXdZBUgTIe+vXnWj0fppUEtMDL0+idd5Sta8TGpHssn/eusA9mrPr9qNDym6SxAYZjNvCn/9RBg==",
    };
    const nestedPolicy = structuredClone(inputs.policy);
    nestedPolicy.lockPackageEntries += 1;
    expect(() => validateRuntimeInputs({
      packageJson: inputs.packageJson,
      lockfile: nestedVulnerableLock,
      sources: inputs.sources,
      policy: nestedPolicy,
    })).toThrow("Hardened extract-zip substitution drifted");

    for (const side of ["sources", "policy"] as const) {
      const legacySources = structuredClone(inputs.sources) as Record<string, unknown>;
      const legacyPolicy = structuredClone(inputs.policy) as Record<string, unknown>;
      (side === "sources" ? legacySources : legacyPolicy).codexAppServer = {};
      expect(() => validateRuntimeInputs({
        packageJson: inputs.packageJson,
        lockfile: inputs.lockfile,
        sources: legacySources,
        policy: legacyPolicy,
      })).toThrow("must not declare a companion backend");
    }
  });

  it("fails closed before patching an unreviewed Prime Agent bundle", async () => {
    const root = await makeTemporaryDirectory();
    const bundle = join(root, "node_modules", "prime-agent", "dist", "bundle");
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, "chunk-CAY2X72A.js"), "// ../../node_modules/extract-zip/index.js\n// dist/main.js\n");

    await expect(applyPinnedPrimeAgentSecurityPatches(root)).rejects.toThrow(
      "Prime Agent bundle security patch source drifted",
    );
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
          NAPI_RS_NATIVE_LIBRARY_PATH: "attacker.node",
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

describe("Prime Agent runtime asset download liveness", () => {
  it("retries a bounded pre-body UND_ERR_SOCKET failure and still verifies exact bytes", async () => {
    const cache = await temporaryDirectory("prime-runtime-fetch-retry-");
    const bytes = Buffer.from("pinned asset");
    const inputs = downloadInputs(bytes);
    const delays: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) {
        const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
        throw Object.assign(new TypeError("fetch failed"), { cause: socketError });
      }
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;

    const verified = await verifyReleaseAssets(inputs as never, cache, {
      fetchImpl,
      sleep: async (milliseconds: number) => { delays.push(milliseconds); },
    });

    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
    expect(await readFile(verified[0]!)).toEqual(bytes);
  });

  it("stops after three pre-body socket attempts", async () => {
    const cache = await temporaryDirectory("prime-runtime-fetch-retry-limit-");
    const delays: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
      throw Object.assign(new TypeError("fetch failed"), { cause: socketError });
    }) as typeof fetch;

    await expect(verifyReleaseAssets(downloadInputs(Buffer.from("pinned asset")) as never, cache, {
      fetchImpl,
      sleep: async (milliseconds: number) => { delays.push(milliseconds); },
    })).rejects.toThrow("fetch failed");
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
    expect(await readdir(cache)).toEqual([]);
  });

  it("does not retry HTTP or integrity failures", async () => {
    const bytes = Buffer.from("pinned asset");
    const sleep = async () => { throw new Error("must not retry"); };

    const httpCache = await temporaryDirectory("prime-runtime-fetch-http-");
    let httpCalls = 0;
    await expect(verifyReleaseAssets(downloadInputs(bytes) as never, httpCache, {
      fetchImpl: (async () => {
        httpCalls += 1;
        return new Response("missing", { status: 404 });
      }) as typeof fetch,
      sleep,
    })).rejects.toThrow("Could not download asset.tgz: HTTP 404");
    expect(httpCalls).toBe(1);
    expect(await readdir(httpCache)).toEqual([]);

    const digestCache = await temporaryDirectory("prime-runtime-fetch-digest-");
    let digestCalls = 0;
    await expect(verifyReleaseAssets(downloadInputs(bytes) as never, digestCache, {
      fetchImpl: (async () => {
        digestCalls += 1;
        return new Response(Buffer.from("broken asset"), { status: 200 });
      }) as typeof fetch,
      sleep,
    })).rejects.toThrow("Downloaded bytes did not match the pinned asset.tgz digest");
    expect(digestCalls).toBe(1);
    expect(await readdir(digestCache)).toEqual([]);
  });

  it("aborts a release fetch that never produces response headers", async () => {
    const cache = await temporaryDirectory("prime-runtime-fetch-timeout-");
    const inputs = downloadInputs(Buffer.from("pinned asset"));
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolveStarted) => { markFetchStarted = resolveStarted; });
    const fetchImpl = (() => {
      markFetchStarted();
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    vi.useFakeTimers();
    try {
      const rejection = expect(verifyReleaseAssets(inputs as never, cache, {
        fetchImpl,
        totalTimeoutMs: 25,
        noProgressTimeoutMs: 10,
      })).rejects.toThrow("Download timed out for asset.tgz; check the network or proxy and retry");

      await fetchStarted;
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(await readdir(cache)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a response body that stops making progress", async () => {
    const cache = await temporaryDirectory("prime-runtime-body-timeout-");
    const inputs = downloadInputs(Buffer.from("pinned asset"));
    const fetchImpl = (async () => new Response(new ReadableStream({ start: () => undefined }), {
      status: 200,
    })) as typeof fetch;

    await expect(verifyReleaseAssets(inputs as never, cache, {
      fetchImpl,
      totalTimeoutMs: 250,
      noProgressTimeoutMs: 25,
    })).rejects.toThrow("Download made no progress for asset.tgz; check the network or proxy and retry")
    expect(await readdir(cache)).toEqual([]);
  });
});

function downloadInputs(bytes: Buffer) {
  return {
    sources: {
      allowedDownloadHosts: ["downloads.example.test"],
      assets: [{
        fileName: "asset.tgz",
        url: "https://downloads.example.test/asset.tgz",
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }],
    },
  };
}

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

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
        runtimeVersions: { node: "22.22.3", modules: "127", napi: "10", platform: process.platform, arch: process.arch, bundleImportGraphComplete: true },
      },
    });
    await expect(verifyBuiltRuntime(root, { inputs, policy: inputs.policy })).resolves.toMatchObject({
      manifest: { tree: { sha256: manifest.tree.sha256 } },
    });

    const manifestPath = join(root, "runtime.json");
    const manifestText = await readFile(manifestPath, "utf8");
    const incompleteSmokeManifest = JSON.parse(manifestText) as Record<string, any>;
    delete incompleteSmokeManifest.smokeRuntime.bundleImportGraphComplete;
    await writeFile(manifestPath, `${JSON.stringify(incompleteSmokeManifest, null, 2)}\n`);
    await expect(verifyBuiltRuntime(root, { inputs, policy: inputs.policy })).rejects.toThrow(
      "Runtime manifest build or smoke identity is invalid",
    );
    await writeFile(manifestPath, manifestText);

    const tamperedManifest = JSON.parse(manifestText) as Record<string, any>;
    tamperedManifest.daemon.schemaId = "protocol-tampered";
    await writeFile(manifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`);
    await expect(verifyBuiltRuntime(root, { inputs, policy: inputs.policy })).rejects.toThrow(
      "does not match the pinned policy",
    );
    await writeFile(manifestPath, manifestText);

    const legacyManifest = JSON.parse(manifestText) as Record<string, unknown>;
    legacyManifest.codexAppServer = { releaseVersion: "0.147.0" };
    await writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
    await expect(verifyBuiltRuntime(root, { inputs, policy: inputs.policy })).rejects.toThrow(
      "does not match the pinned policy",
    );
    await writeFile(manifestPath, manifestText);

    await writeFile(join(root, "node_modules", "prime-agent", "dist", "index.js"), "export const changed = true;\n");
    await expect(verifyBuiltRuntime(root, { inputs, policy: inputs.policy })).rejects.toThrow(
      "Runtime tree does not match runtime.json",
    );
  });

  it("refuses to attest any legacy companion namespace", async () => {
    const root = await makeRuntimeFixture("runtime-with-legacy-companion");
    const companion = join(root, "companions", "legacy");
    await mkdir(companion, { recursive: true });
    await writeFile(join(companion, "backend.exe"), "legacy backend");

    await expect(createRuntimeManifest({
      runtimeDirectory: root,
      inputs: fixtureInputs(),
      npmVersion: "10.9.8",
      smoke: {
        runtimeVersions: { node: "22.22.3", modules: "127", napi: "10", platform: process.platform, arch: process.arch, bundleImportGraphComplete: true },
      },
    })).rejects.toThrow("must not contain a companion backend");
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

  it("gives cold browser startup and screenshot capture distinct bounded smoke custody", async () => {
    const root = await makeRuntimeFixture("runtime-browser-smoke-timeout");
    const runtimeExecutable = await realpath(process.execPath);
    const calls: Array<{ args: string[]; options: SmokeRunnerOptions }> = [];
    const commandRunner = async (
      command: string,
      args: string[],
      options: SmokeRunnerOptions,
    ): Promise<{ stdout: string; stderr: string }> => {
      expect(command).toBe(runtimeExecutable);
      expect(options.env?.PLAYWRIGHT_MCP_TIMEOUT_ACTION).toBe("30000");
      expect(options.env?.PRIME_CONTINUIM_BROWSER_SMOKE_SKIP_FONT_READY).toBe("1");
      expect(options.env?.PW_TEST_SCREENSHOT_NO_FONTS_READY).toBeUndefined();
      calls.push({ args, options });
      const operation = args[1] === "doctor" ? "doctor" : args[2];
      if (operation === "doctor") {
        return {
          stdout: JSON.stringify({
            bridgeVersion: 1,
            controller: "playwright-core/1.63.0-alpha-2026-08-05",
            engine: "verified-electron-host",
            protocol: "prime-continuim.browser.v1",
            ready: true,
          }),
          stderr: "",
        };
      }
      if (operation === "snapshot") return { stdout: '- button "Before" [ref=e1]\n', stderr: "" };
      if (operation === "find") return { stdout: 'button "Before"\n', stderr: "" };
      if (operation === "eval") return { stdout: '"After"\n', stderr: "" };
      if (operation === "screenshot") {
        const filename = args.find((argument) => argument.startsWith("--filename="))?.slice("--filename=".length);
        if (!filename) throw new Error("browser smoke screenshot filename missing");
        await writeFile(filename, Buffer.from("89504e470d0a1a0a", "hex"));
      }
      return { stdout: "", stderr: "" };
    };

    await expect(runtimeLib.smokeBrowserBridge(root, {
      runtimeExecutable,
      policy: fixtureInputs().policy,
      commandRunner,
    })).resolves.toMatchObject({
      verified: true,
      operations: ["doctor", "open", "snapshot", "find", "click", "eval", "screenshot", "close"],
    });
    expect(calls).toHaveLength(8);
    const doctorCall = calls.find(({ args }) => args[1] === "doctor");
    const openCall = calls.find(({ args }) => args[2] === "open");
    const screenshotCall = calls.find(({ args }) => args[2] === "screenshot");
    expect(doctorCall?.options.timeoutMs).toBe(25_000);
    expect(openCall?.options.timeoutMs).toBe(45_000);
    expect(screenshotCall?.options.timeoutMs).toBe(40_000);
  });

  it("closes one exact session after an open rejection before removing smoke custody", async () => {
    const root = await makeRuntimeFixture("runtime-browser-smoke-open-rejection");
    const runtimeExecutable = await realpath(process.execPath);
    const calls: Array<{ args: string[]; options: SmokeRunnerOptions }> = [];
    const commandRunner = async (
      command: string,
      args: string[],
      options: SmokeRunnerOptions,
    ): Promise<{ stdout: string; stderr: string }> => {
      expect(command).toBe(runtimeExecutable);
      calls.push({ args, options });
      const operation = args[1] === "doctor" ? "doctor" : args[2];
      if (operation === "doctor") return { stdout: exactBrowserDoctorResult(), stderr: "" };
      if (operation === "open") throw new Error("simulated open rejection");
      return { stdout: "", stderr: "" };
    };

    await expect(runtimeLib.smokeBrowserBridge(root, {
      runtimeExecutable,
      policy: fixtureInputs().policy,
      commandRunner,
    })).rejects.toThrow("simulated open rejection");

    const openCall = calls.find(({ args }) => args[2] === "open");
    const closeCalls = calls.filter(({ args }) => args[2] === "close");
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]?.args[1]).toBe(openCall?.args[1]);
    expect(closeCalls[0]?.options.timeoutMs).toBe(10_000);
    await expect(readdir(openCall?.options.cwd ?? "")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed and retains smoke custody when exact close fails", async () => {
    const root = await makeRuntimeFixture("runtime-browser-smoke-close-failure");
    const runtimeExecutable = await realpath(process.execPath);
    let scratchDirectory: string | undefined;
    const commandRunner = async (
      command: string,
      args: string[],
      options: SmokeRunnerOptions,
    ): Promise<{ stdout: string; stderr: string }> => {
      expect(command).toBe(runtimeExecutable);
      scratchDirectory = options.cwd;
      const operation = args[1] === "doctor" ? "doctor" : args[2];
      if (operation === "doctor") return { stdout: exactBrowserDoctorResult(), stderr: "" };
      if (operation === "open") throw new Error("simulated open rejection");
      if (operation === "close") throw new Error("simulated exact close failure");
      return { stdout: "", stderr: "" };
    };

    try {
      await expect(runtimeLib.smokeBrowserBridge(root, {
        runtimeExecutable,
        policy: fixtureInputs().policy,
        commandRunner,
      })).rejects.toThrow("simulated exact close failure");
      expect(scratchDirectory).toBeDefined();
      await expect(readdir(scratchDirectory ?? "")).resolves.toContain("state");
    } finally {
      if (scratchDirectory) await rm(scratchDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed and retains evidence when close cannot prove retirement", async () => {
    const root = await makeRuntimeFixture("runtime-browser-smoke-retirement-failure");
    const runtimeExecutable = await realpath(process.execPath);
    let scratchDirectory: string | undefined;
    let launchEvidencePath: string | undefined;
    const commandRunner = async (
      command: string,
      args: string[],
      options: SmokeRunnerOptions,
    ): Promise<{ stdout: string; stderr: string }> => {
      expect(command).toBe(runtimeExecutable);
      scratchDirectory = options.cwd;
      const operation = args[1] === "doctor" ? "doctor" : args[2];
      if (operation === "doctor") return { stdout: exactBrowserDoctorResult(), stderr: "" };
      if (operation === "open") {
        const stateDirectory = options.env?.PRIME_CONTINUIM_BROWSER_STATE_DIR;
        if (!stateDirectory) throw new Error("browser smoke state directory missing");
        launchEvidencePath = join(stateDirectory, "launch.json");
        await writeFile(launchEvidencePath, "retained evidence\n", { mode: 0o600 });
        throw new Error("simulated open rejection");
      }
      return { stdout: "", stderr: "" };
    };

    try {
      await expect(runtimeLib.smokeBrowserBridge(root, {
        runtimeExecutable,
        policy: fixtureInputs().policy,
        commandRunner,
      })).rejects.toThrow("Browser smoke retained private lifecycle state: launch.json");
      expect(launchEvidencePath).toBeDefined();
      await expect(readFile(launchEvidencePath ?? "", "utf8")).resolves.toBe("retained evidence\n");
    } finally {
      if (scratchDirectory) await rm(scratchDirectory, { recursive: true, force: true });
    }
  });

  it("retains bounded stdout and stderr when a runtime command fails", async () => {
    await expect(runtimeLib.runCommand(process.execPath, [
      "--eval",
      "process.stderr.write('visible stderr'); process.stdout.write('visible stdout'); process.exit(7)",
    ], { timeoutMs: 5_000 })).rejects.toThrow(/visible stderr[\s\S]*visible stdout/);
  });

  it("rejects unattested empty directories and converges without changing attested bytes", async () => {
    const root = await makeRuntimeFixture("runtime-empty-namespace");
    const inputs = fixtureInputs();
    await createRuntimeManifest({
      runtimeDirectory: root,
      inputs,
      npmVersion: "10.9.8",
      smoke: {
        runtimeVersions: { node: "22.22.3", modules: "127", napi: "10", platform: process.platform, arch: process.arch, bundleImportGraphComplete: true },
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
      '{"name":"prime-agent","version":"0.7.1","type":"module"}\n',
    );
    const daemonSupervisorPath = join(
      primeDirectory,
      "dist",
      "modes",
      "daemon",
      "daemon-supervisor.js",
    );
    await mkdir(dirname(daemonSupervisorPath), { recursive: true });
    await writeFile(
      daemonSupervisorPath,
      [
        "export class DaemonSupervisor {",
        "  workers = new Map();",
        "  isWorkerStopping(worker) { return worker.intentionalStop || worker.descriptor.stopRequestedAt !== undefined; }",
        "  effectiveWorkerState(worker) { if (this.isWorkerStopping(worker)) return \"stopping\"; if (worker.descriptor.lifecycle === \"ready\" && worker.client === undefined) return \"recovering\"; return worker.descriptor.lifecycle; }",
        "  async reclaimStaleWorkerRegistration(worker) {",
        "    if (worker.client !== undefined || worker.recovery !== undefined || worker.descriptor.stopRequestedAt === undefined) return false;",
        "    if (!['gone', 'replaced'].includes(this.processIdentity(worker.descriptor.pid, worker.descriptor.processStartId))) return false;",
        "    this.scheduleWorkerStopFinalization(worker);",
        "    if (worker.stopFinalization) await worker.stopFinalization;",
        "    if (this.workers.get(worker.descriptor.workerId) === worker) throw new Error('still cleaning');",
        "    return true;",
        "  }",
        "  async handleCommand(client, command) {",
        "    const worker = [...this.workers.values()].find((candidate) => candidate.descriptor.rootActiveSessionId === command.activeSessionId);",
        "    this.assertWorkerAccessibleToClient(client, worker, command.activeSessionId);",
        "    worker.intentionalStop = false;",
        "    worker.descriptor.stopRequestedAt = undefined;",
        "    worker.descriptor.archiveOnStop = undefined;",
        '    worker.descriptor.lifecycle = "recovering";',
        "    worker.descriptor.consecutiveFailures = 0;",
        "    this.persistWorker(worker);",
        "    await this.recoverWorker(worker);",
        '    return { id: command.id, type: "response", command: command.type, success: true };',
        "  }",
        "}",
        "",
      ].join("\n"),
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
      expect(options.env?.ELECTRON_RUN_AS_NODE).toBe("1");
      if (helperName === "runtime-probe.mjs") {
        expect(args[1]).toBe(entrypoints.moduleUrl);
        expect(helperSource).toContain("await import(moduleUrl)");
        expect(helperSource).toContain('"@mistralai/mistralai"');
        expect(helperSource).toContain('"openai-codex-responses-MURTF24R.js"');
        return {
          stdout: JSON.stringify({
            node: "22.22.3",
            modules: "127",
            napi: "10",
            platform: process.platform,
            arch: process.arch,
            bundleImportGraphComplete: true,
          }),
          stderr: "",
        };
      }
      if (helperName === "runtime-retry-worker-probe.mjs") {
        expect(args[1]).toBe(pathToFileURL(await realpath(daemonSupervisorPath)).href);
        expect(helperSource).toContain('type: "retry_worker"');
        expect(helperSource).toContain('stopRequestedAt: candidate.descriptor.stopRequestedAt');
        expect(helperSource).toContain('effectiveWorkerState(disconnectedWorker)');
        expect(helperSource).toContain('reclaimStaleWorkerRegistration(staleWorker)');
        const result = await execFileAsync(command, args, {
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeoutMs,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        });
        return { stdout: String(result.stdout), stderr: String(result.stderr) };
      }
      expect(helperName).toBe("runtime-daemon-client.mjs");
      expect(args[1]).toBe(entrypoints.moduleUrl);
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
        "runtime-retry-worker-probe.mjs",
        "runtime-daemon-client.mjs",
      ]);
      expect(markerGlobal[importMarker]).toBeUndefined();

      const invalidRetryRunner = async (
        command: string,
        args: string[],
        options: SmokeRunnerOptions,
      ): Promise<{ stdout: string; stderr: string }> => {
        const result = await commandRunner(command, args, options);
        if (basename(args[0] ?? "") !== "runtime-retry-worker-probe.mjs") return result;
        return {
          ...result,
          stdout: JSON.stringify({
            retryWorkerOrdering: false,
            disconnectedWorkerState: true,
            staleWorkerReclaimed: true,
          }),
        };
      };
      await expect(
        smokeRuntime(root, {
          runtimeExecutable,
          electronRunAsNode: true,
          policy: inputs.policy,
          commandRunner: invalidRetryRunner,
        }),
      ).rejects.toThrow("did not prove current self-healing semantics");

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

function exactBrowserDoctorResult(): string {
  return JSON.stringify({
    bridgeVersion: 1,
    controller: "playwright-core/1.63.0-alpha-2026-08-05",
    engine: "verified-electron-host",
    protocol: "prime-continuim.browser.v1",
    ready: true,
  });
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
      writeFile(join(packageDirectory, "runtime.d.ts"), "export {};\n"),
      writeFile(join(packageDirectory, "runtime.js.map"), "{}\n"),
      writeFile(join(packageDirectory, "runtime.js"), "export {};\n"),
    ]);

    await expect(pruneRuntimePackagingNoise(root, {
      packaging: {
        excludedBasenames: [".gitkeep"],
        excludedSuffixes: [".d.ts", ".d.mts", ".d.cts", ".map"],
      },
    })).resolves.toEqual([
      "node_modules/fixture/.gitkeep",
      "node_modules/fixture/runtime.d.ts",
      "node_modules/fixture/runtime.js.map",
    ]);
    expect(await readdir(packageDirectory)).toEqual(["runtime.js"]);
  });

  it("prunes only an exact reviewed package directory after validating its complete identity", async () => {
    const root = await makeTemporaryDirectory();
    const packageDirectory = join(root, "node_modules", "fixture");
    const target = join(packageDirectory, "src");
    const packageJson = '{"name":"fixture","version":"1.0.0"}\n';
    await mkdir(join(target, "nested"), { recursive: true });
    await Promise.all([
      writeFile(join(packageDirectory, "package.json"), packageJson),
      writeFile(join(target, "a.ts"), "export const a = 1;\n"),
      writeFile(join(target, "nested", "b.ts"), "export const b = 2;\n"),
    ]);
    const entries = [
      { path: "a.ts", bytes: "export const a = 1;\n" },
      { path: "nested/b.ts", bytes: "export const b = 2;\n" },
    ].map((entry) => ({
      ...entry,
      size: Buffer.byteLength(entry.bytes),
      sha256: createHash("sha256").update(entry.bytes).digest("hex"),
    }));
    const treeSource = entries.map((entry) => `${entry.sha256} ${entry.size} ${entry.path}\n`).join("");
    const policy = {
      packaging: {
        reviewedPrunedDirectories: [{
          relativePath: "node_modules/fixture/src",
          package: "fixture",
          version: "1.0.0",
          packageJsonSha256: createHash("sha256").update(packageJson).digest("hex"),
          fileCount: entries.length,
          totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
          treeSha256: createHash("sha256").update(treeSource).digest("hex"),
        }],
      },
    };

    await expect(pruneReviewedRuntimeDirectories(root, policy)).resolves.toEqual([
      "node_modules/fixture/src",
    ]);
    await expect(realpath(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(packageDirectory, "package.json"), "utf8")).resolves.toBe(packageJson);
  });

  it("fails closed without pruning when a reviewed directory identity drifts", async () => {
    const root = await makeTemporaryDirectory();
    const packageDirectory = join(root, "node_modules", "fixture");
    const target = join(packageDirectory, "src");
    const packageJson = '{"name":"fixture","version":"1.0.0"}\n';
    await mkdir(target, { recursive: true });
    await Promise.all([
      writeFile(join(packageDirectory, "package.json"), packageJson),
      writeFile(join(target, "runtime.ts"), "changed\n"),
    ]);
    const policy = {
      packaging: {
        reviewedPrunedDirectories: [{
          relativePath: "node_modules/fixture/src",
          package: "fixture",
          version: "1.0.0",
          packageJsonSha256: createHash("sha256").update(packageJson).digest("hex"),
          fileCount: 1,
          totalBytes: 7,
          treeSha256: "a".repeat(64),
        }],
      },
    };

    await expect(pruneReviewedRuntimeDirectories(root, policy)).rejects.toThrow(
      "Reviewed runtime prune target drifted",
    );
    await expect(readFile(join(target, "runtime.ts"), "utf8")).resolves.toBe("changed\n");
  });

  it("includes runtime-shaped package files in the reviewed directory identity", async () => {
    const root = await makeTemporaryDirectory();
    const packageDirectory = join(root, "node_modules", "fixture");
    const target = join(packageDirectory, "src");
    const packageJson = '{"name":"fixture","version":"1.0.0"}\n';
    const runtimeSource = "export const runtime = true;\n";
    await mkdir(target, { recursive: true });
    await Promise.all([
      writeFile(join(packageDirectory, "package.json"), packageJson),
      writeFile(join(target, "runtime.ts"), runtimeSource),
      writeFile(join(target, "runtime.json"), "unreviewed\n"),
    ]);
    const runtimeSha256 = createHash("sha256").update(runtimeSource).digest("hex");
    const treeSource = `${runtimeSha256} ${Buffer.byteLength(runtimeSource)} runtime.ts\n`;
    const policy = {
      packaging: {
        reviewedPrunedDirectories: [{
          relativePath: "node_modules/fixture/src",
          package: "fixture",
          version: "1.0.0",
          packageJsonSha256: createHash("sha256").update(packageJson).digest("hex"),
          fileCount: 1,
          totalBytes: Buffer.byteLength(runtimeSource),
          treeSha256: createHash("sha256").update(treeSource).digest("hex"),
        }],
      },
    };

    await expect(pruneReviewedRuntimeDirectories(root, policy)).rejects.toThrow(
      "Reviewed runtime prune target drifted",
    );
    await expect(readFile(join(target, "runtime.json"), "utf8")).resolves.toBe("unreviewed\n");
  });

  it("validates every reviewed directory before removing any of them", async () => {
    const root = await makeTemporaryDirectory();
    const makeEntry = async (packageName: string, contents: string, treeSha256?: string) => {
      const packageDirectory = join(root, "node_modules", packageName);
      const target = join(packageDirectory, "src");
      const packageJson = `${JSON.stringify({ name: packageName, version: "1.0.0" })}\n`;
      await mkdir(target, { recursive: true });
      await Promise.all([
        writeFile(join(packageDirectory, "package.json"), packageJson),
        writeFile(join(target, "index.ts"), contents),
      ]);
      const sha256 = createHash("sha256").update(contents).digest("hex");
      const treeSource = `${sha256} ${Buffer.byteLength(contents)} index.ts\n`;
      return {
        relativePath: `node_modules/${packageName}/src`,
        package: packageName,
        version: "1.0.0",
        packageJsonSha256: createHash("sha256").update(packageJson).digest("hex"),
        fileCount: 1,
        totalBytes: Buffer.byteLength(contents),
        treeSha256: treeSha256 ?? createHash("sha256").update(treeSource).digest("hex"),
      };
    };
    const first = await makeEntry("first", "first\n");
    const second = await makeEntry("second", "second\n", "a".repeat(64));

    await expect(pruneReviewedRuntimeDirectories(root, {
      packaging: { reviewedPrunedDirectories: [first, second] },
    })).rejects.toThrow("Reviewed runtime prune target drifted");
    await expect(readFile(join(root, "node_modules", "first", "src", "index.ts"), "utf8")).resolves.toBe("first\n");
    await expect(readFile(join(root, "node_modules", "second", "src", "index.ts"), "utf8")).resolves.toBe("second\n");
  });

  it.runIf(process.platform !== "win32")("rejects a symlinked reviewed directory without deleting its target", async () => {
    const root = await makeTemporaryDirectory();
    const packageDirectory = join(root, "node_modules", "fixture");
    const outside = join(root, "outside");
    const packageJson = '{"name":"fixture","version":"1.0.0"}\n';
    await Promise.all([
      mkdir(packageDirectory, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(packageDirectory, "package.json"), packageJson),
      writeFile(join(outside, "keep.ts"), "keep\n"),
      symlink(outside, join(packageDirectory, "src"), "dir"),
    ]);

    await expect(pruneReviewedRuntimeDirectories(root, {
      packaging: {
        reviewedPrunedDirectories: [{
          relativePath: "node_modules/fixture/src",
          package: "fixture",
          version: "1.0.0",
          packageJsonSha256: createHash("sha256").update(packageJson).digest("hex"),
          fileCount: 1,
          totalBytes: 5,
          treeSha256: "a".repeat(64),
        }],
      },
    })).rejects.toThrow("not a plain package directory");
    await expect(readFile(join(outside, "keep.ts"), "utf8")).resolves.toBe("keep\n");
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
  await mkdir(join(root, "node_modules", "playwright-core"), { recursive: true });
  await mkdir(join(root, "bridge", "skills", "playwright-cli"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), '{"name":"fixture"}\n'),
    writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}\n'),
    writeFile(join(prime, "package.json"), '{"name":"prime-agent","version":"0.7.1"}\n'),
    writeFile(join(prime, "dist", "index.js"), "export class DaemonClient {}\n"),
    writeFile(join(prime, "dist", "bundle", "cli.js"), "process.exitCode = 0;\n"),
    writeFile(join(root, "node_modules", "playwright-core", "package.json"), '{"name":"playwright-core","version":"1.63.0-alpha-2026-08-05"}\n'),
    writeFile(join(root, "bridge", "browser-bridge.mjs"), "export const bridge = true;\n"),
    writeFile(join(root, "bridge", "browser-doctor-host.cjs"), "module.exports = {};\n"),
    writeFile(join(root, "bridge", "browser-host.cjs"), "module.exports = {};\n"),
    writeFile(join(root, "bridge", "playwright-cli"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }),
    writeFile(join(root, "bridge", "playwright-cli.cmd"), "@exit /b 0\r\n"),
    writeFile(join(root, "bridge", "skills", "playwright-cli", "SKILL.md"), "# Browser\n"),
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
    releaseVersion: "0.7.1",
    runtimeBuildId: "95afd31-dirty",
    minimumNodeVersion: "22.8.0",
    npmVersion: "10.9.8",
    install: {
      ignoreScripts: true,
      omitDev: true,
      omitOptional: true,
      installStrategy: "hoisted",
      targetNativePrebuildsOnly: true,
    },
    packaging: {
      excludedBasenames: [".gitkeep"],
      excludedSuffixes: [".d.ts", ".d.mts", ".d.cts", ".map"],
    },
    entrypoints: {
      module: "node_modules/prime-agent/dist/index.js",
      cli: "node_modules/prime-agent/dist/bundle/cli.js",
      browserBridge: "bridge/browser-bridge.mjs",
      browserHost: "bridge/browser-host.cjs",
      browserLauncher: "bridge/playwright-cli",
      browserLauncherWindows: "bridge/playwright-cli.cmd",
      browserSkill: "bridge/skills/playwright-cli/SKILL.md",
    },
    browserBridge: {
      protocol: "prime-continuim.browser.v1",
      playwrightCoreVersion: "1.63.0-alpha-2026-08-05",
      engine: "verified-electron-host",
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
      release: {
        repository: "https://github.com/PrimeIntellect-ai/prime-agent",
        tag: "v0.7.1",
        version: "0.7.1",
        commit: "95afd319a78ae017a41241d50b013d656a0685ce",
      },
      assets: [],
    },
    sourcesSha256: "a".repeat(64),
    policySha256: "b".repeat(64),
    lockfileSha256: "c".repeat(64),
  };
}
