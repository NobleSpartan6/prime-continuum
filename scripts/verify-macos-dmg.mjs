import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  assertMacosDmgDistributionConfiguration,
  assertMacosSystemToolCustody,
} from './macos-packaging-policy.mjs'
import { parseJsonObject } from './macos-package-verification-lib.mjs'
import {
  prepareMacosDmgArtifactDestinations,
  projectRelative,
  verifyMacosDmg,
} from './macos-dmg-verification-lib.mjs'
import { assertReviewedBuildResources } from './windows-packaging-policy.mjs'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')

async function main() {
  const args = process.argv.slice(2)
  invariant(
    args.length <= 1 && (args.length === 0 || args[0] === '--config-only' || args[0] === '--prepare'),
    'Usage: node scripts/verify-macos-dmg.mjs [--config-only|--prepare]',
  )
  const projectPackage = parseJsonObject(await readFile(resolve(PROJECT_ROOT, 'package.json')), 'The project package manifest')
  const configuration = assertMacosDmgDistributionConfiguration(projectPackage, {
    projectRoot: PROJECT_ROOT,
    arch: process.arch,
  })
  if (args[0] === '--prepare') {
    await prepareMacosDmgArtifactDestinations({ projectRoot: PROJECT_ROOT, projectPackage, arch: process.arch })
    console.log(JSON.stringify({ prepared: projectRelative(PROJECT_ROOT, configuration.artifactPath) }, null, 2))
    return
  }
  if (args[0] === '--config-only') {
    await Promise.all([
      assertReviewedBuildResources({ projectRoot: PROJECT_ROOT }),
      assertMacosSystemToolCustody(),
    ])
    console.log(JSON.stringify({
      artifact: projectRelative(PROJECT_ROOT, configuration.artifactPath),
      checksum: projectRelative(PROJECT_ROOT, configuration.checksumPath),
      target: configuration.target,
      arch: configuration.arch,
      identity: configuration.identity,
      notarized: configuration.notarized,
    }, null, 2))
    return
  }
  const result = await verifyMacosDmg({ projectRoot: PROJECT_ROOT, projectPackage, arch: process.arch })
  console.log(JSON.stringify({
    artifact: projectRelative(PROJECT_ROOT, result.configuration.artifactPath),
    checksum: projectRelative(PROJECT_ROOT, result.configuration.checksumPath),
    bytes: result.artifact.bytes,
    sha256: result.artifact.sha256,
    image: result.image,
    mountedEntries: result.verification.mountedEntries,
    mountedApplication: result.verification.packageEvidence,
  }, null, 2))
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
