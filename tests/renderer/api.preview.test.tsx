// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INTERNAL_VISUAL_QA_USER_AGENT,
  isInternalVisualQaRequest,
} from '../../src/renderer/src/preview-bootstrap'
import { createPreviewRendererApi } from '../../src/renderer/src/api.preview'
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

  it('admits the internal visual fixture only for the exact loopback request and user agent', () => {
    const exact = {
      protocol: 'http:',
      hostname: '127.0.0.1',
      userAgent: INTERNAL_VISUAL_QA_USER_AGENT,
      search: '?visualState=candidate-evaluation-review',
    }
    expect(isInternalVisualQaRequest(exact)).toBe(true)
    expect(isInternalVisualQaRequest({ ...exact, userAgent: `${INTERNAL_VISUAL_QA_USER_AGENT} suffix` })).toBe(false)
    expect(isInternalVisualQaRequest({ ...exact, userAgent: `prefix ${INTERNAL_VISUAL_QA_USER_AGENT}` })).toBe(false)
    expect(isInternalVisualQaRequest({ ...exact, hostname: 'localhost' })).toBe(false)
    expect(isInternalVisualQaRequest({ ...exact, search: '' })).toBe(false)
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
    expect(snapshot.operations).not.toHaveProperty('codexSubscription')
    expect(api).not.toHaveProperty('codexSubscription')

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
        visualState: 'rlm-activity' as const,
        threadState: 'idle',
        receiptState: 'idle',
        operation: undefined,
        message: 'Ready for a new prompt',
        canStart: true,
        canStop: false,
      },
      {
        visualState: 'model-selection' as const,
        threadState: 'idle',
        receiptState: 'idle',
        operation: undefined,
        message: 'Ready for a new prompt',
        canStart: true,
        canStop: false,
      },
      {
        visualState: 'prime-oauth' as const,
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
        message: 'Ready to finish · Prime Agent has not received an End request',
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
      expect(snapshot.operations.selectResidentModel, expected.visualState).toBe(
        expected.visualState === 'model-selection' ? true : undefined,
      )
      if (expected.visualState === 'model-selection') expect(snapshot.operations.modelCatalog).toBe(true)
      if (expected.visualState === 'idle') expect(snapshot.agents).toEqual([])
      if (expected.visualState === 'rlm-activity') {
        expect(snapshot.agents.some((agent) => agent.status === 'running' || agent.status === 'waiting')).toBe(true)
      }
      if (expected.visualState === 'prime-oauth') {
        expect(snapshot.operations.modelCatalog).toBe(true)
        expect(snapshot.operations.runtimeOAuth).toBe(true)
        expect(host?.kind).toBe('local')
      }
    }

    const nonExecutingModelApi = createPreviewRendererApi('model-selection')
    expect(nonExecutingModelApi.environment).toBe('native')
    expect(createPreviewRendererApi('idle').environment).toBe('preview')
    await expect(nonExecutingModelApi.selectResidentModel({
      threadId: 'thread-seamless',
      providerId: 'openai-codex',
      modelId: 'gpt-5.3-codex',
    })).rejects.toThrow('available only in the native desktop app')
    await expect(nonExecutingModelApi.startRuntimeOAuth?.({
      hostId: 'host-devbox',
      providerId: 'openai-codex',
    }, () => undefined)).rejects.toThrow('available only in the native desktop app')
    await expect(nonExecutingModelApi.cancelRuntimeOAuth?.({
      hostId: 'host-devbox',
      providerId: 'openai-codex',
    })).rejects.toThrow('available only in the native desktop app')

    const oauthApi = createPreviewRendererApi('prime-oauth')
    expect(oauthApi.environment).toBe('native')
    const catalogRequest = oauthApi.loadRuntimeModelCatalog('host-local')
    await vi.advanceTimersByTimeAsync(180)
    const oauthCatalog = await catalogRequest
    expect(oauthCatalog.providers.find((provider) => provider.providerId === 'openai-codex')).toMatchObject({
      configured: false,
      availableModelCount: 0,
      oauthSupported: true,
    })
    expect(oauthCatalog.models
      .filter((model) => model.providerId === 'openai-codex')
      .every((model) => model.available === false && model.usingOAuth === false)).toBe(true)
    await expect(oauthApi.startRuntimeOAuth?.({
      hostId: 'host-local',
      providerId: 'openai-codex',
    }, () => undefined)).rejects.toThrow('available only in the native desktop app')

    const reconnectRequest = createPreviewRendererApi().loadWorkbench()
    await vi.advanceTimersByTimeAsync(120)
    const reconnectSnapshot = await reconnectRequest
    const reconnectThread = reconnectSnapshot.threads.find((thread) => thread.id === reconnectSnapshot.selectedThreadId)
    const reconnectHost = reconnectSnapshot.hosts.find((host) => host.id === reconnectThread?.hostId)
    expect(reconnectHost?.connection).toBe('reconnecting')
    expect(reconnectSnapshot.composerReceipt.message).toBe(`${previewPrefix} waiting for a fixture connection`)
  })

  it('scopes the non-executing SSH registered-workspace fixture to one exact saved source', async () => {
    const api = createPreviewRendererApi('ssh-registered-workspace')
    expect(api.environment).toBe('native')

    const load = api.loadWorkbench()
    await vi.advanceTimersByTimeAsync(120)
    const snapshot = await load
    const project = snapshot.projects.find((candidate) => candidate.id === snapshot.selectedProjectId)
    const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId)
    const host = snapshot.hosts.find((candidate) => candidate.id === thread?.hostId)

    expect(project).toMatchObject({ id: 'project-prime', name: 'Prime Continuim' })
    expect(thread).toMatchObject({
      id: 'thread-seamless',
      remoteId: 'thread-seamless-remote',
      projectId: 'project-prime',
      workspaceId: 'workspace-prime-devbox',
      executionGenerationId: 'execution-registered-workspace-preview',
      status: 'idle',
    })
    expect(host).toMatchObject({ id: 'host-devbox', kind: 'ssh', connection: 'online', connectionPath: 'SSH' })
    expect(snapshot.operations).toMatchObject({ provisionResident: true, endResident: true })

    const input = {
      kind: 'registered_workspace' as const,
      projectId: 'project-prime',
      workspaceId: 'workspace-prime-devbox',
      referenceThreadId: 'thread-seamless-remote',
      referenceExecutionGenerationId: 'execution-registered-workspace-preview',
    }
    const selection = await api.selectResidentWorkspace(input)
    expect(selection).toEqual({
      ...input,
      selectionToken: 'preview-registered-workspace-selection-token',
      operationId: 'resident-preview-registered-create',
      expectedHostId: 'host-devbox',
      suggestedName: project?.name,
      expiresAt: '2099-08-07T12:05:00.000Z',
    })
    expect(selection).not.toHaveProperty('path')

    await expect(api.selectResidentWorkspace({
      ...input,
      referenceExecutionGenerationId: 'execution-stale-preview',
    })).rejects.toThrow('exact internal visual-QA authority')
    await expect(api.provisionResident({
      selectionToken: selection.selectionToken,
      projectDisplayName: selection.suggestedName,
      threadTitle: 'Visual QA resident thread',
    })).rejects.toThrow('unavailable in the browser preview')
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
