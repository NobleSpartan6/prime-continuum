import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ZodType } from "zod";

export const DEFAULT_MAX_STATE_FILE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_JOURNAL_ENTRY_BYTES = 1024 * 1024;

/** A destination is visible even though its durability could not be confirmed. */
export class AtomicWriteAmbiguousCommitError extends Error {
  readonly code = "ATOMIC_WRITE_COMMIT_UNCERTAIN";
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`Atomic write became visible but durability could not be confirmed: ${path}`, {
      cause,
    });
    this.name = "AtomicWriteAmbiguousCommitError";
    this.path = path;
  }
}

export type AtomicCreateFaultPoint = "after_open" | "after_write" | "after_sync" | "after_close" | "after_link";

export interface AtomicCreateOptions {
  faultInjector?: (point: AtomicCreateFaultPoint) => void | Promise<void>;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function readJsonFile<T>(
  path: string,
  schema: ZodType<T>,
  options: { optional?: boolean; maxBytes?: number } = {},
): Promise<T | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (options.optional && isMissingFileError(error)) return undefined;
    throw error;
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_STATE_FILE_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new Error(`State file exceeds the ${maxBytes}-byte limit: ${path}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`State file is not valid JSON: ${path}`, { cause: error });
  }
  return schema.parse(value);
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
  maxBytes = DEFAULT_MAX_STATE_FILE_BYTES,
): Promise<void> {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  await atomicWriteBytes(path, body, maxBytes);
}

export async function atomicWriteBytes(
  path: string,
  body: Uint8Array,
  maxBytes = DEFAULT_MAX_STATE_FILE_BYTES,
): Promise<void> {
  if (body.byteLength > maxBytes) {
    throw new Error(`Refusing to write ${body.byteLength} bytes to bounded state file ${path}`);
  }

  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle;
  let renamed = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    renamed = true;
    await syncParentDirectory(path);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (renamed) throw new AtomicWriteAmbiguousCommitError(path, error);
    throw error;
  }
}

/**
 * Logically appends one JSONL record while atomically replacing the bounded
 * file. A deterministic record ID makes replay after a crash exactly-once.
 */
export async function appendJsonLineOnce(
  path: string,
  value: Record<string, unknown>,
  idField: string,
  options: { maxEntryBytes?: number; maxFileBytes?: number; maxLines?: number } = {},
): Promise<boolean> {
  const id = value[idField];
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    throw new Error(`JSONL record requires a bounded string ${idField}`);
  }
  const line = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_JOURNAL_ENTRY_BYTES;
  if (line.byteLength > maxEntryBytes) {
    throw new Error(`Refusing to append a ${line.byteLength}-byte journal entry to ${path}`);
  }

  let current = Buffer.alloc(0);
  try {
    current = await readFile(path);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_STATE_FILE_BYTES;
  if (current.byteLength > maxFileBytes) throw new Error(`Journal exceeds its bounded size: ${path}`);
  if (current.byteLength > 0 && current[current.byteLength - 1] !== 0x0a) {
    throw new Error(`Journal does not end at an atomic JSONL record boundary: ${path}`);
  }

  const lines = current.toString("utf8").split("\n").filter(Boolean);
  const maxLines = options.maxLines ?? 100_000;
  if (lines.length > maxLines) throw new Error(`Journal exceeds the ${maxLines}-line limit: ${path}`);
  for (const existingLine of lines) {
    let existing: unknown;
    try {
      existing = JSON.parse(existingLine) as unknown;
    } catch (error) {
      throw new Error(`Journal contains invalid JSON: ${path}`, { cause: error });
    }
    if (
      typeof existing === "object" &&
      existing !== null &&
      idField in existing &&
      (existing as Record<string, unknown>)[idField] === id
    ) {
      if (!isDeepStrictEqual(existing, value)) {
        throw new Error(`Journal record ID collision for ${id} in ${path}`);
      }
      return false;
    }
  }
  if (lines.length >= maxLines) throw new Error(`Journal has reached the ${maxLines}-line limit: ${path}`);
  const next = Buffer.concat([current, line]);
  await atomicWriteBytes(path, next, maxFileBytes);
  return true;
}

export async function atomicWriteJsonIfAbsent(
  path: string,
  value: unknown,
  maxBytes = DEFAULT_MAX_STATE_FILE_BYTES,
  options: AtomicCreateOptions = {},
): Promise<boolean> {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (body.byteLength > maxBytes) {
    throw new Error(`Refusing to write ${body.byteLength} bytes to bounded state file ${path}`);
  }

  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle;
  let linkAttempted = false;
  let linked = false;
  try {
    // Write and flush a private sibling before exposing the immutable name.
    // A direct `open(path, "wx")` makes an empty/partial destination visible
    // as soon as open succeeds, so write/sync/close failures can poison a
    // later create-if-absent retry.
    handle = await open(temporary, "wx", 0o600);
    await options.faultInjector?.("after_open");
    await handle.writeFile(body);
    await options.faultInjector?.("after_write");
    await handle.sync();
    await options.faultInjector?.("after_sync");
    await handle.close();
    handle = undefined;
    await options.faultInjector?.("after_close");

    // A same-directory hard link is an atomic no-replace publication: either
    // this complete, flushed inode gets the destination name or an existing
    // destination wins with EEXIST.
    linkAttempted = true;
    await link(temporary, path);
    linked = true;
    await options.faultInjector?.("after_link");
    await rm(temporary);
    await syncParentDirectory(path);
    return true;
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (linked) throw new AtomicWriteAmbiguousCommitError(path, error);
    if (linkAttempted && isAlreadyExistsError(error)) {
      try {
        // A prior successful or crash-interrupted creator may own the name.
        // Re-flush both its contents and directory entry before reporting an
        // idempotent existing result to a durability-sensitive caller.
        await confirmExistingFileDurability(path);
        return false;
      } catch (confirmationError) {
        throw new AtomicWriteAmbiguousCommitError(path, confirmationError);
      }
    }
    throw error;
  }
}

export async function appendJsonLine(
  path: string,
  value: unknown,
  maxBytes = DEFAULT_MAX_JOURNAL_ENTRY_BYTES,
): Promise<void> {
  const line = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (line.byteLength > maxBytes) {
    throw new Error(`Refusing to append a ${line.byteLength}-byte journal entry to ${path}`);
  }

  await ensurePrivateDirectory(dirname(path));
  const handle = await open(path, "a", 0o600);
  try {
    // One append call keeps a complete JSONL record together. HostStore also
    // serializes all writers in-process.
    await handle.write(line, 0, line.byteLength, null);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJsonLines<T>(
  path: string,
  schema: ZodType<T>,
  options: { optional?: boolean; maxBytes?: number; maxLines?: number } = {},
): Promise<T[]> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (options.optional && isMissingFileError(error)) return [];
    throw error;
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_STATE_FILE_BYTES;
  if (bytes.byteLength > maxBytes) throw new Error(`Journal exceeds the ${maxBytes}-byte read limit: ${path}`);
  const lines = bytes.toString("utf8").split("\n").filter(Boolean);
  const maxLines = options.maxLines ?? 100_000;
  if (lines.length > maxLines) throw new Error(`Journal exceeds the ${maxLines}-line read limit: ${path}`);
  return lines.map((line, index) => {
    try {
      return schema.parse(JSON.parse(line) as unknown);
    } catch (error) {
      throw new Error(`Invalid JSONL record ${index + 1} in ${path}`, { cause: error });
    }
  });
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/**
 * POSIX requires the containing directory to be synced after a rename or new
 * entry if the name itself must survive power loss. Windows does not expose a
 * portable directory fsync through Node; the flushed file plus atomic rename
 * remains the strongest available contract there.
 */
async function syncParentDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function confirmExistingFileDurability(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncParentDirectory(path);
}
