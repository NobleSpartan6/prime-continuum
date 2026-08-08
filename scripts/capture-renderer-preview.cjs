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
const targets = [
  {
    name: 'desktop-idle',
    width: 1600,
    height: 1000,
    visualState: 'idle',
    expectedText: 'Ready for a new prompt',
  },
  {
    name: 'desktop-prompt-admission',
    width: 1200,
    height: 800,
    visualState: 'prompt-admission',
    expectedText: 'Host received the prompt · awaiting durable admission',
    expectStatusVisible: true,
  },
  {
    name: 'desktop-prompt-proof-390',
    width: 390,
    height: 844,
    visualState: 'prompt-awaiting-idle-proof',
    expectedText: 'Prime Agent owns this prompt · waiting for authoritative idle proof',
    expectStatusVisible: true,
    expectCompactStatus: true,
  },
  {
    name: 'desktop-stop-proof-390',
    width: 390,
    height: 844,
    visualState: 'stop-awaiting-idle-proof',
    expectedText: 'Stop accepted · waiting for authoritative idle proof',
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
    name: 'resident-start-1600',
    width: 1600,
    height: 1000,
    visualState: 'resident-start',
    expectedText: 'Choose workspace folder',
  },
  {
    name: 'resident-dialog-390',
    width: 390,
    height: 844,
    visualState: 'resident-start',
    expectedText: 'Start resident thread',
    openResidentDialog: true,
  },
  {
    name: 'resident-dialog-short-320',
    width: 320,
    height: 256,
    visualState: 'resident-start',
    expectedText: 'Start resident thread',
    openResidentDialog: true,
    expectShortResidentDialog: true,
  },
  {
    name: 'resident-recovery-320',
    width: 320,
    height: 704,
    visualState: 'resident-recovery',
    expectedText: 'Workspace confirmation needed',
  },
  {
    name: 'resident-recovery-short-320',
    width: 320,
    height: 256,
    visualState: 'resident-recovery',
    expectedText: 'Workspace confirmation needed',
    expectScrollableEmpty: true,
  },
  {
    name: 'companion-attention-390',
    width: 390,
    height: 844,
    surface: 'companion',
    visualState: 'nonretryable-uncertainty',
    expectedText: 'Outcome unknown · recovery required; this Stop will not be replayed',
  },
  {
    name: 'companion-attention-320',
    width: 320,
    height: 704,
    surface: 'companion',
    visualState: 'nonretryable-uncertainty',
    expectedText: 'Outcome unknown · recovery required; this Stop will not be replayed',
  },
]

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitForSurface(browserWindow, target) {
  const selector = target.surface === 'companion'
    ? '.companion-shell'
    : target.visualState === 'resident-start' || target.visualState === 'resident-recovery'
      ? '.empty-workbench'
      : '.app-shell'
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const found = await browserWindow.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    )
    if (found) {
      await delay(75)
      return
    }
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${selector}`)
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
    backgroundColor: '#0b0d0f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  try {
    browserWindow.setContentSize(target.width, target.height, false)
    browserWindow.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 PrimeContinuimVisualQA/1',
    )
    const rendererUrl = new URL('/', rendererOrigin)
    if (target.surface) rendererUrl.searchParams.set('surface', target.surface)
    if (target.visualState) rendererUrl.searchParams.set('visualState', target.visualState)
    await browserWindow.loadURL(rendererUrl.href)
    await waitForSurface(browserWindow, target)
    if (target.openResidentDialog) {
      // Chromium does not composite top-layer dialogs into capturePage() for
      // a never-shown window. Show it inactive and far outside every normal
      // desktop work area so the modal renders without stealing user focus.
      browserWindow.setPosition(-10_000, -10_000, false)
      browserWindow.showInactive()
      await browserWindow.webContents.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((candidate) => candidate.textContent?.includes('Choose workspace folder'))
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
    const selector = target.surface === 'companion'
      ? '.companion-shell'
      : target.visualState === 'resident-start' || target.visualState === 'resident-recovery'
        ? '.empty-workbench'
        : '.app-shell'
    const layout = await browserWindow.webContents.executeJavaScript(`({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      surfaceClientWidth: document.querySelector(${JSON.stringify(selector)})?.clientWidth,
      surfaceScrollWidth: document.querySelector(${JSON.stringify(selector)})?.scrollWidth,
    })`)
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
      const firstAttentionTitle = document.querySelector('.companion-card-list strong')
      const attentionStyle = firstAttentionTitle ? window.getComputedStyle(firstAttentionTitle) : undefined
      const residentDialog = document.querySelector('dialog[aria-labelledby="resident-provision-title"]')
      const residentDialogStyle = residentDialog ? window.getComputedStyle(residentDialog) : undefined
      const residentDialogRect = residentDialog?.getBoundingClientRect()
      const residentDialogScroll = residentDialog?.querySelector('.sheet__scroll')
      const residentDialogScrollStyle = residentDialogScroll ? window.getComputedStyle(residentDialogScroll) : undefined
      const residentDialogFooter = residentDialog?.querySelector('.sheet__footer')
      const residentDialogFooterRect = residentDialogFooter?.getBoundingClientRect()
      const emptyMain = document.querySelector('.empty-workbench__main')
      const emptyMainStyle = emptyMain ? window.getComputedStyle(emptyMain) : undefined
      return {
        expectedTextPresent: document.body.innerText.includes(${JSON.stringify(target.expectedText)}),
        compactComposer: Boolean(document.querySelector('.composer--compact')),
        composerStatusVisible: Boolean(status && statusStyle && statusStyle.display !== 'none' && status.getBoundingClientRect().height > 0),
        attentionTitleLineClamp: attentionStyle?.webkitLineClamp,
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
        residentDialogContentReachable: Boolean(
          residentDialogScroll &&
          residentDialogScrollStyle &&
          (residentDialogScrollStyle.overflowY === 'auto' || residentDialogScrollStyle.overflowY === 'scroll') &&
          residentDialogScroll.clientHeight >= 64 &&
          residentDialogFooterRect &&
          residentDialogFooterRect.height > 0 &&
          residentDialogFooterRect.bottom <= window.innerHeight
        ),
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
      }
    })()`)
    invariant(stateEvidence.expectedTextPresent, `${target.name} did not render its expected resident-state copy`)
    if (target.expectStatusVisible || target.expectCompactStatus) {
      invariant(stateEvidence.composerStatusVisible, `${target.name} hid its resident-state copy`)
    }
    if (target.expectCompactStatus) {
      invariant(stateEvidence.compactComposer, `${target.name} did not render the compact resident composer`)
    }
    if (target.surface === 'companion') {
      invariant(stateEvidence.attentionTitleLineClamp === '2', `${target.name} did not preserve two-line Attention titles`)
    }
    if (target.openResidentDialog) {
      invariant(stateEvidence.residentDialogOpen, `${target.name} did not open the resident setup dialog`)
    }
    if (target.expectShortResidentDialog) {
      invariant(stateEvidence.residentDialogContentReachable, `${target.name} did not keep the resident form and actions reachable`)
    }
    if (target.expectScrollableEmpty) {
      invariant(
        stateEvidence.emptyMainScrollable,
        `${target.name} did not preserve vertical access to resident recovery controls: ${JSON.stringify(stateEvidence)}`,
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
    for (const target of targets) results.push(await capture(target, rendererServer.origin))
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
