export function withBrowserSessionLock<T>(
  sessionDirectory: string,
  action: () => Promise<T>,
  options?: Readonly<{
    now?: () => number;
    ownerStatus?: (pid: number) => "live" | "dead" | "unknown";
  }>,
): Promise<T>;
