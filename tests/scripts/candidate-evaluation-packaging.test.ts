import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHostdBuildProvenance } from "../../scripts/verify-windows-package.mjs";

describe("candidate evaluation Windows packaging boundary", () => {
  it("binds the bounded plain Job Object supervisor into hostd provenance and package verification", async () => {
    const [buildSource, verifierSource] = await Promise.all([
      readFile(resolve("scripts/build-hostd.mjs"), "utf8"),
      readFile(resolve("scripts/verify-windows-package.mjs"), "utf8"),
    ]);

    expect(buildSource).toContain('const windowsJobSupervisorInput = "scripts/windows-job-supervisor.ps1"');
    expect(buildSource).toContain("readBoundedPlainFile(");
    expect(buildSource).toContain("await verifyBuiltHostStartup(outfile)");
    expect(buildSource).toContain('const expectedPrefix = "Unknown hostd mode: --help\\nUsage:\\n"');
    expect(buildSource).toContain("Object.keys(buildResult.metafile.inputs), windowsJobSupervisorInput");
    expect(verifierSource).toContain("value.inputs.includes('scripts/windows-job-supervisor.ps1')");

    const base = { schemaVersion: 1, bundleSha256: "a".repeat(64) };
    expect(() => parseHostdBuildProvenance(Buffer.from(JSON.stringify({
      ...base,
      inputs: ["src/hostd/index.ts"],
    })))).toThrow(/Job Object supervisor/);
    expect(parseHostdBuildProvenance(Buffer.from(JSON.stringify({
      ...base,
      inputs: ["scripts/windows-job-supervisor.ps1", "src/hostd/index.ts"],
    })))).toMatchObject(base);
  });

  it("assigns a suspended child before resume and confirms both failure cleanup and final zero-active accounting", async () => {
    const source = await readFile(resolve("scripts/windows-job-supervisor.ps1"), "utf8");
    const assignmentAttribute = source.indexOf("PROC_THREAD_ATTRIBUTE_JOB_LIST");
    const create = source.indexOf("CreateProcess(executable");
    const resume = source.indexOf("ResumeThread(thread)");

    expect(source).toContain("KILL_ON_CLOSE");
    expect(assignmentAttribute).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(assignmentAttribute);
    expect(resume).toBeGreaterThan(create);
    expect(source).toContain("CREATE_SUSPENDED|EXTENDED_STARTUPINFO_PRESENT");
    expect(source).toContain('Check(WaitForSingleObject(process,INFINITE)==WAIT_OBJECT_0,"Process wait failed")');
    expect(source).toContain('Check(TerminateJobObject(job,exitCode),"TerminateJobObject failed")');
    expect(source).toContain("TerminateProcess(process,1)");
    expect(source).toContain("WaitForSingleObject(process,5000)!=WAIT_OBJECT_0");
    expect(source).toContain("if(a.active==0)return unchecked((int)exitCode)");
  });
});
