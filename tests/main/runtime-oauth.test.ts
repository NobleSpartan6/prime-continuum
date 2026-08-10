import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { App } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeOAuthAttemptTerminalV1,
  createRuntimeOAuthAttemptV1,
  type RuntimeOAuthAttemptV1,
} from "../../src/shared/runtime-oauth-attempt";

const { connectLocalHostd, connectSshHost } = vi.hoisted(() => ({
  connectLocalHostd: vi.fn(),
  connectSshHost: vi.fn(),
}));

vi.mock("../../src/main/control/local-hostd", () => ({
  connectSshHost,
  ensureAndConnectLocalHostd: connectLocalHostd,
  localHostdEndpoint: () => "test-endpoint",
}));

import { DesktopControlService } from "../../src/main/control/service";
import { RuntimeOAuthDesktopAttemptStore } from "../../src/main/control/runtime-oauth-attempt-store";

const temporaryDirectories: string[] = [];

class TestConnection extends EventEmitter {
  isClosed = false;
  readonly requests: Array<{ method: string; params: unknown }> = [];

  constructor(private readonly respond: (method: string, params: unknown) => unknown) {
    super();
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return await this.respond(method, params);
  }

  close(): void {
    this.isClosed = true;
  }

  terminate(): void {
    this.close();
  }
}

beforeEach(() => {
  connectLocalHostd.mockReset();
  connectSshHost.mockReset();
});

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

describe("DesktopControlService durable runtime OAuth attempts", () => {
  it("refuses a legacy-only host before creating or dispatching an attempt", async () => {
    const connection = connectionFor(
      (method) => { throw new Error(`Unexpected request: ${method}`); },
      health("host-a", ["runtime_oauth_v1"]),
    );
    const fixture = await connectedService(connection, async () => undefined);

    await expect(fixture.service.startRuntimeOAuth("host-a", "openai-codex")).rejects.toMatchObject({
      code: "runtime.oauth_unavailable",
    });
    expect(connection.requests.some(({ method }) => method.startsWith("oauth."))).toBe(false);
    expect(await readAttemptLedger(fixture.directory)).toEqual({ version: 1, attempts: [] });
    await fixture.service.disconnect();
  });

  it("persists pre-dispatch, sends one exact start, and opens only after browser_dispatching is durable", async () => {
    const authorizationUrl = validAuthorizationUrl();
    let directory = "";
    let attempt!: RuntimeOAuthAttemptV1;
    const connection = connectionFor(async (method, params) => {
      if (method !== "oauth.attempt.start") throw new Error(`Unexpected request: ${method}`);
      expect(Object.keys(params as object).sort()).toEqual(["attempt", "authorityId"]);
      expect((params as { authorityId: string }).authorityId).toMatch(/^desktop-oauth-/);
      attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
      const ledger = await readAttemptLedger(directory);
      expect(ledger.attempts).toEqual([
        expect.objectContaining({ attempt, phase: "start_dispatching", revision: 2 }),
      ]);
      const record = activeRecord(attempt);
      return boundResult(record, liveSnapshot(record, authorizationUrl));
    });
    const openExternal = vi.fn(async (url: string) => {
      expect(url).toBe(authorizationUrl);
      const ledger = await readAttemptLedger(directory);
      expect(ledger.attempts[0]).toMatchObject({
        attempt,
        phase: "browser_dispatching",
        hostSessionId: "oauth-session-1",
        hostPhase: "login_dispatching",
      });
    });
    const fixture = await connectedService(connection, openExternal);
    directory = fixture.directory;

    const view = await fixture.service.startRuntimeOAuth("host-a", "openai-codex");

    expect(connection.requests.filter(({ method }) => method === "oauth.attempt.start")).toHaveLength(1);
    expect(connection.requests.some(({ method }) => method.startsWith("oauth.session."))).toBe(false);
    expect(openExternal).toHaveBeenCalledOnce();
    expect(view).toEqual({
      sessionId: "oauth-session-1",
      providerId: "openai-codex",
      phase: "awaiting_user",
      expiresAt: expiresAt(attempt),
      interaction: { kind: "browser", state: "opened" },
    });
    const ledger = await readAttemptLedger(directory);
    expect(ledger.attempts[0]).toMatchObject({ phase: "observing", revision: 6, attempt });
    expect(JSON.stringify({ view, ledger })).not.toMatch(/auth\.openai|code_challenge|refresh_token|access_token/i);
    await fixture.service.disconnect();
    expect(connection.requests.some(({ method }) => method === "oauth.attempt.cancel")).toBe(false);
  });

  it("recovers a lost start response only through status and never replays start", async () => {
    let attempt!: RuntimeOAuthAttemptV1;
    const authorizationUrl = validAuthorizationUrl();
    const connection = connectionFor((method, params) => {
      if (method === "oauth.attempt.start") {
        attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
        throw new Error("response lost after durable admission");
      }
      if (method === "oauth.attempt.status") {
        expect(params).toEqual({ attempt });
        const record = activeRecord(attempt);
        return boundResult(record, liveSnapshot(record, authorizationUrl));
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const openExternal = vi.fn(async () => undefined);
    const fixture = await connectedService(connection, openExternal);

    await expect(fixture.service.startRuntimeOAuth("host-a", "openai-codex")).resolves.toMatchObject({
      sessionId: "oauth-session-1",
      interaction: { kind: "browser", state: "opened" },
    });
    expect(connection.requests.filter(({ method }) => method === "oauth.attempt.start")).toHaveLength(1);
    expect(connection.requests.filter(({ method }) => method === "oauth.attempt.status")).toHaveLength(1);
    await fixture.service.disconnect();
  });

  it("terminalizes same-connection null after one lost start request without replay", async () => {
    let attempt!: RuntimeOAuthAttemptV1;
    const connection = connectionFor((method, params) => {
      if (method === "oauth.attempt.start") {
        attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
        throw new Error("start response lost before host retention");
      }
      if (method === "oauth.attempt.status") {
        expect(params).toEqual({ attempt });
        return { attemptDigest: attempt.attemptDigest, record: null };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const fixture = await connectedService(connection, async () => undefined);

    await expect(fixture.service.startRuntimeOAuth("host-a", "openai-codex")).rejects.toMatchObject({
      code: "runtime.oauth_start_failed",
    });
    expect(connection.requests.filter(({ method }) => method === "oauth.attempt.start")).toHaveLength(1);
    expect(connection.requests.filter(({ method }) => method === "oauth.attempt.status")).toHaveLength(1);
    expect((await readAttemptLedger(fixture.directory)).attempts[0]).toMatchObject({
      phase: "failed",
      terminal: {
        body: {
          phase: "failed",
          resolution: "interrupted_before_login_dispatch",
          configuredObserved: null,
        },
      },
    });
    await fixture.service.disconnect();
  });

  it("allows the fresh process to dispatch a URL first observed by later status", async () => {
    let attempt!: RuntimeOAuthAttemptV1;
    const authorizationUrl = validAuthorizationUrl();
    const connection = connectionFor((method, params) => {
      if (method === "oauth.attempt.start") {
        attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
        const record = activeRecord(attempt);
        return boundResult(record, {
          ...liveSnapshot(record),
          challenge: {
            id: "manual-redirect-1",
            kind: "manual_redirect",
            message: "Finish sign-in in the provider window.",
            allowEmpty: false,
          },
        });
      }
      if (method === "oauth.attempt.status") {
        const record = activeRecord(attempt);
        return boundResult(record, liveSnapshot(record, authorizationUrl));
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const openExternal = vi.fn(async () => undefined);
    const fixture = await connectedService(connection, openExternal);

    await expect(fixture.service.startRuntimeOAuth("host-a", "openai-codex")).resolves.toMatchObject({
      interaction: { kind: "manual", state: "unavailable" },
    });
    expect(openExternal).not.toHaveBeenCalled();
    await expect(fixture.service.runtimeOAuthStatus("host-a", "oauth-session-1")).resolves.toMatchObject({
      interaction: { kind: "browser", state: "opened" },
    });
    expect(openExternal).toHaveBeenCalledOnce();
    expect(connection.requests.filter(({ method }) => method === "oauth.attempt.start")).toHaveLength(1);
    await fixture.service.disconnect();
  });

  it("keeps local browser time monotonic when the host completes while openExternal is pending", async () => {
    let attempt!: RuntimeOAuthAttemptV1;
    let terminal!: ReturnType<typeof completedRecord>;
    let releaseBrowser!: () => void;
    const browserPending = new Promise<void>((resolve) => { releaseBrowser = resolve; });
    let markBrowserEntered!: () => void;
    const browserEntered = new Promise<void>((resolve) => { markBrowserEntered = resolve; });
    const connection = connectionFor((method, params) => {
      if (method === "oauth.attempt.start") {
        attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
        const record = activeRecord(attempt);
        return boundResult(record, liveSnapshot(record, validAuthorizationUrl()));
      }
      if (method === "oauth.attempt.status") return boundResult(terminal);
      if (method === "oauth.attempt.acknowledge") {
        expect(params).toMatchObject({
          attempt,
          expectedRevision: terminal.revision,
          terminalDigest: terminal.terminal.terminalDigest,
          acknowledgedAt: terminal.terminal.body.terminalAt,
        });
        return boundResult(acknowledgedRecord(terminal));
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const openExternal = vi.fn(async () => {
      markBrowserEntered();
      await browserPending;
    });
    const fixture = await connectedService(connection, openExternal);

    const started = fixture.service.startRuntimeOAuth("host-a", "openai-codex");
    await Promise.race([
      browserEntered,
      started.then(
        () => { throw new Error("OAuth start completed before entering openExternal"); },
        (error: unknown) => { throw error; },
      ),
    ]);
    const dispatchingUpdatedAt = (await readAttemptLedger(fixture.directory)).attempts[0]!.updatedAt as string;
    await waitUntilAfter(dispatchingUpdatedAt);
    terminal = completedRecord(attempt, dispatchingUpdatedAt);
    releaseBrowser();
    await expect(started).resolves.toMatchObject({ phase: "awaiting_user" });
    const browserUpdatedAt = (await readAttemptLedger(fixture.directory)).attempts[0]!.updatedAt as string;
    expect(Date.parse(browserUpdatedAt)).toBeGreaterThan(Date.parse(terminal.terminal.body.terminalAt));

    await expect(fixture.service.runtimeOAuthStatus("host-a", "oauth-session-1")).resolves.toMatchObject({
      phase: "completed",
      configured: true,
    });
    expect((await readAttemptLedger(fixture.directory)).attempts[0]).toMatchObject({
      phase: "completed",
      updatedAt: browserUpdatedAt,
      terminal: terminal.terminal,
      hostAckConfirmedAt: terminal.terminal.body.terminalAt,
    });
    expect(connection.isClosed).toBe(false);
    await fixture.service.disconnect();
  });

  it("restarts an ambiguous start with status only and never reopens its browser", async () => {
    let attempt!: RuntimeOAuthAttemptV1;
    const firstConnection = connectionFor((method, params) => {
      if (method === "oauth.attempt.start") {
        attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
        throw new Error("response lost");
      }
      if (method === "oauth.attempt.status") throw new Error("connection lost");
      throw new Error(`Unexpected request: ${method}`);
    });
    const first = await connectedService(firstConnection, async () => undefined);
    await expect(first.service.startRuntimeOAuth("host-a", "openai-codex")).rejects.toMatchObject({
      code: "runtime.oauth_start_ambiguous",
    });
    await first.service.disconnect();

    const record = activeRecord(attempt);
    const secondConnection = connectionFor((method, params) => {
      if (method === "oauth.attempt.status") {
        expect(params).toEqual({ attempt });
        return boundResult(record, liveSnapshot(record, validAuthorizationUrl()));
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const openExternal = vi.fn(async () => undefined);
    const second = await bootstrappedService(secondConnection, openExternal, first.directory);
    const admitted = observeNextRuntimeOAuthAcceptance(second.service, "host_admitted");
    await second.service.connect({ kind: "local" });
    await admitted;

    await expect(second.service.runtimeOAuthStatus("host-a", "oauth-session-1")).resolves.toMatchObject({
      phase: "awaiting_user",
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(secondConnection.requests.some(({ method }) =>
      method === "oauth.attempt.start" || method === "oauth.attempt.cancel"
    )).toBe(false);
    expect((await readAttemptLedger(first.directory)).attempts[0]).toMatchObject({ phase: "host_admitted" });
    await second.service.disconnect();
  });

  it("retains a start-dispatch barrier when replacement status returns null and never replays start", async () => {
    let attempt!: RuntimeOAuthAttemptV1;
    const firstConnection = connectionFor((method, params) => {
      if (method === "oauth.attempt.start") {
        attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
        throw new Error("start response lost on the old connection");
      }
      if (method === "oauth.attempt.status") throw new Error("old connection unavailable");
      throw new Error(`Unexpected request: ${method}`);
    });
    const first = await connectedService(firstConnection, async () => undefined);
    await expect(first.service.startRuntimeOAuth("host-a", "openai-codex")).rejects.toMatchObject({
      code: "runtime.oauth_start_ambiguous",
    });
    expect((await readAttemptLedger(first.directory)).attempts[0]).toMatchObject({
      phase: "start_dispatching",
    });
    await first.service.disconnect();

    const replacementConnection = connectionFor((method, params) => {
      if (method === "oauth.attempt.status") {
        expect(params).toEqual({ attempt });
        return { attemptDigest: attempt.attemptDigest, record: null };
      }
      throw new Error(`Replacement must remain status-only, received ${method}`);
    });
    const replacement = await bootstrappedService(
      replacementConnection,
      async () => undefined,
      first.directory,
    );
    const absenceAccepted = observeNextRuntimeOAuthAcceptance(replacement.service, "start_dispatching");
    await replacement.service.connect({ kind: "local" });
    await absenceAccepted;

    expect(replacementConnection.requests.filter(({ method }) => method === "oauth.attempt.status"))
      .toHaveLength(1);
    const absentBarrier = (await readAttemptLedger(first.directory)).attempts[0]!;
    expect(absentBarrier).toMatchObject({ phase: "start_dispatching" });
    expect(absentBarrier).not.toHaveProperty("hostSessionId");
    expect(replacementConnection.requests.some(({ method }) => method === "oauth.attempt.start")).toBe(false);
    await expect(replacement.service.startRuntimeOAuth("host-a", "openai-codex")).rejects.toMatchObject({
      code: "runtime.oauth_attempt_active",
    });
    expect(replacementConnection.requests.some(({ method }) => method === "oauth.attempt.start")).toBe(false);
    await replacement.service.disconnect();

    const retained = activeRecord(attempt);
    const laterConnection = connectionFor((method, params) => {
      if (method === "oauth.attempt.status") {
        expect(params).toEqual({ attempt });
        return boundResult(retained, liveSnapshot(retained));
      }
      throw new Error(`Later recovery must remain status-only, received ${method}`);
    });
    const later = await bootstrappedService(laterConnection, async () => undefined, first.directory);
    const retainedAccepted = observeNextRuntimeOAuthAcceptance(later.service, "host_admitted");
    await later.service.connect({ kind: "local" });
    await retainedAccepted;
    expect((await readAttemptLedger(first.directory)).attempts[0]).toMatchObject({
      phase: "host_admitted",
      hostSessionId: retained.sessionId,
      hostPhase: "login_dispatching",
    });
    expect(laterConnection.requests.some(({ method }) => method === "oauth.attempt.start")).toBe(false);
    await later.service.disconnect();
  });

  it("terminalizes a restarted prepared attempt when replacement status confirms absence", async () => {
    const directory = await temporaryDirectory();
    const storePath = path.join(directory, "control", "runtime-oauth-attempts.json");
    await mkdir(path.dirname(storePath), { recursive: true });
    const store = new RuntimeOAuthDesktopAttemptStore(storePath);
    await store.initialize();
    const attempt = createRuntimeOAuthAttemptV1({
      version: 1,
      expectedHostId: "host-a",
      providerId: "openai-codex",
      operationId: "78787878-7878-4878-8878-787878787878",
      requestedAt: "2026-08-10T12:00:00.000Z",
    });
    await store.prepare(attempt, attempt.identity.requestedAt);
    const replacementConnection = connectionFor((method, params) => {
      if (method === "oauth.attempt.status") {
        expect(params).toEqual({ attempt });
        return { attemptDigest: attempt.attemptDigest, record: null };
      }
      throw new Error(`Replacement must remain status-only, received ${method}`);
    });

    const replacement = await bootstrappedService(replacementConnection, async () => undefined, directory);
    const absenceAccepted = observeNextRuntimeOAuthAcceptance(replacement.service, "failed");
    await replacement.service.connect({ kind: "local" });
    await absenceAccepted;
    expect((await readAttemptLedger(directory)).attempts[0]).toMatchObject({
      phase: "failed",
      terminal: {
        body: {
          phase: "failed",
          resolution: "interrupted_before_login_dispatch",
          configuredObserved: null,
        },
      },
    });
    expect(replacementConnection.requests.some(({ method }) => method === "oauth.attempt.start")).toBe(false);
    await replacement.service.disconnect();
  });

  it("retains browser_dispatching after an ambiguous shell failure and reconciles by status only", async () => {
    let attempt!: RuntimeOAuthAttemptV1;
    const connection = connectionFor((method, params) => {
      if (method === "oauth.attempt.start") {
        attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
        const record = activeRecord(attempt);
        return boundResult(record, liveSnapshot(record, validAuthorizationUrl()));
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const fixture = await connectedService(connection, async () => { throw new Error("shell failure"); });

    await expect(fixture.service.startRuntimeOAuth("host-a", "openai-codex")).rejects.toMatchObject({
      code: "runtime.oauth_browser_failed",
    });
    expect((await readAttemptLedger(fixture.directory)).attempts[0]).toMatchObject({
      phase: "browser_dispatching",
    });
    expect(connection.requests.some(({ method }) => method === "oauth.attempt.cancel")).toBe(false);
    await fixture.service.disconnect();

    const restartedConnection = connectionFor((method) => {
      if (method === "oauth.attempt.status") {
        const record = activeRecord(attempt);
        return boundResult(record, liveSnapshot(record, validAuthorizationUrl()));
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const restartedOpen = vi.fn(async () => undefined);
    const restarted = await bootstrappedService(restartedConnection, restartedOpen, fixture.directory);
    const reconciled = observeNextRuntimeOAuthAcceptance(restarted.service, "browser_dispatching");
    await restarted.service.connect({ kind: "local" });
    await reconciled;
    expect(restartedOpen).not.toHaveBeenCalled();
    expect(restartedConnection.requests.every(({ method }) =>
      method === "health.get" || method === "oauth.attempt.status"
    )).toBe(true);
    await restarted.service.disconnect();
  });

  it("persists terminal evidence and acknowledges the exact host predecessor", async () => {
    let attempt!: RuntimeOAuthAttemptV1;
    let terminal!: ReturnType<typeof completedRecord>;
    const connection = connectionFor((method, params) => {
      if (method === "oauth.attempt.start") {
        attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
        const record = activeRecord(attempt);
        return boundResult(record, liveSnapshot(record, validAuthorizationUrl()));
      }
      if (method === "oauth.attempt.status") {
        terminal = completedRecord(attempt);
        return boundResult(terminal);
      }
      if (method === "oauth.attempt.acknowledge") {
        expect(params).toEqual({
          attempt,
          expectedRevision: 4,
          terminalDigest: terminal.terminal.terminalDigest,
          acknowledgedAt: terminal.terminal.body.terminalAt,
        });
        return boundResult(acknowledgedRecord(terminal));
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const fixture = await connectedService(connection, async () => undefined);
    await fixture.service.startRuntimeOAuth("host-a", "openai-codex");

    await expect(fixture.service.runtimeOAuthStatus("host-a", "oauth-session-1")).resolves.toEqual({
      sessionId: "oauth-session-1",
      providerId: "openai-codex",
      phase: "completed",
      expiresAt: expiresAt(attempt),
      configured: true,
    });
    expect(connection.requests.filter(({ method }) => method === "oauth.attempt.acknowledge")).toHaveLength(1);
    expect((await readAttemptLedger(fixture.directory)).attempts[0]).toMatchObject({
      phase: "completed",
      terminal: terminal.terminal,
      hostAckConfirmedAt: terminal.terminal.body.terminalAt,
    });
    await fixture.service.disconnect();
  });

  it("recovers a lost acknowledgement from the read-only N+1 status successor", async () => {
    let attempt!: RuntimeOAuthAttemptV1;
    let terminal!: ReturnType<typeof completedRecord>;
    let statusCount = 0;
    const connection = connectionFor((method, params) => {
      if (method === "oauth.attempt.start") {
        attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
        const record = activeRecord(attempt);
        return boundResult(record, liveSnapshot(record, validAuthorizationUrl()));
      }
      if (method === "oauth.attempt.status") {
        terminal ??= completedRecord(attempt);
        statusCount += 1;
        return statusCount === 1 ? boundResult(terminal) : boundResult(acknowledgedRecord(terminal));
      }
      if (method === "oauth.attempt.acknowledge") {
        expect((params as { expectedRevision: number }).expectedRevision).toBe(4);
        throw new Error("ack response lost after commit");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const fixture = await connectedService(connection, async () => undefined);
    await fixture.service.startRuntimeOAuth("host-a", "openai-codex");

    await expect(fixture.service.runtimeOAuthStatus("host-a", "oauth-session-1")).resolves.toMatchObject({
      phase: "completed",
      configured: true,
    });
    expect(connection.requests.filter(({ method }) => method === "oauth.attempt.acknowledge")).toHaveLength(1);
    expect(connection.requests.filter(({ method }) => method === "oauth.attempt.status")).toHaveLength(2);
    expect((await readAttemptLedger(fixture.directory)).attempts[0]).toMatchObject({
      hostAckConfirmedAt: terminal.terminal.body.terminalAt,
    });
    await fixture.service.disconnect();
  });

  it("rejects and terminates on a changed preexisting acknowledgement timestamp", async () => {
    let attempt!: RuntimeOAuthAttemptV1;
    const connection = connectionFor((method, params) => {
      if (method === "oauth.attempt.start") {
        attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
        const record = activeRecord(attempt);
        return boundResult(record, liveSnapshot(record, validAuthorizationUrl()));
      }
      if (method === "oauth.attempt.status") {
        const terminal = completedRecord(attempt);
        const changedAt = shiftTimestamp(terminal.terminal.body.terminalAt, 1);
        return boundResult({
          ...terminal,
          revision: 5,
          updatedAt: changedAt,
          desktopAcknowledgedAt: changedAt,
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const fixture = await connectedService(connection, async () => undefined);
    await fixture.service.startRuntimeOAuth("host-a", "openai-codex");

    await expect(fixture.service.runtimeOAuthStatus("host-a", "oauth-session-1")).rejects.toMatchObject({
      code: "protocol.oauth_acknowledgement_invalid",
    });
    expect(connection.isClosed).toBe(true);
  });

  it("rejects a false active cancel result through the method-specific parser", async () => {
    let attempt!: RuntimeOAuthAttemptV1;
    const connection = connectionFor((method, params) => {
      if (method === "oauth.attempt.start") {
        attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
        const record = activeRecord(attempt);
        return boundResult(record, liveSnapshot(record, validAuthorizationUrl()));
      }
      if (method === "oauth.attempt.cancel") {
        const active = {
          ...activeRecord(attempt),
          revision: 2,
          phase: "cancelling" as const,
        };
        return boundResult(active, liveSnapshot(active));
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const fixture = await connectedService(connection, async () => undefined);
    await fixture.service.startRuntimeOAuth("host-a", "openai-codex");

    await expect(fixture.service.cancelRuntimeOAuth("host-a", "oauth-session-1")).rejects.toMatchObject({
      code: "protocol.oauth_attempt_cancel_invalid",
    });
    expect(connection.requests.filter(({ method }) => method === "oauth.attempt.cancel")).toHaveLength(1);
    expect(connection.requests.filter(({ method }) => method === "oauth.attempt.status")).toHaveLength(0);
    await fixture.service.disconnect();
  });

  it("rejects a false terminal start result through the method-specific parser", async () => {
    const connection = connectionFor((method, params) => {
      if (method === "oauth.attempt.start") {
        const attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
        return boundResult(completedRecord(attempt));
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const openExternal = vi.fn(async () => undefined);
    const fixture = await connectedService(connection, openExternal);

    await expect(fixture.service.startRuntimeOAuth("host-a", "openai-codex")).rejects.toMatchObject({
      code: "protocol.oauth_attempt_start_invalid",
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(connection.isClosed).toBe(true);
    expect(connection.requests.filter(({ method }) => method === "oauth.attempt.start")).toHaveLength(1);
  });

  it("rejects a false unacknowledged ack result through the method-specific parser", async () => {
    let attempt!: RuntimeOAuthAttemptV1;
    let terminal!: ReturnType<typeof completedRecord>;
    const connection = connectionFor((method, params) => {
      if (method === "oauth.attempt.start") {
        attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
        const record = activeRecord(attempt);
        return boundResult(record, liveSnapshot(record, validAuthorizationUrl()));
      }
      if (method === "oauth.attempt.status") {
        terminal = completedRecord(attempt);
        return boundResult(terminal);
      }
      if (method === "oauth.attempt.acknowledge") return boundResult(terminal);
      throw new Error(`Unexpected request: ${method}`);
    });
    const fixture = await connectedService(connection, async () => undefined);
    await fixture.service.startRuntimeOAuth("host-a", "openai-codex");

    await expect(fixture.service.runtimeOAuthStatus("host-a", "oauth-session-1")).rejects.toMatchObject({
      code: "protocol.oauth_attempt_acknowledge_invalid",
    });
    const retained = (await readAttemptLedger(fixture.directory)).attempts[0]!;
    expect(retained).toMatchObject({ phase: "completed" });
    expect(retained).not.toHaveProperty("hostAckConfirmedAt");
    await fixture.service.disconnect();
  });

  it("never replays cancellation after its durable dispatch barrier", async () => {
    let attempt!: RuntimeOAuthAttemptV1;
    let statusReads = 0;
    const connection = connectionFor((method, params) => {
      if (method === "oauth.attempt.start") {
        attempt = (params as { attempt: RuntimeOAuthAttemptV1 }).attempt;
        const record = activeRecord(attempt);
        return boundResult(record, liveSnapshot(record, validAuthorizationUrl()));
      }
      if (method === "oauth.attempt.cancel") throw new Error("cancel response lost");
      if (method === "oauth.attempt.status") {
        statusReads += 1;
        const cancelling = { ...activeRecord(attempt), revision: 2, phase: "cancelling" as const };
        return boundResult(cancelling, liveSnapshot(cancelling));
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const fixture = await connectedService(connection, async () => undefined);
    await fixture.service.startRuntimeOAuth("host-a", "openai-codex");

    await expect(fixture.service.cancelRuntimeOAuth("host-a", "oauth-session-1")).resolves.toMatchObject({
      sessionId: "oauth-session-1",
    });
    await expect(fixture.service.cancelRuntimeOAuth("host-a", "oauth-session-1")).resolves.toMatchObject({
      sessionId: "oauth-session-1",
    });
    expect(connection.requests.filter(({ method }) => method === "oauth.attempt.cancel")).toHaveLength(1);
    expect(statusReads).toBe(2);
    expect((await readAttemptLedger(fixture.directory)).attempts[0]).toMatchObject({
      phase: "cancel_dispatching",
    });
    await fixture.service.disconnect();
  });

  it("keeps core bootstrap/connect online when only the OAuth journal is malformed", async () => {
    const directory = await temporaryDirectory();
    await mkdir(path.join(directory, "control"), { recursive: true });
    await writeFile(
      path.join(directory, "control", "runtime-oauth-attempts.json"),
      JSON.stringify({ version: 1, attempts: [{ secretPath: "C:\\private\\oauth.json" }] }),
      "utf8",
    );
    const connection = connectionFor((method) => { throw new Error(`Unexpected request: ${method}`); });
    connectLocalHostd.mockResolvedValue(connection);
    const service = new DesktopControlService({ app: testApp(directory), openExternal: async () => undefined });

    await expect(service.bootstrap()).resolves.toMatchObject({ appVersion: "0.1.0" });
    await expect(service.connect({ kind: "local" })).resolves.toMatchObject({ phase: "online", hostId: "host-a" });
    await expect(service.startRuntimeOAuth("host-a", "openai-codex")).rejects.toMatchObject({
      code: "runtime.oauth_attempt_store_unavailable",
    });
    expect(connection.requests.some(({ method }) => method.startsWith("oauth."))).toBe(false);
    await service.disconnect();
  });
});

function connectionFor(
  respond: (method: string, params: unknown) => unknown,
  healthResponse = health(),
): TestConnection {
  return new TestConnection((method, params) => {
    if (method === "health.get") return healthResponse;
    return respond(method, params);
  });
}

async function connectedService(
  connection: TestConnection,
  openExternal: (url: string) => Promise<void>,
  existingDirectory?: string,
): Promise<{ service: DesktopControlService; directory: string }> {
  const fixture = await bootstrappedService(connection, openExternal, existingDirectory);
  await fixture.service.connect({ kind: "local" });
  return fixture;
}

async function bootstrappedService(
  connection: TestConnection,
  openExternal: (url: string) => Promise<void>,
  existingDirectory?: string,
): Promise<{ service: DesktopControlService; directory: string }> {
  const directory = existingDirectory ?? await temporaryDirectory();
  await mkdir(path.join(directory, "control"), { recursive: true });
  connectLocalHostd.mockResolvedValue(connection);
  const service = new DesktopControlService({ app: testApp(directory), openExternal });
  await service.bootstrap();
  return { service, directory };
}

function observeNextRuntimeOAuthAcceptance(
  service: DesktopControlService,
  expectedDesktopPhase: string,
): Promise<void> {
  const internals = service as unknown as {
    acceptRuntimeOAuthAttemptResult: (...args: unknown[]) => Promise<{ desktop: { phase: string } }>;
  };
  const original = internals.acceptRuntimeOAuthAttemptResult.bind(service);
  let resolveObservation!: () => void;
  let rejectObservation!: (reason?: unknown) => void;
  const observation = new Promise<void>((resolve, reject) => {
    resolveObservation = resolve;
    rejectObservation = reject;
  });
  vi.spyOn(internals, "acceptRuntimeOAuthAttemptResult").mockImplementation(async (...args: unknown[]) => {
    try {
      const accepted = await original(...args);
      if (accepted.desktop.phase !== expectedDesktopPhase) {
        rejectObservation(new Error(
          `Expected OAuth acceptance phase ${expectedDesktopPhase}, received ${accepted.desktop.phase}`,
        ));
      } else {
        resolveObservation();
      }
      return accepted;
    } catch (error) {
      rejectObservation(error);
      throw error;
    }
  });
  return observation;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "prime-main-oauth-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function health(
  hostId = "host-a",
  capabilities = ["runtime_oauth_v1", "runtime_oauth_attempt_v1"],
) {
  return {
    protocolVersion: 1,
    hostdVersion: "0.1.0",
    startedAt: "2026-08-07T17:00:00.000Z",
    checkedAt: "2026-08-07T17:00:01.000Z",
    serviceState: "ready",
    host: { hostId },
    capabilities,
  };
}

function activeRecord(attempt: RuntimeOAuthAttemptV1) {
  return {
    recordVersion: 1 as const,
    attempt,
    revision: 1,
    sessionId: "oauth-session-1",
    phase: "login_dispatching" as const,
    createdAt: attempt.identity.requestedAt,
    updatedAt: attempt.identity.requestedAt,
    expiresAt: expiresAt(attempt),
  };
}

function liveSnapshot(
  record: { sessionId: string; expiresAt: string },
  authorizationUrl?: string,
) {
  return {
    sessionId: record.sessionId,
    providerId: "openai-codex" as const,
    phase: "awaiting_user" as const,
    expiresAt: record.expiresAt,
    ...(authorizationUrl ? { authorization: { url: authorizationUrl } } : {}),
  };
}

function completedRecord(
  attempt: RuntimeOAuthAttemptV1,
  terminalAt = shiftTimestamp(attempt.identity.requestedAt, 1_000),
) {
  const terminal = createRuntimeOAuthAttemptTerminalV1({
    version: 1,
    attemptDigest: attempt.attemptDigest,
    phase: "completed",
    resolution: "persistence_confirmed",
    configuredObserved: true,
    terminalAt,
  });
  return {
    recordVersion: 1 as const,
    attempt,
    revision: 4,
    sessionId: "oauth-session-1",
    phase: "completed" as const,
    createdAt: attempt.identity.requestedAt,
    updatedAt: terminalAt,
    expiresAt: expiresAt(attempt),
    terminal,
  };
}

function acknowledgedRecord(record: ReturnType<typeof completedRecord>) {
  return {
    ...record,
    revision: record.revision + 1,
    updatedAt: record.terminal.body.terminalAt,
    desktopAcknowledgedAt: record.terminal.body.terminalAt,
  };
}

function boundResult(record: object, live?: object) {
  const attempt = (record as { attempt: RuntimeOAuthAttemptV1 }).attempt;
  return {
    attemptDigest: attempt.attemptDigest,
    record,
    ...(live ? { live } : {}),
  };
}

function expiresAt(attempt: RuntimeOAuthAttemptV1): string {
  return shiftTimestamp(attempt.identity.requestedAt, 5 * 60_000);
}

function shiftTimestamp(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

async function readAttemptLedger(directory: string): Promise<{
  version: number;
  attempts: Array<Record<string, unknown>>;
}> {
  return JSON.parse(await readFile(
    path.join(directory, "control", "runtime-oauth-attempts.json"),
    "utf8",
  )) as { version: number; attempts: Array<Record<string, unknown>> };
}

async function waitUntilAfter(timestamp: string): Promise<void> {
  const instant = Date.parse(timestamp);
  if (!Number.isFinite(instant)) throw new Error(`Invalid timestamp: ${timestamp}`);
  while (Date.now() <= instant) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(1, instant - Date.now() + 1));
    });
  }
}

function validAuthorizationUrl(origin = "https://auth.openai.com"): string {
  const url = new URL("/oauth/authorize", origin);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", "app_EMoamEEZ73f0CkXaXp7hrann");
  url.searchParams.set("redirect_uri", "http://localhost:1455/auth/callback");
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", "A".repeat(43));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "a".repeat(32));
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");
  return url.toString();
}

function testApp(directory: string): App {
  return {
    getPath: () => directory,
    getVersion: () => "0.1.0",
  } as unknown as App;
}
