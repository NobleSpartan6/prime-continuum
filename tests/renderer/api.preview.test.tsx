// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPreviewRendererApi } from '../../src/renderer/src/api'
import {
  CandidateEvaluationPreflightSchema,
  CandidateEvaluationSnapshotSchema,
} from '../../src/shared/protocol'

const previewPrefix = 'Preview simulation ·'

describe('browser preview evidence labels', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('labels checkpoint fixtures and every simulated command receipt as preview-only', async () => {
    const api = createPreviewRendererApi()
    const load = api.loadWorkbench()
    await vi.advanceTimersByTimeAsync(120)
    const snapshot = await load

    const checkpoint = snapshot.threads
      .flatMap((thread) => thread.transcript)
      .find((block) => block.kind === 'checkpoint')
    const toolReceipt = snapshot.threads
      .flatMap((thread) => thread.transcript)
      .find((block) => block.receipt)

    expect(checkpoint?.body).toMatch(/^Preview simulation ·/)
    expect(checkpoint?.detail).toMatch(/^Preview simulation ·/)
    expect(toolReceipt?.detail).toMatch(/^Preview simulation ·/)
    expect(toolReceipt?.receipt).toMatch(/^preview_simulation_/)
    expect(snapshot.composerReceipt.message).toMatch(/^Preview simulation ·/)

    const firstPrompt = api.sendComposer({
      threadId: snapshot.selectedThreadId,
      text: 'Run a preview command',
    })
    await vi.advanceTimersByTimeAsync(240)

    const secondPrompt = api.sendComposer({
      threadId: snapshot.selectedThreadId,
      text: 'Run another preview command',
    })
    await vi.advanceTimersByTimeAsync(240)

    const messages = [(await firstPrompt).message, (await secondPrompt).message]
    expect(messages).toEqual([
      `${previewPrefix} prompt not sent to a host`,
      `${previewPrefix} prompt not sent to a host`,
    ])
    expect(messages.join(' ')).not.toMatch(/durably admitted by host|host receipt/i)
  })

  it('materializes coherent resident visual states without mutating the default reconnect fixture', async () => {
    const cases = [
      {
        visualState: 'idle' as const,
        threadState: 'idle',
        receiptState: 'idle',
        operation: undefined,
        message: 'Ready for a new prompt',
        canStart: true,
        canStop: false,
      },
      {
        visualState: 'prompt-admission' as const,
        threadState: 'idle',
        receiptState: 'sending',
        operation: 'prompt',
        message: 'Host received the prompt · awaiting durable admission',
        canStart: true,
        canStop: false,
      },
      {
        visualState: 'prompt-awaiting-idle-proof' as const,
        threadState: 'running',
        receiptState: 'sent',
        operation: 'prompt',
        message: 'Prime Agent owns this prompt · waiting for authoritative idle proof',
        canStart: false,
        canStop: true,
      },
      {
        visualState: 'stop-awaiting-idle-proof' as const,
        threadState: 'idle',
        receiptState: 'sent',
        operation: 'abort',
        message: 'Stop accepted · waiting for authoritative idle proof',
        canStart: false,
        canStop: false,
      },
      {
        visualState: 'nonretryable-uncertainty' as const,
        threadState: 'idle',
        receiptState: 'uncertain',
        operation: 'abort',
        message: 'Outcome unknown · recovery required; this Stop will not be replayed',
        canStart: false,
        canStop: false,
      },
      {
        visualState: 'resident-end-review' as const,
        threadState: 'idle',
        receiptState: 'idle',
        operation: undefined,
        message: 'Ready for a new prompt',
        canStart: true,
        canStop: false,
      },
      {
        visualState: 'resident-end-pending' as const,
        threadState: 'idle',
        receiptState: 'sent',
        operation: 'end',
        message: 'Ending resident session · Prime Continuim will not send another kill automatically',
        canStart: false,
        canStop: false,
      },
    ]

    for (const expected of cases) {
      const request = createPreviewRendererApi(expected.visualState).loadWorkbench()
      await vi.advanceTimersByTimeAsync(120)
      const snapshot = await request
      const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
      const host = snapshot.hosts.find((candidate) => candidate.id === thread?.hostId)

      expect(host?.connection, expected.visualState).toBe('online')
      expect(thread?.status, expected.visualState).toBe(expected.threadState)
      expect(snapshot.composerReceipt, expected.visualState).toMatchObject({
        state: expected.receiptState,
        message: expected.message,
        ...(expected.operation ? { operation: expected.operation } : {}),
      })
      expect(snapshot.operations.startResidentTurn, expected.visualState).toBe(expected.canStart)
      expect(snapshot.operations.stopResidentTurn, expected.visualState).toBe(expected.canStop)
    }

    const reconnectRequest = createPreviewRendererApi().loadWorkbench()
    await vi.advanceTimersByTimeAsync(120)
    const reconnectSnapshot = await reconnectRequest
    const reconnectThread = reconnectSnapshot.threads.find((thread) => thread.id === reconnectSnapshot.selectedThreadId)
    const reconnectHost = reconnectSnapshot.hosts.find((host) => host.id === reconnectThread?.hostId)
    expect(reconnectHost?.connection).toBe('reconnecting')
    expect(reconnectSnapshot.composerReceipt.message).toBe(`${previewPrefix} waiting for a fixture connection`)
  })

  it('scopes the non-executing candidate review fixture to its exact visual-QA authority', async () => {
    const api = createPreviewRendererApi('candidate-evaluation-review')
    expect(api.environment).toBe('native')
    expect(createPreviewRendererApi().environment).toBe('preview')

    const load = api.loadWorkbench()
    await vi.advanceTimersByTimeAsync(120)
    const snapshot = await load
    const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
    const host = snapshot.hosts.find((candidate) => candidate.id === thread?.hostId)
    expect(thread).toMatchObject({
      id: 'thread-protocol',
      executionGenerationId: 'candidate-preview-generation',
      status: 'idle',
    })
    expect(host).toMatchObject({ id: 'host-local', kind: 'local', connection: 'online' })
    expect(snapshot.operations.candidateEvaluationProbe).toBe(true)

    const authority = {
      expectedHostId: 'host-local',
      threadId: 'thread-protocol',
      expectedExecutionGenerationId: 'candidate-preview-generation',
    }
    const preflight = CandidateEvaluationPreflightSchema.parse(
      await api.candidateEvaluationPreflight!(authority),
    )
    const history = CandidateEvaluationSnapshotSchema.parse(
      await api.candidateEvaluationSnapshot!(authority),
    )
    expect(preflight).toMatchObject({ status: 'ready', ...authority })
    expect(history).toMatchObject({ ...authority, evaluations: [], repeatEffectsWarningRequired: false })
    if (preflight.status !== 'ready') throw new Error('The candidate visual fixture did not return its ready preflight')
    const publicEvidence = JSON.stringify({ preflight, history })
    expect(publicEvidence).not.toMatch(/[A-Za-z]:\\|\/(?:Users|home|tmp)\/|\\\\/)
    expect(publicEvidence).not.toMatch(/"(?:path|argv|env)"\s*:/)

    await expect(api.startCandidateEvaluation!({
      ...authority,
      operationId: 'candidate-evaluation:visual-qa-never-runs',
      requestedAt: '2026-08-09T12:00:02.000Z',
      kind: 'prime_continuim_self_build_v1',
      expectedReview: preflight.review,
    })).rejects.toThrow('never invokes candidate code')
  })

  it('labels the handoff plan, progress, checkpoint, and receipt as a simulation', async () => {
    const api = createPreviewRendererApi()
    const planRequest = api.planHandoff({
      threadId: 'thread-seamless',
      destinationHostId: 'host-local',
      behaviorIfRunning: 'wait_for_idle',
    })
    await vi.advanceTimersByTimeAsync(220)
    const plan = await planRequest

    expect(plan.handoffId).toMatch(/^preview_simulation_handoff_/)
    expect(plan.warnings[0]).toMatch(/^Preview simulation ·/)

    const progress: Array<{ phase: string; message: string }> = []
    const handoff = api.startHandoff(
      { handoffId: plan.handoffId, behaviorIfRunning: 'wait_for_idle' },
      (phase, message) => progress.push({ phase, message }),
    )
    for (let index = 0; index < 7; index += 1) {
      await vi.advanceTimersByTimeAsync(260)
    }
    const receipt = await handoff

    expect(progress).toHaveLength(7)
    expect(progress.every(({ message }) => message.startsWith(previewPrefix))).toBe(true)
    expect(progress.find(({ phase }) => phase === 'checkpointing')?.message).toContain('no checkpoint is created')
    expect(receipt.receiptId).toMatch(/^preview_simulation_handoff_receipt_/)
    expect(progress.map(({ message }) => message).join(' ')).not.toMatch(
      /creating an immutable source checkpoint|making the destination authoritative|thread moved and verified/i,
    )
  })
})
