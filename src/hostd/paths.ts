import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const HOSTD_VERSION = "0.1.0";

export interface HostDataPaths {
  root: string;
  host: string;
  projects: string;
  threads: string;
  snapshots: string;
  checkpoints: string;
  staging: string;
  transactions: string;
  receipts: string;
  handoffs: string;
  security: string;
  pairingAuthority: string;
  journals: string;
  eventJournal: string;
  commandJournal: string;
}

export function resolveHostDataDir(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome = homedir(),
): string {
  const configured = environment.PRIME_AGENT_DATA_DIR;
  if (configured) {
    return resolve(configured);
  }

  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA || join(userHome, "AppData", "Local");
    return resolve(localAppData, "PrimeAgent", "hostd");
  }
  if (platform === "darwin") {
    return resolve(userHome, "Library", "Application Support", "PrimeAgent", "hostd");
  }

  const stateHome = environment.XDG_STATE_HOME || join(userHome, ".local", "state");
  return resolve(stateHome, "prime-agent", "hostd");
}

export function assertAbsoluteDataDir(dataDir: string): string {
  if (!dataDir || dataDir.length > 4_096) {
    throw new Error("The host data directory must be between 1 and 4096 characters");
  }
  const resolved = resolve(dataDir);
  if (!isAbsolute(resolved)) {
    throw new Error("The host data directory must resolve to an absolute path");
  }
  return resolved;
}

/** Pure endpoint formula mirrored by the native control service. */
export function defaultLocalEndpoint(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = assertAbsoluteDataDir(dataDir);
  if (platform === "win32") {
    const digest = createHash("sha256").update(resolved.toLowerCase()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\prime-agent-hostd-${digest}`;
  }
  return join(resolved, "hostd.sock");
}

export function getHostDataPaths(dataDir: string): HostDataPaths {
  const root = assertAbsoluteDataDir(dataDir);
  const journals = join(root, "journals");
  const security = join(root, "security");
  return {
    root,
    host: join(root, "host.json"),
    projects: join(root, "projects.json"),
    threads: join(root, "threads.json"),
    snapshots: join(root, "snapshots"),
    checkpoints: join(root, "checkpoints"),
    staging: join(root, "handoff-staging"),
    transactions: join(root, "transactions"),
    receipts: join(root, "receipts"),
    handoffs: join(root, "handoffs"),
    security,
    pairingAuthority: join(security, "pairing-authority.json"),
    journals,
    eventJournal: join(journals, "events.jsonl"),
    commandJournal: join(journals, "commands.jsonl"),
  };
}
