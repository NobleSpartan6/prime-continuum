import { readFileSync } from "node:fs";

const SAFE_EXACT_KEYS = new Set([
  "APPDATA",
  "COMSPEC",
  "DISPLAY",
  "HOME",
  "LANG",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SHELL",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "__CF_USER_TEXT_ENCODING",
]);

/**
 * Browser pages receive a minimal OS launch environment, never provider,
 * package-manager, loader, proxy, or agent credentials inherited by hostd.
 */
export function createBrowserHostEnvironment(source) {
  const output = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (typeof value !== "string" || /[\0\r\n]/.test(value)) continue;
    const normalized = key.toUpperCase();
    if (
      !SAFE_EXACT_KEYS.has(normalized) &&
      !normalized.startsWith("LC_")
    ) continue;
    output[key] = value;
  }
  return Object.freeze(output);
}

export function browserProcessStatus(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return "unknown";
  const signal = options.signal ?? ((processId) => process.kill(processId, 0));
  try {
    signal(pid);
  } catch (error) {
    return error?.code === "ESRCH" ? "dead" : "unknown";
  }

  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return "live";
  const readProcStat = options.readProcStat ?? ((processId) => readFileSync(`/proc/${processId}/stat`, "utf8"));
  try {
    const stat = readProcStat(pid);
    const commandEnd = typeof stat === "string" ? stat.lastIndexOf(") ") : -1;
    const state = commandEnd >= 0 ? stat[commandEnd + 2] : undefined;
    if (state === "Z" || state === "X" || state === "x") return "dead";
    return typeof state === "string" && state.length === 1 ? "live" : "unknown";
  } catch (error) {
    return error?.code === "ENOENT" ? "dead" : "unknown";
  }
}
