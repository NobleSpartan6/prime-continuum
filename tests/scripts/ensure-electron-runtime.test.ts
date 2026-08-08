import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalTemporaryDirectory } from '../helpers/canonical-temp'
import {
  ElectronRuntimeSetupError,
  ensureElectronRuntime,
  hostElectronInstallEnvironment,
  inspectElectronRuntime
} from '../../scripts/ensure-electron-runtime.mjs'

const fixtureRoots: string[] = []

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Electron development runtime bootstrap', () => {
  it.each([
    ['a missing marker and payload', undefined, false],
    ['the transient uninstall marker', 'uninstall', true]
  ])('repairs %s before electron-vite starts', async (_label, marker, includePayload) => {
    const electronPackageDirectory = await createElectronFixture({ marker, includePayload })
    const messages: string[] = []

    const result = await ensureElectronRuntime({
      electronPackageDirectory,
      platform: 'win32',
      arch: 'x64',
      log: (message) => messages.push(message)
    })

    expect(result.ready).toBe(true)
    expect(result.expectedExecutable).toBe('electron.exe')
    expect(await readFile(join(electronPackageDirectory, 'path.txt'), 'utf8')).toBe('electron.exe')
    expect(await readFile(join(electronPackageDirectory, 'install-count.txt'), 'utf8')).toBe('1')
    expect(messages).toEqual([
      'Electron desktop runtime is incomplete; repairing it automatically...',
      'Electron desktop runtime is ready.'
    ])
  })

  it('does not reinstall an already verified runtime', async () => {
    const electronPackageDirectory = await createElectronFixture({
      marker: 'electron.exe',
      includePayload: true
    })

    const result = await ensureElectronRuntime({
      electronPackageDirectory,
      platform: 'win32',
      arch: 'x64',
      log: () => undefined
    })

    expect(result.ready).toBe(true)
    await expect(readFile(join(electronPackageDirectory, 'install-count.txt'), 'utf8')).rejects.toThrow()
  })

  it('fails with a precise retry path when automatic repair cannot run', async () => {
    const electronPackageDirectory = await createElectronFixture({
      marker: 'uninstall',
      includePayload: true,
      installerExitCode: 17
    })

    await expect(
      ensureElectronRuntime({
        electronPackageDirectory,
        platform: 'win32',
        arch: 'x64',
        log: () => undefined
      })
    ).rejects.toEqual(
      expect.objectContaining<ElectronRuntimeSetupError>({
        name: 'ElectronRuntimeSetupError',
        message: expect.stringContaining('exit code 17')
      })
    )

    await expect(
      ensureElectronRuntime({
        electronPackageDirectory,
        platform: 'win32',
        arch: 'x64',
        log: () => undefined
      })
    ).rejects.toThrow('Check network or proxy access to Electron release downloads, then retry `pnpm dev`')
    expect(await readFile(join(electronPackageDirectory, 'path.txt'), 'utf8')).toBe('uninstall')
    expect(await findMarkerQuarantines(electronPackageDirectory)).toEqual([])
  })

  it('rejects marker text that electron-vite would resolve outside the expected executable', async () => {
    const electronPackageDirectory = await createElectronFixture({
      marker: '../foreign.exe',
      includePayload: true,
      installerExitCode: 0,
      installerRepairs: false
    })

    const inspection = await inspectElectronRuntime({ electronPackageDirectory, platform: 'win32', arch: 'x64' })
    expect(inspection.ready).toBe(false)
    expect(inspection.reasons).toContain('path_marker_invalid')

    await expect(
      ensureElectronRuntime({
        electronPackageDirectory,
        platform: 'win32',
        arch: 'x64',
        log: () => undefined
      })
    ).rejects.toThrow('installer exited successfully but left invalid runtime state: path_marker_invalid')
    expect(await readFile(join(electronPackageDirectory, 'path.txt'), 'utf8')).toBe('../foreign.exe')
    expect(await findMarkerQuarantines(electronPackageDirectory)).toEqual([])
  })

  it('bounds an Electron installer that never exits', async () => {
    const electronPackageDirectory = await createElectronFixture({
      marker: 'uninstall',
      includePayload: true,
      installerNeverExits: true
    })

    await expect(
      ensureElectronRuntime({
        electronPackageDirectory,
        platform: 'win32',
        arch: 'x64',
        installerTimeoutMs: 30,
        log: () => undefined
      })
    ).rejects.toThrow('timed out after 30ms')
    expect(await findMarkerQuarantines(electronPackageDirectory)).toEqual([])
  })

  it('rejects a wrong-machine Windows executable before electron-vite can start', async () => {
    const electronPackageDirectory = await createElectronFixture({
      marker: 'electron.exe',
      includePayload: true,
      executableMachine: 'ia32',
      installerRepairs: false
    })
    const inspection = await inspectElectronRuntime({
      electronPackageDirectory,
      platform: 'win32',
      arch: 'x64'
    })
    expect(inspection.reasons).toContain('executable_architecture_mismatch')
    await expect(ensureElectronRuntime({
      electronPackageDirectory,
      platform: 'win32',
      arch: 'x64',
      log: () => undefined
    })).rejects.toThrow('executable_architecture_mismatch')
  })

  it.each([
    ['a truncated executable', 'truncated' as const, 'executable_format_invalid'],
    ['a wrong-machine executable', 'ia32' as const, 'executable_architecture_mismatch']
  ])('invalidates Electron\'s shallow install sentinel before repairing %s', async (
    _label,
    executableMachine,
    expectedReason
  ) => {
    const electronPackageDirectory = await createElectronFixture({
      marker: 'electron.exe',
      includePayload: true,
      executableMachine,
      stockInstallerEarlyReturn: true
    })
    const before = await inspectElectronRuntime({
      electronPackageDirectory,
      platform: 'win32',
      arch: 'x64'
    })
    expect(before.reasons).toContain(expectedReason)

    const result = await ensureElectronRuntime({
      electronPackageDirectory,
      platform: 'win32',
      arch: 'x64',
      log: () => undefined
    })

    expect(result.ready).toBe(true)
    expect(await readFile(join(electronPackageDirectory, 'installer-mode.txt'), 'utf8')).toBe('repaired')
    expect(await findMarkerQuarantines(electronPackageDirectory)).toEqual([])
  })

  it('scrubs cross-target installer overrides and pins the host target', () => {
    const environment = hostElectronInstallEnvironment({
      Path: 'C:\\Windows',
      ELECTRON_INSTALL_ARCH: 'ia32',
      npm_config_platform: 'linux'
    })
    expect(environment).toMatchObject({
      Path: 'C:\\Windows',
      ELECTRON_INSTALL_ARCH: process.arch,
      ELECTRON_INSTALL_PLATFORM: process.platform
    })
    expect(environment).not.toHaveProperty('npm_config_platform')
  })

  it('scrubs Electron 43 artifact and checksum overrides case-insensitively', () => {
    const unsafeNames = [
      'electron_use_remote_checksums',
      'npm_config_electron_use_remote_checksums',
      'ELECTRON_OVERRIDE_DIST_PATH',
      'ELECTRON_MIRROR',
      'npm_config_electron_mirror',
      'npm_package_config_electron_mirror',
      'ELECTRON_NIGHTLY_MIRROR',
      'npm_config_electron_nightlymirror',
      'npm_config_electron_nightly_mirror',
      'npm_package_config_electron_nightlyMirror',
      'npm_package_config_electron_nightly_mirror',
      'ELECTRON_CUSTOM_DIR',
      'npm_config_electron_customdir',
      'npm_config_electron_custom_dir',
      'npm_package_config_electron_customDir',
      'npm_package_config_electron_custom_dir',
      'ELECTRON_CUSTOM_FILENAME',
      'npm_config_electron_customfilename',
      'npm_config_electron_custom_filename',
      'npm_package_config_electron_customFilename',
      'npm_package_config_electron_custom_filename',
      'ELECTRON_CUSTOM_VERSION',
      'npm_config_electron_customversion',
      'npm_config_electron_custom_version',
      'npm_package_config_electron_customVersion',
      'npm_package_config_electron_custom_version'
    ].map(mixedCase)
    const safeEnvironment = {
      HTTPS_PROXY: 'https://proxy.example.test',
      no_proxy: 'localhost,127.0.0.1',
      NODE_EXTRA_CA_CERTS: 'C:\\certs\\enterprise.pem',
      SSL_CERT_FILE: 'C:\\certs\\root.pem',
      electron_config_cache: 'C:\\electron-cache',
      npm_config_cache: 'C:\\npm-cache',
      ELECTRON_GET_USE_PROXY: '1',
      force_no_cache: 'true'
    }
    const source = {
      ...Object.fromEntries(unsafeNames.map((name) => [name, 'attacker-controlled'])),
      ...safeEnvironment
    }

    const environment = hostElectronInstallEnvironment(source)

    for (const name of unsafeNames) expect(environment).not.toHaveProperty(name)
    expect(environment).toMatchObject(safeEnvironment)
  })
})

async function createElectronFixture({
  marker,
  includePayload,
  installerExitCode = 0,
  installerRepairs = true,
  installerNeverExits = false,
  executableMachine = 'x64',
  stockInstallerEarlyReturn = false
}: {
  marker: string | undefined
  includePayload: boolean
  installerExitCode?: number
  installerRepairs?: boolean
  installerNeverExits?: boolean
  executableMachine?: 'x64' | 'ia32' | 'truncated'
  stockInstallerEarlyReturn?: boolean
}) {
  const root = await canonicalTemporaryDirectory('prime-electron-bootstrap-')
  fixtureRoots.push(root)
  const electronPackageDirectory = join(root, 'electron')
  await mkdir(electronPackageDirectory, { recursive: true })
  await writeFile(
    join(electronPackageDirectory, 'package.json'),
    JSON.stringify({ name: 'electron', version: '43.3.0' }),
    'utf8'
  )

  if (marker !== undefined) {
    await writeFile(join(electronPackageDirectory, 'path.txt'), marker, 'utf8')
  }
  if (includePayload) {
    await writePayload(electronPackageDirectory, executableMachine)
  }

  const repairBody = installerRepairs
    ? `
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true })
fs.writeFileSync(path.join(__dirname, 'dist', 'version'), '43.3.0')
const executable = Buffer.alloc(512)
executable.write('MZ', 0, 'ascii')
executable.writeUInt32LE(0x80, 0x3c)
executable.write('PE\\0\\0', 0x80, 'binary')
executable.writeUInt16LE(0x8664, 0x84)
fs.writeFileSync(path.join(__dirname, 'dist', 'electron.exe'), executable)
fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron.exe')`
    : ''
  await writeFile(
    join(electronPackageDirectory, 'install.js'),
    `const fs = require('node:fs')
const path = require('node:path')
if (${installerExitCode} !== 0) process.exit(${installerExitCode})
if (${installerNeverExits}) setInterval(() => undefined, 1000)
const markerPath = path.join(__dirname, 'path.txt')
const versionPath = path.join(__dirname, 'dist', 'version')
const executablePath = path.join(__dirname, 'dist', 'electron.exe')
const stockSentinelSaysInstalled =
  fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf8') === 'electron.exe' &&
  fs.existsSync(versionPath) && fs.readFileSync(versionPath, 'utf8') === '43.3.0' &&
  fs.existsSync(executablePath)
if (${stockInstallerEarlyReturn} && stockSentinelSaysInstalled) {
  fs.writeFileSync(path.join(__dirname, 'installer-mode.txt'), 'early-return')
  process.exit(0)
}
${repairBody}
fs.writeFileSync(path.join(__dirname, 'installer-mode.txt'), 'repaired')
const countPath = path.join(__dirname, 'install-count.txt')
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0
fs.writeFileSync(countPath, String(count + 1))
`,
    'utf8'
  )

  return electronPackageDirectory
}

async function writePayload(
  electronPackageDirectory: string,
  machine: 'x64' | 'ia32' | 'truncated' = 'x64'
) {
  const distributionDirectory = join(electronPackageDirectory, 'dist')
  await mkdir(distributionDirectory, { recursive: true })
  await writeFile(join(distributionDirectory, 'version'), '43.3.0', 'utf8')
  if (machine === 'truncated') {
    await writeFile(join(distributionDirectory, 'electron.exe'), Buffer.from('M'))
    return
  }
  const executable = Buffer.alloc(512)
  executable.write('MZ', 0, 'ascii')
  executable.writeUInt32LE(0x80, 0x3c)
  executable.write('PE\0\0', 0x80, 'binary')
  executable.writeUInt16LE(machine === 'x64' ? 0x8664 : 0x014c, 0x84)
  await writeFile(join(distributionDirectory, 'electron.exe'), executable)
}

async function findMarkerQuarantines(electronPackageDirectory: string) {
  return (await readdir(electronPackageDirectory)).filter((name) =>
    name.startsWith('.prime-electron-path-')
  )
}

function mixedCase(name: string) {
  let letter = 0
  return [...name].map((character) => {
    if (!/[a-z]/i.test(character)) return character
    const result = letter % 2 === 0 ? character.toLowerCase() : character.toUpperCase()
    letter += 1
    return result
  }).join('')
}
