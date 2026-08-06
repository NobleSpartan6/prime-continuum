import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { SshHostAlias, SshProbe } from './contracts'
import { ControlError, toStructuredError } from './errors'

const WILDCARD = /[*?[]/
const DEFAULT_MAX_DEPTH = 16
const DEFAULT_MAX_FILES = 256
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_STDOUT_BYTES = 1024 * 1024
const DEFAULT_STDERR_BYTES = 128 * 1024
const SAFE_ALIAS = /^[A-Za-z0-9_.:@%+~-]+$/

export interface SshDiscoveryOptions {
  configPath?: string
  homeDirectory?: string
  sshExecutable?: string
  resolveEffectiveSettings?: boolean
  resolutionConcurrency?: number
  maxDepth?: number
  maxFiles?: number
  maxFileBytes?: number
  resolutionTimeoutMs?: number
}

export interface ParsedSshAlias {
  alias: string
  sourceFiles: string[]
}

interface ParseContext {
  configRoot: string
  maxDepth: number
  maxFiles: number
  maxFileBytes: number
  visited: Set<string>
  aliases: Map<string, Set<string>>
}

export function assertSafeSshAlias(alias: string): void {
  if (
    alias.length === 0 ||
    alias.length > 255 ||
    alias.startsWith('-') ||
    alias.startsWith('!') ||
    WILDCARD.test(alias) ||
    !SAFE_ALIAS.test(alias)
  ) {
    throw new ControlError('ssh.invalid_alias', 'The SSH host alias is not safe to invoke.', {
      details: { alias }
    })
  }
}

export function buildSshResolveArgs(alias: string): string[] {
  assertSafeSshAlias(alias)
  return ['-G', alias]
}

export function buildSshProbeArgs(alias: string): string[] {
  assertSafeSshAlias(alias)
  return [alias, 'prime-agent-hostd', 'probe', '--json']
}

export function buildSshConnectArgs(alias: string): string[] {
  assertSafeSshAlias(alias)
  return [
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    alias,
    'prime-agent-hostd',
    'connect',
    '--stdio'
  ]
}

export async function parseSshConfigAliases(
  options: Pick<
    SshDiscoveryOptions,
    'configPath' | 'homeDirectory' | 'maxDepth' | 'maxFiles' | 'maxFileBytes'
  > = {}
): Promise<ParsedSshAlias[]> {
  const userHome = options.homeDirectory ?? homedir()
  const configPath = path.resolve(options.configPath ?? path.join(userHome, '.ssh', 'config'))
  const context: ParseContext = {
    configRoot: path.dirname(configPath),
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    visited: new Set(),
    aliases: new Map()
  }

  await parseConfigFile(configPath, 0, userHome, context, true)
  return [...context.aliases].map(([alias, files]) => ({
    alias,
    sourceFiles: [...files]
  }))
}

export async function discoverSshHosts(options: SshDiscoveryOptions = {}): Promise<SshHostAlias[]> {
  const aliases = await parseSshConfigAliases(options)
  if (options.resolveEffectiveSettings === false || aliases.length === 0) {
    return aliases.map(({ alias }) => ({ alias }))
  }

  const sshExecutable = options.sshExecutable ?? 'ssh'
  const concurrency = Math.max(1, Math.min(options.resolutionConcurrency ?? 6, 12))
  const results: SshHostAlias[] = new Array(aliases.length)
  let next = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++
      const candidate = aliases[index]
      if (!candidate) return
      try {
        const effective = await resolveSshHost(candidate.alias, {
          sshExecutable,
          timeoutMs: options.resolutionTimeoutMs
        })
        results[index] = { alias: candidate.alias, effective }
      } catch (error) {
        results[index] = { alias: candidate.alias, resolutionError: toStructuredError(error) }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, aliases.length) }, () => worker()))
  return results
}

export async function resolveSshHost(
  alias: string,
  options: { sshExecutable?: string; timeoutMs?: number } = {}
): Promise<NonNullable<SshHostAlias['effective']>> {
  let stdout: string
  try {
    ;({ stdout } = await runBoundedCommand(
      options.sshExecutable ?? 'ssh',
      buildSshResolveArgs(alias),
      {
        timeoutMs: options.timeoutMs ?? 5_000,
        stdoutBytes: DEFAULT_STDOUT_BYTES,
        stderrBytes: DEFAULT_STDERR_BYTES
      }
    ))
  } catch (error) {
    throw classifySshFailure(error, alias)
  }

  const values = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.search(/\s/)
    if (separator <= 0) continue
    const key = line.slice(0, separator).toLowerCase()
    if (!values.has(key)) values.set(key, line.slice(separator).trim())
  }

  const hostname = values.get('hostname')
  if (!hostname) {
    throw new ControlError('ssh.resolve_invalid', 'OpenSSH did not return an effective host name.', {
      details: { alias }
    })
  }

  const parsedPort = Number(values.get('port'))
  return {
    hostname,
    ...(values.get('user') ? { user: values.get('user') } : {}),
    ...(Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65_535
      ? { port: parsedPort }
      : {}),
    ...(values.get('proxyjump') && values.get('proxyjump') !== 'none'
      ? { proxyJump: values.get('proxyjump') }
      : {}),
    ...(values.get('canonicalizehostname')
      ? { canonicalizeHostname: values.get('canonicalizehostname') }
      : {})
  }
}

export async function probeSshHost(
  alias: string,
  options: { sshExecutable?: string; timeoutMs?: number } = {}
): Promise<SshProbe> {
  const effective = await resolveSshHost(alias, options)
  let stdout: string
  try {
    ;({ stdout } = await runBoundedCommand(
      options.sshExecutable ?? 'ssh',
      buildSshProbeArgs(alias),
      {
        timeoutMs: options.timeoutMs ?? 15_000,
        stdoutBytes: DEFAULT_STDOUT_BYTES,
        stderrBytes: DEFAULT_STDERR_BYTES
      }
    ))
  } catch (error) {
    throw classifySshFailure(error, alias)
  }

  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch (cause) {
    throw new ControlError('ssh.probe_invalid_json', 'The remote host returned an invalid probe.', {
      retryable: true,
      details: { alias },
      cause
    })
  }
  if (!isRecord(payload)) {
    throw new ControlError('ssh.probe_invalid_shape', 'The remote probe was not a JSON object.', {
      details: { alias }
    })
  }

  return {
    alias,
    effectiveTarget: formatEffectiveTarget(effective),
    ...(typeof payload.protocolVersion === 'string'
      ? { protocolVersion: payload.protocolVersion }
      : {}),
    ...(typeof payload.hostdVersion === 'string' ? { hostdVersion: payload.hostdVersion } : {}),
    ...(typeof payload.compatible === 'boolean' ? { compatible: payload.compatible } : {}),
    payload
  }
}

export interface BoundedCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export function classifySshFailure(error: unknown, alias: string, diagnostic = ''): ControlError {
  const inherited = error instanceof ControlError ? error : undefined
  const stderr = `${diagnostic} ${typeof inherited?.details?.stderr === 'string' ? inherited.details.stderr : ''}`.trim()
  const details = { alias, ...(stderr ? { diagnostic: redactDiagnostic(stderr) } : {}) }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr)) {
    return new ControlError(
      'ssh.host_key_verification_failed',
      `OpenSSH could not verify the host key for ${alias}.`,
      { details, cause: error }
    )
  }
  if (/Permission denied|Authentication failed|Too many authentication failures/i.test(stderr)) {
    return new ControlError('ssh.authentication_required', `OpenSSH authentication is required for ${alias}.`, {
      retryable: true,
      details,
      cause: error
    })
  }
  if (/ssh_askpass|passphrase|security key|PIN/i.test(stderr)) {
    return new ControlError(
      'ssh.authentication_interaction_required',
      `OpenSSH needs authentication interaction for ${alias}.`,
      { retryable: true, details, cause: error }
    )
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname provided/i.test(stderr)) {
    return new ControlError('ssh.host_not_found', `OpenSSH could not resolve ${alias}.`, {
      retryable: true,
      details,
      cause: error
    })
  }
  if (/Connection refused|Connection timed out|Operation timed out|No route to host/i.test(stderr)) {
    return new ControlError('ssh.unreachable', `OpenSSH could not reach ${alias}.`, {
      retryable: true,
      details,
      cause: error
    })
  }
  if (inherited?.code === 'process.spawn_failed') {
    return new ControlError('ssh.client_unavailable', 'The system OpenSSH client is unavailable.', {
      details: { alias },
      cause: error
    })
  }
  return new ControlError('ssh.failed', `OpenSSH could not complete the request for ${alias}.`, {
    retryable: inherited?.retryable ?? true,
    details,
    cause: error
  })
}

export async function runBoundedCommand(
  executable: string,
  args: readonly string[],
  options: { timeoutMs: number; stdoutBytes: number; stderrBytes: number }
): Promise<BoundedCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' }
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutLength = 0
    let stderrLength = 0
    let settled = false

    const finishReject = (error: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(error)
    }

    const timer = setTimeout(() => {
      finishReject(
        new ControlError('process.timeout', 'The system command timed out.', {
          retryable: true,
          details: { executable, timeoutMs: options.timeoutMs }
        })
      )
    }, options.timeoutMs)
    timer.unref?.()

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutLength += chunk.length
      if (stdoutLength > options.stdoutBytes) {
        finishReject(
          new ControlError('process.stdout_limit', 'The command returned too much output.', {
            details: { limitBytes: options.stdoutBytes }
          })
        )
        return
      }
      stdout.push(chunk)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrLength += chunk.length
      if (stderrLength > options.stderrBytes) {
        finishReject(
          new ControlError('process.stderr_limit', 'The command returned too much diagnostic output.', {
            details: { limitBytes: options.stderrBytes }
          })
        )
        return
      }
      stderr.push(chunk)
    })

    child.once('error', (cause) => {
      finishReject(
        new ControlError('process.spawn_failed', `Could not start ${executable}.`, {
          retryable: true,
          details: { executable },
          cause
        })
      )
    })

    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdoutText = Buffer.concat(stdout).toString('utf8').trim()
      const stderrText = Buffer.concat(stderr).toString('utf8').trim()
      if (code !== 0) {
        reject(
          new ControlError('process.nonzero_exit', `${executable} exited without completing.`, {
            retryable: true,
            details: {
              executable,
              exitCode: code,
              signal,
              stderr: redactDiagnostic(stderrText)
            }
          })
        )
        return
      }
      resolve({ stdout: stdoutText, stderr: stderrText, exitCode: code ?? 0 })
    })
  })
}

async function parseConfigFile(
  candidatePath: string,
  depth: number,
  userHome: string,
  context: ParseContext,
  optional: boolean
): Promise<void> {
  if (depth > context.maxDepth) {
    throw new ControlError('ssh.include_depth', 'SSH config Include nesting is too deep.', {
      details: { maxDepth: context.maxDepth }
    })
  }

  let canonicalPath: string
  try {
    canonicalPath = await realpath(candidatePath)
  } catch (cause) {
    if (optional) return
    throw new ControlError('ssh.config_unreadable', 'An included SSH config could not be read.', {
      details: { path: candidatePath },
      cause
    })
  }
  const comparisonKey = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath
  if (context.visited.has(comparisonKey)) return
  if (context.visited.size >= context.maxFiles) {
    throw new ControlError('ssh.include_file_limit', 'SSH config includes too many files.', {
      details: { maxFiles: context.maxFiles }
    })
  }

  const info = await lstat(canonicalPath)
  if (!info.isFile()) return
  if (info.size > context.maxFileBytes) {
    throw new ControlError('ssh.config_too_large', 'An SSH config file is too large to parse safely.', {
      details: { path: candidatePath, maxFileBytes: context.maxFileBytes }
    })
  }

  context.visited.add(comparisonKey)
  const source = await readFile(canonicalPath, 'utf8')
  for (const logicalLine of joinContinuationLines(source)) {
    const directive = parseDirective(logicalLine)
    if (!directive) continue

    if (directive.key === 'host') {
      for (const alias of directive.values) {
        if (!isConcreteAlias(alias)) continue
        const sources = context.aliases.get(alias) ?? new Set<string>()
        sources.add(canonicalPath)
        context.aliases.set(alias, sources)
      }
      continue
    }

    if (directive.key !== 'include') continue
    for (const pattern of directive.values) {
      if (context.visited.size >= context.maxFiles) {
        throw new ControlError('ssh.include_file_limit', 'SSH config includes too many files.', {
          details: { maxFiles: context.maxFiles }
        })
      }
      const expandedPattern = resolveIncludePattern(pattern, userHome, context.configRoot)
      const matches = await expandGlob(expandedPattern, context.maxFiles - context.visited.size)
      for (const match of matches) {
        await parseConfigFile(match, depth + 1, userHome, context, true)
      }
    }
  }
}

function parseDirective(line: string): { key: string; values: string[] } | undefined {
  const uncommented = stripComment(line).trim()
  if (!uncommented) return undefined
  const match = /^([A-Za-z][A-Za-z0-9-]*)(?:\s*=\s*|\s+)(.*)$/.exec(uncommented)
  if (!match?.[1]) return undefined
  return { key: match[1].toLowerCase(), values: tokenize(match[2] ?? '') }
}

function stripComment(input: string): string {
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '#') return input.slice(0, index)
  }
  return input
}

function tokenize(input: string): string[] {
  const values: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  for (const character of input) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (quote) {
      if (character === quote) quote = undefined
      else current += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/.test(character)) {
      if (current) {
        values.push(current)
        current = ''
      }
    } else {
      current += character
    }
  }
  if (escaped) current += '\\'
  if (current) values.push(current)
  return values
}

function joinContinuationLines(source: string): string[] {
  const result: string[] = []
  let pending = ''
  for (const line of source.split(/\r?\n/)) {
    const continuation = /(^|[^\\])(\\\\)*\\$/.test(line)
    pending += continuation ? line.slice(0, -1) : line
    if (!continuation) {
      result.push(pending)
      pending = ''
    }
  }
  if (pending) result.push(pending)
  return result
}

function isConcreteAlias(alias: string): boolean {
  return !alias.startsWith('!') && !WILDCARD.test(alias) && SAFE_ALIAS.test(alias) && !alias.startsWith('-')
}

function resolveIncludePattern(pattern: string, userHome: string, configRoot: string): string {
  let expanded = pattern
  if (pattern === '~') expanded = userHome
  else if (pattern.startsWith('~/') || pattern.startsWith('~\\')) {
    expanded = path.join(userHome, pattern.slice(2))
  } else if (pattern.startsWith('~')) {
    // OpenSSH may support ~other-user expansion; the app deliberately does not.
    throw new ControlError('ssh.include_unsupported_home', 'SSH config includes for another user are not supported.', {
      details: { pattern }
    })
  }
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(configRoot, expanded))
}

async function expandGlob(pattern: string, remainingLimit: number): Promise<string[]> {
  if (remainingLimit <= 0) return []
  if (!WILDCARD.test(pattern)) {
    try {
      await access(pattern, fsConstants.R_OK)
      return [pattern]
    } catch {
      return []
    }
  }

  const parsed = path.parse(pattern)
  const segments = pattern.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean)
  let candidates = [parsed.root || '.']

  for (const segment of segments) {
    const matcher = WILDCARD.test(segment) ? globSegmentRegExp(segment) : undefined
    const next: string[] = []
    for (const directory of candidates) {
      if (!matcher) {
        next.push(path.join(directory, segment))
        continue
      }
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (matcher.test(entry.name)) next.push(path.join(directory, entry.name))
        if (next.length >= remainingLimit) break
      }
      if (next.length >= remainingLimit) break
    }
    candidates = next
    if (candidates.length === 0) break
  }

  const files: string[] = []
  for (const candidate of candidates.sort()) {
    try {
      if ((await lstat(candidate)).isFile()) files.push(candidate)
    } catch {
      // A concurrently removed include is equivalent to an unmatched glob.
    }
    if (files.length >= remainingLimit) break
  }
  return files
}

function globSegmentRegExp(segment: string): RegExp {
  let expression = '^'
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index] ?? ''
    if (character === '*') expression += '.*'
    else if (character === '?') expression += '.'
    else if (character === '[') {
      const end = segment.indexOf(']', index + 1)
      if (end > index + 1) {
        const contents = segment.slice(index + 1, end).replace(/\\/g, '\\\\')
        expression += `[${contents.startsWith('!') ? `^${contents.slice(1)}` : contents}]`
        index = end
      } else expression += '\\['
    } else expression += character.replace(/[\\^$+?.()|{}]/g, '\\$&')
  }
  expression += '$'
  return new RegExp(expression, process.platform === 'win32' ? 'i' : '')
}

function formatEffectiveTarget(effective: NonNullable<SshHostAlias['effective']>): string {
  const user = effective.user ? `${effective.user}@` : ''
  const port = effective.port && effective.port !== 22 ? `:${effective.port}` : ''
  return `${user}${effective.hostname}${port}`
}

function redactDiagnostic(value: string): string {
  // SSH diagnostics are useful but can include long paths or banners. Bound it
  // further and strip control characters before it crosses IPC.
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 4_096)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
