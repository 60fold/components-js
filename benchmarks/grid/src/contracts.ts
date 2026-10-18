import type { GridData, GridViewSpec } from "@grid-benchmark/types";

export type GridBenchmarkProfileId = "narrow-10m" | "wide-1m";
export type GridBenchmarkOrdinaryCaseId =
  "filter-numeric" | "filter-category" | "sort-1-key" | "filter-sort-3-key-25pct";
export type GridBenchmarkCaseId = GridBenchmarkOrdinaryCaseId | "builder-cancellation-replacement";
export type GridBenchmarkCadenceMode = "production" | "custom";

export interface GridBenchmarkConfiguration {
  readonly profile: GridBenchmarkProfileId;
  readonly rowScale: number;
  readonly repetitions: number;
  readonly cases: readonly GridBenchmarkCaseId[];
  readonly cancellationDelayMs: number;
  /** Explicitly passed to the builder; the harness never inherits a transient default. */
  readonly chunkSize: number;
  readonly cadenceMode: GridBenchmarkCadenceMode;
  readonly cadenceDescription: string;
}

export interface GridBenchmarkDataset {
  readonly data: GridData;
  readonly profile: GridBenchmarkProfileMetadata;
  readonly cases: Readonly<Record<GridBenchmarkOrdinaryCaseId, GridViewSpec>>;
  readonly transfer: {
    readonly buffers: readonly ArrayBuffer[];
    readonly bytes: number;
  };
}

export interface GridBenchmarkProfileMetadata {
  readonly id: GridBenchmarkProfileId;
  readonly declaredRows: number;
  readonly rows: number;
  readonly rowScale: number;
  readonly logicalColumns: number;
  readonly visibleColumns: number;
  readonly stableRowIds: "implicit-physical-index";
  readonly dataTypes: Readonly<Record<string, number>>;
  readonly nullDensity: number;
  readonly installedTypedArrayBytes: number;
  readonly syntheticGeneratedTypedArrayBytes: number;
  readonly notes: readonly string[];
}

export interface GridBenchmarkOracleValidation {
  readonly scope: "full-result-independent-formula-oracle";
  readonly passed: boolean;
  readonly expectedRowCount: number;
  readonly actualRowCount: number;
  readonly inspectedPhysicalRows: number;
  readonly inspectedBitmapRows: number;
  readonly inspectedAdjacentPairs: number;
  readonly physicalRowsInBounds: boolean;
  readonly physicalRowsUnique: boolean;
  readonly membershipMatchesPredicate: boolean;
  readonly bitmapMatchesPredicate: boolean;
  readonly bitmapUnusedBitsClear: boolean;
  readonly orderMatchesSpec: boolean;
  readonly stablePhysicalTieBreak: boolean;
  readonly firstFailure: string | null;
}

export interface GridBenchmarkBufferLedger {
  readonly publishedPhysicalRowsBytes: number;
  readonly publishedFilterBitmapBytes: number;
  readonly publishedCandidateBytes: number;
  /** Current source-derived lower bound; excludes engine/allocator overhead. */
  readonly knownBuilderScratchPeakBytesLowerBound: number;
  readonly knownBuilderScratchComponents: Readonly<Record<string, number>>;
  readonly oracleVerificationScratchBytes: number;
  readonly caveat: string;
}

export interface GridBenchmarkSample {
  readonly caseId: GridBenchmarkOrdinaryCaseId;
  readonly repetition: number;
  readonly temperature: "first" | "warm";
  readonly executionSequence: number;
  /** Wall time of one asynchronous active-view builder invocation. */
  readonly builderInvocationDurationMs: number;
  /** Untimed full-result fingerprint plus independent-oracle validation. */
  readonly verificationDurationMs: number;
  readonly rowCount: number;
  readonly fullResultHash: string;
  readonly fullResultHashAlgorithm: "fnv1a32-pair-v1";
  readonly oracle: GridBenchmarkOracleValidation;
  readonly buffers: GridBenchmarkBufferLedger;
  readonly progressEvents: number;
  readonly lastProgress: {
    readonly phase: "filter" | "sort";
    readonly completed: number;
    readonly total: number;
  } | null;
}

export interface GridBenchmarkBuilderCancellation {
  readonly scope: "active-view-builder-only";
  readonly trigger: "worker-message-after-sort-progress-chunk";
  readonly configuredCancellationDelayMs: number;
  readonly sortProgressAtSignalRequest: {
    readonly phase: "sort";
    readonly completed: number;
    readonly total: number;
    readonly requiredCompleted: number;
    readonly observedAfterBuilderStartMs: number;
  };
  /** Worker progress signal to host dispatch, including any configured delay. */
  readonly progressSignalToCancellationDispatchMs: number;
  /** Host postMessage dispatch to the worker's supersede-message handler. */
  readonly cancellationDispatchToWorkerReceiptMs: number;
  /** Worker supersede-message handler to the builder returning cancelled. */
  readonly cancellationReceiptToBuilderCancellationMs: number;
  /** Host postMessage dispatch to the builder returning cancelled. Used by the 50 ms gate. */
  readonly cancellationDispatchToBuilderCancellationMs: number;
  readonly obsoleteBuilderResultStatus: "cancelled";
  readonly obsoleteBuilderInvocationDurationMs: number;
  readonly hostPublicationAttempted: false;
  readonly replacementBuilderInvocationDurationMs: number;
  readonly replacementFullResultHash: string;
  readonly replacementRows: number;
  readonly referenceFullResultHash: string;
  readonly referenceRows: number;
  readonly replacementHashMatchesReference: boolean;
  readonly replacementRowCountMatchesReference: boolean;
  readonly replacementOracle: GridBenchmarkOracleValidation;
}

export interface WorkerBenchmarkResult {
  readonly profile: GridBenchmarkProfileMetadata;
  readonly samples: readonly GridBenchmarkSample[];
  readonly builderCancellation: readonly GridBenchmarkBuilderCancellation[];
  readonly summaries: readonly GridBenchmarkCaseSummary[];
  readonly correctness: {
    readonly fullHashesMatchAcrossRepetitions: boolean;
    readonly independentOraclePassed: boolean;
    readonly replacementChecksPassed: boolean;
    readonly exactResultValidationPassed: boolean;
  };
  readonly failures: readonly string[];
}

export interface GridBenchmarkCaseSummary {
  readonly caseId: GridBenchmarkOrdinaryCaseId;
  readonly samples: number;
  readonly firstMs: number;
  readonly warmMs: readonly number[];
  readonly warmSampleCount: number;
  readonly warmMinMs: number | null;
  readonly warmMedianMs: number | null;
  /** Null until at least 20 warm samples exist. */
  readonly warmP95Ms: number | null;
  readonly warmP95MinimumSamples: 20;
  readonly warmMaxMs: number | null;
  readonly fullResultHash: string;
  readonly rowCount: number;
}

export type BenchmarkWorkerInput =
  | {
      readonly type: "init";
      readonly configuration: GridBenchmarkConfiguration;
      readonly dataset: GridBenchmarkDataset;
    }
  | { readonly type: "run" }
  | {
      readonly type: "supersede";
      readonly token: number;
      readonly dispatchedAtEpochMs: number;
    };

export type BenchmarkWorkerOutput =
  | {
      readonly type: "ready";
    }
  | {
      readonly type: "stage";
      readonly stage: string;
    }
  | {
      readonly type: "builder-cancellation-armed";
      readonly token: number;
      readonly delayMs: number;
      readonly sortProgress: {
        readonly phase: "sort";
        readonly completed: number;
        readonly total: number;
        readonly requiredCompleted: number;
      };
    }
  | {
      readonly type: "complete";
      readonly result: WorkerBenchmarkResult;
    }
  | { readonly type: "error"; readonly message: string; readonly stack?: string };

declare global {
  var __SIXTYFOLD_GRID_BENCHMARK_STAGE__: string | undefined;
  var __SIXTYFOLD_GRID_BENCHMARK_RESULT__: BrowserGridBenchmarkResult | undefined;
}

export interface BrowserGridBenchmarkResult extends WorkerBenchmarkResult {
  readonly configuration: GridBenchmarkConfiguration;
}
