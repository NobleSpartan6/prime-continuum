import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { App } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_SUBSCRIPTION_BACKEND_ID,
  CODEX_SUBSCRIPTION_BACKEND_LABEL,
  CODEX_SUBSCRIPTION_CAPABILITY,
} from '../../src/shared/protocol'
import { isOfficialCodexAppServerLoginUrl } from '../../src/shared/codex-app-server-auth'

const { connectLocalHostd } = vi.hoisted(() => ({ connectLocalHostd: vi.fn() }))

vi.mock('../../src/main/control/local-hostd', () => ({
  ensureAndConnectLocalHostd: connectLocalHostd,
  localHostdEndpoint: () => 'test-endpoint',
}))

import { DesktopControlService } from '../../src/main/control/service'

const temporaryDirectories: string[] = []

class TestConnection extends EventEmitter {
  isClosed = false
  readonly requests: Array<{ method: string; payload: unknown }> = []

  constructor(private readonly respond: (method: string, payload: unknown) => unknown) {
    super()
  }

  async request(method: string, payload: unknown): Promise<unknown> {
    this.requests.push({ method, payload })
    return this.respond(method, payload)
  }

  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    this.emit('close')
  }

  terminate(): void {
    this.close()
  }
}

beforeEach(() => connectLocalHostd.mockReset())

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
})

describe('DesktopControlService Codex subscription boundary', () => {
  it('opens the official URL only in main, then returns a fresh redacted account snapshot', async () => {
    const authUrl = validAuthorizationUrl()
    const openExternal = vi.fn(async () => undefined)
    const connection = connectionFor((method) => {
      if (method === 'codex.subscription.login.start') {
        return {
          account: account('opening_browser'),
          authorization: { loginId: 'login-one', operationId: 'login-operation-one', authUrl },
        }
      }
      if (method === 'codex.subscription.account.read') return account('waiting_for_login')
      if (method === 'codex.subscription.login.cancel') return account('signed_out')
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(connection, openExternal)

    const result = await service.codexSubscriptionLoginStart({
      expectedHostId: 'host-a',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'login-operation-one',
    })

    expect(openExternal).toHaveBeenCalledWith(authUrl)
    expect(result).toEqual(account('waiting_for_login'))
    expect(JSON.stringify(result)).not.toMatch(/auth\.openai|redirect_uri|client_id|state=/i)
    expect(connection.requests.map(({ method }) => method)).toEqual([
      'health.get',
      'codex.subscription.login.start',
      'codex.subscription.account.read',
    ])
    await service.disconnect()
  })

  it('rejects an untrusted login URL before shell launch and exposes no destination in the error', async () => {
    const openExternal = vi.fn(async () => undefined)
    const connection = connectionFor((method) => {
      if (method === 'codex.subscription.login.start') {
        return {
          account: account('opening_browser'),
          authorization: {
            loginId: 'login-one',
            operationId: 'login-operation-one',
            authUrl: validAuthorizationUrl('https://attacker.example'),
          },
        }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(connection, openExternal)

    const error = await service.codexSubscriptionLoginStart({
      expectedHostId: 'host-a',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'login-operation-one',
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'protocol.codex_subscription_login_invalid' })
    expect(String((error as Error).message)).not.toContain('attacker.example')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('cancels the exact attempt when the system browser fails without retaining the URL', async () => {
    const openExternal = vi.fn(async () => { throw new Error('provider secret https://auth.openai.com') })
    const connection = connectionFor((method, payload) => {
      if (method === 'codex.subscription.login.start') {
        return {
          account: account('opening_browser'),
          authorization: {
            loginId: 'login-one',
            operationId: 'login-operation-one',
            authUrl: validAuthorizationUrl(),
          },
        }
      }
      if (method === 'codex.subscription.login.cancel') {
        expect(payload).toEqual({
          expectedHostId: 'host-a',
          expectedBackendIncarnationId: 'backend-one',
          loginOperationId: 'login-operation-one',
          loginId: 'login-one',
        })
        return account('signed_out')
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(connection, openExternal)

    const error = await service.codexSubscriptionLoginStart({
      expectedHostId: 'host-a',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'login-operation-one',
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'codex.subscription_browser_failed' })
    expect(String((error as Error).message)).not.toMatch(/auth\.openai|provider secret/i)
    expect(connection.requests.filter(({ method }) => method === 'codex.subscription.login.cancel')).toHaveLength(1)
    await service.disconnect()
  })

  it('waits for an in-flight sign-in identity and cancels it before disconnect closes the host', async () => {
    const startGate = deferred<unknown>()
    const connection = connectionFor((method) => {
      if (method === 'codex.subscription.login.start') return startGate.promise
      if (method === 'codex.subscription.login.cancel') return account('signed_out')
      throw new Error(`Unexpected request: ${method}`)
    })
    const openExternal = vi.fn(async () => undefined)
    const service = await connectedService(connection, openExternal)
    const starting = service.codexSubscriptionLoginStart({
      expectedHostId: 'host-a',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'login-operation-one',
    })
    await waitFor(() => connection.requests.some(({ method }) => method === 'codex.subscription.login.start'))

    const disconnecting = service.disconnect()
    await flushMicrotasks()
    expect(connection.isClosed).toBe(false)
    startGate.resolve({
      account: account('opening_browser'),
      authorization: {
        loginId: 'login-one',
        operationId: 'login-operation-one',
        authUrl: validAuthorizationUrl(),
      },
    })

    await expect(starting).rejects.toMatchObject({ code: 'codex.subscription_transition_in_progress' })
    await disconnecting
    expect(openExternal).not.toHaveBeenCalled()
    expect(connection.requests.filter(({ method }) => method === 'codex.subscription.login.cancel')).toHaveLength(1)
    expect(connection.isClosed).toBe(true)
  })

  it('refuses to drain when cancellation still reports a pending provider login', async () => {
    const connection = connectionFor((method) => {
      if (method === 'codex.subscription.login.start') {
        return {
          account: account('opening_browser'),
          authorization: {
            loginId: 'login-one',
            operationId: 'login-operation-one',
            authUrl: validAuthorizationUrl(),
          },
        }
      }
      if (method === 'codex.subscription.account.read') return account('waiting_for_login')
      if (method === 'codex.subscription.login.cancel') return account('waiting_for_login')
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(connection, async () => undefined)
    await service.codexSubscriptionLoginStart({
      expectedHostId: 'host-a',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'login-operation-one',
    })

    await expect(service.disconnect()).rejects.toMatchObject({
      code: 'codex.subscription_login_drain_unconfirmed',
    })
    expect(connection.requests.filter(({ method }) => method === 'codex.subscription.login.cancel')).toHaveLength(1)
  })

  it('does not retire a public cancellation while the exact login remains pending', async () => {
    const connection = connectionFor((method) => {
      if (method === 'codex.subscription.login.start') {
        return {
          account: account('opening_browser'),
          authorization: {
            loginId: 'login-one',
            operationId: 'login-operation-one',
            authUrl: validAuthorizationUrl(),
          },
        }
      }
      if (method === 'codex.subscription.account.read') return account('waiting_for_login')
      if (method === 'codex.subscription.login.cancel') return account('waiting_for_login')
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(connection, async () => undefined)
    await service.codexSubscriptionLoginStart({
      expectedHostId: 'host-a',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'login-operation-one',
    })

    await expect(service.codexSubscriptionLoginCancel({
      expectedHostId: 'host-a',
      expectedBackendIncarnationId: 'backend-one',
      loginOperationId: 'login-operation-one',
      loginId: 'login-one',
    })).rejects.toMatchObject({ code: 'protocol.codex_subscription_invalid' })
  })

  it('waits for an in-flight account observation and drains the login it discovers', async () => {
    const accountGate = deferred<unknown>()
    const connection = connectionFor((method) => {
      if (method === 'codex.subscription.account.read') return accountGate.promise
      if (method === 'codex.subscription.login.cancel') return account('signed_out')
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(connection, async () => undefined)
    const reading = service.codexSubscriptionAccountRead({ expectedHostId: 'host-a' })
    await waitFor(() => connection.requests.some(({ method }) => method === 'codex.subscription.account.read'))

    const disconnecting = service.disconnect()
    await flushMicrotasks()
    expect(connection.isClosed).toBe(false)
    accountGate.resolve(account('waiting_for_login'))

    await expect(reading).rejects.toMatchObject({ code: 'codex.subscription_transition_in_progress' })
    await disconnecting
    expect(connection.requests.filter(({ method }) => method === 'codex.subscription.login.cancel')).toHaveLength(1)
    expect(connection.isClosed).toBe(true)
  })

  it('serializes a stale account read before admitting a newer provider login', async () => {
    const firstRead = deferred<unknown>()
    let accountReads = 0
    const connection = connectionFor((method) => {
      if (method === 'codex.subscription.account.read') {
        accountReads += 1
        return accountReads === 1 ? firstRead.promise : account('waiting_for_login')
      }
      if (method === 'codex.subscription.login.start') {
        return {
          account: account('opening_browser'),
          authorization: {
            loginId: 'login-one',
            operationId: 'login-operation-one',
            authUrl: validAuthorizationUrl(),
          },
        }
      }
      if (method === 'codex.subscription.login.cancel') return account('signed_out')
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(connection, async () => undefined)
    const reading = service.codexSubscriptionAccountRead({ expectedHostId: 'host-a' })
    await waitFor(() => connection.requests.some(({ method }) => method === 'codex.subscription.account.read'))

    const starting = service.codexSubscriptionLoginStart({
      expectedHostId: 'host-a',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'login-operation-one',
    })
    await flushMicrotasks()
    expect(connection.requests.some(({ method }) => method === 'codex.subscription.login.start')).toBe(false)

    firstRead.resolve(account('signed_out'))
    await expect(reading).resolves.toEqual(account('signed_out'))
    await expect(starting).resolves.toEqual(account('waiting_for_login'))
    expect(connection.requests.map(({ method }) => method)).toEqual([
      'health.get',
      'codex.subscription.account.read',
      'codex.subscription.login.start',
      'codex.subscription.account.read',
    ])
    await service.disconnect()
  })

  it('keeps the live login fenced until a terminal observation is durably committed', async () => {
    let accountReads = 0
    const connection = connectionFor((method) => {
      if (method === 'codex.subscription.login.start') {
        return {
          account: account('opening_browser'),
          authorization: {
            loginId: 'login-one',
            operationId: 'login-operation-one',
            authUrl: validAuthorizationUrl(),
          },
        }
      }
      if (method === 'codex.subscription.account.read') {
        accountReads += 1
        return accountReads === 1 ? account('waiting_for_login') : account('signed_out')
      }
      if (method === 'codex.subscription.login.cancel') return account('signed_out')
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(connection, async () => undefined)
    await service.codexSubscriptionLoginStart({
      expectedHostId: 'host-a',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'login-operation-one',
    })

    const writeStarted = deferred<void>()
    const releaseFailedWrite = deferred<void>()
    const fenceStore = Reflect.get(service, 'codexSubscriptionLoginFences') as {
      update: (operation: (current: unknown) => unknown) => Promise<unknown>
    }
    vi.spyOn(fenceStore, 'update').mockImplementationOnce(async () => {
      writeStarted.resolve(undefined)
      await releaseFailedWrite.promise
      throw new Error('injected durable fence write failure')
    })

    const reading = service.codexSubscriptionAccountRead({ expectedHostId: 'host-a' })
    await writeStarted.promise
    const disconnecting = service.disconnect()
    await flushMicrotasks()
    expect(connection.isClosed).toBe(false)

    releaseFailedWrite.resolve(undefined)
    await expect(reading).rejects.toThrow('injected durable fence write failure')
    await disconnecting
    expect(connection.requests.filter(({ method }) => method === 'codex.subscription.login.cancel')).toHaveLength(1)
    expect(connection.isClosed).toBe(true)
  })

  it('blocks host transitions while a lost sign-in response has no reconciled provider identity', async () => {
    const connection = connectionFor((method) => {
      if (method === 'codex.subscription.login.start') throw new Error('response lost')
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(connection, async () => undefined)

    await expect(service.codexSubscriptionLoginStart({
      expectedHostId: 'host-a',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'login-operation-one',
    })).rejects.toMatchObject({ code: 'codex.subscription_login_start_ambiguous' })
    expect(connection.requests.filter(({ method }) => method === 'codex.subscription.login.start')).toHaveLength(2)
    await expect(service.disconnect()).rejects.toMatchObject({
      code: 'codex.subscription_login_drain_unconfirmed',
    })
    expect(connection.isClosed).toBe(false)
  })

  it('allows transition after a fresh same-authority account read resolves a lost-start ambiguity', async () => {
    let startAttempts = 0
    const connection = connectionFor((method) => {
      if (method === 'codex.subscription.login.start') {
        startAttempts += 1
        throw new Error('response lost')
      }
      if (method === 'codex.subscription.account.read') return account('signed_out')
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(connection, async () => undefined)

    await expect(service.codexSubscriptionLoginStart({
      expectedHostId: 'host-a',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'login-operation-one',
    })).rejects.toMatchObject({ code: 'codex.subscription_login_start_ambiguous' })
    expect(startAttempts).toBe(2)
    await expect(service.codexSubscriptionAccountRead({ expectedHostId: 'host-a' })).resolves.toEqual(
      account('signed_out'),
    )
    await expect(service.disconnect()).resolves.toBeUndefined()
    expect(connection.isClosed).toBe(true)
  })

  it('keeps an unexpected-loss login fence until the exact host is reconnected and observed', async () => {
    const first = connectionFor((method) => {
      if (method === 'codex.subscription.login.start') {
        return {
          account: account('opening_browser'),
          authorization: {
            loginId: 'login-one',
            operationId: 'login-operation-one',
            authUrl: validAuthorizationUrl(),
          },
        }
      }
      if (method === 'codex.subscription.account.read') return account('waiting_for_login')
      throw new Error(`Unexpected request: ${method}`)
    })
    const service = await connectedService(first, async () => undefined)
    await service.codexSubscriptionLoginStart({
      expectedHostId: 'host-a',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'login-operation-one',
    })

    first.close()

    const wrongHost = new TestConnection((method) => {
      if (method === 'health.get') return health('host-b')
      throw new Error(`A different host must not receive ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(wrongHost)
    await expect(service.connect({ kind: 'local' })).rejects.toMatchObject({
      code: 'ssh.host_identity_mismatch',
    })
    expect(wrongHost.requests.map(({ method }) => method)).toEqual(['health.get'])

    const recovered = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'codex.subscription.account.read') return account('signed_out')
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(recovered)
    await expect(service.connect({ kind: 'local' })).resolves.toMatchObject({
      phase: 'online',
      hostId: 'host-a',
    })
    await expect(service.codexSubscriptionLoginStart({
      expectedHostId: 'host-a',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'another-login-operation',
    })).rejects.toMatchObject({ code: 'codex.subscription_login_reconciliation_required' })
    expect(recovered.requests.some(({ method }) => method === 'codex.subscription.login.start')).toBe(false)
    await expect(service.codexSubscriptionAccountRead({ expectedHostId: 'host-a' })).resolves.toEqual(
      account('signed_out'),
    )
    await expect(service.disconnect()).resolves.toBeUndefined()
  })

  it('recovers the login fence after a desktop restart before another authority can bind', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prime-codex-subscription-restart-test-'))
    temporaryDirectories.push(directory)
    await mkdir(path.join(directory, 'control'), { recursive: true })
    const firstConnection = connectionFor((method) => {
      if (method === 'codex.subscription.login.start') {
        return {
          account: account('opening_browser'),
          authorization: {
            loginId: 'login-one',
            operationId: 'login-operation-one',
            authUrl: validAuthorizationUrl(),
          },
        }
      }
      if (method === 'codex.subscription.account.read') return account('waiting_for_login')
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(firstConnection)
    const firstService = new DesktopControlService({
      app: testApp(directory),
      openExternal: async () => undefined,
      platform: 'win32',
    })
    await firstService.connect({ kind: 'local' })
    await firstService.codexSubscriptionLoginStart({
      expectedHostId: 'host-a',
      expectedBackendIncarnationId: 'backend-one',
      operationId: 'login-operation-one',
    })
    const fencePath = path.join(directory, 'control', 'codex-subscription-login-fences.json')
    expect(JSON.parse(await readFile(fencePath, 'utf8'))).toMatchObject({
      version: 1,
      entries: [{
        expectedHostId: 'host-a',
        backendIncarnationId: 'backend-one',
        loginOperationId: 'login-operation-one',
        loginId: 'login-one',
      }],
    })

    // Construct a fresh main-process service without closing the detached
    // first host connection, mirroring an Electron crash/relaunch.
    const restarted = new DesktopControlService({
      app: testApp(directory),
      openExternal: async () => undefined,
      platform: 'win32',
    })
    await restarted.bootstrap()
    const wrongHost = new TestConnection((method) => {
      if (method === 'health.get') return health('host-b')
      throw new Error(`A different host must not receive ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(wrongHost)
    await expect(restarted.connect({ kind: 'local' })).rejects.toMatchObject({
      code: 'ssh.host_identity_mismatch',
    })
    expect(wrongHost.requests.map(({ method }) => method)).toEqual(['health.get'])

    const recovered = new TestConnection((method) => {
      if (method === 'health.get') return health('host-a')
      if (method === 'codex.subscription.account.read') return account('signed_out')
      throw new Error(`Unexpected request: ${method}`)
    })
    connectLocalHostd.mockResolvedValueOnce(recovered)
    await restarted.connect({ kind: 'local' })
    await restarted.codexSubscriptionAccountRead({ expectedHostId: 'host-a' })
    expect(JSON.parse(await readFile(fencePath, 'utf8'))).toEqual({ version: 1, entries: [] })
    await restarted.disconnect()
  })

  it('fails closed off Windows before contacting the Codex backend', async () => {
    const connection = connectionFor((method) => { throw new Error(`Unexpected request: ${method}`) })
    const service = await connectedService(connection, async () => undefined, 'linux')

    await expect(service.codexSubscriptionAccountRead({ expectedHostId: 'host-a' })).rejects.toMatchObject({
      code: 'codex.subscription_windows_required',
    })
    expect(connection.requests.map(({ method }) => method)).toEqual(['health.get'])
    await service.disconnect()
  })
})

function account(phase: 'opening_browser' | 'waiting_for_login' | 'signed_out') {
  return {
    backend: {
      id: CODEX_SUBSCRIPTION_BACKEND_ID,
      kind: 'codex_subscription' as const,
      label: CODEX_SUBSCRIPTION_BACKEND_LABEL,
    },
    backendIncarnationId: 'backend-one',
    phase,
    ...(phase === 'opening_browser' || phase === 'waiting_for_login'
      ? { pendingLoginId: 'login-one', pendingLoginOperationId: 'login-operation-one' }
      : {}),
    executionPolicy: {
      filesystem: 'read_only_user_scope' as const,
      workspaceReadConfinement: false as const,
      toolNetworkAccess: false as const,
      approvalPolicy: 'never' as const,
      disclosure: 'Codex tools cannot write files or open network connections. They may read other files available to your Windows account; this is not a workspace-only sandbox. Prompts and content Codex reads—including workspace instructions and tool-read files—are sent to OpenAI for the turn.' as const,
    },
    turnReadiness: phase === 'signed_out'
      ? { state: 'unavailable' as const, reason: 'account_required' as const }
      : { state: 'unavailable' as const, reason: 'login_in_progress' as const },
    updatedAt: '2026-08-09T12:00:00.000Z',
  }
}

function validAuthorizationUrl(origin = 'https://auth.openai.com'): string {
  const url = new URL('/oauth/authorize', origin)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', 'app_EMoamEEZ73f0CkXaXp7hrann')
  url.searchParams.set('redirect_uri', 'http://localhost:1455/auth/callback')
  url.searchParams.set('scope', 'openid profile email offline_access api.connectors.read api.connectors.invoke')
  url.searchParams.set('code_challenge', 'A'.repeat(43))
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', 'B'.repeat(43))
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', 'prime_continuim')
  return url.toString()
}

describe('signed Codex 0.147 authorization allowlist', () => {
  it('accepts only the exact captured query contract', () => {
    const captured = validAuthorizationUrl()
    expect(isOfficialCodexAppServerLoginUrl(captured)).toBe(true)

    const omitted = new URL(captured)
    omitted.searchParams.delete('originator')
    expect(isOfficialCodexAppServerLoginUrl(omitted.toString())).toBe(false)

    const extra = new URL(captured)
    extra.searchParams.set('unexpected', 'true')
    expect(isOfficialCodexAppServerLoginUrl(extra.toString())).toBe(false)

    const duplicate = new URL(captured)
    duplicate.searchParams.append('state', 'C'.repeat(43))
    expect(isOfficialCodexAppServerLoginUrl(duplicate.toString())).toBe(false)
  })
})

function connectionFor(respond: (method: string, payload: unknown) => unknown): TestConnection {
  return new TestConnection((method, payload) => method === 'health.get' ? health() : respond(method, payload))
}

async function connectedService(
  connection: TestConnection,
  openExternal: (url: string) => Promise<void>,
  platform: NodeJS.Platform = 'win32',
): Promise<DesktopControlService> {
  const directory = await mkdtemp(path.join(tmpdir(), 'prime-codex-subscription-test-'))
  temporaryDirectories.push(directory)
  await mkdir(path.join(directory, 'control'), { recursive: true })
  connectLocalHostd.mockResolvedValue(connection)
  const service = new DesktopControlService({ app: testApp(directory), openExternal, platform })
  await service.connect({ kind: 'local' })
  return service
}

function health(hostId = 'host-a') {
  return {
    protocolVersion: 1,
    hostdVersion: '0.1.0',
    startedAt: '2026-08-09T11:00:00.000Z',
    checkedAt: '2026-08-09T11:00:01.000Z',
    serviceState: 'ready',
    host: { hostId },
    capabilities: [CODEX_SUBSCRIPTION_CAPABILITY],
  }
}

function testApp(directory: string): App {
  return { getPath: () => directory, getVersion: () => '0.1.0' } as unknown as App
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Codex subscription test state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
