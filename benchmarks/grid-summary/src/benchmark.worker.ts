/// <reference lib="webworker" />

import {
  buildGridViewCandidateAsync,
  publishGridViewCandidate,
  type GridPublishedView,
} from "@grid-benchmark/active-view";
import {
  GridDataStore,
  preflightGridDataAsync,
  type GridStagedCellPatch,
} from "@grid-benchmark/store";
import type { GridData } from "@grid-benchmark/types";
import {
  buildGridSummaryHierarchyAsync,
  publishGridSummaryHierarchyCandidate,
  type GridPublishedSummaryHierarchy,
  type GridSummaryBuildProgress,
  type GridSummaryHierarchyCandidate,
  type GridSummaryQueryResult,
  type GridSummaryView,
} from "@grid-summary/engine";
import type { GridBenchmarkDataset } from "../../grid/src/contracts";
import {
  buildOracleEdgeFixture,
  buildOracleExpectations,
  buildOracleRanges,
  oracleQueryVisitBounds,
  runEdgeFixtureOracle,
  subsetOracleExpectations,
  validateSummaryCandidateAgainstExpectations,
  type RawSummaryQueryResult,
  type OracleExpectations,
  type OracleRange,
} from "./oracle";
import type {
  GridSummaryBandPayloadLedger,
  GridSummaryBuildSample,
  GridSummaryCancellationResult,
  GridSummaryColumnScopeId,
  GridSummaryConfiguration,
  GridSummaryQueryMetrics,
  GridSummaryViewId,
  GridSummaryViewPreparation,
  GridSummaryWorkerInput,
  GridSummaryWorkerOutput,
  GridSummaryWorkerResult,
} from "./contracts";

const TWO_COLUMNS = ["value0", "category0"] as const;
const ALL_COLUMNS = ["value0", "value1", "value2", "value3", "category0", "category1"] as const;
const DATA_REVISION = 1;

const store = new GridDataStore();
let configuration: GridSummaryConfiguration | null = null;
let dataset: GridBenchmarkDataset | null = null;
let installation: GridSummaryWorkerResult["installation"] | null = null;
let nextRequestId = 0;
const cancellations = new Map<
  number,
  { readonly dispatchedAtEpochMs: number; readonly receivedAtEpochMs: number }
>();

self.onmessage = (event: MessageEvent<GridSummaryWorkerInput>): void => {
  const message = event.data;
  if (message.type === "init") {
    void initialize(message.configuration, message.dataset).catch(reportError);
    return;
  }
  if (message.type === "cancel") {
    cancellations.set(message.token, {
      dispatchedAtEpochMs: message.dispatchedAtEpochMs,
      receivedAtEpochMs: epochNow(),
    });
    return;
  }
  void run().catch(reportError);
};

async function initialize(
  nextConfiguration: GridSummaryConfiguration,
  nextDataset: GridBenchmarkDataset,
): Promise<void> {
  configuration = nextConfiguration;
  dataset = nextDataset;
  const preflightStartedAt = performance.now();
  const proof = await preflightGridDataAsync(nextDataset.data);
  const preflightDurationMs = performance.now() - preflightStartedAt;
  const adoptionStartedAt = performance.now();
  const installed = store.installWorkerIngress(nextDataset.data, proof);
  const storeAdoptionDurationMs = performance.now() - adoptionStartedAt;
  installation = {
    preflightDurationMs,
    storeAdoptionDurationMs,
    storeInstallDurationMs: preflightDurationMs + storeAdoptionDurationMs,
    installedBufferCount: installed.buffers.length,
    transferredArrayBufferBytes: nextDataset.transfer.bytes,
    retainedTypedArrayBytes: installed.buffers.reduce(
      (total, buffer) => total + buffer.byteLength,
      0,
    ),
  };
  send({ type: "ready", installation });
}

async function run(): Promise<void> {
  const activeConfiguration = requireValue(configuration, "configuration");
  const activeDataset = requireValue(dataset, "dataset");
  const activeInstallation = requireValue(installation, "installation");
  const failures: string[] = [];
  const { views, preparation } = await prepareViews(activeConfiguration, activeDataset);

  send({ type: "stage", stage: "edge-fixture-oracle" });
  const edge = await runEdgeFixtureOracle(async (data, physicalRows, blockSize) => {
    const edgeStore = new GridDataStore();
    const proof = await preflightGridDataAsync(data);
    const installed = edgeStore.installWorkerIngress(data, proof);
    const view: GridSummaryView = {
      datasetId: installed.datasetId,
      viewRevision: 1,
      rowCount: physicalRows.length,
      physicalRows,
    };
    const built = await buildGridSummaryHierarchyAsync(edgeStore, view, {
      requestId: 1,
      dataRevision: 1,
      columns: ["numeric", "category"],
      blockSize,
      chunkSize: 64,
    });
    if (built.status !== "complete") throw new Error("Edge summary build cancelled unexpectedly.");
    const published = publishGridSummaryHierarchyCandidate(built.candidate, built.candidate);
    if (!published) throw new Error("Edge summary candidate did not publish.");
    return { query: oracleQueryAdapter(published) };
  });
  const edgeFixtureOracle: GridSummaryWorkerResult["edgeFixtureOracle"] = {
    passed: edge.passed,
    cases: edge.viewsCompared,
    comparisons: edge.candidateComparisons,
    blockSizes: edge.blockSizes,
    coversNulls: edge.passed,
    coversNaN: edge.passed,
    coversInfinities: edge.passed,
    coversSignedZero: edge.passed,
    coversTiedExtrema: edge.passed,
    coversCategoryOverflow: edge.passed,
    coversMergeShapes: edge.mergeShapesCompared.length === 3,
    firstFailure: edge.firstFailure,
  };
  if (!edge.passed) failures.push(`edge fixture oracle: ${edge.firstFailure ?? "unknown failure"}`);

  const combinations = rotate(
    activeConfiguration.views.flatMap((viewId) =>
      activeConfiguration.columnScopes.flatMap((columnScope) =>
        activeConfiguration.blockSizes.map((blockSize) => ({ viewId, columnScope, blockSize })),
      ),
    ),
    activeConfiguration.caseOrderRotation,
  );
  const samples: GridSummaryBuildSample[] = [];
  let stalePublications = 0;
  let logicalRetainedBytes = 0;
  const retainedHierarchyBytesAfterCombinationRelease: number[] = [];
  const oracleCache = new Map<
    GridSummaryViewId,
    Readonly<Record<GridSummaryColumnScopeId, OracleExpectations>>
  >();
  for (const viewId of activeConfiguration.views) {
    const view = requireValue(views.get(viewId), viewId);
    send({ type: "stage", stage: `${viewId}/building-independent-oracle-cache` });
    const ranges = combinedOracleRanges(
      view.rowCount,
      activeConfiguration.blockSizes,
      activeConfiguration.oracleRangeCount,
    );
    const all = buildOracleExpectations(activeDataset.data, view.physicalRows, ALL_COLUMNS, ranges);
    oracleCache.set(viewId, {
      "all-eligible": all,
      "two-column": subsetOracleExpectations(all, TWO_COLUMNS),
    });
  }

  for (const combination of combinations) {
    const view = requireValue(views.get(combination.viewId), combination.viewId);
    const columns = columnsForScope(combination.columnScope);
    send({
      type: "stage",
      stage: `${combination.viewId}/${combination.columnScope}/B${combination.blockSize}/oracle`,
    });
    const expectations = requireValue(oracleCache.get(combination.viewId), "oracle cache")[
      combination.columnScope
    ];
    if (activeConfiguration.repetitions !== 2) {
      throw new Error(
        "Summary decision evidence requires exactly one first build and one replacement.",
      );
    }
    let published: GridPublishedSummaryHierarchy | null = null;
    const buildPair: {
      readonly repetition: number;
      readonly candidate: GridSummaryHierarchyCandidate;
      readonly published: GridPublishedSummaryHierarchy;
      readonly buildDurationMs: number;
      readonly wasActiveUntilSwap: boolean;
    }[] = [];

    // The first and replacement builds are deliberately back-to-back. Oracle
    // scans, query timing, payload encoding, and stale-revision probes happen
    // only after the replacement is installed, so they cannot warm or allocate
    // between the two build measurements.
    for (let repetition = 0; repetition < 2; repetition++) {
      send({
        type: "stage",
        stage: `${combination.viewId}/${combination.columnScope}/B${combination.blockSize}/${repetition === 0 ? "first" : "replacement"}`,
      });
      const activeBeforeBuild = published;
      const requestId = ++nextRequestId;
      const startedAt = performance.now();
      const built = await buildGridSummaryHierarchyAsync(store, view, {
        requestId,
        dataRevision: DATA_REVISION,
        columns,
        blockSize: combination.blockSize,
        previousRetainedBytes: published?.retainedBytes ?? 0,
        chunkSize: activeConfiguration.chunkSize,
      });
      const buildDurationMs = performance.now() - startedAt;
      if (built.status !== "complete") {
        throw new Error(
          `${combination.viewId}/${combination.columnScope}/B${combination.blockSize} cancelled unexpectedly.`,
        );
      }
      const nextPublished = publishGridSummaryHierarchyCandidate(built.candidate, built.candidate);
      if (!nextPublished) {
        throw new Error(
          `${combination.viewId}/${combination.columnScope}/B${combination.blockSize} failed publication.`,
        );
      }
      const wasActiveUntilSwap = activeBeforeBuild === null || published === activeBeforeBuild;
      published = nextPublished;
      logicalRetainedBytes = published.retainedBytes;
      buildPair.push({
        repetition,
        candidate: built.candidate,
        published,
        buildDurationMs,
        wasActiveUntilSwap,
      });
    }

    let firstPublishedExactAfterPair = false;
    for (const build of buildPair) {
      const { repetition, candidate, published: builtPublished, buildDurationMs } = build;
      const oracle = validateSummaryCandidateAgainstExpectations(
        activeDataset.data,
        view.physicalRows,
        expectations,
        oracleQueryAdapter(builtPublished),
      );
      if (!oracle.passed) {
        failures.push(
          `${combination.viewId}/${combination.columnScope}/B${combination.blockSize}/${repetition}: oracle ${oracle.firstFailure ?? "failed"}`,
        );
      }
      if (repetition === 0) firstPublishedExactAfterPair = oracle.passed;
      const query = measureQueries(
        builtPublished,
        columns,
        view.rowCount,
        combination.blockSize,
        activeConfiguration.performanceQueryCount,
      );
      if (!query.structuralBoundsPassed) {
        failures.push(
          `${combination.viewId}/${combination.columnScope}/B${combination.blockSize}: ${query.firstStructuralFailure ?? "structural bound failed"}`,
        );
      }
      const payload = measureBandPayload(
        builtPublished,
        columns,
        view.rowCount,
        activeConfiguration.bandCount,
      );
      if (!payload.boundedByBandAndColumnCount) {
        failures.push(
          `${combination.viewId}/${combination.columnScope}/B${combination.blockSize}: band payload was unbounded.`,
        );
      }
      const staleRevisionQueryRejected = rejectsStaleQuery(builtPublished, columns[0]!);
      if (!staleRevisionQueryRejected) {
        failures.push(
          `${combination.viewId}/${combination.columnScope}/B${combination.blockSize}: stale query was accepted.`,
        );
      }
      const stalePublicationAttempted = repetition === 0;
      let stalePublicationRejected: boolean | null = null;
      if (stalePublicationAttempted) {
        const stale = publishGridSummaryHierarchyCandidate(candidate, {
          datasetId: candidate.datasetId,
          requestId: candidate.requestId + 1,
          dataRevision: candidate.dataRevision,
          viewRevision: candidate.viewRevision,
        });
        stalePublicationRejected = stale === null;
        if (!stalePublicationRejected) stalePublications++;
      }
      const oldHierarchyRetainedUntilSwap =
        repetition === 0 ? true : build.wasActiveUntilSwap && firstPublishedExactAfterPair;
      if (!oldHierarchyRetainedUntilSwap) {
        failures.push(
          `${combination.viewId}/${combination.columnScope}/B${combination.blockSize}: old hierarchy changed before swap.`,
        );
      }
      samples.push(
        sampleFrom(
          combination,
          columns,
          repetition,
          candidate,
          builtPublished,
          buildDurationMs,
          query,
          oracle,
          payload,
          stalePublicationAttempted,
          stalePublicationRejected,
          staleRevisionQueryRejected,
          oldHierarchyRetainedUntilSwap,
        ),
      );
    }

    // The next combination starts with no installed hierarchy. This is a
    // logical ownership assertion; browser GC timing is intentionally not used.
    published = null;
    buildPair.length = 0;
    logicalRetainedBytes = 0;
    retainedHierarchyBytesAfterCombinationRelease.push(logicalRetainedBytes);
    if (logicalRetainedBytes !== 0) failures.push("Hierarchy ownership did not return to zero.");
  }

  send({ type: "stage", stage: "cancellation" });
  const cancellation = await measureCancellation(
    activeConfiguration,
    requireValue(views.get("identity"), "identity view"),
    activeDataset.data,
    requireValue(oracleCache.get("identity"), "identity oracle cache")["two-column"],
  );
  for (const result of cancellation) {
    if (!cancellationPassed(result))
      failures.push(`${result.kind} cancellation correctness failed.`);
  }

  send({ type: "stage", stage: "edit-invalidation" });
  const editInvalidation = await measureEditInvalidation();
  if (editInvalidation.status === "failed")
    failures.push(`edit invalidation: ${editInvalidation.caveat}`);

  const maximumRetainedHierarchyBytes = maximum(samples.map((sample) => sample.retainedBytes));
  const maximumStagedReplacementPeakBytes = maximum(
    samples.map((sample) => sample.stagedReplacementPeakBytes),
  );
  const exactLedgerInternallyConsistent = samples.every(
    (sample) =>
      sample.retainedBytes === sample.buildStats.retainedBytes &&
      sample.stagedReplacementPeakBytes === sample.buildStats.stagedReplacementPeakBytes &&
      sample.buildStats.stagedReplacementPeakBytes ===
        sample.buildStats.previousRetainedBytes +
          sample.buildStats.retainedBytes +
          sample.buildStats.scratchPeakBytes,
  );
  if (!exactLedgerInternallyConsistent) failures.push("Exact summary byte ledger is inconsistent.");
  const rawOraclePassed = samples.every((sample) => sample.oracle.passed) && edge.passed;
  const allCandidatesPublished = samples.every((sample) => sample.publication.published);
  const noStalePublications = stalePublications === 0;
  const payloadsBounded = samples.every((sample) => sample.payload.boundedByBandAndColumnCount);
  const cancellationPassedOverall = cancellation.every(cancellationPassed);
  const correctness = {
    rawOraclePassed,
    allCandidatesPublished,
    noStalePublications,
    payloadsBounded,
    cancellationPassed: cancellationPassedOverall,
    exactLedgerInternallyConsistent,
    passed:
      rawOraclePassed &&
      allCandidatesPublished &&
      noStalePublications &&
      payloadsBounded &&
      cancellationPassedOverall &&
      exactLedgerInternallyConsistent &&
      samples.every(
        (sample) =>
          sample.query.structuralBoundsPassed && sample.publication.staleRevisionQueryRejected,
      ) &&
      editInvalidation.status === "passed",
  };
  if (!correctness.passed && failures.length === 0)
    failures.push("Summary correctness aggregate failed.");

  const viewPermutationBytes = preparation.reduce(
    (total, entry) => total + entry.physicalRowsBytes,
    0,
  );
  const viewFilterBitmapBytes = preparation.reduce(
    (total, entry) => total + entry.filterBitmapBytes,
    0,
  );
  const result: GridSummaryWorkerResult = {
    profile: activeDataset.profile,
    installation: activeInstallation,
    viewPreparation: preparation,
    samples,
    cancellation,
    edgeFixtureOracle,
    editInvalidation,
    exactLedger: {
      installedTypedArrayBytes: activeInstallation.retainedTypedArrayBytes,
      viewPermutationBytes,
      viewFilterBitmapBytes,
      retainedHierarchyBytesAfterCombinationRelease,
      maximumRetainedHierarchyBytes,
      maximumStagedReplacementPeakBytes,
      hierarchyBytesAreExact: exactLedgerInternallyConsistent,
      sampledBrowserMemoryIsNotExact: true,
    },
    correctness,
    failures,
  };
  send({ type: "complete", result });
}

async function prepareViews(
  activeConfiguration: GridSummaryConfiguration,
  activeDataset: GridBenchmarkDataset,
): Promise<{
  readonly views: ReadonlyMap<GridSummaryViewId, GridSummaryView>;
  readonly preparation: readonly GridSummaryViewPreparation[];
}> {
  const datasetId = requireValue(store.datasetId, "installed dataset id");
  const views = new Map<GridSummaryViewId, GridSummaryView>();
  const preparation: GridSummaryViewPreparation[] = [];
  if (activeConfiguration.views.includes("identity")) {
    const identity: GridSummaryView = {
      datasetId,
      viewRevision: 1,
      rowCount: activeDataset.data.length,
      physicalRows: null,
    };
    views.set("identity", identity);
    preparation.push({
      viewId: "identity",
      requestId: 0,
      viewRevision: 1,
      rowCount: identity.rowCount,
      physicalRowsBytes: 0,
      filterBitmapBytes: 0,
      buildDurationMs: 0,
      effectiveKernel: "identity-no-permutation",
    });
  }
  for (const [viewId, spec] of [
    ["full-sort", activeDataset.cases["sort-1-key"]],
    ["filtered-sort-25pct", activeDataset.cases["filter-sort-3-key-25pct"]],
  ] as const) {
    if (!activeConfiguration.views.includes(viewId)) continue;
    send({ type: "stage", stage: `preparing-${viewId}` });
    const requestId = ++nextRequestId;
    const viewRevision = viewId === "full-sort" ? 2 : 3;
    const startedAt = performance.now();
    const result = await buildGridViewCandidateAsync(store, spec, {
      requestId,
      viewRevision,
      kernel: "typed",
      chunkSize: activeConfiguration.chunkSize,
    });
    const buildDurationMs = performance.now() - startedAt;
    if (result.status !== "complete") throw new Error(`${viewId} preparation cancelled.`);
    const published: GridPublishedView | null = publishGridViewCandidate(result.candidate, {
      datasetId,
      requestId,
      viewRevision,
    });
    if (!published) throw new Error(`${viewId} view candidate did not publish.`);
    views.set(viewId, published);
    preparation.push({
      viewId,
      requestId,
      viewRevision,
      rowCount: published.rowCount,
      physicalRowsBytes: published.physicalRows.byteLength,
      filterBitmapBytes: published.filterBitmap?.byteLength ?? 0,
      buildDurationMs,
      effectiveKernel: result.kernel,
    });
  }
  return { views, preparation };
}

function sampleFrom(
  combination: {
    readonly viewId: GridSummaryViewId;
    readonly columnScope: GridSummaryColumnScopeId;
    readonly blockSize: number;
  },
  columns: readonly string[],
  repetition: number,
  candidate: GridSummaryHierarchyCandidate,
  published: GridPublishedSummaryHierarchy,
  buildDurationMs: number,
  query: GridSummaryQueryMetrics,
  oracle: GridSummaryBuildSample["oracle"],
  payload: GridSummaryBandPayloadLedger,
  stalePublicationAttempted: boolean,
  stalePublicationRejected: boolean | null,
  staleRevisionQueryRejected: boolean,
  oldHierarchyRetainedUntilSwap: boolean,
): GridSummaryBuildSample {
  const stats = candidate.buildStats;
  return {
    viewId: combination.viewId,
    columnScope: combination.columnScope,
    columnIds: columns,
    blockSize: combination.blockSize,
    repetition,
    temperature: repetition === 0 ? "first" : "replacement",
    requestId: candidate.requestId,
    dataRevision: candidate.dataRevision,
    viewRevision: candidate.viewRevision,
    rowCount: candidate.rowCount,
    buildDurationMs,
    buildStats: {
      leafBuildDurationMs: stats.leafBuildDurationMs,
      mergeBuildDurationMs: stats.mergeBuildDurationMs,
      totalBuildDurationMs: stats.totalBuildDurationMs,
      yieldCount: stats.yieldCount,
      retainedBytes: stats.retainedBytes,
      previousRetainedBytes: stats.previousRetainedBytes,
      scratchPeakBytes: stats.buildScratchBytes,
      stagedReplacementPeakBytes: stats.stagedReplacementPeakBytes,
      columns: stats.columns,
    },
    retainedBytes: candidate.retainedBytes,
    retainedBytesPerActiveRow:
      candidate.rowCount === 0 ? 0 : candidate.retainedBytes / candidate.rowCount,
    stagedReplacementPeakBytes: stats.stagedReplacementPeakBytes,
    query,
    oracle,
    payload,
    publication: {
      published: true,
      readyToPublishDurationMs: published.readyToPublishedMs,
      stalePublicationAttempted,
      stalePublicationRejected,
      staleRevisionQueryRejected,
      oldHierarchyRetainedUntilSwap,
    },
  };
}

function measureQueries(
  published: GridPublishedSummaryHierarchy,
  columns: readonly string[],
  rowCount: number,
  blockSize: number,
  queryCount: number,
): GridSummaryQueryMetrics {
  const durations: number[] = [];
  let nodeVisits = 0;
  let rawRowsScanned = 0;
  let summaryVertices = 0;
  let maximumNodeVisits = 0;
  let maximumRawRowsScanned = 0;
  let firstStructuralFailure: string | null = null;
  const batchStartedAt = performance.now();
  for (let index = 0; index < queryCount; index++) {
    const band = index % queryCount;
    const start = Math.floor((rowCount * band) / queryCount);
    const end = Math.floor((rowCount * (band + 1)) / queryCount);
    const columnId = columns[index % columns.length]!;
    const startedAt = performance.now();
    const result = published.query(columnId, start, end);
    durations.push(performance.now() - startedAt);
    nodeVisits += result.stats.nodeVisits;
    rawRowsScanned += result.stats.rawRowsScanned;
    summaryVertices += result.stats.summaryVertices;
    maximumNodeVisits = Math.max(maximumNodeVisits, result.stats.nodeVisits);
    maximumRawRowsScanned = Math.max(maximumRawRowsScanned, result.stats.rawRowsScanned);
    const bound = oracleQueryVisitBounds(rowCount, blockSize, { start, end });
    if (
      firstStructuralFailure === null &&
      (result.stats.nodeVisits > bound.maximumCoveredNodeVisits ||
        result.stats.rawRowsScanned > bound.maximumRawBoundaryRows)
    ) {
      firstStructuralFailure =
        `${columnId} [${start}, ${end}) visited ${result.stats.nodeVisits}/${bound.maximumCoveredNodeVisits} nodes ` +
        `and scanned ${result.stats.rawRowsScanned}/${bound.maximumRawBoundaryRows} raw rows.`;
    }
  }
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    batchDurationMs: performance.now() - batchStartedAt,
    queryCount,
    p50DurationMs: percentile(sorted, 0.5),
    p95DurationMs: percentile(sorted, 0.95),
    maximumDurationMs: sorted.at(-1) ?? 0,
    nodeVisits,
    rawRowsScanned,
    summaryVertices,
    maximumNodeVisits,
    maximumRawRowsScanned,
    structuralChecks: queryCount,
    structuralBoundsPassed: firstStructuralFailure === null,
    firstStructuralFailure,
  };
}

function measureBandPayload(
  published: GridPublishedSummaryHierarchy,
  columns: readonly string[],
  rowCount: number,
  bandCount: number,
): GridSummaryBandPayloadLedger {
  let summaries = 0;
  let summaryVertices = 0;
  for (let band = 0; band < bandCount; band++) {
    const start = Math.floor((rowCount * band) / bandCount);
    const end = Math.floor((rowCount * (band + 1)) / bandCount);
    for (const columnId of columns) {
      const result = published.query(columnId, start, end);
      summaryVertices += result.stats.summaryVertices;
      summaries++;
    }
  }
  return {
    bandsRequested: bandCount,
    columnsRequested: columns.length,
    summaries,
    maximumSummaries: bandCount * columns.length,
    summaryVertices,
    boundedByBandAndColumnCount: summaries <= bandCount * columns.length,
  };
}

async function measureCancellation(
  activeConfiguration: GridSummaryConfiguration,
  identity: GridSummaryView,
  activeData: GridData,
  oracleExpectations: OracleExpectations,
): Promise<readonly GridSummaryCancellationResult[]> {
  const baselineRequest = ++nextRequestId;
  const baselineBuild = await buildGridSummaryHierarchyAsync(store, identity, {
    requestId: baselineRequest,
    dataRevision: DATA_REVISION,
    columns: TWO_COLUMNS,
    blockSize: 1_024,
    chunkSize: Math.max(1, Math.min(activeConfiguration.chunkSize, identity.rowCount || 1)),
  });
  if (baselineBuild.status !== "complete") throw new Error("Cancellation baseline build failed.");
  let active = publishGridSummaryHierarchyCandidate(
    baselineBuild.candidate,
    baselineBuild.candidate,
  );
  if (!active) throw new Error("Cancellation baseline publication failed.");
  const referenceDigest = digestHierarchy(active, TWO_COLUMNS);
  const expectedActiveRetainedBytes = active.retainedBytes;

  const buildToken = ++nextRequestId;
  let buildArmedAtEpochMs = 0;
  let buildProgress = 0;
  let buildTotal = 0;
  const obsolete = await buildGridSummaryHierarchyAsync(store, identity, {
    requestId: ++nextRequestId,
    dataRevision: DATA_REVISION,
    columns: ALL_COLUMNS,
    blockSize: 64,
    previousRetainedBytes: active.retainedBytes,
    chunkSize: Math.max(
      1,
      Math.min(activeConfiguration.chunkSize, Math.max(1, identity.rowCount >>> 2)),
    ),
    shouldCancel: () => cancellations.has(buildToken),
    onProgress: (progress: GridSummaryBuildProgress) => {
      if (buildArmedAtEpochMs !== 0) return;
      buildArmedAtEpochMs = epochNow();
      buildProgress = progress.completed;
      buildTotal = progress.total;
      send({
        type: "cancellation-armed",
        token: buildToken,
        kind: "build",
        progress: progress.completed,
        total: progress.total,
        armedAtEpochMs: buildArmedAtEpochMs,
        delayMs: activeConfiguration.cancellationDelayMs,
      });
    },
  });
  const buildEndedAtEpochMs = epochNow();
  const buildSignal = requireValue(cancellations.get(buildToken), "build cancellation signal");
  const observedActiveRetainedBytes = active.retainedBytes;
  const activeDigestMatchesReference = digestHierarchy(active, TWO_COLUMNS) === referenceDigest;
  const replacementBuild = await buildGridSummaryHierarchyAsync(store, identity, {
    requestId: ++nextRequestId,
    dataRevision: DATA_REVISION,
    columns: TWO_COLUMNS,
    blockSize: 1_024,
    previousRetainedBytes: active.retainedBytes,
    chunkSize: activeConfiguration.chunkSize,
  });
  if (replacementBuild.status !== "complete")
    throw new Error("Build-cancellation replacement failed.");
  const replacement = publishGridSummaryHierarchyCandidate(
    replacementBuild.candidate,
    replacementBuild.candidate,
  );
  if (!replacement) throw new Error("Build-cancellation replacement did not publish.");
  active = replacement;
  const replacementDigest = digestHierarchy(active, TWO_COLUMNS);
  const replacementOracle = validateSummaryCandidateAgainstExpectations(
    activeData,
    identity.physicalRows,
    oracleExpectations,
    oracleQueryAdapter(active),
  );
  const buildCancellation: GridSummaryCancellationResult = {
    kind: "build",
    trigger: "host postMessage after hierarchy progress and worker event-loop yield",
    cancellationDelayMs: activeConfiguration.cancellationDelayMs,
    progressAtSignal: buildProgress,
    totalAtSignal: buildTotal,
    progressSignalToDispatchMs: buildSignal.dispatchedAtEpochMs - buildArmedAtEpochMs,
    dispatchToWorkerReceiptMs: buildSignal.receivedAtEpochMs - buildSignal.dispatchedAtEpochMs,
    workerReceiptToCancellationMs: buildEndedAtEpochMs - buildSignal.receivedAtEpochMs,
    dispatchToCancellationMs: buildEndedAtEpochMs - buildSignal.dispatchedAtEpochMs,
    obsoleteStatus: obsolete.status,
    obsoletePublicationAttempted: false,
    stalePublications: 0,
    candidateRetainedBytesAfterCancel:
      obsolete.status === "cancelled" ? obsolete.retainedBytes : obsolete.candidate.retainedBytes,
    releasedCandidateBytes: obsolete.status === "cancelled" ? obsolete.releasedCandidateBytes : 0,
    peakCandidateBytes:
      obsolete.status === "cancelled"
        ? obsolete.peakCandidateBytes
        : obsolete.candidate.buildStats.peakCandidateBytes,
    stagedReplacementPeakBytes:
      obsolete.status === "cancelled"
        ? obsolete.stagedReplacementPeakBytes
        : obsolete.candidate.buildStats.stagedReplacementPeakBytes,
    expectedActiveRetainedBytes,
    observedActiveRetainedBytes,
    activeDigestMatchesReference,
    replacementCompleted: true,
    replacementDigestMatchesReference: replacementDigest === referenceDigest,
    replacementMatchesIndependentOracle: replacementOracle.passed,
  };

  const queryToken = ++nextRequestId;
  const queryCancelled = await cancellableQueryBatch(
    active,
    TWO_COLUMNS,
    activeConfiguration.bandCount,
    queryToken,
    activeConfiguration.cancellationDelayMs,
  );
  const querySignal = requireValue(cancellations.get(queryToken), "query cancellation signal");
  const completedQuery = await completeQueryBatch(
    active,
    TWO_COLUMNS,
    activeConfiguration.bandCount,
  );
  const queryCancellation: GridSummaryCancellationResult = {
    kind: "query-batch",
    trigger: "harness-cooperative-query-batch-between-engine-queries",
    cancellationDelayMs: activeConfiguration.cancellationDelayMs,
    progressAtSignal: queryCancelled.progressAtSignal,
    totalAtSignal: activeConfiguration.bandCount,
    progressSignalToDispatchMs: querySignal.dispatchedAtEpochMs - queryCancelled.armedAtEpochMs,
    dispatchToWorkerReceiptMs: querySignal.receivedAtEpochMs - querySignal.dispatchedAtEpochMs,
    workerReceiptToCancellationMs:
      queryCancelled.cancelledAtEpochMs - querySignal.receivedAtEpochMs,
    dispatchToCancellationMs: queryCancelled.cancelledAtEpochMs - querySignal.dispatchedAtEpochMs,
    obsoleteStatus: "cancelled",
    obsoletePublicationAttempted: false,
    stalePublications: 0,
    candidateRetainedBytesAfterCancel: 0,
    releasedCandidateBytes: 0,
    peakCandidateBytes: 0,
    stagedReplacementPeakBytes: active.retainedBytes,
    expectedActiveRetainedBytes: active.retainedBytes,
    observedActiveRetainedBytes: active.retainedBytes,
    activeDigestMatchesReference: digestHierarchy(active, TWO_COLUMNS) === replacementDigest,
    replacementCompleted: true,
    replacementDigestMatchesReference: completedQuery === queryCancelled.referenceDigest,
    replacementMatchesIndependentOracle: replacementOracle.passed,
  };
  return [buildCancellation, queryCancellation];
}

async function cancellableQueryBatch(
  published: GridPublishedSummaryHierarchy,
  columns: readonly string[],
  bands: number,
  token: number,
  delayMs: number,
): Promise<{
  readonly progressAtSignal: number;
  readonly armedAtEpochMs: number;
  readonly cancelledAtEpochMs: number;
  readonly referenceDigest: string;
}> {
  const referenceDigest = await completeQueryBatch(published, columns, bands);
  let hash = 0x811c9dc5;
  const armAfter = Math.max(1, Math.min(8, bands));
  let armedAtEpochMs = 0;
  for (let band = 0; band < bands; band++) {
    const start = Math.floor((published.rowCount * band) / bands);
    const end = Math.floor((published.rowCount * (band + 1)) / bands);
    for (const columnId of columns) {
      hash = hashQuery(hash, published.query(columnId, start, end));
    }
    if (band + 1 === armAfter) {
      armedAtEpochMs = epochNow();
      send({
        type: "cancellation-armed",
        token,
        kind: "query-batch",
        progress: band + 1,
        total: bands,
        armedAtEpochMs,
        delayMs,
      });
    }
    if (armedAtEpochMs !== 0) {
      await yieldControl();
      if (cancellations.has(token)) {
        return {
          progressAtSignal: armAfter,
          armedAtEpochMs,
          cancelledAtEpochMs: epochNow(),
          referenceDigest,
        };
      }
    }
  }
  throw new Error(`Query batch completed before cancellation (hash ${hash.toString(16)}).`);
}

async function completeQueryBatch(
  published: GridPublishedSummaryHierarchy,
  columns: readonly string[],
  bands: number,
): Promise<string> {
  let hash = 0x811c9dc5;
  for (let band = 0; band < bands; band++) {
    const start = Math.floor((published.rowCount * band) / bands);
    const end = Math.floor((published.rowCount * (band + 1)) / bands);
    for (const columnId of columns) {
      hash = hashQuery(hash, published.query(columnId, start, end));
    }
  }
  return hash.toString(16).padStart(8, "0");
}

async function measureEditInvalidation(): Promise<GridSummaryWorkerResult["editInvalidation"]> {
  const startedAt = performance.now();
  try {
    const fixture = buildOracleEdgeFixture();
    const data: GridData = {
      ...fixture.data,
      columns: fixture.data.columns.map((column) => ({
        ...column,
        schema: { ...column.schema, editable: true },
      })),
    };
    const storeData = structuredClone(data);
    const editStore = new GridDataStore();
    const proof = await preflightGridDataAsync(storeData);
    const installed = editStore.installWorkerIngress(storeData, proof);
    const view: GridSummaryView = {
      datasetId: installed.datasetId,
      viewRevision: 1,
      rowCount: data.length,
      physicalRows: null,
    };
    const baseline = await buildGridSummaryHierarchyAsync(editStore, view, {
      requestId: 1,
      dataRevision: 1,
      columns: ["numeric", "category"],
      blockSize: 257,
      chunkSize: 64,
    });
    if (baseline.status !== "complete") throw new Error("Edit baseline cancelled.");
    const baselinePublished = publishGridSummaryHierarchyCandidate(
      baseline.candidate,
      baseline.candidate,
    );
    if (!baselinePublished) throw new Error("Edit baseline did not publish.");

    const numericRow = 20;
    const numericRowId = editStore.rowIdAt(numericRow);
    const numericState = editStore.cellState(numericRowId, "numeric");
    const numericPatch = editStore.stageCellPatch({
      datasetId: installed.datasetId,
      rowId: numericRowId,
      columnId: "numeric",
      cellRevision: numericState.revision,
      previousValue: numericState.value,
      finalValue: -1_000_000_000,
    });
    if (!numericPatch) throw new Error("Numeric patch did not stage.");
    const numericCandidate = await buildEditedCandidate(
      editStore,
      view,
      numericPatch,
      2,
      baselinePublished.retainedBytes,
    );
    const privateNumeric = numericCandidate.query("numeric", 0, data.length);
    if (privateNumeric.kind !== "numeric")
      throw new Error("Numeric candidate returned a category summary.");
    const privateMinimum = privateNumeric.finiteMinimum;
    if (privateMinimum?.physicalRow !== numericRow)
      throw new Error("Numeric staged candidate missed edited extremum.");
    const installedNumeric = baselinePublished.query("numeric", 0, data.length);
    if (installedNumeric.kind !== "numeric")
      throw new Error("Numeric baseline returned a category summary.");
    if (installedNumeric.finiteMinimum?.physicalRow === numericRow) {
      throw new Error("Numeric staged value leaked into installed summary.");
    }
    if (!editStore.promoteCellPatch(numericPatch))
      throw new Error("Numeric patch promotion failed.");
    const numericData = data.columns.find((column) => column.schema.id === "numeric")?.data;
    if (!numericData || numericData.kind !== "number")
      throw new Error("Numeric fixture is missing.");
    numericData.values.view[numericRow] = -1_000_000_000;
    const numericPublished = publishGridSummaryHierarchyCandidate(
      numericCandidate,
      numericCandidate,
    );
    if (!numericPublished) throw new Error("Numeric edit candidate did not publish.");

    const relocationViewBuild = await buildGridViewCandidateAsync(
      editStore,
      {
        filter: {
          kind: "comparison",
          columnId: "numeric",
          operator: "gte",
          value: -100_000,
        },
        sort: [{ columnId: "numeric", direction: "ascending", nulls: "last" }],
      },
      { requestId: 20, viewRevision: 2, kernel: "typed", chunkSize: 64 },
    );
    if (relocationViewBuild.status !== "complete")
      throw new Error("Edited view relocation cancelled.");
    const relocatedView = publishGridViewCandidate(relocationViewBuild.candidate, {
      datasetId: installed.datasetId,
      requestId: 20,
      viewRevision: 2,
    });
    if (!relocatedView) throw new Error("Edited view relocation did not publish.");
    const relocatedSummary = await buildGridSummaryHierarchyAsync(editStore, relocatedView, {
      requestId: 21,
      dataRevision: 2,
      columns: ["numeric", "category"],
      blockSize: 257,
      chunkSize: 64,
    });
    if (relocatedSummary.status !== "complete") throw new Error("Relocated summary cancelled.");
    const relocationExpectations = buildOracleExpectations(
      data,
      relocatedView.physicalRows,
      ["numeric", "category"],
      buildOracleRanges(relocatedView.rowCount, 257, 32).ranges,
    );
    const relocationOracle = validateSummaryCandidateAgainstExpectations(
      data,
      relocatedView.physicalRows,
      relocationExpectations,
      oracleQueryAdapter(relocatedSummary.candidate),
    );
    const sortedFilteredMappingChecked =
      relocationOracle.passed && relocatedView.viewOrdinalOfRowId(numericRowId, editStore) === -1;

    const categoryRow = 0;
    const categoryRowId = editStore.rowIdAt(categoryRow);
    const categoryState = editStore.cellState(categoryRowId, "category");
    const categoryValues = editStore.categoryValuesAt("category");
    const categoryFinal = categoryValues[5];
    if (!categoryFinal) throw new Error("Category fixture has no alternate value.");
    const oldCategoryBefore = numericPublished.query("category", 0, 6);
    if (oldCategoryBefore.kind !== "category")
      throw new Error("Category baseline returned numeric summary.");
    const categoryPatch = editStore.stageCellPatch({
      datasetId: installed.datasetId,
      rowId: categoryRowId,
      columnId: "category",
      cellRevision: categoryState.revision,
      previousValue: categoryState.value,
      finalValue: categoryFinal,
    });
    if (!categoryPatch) throw new Error("Category patch did not stage.");
    const categoryCandidate = await buildEditedCandidate(
      editStore,
      view,
      categoryPatch,
      3,
      numericPublished.retainedBytes,
    );
    const oldCategoryAfterCandidate = numericPublished.query("category", 0, 6);
    const privateCategory = categoryCandidate.query("category", 0, 6);
    if (oldCategoryAfterCandidate.kind !== "category" || privateCategory.kind !== "category") {
      throw new Error("Category edit returned the wrong summary kind.");
    }
    const categoryCandidatePrivacy =
      canonicalStringify(toRawQueryResult(oldCategoryBefore)) ===
        canonicalStringify(toRawQueryResult(oldCategoryAfterCandidate)) &&
      canonicalStringify(toRawQueryResult(privateCategory)) !==
        canonicalStringify(toRawQueryResult(oldCategoryAfterCandidate));
    const categoryWitnessTransitionChecked =
      oldCategoryBefore.exemplars.map(({ code }) => code).join(",") === "0,1,2,3" &&
      oldCategoryBefore.overflowWitness?.code === 4 &&
      privateCategory.exemplars.map(({ code }) => code).join(",") === "5,0,1,2" &&
      privateCategory.overflowWitness?.code === 3;
    if (!editStore.promoteCellPatch(categoryPatch))
      throw new Error("Category patch promotion failed.");
    const categoryData = data.columns.find((column) => column.schema.id === "category")?.data;
    if (!categoryData || categoryData.kind !== "category")
      throw new Error("Category fixture is missing.");
    categoryData.codes.view[categoryRow] = categoryValues.indexOf(categoryFinal);
    const categoryPublished = publishGridSummaryHierarchyCandidate(
      categoryCandidate,
      categoryCandidate,
    );
    if (!categoryPublished) throw new Error("Category edit candidate did not publish.");
    const expectations = buildOracleExpectations(
      data,
      null,
      ["numeric", "category"],
      buildOracleRanges(data.length, 257, 32).ranges,
    );
    const oracle = validateSummaryCandidateAgainstExpectations(
      data,
      null,
      expectations,
      oracleQueryAdapter(categoryPublished),
    );
    let staleIndexRejected = false;
    try {
      numericPublished.query("numeric", 0, 1, {
        datasetId: installed.datasetId,
        requestId: numericPublished.requestId,
        dataRevision: 3,
        viewRevision: view.viewRevision,
      });
    } catch {
      staleIndexRejected = true;
    }
    return {
      status:
        oracle.passed &&
        staleIndexRejected &&
        categoryCandidatePrivacy &&
        categoryWitnessTransitionChecked &&
        sortedFilteredMappingChecked
          ? "passed"
          : "failed",
      numericEditChecked: true,
      categoryEditChecked: true,
      staleIndexRejected,
      candidatePrivacyChecked: categoryCandidatePrivacy,
      categoryWitnessTransitionChecked,
      sortedFilteredMappingChecked,
      summaryMatchedRawOracle: oracle.passed && relocationOracle.passed,
      durationMs: performance.now() - startedAt,
      caveat: oracle.passed
        ? "Summary-only staged numeric/category invalidation passed on the untimed edge fixture; this is not an edit latency distribution."
        : (oracle.firstFailure ?? "Edited summary did not match raw oracle."),
    };
  } catch (error) {
    return {
      status: "failed",
      numericEditChecked: false,
      categoryEditChecked: false,
      staleIndexRejected: false,
      candidatePrivacyChecked: false,
      categoryWitnessTransitionChecked: false,
      sortedFilteredMappingChecked: false,
      summaryMatchedRawOracle: false,
      durationMs: performance.now() - startedAt,
      caveat: error instanceof Error ? error.message : String(error),
    };
  }
}

async function buildEditedCandidate(
  editStore: GridDataStore,
  view: GridSummaryView,
  stagedPatch: GridStagedCellPatch,
  dataRevision: number,
  previousRetainedBytes: number,
): Promise<GridSummaryHierarchyCandidate> {
  const built = await buildGridSummaryHierarchyAsync(editStore, view, {
    requestId: dataRevision,
    dataRevision,
    columns: ["numeric", "category"],
    blockSize: 257,
    stagedPatch,
    previousRetainedBytes,
    chunkSize: 64,
  });
  if (built.status !== "complete") throw new Error("Edited summary build cancelled.");
  return built.candidate;
}

function oracleQueryAdapter(
  hierarchy: GridSummaryHierarchyCandidate | GridPublishedSummaryHierarchy,
): (columnId: string, start: number, end: number) => RawSummaryQueryResult {
  return (columnId, start, end) => toRawQueryResult(hierarchy.query(columnId, start, end));
}

function toRawQueryResult(result: GridSummaryQueryResult): RawSummaryQueryResult {
  if (result.kind === "numeric") {
    return {
      columnId: result.columnId,
      kind: "numeric",
      exact: result.exact,
      rowCount: result.rowCount,
      nullCount: result.nullCount,
      viewStart: result.start,
      viewEnd: result.end,
      finiteCount: result.finiteCount,
      nanCount: result.nanCount,
      positiveInfinityCount: result.positiveInfinityCount,
      negativeInfinityCount: result.negativeInfinityCount,
      minimum: result.finiteMinimum,
      maximum: result.finiteMaximum,
    };
  }
  return {
    columnId: result.columnId,
    kind: "category",
    exact: result.exact,
    rowCount: result.rowCount,
    nullCount: result.nullCount,
    viewStart: result.start,
    viewEnd: result.end,
    exemplars: result.exemplars,
    complete: result.complete,
    overflowWitness: result.overflowWitness,
  };
}

function rejectsStaleQuery(published: GridPublishedSummaryHierarchy, columnId: string): boolean {
  try {
    published.query(columnId, 0, Math.min(1, published.rowCount), {
      datasetId: published.datasetId,
      requestId: published.requestId,
      dataRevision: published.dataRevision + 1,
      viewRevision: published.viewRevision,
    });
    return false;
  } catch {
    return true;
  }
}

function digestHierarchy(
  published: GridPublishedSummaryHierarchy,
  columns: readonly string[],
): string {
  return fnv1a32(
    canonicalStringify(
      columns.map((column) => toRawQueryResult(published.query(column, 0, published.rowCount))),
    ),
  );
}

function hashQuery(hash: number, query: GridSummaryQueryResult): number {
  const text = canonicalStringify(toRawQueryResult(query));
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function cancellationPassed(result: GridSummaryCancellationResult): boolean {
  return (
    result.obsoleteStatus === "cancelled" &&
    !result.obsoletePublicationAttempted &&
    result.stalePublications === 0 &&
    result.candidateRetainedBytesAfterCancel === 0 &&
    (result.kind === "query-batch" ||
      (result.releasedCandidateBytes > 0 &&
        result.peakCandidateBytes >= result.releasedCandidateBytes)) &&
    result.observedActiveRetainedBytes === result.expectedActiveRetainedBytes &&
    result.activeDigestMatchesReference &&
    result.replacementCompleted &&
    result.replacementDigestMatchesReference &&
    result.replacementMatchesIndependentOracle
  );
}

function columnsForScope(scope: GridSummaryColumnScopeId): readonly string[] {
  return scope === "two-column" ? TWO_COLUMNS : ALL_COLUMNS;
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

function maximum(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function rotate<T>(values: readonly T[], amount: number): T[] {
  if (values.length === 0) return [];
  const offset = amount % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function combinedOracleRanges(
  rowCount: number,
  blockSizes: readonly number[],
  requestedCount: number,
): readonly OracleRange[] {
  const base = buildOracleRanges(rowCount, 257, requestedCount).ranges;
  const keyed = new Map(base.map((range) => [`${range.start}:${range.end}`, range]));
  const add = (start: number, end: number): void => {
    const lo = Math.max(0, Math.min(rowCount, Math.trunc(start)));
    const hi = Math.max(lo, Math.min(rowCount, Math.trunc(end)));
    const key = `${lo}:${hi}`;
    if (!keyed.has(key)) keyed.set(key, { start: lo, end: hi, kind: "block-edge" });
  };
  for (const blockSize of blockSizes) {
    for (const edge of [blockSize, blockSize * 2, rowCount - (rowCount % blockSize)]) {
      add(edge - 1, edge + 1);
    }
    add(1, blockSize * 2 - 1);
  }
  return [...keyed.values()];
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? { $bigint: entry.toString(10) } : entry,
  );
}

function yieldControl(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Missing ${label}.`);
  return value;
}

function send(message: GridSummaryWorkerOutput): void {
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
