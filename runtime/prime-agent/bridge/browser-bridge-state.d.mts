export function residentBrowserAuthority(environment: Readonly<Record<string, string | undefined>>): string;
export function browserSessionStateKeys(
  workspace: string,
  sessionName: string,
  residentAuthority: string,
): Readonly<{ authorityKey: string; sessionKey: string }>;
