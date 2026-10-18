/** Stable source identity. Type is part of identity. */
export type RowId = string | number | bigint;

/** Scalar values surfaced by the finite-grid data contract. */
export type CellScalar = string | number | boolean | bigint;

/** Runtime scalar representation of one installed Grid column. */
export type CellScalarType = "string" | "number" | "boolean" | "bigint";

/** How installation may acquire a supplied typed-array buffer. */
export type BufferOwnership = "copy" | "transfer" | "shared";

export type GridTypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

export interface GridBuffer<T extends GridTypedArray> {
  readonly view: T;
  /**
   * Defaults to `copy`. Hosts must not mutate a `shared` buffer until the
   * admitted dataset is rejected, replaced, or disposed. `copy` snapshots only
   * the referenced view range when `setData` is invoked. `transfer` is consumed
   * when the runtime admits the ingress attempt, including when initialization
   * or worker-side content validation later rejects it; structural admission
   * failures do not detach it.
   */
  readonly ownership?: BufferOwnership;
}

export interface ValidityBitmap {
  /** Arrow-compatible: one means valid and zero means null. */
  readonly bits: GridBuffer<Uint8Array>;
  readonly bitOffset?: number;
}

export interface Utf8Buffers {
  /** Exactly logical value count + 1 non-decreasing, in-range offsets. */
  readonly offsets: GridBuffer<Int32Array | Uint32Array>;
  readonly data: GridBuffer<Uint8Array>;
}

type NumberArray = Float32Array | Float64Array;
type IntegerArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array;
type CategoryCodeArray =
  Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array;

export type GridColumnKind =
  "number" | "integer" | "boolean" | "timestamp" | "category" | "id" | "text";

/** Serializable labels used by the built-in scalar editor. */
export interface SerializableEditorOptions {
  /** Accessible editor label. Defaults to the column ID. */
  readonly label?: string;
  /** Label for the explicit null action on nullable columns. */
  readonly nullLabel?: string;
  /** Labels for the native boolean editor. */
  readonly trueLabel?: string;
  readonly falseLabel?: string;
}

export interface GridColumnSchema {
  readonly id: string;
  readonly kind: GridColumnKind;
  readonly nullable?: boolean;
  /** Only raw scalar cells in supported kinds may be editable. */
  readonly editable?: boolean;
  readonly edit?: SerializableEditorOptions;
}

export type GridColumnData =
  | {
      readonly kind: "number";
      readonly values: GridBuffer<NumberArray>;
      readonly validity?: ValidityBitmap;
    }
  | {
      readonly kind: "integer";
      readonly values: GridBuffer<IntegerArray>;
      readonly validity?: ValidityBitmap;
    }
  | {
      readonly kind: "boolean";
      readonly values: GridBuffer<Uint8Array>;
      readonly encoding: "byte" | "bitmap";
      readonly bitOffset?: number;
      readonly validity?: ValidityBitmap;
    }
  | {
      readonly kind: "timestamp";
      readonly values:
        | {
            readonly data: GridBuffer<BigInt64Array>;
            readonly unit: "s" | "ms" | "us" | "ns";
          }
        | { readonly data: GridBuffer<Float64Array>; readonly unit: "ms" };
      readonly timezone?: string;
      readonly validity?: ValidityBitmap;
    }
  | {
      readonly kind: "category";
      readonly codes: GridBuffer<CategoryCodeArray>;
      readonly dictionary: Utf8Buffers;
      readonly validity?: ValidityBitmap;
    }
  | {
      readonly kind: "id";
      readonly values:
        | { readonly encoding: "integer"; readonly data: GridBuffer<IntegerArray> }
        | ({ readonly encoding: "utf8" } & Utf8Buffers);
      readonly validity?: ValidityBitmap;
    }
  | {
      readonly kind: "text";
      readonly values: Utf8Buffers;
      readonly validity?: ValidityBitmap;
    };

export type RowIdData =
  | {
      readonly kind: "number";
      readonly values: GridBuffer<
        Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float64Array
      >;
    }
  | {
      readonly kind: "bigint";
      readonly values: GridBuffer<BigInt64Array | BigUint64Array>;
    }
  | ({ readonly kind: "string" } & Utf8Buffers);

export interface GridData {
  readonly rowIds?: RowIdData;
  readonly columns: readonly {
    readonly schema: GridColumnSchema;
    readonly data: GridColumnData;
  }[];
  readonly length: number;
}

export interface GridDataInstallResult {
  readonly datasetId: string;
  readonly buffers: readonly {
    readonly path: string;
    readonly requested: BufferOwnership;
    readonly installed: "copied" | "transferred" | "shared";
    /** Referenced view bytes; `transfer` still consumes the complete backing buffer. */
    readonly byteLength: number;
  }[];
}

/** Direction for one key in the stable active-view sort. */
export type GridSortDirection = "ascending" | "descending";

/**
 * One key in a stable multi-sort. Null placement is independent of direction,
 * so reversing a key never silently moves nulls to the opposite edge.
 */
export interface GridSort {
  readonly columnId: string;
  readonly direction: GridSortDirection;
  /** Defaults to `last`. */
  readonly nulls?: "first" | "last";
}

export type GridComparisonOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

export interface GridComparisonFilter {
  readonly kind: "comparison";
  readonly columnId: string;
  readonly operator: GridComparisonOperator;
  readonly value: CellScalar;
}

export interface GridBetweenFilter {
  readonly kind: "between";
  readonly columnId: string;
  readonly lower: CellScalar;
  readonly upper: CellScalar;
  /** Defaults to inclusive at both boundaries. */
  readonly includeLower?: boolean;
  /** Defaults to inclusive at both boundaries. */
  readonly includeUpper?: boolean;
}

export interface GridInFilter {
  readonly kind: "in";
  readonly columnId: string;
  readonly values: readonly CellScalar[];
}

export interface GridNullFilter {
  readonly kind: "is-null" | "is-not-null";
  readonly columnId: string;
}

/** Case-sensitive, code-unit string matching over text-like cell values. */
export interface GridTextFilter {
  readonly kind: "contains" | "starts-with" | "ends-with";
  readonly columnId: string;
  readonly value: string;
}

export interface GridAllFilter {
  readonly kind: "all";
  readonly filters: readonly GridFilter[];
}

export interface GridAnyFilter {
  readonly kind: "any";
  readonly filters: readonly GridFilter[];
}

export interface GridNotFilter {
  readonly kind: "not";
  readonly filter: GridFilter;
}

/**
 * Serializable active-view filter tree. Null cells never satisfy a leaf value
 * predicate; use an explicit null predicate when null membership is intended.
 *
 * Value operands must have the exact runtime scalar type of their target
 * column. In particular, number-backed and bigint-backed integer, timestamp,
 * and ID columns are distinct. NaN is not a valid filter operand, and a NaN
 * data cell never satisfies a relational comparison or bounded range. Text
 * predicates require a string-backed text, category, or UTF-8 ID column.
 * Equality and set membership are type-sensitive. Relational operators use
 * numeric order for numbers and bigints, `false < true` for booleans, and
 * JavaScript code-unit lexical order for strings. This filter order is
 * deliberately separate from the total order used for sorting.
 */
export type GridFilter =
  | GridComparisonFilter
  | GridBetweenFilter
  | GridInFilter
  | GridNullFilter
  | GridTextFilter
  | GridAllFilter
  | GridAnyFilter
  | GridNotFilter;

export interface GridViewSpec {
  readonly filter?: GridFilter;
  /** Earlier entries are higher-priority sort keys. */
  readonly sort?: readonly GridSort[];
}

/** Stable cell identity. Visual row and column positions are deliberately absent. */
export interface GridCellRef {
  readonly rowId: RowId;
  readonly columnId: string;
}

export interface GridRangeSelection {
  readonly kind: "range";
  readonly datasetId: string;
  /** Zero until the active-view pipeline is introduced. */
  readonly viewRevision: number;
  readonly anchor: GridCellRef;
  readonly focus: GridCellRef;
}

export type GridInteractionSource = "pointer" | "keyboard" | "api" | "data" | "view";

export interface GridSelectionChangeEvent {
  readonly selection: GridRangeSelection | null;
  readonly source: GridInteractionSource;
}

export interface GridViewportChangeEvent {
  readonly viewport: GridViewport;
  readonly source: "scroll" | "resize" | "data" | "view" | "api";
}

/** Visible indices use a half-open interval: start is inclusive and end is exclusive. */
export interface GridViewport {
  readonly datasetId: string | null;
  readonly viewRevision: number;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly columnStart: number;
  readonly columnEnd: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

export type GridRenderMode = "auto" | "worker" | "main";
export type GridResolvedRenderMode = "worker" | "main";
export type GridRenderFallbackReason =
  "offscreen-unsupported" | "worker-construction-failed" | "offscreen-transfer-failed" | null;

export interface GridDiagnostics {
  readonly renderMode: GridResolvedRenderMode | null;
  readonly renderFallbackReason: GridRenderFallbackReason;
  /** The runtime formats one bounded visible frame before Canvas painting. */
  readonly paintPipeline: "worker-formatted-bounded-viewport";
  /** Full typed data is canonical in the runtime worker when worker mode is active. */
  readonly dataOwnershipMode: "runtime-worker" | "main-fallback";
  /** Active-view construction uses the canonical runtime worker when available. */
  readonly viewExecutionMode: "worker" | "main";
  readonly dataRevision: number;
  readonly viewRevision: number;
  readonly physicalRowCount: number;
  readonly viewRowCount: number;
  readonly logicalScrollCompressed: boolean;
  readonly lastPaintDurationMs: number | null;
  readonly lastPaintedCells: number;
  readonly lastViewBuildDurationMs: number | null;
  /** Time spent acquiring the bounded host ingress; no host data image is retained afterward. */
  readonly lastMainStoreInstallDurationMs: number | null;
  /** Time spent deeply validating and adopting the latest dataset in the runtime worker. */
  readonly lastViewWorkerStoreInstallDurationMs: number | null;
  /** Host wall time from dispatching the latest worker dataset until its ready message. */
  readonly lastViewWorkerDispatchToReadyDurationMs: number | null;
  /** Present when a paint initialization/runtime failure stops surface publication. */
  readonly paintError: string | null;
  /** Private hierarchy fanout; null when exact summaries are not configured. */
  readonly summaryBlockSize: 256 | null;
  readonly summaryConfiguredColumnCount: number;
  readonly summaryRetainedBytes: number;
  /** Candidate plus prior hierarchy at the latest published replacement. */
  readonly summaryStagedReplacementPeakBytes: number;
  readonly lastSummaryBuildDurationMs: number | null;
  readonly lastSummaryQueryDurationMs: number | null;
  readonly lastSummaryQueryBandCount: number | null;
  readonly lastSummaryQueryNodeVisits: number | null;
  readonly lastSummaryQueryRawRowsScanned: number | null;
  readonly lastSummaryQueryVertices: number | null;
  /** Exact byte count of the latest summary reply's typed-array fields. */
  readonly lastSummaryQueryTypedPayloadBytes: number | null;
}

export interface GridViewProgress {
  readonly phase: "filter" | "sort";
  readonly completed: number;
  readonly total: number;
}

export interface GridViewState {
  readonly status: "ready" | "building" | "failed";
  readonly requestId: number;
  readonly viewRevision: number;
  readonly spec: GridViewSpec;
  readonly rowCount: number;
  readonly progress?: GridViewProgress;
  readonly durationMs?: number;
  readonly error?: string;
}

export type GridViewApplyResult =
  | { readonly status: "applied"; readonly state: GridViewState }
  | { readonly status: "superseded"; readonly requestId: number };

/** Columns whose exact summary hierarchies are installed with each published view. */
export interface GridSummaryOptions {
  /**
   * Summary construction is opt-in and currently supports number and category
   * columns. The runtime rejects unknown, duplicate, or unsupported columns.
   */
  readonly columns: readonly string[];
}

/** One bounded, active-view summary-band request. */
export interface GridSummaryBandsRequest {
  readonly columnId: string;
  /** Desired number of non-empty bands. Must be an integer from 1 through 2,048. */
  readonly bandCount: number;
  /** Inclusive active-view ordinal. Defaults to zero. */
  readonly start?: number;
  /** Exclusive active-view ordinal. Defaults to the published view row count. */
  readonly end?: number;
  readonly signal?: AbortSignal;
}

export interface GridNumericSummaryExemplar {
  readonly value: number;
  readonly viewOrdinal: number;
  readonly rowId: RowId;
}

export interface GridCategorySummaryExemplar {
  readonly code: number;
  readonly label: string;
  readonly viewOrdinal: number;
  readonly rowId: RowId;
}

interface GridSummaryBandBase {
  /** Inclusive active-view ordinal represented by this band. */
  readonly start: number;
  /** Exclusive active-view ordinal represented by this band. */
  readonly end: number;
  readonly rowCount: number;
  readonly exact: true;
}

/** Exact numeric evidence for one contiguous active-view range. */
export interface GridNumericSummaryBand extends GridSummaryBandBase {
  readonly kind: "numeric";
  readonly nullCount: number;
  readonly finiteCount: number;
  readonly nanCount: number;
  readonly positiveInfinityCount: number;
  readonly negativeInfinityCount: number;
  readonly finiteMinimum: GridNumericSummaryExemplar | null;
  readonly finiteMaximum: GridNumericSummaryExemplar | null;
}

/** Exact first-distinct categorical evidence for one active-view range. */
export interface GridCategorySummaryBand extends GridSummaryBandBase {
  readonly kind: "category";
  readonly nullCount: number;
  /** At most four values, ordered by first occurrence in the represented range. */
  readonly exemplars: readonly GridCategorySummaryExemplar[];
  /** True exactly when `exemplars` contains every distinct non-null value. */
  readonly complete: boolean;
}

export type GridSummaryBand = GridNumericSummaryBand | GridCategorySummaryBand;

/** Bounded worker work and transport counters for one exact band batch. */
export interface GridSummaryQueryStats {
  readonly durationMs: number;
  readonly nodeVisits: number;
  readonly rawRowsScanned: number;
  readonly summaryVertices: number;
  /** Exact bytes across the worker reply's typed-array fields. */
  readonly typedPayloadBytes: number;
}

interface GridSummaryBandsAppliedBase {
  readonly status: "applied";
  readonly requestId: number;
  readonly datasetId: string;
  readonly dataRevision: number;
  readonly viewRevision: number;
  /** Renderer-confirmed presentation at which this request captured the view. */
  readonly presentationRevision: number;
  readonly columnId: string;
  readonly start: number;
  readonly end: number;
  readonly rowCount: number;
  readonly exact: true;
  readonly queryStats: GridSummaryQueryStats;
}

export interface GridNumericSummaryBandsApplied extends GridSummaryBandsAppliedBase {
  readonly kind: "numeric";
  readonly bands: readonly GridNumericSummaryBand[];
}

export interface GridCategorySummaryBandsApplied extends GridSummaryBandsAppliedBase {
  readonly kind: "category";
  readonly bands: readonly GridCategorySummaryBand[];
}

export interface GridSummaryBandsSuperseded {
  readonly status: "superseded";
  readonly requestId: number;
}

export type GridSummaryBandsResult =
  GridNumericSummaryBandsApplied | GridCategorySummaryBandsApplied | GridSummaryBandsSuperseded;

/** One structurally valid, host-controlled scalar edit proposal. */
export interface EditRequest {
  readonly operationId: string;
  readonly datasetId: string;
  readonly rowId: RowId;
  readonly columnId: string;
  readonly cellRevision: number;
  readonly previousValue: CellScalar | null;
  readonly proposedValue: CellScalar | null;
  readonly dataRevision: number;
  readonly viewRevision: number;
  /**
   * Aborts only before lease grant. After grant, the Grid never aborts this
   * signal and the operation is uncancellable.
   */
  readonly signal: AbortSignal;
  readonly beginAuthoritativeCommit: (
    finalValue?: CellScalar | null,
  ) => Promise<EditCommitLeaseResult>;
}

export type EditCommitLeaseResult =
  | {
      readonly granted: true;
      readonly leaseId: string;
      readonly finalValue: CellScalar | null;
    }
  | {
      readonly granted: false;
      readonly reason: "cancelled" | "stale" | "invalid-normalization";
      readonly message?: string;
    };

export type EditDecision =
  | { readonly outcome: "accepted"; readonly leaseId: string; readonly message?: string }
  | {
      readonly outcome: "rejected";
      readonly code: string;
      readonly message: string;
    };

export type EditCompletionOutcome =
  | "accepted"
  | "rejected"
  | "host-error"
  | "cancelled"
  | "stale"
  | "invalid-normalization"
  | "host-outcome-unknown"
  | "post-lease-conflict"
  | "apply-failed";

export interface CompletedEditOperation {
  readonly operationId: string;
  readonly datasetId: string;
  readonly rowId: RowId;
  readonly columnId: string;
  readonly previousValue: CellScalar | null;
  readonly proposedValue: CellScalar | null;
  readonly finalValue?: CellScalar | null;
  readonly outcome: EditCompletionOutcome;
  readonly startedDataRevision: number;
  readonly publishedDataRevision?: number;
  readonly code?: string;
  readonly message?: string;
}

export interface EditReconcileRequired {
  readonly operation: CompletedEditOperation;
  readonly reason: "host-outcome-unknown" | "post-lease-conflict" | "apply-failed";
  readonly requiredAction: "replace-dataset-or-destroy";
}

export interface GridEditingOptions {
  readonly mode: "controlled";
  readonly commitTimeoutMs?: number;
  readonly onEditRequest: (request: EditRequest) => EditDecision | Promise<EditDecision>;
  readonly onReconcileRequired: (event: EditReconcileRequired) => void;
  readonly onEditComplete?: (operation: CompletedEditOperation) => void;
}

export interface GridEditController {
  /** Cancels only an open editor or pre-lease operation; false after lease grant. */
  cancelEdit(operationId?: string): boolean;
}

export interface GridOptions {
  readonly ariaLabel?: string;
  /** Accessible label for the presentation-only row-number gutter. */
  readonly rowNumberLabel?: string;
  /** Prefer OffscreenCanvas painting when available. Defaults to `auto`. */
  readonly renderMode?: GridRenderMode;
  readonly rowHeight?: number;
  readonly headerHeight?: number;
  readonly columnWidth?: number;
  readonly rowNumberWidth?: number;
  readonly minColumnWidth?: number;
  readonly maxColumnWidth?: number;
  readonly overscanRows?: number;
  readonly overscanColumns?: number;
  /** Opts selected columns into the exact, worker-owned summary hierarchy. */
  readonly summary?: GridSummaryOptions;
  /** Required controlled persistence boundary for editable columns. */
  readonly editing?: GridEditingOptions;
  readonly onSelectionChange?: (event: GridSelectionChangeEvent) => void;
  readonly onViewportChange?: (event: GridViewportChangeEvent) => void;
  readonly onViewChange?: (state: GridViewState) => void;
  readonly onDiagnosticsChange?: (diagnostics: GridDiagnostics) => void;
}

export interface GridScrollToCellOptions {
  readonly block?: "start" | "center" | "end" | "nearest";
  readonly inline?: "start" | "center" | "end" | "nearest";
}

export interface GridFocusCellOptions {
  readonly scrollIntoView?: boolean;
}
