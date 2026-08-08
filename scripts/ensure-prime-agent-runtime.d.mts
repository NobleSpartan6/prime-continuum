export interface RuntimeCommand {
  executable: string
  args: readonly string[]
  cwd: string
  inheritOutput: boolean
}

export interface RuntimeCommandResult {
  status: number | null
  signal?: NodeJS.Signals | null
  stdout?: string
  stderr?: string
  outputLimitExceeded?: boolean
}

export class PrimeAgentRuntimeSetupError extends Error {}

export function ensurePrimeAgentRuntime(options?: {
  projectRoot?: string
  runtimeRoot?: string
  runCommand?: (command: RuntimeCommand) => RuntimeCommandResult | Promise<RuntimeCommandResult>
  log?: (message: string) => void
}): Promise<{ readonly rebuilt: boolean; readonly runtimeRoot: string }>

export function runRuntimeCommand(command: RuntimeCommand): Promise<RuntimeCommandResult>
