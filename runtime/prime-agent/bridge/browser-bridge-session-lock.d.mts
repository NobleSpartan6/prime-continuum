export function withBrowserSessionLock<T>(
  sessionDirectory: string,
  action: () => Promise<T>,
  options?: Readonly<{
    deadOwnerGraceMs?: number;
    now?: () => number;
    ownerStatus?: (pid: number) => "live" | "dead" | "unknown";
  }>,
): Promise<T>;
