import type {
  ResidentExtensionUiRequest,
  InProgressStream,
  ResidentBrowserExecution,
  ResidentLifecycleDisposition,
  ResidentLifecycleLookupResult,
  ResidentLifecycleStatus,
  RuntimeNamedResource,
  RuntimeResourceCollision,
  RuntimeResourceInventory,
  RuntimeResourceSourceKind,
  SessionCursor,
} from '../../shared/protocol'

type ParseResult<T> = { success: true; data: T } | { success: false }
type UnknownRecord = Record<string, unknown>

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}

function exactKeys(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
}

function boundedString(value: unknown, min: number, max: number): string | undefined {
  return typeof value === 'string' && value.length >= min && value.length <= max ? value : undefined
}

function id(value: unknown): string | undefined {
  const candidate = boundedString(value, 1, 128)
  return candidate && ID_PATTERN.test(candidate) ? candidate : undefined
}

function isoDateTime(value: unknown): string | undefined {
  const candidate = boundedString(value, 20, 40)
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : undefined
}

function integer(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined
}

function sessionCursor(value: unknown): SessionCursor | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const threadId = id(raw.threadId)
  const executionGenerationId = id(raw.executionGenerationId)
  const generation = id(raw.generation)
  const sequence = integer(raw.sequence, 0, Number.MAX_SAFE_INTEGER)
  if (!threadId || !executionGenerationId || !generation || sequence === undefined) return undefined
  return { threadId, executionGenerationId, generation, sequence }
}

export function parseInProgressStream(value: unknown): ParseResult<InProgressStream> {
  const raw = record(value)
  const blockId = id(raw?.blockId)
  const text = boundedString(raw?.text, 0, 262_144)
  const startedAt = isoDateTime(raw?.startedAt)
  return raw && blockId && text !== undefined && startedAt
    ? { success: true, data: { blockId, text, startedAt } }
    : { success: false }
}

function extensionUiAuthority(value: UnknownRecord): {
  interactionVersion: 1
  hostId: string
  threadId: string
  executionGenerationId: string
  bindingFingerprint: string
  requestId: string
  requestDigest: string
  receivedAt: string
  timeoutMs?: number
} | undefined {
  const hostId = id(value.hostId)
  const threadId = id(value.threadId)
  const executionGenerationId = id(value.executionGenerationId)
  const bindingFingerprint = boundedString(value.bindingFingerprint, 64, 64)
  const requestId = id(value.requestId)
  const requestDigest = boundedString(value.requestDigest, 64, 64)
  const receivedAt = isoDateTime(value.receivedAt)
  const timeoutMs = value.timeoutMs === undefined
    ? undefined
    : integer(value.timeoutMs, 1, 24 * 60 * 60 * 1_000)
  if (
    value.interactionVersion !== 1 ||
    !hostId ||
    !threadId ||
    !executionGenerationId ||
    !bindingFingerprint ||
    !SHA256_PATTERN.test(bindingFingerprint) ||
    !requestId ||
    !requestDigest ||
    !SHA256_PATTERN.test(requestDigest) ||
    !receivedAt ||
    (value.timeoutMs !== undefined && timeoutMs === undefined)
  ) return undefined
  return {
    interactionVersion: 1,
    hostId,
    threadId,
    executionGenerationId,
    bindingFingerprint,
    requestId,
    requestDigest,
    receivedAt,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }
}

export function parseResidentExtensionUiRequest(value: unknown): ParseResult<ResidentExtensionUiRequest> {
  const raw = record(value)
  if (!raw) return { success: false }
  const authority = extensionUiAuthority(raw)
  if (!authority) return { success: false }
  const optionalAuthorityKeys = ['timeoutMs'] as const
  if (raw.method === 'select') {
    if (!exactKeys(raw, [
      'interactionVersion',
      'hostId',
      'threadId',
      'executionGenerationId',
      'bindingFingerprint',
      'requestId',
      'requestDigest',
      'receivedAt',
      'method',
      'title',
      'options',
    ], optionalAuthorityKeys)) return { success: false }
    const title = boundedString(raw.title, 1, 1_024)
    const options = parseArray(raw.options, 128, (item) => boundedString(item, 0, 4_096))
    if (!title || !options || options.length === 0 || new Set(options).size !== options.length) {
      return { success: false }
    }
    return { success: true, data: { ...authority, method: 'select', title, options } }
  }
  if (raw.method === 'confirm') {
    if (!exactKeys(raw, [
      'interactionVersion',
      'hostId',
      'threadId',
      'executionGenerationId',
      'bindingFingerprint',
      'requestId',
      'requestDigest',
      'receivedAt',
      'method',
      'title',
      'message',
    ], optionalAuthorityKeys)) return { success: false }
    const title = boundedString(raw.title, 1, 1_024)
    const message = boundedString(raw.message, 0, 8_192)
    return title && message !== undefined
      ? { success: true, data: { ...authority, method: 'confirm', title, message } }
      : { success: false }
  }
  if (raw.method === 'input') {
    if (!exactKeys(raw, [
      'interactionVersion',
      'hostId',
      'threadId',
      'executionGenerationId',
      'bindingFingerprint',
      'requestId',
      'requestDigest',
      'receivedAt',
      'method',
      'title',
    ], [...optionalAuthorityKeys, 'placeholder'])) return { success: false }
    const title = boundedString(raw.title, 1, 1_024)
    const placeholder = raw.placeholder === undefined
      ? undefined
      : boundedString(raw.placeholder, 0, 4_096)
    if (!title || (raw.placeholder !== undefined && placeholder === undefined)) return { success: false }
    return {
      success: true,
      data: { ...authority, method: 'input', title, ...(placeholder !== undefined ? { placeholder } : {}) },
    }
  }
  if (raw.method === 'editor') {
    if (!exactKeys(raw, [
      'interactionVersion',
      'hostId',
      'threadId',
      'executionGenerationId',
      'bindingFingerprint',
      'requestId',
      'requestDigest',
      'receivedAt',
      'method',
      'title',
    ], [...optionalAuthorityKeys, 'prefill'])) return { success: false }
    const title = boundedString(raw.title, 1, 1_024)
    const prefill = raw.prefill === undefined ? undefined : boundedString(raw.prefill, 0, 65_536)
    if (!title || (raw.prefill !== undefined && prefill === undefined)) return { success: false }
    return {
      success: true,
      data: { ...authority, method: 'editor', title, ...(prefill !== undefined ? { prefill } : {}) },
    }
  }
  return { success: false }
}

export function parseResidentBrowserExecution(value: unknown): ParseResult<ResidentBrowserExecution> {
  const raw = record(value)
  if (!raw) return { success: false }
  if (raw.readiness === 'unavailable' && exactKeys(raw, ['readiness'])) {
    return { success: true, data: { readiness: 'unavailable' } }
  }
  if (
    raw.readiness === 'ready' &&
    exactKeys(raw, ['readiness', 'protocol', 'surface', 'controller', 'engine']) &&
    raw.protocol === 'prime-continuim.browser.v1' &&
    raw.surface === 'playwright-cli' &&
    raw.controller === 'playwright-core/1.63.0-alpha-2026-08-05' &&
    raw.engine === 'verified-electron-host'
  ) {
    return {
      success: true,
      data: {
        readiness: 'ready',
        protocol: raw.protocol,
        surface: raw.surface,
        controller: raw.controller,
        engine: raw.engine,
      },
    }
  }
  return { success: false }
}

export function parseResidentLifecycleDisposition(value: unknown): ParseResult<ResidentLifecycleDisposition> {
  const raw = record(value)
  if (!raw || !exactKeys(raw, [
    'version',
    'state',
    'operationId',
    'bindingFingerprint',
    'endedAt',
    'sourceCursor',
    'reason',
  ])) return { success: false }
  const operationId = id(raw.operationId)
  const bindingFingerprint = boundedString(raw.bindingFingerprint, 64, 64)
  const endedAt = isoDateTime(raw.endedAt)
  const sourceCursor = sessionCursor(raw.sourceCursor)
  if (
    raw.version !== 1 ||
    raw.state !== 'ended' ||
    !operationId ||
    !bindingFingerprint ||
    !SHA256_PATTERN.test(bindingFingerprint) ||
    !endedAt ||
    !sourceCursor ||
    raw.reason !== 'user_end'
  ) return { success: false }
  return {
    success: true,
    data: {
      version: 1,
      state: 'ended',
      operationId,
      bindingFingerprint,
      endedAt,
      sourceCursor,
      reason: 'user_end',
    },
  }
}

const LIFECYCLE_PHASES = new Set([
  'prepared',
  'owned_create_dispatching',
  'owned_observed',
  'promotion_dispatching',
  'promoted_observed',
  'projection_committed',
  'committed',
  'ending',
  'kill_dispatching',
  'kill_acknowledged',
  'detached',
  'quarantined',
  'completed',
] as const)
const PROVISION_PHASES = new Set([
  'prepared',
  'owned_create_dispatching',
  'owned_observed',
  'promotion_dispatching',
  'promoted_observed',
  'projection_committed',
  'committed',
  'quarantined',
  'completed',
])
const END_PHASES = new Set(['ending', 'kill_dispatching', 'kill_acknowledged', 'quarantined', 'completed'])
const QUARANTINED_FROM = new Set([
  'prepared',
  'owned_create_dispatching',
  'owned_observed',
  'promotion_dispatching',
  'promoted_observed',
  'projection_committed',
  'ending',
  'kill_dispatching',
  'kill_acknowledged',
])
const QUARANTINE_REASONS = new Set([
  'external_outcome_unknown',
  'authority_changed',
  'explicit_reconciliation_required',
  'owned_client_lost',
])
const COMPLETION_REASONS = new Set(['owned_create_failed_before_effect', 'owned_create_cleaned'])

export function parseResidentLifecycleStatus(value: unknown): ParseResult<ResidentLifecycleStatus> {
  const raw = record(value)
  if (!raw || !exactKeys(raw, [
    'version',
    'kind',
    'operationId',
    'phase',
    'expectedHostId',
    'projectId',
    'workspaceId',
    'threadId',
    'executionGenerationId',
    'preparedAt',
    'updatedAt',
  ], ['quarantinedFrom', 'quarantineReason', 'completionReason', 'terminalAt'])) return { success: false }

  const kind = raw.kind
  const phase = raw.phase
  const operationId = id(raw.operationId)
  const expectedHostId = id(raw.expectedHostId)
  const projectId = id(raw.projectId)
  const workspaceId = id(raw.workspaceId)
  const threadId = id(raw.threadId)
  const executionGenerationId = id(raw.executionGenerationId)
  const preparedAt = isoDateTime(raw.preparedAt)
  const updatedAt = isoDateTime(raw.updatedAt)
  const terminalAt = raw.terminalAt === undefined ? undefined : isoDateTime(raw.terminalAt)
  const quarantinedFrom = raw.quarantinedFrom
  const quarantineReason = raw.quarantineReason
  const completionReason = raw.completionReason
  if (
    raw.version !== 1 ||
    (kind !== 'provision' && kind !== 'end' && kind !== 'detach') ||
    typeof phase !== 'string' || !LIFECYCLE_PHASES.has(phase as never) ||
    !operationId || !expectedHostId || !projectId || !workspaceId || !threadId || !executionGenerationId ||
    !preparedAt || !updatedAt ||
    (raw.terminalAt !== undefined && !terminalAt) ||
    (quarantinedFrom !== undefined && (typeof quarantinedFrom !== 'string' || !QUARANTINED_FROM.has(quarantinedFrom))) ||
    (quarantineReason !== undefined && (typeof quarantineReason !== 'string' || !QUARANTINE_REASONS.has(quarantineReason))) ||
    (completionReason !== undefined && (typeof completionReason !== 'string' || !COMPLETION_REASONS.has(completionReason))) ||
    (kind === 'provision' && !PROVISION_PHASES.has(phase)) ||
    (kind === 'end' && !END_PHASES.has(phase)) ||
    (kind === 'detach' && phase !== 'detached')
  ) return { success: false }

  const quarantined = phase === 'quarantined'
  if (quarantined !== Boolean(quarantinedFrom && quarantineReason)) return { success: false }
  if (
    (quarantineReason === 'owned_client_lost' && quarantinedFrom !== 'owned_observed') ||
    (quarantineReason === 'external_outcome_unknown' &&
      quarantinedFrom !== 'owned_create_dispatching' &&
      quarantinedFrom !== 'promotion_dispatching' &&
      quarantinedFrom !== 'kill_dispatching')
  ) return { success: false }
  const terminal = phase === 'committed' || phase === 'completed' || phase === 'detached'
  if (terminal !== (terminalAt !== undefined)) return { success: false }
  if ((completionReason !== undefined) !== (kind === 'provision' && phase === 'completed')) return { success: false }

  return {
    success: true,
    data: {
      version: 1,
      kind,
      operationId,
      phase,
      expectedHostId,
      projectId,
      workspaceId,
      threadId,
      executionGenerationId,
      preparedAt,
      updatedAt,
      ...(quarantinedFrom ? { quarantinedFrom } : {}),
      ...(quarantineReason ? { quarantineReason } : {}),
      ...(completionReason ? { completionReason } : {}),
      ...(terminalAt ? { terminalAt } : {}),
    } as ResidentLifecycleStatus,
  }
}

export function parseResidentLifecycleLookupResult(value: unknown): ResidentLifecycleLookupResult {
  const raw = record(value)
  if (!raw || !exactKeys(raw, ['status'])) throw new Error('The native service returned an invalid resident lifecycle status.')
  if (raw.status === null) return { status: null }
  const status = parseResidentLifecycleStatus(raw.status)
  if (!status.success) throw new Error('The native service returned an invalid resident lifecycle status.')
  return { status: status.data }
}

function sourceKind(value: unknown): RuntimeResourceSourceKind | undefined {
  const raw = record(value)
  if (!raw || !exactKeys(raw, ['scope', 'origin'])) return undefined
  if (
    raw.scope !== 'user' && raw.scope !== 'project' && raw.scope !== 'temporary' ||
    raw.origin !== 'package' && raw.origin !== 'top-level'
  ) return undefined
  return { scope: raw.scope, origin: raw.origin }
}

function namedResource(value: unknown): RuntimeNamedResource | undefined {
  const raw = record(value)
  if (!raw || !exactKeys(raw, ['name'], ['description', 'sourceKind'])) return undefined
  const name = boundedString(raw.name, 1, 255)
  const description = raw.description === undefined ? undefined : boundedString(raw.description, 0, 4_096)
  const parsedSourceKind = raw.sourceKind === undefined ? undefined : sourceKind(raw.sourceKind)
  if (!name || /[\0\r\n]/.test(name) || (raw.description !== undefined && description === undefined) ||
    (raw.sourceKind !== undefined && !parsedSourceKind)) return undefined
  return { name, ...(description !== undefined ? { description } : {}), ...(parsedSourceKind ? { sourceKind: parsedSourceKind } : {}) }
}

function collision(value: unknown): RuntimeResourceCollision | undefined {
  const raw = record(value)
  if (!raw || !exactKeys(raw, ['resourceType', 'name'])) return undefined
  const resourceType = raw.resourceType
  const name = boundedString(raw.name, 1, 255)
  if (
    resourceType !== 'extension' && resourceType !== 'skill' && resourceType !== 'prompt' && resourceType !== 'theme' ||
    !name || /[\0\r\n]/.test(name)
  ) return undefined
  return { resourceType, name }
}

function parseArray<T>(value: unknown, maximum: number, parser: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value) || value.length > maximum) return undefined
  const parsed = value.map(parser)
  return parsed.every((item): item is T => item !== undefined) ? parsed : undefined
}

export function parseRuntimeResourceInventory(value: unknown): ParseResult<RuntimeResourceInventory> {
  const raw = record(value)
  if (!raw || !exactKeys(raw, [
    'skills',
    'prompts',
    'themes',
    'extensions',
    'contextFileCount',
    'diagnostics',
  ])) return { success: false }
  const skills = parseArray(raw.skills, 2_000, namedResource)
  const prompts = parseArray(raw.prompts, 2_000, namedResource)
  const themes = parseArray(raw.themes, 1_000, namedResource)
  const extensions = record(raw.extensions)
  const diagnostics = record(raw.diagnostics)
  const extensionCount = integer(extensions?.count, 0, 2_000)
  const extensionSourceKinds = parseArray(extensions?.sourceKinds, 6, sourceKind)
  const contextFileCount = integer(raw.contextFileCount, 0, 2_000)
  const warningCount = integer(diagnostics?.warningCount, 0, 2_000)
  const errorCount = integer(diagnostics?.errorCount, 0, 2_000)
  const collisions = parseArray(diagnostics?.collisions, 2_000, collision)
  if (
    !skills || !prompts || !themes || !extensions || !exactKeys(extensions, ['count', 'sourceKinds']) ||
    extensionCount === undefined || !extensionSourceKinds ||
    new Set(extensionSourceKinds.map((item) => `${item.scope}:${item.origin}`)).size !== extensionSourceKinds.length ||
    contextFileCount === undefined || !diagnostics || !exactKeys(diagnostics, ['warningCount', 'errorCount', 'collisions']) ||
    warningCount === undefined || errorCount === undefined || !collisions
  ) return { success: false }
  return {
    success: true,
    data: {
      skills,
      prompts,
      themes,
      extensions: { count: extensionCount, sourceKinds: extensionSourceKinds },
      contextFileCount,
      diagnostics: { warningCount, errorCount, collisions },
    },
  }
}
