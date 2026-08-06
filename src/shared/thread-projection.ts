import {
  IsoDateTimeSchema,
  ThreadProjectionDeltaSchema,
  type ThreadProjectionDelta,
  type ThreadProjectionSnapshot,
} from "./protocol";

const MAX_TRANSCRIPT_INDEX_ENTRIES = 20_000;
const MAX_MATERIALIZED_BLOCKS = 2_000;
const MAX_ATTENTION_EVENTS = 1_000;

export class ProjectionDeltaError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectionDeltaError";
    this.code = code;
  }
}

/**
 * Applies one generation-fenced, contiguous host delta. Duplicate/stale
 * sequences are idempotent; gaps fail closed so the caller can request an
 * authoritative snapshot instead of guessing.
 */
export function applyThreadProjectionDelta(
  snapshotValue: ThreadProjectionSnapshot,
  deltaValue: ThreadProjectionDelta,
  emittedAtValue: string,
): ThreadProjectionSnapshot {
  const snapshot = snapshotValue;
  const delta = ThreadProjectionDeltaSchema.parse(deltaValue);
  const emittedAt = IsoDateTimeSchema.parse(emittedAtValue);
  assertDeltaAuthority(snapshot, delta);

  const currentSequence = snapshot.latestCursor.sequence;
  if (delta.cursor.sequence <= currentSequence) return snapshot;
  if (delta.cursor.sequence !== currentSequence + 1) {
    throw new ProjectionDeltaError(
      "PROJECTION_SEQUENCE_GAP",
      `Expected projection sequence ${currentSequence + 1}, received ${delta.cursor.sequence}`,
    );
  }

  const thread = {
    ...snapshot.thread,
    updatedAt: emittedAt,
    lastKnownCursor: delta.cursor,
  };
  const base = {
    ...snapshot,
    generatedAt: emittedAt,
    thread,
    latestCursor: delta.cursor,
  };

  switch (delta.kind) {
    case "transcript.append": {
      const alreadyIndexed = snapshot.transcriptBlockIndex.some((entry) => entry.blockId === delta.block.blockId);
      const alreadyMaterialized = snapshot.materializedRecentBlocks.some((block) => block.blockId === delta.block.blockId);
      return {
        ...base,
        transcriptBlockIndex: alreadyIndexed
          ? snapshot.transcriptBlockIndex
          : [
              ...snapshot.transcriptBlockIndex,
              {
                blockId: delta.block.blockId,
                kind: delta.block.kind,
                sequence: delta.block.sequence,
                byteLength: new TextEncoder().encode(delta.block.text).byteLength,
                materialized: true,
              },
            ].slice(-MAX_TRANSCRIPT_INDEX_ENTRIES),
        materializedRecentBlocks: alreadyMaterialized
          ? snapshot.materializedRecentBlocks
          : [...snapshot.materializedRecentBlocks, delta.block].slice(-MAX_MATERIALIZED_BLOCKS),
      };
    }
    case "transcript.stream": {
      const { inProgressStream: _previousStream, ...withoutStream } = base;
      return {
        ...withoutStream,
        ...(delta.stream ? { inProgressStream: delta.stream } : {}),
      };
    }
    case "runtime.replace": {
      const nextThread = { ...thread, status: delta.threadStatus };
      if (delta.recap === null) delete nextThread.recap;
      else if (delta.recap !== undefined) nextThread.recap = delta.recap;
      return {
        ...base,
        thread: nextThread,
        runtime: delta.runtime,
        queueState: delta.queueState,
        childAgents: delta.childAgents,
        goals: delta.goals,
        schedules: delta.schedules,
      };
    }
    case "attention.append": {
      const withoutDuplicate = snapshot.pendingAttention.filter(
        (attention) => attention.attentionId !== delta.attention.attentionId,
      );
      return {
        ...base,
        pendingAttention: [...withoutDuplicate, delta.attention].slice(-MAX_ATTENTION_EVENTS),
      };
    }
  }
}

function assertDeltaAuthority(snapshot: ThreadProjectionSnapshot, delta: ThreadProjectionDelta): void {
  if (delta.cursor.threadId !== snapshot.thread.threadId) {
    throw new ProjectionDeltaError("PROJECTION_THREAD_MISMATCH", "Projection delta belongs to another thread");
  }
  if (delta.cursor.executionGenerationId !== snapshot.thread.currentLocation.executionGenerationId) {
    throw new ProjectionDeltaError(
      "PROJECTION_EXECUTION_GENERATION_MISMATCH",
      "Projection delta belongs to another execution generation",
    );
  }
  if (delta.cursor.generation !== snapshot.latestCursor.generation) {
    throw new ProjectionDeltaError(
      "PROJECTION_EVENT_GENERATION_MISMATCH",
      "Projection delta belongs to another daemon event generation",
    );
  }
}
