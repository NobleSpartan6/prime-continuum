export function browserCommandIndex(args: readonly string[]): number;
export function firstBrowserCommand(args: readonly string[]): string | undefined;
export function rewriteBrowserCommand(args: readonly string[], command: string): string[];
export function rewriteBrowserSessionName(args: readonly string[], sessionName: string): string[];
export function parseBrowserSessionName(
  args: readonly string[],
  environment?: Readonly<Record<string, string | undefined>>,
): string;
