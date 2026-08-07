import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface CanonicalLocalHostTarget {
  /** Physical path after resolving junctions/symlinks when the root exists. */
  readonly dataDirectory: string;
  readonly endpoint: string;
  readonly physicalIdentityAvailable: boolean;
}

export interface ResolveCanonicalLocalHostTargetOptions {
  /** Creates only the root directory needed by serve/seed before resolving it. */
  create?: boolean;
  platform?: NodeJS.Platform;
}

/**
 * Resolves every existing data-root alias to one physical spelling before an
 * endpoint is derived. Missing read-only targets deliberately retain their
 * normalized spelling; there cannot be a live store behind a missing root.
 */
export async function resolveCanonicalLocalHostTarget(
  dataDirectory: string,
  options: ResolveCanonicalLocalHostTargetOptions = {},
): Promise<CanonicalLocalHostTarget> {
  const requested = normalizeHostDataDirectory(dataDirectory);
  if (options.create) await mkdir(requested, { recursive: true, mode: 0o700 });

  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch (error) {
    if (!options.create && isMissingPathError(error)) {
      return Object.freeze({
        dataDirectory: requested,
        endpoint: localHostEndpointForCanonicalDataDirectory(requested, options.platform),
        physicalIdentityAvailable: false,
      });
    }
    throw error;
  }

  const root = await stat(canonical);
  if (!root.isDirectory()) throw new Error("The host data root must be a directory");
  return Object.freeze({
    dataDirectory: canonical,
    endpoint: localHostEndpointForCanonicalDataDirectory(canonical, options.platform),
    physicalIdentityAvailable: true,
  });
}

export function normalizeHostDataDirectory(dataDirectory: string): string {
  if (!dataDirectory || dataDirectory.length > 4_096 || /[\0\r\n]/.test(dataDirectory)) {
    throw new Error("The host data directory must be a bounded path without control characters");
  }
  const normalized = resolve(dataDirectory);
  if (!isAbsolute(normalized)) throw new Error("The host data directory must resolve to an absolute path");
  return normalized;
}

/** Accepts only an already-normalized or physically canonical data root. */
export function localHostEndpointForCanonicalDataDirectory(
  canonicalDataDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = normalizeHostDataDirectory(canonicalDataDirectory);
  if (platform === "win32") {
    const identity = createHash("sha256").update(normalized.toLowerCase()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\prime-agent-hostd-${identity}`;
  }
  return join(normalized, "hostd.sock");
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
