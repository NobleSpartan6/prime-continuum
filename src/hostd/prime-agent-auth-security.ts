import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, resolve, win32 } from "node:path";
import {
  areAllExactProtectedUserDirectoryDacls,
  areAllSecureUserEntryDacls,
  isSupportedWindowsUserSid,
} from "./windows-security-descriptor";

const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
const WINDOWS_DIRECTORY_PREFIX = "PrimeContinuim-PrimeAgent-";
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";

export type PrimeAgentAuthSecurityErrorCode =
  | "PRIME_AGENT_AUTH_PATH_INVALID"
  | "PRIME_AGENT_AUTH_PERMISSIONS_INVALID"
  | "PRIME_AGENT_AUTH_SECURITY_TOOL_FAILED";

export class PrimeAgentAuthSecurityError extends Error {
  constructor(
    readonly code: PrimeAgentAuthSecurityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PrimeAgentAuthSecurityError";
  }
}

export interface PrimeAgentAuthSecurityProof {
  readonly canonicalHostDataRoot: string;
  readonly canonicalCustodyParent: string;
  readonly canonicalAgentDirectory: string;
  readonly custodyParentIdentity: string;
  readonly agentDirectoryIdentity: string;
  readonly platform: NodeJS.Platform;
  readonly currentUserSid?: string;
}

export interface PrimeAgentAuthSecurityProvider {
  prepareAndVerify(hostDataRoot: string, agentDirectory: string): Promise<PrimeAgentAuthSecurityProof>;
  assertStillSecure(proof: PrimeAgentAuthSecurityProof): Promise<void>;
}

/** The one process-local gate shared by OAuth, catalog discovery, and residents. */
export interface PrimeAgentRuntimeSecurityGate {
  prepareAndVerify(): Promise<void>;
  assertStillSecure(options?: { readonly force?: boolean }): Promise<void>;
  capabilityAvailable?(): boolean;
}

export interface PrimeAgentAuthSecurityCommandRunner {
  run(executable: string, args: readonly string[], stdin?: Uint8Array): Promise<Uint8Array>;
}

export interface HostScopedPrimeAgentAuthSecurityOptions {
  readonly platform?: NodeJS.Platform;
  readonly systemRoot?: string;
  readonly programDataRoot?: string;
  readonly commandRunner?: PrimeAgentAuthSecurityCommandRunner;
  readonly userId?: number;
}

export interface PrimeAgentRuntimeSecurityGuardOptions {
  readonly security: PrimeAgentAuthSecurityProvider;
  readonly hostDataRoot: string;
  readonly agentDirectory: string;
  /** Coalesces adjacent health consumers; sensitive mutations request a forced recheck. */
  readonly verificationTtlMs?: number;
  readonly now?: () => number;
}

export interface ResolvePrimeAgentRuntimeDirectoryOptions {
  readonly platform?: NodeJS.Platform;
  readonly programDataRoot?: string;
}

/**
 * Coalesces the one custody proof used by all Prime Agent entry points. A
 * failed initial proof or later drift is sticky for this hostd generation, so
 * one component can never continue on a proof that another has revoked.
 */
export class SharedPrimeAgentRuntimeSecurityGuard implements PrimeAgentRuntimeSecurityGate {
  private readonly security: PrimeAgentAuthSecurityProvider;
  private readonly hostDataRoot: string;
  private readonly agentDirectory: string;
  private readonly verificationTtlMs: number;
  private readonly now: () => number;
  private proof: PrimeAgentAuthSecurityProof | undefined;
  private preparation: Promise<void> | undefined;
  private assertion: Promise<void> | undefined;
  private failure: PrimeAgentAuthSecurityError | undefined;
  private lastVerifiedAtMs: number | undefined;

  constructor(options: PrimeAgentRuntimeSecurityGuardOptions) {
    this.security = options.security;
    this.hostDataRoot = options.hostDataRoot;
    this.agentDirectory = options.agentDirectory;
    this.verificationTtlMs = options.verificationTtlMs ?? 1_000;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.verificationTtlMs) ||
      this.verificationTtlMs < 0 ||
      this.verificationTtlMs > 60_000
    ) throw new TypeError("Prime Agent custody verification TTL must be an integer from 0 to 60000 milliseconds");
  }

  prepareAndVerify(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.proof) return Promise.resolve();
    if (this.preparation) return this.preparation;
    const preparation = this.security.prepareAndVerify(this.hostDataRoot, this.agentDirectory)
      .then((proof) => {
        this.proof = proof;
      })
      .catch((error: unknown) => {
        throw this.rememberFailure(error);
      });
    this.preparation = preparation;
    void preparation.finally(() => {
      if (this.preparation === preparation) this.preparation = undefined;
    }).catch(() => undefined);
    return preparation;
  }

  capabilityAvailable(): boolean {
    return this.proof !== undefined && this.failure === undefined;
  }

  async assertStillSecure(options: { readonly force?: boolean } = {}): Promise<void> {
    if (this.failure) throw this.failure;
    await this.prepareAndVerify();
    if (this.failure) throw this.failure;
    const now = this.now();
    if (!Number.isFinite(now)) throw this.rememberFailure(undefined);
    if (
      !options.force &&
      this.lastVerifiedAtMs !== undefined &&
      now >= this.lastVerifiedAtMs &&
      now - this.lastVerifiedAtMs < this.verificationTtlMs
    ) return;
    if (this.assertion) return this.assertion;
    const proof = this.proof;
    if (!proof) throw this.rememberFailure(undefined);
    const assertion = this.security.assertStillSecure(proof)
      .then(() => {
        const completedAt = this.now();
        if (!Number.isFinite(completedAt)) throw this.rememberFailure(undefined);
        this.lastVerifiedAtMs = completedAt;
      })
      .catch((error: unknown) => {
        throw this.rememberFailure(error);
      });
    this.assertion = assertion;
    void assertion.finally(() => {
      if (this.assertion === assertion) this.assertion = undefined;
    }).catch(() => undefined);
    return assertion;
  }

  private rememberFailure(error: unknown): PrimeAgentAuthSecurityError {
    this.failure ??= error instanceof PrimeAgentAuthSecurityError
      ? error
      : new PrimeAgentAuthSecurityError(
          "PRIME_AGENT_AUTH_SECURITY_TOOL_FAILED",
          "Prime Agent runtime custody could not be verified safely",
        );
    return this.failure;
  }
}

/**
 * Returns the only supported Prime Agent state root for this host authority.
 *
 * Windows deliberately does not place credential-bearing state under the
 * app's LocalAppData host root: an inherited third-party DELETE_CHILD grant on
 * that parent can replace an otherwise protected child. Instead, hostd uses a
 * directly named, protected leaf under the OS ProgramData boundary. POSIX uses
 * a dedicated child only after proving the canonical host root is not writable
 * by group or other principals.
 */
export function resolvePrimeAgentRuntimeDirectory(
  hostDataRoot: string,
  options: ResolvePrimeAgentRuntimeDirectoryOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const normalizedHostRoot = resolve(hostDataRoot);
  if (platform !== "win32") return resolve(normalizedHostRoot, "prime-agent");
  const programDataRoot = resolve(options.programDataRoot ?? process.env.ProgramData ?? "");
  if (!isSafeLocalWindowsDrivePath(normalizedHostRoot) || !isSafeLocalWindowsDrivePath(programDataRoot)) {
    invalidPath();
  }
  const identity = createHash("sha256")
    .update(normalizedHostRoot.replaceAll("/", "\\").toLowerCase(), "utf8")
    .digest("hex")
    .slice(0, 32);
  return resolve(programDataRoot, `${WINDOWS_DIRECTORY_PREFIX}${identity}`);
}

/**
 * Protects the one Prime Agent directory shared by catalog, OAuth, and resident
 * workers. Prime Agent v0.7.1 intentionally stores OAuth credentials in
 * auth.json; this boundary keeps that upstream file scoped to the host account
 * without inventing a second credential/runtime authority.
 */
export class HostScopedPrimeAgentAuthSecurity implements PrimeAgentAuthSecurityProvider {
  private readonly platform: NodeJS.Platform;
  private readonly systemRoot: string;
  private readonly programDataRoot: string | undefined;
  private readonly runner: PrimeAgentAuthSecurityCommandRunner;
  private readonly userId: number | undefined;

  constructor(options: HostScopedPrimeAgentAuthSecurityOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.userId = options.userId ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    this.runner = options.commandRunner ?? new SpawnedPrimeAgentAuthSecurityCommandRunner();
    const systemRoot = options.systemRoot ?? process.env.SystemRoot;
    if (this.platform === "win32") {
      if (!systemRoot || !isSafeLocalWindowsDrivePath(systemRoot)) this.toolFailure();
      this.systemRoot = resolve(systemRoot);
      const programDataRoot = options.programDataRoot ?? process.env.ProgramData;
      if (!programDataRoot || !isSafeLocalWindowsDrivePath(programDataRoot)) this.invalidPath();
      this.programDataRoot = resolve(programDataRoot);
    } else {
      this.systemRoot = "";
      this.programDataRoot = undefined;
    }
  }

  async prepareAndVerify(
    hostDataRoot: string,
    agentDirectory: string,
  ): Promise<PrimeAgentAuthSecurityProof> {
    const expected = resolvePrimeAgentRuntimeDirectory(hostDataRoot, {
      platform: this.platform,
      ...(this.programDataRoot ? { programDataRoot: this.programDataRoot } : {}),
    });
    if (!samePath(this.platform, expected, resolve(agentDirectory))) this.invalidPath();

    if (this.platform === "win32") {
      return this.prepareAndVerifyWindows(hostDataRoot, expected);
    }
    return this.prepareAndVerifyPosix(hostDataRoot, expected);
  }

  async assertStillSecure(proof: PrimeAgentAuthSecurityProof): Promise<void> {
    const parsed = parseProof(proof);
    if (parsed.platform !== this.platform) this.invalidPath();
    if (this.platform === "win32") {
      if (!parsed.currentUserSid || !this.programDataRoot) this.invalidPermissions();
      const paths = await verifyCanonicalWindowsPaths(
        parsed.canonicalHostDataRoot,
        this.programDataRoot,
        parsed.canonicalAgentDirectory,
      );
      this.assertSameIdentity(paths.custodyParentIdentity, parsed.custodyParentIdentity);
      this.assertSameIdentity(paths.agentDirectoryIdentity, parsed.agentDirectoryIdentity);
      await this.verifyWindowsProgramDataBoundary(paths.canonicalCustodyParent);
      await this.verifyWindowsAgentBoundary(paths.canonicalAgentDirectory, parsed.currentUserSid);
      const after = await identitiesFor(paths.canonicalCustodyParent, paths.canonicalAgentDirectory);
      this.assertSameIdentity(after.custodyParentIdentity, parsed.custodyParentIdentity);
      this.assertSameIdentity(after.agentDirectoryIdentity, parsed.agentDirectoryIdentity);
      return;
    }

    const paths = await verifyCanonicalPosixPaths(
      parsed.canonicalHostDataRoot,
      parsed.canonicalAgentDirectory,
    );
    this.assertSameIdentity(paths.custodyParentIdentity, parsed.custodyParentIdentity);
    this.assertSameIdentity(paths.agentDirectoryIdentity, parsed.agentDirectoryIdentity);
    await this.verifyPosixAncestorCustody(paths.canonicalCustodyParent);
    await this.verifyPosixBoundary(paths.canonicalCustodyParent, paths.canonicalAgentDirectory);
    const after = await identitiesFor(paths.canonicalCustodyParent, paths.canonicalAgentDirectory);
    this.assertSameIdentity(after.custodyParentIdentity, parsed.custodyParentIdentity);
    this.assertSameIdentity(after.agentDirectoryIdentity, parsed.agentDirectoryIdentity);
  }

  private async prepareAndVerifyWindows(
    hostDataRoot: string,
    agentDirectory: string,
  ): Promise<PrimeAgentAuthSecurityProof> {
    if (!this.programDataRoot) this.invalidPath();
    const canonicalHostDataRoot = await canonicalExistingDirectory(hostDataRoot, "win32");
    const canonicalProgramData = await canonicalExistingDirectory(this.programDataRoot, "win32");
    await this.verifyWindowsProgramDataBoundary(canonicalProgramData);
    const currentUserSid = await this.currentWindowsUserSid();
    const existed = await pathExists(agentDirectory);
    if (!existed) await this.createProtectedWindowsDirectory(agentDirectory, currentUserSid);
    const paths = await verifyCanonicalWindowsPaths(canonicalHostDataRoot, canonicalProgramData, agentDirectory);
    await this.verifyWindowsProgramDataBoundary(paths.canonicalCustodyParent);
    await this.verifyWindowsAgentBoundary(paths.canonicalAgentDirectory, currentUserSid);
    return Object.freeze({ ...paths, platform: this.platform, currentUserSid });
  }

  private async prepareAndVerifyPosix(
    hostDataRoot: string,
    agentDirectory: string,
  ): Promise<PrimeAgentAuthSecurityProof> {
    const canonicalHostDataRoot = await canonicalExistingDirectory(hostDataRoot, this.platform);
    await this.verifyPosixAncestorCustody(canonicalHostDataRoot);
    await this.verifyPosixParent(canonicalHostDataRoot);
    if (!(await pathExists(agentDirectory))) {
      try {
        await mkdir(agentDirectory, { mode: 0o700 });
      } catch {
        this.invalidPath();
      }
    }
    const paths = await verifyCanonicalPosixPaths(canonicalHostDataRoot, agentDirectory);
    await this.verifyPosixBoundary(paths.canonicalCustodyParent, paths.canonicalAgentDirectory);
    return Object.freeze({ ...paths, platform: this.platform });
  }

  private async verifyPosixParent(directory: string): Promise<void> {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) this.invalidPath();
    if (this.userId !== undefined && metadata.uid !== this.userId) this.invalidPermissions();
    if ((metadata.mode & 0o022) !== 0) this.invalidPermissions();
  }

  private async verifyPosixAncestorCustody(directory: string): Promise<void> {
    let candidate = dirname(directory);
    while (true) {
      const metadata = await lstat(candidate);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) this.invalidPath();
      if (this.userId !== undefined && metadata.uid !== this.userId && metadata.uid !== 0) {
        this.invalidPermissions();
      }
      // A sticky writable ancestor (normally /tmp) does not let another user
      // rename or delete this user's child. Any other group/other-writable
      // ancestor can replace the entire proven subtree and is rejected.
      if ((metadata.mode & 0o022) !== 0 && (metadata.mode & 0o1000) === 0) {
        this.invalidPermissions();
      }
      const parent = dirname(candidate);
      if (parent === candidate) return;
      candidate = parent;
    }
  }

  private async verifyPosixBoundary(parent: string, directory: string): Promise<void> {
    await this.verifyPosixParent(parent);
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) this.invalidPath();
    if (this.userId !== undefined && metadata.uid !== this.userId) this.invalidPermissions();
    if ((metadata.mode & 0o777) !== 0o700) this.invalidPermissions();

    const authPath = resolve(directory, "auth.json");
    if (!(await pathExists(authPath))) return;
    const auth = await lstat(authPath);
    if (!auth.isFile() || auth.isSymbolicLink() || auth.nlink !== 1) this.invalidPermissions();
    if (this.userId !== undefined && auth.uid !== this.userId) this.invalidPermissions();
    if ((auth.mode & 0o777) !== 0o600) this.invalidPermissions();
  }

  private async currentWindowsUserSid(): Promise<string> {
    const output = await this.runRequired(this.systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    const matches = Buffer.from(output).toString("ascii").match(/S-\d-(?:\d+-)+\d+/g) ?? [];
    if (matches.length !== 1 || !isSupportedWindowsUserSid(matches[0]!)) this.toolFailure();
    return matches[0]!;
  }

  private async createProtectedWindowsDirectory(directory: string, currentUserSid: string): Promise<void> {
    const output = await this.runRequired(this.systemTool("WindowsPowerShell\\v1.0\\powershell.exe"), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShellCommand(WINDOWS_CREATE_PROTECTED_DIRECTORY_SCRIPT, {
        __PATH_BASE64__: encodePowerShellArgument(directory),
        __SID_BASE64__: encodePowerShellArgument(currentUserSid),
      }),
    ]);
    if (output.byteLength !== 0) this.toolFailure();
  }

  private async verifyWindowsProgramDataBoundary(directory: string): Promise<void> {
    const acl = await this.readWindowsAcl(directory);
    if (acl.ownerSid !== WINDOWS_SYSTEM_SID || !isSecureProgramDataSddl(acl.sddl)) {
      this.invalidPermissions();
    }
  }

  private async verifyWindowsAgentBoundary(directory: string, currentUserSid: string): Promise<void> {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) this.invalidPath();
    const rootAcl = await this.readWindowsAcl(directory);
    if (
      rootAcl.ownerSid !== currentUserSid ||
      !areAllExactProtectedUserDirectoryDacls(rootAcl.sddl, currentUserSid, 1)
    ) {
      this.invalidPermissions();
    }

    const authPath = resolve(directory, "auth.json");
    if (!(await pathExists(authPath))) return;
    const authMetadata = await lstat(authPath);
    if (!authMetadata.isFile() || authMetadata.isSymbolicLink() || authMetadata.nlink !== 1) {
      this.invalidPermissions();
    }
    const authAcl = await this.readWindowsAcl(authPath);
    if (
      authAcl.ownerSid !== currentUserSid ||
      !areAllSecureUserEntryDacls(authAcl.sddl, currentUserSid, 1)
    ) {
      this.invalidPermissions();
    }
  }

  private async readWindowsAcl(path: string): Promise<{ readonly ownerSid: string; readonly sddl: string }> {
    const output = await this.runRequired(this.systemTool("WindowsPowerShell\\v1.0\\powershell.exe"), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShellCommand(WINDOWS_READ_ACL_SCRIPT, {
        __PATH_BASE64__: encodePowerShellArgument(path),
      }),
    ]);
    if (output.byteLength < 2 || output.byteLength > 128 * 1024) this.toolFailure();
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(output).toString("utf8"));
    } catch {
      this.toolFailure();
    }
    if (
      !value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      typeof (value as { ownerSid?: unknown }).ownerSid !== "string" ||
      typeof (value as { sddl?: unknown }).sddl !== "string" ||
      !isBoundedWindowsSid((value as { ownerSid: string }).ownerSid) ||
      !isBoundedSddl((value as { sddl: string }).sddl)
    ) {
      this.toolFailure();
    }
    return Object.freeze(value as { ownerSid: string; sddl: string });
  }

  private systemTool(name: string): string {
    return resolve(this.systemRoot, "System32", name);
  }

  private async runRequired(
    executable: string,
    args: readonly string[],
    stdin?: Uint8Array,
  ): Promise<Uint8Array> {
    try {
      return await this.runner.run(executable, args, stdin);
    } catch {
      this.toolFailure();
    }
  }

  private assertSameIdentity(observed: string, expected: string): void {
    if (observed !== expected) this.invalidPath();
  }

  private invalidPath(): never {
    return invalidPath();
  }

  private invalidPermissions(): never {
    throw new PrimeAgentAuthSecurityError(
      "PRIME_AGENT_AUTH_PERMISSIONS_INVALID",
      "Prime Agent runtime custody is not restricted to the current host account",
    );
  }

  private toolFailure(): never {
    throw new PrimeAgentAuthSecurityError(
      "PRIME_AGENT_AUTH_SECURITY_TOOL_FAILED",
      "Prime Agent runtime custody could not be verified safely",
    );
  }
}

class SpawnedPrimeAgentAuthSecurityCommandRunner implements PrimeAgentAuthSecurityCommandRunner {
  run(executable: string, args: readonly string[], stdin?: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      if (!child.stdout || !child.stderr) {
        child.kill();
        rejectPromise(new Error("Prime Agent security command pipes are unavailable"));
        return;
      }
      const stdout: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        child.kill();
        rejectPromise(new Error("Prime Agent security command failed"));
      };
      const timer = setTimeout(fail, COMMAND_TIMEOUT_MS);
      timer.unref?.();
      const collect = (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          fail();
          return;
        }
        stdout.push(Buffer.from(chunk));
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) fail();
      });
      child.once("error", fail);
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0 || signal !== null) {
          rejectPromise(new Error("Prime Agent security command failed"));
          return;
        }
        resolvePromise(Buffer.concat(stdout));
      });
      if (stdin && child.stdin) child.stdin.end(Buffer.from(stdin));
    });
  }
}

async function verifyCanonicalWindowsPaths(
  hostDataRoot: string,
  programDataRoot: string,
  agentDirectory: string,
): Promise<Pick<
  PrimeAgentAuthSecurityProof,
  | "canonicalHostDataRoot"
  | "canonicalCustodyParent"
  | "canonicalAgentDirectory"
  | "custodyParentIdentity"
  | "agentDirectoryIdentity"
>> {
  if (
    !isSafeLocalWindowsDrivePath(hostDataRoot) ||
    !isSafeLocalWindowsDrivePath(programDataRoot) ||
    !isSafeLocalWindowsDrivePath(agentDirectory)
  ) invalidPath();
  const canonicalHostDataRoot = await canonicalExistingDirectory(hostDataRoot, "win32");
  const canonicalCustodyParent = await canonicalExistingDirectory(programDataRoot, "win32");
  const canonicalAgentDirectory = await canonicalExistingDirectory(agentDirectory, "win32");
  const expected = resolvePrimeAgentRuntimeDirectory(canonicalHostDataRoot, {
    platform: "win32",
    programDataRoot: canonicalCustodyParent,
  });
  if (!samePath("win32", expected, canonicalAgentDirectory)) invalidPath();
  const identities = await identitiesFor(canonicalCustodyParent, canonicalAgentDirectory);
  return Object.freeze({
    canonicalHostDataRoot,
    canonicalCustodyParent,
    canonicalAgentDirectory,
    ...identities,
  });
}

async function verifyCanonicalPosixPaths(
  hostDataRoot: string,
  agentDirectory: string,
): Promise<Pick<
  PrimeAgentAuthSecurityProof,
  | "canonicalHostDataRoot"
  | "canonicalCustodyParent"
  | "canonicalAgentDirectory"
  | "custodyParentIdentity"
  | "agentDirectoryIdentity"
>> {
  const canonicalHostDataRoot = await canonicalExistingDirectory(hostDataRoot, process.platform);
  const canonicalAgentDirectory = await canonicalExistingDirectory(agentDirectory, process.platform);
  if (!samePath(process.platform, resolve(canonicalHostDataRoot, "prime-agent"), canonicalAgentDirectory)) {
    invalidPath();
  }
  const identities = await identitiesFor(canonicalHostDataRoot, canonicalAgentDirectory);
  return Object.freeze({
    canonicalHostDataRoot,
    canonicalCustodyParent: canonicalHostDataRoot,
    canonicalAgentDirectory,
    ...identities,
  });
}

async function canonicalExistingDirectory(path: string, platform: NodeJS.Platform): Promise<string> {
  const lexical = resolve(path);
  const canonical = await realpath(lexical);
  if (!samePath(platform, lexical, canonical)) invalidPath();
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalidPath();
  return canonical;
}

async function identitiesFor(
  custodyParent: string,
  agentDirectory: string,
): Promise<Pick<PrimeAgentAuthSecurityProof, "custodyParentIdentity" | "agentDirectoryIdentity">> {
  const [parent, agent] = await Promise.all([lstat(custodyParent), lstat(agentDirectory)]);
  if (
    !parent.isDirectory() || parent.isSymbolicLink() ||
    !agent.isDirectory() || agent.isSymbolicLink()
  ) invalidPath();
  return Object.freeze({
    custodyParentIdentity: `${parent.dev}:${parent.ino}`,
    agentDirectoryIdentity: `${agent.dev}:${agent.ino}`,
  });
}

function parseProof(value: PrimeAgentAuthSecurityProof): PrimeAgentAuthSecurityProof {
  if (
    !value || typeof value !== "object" ||
    typeof value.canonicalHostDataRoot !== "string" ||
    typeof value.canonicalCustodyParent !== "string" ||
    typeof value.canonicalAgentDirectory !== "string" ||
    typeof value.custodyParentIdentity !== "string" ||
    typeof value.agentDirectoryIdentity !== "string" ||
    typeof value.platform !== "string" ||
    (value.currentUserSid !== undefined && !isSupportedWindowsUserSid(value.currentUserSid))
  ) invalidPath();
  return value;
}

function isSecureProgramDataSddl(value: string): boolean {
  const daclIndex = value.indexOf("D:");
  if (daclIndex < 0) return false;
  const dacl = value.slice(daclIndex);
  const bodyStart = dacl.indexOf("(");
  if (bodyStart < 2 || dacl.slice(2, bodyStart) !== "PAI") return false;
  const body = dacl.slice(bodyStart);
  const aces = body.match(/\([^()]+\)/g) ?? [];
  if (aces.join("") !== body || aces.length !== 5) return false;
  const expected = new Set([
    "(A;OICIIO;GA;;;CO)",
    "(A;OICI;FA;;;SY)",
    "(A;OICI;FA;;;BA)",
    "(A;OICI;0x1200a9;;;BU)",
    "(A;CI;DCLCRPCR;;;BU)",
  ]);
  return new Set(aces).size === expected.size && aces.every((ace) => expected.has(ace));
}

function encodePowerShellArgument(value: string): string {
  return Buffer.from(value, "utf16le").toString("base64");
}

function encodePowerShellCommand(source: string, replacements: Readonly<Record<string, string>>): string {
  let command = source;
  for (const [marker, value] of Object.entries(replacements)) {
    if (!/^[A-Z0-9_]+$/.test(marker) || !/^[A-Za-z0-9+/=]+$/.test(value) || !command.includes(marker)) {
      throw new PrimeAgentAuthSecurityError(
        "PRIME_AGENT_AUTH_SECURITY_TOOL_FAILED",
        "Prime Agent runtime custody could not be verified safely",
      );
    }
    command = command.replaceAll(marker, value);
  }
  if (command.includes("__PATH_BASE64__") || command.includes("__SID_BASE64__")) {
    throw new PrimeAgentAuthSecurityError(
      "PRIME_AGENT_AUTH_SECURITY_TOOL_FAILED",
      "Prime Agent runtime custody could not be verified safely",
    );
  }
  return Buffer.from(command, "utf16le").toString("base64");
}

function isBoundedSddl(value: string): boolean {
  return value.length >= 3 && value.length <= 64 * 1024 && !/[\0\r\n]/.test(value) && value.includes("D:");
}

function samePath(platform: NodeJS.Platform, left: string, right: string): boolean {
  return platform === "win32"
    ? left.replaceAll("/", "\\").toLowerCase() === right.replaceAll("/", "\\").toLowerCase()
    : left === right;
}

function isSafeLocalWindowsDrivePath(value: string): boolean {
  if (value.length < 3 || value.length > 32_767 || /[\0\r\n]/.test(value)) return false;
  const normalized = value.replaceAll("/", "\\");
  return /^[A-Za-z]:\\/.test(normalized) && !normalized.slice(2).includes(":") &&
    !normalized.startsWith("\\\\?\\") && !normalized.startsWith("\\\\.\\") &&
    basename(normalized) !== "." && basename(normalized) !== "..";
}

function isBoundedWindowsSid(value: string): boolean {
  return value.length >= 7 && value.length <= 184 && /^S-\d-(?:\d+-)+\d+$/.test(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function invalidPath(): never {
  throw new PrimeAgentAuthSecurityError(
    "PRIME_AGENT_AUTH_PATH_INVALID",
    "Prime Agent runtime custody is not bound to its dedicated canonical host directory",
  );
}

// Marker names are intentionally stable for command-runner contract tests.
const WINDOWS_READ_ACL_SCRIPT = String.raw`
# PRIME_CONTINUIM_READ_PROTECTED_ACL_V1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -Force -ErrorAction Stop
$path = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('__PATH_BASE64__'))
$acl = Get-Acl -LiteralPath $path -ErrorAction Stop
$ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
[Console]::Out.Write((@{ ownerSid = $ownerSid; sddl = $acl.Sddl } | ConvertTo-Json -Compress))
`;

const WINDOWS_CREATE_PROTECTED_DIRECTORY_SCRIPT = String.raw`
# PRIME_CONTINUIM_CREATE_PROTECTED_DIRECTORY_V1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('__PATH_BASE64__'))
$userSidText = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('__SID_BASE64__'))
if (-not ('PrimeContinuim.NativeDirectory' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace PrimeContinuim {
  [StructLayout(LayoutKind.Sequential)]
  public struct SecurityAttributes {
    public int Length;
    public IntPtr SecurityDescriptor;
    public int InheritHandle;
  }
  public static class NativeDirectory {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateDirectory(string path, ref SecurityAttributes securityAttributes);
  }
}
'@
}
$userSid = New-Object System.Security.Principal.SecurityIdentifier($userSidText)
$security = New-Object System.Security.AccessControl.DirectorySecurity
$security.SetOwner($userSid)
$security.SetAccessRuleProtection($true, $false)
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None
foreach ($sidText in @($userSidText, 'S-1-5-18', 'S-1-5-32-544')) {
  $sid = New-Object System.Security.Principal.SecurityIdentifier($sidText)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, [System.Security.AccessControl.AccessControlType]::Allow)
  [void]$security.AddAccessRule($rule)
}
$bytes = $security.GetSecurityDescriptorBinaryForm()
$descriptor = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $descriptor, $bytes.Length)
  $attributes = New-Object PrimeContinuim.SecurityAttributes
  $attributes.Length = [Runtime.InteropServices.Marshal]::SizeOf([type][PrimeContinuim.SecurityAttributes])
  $attributes.SecurityDescriptor = $descriptor
  $attributes.InheritHandle = 0
  if (-not [PrimeContinuim.NativeDirectory]::CreateDirectory($path, [ref]$attributes)) {
    throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
  }
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($descriptor)
}
`;
