import { describe, expect, it } from "vitest";
import {
  CandidateEvaluationPreflightSchema,
  CandidateEvaluationSnapshotSchema,
  CandidateEvaluationStatusSchema,
  HostIpcRequestSchema,
  PROTOCOL_VERSION,
} from "../../src/shared/protocol";

const authority = {
  expectedHostId: "host-local",
  threadId: "thread-1",
  expectedExecutionGenerationId: "generation-1",
};
const review = {
  headCommit: "a".repeat(40),
  gitIndexSha256: "b".repeat(64),
  gitIndexBytes: 100,
  packageManifestSha256: "c".repeat(64),
  lockfileSha256: "d".repeat(64),
  lockfileBytes: 100,
  nodeVersionPinSha256: "e".repeat(64),
  selfBuildEntrypointSha256: "f".repeat(64),
  launcherBootstrapSha256: "1".repeat(64),
  launcherBootstrapFileCount: 9,
  runtimePointerSha256: "2".repeat(64),
  nodePackageManifestSha256: "3".repeat(64),
  nodeExecutableSha256: "4".repeat(64),
  pnpmCliSha256: "5".repeat(64),
  reviewAggregateSha256: "6".repeat(64),
};
const boundary = {
  securitySandbox: false,
  mainFilesystemIsolation: false,
  providerBackedEvaluation: false,
  autonomousPromotion: false,
  candidateControlledEvaluation: true,
  packageOrInstallerGate: false,
  authenticated: false,
  integrity: "sha256-correlation-only-not-authentication" as const,
};
const requestedAt = "2026-08-09T12:00:00.000Z";

function running(operationId = "evaluation:1") {
  return {
    statusVersion: 1 as const,
    ...authority,
    operationId,
    kind: "prime_continuim_self_build_v1" as const,
    requestedAt,
    updatedAt: requestedAt,
    status: "running" as const,
    review,
    invocationStartedAt: requestedAt,
    boundary,
  };
}

describe("candidate evaluation protocol", () => {
  it("admits only path-free authority-bound requests", () => {
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "candidate-start-1",
      method: "candidate.evaluation.start",
      payload: {
        ...authority,
        operationId: "candidate:operation:1",
        requestedAt,
        kind: "prime_continuim_self_build_v1",
        expectedReview: review,
      },
    } as const;
    expect(HostIpcRequestSchema.parse(request)).toEqual(request);
    expect(HostIpcRequestSchema.safeParse({
      ...request,
      payload: { ...request.payload, workspacePath: "C:\\private\\repo" },
    }).success).toBe(false);
  });

  it("names containment only at the six supervised gates", () => {
    const preflight = {
      preflightVersion: 1,
      ...authority,
      observedAt: requestedAt,
      boundary,
      status: "ready",
      capability: "prime_continuim_self_build_evaluation_v1",
      review,
      executor: {
        kind: "canonical_self_build",
        gateProcessContainment: "windows_job",
        requiredNodeVersion: "24.14.0",
        requiredPnpmVersion: "11.9.0",
        verification: "passive-structure-before-consent;canonical-toolchain-inside-evaluation",
        launcherSource: "workspace-dependency-tree-candidate-controlled",
      },
    } as const;
    expect(CandidateEvaluationPreflightSchema.parse(preflight)).toEqual(preflight);
    expect(CandidateEvaluationPreflightSchema.safeParse({
      ...preflight,
      executor: { ...preflight.executor, processContainment: "windows_job" },
    }).success).toBe(false);
  });

  it("rejects contradictory or path-bearing public status evidence", () => {
    expect(CandidateEvaluationStatusSchema.parse(running()).status).toBe("running");
    expect(CandidateEvaluationStatusSchema.safeParse({
      ...running(),
      error: { code: "EVALUATION_FAILED", message: "failed", retryable: true },
    }).success).toBe(false);
    expect(CandidateEvaluationStatusSchema.safeParse({
      ...running(),
      status: "uncertain",
      completedAt: requestedAt,
      error: {
        code: "EVALUATION_OUTCOME_UNKNOWN",
        message: "unknown",
        retryable: false,
        details: { path: "C:\\private" },
      },
    }).success).toBe(false);
  });

  it("binds every snapshot member to one authority and unique operation", () => {
    const snapshot = {
      snapshotVersion: 1,
      ...authority,
      generatedAt: requestedAt,
      repeatEffectsWarningRequired: false,
      evaluations: [running("one"), running("two")],
    } as const;
    expect(CandidateEvaluationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(CandidateEvaluationSnapshotSchema.safeParse({
      ...snapshot,
      evaluations: [running("one"), { ...running("one"), threadId: "other-thread" }],
    }).success).toBe(false);
  });
});
