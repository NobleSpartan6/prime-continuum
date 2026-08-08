import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export class DevelopmentNodeRuntimeError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'DevelopmentNodeRuntimeError'
  }
}

export function readPinnedDevelopmentNodeVersion(projectRoot) {
  const versionPath = resolve(projectRoot, '.node-version')
  let version
  try {
    version = readFileSync(versionPath, 'utf8').trim()
  } catch (cause) {
    throw new DevelopmentNodeRuntimeError(
      `Prime Continuim cannot read its pinned Node.js version from ${versionPath}.`,
      { cause },
    )
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new DevelopmentNodeRuntimeError(
      `Prime Continuim requires .node-version to contain one exact Node.js version; found ${JSON.stringify(version)}.`,
    )
  }
  return version
}

export function readPinnedDevelopmentPnpmVersion(projectRoot) {
  const manifestPath = resolve(projectRoot, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (cause) {
    throw new DevelopmentNodeRuntimeError(
      `Prime Continuim cannot read its package-manager pin from ${manifestPath}.`,
      { cause },
    )
  }
  const match = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? '')
  if (!match) {
    throw new DevelopmentNodeRuntimeError(
      `Prime Continuim requires packageManager to pin one exact pnpm version; found ${JSON.stringify(manifest.packageManager)}.`,
    )
  }
  return match[1]
}

export function assertPinnedDevelopmentNodeRuntime({
  projectRoot,
  actualVersion = process.version,
  execPath = process.execPath,
} = {}) {
  if (!projectRoot) throw new TypeError('projectRoot is required')
  const requiredVersion = readPinnedDevelopmentNodeVersion(projectRoot)
  const normalizedActualVersion = String(actualVersion).replace(/^v/, '')
  if (normalizedActualVersion === requiredVersion) return requiredVersion
  const requiredPnpmVersion = readPinnedDevelopmentPnpmVersion(projectRoot)

  throw new DevelopmentNodeRuntimeError(
    `Prime Continuim repo workflows require Node.js v${requiredVersion}, but this command is running ` +
      `${actualVersion} from ${execPath}. Run \`pnpm install\` with the repo-pinned pnpm v${requiredPnpmVersion} ` +
      `so pnpm can download the pinned runtime, then retry \`pnpm dev\`. If pnpm cannot run, install Node.js v${requiredVersion}, ` +
      'reopen the terminal, and confirm `node --version` before retrying. No workflow lock or build was started.',
  )
}
