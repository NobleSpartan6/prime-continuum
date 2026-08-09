import { chmod, link, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostScopedPrimeAgentAuthSecurity,
  PrimeAgentAuthSecurityError,
  SharedPrimeAgentRuntimeSecurityGuard,
  resolvePrimeAgentRuntimeDirectory,
  type PrimeAgentAuthSecurityCommandRunner,
  type PrimeAgentAuthSecurityProvider,
  type PrimeAgentAuthSecurityProof,
} from "../../src/hostd/prime-agent-auth-security";

const temporaryDirectories: string[] = [];
const USER_SID = "S-1-5-21-100-200-300-1001";
const AAD_USER_SID = "S-1-12-1-100-200-300-400";
const SYSTEM_SID = "S-1-5-18";
const PROTECTED_DACL = `D:P(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
const INHERITED_FILE_DACL = `D:(A;ID;FA;;;${USER_SID})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`;
const PROGRAM_DATA_SDDL = "O:SYG:SYD:PAI(A;OICIIO;GA;;;CO)(A;OICI;FA;;;SY)" +
  "(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;CI;DCLCRPCR;;;BU)";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })));
});

describe("host-scoped Prime Agent runtime custody", () => {
  it.runIf(process.platform !== "win32")("creates a 0700 agent root only below a proven non-writable parent", async () => {
    const root = await temporaryRoot();
    const directory = resolvePrimeAgentRuntimeDirectory(root);
    const security = new HostScopedPrimeAgentAuthSecurity({ platform: process.platform });

    const proof = await security.prepareAndVerify(root, directory);

    expect(proof.canonicalCustodyParent).toBe(root);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    await writeFile(join(directory, "auth.json"), "{}", { mode: 0o600 });
    await expect(security.assertStillSecure(proof)).resolves.toBeUndefined();
  });

  it.runIf(process.platform !== "win32")("rejects a group/other-writable parent before creating agent state", async () => {
    const root = await temporaryRoot();
    await chmod(root, 0o777);
    const directory = resolvePrimeAgentRuntimeDirectory(root);
    const security = new HostScopedPrimeAgentAuthSecurity({ platform: process.platform });

    await expect(security.prepareAndVerify(root, directory)).rejects.toMatchObject({
      code: "PRIME_AGENT_AUTH_PERMISSIONS_INVALID",
    });
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("rejects a non-sticky writable ancestor that can replace the private parent", async () => {
    const root = await temporaryRoot();
    const unsafeAncestor = join(root, "unsafe-ancestor");
    const hostRoot = join(unsafeAncestor, "hostd");
    await mkdir(unsafeAncestor, { mode: 0o777 });
    await chmod(unsafeAncestor, 0o777);
    await mkdir(hostRoot, { mode: 0o700 });
    const directory = resolvePrimeAgentRuntimeDirectory(hostRoot);
    const security = new HostScopedPrimeAgentAuthSecurity({ platform: process.platform });

    await expect(security.prepareAndVerify(hostRoot, directory)).rejects.toMatchObject({
      code: "PRIME_AGENT_AUTH_PERMISSIONS_INVALID",
    });
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("rejects an existing weak root and linked auth without repairing either", async () => {
    const root = await temporaryRoot();
    const directory = resolvePrimeAgentRuntimeDirectory(root);
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    const security = new HostScopedPrimeAgentAuthSecurity({ platform: process.platform });

    await expect(security.prepareAndVerify(root, directory)).rejects.toBeInstanceOf(PrimeAgentAuthSecurityError);
    expect((await lstat(directory)).mode & 0o777).toBe(0o755);

    await chmod(directory, 0o700);
    const outside = join(root, "outside-auth.json");
    await writeFile(outside, "{}", { mode: 0o600 });
    await link(outside, join(directory, "auth.json"));
    await expect(security.prepareAndVerify(root, directory)).rejects.toMatchObject({
      code: "PRIME_AGENT_AUTH_PERMISSIONS_INVALID",
    });
  });

  it.runIf(process.platform === "win32")("resolves a direct per-host ProgramData leaf and atomically provisions its exact protected root", async () => {
    const fixture = await windowsFixture();

    const proof = await fixture.security.prepareAndVerify(fixture.hostRoot, fixture.agentDirectory);

    expect(proof.canonicalCustodyParent).toBe(fixture.programDataRoot);
    expect(proof.canonicalAgentDirectory).toBe(fixture.agentDirectory);
    expect(fixture.createCalls).toEqual([fixture.agentDirectory]);
    expect(fixture.createScripts[0]).toMatch(/NativeDirectory\]::CreateDirectory/);
    expect(fixture.createScripts[0]).toMatch(/SetAccessRuleProtection\(\$true, \$false\)/);
    expect(fixture.createScripts[0]).not.toMatch(/New-Item|\[IO\.Directory\]::CreateDirectory/);
    expect(fixture.readAclCalls).toEqual([
      fixture.programDataRoot,
      fixture.programDataRoot,
      fixture.agentDirectory,
    ]);
    expect(fixture.agentDirectory).toMatch(/PrimeContinuim-PrimeAgent-[0-9a-f]{32}$/);
  });

  it.runIf(process.platform === "win32")("rejects a weak ProgramData parent before creating or reading an agent root", async () => {
    const fixture = await windowsFixture({
      programDataSddl: `${PROGRAM_DATA_SDDL}(A;OICI;FA;;;WD)`,
    });

    await expect(fixture.security.prepareAndVerify(fixture.hostRoot, fixture.agentDirectory)).rejects.toMatchObject({
      code: "PRIME_AGENT_AUTH_PERMISSIONS_INVALID",
    });
    expect(fixture.createCalls).toEqual([]);
    await expect(lstat(fixture.agentDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "win32")("rejects an inherited root DACL even when its trustees and rights look exact", async () => {
    const fixture = await windowsFixture({
      createAgent: true,
      agentSddl: `D:AI(A;OICIID;FA;;;${USER_SID})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)`,
    });

    await expect(fixture.security.prepareAndVerify(fixture.hostRoot, fixture.agentDirectory)).rejects.toMatchObject({
      code: "PRIME_AGENT_AUTH_PERMISSIONS_INVALID",
    });
    expect(fixture.createCalls).toEqual([]);
  });

  it.runIf(process.platform === "win32")("rejects an exact root DACL whose owner is not the current user", async () => {
    const fixture = await windowsFixture({ createAgent: true, agentOwnerSid: SYSTEM_SID });

    await expect(fixture.security.prepareAndVerify(fixture.hostRoot, fixture.agentDirectory)).rejects.toMatchObject({
      code: "PRIME_AGENT_AUTH_PERMISSIONS_INVALID",
    });
  });

  it.runIf(process.platform === "win32")("accepts an exact inherited auth.json DACL without an AI control bit and proves ownership", async () => {
    const fixture = await windowsFixture({ createAgent: true, createAuth: true });

    const proof = await fixture.security.prepareAndVerify(fixture.hostRoot, fixture.agentDirectory);
    await expect(fixture.security.assertStillSecure(proof)).resolves.toBeUndefined();

    fixture.state.authOwnerSid = SYSTEM_SID;
    await expect(fixture.security.assertStillSecure(proof)).rejects.toMatchObject({
      code: "PRIME_AGENT_AUTH_PERMISSIONS_INVALID",
    });
  });

  it.runIf(process.platform === "win32")("detects a replaced protected root by its physical identity before reuse", async () => {
    const fixture = await windowsFixture({ createAgent: true });
    const proof = await fixture.security.prepareAndVerify(fixture.hostRoot, fixture.agentDirectory);

    await rm(fixture.agentDirectory, { recursive: true, force: true });
    await mkdir(fixture.agentDirectory);

    await expect(fixture.security.assertStillSecure(proof)).rejects.toMatchObject({
      code: "PRIME_AGENT_AUTH_PATH_INVALID",
    });
  });

  it.runIf(process.platform === "win32")("accepts the bounded Entra/AAD user SID namespace returned by whoami", async () => {
    const protectedDacl = `D:P(A;OICI;FA;;;${AAD_USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
    const fixture = await windowsFixture({ userSid: AAD_USER_SID, agentSddl: protectedDacl });

    await expect(fixture.security.prepareAndVerify(fixture.hostRoot, fixture.agentDirectory)).resolves.toMatchObject({
      currentUserSid: AAD_USER_SID,
    });
  });

  it("rejects network, device, and alternate-data-stream Windows state roots", async () => {
    expect(() => resolvePrimeAgentRuntimeDirectory("\\\\server\\share\\hostd", {
      platform: "win32",
      programDataRoot: "C:\\ProgramData",
    })).toThrow(PrimeAgentAuthSecurityError);
    expect(() => resolvePrimeAgentRuntimeDirectory("\\\\?\\C:\\hostd", {
      platform: "win32",
      programDataRoot: "C:\\ProgramData",
    })).toThrow(PrimeAgentAuthSecurityError);
    expect(() => resolvePrimeAgentRuntimeDirectory("C:\\hostd:stream", {
      platform: "win32",
      programDataRoot: "C:\\ProgramData",
    })).toThrow(PrimeAgentAuthSecurityError);
  });
});

describe("shared Prime Agent runtime custody guard", () => {
  it("coalesces one proof across concurrent consumers and makes later drift sticky", async () => {
    const proof = fakeProof();
    const provider: PrimeAgentAuthSecurityProvider = {
      prepareAndVerify: vi.fn(async () => proof),
      assertStillSecure: vi.fn(async () => undefined),
    };
    const guard = new SharedPrimeAgentRuntimeSecurityGuard({
      security: provider,
      hostDataRoot: proof.canonicalHostDataRoot,
      agentDirectory: proof.canonicalAgentDirectory,
      verificationTtlMs: 0,
    });

    await Promise.all([guard.prepareAndVerify(), guard.assertStillSecure(), guard.assertStillSecure()]);
    expect(guard.capabilityAvailable()).toBe(true);
    expect(provider.prepareAndVerify).toHaveBeenCalledOnce();
    expect(provider.assertStillSecure).toHaveBeenCalledOnce();

    vi.mocked(provider.assertStillSecure).mockRejectedValueOnce(new PrimeAgentAuthSecurityError(
      "PRIME_AGENT_AUTH_PERMISSIONS_INVALID",
      "fixed failure",
    ));
    await expect(guard.assertStillSecure()).rejects.toMatchObject({
      code: "PRIME_AGENT_AUTH_PERMISSIONS_INVALID",
    });
    await expect(guard.prepareAndVerify()).rejects.toMatchObject({
      code: "PRIME_AGENT_AUTH_PERMISSIONS_INVALID",
    });
    expect(guard.capabilityAvailable()).toBe(false);
    expect(provider.prepareAndVerify).toHaveBeenCalledOnce();
  });
});

interface WindowsFixtureOptions {
  readonly userSid?: string;
  readonly createAgent?: boolean;
  readonly createAuth?: boolean;
  readonly programDataSddl?: string;
  readonly agentSddl?: string;
  readonly agentOwnerSid?: string;
}

async function windowsFixture(options: WindowsFixtureOptions = {}) {
  const parent = await temporaryRoot();
  const hostRoot = join(parent, "hostd");
  const programDataRoot = join(parent, "ProgramData");
  await mkdir(hostRoot);
  await mkdir(programDataRoot);
  const agentDirectory = resolvePrimeAgentRuntimeDirectory(hostRoot, {
    platform: "win32",
    programDataRoot,
  });
  if (options.createAgent) await mkdir(agentDirectory);
  if (options.createAuth) await writeFile(join(agentDirectory, "auth.json"), "{}");

  const userSid = options.userSid ?? USER_SID;
  const state = {
    programDataSddl: options.programDataSddl ?? PROGRAM_DATA_SDDL,
    agentSddl: options.agentSddl ?? PROTECTED_DACL.replace(USER_SID, userSid),
    agentOwnerSid: options.agentOwnerSid ?? userSid,
    authOwnerSid: userSid,
  };
  const createCalls: string[] = [];
  const createScripts: string[] = [];
  const readAclCalls: string[] = [];
  const runner: PrimeAgentAuthSecurityCommandRunner = {
    async run(_executable, args) {
      if (args[0] === "/user") return Buffer.from(`\"user\",\"${userSid}\"\r\n`, "ascii");
      const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1] ?? "", "base64").toString("utf16le");
      if (script.includes("PRIME_CONTINUIM_CREATE_PROTECTED_DIRECTORY_V1")) {
        const path = decodeEmbeddedPath(script);
        createCalls.push(path);
        createScripts.push(script);
        await mkdir(path);
        return Buffer.alloc(0);
      }
      if (script.includes("PRIME_CONTINUIM_READ_PROTECTED_ACL_V1")) {
        const path = decodeEmbeddedPath(script);
        readAclCalls.push(path);
        const isParent = path.toLowerCase() === programDataRoot.toLowerCase();
        const isAuth = path.toLowerCase() === join(agentDirectory, "auth.json").toLowerCase();
        return Buffer.from(JSON.stringify(isParent
          ? { ownerSid: SYSTEM_SID, sddl: state.programDataSddl }
          : isAuth
            ? { ownerSid: state.authOwnerSid, sddl: INHERITED_FILE_DACL.replace(USER_SID, userSid) }
            : { ownerSid: state.agentOwnerSid, sddl: state.agentSddl }), "utf8");
      }
      throw new Error("unexpected security command");
    },
  };
  const security = new HostScopedPrimeAgentAuthSecurity({
    platform: "win32",
    systemRoot: "C:\\Windows",
    programDataRoot,
    commandRunner: runner,
  });
  return {
    hostRoot,
    programDataRoot,
    agentDirectory,
    security,
    createCalls,
    createScripts,
    readAclCalls,
    state,
  };
}

async function temporaryRoot(): Promise<string> {
  // macOS exposes tmpdir() through /var while the physical path is /private/var.
  // Production deliberately rejects such aliases, so fixtures must hand the
  // security boundary the canonical directory they actually created.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "prime-agent-auth-security-")));
  temporaryDirectories.push(directory);
  return directory;
}

function decodeEmbeddedPath(script: string): string {
  const encoded = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  if (!encoded) throw new Error("missing embedded path");
  return Buffer.from(encoded, "base64").toString("utf16le");
}

function fakeProof(): PrimeAgentAuthSecurityProof {
  return Object.freeze({
    canonicalHostDataRoot: "C:\\hostd",
    canonicalCustodyParent: "C:\\ProgramData",
    canonicalAgentDirectory: "C:\\ProgramData\\PrimeContinuim-PrimeAgent-deadbeef",
    custodyParentIdentity: "1:1",
    agentDirectoryIdentity: "1:2",
    platform: "win32",
    currentUserSid: USER_SID,
  });
}
