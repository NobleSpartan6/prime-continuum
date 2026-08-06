import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  REPO_ROOT,
  RUNTIME_TEMPLATE_DIRECTORY,
  acquireBuildLock,
  createRuntimeManifest,
  discoverNpmCli,
  installLockedRuntime,
  loadRuntimeInputs,
  pruneRuntimePackagingNoise,
  pruneRuntimeForTarget,
  removeObsoleteRuntimeInstalls,
  smokeRuntime,
  sha256File,
  verifyBuiltRuntime,
  verifyOnlySelectedRuntimeInstall,
  verifyReleaseAssets,
  writeCurrentPointer,
} from "./prime-agent-runtime-lib.mjs";

const argumentsValue = parseArguments(process.argv.slice(2));
const outputRoot = resolve(argumentsValue.output ?? join(REPO_ROOT, "out", "runtime"));
const runtimeExecutable = argumentsValue.runtimeNode
  ? resolve(argumentsValue.runtimeNode)
  : process.execPath;
if (!isAbsolute(outputRoot) || !isAbsolute(runtimeExecutable)) throw new Error("Runtime paths must be absolute.");

const inputs = await loadRuntimeInputs(RUNTIME_TEMPLATE_DIRECTORY);
const release = await acquireBuildLock(outputRoot);
const stagingDirectory = join(
  outputRoot,
  `.prime-agent-${inputs.policy.releaseVersion}-${process.platform}-${process.arch}.staging-${randomUUID()}`,
);

try {
  const npmCli = await discoverNpmCli(argumentsValue.npmCli);
  await verifyReleaseAssets(inputs, join(outputRoot, "cache", "assets"));
  const npmVersion = await installLockedRuntime({ inputs, stagingDirectory, npmCli });
  await pruneRuntimePackagingNoise(stagingDirectory, inputs.policy);
  await pruneRuntimeForTarget(stagingDirectory);
  const smoke = await smokeRuntime(stagingDirectory, {
    runtimeExecutable,
    electronRunAsNode: argumentsValue.electronRunAsNode,
    policy: inputs.policy,
  });
  const manifest = await createRuntimeManifest({ runtimeDirectory: stagingDirectory, inputs, npmVersion, smoke });
  await verifyBuiltRuntime(stagingDirectory, { inputs, policy: inputs.policy });
  const manifestSha256 = await sha256File(join(stagingDirectory, "runtime.json"));

  const finalName = `prime-agent-${inputs.policy.releaseVersion}-${process.platform}-${process.arch}-${manifest.tree.sha256.slice(0, 16)}-${manifestSha256.slice(0, 16)}`;
  const installsDirectory = join(outputRoot, "installs");
  const finalDirectory = join(installsDirectory, finalName);
  await mkdir(installsDirectory, { recursive: true });
  try {
    await realpath(finalDirectory);
    await verifyBuiltRuntime(finalDirectory, { inputs, policy: inputs.policy });
    if ((await sha256File(join(finalDirectory, "runtime.json"))) !== manifestSha256) {
      throw new Error("Existing runtime payload has different attestation metadata.");
    }
    await rm(stagingDirectory, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await rename(stagingDirectory, finalDirectory);
  }
  await writeCurrentPointer(outputRoot, finalDirectory, manifest, manifestSha256);
  await removeObsoleteRuntimeInstalls(outputRoot, finalDirectory);
  await verifyOnlySelectedRuntimeInstall(outputRoot, finalDirectory);
  process.stdout.write(`${JSON.stringify({ finalDirectory, treeSha256: manifest.tree.sha256, manifestSha256 }, null, 2)}\n`);
} catch (error) {
  await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  throw error;
} finally {
  await release();
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--electron-run-as-node") {
      values.electronRunAsNode = true;
      continue;
    }
    if (argument === "--output" || argument === "--npm-cli" || argument === "--runtime-node") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      values[argument.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown runtime builder argument: ${argument}.`);
  }
  return values;
}
