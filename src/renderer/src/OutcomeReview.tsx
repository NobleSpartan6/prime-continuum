import {
  AlertCircle,
  Check,
  CheckCircle2,
  CircleHelp,
  CircleX,
  Clock3,
  type LucideIcon,
} from 'lucide-react'
import { memo, useId } from 'react'

import type { AgentSummary, EvidenceSummary } from './api'

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
}: OutcomeReviewProps) {
  const headingId = useId()
  const stateMeta = OUTCOME_STATE[state]
  const passedChecks = evidence?.filter((item) => item.status === 'passed').length
  const returnedBranches = childAgents?.filter((agent) => agent.status === 'complete').length
  const branchReturns = childAgents?.filter((agent) => agentResult(agent) !== undefined) ?? []

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

      <p className={`outcome-review__result${result?.trim() ? '' : ' outcome-review__result--empty'}`}>
        {result?.trim() || (state === 'working' ? 'Prime Agent is still working.' : 'No written result yet.')}
      </p>

      <dl className="outcome-review__facts" aria-label="Outcome facts">
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
            {branchReturns.map((agent) => (
              <li className="outcome-review__row" key={agent.id} data-agent-state={agent.status}>
                <span className="outcome-review__row-icon"><Icon icon={agentIcon(agent.status)} /></span>
                <span className="outcome-review__row-body">
                  <span className="outcome-review__row-title">
                    <strong>{agentDisplayName(agent)}</strong>
                    <span>{agentStateLabel(agent.status)}</span>
                  </span>
                  <span>{agentResult(agent)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  )
})
