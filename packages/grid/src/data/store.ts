import type {
  BufferOwnership,
  CellScalar,
  CellScalarType,
  GridBuffer,
  GridColumnData,
  GridColumnSchema,
  GridData,
  GridDataInstallResult,
  GridTypedArray,
  RowId,
  RowIdData,
  Utf8Buffers,
  ValidityBitmap,
} from "../types.js";

interface BufferDescriptor {
  readonly path: string;
  /** Exact view captured during structural validation. */
  readonly view: GridTypedArray;
  /** Captured before a transfer can detach the source backing buffer. */
  readonly viewConstructor: Function;
  readonly requested: BufferOwnership;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly length: number;
}

interface InstalledSnapshot {
  readonly datasetId: string;
  readonly length: number;
  readonly rowIds?: RowIdData;
  readonly rowIndexById?: ReadonlyMap<RowId, number>;
  readonly columns: readonly {
    readonly schema: GridColumnSchema;
    readonly data: GridColumnData;
  }[];
  readonly columnById: ReadonlyMap<string, number>;
  readonly installResult: GridDataInstallResult;
}

interface GridTypedColumnAccessBase {
  readonly rowCount: number;
  readonly validity?: {
    readonly bits: Uint8Array;
    readonly bitOffset: number;
  };
  /**
   * Immutable snapshot of sparse values layered over the installed base
   * buffer. Omitted for the overwhelmingly common no-patch case so kernels can
   * scan the raw view without a per-row Map probe.
   */
  readonly overrides?: ReadonlyMap<number, CellScalar | null>;
}

type GridIntegerArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array;

type GridCategoryCodeArray =
  Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array;

/**
 * Internal zero-decoding column surface for active-view kernels. This module
 * is not exported from the package root, so the representation can evolve
 * without becoming public API.
 */
export type GridTypedColumnAccess =
  | (GridTypedColumnAccessBase & {
      readonly kind: "number";
      readonly values: Float32Array | Float64Array;
    })
  | (GridTypedColumnAccessBase & {
      readonly kind: "integer";
      readonly values: GridIntegerArray;
    })
  | (GridTypedColumnAccessBase & {
      readonly kind: "timestamp";
      readonly values: Float64Array | BigInt64Array;
      readonly unit: "s" | "ms" | "us" | "ns";
    })
  | (GridTypedColumnAccessBase & {
      readonly kind: "boolean";
      readonly values: Uint8Array;
      readonly encoding: "byte" | "bitmap";
      readonly bitOffset: number;
    })
  | (GridTypedColumnAccessBase & {
      readonly kind: "category";
      readonly codes: GridCategoryCodeArray;
      /** Dictionary code to decoded value. */
      readonly dictionary: readonly string[];
      /** Dictionary code to ascending JavaScript code-unit lexical rank. */
      readonly lexicalRanks: Uint32Array;
      readonly codeByValue: ReadonlyMap<string, number>;
    });

interface GridCategoryAccessMetadata {
  readonly dictionary: readonly string[];
  readonly lexicalRanks: Uint32Array;
  readonly codeByValue: ReadonlyMap<string, number>;
}

export interface GridColumnDescriptor {
  readonly schema: GridColumnSchema;
  readonly timestampUnit?: "s" | "ms" | "us" | "ns";
  readonly timezone?: string;
}

/** Compare-and-set baseline captured when an edit operation is issued. */
export interface GridCellPatchBaseline {
  readonly datasetId: string;
  readonly rowId: RowId;
  readonly columnId: string;
  readonly cellRevision: number;
  readonly previousValue: CellScalar | null;
}

export interface GridCellPatchProposal extends GridCellPatchBaseline {
  readonly finalValue: CellScalar | null;
}

/** Private candidate patch. It is inert until promoted after surface confirmation. */
export interface GridStagedCellPatch extends GridCellPatchProposal {
  readonly token: string;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly nextCellRevision: number;
}

export interface GridCellState {
  readonly value: CellScalar | null;
  readonly revision: number;
}

interface CommittedCellPatch {
  readonly value: CellScalar | null;
  readonly revision: number;
}

interface PreflightResult {
  readonly descriptors: readonly BufferDescriptor[];
}

/** Cooperative validation progress for the internal engine-worker boundary. */
export interface GridDataPreflightProgress {
  readonly phase: "row-ids" | "column" | "ownership" | "complete";
  readonly path: string;
  readonly completed: number;
  readonly total: number;
}

export interface GridDataPreflightOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: GridDataPreflightProgress) => void;
  /** Maximum CPU time between event-loop yields. Defaults to 8ms. */
  readonly yieldIntervalMs?: number;
}

/**
 * Opaque proof that one exact GridData object passed the complete store
 * preflight. It is intentionally exported only from this internal module.
 */
export interface GridDataPreflight {
  readonly bufferCount: number;
  readonly referencedBytes: number;
}

/** Private, call-time snapshot ready to cross the canonical runtime boundary. */
export interface GridRuntimeIngress {
  readonly data: GridData;
  readonly transfer: ArrayBuffer[];
}

interface GridDataPreflightRecord {
  readonly data: GridData;
  readonly result: PreflightResult;
}

const OWNERSHIP_VALUES = new Set<BufferOwnership>(["copy", "transfer", "shared"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const ASYNC_VALIDATION_CHECKPOINT_VALUES = 16_384;
const DEFAULT_VALIDATION_YIELD_INTERVAL_MS = 8;
const preflightRecords = new WeakMap<GridDataPreflight, GridDataPreflightRecord>();
let nextDatasetId = 0;
let nextPatchToken = 0;

/**
 * Runs the exact synchronous store preflight cooperatively. The first turn and
 * every bounded validation slice yield through an event-loop task, so callers
 * can observe progress and abort without waiting for a dataset-sized scan.
 */
export async function preflightGridDataAsync(
  data: GridData,
  options: GridDataPreflightOptions = {},
): Promise<GridDataPreflight> {
  const iterator = validateGridDataSteps(data);
  const yieldIntervalMs = finiteYieldInterval(options.yieldIntervalMs);
  let lastYieldAt = performance.now();
  let latestProgress: GridDataPreflightProgress | null = null;

  throwIfPreflightAborted(options.signal);
  await yieldPreflightTurn(options.signal);
  lastYieldAt = performance.now();

  while (true) {
    throwIfPreflightAborted(options.signal);
    const step = iterator.next();
    if (step.done) {
      const result = step.value;
      const proof = Object.freeze({
        bufferCount: result.descriptors.length,
        referencedBytes: result.descriptors.reduce(
          (total, descriptor) => total + descriptor.byteLength,
          0,
        ),
      });
      preflightRecords.set(proof, { data, result });
      options.onProgress?.({
        phase: "complete",
        path: "data",
        completed: 1,
        total: 1,
      });
      return proof;
    }

    latestProgress = step.value;
    if (performance.now() - lastYieldAt < yieldIntervalMs) continue;
    options.onProgress?.(latestProgress);
    await yieldPreflightTurn(options.signal);
    lastYieldAt = performance.now();
  }
}

/**
 * Captures one immutable host-side ingress image after bounded structural
 * checks, applying the public ownership contract before any asynchronous work.
 *
 * Copy views become exact-range private buffers. Transfer backings are consumed
 * immediately and preserve all source subview offsets/aliasing. Both private
 * buffer classes are transferred once more into the runtime, so the host does
 * not retain a dataset-sized image. Shared views retain their backing under the
 * existing host-immutability contract.
 *
 * Content validation deliberately remains worker-owned. Consequently,
 * `transfer` buffers are consumed once this function succeeds even when later
 * worker validation rejects invalid Boolean bytes, category codes, UTF-8, or
 * row identities. Structural failures (including conflicting alias ownership)
 * are detected before any buffer is detached.
 */
export function acquireGridRuntimeIngress(data: GridData): GridRuntimeIngress {
  const result = validateGridDataStructure(data);
  assertPreflightBuffersAttached(result.descriptors);
  const views = new Map<string, GridTypedArray>();
  const requested = new Map<string, BufferOwnership>();
  const sourceBuffers: ArrayBuffer[] = [];
  const sourceBufferIndex = new Map<ArrayBuffer, number>();
  const transferIndexByPath = new Map<string, number>();

  for (const descriptor of result.descriptors) {
    requested.set(descriptor.path, descriptor.requested);
    if (descriptor.requested === "copy") {
      views.set(descriptor.path, copyView(descriptor.view));
    } else if (descriptor.requested === "shared") {
      views.set(
        descriptor.path,
        recreateCapturedView(
          descriptor,
          descriptor.view.buffer,
          descriptor.byteOffset,
          descriptor.length,
        ),
      );
    } else {
      const source = descriptor.view.buffer as ArrayBuffer;
      if (!sourceBufferIndex.has(source)) {
        sourceBufferIndex.set(source, sourceBuffers.length);
        sourceBuffers.push(source);
      }
      transferIndexByPath.set(descriptor.path, sourceBufferIndex.get(source)!);
    }
  }

  let acquiredBuffers: ArrayBuffer[] = [];
  if (sourceBuffers.length > 0) {
    if (typeof structuredClone !== "function") {
      throw new Error("Transfer ownership requires structuredClone support.");
    }
    acquiredBuffers = structuredClone(sourceBuffers, { transfer: sourceBuffers });
  }
  for (const descriptor of result.descriptors) {
    if (descriptor.requested !== "transfer") continue;
    const sourceIndex = transferIndexByPath.get(descriptor.path);
    if (sourceIndex === undefined) {
      throw new Error(`Internal grid transfer source is missing: ${descriptor.path}`);
    }
    views.set(
      descriptor.path,
      recreateCapturedView(
        descriptor,
        acquiredBuffers[sourceIndex]!,
        descriptor.byteOffset,
        descriptor.length,
      ),
    );
  }

  const ingressData: GridData = Object.freeze({
    length: data.length,
    ...(data.rowIds ? { rowIds: materializeRowIds(data.rowIds, views, requested) } : {}),
    columns: Object.freeze(
      data.columns.map((column, columnIndex) =>
        Object.freeze({
          schema: Object.freeze(cloneColumnSchema(column.schema)),
          data: materializeColumn(column.data, columnIndex, views, requested),
        }),
      ),
    ),
  });
  const transfer = new Set<ArrayBuffer>();
  for (const descriptor of result.descriptors) {
    if (descriptor.requested === "shared") continue;
    const buffer = views.get(descriptor.path)?.buffer;
    if (!buffer || isSharedBuffer(buffer)) {
      throw new Error(`Internal grid ingress buffer is missing: ${descriptor.path}`);
    }
    transfer.add(buffer as ArrayBuffer);
  }
  return { data: ingressData, transfer: [...transfer] };
}

/**
 * Internal finite-grid store. It is intentionally not exported from the package
 * root until the public Grid lifecycle API freezes.
 */
export class GridDataStore {
  private active: InstalledSnapshot | null = null;
  private readonly committedPatches = new Map<number, Map<number, CommittedCellPatch>>();
  private readonly categoryAccessMetadata = new Map<number, GridCategoryAccessMetadata>();
  private stagedPatch: GridStagedCellPatch | null = null;

  get datasetId(): string | null {
    return this.active?.datasetId ?? null;
  }

  get rowCount(): number {
    return this.active?.length ?? 0;
  }

  get columnIds(): readonly string[] {
    return this.active?.columns.map((column) => column.schema.id) ?? [];
  }

  get columnCount(): number {
    return this.active?.columns.length ?? 0;
  }

  columnIndexOf(columnId: string): number {
    return this.active?.columnById.get(columnId) ?? -1;
  }

  /** Exact scalar representation used by filter operands for this column. */
  columnScalarTypeAt(column: number | string): CellScalarType {
    const active = requireActive(this.active);
    const columnIndex = resolveColumnIndex(active, column);
    const data = active.columns[columnIndex]!.data;
    switch (data.kind) {
      case "number":
        return "number";
      case "integer":
        return isBigIntArray(data.values.view) ? "bigint" : "number";
      case "boolean":
        return "boolean";
      case "timestamp":
        return data.values.data.view instanceof BigInt64Array ? "bigint" : "number";
      case "category":
      case "text":
        return "string";
      case "id":
        if (data.values.encoding === "utf8") return "string";
        return isBigIntArray(data.values.data.view) ? "bigint" : "number";
    }
  }

  columnDescriptorAt(columnIndex: number): GridColumnDescriptor {
    const active = requireActive(this.active);
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= active.columns.length) {
      throw new RangeError(`Column index ${columnIndex} is outside the active dataset.`);
    }
    const column = active.columns[columnIndex]!;
    return {
      schema: cloneColumnSchema(column.schema),
      ...(column.data.kind === "timestamp"
        ? {
            timestampUnit: column.data.values.unit,
            ...(column.data.timezone === undefined ? {} : { timezone: column.data.timezone }),
          }
        : {}),
    };
  }

  /** Decoded existing values for the built-in enumerated category editor. */
  categoryValuesAt(column: number | string): readonly string[] {
    const active = requireActive(this.active);
    const columnIndex = resolveColumnIndex(active, column);
    const descriptor = active.columns[columnIndex]!;
    if (descriptor.data.kind !== "category") {
      throw new TypeError(`Grid column ${descriptor.schema.id} is not category.`);
    }
    return this.categoryMetadataAt(columnIndex, descriptor.data).dictionary;
  }

  /**
   * Returns installed typed buffers for kernels that can preserve the scalar
   * contract without decoding each row. Text and ID columns deliberately fall
   * back to `cellAt()` by returning `null`.
   *
   * Passing an active staged patch produces a private candidate snapshot. The
   * staged value is never visible through an ordinary call and never mutates
   * the installed base buffer.
   */
  typedColumnAt(
    column: number | string,
    staged?: GridStagedCellPatch,
  ): GridTypedColumnAccess | null {
    const active = requireActive(this.active);
    const columnIndex = resolveColumnIndex(active, column);
    if (staged && !this.matchesStagedPatch(staged)) {
      throw new Error("The staged Grid cell patch is no longer active.");
    }
    const descriptor = active.columns[columnIndex]!;
    if (descriptor.data.kind === "id" || descriptor.data.kind === "text") return null;
    const validity = descriptor.data.validity
      ? {
          bits: descriptor.data.validity.bits.view,
          bitOffset: descriptor.data.validity.bitOffset ?? 0,
        }
      : undefined;
    const overrides = this.typedColumnOverrides(columnIndex, staged);
    const common = {
      rowCount: active.length,
      ...(validity ? { validity } : {}),
      ...(overrides ? { overrides } : {}),
    };

    switch (descriptor.data.kind) {
      case "number":
        return { ...common, kind: "number", values: descriptor.data.values.view };
      case "integer":
        return { ...common, kind: "integer", values: descriptor.data.values.view };
      case "timestamp":
        return {
          ...common,
          kind: "timestamp",
          values: descriptor.data.values.data.view,
          unit: descriptor.data.values.unit,
        };
      case "boolean":
        return {
          ...common,
          kind: "boolean",
          values: descriptor.data.values.view,
          encoding: descriptor.data.encoding,
          bitOffset: descriptor.data.bitOffset ?? 0,
        };
      case "category": {
        const metadata = this.categoryMetadataAt(columnIndex, descriptor.data);
        return {
          ...common,
          kind: "category",
          codes: descriptor.data.codes.view,
          ...metadata,
        };
      }
    }
  }

  install(data: GridData): GridDataInstallResult {
    const candidate = installSnapshot(data, validateGridData(data), "acquire");
    this.active = candidate;
    this.committedPatches.clear();
    this.categoryAccessMetadata.clear();
    this.stagedPatch = null;
    return candidate.installResult;
  }

  /**
   * Installs views that have already crossed the worker message boundary.
   *
   * `postMessage` has already copied, transferred, or shared each backing
   * buffer according to its declared ownership. Adopting those message-owned
   * views avoids allocating or transferring a second dataset-sized image while
   * preserving the public ownership manifest for the original boundary.
   */
  installWorkerIngress(data: GridData, preflight: GridDataPreflight): GridDataInstallResult {
    const record = requireGridDataPreflight(data, preflight);
    preflightRecords.delete(preflight);
    assertPreflightBuffersAttached(record.result.descriptors);
    const candidate = installSnapshot(data, record.result, "adopt");
    this.active = candidate;
    this.committedPatches.clear();
    this.categoryAccessMetadata.clear();
    this.stagedPatch = null;
    return candidate.installResult;
  }

  rowIdAt(rowIndex: number): RowId {
    const active = requireActive(this.active);
    assertRowIndex(rowIndex, active.length);
    return readRowId(active.rowIds, rowIndex);
  }

  rowIndexOf(rowId: RowId): number {
    const active = requireActive(this.active);
    if (!active.rowIds) {
      return typeof rowId === "number" &&
        Number.isSafeInteger(rowId) &&
        !Object.is(rowId, -0) &&
        rowId >= 0 &&
        rowId < active.length
        ? rowId
        : -1;
    }
    return active.rowIndexById?.get(rowId) ?? -1;
  }

  cellAt(rowIndex: number, column: number | string): CellScalar | null {
    const active = requireActive(this.active);
    assertRowIndex(rowIndex, active.length);
    const columnIndex = resolveColumnIndex(active, column);
    const patch = this.committedPatches.get(columnIndex)?.get(rowIndex);
    if (patch) return patch.value;
    return readCell(active.columns[columnIndex]!.data, rowIndex);
  }

  /** Returns the immutable committed value and its compare-and-set revision. */
  cellState(rowId: RowId, columnId: string): GridCellState {
    const active = requireActive(this.active);
    const rowIndex = this.rowIndexOf(rowId);
    if (rowIndex < 0) throw new RangeError(`Unknown grid RowId: ${String(rowId)}`);
    const columnIndex = resolveColumnIndex(active, columnId);
    return {
      value: this.cellAt(rowIndex, columnIndex),
      revision: this.committedPatches.get(columnIndex)?.get(rowIndex)?.revision ?? 0,
    };
  }

  /** Checks an operation baseline with the contract's type-sensitive equality. */
  isCellBaselineCurrent(baseline: GridCellPatchBaseline): boolean {
    const active = this.active;
    if (!active || baseline.datasetId !== active.datasetId) return false;
    const rowIndex = this.rowIndexOf(baseline.rowId);
    const columnIndex = active.columnById.get(baseline.columnId) ?? -1;
    if (rowIndex < 0 || columnIndex < 0) return false;
    const state = this.cellState(baseline.rowId, baseline.columnId);
    return (
      state.revision === baseline.cellRevision &&
      gridCellScalarEquals(state.value, baseline.previousValue)
    );
  }

  /**
   * Validates a host-normalized value against editability, nullability, the
   * physical integer width, and a categorical column's installed dictionary.
   */
  validateEditableCellValue(rowId: RowId, columnId: string, value: CellScalar | null): void {
    const active = requireActive(this.active);
    if (this.rowIndexOf(rowId) < 0) throw new RangeError(`Unknown grid RowId: ${String(rowId)}`);
    const columnIndex = resolveColumnIndex(active, columnId);
    validateEditableValue(active.columns[columnIndex]!, value);
  }

  /**
   * Parses deterministic, locale-independent editor text. Null is never
   * inferred from an empty string; callers must request the explicit null
   * action. Integer and category parsing retains the installed schema.
   */
  parseEditableCellValue(
    rowId: RowId,
    columnId: string,
    rawValue: string,
    explicitNull = false,
  ): CellScalar | null {
    if (typeof rawValue !== "string") {
      throw new TypeError("Grid editor input must be a string.");
    }
    const active = requireActive(this.active);
    if (this.rowIndexOf(rowId) < 0) throw new RangeError(`Unknown grid RowId: ${String(rowId)}`);
    const columnIndex = resolveColumnIndex(active, columnId);
    const column = active.columns[columnIndex]!;
    if (explicitNull) {
      validateEditableValue(column, null);
      return null;
    }
    const value = parseEditableValue(column, rawValue);
    validateEditableValue(column, value);
    return value;
  }

  /**
   * Stages one sparse candidate without changing committed reads. `null`
   * means the compare-and-set baseline became stale.
   */
  stageCellPatch(proposal: GridCellPatchProposal): GridStagedCellPatch | null {
    const active = requireActive(this.active);
    if (this.stagedPatch) {
      throw new Error("The Grid data store already has a staged cell patch.");
    }
    if (!this.isCellBaselineCurrent(proposal)) return null;
    const rowIndex = this.rowIndexOf(proposal.rowId);
    const columnIndex = resolveColumnIndex(active, proposal.columnId);
    validateEditableValue(active.columns[columnIndex]!, proposal.finalValue);
    const staged = Object.freeze({
      ...proposal,
      token: `sixtyfold:grid:patch:${(++nextPatchToken).toString(36)}`,
      rowIndex,
      columnIndex,
      nextCellRevision: proposal.cellRevision + 1,
    });
    this.stagedPatch = staged;
    return staged;
  }

  /** Reads the candidate value only for its exact target cell. */
  stagedCellAt(
    staged: GridStagedCellPatch,
    rowIndex: number,
    column: number | string,
  ): CellScalar | null {
    const active = requireActive(this.active);
    assertRowIndex(rowIndex, active.length);
    const columnIndex = resolveColumnIndex(active, column);
    if (!this.matchesStagedPatch(staged)) {
      throw new Error("The staged Grid cell patch is no longer active.");
    }
    return rowIndex === staged.rowIndex && columnIndex === staged.columnIndex
      ? staged.finalValue
      : this.cellAt(rowIndex, columnIndex);
  }

  /** Promotes the exact staged patch if its compare-and-set baseline still holds. */
  promoteCellPatch(staged: GridStagedCellPatch): boolean {
    if (!this.matchesStagedPatch(staged) || !this.isCellBaselineCurrent(staged)) return false;
    const active = requireActive(this.active);
    validateEditableValue(active.columns[staged.columnIndex]!, staged.finalValue);
    let columnPatches = this.committedPatches.get(staged.columnIndex);
    if (!columnPatches) {
      columnPatches = new Map<number, CommittedCellPatch>();
      this.committedPatches.set(staged.columnIndex, columnPatches);
    }
    columnPatches.set(staged.rowIndex, {
      value: staged.finalValue,
      revision: staged.nextCellRevision,
    });
    this.stagedPatch = null;
    return true;
  }

  /** Discards the exact candidate without changing committed state. */
  discardCellPatch(staged: GridStagedCellPatch): boolean {
    if (!this.matchesStagedPatch(staged)) return false;
    this.stagedPatch = null;
    return true;
  }

  private matchesStagedPatch(staged: GridStagedCellPatch): boolean {
    return (
      this.stagedPatch === staged &&
      staged.datasetId === this.active?.datasetId &&
      staged.token === this.stagedPatch.token
    );
  }

  private typedColumnOverrides(
    columnIndex: number,
    staged: GridStagedCellPatch | undefined,
  ): ReadonlyMap<number, CellScalar | null> | undefined {
    const committed = this.committedPatches.get(columnIndex);
    const stagedTargetsColumn = staged?.columnIndex === columnIndex;
    if ((!committed || committed.size === 0) && !stagedTargetsColumn) return undefined;

    const snapshot = new Map<number, CellScalar | null>();
    if (committed) {
      for (const [rowIndex, patch] of committed) snapshot.set(rowIndex, patch.value);
    }
    if (stagedTargetsColumn) snapshot.set(staged.rowIndex, staged.finalValue);
    return snapshot;
  }

  private categoryMetadataAt(
    columnIndex: number,
    data: Extract<GridColumnData, { kind: "category" }>,
  ): GridCategoryAccessMetadata {
    const cached = this.categoryAccessMetadata.get(columnIndex);
    if (cached) return cached;

    const dictionary = new Array<string>(data.dictionary.offsets.view.length - 1);
    const codeByValue = new Map<string, number>();
    for (let code = 0; code < dictionary.length; code++) {
      const value = readUtf8(data.dictionary, code);
      dictionary[code] = value;
      codeByValue.set(value, code);
    }
    const lexicalOrder = dictionary.map((_, code) => code);
    lexicalOrder.sort((leftCode, rightCode) => {
      const left = dictionary[leftCode]!;
      const right = dictionary[rightCode]!;
      return left === right ? leftCode - rightCode : left < right ? -1 : 1;
    });
    const lexicalRanks = new Uint32Array(dictionary.length);
    for (let rank = 0; rank < lexicalOrder.length; rank++) {
      lexicalRanks[lexicalOrder[rank]!] = rank;
    }
    const metadata = {
      dictionary: Object.freeze(dictionary),
      lexicalRanks,
      codeByValue,
    } satisfies GridCategoryAccessMetadata;
    this.categoryAccessMetadata.set(columnIndex, metadata);
    return metadata;
  }
}

function installSnapshot(
  data: GridData,
  preflight: PreflightResult,
  acquisition: "acquire" | "adopt",
): InstalledSnapshot {
  const installedViews =
    acquisition === "acquire"
      ? acquireBuffers(preflight.descriptors)
      : adoptIngressBuffers(preflight.descriptors);
  const installedRowIds = data.rowIds ? materializeRowIds(data.rowIds, installedViews) : undefined;
  let rowIndexById: Map<RowId, number> | undefined;
  if (installedRowIds) {
    rowIndexById = new Map<RowId, number>();
    for (let rowIndex = 0; rowIndex < data.length; rowIndex++) {
      rowIndexById.set(readRowId(installedRowIds, rowIndex), rowIndex);
    }
  }
  const installedColumns = data.columns.map((column, columnIndex) => ({
    schema: cloneColumnSchema(column.schema),
    data: materializeColumn(column.data, columnIndex, installedViews),
  }));
  const datasetId = `sixtyfold:grid:dataset:${(++nextDatasetId).toString(36)}`;
  const buffers = preflight.descriptors.map((descriptor) => ({
    path: descriptor.path,
    requested: descriptor.requested,
    installed:
      descriptor.requested === "copy"
        ? ("copied" as const)
        : descriptor.requested === "transfer"
          ? ("transferred" as const)
          : ("shared" as const),
    byteLength: descriptor.byteLength,
  }));
  const installResult = Object.freeze({
    datasetId,
    buffers: Object.freeze(buffers.map((entry) => Object.freeze(entry))),
  });
  return {
    datasetId,
    length: data.length,
    ...(installedRowIds ? { rowIds: installedRowIds } : {}),
    ...(rowIndexById ? { rowIndexById } : {}),
    columns: installedColumns,
    columnById: new Map(installedColumns.map((column, index) => [column.schema.id, index])),
    installResult,
  };
}

function validateGridData(data: GridData): PreflightResult {
  const iterator = validateGridDataSteps(data, true);
  while (true) {
    const step = iterator.next();
    if (step.done) return step.value;
  }
}

function validateGridDataStructure(data: GridData): PreflightResult {
  const iterator = validateGridDataSteps(data, false);
  while (true) {
    const step = iterator.next();
    if (step.done) return step.value;
  }
}

function* validateGridDataSteps(
  data: GridData,
  validateContents = true,
): Generator<GridDataPreflightProgress, PreflightResult> {
  if (!data || typeof data !== "object") {
    throw new TypeError("Grid data must be an object.");
  }
  if (!Number.isSafeInteger(data.length) || data.length < 0) {
    throw new RangeError("Grid data length must be a non-negative safe integer.");
  }
  if (!Array.isArray(data.columns)) {
    throw new TypeError("Grid data columns must be an array.");
  }

  const descriptors: BufferDescriptor[] = [];
  if (data.rowIds) {
    yield* validateRowIdsSteps(data.rowIds, data.length, descriptors, validateContents);
  }

  const columnIds = new Set<string>();
  for (let columnIndex = 0; columnIndex < data.columns.length; columnIndex++) {
    const column = data.columns[columnIndex];
    if (!column || typeof column !== "object") {
      throw new TypeError(`columns[${columnIndex}] must be an object.`);
    }
    const { schema, data: columnData } = column;
    if (!schema || typeof schema !== "object") {
      throw new TypeError(`columns[${columnIndex}].schema must be an object.`);
    }
    if (typeof schema.id !== "string" || schema.id.length === 0) {
      throw new TypeError(`columns[${columnIndex}].schema.id must be a non-empty string.`);
    }
    if (schema.nullable !== undefined && typeof schema.nullable !== "boolean") {
      throw new TypeError(`columns[${columnIndex}].schema.nullable must be a boolean.`);
    }
    if (schema.editable !== undefined && typeof schema.editable !== "boolean") {
      throw new TypeError(`columns[${columnIndex}].schema.editable must be a boolean.`);
    }
    if (schema.edit !== undefined) {
      validateEditorOptions(schema.edit, columnIndex);
      if (schema.editable !== true) {
        throw new TypeError(`columns[${columnIndex}].schema.edit requires editable: true.`);
      }
    }
    if (schema.editable === true && (schema.kind === "timestamp" || schema.kind === "id")) {
      throw new TypeError(`Column ${schema.id} has an immutable ${schema.kind} kind.`);
    }
    if (columnIds.has(schema.id)) {
      throw new RangeError(`Duplicate grid column ID: ${schema.id}`);
    }
    columnIds.add(schema.id);
    if (!columnData || typeof columnData !== "object") {
      throw new TypeError(`columns[${columnIndex}].data must be an object.`);
    }
    if (schema.kind !== columnData.kind) {
      throw new TypeError(
        `Column ${schema.id} declares kind ${schema.kind}, but its data is ${columnData.kind}.`,
      );
    }
    yield* validateColumnSteps(
      columnData,
      schema,
      data.length,
      columnIndex,
      descriptors,
      validateContents,
    );
  }

  validateAliasedOwnership(descriptors);
  yield {
    phase: "ownership",
    path: "buffers",
    completed: descriptors.length,
    total: descriptors.length,
  };
  return { descriptors };
}

function validationProgress(
  phase: GridDataPreflightProgress["phase"],
  path: string,
  completed: number,
  total: number,
): GridDataPreflightProgress {
  return { phase, path, completed, total };
}

function finiteYieldInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_VALIDATION_YIELD_INTERVAL_MS;
  }
  return Math.max(0, Math.min(1_000, value));
}

function throwIfPreflightAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw preflightAbortError(signal);
}

function preflightAbortError(signal: AbortSignal): DOMException {
  const reason = signal.reason;
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.length > 0
        ? reason
        : "Grid data preflight was aborted.";
  return new DOMException(message, "AbortError");
}

function yieldPreflightTurn(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(preflightAbortError(signal));
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let channel: MessageChannel | null = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      channel?.port1.close();
      channel?.port2.close();
      signal?.removeEventListener("abort", handleAbort);
    };
    const complete = () => {
      cleanup();
      resolve();
    };
    const handleAbort = () => {
      cleanup();
      reject(preflightAbortError(signal!));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });

    if (typeof MessageChannel === "function") {
      channel = new MessageChannel();
      channel.port1.onmessage = complete;
      channel.port2.postMessage(undefined);
    } else {
      timer = setTimeout(complete, 0);
    }
  });
}

function cloneColumnSchema(schema: GridColumnSchema): GridColumnSchema {
  return {
    ...schema,
    ...(schema.edit ? { edit: { ...schema.edit } } : {}),
  };
}

function* validateRowIdsSteps(
  rowIds: RowIdData,
  length: number,
  descriptors: BufferDescriptor[],
  validateContents: boolean,
): Generator<GridDataPreflightProgress, void> {
  if (!rowIds || typeof rowIds !== "object") {
    throw new TypeError("rowIds must be an object.");
  }
  switch (rowIds.kind) {
    case "number": {
      const values = addBuffer(descriptors, "rowIds.values", rowIds.values, isNumberRowIdArray);
      assertExactLength(values, length, "rowIds.values");
      if (!validateContents) return;
      const seen = new Set<number>();
      for (let index = 0; index < length; index++) {
        const value = Number(values[index]);
        if (!Number.isSafeInteger(value) || !Number.isFinite(value) || Object.is(value, -0)) {
          throw new RangeError(`rowIds.values[${index}] is not a valid numeric RowId.`);
        }
        if (seen.has(value)) throw new RangeError(`Duplicate RowId at row ${index}.`);
        seen.add(value);
        if ((index + 1) % ASYNC_VALIDATION_CHECKPOINT_VALUES === 0) {
          yield validationProgress("row-ids", "rowIds.values", index + 1, length);
        }
      }
      yield validationProgress("row-ids", "rowIds.values", length, length);
      return;
    }
    case "bigint": {
      const values = addBuffer(descriptors, "rowIds.values", rowIds.values, isBigIntArray);
      assertExactLength(values, length, "rowIds.values");
      if (!validateContents) return;
      const seen = new Set<bigint>();
      for (let index = 0; index < length; index++) {
        const value = values[index]!;
        if (seen.has(value)) throw new RangeError(`Duplicate RowId at row ${index}.`);
        seen.add(value);
        if ((index + 1) % ASYNC_VALIDATION_CHECKPOINT_VALUES === 0) {
          yield validationProgress("row-ids", "rowIds.values", index + 1, length);
        }
      }
      yield validationProgress("row-ids", "rowIds.values", length, length);
      return;
    }
    case "string": {
      yield* validateUtf8Steps(
        rowIds,
        length,
        "rowIds",
        descriptors,
        true,
        "row-ids",
        validateContents,
      );
      return;
    }
    default:
      throw new TypeError(
        `Unsupported rowIds kind: ${String((rowIds as { kind?: unknown }).kind)}`,
      );
  }
}

function* validateColumnSteps(
  data: GridColumnData,
  schema: GridColumnSchema,
  length: number,
  columnIndex: number,
  descriptors: BufferDescriptor[],
  validateContents: boolean,
): Generator<GridDataPreflightProgress, void> {
  const base = `columns[${columnIndex}].data`;
  switch (data.kind) {
    case "number": {
      const values = addBuffer(descriptors, `${base}.values`, data.values, isNumberArray);
      assertExactLength(values, length, `${base}.values`);
      yield* validateValiditySteps(
        data.validity,
        length,
        `${base}.validity`,
        schema.nullable,
        descriptors,
        validateContents,
      );
      return;
    }
    case "integer": {
      const values = addBuffer(descriptors, `${base}.values`, data.values, isIntegerArray);
      assertExactLength(values, length, `${base}.values`);
      yield* validateValiditySteps(
        data.validity,
        length,
        `${base}.validity`,
        schema.nullable,
        descriptors,
        validateContents,
      );
      return;
    }
    case "boolean": {
      const values = addBuffer(descriptors, `${base}.values`, data.values, isUint8Array);
      if (data.encoding === "byte") {
        assertExactLength(values, length, `${base}.values`);
        if (validateContents) {
          for (let index = 0; index < values.length; index++) {
            if (values[index] !== 0 && values[index] !== 1) {
              throw new RangeError(`${base}.values[${index}] must be zero or one.`);
            }
            if ((index + 1) % ASYNC_VALIDATION_CHECKPOINT_VALUES === 0) {
              yield validationProgress("column", `${base}.values`, index + 1, values.length);
            }
          }
          yield validationProgress("column", `${base}.values`, values.length, values.length);
        }
      } else if (data.encoding === "bitmap") {
        validateBitRange(values, data.bitOffset, length, `${base}.values`);
      } else {
        throw new TypeError(`${base}.encoding must be "byte" or "bitmap".`);
      }
      yield* validateValiditySteps(
        data.validity,
        length,
        `${base}.validity`,
        schema.nullable,
        descriptors,
        validateContents,
      );
      return;
    }
    case "timestamp": {
      const values = addBuffer(
        descriptors,
        `${base}.values.data`,
        data.values.data,
        data.values.unit === "ms" ? isTimestampArray : isBigInt64Array,
      );
      if (
        (values instanceof Float64Array && data.values.unit !== "ms") ||
        (values instanceof BigInt64Array && !new Set(["s", "ms", "us", "ns"]).has(data.values.unit))
      ) {
        throw new TypeError(`${base}.values has an incompatible timestamp unit.`);
      }
      assertExactLength(values, length, `${base}.values.data`);
      yield* validateValiditySteps(
        data.validity,
        length,
        `${base}.validity`,
        schema.nullable,
        descriptors,
        validateContents,
      );
      return;
    }
    case "category": {
      const codes = addBuffer(descriptors, `${base}.codes`, data.codes, isCategoryCodeArray);
      assertExactLength(codes, length, `${base}.codes`);
      const dictionaryLength = yield* validateUtf8Steps(
        data.dictionary,
        undefined,
        `${base}.dictionary`,
        descriptors,
        true,
        "column",
        validateContents,
      );
      yield* validateValiditySteps(
        data.validity,
        length,
        `${base}.validity`,
        schema.nullable,
        descriptors,
        validateContents,
      );
      if (validateContents) {
        for (let index = 0; index < length; index++) {
          if (isValid(data.validity, index)) {
            const code = Number(codes[index]);
            if (!Number.isInteger(code) || code < 0 || code >= dictionaryLength) {
              throw new RangeError(`${base}.codes[${index}] is outside the dictionary.`);
            }
          }
          if ((index + 1) % ASYNC_VALIDATION_CHECKPOINT_VALUES === 0) {
            yield validationProgress("column", `${base}.codes`, index + 1, length);
          }
        }
        yield validationProgress("column", `${base}.codes`, length, length);
      }
      return;
    }
    case "id": {
      if (data.values.encoding === "integer") {
        const values = addBuffer(
          descriptors,
          `${base}.values.data`,
          data.values.data,
          isIntegerArray,
        );
        assertExactLength(values, length, `${base}.values.data`);
      } else if (data.values.encoding === "utf8") {
        yield* validateUtf8Steps(
          data.values,
          length,
          `${base}.values`,
          descriptors,
          false,
          "column",
          validateContents,
        );
      } else {
        throw new TypeError(`${base}.values has an unsupported ID encoding.`);
      }
      yield* validateValiditySteps(
        data.validity,
        length,
        `${base}.validity`,
        schema.nullable,
        descriptors,
        validateContents,
      );
      return;
    }
    case "text": {
      yield* validateUtf8Steps(
        data.values,
        length,
        `${base}.values`,
        descriptors,
        false,
        "column",
        validateContents,
      );
      yield* validateValiditySteps(
        data.validity,
        length,
        `${base}.validity`,
        schema.nullable,
        descriptors,
        validateContents,
      );
      return;
    }
    default:
      throw new TypeError(`Unsupported column kind: ${String((data as { kind?: unknown }).kind)}`);
  }
}

function* validateValiditySteps(
  validity: ValidityBitmap | undefined,
  length: number,
  path: string,
  nullable: boolean | undefined,
  descriptors: BufferDescriptor[],
  validateContents: boolean,
): Generator<GridDataPreflightProgress, void> {
  if (!validity) return;
  if (typeof validity !== "object") throw new TypeError(`${path} must be an object.`);
  const bits = addBuffer(descriptors, `${path}.bits`, validity.bits, isUint8Array);
  validateBitRange(bits, validity.bitOffset, length, `${path}.bits`);
  if (!nullable && validateContents) {
    for (let index = 0; index < length; index++) {
      if (!readBit(bits, validity.bitOffset ?? 0, index)) {
        throw new RangeError(`${path} marks row ${index} null, but the schema is not nullable.`);
      }
      if ((index + 1) % ASYNC_VALIDATION_CHECKPOINT_VALUES === 0) {
        yield validationProgress("column", `${path}.bits`, index + 1, length);
      }
    }
    yield validationProgress("column", `${path}.bits`, length, length);
  }
}

function* validateUtf8Steps(
  value: Utf8Buffers,
  expectedLength: number | undefined,
  path: string,
  descriptors: BufferDescriptor[],
  unique: boolean,
  phase: "row-ids" | "column",
  validateContents: boolean,
): Generator<GridDataPreflightProgress, number> {
  if (!value || typeof value !== "object") throw new TypeError(`${path} must be an object.`);
  const offsets = addBuffer(descriptors, `${path}.offsets`, value.offsets, isOffsetArray);
  const bytes = addBuffer(descriptors, `${path}.data`, value.data, isUint8Array);
  if (offsets.length === 0)
    throw new RangeError(`${path}.offsets must contain at least one offset.`);
  const logicalLength = offsets.length - 1;
  if (expectedLength !== undefined && logicalLength !== expectedLength) {
    throw new RangeError(`${path} contains ${logicalLength} values; expected ${expectedLength}.`);
  }
  if (!validateContents) return logicalLength;
  const seen = unique ? new Set<string>() : null;
  let previous = Number(offsets[0]);
  if (!Number.isInteger(previous) || previous < 0 || previous > bytes.length) {
    throw new RangeError(`${path}.offsets[0] is outside the UTF-8 buffer.`);
  }
  for (let index = 0; index < logicalLength; index++) {
    const next = Number(offsets[index + 1]);
    if (!Number.isInteger(next) || next < previous || next > bytes.length) {
      throw new RangeError(`${path}.offsets[${index + 1}] is not monotone and in range.`);
    }
    let decoded: string;
    try {
      decoded = utf8Decoder.decode(bytes.subarray(previous, next));
    } catch {
      throw new TypeError(`${path}[${index}] is not valid UTF-8.`);
    }
    if (seen?.has(decoded)) throw new RangeError(`${path} contains duplicate value ${decoded}.`);
    seen?.add(decoded);
    previous = next;
    if ((index + 1) % ASYNC_VALIDATION_CHECKPOINT_VALUES === 0) {
      yield validationProgress(phase, path, index + 1, logicalLength);
    }
  }
  yield validationProgress(phase, path, logicalLength, logicalLength);
  return logicalLength;
}

function validateBitRange(
  bytes: Uint8Array,
  bitOffset: number | undefined,
  length: number,
  path: string,
): void {
  const offset = bitOffset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`${path} bitOffset must be a non-negative safe integer.`);
  }
  if (offset + length > bytes.length * 8) {
    throw new RangeError(`${path} does not contain enough bits for ${length} rows.`);
  }
}

function validateAliasedOwnership(descriptors: readonly BufferDescriptor[]): void {
  const ownershipByBuffer = new Map<ArrayBufferLike, BufferOwnership>();
  for (const descriptor of descriptors) {
    const backing = descriptor.view.buffer;
    const previous = ownershipByBuffer.get(backing);
    if (previous && previous !== descriptor.requested) {
      throw new TypeError(
        `${descriptor.path} shares a backing buffer with conflicting ownership (${previous}/${descriptor.requested}).`,
      );
    }
    ownershipByBuffer.set(backing, descriptor.requested);
    if (descriptor.requested === "shared" && !isSharedBuffer(backing)) {
      throw new TypeError(
        `${descriptor.path} requests shared ownership without SharedArrayBuffer.`,
      );
    }
    if (descriptor.requested === "transfer" && !(backing instanceof ArrayBuffer)) {
      throw new TypeError(`${descriptor.path} cannot transfer a SharedArrayBuffer.`);
    }
  }
}

function addBuffer<T extends GridTypedArray>(
  descriptors: BufferDescriptor[],
  path: string,
  candidate: GridBuffer<T>,
  predicate: (value: unknown) => value is T,
): T {
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError(`${path} must contain the required typed-array view.`);
  }
  const view = candidate.view;
  if (!predicate(view)) {
    throw new TypeError(`${path} must contain the required typed-array view.`);
  }
  const requested = candidate.ownership ?? "copy";
  if (!OWNERSHIP_VALUES.has(requested)) {
    throw new TypeError(`${path}.ownership is invalid.`);
  }
  descriptors.push({
    path,
    view,
    viewConstructor: view.constructor,
    requested,
    byteLength: view.byteLength,
    byteOffset: view.byteOffset,
    length: view.length,
  });
  return view;
}

function acquireBuffers(
  descriptors: readonly BufferDescriptor[],
): ReadonlyMap<string, GridTypedArray> {
  const installed = new Map<string, GridTypedArray>();
  const transferSources: ArrayBuffer[] = [];
  const transferIndex = new Map<ArrayBuffer, number>();

  for (const descriptor of descriptors) {
    if (descriptor.requested === "copy") {
      installed.set(descriptor.path, copyView(descriptor.view));
    } else if (descriptor.requested === "shared") {
      installed.set(descriptor.path, descriptor.view);
    } else {
      const source = descriptor.view.buffer as ArrayBuffer;
      if (!transferIndex.has(source)) {
        transferIndex.set(source, transferSources.length);
        transferSources.push(source);
      }
    }
  }

  let transferred: ArrayBuffer[] = [];
  if (transferSources.length > 0) {
    if (typeof structuredClone !== "function") {
      throw new Error("Transfer ownership requires structuredClone support.");
    }
    transferred = structuredClone(transferSources, { transfer: transferSources });
  }
  for (const descriptor of descriptors) {
    if (descriptor.requested !== "transfer") continue;
    const target = transferred[transferIndex.get(descriptor.view.buffer as ArrayBuffer)!]!;
    installed.set(
      descriptor.path,
      recreateCapturedView(descriptor, target, descriptor.byteOffset, descriptor.length),
    );
  }
  return installed;
}

function assertPreflightBuffersAttached(descriptors: readonly BufferDescriptor[]): void {
  for (const descriptor of descriptors) {
    const view = descriptor.view;
    if (
      view.byteLength !== descriptor.byteLength ||
      view.byteOffset !== descriptor.byteOffset ||
      view.length !== descriptor.length
    ) {
      throw new Error(`${descriptor.path} changed after Grid worker preflight.`);
    }
  }
}

function requireGridDataPreflight(
  data: GridData,
  preflight: GridDataPreflight,
): GridDataPreflightRecord {
  const record = preflightRecords.get(preflight);
  if (!record || record.data !== data) {
    throw new Error("Grid worker boundary requires a preflight for the exact data object.");
  }
  return record;
}

function adoptIngressBuffers(
  descriptors: readonly BufferDescriptor[],
): ReadonlyMap<string, GridTypedArray> {
  const installed = new Map<string, GridTypedArray>();
  for (const descriptor of descriptors) {
    installed.set(descriptor.path, descriptor.view);
  }
  return installed;
}

function materializeRowIds(
  rowIds: RowIdData,
  views: ReadonlyMap<string, GridTypedArray>,
  requested?: ReadonlyMap<string, BufferOwnership>,
): RowIdData {
  switch (rowIds.kind) {
    case "number":
      return {
        kind: "number",
        values: bufferAt(views, "rowIds.values", requested),
      } as RowIdData;
    case "bigint":
      return {
        kind: "bigint",
        values: bufferAt(views, "rowIds.values", requested),
      } as RowIdData;
    case "string":
      return {
        kind: "string",
        offsets: bufferAt(views, "rowIds.offsets", requested),
        data: bufferAt(views, "rowIds.data", requested),
      } as RowIdData;
  }
}

function materializeColumn(
  data: GridColumnData,
  columnIndex: number,
  views: ReadonlyMap<string, GridTypedArray>,
  requested?: ReadonlyMap<string, BufferOwnership>,
): GridColumnData {
  const base = `columns[${columnIndex}].data`;
  const validity = data.validity
    ? {
        bits: bufferAt<Uint8Array>(views, `${base}.validity.bits`, requested),
        ...(data.validity.bitOffset === undefined ? {} : { bitOffset: data.validity.bitOffset }),
      }
    : undefined;
  switch (data.kind) {
    case "number":
      return {
        kind: "number",
        values: bufferAt(views, `${base}.values`, requested),
        ...(validity ? { validity } : {}),
      } as GridColumnData;
    case "integer":
      return {
        kind: "integer",
        values: bufferAt(views, `${base}.values`, requested),
        ...(validity ? { validity } : {}),
      } as GridColumnData;
    case "boolean":
      return {
        kind: "boolean",
        encoding: data.encoding,
        values: bufferAt(views, `${base}.values`, requested),
        ...(data.bitOffset === undefined ? {} : { bitOffset: data.bitOffset }),
        ...(validity ? { validity } : {}),
      } as GridColumnData;
    case "timestamp":
      return {
        kind: "timestamp",
        values: {
          data: bufferAt(views, `${base}.values.data`, requested),
          unit: data.values.unit,
        },
        ...(data.timezone === undefined ? {} : { timezone: data.timezone }),
        ...(validity ? { validity } : {}),
      } as GridColumnData;
    case "category":
      return {
        kind: "category",
        codes: bufferAt(views, `${base}.codes`, requested),
        dictionary: materializeUtf8(views, `${base}.dictionary`, requested),
        ...(validity ? { validity } : {}),
      } as GridColumnData;
    case "id":
      return {
        kind: "id",
        values:
          data.values.encoding === "integer"
            ? {
                encoding: "integer",
                data: bufferAt(views, `${base}.values.data`, requested),
              }
            : {
                encoding: "utf8",
                ...materializeUtf8(views, `${base}.values`, requested),
              },
        ...(validity ? { validity } : {}),
      } as GridColumnData;
    case "text":
      return {
        kind: "text",
        values: materializeUtf8(views, `${base}.values`, requested),
        ...(validity ? { validity } : {}),
      } as GridColumnData;
  }
}

function materializeUtf8(
  views: ReadonlyMap<string, GridTypedArray>,
  path: string,
  requested?: ReadonlyMap<string, BufferOwnership>,
): Utf8Buffers {
  return {
    offsets: bufferAt(views, `${path}.offsets`, requested),
    data: bufferAt(views, `${path}.data`, requested),
  } as Utf8Buffers;
}

function bufferAt<T extends GridTypedArray>(
  views: ReadonlyMap<string, GridTypedArray>,
  path: string,
  requested?: ReadonlyMap<string, BufferOwnership>,
): GridBuffer<T> {
  const view = views.get(path);
  if (!view) throw new Error(`Internal grid buffer is missing: ${path}`);
  const ownership = requested?.get(path);
  return {
    view: view as T,
    ...(ownership ? { ownership } : {}),
  };
}

function readRowId(rowIds: RowIdData | undefined, rowIndex: number): RowId {
  if (!rowIds) return rowIndex;
  switch (rowIds.kind) {
    case "number":
      return Number(rowIds.values.view[rowIndex]);
    case "bigint":
      return rowIds.values.view[rowIndex]!;
    case "string":
      return readUtf8(rowIds, rowIndex);
  }
}

function readCell(data: GridColumnData, rowIndex: number): CellScalar | null {
  if (!isValid(data.validity, rowIndex)) return null;
  switch (data.kind) {
    case "number":
    case "integer":
      return data.values.view[rowIndex]!;
    case "boolean":
      return data.encoding === "byte"
        ? data.values.view[rowIndex] === 1
        : readBit(data.values.view, data.bitOffset ?? 0, rowIndex);
    case "timestamp":
      return data.values.data.view[rowIndex]!;
    case "category":
      return readUtf8(data.dictionary, Number(data.codes.view[rowIndex]));
    case "id":
      return data.values.encoding === "integer"
        ? data.values.data.view[rowIndex]!
        : readUtf8(data.values, rowIndex);
    case "text":
      return readUtf8(data.values, rowIndex);
  }
}

function resolveColumnIndex(active: InstalledSnapshot, column: number | string): number {
  const columnIndex = typeof column === "number" ? column : (active.columnById.get(column) ?? -1);
  if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= active.columns.length) {
    throw new RangeError(`Unknown grid column: ${String(column)}`);
  }
  return columnIndex;
}

function validateEditorOptions(edit: GridColumnSchema["edit"], columnIndex: number): void {
  if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
    throw new TypeError(`columns[${columnIndex}].schema.edit must be an object.`);
  }
  for (const key of ["label", "nullLabel", "trueLabel", "falseLabel"] as const) {
    const value = edit[key];
    if (value !== undefined && typeof value !== "string") {
      throw new TypeError(`columns[${columnIndex}].schema.edit.${key} must be a string.`);
    }
  }
}

const DECIMAL_NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const DECIMAL_INTEGER_PATTERN = /^[+-]?\d+$/;

function parseEditableValue(
  column: InstalledSnapshot["columns"][number],
  rawValue: string,
): CellScalar {
  const { schema, data } = column;
  if (schema.editable !== true) {
    throw new TypeError(`Grid column ${schema.id} is not editable.`);
  }
  switch (data.kind) {
    case "text":
    case "category":
      return rawValue;
    case "number": {
      if (!DECIMAL_NUMBER_PATTERN.test(rawValue)) {
        throw invalidEditableValue(schema.id, "a finite decimal number");
      }
      const value = Number(rawValue);
      if (!Number.isFinite(value)) throw invalidEditableValue(schema.id, "a finite decimal number");
      return value;
    }
    case "integer": {
      if (!DECIMAL_INTEGER_PATTERN.test(rawValue)) {
        throw invalidEditableValue(schema.id, "a base-10 integer");
      }
      if (data.values.view instanceof BigInt64Array || data.values.view instanceof BigUint64Array) {
        try {
          return BigInt(rawValue);
        } catch {
          throw invalidEditableValue(schema.id, "a base-10 integer");
        }
      }
      const value = Number(rawValue);
      if (!Number.isSafeInteger(value)) throw invalidEditableValue(schema.id, "a safe integer");
      return Object.is(value, -0) ? 0 : value;
    }
    case "boolean":
      if (rawValue === "true") return true;
      if (rawValue === "false") return false;
      throw invalidEditableValue(schema.id, '"true" or "false"');
    case "timestamp":
    case "id":
      throw new TypeError(`Grid column ${schema.id} has an immutable ${data.kind} kind.`);
  }
}

function validateEditableValue(
  column: InstalledSnapshot["columns"][number],
  value: CellScalar | null,
): void {
  const { schema, data } = column;
  if (schema.editable !== true) {
    throw new TypeError(`Grid column ${schema.id} is not editable.`);
  }
  if (value === null) {
    if (schema.nullable !== true) {
      throw new TypeError(`Grid column ${schema.id} is not nullable.`);
    }
    return;
  }
  switch (data.kind) {
    case "text":
      if (typeof value !== "string") throw invalidEditableValue(schema.id, "a string");
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw invalidEditableValue(schema.id, "a finite number");
      }
      return;
    case "integer":
      validateIntegerValue(schema.id, data.values.view, value);
      return;
    case "boolean":
      if (typeof value !== "boolean") throw invalidEditableValue(schema.id, "a boolean");
      return;
    case "category": {
      if (typeof value !== "string") {
        throw invalidEditableValue(schema.id, "an installed category label");
      }
      const dictionaryLength = data.dictionary.offsets.view.length - 1;
      for (let index = 0; index < dictionaryLength; index++) {
        if (readUtf8(data.dictionary, index) === value) return;
      }
      throw invalidEditableValue(schema.id, "an installed category label");
    }
    case "timestamp":
    case "id":
      throw new TypeError(`Grid column ${schema.id} has an immutable ${data.kind} kind.`);
  }
}

function validateIntegerValue(
  columnId: string,
  values:
    | Int8Array
    | Uint8Array
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | BigInt64Array
    | BigUint64Array,
  value: CellScalar,
): void {
  if (values instanceof BigInt64Array || values instanceof BigUint64Array) {
    if (typeof value !== "bigint") throw invalidEditableValue(columnId, "a bigint");
    const unsigned = values instanceof BigUint64Array;
    const minimum = unsigned ? 0n : -(1n << 63n);
    const maximum = unsigned ? (1n << 64n) - 1n : (1n << 63n) - 1n;
    if (value < minimum || value > maximum) {
      throw new RangeError(`Grid column ${columnId} integer is outside its physical width.`);
    }
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidEditableValue(columnId, "an integer");
  }
  const [minimum, maximum] = integerNumberRange(values);
  if (value < minimum || value > maximum) {
    throw new RangeError(`Grid column ${columnId} integer is outside its physical width.`);
  }
}

function integerNumberRange(
  values: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array,
): readonly [number, number] {
  if (values instanceof Int8Array) return [-128, 127];
  if (values instanceof Uint8Array) return [0, 255];
  if (values instanceof Int16Array) return [-32_768, 32_767];
  if (values instanceof Uint16Array) return [0, 65_535];
  if (values instanceof Int32Array) return [-2_147_483_648, 2_147_483_647];
  return [0, 4_294_967_295];
}

function invalidEditableValue(columnId: string, expected: string): TypeError {
  return new TypeError(`Grid column ${columnId} edit must be ${expected}.`);
}

/** Contract scalar equality: Object.is for numbers and type-sensitive equality otherwise. */
export function gridCellScalarEquals(left: CellScalar | null, right: CellScalar | null): boolean {
  return typeof left === "number" && typeof right === "number"
    ? Object.is(left, right)
    : left === right;
}

function readUtf8(value: Utf8Buffers, index: number): string {
  const start = Number(value.offsets.view[index]);
  const end = Number(value.offsets.view[index + 1]);
  return utf8Decoder.decode(value.data.view.subarray(start, end));
}

function isValid(validity: ValidityBitmap | undefined, rowIndex: number): boolean {
  return validity ? readBit(validity.bits.view, validity.bitOffset ?? 0, rowIndex) : true;
}

function readBit(bytes: Uint8Array, bitOffset: number, index: number): boolean {
  const absolute = bitOffset + index;
  return (bytes[absolute >> 3]! & (1 << (absolute & 7))) !== 0;
}

function assertExactLength(view: GridTypedArray, length: number, path: string): void {
  if (view.length !== length) {
    throw new RangeError(`${path} contains ${view.length} values; expected ${length}.`);
  }
}

function assertRowIndex(rowIndex: number, length: number): void {
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 0 || rowIndex >= length) {
    throw new RangeError(`Row index ${rowIndex} is outside the active dataset.`);
  }
}

function requireActive(active: InstalledSnapshot | null): InstalledSnapshot {
  if (!active) throw new Error("No grid dataset is installed.");
  return active;
}

function copyView<T extends GridTypedArray>(view: T): T {
  return Reflect.construct(view.constructor, [view]) as T;
}

function recreateCapturedView(
  descriptor: BufferDescriptor,
  buffer: ArrayBufferLike,
  byteOffset: number,
  length: number,
): GridTypedArray {
  return Reflect.construct(descriptor.viewConstructor, [
    buffer,
    byteOffset,
    length,
  ]) as GridTypedArray;
}

function isSharedBuffer(value: ArrayBufferLike): value is SharedArrayBuffer {
  return typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isNumberArray(value: unknown): value is Float32Array | Float64Array {
  return value instanceof Float32Array || value instanceof Float64Array;
}

function isTimestampArray(value: unknown): value is Float64Array | BigInt64Array {
  return value instanceof Float64Array || value instanceof BigInt64Array;
}

function isBigInt64Array(value: unknown): value is BigInt64Array {
  return value instanceof BigInt64Array;
}

function isBigIntArray(value: unknown): value is BigInt64Array | BigUint64Array {
  return value instanceof BigInt64Array || value instanceof BigUint64Array;
}

function isNumberRowIdArray(
  value: unknown,
): value is
  Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float64Array {
  return (
    value instanceof Int8Array ||
    value instanceof Uint8Array ||
    value instanceof Int16Array ||
    value instanceof Uint16Array ||
    value instanceof Int32Array ||
    value instanceof Uint32Array ||
    value instanceof Float64Array
  );
}

function isIntegerArray(
  value: unknown,
): value is
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array {
  return (isNumberRowIdArray(value) && !(value instanceof Float64Array)) || isBigIntArray(value);
}

function isCategoryCodeArray(
  value: unknown,
): value is Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array {
  return isIntegerArray(value) && !isBigIntArray(value);
}

function isOffsetArray(value: unknown): value is Int32Array | Uint32Array {
  return value instanceof Int32Array || value instanceof Uint32Array;
}
