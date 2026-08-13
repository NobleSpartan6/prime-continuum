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
import { createPrimeAgentSmokeCustody } from "./prime-agent-smoke-custody-lib.mjs";
import { LOCAL_HOSTD_SMOKE_FIRST_HEALTH_DEADLINE_MS } from "../src/shared/local-host-startup-policy.mjs";
import { resolvePinnedDevelopmentNodeExecutable } from "./development-node-runtime.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOSTD_PATH = resolve(REPO_ROOT, "out", "hostd", "hostd.cjs");
const SEED_ROOT = resolve(process.env.PRIME_CONTINUIM_RUNTIME_SEED_ROOT ?? resolve(REPO_ROOT, "out", "runtime"));
const ATTESTATION_PATH = resolve(REPO_ROOT, "out", "main", "runtime-attestation.json");
const HEALTH_REQUEST_DEADLINE_MS = 3_000;
const MODEL_CATALOG_REQUEST_DEADLINE_MS = 180_000;
const READY_DEADLINE_MS = 180_000;
const OPTIONAL_CAPABILITIES_DEADLINE_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const BASE_HEALTH_CAPABILITIES = Object.freeze([
  "hostd_graceful_retire_v1",
  "resident_control_projection_v1",
  "runtime_integrity_v1",
  "runtime_oauth_attempt_v1",
  "snapshot_chunks_v1",
].sort());
const MODEL_CATALOG_CAPABILITY = "runtime_model_catalog_v1";
const RESIDENT_LIFECYCLE_CAPABILITY = "resident_lifecycle_v1";
const RUNTIME_OAUTH_CAPABILITY = "runtime_oauth_v1";
const RUNTIME_PROVIDER_SETUP_CAPABILITY = "runtime_provider_setup_handoff_v1";
const CANDIDATE_EVALUATION_CAPABILITY = "candidate_evaluation_probe_v1";
const WARMED_CAPABILITIES = Object.freeze([
  ...(process.platform === "win32" ? [CANDIDATE_EVALUATION_CAPABILITY] : []),
  ...(process.platform === "darwin" ? [RUNTIME_PROVIDER_SETUP_CAPABILITY] : []),
  MODEL_CATALOG_CAPABILITY,
  RESIDENT_LIFECYCLE_CAPABILITY,
  RUNTIME_OAUTH_CAPABILITY,
].sort());
const EXPECTED_MODEL_CATALOG = Object.freeze({
  releaseVersion: "0.7.2",
  providers: 32,
  models: 1_177,
  requiredModels: Object.freeze([
    "gpt-5.6-sol",
    "claude-opus-5",
    "gemini-3.6-flash",
    "deepseek/deepseek-v4-pro",
    "moonshotai/kimi-k3",
    "z-ai/glm-5.2",
    "qwen/qwen3.6-35b-a3b",
    "minimax/minimax-m3",
    "openai/gpt-oss-120b",
  ]),
  forbiddenModels: Object.freeze([
    "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
  ]),
});

const require = createRequire(import.meta.url);
const hostNodeExecutable = resolvePinnedDevelopmentNodeExecutable(REPO_ROOT);
const browserExecutable = resolve(require("electron"));
const temporaryRoot = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pc-host-smoke-"));
const hostdWrapperPath = join(temporaryRoot, "hostd-smoke-wrapper.cjs");
const requestedDataDirectory = join(temporaryRoot, "host-data");
await mkdir(requestedDataDirectory, { recursive: true, mode: 0o700 });
const dataDirectory = await realpath(requestedDataDirectory);
const endpoint = localEndpoint(dataDirectory);
await writeFile(hostdWrapperPath, hostdSmokeWrapperSource(), { encoding: "utf8", mode: 0o600, flag: "wx" });
const attestationBytes = await readFile(ATTESTATION_PATH);
const attestation = parseRuntimeAttestation(attestationBytes);
const hostdBytes = await readFile(HOSTD_PATH);
const embeddedBytes = extractEmbeddedRuntimeAttestation(hostdBytes);
if (!embeddedBytes.equals(attestationBytes)) {
  throw new Error("Release hostd does not embed the exact generated runtime attestation bytes");
}
if (attestation.runtime.platform !== process.platform || attestation.runtime.arch !== process.arch) {
  throw new Error("Runtime attestation does not target the current smoke platform and architecture");
}
await assertExactSeedRoot(SEED_ROOT);
await Promise.all([stat(hostNodeExecutable), stat(browserExecutable)]);
const hostdModule = require(HOSTD_PATH);
const primeAgentCustody = await createPrimeAgentSmokeCustody({
  hostDataRoot: dataDirectory,
  hostdModule,
});
await primeAgentCustody.assertInitiallyAbsent();

let child;
let primaryFailure;
let successReport;
try {
  const cleanInstall = await runHostdReadinessPass({ expectCleanInstall: true });
  const restart = await runHostdReadinessPass({ expectCleanInstall: false });
  if (identityKey(cleanInstall.identity) !== identityKey(restart.identity)) {
    throw new Error("Clean-install and restart readiness returned different runtime identities");
  }
  successReport = {
    schemaVersion: 1,
    hostNodeExecutable,
    browserExecutable,
    hostdPath: HOSTD_PATH,
    seedRoot: SEED_ROOT,
    cleanInstall,
    restart,
  };
} catch (error) {
  primaryFailure = error;
}

const cleanupFailures = [];
let cleanShutdownConfirmed = child === undefined;
if (child) {
  try {
    await stopChild(child);
    child = undefined;
    cleanShutdownConfirmed = true;
  } catch (error) {
    cleanupFailures.push(new Error("Release hostd cleanup failed", { cause: error }));
  }
}
let custodyCleanupConfirmed = false;
if (cleanShutdownConfirmed) {
  try {
    await primeAgentCustody.captureExisting();
    await primeAgentCustody.removeAfterConfirmedShutdown({ confirmedCleanShutdown: true });
    custodyCleanupConfirmed = true;
  } catch (error) {
    cleanupFailures.push(new Error("Prime Agent package-smoke custody cleanup failed", { cause: error }));
  }
} else {
  cleanupFailures.push(new Error(
    "Prime Agent package-smoke custody was retained because clean host shutdown was not confirmed",
  ));
}
if (custodyCleanupConfirmed) {
  try {
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch (error) {
    cleanupFailures.push(new Error("Runtime initialization smoke temporary-root cleanup failed", { cause: error }));
  }
}

if (primaryFailure) {
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      "Runtime initialization smoke failed and cleanup was incomplete",
    );
  }
  throw primaryFailure;
}
if (cleanupFailures.length > 0) {
  throw new AggregateError(cleanupFailures, "Runtime initialization smoke cleanup was incomplete");
}
if (!successReport) {
  throw new Error("Runtime initialization smoke completed without an assurance report");
}
process.stdout.write(`${JSON.stringify(successReport, null, 2)}\n`);

async function runHostdReadinessPass({ expectCleanInstall }) {
  const launchStartedAt = Date.now();
  let stderrTail = Buffer.alloc(0);
  child = spawn(
    hostNodeExecutable,
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
      "--browser-executable",
      browserExecutable,
    ],
    {
      cwd: REPO_ROOT,
      detached: false,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
      env: cleanHostNodeEnvironment(process.env),
    },
  );
  child.stderr?.on("data", (chunk) => {
    stderrTail = Buffer.concat([stderrTail, Buffer.from(chunk)]).subarray(-64 * 1024);
  });
  await onceSpawned(child);

  let first;
  let lastError;
  const firstDeadline = Date.now() + LOCAL_HOSTD_SMOKE_FIRST_HEALTH_DEADLINE_MS;
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
  if (firstHealthMs >= LOCAL_HOSTD_SMOKE_FIRST_HEALTH_DEADLINE_MS) {
    throw new Error("Initial runtime health exceeded the bounded core-startup deadline");
  }

  const latencies = [first.latencyMs];
  const phases = new Set();
  const phaseFirstSeenMs = Object.create(null);
  const observePhase = (phase) => {
    if (typeof phase !== "string" || phase.length === 0) return;
    phases.add(phase);
    phaseFirstSeenMs[phase] ??= Date.now() - launchStartedAt;
  };
  if (firstRuntimeStatus === "initializing") observePhase(first.health.runtimeIntegrity.phase);
  let readyHealth = firstRuntimeStatus === "ready" ? first.health : undefined;
  const readyDeadline = Date.now() + READY_DEADLINE_MS;
  while (!readyHealth && Date.now() < readyDeadline) {
    assertChildAlive(child, stderrTail);
    await delay(POLL_INTERVAL_MS);
    let response;
    try {
      response = await requestHealth(endpoint, HEALTH_REQUEST_DEADLINE_MS);
    } catch (error) {
      // Once runtime integrity turns ready, health also crosses the isolated
      // resident-Worker module preflight. Keep each poll tightly bounded while
      // that one cached preflight finishes; the outer readiness deadline still
      // limits the complete initialization attempt.
      lastError = error;
      continue;
    }
    latencies.push(response.latencyMs);
    const runtime = response.health.runtimeIntegrity;
    if (runtime?.status === "failed" || runtime?.status === "unavailable") {
      throw new Error(
        `Runtime initialization failed with ${runtime.code} after phases ${[...phases].join(", ") || "none"}; ${stderrTail.toString("utf8")}`,
      );
    }
    if (runtime?.status === "initializing") observePhase(runtime.phase);
    if (runtime?.status === "ready") {
      assertRuntimeHealth(response.health, "ready");
      readyHealth = response.health;
      break;
    }
  }
  if (!readyHealth) {
    throw new Error(
      `Runtime initialization did not reach ready within the smoke deadline after phases ${[...phases].join(", ") || "none"}; ${stderrTail.toString("utf8")}`,
    );
  }
  const readyMs = Date.now() - launchStartedAt;
  const optionalCapabilitiesDeadline = Date.now() + OPTIONAL_CAPABILITIES_DEADLINE_MS;
  while (!hasEveryCapability(readyHealth, WARMED_CAPABILITIES) && Date.now() < optionalCapabilitiesDeadline) {
    assertChildAlive(child, stderrTail);
    await delay(POLL_INTERVAL_MS);
    const response = await requestHealth(endpoint, HEALTH_REQUEST_DEADLINE_MS);
    assertRuntimeHealth(response.health, "ready");
    readyHealth = response.health;
    latencies.push(response.latencyMs);
  }
  if (!hasEveryCapability(readyHealth, WARMED_CAPABILITIES)) {
    const missing = WARMED_CAPABILITIES.filter((capability) => !readyHealth.capabilities.includes(capability));
    throw new Error(
      `Release hostd did not advertise its optional Prime Agent capabilities after bounded background initialization: ${missing.join(", ")}; ${stderrTail.toString("utf8")}`,
    );
  }
  assertRuntimeHealth(readyHealth, "ready", true);
  const optionalCapabilitiesReadyMs = Date.now() - launchStartedAt;
  const identity = readyHealth.runtimeIntegrity;
  const modelCatalog = await requestHost(
    endpoint,
    "runtime.model_catalog",
    { expectedHostId: readyHealth.host?.hostId },
    MODEL_CATALOG_REQUEST_DEADLINE_MS,
  );
  const catalogSummary = assertRuntimeModelCatalog(modelCatalog.result, readyHealth);
  await primeAgentCustody.captureExisting();
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

  try {
    await stopChild(child);
  } catch (error) {
    throw new Error(`${errorMessage(error)}; ${stderrTail.toString("utf8")}`.slice(0, 16 * 1024), { cause: error });
  }
  child = undefined;
  return {
    expectCleanInstall,
    firstRuntimeStatus,
    firstHealthMs,
    readyMs,
    optionalCapabilitiesReadyMs,
    maxHealthLatencyMs: Math.max(...latencies),
    samples: latencies.length,
    phases: [...phases],
    phaseFirstSeenMs,
    identity,
    modelCatalog: catalogSummary,
  };
}

function assertRuntimeHealth(health, expectedStatus, requireWarmedCapabilities = false) {
  if (!health || health.protocolVersion !== 1) throw new Error("Health response has an invalid protocol identity");
  const runtime = health.runtimeIntegrity;
  if (!runtime || runtime.contractVersion !== 1 || runtime.status !== expectedStatus) {
    throw new Error(`Expected runtime ${expectedStatus} health`);
  }
  if (!Array.isArray(health.capabilities) || health.capabilities.some((capability) => typeof capability !== "string")) {
    throw new Error("Runtime health capabilities are invalid");
  }
  assertTrustedLocalRetirementIdentity(health);
  const expectedCapabilities = expectedStatus === "ready"
    ? [
        ...BASE_HEALTH_CAPABILITIES,
        ...(requireWarmedCapabilities ? WARMED_CAPABILITIES : []),
      ].sort()
    : BASE_HEALTH_CAPABILITIES;
  const actualCapabilities = health.capabilities
    .filter((capability) => requireWarmedCapabilities || !WARMED_CAPABILITIES.includes(capability))
    .sort();
  if (JSON.stringify(actualCapabilities) !== JSON.stringify(expectedCapabilities)) {
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

function assertTrustedLocalRetirementIdentity(health) {
  const identity = health.hostdBuildIdentity;
  const expected = {
    contractVersion: 1,
    bundleSha256: createHash("sha256").update(hostdBytes).digest("hex"),
    runtimeTrustAnchorId: createHash("sha256").update(attestationBytes).digest("hex"),
  };
  if (
    !health.capabilities.includes("hostd_graceful_retire_v1") ||
    JSON.stringify(identity) !== JSON.stringify(expected)
  ) {
    throw new Error("Trusted-local retirement capability lacks the exact release hostd identity");
  }
}

function hasEveryCapability(health, capabilities) {
  return capabilities.every((capability) => health.capabilities.includes(capability));
}

function assertRuntimeModelCatalog(catalog, health) {
  if (!catalog || catalog.runtime !== "prime_agent") {
    throw new Error("Runtime model catalog has an invalid contract identity");
  }
  if (catalog.releaseVersion !== EXPECTED_MODEL_CATALOG.releaseVersion) {
    throw new Error(`Runtime model catalog release changed: ${catalog.releaseVersion ?? "missing"}`);
  }
  if (!Array.isArray(catalog.providers) || catalog.providers.length !== EXPECTED_MODEL_CATALOG.providers) {
    throw new Error(`Runtime model provider count changed: ${catalog.providers?.length ?? "invalid"}`);
  }
  if (!Array.isArray(catalog.models) || catalog.models.length !== EXPECTED_MODEL_CATALOG.models) {
    throw new Error(`Runtime model route count changed: ${catalog.models?.length ?? "invalid"}`);
  }
  if (!health.capabilities.includes(MODEL_CATALOG_CAPABILITY)) {
    throw new Error("Ready health omitted the verified model catalog capability");
  }
  const routeKeys = new Set(catalog.models.map((model) => model.modelId));
  const missing = EXPECTED_MODEL_CATALOG.requiredModels
    .filter((modelId) => !routeKeys.has(modelId));
  if (missing.length > 0) {
    throw new Error(`Runtime model catalog lost required frontier routes: ${missing.join(", ")}`);
  }
  const retired = EXPECTED_MODEL_CATALOG.forbiddenModels
    .filter((modelId) => routeKeys.has(modelId));
  if (retired.length > 0) {
    throw new Error(`Runtime model catalog regained retired routes: ${retired.join(", ")}`);
  }
  assertNoSecretBearingCatalogFields(catalog);
  return Object.freeze({
    releaseVersion: catalog.releaseVersion,
    observedAt: catalog.observedAt,
    providers: catalog.providers.length,
    models: catalog.models.length,
    requiredModels: EXPECTED_MODEL_CATALOG.requiredModels.length,
    forbiddenModels: EXPECTED_MODEL_CATALOG.forbiddenModels.length,
    secretBearingPropertiesPresent: false,
  });
}

function assertNoSecretBearingCatalogFields(value) {
  const forbidden = /^(api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|credential|credentials|headers?|secret|base[-_]?url)$/i;
  const pending = [value];
  const seen = new Set();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object") continue;
    if (seen.has(candidate)) throw new Error("Runtime model catalog contains a cyclic object graph");
    seen.add(candidate);
    for (const [key, child] of Object.entries(candidate)) {
      if (forbidden.test(key)) throw new Error(`Runtime model catalog exposed a secret-bearing field: ${key}`);
      if (child && typeof child === "object") pending.push(child);
    }
  }
}

async function requestHealth(socketPath, timeoutMs) {
  const response = await requestHost(socketPath, "health.get", {}, timeoutMs);
  return { health: response.result, latencyMs: response.latencyMs };
}

async function requestHost(socketPath, method, requestPayload, timeoutMs) {
  const requestId = `runtime-smoke-${randomUUID()}`;
  const payload = Buffer.from(JSON.stringify({
    protocolVersion: 1,
    requestId,
    method,
    payload: requestPayload,
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
    const timer = setTimeout(() => finish(new Error(`${method} request timed out`)), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_FRAME_BYTES + 4) return finish(new Error(`${method} response exceeded its frame bound`));
      if (buffer.byteLength < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length < 1 || length > MAX_FRAME_BYTES) return finish(new Error(`${method} frame length is invalid`));
      if (buffer.byteLength < 4 + length) return;
      let response;
      try {
        response = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      } catch (error) {
        return finish(new Error(`${method} response is not valid JSON`, { cause: error }));
      }
      if (!response?.ok || response.requestId !== requestId || response.method !== method) {
        const detail = response?.error?.message ? `: ${response.error.message}` : "";
        return finish(new Error(`${method} response identity is invalid${detail}`));
      }
      finish(undefined, { result: response.result, latencyMs: Date.now() - startedAt });
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error(`hostd closed before returning ${method}`));
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

function cleanHostNodeEnvironment(environment) {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    const normalized = name.toUpperCase();
    if (normalized === "NODE_OPTIONS" || normalized === "NODE_PATH" || normalized === "ELECTRON_RUN_AS_NODE") {
      delete result[name];
    }
  }
  result.PRIME_CONTINUIM_PACKAGE_SMOKE = "1";
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
    "  (error) => {",
    "    const errors = error instanceof AggregateError ? [error, ...error.errors] : [error];",
    "    const details = errors.map((value) => value instanceof Error ? `${value.name}: ${value.message}` : String(value)).join(\" <- \").slice(0, 8192);",
    "    process.stderr.write(`Hostd smoke wrapper failed: ${details}\\n`); process.exitCode = 1; process.stdin.destroy();",
    "  },",
    ");",
    "",
  ].join("\n");
}
