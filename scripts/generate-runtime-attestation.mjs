import { createRequire } from "node:module";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRuntimeAttestation, serializeRuntimeAttestation } from "./runtime-attestation-lib.mjs";

const argumentsValue = parseArguments(process.argv.slice(2));
const require = createRequire(import.meta.url);
const electronExecutable = resolve(argumentsValue.electron ?? require("electron"));
const runtimeRoot = resolve(argumentsValue.runtimeRoot ?? "out/runtime");
const output = resolve(argumentsValue.output ?? "out/main/runtime-attestation.json");
if (!isAbsolute(electronExecutable) || !isAbsolute(runtimeRoot) || !isAbsolute(output)) {
  throw new Error("Runtime attestation paths must be absolute.");
}

const attestation = await createRuntimeAttestation({ runtimeRoot, electronExecutable });
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
process.stdout.write(`${JSON.stringify({ output, bytes: bytes.byteLength, assurance: attestation.assurance, runtime: attestation.runtime, hostRuntime: attestation.hostRuntime }, null, 2)}\n`);

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output" || argument === "--runtime-root" || argument === "--electron") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires one path.`);
      index += 1;
      if (argument === "--output") result.output = value;
      else if (argument === "--runtime-root") result.runtimeRoot = value;
      else result.electron = value;
      continue;
    }
    throw new Error(`Unknown runtime attestation argument: ${argument ?? "(missing)"}.`);
  }
  return result;
}
