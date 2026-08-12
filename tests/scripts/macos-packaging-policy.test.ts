import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertMacosDevelopmentPackageConfiguration,
  assertMacosDmgDistributionConfiguration,
  createMacosDmgBuilderPlan,
  createMacosElectronBuilderArguments,
  createMacosPackagingBuilderPlan,
  createMacosPackagingEnvironment,
  createMacosReviewedPath,
  MACOS_PACKAGING_DENIED_ENVIRONMENT_KEYS,
  resolveMacosPackageDirectory,
} from '../../scripts/macos-packaging-policy.mjs'
import {
  assertDmgTrailer,
  assertDmgImageInfo,
  assertMacosDmgMountEntries,
  assertReadOnlyDiskInfo,
  collectDiskImageDeviceIds,
  recoverMacosDmgVerification,
  resolveAttachedDiskImage,
} from '../../scripts/macos-dmg-verification-lib.mjs'
import {
  assertDistinctExecutableIdentities,
  compareExactDirectoryTrees,
  parseAdHocCodesignDisplay,
  readRequiredMacosFuses,
} from '../../scripts/macos-package-verification-lib.mjs'

const scratchRoots: string[] = []

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('macOS directory packaging policy', () => {
  it('forces an explicit local arm64 directory package without publishing', () => {
    expect(createMacosElectronBuilderArguments({ arch: 'arm64' })).toEqual([
      'exec',
      'electron-builder',
      '--mac',
      '--dir',
      '--arm64',
      '--publish',
      'never',
    ])
    expect(createMacosElectronBuilderArguments({ arch: 'x64' })).toContain('--x64')
    expect(() => createMacosElectronBuilderArguments({ arch: 'ia32' })).toThrow('no reviewed macOS package architecture')
    expect(createMacosPackagingBuilderPlan({ arch: 'arm64' })).toEqual([
      {
        kind: 'node',
        label: 'Verify the reviewed macOS development packaging policy',
        script: 'scripts/verify-macos-package.mjs',
        args: ['--config-only'],
      },
      {
        kind: 'pnpm',
        label: 'Create the ad-hoc macOS application directory',
        args: createMacosElectronBuilderArguments({ arch: 'arm64' }),
      },
    ])
  })

  it('creates an explicit ad-hoc DMG plan without changing the directory package path', async () => {
    expect(createMacosElectronBuilderArguments({ arch: 'arm64', directoryOnly: false })).toEqual([
      'exec',
      'electron-builder',
      '--mac',
      'dmg',
      '--arm64',
      '--publish',
      'never',
    ])
    expect(createMacosDmgBuilderPlan({ arch: 'arm64' })).toEqual([
      {
        kind: 'node',
        label: 'Verify the reviewed macOS DMG policy',
        script: 'scripts/verify-macos-dmg.mjs',
        args: ['--config-only'],
      },
      {
        kind: 'node',
        label: 'Prepare exact macOS DMG destinations',
        script: 'scripts/verify-macos-dmg.mjs',
        args: ['--prepare'],
      },
      {
        kind: 'pnpm',
        label: 'Create the ad-hoc macOS DMG',
        args: createMacosElectronBuilderArguments({ arch: 'arm64', directoryOnly: false }),
      },
    ])
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
    expect(assertMacosDmgDistributionConfiguration(packageJson, {
      projectRoot: resolve('.'),
      arch: 'arm64',
    })).toMatchObject({
      identity: 'ad-hoc',
      notarized: false,
      target: 'dmg',
      arch: 'arm64',
      artifactName: 'Prime-Continuim-0.1.0-macos-arm64.dmg',
      artifactPath: resolve('release', 'Prime-Continuim-0.1.0-macos-arm64.dmg'),
    })
    expect(assertMacosDmgDistributionConfiguration(packageJson, {
      projectRoot: resolve('.'),
      arch: 'x64',
    })).toMatchObject({
      artifactName: 'Prime-Continuim-0.1.0-macos-x64.dmg',
      artifactPath: resolve('release', 'Prime-Continuim-0.1.0-macos-x64.dmg'),
    })
  })

  it('keeps pnpm package platform-aware while preserving the Windows builder plan', async () => {
    const workflow = await readFile(resolve('scripts/run-workflow.mjs'), 'utf8')
    expect(workflow).toContain("process.platform === 'darwin'")
    expect(workflow).toContain('createMacosPackagingBuilderPlan({ arch: process.arch }).map(materializeMacosPackagingStep)')
    expect(workflow).toContain('createWindowsPackagingBuilderPlan({ directoryOnly: true }).map(materializeWindowsPackagingStep)')
    expect(workflow).toContain("nodeStep('Verify the macOS application directory', 'scripts/verify-macos-package.mjs')")
    expect(workflow).toContain('createMacosDmgBuilderPlan({ arch: process.arch }).map(materializeMacosPackagingStep)')
    expect(workflow).toContain("nodeStep('Verify and checksum the macOS DMG', 'scripts/verify-macos-dmg.mjs')")
    expect(workflow).toContain('AD_HOC_MACOS_ENV')
    expect(workflow).toContain('UNSIGNED_WINDOWS_ENV')
  })

  it('removes ambient signing, notarization, publishing, and tool overrides', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/reviewed/tools',
      npm_execpath: '/reviewed/pnpm.cjs',
      PRIME_CONTINUIM_SAFE_INPUT: 'preserved',
      PRIME_CONTINUIM_INTERNAL_PNPM_CLI: '/tmp/poison-pnpm.cjs',
      CUSTOM_DMGBUILD_PATH: '/tmp/unreviewed-dmgbuild',
      ELECTRON_BUILDER_COMPRESSION_LEVEL: '9',
      DYLD_INSERT_LIBRARIES: '/tmp/unreviewed.dylib',
    }
    for (const [index, key] of MACOS_PACKAGING_DENIED_ENVIRONMENT_KEYS.entries()) {
      source[toMixedCase(key)] = `poison-${index}`
    }
    const environment = createMacosPackagingEnvironment(source)
    expect(environment).toMatchObject({
      PATH: createMacosReviewedPath(),
      npm_execpath: '/reviewed/pnpm.cjs',
      PRIME_CONTINUIM_SAFE_INPUT: 'preserved',
      PRIME_CONTINUIM_INTERNAL_PNPM_CLI: '/reviewed/pnpm.cjs',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    })
    expect(environment).not.toHaveProperty('CSC_LINK')
    expect(environment).not.toHaveProperty('CSC_KEY_PASSWORD')
    expect(environment).not.toHaveProperty('CSC_NAME')
    expect(environment).not.toHaveProperty('CUSTOM_DMGBUILD_PATH')
    expect(environment).not.toHaveProperty('ELECTRON_BUILDER_COMPRESSION_LEVEL')
    expect(environment).not.toHaveProperty('DYLD_INSERT_LIBRARIES')
    for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY', 'APPLE_TEAM_ID', 'GH_TOKEN', 'NODE_OPTIONS']) {
      expect(Object.keys(environment)).not.toContain(toMixedCase(key))
    }
    expect(createMacosReviewedPath('/reviewed/node/bin/node')).toBe(
      `/usr/bin:/bin:/usr/sbin:/sbin:${resolve('scripts/packaging-bin')}:/reviewed/node/bin`,
    )
    expect(() => createMacosReviewedPath('relative/node')).toThrow('unsafe')
  })

  it('requires an explicit ad-hoc identity and disabled notarization', async () => {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
    expect(assertMacosDevelopmentPackageConfiguration(packageJson, { projectRoot: resolve('.') })).toEqual({
      identity: 'ad-hoc',
      notarized: false,
      directoryOnly: true,
      packageDirectory: resolveMacosPackageDirectory(resolve('.')),
    })
    for (const [field, value, message] of [
      ['identity', null, 'build.mac is missing reviewed configuration keys'],
      ['notarize', true, 'build.mac.notarize must remain disabled'],
    ] as const) {
      const mutated = structuredClone(packageJson)
      if (value === null) delete mutated.build.mac[field]
      else mutated.build.mac[field] = value
      expect(() => assertMacosDevelopmentPackageConfiguration(mutated, { projectRoot: resolve('.') })).toThrow(message)
    }
  })
})

describe('macOS package verification primitives', () => {
  it('accepts only a UDIF trailer and the reviewed mounted DMG surface', async () => {
    const trailer = Buffer.alloc(512)
    trailer.write('koly', 0, 'ascii')
    expect(assertDmgTrailer(trailer)).toBe(true)
    expect(() => assertDmgTrailer(Buffer.alloc(511))).toThrow('truncated')
    expect(() => assertDmgTrailer(Buffer.alloc(512))).toThrow('no UDIF trailer')

    const root = await mkdtemp(join(tmpdir(), 'prime-macos-dmg-policy-'))
    scratchRoots.push(root)
    const mountRoot = join(root, 'mount')
    const app = join(mountRoot, 'Prime Continuim.app')
    const expectedApp = join(root, 'expected', 'Prime Continuim.app')
    await Promise.all([
      mkdir(join(app, 'Contents', 'Resources'), { recursive: true }),
      mkdir(join(expectedApp, 'Contents', 'Resources'), { recursive: true }),
    ])
    const icon = Buffer.alloc(8)
    icon.write('icns', 0, 'ascii')
    icon.writeUInt32BE(icon.length, 4)
    await Promise.all([
      writeFile(join(mountRoot, '.DS_Store'), Buffer.alloc(4_096)),
      writeFile(join(mountRoot, '.VolumeIcon.icns'), icon),
      writeFile(join(expectedApp, 'Contents', 'Resources', 'icon.icns'), icon),
    ])
    await symlink('/Applications', join(mountRoot, 'Applications'))
    await expect(assertMacosDmgMountEntries(mountRoot, expectedApp)).resolves.toMatchObject({
      appPath: app,
      entries: ['.DS_Store', '.VolumeIcon.icns', 'Applications', 'Prime Continuim.app'],
    })
    await writeFile(join(mountRoot, 'unexpected'), 'drift')
    await expect(assertMacosDmgMountEntries(mountRoot, expectedApp)).rejects.toThrow('exact reviewed Finder surface')
  })

  it('binds one new private read-only disk image and rejects cross-fed or writable devices', () => {
    const artifactPath = resolve('/private/tmp/Prime-Continuim-test.dmg')
    const mountPoint = resolve('/private/tmp/pc-mac-dmg-test/mount')
    const attach = {
      'system-entities': [
        { 'dev-entry': '/dev/disk11s1', 'mount-point': mountPoint },
        { 'dev-entry': '/dev/disk11' },
      ],
    }
    const info = {
      images: [{
        'image-path': artifactPath,
        'image-type': 'UDIF read-only compressed (zlib)',
        writeable: false,
        'image-encrypted': false,
        'system-entities': [
          { 'dev-entry': '/dev/disk11' },
          { 'dev-entry': '/dev/disk11s1', 'mount-point': mountPoint },
        ],
      }],
    }
    expect(collectDiskImageDeviceIds(info)).toEqual(new Set(['/dev/disk11', '/dev/disk11s1']))
    expect(resolveAttachedDiskImage({
      attach,
      info,
      artifactPath,
      mountPoint,
      baselineDeviceIds: new Set(['/dev/disk3']),
    })).toEqual({
      rootDevice: '/dev/disk11',
      mountedDevice: '/dev/disk11s1',
      devices: ['/dev/disk11', '/dev/disk11s1'],
    })
    expect(() => resolveAttachedDiskImage({
      attach,
      info,
      artifactPath,
      mountPoint,
      baselineDeviceIds: new Set(['/dev/disk11']),
    })).toThrow('cross-fed')

    const mountedInfo = {
      BusProtocol: 'Disk Image',
      DeviceNode: '/dev/disk11s1',
      MountPoint: mountPoint,
      Writable: false,
      WritableMedia: false,
      WritableVolume: false,
      WholeDisk: false,
    }
    expect(assertReadOnlyDiskInfo(mountedInfo, { device: '/dev/disk11s1', mountPoint, wholeDisk: false })).toBe(true)
    expect(() => assertReadOnlyDiskInfo({ ...mountedInfo, WritableVolume: true }, {
      device: '/dev/disk11s1', mountPoint, wholeDisk: false,
    })).toThrow('writable')

    expect(assertDmgImageInfo({
      Format: 'UDZO',
      'Format Description': 'UDIF read-only compressed (zlib)',
      Segments: [artifactPath],
      partitions: { 'partition-scheme': 'GUID', burnable: false },
      Properties: {
        Encrypted: false,
        Checksummed: true,
        Compressed: true,
        'Software License Agreement': false,
      },
    }, artifactPath)).toBe(true)
  })

  it.runIf(process.platform === 'darwin')('recovers an exact journaled DMG attachment after its owner exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prime-macos-dmg-recovery-'))
    const scratch = await mkdtemp('/private/tmp/pc-mac-dmg-')
    scratchRoots.push(root, scratch)
    await Promise.all([
      mkdir(join(root, 'release'), { recursive: true }),
      mkdir(join(root, 'source'), { recursive: true }),
      mkdir(join(scratch, 'mount'), { mode: 0o700 }),
    ])
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
    const configuration = assertMacosDmgDistributionConfiguration(packageJson, {
      projectRoot: root,
      arch: process.arch,
    })
    execFileSync('/usr/bin/hdiutil', [
      'create', '-srcfolder', join(root, 'source'), '-fs', 'HFS+', '-volname', 'PrimeContinuimRecovery',
      '-format', 'UDZO', configuration.artifactPath,
    ], { stdio: 'ignore' })
    const parsePlist = (bytes: Buffer) => JSON.parse(execFileSync(
      '/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: bytes, encoding: 'utf8' },
    ))
    const baseline = collectDiskImageDeviceIds(parsePlist(execFileSync('/usr/bin/hdiutil', ['info', '-plist'])))
    const attach = parsePlist(execFileSync('/usr/bin/hdiutil', [
      'attach', '-readonly', '-verify', '-nobrowse', '-noautoopen',
      '-mountpoint', join(scratch, 'mount'), '-plist', configuration.artifactPath,
    ]))
    const rootDevice = attach['system-entities'].find((entity: Record<string, unknown>) =>
      typeof entity['dev-entry'] === 'string' && /^\/dev\/disk\d+$/.test(entity['dev-entry'] as string),
    )?.['dev-entry'] as string
    const attachedDevices = new Set<string>(attach['system-entities'].map((entity: Record<string, string>) => entity['dev-entry']))
    const artifact = await stat(configuration.artifactPath)
    const retiredOwner = spawnSync(process.execPath, ['-e', '']).pid
    const artifactBytes = await readFile(configuration.artifactPath)
    await writeFile(configuration.verificationJournalPath, `${JSON.stringify({
      schemaVersion: 1,
      operationId: '00000000-0000-4000-8000-000000000000',
      ownerPid: retiredOwner,
      createdAt: new Date().toISOString(),
      artifactPath: configuration.artifactPath,
      artifact: {
        dev: artifact.dev,
        ino: artifact.ino,
        size: artifact.size,
        mtimeMs: artifact.mtimeMs,
        sha256: createHash('sha256').update(artifactBytes).digest('hex'),
      },
      scratchRoot: scratch,
      mountPoint: join(scratch, 'mount'),
      baselineDeviceIds: [...baseline].sort(),
    })}\n`, { mode: 0o600 })
    try {
      await expect(recoverMacosDmgVerification(configuration)).resolves.toMatchObject({
        recovered: true,
        devices: [...attachedDevices].sort(),
      })
      const current = collectDiskImageDeviceIds(parsePlist(execFileSync('/usr/bin/hdiutil', ['info', '-plist'])))
      expect([...attachedDevices].every((device) => !current.has(device))).toBe(true)
      await expect(stat(configuration.verificationJournalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      try { execFileSync('/usr/bin/hdiutil', ['detach', '-force', rootDevice], { stdio: 'ignore' }) } catch {}
    }
  // Recovery can spend 30s on a normal detach, 30s on the bounded force fallback,
  // and 15s proving device retirement. Keep the test deadline above that contract.
  }, 90_000)

  it('requires the desktop fuse combination and rejects an enabled RunAsNode fuse', () => {
    const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii')
    const valid = Buffer.concat([Buffer.from('mach-o'), sentinel, Buffer.from([1, 9]), Buffer.from('001111011')])
    expect(readRequiredMacosFuses(valid)).toEqual({ version: 1, wireLength: 9 })
    const invalid = Buffer.concat([Buffer.from('mach-o'), sentinel, Buffer.from([1, 9]), Buffer.from('101111011')])
    expect(() => readRequiredMacosFuses(invalid)).toThrow('RunAsNode must be disabled')
  })

  it('accepts only path-free ad-hoc signature evidence for the exact bundle id', () => {
    const valid = [
      'Executable=/private/tmp/Prime Continuim.app/Contents/MacOS/Prime Continuim',
      'Identifier=ai.primeintellect.continuim',
      'Signature=adhoc',
      'TeamIdentifier=not set',
    ].join('\n')
    expect(parseAdHocCodesignDisplay(valid)).toEqual({
      identity: 'ad-hoc',
      teamIdentifier: null,
      bundleIdentifier: 'ai.primeintellect.continuim',
    })
    expect(() => parseAdHocCodesignDisplay(`${valid}\nAuthority=Developer ID Application: Example`)).toThrow('certificate authority')
  })

  it('compares exact regular trees and requires three distinct executable digests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prime-macos-package-policy-'))
    scratchRoots.push(root)
    const source = join(root, 'source')
    const packaged = join(root, 'packaged')
    await Promise.all([mkdir(join(source, 'nested'), { recursive: true }), mkdir(join(packaged, 'nested'), { recursive: true })])
    await Promise.all([
      writeFile(join(source, 'nested', 'runtime'), 'exact'),
      writeFile(join(packaged, 'nested', 'runtime'), 'exact'),
    ])
    await expect(compareExactDirectoryTrees(source, packaged, 'browser runtime')).resolves.toMatchObject({ files: 1, bytes: 5 })
    await writeFile(join(packaged, 'nested', 'runtime'), 'drift')
    await expect(compareExactDirectoryTrees(source, packaged, 'browser runtime')).rejects.toThrow('does not match')

    const executables = await Promise.all(['desktop', 'host', 'browser'].map(async (name) => {
      const path = join(root, name)
      await writeFile(path, name)
      return { label: name, path }
    }))
    await expect(assertDistinctExecutableIdentities(executables)).resolves.toHaveLength(3)
    await writeFile(executables[2]!.path, 'host')
    await expect(assertDistinctExecutableIdentities(executables)).rejects.toThrow('digests must all differ')
  })
})

function toMixedCase(value: string): string {
  return [...value].map((character, index) =>
    /[a-z]/i.test(character) && index % 2 === 0 ? character.toLowerCase() : character.toUpperCase(),
  ).join('')
}
