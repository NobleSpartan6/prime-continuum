import { resolve } from 'node:path'
import {
  requireCoordinatorRunId,
  runSelfBuild,
  SelfBuildFailure,
  verifyReceiptFile,
} from './self-build-lib.mjs'

main().catch(reportFailure)

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--verify-receipt') {
    if (args.length !== 2) throw new Error('Usage: pnpm verify:self-build-receipt -- <receipt.json>')
    const envelope = await verifyReceiptFile(resolve(args[1]))
    process.stdout.write(`${JSON.stringify({ digestMatches: true, authenticated: false, runId: envelope.receipt.runId, outcome: envelope.receipt.outcome, receiptSha256: envelope.receiptSha256 }, null, 2)}\n`)
    return
  }
  const options = parseSelfBuildArguments(args)
  const result = await runSelfBuild(options)
  process.stdout.write(`${JSON.stringify({ passed: true, receipt: result.relativeReceiptPath, receiptSha256: result.envelope.receiptSha256 }, null, 2)}\n`)
}

export function parseSelfBuildArguments(args) {
  if (args.length === 0) return { retainFailedWorktree: false }
  if (args.length === 1 && args[0] === '--retain-failed-worktree') {
    return { retainFailedWorktree: true }
  }
  if (args.length === 2 && args[0] === '--coordinator-run-id') {
    return {
      retainFailedWorktree: false,
      coordinatorRunId: requireCoordinatorRunId(args[1]),
    }
  }
  throw new Error('Usage: pnpm self-build [--retain-failed-worktree]')
}

function reportFailure(error) {
  if (error instanceof SelfBuildFailure) {
    process.stderr.write(`${error.message}\nReceipt SHA-256: ${error.receiptSha256}\n`)
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  }
  process.exitCode = 1
}
