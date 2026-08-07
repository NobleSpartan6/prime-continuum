import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  localHostEndpointForCanonicalDataDirectory,
  normalizeHostDataDirectory,
} from "../shared/local-host-target";

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
  residentProjectionTransactions: string;
  receipts: string;
  handoffs: string;
  security: string;
  pairingAuthority: string;
  runtime: string;
  runtimeCurrent: string;
  runtimeInstalls: string;
  runtimeStaging: string;
  journals: string;
  eventJournal: string;
  commandJournal: string;
  workspaceAuthorities: string;
  residentSessionBindings: string;
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
  return normalizeHostDataDirectory(dataDir);
}

/** Pure endpoint formula for a root that is already physically canonical. */
export function defaultLocalEndpoint(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  return localHostEndpointForCanonicalDataDirectory(assertAbsoluteDataDir(dataDir), platform);
}

export function getHostDataPaths(dataDir: string): HostDataPaths {
  const root = assertAbsoluteDataDir(dataDir);
  const journals = join(root, "journals");
  const security = join(root, "security");
  const runtime = join(root, "runtime");
  return {
    root,
    host: join(root, "host.json"),
    projects: join(root, "projects.json"),
    threads: join(root, "threads.json"),
    snapshots: join(root, "snapshots"),
    checkpoints: join(root, "checkpoints"),
    staging: join(root, "handoff-staging"),
    transactions: join(root, "transactions"),
    residentProjectionTransactions: join(root, "resident-projection-transactions"),
    receipts: join(root, "receipts"),
    handoffs: join(root, "handoffs"),
    security,
    pairingAuthority: join(security, "pairing-authority.json"),
    runtime,
    runtimeCurrent: join(runtime, "current.json"),
    runtimeInstalls: join(runtime, "installs"),
    runtimeStaging: join(runtime, "staging"),
    journals,
    eventJournal: join(journals, "events.jsonl"),
    commandJournal: join(journals, "commands.jsonl"),
    workspaceAuthorities: join(root, "workspace-authorities.json"),
    residentSessionBindings: join(root, "resident-session-bindings.json"),
  };
}
