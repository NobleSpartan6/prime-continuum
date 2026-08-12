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
