import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import runtimePolicy from "../../runtime/prime-agent/runtime-policy.json";
import runtimeSources from "../../runtime/prime-agent/sources.json";
import {
  parseEmbeddedRuntimeAttestationRecord,
  readEmbeddedRuntimeAttestation,
} from "../../src/hostd/runtime-attestation";
import {
  createEmbeddedRuntimeAttestationRecord,
  extractEmbeddedRuntimeAttestation,
  parseRuntimeAttestation,
  serializeRuntimeAttestation,
  type RuntimeAttestation,
} from "../../scripts/runtime-attestation-lib.mjs";
import { CODEX_APP_SERVER_THREAD_START_POLICY } from "../../scripts/prime-agent-runtime-lib.mjs";

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

const codexAppServerAttestation = {
  releaseVersion: "0.147.0",
  platform: "win32",
  arch: "x64",
  target: "x86_64-pc-windows-msvc",
  entrypoint: "companions/codex-app-server/bin/codex-app-server.exe",
  fixedArguments: runtimePolicy.codexAppServer.fixedArguments,
  legalFiles: runtimeSources.codexAppServer.legalFiles,
  sessionConfig: runtimePolicy.codexAppServer.sessionConfig,
  threadConfig: runtimePolicy.codexAppServer.threadConfig,
  initializeIdentity: runtimePolicy.codexAppServer.initializeIdentity,
  threadStartPolicy: CODEX_APP_SERVER_THREAD_START_POLICY,
  environmentPolicy: runtimePolicy.codexAppServer.environmentPolicy,
  codexHomePolicy: runtimePolicy.codexAppServer.codexHomePolicy,
  assetSha256: "c8908d687cf7caa3074921479726db32f96a295372c3544f1e96919a7254951f",
  publisher: {
    subject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US',
    thumbprint: "8B0ADFB840E141DAD3044D2B5AC819873DDE3590",
    signedFiles: [
      "bin/codex-app-server.exe",
      "bin/codex-code-mode-host.exe",
      "codex-resources/codex-command-runner.exe",
      "codex-resources/codex-windows-sandbox-setup.exe",
    ],
    unsignedFiles: ["codex-path/rg.exe"],
  },
  smoke: {
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
  },
} as const;

describe("release runtime attestation", () => {
  it("round-trips one canonical bounded record", () => {
    const bytes = serializeRuntimeAttestation(attestation);
    const record = createEmbeddedRuntimeAttestationRecord(bytes);
    const extracted = extractEmbeddedRuntimeAttestation(Buffer.from(`const releaseRecord = ${JSON.stringify(record)};`));
    const envelope = parseEmbeddedRuntimeAttestationRecord(record);

    expect(extracted).toEqual(bytes);
    expect(parseRuntimeAttestation(extracted)).toEqual(attestation);
    expect(envelope).toEqual({
      attestation,
      trustAnchorId: createHash("sha256").update(bytes).digest("hex"),
    });
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

  it("binds the full Codex launch, environment, home, and smoke contract", () => {
    const withCompanion = { ...attestation, codexAppServer: codexAppServerAttestation };
    const bytes = serializeRuntimeAttestation(withCompanion);
    expect(parseEmbeddedRuntimeAttestationRecord(createEmbeddedRuntimeAttestationRecord(bytes)).attestation)
      .toEqual(withCompanion);

    expect(() => serializeRuntimeAttestation({
      ...withCompanion,
      codexAppServer: {
        ...codexAppServerAttestation,
        fixedArguments: [...codexAppServerAttestation.fixedArguments, "--drift"],
      },
    })).toThrow("fixed arguments drifted");

    const driftedThreadStartPolicy = {
      ...structuredClone(codexAppServerAttestation.threadStartPolicy),
      expectedSecurityResponse: {
        ...structuredClone(codexAppServerAttestation.threadStartPolicy.expectedSecurityResponse),
        model: "drift",
      },
    };
    expect(() => serializeRuntimeAttestation({
      ...withCompanion,
      codexAppServer: {
        ...codexAppServerAttestation,
        threadStartPolicy: driftedThreadStartPolicy,
      },
    } as unknown as RuntimeAttestation)).toThrow("thread/start policy drifted");
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
