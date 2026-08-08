import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const scriptPath = fileURLToPath(import.meta.url)

export class ElectronRuntimeSetupError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'ElectronRuntimeSetupError'
  }
}

export function expectedElectronExecutable(platform = process.platform) {
  switch (platform) {
    case 'darwin':
    case 'mas':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'freebsd':
    case 'linux':
    case 'openbsd':
      return 'electron'
    case 'win32':
      return 'electron.exe'
    default:
      throw new ElectronRuntimeSetupError(
        `Electron does not publish a desktop runtime for platform ${JSON.stringify(platform)}.`
      )
  }
}

export function resolveElectronPackageDirectory() {
  try {
    return dirname(require.resolve('electron/package.json'))
  } catch (cause) {
    throw new ElectronRuntimeSetupError(
      'The Electron dependency is not installed. Run `pnpm install`, then retry `pnpm dev`.',
      { cause }
    )
  }
}

export async function inspectElectronRuntime({
  electronPackageDirectory = resolveElectronPackageDirectory(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const expectedExecutable = expectedElectronExecutable(platform)
  const markerPath = join(electronPackageDirectory, 'path.txt')
  const versionPath = join(electronPackageDirectory, 'dist', 'version')
  const executablePath = join(electronPackageDirectory, 'dist', expectedExecutable)
  const reasons = []

  let packageVersion
  try {
    const manifest = JSON.parse(await readFile(join(electronPackageDirectory, 'package.json'), 'utf8'))
    if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
      reasons.push('package_version_invalid')
    } else {
      packageVersion = manifest.version
    }
  } catch {
    reasons.push('package_manifest_invalid')
  }

  const marker = await readText(markerPath)
  if (marker === undefined) {
    reasons.push('path_marker_missing')
  } else if (marker !== expectedExecutable) {
    reasons.push('path_marker_invalid')
  }

  const installedVersion = await readText(versionPath)
  if (installedVersion === undefined) {
    reasons.push('distribution_version_missing')
  } else if (packageVersion && installedVersion.replace(/^v/, '') !== packageVersion) {
    reasons.push('distribution_version_mismatch')
  }

  try {
    const executableStat = await stat(executablePath)
    if (!executableStat.isFile() || executableStat.size === 0) {
      reasons.push('executable_invalid')
    } else if (platform === 'win32') {
      const machine = await readPeMachine(executablePath)
      if (machine === undefined) reasons.push('executable_format_invalid')
      else if (machine !== expectedWindowsMachine(arch)) reasons.push('executable_architecture_mismatch')
    }
  } catch {
    reasons.push('executable_missing')
  }

  return {
    ready: reasons.length === 0,
    electronPackageDirectory,
    executablePath,
    expectedExecutable,
    packageVersion,
    reasons
  }
}

export async function ensureElectronRuntime({
  electronPackageDirectory = resolveElectronPackageDirectory(),
  platform = process.platform,
  arch = process.arch,
  log = (message) => console.log(message),
  runInstaller = runElectronInstaller,
  installerTimeoutMs = 10 * 60 * 1000,
} = {}) {
  const before = await inspectElectronRuntime({ electronPackageDirectory, platform, arch })
  if (before.ready) {
    return before
  }

  log('Electron desktop runtime is incomplete; repairing it automatically...')

  let quarantinedMarker
  try {
    quarantinedMarker = await quarantineElectronInstallMarker(electronPackageDirectory)
  } catch (cause) {
    throw repairFailure(
      electronPackageDirectory,
      `the Electron install marker could not be safely invalidated: ${errorMessage(cause)}`,
      cause
    )
  }

  let outcome
  let installerFailure
  try {
    outcome = await runInstaller({ electronPackageDirectory, timeoutMs: installerTimeoutMs })
  } catch (cause) {
    installerFailure = cause
  }

  try {
    await settleElectronInstallMarker(quarantinedMarker)
  } catch (cause) {
    throw repairFailure(
      electronPackageDirectory,
      `the Electron install marker could not be safely restored or cleaned up: ${errorMessage(cause)}`,
      cause
    )
  }

  if (installerFailure) {
    throw repairFailure(
      electronPackageDirectory,
      installerFailure instanceof Error ? installerFailure.message : 'the installer could not be started',
      installerFailure
    )
  }

  if (!outcome || outcome.status !== 0) {
    const detail = outcome?.timedOut
      ? `timed out after ${installerTimeoutMs}ms`
      : outcome?.error
      ? outcome.error.message
      : outcome?.signal
        ? `signal ${outcome.signal}`
        : `exit code ${outcome?.status ?? 'unknown'}`
    throw repairFailure(electronPackageDirectory, detail, outcome?.error)
  }

  const after = await inspectElectronRuntime({ electronPackageDirectory, platform, arch })
  if (!after.ready) {
    throw repairFailure(
      electronPackageDirectory,
      `the installer exited successfully but left invalid runtime state: ${after.reasons.join(', ')}`
    )
  }

  log('Electron desktop runtime is ready.')
  return after
}

async function quarantineElectronInstallMarker(electronPackageDirectory) {
  const packageDirectory = resolve(electronPackageDirectory)
  const markerPath = resolve(packageDirectory, 'path.txt')
  if (dirname(markerPath) !== packageDirectory) {
    throw new Error('the marker path escaped the Electron package directory')
  }

  let markerStat
  try {
    markerStat = await lstat(markerPath, { bigint: true })
  } catch (error) {
    if (isMissingError(error)) return undefined
    throw error
  }
  assertSafeMarkerFile(markerStat)

  const handle = await open(markerPath, 'r')
  let contents
  try {
    const openedStat = await handle.stat({ bigint: true })
    if (!sameFileIdentity(markerStat, openedStat)) {
      throw new Error('the marker changed while it was being inspected')
    }
    contents = await handle.readFile()
    if (contents.byteLength > 4096) throw new Error('the marker is unexpectedly large')
  } finally {
    await handle.close()
  }

  const quarantinePath = resolve(
    packageDirectory,
    `.prime-electron-path-${process.pid}-${randomUUID()}.txt`
  )
  if (dirname(quarantinePath) !== packageDirectory) {
    throw new Error('the quarantine path escaped the Electron package directory')
  }

  await rename(markerPath, quarantinePath)
  const quarantinedStat = await lstat(quarantinePath, { bigint: true })
  if (!sameFileIdentity(markerStat, quarantinedStat)) {
    throw new Error('the quarantined marker does not match the inspected marker')
  }

  return {
    markerPath,
    quarantinePath,
    identity: markerStat,
    contents,
    mode: Number(markerStat.mode & 0o777n)
  }
}

async function settleElectronInstallMarker(quarantine) {
  if (!quarantine) return
  const quarantinedStat = await lstat(quarantine.quarantinePath, { bigint: true })
  assertSafeMarkerFile(quarantinedStat)
  if (!sameFileIdentity(quarantine.identity, quarantinedStat)) {
    throw new Error('the quarantined marker changed during Electron installation')
  }

  let markerExists = true
  try {
    await lstat(quarantine.markerPath)
  } catch (error) {
    if (isMissingError(error)) markerExists = false
    else throw error
  }

  if (!markerExists) {
    try {
      await writeFile(quarantine.markerPath, quarantine.contents, {
        flag: 'wx',
        mode: quarantine.mode
      })
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error
    }
  }

  const finalStat = await lstat(quarantine.quarantinePath, { bigint: true })
  assertSafeMarkerFile(finalStat)
  if (!sameFileIdentity(quarantine.identity, finalStat)) {
    throw new Error('the quarantined marker changed before cleanup')
  }
  await unlink(quarantine.quarantinePath)
}

export function runElectronInstaller({ electronPackageDirectory, timeoutMs = 10 * 60 * 1000 }) {
  const installScript = join(electronPackageDirectory, 'install.js')
  return new Promise((resolveInstaller) => {
    const child = spawn(process.execPath, [installScript], {
      cwd: electronPackageDirectory,
      env: hostElectronInstallEnvironment(process.env),
      stdio: 'inherit',
      windowsHide: true
    })
    let timedOut = false
    let forceTimer
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill()
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      forceTimer.unref?.()
    }, timeoutMs)
    deadline.unref?.()
    child.once('error', (error) => {
      clearTimeout(deadline)
      if (forceTimer) clearTimeout(forceTimer)
      resolveInstaller({ status: null, signal: null, error, timedOut })
    })
    child.once('exit', (status, signal) => {
      clearTimeout(deadline)
      if (forceTimer) clearTimeout(forceTimer)
      resolveInstaller({ status, signal, timedOut })
    })
  })
}

export function hostElectronInstallEnvironment(source = process.env) {
  const environment = { ...source }
  for (const name of Object.keys(environment)) {
    const normalized = name.toUpperCase()
    if (
      normalized === 'ELECTRON_INSTALL_ARCH' ||
      normalized === 'ELECTRON_INSTALL_PLATFORM' ||
      normalized === 'NPM_CONFIG_ARCH' ||
      normalized === 'NPM_CONFIG_PLATFORM' ||
      isElectronArtifactOverride(normalized)
    ) delete environment[name]
  }
  environment.ELECTRON_INSTALL_PLATFORM = process.platform
  environment.ELECTRON_INSTALL_ARCH = process.arch
  return environment
}

const electronArtifactEnvironmentPrefixes = [
  'ELECTRON_',
  'NPM_CONFIG_ELECTRON_',
  'NPM_PACKAGE_CONFIG_ELECTRON_'
]

const electronArtifactOverrideSuffixes = new Set([
  'USE_REMOTE_CHECKSUMS',
  'OVERRIDE_DIST_PATH',
  'MIRROR',
  'NIGHTLY_MIRROR',
  'NIGHTLYMIRROR',
  'CUSTOM_DIR',
  'CUSTOMDIR',
  'CUSTOM_FILENAME',
  'CUSTOMFILENAME',
  'CUSTOM_VERSION',
  'CUSTOMVERSION'
])

function isElectronArtifactOverride(normalizedName) {
  for (const prefix of electronArtifactEnvironmentPrefixes) {
    if (
      normalizedName.startsWith(prefix) &&
      electronArtifactOverrideSuffixes.has(normalizedName.slice(prefix.length))
    ) return true
  }
  return false
}

async function readPeMachine(path) {
  const handle = await open(path, 'r')
  try {
    const dos = Buffer.alloc(64)
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') {
      return undefined
    }
    const peOffset = dos.readUInt32LE(0x3c)
    if (peOffset < 64 || peOffset > 1024 * 1024) return undefined
    const header = Buffer.alloc(6)
    if ((await handle.read(header, 0, header.length, peOffset)).bytesRead !== header.length) return undefined
    if (header.toString('binary', 0, 4) !== 'PE\0\0') return undefined
    return header.readUInt16LE(4)
  } finally {
    await handle.close()
  }
}

function expectedWindowsMachine(arch) {
  if (arch === 'x64') return 0x8664
  if (arch === 'ia32') return 0x014c
  if (arch === 'arm64') return 0xaa64
  throw new ElectronRuntimeSetupError(`Electron architecture ${JSON.stringify(arch)} is unsupported on Windows.`)
}

function assertSafeMarkerFile(markerStat) {
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error('path.txt is not a regular file')
  }
  if (markerStat.nlink !== 1n) {
    throw new Error('path.txt has unexpected hard links')
  }
  if (markerStat.size > 4096n) {
    throw new Error('path.txt is unexpectedly large')
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

function isMissingError(error) {
  return Boolean(error && typeof error === 'object' && error.code === 'ENOENT')
}

function isAlreadyExistsError(error) {
  return Boolean(error && typeof error === 'object' && error.code === 'EEXIST')
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function repairFailure(electronPackageDirectory, detail, cause) {
  return new ElectronRuntimeSetupError(
    `Automatic Electron runtime repair failed in ${electronPackageDirectory} (${detail}). ` +
      'Check network or proxy access to Electron release downloads, then retry `pnpm dev`. ' +
      'You do not need to delete or edit node_modules.',
    cause ? { cause } : undefined
  )
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

async function runCli() {
  try {
    await ensureElectronRuntime()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli()
}
