const { createServer } = require("node:http");
const { isAbsolute } = require("node:path");
const {
  claimBrowserLaunchOwnerSync,
  metadataMatchesCommitted,
  publishClaimedLaunchSync,
  publishReadyLaunchSync,
  publishRetiredLaunchSync,
  readLaunchRecordSync,
  validBrowserMetadata,
  validNonce,
} = require("./browser-bridge-launch-journal.cjs");

const CONTROL_PROTOCOL = "prime-continuim.browser-control.v1";
const COMMIT_TIMEOUT_MS = 20_000;
const WATCHDOG_INTERVAL_MS = 200;
const launchPath = exactArgument("--prime-launch-journal=");
const metadataPath = exactArgument("--prime-browser-metadata=");
const nonce = exactArgument("--prime-launch-nonce=");
if (!isAbsolute(launchPath) || !isAbsolute(metadataPath) || !validNonce(nonce)) {
  throw new Error("invalid verified browser host authority");
}
const starting = readLaunchRecordSync(launchPath);
if (!starting || starting.phase !== "starting" || starting.nonce !== nonce) {
  throw new Error("verified browser launch evidence is unavailable");
}
const launchOwner = claimBrowserLaunchOwnerSync(launchPath, nonce, process.pid);
const claimed = publishClaimedLaunchSync(launchPath, launchOwner);
const { app, BrowserWindow } = require("electron");

app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", "0");
app.commandLine.appendSwitch("no-first-run");
app.commandLine.appendSwitch("no-default-browser-check");

let browserWindow;
let closing = false;
let readyRecord;
let watchdog;
let resolveControlReady;
let rejectControlReady;
const controlReady = new Promise((resolve, reject) => {
  resolveControlReady = resolve;
  rejectControlReady = reject;
});

const control = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${nonce}`) {
    respond(response, 404, { error: "not_found" });
    return;
  }
  const current = readLaunchRecordSync(launchPath);
  if (!current || current.nonce !== nonce || current.hostPid !== process.pid || current.phase === "retired") {
    respond(response, 409, { error: "authority_changed" });
    return;
  }
  if (request.method === "GET" && request.url === "/status") {
    respond(response, 200, { nonce, pid: process.pid, protocol: CONTROL_PROTOCOL, ready: true });
    return;
  }
  if (request.method === "POST" && request.url === "/close") {
    respond(response, 202, { closing: true, nonce, pid: process.pid, protocol: CONTROL_PROTOCOL });
    setImmediate(initiateQuit);
    return;
  }
  respond(response, 404, { error: "not_found" });
});

control.listen(0, "127.0.0.1", () => {
  const address = control.address();
  if (!address || typeof address === "string") throw new Error("verified browser control did not bind privately");
  readyRecord = publishReadyLaunchSync(launchPath, nonce, process.pid, address.port);
  watchdog = setInterval(checkCommitAuthority, WATCHDOG_INTERVAL_MS);
  watchdog.unref();
  resolveControlReady();
});

control.on("error", (error) => {
  rejectControlReady(error);
  initiateQuit();
});

Promise.all([app.whenReady(), controlReady]).then(async () => {
  if (closing) return;
  browserWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      // This window is intentionally never shown. Keep Chromium drawing and
      // swapping frames while it is hidden so CDP screenshots cannot stall on
      // an occluded renderer, notably under Linux/Xvfb.
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await browserWindow.loadURL("about:blank");
}).catch(() => initiateQuit());

app.on("will-quit", () => {
  clearInterval(watchdog);
  control.close();
});

// Terminal evidence is written only from Node's final synchronous exit hook.
// A will-quit event is not proof that Electron actually retired.
process.on("exit", () => {
  publishRetiredLaunchSync(launchPath, nonce, process.pid);
});

app.on("window-all-closed", () => initiateQuit());

function checkCommitAuthority() {
  const current = readLaunchRecordSync(launchPath);
  if (current?.phase === "committed" && current.nonce === nonce && current.hostPid === process.pid) {
    const metadata = readMetadataSync(metadataPath);
    if (metadataMatchesCommitted(metadata, current)) {
      clearInterval(watchdog);
      return;
    }
  }
  if (
    !readyRecord || !current || current.nonce !== nonce || current.hostPid !== process.pid ||
    Date.now() - claimed.createdAt >= COMMIT_TIMEOUT_MS || ownerStatus(claimed.bridgePid) === "dead"
  ) initiateQuit();
}

function initiateQuit() {
  if (closing) return;
  closing = true;
  clearInterval(watchdog);
  if (app.isReady()) app.quit();
  else app.once("ready", () => app.quit());
}

function readMetadataSync(path) {
  try {
    const bytes = require("node:fs").readFileSync(path);
    if (bytes.byteLength < 2 || bytes.byteLength > 8 * 1024) return undefined;
    const value = JSON.parse(bytes.toString("utf8"));
    return validBrowserMetadata(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function ownerStatus(pid) {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return error?.code === "ESRCH" ? "dead" : "unknown";
  }
}

function exactArgument(prefix) {
  const values = process.argv.filter((argument) => argument.startsWith(prefix));
  if (values.length !== 1 || values[0].length <= prefix.length) throw new Error("missing verified browser host authority");
  return values[0].slice(prefix.length);
}

function respond(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  });
  response.end(body);
}
