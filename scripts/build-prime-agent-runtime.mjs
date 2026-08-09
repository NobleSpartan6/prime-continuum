import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  REPO_ROOT,
  RUNTIME_TEMPLATE_DIRECTORY,
  acquireBuildLock,
  createRuntimeManifest,
  discoverNpmCli,
  installLockedRuntime,
  loadRuntimeInputs,
  pruneEmptyRuntimeDirectories,
  pruneRuntimePackagingNoise,
  pruneRuntimeForTarget,
  removeLegacyRuntimeAssetCache,
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
// Download caches are build inputs, not part of the exact runtime seed
// namespace. Keeping them beside the seed prevents both development and
// packaged verification from silently accepting unrelated bytes.
const assetCacheDirectory = join(dirname(outputRoot), `${basename(outputRoot)}-cache`, "assets");
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
  await verifyReleaseAssets(inputs, assetCacheDirectory);
  const reviewedAssetNames = inputs.sources.assets.map((asset) => `${asset.sha256}-${asset.fileName}`);
  await removeLegacyRuntimeAssetCache(
    outputRoot,
    reviewedAssetNames,
  );
  const npmVersion = await installLockedRuntime({ inputs, stagingDirectory, npmCli });
  await pruneRuntimePackagingNoise(stagingDirectory, inputs.policy);
  await pruneRuntimeForTarget(stagingDirectory);
  await pruneEmptyRuntimeDirectories(stagingDirectory);
  const smoke = await smokeRuntime(stagingDirectory, {
    runtimeExecutable,
    electronRunAsNode: argumentsValue.electronRunAsNode,
    policy: inputs.policy,
  });
  const manifest = await createRuntimeManifest({
    runtimeDirectory: stagingDirectory,
    inputs,
    npmVersion,
    smoke,
  });
  await verifyBuiltRuntime(stagingDirectory, { inputs, policy: inputs.policy });
  const manifestSha256 = await sha256File(join(stagingDirectory, "runtime.json"));

  const finalName = `prime-agent-${inputs.policy.releaseVersion}-${process.platform}-${process.arch}-${manifest.tree.sha256.slice(0, 16)}-${manifestSha256.slice(0, 16)}`;
  const installsDirectory = join(outputRoot, "installs");
  const finalDirectory = join(installsDirectory, finalName);
  await mkdir(installsDirectory, { recursive: true });
  try {
    await realpath(finalDirectory);
    // Older generated images may have unattested package-manager namespace
    // directories. Removing only directories that are still empty preserves
    // every attested byte and lets the content-addressed image converge.
    await pruneEmptyRuntimeDirectories(finalDirectory);
    await verifyBuiltRuntime(finalDirectory, { inputs, policy: inputs.policy });
    if ((await sha256File(join(finalDirectory, "runtime.json"))) !== manifestSha256) {
      throw new Error("Existing runtime payload has different attestation metadata.");
    }
    await rm(stagingDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await rename(stagingDirectory, finalDirectory);
  }
  await writeCurrentPointer(outputRoot, finalDirectory, manifest, manifestSha256);
  await removeObsoleteRuntimeInstalls(outputRoot, finalDirectory);
  await verifyOnlySelectedRuntimeInstall(outputRoot, finalDirectory);
  process.stdout.write(`${JSON.stringify({ finalDirectory, treeSha256: manifest.tree.sha256, manifestSha256 }, null, 2)}\n`);
} catch (error) {
  await rm(stagingDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  }).catch(() => undefined);
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
