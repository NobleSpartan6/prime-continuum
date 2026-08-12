import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensurePrimeAgentRuntime } from './ensure-prime-agent-runtime.mjs'
import {
  REPO_ROOT,
  RUNTIME_TEMPLATE_DIRECTORY,
  loadRuntimeInputs,
  verifyOnlySelectedRuntimeInstall,
} from './prime-agent-runtime-lib.mjs'
import {
  assertRuntimeAttestationMatches,
  createRuntimeAttestation,
  parseRuntimeAttestation,
  readElectronRuntimeIdentity,
  readNodeRuntimeIdentity,
  serializeRuntimeAttestation,
} from './runtime-attestation-lib.mjs'
import { resolvePinnedDevelopmentNodeExecutable } from './development-node-runtime.mjs'

const CACHE_SCHEMA_VERSION = 1
const MAX_CACHE_BYTES = 256 * 1024
const MAX_POINTER_BYTES = 64 * 1024
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_FILE_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_RUNTIME_NAMESPACE_ENTRIES = 100_000
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export async function prepareDevelopmentRuntime({
  projectRoot = REPO_ROOT,
  runtimeRoot = resolve(projectRoot, 'out', 'runtime'),
  attestationPath = resolve(
    projectRoot,
    'node_modules',
    '.cache',
    'prime-continuim',
    'development-runtime-attestation.json',
  ),
  cachePath = resolve(
    projectRoot,
    'node_modules',
    '.cache',
    'prime-continuim',
    'development-runtime-checkpoint.json',
  ),
  electronExecutable,
  hostNodeExecutable,
  log = (message) => console.log(message),
  dependencies = {},
} = {}) {
  const absoluteProjectRoot = resolve(projectRoot)
  const absoluteRuntimeRoot = resolve(runtimeRoot)
  const absoluteAttestationPath = resolve(attestationPath)
  const absoluteCachePath = resolve(cachePath)
  const resolvedElectron = resolve(
    electronExecutable ?? createRequire(import.meta.url)('electron'),
  )
  const resolvedHostNode = resolve(
    hostNodeExecutable ?? resolvePinnedDevelopmentNodeExecutable(absoluteProjectRoot),
  )
  for (const [label, value] of Object.entries({
    'project root': absoluteProjectRoot,
    'runtime root': absoluteRuntimeRoot,
    'attestation path': absoluteAttestationPath,
    'checkpoint path': absoluteCachePath,
    'Electron executable': resolvedElectron,
    'host Node executable': resolvedHostNode,
  })) {
    if (!isAbsolute(value)) throw new Error(`Development ${label} must be absolute.`)
  }

  const inspect = dependencies.inspect ?? inspectDevelopmentRuntime
  const readCheckpoint = dependencies.readCheckpoint ?? readDevelopmentRuntimeCheckpoint
  const ensure = dependencies.ensure ?? ensurePrimeAgentRuntime
  const attest = dependencies.attest ?? createRuntimeAttestation
  const serialize = dependencies.serialize ?? serializeRuntimeAttestation
  const writeAtomic = dependencies.writeAtomic ?? writePrivateAtomic

  const cached = await readCheckpoint(absoluteCachePath).catch(() => undefined)
  if (cached) {
    const state = await inspect({
      runtimeRoot: absoluteRuntimeRoot,
      attestationPath: absoluteAttestationPath,
      electronExecutable: resolvedElectron,
      hostNodeExecutable: resolvedHostNode,
    }).catch(() => undefined)
    if (state && cacheMatchesState(cached, state)) {
      log('Development runtime checkpoint matched; authoritative runtime hashing remains gated inside the host service.')
      return Object.freeze({
        cached: true,
        rebuilt: false,
        runtimeRoot: absoluteRuntimeRoot,
        attestationPath: absoluteAttestationPath,
        cachePath: absoluteCachePath,
      })
    }
  }

  log('Development runtime checkpoint missed; running exact runtime verification before launch...')
  let rebuilt = false
  let attestation
  try {
    // Attestation generation already performs the exact whole-tree verifier.
    // Avoid a second identical pass for a valid runtime on a cold cache.
    attestation = await attest({
      runtimeRoot: absoluteRuntimeRoot,
      electronExecutable: resolvedElectron,
      hostNodeExecutable: resolvedHostNode,
    })
  } catch {
    const ensured = await ensure({
      projectRoot: absoluteProjectRoot,
      runtimeRoot: absoluteRuntimeRoot,
      log,
    })
    rebuilt = ensured.rebuilt
    attestation = await attest({
      runtimeRoot: absoluteRuntimeRoot,
      electronExecutable: resolvedElectron,
      hostNodeExecutable: resolvedHostNode,
    })
  }

  await writeAtomic(absoluteAttestationPath, serialize(attestation))
  const state = await inspect({
    runtimeRoot: absoluteRuntimeRoot,
    attestationPath: absoluteAttestationPath,
    electronExecutable: resolvedElectron,
    hostNodeExecutable: resolvedHostNode,
  })
  await writeAtomic(absoluteCachePath, Buffer.from(`${JSON.stringify(cacheFromState(state), null, 2)}\n`, 'utf8'))
  log('Development runtime verified and checkpointed.')
  return Object.freeze({
    cached: false,
    rebuilt,
    runtimeRoot: absoluteRuntimeRoot,
    attestationPath: absoluteAttestationPath,
    cachePath: absoluteCachePath,
  })
}

export async function inspectDevelopmentRuntime({ runtimeRoot, attestationPath, electronExecutable, hostNodeExecutable }) {
  const absoluteRuntimeRoot = resolve(runtimeRoot)
  const absoluteAttestationPath = resolve(attestationPath)
  const absoluteElectronExecutable = resolve(electronExecutable)
  const absoluteHostNodeExecutable = resolve(hostNodeExecutable)
  const inputs = await loadRuntimeInputs(RUNTIME_TEMPLATE_DIRECTORY)
  const [pointerBytes, attestationBytes, guiRuntime, hostRuntime] = await Promise.all([
    readBoundedPlainFile(join(absoluteRuntimeRoot, 'current.json'), MAX_POINTER_BYTES, 'runtime pointer'),
    readBoundedPlainFile(absoluteAttestationPath, MAX_CACHE_BYTES, 'development runtime attestation'),
    readElectronRuntimeIdentity(absoluteElectronExecutable),
    readNodeRuntimeIdentity(absoluteHostNodeExecutable),
  ])
  const pointer = parseJson(pointerBytes, 'runtime pointer')
  if (typeof pointer?.runtimeManifest !== 'string') throw new Error('Runtime pointer has no manifest locator.')
  const manifestPath = resolveContainedRelativePath(
    absoluteRuntimeRoot,
    pointer.runtimeManifest,
    'runtime manifest',
  )
  const runtimeDirectory = dirname(manifestPath)
  await verifyOnlySelectedRuntimeInstall(absoluteRuntimeRoot, runtimeDirectory)

  const before = await createRuntimeNamespaceCheckpoint(runtimeDirectory)
  const [manifestBytes, fileManifestBytes] = await Promise.all([
    readBoundedPlainFile(manifestPath, MAX_MANIFEST_BYTES, 'runtime manifest'),
    readBoundedPlainFile(join(runtimeDirectory, 'files.sha256'), MAX_FILE_MANIFEST_BYTES, 'runtime file manifest'),
  ])
  const after = await createRuntimeNamespaceCheckpoint(runtimeDirectory)
  if (before.metadataSha256 !== after.metadataSha256 || before.entryCount !== after.entryCount) {
    throw new Error('Runtime namespace changed while checking the development checkpoint.')
  }

  const manifest = parseJson(manifestBytes, 'runtime manifest')
  const attestation = parseRuntimeAttestation(attestationBytes)
  assertRuntimeAttestationMatches(attestation, {
    pointer,
    manifest,
    manifestBytes,
    fileManifestBytes,
    guiRuntime,
    hostRuntime,
    inputs,
  })

  return Object.freeze({
    pointerSha256: sha256(pointerBytes),
    manifestSha256: sha256(manifestBytes),
    fileManifestSha256: sha256(fileManifestBytes),
    attestationSha256: sha256(attestationBytes),
    namespaceMetadataSha256: after.metadataSha256,
    namespaceEntryCount: after.entryCount,
  })
}

export async function createRuntimeNamespaceCheckpoint(runtimeDirectory) {
  const root = await realpath(resolve(runtimeDirectory))
  const pending = [{ absolute: root, relative: '' }]
  const records = []
  while (pending.length > 0) {
    const current = pending.pop()
    const names = await readdir(current.absolute)
    names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    if (current.relative && names.length === 0) {
      throw new Error(`Runtime contains an unexpected empty directory: ${current.relative}.`)
    }
    const children = await Promise.all(names.map(async (name) => {
      if (/\0|\r|\n/.test(name) || name.normalize('NFC') !== name) {
        throw new Error(`Runtime contains an unsafe file name: ${name}.`)
      }
      const absolute = join(current.absolute, name)
      const relativePath = current.relative ? `${current.relative}/${name}` : name
      return { absolute, relative: relativePath, stat: await lstat(absolute, { bigint: true }) }
    }))
    for (const child of children) {
      if (child.stat.isSymbolicLink()) throw new Error(`Runtime contains a symbolic link: ${child.relative}.`)
      const kind = child.stat.isDirectory() ? 'd' : child.stat.isFile() ? 'f' : undefined
      if (!kind) throw new Error(`Runtime contains a non-regular entry: ${child.relative}.`)
      records.push(metadataRecord(kind, child.relative, child.stat))
      if (records.length > MAX_RUNTIME_NAMESPACE_ENTRIES) {
        throw new Error('Runtime namespace exceeds the development checkpoint entry limit.')
      }
      if (kind === 'd') pending.push({ absolute: child.absolute, relative: child.relative })
    }
  }
  records.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))
  const digest = createHash('sha256')
  for (const record of records) digest.update(`${JSON.stringify(record)}\n`)
  return Object.freeze({ metadataSha256: digest.digest('hex'), entryCount: records.length })
}

function metadataRecord(kind, path, stat) {
  return {
    kind,
    path,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  }
}

function cacheFromState(state) {
  return Object.freeze({ schemaVersion: CACHE_SCHEMA_VERSION, ...state })
}

function cacheMatchesState(cache, state) {
  return cache.schemaVersion === CACHE_SCHEMA_VERSION &&
    cache.pointerSha256 === state.pointerSha256 &&
    cache.manifestSha256 === state.manifestSha256 &&
    cache.fileManifestSha256 === state.fileManifestSha256 &&
    cache.attestationSha256 === state.attestationSha256 &&
    cache.namespaceMetadataSha256 === state.namespaceMetadataSha256 &&
    cache.namespaceEntryCount === state.namespaceEntryCount
}

async function readDevelopmentRuntimeCheckpoint(path) {
  const bytes = await readBoundedPlainFile(path, MAX_CACHE_BYTES, 'development runtime checkpoint')
  const value = parseJson(bytes, 'development runtime checkpoint')
  const keys = Object.keys(value ?? {}).sort()
  const expectedKeys = [
    'attestationSha256',
    'fileManifestSha256',
    'manifestSha256',
    'namespaceEntryCount',
    'namespaceMetadataSha256',
    'pointerSha256',
    'schemaVersion',
  ].sort()
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || value.schemaVersion !== CACHE_SCHEMA_VERSION) {
    throw new Error('Development runtime checkpoint schema is invalid.')
  }
  for (const key of [
    'attestationSha256',
    'fileManifestSha256',
    'manifestSha256',
    'namespaceMetadataSha256',
    'pointerSha256',
  ]) {
    if (!SHA256_PATTERN.test(value[key])) throw new Error(`Development runtime checkpoint ${key} is invalid.`)
  }
  if (!Number.isInteger(value.namespaceEntryCount) || value.namespaceEntryCount < 1 || value.namespaceEntryCount > MAX_RUNTIME_NAMESPACE_ENTRIES) {
    throw new Error('Development runtime checkpoint entry count is invalid.')
  }
  return Object.freeze(value)
}

async function readBoundedPlainFile(path, maximumBytes, label) {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1 || details.size > maximumBytes) {
    throw new Error(`${label} is not a bounded regular file.`)
  }
  const bytes = await readFile(path)
  if (bytes.byteLength !== details.size) throw new Error(`${label} changed while it was read.`)
  return bytes
}

function resolveContainedRelativePath(root, value, label) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} path is invalid.`)
  }
  const target = resolve(root, ...value.split('/'))
  const relation = relative(root, target)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} escapes the runtime root.`)
  }
  return target
}

async function writePrivateAtomic(path, bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, value, { flag: 'wx', mode: 0o600 })
  try {
    await rename(temporary, path)
  } catch (error) {
    await import('node:fs/promises').then(({ rm }) => rm(temporary, { force: true })).catch(() => undefined)
    throw error
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch (cause) {
    throw new Error(`${label} is not valid JSON.`, { cause })
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseArguments(args) {
  const result = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!['--runtime-root', '--attestation', '--cache', '--electron', '--host-node'].includes(name) || !value || value.startsWith('--')) {
      throw new Error('Usage: node scripts/prepare-development-runtime.mjs --runtime-root <path> --attestation <path> --cache <path> [--electron <path>] [--host-node <path>]')
    }
    const key = name.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate development runtime option: ${name}.`)
    result[key] = resolve(value)
  }
  if (!result.runtimeRoot || !result.attestation || !result.cache) {
    throw new Error('Development runtime preparation requires --runtime-root, --attestation, and --cache.')
  }
  return result
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2))
  await prepareDevelopmentRuntime({
    runtimeRoot: options.runtimeRoot,
    attestationPath: options.attestation,
    cachePath: options.cache,
    electronExecutable: options.electron,
    hostNodeExecutable: options.hostNode,
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli()
}
