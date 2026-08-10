import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  APPCONTAINER_PROBE_GATE_SPECS,
  APPCONTAINER_PROBE_PHASES,
  createAppContainerProbeReceiptEnvelope,
  serializeAppContainerProbeReceiptEnvelope,
} from '../../scripts/windows-appcontainer-probe-lib.mjs'
import { verifyWindowsAppContainerProbeReceiptFile } from '../../scripts/verify-windows-appcontainer-probe.mjs'

const execFileAsync = promisify(execFile)
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Windows AppContainer static receipt verifier', () => {
  it('reads one canonical link-free receipt by stable physical identity', async () => {
    const { receiptPath, bytes } = await writeReceipt()
    const verified = await verifyWindowsAppContainerProbeReceiptFile(receiptPath)

    expect(verified).toMatchObject({
      verifierKind: 'prime_continuim_appcontainer_probe_static_verifier_v2',
      receiptBytes: bytes.byteLength,
      staticVerifierExitCode: 0,
      liveProbeExitCode: 2,
    })
    expect(verified.receiptSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('prints only bounded correlation facts and accepts no live-probe arguments', async () => {
    const { receiptPath } = await writeReceipt()
    const script = resolve('scripts/verify-windows-appcontainer-probe.mjs')
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, '--receipt', receiptPath])

    const output = JSON.parse(stdout)
    expect(stderr).toBe('')
    expect(output).toMatchObject({
      kind: 'prime_continuim_appcontainer_probe_static_verifier_v2',
      outcome: 'functional_passed_vm_disposal_required',
      staticVerifierExitCode: 0,
      liveProbeExitCode: 2,
    })
    expect(stdout).not.toContain(receiptPath)

    await expect(execFileAsync(process.execPath, [script, '--live', receiptPath])).rejects.toMatchObject({
      code: 1,
      stderr: 'Prime Continuim AppContainer receipt verification failed.\n',
    })
  })

  it('rejects corrupted bytes, aliased parents, and multiply-linked receipt files', async () => {
    const { root, receiptPath, bytes } = await writeReceipt()
    await writeFile(receiptPath, Buffer.from(bytes).fill(0x20, 8, 12))
    await expect(verifyWindowsAppContainerProbeReceiptFile(receiptPath)).rejects.toThrow()

    const secondReceipt = join(root, 'second.json')
    await writeFile(secondReceipt, bytes, { flag: 'wx' })
    const aliasParent = join(root, 'alias-parent')
    await symlink(root, aliasParent, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(verifyWindowsAppContainerProbeReceiptFile(join(aliasParent, 'second.json'))).rejects.toThrow(
      /receipt_path_alias/,
    )
    await link(secondReceipt, join(root, 'second-link.json'))
    await expect(verifyWindowsAppContainerProbeReceiptFile(secondReceipt)).rejects.toThrow(/receipt_file_invalid/)
  })

  it('rejects a parent that is replaced by an alias after the receipt was read', async () => {
    const lexicalBase = await mkdtemp(join(tmpdir(), 'prime-appcontainer-verifier-swap-'))
    const base = await realpath(lexicalBase)
    temporaryRoots.push(base)
    const receiptParent = join(base, 'receipt-parent')
    const replacementParent = join(base, 'replacement-parent')
    const movedParent = join(base, 'receipt-parent-moved')
    await Promise.all([mkdir(receiptParent), mkdir(replacementParent)])
    const receiptPath = join(receiptParent, 'receipt.json')
    const replacementPath = join(replacementParent, 'receipt.json')
    const bytes = serializeAppContainerProbeReceiptEnvelope(
      createAppContainerProbeReceiptEnvelope(functionalReceipt()),
    )
    await Promise.all([
      writeFile(receiptPath, bytes, { flag: 'wx' }),
      writeFile(replacementPath, bytes, { flag: 'wx' }),
    ])

    await expect((verifyWindowsAppContainerProbeReceiptFile as any)(receiptPath, {
      beforeFinalPathCheck: async () => {
        await rename(receiptParent, movedParent)
        await symlink(replacementParent, receiptParent, process.platform === 'win32' ? 'junction' : 'dir')
      },
    })).rejects.toThrow(/receipt_path_replaced/)
  })
})

async function writeReceipt() {
  const lexicalRoot = await mkdtemp(join(tmpdir(), 'prime-appcontainer-verifier-'))
  const root = await realpath(lexicalRoot)
  temporaryRoots.push(root)
  const receiptPath = join(root, 'receipt.json')
  const bytes = serializeAppContainerProbeReceiptEnvelope(
    createAppContainerProbeReceiptEnvelope(functionalReceipt()),
  )
  await writeFile(receiptPath, bytes, { flag: 'wx' })
  return { root, receiptPath, bytes }
}

function functionalReceipt(): any {
  return {
    schemaVersion: 2,
    kind: 'prime_continuim_appcontainer_probe_v2',
    outcome: 'functional_passed_vm_disposal_required',
    correlationId: '4'.repeat(32),
    platform: 'win32',
    arch: 'x64',
    admission: {
      status: 'admitted',
      interactive: true,
      ciForbidden: true,
      disposableVm: true,
      checkpointConfirmed: true,
      typedConfirmation: true,
      dedicatedStandardAccount: true,
      operatorNonAdmin: true,
      operatorMediumIntegrity: true,
      operatorNotElevated: true,
      preexistingProvenanceMatched: true,
      dedicatedProbePayload: true,
    },
    provenance: {
      installedCandidate: { role: 'correlation_only_not_executed', sha256: '1'.repeat(64), bytes: 4096 },
      probePayload: { role: 'dedicated_probe_payload_launch_target', sha256: '2'.repeat(64), bytes: 8192 },
    },
    launchPolicy: {
      stableProfileApisOnly: true,
      startupInfoEx: true,
      securityCapabilitiesAttribute: true,
      jobListAtCreateProcess: true,
      inheritHandles: false,
      explicitSanitizedUnicodeEnvironment: true,
      allApplicationPackagesOptOut: true,
      zeroCapabilities: true,
      sealedToolTreeReadExecuteOnly: true,
      scratchAndProfileReadWriteOnly: true,
      noWritableExecutableClosure: true,
      experimentalApi: false,
      fallback: false,
    },
    state: { phases: [...APPCONTAINER_PROBE_PHASES], finalPhase: 'settled' },
    supervisorEvidence: { sha256: '3'.repeat(64), bytes: 1024 },
    gates: APPCONTAINER_PROBE_GATE_SPECS.map(({ id, expected }) => ({ id, expected, observed: expected })),
    cleanup: {
      status: 'complete',
      treeRetired: true,
      profileDeleted: true,
      operationRootDeleted: true,
      publicationMode: 'host_no_replace',
      externalVmDisposalRequired: true,
      externalVmDisposalConfirmed: false,
    },
    claims: {
      productCapability: false,
      candidateEvaluation: false,
      securitySandboxClaim: false,
      mainFilesystemIsolationClaim: false,
      authenticated: false,
      providerBackedEvaluation: false,
      autonomousPromotion: false,
    },
    limitations: {
      controlledSentinelsOnly: true,
      windowsSystemReadsOutsideSentinelsMayRemain: true,
      installedCandidateCorrelationOnly: true,
      installedCandidateExecuted: false,
      candidateEvaluated: false,
      externalVmDisposalRequired: true,
    },
    failure: null,
  }
}
