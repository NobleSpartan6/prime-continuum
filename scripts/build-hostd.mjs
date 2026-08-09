import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { createEmbeddedRuntimeAttestationRecord, parseRuntimeAttestation } from "./runtime-attestation-lib.mjs";

const argumentsValue = parseArguments(process.argv.slice(2));
let attestationRecord;
if (argumentsValue.attestation) {
  const bytes = await readFile(resolve(argumentsValue.attestation));
  parseRuntimeAttestation(bytes);
  attestationRecord = createEmbeddedRuntimeAttestationRecord(bytes);
}

const outfile = resolve("out/hostd/hostd.cjs");
const windowsJobSupervisorInput = "scripts/windows-job-supervisor.ps1";
const windowsJobSupervisor = (await readBoundedPlainFile(
  resolve(windowsJobSupervisorInput),
  256 * 1024,
)).toString("utf8");
const buildResult = await build({
  entryPoints: [resolve("src/hostd/index.ts")],
  outfile,
  bundle: true,
  metafile: true,
  preserveSymlinks: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "info",
  define: {
    __PRIME_CONTINUIM_RUNTIME_ATTESTATION_RECORD__: attestationRecord === undefined
      ? "undefined"
      : JSON.stringify(attestationRecord),
    __PRIME_CONTINUIM_WINDOWS_JOB_SUPERVISOR__: JSON.stringify(windowsJobSupervisor),
  },
});
await verifyBuiltHostStartup(outfile);
const bundle = await readFile(outfile);
const provenance = {
  schemaVersion: 1,
  bundleSha256: createHash("sha256").update(bundle).digest("hex"),
  inputs: [...new Set([...Object.keys(buildResult.metafile.inputs), windowsJobSupervisorInput])].sort(),
};
await writeFile(
  resolve("out/hostd/hostd-build-provenance.json"),
  `${JSON.stringify(provenance, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);

function parseArguments(argv) {
  if (argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== "--attestation" || !argv[1] || argv[1].startsWith("--")) {
    throw new Error("Usage: build-hostd.mjs [--attestation <absolute-or-repository-relative-path>]");
  }
  return { attestation: argv[1] };
}

async function readBoundedPlainFile(path, maximumBytes) {
  const pathMetadata = await lstat(path);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || pathMetadata.size <= 0 || pathMetadata.size > maximumBytes) {
    throw new Error(`Hostd embedded input is not a bounded plain file: ${path}`);
  }
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino || before.size !== pathMetadata.size) {
      throw new Error(`Hostd embedded input changed during safe open: ${path}`);
    }
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(bytes, position, before.size - position, position);
      if (bytesRead <= 0) throw new Error(`Hostd embedded input ended before its recorded size: ${path}`);
      position += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: growthBytes } = await handle.read(probe, 0, 1, before.size);
    const after = await handle.stat();
    if (
      growthBytes !== 0 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error(`Hostd embedded input changed during bounded read: ${path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function verifyBuiltHostStartup(path) {
  const maximumOutputBytes = 64 * 1024;
  const timeoutMs = 10_000;
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [path, "--help"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const capture = (target) => (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumOutputBytes) {
        child.kill();
        finish(new Error("Built host startup smoke output exceeded its bound."));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (settled) return;
      const output = Buffer.concat(stdout).toString("utf8");
      const diagnostic = Buffer.concat(stderr).toString("utf8");
      const expectedPrefix = "Unknown hostd mode: --help\nUsage:\n";
      if (code !== 2 || signal !== null || output !== "" || !diagnostic.startsWith(expectedPrefix) || diagnostic.includes("TypeError")) {
        finish(new Error("Built host bundle did not complete its bounded startup smoke."));
        return;
      }
      finish();
    });
    timer = setTimeout(() => {
      child.kill();
      finish(new Error("Built host startup smoke timed out."));
    }, timeoutMs);
  });
}
