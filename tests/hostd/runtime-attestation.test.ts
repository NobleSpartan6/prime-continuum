import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  parseEmbeddedRuntimeAttestationBytes,
  parseEmbeddedRuntimeAttestationRecord,
  readEmbeddedRuntimeAttestation,
} from "../../src/hostd/runtime-attestation";
import {
  createEmbeddedRuntimeAttestationRecord,
  extractEmbeddedRuntimeAttestation,
  parseRuntimeAttestation,
  readElectronRuntimeIdentity,
  readNodeRuntimeIdentity,
  serializeRuntimeAttestation,
  type RuntimeAttestation,
} from "../../scripts/runtime-attestation-lib.mjs";
import { resolvePinnedDevelopmentNodeExecutable } from "../../scripts/development-node-runtime.mjs";

const require = createRequire(import.meta.url);

const attestation = {
  schemaVersion: 1,
  product: "Prime Continuim",
  assurance: "development-integrity",
  runtimePolicySchemaVersion: 1,
  runtime: {
    name: "prime-agent",
    releaseVersion: "0.7.0",
    runtimeBuildId: "test-build",
    platform: "win32",
    arch: "x64",
    libc: "none",
  },
  manifest: {
    relativePath: "installs/test/runtime.json",
    sha256: "1".repeat(64),
    sourcesSha256: "2".repeat(64),
    policySha256: "3".repeat(64),
    packageLockSha256: "4".repeat(64),
  },
  tree: {
    sha256: "5".repeat(64),
    filesSha256: "6".repeat(64),
    fileCount: 3,
    totalBytes: 42,
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
    smoke: {
      verified: true,
      operations: ["doctor", "open", "snapshot", "find", "click", "eval", "screenshot", "close"],
    },
  },
  daemon: {
    protocolName: "prime-agent.daemon",
    protocolVersion: 7,
    schemaRevision: 13,
    schemaId: "schema-test",
    requiredCapabilities: ["attach_snapshot"],
  },
  nativeAddons: [{ path: "node_modules/native/addon.node", size: 12, sha256: "7".repeat(64) }],
  guiRuntime: {
    kind: "electron",
    electronVersion: "43.3.0",
    nodeVersion: "24.18.1",
    modulesAbi: "148",
    napiVersion: "10",
    platform: "win32",
    arch: "x64",
    executableSha256: "8".repeat(64),
  },
  hostRuntime: {
    kind: "node",
    nodeVersion: "24.14.0",
    modulesAbi: "137",
    napiVersion: "10",
    platform: "win32",
    arch: "x64",
    executableSha256: "9".repeat(64),
  },
} as const satisfies RuntimeAttestation;

describe("release runtime attestation", () => {
  it("independently identifies the GUI Electron and exact pinned standalone host Node", async () => {
    const [guiRuntime, hostRuntime] = await Promise.all([
      readElectronRuntimeIdentity(resolve(require("electron"))),
      readNodeRuntimeIdentity(resolvePinnedDevelopmentNodeExecutable(resolve("."))),
    ]);
    expect(guiRuntime).toMatchObject({ kind: "electron", electronVersion: "43.3.0" });
    expect(hostRuntime).toMatchObject({ kind: "node", nodeVersion: "24.14.0" });
    expect(guiRuntime.executableSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(hostRuntime.executableSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(hostRuntime.executableSha256).not.toBe(guiRuntime.executableSha256);
  }, 20_000);

  it("round-trips one canonical bounded record", () => {
    const bytes = serializeRuntimeAttestation(attestation);
    const record = createEmbeddedRuntimeAttestationRecord(bytes);
    const extracted = extractEmbeddedRuntimeAttestation(Buffer.from(`const releaseRecord = ${JSON.stringify(record)};`));
    const envelope = parseEmbeddedRuntimeAttestationRecord(record);
    const bytesEnvelope = parseEmbeddedRuntimeAttestationBytes(bytes);

    expect(extracted).toEqual(bytes);
    expect(parseRuntimeAttestation(extracted)).toEqual(attestation);
    expect(envelope).toEqual({
      attestation,
      trustAnchorId: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(bytesEnvelope).toEqual(envelope);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.attestation)).toBe(true);
  });

  it("rejects absent, duplicated, malformed, and overstated records", () => {
    const bytes = serializeRuntimeAttestation(attestation);
    const record = createEmbeddedRuntimeAttestationRecord(bytes);
    expect(() => extractEmbeddedRuntimeAttestation("const hostd = true;")).toThrow("exactly one");
    expect(() => extractEmbeddedRuntimeAttestation(`${record}\n${record}`)).toThrow("exactly one");
    expect(() => extractEmbeddedRuntimeAttestation(`${record.slice(0, -1)}!`)).toThrow();
    expect(() => parseRuntimeAttestation(serializeRuntimeAttestation({
      ...attestation,
      assurance: "production-authenticated",
    } as unknown as RuntimeAttestation))).toThrow("assurance");
  });

  it("rejects legacy companion fields from both generated and embedded attestations", () => {
    const legacy = {
      ...attestation,
      codexAppServer: { releaseVersion: "0.147.0" },
    };
    expect(() => serializeRuntimeAttestation(legacy as unknown as RuntimeAttestation))
      .toThrow("unexpected or missing fields");

    const bytes = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    const record = `PRIME_CONTINUIM_RUNTIME_ATTESTATION_V1:${bytes.toString("base64")}`;
    expect(() => parseEmbeddedRuntimeAttestationRecord(record)).toThrow("invalid identity");
  });

  it("rejects a host executable identity that aliases the GUI executable", () => {
    expect(() => serializeRuntimeAttestation({
      ...attestation,
      hostRuntime: {
        ...attestation.hostRuntime,
        executableSha256: attestation.guiRuntime.executableSha256,
      },
    } as RuntimeAttestation)).toThrow("must be unequal");
  });

  it("embeds the exact ASAR attestation bytes into a release hostd bundle", async () => {
    const bytes = serializeRuntimeAttestation(attestation);
    const record = createEmbeddedRuntimeAttestationRecord(bytes);
    const result = await build({
      entryPoints: [resolve("src/hostd/index.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      write: false,
      logLevel: "silent",
      define: {
        __PRIME_CONTINUIM_RUNTIME_ATTESTATION_RECORD__: JSON.stringify(record),
      },
    });
    const output = result.outputFiles[0];
    if (!output) throw new Error("hostd test bundle was not emitted");
    expect(extractEmbeddedRuntimeAttestation(output.contents)).toEqual(bytes);
    const bundledSource = Buffer.from(output.contents).toString("utf8");
    for (const upstreamRuntimePackage of [
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-tui",
    ]) {
      expect(bundledSource).not.toContain(upstreamRuntimePackage);
    }
  });

  it("keeps ordinary development hostd imports unattested", () => {
    expect(readEmbeddedRuntimeAttestation()).toBeUndefined();
  });

  it("keeps the generated attestation out of source control", async () => {
    const gitignore = await readFile(resolve(".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/)).toContain("out/");
  });
});
