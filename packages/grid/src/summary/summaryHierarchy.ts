import {
  GridDataStore,
  type GridStagedCellPatch,
  type GridTypedColumnAccess,
} from "../data/store.js";
import type { RowId } from "../types.js";

const CATEGORY_WITNESS_LIMIT = 5;
const NO_PHYSICAL_ROW = 0xffff_ffff;
const DEFAULT_CHUNK_SIZE = 1_048_576;

export interface GridSummaryView {
  readonly datasetId: string;
  readonly viewRevision: number;
  readonly rowCount: number;
  /** Null is the canonical identity view and does not allocate a 4N permutation. */
  readonly physicalRows: Uint32Array | null;
}

export type GridSummaryBuildPhase = "leaves" | "merge";

export interface GridSummaryBuildProgress {
  readonly phase: GridSummaryBuildPhase;
  readonly completed: number;
  readonly total: number;
}

export interface GridSummaryBuildOptions {
  readonly requestId: number;
  readonly dataRevision: number;
  readonly columns: readonly string[];
  readonly blockSize: number;
  readonly stagedPatch?: GridStagedCellPatch;
  readonly shouldCancel?: () => boolean;
  readonly onProgress?: (progress: GridSummaryBuildProgress) => void;
  readonly previousRetainedBytes?: number;
}

export interface GridSummaryAsyncBuildOptions extends GridSummaryBuildOptions {
  readonly yieldControl?: () => Promise<void>;
  readonly chunkSize?: number;
}

export interface GridSummaryColumnBuildStats {
  readonly columnId: string;
  readonly kind: "numeric" | "category";
  readonly retainedBytes: number;
  readonly leafNodes: number;
  readonly interiorNodes: number;
}

export interface GridSummaryBuildStats {
  readonly startedAtMs: number;
  readonly candidateReadyAtMs: number;
  readonly leafBuildDurationMs: number;
  readonly mergeBuildDurationMs: number;
  readonly totalBuildDurationMs: number;
  readonly yieldCount: number;
  readonly retainedBytes: number;
  readonly previousRetainedBytes: number;
  readonly buildScratchBytes: number;
  readonly peakCandidateBytes: number;
  readonly stagedReplacementPeakBytes: number;
  readonly viewPermutationBytes: number;
  readonly columns: readonly GridSummaryColumnBuildStats[];
}

export interface GridSummaryExpectation {
  readonly datasetId: string;
  readonly requestId: number;
  readonly dataRevision: number;
  readonly viewRevision: number;
}

export interface GridNumericSummaryExemplar {
  readonly value: number;
  readonly viewOrdinal: number;
  readonly physicalRow: number;
  readonly rowId: RowId;
}

export interface GridCategorySummaryExemplar {
  readonly code: number;
  readonly label: string;
  readonly viewOrdinal: number;
  readonly physicalRow: number;
  readonly rowId: RowId;
}

export interface GridSummaryQueryStats {
  readonly nodeVisits: number;
  readonly rawRowsScanned: number;
  readonly summaryVertices: number;
}

interface GridSummaryQueryBase {
  readonly datasetId: string;
  readonly requestId: number;
  readonly dataRevision: number;
  readonly viewRevision: number;
  readonly columnId: string;
  readonly start: number;
  readonly end: number;
  readonly rowCount: number;
  readonly exact: true;
  readonly stats: GridSummaryQueryStats;
}

export interface GridNumericSummaryQueryResult extends GridSummaryQueryBase {
  readonly kind: "numeric";
  readonly nullCount: number;
  readonly finiteCount: number;
  readonly nanCount: number;
  readonly positiveInfinityCount: number;
  readonly negativeInfinityCount: number;
  readonly finiteMinimum: GridNumericSummaryExemplar | null;
  readonly finiteMaximum: GridNumericSummaryExemplar | null;
}

export interface GridCategorySummaryQueryResult extends GridSummaryQueryBase {
  readonly kind: "category";
  readonly nullCount: number;
  readonly exemplars: readonly GridCategorySummaryExemplar[];
  readonly complete: boolean;
  /** Internal fifth distinct witness proving that `complete` is false. */
  readonly overflowWitness: GridCategorySummaryExemplar | null;
}

export type GridSummaryQueryResult = GridNumericSummaryQueryResult | GridCategorySummaryQueryResult;

interface LevelGeometry {
  readonly counts: readonly number[];
  readonly offsets: readonly number[];
  readonly totalNodes: number;
  readonly leafNodes: number;
  readonly interiorNodes: number;
}

interface NumericColumnIndex {
  readonly kind: "numeric";
  readonly columnId: string;
  readonly access: Extract<GridTypedColumnAccess, { kind: "number" }>;
  readonly geometry: LevelGeometry;
  readonly nullCounts: Uint32Array;
  readonly finiteCounts: Uint32Array;
  readonly nanCounts: Uint32Array;
  readonly positiveInfinityCounts: Uint32Array;
  readonly negativeInfinityCounts: Uint32Array;
  readonly minima: Float64Array;
  readonly maxima: Float64Array;
  readonly minimumRows: Uint32Array;
  readonly maximumRows: Uint32Array;
  readonly minimumOrdinals: Uint32Array;
  readonly maximumOrdinals: Uint32Array;
  readonly retainedBytes: number;
}

interface CategoryColumnIndex {
  readonly kind: "category";
  readonly columnId: string;
  readonly access: Extract<GridTypedColumnAccess, { kind: "category" }>;
  readonly geometry: LevelGeometry;
  readonly nullCounts: Uint32Array;
  readonly witnessCounts: Uint8Array;
  readonly witnessCodes: Uint32Array;
  readonly witnessRows: Uint32Array;
  readonly witnessOrdinals: Uint32Array;
  readonly retainedBytes: number;
}

type SummaryColumnIndex = NumericColumnIndex | CategoryColumnIndex;

interface MutableNumericSummary {
  nullCount: number;
  finiteCount: number;
  nanCount: number;
  positiveInfinityCount: number;
  negativeInfinityCount: number;
  minimum: number;
  maximum: number;
  minimumRow: number;
  maximumRow: number;
  minimumOrdinal: number;
  maximumOrdinal: number;
}

interface MutableCategorySummary {
  nullCount: number;
  count: number;
  readonly codes: number[];
  readonly rows: number[];
  readonly ordinals: number[];
}

interface QueryWork {
  nodeVisits: number;
  rawRowsScanned: number;
}

interface BuildState {
  readonly store: GridDataStore;
  readonly view: GridSummaryView;
  readonly options: GridSummaryBuildOptions;
  readonly geometry: LevelGeometry;
  readonly total: number;
  readonly columns: SummaryColumnIndex[];
  readonly columnStats: GridSummaryColumnBuildStats[];
  completed: number;
  allocatedBytes: number;
  peakAllocatedBytes: number;
  leafBuildDurationMs: number;
  mergeBuildDurationMs: number;
  yieldCount: number;
}

export interface GridSummaryBuildCancelled {
  readonly status: "cancelled";
  readonly datasetId: string;
  readonly requestId: number;
  readonly dataRevision: number;
  readonly viewRevision: number;
  readonly retainedBytes: 0;
  readonly releasedCandidateBytes: number;
  readonly peakCandidateBytes: number;
  readonly stagedReplacementPeakBytes: number;
}

export interface GridSummaryBuildComplete {
  readonly status: "complete";
  readonly candidate: GridSummaryHierarchyCandidate;
}

export type GridSummaryBuildResult = GridSummaryBuildCancelled | GridSummaryBuildComplete;

class SummaryBuildCancelledError extends Error {
  constructor() {
    super("Grid summary build was cancelled.");
    this.name = "SummaryBuildCancelledError";
  }
}

abstract class GridSummaryHierarchyBase {
  declare readonly store: GridDataStore;
  declare readonly view: GridSummaryView;
  declare readonly columnIndexes: ReadonlyMap<string, SummaryColumnIndex>;
  declare readonly datasetId: string;
  declare readonly requestId: number;
  declare readonly dataRevision: number;
  declare readonly viewRevision: number;
  declare readonly rowCount: number;
  declare readonly blockSize: number;
  declare readonly retainedBytes: number;
  declare readonly buildStats: GridSummaryBuildStats;

  protected constructor(
    store: GridDataStore,
    view: GridSummaryView,
    columnIndexes: ReadonlyMap<string, SummaryColumnIndex>,
    identity: GridSummaryExpectation,
    blockSize: number,
    buildStats: GridSummaryBuildStats,
  ) {
    this.store = store;
    this.view = view;
    this.columnIndexes = columnIndexes;
    this.datasetId = identity.datasetId;
    this.requestId = identity.requestId;
    this.dataRevision = identity.dataRevision;
    this.viewRevision = identity.viewRevision;
    this.rowCount = view.rowCount;
    this.blockSize = blockSize;
    this.retainedBytes = buildStats.retainedBytes;
    this.buildStats = buildStats;
  }

  query(
    columnId: string,
    start: number,
    end: number,
    expected?: GridSummaryExpectation,
  ): GridSummaryQueryResult {
    if (expected) this.assertExpected(expected);
    if (this.store.datasetId !== this.datasetId) {
      throw new Error("The Grid summary hierarchy's dataset is no longer installed.");
    }
    assertRange(start, end, this.rowCount);
    const column = this.columnIndexes.get(columnId);
    if (!column) throw new RangeError(`Column ${columnId} is not indexed by this hierarchy.`);
    return column.kind === "numeric"
      ? this.queryNumeric(column, start, end)
      : this.queryCategory(column, start, end);
  }

  private assertExpected(expected: GridSummaryExpectation): void {
    if (
      expected.datasetId !== this.datasetId ||
      expected.requestId !== this.requestId ||
      expected.dataRevision !== this.dataRevision ||
      expected.viewRevision !== this.viewRevision
    ) {
      throw new Error("The Grid summary query expectation is stale.");
    }
  }

  private queryNumeric(
    column: NumericColumnIndex,
    start: number,
    end: number,
  ): GridNumericSummaryQueryResult {
    const work: QueryWork = { nodeVisits: 0, rawRowsScanned: 0 };
    const summary = queryNumericRange(column, this.view, this.blockSize, start, end, work);
    const finiteMinimum =
      summary.minimumRow === NO_PHYSICAL_ROW
        ? null
        : {
            value: summary.minimum,
            viewOrdinal: summary.minimumOrdinal,
            physicalRow: summary.minimumRow,
            rowId: this.store.rowIdAt(summary.minimumRow),
          };
    const finiteMaximum =
      summary.maximumRow === NO_PHYSICAL_ROW
        ? null
        : {
            value: summary.maximum,
            viewOrdinal: summary.maximumOrdinal,
            physicalRow: summary.maximumRow,
            rowId: this.store.rowIdAt(summary.maximumRow),
          };
    return {
      kind: "numeric",
      datasetId: this.datasetId,
      requestId: this.requestId,
      dataRevision: this.dataRevision,
      viewRevision: this.viewRevision,
      columnId: column.columnId,
      start,
      end,
      rowCount: end - start,
      exact: true,
      nullCount: summary.nullCount,
      finiteCount: summary.finiteCount,
      nanCount: summary.nanCount,
      positiveInfinityCount: summary.positiveInfinityCount,
      negativeInfinityCount: summary.negativeInfinityCount,
      finiteMinimum,
      finiteMaximum,
      stats: {
        ...work,
        summaryVertices: (finiteMinimum ? 1 : 0) + (finiteMaximum ? 1 : 0),
      },
    };
  }

  private queryCategory(
    column: CategoryColumnIndex,
    start: number,
    end: number,
  ): GridCategorySummaryQueryResult {
    const work: QueryWork = { nodeVisits: 0, rawRowsScanned: 0 };
    const summary = queryCategoryRange(column, this.view, this.blockSize, start, end, work);
    const witnesses = summary.codes.map((code, index) => ({
      code,
      label: column.access.dictionary[code]!,
      viewOrdinal: summary.ordinals[index]!,
      physicalRow: summary.rows[index]!,
      rowId: this.store.rowIdAt(summary.rows[index]!),
    }));
    const exemplars = witnesses.slice(0, CATEGORY_WITNESS_LIMIT - 1);
    const overflowWitness = witnesses.length === CATEGORY_WITNESS_LIMIT ? witnesses[4]! : null;
    return {
      kind: "category",
      datasetId: this.datasetId,
      requestId: this.requestId,
      dataRevision: this.dataRevision,
      viewRevision: this.viewRevision,
      columnId: column.columnId,
      start,
      end,
      rowCount: end - start,
      exact: true,
      nullCount: summary.nullCount,
      exemplars,
      complete: overflowWitness === null,
      overflowWitness,
      stats: { ...work, summaryVertices: exemplars.length },
    };
  }
}

export class GridSummaryHierarchyCandidate extends GridSummaryHierarchyBase {
  constructor(
    store: GridDataStore,
    view: GridSummaryView,
    columns: ReadonlyMap<string, SummaryColumnIndex>,
    identity: GridSummaryExpectation,
    blockSize: number,
    buildStats: GridSummaryBuildStats,
  ) {
    super(store, view, columns, identity, blockSize, buildStats);
  }
}

export class GridPublishedSummaryHierarchy extends GridSummaryHierarchyBase {
  declare readonly publishedAtMs: number;
  declare readonly readyToPublishedMs: number;

  constructor(candidate: GridSummaryHierarchyCandidate, publishedAtMs: number) {
    super(
      candidate.store,
      candidate.view,
      candidate.columnIndexes,
      candidate,
      candidate.blockSize,
      candidate.buildStats,
    );
    this.publishedAtMs = publishedAtMs;
    this.readyToPublishedMs = Math.max(0, publishedAtMs - candidate.buildStats.candidateReadyAtMs);
  }
}

export function publishGridSummaryHierarchyCandidate(
  candidate: GridSummaryHierarchyCandidate,
  expected: GridSummaryExpectation,
): GridPublishedSummaryHierarchy | null {
  if (
    candidate.datasetId !== expected.datasetId ||
    candidate.requestId !== expected.requestId ||
    candidate.dataRevision !== expected.dataRevision ||
    candidate.viewRevision !== expected.viewRevision
  ) {
    return null;
  }
  return new GridPublishedSummaryHierarchy(candidate, performance.now());
}

export async function buildGridSummaryHierarchyAsync(
  store: GridDataStore,
  view: GridSummaryView,
  options: GridSummaryAsyncBuildOptions,
): Promise<GridSummaryBuildResult> {
  const startedAt = performance.now();
  const state = createBuildState(store, view, options);
  const chunkSize = positiveInteger(options.chunkSize ?? DEFAULT_CHUNK_SIZE, "chunkSize");
  const yieldControl = options.yieldControl ?? yieldToEventLoop;
  let nextCheckpoint = chunkSize;
  const checkpoint = async (phase: GridSummaryBuildPhase, force = false): Promise<void> => {
    if (!force && state.completed < nextCheckpoint) return;
    pollCancellation(options);
    options.onProgress?.({ phase, completed: state.completed, total: state.total });
    state.yieldCount++;
    await yieldControl();
    pollCancellation(options);
    nextCheckpoint = state.completed + chunkSize;
  };

  try {
    for (const columnId of options.columns) {
      pollCancellation(options);
      const built = allocateColumn(store, columnId, state.geometry, options.stagedPatch);
      state.allocatedBytes += built.retainedBytes;
      state.peakAllocatedBytes = Math.max(state.peakAllocatedBytes, state.allocatedBytes);

      const leavesStartedAt = performance.now();
      const blockSize = options.blockSize;
      const leafCount = built.geometry.leafNodes;
      for (let block = 0; block < leafCount; block++) {
        const start = block * blockSize;
        const end = Math.min(view.rowCount, start + blockSize);
        buildLeaf(built, view, block, start, end);
        state.completed += end - start;
        if (state.completed >= nextCheckpoint) await checkpoint("leaves");
      }
      state.leafBuildDurationMs += performance.now() - leavesStartedAt;
      await checkpoint("leaves", true);

      const mergeStartedAt = performance.now();
      for (let level = 1; level < built.geometry.counts.length; level++) {
        const count = built.geometry.counts[level]!;
        for (let node = 0; node < count; node++) {
          mergeTreeNode(built, level, node);
          state.completed++;
          if (state.completed >= nextCheckpoint) await checkpoint("merge");
        }
      }
      state.mergeBuildDurationMs += performance.now() - mergeStartedAt;
      await checkpoint("merge", true);
      state.columns.push(built);
      state.columnStats.push(columnStats(built));
    }
    return completeBuild(state, startedAt);
  } catch (error) {
    if (!(error instanceof SummaryBuildCancelledError)) throw error;
    return cancelledBuild(state);
  }
}

function createBuildState(
  store: GridDataStore,
  view: GridSummaryView,
  options: GridSummaryBuildOptions,
): BuildState {
  const datasetId = store.datasetId;
  if (!datasetId || datasetId !== view.datasetId) {
    throw new Error("The Grid summary view does not match the installed dataset.");
  }
  if (view.rowCount < 0 || view.rowCount > store.rowCount || !Number.isSafeInteger(view.rowCount)) {
    throw new RangeError("The Grid summary view row count is invalid.");
  }
  if (view.physicalRows === null && view.rowCount !== store.rowCount) {
    throw new RangeError("A Grid summary identity view must represent the complete dataset.");
  }
  if (view.physicalRows && view.physicalRows.length !== view.rowCount) {
    throw new RangeError("The Grid summary view permutation length is invalid.");
  }
  const blockSize = positiveInteger(options.blockSize, "blockSize");
  positiveInteger(options.requestId, "requestId");
  nonNegativeInteger(options.dataRevision, "dataRevision");
  nonNegativeInteger(view.viewRevision, "viewRevision");
  nonNegativeInteger(options.previousRetainedBytes ?? 0, "previousRetainedBytes");
  if (options.columns.length === 0 || new Set(options.columns).size !== options.columns.length) {
    throw new TypeError("Grid summary columns must be unique and non-empty.");
  }
  const geometry = levelGeometry(view.rowCount, blockSize);
  return {
    store,
    view,
    options,
    geometry,
    total: options.columns.length * (view.rowCount + geometry.interiorNodes),
    columns: [],
    columnStats: [],
    completed: 0,
    allocatedBytes: 0,
    peakAllocatedBytes: 0,
    leafBuildDurationMs: 0,
    mergeBuildDurationMs: 0,
    yieldCount: 0,
  };
}

function allocateColumn(
  store: GridDataStore,
  columnId: string,
  geometry: LevelGeometry,
  stagedPatch: GridStagedCellPatch | undefined,
): SummaryColumnIndex {
  const access = store.typedColumnAt(columnId, stagedPatch);
  if (!access) throw new TypeError(`Grid summary column ${columnId} has no typed summary path.`);
  const nodes = geometry.totalNodes;
  if (access.kind === "number") {
    const nullCounts = new Uint32Array(nodes);
    const finiteCounts = new Uint32Array(nodes);
    const nanCounts = new Uint32Array(nodes);
    const positiveInfinityCounts = new Uint32Array(nodes);
    const negativeInfinityCounts = new Uint32Array(nodes);
    const minima = new Float64Array(nodes);
    const maxima = new Float64Array(nodes);
    const minimumRows = new Uint32Array(nodes);
    const maximumRows = new Uint32Array(nodes);
    const minimumOrdinals = new Uint32Array(nodes);
    const maximumOrdinals = new Uint32Array(nodes);
    minimumRows.fill(NO_PHYSICAL_ROW);
    maximumRows.fill(NO_PHYSICAL_ROW);
    minimumOrdinals.fill(NO_PHYSICAL_ROW);
    maximumOrdinals.fill(NO_PHYSICAL_ROW);
    const retainedBytes = byteLength([
      nullCounts,
      finiteCounts,
      nanCounts,
      positiveInfinityCounts,
      negativeInfinityCounts,
      minima,
      maxima,
      minimumRows,
      maximumRows,
      minimumOrdinals,
      maximumOrdinals,
    ]);
    return {
      kind: "numeric",
      columnId,
      access,
      geometry,
      nullCounts,
      finiteCounts,
      nanCounts,
      positiveInfinityCounts,
      negativeInfinityCounts,
      minima,
      maxima,
      minimumRows,
      maximumRows,
      minimumOrdinals,
      maximumOrdinals,
      retainedBytes,
    };
  }
  if (access.kind === "category") {
    const nullCounts = new Uint32Array(nodes);
    const witnessCounts = new Uint8Array(nodes);
    const witnessCodes = new Uint32Array(nodes * CATEGORY_WITNESS_LIMIT);
    const witnessRows = new Uint32Array(nodes * CATEGORY_WITNESS_LIMIT);
    const witnessOrdinals = new Uint32Array(nodes * CATEGORY_WITNESS_LIMIT);
    const retainedBytes = byteLength([
      nullCounts,
      witnessCounts,
      witnessCodes,
      witnessRows,
      witnessOrdinals,
    ]);
    return {
      kind: "category",
      columnId,
      access,
      geometry,
      nullCounts,
      witnessCounts,
      witnessCodes,
      witnessRows,
      witnessOrdinals,
      retainedBytes,
    };
  }
  throw new TypeError(`Grid summary column ${columnId} is not numeric or categorical.`);
}

function buildLeaf(
  column: SummaryColumnIndex,
  view: GridSummaryView,
  node: number,
  start: number,
  end: number,
): void {
  if (column.kind === "numeric") {
    const summary = scanNumeric(column.access, view, start, end);
    writeNumeric(column, node, summary);
  } else {
    const summary = scanCategory(column.access, view, start, end);
    writeCategory(column, node, summary);
  }
}

function mergeTreeNode(column: SummaryColumnIndex, level: number, node: number): void {
  const childCount = column.geometry.counts[level - 1]!;
  const left = node * 2;
  const right = left + 1;
  if (column.kind === "numeric") {
    const summary = readNumericNode(column, level - 1, left);
    if (right < childCount) mergeNumeric(summary, readNumericNode(column, level - 1, right));
    writeNumeric(column, nodeIndex(column.geometry, level, node), summary);
  } else {
    const summary = readCategoryNode(column, level - 1, left);
    if (right < childCount) mergeCategory(summary, readCategoryNode(column, level - 1, right));
    writeCategory(column, nodeIndex(column.geometry, level, node), summary);
  }
}

function completeBuild(state: BuildState, startedAt: number): GridSummaryBuildComplete {
  const candidateReadyAtMs = performance.now();
  const retainedBytes = state.columns.reduce((sum, column) => sum + column.retainedBytes, 0);
  const previousRetainedBytes = state.options.previousRetainedBytes ?? 0;
  const buildStats: GridSummaryBuildStats = {
    startedAtMs: startedAt,
    candidateReadyAtMs,
    leafBuildDurationMs: state.leafBuildDurationMs,
    mergeBuildDurationMs: state.mergeBuildDurationMs,
    totalBuildDurationMs: Math.max(0, candidateReadyAtMs - startedAt),
    yieldCount: state.yieldCount,
    retainedBytes,
    previousRetainedBytes,
    buildScratchBytes: 0,
    peakCandidateBytes: state.peakAllocatedBytes,
    stagedReplacementPeakBytes: previousRetainedBytes + state.peakAllocatedBytes,
    viewPermutationBytes: state.view.physicalRows?.byteLength ?? 0,
    columns: Object.freeze([...state.columnStats]),
  };
  const columns = new Map(state.columns.map((column) => [column.columnId, column]));
  return {
    status: "complete",
    candidate: new GridSummaryHierarchyCandidate(
      state.store,
      state.view,
      columns,
      {
        datasetId: state.view.datasetId,
        requestId: state.options.requestId,
        dataRevision: state.options.dataRevision,
        viewRevision: state.view.viewRevision,
      },
      state.options.blockSize,
      buildStats,
    ),
  };
}

function cancelledBuild(state: BuildState): GridSummaryBuildCancelled {
  const previous = state.options.previousRetainedBytes ?? 0;
  return {
    status: "cancelled",
    datasetId: state.view.datasetId,
    requestId: state.options.requestId,
    dataRevision: state.options.dataRevision,
    viewRevision: state.view.viewRevision,
    retainedBytes: 0,
    releasedCandidateBytes: state.allocatedBytes,
    peakCandidateBytes: state.peakAllocatedBytes,
    stagedReplacementPeakBytes: previous + state.peakAllocatedBytes,
  };
}

function columnStats(column: SummaryColumnIndex): GridSummaryColumnBuildStats {
  return {
    columnId: column.columnId,
    kind: column.kind,
    retainedBytes: column.retainedBytes,
    leafNodes: column.geometry.leafNodes,
    interiorNodes: column.geometry.interiorNodes,
  };
}

function scanNumeric(
  access: Extract<GridTypedColumnAccess, { kind: "number" }>,
  view: GridSummaryView,
  start: number,
  end: number,
): MutableNumericSummary {
  const rows = view.physicalRows;
  const overrides = access.overrides;
  if (rows !== null && overrides === undefined) {
    return scanNumericPermutedUnpatched(access, rows, start, end);
  }

  const result = emptyNumeric();
  const validity = access.validity;
  for (let ordinal = start; ordinal < end; ordinal++) {
    const physical = rows ? rows[ordinal]! : ordinal;
    let value: number | null;
    if (overrides?.has(physical)) {
      const override = overrides.get(physical);
      if (override !== null && typeof override !== "number") {
        throw new TypeError("A numeric Grid summary override must be a number or null.");
      }
      value = override ?? null;
    } else if (validity && !readBit(validity.bits, validity.bitOffset, physical)) {
      value = null;
    } else {
      value = access.values[physical]!;
    }
    addNumeric(result, value, physical, ordinal);
  }
  return result;
}

/**
 * Full-sort and filtered-sort replacement builds have a dense active-view
 * permutation but overwhelmingly no sparse edits. Keeping that case out of
 * the generic override loop removes two polymorphic branches and the helper
 * call for every gathered cell without allocating a reordered value buffer.
 */
function scanNumericPermutedUnpatched(
  access: Extract<GridTypedColumnAccess, { kind: "number" }>,
  rows: Uint32Array,
  start: number,
  end: number,
): MutableNumericSummary {
  const values = access.values;
  let nullCount = 0;
  let finiteCount = 0;
  let nanCount = 0;
  let positiveInfinityCount = 0;
  let negativeInfinityCount = 0;
  let minimum = 0;
  let maximum = 0;
  let minimumRow = NO_PHYSICAL_ROW;
  let maximumRow = NO_PHYSICAL_ROW;
  let minimumOrdinal = NO_PHYSICAL_ROW;
  let maximumOrdinal = NO_PHYSICAL_ROW;

  const validity = access.validity;
  if (validity) {
    const bits = validity.bits;
    const bitOffset = validity.bitOffset;
    for (let ordinal = start; ordinal < end; ordinal++) {
      const physical = rows[ordinal]!;
      const absolute = bitOffset + physical;
      if ((bits[absolute >>> 3]! & (1 << (absolute & 7))) === 0) {
        nullCount++;
        continue;
      }
      const value = values[physical]!;
      if (value !== value) {
        nanCount++;
      } else if (value === Number.POSITIVE_INFINITY) {
        positiveInfinityCount++;
      } else if (value === Number.NEGATIVE_INFINITY) {
        negativeInfinityCount++;
      } else {
        finiteCount++;
        if (minimumRow === NO_PHYSICAL_ROW || value < minimum) {
          minimum = value;
          minimumRow = physical;
          minimumOrdinal = ordinal;
        }
        if (maximumRow === NO_PHYSICAL_ROW || value > maximum) {
          maximum = value;
          maximumRow = physical;
          maximumOrdinal = ordinal;
        }
      }
    }
  } else {
    for (let ordinal = start; ordinal < end; ordinal++) {
      const physical = rows[ordinal]!;
      const value = values[physical]!;
      if (value !== value) {
        nanCount++;
      } else if (value === Number.POSITIVE_INFINITY) {
        positiveInfinityCount++;
      } else if (value === Number.NEGATIVE_INFINITY) {
        negativeInfinityCount++;
      } else {
        finiteCount++;
        if (minimumRow === NO_PHYSICAL_ROW || value < minimum) {
          minimum = value;
          minimumRow = physical;
          minimumOrdinal = ordinal;
        }
        if (maximumRow === NO_PHYSICAL_ROW || value > maximum) {
          maximum = value;
          maximumRow = physical;
          maximumOrdinal = ordinal;
        }
      }
    }
  }

  return {
    nullCount,
    finiteCount,
    nanCount,
    positiveInfinityCount,
    negativeInfinityCount,
    minimum,
    maximum,
    minimumRow,
    maximumRow,
    minimumOrdinal,
    maximumOrdinal,
  };
}

function addNumeric(
  summary: MutableNumericSummary,
  value: number | null,
  physical: number,
  ordinal: number,
): void {
  if (value === null) {
    summary.nullCount++;
  } else if (Number.isNaN(value)) {
    summary.nanCount++;
  } else if (value === Number.POSITIVE_INFINITY) {
    summary.positiveInfinityCount++;
  } else if (value === Number.NEGATIVE_INFINITY) {
    summary.negativeInfinityCount++;
  } else {
    summary.finiteCount++;
    if (summary.minimumRow === NO_PHYSICAL_ROW || value < summary.minimum) {
      summary.minimum = value;
      summary.minimumRow = physical;
      summary.minimumOrdinal = ordinal;
    }
    if (summary.maximumRow === NO_PHYSICAL_ROW || value > summary.maximum) {
      summary.maximum = value;
      summary.maximumRow = physical;
      summary.maximumOrdinal = ordinal;
    }
  }
}

function scanCategory(
  access: Extract<GridTypedColumnAccess, { kind: "category" }>,
  view: GridSummaryView,
  start: number,
  end: number,
): MutableCategorySummary {
  const rows = view.physicalRows;
  const overrides = access.overrides;
  if (rows !== null && overrides === undefined) {
    return scanCategoryPermutedUnpatched(access, rows, start, end);
  }

  const result = emptyCategory();
  const validity = access.validity;
  for (let ordinal = start; ordinal < end; ordinal++) {
    const physical = rows ? rows[ordinal]! : ordinal;
    let code: number | null;
    if (overrides?.has(physical)) {
      const value = overrides.get(physical);
      if (value === null) {
        code = null;
      } else if (typeof value !== "string") {
        throw new TypeError("A categorical Grid summary override must be a label or null.");
      } else {
        const overrideCode = access.codeByValue.get(value);
        if (overrideCode === undefined) {
          throw new RangeError("A categorical Grid summary override is outside the dictionary.");
        }
        code = overrideCode;
      }
    } else if (validity && !readBit(validity.bits, validity.bitOffset, physical)) {
      code = null;
    } else {
      code = Number(access.codes[physical]!);
    }
    if (code === null) result.nullCount++;
    else appendCategory(result, code, physical, ordinal);
  }
  return result;
}

function scanCategoryPermutedUnpatched(
  access: Extract<GridTypedColumnAccess, { kind: "category" }>,
  rows: Uint32Array,
  start: number,
  end: number,
): MutableCategorySummary {
  const codes = access.codes;
  const witnessCodes: number[] = [];
  const witnessRows: number[] = [];
  const witnessOrdinals: number[] = [];
  let count = 0;
  let nullCount = 0;

  const validity = access.validity;
  if (validity) {
    const bits = validity.bits;
    const bitOffset = validity.bitOffset;
    for (let ordinal = start; ordinal < end; ordinal++) {
      const physical = rows[ordinal]!;
      const absolute = bitOffset + physical;
      if ((bits[absolute >>> 3]! & (1 << (absolute & 7))) === 0) {
        nullCount++;
        continue;
      }
      // Witnesses are bounded, but the validity scan must continue so the
      // block's null count remains exact.
      if (count === CATEGORY_WITNESS_LIMIT) continue;
      const code = Number(codes[physical]!);
      if (
        code !== witnessCodes[0] &&
        code !== witnessCodes[1] &&
        code !== witnessCodes[2] &&
        code !== witnessCodes[3] &&
        code !== witnessCodes[4]
      ) {
        witnessCodes[count] = code;
        witnessRows[count] = physical;
        witnessOrdinals[count] = ordinal;
        count++;
      }
    }
  } else {
    for (let ordinal = start; ordinal < end; ordinal++) {
      const physical = rows[ordinal]!;
      const code = Number(codes[physical]!);
      if (
        code !== witnessCodes[0] &&
        code !== witnessCodes[1] &&
        code !== witnessCodes[2] &&
        code !== witnessCodes[3] &&
        code !== witnessCodes[4]
      ) {
        witnessCodes[count] = code;
        witnessRows[count] = physical;
        witnessOrdinals[count] = ordinal;
        count++;
        if (count === CATEGORY_WITNESS_LIMIT) break;
      }
    }
  }

  return {
    nullCount,
    count,
    codes: witnessCodes,
    rows: witnessRows,
    ordinals: witnessOrdinals,
  };
}

function appendCategory(
  summary: MutableCategorySummary,
  code: number,
  physical: number,
  ordinal: number,
): void {
  for (let index = 0; index < summary.count; index++) {
    if (summary.codes[index] === code) return;
  }
  if (summary.count === CATEGORY_WITNESS_LIMIT) return;
  summary.codes.push(code);
  summary.rows.push(physical);
  summary.ordinals.push(ordinal);
  summary.count++;
}

function mergeNumeric(target: MutableNumericSummary, source: MutableNumericSummary): void {
  target.nullCount += source.nullCount;
  target.finiteCount += source.finiteCount;
  target.nanCount += source.nanCount;
  target.positiveInfinityCount += source.positiveInfinityCount;
  target.negativeInfinityCount += source.negativeInfinityCount;
  if (source.minimumRow !== NO_PHYSICAL_ROW) {
    if (target.minimumRow === NO_PHYSICAL_ROW || source.minimum < target.minimum) {
      target.minimum = source.minimum;
      target.minimumRow = source.minimumRow;
      target.minimumOrdinal = source.minimumOrdinal;
    }
  }
  if (source.maximumRow !== NO_PHYSICAL_ROW) {
    if (target.maximumRow === NO_PHYSICAL_ROW || source.maximum > target.maximum) {
      target.maximum = source.maximum;
      target.maximumRow = source.maximumRow;
      target.maximumOrdinal = source.maximumOrdinal;
    }
  }
}

function mergeCategory(target: MutableCategorySummary, source: MutableCategorySummary): void {
  target.nullCount += source.nullCount;
  for (let index = 0; index < source.count; index++) {
    appendCategory(target, source.codes[index]!, source.rows[index]!, source.ordinals[index]!);
  }
}

function queryNumericRange(
  column: NumericColumnIndex,
  view: GridSummaryView,
  blockSize: number,
  start: number,
  end: number,
  work: QueryWork,
): MutableNumericSummary {
  const fullStart = Math.ceil(start / blockSize) * blockSize;
  const fullEnd = Math.floor(end / blockSize) * blockSize;
  if (fullStart >= fullEnd) {
    work.rawRowsScanned += end - start;
    return scanNumeric(column.access, view, start, end);
  }
  const result = scanNumeric(column.access, view, start, fullStart);
  work.rawRowsScanned += fullStart - start;
  mergeWholeNumericBlocks(column, result, fullStart / blockSize, fullEnd / blockSize, work);
  const right = scanNumeric(column.access, view, fullEnd, end);
  work.rawRowsScanned += end - fullEnd;
  mergeNumeric(result, right);
  return result;
}

function mergeWholeNumericBlocks(
  column: NumericColumnIndex,
  target: MutableNumericSummary,
  blockStart: number,
  blockEnd: number,
  work: QueryWork,
): void {
  const left: MutableNumericSummary[] = [];
  const right: MutableNumericSummary[] = [];
  let lo = blockStart;
  let hi = blockEnd;
  let level = 0;
  while (lo < hi) {
    if (lo & 1) left.push(readNumericNode(column, level, lo++));
    if (hi & 1) right.push(readNumericNode(column, level, --hi));
    lo >>>= 1;
    hi >>>= 1;
    level++;
  }
  work.nodeVisits += left.length + right.length;
  for (const node of left) mergeNumeric(target, node);
  for (let index = right.length - 1; index >= 0; index--) mergeNumeric(target, right[index]!);
}

function queryCategoryRange(
  column: CategoryColumnIndex,
  view: GridSummaryView,
  blockSize: number,
  start: number,
  end: number,
  work: QueryWork,
): MutableCategorySummary {
  const fullStart = Math.ceil(start / blockSize) * blockSize;
  const fullEnd = Math.floor(end / blockSize) * blockSize;
  if (fullStart >= fullEnd) {
    work.rawRowsScanned += end - start;
    return scanCategory(column.access, view, start, end);
  }
  const result = scanCategory(column.access, view, start, fullStart);
  work.rawRowsScanned += fullStart - start;
  mergeWholeCategoryBlocks(column, result, fullStart / blockSize, fullEnd / blockSize, work);
  const right = scanCategory(column.access, view, fullEnd, end);
  work.rawRowsScanned += end - fullEnd;
  mergeCategory(result, right);
  return result;
}

function mergeWholeCategoryBlocks(
  column: CategoryColumnIndex,
  target: MutableCategorySummary,
  blockStart: number,
  blockEnd: number,
  work: QueryWork,
): void {
  const left: MutableCategorySummary[] = [];
  const right: MutableCategorySummary[] = [];
  let lo = blockStart;
  let hi = blockEnd;
  let level = 0;
  while (lo < hi) {
    if (lo & 1) left.push(readCategoryNode(column, level, lo++));
    if (hi & 1) right.push(readCategoryNode(column, level, --hi));
    lo >>>= 1;
    hi >>>= 1;
    level++;
  }
  work.nodeVisits += left.length + right.length;
  for (const node of left) mergeCategory(target, node);
  for (let index = right.length - 1; index >= 0; index--) mergeCategory(target, right[index]!);
}

function readNumericNode(
  column: NumericColumnIndex,
  level: number,
  node: number,
): MutableNumericSummary {
  const index = nodeIndex(column.geometry, level, node);
  return {
    nullCount: column.nullCounts[index]!,
    finiteCount: column.finiteCounts[index]!,
    nanCount: column.nanCounts[index]!,
    positiveInfinityCount: column.positiveInfinityCounts[index]!,
    negativeInfinityCount: column.negativeInfinityCounts[index]!,
    minimum: column.minima[index]!,
    maximum: column.maxima[index]!,
    minimumRow: column.minimumRows[index]!,
    maximumRow: column.maximumRows[index]!,
    minimumOrdinal: column.minimumOrdinals[index]!,
    maximumOrdinal: column.maximumOrdinals[index]!,
  };
}

function writeNumeric(
  column: NumericColumnIndex,
  index: number,
  summary: MutableNumericSummary,
): void {
  column.nullCounts[index] = summary.nullCount;
  column.finiteCounts[index] = summary.finiteCount;
  column.nanCounts[index] = summary.nanCount;
  column.positiveInfinityCounts[index] = summary.positiveInfinityCount;
  column.negativeInfinityCounts[index] = summary.negativeInfinityCount;
  column.minima[index] = summary.minimum;
  column.maxima[index] = summary.maximum;
  column.minimumRows[index] = summary.minimumRow;
  column.maximumRows[index] = summary.maximumRow;
  column.minimumOrdinals[index] = summary.minimumOrdinal;
  column.maximumOrdinals[index] = summary.maximumOrdinal;
}

function readCategoryNode(
  column: CategoryColumnIndex,
  level: number,
  node: number,
): MutableCategorySummary {
  const index = nodeIndex(column.geometry, level, node);
  const count = column.witnessCounts[index]!;
  const offset = index * CATEGORY_WITNESS_LIMIT;
  const summary = emptyCategory();
  summary.nullCount = column.nullCounts[index]!;
  for (let witness = 0; witness < count; witness++) {
    summary.codes.push(column.witnessCodes[offset + witness]!);
    summary.rows.push(column.witnessRows[offset + witness]!);
    summary.ordinals.push(column.witnessOrdinals[offset + witness]!);
  }
  summary.count = count;
  return summary;
}

function writeCategory(
  column: CategoryColumnIndex,
  index: number,
  summary: MutableCategorySummary,
): void {
  column.nullCounts[index] = summary.nullCount;
  column.witnessCounts[index] = summary.count;
  const offset = index * CATEGORY_WITNESS_LIMIT;
  for (let witness = 0; witness < summary.count; witness++) {
    column.witnessCodes[offset + witness] = summary.codes[witness]!;
    column.witnessRows[offset + witness] = summary.rows[witness]!;
    column.witnessOrdinals[offset + witness] = summary.ordinals[witness]!;
  }
}

function emptyNumeric(): MutableNumericSummary {
  return {
    nullCount: 0,
    finiteCount: 0,
    nanCount: 0,
    positiveInfinityCount: 0,
    negativeInfinityCount: 0,
    minimum: 0,
    maximum: 0,
    minimumRow: NO_PHYSICAL_ROW,
    maximumRow: NO_PHYSICAL_ROW,
    minimumOrdinal: NO_PHYSICAL_ROW,
    maximumOrdinal: NO_PHYSICAL_ROW,
  };
}

function emptyCategory(): MutableCategorySummary {
  return { nullCount: 0, count: 0, codes: [], rows: [], ordinals: [] };
}

function levelGeometry(rowCount: number, blockSize: number): LevelGeometry {
  const counts: number[] = [];
  const offsets: number[] = [];
  let count = Math.ceil(rowCount / blockSize);
  let total = 0;
  if (count > 0) {
    while (true) {
      offsets.push(total);
      counts.push(count);
      total += count;
      if (count === 1) break;
      count = Math.ceil(count / 2);
    }
  }
  const leafNodes = counts[0] ?? 0;
  return {
    counts: Object.freeze(counts),
    offsets: Object.freeze(offsets),
    totalNodes: total,
    leafNodes,
    interiorNodes: total - leafNodes,
  };
}

function nodeIndex(geometry: LevelGeometry, level: number, node: number): number {
  const count = geometry.counts[level];
  if (count === undefined || node < 0 || node >= count) {
    throw new RangeError("Grid summary tree node is out of bounds.");
  }
  return geometry.offsets[level]! + node;
}

function readBit(bytes: Uint8Array, bitOffset: number, row: number): boolean {
  const absolute = bitOffset + row;
  return (bytes[absolute >>> 3]! & (1 << (absolute & 7))) !== 0;
}

function pollCancellation(options: GridSummaryBuildOptions): void {
  if (options.shouldCancel?.()) throw new SummaryBuildCancelledError();
}

function assertRange(start: number, end: number, rowCount: number): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > rowCount
  ) {
    throw new RangeError(`Grid summary range [${start}, ${end}) is outside [0, ${rowCount}).`);
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Grid summary ${label} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Grid summary ${label} must be a non-negative safe integer.`);
  }
  return value;
}

function byteLength(arrays: readonly ArrayBufferView[]): number {
  return arrays.reduce((total, array) => total + array.byteLength, 0);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
