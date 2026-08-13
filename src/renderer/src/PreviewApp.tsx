import { useMemo } from 'react'

import App from './App'
import { createPreviewRendererApi, previewVisualStateFromSearch } from './api.preview'

export default function PreviewApp() {
  const api = useMemo(
    () => createPreviewRendererApi(previewVisualStateFromSearch(window.location.search)),
    [],
  )
  const surface = new URLSearchParams(window.location.search).get('surface') === 'hud' ? 'hud' : 'workbench'

  return <App api={api} surface={surface} />
}
