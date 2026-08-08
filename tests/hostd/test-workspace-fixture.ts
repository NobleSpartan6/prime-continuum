import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  SNAPSHOT_VERSION,
  type SavedProject,
  type ThreadProjectionSnapshot,
  type ThreadSummary,
} from "../../src/shared/protocol";
import { HostStore, type WorkspaceThreadBootstrapStatus } from "../../src/hostd/store";

export const TEST_PROJECT_ID = "test-project";
export const TEST_WORKSPACE_ID = "test-workspace";
export const TEST_THREAD_ID = "test-thread";
export const TEST_EXECUTION_GENERATION_ID = "test-execution-1";
export const TEST_PROJECTION_GENERATION = "test-projection-1";

export interface TestWorkspaceFixtureOptions {
  operationId?: string;
  projectId?: string;
  workspaceId?: string;
  threadId?: string;
  executionGenerationId?: string;
  projectionGeneration?: string;
  workspaceDirectory?: string;
  createdAt?: string;
  projectDisplayName?: string;
  threadTitle?: string;
}

export interface TestWorkspaceFixture {
  hostId: string;
  workspaceDirectory: string;
  project: SavedProject;
  thread: ThreadSummary;
  projection: ThreadProjectionSnapshot;
  status: WorkspaceThreadBootstrapStatus;
}

/**
 * Creates test catalog state through the production workspace bootstrap
 * transaction. The transcript is deliberately empty: tests opt into only the
 * real authority they need and never inherit manufactured agent output.
 */
export async function bootstrapTestWorkspace(
  store: HostStore,
  options: TestWorkspaceFixtureOptions = {},
): Promise<TestWorkspaceFixture> {
  const host = await store.getHost();
  const operationId = options.operationId ?? "test-workspace-bootstrap";
  const projectId = options.projectId ?? TEST_PROJECT_ID;
  const workspaceId = options.workspaceId ?? TEST_WORKSPACE_ID;
  const threadId = options.threadId ?? TEST_THREAD_ID;
  const executionGenerationId = options.executionGenerationId ?? TEST_EXECUTION_GENERATION_ID;
  const projectionGeneration = options.projectionGeneration ?? TEST_PROJECTION_GENERATION;
  const createdAt = options.createdAt ?? "2026-08-08T12:00:00.000Z";

  let workspaceDirectory = options.workspaceDirectory;
  if (!workspaceDirectory) {
    const workspacePath = join(store.paths.root, "test-workspaces", operationId);
    await mkdir(workspacePath, { recursive: true });
    workspaceDirectory = await realpath(workspacePath);
  }

  const project: SavedProject = {
    projectId,
    hostId: host.hostId,
    workspaceId,
    displayName: options.projectDisplayName ?? "Test workspace",
    lastOpenedAt: createdAt,
  };
  const cursor = {
    threadId,
    executionGenerationId,
    generation: projectionGeneration,
    sequence: 0,
  };
  const thread: ThreadSummary = {
    threadId,
    title: options.threadTitle ?? "Test thread",
    projectIdentity: projectId,
    currentLocation: {
      hostId: host.hostId,
      projectId,
      workspaceId,
      executionGenerationId,
    },
    status: "idle",
    unread: false,
    updatedAt: createdAt,
    lastKnownCursor: cursor,
  };
  const projection: ThreadProjectionSnapshot = {
    snapshotVersion: SNAPSHOT_VERSION,
    generatedAt: createdAt,
    thread,
    transcriptBlockIndex: [],
    materializedRecentBlocks: [],
    queueState: { pendingCommandIds: [], paused: false },
    approvals: [],
    childAgents: [],
    goals: [],
    schedules: [],
    git: { stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
    evidence: { testsPassed: 0, testsFailed: 0, artifactCount: 0 },
    pendingAttention: [],
    latestCursor: cursor,
  };
  const requestDigest = createHash("sha256")
    .update(JSON.stringify({ projectId, workspaceId, threadId, executionGenerationId, workspaceDirectory }))
    .digest("hex");
  const status = await store.bootstrapWorkspaceThread({
    operationId,
    requestDigest,
    expectedHostId: host.hostId,
    project,
    thread,
    initialProjection: projection,
    workspaceDirectory,
  });

  return { hostId: host.hostId, workspaceDirectory, project, thread, projection, status };
}
