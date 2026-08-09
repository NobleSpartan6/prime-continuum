import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  REPO_ROOT,
  RUNTIME_TEMPLATE_DIRECTORY,
  loadRuntimeInputs,
  smokeCodexAppServerCompanion,
  smokeRuntime,
  sha256File,
  verifyBuiltRuntime,
  verifyOnlySelectedRuntimeInstall,
} from "./prime-agent-runtime-lib.mjs";

const argumentsValue = parseArguments(process.argv.slice(2));
const inputs = await loadRuntimeInputs(RUNTIME_TEMPLATE_DIRECTORY);
const outputRoot = resolve(argumentsValue.output ?? join(REPO_ROOT, "out", "runtime"));
const pointer = JSON.parse(await readFile(join(outputRoot, "current.json"), "utf8"));
if (
  pointer?.schemaVersion !== 1 ||
  pointer.releaseVersion !== inputs.policy.releaseVersion ||
  pointer.platform !== process.platform ||
  pointer.arch !== process.arch ||
  typeof pointer.manifestSha256 !== "string" ||
  !/^[a-f0-9]{64}$/.test(pointer.manifestSha256) ||
  typeof pointer.runtimeManifest !== "string" ||
  pointer.runtimeManifest.includes("\\") ||
  pointer.runtimeManifest.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
  !pointer.runtimeManifest.endsWith("/runtime.json")
) {
  throw new Error("Runtime current.json is invalid.");
}
const manifestPath = resolve(outputRoot, ...pointer.runtimeManifest.split("/"));
const manifestRelative = relative(outputRoot, manifestPath);
if (manifestRelative === ".." || manifestRelative.startsWith(`..${sep}`) || isAbsolute(manifestRelative)) {
  throw new Error("Runtime current.json escapes the output root.");
}
const runtimeDirectory = await realpath(dirname(manifestPath));
await verifyOnlySelectedRuntimeInstall(outputRoot, runtimeDirectory);
if ((await sha256File(manifestPath)) !== pointer.manifestSha256) {
  throw new Error("Runtime pointer manifest digest does not match.");
}
const verified = await verifyBuiltRuntime(runtimeDirectory, { inputs, policy: inputs.policy });
if (verified.manifest.tree.sha256 !== pointer.treeSha256) throw new Error("Runtime pointer tree digest does not match.");
let codexAppServerSmoke;
if (argumentsValue.smoke) {
  const runtimeExecutable = resolve(argumentsValue.runtimeNode ?? process.execPath);
  if (!isAbsolute(runtimeExecutable)) throw new Error("Runtime executable must be absolute.");
  await smokeRuntime(runtimeDirectory, {
    runtimeExecutable,
    electronRunAsNode: argumentsValue.electronRunAsNode,
    policy: inputs.policy,
  });
  codexAppServerSmoke = await smokeCodexAppServerCompanion(runtimeDirectory, { policy: inputs.policy });
}
process.stdout.write(`${JSON.stringify({
  runtimeDirectory,
  treeSha256: verified.manifest.tree.sha256,
  smoke: Boolean(argumentsValue.smoke),
  ...(codexAppServerSmoke ? { codexAppServerSmoke } : {}),
}, null, 2)}\n`);

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--smoke" || argument === "--electron-run-as-node") {
      values[argument.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = true;
      continue;
    }
    if (argument === "--output" || argument === "--runtime-node") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      values[argument.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown runtime verifier argument: ${argument}.`);
  }
  return values;
}
