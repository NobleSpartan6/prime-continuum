import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { isNativeBridgeUnavailable } from './runtime'
import './styles.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Prime Continuim could not find the renderer root.')
}

const nativeBridgeUnavailable = isNativeBridgeUnavailable(
  window.navigator.userAgent,
  Boolean(Reflect.get(window, 'prime')),
)
const surface = new URLSearchParams(window.location.search).get('surface') === 'hud' ? 'hud' : 'workbench'
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
  <App surface={surface} />
)

createRoot(root).render(
  <StrictMode>
    {content}
  </StrictMode>,
)
