const { access, mkdir, readFile, writeFile } = require('node:fs/promises')
const { createServer } = require('node:http')
const { extname, join, relative, resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { app, BrowserWindow } = require('electron')

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

async function waitForSurface(browserWindow, surface) {
  const selector = surface === 'companion' ? '.companion-shell' : '.app-shell'
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
    await waitForSurface(browserWindow, target.surface)
    const selector = target.surface === 'companion' ? '.companion-shell' : '.app-shell'
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
      return {
        expectedTextPresent: document.body.innerText.includes(${JSON.stringify(target.expectedText)}),
        compactComposer: Boolean(document.querySelector('.composer--compact')),
        composerStatusVisible: Boolean(status && statusStyle && statusStyle.display !== 'none' && status.getBoundingClientRect().height > 0),
        attentionTitleLineClamp: attentionStyle?.webkitLineClamp,
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
