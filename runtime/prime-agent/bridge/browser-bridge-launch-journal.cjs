const { randomUUID } = require("node:crypto");
const { constants: fsConstants, closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { chmod, link, lstat, open, readdir, rename, rm } = require("node:fs/promises");
const { dirname, join } = require("node:path");

const PROTOCOL = "prime-continuim.browser.v1";
const MAX_EVIDENCE_BYTES = 8 * 1024;
const NONCE_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BROWSER_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/;
const ENDPOINT_PATTERN = /^http:\/\/127\.0\.0\.1:\d+$/;

async function createStartingLaunch(path, bridgePid, now = Date.now) {
  const record = {
    bridgePid,
    createdAt: now(),
    nonce: randomUUID(),
    phase: "starting",
    protocol: PROTOCOL,
  };
  if (!validLaunchRecord(record)) throw new Error("invalid starting browser launch evidence");
  await durableWrite(path, record);
  return Object.freeze(record);
}

function publishReadyLaunchSync(path, nonce, hostPid, controlPort, now = Date.now) {
  const current = readLaunchRecordSync(path);
  if (!current || current.phase !== "claimed" || current.nonce !== nonce || current.hostPid !== hostPid) {
    throw new Error("browser launch authority changed before host readiness");
  }
  const record = {
    bridgePid: current.bridgePid,
    controlPort,
    createdAt: current.createdAt,
    hostPid,
    nonce: current.nonce,
    phase: "ready",
    protocol: PROTOCOL,
    readyAt: now(),
  };
  if (!validLaunchRecord(record)) throw new Error("invalid ready browser launch evidence");
  durableWriteSync(path, record);
  return Object.freeze(record);
}

function claimBrowserLaunchOwnerSync(path, nonce, hostPid) {
  const current = readLaunchRecordSync(path);
  if (!current || current.phase !== "starting" || current.nonce !== nonce) {
    throw new Error("browser launch authority changed before host claim");
  }
  const owner = {
    kind: "host",
    nonce,
    pid: hostPid,
    protocol: PROTOCOL,
    token: randomUUID(),
  };
  if (!createAtomicOwnerSync(launchOwnerPath(path, nonce), owner)) {
    throw new Error("browser launch ownership was already claimed");
  }
  return Object.freeze(owner);
}

function publishClaimedLaunchSync(path, owner, now = Date.now) {
  if (!validOwnerRecord(owner) || owner.kind !== "host") throw new Error("invalid browser host owner");
  const currentOwner = readOwnerRecordSync(launchOwnerPath(path, owner.nonce));
  const current = readLaunchRecordSync(path);
  if (
    !sameOwner(currentOwner, owner) || !current || current.phase !== "starting" ||
    current.nonce !== owner.nonce
  ) throw new Error("browser launch ownership changed before host claim publication");
  const record = {
    ...current,
    claimedAt: now(),
    hostPid: owner.pid,
    phase: "claimed",
  };
  if (!validLaunchRecord(record)) throw new Error("invalid claimed browser launch evidence");
  durableWriteSync(path, record);
  return Object.freeze(record);
}

async function commitBrowserLaunch(path, ready, metadata, now = Date.now) {
  const current = await readLaunchRecord(path);
  if (!sameReadyLaunch(current, ready) || !metadataMatchesReady(metadata, ready)) {
    throw new Error("browser launch authority changed before commit");
  }
  const record = {
    ...current,
    browserId: metadata.browserId,
    committedAt: now(),
    endpoint: metadata.endpoint,
    phase: "committed",
  };
  if (!validLaunchRecord(record)) throw new Error("invalid committed browser launch evidence");
  await durableWrite(path, record);
  return Object.freeze(record);
}

function publishRetiredLaunchSync(path, nonce, hostPid, now = Date.now) {
  const current = readLaunchRecordSync(path);
  if (!current || current.nonce !== nonce || current.hostPid !== hostPid || current.phase === "starting") {
    return false;
  }
  const record = {
    bridgePid: current.bridgePid,
    createdAt: current.createdAt,
    hostPid,
    nonce,
    phase: "retired",
    protocol: PROTOCOL,
    readyAt: current.readyAt,
    retiredAt: now(),
  };
  if (!validLaunchRecord(record)) return false;
  durableWriteSync(path, record);
  return true;
}

async function readLaunchEvidence(path) {
  return readEvidence(path, validLaunchRecord);
}

async function readLaunchRecord(path) {
  const evidence = await readLaunchEvidence(path);
  return evidence.status === "valid" ? evidence.record : undefined;
}

function readLaunchRecordSync(path) {
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength < 2 || bytes.byteLength > MAX_EVIDENCE_BYTES) return undefined;
    const value = JSON.parse(bytes.toString("utf8"));
    return validLaunchRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readOwnerRecordSync(path) {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size < 2 || entry.size > MAX_EVIDENCE_BYTES) return undefined;
    const bytes = readFileSync(path);
    if (bytes.byteLength !== entry.size) return undefined;
    const value = JSON.parse(bytes.toString("utf8"));
    return validOwnerRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readEvidence(path, validator, options = {}) {
  const inspectPath = options.lstat ?? lstat;
  const openPath = options.open ?? open;
  // A durable publication replaces the journal with rename(2). If that exact
  // replacement lands between lstat and open, the two safe regular files have
  // different identities. Re-read the path a bounded number of times instead
  // of misclassifying a legitimate writer as corruption.
  const maxReplacementRetries = options.maxReplacementRetries ?? 2;
  for (let replacementRetry = 0; replacementRetry <= maxReplacementRetries; replacementRetry += 1) {
    let entry;
    try {
      entry = await inspectPath(path);
    } catch (error) {
      if (error?.code === "ENOENT" && replacementRetry === 0) {
        return Object.freeze({ status: "missing" });
      }
      return Object.freeze({ status: "malformed" });
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size < 2 || entry.size > MAX_EVIDENCE_BYTES) {
      return Object.freeze({ status: "malformed" });
    }
    let handle;
    try {
      handle = await openPath(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const after = await handle.stat();
      if (!after.isFile() || after.nlink !== 1 || after.size < 2 || after.size > MAX_EVIDENCE_BYTES) {
        return Object.freeze({ status: "malformed" });
      }
      if (after.dev !== entry.dev || after.ino !== entry.ino) {
        if (replacementRetry < maxReplacementRetries) continue;
        return Object.freeze({ status: "malformed" });
      }
      if (after.size !== entry.size) return Object.freeze({ status: "malformed" });
      const bytes = await handle.readFile();
      if (bytes.byteLength !== after.size) return Object.freeze({ status: "malformed" });
      const value = JSON.parse(bytes.toString("utf8"));
      return validator(value)
        ? Object.freeze({ status: "valid", record: Object.freeze(value) })
        : Object.freeze({ status: "malformed" });
    } catch {
      return Object.freeze({ status: "malformed" });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return Object.freeze({ status: "malformed" });
}

async function durableWrite(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const bytes = encodeRecord(value);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function createAtomicOwner(path, value) {
  const temporary = `${path}.candidate-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(encodeRecord(value));
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
      await syncDirectory(dirname(path));
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function createAtomicOwnerSync(path, value) {
  const temporary = `${path}.candidate-${process.pid}-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, encodeRecord(value));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporary, path);
      syncDirectorySync(dirname(path));
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    try { rmSync(temporary, { force: true }); } catch {}
  }
}

function durableWriteSync(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const bytes = encodeRecord(value);
  let fileDescriptor;
  try {
    fileDescriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(fileDescriptor, bytes);
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporary, path);
    syncDirectorySync(dirname(path));
  } finally {
    if (fileDescriptor !== undefined) {
      try { closeSync(fileDescriptor); } catch {}
    }
    try { require("node:fs").rmSync(temporary, { force: true }); } catch {}
  }
}

async function durableRemove(path) {
  try {
    await rm(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await syncDirectory(dirname(path));
}

async function cleanupOrphanLaunchOwners(directory, options = {}) {
  const processStatus = options.processStatus ?? (() => "unknown");
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.name.startsWith("launch.owner-") && entry.name.endsWith(".json"));
  if (candidates.length > 64) return "ambiguous";
  for (const entry of candidates) {
    const match = /^launch\.owner-([a-f0-9-]{36})\.json$/.exec(entry.name);
    if (!entry.isFile() || !match || !validNonce(match[1])) return "ambiguous";
    const path = join(directory, entry.name);
    const evidence = await readEvidence(path, validOwnerRecord);
    if (evidence.status !== "valid" || evidence.record.nonce !== match[1]) return "ambiguous";
    if (evidence.record.kind === "host" && processStatus(evidence.record.pid) !== "dead") return "pending";
    await durableRemove(path);
  }
  return "clean";
}

async function cleanupRetiredBrowserState(state, options = {}) {
  await durableRemove(state.metadataPath);
  await durableRemove(state.launchPath);
  const ownerCleanup = await cleanupOrphanLaunchOwners(state.directory, options);
  if (ownerCleanup !== "clean") return ownerCleanup;
  if (options.removeProfile) await rm(state.profileDirectory, { recursive: true, force: true });
  return "clean";
}

async function syncDirectory(path, platform = process.platform) {
  if (platform === "win32") return;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function syncDirectorySync(path, platform = process.platform) {
  if (platform === "win32") return;
  const directoryDescriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

function encodeRecord(value) {
  const bytes = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(bytes) > MAX_EVIDENCE_BYTES) throw new Error("browser launch evidence exceeded its limit");
  return bytes;
}

function sameReadyLaunch(left, right) {
  return Boolean(
    left && right && left.phase === "ready" && right.phase === "ready" &&
    left.protocol === PROTOCOL && left.nonce === right.nonce &&
    left.bridgePid === right.bridgePid && left.hostPid === right.hostPid &&
    left.controlPort === right.controlPort && left.createdAt === right.createdAt &&
    left.readyAt === right.readyAt,
  );
}

function metadataMatchesReady(metadata, ready) {
  return Boolean(
    validBrowserMetadata(metadata) && ready && ready.phase === "ready" &&
    metadata.launchNonce === ready.nonce && metadata.pid === ready.hostPid &&
    metadata.controlPort === ready.controlPort,
  );
}

function metadataMatchesCommitted(metadata, committed) {
  return Boolean(
    validBrowserMetadata(metadata) && committed && committed.phase === "committed" &&
    metadata.launchNonce === committed.nonce && metadata.pid === committed.hostPid &&
    metadata.controlPort === committed.controlPort && metadata.endpoint === committed.endpoint &&
    metadata.browserId === committed.browserId,
  );
}

function validBrowserMetadata(value) {
  return exactKeys(value, ["browserId", "controlPort", "endpoint", "launchNonce", "persistent", "pid", "protocol"]) &&
    value.protocol === PROTOCOL && validNonce(value.launchNonce) && validPid(value.pid) &&
    validPort(value.controlPort) && ENDPOINT_PATTERN.test(value.endpoint) &&
    BROWSER_ID_PATTERN.test(value.browserId) && value.persistent === false;
}

function validLaunchRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.protocol !== PROTOCOL || !validNonce(value.nonce)) return false;
  if (!validPid(value.bridgePid) || !validTime(value.createdAt)) return false;
  switch (value.phase) {
    case "starting":
      return exactKeys(value, ["bridgePid", "createdAt", "nonce", "phase", "protocol"]);
    case "ready":
      return exactKeys(value, ["bridgePid", "controlPort", "createdAt", "hostPid", "nonce", "phase", "protocol", "readyAt"]) &&
        validPid(value.hostPid) && validPort(value.controlPort) && validTime(value.readyAt);
    case "claimed":
      return exactKeys(value, ["bridgePid", "claimedAt", "createdAt", "hostPid", "nonce", "phase", "protocol"]) &&
        validPid(value.hostPid) && validTime(value.claimedAt);
    case "committed":
      return exactKeys(value, ["bridgePid", "browserId", "committedAt", "controlPort", "createdAt", "endpoint", "hostPid", "nonce", "phase", "protocol", "readyAt"]) &&
        validPid(value.hostPid) && validPort(value.controlPort) && validTime(value.readyAt) && validTime(value.committedAt) &&
        ENDPOINT_PATTERN.test(value.endpoint) && BROWSER_ID_PATTERN.test(value.browserId);
    case "retired":
      return exactKeys(value, ["bridgePid", "createdAt", "hostPid", "nonce", "phase", "protocol", "readyAt", "retiredAt"]) &&
        validPid(value.hostPid) && validTime(value.readyAt) && validTime(value.retiredAt);
    default:
      return false;
  }
}

function launchRecoveryDisposition(record, options = {}) {
  if (!validLaunchRecord(record)) return "ambiguous";
  const now = options.now ?? Date.now;
  const processStatus = options.processStatus ?? (() => "unknown");
  if (record.phase === "starting") return "pending";
  if (record.phase === "claimed" || record.phase === "retired") {
    return processStatus(record.hostPid) === "dead" ? "clean" : "pending";
  }
  if (record.phase === "ready" || record.phase === "committed") {
    return processStatus(record.hostPid) === "dead" ? "clean" : "active";
  }
  return "ambiguous";
}

function browserMetadataRecoveryDisposition(launch, metadata, disposition) {
  if (disposition !== "active") return disposition;
  if (launch?.phase === "ready") {
    return metadata && !metadataMatchesReady(metadata, launch) ? "ambiguous" : "active";
  }
  if (launch?.phase === "committed") {
    return metadata && metadataMatchesCommitted(metadata, launch) ? "active" : "ambiguous";
  }
  return "ambiguous";
}

async function resolveStartingLaunch(path, starting, options = {}) {
  if (!validLaunchRecord(starting) || starting.phase !== "starting") return "ambiguous";
  const now = options.now ?? Date.now;
  const processStatus = options.processStatus ?? (() => "unknown");
  if (processStatus(starting.bridgePid) !== "dead" || now() - starting.createdAt < 20_000) return "pending";
  const ownerPath = launchOwnerPath(path, starting.nonce);
  const recoveryOwner = {
    kind: "recovery",
    nonce: starting.nonce,
    pid: process.pid,
    protocol: PROTOCOL,
    token: randomUUID(),
  };
  if (await createAtomicOwner(ownerPath, recoveryOwner)) return "clean";
  const evidence = await readEvidence(ownerPath, validOwnerRecord);
  if (evidence.status !== "valid" || evidence.record.nonce !== starting.nonce) return "ambiguous";
  if (evidence.record.kind === "recovery") return "clean";
  return processStatus(evidence.record.pid) === "dead" ? "clean" : "pending";
}

function launchOwnerPath(launchPath, nonce) {
  return join(dirname(launchPath), `launch.owner-${nonce}.json`);
}

function validOwnerRecord(value) {
  return exactKeys(value, ["kind", "nonce", "pid", "protocol", "token"]) &&
    (value.kind === "host" || value.kind === "recovery") && value.protocol === PROTOCOL &&
    validNonce(value.nonce) && validNonce(value.token) && validPid(value.pid);
}

function sameOwner(left, right) {
  return Boolean(
    validOwnerRecord(left) && validOwnerRecord(right) && left.kind === right.kind &&
    left.nonce === right.nonce && left.pid === right.pid && left.token === right.token,
  );
}

function exactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}

function validNonce(value) {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

function validPid(value) {
  return Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function validTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

module.exports = {
  PROTOCOL,
  claimBrowserLaunchOwnerSync,
  browserMetadataRecoveryDisposition,
  commitBrowserLaunch,
  cleanupOrphanLaunchOwners,
  cleanupRetiredBrowserState,
  createStartingLaunch,
  durableRemove,
  durableWrite,
  launchRecoveryDisposition,
  metadataMatchesCommitted,
  metadataMatchesReady,
  publishClaimedLaunchSync,
  publishReadyLaunchSync,
  publishRetiredLaunchSync,
  readEvidence,
  readLaunchEvidence,
  readLaunchRecord,
  readLaunchRecordSync,
  resolveStartingLaunch,
  syncDirectory,
  syncDirectorySync,
  validBrowserMetadata,
  validLaunchRecord,
  validNonce,
};
