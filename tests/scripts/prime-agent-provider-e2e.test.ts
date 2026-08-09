import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHECKPOINT_ASSERTION,
  CONFIRMATION_PHRASE,
  DISPOSABLE_CHECKPOINT_FLAG,
  MIN_POST_RESTART_OBSERVATIONS,
  MAX_ISOLATED_TEMP_TREE_ENTRIES,
  NONCLAIMS,
  NullDelimitedCdpDecoder,
  OPT_IN_FLAG,
  POST_RESTART_OBSERVATION_INTERVAL_MS,
  ProviderE2eContractError,
  assertInteractiveAdmission,
  assertNoCredentialEnvironment,
  assertTypedConfirmation,
  createFailureReceipt,
  createFunctionalReceipt,
  credentialStrippedEnvironment,
  digestBoundedRegularFileTree,
  encodeCdpMessage,
  hasVisibleAssistantStreamEvidence,
  parseVisibleModelRowMetadata,
  removeIsolatedTemporaryRoot,
  serializeReceipt,
  uniqueExactVisibleModelRowIndex,
  validateAuthenticatedPrimeAgentCatalog,
  validateInitialPrimeAgentCatalog,
  validateRestartNoReplay,
  validateSelectedModelProjection,
  validateStopTransition,
  validateTerminalResidentProjection,
} from '../../scripts/prime-agent-provider-e2e-lib.mjs'

describe('installed Prime Agent provider E2E contract', () => {
  it('admits only the exact disposable non-administrator Windows account, flags, checkpoint, locale, and medium token', () => {
    const exact = admission()
    expect(assertInteractiveAdmission(exact)).toEqual({ admitted: true })
    expect(assertTypedConfirmation(CONFIRMATION_PHRASE)).toBe(true)

    for (const override of [
      { platform: 'linux' },
      { arch: 'arm64' },
      { stdinIsTTY: false },
      { stdoutIsTTY: false },
      { ci: 'true' },
      { ci: undefined, githubActions: 'true' },
      { argv: [OPT_IN_FLAG] },
      { argv: [OPT_IN_FLAG, DISPOSABLE_CHECKPOINT_FLAG, '--extra'] },
      { checkpointAssertion: 'unproven' },
      { username: 'ordinary-user' },
      { tokenUsername: 'ordinary-user' },
      { userProfileBasename: 'ordinary-user' },
      { uiCulture: 'fr-FR' },
      { groupSids: ['S-1-5-32-544', 'S-1-16-8192'] },
      { integritySids: ['S-1-16-12288'] },
      { integritySids: ['S-1-16-8192', 'S-1-16-12288'] },
    ]) {
      expect(() => assertInteractiveAdmission({ ...exact, ...override })).toThrow(ProviderE2eContractError)
    }
    expect(() => assertTypedConfirmation('yes')).toThrowError(
      expect.objectContaining({ stage: 'admission', code: 'CONFIRMATION_REJECTED' }),
    )
  })

  it('rejects ambient provider authority and strips credential-shaped variables from child environments', () => {
    expect(assertNoCredentialEnvironment({ SystemRoot: 'C:\\Windows', PRIME_CONTINUIM_PROVIDER_E2E_MODEL_ID: 'gpt-5' })).toBe(true)
    for (const environment of [
      { OPENAI_API_KEY: 'value' },
      { GH_TOKEN: 'value' },
      { CUSTOM_PASSWORD: 'value' },
      { AWS_PROFILE: 'default' },
    ]) {
      expect(() => assertNoCredentialEnvironment(environment)).toThrowError(
        expect.objectContaining({ code: 'CREDENTIAL_ENVIRONMENT_FORBIDDEN' }),
      )
    }
    const stripped = credentialStrippedEnvironment({
      SystemRoot: 'C:\\Windows',
      NODE_OPTIONS: '--inspect',
      OPENAI_API_KEY: 'value',
      ORDINARY_VALUE: 'kept',
    }, { electronRunAsNode: true, packageSmoke: true })
    expect(stripped).toEqual({
      environment: {
        SystemRoot: 'C:\\Windows',
        ORDINARY_VALUE: 'kept',
        ELECTRON_RUN_AS_NODE: '1',
        PRIME_CONTINUIM_PACKAGE_SMOKE: '1',
      },
      strippedCredentialVariableCount: 1,
    })
  })

  it('accepts only a fresh Prime Agent OAuth catalog and the exact OAuth-backed target model', () => {
    const initial = modelCatalog(false)
    expect(validateInitialPrimeAgentCatalog(initial)).toBe(initial)
    const authenticated = modelCatalog(true)
    expect(validateAuthenticatedPrimeAgentCatalog(authenticated, 'gpt-5.6-codex')).toMatchObject({
      provider: { providerId: 'openai-codex', configured: true },
      model: { modelId: 'gpt-5.6-codex', available: true, usingOAuth: true },
    })
    expect(() => validateInitialPrimeAgentCatalog(authenticated)).toThrowError(
      expect.objectContaining({ code: 'PREEXISTING_AUTHORITY' }),
    )
    expect(() => validateAuthenticatedPrimeAgentCatalog(initial, 'gpt-5.6-codex')).toThrowError(
      expect.objectContaining({ code: 'OAUTH_NOT_COMPLETED' }),
    )
    const apiKeyModel = structuredClone(authenticated)
    apiKeyModel.models[0]!.usingOAuth = false
    expect(() => validateAuthenticatedPrimeAgentCatalog(apiKeyModel, 'gpt-5.6-codex')).toThrow()
  })

  it('binds selected model, visible Stop, exact prompt/abort envelopes, and terminal End to one resident', () => {
    const active = projection({ status: 'running', inProgressStream: { streamId: 'stream-1' } })
    const stopped = projection({ status: 'idle' })
    expect(validateSelectedModelProjection(stopped, { modelId: 'gpt-5.6-codex', threadId: 'thread-1' })).toBe(stopped)
    const wrongRuntimeModel = structuredClone(stopped)
    wrongRuntimeModel.runtime.model = 'GPT 5.6 Codex'
    expect(() => validateSelectedModelProjection(wrongRuntimeModel, {
      modelId: 'gpt-5.6-codex', threadId: 'thread-1',
    })).toThrowError(expect.objectContaining({ code: 'MODEL_NOT_SELECTED' }))
    const prompt = envelope('prompt-1', { kind: 'prompt', text: 'private live input' })
    const abort = envelope('abort-1', { kind: 'abort', reason: 'visible Stop' })
    expect(validateStopTransition(active, stopped, {
      promptEnvelope: prompt,
      abortEnvelope: abort,
      receipts: [
        { commandId: 'prompt-1', status: 'completed' },
        { commandId: 'abort-1', status: 'completed' },
      ],
    })).toMatchObject({ promptEnvelope: prompt, abortEnvelope: abort })
    expect(() => validateStopTransition(active, stopped, {
      promptEnvelope: prompt,
      abortEnvelope: abort,
      receipts: [{ commandId: 'prompt-1', status: 'completed' }],
    })).toThrowError(expect.objectContaining({ code: 'STOP_NOT_PROVEN' }))
    const nonIdle = structuredClone(stopped)
    nonIdle.thread.status = 'failed'
    expect(() => validateStopTransition(active, nonIdle, {
      promptEnvelope: prompt,
      abortEnvelope: abort,
      receipts: [
        { commandId: 'prompt-1', status: 'completed' },
        { commandId: 'abort-1', status: 'completed' },
      ],
    })).toThrowError(expect.objectContaining({ code: 'STOP_NOT_PROVEN' }))

    const terminal = {
      ...stopped,
      runtime: undefined,
      residentLifecycle: { state: 'ended', reason: 'user_end' },
    }
    expect(validateTerminalResidentProjection(terminal, {
      threadId: 'thread-1',
      executionGenerationId: 'execution-1',
    })).toBe(terminal)
  })

  it('requires growth in one visible assistant body alongside the same active stream block', () => {
    expect(hasVisibleAssistantStreamEvidence([
      { blockId: 'stream-1', streamText: 'One sentence.', visibleAssistantText: 'One sentence.' },
      { blockId: 'stream-1', streamText: 'One sentence. Two sentences.', visibleAssistantText: 'One sentence. Two sentences.' },
    ])).toBe(true)
    const userOnlyContainerChanges = [
      { blockId: 'stream-1', streamText: 'One', visibleAssistantText: '', transcriptContainerText: 'user prompt' },
      { blockId: 'stream-1', streamText: 'One two', visibleAssistantText: '', transcriptContainerText: 'user prompt changed' },
    ]
    expect(hasVisibleAssistantStreamEvidence(userOnlyContainerChanges)).toBe(false)
    expect(hasVisibleAssistantStreamEvidence([
      { blockId: 'stream-1', streamText: 'One', visibleAssistantText: 'An older assistant reply' },
      { blockId: 'stream-1', streamText: 'One two', visibleAssistantText: 'An older assistant reply' },
    ])).toBe(false)
    expect(hasVisibleAssistantStreamEvidence([
      { blockId: 'stream-1', streamText: 'One', visibleAssistantText: 'One' },
      { blockId: 'stream-2', streamText: 'One two', visibleAssistantText: 'One two' },
    ])).toBe(false)
  })

  it('binds model mutation to one exact visible provider/model row despite ambiguous substring results', () => {
    expect(parseVisibleModelRowMetadata(
      '<article class="model-row"><span><bdi>ChatGPT Plus/Pro &amp; Team</bdi> · <bdi>gpt-5</bdi></span></article>',
    )).toEqual({ providerDisplayName: 'ChatGPT Plus/Pro & Team', modelId: 'gpt-5' })
    const rows = [
      { providerId: 'openai-codex', providerDisplayName: 'ChatGPT Plus/Pro', modelId: 'gpt-5', visibleSelectActionCount: 1 },
      { providerId: 'openai-codex', providerDisplayName: 'ChatGPT Plus/Pro', modelId: 'gpt-5-codex', visibleSelectActionCount: 1 },
    ]
    expect(uniqueExactVisibleModelRowIndex(rows, {
      providerId: 'openai-codex', providerDisplayName: 'ChatGPT Plus/Pro', modelId: 'gpt-5',
    })).toBe(0)
    expect(() => uniqueExactVisibleModelRowIndex([...rows, { ...rows[0]! }], {
      providerId: 'openai-codex', providerDisplayName: 'ChatGPT Plus/Pro', modelId: 'gpt-5',
    })).toThrowError(expect.objectContaining({ code: 'MODEL_NOT_SELECTED' }))
  })

  it('requires changed hostd/desktop identities and three separated stable observations with no journal, dispatch, or outbox growth', () => {
    const before = projection({ status: 'idle' })
    const observations = Array.from({ length: MIN_POST_RESTART_OBSERVATIONS }, (_, index) => ({
      snapshot: structuredClone(before),
      observedAtMonotonicMs: 10_000 + index * POST_RESTART_OBSERVATION_INTERVAL_MS,
    }))
    const evidence = restartEvidence(before, observations)
    expect(validateRestartNoReplay(evidence)).toEqual({
      hostdRestarted: true,
      desktopRestarted: true,
      exactProjectionStable: true,
      exactJournalIdsUnchanged: true,
      exactCommandsReconciledByHarness: true,
      residentDispatchAttemptsEmpty: true,
      outboxEmpty: true,
      postRestartObservationCount: 3,
      minimumPostRestartObservationSeparationMs: 4_000,
    })
    expect(() => validateRestartNoReplay({ ...evidence, observations: observations.slice(0, 2) })).toThrow()
    const tooSoon = structuredClone(observations)
    tooSoon[2]!.observedAtMonotonicMs -= 1
    expect(() => validateRestartNoReplay({ ...evidence, observations: tooSoon })).toThrow()
    expect(() => validateRestartNoReplay({ ...evidence, hostdIdentityAfter: '100:1000' })).toThrow()
    expect(() => validateRestartNoReplay({ ...evidence, journalIdsAfter: ['journal-1', 'journal-new'] })).toThrow()
    expect(() => validateRestartNoReplay({ ...evidence, dispatchAttemptCount: 1 })).toThrow()
    expect(() => validateRestartNoReplay({ ...evidence, outboxEntryCount: 1 })).toThrow()
    const changed = structuredClone(observations)
    changed[2]!.snapshot.latestCursor.sequence = 9
    expect(() => validateRestartNoReplay({ ...evidence, observations: changed })).toThrow()
    const attentionChanged = structuredClone(observations)
    ;(attentionChanged[2]!.snapshot as Record<string, unknown>).pendingAttention = [{ id: 'new-attention' }]
    expect(() => validateRestartNoReplay({ ...evidence, observations: attentionChanged })).toThrow()
  })

  it('frames bounded null-delimited CDP messages', () => {
    const decoder = new NullDelimitedCdpDecoder(512)
    const first = encodeCdpMessage({ id: 1, method: 'Target.getTargets' })
    const second = encodeCdpMessage({ id: 2, method: 'DOM.getDocument' })
    expect(decoder.push(first.subarray(0, 7))).toEqual([])
    expect(decoder.push(Buffer.concat([first.subarray(7), second]))).toEqual([
      { id: 1, method: 'Target.getTargets' },
      { id: 2, method: 'DOM.getDocument' },
    ])
    decoder.finish()
    expect(() => new NullDelimitedCdpDecoder(512).push(Buffer.from('{bad}\0'))).toThrowError(
      expect.objectContaining({ code: 'CDP_PROTOCOL_INVALID' }),
    )
    const unfinished = new NullDelimitedCdpDecoder(512)
    unfinished.push(Buffer.from('{}'))
    expect(() => unfinished.finish()).toThrow()
  })

  it('emits a bounded secret-free functional receipt with exact nonclaims and mandatory external VM disposal', () => {
    const receipt = createFunctionalReceipt(functionalReceiptInput())
    expect(receipt).toMatchObject({
      outcome: 'functional_passed_vm_disposal_required',
      workspaceSetup: 'production_host_protocol_fixture',
      proof: {
        hostdAndDesktopRestartedWithChangedIdentities: true,
        harnessReconciledExactPromptAndAbortWithoutDirectSubmission: true,
        noDurableContinuimOrProviderDispatchReplayObserved: true,
      },
      cleanup: {
        externalVmDisposalRequired: true,
        externalVmDisposalConfirmed: false,
      },
    })
    expect(receipt.nonclaims).toEqual(NONCLAIMS)
    expect(Buffer.byteLength(serializeReceipt(receipt))).toBeLessThanOrEqual(12 * 1024)
    expect(() => serializeReceipt({ ...receipt, prompt: 'must never enter receipt' })).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_INVALID' }),
    )
    expect(() => serializeReceipt({ ...receipt, leaked: 'C:\\private\\auth.json' })).toThrow()
    expect(() => serializeReceipt({ ...receipt, leakedEmail: 'operator@example.test' })).toThrow()
    expect(() => serializeReceipt({ ...receipt, stage: '/tmp/private-auth.json' })).toThrow()
    expect(() => serializeReceipt({ ...receipt, code: 'Bearer abcdefghijklmnopqrstuvwxyz' })).toThrow()
    const receiptInput = functionalReceiptInput()
    const candidateWithLeak = { ...receiptInput.candidate, leakedEmail: 'operator@example.test' }
    expect(() => createFunctionalReceipt({ ...receiptInput, candidate: candidateWithLeak })).toThrow()
    expect(createFailureReceipt('oauth', 'OAUTH_NOT_COMPLETED', { fixtureCreated: true })).toMatchObject({
      outcome: 'failed_vm_disposal_required',
      cleanup: { status: 'cleanup_unconfirmed', fixtureMayRemain: true, externalVmDisposalRequired: true },
    })
  })

  it('changes a bounded whole-tree binding when an extra regular file appears', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'prime-continuim-prime-agent-e2e-')))
    await writeFile(join(root, 'runtime.js'), 'first')
    const before = await digestBoundedRegularFileTree(root, { maxFiles: 10, maxBytes: 1_024 })
    await writeFile(join(root, 'extra.js'), 'second')
    const after = await digestBoundedRegularFileTree(root, { maxFiles: 10, maxBytes: 1_024 })
    expect(after).toMatchObject({ canonicalRoot: root, fileCount: 2, totalBytes: 11 })
    expect(after.sha256).not.toBe(before.sha256)
    await mkdir(join(root, 'empty-directory'))
    const withExtraDirectory = await digestBoundedRegularFileTree(root, { maxFiles: 10, maxBytes: 1_024 })
    expect(withExtraDirectory).toMatchObject({ fileCount: 2, totalBytes: 11 })
    expect(withExtraDirectory.sha256).not.toBe(after.sha256)
    await removeIsolatedTemporaryRoot({
      root,
      expectedPrefix: 'prime-continuim-prime-agent-e2e-',
      confirmedCleanShutdown: true,
    })
  })

  it('bounds isolated cleanup above the complete pinned runtime plus its directory structure', () => {
    expect(MAX_ISOLATED_TEMP_TREE_ENTRIES).toBe(50_000)
    expect(MAX_ISOLATED_TEMP_TREE_ENTRIES).toBeGreaterThan(20_771 + 1_699)
  })

  it('removes only a canonical bounded link-free harness temporary root after proven clean shutdown', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'prime-continuim-prime-agent-e2e-')))
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'fixture.txt'), 'fixture')
    await expect(removeIsolatedTemporaryRoot({
      root,
      expectedPrefix: 'prime-continuim-prime-agent-e2e-',
      confirmedCleanShutdown: true,
    })).resolves.toMatchObject({ removed: true, entries: 2, bytes: 7 })
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })

    const retained = await realpath(await mkdtemp(join(tmpdir(), 'prime-continuim-prime-agent-e2e-')))
    await expect(removeIsolatedTemporaryRoot({
      root: retained,
      expectedPrefix: 'prime-continuim-prime-agent-e2e-',
      confirmedCleanShutdown: false,
    })).rejects.toMatchObject({ code: 'CLEANUP_UNCONFIRMED' })
    await expect(stat(retained)).resolves.toBeDefined()
    // The test owns this credential-free empty temp fixture; leave no test residue.
    await removeIsolatedTemporaryRoot({
      root: retained,
      expectedPrefix: 'prime-continuim-prime-agent-e2e-',
      confirmedCleanShutdown: true,
    })
  })

  it('keeps the runner Prime Agent-native, UI-mutated, restart-owning, non-replaying, and outside normal workflows', async () => {
    const [source, packageManifest, workflow] = await Promise.all([
      readFile(resolve('scripts/verify-prime-agent-provider-e2e.mjs'), 'utf8'),
      readFile(resolve('package.json'), 'utf8'),
      readFile(resolve('scripts/run-workflow.mjs'), 'utf8'),
    ])
    expect(source).toContain('--remote-debugging-pipe')
    expect(source).not.toContain('--remote-debugging-port')
    expect(source).not.toContain('Runtime.evaluate')
    expect(source).not.toContain('.click()')
    expect(source).toContain('Input.dispatchMouseEvent')
    expect(source).toContain('Input.insertText')
    expect(source).toContain('globalThis.prime.requestSnapshot')
    expect(source).not.toContain('globalThis.prime.submitCommand')
    expect(source).not.toContain('globalThis.prime.startRuntimeOAuth')
    expect(source).not.toContain('globalThis.prime.selectResidentModel')
    expect(source).not.toContain('globalThis.prime.endResident')
    expect(source).not.toContain('codexSubscription')
    expect(source).not.toContain('app-server')
    expect(source).not.toContain('command.submit')
    expect(source).toContain('"resident.provision"')
    expect(source).toContain('"command.reconcile"')
    expect(source).toContain('readExactCommandReceipt')
    expect(source).toContain('isDeepStrictEqual(reconciliation, stoppedAudit.receipts)')
    expect(source).toContain('readExactStoredProjection')
    expect(source).toContain('readRelevantJournalIds')
    expect(source).toContain('button[aria-label="Close models and accounts"]')
    expect(source).toContain('controller.clickExactVisibleModelRow({')
    expect(source).toContain('uniqueExactVisibleModelRowIndex(candidates, expected)')
    expect(source).toContain('providerAttributes.get("data-provider-id") === expected?.providerId')
    expect(source).toContain('parseVisibleModelRowMetadata(await this.nodeOuterHtml(rowNodeId))')
    expect(source).not.toContain('controller.clickVisible(MODEL_SELECT_SELECTOR')
    expect(source.indexOf('controller.clickVisible(MODELS_CLOSE_SELECTOR')).toBeLessThan(
      source.indexOf('controller.typeVisible(COMPOSER_SELECTOR'),
    )
    expect(source).toContain('createPrimeAgentSmokeCustody')
    expect(source).toContain('removeAfterConfirmedShutdown')
    expect(source).toContain('status.kind !== "provision"')
    expect(source).toContain('expectedHostId: hostId')
    expect(source).toContain('status.expectedHostId !== request.expectedHostId')
    expect(source).toContain('commands: [command]')
    expect(source).toContain(
      'VISIBLE_ASSISTANT_BODY_SELECTOR = "#thread-transcript .message--assistant.message--streaming .message__body"',
    )
    expect(source).toContain('hasVisibleAssistantStreamEvidence(observations)')
    expect(source).not.toContain('outerHtml(TRANSCRIPT_SELECTOR)')
    expect(source).toContain('verificationTrees: Object.freeze')
    expect(source).toContain('digestBoundedRegularFileTree(binding.canonicalRoot')
    expect(source).toContain('lineage?.length !== 1')
    expect(source).toContain('runState.endOutcomeUncertain = true')
    expect(source).toContain('runState.helperMayRemain !== true && runState.endOutcomeUncertain !== true')
    expect(source).toContain('if (overflow) return;')
    expect(source).toContain('output.byteLength + bytes.byteLength > options.maxStdoutBytes')
    expect(source).toContain('process.stdin.once("end", terminate)')
    expect(source).toContain('process.stdin.once("close", terminate)')
    expect(source).toContain('if (!desktopClean && runState.hostd)')
    expect(source).toContain('response?.protocolVersion !== 1')
    expect(source.indexOf('if (!desktopClean && runState.hostd)')).toBeLessThan(
      source.lastIndexOf('abandonChildObservation(runState.hostd)'),
    )
    expect(source.indexOf('runState.daemonShutdownAttempted = true')).toBeLessThan(
      source.indexOf('inspectResidentDaemon(runState.daemonContext, "shutdown")'),
    )
    expect(source.indexOf('runState.custodyRemovalAttempted = true')).toBeLessThan(
      source.indexOf('fixture.custody.removeAfterConfirmedShutdown'),
    )
    expect(source.indexOf('runState.temporaryRootRemovalAttempted = true')).toBeLessThan(
      source.indexOf('removeIsolatedTemporaryRoot({'),
    )
    // The pinned v0.7.1 runtime has 20,764 files per tree. Admission must bind
    // both complete installed/candidate trees rather than reject the real pin.
    expect(source).toContain('const MAX_TREE_FILES = 25_000')
    expect(source).toContain('candidate.verificationArtifacts.length > 2 * MAX_TREE_FILES + 10')
    expect(source).not.toMatch(/\.kill\(|taskkill|Stop-Process|Remove-Item|\brm\(/u)
    expect(source.indexOf('startOwnedHostd(candidate')).toBeLessThan(source.indexOf('startInstalledDesktop(candidate'))
    expect(source.indexOf('stopOwnedHostd(hostd)')).toBeLessThan(source.lastIndexOf('startOwnedHostd(candidate'))
    expect(source.indexOf('reconcileExactCommands')).toBeLessThan(source.lastIndexOf('startInstalledDesktop(candidate'))
    expect(source).toContain('process.exitCode = 2')
    expect(JSON.parse(packageManifest).scripts['verify:prime-agent-provider:e2e']).toBe(
      'node scripts/verify-prime-agent-provider-e2e.mjs',
    )
    expect(workflow).not.toContain('verify:prime-agent-provider:e2e')
  })
})

function admission() {
  return {
    platform: 'win32',
    arch: 'x64',
    stdinIsTTY: true,
    stdoutIsTTY: true,
    ci: undefined,
    githubActions: undefined,
    argv: [OPT_IN_FLAG, DISPOSABLE_CHECKPOINT_FLAG],
    checkpointAssertion: CHECKPOINT_ASSERTION,
    username: 'PrimeAgentE2E',
    tokenUsername: 'PrimeAgentE2E',
    userProfileBasename: 'PrimeAgentE2E',
    uiCulture: 'en-US',
    groupSids: ['S-1-5-11', 'S-1-5-32-545', 'S-1-16-8192'],
    integritySids: ['S-1-16-8192'],
  }
}

function modelCatalog(configured: boolean) {
  return {
    runtime: 'prime_agent',
    releaseVersion: '0.7.1',
    observedAt: '2026-08-09T12:00:00.000Z',
    providers: [{
      providerId: 'openai-codex',
      displayName: 'ChatGPT Plus/Pro (Codex Subscription)',
      oauthSupported: true,
      oauthUsesCallbackServer: true,
      configured,
      availableModelCount: configured ? 1 : 0,
      modelCount: 1,
    }],
    models: [{
      providerId: 'openai-codex',
      modelId: 'gpt-5.6-codex',
      name: 'GPT 5.6 Codex',
      available: configured,
      usingOAuth: configured,
    }],
  }
}

function projection(options: { status: string; inProgressStream?: Record<string, unknown> }) {
  return {
    snapshotVersion: 1,
    generatedAt: '2026-08-09T12:00:00.000Z',
    thread: {
      threadId: 'thread-1',
      title: 'Provider E2E',
      projectIdentity: 'project-1',
      currentLocation: {
        hostId: 'host-1',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        executionGenerationId: 'execution-1',
      },
      status: options.status,
      unread: false,
      updatedAt: '2026-08-09T12:00:00.000Z',
      lastKnownCursor: { threadId: 'thread-1', executionGenerationId: 'execution-1', generation: 'g-1', sequence: 3 },
    },
    runtime: {
      runtime: 'prime_agent',
      residency: 'resident',
      activeSessionId: 'active-1',
      sessionId: 'session-1',
      model: 'openai-codex/gpt-5.6-codex',
    },
    transcriptBlockIndex: [{ id: 'user-1' }, { id: 'assistant-1' }],
    materializedRecentBlocks: [{ id: 'user-1', kind: 'user' }, { id: 'assistant-1', kind: 'assistant' }],
    queueState: { pendingCommandIds: [], paused: false },
    approvals: [],
    childAgents: [],
    goals: [],
    schedules: [],
    latestCursor: { threadId: 'thread-1', executionGenerationId: 'execution-1', generation: 'g-1', sequence: 3 },
    ...(options.inProgressStream ? { inProgressStream: options.inProgressStream } : {}),
  }
}

function envelope(commandId: string, command: Record<string, unknown>) {
  return {
    protocolVersion: 1,
    deviceId: 'device-1',
    commandId,
    expectedHostId: 'host-1',
    threadId: 'thread-1',
    issuedAt: '2026-08-09T12:00:00.000Z',
    expectedExecutionGenerationId: 'execution-1',
    command,
  }
}

function restartEvidence(before: ReturnType<typeof projection>, observations: Array<Record<string, unknown>>) {
  return {
    beforeRestart: before,
    observations,
    hostdIdentityBefore: '100:1000',
    hostdIdentityAfter: '101:2000',
    desktopIdentityBefore: '200:1000',
    desktopIdentityAfter: '201:2000',
    journalIdsBefore: ['journal-1', 'journal-2'],
    journalIdsAfter: ['journal-2', 'journal-1'],
    expectedCommandIds: ['prompt-1', 'abort-1'],
    reconciledCommandIds: ['abort-1', 'prompt-1'],
    dispatchAttemptCount: 0,
    outboxEntryCount: 0,
  }
}

function functionalReceiptInput() {
  const trueFacts = {
    boundInstalledArtifactsExact: true,
    primeAgentOauthCompleted: true,
    targetModelSelected: true,
    visiblePromptSubmitted: true,
    visibleStreamObserved: true,
    visibleStopInvoked: true,
    stopTerminalReceiptObserved: true,
    desktopClosedOrderlyBeforeRestart: true,
    hostdStoppedCleanly: true,
    hostdRestarted: true,
    desktopRestarted: true,
    hostdProcessIdentityChanged: true,
    desktopProcessIdentityChanged: true,
    harnessReconciledExactPromptAndAbortWithoutDirectSubmission: true,
    residentDispatchAttemptsEmpty: true,
    outboxEmpty: true,
    journalIdsUnchanged: true,
    noDurableContinuimOrProviderDispatchReplayObserved: true,
    visibleEndInvoked: true,
    terminalProjectionObserved: true,
    retiredBindingObserved: true,
    zeroDaemonSessionsObserved: true,
    finalDesktopCloseOrderly: true,
    finalHostdStopCleanly: true,
    candidateArtifactsUnchanged: true,
    custodyLeafRemoved: true,
    temporaryRootRemoved: true,
  }
  return {
    candidate: {
      appVersion: '0.1.0',
      runtimeReleaseVersion: '0.7.1',
      runtimeBuildId: 'runtime-build-1',
      assurance: 'development-integrity' as const,
      installerSha256: 'a'.repeat(64),
      installedExecutableSha256: 'b'.repeat(64),
      applicationArchiveSha256: 'c'.repeat(64),
      hostdSha256: 'd'.repeat(64),
      runtimeManifestSha256: 'e'.repeat(64),
      runtimeTreeSha256: 'f'.repeat(64),
    },
    ...trueFacts,
    postRestartObservationCount: 3,
    minimumPostRestartObservationSeparationMs: 4_000,
    durationsMs: {
      total: 30_000,
      oauth: 10_000,
      modelSelection: 1_000,
      promptAndStop: 5_000,
      restartAndNoReplay: 10_000,
      end: 4_000,
    },
  }
}
