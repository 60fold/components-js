import type { GridData } from "@grid-interaction/types";
import type {
  GridSurfaceTelemetryEvent,
  GridSurfaceTelemetryPublishedEvent,
} from "@grid-interaction/telemetry";

export type GridInteractionProfileId = "narrow-10m" | "wide-1m";
export type GridInteractionScenario =
  "vertical-wheel" | "compressed-thumb" | "horizontal-wheel" | "resize-drag";

export interface GridInteractionConfiguration {
  readonly profile: GridInteractionProfileId;
  readonly scenario: GridInteractionScenario;
  readonly rowScale: number;
  readonly sampleIndex: number;
  readonly durationMs: number;
  readonly cadenceHz: number;
  readonly settleMs: number;
}

export interface GridInteractionGeneratedDataset {
  readonly data: GridData;
  readonly profile: {
    readonly id: GridInteractionProfileId;
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
}

export interface GridInteractionGeneratorInput {
  readonly type: "generate";
  readonly profile: GridInteractionProfileId;
  readonly rowScale: number;
}

export type GridInteractionGeneratorOutput =
  | ({ readonly type: "generated" } & GridInteractionGeneratedDataset)
  | { readonly type: "error"; readonly message: string; readonly stack?: string };

export type GridInteractionTelemetryEvent = GridSurfaceTelemetryEvent;
export type GridInteractionPublishedEvent = GridSurfaceTelemetryPublishedEvent;

export interface GridInteractionLongTask {
  readonly startTimeMs: number;
  readonly durationMs: number;
}

export interface GridInteractionGeometrySample {
  readonly observedAtMs: number;
  readonly rafIntervalMs: number | null;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly canvasDriftX: number;
  readonly canvasDriftY: number;
  readonly semanticDriftX: number;
  readonly semanticDriftY: number;
  readonly canvasSemanticDriftX: number;
  readonly canvasSemanticDriftY: number;
}

export interface GridInteractionDistribution {
  readonly count: number;
  readonly median: number | null;
  readonly p95: number | null;
  readonly maximum: number | null;
}

export interface GridInteractionPageResult {
  readonly configuration: GridInteractionConfiguration;
  readonly profile: GridInteractionGeneratedDataset["profile"];
  readonly trace: {
    readonly finalSettleMs: number;
  };
  readonly metrics: {
    readonly intentToPublicationMs: GridInteractionDistribution;
    readonly latestIntentLagMs: GridInteractionDistribution;
    readonly interPresentationMs: GridInteractionDistribution;
    readonly rafIntervalMs: GridInteractionDistribution;
    readonly runtimeFormatMs: GridInteractionDistribution;
    readonly paintMs: GridInteractionDistribution;
    readonly semanticMs: GridInteractionDistribution;
    readonly requestedToRuntimeReadyMs: GridInteractionDistribution;
    readonly runtimeReadyToPaintReceiptMs: GridInteractionDistribution;
    readonly paintReceiptToSemanticCompleteMs: GridInteractionDistribution;
    readonly semanticCompleteToRuntimeAckMs: GridInteractionDistribution;
    readonly runtimeAckToPublicationMs: GridInteractionDistribution;
    readonly achievedIntentHz: number | null;
    readonly longTaskObserverSupported: boolean;
    readonly wheelEventCount: number;
    readonly untrustedWheelEventCount: number;
    readonly allObservedWheelEventsTrusted: boolean | null;
    readonly intentCount: number;
    readonly requestedSurfaceCount: number;
    readonly publishedSurfaceCount: number;
    readonly droppedSurfaceCount: number;
    readonly runtimeCoalescedSurfaceDrops: number;
    readonly runtimeStaleSurfaceDrops: number;
    readonly coalescedIntentCount: number;
    readonly maximumSupersededIntentDepthAtPublication: number;
    readonly maximumConcurrentSurfaces: number;
    readonly maximumVisibleGeometryDriftPx: number;
    readonly maximumCanvasSemanticDriftDifferencePx: number;
    readonly finalSettledVisibleGeometryDriftPx: number;
    readonly maximumVisibleRows: number;
    readonly maximumVisibleColumns: number;
    readonly maximumCellCountProductMismatch: number;
    readonly unterminatedRequestedSurfaceCount: number;
    readonly multiplyTerminatedRequestedSurfaceCount: number;
    readonly duplicateSurfaceCorrelationCount: number;
    readonly orphanTerminalSurfaceCount: number;
    readonly horizontalFarLaneObserved: boolean | null;
    readonly horizontalReturnLaneObserved: boolean | null;
    readonly maximumLongTaskDurationMs: number | null;
  };
  readonly correctness: {
    readonly expectedProfileForScenario: boolean;
    readonly workerPaintPath: boolean;
    readonly workerRuntimePath: boolean;
    readonly logicalCompressionAsExpected: boolean;
    readonly endpointReached: boolean;
    readonly latestIntentPublished: boolean;
    readonly publicationIntentOrderMonotonic: boolean;
    readonly exactTerminalAccounting: boolean;
    readonly noRuntimeSurfaceDrops: boolean;
    readonly boundedViewportPayload: boolean;
    readonly horizontalEndpointLanes: boolean;
    readonly compressedLogicalCheckpoints: boolean;
    readonly trustedWheelInput: boolean;
    readonly stableSurfaceRoots: boolean;
    readonly noPaintError: boolean;
    readonly passed: boolean;
  };
  readonly failures: readonly string[];
}

export interface GridInteractionDriverGeometry {
  readonly scrollport: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly resizeHandle: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly maximumTop: number;
  readonly maximumLeft: number;
}

export interface GridInteractionControl {
  readonly begin: () => GridInteractionDriverGeometry;
  readonly setCompressedThumbFraction: (fraction: number) => void;
  readonly driverFinished: () => Promise<void>;
}

declare global {
  var __SIXTYFOLD_GRID_INTERACTION_STAGE__: string | undefined;
  var __SIXTYFOLD_GRID_INTERACTION_CONTROL__: GridInteractionControl | undefined;
  var __SIXTYFOLD_GRID_INTERACTION_RESULT__:
    GridInteractionPageResult | { readonly error: string } | undefined;
}
