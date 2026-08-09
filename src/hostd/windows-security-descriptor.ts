const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const MAX_ACL_ENTRIES = 100_001;

/**
 * Neutral parser for the exact protected user/SYSTEM/Administrators Windows
 * boundary used by credential-bearing host components. It accepts only full
 * control ACEs and rejects unknown trustees, deny ACEs, object GUIDs,
 * inherit-only roots, partial rights, and malformed SDDL.
 */
export function isExactProtectedUserDirectoryDacl(sddl: string, currentUserSid: string): boolean {
  if (!isSupportedWindowsUserSid(currentUserSid)) return false;
  const parsed = parseDacl(sddl);
  if (!parsed || !hasExactDaclFlags(parsed.flags, "protected")) return false;
  const aces = parsed.body.match(/\([^()]+\)/g) ?? [];
  if (aces.join("") !== parsed.body || aces.length !== 3) return false;
  const trustees = new Set<string>();
  for (const ace of aces) {
    const fields = ace.slice(1, -1).split(";");
    if (
      fields.length !== 6 || fields[0] !== "A" ||
      !hasExactAceFlags(fields[1]!, ["OI", "CI"]) ||
      !isFileFullControl(fields[2]!) || fields[3] !== "" || fields[4] !== ""
    ) return false;
    trustees.add(canonicalTrustee(fields[5]!));
  }
  return trustees.size === 3 && trustees.has(currentUserSid) && trustees.has(SYSTEM_SID) &&
    trustees.has(ADMINISTRATORS_SID);
}

export function areAllExactProtectedUserDirectoryDacls(
  output: string,
  currentUserSid: string,
  expectedEntryCount: number,
): boolean {
  if (!validExpectedEntryCount(expectedEntryCount)) return false;
  const dacls = extractDacls(output);
  return dacls.length === expectedEntryCount &&
    dacls.every((dacl) => isExactProtectedUserDirectoryDacl(dacl, currentUserSid));
}

/** Accepts the protected root form or the exact inherited descendant form. */
export function isSecureInheritedUserEntryDacl(sddl: string, currentUserSid: string): boolean {
  if (!isSupportedWindowsUserSid(currentUserSid)) return false;
  const parsed = parseDacl(sddl);
  if (!parsed || !hasExactDaclFlags(parsed.flags, "inherited")) return false;
  const aces = parsed.body.match(/\([^()]+\)/g) ?? [];
  if (aces.join("") !== parsed.body || aces.length !== 3) return false;
  const trustees = new Set<string>();
  let inheritanceKind: "file" | "directory" | undefined;
  for (const ace of aces) {
    const fields = ace.slice(1, -1).split(";");
    if (
      fields.length !== 6 || fields[0] !== "A" ||
      !isFileFullControl(fields[2]!) || fields[3] !== "" || fields[4] !== ""
    ) return false;
    const observedInheritanceKind = hasExactAceFlags(fields[1]!, ["ID"])
      ? "file" as const
      : hasExactAceFlags(fields[1]!, ["OI", "CI", "ID"])
        ? "directory" as const
        : undefined;
    if (!observedInheritanceKind || (inheritanceKind && inheritanceKind !== observedInheritanceKind)) {
      return false;
    }
    inheritanceKind = observedInheritanceKind;
    trustees.add(canonicalTrustee(fields[5]!));
  }
  return trustees.size === 3 && trustees.has(currentUserSid) && trustees.has(SYSTEM_SID) &&
    trustees.has(ADMINISTRATORS_SID);
}

export function areAllSecureUserEntryDacls(
  output: string,
  currentUserSid: string,
  expectedEntryCount: number,
): boolean {
  if (!validExpectedEntryCount(expectedEntryCount)) return false;
  const dacls = extractDacls(output);
  return dacls.length === expectedEntryCount && dacls.every((dacl) =>
    isExactProtectedUserDirectoryDacl(dacl, currentUserSid) ||
    isSecureInheritedUserEntryDacl(dacl, currentUserSid));
}

export function isSupportedWindowsUserSid(value: string): boolean {
  if (value.length < 7 || value.length > 184) return false;
  return /^S-1-5-21(?:-\d+){4}$/.test(value) || /^S-1-12-1(?:-\d+){4}$/.test(value);
}

function parseDacl(sddl: string): Readonly<{ flags: string; body: string }> | undefined {
  if (!sddl.startsWith("D:")) return undefined;
  const bodyStart = sddl.indexOf("(", 2);
  if (bodyStart < 2) return undefined;
  return Object.freeze({ flags: sddl.slice(2, bodyStart), body: sddl.slice(bodyStart) });
}

function hasExactDaclFlags(flags: string, kind: "protected" | "inherited"): boolean {
  const tokens: string[] = flags.match(/AI|AR|P/g) ?? [];
  if (tokens.join("") !== flags || new Set(tokens).size !== tokens.length) return false;
  if (kind === "protected") return tokens.includes("P");
  return !tokens.includes("P") && tokens.includes("AI");
}

function hasExactAceFlags(flags: string, required: readonly string[]): boolean {
  const tokens: string[] = flags.match(/OI|CI|ID/g) ?? [];
  if (tokens.join("") !== flags || new Set(tokens).size !== tokens.length) return false;
  const requiredSet = new Set(required);
  return tokens.length === requiredSet.size && tokens.every((token) => requiredSet.has(token));
}

function isFileFullControl(rights: string): boolean {
  if (rights === "FA" || rights === "GA") return true;
  if (!/^0x[0-9a-f]{1,8}$/i.test(rights)) return false;
  return Number.parseInt(rights.slice(2), 16) === 0x001f01ff;
}

function canonicalTrustee(value: string): string {
  if (value === "SY") return SYSTEM_SID;
  if (value === "BA") return ADMINISTRATORS_SID;
  return value;
}

function extractDacls(output: string): string[] {
  return output.match(/D:[A-Z]*(?:\([^()\r\n]+\))+/g) ?? [];
}

function validExpectedEntryCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_ACL_ENTRIES;
}
