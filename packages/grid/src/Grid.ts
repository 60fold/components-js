import { SemanticGrid } from "./accessibility/semanticGrid.js";
import { acquireGridRuntimeIngress, type GridRuntimeIngress } from "./data/store.js";
import GridPaintWorker from "./grid.paint.worker.ts?worker";
import GridRuntimeWorker from "./grid.runtime.worker.ts?worker";
import { readGridPalette } from "./rendering/mainRenderer.js";
import {
  InlineGridPaintTransport,
  selectGridPaintTransport,
  type GridPaintFallbackReason,
  type GridPaintTransport,
  type ResolvedGridPaintRenderMode,
} from "./rendering/paintTransport.js";
import type { GridPaintOutputMessage } from "./rendering/paintProtocol.js";
import {
  alignedScrollOffset,
  createGridColumnLayout,
  finiteDimension,
  finiteOverscan,
  hitTestGrid,
  logicalScrollGeometry,
  logicalToPhysicalScroll,
  physicalToLogicalScroll,
  visibleGridRange,
  type GridColumnLayout,
  type GridLayout,
} from "./rendering/layout.js";
import {
  InlineGridRuntimeTransport,
  bindGridRuntimeTransport,
} from "./runtime/runtimeTransport.js";
import type {
  GridRuntimeDatasetDescriptor,
  GridRuntimeOutputMessage,
  GridRuntimeSurfaceReadyMessage,
  GridRuntimeSurfaceTarget,
  GridRuntimeTransport,
} from "./runtime/runtimeProtocol.js";
import type {
  CompletedEditOperation,
  EditCommitLeaseResult,
  EditCompletionOutcome,
  EditDecision,
  EditReconcileRequired,
  EditRequest,
  GridCellRef,
  GridData,
  GridDataInstallResult,
  GridDiagnostics,
  GridFocusCellOptions,
  GridInteractionSource,
  GridOptions,
  GridRangeSelection,
  GridScrollToCellOptions,
  GridCategorySummaryBand,
  GridNumericSummaryBand,
  GridSummaryBandsRequest,
  GridSummaryBandsResult,
  GridViewApplyResult,
  GridViewSpec,
  GridViewState,
  GridViewport,
  RowId,
  CellScalar,
} from "./types.js";
import {
  GridEditorOverlay,
  type GridEditorNavigation,
  type GridEditorRawValue,
} from "./editing/editorOverlay.js";
import {
  GRID_INTERNAL_SURFACE_TELEMETRY,
  gridPaintFrameTextCodeUnits,
  type GridInternalSurfaceTelemetryOptions,
  type GridSurfaceTelemetryDropReason,
  type GridSurfaceTelemetryEvent,
  type GridSurfaceTelemetrySink,
} from "./internal/surfaceTelemetry.js";

const DEFAULT_ROW_HEIGHT = 30;
const DEFAULT_HEADER_HEIGHT = 38;
const DEFAULT_COLUMN_WIDTH = 176;
const DEFAULT_ROW_NUMBER_WIDTH = 80;
const DEFAULT_MIN_COLUMN_WIDTH = 88;
const DEFAULT_MAX_COLUMN_WIDTH = 640;
const MAX_GRID_COLUMN_WIDTH = 4_096;
const DEFAULT_OVERSCAN_ROWS = 3;
const DEFAULT_OVERSCAN_COLUMNS = 1;
const DEFAULT_EDIT_COMMIT_TIMEOUT_MS = 30_000;
const MIN_EDIT_COMMIT_TIMEOUT_MS = 1_000;
const MAX_EDIT_COMMIT_TIMEOUT_MS = 120_000;
const MAX_GRID_SUMMARY_BANDS = 2_048;
const NO_GRID_SUMMARY_ORDINAL = 0xffff_ffff;

type ViewportSource = "scroll" | "resize" | "data" | "view" | "api";

interface PendingInstall {
  readonly requestId: number;
  dataRevision: number;
  readonly resolve: (result: GridDataInstallResult) => void;
  readonly reject: (reason: unknown) => void;
  readonly abortController: AbortController;
  workerDispatchStartedAt: number | null;
  descriptor: GridRuntimeDatasetDescriptor | null;
  columnLayout: GridColumnLayout | null;
  installDurationMs: number | null;
}

interface PendingView {
  readonly requestId: number;
  readonly datasetId: string;
  readonly viewRevision: number;
  readonly spec: GridViewSpec;
  readonly resolve: (result: GridViewApplyResult) => void;
  readonly reject: (reason: unknown) => void;
  rowCount: number | null;
  buildDurationMs: number | null;
}

interface PendingSurface {
  readonly runtime: GridRuntimeSurfaceReadyMessage;
  readonly columnLayout: GridColumnLayout;
  readonly viewport: GridViewport;
  readonly focusedRowIndex: number;
  readonly focusedColumnIndex: number;
  readonly telemetry: SurfaceTelemetryTrace | null;
}

interface RequestedSurface {
  readonly surfaceId: number;
  readonly commitToken: string;
  readonly target: GridRuntimeSurfaceTarget;
  readonly columnLayout: GridColumnLayout;
  readonly viewport: GridViewport;
  readonly focusedRowIndex: number;
  readonly focusedColumnIndex: number;
  readonly telemetry: SurfaceTelemetryTrace | null;
}

interface SurfaceTelemetryIntent {
  readonly intentId: number;
  readonly observedAtMs: number;
  readonly source: ViewportSource;
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

interface SurfaceTelemetryTrace {
  readonly surfaceId: number;
  readonly commitToken: string;
  readonly intentId: number;
  readonly intentAtMs: number;
  readonly source: ViewportSource;
  readonly targetKind: GridRuntimeSurfaceTarget["kind"];
  readonly columnLayoutRevision: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly pixelRatio: number;
  readonly datasetRowCount: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly viewportRowStart: number;
  readonly viewportRowEnd: number;
  readonly viewportColumnStart: number;
  readonly viewportColumnEnd: number;
  readonly intentScrollTop: number;
  readonly intentScrollLeft: number;
  dropped: boolean;
}

interface PaintCommitLease {
  readonly surfaceId: number;
  readonly commitToken: string;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

interface ResolvedCell {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly rowId: RowId;
}

type GridEditorExitTarget =
  | { readonly kind: "grid" }
  | { readonly kind: "external" }
  | { readonly kind: "cell"; readonly rowId: RowId; readonly columnId: string };

interface ActiveGridEditor {
  readonly overlay: GridEditorOverlay;
  readonly rowId: RowId;
  readonly columnId: string;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly cellRevision: number;
  readonly previousValue: CellScalar | null;
  navigation: GridEditorNavigation;
  exitTarget: GridEditorExitTarget;
}

type OutstandingEditPhase = "pending" | "reserving" | "committing" | "applying";

interface OutstandingGridEdit {
  readonly operationId: string;
  readonly datasetId: string;
  readonly rowId: RowId;
  readonly columnId: string;
  readonly cellRevision: number;
  readonly previousValue: CellScalar | null;
  readonly proposedValue: CellScalar | null;
  readonly startedDataRevision: number;
  readonly startedViewRevision: number;
  readonly abortController: AbortController;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  phase: OutstandingEditPhase;
  cancelledWhileReserving?: boolean;
  leaseId?: string;
  finalValue?: CellScalar | null;
  timeoutId?: ReturnType<typeof setTimeout>;
}

interface RowQuery {
  readonly datasetId: string;
  readonly resolve: (
    value: { physicalRow: number; viewOrdinal: number; rowId: RowId } | null,
  ) => void;
  readonly reject: (reason: unknown) => void;
}

interface CellInspection {
  readonly datasetId: string;
  readonly rowId: RowId;
  readonly columnId: string;
  readonly descriptor: GridRuntimeDatasetDescriptor["columns"][number];
  readonly value: CellScalar | null;
  readonly cellRevision: number;
  readonly categoryValues?: readonly string[];
}

interface CellInspectionQuery {
  readonly datasetId: string;
  readonly resolve: (value: CellInspection | null) => void;
  readonly reject: (reason: unknown) => void;
}

interface PendingSummaryBandsQuery {
  readonly requestId: number;
  readonly datasetId: string;
  readonly dataRevision: number;
  readonly viewRevision: number;
  readonly presentationRevision: number;
  readonly columnId: string;
  readonly start: number;
  readonly end: number;
  readonly ranges: Uint32Array;
  readonly resolve: (value: GridSummaryBandsResult) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
}

interface PendingEditCandidate {
  readonly operationId: string;
  readonly dataRevision: number;
  readonly viewRevision: number;
  readonly rowCount: number;
  readonly editedRowIndex: number;
  readonly viewChanged: boolean;
  readonly buildDurationMs: number;
}

/**
 * Typed-column Canvas2D grid whose canonical data, active view, sparse patches,
 * and formatting live in one runtime worker. The host retains only bounded
 * renderer-confirmed viewport payloads and interaction metadata.
 */
export class Grid {
  private readonly host: HTMLElement;
  private readonly options: GridOptions;
  private readonly surfaceTelemetry: GridSurfaceTelemetrySink | null;
  private readonly root: HTMLDivElement;
  private readonly scrollport: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly semantics: SemanticGrid;
  private readonly editorLayer: HTMLDivElement;
  private readonly layout: GridLayout;
  private readonly rowNumberWidth: number;
  private readonly rowNumberLabel: string;
  private readonly minColumnWidth: number;
  private readonly maxColumnWidth: number;
  private readonly summaryColumnIds: readonly string[];
  private readonly columnWidthsById = new Map<string, number>();
  private columnLayout: GridColumnLayout = createGridColumnLayout([]);
  private presentedColumnLayout: GridColumnLayout = createGridColumnLayout([]);
  private nextColumnLayoutRevision = 0;

  private paintTransport: GridPaintTransport | null = null;
  private runtimeTransport: GridRuntimeTransport | null = null;
  private resolvedRenderMode: ResolvedGridPaintRenderMode | null = null;
  private renderFallbackReason: GridPaintFallbackReason = null;
  private viewExecutionMode: "worker" | "main" = "main";
  private initializationPromise: Promise<void> | null = null;
  private paintReadyResolve: (() => void) | null = null;
  private paintReadyReject: ((reason: unknown) => void) | null = null;
  private runtimeReadyResolve: (() => void) | null = null;
  private runtimeReadyReject: ((reason: unknown) => void) | null = null;
  private paintInitializationError: Error | null = null;
  private runtimeInitializationError: Error | null = null;

  private dataset: GridRuntimeDatasetDescriptor | null = null;
  private pendingInstall: PendingInstall | null = null;
  private pendingView: PendingView | null = null;
  private viewState: GridViewState = {
    status: "ready",
    requestId: 0,
    viewRevision: 0,
    spec: {},
    rowCount: 0,
  };
  /** Revision/spec of the renderer-confirmed snapshot, excluding a building/failed candidate. */
  private publishedViewRevision = 0;
  private publishedViewSpec: GridViewSpec = {};
  private publishedPresentationRevision = 0;
  private dataRevision = 0;
  private nextInstallRequestId = 0;
  private nextViewRequestId = 0;
  private nextViewRevision = 0;

  private nextSurfaceId = 0;
  private runtimeSurfaceInFlight: RequestedSurface | PendingSurface | null = null;
  private paintInFlight: PendingSurface | null = null;
  private awaitingRuntimePublication: PendingSurface | null = null;
  private paintCommitLease: PaintCommitLease | null = null;
  private pendingViewportSource: ViewportSource | null = null;
  private nextSurfaceIntentId = 0;
  private pendingSurfaceIntent: SurfaceTelemetryIntent | null = null;
  private latestSurfaceIntent: SurfaceTelemetryIntent | null = null;
  private frame = 0;
  private lastPaintDurationMs: number | null = null;
  private lastPaintedCells = 0;
  private lastViewBuildDurationMs: number | null = null;
  private lastHostIngressDurationMs: number | null = null;
  private lastRuntimeInstallDurationMs: number | null = null;
  private lastRuntimeDispatchToReadyDurationMs: number | null = null;
  private summaryBlockSize: 256 | null = null;
  private summaryConfiguredColumnCount = 0;
  private summaryRetainedBytes = 0;
  private summaryStagedReplacementPeakBytes = 0;
  private lastSummaryBuildDurationMs: number | null = null;
  private lastSummaryQueryDurationMs: number | null = null;
  private lastSummaryQueryBandCount: number | null = null;
  private lastSummaryQueryNodeVisits: number | null = null;
  private lastSummaryQueryRawRowsScanned: number | null = null;
  private lastSummaryQueryVertices: number | null = null;
  private lastSummaryQueryTypedPayloadBytes: number | null = null;
  private paintError: string | null = null;

  private resizeObserver: ResizeObserver | null = null;
  private initialized = false;
  private destroyed = false;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private focusedRowIndex = -1;
  private focusedColumnIndex = -1;
  private focusedCell: GridCellRef | null = null;
  private selection: GridRangeSelection | null = null;
  private selectionAnchorRowIndex = -1;
  private selectionAnchorColumnIndex = -1;
  private visibleRowIds = new Map<number, RowId>();
  private activePointerId: number | null = null;
  private resizeGesture: {
    readonly pointerId: number;
    readonly columnId: string;
    readonly columnIndex: number;
    readonly startX: number;
    readonly startWidth: number;
  } | null = null;
  private nextRowQueryId = 0;
  private nextSummaryQueryId = 0;
  private readonly rowQueries = new Map<number, RowQuery>();
  private readonly cellInspectionQueries = new Map<number, CellInspectionQuery>();
  private readonly summaryQueries = new Map<number, PendingSummaryBandsQuery>();
  private readonly editParseQueries = new Map<
    string,
    {
      readonly resolve: (value: CellScalar | null) => void;
      readonly reject: (reason: unknown) => void;
    }
  >();
  private readonly editLeaseQueries = new Map<
    string,
    {
      readonly resolve: (value: EditCommitLeaseResult) => void;
      readonly reject: (reason: unknown) => void;
    }
  >();

  private activeEditor: ActiveGridEditor | null = null;
  private outstandingEdit: OutstandingGridEdit | null = null;
  private pendingEditCandidate: PendingEditCandidate | null = null;
  private pendingParseOperationId: string | null = null;
  private nextEditOperationId = 0;
  private editingLocked = false;

  constructor(host: HTMLElement, options: GridOptions = {}) {
    if (!host || typeof host.append !== "function") {
      throw new TypeError("Grid requires a host HTMLElement.");
    }
    if (host.childNodes.length > 0) throw new Error("Grid host must be empty.");
    this.host = host;
    this.options = options;
    this.summaryColumnIds = snapshotSummaryColumnIds(options.summary?.columns);
    const telemetry = (options as GridOptions & GridInternalSurfaceTelemetryOptions)[
      GRID_INTERNAL_SURFACE_TELEMETRY
    ];
    this.surfaceTelemetry = typeof telemetry === "function" ? telemetry : null;
    this.minColumnWidth = Math.min(
      MAX_GRID_COLUMN_WIDTH,
      finiteDimension(
        options.minColumnWidth ?? DEFAULT_MIN_COLUMN_WIDTH,
        DEFAULT_MIN_COLUMN_WIDTH,
        48,
      ),
    );
    const requestedMaximum =
      Number.isFinite(options.maxColumnWidth) && options.maxColumnWidth! >= this.minColumnWidth
        ? options.maxColumnWidth!
        : Math.max(DEFAULT_MAX_COLUMN_WIDTH, this.minColumnWidth);
    this.maxColumnWidth = Math.min(
      MAX_GRID_COLUMN_WIDTH,
      Math.max(this.minColumnWidth, requestedMaximum),
    );
    this.rowNumberWidth = Math.min(
      MAX_GRID_COLUMN_WIDTH,
      finiteDimension(
        options.rowNumberWidth ?? DEFAULT_ROW_NUMBER_WIDTH,
        DEFAULT_ROW_NUMBER_WIDTH,
        48,
      ),
    );
    this.rowNumberLabel = options.rowNumberLabel?.trim() || "Row number";
    this.layout = {
      rowHeight: finiteDimension(options.rowHeight ?? DEFAULT_ROW_HEIGHT, DEFAULT_ROW_HEIGHT, 18),
      headerHeight: finiteDimension(
        options.headerHeight ?? DEFAULT_HEADER_HEIGHT,
        DEFAULT_HEADER_HEIGHT,
        22,
      ),
      columnWidth: Math.max(
        this.minColumnWidth,
        Math.min(
          this.maxColumnWidth,
          finiteDimension(
            options.columnWidth ?? DEFAULT_COLUMN_WIDTH,
            Math.max(DEFAULT_COLUMN_WIDTH, this.minColumnWidth),
            this.minColumnWidth,
          ),
        ),
      ),
      overscanRows: finiteOverscan(options.overscanRows ?? DEFAULT_OVERSCAN_ROWS, 3),
      overscanColumns: finiteOverscan(options.overscanColumns ?? DEFAULT_OVERSCAN_COLUMNS, 1),
    };

    const root = document.createElement("div");
    root.dataset.sixtyfoldGrid = "";
    Object.assign(root.style, {
      position: "relative",
      width: "100%",
      height: "100%",
      minWidth: "0",
      minHeight: "0",
      overflow: "hidden",
      background: "var(--sixtyfold-grid-background, #0c1119)",
    });
    const scrollport = document.createElement("div");
    scrollport.dataset.gridScrollport = "";
    Object.assign(scrollport.style, {
      position: "absolute",
      inset: "0",
      overflow: "auto",
      overscrollBehavior: "contain",
      touchAction: "pan-x pan-y",
      WebkitOverflowScrolling: "touch",
      scrollbarGutter: "stable",
    });
    const spacer = document.createElement("div");
    spacer.dataset.gridSpacer = "";
    spacer.setAttribute("aria-hidden", "true");
    const canvas = document.createElement("canvas");
    canvas.dataset.gridCanvas = "";
    canvas.setAttribute("aria-hidden", "true");
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0 auto auto 0",
      zIndex: "1",
      display: "block",
      touchAction: "pan-x pan-y",
    });
    const semantics = new SemanticGrid(options.ariaLabel ?? "Data grid");
    semantics.element.style.zIndex = "2";
    const editorLayer = document.createElement("div");
    editorLayer.dataset.gridEditorLayer = "";
    editorLayer.setAttribute("aria-live", "off");
    Object.assign(editorLayer.style, {
      position: "absolute",
      inset: "0",
      zIndex: "4",
      overflow: "visible",
      pointerEvents: "none",
    });
    scrollport.append(spacer, canvas, semantics.element);
    root.dataset.gridEditState = "idle";
    root.append(scrollport, editorLayer);
    host.append(root);

    this.root = root;
    this.scrollport = scrollport;
    this.spacer = spacer;
    this.canvas = canvas;
    this.semantics = semantics;
    this.editorLayer = editorLayer;

    this.handleScroll = this.handleScroll.bind(this);
    this.handleWheel = this.handleWheel.bind(this);
    this.handleDocumentPointerDown = this.handleDocumentPointerDown.bind(this);
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handleDoubleClick = this.handleDoubleClick.bind(this);
    this.handleSemanticClick = this.handleSemanticClick.bind(this);
    this.handleSemanticPointerDown = this.handleSemanticPointerDown.bind(this);
    this.handleResizePointerMove = this.handleResizePointerMove.bind(this);
    this.handleResizePointerUp = this.handleResizePointerUp.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleWindowResize = this.handleWindowResize.bind(this);
    scrollport.addEventListener("scroll", this.handleScroll, { passive: true });
    scrollport.addEventListener("wheel", this.handleWheel, { passive: false });
    host.ownerDocument.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    canvas.addEventListener("pointerdown", this.handlePointerDown);
    canvas.addEventListener("pointermove", this.handlePointerMove);
    canvas.addEventListener("pointerup", this.handlePointerUp);
    canvas.addEventListener("pointercancel", this.handlePointerUp);
    canvas.addEventListener("dblclick", this.handleDoubleClick);
    semantics.element.addEventListener("click", this.handleSemanticClick);
    semantics.element.addEventListener("pointerdown", this.handleSemanticPointerDown);
    semantics.element.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("pointermove", this.handleResizePointerMove, { passive: false });
    window.addEventListener("pointerup", this.handleResizePointerUp);
    window.addEventListener("pointercancel", this.handleResizePointerUp);
  }

  initialize(): Promise<void> {
    this.assertLive();
    if (this.paintInitializationError) return Promise.reject(this.paintInitializationError);
    if (this.runtimeInitializationError) return Promise.reject(this.runtimeInitializationError);
    if (this.initialized) return Promise.resolve();
    if (this.initializationPromise) return this.initializationPromise;

    this.initializationPromise = this.initializeTransports().finally(() => {
      if (!this.initialized) this.initializationPromise = null;
    });
    // Destruction can settle the internal transport-ready barriers before the
    // caller observes this shared promise. Mark it handled without changing
    // the rejection seen by callers that await initialize().
    void this.initializationPromise.catch(() => undefined);
    return this.initializationPromise;
  }

  private async initializeTransports(): Promise<void> {
    const paintSelection = selectGridPaintTransport(
      this.canvas,
      this.options.renderMode ?? "auto",
      () => new GridPaintWorker() as unknown as GridPaintTransport,
    );
    const paintReady = new Promise<void>((resolve, reject) => {
      this.paintReadyResolve = resolve;
      this.paintReadyReject = reject;
    });
    let paintTransport = paintSelection.transport;
    let renderMode = paintSelection.renderMode;
    let fallbackReason = paintSelection.fallbackReason;
    this.bindPaintTransport(paintTransport);
    if (renderMode === "worker") {
      let offscreen: OffscreenCanvas;
      try {
        offscreen = this.canvas.transferControlToOffscreen();
      } catch {
        paintTransport.terminate();
        paintTransport = new InlineGridPaintTransport();
        renderMode = "main";
        fallbackReason = "offscreen-transfer-failed";
        this.bindPaintTransport(paintTransport);
        paintTransport.postMessage({ type: "init", canvas: this.canvas });
      }
      if (renderMode === "worker") {
        try {
          paintTransport.postMessage({ type: "init", canvas: offscreen! }, [offscreen!]);
        } catch (reason) {
          paintTransport.terminate();
          const error =
            reason instanceof Error
              ? reason
              : new Error("The Grid paint worker rejected its transferred canvas.");
          this.paintInitializationError = error;
          this.paintError = error.message;
          this.paintReadyResolve = null;
          this.paintReadyReject = null;
          throw error;
        }
      }
    } else {
      paintTransport.postMessage({ type: "init", canvas: this.canvas });
    }
    this.paintTransport = paintTransport;
    this.resolvedRenderMode = renderMode;
    this.renderFallbackReason = fallbackReason;

    const runtimeReady = new Promise<void>((resolve, reject) => {
      this.runtimeReadyResolve = resolve;
      this.runtimeReadyReject = reject;
    });
    let runtime: GridRuntimeTransport;
    if (typeof Worker === "function" && typeof structuredClone === "function") {
      try {
        runtime = new GridRuntimeWorker() as unknown as GridRuntimeTransport;
        this.viewExecutionMode = "worker";
      } catch {
        runtime = new InlineGridRuntimeTransport();
        this.viewExecutionMode = "main";
      }
    } else {
      runtime = new InlineGridRuntimeTransport();
      this.viewExecutionMode = "main";
    }
    bindGridRuntimeTransport(runtime, {
      message: (message) => this.handleRuntimeMessage(message),
      error: (error) => this.handleRuntimeFailure(error),
    });
    this.runtimeTransport = runtime;

    try {
      await Promise.all([paintReady, runtimeReady]);
    } catch (error) {
      paintTransport.terminate();
      runtime.terminate();
      throw error;
    }
    this.assertLive();
    this.initialized = true;
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.host);
    } else {
      window.addEventListener("resize", this.handleWindowResize);
    }
    this.resize();
    this.emitDiagnostics();
  }

  setData(data: GridData): Promise<GridDataInstallResult> {
    const operation = this.setDataOperation(data);
    // Public callers may intentionally fire-and-forget an installation during
    // teardown. Observe the same returned promise internally so destruction or
    // transport failure cannot become a process-level unhandled rejection;
    // awaiters still receive the original rejection.
    void operation.catch(() => undefined);
    return operation;
  }

  private async setDataOperation(data: GridData): Promise<GridDataInstallResult> {
    this.assertLive();
    this.throwIfRuntimeFailed();
    if (this.pendingInstall) {
      throw new Error("A Grid dataset installation is already in progress.");
    }
    const hostIngressStartedAt = performance.now();
    const ingress = acquireGridRuntimeIngress(data);
    const hostIngressDurationMs = Math.max(0, performance.now() - hostIngressStartedAt);
    const requestId = ++this.nextInstallRequestId;
    const dataRevision = this.dataRevision + 1;
    const abortController = new AbortController();
    let resolveInstall!: (result: GridDataInstallResult) => void;
    let rejectInstall!: (reason: unknown) => void;
    const result = new Promise<GridDataInstallResult>((resolve, reject) => {
      resolveInstall = resolve;
      rejectInstall = reject;
    });
    const pending: PendingInstall = {
      requestId,
      dataRevision,
      resolve: resolveInstall,
      reject: rejectInstall,
      abortController,
      workerDispatchStartedAt: null,
      descriptor: null,
      columnLayout: null,
      installDurationMs: null,
    };
    this.pendingInstall = pending;
    this.lastHostIngressDurationMs = hostIngressDurationMs;

    try {
      await this.initialize();
      this.assertLive();
      if (
        this.outstandingEdit?.phase === "committing" ||
        this.outstandingEdit?.phase === "applying"
      ) {
        await this.outstandingEdit.settled;
        this.assertLive();
      }
      if (this.pendingInstall !== pending || abortController.signal.aborted) {
        return result;
      }
      if (!this.editingLocked) this.cancelEdit();
      this.supersedePendingView();
      // An authoritative edit may have published while this replacement waited
      // behind its lease. Allocate the replacement revision only at dispatch so
      // every committed dataset/edit transition remains strictly monotonic.
      pending.dataRevision = this.dataRevision + 1;
      this.dispatchInstall(ingress, requestId, abortController.signal);
    } catch (error) {
      if (this.pendingInstall === pending) {
        this.pendingInstall = null;
        pending.reject(error);
        this.emitDiagnostics();
      }
    }
    return result;
  }

  private dispatchInstall(
    ingress: GridRuntimeIngress,
    requestId: number,
    signal: AbortSignal,
  ): void {
    try {
      if (signal.aborted || this.destroyed) return;
      const pending = this.pendingInstall;
      if (!pending || pending.requestId !== requestId || signal.aborted || this.destroyed) return;
      const runtime = this.requireRuntimeTransport();
      pending.workerDispatchStartedAt = performance.now();
      runtime.postMessage(
        {
          type: "install",
          requestId,
          dataRevision: pending.dataRevision,
          data: ingress.data,
          ...(this.summaryColumnIds.length > 0 ? { summaryColumnIds: this.summaryColumnIds } : {}),
        },
        ingress.transfer,
      );
      this.emitDiagnostics();
    } catch (error) {
      const pending = this.pendingInstall;
      if (!pending || pending.requestId !== requestId) return;
      this.pendingInstall = null;
      pending.reject(error);
      this.emitDiagnostics();
    }
  }

  setView(spec: GridViewSpec): Promise<GridViewApplyResult> {
    const operation = this.setViewOperation(spec);
    void operation.catch(() => undefined);
    return operation;
  }

  private async setViewOperation(spec: GridViewSpec): Promise<GridViewApplyResult> {
    this.assertLive();
    await this.initialize();
    this.assertLive();
    if (this.editingLocked) {
      throw new Error("Grid editing requires authoritative dataset reconciliation.");
    }
    if (this.pendingInstall) {
      throw new Error("Wait for Grid dataset installation before setting a view.");
    }
    if (
      this.outstandingEdit?.phase === "committing" ||
      this.outstandingEdit?.phase === "applying"
    ) {
      await this.outstandingEdit.settled;
      return this.setView(spec);
    }
    this.cancelEdit();
    const dataset = this.dataset;
    if (!dataset) throw new Error("Grid data must be installed before setting a view.");
    const acceptedSpec = snapshotViewSpec(spec);
    const barrier = this.paintCommitLease?.settled;
    if (barrier) {
      await barrier;
      return this.setView(acceptedSpec);
    }
    const runtime = this.requireRuntimeTransport();
    this.supersedePendingView();
    const requestId = ++this.nextViewRequestId;
    const viewRevision = ++this.nextViewRevision;
    this.viewState = {
      status: "building",
      requestId,
      viewRevision,
      spec: acceptedSpec,
      rowCount: this.viewState.rowCount,
      progress: { phase: "filter", completed: 0, total: dataset.rowCount },
    };
    this.notifyHost(() => this.options.onViewChange?.(this.viewState));
    const result = new Promise<GridViewApplyResult>((resolve, reject) => {
      this.pendingView = {
        requestId,
        datasetId: dataset.datasetId,
        viewRevision,
        spec: acceptedSpec,
        resolve,
        reject,
        rowCount: null,
        buildDurationMs: null,
      };
    });
    try {
      runtime.postMessage({
        type: "setView",
        requestId,
        datasetId: dataset.datasetId,
        viewRevision,
        spec: acceptedSpec,
      });
    } catch (error) {
      this.failView(requestId, error instanceof Error ? error : new Error(String(error)));
    }
    return result;
  }

  getView(): GridViewState {
    this.assertLive();
    return this.viewState;
  }

  getSummaryBands(request: GridSummaryBandsRequest): Promise<GridSummaryBandsResult> {
    this.assertLive();
    const accepted = snapshotSummaryBandsRequest(request);
    const operation = this.getSummaryBandsOperation(accepted);
    void operation.catch(() => undefined);
    return operation;
  }

  private async getSummaryBandsOperation(
    request: GridSummaryBandsRequest,
  ): Promise<GridSummaryBandsResult> {
    if (request.signal?.aborted) {
      throw createAbortError("The Grid summary query was aborted.");
    }
    await this.initialize();
    this.assertLive();
    if (request.signal?.aborted) {
      throw createAbortError("The Grid summary query was aborted.");
    }
    const dataset = this.dataset;
    if (!dataset) throw new Error("Grid data must be installed before querying summaries.");
    if (!this.summaryColumnIds.includes(request.columnId)) {
      throw new RangeError(`Grid summary column ${request.columnId} is not configured.`);
    }
    const rowCount = this.viewState.rowCount;
    const start = request.start ?? 0;
    const end = request.end ?? rowCount;
    assertSummaryRange(start, end, rowCount);
    const requestId = ++this.nextSummaryQueryId;
    const ranges = summaryBandRanges(start, end, request.bandCount);
    const runtime = this.requireRuntimeTransport();
    const identity = {
      datasetId: dataset.datasetId,
      dataRevision: this.dataRevision,
      viewRevision: this.publishedViewRevision,
      presentationRevision: this.publishedPresentationRevision,
    };

    if (ranges.length === 0) {
      const descriptor = dataset.columns.find((column) => column.schema.id === request.columnId);
      if (
        !descriptor ||
        (descriptor.schema.kind !== "number" && descriptor.schema.kind !== "category")
      ) {
        throw new TypeError(
          `Grid summary column ${request.columnId} is not numeric or categorical.`,
        );
      }
      this.lastSummaryQueryDurationMs = 0;
      this.lastSummaryQueryBandCount = 0;
      this.lastSummaryQueryNodeVisits = 0;
      this.lastSummaryQueryRawRowsScanned = 0;
      this.lastSummaryQueryVertices = 0;
      this.lastSummaryQueryTypedPayloadBytes = 0;
      this.emitDiagnostics();
      return {
        status: "applied",
        requestId,
        ...identity,
        columnId: request.columnId,
        start,
        end,
        rowCount: 0,
        exact: true,
        queryStats: {
          durationMs: 0,
          nodeVisits: 0,
          rawRowsScanned: 0,
          summaryVertices: 0,
          typedPayloadBytes: 0,
        },
        kind: descriptor.schema.kind === "number" ? "numeric" : "category",
        bands: [],
      };
    }

    return new Promise<GridSummaryBandsResult>((resolve, reject) => {
      const pending: PendingSummaryBandsQuery = {
        requestId,
        ...identity,
        columnId: request.columnId,
        start,
        end,
        ranges,
        resolve,
        reject,
        ...(request.signal ? { signal: request.signal } : {}),
      };
      if (request.signal) {
        pending.abortListener = () => this.abortSummaryQuery(pending);
        request.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.summaryQueries.set(requestId, pending);
      try {
        runtime.postMessage({
          type: "querySummary",
          queryId: requestId,
          datasetId: identity.datasetId,
          dataRevision: identity.dataRevision,
          viewRevision: identity.viewRevision,
          columnId: request.columnId,
          ranges,
        });
      } catch (error) {
        this.deleteSummaryQuery(pending);
        reject(error);
      }
    });
  }

  getDiagnostics(): GridDiagnostics {
    this.assertLive();
    return {
      renderMode: this.resolvedRenderMode,
      renderFallbackReason: this.renderFallbackReason,
      paintPipeline: "worker-formatted-bounded-viewport",
      dataOwnershipMode: this.viewExecutionMode === "worker" ? "runtime-worker" : "main-fallback",
      viewExecutionMode: this.viewExecutionMode,
      dataRevision: this.dataRevision,
      viewRevision: this.publishedViewRevision,
      physicalRowCount: this.dataset?.rowCount ?? 0,
      viewRowCount: this.viewState.rowCount,
      logicalScrollCompressed: this.scrollGeometry().compressed,
      lastPaintDurationMs: this.lastPaintDurationMs,
      lastPaintedCells: this.lastPaintedCells,
      lastViewBuildDurationMs: this.lastViewBuildDurationMs,
      lastMainStoreInstallDurationMs: this.lastHostIngressDurationMs,
      lastViewWorkerStoreInstallDurationMs: this.lastRuntimeInstallDurationMs,
      lastViewWorkerDispatchToReadyDurationMs: this.lastRuntimeDispatchToReadyDurationMs,
      paintError: this.paintError,
      summaryBlockSize: this.summaryBlockSize,
      summaryConfiguredColumnCount: this.summaryConfiguredColumnCount,
      summaryRetainedBytes: this.summaryRetainedBytes,
      summaryStagedReplacementPeakBytes: this.summaryStagedReplacementPeakBytes,
      lastSummaryBuildDurationMs: this.lastSummaryBuildDurationMs,
      lastSummaryQueryDurationMs: this.lastSummaryQueryDurationMs,
      lastSummaryQueryBandCount: this.lastSummaryQueryBandCount,
      lastSummaryQueryNodeVisits: this.lastSummaryQueryNodeVisits,
      lastSummaryQueryRawRowsScanned: this.lastSummaryQueryRawRowsScanned,
      lastSummaryQueryVertices: this.lastSummaryQueryVertices,
      lastSummaryQueryTypedPayloadBytes: this.lastSummaryQueryTypedPayloadBytes,
    };
  }

  getRenderMode(): "worker" | "main" | null {
    this.assertLive();
    return this.resolvedRenderMode;
  }

  resize(): void {
    this.assertLive();
    if (this.activeEditor && (!this.outstandingEdit || this.outstandingEdit.phase === "pending")) {
      this.cancelEdit();
    }
    const logicalTop = this.logicalScrollTop();
    const width = Math.max(0, this.scrollport.clientWidth || this.host.clientWidth);
    const height = Math.max(0, this.scrollport.clientHeight || this.host.clientHeight);
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.updateScrollExtent();
    this.scrollport.scrollTop = logicalToPhysicalScroll(logicalTop, this.scrollGeometry());
    this.semantics.setViewportSize(width, height);
    this.scheduleRender("resize");
  }

  async focusCell(cell: GridCellRef, options: GridFocusCellOptions = {}): Promise<boolean> {
    this.assertLive();
    this.throwIfRuntimeFailed();
    const target = await this.resolveCell(cell);
    if (!target || this.destroyed) return false;
    this.moveFocusResolved(target, false, "api", options.scrollIntoView !== false);
    this.semantics.element.focus({ preventScroll: true });
    return true;
  }

  async scrollToCell(cell: GridCellRef, options: GridScrollToCellOptions = {}): Promise<boolean> {
    this.assertLive();
    this.throwIfRuntimeFailed();
    const target = await this.resolveCell(cell);
    if (!target || this.destroyed) return false;
    this.scrollResolvedCell(target, options);
    this.scheduleRender("api");
    return true;
  }

  getFocusedCell(): GridCellRef | null {
    this.assertLive();
    return this.focusedCell;
  }

  getSelection(): GridRangeSelection | null {
    this.assertLive();
    return this.selection;
  }

  getViewport(): GridViewport {
    this.assertLive();
    return this.viewportSnapshot(
      this.dataset?.datasetId ?? null,
      this.publishedViewRevision,
      this.viewState.rowCount,
      this.logicalScrollTop(),
      this.publishedColumnLayout(),
    );
  }

  clearSelection(): void {
    this.assertLive();
    if (!this.selection) return;
    this.selection = null;
    this.selectionAnchorRowIndex = -1;
    this.selectionAnchorColumnIndex = -1;
    this.notifyHost(() => this.options.onSelectionChange?.({ selection: null, source: "api" }));
    this.scheduleRender("api");
  }

  cancelEdit(operationId?: string): boolean {
    this.assertLive();
    const operation = this.outstandingEdit;
    const hadEditor = this.activeEditor !== null;
    if (operationId && operation?.operationId !== operationId) return false;
    if (operation && operation.phase !== "pending" && operation.phase !== "reserving") return false;
    if (operation) {
      if (operation.phase === "reserving") operation.cancelledWhileReserving = true;
      operation.abortController.abort("cancelled");
      try {
        this.runtimeTransport?.postMessage({
          type: "cancelEdit",
          operationId: operation.operationId,
        });
      } catch {
        // Cancellation remains authoritative on the host before lease grant.
      }
      this.completeEdit(operation, "cancelled");
    }
    this.pendingParseOperationId = null;
    if (this.activeEditor) this.closeEditor(true);
    return Boolean(operation || hadEditor);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.paintReadyResolve?.();
    this.runtimeReadyResolve?.();
    this.paintReadyResolve = null;
    this.paintReadyReject = null;
    this.runtimeReadyResolve = null;
    this.runtimeReadyReject = null;
    this.pendingInstall?.abortController.abort("destroyed");
    this.pendingInstall?.reject(new Error("Grid was destroyed during dataset installation."));
    this.pendingInstall = null;
    this.supersedePendingView(false);
    if (this.outstandingEdit?.phase === "pending" || this.outstandingEdit?.phase === "reserving") {
      this.outstandingEdit.abortController.abort("destroyed");
      this.completeEdit(this.outstandingEdit, "cancelled");
    } else if (this.outstandingEdit?.phase === "committing") {
      this.requireEditReconciliation(
        this.outstandingEdit,
        "host-outcome-unknown",
        "The Grid was destroyed after the authoritative commit lease was granted.",
      );
    } else if (this.outstandingEdit?.phase === "applying") {
      this.requireEditReconciliation(
        this.outstandingEdit,
        "apply-failed",
        "The Grid was destroyed before the accepted edit could be published.",
      );
    }
    this.activeEditor?.overlay.destroy();
    this.activeEditor = null;
    this.paintTransport?.postMessage({ type: "dispose" });
    this.paintTransport?.terminate();
    this.paintTransport = null;
    this.runtimeTransport?.postMessage({ type: "dispose" });
    this.runtimeTransport?.terminate();
    this.runtimeTransport = null;
    this.emitSurfaceDropped(
      this.runtimeSurfaceInFlight ?? this.paintInFlight ?? this.awaitingRuntimePublication,
      "destroyed",
    );
    this.paintInFlight = null;
    this.runtimeSurfaceInFlight = null;
    this.awaitingRuntimePublication = null;
    this.settlePaintCommitLease();
    for (const query of this.rowQueries.values()) query.resolve(null);
    this.rowQueries.clear();
    for (const query of this.cellInspectionQueries.values()) query.resolve(null);
    this.cellInspectionQueries.clear();
    for (const query of this.summaryQueries.values()) {
      this.removeSummaryAbortListener(query);
      query.reject(new Error("Grid was destroyed during a summary query."));
    }
    this.summaryQueries.clear();
    for (const query of this.editParseQueries.values())
      query.reject(new Error("Grid was destroyed."));
    this.editParseQueries.clear();
    for (const query of this.editLeaseQueries.values()) {
      query.resolve({ granted: false, reason: "cancelled" });
    }
    this.editLeaseQueries.clear();
    this.dataset = null;
    this.visibleRowIds.clear();
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this.handleWindowResize);
    this.scrollport.removeEventListener("scroll", this.handleScroll);
    this.scrollport.removeEventListener("wheel", this.handleWheel);
    this.host.ownerDocument.removeEventListener(
      "pointerdown",
      this.handleDocumentPointerDown,
      true,
    );
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerUp);
    this.canvas.removeEventListener("dblclick", this.handleDoubleClick);
    this.semantics.element.removeEventListener("click", this.handleSemanticClick);
    this.semantics.element.removeEventListener("pointerdown", this.handleSemanticPointerDown);
    this.semantics.element.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("pointermove", this.handleResizePointerMove);
    window.removeEventListener("pointerup", this.handleResizePointerUp);
    window.removeEventListener("pointercancel", this.handleResizePointerUp);
    this.root.remove();
  }

  private handleScroll(): void {
    if (this.activeEditor && (!this.outstandingEdit || this.outstandingEdit.phase === "pending")) {
      this.cancelEdit();
    } else if (this.activeEditor) {
      this.positionActiveEditor();
    }
    this.scheduleRender("scroll");
  }

  private handleWheel(event: WheelEvent): void {
    const geometry = this.scrollGeometry();
    if (!geometry.compressed || event.ctrlKey || event.deltaY === 0) return;
    event.preventDefault();
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? this.layout.rowHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? Math.max(1, this.viewportHeight - this.layout.headerHeight)
          : 1;
    this.scrollport.scrollTop = logicalToPhysicalScroll(
      this.logicalScrollTop() + event.deltaY * unit,
      geometry,
    );
    if (event.deltaX !== 0) this.scrollport.scrollLeft += event.deltaX * unit;
  }

  private handleWindowResize(): void {
    this.resize();
  }

  private handleDocumentPointerDown(event: PointerEvent): void {
    const editor = this.activeEditor;
    if (!editor || event.button !== 0 || event.composedPath().includes(editor.overlay.element)) {
      return;
    }

    let exitTarget: GridEditorExitTarget = { kind: "external" };
    const target = event.target;
    if (target instanceof Node && this.root.contains(target)) {
      exitTarget = { kind: "grid" };
      const layout = this.interactiveColumnLayout();
      if (layout) {
        const rect = this.canvas.getBoundingClientRect();
        const hit = hitTestGrid(
          event.clientX - rect.left - this.rowNumberWidth,
          event.clientY - rect.top,
          this.logicalScrollTop(),
          this.scrollport.scrollLeft,
          this.viewState.rowCount,
          this.columnCount(),
          this.layout,
          layout,
        );
        const rowId = hit ? this.visibleRowIds.get(hit.rowIndex) : undefined;
        if (hit && rowId !== undefined) {
          exitTarget = {
            kind: "cell",
            rowId,
            columnId: this.columnIdAt(hit.columnIndex),
          };
        }
      }
    }

    editor.navigation = "stay";
    editor.exitTarget = exitTarget;
    if (this.pendingParseOperationId || this.outstandingEdit || !editor.overlay.canCommit()) return;
    void this.submitEditor(editor.overlay.value(), "stay", exitTarget);
  }

  private handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0 || event.pointerType === "touch" || this.activeEditor) return;
    const layout = this.interactiveColumnLayout();
    if (!layout) return;
    const rect = this.canvas.getBoundingClientRect();
    const hit = hitTestGrid(
      event.clientX - rect.left - this.rowNumberWidth,
      event.clientY - rect.top,
      this.logicalScrollTop(),
      this.scrollport.scrollLeft,
      this.viewState.rowCount,
      this.columnCount(),
      this.layout,
      layout,
    );
    if (!hit) return;
    const rowId = this.visibleRowIds.get(hit.rowIndex);
    if (rowId === undefined) return;
    event.preventDefault();
    this.moveFocusResolved(
      { rowIndex: hit.rowIndex, columnIndex: hit.columnIndex, rowId },
      event.shiftKey,
      "pointer",
      true,
    );
    this.activePointerId = event.pointerId;
    this.canvas.setPointerCapture?.(event.pointerId);
    this.semantics.element.focus({ preventScroll: true });
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.activeEditor || this.activePointerId !== event.pointerId || (event.buttons & 1) === 0)
      return;
    const layout = this.interactiveColumnLayout();
    if (!layout) return;
    const rect = this.canvas.getBoundingClientRect();
    const hit = hitTestGrid(
      event.clientX - rect.left - this.rowNumberWidth,
      event.clientY - rect.top,
      this.logicalScrollTop(),
      this.scrollport.scrollLeft,
      this.viewState.rowCount,
      this.columnCount(),
      this.layout,
      layout,
    );
    if (
      !hit ||
      (hit.rowIndex === this.focusedRowIndex && hit.columnIndex === this.focusedColumnIndex)
    ) {
      return;
    }
    const rowId = this.visibleRowIds.get(hit.rowIndex);
    if (rowId === undefined) return;
    event.preventDefault();
    this.moveFocusResolved(
      { rowIndex: hit.rowIndex, columnIndex: hit.columnIndex, rowId },
      true,
      "pointer",
      true,
    );
  }

  private handlePointerUp(event: PointerEvent): void {
    if (this.activePointerId !== event.pointerId) return;
    this.activePointerId = null;
    if (this.canvas.hasPointerCapture?.(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
  }

  private handleDoubleClick(event: MouseEvent): void {
    if (event.button !== 0 || this.activeEditor || !this.options.editing) return;
    const layout = this.interactiveColumnLayout();
    if (!layout) return;
    const rect = this.canvas.getBoundingClientRect();
    const hit = hitTestGrid(
      event.clientX - rect.left - this.rowNumberWidth,
      event.clientY - rect.top,
      this.logicalScrollTop(),
      this.scrollport.scrollLeft,
      this.viewState.rowCount,
      this.columnCount(),
      this.layout,
      layout,
    );
    if (!hit) return;
    const rowId = this.visibleRowIds.get(hit.rowIndex);
    if (rowId === undefined) return;
    this.moveFocusResolved(
      { rowIndex: hit.rowIndex, columnIndex: hit.columnIndex, rowId },
      false,
      "pointer",
      true,
    );
    event.preventDefault();
    void this.openEditor(hit.rowIndex, hit.columnIndex, rowId);
  }

  private handleSemanticClick(event: MouseEvent): void {
    if (this.activeEditor) return;
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest<HTMLElement>("[data-grid-sort-button]");
    const columnId = button?.dataset.gridColumnId;
    if (!columnId || !this.interactiveColumnLayout()) return;
    event.preventDefault();
    void this.toggleColumnSort(columnId);
  }

  private handleSemanticPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.activeEditor) return;
    const target = event.target instanceof Element ? event.target : null;
    const handle = target?.closest<HTMLElement>("[data-grid-resize-handle]");
    const columnId = handle?.dataset.gridColumnId;
    if (!columnId) return;
    const layout = this.interactiveColumnLayout();
    const columnIndex = this.columnIndexOf(columnId);
    if (!layout || columnIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.resizeGesture = {
      pointerId: event.pointerId,
      columnId,
      columnIndex,
      startX: event.clientX,
      startWidth: layout.widths[columnIndex] ?? this.layout.columnWidth,
    };
    this.semantics.element.setPointerCapture?.(event.pointerId);
  }

  private handleResizePointerMove(event: PointerEvent): void {
    const gesture = this.resizeGesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    event.preventDefault();
    this.resizeColumn(
      gesture.columnIndex,
      gesture.columnId,
      gesture.startWidth + event.clientX - gesture.startX,
    );
  }

  private handleResizePointerUp(event: PointerEvent): void {
    if (!this.resizeGesture || event.pointerId !== this.resizeGesture.pointerId) return;
    this.resizeGesture = null;
    if (this.semantics.element.hasPointerCapture?.(event.pointerId)) {
      this.semantics.element.releasePointerCapture(event.pointerId);
    }
  }

  private async toggleColumnSort(columnId: string): Promise<void> {
    if (this.columnIndexOf(columnId) < 0 || !this.dataset) return;
    const currentSpec = this.pendingView?.spec ?? this.publishedViewSpec;
    const primary = currentSpec.sort?.[0];
    const direction =
      primary?.columnId === columnId && primary.direction === "ascending"
        ? "descending"
        : "ascending";
    try {
      await this.setView({
        ...(currentSpec.filter ? { filter: currentSpec.filter } : {}),
        sort: [{ columnId, direction, nulls: "last" }],
      });
    } catch {
      // onViewChange reports the failed request.
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-grid-sort-button]")) return;
    const columnLayout = this.interactiveColumnLayout();
    const resizeHandle = target?.closest<HTMLElement>("[data-grid-resize-handle]");
    if (resizeHandle) {
      const columnId = resizeHandle.dataset.gridColumnId;
      const columnIndex = columnId ? this.columnIndexOf(columnId) : -1;
      if (columnLayout && columnId && columnIndex >= 0) {
        const width = columnLayout.widths[columnIndex] ?? this.layout.columnWidth;
        const nextWidth =
          event.key === "ArrowLeft"
            ? width - 8
            : event.key === "ArrowRight"
              ? width + 8
              : event.key === "Home"
                ? this.minColumnWidth
                : event.key === "End"
                  ? this.maxColumnWidth
                  : null;
        if (nextWidth !== null) {
          event.preventDefault();
          this.resizeColumn(columnIndex, columnId, nextWidth);
        }
      }
      return;
    }
    if (!columnLayout || this.viewState.rowCount === 0 || this.columnCount() === 0) return;
    if ((event.key === "Enter" || event.key === "F2") && !event.altKey && !event.metaKey) {
      const rowId = this.visibleRowIds.get(this.focusedRowIndex);
      if (rowId !== undefined) {
        event.preventDefault();
        void this.openEditor(this.focusedRowIndex, this.focusedColumnIndex, rowId);
      }
      return;
    }
    const pageRows = Math.max(
      1,
      Math.floor((this.viewportHeight - this.layout.headerHeight) / this.layout.rowHeight),
    );
    let rowIndex = Math.max(0, this.focusedRowIndex);
    let columnIndex = Math.max(0, this.focusedColumnIndex);
    switch (event.key) {
      case "ArrowUp":
        rowIndex -= 1;
        break;
      case "ArrowDown":
        rowIndex += 1;
        break;
      case "ArrowLeft":
        columnIndex -= 1;
        break;
      case "ArrowRight":
        columnIndex += 1;
        break;
      case "PageUp":
        rowIndex -= pageRows;
        break;
      case "PageDown":
        rowIndex += pageRows;
        break;
      case "Home":
        if (event.ctrlKey || event.metaKey) rowIndex = 0;
        columnIndex = 0;
        break;
      case "End":
        if (event.ctrlKey || event.metaKey) rowIndex = this.viewState.rowCount - 1;
        columnIndex = this.columnCount() - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    void this.moveFocusToOrdinal(
      Math.max(0, Math.min(this.viewState.rowCount - 1, rowIndex)),
      Math.max(0, Math.min(this.columnCount() - 1, columnIndex)),
      event.shiftKey,
      "keyboard",
    ).catch(() => undefined);
  }

  private async moveFocusToOrdinal(
    rowIndex: number,
    columnIndex: number,
    extend: boolean,
    source: GridInteractionSource,
  ): Promise<void> {
    let rowId = this.visibleRowIds.get(rowIndex);
    if (rowId === undefined) rowId = await this.resolveOrdinal(rowIndex);
    if (rowId === undefined || this.destroyed) return;
    this.moveFocusResolved({ rowIndex, columnIndex, rowId }, extend, source, true);
  }

  private moveFocusResolved(
    target: ResolvedCell,
    extend: boolean,
    source: GridInteractionSource,
    scrollIntoView: boolean,
  ): void {
    if (!this.dataset) return;
    if (!extend || !this.selection) {
      this.selectionAnchorRowIndex = target.rowIndex;
      this.selectionAnchorColumnIndex = target.columnIndex;
    }
    const anchorRow =
      extend && this.selectionAnchorRowIndex >= 0 ? this.selectionAnchorRowIndex : target.rowIndex;
    const anchorColumn =
      extend && this.selectionAnchorColumnIndex >= 0
        ? this.selectionAnchorColumnIndex
        : target.columnIndex;
    const anchorRowId =
      anchorRow === target.rowIndex
        ? target.rowId
        : (this.selection?.anchor.rowId ?? this.visibleRowIds.get(anchorRow));
    if (anchorRowId === undefined) return;
    this.focusedRowIndex = target.rowIndex;
    this.focusedColumnIndex = target.columnIndex;
    this.focusedCell = {
      rowId: target.rowId,
      columnId: this.columnIdAt(target.columnIndex),
    };
    this.selection = {
      kind: "range",
      datasetId: this.dataset.datasetId,
      viewRevision: this.publishedViewRevision,
      anchor: { rowId: anchorRowId, columnId: this.columnIdAt(anchorColumn) },
      focus: this.focusedCell,
    };
    if (scrollIntoView) this.scrollResolvedCell(target, {});
    this.notifyHost(() => this.options.onSelectionChange?.({ selection: this.selection, source }));
    this.scheduleRender("api");
  }

  private columnCount(): number {
    return this.dataset?.columns.length ?? 0;
  }

  private columnIndexOf(columnId: string): number {
    return this.dataset?.columns.findIndex((column) => column.schema.id === columnId) ?? -1;
  }

  private columnIdAt(columnIndex: number): string {
    const descriptor = this.dataset?.columns[columnIndex];
    if (!descriptor)
      throw new RangeError(`Column index ${columnIndex} is outside the active dataset.`);
    return descriptor.schema.id;
  }

  private editNavigationColumn(currentColumn: number, navigation: GridEditorNavigation): number {
    if (navigation === "stay" || !this.dataset) return currentColumn;
    const direction = navigation === "next" ? 1 : -1;
    for (
      let column = currentColumn + direction;
      column >= 0 && column < this.dataset.columns.length;
      column += direction
    ) {
      const schema = this.dataset.columns[column]!.schema;
      if (schema.editable === true && schema.kind !== "timestamp" && schema.kind !== "id") {
        return column;
      }
    }
    return currentColumn;
  }

  private rebuildColumnLayout(descriptor: GridRuntimeDatasetDescriptor): GridColumnLayout {
    const widths = descriptor.columns.map(
      (column) => this.columnWidthsById.get(column.schema.id) ?? this.layout.columnWidth,
    );
    return createGridColumnLayout(widths, ++this.nextColumnLayoutRevision);
  }

  private resizeColumn(columnIndex: number, columnId: string, requestedWidth: number): void {
    if (this.activeEditor && (!this.outstandingEdit || this.outstandingEdit.phase === "pending")) {
      this.cancelEdit();
    }
    if (this.dataset?.columns[columnIndex]?.schema.id !== columnId) return;
    const width = Math.max(
      this.minColumnWidth,
      Math.min(this.maxColumnWidth, Math.round(requestedWidth)),
    );
    if (this.columnLayout.widths[columnIndex] === width) return;
    const widths = [...this.columnLayout.widths];
    widths[columnIndex] = width;
    this.columnWidthsById.set(columnId, width);
    this.columnLayout = createGridColumnLayout(widths, ++this.nextColumnLayoutRevision);
    this.updateScrollExtent();
    this.scheduleRender("resize");
  }

  private dataViewportWidth(): number {
    return Math.max(0, this.viewportWidth - this.rowNumberWidth);
  }

  private publishedColumnLayout(): GridColumnLayout {
    return this.presentedColumnLayout.widths.length === this.columnCount()
      ? this.presentedColumnLayout
      : this.columnLayout;
  }

  private interactiveColumnLayout(): GridColumnLayout | null {
    if (
      !this.dataset ||
      this.editingLocked ||
      this.runtimeSurfaceInFlight ||
      this.paintInFlight ||
      this.awaitingRuntimePublication ||
      this.outstandingEdit?.phase === "committing" ||
      this.outstandingEdit?.phase === "applying"
    ) {
      return null;
    }
    return this.presentedColumnLayout.revision === this.columnLayout.revision
      ? this.presentedColumnLayout
      : null;
  }

  private scrollGeometry(rowCount = this.viewState.rowCount) {
    return logicalScrollGeometry(
      rowCount,
      this.layout.rowHeight,
      this.layout.headerHeight,
      this.viewportHeight,
    );
  }

  private logicalScrollTop(rowCount = this.viewState.rowCount): number {
    return physicalToLogicalScroll(this.scrollport.scrollTop, this.scrollGeometry(rowCount));
  }

  private scrollResolvedCell(
    cell: { rowIndex: number; columnIndex: number },
    options: GridScrollToCellOptions,
  ): void {
    const columnLayout = this.columnLayout;
    const rowViewport = Math.max(1, this.viewportHeight - this.layout.headerHeight);
    const columnViewport = Math.max(1, this.dataViewportWidth());
    const top = alignedScrollOffset(
      cell.rowIndex * this.layout.rowHeight,
      this.layout.rowHeight,
      this.logicalScrollTop(),
      rowViewport,
      options.block ?? "nearest",
    );
    const left = alignedScrollOffset(
      columnLayout.offsets[cell.columnIndex] ?? 0,
      columnLayout.widths[cell.columnIndex] ?? this.layout.columnWidth,
      this.scrollport.scrollLeft,
      columnViewport,
      options.inline ?? "nearest",
    );
    const maxTop = Math.max(
      0,
      this.layout.headerHeight +
        this.viewState.rowCount * this.layout.rowHeight -
        this.viewportHeight,
    );
    const maxLeft = Math.max(0, this.rowNumberWidth + columnLayout.totalWidth - this.viewportWidth);
    this.scrollport.scrollTop = logicalToPhysicalScroll(
      Math.max(0, Math.min(maxTop, top)),
      this.scrollGeometry(),
    );
    this.scrollport.scrollLeft = Math.max(0, Math.min(maxLeft, left));
  }

  private updateScrollExtent(): void {
    this.spacer.style.width = `${Math.max(1, this.rowNumberWidth + this.columnLayout.totalWidth)}px`;
    this.spacer.style.height = `${this.scrollGeometry().physicalExtent}px`;
  }

  private viewportSnapshot(
    datasetId: string | null,
    viewRevision: number,
    rowCount: number,
    logicalScrollTop: number,
    columnLayout: GridColumnLayout,
  ): GridViewport {
    const range = visibleGridRange(
      logicalScrollTop,
      this.scrollport.scrollLeft,
      this.dataViewportWidth(),
      this.viewportHeight,
      rowCount,
      columnLayout.widths.length,
      { ...this.layout, overscanRows: 0, overscanColumns: 0 },
      columnLayout,
    );
    return {
      datasetId,
      viewRevision,
      rowStart: range.rows.start,
      rowEnd: range.rows.end,
      columnStart: range.columns.start,
      columnEnd: range.columns.end,
      scrollTop: logicalScrollTop,
      scrollLeft: this.scrollport.scrollLeft,
    };
  }

  private scheduleRender(source: ViewportSource, recordIntent = true): void {
    if (recordIntent) this.recordSurfaceIntent(source);
    if (
      this.pendingViewportSource === null ||
      viewportSourcePriority(source) >= viewportSourcePriority(this.pendingViewportSource)
    ) {
      this.pendingViewportSource = source;
    }
    if (
      !this.initialized ||
      this.destroyed ||
      this.frame ||
      this.runtimeSurfaceInFlight ||
      this.paintInFlight ||
      this.awaitingRuntimePublication
    ) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    if (
      this.destroyed ||
      !this.runtimeTransport ||
      this.runtimeSurfaceInFlight ||
      this.paintInFlight ||
      this.awaitingRuntimePublication
    ) {
      return;
    }

    const pendingInstall = this.pendingInstall?.descriptor ? this.pendingInstall : null;
    const pendingView = this.pendingView?.rowCount !== null ? this.pendingView : null;
    const pendingEdit = this.pendingEditCandidate;
    let target: GridRuntimeSurfaceTarget;
    let datasetId: string;
    let dataRevision: number;
    let viewRevision: number;
    let rowCount: number;
    let columnLayout: GridColumnLayout;
    let focusedRowIndex: number;
    let focusedColumnIndex: number;
    let logicalTop: number;
    let selection: GridRangeSelection | null;
    let source = this.pendingViewportSource ?? "resize";

    if (pendingEdit && this.dataset) {
      target = { kind: "edit", operationId: pendingEdit.operationId };
      datasetId = this.dataset.datasetId;
      dataRevision = pendingEdit.dataRevision;
      viewRevision = pendingEdit.viewRevision;
      rowCount = pendingEdit.rowCount;
      columnLayout = this.columnLayout;
      const editor = this.activeEditor;
      focusedRowIndex =
        rowCount > 0 && this.columnCount() > 0
          ? pendingEdit.editedRowIndex >= 0
            ? pendingEdit.editedRowIndex
            : Math.max(0, Math.min(rowCount - 1, editor?.rowIndex ?? this.focusedRowIndex))
          : -1;
      focusedColumnIndex =
        focusedRowIndex >= 0
          ? Math.max(
              0,
              Math.min(
                this.columnCount() - 1,
                editor
                  ? this.editNavigationColumn(editor.columnIndex, editor.navigation)
                  : this.focusedColumnIndex,
              ),
            )
          : -1;
      const geometry = this.scrollGeometry(rowCount);
      logicalTop = Math.max(0, Math.min(geometry.logicalMax, this.logicalScrollTop()));
      if (focusedRowIndex >= 0) {
        logicalTop = Math.max(
          0,
          Math.min(
            geometry.logicalMax,
            alignedScrollOffset(
              focusedRowIndex * this.layout.rowHeight,
              this.layout.rowHeight,
              logicalTop,
              Math.max(1, this.viewportHeight - this.layout.headerHeight),
              "nearest",
            ),
          ),
        );
      }
      selection = null;
      source = pendingEdit.viewChanged ? "view" : "data";
    } else if (pendingInstall?.descriptor && pendingInstall.columnLayout) {
      target = { kind: "install", requestId: pendingInstall.requestId };
      datasetId = pendingInstall.descriptor.datasetId;
      dataRevision = pendingInstall.dataRevision;
      viewRevision = 0;
      rowCount = pendingInstall.descriptor.rowCount;
      columnLayout = pendingInstall.columnLayout;
      focusedRowIndex = rowCount > 0 && columnLayout.widths.length > 0 ? 0 : -1;
      focusedColumnIndex = focusedRowIndex >= 0 ? 0 : -1;
      logicalTop = 0;
      selection = null;
      source = "data";
    } else if (pendingView && pendingView.rowCount !== null && this.dataset) {
      target = { kind: "view", requestId: pendingView.requestId };
      datasetId = this.dataset.datasetId;
      dataRevision = this.dataRevision;
      viewRevision = pendingView.viewRevision;
      rowCount = pendingView.rowCount;
      columnLayout = this.columnLayout;
      focusedRowIndex =
        rowCount > 0 && this.columnCount() > 0
          ? Math.max(0, Math.min(rowCount - 1, this.focusedRowIndex))
          : -1;
      focusedColumnIndex =
        focusedRowIndex >= 0
          ? Math.max(0, Math.min(this.columnCount() - 1, this.focusedColumnIndex))
          : -1;
      const geometry = this.scrollGeometry(rowCount);
      logicalTop = Math.max(0, Math.min(geometry.logicalMax, this.logicalScrollTop()));
      if (focusedRowIndex >= 0) {
        logicalTop = Math.max(
          0,
          Math.min(
            geometry.logicalMax,
            alignedScrollOffset(
              focusedRowIndex * this.layout.rowHeight,
              this.layout.rowHeight,
              logicalTop,
              Math.max(1, this.viewportHeight - this.layout.headerHeight),
              "nearest",
            ),
          ),
        );
      }
      selection = null;
      source = "view";
    } else if (this.dataset) {
      target = { kind: "active" };
      datasetId = this.dataset.datasetId;
      dataRevision = this.dataRevision;
      viewRevision = this.publishedViewRevision;
      rowCount = this.viewState.rowCount;
      columnLayout = this.columnLayout;
      focusedRowIndex = this.focusedRowIndex;
      focusedColumnIndex = this.focusedColumnIndex;
      logicalTop = this.logicalScrollTop();
      selection = this.selection;
    } else {
      this.pendingViewportSource = null;
      this.pendingSurfaceIntent = null;
      return;
    }

    this.pendingViewportSource = null;
    const telemetryIntent = this.pendingSurfaceIntent;
    this.pendingSurfaceIntent = null;
    const range = visibleGridRange(
      logicalTop,
      this.scrollport.scrollLeft,
      this.dataViewportWidth(),
      this.viewportHeight,
      rowCount,
      columnLayout.widths.length,
      this.layout,
      columnLayout,
    );
    const surfaceId = ++this.nextSurfaceId;
    const commitToken = `d${dataRevision}:v${viewRevision}:s${surfaceId}`;
    const viewport = this.viewportSnapshot(
      datasetId,
      viewRevision,
      rowCount,
      logicalTop,
      columnLayout,
    );
    const pixelRatio = Math.min(4, Math.max(1, window.devicePixelRatio || 1));
    const telemetry: SurfaceTelemetryTrace | null =
      telemetryIntent && this.surfaceTelemetry
        ? {
            surfaceId,
            commitToken,
            intentId: telemetryIntent.intentId,
            intentAtMs: telemetryIntent.observedAtMs,
            source,
            targetKind: target.kind,
            columnLayoutRevision: columnLayout.revision,
            viewportWidth: this.viewportWidth,
            viewportHeight: this.viewportHeight,
            pixelRatio,
            datasetRowCount:
              target.kind === "install"
                ? (pendingInstall?.descriptor?.rowCount ?? rowCount)
                : (this.dataset?.rowCount ?? rowCount),
            scrollTop: viewport.scrollTop,
            scrollLeft: viewport.scrollLeft,
            viewportRowStart: viewport.rowStart,
            viewportRowEnd: viewport.rowEnd,
            viewportColumnStart: viewport.columnStart,
            viewportColumnEnd: viewport.columnEnd,
            intentScrollTop: telemetryIntent.scrollTop,
            intentScrollLeft: telemetryIntent.scrollLeft,
            dropped: false,
          }
        : null;
    const transform = `translate(${this.scrollport.scrollLeft}px, ${this.scrollport.scrollTop}px)`;
    this.canvas.style.transform = transform;
    this.semantics.element.style.transform = transform;
    this.canvas.style.width = `${this.viewportWidth}px`;
    this.canvas.style.height = `${this.viewportHeight}px`;
    this.runtimeSurfaceInFlight = {
      surfaceId,
      commitToken,
      target,
      columnLayout,
      viewport,
      focusedRowIndex,
      focusedColumnIndex,
      telemetry,
    };
    if (telemetry) {
      this.emitSurfaceTelemetry({
        type: "requested",
        ...this.surfaceTelemetryBase(telemetry, performance.now()),
      });
    }
    try {
      this.runtimeTransport.postMessage({
        type: "surface",
        surfaceId,
        commitToken,
        source,
        target,
        revision: {
          datasetId,
          dataRevision,
          viewRevision,
          presentationRevision: surfaceId,
        },
        viewportWidth: this.viewportWidth,
        viewportHeight: this.viewportHeight,
        pixelRatio,
        scrollTop: logicalTop,
        scrollLeft: this.scrollport.scrollLeft,
        range,
        layout: this.layout,
        columnLayout,
        rowNumberWidth: this.rowNumberWidth,
        rowNumberLabel: this.rowNumberLabel,
        minColumnWidth: this.minColumnWidth,
        maxColumnWidth: this.maxColumnWidth,
        palette: readGridPalette(this.host),
        selection,
        focusedRowIndex,
        focusedColumnIndex,
      });
    } catch (error) {
      this.emitSurfaceDropped(this.runtimeSurfaceInFlight, "runtime-transport-failure");
      this.runtimeSurfaceInFlight = null;
      this.handleRuntimeFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private bindPaintTransport(transport: GridPaintTransport): void {
    transport.onmessage = (event) => this.handlePaintMessage(event.data);
    transport.onerror = (event) =>
      this.handlePaintFailure(
        event.error instanceof Error ? event.error : new Error(event.message),
      );
    transport.onmessageerror = () =>
      this.handlePaintFailure(
        new Error("The Grid paint transport could not deserialize a message."),
      );
  }

  private handlePaintMessage(message: GridPaintOutputMessage): void {
    if (this.destroyed) return;
    if (message.type === "ready") {
      this.paintReadyResolve?.();
      this.paintReadyResolve = null;
      this.paintReadyReject = null;
      return;
    }
    if (message.type === "initError" || message.type === "runtimeError") {
      this.handlePaintFailure(new Error(message.error.message));
      return;
    }
    if (message.type === "disposed" || !("frameId" in message)) return;
    const surface = this.paintInFlight;
    if (
      !surface ||
      message.frameId !== surface.runtime.frame.frameId ||
      message.commitToken !== surface.runtime.frame.commitToken
    ) {
      return;
    }
    if (message.type === "prepared") {
      if (!this.canPresentSurface(surface)) {
        this.paintInFlight = null;
        this.emitSurfaceDropped(surface, "presentation-invalidated");
        this.dropRuntimeSurface(surface);
        return;
      }
      this.createPaintCommitLease(surface);
      try {
        this.paintTransport?.postMessage({
          type: "commit",
          frameId: surface.runtime.frame.frameId,
          commitToken: surface.runtime.frame.commitToken,
        });
      } catch (error) {
        this.handlePaintFailure(error, surface);
      }
      return;
    }
    this.paintInFlight = null;
    if (message.type === "presented") {
      const paintPresentedAtMs = surface.telemetry ? performance.now() : 0;
      if (!this.matchesPaintCommitLease(surface)) {
        this.handlePaintFailure(
          new Error("The Grid paint worker presented an unauthorized frame."),
          surface,
        );
        return;
      }
      this.lastPaintDurationMs = message.durationMs;
      this.lastPaintedCells = message.paintedCells;
      const semanticStartedAt = surface.telemetry ? performance.now() : 0;
      this.semantics.updateFrame(
        surface.runtime.frame,
        surface.runtime.rowCount,
        surface.runtime.columnCount,
      );
      const semanticCompleteAtMs = surface.telemetry ? performance.now() : 0;
      const semanticDurationMs = surface.telemetry
        ? Math.max(0, semanticCompleteAtMs - semanticStartedAt)
        : 0;
      this.awaitingRuntimePublication = surface;
      if (surface.telemetry) {
        this.emitSurfaceTelemetry({
          type: "paint-presented",
          ...this.surfaceTelemetryBase(surface.telemetry, paintPresentedAtMs),
          paintDurationMs: message.durationMs,
          paintedCells: message.paintedCells,
          semanticDurationMs,
          semanticCompleteAtMs,
        });
      }
      try {
        this.requireRuntimeTransport().postMessage({
          type: "finalizeSurface",
          surfaceId: surface.runtime.surfaceId,
          commitToken: surface.runtime.commitToken,
        });
      } catch (error) {
        this.awaitingRuntimePublication = null;
        this.handleRuntimeFailure(error instanceof Error ? error : new Error(String(error)));
      }
    } else if (message.type === "dropped") {
      this.settlePaintCommitLease();
      this.emitSurfaceDropped(surface, `paint-${message.reason}`);
      this.dropRuntimeSurface(surface);
    }
  }

  private canPresentSurface(surface: PendingSurface): boolean {
    const requested = surface.runtime.target;
    if (surface.columnLayout.revision !== this.targetColumnLayout(requested)?.revision)
      return false;
    if (requested.kind === "install") {
      return (
        this.pendingInstall?.requestId === requested.requestId &&
        this.pendingInstall.descriptor?.datasetId === surface.runtime.frame.revision.datasetId
      );
    }
    if (requested.kind === "view") {
      return (
        this.pendingView?.requestId === requested.requestId &&
        this.pendingView.viewRevision === surface.runtime.frame.revision.viewRevision
      );
    }
    if (requested.kind === "edit") {
      return (
        this.pendingEditCandidate?.operationId === requested.operationId &&
        this.pendingEditCandidate.dataRevision === surface.runtime.frame.revision.dataRevision &&
        this.pendingEditCandidate.viewRevision === surface.runtime.frame.revision.viewRevision
      );
    }
    return (
      this.dataset?.datasetId === surface.runtime.frame.revision.datasetId &&
      this.publishedViewRevision === surface.runtime.frame.revision.viewRevision
    );
  }

  private targetColumnLayout(target: GridRuntimeSurfaceTarget): GridColumnLayout | null {
    return target.kind === "install"
      ? this.pendingInstall?.requestId === target.requestId
        ? this.pendingInstall.columnLayout
        : null
      : this.columnLayout;
  }

  private createPaintCommitLease(surface: PendingSurface): void {
    if (this.paintCommitLease)
      throw new Error("The Grid paint transport already has a commit lease.");
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.paintCommitLease = {
      surfaceId: surface.runtime.surfaceId,
      commitToken: surface.runtime.commitToken,
      settled,
      settle,
    };
  }

  private matchesPaintCommitLease(surface: PendingSurface): boolean {
    return (
      this.paintCommitLease?.surfaceId === surface.runtime.surfaceId &&
      this.paintCommitLease.commitToken === surface.runtime.commitToken
    );
  }

  private settlePaintCommitLease(): void {
    const lease = this.paintCommitLease;
    this.paintCommitLease = null;
    lease?.settle();
  }

  private dropRuntimeSurface(surface: RequestedSurface | PendingSurface): void {
    const surfaceId = "runtime" in surface ? surface.runtime.surfaceId : surface.surfaceId;
    const commitToken = "runtime" in surface ? surface.runtime.commitToken : surface.commitToken;
    try {
      this.runtimeTransport?.postMessage({
        type: "dropSurface",
        surfaceId,
        commitToken,
      });
    } catch (error) {
      this.handleRuntimeFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handlePaintFailure(reason: unknown, failedSurface?: PendingSurface): void {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.paintError = error.message;
    this.paintReadyReject?.(error);
    this.paintReadyResolve = null;
    this.paintReadyReject = null;
    const surface =
      failedSurface ??
      this.paintInFlight ??
      this.awaitingRuntimePublication ??
      this.runtimeSurfaceInFlight;
    this.emitSurfaceDropped(surface, "paint-failure");
    this.paintInFlight = null;
    this.awaitingRuntimePublication = null;
    this.runtimeSurfaceInFlight = null;
    if (surface) this.dropRuntimeSurface(surface);
    this.settlePaintCommitLease();
    this.failPendingOperationForSurface(surface, error);
    this.emitDiagnostics();
  }

  private handleRuntimeMessage(message: GridRuntimeOutputMessage): void {
    if (this.destroyed) return;
    switch (message.type) {
      case "ready":
        this.runtimeReadyResolve?.();
        this.runtimeReadyResolve = null;
        this.runtimeReadyReject = null;
        return;
      case "installProgress":
        return;
      case "installReady": {
        const pending = this.pendingInstall;
        if (!pending || pending.requestId !== message.requestId) return;
        pending.descriptor = message.descriptor;
        pending.columnLayout = this.rebuildColumnLayout(message.descriptor);
        pending.installDurationMs = message.installDurationMs;
        this.lastRuntimeInstallDurationMs = message.installDurationMs;
        this.lastRuntimeDispatchToReadyDurationMs =
          pending.workerDispatchStartedAt === null
            ? null
            : Math.max(0, performance.now() - pending.workerDispatchStartedAt);
        this.scheduleRender("data");
        this.emitDiagnostics();
        return;
      }
      case "viewProgress": {
        const pending = this.pendingView;
        if (!pending || pending.requestId !== message.requestId) return;
        this.viewState = {
          ...this.viewState,
          progress: {
            phase: message.phase,
            completed: message.completed,
            total: message.total,
          },
        };
        this.notifyHost(() => this.options.onViewChange?.(this.viewState));
        return;
      }
      case "viewReady": {
        const pending = this.pendingView;
        if (
          !pending ||
          pending.requestId !== message.requestId ||
          pending.datasetId !== message.datasetId ||
          pending.viewRevision !== message.viewRevision
        ) {
          return;
        }
        pending.rowCount = message.rowCount;
        pending.buildDurationMs = message.buildDurationMs;
        this.lastViewBuildDurationMs = message.buildDurationMs;
        this.scheduleRender("view");
        this.emitDiagnostics();
        return;
      }
      case "surfaceReady": {
        const requested = this.runtimeSurfaceInFlight;
        if (
          !requested ||
          "runtime" in requested ||
          requested.surfaceId !== message.surfaceId ||
          requested.commitToken !== message.commitToken
        ) {
          return;
        }
        const surface: PendingSurface = {
          runtime: message,
          columnLayout: requested.columnLayout,
          viewport: requested.viewport,
          focusedRowIndex: requested.focusedRowIndex,
          focusedColumnIndex: requested.focusedColumnIndex,
          telemetry: requested.telemetry,
        };
        this.runtimeSurfaceInFlight = surface;
        this.paintInFlight = surface;
        if (surface.telemetry) {
          this.emitSurfaceTelemetry({
            type: "runtime-ready",
            ...this.surfaceTelemetryBase(surface.telemetry, performance.now()),
            formatDurationMs: message.formatDurationMs,
            visibleRows: message.frame.rows.length,
            visibleColumns: message.frame.columns.length,
            firstRenderedRowIndex: message.frame.rows[0]?.viewOrdinal ?? null,
            lastRenderedRowIndex:
              message.frame.rows[message.frame.rows.length - 1]?.viewOrdinal ?? null,
            firstRenderedColumnIndex: message.frame.columns[0]?.columnIndex ?? null,
            lastRenderedColumnIndex:
              message.frame.columns[message.frame.columns.length - 1]?.columnIndex ?? null,
            datasetRowCount: surface.telemetry.datasetRowCount,
            viewRowCount: message.rowCount,
            datasetColumnCount: message.columnCount,
            cellCount: message.frame.cellText.length,
            textCodeUnits: gridPaintFrameTextCodeUnits(message.frame),
          });
        }
        try {
          this.paintTransport?.postMessage({ type: "prepare", frame: message.frame });
        } catch (error) {
          this.handlePaintFailure(error, surface);
        }
        return;
      }
      case "published":
        this.finishRuntimePublication(message);
        return;
      case "surfaceDropped": {
        const current = this.runtimeSurfaceInFlight;
        if (
          current &&
          ("runtime" in current ? current.runtime.surfaceId : current.surfaceId) ===
            message.surfaceId &&
          ("runtime" in current
            ? current.runtime.commitToken === message.commitToken
            : current.commitToken === message.commitToken)
        ) {
          this.emitSurfaceDropped(current, `runtime-${message.reason}`);
          if (message.reason !== "stale") this.restoreSurfaceIntent(current);
          this.runtimeSurfaceInFlight = null;
          this.paintInFlight = null;
          this.awaitingRuntimePublication = null;
          if (message.reason === "stale") {
            const error = new Error(
              "The Grid runtime rejected a surface whose revision no longer matches its target.",
            );
            const target = "runtime" in current ? current.runtime.target : current.target;
            if (target.kind === "active") {
              // Retrying the same active tuple cannot repair a revision
              // mismatch and would create a self-sustaining render loop.
              this.handleRuntimeFailure(error);
              return;
            }
            this.failPendingOperationForSurface(current, error);
            this.emitDiagnostics();
            this.scheduleLatestSurface();
            return;
          }
          this.scheduleLatestSurface();
        }
        return;
      }
      case "cancelled":
        if (message.scope === "install" && this.pendingInstall?.requestId === message.requestId) {
          const pending = this.pendingInstall;
          this.pendingInstall = null;
          pending.reject(createAbortError("Grid dataset installation was cancelled."));
        } else if (message.scope === "view" && this.pendingView?.requestId === message.requestId) {
          const pending = this.pendingView;
          this.pendingView = null;
          pending.resolve({ status: "superseded", requestId: pending.requestId });
        }
        this.scheduleLatestSurface();
        return;
      case "summaryReady":
        this.finishSummaryQuery(message);
        return;
      case "summaryCancelled": {
        const query = this.summaryQueries.get(message.queryId);
        if (!query) return;
        this.deleteSummaryQuery(query);
        query.resolve({ status: "superseded", requestId: query.requestId });
        return;
      }
      case "resolvedRow": {
        const query = this.rowQueries.get(message.queryId);
        if (!query) return;
        this.rowQueries.delete(message.queryId);
        if (
          query.datasetId !== message.datasetId ||
          this.dataset?.datasetId !== message.datasetId
        ) {
          query.resolve(null);
          return;
        }
        query.resolve(
          message.physicalRow < 0 || message.viewOrdinal < 0
            ? null
            : {
                physicalRow: message.physicalRow,
                viewOrdinal: message.viewOrdinal,
                rowId: message.rowId,
              },
        );
        return;
      }
      case "resolvedOrdinal": {
        const query = this.rowQueries.get(message.queryId);
        if (!query) return;
        this.rowQueries.delete(message.queryId);
        if (
          query.datasetId !== message.datasetId ||
          this.dataset?.datasetId !== message.datasetId ||
          message.rowId === null ||
          message.physicalRow < 0
        ) {
          query.resolve(null);
          return;
        }
        query.resolve({
          physicalRow: message.physicalRow,
          viewOrdinal: message.viewOrdinal,
          rowId: message.rowId,
        });
        return;
      }
      case "cellInspected": {
        const query = this.cellInspectionQueries.get(message.queryId);
        if (!query) return;
        this.cellInspectionQueries.delete(message.queryId);
        if (
          query.datasetId !== message.datasetId ||
          this.dataset?.datasetId !== message.datasetId
        ) {
          query.resolve(null);
          return;
        }
        query.resolve({
          datasetId: message.datasetId,
          rowId: message.rowId,
          columnId: message.columnId,
          descriptor: message.descriptor,
          value: message.value,
          cellRevision: message.cellRevision,
          ...(message.categoryValues ? { categoryValues: message.categoryValues } : {}),
        });
        return;
      }
      case "editParsed": {
        const query = this.editParseQueries.get(message.operationId);
        if (!query) return;
        this.editParseQueries.delete(message.operationId);
        query.resolve(message.value);
        return;
      }
      case "editLease": {
        const query = this.editLeaseQueries.get(message.operationId);
        if (!query) return;
        this.editLeaseQueries.delete(message.operationId);
        const operation = this.outstandingEdit;
        if (
          !operation ||
          operation.operationId !== message.operationId ||
          operation.abortController.signal.aborted ||
          operation.cancelledWhileReserving
        ) {
          try {
            this.runtimeTransport?.postMessage({
              type: "cancelEdit",
              operationId: message.operationId,
            });
          } catch {
            // A late grant is never exposed to the host after cancellation.
          }
          query.resolve({ granted: false, reason: "cancelled" });
          return;
        }
        if (!message.result.granted) {
          const editor = this.activeEditor;
          operation.phase = "pending";
          query.resolve(message.result);
          const messageText =
            message.result.message ??
            (message.result.reason === "stale"
              ? "The cell changed before commit."
              : "The normalized edit value is invalid.");
          this.completeEdit(operation, message.result.reason, { message: messageText });
          if (message.result.reason === "invalid-normalization") {
            if (editor) this.resetEditorExitIntent(editor);
            editor?.overlay.setError(messageText);
          } else {
            if (editor) this.finishEditorExit(editor, false);
            else this.closeEditor(true);
          }
          return;
        }
        operation.phase = "committing";
        operation.leaseId = message.result.leaseId;
        operation.finalValue = message.result.finalValue;
        this.root.dataset.gridEditState = "committing";
        this.activeEditor?.overlay.setStatus("committing", "Saving authoritative value");
        operation.timeoutId = setTimeout(
          () =>
            this.requireEditReconciliation(
              operation,
              "host-outcome-unknown",
              "The edit host timed out after commit began.",
            ),
          editCommitTimeout(this.options.editing?.commitTimeoutMs),
        );
        query.resolve(message.result);
        return;
      }
      case "editProgress":
        if (this.outstandingEdit?.operationId === message.operationId) {
          const percentage =
            message.total > 0 ? Math.round((message.completed / message.total) * 100) : 100;
          this.activeEditor?.overlay.setStatus(
            "applying",
            `Applying committed value: ${message.phase} ${percentage}%`,
          );
        }
        return;
      case "editReady": {
        const operation = this.outstandingEdit;
        if (
          !operation ||
          operation.operationId !== message.operationId ||
          operation.phase !== "applying"
        )
          return;
        this.pendingEditCandidate = {
          operationId: message.operationId,
          dataRevision: message.dataRevision,
          viewRevision: message.viewRevision,
          rowCount: message.rowCount,
          editedRowIndex: message.editedRowIndex,
          viewChanged: message.viewChanged,
          buildDurationMs: message.buildDurationMs,
        };
        this.scheduleRender(message.viewChanged ? "view" : "data");
        return;
      }
      case "runtimeError":
        this.handleRuntimeOperationError(message);
        return;
      case "disposed":
        return;
    }
  }

  private finishRuntimePublication(
    message: Extract<GridRuntimeOutputMessage, { type: "published" }>,
  ): void {
    const surface = this.awaitingRuntimePublication;
    if (
      !surface ||
      surface.runtime.surfaceId !== message.surfaceId ||
      surface.runtime.commitToken !== message.commitToken
    ) {
      return;
    }
    const runtimeAckAtMs = surface.telemetry ? performance.now() : 0;

    this.awaitingRuntimePublication = null;
    this.runtimeSurfaceInFlight = null;
    this.presentedColumnLayout = surface.columnLayout;
    this.visibleRowIds = new Map(
      surface.runtime.frame.rows.map((row, index) => [
        row.viewOrdinal,
        surface.runtime.visibleRowIds[index]!,
      ]),
    );

    let callbackSource: ViewportSource = surface.runtime.source;
    if (message.publicationKind === "data") {
      const pending = this.pendingInstall;
      if (
        !pending ||
        surface.runtime.target.kind !== "install" ||
        pending.requestId !== surface.runtime.target.requestId ||
        pending.descriptor?.datasetId !== message.descriptor.datasetId ||
        !pending.columnLayout
      ) {
        this.handleRuntimeFailure(
          new Error("The Grid runtime published an unknown dataset."),
          surface,
        );
        return;
      }
      const hadSelection = this.selection !== null;
      this.dataset = message.descriptor;
      this.dataRevision = message.descriptor.dataRevision;
      this.columnLayout = pending.columnLayout;
      this.nextViewRevision = 0;
      this.viewState = {
        status: "ready",
        requestId: ++this.nextViewRequestId,
        viewRevision: 0,
        spec: {},
        rowCount: message.rowCount,
        durationMs: pending.installDurationMs ?? undefined,
      };
      this.publishedViewRevision = 0;
      this.publishedViewSpec = {};
      this.focusedRowIndex = surface.focusedRowIndex;
      this.focusedColumnIndex = surface.focusedColumnIndex;
      const focusedRowId = this.visibleRowIds.get(this.focusedRowIndex);
      this.focusedCell =
        focusedRowId === undefined || this.focusedColumnIndex < 0
          ? null
          : {
              rowId: focusedRowId,
              columnId: this.columnIdAt(this.focusedColumnIndex),
            };
      this.selection = null;
      this.selectionAnchorRowIndex = -1;
      this.selectionAnchorColumnIndex = -1;
      this.scrollport.scrollTop = 0;
      this.scrollport.scrollLeft = 0;
      this.semantics.setEditableColumns(
        this.options.editing
          ? message.descriptor.columns
              .filter((column) => column.schema.editable === true)
              .map((column) => column.schema.id)
          : [],
      );
      this.updateScrollExtent();
      this.updateSurfaceTransform();
      this.editingLocked = false;
      this.closeEditor(false);
      this.root.dataset.gridEditState = "idle";
      this.pendingInstall = null;
      pending.resolve(message.descriptor.installResult);
      if (hadSelection) {
        this.notifyHost(() =>
          this.options.onSelectionChange?.({ selection: null, source: "data" }),
        );
      }
      this.notifyHost(() => this.options.onViewChange?.(this.viewState));
      callbackSource = "data";
    } else if (message.publicationKind === "view") {
      const pending = this.pendingView;
      if (
        !pending ||
        surface.runtime.target.kind !== "view" ||
        pending.requestId !== surface.runtime.target.requestId
      ) {
        this.handleRuntimeFailure(
          new Error("The Grid runtime published an unknown view."),
          surface,
        );
        return;
      }
      const hadSelection = this.selection !== null;
      this.focusedRowIndex = surface.focusedRowIndex;
      this.focusedColumnIndex = surface.focusedColumnIndex;
      const focusedRowId = this.visibleRowIds.get(this.focusedRowIndex);
      this.focusedCell =
        focusedRowId === undefined || this.focusedColumnIndex < 0
          ? null
          : {
              rowId: focusedRowId,
              columnId: this.columnIdAt(this.focusedColumnIndex),
            };
      this.selection = null;
      this.selectionAnchorRowIndex = -1;
      this.selectionAnchorColumnIndex = -1;
      this.viewState = {
        status: "ready",
        requestId: pending.requestId,
        viewRevision: message.viewRevision,
        spec: message.spec,
        rowCount: message.rowCount,
        durationMs: pending.buildDurationMs ?? undefined,
      };
      this.publishedViewRevision = message.viewRevision;
      this.publishedViewSpec = message.spec;
      this.updateScrollExtent();
      this.scrollport.scrollTop = logicalToPhysicalScroll(
        surface.viewport.scrollTop,
        this.scrollGeometry(),
      );
      this.updateSurfaceTransform();
      this.pendingView = null;
      pending.resolve({ status: "applied", state: this.viewState });
      if (hadSelection) {
        this.notifyHost(() =>
          this.options.onSelectionChange?.({ selection: null, source: "view" }),
        );
      }
      this.notifyHost(() => this.options.onViewChange?.(this.viewState));
      callbackSource = "view";
    } else if (message.publicationKind === "edit") {
      const candidate = this.pendingEditCandidate;
      const operation = this.outstandingEdit;
      const editor = this.activeEditor;
      if (
        !candidate ||
        !operation ||
        surface.runtime.target.kind !== "edit" ||
        candidate.operationId !== surface.runtime.target.operationId ||
        operation.operationId !== candidate.operationId
      ) {
        this.handleRuntimeFailure(
          new Error("The Grid runtime published an unknown edit."),
          surface,
        );
        return;
      }
      const hadSelection = this.selection !== null;
      this.dataset = message.descriptor;
      this.dataRevision = message.descriptor.dataRevision;
      this.focusedRowIndex = surface.focusedRowIndex;
      this.focusedColumnIndex = surface.focusedColumnIndex;
      const focusedRowId = this.visibleRowIds.get(this.focusedRowIndex);
      this.focusedCell =
        focusedRowId === undefined || this.focusedColumnIndex < 0
          ? null
          : {
              rowId: focusedRowId,
              columnId: this.columnIdAt(this.focusedColumnIndex),
            };
      this.selection = null;
      this.selectionAnchorRowIndex = -1;
      this.selectionAnchorColumnIndex = -1;
      this.viewState = {
        status: "ready",
        requestId: this.viewState.requestId,
        viewRevision: message.viewRevision,
        spec: message.spec,
        rowCount: message.rowCount,
        durationMs: candidate.buildDurationMs,
      };
      this.publishedViewRevision = message.viewRevision;
      this.nextViewRevision = Math.max(this.nextViewRevision, message.viewRevision);
      this.publishedViewSpec = message.spec;
      this.lastViewBuildDurationMs = candidate.buildDurationMs;
      this.pendingEditCandidate = null;
      this.updateScrollExtent();
      this.scrollport.scrollTop = logicalToPhysicalScroll(
        surface.viewport.scrollTop,
        this.scrollGeometry(),
      );
      this.updateSurfaceTransform();
      if (hadSelection) {
        this.notifyHost(() =>
          this.options.onSelectionChange?.({ selection: null, source: "view" }),
        );
      }
      if (candidate.viewChanged) {
        this.notifyHost(() => this.options.onViewChange?.(this.viewState));
      }
      this.completeEdit(operation, "accepted", { publishedDataRevision: this.dataRevision });
      if (editor) this.finishEditorExit(editor, true);
      else this.closeEditor(false);
      this.root.dataset.gridEditState = "idle";
      callbackSource = candidate.viewChanged ? "view" : "data";
    }

    this.updateSummaryBuildDiagnostics(message.summary, message.publicationKind);
    this.publishedPresentationRevision = surface.runtime.frame.revision.presentationRevision;
    // A bounded surface failure is recoverable: a later resize/scroll may
    // produce a valid frame. Clear the public presentation error only after
    // that replacement completes the full paint/runtime publication lease.
    this.paintError = null;
    this.supersedeStaleSummaryQueries();

    this.notifyHost(() =>
      this.options.onViewportChange?.({ viewport: surface.viewport, source: callbackSource }),
    );
    this.emitDiagnostics();
    if (surface.telemetry) {
      const publicationCompleteAtMs = performance.now();
      const latestIntentAtPublication = this.latestSurfaceIntent;
      const latestIntentId = latestIntentAtPublication?.intentId ?? surface.telemetry.intentId;
      const latestIntentAtMs =
        latestIntentAtPublication?.observedAtMs ?? surface.telemetry.intentAtMs;
      this.emitSurfaceTelemetry({
        type: "published",
        ...this.surfaceTelemetryBase(surface.telemetry, publicationCompleteAtMs),
        runtimeAckAtMs,
        latestIntentId,
        latestIntentLagMs: Math.max(0, publicationCompleteAtMs - latestIntentAtMs),
      });
    }
    // Canvas presentation authorizes the candidate, but the publication is
    // not complete until the canonical runtime has promoted and acknowledged
    // the same surface. Keep newer data/view operations behind that complete
    // transaction so they cannot supersede a candidate between `presented`
    // and `published`.
    this.settlePaintCommitLease();
    this.scheduleLatestSurface();
  }

  private updateSurfaceTransform(): void {
    const transform = `translate(${this.scrollport.scrollLeft}px, ${this.scrollport.scrollTop}px)`;
    this.canvas.style.transform = transform;
    this.semantics.element.style.transform = transform;
  }

  private scheduleLatestSurface(): void {
    const source = this.pendingViewportSource;
    this.pendingViewportSource = null;
    if (source) {
      this.scheduleRender(source, false);
      return;
    }

    // A runtime-host/coalesced drop restores the exact correlated intent. It
    // still needs a new surface transaction even when no newer viewport event
    // arrived while the prior active surface was in flight.
    if (this.pendingSurfaceIntent) {
      this.scheduleRender(this.pendingSurfaceIntent.source, false);
      return;
    }

    // A paint/runtime drop leaves the private candidate available for a fresh
    // bounded handoff. A successful publication clears its candidate first, so
    // it must quiesce instead of starting an endless active-surface loop.
    if (this.pendingEditCandidate) {
      this.scheduleRender(this.pendingEditCandidate.viewChanged ? "view" : "data", false);
    } else if (this.pendingInstall?.descriptor) {
      this.scheduleRender("data", false);
    } else if (this.pendingView && this.pendingView.rowCount !== null) {
      this.scheduleRender("view", false);
    }
  }

  private handleRuntimeOperationError(
    message: Extract<GridRuntimeOutputMessage, { type: "runtimeError" }>,
  ): void {
    const error = new Error(message.message);
    if (message.operation === "resolve" && message.queryId !== undefined) {
      const query = this.rowQueries.get(message.queryId);
      this.rowQueries.delete(message.queryId);
      if (query) query.reject(error);
      const inspection = this.cellInspectionQueries.get(message.queryId);
      this.cellInspectionQueries.delete(message.queryId);
      inspection?.reject(error);
      return;
    }
    if (message.operation === "summary" && message.queryId !== undefined) {
      const query = this.summaryQueries.get(message.queryId);
      if (!query) return;
      const snapshotIsPublished = this.summarySnapshotIsPublished(query);
      this.deleteSummaryQuery(query);
      if (snapshotIsPublished) query.reject(error);
      else query.resolve({ status: "superseded", requestId: query.requestId });
      return;
    }
    if (message.operation === "edit" && message.operationId) {
      const parse = this.editParseQueries.get(message.operationId);
      if (parse) {
        this.editParseQueries.delete(message.operationId);
        parse.reject(error);
        return;
      }
      const lease = this.editLeaseQueries.get(message.operationId);
      if (lease) {
        this.editLeaseQueries.delete(message.operationId);
        lease.resolve({
          granted: false,
          reason: "invalid-normalization",
          message: error.message,
        });
        return;
      }
      const operation = this.outstandingEdit;
      if (operation?.operationId === message.operationId) {
        if (operation.phase === "pending" || operation.phase === "reserving") {
          this.completeEdit(operation, "host-error", { message: error.message });
          if (this.activeEditor) this.resetEditorExitIntent(this.activeEditor);
          this.activeEditor?.overlay.setError(error.message);
        } else {
          this.requireEditReconciliation(operation, "apply-failed", error.message);
        }
      }
      return;
    }
    if (message.operation === "install" && message.requestId !== undefined) {
      const pending = this.pendingInstall;
      if (pending?.requestId === message.requestId) {
        this.pendingInstall = null;
        pending.reject(error);
      }
      return;
    }
    if (message.operation === "view" && message.requestId !== undefined) {
      this.failView(message.requestId, error);
      return;
    }
    if (message.operation === "surface") {
      const current = this.runtimeSurfaceInFlight;
      const surfaceId = current
        ? "runtime" in current
          ? current.runtime.surfaceId
          : current.surfaceId
        : null;
      if (message.requestId !== undefined && message.requestId !== surfaceId) return;
      const target = current
        ? "runtime" in current
          ? current.runtime.target
          : current.target
        : null;
      this.emitSurfaceDropped(current, "runtime-failure");
      this.runtimeSurfaceInFlight = null;
      this.paintInFlight = null;
      this.awaitingRuntimePublication = null;
      this.settlePaintCommitLease();
      this.failPendingOperationForSurface(current, error);
      if (target?.kind === "active") {
        this.paintError = error.message;
        this.emitDiagnostics();
      }
      this.scheduleLatestSurface();
      return;
    }
    this.handleRuntimeFailure(error);
  }

  private handleRuntimeFailure(
    reason: unknown,
    failedSurface?: RequestedSurface | PendingSurface,
  ): void {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const surface =
      failedSurface ??
      this.runtimeSurfaceInFlight ??
      this.paintInFlight ??
      this.awaitingRuntimePublication;
    this.emitSurfaceDropped(surface, "runtime-failure");
    this.runtimeSurfaceInFlight = null;
    this.paintInFlight = null;
    this.awaitingRuntimePublication = null;
    this.runtimeInitializationError = error;
    this.paintError = error.message;
    this.runtimeReadyReject?.(error);
    this.runtimeReadyResolve = null;
    this.runtimeReadyReject = null;
    this.runtimeTransport?.terminate();
    this.runtimeTransport = null;
    this.settlePaintCommitLease();
    const edit = this.outstandingEdit;
    if (edit?.phase === "pending" || edit?.phase === "reserving") {
      edit.abortController.abort("runtime-failed");
      this.completeEdit(edit, "host-error", { message: error.message });
      this.activeEditor?.overlay.setError(error.message);
    } else if (edit?.phase === "committing" || edit?.phase === "applying") {
      this.requireEditReconciliation(edit, "apply-failed", error.message);
    }
    if (this.pendingInstall) {
      const pending = this.pendingInstall;
      this.pendingInstall = null;
      pending.reject(error);
    }
    if (this.pendingView) this.failView(this.pendingView.requestId, error);
    for (const query of this.rowQueries.values()) query.reject(error);
    this.rowQueries.clear();
    for (const query of this.cellInspectionQueries.values()) query.reject(error);
    this.cellInspectionQueries.clear();
    for (const query of this.summaryQueries.values()) {
      this.removeSummaryAbortListener(query);
      query.reject(error);
    }
    this.summaryQueries.clear();
    for (const query of this.editParseQueries.values()) query.reject(error);
    this.editParseQueries.clear();
    for (const query of this.editLeaseQueries.values()) query.reject(error);
    this.editLeaseQueries.clear();
    this.emitDiagnostics();
  }

  private failPendingOperationForSurface(
    surface: RequestedSurface | PendingSurface | null,
    error: Error,
  ): void {
    const target = surface
      ? "runtime" in surface
        ? surface.runtime.target
        : surface.target
      : null;
    if (target?.kind === "install" && this.pendingInstall?.requestId === target.requestId) {
      const pending = this.pendingInstall;
      this.pendingInstall = null;
      try {
        this.runtimeTransport?.postMessage({
          type: "cancel",
          scope: "install",
          requestId: target.requestId,
        });
      } catch {
        // The public failure is authoritative even if candidate cleanup fails.
      }
      pending.reject(error);
    } else if (target?.kind === "view") {
      try {
        this.runtimeTransport?.postMessage({
          type: "cancel",
          scope: "view",
          requestId: target.requestId,
        });
      } catch {
        // The public failure is authoritative even if candidate cleanup fails.
      }
      this.failView(target.requestId, error);
    } else if (target?.kind === "edit") {
      const operation = this.outstandingEdit;
      if (operation?.operationId === target.operationId) {
        this.requireEditReconciliation(operation, "apply-failed", error.message);
      }
    }
  }

  private failView(requestId: number, error: Error): void {
    const pending = this.pendingView;
    if (!pending || pending.requestId !== requestId) return;
    this.pendingView = null;
    this.viewState = {
      status: "failed",
      requestId,
      viewRevision: pending.viewRevision,
      spec: pending.spec,
      rowCount: this.viewState.rowCount,
      error: error.message,
    };
    pending.reject(error);
    this.notifyHost(() => this.options.onViewChange?.(this.viewState));
    this.emitDiagnostics();
  }

  private supersedePendingView(restoreSurface = true): void {
    const pending = this.pendingView;
    if (!pending) return;
    this.pendingView = null;
    try {
      this.runtimeTransport?.postMessage({
        type: "cancel",
        scope: "view",
        requestId: pending.requestId,
      });
    } catch {
      // The superseded public result is still deterministic.
    }
    pending.resolve({ status: "superseded", requestId: pending.requestId });
    if (restoreSurface) this.scheduleRender("view");
  }

  private finishSummaryQuery(
    message: Extract<GridRuntimeOutputMessage, { type: "summaryReady" }>,
  ): void {
    const query = this.summaryQueries.get(message.queryId);
    if (!query) return;
    try {
      assertSummaryReplyIdentity(query, message);
      if (!this.summarySnapshotIsPublished(query)) {
        this.deleteSummaryQuery(query);
        query.resolve({ status: "superseded", requestId: query.requestId });
        return;
      }
      const bandCount = message.bandCount;
      assertSummaryResultArray(message.ranges, bandCount * 2, "ranges");
      assertSummaryResultArray(message.rowCounts, bandCount, "rowCounts");
      assertSummaryResultArray(message.nullCounts, bandCount, "nullCounts");
      assertSummaryQueryInstrumentation(message);

      const base = {
        status: "applied" as const,
        requestId: query.requestId,
        datasetId: query.datasetId,
        dataRevision: query.dataRevision,
        viewRevision: query.viewRevision,
        presentationRevision: query.presentationRevision,
        columnId: query.columnId,
        start: query.start,
        end: query.end,
        rowCount: query.end - query.start,
        exact: true as const,
        queryStats: {
          durationMs: message.queryDurationMs,
          nodeVisits: message.nodeVisits,
          rawRowsScanned: message.rawRowsScanned,
          summaryVertices: message.summaryVertices,
          typedPayloadBytes: message.typedPayloadBytes,
        },
      };
      if (message.kind === "numeric") {
        assertSummaryResultArray(message.finiteCounts, bandCount, "finiteCounts");
        assertSummaryResultArray(message.nanCounts, bandCount, "nanCounts");
        assertSummaryResultArray(
          message.positiveInfinityCounts,
          bandCount,
          "positiveInfinityCounts",
        );
        assertSummaryResultArray(
          message.negativeInfinityCounts,
          bandCount,
          "negativeInfinityCounts",
        );
        assertSummaryResultArray(message.finiteMinimumValues, bandCount, "finiteMinimumValues");
        assertSummaryResultArray(message.finiteMaximumValues, bandCount, "finiteMaximumValues");
        assertSummaryResultArray(
          message.finiteMinimumViewOrdinals,
          bandCount,
          "finiteMinimumViewOrdinals",
        );
        assertSummaryResultArray(
          message.finiteMaximumViewOrdinals,
          bandCount,
          "finiteMaximumViewOrdinals",
        );
        assertSummaryResultArray(message.finiteMinimumRowIds, bandCount, "finiteMinimumRowIds");
        assertSummaryResultArray(message.finiteMaximumRowIds, bandCount, "finiteMaximumRowIds");
        const bands: GridNumericSummaryBand[] = [];
        let summaryVertices = 0;
        for (let band = 0; band < bandCount; band++) {
          const start = message.ranges[band * 2]!;
          const end = message.ranges[band * 2 + 1]!;
          const rowCount = message.rowCounts[band]!;
          assertSummaryBandEnvelope(query, band, start, end, rowCount);
          const nullCount = message.nullCounts[band]!;
          const finiteCount = message.finiteCounts[band]!;
          const nanCount = message.nanCounts[band]!;
          const positiveInfinityCount = message.positiveInfinityCounts[band]!;
          const negativeInfinityCount = message.negativeInfinityCounts[band]!;
          if (
            nullCount + finiteCount + nanCount + positiveInfinityCount + negativeInfinityCount !==
            rowCount
          ) {
            throw new Error("The Grid runtime returned inconsistent numeric summary counts.");
          }
          const finiteMinimum = summaryNumericExemplar(
            message.finiteMinimumValues[band]!,
            message.finiteMinimumViewOrdinals[band]!,
            message.finiteMinimumRowIds[band]!,
            start,
            end,
            "minimum",
          );
          const finiteMaximum = summaryNumericExemplar(
            message.finiteMaximumValues[band]!,
            message.finiteMaximumViewOrdinals[band]!,
            message.finiteMaximumRowIds[band]!,
            start,
            end,
            "maximum",
          );
          if ((finiteCount === 0) !== (finiteMinimum === null && finiteMaximum === null)) {
            throw new Error("The Grid runtime returned inconsistent numeric summary extrema.");
          }
          summaryVertices += (finiteMinimum ? 1 : 0) + (finiteMaximum ? 1 : 0);
          bands.push({
            kind: "numeric",
            start,
            end,
            rowCount,
            exact: true,
            nullCount,
            finiteCount,
            nanCount,
            positiveInfinityCount,
            negativeInfinityCount,
            finiteMinimum,
            finiteMaximum,
          });
        }
        if (summaryVertices !== message.summaryVertices) {
          throw new Error("The Grid runtime returned inconsistent numeric summary vertices.");
        }
        this.recordSummaryQueryDiagnostics(message);
        this.deleteSummaryQuery(query);
        query.resolve({ ...base, kind: "numeric", bands });
        return;
      }

      assertSummaryResultArray(message.exemplarCounts, bandCount, "exemplarCounts");
      assertSummaryResultArray(message.exemplarCodes, bandCount * 4, "exemplarCodes");
      assertSummaryResultArray(message.exemplarViewOrdinals, bandCount * 4, "exemplarViewOrdinals");
      assertSummaryResultArray(message.exemplarRowIds, bandCount * 4, "exemplarRowIds");
      assertSummaryResultArray(message.exemplarLabelIndexes, bandCount * 4, "exemplarLabelIndexes");
      assertSummaryResultArray(message.complete, bandCount, "complete");
      if (new Set(message.labels).size !== message.labels.length) {
        throw new Error("The Grid runtime returned duplicate category summary labels.");
      }
      const bands: GridCategorySummaryBand[] = [];
      let summaryVertices = 0;
      for (let band = 0; band < bandCount; band++) {
        const start = message.ranges[band * 2]!;
        const end = message.ranges[band * 2 + 1]!;
        const rowCount = message.rowCounts[band]!;
        assertSummaryBandEnvelope(query, band, start, end, rowCount);
        const nullCount = message.nullCounts[band]!;
        const exemplarCount = message.exemplarCounts[band]!;
        const complete = message.complete[band]!;
        if (nullCount > rowCount || exemplarCount > 4 || (complete !== 0 && complete !== 1)) {
          throw new Error("The Grid runtime returned an invalid category summary.");
        }
        if (complete === 0 && exemplarCount !== 4) {
          throw new Error("An incomplete Grid category summary must expose four exemplars.");
        }
        const exemplars = [];
        const seenCodes = new Set<number>();
        let previousOrdinal = -1;
        for (let exemplar = 0; exemplar < exemplarCount; exemplar++) {
          const offset = band * 4 + exemplar;
          const code = message.exemplarCodes[offset]!;
          const viewOrdinal = message.exemplarViewOrdinals[offset]!;
          const rowId = message.exemplarRowIds[offset]!;
          const labelIndex = message.exemplarLabelIndexes[offset]!;
          const label = message.labels[labelIndex];
          if (
            rowId === null ||
            label === undefined ||
            viewOrdinal < start ||
            viewOrdinal >= end ||
            viewOrdinal <= previousOrdinal ||
            seenCodes.has(code)
          ) {
            throw new Error("The Grid runtime returned invalid category exemplar evidence.");
          }
          seenCodes.add(code);
          previousOrdinal = viewOrdinal;
          exemplars.push({ code, label, viewOrdinal, rowId });
        }
        summaryVertices += exemplars.length;
        bands.push({
          kind: "category",
          start,
          end,
          rowCount,
          exact: true,
          nullCount,
          exemplars,
          complete: complete === 1,
        });
      }
      if (summaryVertices !== message.summaryVertices) {
        throw new Error("The Grid runtime returned inconsistent category summary vertices.");
      }
      this.recordSummaryQueryDiagnostics(message);
      this.deleteSummaryQuery(query);
      query.resolve({ ...base, kind: "category", bands });
    } catch (error) {
      this.deleteSummaryQuery(query);
      query.reject(error);
    }
  }

  private abortSummaryQuery(query: PendingSummaryBandsQuery): void {
    if (this.summaryQueries.get(query.requestId) !== query) return;
    this.deleteSummaryQuery(query);
    try {
      this.runtimeTransport?.postMessage({ type: "cancelSummary", queryId: query.requestId });
    } catch {
      // The host-side abort is authoritative even if cancellation delivery fails.
    }
    query.reject(createAbortError("The Grid summary query was aborted."));
  }

  private updateSummaryBuildDiagnostics(
    summary: Extract<GridRuntimeOutputMessage, { type: "published" }>["summary"],
    publicationKind: Extract<GridRuntimeOutputMessage, { type: "published" }>["publicationKind"],
  ): void {
    this.summaryBlockSize = summary.columnCount > 0 ? summary.blockSize : null;
    this.summaryConfiguredColumnCount = summary.columnCount;
    this.summaryRetainedBytes = summary.retainedBytes;
    this.summaryStagedReplacementPeakBytes = summary.stagedReplacementPeakBytes;
    this.lastSummaryBuildDurationMs = summary.columnCount > 0 ? summary.buildDurationMs : null;
    if (publicationKind !== "presentation") {
      this.lastSummaryQueryDurationMs = null;
      this.lastSummaryQueryBandCount = null;
      this.lastSummaryQueryNodeVisits = null;
      this.lastSummaryQueryRawRowsScanned = null;
      this.lastSummaryQueryVertices = null;
      this.lastSummaryQueryTypedPayloadBytes = null;
    }
  }

  private recordSummaryQueryDiagnostics(
    message: Extract<GridRuntimeOutputMessage, { type: "summaryReady" }>,
  ): void {
    this.lastSummaryQueryDurationMs = message.queryDurationMs;
    this.lastSummaryQueryBandCount = message.bandCount;
    this.lastSummaryQueryNodeVisits = message.nodeVisits;
    this.lastSummaryQueryRawRowsScanned = message.rawRowsScanned;
    this.lastSummaryQueryVertices = message.summaryVertices;
    this.lastSummaryQueryTypedPayloadBytes = message.typedPayloadBytes;
    this.emitDiagnostics();
  }

  private deleteSummaryQuery(query: PendingSummaryBandsQuery): void {
    if (this.summaryQueries.get(query.requestId) === query) {
      this.summaryQueries.delete(query.requestId);
    }
    this.removeSummaryAbortListener(query);
  }

  private removeSummaryAbortListener(query: PendingSummaryBandsQuery): void {
    if (query.signal && query.abortListener) {
      query.signal.removeEventListener("abort", query.abortListener);
      query.abortListener = undefined;
    }
  }

  private summarySnapshotIsPublished(query: PendingSummaryBandsQuery): boolean {
    return (
      this.dataset?.datasetId === query.datasetId &&
      this.dataRevision === query.dataRevision &&
      this.publishedViewRevision === query.viewRevision
    );
  }

  private supersedeStaleSummaryQueries(): void {
    for (const query of this.summaryQueries.values()) {
      if (this.summarySnapshotIsPublished(query)) continue;
      this.deleteSummaryQuery(query);
      try {
        this.runtimeTransport?.postMessage({ type: "cancelSummary", queryId: query.requestId });
      } catch {
        // Publication is authoritative even if stale query cleanup cannot be delivered.
      }
      query.resolve({ status: "superseded", requestId: query.requestId });
    }
  }

  private async resolveCell(cell: GridCellRef): Promise<ResolvedCell | null> {
    for (;;) {
      if (this.destroyed) return null;
      const dataset = this.dataset;
      const columnIndex = this.columnIndexOf(cell.columnId);
      if (!dataset || columnIndex < 0) return null;
      const viewRevision = this.publishedViewRevision;
      for (const [rowIndex, rowId] of this.visibleRowIds) {
        if (rowIdEquals(rowId, cell.rowId)) return { rowIndex, columnIndex, rowId };
      }
      const queryId = ++this.nextRowQueryId;
      const target = await new Promise<ResolvedCell | null>((resolve, reject) => {
        this.rowQueries.set(queryId, {
          datasetId: dataset.datasetId,
          resolve: (result) =>
            resolve(
              result ? { rowIndex: result.viewOrdinal, columnIndex, rowId: result.rowId } : null,
            ),
          reject,
        });
        try {
          this.requireRuntimeTransport().postMessage({
            type: "resolveRow",
            queryId,
            datasetId: dataset.datasetId,
            rowId: cell.rowId,
          });
        } catch (error) {
          this.rowQueries.delete(queryId);
          reject(error);
        }
      });
      if (this.destroyed || this.dataset?.datasetId !== dataset.datasetId) return null;
      // The worker may have answered immediately before a view publication.
      // Retry against the now-active permutation rather than using its stale
      // ordinal for programmatic focus or scrolling.
      if (this.publishedViewRevision !== viewRevision) continue;
      return target;
    }
  }

  private async resolveOrdinal(viewOrdinal: number): Promise<RowId | undefined> {
    for (;;) {
      if (this.destroyed) return undefined;
      const dataset = this.dataset;
      if (!dataset) return undefined;
      const viewRevision = this.publishedViewRevision;
      const queryId = ++this.nextRowQueryId;
      const rowId = await new Promise<RowId | undefined>((resolve, reject) => {
        this.rowQueries.set(queryId, {
          datasetId: dataset.datasetId,
          resolve: (result) => resolve(result?.rowId),
          reject,
        });
        try {
          this.requireRuntimeTransport().postMessage({
            type: "resolveOrdinal",
            queryId,
            datasetId: dataset.datasetId,
            viewOrdinal,
          });
        } catch (error) {
          this.rowQueries.delete(queryId);
          reject(error);
        }
      });
      if (this.destroyed || this.dataset?.datasetId !== dataset.datasetId) return undefined;
      if (this.publishedViewRevision !== viewRevision) continue;
      return rowId;
    }
  }

  private async openEditor(rowIndex: number, columnIndex: number, rowId: RowId): Promise<boolean> {
    if (
      !this.options.editing ||
      this.editingLocked ||
      this.activeEditor ||
      this.outstandingEdit ||
      this.pendingEditCandidate ||
      this.pendingInstall ||
      rowIndex < 0 ||
      columnIndex < 0 ||
      rowIndex >= this.viewState.rowCount ||
      columnIndex >= this.columnCount() ||
      !this.dataset
    ) {
      return false;
    }
    const requestedDatasetId = this.dataset.datasetId;
    const requestedColumnId = this.columnIdAt(columnIndex);
    const startingViewRevision = this.publishedViewRevision;
    if (!(await this.waitForPendingView(requestedDatasetId))) return false;
    if (this.publishedViewRevision !== startingViewRevision) {
      const resolved = await this.resolveCell({ rowId, columnId: requestedColumnId });
      if (!resolved) return false;
      rowIndex = resolved.rowIndex;
      columnIndex = resolved.columnIndex;
      this.moveFocusResolved(resolved, false, "keyboard", true);
    }
    const requestedViewRevision = this.publishedViewRevision;
    if (!(await this.waitForEditorSurface(requestedDatasetId, requestedViewRevision))) return false;
    const descriptor = this.dataset.columns[columnIndex];
    if (
      !descriptor ||
      descriptor.schema.editable !== true ||
      descriptor.schema.kind === "timestamp" ||
      descriptor.schema.kind === "id"
    ) {
      return false;
    }
    let inspection: CellInspection | null;
    try {
      inspection = await this.inspectCell(rowId, descriptor.schema.id);
    } catch {
      return false;
    }
    if (
      !inspection ||
      this.destroyed ||
      this.activeEditor ||
      this.outstandingEdit ||
      this.dataset?.datasetId !== inspection.datasetId ||
      this.pendingInstall ||
      this.pendingView ||
      this.visibleRowIds.get(rowIndex) === undefined ||
      !rowIdEquals(this.visibleRowIds.get(rowIndex)!, rowId)
    ) {
      return false;
    }
    if (!(await this.waitForEditorSurface(requestedDatasetId, requestedViewRevision))) return false;
    const schema = inspection.descriptor.schema;
    const overlay = new GridEditorOverlay({
      container: this.editorLayer,
      columnId: schema.id,
      ...(schema.edit?.label ? { accessibleLabel: schema.edit.label } : {}),
      ...(schema.edit?.nullLabel ? { nullLabel: schema.edit.nullLabel } : {}),
      ...(schema.edit?.trueLabel ? { trueLabel: schema.edit.trueLabel } : {}),
      ...(schema.edit?.falseLabel ? { falseLabel: schema.edit.falseLabel } : {}),
      rowNumber: rowIndex + 1,
      kind: schema.kind,
      nullable: schema.nullable === true,
      initialValue: inspection.value,
      ...(inspection.categoryValues ? { categoryValues: inspection.categoryValues } : {}),
      onCommit: (raw, navigation) => void this.submitEditor(raw, navigation, { kind: "grid" }),
      onCancel: () => this.cancelEdit(),
    });
    this.activeEditor = {
      overlay,
      rowId,
      columnId: schema.id,
      rowIndex,
      columnIndex,
      cellRevision: inspection.cellRevision,
      previousValue: inspection.value,
      navigation: "stay",
      exitTarget: { kind: "grid" },
    };
    this.root.dataset.gridEditState = "editing";
    this.positionActiveEditor();
    overlay.focus();
    return true;
  }

  private async waitForPendingView(datasetId: string): Promise<boolean> {
    while (!this.destroyed && this.pendingView) {
      if (this.pendingInstall || this.dataset?.datasetId !== datasetId || this.editingLocked) {
        return false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    return !this.destroyed && !this.pendingInstall && this.dataset?.datasetId === datasetId;
  }

  /**
   * Keyboard navigation may have a bounded replacement frame in flight when
   * Enter/F2 arrives. Preserve that edit intent until the matching Canvas and
   * semantic surface settles instead of dropping the keystroke.
   */
  private async waitForEditorSurface(datasetId: string, viewRevision: number): Promise<boolean> {
    const deadline = performance.now() + 2_000;
    while (!this.destroyed && performance.now() < deadline) {
      if (
        this.dataset?.datasetId !== datasetId ||
        this.publishedViewRevision !== viewRevision ||
        this.pendingInstall ||
        this.pendingView ||
        this.editingLocked ||
        this.paintError
      ) {
        return false;
      }
      if (
        this.interactiveColumnLayout() &&
        this.frame === 0 &&
        this.pendingViewportSource === null
      ) {
        return true;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return false;
  }

  private inspectCell(rowId: RowId, columnId: string): Promise<CellInspection | null> {
    const dataset = this.dataset;
    if (!dataset) return Promise.resolve(null);
    const queryId = ++this.nextRowQueryId;
    return new Promise<CellInspection | null>((resolve, reject) => {
      this.cellInspectionQueries.set(queryId, { datasetId: dataset.datasetId, resolve, reject });
      try {
        this.requireRuntimeTransport().postMessage({
          type: "inspectCell",
          queryId,
          datasetId: dataset.datasetId,
          rowId,
          columnId,
        });
      } catch (error) {
        this.cellInspectionQueries.delete(queryId);
        reject(error);
      }
    });
  }

  private positionActiveEditor(): void {
    const editor = this.activeEditor;
    if (!editor) return;
    const layout = this.publishedColumnLayout();
    const left =
      this.rowNumberWidth + (layout.offsets[editor.columnIndex] ?? 0) - this.scrollport.scrollLeft;
    const top =
      this.layout.headerHeight + editor.rowIndex * this.layout.rowHeight - this.logicalScrollTop();
    editor.overlay.position({
      left,
      top,
      width: layout.widths[editor.columnIndex] ?? this.layout.columnWidth,
      height: this.layout.rowHeight,
    });
  }

  private closeEditor(restoreFocus: boolean): void {
    const editor = this.activeEditor;
    if (!editor) return;
    editor.overlay.destroy();
    this.activeEditor = null;
    if (!this.outstandingEdit && !this.editingLocked) this.root.dataset.gridEditState = "idle";
    if (restoreFocus && !this.destroyed) this.semantics.element.focus({ preventScroll: true });
  }

  private resetEditorExitIntent(editor: ActiveGridEditor): void {
    editor.navigation = "stay";
    editor.exitTarget = { kind: "grid" };
  }

  private finishEditorExit(editor: ActiveGridEditor, publicationAlreadyFocused: boolean): void {
    const exitTarget = editor.exitTarget;
    const navigation = editor.navigation;
    this.closeEditor(false);
    if (this.destroyed || exitTarget.kind === "external") return;

    this.semantics.element.focus({ preventScroll: true });
    if (publicationAlreadyFocused && exitTarget.kind === "grid") return;

    const target =
      exitTarget.kind === "cell"
        ? { rowId: exitTarget.rowId, columnId: exitTarget.columnId }
        : {
            rowId: editor.rowId,
            columnId: this.columnIdAt(this.editNavigationColumn(editor.columnIndex, navigation)),
          };
    void this.focusCell(target, { scrollIntoView: true }).catch(() => undefined);
  }

  private async submitEditor(
    raw: GridEditorRawValue,
    navigation: GridEditorNavigation,
    exitTarget: GridEditorExitTarget,
  ): Promise<void> {
    const editor = this.activeEditor;
    const editing = this.options.editing;
    if (!editor || !editing || this.outstandingEdit || this.editingLocked || !this.dataset) return;
    const operationId = `sixtyfold:grid:edit:${(++this.nextEditOperationId).toString(36)}`;
    editor.navigation = navigation;
    editor.exitTarget = exitTarget;
    this.pendingParseOperationId = operationId;
    editor.overlay.clearError();
    editor.overlay.setStatus("pending", "Validating value");
    let proposedValue: CellScalar | null;
    try {
      proposedValue = await this.parseEdit(operationId, editor, raw);
    } catch (error) {
      if (this.pendingParseOperationId !== operationId || this.activeEditor !== editor) return;
      this.pendingParseOperationId = null;
      this.resetEditorExitIntent(editor);
      editor.overlay.setError(error instanceof Error ? error.message : String(error));
      this.root.dataset.gridEditState = "validation-error";
      return;
    }
    if (
      this.pendingParseOperationId !== operationId ||
      this.activeEditor !== editor ||
      this.destroyed
    ) {
      return;
    }
    this.pendingParseOperationId = null;
    if (cellScalarEquals(proposedValue, editor.previousValue)) {
      this.finishEditorExit(editor, false);
      return;
    }
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const operation: OutstandingGridEdit = {
      operationId,
      datasetId: this.dataset.datasetId,
      rowId: editor.rowId,
      columnId: editor.columnId,
      cellRevision: editor.cellRevision,
      previousValue: editor.previousValue,
      proposedValue,
      startedDataRevision: this.dataRevision,
      startedViewRevision: this.publishedViewRevision,
      abortController: new AbortController(),
      settled,
      settle,
      phase: "pending",
    };
    this.outstandingEdit = operation;
    this.root.dataset.gridEditState = "pending";
    editor.overlay.setStatus("pending", "Waiting for host validation");
    const request: EditRequest = {
      operationId,
      datasetId: operation.datasetId,
      rowId: operation.rowId,
      columnId: operation.columnId,
      cellRevision: operation.cellRevision,
      previousValue: operation.previousValue,
      proposedValue,
      dataRevision: operation.startedDataRevision,
      viewRevision: operation.startedViewRevision,
      signal: operation.abortController.signal,
      beginAuthoritativeCommit: (finalValue = proposedValue) =>
        this.beginAuthoritativeEditCommit(operation, finalValue),
    };
    let decision: EditDecision | Promise<EditDecision>;
    try {
      decision = editing.onEditRequest(request);
    } catch (error) {
      this.handleEditHostFailure(operation, error);
      return;
    }
    void Promise.resolve(decision).then(
      (result) => this.handleEditDecision(operation, result),
      (error) => this.handleEditHostFailure(operation, error),
    );
  }

  private parseEdit(
    operationId: string,
    editor: ActiveGridEditor,
    raw: GridEditorRawValue,
  ): Promise<CellScalar | null> {
    const datasetId = this.dataset?.datasetId;
    if (!datasetId) return Promise.reject(new Error("Grid data is no longer active."));
    return new Promise<CellScalar | null>((resolve, reject) => {
      this.editParseQueries.set(operationId, { resolve, reject });
      try {
        this.requireRuntimeTransport().postMessage({
          type: "parseEdit",
          operationId,
          datasetId,
          rowId: editor.rowId,
          columnId: editor.columnId,
          raw: raw.raw,
          explicitNull: raw.explicitNull,
        });
      } catch (error) {
        this.editParseQueries.delete(operationId);
        reject(error);
      }
    });
  }

  private async beginAuthoritativeEditCommit(
    operation: OutstandingGridEdit,
    finalValue: CellScalar | null,
  ): Promise<EditCommitLeaseResult> {
    if (
      this.outstandingEdit !== operation ||
      operation.phase !== "pending" ||
      operation.abortController.signal.aborted
    ) {
      return { granted: false, reason: "cancelled" };
    }
    operation.phase = "reserving";
    operation.finalValue = finalValue;
    this.activeEditor?.overlay.setStatus("pending", "Reserving authoritative commit");
    return new Promise<EditCommitLeaseResult>((resolve, reject) => {
      this.editLeaseQueries.set(operation.operationId, { resolve, reject });
      try {
        this.requireRuntimeTransport().postMessage({
          type: "reserveEdit",
          operationId: operation.operationId,
          datasetId: operation.datasetId,
          rowId: operation.rowId,
          columnId: operation.columnId,
          cellRevision: operation.cellRevision,
          previousValue: operation.previousValue,
          finalValue,
        });
      } catch (error) {
        this.editLeaseQueries.delete(operation.operationId);
        operation.phase = "pending";
        reject(error);
      }
    });
  }

  private handleEditDecision(operation: OutstandingGridEdit, decision: EditDecision): void {
    if (this.outstandingEdit !== operation) return;
    if (operation.phase === "pending" || operation.phase === "reserving") {
      if (decision?.outcome === "rejected") {
        this.completeEdit(operation, "rejected", {
          code: decision.code,
          message: decision.message,
        });
        if (this.activeEditor) this.resetEditorExitIntent(this.activeEditor);
        this.activeEditor?.overlay.setError(decision.message);
      } else {
        const message = "The edit host accepted without acquiring a commit lease.";
        this.completeEdit(operation, "host-error", { message });
        if (this.activeEditor) this.resetEditorExitIntent(this.activeEditor);
        this.activeEditor?.overlay.setError(message);
      }
      return;
    }
    if (operation.phase !== "committing") return;
    if (decision?.outcome !== "accepted" || decision.leaseId !== operation.leaseId) {
      this.requireEditReconciliation(
        operation,
        "host-outcome-unknown",
        "The edit host did not return acceptance for the granted commit lease.",
      );
      return;
    }
    if (operation.timeoutId) clearTimeout(operation.timeoutId);
    operation.timeoutId = undefined;
    operation.phase = "applying";
    this.root.dataset.gridEditState = "applying";
    this.activeEditor?.overlay.setStatus("applying", "Applying committed value");
    try {
      this.requireRuntimeTransport().postMessage({
        type: "applyEdit",
        operationId: operation.operationId,
        leaseId: operation.leaseId!,
      });
    } catch (error) {
      this.requireEditReconciliation(
        operation,
        "apply-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private handleEditHostFailure(operation: OutstandingGridEdit, reason: unknown): void {
    if (this.outstandingEdit !== operation) return;
    const message = reason instanceof Error ? reason.message : String(reason);
    if (operation.phase === "pending" || operation.phase === "reserving") {
      this.completeEdit(operation, "host-error", { message });
      if (this.activeEditor) this.resetEditorExitIntent(this.activeEditor);
      this.activeEditor?.overlay.setError(message);
      return;
    }
    this.requireEditReconciliation(operation, "host-outcome-unknown", message);
  }

  private completeEdit(
    operation: OutstandingGridEdit,
    outcome: EditCompletionOutcome,
    details: { code?: string; message?: string; publishedDataRevision?: number } = {},
  ): CompletedEditOperation {
    if (operation.timeoutId) clearTimeout(operation.timeoutId);
    if (this.outstandingEdit === operation) this.outstandingEdit = null;
    operation.settle();
    const completion: CompletedEditOperation = {
      operationId: operation.operationId,
      datasetId: operation.datasetId,
      rowId: operation.rowId,
      columnId: operation.columnId,
      previousValue: operation.previousValue,
      proposedValue: operation.proposedValue,
      ...(operation.leaseId === undefined ? {} : { finalValue: operation.finalValue! }),
      outcome,
      startedDataRevision: operation.startedDataRevision,
      ...(details.publishedDataRevision === undefined
        ? {}
        : { publishedDataRevision: details.publishedDataRevision }),
      ...(details.code === undefined ? {} : { code: details.code }),
      ...(details.message === undefined ? {} : { message: details.message }),
    };
    this.notifyHost(() => this.options.editing?.onEditComplete?.(completion));
    return completion;
  }

  private requireEditReconciliation(
    operation: OutstandingGridEdit,
    reason: EditReconcileRequired["reason"],
    message: string,
  ): void {
    if (this.outstandingEdit !== operation) return;
    try {
      this.runtimeTransport?.postMessage({
        type: "discardEdit",
        operationId: operation.operationId,
      });
    } catch {
      // Reconciliation is already mandatory; transport failure does not weaken it.
    }
    this.pendingEditCandidate = null;
    this.editingLocked = true;
    this.root.dataset.gridEditState = "reconcile-required";
    this.activeEditor?.overlay.setReconcileRequired(message);
    const completion = this.completeEdit(
      operation,
      reason === "apply-failed" ? "apply-failed" : reason,
      {
        message,
      },
    );
    this.root.dataset.gridEditState = "reconcile-required";
    this.notifyHost(() =>
      this.options.editing?.onReconcileRequired({
        operation: completion,
        reason,
        requiredAction: "replace-dataset-or-destroy",
      }),
    );
  }

  private recordSurfaceIntent(source: ViewportSource): void {
    if (!this.surfaceTelemetry || this.destroyed) return;
    const intent: SurfaceTelemetryIntent = {
      intentId: ++this.nextSurfaceIntentId,
      observedAtMs: performance.now(),
      source,
      scrollTop: this.scrollport.scrollTop,
      scrollLeft: this.scrollport.scrollLeft,
    };
    this.pendingSurfaceIntent = intent;
    this.latestSurfaceIntent = intent;
    this.emitSurfaceTelemetry({
      type: "intent",
      intentId: intent.intentId,
      observedAtMs: intent.observedAtMs,
      source: intent.source,
      scrollTop: intent.scrollTop,
      scrollLeft: intent.scrollLeft,
    });
  }

  private restoreSurfaceIntent(surface: RequestedSurface | PendingSurface): void {
    if (!this.surfaceTelemetry || this.pendingSurfaceIntent) return;
    const trace = surface.telemetry;
    if (!trace) return;
    this.pendingSurfaceIntent = {
      intentId: trace.intentId,
      observedAtMs: trace.intentAtMs,
      source: trace.source,
      scrollTop: trace.intentScrollTop,
      scrollLeft: trace.intentScrollLeft,
    };
  }

  private surfaceTelemetryBase(trace: SurfaceTelemetryTrace, observedAtMs: number) {
    return {
      surfaceId: trace.surfaceId,
      commitToken: trace.commitToken,
      intentId: trace.intentId,
      intentAtMs: trace.intentAtMs,
      observedAtMs,
      source: trace.source,
      targetKind: trace.targetKind,
      columnLayoutRevision: trace.columnLayoutRevision,
      viewportWidth: trace.viewportWidth,
      viewportHeight: trace.viewportHeight,
      pixelRatio: trace.pixelRatio,
      scrollTop: trace.scrollTop,
      scrollLeft: trace.scrollLeft,
      viewportRowStart: trace.viewportRowStart,
      viewportRowEnd: trace.viewportRowEnd,
      viewportColumnStart: trace.viewportColumnStart,
      viewportColumnEnd: trace.viewportColumnEnd,
      intentScrollTop: trace.intentScrollTop,
      intentScrollLeft: trace.intentScrollLeft,
    } as const;
  }

  private emitSurfaceDropped(
    surface: RequestedSurface | PendingSurface | null,
    reason: GridSurfaceTelemetryDropReason,
  ): void {
    const trace = surface?.telemetry;
    if (!trace || trace.dropped) return;
    trace.dropped = true;
    this.emitSurfaceTelemetry({
      type: "dropped",
      ...this.surfaceTelemetryBase(trace, performance.now()),
      reason,
    });
  }

  private emitSurfaceTelemetry(event: GridSurfaceTelemetryEvent): void {
    const sink = this.surfaceTelemetry;
    if (!sink) return;
    try {
      sink(event);
    } catch {
      // Private instrumentation must never participate in the Grid transaction.
    }
  }

  private emitDiagnostics(): void {
    this.notifyHost(() => this.options.onDiagnosticsChange?.(this.getDiagnostics()));
  }

  private notifyHost(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }

  private assertLive(): void {
    if (this.destroyed) throw new Error("Grid has been destroyed.");
  }

  private throwIfRuntimeFailed(): void {
    if (this.runtimeInitializationError) throw this.runtimeInitializationError;
  }

  private requireRuntimeTransport(): GridRuntimeTransport {
    this.throwIfRuntimeFailed();
    const runtime = this.runtimeTransport;
    if (!runtime) throw new Error("The Grid runtime transport is not available.");
    return runtime;
  }
}

function viewportSourcePriority(source: ViewportSource): number {
  switch (source) {
    case "data":
      return 5;
    case "view":
      return 4;
    case "api":
      return 3;
    case "resize":
      return 2;
    case "scroll":
      return 1;
  }
}

function snapshotViewSpec(spec: GridViewSpec): GridViewSpec {
  if (!spec || typeof spec !== "object") throw new TypeError("Grid view spec must be an object.");
  return deepFreeze(structuredClone(spec));
}

function snapshotSummaryColumnIds(columns: readonly string[] | undefined): readonly string[] {
  if (columns === undefined) return Object.freeze([]);
  if (!Array.isArray(columns)) {
    throw new TypeError("Grid summary columns must be an array.");
  }
  const snapshot = columns.map((columnId, index) => {
    if (typeof columnId !== "string" || columnId.length === 0) {
      throw new TypeError(`Grid summary columns[${index}] must be a non-empty string.`);
    }
    return columnId;
  });
  if (new Set(snapshot).size !== snapshot.length) {
    throw new RangeError("Grid summary columns must be unique.");
  }
  return Object.freeze(snapshot);
}

function snapshotSummaryBandsRequest(request: GridSummaryBandsRequest): GridSummaryBandsRequest {
  if (!request || typeof request !== "object") {
    throw new TypeError("Grid summary request must be an object.");
  }
  if (typeof request.columnId !== "string" || request.columnId.length === 0) {
    throw new TypeError("Grid summary columnId must be a non-empty string.");
  }
  if (
    !Number.isSafeInteger(request.bandCount) ||
    request.bandCount < 1 ||
    request.bandCount > MAX_GRID_SUMMARY_BANDS
  ) {
    throw new RangeError(
      `Grid summary bandCount must be an integer from 1 through ${MAX_GRID_SUMMARY_BANDS}.`,
    );
  }
  assertOptionalSummaryOrdinal(request.start, "start");
  assertOptionalSummaryOrdinal(request.end, "end");
  return Object.freeze({
    columnId: request.columnId,
    bandCount: request.bandCount,
    ...(request.start === undefined ? {} : { start: request.start }),
    ...(request.end === undefined ? {} : { end: request.end }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

function assertOptionalSummaryOrdinal(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0 || value > NO_GRID_SUMMARY_ORDINAL) {
    throw new RangeError(
      `Grid summary ${label} must be an integer from zero through ${NO_GRID_SUMMARY_ORDINAL}.`,
    );
  }
}

function assertSummaryRange(start: number, end: number, rowCount: number): void {
  assertOptionalSummaryOrdinal(start, "start");
  assertOptionalSummaryOrdinal(end, "end");
  if (start > end || end > rowCount) {
    throw new RangeError(
      `Grid summary range [${start}, ${end}) is outside the published view [0, ${rowCount}).`,
    );
  }
}

function summaryBandRanges(start: number, end: number, requestedBands: number): Uint32Array {
  const rowCount = end - start;
  if (rowCount === 0) return new Uint32Array(0);
  const bandCount = Math.min(rowCount, requestedBands);
  const ranges = new Uint32Array(bandCount * 2);
  for (let band = 0; band < bandCount; band++) {
    ranges[band * 2] = start + Math.floor((rowCount * band) / bandCount);
    ranges[band * 2 + 1] = start + Math.floor((rowCount * (band + 1)) / bandCount);
  }
  return ranges;
}

function assertSummaryReplyIdentity(
  query: PendingSummaryBandsQuery,
  message: Extract<GridRuntimeOutputMessage, { type: "summaryReady" }>,
): void {
  if (
    message.datasetId !== query.datasetId ||
    message.dataRevision !== query.dataRevision ||
    message.viewRevision !== query.viewRevision ||
    message.columnId !== query.columnId ||
    message.bandCount !== query.ranges.length / 2 ||
    message.ranges.length !== query.ranges.length
  ) {
    throw new Error("The Grid runtime returned a summary for the wrong published snapshot.");
  }
  for (let index = 0; index < query.ranges.length; index++) {
    if (message.ranges[index] !== query.ranges[index]) {
      throw new Error("The Grid runtime returned different summary ranges than requested.");
    }
  }
}

function assertSummaryResultArray(
  value: { readonly length: number },
  expectedLength: number,
  label: string,
): void {
  if (value.length !== expectedLength) {
    throw new Error(`The Grid runtime returned a misaligned summary ${label} array.`);
  }
}

function assertSummaryQueryInstrumentation(
  message: Extract<GridRuntimeOutputMessage, { type: "summaryReady" }>,
): void {
  if (!Number.isFinite(message.queryDurationMs) || message.queryDurationMs < 0) {
    throw new Error("The Grid runtime returned an invalid summary query duration.");
  }
  for (const [label, value] of [
    ["node visits", message.nodeVisits],
    ["raw rows scanned", message.rawRowsScanned],
    ["summary vertices", message.summaryVertices],
    ["typed payload bytes", message.typedPayloadBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`The Grid runtime returned invalid summary ${label}.`);
    }
  }
  const common = [message.ranges, message.rowCounts, message.nullCounts];
  const arrays =
    message.kind === "numeric"
      ? [
          ...common,
          message.finiteCounts,
          message.nanCounts,
          message.positiveInfinityCounts,
          message.negativeInfinityCounts,
          message.finiteMinimumValues,
          message.finiteMaximumValues,
          message.finiteMinimumViewOrdinals,
          message.finiteMaximumViewOrdinals,
        ]
      : [
          ...common,
          message.exemplarCounts,
          message.exemplarCodes,
          message.exemplarViewOrdinals,
          message.exemplarLabelIndexes,
          message.complete,
        ];
  const typedPayloadBytes = arrays.reduce((total, value) => total + value.byteLength, 0);
  if (message.typedPayloadBytes !== typedPayloadBytes) {
    throw new Error("The Grid runtime returned inconsistent summary typed payload bytes.");
  }
}

function assertSummaryBandEnvelope(
  query: PendingSummaryBandsQuery,
  band: number,
  start: number,
  end: number,
  rowCount: number,
): void {
  if (
    start !== query.ranges[band * 2] ||
    end !== query.ranges[band * 2 + 1] ||
    end <= start ||
    rowCount !== end - start
  ) {
    throw new Error("The Grid runtime returned an invalid summary band range.");
  }
}

function summaryNumericExemplar(
  value: number,
  viewOrdinal: number,
  rowId: RowId | null,
  start: number,
  end: number,
  label: "minimum" | "maximum",
): { readonly value: number; readonly viewOrdinal: number; readonly rowId: RowId } | null {
  if (viewOrdinal === NO_GRID_SUMMARY_ORDINAL) {
    if (rowId !== null) {
      throw new Error(`The Grid runtime returned a ${label} RowId without an ordinal.`);
    }
    return null;
  }
  if (rowId === null || viewOrdinal < start || viewOrdinal >= end || !Number.isFinite(value)) {
    throw new Error(`The Grid runtime returned invalid finite-${label} evidence.`);
  }
  return { value, viewOrdinal, rowId };
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function rowIdEquals(left: RowId, right: RowId): boolean {
  return (
    typeof left === typeof right &&
    (typeof left === "number" ? Object.is(left, right) : left === right)
  );
}

function cellScalarEquals(left: CellScalar | null, right: CellScalar | null): boolean {
  if (left === null || right === null) return left === right;
  if (typeof left === "number" && typeof right === "number") return Object.is(left, right);
  return left === right;
}

function createAbortError(message: string): Error {
  if (typeof DOMException === "function") return new DOMException(message, "AbortError");
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function editCommitTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_EDIT_COMMIT_TIMEOUT_MS;
  return Math.max(MIN_EDIT_COMMIT_TIMEOUT_MS, Math.min(MAX_EDIT_COMMIT_TIMEOUT_MS, value));
}
