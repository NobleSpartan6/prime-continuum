import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { readEmbeddedRuntimeAttestation } from "../../src/hostd/runtime-attestation";
import {
  createEmbeddedRuntimeAttestationRecord,
  extractEmbeddedRuntimeAttestation,
  parseRuntimeAttestation,
  serializeRuntimeAttestation,
  type RuntimeAttestation,
} from "../../scripts/runtime-attestation-lib.mjs";

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
  },
  daemon: {
    protocolName: "prime-agent.daemon",
    protocolVersion: 7,
    schemaRevision: 13,
    schemaId: "schema-test",
    requiredCapabilities: ["attach_snapshot"],
  },
  nativeAddons: [{ path: "node_modules/native/addon.node", size: 12, sha256: "7".repeat(64) }],
  hostRuntime: {
    kind: "electron-run-as-node",
    electronVersion: "43.3.0",
    nodeVersion: "24.18.1",
    modulesAbi: "148",
    napiVersion: "10",
    platform: "win32",
    arch: "x64",
    runAsNode: true,
  },
} as const satisfies RuntimeAttestation;

describe("release runtime attestation", () => {
  it("round-trips one canonical bounded record", () => {
    const bytes = serializeRuntimeAttestation(attestation);
    const record = createEmbeddedRuntimeAttestationRecord(bytes);
    const extracted = extractEmbeddedRuntimeAttestation(Buffer.from(`const releaseRecord = ${JSON.stringify(record)};`));

    expect(extracted).toEqual(bytes);
    expect(parseRuntimeAttestation(extracted)).toEqual(attestation);
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
  });

  it("keeps ordinary development hostd imports unattested", () => {
    expect(readEmbeddedRuntimeAttestation()).toBeUndefined();
  });

  it("keeps the generated attestation out of source control", async () => {
    const gitignore = await readFile(resolve(".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/)).toContain("out/");
  });
});
