import { describe, expect, it } from "vitest";
import type { GridData } from "../../../packages/grid/src/types.js";
import {
  buildOracleExpectations,
  buildOracleEdgeFixture,
  buildOracleRanges,
  compareOracleSummary,
  oracleQueryVisitBounds,
  rawScanSummary,
  runEdgeFixtureOracle,
  runOracleSelfCheck,
  subsetOracleExpectations,
  validateSummaryCandidate,
  validateSummaryCandidateAgainstExpectations,
  type OracleCategorySummary,
  type OracleNumericSummary,
  type OracleSummary,
  type RawSummaryQueryResult,
} from "./oracle.js";

describe("grid summary independent raw oracle", () => {
  it("self-checks signed zero, special values, fifth witnesses, merge shapes, and B=257", () => {
    const result = runOracleSelfCheck();
    expect(result).toMatchObject({
      passed: true,
      blockSizes: [3, 7, 257],
      mergeShapesCompared: ["left-deep", "right-deep", "balanced"],
      firstFailure: null,
    });
    expect(result.checks).toBeGreaterThan(100);
  });

  it("counts null and floating-point states without letting specials enter extrema", () => {
    const fixture = buildOracleEdgeFixture();
    const summary = rawScanSummary(
      fixture.data,
      fixture.views.identity,
      "numeric",
      0,
      13,
    ) as OracleNumericSummary;
    expect(summary).toMatchObject({
      kind: "numeric",
      rowCount: 13,
      nullCount: 1,
      finiteCount: 8,
      nanCount: 2,
      positiveInfinityCount: 1,
      negativeInfinityCount: 1,
    });
    expect(summary.minimum).toMatchObject({ value: -7, activeViewOrdinal: 5, physicalRow: 5 });
    expect(summary.maximum).toMatchObject({ value: 42, activeViewOrdinal: 7, physicalRow: 7 });
    expect(typeof summary.minimum?.rowId).toBe("bigint");
  });

  it("uses the first active-view tie and preserves the chosen signed zero", () => {
    const fixture = buildOracleEdgeFixture();
    const identity = rawScanSummary(
      fixture.data,
      fixture.views.identity,
      "numeric",
      3,
      5,
    ) as OracleNumericSummary;
    expect(Object.is(identity.minimum?.value, -0)).toBe(true);
    expect(Object.is(identity.maximum?.value, -0)).toBe(true);
    expect(identity.minimum?.physicalRow).toBe(3);

    const reordered = rawScanSummary(
      fixture.data,
      fixture.views.reordered,
      "numeric",
      0,
      2,
    ) as OracleNumericSummary;
    expect(Object.is(reordered.minimum?.value, +0)).toBe(true);
    expect(Object.is(reordered.maximum?.value, +0)).toBe(true);
    expect(reordered.minimum?.physicalRow).toBe(4);
  });

  it("orders category witnesses by first code occurrence rather than label collation", () => {
    const fixture = buildOracleEdgeFixture();
    const four = rawScanSummary(
      fixture.data,
      fixture.views.identity,
      "category",
      0,
      5,
    ) as OracleCategorySummary;
    expect(four.complete).toBe(true);
    expect(four.exemplars.map(({ code }) => code)).toEqual([0, 1, 2, 3]);
    expect(four.exemplars[0]?.label).toBe("zeta-000");
    expect(four.exemplars[1]?.label).toBe("alpha-001");

    const five = rawScanSummary(
      fixture.data,
      fixture.views.identity,
      "category",
      0,
      6,
    ) as OracleCategorySummary;
    expect(five.complete).toBe(false);
    expect(five.exemplars.map(({ code }) => code)).toEqual([0, 1, 2, 3]);
    expect(five.overflowWitness?.code).toBe(4);
    const high = rawScanSummary(
      fixture.data,
      fixture.views.identity,
      "category",
      9,
      10,
    ) as OracleCategorySummary;
    expect(high.exemplars[0]).toMatchObject({ code: 255, label: "code-255" });
  });

  it("compares every field and rejects a wrong first-tie exemplar despite equal value", () => {
    const fixture = buildOracleEdgeFixture();
    const expected = rawScanSummary(
      fixture.data,
      fixture.views.identity,
      "numeric",
      5,
      7,
    ) as OracleNumericSummary;
    const wrong = {
      ...expected,
      minimum: { ...expected.minimum!, activeViewOrdinal: 6, physicalRow: 6, rowId: 10_000_102n },
    };
    expect(compareOracleSummary(wrong, expected)).toEqual({
      passed: false,
      firstFailure: "minimum ordinal differs",
    });
  });

  it("validates a structural subject adapter without importing subject helpers", () => {
    const fixture = buildOracleEdgeFixture();
    const ranges = buildOracleRanges(fixture.data.length, 257, 64).ranges;
    const query = rawQueryAdapter(fixture.data, fixture.views.reordered);
    const result = validateSummaryCandidate(
      fixture.data,
      fixture.views.reordered,
      ["numeric", "category"],
      ranges,
      query,
    );
    expect(result.passed).toBe(true);
    expect(result.summariesCompared).toBe(128);
    expect(result.rawRowsScanned).toBeGreaterThan(fixture.data.length * 2);
    expect(result.digest).toMatch(/^[a-f0-9]{8}$/);
  });

  it("reuses one raw-scan expectation cache across first and replacement candidates", () => {
    const fixture = buildOracleEdgeFixture();
    const ranges = buildOracleRanges(fixture.views.discontiguous.length, 7, 32).ranges;
    const expectations = buildOracleExpectations(
      fixture.data,
      fixture.views.discontiguous,
      ["numeric", "category"],
      ranges,
    );
    const query = rawQueryAdapter(fixture.data, fixture.views.discontiguous);
    const first = validateSummaryCandidateAgainstExpectations(
      fixture.data,
      fixture.views.discontiguous,
      expectations,
      query,
    );
    const replacement = validateSummaryCandidateAgainstExpectations(
      fixture.data,
      fixture.views.discontiguous,
      expectations,
      query,
    );
    expect(first).toEqual(replacement);
    expect(first.rawRowsScanned).toBe(expectations.rawRowsScanned);
    expect(first.summariesCompared).toBe(expectations.summaries);
  });

  it("derives a bound two-column cache without rescanning or losing source identity", () => {
    const fixture = buildOracleEdgeFixture();
    const ranges = buildOracleRanges(fixture.views.reordered.length, 257, 32).ranges;
    const all = buildOracleExpectations(
      fixture.data,
      fixture.views.reordered,
      ["numeric", "category"],
      ranges,
    );
    const numeric = subsetOracleExpectations(all, ["numeric"]);
    expect(numeric.summaries).toBe(ranges.length);
    expect(numeric.rawRowsScanned * 2).toBe(all.rawRowsScanned);
    expect(
      validateSummaryCandidateAgainstExpectations(
        fixture.data,
        fixture.views.reordered,
        numeric,
        rawQueryAdapter(fixture.data, fixture.views.reordered),
      ).passed,
    ).toBe(true);
    expect(() => subsetOracleExpectations(all, ["missing"])).toThrow(/do not contain/);
    expect(() =>
      validateSummaryCandidateAgainstExpectations(
        fixture.data,
        fixture.views.identity,
        numeric,
        rawQueryAdapter(fixture.data, fixture.views.identity),
      ),
    ).toThrow(/exact data and view objects/);
  });

  it("records a subject failure instead of making failure unrepresentable", () => {
    const fixture = buildOracleEdgeFixture();
    const range = [{ start: 0, end: 6, kind: "arbitrary" as const }];
    const valid = rawQueryAdapter(fixture.data, fixture.views.identity);
    const result = validateSummaryCandidate(
      fixture.data,
      fixture.views.identity,
      ["category"],
      range,
      (columnId, start, end) => {
        const candidate = valid(columnId, start, end);
        if (candidate.kind !== "category") return candidate;
        return { ...candidate, complete: true, overflowWitness: null };
      },
    );
    expect(result).toMatchObject({
      passed: false,
      summariesCompared: 1,
      firstFailure: "category [0, 6): complete differs",
    });
  });

  it("rejects an engine exemplar whose physical row disagrees with its view ordinal", () => {
    const fixture = buildOracleEdgeFixture();
    const valid = rawQueryAdapter(fixture.data, fixture.views.reordered);
    const result = validateSummaryCandidate(
      fixture.data,
      fixture.views.reordered,
      ["numeric"],
      [{ start: 0, end: 2, kind: "arbitrary" }],
      (columnId, start, end) => {
        const candidate = valid(columnId, start, end);
        if (candidate.kind !== "numeric" || !candidate.minimum) return candidate;
        return {
          ...candidate,
          minimum: { ...candidate.minimum, physicalRow: candidate.minimum.physicalRow + 1 },
        };
      },
    );
    expect(result.passed).toBe(false);
    expect(result.firstFailure).toMatch(/physical row .* does not match view ordinal/);
  });

  it("derives tight arbitrary-boundary and non-power-of-two tree bounds", () => {
    const bounds = oracleQueryVisitBounds(600, 257, { start: 1, end: 513 });
    expect(bounds).toEqual({
      maximumRawBoundaryRows: 512,
      maximumCoveredNodeVisits: 4,
      leafCount: 3,
      treeBase: 4,
    });
    const empty = oracleQueryVisitBounds(600, 257, { start: 12, end: 12 });
    expect(empty.maximumRawBoundaryRows).toBe(0);
    expect(empty.maximumCoveredNodeVisits).toBe(0);
  });

  it("runs the oracle-owned edge fixture against an asynchronous production-shaped factory", async () => {
    const result = await runEdgeFixtureOracle(async (data, physicalRows) => ({
      query: rawQueryAdapter(data, physicalRows),
    }));
    expect(result.passed).toBe(true);
    expect(result.viewsCompared).toBe(12);
    expect(result.candidateComparisons).toBeGreaterThan(0);
  });
});

function rawQueryAdapter(data: GridData, physicalRows: Uint32Array) {
  return (columnId: string, start: number, end: number): RawSummaryQueryResult =>
    toRawQuery(rawScanSummary(data, physicalRows, columnId, start, end));
}

function toRawQuery(summary: OracleSummary): RawSummaryQueryResult {
  if (summary.kind === "numeric") {
    const extremum = (value: OracleNumericSummary["minimum"]) =>
      value
        ? {
            value: value.value,
            rowId: value.rowId,
            viewOrdinal: value.activeViewOrdinal,
            physicalRow: value.physicalRow,
          }
        : null;
    return {
      columnId: summary.columnId,
      kind: "numeric",
      exact: true,
      rowCount: summary.rowCount,
      nullCount: summary.nullCount,
      viewStart: summary.start,
      viewEnd: summary.end,
      finiteCount: summary.finiteCount,
      nanCount: summary.nanCount,
      positiveInfinityCount: summary.positiveInfinityCount,
      negativeInfinityCount: summary.negativeInfinityCount,
      minimum: extremum(summary.minimum),
      maximum: extremum(summary.maximum),
    };
  }
  const exemplar = (value: OracleCategorySummary["exemplars"][number]) => ({
    code: value.code,
    label: value.label,
    rowId: value.rowId,
    viewOrdinal: value.activeViewOrdinal,
    physicalRow: value.physicalRow,
  });
  return {
    columnId: summary.columnId,
    kind: "category",
    exact: true,
    rowCount: summary.rowCount,
    nullCount: summary.nullCount,
    viewStart: summary.start,
    viewEnd: summary.end,
    exemplars: summary.exemplars.map(exemplar),
    complete: summary.complete,
    overflowWitness: summary.overflowWitness ? exemplar(summary.overflowWitness) : null,
  };
}
