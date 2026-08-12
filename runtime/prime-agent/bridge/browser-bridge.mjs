import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";
import {
  firstBrowserCommand,
  parseBrowserSessionName,
  rewriteBrowserCommand,
  rewriteBrowserSessionName,
} from "./browser-bridge-arguments.mjs";
import { createBrowserHostEnvironment } from "./browser-bridge-environment.mjs";
import { withBrowserSessionLock } from "./browser-bridge-session-lock.mjs";
import { browserSessionStateKeys, residentBrowserAuthority } from "./browser-bridge-state.mjs";

const PROTOCOL = "prime-continuim.browser.v1";
const BRIDGE_VERSION = 1;
const PLAYWRIGHT_VERSION = "1.63.0-alpha-2026-08-05";
const START_TIMEOUT_MS = 15_000;
const POLL_MS = 40;
const require = createRequire(import.meta.url);
const {
  commitBrowserLaunch,
  browserMetadataRecoveryDisposition,
  cleanupRetiredBrowserState,
  createStartingLaunch,
  durableRemove,
  durableWrite,
  launchRecoveryDisposition,
  metadataMatchesCommitted,
  metadataMatchesReady,
  readEvidence,
  readLaunchEvidence,
  resolveStartingLaunch,
  validBrowserMetadata,
} = require("./browser-bridge-launch-journal.cjs");
const packageRoot = resolve(require.resolve("playwright-core/package.json"), "..");
const childProcess = require("node:child_process");
const originalSpawn = childProcess.spawn;
const electronNodeShim = join(dirname(import.meta.filename), "electron-node-shim.cjs");
childProcess.spawn = (command, args, options) => {
  if (
    samePath(resolve(command), resolve(process.execPath)) &&
    Array.isArray(args) &&
    basename(args[0] ?? "") === "cliDaemon.js"
  ) return originalSpawn(command, [electronNodeShim, ...args], options);
  return originalSpawn(command, args, options);
};
const { program } = require(join(packageRoot, "lib", "tools", "cli-client", "program.js"));
const packageVersion = require(join(packageRoot, "package.json")).version;

async function main() {
  const args = process.argv.slice(2);
  const command = firstBrowserCommand(args);
  if (args.includes("--version") || args.includes("-v") || command === "version") {
    process.stdout.write(`Prime Continuim browser bridge ${BRIDGE_VERSION} (Playwright ${PLAYWRIGHT_VERSION})\n`);
    return;
  }

  const environment = await verifiedEnvironment();
  if (command === "doctor") {
    await doctor(environment, args.includes("--json"));
    return;
  }
  if (!command) {
    await runOfficial(args);
    return;
  }

  const sessionName = parseBrowserSessionName(args, process.env);
  const residentAuthority = residentBrowserAuthority(process.env);
  const state = await sessionState(environment.stateRoot, sessionName, residentAuthority);
  switch (command) {
    case "open":
      await withBrowserSessionLock(state.directory, () => openVerifiedBrowser(environment, state, args));
      return;
    case "close":
    case "detach":
      await withBrowserSessionLock(state.directory, () => closeOne(state, args, false));
      return;
    case "delete-data":
      await withBrowserSessionLock(state.directory, () => closeOne(state, args, true));
      return;
    case "close-all":
    case "kill-all":
      await closeAll(environment.stateRoot, residentAuthority, command === "kill-all");
      return;
    case "attach":
    case "install":
    case "install-browser":
      throw new BridgeError("UNSUPPORTED_BOUNDARY", "This command would leave the verified browser boundary.");
    default:
      await withBrowserSessionLock(
        state.directory,
        () => runOfficial(rewriteBrowserSessionName(args, state.officialSessionName)),
      );
  }
}

async function verifiedEnvironment() {
  if (process.env.ELECTRON_RUN_AS_NODE !== "1") {
    throw new BridgeError("HOST_IDENTITY_INVALID", "The browser bridge requires the verified Electron RunAsNode host.");
  }
  if (packageVersion !== PLAYWRIGHT_VERSION) {
    throw new BridgeError("PLAYWRIGHT_IDENTITY_INVALID", "The packaged Playwright controller identity changed.");
  }
  const executable = process.env.PRIME_CONTINUIM_BROWSER_EXECUTABLE;
  const stateRootValue = process.env.PRIME_CONTINUIM_BROWSER_STATE_DIR;
  if (!executable || !stateRootValue || !isAbsolute(executable) || !isAbsolute(stateRootValue)) {
    throw new BridgeError("SESSION_UNAVAILABLE", "Verified browser execution is unavailable for this resident session.");
  }
  const [actualExecutable, expectedExecutable] = await Promise.all([
    realpath(process.execPath),
    realpath(executable),
  ]);
  if (!samePath(actualExecutable, expectedExecutable)) {
    throw new BridgeError("HOST_IDENTITY_INVALID", "The browser host does not match the verified resident runtime.");
  }
  const stateRoot = await ensurePrivateDirectory(resolve(stateRootValue));
  process.env.PWTEST_DAEMON_SESSION_DIR = join(stateRoot, "playwright-daemons");
  return Object.freeze({ executable: expectedExecutable, stateRoot });
}

async function doctor(environment, json) {
  const childEnvironment = browserEnvironment();
  let application;
  let terminating = false;
  const retire = () => {
    if (terminating) return;
    terminating = true;
    void application?.close().catch(() => undefined).finally(() => process.exit(1));
    if (!application) process.exit(1);
  };
  process.once("SIGTERM", retire);
  process.once("SIGINT", retire);
  try {
    application = await electron.launch({
      executablePath: environment.executable,
      env: childEnvironment,
      args: [
        join(dirname(import.meta.filename), "browser-doctor-host.cjs"),
        `--prime-doctor-owner-pid=${process.pid}`,
      ],
      timeout: START_TIMEOUT_MS,
    });
    const page = await application.firstWindow({ timeout: START_TIMEOUT_MS });
    await page.goto("data:text/html,<title>Prime%20Continuim%20browser%20probe</title><main>ready</main>");
    if (await page.locator("main").textContent() !== "ready") {
      throw new Error("The browser probe did not observe its expected document.");
    }
  } finally {
    process.off("SIGTERM", retire);
    process.off("SIGINT", retire);
    await application?.close().catch(() => undefined);
  }
  const result = {
    protocol: PROTOCOL,
    bridgeVersion: BRIDGE_VERSION,
    ready: true,
    controller: `playwright-core/${PLAYWRIGHT_VERSION}`,
    engine: "verified-electron-host",
  };
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : "Verified browser execution is ready.\n");
}

async function openVerifiedBrowser(environment, state, originalArgs) {
  const options = parseOpenOptions(originalArgs);
  await stopOfficialSession(state.officialSessionName).catch(() => undefined);
  await retireBrowserState(state, true);
  // Reopening after a crash must not reuse cookies or storage from a prior
  // resident generation in this workspace.
  await mkdir(state.profileDirectory, { recursive: true, mode: 0o700 });
  await chmod(state.profileDirectory, 0o700).catch(() => undefined);

  const starting = await createStartingLaunch(state.launchPath, process.pid);

  const browserArgs = [
    join(dirname(import.meta.filename), "browser-host.cjs"),
    `--prime-launch-journal=${state.launchPath}`,
    `--prime-browser-metadata=${state.metadataPath}`,
    `--prime-launch-nonce=${starting.nonce}`,
    `--user-data-dir=${state.profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(options.headed ? [] : ["--headless"]),
    "about:blank",
  ];
  const child = spawn(environment.executable, browserArgs, {
    cwd: state.directory,
    detached: true,
    env: browserEnvironment(),
    stdio: "ignore",
    windowsHide: true,
  });
  let spawnFailure;
  const childError = new Promise((_, reject) => {
    child.once("error", (error) => {
      spawnFailure = error;
      reject(new BridgeError("BROWSER_START_FAILED", "The verified browser host could not be spawned.", { cause: error }));
    });
  });
  child.unref();

  let metadata;
  try {
    const ready = await Promise.race([
      waitForReadyLaunch(state, starting, child.pid),
      childError,
    ]);
    const endpoint = await waitForEndpoint(state, child.pid);
    metadata = {
      ...endpoint,
      controlPort: ready.controlPort,
      launchNonce: ready.nonce,
      persistent: false,
    };
    await durableWrite(state.metadataPath, metadata);
    await commitBrowserLaunch(state.launchPath, ready, metadata);
    await runOfficial([
      `--session=${state.officialSessionName}`,
      "attach",
      `--cdp=${metadata.endpoint}`,
    ], true);
    if (options.url) {
      await runOfficial([`--session=${state.officialSessionName}`, "goto", options.url]);
    } else {
      await runOfficial([`--session=${state.officialSessionName}`, "snapshot"]);
    }
  } catch (error) {
    await stopOfficialSession(state.officialSessionName).catch(() => undefined);
    try {
      await rollbackFreshLaunch(state, child, spawnFailure);
    } catch (closeError) {
      throw new BridgeError(
        "BROWSER_ROLLBACK_FAILED",
        "Browser startup failed and verified engine cleanup did not complete; recovery evidence was retained.",
        { cause: closeError },
      );
    }
    throw error;
  }
}

async function closeOne(state, args, deleteData) {
  await runOfficial(rewriteBrowserSessionName(
    rewriteBrowserCommand(args, deleteData ? "delete-data" : "close"),
    state.officialSessionName,
  )).catch(() => undefined);
  await retireBrowserState(state, true);
  process.stdout.write(deleteData ? "Browser data deleted.\n" : "Browser closed.\n");
}

async function closeAll(stateRoot, residentAuthority, forceLabel) {
  const { authorityKey } = browserSessionStateKeys("authority", "all", residentAuthority);
  const bridgeRoot = join(stateRoot, "resident-authorities", authorityKey);
  const entries = await import("node:fs/promises").then(({ readdir }) => readdir(bridgeRoot, { withFileTypes: true })).catch(() => []);
  let closed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const sessionDirectory = join(bridgeRoot, entry.name);
    await withBrowserSessionLock(sessionDirectory, async () => {
      await stopOfficialSession(`pc-${authorityKey.slice(0, 10)}-${entry.name.slice(0, 16)}`).catch(() => undefined);
      const hadEvidence = await retireBrowserState({
        directory: sessionDirectory,
        launchPath: join(sessionDirectory, "launch.json"),
        metadataPath: join(sessionDirectory, "browser.json"),
        profileDirectory: join(sessionDirectory, "profile"),
      }, true);
      if (hadEvidence) closed += 1;
    });
  }
  process.stdout.write(`${forceLabel ? "Closed" : "Closed"} ${closed} verified browser session${closed === 1 ? "" : "s"}.\n`);
}

async function closeEndpoint(metadata, launch, launchPath) {
  const current = await endpointIdentity(metadata.endpoint);
  if (current.browserId !== metadata.browserId) {
    throw new BridgeError("BROWSER_IDENTITY_CHANGED", "Browser endpoint identity changed; recovery evidence was retained.");
  }
  await requestHostRetirement(launch, launchPath);
}

function browserProcessStatus(pid) {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return error?.code === "ESRCH" ? "dead" : "unknown";
  }
}

async function retireBrowserState(state, removeProfile) {
  const [launchEvidence, metadataEvidence] = await Promise.all([
    readLaunchEvidence(state.launchPath),
    readEvidence(state.metadataPath, validBrowserMetadata),
  ]);
  if (launchEvidence.status === "malformed" || metadataEvidence.status === "malformed") {
    throw new BridgeError("BROWSER_RECOVERY_AMBIGUOUS", "Browser recovery evidence is malformed and was retained.");
  }
  if (launchEvidence.status === "missing" && metadataEvidence.status === "missing") {
    const orphanCleanup = await cleanupRetiredBrowserState(state, {
      processStatus: browserProcessStatus,
      removeProfile,
    });
    if (orphanCleanup !== "clean") {
      throw new BridgeError(
        orphanCleanup === "pending" ? "BROWSER_RECOVERY_PENDING" : "BROWSER_RECOVERY_AMBIGUOUS",
        "Browser owner evidence could not be safely retired.",
      );
    }
    return false;
  }
  if (launchEvidence.status !== "valid") {
    throw new BridgeError("BROWSER_RECOVERY_AMBIGUOUS", "Browser launch authority is missing; recovery evidence was retained.");
  }
  const launch = launchEvidence.record;
  const metadata = metadataEvidence.status === "valid" ? metadataEvidence.record : undefined;
  let disposition = launch.phase === "starting"
    ? await resolveStartingLaunch(state.launchPath, launch, { processStatus: browserProcessStatus })
    : launchRecoveryDisposition(launch, { processStatus: browserProcessStatus });
  disposition = browserMetadataRecoveryDisposition(launch, metadata, disposition);
  if (disposition === "ambiguous") {
    throw new BridgeError("BROWSER_RECOVERY_AMBIGUOUS", "Browser launch authority is invalid.");
  }
  if (disposition === "pending") {
    throw new BridgeError("BROWSER_RECOVERY_PENDING", "Browser host retirement is not yet proven.");
  }
  try {
    if (disposition === "active") switch (launch.phase) {
      case "ready":
        await requestHostRetirement(launch, state.launchPath);
        break;
      case "committed":
        await closeEndpoint(metadata, launch, state.launchPath);
        break;
      default:
        throw new BridgeError("BROWSER_RECOVERY_AMBIGUOUS", "Active browser launch authority is invalid.");
    }
  } catch (error) {
    if (launch.hostPid && browserProcessStatus(launch.hostPid) === "dead") {
      // A provably retired exact host cannot retain cookies or keep using this
      // private profile. PID-live/EPERM ambiguity always retains evidence.
    } else {
      throw error;
    }
  }
  const ownerCleanup = await cleanupRetiredBrowserState(state, {
    processStatus: browserProcessStatus,
    removeProfile,
  });
  if (ownerCleanup !== "clean") {
    throw new BridgeError(
      ownerCleanup === "pending" ? "BROWSER_RECOVERY_PENDING" : "BROWSER_RECOVERY_AMBIGUOUS",
      "Browser owner evidence could not be safely retired.",
    );
  }
  return true;
}

async function requestHostRetirement(launch, launchPath) {
  if (!Number.isInteger(launch.controlPort) || !launch.hostPid) {
    throw new BridgeError("BROWSER_RECOVERY_PENDING", "Browser host control authority is not ready.");
  }
  const base = `http://127.0.0.1:${launch.controlPort}`;
  const headers = { authorization: `Bearer ${launch.nonce}` };
  const statusResponse = await fetch(`${base}/status`, { headers, signal: AbortSignal.timeout(1_000) });
  const status = await statusResponse.json();
  if (
    !statusResponse.ok || status?.protocol !== "prime-continuim.browser-control.v1" ||
    status.nonce !== launch.nonce || status.pid !== launch.hostPid || status.ready !== true
  ) throw new BridgeError("BROWSER_CONTROL_IDENTITY_CHANGED", "Browser host control identity changed; recovery evidence was retained.");
  const closeResponse = await fetch(`${base}/close`, { method: "POST", headers, signal: AbortSignal.timeout(1_000) });
  const closing = await closeResponse.json();
  if (
    closeResponse.status !== 202 || closing?.protocol !== "prime-continuim.browser-control.v1" ||
    closing.nonce !== launch.nonce || closing.pid !== launch.hostPid || closing.closing !== true
  ) throw new BridgeError("BROWSER_CONTROL_IDENTITY_CHANGED", "Browser host did not acknowledge exact retirement.");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const evidence = await readLaunchEvidence(launchPath);
    if (
      evidence.status === "valid" && evidence.record.phase === "retired" &&
      evidence.record.nonce === launch.nonce && evidence.record.hostPid === launch.hostPid &&
      browserProcessStatus(launch.hostPid) === "dead"
    ) return;
    await wait(25);
  }
  throw new BridgeError("BROWSER_CLOSE_FAILED", "The verified browser host did not durably acknowledge retirement.");
}

async function waitForEndpoint(state, pid) {
  const activePortPath = join(state.profileDirectory, "DevToolsActivePort");
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(activePortPath, "utf8");
      const [portLine, browserPath] = contents.trim().split(/\r?\n/);
      const port = Number(portLine);
      if (!Number.isInteger(port) || port < 1 || port > 65_535 || !browserPath?.startsWith("/devtools/browser/")) {
        throw new Error("invalid DevToolsActivePort");
      }
      const endpoint = `http://127.0.0.1:${port}`;
      const identity = await endpointIdentity(endpoint);
      const browserId = browserPath.slice("/devtools/browser/".length);
      if (identity.browserId !== browserId) throw new Error("browser endpoint identity mismatch");
      return { protocol: PROTOCOL, endpoint, browserId, pid };
    } catch (error) {
      lastError = error;
      await wait(POLL_MS);
    }
  }
  throw new BridgeError("BROWSER_START_FAILED", "The verified browser did not become ready.", { cause: lastError });
}

async function waitForReadyLaunch(state, starting, pid) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const evidence = await readLaunchEvidence(state.launchPath);
    if (evidence.status === "malformed") {
      throw new BridgeError("BROWSER_START_FAILED", "Browser host launch evidence became malformed.");
    }
    if (evidence.status === "valid") {
      const ready = evidence.record;
      if (
        ready.phase === "ready" && ready.nonce === starting.nonce &&
        ready.bridgePid === starting.bridgePid && ready.hostPid === pid
      ) return ready;
      if (ready.phase === "retired") {
        throw new BridgeError("BROWSER_START_FAILED", "The verified browser host retired before commit.");
      }
    }
    if (browserProcessStatus(pid) === "dead") {
      throw new BridgeError("BROWSER_START_FAILED", "The verified browser host retired before readiness.");
    }
    await wait(POLL_MS);
  }
  throw new BridgeError("BROWSER_START_FAILED", "The verified browser host did not publish exact readiness.");
}

async function rollbackFreshLaunch(state, child, spawnFailure) {
  await retireSpawnedChild(child, spawnFailure);
  const ownerCleanup = await cleanupRetiredBrowserState(state, {
    processStatus: browserProcessStatus,
    removeProfile: true,
  });
  if (ownerCleanup !== "clean") throw new BridgeError("BROWSER_ROLLBACK_FAILED", "Browser owner evidence was retained.");
}

async function retireSpawnedChild(child, spawnFailure) {
  if (spawnFailure || !child.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const retired = await Promise.race([
    exited.then(() => true),
    wait(5_000).then(() => false),
  ]);
  if (!retired) {
    throw new BridgeError("BROWSER_CLOSE_FAILED", "The freshly spawned verified browser host did not retire.");
  }
}

async function endpointIdentity(endpoint) {
  const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1_000) });
  if (!response.ok) throw new Error("browser endpoint unavailable");
  const value = await response.json();
  const socket = typeof value?.webSocketDebuggerUrl === "string" ? value.webSocketDebuggerUrl : "";
  const match = /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/([A-Za-z0-9-]+)$/.exec(socket);
  if (!match?.[1]) throw new Error("browser endpoint identity invalid");
  return { browserId: match[1] };
}

async function sessionState(stateRoot, sessionName, residentAuthority) {
  const workspace = await realpath(process.cwd());
  const { authorityKey, sessionKey } = browserSessionStateKeys(workspace, sessionName, residentAuthority);
  const directory = join(stateRoot, "resident-authorities", authorityKey, sessionKey);
  await ensurePrivateDirectory(directory);
  return Object.freeze({
    userSessionName: sessionName,
    officialSessionName: `pc-${authorityKey.slice(0, 10)}-${sessionKey.slice(0, 16)}`,
    directory,
    launchPath: join(directory, "launch.json"),
    metadataPath: join(directory, "browser.json"),
    profileDirectory: join(directory, "profile"),
  });
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new BridgeError("STATE_INVALID", "Browser state is not a private directory.");
  if (process.platform !== "win32") {
    if ((entry.mode & 0o077) !== 0) throw new BridgeError("STATE_INVALID", "Browser state permissions are too broad.");
    if (typeof process.getuid === "function" && entry.uid !== process.getuid()) {
      throw new BridgeError("STATE_INVALID", "Browser state is owned by another user.");
    }
  }
  return realpath(directory);
}

async function runOfficial(args, silent = false) {
  const previousArgv = process.argv;
  const previousWrite = process.stdout.write;
  process.argv = [process.execPath, import.meta.filename, ...args];
  if (silent) process.stdout.write = (() => true);
  try {
    await program({ embedderVersion: `prime-continuim-${BRIDGE_VERSION}` });
  } finally {
    process.argv = previousArgv;
    process.stdout.write = previousWrite;
  }
}

async function stopOfficialSession(sessionName) {
  await runOfficial([`--session=${sessionName}`, "close"], true);
}

function parseOpenOptions(args) {
  const positional = [];
  let headed = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "open") continue;
    if (argument === "--headed") {
      headed = true;
      continue;
    }
    if (argument === "--persistent") {
      throw new BridgeError(
        "UNSUPPORTED_BOUNDARY",
        "Persistent browser profiles are unavailable until they can be bound to an exact resident generation.",
      );
    }
    if (argument === "--session" || argument === "-s") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--session=") || argument.startsWith("-s=")) continue;
    if (argument.startsWith("-")) {
      throw new BridgeError("UNSUPPORTED_BOUNDARY", `Unsupported verified-browser option: ${argument}`);
    }
    positional.push(argument);
  }
  if (positional.length > 1) throw new BridgeError("ARGUMENT_INVALID", "Browser open accepts at most one URL.");
  return { headed, url: positional[0] };
}

function browserEnvironment() {
  return { ...createBrowserHostEnvironment(process.env) };
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function safeError(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code
    : "COMMAND_FAILED";
  let message = error instanceof Error ? error.message : "Browser bridge command failed.";
  for (const value of [
    process.env.PRIME_CONTINUIM_BROWSER_EXECUTABLE,
    process.env.PRIME_CONTINUIM_BROWSER_BRIDGE,
    process.env.PRIME_CONTINUIM_BROWSER_STATE_DIR,
  ]) {
    if (value) message = message.split(value).join("<private>");
  }
  message = message.replace(/(?:https?|ws):\/\/127\.0\.0\.1:\d+[^\s]*/g, "<private-browser>");
  return `${code}: ${message.slice(0, 1_024)}`;
}

class BridgeError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "BridgeError";
    this.code = code;
  }
}

await main().catch((error) => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});
