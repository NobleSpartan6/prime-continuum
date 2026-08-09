import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import {
  CODEX_SUBSCRIPTION_BACKEND_ID,
  CODEX_SUBSCRIPTION_BACKEND_LABEL,
  CodexSubscriptionAccountSnapshotSchema,
  CodexSubscriptionConversationLookupSchema,
  CodexSubscriptionConversationSnapshotSchema,
  CodexSubscriptionLoginStartResultSchema,
  CodexSubscriptionTurnReconciliationSchema,
  type CodexSubscriptionAccountReadRequest,
  type CodexSubscriptionAccountSnapshot,
  type CodexSubscriptionConversationLookup,
  type CodexSubscriptionConversationSnapshot,
  type CodexSubscriptionLoginCancelRequest,
  type CodexSubscriptionLoginStartRequest,
  type CodexSubscriptionLoginStartResult,
  type CodexSubscriptionLogoutRequest,
  type CodexSubscriptionPlanType,
  type CodexSubscriptionRequestBinding,
  type CodexSubscriptionTurnInterruptRequest,
  type CodexSubscriptionTurnReconciliation,
  type CodexSubscriptionTurnStartRequest,
  type CodexSubscriptionWorkspaceBinding,
} from "../shared/protocol";
import { isOfficialCodexAppServerLoginUrl } from "../shared/codex-app-server-auth";
import {
  CodexAppServerClient,
  CodexAppServerClientError,
  type CodexAppServerClientErrorCode,
  type CodexAppServerNotification,
} from "./codex-app-server-client";
import {
  CODEX_HOME_CONTENT_POLICY,
  CodexHomeSecurityError,
  WindowsCodexHomeSecurityProvider,
  type CodexHomeSecurityProof,
  type CodexHomeSecurityProvider,
} from "./codex-home-security";
import {
  WindowsJobCodexAppServerProcessLauncher,
  type CodexAppServerProcessLauncher,
} from "./codex-app-server-process";
import {
  CodexSubscriptionStore,
  CodexSubscriptionStoreError,
  type CodexAuthoritativeTurnProof,
  type CodexSubscriptionRecoveryRecord,
} from "./codex-subscription-store";
import type { HostDataPaths } from "./paths";
import type {
  VerifiedCodexAppServerLaunchDescriptor,
  VerifiedInstalledRuntimeHandle,
} from "./runtime-integrity-manager";
import type { HostStore } from "./store";

const EXECUTION_POLICY = Object.freeze({
  filesystem: "read_only_user_scope",
  workspaceReadConfinement: false,
  toolNetworkAccess: false,
  approvalPolicy: "never",
  disclosure:
    "Codex tools cannot write files or open network connections. They may read other files available to your Windows account; this is not a workspace-only sandbox. Prompts and content Codex reads—including workspace instructions and tool-read files—are sent to OpenAI for the turn.",
} as const);
const NOTIFICATION_QUEUE_LIMIT = 256;
const NOTIFICATION_BYTES_LIMIT = 512 * 1024;
const INTERRUPT_PROOF_TIMEOUT_MS = 35_000;
const LOGIN_ATTEMPT_TTL_MS = 10 * 60_000;
const CANARY_NOTIFICATION_TIMEOUT_MS = 5_000;
const CAPABILITY_PREPARATION_RETRY_MS = 30_000;
const SYNCHRONOUS_FORBIDDEN_NOTIFICATIONS = new Set([
  "configWarning",
  "deprecationNotice",
  "guardianWarning",
  "hook/completed",
  "hook/started",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "mcpServer/startupStatus/updated",
  "model/rerouted",
  "model/verification",
  "serverRequest/resolved",
  "turn/diff/updated",
  "warning",
  "windows/worldWritableWarning",
]);
const MAX_COMMAND_ITEMS = 16;
const MAX_COMMAND_ACTIONS = 32;
const MAX_COMMAND_TEXT_BYTES = 64 * 1_024;
const MAX_COMMAND_OUTPUT_BYTES = 512 * 1_024;
const MAX_INSTRUCTION_SOURCE_BYTES = 64 * 1_024;
const PLAN_TYPES = new Set<CodexSubscriptionPlanType>([
  "free", "go", "plus", "pro", "prolite", "team", "self_serve_business_prolite",
  "self_serve_business_usage_based", "business", "ent26", "enterprise_cbp_automation",
  "enterprise_cbp_usage_based", "enterprise", "edu", "unknown",
]);

type JsonRecord = Record<string, unknown>;

export type CodexSubscriptionBackendErrorCode =
  | "CODEX_SUBSCRIPTION_UNAVAILABLE"
  | "CODEX_HOST_AUTHORITY_MISMATCH"
  | "CODEX_ACCOUNT_REQUIRED"
  | "CODEX_LOGIN_OUTCOME_UNKNOWN"
  | "CODEX_PROTOCOL_VIOLATION"
  | "CODEX_RUNTIME_BUSY"
  | "CODEX_TURN_OUTCOME_UNKNOWN";

export class CodexSubscriptionBackendError extends Error {
  constructor(
    readonly code: CodexSubscriptionBackendErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CodexSubscriptionBackendError";
  }
}

export interface CodexSubscriptionRuntimeProvider {
  snapshot(): { readonly status: string };
  acquireVerifiedRuntimeHandle(): Promise<VerifiedInstalledRuntimeHandle>;
}

export interface CodexSubscriptionBackendOptions {
  readonly paths: HostDataPaths;
  readonly authorityStore: Pick<HostStore, "resolveWorkspaceDirectory">;
  readonly runtimeHandles: CodexSubscriptionRuntimeProvider;
  readonly clientVersion: string;
  readonly platform?: NodeJS.Platform;
  readonly store?: CodexSubscriptionStore;
  readonly homeSecurity?: CodexHomeSecurityProvider;
  readonly launcher?: CodexAppServerProcessLauncher;
  /** Test-only seam; production always composes the attested Job transport. */
  readonly clientFactory?: (
    descriptor: VerifiedCodexAppServerLaunchDescriptor,
    home: CodexHomeSecurityProof,
  ) => CodexSubscriptionAppServerClient;
  readonly idFactory?: () => string;
  readonly now?: () => number;
}

export type CodexSubscriptionAppServerClient = Pick<CodexAppServerClient,
  | "initialize"
  | "readAccount"
  | "startChatGptLogin"
  | "cancelLogin"
  | "logout"
  | "readEffectiveConfig"
  | "listMcpServers"
  | "listHooks"
  | "listPlugins"
  | "listApps"
  | "readWindowsSandboxReadiness"
  | "startThread"
  | "resumeThread"
  | "readThread"
  | "deleteThread"
  | "startTurn"
  | "interruptTurn"
  | "subscribe"
  | "subscribeDeniedServerRequests"
  | "subscribeFailures"
  | "assertHealthy"
  | "close"
>;

interface AccountProjection {
  phase: CodexSubscriptionAccountSnapshot["phase"];
  pendingLoginId?: string;
  pendingLoginOperationId?: string;
  planType?: CodexSubscriptionPlanType;
  error?: Readonly<{ code: string; message: string; retryable: boolean }>;
}

type ParsedAccount =
  | Readonly<{ signedIn: false }>
  | Readonly<{ signedIn: true; planType: CodexSubscriptionPlanType }>;

interface SettledLoginAuthority {
  readonly operationId: string;
  readonly loginId: string;
}

interface ActiveTurnAuthority {
  readonly operationId: string;
  readonly threadId: string;
  readonly turnId: string;
}

interface ActiveCommandAuthority {
  readonly fingerprint: string;
  outputBytes: number;
}

interface InterruptWaiter {
  readonly targetTurnOperationId: string;
  readonly promise: Promise<CodexSubscriptionConversationSnapshot>;
  readonly resolve: (snapshot: CodexSubscriptionConversationSnapshot) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type CapabilityPreparationStage =
  | "runtime_handle"
  | "home_prelaunch"
  | "home_postlaunch"
  | "transport_launch"
  | "initialize"
  | "config_read"
  | "mcp_list"
  | "hooks_list"
  | "plugins_list"
  | "apps_list"
  | "sandbox_readiness"
  | "canary_start"
  | "canary_delete"
  | "canary_notifications"
  | "home_postflight"
  | "account_read"
  | "account_recovery";

/**
 * One-host preview backend for the official attested Codex app-server.
 * All mutations and provider notifications share one FIFO authority queue.
 */
export class CodexSubscriptionBackend {
  readonly backendIncarnationId: string;
  private readonly store: CodexSubscriptionStore;
  private readonly homeSecurity: CodexHomeSecurityProvider;
  private readonly launcher: CodexAppServerProcessLauncher;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private hostId: string | undefined;
  private initialized = false;
  private fatalError: CodexSubscriptionBackendError | undefined;
  private fatalSettlementStarted = false;
  private client: CodexSubscriptionAppServerClient | undefined;
  private descriptor: VerifiedCodexAppServerLaunchDescriptor | undefined;
  private homeProof: CodexHomeSecurityProof | undefined;
  private compositionPromise: Promise<CodexSubscriptionAppServerClient> | undefined;
  private capabilityPreparationPromise: Promise<void> | undefined;
  private capabilityPreparationStage: CapabilityPreparationStage | undefined;
  private capabilityRetryBlocked = false;
  private capabilityRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private account: AccountProjection = {
    phase: "unavailable",
    error: {
      code: "CODEX_SUBSCRIPTION_UNAVAILABLE",
      message: "Codex via ChatGPT subscription is still initializing",
      retryable: true,
    },
  };
  private preflightVerifiedAt: string | undefined;
  private lastTimestampMs = 0;
  private readonly accountRecoveries: CodexSubscriptionRecoveryRecord[] = [];
  private transientAuthorization: CodexSubscriptionLoginStartResult["authorization"] | undefined;
  private lastSettledLogin: SettledLoginAuthority | undefined;
  private activeTurn: ActiveTurnAuthority | undefined;
  private readonly activeCommands = new Map<string, ActiveCommandAuthority>();
  private preflightInProgress = false;
  private turnStartInProgress = false;
  private readonly canaryThreadIds = new Set<string>();
  private canaryThreadId: string | undefined;
  private canaryStarted = false;
  private canaryNotLoaded = false;
  private canaryDeleted = false;
  private canaryNotificationError: Error | undefined;
  private readonly pendingCanaryNotifications: CodexAppServerNotification[] = [];
  private canaryNotificationWaiter: Readonly<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> | undefined;
  private readonly interruptWaiters = new Map<string, InterruptWaiter>();
  private readonly notificationBuffer: CodexAppServerNotification[] = [];
  private notificationBytes = 0;
  private notificationTimer: ReturnType<typeof setTimeout> | undefined;
  private loginExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: CodexSubscriptionBackendOptions) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    const idFactory = options.idFactory ?? randomUUID;
    this.backendIncarnationId = `codex-backend-${idFactory()}`;
    this.store = options.store ?? new CodexSubscriptionStore({
      statePath: options.paths.codexSubscriptionState,
      now: this.now,
      idFactory,
    });
    this.homeSecurity = options.homeSecurity ?? new WindowsCodexHomeSecurityProvider({ platform: this.platform });
    this.launcher = options.launcher ?? new WindowsJobCodexAppServerProcessLauncher({ platform: this.platform });
    if (!/^[A-Za-z0-9._:+-]{1,128}$/.test(options.clientVersion)) {
      throw new TypeError("Codex app-server client version is invalid");
    }
  }

  /** Optional capability initialization never blocks or fails core host startup. */
  async initialize(hostId: string): Promise<void> {
    if (this.initialized) return;
    this.hostId = boundedId(hostId, "Host identifier");
    try {
      if (this.platform !== "win32") {
        throw unavailable("Codex via ChatGPT subscription is available only on Windows", false);
      }
      // The entire private root, including durable subscription state, must be
      // protected before the Store may create, read, recover, or rewrite a byte.
      this.homeProof = await this.homeSecurity.prepareAndVerify(
        this.options.paths.root,
        this.options.paths.codexHome,
        this.options.paths.codexTemporary,
      );
      this.accountRecoveries.push(...await this.store.initialize());
    } catch {
      this.fatalError = unavailable("Codex subscription state is unavailable", false);
      this.account = accountError(this.fatalError);
    }
    this.initialized = true;
  }

  async capabilityReady(): Promise<boolean> {
    if (
      !this.initialized || this.closed || this.platform !== "win32" || this.fatalError ||
      this.options.runtimeHandles.snapshot().status !== "ready"
    ) return false;
    if (this.client && this.preflightVerifiedAt) {
      try {
        this.client.assertHealthy();
        return true;
      } catch {
        return false;
      }
    }
    this.scheduleCapabilityPreparation();
    return false;
  }

  async accountRead(request: CodexSubscriptionAccountReadRequest): Promise<CodexSubscriptionAccountSnapshot> {
    return this.serialized(async () => {
      this.assertHost(request.expectedHostId);
      const client = await this.ensureClient();
      const pending = this.pendingLoginAuthority();
      const parsed = await this.refreshAccount(client, true);
      if (parsed.signedIn && pending) {
        await this.settleLoginFromAccountRead(pending.operationId, pending.loginId, parsed);
      }
      return this.accountSnapshot();
    });
  }

  async loginStart(request: CodexSubscriptionLoginStartRequest): Promise<CodexSubscriptionLoginStartResult> {
    return this.serialized(async () => {
      this.assertHost(request.expectedHostId);
      const client = await this.ensureClient();
      if (this.account.phase !== "signed_out") {
        throw new CodexSubscriptionBackendError(
          "CODEX_RUNTIME_BUSY",
          "Codex login can start only from an authoritative signed-out account",
          true,
        );
      }
      const admission = await this.store.admitAccountMutation(
        "login",
        request.expectedHostId,
        request.operationId,
        request.expectedBackendIncarnationId,
        this.backendIncarnationId,
      );
      if (admission.duplicate) {
        if (
          this.transientAuthorization?.operationId === request.operationId &&
          admission.operation.phase === "active"
        ) {
          return CodexSubscriptionLoginStartResultSchema.parse({
            account: this.accountSnapshot("opening_browser"),
            authorization: this.transientAuthorization,
          });
        }
        throw new CodexSubscriptionBackendError(
          "CODEX_LOGIN_OUTCOME_UNKNOWN",
          "The login attempt is durable, but its one-time browser URL cannot be replayed",
          true,
        );
      }
      await this.store.markAccountMutationDispatching(request.operationId);
      try {
        const result = await this.withSecureHome(() => client.startChatGptLogin());
        const authorization = parseLoginStart(result, request.operationId);
        await this.store.markLoginActive(request.operationId, authorization.loginId);
        this.transientAuthorization = authorization;
        this.account = {
          phase: "opening_browser",
          pendingLoginId: authorization.loginId,
          pendingLoginOperationId: request.operationId,
        };
        const opening = this.accountSnapshot();
        this.account.phase = "waiting_for_login";
        this.scheduleLoginExpiry(request.operationId, authorization.loginId);
        return CodexSubscriptionLoginStartResultSchema.parse({ account: opening, authorization });
      } catch (error) {
        await this.store.completeAccountMutation(
          request.operationId,
          ambiguousClientFailure(error) ? "uncertain" : "failed",
        ).catch(() => undefined);
        throw sanitizeBackendFailure(error, "Codex login could not be started");
      }
    });
  }

  async loginCancel(request: CodexSubscriptionLoginCancelRequest): Promise<CodexSubscriptionAccountSnapshot> {
    return this.serialized(async () => {
      this.assertHost(request.expectedHostId);
      this.assertIncarnation(request.expectedBackendIncarnationId);
      const client = await this.ensureClient();
      const existing = await this.store.getOperation(request.loginOperationId);
      if (
        existing?.kind === "login" &&
        existing.loginId === request.loginId &&
        (existing.phase === "failed" || existing.phase === "completed")
      ) {
        const parsed = parseAccount(await this.withSecureHome(() => client.readAccount()));
        await this.settleLoginFromAccountRead(request.loginOperationId, request.loginId, parsed);
        return this.accountSnapshot();
      }
      await this.store.beginLoginCancel(request.loginOperationId, request.loginId);
      this.clearLoginExpiry();
      try {
        const result = requireExactRecord(await this.withSecureHome(() => client.cancelLogin(request.loginId)), ["status"]);
        if (result.status !== "canceled" && result.status !== "notFound") protocolViolation();
        const parsed = parseAccount(await this.withSecureHome(() => client.readAccount()));
        await this.settleLoginFromAccountRead(request.loginOperationId, request.loginId, parsed);
        return this.accountSnapshot();
      } catch (error) {
        await this.store.completeAccountMutation(
          request.loginOperationId,
          ambiguousClientFailure(error) ? "uncertain" : "failed",
        ).catch(() => undefined);
        throw sanitizeBackendFailure(error, "Codex login cancellation could not be confirmed");
      }
    });
  }

  async logout(request: CodexSubscriptionLogoutRequest): Promise<CodexSubscriptionAccountSnapshot> {
    return this.serialized(async () => {
      this.assertHost(request.expectedHostId);
      this.assertIncarnation(request.expectedBackendIncarnationId);
      const client = await this.ensureClient();
      await this.store.assertQuiescent();
      const admission = await this.store.admitAccountMutation(
        "logout",
        request.expectedHostId,
        request.operationId,
        request.expectedBackendIncarnationId,
        this.backendIncarnationId,
      );
      if (admission.duplicate) {
        await this.refreshAccount(client, false);
        return this.accountSnapshot();
      }
      await this.store.markAccountMutationDispatching(request.operationId);
      try {
        requireExactRecord(await this.withSecureHome(() => client.logout()), []);
        await this.store.completeAccountMutation(request.operationId, "completed");
        this.clearLoginExpiry();
        this.transientAuthorization = undefined;
        this.account = { phase: "signed_out" };
        return this.accountSnapshot();
      } catch (error) {
        await this.store.completeAccountMutation(
          request.operationId,
          ambiguousClientFailure(error) ? "uncertain" : "failed",
        ).catch(() => undefined);
        throw sanitizeBackendFailure(error, "Codex logout could not be confirmed");
      }
    });
  }

  async conversationSnapshot(
    request: CodexSubscriptionRequestBinding,
  ): Promise<CodexSubscriptionConversationLookup> {
    return this.serialized(async () => {
      this.assertHost(request.expectedHostId);
      let conversation = await this.store.getConversation(bindingFromRequest(request), this.backendIncarnationId);
      if (conversation?.state === "uncertain") {
        conversation = await this.reconcileUncertainConversation(request, conversation);
      }
      return CodexSubscriptionConversationLookupSchema.parse({ conversation: conversation ?? null });
    });
  }

  async turnStart(request: CodexSubscriptionTurnStartRequest): Promise<CodexSubscriptionConversationSnapshot> {
    return this.serialized(async () => {
      this.assertHost(request.expectedHostId);
      const client = await this.ensureClient();
      this.requireTurnReady();
      const cwd = await this.options.authorityStore.resolveWorkspaceDirectory(
        request.threadId,
        request.expectedExecutionGenerationId,
      );
      try {
        await this.runWorkspacePreflight(client, cwd);
      } catch (error) {
        await this.retireClientOrFence(
          "Codex app-server retirement could not be confirmed after workspace preflight failed",
        );
        throw error;
      }
      const admission = await this.store.admitTurn(request, this.backendIncarnationId);
      if (admission.duplicate) return admission.snapshot;
      let dispatchSnapshot = admission.snapshot;
      let promptDispatchStarted = false;
      try {
        dispatchSnapshot = await this.store.markTurnStartingThread(request.operationId, this.backendIncarnationId);
        this.turnStartInProgress = true;
        const instructionSources = await expectedWorkspaceInstructionSources(cwd);
        const threadResult = dispatchSnapshot.threadId
          ? await client.resumeThread(dispatchSnapshot.threadId, { cwd })
          : await client.startThread({ cwd });
        this.throwIfFatal();
        const threadId = validateThreadSecurityResponse(
          threadResult,
          cwd,
          this.descriptorRequired(),
          dispatchSnapshot.threadId,
          instructionSources,
        );
        if (!sameJson(instructionSources, await expectedWorkspaceInstructionSources(cwd))) protocolViolation();
        dispatchSnapshot = await this.store.bindThread(request.operationId, threadId, this.backendIncarnationId);
        await this.runWorkspacePreflight(client, cwd, threadId);
        const operation = await this.store.getOperation(request.operationId);
        if (!operation?.clientUserMessageId) protocolViolation();
        dispatchSnapshot = await this.store.markTurnPromptDispatching(
          request.operationId,
          this.backendIncarnationId,
        );
        promptDispatchStarted = true;
        const turnResponse = await client.startTurn({
          cwd,
          threadId,
          clientUserMessageId: operation.clientUserMessageId,
          prompt: request.prompt,
        });
        this.throwIfFatal();
        const turnResult = parseTurnStart(turnResponse);
        dispatchSnapshot = await this.store.bindTurn(request.operationId, turnResult.turnId, this.backendIncarnationId);
        this.activeTurn = { operationId: request.operationId, threadId, turnId: turnResult.turnId };
        await this.homeSecurity.assertStillSecure(this.homeRequired(), this.descriptorRequired());
        return dispatchSnapshot;
      } catch (error) {
        // Thread creation/resume is pre-prompt work. Even an ambiguous response
        // is safe to fail only after the exact Job is positively retired.
        if (!promptDispatchStarted) {
          try {
            await this.retireClient(false);
          } catch {
            this.fatalError = unavailable(
              "Codex app-server retirement could not be confirmed after a pre-prompt failure",
              false,
            );
            throw this.fatalError;
          }
        }
        const uncertain = promptDispatchStarted && ambiguousClientFailure(error);
        dispatchSnapshot = await this.store.completeTurn(request.operationId, {
          state: uncertain ? "uncertain" : "failed",
          error: {
            code: uncertain ? "CODEX_TURN_OUTCOME_UNKNOWN" : "CODEX_TURN_START_FAILED",
            message: uncertain
              ? "Codex may have started the turn, but its outcome could not be confirmed"
              : "Codex rejected the turn before a confirmed start",
            retryable: uncertain,
          },
        }, this.backendIncarnationId).catch(() => dispatchSnapshot);
        if (uncertain) await this.retireClientOrFence(
          "Codex app-server retirement could not be confirmed after an uncertain turn start",
        );
        throw sanitizeBackendFailure(error, "Codex turn could not be started");
      } finally {
        this.turnStartInProgress = false;
      }
    });
  }

  async turnInterrupt(
    request: CodexSubscriptionTurnInterruptRequest,
  ): Promise<CodexSubscriptionConversationSnapshot> {
    const prepared = await this.serialized(async () => {
      this.assertHost(request.expectedHostId);
      const client = await this.ensureClient();
      const admission = await this.store.admitInterrupt(request, this.backendIncarnationId);
      if (admission.duplicate) {
        if (admission.snapshot.latestTurn?.terminal) return { terminal: admission.snapshot } as const;
        const waiter = this.interruptWaiters.get(request.operationId);
        if (!waiter) {
          throw new CodexSubscriptionBackendError(
            "CODEX_TURN_OUTCOME_UNKNOWN",
            "Codex Stop is already durable, but this backend cannot yet prove its outcome",
            true,
          );
        }
        return { pending: waiter.promise } as const;
      }
      await this.store.markInterruptDispatching(request.operationId, this.backendIncarnationId);
      const pending = this.createInterruptWaiter(request.operationId, request.expectedTurnOperationId);
      void client.interruptTurn(request.codexThreadId, request.turnId).then(
        (result) => this.enqueue(async () => {
          requireExactRecord(result, []);
          // Acknowledgement is deliberately not terminal proof.
        }),
        (error) => this.enqueue(() => this.handleInterruptRequestFailure(request.operationId, error)),
      ).catch(() => undefined);
      return { pending } as const;
    });
    if (prepared.terminal !== undefined) return prepared.terminal;
    return prepared.pending;
  }

  async turnReconcile(request: CodexSubscriptionTurnStartRequest): Promise<CodexSubscriptionTurnReconciliation> {
    return this.serialized(async () => {
      this.assertHost(request.expectedHostId);
      const record = await this.store.reconcileTurn(request, this.backendIncarnationId);
      if (!record.known || !record.snapshot) {
        return CodexSubscriptionTurnReconciliationSchema.parse({
          known: false,
          operationId: request.operationId,
          binding: bindingFromRequest(request),
        });
      }
      let conversation = record.snapshot;
      if (conversation.state === "uncertain") {
        conversation = await this.reconcileUncertainConversation(request, conversation);
      }
      return CodexSubscriptionTurnReconciliationSchema.parse({
        known: true,
        operationId: request.operationId,
        conversation,
      });
    });
  }

  private async reconcileUncertainConversation(
    request: CodexSubscriptionRequestBinding,
    conversation: CodexSubscriptionConversationSnapshot,
  ): Promise<CodexSubscriptionConversationSnapshot> {
    if (conversation.state !== "uncertain" || !conversation.threadId || !conversation.latestTurn) {
      return conversation;
    }
    const operationId = conversation.latestTurn.operationId;
    const operation = await this.store.getOperation(operationId);
    if (
      operation?.kind !== "turn_start" || !operation.clientUserMessageId ||
      operation.codexThreadId !== conversation.threadId || operation.promptDispatchStarted !== true
    ) protocolViolation();
    const client = await this.ensureClient();
    const cwd = await this.options.authorityStore.resolveWorkspaceDirectory(
      request.threadId,
      request.expectedExecutionGenerationId,
    );
    const observation = authoritativeProofFromThreadRead(
      await this.withSecureHome(() => client.readThread(conversation.threadId!)),
      conversation.threadId,
      operation.clientUserMessageId,
      operation.codexTurnId,
    );
    if (observation.kind === "absent") {
      // Absence from one read does not prove the provider never received the
      // prompt. Preserve the durable no-replay barrier and allow bounded later
      // reads to reconcile it.
      return conversation;
    }
    if (observation.proof.state !== "inProgress") {
      return this.store.adoptAuthoritativeTurn(
        operationId,
        observation.proof,
        this.backendIncarnationId,
      );
    }
    if (this.activeTurn && (
      this.activeTurn.operationId !== operationId ||
      this.activeTurn.threadId !== observation.proof.threadId ||
      this.activeTurn.turnId !== observation.proof.turnId
    )) protocolViolation();
    await this.runWorkspacePreflight(client, cwd);
    const instructionSources = await expectedWorkspaceInstructionSources(cwd);
    this.turnStartInProgress = true;
    try {
      validateThreadSecurityResponse(
        await client.resumeThread(conversation.threadId, { cwd }),
        cwd,
        this.descriptorRequired(),
        conversation.threadId,
        instructionSources,
      );
      await this.runWorkspacePreflight(client, cwd, conversation.threadId);
      if (!sameJson(instructionSources, await expectedWorkspaceInstructionSources(cwd))) protocolViolation();
      const adopted = await this.store.adoptAuthoritativeTurn(
        operationId,
        observation.proof,
        this.backendIncarnationId,
      );
      this.activeCommands.clear();
      for (const command of observation.activeCommands) {
        if (this.activeCommands.size >= MAX_COMMAND_ITEMS || this.activeCommands.has(command.itemId)) {
          protocolViolation();
        }
        this.activeCommands.set(command.itemId, { fingerprint: command.fingerprint, outputBytes: 0 });
      }
      this.activeTurn = {
        operationId,
        threadId: observation.proof.threadId,
        turnId: observation.proof.turnId,
      };
      return adopted;
    } finally {
      this.turnStartInProgress = false;
    }
  }

  assertQuiescent(): Promise<void> {
    return this.store.assertQuiescent();
  }

  async drainForRuntimeMutation(): Promise<void> {
    return this.serialized(async () => {
      await this.store.assertQuiescent();
      await this.retireClient(true);
    });
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      // Latch synchronously so a concurrent health observation cannot enqueue a
      // fresh app-server composition behind the close/drain authority barrier.
      this.closed = true;
      this.clearCapabilityRetry();
      this.closePromise = this.serialized(async () => {
        if (this.notificationTimer) clearTimeout(this.notificationTimer);
        this.clearLoginExpiry();
        await this.drainNotifications();
        for (const [operationId, waiter] of this.interruptWaiters) {
          clearTimeout(waiter.timer);
          waiter.reject(unavailable("Codex backend closed before Stop was confirmed", true));
          this.interruptWaiters.delete(operationId);
        }
        await this.retireClient(true);
      });
    }
    return this.closePromise;
  }

  private async ensureClient(): Promise<CodexSubscriptionAppServerClient> {
    this.requireInitialized();
    if (this.fatalError) throw this.fatalError;
    if (this.platform !== "win32" || this.options.runtimeHandles.snapshot().status !== "ready") {
      throw unavailable("The verified Codex app-server runtime is not ready", true);
    }
    if (this.client) {
      this.client.assertHealthy();
      return this.client;
    }
    this.compositionPromise ??= this.composeClient();
    try {
      return await this.compositionPromise;
    } catch (error) {
      this.compositionPromise = undefined;
      this.reportCapabilityPreparationFailure(error);
      const failure = sanitizeBackendFailure(error, "Codex via ChatGPT subscription is unavailable");
      this.account = accountError(failure);
      throw failure;
    }
  }

  /**
   * Health only observes readiness. It may start one background preparation,
   * but it never waits for runtime hashing, process launch, or app-server RPC.
   * A failed optional preparation is coalesced behind a bounded retry window so
   * disconnected health polls cannot accumulate launch attempts on the FIFO.
   */
  private scheduleCapabilityPreparation(): void {
    if (
      this.capabilityPreparationPromise || this.capabilityRetryBlocked || this.closed ||
      !this.initialized || this.platform !== "win32" || this.fatalError ||
      this.options.runtimeHandles.snapshot().status !== "ready"
    ) return;

    const preparation = this.serialized(async () => {
      if (
        this.closed || this.fatalError ||
        this.options.runtimeHandles.snapshot().status !== "ready"
      ) return;
      await this.ensureClient();
    }).then(
      () => {
        if (this.client && this.preflightVerifiedAt) this.clearCapabilityRetry();
      },
      () => {
        if (!this.closed && !this.fatalError) this.armCapabilityRetry();
      },
    );
    let tracked!: Promise<void>;
    tracked = preparation.finally(() => {
      if (this.capabilityPreparationPromise === tracked) {
        this.capabilityPreparationPromise = undefined;
        this.capabilityPreparationStage = undefined;
      }
    });
    this.capabilityPreparationPromise = tracked;
    // Both branches above settle successfully. Keep an explicit terminal catch
    // so a future cleanup change cannot turn optional readiness into an
    // unhandled process rejection.
    void tracked.catch(() => undefined);
  }

  private armCapabilityRetry(): void {
    this.clearCapabilityRetry();
    this.capabilityRetryBlocked = true;
    const timer = setTimeout(() => {
      if (this.capabilityRetryTimer !== timer) return;
      this.capabilityRetryTimer = undefined;
      this.capabilityRetryBlocked = false;
    }, CAPABILITY_PREPARATION_RETRY_MS);
    timer.unref?.();
    this.capabilityRetryTimer = timer;
  }

  private clearCapabilityRetry(): void {
    if (this.capabilityRetryTimer) clearTimeout(this.capabilityRetryTimer);
    this.capabilityRetryTimer = undefined;
    this.capabilityRetryBlocked = false;
  }

  private noteCapabilityPreparationStage(stage: CapabilityPreparationStage): void {
    if (this.capabilityPreparationPromise) this.capabilityPreparationStage = stage;
  }

  private reportCapabilityPreparationFailure(error: unknown): void {
    if (process.env.PRIME_CONTINUIM_PACKAGE_SMOKE !== "1") return;
    const stage = this.capabilityPreparationStage ?? "unknown";
    const code = error instanceof CodexAppServerClientError ||
      error instanceof CodexSubscriptionBackendError ||
      error instanceof CodexSubscriptionStoreError ||
      error instanceof CodexHomeSecurityError
      ? error.code
      : "UNCLASSIFIED";
    const reason = error instanceof CodexHomeSecurityError && error.diagnosticReason
      ? `:${error.diagnosticReason}`
      : "";
    // Package smoke receives only one bounded stage/code diagnostic. Never
    // serialize the raw error, provider frame, path, account, or stderr here.
    try {
      process.stderr.write(`[codex-subscription] readiness preparation failed at ${stage} (${code}${reason})\n`);
    } catch {
      // Private diagnostics must never alter optional capability readiness.
    }
  }

  private async composeClient(): Promise<CodexSubscriptionAppServerClient> {
    this.noteCapabilityPreparationStage("runtime_handle");
    const handle = await this.options.runtimeHandles.acquireVerifiedRuntimeHandle();
    const descriptor = handle.codexAppServer;
    if (!descriptor || !sameJson(descriptor.codexHomePolicy, CODEX_HOME_CONTENT_POLICY)) {
      throw unavailable("The verified runtime does not carry the required Codex companion policy", false);
    }
    const home = this.homeRequired();
    this.noteCapabilityPreparationStage("home_prelaunch");
    await this.homeSecurity.assertStillSecure(home);
    this.noteCapabilityPreparationStage("transport_launch");
    const client = this.options.clientFactory
      ? this.options.clientFactory(descriptor, home)
      : new CodexAppServerClient({
          transport: await this.launcher.launch(descriptor, home),
          expectedCodexHome: home.canonicalHome,
          expectedReleaseVersion: descriptor.releaseVersion,
          clientVersion: this.options.clientVersion,
          initializeIdentity: descriptor.initializeIdentity,
          initializeCapabilities: descriptor.initializeCapabilities,
          threadConfig: descriptor.threadConfig,
        });
    this.descriptor = descriptor;
    this.homeProof = home;
    this.client = client;
    client.subscribe((notification) => this.bufferNotification(notification));
    client.subscribeDeniedServerRequests(() => this.scheduleFatal("Codex requested forbidden host authority"));
    client.subscribeFailures(() => this.scheduleFatal("Codex app-server transport failed"));
    try {
      this.noteCapabilityPreparationStage("initialize");
      await client.initialize();
      await this.runPreflight(client, descriptor, home);
      this.noteCapabilityPreparationStage("account_read");
      await this.refreshAccount(client, false);
      this.noteCapabilityPreparationStage("account_recovery");
      await this.reconcileRecoveredAccountOperations();
      this.throwIfFatal();
      return client;
    } catch (error) {
      await this.retireClientOrFence(
        "Codex app-server retirement could not be confirmed after composition failed",
      );
      throw error;
    }
  }

  private async runPreflight(
    client: CodexSubscriptionAppServerClient,
    descriptor: VerifiedCodexAppServerLaunchDescriptor,
    home: CodexHomeSecurityProof,
  ): Promise<void> {
    this.preflightInProgress = true;
    this.resetCanaryObservation();
    try {
      this.noteCapabilityPreparationStage("home_postlaunch");
      await this.homeSecurity.assertStillSecure(home, descriptor);
      this.noteCapabilityPreparationStage("config_read");
      validateEffectiveConfig(await client.readEffectiveConfig(home.canonicalHome), descriptor, home.canonicalHome);
      this.noteCapabilityPreparationStage("mcp_list");
      requireExactValue(await client.listMcpServers(), { data: [], nextCursor: null });
      this.noteCapabilityPreparationStage("hooks_list");
      requireExactValue(await client.listHooks(home.canonicalHome), {
        data: [{ cwd: home.canonicalHome, hooks: [], warnings: [], errors: [] }],
      });
      this.noteCapabilityPreparationStage("plugins_list");
      requireExactValue(await client.listPlugins(home.canonicalHome), {
        marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [],
      });
      this.noteCapabilityPreparationStage("apps_list");
      requireExactValue(await client.listApps(), { data: [], nextCursor: null });
      this.noteCapabilityPreparationStage("sandbox_readiness");
      requireExactValue(await client.readWindowsSandboxReadiness(), { status: "ready" });
      this.noteCapabilityPreparationStage("canary_start");
      const canary = validateThreadSecurityResponse(
        await client.startThread({ cwd: home.canonicalHome }),
        home.canonicalHome,
        descriptor,
        undefined,
        [],
      );
      this.canaryThreadId = canary;
      this.canaryThreadIds.add(canary);
      this.consumePendingCanaryNotifications();
      this.noteCapabilityPreparationStage("canary_delete");
      requireExactRecord(await client.deleteThread(canary), []);
      this.noteCapabilityPreparationStage("canary_notifications");
      await this.waitForCanaryNotifications();
      this.noteCapabilityPreparationStage("home_postflight");
      await this.homeSecurity.assertStillSecure(home, descriptor);
      this.preflightVerifiedAt = this.timestamp();
    } finally {
      this.preflightInProgress = false;
      this.clearCanaryObservation();
    }
  }

  private async runWorkspacePreflight(
    client: CodexSubscriptionAppServerClient,
    cwd: string,
    threadId?: string,
  ): Promise<void> {
    const home = this.homeRequired();
    const descriptor = this.descriptorRequired();
    await this.homeSecurity.assertStillSecure(home, descriptor);
    validateEffectiveConfig(await client.readEffectiveConfig(cwd), descriptor, home.canonicalHome);
    requireExactValue(await client.listMcpServers(threadId), { data: [], nextCursor: null });
    requireExactValue(await client.listHooks(cwd), {
      data: [{ cwd, hooks: [], warnings: [], errors: [] }],
    });
    requireExactValue(await client.listPlugins(cwd), {
      marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [],
    });
    requireExactValue(await client.listApps(threadId), { data: [], nextCursor: null });
    requireExactValue(await client.readWindowsSandboxReadiness(), { status: "ready" });
    await this.homeSecurity.assertStillSecure(home, descriptor);
    this.throwIfFatal();
  }

  private async refreshAccount(client: CodexSubscriptionAppServerClient, preservePending: boolean): Promise<ParsedAccount> {
    const parsed = parseAccount(await this.withSecureHome(() => client.readAccount()));
    if (parsed.signedIn) {
      this.account = { phase: "signed_in", planType: parsed.planType };
    } else if (!(preservePending && (this.account.phase === "opening_browser" || this.account.phase === "waiting_for_login"))) {
      this.account = { phase: "signed_out" };
    }
    return parsed;
  }

  private async reconcileRecoveredAccountOperations(): Promise<void> {
    if (this.accountRecoveries.length === 0) return;
    const signedIn = this.account.phase === "signed_in";
    for (const recovery of this.accountRecoveries.splice(0)) {
      if ((recovery.kind === "login" || recovery.kind === "logout") && recovery.recoveredPhase === "uncertain") {
        await this.store.adoptAccountReconciliation(recovery.operationId, signedIn);
      }
    }
  }

  private accountSnapshot(phaseOverride?: CodexSubscriptionAccountSnapshot["phase"]): CodexSubscriptionAccountSnapshot {
    const phase = phaseOverride ?? this.account.phase;
    const pending = phase === "opening_browser" || phase === "waiting_for_login";
    const signedIn = phase === "signed_in";
    const error = phase === "unavailable" || phase === "error"
      ? this.account.error ?? unavailable("Codex subscription backend is unavailable", true)
      : undefined;
    const updatedAt = this.timestamp();
    return CodexSubscriptionAccountSnapshotSchema.parse({
      backend: { id: CODEX_SUBSCRIPTION_BACKEND_ID, label: CODEX_SUBSCRIPTION_BACKEND_LABEL, kind: "codex_subscription" },
      backendIncarnationId: this.backendIncarnationId,
      phase,
      ...(pending
        ? {
            pendingLoginId: this.account.pendingLoginId,
            pendingLoginOperationId: this.account.pendingLoginOperationId,
          }
        : {}),
      ...(signedIn
        ? { accountType: "chatgpt", requiresOpenaiAuth: true, planType: this.account.planType ?? "unknown" }
        : {}),
      executionPolicy: EXECUTION_POLICY,
      turnReadiness: signedIn && this.preflightVerifiedAt
        ? { state: "ready", verifiedAt: this.preflightVerifiedAt }
        : phase === "error"
          ? { state: "error", checkedAt: updatedAt, error }
          : {
              state: "unavailable",
              reason: phase === "signed_out"
                ? "account_required"
                : pending
                  ? "login_in_progress"
                  : "backend_unavailable",
            },
      updatedAt,
      ...(error ? { error: { code: error.code, message: error.message, retryable: error.retryable } } : {}),
    });
  }

  private async withSecureHome<T>(operation: () => Promise<T>): Promise<T> {
    const proof = this.homeRequired();
    const descriptor = this.descriptorRequired();
    await this.homeSecurity.assertStillSecure(proof, descriptor);
    const result = await operation();
    await this.homeSecurity.assertStillSecure(proof, descriptor);
    return result;
  }

  private bufferNotification(notification: CodexAppServerNotification): void {
    if (this.fatalError) return;
    if (SYNCHRONOUS_FORBIDDEN_NOTIFICATIONS.has(notification.method)) {
      this.scheduleFatal("Codex app-server emitted a forbidden tool or extension notification");
      return;
    }
    if (
      this.preflightInProgress &&
      (notification.method === "thread/started" ||
        notification.method === "thread/status/changed" ||
        notification.method === "thread/deleted")
    ) {
      if (this.pendingCanaryNotifications.length >= 8) {
        this.failCanaryObservation(protocolViolationError());
        return;
      }
      this.pendingCanaryNotifications.push(notification);
      this.consumePendingCanaryNotifications();
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(notification), "utf8");
    if (
      this.notificationBuffer.length >= NOTIFICATION_QUEUE_LIMIT ||
      bytes > NOTIFICATION_BYTES_LIMIT - this.notificationBytes
    ) {
      // Latch synchronously and drop the overflowing frame. Fatal settlement
      // stays on the mutation FIFO, but no synchronous provider flood can grow
      // the queue while an earlier request is blocked.
      this.scheduleFatal("Codex app-server exceeded its bounded notification queue");
      return;
    }
    this.notificationBytes += bytes;
    this.notificationBuffer.push(notification);
    if (notification.method === "turn/completed" || notification.method === "account/login/completed") {
      this.scheduleNotificationDrain(0);
    } else {
      this.scheduleNotificationDrain(20);
    }
  }

  private scheduleNotificationDrain(delayMs: number): void {
    if (this.notificationTimer && delayMs !== 0) return;
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = undefined;
      void this.enqueue(() => this.drainNotifications()).catch(() => {
        this.scheduleFatal("Codex app-server emitted an invalid or unauthorized notification");
      });
    }, delayMs);
    this.notificationTimer.unref?.();
  }

  private async drainNotifications(): Promise<void> {
    while (this.notificationBuffer.length > 0) {
      const notification = this.notificationBuffer.shift()!;
      this.notificationBytes -= Buffer.byteLength(JSON.stringify(notification), "utf8");
      await this.handleNotification(notification);
    }
  }

  private async handleNotification(notification: CodexAppServerNotification): Promise<void> {
    switch (notification.method) {
      case "remoteControl/status/changed":
        validateRemoteControlDisabled(notification.params);
        return;
      case "account/login/completed":
        await this.handleLoginCompleted(notification.params);
        return;
      case "account/updated":
      case "account/rateLimits/updated":
      case "thread/tokenUsage/updated":
      case "thread/status/changed":
      case "model/safetyBuffering/updated":
      case "turn/moderationMetadata":
        return;
      case "thread/started":
      case "thread/closed":
      case "thread/deleted":
        if (this.preflightInProgress || this.turnStartInProgress || this.activeTurn) return;
        protocolViolation();
      case "turn/started":
        this.validateTurnStarted(notification.params);
        return;
      case "item/agentMessage/delta":
        await this.handleAgentDelta(notification.params);
        return;
      case "item/commandExecution/outputDelta":
        this.handleCommandOutputDelta(notification.params);
        return;
      case "item/started":
      case "item/completed":
        await this.handleItemLifecycle(notification.method, notification.params);
        return;
      case "item/reasoning/summaryPartAdded":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
      case "item/plan/delta":
      case "turn/plan/updated":
        validateTurnScoped(notification.params, this.activeTurnRequired());
        return;
      case "turn/completed":
        await this.handleTurnCompleted(notification.params);
        return;
      case "error":
        validateTurnErrorNotification(notification.params, this.activeTurnRequired());
        return;
      default:
        // Tool, hook, MCP, file-change, raw, warning, reroute, and request
        // lifecycle notifications are not part of the frozen preview surface.
        protocolViolation();
    }
  }

  private async handleLoginCompleted(params: unknown): Promise<void> {
    const value = requireExactRecord(params, ["loginId", "success", "error", "onboardingEntrypoint"]);
    if (typeof value.loginId !== "string" || typeof value.success !== "boolean" ||
      (value.error !== null && typeof value.error !== "string")) protocolViolation();
    const pending = this.pendingLoginAuthority();
    const authority = pending?.loginId === value.loginId
      ? pending
      : this.lastSettledLogin?.loginId === value.loginId
        ? this.lastSettledLogin
        : undefined;
    if (!authority) protocolViolation();
    this.clearLoginExpiry();
    const client = this.clientRequired();
    const parsed = parseAccount(await this.withSecureHome(() => client.readAccount()));
    if (value.success === true && !parsed.signedIn) protocolViolation();
    await this.settleLoginFromAccountRead(authority.operationId, authority.loginId, parsed);
  }

  private scheduleLoginExpiry(operationId: string, loginId: string): void {
    this.clearLoginExpiry();
    this.loginExpiryTimer = setTimeout(() => {
      this.loginExpiryTimer = undefined;
      void this.enqueue(async () => {
        if (
          this.account.pendingLoginOperationId !== operationId ||
          this.account.pendingLoginId !== loginId
        ) return;
        try {
          const client = this.clientRequired();
          await this.store.beginLoginCancel(operationId, loginId);
          const result = requireExactRecord(
            await this.withSecureHome(() => client.cancelLogin(loginId)),
            ["status"],
          );
          if (result.status !== "canceled" && result.status !== "notFound") protocolViolation();
          const parsed = parseAccount(await this.withSecureHome(() => client.readAccount()));
          await this.settleLoginFromAccountRead(operationId, loginId, parsed);
        } catch (error) {
          await this.store.completeAccountMutation(operationId, "uncertain").catch(() => undefined);
          this.account = accountError(new CodexSubscriptionBackendError(
            "CODEX_LOGIN_OUTCOME_UNKNOWN",
            "The bounded Codex login attempt expired, but cancellation could not be confirmed",
            false,
          ));
          await this.retireClient(false).catch(() => undefined);
        }
      }).catch(() => undefined);
    }, LOGIN_ATTEMPT_TTL_MS);
    this.loginExpiryTimer.unref?.();
  }

  private clearLoginExpiry(): void {
    if (this.loginExpiryTimer) clearTimeout(this.loginExpiryTimer);
    this.loginExpiryTimer = undefined;
  }

  private resetCanaryObservation(): void {
    this.clearCanaryObservation();
    this.canaryStarted = false;
    this.canaryNotLoaded = false;
    this.canaryDeleted = false;
    this.canaryNotificationError = undefined;
    this.pendingCanaryNotifications.length = 0;
  }

  private clearCanaryObservation(): void {
    if (this.canaryNotificationWaiter) clearTimeout(this.canaryNotificationWaiter.timer);
    this.canaryNotificationWaiter = undefined;
    if (this.canaryThreadId) this.canaryThreadIds.delete(this.canaryThreadId);
    this.canaryThreadId = undefined;
    this.pendingCanaryNotifications.length = 0;
  }

  private consumePendingCanaryNotifications(): void {
    const expectedThreadId = this.canaryThreadId;
    if (!expectedThreadId || this.canaryNotificationError) return;
    try {
      while (this.pendingCanaryNotifications.length > 0) {
        const notification = this.pendingCanaryNotifications.shift()!;
        if (notification.method === "thread/started") {
          const value = requireExactRecord(notification.params, ["thread"]);
          const thread = requireRecord(value.thread);
          if (this.canaryStarted || thread.id !== expectedThreadId) protocolViolation();
          this.canaryStarted = true;
        } else if (notification.method === "thread/status/changed") {
          const value = requireExactRecord(notification.params, ["threadId", "status"]);
          if (
            !this.canaryStarted || this.canaryNotLoaded ||
            value.threadId !== expectedThreadId ||
            !sameJson(value.status, { type: "notLoaded" })
          ) protocolViolation();
          this.canaryNotLoaded = true;
        } else {
          const value = requireExactRecord(notification.params, ["threadId"]);
          if (!this.canaryNotLoaded || this.canaryDeleted || value.threadId !== expectedThreadId) {
            protocolViolation();
          }
          this.canaryDeleted = true;
        }
      }
      if (this.canaryStarted && this.canaryNotLoaded && this.canaryDeleted) {
        const waiter = this.canaryNotificationWaiter;
        if (waiter) {
          clearTimeout(waiter.timer);
          this.canaryNotificationWaiter = undefined;
          waiter.resolve();
        }
      }
    } catch (error) {
      this.failCanaryObservation(error instanceof Error ? error : protocolViolationError());
    }
  }

  private waitForCanaryNotifications(): Promise<void> {
    if (this.canaryNotificationError) return Promise.reject(this.canaryNotificationError);
    if (this.canaryStarted && this.canaryNotLoaded && this.canaryDeleted) return Promise.resolve();
    if (this.canaryNotificationWaiter) {
      return Promise.reject(protocolViolationError());
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.canaryNotificationWaiter = undefined;
        reject(protocolViolationError());
      }, CANARY_NOTIFICATION_TIMEOUT_MS);
      timer.unref?.();
      this.canaryNotificationWaiter = { resolve, reject, timer };
    });
  }

  private failCanaryObservation(error: Error): void {
    this.canaryNotificationError = error;
    const waiter = this.canaryNotificationWaiter;
    if (waiter) {
      clearTimeout(waiter.timer);
      this.canaryNotificationWaiter = undefined;
      waiter.reject(error);
    }
  }

  private pendingLoginAuthority(): SettledLoginAuthority | undefined {
    return this.account.pendingLoginOperationId && this.account.pendingLoginId
      ? {
          operationId: this.account.pendingLoginOperationId,
          loginId: this.account.pendingLoginId,
        }
      : undefined;
  }

  private async settleLoginFromAccountRead(
    operationId: string,
    loginId: string,
    parsed: ParsedAccount,
  ): Promise<void> {
    await this.store.settleLoginFromAccountRead(operationId, parsed.signedIn);
    this.clearLoginExpiry();
    this.transientAuthorization = undefined;
    this.lastSettledLogin = { operationId, loginId };
    this.account = parsed.signedIn
      ? { phase: "signed_in", planType: parsed.planType }
      : { phase: "signed_out" };
  }

  private validateTurnStarted(params: unknown): void {
    const value = requireExactRecord(params, ["threadId", "turn"]);
    const authority = this.activeTurnRequired();
    const turn = parseTurn(value.turn);
    if (
      value.threadId !== authority.threadId ||
      turn.id !== authority.turnId ||
      turn.status !== "inProgress"
    ) protocolViolation();
  }

  private async handleAgentDelta(params: unknown): Promise<void> {
    const value = requireExactRecord(params, ["threadId", "turnId", "itemId", "delta"]);
    const authority = this.activeTurnRequired();
    if (
      value.threadId !== authority.threadId ||
      value.turnId !== authority.turnId ||
      typeof value.itemId !== "string" ||
      typeof value.delta !== "string" ||
      value.delta.length === 0
    ) protocolViolation();
    await this.store.appendAssistantDelta(
      authority.operationId,
      value.itemId,
      value.delta,
      this.backendIncarnationId,
    );
  }

  private async handleItemLifecycle(method: string, params: unknown): Promise<void> {
    const timeKey = method === "item/started" ? "startedAtMs" : "completedAtMs";
    const value = requireExactRecord(params, ["item", "threadId", "turnId", timeKey]);
    const authority = this.activeTurnRequired();
    if (
      value.threadId !== authority.threadId ||
      value.turnId !== authority.turnId ||
      !Number.isSafeInteger(value[timeKey]) ||
      (value[timeKey] as number) <= 0
    ) protocolViolation();
    const item = requireRecord(value.item);
    if (item.type === "commandExecution") {
      this.handleCommandLifecycle(method, item);
      return;
    }
    if (item.type === "agentMessage") {
      if (typeof item.id !== "string" || typeof item.text !== "string") protocolViolation();
      if (method === "item/completed") {
        await this.store.completeAssistantItem(
          authority.operationId,
          item.id,
          item.text,
          this.backendIncarnationId,
        );
      }
      return;
    }
    if (item.type === "userMessage") {
      const operation = await this.store.getOperation(authority.operationId);
      if (item.clientId !== operation?.clientUserMessageId) protocolViolation();
      return;
    }
    if (item.type === "reasoning" || item.type === "plan" || item.type === "contextCompaction") return;
    protocolViolation();
  }

  private handleCommandLifecycle(method: string, item: JsonRecord): void {
    const parsed = validateReadOnlyCommandExecution(item, method === "item/started");
    const existing = this.activeCommands.get(parsed.itemId);
    if (method === "item/started") {
      if (existing || this.activeCommands.size >= MAX_COMMAND_ITEMS) protocolViolation();
      this.activeCommands.set(parsed.itemId, { fingerprint: parsed.fingerprint, outputBytes: 0 });
      return;
    }
    if (!existing || existing.fingerprint !== parsed.fingerprint) protocolViolation();
    this.activeCommands.delete(parsed.itemId);
  }

  private handleCommandOutputDelta(params: unknown): void {
    const value = requireExactRecord(params, ["threadId", "turnId", "itemId", "delta"]);
    const authority = this.activeTurnRequired();
    if (
      value.threadId !== authority.threadId || value.turnId !== authority.turnId ||
      typeof value.itemId !== "string" || typeof value.delta !== "string" ||
      value.delta.length === 0
    ) protocolViolation();
    const itemId = boundedId(value.itemId, "Codex command item identifier");
    const command = this.activeCommands.get(itemId);
    if (!command) protocolViolation();
    const bytes = Buffer.byteLength(value.delta, "utf8");
    if (bytes > MAX_COMMAND_OUTPUT_BYTES || command.outputBytes + bytes > MAX_COMMAND_OUTPUT_BYTES) {
      protocolViolation();
    }
    command.outputBytes += bytes;
  }

  private async handleTurnCompleted(params: unknown): Promise<void> {
    const value = requireExactRecord(params, ["threadId", "turn"]);
    const authority = this.activeTurnRequired();
    const turn = parseTurn(value.turn);
    if (value.threadId !== authority.threadId || turn.id !== authority.turnId) protocolViolation();
    if (turn.status === "inProgress") protocolViolation();
    if (this.activeCommands.size !== 0) protocolViolation();
    const state = turn.status;
    const snapshot = await this.store.settleProviderTurn(authority.operationId, {
      threadId: authority.threadId,
      turnId: authority.turnId,
      state,
      ...(state === "failed"
        ? {
            error: {
              code: "CODEX_TURN_FAILED",
              message: "Codex reported that the turn failed",
              retryable: true,
            },
          }
        : {}),
    }, this.backendIncarnationId);
    this.activeTurn = undefined;
    this.activeCommands.clear();
    this.resolveInterruptsForTurn(authority.operationId, snapshot);
  }

  private async handleInterruptRequestFailure(operationId: string, error: unknown): Promise<void> {
    const uncertain = ambiguousClientFailure(error);
    const snapshot = await this.store.completeInterrupt(
      operationId,
      uncertain ? "uncertain" : "failed",
      this.backendIncarnationId,
    );
    if (uncertain) {
      this.activeTurn = undefined;
      this.activeCommands.clear();
      try {
        await this.retireClientOrFence(
          "Codex app-server retirement could not be confirmed after an uncertain Stop",
        );
      } catch (retirementError) {
        this.rejectInterrupt(operationId, sanitizeBackendFailure(
          retirementError,
          "Codex Stop outcome is unknown",
        ));
        return;
      }
    }
    this.resolveInterrupt(operationId, snapshot);
  }

  private createInterruptWaiter(
    operationId: string,
    targetTurnOperationId: string,
  ): Promise<CodexSubscriptionConversationSnapshot> {
    let resolvePromise!: (snapshot: CodexSubscriptionConversationSnapshot) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<CodexSubscriptionConversationSnapshot>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      void this.enqueue(async () => {
        const waiter = this.interruptWaiters.get(operationId);
        if (!waiter) return;
        const snapshot = await this.store.completeInterrupt(
          operationId,
          "uncertain",
          this.backendIncarnationId,
        );
        this.activeTurn = undefined;
        this.activeCommands.clear();
        await this.retireClientOrFence(
          "Codex app-server retirement could not be confirmed after Stop proof timed out",
        );
        this.resolveInterrupt(operationId, snapshot);
      }).catch((error) => this.rejectInterrupt(
        operationId,
        sanitizeBackendFailure(error, "Codex Stop outcome is unknown"),
      ));
    }, INTERRUPT_PROOF_TIMEOUT_MS);
    timer.unref?.();
    this.interruptWaiters.set(operationId, {
      targetTurnOperationId,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
    });
    return promise;
  }

  private resolveInterrupt(operationId: string, snapshot: CodexSubscriptionConversationSnapshot): void {
    const waiter = this.interruptWaiters.get(operationId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.interruptWaiters.delete(operationId);
    waiter.resolve(snapshot);
  }

  private rejectInterrupt(operationId: string, error: Error): void {
    const waiter = this.interruptWaiters.get(operationId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.interruptWaiters.delete(operationId);
    waiter.reject(error);
  }

  private resolveInterruptsForTurn(
    turnOperationId: string,
    snapshot: CodexSubscriptionConversationSnapshot,
  ): void {
    for (const [operationId, waiter] of this.interruptWaiters) {
      if (waiter.targetTurnOperationId === turnOperationId) this.resolveInterrupt(operationId, snapshot);
    }
  }

  private scheduleFatal(message: string): void {
    if (this.fatalError) return;
    this.fatalError = new CodexSubscriptionBackendError("CODEX_PROTOCOL_VIOLATION", message, false);
    this.account = accountError(this.fatalError);
    void this.enqueue(() => this.failBackend(message)).catch(() => undefined);
  }

  private async failBackend(message: string): Promise<void> {
    if (this.fatalSettlementStarted) return;
    this.fatalSettlementStarted = true;
    this.fatalError ??= new CodexSubscriptionBackendError("CODEX_PROTOCOL_VIOLATION", message, false);
    this.account = accountError(this.fatalError);
    if (this.activeTurn) {
      await this.store.completeTurn(this.activeTurn.operationId, {
        state: "uncertain",
        error: {
          code: "CODEX_TURN_OUTCOME_UNKNOWN",
          message: "Codex violated the frozen host protocol while a turn was active",
          retryable: true,
        },
      }, this.backendIncarnationId).catch(() => undefined);
      this.activeTurn = undefined;
      this.activeCommands.clear();
    }
    await this.retireClient(false);
  }

  private async retireClient(clearFatal: boolean): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.compositionPromise = undefined;
    this.descriptor = undefined;
    this.preflightVerifiedAt = undefined;
    this.activeCommands.clear();
    if (client) await client.close();
    if (clearFatal) {
      this.clearCapabilityRetry();
      this.fatalError = undefined;
      this.fatalSettlementStarted = false;
      this.account = accountError(unavailable("Codex runtime is restarting", true));
    }
  }

  private async retireClientOrFence(message: string): Promise<void> {
    try {
      await this.retireClient(false);
    } catch {
      this.fatalError = unavailable(message, false);
      this.account = accountError(this.fatalError);
      throw this.fatalError;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(operation);
  }

  private requireTurnReady(): void {
    if (this.account.phase !== "signed_in" || !this.preflightVerifiedAt) {
      throw new CodexSubscriptionBackendError(
        "CODEX_ACCOUNT_REQUIRED",
        "Sign in with ChatGPT and complete the read-only preview check before starting a turn",
        false,
      );
    }
  }

  private throwIfFatal(): void {
    if (this.fatalError) throw this.fatalError;
  }

  private assertHost(expectedHostId: string): void {
    if (boundedId(expectedHostId, "Host identifier") !== this.hostId) {
      throw new CodexSubscriptionBackendError(
        "CODEX_HOST_AUTHORITY_MISMATCH",
        "Codex subscription authority changed before the request",
        true,
      );
    }
  }

  private assertIncarnation(expected: string): void {
    if (boundedId(expected, "Backend incarnation") !== this.backendIncarnationId) {
      throw new CodexSubscriptionBackendError(
        "CODEX_HOST_AUTHORITY_MISMATCH",
        "Codex backend restarted before the request",
        true,
      );
    }
  }

  private requireInitialized(): void {
    if (!this.initialized || !this.hostId) throw unavailable("Codex backend is not initialized", true);
  }

  private descriptorRequired(): VerifiedCodexAppServerLaunchDescriptor {
    if (!this.descriptor) throw unavailable("Codex runtime descriptor is unavailable", true);
    return this.descriptor;
  }

  private homeRequired(): CodexHomeSecurityProof {
    if (!this.homeProof) throw unavailable("Codex private home proof is unavailable", true);
    return this.homeProof;
  }

  private clientRequired(): CodexSubscriptionAppServerClient {
    if (!this.client) throw unavailable("Codex app-server client is unavailable", true);
    return this.client;
  }

  private activeTurnRequired(): ActiveTurnAuthority {
    if (!this.activeTurn) protocolViolation();
    return this.activeTurn;
  }

  private timestamp(): string {
    const current = Math.max(this.lastTimestampMs + 1, Math.trunc(this.now()));
    this.lastTimestampMs = current;
    return new Date(current).toISOString();
  }
}

function bindingFromRequest(request: CodexSubscriptionRequestBinding): CodexSubscriptionWorkspaceBinding {
  return {
    hostId: request.expectedHostId,
    sourceThreadId: request.threadId,
    executionGenerationId: request.expectedExecutionGenerationId,
  };
}

function parseLoginStart(value: unknown, operationId: string): CodexSubscriptionLoginStartResult["authorization"] {
  const result = requireExactRecord(value, ["type", "loginId", "authUrl"]);
  if (
    result.type !== "chatgpt" ||
    typeof result.loginId !== "string" ||
    typeof result.authUrl !== "string" ||
    !isOfficialCodexAppServerLoginUrl(result.authUrl)
  ) protocolViolation();
  return { loginId: boundedId(result.loginId, "Login identifier"), operationId, authUrl: result.authUrl };
}

function parseAccount(value: unknown): ParsedAccount {
  const result = requireExactRecord(value, ["account", "requiresOpenaiAuth"]);
  if (result.requiresOpenaiAuth !== true) protocolViolation();
  if (result.account === null) return { signedIn: false };
  const account = requireExactRecord(result.account, ["type", "email", "planType"]);
  if (
    account.type !== "chatgpt" ||
    (account.email !== null && typeof account.email !== "string") ||
    typeof account.planType !== "string"
  ) protocolViolation();
  return {
    signedIn: true,
    planType: PLAN_TYPES.has(account.planType as CodexSubscriptionPlanType)
      ? account.planType as CodexSubscriptionPlanType
      : "unknown",
  };
}

async function expectedWorkspaceInstructionSources(cwd: string): Promise<readonly string[]> {
  const canonicalWorkspace = await realpath(cwd).catch(() => protocolViolation());
  if (!sameCanonicalWindowsPath(canonicalWorkspace, cwd)) protocolViolation();
  for (const filename of ["AGENTS.override.md", "AGENTS.md"] as const) {
    const candidate = join(cwd, filename);
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      protocolViolation();
    }
    if (
      metadata.isSymbolicLink() || !metadata.isFile() ||
      metadata.size < 0 || metadata.size > MAX_INSTRUCTION_SOURCE_BYTES
    ) protocolViolation();
    const canonicalCandidate = await realpath(candidate).catch(() => protocolViolation());
    if (
      !sameCanonicalWindowsPath(canonicalCandidate, candidate) ||
      !pathIsWithin(canonicalWorkspace, canonicalCandidate)
    ) protocolViolation();
    return Object.freeze([candidate]);
  }
  return Object.freeze([]);
}

function validateReadOnlyCommandExecution(
  value: unknown,
  started: boolean,
): Readonly<{ itemId: string; fingerprint: string }> {
  const item = requireExactRecord(value, [
    "type", "id", "pluginId", "scriptPath", "command", "cwd", "processId", "source",
    "status", "commandActions", "aggregatedOutput", "exitCode", "durationMs",
  ]);
  if (
    item.type !== "commandExecution" || item.pluginId !== null || item.scriptPath !== null ||
    typeof item.id !== "string" || typeof item.command !== "string" ||
    typeof item.cwd !== "string" || !isAbsolute(item.cwd) || /[\0\r\n]/.test(item.cwd) ||
    item.cwd.length > 2_048 || item.source !== "agent" ||
    (item.processId !== null && typeof item.processId !== "string") ||
    !Array.isArray(item.commandActions) || item.commandActions.length === 0 ||
    item.commandActions.length > MAX_COMMAND_ACTIONS ||
    !boundedUtf8String(item.command, MAX_COMMAND_TEXT_BYTES)
  ) protocolViolation();
  const itemId = boundedId(item.id, "Codex command item identifier");
  const processId = item.processId === null
    ? null
    : boundedId(item.processId as string, "Codex command process identifier");
  const actions = item.commandActions.map(validateReadOnlyCommandAction);
  if (started) {
    if (
      item.status !== "inProgress" || item.aggregatedOutput !== null ||
      item.exitCode !== null || item.durationMs !== null
    ) protocolViolation();
  } else {
    if (
      item.status !== "completed" && item.status !== "failed" && item.status !== "declined"
    ) protocolViolation();
    if (
      item.aggregatedOutput !== null &&
      (typeof item.aggregatedOutput !== "string" ||
        !boundedUtf8String(item.aggregatedOutput, MAX_COMMAND_OUTPUT_BYTES))
    ) protocolViolation();
    if (
      item.exitCode !== null &&
      (!Number.isInteger(item.exitCode) || (item.exitCode as number) < -2_147_483_648 ||
        (item.exitCode as number) > 2_147_483_647)
    ) protocolViolation();
    if (
      item.durationMs !== null &&
      (!Number.isSafeInteger(item.durationMs) || (item.durationMs as number) < 0 ||
        (item.durationMs as number) > 24 * 60 * 60_000)
    ) protocolViolation();
  }
  return Object.freeze({
    itemId,
    fingerprint: JSON.stringify({
      itemId,
      pluginId: null,
      scriptPath: null,
      command: item.command,
      cwd: item.cwd,
      processId,
      source: item.source,
      actions,
    }),
  });
}

function validateReadOnlyCommandAction(value: unknown): JsonRecord {
  const action = requireRecord(value);
  switch (action.type) {
    case "read": {
      const exact = requireExactRecord(action, ["type", "command", "name", "path"]);
      if (
        typeof exact.command !== "string" || typeof exact.name !== "string" ||
        typeof exact.path !== "string" || !isAbsolute(exact.path) ||
        !boundedUtf8String(exact.command, MAX_COMMAND_TEXT_BYTES) ||
        !boundedUtf8String(exact.name, 1_024) || !boundedPathText(exact.path)
      ) protocolViolation();
      return exact;
    }
    case "listFiles": {
      const exact = requireExactRecord(action, ["type", "command", "path"]);
      if (
        typeof exact.command !== "string" || !boundedUtf8String(exact.command, MAX_COMMAND_TEXT_BYTES) ||
        (exact.path !== null && (typeof exact.path !== "string" || !boundedPathText(exact.path)))
      ) protocolViolation();
      return exact;
    }
    case "search": {
      const exact = requireExactRecord(action, ["type", "command", "query", "path"]);
      if (
        typeof exact.command !== "string" || !boundedUtf8String(exact.command, MAX_COMMAND_TEXT_BYTES) ||
        (exact.query !== null &&
          (typeof exact.query !== "string" || !boundedUtf8String(exact.query, 8 * 1_024))) ||
        (exact.path !== null && (typeof exact.path !== "string" || !boundedPathText(exact.path)))
      ) protocolViolation();
      return exact;
    }
    case "unknown": {
      // Command parsing is explicitly best-effort in the pinned protocol. The
      // attested Windows read-only sandbox, not this presentation hint, is the
      // write/network authority.
      const exact = requireExactRecord(action, ["type", "command"]);
      if (typeof exact.command !== "string" || !boundedUtf8String(exact.command, MAX_COMMAND_TEXT_BYTES)) {
        protocolViolation();
      }
      return exact;
    }
    default:
      protocolViolation();
  }
}

function boundedUtf8String(value: string, maximumBytes: number): boolean {
  return !value.includes("\0") && !hasUnpairedSurrogate(value) &&
    Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function boundedPathText(value: string): boolean {
  return value.length > 0 && value.length <= 2_048 && !/[\0\r\n]/.test(value) && !hasUnpairedSurrogate(value);
}

function sameCanonicalWindowsPath(first: string, second: string): boolean {
  return resolve(first).toLocaleLowerCase("en-US") === resolve(second).toLocaleLowerCase("en-US");
}

function pathIsWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child.length > 0 && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

function validateEffectiveConfig(
  value: unknown,
  descriptor: VerifiedCodexAppServerLaunchDescriptor,
  codexHome: string,
): void {
  const result = requireExactRecord(value, ["config", "origins", "layers"]);
  const config = requireRecord(result.config);
  const origins = requireRecord(result.origins);
  if (!Array.isArray(result.layers) || result.layers.length !== 3) protocolViolation();
  const layers = result.layers.map(requireRecord);
  const session = layers[0]!;
  const user = layers[1]!;
  const system = layers[2]!;
  if (
    !sameJson(Object.keys(session).sort(), ["config", "name", "version"]) ||
    !sameJson(session.name, { type: "sessionFlags" }) ||
    typeof session.version !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(session.version) ||
    !sameJson(session.config, descriptor.sessionConfig) ||
    !sameJson(Object.keys(user).sort(), ["config", "name", "version"]) ||
    !sameJson(user.name, { type: "user", file: join(codexHome, "config.toml"), profile: null }) ||
    typeof user.version !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(user.version) ||
    !sameJson(user.config, {}) ||
    !sameJson(Object.keys(system).sort(), ["config", "name", "version"]) ||
    !isRecord(system.name) ||
    !sameJson(Object.keys(system.name).sort(), ["file", "type"]) ||
    system.name.type !== "system" ||
    typeof system.name.file !== "string" ||
    !win32.isAbsolute(system.name.file) ||
    /[\0\r\n]/.test(system.name.file) ||
    typeof system.version !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(system.version) ||
    !sameJson(system.config, {})
  ) protocolViolation();
  const expectedPaths = flattenLeafPaths(descriptor.sessionConfig)
    .map((path) => path === "features.multi_agent_v2" ? "features.multi_agent_v2.enabled" : path)
    .sort();
  if (!sameJson(Object.keys(origins).sort(), expectedPaths)) protocolViolation();
  for (const origin of Object.values(origins)) {
    const parsed = requireExactRecord(origin, ["name", "version"]);
    if (!sameJson(parsed.name, { type: "sessionFlags" }) || parsed.version !== session.version) {
      protocolViolation();
    }
  }
  for (const path of flattenLeafPaths(descriptor.sessionConfig)) {
    if (!sameJson(readPath(config, path), readPath(descriptor.sessionConfig, path))) protocolViolation();
  }
  for (const [path, expected] of [
    ["mcp_servers", {}], ["plugins", {}], ["marketplaces", {}], ["hooks", null],
    ["apps", null], ["tools", null], ["agents", null], ["features.network_proxy", null],
    ["features.remote_control", false],
  ] as const) if (!sameJson(readPath(config, path), expected)) protocolViolation();
}

function validateThreadSecurityResponse(
  value: unknown,
  cwd: string,
  descriptor: VerifiedCodexAppServerLaunchDescriptor,
  expectedThreadId?: string,
  expectedInstructionSources: readonly string[] = [],
): string {
  const result = requireExactRecord(value, [
    "thread", "model", "modelProvider", "serviceTier", "cwd", "runtimeWorkspaceRoots",
    "instructionSources", "approvalPolicy", "approvalsReviewer", "sandbox",
    "activePermissionProfile", "reasoningEffort", "multiAgentMode",
  ]);
  const expected = requireRecord(descriptor.threadStartPolicy.expectedSecurityResponse);
  if (
    result.model !== expected.model ||
    result.modelProvider !== "openai" ||
    result.serviceTier !== null ||
    result.cwd !== cwd ||
    !sameJson(result.runtimeWorkspaceRoots, expected.runtimeWorkspaceRoots) ||
    !sameJson(result.instructionSources, expectedInstructionSources) ||
    result.approvalPolicy !== "never" ||
    result.approvalsReviewer !== "user" ||
    !sameJson(result.sandbox, { type: "readOnly", networkAccess: false }) ||
    result.activePermissionProfile !== null ||
    result.reasoningEffort !== null ||
    result.multiAgentMode !== "explicitRequestOnly"
  ) protocolViolation();
  const thread = requireRecord(result.thread);
  if (
    typeof thread.id !== "string" ||
    (expectedThreadId !== undefined && thread.id !== expectedThreadId) ||
    thread.modelProvider !== "openai" ||
    thread.cwd !== cwd ||
    thread.ephemeral !== false ||
    thread.cliVersion !== "0.147.0" ||
    thread.canAcceptDirectInput !== true ||
    !Array.isArray(thread.turns)
  ) protocolViolation();
  return boundedId(thread.id, "Codex thread identifier");
}

function parseTurnStart(value: unknown): { turnId: string } {
  const result = requireExactRecord(value, ["turn"]);
  const turn = parseTurn(result.turn);
  if (turn.status !== "inProgress") protocolViolation();
  return { turnId: turn.id };
}

function parseTurn(value: unknown): {
  id: string;
  status: "inProgress" | "completed" | "interrupted" | "failed";
} {
  const turn = requireExactRecord(value, [
    "id", "items", "itemsView", "status", "error", "startedAt", "completedAt", "durationMs",
  ]);
  if (
    typeof turn.id !== "string" ||
    !Array.isArray(turn.items) ||
    (turn.status !== "inProgress" && turn.status !== "completed" &&
      turn.status !== "interrupted" && turn.status !== "failed")
  ) protocolViolation();
  if ((turn.status === "failed") !== (turn.error !== null)) protocolViolation();
  return { id: boundedId(turn.id, "Codex turn identifier"), status: turn.status };
}

function authoritativeProofFromThreadRead(
  value: unknown,
  expectedThreadId: string,
  clientUserMessageId: string,
  expectedTurnId?: string,
): Readonly<
  | {
      kind: "present";
      proof: CodexAuthoritativeTurnProof;
      activeCommands: ReadonlyArray<Readonly<{ itemId: string; fingerprint: string }>>;
    }
  | { kind: "absent" }
> {
  const result = requireExactRecord(value, ["thread"]);
  const thread = requireRecord(result.thread);
  if (thread.id !== expectedThreadId || !Array.isArray(thread.turns) || thread.turns.length > 128) protocolViolation();
  for (const rawTurn of thread.turns) {
    const parsedTurn = parseTurn(rawTurn);
    const turn = requireRecord(rawTurn);
    if (!Array.isArray(turn.items) || turn.items.length > 256) protocolViolation();
    const user = turn.items.find((item) => isRecord(item) && item.type === "userMessage" && item.clientId === clientUserMessageId);
    const items = turn.items.map((item) => validateThreadReadItem(item, parsedTurn.status));
    const assistantItems = items.flatMap((item) => item.assistantItems);
    const activeCommands = items.flatMap((item) => item.activeCommand ? [item.activeCommand] : []);
    if (!user) continue;
    if (expectedTurnId !== undefined && turn.id !== expectedTurnId) protocolViolation();
    return {
      kind: "present",
      proof: {
        clientUserMessageId,
        threadId: expectedThreadId,
        turnId: boundedId(turn.id as string, "Codex turn identifier"),
        state: parsedTurn.status,
        assistantItems,
      },
      activeCommands,
    };
  }
  return { kind: "absent" };
}

function validateThreadReadItem(
  value: unknown,
  turnStatus: "inProgress" | "completed" | "interrupted" | "failed",
): Readonly<{
  assistantItems: ReadonlyArray<{ itemId: string; text: string }>;
  activeCommand?: Readonly<{ itemId: string; fingerprint: string }>;
}> {
  const item = requireRecord(value);
  if (item.type === "agentMessage") {
    if (typeof item.id !== "string" || typeof item.text !== "string") protocolViolation();
    return { assistantItems: [{ itemId: boundedId(item.id, "Codex item identifier"), text: item.text }] };
  }
  if (item.type === "userMessage") {
    if (typeof item.id !== "string" || (item.clientId !== null && typeof item.clientId !== "string")) {
      protocolViolation();
    }
    return { assistantItems: [] };
  }
  if (item.type === "commandExecution") {
    const active = turnStatus === "inProgress" && item.status === "inProgress";
    const parsed = validateReadOnlyCommandExecution(item, active);
    if (turnStatus !== "inProgress" && item.status === "inProgress") protocolViolation();
    return { assistantItems: [], ...(active ? { activeCommand: parsed } : {}) };
  }
  if (item.type === "reasoning" || item.type === "plan" || item.type === "contextCompaction") {
    return { assistantItems: [] };
  }
  protocolViolation();
}

function validateTurnScoped(value: unknown, authority: ActiveTurnAuthority): void {
  const record = requireRecord(value);
  if (record.threadId !== authority.threadId || record.turnId !== authority.turnId) protocolViolation();
}

function validateTurnErrorNotification(value: unknown, authority: ActiveTurnAuthority): void {
  const notification = requireExactRecord(value, ["error", "willRetry", "threadId", "turnId"]);
  if (
    notification.threadId !== authority.threadId || notification.turnId !== authority.turnId ||
    typeof notification.willRetry !== "boolean"
  ) protocolViolation();
  const error = requireExactRecord(notification.error, ["message", "codexErrorInfo", "additionalDetails"]);
  if (
    typeof error.message !== "string" || error.message.length === 0 ||
    !boundedUtf8String(error.message, 8 * 1_024) ||
    (error.additionalDetails !== null &&
      (typeof error.additionalDetails !== "string" ||
        !boundedUtf8String(error.additionalDetails, 8 * 1_024))) ||
    !validCodexErrorInfo(error.codexErrorInfo)
  ) protocolViolation();
}

function validCodexErrorInfo(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string") {
    return new Set([
      "contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded", "serverOverloaded",
      "cyberPolicy", "internalServerError", "unauthorized", "badRequest", "threadRollbackFailed",
      "sandboxError", "other",
    ]).has(value);
  }
  if (!isRecord(value) || Object.keys(value).length !== 1) return false;
  const [kind, details] = Object.entries(value)[0]!;
  if (kind === "activeTurnNotSteerable") {
    return isRecord(details) && sameJson(Object.keys(details), ["turnKind"]) &&
      (details.turnKind === "review" || details.turnKind === "compact");
  }
  if (
    kind !== "httpConnectionFailed" && kind !== "responseStreamConnectionFailed" &&
    kind !== "responseStreamDisconnected" && kind !== "responseTooManyFailedAttempts"
  ) return false;
  return isRecord(details) && sameJson(Object.keys(details), ["httpStatusCode"]) &&
    (details.httpStatusCode === null ||
      (Number.isInteger(details.httpStatusCode) &&
        (details.httpStatusCode as number) >= 100 && (details.httpStatusCode as number) <= 599));
}

function validateRemoteControlDisabled(value: unknown): void {
  const record = requireExactRecord(value, ["status", "serverName", "installationId", "environmentId"]);
  if (record.status !== "disabled" || record.environmentId !== null) protocolViolation();
}

function requireExactValue(actual: unknown, expected: unknown): void {
  if (!sameJson(actual, expected)) protocolViolation();
}

function requireExactRecord(value: unknown, keys: readonly string[]): JsonRecord {
  const record = requireRecord(value);
  if (!sameJson(Object.keys(record).sort(), [...keys].sort())) protocolViolation();
  return record;
}

function requireRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) protocolViolation();
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenLeafPaths(value: unknown, prefix = "", result: string[] = []): string[] {
  if (!isRecord(value)) return result;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(child)) flattenLeafPaths(child, path, result);
    else result.push(path);
  }
  return result;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, value);
}

function sameJson(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function boundedId(value: string, label: string): string {
  if (value.length === 0 || value.length > 256 || !/^[A-Za-z0-9._:+-]+$/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function ambiguousClientFailure(error: unknown): boolean {
  if (!(error instanceof CodexAppServerClientError)) return true;
  const ambiguous = new Set<CodexAppServerClientErrorCode>([
    "APP_SERVER_CLOSED", "APP_SERVER_PROTOCOL_INVALID", "APP_SERVER_RESOURCE_LIMIT",
    "APP_SERVER_REQUEST_TIMEOUT", "APP_SERVER_TRANSPORT_FAILED",
  ]);
  return ambiguous.has(error.code);
}

function sanitizeBackendFailure(error: unknown, message: string): CodexSubscriptionBackendError {
  if (error instanceof CodexSubscriptionBackendError) return error;
  if (error instanceof CodexSubscriptionStoreError) {
    return new CodexSubscriptionBackendError(
      error.code === "CODEX_HOST_BUSY" ? "CODEX_RUNTIME_BUSY" : "CODEX_SUBSCRIPTION_UNAVAILABLE",
      error.message,
      error.retryable,
    );
  }
  return unavailable(message, ambiguousClientFailure(error));
}

function unavailable(message: string, retryable: boolean): CodexSubscriptionBackendError {
  return new CodexSubscriptionBackendError("CODEX_SUBSCRIPTION_UNAVAILABLE", message, retryable);
}

function accountError(error: CodexSubscriptionBackendError): AccountProjection {
  return {
    phase: "unavailable",
    error: { code: error.code, message: error.message, retryable: error.retryable },
  };
}

function protocolViolation(): never {
  throw protocolViolationError();
}

function protocolViolationError(): CodexSubscriptionBackendError {
  return new CodexSubscriptionBackendError(
    "CODEX_PROTOCOL_VIOLATION",
    "Codex app-server violated the frozen Windows preview contract",
    false,
  );
}
