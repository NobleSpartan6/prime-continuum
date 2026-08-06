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
import { ensurePrivateDirectory } from "./atomic-files";
import { defaultLocalEndpoint, HOSTD_VERSION } from "./paths";
import { HOST_CAPABILITIES } from "./service";
import type { HostStore } from "./store";

const TOOL_TIMEOUT_MS = 2_500;
const TOOL_OUTPUT_LIMIT = 16 * 1024;

export async function collectHostProbe(dataDir: string, store: HostStore): Promise<HostProbe> {
  await ensurePrivateDirectory(dataDir);
  const [git, python, ipython, primeAgent, availableDiskBytes, runningVersion, catalog] = await Promise.all([
    probeTool("git", ["--version"]),
    probeFirstTool([
      ["python3", ["--version"]],
      ["python", ["--version"]],
      ...(process.platform === "win32" ? ([["py", ["--version"]]] as Array<[string, string[]]>) : []),
    ]),
    probeTool("ipython", ["--version"]),
    probeTool("prime-agent", ["--version"]),
    probeAvailableDisk(dataDir),
    probeRunningVersion(defaultLocalEndpoint(dataDir)),
    store.getCatalogSnapshot(),
  ]);

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
    tools: { git, python, ipython, primeAgent },
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
    recentProjects: catalog.projects.slice(0, 1_000),
    capabilities: [...HOST_CAPABILITIES],
  });
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

async function probeRunningVersion(endpoint: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const socket = createConnection(endpoint);
    const decoder = new LengthPrefixedJsonDecoder({ parse: (value) => HostIpcResponseSchema.parse(value) });
    let settled = false;
    const finish = (version?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(version);
    };
    const timer = setTimeout(() => finish(), 500);
    timer.unref();
    socket.once("error", () => finish());
    socket.on("data", (chunk: Buffer) => {
      try {
        const responses = decoder.push(chunk);
        const response = responses[0];
        if (response?.ok && response.method === "health.get") finish(response.result.hostdVersion);
      } catch {
        finish();
      }
    });
    socket.once("connect", () => {
      socket.write(
        encodeJsonFrame({
          protocolVersion: PROTOCOL_VERSION,
          requestId: `probe-${randomUUID()}`,
          method: "health.get",
          payload: {},
        }),
      );
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
