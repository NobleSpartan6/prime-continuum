export function createBrowserHostEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>>;

export type BrowserProcessStatus = "live" | "dead" | "unknown";

export function browserProcessStatus(pid: number, options?: Readonly<{
  platform?: NodeJS.Platform;
  signal?: (pid: number) => void;
  readProcStat?: (pid: number) => string;
}>): BrowserProcessStatus;
