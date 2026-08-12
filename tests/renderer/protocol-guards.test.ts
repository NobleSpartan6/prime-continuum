import { describe, expect, it } from 'vitest'
import {
  InProgressStreamSchema,
  ResidentBrowserExecutionSchema,
  ResidentLifecycleDispositionSchema,
  ResidentLifecycleStatusSchema,
  RuntimeResourceInventorySchema,
} from '../../src/shared/protocol'
import {
  parseInProgressStream,
  parseResidentBrowserExecution,
  parseResidentLifecycleDisposition,
  parseResidentLifecycleLookupResult,
  parseResidentLifecycleStatus,
  parseRuntimeResourceInventory,
} from '../../src/renderer/src/protocol-guards'

const cursor = {
  threadId: 'thread-1',
  executionGenerationId: 'generation-1',
  generation: 'daemon-1',
  sequence: 8,
}

const lifecycleStatus = {
  version: 1,
  kind: 'provision',
  operationId: 'operation-1',
  phase: 'committed',
  expectedHostId: 'host-1',
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  threadId: 'thread-1',
  executionGenerationId: 'generation-1',
  preparedAt: '2026-08-10T20:00:00.000Z',
  updatedAt: '2026-08-10T20:00:01.000Z',
  terminalAt: '2026-08-10T20:00:01.000Z',
}

const inventory = {
  skills: [{ name: 'playwright-cli', description: 'Verified browser controls.' }],
  prompts: [],
  themes: [],
  extensions: {
    count: 1,
    sourceKinds: [{ scope: 'project', origin: 'top-level' }],
  },
  contextFileCount: 1,
  diagnostics: { warningCount: 0, errorCount: 0, collisions: [] },
}

function expectParity<T>(
  values: unknown[],
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  guard: (value: unknown) => { success: boolean; data?: T },
): void {
  for (const value of values) {
    const expected = schema.safeParse(value)
    const received = guard(value)
    expect(received.success, JSON.stringify(value)).toBe(expected.success)
    if (expected.success && received.success) expect(received.data).toEqual(expected.data)
  }
}

describe('renderer startup protocol guards', () => {
  it('matches the canonical stream, browser, and lifecycle disposition schemas', () => {
    expectParity(
      [
        { blockId: 'block-1', text: '', startedAt: '2026-08-10T20:00:00.000Z' },
        { blockId: 'block-1', text: 'live', startedAt: '2026-08-10T20:00:00.000Z', ignored: true },
        { blockId: '', text: 'live', startedAt: '2026-08-10T20:00:00.000Z' },
        { blockId: 'block-1', text: 'live', startedAt: 'not-a-date' },
      ],
      InProgressStreamSchema,
      parseInProgressStream,
    )
    expectParity(
      [
        { readiness: 'unavailable' },
        { readiness: 'unavailable', extra: true },
        {
          readiness: 'ready',
          protocol: 'prime-continuim.browser.v1',
          surface: 'playwright-cli',
          controller: 'playwright-core/1.63.0-alpha-2026-08-05',
          engine: 'verified-electron-host',
        },
        {
          readiness: 'ready',
          protocol: 'prime-continuim.browser.v1',
          surface: 'playwright-cli',
          controller: 'ambient-playwright',
          engine: 'verified-electron-host',
        },
      ],
      ResidentBrowserExecutionSchema,
      parseResidentBrowserExecution,
    )
    expectParity(
      [
        {
          version: 1,
          state: 'ended',
          operationId: 'operation-1',
          bindingFingerprint: 'a'.repeat(64),
          endedAt: '2026-08-10T20:00:00.000Z',
          sourceCursor: cursor,
          reason: 'user_end',
        },
        {
          version: 1,
          state: 'ended',
          operationId: 'operation-1',
          bindingFingerprint: 'A'.repeat(64),
          endedAt: '2026-08-10T20:00:00.000Z',
          sourceCursor: cursor,
          reason: 'user_end',
        },
      ],
      ResidentLifecycleDispositionSchema,
      parseResidentLifecycleDisposition,
    )
  })

  it('matches lifecycle state-machine and resource-inventory validation', () => {
    expectParity(
      [
        lifecycleStatus,
        { ...lifecycleStatus, terminalAt: undefined },
        {
          ...lifecycleStatus,
          phase: 'quarantined',
          terminalAt: undefined,
          quarantinedFrom: 'owned_observed',
          quarantineReason: 'owned_client_lost',
        },
        {
          ...lifecycleStatus,
          phase: 'quarantined',
          terminalAt: undefined,
          quarantinedFrom: 'kill_dispatching',
          quarantineReason: 'owned_client_lost',
        },
        { ...lifecycleStatus, unexpected: true },
      ],
      ResidentLifecycleStatusSchema,
      parseResidentLifecycleStatus,
    )
    expectParity(
      [
        inventory,
        {
          ...inventory,
          extensions: {
            count: 2,
            sourceKinds: [
              { scope: 'project', origin: 'top-level' },
              { scope: 'project', origin: 'top-level' },
            ],
          },
        },
        { ...inventory, skills: [{ name: 'unsafe\nname' }] },
        { ...inventory, diagnostics: { ...inventory.diagnostics, rawMessage: '/private/path' } },
      ],
      RuntimeResourceInventorySchema,
      parseRuntimeResourceInventory,
    )
  })

  it('decodes only an exact lifecycle lookup envelope', () => {
    expect(parseResidentLifecycleLookupResult({ status: lifecycleStatus })).toEqual({ status: lifecycleStatus })
    expect(parseResidentLifecycleLookupResult({ status: null })).toEqual({ status: null })
    expect(() => parseResidentLifecycleLookupResult({ status: lifecycleStatus, replay: true })).toThrow(
      'invalid resident lifecycle status',
    )
  })
})
