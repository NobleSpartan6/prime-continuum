import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import {
  assertWindowsInstallerConfiguration,
  WINDOWS_PACKAGING_DENIED_ENVIRONMENT_KEYS,
} from './windows-packaging-policy.mjs'

export const MACOS_DMG_ARTIFACT_TEMPLATE = 'Prime-Continuim-${version}-macos-${arch}.${ext}'
export const MACOS_REVIEWED_SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const REVIEWED_PACKAGING_BIN = resolve(import.meta.dirname, 'packaging-bin')
const REVIEWED_PNPM_SHIM = resolve(REVIEWED_PACKAGING_BIN, 'pnpm')
const REVIEWED_PNPM_SHIM_SHA256 = '08e0e42c3637bc043bb6345bcf2af6ab2f8bb762ab02c1ee99a6150fd4db961b'
const REVIEWED_SYSTEM_TOOLS = Object.freeze([
  '/usr/bin/codesign',
  '/usr/bin/ditto',
  '/usr/bin/hdiutil',
  '/usr/bin/osascript',
  '/usr/bin/plutil',
  '/usr/bin/sips',
  '/usr/bin/xcrun',
  '/usr/sbin/diskutil',
])

export const MACOS_PACKAGING_DENIED_ENVIRONMENT_KEYS = Object.freeze([
  ...new Set([
    ...WINDOWS_PACKAGING_DENIED_ENVIRONMENT_KEYS,
    'APPLE_API_ISSUER',
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_ID',
    'APPLE_KEYCHAIN',
    'APPLE_KEYCHAIN_PROFILE',
    'APPLE_TEAM_ID',
    'CUSTOM_DMGBUILD_PATH',
    'ELECTRON_BUILDER_COMPRESSION_LEVEL',
    'PRIME_CONTINUIM_INTERNAL_PNPM_CLI',
  ]),
])

const DENIED_ENVIRONMENT_KEYS = new Set(MACOS_PACKAGING_DENIED_ENVIRONMENT_KEYS)
const REVIEWED_AD_HOC_ENVIRONMENT = Object.freeze({
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
})

export function createMacosElectronBuilderArguments({ arch = process.arch, directoryOnly = true } = {}) {
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Prime Continuim has no reviewed macOS package architecture for ${arch}.`)
  }
  return Object.freeze([
    'exec',
    'electron-builder',
    '--mac',
    ...(directoryOnly ? ['--dir'] : ['dmg']),
    `--${arch}`,
    '--publish',
    'never',
  ])
}

export function createMacosDmgBuilderPlan({ arch = process.arch } = {}) {
  return Object.freeze([
    Object.freeze({
      kind: 'node',
      label: 'Verify the reviewed macOS DMG policy',
      script: 'scripts/verify-macos-dmg.mjs',
      args: Object.freeze(['--config-only']),
    }),
    Object.freeze({
      kind: 'node',
      label: 'Prepare exact macOS DMG destinations',
      script: 'scripts/verify-macos-dmg.mjs',
      args: Object.freeze(['--prepare']),
    }),
    Object.freeze({
      kind: 'pnpm',
      label: 'Create the ad-hoc macOS DMG',
      args: createMacosElectronBuilderArguments({ arch, directoryOnly: false }),
    }),
  ])
}

export function createMacosPackagingBuilderPlan({ arch = process.arch } = {}) {
  return Object.freeze([
    Object.freeze({
      kind: 'node',
      label: 'Verify the reviewed macOS development packaging policy',
      script: 'scripts/verify-macos-package.mjs',
      args: Object.freeze(['--config-only']),
    }),
    Object.freeze({
      kind: 'pnpm',
      label: 'Create the ad-hoc macOS application directory',
      args: createMacosElectronBuilderArguments({ arch }),
    }),
  ])
}

export function createMacosPackagingEnvironment(source = process.env) {
  const pnpmCli = source.npm_execpath
  invariant(
    typeof pnpmCli === 'string' && isAbsolute(pnpmCli) && basename(pnpmCli).toLowerCase().includes('pnpm') && !/[\0\r\n]/.test(pnpmCli),
    'The macOS packaging environment requires the exact parent pnpm CLI.',
  )
  const result = {}
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toUpperCase()
    if (
      !DENIED_ENVIRONMENT_KEYS.has(normalizedKey) &&
      !normalizedKey.startsWith('DYLD_') &&
      normalizedKey !== 'PATH' &&
      value !== undefined
    ) result[key] = value
  }
  return {
    ...result,
    PATH: createMacosReviewedPath(),
    PRIME_CONTINUIM_INTERNAL_PNPM_CLI: pnpmCli,
    ...REVIEWED_AD_HOC_ENVIRONMENT,
  }
}

export function createMacosReviewedPath(nodeExecutable = process.execPath) {
  invariant(typeof nodeExecutable === 'string' && isAbsolute(nodeExecutable) && !/[\0\r\n:]/.test(nodeExecutable), 'The packaging Node executable path is unsafe.')
  const nodeBin = dirname(nodeExecutable)
  return `${MACOS_REVIEWED_SYSTEM_PATH}:${REVIEWED_PACKAGING_BIN}:${nodeBin}`
}

export async function assertMacosSystemToolCustody() {
  invariant(process.platform === 'darwin', `macOS packaging tools are unavailable on ${process.platform}.`)
  for (const path of REVIEWED_SYSTEM_TOOLS) {
    const metadata = await lstat(path)
    invariant(
      metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === 0 && (metadata.mode & 0o111) !== 0,
      `${path} is not the reviewed root-owned executable.`,
    )
  }
  const entries = await readdir(REVIEWED_PACKAGING_BIN, { withFileTypes: true })
  invariant(entries.length === 1 && entries[0]?.name === 'pnpm' && entries[0].isFile(), 'The reviewed macOS packaging bin contains unexpected tools.')
  const [shim, shimBytes] = await Promise.all([lstat(REVIEWED_PNPM_SHIM), readFile(REVIEWED_PNPM_SHIM)])
  invariant(shim.isFile() && !shim.isSymbolicLink() && (shim.mode & 0o111) !== 0, 'The reviewed pnpm packaging shim is not executable.')
  invariant(createHash('sha256').update(shimBytes).digest('hex') === REVIEWED_PNPM_SHIM_SHA256, 'The reviewed pnpm packaging shim bytes changed.')
}

export function resolveMacosPackageDirectory(projectRoot, arch = process.arch) {
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Prime Continuim has no reviewed macOS package architecture for ${arch}.`)
  }
  return resolve(projectRoot, 'release', arch === 'arm64' ? 'mac-arm64' : 'mac')
}

export function resolveMacosDmgArtifact(projectRoot, projectPackage, arch = process.arch) {
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Prime Continuim has no reviewed macOS package architecture for ${arch}.`)
  }
  invariant(projectPackage?.productName === undefined, 'productName must remain under the reviewed Electron Builder configuration.')
  invariant(projectPackage?.build?.productName === 'Prime Continuim', 'build.productName must remain Prime Continuim.')
  invariant(projectPackage?.build?.artifactName === undefined, 'A custom global artifactName is not reviewed for macOS distribution.')
  invariant(projectPackage?.build?.mac?.artifactName === undefined, 'A custom macOS artifactName is not reviewed.')
  invariant(projectPackage?.build?.mac?.target === 'dmg', 'The macOS distribution target must remain dmg.')
  invariant(projectPackage?.build?.dmg?.artifactName === MACOS_DMG_ARTIFACT_TEMPLATE, 'The macOS DMG artifact template changed without review.')
  invariant(typeof projectPackage?.version === 'string' && /^\d+\.\d+\.\d+$/.test(projectPackage.version), 'package.json version must be a three-part numeric version.')
  const values = {
    version: projectPackage.version,
    arch,
    ext: 'dmg',
  }
  const artifactName = MACOS_DMG_ARTIFACT_TEMPLATE.replace(/\$\{([^}]+)\}/g, (_match, macro) => {
    invariant(Object.hasOwn(values, macro), `Unsupported macOS artifact-name macro: ${macro}.`)
    return values[macro]
  })
  invariant(!artifactName.includes('${'), 'The macOS DMG artifact name contains an unresolved macro.')
  invariant(artifactName === artifactName.trim() && !artifactName.includes('/') && !artifactName.includes('\\'), 'The macOS DMG artifact template did not produce a safe file name.')
  const artifactPath = resolve(projectRoot, 'release', artifactName)
  const releaseRoot = resolve(projectRoot, 'release')
  const legacyNames = new Set([
    `Prime Continuim-${projectPackage.version}-${arch}.dmg`,
    ...(arch === 'x64' ? [`Prime Continuim-${projectPackage.version}.dmg`] : []),
  ])
  return Object.freeze({
    artifactName,
    artifactPath,
    blockmapPath: `${artifactPath}.blockmap`,
    checksumPath: `${artifactPath}.sha256`,
    updateMetadataPath: resolve(releaseRoot, 'latest-mac.yml'),
    verificationJournalPath: resolve(releaseRoot, '.prime-continuim-dmg-verification-v1.json'),
    legacyArtifactPaths: Object.freeze([...legacyNames].flatMap((name) => {
      const path = resolve(releaseRoot, name)
      return [path, `${path}.blockmap`, `${path}.sha256`]
    })),
  })
}

export function assertMacosDevelopmentPackageConfiguration(projectPackage, { projectRoot }) {
  // This validator deliberately reuses the existing exact whole-build key
  // allowlist. A macOS package must not weaken the Windows artifact policy or
  // gain an unreviewed Electron Builder hook merely because it is directory-only.
  assertWindowsInstallerConfiguration(projectPackage, { projectRoot })
  const mac = projectPackage?.build?.mac
  invariant(mac?.identity === '-', 'build.mac.identity must select only the ad-hoc development identity.')
  invariant(mac?.notarize === false, 'build.mac.notarize must remain disabled for local development packaging.')
  invariant(mac?.target === 'dmg', 'The configured distributable target must remain reviewed even though pnpm package forces --dir.')
  return Object.freeze({
    identity: 'ad-hoc',
    notarized: false,
    directoryOnly: true,
    packageDirectory: resolveMacosPackageDirectory(projectRoot),
  })
}

export function assertMacosDmgDistributionConfiguration(projectPackage, { projectRoot, arch = process.arch }) {
  const development = assertMacosDevelopmentPackageConfiguration(projectPackage, { projectRoot })
  const artifact = resolveMacosDmgArtifact(projectRoot, projectPackage, arch)
  return Object.freeze({
    identity: development.identity,
    notarized: development.notarized,
    target: 'dmg',
    arch,
    ...artifact,
  })
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}
