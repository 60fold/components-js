/// <reference lib="webworker" />

import { GridDataStore } from "@grid-benchmark/store";
import {
  buildGridViewCandidateAsync,
  type GridViewBuildProgress,
} from "@grid-benchmark/active-view";
import type { GridViewSpec } from "@grid-benchmark/types";
import type {
  BenchmarkWorkerInput,
  BenchmarkWorkerOutput,
  GridBenchmarkBuilderCancellation,
  GridBenchmarkCaseSummary,
  GridBenchmarkConfiguration,
  GridBenchmarkDataset,
  GridBenchmarkOrdinaryCaseId,
  GridBenchmarkSample,
} from "./contracts";
import { oracleVerificationScratchBytes, validateBenchmarkCandidate } from "./oracle";

const WARM_P95_MINIMUM_SAMPLES = 20;
const store = new GridDataStore();
let configuration: GridBenchmarkConfiguration | null = null;
let dataset: GridBenchmarkDataset | null = null;
let requestId = 0;
let viewRevision = 0;
let supersessionToken = 0;
let executionSequence = 0;
const supersededTokens = new Set<number>();
const cancellationSignalTiming = new Map<
  number,
  { readonly dispatchedAtEpochMs: number; readonly receivedAtEpochMs: number }
>();

self.onmessage = (event: MessageEvent<BenchmarkWorkerInput>) => {
  const message = event.data;
  if (message.type === "init") {
    initialize(message.configuration, message.dataset);
    return;
  }
  if (message.type === "supersede") {
    if (!Number.isFinite(message.dispatchedAtEpochMs)) {
      reportError(new TypeError("Cancellation dispatch timestamp must be finite."));
      return;
    }
    cancellationSignalTiming.set(message.token, {
      dispatchedAtEpochMs: message.dispatchedAtEpochMs,
      receivedAtEpochMs: epochNow(),
    });
    supersededTokens.add(message.token);
    return;
  }
  void run().catch(reportError);
};

function initialize(
  nextConfiguration: GridBenchmarkConfiguration,
  nextDataset: GridBenchmarkDataset,
): void {
  try {
    configuration = nextConfiguration;
    dataset = nextDataset;
    store.install(nextDataset.data);
    send({ type: "ready" });
  } catch (error) {
    reportError(error);
  }
}

async function run(): Promise<void> {
  const activeConfiguration = requireValue(configuration, "benchmark configuration");
  const activeDataset = requireValue(dataset, "benchmark dataset");
  const samples: GridBenchmarkSample[] = [];
  const builderCancellation: GridBenchmarkBuilderCancellation[] = [];
  const failures: string[] = [];
  const ordinaryCases = activeConfiguration.cases.filter(
    (caseId): caseId is GridBenchmarkOrdinaryCaseId =>
      caseId !== "builder-cancellation-replacement",
  );

  for (const caseId of ordinaryCases) {
    const spec = activeDataset.cases[caseId];
    for (let repetition = 0; repetition < activeConfiguration.repetitions; repetition++) {
      send({
        type: "stage",
        stage: `${activeDataset.profile.id}/${caseId}/${repetition + 1}`,
      });
      const sample = await measureBuild(
        caseId,
        spec,
        repetition,
        activeConfiguration,
        activeDataset,
      );
      samples.push(sample);
      if (!sample.oracle.passed) {
        failures.push(
          `${caseId}/${repetition + 1}: independent oracle failed: ${sample.oracle.firstFailure ?? "unknown mismatch"}`,
        );
      }
    }
  }

  if (activeConfiguration.cases.includes("builder-cancellation-replacement")) {
    send({
      type: "stage",
      stage: `${activeDataset.profile.id}/builder-cancellation-replacement`,
    });
    const reference = samples.find((sample) => sample.caseId === "filter-numeric");
    if (!reference) {
      throw new Error(
        "builder-cancellation-replacement requires filter-numeric for its independent reference hash/count.",
      );
    }
    const result = await measureBuilderCancellation(
      activeDataset.cases["sort-1-key"],
      activeDataset.cases["filter-numeric"],
      activeConfiguration,
      activeDataset,
      reference,
    );
    builderCancellation.push(result);
    if (!result.replacementHashMatchesReference) {
      failures.push("builder cancellation: replacement hash differs from reference.");
    }
    if (!result.replacementRowCountMatchesReference) {
      failures.push("builder cancellation: replacement row count differs from reference.");
    }
    if (!result.replacementOracle.passed) {
      failures.push(
        `builder cancellation: replacement oracle failed: ${result.replacementOracle.firstFailure ?? "unknown mismatch"}`,
      );
    }
  }

  const fullHashesMatchAcrossRepetitions = compareHashes(samples);
  if (!fullHashesMatchAcrossRepetitions) {
    failures.push("One or more case full-result hashes changed across repetitions.");
  }
  const independentOraclePassed = samples.every((sample) => sample.oracle.passed);
  const replacementChecksPassed = builderCancellation.every(
    (entry) =>
      entry.replacementHashMatchesReference &&
      entry.replacementRowCountMatchesReference &&
      entry.replacementOracle.passed,
  );
  const exactResultValidationPassed =
    fullHashesMatchAcrossRepetitions && independentOraclePassed && replacementChecksPassed;

  const summaries = summarize(samples);
  send({
    type: "complete",
    result: {
      profile: activeDataset.profile,
      samples,
      builderCancellation,
      summaries,
      correctness: {
        fullHashesMatchAcrossRepetitions,
        independentOraclePassed,
        replacementChecksPassed,
        exactResultValidationPassed,
      },
      failures,
    },
  });
}

async function measureBuild(
  caseId: GridBenchmarkOrdinaryCaseId,
  spec: GridViewSpec,
  repetition: number,
  activeConfiguration: GridBenchmarkConfiguration,
  activeDataset: GridBenchmarkDataset,
): Promise<GridBenchmarkSample> {
  let progressEvents = 0;
  let lastProgress: GridViewBuildProgress | null = null;
  const startedAt = performance.now();
  const result = await buildGridViewCandidateAsync(store, spec, {
    requestId: ++requestId,
    viewRevision: ++viewRevision,
    chunkSize: activeConfiguration.chunkSize,
    onProgress: (progress) => {
      progressEvents++;
      lastProgress = progress;
    },
  });
  const builderInvocationDurationMs = performance.now() - startedAt;
  if (result.status !== "complete") throw new Error(`${caseId} cancelled unexpectedly.`);

  const verificationStartedAt = performance.now();
  const fullResultHash = hashCandidate(
    result.candidate.physicalRows,
    result.candidate.filterBitmap,
  );
  const oracle = validateBenchmarkCandidate(activeDataset.profile, caseId, result.candidate);
  const verificationDurationMs = performance.now() - verificationStartedAt;
  return {
    caseId,
    repetition,
    temperature: repetition === 0 ? "first" : "warm",
    executionSequence: ++executionSequence,
    builderInvocationDurationMs,
    verificationDurationMs,
    rowCount: result.candidate.rowCount,
    fullResultHash,
    fullResultHashAlgorithm: "fnv1a32-pair-v1",
    oracle,
    buffers: bufferLedger(
      caseId,
      activeDataset.profile,
      result.candidate.physicalRows,
      result.candidate.filterBitmap,
    ),
    progressEvents,
    lastProgress,
  };
}

async function measureBuilderCancellation(
  obsoleteSpec: GridViewSpec,
  replacementSpec: GridViewSpec,
  activeConfiguration: GridBenchmarkConfiguration,
  activeDataset: GridBenchmarkDataset,
  reference: GridBenchmarkSample,
): Promise<GridBenchmarkBuilderCancellation> {
  const token = ++supersessionToken;
  supersededTokens.delete(token);
  cancellationSignalTiming.delete(token);
  const startedAt = performance.now();
  const startedAtEpochMs = epochNow();
  const requiredCompleted = Math.min(activeConfiguration.chunkSize, store.rowCount);
  let sortProgressAtSignalRequest:
    GridBenchmarkBuilderCancellation["sortProgressAtSignalRequest"] | null = null;
  let progressSignalAtEpochMs: number | null = null;
  const obsolete = await buildGridViewCandidateAsync(store, obsoleteSpec, {
    requestId: ++requestId,
    viewRevision: ++viewRevision,
    chunkSize: activeConfiguration.chunkSize,
    shouldCancel: () => supersededTokens.has(token),
    onProgress: (progress) => {
      if (
        sortProgressAtSignalRequest ||
        progress.phase !== "sort" ||
        progress.completed < requiredCompleted
      ) {
        return;
      }
      progressSignalAtEpochMs = epochNow();
      sortProgressAtSignalRequest = {
        phase: "sort",
        completed: progress.completed,
        total: progress.total,
        requiredCompleted,
        observedAfterBuilderStartMs: progressSignalAtEpochMs - startedAtEpochMs,
      };
      send({
        type: "builder-cancellation-armed",
        token,
        delayMs: activeConfiguration.cancellationDelayMs,
        sortProgress: {
          phase: "sort",
          completed: progress.completed,
          total: progress.total,
          requiredCompleted,
        },
      });
    },
  });
  const obsoleteBuilderInvocationDurationMs = performance.now() - startedAt;
  const builderCancelledAtEpochMs = epochNow();
  const signalTiming = cancellationSignalTiming.get(token) ?? null;
  supersededTokens.delete(token);
  cancellationSignalTiming.delete(token);
  if (obsolete.status !== "cancelled") {
    throw new Error(
      `Builder request ${token} completed before a post-sort-chunk cancellation was observed.`,
    );
  }
  if (!sortProgressAtSignalRequest || progressSignalAtEpochMs === null) {
    throw new Error(
      `Builder request ${token} cancelled before the sort progress trigger was armed.`,
    );
  }
  if (!signalTiming) {
    throw new Error(`Builder request ${token} cancelled without supersede-message timing.`);
  }

  const replacementStartedAt = performance.now();
  const replacement = await buildGridViewCandidateAsync(store, replacementSpec, {
    requestId: ++requestId,
    viewRevision: ++viewRevision,
    chunkSize: activeConfiguration.chunkSize,
  });
  const replacementBuilderInvocationDurationMs = performance.now() - replacementStartedAt;
  if (replacement.status !== "complete") throw new Error("Replacement build was cancelled.");
  const replacementFullResultHash = hashCandidate(
    replacement.candidate.physicalRows,
    replacement.candidate.filterBitmap,
  );
  const replacementOracle = validateBenchmarkCandidate(
    activeDataset.profile,
    "filter-numeric",
    replacement.candidate,
  );
  return {
    scope: "active-view-builder-only",
    trigger: "worker-message-after-sort-progress-chunk",
    configuredCancellationDelayMs: activeConfiguration.cancellationDelayMs,
    sortProgressAtSignalRequest,
    progressSignalToCancellationDispatchMs:
      signalTiming.dispatchedAtEpochMs - progressSignalAtEpochMs,
    cancellationDispatchToWorkerReceiptMs:
      signalTiming.receivedAtEpochMs - signalTiming.dispatchedAtEpochMs,
    cancellationReceiptToBuilderCancellationMs:
      builderCancelledAtEpochMs - signalTiming.receivedAtEpochMs,
    cancellationDispatchToBuilderCancellationMs:
      builderCancelledAtEpochMs - signalTiming.dispatchedAtEpochMs,
    obsoleteBuilderResultStatus: "cancelled",
    obsoleteBuilderInvocationDurationMs,
    hostPublicationAttempted: false,
    replacementBuilderInvocationDurationMs,
    replacementFullResultHash,
    replacementRows: replacement.candidate.rowCount,
    referenceFullResultHash: reference.fullResultHash,
    referenceRows: reference.rowCount,
    replacementHashMatchesReference: replacementFullResultHash === reference.fullResultHash,
    replacementRowCountMatchesReference: replacement.candidate.rowCount === reference.rowCount,
    replacementOracle,
  };
}

function compareHashes(samples: readonly GridBenchmarkSample[]): boolean {
  const byCase = new Map<string, Set<string>>();
  for (const sample of samples) {
    let repeated = byCase.get(sample.caseId);
    if (!repeated) byCase.set(sample.caseId, (repeated = new Set()));
    repeated.add(sample.fullResultHash);
  }
  return [...byCase.values()].every((hashes) => hashes.size === 1);
}

function summarize(samples: readonly GridBenchmarkSample[]): GridBenchmarkCaseSummary[] {
  const grouped = new Map<string, GridBenchmarkSample[]>();
  for (const sample of samples) {
    const key = sample.caseId;
    let entries = grouped.get(key);
    if (!entries) grouped.set(key, (entries = []));
    entries.push(sample);
  }
  return [...grouped.values()].map((entries) => {
    const first = entries.find((entry) => entry.temperature === "first")!;
    const warmMs = entries
      .filter((entry) => entry.temperature === "warm")
      .map((entry) => entry.builderInvocationDurationMs);
    const orderedWarm = [...warmMs].sort((left, right) => left - right);
    return {
      caseId: first.caseId,
      samples: entries.length,
      firstMs: first.builderInvocationDurationMs,
      warmMs,
      warmSampleCount: warmMs.length,
      warmMinMs: orderedWarm[0] ?? null,
      warmMedianMs: orderedWarm.length > 0 ? percentile(orderedWarm, 0.5) : null,
      warmP95Ms:
        orderedWarm.length >= WARM_P95_MINIMUM_SAMPLES ? percentile(orderedWarm, 0.95) : null,
      warmP95MinimumSamples: WARM_P95_MINIMUM_SAMPLES,
      warmMaxMs: orderedWarm.at(-1) ?? null,
      fullResultHash: first.fullResultHash,
      rowCount: first.rowCount,
    };
  });
}

function bufferLedger(
  caseId: GridBenchmarkOrdinaryCaseId,
  profile: GridBenchmarkDataset["profile"],
  rows: Uint32Array,
  bitmap: Uint8Array | null,
): GridBenchmarkSample["buffers"] {
  const publishedPhysicalRowsBytes = rows.byteLength;
  const publishedFilterBitmapBytes = bitmap?.byteLength ?? 0;
  const components: Record<string, number> = {};
  if (caseId === "sort-1-key" || caseId === "filter-sort-3-key-25pct") {
    components.sortPermutationScratch = rows.byteLength;
  }
  const knownBuilderScratchPeakBytesLowerBound = Object.values(components).reduce(
    (sum, bytes) => sum + bytes,
    0,
  );
  return {
    publishedPhysicalRowsBytes,
    publishedFilterBitmapBytes,
    publishedCandidateBytes: publishedPhysicalRowsBytes + publishedFilterBitmapBytes,
    knownBuilderScratchPeakBytesLowerBound,
    knownBuilderScratchComponents: components,
    oracleVerificationScratchBytes: oracleVerificationScratchBytes(profile),
    caveat:
      "The ledger counts typed arrays derivable from this exact source tree. It excludes engine objects, allocator capacity, callback state, and unproven hybrid-path scratch; it is a lower bound, not peak process memory.",
  };
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function hashCandidate(rows: Uint32Array, bitmap: Uint8Array | null): string {
  let low = 0x811c9dc5;
  let high = 0x9e3779b9;
  const absorb = (value: number): void => {
    low = Math.imul(low ^ value, 0x01000193) >>> 0;
    high = Math.imul(high ^ (value >>> 16) ^ value, 0x85ebca6b) >>> 0;
  };
  absorb(rows.length);
  for (let index = 0; index < rows.length; index++) absorb(rows[index]!);
  if (bitmap) {
    absorb(bitmap.length);
    for (let index = 0; index < bitmap.length; index++) absorb(bitmap[index]!);
  } else {
    absorb(0xffff_ffff);
  }
  return `${low.toString(16).padStart(8, "0")}${high.toString(16).padStart(8, "0")}`;
}

function send(message: BenchmarkWorkerOutput): void {
  self.postMessage(message);
}

function reportError(error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  send({
    type: "error",
    message: normalized.message,
    ...(normalized.stack ? { stack: normalized.stack } : {}),
  });
}

function requireValue<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Missing ${label}.`);
  return value;
}

function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

export {};
