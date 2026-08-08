import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const WINDOWS_ARTIFACT_TEMPLATE = 'Prime-Continuim-${version}-windows-${arch}-setup.${ext}'
const REVIEWED_BUILD_KEYS = [
  'appId',
  'afterPack',
  'asar',
  'directories',
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
    ['enableEmbeddedAsarIntegrityValidation', 'onlyLoadAppFromAsar'],
    'build.electronFuses',
  )
  assertExactBoolean(build.electronFuses, 'enableEmbeddedAsarIntegrityValidation', true, 'build.electronFuses')
  assertExactBoolean(build.electronFuses, 'onlyLoadAppFromAsar', true, 'build.electronFuses')

  assertExactStringArray(build.files, REVIEWED_FILES, 'build.files')

  invariant(Array.isArray(build.extraResources) && build.extraResources.length === 2, 'build.extraResources must contain only the reviewed host and runtime resources.')
  const hostResource = build.extraResources[0]
  assertObject(hostResource, 'build.extraResources[0]')
  assertExactKeys(hostResource, ['from', 'to'], 'build.extraResources[0]')
  invariant(hostResource.from === 'out/hostd/hostd.cjs', 'build.extraResources[0].from must select the attested host service.')
  invariant(hostResource.to === 'hostd/hostd.cjs', 'build.extraResources[0].to must use the reviewed host resource destination.')

  const runtimeResource = build.extraResources[1]
  assertObject(runtimeResource, 'build.extraResources[1]')
  assertExactKeys(runtimeResource, ['filter', 'from', 'to'], 'build.extraResources[1]')
  invariant(runtimeResource.from === 'out/runtime', 'build.extraResources[1].from must select the verified runtime tree.')
  invariant(runtimeResource.to === 'runtime-seed', 'build.extraResources[1].to must use the reviewed runtime resource destination.')
  assertExactStringArray(runtimeResource.filter, ['current.json', 'installs/**/*'], 'build.extraResources[1].filter')

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

  assertObject(build.mac, 'build.mac')
  assertExactKeys(build.mac, ['category', 'target'], 'build.mac')
  invariant(build.mac.target === 'dmg', 'build.mac.target must remain the reviewed DMG target.')
  invariant(build.mac.category === 'public.app-category.developer-tools', 'build.mac.category must remain the reviewed developer-tools category.')

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
