import { isAbsolute, join, resolve } from "node:path";

/**
 * Side-effect-free Codex app-server launch policy shared by the runtime
 * builder and the bundled host daemon. This module deliberately performs no
 * top-level filesystem access and does not resolve paths through import.meta.
 */
export const CODEX_APP_SERVER_ENVIRONMENT_POLICY = Object.freeze({
  inherit: "none",
  requiredSourceVariables: Object.freeze(["SystemRoot", "WINDIR"]),
  constructedVariables: Object.freeze(["ComSpec", "TEMP", "TMP", "PATH", "PATHEXT", "CODEX_HOME"]),
  privateTemporaryDirectoryRequired: true,
  pathEntries: Object.freeze(["codex-path", "System32", "WindowsPowerShell/v1.0"]),
  pathExt: ".COM;.EXE;.BAT;.CMD",
});

export const CODEX_APP_SERVER_LEGAL_FILES = Object.freeze([
  Object.freeze({
    fileName: "codex-LICENSE",
    path: "legal/LICENSE",
    url: "https://raw.githubusercontent.com/openai/codex/be6e8eac029b183056b7e4402879f15d2c85f61b/LICENSE",
    sourceCommit: "be6e8eac029b183056b7e4402879f15d2c85f61b",
    size: 10_926,
    sha256: "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc",
  }),
  Object.freeze({
    fileName: "codex-NOTICE",
    path: "legal/NOTICE",
    url: "https://raw.githubusercontent.com/openai/codex/be6e8eac029b183056b7e4402879f15d2c85f61b/NOTICE",
    sourceCommit: "be6e8eac029b183056b7e4402879f15d2c85f61b",
    size: 242,
    sha256: "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915",
  }),
]);

export function createCodexAppServerEnvironment(source, {
  codexHome,
  companionDirectory,
  temporaryDirectory,
}) {
  if (typeof codexHome !== "string" || !isAbsolute(codexHome) || /[\0\r\n]/.test(codexHome)) {
    throw new Error("Codex app-server requires an absolute private CODEX_HOME.");
  }
  if (
    typeof companionDirectory !== "string" ||
    !isAbsolute(companionDirectory) ||
    /[\0\r\n]/.test(companionDirectory)
  ) {
    throw new Error("Codex app-server requires an absolute verified companion directory.");
  }
  if (
    typeof temporaryDirectory !== "string" ||
    !isAbsolute(temporaryDirectory) ||
    /[\0\r\n]/.test(temporaryDirectory)
  ) {
    throw new Error("Codex app-server requires an absolute private temporary directory.");
  }
  const readRequired = (name) => {
    const matches = Object.entries(source ?? {}).filter(([key]) => key.toUpperCase() === name.toUpperCase());
    if (matches.length !== 1) throw new Error(`Codex app-server environment requires exactly one ${name}.`);
    const value = matches[0][1];
    if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/.test(value)) {
      throw new Error(`Codex app-server environment ${name} must be one absolute path.`);
    }
    return resolve(value);
  };
  const systemRoot = readRequired("SystemRoot");
  const windowsDirectory = readRequired("WINDIR");
  if (systemRoot.toLowerCase() !== windowsDirectory.toLowerCase()) {
    throw new Error("Codex app-server SystemRoot and WINDIR disagree.");
  }
  const verifiedCompanion = resolve(companionDirectory);
  const privateTemporaryDirectory = resolve(temporaryDirectory);
  if (privateTemporaryDirectory.toLowerCase() === resolve(codexHome).toLowerCase()) {
    throw new Error("Codex app-server temporary directory must be separate from CODEX_HOME.");
  }
  return Object.freeze({
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: join(systemRoot, "System32", "cmd.exe"),
    TEMP: privateTemporaryDirectory,
    TMP: privateTemporaryDirectory,
    PATH: [
      join(verifiedCompanion, "codex-path"),
      join(systemRoot, "System32"),
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    ].join(";"),
    PATHEXT: CODEX_APP_SERVER_ENVIRONMENT_POLICY.pathExt,
    CODEX_HOME: resolve(codexHome),
  });
}
