import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePrimeAgentRuntimeDirectory } from "../../src/hostd/prime-agent-auth-security";
import { createPrimeAgentSmokeCustody } from "../../scripts/prime-agent-smoke-custody-lib.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }));
});

describe("Prime Agent package-smoke custody cleanup", () => {
  it("removes only the exact captured leaf after clean shutdown and preserves its parent identity", async () => {
    const fixture = await makeFixture();
    const custody = await createPrimeAgentSmokeCustody(fixture.options);
    await custody.assertInitiallyAbsent();
    await mkdir(custody.agentDirectory, { mode: 0o700 });
    await mkdir(join(custody.agentDirectory, "sessions"), { mode: 0o700 });
    await writeFile(join(custody.agentDirectory, "sessions", "one.jsonl"), "smoke\n", { mode: 0o600 });
    await writeFile(join(fixture.programDataRoot, "unrelated.txt"), "keep\n", "utf8");

    const proof = await custody.captureExisting();
    const result = await custody.removeAfterConfirmedShutdown({ confirmedCleanShutdown: true });

    expect(proof?.canonicalAgentDirectory).toBe(await realpath(resolve(custody.agentDirectory)).catch(() => resolve(custody.agentDirectory)));
    expect(result).toMatchObject({ removed: true, entries: 3, bytes: 6 });
    await expect(lstat(custody.agentDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(fixture.programDataRoot, "unrelated.txt"))).resolves.toMatchObject({ size: 5 });
    expect(fixture.securityCalls.prepare).toBe(1);
    expect(fixture.securityCalls.assert).toBeGreaterThanOrEqual(3);
  });

  it("requires pre-start absence and an explicit clean-shutdown confirmation", async () => {
    const fixture = await makeFixture();
    const custody = await createPrimeAgentSmokeCustody(fixture.options);
    await mkdir(custody.agentDirectory, { mode: 0o700 });
    await expect(custody.assertInitiallyAbsent()).rejects.toThrow(/already exists/i);

    const secondFixture = await makeFixture();
    const second = await createPrimeAgentSmokeCustody(secondFixture.options);
    await second.assertInitiallyAbsent();
    await mkdir(second.agentDirectory, { mode: 0o700 });
    await second.captureExisting();
    await expect(second.removeAfterConfirmedShutdown({ confirmedCleanShutdown: false })).rejects.toThrow(
      /confirmed clean host shutdown/i,
    );
    await expect(lstat(second.agentDirectory)).resolves.toMatchObject({});
  });

  it("rejects conflicting case-variant ProgramData roots before resolving a leaf", async () => {
    if (process.platform !== "win32") return;
    const fixture = await makeFixture();
    await expect(createPrimeAgentSmokeCustody({
      ...fixture.options,
      environment: {
        ProgramData: fixture.programDataRoot,
        PROGRAMDATA: join(fixture.root, "different-program-data"),
      },
    })).rejects.toThrow(/conflicting ProgramData roots/i);
  });

  it("refuses a linked descendant and leaves the custody tree untouched", async () => {
    const fixture = await makeFixture();
    const custody = await createPrimeAgentSmokeCustody(fixture.options);
    await custody.assertInitiallyAbsent();
    await mkdir(custody.agentDirectory, { mode: 0o700 });
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "outside", "utf8");
    await symlink(outside, join(custody.agentDirectory, "linked"), process.platform === "win32" ? "junction" : "dir");
    await custody.captureExisting();

    await expect(custody.removeAfterConfirmedShutdown({ confirmedCleanShutdown: true })).rejects.toThrow(
      /linked entries|reparse directories/i,
    );
    await expect(lstat(custody.agentDirectory)).resolves.toMatchObject({});
    await expect(lstat(join(outside, "sentinel.txt"))).resolves.toMatchObject({ size: 7 });
  });

  it("refuses multiply-linked files before recursive removal", async () => {
    const fixture = await makeFixture();
    const custody = await createPrimeAgentSmokeCustody(fixture.options);
    await custody.assertInitiallyAbsent();
    await mkdir(custody.agentDirectory, { mode: 0o700 });
    const outside = join(fixture.root, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    await link(outside, join(custody.agentDirectory, "linked.txt"));
    await custody.captureExisting();

    await expect(custody.removeAfterConfirmedShutdown({ confirmedCleanShutdown: true })).rejects.toThrow(
      /multiply-linked/i,
    );
    await expect(lstat(outside)).resolves.toMatchObject({ size: 7 });
  });

  it("refuses a replacement leaf whose filesystem identity differs from the captured proof", async () => {
    const fixture = await makeFixture();
    const custody = await createPrimeAgentSmokeCustody(fixture.options);
    await custody.assertInitiallyAbsent();
    await mkdir(custody.agentDirectory, { mode: 0o700 });
    const proof = await custody.captureExisting();
    expect(proof).toBeDefined();
    await rm(custody.agentDirectory, { recursive: true, force: true });
    let replacementIdentity = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await mkdir(custody.agentDirectory, { mode: 0o700 });
      const replacement = await lstat(custody.agentDirectory);
      replacementIdentity = `${replacement.dev}:${replacement.ino}`;
      if (replacementIdentity !== proof?.agentDirectoryIdentity) break;
      await rm(custody.agentDirectory, { recursive: true, force: true });
      // Some filesystems immediately recycle the just-freed inode. Consume it
      // with an unrelated fixture directory so this case continues to test a
      // replacement whose identity is actually different.
      await mkdir(join(fixture.root, `replacement-spacer-${attempt}`), { mode: 0o700 });
    }
    expect(replacementIdentity).not.toBe(proof?.agentDirectoryIdentity);

    await expect(custody.removeAfterConfirmedShutdown({ confirmedCleanShutdown: true })).rejects.toThrow(
      /identity drift|identity changed/i,
    );
    await expect(lstat(custody.agentDirectory)).resolves.toMatchObject({});
  });
});

async function makeFixture() {
  // macOS spells the temporary root through a /var symlink. The production
  // boundary rightly rejects aliases, so tests use the physical path.
  const root = await realpath(await mkdtemp(join(tmpdir(), "prime-smoke-custody-test-")));
  roots.push(root);
  const hostDataRoot = join(root, "host-data");
  const programDataRoot = process.platform === "win32" ? join(root, "ProgramData") : hostDataRoot;
  await mkdir(hostDataRoot, { mode: 0o700 });
  if (programDataRoot !== hostDataRoot) await mkdir(programDataRoot, { mode: 0o700 });
  const securityCalls = { prepare: 0, assert: 0 };

  class FakeSecurity {
    async prepareAndVerify(hostRoot: string, agentDirectory: string) {
      securityCalls.prepare += 1;
      return await proofFor(hostRoot, programDataRoot, agentDirectory);
    }

    async assertStillSecure(proof: Awaited<ReturnType<typeof proofFor>>) {
      securityCalls.assert += 1;
      const observed = await proofFor(proof.canonicalHostDataRoot, proof.canonicalCustodyParent, proof.canonicalAgentDirectory);
      if (
        observed.custodyParentIdentity !== proof.custodyParentIdentity ||
        observed.agentDirectoryIdentity !== proof.agentDirectoryIdentity
      ) throw new Error("fake custody identity drift");
    }
  }

  return {
    root,
    programDataRoot,
    securityCalls,
    options: {
      hostDataRoot,
      hostdModule: {
        resolvePrimeAgentRuntimeDirectory,
        HostScopedPrimeAgentAuthSecurity: FakeSecurity,
      },
      environment: {
        ProgramData: programDataRoot,
      },
    },
  };
}

async function proofFor(hostDataRoot: string, custodyParent: string, agentDirectory: string) {
  const [canonicalHostDataRoot, canonicalCustodyParent, canonicalAgentDirectory] = await Promise.all([
    realpath(hostDataRoot),
    realpath(custodyParent),
    realpath(agentDirectory),
  ]);
  const [parent, agent] = await Promise.all([lstat(canonicalCustodyParent), lstat(canonicalAgentDirectory)]);
  return Object.freeze({
    canonicalHostDataRoot,
    canonicalCustodyParent,
    canonicalAgentDirectory,
    custodyParentIdentity: `${parent.dev}:${parent.ino}`,
    agentDirectoryIdentity: `${agent.dev}:${agent.ino}`,
    platform: process.platform,
    ...(process.platform === "win32" ? { currentUserSid: fakeSid(canonicalHostDataRoot) } : {}),
  });
}

function fakeSid(value: string): string {
  const suffix = Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 7), 16);
  return `S-1-5-21-1000-1000-1000-${suffix}`;
}
