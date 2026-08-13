import { createRequire } from "node:module";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRuntimeAttestation, serializeRuntimeAttestation } from "./runtime-attestation-lib.mjs";
import { resolvePinnedDevelopmentNodeExecutable } from "./development-node-runtime.mjs";

const argumentsValue = parseArguments(process.argv.slice(2));
const require = createRequire(import.meta.url);
const electronExecutable = resolve(argumentsValue.electron ?? require("electron"));
const hostNodeExecutable = resolve(argumentsValue.hostNode ?? resolvePinnedDevelopmentNodeExecutable(resolve(import.meta.dirname, "..")));
const runtimeRoot = resolve(argumentsValue.runtimeRoot ?? "out/runtime");
const output = resolve(argumentsValue.output ?? "out/main/runtime-attestation.json");
if (!isAbsolute(electronExecutable) || !isAbsolute(hostNodeExecutable) || !isAbsolute(runtimeRoot) || !isAbsolute(output)) {
  throw new Error("Runtime attestation paths must be absolute.");
}

const attestation = await createRuntimeAttestation({ runtimeRoot, electronExecutable, hostNodeExecutable });
const bytes = serializeRuntimeAttestation(attestation);
await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.tmp-${process.pid}-${randomUUID()}`;
try {
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, output);
} catch (error) {
  await import("node:fs/promises").then(({ rm }) => rm(temporary, { force: true })).catch(() => undefined);
  throw error;
}
process.stdout.write(`${JSON.stringify({ output, bytes: bytes.byteLength, assurance: attestation.assurance, runtime: attestation.runtime, guiRuntime: attestation.guiRuntime, hostRuntime: attestation.hostRuntime }, null, 2)}\n`);

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output" || argument === "--runtime-root" || argument === "--electron" || argument === "--host-node") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires one path.`);
      index += 1;
      if (argument === "--output") result.output = value;
      else if (argument === "--runtime-root") result.runtimeRoot = value;
      else if (argument === "--electron") result.electron = value;
      else result.hostNode = value;
      continue;
    }
    throw new Error(`Unknown runtime attestation argument: ${argument ?? "(missing)"}.`);
  }
  return result;
}
