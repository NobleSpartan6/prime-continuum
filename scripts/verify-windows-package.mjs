import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify, isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'
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
} from './runtime-attestation-lib.mjs'
import { createPrimeAgentSmokeCustody } from './prime-agent-smoke-custody-lib.mjs'

const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii')
const FUSE_ENABLED = '1'.charCodeAt(0)
const PACKAGE_SMOKE_MARKER = 'PRIME_CONTINUIM_PACKAGE_SMOKE_OK'
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function readPeMaximumRawEnd(executable) {
  invariant(executable.length >= 64, 'The packaged executable is too small to contain a PE header.')
  invariant(executable.subarray(0, 2).toString('ascii') === 'MZ', 'The packaged executable has no DOS header.')

  const peOffset = executable.readUInt32LE(0x3c)
  invariant(peOffset + 24 <= executable.length, 'The packaged executable has a truncated PE header.')
  invariant(executable.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0])), 'The packaged executable has no PE signature.')

  const sectionCount = executable.readUInt16LE(peOffset + 6)
  const optionalHeaderSize = executable.readUInt16LE(peOffset + 20)
  const sectionTableOffset = peOffset + 24 + optionalHeaderSize
  const sectionTableEnd = sectionTableOffset + sectionCount * 40
  invariant(sectionCount > 0 && sectionTableEnd <= executable.length, 'The packaged executable has a truncated section table.')

  let maximumRawEnd = 0
  for (let index = 0; index < sectionCount; index += 1) {
    const sectionOffset = sectionTableOffset + index * 40
    const rawSize = executable.readUInt32LE(sectionOffset + 16)
    const rawPointer = executable.readUInt32LE(sectionOffset + 20)
    maximumRawEnd = Math.max(maximumRawEnd, rawPointer + rawSize)
  }

  return maximumRawEnd
}

function readRequiredFuses(executable) {
  const sentinelOffset = executable.indexOf(FUSE_SENTINEL)
  invariant(sentinelOffset >= 0, 'The Electron fuse sentinel is missing from the packaged executable.')
  invariant(executable.indexOf(FUSE_SENTINEL, sentinelOffset + 1) < 0, 'The packaged executable contains more than one Electron fuse sentinel.')

  const wireOffset = sentinelOffset + FUSE_SENTINEL.length
  invariant(wireOffset + 2 <= executable.length, 'The Electron fuse header is truncated.')
  const version = executable[wireOffset]
  const wireLength = executable[wireOffset + 1]
  invariant(version === 1, `Unsupported Electron fuse wire version: ${version}.`)
  invariant(wireLength >= 6 && wireOffset + 2 + wireLength <= executable.length, 'The Electron fuse wire is truncated.')

  const wire = executable.subarray(wireOffset + 2, wireOffset + 2 + wireLength)
  invariant(wire[0] === FUSE_ENABLED, 'RunAsNode must remain enabled for the external packaged host daemon launcher.')
  invariant(wire[4] === FUSE_ENABLED, 'EnableEmbeddedAsarIntegrityValidation is not enabled in the packaged executable.')
  invariant(wire[5] === FUSE_ENABLED, 'OnlyLoadAppFromAsar is not enabled in the packaged executable.')

  return { version, wireLength }
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex').toUpperCase()
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error(`Release blocked: packaged runtime verification is not implemented for ${process.platform}.`)
  }

  const packageDirectory = resolve(process.argv[2] ?? 'release/win-unpacked')
  const executablePath = resolve(packageDirectory, 'Prime Continuim.exe')
  const packagedHostdPath = resolve(packageDirectory, 'resources/hostd/hostd.cjs')
  const asarPath = resolve(packageDirectory, 'resources/app.asar')
  const builtHostdPath = resolve('out/hostd/hostd.cjs')
  const builtHostdProvenancePath = resolve('out/hostd/hostd-build-provenance.json')
  const builtMainPath = resolve('out/main/index.js')
  const builtAttestationPath = resolve('out/main/runtime-attestation.json')
  const builtPreloadPath = resolve('out/preload/index.cjs')
  const builtRuntimeRoot = resolve('out/runtime')
  const packagedRuntimeRoot = resolve(packageDirectory, 'resources/runtime-seed')
  const builtRendererDirectory = resolve('out/renderer')

  const [executable, packagedHostd, builtHostd, builtHostdProvenanceBytes, builtMain, builtAttestationBytes, builtPreload, asarMetadata, projectPackageBytes] = await Promise.all([
    readFile(executablePath),
    readFile(packagedHostdPath),
    readFile(builtHostdPath),
    readFile(builtHostdProvenancePath),
    readFile(builtMainPath, 'utf8'),
    readFile(builtAttestationPath),
    readFile(builtPreloadPath, 'utf8'),
    stat(asarPath),
    readFile(resolve('package.json')),
  ])

  const maximumRawEnd = readPeMaximumRawEnd(executable)
  invariant(executable.length >= maximumRawEnd, `The packaged executable is truncated: ${executable.length} bytes for PE sections ending at ${maximumRawEnd}.`)
  invariant(asarMetadata.isFile() && asarMetadata.size > 0, 'The packaged ASAR is missing or empty.')
  invariant(builtPreload.length > 0, 'The built native preload entry is missing or empty.')
  invariant(builtMain.includes('../preload/index.cjs'), 'The built main process does not request the emitted native preload entry.')
  invariant(!/^\s*import\s/m.test(builtPreload), 'The sandboxed native preload contains unsupported ESM imports.')
  invariant(/require\(["']electron["']\)/.test(builtPreload), 'The sandboxed native preload does not load Electron through its runtime CommonJS API.')
  invariant(!builtPreload.includes('Downloading Electron binary'), 'The sandboxed native preload incorrectly bundles the Electron npm launcher.')
  const asarArtifacts = await verifyPackagedApplicationCode(asarPath, [
    { sourceRoot: resolve('out/main'), archiveRoot: 'out/main' },
    { sourceRoot: resolve('out/preload'), archiveRoot: 'out/preload' },
    { sourceRoot: resolve('out/renderer'), archiveRoot: 'out/renderer' },
  ])
  const projectPackage = parseJsonObject(projectPackageBytes, 'The project package manifest')
  const packagedPackage = parseJsonObject(extractFile(asarPath, 'package.json'), 'The packaged application manifest')
  const expectedPackagedPackage = selectPackagedMetadata(projectPackage)
  invariant(
    isDeepStrictEqual(packagedPackage, expectedPackagedPackage),
    'The packaged application manifest does not match this project release metadata and dependency set.',
  )
  const packagedAttestationBytes = extractFile(asarPath, join('out', 'main', 'runtime-attestation.json'))
  invariant(
    packagedAttestationBytes.equals(builtAttestationBytes),
    'The packaged ASAR runtime attestation does not match this release build.',
  )
  const attestation = parseRuntimeAttestation(builtAttestationBytes)

  const fuses = readRequiredFuses(executable)
  const windowsVersionInfo = await readWindowsVersionInfo(executablePath)
  verifyWindowsVersionInfo(windowsVersionInfo, projectPackage)
  const windowsAuthenticode = await readWindowsAuthenticodeStatus(executablePath)
  invariant(windowsAuthenticode.Status === 'NotSigned', `The development application package must be unsigned, but Authenticode reported ${windowsAuthenticode.Status}.`)
  const builtHostdHash = sha256(builtHostd)
  const packagedHostdHash = sha256(packagedHostd)
  invariant(packagedHostdHash === builtHostdHash, 'The packaged host daemon does not match the host daemon built in this run.')
  const hostdProvenance = parseHostdBuildProvenance(builtHostdProvenanceBytes)
  invariant(
    hostdProvenance.bundleSha256.toUpperCase() === builtHostdHash,
    'The host daemon build provenance does not bind this exact bundle.',
  )
  for (const input of hostdProvenance.inputs) {
    const normalized = input.replaceAll('\\', '/').toLowerCase()
    invariant(
      !normalized.includes('/node_modules/prime-agent/') &&
        !normalized.startsWith('node_modules/prime-agent/') &&
        !normalized.includes('/out/runtime/') &&
        !normalized.startsWith('out/runtime/'),
      `The host daemon input graph includes the isolated Prime Agent runtime: ${input}.`,
    )
  }
  const builtHostdAttestation = extractEmbeddedRuntimeAttestation(builtHostd)
  const packagedHostdAttestation = extractEmbeddedRuntimeAttestation(packagedHostd)
  invariant(
    builtHostdAttestation.equals(builtAttestationBytes) && packagedHostdAttestation.equals(builtAttestationBytes),
    'The host daemon and ASAR do not carry the same runtime attestation.',
  )

  const inputs = await loadRuntimeInputs(RUNTIME_TEMPLATE_DIRECTORY)
  const seedEntries = await readdir(packagedRuntimeRoot, { withFileTypes: true })
  invariant(
    seedEntries.length === 2 &&
      seedEntries.some((entry) => entry.name === 'current.json' && entry.isFile() && !entry.isSymbolicLink()) &&
      seedEntries.some((entry) => entry.name === 'installs' && entry.isDirectory() && !entry.isSymbolicLink()),
    'The packaged runtime seed contains unexpected top-level entries.',
  )
  const [builtPointerText, packagedPointerText] = await Promise.all([
    readFile(join(builtRuntimeRoot, 'current.json'), 'utf8'),
    readFile(join(packagedRuntimeRoot, 'current.json'), 'utf8'),
  ])
  invariant(packagedPointerText === builtPointerText, 'The packaged runtime pointer does not match the runtime built in this run.')
  const builtPointer = JSON.parse(builtPointerText)
  const runtimePointer = JSON.parse(packagedPointerText)
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
  invariant(
    packagedRuntimeManifest.equals(builtRuntimeManifest),
    'The packaged runtime manifest does not match the runtime built in this run.',
  )
  invariant(
    packagedFileManifest.equals(builtFileManifest),
    'The packaged runtime file manifest does not match the runtime built in this run.',
  )
  invariant(
    sha256(packagedRuntimeManifest).toLowerCase() === runtimePointer.manifestSha256,
    'The packaged runtime manifest digest does not match its pointer.',
  )
  const packagedRuntime = await verifyBuiltRuntime(dirname(runtimeManifestPath), { inputs, policy: inputs.policy })
  invariant(
    packagedRuntime.manifest.tree.sha256 === JSON.parse(builtRuntimeManifest.toString('utf8')).tree?.sha256,
    'The packaged runtime tree does not match the attested runtime built in this run.',
  )
  invariant(packagedRuntime.manifest.tree.sha256 === runtimePointer.treeSha256, 'The packaged runtime pointer digest is stale.')
  const runtimeSmoke = await smokeRuntime(packagedRuntime.root, {
    runtimeExecutable: executablePath,
    electronRunAsNode: true,
    policy: inputs.policy,
  })
  const applicationSmoke = await smokePackagedApplication(executablePath, packageDirectory, packagedHostdPath)
  assertRuntimeAttestationMatches(attestation, {
    pointer: runtimePointer,
    manifest: packagedRuntime.manifest,
    manifestBytes: packagedRuntimeManifest,
    fileManifestBytes: packagedFileManifest,
    runtimeVersions: runtimeSmoke.runtimeVersions,
    inputs,
  })

  const rendererText = await readTextArtifacts(builtRendererDirectory)
  for (const fingerprint of [
    'node_modules/prime-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-tui',
    'node_modules/zeromq',
  ]) {
    invariant(!rendererText.includes(fingerprint), `The renderer bundle contains host-only runtime code: ${fingerprint}.`)
    invariant(!builtMain.includes(fingerprint), `The Electron main bundle contains host-only runtime code: ${fingerprint}.`)
    invariant(!builtPreload.includes(fingerprint), `The preload bundle contains host-only runtime code: ${fingerprint}.`)
  }
  for (const fingerprint of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-tui']) {
    invariant(!builtHostd.toString('utf8').includes(fingerprint), `The hostd bundle statically embeds upstream runtime code: ${fingerprint}.`)
  }

  console.log(JSON.stringify({
    packageDirectory,
    executableBytes: executable.length,
    maximumPeRawEnd: maximumRawEnd,
    fuses: {
      version: fuses.version,
      wireLength: fuses.wireLength,
      runAsNode: true,
      embeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    },
    windowsVersionInfo,
    windowsAuthenticode,
    applicationSmoke,
    asarBytes: asarMetadata.size,
    asarVerifiedFiles: asarArtifacts.fileCount,
    preloadEntry: 'out/preload/index.cjs',
    hostdSha256: packagedHostdHash,
    runtimeAttestation: {
      assurance: attestation.assurance,
      bytes: builtAttestationBytes.byteLength,
      embeddedInAsar: true,
      embeddedInHostd: true,
    },
    runtime: {
      releaseVersion: packagedRuntime.manifest.release.version,
      treeSha256: packagedRuntime.manifest.tree.sha256,
      files: packagedRuntime.manifest.tree.fileCount,
      bytes: packagedRuntime.manifest.tree.totalBytes,
      electron: runtimeSmoke.runtimeVersions.electron,
      electronNode: runtimeSmoke.runtimeVersions.node,
      electronModulesAbi: runtimeSmoke.runtimeVersions.modules,
      electronNapi: runtimeSmoke.runtimeVersions.napi,
    },
  }, null, 2))
}

export function parseHostdBuildProvenance(bytes) {
  invariant(bytes.length > 0 && bytes.length <= 4 * 1024 * 1024, 'The host daemon build provenance is empty or oversized.')
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error('The host daemon build provenance is not valid JSON.', { cause: error })
  }
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'The host daemon build provenance is not an object.')
  invariant(value.schemaVersion === 1, 'The host daemon build provenance schema is unsupported.')
  invariant(typeof value.bundleSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.bundleSha256), 'The host daemon build provenance digest is invalid.')
  invariant(Array.isArray(value.inputs) && value.inputs.length > 0 && value.inputs.length <= 10000, 'The host daemon build provenance input graph is invalid.')
  invariant(
    value.inputs.every((input) => typeof input === 'string' && input.length > 0 && input.length <= 4096 && !/[\0\r\n]/.test(input)),
    'The host daemon build provenance contains an invalid input path.',
  )
  invariant(new Set(value.inputs).size === value.inputs.length, 'The host daemon build provenance contains duplicate inputs.')
  invariant(
    value.inputs.includes('scripts/windows-job-supervisor.ps1'),
    'The host daemon build provenance does not bind the Windows Job Object supervisor input.',
  )
  return value
}

async function verifyPackagedApplicationCode(asarPath, roots) {
  const archiveEntries = new Set(
    listPackage(asarPath, { isPack: false }).map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, '')),
  )
  invariant(
    ![...archiveEntries].some((entry) => entry === 'out/runtime' || entry.startsWith('out/runtime/')),
    'The Prime Agent runtime was duplicated inside app.asar.',
  )
  invariant(
    ![...archiveEntries].some((entry) => entry === 'out/runtime-cache' || entry.startsWith('out/runtime-cache/')),
    'Prime Agent release-asset caches were duplicated inside app.asar.',
  )
  invariant(
    ![...archiveEntries].some((entry) => entry === 'out/hostd' || entry.startsWith('out/hostd/')),
    'The external host daemon was duplicated inside app.asar.',
  )
  invariant(
    [...archiveEntries]
      .filter((entry) => entry === 'out' || entry.startsWith('out/'))
      .every(
        (entry) =>
          entry === 'out' || roots.some(({ archiveRoot }) => entry === archiveRoot || entry.startsWith(`${archiveRoot}/`)),
      ),
    'The packaged ASAR contains an unexpected build-output subtree.',
  )

  const expectedEntries = new Set()
  const expectedFiles = []
  for (const root of roots) {
    expectedEntries.add(root.archiveRoot)
    await visit(root.sourceRoot, root.archiveRoot)
  }

  async function visit(directory, archiveDirectory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'))
    for (const entry of entries) {
      const sourcePath = join(directory, entry.name)
      const archivePath = `${archiveDirectory}/${entry.name}`
      expectedEntries.add(archivePath)
      if (entry.isDirectory()) {
        await visit(sourcePath, archivePath)
      } else if (entry.isFile()) {
        expectedFiles.push({ sourcePath, archivePath })
      } else {
        throw new Error(`Built application output contains a non-regular entry: ${sourcePath}.`)
      }
    }
  }

  const selectedArchiveEntries = [...archiveEntries].filter((entry) =>
    roots.some(({ archiveRoot }) => entry === archiveRoot || entry.startsWith(`${archiveRoot}/`)),
  )
  invariant(
    selectedArchiveEntries.length === expectedEntries.size &&
      selectedArchiveEntries.every((entry) => expectedEntries.has(entry)),
    'The packaged app.asar application entries do not match this build output.',
  )
  for (const file of expectedFiles) {
    const packaged = extractFile(asarPath, join(...file.archivePath.split('/')))
    const built = await readFile(file.sourcePath)
    invariant(packaged.equals(built), `Packaged app.asar file differs from this build: ${file.archivePath}.`)
  }
  return { fileCount: expectedFiles.length }
}

function parseJsonObject(bytes, label) {
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error })
  }
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${label} is not an object.`)
  return value
}

function selectPackagedMetadata(projectPackage) {
  const fields = [
    'name',
    'version',
    'private',
    'author',
    'description',
    'main',
    'type',
    'packageManager',
    'engines',
    'devEngines',
    'dependencies',
  ]
  const selected = {}
  for (const field of fields) {
    invariant(Object.hasOwn(projectPackage, field), `The project package manifest is missing ${field}.`)
    selected[field] = projectPackage[field]
  }
  return selected
}

async function readWindowsVersionInfo(executablePath) {
  const systemRoot = process.env.SystemRoot
  invariant(typeof systemRoot === 'string' && isAbsolute(systemRoot), 'SystemRoot is required to inspect Windows executable metadata.')
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const command = [
    '$value = (Get-Item -LiteralPath $env:PRIME_CONTINUIM_VERIFY_EXECUTABLE).VersionInfo',
    '[ordered]@{ ProductName = $value.ProductName; FileDescription = $value.FileDescription; FileVersion = $value.FileVersion; ProductVersion = $value.ProductVersion; OriginalFilename = $value.OriginalFilename; CompanyName = $value.CompanyName } | ConvertTo-Json -Compress',
  ].join('; ')
  const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, PRIME_CONTINUIM_VERIFY_EXECUTABLE: executablePath },
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  })
  const value = parseJsonObject(Buffer.from(stdout, 'utf8'), 'The Windows executable version metadata')
  for (const field of ['ProductName', 'FileDescription', 'FileVersion', 'ProductVersion', 'OriginalFilename', 'CompanyName']) {
    invariant(typeof value[field] === 'string' && value[field].length <= 1024, `The Windows executable ${field} value is invalid.`)
  }
  return value
}

async function readWindowsAuthenticodeStatus(executablePath) {
  const systemRoot = process.env.SystemRoot
  invariant(typeof systemRoot === 'string' && isAbsolute(systemRoot), 'SystemRoot is required to inspect Windows Authenticode status.')
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const securityModule = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')
  const command = [
    "$ErrorActionPreference = 'Stop'",
    'Import-Module -Name $env:PRIME_CONTINUIM_SECURITY_MODULE -Force',
    '$value = Get-AuthenticodeSignature -LiteralPath $env:PRIME_CONTINUIM_VERIFY_EXECUTABLE -ErrorAction Stop',
    '[ordered]@{ Status = [string]$value.Status; SignerSubject = if ($null -eq $value.SignerCertificate) { "" } else { [string]$value.SignerCertificate.Subject } } | ConvertTo-Json -Compress',
  ].join('; ')
  const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, PRIME_CONTINUIM_SECURITY_MODULE: securityModule, PRIME_CONTINUIM_VERIFY_EXECUTABLE: executablePath },
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  })
  const value = parseJsonObject(Buffer.from(stdout, 'utf8'), 'The Windows Authenticode result')
  invariant(typeof value.Status === 'string' && value.Status.length > 0 && value.Status.length <= 128, 'The Windows Authenticode status is invalid.')
  invariant(typeof value.SignerSubject === 'string' && value.SignerSubject.length <= 4096, 'The Windows Authenticode signer subject is invalid.')
  return value
}

function verifyWindowsVersionInfo(value, projectPackage) {
  const productName = projectPackage.build?.productName
  const version = projectPackage.version
  const author = projectPackage.author
  invariant(typeof productName === 'string' && productName.length > 0, 'The configured Windows product name is invalid.')
  invariant(typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version), 'The configured application version is invalid.')
  invariant(typeof author === 'string' && author.length > 0, 'The configured application author is invalid.')
  const productVersion = `${version}.0`
  invariant(value.ProductName === productName, 'Windows ProductName was not edited for Prime Continuim.')
  invariant(value.FileDescription === productName, 'Windows FileDescription was not edited for Prime Continuim.')
  invariant(value.FileVersion === version, 'Windows FileVersion does not match this release.')
  invariant(value.ProductVersion === productVersion, 'Windows ProductVersion does not match this release.')
  invariant(value.CompanyName === author, 'Windows CompanyName does not match this release.')
  invariant(value.OriginalFilename === `${productName}.exe`, 'Windows OriginalFilename does not match this release.')
}

async function smokePackagedApplication(executablePath, packageDirectory, packagedHostdPath) {
  const scratch = await mkdtemp(join(tmpdir(), 'prime-continuim-package-smoke-'))
  const hostDataRoot = join(scratch, 'hostd')
  await mkdir(hostDataRoot, { mode: 0o700 })
  const primeAgentCustody = await createPrimeAgentSmokeCustody({
    hostDataRoot,
    hostdModule: require(packagedHostdPath),
  })
  await primeAgentCustody.assertInitiallyAbsent()
  const environment = { ...process.env }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS', 'NODE_PATH']) delete environment[name]
  environment.PRIME_CONTINUIM_PACKAGE_SMOKE = '1'
  environment.PRIME_AGENT_DATA_DIR = hostDataRoot
  let primaryFailure
  let applicationSmoke
  let cleanShutdownConfirmed = false
  try {
    const { stdout } = await execFileAsync(executablePath, [`--user-data-dir=${join(scratch, 'user-data')}`, '--disable-gpu'], {
      cwd: packageDirectory,
      env: environment,
      timeout: 210_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    const markers = stdout.split(/\r?\n/).filter((line) => line === PACKAGE_SMOKE_MARKER)
    invariant(markers.length === 1, 'The packaged application did not complete its main/preload/renderer bridge smoke exactly once.')
    cleanShutdownConfirmed = true
    applicationSmoke = { mainLoaded: true, preloadBridgeInstalled: true, rendererLoaded: true }
  } catch (error) {
    primaryFailure = error
  }

  const cleanupFailures = []
  let custodyCleanupConfirmed = false
  if (cleanShutdownConfirmed) {
    try {
      await primeAgentCustody.captureExisting()
      await primeAgentCustody.removeAfterConfirmedShutdown({ confirmedCleanShutdown: true })
      custodyCleanupConfirmed = true
    } catch (error) {
      cleanupFailures.push(new Error('Packaged application Prime Agent custody cleanup failed', { cause: error }))
    }
  } else {
    cleanupFailures.push(new Error(
      'Packaged application Prime Agent custody was retained because clean app and host shutdown was not confirmed',
    ))
  }
  if (custodyCleanupConfirmed) {
    try {
      await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      cleanupFailures.push(new Error('Packaged application smoke temporary-root cleanup failed', { cause: error }))
    }
  }
  if (primaryFailure) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...cleanupFailures],
        'Packaged application smoke failed and cleanup was incomplete',
      )
    }
    throw primaryFailure
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'Packaged application smoke cleanup was incomplete')
  }
  invariant(applicationSmoke, 'Packaged application smoke completed without an assurance result.')
  return applicationSmoke
}

function validateRuntimePointer(pointer, inputs, label) {
  invariant(pointer?.schemaVersion === 1, `${label} runtime pointer is invalid.`)
  invariant(pointer.releaseVersion === inputs.policy.releaseVersion, `${label} runtime release is not pinned.`)
  invariant(pointer.platform === process.platform && pointer.arch === process.arch, `${label} runtime target is incompatible.`)
  invariant(
    typeof pointer.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(pointer.manifestSha256),
    `${label} runtime manifest digest is invalid.`,
  )
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
  const manifestRelative = relative(root, manifestPath)
  invariant(
    manifestRelative !== '..' && !manifestRelative.startsWith(`..${sep}`) && !isAbsolute(manifestRelative),
    `${label} runtime pointer escapes its resource root.`,
  )
  return manifestPath
}

async function readTextArtifacts(root) {
  let result = ''
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile() && /\.(?:css|html|js|json|map)$/i.test(entry.name)) {
        result += await readFile(path, 'utf8')
      }
    }
  }
  await visit(root)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
