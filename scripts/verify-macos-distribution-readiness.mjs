import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyMacosDistributionReadiness } from './macos-distribution-readiness-lib.mjs'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')

export async function main(args = process.argv.slice(2)) {
  if (args[0] === '--') args = args.slice(1)
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--config-only' && args[0] !== '--preflight')) {
    throw new Error('Usage: node scripts/verify-macos-distribution-readiness.mjs [--config-only|--preflight]')
  }
  const [projectPackage, policy] = await Promise.all([
    readJson(resolve(PROJECT_ROOT, 'package.json'), 'package manifest'),
    readJson(resolve(PROJECT_ROOT, 'macos-distribution-policy.json'), 'macOS distribution policy'),
  ])
  const result = await verifyMacosDistributionReadiness({
    projectRoot: PROJECT_ROOT,
    projectPackage,
    policy,
    configOnly: args[0] === '--config-only',
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.status !== 'ready') process.exitCode = 1
  return result
}

async function readJson(path, label) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch (error) {
    throw new Error(`The ${label} is not valid JSON.`, { cause: error })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
