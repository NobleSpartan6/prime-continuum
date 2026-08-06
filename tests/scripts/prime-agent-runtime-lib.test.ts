import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  validateRuntimeInputs,
  verifyBuiltRuntime,
  verifyOnlySelectedRuntimeInstall,
  writeCurrentPointer,
} from "../../scripts/prime-agent-runtime-lib.mjs";

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
});

describe("Prime Agent package seed selection", () => {
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
