import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'

import type { TranscriptBodyProps } from './TranscriptBody'

const safeMarkdownElements = [
  'a',
  'blockquote',
  'br',
  'code',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'ul',
]

const markdownComponents: Components = {
  a({ children, href }) {
    if (!href) return <span>{children}</span>

    return (
      <span className="transcript-body__link">
        <span className="transcript-body__link-label">{children}</span>
        <span aria-hidden="true"> · </span>
        <span className="transcript-body__link-target">{href}</span>
      </span>
    )
  },
  code({ children, className, node: _node, ...props }) {
    if (className?.split(' ').includes('language-diff')) {
      const lines = String(children).split('\n')

      return (
        <code {...props} className={className}>
          {lines.map((line, index) => {
            const tone = line.startsWith('+') && !line.startsWith('+++')
              ? 'addition'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'deletion'
                : line.startsWith('@@')
                  ? 'context'
                  : 'neutral'

            return (
              <span className={`transcript-body__diff-line transcript-body__diff-line--${tone}`} key={`${index}:${line}`}>
                {line}
                {index < lines.length - 1 ? '\n' : null}
              </span>
            )
          })}
        </code>
      )
    }

    return <code {...props} className={className}>{children}</code>
  },
}

function safeUrlTransform(url: string): string {
  return defaultUrlTransform(url)
}

export default function MarkdownTranscriptBody({ body, kind }: TranscriptBodyProps) {
  return (
    <div className="transcript-body transcript-body--prose" data-transcript-body-kind={kind}>
      <ReactMarkdown
        allowedElements={safeMarkdownElements}
        components={markdownComponents}
        skipHtml
        urlTransform={safeUrlTransform}
      >
        {body}
      </ReactMarkdown>
    </div>
  )
}
