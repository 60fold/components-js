import type {
  GridBenchmarkOrdinaryCaseId,
  GridBenchmarkOracleValidation,
  GridBenchmarkProfileMetadata,
} from "./contracts";

interface CandidateBuffers {
  readonly physicalRows: Uint32Array;
  readonly filterBitmap: Uint8Array | null;
}

// Kept independently of profiles.ts on purpose: the oracle does not inspect
// GridDataStore, production typed-column accessors, or the generated buffers.
const CATEGORY_32_LABEL_BY_CODE = Object.freeze([
  17, 3, 1, 30, 2, 14, 9, 31, 7, 15, 11, 0, 20, 6, 13, 23, 4, 19, 5, 22, 21, 10, 16, 29, 25, 28, 27,
  8, 12, 26, 18, 24,
]);

export function validateBenchmarkCandidate(
  profile: GridBenchmarkProfileMetadata,
  caseId: GridBenchmarkOrdinaryCaseId,
  candidate: CandidateBuffers,
): GridBenchmarkOracleValidation {
  const rowCount = profile.rows;
  const filtered = caseId !== "sort-1-key";
  const expectedBitmapBytes = Math.ceil(rowCount / 8);
  const seen = new Uint8Array(expectedBitmapBytes);
  let expectedRowCount = 0;
  let bitmapMatchesPredicate = filtered
    ? candidate.filterBitmap?.length === expectedBitmapBytes
    : candidate.filterBitmap === null;
  let firstFailure: string | null = null;
  const fail = (message: string): void => {
    if (firstFailure === null) firstFailure = message;
  };

  for (let row = 0; row < rowCount; row++) {
    const expected = matchesFilter(profile.id, caseId, row);
    if (expected) expectedRowCount++;
    if (filtered) {
      const actual = candidate.filterBitmap ? bitIsSet(candidate.filterBitmap, row) : false;
      if (actual !== expected) {
        bitmapMatchesPredicate = false;
        fail(`filter bitmap differs from the oracle at physical row ${row}`);
      }
    }
  }

  let bitmapUnusedBitsClear = true;
  if (filtered && candidate.filterBitmap && rowCount % 8 !== 0) {
    const usedMask = (1 << (rowCount % 8)) - 1;
    bitmapUnusedBitsClear =
      (candidate.filterBitmap[candidate.filterBitmap.length - 1]! & ~usedMask) === 0;
    if (!bitmapUnusedBitsClear)
      fail("filter bitmap has non-zero bits beyond the physical row count");
  }

  let physicalRowsInBounds = true;
  let physicalRowsUnique = true;
  let candidateRowsMatchPredicate = true;
  let orderMatchesSpec = true;
  let stablePhysicalTieBreak = true;
  let previous: number | null = null;
  for (let ordinal = 0; ordinal < candidate.physicalRows.length; ordinal++) {
    const row = candidate.physicalRows[ordinal]!;
    if (row >= rowCount) {
      physicalRowsInBounds = false;
      fail(`candidate ordinal ${ordinal} contains out-of-range physical row ${row}`);
      continue;
    }
    if (bitIsSet(seen, row)) {
      physicalRowsUnique = false;
      fail(`physical row ${row} appears more than once in the candidate permutation`);
    } else {
      setBit(seen, row);
    }
    if (!matchesFilter(profile.id, caseId, row)) {
      candidateRowsMatchPredicate = false;
      fail(`candidate includes physical row ${row}, which fails the independent predicate`);
    }
    if (previous !== null) {
      const keyComparison = compareSortKeys(profile.id, caseId, previous, row);
      if (keyComparison > 0) {
        orderMatchesSpec = false;
        fail(`candidate order decreases between physical rows ${previous} and ${row}`);
      } else if (keyComparison === 0 && previous > row) {
        stablePhysicalTieBreak = false;
        orderMatchesSpec = false;
        fail(`equal keys reverse physical ingestion order at rows ${previous} and ${row}`);
      }
    }
    previous = row;
  }

  const membershipMatchesPredicate =
    candidateRowsMatchPredicate &&
    physicalRowsInBounds &&
    physicalRowsUnique &&
    candidate.physicalRows.length === expectedRowCount;
  if (candidate.physicalRows.length !== expectedRowCount) {
    fail(
      `candidate row count ${candidate.physicalRows.length} differs from oracle count ${expectedRowCount}`,
    );
  }
  if (!bitmapMatchesPredicate)
    fail("filter bitmap does not exactly match the independent predicate");

  const passed =
    physicalRowsInBounds &&
    physicalRowsUnique &&
    membershipMatchesPredicate &&
    bitmapMatchesPredicate &&
    bitmapUnusedBitsClear &&
    orderMatchesSpec &&
    stablePhysicalTieBreak;
  return {
    scope: "full-result-independent-formula-oracle",
    passed,
    expectedRowCount,
    actualRowCount: candidate.physicalRows.length,
    inspectedPhysicalRows: candidate.physicalRows.length,
    inspectedBitmapRows: rowCount,
    inspectedAdjacentPairs: Math.max(0, candidate.physicalRows.length - 1),
    physicalRowsInBounds,
    physicalRowsUnique,
    membershipMatchesPredicate,
    bitmapMatchesPredicate,
    bitmapUnusedBitsClear,
    orderMatchesSpec,
    stablePhysicalTieBreak,
    firstFailure,
  };
}

export function oracleVerificationScratchBytes(profile: GridBenchmarkProfileMetadata): number {
  return Math.ceil(profile.rows / 8);
}

function matchesFilter(
  profile: GridBenchmarkProfileMetadata["id"],
  caseId: GridBenchmarkOrdinaryCaseId,
  row: number,
): boolean {
  if (caseId === "sort-1-key") return true;
  if (caseId === "filter-numeric") {
    const value = isNarrowProfile(profile) ? narrowValue0(row) : wideNumber(0, row);
    return value >= 25_000 && value <= 74_999;
  }
  if (caseId === "filter-category") {
    const label = CATEGORY_32_LABEL_BY_CODE[category0Code(row)]!;
    return label === 3 || label === 7 || label === 11 || label === 19;
  }
  const value = isNarrowProfile(profile)
    ? ((mix32Independent(row) >>> 7) + (row % 997)) % 65_521
    : wideNumber(1, row);
  return value >= 0 && value <= 16_383;
}

function compareSortKeys(
  profile: GridBenchmarkProfileMetadata["id"],
  caseId: GridBenchmarkOrdinaryCaseId,
  leftRow: number,
  rightRow: number,
): number {
  if (caseId === "filter-numeric" || caseId === "filter-category") {
    // Filter-only candidates must remain in physical ingestion order.
    return leftRow < rightRow ? -1 : leftRow > rightRow ? 1 : 0;
  }
  if (caseId === "sort-1-key") {
    return compareNumber(
      isNarrowProfile(profile) ? narrowValue0(leftRow) : wideNumber(0, leftRow),
      isNarrowProfile(profile) ? narrowValue0(rightRow) : wideNumber(0, rightRow),
    );
  }

  const categoryComparison = compareNumber(
    CATEGORY_32_LABEL_BY_CODE[category0Code(leftRow)]!,
    CATEGORY_32_LABEL_BY_CODE[category0Code(rightRow)]!,
  );
  if (categoryComparison !== 0) return categoryComparison;
  const leftInteger = isNarrowProfile(profile)
    ? (leftRow % 20_001) - 10_000
    : (mix32Independent(leftRow) % 20_001) - 10_000;
  const rightInteger = isNarrowProfile(profile)
    ? (rightRow % 20_001) - 10_000
    : (mix32Independent(rightRow) % 20_001) - 10_000;
  const descendingIntegerComparison = -compareNumber(leftInteger, rightInteger);
  if (descendingIntegerComparison !== 0) return descendingIntegerComparison;
  return compareNumber(
    isNarrowProfile(profile) ? narrowValue0(leftRow) : wideNumber(0, leftRow),
    isNarrowProfile(profile) ? narrowValue0(rightRow) : wideNumber(0, rightRow),
  );
}

function narrowValue0(row: number): number {
  return mix32Independent(row) % 100_003;
}

function isNarrowProfile(profile: GridBenchmarkProfileMetadata["id"]): boolean {
  return profile === "narrow-10m";
}

function wideNumber(column: number, row: number): number {
  return Math.fround((mix32Independent(row + column * 0x9e37) % 100_003) + column / 64);
}

function category0Code(row: number): number {
  return mix32Independent(row) & 31;
}

function compareNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mix32Independent(value: number): number {
  let mixed = value | 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

function bitIsSet(bitmap: Uint8Array, index: number): boolean {
  return (bitmap[index >> 3]! & (1 << (index & 7))) !== 0;
}

function setBit(bitmap: Uint8Array, index: number): void {
  bitmap[index >> 3]! |= 1 << (index & 7);
}
