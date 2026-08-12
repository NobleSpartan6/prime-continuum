import { createHash } from "node:crypto";

const AUTHORITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function residentBrowserAuthority(environment) {
  const value = environment?.PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID;
  if (typeof value !== "string" || !AUTHORITY_PATTERN.test(value)) {
    const error = new Error("Verified browser execution requires an exact resident session authority.");
    error.code = "RESIDENT_AUTHORITY_UNAVAILABLE";
    throw error;
  }
  return value;
}

export function browserSessionStateKeys(workspace, sessionName, residentAuthority) {
  const authorityKey = createHash("sha256").update(residentAuthority, "utf8").digest("hex").slice(0, 32);
  const sessionKey = createHash("sha256").update(`${workspace}\0${sessionName}`, "utf8").digest("hex").slice(0, 32);
  return Object.freeze({ authorityKey, sessionKey });
}
