import {
  GridDataStore,
  preflightGridDataAsync,
  type GridCellPatchBaseline,
  type GridColumnDescriptor,
  type GridStagedCellPatch,
} from "../data/store.js";
import { buildRawGridPaintFrame } from "../rendering/rawPaintFrame.js";
import { assertGridPaintFrame } from "../rendering/paintProtocol.js";
import type {
  GridPublishedSummaryHierarchy,
  GridSummaryView,
} from "../summary/summaryHierarchy.js";
import {
  buildGridViewCandidateAsync,
  createPublishedGridView,
  publishGridViewCandidate,
  type GridPublishedView,
} from "../view/activeView.js";
import type { CellScalar, GridDataInstallResult, GridViewSpec, RowId } from "../types.js";
import type {
  GridRuntimeDatasetDescriptor,
  GridRuntimeInputMessage,
  GridRuntimeOutputMessage,
  GridRuntimeQuerySummaryMessage,
  GridRuntimeSummaryReadyMessage,
  GridRuntimeSurfaceMessage,
  GridRuntimeSurfaceTarget,
} from "./runtimeProtocol.js";

const SUMMARY_BLOCK_SIZE = 256;
const MAX_SUMMARY_BANDS = 2_048;
const SUMMARY_QUERY_CHUNK_BANDS = 128;
const NO_SUMMARY_ORDINAL = 0xffff_ffff;
let summaryHierarchyModulePromise: Promise<typeof import("../summary/summaryHierarchy.js")> | null =
  null;
const runtimeSummaryBuildDurations = new WeakMap<GridPublishedSummaryHierarchy, number>();

interface RuntimeSnapshot {
  readonly store: GridDataStore;
  readonly descriptor: GridRuntimeDatasetDescriptor;
  readonly view: GridPublishedView | null;
  readonly viewRevision: number;
  readonly spec: GridViewSpec;
  readonly summaryColumnIds: readonly string[];
  readonly summary: GridPublishedSummaryHierarchy | null;
  readonly stagedPatch?: GridStagedCellPatch;
}

interface PendingInstall {
  readonly requestId: number;
  readonly snapshot: RuntimeSnapshot;
}

interface PendingView {
  readonly requestId: number;
  readonly snapshot: RuntimeSnapshot;
  readonly buildDurationMs: number;
}

interface PendingSurface {
  readonly message: GridRuntimeSurfaceMessage;
  readonly snapshot: RuntimeSnapshot;
}

interface EditReservation {
  readonly operationId: string;
  readonly leaseId: string;
  readonly baseline: GridCellPatchBaseline;
  readonly finalValue: CellScalar | null;
}

interface PendingEdit {
  readonly operationId: string;
  readonly leaseId: string;
  readonly stagedPatch: GridStagedCellPatch;
  readonly snapshot: RuntimeSnapshot;
  readonly buildDurationMs: number;
  readonly viewChanged: boolean;
}

interface PendingSummaryQuery {
  readonly message: GridRuntimeQuerySummaryMessage;
  readonly ranges: Uint32Array;
  readonly snapshot: RuntimeSnapshot;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface GridRuntimeEngineCallbacks {
  postMessage(message: GridRuntimeOutputMessage, transfer?: Transferable[]): void;
  close?(): void;
}

export interface GridRuntimeEngine {
  handleMessage(message: GridRuntimeInputMessage): void;
  dispose(): void;
}

/**
 * Canonical single-owner data/view/format runtime. Canvas painting deliberately
 * remains in the existing bounded paint transport during this migration.
 */
export function createGridRuntimeEngine(callbacks: GridRuntimeEngineCallbacks): GridRuntimeEngine {
  let active: RuntimeSnapshot | null = null;
  let pendingInstall: PendingInstall | null = null;
  let pendingView: PendingView | null = null;
  let editReservation: EditReservation | null = null;
  let pendingEdit: PendingEdit | null = null;
  let pendingSurface: PendingSurface | null = null;
  let queuedSurface: GridRuntimeSurfaceMessage | null = null;
  let installGeneration = 0;
  let viewGeneration = 0;
  let installAbort: AbortController | null = null;
  let installingRequestId: number | null = null;
  let buildingViewRequestId: number | null = null;
  let nextSummaryBuildRequestId = 0;
  const pendingSummaryQueries = new Map<number, PendingSummaryQuery>();
  let disposed = false;

  const send = (message: GridRuntimeOutputMessage, transfer: Transferable[] = []): void => {
    if (!disposed || message.type === "disposed") callbacks.postMessage(message, transfer);
  };

  const cancelInstall = (requestId?: number): void => {
    if (
      requestId !== undefined &&
      pendingInstall?.requestId !== requestId &&
      installingRequestId !== requestId
    ) {
      return;
    }
    installGeneration++;
    installAbort?.abort("superseded");
    installAbort = null;
    installingRequestId = null;
    if (pendingInstall && (requestId === undefined || pendingInstall.requestId === requestId)) {
      const cancelled = pendingInstall.requestId;
      pendingInstall = null;
      send({ type: "cancelled", scope: "install", requestId: cancelled });
    }
  };

  const cancelView = (requestId?: number): void => {
    if (
      requestId !== undefined &&
      pendingView?.requestId !== requestId &&
      buildingViewRequestId !== requestId
    ) {
      return;
    }
    viewGeneration++;
    buildingViewRequestId = null;
    if (pendingView && (requestId === undefined || pendingView.requestId === requestId)) {
      const cancelled = pendingView.requestId;
      pendingView = null;
      send({ type: "cancelled", scope: "view", requestId: cancelled });
    }
  };

  const fail = (
    operation: "install" | "view" | "surface" | "resolve" | "summary" | "edit" | "protocol",
    error: unknown,
    identity: { requestId?: number; queryId?: number; operationId?: string } = {},
  ): void => {
    send({
      type: "runtimeError",
      operation,
      ...identity,
      message: error instanceof Error ? error.message : String(error),
    });
  };

  const buildSummary = async (options: {
    readonly store: GridDataStore;
    readonly descriptor: GridRuntimeDatasetDescriptor;
    readonly view: GridPublishedView | null;
    readonly viewRevision: number;
    readonly summaryColumnIds: readonly string[];
    readonly stagedPatch?: GridStagedCellPatch;
    readonly previousRetainedBytes?: number;
    readonly shouldCancel: () => boolean;
  }): Promise<GridPublishedSummaryHierarchy | null> => {
    if (options.summaryColumnIds.length === 0) return null;
    const startedAt = performance.now();
    const { buildGridSummaryHierarchyAsync, publishGridSummaryHierarchyCandidate } =
      await loadSummaryHierarchyModule();
    const summaryView: GridSummaryView = options.view ?? {
      datasetId: options.descriptor.datasetId,
      viewRevision: options.viewRevision,
      rowCount: options.store.rowCount,
      physicalRows: null,
    };
    const result = await buildGridSummaryHierarchyAsync(options.store, summaryView, {
      requestId: ++nextSummaryBuildRequestId,
      dataRevision: options.descriptor.dataRevision,
      columns: options.summaryColumnIds,
      blockSize: SUMMARY_BLOCK_SIZE,
      ...(options.stagedPatch ? { stagedPatch: options.stagedPatch } : {}),
      ...(options.previousRetainedBytes === undefined
        ? {}
        : { previousRetainedBytes: options.previousRetainedBytes }),
      shouldCancel: options.shouldCancel,
    });
    if (result.status === "cancelled" || options.shouldCancel()) return null;
    const published = publishGridSummaryHierarchyCandidate(result.candidate, result.candidate);
    if (!published) throw new Error("The Grid summary candidate could not be published.");
    runtimeSummaryBuildDurations.set(published, Math.max(0, performance.now() - startedAt));
    return published;
  };

  const install = async (
    message: Extract<GridRuntimeInputMessage, { type: "install" }>,
  ): Promise<void> => {
    if (editReservation || pendingEdit) {
      fail("install", new Error("Grid data replacement is blocked by an authoritative edit."), {
        requestId: message.requestId,
      });
      return;
    }
    cancelInstall();
    cancelView();
    const generation = ++installGeneration;
    const controller = new AbortController();
    installAbort = controller;
    installingRequestId = message.requestId;
    const startedAt = performance.now();
    try {
      const preflight = await preflightGridDataAsync(message.data, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (disposed || generation !== installGeneration) return;
          send({
            type: "installProgress",
            requestId: message.requestId,
            dataRevision: message.dataRevision,
            completed: progress.completed,
            total: progress.total,
          });
        },
      });
      if (disposed || generation !== installGeneration || controller.signal.aborted) {
        send({ type: "cancelled", scope: "install", requestId: message.requestId });
        return;
      }
      const store = new GridDataStore();
      const installResult = store.installWorkerIngress(message.data, preflight);
      if (disposed || generation !== installGeneration || controller.signal.aborted) {
        send({ type: "cancelled", scope: "install", requestId: message.requestId });
        return;
      }
      const descriptor = datasetDescriptor(store, installResult, message.dataRevision);
      const summaryColumnIds = configuredSummaryColumnIds(store, message.summaryColumnIds);
      const summary = await buildSummary({
        store,
        descriptor,
        view: null,
        viewRevision: 0,
        summaryColumnIds,
        previousRetainedBytes: active?.summary?.retainedBytes,
        shouldCancel: () =>
          disposed ||
          generation !== installGeneration ||
          controller.signal.aborted ||
          store.datasetId !== descriptor.datasetId,
      });
      if (
        disposed ||
        generation !== installGeneration ||
        controller.signal.aborted ||
        (summaryColumnIds.length > 0 && summary === null)
      ) {
        send({ type: "cancelled", scope: "install", requestId: message.requestId });
        return;
      }
      pendingInstall = {
        requestId: message.requestId,
        snapshot: {
          store,
          descriptor,
          view: null,
          viewRevision: 0,
          spec: {},
          summaryColumnIds,
          summary,
        },
      };
      installAbort = null;
      installingRequestId = null;
      send({
        type: "installReady",
        requestId: message.requestId,
        descriptor,
        installDurationMs: Math.max(0, performance.now() - startedAt),
        summary: summaryBuildMetadata(summary),
      });
    } catch (error) {
      if (disposed) return;
      if (generation !== installGeneration || controller.signal.aborted) {
        send({ type: "cancelled", scope: "install", requestId: message.requestId });
      } else {
        installAbort = null;
        installingRequestId = null;
        fail("install", error, { requestId: message.requestId });
      }
    }
  };

  const setView = async (
    message: Extract<GridRuntimeInputMessage, { type: "setView" }>,
  ): Promise<void> => {
    if (editReservation || pendingEdit) {
      fail("view", new Error("Grid view changes are blocked by an authoritative edit."), {
        requestId: message.requestId,
      });
      return;
    }
    const current = active;
    if (!current || current.descriptor.datasetId !== message.datasetId) {
      fail("view", new Error("The requested dataset is not active in the Grid runtime."), {
        requestId: message.requestId,
      });
      return;
    }
    cancelView();
    const generation = ++viewGeneration;
    buildingViewRequestId = message.requestId;
    const startedAt = performance.now();
    try {
      const result = await buildGridViewCandidateAsync(current.store, message.spec, {
        requestId: message.requestId,
        viewRevision: message.viewRevision,
        shouldCancel: () =>
          disposed ||
          generation !== viewGeneration ||
          active?.descriptor.datasetId !== message.datasetId,
        onProgress: (progress) => {
          if (disposed || generation !== viewGeneration) return;
          send({
            type: "viewProgress",
            requestId: message.requestId,
            datasetId: message.datasetId,
            viewRevision: message.viewRevision,
            ...progress,
          });
        },
      });
      if (disposed || generation !== viewGeneration || result.status !== "complete") {
        send({ type: "cancelled", scope: "view", requestId: message.requestId });
        return;
      }
      const published = publishGridViewCandidate(result.candidate, message);
      if (!published) {
        send({ type: "cancelled", scope: "view", requestId: message.requestId });
        return;
      }
      const summary = await buildSummary({
        store: current.store,
        descriptor: current.descriptor,
        view: published,
        viewRevision: message.viewRevision,
        summaryColumnIds: current.summaryColumnIds,
        previousRetainedBytes: current.summary?.retainedBytes,
        shouldCancel: () =>
          disposed ||
          generation !== viewGeneration ||
          active !== current ||
          active?.descriptor.datasetId !== message.datasetId,
      });
      if (
        disposed ||
        generation !== viewGeneration ||
        active !== current ||
        (current.summaryColumnIds.length > 0 && summary === null)
      ) {
        send({ type: "cancelled", scope: "view", requestId: message.requestId });
        return;
      }
      const buildDurationMs = Math.max(0, performance.now() - startedAt);
      buildingViewRequestId = null;
      const snapshot: RuntimeSnapshot = {
        ...current,
        view: published,
        viewRevision: message.viewRevision,
        spec: published.spec,
        summary,
      };
      pendingView = { requestId: message.requestId, snapshot, buildDurationMs };
      send({
        type: "viewReady",
        requestId: message.requestId,
        datasetId: message.datasetId,
        viewRevision: message.viewRevision,
        spec: published.spec,
        rowCount: published.rowCount,
        buildDurationMs,
        summary: summaryBuildMetadata(summary),
      });
    } catch (error) {
      if (disposed) return;
      if (generation !== viewGeneration) {
        send({ type: "cancelled", scope: "view", requestId: message.requestId });
      } else {
        buildingViewRequestId = null;
        fail("view", error, { requestId: message.requestId });
      }
    }
  };

  const resolveTarget = (target: GridRuntimeSurfaceTarget): RuntimeSnapshot => {
    if (target.kind === "active") {
      if (!active) throw new Error("The Grid runtime has no active dataset.");
      return active;
    }
    if (target.kind === "install") {
      if (!pendingInstall || pendingInstall.requestId !== target.requestId) {
        throw new Error("The requested Grid install candidate is no longer available.");
      }
      return pendingInstall.snapshot;
    }
    if (target.kind === "view") {
      if (!pendingView || pendingView.requestId !== target.requestId) {
        throw new Error("The requested Grid view candidate is no longer available.");
      }
      return pendingView.snapshot;
    }
    if (!pendingEdit || pendingEdit.operationId !== target.operationId) {
      throw new Error("The requested Grid edit candidate is no longer available.");
    }
    return pendingEdit.snapshot;
  };

  const prepareSurface = (message: GridRuntimeSurfaceMessage): void => {
    if (pendingSurface) {
      if (queuedSurface) {
        send({
          type: "surfaceDropped",
          surfaceId: queuedSurface.surfaceId,
          commitToken: queuedSurface.commitToken,
          reason: "coalesced",
        });
      }
      queuedSurface = message;
      return;
    }
    try {
      const snapshot = resolveTarget(message.target);
      if (
        message.revision.datasetId !== snapshot.descriptor.datasetId ||
        message.revision.dataRevision !== snapshot.descriptor.dataRevision ||
        message.revision.viewRevision !== snapshot.viewRevision
      ) {
        send({
          type: "surfaceDropped",
          surfaceId: message.surfaceId,
          commitToken: message.commitToken,
          reason: "stale",
        });
        return;
      }
      const startedAt = performance.now();
      const frame = buildRawGridPaintFrame({
        frameId: message.surfaceId,
        commitToken: message.commitToken,
        revision: message.revision,
        store: snapshot.store,
        view: snapshot.view,
        viewportWidth: message.viewportWidth,
        viewportHeight: message.viewportHeight,
        pixelRatio: message.pixelRatio,
        scrollTop: message.scrollTop,
        scrollLeft: message.scrollLeft,
        range: message.range,
        layout: message.layout,
        columnLayout: message.columnLayout,
        rowNumberWidth: message.rowNumberWidth,
        rowNumberLabel: message.rowNumberLabel,
        minColumnWidth: message.minColumnWidth,
        maxColumnWidth: message.maxColumnWidth,
        palette: message.palette,
        selection: message.selection,
        focusedRowIndex: message.focusedRowIndex,
        focusedColumnIndex: message.focusedColumnIndex,
        ...(snapshot.stagedPatch
          ? {
              cellAt: (physicalRow: number, columnIndex: number) =>
                snapshot.store.stagedCellAt(snapshot.stagedPatch!, physicalRow, columnIndex),
            }
          : {}),
      });
      assertGridPaintFrame(frame);
      const visibleRowIds = frame.rows.map((row) => {
        const physicalRow = snapshot.view?.physicalRowAt(row.viewOrdinal) ?? row.viewOrdinal;
        return snapshot.store.rowIdAt(physicalRow);
      });
      pendingSurface = { message, snapshot };
      send({
        type: "surfaceReady",
        surfaceId: message.surfaceId,
        commitToken: message.commitToken,
        source: message.source,
        target: message.target,
        frame,
        visibleRowIds,
        rowCount: snapshot.view?.rowCount ?? snapshot.store.rowCount,
        columnCount: snapshot.store.columnCount,
        formatDurationMs: Math.max(0, performance.now() - startedAt),
      });
    } catch (error) {
      fail("surface", error, { requestId: message.surfaceId });
    }
  };

  const continueSurfaceQueue = (): void => {
    const next = queuedSurface;
    queuedSurface = null;
    if (next && !disposed) prepareSurface(next);
  };

  const finalizeSurface = (
    message: Extract<GridRuntimeInputMessage, { type: "finalizeSurface" }>,
  ): void => {
    const surface = pendingSurface;
    if (
      !surface ||
      surface.message.surfaceId !== message.surfaceId ||
      surface.message.commitToken !== message.commitToken
    ) {
      fail("surface", new Error("The Grid runtime cannot finalize an unknown surface."), {
        requestId: message.surfaceId,
      });
      return;
    }
    let publicationKind: "data" | "view" | "edit" | "presentation" = "presentation";
    if (surface.message.target.kind === "install") {
      if (
        !pendingInstall ||
        pendingInstall.requestId !== surface.message.target.requestId ||
        pendingInstall.snapshot !== surface.snapshot
      ) {
        pendingSurface = null;
        fail(
          "surface",
          new Error("The Grid install candidate was superseded before publication."),
          {
            requestId: message.surfaceId,
          },
        );
        continueSurfaceQueue();
        return;
      }
      cancelAllSummaryQueries("stale");
      active = pendingInstall.snapshot;
      pendingInstall = null;
      pendingView = null;
      publicationKind = "data";
    } else if (surface.message.target.kind === "view") {
      if (
        !pendingView ||
        pendingView.requestId !== surface.message.target.requestId ||
        pendingView.snapshot !== surface.snapshot
      ) {
        pendingSurface = null;
        fail("surface", new Error("The Grid view candidate was superseded before publication."), {
          requestId: message.surfaceId,
        });
        continueSurfaceQueue();
        return;
      }
      cancelAllSummaryQueries("stale");
      active = pendingView.snapshot;
      pendingView = null;
      publicationKind = "view";
    } else if (surface.message.target.kind === "edit") {
      if (
        !pendingEdit ||
        pendingEdit.operationId !== surface.message.target.operationId ||
        pendingEdit.snapshot !== surface.snapshot
      ) {
        pendingSurface = null;
        fail("surface", new Error("The Grid edit candidate was superseded before publication."), {
          requestId: message.surfaceId,
          operationId: surface.message.target.operationId,
        });
        continueSurfaceQueue();
        return;
      }
      // V1 serializes one authoritative reservation/candidate, but this final
      // CAS protects the async staged view/summary/paint gap. Any future edit
      // concurrency must retain explicit stale-publication coverage here.
      if (!pendingEdit.snapshot.store.promoteCellPatch(pendingEdit.stagedPatch)) {
        pendingSurface = null;
        fail("edit", new Error("The accepted Grid edit failed its publication compare-and-set."), {
          operationId: pendingEdit.operationId,
        });
        continueSurfaceQueue();
        return;
      }
      cancelAllSummaryQueries("stale");
      active = { ...pendingEdit.snapshot, stagedPatch: undefined };
      pendingEdit = null;
      editReservation = null;
      publicationKind = "edit";
    }
    pendingSurface = null;
    const committed = active ?? surface.snapshot;
    send({
      type: "published",
      surfaceId: message.surfaceId,
      commitToken: message.commitToken,
      publicationKind,
      descriptor: committed.descriptor,
      viewRevision: committed.viewRevision,
      spec: committed.spec,
      rowCount: committed.view?.rowCount ?? committed.store.rowCount,
      summary: summaryBuildMetadata(committed.summary),
    });
    continueSurfaceQueue();
  };

  const dropSurface = (
    message: Extract<GridRuntimeInputMessage, { type: "dropSurface" }>,
  ): void => {
    const surface = pendingSurface;
    if (
      !surface ||
      surface.message.surfaceId !== message.surfaceId ||
      surface.message.commitToken !== message.commitToken
    ) {
      return;
    }
    pendingSurface = null;
    send({
      type: "surfaceDropped",
      surfaceId: message.surfaceId,
      commitToken: message.commitToken,
      reason: "host",
    });
    continueSurfaceQueue();
  };

  const resolveRow = (message: Extract<GridRuntimeInputMessage, { type: "resolveRow" }>): void => {
    try {
      if (!active || active.descriptor.datasetId !== message.datasetId) {
        throw new Error("The requested dataset is not active in the Grid runtime.");
      }
      const physicalRow = active.store.rowIndexOf(message.rowId);
      const viewOrdinal =
        physicalRow < 0
          ? -1
          : active.view
            ? active.view.viewOrdinalOfRowId(message.rowId, active.store)
            : physicalRow;
      send({
        type: "resolvedRow",
        queryId: message.queryId,
        datasetId: message.datasetId,
        rowId: message.rowId,
        physicalRow,
        viewOrdinal,
      });
    } catch (error) {
      fail("resolve", error, { queryId: message.queryId });
    }
  };

  const resolveOrdinal = (
    message: Extract<GridRuntimeInputMessage, { type: "resolveOrdinal" }>,
  ): void => {
    try {
      if (!active || active.descriptor.datasetId !== message.datasetId) {
        throw new Error("The requested dataset is not active in the Grid runtime.");
      }
      const rowCount = active.view?.rowCount ?? active.store.rowCount;
      if (
        !Number.isSafeInteger(message.viewOrdinal) ||
        message.viewOrdinal < 0 ||
        message.viewOrdinal >= rowCount
      ) {
        send({
          type: "resolvedOrdinal",
          queryId: message.queryId,
          datasetId: message.datasetId,
          viewOrdinal: message.viewOrdinal,
          physicalRow: -1,
          rowId: null,
        });
        return;
      }
      const physicalRow = active.view?.physicalRowAt(message.viewOrdinal) ?? message.viewOrdinal;
      send({
        type: "resolvedOrdinal",
        queryId: message.queryId,
        datasetId: message.datasetId,
        viewOrdinal: message.viewOrdinal,
        physicalRow,
        rowId: active.store.rowIdAt(physicalRow),
      });
    } catch (error) {
      fail("resolve", error, { queryId: message.queryId });
    }
  };

  const inspectCell = (
    message: Extract<GridRuntimeInputMessage, { type: "inspectCell" }>,
  ): void => {
    try {
      if (!active || active.descriptor.datasetId !== message.datasetId) {
        throw new Error("The requested dataset is not active in the Grid runtime.");
      }
      const rowIndex = active.store.rowIndexOf(message.rowId);
      const columnIndex = active.store.columnIndexOf(message.columnId);
      if (rowIndex < 0 || columnIndex < 0)
        throw new Error("The requested Grid cell does not exist.");
      const state = active.store.cellState(message.rowId, message.columnId);
      const descriptor = active.store.columnDescriptorAt(columnIndex);
      send({
        type: "cellInspected",
        queryId: message.queryId,
        datasetId: message.datasetId,
        rowId: message.rowId,
        columnId: message.columnId,
        descriptor,
        value: state.value,
        cellRevision: state.revision,
        ...(descriptor.schema.kind === "category"
          ? { categoryValues: active.store.categoryValuesAt(columnIndex) }
          : {}),
      });
    } catch (error) {
      fail("resolve", error, { queryId: message.queryId });
    }
  };

  const cancelSummaryQuery = (queryId: number, reason: "host" | "stale"): void => {
    const pending = pendingSummaryQueries.get(queryId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSummaryQueries.delete(queryId);
    send({ type: "summaryCancelled", queryId, reason });
  };

  const cancelAllSummaryQueries = (reason: "stale"): void => {
    for (const queryId of pendingSummaryQueries.keys()) {
      cancelSummaryQuery(queryId, reason);
    }
  };

  const querySnapshotIsCurrent = (pending: PendingSummaryQuery): boolean => {
    const current = active;
    return (
      pendingSummaryQueries.get(pending.message.queryId) === pending &&
      current === pending.snapshot &&
      current.descriptor.datasetId === pending.message.datasetId &&
      current.descriptor.dataRevision === pending.message.dataRevision &&
      current.viewRevision === pending.message.viewRevision &&
      current.summary !== null
    );
  };

  const runSummaryQuery = async (pending: PendingSummaryQuery): Promise<void> => {
    const startedAt = performance.now();
    const { message, ranges, snapshot } = pending;
    const hierarchy = snapshot.summary;
    if (!hierarchy || !querySnapshotIsCurrent(pending)) {
      cancelSummaryQuery(message.queryId, "stale");
      return;
    }
    const bandCount = ranges.length >>> 1;
    const rowCounts = new Uint32Array(bandCount);
    const nullCounts = new Uint32Array(bandCount);
    let nodeVisits = 0;
    let rawRowsScanned = 0;
    let summaryVertices = 0;
    const descriptor = snapshot.store.columnDescriptorAt(
      snapshot.store.columnIndexOf(message.columnId),
    );
    try {
      let output: GridRuntimeSummaryReadyMessage;
      if (descriptor.schema.kind === "number") {
        const finiteCounts = new Uint32Array(bandCount);
        const nanCounts = new Uint32Array(bandCount);
        const positiveInfinityCounts = new Uint32Array(bandCount);
        const negativeInfinityCounts = new Uint32Array(bandCount);
        const finiteMinimumValues = new Float64Array(bandCount);
        const finiteMaximumValues = new Float64Array(bandCount);
        finiteMinimumValues.fill(Number.NaN);
        finiteMaximumValues.fill(Number.NaN);
        const finiteMinimumViewOrdinals = new Uint32Array(bandCount);
        const finiteMaximumViewOrdinals = new Uint32Array(bandCount);
        finiteMinimumViewOrdinals.fill(NO_SUMMARY_ORDINAL);
        finiteMaximumViewOrdinals.fill(NO_SUMMARY_ORDINAL);
        const finiteMinimumRowIds: (RowId | null)[] = new Array(bandCount).fill(null);
        const finiteMaximumRowIds: (RowId | null)[] = new Array(bandCount).fill(null);
        for (let band = 0; band < bandCount; band++) {
          if (!querySnapshotIsCurrent(pending)) {
            cancelSummaryQuery(message.queryId, "stale");
            return;
          }
          const start = ranges[band * 2]!;
          const end = ranges[band * 2 + 1]!;
          const result = hierarchy.query(message.columnId, start, end, hierarchy);
          if (result.kind !== "numeric") {
            throw new Error("The configured Grid numeric summary changed kind.");
          }
          rowCounts[band] = result.rowCount;
          nullCounts[band] = result.nullCount;
          finiteCounts[band] = result.finiteCount;
          nanCounts[band] = result.nanCount;
          positiveInfinityCounts[band] = result.positiveInfinityCount;
          negativeInfinityCounts[band] = result.negativeInfinityCount;
          nodeVisits += result.stats.nodeVisits;
          rawRowsScanned += result.stats.rawRowsScanned;
          summaryVertices += result.stats.summaryVertices;
          if (result.finiteMinimum) {
            finiteMinimumValues[band] = result.finiteMinimum.value;
            finiteMinimumViewOrdinals[band] = result.finiteMinimum.viewOrdinal;
            finiteMinimumRowIds[band] = result.finiteMinimum.rowId;
          }
          if (result.finiteMaximum) {
            finiteMaximumValues[band] = result.finiteMaximum.value;
            finiteMaximumViewOrdinals[band] = result.finiteMaximum.viewOrdinal;
            finiteMaximumRowIds[band] = result.finiteMaximum.rowId;
          }
          if ((band + 1) % SUMMARY_QUERY_CHUNK_BANDS === 0 && band + 1 < bandCount) {
            await yieldSummaryQueryTurn();
          }
        }
        output = {
          type: "summaryReady",
          kind: "numeric",
          queryId: message.queryId,
          datasetId: message.datasetId,
          dataRevision: message.dataRevision,
          viewRevision: message.viewRevision,
          columnId: message.columnId,
          exact: true,
          bandCount,
          ranges,
          rowCounts,
          nullCounts,
          finiteCounts,
          nanCounts,
          positiveInfinityCounts,
          negativeInfinityCounts,
          finiteMinimumValues,
          finiteMaximumValues,
          finiteMinimumViewOrdinals,
          finiteMaximumViewOrdinals,
          finiteMinimumRowIds,
          finiteMaximumRowIds,
          nodeVisits,
          rawRowsScanned,
          summaryVertices,
          queryDurationMs: Math.max(0, performance.now() - startedAt),
          typedPayloadBytes: typedArrayBytes([
            ranges,
            rowCounts,
            nullCounts,
            finiteCounts,
            nanCounts,
            positiveInfinityCounts,
            negativeInfinityCounts,
            finiteMinimumValues,
            finiteMaximumValues,
            finiteMinimumViewOrdinals,
            finiteMaximumViewOrdinals,
          ]),
        };
      } else if (descriptor.schema.kind === "category") {
        const exemplarCounts = new Uint8Array(bandCount);
        const exemplarCodes = new Uint32Array(bandCount * 4);
        const exemplarViewOrdinals = new Uint32Array(bandCount * 4);
        exemplarViewOrdinals.fill(NO_SUMMARY_ORDINAL);
        const exemplarRowIds: (RowId | null)[] = new Array(bandCount * 4).fill(null);
        const labels: string[] = [];
        const labelIndexes = new Map<string, number>();
        const exemplarLabelIndexes = new Uint32Array(bandCount * 4);
        exemplarLabelIndexes.fill(NO_SUMMARY_ORDINAL);
        const complete = new Uint8Array(bandCount);
        for (let band = 0; band < bandCount; band++) {
          if (!querySnapshotIsCurrent(pending)) {
            cancelSummaryQuery(message.queryId, "stale");
            return;
          }
          const start = ranges[band * 2]!;
          const end = ranges[band * 2 + 1]!;
          const result = hierarchy.query(message.columnId, start, end, hierarchy);
          if (result.kind !== "category") {
            throw new Error("The configured Grid category summary changed kind.");
          }
          rowCounts[band] = result.rowCount;
          nullCounts[band] = result.nullCount;
          exemplarCounts[band] = result.exemplars.length;
          complete[band] = result.complete ? 1 : 0;
          nodeVisits += result.stats.nodeVisits;
          rawRowsScanned += result.stats.rawRowsScanned;
          summaryVertices += result.stats.summaryVertices;
          for (let exemplar = 0; exemplar < result.exemplars.length; exemplar++) {
            const value = result.exemplars[exemplar]!;
            const offset = band * 4 + exemplar;
            exemplarCodes[offset] = value.code;
            exemplarViewOrdinals[offset] = value.viewOrdinal;
            exemplarRowIds[offset] = value.rowId;
            let labelIndex = labelIndexes.get(value.label);
            if (labelIndex === undefined) {
              labelIndex = labels.length;
              labelIndexes.set(value.label, labelIndex);
              labels.push(value.label);
            }
            exemplarLabelIndexes[offset] = labelIndex;
          }
          if ((band + 1) % SUMMARY_QUERY_CHUNK_BANDS === 0 && band + 1 < bandCount) {
            await yieldSummaryQueryTurn();
          }
        }
        output = {
          type: "summaryReady",
          kind: "category",
          queryId: message.queryId,
          datasetId: message.datasetId,
          dataRevision: message.dataRevision,
          viewRevision: message.viewRevision,
          columnId: message.columnId,
          exact: true,
          bandCount,
          ranges,
          rowCounts,
          nullCounts,
          exemplarCounts,
          exemplarCodes,
          exemplarViewOrdinals,
          exemplarRowIds,
          labels,
          exemplarLabelIndexes,
          complete,
          nodeVisits,
          rawRowsScanned,
          summaryVertices,
          queryDurationMs: Math.max(0, performance.now() - startedAt),
          typedPayloadBytes: typedArrayBytes([
            ranges,
            rowCounts,
            nullCounts,
            exemplarCounts,
            exemplarCodes,
            exemplarViewOrdinals,
            exemplarLabelIndexes,
            complete,
          ]),
        };
      } else {
        throw new Error("The configured Grid summary column is no longer supported.");
      }
      if (!querySnapshotIsCurrent(pending)) {
        cancelSummaryQuery(message.queryId, "stale");
        return;
      }
      pendingSummaryQueries.delete(message.queryId);
      send(output, summaryTransferList(output));
    } catch (error) {
      if (pendingSummaryQueries.get(message.queryId) !== pending) return;
      pendingSummaryQueries.delete(message.queryId);
      fail("summary", error, { queryId: message.queryId });
    }
  };

  const querySummary = (message: GridRuntimeQuerySummaryMessage): void => {
    try {
      if (!Number.isSafeInteger(message.queryId) || message.queryId < 0) {
        throw new RangeError("Grid summary queryId must be a non-negative safe integer.");
      }
      if (pendingSummaryQueries.has(message.queryId)) {
        throw new Error("The Grid summary queryId is already active.");
      }
      const snapshot = active;
      if (
        !snapshot ||
        snapshot.descriptor.datasetId !== message.datasetId ||
        snapshot.descriptor.dataRevision !== message.dataRevision ||
        snapshot.viewRevision !== message.viewRevision
      ) {
        throw new Error("The requested Grid summary snapshot is stale.");
      }
      if (!snapshot.summary || !snapshot.summaryColumnIds.includes(message.columnId)) {
        throw new Error("The requested Grid column has no configured exact summary.");
      }
      if (!(message.ranges instanceof Uint32Array)) {
        throw new TypeError("Grid summary ranges must be a Uint32Array of [start, end) pairs.");
      }
      if (
        message.ranges.length === 0 ||
        (message.ranges.length & 1) !== 0 ||
        message.ranges.length / 2 > MAX_SUMMARY_BANDS
      ) {
        throw new RangeError(`Grid summary queries support 1 to ${MAX_SUMMARY_BANDS} bands.`);
      }
      const rowCount = snapshot.view?.rowCount ?? snapshot.store.rowCount;
      const ranges = message.ranges.slice();
      for (let offset = 0; offset < ranges.length; offset += 2) {
        const start = ranges[offset]!;
        const end = ranges[offset + 1]!;
        if (end < start || end > rowCount) {
          throw new RangeError(
            `Grid summary range [${start}, ${end}) is outside [0, ${rowCount}).`,
          );
        }
      }
      let pending!: PendingSummaryQuery;
      const timer = setTimeout(() => void runSummaryQuery(pending), 0);
      pending = { message, ranges, snapshot, timer };
      pendingSummaryQueries.set(message.queryId, pending);
    } catch (error) {
      fail("summary", error, { queryId: message.queryId });
    }
  };

  const parseEdit = (message: Extract<GridRuntimeInputMessage, { type: "parseEdit" }>): void => {
    try {
      if (!active || active.descriptor.datasetId !== message.datasetId) {
        throw new Error("The requested dataset is not active in the Grid runtime.");
      }
      const value = active.store.parseEditableCellValue(
        message.rowId,
        message.columnId,
        message.raw,
        message.explicitNull,
      );
      send({ type: "editParsed", operationId: message.operationId, value });
    } catch (error) {
      fail("edit", error, { operationId: message.operationId });
    }
  };

  const reserveEdit = (
    message: Extract<GridRuntimeInputMessage, { type: "reserveEdit" }>,
  ): void => {
    if (editReservation || pendingEdit) {
      send({
        type: "editLease",
        operationId: message.operationId,
        result: {
          granted: false,
          reason: "stale",
          message: "Another Grid edit already owns the authoritative commit reservation.",
        },
      });
      return;
    }
    try {
      if (!active || active.descriptor.datasetId !== message.datasetId) {
        throw new Error("The edited dataset is no longer active.");
      }
      const baseline: GridCellPatchBaseline = {
        datasetId: message.datasetId,
        rowId: message.rowId,
        columnId: message.columnId,
        cellRevision: message.cellRevision,
        previousValue: message.previousValue,
      };
      if (!active.store.isCellBaselineCurrent(baseline)) {
        send({
          type: "editLease",
          operationId: message.operationId,
          result: {
            granted: false,
            reason: "stale",
            message: "The cell changed before authoritative commit.",
          },
        });
        return;
      }
      try {
        active.store.validateEditableCellValue(message.rowId, message.columnId, message.finalValue);
      } catch (error) {
        send({
          type: "editLease",
          operationId: message.operationId,
          result: {
            granted: false,
            reason: "invalid-normalization",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      const leaseId = `${message.operationId}:lease`;
      editReservation = {
        operationId: message.operationId,
        leaseId,
        baseline,
        finalValue: message.finalValue,
      };
      send({
        type: "editLease",
        operationId: message.operationId,
        result: { granted: true, leaseId, finalValue: message.finalValue },
      });
    } catch (error) {
      send({
        type: "editLease",
        operationId: message.operationId,
        result: {
          granted: false,
          reason: "stale",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  const cancelEdit = (message: Extract<GridRuntimeInputMessage, { type: "cancelEdit" }>): void => {
    if (editReservation?.operationId === message.operationId && !pendingEdit) {
      editReservation = null;
    }
  };

  const discardEdit = (
    message: Extract<GridRuntimeInputMessage, { type: "discardEdit" }>,
  ): void => {
    if (pendingEdit?.operationId === message.operationId) {
      pendingEdit.snapshot.store.discardCellPatch(pendingEdit.stagedPatch);
      pendingEdit = null;
    }
    if (editReservation?.operationId === message.operationId) editReservation = null;
  };

  const applyEdit = async (
    message: Extract<GridRuntimeInputMessage, { type: "applyEdit" }>,
  ): Promise<void> => {
    const reservation = editReservation;
    const current = active;
    if (
      !reservation ||
      reservation.operationId !== message.operationId ||
      reservation.leaseId !== message.leaseId ||
      !current
    ) {
      fail("edit", new Error("The Grid edit commit reservation is not active."), {
        operationId: message.operationId,
      });
      return;
    }
    const stagedPatch = current.store.stageCellPatch({
      ...reservation.baseline,
      finalValue: reservation.finalValue,
    });
    if (!stagedPatch) {
      fail("edit", new Error("The edited cell changed after commit reservation."), {
        operationId: message.operationId,
      });
      return;
    }
    const startedAt = performance.now();
    try {
      const source = {
        datasetId: current.store.datasetId,
        rowCount: current.store.rowCount,
        columnIndexOf: (columnId: string) => current.store.columnIndexOf(columnId),
        columnScalarTypeAt: (column: number | string) => current.store.columnScalarTypeAt(column),
        cellAt: (rowIndex: number, column: number | string) =>
          current.store.stagedCellAt(stagedPatch, rowIndex, column),
        typedColumnAt: (column: number | string) =>
          current.store.typedColumnAt(column, stagedPatch),
      };
      const tentativeViewRevision = current.viewRevision + 1;
      const result = await buildGridViewCandidateAsync(source, current.spec, {
        requestId: 0,
        viewRevision: tentativeViewRevision,
        shouldCancel: () => disposed || editReservation !== reservation,
        onProgress: (progress) => {
          if (disposed || editReservation !== reservation) return;
          send({ type: "editProgress", operationId: message.operationId, ...progress });
        },
      });
      if (result.status !== "complete" || disposed || editReservation !== reservation) return;
      const candidate = publishGridViewCandidate(result.candidate, {
        datasetId: current.descriptor.datasetId,
        requestId: 0,
        viewRevision: tentativeViewRevision,
      });
      if (!candidate) throw new Error("The Grid edit view candidate could not be published.");
      const viewChanged = !viewMappingsEqual(current, candidate);
      const viewRevision = viewChanged ? tentativeViewRevision : current.viewRevision;
      const view =
        viewRevision === candidate.viewRevision
          ? candidate
          : createPublishedGridView({
              datasetId: candidate.datasetId,
              requestId: candidate.requestId,
              viewRevision,
              physicalRowCount: candidate.physicalRowCount,
              physicalRows: candidate.physicalRows,
              filterBitmap: candidate.filterBitmap,
              spec: candidate.spec,
            });
      const descriptor = {
        ...current.descriptor,
        dataRevision: current.descriptor.dataRevision + 1,
      };
      const summary = await buildSummary({
        store: current.store,
        descriptor,
        view,
        viewRevision,
        summaryColumnIds: current.summaryColumnIds,
        stagedPatch,
        previousRetainedBytes: current.summary?.retainedBytes,
        shouldCancel: () => disposed || editReservation !== reservation || active !== current,
      });
      if (
        disposed ||
        editReservation !== reservation ||
        active !== current ||
        (current.summaryColumnIds.length > 0 && summary === null)
      ) {
        current.store.discardCellPatch(stagedPatch);
        return;
      }
      const snapshot: RuntimeSnapshot = {
        store: current.store,
        descriptor,
        view,
        viewRevision,
        spec: current.spec,
        summaryColumnIds: current.summaryColumnIds,
        summary,
        stagedPatch,
      };
      const buildDurationMs = Math.max(0, performance.now() - startedAt);
      const editedRowIndex = view.viewOrdinalOfRowId(reservation.baseline.rowId, current.store);
      pendingEdit = {
        operationId: message.operationId,
        leaseId: message.leaseId,
        stagedPatch,
        snapshot,
        buildDurationMs,
        viewChanged,
      };
      send({
        type: "editReady",
        operationId: message.operationId,
        datasetId: descriptor.datasetId,
        dataRevision: descriptor.dataRevision,
        viewRevision,
        rowCount: view.rowCount,
        editedRowIndex,
        viewChanged,
        buildDurationMs,
        summary: summaryBuildMetadata(summary),
      });
    } catch (error) {
      current.store.discardCellPatch(stagedPatch);
      fail("edit", error, { operationId: message.operationId });
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    installGeneration++;
    viewGeneration++;
    installAbort?.abort("disposed");
    installAbort = null;
    installingRequestId = null;
    buildingViewRequestId = null;
    active = null;
    pendingInstall = null;
    pendingView = null;
    if (pendingEdit) pendingEdit.snapshot.store.discardCellPatch(pendingEdit.stagedPatch);
    pendingEdit = null;
    editReservation = null;
    pendingSurface = null;
    queuedSurface = null;
    for (const pending of pendingSummaryQueries.values()) clearTimeout(pending.timer);
    pendingSummaryQueries.clear();
    disposed = true;
    callbacks.postMessage({ type: "disposed" });
    callbacks.close?.();
  };

  queueMicrotask(() => send({ type: "ready" }));

  return {
    handleMessage(message): void {
      if (disposed) return;
      switch (message.type) {
        case "install":
          void install(message);
          return;
        case "setView":
          void setView(message);
          return;
        case "surface":
          prepareSurface(message);
          return;
        case "finalizeSurface":
          finalizeSurface(message);
          return;
        case "dropSurface":
          dropSurface(message);
          return;
        case "cancel":
          if (message.scope === "install") cancelInstall(message.requestId);
          else cancelView(message.requestId);
          return;
        case "resolveRow":
          resolveRow(message);
          return;
        case "resolveOrdinal":
          resolveOrdinal(message);
          return;
        case "inspectCell":
          inspectCell(message);
          return;
        case "querySummary":
          querySummary(message);
          return;
        case "cancelSummary":
          cancelSummaryQuery(message.queryId, "host");
          return;
        case "parseEdit":
          parseEdit(message);
          return;
        case "reserveEdit":
          reserveEdit(message);
          return;
        case "cancelEdit":
          cancelEdit(message);
          return;
        case "applyEdit":
          void applyEdit(message);
          return;
        case "discardEdit":
          discardEdit(message);
          return;
        case "dispose":
          dispose();
      }
    },
    dispose,
  };
}

function datasetDescriptor(
  store: GridDataStore,
  installResult: GridDataInstallResult,
  dataRevision: number,
): GridRuntimeDatasetDescriptor {
  const columns: GridColumnDescriptor[] = [];
  for (let columnIndex = 0; columnIndex < store.columnCount; columnIndex++) {
    columns.push(store.columnDescriptorAt(columnIndex));
  }
  return {
    datasetId: installResult.datasetId,
    dataRevision,
    rowCount: store.rowCount,
    columns,
    installResult,
  };
}

function viewMappingsEqual(active: RuntimeSnapshot, candidate: GridPublishedView): boolean {
  const activeRowCount = active.view?.rowCount ?? active.store.rowCount;
  if (candidate.rowCount !== activeRowCount) return false;
  for (let ordinal = 0; ordinal < activeRowCount; ordinal++) {
    const activePhysical = active.view?.physicalRowAt(ordinal) ?? ordinal;
    if (candidate.physicalRowAt(ordinal) !== activePhysical) return false;
  }
  return true;
}

function configuredSummaryColumnIds(
  store: GridDataStore,
  requested: readonly string[] | undefined,
): readonly string[] {
  if (requested === undefined || requested.length === 0) return Object.freeze([]);
  const unique = new Set<string>();
  const configured: string[] = [];
  for (const columnId of requested) {
    if (typeof columnId !== "string" || columnId.length === 0) {
      throw new TypeError("Configured Grid summary column IDs must be non-empty strings.");
    }
    if (unique.has(columnId)) {
      throw new TypeError(`Configured Grid summary column ${columnId} is duplicated.`);
    }
    const columnIndex = store.columnIndexOf(columnId);
    if (columnIndex < 0) {
      throw new RangeError(`Configured Grid summary column ${columnId} does not exist.`);
    }
    const kind = store.columnDescriptorAt(columnIndex).schema.kind;
    if (kind !== "number" && kind !== "category") {
      throw new TypeError(
        `Configured Grid summary column ${columnId} must be numeric or categorical.`,
      );
    }
    unique.add(columnId);
    configured.push(columnId);
  }
  return Object.freeze(configured);
}

function yieldSummaryQueryTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function loadSummaryHierarchyModule() {
  summaryHierarchyModulePromise ??= import("../summary/summaryHierarchy.js");
  return summaryHierarchyModulePromise;
}

function typedArrayBytes(arrays: readonly ArrayBufferView[]): number {
  let bytes = 0;
  for (const array of arrays) bytes += array.byteLength;
  return bytes;
}

function summaryTransferList(message: GridRuntimeSummaryReadyMessage): Transferable[] {
  const arrays: ArrayBufferView[] = [message.ranges, message.rowCounts, message.nullCounts];
  if (message.kind === "numeric") {
    arrays.push(
      message.finiteCounts,
      message.nanCounts,
      message.positiveInfinityCounts,
      message.negativeInfinityCounts,
      message.finiteMinimumValues,
      message.finiteMaximumValues,
      message.finiteMinimumViewOrdinals,
      message.finiteMaximumViewOrdinals,
    );
  } else {
    arrays.push(
      message.exemplarCounts,
      message.exemplarCodes,
      message.exemplarViewOrdinals,
      message.exemplarLabelIndexes,
      message.complete,
    );
  }
  const buffers = new Set<ArrayBuffer>();
  for (const array of arrays) {
    if (array.buffer instanceof ArrayBuffer) buffers.add(array.buffer);
  }
  return [...buffers];
}

function summaryBuildMetadata(summary: GridPublishedSummaryHierarchy | null) {
  if (!summary) {
    return {
      blockSize: SUMMARY_BLOCK_SIZE,
      columnCount: 0,
      buildDurationMs: 0,
      retainedBytes: 0,
      stagedReplacementPeakBytes: 0,
    } as const;
  }
  return {
    blockSize: SUMMARY_BLOCK_SIZE,
    columnCount: summary.buildStats.columns.length,
    buildDurationMs:
      runtimeSummaryBuildDurations.get(summary) ?? summary.buildStats.totalBuildDurationMs,
    retainedBytes: summary.retainedBytes,
    stagedReplacementPeakBytes: summary.buildStats.stagedReplacementPeakBytes,
  } as const;
}
