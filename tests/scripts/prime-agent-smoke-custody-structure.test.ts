import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const runtimeInitialization = read("scripts/verify-hostd-runtime-initialization.mjs");
const residentLifecycle = read("scripts/verify-hostd-resident-lifecycle.mjs");
const windowsPackage = read("scripts/verify-windows-package.mjs");
const custodyHelper = read("scripts/prime-agent-smoke-custody-lib.mjs");

describe("Prime Agent package-smoke custody structure", () => {
  it.each([
    ["runtime initialization", runtimeInitialization],
    ["resident lifecycle", residentLifecycle],
    ["Windows package", windowsPackage],
  ])("binds %s to the hostd-exported resolver and explicit post-shutdown cleanup", (_label, source) => {
    expect(source).toMatch(/from ["']\.\/prime-agent-smoke-custody-lib\.mjs["']/);
    expect(source).toContain("createPrimeAgentSmokeCustody({");
    expect(source).toContain("hostdModule");
    expect(source).toContain("await primeAgentCustody.assertInitiallyAbsent()");
    expect(source).toContain("await primeAgentCustody.captureExisting()");
    expect(source).toContain("await primeAgentCustody.removeAfterConfirmedShutdown({ confirmedCleanShutdown: true })");
    expect(source).toMatch(/custody (?:was retained|cleanup requires)|custody was retained/i);
  });

  it("seeds the resident smoke extension only after production custody has been captured", () => {
    expect(residentLifecycle).not.toMatch(/environment\.PRIME_AGENT_CODING_AGENT_DIR\s*=/);
    const capture = residentLifecycle.indexOf("await primeAgentCustody.captureExisting();");
    const extensionDirectory = residentLifecycle.indexOf("await mkdir(extensionDirectory", capture);
    const extensionWrite = residentLifecycle.indexOf("await writeFile(fauxExtensionPath", extensionDirectory);
    expect(capture).toBeGreaterThan(0);
    expect(extensionDirectory).toBeGreaterThan(capture);
    expect(extensionWrite).toBeGreaterThan(extensionDirectory);
  });

  it("keeps leaf removal behind exact clean-shutdown evidence in every harness", () => {
    const runtimeCleanup = runtimeInitialization.slice(runtimeInitialization.indexOf("const cleanupFailures = []"));
    expect(runtimeCleanup.indexOf("await stopChild(child)")).toBeLessThan(
      runtimeCleanup.indexOf("removeAfterConfirmedShutdown"),
    );
    const residentCleanup = residentLifecycle.slice(residentLifecycle.indexOf("const cleanupFailures = []"));
    expect(residentCleanup.indexOf("await stopHostd(hostdChild)")).toBeLessThan(
      residentCleanup.indexOf("removeAfterConfirmedShutdown"),
    );
    const packageCleanup = windowsPackage.slice(windowsPackage.indexOf("async function smokePackagedApplication"));
    expect(packageCleanup.indexOf("markers.length === 1")).toBeLessThan(
      packageCleanup.indexOf("cleanShutdownConfirmed = true"),
    );
    expect(packageCleanup.indexOf("cleanShutdownConfirmed = true")).toBeLessThan(
      packageCleanup.indexOf("removeAfterConfirmedShutdown"),
    );
  });

  it("re-proves exact custody and bounds a link-free tree before removing only the leaf", () => {
    expect(custodyHelper).toContain("security.assertStillSecure(proof)");
    expect(custodyHelper).toContain("assertIdentity(agentDirectory, proof.agentDirectoryIdentity)");
    expect(custodyHelper).toContain("assertIdentity(proof.canonicalCustodyParent, proof.custodyParentIdentity)");
    expect(custodyHelper).toContain("MAX_TREE_ENTRIES");
    expect(custodyHelper).toContain("MAX_TREE_DEPTH");
    expect(custodyHelper).toContain("MAX_TREE_BYTES");
    expect(custodyHelper).toContain("metadata.isSymbolicLink()");
    expect(custodyHelper).toContain("metadata.nlink !== 1");
    expect(custodyHelper).toContain("await rm(agentDirectory");
    expect(custodyHelper).not.toMatch(/rm\((?:programDataRoot|proof\.canonicalCustodyParent)/);
  });
});

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}
