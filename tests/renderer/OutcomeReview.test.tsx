// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { OutcomeReview } from '../../src/renderer/src/OutcomeReview'
import type { AgentSummary, EvidenceSummary } from '../../src/renderer/src/api'

afterEach(cleanup)

const evidence: EvidenceSummary[] = [
  { id: 'typecheck', label: 'Typecheck', detail: 'Exact workspace command passed', status: 'passed', duration: '18s' },
  { id: 'visual', label: 'Visual review', detail: 'Native window review remains open', status: 'running' },
]

const childAgents: AgentSummary[] = [
  {
    id: 'interface-audit',
    name: 'Long delegated prompt',
    sessionName: 'Interface audit',
    role: 'Design review',
    status: 'complete',
    hostName: 'This computer',
    answerPreview: 'Removed the duplicate state rail.',
  },
  {
    id: 'runtime-audit',
    name: 'Runtime audit',
    role: 'Runtime review',
    status: 'failed',
    hostName: 'This computer',
    error: 'Provider access expired before the live check.',
  },
]

describe('OutcomeReview', () => {
  it('renders a compact completed outcome with exact facts, proof, and branch returns', () => {
    render(
      <OutcomeReview
        state="complete"
        objective="Ship a reliable outcome review"
        result="The exact resident generation completed and passed its local checks."
        evidence={evidence}
        childAgents={childAgents}
        changedFileCount={9}
        tokensUsed={12_400}
        timeUsedSeconds={125}
        proofScope="current_snapshot"
      />,
    )

    const review = screen.getByRole('region', { name: 'Ship a reliable outcome review' })
    expect(review).toHaveAttribute('data-outcome-state', 'complete')
    expect(within(review).getByText('Complete')).toBeVisible()
    expect(within(review).getByText('The exact resident generation completed and passed its local checks.')).toBeVisible()
    expect(within(review).getByText('Current snapshot proof')).toBeVisible()

    const facts = review.querySelector('.outcome-review__facts')!
    expect(within(facts).getByText('9')).toBeVisible()
    expect(within(facts).getAllByText('1/2')).toHaveLength(2)
    expect(within(facts).getByText('12K tokens · 2m 5s')).toBeVisible()

    const verification = within(review).getByRole('list', { name: 'Verification evidence' })
    expect(within(verification).getAllByRole('listitem')).toHaveLength(2)
    expect(within(verification).getByText('Typecheck')).toBeVisible()

    const branches = within(review).getByRole('list', { name: 'RLM child outcomes' })
    expect(within(branches).getByText('Interface audit')).toBeVisible()
    expect(within(branches).getByText('Removed the duplicate state rail.')).toBeVisible()
    expect(within(branches).getByText('Provider access expired before the live check.')).toBeVisible()
  })

  it('uses quiet aggregate facts for authoritative empty collections', () => {
    render(
      <OutcomeReview
        state="ready"
        result="Inspection completed."
        evidence={[]}
        childAgents={[]}
        changedFileCount={0}
      />,
    )

    const review = screen.getByRole('region', { name: 'Latest result' })
    expect(within(review).getByText('Ready to review')).toBeVisible()
    expect(within(review).getAllByText('0/0')).toHaveLength(2)
    expect(within(review).queryByText(/wasn’t reported|No checks|No file changes/)).not.toBeInTheDocument()
    expect(within(review).queryByRole('list')).not.toBeInTheDocument()
  })

  it('keeps active and missing outcome evidence explicit without fabricating completion', () => {
    const { rerender } = render(<OutcomeReview state="working" />)

    let review = screen.getByRole('region', { name: 'Latest result' })
    expect(review).toHaveAttribute('data-outcome-state', 'working')
    expect(within(review).getByText('Prime Agent is still working.')).toBeVisible()
    expect(within(review).getAllByText('—')).toHaveLength(4)

    rerender(<OutcomeReview state="unknown" />)
    review = screen.getByRole('region', { name: 'Latest result' })
    expect(within(review).getByText('Not reported')).toBeVisible()
    expect(within(review).getByText('No written result yet.')).toBeVisible()
    expect(review.querySelectorAll('.outcome-review__rail, .outcome-review__card')).toHaveLength(0)
  })

  it('preserves structured long results behind an explicit full-result disclosure', async () => {
    const longResult = [
      '## What changed',
      '',
      '- Preserved the exact resident authority.',
      '- Removed duplicate status language.',
      '- Kept the RLM branch result visible.',
      '- Bound Review to the exact snapshot.',
      '- Left provider setup local to the host.',
      '- Added a durable verification receipt.',
      '',
      '`pnpm typecheck` passed for the current candidate.',
      '',
      '[Open the full verification receipt](https://example.com/receipt)',
    ].join('\n')

    render(<OutcomeReview state="ready" result={longResult} />)

    const review = screen.getByRole('region', { name: 'Latest result' })
    expect(await within(review).findAllByRole('heading', { name: 'What changed' })).toHaveLength(1)
    expect(within(review).queryByText('Open the full verification receipt')).not.toBeInTheDocument()
    const disclosure = within(review).getByText('View full result').closest('details')
    expect(disclosure).not.toHaveAttribute('open')

    fireEvent.click(within(review).getByText('View full result'))
    expect(disclosure).toHaveAttribute('open')
    expect(within(review).getAllByRole('heading', { name: 'What changed' })).toHaveLength(1)
    expect(within(disclosure as HTMLElement).getByText('pnpm typecheck')).toBeVisible()
    expect(within(disclosure as HTMLElement).getByText('Open the full verification receipt')).toBeVisible()

    fireEvent.click(within(review).getByText('Hide full result'))
    expect(disclosure).not.toHaveAttribute('open')
    expect(within(review).getAllByRole('heading', { name: 'What changed' })).toHaveLength(1)
    expect(within(review).queryByText('Open the full verification receipt')).not.toBeInTheDocument()
  })
})
