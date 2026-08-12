import {
  Activity,
  AlertCircle,
  Check,
  Clock3,
  GitFork,
  type LucideIcon,
} from 'lucide-react'
import { memo, useMemo, useState, type CSSProperties } from 'react'

import type { AgentSummary } from './api'

const AGENT_INCREMENT = 50
const MAX_VISUAL_DEPTH = 4

export interface RlmDelegationPanelProps {
  agents: AgentSummary[]
  agentsReported: boolean
  isFresh: boolean
  rootAvailable: boolean
  rootActive: boolean
  rootLabel: string
  rootDetail: string
  rootModel?: string
  rootThinkingLevel?: string
}

interface AgentBranch {
  agent: AgentSummary
  children: AgentBranch[]
  depth: number
  parent?: AgentSummary
}

function Icon({ icon: IconComponent, size = 14 }: { icon: LucideIcon; size?: number }) {
  return <IconComponent aria-hidden="true" focusable="false" size={size} strokeWidth={1.75} />
}

function agentDisplayName(agent: AgentSummary): string {
  return agent.sessionName?.trim() || agent.name
}

function readableModelName(model: string | undefined): string | undefined {
  if (!model || model === 'unknown/unknown' || model.startsWith('unknown/')) return undefined
  const shortName = model.split('/').at(-1) ?? model
  return shortName.toLocaleLowerCase() === 'gpt-5.6-sol' ? 'GPT-5.6 Sol' : shortName
}

function runtimeStateLabel(state: string): string {
  return state.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase())
}

function compactDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

function parentFirstAgents(agents: AgentSummary[]): AgentSummary[] {
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

  const ordered: AgentSummary[] = []
  const visited = new Set<string>()
  const visit = (agent: AgentSummary): void => {
    if (visited.has(agent.id)) return
    visited.add(agent.id)
    ordered.push(agent)
    children.get(agent.id)?.forEach(visit)
  }

  roots.forEach(visit)
  // Malformed cyclic relationships have no root. Keep them visible once in
  // first-seen order instead of dropping the retained runtime evidence.
  agents.forEach(visit)
  return ordered
}

function buildAgentForest(agents: AgentSummary[]): AgentBranch[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const children = new Map<string, AgentSummary[]>()
  const rootAgents: AgentSummary[] = []

  for (const agent of agents) {
    if (agent.parentId && agent.parentId !== agent.id && byId.has(agent.parentId)) {
      const siblings = children.get(agent.parentId) ?? []
      siblings.push(agent)
      children.set(agent.parentId, siblings)
    } else {
      rootAgents.push(agent)
    }
  }

  const rendered = new Set<string>()
  const build = (agent: AgentSummary, depth: number, parent?: AgentSummary): AgentBranch | undefined => {
    if (rendered.has(agent.id)) return undefined
    rendered.add(agent.id)
    return {
      agent,
      depth,
      parent,
      children: (children.get(agent.id) ?? [])
        .map((child) => build(child, depth + 1, agent))
        .filter((child): child is AgentBranch => child !== undefined),
    }
  }

  const forest = rootAgents
    .map((agent) => build(agent, 0))
    .filter((branch): branch is AgentBranch => branch !== undefined)

  // A cycle cannot produce a root. Surface its first retained member as a
  // bounded root and let the rendered set break the loop.
  for (const agent of agents) {
    const branch = build(agent, 0)
    if (branch) forest.push(branch)
  }

  return forest
}

function branchIcon(agent: AgentSummary): LucideIcon {
  if (agent.status === 'complete') return Check
  if (agent.status === 'running') return Activity
  if (agent.status === 'failed') return AlertCircle
  return Clock3
}

function AgentBranchRow({ branch, isFresh }: { branch: AgentBranch; isFresh: boolean }) {
  const { agent, children, depth, parent } = branch
  const resultPreview = agent.answerPreview ?? (
    agent.status === 'complete' || agent.status === 'failed' || agent.status === 'cancelled'
      ? agent.recap
      : undefined
  )
  const statusCopy = agent.repliedSinceTask === true
    ? 'Returned'
    : isFresh
      ? runtimeStateLabel(agent.status)
      : `Last reported ${runtimeStateLabel(agent.status).toLocaleLowerCase()}`
  const visualDepth = Math.min(depth, MAX_VISUAL_DEPTH)

  return (
    <li
      className="rlm-map__branch"
      aria-label={parent
        ? `${agentDisplayName(agent)}, delegated by ${agentDisplayName(parent)}`
        : `${agentDisplayName(agent)}, delegated branch`}
      data-runtime-agent
      data-rlm-depth={depth}
      data-rlm-parent={parent?.id}
      style={{ '--rlm-depth': visualDepth } as CSSProperties}
    >
      <div className="rlm-map__row">
        <span className={`agent-state agent-state--${agent.status}`} aria-hidden="true">
          <Icon icon={branchIcon(agent)} />
        </span>
        <span className="agent-list__body rlm-map__body">
          <span className="rlm-map__heading">
            <strong>{agentDisplayName(agent)}</strong>
            <span>{statusCopy}</span>
          </span>
          <span className="sr-only">
            {parent ? `Delegated by ${agentDisplayName(parent)}` : 'Delegated RLM branch'}
          </span>
          <span>{agent.activity ?? (resultPreview ? agent.role : agent.recap ?? agent.role)}</span>
          <small>
            {agent.model ? (readableModelName(agent.model) ?? agent.model) : 'Inherited model'}
            {agent.durationMs !== undefined ? ` · ${compactDuration(agent.durationMs)}` : ''}
            {agent.toolUseCount !== undefined ? ` · ${agent.toolUseCount.toLocaleString()} tool ${agent.toolUseCount === 1 ? 'use' : 'uses'}` : ''}
            {agent.tokenCount !== undefined ? ` · ${agent.tokenCount.toLocaleString()} tokens` : ''}
          </small>
          {resultPreview && (
            <details className="rlm-map__result">
              <summary>View result</summary>
              <p>{resultPreview}</p>
            </details>
          )}
          {agent.error && <span className="runtime-error">{agent.error}</span>}
        </span>
      </div>
      {children.length > 0 ? (
        <ul className="rlm-map__branch-list" aria-label={`Branches delegated by ${agentDisplayName(agent)}`}>
          {children.map((child) => <AgentBranchRow branch={child} isFresh={isFresh} key={child.agent.id} />)}
        </ul>
      ) : null}
    </li>
  )
}

export const RlmDelegationPanel = memo(function RlmDelegationPanel({
  agents,
  agentsReported,
  isFresh,
  rootAvailable,
  rootActive,
  rootLabel,
  rootDetail,
  rootModel,
  rootThinkingLevel,
}: RlmDelegationPanelProps) {
  const [agentLimit, setAgentLimit] = useState(AGENT_INCREMENT)
  const activeAgents = agents.filter((agent) => (
    agent.status === 'pending' ||
    agent.status === 'queued' ||
    agent.status === 'running' ||
    agent.status === 'waiting'
  )).length
  const completedAgents = agents.filter((agent) => agent.status === 'complete').length
  const visibleAgents = useMemo(
    () => parentFirstAgents(agents).slice(0, agentLimit),
    [agentLimit, agents],
  )
  const forest = useMemo(() => buildAgentForest(visibleAgents), [visibleAgents])

  return (
    <div className="runtime-subsection runtime-subsection--rlm" aria-labelledby="runtime-agents-heading">
      <div className="runtime-subsection__heading">
        <h4 id="runtime-agents-heading">RLM delegation</h4>
        <span>
          {agentsReported
            ? `${agents.length} ${agents.length === 1 ? 'branch' : 'branches'}`
            : 'Not reported'}
        </span>
      </div>
      <p className="rlm-map__intro">Prime delegates focused work, then folds results into the main task.</p>
      {agentsReported && agents.length > 0 ? (
        <p className="rlm-map__summary" aria-label="RLM activity summary">
          <span><strong>{activeAgents}</strong> active</span>
          <span><strong>{completedAgents}</strong> complete</span>
        </p>
      ) : null}
      <div className="rlm-map" aria-label="Recursive agent hierarchy">
        <div className="rlm-map__root">
          <span className={`agent-state ${rootActive ? 'agent-state--running' : 'agent-state--waiting'}`} aria-hidden="true">
            <Icon icon={GitFork} />
          </span>
          <span className="rlm-map__body">
            <span className="rlm-map__heading">
              <strong>Prime Agent</strong>
              <span>{rootAvailable ? rootLabel : 'Session not reported'}</span>
            </span>
            <span className="rlm-map__role">Coordinator · main session</span>
            <span>{rootAvailable ? rootDetail : 'Live coordinator state isn’t reported.'}</span>
            {rootModel ? <small>{readableModelName(rootModel) ?? rootModel}{rootThinkingLevel ? ` · ${rootThinkingLevel} thinking` : ''}</small> : null}
          </span>
        </div>
        {!agentsReported ? (
          <p className="runtime-empty">Child activity isn’t reported.</p>
        ) : agents.length === 0 ? (
          <p className="runtime-empty">No child agents for this task.</p>
        ) : (
          <ul className="agent-list rlm-map__children rlm-map__branch-list" aria-label="Delegated branches">
            {forest.map((branch) => <AgentBranchRow branch={branch} isFresh={isFresh} key={branch.agent.id} />)}
          </ul>
        )}
      </div>
      {agentsReported && agents.length > agentLimit ? (
        <button
          className="button button--secondary button--full runtime-more"
          type="button"
          onClick={() => setAgentLimit((limit) => limit + AGENT_INCREMENT)}
        >
          Show {Math.min(AGENT_INCREMENT, agents.length - agentLimit)} more subagents
        </button>
      ) : null}
    </div>
  )
})
