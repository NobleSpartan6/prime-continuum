import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtomicWriteAmbiguousCommitError } from "../../src/hostd/atomic-files";
import {
  OAUTH_ATTEMPT_MAX_FILES,
  OAUTH_ATTEMPT_MAX_FILE_BYTES,
  OAUTH_ATTEMPT_TERMINAL_RETENTION_MS,
  OAuthAttemptStore,
  isOAuthAttemptBarrier,
  type OAuthAttemptRecord,
  type OAuthAttemptStoreOptions,
} from "../../src/hostd/oauth-attempt-store";
import { getHostDataPaths } from "../../src/hostd/paths";
import {
  RUNTIME_OAUTH_ATTEMPT_MAX_AGE_MS,
  createRuntimeOAuthAttemptTerminalV1,
  createRuntimeOAuthAttemptV1,
  type RuntimeOAuthAttemptTerminalPhase,
  type RuntimeOAuthAttemptTerminalResolution,
  type RuntimeOAuthAttemptV1,
} from "../../src/shared/runtime-oauth-attempt";

const temporaryDirectories: string[] = [];
const baseMs = Date.parse("2026-08-10T12:00:00.000Z");
const dayMs = 24 * 60 * 60 * 1_000;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("OAuthAttemptStore", () => {
  it("adds the exact private host path and requires initialization after caller authority", async () => {
    const directory = await temporaryDirectory();
    const paths = getHostDataPaths(directory);
    const store = new OAuthAttemptStore(paths);

    expect(paths.oauthAttempts).toBe(join(directory, "oauth-attempts"));
    await expect(store.list()).rejects.toThrow(/not initialized/);
    await store.initialize(at(0));
    const metadata = await lstat(paths.oauthAttempts);
    expect(metadata.isDirectory()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") expect(metadata.mode & 0o077).toBe(0);
  });

  it("publishes one exact digest-named record and treats only an exact duplicate as idempotent", async () => {
    const { store, paths } = await temporaryStore();
    const input = prepareInput(1);
    const first = await store.prepare(input);
    const duplicate = await store.prepare(input);
    const oldDuplicate = await store.prepare({
      ...input,
      observedAt: at(1_000 + RUNTIME_OAUTH_ATTEMPT_MAX_AGE_MS + 1),
    });
    const names = await readdir(paths.oauthAttempts);

    expect(first.created).toBe(true);
    expect(first.record).toMatchObject({
      recordVersion: 1,
      attempt: input.attempt,
      revision: 0,
      sessionId: input.sessionId,
      initialAuthorityId: input.initialAuthorityId,
      phase: "prepared",
      createdAt: input.attempt.identity.requestedAt,
      updatedAt: input.attempt.identity.requestedAt,
      expiresAt: input.expiresAt,
    });
    expect(duplicate).toEqual({ record: first.record, created: false });
    expect(oldDuplicate).toEqual({ record: first.record, created: false });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.record)).toBe(true);
    expect(Object.isFrozen(first.record.attempt)).toBe(true);
    expect(names).toEqual([`${input.attempt.attemptDigest}.json`]);
    expect((await readFile(join(paths.oauthAttempts, names[0]!))).byteLength)
      .toBeLessThanOrEqual(OAUTH_ATTEMPT_MAX_FILE_BYTES);

    await expect(store.prepare({ ...input, sessionId: "different-session" }))
      .rejects.toMatchObject({ code: "OAUTH_ATTEMPT_ID_CONFLICT" });
    await expect(store.prepare(prepareInput(2)))
      .rejects.toMatchObject({ code: "OAUTH_ATTEMPT_ID_CONFLICT" });
  });

  it("applies freshness only to initial creation, never reconciliation of an existing digest", async () => {
    const { store } = await temporaryStore();
    const stale = prepareInput(1);
    stale.observedAt = at(1_000 + RUNTIME_OAUTH_ATTEMPT_MAX_AGE_MS + 1);
    await expect(store.prepare(stale)).rejects.toThrow(/fresh enough/);
    expect(await store.list()).toEqual([]);
  });

  it("rejects retained operation or session aliases after the prior attempt is terminal", async () => {
    const { store } = await temporaryStore();
    const first = await createTerminal(store, 1, at(1_001));
    const operationAlias = prepareInput(2);
    operationAlias.attempt = createRuntimeOAuthAttemptV1({
      ...operationAlias.attempt.identity,
      operationId: first.attempt.identity.operationId,
    });

    await expect(store.prepare(operationAlias)).rejects.toMatchObject({
      code: "OAUTH_ATTEMPT_ID_CONFLICT",
    });
    await expect(store.prepare({
      ...prepareInput(3),
      sessionId: first.sessionId,
    })).rejects.toMatchObject({ code: "OAUTH_ATTEMPT_ID_CONFLICT" });
  });

  it("rejects decorated public input without invoking accessors or retaining secret-shaped data", async () => {
    const { store } = await temporaryStore();
    const input = prepareInput(1) as unknown as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(input, "sessionId", {
      enumerable: true,
      get() {
        reads += 1;
        return "session-1";
      },
    });
    await expect(store.prepare(input)).rejects.toThrow(/accessor/);
    expect(reads).toBe(0);

    const hidden = prepareInput(2);
    Object.defineProperty(hidden, "accessToken", { enumerable: false, value: "never-read" });
    await expect(store.prepare(hidden)).rejects.toThrow(/hidden|unexpected/);
    await expect(store.prepare({ ...prepareInput(3), authorizationUrl: "https://example.test" }))
      .rejects.toThrow(/unexpected/);
    await expect(store.prepare({ ...prepareInput(4), [Symbol("state")]: "never-read" }))
      .rejects.toThrow(/symbol/);
    await expect(store.prepare({
      ...prepareInput(5),
      initialAuthorityId: "authority/with/path",
    })).rejects.toThrow(/authority correlation/);

    const clean = (await store.prepare(prepareInput(6))).record;
    const decoratedRecord = { ...clean } as Record<string, unknown>;
    Object.defineProperty(decoratedRecord, "phase", {
      enumerable: true,
      get() {
        reads += 1;
        return "prepared";
      },
    });
    await expect(store.markLoginDispatching(decoratedRecord, at(6_001))).rejects.toThrow(/accessor/);
    expect(reads).toBe(0);
  });

  it("durably rereads every success-path effect boundary and enforces revision/time order", async () => {
    const { store } = await temporaryStore();
    const prepared = (await store.prepare(prepareInput(1))).record;
    const login = await store.markLoginDispatching(prepared, at(1_001));
    const credentials = await store.markCredentialsReady(login, at(1_002));
    const persistence = await store.markPersistenceDispatching(credentials, at(1_003));
    const completed = await store.settle(persistence, terminalFor(
      persistence,
      "completed",
      "persistence_confirmed",
      true,
      at(1_004),
    ));
    await expect(store.acknowledge(
      prepared,
      completed.terminal!.terminalDigest,
      at(1_005),
    )).rejects.toMatchObject({ code: "OAUTH_ATTEMPT_CAS_CONFLICT" });
    const acknowledged = await store.acknowledge(
      completed,
      completed.terminal!.terminalDigest,
      at(1_005),
    );

    expect([prepared, login, credentials, persistence, completed, acknowledged].map((record) => record.revision))
      .toEqual([0, 1, 2, 3, 4, 5]);
    expect((await store.get(prepared.attempt))).toEqual(acknowledged);
    expect(acknowledged).toMatchObject({
      phase: "completed",
      desktopAcknowledgedAt: at(1_005),
      terminal: {
        body: {
          attemptDigest: prepared.attempt.attemptDigest,
          phase: "completed",
          resolution: "persistence_confirmed",
          configuredObserved: true,
          terminalAt: at(1_004),
        },
      },
    });
    expect(await store.acknowledge(completed, completed.terminal!.terminalDigest, at(1_005)))
      .toEqual(acknowledged);
    await expect(store.acknowledge(completed, completed.terminal!.terminalDigest, at(1_006)))
      .rejects.toMatchObject({ code: "OAUTH_ATTEMPT_CAS_CONFLICT" });
    await expect(store.acknowledge(acknowledged, completed.terminal!.terminalDigest, at(1_005)))
      .rejects.toMatchObject({ code: "OAUTH_ATTEMPT_CAS_CONFLICT" });
    await expect(store.markCredentialsReady(prepared, at(1_002))).rejects.toThrow(/cannot enter/);
    await expect(store.markLoginDispatching(prepared, at(999))).rejects.toThrow(/backwards/);
    await expect(store.markLoginDispatching(acknowledged, at(1_006))).rejects.toThrow();
  });

  it("serializes in-process CAS and rejects a stale transition with different bytes", async () => {
    const { store } = await temporaryStore();
    const prepared = (await store.prepare(prepareInput(1))).record;
    const [left, right] = await Promise.allSettled([
      store.markLoginDispatching(prepared, at(1_001)),
      store.markLoginDispatching(prepared, at(1_002)),
    ]);

    expect([left.status, right.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = left.status === "rejected" ? left.reason : right.status === "rejected" ? right.reason : undefined;
    expect(rejected).toMatchObject({ code: "OAUTH_ATTEMPT_CAS_CONFLICT" });
    expect((await store.get(prepared.attempt))?.revision).toBe(1);
  });

  it("reconfirms exact transition and acknowledgement retries before returning success", async () => {
    let failConfirmation = false;
    const fixture = await temporaryStore({
      faultInjector(point) {
        if (point === "after_record_file_sync" && failConfirmation) {
          throw new Error("simulated parent-directory confirmation failure");
        }
      },
    });
    const prepared = (await fixture.store.prepare(prepareInput(1))).record;
    const login = await fixture.store.markLoginDispatching(prepared, at(1_001));

    failConfirmation = true;
    await expect(fixture.store.markLoginDispatching(prepared, at(1_001)))
      .rejects.toThrow(/confirmation failure/);
    failConfirmation = false;
    expect(await fixture.store.markLoginDispatching(prepared, at(1_001))).toEqual(login);

    const terminal = await fixture.store.settle(login, terminalFor(
      login,
      "failed",
      "provider_login_failed",
      null,
      at(1_002),
    ));
    const acknowledged = await fixture.store.acknowledge(
      terminal,
      terminal.terminal!.terminalDigest,
      at(1_003),
    );
    failConfirmation = true;
    await expect(fixture.store.acknowledge(
      terminal,
      terminal.terminal!.terminalDigest,
      at(1_003),
    )).rejects.toThrow(/confirmation failure/);
    failConfirmation = false;
    expect(await fixture.store.acknowledge(
      terminal,
      terminal.terminal!.terminalDigest,
      at(1_003),
    )).toEqual(acknowledged);
  });

  it("allows only phase-coherent cancellation and terminal outcomes", async () => {
    const user = await flowToLogin(1);
    const cancelling = await user.store.markCancelling(user.record, "user", at(1_002));
    const cancelled = await user.store.settle(cancelling, terminalFor(
      cancelling,
      "cancelled",
      "user_cancelled",
      null,
      at(1_003),
    ));
    expect(cancelled).toMatchObject({ phase: "cancelled", cancelIntent: "user" });

    const expired = await flowToLogin(2);
    const expiring = await expired.store.markCancelling(expired.record, "expired", at(2_002));
    await expect(expired.store.settle(expiring, terminalFor(
      expiring,
      "cancelled",
      "user_cancelled",
      null,
      at(2_003),
    ))).rejects.toThrow(/illegal/);
    const expiredTerminal = await expired.store.settle(expiring, terminalFor(
      expiring,
      "failed",
      "expired",
      null,
      at(2_003),
    ));
    expect(expiredTerminal).toMatchObject({ phase: "failed", cancelIntent: "expired" });

    const shutdown = await flowToLogin(3);
    const stopping = await shutdown.store.markCancelling(shutdown.record, "shutdown", at(3_002));
    const stopped = await shutdown.store.settle(stopping, terminalFor(
      stopping,
      "failed",
      "host_shutdown",
      null,
      at(3_003),
    ));
    expect(stopped.cancelIntent).toBe("shutdown");
  });

  it("settles pre-dispatch cancellation, expiry, and shutdown without inventing helper state", async () => {
    const cases = [
      { phase: "cancelled" as const, resolution: "user_cancelled" as const, intent: "user" },
      { phase: "failed" as const, resolution: "expired" as const, intent: "expired" },
      { phase: "failed" as const, resolution: "host_shutdown" as const, intent: "shutdown" },
    ];
    for (const [offset, value] of cases.entries()) {
      const fixture = await isolatedPrepared(offset + 1);
      const terminal = await fixture.store.settle(fixture.record, terminalFor(
        fixture.record,
        value.phase,
        value.resolution,
        null,
        at((offset + 1) * 1_000 + 1),
      ));
      expect(terminal).toMatchObject({
        phase: value.phase,
        cancelIntent: value.intent,
      });
      expect(terminal).not.toHaveProperty("recoveryReason");
    }
  });

  it("allows every fixed non-recovery terminal path and rejects cross-attempt or backward evidence", async () => {
    const preparedFixture = await isolatedPrepared(1);
    await expect(preparedFixture.store.settle(preparedFixture.record, terminalFor(
      preparedFixture.record,
      "failed",
      "interrupted_before_login_dispatch",
      null,
      at(1_001),
    ))).resolves.toMatchObject({ phase: "failed" });

    const loginFixture = await flowToLogin(2);
    await expect(loginFixture.store.settle(loginFixture.record, terminalFor(
      loginFixture.record,
      "failed",
      "provider_login_failed",
      null,
      at(2_002),
    ))).resolves.toMatchObject({ phase: "failed" });

    const credentialsFixture = await flowToCredentials(3);
    await expect(credentialsFixture.store.settle(credentialsFixture.record, terminalFor(
      credentialsFixture.record,
      "failed",
      "credentials_discarded_before_persistence",
      null,
      at(3_003),
    ))).resolves.toMatchObject({ phase: "failed" });

    const persistenceFixture = await flowToPersistence(4);
    await expect(persistenceFixture.store.settle(persistenceFixture.record, terminalFor(
      persistenceFixture.record,
      "failed",
      "persistence_failed",
      null,
      at(4_004),
    ))).resolves.toMatchObject({ phase: "failed" });

    const wrongAttempt = attemptFor(99);
    const wrongTerminal = createRuntimeOAuthAttemptTerminalV1({
      ...terminalFor(
        persistenceFixture.record,
        "failed",
        "persistence_failed",
        null,
        at(4_004),
      ).body,
      attemptDigest: wrongAttempt.attemptDigest,
    });
    await expect(persistenceFixture.store.settle(persistenceFixture.record, wrongTerminal))
      .rejects.toThrow(/different attempt/);
    await expect(persistenceFixture.store.settle(persistenceFixture.record, terminalFor(
      persistenceFixture.record,
      "failed",
      "persistence_failed",
      null,
      at(4_002),
    ))).rejects.toThrow(/backwards/);
  });

  it("classifies every pre-restart phase without replaying an effect", async () => {
    await expectRestartClassification("prepared", async (store, prepared) => prepared, {
      phase: "failed",
      resolution: "interrupted_before_login_dispatch",
    });
    await expectRestartClassification("login_dispatching", async (store, prepared) =>
      await store.markLoginDispatching(prepared, at(1_001)), {
      phase: "recovery_required",
      recoveryReason: "login_helper_liveness_unconfirmed",
    });
    await expectRestartClassification("credentials_ready", async (store, prepared) => {
      const login = await store.markLoginDispatching(prepared, at(1_001));
      return await store.markCredentialsReady(login, at(1_002));
    }, {
      phase: "failed",
      resolution: "credentials_discarded_before_persistence",
    });
    await expectRestartClassification("persistence_dispatching", async (store, prepared) => {
      const login = await store.markLoginDispatching(prepared, at(1_001));
      const credentials = await store.markCredentialsReady(login, at(1_002));
      return await store.markPersistenceDispatching(credentials, at(1_003));
    }, {
      phase: "recovery_required",
      recoveryReason: "storage_helper_liveness_unconfirmed",
    });
    await expectRestartClassification("cancelling", async (store, prepared) => {
      const login = await store.markLoginDispatching(prepared, at(1_001));
      return await store.markCancelling(login, "user", at(1_002));
    }, {
      phase: "recovery_required",
      recoveryReason: "cancelling_helper_liveness_unconfirmed",
      cancelIntent: "user",
    });
  });

  it("retains recovery barriers across restart and permits only their exact terminal resolution", async () => {
    const loginFixture = await flowToLogin(1);
    await expect(loginFixture.store.markRecoveryRequired(
      loginFixture.record,
      "storage_helper_liveness_unconfirmed",
      at(1_002),
    )).rejects.toThrow(/does not match/);
    const loginRecovery = await loginFixture.store.markRecoveryRequired(
      loginFixture.record,
      "login_helper_liveness_unconfirmed",
      at(1_002),
    );
    const loginRestart = new OAuthAttemptStore(loginFixture.paths);
    await loginRestart.initialize(at(1_003));
    expect(await loginRestart.get(loginRecovery.attempt)).toEqual(loginRecovery);
    await expect(loginRestart.settle(loginRecovery, terminalFor(
      loginRecovery,
      "failed",
      "interrupted_during_login",
      null,
      at(1_004),
    ))).resolves.toMatchObject({ phase: "failed" });

    const storageFixture = await flowToPersistence(2);
    const storageRecovery = await storageFixture.store.markRecoveryRequired(
      storageFixture.record,
      "storage_helper_liveness_unconfirmed",
      at(2_004),
    );
    await expect(storageFixture.store.settle(storageRecovery, terminalFor(
      storageRecovery,
      "completed",
      "persistence_confirmed",
      true,
      at(2_005),
    ))).rejects.toThrow(/illegal/);
    const observed = await storageFixture.store.settle(storageRecovery, terminalFor(
      storageRecovery,
      "outcome_unknown",
      "configured_observed_after_recovery",
      true,
      at(2_005),
    ));
    expect(observed).toMatchObject({
      phase: "outcome_unknown",
      recoveryReason: "storage_helper_liveness_unconfirmed",
    });

    const cancellationFixture = await flowToLogin(3);
    const cancelling = await cancellationFixture.store.markCancelling(
      cancellationFixture.record,
      "shutdown",
      at(3_002),
    );
    const cancellationRecovery = await cancellationFixture.store.markRecoveryRequired(
      cancelling,
      "cancelling_helper_liveness_unconfirmed",
      at(3_003),
    );
    await expect(cancellationFixture.store.settle(cancellationRecovery, terminalFor(
      cancellationRecovery,
      "failed",
      "host_shutdown",
      null,
      at(3_004),
    ))).resolves.toMatchObject({
      phase: "failed",
      cancelIntent: "shutdown",
      recoveryReason: "cancelling_helper_liveness_unconfirmed",
    });
  });

  it("keeps terminal records byte-exact across restart and rejects an altered terminal digest", async () => {
    const fixture = await flowToPersistence(1);
    const terminal = await fixture.store.settle(fixture.record, terminalFor(
      fixture.record,
      "completed",
      "persistence_confirmed",
      true,
      at(1_004),
    ));
    const restarted = new OAuthAttemptStore(fixture.paths);
    await restarted.initialize(at(1_005));
    expect(await restarted.get(terminal.attempt)).toEqual(terminal);

    await expect(restarted.settle(terminal, {
      ...terminal.terminal,
      terminalDigest: "f".repeat(64),
    })).rejects.toThrow(/terminal evidence is invalid/);
  });

  it("fails closed after a create crash and after a transition was published but not returned", async () => {
    const createFixture = await temporaryStore({
      atomicCreateFaultInjector(point) {
        if (point === "after_link") throw new Error("simulated create crash");
      },
    });
    await expect(createFixture.store.prepare(prepareInput(1)))
      .rejects.toBeInstanceOf(AtomicWriteAmbiguousCommitError);
    const createRestart = new OAuthAttemptStore(createFixture.paths);
    await createRestart.initialize(at(1_001));
    expect(await createRestart.list()).toMatchObject([{
      phase: "failed",
      terminal: { body: { resolution: "interrupted_before_login_dispatch" } },
    }]);

    let failTransition = true;
    const transitionFixture = await temporaryStore({
      faultInjector(point) {
        if (point === "after_transition_publish" && failTransition) {
          failTransition = false;
          throw new Error("simulated host crash");
        }
      },
    });
    const prepared = (await transitionFixture.store.prepare(prepareInput(2))).record;
    await expect(transitionFixture.store.markLoginDispatching(prepared, at(2_001)))
      .rejects.toThrow(/simulated host crash/);
    const transitionRestart = new OAuthAttemptStore(transitionFixture.paths);
    await transitionRestart.initialize(at(2_002));
    expect(await transitionRestart.list()).toMatchObject([{
      phase: "recovery_required",
      recoveryReason: "login_helper_liveness_unconfirmed",
    }]);
  });

  it("recovers exact atomic siblings and conservatively restores an interrupted deletion", async () => {
    const fixture = await isolatedPrepared(1);
    const [targetName] = await readdir(fixture.paths.oauthAttempts);
    const target = join(fixture.paths.oauthAttempts, targetName!);
    const body = await readFile(target);

    const unpublished = `${target}.tmp-123-${"a".repeat(16)}`;
    await writeFile(unpublished, body, { mode: 0o600 });
    const afterUnpublished = new OAuthAttemptStore(fixture.paths);
    await afterUnpublished.initialize(at(1_001));
    expect((await readdir(fixture.paths.oauthAttempts)).some((name) => name.includes(".tmp-"))).toBe(false);

    const currentTarget = join(fixture.paths.oauthAttempts, targetName!);
    const publishedSibling = `${currentTarget}.tmp-124-${"b".repeat(16)}`;
    await link(currentTarget, publishedSibling);
    const afterPublished = new OAuthAttemptStore(fixture.paths);
    await afterPublished.initialize(at(1_002));
    expect(await readdir(fixture.paths.oauthAttempts)).toEqual([targetName]);

    const deletionTemporary = `${currentTarget}.delete-${"c".repeat(16)}`;
    await rename(currentTarget, deletionTemporary);
    const afterDeletion = new OAuthAttemptStore(fixture.paths);
    await afterDeletion.initialize(at(1_003));
    expect(await readdir(fixture.paths.oauthAttempts)).toEqual([targetName]);
  });

  it("rejects uncorrelated temporary hard links, record hard links, symlinks, and nonprivate POSIX state", async () => {
    const fixture = await isolatedPrepared(1);
    const [targetName] = await readdir(fixture.paths.oauthAttempts);
    const target = join(fixture.paths.oauthAttempts, targetName!);
    const outside = join(fixture.paths.root, "outside.json");
    await writeFile(outside, await readFile(target), { mode: 0o600 });
    await link(outside, `${target}.tmp-123-${"a".repeat(16)}`);
    await expect(new OAuthAttemptStore(fixture.paths).initialize(at(1_001)))
      .rejects.toThrow(/uncorrelated hard link/);
    await rm(`${target}.tmp-123-${"a".repeat(16)}`);

    const outsideHardLink = join(fixture.paths.root, "outside-hardlink.json");
    await link(target, outsideHardLink);
    await expect(new OAuthAttemptStore(fixture.paths).initialize(at(1_002)))
      .rejects.toThrow(/single-link|unsafe/i);
    await rm(outsideHardLink);

    const symlinkName = `${attemptFor(2).attemptDigest}.json`;
    try {
      await symlink(target, join(fixture.paths.oauthAttempts, symlinkName), "file");
      await expect(new OAuthAttemptStore(fixture.paths).initialize(at(1_003)))
        .rejects.toThrow(/unexpected entry|regular file/i);
      await rm(join(fixture.paths.oauthAttempts, symlinkName));
    } catch (cause) {
      if (!isErrorCode(cause, "EPERM")) throw cause;
    }

    if (process.platform !== "win32") {
      await chmod(target, 0o644);
      await expect(new OAuthAttemptStore(fixture.paths).initialize(at(1_004)))
        .rejects.toThrow(/permissions/);
    }
  });

  it("rejects filename/digest cross-feed, malformed JSON, oversize files, extras, and secret fields", async () => {
    const cross = await isolatedPrepared(1);
    const [name] = await readdir(cross.paths.oauthAttempts);
    await rename(
      join(cross.paths.oauthAttempts, name!),
      join(cross.paths.oauthAttempts, `${attemptFor(2).attemptDigest}.json`),
    );
    await expect(new OAuthAttemptStore(cross.paths).initialize(at(1_001)))
      .rejects.toThrow(/filename.*correlated/i);

    const malformed = await isolatedPrepared(3);
    const [malformedName] = await readdir(malformed.paths.oauthAttempts);
    await writeFile(join(malformed.paths.oauthAttempts, malformedName!), "{not-json\n", { mode: 0o600 });
    await expect(new OAuthAttemptStore(malformed.paths).initialize(at(3_001)))
      .rejects.toThrow(/valid JSON/);

    const oversized = await temporaryStore();
    await writeFile(
      join(oversized.paths.oauthAttempts, `${attemptFor(4).attemptDigest}.json`),
      Buffer.alloc(OAUTH_ATTEMPT_MAX_FILE_BYTES + 1, 0x20),
      { mode: 0o600 },
    );
    await expect(new OAuthAttemptStore(oversized.paths).initialize(at(4_001)))
      .rejects.toThrow(/bounded single-link/);

    const decorated = await isolatedPrepared(5);
    const [decoratedName] = await readdir(decorated.paths.oauthAttempts);
    const decoratedPath = join(decorated.paths.oauthAttempts, decoratedName!);
    const record = JSON.parse(await readFile(decoratedPath, "utf8")) as Record<string, unknown>;
    await writeFile(decoratedPath, `${JSON.stringify({
      ...record,
      authorizationUrl: "https://auth.example.test",
      accessToken: "never",
      pid: 31337,
    })}\n`, { mode: 0o600 });
    await expect(new OAuthAttemptStore(decorated.paths).initialize(at(5_001)))
      .rejects.toThrow(/record is invalid/);
  });

  it("rejects multiple unresolved records recovered from conflicting authority", async () => {
    const left = await isolatedPrepared(1);
    const right = await isolatedPrepared(2);
    const [rightName] = await readdir(right.paths.oauthAttempts);
    await copyFile(
      join(right.paths.oauthAttempts, rightName!),
      join(left.paths.oauthAttempts, rightName!),
    );
    if (process.platform !== "win32") {
      await chmod(join(left.paths.oauthAttempts, rightName!), 0o600);
    }
    await expect(new OAuthAttemptStore(left.paths).initialize(at(2_001)))
      .rejects.toThrow(/more than one unresolved/);
  });

  it("compacts only acknowledged terminals at the inclusive 30-day boundary", async () => {
    const { store } = await temporaryStore();
    const eligible = await createTerminal(store, 1, at(1_001));
    const eligibleAck = await store.acknowledge(
      eligible,
      eligible.terminal!.terminalDigest,
      at(1_002),
    );
    const unacknowledged = await createTerminal(store, 2, at(2_001));
    const young = await createTerminal(store, 3, at(3_001 + 29 * dayMs));
    await store.acknowledge(young, young.terminal!.terminalDigest, at(3_002 + 29 * dayMs));
    const unresolved = (await store.prepare(prepareInput(4, at(4_000)))).record;

    const beforeBoundary = await store.compact(at(1_001 + OAUTH_ATTEMPT_TERMINAL_RETENTION_MS - 1));
    expect(beforeBoundary.deletedAttemptDigests).toEqual([]);
    const atBoundary = await store.compact(at(1_001 + OAUTH_ATTEMPT_TERMINAL_RETENTION_MS));
    expect(atBoundary.deletedAttemptDigests).toEqual([eligibleAck.attempt.attemptDigest]);
    const records = await store.list();
    expect(records.map((record) => record.attempt.attemptDigest)).toContain(unacknowledged.attempt.attemptDigest);
    expect(records.map((record) => record.attempt.attemptDigest)).toContain(young.attempt.attemptDigest);
    expect(records.map((record) => record.attempt.attemptDigest)).toContain(unresolved.attempt.attemptDigest);
    expect(isOAuthAttemptBarrier(unresolved)).toBe(true);
  });

  it("does not compact on clock rollback", async () => {
    const { store } = await temporaryStore();
    const terminal = await createTerminal(store, 1, at(10_001));
    await store.acknowledge(terminal, terminal.terminal!.terminalDigest, at(10_002));

    expect((await store.compact(at(9_999))).deletedAttemptDigests).toEqual([]);
    expect(await store.list()).toHaveLength(1);
  });

  it("fails closed at 128 records and never deletes unacknowledged terminals", async () => {
    const { store } = await temporaryStore();
    for (let index = 1; index <= OAUTH_ATTEMPT_MAX_FILES; index += 1) {
      await createTerminal(store, index, at(index * 1_000 + 1));
    }
    expect(await store.list()).toHaveLength(OAUTH_ATTEMPT_MAX_FILES);
    await expect(store.prepare(prepareInput(OAUTH_ATTEMPT_MAX_FILES + 1, at(200_000))))
      .rejects.toMatchObject({ code: "OAUTH_ATTEMPT_STORAGE_FULL" });
    expect((await store.compact(at(90 * dayMs))).deletedAttemptDigests).toEqual([]);
    expect(await store.list()).toHaveLength(OAUTH_ATTEMPT_MAX_FILES);
  }, 30_000);

  it("does not enable admission after an ambiguous deletion and restores its tombstone on restart", async () => {
    let failDeletion = true;
    const fixture = await temporaryStore({
      faultInjector(point) {
        if (point === "after_compaction_rename" && failDeletion) {
          failDeletion = false;
          throw new Error("simulated compaction crash");
        }
      },
    });
    const terminal = await createTerminal(fixture.store, 1, at(1_001));
    await fixture.store.acknowledge(terminal, terminal.terminal!.terminalDigest, at(1_002));
    for (let index = 2; index <= OAUTH_ATTEMPT_MAX_FILES; index += 1) {
      await createTerminal(fixture.store, index, at(index * 1_000 + 1));
    }

    await expect(fixture.store.compact(at(40 * dayMs))).rejects.toThrow(/uncertain/);
    await expect(fixture.store.prepare(prepareInput(129, at(200_000))))
      .rejects.toThrow(/requires restart/);
    expect((await readdir(fixture.paths.oauthAttempts)).some((name) => name.includes(".delete-"))).toBe(true);

    const restarted = new OAuthAttemptStore(fixture.paths);
    await restarted.initialize(at(40 * dayMs + 1));
    expect(await restarted.list()).toHaveLength(OAUTH_ATTEMPT_MAX_FILES);
    await expect(restarted.prepare(prepareInput(129, at(200_000))))
      .rejects.toMatchObject({ code: "OAUTH_ATTEMPT_STORAGE_FULL" });
  }, 30_000);

  it("converges every compaction crash boundary before admitting public use", async () => {
    const cases = [
      { point: "after_compaction_rename" as const, restored: true },
      { point: "after_compaction_record_removal_sync" as const, restored: true },
      { point: "after_compaction_unlink" as const, restored: false },
      { point: "after_compaction_cleanup_sync" as const, restored: false },
    ];
    for (const [index, value] of cases.entries()) {
      let fail = true;
      const fixture = await temporaryStore({
        faultInjector(point) {
          if (point === value.point && fail) {
            fail = false;
            throw new Error(`simulated ${value.point} crash`);
          }
        },
      });
      const terminal = await createTerminal(fixture.store, index + 1, at((index + 1) * 1_000 + 1));
      await fixture.store.acknowledge(
        terminal,
        terminal.terminal!.terminalDigest,
        at((index + 1) * 1_000 + 2),
      );

      await expect(fixture.store.compact(at(40 * dayMs + index))).rejects.toThrow(/uncertain/);
      await expect(fixture.store.prepare(prepareInput(100 + index, at(200_000 + index))))
        .rejects.toThrow(/requires restart/);
      const restarted = new OAuthAttemptStore(fixture.paths);
      await restarted.initialize(at(40 * dayMs + index + 1));
      expect(await restarted.list()).toHaveLength(value.restored ? 1 : 0);
    }
  });

  it("serializes a strict allow-listed record with no URL, secret, account, raw failure, process, or path fields", async () => {
    const fixture = await flowToPersistence(1);
    const recovery = await fixture.store.markRecoveryRequired(
      fixture.record,
      "storage_helper_liveness_unconfirmed",
      at(1_004),
    );
    const terminal = await fixture.store.settle(recovery, terminalFor(
      recovery,
      "outcome_unknown",
      "not_configured_observed_after_recovery",
      false,
      at(1_005),
    ));
    const [name] = await readdir(fixture.paths.oauthAttempts);
    const durable = JSON.parse(await readFile(join(fixture.paths.oauthAttempts, name!), "utf8")) as unknown;
    const keys = collectKeys(durable);
    const forbidden = new Set([
      "path",
      "url",
      "authorization",
      "challenge",
      "progress",
      "state",
      "code",
      "token",
      "credential",
      "credentials",
      "account",
      "error",
      "pid",
      "argv",
      "env",
    ]);

    expect(keys.some((key) => forbidden.has(key))).toBe(false);
    expect(JSON.stringify(durable)).not.toMatch(/(?:https?|file):|[A-Za-z]:\\|\/(?:Users|home)\//i);
    expect(durable).toEqual(terminal);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "prime-oauth-attempt-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function temporaryStore(options: OAuthAttemptStoreOptions = {}) {
  const directory = await temporaryDirectory();
  const paths = getHostDataPaths(directory);
  const store = new OAuthAttemptStore(paths, options);
  await store.initialize(at(0));
  return { store, paths };
}

async function isolatedPrepared(index: number) {
  const fixture = await temporaryStore();
  const record = (await fixture.store.prepare(prepareInput(index))).record;
  return { ...fixture, record };
}

async function flowToLogin(index: number) {
  const fixture = await isolatedPrepared(index);
  const record = await fixture.store.markLoginDispatching(fixture.record, at(index * 1_000 + 1));
  return { ...fixture, record };
}

async function flowToCredentials(index: number) {
  const fixture = await flowToLogin(index);
  const record = await fixture.store.markCredentialsReady(fixture.record, at(index * 1_000 + 2));
  return { ...fixture, record };
}

async function flowToPersistence(index: number) {
  const fixture = await flowToCredentials(index);
  const record = await fixture.store.markPersistenceDispatching(fixture.record, at(index * 1_000 + 3));
  return { ...fixture, record };
}

async function createTerminal(store: OAuthAttemptStore, index: number, terminalAt: string) {
  const prepared = (await store.prepare(prepareInput(index))).record;
  return await store.settle(prepared, terminalFor(
    prepared,
    "failed",
    "interrupted_before_login_dispatch",
    null,
    terminalAt,
  ));
}

async function expectRestartClassification(
  _label: string,
  build: (store: OAuthAttemptStore, prepared: OAuthAttemptRecord) => Promise<OAuthAttemptRecord>,
  expected: { phase: string; resolution?: string; recoveryReason?: string; cancelIntent?: string },
) {
  const fixture = await isolatedPrepared(1);
  const before = await build(fixture.store, fixture.record);
  const restarted = new OAuthAttemptStore(fixture.paths);
  await restarted.initialize(at(1_010));
  const after = await restarted.get(before.attempt);
  expect(after?.revision).toBe(before.phase === "recovery_required" || !isOAuthAttemptBarrier(before)
    ? before.revision
    : before.revision + 1);
  expect(after).toMatchObject({
    phase: expected.phase,
    ...(expected.recoveryReason ? { recoveryReason: expected.recoveryReason } : {}),
    ...(expected.cancelIntent ? { cancelIntent: expected.cancelIntent } : {}),
    ...(expected.resolution ? { terminal: { body: { resolution: expected.resolution } } } : {}),
  });
}

function prepareInput(index: number, requestedAt = at(index * 1_000)) {
  const attempt = attemptFor(index, requestedAt);
  return {
    attempt,
    sessionId: `session-${index}`,
    initialAuthorityId: `authority-${index}`,
    observedAt: requestedAt,
    expiresAt: new Date(Date.parse(requestedAt) + dayMs).toISOString(),
  };
}

function attemptFor(index: number, requestedAt = at(index * 1_000)): RuntimeOAuthAttemptV1 {
  return createRuntimeOAuthAttemptV1({
    version: 1,
    expectedHostId: "host-local",
    providerId: "openai-codex",
    operationId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    requestedAt,
  });
}

function terminalFor(
  record: OAuthAttemptRecord,
  phase: RuntimeOAuthAttemptTerminalPhase,
  resolution: RuntimeOAuthAttemptTerminalResolution,
  configuredObserved: boolean | null,
  terminalAt: string,
) {
  return createRuntimeOAuthAttemptTerminalV1({
    version: 1,
    attemptDigest: record.attempt.attemptDigest,
    phase,
    resolution,
    configuredObserved,
    terminalAt,
  });
}

function at(offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

function collectKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Reflect.ownKeys(value).flatMap((key) => [
    typeof key === "string" ? key : key.description ?? "symbol",
    ...collectKeys(Object.getOwnPropertyDescriptor(value, key)?.value),
  ]);
}

function isErrorCode(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
