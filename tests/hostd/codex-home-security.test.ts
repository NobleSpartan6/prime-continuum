import { access, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WindowsCodexHomeSecurityProvider,
  areAllExactProtectedCodexHomeDacls,
  areAllSecureCodexHomeDacls,
  assertSafeCodexHomeTree,
  isExactProtectedCodexHomeDacl,
  isSecureInheritedCodexHomeDacl,
} from "../../src/hostd/codex-home-security";
import type { CodexHomeSecurityCommandRunner } from "../../src/hostd/codex-home-security";
import { CodexSubscriptionStore } from "../../src/hostd/codex-subscription-store";
import type { VerifiedCodexAppServerLaunchDescriptor } from "../../src/hostd/runtime-integrity-manager";
import { canonicalTemporaryDirectory } from "../helpers/canonical-temp";

const USER_SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const LOCAL_ADMIN_SID = "S-1-5-21-1111111111-2222222222-3333333333-500";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Codex home security boundary", () => {
  it("accepts only the exact protected user, SYSTEM, and Administrators DACL", () => {
    expect(isExactProtectedCodexHomeDacl(
      `D:P(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      USER_SID,
    )).toBe(true);
    expect(isExactProtectedCodexHomeDacl(
      `D:P(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;S-1-1-0)`,
      USER_SID,
    )).toBe(false);
    const exact = `D:P(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
    expect(areAllExactProtectedCodexHomeDacls(`root ${exact}\nchild ${exact}\n`, USER_SID, 2)).toBe(true);
    expect(areAllExactProtectedCodexHomeDacls(
      `root ${exact}\nchild D:P(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;SY)` +
        `(A;OICI;FA;;;BA)(A;OICI;R;;;S-1-1-0)\n`,
      USER_SID,
      2,
    )).toBe(false);
    expect(isExactProtectedCodexHomeDacl(
      `D:PAI(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      USER_SID,
    )).toBe(true);
    expect(isExactProtectedCodexHomeDacl(
      `D:PARAI(A;CIOI;0x001F01FF;;;${USER_SID})` +
        `(A;OICI;GA;;;S-1-5-18)(A;CIOI;FA;;;S-1-5-32-544)`,
      USER_SID,
    )).toBe(true);
    const inheritedDirectory = `D:ARAI(A;IDCIOI;0x1f01ff;;;${USER_SID})` +
      `(A;OICIID;FA;;;SY)(A;CIIDOI;FA;;;S-1-5-32-544)`;
    const inheritedFile = `D:AI(A;ID;FA;;;${USER_SID})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`;
    expect(isSecureInheritedCodexHomeDacl(inheritedDirectory, USER_SID)).toBe(true);
    expect(isSecureInheritedCodexHomeDacl(inheritedFile, USER_SID)).toBe(true);
    expect(areAllSecureCodexHomeDacls(
      `root ${exact}\ndirectory ${inheritedDirectory}\nfile ${inheritedFile}\n`,
      USER_SID,
      3,
    )).toBe(true);

    for (const nearMiss of [
      `D:AI(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      `D:PRAI(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      `D:P(A;OICI;0x001301ff;;;${USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      `D:P(A;OICI;GRGWGX;;;${USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      `D:P(A;OICIIO;FA;;;${USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      `D:P(A;OICI;FA;11111111-1111-1111-1111-111111111111;;${USER_SID})` +
        `(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      `D:P(D;OICI;FA;;;${USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      `D:P(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;WD)`,
    ]) expect(isExactProtectedCodexHomeDacl(nearMiss, USER_SID)).toBe(false);
    expect(isExactProtectedCodexHomeDacl(
      "D:PAI(A;OICI;FA;;;LA)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
      LOCAL_ADMIN_SID,
    )).toBe(false);
    expect(isExactProtectedCodexHomeDacl(
      "D:PAI(A;OICI;FA;;;LG)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
      "S-1-5-21-1111111111-2222222222-3333333333-501",
    )).toBe(false);
    expect(isSecureInheritedCodexHomeDacl(
      "D:AI(A;OICIID;FA;;;LA)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)",
      LOCAL_ADMIN_SID,
    )).toBe(false);
    expect(isSecureInheritedCodexHomeDacl(
      `D:AI(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      USER_SID,
    )).toBe(false);
    expect(isSecureInheritedCodexHomeDacl(
      `D:AR(A;OICIID;FA;;;${USER_SID})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)`,
      USER_SID,
    )).toBe(false);
    expect(isSecureInheritedCodexHomeDacl(
      `D:AI(A;ID;FA;;;${USER_SID})(A;OICIID;FA;;;SY)(A;ID;FA;;;BA)`,
      USER_SID,
    )).toBe(false);
    expect(isSecureInheritedCodexHomeDacl(
      `D:AI(A;CIID;FA;;;${USER_SID})(A;CIID;FA;;;SY)(A;CIID;FA;;;BA)`,
      USER_SID,
    )).toBe(false);
  });

  it("permits encrypted keyring and bounded session data without permitting plaintext auth", async () => {
    const home = await temporaryHome();
    await mkdir(join(home, "secrets"));
    await writeFile(join(home, "secrets", "codex_auth.age"), "encrypted fixture");
    await mkdir(join(home, "skills", ".system", "review"), { recursive: true });
    await writeFile(join(home, "skills", ".system", "review", "helper.py"), "# signed system skill fixture\n");
    await mkdir(join(home, "sessions", "2026"), { recursive: true });
    await writeFile(join(home, "sessions", "2026", "rollout.jsonl"), "{}\n");
    await expect(assertSafeCodexHomeTree(home)).resolves.toBeUndefined();

    await writeFile(join(home, "auth.json"), "{}\n");
    await expect(assertSafeCodexHomeTree(home)).rejects.toMatchObject({
      code: "CODEX_HOME_CONTENT_INVALID",
    });
  });

  it("rejects executable config and plugin authority anywhere in the dedicated home", async () => {
    const executableHome = await temporaryHome();
    await writeFile(join(executableHome, "bootstrap.ps1"), "Write-Output unsafe\n");
    await expect(assertSafeCodexHomeTree(executableHome)).rejects.toMatchObject({
      code: "CODEX_HOME_CONTENT_INVALID",
    });

    const pluginHome = await temporaryHome();
    await mkdir(join(pluginHome, "plugins"));
    await expect(assertSafeCodexHomeTree(pluginHome)).rejects.toMatchObject({
      code: "CODEX_HOME_CONTENT_INVALID",
    });
  });

  it("bounds the encrypted credential payload before any account operation", async () => {
    const home = await temporaryHome();
    await mkdir(join(home, "secrets"));
    await writeFile(join(home, "secrets", "codex_auth.age"), Buffer.alloc(1024 * 1024 + 1));
    await expect(assertSafeCodexHomeTree(home)).rejects.toMatchObject({
      code: "CODEX_HOME_CONTENT_INVALID",
    });
  });

  it("accepts the bounded signed-out 0.147 restart topology", async () => {
    const home = await temporaryHome();
    for (const name of [
      "goals_1.sqlite",
      "goals_1.sqlite-shm",
      "goals_1.sqlite-wal",
      "installation_id",
      "logs_2.sqlite",
      "logs_2.sqlite-shm",
      "logs_2.sqlite-wal",
      "memories_1.sqlite",
      "memories_1.sqlite-shm",
      "memories_1.sqlite-wal",
      "queue_1.sqlite",
      "queue_1.sqlite-shm",
      "queue_1.sqlite-wal",
      "state_5.sqlite",
      "state_5.sqlite-shm",
      "state_5.sqlite-wal",
    ]) await writeFile(join(home, name), Buffer.alloc(32));
    await mkdir(join(home, "tmp", "arg0"), { recursive: true });
    const systemSkills = join(home, "skills", ".system");
    await mkdir(systemSkills, { recursive: true });
    await writeFile(join(systemSkills, ".codex-system-skills.marker"), "managed by codex\n");
    for (const skill of [
      "imagegen",
      "openai-docs",
      "plugin-creator",
      "review-agent",
      "skill-creator",
      "skill-installer",
    ]) {
      await mkdir(join(systemSkills, skill, "scripts"), { recursive: true });
      await writeFile(join(systemSkills, skill, "SKILL.md"), `# ${skill}\n`);
      await writeFile(join(systemSkills, skill, "scripts", "managed.py"), "# generated\n");
    }
    await expect(assertSafeCodexHomeTree(home)).resolves.toBeUndefined();
  });

  describe.runIf(process.platform === "win32")("descriptor-bound transient apply-patch shims", () => {
    it("accepts the exact stable lock plus LF shim tree only with its verified descriptor", async () => {
      const fixture = await transientShimFixture();
      const lock = await lstat(join(fixture.shimDirectory, ".lock"));
      expect(lock.isFile()).toBe(true);
      expect(lock.isSymbolicLink()).toBe(false);
      expect(lock.nlink).toBe(1);
      expect(lock.size).toBe(0);

      await expect(assertSafeCodexHomeTree(fixture.home)).rejects.toMatchObject({
        code: "CODEX_HOME_CONTENT_INVALID",
      });
      await expect(assertSafeCodexHomeTree(fixture.home, fixture.descriptor)).resolves.toBeUndefined();
    });

    it("rejects shims bound to a different regular executable", async () => {
      const fixture = await transientShimFixture();
      const otherExecutable = join(fixture.executableDirectory, "other-codex-app-server.exe");
      await writeFile(otherExecutable, "other executable fixture\n", "utf8");
      const canonicalOtherExecutable = await realpath(otherExecutable);
      const wrongTemplate = applyPatchShimTemplate(canonicalOtherExecutable);
      await Promise.all(SHIM_FILENAMES.map((name) =>
        writeFile(join(fixture.shimDirectory, name), wrongTemplate, "utf8")));

      await expect(assertSafeCodexHomeTree(fixture.home, fixture.descriptor)).rejects.toMatchObject({
        code: "CODEX_HOME_CONTENT_INVALID",
      });
    });

    it("rejects any byte drift in the descriptor-bound shim template", async () => {
      const fixture = await transientShimFixture();
      await writeFile(
        join(fixture.shimDirectory, "applypatch.bat"),
        applyPatchShimTemplate(fixture.descriptor.executable).replaceAll("\n", "\r\n"),
        "utf8",
      );

      await expect(assertSafeCodexHomeTree(fixture.home, fixture.descriptor)).rejects.toMatchObject({
        code: "CODEX_HOME_CONTENT_INVALID",
      });
    });

    it("rejects a missing stable lock or a partial wrapper set without retrying", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const missingLock = await transientShimFixture();
      await rm(join(missingLock.shimDirectory, ".lock"));
      await expectImmediateContentRejection(
        assertSafeCodexHomeTree(missingLock.home, missingLock.descriptor),
      );

      const partial = await transientShimFixture();
      await rm(join(partial.shimDirectory, "applypatch.bat"));
      await expectImmediateContentRejection(assertSafeCodexHomeTree(partial.home, partial.descriptor));
    });

    it("rejects a wrong-type or nonempty stable lock without retrying", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const wrongType = await transientShimFixture();
      const wrongTypeLock = join(wrongType.shimDirectory, ".lock");
      await rm(wrongTypeLock);
      await mkdir(wrongTypeLock);
      await expectImmediateContentRejection(assertSafeCodexHomeTree(wrongType.home, wrongType.descriptor));

      const nonempty = await transientShimFixture();
      await writeFile(join(nonempty.shimDirectory, ".lock"), "x", "utf8");
      await expectImmediateContentRejection(assertSafeCodexHomeTree(nonempty.home, nonempty.descriptor));
    });

    it("rejects wrong transient directory or shim names", async () => {
      const wrongDirectory = await transientShimFixture("codex-arg0ABC12_");
      await expect(assertSafeCodexHomeTree(wrongDirectory.home, wrongDirectory.descriptor)).rejects.toMatchObject({
        code: "CODEX_HOME_CONTENT_INVALID",
      });

      const wrongFile = await transientShimFixture();
      await rename(
        join(wrongFile.shimDirectory, "applypatch.bat"),
        join(wrongFile.shimDirectory, "apply-patch.bat"),
      );
      await expect(assertSafeCodexHomeTree(wrongFile.home, wrongFile.descriptor)).rejects.toMatchObject({
        code: "CODEX_HOME_CONTENT_INVALID",
      });
    });

    it("rejects any extra entry in an otherwise exact shim directory", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const fixture = await transientShimFixture();
      await writeFile(join(fixture.shimDirectory, "unexpected.txt"), "extra\n", "utf8");

      await expectImmediateContentRejection(assertSafeCodexHomeTree(fixture.home, fixture.descriptor));
    });
  });

  describe.runIf(process.platform === "win32")("local Administrator SDDL alias proof", () => {
    it("accepts LA only after a pinned exact-SID lookup succeeds on the same root", async () => {
      const fixture = await mockedAclBoundary(LOCAL_ADMIN_SID, "LA", "match");

      await expect(fixture.provider.prepareAndVerify(
        fixture.root,
        fixture.home,
        fixture.privateTemporary,
      )).resolves.toMatchObject({ currentUserSid: LOCAL_ADMIN_SID });

      expect(fixture.findSidCalls()).toEqual([{
        executable: join(process.env.SystemRoot!, "System32", "icacls.exe"),
        args: [fixture.privateRoot, "/findsid", `*${LOCAL_ADMIN_SID}`, "/Q"],
      }]);
    });

    it("fails closed when the exact RID-500 lookup command exits unsuccessfully", async () => {
      const fixture = await mockedAclBoundary(LOCAL_ADMIN_SID, "LA", "exit_failure");

      await expect(fixture.provider.prepareAndVerify(
        fixture.root,
        fixture.home,
        fixture.privateTemporary,
      )).rejects.toMatchObject({ code: "CODEX_HOME_SECURITY_TOOL_FAILED" });
      expect(fixture.findSidCalls()).toHaveLength(1);
    });

    it.each([
      ["empty success", "empty_success"],
      ["success without a match", "no_match_success"],
      ["success naming a different root", "wrong_root"],
      ["success naming both the exact and a different root", "ambiguous_match"],
    ] as const)("rejects LA after %s output", async (_label, findSidResult) => {
      const fixture = await mockedAclBoundary(LOCAL_ADMIN_SID, "LA", findSidResult);

      await expect(fixture.provider.prepareAndVerify(
        fixture.root,
        fixture.home,
        fixture.privateTemporary,
      )).rejects.toMatchObject({ code: "CODEX_HOME_ACL_INVALID" });
      expect(fixture.findSidCalls()).toHaveLength(1);
    });

    it("never looks up or accepts LA for an ordinary user SID", async () => {
      const fixture = await mockedAclBoundary(USER_SID, "LA", "match");

      await expect(fixture.provider.prepareAndVerify(
        fixture.root,
        fixture.home,
        fixture.privateTemporary,
      )).rejects.toMatchObject({ code: "CODEX_HOME_ACL_INVALID" });
      expect(fixture.findSidCalls()).toEqual([]);
    });

    it("keeps the numeric ordinary-user path independent of alias lookup", async () => {
      const fixture = await mockedAclBoundary(USER_SID, USER_SID, "exit_failure");

      await expect(fixture.provider.prepareAndVerify(
        fixture.root,
        fixture.home,
        fixture.privateTemporary,
      )).resolves.toMatchObject({ currentUserSid: USER_SID });
      expect(fixture.findSidCalls()).toEqual([]);
    });

    it("does not invoke alias lookup for a numeric RID-500 trustee", async () => {
      const fixture = await mockedAclBoundary(LOCAL_ADMIN_SID, LOCAL_ADMIN_SID, "exit_failure");

      await expect(fixture.provider.prepareAndVerify(
        fixture.root,
        fixture.home,
        fixture.privateTemporary,
      )).resolves.toMatchObject({ currentUserSid: LOCAL_ADMIN_SID });
      expect(fixture.findSidCalls()).toEqual([]);
    });
  });

  it.runIf(process.platform === "win32")(
    "keeps the protected boundary valid after the durable subscription store is initialized",
    async () => {
      const root = await canonicalTemporaryDirectory("prime-codex-store-acl-");
      temporaryDirectories.push(root);
      const privateRoot = join(root, "codex-subscription");
      const home = join(privateRoot, "home");
      const privateTemporary = join(privateRoot, "private-temp");
      const provider = new WindowsCodexHomeSecurityProvider();
      const proof = await prepareNativeBoundary(provider, root, home, privateTemporary);

      const store = new CodexSubscriptionStore({ statePath: join(privateRoot, "state.json") });
      await store.initialize();

      await expect(provider.assertStillSecure(proof)).resolves.toBeUndefined();
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects an existing state root before creating or repairing missing authority children",
    async () => {
      const root = await canonicalTemporaryDirectory("prime-codex-existing-root-");
      temporaryDirectories.push(root);
      const privateRoot = join(root, "codex-subscription");
      const statePath = join(privateRoot, "state.json");
      const home = join(privateRoot, "home");
      const privateTemporary = join(privateRoot, "private-temp");
      await mkdir(privateRoot);
      await writeFile(statePath, "untrusted durable state\n");

      const provider = new WindowsCodexHomeSecurityProvider();
      await expect(provider.prepareAndVerify(root, home, privateTemporary)).rejects.toMatchObject({
        code: "CODEX_HOME_PATH_INVALID",
      });
      await expect(readFile(statePath, "utf8")).resolves.toBe("untrusted durable state\n");
      await expect(access(home)).rejects.toBeDefined();
      await expect(access(privateTemporary)).rejects.toBeDefined();
    },
  );

  it.runIf(process.platform === "win32")(
    "fails closed when an existing encrypted credential child gains Everyone read access",
    async () => {
      const root = await canonicalTemporaryDirectory("prime-codex-acl-");
      temporaryDirectories.push(root);
      const home = join(root, "codex-subscription", "home");
      const privateTemporary = join(root, "codex-subscription", "private-temp");
      const provider = new WindowsCodexHomeSecurityProvider();
      const proof = await prepareNativeBoundary(provider, root, home, privateTemporary);
      await mkdir(join(home, "secrets"));
      const credential = join(home, "secrets", "codex_auth.age");
      await writeFile(credential, "encrypted fixture");
      await expect(provider.assertStillSecure(proof)).resolves.toBeUndefined();

      await runNative(process.env.SystemRoot + "\\System32\\icacls.exe", [
        credential,
        "/grant",
        "*S-1-1-0:(R)",
      ]);
      await expect(provider.assertStillSecure(proof)).rejects.toMatchObject({
        code: "CODEX_HOME_ACL_INVALID",
      });
    },
  );

  it("fails the production capability closed off Windows", async () => {
    const provider = new WindowsCodexHomeSecurityProvider({ platform: "linux" });
    await expect(provider.prepareAndVerify(
      "C:\\host",
      "C:\\host\\codex-subscription\\home",
      "C:\\host\\codex-subscription\\private-temp",
    ))
      .rejects.toMatchObject({ code: "CODEX_HOME_UNSUPPORTED" });
  });
});

async function mockedAclBoundary(
  currentUserSid: string,
  observedUserTrustee: string,
  findSidResult: "match" | "exit_failure" | "empty_success" | "no_match_success" | "wrong_root" |
    "ambiguous_match",
) {
  const root = await canonicalTemporaryDirectory("prime-codex-mocked-acl-");
  temporaryDirectories.push(root);
  const privateRoot = join(root, "codex-subscription");
  const home = join(privateRoot, "home");
  const privateTemporary = join(privateRoot, "private-temp");
  const dacl = `D:PAI(A;OICI;FA;;;${observedUserTrustee})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
  const inheritedDacl = `D:AI(A;OICIID;FA;;;${observedUserTrustee})` +
    "(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)";
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  const commandRunner: CodexHomeSecurityCommandRunner = {
    async run(executable, args) {
      calls.push({ executable, args: [...args] });
      const normalizedExecutable = executable.replaceAll("/", "\\").toLowerCase();
      if (normalizedExecutable.endsWith("\\whoami.exe")) {
        return commandResult(`"HOST\\fixture","${currentUserSid}"\r\n`);
      }
      if (normalizedExecutable.endsWith("\\cacls.exe")) {
        if (args.length === 2 && args[1] === "/s") return commandResult(`root ${dacl}\r\n`);
        if (args.length === 3 && args[1] === "/t" && args[2] === "/s") {
          return commandResult(`root ${dacl}\r\nhome ${inheritedDacl}\r\ntemp ${inheritedDacl}\r\n`);
        }
      }
      if (args[1] === "/findsid") {
        if (findSidResult === "exit_failure") {
          throw new Error("Exact SID lookup exited unsuccessfully");
        }
        if (findSidResult === "match") {
          return commandResult(`SID Found: ${args[0]}.\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`);
        }
        if (findSidResult === "no_match_success") {
          return commandResult(
            "No files with a matching SID was found\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n",
          );
        }
        if (findSidResult === "wrong_root") {
          return commandResult("SID Found: C:\\unrelated\\codex-subscription.\r\n");
        }
        if (findSidResult === "ambiguous_match") {
          return commandResult(
            `SID Found: ${args[0]}.\r\nSID Found: C:\\unrelated\\codex-subscription.\r\n`,
          );
        }
        return commandResult("");
      }
      return commandResult("");
    },
  };
  return Object.freeze({
    root,
    privateRoot,
    home,
    privateTemporary,
    provider: new WindowsCodexHomeSecurityProvider({ commandRunner }),
    findSidCalls: () => calls.filter(({ args }) => args[1] === "/findsid"),
  });
}

function commandResult(stdout: string) {
  return Object.freeze({ stdout: Buffer.from(stdout, "ascii"), stderr: Buffer.alloc(0) });
}

async function temporaryHome(): Promise<string> {
  const directory = await canonicalTemporaryDirectory("prime-codex-home-");
  temporaryDirectories.push(directory);
  return directory;
}

const SHIM_FILENAMES = ["apply_patch.bat", "applypatch.bat"] as const;

async function transientShimFixture(directoryName = "codex-arg0A1b2C3") {
  const home = await temporaryHome();
  const executableDirectory = await canonicalTemporaryDirectory("prime-codex-app-server-executable-");
  temporaryDirectories.push(executableDirectory);
  const executablePath = join(executableDirectory, "codex-app-server.exe");
  await writeFile(executablePath, "executable fixture\n", "utf8");
  const executable = await realpath(executablePath);
  const descriptor = { executable } as VerifiedCodexAppServerLaunchDescriptor;
  const shimDirectory = join(home, "tmp", "arg0", directoryName);
  await mkdir(shimDirectory, { recursive: true });
  await writeFile(join(shimDirectory, ".lock"), Buffer.alloc(0));
  const template = applyPatchShimTemplate(descriptor.executable);
  await Promise.all(SHIM_FILENAMES.map((name) => writeFile(join(shimDirectory, name), template, "utf8")));
  return { home, executableDirectory, descriptor, shimDirectory };
}

function applyPatchShimTemplate(executable: string): string {
  return `@echo off\n"${executable}" --codex-run-as-apply-patch %*\n`;
}

async function expectImmediateContentRejection(promise: Promise<void>): Promise<void> {
  let outcome: Readonly<{ status: "resolved" }> |
    Readonly<{ status: "rejected"; reason: unknown }> |
    undefined;
  void promise.then(
    () => { outcome = { status: "resolved" }; },
    (reason: unknown) => { outcome = { status: "rejected", reason }; },
  );
  for (let turn = 0; turn < 100 && !outcome; turn += 1) {
    expect(vi.getTimerCount()).toBe(0);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
  expect(outcome).toMatchObject({
    status: "rejected",
    reason: { code: "CODEX_HOME_CONTENT_INVALID" },
  });
  expect(vi.getTimerCount()).toBe(0);
}

function runNative(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...args], { shell: false, windowsHide: true, stdio: "ignore" });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolvePromise();
      else rejectPromise(new Error("Native ACL fixture command failed"));
    });
  });
}

async function prepareNativeBoundary(
  provider: WindowsCodexHomeSecurityProvider,
  root: string,
  home: string,
  privateTemporary: string,
) {
  try {
    return await provider.prepareAndVerify(root, home, privateTemporary);
  } catch (error) {
    const diagnostic = await captureSanitizedDaclDiagnostic(join(root, "codex-subscription"));
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "unknown";
    throw new Error(
      `Native CODEX_HOME provisioning failed (${code}); sanitized DACLs=${JSON.stringify(diagnostic)}`,
      { cause: error },
    );
  }
}

async function captureSanitizedDaclDiagnostic(privateRoot: string): Promise<Readonly<Record<string, unknown>>> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) return Object.freeze({ unavailable: "system_root_missing" });
  try {
    const whoami = await runNativeCapture(join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    const currentUserSid = whoami.match(/S-\d-\d+(?:-\d+)+/)?.[0];
    const root = await runNativeCapture(join(systemRoot, "System32", "cacls.exe"), [privateRoot, "/s"]);
    const tree = await runNativeCapture(join(systemRoot, "System32", "cacls.exe"), [privateRoot, "/t", "/s"]);
    const sanitize = (output: string) => (output.match(/D:[A-Z]*(?:\([^()\r\n]+\))+/g) ?? []).map((dacl) =>
      dacl.replace(/S-\d-\d+(?:-\d+)+/g, (sid) => {
        if (sid === currentUserSid) return "CURRENT_USER_SID";
        if (sid === "S-1-5-18" || sid === "S-1-5-32-544") return sid;
        return "OTHER_SID";
      }));
    return Object.freeze({ root: sanitize(root), tree: sanitize(tree) });
  } catch {
    return Object.freeze({ unavailable: "native_query_failed" });
  }
}

function runNativeCapture(executable: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, value = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Native diagnostic timed out"));
    }, 15_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024) {
        child.kill();
        finish(new Error("Native diagnostic output exceeded its bound"));
      } else chunks.push(Buffer.from(chunk));
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null) finish(new Error("Native diagnostic failed"));
      else finish(undefined, Buffer.concat(chunks).toString("ascii"));
    });
  });
}
