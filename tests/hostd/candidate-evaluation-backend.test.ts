import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  capturePassiveReview,
  candidateEvaluationPlatformSupported,
  resolvePnpmCli,
  workspaceBuildActivity,
} from "../../src/hostd/candidate-evaluation";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("candidate evaluation passive backend", () => {
  it("withholds capability on escapable POSIX process backends", () => {
    expect(candidateEvaluationPlatformSupported("linux")).toBe(false);
    expect(candidateEvaluationPlatformSupported("darwin")).toBe(false);
    expect(candidateEvaluationPlatformSupported("win32")).toBe(true);
  });

  it("hashes the complete launcher bootstrap without executing malicious Node or pnpm bytes", async () => {
    const root = await fixtureRoot();
    const sentinel = join(root, "executed-sentinel");
    const node = join(root, "node_modules", "node", "node.exe");
    const pnpm = join(root, "tools", "pnpm.cjs");
    await writeFile(node, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'node')\n`);
    await writeFile(pnpm, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'pnpm')\n`);

    const review = await capturePassiveReview(root, node, pnpm);

    expect(review).toMatchObject({
      headCommit: "a".repeat(40),
      launcherBootstrapFileCount: 9,
      nodeExecutableSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      pnpmCliSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      reviewAggregateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(access(sentinel)).rejects.toThrow();
  });

  it("resolves only an actual JavaScript pnpm/Corepack launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "prime-pnpm-launcher-"));
    roots.push(root);
    const npmCli = join(root, "npm-cli.js");
    const shellShim = join(root, "pnpm");
    const pnpmCli = join(root, "pnpm.cjs");
    await Promise.all([
      writeFile(npmCli, "// npm\n"),
      writeFile(shellShim, "#!/bin/sh\n"),
      writeFile(pnpmCli, "// pnpm\n"),
    ]);

    await expect(resolvePnpmCli({ npm_execpath: npmCli, PATH: "" })).rejects.toThrow(/could not be resolved/);
    await expect(resolvePnpmCli({ npm_execpath: shellShim, PATH: "" })).rejects.toThrow(/could not be resolved/);
    await expect(resolvePnpmCli({ npm_execpath: pnpmCli, PATH: "" })).resolves.toBe(pnpmCli);
  });

  it("passively rejects live, malformed, and unresolved child workflow leases", async () => {
    const root = await fixtureRoot();
    const lockPath = join(root, ".prime-continuim-workflow.lock");
    const token = "11111111-1111-4111-8111-111111111111";
    const owner = {
      schemaVersion: 1,
      token,
      pid: process.pid,
      workflow: "self-build:11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-09T12:00:00.000Z",
      projectRoot: root,
    };
    await writeFile(lockPath, `${JSON.stringify(owner)}\n`);
    await expect(workspaceBuildActivity(root)).resolves.toBe("busy");

    await writeFile(lockPath, "not-json\n");
    await expect(workspaceBuildActivity(root)).resolves.toBe("busy");

    await writeFile(lockPath, `${JSON.stringify({ ...owner, pid: 2_147_483_647 })}\n`);
    await writeFile(`${lockPath}.child`, `${JSON.stringify({
      schemaVersion: 1,
      token: "22222222-2222-4222-8222-222222222222",
      lockToken: token,
      workflow: owner.workflow,
      parentPid: 2_147_483_647,
      supervisorPid: 2_147_483_647,
      containment: "windows-job",
      childPublication: "pending",
      startedAt: owner.startedAt,
    })}\n`);
    await expect(workspaceBuildActivity(root)).resolves.toBe("busy");
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "prime-candidate-passive-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, ".git"), { recursive: true }),
    mkdir(join(root, "scripts"), { recursive: true }),
    mkdir(join(root, "out", "runtime"), { recursive: true }),
    mkdir(join(root, "node_modules", "node"), { recursive: true }),
    mkdir(join(root, "tools"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, ".git", "HEAD"), `${"a".repeat(40)}\n`),
    writeFile(join(root, ".git", "index"), "bounded-index\n"),
    writeFile(join(root, "package.json"), '{"name":"prime-continuim"}\n'),
    writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
    writeFile(join(root, ".node-version"), "24.14.0\n"),
    writeFile(join(root, "out", "runtime", "current.json"), '{"schemaVersion":1}\n'),
    writeFile(join(root, "node_modules", "node", "package.json"), '{"version":"24.14.0"}\n'),
    ...[
      "self-build.mjs",
      "self-build-lib.mjs",
      "self-build-evidence-lib.mjs",
      "development-node-runtime.mjs",
      "workflow-lock-lib.mjs",
      "workflow-child-lease-lib.mjs",
      "workflow-supervised-step-lib.mjs",
      "workflow-child-supervisor.mjs",
      "windows-job-supervisor.ps1",
    ].map(async (name) => await writeFile(join(root, "scripts", name), `// ${name}\n`)),
  ]);
  return root;
}
