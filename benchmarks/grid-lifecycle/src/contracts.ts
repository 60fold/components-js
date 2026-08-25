import type { GridData, GridDiagnostics } from "@grid-benchmark/types";

export type GridLifecycleProfileId = "narrow-10m" | "wide-1m";
export type GridLifecycleOwnership = "transfer" | "copy";
export type GridLifecyclePass = "latency" | "memory";
export type GridLifecycleRowIdMode = "implicit" | "explicit-number";

export interface GridLifecycleConfiguration {
  readonly profile: GridLifecycleProfileId;
  readonly rowScale: number;
  readonly ownership: GridLifecycleOwnership;
  readonly pass: GridLifecyclePass;
  readonly rowIdMode: GridLifecycleRowIdMode;
  readonly sampleIndex: number;
  readonly postDestroySettleMs: number;
}

export interface GridLifecycleGeneratedDataset {
  readonly data: GridData;
  readonly profile: {
    readonly id: GridLifecycleProfileId;
    readonly declaredRows: number;
    readonly rows: number;
    readonly rowScale: number;
    readonly logicalColumns: number;
    readonly visibleColumns: number;
    readonly stableRowIds: string;
    readonly dataTypes: Readonly<Record<string, number>>;
    readonly nullDensity: number;
    readonly installedTypedArrayBytes: number;
    readonly syntheticGeneratedTypedArrayBytes: number;
    readonly notes: readonly string[];
  };
  readonly sourceBufferCount: number;
  readonly sourceUniqueArrayBufferBytes: number;
  readonly oracle: {
    readonly sortColumnId: string;
    readonly firstSortedValues: readonly number[];
    readonly physicalRowZeroValue: number | null;
    readonly physicalRowZeroRowId: number | null;
  };
}

export type GridLifecycleGeneratorInput = {
  readonly type: "generate";
  readonly profile: GridLifecycleProfileId;
  readonly rowScale: number;
  readonly ownership: GridLifecycleOwnership;
  readonly rowIdMode: GridLifecycleRowIdMode;
  readonly generation: number;
};

export type GridLifecycleGeneratorOutput =
  | ({ readonly type: "generated" } & GridLifecycleGeneratedDataset)
  | { readonly type: "error"; readonly message: string; readonly stack?: string };

export type GridLifecycleDiagnostics = GridDiagnostics;

export interface GridLifecycleUaMemoryResult {
  readonly status: "available" | "unsupported" | "error" | "not-sampled";
  readonly bytes: number | null;
}

export interface GridLifecycleMemorySample {
  readonly label: string;
  readonly measuredAtMs: number;
  readonly userAgentSpecific: GridLifecycleUaMemoryResult;
}

export interface GridLifecycleLongTask {
  readonly startTimeMs: number;
  readonly durationMs: number;
}

export interface GridLifecycleResponsivenessPhase {
  readonly phase: "initial-set-data" | "replacement-set-data" | "sort";
  readonly samples: number;
  readonly maximumWorkerHeartbeatDelayMs: number | null;
  readonly p95WorkerHeartbeatDelayMs: number | null;
  readonly maximumLongTaskDurationMs: number | null;
}

export interface GridLifecycleExactLedger {
  readonly inputTypedArrayBytes: number;
  readonly inputArrayBufferCount: number;
  readonly runtimeStoreInstalledReferencedBytes: number;
  readonly runtimeIngressTransferListBytes: number;
  readonly runtimeIngressTransferListCount: number;
  readonly callerRetainedInputBytesAtSteadyCheckpoint: number;
  readonly activeSortPermutationBytes: number;
  readonly hostPublishedSortPermutationBytes: 0;
  readonly hostInversePermutationBytes: number;
  readonly potentialWorkerInversePermutationBytes: number;
  readonly potentialWorkerInverseIncludedInLowerBounds: false;
  readonly workerSortScratchPermutationBytes: number;
  readonly workerRadixCountsBytes: number;
  readonly knownSortScratchBytesLowerBound: number;
  readonly boundedPaintFrameTypedArrayBytes: number;
  readonly explicitRowIdTypedArrayBytes: number;
  readonly runtimeValidationUniquenessSetIncludedInLowerBounds: false;
  readonly runtimeRowIdIndexMapIncludedInLowerBounds: false;
  readonly initialKnownPeakBytesLowerBound: number;
  readonly sortedSteadyKnownBytesLowerBound: number;
  readonly replacementKnownPeakBytesLowerBound: number;
  readonly ownershipAssumptions: readonly string[];
  readonly caveat: string;
}

export interface GridLifecycleTimings {
  readonly gridInitializeMs: number;
  readonly initialSetDataCallReturnMs: number;
  readonly initialSetDataSettledMs: number;
  readonly initialSetDataToViewportCallbackMs: number;
  readonly initialHostIngressMs: number | null;
  readonly immediateSortSetViewSettledMs: number;
  readonly reportedWorkerBuildMs: number | null;
  readonly firstSortNonBuilderOverheadMs: number | null;
  readonly replacementSetDataCallReturnMs: number;
  readonly replacementSetDataSettledMs: number;
  readonly replacementSetDataToViewportCallbackMs: number;
  readonly replacementHostIngressMs: number | null;
  readonly destroyStartedAtEpochMs: number;
  readonly destroySyncMs: number;
}

export interface GridLifecycleSurfaceRecord {
  readonly source: string;
  readonly observedAtMs: number;
  readonly datasetId: string | null;
  readonly viewRevision: number;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly columnStart: number;
  readonly columnEnd: number;
}

export interface GridLifecyclePageResult {
  readonly configuration: GridLifecycleConfiguration;
  readonly profile: GridLifecycleGeneratedDataset["profile"];
  readonly timings: GridLifecycleTimings;
  readonly exactLedger: GridLifecycleExactLedger;
  readonly memorySamples: readonly GridLifecycleMemorySample[];
  readonly responsiveness: readonly GridLifecycleResponsivenessPhase[];
  readonly workerTracking: {
    readonly constructed: number;
    readonly terminateCalls: number;
    readonly activeAfterDestroy: number;
    readonly urls: readonly string[];
  };
  readonly correctness: {
    readonly workerPaintPath: boolean;
    readonly workerViewPath: boolean;
    readonly canonicalWorkerOwnership: boolean;
    readonly boundedWorkerFormattedPaintPath: boolean;
    readonly replacementCandidateStayedPrivate: boolean;
    readonly rawSurfaceConfirmed: boolean;
    readonly sortedSurfaceConfirmed: boolean;
    readonly sortedVisibleValuesMatchOracle: boolean;
    readonly replacementSurfaceConfirmed: boolean;
    readonly replacementMarkerValueMatchesOracle: boolean;
    readonly replacementFocusedRowIdMatchesOracle: boolean;
    readonly semanticCountsMatch: boolean;
    readonly transferInputsDetached: boolean | null;
    readonly copyInputsRetained: boolean | null;
    readonly noPaintError: boolean;
    readonly passed: boolean;
  };
  readonly failures: readonly string[];
  readonly browser: {
    readonly userAgent: string;
    readonly hardwareConcurrency: number;
    readonly deviceMemoryGiB: number | null;
    readonly crossOriginIsolated: boolean;
    readonly isSecureContext: boolean;
    readonly devicePixelRatio: number;
    readonly viewport: { readonly width: number; readonly height: number };
  };
}

declare global {
  var __SIXTYFOLD_GRID_LIFECYCLE_STAGE__: string | undefined;
  var __SIXTYFOLD_GRID_LIFECYCLE_RESULT__: GridLifecyclePageResult | { error: string } | undefined;
}
