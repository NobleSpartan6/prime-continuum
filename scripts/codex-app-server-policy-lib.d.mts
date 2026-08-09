export interface CodexAppServerEnvironmentOptions {
  readonly codexHome: string;
  readonly companionDirectory: string;
  readonly temporaryDirectory: string;
}

export const CODEX_APP_SERVER_ENVIRONMENT_POLICY: Readonly<{
  inherit: "none";
  requiredSourceVariables: readonly ["SystemRoot", "WINDIR"];
  constructedVariables: readonly ["ComSpec", "TEMP", "TMP", "PATH", "PATHEXT", "CODEX_HOME"];
  privateTemporaryDirectoryRequired: true;
  pathEntries: readonly ["codex-path", "System32", "WindowsPowerShell/v1.0"];
  pathExt: ".COM;.EXE;.BAT;.CMD";
}>;

export const CODEX_APP_SERVER_LEGAL_FILES: readonly Readonly<{
  fileName: "codex-LICENSE" | "codex-NOTICE";
  path: "legal/LICENSE" | "legal/NOTICE";
  url: string;
  sourceCommit: "be6e8eac029b183056b7e4402879f15d2c85f61b";
  size: number;
  sha256: string;
}>[];

export function createCodexAppServerEnvironment(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options: CodexAppServerEnvironmentOptions,
): Readonly<Record<string, string>>;
