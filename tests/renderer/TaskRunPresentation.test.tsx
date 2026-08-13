import { describe, expect, it } from 'vitest'

import {
  taskRunPresentation,
  type TaskRunPresentationInput,
} from '../../src/renderer/src/TaskRunPresentation'

function baseline(overrides: Partial<TaskRunPresentationInput> = {}): TaskRunPresentationInput {
  return {
    hostName: 'Studio Mac',
    connection: 'online',
    taskState: 'idle',
    sessionEnded: false,
    sessionNeedsRecovery: false,
    endOperationPresent: false,
    endReadyToFinish: false,
    endPhase: undefined,
    modelReady: true,
    activity: { live: false, fresh: true },
    receipt: { state: 'idle' },
    authority: {
      verified: true,
      mutation: true,
      conflictingMutation: false,
      canStart: true,
      canStop: false,
      canFinishEnd: false,
      canReview: true,
      canSetUpModel: true,
    },
    ...overrides,
  }
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!
}

function randomInput(random: () => number): TaskRunPresentationInput {
  const bool = () => random() >= 0.5
  return baseline({
    hostName: pick(random, ['', 'Studio Mac', 'Remote workstation']),
    connection: pick(random, ['online', 'reconnecting', 'offline'] as const),
    taskState: pick(random, ['idle', 'running', 'waiting', 'needs_approval', 'complete', 'failed'] as const),
    sessionEnded: bool(),
    sessionNeedsRecovery: bool(),
    endOperationPresent: bool(),
    endReadyToFinish: bool(),
    modelReady: bool(),
    activity: { live: bool(), fresh: bool() },
    receipt: {
      state: pick(random, ['idle', 'sending', 'sent', 'queued', 'waiting_for_connection', 'uncertain', 'rejected'] as const),
      operation: pick(random, [undefined, 'prompt', 'abort', 'end'] as const),
      message: bool() ? 'Exact host detail.' : undefined,
      retryable: bool(),
    },
    authority: {
      verified: bool(),
      mutation: bool(),
      conflictingMutation: bool(),
      canStart: bool(),
      canStop: bool(),
      canFinishEnd: bool(),
      canReview: bool(),
      canSetUpModel: bool(),
    },
  })
}

describe('taskRunPresentation', () => {
  it('is total and deterministic across a seeded contradictory-state corpus', () => {
    const random = seededRandom(0x50_52_49_4D)
    for (let index = 0; index < 2_048; index += 1) {
      const input = randomInput(random)
      const first = taskRunPresentation(input)
      const second = taskRunPresentation(structuredClone(input))

      expect(second).toEqual(first)
      expect(first.headline.length).toBeGreaterThan(0)
      expect(first.detail.length).toBeGreaterThan(0)
      expect(first.primaryAction ? 1 : 0).toBeLessThanOrEqual(1)
    }
  })

  it('emits actions only from their explicit, current authority grants', () => {
    const random = seededRandom(0x41_55_54_48)
    for (let index = 0; index < 2_048; index += 1) {
      const input = randomInput(random)
      const action = taskRunPresentation(input).primaryAction
      if (!action) continue

      expect(input.connection).toBe('online')
      expect(input.authority.verified).toBe(true)

      switch (action.kind) {
        case 'review_status':
          expect(input.authority.canReview).toBe(true)
          break
        case 'finish_end':
          expect(input.authority.mutation).toBe(true)
          expect(input.authority.conflictingMutation).toBe(false)
          expect(input.authority.canFinishEnd).toBe(true)
          expect(input.endReadyToFinish).toBe(true)
          break
        case 'stop':
          expect(input.authority.mutation).toBe(true)
          expect(input.authority.conflictingMutation).toBe(false)
          expect(input.authority.canStop).toBe(true)
          break
        case 'submit':
          expect(input.authority.mutation).toBe(true)
          expect(input.authority.conflictingMutation).toBe(false)
          expect(input.authority.canStart).toBe(true)
          break
        case 'setup_model':
          expect(input.authority.mutation).toBe(true)
          expect(input.authority.conflictingMutation).toBe(false)
          expect(input.authority.canSetUpModel).toBe(true)
          expect(input.modelReady).toBe(false)
          break
      }
    }
  })

  it('never exposes a mutation while disconnected or unverified', () => {
    for (const connection of ['offline', 'reconnecting'] as const) {
      const presentation = taskRunPresentation(baseline({
        connection,
        authority: {
          ...baseline().authority,
          canStart: true,
          canStop: true,
          canFinishEnd: true,
          canSetUpModel: true,
        },
      }))
      expect(presentation.kind).toBe('disconnected')
      expect(presentation.primaryAction).toBeUndefined()
    }

    const unverified = taskRunPresentation(baseline({
      authority: { ...baseline().authority, verified: false },
    }))
    expect(unverified.kind).toBe('disconnected')
    expect(unverified.primaryAction).toBeUndefined()
  })

  it('makes End exclusive of prompt submission and Stop', () => {
    const random = seededRandom(0x45_4E_44)
    for (let index = 0; index < 512; index += 1) {
      const input = randomInput(random)
      input.sessionEnded = false
      input.connection = 'online'
      input.authority.verified = true
      input.endOperationPresent = true
      const action = taskRunPresentation(input).primaryAction
      expect(action?.kind).not.toBe('submit')
      expect(action?.kind).not.toBe('stop')
    }
  })

  it('never labels stale activity as Working without fresh Stop authority', () => {
    const random = seededRandom(0x53_54_41_4C)
    for (let index = 0; index < 512; index += 1) {
      const input = randomInput(random)
      input.connection = 'online'
      input.sessionEnded = false
      input.endOperationPresent = false
      input.endReadyToFinish = false
      input.taskState = 'running'
      input.receipt = { state: 'idle' }
      input.activity = { live: true, fresh: false }
      input.authority = {
        ...input.authority,
        verified: true,
        conflictingMutation: false,
        canStop: false,
      }

      expect(taskRunPresentation(input).kind).not.toBe('working')
    }
  })

  it('follows the authoritative Ready to Starting to Working to Stopping to Ready trace', () => {
    const ready = baseline()
    const starting = baseline({
      taskState: 'idle',
      receipt: { state: 'sending', operation: 'prompt' },
      authority: { ...baseline().authority, canStart: false },
    })
    const working = baseline({
      taskState: 'running',
      activity: { live: true, fresh: true },
      authority: { ...baseline().authority, canStart: false, canStop: true },
    })
    const stopping = baseline({
      taskState: 'running',
      receipt: { state: 'sent', operation: 'abort' },
      authority: { ...baseline().authority, canStart: false, canStop: false },
    })
    const returnedReady = baseline()

    expect([ready, starting, working, stopping, returnedReady].map((input) =>
      taskRunPresentation(input).kind,
    )).toEqual(['ready', 'starting', 'working', 'stopping', 'ready'])
  })

  it('promotes current resident activity to Working after the prompt receipt retires', () => {
    const presentation = taskRunPresentation(baseline({
      taskState: 'running',
      receipt: { state: 'idle' },
      activity: { live: true, fresh: true },
      authority: { ...baseline().authority, canStart: false, canStop: true },
    }))

    expect(presentation).toMatchObject({
      kind: 'working',
      headline: 'Working',
      primaryAction: { kind: 'stop' },
    })
  })

  it.each(['sending', 'sent', 'queued'] as const)(
    'keeps a running projection at Starting while the prompt receipt is %s',
    (receiptState) => {
    const presentation = taskRunPresentation(baseline({
      taskState: 'running',
      receipt: { state: receiptState, operation: 'prompt' },
      activity: { live: true, fresh: true },
      authority: { ...baseline().authority, canStart: false, canStop: true },
    }))

    expect(presentation).toMatchObject({
      kind: 'starting',
      headline: 'Starting',
    })
    expect(presentation.primaryAction).toBeUndefined()
    },
  )

  it('offers one passive Review action for a saved End without mutation controls', () => {
    const presentation = taskRunPresentation(baseline({
      endOperationPresent: true,
      receipt: { state: 'sent', operation: 'end', retryable: true },
      authority: {
        ...baseline().authority,
        mutation: false,
        canFinishEnd: false,
        canReview: true,
      },
    }))

    expect(presentation).toMatchObject({
      kind: 'ending',
      headline: 'End saved',
      primaryAction: { kind: 'review_status', label: 'Review status' },
    })
  })

  it.each(['waiting', 'needs_approval'] as const)(
    'turns idle upstream %s into one ordinary Reply action without inventing an approval',
    (taskState) => {
      const presentation = taskRunPresentation(baseline({ taskState }))

      expect(presentation).toMatchObject({
        kind: 'needs_attention',
        headline: 'Reply needed',
        primaryAction: { kind: 'submit', label: 'Reply' },
      })
      expect(`${presentation.headline} ${presentation.detail}`).not.toMatch(/approval/i)
    },
  )

  it('does not claim Ready before a model is selected', () => {
    expect(taskRunPresentation(baseline({ modelReady: false }))).toMatchObject({
      kind: 'model_setup',
      headline: 'Choose a model',
      primaryAction: { kind: 'setup_model' },
    })
  })
})
