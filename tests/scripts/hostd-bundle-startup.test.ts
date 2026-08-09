import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bundled host startup", () => {
  it("starts the real CommonJS host bundle without importing self-build workflow side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "prime-hostd-bundle-"));
    temporaryRoots.push(root);
    const outfile = join(root, "hostd.cjs");
    const supervisor = await readFile(resolve("scripts/windows-job-supervisor.ps1"), "utf8");

    const result = await build({
      entryPoints: [resolve("src/hostd/index.ts")],
      outfile,
      bundle: true,
      preserveSymlinks: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      metafile: true,
      logLevel: "silent",
      define: {
        __PRIME_CONTINUIM_RUNTIME_ATTESTATION_RECORD__: "undefined",
        __PRIME_CONTINUIM_WINDOWS_JOB_SUPERVISOR__: JSON.stringify(supervisor),
      },
    });

    const bundle = await readFile(outfile, "utf8");
    expect(Object.keys(result.metafile.inputs)).not.toContain("scripts/workflow-supervised-step-lib.mjs");
    expect(bundle).not.toContain("import_meta.dirname");

    const started = spawnSync(process.execPath, [outfile, "--help"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    expect(started.error).toBeUndefined();
    expect(started.status).toBe(2);
    expect(started.stderr).toContain("Usage:");
    expect(started.stderr).not.toContain("TypeError");
  }, 30_000);
});
