import { GridDataStore } from "../data/store.js";
import type {
  CellScalar,
  CellScalarType,
  GridFilter,
  GridSort,
  GridViewSpec,
  RowId,
} from "../types.js";
import {
  assertCompatibleFilterScalar,
  matchesFilterBetween,
  matchesFilterComparison,
} from "./filterSemantics.js";
import {
  filterTypedColumnAsync,
  stableTypedRadixSortRowsAsync,
  TypedViewKernelCancelledError,
  type TypedViewKernelColumn,
  type TypedViewKernelFilter,
  type TypedViewKernelProgress,
  type TypedViewKernelSortKey,
} from "./typedViewKernels.js";
import { yieldWorkerTurn } from "./yieldWorkerTurn.js";

const UINT32_NOT_VISIBLE = 0xffff_ffff;
// A 1M-row task keeps cancellation comfortably below the 50 ms experimental
// gate during an active radix pass while avoiding timer-clamp overhead on the
// 10M profile. The benchmark records this cadence explicitly.
const DEFAULT_ASYNC_CHUNK_SIZE = 1_048_576;
const BUILD_CANCELLED = Symbol("grid-view-build-cancelled");

export type GridViewBuildPhase = "filter" | "sort";
export type GridViewKernelPreference = "auto" | "generic" | "typed";
export type GridViewKernelKind = "generic" | "typed" | "hybrid";

export interface GridViewBuildProgress {
  readonly phase: GridViewBuildPhase;
  readonly completed: number;
  readonly total: number;
}

export interface GridViewBuildOptions {
  /** Opaque caller-owned identity used to reject a superseded result. */
  readonly requestId: number;
  /** Monotonic revision reserved for this candidate. */
  readonly viewRevision: number;
  /**
   * Polled during filtering and sorting. In a worker this may read an atomic
   * cancellation token so a newer request can supersede in-flight work.
   */
  readonly shouldCancel?: () => boolean;
  readonly onProgress?: (progress: GridViewBuildProgress) => void;
  /** Internal diagnostics/benchmark selector. Production uses `auto`. */
  readonly kernel?: GridViewKernelPreference;
}

/** Worker-oriented build options that make long filter/sort jobs interruptible. */
export interface GridViewAsyncBuildOptions extends GridViewBuildOptions {
  /** Test hook; production builds yield with a zero-delay task. */
  readonly yieldControl?: () => Promise<void>;
  /** Test/benchmark hook. Production defaults to 1,048,576 processed rows. */
  readonly chunkSize?: number;
}

export interface GridViewPublicationExpectation {
  readonly datasetId: string;
  readonly requestId: number;
  readonly viewRevision: number;
}

export interface GridViewBuildCancelled {
  readonly status: "cancelled";
  readonly datasetId: string;
  readonly requestId: number;
  readonly viewRevision: number;
}

export interface GridViewBuildComplete {
  readonly status: "complete";
  /** The implementation path that actually produced this candidate. */
  readonly kernel: GridViewKernelKind;
  readonly candidate: GridViewCandidate;
}

export type GridViewBuildResult = GridViewBuildCancelled | GridViewBuildComplete;

interface GridViewMappingOptions {
  readonly datasetId: string;
  readonly requestId: number;
  readonly viewRevision: number;
  readonly physicalRowCount: number;
  readonly physicalRows: Uint32Array;
  readonly filterBitmap: Uint8Array | null;
  readonly spec: GridViewSpec;
}

export interface GridPublishedViewData {
  readonly datasetId: string;
  readonly requestId: number;
  readonly viewRevision: number;
  readonly physicalRowCount: number;
  readonly physicalRows: Uint32Array;
  readonly filterBitmap: Uint8Array | null;
  readonly spec: GridViewSpec;
}

export interface NormalizedGridViewSpec extends GridViewSpec {
  readonly sort?: readonly Required<GridSort>[];
}

/**
 * The narrow data surface required to build a filter/sort permutation.
 *
 * Keeping this structural lets the view worker evaluate a private sparse edit
 * candidate without mutating its installed typed-column store. Published view
 * identity methods continue to require the concrete {@link GridDataStore}.
 */
export interface GridViewDataSource {
  readonly datasetId: string | null;
  readonly rowCount: number;
  columnIndexOf(columnId: string): number;
  columnScalarTypeAt(column: number | string): CellScalarType;
  cellAt(rowIndex: number, column: number | string): CellScalar | null;
  /** Optional package-internal fast path over installed typed buffers. */
  typedColumnAt?(column: number | string): TypedViewKernelColumn | null;
}

interface GridViewKernelUsage {
  generic: boolean;
  typed: boolean;
}

export class GridViewMapping {
  readonly datasetId: string;
  readonly requestId: number;
  readonly viewRevision: number;
  readonly physicalRowCount: number;
  readonly physicalRows: Uint32Array;
  /** Bit-packed physical membership, or null for the unfiltered identity set. */
  readonly filterBitmap: Uint8Array | null;
  readonly spec: GridViewSpec;
  private physicalToView: Uint32Array | null = null;

  protected constructor(options: GridViewMappingOptions) {
    this.datasetId = options.datasetId;
    this.requestId = options.requestId;
    this.viewRevision = options.viewRevision;
    this.physicalRowCount = options.physicalRowCount;
    this.physicalRows = options.physicalRows;
    this.filterBitmap = options.filterBitmap;
    this.spec = options.spec;
  }

  get rowCount(): number {
    return this.physicalRows.length;
  }

  physicalRowAt(viewOrdinal: number): number {
    assertIndex(viewOrdinal, this.rowCount, "View ordinal");
    return this.physicalRows[viewOrdinal]!;
  }

  viewOrdinalOfPhysicalRow(physicalRow: number): number {
    assertIndex(physicalRow, this.physicalRowCount, "Physical row");
    const ordinal = this.inverse()[physicalRow]!;
    return ordinal === UINT32_NOT_VISIBLE ? -1 : ordinal;
  }

  rowIdAt(viewOrdinal: number, store: GridDataStore): RowId {
    this.assertStore(store);
    return store.rowIdAt(this.physicalRowAt(viewOrdinal));
  }

  viewOrdinalOfRowId(rowId: RowId, store: GridDataStore): number {
    this.assertStore(store);
    const physicalRow = store.rowIndexOf(rowId);
    return physicalRow < 0 ? -1 : this.viewOrdinalOfPhysicalRow(physicalRow);
  }

  private inverse(): Uint32Array {
    if (this.physicalToView) return this.physicalToView;
    const inverse = new Uint32Array(this.physicalRowCount);
    inverse.fill(UINT32_NOT_VISIBLE);
    for (let ordinal = 0; ordinal < this.physicalRows.length; ordinal++) {
      inverse[this.physicalRows[ordinal]!] = ordinal;
    }
    this.physicalToView = inverse;
    return inverse;
  }

  private assertStore(store: GridDataStore): void {
    if (store.datasetId !== this.datasetId) {
      throw new Error(
        `View dataset ${this.datasetId} cannot resolve rows from ${String(store.datasetId)}.`,
      );
    }
  }
}

export class GridViewCandidate extends GridViewMapping {
  constructor(options: GridViewMappingOptions) {
    super(options);
  }
}

export class GridPublishedView extends GridViewMapping {
  constructor(options: GridViewMappingOptions) {
    super(options);
  }
}

/** Rehydrates a worker-built candidate after its typed mappings are transferred. */
export function createPublishedGridView(data: GridPublishedViewData): GridPublishedView {
  return new GridPublishedView(data);
}

/**
 * Builds a private view candidate without mutating the store or a previously
 * published view, yielding between bounded chunks so a newer request can
 * supersede an in-flight filter or stable sort.
 */
export async function buildGridViewCandidateAsync(
  store: GridViewDataSource,
  spec: GridViewSpec,
  options: GridViewAsyncBuildOptions,
): Promise<GridViewBuildResult> {
  const datasetId = store.datasetId;
  if (!datasetId) throw new Error("A grid dataset must be installed before building a view.");
  validateBuildIdentity(options);
  if (store.rowCount > UINT32_NOT_VISIBLE) {
    throw new RangeError("Active views support at most 4,294,967,295 physical rows.");
  }
  const chunkSize = asyncChunkSize(options.chunkSize);
  const preference = kernelPreference(options.kernel);
  const normalizedSpec = normalizeGridViewSpec(store, spec);
  const usage: GridViewKernelUsage = { generic: false, typed: false };
  try {
    pollCancellation(options);
    const filtered = await filterRowsWithKernelAsync(
      store,
      normalizedSpec.filter,
      options,
      chunkSize,
      preference,
      usage,
    );
    let rows = filtered.rows;
    if (normalizedSpec.sort && normalizedSpec.sort.length > 0 && rows.length > 1) {
      rows = await sortRowsWithKernelAsync(
        store,
        rows,
        normalizedSpec.sort,
        options,
        chunkSize,
        preference,
        usage,
      );
    }
    pollCancellation(options);
    return {
      status: "complete",
      kernel: effectiveKernel(usage),
      candidate: new GridViewCandidate({
        datasetId,
        requestId: options.requestId,
        viewRevision: options.viewRevision,
        physicalRowCount: store.rowCount,
        physicalRows: rows,
        filterBitmap: filtered.filterBitmap,
        spec: normalizedSpec,
      }),
    };
  } catch (error) {
    if (error !== BUILD_CANCELLED && !(error instanceof TypedViewKernelCancelledError)) throw error;
    return {
      status: "cancelled",
      datasetId,
      requestId: options.requestId,
      viewRevision: options.viewRevision,
    };
  }
}

/**
 * Converts only the expected candidate into a published mapping. A caller can
 * atomically replace its current reference with the returned object; `null`
 * means the candidate was stale and must be discarded.
 */
export function publishGridViewCandidate(
  candidate: GridViewCandidate,
  expected: GridViewPublicationExpectation,
): GridPublishedView | null {
  if (
    candidate.datasetId !== expected.datasetId ||
    candidate.requestId !== expected.requestId ||
    candidate.viewRevision !== expected.viewRevision
  ) {
    return null;
  }
  return new GridPublishedView({
    datasetId: candidate.datasetId,
    requestId: candidate.requestId,
    viewRevision: candidate.viewRevision,
    physicalRowCount: candidate.physicalRowCount,
    physicalRows: candidate.physicalRows,
    filterBitmap: candidate.filterBitmap,
    spec: candidate.spec,
  });
}

async function filterRowsWithKernelAsync(
  store: GridViewDataSource,
  filter: GridFilter | undefined,
  options: GridViewAsyncBuildOptions,
  chunkSize: number,
  preference: GridViewKernelPreference,
  usage: GridViewKernelUsage,
): Promise<{ rows: Uint32Array; filterBitmap: Uint8Array | null }> {
  const typed = preference === "generic" ? null : typedFilterInput(store, filter);
  if (!typed) {
    if (filter) usage.generic = true;
    return filterRowsAsync(store, filter, options, chunkSize);
  }
  usage.typed = true;
  const result = await filterTypedColumnAsync(typed.column, typed.filter, {
    chunkSize,
    ...(options.shouldCancel ? { shouldCancel: options.shouldCancel } : {}),
    ...(options.yieldControl ? { yieldControl: options.yieldControl } : {}),
    onChunk: (progress) => reportTypedFilterProgress(progress, store.rowCount, options),
  });
  return { rows: result.physicalRows, filterBitmap: result.bitmap };
}

async function sortRowsWithKernelAsync(
  store: GridViewDataSource,
  rows: Uint32Array,
  sorts: readonly Required<GridSort>[],
  options: GridViewAsyncBuildOptions,
  chunkSize: number,
  preference: GridViewKernelPreference,
  usage: GridViewKernelUsage,
): Promise<Uint32Array> {
  const keys = preference === "generic" ? null : typedSortKeys(store, sorts);
  if (!keys) {
    usage.generic = true;
    return sortRowsAsync(store, rows, sorts, options, chunkSize);
  }
  usage.typed = true;
  return stableTypedRadixSortRowsAsync(
    rows,
    keys,
    {
      chunkSize,
      ...(options.shouldCancel ? { shouldCancel: options.shouldCancel } : {}),
      ...(options.yieldControl ? { yieldControl: options.yieldControl } : {}),
      onChunk: (progress) => reportTypedSortProgress(progress, options),
    },
    true,
  );
}

function typedFilterInput(
  store: GridViewDataSource,
  filter: GridFilter | undefined,
): { column: TypedViewKernelColumn; filter: TypedViewKernelFilter } | null {
  if (!filter || !store.typedColumnAt) return null;
  switch (filter.kind) {
    case "comparison":
    case "between":
    case "in":
    case "is-null":
    case "is-not-null": {
      const column = store.typedColumnAt(requireColumn(store, filter.columnId));
      return column ? { column, filter } : null;
    }
    case "all":
    case "any":
    case "not":
    case "contains":
    case "starts-with":
    case "ends-with":
      return null;
  }
}

function typedSortKeys(
  store: GridViewDataSource,
  sorts: readonly Required<GridSort>[],
): readonly TypedViewKernelSortKey[] | null {
  if (!store.typedColumnAt) return null;
  const keys: TypedViewKernelSortKey[] = [];
  for (const sort of sorts) {
    const column = store.typedColumnAt(requireColumn(store, sort.columnId));
    if (!column) return null;
    keys.push({ column, direction: sort.direction, nulls: sort.nulls });
  }
  return keys;
}

function reportTypedFilterProgress(
  progress: TypedViewKernelProgress,
  rowCount: number,
  options: GridViewBuildOptions,
): void {
  const total = rowCount * 2;
  const completed =
    progress.phase === "filter" ? progress.completed : rowCount + progress.completed;
  options.onProgress?.({ phase: "filter", completed: Math.min(total, completed), total });
}

function reportTypedSortProgress(
  progress: TypedViewKernelProgress,
  options: GridViewBuildOptions,
): void {
  options.onProgress?.({ phase: "sort", completed: progress.completed, total: progress.total });
}

function effectiveKernel(usage: GridViewKernelUsage): GridViewKernelKind {
  if (usage.typed && usage.generic) return "hybrid";
  return usage.typed ? "typed" : "generic";
}

function kernelPreference(value: GridViewKernelPreference | undefined): GridViewKernelPreference {
  if (value === undefined) return "auto";
  if (value !== "auto" && value !== "generic" && value !== "typed") {
    throw new TypeError(`Unknown Grid view kernel: ${String(value)}`);
  }
  return value;
}

async function filterRowsAsync(
  store: GridViewDataSource,
  filter: GridFilter | undefined,
  options: GridViewAsyncBuildOptions,
  chunkSize: number,
): Promise<{ rows: Uint32Array; filterBitmap: Uint8Array | null }> {
  const rowCount = store.rowCount;
  if (!filter) {
    const rows = new Uint32Array(rowCount);
    for (let start = 0; start < rowCount; start += chunkSize) {
      const end = Math.min(rowCount, start + chunkSize);
      for (let row = start; row < end; row++) rows[row] = row;
      options.onProgress?.({ phase: "filter", completed: end, total: rowCount });
      if (end < rowCount) await asyncCheckpoint(options);
    }
    pollCancellation(options);
    return { rows, filterBitmap: null };
  }

  const predicate = compileFilter(store, filter);
  const filterBitmap = new Uint8Array(Math.ceil(rowCount / 8));
  let matchCount = 0;
  for (let start = 0; start < rowCount; start += chunkSize) {
    const end = Math.min(rowCount, start + chunkSize);
    for (let row = start; row < end; row++) {
      if (predicate(row)) {
        filterBitmap[row >> 3]! |= 1 << (row & 7);
        matchCount++;
      }
    }
    options.onProgress?.({ phase: "filter", completed: end, total: rowCount });
    if (end < rowCount) await asyncCheckpoint(options);
  }

  const rows = new Uint32Array(matchCount);
  let ordinal = 0;
  for (let start = 0; start < rowCount; start += chunkSize) {
    const end = Math.min(rowCount, start + chunkSize);
    for (let row = start; row < end; row++) {
      if ((filterBitmap[row >> 3]! & (1 << (row & 7))) !== 0) rows[ordinal++] = row;
    }
    if (end < rowCount) await asyncCheckpoint(options);
  }
  pollCancellation(options);
  return { rows, filterBitmap };
}

async function sortRowsAsync(
  store: GridViewDataSource,
  rows: Uint32Array,
  sorts: readonly Required<GridSort>[],
  options: GridViewAsyncBuildOptions,
  chunkSize: number,
): Promise<Uint32Array> {
  const length = rows.length;
  const compareRows = rowComparator(store, sorts);
  const passes = Math.ceil(Math.log2(length));
  const total = length * passes;
  let completed = 0;
  let sinceYield = 0;
  let source: Uint32Array = rows;
  let target: Uint32Array = new Uint32Array(length);
  options.onProgress?.({ phase: "sort", completed: 0, total });

  for (let width = 1; width < length; width = Math.min(length, width * 2)) {
    for (let left = 0; left < length; left += width * 2) {
      const middle = Math.min(length, left + width);
      const right = Math.min(length, middle + width);
      let leftIndex = left;
      let rightIndex = middle;
      let output = left;
      while (leftIndex < middle && rightIndex < right) {
        target[output++] =
          compareRows(source[leftIndex]!, source[rightIndex]!) <= 0
            ? source[leftIndex++]!
            : source[rightIndex++]!;
        if (++sinceYield >= chunkSize) {
          completed += sinceYield;
          sinceYield = 0;
          options.onProgress?.({ phase: "sort", completed: Math.min(total, completed), total });
          await asyncCheckpoint(options);
        }
      }
      while (leftIndex < middle) {
        target[output++] = source[leftIndex++]!;
        if (++sinceYield >= chunkSize) {
          completed += sinceYield;
          sinceYield = 0;
          options.onProgress?.({ phase: "sort", completed: Math.min(total, completed), total });
          await asyncCheckpoint(options);
        }
      }
      while (rightIndex < right) {
        target[output++] = source[rightIndex++]!;
        if (++sinceYield >= chunkSize) {
          completed += sinceYield;
          sinceYield = 0;
          options.onProgress?.({ phase: "sort", completed: Math.min(total, completed), total });
          await asyncCheckpoint(options);
        }
      }
    }
    [source, target] = [target, source];
  }
  if (sinceYield > 0) completed += sinceYield;
  options.onProgress?.({ phase: "sort", completed: total, total });
  pollCancellation(options);
  return source;
}

function rowComparator(
  store: GridViewDataSource,
  sorts: readonly Required<GridSort>[],
): (leftRow: number, rightRow: number) => number {
  const keys = sorts.map((sort) => ({
    column: store.columnIndexOf(sort.columnId),
    direction: sort.direction,
    nulls: sort.nulls,
  }));
  return (leftRow, rightRow) => {
    for (const key of keys) {
      const left = store.cellAt(leftRow, key.column);
      const right = store.cellAt(rightRow, key.column);
      if (left === null || right === null) {
        const nullComparison = compareNullable(left, right, key.nulls);
        if (nullComparison !== 0) return nullComparison;
      } else {
        const comparison = compareScalar(left, right);
        if (comparison !== 0) return key.direction === "ascending" ? comparison : -comparison;
      }
    }
    // Physical ingestion order is the deterministic stable-sort tie break.
    return leftRow - rightRow;
  };
}

function compileFilter(store: GridViewDataSource, filter: GridFilter): (row: number) => boolean {
  switch (filter.kind) {
    case "all": {
      const children = filter.filters.map((child) => compileFilter(store, child));
      return (row) => children.every((child) => child(row));
    }
    case "any": {
      const children = filter.filters.map((child) => compileFilter(store, child));
      return (row) => children.some((child) => child(row));
    }
    case "not": {
      const child = compileFilter(store, filter.filter);
      return (row) => !child(row);
    }
    case "is-null": {
      const column = requireColumn(store, filter.columnId);
      return (row) => store.cellAt(row, column) === null;
    }
    case "is-not-null": {
      const column = requireColumn(store, filter.columnId);
      return (row) => store.cellAt(row, column) !== null;
    }
    case "comparison": {
      const column = requireColumn(store, filter.columnId);
      return (row) => {
        const value = store.cellAt(row, column);
        return value !== null && matchesFilterComparison(value, filter.operator, filter.value);
      };
    }
    case "between": {
      const column = requireColumn(store, filter.columnId);
      const includeLower = filter.includeLower ?? true;
      const includeUpper = filter.includeUpper ?? true;
      return (row) => {
        const value = store.cellAt(row, column);
        return (
          value !== null &&
          matchesFilterBetween(value, filter.lower, filter.upper, includeLower, includeUpper)
        );
      };
    }
    case "in": {
      const column = requireColumn(store, filter.columnId);
      const values = [...filter.values];
      return (row) => {
        const value = store.cellAt(row, column);
        return value !== null && values.some((candidate) => value === candidate);
      };
    }
    case "contains":
    case "starts-with":
    case "ends-with": {
      const column = requireColumn(store, filter.columnId);
      return (row) => {
        const value = store.cellAt(row, column);
        if (typeof value !== "string") return false;
        if (filter.kind === "contains") return value.includes(filter.value);
        if (filter.kind === "starts-with") return value.startsWith(filter.value);
        return value.endsWith(filter.value);
      };
    }
  }
}

function compareNullable(
  left: CellScalar | null,
  right: CellScalar | null,
  nulls: "first" | "last",
): number {
  if (left === null) return right === null ? 0 : nulls === "first" ? -1 : 1;
  if (right === null) return nulls === "first" ? 1 : -1;
  return compareScalar(left, right);
}

function compareScalar(left: CellScalar, right: CellScalar): number {
  if (left === right) return 0;
  if (isNaNScalar(left)) return isNaNScalar(right) ? 0 : 1;
  if (isNaNScalar(right)) return -1;
  if (typeof left === typeof right || isNumericPair(left, right)) {
    if (left < right) return -1;
    if (right < left) return 1;
    return 0;
  }
  const leftRank = scalarTypeRank(left);
  const rightRank = scalarTypeRank(right);
  return leftRank === rightRank ? 0 : leftRank < rightRank ? -1 : 1;
}

function isNaNScalar(value: CellScalar): boolean {
  return typeof value === "number" && Number.isNaN(value);
}

/**
 * Validates and captures an immutable view specification. Hosts may safely
 * retain this snapshot across an asynchronous worker or main-thread build.
 */
export function normalizeGridViewSpec(
  store: GridViewDataSource,
  spec: GridViewSpec,
): NormalizedGridViewSpec {
  if (!spec || typeof spec !== "object") throw new TypeError("Grid view spec must be an object.");
  const sortIds = new Set<string>();
  const sort = spec.sort?.map((entry, index): Required<GridSort> => {
    if (!entry || typeof entry !== "object") {
      throw new TypeError(`Grid sort entry ${index} must be an object.`);
    }
    requireColumn(store, entry.columnId);
    if (sortIds.has(entry.columnId)) {
      throw new RangeError(`Grid sort column ${entry.columnId} appears more than once.`);
    }
    sortIds.add(entry.columnId);
    if (entry.direction !== "ascending" && entry.direction !== "descending") {
      throw new TypeError(`Grid sort direction for ${entry.columnId} is invalid.`);
    }
    const nulls = entry.nulls ?? "last";
    if (nulls !== "first" && nulls !== "last") {
      throw new TypeError(`Grid null order for ${entry.columnId} is invalid.`);
    }
    return Object.freeze({ columnId: entry.columnId, direction: entry.direction, nulls });
  });
  if (spec.filter) validateFilterShape(store, spec.filter, new Set());
  const filter = spec.filter ? cloneFilter(spec.filter) : undefined;
  return Object.freeze({
    ...(filter ? { filter } : {}),
    ...(sort ? { sort: Object.freeze(sort) } : {}),
  });
}

function cloneFilter(filter: GridFilter): GridFilter {
  switch (filter.kind) {
    case "all":
    case "any":
      return Object.freeze({
        kind: filter.kind,
        filters: Object.freeze(filter.filters.map(cloneFilter)),
      });
    case "not":
      return Object.freeze({ kind: "not", filter: cloneFilter(filter.filter) });
    case "in":
      return Object.freeze({ ...filter, values: Object.freeze([...filter.values]) });
    default:
      return Object.freeze({ ...filter });
  }
}

function validateFilterShape(
  store: GridViewDataSource,
  filter: GridFilter,
  ancestors: Set<GridFilter>,
): void {
  if (!filter || typeof filter !== "object") throw new TypeError("Grid filter must be an object.");
  if (ancestors.has(filter)) throw new TypeError("Grid filter trees cannot contain cycles.");
  ancestors.add(filter);
  switch (filter.kind) {
    case "all":
    case "any":
      if (!Array.isArray(filter.filters))
        throw new TypeError(`${filter.kind} filters require an array.`);
      filter.filters.forEach((child) => validateFilterShape(store, child, ancestors));
      break;
    case "not":
      validateFilterShape(store, filter.filter, ancestors);
      break;
    case "comparison": {
      const column = requireColumn(store, filter.columnId);
      const scalarType = store.columnScalarTypeAt(column);
      if (!["eq", "ne", "lt", "lte", "gt", "gte"].includes(filter.operator)) {
        throw new TypeError(`Grid comparison operator ${String(filter.operator)} is invalid.`);
      }
      assertCompatibleFilterScalar(
        filter.value,
        scalarType,
        `comparison value for column ${filter.columnId}`,
      );
      break;
    }
    case "between": {
      const column = requireColumn(store, filter.columnId);
      const scalarType = store.columnScalarTypeAt(column);
      assertCompatibleFilterScalar(
        filter.lower,
        scalarType,
        `between lower value for column ${filter.columnId}`,
      );
      assertCompatibleFilterScalar(
        filter.upper,
        scalarType,
        `between upper value for column ${filter.columnId}`,
      );
      break;
    }
    case "in": {
      const column = requireColumn(store, filter.columnId);
      if (!Array.isArray(filter.values))
        throw new TypeError("Grid in filter values must be an array.");
      const scalarType = store.columnScalarTypeAt(column);
      for (let index = 0; index < filter.values.length; index++) {
        assertCompatibleFilterScalar(
          filter.values[index],
          scalarType,
          `in filter value ${index} for column ${filter.columnId}`,
        );
      }
      break;
    }
    case "is-null":
    case "is-not-null":
      requireColumn(store, filter.columnId);
      break;
    case "contains":
    case "starts-with":
    case "ends-with": {
      const column = requireColumn(store, filter.columnId);
      if (typeof filter.value !== "string")
        throw new TypeError(`${filter.kind} value must be a string.`);
      if (store.columnScalarTypeAt(column) !== "string") {
        throw new TypeError(
          `Grid ${filter.kind} filter requires a string-backed column; ${filter.columnId} is not string-backed.`,
        );
      }
      break;
    }
    default:
      throw new TypeError(
        `Unsupported grid filter kind: ${String((filter as { kind?: unknown }).kind)}`,
      );
  }
  ancestors.delete(filter);
}

function requireColumn(store: GridViewDataSource, columnId: string): number {
  if (typeof columnId !== "string" || columnId.length === 0) {
    throw new TypeError("Grid filter and sort column IDs must be non-empty strings.");
  }
  const index = store.columnIndexOf(columnId);
  if (index < 0) throw new RangeError(`Unknown grid column: ${columnId}`);
  return index;
}

function validateBuildIdentity(options: GridViewBuildOptions): void {
  if (!Number.isSafeInteger(options.requestId) || options.requestId < 0) {
    throw new RangeError("Grid view requestId must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(options.viewRevision) || options.viewRevision < 0) {
    throw new RangeError("Grid view revision must be a non-negative safe integer.");
  }
}

function pollCancellation(options: GridViewBuildOptions): void {
  if (options.shouldCancel?.()) throw BUILD_CANCELLED;
}

async function asyncCheckpoint(options: GridViewAsyncBuildOptions): Promise<void> {
  pollCancellation(options);
  if (options.yieldControl) await options.yieldControl();
  else await yieldWorkerTurn();
  pollCancellation(options);
}

function asyncChunkSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ASYNC_CHUNK_SIZE;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Grid async view chunkSize must be a positive safe integer.");
  }
  return value;
}

function assertIndex(index: number, length: number, label: string): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new RangeError(`${label} ${index} is outside the view.`);
  }
}

function isNumericPair(left: CellScalar, right: CellScalar): boolean {
  return (
    (typeof left === "number" || typeof left === "bigint") &&
    (typeof right === "number" || typeof right === "bigint")
  );
}

function scalarTypeRank(value: CellScalar): number {
  switch (typeof value) {
    case "boolean":
      return 0;
    case "number":
    case "bigint":
      return 1;
    case "string":
      return 2;
  }
}
