import { readFile, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { extractFile } from '@electron/asar'
import {
  RUNTIME_TEMPLATE_DIRECTORY,
  loadRuntimeInputs,
  smokeRuntime,
  verifyBuiltRuntime,
  verifyOnlySelectedRuntimeInstall,
} from './prime-agent-runtime-lib.mjs'
import {
  assertRuntimeAttestationMatches,
  extractEmbeddedRuntimeAttestation,
  parseRuntimeAttestation,
  readElectronRuntimeIdentity,
  readNodeRuntimeIdentity,
} from './runtime-attestation-lib.mjs'
import {
  assertMacosDevelopmentPackageConfiguration,
  assertMacosSystemToolCustody,
  resolveMacosPackageDirectory,
} from './macos-packaging-policy.mjs'
import { assertReviewedBuildResources } from './windows-packaging-policy.mjs'
import {
  assertDistinctExecutableIdentities,
  compareExactDirectoryTrees,
  parseJsonObject,
  readRequiredMacosFuses,
  selectPackagedMetadata,
  sha256,
  smokePackagedMacosApplication,
  verifyAdHocMacosSignature,
  verifyMacosAsarIntegrity,
  verifyPackagedApplicationCode,
} from './macos-package-verification-lib.mjs'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

export async function verifyMacosPackage({
  projectRoot = PROJECT_ROOT,
  packageDirectory = resolveMacosPackageDirectory(projectRoot),
  configOnly = false,
} = {}) {
  const root = resolve(projectRoot)
  const projectPackageBytes = await readFile(join(root, 'package.json'))
  const projectPackage = parseJsonObject(projectPackageBytes, 'The project package manifest')
  const policy = assertMacosDevelopmentPackageConfiguration(projectPackage, { projectRoot: root })
  await Promise.all([
    assertReviewedBuildResources({ projectRoot: root }),
    assertMacosSystemToolCustody(),
  ])
  if (configOnly) return policy
  invariant(process.platform === 'darwin', `Release blocked: macOS package verification cannot run on ${process.platform}.`)

  const packageRoot = resolve(packageDirectory)
  const appPath = join(packageRoot, 'Prime Continuim.app')
  const contentsPath = join(appPath, 'Contents')
  const resourcesPath = join(contentsPath, 'Resources')
  const executablePath = join(contentsPath, 'MacOS', 'Prime Continuim')
  const frameworkPath = join(contentsPath, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework')
  const infoPlistPath = join(contentsPath, 'Info.plist')
  const asarPath = join(resourcesPath, 'app.asar')
  const packagedHostdPath = join(resourcesPath, 'hostd', 'hostd.cjs')
  const packagedHostRuntimeRoot = join(resourcesPath, 'host-runtime')
  const packagedHostNodePath = join(packagedHostRuntimeRoot, 'bin', 'node')
  const packagedHostNodeLicensePath = join(packagedHostRuntimeRoot, 'LICENSE')
  const packagedBrowserRuntimeRoot = join(resourcesPath, 'browser-runtime')
  const packagedBrowserExecutablePath = join(packagedBrowserRuntimeRoot, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  const packagedRuntimeRoot = join(resourcesPath, 'runtime-seed')
  const builtHostdPath = join(root, 'out', 'hostd', 'hostd.cjs')
  const builtMainPath = join(root, 'out', 'main', 'index.js')
  const builtAttestationPath = join(root, 'out', 'main', 'runtime-attestation.json')
  const builtPreloadPath = join(root, 'out', 'preload', 'index.cjs')
  const builtRuntimeRoot = join(root, 'out', 'runtime')
  const builtRendererDirectory = join(root, 'out', 'renderer')
  const sourceHostNodePath = join(root, 'node_modules', 'node', 'bin', 'node')
  const sourceHostNodeLicensePath = join(root, 'node_modules', 'node', 'LICENSE')
  const sourceBrowserRuntimeRoot = join(root, 'node_modules', 'electron', 'dist')
  const sourceBrowserExecutablePath = resolve(require('electron'))

  const [
    asarMetadata,
    packagedHostd,
    builtHostd,
    packagedHostNode,
    sourceHostNode,
    packagedHostNodeLicense,
    sourceHostNodeLicense,
    packagedBrowserExecutable,
    sourceBrowserExecutable,
    frameworkBytes,
    builtMain,
    builtAttestationBytes,
    builtPreload,
  ] = await Promise.all([
    stat(asarPath),
    readFile(packagedHostdPath),
    readFile(builtHostdPath),
    readFile(packagedHostNodePath),
    readFile(sourceHostNodePath),
    readFile(packagedHostNodeLicensePath),
    readFile(sourceHostNodeLicensePath),
    readFile(packagedBrowserExecutablePath),
    readFile(sourceBrowserExecutablePath),
    readFile(frameworkPath),
    readFile(builtMainPath, 'utf8'),
    readFile(builtAttestationPath),
    readFile(builtPreloadPath, 'utf8'),
  ])

  invariant(asarMetadata.isFile() && asarMetadata.size > 0, 'The packaged ASAR is missing or empty.')
  invariant(builtPreload.length > 0, 'The built native preload entry is missing or empty.')
  invariant(builtMain.includes('../preload/index.cjs'), 'The built main process does not request the emitted native preload entry.')
  invariant(!/^\s*import\s/m.test(builtPreload), 'The sandboxed native preload contains unsupported ESM imports.')
  invariant(/require\(["']electron["']\)/.test(builtPreload), 'The sandboxed native preload does not load Electron through CommonJS.')
  invariant(!builtPreload.includes('Downloading Electron binary'), 'The sandboxed preload incorrectly bundles the Electron npm launcher.')

  const asarArtifacts = await verifyPackagedApplicationCode(asarPath, [
    { sourceRoot: join(root, 'out', 'main'), archiveRoot: 'out/main' },
    { sourceRoot: join(root, 'out', 'preload'), archiveRoot: 'out/preload' },
    { sourceRoot: builtRendererDirectory, archiveRoot: 'out/renderer' },
  ])
  const packagedPackage = parseJsonObject(extractFile(asarPath, 'package.json'), 'The packaged application manifest')
  invariant(
    isDeepStrictEqual(packagedPackage, selectPackagedMetadata(projectPackage)),
    'The packaged application manifest does not match this project release metadata and dependency set.',
  )
  const packagedAttestationBytes = extractFile(asarPath, join('out', 'main', 'runtime-attestation.json'))
  invariant(packagedAttestationBytes.equals(builtAttestationBytes), 'The packaged ASAR attestation does not match this release build.')
  const attestation = parseRuntimeAttestation(builtAttestationBytes)

  const fuses = readRequiredMacosFuses(frameworkBytes)
  const asarIntegrity = await verifyMacosAsarIntegrity({ asarPath, infoPlistPath })
  const codeSignature = await verifyAdHocMacosSignature(appPath)
  invariant(packagedHostd.equals(builtHostd), 'The packaged host daemon does not match the host daemon built in this run.')
  invariant(packagedHostNode.equals(sourceHostNode), 'The packaged host Node executable does not match the pinned runtime bytes.')
  invariant(packagedHostNodeLicense.equals(sourceHostNodeLicense), 'The packaged host Node license does not match the pinned distribution.')
  invariant(packagedBrowserExecutable.equals(sourceBrowserExecutable), 'The packaged browser Electron executable does not match the exact build runtime bytes.')
  await verifyHostRuntimeShape(packagedHostRuntimeRoot)
  const browserRuntime = await compareExactDirectoryTrees(
    sourceBrowserRuntimeRoot,
    packagedBrowserRuntimeRoot,
    'The packaged browser Electron runtime',
  )
  const executableIdentities = await assertDistinctExecutableIdentities([
    { label: 'desktop Electron', path: executablePath },
    { label: 'host Node', path: packagedHostNodePath },
    { label: 'browser Electron', path: packagedBrowserExecutablePath },
  ])

  const embeddedHostdAttestation = extractEmbeddedRuntimeAttestation(packagedHostd)
  invariant(embeddedHostdAttestation.equals(builtAttestationBytes), 'The host daemon and ASAR do not carry the same runtime attestation.')

  const inputs = await loadRuntimeInputs(RUNTIME_TEMPLATE_DIRECTORY)
  await assertRuntimeSeedTopLevel(packagedRuntimeRoot)
  const [builtPointerText, packagedPointerText] = await Promise.all([
    readFile(join(builtRuntimeRoot, 'current.json'), 'utf8'),
    readFile(join(packagedRuntimeRoot, 'current.json'), 'utf8'),
  ])
  invariant(packagedPointerText === builtPointerText, 'The packaged runtime pointer does not match the runtime built in this run.')
  const builtPointer = parseJsonObject(Buffer.from(builtPointerText), 'The built runtime pointer')
  const runtimePointer = parseJsonObject(Buffer.from(packagedPointerText), 'The packaged runtime pointer')
  validateRuntimePointer(builtPointer, inputs, 'Built')
  validateRuntimePointer(runtimePointer, inputs, 'Packaged')
  const builtRuntimeManifestPath = resolveRuntimeManifestPath(builtRuntimeRoot, builtPointer, 'Built')
  const runtimeManifestPath = resolveRuntimeManifestPath(packagedRuntimeRoot, runtimePointer, 'Packaged')
  await Promise.all([
    verifyOnlySelectedRuntimeInstall(builtRuntimeRoot, dirname(builtRuntimeManifestPath)),
    verifyOnlySelectedRuntimeInstall(packagedRuntimeRoot, dirname(runtimeManifestPath)),
  ])
  const [builtRuntimeManifest, packagedRuntimeManifest, builtFileManifest, packagedFileManifest] = await Promise.all([
    readFile(builtRuntimeManifestPath),
    readFile(runtimeManifestPath),
    readFile(join(dirname(builtRuntimeManifestPath), 'files.sha256')),
    readFile(join(dirname(runtimeManifestPath), 'files.sha256')),
  ])
  invariant(packagedRuntimeManifest.equals(builtRuntimeManifest), 'The packaged runtime manifest does not match this run.')
  invariant(packagedFileManifest.equals(builtFileManifest), 'The packaged runtime file manifest does not match this run.')
  invariant(sha256(packagedRuntimeManifest) === runtimePointer.manifestSha256, 'The packaged runtime manifest digest is stale.')
  const packagedRuntime = await verifyBuiltRuntime(dirname(runtimeManifestPath), { inputs, policy: inputs.policy })
  invariant(packagedRuntime.manifest.tree.sha256 === runtimePointer.treeSha256, 'The packaged runtime pointer tree digest is stale.')

  const runtimeSmoke = await smokeRuntime(packagedRuntime.root, {
    runtimeExecutable: packagedHostNodePath,
    electronRunAsNode: false,
    policy: inputs.policy,
  })
  const [guiRuntime, hostRuntime] = await Promise.all([
    readElectronRuntimeIdentity(packagedBrowserExecutablePath),
    readNodeRuntimeIdentity(packagedHostNodePath),
  ])
  assertRuntimeAttestationMatches(attestation, {
    pointer: runtimePointer,
    manifest: packagedRuntime.manifest,
    manifestBytes: packagedRuntimeManifest,
    fileManifestBytes: packagedFileManifest,
    guiRuntime,
    hostRuntime,
    inputs,
  })

  await assertNoHostRuntimeFingerprints({ builtMain, builtPreload, builtHostd, builtRendererDirectory })
  const applicationSmoke = await smokePackagedMacosApplication(executablePath, packageRoot, packagedHostdPath)

  return Object.freeze({
    packageDirectory: packageRoot,
    appPath,
    codeSignature,
    fuses: Object.freeze({
      ...fuses,
      runAsNode: false,
      embeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    }),
    asarIntegrity,
    asarBytes: asarMetadata.size,
    asarVerifiedFiles: asarArtifacts.fileCount,
    hostdSha256: sha256(packagedHostd),
    browserRuntime,
    executables: executableIdentities,
    runtime: Object.freeze({
      releaseVersion: packagedRuntime.manifest.release.version,
      treeSha256: packagedRuntime.manifest.tree.sha256,
      files: packagedRuntime.manifest.tree.fileCount,
      bytes: packagedRuntime.manifest.tree.totalBytes,
      hostNode: runtimeSmoke.runtimeVersions.node,
    }),
    applicationSmoke,
  })
}

async function verifyHostRuntimeShape(root) {
  const top = await readdir(root, { withFileTypes: true })
  top.sort((left, right) => left.name.localeCompare(right.name, 'en-US'))
  invariant(top.length === 2 && top[0]?.name === 'bin' && top[0].isDirectory() && top[1]?.name === 'LICENSE' && top[1].isFile(), 'The packaged host runtime contains unexpected top-level entries.')
  const bin = await readdir(join(root, 'bin'), { withFileTypes: true })
  invariant(bin.length === 1 && bin[0]?.name === 'node' && bin[0].isFile(), 'The packaged host runtime bin directory is not exact.')
}

async function assertRuntimeSeedTopLevel(root) {
  const entries = await readdir(root, { withFileTypes: true })
  invariant(
    entries.length === 2 &&
      entries.some((entry) => entry.name === 'current.json' && entry.isFile() && !entry.isSymbolicLink()) &&
      entries.some((entry) => entry.name === 'installs' && entry.isDirectory() && !entry.isSymbolicLink()),
    'The packaged runtime seed contains unexpected top-level entries.',
  )
}

function validateRuntimePointer(pointer, inputs, label) {
  invariant(pointer.schemaVersion === 1, `${label} runtime pointer is invalid.`)
  invariant(pointer.releaseVersion === inputs.policy.releaseVersion, `${label} runtime release is not pinned.`)
  invariant(pointer.platform === process.platform && pointer.arch === process.arch, `${label} runtime target is incompatible.`)
  invariant(typeof pointer.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(pointer.manifestSha256), `${label} runtime manifest digest is invalid.`)
  invariant(typeof pointer.treeSha256 === 'string' && /^[a-f0-9]{64}$/.test(pointer.treeSha256), `${label} runtime tree digest is invalid.`)
  invariant(
    typeof pointer.runtimeManifest === 'string' &&
      !pointer.runtimeManifest.includes('\\') &&
      pointer.runtimeManifest.split('/').every((segment) => segment && segment !== '.' && segment !== '..') &&
      pointer.runtimeManifest.endsWith('/runtime.json'),
    `${label} runtime pointer path is unsafe.`,
  )
}

function resolveRuntimeManifestPath(root, pointer, label) {
  const manifestPath = resolve(root, ...pointer.runtimeManifest.split('/'))
  const relation = relative(root, manifestPath)
  invariant(relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation), `${label} runtime pointer escapes its root.`)
  return manifestPath
}

async function assertNoHostRuntimeFingerprints({ builtMain, builtPreload, builtHostd, builtRendererDirectory }) {
  const rendererText = await readTextArtifacts(builtRendererDirectory)
  for (const fingerprint of ['node_modules/prime-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-tui', 'node_modules/zeromq']) {
    invariant(!rendererText.includes(fingerprint), `The renderer bundle contains host-only runtime code: ${fingerprint}.`)
    invariant(!builtMain.includes(fingerprint), `The Electron main bundle contains host-only runtime code: ${fingerprint}.`)
    invariant(!builtPreload.includes(fingerprint), `The preload bundle contains host-only runtime code: ${fingerprint}.`)
  }
  const hostdText = builtHostd.toString('utf8')
  for (const fingerprint of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-tui']) {
    invariant(!hostdText.includes(fingerprint), `The hostd bundle statically embeds upstream runtime code: ${fingerprint}.`)
  }
}

async function readTextArtifacts(root) {
  let result = ''
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && /\.(?:css|html|js|json|map)$/i.test(entry.name)) result += await readFile(path, 'utf8')
      else if (!entry.isFile()) throw new Error(`Built renderer output contains a non-regular entry: ${path}.`)
    }
  }
  await visit(root)
  return result
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const configOnly = process.argv.length === 3 && process.argv[2] === '--config-only'
  if (process.argv.length > (configOnly ? 3 : 2)) {
    console.error('Usage: node scripts/verify-macos-package.mjs [--config-only]')
    process.exitCode = 1
  } else {
    verifyMacosPackage({ configOnly }).then((result) => {
      console.log(JSON.stringify(result, null, 2))
    }).catch((error) => {
      console.error(formatVerificationError(error))
      process.exitCode = 1
    })
  }
}

function formatVerificationError(error, depth = 0) {
  if (depth > 4) return 'nested verification error omitted'
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map((child) => `- ${formatVerificationError(child, depth + 1)}`)].join('\n')
  }
  if (!(error instanceof Error)) return String(error)
  const details = []
  for (const field of ['stdout', 'stderr']) {
    const value = error[field]
    if (typeof value === 'string' && value.trim()) details.push(value.trim().slice(-16 * 1024))
  }
  return [error.message, ...details].join('\n')
}
