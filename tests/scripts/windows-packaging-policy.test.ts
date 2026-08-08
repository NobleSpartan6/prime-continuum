import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  assertWindowsInstallerConfiguration,
  assertReviewedBuildResources,
  createWindowsElectronBuilderArguments,
  createWindowsPackagingBuilderPlan,
  createWindowsPackagingEnvironment,
  WINDOWS_PACKAGING_DENIED_ENVIRONMENT_KEYS,
} from '../../scripts/windows-packaging-policy.mjs'

const execFileAsync = promisify(execFile)

describe('unsigned Windows development packaging policy', () => {
  it('uses the locked workflow and pure-JavaScript resource editor', async () => {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))

    expect(packageJson.scripts.dev).toBe('node scripts/run-workflow.mjs dev')
    expect(packageJson.scripts.package).toBe('node scripts/run-workflow.mjs package')
    expect(packageJson.scripts.dist).toBe('node scripts/run-workflow.mjs dist')
    expect(packageJson.scripts).not.toHaveProperty('dev:web')
    expect(packageJson.build).toMatchObject({
      afterPack: 'scripts/after-pack-windows.mjs',
      extends: null,
      toolsets: { winCodeSign: '1.1.0' },
      win: { signAndEditExecutable: false },
    })
    expect(packageJson.build).not.toHaveProperty('publish')
    expect(Object.keys(packageJson.build.nsis).sort()).toEqual([
      'createDesktopShortcut',
      'createStartMenuShortcut',
      'deleteAppDataOnUninstall',
      'installerIcon',
      'oneClick',
      'perMachine',
      'runAfterFinish',
      'shortcutName',
      'uninstallDisplayName',
      'uninstallerIcon',
    ])
    expect(packageJson.devDependencies.resedit).toBe('1.7.2')
  })

  it('forces both Electron Builder entry points to remain local-only', async () => {
    expect(createWindowsElectronBuilderArguments({ directoryOnly: true })).toEqual([
      'exec',
      'electron-builder',
      '--dir',
      '--publish',
      'never',
    ])
    expect(createWindowsElectronBuilderArguments()).toEqual([
      'exec',
      'electron-builder',
      '--publish',
      'never',
    ])

    const packagePlan = createWindowsPackagingBuilderPlan({ directoryOnly: true })
    const installerPlan = createWindowsPackagingBuilderPlan()
    for (const plan of [packagePlan, installerPlan]) {
      expect(plan).toHaveLength(2)
      expect(plan[0]).toEqual({
        kind: 'node',
        label: 'Verify the reviewed Windows packaging policy',
        script: 'scripts/verify-windows-installer.mjs',
        args: ['--config-only'],
      })
      expect(plan[1]?.kind).toBe('pnpm')
    }
    expect(packagePlan[1]?.args).toEqual(createWindowsElectronBuilderArguments({ directoryOnly: true }))
    expect(installerPlan[1]?.args).toEqual(createWindowsElectronBuilderArguments())

    const workflowSource = await readFile(resolve('scripts/run-workflow.mjs'), 'utf8')
    expect(workflowSource.match(/createWindowsPackagingBuilderPlan/g)).toHaveLength(3)
    expect(workflowSource).toContain('createWindowsPackagingBuilderPlan({ directoryOnly: true }).map(materializeWindowsPackagingStep)')
    expect(workflowSource).toContain('createWindowsPackagingBuilderPlan().map(materializeWindowsPackagingStep)')
  })

  it('removes case-insensitive tool, signing, and publishing overrides while preserving normal process inputs', () => {
    expect(WINDOWS_PACKAGING_DENIED_ENVIRONMENT_KEYS).toEqual(expect.arrayContaining([
      'ELECTRON_BUILDER_NSIS_DIR',
      'ELECTRON_BUILDER_NSIS_RESOURCES_DIR',
      'ELECTRON_BUILDER_RCEDIT_PATH',
      'ELECTRON_BUILDER_WINDOWS_KITS_PATH',
      'CUSTOM_APP_BUILDER_PATH',
      'USE_SYSTEM_APP_BUILDER',
      'USE_SYSTEM_7ZA',
      'NODE_OPTIONS',
      'ELECTRON_BUILDER_CACHE',
      'ELECTRON_DOWNLOAD_CACHE_MODE',
      'SIGNTOOL_PATH',
      'WINDOWS_KITS_PATH',
      'ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL',
      'ELECTRON_BUILDER_BINARIES_MIRROR',
      'ELECTRON_BUILDER_BINARIES_CUSTOM_DIR',
      'NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR',
      'NPM_CONFIG_ELECTRON_BUILDER_BINARIES_CUSTOM_DIR',
      'PUBLISH_FOR_PULL_REQUEST',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GITLAB_TOKEN',
      'BITBUCKET_TOKEN',
      'KEYGEN_TOKEN',
    ]))
    const poisonedEnvironment: NodeJS.ProcessEnv = {
      Path: 'C:\\reviewed-tools',
      HTTPS_PROXY: 'https://proxy.invalid',
      npm_execpath: 'C:\\pnpm\\pnpm.cjs',
      PRIME_CONTINUIM_SAFE_INPUT: 'preserved',
    }
    for (const [index, key] of WINDOWS_PACKAGING_DENIED_ENVIRONMENT_KEYS.entries()) {
      poisonedEnvironment[toMixedCase(key)] = `unreviewed-${index}`
    }

    const sanitized = createWindowsPackagingEnvironment(poisonedEnvironment)
    expect(sanitized).toMatchObject({
      Path: 'C:\\reviewed-tools',
      HTTPS_PROXY: 'https://proxy.invalid',
      npm_execpath: 'C:\\pnpm\\pnpm.cjs',
      PRIME_CONTINUIM_SAFE_INPUT: 'preserved',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      CSC_LINK: '',
      WIN_CSC_LINK: '',
      CSC_KEY_PASSWORD: '',
      WIN_CSC_KEY_PASSWORD: '',
    })

    const reviewedSigningKeys = new Set([
      'CSC_IDENTITY_AUTO_DISCOVERY',
      'CSC_KEY_PASSWORD',
      'CSC_LINK',
      'WIN_CSC_KEY_PASSWORD',
      'WIN_CSC_LINK',
    ])
    const denied = new Set(WINDOWS_PACKAGING_DENIED_ENVIRONMENT_KEYS)
    const unreviewedAliases = Object.keys(sanitized).filter(
      (key) => denied.has(key.toUpperCase()) && !reviewedSigningKeys.has(key),
    )
    expect(unreviewedAliases).toEqual([])
    expect(Object.keys(sanitized)).not.toContain(toMixedCase('ELECTRON_BUILDER_NSIS_DIR'))
    expect(Object.keys(sanitized)).not.toContain(toMixedCase('GH_TOKEN'))
  })

  it.each([
    {
      name: 'a parent configuration that can inject nsis.include',
      mutate: (packageJson: any) => { packageJson.build.extends = './unreviewed-electron-builder-parent.mjs' },
      message: 'build.extends must be explicitly null',
    },
    {
      name: 'an elevated Windows execution level',
      mutate: (packageJson: any) => { packageJson.build.win.requestedExecutionLevel = 'requireAdministrator' },
      message: 'build.win contains unreviewed configuration keys: requestedExecutionLevel',
    },
    {
      name: 'arbitrary extra files',
      mutate: (packageJson: any) => { packageJson.build.extraFiles = ['unreviewed/**/*'] },
      message: 'build contains unreviewed configuration keys: extraFiles',
    },
    {
      name: 'an additional build hook',
      mutate: (packageJson: any) => { packageJson.build.beforeBuild = 'scripts/unreviewed-hook.mjs' },
      message: 'build contains unreviewed configuration keys: beforeBuild',
    },
    {
      name: 'an arbitrary packaged resource',
      mutate: (packageJson: any) => {
        packageJson.build.extraResources.push({ from: 'unreviewed.bin', to: 'unreviewed.bin' })
      },
      message: 'build.extraResources must contain only the reviewed host and runtime resources',
    },
    {
      name: 'a custom NSIS compiler',
      mutate: (packageJson: any) => {
        packageJson.build.nsis.customNsisBinary = { url: 'file:///unreviewed-nsis.7z', checksum: '00', version: '1' }
      },
      message: 'build.nsis contains unreviewed configuration keys: customNsisBinary',
    },
    {
      name: 'a custom NSIS visual resource',
      mutate: (packageJson: any) => { packageJson.build.nsis.installerSidebar = 'unreviewed.bmp' },
      message: 'build.nsis contains unreviewed configuration keys: installerSidebar',
    },
    {
      name: 'an unexpected top-level build key',
      mutate: (packageJson: any) => { packageJson.build.unreviewed = true },
      message: 'build contains unreviewed configuration keys: unreviewed',
    },
    {
      name: 'an unexpected target key',
      mutate: (packageJson: any) => { packageJson.build.win.target[0].unreviewed = true },
      message: 'build.win.target[0] contains unreviewed configuration keys: unreviewed',
    },
    {
      name: 'an unexpected fuse',
      mutate: (packageJson: any) => { packageJson.build.electronFuses.runAsNode = false },
      message: 'build.electronFuses contains unreviewed configuration keys: runAsNode',
    },
    {
      name: 'an alternate build resource directory',
      mutate: (packageJson: any) => { packageJson.build.directories.buildResources = 'unreviewed-build' },
      message: 'build.directories contains unreviewed configuration keys: buildResources',
    },
    {
      name: 'an alternate Windows toolset',
      mutate: (packageJson: any) => { packageJson.build.toolsets.unreviewed = '1.0.0' },
      message: 'build.toolsets contains unreviewed configuration keys: unreviewed',
    },
  ])('rejects $name before any installer artifact is inspected', async ({ mutate, message }) => {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
    mutate(packageJson)
    expect(() => assertWindowsInstallerConfiguration(packageJson, {
      projectRoot: resolve('C:/artifact-must-not-be-read'),
    })).toThrow(message)
  })

  it('passes the executable installer policy verifier without creating an artifact', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/verify-windows-installer.mjs', '--config-only'], {
      cwd: resolve('.'),
      timeout: 15_000,
      windowsHide: true,
    })
    expect(JSON.parse(stdout)).toMatchObject({
      target: 'nsis',
      arch: 'x64',
      oneClick: true,
      installScope: 'per-user',
    })
  })

  it('rejects Electron Builder auto-discovered NSIS customization', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'prime-continuim-packaging-policy-'))
    const buildDirectory = join(scratch, 'build')
    await mkdir(buildDirectory)
    await Promise.all([
      writeFile(join(buildDirectory, 'icon.ico'), 'reviewed icon fixture', 'utf8'),
      writeFile(join(buildDirectory, 'icon.png'), 'reviewed icon fixture', 'utf8'),
      writeFile(join(buildDirectory, 'installer.nsh'), '!macro customInstall\n!macroend\n', 'utf8'),
    ])
    try {
      await expect(assertReviewedBuildResources({ projectRoot: scratch }))
        .rejects.toThrow('build/installer.nsh must remain absent')
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

function toMixedCase(value: string): string {
  return [...value].map((character, index) =>
    /[a-z]/i.test(character) && index % 2 === 0 ? character.toLowerCase() : character.toUpperCase(),
  ).join('')
}
