import {
  AlertCircle,
  Check,
  CheckCircle2,
  CircleHelp,
  CircleX,
  Clock3,
  type LucideIcon,
} from 'lucide-react'
import { memo, useId, useMemo, useState, type CSSProperties } from 'react'

import type { AgentSummary, EvidenceSummary } from './api'
import { TranscriptBody } from './TranscriptBody'

export type OutcomeReviewState = 'working' | 'ready' | 'complete' | 'needs_review' | 'unknown'

export interface OutcomeReviewProps {
  objective?: string
  result?: string
  state: OutcomeReviewState
  /** Undefined means verification was not reported; an empty array is authoritative. */
  evidence?: readonly EvidenceSummary[]
  /** Undefined means child outcomes were not reported; an empty array is authoritative. */
  childAgents?: readonly AgentSummary[]
  /** Aggregate from the exact thread snapshot. File names are intentionally not inferred. */
  changedFileCount?: number
  tokensUsed?: number
  timeUsedSeconds?: number
  /** Exact snapshot freshness. Omitted only for non-native previews. */
  snapshotSource?: 'live' | 'cached'
  /** Aggregate facts belong to the exact current snapshot, not the turn receipt. */
  proofScope?: 'current_snapshot'
}

const OUTCOME_STATE: Record<OutcomeReviewState, { icon: LucideIcon; label: string }> = {
  working: { icon: Clock3, label: 'Working' },
  ready: { icon: Check, label: 'Ready to review' },
  complete: { icon: CheckCircle2, label: 'Complete' },
  needs_review: { icon: AlertCircle, label: 'Needs review' },
  unknown: { icon: CircleHelp, label: 'Not reported' },
}
const NUMBER_FORMATTER = new Intl.NumberFormat()
const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat(undefined, { notation: 'compact' })
const RESULT_DISCLOSURE_CHARACTER_THRESHOLD = 420
const RESULT_DISCLOSURE_LINE_THRESHOLD = 6
const MAX_BRANCH_RETURN_VISUAL_DEPTH = 4

interface BranchReturn {
  agent: AgentSummary
  depth: number
  parent?: AgentSummary
  result: string
}

function Icon({ icon: IconComponent, size = 15 }: { icon: LucideIcon; size?: number }) {
  return <IconComponent aria-hidden="true" focusable="false" size={size} strokeWidth={1.75} />
}

function evidenceIcon(status: EvidenceSummary['status']): LucideIcon {
  if (status === 'passed') return Check
  if (status === 'running') return Clock3
  return AlertCircle
}

function agentIcon(status: AgentSummary['status']): LucideIcon {
  if (status === 'complete') return Check
  if (status === 'failed') return CircleX
  if (status === 'cancelled') return AlertCircle
  return Clock3
}

function agentDisplayName(agent: AgentSummary): string {
  return agent.sessionName?.trim() || agent.name
}

function agentResult(agent: AgentSummary): string | undefined {
  return agent.answerPreview?.trim() || agent.recap?.trim() || agent.error?.trim() || undefined
}

function agentStateLabel(status: AgentSummary['status']): string {
  if (status === 'complete') return 'Returned'
  if (status === 'failed') return 'Failed'
  if (status === 'cancelled') return 'Cancelled'
  if (status === 'running') return 'Running'
  if (status === 'waiting') return 'Waiting'
  if (status === 'queued') return 'Queued'
  return 'Pending'
}

function orderedBranchReturns(agents: readonly AgentSummary[] | undefined): BranchReturn[] {
  if (!agents) return []

  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const children = new Map<string, AgentSummary[]>()
  const roots: AgentSummary[] = []

  for (const agent of agents) {
    if (agent.parentId && agent.parentId !== agent.id && byId.has(agent.parentId)) {
      const siblings = children.get(agent.parentId) ?? []
      siblings.push(agent)
      children.set(agent.parentId, siblings)
    } else {
      roots.push(agent)
    }
  }

  const rows: BranchReturn[] = []
  const visited = new Set<string>()
  const visit = (agent: AgentSummary, depth: number, parent?: AgentSummary): void => {
    if (visited.has(agent.id)) return
    visited.add(agent.id)
    const result = agentResult(agent)
    if (result) rows.push({ agent, depth, parent, result })
    children.get(agent.id)?.forEach((child) => visit(child, depth + 1, agent))
  }

  roots.forEach((agent) => visit(agent, 0))
  // Malformed cyclic relationships have no root. Preserve their evidence once
  // in first-seen order while the visited set keeps traversal bounded.
  agents.forEach((agent) => visit(agent, 0))
  return rows
}

function compactCount(value: number): string {
  return (value >= 10_000 ? COMPACT_NUMBER_FORMATTER : NUMBER_FORMATTER).format(value)
}

function compactDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const minuteRemainder = minutes % 60
  return minuteRemainder > 0 ? `${hours}h ${minuteRemainder}m` : `${hours}h`
}

function resultNeedsDisclosure(result: string): boolean {
  return (
    result.length > RESULT_DISCLOSURE_CHARACTER_THRESHOLD ||
    result.split('\n').length > RESULT_DISCLOSURE_LINE_THRESHOLD
  )
}

function resultPreview(result: string): string {
  const lineBounded = result
    .split('\n')
    .slice(0, RESULT_DISCLOSURE_LINE_THRESHOLD)
    .join('\n')
  const characterBounded = lineBounded.length > RESULT_DISCLOSURE_CHARACTER_THRESHOLD
    ? lineBounded.slice(0, RESULT_DISCLOSURE_CHARACTER_THRESHOLD)
    : lineBounded
  return `${characterBounded.trimEnd()}\n\n…`
}

export const OutcomeReview = memo(function OutcomeReview({
  objective,
  result,
  state,
  evidence,
  childAgents,
  changedFileCount,
  tokensUsed,
  timeUsedSeconds,
  snapshotSource,
  proofScope,
}: OutcomeReviewProps) {
  const headingId = useId()
  const [fullResultOpen, setFullResultOpen] = useState(false)
  const stateMeta = OUTCOME_STATE[state]
  const passedChecks = evidence?.filter((item) => item.status === 'passed').length
  const returnedBranches = childAgents?.filter((agent) => agent.status === 'complete').length
  const branchReturns = useMemo(() => orderedBranchReturns(childAgents), [childAgents])
  const writtenResult = result?.trim()
  const resultIsLong = writtenResult ? resultNeedsDisclosure(writtenResult) : false

  return (
    <section className="outcome-review" aria-labelledby={headingId} data-outcome-state={state}>
      <header className="outcome-review__header">
        <div className="outcome-review__heading">
          <span className="outcome-review__eyebrow">Outcome</span>
          <h2 id={headingId}>{objective?.trim() || 'Latest result'}</h2>
        </div>
        <span className={`outcome-review__state outcome-review__state--${state}`}>
          <Icon icon={stateMeta.icon} />
          {snapshotSource === 'cached' ? `Last reported · ${stateMeta.label}` : stateMeta.label}
        </span>
      </header>

      {writtenResult && (!resultIsLong || !fullResultOpen) ? (
        <div className="outcome-review__result">
          <TranscriptBody body={resultIsLong ? resultPreview(writtenResult) : writtenResult} kind="assistant" />
        </div>
      ) : !writtenResult ? (
        <p className="outcome-review__result outcome-review__result--empty">
          {state === 'working' ? 'Prime Agent is still working.' : 'No written result yet.'}
        </p>
      ) : null}
      {writtenResult && resultIsLong ? (
        <details
          className="outcome-review__result-disclosure"
          open={fullResultOpen}
        >
          <summary
            onClick={(event) => {
              event.preventDefault()
              setFullResultOpen((open) => !open)
            }}
          >
            {fullResultOpen ? 'Hide full result' : 'View full result'}
          </summary>
          {fullResultOpen ? (
            <div className="outcome-review__result-full">
              <TranscriptBody body={writtenResult} kind="assistant" />
            </div>
          ) : null}
        </details>
      ) : null}

      {proofScope === 'current_snapshot' ? (
        <p className="outcome-review__proof-scope">Current snapshot proof</p>
      ) : null}
      <dl className="outcome-review__facts" aria-label={proofScope === 'current_snapshot' ? 'Current snapshot proof facts' : 'Outcome facts'}>
        <div>
          <dt>Changes</dt>
          <dd>{changedFileCount === undefined ? '—' : compactCount(changedFileCount)}</dd>
        </div>
        <div>
          <dt>Checks</dt>
          <dd>{evidence === undefined ? '—' : `${passedChecks}/${evidence.length}`}</dd>
        </div>
        <div>
          <dt>Branches</dt>
          <dd>{childAgents === undefined ? '—' : `${returnedBranches}/${childAgents.length}`}</dd>
        </div>
        <div>
          <dt>Usage</dt>
          <dd>
            {tokensUsed === undefined && timeUsedSeconds === undefined
              ? '—'
              : [
                  tokensUsed === undefined ? undefined : `${compactCount(tokensUsed)} tokens`,
                  timeUsedSeconds === undefined ? undefined : compactDuration(timeUsedSeconds),
                ].filter(Boolean).join(' · ')}
          </dd>
        </div>
      </dl>

      {evidence && evidence.length > 0 ? (
        <section className="outcome-review__section" aria-labelledby={`${headingId}-proof`}>
          <div className="outcome-review__section-heading">
            <h3 id={`${headingId}-proof`}>Proof</h3>
          </div>
          <ul className="outcome-review__list" aria-label="Verification evidence">
            {evidence.map((item) => (
              <li className="outcome-review__row" key={item.id} data-evidence-state={item.status}>
                <span className="outcome-review__row-icon"><Icon icon={evidenceIcon(item.status)} /></span>
                <span className="outcome-review__row-body">
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </span>
                {item.duration ? <span className="outcome-review__row-meta">{item.duration}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {branchReturns.length > 0 ? (
        <section className="outcome-review__section" aria-labelledby={`${headingId}-branches`}>
          <div className="outcome-review__section-heading">
            <h3 id={`${headingId}-branches`}>Branch returns</h3>
          </div>
          <ul className="outcome-review__list" aria-label="RLM child outcomes">
            {branchReturns.map(({ agent, depth, parent, result: branchResult }) => (
              <li
                className="outcome-review__row outcome-review__row--branch"
                key={agent.id}
                data-agent-state={agent.status}
                data-branch-depth={depth}
                data-branch-parent={parent?.id}
                style={{ '--outcome-branch-depth': Math.min(depth, MAX_BRANCH_RETURN_VISUAL_DEPTH) } as CSSProperties}
              >
                <span className="outcome-review__row-icon"><Icon icon={agentIcon(agent.status)} /></span>
                <span className="outcome-review__row-body">
                  <span className="outcome-review__row-title">
                    <strong>{agentDisplayName(agent)}</strong>
                    <span>{agentStateLabel(agent.status)}</span>
                  </span>
                  {parent ? (
                    <span className="outcome-review__row-parent">via {agentDisplayName(parent)}</span>
                  ) : null}
                  <span>{branchResult}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  )
})
