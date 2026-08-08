import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  extractEmbeddedRuntimeAttestation,
  parseRuntimeAttestation,
} from "./runtime-attestation-lib.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOSTD_PATH = resolve(REPO_ROOT, "out", "hostd", "hostd.cjs");
const RUNTIME_SEED_ROOT = resolve(
  process.env.PRIME_CONTINUIM_RUNTIME_SEED_ROOT ?? resolve(REPO_ROOT, "out", "runtime"),
);
const ATTESTATION_PATH = resolve(REPO_ROOT, "out", "main", "runtime-attestation.json");
const HOST_REQUEST_DEADLINE_MS = 3_000;
const RUNTIME_READY_DEADLINE_MS = 180_000;
const RESIDENT_READY_DEADLINE_MS = 180_000;
const HELPER_DEADLINE_MS = 60_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const THREAD_ID = "demo-thread";
const EXECUTION_GENERATION_ID = "demo-execution-1";
const RESIDENT_COMMAND_CAPABILITY = "prime_agent_commands_v2";
const EXPECTED_BASE_CAPABILITIES = Object.freeze([
  "runtime_integrity_v1",
  "runtime_model_catalog_v1",
  "snapshot_chunks_v1",
].sort());

const require = createRequire(import.meta.url);
const electronExecutable = resolve(require("electron"));
const temporaryRoot = await mkdtemp(join(tmpdir(), "prime-continuim-resident-attach-smoke-"));
const hostdWrapperPath = join(temporaryRoot, "hostd-smoke-wrapper.cjs");
const residentFixturePath = join(temporaryRoot, "resident-fixture.cjs");
const daemonShutdownPath = join(temporaryRoot, "daemon-shutdown.mjs");
const requestedDataDirectory = join(temporaryRoot, "host-data");
const requestedWorkspaceDirectory = join(temporaryRoot, "workspace");
const agentDirectory = join(temporaryRoot, "prime-agent-home");

await Promise.all([
  mkdir(requestedDataDirectory, { recursive: true, mode: 0o700 }),
  mkdir(requestedWorkspaceDirectory, { recursive: true, mode: 0o700 }),
  mkdir(agentDirectory, { recursive: true, mode: 0o700 }),
]);
const dataDirectory = await realpath(requestedDataDirectory);
const workspaceDirectory = await realpath(requestedWorkspaceDirectory);
const hostEndpoint = localHostEndpoint(dataDirectory);
const residentEndpoint = residentDaemonEndpoint(dataDirectory);
const residentDaemonDirectory = join(dataDirectory, "resident-daemon");
await mkdir(residentDaemonDirectory, { recursive: true, mode: 0o700 });

await Promise.all([
  writeFile(hostdWrapperPath, hostdSmokeWrapperSource(), { encoding: "utf8", mode: 0o600, flag: "wx" }),
  writeFile(residentFixturePath, residentFixtureSource(), { encoding: "utf8", mode: 0o600, flag: "wx" }),
  writeFile(daemonShutdownPath, daemonShutdownSource(), { encoding: "utf8", mode: 0o600, flag: "wx" }),
]);

const attestationBytes = await readFile(ATTESTATION_PATH);
const attestation = parseRuntimeAttestation(attestationBytes);
const embeddedBytes = extractEmbeddedRuntimeAttestation(await readFile(HOSTD_PATH));
if (!embeddedBytes.equals(attestationBytes)) {
  throw new Error("Release hostd does not embed the exact generated runtime attestation bytes");
}
if (attestation.runtime.platform !== process.platform || attestation.runtime.arch !== process.arch) {
  throw new Error("Runtime attestation does not target this smoke platform and architecture");
}
await assertExactSeedRoot(RUNTIME_SEED_ROOT);
await stat(electronExecutable);

const credentialFree = credentialFreeRunAsNodeEnvironment(process.env, agentDirectory);
let hostdChild;
let runtimeRoot;
let binding;
let daemonStarted = false;
let credentialFileState = "absent";

try {
  await seedHostData(credentialFree.environment);

  hostdChild = await startReleaseHostd(credentialFree.environment);
  const installed = await waitForRuntimeReady(hostdChild, false);
  await stopHostd(hostdChild);
  hostdChild = undefined;

  runtimeRoot = await resolveInstalledRuntimeRoot(installed.health.runtimeIntegrity);
  daemonStarted = true;
  const fixture = await createResidentFixture(runtimeRoot, credentialFree.environment);
  binding = fixture.binding;
  assertResidentBinding(binding, fixture.compatibility);
  assertResidentFixtureIsolation(fixture.workerIsolation);
  credentialFileState = await assertCredentialStoreEmpty();

  hostdChild = await startReleaseHostd(credentialFree.environment);
  const attached = await waitForRuntimeReady(hostdChild, true);
  const snapshotResponse = await requestHost(
    hostEndpoint,
    "thread.snapshot",
    { threadId: THREAD_ID },
    HOST_REQUEST_DEADLINE_MS,
  );
  const projection = assertAttachedProjection(snapshotResponse.result, binding);
  await stopHostd(hostdChild);
  hostdChild = undefined;

  const shutdown = await shutdownResidentDaemon(runtimeRoot, binding.activeSessionId, credentialFree.environment);
  daemonStarted = false;
  credentialFileState = await assertCredentialStoreEmpty();

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    assurance: attestation.assurance,
    runtime: {
      releaseVersion: attestation.runtime.releaseVersion,
      runtimeBuildId: attestation.runtime.runtimeBuildId,
      treeSha256: attestation.tree.sha256,
      manifestSha256: attestation.manifest.sha256,
    },
    credentialIsolation: {
      isolatedAgentDirectory: true,
      credentialFileState,
      credentialMaterialPresent: false,
      strippedCredentialVariableCount: credentialFree.strippedCredentialVariableCount,
      promptSent: false,
    },
    binding: {
      threadId: binding.threadId,
      executionGenerationId: binding.executionGenerationId,
      activeSessionId: binding.activeSessionId,
      sessionId: binding.sessionId,
      lifecycle: binding.lifecycle,
    },
    attach: {
      capability: RESIDENT_COMMAND_CAPABILITY,
      readyMs: attached.readyMs,
      healthSamples: attached.samples,
      authoritativeProjection: true,
      projectionCursor: projection.latestCursor,
      parentProcessIsolation: fixture.workerIsolation,
    },
    restartContinuity: {
      residentStillListedAfterHostDetach: shutdown.residentStillListed,
      daemonShutdownConfirmed: shutdown.shutdownConfirmed,
    },
  }, null, 2)}\n`);
} finally {
  if (hostdChild) await stopHostd(hostdChild).catch(() => hostdChild?.kill());
  if (daemonStarted && runtimeRoot) {
    await shutdownResidentDaemon(runtimeRoot, binding?.activeSessionId, credentialFree.environment).catch(() => undefined);
  }
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  }).catch(() => undefined);
}

async function seedHostData(environment) {
  const result = await runProcess(
    electronExecutable,
    [HOSTD_PATH, "seed", "--data-dir", dataDirectory],
    { cwd: REPO_ROOT, environment, timeoutMs: HELPER_DEADLINE_MS },
  );
  let seeded;
  try {
    seeded = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("Release hostd seed returned invalid JSON", { cause: error });
  }
  if (seeded?.version !== 1 || seeded.seeded !== true || seeded.thread?.threadId !== THREAD_ID) {
    throw new Error("Release hostd did not create the exact resident smoke thread fixture");
  }
}

async function startReleaseHostd(environment) {
  const child = spawn(
    electronExecutable,
    [
      hostdWrapperPath,
      HOSTD_PATH,
      "serve",
      "--socket",
      hostEndpoint,
      "--data-dir",
      dataDirectory,
      "--runtime-seed",
      RUNTIME_SEED_ROOT,
    ],
    {
      cwd: REPO_ROOT,
      detached: false,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
      env: environment,
    },
  );
  child.stderrTail = Buffer.alloc(0);
  child.stderr?.on("data", (chunk) => {
    child.stderrTail = Buffer.concat([child.stderrTail, Buffer.from(chunk)]).subarray(-64 * 1024);
  });
  await onceSpawned(child);
  return child;
}

async function waitForRuntimeReady(child, requireResident) {
  const startedAt = Date.now();
  const deadline = startedAt + (requireResident ? RESIDENT_READY_DEADLINE_MS : RUNTIME_READY_DEADLINE_MS);
  let samples = 0;
  let lastHealth;
  let lastError;
  while (Date.now() < deadline) {
    assertChildAlive(child);
    try {
      const response = await requestHost(hostEndpoint, "health.get", {}, HOST_REQUEST_DEADLINE_MS);
      samples += 1;
      lastHealth = response.result;
      const runtime = lastHealth?.runtimeIntegrity;
      if (runtime?.status === "failed" || runtime?.status === "unavailable") {
        throw new Error(`Runtime initialization failed with ${runtime.code ?? runtime.status}`);
      }
      if (runtime?.status === "ready") {
        assertReadyRuntimeHealth(lastHealth);
        const residentReady = lastHealth.capabilities.includes(RESIDENT_COMMAND_CAPABILITY);
        if (residentReady === requireResident) {
          return {
            health: lastHealth,
            readyMs: Date.now() - startedAt,
            samples,
          };
        }
      }
    } catch (error) {
      lastError = error;
      if (/Runtime initialization failed/.test(errorMessage(error))) throw error;
    }
    await delay(100);
  }
  const capabilityState = lastHealth?.capabilities?.includes(RESIDENT_COMMAND_CAPABILITY)
    ? "present"
    : "absent";
  throw new Error(
    `Release hostd did not reach the expected resident readiness; capability ${capabilityState}; ${errorMessage(lastError)}; ${child.stderrTail.toString("utf8")}`,
  );
}

function assertReadyRuntimeHealth(health) {
  if (!health || health.protocolVersion !== 1 || health.serviceState !== "ready") {
    throw new Error("Release hostd returned an invalid ready health identity");
  }
  const runtime = health.runtimeIntegrity;
  if (!runtime || runtime.contractVersion !== 1 || runtime.status !== "ready") {
    throw new Error("Release hostd runtime integrity is not ready");
  }
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
    throw new Error("Ready runtime target differs from the embedded attestation");
  }
  const expectedTrustAnchor = createHash("sha256").update(attestationBytes).digest("hex");
  if (runtime.trustAnchorId !== expectedTrustAnchor || runtime.assurance !== attestation.assurance) {
    throw new Error("Ready runtime trust identity differs from the embedded attestation");
  }
  if (!Array.isArray(health.capabilities)) throw new Error("Ready health capabilities are invalid");
  const base = health.capabilities.filter((capability) => capability !== RESIDENT_COMMAND_CAPABILITY).sort();
  if (JSON.stringify(base) !== JSON.stringify(EXPECTED_BASE_CAPABILITIES)) {
    throw new Error(`Ready health capabilities changed: ${health.capabilities.join(", ")}`);
  }
}

async function resolveInstalledRuntimeRoot(runtimeIntegrity) {
  const pointerPath = join(dataDirectory, "runtime", "current.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  const expectedPointer = {
    schemaVersion: 1,
    assurance: attestation.assurance,
    runtime: "prime-agent",
    releaseVersion: attestation.runtime.releaseVersion,
    runtimeBuildId: attestation.runtime.runtimeBuildId,
    platform: attestation.runtime.platform,
    arch: attestation.runtime.arch,
    manifestSha256: attestation.manifest.sha256,
    treeSha256: attestation.tree.sha256,
    filesSha256: attestation.tree.filesSha256,
  };
  if (JSON.stringify(pointer) !== JSON.stringify(expectedPointer)) {
    throw new Error("Installed runtime pointer differs from the attested ready identity");
  }
  if (JSON.stringify(pointer) !== JSON.stringify(runtimeIntegrity.target && {
    schemaVersion: 1,
    assurance: runtimeIntegrity.assurance,
    ...runtimeIntegrity.target,
  })) {
    throw new Error("Installed runtime pointer differs from ready health");
  }

  const manifestLocation = join(dataDirectory, "runtime", ...attestation.manifest.relativePath.split("/"));
  assertPathWithin(join(dataDirectory, "runtime"), manifestLocation);
  const manifestBytes = await readFile(manifestLocation);
  if (createHash("sha256").update(manifestBytes).digest("hex") !== attestation.manifest.sha256) {
    throw new Error("Installed runtime manifest differs from the embedded attestation");
  }
  const root = dirname(manifestLocation);
  for (const entrypoint of [attestation.entrypoints.module, attestation.entrypoints.cli]) {
    const location = join(root, ...entrypoint.split("/"));
    assertPathWithin(root, location);
    const entry = await stat(location);
    if (!entry.isFile()) throw new Error("Installed runtime entrypoint is not a regular file");
  }
  return root;
}

async function createResidentFixture(installedRuntimeRoot, environment) {
  const result = await runProcess(
    electronExecutable,
    [
      residentFixturePath,
      HOSTD_PATH,
      dataDirectory,
      workspaceDirectory,
      installedRuntimeRoot,
      residentEndpoint,
      THREAD_ID,
      EXECUTION_GENERATION_ID,
    ],
    { cwd: REPO_ROOT, environment, timeoutMs: HELPER_DEADLINE_MS },
  );
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Resident fixture helper returned invalid JSON: ${result.stdout.slice(0, 2_048)}`, { cause: error });
  }
}

function assertResidentBinding(candidate, compatibility) {
  if (
    !candidate ||
    candidate.bindingVersion !== 1 ||
    candidate.lifecycle !== "resident" ||
    candidate.threadId !== THREAD_ID ||
    candidate.executionGenerationId !== EXECUTION_GENERATION_ID ||
    !samePath(candidate.workspaceDirectory, workspaceDirectory) ||
    typeof candidate.activeSessionId !== "string" ||
    candidate.activeSessionId.length < 1 ||
    typeof candidate.sessionId !== "string" ||
    candidate.sessionId.length < 1
  ) {
    throw new Error("Release adapter did not produce the expected durable resident binding");
  }
  const expectedCompatibility = {
    releaseVersion: attestation.runtime.releaseVersion,
    appVersion: attestation.runtime.releaseVersion,
    protocolName: attestation.daemon.protocolName,
    protocolVersion: attestation.daemon.protocolVersion,
    schemaRevision: attestation.daemon.schemaRevision,
    schemaId: attestation.daemon.schemaId,
    runtimeBuildId: attestation.runtime.runtimeBuildId,
  };
  for (const [key, expected] of Object.entries(expectedCompatibility)) {
    if (candidate.runtime?.[key] !== expected || compatibility?.[key] !== expected) {
      throw new Error(`Resident binding runtime compatibility changed: ${key}`);
    }
  }
  for (const capability of attestation.daemon.requiredCapabilities) {
    if (!candidate.runtime.capabilities.includes(capability)) {
      throw new Error(`Resident binding omitted required capability: ${capability}`);
    }
  }
}

function assertResidentFixtureIsolation(candidate) {
  if (
    !candidate ||
    candidate.sigintHandlerCountChanged !== false ||
    candidate.sigtermHandlerCountChanged !== false ||
    candidate.processEmitChanged !== false ||
    candidate.processReallyExitChanged !== false ||
    candidate.checkedAfterAttach !== true ||
    candidate.checkedAfterLoaderClose !== true
  ) {
    throw new Error("Resident Worker did not preserve the helper parent process surface");
  }
}

function assertAttachedProjection(snapshot, expectedBinding) {
  if (
    !snapshot ||
    snapshot.thread?.threadId !== expectedBinding.threadId ||
    snapshot.thread?.currentLocation?.executionGenerationId !== expectedBinding.executionGenerationId ||
    snapshot.runtime?.runtime !== "prime_agent" ||
    snapshot.runtime?.residency !== "resident" ||
    snapshot.runtime?.activeSessionId !== expectedBinding.activeSessionId ||
    snapshot.runtime?.sessionId !== expectedBinding.sessionId ||
    snapshot.latestCursor?.threadId !== expectedBinding.threadId ||
    snapshot.latestCursor?.executionGenerationId !== expectedBinding.executionGenerationId
  ) {
    throw new Error("Release hostd did not publish the authoritative attached resident projection");
  }
  return snapshot;
}

async function shutdownResidentDaemon(installedRuntimeRoot, activeSessionId, environment) {
  const daemonClientPath = join(
    installedRuntimeRoot,
    "node_modules",
    "prime-agent",
    "dist",
    "modes",
    "daemon",
    "daemon-client.js",
  );
  assertPathWithin(installedRuntimeRoot, daemonClientPath);
  const result = await runProcess(
    electronExecutable,
    [daemonShutdownPath, pathToFileURL(daemonClientPath).href, residentEndpoint, activeSessionId ?? ""],
    { cwd: REPO_ROOT, environment, timeoutMs: HELPER_DEADLINE_MS },
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("Resident daemon shutdown helper returned invalid JSON", { cause: error });
  }
  if (parsed?.shutdownConfirmed !== true) throw new Error("Resident daemon did not confirm shutdown");
  if (activeSessionId && parsed.residentStillListed !== true) {
    throw new Error("Resident session did not survive release host attachment and detach");
  }
  return parsed;
}

async function assertCredentialStoreEmpty() {
  const credentialPath = join(agentDirectory, "auth.json");
  let bytes;
  let state = "empty";
  try {
    bytes = await readFile(credentialPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") state = "absent";
    else throw error;
  }
  if (bytes) {
    if (bytes.byteLength > 64 * 1024) throw new Error("Credential-free auth.json exceeds its inspection bound");
    let auth;
    try {
      auth = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error("Credential-free auth.json is not valid JSON", { cause: error });
    }
    if (!auth || typeof auth !== "object" || Array.isArray(auth) || Object.keys(auth).length !== 0) {
      throw new Error("Credential-free resident smoke found credential material in auth.json");
    }
  }
  try {
    await readFile(join(agentDirectory, "oauth.json"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return state;
    throw error;
  }
  throw new Error("Credential-free resident smoke found legacy oauth.json material");
}

async function requestHost(socketPath, method, requestPayload, timeoutMs) {
  const requestId = `resident-attach-smoke-${randomUUID()}`;
  const payload = Buffer.from(JSON.stringify({
    protocolVersion: 1,
    requestId,
    method,
    payload: requestPayload,
  }), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);

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
      if (buffer.byteLength > MAX_FRAME_BYTES + 4) {
        finish(new Error(`${method} response exceeded its frame bound`));
        return;
      }
      if (buffer.byteLength < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length < 1 || length > MAX_FRAME_BYTES) {
        finish(new Error(`${method} frame length is invalid`));
        return;
      }
      if (buffer.byteLength < 4 + length) return;
      let response;
      try {
        response = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      } catch (error) {
        finish(new Error(`${method} response is not valid JSON`, { cause: error }));
        return;
      }
      if (!response?.ok || response.requestId !== requestId || response.method !== method) {
        const detail = response?.error?.message ? `: ${response.error.message}` : "";
        finish(new Error(`${method} response identity is invalid${detail}`));
        return;
      }
      finish(undefined, response);
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error(`hostd closed before returning ${method}`));
    });
  });
}

async function stopHostd(processHandle) {
  if (!processHandle) return;
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    throw new Error(`Release hostd exited before graceful shutdown (${processHandle.exitCode ?? processHandle.signalCode})`);
  }
  if (!processHandle.stdin || processHandle.stdin.destroyed || !processHandle.stdin.writable) {
    throw new Error("Release hostd has no writable graceful-shutdown control pipe");
  }
  processHandle.stdin.once("error", () => undefined);
  processHandle.stdin.end("shutdown\n");
  const outcome = await waitForProcessExit(processHandle, 10_000).catch(async (error) => {
    if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill();
    await waitForProcessExit(processHandle, 10_000).catch(() => undefined);
    throw error;
  });
  if (outcome.code !== 0 || outcome.signal !== null) {
    throw new Error(`Release hostd did not shut down cleanly (${outcome.code ?? outcome.signal ?? "unknown"})`);
  }
}

function runProcess(executable, argv, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, argv, {
      cwd: options.cwd,
      detached: false,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.environment,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Helper timed out: ${argv[0] ?? executable}`));
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]).subarray(-8 * 1024 * 1024);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(-64 * 1024);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal !== null) {
        finish(new Error(`Helper failed (${code ?? signal ?? "unknown"}): ${stderr.toString("utf8")}`));
        return;
      }
      finish(undefined, { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    });
  });
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
      rejectPromise(new Error("Release hostd did not complete graceful shutdown within its deadline"));
    }, timeoutMs);
    processHandle.once("exit", onExit);
    processHandle.once("error", onError);
  });
}

function onceSpawned(processHandle) {
  return new Promise((resolvePromise, rejectPromise) => {
    processHandle.once("spawn", resolvePromise);
    processHandle.once("error", rejectPromise);
  });
}

function assertChildAlive(processHandle) {
  if (processHandle.exitCode === null && processHandle.signalCode === null) return;
  throw new Error(`Release hostd exited before readiness: ${processHandle.stderrTail.toString("utf8")}`);
}

function credentialFreeRunAsNodeEnvironment(source, isolatedAgentDirectory) {
  const environment = {};
  let strippedCredentialVariableCount = 0;
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalized = name.toUpperCase();
    if (
      normalized === "NODE_OPTIONS" ||
      normalized === "NODE_PATH" ||
      normalized === "ELECTRON_RUN_AS_NODE" ||
      normalized === "PRIME_CONTINUIM_ENABLE_PLAINTEXT_OAUTH_DEV" ||
      normalized.startsWith("PRIME_AGENT_INTERNAL_") ||
      normalized === "PRIME_AGENT_BUILD_ID" ||
      normalized === "PRIME_AGENT_LAUNCHER_PATH"
    ) {
      continue;
    }
    if (isCredentialVariable(normalized)) {
      strippedCredentialVariableCount += 1;
      continue;
    }
    environment[name] = value;
  }
  environment.ELECTRON_RUN_AS_NODE = "1";
  environment.PRIME_AGENT_CODING_AGENT_DIR = isolatedAgentDirectory;
  environment.PRIME_CONTINUIM_PACKAGE_SMOKE = "1";
  return Object.freeze({
    environment: Object.freeze(environment),
    strippedCredentialVariableCount,
  });
}

function isCredentialVariable(name) {
  return /(?:^|_)(?:API_?KEY|ACCESS_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTHORIZATION)(?:_|$)/.test(name) ||
    /^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE_GENERATIVE_AI|PRIME|AZURE_OPENAI|AWS|MISTRAL|GROQ|CEREBRAS|COHERE|TOGETHER|DEEPSEEK|OPENROUTER|PERPLEXITY|XAI)(?:_|$)/.test(name);
}

function localHostEndpoint(directory) {
  if (process.platform === "win32") {
    const digest = createHash("sha256").update(resolve(directory).toLowerCase()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\prime-agent-hostd-${digest}`;
  }
  return join(directory, "hostd.sock");
}

function residentDaemonEndpoint(directory) {
  const root = resolve(directory);
  const identity = createHash("sha256")
    .update(process.platform === "win32" ? root.toLowerCase() : root)
    .digest("hex")
    .slice(0, 16);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\prime-continuim-resident-${identity}`
    : join(resolve(tmpdir()), `pc-${identity}`, "d.sock");
}

async function assertExactSeedRoot(root) {
  const { readdir } = await import("node:fs/promises");
  const entries = (await readdir(root)).sort();
  if (JSON.stringify(entries) !== JSON.stringify(["current.json", "installs"])) {
    throw new Error(`Development runtime seed is not an exact packaging view: ${entries.join(", ")}`);
  }
}

function assertPathWithin(parent, child) {
  const childRelative = relative(resolve(parent), resolve(child));
  if (
    childRelative === "" ||
    childRelative === ".." ||
    childRelative.startsWith(`..${sep}`) ||
    resolve(childRelative) === resolve(child)
  ) {
    throw new Error("Runtime path escaped its expected root");
  }
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function hostdSmokeWrapperSource() {
  return [
    '"use strict";',
    "const [hostdPath, ...hostdArguments] = process.argv.slice(2);",
    'if (!hostdPath) throw new Error("missing hostd smoke path");',
    "const hostd = require(hostdPath);",
    'process.stdin.setEncoding("utf8");',
    'process.stdin.once("data", () => process.emit("SIGTERM"));',
    "process.stdin.resume();",
    "void Promise.resolve(hostd.runHostdCli(hostdArguments)).then(",
    "  (code) => { process.exitCode = code; process.stdin.destroy(); },",
    "  (error) => {",
    "    const errors = error instanceof AggregateError ? [error, ...error.errors] : [error];",
    '    const details = errors.map((value) => value instanceof Error ? `${value.name}: ${value.message}` : String(value)).join(" <- ").slice(0, 8192);',
    '    process.stderr.write(`Hostd resident smoke wrapper failed: ${details}\\n`); process.exitCode = 1; process.stdin.destroy();',
    "  },",
    ");",
    "",
  ].join("\n");
}

function residentFixtureSource() {
  return [
    '"use strict";',
    'const { join } = require("node:path");',
    'const { pathToFileURL } = require("node:url");',
    "const [hostdPath, dataDirectory, workspaceDirectory, runtimeRoot, socketPath, threadId, executionGenerationId] = process.argv.slice(2);",
    'if ([hostdPath, dataDirectory, workspaceDirectory, runtimeRoot, socketPath, threadId, executionGenerationId].some((value) => !value)) throw new Error("missing resident fixture argument");',
    "const hostd = require(hostdPath);",
    "let adapter;",
    "let loader;",
    "let store;",
    "void (async () => {",
    "  store = new hostd.HostStore(dataDirectory);",
    "  await store.initialize({ seed: false });",
    "  await store.registerWorkspaceAuthority({ threadId, executionGenerationId, workspaceDirectory });",
    '  const modulePath = join(runtimeRoot, "node_modules", "prime-agent", "dist", "index.js");',
    '  const cliEntrypoint = join(runtimeRoot, "node_modules", "prime-agent", "dist", "bundle", "cli.js");',
    '  const handlerEvents = ["SIGINT", "SIGTERM"];',
    "  const handlerSnapshot = new Map(handlerEvents.map((event) => [event, [...process.rawListeners(event)]]));",
    "  const processEmitBefore = process.emit;",
    "  const processReallyExitBefore = process.reallyExit;",
    "  const assertParentIsolation = (label) => {",
    "    for (const event of handlerEvents) {",
    "      const before = handlerSnapshot.get(event);",
    "      const after = process.rawListeners(event);",
    "      if (before.length !== after.length || before.some((listener, index) => listener !== after[index])) {",
    '        throw new Error(`Resident Worker changed parent ${event} handlers ${label}`);',
    "      }",
    "    }",
    '    if (process.emit !== processEmitBefore) throw new Error(`Resident Worker changed parent process.emit ${label}`);',
    '    if (process.reallyExit !== processReallyExitBefore) throw new Error(`Resident Worker changed parent process.reallyExit ${label}`);',
    "  };",
    "  loader = hostd.createVerifiedResidentModuleLoader({ moduleUrl: pathToFileURL(modulePath).href });",
    "  adapter = new hostd.PrimeAgentResidentAdapter({",
    "    socketPath,",
    "    executable: process.execPath,",
    "    cliEntrypoint,",
    '    daemonWorkingDirectory: join(dataDirectory, "resident-daemon"),',
    "    environment: process.env,",
    "    loadRuntimeModule: loader,",
    "    persistBinding: (binding) => store.persistResidentSessionBinding(binding),",
    "    completeBinding: (binding) => store.completeResidentSessionBinding(binding),",
    "    publishProjection: (binding, projection) => store.publishResidentProjectionSnapshot(binding, projection),",
    "  });",
    "  const connection = await adapter.createResident({",
    "    threadId,",
    "    executionGenerationId,",
    "    workspaceDirectory,",
    '    session: { kind: "new" },',
    '    sessionName: "Continuim resident attachment smoke",',
    "  });",
    "  const binding = connection.binding;",
    '  assertParentIsolation("after attach");',
    "  const compatibility = await adapter.ensureDaemon(hostd.buildResidentDaemonStartInvocation({",
    "    executable: process.execPath,",
    "    cliEntrypoint,",
    "    socketPath,",
    '    daemonWorkingDirectory: join(dataDirectory, "resident-daemon"),',
    "    environment: process.env,",
    "  }));",
    "  await adapter.close();",
    "  adapter = undefined;",
    "  await loader.close();",
    "  loader = undefined;",
    '  assertParentIsolation("after loader close");',
    "  const workerIsolation = {",
    "    sigintHandlerCountChanged: false,",
    "    sigtermHandlerCountChanged: false,",
    "    processEmitChanged: false,",
    "    processReallyExitChanged: false,",
    "    checkedAfterAttach: true,",
    "    checkedAfterLoaderClose: true,",
    "  };",
    "  process.stdout.write(JSON.stringify({ binding, compatibility, workerIsolation }));",
    "})().catch(async (error) => {",
    "  await adapter?.close().catch(() => undefined);",
    "  await loader?.close().catch(() => undefined);",
    "  const details = [];",
    "  let current = error;",
    "  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {",
    "    if (current instanceof Error) {",
    "      details.push(`${current.name}: ${current.message}${current.details ? ` ${JSON.stringify(current.details)}` : \"\"}`);",
    "      current = current.cause;",
    "    } else {",
    "      details.push(String(current));",
    "      break;",
    "    }",
    "  }",
    '  process.stderr.write(`${details.join(" <- ").slice(0, 8192)}\\n`);',
    "  process.exitCode = 1;",
    "});",
    "",
  ].join("\n");
}

function daemonShutdownSource() {
  return [
    "const [moduleUrl, socketPath, expectedActiveSessionId] = process.argv.slice(2);",
    'if (!moduleUrl || !socketPath) throw new Error("missing daemon shutdown argument");',
    "const { DaemonClient } = await import(moduleUrl);",
    "const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));",
    "let client;",
    "try {",
    "  const deadline = Date.now() + 10_000;",
    "  let lastError;",
    "  while (Date.now() < deadline) {",
    "    const candidate = new DaemonClient(socketPath);",
    "    try {",
    "      await candidate.connect(500);",
    "      client = candidate;",
    "      break;",
    "    } catch (error) {",
    "      lastError = error;",
    "      candidate.close();",
    "      await delay(50);",
    "    }",
    "  }",
    '  if (!client) throw new Error(`resident daemon did not accept shutdown connection: ${lastError instanceof Error ? lastError.message : String(lastError)}`);',
    '  const listed = await client.request({ type: "list", includeClientOwned: true }, 5_000);',
    '  if (listed?.type !== "response" || listed.command !== "list" || listed.success !== true || !Array.isArray(listed.data?.sessions)) throw new Error("resident daemon list response is invalid");',
    "  const residentStillListed = expectedActiveSessionId.length > 0 && listed.data.sessions.some((session) => session.activeSessionId === expectedActiveSessionId);",
    '  const shutdown = await client.request({ type: "shutdown", force: true }, 5_000);',
    '  const shutdownConfirmed = shutdown?.type === "response" && shutdown.command === "shutdown" && shutdown.success === true;',
    '  if (!shutdownConfirmed) throw new Error("resident daemon did not confirm shutdown");',
    "  process.stdout.write(JSON.stringify({ residentStillListed, shutdownConfirmed }));",
    "} finally {",
    "  client?.close();",
    "}",
    "",
  ].join("\n");
}
