import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
const buildResult = await build({
  entryPoints: [resolve("src/hostd/index.ts")],
  outfile,
  bundle: true,
  metafile: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "info",
  define: {
    __PRIME_CONTINUIM_RUNTIME_ATTESTATION_RECORD__: attestationRecord === undefined
      ? "undefined"
      : JSON.stringify(attestationRecord),
  },
});
const bundle = await readFile(outfile);
const provenance = {
  schemaVersion: 1,
  bundleSha256: createHash("sha256").update(bundle).digest("hex"),
  inputs: Object.keys(buildResult.metafile.inputs).sort(),
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
