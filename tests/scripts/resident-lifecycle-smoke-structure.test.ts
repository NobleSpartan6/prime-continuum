import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '..', '..')
const smokePath = resolve(projectRoot, 'scripts', 'verify-hostd-resident-lifecycle.mjs')
const smokeSource = readFileSync(smokePath, 'utf8')
const require = createRequire(import.meta.url)
const tscPath = resolve(dirname(require.resolve('typescript')), 'tsc.js')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'prime-continuim-lifecycle-structure-'))
const unresolvedNamePattern = /error TS(?:2304|2305|2307|2552|2580|2614):[^\r\n]*/g

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

function unresolvedNameDiagnostics(path: string): string[] {
  const result = spawnSync(process.execPath, [
    tscPath,
    '--ignoreConfig',
    '--allowJs',
    '--checkJs',
    '--noEmit',
    '--target',
    'ES2024',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--types',
    'node',
    '--typeRoots',
    resolve(projectRoot, 'node_modules', '@types'),
    '--skipLibCheck',
    '--strict',
    'false',
    '--noImplicitAny',
    'false',
    path,
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error) throw result.error
  return `${result.stdout}${result.stderr}`.match(unresolvedNamePattern) ?? []
}

function materializeExpectedBaseCapabilities(): string[] {
  const declarationStart = smokeSource.indexOf('const RESIDENT_COMMAND_CAPABILITY')
  const declarationEnd = smokeSource.indexOf('const require = createRequire', declarationStart)
  expect(declarationStart).toBeGreaterThanOrEqual(0)
  expect(declarationEnd).toBeGreaterThan(declarationStart)
  const declaration = smokeSource.slice(declarationStart, declarationEnd)
  return new Function(`${declaration}; return [...EXPECTED_BASE_CAPABILITIES];`)() as string[]
}

function materializeDaemonAuditSource(): string {
  const declarationStart = smokeSource.indexOf('function daemonAuditSource()')
  expect(declarationStart).toBeGreaterThanOrEqual(0)
  const declaration = smokeSource.slice(declarationStart)
  return new Function(
    'MAX_DAEMON_PROCESS_IDENTITIES',
    `${declaration}; return daemonAuditSource();`,
  )(16) as string
}

type TranscriptBlock = {
  blockId: string
  kind: 'assistant' | 'status' | 'tool' | 'user'
  sequence: number
  text: string
}

function materializeCompletedTurnAssertion(): (
  snapshot: { materializedRecentBlocks: TranscriptBlock[] },
  options?: { allowFollowingTurns?: boolean },
) => void {
  const declarationStart = smokeSource.indexOf('function assertExactCompletedTurn(')
  const declarationEnd = smokeSource.indexOf('function assertExactStoppedTurn(', declarationStart)
  expect(declarationStart).toBeGreaterThanOrEqual(0)
  expect(declarationEnd).toBeGreaterThan(declarationStart)
  const declaration = smokeSource.slice(declarationStart, declarationEnd)
  return new Function(
    'COMPLETED_PROMPT_TEXT',
    'COMPLETED_RESPONSE_TEXT',
    'COMPLETED_COMPACTION_STATUS_TEXT',
    'assertExactMaterializedIndex',
    `${declaration}; return assertExactCompletedTurn;`,
  )(
    'Complete the deterministic packaged resident provider prompt.',
    'Deterministic resident provider completed the packaged prompt.',
    'compaction_outcome\nAuto-compaction skipped: Session is too short to compact — try again once it grows',
    () => undefined,
  ) as (
    snapshot: { materializedRecentBlocks: TranscriptBlock[] },
    options?: { allowFollowingTurns?: boolean },
  ) => void
}

function materializeCanaryTurnAssertion(): (
  snapshot: { materializedRecentBlocks: TranscriptBlock[] },
  expectedPacedCharacters: number,
) => number {
  const declarationStart = smokeSource.indexOf('function assertExactCompletedTurn(')
  const declarationEnd = smokeSource.indexOf('function assertExactMaterializedIndex(', declarationStart)
  expect(declarationStart).toBeGreaterThanOrEqual(0)
  expect(declarationEnd).toBeGreaterThan(declarationStart)
  const declaration = smokeSource.slice(declarationStart, declarationEnd)
  return new Function(
    'COMPLETED_PROMPT_TEXT',
    'COMPLETED_RESPONSE_TEXT',
    'COMPLETED_COMPACTION_STATUS_TEXT',
    'PACED_PROMPT_TEXT',
    'PACED_RESPONSE_TEXT',
    'CANARY_PROMPT_TEXT',
    'CANARY_RESPONSE_TEXT',
    'assertExactMaterializedIndex',
    `${declaration}; return assertExactCanaryStoppedTurn;`,
  )(
    'Completed prompt',
    'Completed response',
    'compaction_outcome\nAuto-compaction skipped: Session is too short to compact — try again once it grows',
    'Paced prompt',
    'Paced full response',
    'Canary prompt',
    'Stop replay full response',
    () => undefined,
  ) as (
    snapshot: { materializedRecentBlocks: TranscriptBlock[] },
    expectedPacedCharacters: number,
  ) => number
}

function durableProjectionFixture(sequence: number, updatedAt: string) {
  const latestCursor = {
    threadId: 'thread-1',
    executionGenerationId: 'generation-1',
    generation: 'daemon-generation-1',
    sequence,
  }
  return {
    snapshotVersion: 3,
    thread: {
      threadId: 'thread-1',
      title: 'Resident thread',
      status: 'idle',
      updatedAt,
      lastKnownCursor: latestCursor,
    },
    transcriptBlockIndex: [],
    materializedRecentBlocks: [],
    queueState: { paused: false, pendingCommandIds: [] },
    approvals: [],
    childAgents: [],
    goals: [],
    schedules: [],
    runtime: { runtime: 'prime_agent', model: 'continuim/model' },
    git: { state: 'clean' },
    evidence: { passed: 0, failed: 0 },
    pendingAttention: [],
    latestCursor,
  }
}

function materializeDurableProjectionAssertions(): {
  transition: (before: ReturnType<typeof durableProjectionFixture>, after: ReturnType<typeof durableProjectionFixture>, message: string) => void
  unchanged: (before: ReturnType<typeof durableProjectionFixture>, after: ReturnType<typeof durableProjectionFixture>, message: string) => void
} {
  const declarationStart = smokeSource.indexOf('function durableIdleCommandProjection(')
  const declarationEnd = smokeSource.indexOf('function assertCursorAdvanced(', declarationStart)
  expect(declarationStart).toBeGreaterThanOrEqual(0)
  expect(declarationEnd).toBeGreaterThan(declarationStart)
  const declaration = smokeSource.slice(declarationStart, declarationEnd)
  return new Function(
    'isDeepStrictEqual',
    'assertExactJson',
    `${declaration}; return { transition: assertDurableIdleProjectionTransition, unchanged: assertDurableIdleProjectionUnchanged };`,
  )(
    isDeepStrictEqual,
    (actual: unknown, expected: unknown, message: string) => {
      if (!isDeepStrictEqual(actual, expected)) throw new Error(message)
    },
  ) as {
    transition: (before: ReturnType<typeof durableProjectionFixture>, after: ReturnType<typeof durableProjectionFixture>, message: string) => void
    unchanged: (before: ReturnType<typeof durableProjectionFixture>, after: ReturnType<typeof durableProjectionFixture>, message: string) => void
  }
}

describe('resident lifecycle smoke structure', () => {
  it('requires every packaged local capability in the exact ready-health contract', () => {
    expect(materializeExpectedBaseCapabilities()).toEqual([
      'candidate_evaluation_probe_v1',
      'codex_subscription_v1',
      'resident_control_projection_v1',
      'resident_lifecycle_v1',
      'runtime_integrity_v1',
      'runtime_model_catalog_v1',
      'snapshot_chunks_v1',
    ])
  })

  it('resolves every outer smoke and generated daemon-audit global', () => {
    const daemonAuditPath = resolve(temporaryRoot, 'daemon-audit.mjs')
    writeFileSync(daemonAuditPath, materializeDaemonAuditSource(), { encoding: 'utf8', mode: 0o600 })

    expect(unresolvedNameDiagnostics(smokePath)).toEqual([])
    expect(unresolvedNameDiagnostics(daemonAuditPath)).toEqual([])
  })

  it('detects the missing node:net import that makes readiness time out', () => {
    const regressedPath = resolve(temporaryRoot, 'missing-node-net-import.mjs')
    const regressedSource = smokeSource.replace(/import \{ createConnection \} from "node:net";\r?\n/, '')
    expect(regressedSource).not.toBe(smokeSource)
    writeFileSync(regressedPath, regressedSource, { encoding: 'utf8', mode: 0o600 })

    const diagnostics = unresolvedNameDiagnostics(regressedPath)
    const createConnectionDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.includes("Cannot find name 'createConnection'"),
    )
    expect(createConnectionDiagnostics).toHaveLength(2)
  })

  it('accepts only the exact completed turn and bounded compaction outcome', () => {
    const assertCompletedTurn = materializeCompletedTurnAssertion()
    const exactBlocks: TranscriptBlock[] = [
      {
        blockId: 'user-1',
        kind: 'user',
        sequence: 0,
        text: 'Complete the deterministic packaged resident provider prompt.',
      },
      {
        blockId: 'assistant-1',
        kind: 'assistant',
        sequence: 1,
        text: 'Deterministic resident provider completed the packaged prompt.',
      },
      {
        blockId: 'status-1',
        kind: 'status',
        sequence: 2,
        text: 'compaction_outcome\nAuto-compaction skipped: Session is too short to compact — try again once it grows',
      },
    ]

    expect(() => assertCompletedTurn({ materializedRecentBlocks: exactBlocks })).not.toThrow()
    expect(() => assertCompletedTurn({
      materializedRecentBlocks: [
        ...exactBlocks,
        { blockId: 'later-user', kind: 'user', sequence: 3, text: 'Later command' },
      ],
    }, { allowFollowingTurns: true })).not.toThrow()

    const invalidBlockSets: TranscriptBlock[][] = [
      exactBlocks.slice(0, 2),
      exactBlocks.map((block, index) => index === 2 ? { ...block, text: 'arbitrary status' } : block),
      exactBlocks.map((block, index) => index === 2 ? { ...block, sequence: 3 } : block),
      [...exactBlocks, { blockId: 'extra-user', kind: 'user', sequence: 3, text: 'Unexpected' }],
      [...exactBlocks, { ...exactBlocks[1]!, blockId: 'duplicate-assistant', sequence: 3 }],
    ]
    for (const materializedRecentBlocks of invalidBlockSets) {
      expect(() => assertCompletedTurn({ materializedRecentBlocks })).toThrow(
        'Completed provider Prompt did not materialize its exact transcript turn',
      )
    }
  })

  it('binds each stopped turn to its exact pre-turn compaction outcome', () => {
    const assertCanaryTurn = materializeCanaryTurnAssertion()
    const statusText = 'compaction_outcome\nAuto-compaction skipped: Session is too short to compact — try again once it grows'
    const exactBlocks: TranscriptBlock[] = [
      { blockId: 'completed-user', kind: 'user', sequence: 0, text: 'Completed prompt' },
      { blockId: 'completed-assistant', kind: 'assistant', sequence: 1, text: 'Completed response' },
      { blockId: 'post-completed-status', kind: 'status', sequence: 2, text: statusText },
      { blockId: 'pre-paced-status', kind: 'status', sequence: 3, text: statusText },
      { blockId: 'paced-user', kind: 'user', sequence: 4, text: 'Paced prompt' },
      { blockId: 'paced-assistant', kind: 'assistant', sequence: 5, text: 'Pace\n\nError: Request was aborted' },
      { blockId: 'pre-canary-status', kind: 'status', sequence: 6, text: statusText },
      { blockId: 'canary-user', kind: 'user', sequence: 7, text: 'Canary prompt' },
      { blockId: 'canary-assistant', kind: 'assistant', sequence: 8, text: 'Stop rep\n\nError: Request was aborted' },
    ]

    expect(assertCanaryTurn({ materializedRecentBlocks: exactBlocks }, 4)).toBe(8)
    for (const changedIndex of [3, 6]) {
      const changed = exactBlocks.map((block, index) =>
        index === changedIndex ? { ...block, text: 'unexpected status' } : block)
      expect(() => assertCanaryTurn({ materializedRecentBlocks: changed }, 4)).toThrow()
    }
    expect(() => assertCanaryTurn({
      materializedRecentBlocks: [
        ...exactBlocks.slice(0, 6),
        { blockId: 'unexpected-tool', kind: 'tool', sequence: 6, text: 'unexpected' },
        ...exactBlocks.slice(6).map((block) => ({ ...block, sequence: block.sequence + 1 })),
      ],
    }, 4)).toThrow()
  })

  it('separates stable restart semantics from causal cursor telemetry', () => {
    const assertions = materializeDurableProjectionAssertions()
    const before = durableProjectionFixture(59, '2026-08-08T21:13:40.570Z')
    const reattached = durableProjectionFixture(60, '2026-08-08T21:13:49.582Z')

    expect(() => assertions.transition(before, reattached, 'restart changed semantics')).not.toThrow()
    expect(() => assertions.unchanged(reattached, structuredClone(reattached), 'replay changed state')).not.toThrow()

    const semanticChange = structuredClone(reattached)
    semanticChange.runtime.model = 'continuim/other-model'
    expect(() => assertions.transition(before, semanticChange, 'restart changed semantics')).toThrow(
      'restart changed semantics',
    )
    expect(() => assertions.transition(
      before,
      durableProjectionFixture(58, '2026-08-08T21:13:49.582Z'),
      'cursor regressed',
    )).toThrow('cursor regressed: causal resident cursor metadata is invalid')
    expect(() => assertions.unchanged(before, reattached, 'replay changed state')).toThrow(
      'replay changed state: command replay advanced causal resident metadata',
    )
  })
})
