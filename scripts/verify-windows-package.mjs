import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii')
const FUSE_ENABLED = '1'.charCodeAt(0)

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
  const builtMainPath = resolve('out/main/index.js')
  const builtAttestationPath = resolve('out/main/runtime-attestation.json')
  const builtPreloadPath = resolve('out/preload/index.cjs')
  const builtRuntimeRoot = resolve('out/runtime')
  const packagedRuntimeRoot = resolve(packageDirectory, 'resources/runtime-seed')
  const builtRendererDirectory = resolve('out/renderer')

  const [executable, packagedHostd, builtHostd, builtMain, builtAttestationBytes, builtPreload, asarMetadata] = await Promise.all([
    readFile(executablePath),
    readFile(packagedHostdPath),
    readFile(builtHostdPath),
    readFile(builtMainPath, 'utf8'),
    readFile(builtAttestationPath),
    readFile(builtPreloadPath, 'utf8'),
    stat(asarPath),
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
  const packagedAttestationBytes = extractFile(asarPath, join('out', 'main', 'runtime-attestation.json'))
  invariant(
    packagedAttestationBytes.equals(builtAttestationBytes),
    'The packaged ASAR runtime attestation does not match this release build.',
  )
  const attestation = parseRuntimeAttestation(builtAttestationBytes)

  const fuses = readRequiredFuses(executable)
  const builtHostdHash = sha256(builtHostd)
  const packagedHostdHash = sha256(packagedHostd)
  invariant(packagedHostdHash === builtHostdHash, 'The packaged host daemon does not match the host daemon built in this run.')
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
    invariant(!builtHostd.toString('utf8').includes(fingerprint), `The hostd bundle statically embeds Prime Agent code: ${fingerprint}.`)
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

async function verifyPackagedApplicationCode(asarPath, roots) {
  const archiveEntries = new Set(
    listPackage(asarPath, { isPack: false }).map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, '')),
  )
  invariant(
    ![...archiveEntries].some((entry) => entry === 'out/runtime' || entry.startsWith('out/runtime/')),
    'The Prime Agent runtime was duplicated inside app.asar.',
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
