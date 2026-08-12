// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { RlmDelegationPanel } from '../../src/renderer/src/RlmDelegationPanel'
import type { AgentSummary } from '../../src/renderer/src/api'

afterEach(cleanup)

const root = {
  rootAvailable: true,
  rootActive: true,
  rootLabel: 'Delegating',
  rootDetail: 'review is working in a child session',
  rootModel: 'openai-codex/gpt-5.6-sol',
  rootThinkingLevel: 'high',
}

describe('RlmDelegationPanel', () => {
  it('renders retained child work as a real nested hierarchy without connector rails', () => {
    const agents: AgentSummary[] = [
      {
        id: 'lead',
        name: 'Long task prompt that should not become the title',
        sessionName: 'Review lead',
        role: 'Coordinator',
        status: 'running',
        hostName: 'This computer',
        activity: 'Splitting independent checks',
      },
      {
        id: 'child',
        parentId: 'lead',
        name: 'Accessibility review',
        role: 'Interface audit',
        status: 'complete',
        hostName: 'This computer',
        answerPreview: 'No keyboard blockers found.',
        repliedSinceTask: true,
        toolUseCount: 2,
      },
      {
        id: 'grandchild',
        parentId: 'child',
        name: 'Focus audit',
        role: 'Focus order',
        status: 'waiting',
        hostName: 'This computer',
      },
    ]

    const { container } = render(
      <RlmDelegationPanel agents={agents} agentsReported isFresh {...root} />,
    )

    const lead = screen.getByText('Review lead').closest('[data-runtime-agent]')
    const child = screen.getByText('Accessibility review').closest('[data-runtime-agent]')
    const grandchild = screen.getByText('Focus audit').closest('[data-runtime-agent]')
    expect(lead).toContainElement(child)
    expect(child).toContainElement(grandchild)
    expect(lead).toHaveAttribute('data-rlm-depth', '0')
    expect(child).toHaveAttribute('data-rlm-depth', '1')
    expect(grandchild).toHaveAttribute('data-rlm-depth', '2')
    expect(child).toHaveAttribute('data-rlm-parent', 'lead')
    expect(within(child as HTMLElement).getByText('Branch of Review lead')).toBeVisible()
    expect(screen.getByText('GPT-5.6 Sol · high thinking')).toBeVisible()
    expect(container.querySelector('.rlm-map__connector')).not.toBeInTheDocument()
    expect(within(screen.getByLabelText('RLM activity summary')).getByText('2')).toBeVisible()
    expect(within(screen.getByLabelText('RLM activity summary')).getByText('1')).toBeVisible()
    expect(screen.getByText('View result')).toBeVisible()
  })

  it('keeps malformed cyclic retained agents visible once instead of recursing forever', () => {
    const agents: AgentSummary[] = [
      { id: 'a', parentId: 'b', name: 'Agent A', role: 'Audit A', status: 'waiting', hostName: 'Host' },
      { id: 'b', parentId: 'a', name: 'Agent B', role: 'Audit B', status: 'waiting', hostName: 'Host' },
    ]

    render(<RlmDelegationPanel agents={agents} agentsReported isFresh {...root} />)

    expect(screen.getAllByText('Agent A')).toHaveLength(1)
    expect(screen.getAllByText('Agent B')).toHaveLength(1)
    expect(document.querySelectorAll('[data-runtime-agent]')).toHaveLength(2)
  })
})
