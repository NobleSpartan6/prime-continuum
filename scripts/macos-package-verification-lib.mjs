import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { extractFile, getRawHeader, listPackage } from '@electron/asar'
import { createPrimeAgentSmokeCustody } from './prime-agent-smoke-custody-lib.mjs'

const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii')
const FUSE_ENABLED = '1'.charCodeAt(0)
const FUSE_DISABLED = '0'.charCodeAt(0)
const PACKAGE_SMOKE_MARKER = 'PRIME_CONTINUIM_PACKAGE_SMOKE_OK'
const MAX_TREE_ENTRIES = 30_000
const MAX_TREE_BYTES = 1024 * 1024 * 1024
const MAX_FILE_BYTES = 512 * 1024 * 1024
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

export function readRequiredMacosFuses(frameworkBytes) {
  const executable = Buffer.isBuffer(frameworkBytes) ? frameworkBytes : Buffer.from(frameworkBytes)
  const sentinelOffset = executable.indexOf(FUSE_SENTINEL)
  invariant(sentinelOffset >= 0, 'The Electron fuse sentinel is missing from the packaged framework.')
  invariant(executable.indexOf(FUSE_SENTINEL, sentinelOffset + 1) < 0, 'The packaged framework contains more than one Electron fuse sentinel.')
  const wireOffset = sentinelOffset + FUSE_SENTINEL.length
  invariant(wireOffset + 2 <= executable.length, 'The Electron fuse header is truncated.')
  const version = executable[wireOffset]
  const wireLength = executable[wireOffset + 1]
  invariant(version === 1, `Unsupported Electron fuse wire version: ${version}.`)
  invariant(wireLength >= 6 && wireOffset + 2 + wireLength <= executable.length, 'The Electron fuse wire is truncated.')
  const wire = executable.subarray(wireOffset + 2, wireOffset + 2 + wireLength)
  invariant(wire[0] === FUSE_DISABLED, 'RunAsNode must be disabled in the packaged desktop Electron runtime.')
  invariant(wire[4] === FUSE_ENABLED, 'EnableEmbeddedAsarIntegrityValidation is not enabled in the packaged framework.')
  invariant(wire[5] === FUSE_ENABLED, 'OnlyLoadAppFromAsar is not enabled in the packaged framework.')
  return Object.freeze({ version, wireLength })
}

export async function verifyMacosAsarIntegrity({ asarPath, infoPlistPath }) {
  const { stdout } = await execFileAsync('/usr/bin/plutil', [
    '-extract',
    'ElectronAsarIntegrity',
    'json',
    '-o',
    '-',
    infoPlistPath,
  ], { timeout: 10_000, maxBuffer: 256 * 1024 })
  const value = parseJsonObject(Buffer.from(stdout, 'utf8'), 'The macOS ASAR integrity record')
  const expected = Object.freeze({
    'Resources/app.asar': asarPath,
    'Resources/browser-runtime/default_app.asar': join(
      dirname(asarPath),
      'browser-runtime',
      'Electron.app',
      'Contents',
      'Resources',
      'default_app.asar',
    ),
  })
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(Object.keys(expected).sort()),
    'The macOS ASAR integrity record does not bind exactly the application and browser-runtime archives.',
  )
  const result = {}
  for (const [recordPath, archivePath] of Object.entries(expected)) {
    const record = value[recordPath]
    invariant(record && typeof record === 'object' && !Array.isArray(record), `The macOS ASAR integrity record is missing ${recordPath}.`)
    invariant(Object.keys(record).sort().join(',') === 'algorithm,hash', `The macOS ASAR integrity record for ${recordPath} contains unexpected fields.`)
    invariant(record.algorithm === 'SHA256', `The macOS ASAR integrity algorithm for ${recordPath} is not SHA256.`)
    const { headerString } = getRawHeader(archivePath)
    invariant(typeof headerString === 'string' && headerString.length > 0, `The packaged ASAR header for ${recordPath} is empty.`)
    const expectedHash = sha256(Buffer.from(headerString, 'utf8')).toLowerCase()
    invariant(record.hash === expectedHash, `The macOS ASAR integrity digest for ${recordPath} does not match the exact packaged header.`)
    result[recordPath] = Object.freeze({ algorithm: 'SHA256', hash: expectedHash })
  }
  return Object.freeze(result)
}

export async function verifyAdHocMacosSignature(appPath) {
  await execFileAsync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', appPath], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  })
  const result = await execFileAsync('/usr/bin/codesign', ['--display', '--verbose=4', appPath], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  })
  const output = `${result.stdout}${result.stderr}`
  return parseAdHocCodesignDisplay(output)
}

export function parseAdHocCodesignDisplay(output) {
  invariant(typeof output === 'string' && output.length > 0 && output.length <= 1024 * 1024, 'The macOS code-signature inspection is empty or oversized.')
  invariant(/^Signature=adhoc$/m.test(output), 'The macOS development package is not ad-hoc signed.')
  invariant(/^TeamIdentifier=not set$/m.test(output), 'The macOS development package unexpectedly has a signing team identity.')
  invariant(!/^Authority=/m.test(output), 'The macOS development package unexpectedly has a certificate authority chain.')
  const identifier = /^Identifier=([^\r\n]+)$/m.exec(output)?.[1]
  invariant(identifier === 'ai.primeintellect.continuim', 'The macOS development package has the wrong bundle identity.')
  return Object.freeze({ identity: 'ad-hoc', teamIdentifier: null, bundleIdentifier: identifier })
}

export async function verifyPackagedApplicationCode(asarPath, roots) {
  const archiveEntries = new Set(
    listPackage(asarPath, { isPack: false }).map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, '')),
  )
  for (const excluded of ['out/runtime', 'out/runtime-cache', 'out/hostd', 'out/visual-qa']) {
    invariant(
      ![...archiveEntries].some((entry) => entry === excluded || entry.startsWith(`${excluded}/`)),
      `The external ${excluded} tree was duplicated inside app.asar.`,
    )
  }
  invariant(
    [...archiveEntries]
      .filter((entry) => entry === 'out' || entry.startsWith('out/'))
      .every((entry) => entry === 'out' || roots.some(({ archiveRoot }) => entry === archiveRoot || entry.startsWith(`${archiveRoot}/`))),
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
      if (entry.isDirectory()) await visit(sourcePath, archivePath)
      else if (entry.isFile()) expectedFiles.push({ sourcePath, archivePath })
      else throw new Error(`Built application output contains a non-regular entry: ${sourcePath}.`)
    }
  }

  const selected = [...archiveEntries].filter((entry) =>
    roots.some(({ archiveRoot }) => entry === archiveRoot || entry.startsWith(`${archiveRoot}/`)),
  )
  invariant(
    selected.length === expectedEntries.size && selected.every((entry) => expectedEntries.has(entry)),
    'The packaged app.asar application entries do not match this build output.',
  )
  for (const file of expectedFiles) {
    const packaged = extractFile(asarPath, join(...file.archivePath.split('/')))
    const built = await readFile(file.sourcePath)
    invariant(packaged.equals(built), `Packaged app.asar file differs from this build: ${file.archivePath}.`)
  }
  return Object.freeze({ fileCount: expectedFiles.length })
}

export async function compareExactDirectoryTrees(sourceRoot, packagedRoot, label) {
  const [source, packaged] = await Promise.all([
    createDirectoryManifest(sourceRoot, `${label} source`),
    createDirectoryManifest(packagedRoot, `${label} package`),
  ])
  invariant(JSON.stringify(packaged.records) === JSON.stringify(source.records), `${label} does not match the exact source tree.`)
  return Object.freeze({ entries: source.records.length, files: source.files, bytes: source.bytes })
}

export async function assertDistinctExecutableIdentities(executables) {
  invariant(Array.isArray(executables) && executables.length >= 3, 'At least three executable identities are required.')
  const records = await Promise.all(executables.map(async ({ label, path }) => {
    const [metadata, physical, digest] = await Promise.all([lstat(path), realpath(path), hashRegularFile(path)])
    invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `${label} is not a non-empty regular executable.`)
    return Object.freeze({ label, path: physical, sha256: digest })
  }))
  invariant(new Set(records.map(({ path }) => path)).size === records.length, 'Packaged executable physical identities must all differ.')
  invariant(new Set(records.map(({ sha256 }) => sha256)).size === records.length, 'Packaged executable digests must all differ.')
  return Object.freeze(records)
}

export function parseJsonObject(bytes, label) {
  let value
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error })
  }
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${label} is not an object.`)
  return value
}

export function selectPackagedMetadata(projectPackage) {
  const fields = [
    'name',
    'version',
    'private',
    'author',
    'license',
    'description',
    'homepage',
    'repository',
    'bugs',
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

export async function smokePackagedMacosApplication(executablePath, packageDirectory, packagedHostdPath) {
  // Unix-domain socket paths are sharply bounded on macOS. /tmp is resolved
  // before use so custody still receives a physical path while the owned leaf
  // remains short enough for hostd's derived endpoint.
  const scratch = await mkdtemp(join(await realpath('/tmp'), 'pc-mac-pkg-'))
  const hostDataRoot = join(scratch, 'hostd')
  const userDataRoot = join(scratch, 'user-data')
  let primeAgentCustody
  try {
    await mkdir(hostDataRoot, { mode: 0o700 })
    primeAgentCustody = await createPrimeAgentSmokeCustody({
      hostDataRoot,
      hostdModule: require(packagedHostdPath),
    })
    await primeAgentCustody.assertInitiallyAbsent()
  } catch (error) {
    try {
      await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'macOS package-smoke setup failed and its isolated root could not be removed')
    }
    throw error
  }
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS', 'NODE_PATH'].includes(name.toUpperCase())) {
      delete environment[name]
    }
  }
  environment.PRIME_CONTINUIM_PACKAGE_SMOKE = '1'
  environment.PRIME_AGENT_DATA_DIR = hostDataRoot

  let primaryFailure
  let cleanShutdownConfirmed = false
  try {
    const { stdout } = await execFileAsync(executablePath, [`--user-data-dir=${userDataRoot}`, '--disable-gpu'], {
      cwd: packageDirectory,
      env: environment,
      timeout: 210_000,
      maxBuffer: 1024 * 1024,
    })
    const markers = stdout.split(/\r?\n/).filter((line) => line === PACKAGE_SMOKE_MARKER)
    invariant(markers.length === 1, 'The macOS package did not complete its main/preload/renderer bridge smoke exactly once.')
    await assertNoProcessResidue(scratch)
    cleanShutdownConfirmed = true
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
      cleanupFailures.push(new Error('macOS package-smoke Prime Agent custody cleanup failed', { cause: error }))
    }
  } else {
    cleanupFailures.push(new Error('macOS package-smoke state was retained because clean app and host shutdown was not confirmed'))
  }
  if (custodyCleanupConfirmed) {
    try {
      await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      cleanupFailures.push(new Error('macOS package-smoke temporary-root cleanup failed', { cause: error }))
    }
  }
  if (primaryFailure) {
    if (cleanupFailures.length > 0) throw new AggregateError([primaryFailure, ...cleanupFailures], 'macOS package smoke failed and cleanup was incomplete')
    throw primaryFailure
  }
  if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'macOS package-smoke cleanup was incomplete')
  return Object.freeze({ mainLoaded: true, preloadBridgeInstalled: true, rendererLoaded: true, cleanShutdown: true, residue: false })
}

async function assertNoProcessResidue(marker) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,command='], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 })
    const matches = stdout.split(/\r?\n/).filter((line) => line.includes(marker) && !line.includes('/bin/ps -axo'))
    if (matches.length === 0) return
    if (attempt < 19) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    else throw new Error('The macOS package smoke left a process associated with its isolated state root.')
  }
}

async function createDirectoryManifest(root, label) {
  const absoluteRoot = await realpath(resolve(root))
  const pending = [{ absolute: absoluteRoot, relativePath: '' }]
  const records = []
  let files = 0
  let bytes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    const entries = await readdir(current.absolute, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'))
    for (const entry of entries) {
      invariant(entry.name && !/[\0\r\n/\\]/.test(entry.name) && entry.name.normalize('NFC') === entry.name, `${label} contains an unsafe entry name.`)
      const absolute = join(current.absolute, entry.name)
      const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name
      const metadata = await lstat(absolute)
      invariant(records.length < MAX_TREE_ENTRIES, `${label} exceeds its entry bound.`)
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        pending.push({ absolute, relativePath })
      } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
        invariant(metadata.size <= MAX_FILE_BYTES, `${label} contains an oversized file.`)
        files += 1
        bytes += metadata.size
        invariant(bytes <= MAX_TREE_BYTES, `${label} exceeds its byte bound.`)
        records.push(['f', relativePath, metadata.mode & 0o777, metadata.size, await hashRegularFile(absolute)])
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(absolute)
        invariant(target.length > 0 && target.length <= 4096 && !isAbsolute(target) && !/[\0\r\n]/.test(target), `${label} contains an unsafe symbolic link.`)
        const resolvedTarget = resolve(dirname(absolute), target)
        const relation = relative(absoluteRoot, resolvedTarget)
        invariant(relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation), `${label} contains an escaping symbolic link.`)
        records.push(['l', relativePath, target])
      } else {
        throw new Error(`${label} contains a non-regular filesystem entry.`)
      }
    }
  }
  records.sort((left, right) => left[1].localeCompare(right[1], 'en-US'))
  return Object.freeze({ records, files, bytes })
}

async function hashRegularFile(path) {
  const before = await stat(path)
  invariant(before.isFile() && before.size >= 0 && before.size <= MAX_FILE_BYTES, 'Executable or tree file is outside its size bound.')
  const digest = createHash('sha256')
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => digest.update(chunk))
    stream.once('end', resolveStream)
    stream.once('error', rejectStream)
  })
  const after = await stat(path)
  invariant(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs, 'Executable or tree file changed while it was hashed.')
  return digest.digest('hex')
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}
