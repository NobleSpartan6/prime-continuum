import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BROWSER_SURFACE,
  CHECKPOINT_ASSERTION,
  CHILD_NAME,
  CONFIRMATION_PHRASE,
  DISPOSABLE_CHECKPOINT_FLAG,
  EVIDENCE_KIND,
  FUNCTIONAL_EXIT_CODE,
  MAX_UNIX_SOCKET_PATH_BYTES,
  MIN_POST_RESTART_OBSERVATIONS,
  MODEL_ID,
  NONCLAIMS,
  OPT_IN_FLAG,
  POST_RESTART_OBSERVATION_INTERVAL_MS,
  PRIME_AGENT_RELEASE_VERSION,
  PROOF_DIRECTORY,
  PROVIDER_ID,
  ROOT_PREFIX,
  RUNTIME_MODEL_ID,
  SCREENSHOT_NAME,
  ToolDogfoodContractError,
  assertBrowserStateRetired,
  assertInteractiveAdmission,
  assertNoCredentialEnvironment,
  assertTypedConfirmation,
  createDogfoodIdentity,
  createDogfoodPage,
  createDogfoodPrompt,
  createFailureReceipt,
  createFunctionalReceipt,
  parseAndValidateProof,
  readAndValidateProof,
  resolveDogfoodHostEndpoint,
  resolveDogfoodResidentDaemonEndpoint,
  serializeReceipt,
  validateAuthenticatedCatalog,
  validateCompletedEndLifecycleStatus,
  validateCompletedProjection,
  validateDisposableLayout,
  validateEndedControlProjection,
  validateEndedProjection,
  validateInFlightProjection,
  validateInitialProjection,
  validateLoopbackEvidence,
  validateReceipt,
  validateRestartNoReplay,
  validateScreenshot,
} from '../../scripts/prime-agent-tool-dogfood-lib.mjs'

describe('explicit Sol/RLM/browser dogfood contract', () => {
  it('requires the exact interactive opt-in, checkpoint, and typed authorization on supported hosts', () => {
    const exact = admission()
    expect(assertInteractiveAdmission(exact)).toEqual({ admitted: true })
    expect(assertTypedConfirmation(CONFIRMATION_PHRASE)).toBe(true)

    for (const override of [
      { platform: 'freebsd' },
      { stdinIsTTY: false },
      { stdoutIsTTY: false },
      { ci: '1' },
      { ci: undefined, githubActions: 'true' },
      { argv: [OPT_IN_FLAG] },
      { argv: [OPT_IN_FLAG, DISPOSABLE_CHECKPOINT_FLAG, '--extra'] },
      { checkpointAssertion: 'not-a-checkpoint' },
    ]) {
      expect(() => assertInteractiveAdmission({ ...exact, ...override })).toThrow(ToolDogfoodContractError)
    }
    expect(() => assertTypedConfirmation('yes')).toThrowError(
      expect.objectContaining({ stage: 'admission', code: 'CONFIRMATION_REJECTED' }),
    )
  })

  it('rejects ambient credential authority while allowing only path/checkpoint harness configuration', () => {
    expect(assertNoCredentialEnvironment({
      PATH: '/usr/bin',
      PRIME_AGENT_DATA_DIR: '/private/tmp/isolated-host',
      PRIME_CONTINUIM_TOOL_DOGFOOD_ROOT: '/private/tmp/root',
      PRIME_CONTINUIM_TOOL_DOGFOOD_WORKSPACE: '/private/tmp/root/workspace',
      PRIME_CONTINUIM_TOOL_DOGFOOD_DISPOSABLE_CHECKPOINT: CHECKPOINT_ASSERTION,
    })).toBe(true)
    for (const environment of [
      { OPENAI_API_KEY: 'secret' },
      { GH_TOKEN: 'secret' },
      { CUSTOM_PASSWORD: 'secret' },
      { AWS_PROFILE: 'credential-profile' },
      { SESSION_COOKIE: 'secret' },
    ]) {
      expect(() => assertNoCredentialEnvironment(environment)).toThrowError(
        expect.objectContaining({ code: 'CREDENTIAL_ENVIRONMENT_FORBIDDEN' }),
      )
    }
  })

  it('admits only real private temporary roots with disjoint workspace and host data descendants', async () => {
    const requestedRoot = await mkdtemp(join(tmpdir(), ROOT_PREFIX))
    await Promise.all([
      mkdir(join(requestedRoot, 'workspace'), { mode: 0o700 }),
      mkdir(join(requestedRoot, 'host-data'), { mode: 0o700 }),
    ])
    const root = await realpath(requestedRoot)
    try {
      await expect(validateDisposableLayout({
        root,
        workspace: join(root, 'workspace'),
        dataDirectory: join(root, 'host-data'),
      })).resolves.toEqual({
        root,
        workspace: join(root, 'workspace'),
        dataDirectory: join(root, 'host-data'),
      })
      await expect(validateDisposableLayout({
        root,
        workspace: join(root, 'workspace'),
        dataDirectory: join(root, 'workspace'),
      })).rejects.toMatchObject({ code: 'FIXTURE_INVALID' })
      await expect(validateDisposableLayout({
        root,
        workspace: root,
        dataDirectory: join(root, 'host-data'),
      })).rejects.toMatchObject({ code: 'FIXTURE_INVALID' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects overlong Unix endpoints and accepts the short private macOS fixture root', () => {
    const longDataDirectory = `/private/var/folders/${'x'.repeat(80)}/prime-continuim-tool-dogfood-run/host-data`
    expect(() => resolveDogfoodHostEndpoint({
      platform: 'darwin',
      dataDirectory: longDataDirectory,
    })).toThrowError(expect.objectContaining({ code: 'FIXTURE_INVALID' }))
    const endpoint = resolveDogfoodHostEndpoint({
      platform: 'darwin',
      dataDirectory: '/private/tmp/prime-continuim-tool-dogfood-run/host-data',
    })
    expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(MAX_UNIX_SOCKET_PATH_BYTES)
    expect(endpoint).toBe('/private/tmp/prime-continuim-tool-dogfood-run/host-data/hostd.sock')
    expect(resolveDogfoodHostEndpoint({
      platform: 'win32',
      dataDirectory: 'C:\\dogfood\\host-data',
    })).toMatch(/^\\\\\.\\pipe\\prime-agent-hostd-[a-f0-9]{16}$/u)
    expect(() => resolveDogfoodHostEndpoint({
      platform: 'win32',
      dataDirectory: '/drive-relative/host-data',
    })).toThrowError(expect.objectContaining({ code: 'FIXTURE_INVALID' }))
    expect(() => resolveDogfoodHostEndpoint({
      platform: 'darwin',
      dataDirectory: 'C:\\dogfood\\host-data',
    })).toThrowError(expect.objectContaining({ code: 'FIXTURE_INVALID' }))
    const resident = resolveDogfoodResidentDaemonEndpoint({
      platform: 'darwin',
      dataDirectory: '/private/tmp/prime-continuim-tool-dogfood-run/host-data',
      physicalTemporaryDirectory: '/private/var/folders/fixture/T',
    })
    expect(resident).toMatch(/^\/private\/var\/folders\/fixture\/T\/pc-[a-f0-9]{16}\/d\.sock$/u)
    expect(Buffer.byteLength(resident)).toBeLessThanOrEqual(MAX_UNIX_SOCKET_PATH_BYTES)
  })

  it('freezes one native child, exact Sol model, stable-ref browser sequence, and no ambient browser authority in the task', () => {
    const identity = dogfoodIdentity()
    const prompt = createDogfoodPrompt({
      identity,
      pageUrl: `http://127.0.0.1:43121/dogfood/${identity.runId}`,
    })
    expect(prompt).toContain(`exact objective: ${identity.goalObjective}`)
    expect(prompt).toContain(`exactly one native RLM child with name ${CHILD_NAME}`)
    expect(prompt).toContain('Keep the root turn and that child active')
    expect(prompt).toContain(`agent_message with the exact token ${identity.childToken}`)
    expect(prompt).toContain(`model is exactly ${RUNTIME_MODEL_ID}`)
    expect(prompt).toContain(`${BROWSER_SURFACE} surface`)
    expect(prompt).toContain('snapshot')
    expect(prompt).toContain('stable e-ref')
    expect(prompt).toContain('fill the textbox')
    expect(prompt).toContain('click the button by its stable ref')
    expect(prompt).toContain('eval/read')
    expect(prompt).toContain('screenshot')
    expect(prompt).toContain('close the named session')
    expect(prompt).not.toContain('--persistent')
    expect(prompt).not.toContain('attach --')
    expect(prompt).not.toContain('auth.json')

    const page = createDogfoodPage(identity)
    expect(page).toContain('aria-label="Dogfood value"')
    expect(page).toContain('Commit dogfood proof')
    expect(page).toContain("await fillProof;await record('click',value)")
    expect(page).toContain('data-dogfood-result')
  })

  it('requires an OAuth-backed exact Sol catalog and an exact ready resident/browser baseline', () => {
    const identity = dogfoodIdentity()
    const initial = initialProjection(identity)
    expect(validateAuthenticatedCatalog(modelCatalog())).toMatchObject({
      provider: { providerId: PROVIDER_ID, configured: true },
      model: { modelId: MODEL_ID, available: true, usingOAuth: true },
    })
    expect(validateInitialProjection(initial, identity)).toMatchObject({
      hostId: 'host-1',
      threadId: 'thread-1',
      activeSessionId: 'active-1',
      initialSequence: 4,
    })

    const unavailable: any = structuredClone(initial)
    unavailable.residentControl.browserExecution = { readiness: 'unavailable' }
    expect(() => validateInitialProjection(unavailable, identity)).toThrowError(
      expect.objectContaining({ code: 'PRECONDITION_NOT_PROVEN' }),
    )
    const collision: any = structuredClone(initial)
    collision.runtime.resourceInventory.diagnostics.collisions = [{ resourceType: 'skill', name: BROWSER_SURFACE }]
    expect(validateInitialProjection(collision, identity)).toMatchObject({
      hostId: 'host-1',
      threadId: 'thread-1',
    })
    const unverifiedWinner: any = structuredClone(collision)
    unverifiedWinner.runtime.resourceInventory.skills[0].sourceKind = { scope: 'project', origin: 'top-level' }
    expect(() => validateInitialProjection(unverifiedWinner, identity)).toThrowError(
      expect.objectContaining({ code: 'PRECONDITION_NOT_PROVEN' }),
    )
    const noOauth = modelCatalog()
    noOauth.models[0]!.usingOAuth = false
    expect(() => validateAuthenticatedCatalog(noOauth)).toThrowError(
      expect.objectContaining({ code: 'PRECONDITION_NOT_PROVEN' }),
    )
  })

  it('requires an observable live root turn and active child before accepting their exact completion', () => {
    const identity = dogfoodIdentity()
    const baseline = validateInitialProjection(initialProjection(identity), identity)
    const live = inFlightProjection(identity)
    const inFlight = validateInFlightProjection(live, { initial: baseline, identity })
    expect(inFlight).toMatchObject({
      child: { sessionName: CHILD_NAME, state: 'running', repliedSinceTask: false },
      goal: { objective: identity.goalObjective, state: 'active' },
      rootActivity: 'runtime_stream',
      sequence: 12,
      projectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })

    for (const mutate of [
      (value: any) => { value.thread.status = 'idle' },
      (value: any) => {
        value.runtime.isStreaming = false
        value.runtime.isCompacting = false
        value.runtime.isBashRunning = false
        value.runtime.activeToolNames = []
      },
      (value: any) => { value.childAgents[0].state = 'complete' },
      (value: any) => { value.childAgents[0].repliedSinceTask = true },
      (value: any) => { value.goals[0].state = 'complete' },
      (value: any) => { value.latestCursor.sequence = baseline.initialSequence },
    ]) {
      const invalid = structuredClone(live)
      mutate(invalid)
      expect(() => validateInFlightProjection(invalid, { initial: baseline, identity })).toThrowError(
        expect.objectContaining({ code: 'IN_FLIGHT_NOT_PROVEN' }),
      )
    }

    const completed = completedProjection(identity)
    expect(validateCompletedProjection(completed, { initial: baseline, identity, inFlight })).toMatchObject({
      child: {
        sessionName: CHILD_NAME,
        model: RUNTIME_MODEL_ID,
        repliedSinceTask: true,
        state: 'complete',
      },
      goal: { objective: identity.goalObjective, state: 'complete' },
    })

    const cases = [
      (value: any) => { value.runtime.model = `${PROVIDER_ID}/wrong` },
      (value: any) => { value.childAgents[0].sessionName = 'other' },
      (value: any) => { value.childAgents[0].repliedSinceTask = false },
      (value: any) => { value.childAgents.push({ ...value.childAgents[0], agentId: 'child-2' }) },
      (value: any) => { value.goals[0].state = 'active' },
      (value: any) => { value.materializedRecentBlocks[0].text = 'missing exact evidence' },
      (value: any) => { value.residentControl.browserExecution = { readiness: 'unavailable' } },
    ]
    for (const mutate of cases) {
      const invalid = structuredClone(completed)
      mutate(invalid)
      expect(() => validateCompletedProjection(invalid, { initial: baseline, identity, inFlight })).toThrowError(
        expect.objectContaining({ code: 'PROJECTION_NOT_PROVEN' }),
      )
    }
    expect(() => validateCompletedProjection(completed, { initial: baseline, identity } as any)).toThrowError(
      expect.objectContaining({ code: 'PROJECTION_NOT_PROVEN' }),
    )
  })

  it('requires a changed host and desktop, exact resident reattachment, stable idle projections, and no durable replay evidence', () => {
    const identity = dogfoodIdentity()
    const initial = validateInitialProjection(initialProjection(identity), identity)
    const inFlight = validateInFlightProjection(inFlightProjection(identity), { initial, identity })
    const completed = completedProjection(identity)
    const observations = Array.from({ length: MIN_POST_RESTART_OBSERVATIONS }, (_, index) => ({
      snapshot: structuredClone(completed),
      observedAtMonotonicMs: 10_000 + index * POST_RESTART_OBSERVATION_INTERVAL_MS,
    }))
    const exact = {
      initial,
      identity,
      inFlight,
      beforeRestart: completed,
      observations,
      hostProcessBefore: 'hostd:00000000-0000-4000-8000-000000000001',
      hostProcessAfter: 'hostd:00000000-0000-4000-8000-000000000002',
      desktopProcessBefore: 'desktop:00000000-0000-4000-8000-000000000001',
      desktopProcessAfter: 'desktop:00000000-0000-4000-8000-000000000002',
      journalIdsBefore: ['command:journal-1', 'event:event-1'],
      journalIdsAfter: ['event:event-1', 'command:journal-1'],
      dispatchAttemptCountBefore: 0,
      dispatchAttemptCountAfter: 0,
      outboxEntryCountBefore: 0,
      outboxEntryCountAfter: 0,
    }
    expect(validateRestartNoReplay(exact)).toEqual({
      hostdRestarted: true,
      desktopRestarted: true,
      sameResidentReattached: true,
      exactProjectionStable: true,
      exactJournalIdsUnchanged: true,
      residentDispatchAttemptsEmpty: true,
      desktopOutboxEmpty: true,
      postRestartObservationCount: 3,
      minimumPostRestartObservationSeparationMs: 4_000,
    })
    expect(() => validateRestartNoReplay({ ...exact, observations: observations.slice(0, 2) })).toThrowError(
      expect.objectContaining({ code: 'RESTART_NOT_PROVEN' }),
    )
    const tooSoon = structuredClone(observations)
    tooSoon[2]!.observedAtMonotonicMs -= 1
    expect(() => validateRestartNoReplay({ ...exact, observations: tooSoon })).toThrow()
    expect(() => validateRestartNoReplay({ ...exact, hostProcessAfter: exact.hostProcessBefore })).toThrow()
    expect(() => validateRestartNoReplay({ ...exact, journalIdsAfter: [...exact.journalIdsAfter, 'event:new'] })).toThrowError(
      expect.objectContaining({ code: 'REPLAY_NOT_DISPROVEN' }),
    )
    expect(() => validateRestartNoReplay({ ...exact, dispatchAttemptCountAfter: 1 })).toThrow()
    expect(() => validateRestartNoReplay({ ...exact, outboxEntryCountAfter: 1 })).toThrow()
    const changed = structuredClone(observations)
    changed[2]!.snapshot.latestCursor.sequence += 1
    expect(() => validateRestartNoReplay({ ...exact, observations: changed })).toThrow()
  })

  it('requires the exact GUI End projection, ended control state, and completed lifecycle before daemon cleanup', () => {
    const identity = dogfoodIdentity()
    const completed = completedProjection(identity)
    const authority = { hostId: 'host-1', threadId: 'thread-1', executionGenerationId: 'execution-1' }
    const snapshot = endedProjection(completed)
    const ended = validateEndedProjection(snapshot, { completedSnapshot: completed, authority })
    expect(ended).toMatchObject({ operationId: 'end-operation-1', endedAt: snapshot.generatedAt })
    expect(validateEndedControlProjection(endedControlProjection(snapshot), { authority, ended })).toBe(true)
    expect(validateCompletedEndLifecycleStatus(endLifecycleStatus(), {
      authority,
      operationId: ended.operationId,
      ended,
    })).toBe(true)

    for (const mutate of [
      (value: any) => { value.runtime = completed.runtime },
      (value: any) => { value.latestCursor.sequence += 1 },
      (value: any) => { value.materializedRecentBlocks = [] },
      (value: any) => { value.childAgents = completed.childAgents },
      (value: any) => { value.thread.recap = 'looks done' },
      (value: any) => { value.thread.currentLocation.projectId = 'project-other' },
      (value: any) => { value.thread.currentLocation.workspaceId = 'workspace-other' },
      (value: any) => { value.thread.projectIdentity = 'project-identity-other' },
    ]) {
      const invalid = structuredClone(snapshot)
      mutate(invalid)
      expect(() => validateEndedProjection(invalid, { completedSnapshot: completed, authority })).toThrowError(
        expect.objectContaining({ code: 'CLEANUP_UNCONFIRMED' }),
      )
    }
    const busyControl = endedControlProjection(snapshot)
    busyControl.commandReadiness = 'ready'
    expect(() => validateEndedControlProjection(busyControl, { authority, ended })).toThrow()
    const wrongFingerprint = endedControlProjection(snapshot)
    wrongFingerprint.bindingFingerprint = 'c'.repeat(64)
    expect(() => validateEndedControlProjection(wrongFingerprint, { authority, ended })).toThrow()
    expect(() => validateCompletedEndLifecycleStatus({ ...endLifecycleStatus(), phase: 'ending' }, {
      authority,
      operationId: ended.operationId,
      ended,
    })).toThrow()
    expect(() => validateCompletedEndLifecycleStatus({ ...endLifecycleStatus(), workspaceId: 'workspace-other' }, {
      authority,
      operationId: ended.operationId,
      ended,
    })).toThrow()
  })

  it('binds loopback order, strict stable-ref proof JSON, a PNG screenshot, and no browser lifecycle residue', async () => {
    const identity = dogfoodIdentity()
    expect(validateLoopbackEvidence([
      { runId: identity.runId, action: 'open' },
      { runId: identity.runId, action: 'fill', value: identity.fillValue },
      { runId: identity.runId, action: 'click', value: identity.fillValue },
    ], identity)).toMatchObject({ openIndex: 0, fillIndex: 1, clickIndex: 2 })
    expect(() => validateLoopbackEvidence([
      { runId: identity.runId, action: 'open' },
      { runId: identity.runId, action: 'click', value: identity.fillValue },
    ], identity)).toThrowError(expect.objectContaining({ code: 'BROWSER_PROOF_INVALID' }))

    const proof = exactProof(identity)
    expect(parseAndValidateProof(Buffer.from(JSON.stringify(proof)), identity)).toEqual(proof)
    expect(() => parseAndValidateProof(Buffer.from(JSON.stringify({ ...proof, unexpected: true })), identity)).toThrow()
    expect(() => parseAndValidateProof(Buffer.from(JSON.stringify({
      ...proof,
      browser: { ...proof.browser, buttonRef: proof.browser.inputRef },
    })), identity)).toThrow()

    const root = await mkdtemp(join(tmpdir(), 'prime-continuim-tool-dogfood-test-'))
    const state = join(root, 'browser')
    const screenshot = join(root, SCREENSHOT_NAME)
    const proofPath = join(root, 'proof.json')
    const proofAlias = join(root, 'proof-alias.json')
    await mkdir(join(state, 'authority', 'session'), { recursive: true })
    await writeFile(screenshot, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, 1)]))
    await writeFile(proofPath, JSON.stringify(proof), { mode: 0o600 })
    try {
      await expect(readAndValidateProof(proofPath, identity)).resolves.toEqual(proof)
      await link(proofPath, proofAlias)
      await expect(readAndValidateProof(proofAlias, identity)).rejects.toMatchObject({ code: 'BROWSER_PROOF_INVALID' })
      await expect(validateScreenshot(screenshot)).resolves.toMatchObject({ byteLength: 40 })
      await expect(assertBrowserStateRetired(state)).resolves.toMatchObject({ retired: true })
      await writeFile(join(state, 'authority', 'session', 'launch.json'), '{}')
      await expect(assertBrowserStateRetired(state)).rejects.toMatchObject({ code: 'BROWSER_RESIDUE_RETAINED' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes a path-free fail-closed receipt and makes external disposal non-successful', () => {
    const identity = dogfoodIdentity()
    const completed = completedProjection(identity)
    const functional = createFunctionalReceipt({
      platform: 'darwin',
      arch: 'arm64',
      runId: identity.runId,
      candidate: {
        artifact: 'macos-directory-package',
        runtime: 'prime-agent',
        releaseVersion: PRIME_AGENT_RELEASE_VERSION,
        runtimeTreeSha256: 'a'.repeat(64),
        attestationSha256: 'b'.repeat(64),
        appAsarSha256: '1'.repeat(64),
        desktopExecutableSha256: '2'.repeat(64),
        hostExecutableSha256: '3'.repeat(64),
        browserExecutableSha256: '4'.repeat(64),
        hostdSha256: '5'.repeat(64),
      },
      workspaceCheckpoint: { detachedHead: true, initiallyClean: true, head: 'c'.repeat(64) },
      authority: {
        hostId: 'host-1',
        threadId: 'thread-1',
        executionGenerationId: 'execution-1',
      },
      proof: {
        runtimeModel: RUNTIME_MODEL_ID,
        inFlightObserved: true,
        inFlightProjectionSha256: '7'.repeat(64),
        inFlightRootActivity: 'runtime_stream',
        inFlightChildState: 'running',
        inFlightSequence: 12,
        childName: CHILD_NAME,
        childAgentId: completed.childAgents[0]!.agentId,
        childReplied: true,
        goalId: completed.goals[0]!.goalId,
        goalState: 'complete',
        browserSurface: BROWSER_SURFACE,
        browserOperations: ['open', 'snapshot', 'fill', 'click', 'eval', 'screenshot', 'close'],
        stableReferenceCount: 2,
        loopbackEventCount: 3,
        transcriptSha256: 'd'.repeat(64),
        screenshotSha256: 'e'.repeat(64),
        screenshotBytes: 40,
        browserStateEntriesInspected: 2,
        completionProjectionSha256: 'f'.repeat(64),
        hostdRestarted: true,
        desktopRestarted: true,
        sameResidentReattached: true,
        exactProjectionStable: true,
        exactJournalIdsUnchanged: true,
        residentDispatchAttemptsEmpty: true,
        desktopOutboxEmpty: true,
        postRestartObservationCount: 3,
        minimumPostRestartObservationSeparationMs: 4_000,
        residentEndProjectionSha256: '6'.repeat(64),
        residentEndLifecycleCompleted: true,
        residentDaemonSessionsAfterEnd: 0,
        residentDaemonShutdownConfirmed: true,
        residentDaemonEndpointRetired: true,
        residentDaemonOwnerRetired: true,
        residentDaemonIdentityCount: 3,
        residentDaemonTerminatedIdentityCount: 3,
        residentDaemonProcessGroupCount: 2,
        residentDaemonRetiredProcessGroupCount: 2,
      },
      ownedProcesses: { desktopStopped: true, hostdStopped: true, residentDaemonStopped: true },
    })
    expect(validateReceipt(functional)).toBe(functional)
    expect(JSON.parse(serializeReceipt(functional).toString('utf8'))).toMatchObject({
      schemaVersion: 4,
      kind: EVIDENCE_KIND,
      outcome: 'functional_passed_external_disposal_required',
      cleanup: {
        browserStateRetired: true,
        loopbackConnectionsRetired: true,
        externalDisposalRequired: true,
        externalDisposalConfirmed: false,
      },
      proof: {
        hostdRestarted: true,
        desktopRestarted: true,
        sameResidentReattached: true,
        exactProjectionStable: true,
        exactJournalIdsUnchanged: true,
        residentDispatchAttemptsEmpty: true,
        desktopOutboxEmpty: true,
      },
      nonclaims: NONCLAIMS,
    })
    expect(FUNCTIONAL_EXIT_CODE).toBe(2)

    const failed = createFailureReceipt({
      platform: 'darwin',
      arch: 'arm64',
      runId: identity.runId,
      stage: 'browser',
      code: 'BROWSER_PROOF_INVALID',
      browserStateRetired: false,
      loopbackConnectionsRetired: true,
      providerMayHaveBeenUsed: true,
    })
    expect(failed).toMatchObject({
      outcome: 'failed_fixture_retained',
      stage: 'browser',
      ownedProcesses: { residentDaemonStopped: false },
    })
    expect(() => validateReceipt({
      ...functional,
      ownedProcesses: { ...functional.ownedProcesses, residentDaemonStopped: false },
    })).toThrowError(expect.objectContaining({ code: 'RECEIPT_INVALID' }))
    expect(() => validateReceipt({
      ...functional,
      proof: { ...functional.proof, residentDaemonTerminatedIdentityCount: 2 },
    })).toThrowError(expect.objectContaining({ code: 'RECEIPT_INVALID' }))
    expect(() => validateReceipt({
      ...functional,
      proof: { ...functional.proof, residentDaemonRetiredProcessGroupCount: 1 },
    })).toThrowError(expect.objectContaining({ code: 'RECEIPT_INVALID' }))
    expect(() => validateReceipt({
      ...functional,
      proof: {
        ...functional.proof,
        residentDaemonIdentityCount: 129,
        residentDaemonTerminatedIdentityCount: 129,
      },
    })).toThrowError(expect.objectContaining({ code: 'RECEIPT_INVALID' }))
    expect(() => validateReceipt({
      ...functional,
      proof: {
        ...functional.proof,
        residentDaemonIdentityCount: 1,
        residentDaemonTerminatedIdentityCount: 1,
        residentDaemonProcessGroupCount: 2,
        residentDaemonRetiredProcessGroupCount: 2,
      },
    })).toThrowError(expect.objectContaining({ code: 'RECEIPT_INVALID' }))
    expect(() => validateReceipt({
      ...functional,
      candidate: { ...functional.candidate, releaseVersion: '0.7.1' },
    })).toThrowError(expect.objectContaining({ code: 'RECEIPT_INVALID' }))
    expect(() => validateReceipt({ ...functional, schemaVersion: 3 })).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_INVALID' }),
    )
    expect(() => validateReceipt({ ...functional, receiptPath: '/Users/operator/secret' })).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_INVALID' }),
    )
  })

  it('keeps the live lane operator-driven, credential-opaque, separate from the no-tools lane, and outside normal workflows', async () => {
    const [source, daemonCleanup, existingLane, packageManifest, runtimePolicy, workflow, readme, runbook] = await Promise.all([
      readFile(resolve('scripts/verify-prime-agent-tool-dogfood.mjs'), 'utf8'),
      readFile(resolve('scripts/prime-agent-tool-dogfood-daemon-cleanup.mjs'), 'utf8'),
      readFile(resolve('scripts/verify-prime-agent-provider-e2e.mjs'), 'utf8'),
      readFile(resolve('package.json'), 'utf8'),
      readFile(resolve('runtime/prime-agent/runtime-policy.json'), 'utf8'),
      readFile(resolve('scripts/run-workflow.mjs'), 'utf8'),
      readFile(resolve('README.md'), 'utf8'),
      readFile(resolve('docs/prime-agent-journey-gate.md'), 'utf8'),
    ])
    expect(source).toContain('"thread.snapshot"')
    expect(source).toContain('"runtime.model_catalog"')
    expect(source).not.toContain('"command.submit"')
    expect(source).not.toContain('"resident.provision"')
    expect(source).not.toContain('"resident.end"')
    expect(source).not.toContain('"oauth.attempt.start"')
    expect(source).not.toContain('auth.json')
    expect(source).not.toContain('oauth.json')
    expect(source).toContain('validateCompletedProjection')
    expect(source).toContain('validateInFlightProjection')
    expect(source).toContain('waitForInFlightProjection')
    expect(source).toContain('attestation.runtime.releaseVersion !== PRIME_AGENT_RELEASE_VERSION')
    expect(source).toContain('validateRestartNoReplay')
    expect(source).toContain('observeStableRestart')
    expect(source).toContain('inspectReplayState')
    expect(source).toContain('exactJournalIdsUnchanged')
    expect(source).toContain('assertBrowserStateRetired')
    expect(source).toContain('verifyMacosPackage')
    expect(source).toContain('"--browser-executable"')
    expect(source).toContain('candidate.browserExecutable')
    expect(daemonCleanup).toContain('client.request({ type: "shutdown" }')
    expect(daemonCleanup).toContain('shutdownConfirmed')
    expect(daemonCleanup).toContain('terminatedIdentityCount')
    expect(daemonCleanup).toContain('retiredProcessGroupCount')
    expect(daemonCleanup).not.toContain('shutdownDaemonAndWait')
    expect(source).toContain('choose End session once')
    expect(source).toContain('Quit the isolated Prime Continuim app now (Cmd+Q)')
    expect(source).not.toContain('shutdown --force')
    expect(daemonCleanup).not.toContain('force: true')
    expect(source).toContain('macos-directory-package')
    expect(source.indexOf('await readPackagedCandidate()')).toBeLessThan(
      source.indexOf('confirmation.question('),
    )
    expect(source).toContain('before requesting live-provider authorization')
    expect(source).toContain('process.exitCode = FUNCTIONAL_EXIT_CODE')
    expect(source).toContain('writeReceiptNoReplace')
    expect(existingLane).toContain('LONG_NO_TOOLS_PROMPT')
    expect(existingLane).toContain('Do not use tools, read files, modify files, or make network requests.')
    expect(existingLane).not.toContain('verify-prime-agent-tool-dogfood')
    expect(JSON.parse(packageManifest).scripts['verify:prime-agent-tool-dogfood']).toBe(
      'node scripts/verify-prime-agent-tool-dogfood.mjs',
    )
    expect(PRIME_AGENT_RELEASE_VERSION).toBe('0.7.2')
    expect(JSON.parse(runtimePolicy).releaseVersion).toBe(PRIME_AGENT_RELEASE_VERSION)
    expect(workflow).not.toContain('verify:prime-agent-tool-dogfood')
    expect(readme).toContain('verify:prime-agent-tool-dogfood')
    expect(runbook).toContain('three interval-separated production snapshots')
    expect(runbook).toContain('observable in-flight root turn')
    expect(runbook).toContain('Prime Agent v0.7.2')
    expect(runbook).toContain('arm64) DOGFOOD_APP_DIR=mac-arm64')
    expect(runbook).toContain('x86_64) DOGFOOD_APP_DIR=mac')
    expect(runbook).toContain('release/$DOGFOOD_APP_DIR/Prime Continuim.app')
    expect(runbook).toContain('never reads credential files')
    expect(runbook).toContain('never')
    expect(runbook).toContain('submits a resident command')
    expect(runbook).toContain('intentionally exits with code `2`')
  })
})

function admission() {
  return {
    platform: 'darwin',
    stdinIsTTY: true,
    stdoutIsTTY: true,
    ci: undefined,
    githubActions: undefined,
    argv: [OPT_IN_FLAG, DISPOSABLE_CHECKPOINT_FLAG],
    checkpointAssertion: CHECKPOINT_ASSERTION,
  }
}

function dogfoodIdentity() {
  return createDogfoodIdentity('sol-rlm-browser-test', 'a'.repeat(48))
}

function modelCatalog() {
  return {
    runtime: 'prime_agent',
    providers: [{
      providerId: PROVIDER_ID,
      oauthSupported: true,
      configured: true,
    }],
    models: [{
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      available: true,
      usingOAuth: true,
    }],
  }
}

function initialProjection(_identity: ReturnType<typeof dogfoodIdentity>) {
  return {
    thread: {
      threadId: 'thread-1',
      projectIdentity: 'project-identity-1',
      status: 'idle',
      currentLocation: {
        hostId: 'host-1',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        executionGenerationId: 'execution-1',
      },
    },
    runtime: {
      runtime: 'prime_agent',
      residency: 'resident',
      activeSessionId: 'active-1',
      sessionId: 'session-1',
      model: RUNTIME_MODEL_ID,
      resourceInventory: {
        skills: [{ name: BROWSER_SURFACE, sourceKind: { scope: 'temporary', origin: 'top-level' } }],
        diagnostics: { errorCount: 0, warningCount: 0, collisions: [] },
      },
    },
    inProgressStream: undefined,
    queueState: { pendingCommandIds: [], paused: false },
    childAgents: [],
    goals: [],
    residentControl: {
      hostId: 'host-1',
      threadId: 'thread-1',
      executionGenerationId: 'execution-1',
      browserExecution: {
        readiness: 'ready',
        surface: BROWSER_SURFACE,
      },
    },
    latestCursor: {
      threadId: 'thread-1',
      executionGenerationId: 'execution-1',
      generation: 'generation-1',
      sequence: 4,
    },
    materializedRecentBlocks: [],
  }
}

function completedProjection(identity: ReturnType<typeof dogfoodIdentity>) {
  const value = initialProjection(identity)
  return {
    ...value,
    childAgents: [{
      agentId: 'child-1',
      sessionName: CHILD_NAME,
      title: 'Browser auditor',
      state: 'complete',
      model: RUNTIME_MODEL_ID,
      repliedSinceTask: true,
    }],
    goals: [{ goalId: 'goal-1', objective: identity.goalObjective, state: 'complete' }],
    latestCursor: { ...value.latestCursor, sequence: 42 },
    materializedRecentBlocks: [{
      blockId: 'block-1',
      sequence: 41,
      kind: 'assistant',
      createdAt: '2026-08-10T12:00:00.000Z',
      text: [
        identity.childToken,
        `${BROWSER_SURFACE} snapshot [ref=e12] [ref=e13]`,
        `fill ${identity.fillValue}`,
        `clicked:${identity.fillValue}`,
        `screenshot ${PROOF_DIRECTORY}/${SCREENSHOT_NAME}`,
        'close',
        identity.finalMarker,
      ].join('\n'),
    }],
  }
}

function inFlightProjection(identity: ReturnType<typeof dogfoodIdentity>) {
  const value = initialProjection(identity)
  return {
    ...value,
    thread: { ...value.thread, status: 'running' },
    runtime: {
      ...value.runtime,
      isStreaming: true,
      isCompacting: false,
      isBashRunning: false,
      activeToolNames: ['rlm'],
    },
    childAgents: [{
      agentId: 'child-1',
      sessionName: CHILD_NAME,
      title: 'Browser auditor',
      state: 'running',
      model: RUNTIME_MODEL_ID,
      repliedSinceTask: false,
      activity: { kind: 'executing', toolName: BROWSER_SURFACE },
    }],
    goals: [{ goalId: 'goal-1', objective: identity.goalObjective, state: 'active' }],
    latestCursor: { ...value.latestCursor, sequence: 12 },
  }
}

function endedProjection(completed: ReturnType<typeof completedProjection>) {
  const generatedAt = '2026-08-10T12:01:00.000Z'
  return {
    ...completed,
    snapshotVersion: 1,
    generatedAt,
    thread: {
      ...completed.thread,
      status: 'idle',
      recap: 'Resident session ended.',
      updatedAt: generatedAt,
      lastKnownCursor: completed.latestCursor,
    },
    runtime: undefined,
    inProgressStream: undefined,
    queueState: { pendingCommandIds: [], paused: false },
    approvals: [],
    childAgents: [],
    goals: [],
    schedules: [],
    pendingAttention: [],
    residentControl: undefined,
    residentLifecycle: {
      version: 1,
      state: 'ended',
      operationId: 'end-operation-1',
      bindingFingerprint: 'b'.repeat(64),
      endedAt: generatedAt,
      sourceCursor: completed.latestCursor,
      reason: 'user_end',
    },
  }
}

function endedControlProjection(snapshot: ReturnType<typeof endedProjection>): any {
  return {
    projectionVersion: 1,
    hostId: 'host-1',
    threadId: 'thread-1',
    executionGenerationId: 'execution-1',
    bindingFingerprint: 'b'.repeat(64),
    controlSequence: 7,
    changedAt: snapshot.generatedAt,
    authorityCursor: snapshot.latestCursor,
    commandReadiness: 'unavailable',
    browserExecution: { readiness: 'unavailable' },
    quiescence: { state: 'ended', endedAt: snapshot.generatedAt },
  }
}

function endLifecycleStatus() {
  return {
    version: 1,
    kind: 'end',
    operationId: 'end-operation-1',
    phase: 'completed',
    expectedHostId: 'host-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    threadId: 'thread-1',
    executionGenerationId: 'execution-1',
    preparedAt: '2026-08-10T12:00:30.000Z',
    updatedAt: '2026-08-10T12:01:00.000Z',
    terminalAt: '2026-08-10T12:01:00.000Z',
  }
}

function exactProof(identity: ReturnType<typeof dogfoodIdentity>) {
  return {
    schemaVersion: 1,
    runId: identity.runId,
    runtimeModel: RUNTIME_MODEL_ID,
    childName: CHILD_NAME,
    childToken: identity.childToken,
    browser: {
      sessionName: identity.sessionName,
      inputRef: 'e12',
      buttonRef: 'e13',
      fillValue: identity.fillValue,
      evalResult: `clicked:${identity.fillValue}`,
      screenshot: `${PROOF_DIRECTORY}/${SCREENSHOT_NAME}`,
      closed: true,
    },
  }
}
