import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { isInternalVisualQaRequest } from './preview-bootstrap'
import RendererErrorBoundary from './RendererErrorBoundary'
import { isNativeBridgeUnavailable } from './runtime'
import './styles.css'

const NativeApp = lazy(() => import('./App'))
const PreviewApp = lazy(() => import('./PreviewApp'))

function WorkbenchBootFallback({ surface }: { surface: 'workbench' | 'hud' }) {
  if (surface === 'hud') {
    return (
      <main className="hud-startup" role="status" aria-label="Opening Prime Continuim">
        <span aria-hidden="true">∞</span>
      </main>
    )
  }
  return (
    <main className="workbench-startup" role="status" aria-label="Opening resident workbench">
      <header className="workbench-startup__bar">
        <span className="workbench-startup__brand" aria-hidden="true">∞</span>
        <strong>Prime Continuim</strong>
      </header>
      <section className="workbench-startup__body">
        <span className="workbench-startup__mark" aria-hidden="true">∞</span>
        <h1>Opening your workbench</h1>
        <p>Agent state stays safely in the local service.</p>
      </section>
    </main>
  )
}

const root = document.getElementById('root')

if (!root) {
  throw new Error('Prime Continuim could not find the renderer root.')
}

const nativeBridgeUnavailable = isNativeBridgeUnavailable(
  window.navigator.userAgent,
  Boolean(Reflect.get(window, 'prime')),
)
const surface = new URLSearchParams(window.location.search).get('surface') === 'hud' ? 'hud' : 'workbench'
const internalVisualQa = isInternalVisualQaRequest({
  protocol: window.location.protocol,
  hostname: window.location.hostname,
  userAgent: window.navigator.userAgent,
  search: window.location.search,
})
document.documentElement.dataset.surface = surface
document.body.dataset.surface = surface

const content = nativeBridgeUnavailable ? (
  <main className="startup-failure">
    <section className="startup-failure__panel" role="alert" aria-labelledby="startup-failure-title">
      <span className="startup-failure__status" aria-hidden="true" />
      <p className="startup-failure__eyebrow">Prime Continuim</p>
      <h1 id="startup-failure-title">The desktop connection didn’t start</h1>
      <p>
        Prime Continuim stopped before showing workspace data because its secure native bridge did not load. Restart the
        app. If this continues, reinstall this build.
      </p>
      <code>PRELOAD_UNAVAILABLE</code>
    </section>
  </main>
) : (
  internalVisualQa ? (
    <Suspense fallback={<main className="startup-failure" role="status">Loading the internal visual fixture…</main>}>
      <PreviewApp />
    </Suspense>
  ) : (
    <Suspense fallback={<WorkbenchBootFallback surface={surface} />}>
      <NativeApp surface={surface} />
    </Suspense>
  )
)

createRoot(root).render(
  <StrictMode>
    <RendererErrorBoundary>{content}</RendererErrorBoundary>
  </StrictMode>,
)
