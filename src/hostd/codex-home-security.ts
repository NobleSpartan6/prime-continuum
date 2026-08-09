import { spawn } from "node:child_process";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { VerifiedCodexAppServerLaunchDescriptor } from "./runtime-integrity-manager";

const MAX_HOME_ENTRIES = 4_096;
const MAX_HOME_DEPTH = 16;
const MAX_HOME_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ENCRYPTED_AUTH_BYTES = 1024 * 1024;
const MAX_HOME_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1_024 * 1_024;
const COMMAND_TIMEOUT_MS = 15_000;
const APPLY_PATCH_SHIM_MAX_BYTES = 4 * 1_024;
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
export const CODEX_HOME_CONTENT_POLICY = Object.freeze({
  requireEmptyAtLaunch: true,
  allowedGeneratedSystemSkillsRoot: "skills/.system",
  forbiddenBasenames: Object.freeze([
  ".credentials.json",
    ".env",
    "AGENTS.md",
    "auth.json",
  "config.toml",
    "hooks.json",
  "managed_config.toml",
  "requirements.toml",
  ]),
  forbiddenTopLevelDirectories: Object.freeze([
    ".agents",
    ".codex",
    "agents",
    "commands",
    "marketplaces",
  "plugins",
  "prompts",
  "rules",
  ]),
  forbiddenExecutableExtensions: Object.freeze([
  ".bat",
  ".cmd",
  ".com",
    ".cjs",
  ".dll",
  ".exe",
  ".js",
    ".jsx",
  ".mjs",
  ".ps1",
  ".py",
    ".sh",
    ".ts",
    ".tsx",
  ]),
} as const);
export type CodexHomeContentPolicy = typeof CODEX_HOME_CONTENT_POLICY;
const FORBIDDEN_NAMES = new Set(CODEX_HOME_CONTENT_POLICY.forbiddenBasenames.map((value) => value.toLowerCase()));
const FORBIDDEN_TOP_LEVEL_DIRECTORIES = new Set(
  CODEX_HOME_CONTENT_POLICY.forbiddenTopLevelDirectories.map((value) => value.toLowerCase()),
);
const FORBIDDEN_EXECUTABLE_EXTENSIONS = new Set(CODEX_HOME_CONTENT_POLICY.forbiddenExecutableExtensions);

export type CodexHomeSecurityErrorCode =
  | "CODEX_HOME_UNSUPPORTED"
  | "CODEX_HOME_PATH_INVALID"
  | "CODEX_HOME_ACL_INVALID"
  | "CODEX_HOME_CONTENT_INVALID"
  | "CODEX_HOME_SECURITY_TOOL_FAILED";

type CodexHomeContentDiagnosticReason =
  | "generic"
  | "shim_descriptor_path"
  | "shim_executable_identity"
  | "shim_candidate_count"
  | "shim_directory_identity"
  | "shim_children_type"
  | "shim_children"
  | "shim_expected_size"
  | "shim_extra_entry"
  | "shim_unrecognized_directory"
  | "shim_file_metadata"
  | "shim_file_open"
  | "shim_file_identity"
  | "shim_file_content"
  | "shim_lock_identity"
  | "shim_observation_incomplete";

export class CodexHomeSecurityError extends Error {
  constructor(
    readonly code: CodexHomeSecurityErrorCode,
    message: string,
    readonly diagnosticReason?: CodexHomeContentDiagnosticReason,
  ) {
    super(message);
    this.name = "CodexHomeSecurityError";
  }
}

export interface CodexHomeSecurityProof {
  readonly canonicalHostDataRoot: string;
  readonly canonicalHome: string;
  readonly canonicalTemporaryDirectory: string;
  readonly currentUserSid: string;
  readonly homeState: "first_provisioning" | "verified_restart";
}

export interface CodexHomeSecurityProvider {
  prepareAndVerify(
    hostDataRoot: string,
    codexHome: string,
    temporaryDirectory: string,
  ): Promise<CodexHomeSecurityProof>;
  assertStillSecure(
    proof: CodexHomeSecurityProof,
    descriptor?: VerifiedCodexAppServerLaunchDescriptor,
  ): Promise<void>;
}

interface CommandResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface CodexHomeSecurityCommandRunner {
  run(executable: string, args: readonly string[], stdin?: Uint8Array): Promise<CommandResult>;
}

export interface WindowsCodexHomeSecurityProviderOptions {
  readonly platform?: NodeJS.Platform;
  readonly systemRoot?: string;
  readonly commandRunner?: CodexHomeSecurityCommandRunner;
}

/**
 * Windows-only CODEX_HOME boundary for the official app-server keyring.
 *
 * The provider intentionally uses absolute System32 tools with `shell:false`.
 * `cacls /s:<SDDL>` replaces the DACL rather than adding grants, and a second
 * read verifies that the protected DACL contains only the current user,
 * SYSTEM, and Administrators. Any uncertainty removes the Codex capability.
 */
export class WindowsCodexHomeSecurityProvider implements CodexHomeSecurityProvider {
  private readonly platform: NodeJS.Platform;
  private readonly systemRoot: string;
  private readonly runner: CodexHomeSecurityCommandRunner;

  constructor(options: WindowsCodexHomeSecurityProviderOptions = {}) {
    this.platform = options.platform ?? process.platform;
    const systemRoot = options.systemRoot ?? process.env.SystemRoot;
    if (this.platform !== "win32") {
      this.systemRoot = "";
    } else if (!systemRoot || !isSafeAbsoluteWindowsPath(systemRoot)) {
      throw new CodexHomeSecurityError(
        "CODEX_HOME_SECURITY_TOOL_FAILED",
        "Windows system tools could not be located safely",
      );
    } else {
      this.systemRoot = resolve(systemRoot);
    }
    this.runner = options.commandRunner ?? new SpawnedWindowsSecurityCommandRunner();
  }

  async prepareAndVerify(
    hostDataRoot: string,
    codexHome: string,
    temporaryDirectory: string,
  ): Promise<CodexHomeSecurityProof> {
    this.assertWindows();
    const expected = resolve(hostDataRoot, "codex-subscription", "home");
    const expectedTemporary = resolve(hostDataRoot, "codex-subscription", "private-temp");
    if (
      !sameWindowsPath(expected, resolve(codexHome)) ||
      !sameWindowsPath(expectedTemporary, resolve(temporaryDirectory))
    ) this.invalidPath();
    const privateRoot = resolve(hostDataRoot, "codex-subscription");
    const privateRootExisted = await pathExists(privateRoot);
    const homeExisted = await pathExists(codexHome);
    const temporaryExisted = await pathExists(temporaryDirectory);
    if (privateRootExisted && (!homeExisted || !temporaryExisted)) {
      // An existing private root may already contain durable state or
      // credentials. Never create missing authority children or repair its ACL;
      // the whole root must have been provisioned atomically by this boundary.
      this.invalidPath();
    }
    if (!privateRootExisted && (homeExisted || temporaryExisted)) this.invalidPath();
    if (!privateRootExisted) {
      await mkdir(privateRoot, { mode: 0o700 });
      await mkdir(codexHome, { mode: 0o700 });
      await mkdir(temporaryDirectory, { mode: 0o700 });
    }
    const paths = await verifyCanonicalCodexPaths(hostDataRoot, codexHome, temporaryDirectory);
    await this.assertSystemTools();
    const currentUserSid = await this.readCurrentUserSid();
    const icacls = this.systemTool("icacls.exe");
    const cacls = this.systemTool("cacls.exe");
    const canonicalPrivateRoot = resolve(paths.canonicalHostDataRoot, "codex-subscription");
    if (privateRootExisted) {
      // Never silently repair an existing credential tree. A weak ACL means
      // encrypted credentials may already have been disclosed, so capability
      // admission must fail before reading content or changing permissions.
      await this.verifyDacl(cacls, canonicalPrivateRoot, currentUserSid);
    } else {
      if (
        JSON.stringify((await readdir(canonicalPrivateRoot)).sort()) !== JSON.stringify(["home", "private-temp"]) ||
        (await readdir(paths.canonicalHome)).length !== 0 ||
        (await readdir(paths.canonicalTemporaryDirectory)).length !== 0
      ) {
        throw new CodexHomeSecurityError(
          "CODEX_HOME_CONTENT_INVALID",
          "New CODEX_HOME and private temporary storage must be empty",
        );
      }
      await this.applyAndVerifyDacl(icacls, cacls, canonicalPrivateRoot, currentUserSid);
    }
    await assertSafeCodexHomeTree(paths.canonicalHome);
    await assertPlainPrivateTree(paths.canonicalTemporaryDirectory);
    return Object.freeze({
      ...paths,
      currentUserSid,
      homeState: privateRootExisted ? "verified_restart" : "first_provisioning",
    });
  }

  async assertStillSecure(
    proof: CodexHomeSecurityProof,
    descriptor?: VerifiedCodexAppServerLaunchDescriptor,
  ): Promise<void> {
    this.assertWindows();
    const parsed = parseProof(proof);
    const paths = await verifyCanonicalCodexPaths(
      parsed.canonicalHostDataRoot,
      parsed.canonicalHome,
      parsed.canonicalTemporaryDirectory,
    );
    if (
      !sameWindowsPath(paths.canonicalHome, parsed.canonicalHome) ||
      !sameWindowsPath(paths.canonicalTemporaryDirectory, parsed.canonicalTemporaryDirectory) ||
      !sameWindowsPath(paths.canonicalHostDataRoot, parsed.canonicalHostDataRoot)
    ) {
      this.invalidPath();
    }
    await this.assertSystemTools();
    // Post-operation checks are observation-only. Permission drift is a
    // terminal credential-custody failure, not something to heal after use.
    await this.verifyDacl(
      this.systemTool("cacls.exe"),
      resolve(paths.canonicalHostDataRoot, "codex-subscription"),
      parsed.currentUserSid,
    );
    await assertSafeCodexHomeTree(paths.canonicalHome, descriptor);
    await assertPlainPrivateTree(paths.canonicalTemporaryDirectory);
  }

  private assertWindows(): void {
    if (this.platform !== "win32") {
      throw new CodexHomeSecurityError(
        "CODEX_HOME_UNSUPPORTED",
        "Codex via ChatGPT subscription is available only on the verified Windows host",
      );
    }
  }

  private async assertSystemTools(): Promise<void> {
    for (const executable of [this.systemTool("whoami.exe"), this.systemTool("icacls.exe"), this.systemTool("cacls.exe")]) {
      let metadata;
      try {
        metadata = await lstat(executable);
      } catch {
        throw new CodexHomeSecurityError(
          "CODEX_HOME_SECURITY_TOOL_FAILED",
          "Windows security tooling is unavailable",
        );
      }
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new CodexHomeSecurityError(
          "CODEX_HOME_SECURITY_TOOL_FAILED",
          "Windows security tooling is not a regular system file",
        );
      }
    }
  }

  private async readCurrentUserSid(): Promise<string> {
    const result = await this.runRequired(this.systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    const matches = Buffer.from(result.stdout).toString("ascii").match(/S-\d-\d+(?:-\d+)+/g) ?? [];
    if (matches.length !== 1 || !isUserSid(matches[0]!)) {
      throw new CodexHomeSecurityError(
        "CODEX_HOME_SECURITY_TOOL_FAILED",
        "The current Windows user SID could not be verified",
      );
    }
    return matches[0]!;
  }

  private async applyAndVerifyDacl(
    icacls: string,
    cacls: string,
    directory: string,
    currentUserSid: string,
  ): Promise<void> {
    await this.runRequired(icacls, [directory, "/setowner", `*${currentUserSid}`, "/T", "/Q"]);
    await this.runRequired(
      cacls,
      [directory, "/t", `/s:${protectedDacl(currentUserSid)}`],
      Buffer.from("Y\r\n", "ascii"),
    );
    await this.verifyDacl(cacls, directory, currentUserSid);
  }

  private async verifyDacl(
    cacls: string,
    directory: string,
    currentUserSid: string,
  ): Promise<void> {
    const expectedEntryCount = await countPlainTreeEntries(directory);
    const rootResult = await this.runRequired(cacls, [directory, "/s"]);
    const rootOutput = Buffer.from(rootResult.stdout).toString("ascii");
    const result = await this.runRequired(cacls, [directory, "/t", "/s"]);
    const output = Buffer.from(result.stdout).toString("ascii");
    if (
      !containsOneExactProtectedCodexHomeDacl(rootOutput, currentUserSid) ||
      !areAllSecureCodexHomeDacls(output, currentUserSid, expectedEntryCount)
    ) {
      throw new CodexHomeSecurityError(
        "CODEX_HOME_ACL_INVALID",
        "CODEX_HOME entries do not have the required protected Windows DACL",
      );
    }
  }

  private async runRequired(
    executable: string,
    args: readonly string[],
    stdin?: Uint8Array,
  ): Promise<CommandResult> {
    try {
      return await this.runner.run(executable, args, stdin);
    } catch {
      throw new CodexHomeSecurityError(
        "CODEX_HOME_SECURITY_TOOL_FAILED",
        "Windows CODEX_HOME security verification failed",
      );
    }
  }

  private systemTool(name: string): string {
    return join(this.systemRoot, "System32", name);
  }

  private invalidPath(): never {
    throw new CodexHomeSecurityError(
      "CODEX_HOME_PATH_INVALID",
      "CODEX_HOME is not the dedicated canonical host-data directory",
    );
  }
}

class SpawnedWindowsSecurityCommandRunner implements CodexHomeSecurityCommandRunner {
  run(executable: string, args: readonly string[], stdin?: Uint8Array): Promise<CommandResult> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      if (!child.stdout || !child.stderr) {
        child.kill();
        rejectPromise(new Error("Windows security command pipes are unavailable"));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        child.kill();
        rejectPromise(new Error("Windows security command failed"));
      };
      const timer = setTimeout(fail, COMMAND_TIMEOUT_MS);
      timer.unref?.();
      const consume = (target: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          fail();
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on("data", (chunk: Buffer) => consume(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => consume(stderr, chunk));
      if (stdin && child.stdin) child.stdin.end(Buffer.from(stdin));
      child.once("error", fail);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code !== 0 || signal !== null) {
          rejectPromise(new Error("Windows security command exited unsuccessfully"));
          return;
        }
        resolvePromise(Object.freeze({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
      });
    });
  }
}

export async function assertSafeCodexHomeTree(
  home: string,
  descriptor?: VerifiedCodexAppServerLaunchDescriptor,
): Promise<void> {
  const applyPatchShims = await inspectOptionalApplyPatchShims(home, descriptor);
  const observedApplyPatchShims = new Set<string>();
  let observedApplyPatchLock = false;
  let entriesSeen = 0;
  let totalBytes = 0;
  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > MAX_HOME_DEPTH) invalidContent();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_HOME_ENTRIES || !isSafeName(entry.name)) invalidContent();
      const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
      const normalizedRelative = relativePath.replace(/\\/g, "/").toLowerCase();
      const isGeneratedSystemSkill = normalizedRelative === "skills" ||
        normalizedRelative === CODEX_HOME_CONTENT_POLICY.allowedGeneratedSystemSkillsRoot ||
        normalizedRelative.startsWith(`${CODEX_HOME_CONTENT_POLICY.allowedGeneratedSystemSkillsRoot}/`);
      const isApplyPatchShim = applyPatchShims.files.has(normalizedRelative);
      const isApplyPatchLock = normalizedRelative === applyPatchShims.lockPath;
      if (
        applyPatchShims.directory &&
        normalizedRelative.startsWith(`${applyPatchShims.directory}/`) &&
        !isApplyPatchShim && !isApplyPatchLock
      ) invalidContent("shim_extra_entry");
      if (
        normalizedRelative.startsWith("tmp/arg0/codex-arg0") &&
        /^tmp\/arg0\/codex-arg0[A-Za-z0-9]{6}$/.test(normalizedRelative) &&
        normalizedRelative !== applyPatchShims.directory
      ) invalidContent("shim_unrecognized_directory");
      const entryPath = join(directory, entry.name);
      const metadata = await lstat(entryPath);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) invalidContent();
      if (metadata.isDirectory()) {
        if (relativeDirectory === "" && FORBIDDEN_TOP_LEVEL_DIRECTORIES.has(entry.name.toLowerCase())) {
          invalidContent();
        }
        if (
          normalizedRelative.startsWith("skills/") &&
          normalizedRelative !== CODEX_HOME_CONTENT_POLICY.allowedGeneratedSystemSkillsRoot &&
          !normalizedRelative.startsWith(`${CODEX_HOME_CONTENT_POLICY.allowedGeneratedSystemSkillsRoot}/`)
        ) {
          invalidContent();
        }
        if (normalizedRelative.startsWith("secrets/") && normalizedRelative !== "secrets") invalidContent();
        await visit(entryPath, relativePath, depth + 1);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) invalidContent();
      const lowerName = entry.name.toLowerCase();
      if (FORBIDDEN_NAMES.has(lowerName)) invalidContent();
      if (normalizedRelative.startsWith("skills/") && !isGeneratedSystemSkill) invalidContent();
      const extensionIndex = lowerName.lastIndexOf(".");
      const extension = extensionIndex >= 0 ? lowerName.slice(extensionIndex) : "";
      if (!isGeneratedSystemSkill && !isApplyPatchShim && FORBIDDEN_EXECUTABLE_EXTENSIONS.has(extension)) {
        invalidContent();
      }
      if (isApplyPatchShim) {
        await assertExactApplyPatchShim(entryPath, metadata, applyPatchShims.expectedBytes!);
        observedApplyPatchShims.add(normalizedRelative);
      }
      if (isApplyPatchLock) {
        if (
          !applyPatchShims.lockIdentity || metadata.size !== 0 || metadata.nlink !== 1 ||
          metadata.dev !== applyPatchShims.lockIdentity.dev || metadata.ino !== applyPatchShims.lockIdentity.ino
        ) invalidContent("shim_lock_identity");
        observedApplyPatchLock = true;
      }
      if (normalizedRelative.startsWith("secrets/") && normalizedRelative !== "secrets/codex_auth.age") {
        invalidContent();
      }
      const maximumFileBytes = normalizedRelative === "secrets/codex_auth.age"
        ? MAX_ENCRYPTED_AUTH_BYTES
        : MAX_HOME_FILE_BYTES;
      totalBytes += metadata.size;
      if (metadata.size > maximumFileBytes || totalBytes > MAX_HOME_TOTAL_BYTES) invalidContent();
    }
  };
  await visit(home, "", 0);
  if (observedApplyPatchShims.size !== applyPatchShims.files.size) {
    invalidContent("shim_observation_incomplete");
  }
  if (Boolean(applyPatchShims.lockPath) !== observedApplyPatchLock) {
    invalidContent("shim_observation_incomplete");
  }
}

interface ApplyPatchShimAllowance {
  readonly directory?: string;
  readonly files: ReadonlySet<string>;
  readonly expectedBytes?: Buffer;
  readonly lockPath?: string;
  readonly lockIdentity?: Readonly<{ dev: number; ino: number }>;
}

async function inspectOptionalApplyPatchShims(
  home: string,
  descriptor?: VerifiedCodexAppServerLaunchDescriptor,
): Promise<ApplyPatchShimAllowance> {
  if (!descriptor) return Object.freeze({ files: new Set<string>() });
  const executable = descriptor.executable;
  if (!isSafeAbsoluteWindowsPath(executable)) invalidContent("shim_descriptor_path");
  const canonicalExecutable = await realpath(executable).catch(() => invalidContent("shim_executable_identity"));
  const executableMetadata = await lstat(executable).catch(() => invalidContent("shim_executable_identity"));
  if (
    !sameWindowsPath(canonicalExecutable, executable) ||
    !executableMetadata.isFile() || executableMetadata.isSymbolicLink() || executableMetadata.nlink !== 1
  ) invalidContent("shim_executable_identity");

  const arg0 = join(home, "tmp", "arg0");
  let entries;
  try {
    entries = await readdir(arg0, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return Object.freeze({ files: new Set<string>() });
    throw error;
  }
  const candidates = entries.filter((entry) => /^codex-arg0[A-Za-z0-9]{6}$/.test(entry.name));
  if (candidates.length === 0) return Object.freeze({ files: new Set<string>() });
  if (candidates.length !== 1) invalidContent("shim_candidate_count");
  const candidate = candidates[0]!;
  const directoryPath = join(arg0, candidate.name);
  const directoryMetadata = await lstat(directoryPath).catch(() => invalidContent("shim_directory_identity"));
  const canonicalDirectory = await realpath(directoryPath).catch(() => invalidContent("shim_directory_identity"));
  if (
    !candidate.isDirectory() || candidate.isSymbolicLink() ||
    !directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
    !sameWindowsPath(canonicalDirectory, directoryPath)
  ) invalidContent("shim_directory_identity");
  const children = await readdir(directoryPath, { withFileTypes: true });
  const expectedNames = [".lock", "apply_patch.bat", "applypatch.bat"] as const;
  const observedNames = children.map((entry) => entry.name).sort();
  if (
    JSON.stringify(observedNames) !== JSON.stringify([...expectedNames].sort()) ||
    children.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) invalidContent("shim_children");
  const lockMetadata = await lstat(join(directoryPath, ".lock")).catch(() => invalidContent("shim_lock_identity"));
  if (
    !lockMetadata.isFile() || lockMetadata.isSymbolicLink() ||
    lockMetadata.nlink !== 1 || lockMetadata.size !== 0
  ) invalidContent("shim_lock_identity");
  const expectedBytes = Buffer.from(
    `@echo off\n"${executable}" --codex-run-as-apply-patch %*\n`,
    "utf8",
  );
  if (expectedBytes.byteLength === 0 || expectedBytes.byteLength > APPLY_PATCH_SHIM_MAX_BYTES) {
    invalidContent("shim_expected_size");
  }
  const normalizedDirectory = `tmp/arg0/${candidate.name.toLowerCase()}`;
  return Object.freeze({
    directory: normalizedDirectory,
    files: new Set(["apply_patch.bat", "applypatch.bat"].map((name) => `${normalizedDirectory}/${name}`)),
    expectedBytes,
    lockPath: `${normalizedDirectory}/.lock`,
    lockIdentity: Object.freeze({ dev: lockMetadata.dev, ino: lockMetadata.ino }),
  });
}

async function assertExactApplyPatchShim(
  path: string,
  lexicalMetadata: Awaited<ReturnType<typeof lstat>>,
  expectedBytes: Buffer,
): Promise<void> {
  if (
    !lexicalMetadata.isFile() || lexicalMetadata.isSymbolicLink() || lexicalMetadata.nlink !== 1 ||
    lexicalMetadata.size !== expectedBytes.byteLength
  ) invalidContent("shim_file_metadata");
  const handle = await open(path, "r").catch(() => invalidContent("shim_file_open"));
  try {
    const before = await handle.stat();
    if (
      !before.isFile() || before.nlink !== 1 || before.size !== expectedBytes.byteLength ||
      before.dev !== lexicalMetadata.dev || before.ino !== lexicalMetadata.ino
    ) invalidContent("shim_file_identity");
    const bytes = Buffer.alloc(expectedBytes.byteLength + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== expectedBytes.byteLength || !bytes.subarray(0, offset).equals(expectedBytes) ||
      !after.isFile() || after.nlink !== 1 || after.size !== expectedBytes.byteLength ||
      after.dev !== before.dev || after.ino !== before.ino
    ) invalidContent("shim_file_content");
  } finally {
    await handle.close();
  }
}

export async function assertPlainPrivateTree(root: string): Promise<void> {
  let entriesSeen = 0;
  let totalBytes = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_HOME_DEPTH) invalidContent();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_HOME_ENTRIES || !isSafeName(entry.name)) invalidContent();
      const entryPath = join(directory, entry.name);
      const metadata = await lstat(entryPath);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) invalidContent();
      if (metadata.isDirectory()) {
        await visit(entryPath, depth + 1);
      } else if (!metadata.isFile() || metadata.nlink !== 1) {
        invalidContent();
      } else {
        totalBytes += metadata.size;
        if (metadata.size > MAX_HOME_FILE_BYTES || totalBytes > MAX_HOME_TOTAL_BYTES) invalidContent();
      }
    }
  };
  await visit(root, 0);
}

export function isExactProtectedCodexHomeDacl(sddl: string, currentUserSid: string): boolean {
  if (!isUserSid(currentUserSid)) return false;
  const prefix = sddl.startsWith("D:PAI") ? "D:PAI" : sddl.startsWith("D:P") ? "D:P" : undefined;
  if (!prefix) return false;
  const body = sddl.slice(prefix.length);
  const aces = body.match(/\([^()]+\)/g) ?? [];
  if (aces.join("") !== body || aces.length !== 3) return false;
  const trustees = new Set<string>();
  for (const ace of aces) {
    const fields = ace.slice(1, -1).split(";");
    if (fields.length !== 6 || fields[0] !== "A" || fields[1] !== "OICI" || fields[2] !== "FA") {
      return false;
    }
    const trustee = fields[5] === "SY"
      ? SYSTEM_SID
      : fields[5] === "BA"
        ? ADMINISTRATORS_SID
        : fields[5]!;
    trustees.add(trustee);
  }
  return trustees.size === 3 && trustees.has(currentUserSid) && trustees.has(SYSTEM_SID) &&
    trustees.has(ADMINISTRATORS_SID);
}

export function areAllExactProtectedCodexHomeDacls(
  output: string,
  currentUserSid: string,
  expectedEntryCount: number,
): boolean {
  if (!Number.isSafeInteger(expectedEntryCount) || expectedEntryCount < 1 || expectedEntryCount > MAX_HOME_ENTRIES + 1) {
    return false;
  }
  const dacls = output.match(/D:P(?:AI)?(?:\([^()\r\n]+\))+/g) ?? [];
  return dacls.length === expectedEntryCount &&
    dacls.every((dacl) => isExactProtectedCodexHomeDacl(dacl, currentUserSid));
}

/**
 * Accepts either our exact protected root DACL or the exact effective form
 * inherited by subsequently created descendants. No deny/unknown trustee,
 * partial access, inherit-only ACE, or explicit broad grant is accepted.
 */
export function isSecureInheritedCodexHomeDacl(sddl: string, currentUserSid: string): boolean {
  if (!isUserSid(currentUserSid) || !sddl.startsWith("D:AI")) return false;
  const body = sddl.slice(4);
  const aces = body.match(/\([^()]+\)/g) ?? [];
  if (aces.join("") !== body || aces.length !== 3) return false;
  const trustees = new Set<string>();
  for (const ace of aces) {
    const fields = ace.slice(1, -1).split(";");
    if (fields.length !== 6 || fields[0] !== "A" || fields[2] !== "FA") return false;
    const flags = fields[1]!;
    const tokens: string[] = flags.match(/OI|CI|ID/g) ?? [];
    if (tokens.join("") !== flags || !tokens.includes("ID")) return false;
    const trustee = fields[5] === "SY"
      ? SYSTEM_SID
      : fields[5] === "BA"
        ? ADMINISTRATORS_SID
        : fields[5]!;
    trustees.add(trustee);
  }
  return trustees.size === 3 && trustees.has(currentUserSid) && trustees.has(SYSTEM_SID) &&
    trustees.has(ADMINISTRATORS_SID);
}

export function areAllSecureCodexHomeDacls(
  output: string,
  currentUserSid: string,
  expectedEntryCount: number,
): boolean {
  if (!Number.isSafeInteger(expectedEntryCount) || expectedEntryCount < 1 || expectedEntryCount > MAX_HOME_ENTRIES + 1) {
    return false;
  }
  const dacls = output.match(/D:(?:P(?:AI)?|AI)(?:\([^()\r\n]+\))+/g) ?? [];
  return dacls.length === expectedEntryCount && dacls.every((dacl) =>
    isExactProtectedCodexHomeDacl(dacl, currentUserSid) ||
    isSecureInheritedCodexHomeDacl(dacl, currentUserSid));
}

function containsOneExactProtectedCodexHomeDacl(output: string, currentUserSid: string): boolean {
  const dacls = output.match(/D:(?:P(?:AI)?|AI)(?:\([^()\r\n]+\))+/g) ?? [];
  return dacls.length === 1 && isExactProtectedCodexHomeDacl(dacls[0]!, currentUserSid);
}

function protectedDacl(currentUserSid: string): string {
  return `D:P(A;OICI;FA;;;${currentUserSid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
}

async function verifyCanonicalCodexPaths(
  hostDataRoot: string,
  home: string,
  temporaryDirectory: string,
): Promise<Pick<
  CodexHomeSecurityProof,
  "canonicalHostDataRoot" | "canonicalHome" | "canonicalTemporaryDirectory"
>> {
  if (
    !isSafeAbsoluteWindowsPath(hostDataRoot) ||
    !isSafeAbsoluteWindowsPath(home) ||
    !isSafeAbsoluteWindowsPath(temporaryDirectory)
  ) invalidPath();
  const lexicalRoot = resolve(hostDataRoot);
  const lexicalHome = resolve(home);
  const lexicalTemporary = resolve(temporaryDirectory);
  if (
    !sameWindowsPath(resolve(lexicalRoot, "codex-subscription", "home"), lexicalHome) ||
    !sameWindowsPath(resolve(lexicalRoot, "codex-subscription", "private-temp"), lexicalTemporary)
  ) invalidPath();
  const canonicalHostDataRoot = await realpath(lexicalRoot);
  const canonicalHome = await realpath(lexicalHome);
  const canonicalTemporaryDirectory = await realpath(lexicalTemporary);
  if (
    !sameWindowsPath(canonicalHostDataRoot, lexicalRoot) ||
    !sameWindowsPath(canonicalHome, lexicalHome) ||
    !sameWindowsPath(canonicalTemporaryDirectory, lexicalTemporary) ||
    !sameWindowsPath(resolve(canonicalHostDataRoot, "codex-subscription", "home"), canonicalHome) ||
    !sameWindowsPath(
      resolve(canonicalHostDataRoot, "codex-subscription", "private-temp"),
      canonicalTemporaryDirectory,
    )
  ) {
    invalidPath();
  }
  for (const candidate of [
    canonicalHostDataRoot,
    resolve(canonicalHostDataRoot, "codex-subscription"),
    canonicalHome,
    canonicalTemporaryDirectory,
  ]) {
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalidPath();
  }
  return Object.freeze({ canonicalHostDataRoot, canonicalHome, canonicalTemporaryDirectory });
}

function parseProof(value: CodexHomeSecurityProof): CodexHomeSecurityProof {
  if (
    !isSafeAbsoluteWindowsPath(value.canonicalHostDataRoot) ||
    !isSafeAbsoluteWindowsPath(value.canonicalHome) ||
    !isSafeAbsoluteWindowsPath(value.canonicalTemporaryDirectory) ||
    !isUserSid(value.currentUserSid) ||
    (value.homeState !== "first_provisioning" && value.homeState !== "verified_restart")
  ) {
    invalidPath();
  }
  return value;
}

function isSafeAbsoluteWindowsPath(value: string): boolean {
  return isAbsolute(value) && /^[A-Za-z]:[\\/]/.test(value) && value.length <= 2_048 &&
    !/[\0\r\n]/.test(value) && !value.slice(2).includes(":");
}

function sameWindowsPath(first: string, second: string): boolean {
  return first.replace(/\//g, "\\").toLowerCase() === second.replace(/\//g, "\\").toLowerCase();
}

function isSafeName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." &&
    !/[^\S ]|[\0\r\n/:]/.test(value) && value.normalize("NFC") === value && basename(value) === value;
}

function isUserSid(value: string): boolean {
  return /^S-1-5-21(?:-\d+){4}$/.test(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error &&
      (error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

async function countPlainTreeEntries(root: string): Promise<number> {
  let count = 1;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_HOME_DEPTH) invalidContent();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      count += 1;
      if (count > MAX_HOME_ENTRIES + 1 || !isSafeName(entry.name)) invalidContent();
      const metadata = await lstat(join(directory, entry.name));
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) invalidContent();
      if (metadata.isDirectory()) {
        await visit(join(directory, entry.name), depth + 1);
      } else if (!metadata.isFile() || metadata.nlink !== 1) {
        invalidContent();
      }
    }
  };
  await visit(root, 0);
  return count;
}

function invalidPath(): never {
  throw new CodexHomeSecurityError(
    "CODEX_HOME_PATH_INVALID",
    "CODEX_HOME is not the dedicated canonical host-data directory",
  );
}

function invalidContent(reason: CodexHomeContentDiagnosticReason = "generic"): never {
  throw new CodexHomeSecurityError(
    "CODEX_HOME_CONTENT_INVALID",
    "CODEX_HOME contains forbidden credential or executable configuration state",
    reason,
  );
}
