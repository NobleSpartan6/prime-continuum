import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_IDENTITIES = 128;
const MAX_PROCESS_ROWS = 16_384;
const MAX_AUDIT_FILE_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;

const [daemonClientPath, socketPath, agentDirectory, expectedJson] = process.argv.slice(2);
if (![daemonClientPath, socketPath, agentDirectory].every((value) => typeof value === "string" && isAbsolute(value))) {
  throw new Error("invalid exact daemon cleanup input");
}
const expected = parseExpected(expectedJson);
const moduleUrl = pathToFileURL(daemonClientPath).href;
const [{ DaemonClient }, { defaultDaemonSocketDir }, { getProcessStartId }] = await Promise.all([
  import(moduleUrl),
  import(new URL("./daemon-socket.js", moduleUrl)),
  import(new URL("../../core/session-lease.js", moduleUrl)),
]);

const registryDirectory = process.env.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR ??
  resolve(defaultDaemonSocketDir(), "supervisor-owners");
const descriptorKey = createHash("sha256").update(socketPath).digest("hex").slice(0, 12);
const expectedDescriptorDirectory = join(agentDirectory, "daemon-workers", descriptorKey);
const client = new DaemonClient(socketPath);
let identities = [];
let processGroups = [];
let shutdownConfirmed = false;
let exactOwnerDirectory;
try {
  await client.connect(1_000);
  const hello = await client.waitForHello(2_000);
  validateHello(hello, expected);
  const owners = await readMatchingOwners();
  if (owners.length !== 1) throw new Error("resident daemon did not retain one exact owner");
  validateOwner(owners[0], hello);
  exactOwnerDirectory = owners[0].directory;
  ({ identities, processGroups } = captureProcessTree(hello.supervisorPid));
  const listResponse = await client.request({ type: "list", includeClientOwned: true }, 5_000);
  if (
    listResponse?.type !== "response" || listResponse.command !== "list" || listResponse.success !== true ||
    !Array.isArray(listResponse.data?.sessions) || listResponse.data.sessions.length !== 0
  ) throw new Error("resident daemon still has sessions");
  const shutdownResponse = await client.request({ type: "shutdown" }, 5_000);
  shutdownConfirmed = shutdownResponse?.type === "response" &&
    shutdownResponse.command === "shutdown" && shutdownResponse.success === true;
  if (!shutdownConfirmed) throw new Error("resident daemon did not confirm graceful shutdown");
  const trailing = captureProcessTreeIfCurrent(hello.supervisorPid, hello.supervisorProcessStartId);
  identities = mergeIdentities(identities, trailing.identities);
  processGroups = mergeGroups(processGroups, trailing.processGroups);
} finally {
  client.close();
}

const deadline = Date.now() + 30_000;
let endpointRetired = false;
let ownerRetired = false;
let terminatedIdentityCount = 0;
let retiredProcessGroupCount = 0;
while (Date.now() < deadline) {
  endpointRetired = !(await endpointAcceptsConnection());
  ownerRetired = exactOwnerDirectory !== undefined && await pathAbsent(exactOwnerDirectory) &&
    (await readMatchingOwners()).length === 0;
  terminatedIdentityCount = identities.filter(exactIdentityRetired).length;
  retiredProcessGroupCount = processGroups.filter(processGroupRetired).length;
  if (
    endpointRetired && ownerRetired &&
    terminatedIdentityCount === identities.length &&
    retiredProcessGroupCount === processGroups.length
  ) break;
  await delay(100);
}
if (
  !shutdownConfirmed || !endpointRetired || !ownerRetired || identities.length < 1 ||
  terminatedIdentityCount !== identities.length || processGroups.length < 1 ||
  retiredProcessGroupCount !== processGroups.length
) throw new Error("resident daemon cleanup proof did not converge");

const output = JSON.stringify({
  sessionsAfterEnd: 0,
  shutdownConfirmed,
  endpointRetired,
  ownerRetired,
  identityCount: identities.length,
  terminatedIdentityCount,
  processGroupCount: processGroups.length,
  retiredProcessGroupCount,
});
if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new Error("daemon cleanup output exceeded its bound");
process.stdout.write(output);

function parseExpected(value) {
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("invalid daemon identity input"); }
  const keys = Object.keys(parsed ?? {}).sort();
  if (
    JSON.stringify(keys) !== JSON.stringify([
      "appVersion", "protocolName", "protocolVersion", "runtimeBuildId", "schemaId", "schemaRevision",
    ]) ||
    typeof parsed.appVersion !== "string" || typeof parsed.protocolName !== "string" ||
    !Number.isSafeInteger(parsed.protocolVersion) || !Number.isSafeInteger(parsed.schemaRevision) ||
    typeof parsed.schemaId !== "string" || typeof parsed.runtimeBuildId !== "string"
  ) throw new Error("invalid daemon identity input");
  return parsed;
}

function validateHello(hello, identity) {
  if (
    hello?.socketPath !== socketPath || hello.supervisorSocketPath !== socketPath ||
    hello.protocol?.name !== identity.protocolName || hello.protocol.version !== identity.protocolVersion ||
    hello.schemaId !== identity.schemaId || hello.schemaRevision !== identity.schemaRevision ||
    hello.appVersion !== identity.appVersion || hello.runtime?.buildId !== identity.runtimeBuildId ||
    typeof hello.supervisorGeneration !== "string" || hello.supervisorGeneration.length < 1 ||
    typeof hello.supervisorOwnerToken !== "string" || hello.supervisorOwnerToken.length < 1 ||
    !Number.isSafeInteger(hello.supervisorPid) || hello.supervisorPid < 1 ||
    typeof hello.supervisorProcessStartId !== "string" || hello.supervisorProcessStartId.length < 1 ||
    getProcessStartId(hello.supervisorPid) !== hello.supervisorProcessStartId
  ) throw new Error("resident daemon hello changed exact identity");
}

async function readMatchingOwners() {
  const entries = await readDirectory(registryDirectory);
  if (entries.length > MAX_IDENTITIES) throw new Error("daemon owner registry exceeded its audit bound");
  const owners = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".owner")) continue;
    const owner = await readOptionalJson(join(registryDirectory, entry.name, "owner.json"));
    const scope = await readOptionalJson(join(registryDirectory, entry.name, "scope.json"));
    const ownerMatches = samePath(owner?.socketPath, socketPath);
    const scopeMatches = samePath(scope?.socketPath, socketPath);
    if (!ownerMatches && !scopeMatches) continue;
    if (!ownerMatches || !scopeMatches) throw new Error("resident daemon owner scope is incomplete");
    owners.push({ directory: join(registryDirectory, entry.name), owner, scope });
  }
  if (owners.length > 1) throw new Error("multiple resident daemon owners matched one endpoint");
  return owners;
}

function validateOwner(record, hello) {
  const owner = record.owner;
  const scope = record.scope;
  if (
    owner?.version !== 1 || owner.role !== "supervisor" ||
    !["starting", "owner", "stopping"].includes(owner.phase) ||
    owner.socketPath !== socketPath || owner.pid !== hello.supervisorPid ||
    owner.processStartId !== hello.supervisorProcessStartId ||
    owner.generation !== hello.supervisorGeneration || owner.token !== hello.supervisorOwnerToken ||
    resolve(owner.agentDir) !== resolve(agentDirectory) ||
    resolve(owner.descriptorDir) !== resolve(expectedDescriptorDirectory) ||
    scope?.version !== 1 || scope.role !== "supervisor" || scope.socketPath !== socketPath ||
    scope.generation !== owner.generation || scope.token !== owner.token ||
    resolve(scope.descriptorDir) !== resolve(expectedDescriptorDirectory)
  ) throw new Error("resident daemon owner changed exact identity");
}

function captureProcessTree(supervisorPid) {
  const rows = readProcessRows();
  const descendants = new Set([supervisorPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  if (descendants.size < 1 || descendants.size > MAX_IDENTITIES) throw new Error("daemon process tree exceeded its bound");
  const identities = [];
  const groups = new Set();
  for (const pid of descendants) {
    const row = rows.find((candidate) => candidate.pid === pid);
    const processStartId = getProcessStartId(pid);
    if (!row || typeof processStartId !== "string" || processStartId.length < 1 || row.pgid < 1) {
      throw new Error("daemon process tree changed during capture");
    }
    identities.push({ pid, processStartId });
    groups.add(row.pgid);
  }
  return { identities, processGroups: [...groups].sort((left, right) => left - right) };
}

function captureProcessTreeIfCurrent(pid, processStartId) {
  if (getProcessStartId(pid) !== processStartId) return { identities: [], processGroups: [] };
  return captureProcessTree(pid);
}

function readProcessRows() {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid="], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 5_000,
  });
  const rows = output.trim().split("\n").filter(Boolean).map((line) => {
    const fields = line.trim().split(/\s+/u).map(Number);
    if (fields.length !== 3 || fields.some((field) => !Number.isSafeInteger(field) || field < 0)) {
      throw new Error("process table returned an invalid row");
    }
    return { pid: fields[0], ppid: fields[1], pgid: fields[2] };
  });
  if (rows.length < 1 || rows.length > MAX_PROCESS_ROWS) throw new Error("process table exceeded its bound");
  return rows;
}

function mergeIdentities(left, right) {
  const merged = new Map();
  for (const identity of [...left, ...right]) merged.set(`${identity.pid}:${identity.processStartId}`, identity);
  if (merged.size > MAX_IDENTITIES) throw new Error("daemon process identity union exceeded its bound");
  return [...merged.values()];
}

function mergeGroups(left, right) {
  const groups = [...new Set([...left, ...right])];
  if (groups.length > MAX_IDENTITIES) throw new Error("daemon process-group union exceeded its bound");
  return groups;
}

function exactIdentityRetired(identity) {
  const observed = getProcessStartId(identity.pid);
  if (observed !== undefined) return observed !== identity.processStartId;
  try { process.kill(identity.pid, 0); return false; }
  catch (error) { return error?.code === "ESRCH"; }
}

function processGroupRetired(processGroup) {
  try { process.kill(-processGroup, 0); return false; }
  catch (error) { return error?.code === "ESRCH"; }
}

async function endpointAcceptsConnection() {
  return await new Promise((resolvePromise) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(accepted);
    };
    const timer = setTimeout(() => finish(true), 500);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function readDirectory(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}

async function readOptionalJson(path) {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_AUDIT_FILE_BYTES) {
      throw new Error("daemon audit file exceeded its bound");
    }
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function pathAbsent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (error?.code === "ENOENT") return true; throw error; }
}

function samePath(left, right) {
  return typeof left === "string" && resolve(left) === resolve(right);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
