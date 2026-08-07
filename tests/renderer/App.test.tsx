// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import App from '../../src/renderer/src/App'
import {
  createPreviewRendererApi,
  StaleHostAuthorityError,
  type HostRuntimeReadiness,
  type RuntimeModelCatalog,
} from '../../src/renderer/src/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function withLargeModelCatalog(catalog: RuntimeModelCatalog): RuntimeModelCatalog {
  const providers = catalog.providers.slice(0, 2).map((provider) => ({
    ...provider,
    configured: true,
    modelCount: 90,
    availableModelCount: 90,
  }))
  const template = catalog.models.find((model) => model.available)!
  return {
    ...catalog,
    providers,
    models: Array.from({ length: 180 }, (_, index) => {
      const provider = providers[index < 90 ? 0 : 1]!
      const sequence = String(index + 1).padStart(3, '0')
      return {
        ...template,
        providerId: provider.providerId,
        modelId: `catalog-model-${sequence}`,
        name: `Catalog model ${sequence}`,
        available: true,
        usingOAuth: provider.oauthSupported,
      }
    }),
  }
}

beforeAll(() => {
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
  })

  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '')
    },
  })

  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    },
  })
})

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
})

describe('Prime Continuim renderer', () => {
  it('keeps the durable thread primary while connection and task states remain separate', async () => {
    render(<App api={createPreviewRendererApi()} />)

    expect(await screen.findByRole('heading', { name: 'Seamless remote experience' })).toBeVisible()
    expect(document.querySelector('.topbar__brand-name')).toHaveTextContent('Prime Continuim')
    expect(screen.getAllByText('Running').some((element) => element.getClientRects().length > 0 || !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.getAllByText(/Reconnecting… Last synchronized 12 s ago/).some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send when reconnected' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send when reconnected' })).toHaveClass('button--empty')
    expect(screen.getByText(/cached transcript is still available/i)).toBeVisible()
    const continuity = screen.getByRole('region', { name: 'Session status' })
    expect(within(continuity).getByText(/Last reported resident on devbox · current status unverified/i)).toBeVisible()
    expect(within(continuity).queryByText(/Continues on devbox when this window closes/i)).not.toBeInTheDocument()
  })

  it('preserves the composer and cached transcript for an offline thread', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    await user.click(screen.getByRole('button', { name: /Training runs/ }))

    expect(await screen.findByRole('heading', { name: 'Benchmark attention kernel' })).toBeVisible()
    expect(screen.getAllByText(/Offline · Last synchronized 18 min ago/).some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.getAllByText(/cached transcript remains available/i).some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled()

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Send the benchmark recap when the host returns.')
    expect(screen.getByRole('button', { name: 'Send when reconnected' })).not.toHaveClass('button--empty')
    await user.click(screen.getByRole('button', { name: 'Send when reconnected' }))
    expect((await screen.findAllByText(/Preview simulation · command saved only in the in-memory preview outbox/i)).some((element) => !element.classList.contains('sr-only'))).toBe(true)
  })

  it('cannot retain a hidden steer intent after selecting a non-running thread', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      const devbox = snapshot.hosts.find((host) => host.id === 'host-devbox')
      if (devbox) devbox.connection = 'online'
      return snapshot
    }
    api.sendComposer = vi.fn(async () => ({ state: 'sent', message: 'Sent' }))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const steerIntent = screen.getByRole('button', { name: 'Steer next step' })
    await user.click(steerIntent)
    expect(steerIntent).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: /Frame protocol boundaries/ }))
    expect(await screen.findByRole('heading', { name: 'Frame protocol boundaries' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Steer next step' })).not.toBeInTheDocument()
    expect(screen.getByText('Follow up', { selector: '.composer__intent' })).toBeVisible()

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Summarize the approval boundary.')
    await user.click(screen.getByRole('button', { name: 'Send follow-up' }))
    expect(api.sendComposer).toHaveBeenCalledWith(expect.objectContaining({ intent: 'follow_up' }))
  })

  it('focuses and describes an empty composer submission, then clears the error while typing', async () => {
    const user = userEvent.setup()
    const previewApi = createPreviewRendererApi()
    const sendComposer = vi.fn(previewApi.sendComposer.bind(previewApi))
    const api = Object.create(previewApi) as typeof previewApi
    Object.defineProperty(api, 'sendComposer', { configurable: true, value: sendComposer })
    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    const composer = screen.getByRole('textbox', { name: 'Message' })
    await user.click(screen.getByRole('button', { name: 'Send when reconnected' }))

    await waitFor(() => expect(composer).toHaveFocus())
    expect(composer).toHaveAttribute('aria-invalid', 'true')
    expect(composer).toHaveAttribute('aria-describedby', 'composer-hint composer-message-error')
    expect(document.getElementById('composer-message-error')).toHaveTextContent('Write a message before sending.')
    expect(sendComposer).not.toHaveBeenCalled()

    await user.type(composer, 'Continue from the latest checkpoint.')
    expect(composer).not.toHaveAttribute('aria-invalid')
    expect(composer).toHaveAttribute('aria-describedby', 'composer-hint composer-status')
    expect(document.getElementById('composer-message-error')).not.toBeInTheDocument()
  })

  it('preserves a draft when the host rejects command admission', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    api.sendComposer = vi.fn(async () => ({
      state: 'rejected',
      message: 'Prime Agent execution is not attached in this build.',
    }))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const composer = screen.getByRole('textbox', { name: 'Message' })
    const draft = 'Keep this draft until execution is available.'
    await user.type(composer, draft)
    await user.click(screen.getByRole('button', { name: 'Send when reconnected' }))

    await screen.findAllByText('Prime Agent execution is not attached in this build.')
    expect(composer).toHaveValue(draft)
    expect(within(screen.getByRole('region', { name: 'Thread transcript' })).queryByText(draft)).not.toBeInTheDocument()
  })

  it('waits for an authoritative host snapshot before rendering an admitted prompt', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const snapshot = await api.loadWorkbench()
    let publish: ((next: typeof snapshot) => void) | undefined
    api.loadWorkbench = vi.fn(() => Promise.resolve(structuredClone(snapshot)))
    api.subscribe = vi.fn((listener) => {
      publish = listener
      return () => undefined
    })
    api.sendComposer = vi.fn(async () => ({ state: 'sent', message: 'Sent · durably admitted by host' }))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const transcript = screen.getByRole('region', { name: 'Thread transcript' })
    const composer = screen.getByRole('textbox', { name: 'Message' })
    const prompt = 'Wait for the resident transcript before showing this prompt.'

    await user.type(composer, prompt)
    await user.click(screen.getByRole('button', { name: 'Send when reconnected' }))

    await waitFor(() => expect(api.sendComposer).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(composer).toHaveValue(''))
    expect(within(transcript).queryByText(prompt)).not.toBeInTheDocument()

    const authoritative = structuredClone(snapshot)
    const selected = authoritative.threads.find((thread) => thread.id === authoritative.selectedThreadId)
    if (!selected) throw new Error('Expected the selected thread fixture')
    selected.transcript.push({
      id: 'authoritative-user-prompt',
      kind: 'user',
      author: 'You',
      time: 'Now',
      body: prompt,
    })
    authoritative.composerReceipt = { state: 'sent', message: 'Sent · durably admitted by host' }

    await act(async () => publish?.(authoritative))
    expect(await within(transcript).findByText(prompt)).toBeVisible()
  })

  it('does not let a same-host in-flight receipt clear a newer thread draft', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const admission = deferred<{ state: 'sent'; message: string }>()
    api.sendComposer = vi.fn(() => admission.promise)

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const firstComposer = screen.getByRole('textbox', { name: 'Message' })
    await user.type(firstComposer, 'First thread submission')
    await user.click(screen.getByRole('button', { name: 'Send when reconnected' }))

    await user.click(screen.getByRole('button', { name: /Audit SSH discovery/ }))
    await screen.findByRole('heading', { name: 'Audit SSH discovery' })
    const secondComposer = screen.getByRole('textbox', { name: 'Message' })
    await user.clear(secondComposer)
    await user.type(secondComposer, 'Newer draft for the second thread')

    await act(async () => {
      admission.resolve({ state: 'sent', message: 'Sent' })
      await admission.promise
    })

    expect(secondComposer).toHaveValue('Newer draft for the second thread')
    expect(within(screen.getByRole('region', { name: 'Thread transcript' })).queryByText('First thread submission')).not.toBeInTheDocument()
  })

  it('disables native execution affordances when the host did not negotiate them', async () => {
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.operations = { submitCommands: false, crossHostHandoff: false }
      return snapshot
    }
    api.sendComposer = vi.fn(async () => ({ state: 'sent', message: 'Sent' }))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Commands unavailable' })).toBeDisabled()
    const location = screen.getByLabelText(/^Run location: devbox\. Moving threads between computers is unavailable$/)
    expect(location).toHaveTextContent('devboxMove unavailable')
    expect(screen.getAllByText(/Prime Agent isn’t attached to this host/i).some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(api.sendComposer).not.toHaveBeenCalled()
  })

  it('asks the adapter for the authoritative snapshot when a thread is selected', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const selectThread = vi.spyOn(api, 'selectThread')
    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    await user.click(screen.getByRole('button', { name: /Training runs/ }))

    expect(selectThread).toHaveBeenCalledWith('thread-gpu')
  })

  it('labels the browser model registry as illustrative while preserving its read-only metadata controls', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const loadRuntimeModelCatalog = vi.spyOn(api, 'loadRuntimeModelCatalog')

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const trigger = screen.getByRole('button', { name: /Open models and accounts/ })
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    expect(await within(dialog).findByText('Sample accounts')).toBeVisible()
    expect(within(dialog).getByText(/Illustrative sample catalog.*No Prime Agent host was queried/i)).toBeVisible()
    expect(within(dialog).queryByText(/reported by Prime Agent on devbox/i)).not.toBeInTheDocument()
    expect(loadRuntimeModelCatalog).toHaveBeenCalledWith('host-devbox')
    expect(within(dialog).getByText('2 configured')).toBeVisible()
    expect(within(dialog).getByText(/Browser preview · illustrative Prime Agent 0\.7\.0 fixture/)).toBeVisible()
    expect(within(dialog).getByText('GPT-5.6 Sol')).toBeVisible()
    expect(within(dialog).getByText('Kimi K3')).toBeVisible()
    expect(within(dialog).getByText('Current')).toBeVisible()
    expect(within(dialog).queryByText('Claude Opus 5')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /connect|select/i })).not.toBeInTheDocument()
    expect(within(dialog).getByText(/Illustrative sample only/)).toBeVisible()
    expect(within(dialog).getByText(/model names and availability are not host evidence/i)).toBeVisible()

    const providerToolbar = within(dialog).getByRole('toolbar', { name: 'Filter models by provider' })
    const allProviders = within(providerToolbar).getByRole('button', { name: /All providers/ })
    const codexProvider = within(providerToolbar).getByRole('button', { name: /ChatGPT Plus\/Pro/ })
    expect(providerToolbar).toHaveAttribute('aria-orientation', 'horizontal')
    expect(providerToolbar).toHaveAccessibleDescription(/Use Left and Right Arrow keys to select a provider/)
    expect(allProviders).toHaveAttribute('tabindex', '0')
    expect(codexProvider).toHaveAttribute('tabindex', '-1')
    allProviders.focus()
    await user.keyboard('{ArrowRight}')
    expect(codexProvider).toHaveFocus()
    expect(codexProvider).toHaveAttribute('aria-pressed', 'true')
    expect(codexProvider).toHaveAttribute('tabindex', '0')
    await user.keyboard('{End}')
    expect(within(providerToolbar).getByRole('button', { name: /^xAI/ })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(allProviders).toHaveFocus()

    await user.click(within(dialog).getByRole('button', { name: /Anthropic \(Claude Pro\/Max\)/ }))
    expect(within(dialog).getByText('OAuth is supported by Prime Agent')).toBeVisible()
    expect(within(dialog).getByText('0 shown as available · 2 listed in this sample')).toBeVisible()
    expect(within(dialog).getByText('/login')).toBeVisible()
    expect(within(dialog).getByText(/This sample never reads or stores credentials/)).toBeVisible()
    expect(within(dialog).getByText('No available models match')).toBeVisible()

    await user.click(within(dialog).getByRole('button', { name: 'All models' }))
    expect(within(dialog).getByText('Claude Opus 5')).toBeVisible()
    expect(within(dialog).getAllByText('Setup required').length).toBeGreaterThan(0)
    expect(dialog.querySelector('.model-list')).not.toHaveAttribute('aria-live')
    expect(within(dialog).getByRole('status')).toHaveAttribute('aria-atomic', 'true')

    await user.click(within(dialog).getByRole('button', { name: 'Close models and accounts' }))
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('reveals every matching model in explicit batches and resets the batch when filters or the dialog change', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const catalog = withLargeModelCatalog(await api.loadRuntimeModelCatalog('host-devbox'))
    api.loadRuntimeModelCatalog = vi.fn(async () => structuredClone(catalog))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const trigger = screen.getByRole('button', { name: /Open models and accounts/ })
    await user.click(trigger)

    let dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    expect(await within(dialog).findByText('Showing 80 of 180 models')).toBeVisible()
    expect(within(dialog).getByText('Catalog model 080')).toBeVisible()
    expect(within(dialog).queryByText('Catalog model 081')).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Show 80 more models' }))
    expect(within(dialog).getByText('Showing 160 of 180 models')).toBeVisible()
    expect(within(dialog).getByText('Catalog model 160')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Show 20 more models' })).toBeVisible()

    await user.click(within(dialog).getByRole('button', { name: /ChatGPT Plus\/Pro/ }))
    expect(within(dialog).getByText('Showing 80 of 90 models')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Show 10 more models' }))
    expect(within(dialog).getByText('Showing 90 of 90 models')).toBeVisible()

    await user.type(within(dialog).getByRole('searchbox', { name: 'Search models' }), 'Catalog')
    expect(within(dialog).getByText('Showing 80 of 90 models')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Show 10 more models' }))
    await user.click(within(dialog).getByRole('button', { name: 'All models' }))
    expect(within(dialog).getByText('Showing 80 of 90 models')).toBeVisible()

    await user.click(within(dialog).getByRole('button', { name: 'Close models and accounts' }))
    await user.click(trigger)
    dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    expect(await within(dialog).findByText('Showing 80 of 180 models')).toBeVisible()
    expect(api.loadRuntimeModelCatalog).toHaveBeenCalledTimes(2)
  })

  it('retries a recoverable catalog load without enabling model mutation controls', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const catalog = await api.loadRuntimeModelCatalog('host-devbox')
    const loadRuntimeModelCatalog = vi.fn()
      .mockRejectedValueOnce(new Error('The catalog request timed out.'))
      .mockResolvedValue(catalog)
    api.loadRuntimeModelCatalog = loadRuntimeModelCatalog

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: /Open models and accounts/ }))

    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    expect(await within(dialog).findByText('The catalog request timed out.')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Retry loading catalog' }))
    expect(await within(dialog).findByText('Illustrative sample models')).toBeVisible()
    expect(loadRuntimeModelCatalog).toHaveBeenCalledTimes(2)
    expect(within(dialog).queryByRole('button', { name: /select model|use model|switch model/i })).not.toBeInTheDocument()
  })

  it('does not retry a catalog request captured for stale host authority', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const loadRuntimeModelCatalog = vi.fn(async () => {
      throw new StaleHostAuthorityError()
    })
    api.loadRuntimeModelCatalog = loadRuntimeModelCatalog

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const trigger = screen.getByRole('button', { name: /Open models and accounts/ })
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    expect(await within(dialog).findByText(/Close this dialog, confirm the active computer, then reopen Models & accounts/)).toBeVisible()
    expect(within(dialog).queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Close dialog' }))
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(loadRuntimeModelCatalog).toHaveBeenCalledOnce()
  })

  it('shows Add computer as one keyboard-operable sheet with exact connection and install details', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const sidebarToggle = screen.getByRole('button', { name: 'Open sidebar' })
    await user.click(sidebarToggle)
    const sidebar = await screen.findByRole('dialog', { name: 'Projects and threads' })
    const trigger = within(sidebar).getByRole('button', { name: 'Add computer' })

    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Add computer' })
    expect(within(dialog).getByText('Discovered aliases')).toBeVisible()
    expect((await within(dialog).findAllByText('ebene@devbox.internal:22')).length).toBeGreaterThan(0)
    expect(within(dialog).getByText('Preview sample')).toBeVisible()
    expect(within(dialog).getByText('Host verification')).toBeVisible()
    expect(within(dialog).getAllByText(/Sample browser preview only; no live host key was checked/i).length).toBeGreaterThan(0)
    expect(within(dialog).queryByText('Host-key fingerprint')).not.toBeInTheDocument()
    expect(within(dialog).getByText('Readiness check')).toBeVisible()

    await user.click(within(dialog).getByText('Show exact install command'))
    expect(within(dialog).getByText(/No signed host-service installer is available in this build/)).toBeVisible()
    expect(within(dialog).getByRole('checkbox', { name: /Install the signed Continuim host service/ })).toBeDisabled()
    const unavailableInstaller = within(dialog).getByRole('button', { name: 'Host-service installer unavailable' })
    expect(unavailableInstaller).toBeDisabled()
    expect(unavailableInstaller).toHaveAttribute('aria-describedby', 'add-computer-install-unavailable')
    await user.click(within(dialog).getByText('Install Prime Agent on macOS or Linux'))
    expect(within(dialog).getByText('curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh')).toBeVisible()
    expect(within(dialog).getByText(/never runs this command automatically/i)).toBeVisible()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(sidebarToggle).toHaveFocus())
  })

  it('announces official installer clipboard results', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      render(<App api={createPreviewRendererApi()} />)
      await screen.findByRole('heading', { name: 'Seamless remote experience' })
      await user.click(screen.getByRole('button', { name: 'Open sidebar' }))
      const sidebar = await screen.findByRole('dialog', { name: 'Projects and threads' })
      await user.click(within(sidebar).getByRole('button', { name: 'Add computer' }))
      const dialog = await screen.findByRole('dialog', { name: 'Add computer' })
      await within(dialog).findByText('Readiness check')
      await user.click(within(dialog).getByText('Install Prime Agent on macOS or Linux'))
      await user.click(within(dialog).getByRole('button', { name: 'Copy official Prime Agent install command' }))

      await waitFor(() => expect(writeText).toHaveBeenCalledWith('curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh'))
      expect(within(dialog).getByText('Prime Agent install command copied to the clipboard.')).toBeVisible()
      await user.click(within(dialog).getByRole('button', { name: 'Copy official Prime Agent install command' }))
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    }
  })

  it('labels absent runtime telemetry as not reported instead of zero', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.runtime = { queue: { pendingCount: 0, paused: false } }
      snapshot.agents = []
      return snapshot
    }

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    expect(within(screen.getByRole('region', { name: 'Session status' })).getByText('Goal state unavailable')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Runtime' }))
    const runtimePanel = screen.getByRole('tabpanel', { name: 'Runtime' })

    expect(within(runtimePanel).getByText('Current thread · runtime not reported')).toBeVisible()
    expect(within(runtimePanel).getByText('Agent activity isn’t reported in this snapshot.')).toBeVisible()
    expect(within(runtimePanel).getByText('Goals aren’t reported in this snapshot.')).toBeVisible()
    expect(within(runtimePanel).getByText('Schedules aren’t reported in this snapshot.')).toBeVisible()
    expect(within(runtimePanel).getByText('Goals not reported · Agents not reported')).toBeVisible()
    expect(within(runtimePanel).queryByText('0 active · 0 agents')).not.toBeInTheDocument()
  })

  it.each([
    [
      'unreported verification',
      { kind: 'not_reported', freshness: 'live' },
      'This host service doesn’t report runtime verification.',
      undefined,
    ],
    [
      'runtime preparation',
      { kind: 'reported', freshness: 'live', status: 'initializing', phase: 'verifying' },
      'Preparing verified Prime Agent runtime · Verifying files',
      undefined,
    ],
    [
      'cached verification failure',
      {
        kind: 'reported',
        freshness: 'cached',
        observedAt: '2026-08-05T20:00:00.000Z',
        status: 'failed',
        recovery: 'repair',
      },
      'Last reported · Runtime verification failed',
      'Repair or reinstall Prime Continuim on this computer.',
    ],
    [
      'ready development integrity',
      { kind: 'reported', freshness: 'live', status: 'ready', assurance: 'development-integrity' },
      'Development integrity',
      undefined,
    ],
    [
      'ready runtime without an assurance claim',
      { kind: 'reported', freshness: 'live', status: 'ready' },
      'Runtime files verified',
      undefined,
    ],
  ] satisfies Array<[string, HostRuntimeReadiness, string, string | undefined]>) (
    'renders compact, honest host %s in the Runtime facts',
    async (_caseName, readiness, summary, detail) => {
      const user = userEvent.setup()
      const api = createPreviewRendererApi()
      const loadWorkbench = api.loadWorkbench.bind(api)
      api.loadWorkbench = async () => {
        const snapshot = await loadWorkbench()
        const activeHost = snapshot.hosts.find((host) => host.id === snapshot.threads.find((thread) => thread.id === snapshot.selectedThreadId)?.hostId)
        if (activeHost) activeHost.runtimeReadiness = readiness
        return snapshot
      }

      render(<App api={api} />)
      await screen.findByRole('heading', { name: 'Seamless remote experience' })
      await user.click(screen.getByRole('tab', { name: 'Runtime' }))
      const runtimePanel = screen.getByRole('tabpanel', { name: 'Runtime' })

      expect(within(runtimePanel).getByText('Runtime verification')).toBeVisible()
      expect(within(runtimePanel).getByText(summary)).toBeVisible()
      if (detail) expect(within(runtimePanel).getByText(detail)).toBeVisible()
      if (readiness.freshness === 'cached') {
        const observed = runtimePanel.querySelector(`time[datetime="${readiness.observedAt}"]`)
        expect(observed).toBeVisible()
        expect(observed).toHaveTextContent(/^Observed /)
      }
      expect(within(runtimePanel).queryByText(/RUNTIME_INTEGRITY_/)).not.toBeInTheDocument()
    },
  )

  it('renders persisted work reports independently from live session telemetry', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.runtime = {
        agentsReported: true,
        goals: [{ id: 'persisted-goal', objective: 'Finish the persisted review', state: 'paused' }],
        schedules: [{ id: 'persisted-schedule', label: 'Resume the review tomorrow', state: 'paused' }],
      }
      snapshot.agents = [{
        id: 'persisted-agent',
        name: 'Review helper',
        role: 'Retained subagent',
        status: 'waiting',
        hostName: 'devbox',
      }]
      return snapshot
    }

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    expect(within(screen.getByRole('region', { name: 'Session status' })).getByText('Finish the persisted review')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Runtime' }))
    const runtimePanel = screen.getByRole('tabpanel', { name: 'Runtime' })

    expect(within(runtimePanel).getByText('Current thread · session not reported')).toBeVisible()
    expect(within(runtimePanel).getByText('Finish the persisted review')).toBeVisible()
    expect(within(runtimePanel).getByText('Resume the review tomorrow')).toBeVisible()
    expect(within(runtimePanel).getByText('Review helper')).toBeVisible()
  })

  it('focuses and clears field-level Add computer errors as they are corrected', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const previewProbe = api.probeComputer.bind(api)
    api.probeComputer = vi.fn(async (input) => ({
      ...(await previewProbe(input)),
      installAvailable: true,
      installCommand: "ssh build-preview 'continuim-hostd install --user'",
      installDeferredReason: undefined,
    }))

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: 'Open sidebar' }))
    const sidebar = await screen.findByRole('dialog', { name: 'Projects and threads' })
    await user.click(within(sidebar).getByRole('button', { name: 'Add computer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add computer' })

    await user.click(within(dialog).getByText('Preview a manual host'))
    const host = within(dialog).getByRole('textbox', { name: 'Hostname or SSH alias' })
    await user.click(within(dialog).getByRole('button', { name: 'Check preview host' }))
    expect(host).toHaveFocus()
    expect(host).toHaveAttribute('aria-invalid', 'true')
    expect(host).toHaveAttribute('aria-describedby', 'add-computer-error')
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/Enter a hostname or SSH alias/i)

    await user.type(host, 'build-preview')
    expect(host).toHaveAttribute('aria-invalid', 'false')
    expect(host).not.toHaveAttribute('aria-describedby')
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Check preview host' }))

    const consent = await within(dialog).findByRole('checkbox', { name: /Install the signed Continuim host service/ })
    await waitFor(() => expect(consent).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: /Install and add/ }))
    expect(consent).toHaveFocus()
    expect(consent).toHaveAttribute('aria-invalid', 'true')
    expect(consent).toHaveAttribute('aria-describedby', 'add-computer-error')
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/Allow installation/i)

    await user.click(consent)
    expect(consent).toHaveAttribute('aria-invalid', 'false')
    expect(consent).not.toHaveAttribute('aria-describedby')
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reviews and completes a checkpoint handoff without changing the reviewed source', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    await user.selectOptions(screen.getByRole('combobox', { name: /Run location:/ }), 'host-local')
    const dialog = await screen.findByRole('dialog', { name: 'Move thread' })
    expect(await within(dialog).findByText('Move review')).toBeVisible()
    expect(dialog).toHaveTextContent(/devbox remains authoritative/i)
    expect(within(dialog).getByText('Running subprocesses')).toBeVisible()
    expect(within(dialog).getByText(/checkpoint transfer, not a live process migration/i)).toBeVisible()

    await user.click(within(dialog).getByRole('radio', { name: /Interrupt this turn/ }))
    const moveButton = within(dialog).getByRole('button', { name: 'Move thread to This computer' })
    await waitFor(() => expect(moveButton).toBeEnabled())
    await user.click(moveButton)

    await waitFor(() => expect(dialog).toHaveTextContent(/Moved from devbox to This computer/i), { timeout: 4_000 })
    expect(dialog).not.toHaveTextContent(/Moved from This computer to This computer/i)
    expect(within(dialog).getByText(/Runtime-local Python state restarted/i)).toBeVisible()
  }, 6_000)

  it('implements arrow-key navigation for inspector tabs', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    const inspectorToggle = screen.getByRole('button', { name: 'Open inspector' })
    expect(inspectorToggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(inspectorToggle)

    const changes = screen.getByRole('tab', { name: 'Changes' })
    changes.focus()
    await user.keyboard('{ArrowRight}')

    expect(screen.getByRole('tab', { name: 'Runtime' })).toHaveAttribute('aria-selected', 'true')
    const runtimePanel = screen.getByRole('tabpanel', { name: 'Runtime' })
    expect(within(runtimePanel).getByRole('heading', { name: 'Reported runtime' })).toBeVisible()
    expect(within(runtimePanel).getByText('Implement the seamless remote workbench')).toBeVisible()
    expect(within(runtimePanel).getByText('Review overnight verification')).toBeVisible()
    expect(within(runtimePanel).getAllByText('Subagent of Workbench lead')).toHaveLength(2)
    expect(within(runtimePanel).getByText(/18 tool uses/)).toBeVisible()
  })

  it('progressively mounts large retained-subagent projections in bounded windows', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.agents = Array.from({ length: 120 }, (_, index) => ({
        id: `agent-${index}`,
        ...(index > 0 ? { parentId: 'agent-0' } : {}),
        name: `Agent ${index + 1}`,
        role: 'Retained subagent',
        status: index % 3 === 0 ? 'running' as const : 'waiting' as const,
        hostName: 'devbox',
      }))
      return snapshot
    }

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    await user.click(screen.getByRole('tab', { name: 'Runtime' }))
    const runtimePanel = screen.getByRole('tabpanel', { name: 'Runtime' })

    expect(runtimePanel.querySelectorAll('[data-runtime-agent]')).toHaveLength(50)
    await user.click(within(runtimePanel).getByRole('button', { name: 'Show 50 more subagents' }))
    expect(runtimePanel.querySelectorAll('[data-runtime-agent]')).toHaveLength(100)
    await user.click(within(runtimePanel).getByRole('button', { name: 'Show 20 more subagents' }))
    expect(runtimePanel.querySelectorAll('[data-runtime-agent]')).toHaveLength(120)
    expect(within(runtimePanel).queryByRole('button', { name: /more subagents/ })).not.toBeInTheDocument()
  })

  it('keeps projection-only inspector data non-interactive and reports the real connection state', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    const changesPanel = screen.getByRole('tabpanel', { name: 'Changes' })
    expect(within(changesPanel).queryByRole('button')).not.toBeInTheDocument()
    expect(within(changesPanel).queryByText('App.tsx')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Runtime' }))
    expect(within(screen.getByRole('tabpanel', { name: 'Runtime' })).queryByRole('button')).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    expect(within(screen.getByRole('tabpanel', { name: 'Evidence' })).queryByRole('button', { name: 'Run checks' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Training runs/ }))
    await user.click(screen.getByRole('tab', { name: 'Context' }))
    const contextPanel = screen.getByRole('tabpanel', { name: 'Context' })
    expect(within(contextPanel).getByText(/Offline · Last synchronized 18 min ago/)).toBeVisible()
    expect(within(contextPanel).queryByText('Running')).not.toBeInTheDocument()
  })

  it('omits controls that do not have backing operations', async () => {
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    expect(screen.queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New thread' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Running.*Seamless remote experience/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Search projects and threads' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Attach files' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })

  it('labels verification-only host identity results without inventing a fingerprint', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    api.discoverComputers = async () => [
      {
        alias: 'verification-only',
        effectiveTarget: 'developer@build.example.com:22',
        fingerprint: 'Host identity was checked by system OpenSSH; the exact fingerprint was not returned by this probe.',
        protocol: 'System OpenSSH',
        platform: 'Ubuntu 24.04',
        architecture: 'x86_64',
        diskFree: '80 GB free',
        gitVersion: 'Git 2.45.2',
        pythonStatus: 'Python 3.12',
        agentVersion: 'Prime Agent 0.7.0',
        hostServiceVersion: 'Host service 0.1.0',
        requiresInstall: false,
        installCommand: "ssh verification-only 'prime-agent-hostd install --user'",
        recentProjects: [],
        probeComplete: true,
        installAvailable: true,
      },
    ]

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: 'Add computer' }))

    const dialog = await screen.findByRole('dialog', { name: 'Add computer' })
    expect(await within(dialog).findByText('Host verification')).toBeVisible()
    expect(within(dialog).queryByText('Host-key fingerprint')).not.toBeInTheDocument()
    expect(within(dialog).getAllByText(/Sample browser preview only; no live host key was checked/i).length).toBeGreaterThan(0)
  })

  it('opens a real command palette and navigates to a matching durable thread', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const selectThread = vi.spyOn(api, 'selectThread')
    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    await user.keyboard('{Control>}k{/Control}')
    const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
    const search = within(palette).getByRole('combobox', { name: 'Search projects, threads, and commands' })
    expect(search).toHaveFocus()
    expect(search).toHaveAttribute('aria-autocomplete', 'list')
    await user.type(search, 'Benchmark attention')
    expect(within(palette).queryByText('New thread')).not.toBeInTheDocument()
    const matchingOption = within(palette).getByRole('option', { name: /Benchmark attention kernel/ })
    expect(matchingOption).toHaveAttribute('tabindex', '-1')
    await user.click(matchingOption)

    expect(await screen.findByRole('heading', { name: 'Benchmark attention kernel' })).toBeVisible()
    expect(selectThread).toHaveBeenCalledWith('thread-gpu')

    await user.keyboard('{Control>}k{/Control}')
    const companionPalette = await screen.findByRole('dialog', { name: 'Search and commands' })
    const companionSearch = within(companionPalette).getByRole('combobox', { name: 'Search projects, threads, and commands' })
    await user.type(companionSearch, 'Companion Preview')
    await user.click(within(companionPalette).getByRole('option', { name: /Open companion preview/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Needs you' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Desktop' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search projects, threads, and commands' })).toHaveFocus())
  })

  it('closes the command palette with an explicit touch target and ignores its shortcut over another sheet', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    const sidebarTrigger = screen.getByRole('button', { name: 'Open sidebar' })
    await user.click(sidebarTrigger)
    const sidebar = await screen.findByRole('dialog', { name: 'Projects and threads' })
    await user.keyboard('{Control>}k{/Control}')
    expect(sidebar).toHaveAttribute('aria-modal', 'true')
    expect(screen.queryByRole('dialog', { name: 'Search and commands' })).not.toBeInTheDocument()
    await user.click(within(sidebar).getByRole('button', { name: 'Close sidebar' }))
    await waitFor(() => expect(sidebarTrigger).toHaveFocus())

    const paletteTrigger = screen.getByRole('button', { name: 'Search projects, threads, and commands' })
    await user.click(paletteTrigger)
    const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
    expect(palette).toHaveAttribute('open')

    await user.click(within(palette).getByRole('button', { name: 'Close search and commands' }))
    await waitFor(() => expect(paletteTrigger).toHaveFocus())
    expect(screen.queryByRole('dialog', { name: 'Search and commands' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add computer' }))
    const addComputer = await screen.findByRole('dialog', { name: 'Add computer' })
    await user.keyboard('{Control>}k{/Control}')

    expect(addComputer).toHaveAttribute('open')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: 'Search and commands' })).not.toBeInTheDocument()
  })

  it('shows an honest pairing gate and a sample, read-only Companion Preview with stable focus', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    const sidebarToggle = screen.getByRole('button', { name: 'Open sidebar' })
    await user.click(sidebarToggle)
    const sidebar = await screen.findByRole('dialog', { name: 'Projects and threads' })
    await user.click(within(sidebar).getByRole('button', { name: 'Companion preview' }))
    const dialog = await screen.findByRole('dialog', { name: 'Mobile companion' })
    expect(screen.queryByRole('dialog', { name: 'Projects and threads' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(within(dialog).getByRole('heading', { name: 'Phone control isn’t available in this build' })).toBeVisible()
    expect(within(dialog).getByText(/does not connect a phone or enable remote control/i)).toBeVisible()
    expect(within(dialog).queryByText('Per-device permissions')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('relay_pairing_v1')).not.toBeInTheDocument()
    expect(within(dialog).getByText('Browser preview · sample data')).toBeVisible()
    expect(within(dialog).queryByRole('button', { name: 'Start pairing' })).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Open companion preview' }))
    expect(await screen.findByText('Prime Continuim')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Needs you' })).toHaveFocus())
    expect(screen.getByText('Browser preview · sample data')).toBeVisible()
    expect(screen.getByRole('note')).toHaveTextContent(/Read-only preview.*Secure relay unavailable/i)
    expect(screen.getByRole('navigation', { name: 'Companion navigation' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Threads' }))
    const selectedThreadRow = screen.getByRole('button', { name: /Seamless remote experience/ })
    await user.click(selectedThreadRow)
    const companionThreadHeading = await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await waitFor(() => expect(companionThreadHeading).toHaveFocus())
    expect(screen.getByText('Replies are read-only in this preview')).toBeVisible()
    expect(screen.getByText(/This preview never sends a command/i)).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Mobile message' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()

    const threadArticle = screen.getByRole('article', { name: 'Seamless remote experience' })
    await user.click(within(threadArticle).getByRole('button', { name: 'Threads' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Seamless remote experience/ })).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Desktop' }))
    expect(await screen.findByRole('heading', { name: 'Seamless remote experience' })).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open sidebar' })).toHaveFocus())
  })

  it('reuses the safe transcript-body renderer for Companion recent activity', async () => {
    window.history.replaceState({}, '', '/?surface=companion')
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      const selected = snapshot.threads.find((thread) => thread.id === snapshot.selectedThreadId)
      if (!selected) throw new Error('Expected the selected thread fixture')
      selected.transcript.push({
        id: 'companion-markdown-fidelity',
        kind: 'assistant',
        author: 'Prime Agent',
        time: 'Now',
        body: '### Resident result\n\n- Snapshot persisted\n- Reconnect verified\n\n```ts\nconst durable = true\n```',
      })
      return snapshot
    }

    render(<App api={api} />)
    expect(await screen.findByRole('heading', { name: 'Needs you' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Threads' }))
    await user.click(await screen.findByRole('button', { name: /Seamless remote experience/ }))

    const recentActivity = await screen.findByRole('region', { name: 'Recent activity' })
    const sharedBody = recentActivity.querySelector('[data-transcript-body-kind="assistant"]')
    expect(sharedBody).not.toBeNull()
    expect(within(recentActivity).getByRole('heading', { name: 'Resident result' })).toBeVisible()
    expect(within(recentActivity).getAllByRole('listitem')).toHaveLength(2)
    expect(recentActivity.querySelector('pre > code.language-ts')).toHaveTextContent('const durable = true')
  })

  it('surfaces an uncertain command receipt in mobile Attention', async () => {
    window.history.replaceState({}, '', '/?surface=companion')
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => ({
      ...(await loadWorkbench()),
      composerReceipt: { state: 'uncertain', message: 'Receipt uncertain · reconciling by command ID' },
    })

    render(<App api={api} />)

    expect(await screen.findByRole('heading', { name: 'Needs you' })).toBeVisible()
    expect(screen.getByRole('button', { name: /Receipt uncertain · reconciling by command ID/ })).toBeVisible()
  })

  it('keeps an in-flight handoff visible when Escape or the backdrop is used', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const handoff = deferred<{ destinationHostId: string; receiptId: string }>()
    api.startHandoff = vi.fn(async (_input, onProgress) => {
      onProgress('quiescing', 'Preparing the source')
      return handoff.promise
    })

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.selectOptions(screen.getByRole('combobox', { name: /Run location:/ }), 'host-local')

    const dialog = await screen.findByRole('dialog', { name: 'Move thread' })
    const moveButton = await within(dialog).findByRole('button', { name: 'Move thread to This computer' })
    await waitFor(() => expect(moveButton).toBeEnabled())
    await user.click(moveButton)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Moving thread…' })).toBeDisabled())
    const progressHeading = within(dialog).getByRole('heading', { name: 'Move progress' })
    await waitFor(() => expect(progressHeading).toHaveFocus())
    expect(within(dialog).getByText('Prepare source').closest('li')).toHaveAttribute('aria-current', 'step')

    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }))
    fireEvent.click(dialog)
    expect(dialog).toHaveAttribute('open')
    expect(within(dialog).getByRole('button', { name: 'Close Move thread' })).toBeDisabled()
    expect(within(dialog).getByRole('radio', { name: /Wait for this turn/ })).toBeDisabled()

    await act(async () => {
      handoff.resolve({ destinationHostId: 'host-local', receiptId: 'handoff_receipt_guarded' })
      await handoff.promise
    })
    const continueThread = await within(dialog).findByRole('button', { name: 'Continue thread' })
    expect(continueThread).toBeEnabled()
    await waitFor(() => expect(continueThread).toHaveFocus())
  })

  it('keeps responsive drawers mutually exclusive when a sidebar command opens the inspector', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    await user.click(screen.getByRole('button', { name: 'Open sidebar' }))
    const sidebar = await screen.findByRole('dialog', { name: 'Projects and threads' })
    await user.click(within(sidebar).getByRole('button', { name: 'Search projects and threads' }))

    const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toHaveAttribute('aria-expanded', 'false')
    await user.click(within(palette).getByRole('option', { name: /Open changes and evidence/ }))

    const inspector = await screen.findByRole('dialog', { name: 'Thread inspector' })
    await waitFor(() => expect(within(inspector).getByRole('tab', { name: 'Changes' })).toHaveFocus())
    expect(document.querySelector('.app-shell')).toHaveAttribute('data-sidebar-open', 'false')
    expect(document.querySelector('.app-shell')).toHaveAttribute('data-inspector-open', 'true')
    expect(screen.queryByRole('dialog', { name: 'Projects and threads' })).not.toBeInTheDocument()
  })

  it('keeps notices in one stable grid row when an offline thread refresh also fails', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    api.selectThread = vi.fn(async () => {
      throw new Error('Host unavailable')
    })

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    await user.click(screen.getByRole('button', { name: /Training runs/ }))
    await screen.findByText(/Couldn’t refresh Benchmark attention kernel. Host unavailable/)

    const threadView = document.querySelector('.thread-view')
    expect(threadView).not.toBeNull()
    expect(Array.from(threadView?.children ?? []).map((element) => element.className)).toEqual([
      'thread-notices',
      'transcript',
      'composer-wrap',
    ])
    expect(threadView?.querySelectorAll('.thread-notices .connection-notice')).toHaveLength(2)
  })

  it('resets companion scroll and focuses each destination heading', async () => {
    window.history.replaceState({}, '', '/?surface=companion')
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Needs you' })

    await user.click(screen.getByRole('button', { name: 'Threads' }))
    const threadsHeading = await screen.findByRole('heading', { name: 'Threads' })
    await waitFor(() => expect(threadsHeading).toHaveFocus())
    await user.click(screen.getByRole('button', { name: /Seamless remote experience/ }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Seamless remote experience' })).toHaveFocus())

    const main = screen.getByRole('main')
    main.scrollTop = 320
    await user.click(screen.getByRole('button', { name: 'Hosts' }))
    const hostsHeading = await screen.findByRole('heading', { name: 'Hosts' })
    await waitFor(() => expect(hostsHeading).toHaveFocus())
    expect(main.scrollTop).toBe(0)
  })

  it('scrolls the command palette active descendant into view during keyboard navigation', async () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    const scrolledOptions: HTMLElement[] = []
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: HTMLElement) {
        scrolledOptions.push(this)
      },
    })

    try {
      const user = userEvent.setup()
      render(<App api={createPreviewRendererApi()} />)
      await screen.findByRole('heading', { name: 'Seamless remote experience' })
      await user.keyboard('{Control>}k{/Control}')
      const input = await screen.findByRole('combobox', { name: 'Search projects, threads, and commands' })
      await waitFor(() => expect(scrolledOptions.length).toBeGreaterThan(0))
      scrolledOptions.length = 0

      await user.keyboard('{ArrowDown}')
      await waitFor(() => expect(scrolledOptions.length).toBeGreaterThan(0))
      const activeId = input.getAttribute('aria-activedescendant')
      expect(activeId).toBeTruthy()
      expect(scrolledOptions[scrolledOptions.length - 1]).toHaveAttribute('id', activeId)
    } finally {
      if (previousDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousDescriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    }
  })

  it('mounts recent transcript activity in bounded increments and preserves the reading anchor', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const loadWorkbench = api.loadWorkbench.bind(api)
    api.loadWorkbench = async () => {
      const snapshot = await loadWorkbench()
      snapshot.threads[0]!.transcript = Array.from({ length: 450 }, (_, index) => ({
        id: `history-${index + 1}`,
        kind: 'assistant' as const,
        author: 'Prime Agent',
        time: 'Now',
        body: `Activity ${index + 1}`,
      }))
      return snapshot
    }

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const transcript = screen.getByRole('region', { name: 'Thread transcript' })
    let scrollTop = 300
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: {
        configurable: true,
        get: () => transcript.querySelectorAll('[data-transcript-block]').length * 10,
      },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value },
      },
    })
    fireEvent.scroll(transcript)

    expect(transcript.querySelectorAll('[data-transcript-block]')).toHaveLength(200)
    expect(within(transcript).queryByText('Activity 250')).not.toBeInTheDocument()
    expect(within(transcript).getByText('Activity 251')).toBeVisible()

    await user.click(within(transcript).getByRole('button', { name: 'Load earlier activity' }))
    expect(transcript.querySelectorAll('[data-transcript-block]')).toHaveLength(400)
    expect(within(transcript).getByText('Activity 51')).toBeVisible()
    expect(scrollTop).toBe(2_300)

    await user.click(within(transcript).getByRole('button', { name: 'Load earlier activity' }))
    expect(transcript.querySelectorAll('[data-transcript-block]')).toHaveLength(450)
    expect(within(transcript).getByText('Activity 1')).toBeVisible()
    expect(within(transcript).getByRole('button', { name: 'All activity loaded' })).toBeDisabled()
  })

  it('follows new transcript messages only near the bottom and resets on thread changes', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const initialSnapshot = await api.loadWorkbench()
    let authoritative = structuredClone(initialSnapshot)
    let publish: ((next: typeof initialSnapshot) => void) | undefined
    const firstSend = deferred<{ state: 'sent'; message: string }>()
    const secondSend = deferred<{ state: 'sent'; message: string }>()
    let sendCount = 0
    api.loadWorkbench = vi.fn(() => Promise.resolve(structuredClone(initialSnapshot)))
    api.subscribe = vi.fn((listener) => {
      publish = listener
      return () => undefined
    })
    api.sendComposer = vi.fn(() => sendCount++ === 0 ? firstSend.promise : secondSend.promise)

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const transcript = screen.getByRole('region', { name: 'Thread transcript' })
    let scrollHeight = 1_000
    let scrollTop = 600
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value },
      },
    })

    fireEvent.scroll(transcript)
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Follow the first response.')
    await user.click(screen.getByRole('button', { name: 'Send when reconnected' }))
    scrollHeight = 1_200
    await act(async () => {
      firstSend.resolve({ state: 'sent', message: 'Sent' })
      await firstSend.promise
    })
    expect(within(transcript).queryByText('Follow the first response.')).not.toBeInTheDocument()
    authoritative = structuredClone(authoritative)
    authoritative.threads.find((thread) => thread.id === authoritative.selectedThreadId)?.transcript.push({
      id: 'authoritative-follow-response',
      kind: 'user',
      author: 'You',
      time: 'Now',
      body: 'Follow the first response.',
    })
    await act(async () => publish?.(authoritative))
    await screen.findByText('Follow the first response.')
    await waitFor(() => expect(scrollTop).toBe(1_200))

    scrollTop = 200
    fireEvent.scroll(transcript)
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Do not steal my reading position.')
    await user.click(screen.getByRole('button', { name: 'Send when reconnected' }))
    scrollHeight = 1_400
    await act(async () => {
      secondSend.resolve({ state: 'sent', message: 'Sent' })
      await secondSend.promise
    })
    expect(within(transcript).queryByText('Do not steal my reading position.')).not.toBeInTheDocument()
    authoritative = structuredClone(authoritative)
    authoritative.threads.find((thread) => thread.id === authoritative.selectedThreadId)?.transcript.push({
      id: 'authoritative-reading-position',
      kind: 'user',
      author: 'You',
      time: 'Now',
      body: 'Do not steal my reading position.',
    })
    const composer = screen.getByRole('textbox', { name: 'Message' })
    composer.focus()
    await act(async () => publish?.(authoritative))
    await screen.findByText('Do not steal my reading position.')
    expect(scrollTop).toBe(200)
    expect(composer).toHaveFocus()

    const jumpToLatest = await screen.findByRole('button', { name: 'New activity · Jump to latest' })
    await user.click(jumpToLatest)
    expect(scrollTop).toBe(1_400)
    expect(screen.queryByRole('button', { name: 'New activity · Jump to latest' })).not.toBeInTheDocument()
    expect(transcript).toHaveFocus()

    scrollHeight = 800
    await user.click(screen.getByRole('button', { name: /Training runs/ }))
    await screen.findByRole('heading', { name: 'Benchmark attention kernel' })
    expect(scrollTop).toBe(800)
  })

  it('continues following same-block streaming growth while the reader stays near the bottom', async () => {
    const api = createPreviewRendererApi()
    const snapshot = await api.loadWorkbench()
    let publish: ((next: typeof snapshot) => void) | undefined
    api.loadWorkbench = vi.fn(() => Promise.resolve(snapshot))
    api.subscribe = vi.fn((listener) => {
      publish = listener
      return () => undefined
    })

    render(<App api={api} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const transcript = screen.getByRole('region', { name: 'Thread transcript' })
    let scrollHeight = 1_000
    let scrollTop = 600
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value },
      },
    })
    fireEvent.scroll(transcript)

    const next = structuredClone(snapshot)
    const selected = next.threads.find((thread) => thread.id === next.selectedThreadId)
    const last = selected?.transcript.at(-1)
    if (!last) throw new Error('Expected a final transcript block')
    last.body = `${last.body} Streaming continuation in the same block.`
    scrollHeight = 1_180
    await act(async () => publish?.(next))

    expect(scrollTop).toBe(1_180)
  })

  it('contains focus in narrow drawers, closes with Escape, and restores each trigger', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    const sidebarToggle = screen.getByRole('button', { name: 'Open sidebar' })
    await user.click(sidebarToggle)
    const sidebar = screen.getByRole('dialog', { name: 'Projects and threads' })
    expect(sidebar).toHaveAttribute('aria-modal', 'true')
    const firstSidebarAction = within(sidebar).getByRole('button', { name: 'Close sidebar' })
    await waitFor(() => expect(firstSidebarAction).toHaveFocus())
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(within(sidebar).getByRole('combobox', { name: /Compact run location/ })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(sidebarToggle).toHaveFocus())
    expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(sidebarToggle)
    const reopenedSidebar = screen.getByRole('dialog', { name: 'Projects and threads' })
    await user.click(within(reopenedSidebar).getByRole('button', { name: 'Close sidebar' }))
    await waitFor(() => expect(sidebarToggle).toHaveFocus())

    const inspectorToggle = screen.getByRole('button', { name: 'Open inspector' })
    await user.click(inspectorToggle)
    expect(screen.getByRole('dialog', { name: 'Thread inspector' })).toHaveAttribute('aria-modal', 'true')
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Changes' })).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(inspectorToggle).toHaveFocus())
    expect(inspectorToggle).toHaveAttribute('aria-expanded', 'false')
  })
})
