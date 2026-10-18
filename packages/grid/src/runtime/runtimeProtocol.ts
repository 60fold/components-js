import type { GridColumnDescriptor } from "../data/store.js";
import type { GridColumnLayout, GridLayout, VisibleGridRange } from "../rendering/layout.js";
import type {
  GridPaintFrame,
  GridPaintPalette,
  GridPaintRevision,
} from "../rendering/paintProtocol.js";
import type {
  CellScalar,
  EditCommitLeaseResult,
  GridData,
  GridDataInstallResult,
  GridRangeSelection,
  GridViewSpec,
  RowId,
} from "../types.js";

export type GridRuntimePublicationKind = "data" | "view" | "edit" | "presentation";

export interface GridRuntimeDatasetDescriptor {
  readonly datasetId: string;
  readonly dataRevision: number;
  readonly rowCount: number;
  readonly columns: readonly GridColumnDescriptor[];
  readonly installResult: GridDataInstallResult;
}

/** Bounded diagnostics for the private hierarchy installed with one snapshot. */
export interface GridRuntimeSummaryBuildMetadata {
  readonly blockSize: 256;
  readonly columnCount: number;
  readonly buildDurationMs: number;
  readonly retainedBytes: number;
  readonly stagedReplacementPeakBytes: number;
}

export interface GridRuntimeInstallMessage {
  readonly type: "install";
  readonly requestId: number;
  readonly dataRevision: number;
  /**
   * Call-time metadata snapshot whose non-shared buffers are already private
   * runtime ingress ownership. The worker remains the sole deep validator.
   */
  readonly data: GridData;
  /**
   * Opt-in exact-summary columns owned by the canonical runtime worker.
   * Unsupported or duplicate configured columns reject the install.
   */
  readonly summaryColumnIds?: readonly string[];
}

export interface GridRuntimeSetViewMessage {
  readonly type: "setView";
  readonly requestId: number;
  readonly datasetId: string;
  readonly viewRevision: number;
  readonly spec: GridViewSpec;
}

export type GridRuntimeSurfaceTarget =
  | { readonly kind: "active" }
  | { readonly kind: "install"; readonly requestId: number }
  | { readonly kind: "view"; readonly requestId: number }
  | { readonly kind: "edit"; readonly operationId: string };

/**
 * Bounded presentation input. It contains viewport geometry and host interaction
 * state, never column buffers or an active-view permutation.
 */
export interface GridRuntimeSurfaceMessage {
  readonly type: "surface";
  readonly surfaceId: number;
  readonly commitToken: string;
  readonly source: "scroll" | "resize" | "data" | "view" | "api";
  readonly target: GridRuntimeSurfaceTarget;
  readonly revision: GridPaintRevision;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly pixelRatio: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly range: VisibleGridRange;
  readonly layout: GridLayout;
  readonly columnLayout: GridColumnLayout;
  readonly rowNumberWidth: number;
  readonly rowNumberLabel: string;
  readonly minColumnWidth: number;
  readonly maxColumnWidth: number;
  readonly palette: GridPaintPalette;
  readonly selection: GridRangeSelection | null;
  readonly focusedRowIndex: number;
  readonly focusedColumnIndex: number;
}

export interface GridRuntimeFinalizeSurfaceMessage {
  readonly type: "finalizeSurface";
  readonly surfaceId: number;
  readonly commitToken: string;
}

export interface GridRuntimeDropSurfaceMessage {
  readonly type: "dropSurface";
  readonly surfaceId: number;
  readonly commitToken: string;
}

export interface GridRuntimeCancelMessage {
  readonly type: "cancel";
  readonly scope: "install" | "view";
  readonly requestId: number;
}

export interface GridRuntimeResolveRowMessage {
  readonly type: "resolveRow";
  readonly queryId: number;
  readonly datasetId: string;
  readonly rowId: RowId;
}

export interface GridRuntimeResolveOrdinalMessage {
  readonly type: "resolveOrdinal";
  readonly queryId: number;
  readonly datasetId: string;
  readonly viewOrdinal: number;
}

export interface GridRuntimeInspectCellMessage {
  readonly type: "inspectCell";
  readonly queryId: number;
  readonly datasetId: string;
  readonly rowId: RowId;
  readonly columnId: string;
}

/**
 * One configured column over one or more active-view ranges. `ranges` stores
 * aligned `[start, end)` pairs and is capped at 2,048 bands. The hierarchy and
 * active-view permutation never cross this boundary.
 */
export interface GridRuntimeQuerySummaryMessage {
  readonly type: "querySummary";
  readonly queryId: number;
  readonly datasetId: string;
  readonly dataRevision: number;
  readonly viewRevision: number;
  readonly columnId: string;
  readonly ranges: Uint32Array;
}

export interface GridRuntimeCancelSummaryMessage {
  readonly type: "cancelSummary";
  readonly queryId: number;
}

export interface GridRuntimeParseEditMessage {
  readonly type: "parseEdit";
  readonly operationId: string;
  readonly datasetId: string;
  readonly rowId: RowId;
  readonly columnId: string;
  readonly raw: string;
  readonly explicitNull: boolean;
}

export interface GridRuntimeReserveEditMessage {
  readonly type: "reserveEdit";
  readonly operationId: string;
  readonly datasetId: string;
  readonly rowId: RowId;
  readonly columnId: string;
  readonly cellRevision: number;
  readonly previousValue: CellScalar | null;
  readonly finalValue: CellScalar | null;
}

export interface GridRuntimeCancelEditMessage {
  readonly type: "cancelEdit";
  readonly operationId: string;
}

export interface GridRuntimeApplyEditMessage {
  readonly type: "applyEdit";
  readonly operationId: string;
  readonly leaseId: string;
}

export interface GridRuntimeDiscardEditMessage {
  readonly type: "discardEdit";
  readonly operationId: string;
}

export interface GridRuntimeDisposeMessage {
  readonly type: "dispose";
}

export type GridRuntimeInputMessage =
  | GridRuntimeInstallMessage
  | GridRuntimeSetViewMessage
  | GridRuntimeSurfaceMessage
  | GridRuntimeFinalizeSurfaceMessage
  | GridRuntimeDropSurfaceMessage
  | GridRuntimeCancelMessage
  | GridRuntimeResolveRowMessage
  | GridRuntimeResolveOrdinalMessage
  | GridRuntimeInspectCellMessage
  | GridRuntimeQuerySummaryMessage
  | GridRuntimeCancelSummaryMessage
  | GridRuntimeParseEditMessage
  | GridRuntimeReserveEditMessage
  | GridRuntimeCancelEditMessage
  | GridRuntimeApplyEditMessage
  | GridRuntimeDiscardEditMessage
  | GridRuntimeDisposeMessage;

export interface GridRuntimeReadyMessage {
  readonly type: "ready";
}

export interface GridRuntimeInstallProgressMessage {
  readonly type: "installProgress";
  readonly requestId: number;
  readonly dataRevision: number;
  readonly completed: number;
  readonly total: number;
}

export interface GridRuntimeInstallReadyMessage {
  readonly type: "installReady";
  readonly requestId: number;
  readonly descriptor: GridRuntimeDatasetDescriptor;
  readonly installDurationMs: number;
  readonly summary: GridRuntimeSummaryBuildMetadata;
}

export interface GridRuntimeViewProgressMessage {
  readonly type: "viewProgress";
  readonly requestId: number;
  readonly datasetId: string;
  readonly viewRevision: number;
  readonly phase: "filter" | "sort";
  readonly completed: number;
  readonly total: number;
}

export interface GridRuntimeViewReadyMessage {
  readonly type: "viewReady";
  readonly requestId: number;
  readonly datasetId: string;
  readonly viewRevision: number;
  readonly spec: GridViewSpec;
  readonly rowCount: number;
  readonly buildDurationMs: number;
  readonly summary: GridRuntimeSummaryBuildMetadata;
}

/** The only row-sized payload crossing from the canonical runtime to the host. */
export interface GridRuntimeSurfaceReadyMessage {
  readonly type: "surfaceReady";
  readonly surfaceId: number;
  readonly commitToken: string;
  readonly source: GridRuntimeSurfaceMessage["source"];
  readonly target: GridRuntimeSurfaceTarget;
  readonly frame: GridPaintFrame;
  /** Stable identities aligned with `frame.rows`; always viewport bounded. */
  readonly visibleRowIds: readonly RowId[];
  readonly rowCount: number;
  readonly columnCount: number;
  readonly formatDurationMs: number;
}

export interface GridRuntimePublishedMessage {
  readonly type: "published";
  readonly surfaceId: number;
  readonly commitToken: string;
  readonly publicationKind: GridRuntimePublicationKind;
  readonly descriptor: GridRuntimeDatasetDescriptor;
  readonly viewRevision: number;
  readonly spec: GridViewSpec;
  readonly rowCount: number;
  readonly summary: GridRuntimeSummaryBuildMetadata;
}

export interface GridRuntimeSurfaceDroppedMessage {
  readonly type: "surfaceDropped";
  readonly surfaceId: number;
  readonly commitToken: string;
  readonly reason: "host" | "coalesced" | "stale";
}

export interface GridRuntimeCancelledMessage {
  readonly type: "cancelled";
  readonly scope: "install" | "view";
  readonly requestId: number;
}

export interface GridRuntimeResolvedRowMessage {
  readonly type: "resolvedRow";
  readonly queryId: number;
  readonly datasetId: string;
  readonly rowId: RowId;
  readonly physicalRow: number;
  readonly viewOrdinal: number;
}

export interface GridRuntimeResolvedOrdinalMessage {
  readonly type: "resolvedOrdinal";
  readonly queryId: number;
  readonly datasetId: string;
  readonly viewOrdinal: number;
  /** `-1` when the requested ordinal is outside the active view. */
  readonly physicalRow: number;
  /** `null` when the requested ordinal is outside the active view. */
  readonly rowId: RowId | null;
}

export interface GridRuntimeCellInspectedMessage {
  readonly type: "cellInspected";
  readonly queryId: number;
  readonly datasetId: string;
  readonly rowId: RowId;
  readonly columnId: string;
  readonly descriptor: GridColumnDescriptor;
  readonly value: CellScalar | null;
  readonly cellRevision: number;
  /** Present only for editable categorical cells. */
  readonly categoryValues?: readonly string[];
}

interface GridRuntimeSummaryReadyBase {
  readonly type: "summaryReady";
  readonly queryId: number;
  readonly datasetId: string;
  readonly dataRevision: number;
  readonly viewRevision: number;
  readonly columnId: string;
  readonly exact: true;
  readonly bandCount: number;
  /** Exact echoed `[start, end)` pairs aligned with every result array. */
  readonly ranges: Uint32Array;
  readonly rowCounts: Uint32Array;
  readonly nullCounts: Uint32Array;
  /** Aggregate exact hierarchy work across every band. */
  readonly nodeVisits: number;
  /** Aggregate exact raw boundary rows across every band. */
  readonly rawRowsScanned: number;
  /** Aggregate exact output summary vertices across every band. */
  readonly summaryVertices: number;
  /** Worker elapsed time including bounded cooperative query yields. */
  readonly queryDurationMs: number;
  /** Exact bytes across the response's typed-array fields only. */
  readonly typedPayloadBytes: number;
}

export interface GridRuntimeNumericSummaryReadyMessage extends GridRuntimeSummaryReadyBase {
  readonly kind: "numeric";
  readonly finiteCounts: Uint32Array;
  readonly nanCounts: Uint32Array;
  readonly positiveInfinityCounts: Uint32Array;
  readonly negativeInfinityCounts: Uint32Array;
  readonly finiteMinimumValues: Float64Array;
  readonly finiteMaximumValues: Float64Array;
  /** `0xffff_ffff` when the corresponding finite extremum is absent. */
  readonly finiteMinimumViewOrdinals: Uint32Array;
  /** `0xffff_ffff` when the corresponding finite extremum is absent. */
  readonly finiteMaximumViewOrdinals: Uint32Array;
  readonly finiteMinimumRowIds: readonly (RowId | null)[];
  readonly finiteMaximumRowIds: readonly (RowId | null)[];
}

export interface GridRuntimeCategorySummaryReadyMessage extends GridRuntimeSummaryReadyBase {
  readonly kind: "category";
  /** Number of public exemplars in each band, from zero through four. */
  readonly exemplarCounts: Uint8Array;
  /** Four fixed slots per band; only `exemplarCounts[band]` slots are live. */
  readonly exemplarCodes: Uint32Array;
  /** Four fixed slots per band; only `exemplarCounts[band]` slots are live. */
  readonly exemplarViewOrdinals: Uint32Array;
  /** Four fixed slots per band; only `exemplarCounts[band]` slots are live. */
  readonly exemplarRowIds: readonly (RowId | null)[];
  /** Deduplicated labels actually referenced by this response. */
  readonly labels: readonly string[];
  /** Four fixed slots per band indexing `labels`; unused slots are `0xffff_ffff`. */
  readonly exemplarLabelIndexes: Uint32Array;
  /** One means the four public exemplars cover every distinct non-null code. */
  readonly complete: Uint8Array;
}

export type GridRuntimeSummaryReadyMessage =
  GridRuntimeNumericSummaryReadyMessage | GridRuntimeCategorySummaryReadyMessage;

export interface GridRuntimeSummaryCancelledMessage {
  readonly type: "summaryCancelled";
  readonly queryId: number;
  readonly reason: "host" | "stale";
}

export interface GridRuntimeEditParsedMessage {
  readonly type: "editParsed";
  readonly operationId: string;
  readonly value: CellScalar | null;
}

export interface GridRuntimeEditLeaseMessage {
  readonly type: "editLease";
  readonly operationId: string;
  readonly result: EditCommitLeaseResult;
}

export interface GridRuntimeEditProgressMessage {
  readonly type: "editProgress";
  readonly operationId: string;
  readonly phase: "filter" | "sort";
  readonly completed: number;
  readonly total: number;
}

export interface GridRuntimeEditReadyMessage {
  readonly type: "editReady";
  readonly operationId: string;
  readonly datasetId: string;
  readonly dataRevision: number;
  readonly viewRevision: number;
  readonly rowCount: number;
  /** Candidate active-view ordinal for the edited RowId, or -1 when filtered out. */
  readonly editedRowIndex: number;
  readonly viewChanged: boolean;
  readonly buildDurationMs: number;
  readonly summary: GridRuntimeSummaryBuildMetadata;
}

export interface GridRuntimeErrorMessage {
  readonly type: "runtimeError";
  readonly operation: "install" | "view" | "surface" | "resolve" | "summary" | "edit" | "protocol";
  readonly requestId?: number;
  readonly queryId?: number;
  readonly operationId?: string;
  readonly message: string;
}

export interface GridRuntimeDisposedMessage {
  readonly type: "disposed";
}

export type GridRuntimeOutputMessage =
  | GridRuntimeReadyMessage
  | GridRuntimeInstallProgressMessage
  | GridRuntimeInstallReadyMessage
  | GridRuntimeViewProgressMessage
  | GridRuntimeViewReadyMessage
  | GridRuntimeSurfaceReadyMessage
  | GridRuntimePublishedMessage
  | GridRuntimeSurfaceDroppedMessage
  | GridRuntimeCancelledMessage
  | GridRuntimeResolvedRowMessage
  | GridRuntimeResolvedOrdinalMessage
  | GridRuntimeCellInspectedMessage
  | GridRuntimeSummaryReadyMessage
  | GridRuntimeSummaryCancelledMessage
  | GridRuntimeEditParsedMessage
  | GridRuntimeEditLeaseMessage
  | GridRuntimeEditProgressMessage
  | GridRuntimeEditReadyMessage
  | GridRuntimeErrorMessage
  | GridRuntimeDisposedMessage;

export interface GridRuntimeTransport {
  postMessage(message: GridRuntimeInputMessage, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<GridRuntimeOutputMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
