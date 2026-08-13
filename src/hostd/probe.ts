import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { createConnection } from "node:net";
import { arch, homedir, hostname, platform as nodePlatform, release } from "node:os";
import { delimiter, resolve } from "node:path";
import {
  encodeJsonFrame,
  LengthPrefixedJsonDecoder,
} from "../shared/frame-codec";
import {
  HostIpcResponseSchema,
  HostProbeSchema,
  PROTOCOL_VERSION,
  type HostProbe,
  type ProbeToolStatus,
  type SavedProject,
} from "../shared/protocol";
import { resolveCanonicalLocalHostTarget } from "../shared/local-host-target";
import { HOSTD_VERSION } from "./paths";
import { PINNED_PRIME_AGENT_RUNTIME } from "./resident-runtime";
import { HOST_CAPABILITIES } from "./service";

const TOOL_TIMEOUT_MS = 2_500;
const TOOL_OUTPUT_LIMIT = 16 * 1024;
const LIVE_HOST_PROBE_TIMEOUT_MS = 1_000;

export async function collectHostProbe(dataDir: string): Promise<HostProbe> {
  // Existing roots resolve through junction/symlink aliases. A missing probe
  // target remains normalized but is never created.
  const target = await resolveCanonicalLocalHostTarget(dataDir);
  const [git, bash, python, ipython, primeAgent, availableDiskBytes, liveHost] = await Promise.all([
    probeTool("git", ["--version"]),
    probeTool("bash", ["--version"]),
    probeFirstTool([
      ["python3", ["--version"]],
      ["python", ["--version"]],
      ...(process.platform === "win32" ? ([["py", ["--version"]]] as Array<[string, string[]]>) : []),
    ]),
    probeTool("ipython", ["--version"]),
    probeTool("prime-agent", ["--version"]),
    probeAvailableDisk(target.dataDirectory),
    probeLiveHost(target.endpoint),
  ]);
  const { runningVersion, recentProjects } = liveHost;

  const platform = nodePlatform();
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : "unknown";
  return HostProbeSchema.parse({
    probeVersion: 1,
    protocolVersion: String(PROTOCOL_VERSION),
    hostdVersion: HOSTD_VERSION,
    compatible: true,
    generatedAt: new Date().toISOString(),
    platform: { os, architecture: arch(), release: release(), hostname: hostname() || undefined },
    loginShell: boundedEnvironmentValue(platform === "win32" ? process.env.ComSpec : process.env.SHELL),
    homeDirectory: homedir(),
    availableDiskBytes,
    tools: { git, node: nodeRuntimeStatus(), bash, python, ipython, primeAgent },
    primeRuntime: {
      expectedVersion: PINNED_PRIME_AGENT_RUNTIME.expectedAppVersion,
      releaseTag: PINNED_PRIME_AGENT_RUNTIME.releaseTag,
      daemonProtocolVersion: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolVersion,
      schemaRevision: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaRevision,
      schemaId: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaId,
      compatibility: primeAgent.available ? "handshake_required" : "unavailable",
      diagnostic: primeAgent.available
        ? "Daemon compatibility is verified from daemon_hello when a resident session attaches."
        : "Install the pinned Prime Agent runtime before attaching a resident session.",
    },
    hostd: {
      installedVersion: HOSTD_VERSION,
      runningVersion,
      status: runningVersion ? "running" : "installed",
    },
    protocol: {
      minimum: PROTOCOL_VERSION,
      maximum: PROTOCOL_VERSION,
      current: PROTOCOL_VERSION,
      compatible: true,
    },
    configuredRepositoryRoots: configuredRepositoryRoots(),
    recentProjects,
    capabilities: [...HOST_CAPABILITIES],
  });
}

export function nodeRuntimeStatus(version = process.versions.node): ProbeToolStatus {
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) {
    return { available: false, status: "error", diagnostic: "The host Node.js version is invalid." };
  }
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  const supported = major > 22 || (major === 22 && minor >= 12);
  return supported
    ? { available: true, status: "ready", version: `Node.js ${version}` }
    : {
        available: false,
        status: "error",
        version: `Node.js ${version}`,
        diagnostic: "Prime Continuim's hardened Prime Agent 0.7.2 runtime requires Node.js 22.12 or newer.",
      };
}

async function probeFirstTool(candidates: Array<[string, string[]]>): Promise<ProbeToolStatus> {
  let last: ProbeToolStatus | undefined;
  for (const [executable, args] of candidates) {
    const result = await probeTool(executable, args);
    if (result.available) return result;
    last = result;
  }
  return last ?? { available: false, status: "unavailable" };
}

async function probeTool(executable: string, args: string[]): Promise<ProbeToolStatus> {
  return new Promise((resolvePromise) => {
    execFile(
      executable,
      args,
      { timeout: TOOL_TIMEOUT_MS, maxBuffer: TOOL_OUTPUT_LIMIT, windowsHide: true, shell: false },
      (error, stdout, stderr) => {
        const output = `${stdout || ""}\n${stderr || ""}`.trim().split(/\r?\n/, 1)[0]?.trim();
        if (!error) {
          resolvePromise({ available: true, status: "ready", ...(output ? { version: output.slice(0, 256) } : {}) });
          return;
        }
        const code = "code" in error ? error.code : undefined;
        const unavailable = code === "ENOENT";
        resolvePromise({
          available: false,
          status: unavailable ? "unavailable" : "error",
          diagnostic: unavailable ? `${executable} was not found` : `Probe exited without a ready status`,
        });
      },
    );
  });
}

async function probeAvailableDisk(dataDir: string): Promise<number | undefined> {
  try {
    const stats = await statfs(dataDir);
    const value = Number(stats.bavail) * Number(stats.bsize);
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

interface LiveHostProbe {
  runningVersion?: string;
  recentProjects: SavedProject[];
}

/**
 * Reads host-owned metadata only through the live protocol. If no daemon is
 * available, probe remains useful for tool/platform diagnostics but returns no
 * recent-project catalog rather than initializing or recovering durable state.
 */
async function probeLiveHost(endpoint: string): Promise<LiveHostProbe> {
  return new Promise((resolvePromise) => {
    const socket = createConnection(endpoint);
    const decoder = new LengthPrefixedJsonDecoder({ parse: (value) => HostIpcResponseSchema.parse(value) });
    const healthRequestId = `probe-health-${randomUUID()}`;
    const catalogRequestId = `probe-catalog-${randomUUID()}`;
    let settled = false;
    let healthSettled = false;
    let catalogSettled = false;
    let runningVersion: string | undefined;
    let recentProjects: SavedProject[] = [];
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise({ runningVersion, recentProjects });
    };
    const timer = setTimeout(finish, LIVE_HOST_PROBE_TIMEOUT_MS);
    timer.unref();
    socket.once("error", finish);
    socket.once("close", finish);
    socket.on("data", (chunk: Buffer) => {
      try {
        const responses = decoder.push(chunk);
        for (const response of responses) {
          if (response.requestId === healthRequestId && response.method === "health.get") {
            healthSettled = true;
            if (response.ok) runningVersion = response.result.hostdVersion;
          }
          if (response.requestId === catalogRequestId && response.method === "catalog.snapshot") {
            catalogSettled = true;
            if (response.ok) recentProjects = recentProjectSummaries(response.result.projects);
          }
        }
        if (healthSettled && catalogSettled) finish();
      } catch {
        finish();
      }
    });
    socket.once("connect", () => {
      socket.write(Buffer.concat([
        encodeJsonFrame({
          protocolVersion: PROTOCOL_VERSION,
          requestId: healthRequestId,
          method: "health.get",
          payload: {},
        }),
        encodeJsonFrame({
          protocolVersion: PROTOCOL_VERSION,
          requestId: catalogRequestId,
          method: "catalog.snapshot",
          payload: {},
        }),
      ]));
    });
  });
}

function configuredRepositoryRoots(): string[] {
  const value = process.env.PRIME_AGENT_REPOSITORY_ROOTS;
  if (!value) return [];
  return value
    .split(delimiter)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 4_096)
    .slice(0, 128)
    .map((item) => resolve(item));
}

function boundedEnvironmentValue(value: string | undefined): string | undefined {
  return value && value.length <= 1_024 ? value : undefined;
}

export function recentProjectSummaries(projects: SavedProject[]): SavedProject[] {
  return [...projects]
    .sort((left, right) => Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt))
    .slice(0, 1_000);
}
