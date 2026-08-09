import { bootstrapTestWorkspace } from "./test-workspace-fixture";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GatewayError,
  UnavailablePrimeAgentGateway,
  type GatewayAdmission,
  type GatewayDispatchContext,
  type PrimeAgentGateway,
} from "../../src/hostd/gateway";
import type { ResidentProjectionSnapshot } from "../../src/hostd/resident-projection";
import { runFramedSession } from "../../src/hostd/server";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import { HostService, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import {
  HostStore,
  validateResidentDispatchLease,
  type ResidentDispatchLease,
  type HostStoreOptions,
} from "../../src/hostd/store";
import {
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type CommandReceipt,
  type ResidentControlProjectionSnapshot,
} from "../../src/shared/protocol";
import { encodeJsonFrame, LengthPrefixedJsonDecoder } from "../../src/shared/frame-codec";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HostService resident continuity dispatch integration", () => {
  it("publishes stable monotonic control state across distinct command-envelope identities without replay", async () => {
    const gateway = residentGateway((command) => ({
      disposition: command.command.kind === "prompt" ? "accepted" : "handled",
      message: command.command.kind === "prompt"
        ? "Prime Agent owns the prompt"
        : "Prime Agent accepted Stop",
    }));
    const fixture = await serviceFixture(gateway);
    await publishIdleResidentProjection(fixture, "resident-control-initial-idle");

    const health = await fixture.service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "resident-control-health",
      method: "health.get",
      payload: {},
    }, TRUSTED_USER_SESSION);
    expect(health).toMatchObject({
      ok: true,
      result: { capabilities: expect.arrayContaining(["resident_control_projection_v1"]) },
    });

    const idle = await controlSnapshot(fixture.service, fixture.hostId, "resident-control-idle");
    expect(idle).toMatchObject({
      hostId: fixture.hostId,
      threadId: "test-thread",
      executionGenerationId: "test-execution-1",
      controlSequence: 0,
      quiescence: { state: "idle_proven" },
    });
    expect(idle.operation).toBeUndefined();
    expect(await controlSnapshot(fixture.service, fixture.hostId, "resident-control-idle-repeat"))
      .toEqual(idle);

    const prompt = {
      ...residentCommand(fixture.hostId, "device-a-prompt", "prompt"),
      deviceId: "device-a",
    } satisfies CommandEnvelope;
    expect(await submitCommand(fixture.service, prompt, "device-a-prompt-submit"))
      .toMatchObject({ status: "running" });
    const promptOwned = await controlSnapshot(
      fixture.service,
      fixture.hostId,
      "resident-control-prompt-owned",
    );
    expect(promptOwned).toMatchObject({
      controlSequence: idle.controlSequence + 1,
      operation: {
        kind: "prompt",
        deviceId: "device-a",
        commandId: prompt.commandId,
        phase: "acknowledged",
      },
      quiescence: { state: "prompt_owned" },
    });

    const stop = {
      ...residentCommand(fixture.hostId, "device-b-stop", "abort"),
      deviceId: "device-b",
    } satisfies CommandEnvelope;
    expect(await submitCommand(fixture.service, stop, "device-b-stop-submit"))
      .toMatchObject({ status: "running" });
    const stopOwned = await controlSnapshot(
      fixture.service,
      fixture.hostId,
      "resident-control-stop-owned",
    );
    expect(stopOwned).toMatchObject({
      controlSequence: promptOwned.controlSequence + 1,
      operation: {
        kind: "abort",
        deviceId: "device-b",
        commandId: stop.commandId,
        phase: "acknowledged",
      },
      quiescence: { state: "stop_owned" },
    });
    expect(await controlSnapshot(fixture.service, fixture.hostId, "resident-control-stop-repeat"))
      .toEqual(stopOwned);
    expect(gateway.submit).toHaveBeenCalledTimes(2);
    await fixture.service.close();

    const restartedStore = new HostStore(fixture.directory);
    const restartedGateway = residentGateway(() => {
      throw new Error("resident control polling must never replay a mutation");
    });
    const restartedService = new HostService(restartedStore, restartedGateway);
    await restartedService.initialize();
    expect(await controlSnapshot(restartedService, fixture.hostId, "resident-control-after-restart"))
      .toEqual(stopOwned);
    expect(restartedGateway.isLive).not.toHaveBeenCalled();
    expect(restartedGateway.submit).not.toHaveBeenCalled();

    const stale = await restartedService.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "resident-control-stale-generation",
      method: "thread.control.snapshot",
      payload: {
        expectedHostId: fixture.hostId,
        threadId: "test-thread",
        expectedExecutionGenerationId: "test-execution-stale",
      },
    }, TRUSTED_USER_SESSION);
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "STALE_EXECUTION_GENERATION", retryable: false },
    });
    const wrongHost = await restartedService.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "resident-control-wrong-host",
      method: "thread.control.snapshot",
      payload: {
        expectedHostId: "other-host",
        threadId: "test-thread",
        expectedExecutionGenerationId: "test-execution-1",
      },
    }, TRUSTED_USER_SESSION);
    expect(wrongHost).toMatchObject({
      ok: false,
      error: { code: "HOST_AUTHORITY_MISMATCH", retryable: false },
    });
    await restartedService.close();
  });

  it("keeps an active binding uncertain when no exact resident projection lineage exists", async () => {
    const gateway = residentGateway(() => {
      throw new Error("resident control discovery must never dispatch a mutation");
    });
    const fixture = await serviceFixture(gateway);

    const snapshot = await controlSnapshot(
      fixture.service,
      fixture.hostId,
      "resident-control-placeholder-lineage",
    );

    expect(snapshot.quiescence).toEqual({ state: "uncertain", reason: "lifecycle_transition" });
    expect(snapshot.operation).toBeUndefined();
    expect(gateway.isResidentBindingLive).toHaveBeenCalledWith(fixture.binding);
    expect(gateway.submit).not.toHaveBeenCalled();
    await fixture.service.close();
  });

  it("keeps an exact inactive projection uncertain while the resident gateway is unavailable", async () => {
    const fixture = await serviceFixture(new UnavailablePrimeAgentGateway());
    await publishIdleResidentProjection(fixture, "resident-control-unavailable-gateway");

    const snapshot = await controlSnapshot(
      fixture.service,
      fixture.hostId,
      "resident-control-unavailable-gateway-read",
    );

    expect(snapshot.quiescence).toEqual({ state: "uncertain", reason: "lifecycle_transition" });
    expect(snapshot.operation).toBeUndefined();
    await fixture.service.close();
  });

  it("reports idle only when exact lineage and the gateway's exact prepared binding agree", async () => {
    const gateway = residentGateway(() => {
      throw new Error("resident control discovery must never dispatch a mutation");
    });
    const fixture = await serviceFixture(gateway);
    await publishIdleResidentProjection(fixture, "resident-control-exact-live");

    const snapshot = await controlSnapshot(
      fixture.service,
      fixture.hostId,
      "resident-control-exact-live-read",
    );

    expect(snapshot.quiescence).toEqual({ state: "idle_proven" });
    expect(snapshot.operation).toBeUndefined();
    expect(gateway.isResidentBindingLive).toHaveBeenCalledWith(fixture.binding);
    expect(gateway.isLive).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
    await fixture.service.close();
  });

  it("stays uncertain after restart until the exact resident binding is prepared again", async () => {
    const firstGateway = residentGateway(() => {
      throw new Error("resident control discovery must never dispatch a mutation");
    });
    const fixture = await serviceFixture(firstGateway);
    await publishIdleResidentProjection(fixture, "resident-control-restart-idle");
    expect((await controlSnapshot(
      fixture.service,
      fixture.hostId,
      "resident-control-before-restart",
    )).quiescence).toEqual({ state: "idle_proven" });
    await fixture.service.close();

    const restartedStore = new HostStore(fixture.directory);
    const restartedGateway = residentGateway(() => {
      throw new Error("resident reconnect discovery must never dispatch a mutation");
    }, { bindingLive: false });
    const restartedService = new HostService(restartedStore, restartedGateway);
    await restartedService.initialize();

    const reconnecting = await controlSnapshot(
      restartedService,
      fixture.hostId,
      "resident-control-restart-before-reattach",
    );
    expect(reconnecting.quiescence).toEqual({ state: "uncertain", reason: "lifecycle_transition" });
    expect(restartedGateway.submit).not.toHaveBeenCalled();

    restartedGateway.isResidentBindingLive.mockResolvedValue(true);
    const reattached = await controlSnapshot(
      restartedService,
      fixture.hostId,
      "resident-control-restart-after-reattach",
    );
    expect(reattached).toMatchObject({
      controlSequence: reconnecting.controlSequence + 1,
      quiescence: { state: "idle_proven" },
    });
    expect(restartedGateway.submit).not.toHaveBeenCalled();
    await restartedService.close();
  });

  it("keeps an explicitly detached generation uncertain across restart instead of synthesizing idle", async () => {
    const fixture = await serviceFixture(residentGateway(() => {
      throw new Error("detach control discovery must not dispatch a mutation");
    }));
    await publishIdleResidentProjection(fixture, "resident-control-before-detach");
    const before = await controlSnapshot(fixture.service, fixture.hostId, "resident-control-before-detach");
    expect(before.quiescence).toEqual({ state: "idle_proven" });

    await fixture.store.detachResidentLifecycle({
      operationId: "resident-control-explicit-detach",
      expectedHostId: fixture.hostId,
      projectId: "test-project",
      workspaceId: "test-workspace",
      threadId: "test-thread",
      executionGenerationId: "test-execution-1",
      requestDigest: "d".repeat(64),
    }, fixture.binding);
    const detached = await controlSnapshot(
      fixture.service,
      fixture.hostId,
      "resident-control-after-detach",
    );
    expect(detached).toMatchObject({
      controlSequence: before.controlSequence + 1,
      quiescence: { state: "uncertain", reason: "lifecycle_transition" },
    });
    expect(detached.operation).toBeUndefined();
    await fixture.service.close();

    const restartedStore = new HostStore(fixture.directory);
    const restartedService = new HostService(restartedStore, residentGateway(() => {
      throw new Error("detached restart discovery must remain read-only");
    }));
    await restartedService.initialize();
    expect(await controlSnapshot(restartedService, fixture.hostId, "resident-control-detached-restart"))
      .toEqual(detached);
    await restartedService.close();
  });

  it("fails closed on a corrupt durable resident control projection", async () => {
    const fixture = await serviceFixture(residentGateway(() => {
      throw new Error("control polling must remain read-only");
    }));
    await publishIdleResidentProjection(fixture, "resident-control-before-corruption");
    await controlSnapshot(fixture.service, fixture.hostId, "resident-control-before-corruption");
    await fixture.service.close();
    const files = await readdir(fixture.store.paths.residentControlProjections);
    expect(files).toHaveLength(1);
    await writeFile(
      join(fixture.store.paths.residentControlProjections, files[0]!),
      "{\"projectionVersion\":1",
      "utf8",
    );

    const restartedStore = new HostStore(fixture.directory);
    const restartedService = new HostService(restartedStore, residentGateway(() => {
      throw new Error("corrupt control state must not dispatch");
    }));
    await restartedService.initialize();
    const response = await restartedService.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "resident-control-corrupt-read",
      method: "thread.control.snapshot",
      payload: {
        expectedHostId: fixture.hostId,
        threadId: "test-thread",
        expectedExecutionGenerationId: "test-execution-1",
      },
    }, TRUSTED_USER_SESSION);
    expect(response).toMatchObject({
      ok: false,
      error: { code: "RESIDENT_CONTROL_PROJECTION_INVALID", retryable: false },
    });
    await restartedService.close();
  });

  it("compacts only a validated stale generation under pressure and preserves current state across restart", async () => {
    const fixture = await serviceFixture(
      residentGateway(() => {
        throw new Error("control polling must remain read-only");
      }),
      { residentControlProjectionLimit: 1 },
    );
    await publishIdleResidentProjection(fixture, "resident-control-at-capacity");
    const current = await controlSnapshot(fixture.service, fixture.hostId, "resident-control-at-capacity");
    const staleExecutionGenerationId = "test-execution-stale";
    const staleFileName = `${createHash("sha256")
      .update(JSON.stringify(["test-thread", staleExecutionGenerationId]))
      .digest("hex")}.json`;
    await writeFile(
      join(fixture.store.paths.residentControlProjections, staleFileName),
      `${JSON.stringify({
        ...current,
        executionGenerationId: staleExecutionGenerationId,
        authorityCursor: {
          ...current.authorityCursor,
          executionGenerationId: staleExecutionGenerationId,
        },
      })}\n`,
      "utf8",
    );
    expect(await readdir(fixture.store.paths.residentControlProjections)).toHaveLength(2);
    await fixture.service.close();

    const restartedStore = new HostStore(fixture.directory, { residentControlProjectionLimit: 1 });
    const restartedService = new HostService(restartedStore, residentGateway(() => {
      throw new Error("control compaction must not dispatch a mutation");
    }));
    await restartedService.initialize();
    expect(await readdir(restartedStore.paths.residentControlProjections)).toHaveLength(1);
    expect(await controlSnapshot(restartedService, fixture.hostId, "resident-control-after-compaction"))
      .toEqual(current);
    await restartedService.close();
  });

  it("fails closed at the bound when every retained generation is still current", async () => {
    const fixture = await serviceFixture(
      residentGateway(() => {
        throw new Error("control polling must remain read-only");
      }),
      { residentControlProjectionLimit: 1 },
    );
    await publishIdleResidentProjection(fixture, "resident-control-first-current");
    await controlSnapshot(fixture.service, fixture.hostId, "resident-control-first-current");
    const second = await bootstrapTestWorkspace(fixture.store, {
      operationId: "resident-control-second-bootstrap",
      projectId: "test-project-two",
      workspaceId: "test-workspace-two",
      threadId: "test-thread-two",
      executionGenerationId: "test-execution-two",
      projectionGeneration: "test-projection-two",
    });
    await fixture.store.persistResidentSessionBinding({
      ...fixture.binding,
      threadId: second.thread.threadId,
      executionGenerationId: second.thread.currentLocation.executionGenerationId,
      workspaceDirectory: second.workspaceDirectory,
      activeSessionId: "resident-control-second-active",
      sessionId: "resident-control-second-session",
      sessionFile: join(second.workspaceDirectory, ".prime-agent", "resident-control-second.jsonl"),
    });
    const response = await fixture.service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "resident-control-all-current-capacity",
      method: "thread.control.snapshot",
      payload: {
        expectedHostId: fixture.hostId,
        threadId: second.thread.threadId,
        expectedExecutionGenerationId: second.thread.currentLocation.executionGenerationId,
      },
    }, TRUSTED_USER_SESSION);
    expect(response).toMatchObject({
      ok: false,
      error: { code: "RESIDENT_CONTROL_PROJECTION_LIMIT", retryable: false },
    });
    await fixture.service.close();
  });

  it("passes the exact opaque Store lease, records prompt ownership as running, and short-circuits duplicates", async () => {
    let observedLease: ResidentDispatchLease | undefined;
    const gateway = residentGateway((command, context) => {
      expect(context).toEqual({ residentDispatch: expect.any(Object) });
      const lease = validateResidentDispatchLease(context?.residentDispatch as ResidentDispatchLease);
      observedLease = lease;
      expect(lease.command).toEqual(command);
      expect(lease.binding.threadId).toBe(command.threadId);
      expect(lease.binding.executionGenerationId).toBe(command.expectedExecutionGenerationId);
      expect(Object.isFrozen(lease)).toBe(true);
      expect(Object.isFrozen(lease.command)).toBe(true);
      expect(Object.isFrozen(lease.binding)).toBe(true);
      return { disposition: "accepted", message: "Prime Agent owns this exact prompt" };
    });
    const fixture = await serviceFixture(gateway);
    const command = residentCommand(fixture.hostId, "resident-service-prompt", "prompt");

    const first = await submitCommand(fixture.service, command, "first-prompt-submit");
    const duplicate = await submitCommand(fixture.service, command, "duplicate-prompt-submit");

    expect(first).toMatchObject({
      status: "running",
      message: "Prime Agent owns this exact prompt",
      queuePosition: undefined,
    });
    expect(duplicate).toEqual(first);
    expect(gateway.submit).toHaveBeenCalledOnce();
    expect(gateway.isLive).toHaveBeenCalledOnce();
    expect(observedLease?.command).toEqual(command);
    expect(() =>
      validateResidentDispatchLease(
        structuredClone(observedLease) as ResidentDispatchLease,
      ),
    ).toThrow(expect.objectContaining({ code: "RESIDENT_DISPATCH_LEASE_INVALID" }));
    expect((await fixture.store.reconcileCommands([command])).receipts).toEqual([first]);

    await fixture.service.close();
  });

  it.each([
    [
      "accepted",
      "Prime Agent accepted the stop request; authoritative runtime state will confirm idleness",
    ],
    [
      "not_needed",
      "Prompt admission was cancelled before the runtime owned it",
    ],
  ] as const)(
    "records a nonterminal %s stop acknowledgement without speculating that the projection is idle",
    async (_outcome, abortMessage) => {
      const gateway = residentGateway((command, context) => {
        validateResidentDispatchLease(context?.residentDispatch as ResidentDispatchLease);
        return command.command.kind === "prompt"
          ? { disposition: "accepted", message: "Prime Agent owns the prompt" }
          : { disposition: "handled", message: abortMessage };
      });
      const fixture = await serviceFixture(gateway);
      const prompt = residentCommand(fixture.hostId, `resident-prompt-before-${_outcome}`, "prompt");
      expect(await submitCommand(fixture.service, prompt, `submit-prompt-${_outcome}`)).toMatchObject({
        status: "running",
      });
      await fixture.store.publishResidentProjectionSnapshot(
        fixture.binding,
        projection(fixture.binding, `active-before-${_outcome}`, 1, true),
      );
      expect((await fixture.store.getThreadSnapshot(prompt.threadId)).thread.status).toBe("running");

      const abort = residentCommand(fixture.hostId, `resident-abort-${_outcome}`, "abort");
      const receipt = await submitCommand(fixture.service, abort, `submit-abort-${_outcome}`);

      expect(receipt).toMatchObject({ status: "running", message: abortMessage });
      const after = await fixture.store.getThreadSnapshot(abort.threadId);
      expect(after.thread.status).toBe("running");
      expect(after.latestCursor).toMatchObject({
        generation: `active-before-${_outcome}`,
        sequence: 1,
      });
      expect(gateway.submit).toHaveBeenCalledTimes(2);

      await fixture.service.close();
    },
  );

  it("persists an ambiguous prompt as uncertain and never invokes a gateway for the exact retry after restart", async () => {
    const firstGateway = residentGateway(() => {
      throw new GatewayError(
        "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
        "Prime Agent may own the prompt, but admission evidence was lost",
        false,
        true,
      );
    });
    const fixture = await serviceFixture(firstGateway);
    const command = residentCommand(fixture.hostId, "resident-service-ambiguous", "prompt");

    const uncertain = await submitCommand(fixture.service, command, "submit-ambiguous-first");
    expect(uncertain).toMatchObject({
      status: "uncertain",
      error: {
        code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
        retryable: false,
      },
    });
    expect(firstGateway.submit).toHaveBeenCalledOnce();
    await fixture.service.close();

    const restartedStore = new HostStore(fixture.directory);
    const restartedGateway = residentGateway(() => {
      throw new Error("an exact uncertain command must never be replayed");
    });
    const restartedService = new HostService(restartedStore, restartedGateway);
    await restartedService.initialize();
    const duplicate = await submitCommand(restartedService, command, "submit-ambiguous-after-restart");

    expect(duplicate).toEqual(uncertain);
    expect(restartedGateway.isLive).not.toHaveBeenCalled();
    expect(restartedGateway.submit).not.toHaveBeenCalled();
    expect((await restartedStore.reconcileCommands([command])).receipts).toEqual([uncertain]);
    await restartedService.close();
  });

  it("retains an uncertain Stop as a no-replay mutation barrier before and after a late upstream side effect", async () => {
    const lateAbortSideEffect = deferred<void>();
    let lateAbortExecutions = 0;
    const firstGateway = residentGateway((command) => {
      if (command.command.kind !== "abort") {
        throw new Error("the abort barrier must reject newer prompts before gateway dispatch");
      }
      void lateAbortSideEffect.promise.then(() => {
        lateAbortExecutions += 1;
      });
      throw new GatewayError(
        "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
        "Stop may execute after the transport outcome is lost",
        false,
        true,
      );
    });
    const fixture = await serviceFixture(firstGateway);
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, "resident-active-before-uncertain-stop", 1, true),
    );
    const abort = residentCommand(fixture.hostId, "resident-service-uncertain-abort", "abort");

    const uncertain = await submitCommand(fixture.service, abort, "submit-uncertain-abort");
    expect(uncertain).toMatchObject({
      status: "uncertain",
      error: { code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN", retryable: false },
    });
    expect(firstGateway.submit).toHaveBeenCalledOnce();
    expect(await submitCommand(fixture.service, abort, "duplicate-uncertain-abort")).toEqual(uncertain);
    expect(firstGateway.submit).toHaveBeenCalledOnce();

    const promptBeforeLateEffect = residentCommand(
      fixture.hostId,
      "resident-prompt-before-late-abort",
      "prompt",
    );
    expect(await submitCommand(fixture.service, promptBeforeLateEffect, "prompt-before-late-abort")).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_ABORT_OUTCOME_UNCERTAIN", retryable: false },
    });
    lateAbortSideEffect.resolve(undefined);
    await lateAbortSideEffect.promise;
    await Promise.resolve();
    expect(lateAbortExecutions).toBe(1);
    const promptAfterLateEffect = residentCommand(
      fixture.hostId,
      "resident-prompt-after-late-abort",
      "prompt",
    );
    expect(await submitCommand(fixture.service, promptAfterLateEffect, "prompt-after-late-abort")).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_ABORT_OUTCOME_UNCERTAIN", retryable: false },
    });
    await fixture.service.close();

    const restartedStore = new HostStore(fixture.directory);
    const restartedGateway = residentGateway(() => {
      throw new Error("an uncertain Stop or a mutation behind it must never be replayed");
    });
    const restartedService = new HostService(restartedStore, restartedGateway);
    await restartedService.initialize();
    expect(await submitCommand(restartedService, abort, "duplicate-uncertain-abort-after-restart"))
      .toEqual(uncertain);
    const freshAbort = residentCommand(fixture.hostId, "resident-abort-after-uncertain-restart", "abort");
    expect(await submitCommand(restartedService, freshAbort, "fresh-abort-after-uncertain-restart"))
      .toMatchObject({
        status: "rejected",
        error: { code: "RESIDENT_ABORT_OUTCOME_UNCERTAIN", retryable: false },
      });
    expect(restartedGateway.isLive).toHaveBeenCalledOnce();
    expect(restartedGateway.submit).not.toHaveBeenCalled();
    await restartedService.close();
  });

  it("rejects Stop from a second request while the admitted prompt is paused before its dispatch boundary", async () => {
    const gateway = residentGateway((command) => ({
      disposition: command.command.kind === "prompt" ? "accepted" : "handled",
      message: command.command.kind === "prompt"
        ? "Prime Agent owns the prompt"
        : "Prime Agent accepted Stop",
    }));
    const fixture = await serviceFixture(gateway);
    const promptBeginEntered = deferred<void>();
    const releasePromptBegin = deferred<void>();
    const beginResidentDispatch = fixture.store.beginResidentDispatch.bind(fixture.store);
    vi.spyOn(fixture.store, "beginResidentDispatch").mockImplementation(async (command) => {
      if (command.command.kind === "prompt") {
        promptBeginEntered.resolve(undefined);
        await releasePromptBegin.promise;
      }
      return beginResidentDispatch(command);
    });
    const prompt = residentCommand(fixture.hostId, "resident-barrier-prompt", "prompt");
    const promptSubmission = submitCommand(fixture.service, prompt, "barrier-session-one");
    await promptBeginEntered.promise;
    expect((await fixture.store.reconcileCommands([prompt])).receipts[0]).toMatchObject({
      status: "admitted",
    });

    const abort = residentCommand(fixture.hostId, "resident-barrier-abort", "abort");
    const abortReceipt = await submitCommand(fixture.service, abort, "barrier-session-two");
    expect(abortReceipt).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_PROMPT_DELIVERY_PENDING", retryable: true },
    });
    expect(gateway.submit.mock.calls.filter(([command]) => command.command.kind === "abort")).toHaveLength(0);

    releasePromptBegin.resolve(undefined);
    await expect(promptSubmission).resolves.toMatchObject({ status: "running" });
    expect(gateway.submit.mock.calls.filter(([command]) => command.command.kind === "prompt")).toHaveLength(1);
    await fixture.service.close();
  });

  it("dispatches Stop through the resident gateway while a model mutation is deferred on the same framed session", async () => {
    const modelGatewayEntered = deferred<void>();
    const releaseModelGateway = deferred<void>();
    const abortGatewayEntered = deferred<boolean>();
    let modelGatewayReleased = false;
    const gateway = residentGateway(async (command) => {
      if (command.command.kind === "model.select") {
        modelGatewayEntered.resolve(undefined);
        await releaseModelGateway.promise;
        return { disposition: "handled", message: "Prime Agent selected the model" };
      }
      if (command.command.kind === "abort") {
        abortGatewayEntered.resolve(modelGatewayReleased);
        return { disposition: "handled", message: "Prime Agent accepted Stop" };
      }
      return { disposition: "accepted", message: "Prime Agent accepted the prompt" };
    });
    const fixture = await serviceFixture(gateway);
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, "framed-active", 1, true),
    );
    const model: CommandEnvelope = {
      ...residentCommand(fixture.hostId, "framed-model-select", "prompt"),
      command: {
        kind: "model.select",
        providerId: "openai-codex",
        modelId: "gpt-5.3-codex",
      },
    };
    const abort = residentCommand(fixture.hostId, "framed-abort", "abort");
    const readable = new PassThrough();
    const writable = new PassThrough();
    const frames: Array<Record<string, unknown>> = [];
    const decoder = new LengthPrefixedJsonDecoder<Record<string, unknown>>();
    writable.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
    const session = runFramedSession(
      fixture.service,
      readable,
      writable,
      TRUSTED_USER_SESSION,
    );

    readable.write(encodeJsonFrame(commandRequest("framed-model-request", model)));
    await modelGatewayEntered.promise;
    readable.write(encodeJsonFrame(commandRequest("framed-abort-request", abort)));
    try {
      // This timeout bounds a wedged test harness; the semantic assertion is
      // that Stop reaches the gateway before the deferred model mutation ends.
      const modelWasReleasedWhenAbortEnteredGateway = await withTimeout(abortGatewayEntered.promise, 2_000);
      expect(modelWasReleasedWhenAbortEnteredGateway).toBe(false);
      await vi.waitFor(() => {
        expect(frames.find((frame) => frame.requestId === "framed-abort-request")).toMatchObject({
          ok: true,
          method: "command.submit",
          result: { status: "running", message: "Prime Agent accepted Stop" },
        });
      }, { timeout: 1_000 });
      expect(frames.findIndex((frame) => frame.requestId === "framed-model-request")).toBe(-1);
      modelGatewayReleased = true;
      releaseModelGateway.resolve(undefined);
      await vi.waitFor(() => {
        expect(frames.some((frame) => frame.requestId === "framed-model-request")).toBe(true);
      });
      const correlatedResponses = frames.filter((frame) => typeof frame.requestId === "string");
      expect(correlatedResponses.map((frame) => frame.requestId)).toEqual([
        "framed-abort-request",
        "framed-model-request",
      ]);
    } finally {
      modelGatewayReleased = true;
      releaseModelGateway.resolve(undefined);
      readable.end();
      await session;
      await fixture.service.close();
    }

  });
});

async function serviceFixture(gateway: PrimeAgentGateway, storeOptions: HostStoreOptions = {}): Promise<{
  directory: string;
  service: HostService;
  store: HostStore;
  hostId: string;
  binding: ResidentSessionBinding;
}> {
  const directory = await mkdtemp(join(tmpdir(), "prime-resident-service-integration-"));
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const workspaceDirectory = await realpath(workspacePath);
  const store = new HostStore(directory, storeOptions);
  const service = new HostService(store, gateway);
  await service.initialize();
  await bootstrapTestWorkspace(store, { workspaceDirectory });
  await store.registerWorkspaceAuthority({
    threadId: "test-thread",
    executionGenerationId: "test-execution-1",
    workspaceDirectory,
  });
  const residentBinding = binding(workspaceDirectory);
  await store.persistResidentSessionBinding(residentBinding);
  return {
    directory,
    service,
    store,
    hostId: (await store.getHost()).hostId,
    binding: residentBinding,
  };
}

type FakeResidentGateway = PrimeAgentGateway & {
  isLive: ReturnType<typeof vi.fn>;
  isResidentBindingLive: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function residentGateway(
  handler: (
    command: CommandEnvelope,
    context?: GatewayDispatchContext,
  ) => GatewayAdmission | Promise<GatewayAdmission>,
  options: { bindingLive?: boolean } = {},
): FakeResidentGateway {
  return {
    continuity: "resident",
    isLive: vi.fn(async () => true),
    isResidentBindingLive: vi.fn(async () => options.bindingLive ?? true),
    submit: vi.fn(async (command: CommandEnvelope, context?: GatewayDispatchContext) =>
      handler(command, context)),
    close: vi.fn(async () => undefined),
  };
}

async function publishIdleResidentProjection(
  fixture: { store: HostStore; binding: ResidentSessionBinding },
  generation: string,
): Promise<void> {
  await fixture.store.publishResidentProjectionSnapshot(
    fixture.binding,
    projection(fixture.binding, generation, 1, false),
  );
}

function binding(workspaceDirectory: string): ResidentSessionBinding {
  return {
    bindingVersion: 1,
    lifecycle: "resident",
    threadId: "test-thread",
    executionGenerationId: "test-execution-1",
    workspaceDirectory,
    activeSessionId: "active-session-service-1",
    sessionId: "session-service-1",
    sessionFile: join(workspaceDirectory, ".prime-agent", "session-service-1.jsonl"),
    boundAt: "2026-08-07T21:00:00.000Z",
    runtime: {
      releaseVersion: PINNED_PRIME_AGENT_RUNTIME.releaseVersion,
      appVersion: PINNED_PRIME_AGENT_RUNTIME.expectedAppVersion,
      protocolName: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolName,
      protocolVersion: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolVersion,
      schemaRevision: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaRevision,
      schemaId: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaId,
      capabilities: [...REQUIRED_RESIDENT_DAEMON_CAPABILITIES],
      runtimeBuildId: PINNED_PRIME_AGENT_RUNTIME.runtimeBuildId,
    },
  };
}

function residentCommand(
  expectedHostId: string,
  commandId: string,
  kind: "prompt" | "abort",
): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "resident-service-device",
    commandId,
    expectedHostId,
    threadId: "test-thread",
    issuedAt: "2026-08-07T21:01:00.000Z",
    expectedExecutionGenerationId: "test-execution-1",
    command: kind === "prompt"
      ? { kind, text: "Inspect the resident workspace through the durable session." }
      : { kind, reason: "Stop the current resident turn." },
  };
}

function projection(
  residentBinding: ResidentSessionBinding,
  generation: string,
  sequence: number,
  active: boolean,
): ResidentProjectionSnapshot {
  return {
    projectionVersion: 1,
    identity: {
      activeSessionId: residentBinding.activeSessionId,
      sessionId: residentBinding.sessionId,
      sessionFile: residentBinding.sessionFile,
      workspaceDirectory: residentBinding.workspaceDirectory,
    },
    cursor: { generation, sequence },
    runtime: {
      runtime: "prime_agent",
      residency: "resident",
      appVersion: residentBinding.runtime.appVersion,
      activeSessionId: residentBinding.activeSessionId,
      sessionId: residentBinding.sessionId,
      isStreaming: active,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      steeringMode: "all",
      followUpMode: "all",
      messageCount: 1,
      compactionCount: 0,
      queuedActionCount: active ? 1 : 0,
      activeToolNames: [],
      recap: active ? "Resident turn remains active." : "Resident session is idle.",
    },
    transcript: [],
    childAgents: [],
    queue: active
      ? {
          queuedCount: 0,
          steeringCount: 0,
          followUpCount: 0,
          active: { kind: "turn", phase: "running", label: "Resident turn" },
        }
      : { queuedCount: 0, steeringCount: 0, followUpCount: 0 },
  };
}

async function submitCommand(
  service: HostService,
  command: CommandEnvelope,
  requestId: string,
): Promise<CommandReceipt> {
  const response = await service.handle(
    {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      method: "command.submit",
      payload: { command },
    },
    TRUSTED_USER_SESSION,
  );
  if (!response.ok || response.method !== "command.submit") {
    throw new Error("Resident command submission failed at the host protocol boundary");
  }
  return response.result;
}

async function controlSnapshot(
  service: HostService,
  expectedHostId: string,
  requestId: string,
): Promise<ResidentControlProjectionSnapshot> {
  const response = await service.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method: "thread.control.snapshot",
    payload: {
      expectedHostId,
      threadId: "test-thread",
      expectedExecutionGenerationId: "test-execution-1",
    },
  }, TRUSTED_USER_SESSION);
  if (!response.ok || response.method !== "thread.control.snapshot") {
    throw new Error("Resident control projection request failed at the host protocol boundary");
  }
  return response.result;
}

function commandRequest(requestId: string, command: CommandEnvelope) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method: "command.submit",
    payload: { command },
  } as const;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
