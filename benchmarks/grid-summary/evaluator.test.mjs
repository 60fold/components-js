import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSummaryGate } from "./evaluator.mjs";

test("scaled smoke evidence cannot produce a performance verdict", () => {
  const result = evaluateSummaryGate(
    {
      rowScale: 0.001,
      repetitions: 2,
      views: ["identity", "full-sort", "filtered-sort-25pct"],
      columnScopes: ["two-column", "all-eligible"],
      blockSizes: [256],
      bandCount: 64,
      performanceQueryCount: 256,
    },
    { browser: "chromium" },
    [],
  );
  assert.equal(result.evaluable, false);
  assert.equal(result.passes, null);
  assert.ok(result.evaluabilityReasons.length > 0);
});

test("complete independent evidence passes the frozen decision gate", () => {
  const fixture = fullFixture();
  const result = evaluateSummaryGate(fixture.configuration, fixture.environment, fixture.samples);
  assert.equal(result.evaluable, true);
  assert.equal(result.passes, true);
  assert.deepEqual(result.failures, []);
});

test("missing replacement evidence cannot be hidden by aggregate medians", () => {
  const fixture = fullFixture();
  fixture.samples[1].page.samples.splice(
    fixture.samples[1].page.samples.findIndex(
      (entry) =>
        entry.viewId === "full-sort" &&
        entry.columnScope === "two-column" &&
        entry.blockSize === 256 &&
        entry.temperature === "replacement",
    ),
    1,
  );
  const result = evaluateSummaryGate(fixture.configuration, fixture.environment, fixture.samples);
  assert.equal(result.passes, false);
  assert.ok(
    result.failures.some((failure) => failure.includes("expected one first and 1 replacement")),
  );
});

test("browser, worker, cancellation, structural, edit, and memory regressions are representable", () => {
  const fixture = fullFixture();
  fixture.samples[0].runner.browserErrors.push("boom");
  fixture.samples[0].runner.activeWorkersAfterCompletion = 1;
  fixture.samples[0].page.cancellation[0].obsoleteStatus = "complete";
  fixture.samples[0].page.editInvalidation.status = "failed";
  const entry = fixture.samples[0].page.samples.find(
    (candidate) => candidate.blockSize === 256 && candidate.columnScope === "all-eligible",
  );
  entry.query.structuralBoundsPassed = false;
  entry.buildStats.columns[0].retainedBytes = 9 * 1024 * 1024;
  entry.buildDurationMs = Number.NaN;
  entry.publication.staleRevisionQueryRejected = false;
  const result = evaluateSummaryGate(fixture.configuration, fixture.environment, fixture.samples);
  assert.equal(result.passes, false);
  for (const fragment of [
    "browser failure",
    "worker(s) remained active",
    "cancellation outcome failed",
    "edit invalidation gate failed",
    "structural bounds failed",
    "column exceeded 8 MiB",
    "exact byte ledger equation failed",
    "build duration is invalid",
    "publication atomicity failed",
  ]) {
    assert.ok(
      result.failures.some((failure) => failure.includes(fragment)),
      fragment,
    );
  }
});

function fullFixture() {
  const configuration = {
    rowScale: 1,
    freshBrowserSamples: 3,
    repetitions: 2,
    views: ["identity", "full-sort", "filtered-sort-25pct"],
    columnScopes: ["two-column", "all-eligible"],
    blockSizes: [256],
    bandCount: 2_048,
    performanceQueryCount: 2_048,
    caseOrderOffsets: [0, 2, 4],
  };
  return {
    configuration,
    environment: { browser: "chromium" },
    samples: [0, 1, 2].map((sampleIndex) => sampleFixture(sampleIndex, configuration)),
  };
}

function sampleFixture(sampleIndex, configuration) {
  const combinationCount =
    configuration.views.length *
    configuration.columnScopes.length *
    configuration.blockSizes.length;
  const rotation = Math.floor((combinationCount * sampleIndex) / configuration.freshBrowserSamples);
  const samples = [];
  for (const viewId of configuration.views) {
    for (const columnScope of configuration.columnScopes) {
      for (const blockSize of configuration.blockSizes) {
        samples.push(buildFixture(viewId, columnScope, blockSize, "first", configuration));
        samples.push(buildFixture(viewId, columnScope, blockSize, "replacement", configuration));
      }
    }
  }
  return {
    sampleIndex,
    caseOrderRotation: rotation,
    runner: {
      browserErrors: [],
      constructedWorkers: 1,
      closedWorkers: 1,
      activeWorkersAfterCompletion: 0,
    },
    page: {
      configuration: { sampleIndex, caseOrderRotation: rotation },
      profile: { id: "narrow-10m", declaredRows: 10_000_000, rows: 10_000_000, rowScale: 1 },
      installation: { retainedTypedArrayBytes: 480_000_000 },
      failures: [],
      correctness: {
        passed: true,
        rawOraclePassed: true,
        noStalePublications: true,
        exactLedgerInternallyConsistent: true,
      },
      edgeFixtureOracle: {
        passed: true,
        blockSizes: [3, 7, 257],
        coversNulls: true,
        coversNaN: true,
        coversInfinities: true,
        coversSignedZero: true,
        coversTiedExtrema: true,
        coversCategoryOverflow: true,
        coversMergeShapes: true,
      },
      editInvalidation: {
        status: "passed",
        numericEditChecked: true,
        categoryEditChecked: true,
        staleIndexRejected: true,
        candidatePrivacyChecked: true,
        categoryWitnessTransitionChecked: true,
        sortedFilteredMappingChecked: true,
        summaryMatchedRawOracle: true,
      },
      viewPreparation: [{ viewId: "identity", physicalRowsBytes: 0, filterBitmapBytes: 0 }],
      exactLedger: {
        retainedHierarchyBytesAfterCombinationRelease: Array(combinationCount).fill(0),
        installedTypedArrayBytes: 480_000_000,
        viewPermutationBytes: 0,
        viewFilterBitmapBytes: 0,
        maximumRetainedHierarchyBytes: Math.max(...samples.map((entry) => entry.retainedBytes)),
        maximumStagedReplacementPeakBytes: Math.max(
          ...samples.map((entry) => entry.stagedReplacementPeakBytes),
        ),
        hierarchyBytesAreExact: true,
        sampledBrowserMemoryIsNotExact: true,
      },
      cancellation: [cancellationFixture("build"), cancellationFixture("query-batch")],
      samples,
    },
  };
}

function buildFixture(viewId, columnScope, blockSize, temperature, configuration) {
  const columnCount = columnScope === "two-column" ? 2 : 6;
  const retainedBytes = columnScope === "two-column" ? 9_000_000 : 26_000_000;
  const baseColumnBytes = Math.floor(retainedBytes / columnCount);
  const columns = Array.from({ length: columnCount }, (_value, index) => ({
    columnId: `c${index}`,
    retainedBytes:
      index === columnCount - 1
        ? retainedBytes - baseColumnBytes * (columnCount - 1)
        : baseColumnBytes,
  }));
  const previousRetainedBytes = temperature === "first" ? 0 : retainedBytes;
  return {
    viewId,
    columnScope,
    columnIds: Array.from({ length: columnCount }, (_value, index) => `c${index}`),
    blockSize,
    temperature,
    rowCount: 10_000_000,
    buildDurationMs: columnScope === "two-column" ? 100 : 300,
    retainedBytes,
    stagedReplacementPeakBytes: temperature === "first" ? retainedBytes : retainedBytes * 2,
    buildStats: {
      leafBuildDurationMs: 10,
      mergeBuildDurationMs: 20,
      totalBuildDurationMs: 30,
      retainedBytes,
      previousRetainedBytes,
      scratchPeakBytes: 0,
      stagedReplacementPeakBytes: previousRetainedBytes + retainedBytes,
      columns,
    },
    query: {
      queryCount: configuration.performanceQueryCount,
      p95DurationMs: 0.1,
      structuralChecks: configuration.performanceQueryCount,
      structuralBoundsPassed: true,
      maximumNodeVisits: 16,
      maximumRawRowsScanned: Math.min(
        Math.ceil(10_000_000 / configuration.performanceQueryCount),
        blockSize * 2 - 2,
      ),
      p50DurationMs: 0.05,
      maximumDurationMs: 0.2,
    },
    payload: {
      boundedByBandAndColumnCount: true,
      columnsRequested: columnCount,
      bandsRequested: configuration.bandCount,
      summaries: configuration.bandCount * columnCount,
      maximumSummaries: configuration.bandCount * columnCount,
    },
    publication: {
      published: true,
      readyToPublishDurationMs: 0.1,
      stalePublicationAttempted: temperature === "first",
      stalePublicationRejected: temperature === "first" ? true : null,
      staleRevisionQueryRejected: true,
      oldHierarchyRetainedUntilSwap: true,
    },
    oracle: { passed: true },
  };
}

function cancellationFixture(kind) {
  return {
    kind,
    progressAtSignal: 1,
    totalAtSignal: 10,
    progressSignalToDispatchMs: 0.1,
    dispatchToWorkerReceiptMs: 0.1,
    workerReceiptToCancellationMs: 0.1,
    dispatchToCancellationMs: 0.2,
    obsoleteStatus: "cancelled",
    obsoletePublicationAttempted: false,
    stalePublications: 0,
    candidateRetainedBytesAfterCancel: 0,
    releasedCandidateBytes: kind === "build" ? 1 : 0,
    peakCandidateBytes: kind === "build" ? 1 : 0,
    expectedActiveRetainedBytes: 1,
    observedActiveRetainedBytes: 1,
    activeDigestMatchesReference: true,
    replacementCompleted: true,
    replacementDigestMatchesReference: true,
    replacementMatchesIndependentOracle: true,
  };
}
