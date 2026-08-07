// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPreviewRendererApi } from '../../src/renderer/src/api'

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

    const liveOnly = api.sendComposer({
      threadId: snapshot.selectedThreadId,
      text: 'Run a preview command',
      intent: 'follow_up',
      sendWhenReconnected: false,
    })
    await vi.advanceTimersByTimeAsync(240)

    const queued = api.sendComposer({
      threadId: snapshot.selectedThreadId,
      text: 'Queue a preview command',
      intent: 'follow_up',
      sendWhenReconnected: true,
    })
    await vi.advanceTimersByTimeAsync(240)

    const messages = [(await liveOnly).message, (await queued).message]
    expect(messages).toEqual([
      `${previewPrefix} command not sent to a host`,
      `${previewPrefix} command saved only in the in-memory preview outbox`,
    ])
    expect(messages.join(' ')).not.toMatch(/durably admitted by host|host receipt/i)
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
