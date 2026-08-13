import { lazy, memo, Suspense, type ComponentType } from 'react'

import type { TranscriptBlock } from './api'

type TranscriptBodyKind = TranscriptBlock['kind']

export interface TranscriptBodyProps {
  body: string
  kind: TranscriptBodyKind
}

function PlainTranscriptBody({ body, kind, pending = false }: TranscriptBodyProps & { pending?: boolean }) {
  return (
    <div
      className={`transcript-body transcript-body--prose${pending ? ' transcript-body--loading' : ''}`}
      data-transcript-body-kind={kind}
      data-transcript-renderer={pending ? 'loading' : 'plain'}
    >
      <p>{body}</p>
    </div>
  )
}

export async function loadMarkdownTranscriptBody(
  loader: () => Promise<{ default: ComponentType<TranscriptBodyProps> }> = () => import('./MarkdownTranscriptBody'),
): Promise<{ default: ComponentType<TranscriptBodyProps> }> {
  try {
    return await loader()
  } catch {
    // Keep durable host text readable if a packaged renderer chunk is missing or
    // corrupt. React still escapes this plain fallback, so it cannot add markup.
    return { default: PlainTranscriptBody }
  }
}

const MarkdownTranscriptBody = lazy(loadMarkdownTranscriptBody)

/**
 * The sole renderer for host-projected transcript bodies. Raw HTML is deliberately
 * disabled: host content can describe markup, but it can never add markup to the UI.
 */
export const TranscriptBody = memo(function TranscriptBody({ body, kind }: TranscriptBodyProps) {
  if (kind === 'tool') {
    return (
      <div className="transcript-body transcript-body--tool" data-transcript-body-kind="tool">
        <pre>
          <code>{body}</code>
        </pre>
      </div>
    )
  }

  return (
    <Suspense
      fallback={<PlainTranscriptBody body={body} kind={kind} pending />}
    >
      <MarkdownTranscriptBody body={body} kind={kind} />
    </Suspense>
  )
})
