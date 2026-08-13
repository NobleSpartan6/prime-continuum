import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const LOCK_PROTOCOL = "prime-continuim.browser.v1";
const MAX_LOCK_BYTES = 1_024;
const MAX_RECLAIM_GENERATIONS = 256;
const STALE_LOCK_MS = 120_000;
const TOKEN_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export async function withBrowserSessionLock(sessionDirectory, action, options = {}) {
  const now = options.now ?? Date.now;
  const ownerStatus = options.ownerStatus ?? browserLockOwnerStatus;
  const deadOwnerGraceMs = boundedDeadOwnerGraceMs(options.deadOwnerGraceMs);
  const lockPath = join(sessionDirectory, "operation.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await createOperationRecord(lockPath, token)) {
      try {
        return await action();
      } finally {
        await removeExactOperationRecord(lockPath, token).catch(() => undefined);
      }
    }
    if (attempt === 0 && await reclaimDeadBrowserLock(
      sessionDirectory,
      lockPath,
      { deadOwnerGraceMs, now, ownerStatus },
    )) continue;
    throw busyError();
  }
  throw busyError();
}

async function reclaimDeadBrowserLock(sessionDirectory, lockPath, options) {
  const operation = await readOperationRecord(lockPath);
  if (!operation) return false;
  const ageMs = options.now() - operation.mtimeMs;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs < options.deadOwnerGraceMs) return false;
  if (options.ownerStatus(operation.pid) !== "dead") return false;

  // Reclaim claims are immutable generations scoped to this exact operation
  // token. They are intentionally never replaced or deleted. A crashed owner
  // therefore cannot create an ABA window: a successor appends a generation,
  // and only the single newest live owner may inspect/remove the old operation.
  const claim = await acquireReclaimGeneration(sessionDirectory, operation.token, options.ownerStatus);
  if (!claim) return false;
  const current = await readOperationRecord(lockPath);
  if (!sameRecordIdentity(current, operation)) return false;
  await rm(lockPath);
  return true;
}

async function acquireReclaimGeneration(sessionDirectory, operationToken, ownerStatus) {
  for (let attempt = 0; attempt < MAX_RECLAIM_GENERATIONS; attempt += 1) {
    const claims = await listReclaimGenerations(sessionDirectory, operationToken);
    if (claims.length >= MAX_RECLAIM_GENERATIONS) return undefined;
    const latest = claims.at(-1);
    if (latest) {
      const record = await readReclaimRecord(latest.path, operationToken);
      if (!record || ownerStatus(record.pid) !== "dead") return undefined;
    }
    const generation = latest ? latest.generation + 1 : 0;
    if (!Number.isSafeInteger(generation) || generation >= MAX_RECLAIM_GENERATIONS) return undefined;
    const token = randomUUID();
    const path = reclaimPath(sessionDirectory, operationToken, generation);
    if (await createAtomicRecord(path, {
      kind: "reclaim",
      operationToken,
      protocol: LOCK_PROTOCOL,
      pid: process.pid,
      token,
    })) return { generation, path, token };
  }
  return undefined;
}

async function listReclaimGenerations(sessionDirectory, operationToken) {
  const prefix = `operation.lock.reclaim-${operationToken}-`;
  const entries = await readdir(sessionDirectory, { withFileTypes: true });
  const claims = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".json")) continue;
    const suffix = entry.name.slice(prefix.length, -".json".length);
    if (!/^\d{3}$/.test(suffix)) continue;
    claims.push({ generation: Number(suffix), path: join(sessionDirectory, entry.name) });
  }
  claims.sort((left, right) => left.generation - right.generation);
  for (let index = 1; index < claims.length; index += 1) {
    if (claims[index - 1].generation === claims[index].generation) return [];
  }
  return claims;
}

function reclaimPath(sessionDirectory, operationToken, generation) {
  return join(sessionDirectory, `operation.lock.reclaim-${operationToken}-${String(generation).padStart(3, "0")}.json`);
}

async function createOperationRecord(path, token) {
  return createAtomicRecord(path, {
    kind: "operation",
    protocol: LOCK_PROTOCOL,
    pid: process.pid,
    token,
  });
}

async function createAtomicRecord(targetPath, value) {
  const temporaryPath = `${targetPath}.candidate-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, targetPath);
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function removeExactOperationRecord(path, token) {
  const current = await readOperationRecord(path);
  if (!current || current.token !== token || current.pid !== process.pid) return false;
  await rm(path);
  return true;
}

async function readOperationRecord(path) {
  const record = await readBoundedRecord(path);
  if (
    !record ||
    Object.keys(record.value).sort().join(",") !== "kind,pid,protocol,token" ||
    record.value.kind !== "operation" || record.value.protocol !== LOCK_PROTOCOL ||
    !validPid(record.value.pid) || !validToken(record.value.token)
  ) return undefined;
  return { ...record.identity, pid: record.value.pid, token: record.value.token };
}

async function readReclaimRecord(path, operationToken) {
  const record = await readBoundedRecord(path);
  if (
    !record ||
    Object.keys(record.value).sort().join(",") !== "kind,operationToken,pid,protocol,token" ||
    record.value.kind !== "reclaim" || record.value.protocol !== LOCK_PROTOCOL ||
    record.value.operationToken !== operationToken || !validToken(operationToken) ||
    !validPid(record.value.pid) || !validToken(record.value.token)
  ) return undefined;
  return { ...record.identity, pid: record.value.pid, token: record.value.token };
}

async function readBoundedRecord(path) {
  let before;
  try {
    before = await lstat(path);
  } catch {
    return undefined;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 || before.size > MAX_LOCK_BYTES) {
    return undefined;
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const after = await handle.stat();
    if (
      !after.isFile() || after.nlink !== 1 || after.size !== before.size ||
      after.dev !== before.dev || after.ino !== before.ino
    ) return undefined;
    const bytes = await handle.readFile();
    if (bytes.byteLength !== after.size || bytes.byteLength > MAX_LOCK_BYTES) return undefined;
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return {
      value,
      identity: { dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs },
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameRecordIdentity(left, right) {
  return Boolean(
    left && right && left.dev === right.dev && left.ino === right.ino &&
    left.pid === right.pid && left.token === right.token,
  );
}

function validPid(value) {
  return Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function validToken(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

function boundedDeadOwnerGraceMs(value) {
  const grace = value ?? STALE_LOCK_MS;
  if (!Number.isSafeInteger(grace) || grace < 0 || grace > STALE_LOCK_MS) {
    throw new TypeError("Browser dead-owner grace must be a bounded integer.");
  }
  return grace;
}

function browserLockOwnerStatus(pid) {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return error?.code === "ESRCH" ? "dead" : "unknown";
  }
}

function busyError() {
  const busy = new Error("Another browser operation owns this exact session.");
  busy.code = "SESSION_BUSY";
  return busy;
}
