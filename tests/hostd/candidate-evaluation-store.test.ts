import { link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CandidateEvaluationStore,
  isEvaluationBarrier,
} from "../../src/hostd/candidate-evaluation-store";
import { getHostDataPaths } from "../../src/hostd/paths";
import type { CandidateEvaluationStartRequest } from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];
const firstTime = "2026-08-09T12:00:00.000Z";
const secondTime = "2026-08-09T12:00:01.000Z";
const thirdTime = "2026-08-09T12:00:02.000Z";
const firstRunId = "11111111-1111-4111-8111-111111111111";
const secondRunId = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("CandidateEvaluationStore", () => {
  it("serializes the single active operation and hashes renderer IDs before filenames", async () => {
    const { store, paths } = await temporaryStore();
    const [left, right] = await Promise.allSettled([
      store.prepare(request("operation:one"), "C:\\physical\\repo", firstRunId, firstTime),
      store.prepare(request("operation:two"), "C:\\physical\\repo", secondRunId, firstTime),
    ]);
    expect([left.status, right.status].sort()).toEqual(["fulfilled", "rejected"]);
    const records = await store.list();
    expect(records).toHaveLength(1);
    const names = await readdir(paths.candidateEvaluationOperations);
    expect(names).toEqual([expect.stringMatching(/^[a-f0-9]{64}\.json$/)]);
    expect(names[0]).not.toContain(records[0]!.request.operationId);
  });

  it("keeps an uncertain invocation as a barrier until exact retirement is durable", async () => {
    const { store } = await temporaryStore();
    const prepared = (await store.prepare(request("operation:one"), "C:\\physical\\repo", firstRunId, firstTime)).record;
    const running = await store.markInvocationStarted(prepared, firstRunId, firstTime, "2026-08-09T14:15:00.000Z");
    const published = await store.markOuterProcess(running, 4123, secondTime, "windows_job");
    const uncertain = await store.settle(published, "uncertain", thirdTime, {
      error: {
        code: "EVALUATION_OUTCOME_UNKNOWN",
        message: "The exact invocation has no settled receipt",
        retryable: false,
      },
    });
    expect(isEvaluationBarrier(uncertain)).toBe(true);
    await expect(
      store.prepare(request("operation:two", thirdTime), "C:\\physical\\repo", secondRunId, thirdTime),
    ).rejects.toMatchObject({ code: "EVALUATION_ID_CONFLICT" });

    const retired = await store.markInvocationRetired(
      uncertain,
      "tree_retired",
      "2026-08-09T12:00:03.000Z",
    );
    expect(isEvaluationBarrier(retired)).toBe(false);
    await expect(
      store.prepare(
        request("operation:two", "2026-08-09T12:00:03.000Z"),
        "C:\\physical\\repo",
        secondRunId,
        "2026-08-09T12:00:03.000Z",
      ),
    ).resolves.toMatchObject({ created: true });
  });

  it("publishes a digest-bound immutable outer receipt before terminal status", async () => {
    const { store, paths } = await temporaryStore();
    const prepared = (await store.prepare(request("operation:receipt"), "C:\\physical\\repo", firstRunId, firstTime)).record;
    const running = await store.markInvocationStarted(prepared, firstRunId, firstTime, "2026-08-09T14:15:00.000Z");
    const terminal = await store.settle(running, "failed", secondTime, {
      receipt: {
        receiptVersion: 1,
        kind: "prime_continuim_candidate_evaluation_evidence",
        selfBuildRunId: firstRunId,
        selfBuildReceiptSha256: "a".repeat(64),
        outcome: "failed",
        settledGateCount: 0,
        gateCount: 6,
        completedAt: secondTime,
        boundary: boundary(),
      },
      error: { code: "EVALUATION_FAILED", message: "A canonical gate failed", retryable: true },
      candidate: candidate(),
      selfBuildEnvelope: { bounded: true },
    });
    expect(terminal.status.status).toBe("failed");
    const receiptNames = await readdir(paths.candidateEvaluationReceipts);
    expect(receiptNames).toHaveLength(1);
    const receiptPath = join(paths.candidateEvaluationReceipts, receiptNames[0]!);
    const envelope = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      integrity: "sha256-correlation-only-not-authentication",
      receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    await expect(new CandidateEvaluationStore(paths).initialize()).resolves.toBeUndefined();
    await writeFile(receiptPath, `${JSON.stringify({ ...envelope, receiptSha256: "0".repeat(64) })}\n`);
    await expect(new CandidateEvaluationStore(paths).initialize()).rejects.toThrow(/digest|state/i);
  });

  it("recovers only exact bounded pre-link and post-link atomic temp siblings", async () => {
    const { store, paths } = await temporaryStore();
    await store.prepare(request("temp-recovery"), "C:\\physical\\repo", firstRunId, firstTime);
    const [targetName] = await readdir(paths.candidateEvaluationOperations);
    const targetPath = join(paths.candidateEvaluationOperations, targetName!);
    const body = await readFile(targetPath);

    const unpublished = join(paths.candidateEvaluationOperations, `${targetName}.tmp-123-${"a".repeat(16)}`);
    await writeFile(unpublished, body);
    await expect(new CandidateEvaluationStore(paths).initialize()).resolves.toBeUndefined();
    expect(await readdir(paths.candidateEvaluationOperations)).toEqual([targetName]);

    const publishedSibling = join(paths.candidateEvaluationOperations, `${targetName}.tmp-124-${"b".repeat(16)}`);
    await link(targetPath, publishedSibling);
    await expect(new CandidateEvaluationStore(paths).initialize()).resolves.toBeUndefined();
    expect(await readdir(paths.candidateEvaluationOperations)).toEqual([targetName]);
  });
});

async function temporaryStore() {
  const directory = await mkdtemp(join(tmpdir(), "prime-candidate-evaluation-store-"));
  temporaryDirectories.push(directory);
  const paths = getHostDataPaths(directory);
  const store = new CandidateEvaluationStore(paths);
  await store.initialize();
  return { store, paths };
}

function request(operationId: string, requestedAt = firstTime): CandidateEvaluationStartRequest {
  return {
    expectedHostId: "host-local",
    threadId: "thread-one",
    expectedExecutionGenerationId: "generation-one",
    operationId,
    requestedAt,
    kind: "prime_continuim_self_build_v1",
    expectedReview: {
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
    },
  };
}

function candidate() {
  return {
    headCommit: "a".repeat(40),
    dirty: false,
    statusPorcelainV2Sha256: "b".repeat(64),
    statusBytes: 0,
    binaryPatchSha256: "c".repeat(64),
    binaryPatchBytes: 0,
    untrackedManifestSha256: "d".repeat(64),
    untrackedFileCount: 0,
    untrackedBytes: 0,
    treeSha256: "e".repeat(64),
    treeFileCount: 10,
    treeBytes: 100,
  } as const;
}

function boundary() {
  return {
    securitySandbox: false,
    mainFilesystemIsolation: false,
    providerBackedEvaluation: false,
    autonomousPromotion: false,
    candidateControlledEvaluation: true,
    packageOrInstallerGate: false,
    authenticated: false,
    integrity: "sha256-correlation-only-not-authentication" as const,
  } as const;
}
