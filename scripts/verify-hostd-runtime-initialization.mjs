import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  extractEmbeddedRuntimeAttestation,
  parseRuntimeAttestation,
} from "./runtime-attestation-lib.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOSTD_PATH = resolve(REPO_ROOT, "out", "hostd", "hostd.cjs");
const SEED_ROOT = resolve(REPO_ROOT, "out", "runtime");
const ATTESTATION_PATH = resolve(REPO_ROOT, "out", "main", "runtime-attestation.json");
const FIRST_HEALTH_DEADLINE_MS = 10_000;
const HEALTH_REQUEST_DEADLINE_MS = 3_000;
const READY_DEADLINE_MS = 180_000;
const POLL_INTERVAL_MS = 250;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const EXPECTED_HEALTH_CAPABILITIES = Object.freeze([
  "runtime_integrity_v1",
  "snapshot_chunks_v1",
].sort());

const require = createRequire(import.meta.url);
const electronExecutable = resolve(require("electron"));
const temporaryRoot = await mkdtemp(join(tmpdir(), "prime-continuim-hostd-runtime-smoke-"));
const hostdWrapperPath = join(temporaryRoot, "hostd-smoke-wrapper.cjs");
const requestedDataDirectory = join(temporaryRoot, "host-data");
await mkdir(requestedDataDirectory, { recursive: true, mode: 0o700 });
const dataDirectory = await realpath(requestedDataDirectory);
const endpoint = localEndpoint(dataDirectory);
await writeFile(hostdWrapperPath, hostdSmokeWrapperSource(), { encoding: "utf8", mode: 0o600, flag: "wx" });
const attestationBytes = await readFile(ATTESTATION_PATH);
const attestation = parseRuntimeAttestation(attestationBytes);
const embeddedBytes = extractEmbeddedRuntimeAttestation(await readFile(HOSTD_PATH));
if (!embeddedBytes.equals(attestationBytes)) {
  throw new Error("Release hostd does not embed the exact generated runtime attestation bytes");
}
if (attestation.runtime.platform !== process.platform || attestation.runtime.arch !== process.arch) {
  throw new Error("Runtime attestation does not target the current smoke platform and architecture");
}
await assertExactSeedRoot(SEED_ROOT);
await stat(electronExecutable);

let child;
try {
  const cleanInstall = await runHostdReadinessPass({ expectCleanInstall: true });
  const restart = await runHostdReadinessPass({ expectCleanInstall: false });
  if (identityKey(cleanInstall.identity) !== identityKey(restart.identity)) {
    throw new Error("Clean-install and restart readiness returned different runtime identities");
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    electronExecutable,
    hostdPath: HOSTD_PATH,
    seedRoot: SEED_ROOT,
    cleanInstall,
    restart,
  }, null, 2)}\n`);
} finally {
  await stopChild(child).catch(() => undefined);
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  }).catch(() => undefined);
}

async function runHostdReadinessPass({ expectCleanInstall }) {
  const launchStartedAt = Date.now();
  let stderrTail = Buffer.alloc(0);
  child = spawn(
    electronExecutable,
    [
      hostdWrapperPath,
      HOSTD_PATH,
      "serve",
      "--socket",
      endpoint,
      "--data-dir",
      dataDirectory,
      "--runtime-seed",
      SEED_ROOT,
    ],
    {
      cwd: REPO_ROOT,
      detached: false,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
      env: cleanRunAsNodeEnvironment(process.env),
    },
  );
  child.stderr?.on("data", (chunk) => {
    stderrTail = Buffer.concat([stderrTail, Buffer.from(chunk)]).subarray(-64 * 1024);
  });
  await onceSpawned(child);

  let first;
  let lastError;
  const firstDeadline = Date.now() + FIRST_HEALTH_DEADLINE_MS;
  while (Date.now() < firstDeadline) {
    assertChildAlive(child, stderrTail);
    try {
      first = await requestHealth(endpoint, HEALTH_REQUEST_DEADLINE_MS);
      break;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  if (!first) {
    throw new Error(`Release hostd did not answer initial health: ${errorMessage(lastError)}; ${stderrTail.toString("utf8")}`);
  }
  const firstHealthMs = Date.now() - launchStartedAt;
  const firstRuntimeStatus = first.health?.runtimeIntegrity?.status;
  if (expectCleanInstall && firstRuntimeStatus !== "initializing") {
    throw new Error(`Clean-install health skipped the observable initializing state: ${firstRuntimeStatus ?? "missing"}`);
  }
  if (firstRuntimeStatus !== "initializing" && firstRuntimeStatus !== "ready") {
    throw new Error(`Initial runtime health has an invalid status: ${firstRuntimeStatus ?? "missing"}`);
  }
  assertRuntimeHealth(first.health, firstRuntimeStatus);
  if (firstHealthMs >= FIRST_HEALTH_DEADLINE_MS) {
    throw new Error("Initial runtime health exceeded the bounded core-startup deadline");
  }

  const latencies = [first.latencyMs];
  const phases = new Set();
  if (firstRuntimeStatus === "initializing") phases.add(first.health.runtimeIntegrity.phase);
  let readyHealth = firstRuntimeStatus === "ready" ? first.health : undefined;
  const readyDeadline = Date.now() + READY_DEADLINE_MS;
  while (!readyHealth && Date.now() < readyDeadline) {
    assertChildAlive(child, stderrTail);
    await delay(POLL_INTERVAL_MS);
    const response = await requestHealth(endpoint, HEALTH_REQUEST_DEADLINE_MS);
    latencies.push(response.latencyMs);
    const runtime = response.health.runtimeIntegrity;
    if (runtime?.status === "failed" || runtime?.status === "unavailable") {
      throw new Error(
        `Runtime initialization failed with ${runtime.code} after phases ${[...phases].join(", ") || "none"}`,
      );
    }
    if (runtime?.status === "initializing") phases.add(runtime.phase);
    if (runtime?.status === "ready") {
      assertRuntimeHealth(response.health, "ready");
      readyHealth = response.health;
      break;
    }
  }
  if (!readyHealth) throw new Error("Runtime initialization did not reach ready within the smoke deadline");
  const readyMs = Date.now() - launchStartedAt;
  const identity = readyHealth.runtimeIntegrity;
  const installedPointer = JSON.parse(await readFile(join(dataDirectory, "runtime", "current.json"), "utf8"));
  for (const key of [
    "releaseVersion",
    "runtimeBuildId",
    "platform",
    "arch",
    "manifestSha256",
    "treeSha256",
    "filesSha256",
  ]) {
    if (installedPointer[key] !== identity.target[key]) {
      throw new Error(`Installed pointer differs from ready health: ${key}`);
    }
  }

  await stopChild(child);
  child = undefined;
  return {
    expectCleanInstall,
    firstRuntimeStatus,
    firstHealthMs,
    readyMs,
    maxHealthLatencyMs: Math.max(...latencies),
    samples: latencies.length,
    phases: [...phases],
    identity,
  };
}

function assertRuntimeHealth(health, expectedStatus) {
  if (!health || health.protocolVersion !== 1) throw new Error("Health response has an invalid protocol identity");
  const runtime = health.runtimeIntegrity;
  if (!runtime || runtime.contractVersion !== 1 || runtime.status !== expectedStatus) {
    throw new Error(`Expected runtime ${expectedStatus} health`);
  }
  if (!Array.isArray(health.capabilities) || health.capabilities.some((capability) => typeof capability !== "string")) {
    throw new Error("Runtime health capabilities are invalid");
  }
  const actualCapabilities = [...health.capabilities].sort();
  if (JSON.stringify(actualCapabilities) !== JSON.stringify(EXPECTED_HEALTH_CAPABILITIES)) {
    throw new Error(
      `Runtime health capabilities differ from the exact release contract: ${actualCapabilities.join(", ")}`,
    );
  }
  const expectedState = expectedStatus === "ready" ? "ready" : "starting";
  if (health.serviceState !== expectedState) throw new Error("Runtime and service readiness disagree");
  const expectedTarget = {
    runtime: "prime-agent",
    releaseVersion: attestation.runtime.releaseVersion,
    runtimeBuildId: attestation.runtime.runtimeBuildId,
    platform: attestation.runtime.platform,
    arch: attestation.runtime.arch,
    manifestSha256: attestation.manifest.sha256,
    treeSha256: attestation.tree.sha256,
    filesSha256: attestation.tree.filesSha256,
  };
  if (JSON.stringify(runtime.target) !== JSON.stringify(expectedTarget)) {
    throw new Error("Runtime health target differs from the embedded attestation");
  }
  const expectedAnchor = createHash("sha256").update(attestationBytes).digest("hex");
  if (runtime.trustAnchorId !== expectedAnchor) throw new Error("Runtime health trust anchor is not byte-exact");
  if (expectedStatus === "ready" && runtime.assurance !== attestation.assurance) {
    throw new Error("Runtime health assurance differs from the embedded attestation");
  }
  const serialized = JSON.stringify(runtime);
  for (const forbidden of [SEED_ROOT, dataDirectory, temporaryRoot]) {
    if (serialized.toLowerCase().includes(forbidden.toLowerCase())) {
      throw new Error("Runtime health exposed a filesystem path");
    }
  }
}

async function requestHealth(socketPath, timeoutMs) {
  const requestId = `runtime-smoke-${randomUUID()}`;
  const payload = Buffer.from(JSON.stringify({
    protocolVersion: 1,
    requestId,
    method: "health.get",
    payload: {},
  }), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  const startedAt = Date.now();

  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(new Error("health request timed out")), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_FRAME_BYTES + 4) return finish(new Error("health response exceeded its frame bound"));
      if (buffer.byteLength < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length < 1 || length > MAX_FRAME_BYTES) return finish(new Error("health frame length is invalid"));
      if (buffer.byteLength < 4 + length) return;
      let response;
      try {
        response = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      } catch (error) {
        return finish(new Error("health response is not valid JSON", { cause: error }));
      }
      if (!response?.ok || response.requestId !== requestId || response.method !== "health.get") {
        return finish(new Error("health response identity is invalid"));
      }
      finish(undefined, { health: response.result, latencyMs: Date.now() - startedAt });
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error("hostd closed before returning health"));
    });
  });
}

function onceSpawned(processHandle) {
  return new Promise((resolvePromise, rejectPromise) => {
    processHandle.once("spawn", resolvePromise);
    processHandle.once("error", rejectPromise);
  });
}

async function stopChild(processHandle) {
  if (!processHandle) return;
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    throw new Error(`Release hostd exited before the graceful shutdown request (${processHandle.exitCode ?? processHandle.signalCode})`);
  }
  if (!processHandle.stdin || processHandle.stdin.destroyed || !processHandle.stdin.writable) {
    throw new Error("Release hostd has no writable graceful-shutdown control pipe");
  }
  processHandle.stdin.once("error", () => undefined);
  processHandle.stdin.end("shutdown\n");
  let outcome;
  try {
    outcome = await waitForProcessExit(processHandle, 10_000);
  } catch (error) {
    if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill();
    await waitForProcessExit(processHandle, 10_000).catch(() => undefined);
    throw error;
  }
  if (outcome.code !== 0 || outcome.signal !== null) {
    throw new Error(`Release hostd did not shut down cleanly (${outcome.code ?? outcome.signal ?? "unknown"})`);
  }
}

function waitForProcessExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return Promise.resolve({ code: processHandle.exitCode, signal: processHandle.signalCode });
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const finish = () => {
      clearTimeout(timer);
      processHandle.off("exit", onExit);
      processHandle.off("error", onError);
    };
    const onExit = (code, signal) => {
      finish();
      resolvePromise({ code, signal });
    };
    const onError = (error) => {
      finish();
      rejectPromise(error);
    };
    const timer = setTimeout(() => {
      finish();
      rejectPromise(new Error("Release hostd did not complete graceful shutdown within 10 seconds"));
    }, timeoutMs);
    processHandle.once("exit", onExit);
    processHandle.once("error", onError);
  });
}

function assertChildAlive(processHandle, stderrTail) {
  if (processHandle.exitCode === null && processHandle.signalCode === null) return;
  throw new Error(`Release hostd exited before readiness: ${stderrTail.toString("utf8")}`);
}

function cleanRunAsNodeEnvironment(environment) {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    const normalized = name.toUpperCase();
    if (normalized === "NODE_OPTIONS" || normalized === "NODE_PATH" || normalized === "ELECTRON_RUN_AS_NODE") {
      delete result[name];
    }
  }
  result.ELECTRON_RUN_AS_NODE = "1";
  return result;
}

function localEndpoint(directory) {
  if (process.platform === "win32") {
    const digest = createHash("sha256").update(resolve(directory).toLowerCase()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\prime-agent-hostd-${digest}`;
  }
  return join(directory, "hostd.sock");
}

async function assertExactSeedRoot(root) {
  const { readdir } = await import("node:fs/promises");
  const entries = (await readdir(root)).sort();
  if (JSON.stringify(entries) !== JSON.stringify(["current.json", "installs"])) {
    throw new Error(`Development runtime seed is not an exact packaging view: ${entries.join(", ")}`);
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function identityKey(runtimeIntegrity) {
  return JSON.stringify({
    contractVersion: runtimeIntegrity.contractVersion,
    status: runtimeIntegrity.status,
    assurance: runtimeIntegrity.assurance,
    trustAnchorId: runtimeIntegrity.trustAnchorId,
    target: runtimeIntegrity.target,
  });
}

function hostdSmokeWrapperSource() {
  return [
    '"use strict";',
    "const [hostdPath, ...hostdArguments] = process.argv.slice(2);",
    'if (!hostdPath) throw new Error("missing hostd smoke path");',
    "const hostd = require(hostdPath);",
    "process.stdin.setEncoding(\"utf8\");",
    "process.stdin.once(\"data\", () => process.emit(\"SIGTERM\"));",
    "process.stdin.resume();",
    "void Promise.resolve(hostd.runHostdCli(hostdArguments)).then(",
    "  (code) => { process.exitCode = code; process.stdin.destroy(); },",
    "  () => { process.stderr.write(\"Hostd smoke wrapper failed\\n\"); process.exitCode = 1; process.stdin.destroy(); },",
    ");",
    "",
  ].join("\n");
}
