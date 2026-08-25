import type {
  GridColumnData,
  GridData,
  RowId,
  Utf8Buffers,
} from "../../../packages/grid/src/types.js";

/**
 * Benchmark-only canonical result shape. Production results are deliberately
 * adapted into this shape by the harness rather than imported here. Keeping
 * the oracle on raw GridData prevents it from sharing store, hierarchy, merge,
 * or query code with the subject under test.
 */
export interface OracleExtremum {
  readonly value: number;
  readonly activeViewOrdinal: number;
  readonly physicalRow: number;
  readonly rowId: RowId;
}

export interface OracleCategoryExemplar {
  readonly code: number;
  readonly label: string;
  readonly activeViewOrdinal: number;
  readonly physicalRow: number;
  readonly rowId: RowId;
}

export interface OracleNumericSummary {
  readonly kind: "numeric";
  readonly columnId: string;
  readonly start: number;
  readonly end: number;
  readonly rowCount: number;
  readonly nullCount: number;
  readonly finiteCount: number;
  readonly nanCount: number;
  readonly positiveInfinityCount: number;
  readonly negativeInfinityCount: number;
  readonly minimum: OracleExtremum | null;
  readonly maximum: OracleExtremum | null;
}

export interface OracleCategorySummary {
  readonly kind: "category";
  readonly columnId: string;
  readonly start: number;
  readonly end: number;
  readonly rowCount: number;
  readonly nullCount: number;
  /** The public contract exposes no more than four entries. */
  readonly exemplars: readonly OracleCategoryExemplar[];
  /** True exactly when the range contains no fifth distinct non-null code. */
  readonly complete: boolean;
  /** Benchmark evidence only; this must not be added to the public payload. */
  readonly overflowWitness: OracleCategoryExemplar | null;
}

export type OracleSummary = OracleNumericSummary | OracleCategorySummary;

export interface OracleCandidateExtremum {
  readonly value: number;
  readonly activeViewOrdinal: number;
  readonly physicalRow: number;
  readonly rowId: RowId;
}

export interface OracleNumericCandidate {
  readonly kind: "numeric";
  readonly columnId: string;
  readonly start: number;
  readonly end: number;
  readonly rowCount: number;
  readonly nullCount: number;
  readonly finiteCount: number;
  readonly nanCount: number;
  readonly positiveInfinityCount: number;
  readonly negativeInfinityCount: number;
  readonly minimum: OracleCandidateExtremum | null;
  readonly maximum: OracleCandidateExtremum | null;
}

export interface OracleCategoryCandidate {
  readonly kind: "category";
  readonly columnId: string;
  readonly start: number;
  readonly end: number;
  readonly rowCount: number;
  readonly nullCount: number;
  readonly exemplars: readonly OracleCategoryExemplar[];
  readonly complete: boolean;
  /** Optional internal diagnostic. Public summary adapters should omit it. */
  readonly overflowWitness?: OracleCategoryExemplar | null;
}

export type OracleSummaryCandidate = OracleNumericCandidate | OracleCategoryCandidate;

export interface OracleComparison {
  readonly passed: boolean;
  readonly firstFailure: string | null;
}

/** Structural copy of the subject's query payload, not an imported engine type. */
export type RawSummaryQueryResult =
  | {
      readonly columnId: string;
      readonly kind: "numeric";
      readonly exact: boolean;
      readonly rowCount: number;
      readonly nullCount: number;
      readonly viewStart: number;
      readonly viewEnd: number;
      readonly finiteCount: number;
      readonly nanCount: number;
      readonly positiveInfinityCount: number;
      readonly negativeInfinityCount: number;
      readonly minimum: RawSummaryExtremum | null;
      readonly maximum: RawSummaryExtremum | null;
    }
  | {
      readonly columnId: string;
      readonly kind: "category";
      readonly exact: boolean;
      readonly rowCount: number;
      readonly nullCount: number;
      readonly viewStart: number;
      readonly viewEnd: number;
      readonly exemplars: readonly RawSummaryCategoryExemplar[];
      readonly complete: boolean;
      readonly overflowWitness: RawSummaryCategoryExemplar | null;
    };

export interface RawSummaryExtremum {
  readonly value: number;
  readonly rowId: RowId;
  readonly viewOrdinal: number;
  readonly physicalRow: number;
}

export interface RawSummaryCategoryExemplar {
  readonly code: number;
  readonly label: string;
  readonly rowId: RowId;
  readonly viewOrdinal: number;
  readonly physicalRow: number;
}

export interface OracleValidation {
  readonly passed: boolean;
  readonly ranges: number;
  readonly summariesCompared: number;
  readonly rawRowsScanned: number;
  readonly firstFailure: string | null;
  readonly digest: string;
  readonly digestAlgorithm: "fnv1a32-summary-v1";
}

export interface OracleExpectation {
  readonly columnId: string;
  readonly range: OracleRange;
  readonly summary: OracleSummary;
}

export interface OracleExpectations {
  readonly physicalRowCount: number;
  readonly viewRowCount: number;
  readonly ranges: number;
  readonly summaries: number;
  readonly rawRowsScanned: number;
  readonly digest: string;
  readonly digestAlgorithm: "fnv1a32-summary-v1";
  readonly entries: readonly OracleExpectation[];
}

export type RawSummaryQuery = (
  columnId: string,
  start: number,
  end: number,
) => RawSummaryQueryResult;

export interface OracleEdgeAdapter {
  query: RawSummaryQuery;
  dispose?(): void;
}

export type OracleEdgeAdapterFactory = (
  data: GridData,
  physicalRows: Uint32Array,
  blockSize: number,
) => OracleEdgeAdapter | Promise<OracleEdgeAdapter>;

export interface OracleEdgeCandidateValidation extends OracleSelfCheck {
  readonly candidateComparisons: number;
  readonly viewsCompared: number;
}

export type OracleRangeKind =
  "full" | "partition" | "block-edge" | "singleton" | "empty" | "arbitrary";

export interface OracleRange {
  readonly start: number;
  readonly end: number;
  readonly kind: OracleRangeKind;
}

export interface OracleRangeCorpus {
  readonly ranges: readonly OracleRange[];
  readonly nonAlignedRanges: number;
  readonly totalRepresentedRows: number;
}

export interface OracleQueryVisitBounds {
  readonly maximumRawBoundaryRows: number;
  readonly maximumCoveredNodeVisits: number;
  readonly leafCount: number;
  readonly treeBase: number;
}

export interface OracleEdgeFixture {
  readonly data: GridData;
  readonly views: Readonly<
    Record<"identity" | "reordered" | "discontiguous" | "empty", Uint32Array>
  >;
  readonly blockSizes: readonly [3, 7, 257];
  readonly ranges: readonly OracleRange[];
  readonly mergeShapeRange: OracleRange;
}

export interface OracleSelfCheck {
  readonly passed: boolean;
  readonly checks: number;
  readonly blockSizes: readonly number[];
  readonly mergeShapesCompared: readonly ["left-deep", "right-deep", "balanced"];
  readonly firstFailure: string | null;
}

const PUBLIC_CATEGORY_EXEMPLARS = 4;
const INTERNAL_CATEGORY_WITNESSES = PUBLIC_CATEGORY_EXEMPLARS + 1;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const expectationSources = new WeakMap<
  OracleExpectations,
  { readonly data: GridData; readonly physicalRows: Uint32Array | null }
>();

/** Raw, allocation-light scan over active-view order. */
export function rawScanSummary(
  data: GridData,
  physicalRows: Uint32Array | null,
  columnId: string,
  start: number,
  end: number,
): OracleSummary {
  const viewRowCount = physicalRows?.length ?? data.length;
  assertRange(start, end, viewRowCount);
  const entry = data.columns.find((column) => column.schema.id === columnId);
  if (!entry) throw new RangeError(`Unknown oracle column ${columnId}.`);
  if (entry.data.kind === "number") {
    return scanNumeric(data, physicalRows, columnId, entry.data, start, end);
  }
  if (entry.data.kind === "category") {
    return scanCategory(data, physicalRows, columnId, entry.data, start, end);
  }
  throw new TypeError(`Oracle column ${columnId} has unsupported kind ${entry.data.kind}.`);
}

/** Exact field-by-field comparison; the digest is never the correctness oracle. */
export function compareOracleSummary(
  actual: OracleSummaryCandidate,
  expected: OracleSummary,
): OracleComparison {
  const failures: string[] = [];
  const same = (condition: boolean, message: string): void => {
    if (!condition && failures.length === 0) failures.push(message);
  };

  same(actual.kind === expected.kind, `kind ${actual.kind} !== ${expected.kind}`);
  same(actual.columnId === expected.columnId, "columnId differs");
  same(actual.start === expected.start, "range start differs");
  same(actual.end === expected.end, "range end differs");
  same(actual.rowCount === expected.rowCount, "rowCount differs");
  same(actual.nullCount === expected.nullCount, "nullCount differs");
  if (actual.kind === "numeric" && expected.kind === "numeric") {
    same(actual.finiteCount === expected.finiteCount, "finiteCount differs");
    same(actual.nanCount === expected.nanCount, "nanCount differs");
    same(
      actual.positiveInfinityCount === expected.positiveInfinityCount,
      "positiveInfinityCount differs",
    );
    same(
      actual.negativeInfinityCount === expected.negativeInfinityCount,
      "negativeInfinityCount differs",
    );
    compareExtremum(actual.minimum, expected.minimum, "minimum", same);
    compareExtremum(actual.maximum, expected.maximum, "maximum", same);
  } else if (actual.kind === "category" && expected.kind === "category") {
    same(actual.complete === expected.complete, "complete differs");
    same(actual.exemplars.length === expected.exemplars.length, "exemplar count differs");
    for (
      let index = 0;
      index < Math.min(actual.exemplars.length, expected.exemplars.length);
      index++
    ) {
      compareCategoryExemplar(actual.exemplars[index]!, expected.exemplars[index]!, index, same);
    }
    if (actual.overflowWitness !== undefined) {
      compareCategoryOverflow(actual.overflowWitness, expected.overflowWitness, same);
    }
  }
  return { passed: failures.length === 0, firstFailure: failures[0] ?? null };
}

/**
 * Compares subject queries with direct raw scans. This function never invokes
 * production store accessors and never uses a hierarchy-produced fingerprint
 * as evidence of correctness.
 */
export function validateSummaryCandidate(
  data: GridData,
  physicalRows: Uint32Array | null,
  columnIds: readonly string[],
  ranges: readonly OracleRange[],
  query: RawSummaryQuery,
): OracleValidation {
  return validateSummaryCandidateAgainstExpectations(
    data,
    physicalRows,
    buildOracleExpectations(data, physicalRows, columnIds, ranges),
    query,
  );
}

/** Builds one reusable raw-scan cache outside every timed candidate query. */
export function buildOracleExpectations(
  data: GridData,
  physicalRows: Uint32Array | null,
  columnIds: readonly string[],
  ranges: readonly OracleRange[],
): OracleExpectations {
  const entries: OracleExpectation[] = [];
  let rawRowsScanned = 0;
  for (const range of ranges) {
    for (const columnId of columnIds) {
      entries.push({
        columnId,
        range,
        summary: rawScanSummary(data, physicalRows, columnId, range.start, range.end),
      });
      rawRowsScanned += range.end - range.start;
    }
  }
  const summaries = entries.map(({ summary }) => summary);
  const expectations: OracleExpectations = {
    physicalRowCount: data.length,
    viewRowCount: physicalRows?.length ?? data.length,
    ranges: ranges.length,
    summaries: entries.length,
    rawRowsScanned,
    digest: digestOracleSummaries(summaries),
    digestAlgorithm: "fnv1a32-summary-v1",
    entries,
  };
  expectationSources.set(expectations, { data, physicalRows });
  return expectations;
}

/** Derives a smaller column cache without repeating any raw source scan. */
export function subsetOracleExpectations(
  expectations: OracleExpectations,
  columnIds: readonly string[],
): OracleExpectations {
  const source = expectationSources.get(expectations);
  if (!source) throw new Error("Oracle expectations were not produced by this oracle instance.");
  if (columnIds.length === 0 || new Set(columnIds).size !== columnIds.length) {
    throw new TypeError("Oracle expectation columns must be unique and non-empty.");
  }
  const available = new Set(expectations.entries.map(({ columnId }) => columnId));
  for (const columnId of columnIds) {
    if (!available.has(columnId)) {
      throw new RangeError(`Oracle expectations do not contain column ${columnId}.`);
    }
  }
  const selected = new Set(columnIds);
  const entries = expectations.entries.filter(({ columnId }) => selected.has(columnId));
  const summaries = entries.map(({ summary }) => summary);
  const derived: OracleExpectations = {
    physicalRowCount: expectations.physicalRowCount,
    viewRowCount: expectations.viewRowCount,
    ranges: expectations.ranges,
    summaries: entries.length,
    rawRowsScanned: entries.reduce((total, { range }) => total + range.end - range.start, 0),
    digest: digestOracleSummaries(summaries),
    digestAlgorithm: "fnv1a32-summary-v1",
    entries,
  };
  expectationSources.set(derived, source);
  return derived;
}

/** Reuses a raw-scan cache for first/replacement candidates without rescanning. */
export function validateSummaryCandidateAgainstExpectations(
  data: GridData,
  physicalRows: Uint32Array | null,
  expectations: OracleExpectations,
  query: RawSummaryQuery,
): OracleValidation {
  const source = expectationSources.get(expectations);
  if (!source || source.data !== data || source.physicalRows !== physicalRows) {
    throw new Error(
      "Oracle expectations must be validated against the exact data and view objects that produced them.",
    );
  }
  if (expectations.physicalRowCount !== data.length) {
    throw new Error("Oracle expectations belong to a different physical dataset length.");
  }
  if (expectations.viewRowCount !== (physicalRows?.length ?? data.length)) {
    throw new Error("Oracle expectations belong to a different active-view length.");
  }
  let summariesCompared = 0;
  let firstFailure: string | null = null;
  for (const { range, columnId, summary: expected } of expectations.entries) {
    let raw: RawSummaryQueryResult;
    try {
      raw = query(columnId, range.start, range.end);
    } catch (error) {
      firstFailure ??= `${columnId} [${range.start}, ${range.end}) query threw: ${String(error)}`;
      continue;
    }
    summariesCompared++;
    if (raw.exact !== true) {
      firstFailure ??= `${columnId} [${range.start}, ${range.end}) was not marked exact`;
      continue;
    }
    let candidate: OracleSummaryCandidate;
    try {
      candidate = normalizeRawCandidate(data, physicalRows, raw);
    } catch (error) {
      firstFailure ??= `${columnId} [${range.start}, ${range.end}) payload is invalid: ${String(error)}`;
      continue;
    }
    const comparison = compareOracleSummary(candidate, expected);
    if (!comparison.passed) {
      firstFailure ??= `${columnId} [${range.start}, ${range.end}): ${comparison.firstFailure}`;
    }
  }
  return {
    passed: firstFailure === null && summariesCompared === expectations.summaries,
    ranges: expectations.ranges,
    summariesCompared,
    rawRowsScanned: expectations.rawRowsScanned,
    firstFailure,
    digest: expectations.digest,
    digestAlgorithm: expectations.digestAlgorithm,
  };
}

/** Runs production adapters over the oracle-owned edge fixture, including B=257. */
export async function runEdgeFixtureOracle(
  factory: OracleEdgeAdapterFactory,
): Promise<OracleEdgeCandidateValidation> {
  const fixture = buildOracleEdgeFixture();
  const self = runOracleSelfCheck();
  let candidateComparisons = 0;
  let viewsCompared = 0;
  let firstFailure = self.firstFailure;
  for (const blockSize of fixture.blockSizes) {
    for (const [viewName, physicalRows] of Object.entries(fixture.views)) {
      const ranges = fixture.ranges
        .map((range) => ({
          ...range,
          start: Math.min(range.start, physicalRows.length),
          end: Math.min(range.end, physicalRows.length),
        }))
        .filter((range) => range.start <= range.end);
      let adapter: OracleEdgeAdapter | null = null;
      try {
        adapter = await factory(fixture.data, physicalRows, blockSize);
        const validation = validateSummaryCandidate(
          fixture.data,
          physicalRows,
          ["numeric", "category"],
          ranges,
          adapter.query,
        );
        candidateComparisons += validation.summariesCompared;
        viewsCompared++;
        if (!validation.passed) {
          firstFailure ??= `${viewName}/B=${blockSize}: ${validation.firstFailure}`;
        }
      } catch (error) {
        firstFailure ??= `${viewName}/B=${blockSize}: adapter failed: ${String(error)}`;
      } finally {
        adapter?.dispose?.();
      }
    }
  }
  return {
    ...self,
    passed: firstFailure === null,
    checks: self.checks + candidateComparisons,
    firstFailure,
    candidateComparisons,
    viewsCompared,
  };
}

/**
 * Deterministic arbitrary-range corpus. The raw-scan cost is recorded by the
 * caller and intentionally excluded from hierarchy build/query timings.
 */
export function buildOracleRanges(
  rowCount: number,
  blockSize: number,
  requestedCount: number,
  seed = 0x51_4d_4d_52,
): OracleRangeCorpus {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new RangeError("rowCount is invalid.");
  if (!Number.isSafeInteger(blockSize) || blockSize < 1)
    throw new RangeError("blockSize is invalid.");
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1)
    throw new RangeError("requestedCount is invalid.");

  const keyed = new Map<string, OracleRange>();
  const add = (start: number, end: number, kind: OracleRangeKind): void => {
    const lo = Math.max(0, Math.min(rowCount, Math.trunc(start)));
    const hi = Math.max(lo, Math.min(rowCount, Math.trunc(end)));
    const key = `${lo}:${hi}`;
    if (!keyed.has(key)) keyed.set(key, { start: lo, end: hi, kind });
  };

  add(0, 0, "empty");
  add(rowCount, rowCount, "empty");
  add(0, rowCount, "full");
  if (rowCount > 0) {
    add(0, 1, "singleton");
    add(rowCount >>> 1, (rowCount >>> 1) + 1, "singleton");
    add(rowCount - 1, rowCount, "singleton");
  }
  for (const edge of [blockSize, blockSize * 2, rowCount - (rowCount % blockSize)]) {
    add(edge - 1, edge, "block-edge");
    add(edge, edge + 1, "block-edge");
    add(edge - 1, edge + 1, "block-edge");
  }
  // This is the largest range with no complete interior block: 2B - 2 rows.
  add(1, blockSize * 2 - 1, "block-edge");
  const partitions = Math.min(16, Math.max(1, requestedCount >>> 3));
  for (let part = 0; part < partitions; part++) {
    const start = Math.floor((rowCount * part) / partitions);
    const end = Math.floor((rowCount * (part + 1)) / partitions);
    add(start, end, "partition");
  }

  let state = seed >>> 0;
  const random = (): number => {
    state = mix32(state + 0x9e37_79b9);
    return state / 0x1_0000_0000;
  };
  let attempts = 0;
  while (keyed.size < requestedCount && attempts++ < requestedCount * 100 + 100) {
    if (rowCount === 0) break;
    let start = Math.floor(random() * rowCount);
    const remaining = rowCount - start;
    const exponent = Math.floor(random() * Math.max(1, Math.ceil(Math.log2(remaining + 1))));
    const ceiling = Math.min(remaining, 1 << Math.min(exponent, 30));
    let end = start + 1 + Math.floor(random() * Math.max(1, ceiling));
    end = Math.min(rowCount, end);
    // Prefer genuinely arbitrary boundaries after the curated cases.
    if (blockSize > 1 && start % blockSize === 0 && start + 1 < end) start++;
    if (blockSize > 1 && end % blockSize === 0 && end - 1 > start) end--;
    add(start, end, "arbitrary");
  }

  const ranges = [...keyed.values()].slice(0, requestedCount);
  return {
    ranges,
    nonAlignedRanges: ranges.filter(
      ({ start, end }) => start % blockSize !== 0 || end % blockSize !== 0,
    ).length,
    totalRepresentedRows: ranges.reduce((total, range) => total + range.end - range.start, 0),
  };
}

/** Tight structural upper bounds for the block-boundary + segment-tree query. */
export function oracleQueryVisitBounds(
  rowCount: number,
  blockSize: number,
  range: Pick<OracleRange, "start" | "end">,
): OracleQueryVisitBounds {
  assertRange(range.start, range.end, rowCount);
  if (!Number.isSafeInteger(blockSize) || blockSize < 1)
    throw new RangeError("blockSize is invalid.");
  const leafCount = Math.ceil(rowCount / blockSize);
  const treeBase = nextPowerOfTwo(Math.max(1, leafCount));
  const rangeLength = range.end - range.start;
  return {
    maximumRawBoundaryRows:
      rangeLength === 0 ? 0 : Math.min(rangeLength, Math.max(0, blockSize * 2 - 2)),
    maximumCoveredNodeVisits:
      rangeLength === 0 ? 0 : Math.max(1, 2 * Math.ceil(Math.log2(treeBase))),
    leafCount,
    treeBase,
  };
}

/** Fixed untimed fixture for semantic edge and non-power-of-two partition checks. */
export function buildOracleEdgeFixture(): OracleEdgeFixture {
  const length = 600;
  const numeric = new Float64Array(length);
  const category = new Uint32Array(length);
  for (let row = 0; row < length; row++) {
    numeric[row] = ((mix32(row + 17) % 20_003) - 10_001) / 8;
    category[row] = row % 11;
  }
  numeric.set([Number.NaN, Infinity, -Infinity, -0, +0, -7, -7, 42, 42, 5, Number.NaN, 6, -999], 0);
  category.set([0, 0, 1, 2, 3, 4, 0, 1, 2, 255, 4, 3, 2], 0);

  const bitOffset = 5;
  const validityBits = new Uint8Array(Math.ceil((bitOffset + length) / 8));
  for (let row = 0; row < length; row++) setValidity(validityBits, bitOffset + row, true);
  for (const row of [12, 258, 599]) setValidity(validityBits, bitOffset + row, false);

  const rowIds = new BigUint64Array(length);
  for (let row = 0; row < length; row++) rowIds[row] = 10_000_000n + BigInt(row * 17);
  const dictionary = buildFixtureDictionary(256);
  const data: GridData = {
    length,
    rowIds: { kind: "bigint", values: { view: rowIds } },
    columns: [
      {
        schema: { id: "numeric", kind: "number", nullable: true },
        data: {
          kind: "number",
          values: { view: numeric },
          validity: { bits: { view: validityBits }, bitOffset },
        },
      },
      {
        schema: { id: "category", kind: "category", nullable: true },
        data: {
          kind: "category",
          codes: { view: category },
          dictionary,
          validity: { bits: { view: validityBits }, bitOffset },
        },
      },
    ],
  };
  const identity = identityRows(length);
  const reordered = reorderFixtureRows(length);
  const discontiguousValues: number[] = [];
  for (let row = length - 1; row >= 0; row--)
    if (row % 3 === 0 || row % 17 === 1) discontiguousValues.push(row);
  return {
    data,
    views: {
      identity,
      reordered,
      discontiguous: Uint32Array.from(discontiguousValues),
      empty: new Uint32Array(0),
    },
    blockSizes: [3, 7, 257],
    ranges: [
      { start: 0, end: 0, kind: "empty" },
      { start: 12, end: 13, kind: "singleton" },
      { start: 10, end: 11, kind: "singleton" },
      { start: 1, end: 3, kind: "block-edge" },
      { start: 3, end: 5, kind: "block-edge" },
      { start: 5, end: 9, kind: "arbitrary" },
      { start: 0, end: 5, kind: "arbitrary" },
      { start: 0, end: 6, kind: "arbitrary" },
      { start: 1, end: 513, kind: "block-edge" },
      { start: 257, end: 600, kind: "arbitrary" },
    ],
    mergeShapeRange: { start: 0, end: 10, kind: "arbitrary" },
  };
}

/** Oracle-local checks. Production candidates are compared separately. */
export function runOracleSelfCheck(): OracleSelfCheck {
  const fixture = buildOracleEdgeFixture();
  let checks = 0;
  let firstFailure: string | null = null;
  const check = (condition: boolean, message: string): void => {
    checks++;
    if (!condition && firstFailure === null) firstFailure = message;
  };
  const identity = fixture.views.identity;
  const emptyNumeric = rawScanSummary(fixture.data, identity, "numeric", 0, 0);
  check(emptyNumeric.kind === "numeric" && emptyNumeric.rowCount === 0, "empty numeric");
  const nullNumeric = rawScanSummary(fixture.data, identity, "numeric", 12, 13);
  check(nullNumeric.kind === "numeric" && nullNumeric.nullCount === 1, "validity bit offset");
  const specialNumeric = rawScanSummary(fixture.data, identity, "numeric", 0, 11);
  check(
    specialNumeric.kind === "numeric" &&
      specialNumeric.nanCount === 2 &&
      specialNumeric.positiveInfinityCount === 1 &&
      specialNumeric.negativeInfinityCount === 1,
    "numeric special counts",
  );
  const zeroNumeric = rawScanSummary(fixture.data, identity, "numeric", 3, 5);
  check(
    zeroNumeric.kind === "numeric" &&
      zeroNumeric.minimum !== null &&
      Object.is(zeroNumeric.minimum.value, -0) &&
      zeroNumeric.minimum.physicalRow === 3,
    "signed-zero first-active tie",
  );
  const tiedNumeric = rawScanSummary(fixture.data, identity, "numeric", 5, 9);
  check(
    tiedNumeric.kind === "numeric" &&
      tiedNumeric.minimum?.physicalRow === 5 &&
      tiedNumeric.maximum?.physicalRow === 7,
    "tied extrema first-active provenance",
  );
  const four = rawScanSummary(fixture.data, identity, "category", 0, 5);
  const five = rawScanSummary(fixture.data, identity, "category", 0, 6);
  check(four.kind === "category" && four.complete && four.exemplars.length === 4, "four codes");
  check(
    five.kind === "category" &&
      !five.complete &&
      five.exemplars.length === 4 &&
      five.overflowWitness?.code === 4,
    "fifth overflow witness",
  );
  if (four.kind === "category") {
    check(
      four.exemplars[0]?.code === 0 &&
        four.exemplars[1]?.code === 1 &&
        four.exemplars[0]?.label === "zeta-000" &&
        four.exemplars[1]?.label === "alpha-001",
      "code order is independent from label lexical order",
    );
  }

  const pieces: readonly (readonly OracleCategoryExemplar[])[] = [
    five.kind === "category" ? five.exemplars.slice(0, 1) : [],
    five.kind === "category" ? [...five.exemplars, five.overflowWitness!].filter(Boolean) : [],
    [],
  ];
  const left = mergeWitnessPiecesLeft(pieces);
  const right = mergeWitnessPiecesRight(pieces);
  const balanced = mergeWitnessPiecesBalanced(pieces);
  check(summaryWitnessesEqual(left, right), "left/right merge shape");
  check(summaryWitnessesEqual(left, balanced), "left/balanced merge shape");
  check(left.length === 5, "merge retains fifth witness after overlap");

  for (const blockSize of fixture.blockSizes) {
    const corpus = buildOracleRanges(fixture.data.length, blockSize, 48, blockSize * 31337);
    check(corpus.ranges.length === 48, `range corpus B=${blockSize}`);
    for (const range of corpus.ranges) {
      const bounds = oracleQueryVisitBounds(fixture.data.length, blockSize, range);
      check(
        bounds.maximumRawBoundaryRows <= Math.min(range.end - range.start, blockSize * 2 - 2),
        `raw bound B=${blockSize}`,
      );
    }
  }
  return {
    passed: firstFailure === null,
    checks,
    blockSizes: fixture.blockSizes,
    mergeShapesCompared: ["left-deep", "right-deep", "balanced"],
    firstFailure,
  };
}

export function digestOracleSummaries(summaries: readonly OracleSummary[]): string {
  const encoded = new TextEncoder().encode(
    summaries.map((summary) => canonicalOracleSummary(summary)).join("\n"),
  );
  let hash = 0x811c9dc5;
  for (const byte of encoded) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function scanNumeric(
  data: GridData,
  physicalRows: Uint32Array | null,
  columnId: string,
  column: Extract<GridColumnData, { kind: "number" }>,
  start: number,
  end: number,
): OracleNumericSummary {
  let nullCount = 0;
  let finiteCount = 0;
  let nanCount = 0;
  let positiveInfinityCount = 0;
  let negativeInfinityCount = 0;
  let minimum: OracleExtremum | null = null;
  let maximum: OracleExtremum | null = null;
  for (let ordinal = start; ordinal < end; ordinal++) {
    const physicalRow = physicalRowAt(physicalRows, ordinal, data.length);
    if (!isValid(column.validity, physicalRow)) {
      nullCount++;
      continue;
    }
    const value = column.values.view[physicalRow]!;
    if (Number.isNaN(value)) {
      nanCount++;
      continue;
    }
    if (value === Infinity) {
      positiveInfinityCount++;
      continue;
    }
    if (value === -Infinity) {
      negativeInfinityCount++;
      continue;
    }
    finiteCount++;
    if (minimum === null || value < minimum.value) {
      minimum = extremum(data, value, ordinal, physicalRow);
    }
    if (maximum === null || value > maximum.value) {
      maximum = extremum(data, value, ordinal, physicalRow);
    }
    // Equal values deliberately retain the earlier active-view ordinal. This
    // includes +0/-0, so the chosen exemplar also determines the encoded sign.
  }
  return {
    kind: "numeric",
    columnId,
    start,
    end,
    rowCount: end - start,
    nullCount,
    finiteCount,
    nanCount,
    positiveInfinityCount,
    negativeInfinityCount,
    minimum,
    maximum,
  };
}

function scanCategory(
  data: GridData,
  physicalRows: Uint32Array | null,
  columnId: string,
  column: Extract<GridColumnData, { kind: "category" }>,
  start: number,
  end: number,
): OracleCategorySummary {
  let nullCount = 0;
  const seen = new Set<number>();
  const witnesses: OracleCategoryExemplar[] = [];
  for (let ordinal = start; ordinal < end; ordinal++) {
    const physicalRow = physicalRowAt(physicalRows, ordinal, data.length);
    if (!isValid(column.validity, physicalRow)) {
      nullCount++;
      continue;
    }
    const code = Number(column.codes.view[physicalRow]!);
    if (seen.has(code)) continue;
    seen.add(code);
    if (witnesses.length < INTERNAL_CATEGORY_WITNESSES) {
      witnesses.push({
        code,
        label: decodeUtf8Value(column.dictionary, code),
        activeViewOrdinal: ordinal,
        physicalRow,
        rowId: rowIdAt(data, physicalRow),
      });
    }
  }
  return {
    kind: "category",
    columnId,
    start,
    end,
    rowCount: end - start,
    nullCount,
    exemplars: witnesses.slice(0, PUBLIC_CATEGORY_EXEMPLARS),
    complete: witnesses.length <= PUBLIC_CATEGORY_EXEMPLARS,
    overflowWitness:
      witnesses.length === INTERNAL_CATEGORY_WITNESSES
        ? witnesses[PUBLIC_CATEGORY_EXEMPLARS]!
        : null,
  };
}

function normalizeRawCandidate(
  data: GridData,
  physicalRows: Uint32Array | null,
  raw: RawSummaryQueryResult,
): OracleSummaryCandidate {
  if (raw.kind === "numeric") {
    return {
      kind: "numeric",
      columnId: raw.columnId,
      start: raw.viewStart,
      end: raw.viewEnd,
      rowCount: raw.rowCount,
      nullCount: raw.nullCount,
      finiteCount: raw.finiteCount,
      nanCount: raw.nanCount,
      positiveInfinityCount: raw.positiveInfinityCount,
      negativeInfinityCount: raw.negativeInfinityCount,
      minimum: normalizeRawExtremum(data, physicalRows, raw.minimum),
      maximum: normalizeRawExtremum(data, physicalRows, raw.maximum),
    };
  }
  return {
    kind: "category",
    columnId: raw.columnId,
    start: raw.viewStart,
    end: raw.viewEnd,
    rowCount: raw.rowCount,
    nullCount: raw.nullCount,
    complete: raw.complete,
    exemplars: raw.exemplars.map((entry) =>
      normalizeRawCategoryExemplar(data, physicalRows, entry),
    ),
    overflowWitness: raw.overflowWitness
      ? normalizeRawCategoryExemplar(data, physicalRows, raw.overflowWitness)
      : null,
  };
}

function normalizeRawExtremum(
  data: GridData,
  physicalRows: Uint32Array | null,
  raw: RawSummaryExtremum | null,
): OracleCandidateExtremum | null {
  if (!raw) return null;
  const physicalRow = physicalRowAt(physicalRows, raw.viewOrdinal, data.length);
  if (raw.physicalRow !== physicalRow) {
    throw new RangeError(
      `Numeric exemplar physical row ${raw.physicalRow} does not match view ordinal ${raw.viewOrdinal}.`,
    );
  }
  return {
    value: raw.value,
    activeViewOrdinal: raw.viewOrdinal,
    physicalRow: raw.physicalRow,
    rowId: raw.rowId,
  };
}

function normalizeRawCategoryExemplar(
  data: GridData,
  physicalRows: Uint32Array | null,
  raw: RawSummaryCategoryExemplar,
): OracleCategoryExemplar {
  const physicalRow = physicalRowAt(physicalRows, raw.viewOrdinal, data.length);
  if (raw.physicalRow !== physicalRow) {
    throw new RangeError(
      `Category exemplar physical row ${raw.physicalRow} does not match view ordinal ${raw.viewOrdinal}.`,
    );
  }
  return {
    code: raw.code,
    label: raw.label,
    activeViewOrdinal: raw.viewOrdinal,
    physicalRow: raw.physicalRow,
    rowId: raw.rowId,
  };
}

function compareExtremum(
  actual: OracleCandidateExtremum | null,
  expected: OracleExtremum | null,
  label: string,
  same: (condition: boolean, message: string) => void,
): void {
  same((actual === null) === (expected === null), `${label} presence differs`);
  if (!actual || !expected) return;
  same(Object.is(actual.value, expected.value), `${label} value differs`);
  same(actual.activeViewOrdinal === expected.activeViewOrdinal, `${label} ordinal differs`);
  same(actual.physicalRow === expected.physicalRow, `${label} physical row differs`);
  same(rowIdsEqual(actual.rowId, expected.rowId), `${label} RowId differs`);
}

function compareCategoryExemplar(
  actual: OracleCategoryExemplar,
  expected: OracleCategoryExemplar,
  index: number,
  same: (condition: boolean, message: string) => void,
): void {
  same(actual.code === expected.code, `exemplar ${index} code differs`);
  same(actual.label === expected.label, `exemplar ${index} label differs`);
  same(
    actual.activeViewOrdinal === expected.activeViewOrdinal,
    `exemplar ${index} ordinal differs`,
  );
  same(actual.physicalRow === expected.physicalRow, `exemplar ${index} physical row differs`);
  same(rowIdsEqual(actual.rowId, expected.rowId), `exemplar ${index} RowId differs`);
}

function compareCategoryOverflow(
  actual: OracleCategoryExemplar | null,
  expected: OracleCategoryExemplar | null,
  same: (condition: boolean, message: string) => void,
): void {
  same((actual === null) === (expected === null), "overflow witness presence differs");
  if (actual && expected) compareCategoryExemplar(actual, expected, 4, same);
}

function extremum(
  data: GridData,
  value: number,
  activeViewOrdinal: number,
  physicalRow: number,
): OracleExtremum {
  return { value, activeViewOrdinal, physicalRow, rowId: rowIdAt(data, physicalRow) };
}

function physicalRowAt(
  physicalRows: Uint32Array | null,
  ordinal: number,
  physicalRowCount: number,
): number {
  const physicalRow = physicalRows ? physicalRows[ordinal] : ordinal;
  if (physicalRow === undefined || physicalRow >= physicalRowCount) {
    throw new RangeError(`Active-view ordinal ${ordinal} resolves outside the raw dataset.`);
  }
  return physicalRow;
}

function rowIdAt(data: GridData, physicalRow: number): RowId {
  const rowIds = data.rowIds;
  if (!rowIds) return physicalRow;
  if (rowIds.kind === "number") return Number(rowIds.values.view[physicalRow]!);
  if (rowIds.kind === "bigint") return rowIds.values.view[physicalRow]!;
  return decodeUtf8Value(rowIds, physicalRow);
}

function isValid(
  validity: Extract<GridColumnData, { kind: "number" | "category" }>["validity"],
  physicalRow: number,
): boolean {
  if (!validity) return true;
  const index = (validity.bitOffset ?? 0) + physicalRow;
  return (validity.bits.view[index >>> 3]! & (1 << (index & 7))) !== 0;
}

function decodeUtf8Value(buffers: Utf8Buffers, index: number): string {
  const offsets = buffers.offsets.view;
  if (!Number.isInteger(index) || index < 0 || index + 1 >= offsets.length) {
    throw new RangeError(`UTF-8 oracle index ${index} is outside its dictionary.`);
  }
  const start = Number(offsets[index]!);
  const end = Number(offsets[index + 1]!);
  return utf8Decoder.decode(buffers.data.view.subarray(start, end));
}

function assertRange(start: number, end: number, rowCount: number): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    end > rowCount
  ) {
    throw new RangeError(`Oracle range [${start}, ${end}) is outside [0, ${rowCount}).`);
  }
}

function rowIdsEqual(left: RowId, right: RowId): boolean {
  return (
    typeof left === typeof right &&
    (typeof left === "number" ? Object.is(left, right) : left === right)
  );
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function mix32(value: number): number {
  let mixed = value | 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

function identityRows(length: number): Uint32Array {
  const rows = new Uint32Array(length);
  for (let row = 0; row < length; row++) rows[row] = row;
  return rows;
}

function reorderFixtureRows(length: number): Uint32Array {
  const prefix = [4, 3, 8, 7, 6, 5, 1, 2, 10, 12, 0, 9];
  const used = new Set(prefix);
  const rows = prefix.slice();
  for (let row = length - 1; row >= 0; row--) if (!used.has(row)) rows.push(row);
  return Uint32Array.from(rows);
}

function setValidity(bits: Uint8Array, index: number, valid: boolean): void {
  if (valid) bits[index >>> 3]! |= 1 << (index & 7);
  else bits[index >>> 3]! &= ~(1 << (index & 7));
}

function buildFixtureDictionary(length: number): Utf8Buffers {
  const encoder = new TextEncoder();
  const labels = Array.from({ length }, (_, code) => {
    if (code === 0) return "zeta-000";
    if (code === 1) return "alpha-001";
    return `code-${String(code).padStart(3, "0")}`;
  });
  const encoded = labels.map((label) => encoder.encode(label));
  const offsets = new Uint32Array(length + 1);
  const data = new Uint8Array(encoded.reduce((total, value) => total + value.length, 0));
  let cursor = 0;
  for (let code = 0; code < encoded.length; code++) {
    offsets[code] = cursor;
    data.set(encoded[code]!, cursor);
    cursor += encoded[code]!.length;
  }
  offsets[length] = cursor;
  return { offsets: { view: offsets }, data: { view: data } };
}

function mergeWitnesses(
  left: readonly OracleCategoryExemplar[],
  right: readonly OracleCategoryExemplar[],
): OracleCategoryExemplar[] {
  const output = left.slice(0, INTERNAL_CATEGORY_WITNESSES);
  const seen = new Set(output.map((entry) => entry.code));
  for (const entry of right) {
    if (seen.has(entry.code)) continue;
    seen.add(entry.code);
    output.push(entry);
    if (output.length === INTERNAL_CATEGORY_WITNESSES) break;
  }
  return output;
}

function mergeWitnessPiecesLeft(
  pieces: readonly (readonly OracleCategoryExemplar[])[],
): OracleCategoryExemplar[] {
  let result: OracleCategoryExemplar[] = [];
  for (const piece of pieces) result = mergeWitnesses(result, piece);
  return result;
}

function mergeWitnessPiecesRight(
  pieces: readonly (readonly OracleCategoryExemplar[])[],
  index = 0,
): OracleCategoryExemplar[] {
  return index >= pieces.length
    ? []
    : mergeWitnesses(pieces[index]!, mergeWitnessPiecesRight(pieces, index + 1));
}

function mergeWitnessPiecesBalanced(
  pieces: readonly (readonly OracleCategoryExemplar[])[],
  start = 0,
  end = pieces.length,
): OracleCategoryExemplar[] {
  if (start >= end) return [];
  if (end - start === 1) return pieces[start]!.slice();
  const middle = (start + end) >>> 1;
  return mergeWitnesses(
    mergeWitnessPiecesBalanced(pieces, start, middle),
    mergeWitnessPiecesBalanced(pieces, middle, end),
  );
}

function summaryWitnessesEqual(
  left: readonly OracleCategoryExemplar[],
  right: readonly OracleCategoryExemplar[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.code === right[index]?.code &&
        entry.physicalRow === right[index]?.physicalRow &&
        rowIdsEqual(entry.rowId, right[index]!.rowId),
    )
  );
}

function canonicalOracleSummary(summary: OracleSummary): string {
  const scalar = (value: number): string => {
    if (Number.isNaN(value)) return "nan";
    if (value === Infinity) return "+inf";
    if (value === -Infinity) return "-inf";
    if (Object.is(value, -0)) return "-0";
    return String(value);
  };
  const rowId = (value: RowId): string => `${typeof value}:${String(value)}`;
  if (summary.kind === "numeric") {
    const extremum = (value: OracleExtremum | null): string =>
      value
        ? `${scalar(value.value)}@${value.activeViewOrdinal}:${value.physicalRow}:${rowId(value.rowId)}`
        : "null";
    return [
      summary.kind,
      summary.columnId,
      summary.start,
      summary.end,
      summary.rowCount,
      summary.nullCount,
      summary.finiteCount,
      summary.nanCount,
      summary.positiveInfinityCount,
      summary.negativeInfinityCount,
      extremum(summary.minimum),
      extremum(summary.maximum),
    ].join("|");
  }
  return [
    summary.kind,
    summary.columnId,
    summary.start,
    summary.end,
    summary.rowCount,
    summary.nullCount,
    summary.complete,
    ...summary.exemplars.map(
      (entry) =>
        `${entry.code}:${entry.label}:${entry.activeViewOrdinal}:${entry.physicalRow}:${rowId(entry.rowId)}`,
    ),
    summary.overflowWitness
      ? `overflow:${summary.overflowWitness.code}:${summary.overflowWitness.physicalRow}`
      : "overflow:null",
  ].join("|");
}
