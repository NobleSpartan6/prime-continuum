// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import App from '../../src/renderer/src/App'
import { createPreviewRendererApi } from '../../src/renderer/src/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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

describe('Prime Agent renderer', () => {
  it('keeps the durable thread primary while connection and task states remain separate', async () => {
    render(<App api={createPreviewRendererApi()} />)

    expect(await screen.findByRole('heading', { name: 'Seamless remote experience' })).toBeVisible()
    expect(screen.getAllByText('Running').some((element) => element.getClientRects().length > 0 || !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.getAllByText(/Reconnecting… Last synchronized 12 s ago/).some((element) => !element.classList.contains('sr-only'))).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send when reconnected' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send when reconnected' })).toHaveClass('button--empty')
    expect(screen.getByText(/cached transcript is still available/i)).toBeVisible()
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
    expect((await screen.findAllByText(/saved in this device’s outbox/i)).some((element) => !element.classList.contains('sr-only'))).toBe(true)
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

  it('shows Add computer as one keyboard-operable sheet with exact connection and install details', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })
    const trigger = screen.getByRole('button', { name: 'Add computer' })

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
    expect(within(dialog).getByText(/prime-agent bootstrap --host-service/)).toBeVisible()
    expect(within(dialog).getByRole('checkbox', { name: /Install the signed Prime Agent host service/ })).toBeEnabled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(trigger).toHaveFocus())
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

    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'Agent team' })).toBeVisible()
  })

  it('keeps projection-only inspector data non-interactive and reports the real connection state', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    await user.click(screen.getByRole('button', { name: 'Open inspector' }))
    const changesPanel = screen.getByRole('tabpanel', { name: 'Changes' })
    expect(within(changesPanel).queryByRole('button')).not.toBeInTheDocument()
    expect(within(changesPanel).queryByText('App.tsx')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Agents' }))
    expect(within(screen.getByRole('tabpanel', { name: 'Agents' })).queryByRole('button')).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    expect(within(screen.getByRole('tabpanel', { name: 'Evidence' })).queryByRole('button', { name: 'Run checks' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Training runs/ }))
    await user.click(screen.getByRole('tab', { name: 'Context' }))
    const contextPanel = screen.getByRole('tabpanel', { name: 'Context' })
    expect(within(contextPanel).getByText(/Offline · Last synchronized 18 min ago/)).toBeVisible()
    expect(within(contextPanel).queryByText('Running')).not.toBeInTheDocument()
  })

  it('renders controls without backing operations as honestly unavailable', async () => {
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    expect(screen.queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New thread' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Running.*Seamless remote experience/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Search projects and threads' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled()
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
        agentVersion: 'Prime Agent 0.18.4',
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

  it('shows an honest pairing gate and a sample, read-only Companion Preview with stable focus', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    await user.click(screen.getByRole('button', { name: 'Mobile' }))
    const dialog = await screen.findByRole('dialog', { name: 'Mobile companion' })
    expect(within(dialog).getByRole('heading', { name: 'Phone control is not ready yet' })).toBeVisible()
    expect(within(dialog).getByText(/Remote control stays off until encrypted pairing/i)).toBeVisible()
    expect(within(dialog).queryByText('Per-device permissions')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('relay_pairing_v1')).not.toBeInTheDocument()
    expect(within(dialog).getByText('Browser preview · sample data')).toBeVisible()
    expect(within(dialog).queryByRole('button', { name: 'Start pairing' })).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Open companion preview' }))
    expect(await screen.findByText('Prime Companion')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Needs you' })).toHaveFocus())
    expect(screen.getByText('Browser preview · sample data')).toBeVisible()
    expect(screen.getByRole('note')).toHaveTextContent(/Preview only.*Secure mobile relay is not available/i)
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mobile' })).toHaveFocus())
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

    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }))
    fireEvent.click(dialog)
    expect(dialog).toHaveAttribute('open')
    expect(within(dialog).getByRole('button', { name: 'Close Move thread' })).toBeDisabled()
    expect(within(dialog).getByRole('radio', { name: /Wait for this turn/ })).toBeDisabled()

    await act(async () => {
      handoff.resolve({ destinationHostId: 'host-local', receiptId: 'handoff_receipt_guarded' })
      await handoff.promise
    })
    expect(await within(dialog).findByRole('button', { name: 'Continue thread' })).toBeEnabled()
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
      'thread-header',
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

  it('follows new transcript messages only near the bottom and resets on thread changes', async () => {
    const user = userEvent.setup()
    const api = createPreviewRendererApi()
    const firstSend = deferred<{ state: 'sent'; message: string }>()
    const secondSend = deferred<{ state: 'sent'; message: string }>()
    let sendCount = 0
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
    await screen.findByText('Follow the first response.')
    expect(scrollTop).toBe(1_200)

    scrollTop = 200
    fireEvent.scroll(transcript)
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Do not steal my reading position.')
    await user.click(screen.getByRole('button', { name: 'Send when reconnected' }))
    scrollHeight = 1_400
    await act(async () => {
      secondSend.resolve({ state: 'sent', message: 'Sent' })
      await secondSend.promise
    })
    await screen.findByText('Do not steal my reading position.')
    expect(scrollTop).toBe(200)

    scrollHeight = 800
    await user.click(screen.getByRole('button', { name: /Training runs/ }))
    await screen.findByRole('heading', { name: 'Benchmark attention kernel' })
    expect(scrollTop).toBe(800)
  })

  it('contains focus in narrow drawers, closes with Escape, and restores each trigger', async () => {
    const user = userEvent.setup()
    render(<App api={createPreviewRendererApi()} />)
    await screen.findByRole('heading', { name: 'Seamless remote experience' })

    const sidebarToggle = screen.getByRole('button', { name: 'Open sidebar' })
    await user.click(sidebarToggle)
    const sidebar = screen.getByRole('dialog', { name: 'Projects and threads' })
    expect(sidebar).toHaveAttribute('aria-modal', 'true')
    const firstSidebarAction = within(sidebar).getByRole('button', { name: 'Search projects and threads' })
    await waitFor(() => expect(firstSidebarAction).toHaveFocus())
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(within(sidebar).getByRole('combobox', { name: /Compact run location/ })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(sidebarToggle).toHaveFocus())
    expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false')

    const inspectorToggle = screen.getByRole('button', { name: 'Open inspector' })
    await user.click(inspectorToggle)
    expect(screen.getByRole('dialog', { name: 'Thread inspector' })).toHaveAttribute('aria-modal', 'true')
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Changes' })).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(inspectorToggle).toHaveFocus())
    expect(inspectorToggle).toHaveAttribute('aria-expanded', 'false')
  })
})
