import type { GridBenchmarkDataset, GridBenchmarkProfileMetadata } from "../../grid/src/contracts";

export type GridSummaryViewId = "identity" | "full-sort" | "filtered-sort-25pct";
export type GridSummaryColumnScopeId = "two-column" | "all-eligible";

export interface GridSummaryConfiguration {
  readonly profile: "narrow-10m";
  readonly rowScale: number;
  readonly sampleIndex: number;
  readonly caseOrderRotation: number;
  readonly repetitions: number;
  readonly blockSizes: readonly number[];
  readonly views: readonly GridSummaryViewId[];
  readonly columnScopes: readonly GridSummaryColumnScopeId[];
  readonly bandCount: number;
  readonly performanceQueryCount: number;
  readonly oracleRangeCount: number;
  readonly chunkSize: number;
  readonly cancellationDelayMs: number;
}

export interface GridSummaryViewPreparation {
  readonly viewId: GridSummaryViewId;
  readonly requestId: number;
  readonly viewRevision: number;
  readonly rowCount: number;
  readonly physicalRowsBytes: number;
  readonly filterBitmapBytes: number;
  readonly buildDurationMs: number;
  readonly effectiveKernel: "identity-no-permutation" | "generic" | "typed" | "hybrid";
}

export interface GridSummaryOracleRange {
  readonly start: number;
  readonly end: number;
  readonly kind: "full" | "partition" | "block-edge" | "singleton" | "empty";
}

export interface GridSummaryOracleValidation {
  readonly passed: boolean;
  readonly ranges: number;
  readonly summariesCompared: number;
  readonly rawRowsScanned: number;
  readonly firstFailure: string | null;
  readonly digest: string;
  readonly digestAlgorithm: "fnv1a32-summary-v1";
}

export interface GridSummaryQueryMetrics {
  readonly batchDurationMs: number;
  readonly queryCount: number;
  readonly p50DurationMs: number;
  readonly p95DurationMs: number;
  readonly maximumDurationMs: number;
  readonly nodeVisits: number;
  readonly rawRowsScanned: number;
  readonly summaryVertices: number;
  readonly maximumNodeVisits: number;
  readonly maximumRawRowsScanned: number;
  readonly structuralChecks: number;
  readonly structuralBoundsPassed: boolean;
  readonly firstStructuralFailure: string | null;
}

export interface GridSummaryBandPayloadLedger {
  readonly bandsRequested: number;
  readonly columnsRequested: number;
  readonly summaries: number;
  readonly maximumSummaries: number;
  readonly summaryVertices: number;
  readonly boundedByBandAndColumnCount: boolean;
}

export interface GridSummaryBuildSample {
  readonly viewId: GridSummaryViewId;
  readonly columnScope: GridSummaryColumnScopeId;
  readonly columnIds: readonly string[];
  readonly blockSize: number;
  readonly repetition: number;
  readonly temperature: "first" | "replacement";
  readonly requestId: number;
  readonly dataRevision: number;
  readonly viewRevision: number;
  readonly rowCount: number;
  readonly buildDurationMs: number;
  readonly buildStats: {
    readonly leafBuildDurationMs: number;
    readonly mergeBuildDurationMs: number;
    readonly totalBuildDurationMs: number;
    readonly yieldCount: number;
    readonly retainedBytes: number;
    readonly previousRetainedBytes: number;
    readonly scratchPeakBytes: number;
    readonly stagedReplacementPeakBytes: number;
    readonly columns: readonly {
      readonly columnId: string;
      readonly kind: "numeric" | "category";
      readonly retainedBytes: number;
      readonly leafNodes: number;
      readonly interiorNodes: number;
    }[];
  };
  readonly retainedBytes: number;
  readonly retainedBytesPerActiveRow: number;
  readonly stagedReplacementPeakBytes: number;
  readonly query: GridSummaryQueryMetrics;
  readonly oracle: GridSummaryOracleValidation;
  readonly payload: GridSummaryBandPayloadLedger;
  readonly publication: {
    readonly published: boolean;
    readonly readyToPublishDurationMs: number;
    readonly stalePublicationAttempted: boolean;
    readonly stalePublicationRejected: boolean | null;
    readonly staleRevisionQueryRejected: boolean;
    readonly oldHierarchyRetainedUntilSwap: boolean;
  };
}

export interface GridSummaryCancellationResult {
  readonly kind: "build" | "query-batch";
  readonly trigger: string;
  readonly cancellationDelayMs: number;
  readonly progressAtSignal: number;
  readonly totalAtSignal: number;
  readonly progressSignalToDispatchMs: number;
  readonly dispatchToWorkerReceiptMs: number;
  readonly workerReceiptToCancellationMs: number;
  readonly dispatchToCancellationMs: number;
  readonly obsoleteStatus: "cancelled" | "complete" | "error";
  readonly obsoletePublicationAttempted: boolean;
  readonly stalePublications: number;
  readonly candidateRetainedBytesAfterCancel: number;
  readonly releasedCandidateBytes: number;
  readonly peakCandidateBytes: number;
  readonly stagedReplacementPeakBytes: number;
  readonly expectedActiveRetainedBytes: number;
  readonly observedActiveRetainedBytes: number;
  readonly activeDigestMatchesReference: boolean;
  readonly replacementCompleted: boolean;
  readonly replacementDigestMatchesReference: boolean;
  readonly replacementMatchesIndependentOracle: boolean;
}

export interface GridSummaryWorkerResult {
  readonly profile: GridBenchmarkProfileMetadata;
  readonly installation: {
    readonly preflightDurationMs: number;
    readonly storeAdoptionDurationMs: number;
    readonly storeInstallDurationMs: number;
    readonly installedBufferCount: number;
    readonly transferredArrayBufferBytes: number;
    readonly retainedTypedArrayBytes: number;
  };
  readonly viewPreparation: readonly GridSummaryViewPreparation[];
  readonly samples: readonly GridSummaryBuildSample[];
  readonly cancellation: readonly GridSummaryCancellationResult[];
  readonly edgeFixtureOracle: {
    readonly passed: boolean;
    readonly cases: number;
    readonly comparisons: number;
    readonly blockSizes: readonly number[];
    readonly coversNulls: boolean;
    readonly coversNaN: boolean;
    readonly coversInfinities: boolean;
    readonly coversSignedZero: boolean;
    readonly coversTiedExtrema: boolean;
    readonly coversCategoryOverflow: boolean;
    readonly coversMergeShapes: boolean;
    readonly firstFailure: string | null;
  };
  readonly editInvalidation: {
    readonly status: "passed" | "failed" | "unsupported";
    readonly numericEditChecked: boolean;
    readonly categoryEditChecked: boolean;
    readonly staleIndexRejected: boolean;
    readonly candidatePrivacyChecked: boolean;
    readonly categoryWitnessTransitionChecked: boolean;
    readonly sortedFilteredMappingChecked: boolean;
    readonly summaryMatchedRawOracle: boolean;
    readonly durationMs: number | null;
    readonly caveat: string;
  };
  readonly exactLedger: {
    readonly installedTypedArrayBytes: number;
    readonly viewPermutationBytes: number;
    readonly viewFilterBitmapBytes: number;
    readonly retainedHierarchyBytesAfterCombinationRelease: readonly number[];
    readonly maximumRetainedHierarchyBytes: number;
    readonly maximumStagedReplacementPeakBytes: number;
    readonly hierarchyBytesAreExact: boolean;
    readonly sampledBrowserMemoryIsNotExact: boolean;
  };
  readonly correctness: {
    readonly rawOraclePassed: boolean;
    readonly allCandidatesPublished: boolean;
    readonly noStalePublications: boolean;
    readonly payloadsBounded: boolean;
    readonly cancellationPassed: boolean;
    readonly exactLedgerInternallyConsistent: boolean;
    readonly passed: boolean;
  };
  readonly failures: readonly string[];
}

export interface BrowserGridSummaryResult extends GridSummaryWorkerResult {
  readonly configuration: GridSummaryConfiguration;
}

export type GridSummaryWorkerInput =
  | {
      readonly type: "init";
      readonly configuration: GridSummaryConfiguration;
      readonly dataset: GridBenchmarkDataset;
    }
  | { readonly type: "run" }
  | {
      readonly type: "cancel";
      readonly token: number;
      readonly dispatchedAtEpochMs: number;
    };

export type GridSummaryWorkerOutput =
  | { readonly type: "ready"; readonly installation: GridSummaryWorkerResult["installation"] }
  | { readonly type: "stage"; readonly stage: string }
  | {
      readonly type: "cancellation-armed";
      readonly token: number;
      readonly kind: "build" | "query-batch";
      readonly progress: number;
      readonly total: number;
      readonly armedAtEpochMs: number;
      readonly delayMs: number;
    }
  | { readonly type: "complete"; readonly result: GridSummaryWorkerResult }
  | { readonly type: "error"; readonly message: string; readonly stack?: string };

declare global {
  var __SIXTYFOLD_GRID_SUMMARY_STAGE__: string | undefined;
  var __SIXTYFOLD_GRID_SUMMARY_RESULT__:
    BrowserGridSummaryResult | { readonly error: string } | undefined;
}
