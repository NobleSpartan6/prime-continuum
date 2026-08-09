import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHECKPOINT_ASSERTION,
  CONFIRMATION_PHRASE,
  DISPOSABLE_CHECKPOINT_FLAG,
  NullDelimitedCdpDecoder,
  OPT_IN_FLAG,
  ProviderE2eContractError,
  assertInteractiveAdmission,
  assertTypedConfirmation,
  createFailureReceipt,
  createFunctionalReceipt,
  encodeCdpMessage,
  parseAccountReadResult,
  parseConversationSnapshotResult,
  serializeReceipt,
  validateCompletedTurn,
  validateElectronRestartRecovery,
  validateInterruptedTurn,
} from '../../scripts/codex-subscription-provider-e2e-lib.mjs'

describe('authenticated Codex provider E2E contract', () => {
  it('requires Windows x64, a TTY, both exact opt-ins, and the dedicated disposable account', () => {
    const admitted = admission()
    expect(assertInteractiveAdmission(admitted)).toEqual({ admitted: true })
    expect(assertTypedConfirmation(CONFIRMATION_PHRASE)).toBe(true)

    for (const override of [
      { platform: 'linux' },
      { arch: 'arm64' },
      { stdinIsTTY: false },
      { ci: 'true' },
      { ci: 'TRUE' },
      { ci: 'yes' },
      { argv: [OPT_IN_FLAG] },
      { checkpointAssertion: 'not-a-checkpoint' },
      { username: 'ordinary-user' },
      { tokenUsername: 'ordinary-user' },
      { userProfileBasename: 'ordinary-profile' },
      { uiCulture: 'fr-FR' },
      { integritySids: ['S-1-16-12288'] },
      { integritySids: ['S-1-16-8192', 'S-1-16-12288'] },
    ]) {
      expect(() => assertInteractiveAdmission({ ...admitted, ...override })).toThrow(ProviderE2eContractError)
    }
    expect(() => assertTypedConfirmation('yes')).toThrowError(
      expect.objectContaining({ stage: 'admission', code: 'CONFIRMATION_REJECTED' }),
    )
  })

  it('frames bounded CDP pipe messages and rejects malformed or unterminated payloads', () => {
    const decoder = new NullDelimitedCdpDecoder(512)
    const first = encodeCdpMessage({ id: 1, method: 'Target.getTargets' })
    const second = encodeCdpMessage({ id: 2, method: 'DOM.getDocument' })
    expect(decoder.push(Buffer.concat([first.subarray(0, 7)]))).toEqual([])
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
    expect(() => unfinished.finish()).toThrowError(expect.objectContaining({ code: 'CDP_PROTOCOL_INVALID' }))
  })

  it('strictly unwraps and schema-validates only successful production bridge Result values', () => {
    const account = signedOutAccount()
    expect(parseAccountReadResult({ ok: true, value: account }, 'initial_account')).toEqual(account)
    expect(parseConversationSnapshotResult({ ok: true, value: { conversation: conversation({
      operationId: 'turn-one',
      turnId: 'provider-turn-one',
      state: 'completed',
      assistantState: 'completed',
      assistantText: 'Finished.',
    }) } }, 'completed_turn')).toMatchObject({ conversation: { state: 'terminal' } })

    for (const result of [
      { ok: false, error: { code: 'FAILED', message: 'raw details', retryable: false, receiptId: 'private' } },
      { ok: true, value: account, error: { message: 'must not coexist' } },
      { ok: true, value: { ...account, unexpected: true } },
      account,
    ]) {
      expect(() => parseAccountReadResult(result, 'initial_account')).toThrowError(
        expect.objectContaining({ stage: 'initial_account', code: 'ACCOUNT_STATE_INVALID' }),
      )
    }
    expect(() => parseConversationSnapshotResult({ ok: false, error: {} }, 'completed_turn')).toThrowError(
      expect.objectContaining({ stage: 'completed_turn', code: 'TURN_NOT_COMPLETED' }),
    )
  })

  it('requires one exact streamed and completed turn identity', () => {
    const active = conversation({ operationId: 'turn-one', turnId: 'provider-turn-one', state: 'running' })
    const streaming = conversation({
      operationId: 'turn-one',
      turnId: 'provider-turn-one',
      state: 'running',
      assistantState: 'streaming',
      assistantText: 'A streamed delta',
    })
    const completed = conversation({
      operationId: 'turn-one',
      turnId: 'provider-turn-one',
      state: 'completed',
      assistantState: 'completed',
      assistantText: 'A streamed delta finished.',
    })
    expect(validateCompletedTurn([active, streaming, completed])).toEqual({
      operationId: 'turn-one',
      turnId: 'provider-turn-one',
    })
    expect(() => validateCompletedTurn([active, completed])).toThrowError(
      expect.objectContaining({ code: 'STREAMING_NOT_OBSERVED' }),
    )
    expect(() => validateCompletedTurn([
      active,
      streaming,
      conversation({
        operationId: 'turn-one',
        turnId: 'different-turn',
        state: 'completed',
        assistantState: 'completed',
        assistantText: 'wrong',
      }),
    ])).toThrow(ProviderE2eContractError)
  })

  it('binds visible Stop proof to the same admitted operation and provider turn', () => {
    const active = conversation({ operationId: 'turn-two', turnId: 'provider-turn-two', state: 'running' })
    const interrupted = conversation({
      operationId: 'turn-two',
      turnId: 'provider-turn-two',
      state: 'interrupted',
      assistantState: 'completed',
      assistantText: 'Partial answer',
    })
    expect(validateInterruptedTurn(active, interrupted)).toEqual({
      operationId: 'turn-two',
      turnId: 'provider-turn-two',
    })
    expect(() => validateInterruptedTurn(
      active,
      conversation({
        operationId: 'other-operation',
        turnId: 'provider-turn-two',
        state: 'interrupted',
        assistantState: 'completed',
        assistantText: 'Partial answer',
      }),
    )).toThrowError(expect.objectContaining({ code: 'INTERRUPT_NOT_PROVEN' }))
  })

  it('proves Electron-only recovery on the same hostd incarnation without replay', () => {
    const first = terminalTwoTurnConversation()
    const restarted = structuredClone(first)
    restarted.revision += 1
    restarted.updatedAt = '2026-08-09T12:00:10.000Z'
    expect(validateElectronRestartRecovery(first, restarted, ['turn-one', 'turn-two'])).toEqual({
      recovered: true,
      noReplay: true,
    })

    const differentBackend = structuredClone(restarted)
    differentBackend.backendIncarnationId = 'new-hostd-incarnation'
    expect(() => validateElectronRestartRecovery(first, differentBackend, ['turn-one', 'turn-two']))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_NOT_PROVEN' }))

    const replayed = structuredClone(restarted)
    replayed.transcript.push({ ...replayed.transcript[0]!, itemId: 'duplicate-user', sequence: 4 })
    expect(() => validateElectronRestartRecovery(first, replayed, ['turn-one', 'turn-two']))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_NOT_PROVEN' }))

    const beforeWithUnrelated = structuredClone(first)
    beforeWithUnrelated.transcript.push({
      ...beforeWithUnrelated.transcript[0]!,
      itemId: 'third-user',
      turnOperationId: 'unexpected-operation',
      sequence: 4,
    })
    const afterWithUnrelated = structuredClone(beforeWithUnrelated)
    afterWithUnrelated.revision += 1
    afterWithUnrelated.updatedAt = '2026-08-09T12:00:10.000Z'
    expect(() => validateElectronRestartRecovery(beforeWithUnrelated, afterWithUnrelated, ['turn-one', 'turn-two']))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_NOT_PROVEN' }))
  })

  it('emits only bounded path-free functional evidence with cleanup still externally required', () => {
    const receipt = createFunctionalReceipt({
      candidate: candidate(),
      durationsMs: {
        total: 10_000,
        login: 4_000,
        completedTurn: 2_000,
        interruptedTurn: 1_000,
        desktopRestart: 2_000,
        logout: 1_000,
      },
      initialSignedOut: true,
      loginOperationObserved: true,
      signedIn: true,
      completedTurnStreamed: true,
      completedTurnRenderedStream: true,
      completedTurnRenderedUserItem: true,
      completedTurnExactIdentity: true,
      interruptedTurnRenderedUserItem: true,
      interruptedTurnExactIdentity: true,
      desktopRestartRecovered: true,
      noReplay: true,
      restartSignedIn: true,
      loggedOut: true,
      authJsonAbsent: true,
    })
    expect(receipt).toMatchObject({
      evidenceClass: 'opt_in_functional_e2e',
      outcome: 'functional_passed_cleanup_required',
      privilegedDebugAuthority: true,
      workspaceSetup: 'production_store_fixture',
      cleanup: {
        status: 'cleanup_required',
        vmRollbackOrDestructionConfirmed: false,
        externalVmDisposalRequired: true,
      },
      completedTurn: { renderedStreamingAssistantObserved: true },
      boundary: { desktopLifecycleDrive: 'exact_process_uia_titlebar_close_button' },
      security: { codexHomeAuthJsonAbsent: true },
    })
    expect(receipt.nonclaims).toEqual([
      'not_sender_trust_or_security_evidence',
      'not_ordinary_user_authority',
      'not_installed_lifecycle_evidence',
      'not_signing_evidence',
      'not_hostd_restart_evidence',
      'not_provider_rpc_count_evidence',
      'system_browser_session_state_not_observed',
    ])
    const serialized = serializeReceipt(receipt)
    expect(serialized).not.toMatch(/planType|accountId|email|token|prompt|https?:\/\/|[a-z]:\\/iu)
    expect(Buffer.byteLength(serialized)).toBeLessThan(12 * 1024)
    for (const sensitiveKey of ['secret', 'password', 'cookie', 'credential', 'authorization']) {
      expect(() => serializeReceipt({ [sensitiveKey]: 'canary' })).toThrowError(
        expect.objectContaining({ code: 'RECEIPT_INVALID' }),
      )
    }

    const failureReceipt = createFailureReceipt('login', 'LOGIN_NOT_COMPLETED', {
      fixtureCreated: true,
      desktopStarted: true,
    })
    expect(failureReceipt).toMatchObject({
      outcome: 'failed',
      stage: 'login',
      code: 'LOGIN_NOT_COMPLETED',
      cleanup: { status: 'cleanup_unconfirmed', fixtureRetained: true },
    })
    expect(failureReceipt).not.toHaveProperty('platform')
    expect(failureReceipt).not.toHaveProperty('arch')
    expect(failureReceipt).not.toHaveProperty('privilegedDebugAuthority')
    expect(failureReceipt).not.toHaveProperty('workspaceSetup')
    expect(createFailureReceipt('admission', 'INTERACTIVE_REQUIRED', { helperMayRemain: true })).toMatchObject({
      cleanup: {
        helperProcessMayRemain: true,
        externalVmDisposalRequired: true,
      },
    })
  })

  it('keeps the executable harness on the pipe, UI-input, read-only-bridge boundary', async () => {
    const [source, packageSource, workflowSource] = await Promise.all([
      readFile(resolve('scripts/verify-codex-subscription-provider-e2e.mjs'), 'utf8'),
      readFile(resolve('package.json'), 'utf8'),
      readFile(resolve('scripts/run-workflow.mjs'), 'utf8'),
    ])
    const packageManifest = JSON.parse(packageSource) as { scripts?: Record<string, string> }
    expect(source).toContain('--remote-debugging-pipe')
    expect(source).not.toMatch(/--remote-debugging-port|createServer\(|listen\s*\(/u)
    expect(source).not.toMatch(/Runtime\.evaluate|\.click\s*\(/u)
    expect(source).not.toContain('DOM.focus')
    expect(source).not.toMatch(/\.(?:loginStart|loginCancel|logout|turnStart|turnInterrupt|turnReconcile)\s*\(/u)
    expect(source).toContain('Input.dispatchMouseEvent')
    expect(source).toContain('Input.insertText')
    expect(source).toContain('accountRead')
    expect(source).toContain('conversationSnapshot')
    expect(source.match(/Runtime\.callFunctionOn/gu)).toHaveLength(2)
    expect(source.match(/functionDeclaration:/gu)).toHaveLength(2)
    expect(source).toContain('function(binding){return globalThis.prime.codexSubscription.accountRead(binding)}')
    expect(source).toContain('function(binding){return globalThis.prime.codexSubscription.conversationSnapshot(binding)}')
    expect(source).not.toMatch(/console\.(?:log|error|trace)|Page\.captureScreenshot|Tracing\./u)
    expect(source).toContain('PRIME_CONTINUIM_CODEX_E2E_INSTALLED_EXE')
    expect(source).not.toMatch(/\{\s*\.\.\.process\.env/u)
    expect(source).not.toMatch(/environment\.ELECTRON_RUN_AS_NODE\s*=/u)
    expect(source).not.toContain('--remote-debugging-io-pipes')
    expect(source).toContain('pages[0]?.url === exactRendererUrl')
    expect(source).toContain('pages[0]?.title === "Prime Continuim"')
    expect(source).toContain('await store.initialize()')
    expect(source.match(/new installedHostd\.HostStore/gu)).toHaveLength(1)
    expect(source).toContain('installedExecutableSha256 !== candidateExecutableSha256')
    expect(source).toContain('applicationArchiveSha256 !== candidateArchiveSha256')
    expect(source).toContain('hostdSha256 !== candidateHostdSha256')
    expect(source).toContain('installedRuntimePointerSha256 !== candidateRuntimePointerSha256')
    expect(source).toContain('UIAutomationClient')
    expect(source).toContain('AutomationElement.FromHandle')
    expect(source).toContain('ControlType.TitleBar')
    expect(source).toContain('current.Name == "Close"')
    expect(source).toContain('current.ProcessId != processId')
    expect(source).toContain('current.IsEnabled')
    expect(source).toContain('current.IsOffscreen')
    expect(source).toContain('BoundingRectangle')
    expect(source).toContain('InvokePattern.Pattern')
    expect(source).toContain('closeCandidates.Count != 1')
    expect(source).toContain('TreeWalker.ControlViewWalker')
    expect(source).toContain('MaxRootChildren = 64')
    expect(source).toContain('MaxTitleBarNodes = 64')
    expect(source).toContain('MaxTitleBarDepth = 8')
    expect(source).toContain('discovered > MaxTitleBarNodes')
    expect(source).toContain('Task.Factory.StartNew')
    expect(source).toContain('task.Wait(InvokeTimeoutMilliseconds)')
    expect(source).toContain('ApartmentState.MTA')
    expect(source).toContain('primeContinuimCloseAttempted = true')
    expect(source).not.toMatch(/\.FindAll\s*\(|TrueCondition/u)
    expect(source.match(/allowAlreadyExited: true/gu)).toHaveLength(1)
    expect(source).toContain('waitForHelperExit(child, 10_000)')
    expect(source).toContain('waitForHelperExit(helper, 20_000)')
    expect(source).toContain('runState.helperMayRemain = true')
    expect(source).toContain('child?.unref()')
    expect(source).toContain('abandonChildObservation(runState.desktop)')
    expect(source).not.toContain('CloseMainWindow')
    expect(source).not.toMatch(/Browser\.close|\.kill\s*\(|taskkill|Stop-Process|remove-item|\.rm\s*\(|unlink/iu)
    expect(source).toContain('DOM.querySelectorAll')
    expect(source).toContain('Page.getLayoutMetrics')
    expect(source).toContain('Accessibility.getPartialAXTree')
    expect(source).toContain('exactAxNode?.ignored !== false')
    expect(source).toContain('width <= 0')
    expect(source).toContain('area <= 0')
    expect(source).toContain('requireViewport &&')
    expect(source).toContain('STREAMING_ASSISTANT_SELECTOR')
    expect(source).toContain('assertAuthJsonAbsent(await canonicalCodexHome(fixture.dataDirectory))')
    expect(source).toContain('resolve(dataDirectory, "codex-subscription", "home")')
    expect(source).not.toContain('assertAuthJsonAbsent(fixture.dataDirectory)')
    expect(source).toContain('[Globalization.CultureInfo]::CurrentUICulture.Name')
    expect(source).toContain('statFile(archive, "package.json", false)')
    expect(source).toContain('extractFile(archive, "package.json", false)')
    expect(source).toContain('entry.unpacked === true')
    expect(source).toContain('entry.integrity?.algorithm !== "SHA256"')
    expect(source).toContain('manifest.name !== "prime-continuim"')
    expect(source).toContain('manifest.main !== "./out/main/index.js"')
    expect(source).toContain('finally {')
    expect(source).toContain('uncache(archive)')
    expect(source).not.toContain('readFile(resolve(REPO_ROOT, "package.json")')
    expect(source).toContain('appVersion: installedAppVersion')
    expect(source).toContain('canonicalBefore = await canonicalRegularFile(artifact.path)')
    expect(source).toContain('canonicalAfter = await canonicalRegularFile(artifact.path)')
    const finalClose = source.lastIndexOf('await closeInstalledDesktopOrderly(desktop)')
    const finalCandidateFence = source.indexOf('await assertCandidateArtifactsUnchanged(candidate)')
    const receiptCreation = source.indexOf('const receipt = createFunctionalReceipt')
    expect(finalClose).toBeGreaterThan(0)
    expect(finalCandidateFence).toBeGreaterThan(finalClose)
    expect(receiptCreation).toBeGreaterThan(finalCandidateFence)
    expect(source.indexOf('runState.fixtureCreated = true')).toBeGreaterThan(source.indexOf('await mkdtemp('))
    expect(source.indexOf('runState.fixtureCreated = true')).toBeLessThan(source.indexOf('await realpath(requestedRoot)'))
    expect(source.indexOf('runState.desktop = child')).toBeGreaterThan(source.indexOf('child.once("spawn"'))
    expect(source.indexOf('runState.desktop = child')).toBeLessThan(source.indexOf('child.stdio[3]?.writable'))
    expect(source.indexOf('child.primeContinuimTemporaryDirectory = fixture.temporaryDirectory')).toBeLessThan(
      source.indexOf('runState.desktop = child'),
    )
    expect(source).toContain('TEMP: temporaryDirectory')
    expect(source).toContain('TMP: temporaryDirectory')
    expect(source.match(/stdout\.write\(serializeReceipt/gu)).toHaveLength(2)
    expect(packageManifest.scripts?.['verify:codex-subscription-provider:e2e'])
      .toBe('node scripts/verify-codex-subscription-provider-e2e.mjs')
    expect(workflowSource).not.toContain('verify:codex-subscription-provider:e2e')
  })

})

function admission() {
  return {
    platform: 'win32',
    arch: 'x64',
    stdinIsTTY: true,
    stdoutIsTTY: true,
    ci: false,
    argv: [OPT_IN_FLAG, DISPOSABLE_CHECKPOINT_FLAG],
    checkpointAssertion: CHECKPOINT_ASSERTION,
    username: 'PrimeCodexE2E',
    tokenUsername: 'PrimeCodexE2E',
    userProfileBasename: 'PrimeCodexE2E',
    uiCulture: 'en-US',
    integritySids: ['S-1-16-8192'],
  }
}

function candidate() {
  return {
    appVersion: '0.1.0',
    runtimeReleaseVersion: '0.7.0',
    runtimeBuildId: 'build-1',
    codexAppServerReleaseVersion: '0.147.0',
    assurance: 'development-integrity',
    installerSha256: 'a'.repeat(64),
    installedExecutableSha256: 'b'.repeat(64),
    applicationArchiveSha256: 'c'.repeat(64),
    hostdSha256: 'd'.repeat(64),
    runtimeManifestSha256: 'e'.repeat(64),
    runtimeTreeSha256: 'f'.repeat(64),
  }
}

type TurnState = 'running' | 'completed' | 'interrupted'

const executionPolicy = {
  filesystem: 'read_only_user_scope',
  workspaceReadConfinement: false,
  toolNetworkAccess: false,
  approvalPolicy: 'never',
  disclosure: 'Codex tools cannot write files or open network connections. They may read other files available to your Windows account; this is not a workspace-only sandbox. Prompts and content Codex reads—including workspace instructions and tool-read files—are sent to OpenAI for the turn.',
} as const

function signedOutAccount() {
  return {
    backend: {
      id: 'codex-chatgpt-subscription',
      kind: 'codex_subscription',
      label: 'Codex via ChatGPT subscription',
    },
    backendIncarnationId: 'same-hostd-incarnation',
    phase: 'signed_out',
    executionPolicy,
    turnReadiness: { state: 'unavailable', reason: 'account_required' },
    updatedAt: '2026-08-09T12:00:00.000Z',
  }
}

function conversation(input: {
  operationId: string
  turnId: string
  state: TurnState
  assistantState?: 'streaming' | 'completed'
  assistantText?: string
}) {
  const active = input.state === 'running'
  const startedAt = '2026-08-09T12:00:00.000Z'
  const latestTurn = active
    ? {
        operationId: input.operationId,
        turnId: input.turnId,
        state: 'running',
        terminal: false,
        startedAt,
      }
    : {
        operationId: input.operationId,
        turnId: input.turnId,
        state: input.state,
        terminal: true,
        startedAt,
        completedAt: '2026-08-09T12:00:05.000Z',
      }
  const transcript = [
    {
      itemId: `user-${input.operationId}`,
      turnOperationId: input.operationId,
      turnId: input.turnId,
      sequence: 0,
      role: 'user',
      state: 'completed',
      text: 'private prompt never enters the receipt',
      createdAt: startedAt,
      updatedAt: startedAt,
    },
    ...(input.assistantState ? [{
      itemId: `assistant-${input.operationId}`,
      turnOperationId: input.operationId,
      turnId: input.turnId,
      sequence: 1,
      role: 'assistant',
      state: input.assistantState,
      text: input.assistantText ?? '',
      createdAt: startedAt,
      updatedAt: '2026-08-09T12:00:04.000Z',
    }] : []),
  ]
  return {
    backend: {
      id: 'codex-chatgpt-subscription',
      kind: 'codex_subscription',
      label: 'Codex via ChatGPT subscription',
    },
    backendIncarnationId: 'same-hostd-incarnation',
    binding: {
      hostId: 'fixture-host',
      sourceThreadId: 'fixture-thread',
      executionGenerationId: 'fixture-generation',
    },
    sessionId: 'fixture-session',
    threadId: 'provider-thread',
    revision: active ? 2 : 3,
    state: active ? 'active' : 'terminal',
    executionPolicy,
    ...(active ? { activeTurn: latestTurn } : {}),
    latestTurn,
    transcript,
    transcriptTruncated: false,
    updatedAt: active ? '2026-08-09T12:00:04.000Z' : '2026-08-09T12:00:05.000Z',
  }
}

function terminalTwoTurnConversation() {
  const first = conversation({
    operationId: 'turn-one',
    turnId: 'provider-turn-one',
    state: 'completed',
    assistantState: 'completed',
    assistantText: 'First result',
  })
  const second = conversation({
    operationId: 'turn-two',
    turnId: 'provider-turn-two',
    state: 'interrupted',
    assistantState: 'completed',
    assistantText: 'Partial second result',
  })
  second.transcript = [
    ...first.transcript,
    ...second.transcript.map((item, index) => ({ ...item, sequence: index + first.transcript.length })),
  ]
  second.revision = 8
  return second
}
