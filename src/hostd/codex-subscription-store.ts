import { createHash, randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { z } from "zod";
import {
  CODEX_SUBSCRIPTION_BACKEND_ID,
  CODEX_SUBSCRIPTION_BACKEND_LABEL,
  CodexSubscriptionConversationSnapshotSchema,
  CodexSubscriptionErrorSchema,
  CodexSubscriptionTranscriptItemSchema,
  CodexSubscriptionTurnSchema,
  CodexSubscriptionWorkspaceBindingSchema,
  IdSchema,
  IsoDateTimeSchema,
  type CodexSubscriptionConversationSnapshot,
  type CodexSubscriptionTurnInterruptRequest,
  type CodexSubscriptionTurnStartRequest,
  type CodexSubscriptionWorkspaceBinding,
} from "../shared/protocol";
import { atomicWriteJson, ensurePrivateDirectory } from "./atomic-files";

const STATE_VERSION = 1 as const;
const MAX_CONVERSATIONS = 32;
const MAX_OPERATIONS = 512;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_ITEMS = 128;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export type CodexSubscriptionStoreErrorCode =
  | "CODEX_STATE_INVALID"
  | "CODEX_STATE_LIMIT"
  | "CODEX_HOST_BUSY"
  | "CODEX_OPERATION_COLLISION"
  | "CODEX_OPERATION_NOT_FOUND"
  | "CODEX_CONVERSATION_NOT_FOUND"
  | "CODEX_TURN_AUTHORITY_CHANGED"
  | "CODEX_NOT_QUIESCENT";

export class CodexSubscriptionStoreError extends Error {
  constructor(
    readonly code: CodexSubscriptionStoreErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CodexSubscriptionStoreError";
  }
}

const PersistedConversationSchema = z
  .object({
    binding: CodexSubscriptionWorkspaceBindingSchema,
    sessionId: IdSchema,
    threadId: IdSchema.optional(),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    latestTurn: CodexSubscriptionTurnSchema.optional(),
    transcript: z.array(CodexSubscriptionTranscriptItemSchema).max(MAX_TRANSCRIPT_ITEMS),
    transcriptTruncated: z.boolean(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
type PersistedConversation = z.infer<typeof PersistedConversationSchema>;

const PersistedOperationSchema = z
  .object({
    operationId: IdSchema,
    kind: z.enum(["turn_start", "turn_interrupt", "login", "logout"]),
    requestDigest: Sha256Schema,
    hostId: IdSchema,
    backendIncarnationId: IdSchema,
    phase: z.enum(["admitted", "dispatching", "active", "completed", "failed", "uncertain"]),
    binding: CodexSubscriptionWorkspaceBindingSchema.optional(),
    sessionId: IdSchema.optional(),
    targetTurnOperationId: IdSchema.optional(),
    clientUserMessageId: IdSchema.optional(),
    promptDispatchStarted: z.boolean().optional(),
    codexThreadId: IdSchema.optional(),
    codexTurnId: IdSchema.optional(),
    reconciledByIncarnationId: IdSchema.optional(),
    loginId: IdSchema.optional(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((operation, context) => {
    const isTurn = operation.kind === "turn_start" || operation.kind === "turn_interrupt";
    if (isTurn !== (operation.binding !== undefined) || isTurn !== (operation.sessionId !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Turn operations require their exact path-free conversation authority",
      });
    }
    if ((operation.kind === "turn_interrupt") !== (operation.targetTurnOperationId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["targetTurnOperationId"],
        message: "Only an interrupt operation retains its exact target turn operation",
      });
    }
    if (operation.loginId !== undefined && operation.kind !== "login") {
      context.addIssue({
        code: "custom",
        path: ["loginId"],
        message: "Only a login operation may retain a login identifier",
      });
    }
    if ((operation.kind === "turn_start") !== (operation.clientUserMessageId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["clientUserMessageId"],
        message: "Turn starts retain the exact client user message identifier",
      });
    }
    if ((operation.promptDispatchStarted !== undefined) && operation.kind !== "turn_start") {
      context.addIssue({
        code: "custom",
        path: ["promptDispatchStarted"],
        message: "Only a turn start may retain its prompt dispatch barrier",
      });
    }
    if (operation.codexTurnId !== undefined && operation.codexThreadId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["codexTurnId"],
        message: "A Codex turn identifier requires its exact Codex thread authority",
      });
    }
    if (operation.binding && operation.binding.hostId !== operation.hostId) {
      context.addIssue({
        code: "custom",
        path: ["hostId"],
        message: "Turn operation host authority must equal its exact workspace binding",
      });
    }
    if (
      (operation.kind === "login" || operation.kind === "logout") &&
      (operation.codexThreadId !== undefined || operation.codexTurnId !== undefined ||
        operation.reconciledByIncarnationId !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["codexThreadId"],
        message: "Account operations cannot retain Codex conversation authority",
      });
    }
  });
export type CodexSubscriptionPersistedOperation = z.infer<typeof PersistedOperationSchema>;

const PersistedStateSchema = z
  .object({
    version: z.literal(STATE_VERSION),
    conversations: z.array(PersistedConversationSchema).max(MAX_CONVERSATIONS),
    operations: z.array(PersistedOperationSchema).max(MAX_OPERATIONS),
  })
  .strict()
  .superRefine((state, context) => {
    const bindings = new Set<string>();
    const sessions = new Set<string>();
    for (const [index, conversation] of state.conversations.entries()) {
      const key = bindingKey(conversation.binding);
      if (bindings.has(key) || sessions.has(conversation.sessionId)) {
        context.addIssue({
          code: "custom",
          path: ["conversations", index],
          message: "Conversation bindings and session identifiers must be unique",
        });
      }
      bindings.add(key);
      sessions.add(conversation.sessionId);
    }
    const operationIds = new Set<string>();
    for (const [index, operation] of state.operations.entries()) {
      if (operationIds.has(operation.operationId)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "operationId"],
          message: "Operation identifiers must be globally unique",
        });
      }
      operationIds.add(operation.operationId);
      const operationConversation = operation.sessionId
        ? state.conversations.find((conversation) => conversation.sessionId === operation.sessionId)
        : undefined;
      if (
        operation.sessionId &&
        (!operationConversation || !operation.binding || !sameBinding(operationConversation.binding, operation.binding))
      ) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "sessionId"],
          message: "Turn operation references an unknown durable conversation",
        });
      }
    }
    const unresolved = state.operations.filter(isUnresolvedOperation);
    const primary = unresolved.filter((operation) => operation.kind !== "turn_interrupt");
    const interrupts = unresolved.filter((operation) => operation.kind === "turn_interrupt");
    if (primary.length > 1 || interrupts.length > 1) {
      context.addIssue({ code: "custom", message: "Only one host-wide Codex invocation may be unresolved" });
    }
    if (
      interrupts.length === 1 &&
      (primary.length !== 1 || interrupts[0]?.targetTurnOperationId !== primary[0]?.operationId)
    ) {
      context.addIssue({ code: "custom", message: "An unresolved interrupt must target the sole unresolved turn" });
    }
  });
type PersistedState = z.infer<typeof PersistedStateSchema>;

export interface CodexSubscriptionStoreOptions {
  readonly statePath: string;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly writeState?: (path: string, value: unknown, maxBytes: number) => Promise<void>;
  readonly maxStateBytes?: number;
}

export interface CodexTurnAdmission {
  readonly duplicate: boolean;
  readonly snapshot: CodexSubscriptionConversationSnapshot;
}

export interface CodexInterruptAdmission extends CodexTurnAdmission {}

export interface CodexAccountMutationAdmission {
  readonly duplicate: boolean;
  readonly operation: CodexSubscriptionPersistedOperation;
}

export interface CodexTurnReconciliationRecord {
  readonly known: boolean;
  readonly operationId: string;
  readonly snapshot?: CodexSubscriptionConversationSnapshot;
}

export interface CodexSubscriptionRecoveryRecord {
  readonly operationId: string;
  readonly kind: CodexSubscriptionPersistedOperation["kind"];
  readonly priorPhase: CodexSubscriptionPersistedOperation["phase"];
  readonly recoveredPhase: "failed" | "uncertain";
}

export interface CodexAuthoritativeTurnProof {
  readonly clientUserMessageId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly state: "inProgress" | "completed" | "interrupted" | "failed";
  readonly assistantItems?: ReadonlyArray<{
    readonly itemId: string;
    readonly text: string;
  }>;
}

const EXECUTION_POLICY = Object.freeze({
  filesystem: "read_only_user_scope",
  workspaceReadConfinement: false,
  toolNetworkAccess: false,
  approvalPolicy: "never",
  disclosure:
    "Codex tools cannot write files or open network connections. They may read other files available to your Windows account; this is not a workspace-only sandbox. Prompts and content Codex reads—including workspace instructions and tool-read files—are sent to OpenAI for the turn.",
} as const);

export class CodexSubscriptionStore {
  private readonly statePath: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly writeState: (path: string, value: unknown, maxBytes: number) => Promise<void>;
  private readonly maxStateBytes: number;
  private state: PersistedState = { version: STATE_VERSION, conversations: [], operations: [] };
  private tail: Promise<void> = Promise.resolve();
  private initialized = false;
  private degradedError: CodexSubscriptionStoreError | undefined;

  constructor(options: CodexSubscriptionStoreOptions) {
    this.statePath = options.statePath;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.writeState = options.writeState ?? atomicWriteJson;
    this.maxStateBytes = options.maxStateBytes ?? MAX_STATE_BYTES;
    if (!Number.isSafeInteger(this.maxStateBytes) || this.maxStateBytes < 4_096 || this.maxStateBytes > MAX_STATE_BYTES) {
      throw new TypeError(`Codex state byte limit must be an integer from 4096 to ${MAX_STATE_BYTES}`);
    }
  }

  initialize(): Promise<readonly CodexSubscriptionRecoveryRecord[]> {
    return this.serialized(async () => {
      if (this.degradedError) throw this.degradedError;
      if (this.initialized) return [];
      await ensurePrivateDirectory(directoryName(this.statePath));
      try {
        this.state = (await readBoundedStateFile(
          this.statePath,
          PersistedStateSchema,
          this.maxStateBytes,
        )) ?? { version: STATE_VERSION, conversations: [], operations: [] };
      } catch {
        throw new CodexSubscriptionStoreError(
          "CODEX_STATE_INVALID",
          "Codex subscription state could not be validated",
          false,
        );
      }
      const recoveries = this.recoverInterruptedHost();
      if (recoveries.length > 0) await this.persist();
      this.initialized = true;
      return Object.freeze(recoveries);
    });
  }

  getConversation(
    binding: CodexSubscriptionWorkspaceBinding,
    backendIncarnationId: string,
  ): Promise<CodexSubscriptionConversationSnapshot | undefined> {
    return this.serialized(async () => {
      this.requireInitialized();
      const parsedBinding = CodexSubscriptionWorkspaceBindingSchema.parse(binding);
      const conversation = this.findConversation(parsedBinding);
      return conversation ? this.snapshot(conversation, backendIncarnationId) : undefined;
    });
  }

  admitTurn(
    request: CodexSubscriptionTurnStartRequest,
    backendIncarnationId: string,
  ): Promise<CodexTurnAdmission> {
    return this.serialized(async () => {
      this.requireInitialized();
      const binding = bindingFromTurnRequest(request);
      const digest = turnStartDigest(request);
      const known = this.findOperation(request.operationId);
      if (known) {
        this.assertExactOperation(known, "turn_start", digest);
        const conversation = this.requiredOperationConversation(known);
        return Object.freeze({ duplicate: true, snapshot: this.snapshot(conversation, backendIncarnationId) });
      }
      if (request.expectedBackendIncarnationId !== backendIncarnationId) this.invalidTurnAuthority();
      this.assertNewPrimaryAdmission();
      this.assertOperationCapacity();
      let conversation = this.findConversation(binding);
      this.assertConversationObservation(conversation, request.expectedConversation);
      const admittedAt = this.causalTimestamp(conversation?.updatedAt);
      if (!conversation) {
        if (this.state.conversations.length >= MAX_CONVERSATIONS) {
          throw new CodexSubscriptionStoreError(
            "CODEX_STATE_LIMIT",
            "Codex conversation capacity is exhausted",
            false,
          );
        }
        conversation = {
          binding,
          sessionId: this.nextIdentifier("codex-session"),
          revision: 0,
          transcript: [],
          transcriptTruncated: false,
          updatedAt: admittedAt,
        };
        this.state.conversations.push(conversation);
      }
      const clientUserMessageId = stableItemId("user", request.operationId);
      const turn = CodexSubscriptionTurnSchema.parse({
        operationId: request.operationId,
        state: "admitted",
        terminal: false,
        startedAt: admittedAt,
      });
      this.appendTranscript(conversation, {
        itemId: clientUserMessageId,
        turnOperationId: request.operationId,
        sequence: nextTranscriptSequence(conversation),
        role: "user",
        state: "completed",
        text: request.prompt,
        createdAt: admittedAt,
        updatedAt: admittedAt,
      });
      conversation.latestTurn = turn;
      this.bump(conversation, admittedAt);
      this.state.operations.push({
        operationId: request.operationId,
        kind: "turn_start",
        requestDigest: digest,
        hostId: binding.hostId,
        backendIncarnationId,
        phase: "admitted",
        binding,
        sessionId: conversation.sessionId,
        clientUserMessageId,
        promptDispatchStarted: false,
        updatedAt: admittedAt,
      });
      await this.persist();
      return Object.freeze({ duplicate: false, snapshot: this.snapshot(conversation, backendIncarnationId) });
    });
  }

  markTurnStartingThread(operationId: string, backendIncarnationId: string): Promise<CodexSubscriptionConversationSnapshot> {
    return this.updateActiveTurn(operationId, "starting_thread", "dispatching", backendIncarnationId);
  }

  bindThread(
    operationId: string,
    threadId: string,
    backendIncarnationId: string,
  ): Promise<CodexSubscriptionConversationSnapshot> {
    return this.serialized(async () => {
      const { operation, conversation, turn } = this.requiredActiveTurn(operationId);
      if (turn.state !== "starting_thread") this.invalidTurnAuthority();
      conversation.threadId = IdSchema.parse(threadId);
      operation.codexThreadId = conversation.threadId;
      conversation.latestTurn = CodexSubscriptionTurnSchema.parse({ ...turn, state: "starting_turn" });
      operation.phase = "dispatching";
      const updatedAt = this.causalTimestamp(conversation.updatedAt, operation.updatedAt, turn.startedAt);
      operation.updatedAt = updatedAt;
      this.bump(conversation, updatedAt);
      await this.persist();
      return this.snapshot(conversation, backendIncarnationId);
    });
  }

  bindTurn(
    operationId: string,
    turnId: string,
    backendIncarnationId: string,
  ): Promise<CodexSubscriptionConversationSnapshot> {
    return this.serialized(async () => {
      const { operation, conversation, turn } = this.requiredActiveTurn(operationId);
      if (
        turn.state !== "starting_turn" || !conversation.threadId ||
        operation.promptDispatchStarted !== true
      ) this.invalidTurnAuthority();
      const parsedTurnId = IdSchema.parse(turnId);
      operation.codexThreadId = conversation.threadId;
      operation.codexTurnId = parsedTurnId;
      conversation.latestTurn = CodexSubscriptionTurnSchema.parse({ ...turn, turnId: parsedTurnId, state: "running" });
      for (const item of conversation.transcript) {
        if (item.turnOperationId === operationId) item.turnId = parsedTurnId;
      }
      operation.phase = "active";
      const updatedAt = this.causalTimestamp(conversation.updatedAt, operation.updatedAt, turn.startedAt);
      operation.updatedAt = updatedAt;
      this.bump(conversation, updatedAt);
      await this.persist();
      return this.snapshot(conversation, backendIncarnationId);
    });
  }

  /** Persists the exact no-replay boundary immediately before `turn/start`. */
  markTurnPromptDispatching(
    operationId: string,
    backendIncarnationId: string,
  ): Promise<CodexSubscriptionConversationSnapshot> {
    return this.serialized(async () => {
      const { operation, conversation, turn } = this.requiredActiveTurn(operationId);
      if (
        turn.state !== "starting_turn" || !conversation.threadId ||
        operation.codexThreadId !== conversation.threadId ||
        operation.promptDispatchStarted === true
      ) this.invalidTurnAuthority();
      operation.promptDispatchStarted = true;
      const updatedAt = this.causalTimestamp(conversation.updatedAt, operation.updatedAt, turn.startedAt);
      operation.updatedAt = updatedAt;
      this.bump(conversation, updatedAt);
      await this.persist();
      return this.snapshot(conversation, backendIncarnationId);
    });
  }

  appendAssistantDelta(
    operationId: string,
    itemId: string,
    delta: string,
    backendIncarnationId: string,
  ): Promise<CodexSubscriptionConversationSnapshot> {
    return this.serialized(async () => {
      const { conversation, turn } = this.requiredActiveTurn(operationId);
      if ((turn.state !== "running" && turn.state !== "interrupting") || !turn.turnId) {
        this.invalidTurnAuthority();
      }
      const parsedItemId = IdSchema.parse(itemId);
      if (delta.length === 0 || delta.length > 64 * 1_024) {
        throw new CodexSubscriptionStoreError("CODEX_STATE_LIMIT", "Codex transcript delta is invalid", false);
      }
      const updatedAt = this.causalTimestamp(conversation.updatedAt, turn.startedAt);
      let item = conversation.transcript.find((candidate) =>
        candidate.itemId === parsedItemId && candidate.turnOperationId === operationId && candidate.role === "assistant"
      );
      if (!item) {
        item = CodexSubscriptionTranscriptItemSchema.parse({
          itemId: parsedItemId,
          turnOperationId: operationId,
          turnId: turn.turnId,
          sequence: nextTranscriptSequence(conversation),
          role: "assistant",
          state: "streaming",
          text: delta,
          createdAt: updatedAt,
          updatedAt,
        });
        this.appendTranscript(conversation, item);
      } else {
        if (item.text.length + delta.length > 128 * 1_024) {
          throw new CodexSubscriptionStoreError("CODEX_STATE_LIMIT", "Codex assistant message exceeds its limit", false);
        }
        item.text += delta;
        item.updatedAt = updatedAt;
      }
      this.bump(conversation, updatedAt);
      await this.persist();
      return this.snapshot(conversation, backendIncarnationId);
    });
  }

  completeAssistantItem(
    operationId: string,
    itemId: string,
    text: string,
    backendIncarnationId: string,
  ): Promise<CodexSubscriptionConversationSnapshot> {
    return this.serialized(async () => {
      const { conversation, turn } = this.requiredActiveTurn(operationId);
      if ((turn.state !== "running" && turn.state !== "interrupting") || !turn.turnId) {
        this.invalidTurnAuthority();
      }
      const parsedItemId = IdSchema.parse(itemId);
      if (text.length > 128 * 1_024) {
        throw new CodexSubscriptionStoreError("CODEX_STATE_LIMIT", "Codex assistant message exceeds its limit", false);
      }
      const updatedAt = this.causalTimestamp(conversation.updatedAt, turn.startedAt);
      let item = conversation.transcript.find((candidate) =>
        candidate.itemId === parsedItemId && candidate.turnOperationId === operationId && candidate.role === "assistant"
      );
      if (!item) {
        item = CodexSubscriptionTranscriptItemSchema.parse({
          itemId: parsedItemId,
          turnOperationId: operationId,
          turnId: turn.turnId,
          sequence: nextTranscriptSequence(conversation),
          role: "assistant",
          state: "completed",
          text,
          createdAt: updatedAt,
          updatedAt,
        });
        this.appendTranscript(conversation, item);
      } else {
        item.text = text;
        item.state = "completed";
        item.updatedAt = updatedAt;
      }
      this.bump(conversation, updatedAt);
      await this.persist();
      return this.snapshot(conversation, backendIncarnationId);
    });
  }

  completeTurn(
    operationId: string,
    outcome: Readonly<{
      state: "completed" | "interrupted" | "failed" | "uncertain";
      error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
    }>,
    backendIncarnationId: string,
  ): Promise<CodexSubscriptionConversationSnapshot> {
    return this.serialized(async () => {
      const { operation, conversation, turn } = this.requiredActiveTurn(operationId);
      const completedAt = this.causalTimestamp(conversation.updatedAt, operation.updatedAt, turn.startedAt);
      conversation.latestTurn = CodexSubscriptionTurnSchema.parse({
        operationId,
        ...(turn.turnId ? { turnId: turn.turnId } : {}),
        state: outcome.state,
        terminal: true,
        startedAt: turn.startedAt,
        completedAt,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
      for (const item of conversation.transcript) {
        if (item.turnOperationId === operationId) {
          item.state = "completed";
          item.updatedAt = completedAt;
        }
      }
      operation.phase = outcome.state === "uncertain"
        ? "uncertain"
        : outcome.state === "failed"
        ? "failed"
        : "completed";
      operation.updatedAt = completedAt;
      this.settleMatchingInterrupts(
        operation,
        outcome.state === "interrupted" ? "completed" : outcome.state === "uncertain" ? "uncertain" : "failed",
        completedAt,
      );
      this.bump(conversation, completedAt);
      await this.persist();
      return this.snapshot(conversation, backendIncarnationId);
    });
  }

  /**
   * Applies one authoritative provider completion and retires any matching
   * Stop admission in the same durable transaction. Duplicate identical
   * notifications are idempotent; conflicting terminal evidence fails closed.
   */
  settleProviderTurn(
    operationId: string,
    proof: Readonly<{
      threadId: string;
      turnId: string;
      state: "completed" | "interrupted" | "failed";
      error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
    }>,
    backendIncarnationId: string,
  ): Promise<CodexSubscriptionConversationSnapshot> {
    return this.serialized(async () => {
      this.requireInitialized();
      const operation = this.requiredOperation(operationId, "turn_start");
      const conversation = this.requiredOperationConversation(operation);
      const threadId = IdSchema.parse(proof.threadId);
      const turnId = IdSchema.parse(proof.turnId);
      const error = proof.error === undefined ? undefined : CodexSubscriptionErrorSchema.parse(proof.error);
      if (
        conversation.threadId !== threadId ||
        operation.codexThreadId !== threadId ||
        operation.codexTurnId !== turnId
      ) this.invalidTurnAuthority();
      const latest = conversation.latestTurn;
      if (!latest || latest.operationId !== operation.operationId || latest.turnId !== turnId) {
        this.invalidTurnAuthority();
      }
      if (latest.terminal) {
        if (
          latest.state !== proof.state ||
          JSON.stringify(latest.error) !== JSON.stringify(error)
        ) this.invalidTurnAuthority();
        return this.snapshot(conversation, backendIncarnationId);
      }
      if (latest.state !== "running" && latest.state !== "interrupting") this.invalidTurnAuthority();
      if ((proof.state === "failed") !== (error !== undefined)) this.invalidTurnAuthority();
      const completedAt = this.causalTimestamp(
        conversation.updatedAt,
        operation.updatedAt,
        latest.startedAt,
      );
      conversation.latestTurn = CodexSubscriptionTurnSchema.parse({
        operationId: operation.operationId,
        turnId,
        state: proof.state,
        terminal: true,
        startedAt: latest.startedAt,
        completedAt,
        ...(error ? { error } : {}),
      });
      for (const item of conversation.transcript) {
        if (item.turnOperationId === operation.operationId) {
          item.state = "completed";
          item.updatedAt = completedAt;
        }
      }
      operation.phase = proof.state === "failed" ? "failed" : "completed";
      operation.updatedAt = completedAt;
      this.settleMatchingInterrupts(
        operation,
        proof.state === "interrupted" ? "completed" : "failed",
        completedAt,
      );
      this.bump(conversation, completedAt);
      await this.persist();
      return this.snapshot(conversation, backendIncarnationId);
    });
  }

  admitInterrupt(
    request: CodexSubscriptionTurnInterruptRequest,
    backendIncarnationId: string,
  ): Promise<CodexInterruptAdmission> {
    return this.serialized(async () => {
      this.requireInitialized();
      const binding = bindingFromInterruptRequest(request);
      const digest = turnInterruptDigest(request);
      const known = this.findOperation(request.operationId);
      if (known) {
        this.assertExactOperation(known, "turn_interrupt", digest);
        return Object.freeze({
          duplicate: true,
          snapshot: this.snapshot(this.requiredOperationConversation(known), backendIncarnationId),
        });
      }
      if (request.expectedBackendIncarnationId !== backendIncarnationId) this.invalidTurnAuthority();
      this.assertOperationCapacity();
      const target = this.findOperation(request.expectedTurnOperationId);
      if (!target || target.kind !== "turn_start" || !isUnresolvedOperation(target)) this.invalidTurnAuthority();
      const conversation = this.requiredOperationConversation(target);
      const turn = conversation.latestTurn;
      if (
        !sameBinding(conversation.binding, binding) ||
        conversation.sessionId !== request.sessionId ||
        conversation.threadId !== request.codexThreadId ||
        !turn || turn.terminal || turn.turnId !== request.turnId ||
        this.state.operations.some((operation) => operation.kind === "turn_interrupt" && isUnresolvedOperation(operation))
      ) {
        this.invalidTurnAuthority();
      }
      const admittedAt = this.causalTimestamp(conversation.updatedAt, target.updatedAt, turn?.startedAt);
      this.state.operations.push({
        operationId: request.operationId,
        kind: "turn_interrupt",
        requestDigest: digest,
        hostId: binding.hostId,
        backendIncarnationId,
        phase: "admitted",
        binding,
        sessionId: conversation.sessionId,
        targetTurnOperationId: request.expectedTurnOperationId,
        codexThreadId: request.codexThreadId,
        codexTurnId: request.turnId,
        updatedAt: admittedAt,
      });
      await this.persist();
      return Object.freeze({ duplicate: false, snapshot: this.snapshot(conversation, backendIncarnationId) });
    });
  }

  markInterruptDispatching(
    operationId: string,
    backendIncarnationId: string,
  ): Promise<CodexSubscriptionConversationSnapshot> {
    return this.serialized(async () => {
      const interrupt = this.requiredOperation(operationId, "turn_interrupt");
      if (interrupt.phase !== "admitted" || !interrupt.targetTurnOperationId) this.invalidTurnAuthority();
      const target = this.requiredOperation(interrupt.targetTurnOperationId, "turn_start");
      const conversation = this.requiredOperationConversation(target);
      const turn = conversation.latestTurn;
      if (!turn || turn.terminal || turn.state !== "running") this.invalidTurnAuthority();
      conversation.latestTurn = CodexSubscriptionTurnSchema.parse({ ...turn, state: "interrupting" });
      interrupt.phase = "dispatching";
      const updatedAt = this.causalTimestamp(
        conversation.updatedAt,
        interrupt.updatedAt,
        target.updatedAt,
        turn.startedAt,
      );
      interrupt.updatedAt = updatedAt;
      this.bump(conversation, updatedAt);
      await this.persist();
      return this.snapshot(conversation, backendIncarnationId);
    });
  }

  completeInterrupt(
    operationId: string,
    outcome: "interrupted" | "failed" | "uncertain",
    backendIncarnationId: string,
  ): Promise<CodexSubscriptionConversationSnapshot> {
    return this.serialized(async () => {
      const interrupt = this.requiredOperation(operationId, "turn_interrupt");
      if (interrupt.phase !== "dispatching" || !interrupt.targetTurnOperationId) this.invalidTurnAuthority();
      const target = this.requiredOperation(interrupt.targetTurnOperationId, "turn_start");
      const conversation = this.requiredOperationConversation(target);
      const turn = conversation.latestTurn;
      if (!turn || turn.terminal || turn.state !== "interrupting" || !turn.turnId) this.invalidTurnAuthority();
      const updatedAt = this.causalTimestamp(
        conversation.updatedAt,
        interrupt.updatedAt,
        target.updatedAt,
        turn.startedAt,
      );
      if (outcome === "failed") {
        conversation.latestTurn = CodexSubscriptionTurnSchema.parse({ ...turn, state: "running" });
        interrupt.phase = "failed";
      } else {
        conversation.latestTurn = CodexSubscriptionTurnSchema.parse({
          operationId: target.operationId,
          turnId: turn.turnId,
          state: outcome,
          terminal: true,
          startedAt: turn.startedAt,
          completedAt: updatedAt,
          ...(outcome === "uncertain"
            ? {
                error: {
                  code: "CODEX_INTERRUPT_OUTCOME_UNKNOWN",
                  message: "Stop may have reached Codex, but its outcome could not be confirmed",
                  retryable: true,
                },
              }
            : {}),
        });
        for (const item of conversation.transcript) {
          if (item.turnOperationId === target.operationId) {
            item.state = "completed";
            item.updatedAt = updatedAt;
          }
        }
        target.phase = outcome === "uncertain" ? "uncertain" : "completed";
        target.updatedAt = updatedAt;
        interrupt.phase = outcome === "uncertain" ? "uncertain" : "completed";
      }
      interrupt.updatedAt = updatedAt;
      this.bump(conversation, updatedAt);
      await this.persist();
      return this.snapshot(conversation, backendIncarnationId);
    });
  }

  reconcileTurn(
    request: CodexSubscriptionTurnStartRequest,
    backendIncarnationId: string,
  ): Promise<CodexTurnReconciliationRecord> {
    return this.serialized(async () => {
      this.requireInitialized();
      const operation = this.findOperation(request.operationId);
      if (!operation) return Object.freeze({ known: false, operationId: request.operationId });
      this.assertExactOperation(operation, "turn_start", turnStartDigest(request));
      return Object.freeze({
        known: true,
        operationId: request.operationId,
        snapshot: this.snapshot(this.requiredOperationConversation(operation), backendIncarnationId),
      });
    });
  }

  /**
   * Adopts an attested app-server `thread/read` result for an uncertain turn.
   * It never starts or resends work: the durable client user-message identity
   * and any already-known provider thread/turn IDs must match exactly.
   */
  adoptAuthoritativeTurn(
    operationId: string,
    proof: CodexAuthoritativeTurnProof,
    backendIncarnationId: string,
  ): Promise<CodexSubscriptionConversationSnapshot> {
    return this.serialized(async () => {
      this.requireInitialized();
      const operation = this.requiredOperation(operationId, "turn_start");
      const conversation = this.requiredOperationConversation(operation);
      const latest = conversation.latestTurn;
      const parsedThreadId = IdSchema.parse(proof.threadId);
      const parsedTurnId = IdSchema.parse(proof.turnId);
      if (
        operation.phase !== "uncertain" ||
        operation.promptDispatchStarted !== true ||
        !latest || latest.state !== "uncertain" || latest.operationId !== operation.operationId ||
        operation.clientUserMessageId !== IdSchema.parse(proof.clientUserMessageId) ||
        (operation.codexThreadId !== undefined && operation.codexThreadId !== parsedThreadId) ||
        (operation.codexTurnId !== undefined && operation.codexTurnId !== parsedTurnId) ||
        (conversation.threadId !== undefined && conversation.threadId !== parsedThreadId)
      ) {
        this.invalidTurnAuthority();
      }
      const assistantItems = proof.assistantItems ?? [];
      if (assistantItems.length > 64) {
        throw new CodexSubscriptionStoreError("CODEX_STATE_LIMIT", "Codex reconciliation has too many messages", false);
      }
      const updatedAt = this.causalTimestamp(
        conversation.updatedAt,
        operation.updatedAt,
        latest.startedAt,
        latest.completedAt,
      );
      conversation.threadId = parsedThreadId;
      operation.codexThreadId = parsedThreadId;
      operation.codexTurnId = parsedTurnId;
      operation.reconciledByIncarnationId = IdSchema.parse(backendIncarnationId);
      for (const item of conversation.transcript) {
        if (item.turnOperationId === operation.operationId) item.turnId = parsedTurnId;
      }
      for (const assistant of assistantItems) {
        const itemId = IdSchema.parse(assistant.itemId);
        if (assistant.text.length > 128 * 1_024) {
          throw new CodexSubscriptionStoreError("CODEX_STATE_LIMIT", "Codex reconciled message exceeds its limit", false);
        }
        const existing = conversation.transcript.find((item) =>
          item.itemId === itemId && item.turnOperationId === operation.operationId && item.role === "assistant"
        );
        if (existing) {
          existing.text = assistant.text;
          existing.state = proof.state === "inProgress" ? "streaming" : "completed";
          existing.turnId = parsedTurnId;
          existing.updatedAt = updatedAt;
        } else {
          this.appendTranscript(conversation, {
            itemId,
            turnOperationId: operation.operationId,
            turnId: parsedTurnId,
            sequence: nextTranscriptSequence(conversation),
            role: "assistant",
            state: proof.state === "inProgress" ? "streaming" : "completed",
            text: assistant.text,
            createdAt: updatedAt,
            updatedAt,
          });
        }
      }
      if (proof.state === "inProgress") {
        conversation.latestTurn = CodexSubscriptionTurnSchema.parse({
          operationId: operation.operationId,
          turnId: parsedTurnId,
          state: "running",
          terminal: false,
          startedAt: latest.startedAt,
        });
        operation.phase = "active";
      } else {
        const terminalState = proof.state;
        conversation.latestTurn = CodexSubscriptionTurnSchema.parse({
          operationId: operation.operationId,
          turnId: parsedTurnId,
          state: terminalState,
          terminal: true,
          startedAt: latest.startedAt,
          completedAt: updatedAt,
          ...(terminalState === "failed"
            ? {
                error: {
                  code: "CODEX_TURN_FAILED",
                  message: "Codex reported that the turn failed",
                  retryable: true,
                },
              }
            : {}),
        });
        for (const item of conversation.transcript) {
          if (item.turnOperationId === operation.operationId) {
            item.state = "completed";
            item.updatedAt = updatedAt;
          }
        }
        operation.phase = terminalState === "failed" ? "failed" : "completed";
      }
      operation.updatedAt = updatedAt;
      for (const interrupt of this.state.operations) {
        if (interrupt.kind !== "turn_interrupt" || interrupt.targetTurnOperationId !== operation.operationId) continue;
        if (isUnresolvedOperation(interrupt)) {
          interrupt.phase = proof.state === "interrupted" ? "completed" : "failed";
          interrupt.reconciledByIncarnationId = backendIncarnationId;
          interrupt.updatedAt = updatedAt;
        }
      }
      this.bump(conversation, updatedAt);
      await this.persist();
      return this.snapshot(conversation, backendIncarnationId);
    });
  }

  adoptAccountReconciliation(operationId: string, signedIn: boolean): Promise<void> {
    return this.serialized(async () => {
      const operation = this.requiredAccountOperation(operationId);
      if (operation.phase !== "uncertain") this.invalidTurnAuthority();
      operation.phase = operation.kind === "login"
        ? signedIn ? "completed" : "failed"
        : signedIn ? "failed" : "completed";
      operation.updatedAt = this.causalTimestamp(operation.updatedAt);
      await this.persist();
    });
  }

  /**
   * Reconciles one exact login against a secure provider account/read. A
   * callback can complete after cancel returned notFound, so a prior failed
   * projection may advance to completed when the provider later proves the
   * credential exists. This never dispatches or replays login work.
   */
  settleLoginFromAccountRead(operationId: string, signedIn: boolean): Promise<void> {
    return this.serialized(async () => {
      const operation = this.requiredOperation(operationId, "login");
      const phase = signedIn ? "completed" : "failed";
      if (operation.phase === phase) return;
      operation.phase = phase;
      operation.updatedAt = this.causalTimestamp(operation.updatedAt);
      await this.persist();
    });
  }

  admitAccountMutation(
    kind: "login" | "logout",
    expectedHostId: string,
    operationId: string,
    expectedBackendIncarnationId: string,
    backendIncarnationId: string,
  ): Promise<CodexAccountMutationAdmission> {
    return this.serialized(async () => {
      this.requireInitialized();
      const parsedOperationId = IdSchema.parse(operationId);
      const parsedHostId = IdSchema.parse(expectedHostId);
      const parsedExpectedIncarnation = IdSchema.parse(expectedBackendIncarnationId);
      const digest = accountMutationDigest(kind, parsedHostId, parsedOperationId, parsedExpectedIncarnation);
      const known = this.findOperation(parsedOperationId);
      if (known) {
        this.assertExactOperation(known, kind, digest);
        return Object.freeze({ duplicate: true, operation: Object.freeze({ ...known }) });
      }
      if (parsedExpectedIncarnation !== backendIncarnationId) this.invalidTurnAuthority();
      this.assertNewPrimaryAdmission();
      this.assertOperationCapacity();
      const operation = PersistedOperationSchema.parse({
        operationId: parsedOperationId,
        kind,
        requestDigest: digest,
        hostId: parsedHostId,
        backendIncarnationId,
        phase: "admitted",
        updatedAt: this.causalTimestamp(),
      });
      this.state.operations.push(operation);
      await this.persist();
      return Object.freeze({ duplicate: false, operation: Object.freeze({ ...operation }) });
    });
  }

  markAccountMutationDispatching(operationId: string): Promise<CodexSubscriptionPersistedOperation> {
    return this.serialized(async () => {
      const operation = this.requiredAccountOperation(operationId);
      if (operation.phase !== "admitted") this.invalidTurnAuthority();
      operation.phase = "dispatching";
      operation.updatedAt = this.causalTimestamp(operation.updatedAt);
      await this.persist();
      return Object.freeze({ ...operation });
    });
  }

  markLoginActive(operationId: string, loginId: string): Promise<CodexSubscriptionPersistedOperation> {
    return this.serialized(async () => {
      const operation = this.requiredOperation(operationId, "login");
      if (operation.phase !== "dispatching") this.invalidTurnAuthority();
      operation.loginId = IdSchema.parse(loginId);
      operation.phase = "active";
      operation.updatedAt = this.causalTimestamp(operation.updatedAt);
      await this.persist();
      return Object.freeze({ ...operation });
    });
  }

  beginLoginCancel(
    operationId: string,
    loginId: string,
  ): Promise<CodexSubscriptionPersistedOperation> {
    return this.serialized(async () => {
      const operation = this.requiredOperation(operationId, "login");
      if (operation.phase !== "active" || operation.loginId !== IdSchema.parse(loginId)) {
        this.invalidTurnAuthority();
      }
      operation.phase = "dispatching";
      operation.updatedAt = this.causalTimestamp(operation.updatedAt);
      await this.persist();
      return Object.freeze({ ...operation });
    });
  }

  completeAccountMutation(operationId: string, outcome: "completed" | "failed" | "uncertain"): Promise<void> {
    return this.serialized(async () => {
      const operation = this.requiredAccountOperation(operationId);
      if (!isUnresolvedOperation(operation)) this.invalidTurnAuthority();
      operation.phase = outcome;
      operation.updatedAt = this.causalTimestamp(operation.updatedAt);
      await this.persist();
    });
  }

  getOperation(operationId: string): Promise<CodexSubscriptionPersistedOperation | undefined> {
    return this.serialized(async () => {
      this.requireInitialized();
      const operation = this.findOperation(IdSchema.parse(operationId));
      return operation ? Object.freeze({ ...operation }) : undefined;
    });
  }

  assertQuiescent(): Promise<void> {
    return this.serialized(async () => {
      this.requireInitialized();
      if (this.state.operations.some(isUnresolvedOperation)) {
        throw new CodexSubscriptionStoreError(
          "CODEX_NOT_QUIESCENT",
          "Codex has an active or unresolved host-owned operation",
          true,
        );
      }
    });
  }

  private updateActiveTurn(
    operationId: string,
    state: "starting_thread",
    phase: "dispatching",
    backendIncarnationId: string,
  ): Promise<CodexSubscriptionConversationSnapshot> {
    return this.serialized(async () => {
      const { operation, conversation, turn } = this.requiredActiveTurn(operationId);
      if (turn.state !== "admitted" || operation.phase !== "admitted") this.invalidTurnAuthority();
      conversation.latestTurn = CodexSubscriptionTurnSchema.parse({ ...turn, state });
      operation.phase = phase;
      const updatedAt = this.causalTimestamp(conversation.updatedAt, operation.updatedAt, turn.startedAt);
      operation.updatedAt = updatedAt;
      this.bump(conversation, updatedAt);
      await this.persist();
      return this.snapshot(conversation, backendIncarnationId);
    });
  }

  private settleMatchingInterrupts(
    target: CodexSubscriptionPersistedOperation,
    phase: "completed" | "failed" | "uncertain",
    updatedAt: string,
  ): void {
    for (const interrupt of this.state.operations) {
      if (
        interrupt.kind === "turn_interrupt" &&
        interrupt.targetTurnOperationId === target.operationId &&
        isUnresolvedOperation(interrupt)
      ) {
        interrupt.phase = phase;
        interrupt.updatedAt = updatedAt;
      }
    }
  }

  private recoverInterruptedHost(): CodexSubscriptionRecoveryRecord[] {
    const recoveries: CodexSubscriptionRecoveryRecord[] = [];
    const recoveredAt = this.causalTimestamp(
      ...this.state.operations.map((operation) => operation.updatedAt),
      ...this.state.conversations.flatMap((conversation) => [
        conversation.updatedAt,
        conversation.latestTurn?.startedAt,
        conversation.latestTurn?.terminal ? conversation.latestTurn.completedAt : undefined,
        ...conversation.transcript.flatMap((item) => [item.createdAt, item.updatedAt]),
      ]),
    );
    for (const operation of this.state.operations) {
      if (!isUnresolvedOperation(operation)) continue;
      const priorPhase = operation.phase;
      const recoveredPhase = priorPhase === "admitted" ||
        (operation.kind === "turn_start" && operation.promptDispatchStarted !== true)
        ? "failed"
        : "uncertain";
      operation.phase = recoveredPhase;
      operation.updatedAt = recoveredAt;
      if (operation.kind === "turn_start") {
        const conversation = this.requiredOperationConversation(operation);
        const turn = conversation.latestTurn;
        if (turn && !turn.terminal && turn.operationId === operation.operationId) {
          conversation.latestTurn = CodexSubscriptionTurnSchema.parse({
            operationId: operation.operationId,
            ...(turn.turnId ? { turnId: turn.turnId } : {}),
            state: recoveredPhase === "failed" ? "failed" : "uncertain",
            terminal: true,
            startedAt: turn.startedAt,
            completedAt: recoveredAt,
            error: recoveredPhase === "failed"
              ? {
                  code: "CODEX_TURN_NOT_DISPATCHED",
                  message: "The host restarted before the Codex turn was dispatched",
                  retryable: true,
                }
              : {
                  code: "CODEX_TURN_OUTCOME_UNKNOWN",
                  message: "The host restarted while the Codex turn outcome was unresolved",
                  retryable: true,
                },
          });
          for (const item of conversation.transcript) {
            if (item.turnOperationId === operation.operationId) {
              item.state = "completed";
              item.updatedAt = recoveredAt;
            }
          }
          this.bump(conversation, recoveredAt);
        }
      }
      recoveries.push(Object.freeze({ operationId: operation.operationId, kind: operation.kind, priorPhase, recoveredPhase }));
    }
    return recoveries;
  }

  private snapshot(
    conversation: PersistedConversation,
    backendIncarnationId: string,
  ): CodexSubscriptionConversationSnapshot {
    const latestTurn = conversation.latestTurn;
    const state = !latestTurn
      ? "idle"
      : !latestTurn.terminal
      ? "active"
      : latestTurn.state === "uncertain"
      ? "uncertain"
      : "terminal";
    return CodexSubscriptionConversationSnapshotSchema.parse({
      backend: {
        id: CODEX_SUBSCRIPTION_BACKEND_ID,
        kind: "codex_subscription",
        label: CODEX_SUBSCRIPTION_BACKEND_LABEL,
      },
      backendIncarnationId: IdSchema.parse(backendIncarnationId),
      binding: conversation.binding,
      sessionId: conversation.sessionId,
      ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
      revision: conversation.revision,
      state,
      executionPolicy: EXECUTION_POLICY,
      ...(!latestTurn?.terminal ? { activeTurn: latestTurn } : {}),
      ...(latestTurn ? { latestTurn } : {}),
      transcript: conversation.transcript,
      transcriptTruncated: conversation.transcriptTruncated,
      updatedAt: conversation.updatedAt,
    });
  }

  private requiredActiveTurn(operationId: string): {
    operation: CodexSubscriptionPersistedOperation;
    conversation: PersistedConversation;
    turn: Extract<z.infer<typeof CodexSubscriptionTurnSchema>, { terminal: false }>;
  } {
    this.requireInitialized();
    const operation = this.requiredOperation(operationId, "turn_start");
    if (!isUnresolvedOperation(operation)) this.invalidTurnAuthority();
    const conversation = this.requiredOperationConversation(operation);
    const turn = conversation.latestTurn;
    if (!turn || turn.terminal || turn.operationId !== operation.operationId) this.invalidTurnAuthority();
    return { operation, conversation, turn };
  }

  private requiredOperationConversation(operation: CodexSubscriptionPersistedOperation): PersistedConversation {
    if (!operation.binding || !operation.sessionId) {
      throw new CodexSubscriptionStoreError(
        "CODEX_CONVERSATION_NOT_FOUND",
        "Codex operation does not own a conversation",
        false,
      );
    }
    const conversation = this.state.conversations.find((candidate) =>
      candidate.sessionId === operation.sessionId && sameBinding(candidate.binding, operation.binding!)
    );
    if (!conversation) {
      throw new CodexSubscriptionStoreError(
        "CODEX_CONVERSATION_NOT_FOUND",
        "Codex operation conversation is unavailable",
        false,
      );
    }
    return conversation;
  }

  private requiredOperation(
    operationId: string,
    kind: CodexSubscriptionPersistedOperation["kind"],
  ): CodexSubscriptionPersistedOperation {
    this.requireInitialized();
    const operation = this.findOperation(IdSchema.parse(operationId));
    if (!operation || operation.kind !== kind) {
      throw new CodexSubscriptionStoreError(
        "CODEX_OPERATION_NOT_FOUND",
        "Codex operation was not found",
        false,
      );
    }
    return operation;
  }

  private requiredAccountOperation(operationId: string): CodexSubscriptionPersistedOperation {
    this.requireInitialized();
    const operation = this.findOperation(IdSchema.parse(operationId));
    if (!operation || (operation.kind !== "login" && operation.kind !== "logout")) {
      throw new CodexSubscriptionStoreError(
        "CODEX_OPERATION_NOT_FOUND",
        "Codex account operation was not found",
        false,
      );
    }
    return operation;
  }

  private assertExactOperation(
    operation: CodexSubscriptionPersistedOperation,
    kind: CodexSubscriptionPersistedOperation["kind"],
    digest: string,
  ): void {
    if (operation.kind !== kind || operation.requestDigest !== digest) {
      throw new CodexSubscriptionStoreError(
        "CODEX_OPERATION_COLLISION",
        "Codex operation identifier was reused for a different request",
        false,
      );
    }
  }

  private assertNewPrimaryAdmission(): void {
    if (this.state.operations.some(isUnresolvedOperation)) {
      throw new CodexSubscriptionStoreError(
        "CODEX_HOST_BUSY",
        "Another Codex login or turn is active or unresolved on this host",
        true,
      );
    }
  }

  private assertConversationObservation(
    conversation: PersistedConversation | undefined,
    observation: CodexSubscriptionTurnStartRequest["expectedConversation"],
  ): void {
    if (!conversation) {
      if (observation.state !== "absent") this.invalidTurnAuthority();
      return;
    }
    if (
      observation.state !== "present" ||
      observation.sessionId !== conversation.sessionId ||
      observation.revision !== conversation.revision ||
      observation.threadId !== conversation.threadId
    ) {
      this.invalidTurnAuthority();
    }
  }

  private assertOperationCapacity(): void {
    if (this.state.operations.length >= MAX_OPERATIONS) {
      throw new CodexSubscriptionStoreError(
        "CODEX_STATE_LIMIT",
        "Codex operation history capacity is exhausted",
        false,
      );
    }
  }

  private findOperation(operationId: string): CodexSubscriptionPersistedOperation | undefined {
    return this.state.operations.find((operation) => operation.operationId === operationId);
  }

  private findConversation(binding: CodexSubscriptionWorkspaceBinding): PersistedConversation | undefined {
    return this.state.conversations.find((conversation) => sameBinding(conversation.binding, binding));
  }

  private appendTranscript(
    conversation: PersistedConversation,
    item: z.infer<typeof CodexSubscriptionTranscriptItemSchema>,
  ): void {
    if (conversation.transcript.length >= MAX_TRANSCRIPT_ITEMS) {
      const activeOperationId = conversation.latestTurn?.terminal ? undefined : conversation.latestTurn?.operationId;
      const removable = conversation.transcript.findIndex((candidate) => candidate.turnOperationId !== activeOperationId);
      if (removable < 0) {
        throw new CodexSubscriptionStoreError("CODEX_STATE_LIMIT", "Active Codex transcript is full", false);
      }
      conversation.transcript.splice(removable, 1);
      conversation.transcriptTruncated = true;
    }
    conversation.transcript.push(CodexSubscriptionTranscriptItemSchema.parse(item));
  }

  private bump(conversation: PersistedConversation, updatedAt: string): void {
    if (conversation.revision >= Number.MAX_SAFE_INTEGER) {
      throw new CodexSubscriptionStoreError("CODEX_STATE_LIMIT", "Codex conversation revision is exhausted", false);
    }
    conversation.revision += 1;
    conversation.updatedAt = updatedAt;
  }

  private async persist(): Promise<void> {
    try {
      this.compactToBound();
      const parsed = PersistedStateSchema.parse(this.state);
      await this.writeState(this.statePath, parsed, this.maxStateBytes);
      this.state = parsed;
    } catch {
      this.degradedError ??= new CodexSubscriptionStoreError(
        "CODEX_STATE_INVALID",
        "Codex durable state could not be confirmed; this host process is fenced until restart",
        false,
      );
      throw this.degradedError;
    }
  }

  private compactToBound(): void {
    for (;;) {
      const byteLength = Buffer.byteLength(`${JSON.stringify(this.state)}\n`, "utf8");
      if (byteLength <= this.maxStateBytes) return;
      let removed = false;
      for (const conversation of this.state.conversations) {
        const activeOperationId = conversation.latestTurn?.terminal ? undefined : conversation.latestTurn?.operationId;
        const index = conversation.transcript.findIndex((item) => item.turnOperationId !== activeOperationId);
        if (index >= 0) {
          conversation.transcript.splice(index, 1);
          conversation.transcriptTruncated = true;
          this.bump(conversation, this.causalTimestamp(conversation.updatedAt));
          removed = true;
          break;
        }
      }
      if (!removed) {
        throw new CodexSubscriptionStoreError(
          "CODEX_STATE_LIMIT",
          "Codex active state exceeds its durable byte limit",
          false,
        );
      }
    }
  }

  private invalidTurnAuthority(): never {
    throw new CodexSubscriptionStoreError(
      "CODEX_TURN_AUTHORITY_CHANGED",
      "Codex turn authority changed before the operation could continue",
      true,
    );
  }

  private requireInitialized(): void {
    if (this.degradedError) throw this.degradedError;
    if (!this.initialized) {
      throw new CodexSubscriptionStoreError("CODEX_STATE_INVALID", "Codex store is not initialized", true);
    }
  }

  private causalTimestamp(...causes: Array<string | undefined>): string {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) {
      throw new CodexSubscriptionStoreError("CODEX_STATE_INVALID", "Codex host clock is invalid", true);
    }
    let causalValue = value;
    for (const cause of causes) {
      if (cause === undefined) continue;
      const parsed = Date.parse(cause);
      if (!Number.isFinite(parsed)) {
        throw new CodexSubscriptionStoreError("CODEX_STATE_INVALID", "Codex causal timestamp is invalid", false);
      }
      causalValue = Math.max(causalValue, parsed);
    }
    return new Date(causalValue).toISOString();
  }

  private isoNow(): string {
    return this.causalTimestamp();
  }

  private nextIdentifier(prefix: string): string {
    const id = `${prefix}-${this.idFactory()}`;
    return IdSchema.parse(id);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function turnStartDigest(request: CodexSubscriptionTurnStartRequest): string {
  return digest({
    version: 1,
    kind: "turn_start",
    expectedBackendIncarnationId: request.expectedBackendIncarnationId,
    expectedConversation: request.expectedConversation,
    operationId: request.operationId,
    expectedHostId: request.expectedHostId,
    threadId: request.threadId,
    expectedExecutionGenerationId: request.expectedExecutionGenerationId,
    prompt: request.prompt,
  });
}

export function turnInterruptDigest(request: CodexSubscriptionTurnInterruptRequest): string {
  return digest({
    version: 1,
    kind: "turn_interrupt",
    expectedBackendIncarnationId: request.expectedBackendIncarnationId,
    sessionId: request.sessionId,
    codexThreadId: request.codexThreadId,
    operationId: request.operationId,
    expectedHostId: request.expectedHostId,
    threadId: request.threadId,
    expectedExecutionGenerationId: request.expectedExecutionGenerationId,
    expectedTurnOperationId: request.expectedTurnOperationId,
    turnId: request.turnId,
  });
}

export function accountMutationDigest(
  kind: "login" | "logout",
  expectedHostId: string,
  operationId: string,
  expectedBackendIncarnationId: string,
): string {
  return digest({ version: 1, kind, expectedHostId, operationId, expectedBackendIncarnationId });
}

function bindingFromTurnRequest(request: CodexSubscriptionTurnStartRequest): CodexSubscriptionWorkspaceBinding {
  return CodexSubscriptionWorkspaceBindingSchema.parse({
    hostId: request.expectedHostId,
    sourceThreadId: request.threadId,
    executionGenerationId: request.expectedExecutionGenerationId,
  });
}

function bindingFromInterruptRequest(
  request: CodexSubscriptionTurnInterruptRequest,
): CodexSubscriptionWorkspaceBinding {
  return CodexSubscriptionWorkspaceBindingSchema.parse({
    hostId: request.expectedHostId,
    sourceThreadId: request.threadId,
    executionGenerationId: request.expectedExecutionGenerationId,
  });
}

function isUnresolvedOperation(operation: CodexSubscriptionPersistedOperation): boolean {
  return operation.phase === "admitted" ||
    operation.phase === "dispatching" ||
    operation.phase === "active" ||
    operation.phase === "uncertain";
}

function bindingKey(binding: CodexSubscriptionWorkspaceBinding): string {
  return `${binding.hostId}\0${binding.sourceThreadId}\0${binding.executionGenerationId}`;
}

function sameBinding(
  first: CodexSubscriptionWorkspaceBinding,
  second: CodexSubscriptionWorkspaceBinding,
): boolean {
  return bindingKey(first) === bindingKey(second);
}

function nextTranscriptSequence(conversation: PersistedConversation): number {
  const last = conversation.transcript.at(-1)?.sequence ?? 0;
  if (last >= Number.MAX_SAFE_INTEGER) {
    throw new CodexSubscriptionStoreError("CODEX_STATE_LIMIT", "Codex transcript sequence is exhausted", false);
  }
  return last + 1;
}

function stableItemId(role: "user" | "assistant", operationId: string): string {
  return `${role}-${createHash("sha256").update(operationId, "utf8").digest("hex").slice(0, 48)}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function directoryName(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separator <= 0) throw new TypeError("Codex state path must have an absolute parent directory");
  return path.slice(0, separator);
}

async function readBoundedStateFile<T>(
  path: string,
  schema: z.ZodType<T>,
  maximumBytes: number,
): Promise<T | undefined> {
  let pathMetadata;
  try {
    pathMetadata = await lstat(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.nlink !== 1 ||
    pathMetadata.size <= 0 ||
    pathMetadata.size > maximumBytes
  ) {
    throw new Error("Codex subscription state is not a bounded plain file");
  }
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== pathMetadata.dev ||
      before.ino !== pathMetadata.ino ||
      before.size !== pathMetadata.size ||
      before.size > maximumBytes
    ) {
      throw new Error("Codex subscription state changed during safe open");
    }
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(bytes, position, before.size - position, position);
      if (bytesRead <= 0) throw new Error("Codex subscription state ended before its recorded size");
      position += bytesRead;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    const { bytesRead: growthBytes } = await handle.read(growthProbe, 0, 1, before.size);
    const after = await handle.stat();
    if (
      growthBytes !== 0 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error("Codex subscription state changed during bounded read");
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return schema.parse(JSON.parse(source) as unknown);
  } finally {
    await handle.close();
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}
