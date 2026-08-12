import {
  AlertCircle,
  ArrowRight,
  Bot,
  Check,
  Circle,
  FileCode2,
  Network,
  Search,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react'

export interface AgentLaunchpadStarter {
  id: string
  label: string
  description: string
  prompt: string
}

export interface AgentLaunchpadProps {
  hostName: string
  model?: string
  sessionState: 'ready' | 'preparing' | 'needs-input' | 'needs-recovery' | 'end-ready' | 'end-paused' | 'ending' | 'end-uncertain' | 'ended'
  browserReady: boolean
  skillCount?: number
  diagnosticCount?: number
  canStartTurn: boolean
  canOpenModels: boolean
  starters: readonly AgentLaunchpadStarter[]
  onSelectStarter: (prompt: string) => void
  onOpenModels: (trigger: HTMLElement) => void
}

const STARTER_ICONS: Record<string, LucideIcon> = {
  delegate: Network,
  feature: FileCode2,
  review: ShieldCheck,
  investigate: Search,
}

function Icon({ icon: IconComponent, size = 16 }: { icon: LucideIcon; size?: number }) {
  return <IconComponent aria-hidden="true" focusable="false" size={size} strokeWidth={1.75} />
}

function usableModel(model: string | undefined): boolean {
  return Boolean(model && model !== 'unknown/unknown' && !model.startsWith('unknown/'))
}

function shortModelName(model: string | undefined): string {
  if (!usableModel(model)) return 'Connect a model'
  return model?.split('/').at(-1) ?? model ?? 'Current model'
}

export default function AgentLaunchpad({
  hostName,
  model,
  sessionState,
  browserReady,
  skillCount,
  diagnosticCount,
  canStartTurn,
  canOpenModels,
  starters,
  onSelectStarter,
  onOpenModels,
}: AgentLaunchpadProps) {
  const modelReady = usableModel(model)
  const residentCapabilityReady = sessionState === 'ready'
  const setupReady = modelReady && residentCapabilityReady
  const showWorkflows = sessionState === 'ready' || sessionState === 'preparing'
  const showSetup = !setupReady || !showWorkflows
  const sessionPresentation = sessionState === 'end-ready'
    ? {
        title: 'Ready to close',
        detail: 'Finish this session to start a new task.',
        icon: ArrowRight,
      }
    : sessionState === 'end-paused'
      ? {
          title: 'End saved',
          detail: `Waiting for resident controls on ${hostName}.`,
          icon: Circle,
        }
      : sessionState === 'ending'
        ? {
            title: 'Finishing session',
            detail: 'Prime Agent received the End request. Completion is checked automatically.',
            icon: Circle,
          }
        : sessionState === 'end-uncertain'
          ? {
              title: 'End outcome needs review',
              detail: 'Prime Continuim will not send another End. Check the retained lifecycle status in Session.',
              icon: AlertCircle,
            }
          : sessionState === 'ended'
            ? {
                title: 'Session ended',
                detail: 'The saved thread remains available. Choose New agent to continue in this workspace.',
                icon: Check,
              }
            : sessionState === 'needs-recovery'
              ? {
                  title: 'Session needs a restart',
                  detail: 'The model is connected, but Prime Agent no longer reports this runtime.',
                  icon: AlertCircle,
                }
              : sessionState === 'needs-input'
                ? {
                    title: 'Session needs your input',
                    detail: 'Open Session to review the current question, approval, or failure.',
                    icon: AlertCircle,
                  }
                : sessionState === 'preparing'
                  ? {
                      title: 'Preparing agent session',
                      detail: `${hostName} is verifying this resident workspace before it accepts a task.`,
                      icon: Circle,
                    }
                  : modelReady
                    ? {
                        title: 'Ready to delegate',
                        detail: `${shortModelName(model)} is selected for this exact resident session.`,
                        icon: Check,
                      }
                    : {
                        title: 'Connect a model to begin',
                        detail: 'ChatGPT setup is guided in-app; credentials remain on this computer.',
                        icon: Bot,
                      }
  const modelActionAvailable = canOpenModels && (
    sessionState === 'ready' || sessionState === 'preparing'
  )

  return (
    <section
      className={showWorkflows ? 'agent-launchpad' : 'agent-launchpad agent-launchpad--status'}
      data-session-state={sessionState}
      aria-labelledby="agent-launchpad-title"
    >
      {showWorkflows && (
        <header className="agent-launchpad__header">
          <span className="agent-launchpad__eyebrow">Prime Agent</span>
          <h2 id="agent-launchpad-title">What should we build?</h2>
          <p>Describe the outcome or choose a brief.</p>
        </header>
      )}

      {showWorkflows && setupReady && (
        <div className="agent-launchpad__readiness" aria-label="Agent readiness">
          <span><Check aria-hidden="true" size={13} /> {shortModelName(model)}</span>
          <span className={browserReady ? 'agent-launchpad__readiness--ready' : undefined}>
            {browserReady ? 'Browser ready' : 'Browser off'}
          </span>
          {skillCount !== undefined && <span>{skillCount} {skillCount === 1 ? 'skill' : 'skills'}</span>}
          {diagnosticCount !== undefined && diagnosticCount > 0 && (
            <span className="agent-launchpad__readiness--warning">{diagnosticCount} notices</span>
          )}
        </div>
      )}

      {showSetup && <div className={setupReady ? 'agent-launchpad__setup agent-launchpad__setup--ready' : 'agent-launchpad__setup'}>
        <span className="agent-launchpad__setup-icon" aria-hidden="true">
          <Icon icon={sessionPresentation.icon} size={16} />
        </span>
        <span className="agent-launchpad__setup-copy">
          {showWorkflows
            ? <strong>{sessionPresentation.title}</strong>
            : <h2 id="agent-launchpad-title">{sessionPresentation.title}</h2>}
          <small>{sessionPresentation.detail}</small>
        </span>
        {modelActionAvailable && (
          <button
            className="button button--secondary agent-launchpad__model-action"
            type="button"
            onClick={(event) => onOpenModels(event.currentTarget)}
          >
            {modelReady ? 'Change model' : 'Set up model'}
            <Icon icon={ArrowRight} size={14} />
          </button>
        )}
      </div>}

      {showWorkflows && <div className="agent-launchpad__tasks" role="group" aria-label="Choose a coding workflow">
        {starters.map((starter) => {
          const StarterIcon = STARTER_ICONS[starter.id] ?? FileCode2
          return (
            <button
              className="agent-launchpad__task"
              type="button"
              key={starter.id}
              disabled={!canStartTurn}
              aria-label={`${starter.label}. ${starter.description}`}
              onClick={() => onSelectStarter(starter.prompt)}
            >
              <span className="agent-launchpad__task-icon"><Icon icon={StarterIcon} size={16} /></span>
              <span>
                <strong>{starter.label}</strong>
                <small>{starter.description}</small>
              </span>
              <Icon icon={ArrowRight} size={14} />
            </button>
          )
        })}
      </div>}

      {showWorkflows && <p className="agent-launchpad__disclaimer">Briefs only fill the composer.</p>}
    </section>
  )
}
