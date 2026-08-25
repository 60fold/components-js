export const SUMMARY_GATE_THRESHOLDS = Object.freeze({
  version: "grid-summary-decision-v1",
  decisionBlockSize: 256,
  minimumFreshBrowserSamples: 3,
  requiredRepetitionsPerCombination: 2,
  defaultBands: 2_048,
  minimumTimedQueriesPerSample: 1_000,
  twoColumnFirstMedianBuildMsMaximum: 500,
  twoColumnReplacementMedianBuildMsMaximum: 350,
  allEligibleFirstMedianBuildMsMaximum: 1_500,
  allEligibleReplacementMedianBuildMsMaximum: 1_000,
  queryP95MsMaximum: 1,
  allEligibleRetainedBytesMaximum: 64 * 1024 * 1024,
  perColumnRetainedBytesMaximum: 8 * 1024 * 1024,
  stagedReplacementPeakBytesMaximum: 128 * 1024 * 1024,
  cancellationDispatchToReturnMsMaximum: 50,
  readyToPublishMsMaximum: 50,
});

const REQUIRED_VIEWS = ["identity", "full-sort", "filtered-sort-25pct"];
const REQUIRED_SCOPES = ["two-column", "all-eligible"];
const REQUIRED_BLOCKS = [256];

export function evaluateSummaryGate(configuration, environment, samples) {
  const failures = [];
  const evaluabilityReasons = [];
  const fullConfiguration =
    environment.browser === "chromium" &&
    configuration.rowScale === 1 &&
    configuration.freshBrowserSamples === samples.length &&
    samples.length >= SUMMARY_GATE_THRESHOLDS.minimumFreshBrowserSamples &&
    configuration.repetitions === SUMMARY_GATE_THRESHOLDS.requiredRepetitionsPerCombination &&
    includesAll(configuration.views, REQUIRED_VIEWS) &&
    includesAll(configuration.columnScopes, REQUIRED_SCOPES) &&
    includesAll(configuration.blockSizes, REQUIRED_BLOCKS) &&
    configuration.bandCount >= SUMMARY_GATE_THRESHOLDS.defaultBands &&
    configuration.performanceQueryCount >= SUMMARY_GATE_THRESHOLDS.minimumTimedQueriesPerSample;

  if (environment.browser !== "chromium") evaluabilityReasons.push("Chromium is required.");
  if (configuration.rowScale !== 1) evaluabilityReasons.push("rowScale must equal 1.");
  if (samples.length < SUMMARY_GATE_THRESHOLDS.minimumFreshBrowserSamples) {
    evaluabilityReasons.push(
      `At least ${SUMMARY_GATE_THRESHOLDS.minimumFreshBrowserSamples} fresh browser samples are required.`,
    );
  }
  if (configuration.freshBrowserSamples !== samples.length) {
    evaluabilityReasons.push("Recorded freshBrowserSamples must equal the raw sample count.");
  }
  if (configuration.repetitions !== SUMMARY_GATE_THRESHOLDS.requiredRepetitionsPerCombination) {
    evaluabilityReasons.push("Exactly two repetitions (first + replacement) are required.");
  }
  if (!includesAll(configuration.views, REQUIRED_VIEWS)) {
    evaluabilityReasons.push("All three canonical views are required.");
  }
  if (!includesAll(configuration.columnScopes, REQUIRED_SCOPES)) {
    evaluabilityReasons.push("Both column scopes are required.");
  }
  if (!includesAll(configuration.blockSizes, REQUIRED_BLOCKS)) {
    evaluabilityReasons.push("Production block size 256 is required.");
  }
  if (configuration.bandCount < SUMMARY_GATE_THRESHOLDS.defaultBands) {
    evaluabilityReasons.push("The canonical 2,048-band payload is required.");
  }
  if (configuration.performanceQueryCount < SUMMARY_GATE_THRESHOLDS.minimumTimedQueriesPerSample) {
    evaluabilityReasons.push("At least 1,000 timed engine queries are required.");
  }

  // Harness and exactness failures are evaluated even when a scaled artifact
  // is not performance-evaluable. They must never be masked by passes:null.
  for (const sample of samples) {
    validateSampleInvariants(sample, configuration, fullConfiguration, failures);
  }
  if (fullConfiguration) {
    const sampleIndexes = samples.map((sample) => sample.sampleIndex);
    const rotations = samples.map((sample) => sample.caseOrderRotation);
    if (
      new Set(sampleIndexes).size !== samples.length ||
      new Set(rotations).size !== samples.length ||
      JSON.stringify(rotations) !== JSON.stringify(configuration.caseOrderOffsets)
    ) {
      failures.push("Fresh sample indexes or counterbalanced rotations are incomplete.");
    }
  }

  const measurements = [];
  if (fullConfiguration) {
    for (const viewId of REQUIRED_VIEWS) {
      for (const columnScope of REQUIRED_SCOPES) {
        const builds = samples.flatMap((sample) =>
          sample.page.samples.filter(
            (entry) =>
              entry.viewId === viewId &&
              entry.columnScope === columnScope &&
              entry.blockSize === SUMMARY_GATE_THRESHOLDS.decisionBlockSize,
          ),
        );
        const first = builds
          .filter((entry) => entry.temperature === "first")
          .map((entry) => entry.buildDurationMs);
        const replacement = builds
          .filter((entry) => entry.temperature === "replacement")
          .map((entry) => entry.buildDurationMs);
        const firstLimit =
          columnScope === "two-column"
            ? SUMMARY_GATE_THRESHOLDS.twoColumnFirstMedianBuildMsMaximum
            : SUMMARY_GATE_THRESHOLDS.allEligibleFirstMedianBuildMsMaximum;
        const replacementLimit =
          columnScope === "two-column"
            ? SUMMARY_GATE_THRESHOLDS.twoColumnReplacementMedianBuildMsMaximum
            : SUMMARY_GATE_THRESHOLDS.allEligibleReplacementMedianBuildMsMaximum;
        const measurement = {
          viewId,
          columnScope,
          firstSamples: first.length,
          replacementSamples: replacement.length,
          firstMedianMs: median(first),
          firstLimitMs: firstLimit,
          replacementMedianMs: median(replacement),
          replacementLimitMs: replacementLimit,
          maximumQueryP95Ms: maximum(builds.map((entry) => entry.query.p95DurationMs)),
          maximumRetainedBytes: maximum(builds.map((entry) => entry.retainedBytes)),
          maximumStagedReplacementPeakBytes: maximum(
            builds.map((entry) => entry.stagedReplacementPeakBytes),
          ),
          maximumReadyToPublishMs: maximum(
            builds.map((entry) => entry.publication.readyToPublishDurationMs),
          ),
        };
        measurements.push(measurement);
        if (first.length !== samples.length) {
          failures.push(
            `${viewId}/${columnScope} has ${first.length}, expected ${samples.length}, first builds.`,
          );
        }
        if (replacement.length !== samples.length) {
          failures.push(
            `${viewId}/${columnScope} has ${replacement.length}, expected ${samples.length}, replacement builds.`,
          );
        }
        if (
          !nonNegativeFinite(measurement.firstMedianMs) ||
          measurement.firstMedianMs > firstLimit
        ) {
          failures.push(`${viewId}/${columnScope} first-build median exceeded ${firstLimit} ms.`);
        }
        if (
          !nonNegativeFinite(measurement.replacementMedianMs) ||
          measurement.replacementMedianMs > replacementLimit
        ) {
          failures.push(
            `${viewId}/${columnScope} replacement median exceeded ${replacementLimit} ms.`,
          );
        }
        if (
          !nonNegativeFinite(measurement.maximumQueryP95Ms) ||
          measurement.maximumQueryP95Ms > SUMMARY_GATE_THRESHOLDS.queryP95MsMaximum
        ) {
          failures.push(`${viewId}/${columnScope} query p95 exceeded 1 ms.`);
        }
        if (
          !nonNegativeFinite(measurement.maximumStagedReplacementPeakBytes) ||
          measurement.maximumStagedReplacementPeakBytes >
            SUMMARY_GATE_THRESHOLDS.stagedReplacementPeakBytesMaximum
        ) {
          failures.push(`${viewId}/${columnScope} staged peak exceeded 128 MiB.`);
        }
        if (
          !nonNegativeFinite(measurement.maximumReadyToPublishMs) ||
          measurement.maximumReadyToPublishMs > SUMMARY_GATE_THRESHOLDS.readyToPublishMsMaximum
        ) {
          failures.push(`${viewId}/${columnScope} ready-to-publish exceeded 50 ms.`);
        }
        if (
          columnScope === "all-eligible" &&
          (!nonNegativeFinite(measurement.maximumRetainedBytes) ||
            measurement.maximumRetainedBytes >
              SUMMARY_GATE_THRESHOLDS.allEligibleRetainedBytesMaximum)
        ) {
          failures.push(`${viewId}/${columnScope} retained hierarchy exceeded 64 MiB.`);
        }
      }
    }
  }

  return {
    thresholds: SUMMARY_GATE_THRESHOLDS,
    evaluable: fullConfiguration,
    passes: fullConfiguration ? failures.length === 0 : null,
    evaluabilityReasons,
    measurements,
    failures,
  };
}

function validateSampleInvariants(sample, configuration, fullConfiguration, failures) {
  const prefix = `sample ${sample.sampleIndex}`;
  const combinationCount =
    configuration.views.length *
    configuration.columnScopes.length *
    configuration.blockSizes.length;
  const expectedRotation = Math.floor(
    (combinationCount * sample.sampleIndex) / configuration.freshBrowserSamples,
  );
  if (
    sample.caseOrderRotation !== expectedRotation ||
    sample.page.configuration.caseOrderRotation !== expectedRotation ||
    sample.page.configuration.sampleIndex !== sample.sampleIndex
  ) {
    failures.push(`${prefix}: case-order rotation is not the declared counterbalance offset.`);
  }
  for (const failure of sample.page.failures ?? [])
    failures.push(`${prefix}: page failure: ${failure}`);
  for (const failure of sample.runner.browserErrors ?? []) {
    failures.push(`${prefix}: browser failure: ${failure}`);
  }
  if (
    sample.runner.constructedWorkers <= 0 ||
    sample.runner.closedWorkers !== sample.runner.constructedWorkers
  ) {
    failures.push(`${prefix}: worker construction/closure counts do not match.`);
  }
  if (sample.runner.activeWorkersAfterCompletion !== 0) {
    failures.push(
      `${prefix}: ${sample.runner.activeWorkersAfterCompletion} worker(s) remained active.`,
    );
  }
  if (!sample.page.correctness.passed) failures.push(`${prefix}: correctness aggregate failed.`);
  if (!sample.page.correctness.rawOraclePassed) failures.push(`${prefix}: raw oracle failed.`);
  if (!sample.page.correctness.noStalePublications)
    failures.push(`${prefix}: stale publication occurred.`);
  if (sample.page.profile.id !== "narrow-10m") {
    failures.push(`${prefix}: profile id is not narrow-10m.`);
  }
  if (
    fullConfiguration &&
    (sample.page.profile.declaredRows !== 10_000_000 ||
      sample.page.profile.rows !== 10_000_000 ||
      sample.page.profile.rowScale !== 1)
  ) {
    failures.push(`${prefix}: full narrow-10m profile identity is missing.`);
  }
  const edge = sample.page.edgeFixtureOracle;
  if (
    !edge.passed ||
    !edge.blockSizes.includes(257) ||
    !edge.coversNulls ||
    !edge.coversNaN ||
    !edge.coversInfinities ||
    !edge.coversSignedZero ||
    !edge.coversTiedExtrema ||
    !edge.coversCategoryOverflow ||
    !edge.coversMergeShapes
  ) {
    failures.push(`${prefix}: edge fixture coverage failed.`);
  }
  const edit = sample.page.editInvalidation;
  if (
    edit.status !== "passed" ||
    !edit.numericEditChecked ||
    !edit.categoryEditChecked ||
    !edit.staleIndexRejected ||
    !edit.candidatePrivacyChecked ||
    !edit.categoryWitnessTransitionChecked ||
    !edit.sortedFilteredMappingChecked ||
    !edit.summaryMatchedRawOracle
  ) {
    failures.push(`${prefix}: edit invalidation gate failed.`);
  }
  const identity = sample.page.viewPreparation.find((entry) => entry.viewId === "identity");
  if (!identity || identity.physicalRowsBytes !== 0) {
    failures.push(`${prefix}: identity allocated a permutation.`);
  }
  const exact = sample.page.exactLedger;
  const release = exact.retainedHierarchyBytesAfterCombinationRelease;
  if (release.length !== combinationCount || release.some((bytes) => bytes !== 0)) {
    failures.push(`${prefix}: hierarchy ownership did not return to zero after every combination.`);
  }
  const retainedMaximum = maximum(sample.page.samples.map((entry) => entry.retainedBytes));
  const stagedMaximum = maximum(
    sample.page.samples.map((entry) => entry.stagedReplacementPeakBytes),
  );
  const permutationBytes = sample.page.viewPreparation.reduce(
    (total, entry) => total + entry.physicalRowsBytes,
    0,
  );
  const filterBitmapBytes = sample.page.viewPreparation.reduce(
    (total, entry) => total + entry.filterBitmapBytes,
    0,
  );
  if (
    exact.hierarchyBytesAreExact !== true ||
    sample.page.correctness.exactLedgerInternallyConsistent !== true ||
    exact.sampledBrowserMemoryIsNotExact !== true ||
    exact.installedTypedArrayBytes !== sample.page.installation.retainedTypedArrayBytes ||
    exact.viewPermutationBytes !== permutationBytes ||
    exact.viewFilterBitmapBytes !== filterBitmapBytes ||
    exact.maximumRetainedHierarchyBytes !== retainedMaximum ||
    exact.maximumStagedReplacementPeakBytes !== stagedMaximum
  ) {
    failures.push(`${prefix}: exact summary byte ledger aggregate is inconsistent.`);
  }

  for (const viewId of configuration.views) {
    for (const columnScope of configuration.columnScopes) {
      for (const blockSize of configuration.blockSizes) {
        const entries = sample.page.samples.filter(
          (entry) =>
            entry.viewId === viewId &&
            entry.columnScope === columnScope &&
            entry.blockSize === blockSize,
        );
        const first = entries.filter((entry) => entry.temperature === "first");
        const replacement = entries.filter((entry) => entry.temperature === "replacement");
        if (first.length !== 1 || replacement.length !== configuration.repetitions - 1) {
          failures.push(
            `${prefix}/${viewId}/${columnScope}/B${blockSize}: expected one first and ${configuration.repetitions - 1} replacement entries.`,
          );
        }
        if (
          first.length === 1 &&
          replacement.length === 1 &&
          (first[0].buildStats.previousRetainedBytes !== 0 ||
            replacement[0].buildStats.previousRetainedBytes !== first[0].retainedBytes)
        ) {
          failures.push(
            `${prefix}/${viewId}/${columnScope}/B${blockSize}: replacement ledger did not retain exactly the first hierarchy.`,
          );
        }
        for (const entry of entries) {
          validateBuildEntry(
            prefix,
            entry,
            configuration,
            fullConfiguration && blockSize === 256,
            failures,
          );
        }
      }
    }
  }
  if (
    sample.page.cancellation.length !== 2 ||
    !sample.page.cancellation.some((entry) => entry.kind === "build") ||
    !sample.page.cancellation.some((entry) => entry.kind === "query-batch")
  ) {
    failures.push(`${prefix}: expected one build and one query-batch cancellation result.`);
  }
  for (const cancellation of sample.page.cancellation) {
    if (
      cancellation.progressAtSignal <= 0 ||
      cancellation.totalAtSignal <= cancellation.progressAtSignal ||
      !nonNegativeFinite(cancellation.progressSignalToDispatchMs) ||
      !nonNegativeFinite(cancellation.dispatchToWorkerReceiptMs) ||
      !nonNegativeFinite(cancellation.workerReceiptToCancellationMs) ||
      !nonNegativeFinite(cancellation.dispatchToCancellationMs) ||
      cancellation.obsoleteStatus !== "cancelled" ||
      cancellation.obsoletePublicationAttempted ||
      cancellation.stalePublications !== 0 ||
      cancellation.candidateRetainedBytesAfterCancel !== 0 ||
      cancellation.observedActiveRetainedBytes !== cancellation.expectedActiveRetainedBytes ||
      !cancellation.activeDigestMatchesReference ||
      !cancellation.replacementCompleted ||
      !cancellation.replacementDigestMatchesReference ||
      !cancellation.replacementMatchesIndependentOracle
    ) {
      failures.push(`${prefix}/${cancellation.kind}: cancellation outcome failed.`);
    }
    if (
      fullConfiguration &&
      cancellation.dispatchToCancellationMs >
        SUMMARY_GATE_THRESHOLDS.cancellationDispatchToReturnMsMaximum
    ) {
      failures.push(`${prefix}/${cancellation.kind}: cancellation exceeded 50 ms.`);
    }
    if (
      cancellation.kind === "build" &&
      (cancellation.releasedCandidateBytes <= 0 ||
        cancellation.peakCandidateBytes < cancellation.releasedCandidateBytes)
    ) {
      failures.push(`${prefix}/build: cancelled candidate byte release was not proven.`);
    }
  }
}

function validateBuildEntry(prefix, entry, configuration, decisionSurface, failures) {
  if (!entry.oracle.passed)
    failures.push(`${prefix}/${entry.viewId}/B${entry.blockSize}: oracle failed.`);
  const byteFields = [
    entry.retainedBytes,
    entry.stagedReplacementPeakBytes,
    entry.buildStats.retainedBytes,
    entry.buildStats.previousRetainedBytes,
    entry.buildStats.scratchPeakBytes,
    entry.buildStats.stagedReplacementPeakBytes,
    ...entry.buildStats.columns.map((column) => column.retainedBytes),
  ];
  const columnBytes = entry.buildStats.columns.reduce(
    (total, column) => total + column.retainedBytes,
    0,
  );
  if (
    byteFields.some((value) => !nonNegativeInteger(value)) ||
    entry.retainedBytes !== entry.buildStats.retainedBytes ||
    entry.retainedBytes !== columnBytes ||
    entry.stagedReplacementPeakBytes !== entry.buildStats.stagedReplacementPeakBytes ||
    entry.buildStats.stagedReplacementPeakBytes !==
      entry.buildStats.previousRetainedBytes +
        entry.buildStats.retainedBytes +
        entry.buildStats.scratchPeakBytes
  ) {
    failures.push(
      `${prefix}/${entry.viewId}/B${entry.blockSize}: exact byte ledger equation failed.`,
    );
  }
  if (
    !nonNegativeFinite(entry.buildStats.leafBuildDurationMs) ||
    !nonNegativeFinite(entry.buildStats.mergeBuildDurationMs) ||
    !nonNegativeFinite(entry.buildStats.totalBuildDurationMs) ||
    !nonNegativeFinite(entry.query.p50DurationMs) ||
    !nonNegativeFinite(entry.query.p95DurationMs) ||
    !nonNegativeFinite(entry.query.maximumDurationMs) ||
    entry.query.p50DurationMs > entry.query.p95DurationMs ||
    entry.query.p95DurationMs > entry.query.maximumDurationMs
  ) {
    failures.push(`${prefix}/${entry.viewId}/B${entry.blockSize}: timing evidence is invalid.`);
  }
  const leafCount = Math.ceil(entry.rowCount / entry.blockSize);
  const treeBase = nextPowerOfTwo(Math.max(1, leafCount));
  const maximumCoveredNodeVisits =
    entry.query.queryCount === 0 ? 0 : Math.max(1, 2 * Math.ceil(Math.log2(treeBase)));
  const maximumBandRows =
    entry.query.queryCount === 0 ? 0 : Math.ceil(entry.rowCount / entry.query.queryCount);
  const maximumRawBoundaryRows = Math.min(maximumBandRows, entry.blockSize * 2 - 2);
  if (
    !entry.query.structuralBoundsPassed ||
    entry.query.structuralChecks !== entry.query.queryCount ||
    entry.query.maximumNodeVisits > maximumCoveredNodeVisits ||
    entry.query.maximumRawRowsScanned > maximumRawBoundaryRows
  ) {
    failures.push(`${prefix}/${entry.viewId}/B${entry.blockSize}: structural bounds failed.`);
  }
  if (
    !entry.payload.boundedByBandAndColumnCount ||
    entry.payload.columnsRequested !== entry.columnIds.length ||
    entry.payload.bandsRequested !== configuration.bandCount ||
    entry.payload.maximumSummaries !==
      entry.payload.bandsRequested * entry.payload.columnsRequested ||
    entry.payload.summaries > entry.payload.maximumSummaries
  ) {
    failures.push(`${prefix}/${entry.viewId}/B${entry.blockSize}: payload bound failed.`);
  }
  if (
    !entry.publication.published ||
    !entry.publication.staleRevisionQueryRejected ||
    !entry.publication.oldHierarchyRetainedUntilSwap
  ) {
    failures.push(`${prefix}/${entry.viewId}/B${entry.blockSize}: publication atomicity failed.`);
  }
  if (entry.temperature === "first") {
    if (
      !entry.publication.stalePublicationAttempted ||
      !entry.publication.stalePublicationRejected
    ) {
      failures.push(
        `${prefix}/${entry.viewId}/B${entry.blockSize}: stale publication rejection was not proven.`,
      );
    }
  } else if (entry.publication.stalePublicationAttempted) {
    failures.push(
      `${prefix}/${entry.viewId}/B${entry.blockSize}: replacement attempted stale publication unexpectedly.`,
    );
  }
  if (!decisionSurface) return;
  if (!nonNegativeFinite(entry.buildDurationMs)) {
    failures.push(`${prefix}/${entry.viewId}/${entry.columnScope}: build duration is invalid.`);
  }
  if (entry.query.queryCount < SUMMARY_GATE_THRESHOLDS.minimumTimedQueriesPerSample) {
    failures.push(`${prefix}/${entry.viewId}/${entry.columnScope}: too few timed queries.`);
  }
  if (
    !nonNegativeFinite(entry.query.p95DurationMs) ||
    entry.query.p95DurationMs > SUMMARY_GATE_THRESHOLDS.queryP95MsMaximum
  ) {
    failures.push(`${prefix}/${entry.viewId}/${entry.columnScope}: query p95 exceeded 1 ms.`);
  }
  if (
    !nonNegativeFinite(entry.publication.readyToPublishDurationMs) ||
    entry.publication.readyToPublishDurationMs > SUMMARY_GATE_THRESHOLDS.readyToPublishMsMaximum
  ) {
    failures.push(`${prefix}/${entry.viewId}/${entry.columnScope}: publication exceeded 50 ms.`);
  }
  if (
    !nonNegativeFinite(entry.stagedReplacementPeakBytes) ||
    entry.stagedReplacementPeakBytes > SUMMARY_GATE_THRESHOLDS.stagedReplacementPeakBytesMaximum
  ) {
    failures.push(`${prefix}/${entry.viewId}/${entry.columnScope}: staged peak exceeded 128 MiB.`);
  }
  if (
    entry.columnScope === "all-eligible" &&
    (!nonNegativeFinite(entry.retainedBytes) ||
      entry.retainedBytes > SUMMARY_GATE_THRESHOLDS.allEligibleRetainedBytesMaximum)
  ) {
    failures.push(`${prefix}/${entry.viewId}: all-column retained hierarchy exceeded 64 MiB.`);
  }
  for (const column of entry.buildStats.columns) {
    if (
      !nonNegativeFinite(column.retainedBytes) ||
      column.retainedBytes > SUMMARY_GATE_THRESHOLDS.perColumnRetainedBytesMaximum
    ) {
      failures.push(`${prefix}/${entry.viewId}/${column.columnId}: column exceeded 8 MiB.`);
    }
  }
}

function includesAll(actual, expected) {
  const values = new Set(actual);
  return expected.every((entry) => values.has(entry));
}

function maximum(values) {
  return values.length === 0 ? null : Math.max(...values);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function nextPowerOfTwo(value) {
  return value <= 1 ? 1 : 2 ** Math.ceil(Math.log2(value));
}

function nonNegativeFinite(value) {
  return Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
