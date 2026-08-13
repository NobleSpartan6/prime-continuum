const { access, mkdir, readFile, writeFile } = require('node:fs/promises')
const { createServer } = require('node:http')
const { extname, join, relative, resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { app, BrowserWindow } = require('electron')

// Each target owns a short-lived BrowserWindow. Keep Electron alive between
// captures even if the platform emits window-all-closed before the hidden
// keeper window is painted; the harness exits explicitly after the manifest.
app.on('window-all-closed', (event) => event.preventDefault())

const repositoryRoot = resolve(__dirname, '..')
const rendererRoot = join(repositoryRoot, 'out', 'renderer')
const rendererEntry = join(rendererRoot, 'index.html')
const outputDirectory = join(repositoryRoot, 'out', 'visual-qa')
const resultPath = join(outputDirectory, 'capture-result.json')
const errorPath = join(outputDirectory, 'capture-error.txt')
const visualQaUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 PrimeContinuimVisualQA/1'
const providerHandoffEvidenceBoundary = 'Internal renderer preview: layout only; no Terminal launch, provider login, or account refresh.'
const targets = [
  {
    name: 'desktop-agent-launchpad',
    width: 1600,
    height: 1000,
    visualState: 'launchpad',
    expectedText: 'Give Prime Agent a goal.',
    expectLaunchpadContinuitySuppressed: true,
  },
  {
    name: 'mobile-agent-launchpad-390',
    width: 390,
    height: 844,
    visualState: 'launchpad',
    expectedText: 'Give Prime Agent a goal.',
    expectResponsiveTopbar: true,
    expectLaunchpadContinuitySuppressed: true,
  },
  {
    name: 'desktop-idle',
    width: 1600,
    height: 1000,
    visualState: 'idle',
    expectedText: 'Prime Agent is ready for another task.',
  },
  {
    name: 'desktop-investigation',
    width: 1600,
    height: 1000,
    visualState: 'idle',
    expectedText: 'Investigate an issue',
    openInspector: true,
    selectTaskStarter: 'Investigate an issue',
  },
  {
    name: 'desktop-rlm-activity',
    width: 1200,
    height: 800,
    visualState: 'rlm-activity',
    expectedText: 'RLM delegation',
    openInspector: true,
    selectRuntimeTab: true,
    expectDockedComposerBounded: true,
  },
  {
    name: 'desktop-rlm-outcome',
    width: 1200,
    height: 800,
    visualState: 'rlm-outcome',
    expectedText: 'Outcome lead',
    openInspector: true,
    expectOutcomeBranchHierarchy: true,
  },
  {
    name: 'desktop-extension-question',
    width: 1200,
    height: 800,
    visualState: 'extension-ui-confirm',
    expectedText: 'Use the verified migration plan?',
    expectExtensionQuestion: true,
  },
  {
    name: 'mobile-extension-question-390',
    width: 390,
    height: 844,
    visualState: 'extension-ui-confirm',
    expectedText: 'Use the verified migration plan?',
    expectResponsiveTopbar: true,
    expectExtensionQuestion: true,
  },
  {
    name: 'mobile-idle-390',
    width: 390,
    height: 844,
    visualState: 'idle',
    expectedText: 'Prime Agent is ready for another task.',
    expectResponsiveTopbar: true,
    expectBoundedTaskStarters: true,
  },
  {
    name: 'compact-idle-320',
    width: 320,
    height: 704,
    visualState: 'idle',
    expectedText: 'Prime Agent is ready for another task.',
    expectResponsiveTopbar: true,
    expectBoundedTaskStarters: true,
  },
  {
    name: 'desktop-ended-empty',
    width: 1600,
    height: 1000,
    visualState: 'ended-empty',
    expectedText: 'No transcript was recorded. Your workspace and files remain available.',
    expectEndedEmpty: true,
  },
  {
    name: 'ended-empty-390',
    width: 390,
    height: 844,
    visualState: 'ended-empty',
    expectedText: 'No transcript was recorded. Your workspace and files remain available.',
    expectResponsiveTopbar: true,
    expectEndedEmpty: true,
  },
  {
    name: 'ended-empty-320',
    width: 320,
    height: 704,
    visualState: 'ended-empty',
    expectedText: 'No transcript was recorded. Your workspace and files remain available.',
    expectResponsiveTopbar: true,
    expectEndedEmpty: true,
  },
  {
    name: 'mobile-inspector-390',
    width: 390,
    height: 844,
    visualState: 'idle',
    expectedText: 'Prime Agent is ready for another task.',
    openInspector: true,
    expectResponsiveTopbar: true,
    expectResponsiveDrawer: true,
  },
  {
    name: 'model-selection-dialog-390',
    width: 390,
    height: 844,
    visualState: 'model-selection',
    expectedText: 'Choose a model for this thread’s next prompt. This changes the resident session only; it does not send a prompt. “Available” means Prime Agent reports provider access, not that an inference smoke test passed.',
    expectModelAction: 'Use model GPT-5.6 Luna',
    openModelsDialog: true,
  },
  {
    name: 'model-selection-dialog-short-320',
    width: 320,
    height: 256,
    visualState: 'model-selection',
    expectedText: 'Choose a model for this thread’s next prompt. This changes the resident session only; it does not send a prompt. “Available” means Prime Agent reports provider access, not that an inference smoke test passed.',
    expectModelAction: 'Use model GPT-5.6 Terra',
    openModelsDialog: true,
    expectShortModelsDialog: true,
  },
  {
    name: 'reasoning-control-dialog-390',
    width: 390,
    height: 844,
    visualState: 'model-selection',
    expectedText: 'Applies to the next prompt.',
    expectReasoningControl: true,
    openModelsDialog: true,
  },
  {
    name: 'reasoning-control-dialog-short-320',
    width: 320,
    height: 256,
    visualState: 'model-selection',
    expectedText: 'Applies to the next prompt.',
    expectReasoningControl: true,
    expectShortModelsDialog: true,
    openModelsDialog: true,
  },
  {
    name: 'prime-oauth-dialog-390',
    width: 390,
    height: 844,
    visualState: 'prime-oauth',
    expectedText: 'Sign-in opens in your browser; this view never receives the authorization URL or credential.',
    expectOAuthAction: 'Connect ChatGPT',
    selectProviderId: 'openai-codex',
    openModelsDialog: true,
  },
  {
    name: 'prime-oauth-dialog-short-320',
    width: 320,
    height: 256,
    visualState: 'prime-oauth',
    expectedText: 'Sign-in opens in your browser; this view never receives the authorization URL or credential.',
    expectOAuthAction: 'Connect ChatGPT',
    selectProviderId: 'openai-codex',
    openModelsDialog: true,
    expectShortModelsDialog: true,
  },
  {
    name: 'provider-handoff-unopened-390',
    width: 390,
    height: 844,
    visualState: 'provider-handoff-unopened',
    expectedText: 'Open Prime Agent, run /login, and choose Anthropic (Claude Pro/Max).',
    expectProviderSetupAction: 'Open Prime Agent',
    expectProviderSetupState: 'unopened',
    selectProviderId: 'anthropic',
    openModelsDialog: true,
    evidenceBoundary: providerHandoffEvidenceBoundary,
  },
  {
    name: 'provider-handoff-unopened-short-320',
    width: 320,
    height: 256,
    visualState: 'provider-handoff-unopened',
    expectedText: 'Open Prime Agent, run /login, and choose Anthropic (Claude Pro/Max).',
    expectProviderSetupAction: 'Open Prime Agent',
    expectProviderSetupState: 'unopened',
    selectProviderId: 'anthropic',
    openModelsDialog: true,
    expectShortModelsDialog: true,
    evidenceBoundary: providerHandoffEvidenceBoundary,
  },
  {
    name: 'provider-handoff-opened-390',
    width: 390,
    height: 844,
    visualState: 'provider-handoff-opened',
    expectedText: 'Prime Agent opened. Run /login, choose your provider, then return here.',
    expectProviderSetupAction: 'Check account',
    expectProviderSetupState: 'opened',
    triggerProviderSetup: true,
    selectProviderId: 'anthropic',
    openModelsDialog: true,
    evidenceBoundary: providerHandoffEvidenceBoundary,
  },
  {
    name: 'provider-handoff-opened-short-320',
    width: 320,
    height: 256,
    visualState: 'provider-handoff-opened',
    expectedText: 'Prime Agent opened. Run /login, choose your provider, then return here.',
    expectProviderSetupAction: 'Check account',
    expectProviderSetupState: 'opened',
    triggerProviderSetup: true,
    selectProviderId: 'anthropic',
    openModelsDialog: true,
    expectShortModelsDialog: true,
    evidenceBoundary: providerHandoffEvidenceBoundary,
  },
  {
    name: 'provider-handoff-indeterminate-390',
    width: 390,
    height: 844,
    visualState: 'provider-handoff-indeterminate',
    expectedText: 'Prime Agent may already be open. Check your windows first; Prime Continuim won’t repeat this request.',
    expectProviderSetupAction: 'Check account',
    expectProviderSetupState: 'indeterminate',
    triggerProviderSetup: true,
    selectProviderId: 'anthropic',
    openModelsDialog: true,
    evidenceBoundary: providerHandoffEvidenceBoundary,
  },
  {
    name: 'provider-handoff-indeterminate-short-320',
    width: 320,
    height: 256,
    visualState: 'provider-handoff-indeterminate',
    expectedText: 'Prime Agent may already be open. Check your windows first; Prime Continuim won’t repeat this request.',
    expectProviderSetupAction: 'Check account',
    expectProviderSetupState: 'indeterminate',
    triggerProviderSetup: true,
    selectProviderId: 'anthropic',
    openModelsDialog: true,
    expectShortModelsDialog: true,
    evidenceBoundary: providerHandoffEvidenceBoundary,
  },
  {
    name: 'desktop-prompt-admission',
    width: 1200,
    height: 800,
    visualState: 'prompt-admission',
    expectedText: 'Delegating the task to Prime Agent.',
    expectStatusVisible: true,
  },
  {
    name: 'desktop-prompt-proof-390',
    width: 390,
    height: 844,
    visualState: 'prompt-awaiting-idle-proof',
    expectedText: 'Prime Agent owns the task. Waiting for fresh activity.',
    expectStatusVisible: true,
    expectCompactStatus: true,
  },
  {
    name: 'desktop-stop-proof-390',
    width: 390,
    height: 844,
    visualState: 'stop-awaiting-idle-proof',
    expectedText: 'Waiting for authoritative idle proof',
    expectStatusVisible: true,
    expectCompactStatus: true,
  },
  {
    name: 'desktop-uncertain-320',
    width: 320,
    height: 704,
    visualState: 'nonretryable-uncertainty',
    expectedText: 'Outcome unknown · recovery required; this Stop will not be replayed',
    expectStatusVisible: true,
    expectCompactStatus: true,
  },
  {
    name: 'desktop-end-pending-390',
    width: 390,
    height: 844,
    visualState: 'resident-end-pending',
    expectedText: 'End saved',
    expectCompactComposer: true,
    expectStatusHidden: true,
  },
  {
    name: 'resident-start-1600',
    width: 1600,
    height: 1000,
    visualState: 'resident-start',
    expectedText: 'Choose folder',
  },
  {
    name: 'ssh-registered-workspace-dialog-390',
    width: 390,
    height: 844,
    visualState: 'ssh-registered-workspace',
    expectedText: 'Start another task',
    expectedRegisteredProject: 'Prime Continuim',
    openRegisteredResidentDialog: true,
  },
  {
    name: 'ssh-registered-workspace-dialog-short-320',
    width: 320,
    height: 256,
    visualState: 'ssh-registered-workspace',
    expectedText: 'Start another task',
    expectedRegisteredProject: 'Prime Continuim',
    openRegisteredResidentDialog: true,
    expectShortRegisteredResidentDialog: true,
  },
  {
    name: 'resident-dialog-390',
    width: 390,
    height: 844,
    visualState: 'resident-start',
    expectedText: 'Start agent',
    openResidentDialog: true,
  },
  {
    name: 'resident-dialog-short-320',
    width: 320,
    height: 256,
    visualState: 'resident-start',
    expectedText: 'Start agent',
    openResidentDialog: true,
    expectShortResidentDialog: true,
  },
  {
    name: 'resident-recovery-320',
    width: 320,
    height: 704,
    visualState: 'resident-recovery',
    expectedText: 'Reconnect workspace',
  },
  {
    name: 'resident-recovery-short-320',
    width: 320,
    height: 256,
    visualState: 'resident-recovery',
    expectedText: 'Reconnect workspace',
    expectScrollableEmpty: true,
  },
  {
    name: 'candidate-evaluation-dialog-390',
    width: 390,
    height: 844,
    visualState: 'candidate-evaluation-review',
    expectedText: 'Evaluate this candidate?',
    openCandidateEvaluationDialog: true,
  },
  {
    name: 'candidate-evaluation-dialog-short-320',
    width: 320,
    height: 256,
    visualState: 'candidate-evaluation-review',
    expectedText: 'Evaluate this candidate?',
    openCandidateEvaluationDialog: true,
    expectShortCandidateEvaluationDialog: true,
  },
  {
    name: 'hud-expanded',
    width: 620,
    height: 380,
    visualState: 'hud-expanded',
    surface: 'hud',
    expectedText: 'Seamless remote experience',
    expectHud: 'expanded',
  },
  {
    name: 'hud-expanded-320',
    width: 320,
    height: 240,
    visualState: 'hud-expanded',
    surface: 'hud',
    expectedText: 'Seamless remote experience',
    expectHud: 'expanded',
  },
  {
    name: 'hud-buddy',
    width: 184,
    height: 64,
    visualState: 'hud-buddy',
    surface: 'hud',
    expectedText: 'Prime Agent owns the task. Waiting for fresh activity.',
    expectHud: 'buddy',
  },
]

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function modelsActionExpression(target, dialogVariable) {
  if (target.expectReasoningControl) {
    return `${dialogVariable}?.querySelector('select#resident-thinking-level')`
  }
  if (target.expectModelAction) {
    return `[...(${dialogVariable}?.querySelectorAll('button') ?? [])]
      .find((candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(target.expectModelAction)})`
  }
  const expectedText = target.expectOAuthAction ?? target.expectProviderSetupAction
  return `[...(${dialogVariable}?.querySelectorAll('button') ?? [])]
    .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(expectedText)})`
}

async function waitForSurface(browserWindow, target) {
  const selector = target.expectHud
    ? `.hud-${target.expectHud}`
    : target.visualState === 'resident-start' || target.visualState === 'resident-recovery'
      ? '.empty-workbench'
      : '.app-shell'
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const found = await browserWindow.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    )
    if (found) {
      if (target.visualState === 'launchpad') {
        const launchpadReady = await browserWindow.webContents.executeJavaScript(
          `document.body.innerText.includes(${JSON.stringify(target.expectedText)})`,
        )
        if (!launchpadReady) {
          await delay(25)
          continue
        }
      }
      await delay(75)
      return
    }
    await delay(25)
  }
  const diagnostics = await browserWindow.webContents.executeJavaScript(`(() => ({
    readyState: document.readyState,
    bodyText: document.body?.innerText?.slice(0, 500) ?? '',
    bodyHtml: document.body?.innerHTML?.slice(0, 1_000) ?? '',
    scripts: [...document.scripts].map((script) => script.src || 'inline').slice(0, 8),
  }))()`)
  throw new Error(`Timed out waiting for ${selector}: ${JSON.stringify(diagnostics)}`)
}

async function startRendererServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
      const filePath = resolve(rendererRoot, `.${pathname}`)
      const relativePath = relative(rendererRoot, filePath)
      if (relativePath.startsWith('..') || resolve(filePath) === resolve(rendererRoot)) {
        response.writeHead(403).end('Forbidden')
        return
      }
      const contentType = ({
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
      })[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': contentType,
      })
      response.end(await readFile(filePath))
    } catch {
      response.writeHead(404).end('Not found')
    }
  })
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  invariant(address && typeof address === 'object', 'Renderer visual server did not bind a TCP port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => error ? rejectPromise(error) : resolvePromise())
    }),
  }
}

async function capture(target, rendererOrigin) {
  const browserWindow = new BrowserWindow({
    show: false,
    frame: false,
    useContentSize: true,
    width: target.width,
    height: target.height,
    backgroundColor: target.surface === 'hud' ? '#00000000' : '#0b0d0f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  try {
    let registeredWorkspaceTriggerEvidence
    browserWindow.setContentSize(target.width, target.height, false)
    browserWindow.webContents.setUserAgent(visualQaUserAgent)
    const rendererUrl = new URL('/', rendererOrigin)
    if (target.visualState) rendererUrl.searchParams.set('visualState', target.visualState)
    if (target.surface) rendererUrl.searchParams.set('surface', target.surface)
    await browserWindow.loadURL(rendererUrl.href)
    if (target.visualState === 'launchpad' && target.width <= 390) {
      // Hidden macOS Electron windows can occasionally expose complete DOM
      // geometry before their compositor surface paints. Keep the real window
      // offscreen while requiring an actual paint for launchpad evidence.
      browserWindow.setPosition(-10_000, -10_000, false)
      browserWindow.showInactive()
    }
    await waitForSurface(browserWindow, target)
    if (target.openInspector || target.selectTaskStarter) {
      const workbenchActions = await browserWindow.webContents.executeJavaScript(`(() => {
        const inspector = document.querySelector('button[aria-label="Open inspector"], button[aria-label="Close inspector"]')
        const inspectorOpen = document.querySelector('.app-shell')?.getAttribute('data-inspector-open') === 'true'
        const starter = [...document.querySelectorAll('.task-starters button')]
          .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(target.selectTaskStarter)})
        if (${Boolean(target.openInspector)} && !inspectorOpen && inspector instanceof HTMLButtonElement) inspector.click()
        if (${Boolean(target.selectTaskStarter)} && starter instanceof HTMLButtonElement) starter.click()
        return {
          inspectorFound: inspector instanceof HTMLButtonElement,
          starterFound: starter instanceof HTMLButtonElement,
        }
      })()`)
      invariant(!target.openInspector || workbenchActions.inspectorFound, `${target.name} did not expose the inspector action`)
      invariant(!target.selectTaskStarter || workbenchActions.starterFound, `${target.name} did not expose the task starter`)
      let workbenchInteraction
      const interactionDeadline = Date.now() + 10_000
      while (Date.now() < interactionDeadline) {
        workbenchInteraction = await browserWindow.webContents.executeJavaScript(`(() => {
          const starter = [...document.querySelectorAll('.task-starters button')]
            .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(target.selectTaskStarter)})
          const composer = document.querySelector('#thread-composer')
          return {
            inspectorOpen: document.querySelector('.app-shell')?.getAttribute('data-inspector-open') === 'true',
            starterSelected: starter?.getAttribute('aria-pressed') === 'true',
            composerGuided: composer instanceof HTMLTextAreaElement &&
              composer.value === '' &&
              composer.placeholder === 'Describe the issue, reproduction details, expected behavior, and done criteria…' &&
              document.activeElement === composer,
          }
        })()`)
        if (
          (!target.openInspector || workbenchInteraction.inspectorOpen) &&
          (!target.selectTaskStarter || (workbenchInteraction.starterSelected && workbenchInteraction.composerGuided))
        ) break
        await delay(25)
      }
      invariant(!target.openInspector || workbenchInteraction?.inspectorOpen, `${target.name} did not open the inspector`)
      invariant(!target.selectTaskStarter || (
        workbenchInteraction?.starterSelected && workbenchInteraction?.composerGuided
      ), `${target.name} did not focus the composer with the selected task guidance`)
      await delay(500)
    }
    if (target.selectRuntimeTab) {
      const runtimeTabEvidence = await browserWindow.webContents.executeJavaScript(`(() => {
        const tab = document.querySelector('#inspector-tab-session')
        if (tab instanceof HTMLButtonElement) tab.click()
        return { found: tab instanceof HTMLButtonElement }
      })()`)
      invariant(runtimeTabEvidence.found, `${target.name} did not expose the Session inspector tab`)
      const runtimeDeadline = Date.now() + 10_000
      let runtimeVisible = false
      while (Date.now() < runtimeDeadline) {
        runtimeVisible = await browserWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('#inspector-panel-session .rlm-map'))`,
        )
        if (runtimeVisible) break
        await delay(25)
      }
      invariant(runtimeVisible, `${target.name} did not render the agent hierarchy`)
      const hierarchyStartsNearTop = await browserWindow.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('#inspector-panel-session')
        const hierarchy = panel?.querySelector('.runtime-subsection--rlm')
        if (!(panel instanceof HTMLElement) || !(hierarchy instanceof HTMLElement)) return false
        return hierarchy.getBoundingClientRect().top - panel.getBoundingClientRect().top < 180
      })()`)
      invariant(hierarchyStartsNearTop, `${target.name} hid the agent hierarchy below session details`)
      await delay(150)
    }
    if (target.expectOutcomeBranchHierarchy) {
      const branchHierarchyStaged = await browserWindow.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('#inspector-panel-review')
        const heading = [...document.querySelectorAll('.outcome-review__section h3')]
          .find((candidate) => candidate.textContent?.trim() === 'Branch returns')
        const branches = heading?.closest('.outcome-review__section')
        if (!(panel instanceof HTMLElement) || !(branches instanceof HTMLElement)) return false
        panel.scrollTop += branches.getBoundingClientRect().top - panel.getBoundingClientRect().top
        return true
      })()`)
      invariant(branchHierarchyStaged, `${target.name} did not expose the recursive outcome hierarchy`)
      await delay(250)
    }
    if (target.openModelsDialog) {
      // Paint the real native surface offscreen, then use the visible composer
      // action that a person would use. Model, OAuth, and account-refresh
      // actions remain untouched. Provider handoff outcomes are exercised only
      // by the in-memory preview API; this harness cannot launch Terminal.
      browserWindow.setPosition(-10_000, -10_000, false)
      browserWindow.showInactive()
      const modelTriggerEvidence = await browserWindow.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('button.model-chip')
        if (button instanceof HTMLButtonElement) {
          button.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
        const rect = button?.getBoundingClientRect()
        const style = button ? window.getComputedStyle(button) : undefined
        const visible = Boolean(
          button instanceof HTMLButtonElement &&
          !button.disabled &&
          style &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left >= 0 &&
          rect.right <= window.innerWidth &&
          rect.top >= 0 &&
          rect.bottom <= window.innerHeight
        )
        if (button instanceof HTMLButtonElement && visible) button.click()
        return {
          found: button instanceof HTMLButtonElement,
          enabled: button instanceof HTMLButtonElement && !button.disabled,
          visible,
          rect: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : undefined,
        }
      })()`)
      invariant(
        modelTriggerEvidence.visible,
        `${target.name} did not expose the visible Models & accounts composer action: ${JSON.stringify(modelTriggerEvidence)}`,
      )
      if (target.selectProviderId) {
        const providerDeadline = Date.now() + 10_000
        while (Date.now() < providerDeadline) {
          const selected = await browserWindow.webContents.executeJavaScript(`(() => {
            const dialog = document.querySelector('dialog[open][aria-labelledby="models-title"]')
            const button = dialog?.querySelector('button[data-provider-id=${JSON.stringify(target.selectProviderId)}]')
            if (!(button instanceof HTMLButtonElement)) return false
            button.click()
            return true
          })()`)
          if (selected) break
          await delay(25)
        }
      }
      if (target.triggerProviderSetup) {
        const providerSetupDeadline = Date.now() + 10_000
        let providerSetupTriggered = false
        while (Date.now() < providerSetupDeadline) {
          providerSetupTriggered = await browserWindow.webContents.executeJavaScript(`(() => {
            const dialog = document.querySelector('dialog[open][aria-labelledby="models-title"]')
            const action = [...(dialog?.querySelectorAll('button') ?? [])]
              .find((candidate) => candidate.textContent?.trim() === 'Open Prime Agent')
            if (!(action instanceof HTMLButtonElement) || action.disabled) return false
            action.click()
            return true
          })()`)
          if (providerSetupTriggered) break
          await delay(25)
        }
        invariant(providerSetupTriggered, `${target.name} did not expose the initial provider handoff action`)
      }
      const dialogDeadline = Date.now() + 10_000
      while (Date.now() < dialogDeadline) {
        const ready = await browserWindow.webContents.executeJavaScript(`(() => {
          const dialog = document.querySelector('dialog[open][aria-labelledby="models-title"]')
          const action = ${modelsActionExpression(target, 'dialog')}
          return Boolean(
            dialog &&
            (action instanceof HTMLButtonElement || action instanceof HTMLSelectElement) &&
            !action.disabled &&
            document.body.innerText.includes(${JSON.stringify(target.expectedText)})
          )
        })()`)
        if (ready) break
        await delay(25)
      }
      await delay(300)
      if (
        target.expectModelAction ||
        target.expectOAuthAction ||
        target.expectProviderSetupAction ||
        target.expectShortModelsDialog ||
        target.expectReasoningControl
      ) {
        const shortModelScrollEvidence = await browserWindow.webContents.executeJavaScript(`(() => {
          const dialog = document.querySelector('dialog[open][aria-labelledby="models-title"]')
          const catalog = dialog?.querySelector('.model-catalog')
          const action = ${modelsActionExpression(target, 'dialog')}
          if (
            !(catalog instanceof HTMLElement) ||
            (!(action instanceof HTMLButtonElement) && !(action instanceof HTMLSelectElement)) ||
            action.disabled
          ) {
            return { ready: false }
          }
          const catalogRect = catalog.getBoundingClientRect()
          const actionRect = action.getBoundingClientRect()
          if (actionRect.top < catalogRect.top || actionRect.bottom > catalogRect.bottom) {
            const centeredOffset = ${JSON.stringify(Boolean(target.expectShortModelsDialog))}
              ? actionRect.top - catalogRect.top - Math.max(0, (catalog.clientHeight - actionRect.height) / 2)
              : actionRect.top < catalogRect.top
                ? actionRect.top - catalogRect.top - 12
                : actionRect.bottom - catalogRect.bottom + 12
            const maximumScrollTop = Math.max(0, catalog.scrollHeight - catalog.clientHeight)
            catalog.scrollTop = Math.min(maximumScrollTop, Math.max(0, catalog.scrollTop + centeredOffset))
          }
          return { ready: true }
        })()`)
        invariant(shortModelScrollEvidence.ready, `${target.name} did not expose an enabled model action to its catalog scroller`)
        await delay(75)
      }
    }
    if (target.openRegisteredResidentDialog) {
      // Exercise the compact workbench exactly as a person would: open the
      // mobile sidebar, use the visible saved-workspace action, and stop once
      // the non-executing visual fixture has opened the confirmation dialog.
      browserWindow.setPosition(-10_000, -10_000, false)
      browserWindow.showInactive()
      const sidebarToggleEvidence = await browserWindow.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('button[aria-label="Open sidebar"]')
        const rect = button?.getBoundingClientRect()
        const style = button ? window.getComputedStyle(button) : undefined
        const visible = Boolean(
          button instanceof HTMLButtonElement &&
          !button.disabled &&
          style &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left >= 0 &&
          rect.right <= window.innerWidth &&
          rect.top >= 0 &&
          rect.bottom <= window.innerHeight
        )
        if (button instanceof HTMLButtonElement && visible) button.click()
        return { found: button instanceof HTMLButtonElement, enabled: !button?.disabled, visible }
      })()`)
      invariant(
        sidebarToggleEvidence.visible,
        `${target.name} did not expose the visible Open sidebar control: ${JSON.stringify(sidebarToggleEvidence)}`,
      )
      const sidebarDeadline = Date.now() + 10_000
      while (Date.now() < sidebarDeadline) {
        const open = await browserWindow.webContents.executeJavaScript(
          `document.querySelector('.app-shell')?.getAttribute('data-sidebar-open') === 'true'`,
        )
        if (open) break
        await delay(25)
      }
      await delay(250)
      await browserWindow.webContents.executeJavaScript(`(() => {
        const button = [...(document.querySelector('#project-sidebar')?.querySelectorAll('button') ?? [])]
          .find((candidate) => candidate.getAttribute('aria-label') === 'New resident thread in this workspace')
        if (!(button instanceof HTMLButtonElement)) return false
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        return true
      })()`)
      await delay(75)
      registeredWorkspaceTriggerEvidence = await browserWindow.webContents.executeJavaScript(`(() => {
        const sidebar = document.querySelector('#project-sidebar')
        const catalog = sidebar?.querySelector('.sidebar__scroll')
        const workbench = document.querySelector('.transcript__scroller')
        const button = [...(sidebar?.querySelectorAll('button') ?? [])]
          .find((candidate) => candidate.getAttribute('aria-label') === 'New resident thread in this workspace')
        const helper = sidebar?.querySelector('#registered-resident-action-description')
        const sidebarRect = sidebar?.getBoundingClientRect()
        const catalogRect = catalog?.getBoundingClientRect()
        const workbenchRect = workbench?.getBoundingClientRect()
        const buttonRect = button?.getBoundingClientRect()
        const buttonStyle = button ? window.getComputedStyle(button) : undefined
        const catalogStyle = catalog ? window.getComputedStyle(catalog) : undefined
        const workbenchStyle = workbench ? window.getComputedStyle(workbench) : undefined
        const actionCopy = [button?.textContent?.trim(), helper?.textContent?.trim()].filter(Boolean).join(' ')
        const actionVisible = Boolean(
          button instanceof HTMLButtonElement &&
          !button.disabled &&
          buttonStyle &&
          buttonStyle.display !== 'none' &&
          buttonStyle.visibility !== 'hidden' &&
          buttonRect &&
          catalogRect &&
          buttonRect.width > 0 &&
          buttonRect.height > 0 &&
          buttonRect.left >= Math.max(0, catalogRect.left) - 1 &&
          buttonRect.right <= Math.min(window.innerWidth, catalogRect.right) + 1 &&
          buttonRect.top >= Math.max(0, catalogRect.top) - 1 &&
          buttonRect.bottom <= Math.min(window.innerHeight, catalogRect.bottom) + 1
        )
        const bounded = (rect) => Boolean(
          rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left >= 0 &&
          rect.right <= window.innerWidth &&
          rect.top >= 0 &&
          rect.bottom <= window.innerHeight
        )
        if (button instanceof HTMLButtonElement && actionVisible) button.click()
        return {
          actionVisible,
          actionEnabled: button instanceof HTMLButtonElement && !button.disabled,
          actionText: button?.textContent?.trim(),
          helperText: helper?.textContent?.trim(),
          forbiddenActionCopyPresent: /(?:\\bpath\\b|\\bfolder\\b|picker|handoff|mobile)/i.test(actionCopy),
          sidebarBounded: bounded(sidebarRect),
          catalogBounded: bounded(catalogRect),
          catalogOverflowY: catalogStyle?.overflowY,
          catalogClientHeight: catalog?.clientHeight,
          catalogScrollHeight: catalog?.scrollHeight,
          workbenchBounded: bounded(workbenchRect),
          workbenchOverflowY: workbenchStyle?.overflowY,
          workbenchClientHeight: workbench?.clientHeight,
          workbenchScrollHeight: workbench?.scrollHeight,
          catalogScrollTop: catalog?.scrollTop,
          catalogRect: catalogRect ? {
            left: catalogRect.left,
            right: catalogRect.right,
            top: catalogRect.top,
            bottom: catalogRect.bottom,
          } : undefined,
          actionRect: buttonRect ? {
            left: buttonRect.left,
            right: buttonRect.right,
            top: buttonRect.top,
            bottom: buttonRect.bottom,
          } : undefined,
        }
      })()`)
      invariant(
        registeredWorkspaceTriggerEvidence.actionVisible &&
        registeredWorkspaceTriggerEvidence.actionEnabled &&
        registeredWorkspaceTriggerEvidence.actionText === 'New agent',
        `${target.name} did not expose the saved-workspace New agent action: ${JSON.stringify(registeredWorkspaceTriggerEvidence)}`,
      )
      invariant(
        registeredWorkspaceTriggerEvidence.helperText === 'Uses this saved workspace.' &&
        !registeredWorkspaceTriggerEvidence.forbiddenActionCopyPresent,
        `${target.name} did not preserve the exact path-free saved-workspace helper: ${JSON.stringify(registeredWorkspaceTriggerEvidence)}`,
      )
      invariant(
        registeredWorkspaceTriggerEvidence.sidebarBounded &&
        registeredWorkspaceTriggerEvidence.catalogBounded &&
        ['auto', 'scroll'].includes(registeredWorkspaceTriggerEvidence.catalogOverflowY) &&
        registeredWorkspaceTriggerEvidence.workbenchBounded &&
        ['auto', 'scroll'].includes(registeredWorkspaceTriggerEvidence.workbenchOverflowY),
        `${target.name} did not preserve bounded catalog and workbench scrollers: ${JSON.stringify(registeredWorkspaceTriggerEvidence)}`,
      )
      if (target.expectShortRegisteredResidentDialog) {
        invariant(
          registeredWorkspaceTriggerEvidence.catalogScrollHeight > registeredWorkspaceTriggerEvidence.catalogClientHeight,
          `${target.name} did not exercise real short-height catalog overflow: ${JSON.stringify(registeredWorkspaceTriggerEvidence)}`,
        )
      }
      const dialogDeadline = Date.now() + 10_000
      while (Date.now() < dialogDeadline) {
        const open = await browserWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('dialog[open][aria-labelledby="resident-provision-title"]'))`,
        )
        if (open) break
        await delay(25)
      }
      // Wait past the sheet transition so the real Electron compositor captures
      // the final focused-field and scroll positions without submitting.
      await delay(300)
      await browserWindow.webContents.executeJavaScript(`(() => {
        const dialog = document.querySelector('dialog[open][aria-labelledby="resident-provision-title"]')
        const scroller = dialog?.querySelector('.sheet__scroll')
        const fixedProject = dialog?.querySelector('.form-field__fixed-value')
        const threadTitle = dialog?.querySelector('#resident-thread-title')
        if (!(scroller instanceof HTMLElement) || !fixedProject || !threadTitle) return false
        const scrollerRect = scroller.getBoundingClientRect()
        const fixedRect = fixedProject.getBoundingClientRect()
        const titleRect = threadTitle.getBoundingClientRect()
        const fixedTop = fixedRect.top - scrollerRect.top + scroller.scrollTop
        const titleBottom = titleRect.bottom - scrollerRect.top + scroller.scrollTop
        const minimumScrollTop = Math.max(0, titleBottom - scroller.clientHeight)
        if (minimumScrollTop <= fixedTop) scroller.scrollTop = minimumScrollTop
        return true
      })()`)
      await delay(75)
    }
    if (target.openResidentDialog) {
      // Chromium does not composite top-layer dialogs into capturePage() for
      // a never-shown window. Show it inactive and far outside every normal
      // desktop work area so the modal renders without stealing user focus.
      browserWindow.setPosition(-10_000, -10_000, false)
      browserWindow.showInactive()
      await browserWindow.webContents.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((candidate) => candidate.getAttribute('aria-label') === 'Choose workspace folder')
        if (!(button instanceof HTMLButtonElement)) throw new Error('Resident workspace action was not found')
        button.click()
      })()`)
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const open = await browserWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('dialog[open][aria-labelledby="resident-provision-title"]'))`,
        )
        if (open) break
        await delay(25)
      }
      // Hidden Electron windows still advance dialog enter animations, but a
      // paint can lag the imperative showModal() state. Capture only after the
      // 180ms sheet transition and the following compositor frame.
      await delay(300)
    }
    if (target.openCandidateEvaluationDialog) {
      browserWindow.setPosition(-10_000, -10_000, false)
      browserWindow.showInactive()
      await browserWindow.webContents.executeJavaScript(`(() => {
        const inspectorButton = document.querySelector('button[aria-label="Open inspector"]')
        if (inspectorButton instanceof HTMLButtonElement) inspectorButton.click()
        const evidenceTab = document.querySelector('#inspector-tab-evidence')
        if (!(evidenceTab instanceof HTMLButtonElement)) throw new Error('Evidence inspector tab was not found')
        evidenceTab.click()
      })()`)
      const actionDeadline = Date.now() + 10_000
      while (Date.now() < actionDeadline) {
        const actionReady = await browserWindow.webContents.executeJavaScript(`(() => {
          const button = [...document.querySelectorAll('button')]
            .find((candidate) => candidate.textContent?.trim() === 'Evaluate candidate')
          return button instanceof HTMLButtonElement && !button.disabled
        })()`)
        if (actionReady) break
        await delay(25)
      }
      await browserWindow.webContents.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((candidate) => candidate.textContent?.trim() === 'Evaluate candidate')
        if (!(button instanceof HTMLButtonElement) || button.disabled) throw new Error('Candidate evaluation action was not ready')
        button.click()
      })()`)
      const dialogDeadline = Date.now() + 10_000
      while (Date.now() < dialogDeadline) {
        const open = await browserWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('dialog[open][aria-labelledby="candidate-evaluation-dialog-title"]'))`,
        )
        if (open) break
        await delay(25)
      }
      await delay(300)
    }
    const selector = target.expectHud
      ? `.hud-${target.expectHud}`
      : target.openModelsDialog
        ? 'dialog[open][aria-labelledby="models-title"] .models-sheet__surface'
      : target.visualState === 'resident-start' || target.visualState === 'resident-recovery'
        ? '.empty-workbench'
        : '.app-shell'
    const layout = await browserWindow.webContents.executeJavaScript(`(() => {
      const surface = document.querySelector(${JSON.stringify(selector)})
      const overflowers = [...document.querySelectorAll('body *')].flatMap((element) => {
        if (!(element instanceof HTMLElement) || element.offsetParent === null || element.classList.contains('sr-only')) return []
        const rect = element.getBoundingClientRect()
        if (rect.right <= window.innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1) return []
        return [{
          element: element.tagName.toLowerCase(),
          className: typeof element.className === 'string' ? element.className.slice(0, 96) : '',
          id: element.id,
          role: element.getAttribute('role'),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflow: Math.max(Math.round(rect.right - window.innerWidth), element.scrollWidth - element.clientWidth),
        }]
      }).sort((left, right) => right.overflow - left.overflow).slice(0, 12)
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        surfaceClientWidth: surface?.clientWidth,
        surfaceScrollWidth: surface?.scrollWidth,
        overflowers,
      }
    })()`)
    invariant(layout.innerWidth === target.width, `${target.name} rendered at ${layout.innerWidth}px instead of ${target.width}px`)
    invariant(
      layout.documentScrollWidth <= layout.documentClientWidth && layout.bodyScrollWidth <= layout.bodyClientWidth,
      `${target.name} has horizontal page overflow: ${JSON.stringify(layout)}`,
    )
    invariant(
      layout.surfaceScrollWidth <= layout.surfaceClientWidth,
      `${target.name} surface overflows horizontally: ${JSON.stringify(layout)}`,
    )
    const stateEvidence = await browserWindow.webContents.executeJavaScript(`(() => {
      const status = document.querySelector('.composer__connection')
      const statusStyle = status ? window.getComputedStyle(status) : undefined
      const sessionStatus = document.querySelector('.session-continuity')
      const sessionStatusRect = sessionStatus?.getBoundingClientRect()
      const residentDialog = document.querySelector('dialog[aria-labelledby="resident-provision-title"]')
      const residentDialogStyle = residentDialog ? window.getComputedStyle(residentDialog) : undefined
      const residentDialogRect = residentDialog?.getBoundingClientRect()
      const residentDialogScroll = residentDialog?.querySelector('.sheet__scroll')
      const residentDialogScrollStyle = residentDialogScroll ? window.getComputedStyle(residentDialogScroll) : undefined
      const residentDialogScrollRect = residentDialogScroll?.getBoundingClientRect()
      const residentDialogFooter = residentDialog?.querySelector('.sheet__footer')
      const residentDialogFooterRect = residentDialogFooter?.getBoundingClientRect()
      const residentDialogForm = residentDialog?.querySelector('form')
      const residentDialogInputs = [...(residentDialog?.querySelectorAll('input:not([type="hidden"])') ?? [])]
      const residentThreadTitle = residentDialog?.querySelector('#resident-thread-title')
      const residentThreadTitleRect = residentThreadTitle?.getBoundingClientRect()
      const residentFixedProject = residentDialog?.querySelector('.resident-provision__workspace strong')
      const residentFixedProjectRect = residentFixedProject?.getBoundingClientRect()
      const residentProvisionAction = [...(residentDialog?.querySelectorAll('.sheet__footer button') ?? [])]
        .find((candidate) => candidate.textContent?.trim() === 'Start agent')
      const residentProvisionActionRect = residentProvisionAction?.getBoundingClientRect()
      const residentDialogError = residentDialog?.querySelector('#resident-provision-error')
      const residentDialogDescription = residentDialog?.querySelector('#resident-provision-description')
      const residentPrivacy = residentDialog?.querySelector('.resident-provision__workspace div > span')
      const residentSavedProjectLabel = residentDialog?.querySelector('.resident-provision__workspace small')
      const residentThreadTitleLabel = residentDialog?.querySelector('label[for="resident-thread-title"]')
      const backgroundCatalog = document.querySelector('.sidebar__scroll')
      const backgroundWorkbench = document.querySelector('.transcript__scroller')
      const backgroundCatalogStyle = backgroundCatalog ? window.getComputedStyle(backgroundCatalog) : undefined
      const backgroundWorkbenchStyle = backgroundWorkbench ? window.getComputedStyle(backgroundWorkbench) : undefined
      const relevantRegisteredCopy = [
        document.querySelector('.sidebar__registered-resident')?.textContent,
        residentDialog?.textContent,
      ].filter(Boolean).join(' ')
      const visibleWithin = (rect, containerRect) => Boolean(
        rect &&
        containerRect &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= Math.max(0, containerRect.left) &&
        rect.right <= Math.min(window.innerWidth, containerRect.right) &&
        rect.top >= Math.max(0, containerRect.top) &&
        rect.bottom <= Math.min(window.innerHeight, containerRect.bottom)
      )
      const candidateEvaluationDialog = document.querySelector('dialog[aria-labelledby="candidate-evaluation-dialog-title"]')
      const candidateEvaluationDialogScroll = candidateEvaluationDialog?.querySelector('.sheet__scroll')
      const candidateEvaluationDialogScrollStyle = candidateEvaluationDialogScroll ? window.getComputedStyle(candidateEvaluationDialogScroll) : undefined
      const candidateEvaluationDialogFooterRect = candidateEvaluationDialog?.querySelector('.sheet__footer')?.getBoundingClientRect()
      const modelsDialog = document.querySelector('dialog[aria-labelledby="models-title"]')
      const modelsSurface = modelsDialog?.querySelector('.models-sheet__surface')
      const modelCatalog = modelsDialog?.querySelector('.model-catalog')
      const modelCatalogStyle = modelCatalog ? window.getComputedStyle(modelCatalog) : undefined
      const modelCatalogRect = modelCatalog?.getBoundingClientRect()
      const modelAction = ${modelsActionExpression(target, 'modelsDialog')}
      const modelActionRect = modelAction?.getBoundingClientRect()
      const providerSetupOpenAction = [...(modelsDialog?.querySelectorAll('button') ?? [])]
        .find((candidate) => candidate.textContent?.trim() === 'Open Prime Agent' || candidate.textContent?.trim() === 'Try again')
      const providerSetupFeedback = modelsDialog?.querySelector('.provider-setup-feedback:not(.sr-only)')
      const reasoningControl = modelsDialog?.querySelector('.reasoning-control')
      const reasoningControlRect = reasoningControl?.getBoundingClientRect()
      const reasoningLabel = modelsDialog?.querySelector('label[for="resident-thinking-level"]')
      const reasoningLabelRect = reasoningLabel?.getBoundingClientRect()
      const reasoningStatus = modelsDialog?.querySelector('#resident-thinking-level-status')
      const reasoningStatusRect = reasoningStatus?.getBoundingClientRect()
      const modelActionVisible = Boolean(
        modelActionRect &&
        modelCatalogRect &&
        modelActionRect.width > 0 &&
        modelActionRect.height > 0 &&
        modelActionRect.left >= Math.max(0, modelCatalogRect.left) &&
        modelActionRect.right <= Math.min(window.innerWidth, modelCatalogRect.right) &&
        modelActionRect.top >= Math.max(0, modelCatalogRect.top) &&
        modelActionRect.bottom <= Math.min(window.innerHeight, modelCatalogRect.bottom)
      )
      const emptyMain = document.querySelector('.empty-workbench__main')
      const emptyMainStyle = emptyMain ? window.getComputedStyle(emptyMain) : undefined
      const hudSurface = document.querySelector(${JSON.stringify(target.expectHud ? `.hud-${target.expectHud}` : '.hud-never')})
      const bodyStyle = window.getComputedStyle(document.body)
      const rootStyle = window.getComputedStyle(document.documentElement)
      const topbarLeading = document.querySelector('.topbar__leading')
      const topbarThread = document.querySelector('.topbar__thread')
      const topbarControls = document.querySelector('.topbar__controls')
      const topbarTitle = document.querySelector('.topbar__thread-copy h1')
      const topbarBrand = document.querySelector('.topbar__brand-name')
      const topbarSidebarControl = topbarLeading?.querySelector('.topbar__sidebar-control')
      const topbarMark = topbarLeading?.querySelector('.brand-mark')
      const topbarLeadingRect = topbarLeading?.getBoundingClientRect()
      const topbarThreadRect = topbarThread?.getBoundingClientRect()
      const topbarControlsRect = topbarControls?.getBoundingClientRect()
      const topbarTitleRect = topbarTitle?.getBoundingClientRect()
      const topbarSidebarControlRect = topbarSidebarControl?.getBoundingClientRect()
      const topbarMarkRect = topbarMark?.getBoundingClientRect()
      const topbarBrandStyle = topbarBrand ? window.getComputedStyle(topbarBrand) : undefined
      const taskStarters = document.querySelector('.task-starters')
      const taskStartersStyle = taskStarters ? window.getComputedStyle(taskStarters) : undefined
      const taskStarterButtons = [...(taskStarters?.querySelectorAll('.task-starters__item') ?? [])]
      const taskStarterRects = taskStarterButtons.map((button) => button.getBoundingClientRect())
      const taskStartersRect = taskStarters?.getBoundingClientRect()
      const endedEmpty = document.querySelector('.ended-thread-empty')
      const endedEmptyHeading = endedEmpty?.querySelector('h2')
      const endedEmptyAction = endedEmpty?.querySelector('button')
      const endedEmptyRect = endedEmpty?.getBoundingClientRect()
      const responsiveInspector = document.querySelector('.inspector')
      const responsiveInspectorRect = responsiveInspector?.getBoundingClientRect()
      const responsiveInspectorStyle = responsiveInspector ? window.getComputedStyle(responsiveInspector) : undefined
      const outcomeReviewPanelRect = document.querySelector('#inspector-panel-review')?.getBoundingClientRect()
      const outcomeBranchRows = [...document.querySelectorAll('.outcome-review__row--branch')]
      const outcomeBranchEvidence = outcomeBranchRows.map((row) => ({
        title: row.querySelector('.outcome-review__row-title strong')?.textContent?.trim() ?? '',
        parentLabel: row.querySelector('.outcome-review__row-parent')?.textContent?.trim() ?? '',
        depth: row.getAttribute('data-branch-depth'),
        parent: row.getAttribute('data-branch-parent'),
        rect: row.getBoundingClientRect().toJSON(),
      }))
      const extensionQuestion = document.querySelector('.prime-interaction')
      const extensionQuestionRect = extensionQuestion?.getBoundingClientRect()
      const extensionConfirm = [...(extensionQuestion?.querySelectorAll('button') ?? [])]
        .find((candidate) => candidate.textContent?.trim() === 'Confirm')
      const appShell = document.querySelector('.app-shell')
      const composerWrap = document.querySelector('.composer-wrap')
      const composer = composerWrap?.querySelector('.composer')
      const composerActions = composer?.querySelector('.composer__actions')
      const composerSecondaryActions = composer?.querySelector('.composer__secondary-actions')
      const composerPrimaryActions = composer?.querySelector('.composer__primary-actions')
      const composerPrimaryButton = composerPrimaryActions?.querySelector('.button')
      const composerWrapRect = composerWrap?.getBoundingClientRect()
      const composerRect = composer?.getBoundingClientRect()
      const composerPrimaryButtonRect = composerPrimaryButton?.getBoundingClientRect()
      const composerActionsStyle = composerActions ? window.getComputedStyle(composerActions) : undefined
      return {
        workbenchShellPresent: Boolean(appShell),
        expectedTextPresent: document.body.innerText.includes(${JSON.stringify(target.expectedText)}),
        compactComposer: Boolean(document.querySelector('.composer--compact')),
        emptyComposerAbsent: ${Boolean(target.expectOutcomeBranchHierarchy)}
          ? !document.querySelector('.composer')
          : undefined,
        composerStatusVisible: Boolean(status && statusStyle && statusStyle.display !== 'none' && status.getBoundingClientRect().height > 0),
        taskStatusVisible: Boolean(
          (status && statusStyle && statusStyle.display !== 'none' && status.getBoundingClientRect().height > 0) ||
          (sessionStatusRect && sessionStatusRect.width > 0 && sessionStatusRect.height > 0 &&
            sessionStatus?.textContent?.includes(${JSON.stringify(target.expectedText)}))
        ),
        extensionQuestionVisible: Boolean(
          extensionQuestionRect &&
          extensionQuestionRect.width > 0 &&
          extensionQuestionRect.height > 0 &&
          extensionQuestionRect.left >= 0 &&
          extensionQuestionRect.right <= window.innerWidth
        ),
        extensionComposerSuppressed: !document.querySelector('.composer'),
        extensionConfirmEnabled: extensionConfirm instanceof HTMLButtonElement && !extensionConfirm.disabled,
        residentDialogOpen: Boolean(document.querySelector('dialog[open][aria-labelledby="resident-provision-title"]')),
        residentDialogModal: Boolean(residentDialog?.matches(':modal')),
        residentDialogDisplay: residentDialogStyle?.display,
        residentDialogVisibility: residentDialogStyle?.visibility,
        residentDialogRect: residentDialogRect ? {
          x: residentDialogRect.x,
          y: residentDialogRect.y,
          width: residentDialogRect.width,
          height: residentDialogRect.height,
        } : undefined,
        residentDialogText: residentDialog?.textContent?.trim(),
        registeredResidentDialogExactCopy: Boolean(
          residentDialogDescription?.textContent?.trim() ===
            'Name the task. Prime Agent runs it here.' &&
          residentSavedProjectLabel?.textContent?.trim() === 'Runs in' &&
          residentThreadTitleLabel?.textContent?.trim() === 'Task name' &&
          residentPrivacy?.textContent?.trim() ===
            'Access stays on the verified host'
        ),
        registeredResidentForbiddenCopyPresent: /(?:\\bpath\\b|\\bfolder\\b|picker|handoff|mobile)/i.test(relevantRegisteredCopy),
        residentFixedProjectText: residentFixedProject?.textContent?.trim(),
        residentFixedProjectVisible: visibleWithin(residentFixedProjectRect, residentDialogScrollRect),
        residentThreadInputCount: residentDialogInputs.length,
        residentThreadTitleOnlyInput: Boolean(
          residentDialogInputs.length === 1 &&
          residentThreadTitle instanceof HTMLInputElement &&
          residentDialogInputs[0] === residentThreadTitle &&
          !residentThreadTitle.disabled
        ),
        residentThreadTitleVisible: visibleWithin(residentThreadTitleRect, residentDialogScrollRect),
        residentProvisionActionText: residentProvisionAction?.textContent?.trim(),
        residentProvisionActionEnabled: Boolean(
          residentProvisionAction instanceof HTMLButtonElement && !residentProvisionAction.disabled
        ),
        residentProvisionActionVisible: visibleWithin(residentProvisionActionRect, residentDialogFooterRect),
        residentProvisionUnsubmitted: Boolean(
          residentDialogForm?.getAttribute('aria-busy') === 'false' &&
          !residentDialogError?.textContent?.trim() &&
          residentProvisionAction instanceof HTMLButtonElement &&
          !residentProvisionAction.disabled
        ),
        residentDialogScrollBounded: visibleWithin(residentDialogScrollRect, residentDialogRect),
        residentDialogScrollOverflowY: residentDialogScrollStyle?.overflowY,
        residentDialogScrollClientHeight: residentDialogScroll?.clientHeight,
        residentDialogScrollHeight: residentDialogScroll?.scrollHeight,
        residentDialogScrollTop: residentDialogScroll?.scrollTop,
        residentDialogOuterScrollTop: residentDialog?.scrollTop,
        residentDialogFormScrollTop: residentDialogForm?.scrollTop,
        residentBackgroundCatalogLocked: backgroundCatalogStyle?.overflowY === 'hidden',
        residentBackgroundWorkbenchLocked: backgroundWorkbenchStyle?.overflowY === 'hidden',
        residentDialogContentReachable: Boolean(
          residentDialogScroll &&
          residentDialogScrollStyle &&
          (residentDialogScrollStyle.overflowY === 'auto' || residentDialogScrollStyle.overflowY === 'scroll') &&
          residentDialogScroll.clientHeight >= 64 &&
          residentDialogFooterRect &&
          residentDialogFooterRect.height > 0 &&
          residentDialogFooterRect.bottom <= window.innerHeight
        ),
        candidateEvaluationDialogOpen: Boolean(document.querySelector('dialog[open][aria-labelledby="candidate-evaluation-dialog-title"]')),
        candidateEvaluationDialogContentReachable: Boolean(
          candidateEvaluationDialogScroll &&
          candidateEvaluationDialogScrollStyle &&
          (candidateEvaluationDialogScrollStyle.overflowY === 'auto' || candidateEvaluationDialogScrollStyle.overflowY === 'scroll') &&
          candidateEvaluationDialogScroll.clientHeight >= 48 &&
          candidateEvaluationDialogFooterRect &&
          candidateEvaluationDialogFooterRect.height > 0 &&
          candidateEvaluationDialogFooterRect.bottom <= window.innerHeight
        ),
        modelsDialogOpen: Boolean(modelsDialog?.matches('[open]:modal')),
        modelSelectionActionEnabled: Boolean(
          (modelAction instanceof HTMLButtonElement || modelAction instanceof HTMLSelectElement) &&
          !modelAction.disabled
        ),
        modelSelectionActionVisible: modelActionVisible,
        modelSelectionUnchanged: Boolean(
          (modelAction instanceof HTMLButtonElement || modelAction instanceof HTMLSelectElement) &&
          !modelAction.disabled &&
          !modelsDialog?.querySelector('.model-selection-feedback__message:not(.sr-only)')
        ),
        providerSetupActionText: modelAction?.textContent?.trim(),
        providerSetupActionPrimary: Boolean(modelAction?.classList.contains('button--primary')),
        providerSetupRepeatSuppressed: !providerSetupOpenAction,
        providerSetupFeedbackText: providerSetupFeedback?.textContent?.trim(),
        providerSetupFeedbackRole: providerSetupFeedback?.getAttribute('role'),
        providerSetupLayoutEvidenceOnly: ${JSON.stringify(Boolean(target.evidenceBoundary))},
        reasoningControlOptions: modelAction instanceof HTMLSelectElement
          ? [...modelAction.options].map((option) => option.value)
          : [],
        reasoningControlRect: reasoningControlRect ? {
          left: reasoningControlRect.left,
          right: reasoningControlRect.right,
          top: reasoningControlRect.top,
          bottom: reasoningControlRect.bottom,
        } : undefined,
        reasoningLabelRect: reasoningLabelRect ? {
          left: reasoningLabelRect.left,
          right: reasoningLabelRect.right,
          top: reasoningLabelRect.top,
          bottom: reasoningLabelRect.bottom,
        } : undefined,
        reasoningStatusRect: reasoningStatusRect ? {
          left: reasoningStatusRect.left,
          right: reasoningStatusRect.right,
          top: reasoningStatusRect.top,
          bottom: reasoningStatusRect.bottom,
        } : undefined,
        modelCatalogScrollable: Boolean(
          modelCatalog &&
          modelCatalogStyle &&
          (modelCatalogStyle.overflowY === 'auto' || modelCatalogStyle.overflowY === 'scroll') &&
          modelCatalog.clientHeight > 0 &&
          modelCatalog.scrollHeight > modelCatalog.clientHeight
        ),
        modelCatalogClientHeight: modelCatalog?.clientHeight,
        modelCatalogScrollHeight: modelCatalog?.scrollHeight,
        modelCatalogScrollTop: modelCatalog?.scrollTop,
        modelsDialogScrollTop: modelsDialog?.scrollTop,
        modelsSurfaceScrollTop: modelsSurface?.scrollTop,
        residentPickerBusy: document.querySelector('.empty-workbench__actions .button--primary')?.getAttribute('aria-busy'),
        emptyMainScrollable: Boolean(
          emptyMain &&
          emptyMainStyle &&
          (emptyMainStyle.overflowY === 'auto' || emptyMainStyle.overflowY === 'scroll') &&
          emptyMain.scrollHeight > emptyMain.clientHeight
        ),
        emptyMainClientHeight: emptyMain?.clientHeight,
        emptyMainScrollHeight: emptyMain?.scrollHeight,
        emptyMainOverflowY: emptyMainStyle?.overflowY,
        hudSurfaceVisible: Boolean(hudSurface && hudSurface.getBoundingClientRect().width > 0 && hudSurface.getBoundingClientRect().height > 0),
        hudMode: document.querySelector('.hud-buddy') ? 'buddy' : document.querySelector('.hud-expanded') ? 'expanded' : undefined,
        hudStatusVisible: Boolean(document.querySelector('.hud-status')),
        hudStatusCopy: document.querySelector('.hud-status')?.textContent?.trim().replace(/\\s+/g, ' '),
        hudHostTransparent: bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)' && rootStyle.backgroundColor === 'rgba(0, 0, 0, 0)',
        responsiveTopbarBounded: Boolean(
          topbarLeadingRect &&
          topbarThreadRect &&
          topbarControlsRect &&
          topbarTitleRect &&
          topbarLeadingRect.right <= topbarThreadRect.left + 1 &&
          topbarThreadRect.right <= topbarControlsRect.left + 1 &&
          topbarTitleRect.width > 0 &&
          topbarTitleRect.left >= topbarThreadRect.left &&
          topbarTitleRect.right <= topbarThreadRect.right + 1 &&
          topbarBrandStyle?.display === 'none'
        ),
        topbarLeadingPresent: Boolean(topbarLeading),
        topbarLeadingBounded: Boolean(
          topbarLeading &&
          topbarLeading.clientWidth > 0 &&
          topbarLeading.scrollWidth <= topbarLeading.clientWidth
        ),
        topbarLeadingClientWidth: topbarLeading?.clientWidth,
        topbarLeadingScrollWidth: topbarLeading?.scrollWidth,
        topbarLeadingEssentialsVisible: Boolean(
          topbarLeadingRect &&
          topbarSidebarControlRect &&
          topbarMarkRect &&
          topbarSidebarControlRect.width > 0 &&
          topbarMarkRect.width > 0 &&
          topbarSidebarControlRect.left >= topbarLeadingRect.left &&
          topbarSidebarControlRect.right <= topbarLeadingRect.right &&
          topbarMarkRect.left >= topbarLeadingRect.left &&
          topbarMarkRect.right <= topbarLeadingRect.right
        ),
        topbarLeadingControlVisible: Boolean(
          topbarLeadingRect &&
          topbarSidebarControlRect &&
          topbarSidebarControlRect.width > 0 &&
          topbarSidebarControlRect.left >= topbarLeadingRect.left &&
          topbarSidebarControlRect.right <= topbarLeadingRect.right
        ),
        topbarLeadingMarkVisible: Boolean(
          topbarLeadingRect &&
          topbarMarkRect &&
          topbarMarkRect.width > 0 &&
          topbarMarkRect.left >= topbarLeadingRect.left &&
          topbarMarkRect.right <= topbarLeadingRect.right
        ),
        boundedTaskStarters: Boolean(
          taskStarters &&
          taskStartersRect &&
          taskStartersStyle?.display === 'grid' &&
          taskStartersStyle.gridTemplateColumns.split(' ').length === 2 &&
          taskStarters.scrollWidth <= taskStarters.clientWidth &&
          taskStarterButtons.length === 4 &&
          taskStarterRects.every((rect) =>
            rect.width > 0 &&
            rect.height >= 44 &&
            rect.left >= Math.max(0, taskStartersRect.left) &&
            rect.right <= Math.min(window.innerWidth, taskStartersRect.right) &&
            rect.top >= taskStartersRect.top &&
            rect.bottom <= taskStartersRect.bottom
          )
        ),
        endedEmptyResolved: Boolean(
          endedEmptyRect &&
          endedEmptyHeading?.textContent?.trim() === 'Session ended' &&
          endedEmptyAction?.textContent?.trim() === 'Start another task' &&
          endedEmptyRect.left >= 0 &&
          endedEmptyRect.right <= window.innerWidth &&
          !document.querySelector('.composer-wrap')
        ),
        launchpadContinuitySuppressed: Boolean(
          document.querySelector('.agent-launchpad') &&
          !document.querySelector('.session-continuity')
        ),
        responsiveDrawerBounded: Boolean(
          responsiveInspectorRect &&
          document.querySelector('.app-shell')?.getAttribute('data-inspector-open') === 'true' &&
          responsiveInspectorStyle?.visibility === 'visible' &&
          responsiveInspectorRect.width > 0 &&
          responsiveInspectorRect.left >= 0 &&
          responsiveInspectorRect.right <= window.innerWidth &&
          responsiveInspector?.textContent?.includes('Review') &&
          responsiveInspector.textContent.includes('Outcome')
        ),
        dockedComposerBounded: Boolean(
          appShell?.getAttribute('data-inspector-open') === 'true' &&
          composerWrapRect &&
          composerRect &&
          composerPrimaryButtonRect &&
          composerWrapRect.width > 0 &&
          composerWrapRect.width <= 44 * 16 &&
          composerActionsStyle?.flexWrap === 'wrap' &&
          composer.scrollWidth <= composer.clientWidth &&
          composerActions && composerActions.scrollWidth <= composerActions.clientWidth &&
          composerSecondaryActions && composerSecondaryActions.scrollWidth <= composerSecondaryActions.clientWidth &&
          composerPrimaryActions && composerPrimaryActions.scrollWidth <= composerPrimaryActions.clientWidth &&
          composerPrimaryButtonRect.left >= composerRect.left &&
          composerPrimaryButtonRect.right <= composerRect.right
        ),
        outcomeBranchEvidence,
        outcomeBranchHierarchyBounded: Boolean(
          responsiveInspectorRect &&
          outcomeReviewPanelRect &&
          !document.querySelector('.composer') &&
          outcomeBranchEvidence.length === 3 &&
          outcomeBranchEvidence[0]?.title === 'Outcome lead' &&
          outcomeBranchEvidence[1]?.title === 'Interface branch' &&
          outcomeBranchEvidence[1]?.parentLabel === 'via Outcome lead' &&
          outcomeBranchEvidence[1]?.depth === '1' &&
          outcomeBranchEvidence[1]?.parent === 'agent-outcome-lead' &&
          outcomeBranchEvidence[2]?.title === 'Responsive proof' &&
          outcomeBranchEvidence[2]?.parentLabel === 'via Interface branch' &&
          outcomeBranchEvidence[2]?.depth === '2' &&
          outcomeBranchEvidence[2]?.parent === 'agent-outcome-interface' &&
          outcomeBranchEvidence.every(({ rect }) =>
            rect.left >= responsiveInspectorRect.left &&
            rect.right <= responsiveInspectorRect.right &&
            rect.top >= outcomeReviewPanelRect.top &&
            rect.bottom <= Math.min(outcomeReviewPanelRect.bottom, window.innerHeight)
          )
        ),
      }
    })()`)
    if (registeredWorkspaceTriggerEvidence) {
      stateEvidence.registeredWorkspaceTriggerEvidence = registeredWorkspaceTriggerEvidence
    }
    invariant(
      stateEvidence.expectedTextPresent,
      `${target.name} did not render its expected resident-state copy: ${JSON.stringify(stateEvidence)}`,
    )
    if (target.expectStatusVisible || target.expectCompactStatus) {
      invariant(stateEvidence.taskStatusVisible, `${target.name} hid its resident-state copy`)
    }
    if (target.expectCompactStatus) {
      invariant(stateEvidence.compactComposer, `${target.name} did not render the compact resident composer`)
    }
    if (target.expectCompactComposer) {
      invariant(stateEvidence.compactComposer, `${target.name} did not render the compact resident composer`)
    }
    if (target.expectStatusHidden) {
      invariant(!stateEvidence.composerStatusVisible, `${target.name} duplicated its resident-state copy`)
    }
    if (target.expectExtensionQuestion) {
      invariant(
        stateEvidence.extensionQuestionVisible &&
        stateEvidence.extensionComposerSuppressed &&
        stateEvidence.extensionConfirmEnabled,
        `${target.name} did not keep the Prime Agent question singular and actionable: ${JSON.stringify(stateEvidence)}`,
      )
    }
    if (target.openResidentDialog) {
      invariant(stateEvidence.residentDialogOpen, `${target.name} did not open the resident setup dialog`)
    }
    if (target.openRegisteredResidentDialog) {
      invariant(
        stateEvidence.residentDialogOpen &&
        stateEvidence.residentDialogModal &&
        stateEvidence.registeredResidentDialogExactCopy &&
        !stateEvidence.registeredResidentForbiddenCopyPresent,
        `${target.name} did not preserve the exact path-free registered-workspace dialog: ${JSON.stringify(stateEvidence)}`,
      )
      invariant(
        stateEvidence.residentFixedProjectText === target.expectedRegisteredProject &&
        stateEvidence.residentFixedProjectVisible &&
        stateEvidence.residentThreadTitleOnlyInput &&
        stateEvidence.residentThreadTitleVisible,
        `${target.name} did not keep the fixed project and sole thread-title field visible: ${JSON.stringify(stateEvidence)}`,
      )
      invariant(
        stateEvidence.residentProvisionActionText === 'Start agent' &&
        stateEvidence.residentProvisionActionEnabled &&
        stateEvidence.residentProvisionActionVisible &&
        stateEvidence.residentProvisionUnsubmitted,
        `${target.name} hid, disabled, or invoked the registered-workspace footer action: ${JSON.stringify(stateEvidence)}`,
      )
      invariant(
        stateEvidence.residentDialogContentReachable &&
        stateEvidence.residentDialogScrollBounded &&
        ['auto', 'scroll'].includes(stateEvidence.residentDialogScrollOverflowY) &&
        stateEvidence.residentDialogOuterScrollTop === 0 &&
        stateEvidence.residentDialogFormScrollTop === 0 &&
        stateEvidence.residentBackgroundCatalogLocked &&
        stateEvidence.residentBackgroundWorkbenchLocked,
        `${target.name} did not keep dialog scrolling bounded and background scrolling locked: ${JSON.stringify(stateEvidence)}`,
      )
    }
    if (target.expectShortRegisteredResidentDialog) {
      invariant(
        stateEvidence.residentDialogScrollHeight > stateEvidence.residentDialogScrollClientHeight,
        `${target.name} did not exercise real short-height dialog overflow: ${JSON.stringify(stateEvidence)}`,
      )
    }
    if (target.expectShortResidentDialog) {
      invariant(stateEvidence.residentDialogContentReachable, `${target.name} did not keep the resident form and actions reachable`)
    }
    if (target.openCandidateEvaluationDialog) {
      invariant(stateEvidence.candidateEvaluationDialogOpen, `${target.name} did not open the candidate evaluation review`)
    }
    if (target.expectShortCandidateEvaluationDialog) {
      invariant(stateEvidence.candidateEvaluationDialogContentReachable, `${target.name} did not keep the candidate evaluation review and actions reachable`)
    }
    if (target.openModelsDialog) {
      invariant(stateEvidence.modelsDialogOpen, `${target.name} did not open Models & accounts as a modal dialog`)
      invariant(stateEvidence.modelSelectionActionEnabled, `${target.name} did not expose its expected enabled action`)
      invariant(stateEvidence.modelSelectionActionVisible, `${target.name} hid its expected action: ${JSON.stringify(stateEvidence)}`)
      if (!target.triggerProviderSetup) {
        invariant(stateEvidence.modelSelectionUnchanged, `${target.name} invoked or locked its non-executing action`)
      }
    }
    if (target.expectProviderSetupState) {
      invariant(
        stateEvidence.providerSetupActionText === target.expectProviderSetupAction &&
        stateEvidence.providerSetupLayoutEvidenceOnly,
        `${target.name} did not preserve its QA-only provider handoff action: ${JSON.stringify(stateEvidence)}`,
      )
      if (target.expectProviderSetupState === 'unopened') {
        invariant(
          !stateEvidence.providerSetupRepeatSuppressed && !stateEvidence.providerSetupFeedbackText,
          `${target.name} did not preserve the unopened provider handoff state: ${JSON.stringify(stateEvidence)}`,
        )
      } else {
        invariant(
          stateEvidence.providerSetupActionPrimary &&
          stateEvidence.providerSetupRepeatSuppressed &&
          stateEvidence.providerSetupFeedbackRole === 'status' &&
          stateEvidence.providerSetupFeedbackText === target.expectedText,
          `${target.name} did not suppress repeat provider handoff after ${target.expectProviderSetupState}: ${JSON.stringify(stateEvidence)}`,
        )
      }
    }
    if (target.expectReasoningControl) {
      invariant(
        JSON.stringify(stateEvidence.reasoningControlOptions) === JSON.stringify(['off', 'low', 'medium', 'high', 'max']),
        `${target.name} did not render only the session-reported reasoning levels: ${JSON.stringify(stateEvidence)}`,
      )
      invariant(
        stateEvidence.reasoningControlRect &&
        stateEvidence.reasoningLabelRect &&
        stateEvidence.reasoningStatusRect &&
        stateEvidence.reasoningControlRect.left >= 0 &&
        stateEvidence.reasoningControlRect.right <= target.width &&
        stateEvidence.reasoningControlRect.top >= 0 &&
        stateEvidence.reasoningControlRect.bottom <= target.height &&
        stateEvidence.reasoningLabelRect.top >= stateEvidence.reasoningControlRect.top &&
        stateEvidence.reasoningLabelRect.bottom <= stateEvidence.reasoningControlRect.bottom &&
        stateEvidence.reasoningStatusRect.top >= stateEvidence.reasoningControlRect.top &&
        stateEvidence.reasoningStatusRect.bottom <= stateEvidence.reasoningControlRect.bottom,
        `${target.name} did not keep the complete reasoning control visible: ${JSON.stringify(stateEvidence)}`,
      )
    }
    if (target.expectShortModelsDialog) {
      invariant(
        stateEvidence.modelCatalogScrollable,
        `${target.name} did not preserve a real model-catalog scroll container: ${JSON.stringify(stateEvidence)}`,
      )
      invariant(
        stateEvidence.modelsDialogScrollTop === 0 && stateEvidence.modelsSurfaceScrollTop === 0,
        `${target.name} scrolled outside the model catalog: ${JSON.stringify(stateEvidence)}`,
      )
    }
    if (target.expectScrollableEmpty) {
      invariant(
        stateEvidence.emptyMainScrollable,
        `${target.name} did not preserve vertical access to resident recovery controls: ${JSON.stringify(stateEvidence)}`,
      )
    }
    if (target.expectHud) {
      invariant(stateEvidence.hudSurfaceVisible, `${target.name} did not paint its HUD surface`)
      invariant(stateEvidence.hudMode === target.expectHud, `${target.name} rendered the wrong HUD mode`)
      invariant(stateEvidence.hudStatusVisible, `${target.name} hid its redundant HUD status`)
      invariant(stateEvidence.hudHostTransparent, `${target.name} did not preserve a transparent native host layer`)
    }
    if (target.expectResponsiveTopbar) {
      invariant(stateEvidence.responsiveTopbarBounded, `${target.name} allowed responsive topbar regions to overlap: ${JSON.stringify(stateEvidence)}`)
    }
    if (target.expectBoundedTaskStarters) {
      invariant(stateEvidence.boundedTaskStarters, `${target.name} did not keep all four task starters visible in a bounded two-column grid`)
    }
    if (target.expectEndedEmpty) {
      invariant(stateEvidence.endedEmptyResolved, `${target.name} did not render the resolved ended-session empty state`)
    }
    if (target.expectLaunchpadContinuitySuppressed) {
      invariant(stateEvidence.launchpadContinuitySuppressed, `${target.name} duplicated neutral launchpad readiness below the transcript`)
    }
    if (target.expectResponsiveDrawer) {
      invariant(stateEvidence.responsiveDrawerBounded, `${target.name} did not keep the responsive inspector drawer within the viewport`)
    }
    if (!target.expectHud && stateEvidence.workbenchShellPresent) {
      invariant(
        stateEvidence.topbarLeadingPresent &&
        stateEvidence.topbarLeadingBounded &&
        stateEvidence.topbarLeadingControlVisible &&
        (target.width < 800 || stateEvidence.topbarLeadingMarkVisible),
        `${target.name} overflowed the desktop titlebar leading region: ${JSON.stringify({
          clientWidth: stateEvidence.topbarLeadingClientWidth,
          scrollWidth: stateEvidence.topbarLeadingScrollWidth,
          controlVisible: stateEvidence.topbarLeadingControlVisible,
          markVisible: stateEvidence.topbarLeadingMarkVisible,
        })}`,
      )
    }
    if (target.expectDockedComposerBounded) {
      invariant(stateEvidence.dockedComposerBounded, `${target.name} did not keep the 512px docked-inspector composer bounded: ${JSON.stringify({ layout, stateEvidence })}`)
    }
    if (target.expectOutcomeBranchHierarchy) {
      invariant(
        stateEvidence.outcomeBranchHierarchyBounded,
        `${target.name} did not preserve a bounded parent-first RLM outcome hierarchy: ${JSON.stringify(stateEvidence.outcomeBranchEvidence)}`,
      )
      invariant(
        stateEvidence.emptyComposerAbsent,
        `${target.name} retained an empty composer below the completed outcome`,
      )
    }
    const image = await browserWindow.webContents.capturePage()
    const outputPath = join(outputDirectory, `${target.name}.png`)
    await writeFile(outputPath, image.toPNG())
    return { ...target, outputPath, layout, stateEvidence }
  } finally {
    if (!browserWindow.isDestroyed()) browserWindow.destroy()
  }
}

async function main() {
  await access(rendererEntry)
  await mkdir(outputDirectory, { recursive: true })
  await app.whenReady()
  const rendererServer = await startRendererServer()
  const keeperWindow = new BrowserWindow({ show: false, width: 1, height: 1 })
  try {
    const results = []
    for (const target of targets) {
      try {
        results.push(await capture(target, rendererServer.origin))
      } catch (error) {
        throw new Error(
          `Visual capture target ${target.name} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          { cause: error },
        )
      }
    }
    return results
  } finally {
    if (!keeperWindow.isDestroyed()) keeperWindow.destroy()
    await rendererServer.close()
  }
}

main().then(
  async (results) => {
    await writeFile(resultPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
    app.exit(0)
  },
  async (error) => {
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(errorPath, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`, 'utf8')
    app.exit(1)
  },
)
