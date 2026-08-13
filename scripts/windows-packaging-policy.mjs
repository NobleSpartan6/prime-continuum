import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const WINDOWS_ARTIFACT_TEMPLATE = 'Prime-Continuim-${version}-windows-${arch}-setup.${ext}'
export const REVIEWED_ELECTRON_BUILDER_VERSION = '26.15.3'
const REVIEWED_BUILD_KEYS = [
  'appId',
  'afterPack',
  'asar',
  'directories',
  'dmg',
  'electronFuses',
  'extends',
  'extraResources',
  'files',
  'linux',
  'mac',
  'nsis',
  'productName',
  'toolsets',
  'win',
]
const REVIEWED_FILES = [
  'out/**/*',
  '!out/hostd/**/*',
  '!out/runtime/**/*',
  '!out/runtime-cache/**/*',
  '!out/visual-qa/**/*',
]
const REVIEWED_NSIS_KEYS = [
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
]

// Electron Builder reads these names directly from the child environment. They
// can select unchecked local tools, redirect binary acquisition, enable an
// ambient signing identity, or provide credentials/control signals for an
// implicit publisher. Matching is case-insensitive because Windows environment
// names are case-insensitive even though JavaScript objects are not.
export const WINDOWS_PACKAGING_DENIED_ENVIRONMENT_KEYS = Object.freeze([
  '__TEST_S3_PUBLISHER__',
  'APPVEYOR_REPO_TAG_NAME',
  'AWS_ACCESS_KEY_ID',
  'AWS_CONFIG_FILE',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_DEFAULT_PROFILE',
  'AWS_PROFILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SECURITY_TOKEN',
  'AWS_SESSION_TOKEN',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AZURE_CLIENT_CERTIFICATE_PASSWORD',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_SEND_CERTIFICATE_CHAIN',
  'AZURE_PASSWORD',
  'AZURE_TENANT_ID',
  'AZURE_USERNAME',
  'BITBUCKET_TAG',
  'BITBUCKET_TOKEN',
  'BITBUCKET_USERNAME',
  'BITRISE_GIT_TAG',
  'BT_TOKEN',
  'CIRCLE_TAG',
  'CI_BUILD_TAG',
  'CI_COMMIT_TAG',
  'CSC_FOR_PULL_REQUEST',
  'CSC_IDENTITY_AUTO_DISCOVERY',
  'CSC_INSTALLER_KEY_PASSWORD',
  'CSC_INSTALLER_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_KEYCHAIN',
  'CSC_LINK',
  'CSC_NAME',
  'CUSTOM_APP_BUILDER_PATH',
  'DO_KEY_ID',
  'DO_SECRET_KEY',
  'ELECTRON_BUILDER_BINARIES_ALLOW_HTTP',
  'ELECTRON_BUILDER_BINARIES_CUSTOM_DIR',
  'ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL',
  'ELECTRON_BUILDER_BINARIES_MIRROR',
  'ELECTRON_BUILDER_CACHE',
  'ELECTRON_BUILDER_NSIS_DIR',
  'ELECTRON_BUILDER_NSIS_RESOURCES_DIR',
  'ELECTRON_BUILDER_OSSL_SIGNCODE_PATH',
  'ELECTRON_BUILDER_RCEDIT_PATH',
  'ELECTRON_BUILDER_WINDOWS_KITS_PATH',
  'ELECTRON_CUSTOM_DIR',
  'ELECTRON_CUSTOM_FILENAME',
  'ELECTRON_CUSTOM_VERSION',
  'ELECTRON_DOWNLOAD_CACHE_MODE',
  'ELECTRON_MIRROR',
  'ELECTRON_NIGHTLY_MIRROR',
  'EP_DRAFT',
  'EP_GH_IGNORE_TIME',
  'EP_PRE_RELEASE',
  'EP_PRELEASE',
  'GH_TOKEN',
  'GITHUB_REF_NAME',
  'GITHUB_REF_TYPE',
  'GITHUB_RELEASE_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'KEYGEN_TOKEN',
  'NPM_CONFIG_ELECTRON_BUILDER_BINARIES_CUSTOM_DIR',
  'NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR',
  'NPM_CONFIG_ELECTRON_CUSTOM_DIR',
  'NPM_CONFIG_ELECTRON_CUSTOM_FILENAME',
  'NPM_CONFIG_ELECTRON_CUSTOM_VERSION',
  'NPM_CONFIG_ELECTRON_MIRROR',
  'NPM_CONFIG_ELECTRON_NIGHTLY_MIRROR',
  'NPM_PACKAGE_CONFIG_ELECTRON_BUILDER_BINARIES_CUSTOM_DIR',
  'NPM_PACKAGE_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR',
  'NPM_PACKAGE_CONFIG_ELECTRON_CUSTOM_DIR',
  'NPM_PACKAGE_CONFIG_ELECTRON_CUSTOM_FILENAME',
  'NPM_PACKAGE_CONFIG_ELECTRON_CUSTOM_VERSION',
  'NPM_PACKAGE_CONFIG_ELECTRON_MIRROR',
  'NPM_PACKAGE_CONFIG_ELECTRON_NIGHTLY_MIRROR',
  'NODE_OPTIONS',
  'PUBLISH_FOR_PULL_REQUEST',
  'SIGNTOOL_PATH',
  'TRAVIS_TAG',
  'USE_SYSTEM_7ZA',
  'USE_SYSTEM_APP_BUILDER',
  'USE_SYSTEM_OSSLSIGNCODE',
  'USE_SYSTEM_SIGNCODE',
  'WINDOWS_KITS_PATH',
  'WINDOWS_SIGNTOOL_PATH',
  'WIN_CSC_KEY_PASSWORD',
  'WIN_CSC_LINK',
  'WIN_CSC_NAME',
])

const DENIED_ENVIRONMENT_KEYS = new Set(WINDOWS_PACKAGING_DENIED_ENVIRONMENT_KEYS)
const REVIEWED_UNSIGNED_SIGNING_ENVIRONMENT = Object.freeze({
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  CSC_KEY_PASSWORD: '',
  CSC_LINK: '',
  WIN_CSC_KEY_PASSWORD: '',
  WIN_CSC_LINK: '',
})

export function createWindowsElectronBuilderArguments({ directoryOnly = false } = {}) {
  return Object.freeze([
    'exec',
    'electron-builder',
    ...(directoryOnly ? ['--dir'] : []),
    '--publish',
    'never',
  ])
}

export function createWindowsPackagingBuilderPlan({ directoryOnly = false } = {}) {
  return Object.freeze([
    Object.freeze({
      kind: 'node',
      label: 'Verify the reviewed Windows packaging policy',
      script: 'scripts/verify-windows-installer.mjs',
      args: Object.freeze(['--config-only']),
    }),
    Object.freeze({
      kind: 'pnpm',
      label: directoryOnly
        ? 'Create the unsigned Windows application package'
        : 'Create the unsigned Windows installer',
      args: createWindowsElectronBuilderArguments({ directoryOnly }),
    }),
  ])
}

export function createWindowsPackagingEnvironment(source = process.env) {
  const result = {}
  for (const [key, value] of Object.entries(source)) {
    if (!DENIED_ENVIRONMENT_KEYS.has(key.toUpperCase()) && value !== undefined) result[key] = value
  }
  return { ...result, ...REVIEWED_UNSIGNED_SIGNING_ENVIRONMENT }
}

export function assertWindowsInstallerConfiguration(projectPackage, { projectRoot }) {
  assertObject(projectPackage, 'package.json')
  assertObject(projectPackage.devDependencies, 'package.json devDependencies')
  invariant(
    projectPackage.devDependencies['electron-builder'] === REVIEWED_ELECTRON_BUILDER_VERSION,
    `devDependencies.electron-builder must remain ${REVIEWED_ELECTRON_BUILDER_VERSION}.`,
  )
  const build = projectPackage.build
  assertObject(build, 'package.json build')

  invariant(build.extends === null, 'build.extends must be explicitly null; inherited Electron Builder configuration is not reviewed.')
  invariant(build.publish === undefined, 'build.publish must remain absent; packaging is forced to --publish never by the reviewed workflow.')
  assertExactKeys(build, REVIEWED_BUILD_KEYS, 'build')
  invariant(build.appId === 'ai.primeintellect.continuim', 'build.appId must match the reviewed Windows application identity.')
  invariant(build.productName === 'Prime Continuim', 'build.productName must match the reviewed Windows product name.')
  invariant(build.afterPack === 'scripts/after-pack-windows.mjs', 'build.afterPack must use the reviewed Windows resource editor.')
  invariant(build.asar === true, 'build.asar must be explicitly enabled.')

  assertObject(build.electronFuses, 'build.electronFuses')
  assertExactKeys(
    build.electronFuses,
    ['enableEmbeddedAsarIntegrityValidation', 'onlyLoadAppFromAsar', 'runAsNode'],
    'build.electronFuses',
  )
  assertExactBoolean(build.electronFuses, 'enableEmbeddedAsarIntegrityValidation', true, 'build.electronFuses')
  assertExactBoolean(build.electronFuses, 'onlyLoadAppFromAsar', true, 'build.electronFuses')
  assertExactBoolean(build.electronFuses, 'runAsNode', false, 'build.electronFuses')

  assertExactStringArray(build.files, REVIEWED_FILES, 'build.files')

  invariant(Array.isArray(build.extraResources) && build.extraResources.length === 4, 'build.extraResources must contain only the reviewed host, host runtime, browser runtime, and agent runtime resources.')
  const hostResource = build.extraResources[0]
  assertObject(hostResource, 'build.extraResources[0]')
  assertExactKeys(hostResource, ['from', 'to'], 'build.extraResources[0]')
  invariant(hostResource.from === 'out/hostd/hostd.cjs', 'build.extraResources[0].from must select the attested host service.')
  invariant(hostResource.to === 'hostd/hostd.cjs', 'build.extraResources[0].to must use the reviewed host resource destination.')

  const hostRuntimeResource = build.extraResources[1]
  assertObject(hostRuntimeResource, 'build.extraResources[1]')
  assertExactKeys(hostRuntimeResource, ['filter', 'from', 'to'], 'build.extraResources[1]')
  invariant(hostRuntimeResource.from === 'node_modules/node', 'build.extraResources[1].from must select the pnpm-pinned host Node distribution.')
  invariant(hostRuntimeResource.to === 'host-runtime', 'build.extraResources[1].to must use the reviewed host runtime destination.')
  assertExactStringArray(hostRuntimeResource.filter, ['bin/node', 'node.exe', 'LICENSE'], 'build.extraResources[1].filter')

  const browserRuntimeResource = build.extraResources[2]
  assertObject(browserRuntimeResource, 'build.extraResources[2]')
  assertExactKeys(browserRuntimeResource, ['filter', 'from', 'to'], 'build.extraResources[2]')
  invariant(browserRuntimeResource.from === 'node_modules/electron/dist', 'build.extraResources[2].from must select the exact Electron browser distribution.')
  invariant(browserRuntimeResource.to === 'browser-runtime', 'build.extraResources[2].to must use the reviewed browser runtime destination.')
  assertExactStringArray(browserRuntimeResource.filter, ['**/*'], 'build.extraResources[2].filter')

  const runtimeResource = build.extraResources[3]
  assertObject(runtimeResource, 'build.extraResources[3]')
  assertExactKeys(runtimeResource, ['filter', 'from', 'to'], 'build.extraResources[3]')
  invariant(runtimeResource.from === 'out/runtime', 'build.extraResources[3].from must select the verified runtime tree.')
  invariant(runtimeResource.to === 'runtime-seed', 'build.extraResources[3].to must use the reviewed runtime resource destination.')
  assertExactStringArray(runtimeResource.filter, ['current.json', 'installs/**/*'], 'build.extraResources[3].filter')

  assertObject(build.directories, 'build.directories')
  assertExactKeys(build.directories, ['output'], 'build.directories')
  const output = build.directories.output
  invariant(typeof output === 'string' && output.length > 0 && !isAbsolute(output), 'build.directories.output must be a non-empty project-relative path.')
  invariant(output === 'release', 'build.directories.output must use the reviewed release directory.')
  const outputDirectory = resolve(projectRoot, output)
  const relativeOutput = relative(resolve(projectRoot), outputDirectory)
  invariant(relativeOutput.length > 0 && relativeOutput !== '..' && !relativeOutput.startsWith(`..${sep}`), 'build.directories.output must stay inside the project.')

  assertObject(build.toolsets, 'build.toolsets')
  assertExactKeys(build.toolsets, ['winCodeSign'], 'build.toolsets')
  invariant(build.toolsets.winCodeSign === '1.1.0', 'build.toolsets.winCodeSign must use the reviewed split Windows toolset.')

  const windows = build.win
  assertObject(windows, 'build.win')
  assertExactKeys(windows, ['artifactName', 'signAndEditExecutable', 'target'], 'build.win')
  assertExactBoolean(windows, 'signAndEditExecutable', false, 'build.win')
  invariant(Array.isArray(windows.target) && windows.target.length === 1, 'build.win.target must contain only the reviewed NSIS target.')
  const target = windows.target[0]
  assertObject(target, 'build.win.target[0]')
  assertExactKeys(target, ['arch', 'target'], 'build.win.target[0]')
  invariant(target.target === 'nsis', 'build.win.target[0].target must be nsis.')
  assertExactStringArray(target.arch, ['x64'], 'build.win.target[0].arch')

  const nsis = build.nsis
  assertObject(nsis, 'build.nsis')
  assertExactKeys(nsis, REVIEWED_NSIS_KEYS, 'build.nsis')
  assertExactBoolean(nsis, 'oneClick', true, 'build.nsis')
  assertExactBoolean(nsis, 'perMachine', false, 'build.nsis')
  assertExactBoolean(nsis, 'createDesktopShortcut', true, 'build.nsis')
  assertExactBoolean(nsis, 'createStartMenuShortcut', true, 'build.nsis')
  assertExactBoolean(nsis, 'runAfterFinish', true, 'build.nsis')
  assertExactBoolean(nsis, 'deleteAppDataOnUninstall', false, 'build.nsis')
  invariant(nsis.shortcutName === build.productName, 'build.nsis.shortcutName must match build.productName.')
  invariant(nsis.installerIcon === 'build/icon.ico', 'build.nsis.installerIcon must use the reviewed product icon.')
  invariant(nsis.uninstallerIcon === 'build/icon.ico', 'build.nsis.uninstallerIcon must use the reviewed product icon.')
  invariant(nsis.uninstallDisplayName === '${productName} ${version}', 'build.nsis.uninstallDisplayName must include the product name and version.')

  const dmg = build.dmg
  assertObject(dmg, 'build.dmg')
  assertExactKeys(
    dmg,
    ['artifactName', 'backgroundColor', 'format', 'iconSize', 'iconTextSize', 'internetEnabled', 'shrink', 'sign', 'title', 'window', 'writeUpdateInfo'],
    'build.dmg',
  )
  invariant(dmg.artifactName === 'Prime-Continuim-${version}-macos-${arch}.${ext}', 'build.dmg.artifactName must use the reviewed cross-architecture template.')
  invariant(dmg.backgroundColor === '#0b0f0d', 'build.dmg.backgroundColor must use the reviewed Prime surface color.')
  invariant(dmg.format === 'UDZO', 'build.dmg.format must remain the verified zlib-compressed read-only format.')
  invariant(dmg.iconSize === 96 && dmg.iconTextSize === 12, 'build.dmg icon sizing changed without review.')
  assertExactBoolean(dmg, 'internetEnabled', false, 'build.dmg')
  assertExactBoolean(dmg, 'shrink', true, 'build.dmg')
  assertExactBoolean(dmg, 'sign', false, 'build.dmg')
  invariant(dmg.title === 'Prime Continuim ${version}', 'build.dmg.title must use the reviewed volume-title template.')
  assertObject(dmg.window, 'build.dmg.window')
  assertExactKeys(dmg.window, ['height', 'width'], 'build.dmg.window')
  invariant(dmg.window.width === 560 && dmg.window.height === 360, 'build.dmg.window must retain the reviewed dimensions.')
  assertExactBoolean(dmg, 'writeUpdateInfo', false, 'build.dmg')

  assertObject(build.mac, 'build.mac')
  assertExactKeys(build.mac, ['category', 'extendInfo', 'identity', 'notarize', 'signIgnore', 'target'], 'build.mac')
  invariant(build.mac.target === 'dmg', 'build.mac.target must remain the reviewed DMG target.')
  invariant(build.mac.category === 'public.app-category.developer-tools', 'build.mac.category must remain the reviewed developer-tools category.')
  invariant(build.mac.identity === '-', 'build.mac.identity must remain the explicit ad-hoc development identity.')
  invariant(build.mac.notarize === false, 'build.mac.notarize must remain disabled for the local directory package.')
  assertObject(build.mac.extendInfo, 'build.mac.extendInfo')
  const reviewedMacosPrivacyPurposeStrings = {
    NSDesktopFolderUsageDescription: 'Prime Continuim accesses a Desktop workspace only after you choose it.',
    NSDocumentsFolderUsageDescription: 'Prime Continuim accesses a Documents workspace only after you choose it.',
    NSDownloadsFolderUsageDescription: 'Prime Continuim accesses a Downloads workspace only after you choose it.',
    NSNetworkVolumesUsageDescription: 'Prime Continuim accesses a workspace on a network volume only after you choose it.',
    NSRemovableVolumesUsageDescription: 'Prime Continuim accesses a workspace on a removable volume only after you choose it.',
  }
  assertExactKeys(build.mac.extendInfo, Object.keys(reviewedMacosPrivacyPurposeStrings), 'build.mac.extendInfo')
  invariant(
    Object.entries(reviewedMacosPrivacyPurposeStrings).every(([key, value]) => build.mac.extendInfo[key] === value),
    'build.mac.extendInfo must retain the reviewed user-selected workspace purpose strings.',
  )
  invariant(
    Array.isArray(build.mac.signIgnore) &&
      JSON.stringify(build.mac.signIgnore) === JSON.stringify([
        'Contents/Resources/browser-runtime/',
        'Contents/Resources/host-runtime/',
        'Contents/Resources/runtime-seed/',
      ]),
    'build.mac.signIgnore must preserve the exact attested browser Electron, host Node, and runtime seed bytes.',
  )

  assertObject(build.linux, 'build.linux')
  assertExactKeys(build.linux, ['category', 'target'], 'build.linux')
  assertExactStringArray(build.linux.target, ['AppImage', 'deb'], 'build.linux.target')
  invariant(build.linux.category === 'Development', 'build.linux.category must remain the reviewed category.')

  invariant(typeof windows.artifactName === 'string' && windows.artifactName.length > 0, 'build.win.artifactName must be explicit.')
  invariant(windows.artifactName === WINDOWS_ARTIFACT_TEMPLATE, `build.win.artifactName must be ${WINDOWS_ARTIFACT_TEMPLATE}.`)
  invariant(typeof projectPackage.version === 'string' && /^\d+\.\d+\.\d+$/.test(projectPackage.version), 'package.json version must be a three-part numeric version.')
  const artifactName = windows.artifactName.replace(/\$\{([^}]+)\}/g, (_match, macro) => {
    const values = {
      productName: build.productName,
      version: projectPackage.version,
      arch: 'x64',
      ext: 'exe',
    }
    invariant(Object.hasOwn(values, macro), `Unsupported Windows artifact-name macro: ${macro}.`)
    const value = values[macro]
    invariant(typeof value === 'string' && value.length > 0, `Windows artifact-name macro ${macro} has no value.`)
    return value
  })
  invariant(!artifactName.includes('${'), 'The Windows artifact name contains an unresolved macro.')
  invariant(artifactName === artifactName.trim(), 'The Windows artifact name must not have leading or trailing whitespace.')
  invariant(!artifactName.includes('/') && !artifactName.includes('\\'), 'The Windows artifact name must be a file name, not a path.')
  invariant(artifactName.toLowerCase().endsWith('.exe'), 'The Windows installer artifact must use the .exe extension.')

  return {
    artifactName,
    artifactPath: resolve(outputDirectory, artifactName),
    checksumPath: resolve(outputDirectory, `${artifactName}.sha256`),
  }
}

export async function assertReviewedBuildResources({ projectRoot }) {
  const resourceRoot = resolve(projectRoot, 'build')
  const entries = await readdir(resourceRoot, { withFileTypes: true })
  const reviewedNames = new Set(['icon.ico', 'icon.png'])
  for (const entry of entries) {
    const normalizedName = entry.name.toLowerCase()
    if (normalizedName === 'installer.nsi' || normalizedName === 'installer.nsh') {
      throw new Error(`build/${entry.name} must remain absent; Electron Builder auto-discovers it as unreviewed NSIS lifecycle code.`)
    }
    invariant(reviewedNames.has(entry.name), `build/${entry.name} is an unreviewed Electron Builder resource.`)
    const metadata = await lstat(resolve(resourceRoot, entry.name))
    invariant(entry.isFile() && metadata.isFile() && !metadata.isSymbolicLink(), `build/${entry.name} must be a regular file.`)
    invariant(metadata.size > 0, `build/${entry.name} must not be empty.`)
  }
  invariant(entries.length === reviewedNames.size, 'The build resource directory must contain exactly the reviewed product icons.')
}

function assertObject(value, label) {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`)
}

function assertExactBoolean(object, key, expected, label) {
  invariant(object[key] === expected, `${label}.${key} must be explicitly set to ${expected}.`)
}

function assertExactStringArray(value, expected, label) {
  invariant(Array.isArray(value), `${label} must be an array.`)
  invariant(value.length === expected.length, `${label} must contain exactly the reviewed entries.`)
  for (let index = 0; index < expected.length; index += 1) {
    invariant(value[index] === expected[index], `${label}[${index}] must be ${JSON.stringify(expected[index])}.`)
  }
}

function assertExactKeys(object, expected, label) {
  const expectedKeys = [...expected].sort()
  const actualKeys = Object.keys(object).sort()
  const unexpected = actualKeys.filter((key) => !expectedKeys.includes(key))
  invariant(unexpected.length === 0, `${label} contains unreviewed configuration keys: ${unexpected.join(', ')}.`)
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key))
  invariant(missing.length === 0, `${label} is missing reviewed configuration keys: ${missing.join(', ')}.`)
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}
