import { describe, expect, it } from "vitest";
import {
  areAllExactProtectedUserDirectoryDacls,
  areAllSecureUserEntryDacls,
  isExactProtectedUserDirectoryDacl,
  isSecureInheritedUserEntryDacl,
  isSupportedWindowsUserSid,
} from "../../src/hostd/windows-security-descriptor";

const USER = "S-1-5-21-100-200-300-1001";
const AAD_USER = "S-1-12-1-100-200-300-400";

describe("neutral Windows security descriptor predicates", () => {
  it("accepts only an exact protected user, SYSTEM, and Administrators root", () => {
    const exact = `D:P(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
    expect(isExactProtectedUserDirectoryDacl(exact, USER)).toBe(true);
    expect(areAllExactProtectedUserDirectoryDacls(`root ${exact}\r\n`, USER, 1)).toBe(true);
    expect(isExactProtectedUserDirectoryDacl(
      `D:AI(A;OICIID;FA;;;${USER})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)`,
      USER,
    )).toBe(false);
    expect(isExactProtectedUserDirectoryDacl(`${exact}(A;OICI;FR;;;WD)`, USER)).toBe(false);
  });

  it("allows the exact inherited descendant form but never promotes it to a root proof", () => {
    const inheritedFile = `(A;ID;FA;;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`;
    expect(isSecureInheritedUserEntryDacl(`D:${inheritedFile}`, USER)).toBe(true);
    expect(isSecureInheritedUserEntryDacl(`D:AI${inheritedFile}`, USER)).toBe(true);
    expect(areAllSecureUserEntryDacls(`auth D:${inheritedFile}\n`, USER, 1)).toBe(true);
    expect(isExactProtectedUserDirectoryDacl(`D:${inheritedFile}`, USER)).toBe(false);

    for (const invalid of [
      `D:P${inheritedFile}`,
      `D:AR${inheritedFile}`,
      `D:PAI${inheritedFile}`,
      `D:X${inheritedFile}`,
      `D:(A;;FA;;;${USER})(A;;FA;;;SY)(A;;FA;;;BA)`,
      `D:(A;ID;FA;;;${USER})(A;;FA;;;SY)(A;ID;FA;;;BA)`,
      `D:(A;ID;FA;;;${USER})(A;ID;FA;;;${USER})(A;ID;FA;;;BA)`,
      `D:${inheritedFile}(A;ID;FA;;;WD)`,
      `D:(D;ID;FA;;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`,
      `D:(A;ID;FA;object-guid;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`,
      `D:(A;OIID;FA;;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`,
      `D:(A;ID;FA;;;${USER})(A;OICIID;FA;;;SY)(A;ID;FA;;;BA)`,
      `D:(A;ID;FR;;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`,
      `D:(A;ID;FA;;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;WD)`,
    ]) {
      expect(isSecureInheritedUserEntryDacl(invalid, USER)).toBe(false);
    }
  });

  it("supports bounded classic and Entra user SID namespaces but excludes well-known identities", () => {
    expect(isSupportedWindowsUserSid(USER)).toBe(true);
    expect(isSupportedWindowsUserSid(AAD_USER)).toBe(true);
    expect(isSupportedWindowsUserSid("S-1-5-18")).toBe(false);
    expect(isSupportedWindowsUserSid("S-1-5-32-544")).toBe(false);
  });
});
