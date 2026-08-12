const { app, BrowserWindow } = require("electron");

const OWNER_POLL_MS = 200;
const ownerPid = exactPositiveIntegerArgument("--prime-doctor-owner-pid=");
if (process.ppid !== ownerPid) {
  throw new Error("verified browser doctor owner is unavailable");
}

app.commandLine.appendSwitch("no-first-run");
app.commandLine.appendSwitch("no-default-browser-check");

let browserWindow;
let closing = false;
const ownerWatchdog = setInterval(() => {
  // The OS parent relationship cannot be transferred to a PID-reused process.
  if (process.ppid !== ownerPid) initiateQuit();
}, OWNER_POLL_MS);
ownerWatchdog.unref();

void app.whenReady().then(async () => {
  if (closing) return;
  browserWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await browserWindow.loadURL("about:blank");
}).catch(() => initiateQuit());

app.on("window-all-closed", () => initiateQuit());
app.on("will-quit", () => clearInterval(ownerWatchdog));

function initiateQuit() {
  if (closing) return;
  closing = true;
  clearInterval(ownerWatchdog);
  if (app.isReady()) app.quit();
  else app.once("ready", () => app.quit());
}

function exactPositiveIntegerArgument(prefix) {
  const values = process.argv.filter((argument) => argument.startsWith(prefix));
  if (values.length !== 1) throw new Error("missing verified browser doctor owner");
  const value = Number(values[0].slice(prefix.length));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("invalid verified browser doctor owner");
  }
  return value;
}
