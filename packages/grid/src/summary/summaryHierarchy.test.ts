import { describe, expect, it } from "vitest";
import { GridDataStore } from "../data/store";
import type { RowId, Utf8Buffers } from "../types";
import {
  buildGridSummaryHierarchyAsync,
  publishGridSummaryHierarchyCandidate,
  type GridSummaryAsyncBuildOptions,
  type GridCategorySummaryQueryResult,
  type GridNumericSummaryQueryResult,
  type GridSummaryBuildResult,
  type GridSummaryHierarchyCandidate,
  type GridSummaryView,
} from "./summaryHierarchy";

const BLOCK_SIZE = 4;

function utf8(values: readonly string[]): Utf8Buffers {
  const encoder = new TextEncoder();
  const encoded = values.map((value) => encoder.encode(value));
  const offsets = new Uint32Array(values.length + 1);
  let byteLength = 0;
  for (let index = 0; index < encoded.length; index++) {
    byteLength += encoded[index]!.length;
    offsets[index + 1] = byteLength;
  }
  const data = new Uint8Array(byteLength);
  let offset = 0;
  for (const value of encoded) {
    data.set(value, offset);
    offset += value.length;
  }
  return { offsets: { view: offsets }, data: { view: data } };
}

function validity(valid: readonly boolean[]): Uint8Array {
  const bits = new Uint8Array(Math.ceil(valid.length / 8));
  for (let index = 0; index < valid.length; index++) {
    if (valid[index]) bits[index >>> 3]! |= 1 << (index & 7);
  }
  return bits;
}

interface Fixture {
  readonly store: GridDataStore;
  readonly numbers: Float64Array;
  readonly codes: Uint8Array;
  readonly labels: readonly string[];
  readonly valid: readonly boolean[];
  readonly rowIds: readonly string[];
}

function exactFixture(): Fixture {
  const numbers = new Float64Array([
    7,
    Number.NaN,
    -3,
    Number.POSITIVE_INFINITY,
    -3,
    11,
    Number.NEGATIVE_INFINITY,
    4,
    11,
    -0,
    0,
    8,
    Number.NaN,
    -9,
    2,
    Number.POSITIVE_INFINITY,
    6,
    -9,
    5,
  ]);
  const codes = new Uint8Array([0, 1, 2, 3, 4, 5, 0, 2, 1, 4, 3, 5, 2, 0, 4, 1, 5, 3, 2]);
  const labels = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  const valid = [
    true,
    false,
    true,
    true,
    true,
    true,
    true,
    false,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
    true,
    true,
    true,
    true,
  ];
  const rowIds = Array.from({ length: numbers.length }, (_, index) => `row-${index}`);
  const store = new GridDataStore();
  store.install({
    length: numbers.length,
    rowIds: { kind: "string", ...utf8(rowIds) },
    columns: [
      {
        schema: { id: "value", kind: "number", nullable: true },
        data: {
          kind: "number",
          values: { view: numbers },
          validity: { bits: { view: validity(valid) } },
        },
      },
      {
        schema: { id: "category", kind: "category", nullable: true },
        data: {
          kind: "category",
          codes: { view: codes },
          dictionary: utf8(labels),
          validity: { bits: { view: validity(valid) } },
        },
      },
    ],
  });
  return { store, numbers, codes, labels, valid, rowIds };
}

function viewFor(
  store: GridDataStore,
  physicalRows: Uint32Array | null,
  viewRevision = 3,
): GridSummaryView {
  return {
    datasetId: requireDatasetId(store),
    viewRevision,
    rowCount: physicalRows?.length ?? store.rowCount,
    physicalRows,
  };
}

function options(
  columns: readonly string[] = ["value", "category"],
  overrides: Partial<GridSummaryAsyncBuildOptions> = {},
): GridSummaryAsyncBuildOptions {
  return {
    requestId: 7,
    dataRevision: 5,
    columns,
    blockSize: BLOCK_SIZE,
    ...overrides,
  };
}

function candidate(result: GridSummaryBuildResult): GridSummaryHierarchyCandidate {
  if (result.status !== "complete") throw new Error("Expected a completed summary build.");
  return result.candidate;
}

async function buildCandidate(
  store: GridDataStore,
  view: GridSummaryView,
  buildOptions: GridSummaryAsyncBuildOptions,
): Promise<GridSummaryHierarchyCandidate> {
  return candidate(
    await buildGridSummaryHierarchyAsync(store, view, {
      ...buildOptions,
      yieldControl: () => Promise.resolve(),
    }),
  );
}

function numeric(
  hierarchy: GridSummaryHierarchyCandidate,
  start: number,
  end: number,
): GridNumericSummaryQueryResult {
  const result = hierarchy.query("value", start, end);
  if (result.kind !== "numeric") throw new Error("Expected a numeric summary.");
  return result;
}

function category(
  hierarchy: GridSummaryHierarchyCandidate,
  start: number,
  end: number,
): GridCategorySummaryQueryResult {
  const result = hierarchy.query("category", start, end);
  if (result.kind !== "category") throw new Error("Expected a category summary.");
  return result;
}

interface NumericOracle {
  nullCount: number;
  finiteCount: number;
  nanCount: number;
  positiveInfinityCount: number;
  negativeInfinityCount: number;
  finiteMinimum: {
    value: number;
    viewOrdinal: number;
    physicalRow: number;
    rowId: RowId;
  } | null;
  finiteMaximum: {
    value: number;
    viewOrdinal: number;
    physicalRow: number;
    rowId: RowId;
  } | null;
}

function numericOracle(
  fixture: Fixture,
  view: GridSummaryView,
  start: number,
  end: number,
): NumericOracle {
  const result: NumericOracle = {
    nullCount: 0,
    finiteCount: 0,
    nanCount: 0,
    positiveInfinityCount: 0,
    negativeInfinityCount: 0,
    finiteMinimum: null,
    finiteMaximum: null,
  };
  for (let ordinal = start; ordinal < end; ordinal++) {
    const physical = view.physicalRows?.[ordinal] ?? ordinal;
    if (!fixture.valid[physical]) {
      result.nullCount++;
      continue;
    }
    const value = fixture.numbers[physical]!;
    if (Number.isNaN(value)) result.nanCount++;
    else if (value === Number.POSITIVE_INFINITY) result.positiveInfinityCount++;
    else if (value === Number.NEGATIVE_INFINITY) result.negativeInfinityCount++;
    else {
      result.finiteCount++;
      if (result.finiteMinimum === null || value < result.finiteMinimum.value) {
        result.finiteMinimum = {
          value,
          viewOrdinal: ordinal,
          physicalRow: physical,
          rowId: fixture.rowIds[physical]!,
        };
      }
      if (result.finiteMaximum === null || value > result.finiteMaximum.value) {
        result.finiteMaximum = {
          value,
          viewOrdinal: ordinal,
          physicalRow: physical,
          rowId: fixture.rowIds[physical]!,
        };
      }
    }
  }
  return result;
}

function categoryOracle(
  fixture: Fixture,
  view: GridSummaryView,
  start: number,
  end: number,
): Omit<
  GridCategorySummaryQueryResult,
  | "datasetId"
  | "requestId"
  | "dataRevision"
  | "viewRevision"
  | "columnId"
  | "start"
  | "end"
  | "rowCount"
  | "exact"
  | "stats"
  | "kind"
> {
  let nullCount = 0;
  const seen = new Set<number>();
  const witnesses: GridCategorySummaryQueryResult["exemplars"][number][] = [];
  for (let ordinal = start; ordinal < end; ordinal++) {
    const physical = view.physicalRows?.[ordinal] ?? ordinal;
    if (!fixture.valid[physical]) {
      nullCount++;
      continue;
    }
    const code = fixture.codes[physical]!;
    if (seen.has(code)) continue;
    seen.add(code);
    if (witnesses.length < 5) {
      witnesses.push({
        code,
        label: fixture.labels[code]!,
        viewOrdinal: ordinal,
        physicalRow: physical,
        rowId: fixture.rowIds[physical]!,
      });
    }
  }
  return {
    nullCount,
    exemplars: witnesses.slice(0, 4),
    complete: witnesses.length <= 4,
    overflowWitness: witnesses.length >= 5 ? witnesses[4]! : null,
  };
}

function requireDatasetId(store: GridDataStore): string {
  const datasetId = store.datasetId;
  if (!datasetId) throw new Error("Fixture dataset was not installed.");
  return datasetId;
}

function summaryIdentity(hierarchy: GridSummaryHierarchyCandidate) {
  return {
    datasetId: hierarchy.datasetId,
    requestId: hierarchy.requestId,
    dataRevision: hierarchy.dataRevision,
    viewRevision: hierarchy.viewRevision,
  };
}

describe("Grid summary hierarchy", () => {
  it("matches independent numeric and category scans for every identity-view range", async () => {
    const fixture = exactFixture();
    const view = viewFor(fixture.store, null);
    const hierarchy = await buildCandidate(fixture.store, view, options());

    expect(hierarchy.buildStats.viewPermutationBytes).toBe(0);
    expect(hierarchy.rowCount).toBe(19);
    // Five leaves form compact levels [5, 3, 2, 1], not a padded eight-leaf tree.
    expect(hierarchy.buildStats.columns).toEqual([
      {
        columnId: "value",
        kind: "numeric",
        retainedBytes: 11 * 52,
        leafNodes: 5,
        interiorNodes: 6,
      },
      {
        columnId: "category",
        kind: "category",
        retainedBytes: 11 * 65,
        leafNodes: 5,
        interiorNodes: 6,
      },
    ]);
    expect(hierarchy.retainedBytes).toBe(11 * (52 + 65));
    expect(hierarchy.buildStats.peakCandidateBytes).toBe(hierarchy.retainedBytes);
    expect(category(hierarchy, 0, view.rowCount)).toMatchObject({
      complete: false,
      overflowWitness: { code: 5, label: "foxtrot", viewOrdinal: 5, physicalRow: 5 },
    });

    const maximumNodeVisits = 2 * Math.ceil(Math.log2(5));
    for (let start = 0; start <= view.rowCount; start++) {
      for (let end = start; end <= view.rowCount; end++) {
        const actualNumeric = numeric(hierarchy, start, end);
        const expectedNumeric = numericOracle(fixture, view, start, end);
        expect(
          {
            nullCount: actualNumeric.nullCount,
            finiteCount: actualNumeric.finiteCount,
            nanCount: actualNumeric.nanCount,
            positiveInfinityCount: actualNumeric.positiveInfinityCount,
            negativeInfinityCount: actualNumeric.negativeInfinityCount,
            finiteMinimum: actualNumeric.finiteMinimum,
            finiteMaximum: actualNumeric.finiteMaximum,
          },
          `numeric [${start}, ${end})`,
        ).toEqual(expectedNumeric);

        const actualCategory = category(hierarchy, start, end);
        expect(
          {
            nullCount: actualCategory.nullCount,
            exemplars: actualCategory.exemplars,
            complete: actualCategory.complete,
            overflowWitness: actualCategory.overflowWitness,
          },
          `category [${start}, ${end})`,
        ).toEqual(categoryOracle(fixture, view, start, end));

        for (const stats of [actualNumeric.stats, actualCategory.stats]) {
          expect(stats.rawRowsScanned).toBeLessThanOrEqual(
            Math.min(end - start, 2 * BLOCK_SIZE - 2),
          );
          expect(stats.nodeVisits).toBeLessThanOrEqual(maximumNodeVisits);
        }
      }
    }
  });

  it("preserves first-in-active-view provenance through a filtered permutation", async () => {
    const fixture = exactFixture();
    const physicalRows = new Uint32Array([17, 13, 4, 2, 8, 5, 0, 18, 16, 10, 9, 12, 3]);
    const view = viewFor(fixture.store, physicalRows, 9);
    const hierarchy = await buildCandidate(fixture.store, view, options());

    expect(hierarchy.buildStats.viewPermutationBytes).toBe(physicalRows.byteLength);
    for (let start = 0; start <= view.rowCount; start++) {
      for (let end = start; end <= view.rowCount; end++) {
        const actualNumeric = numeric(hierarchy, start, end);
        const expectedNumeric = numericOracle(fixture, view, start, end);
        expect(actualNumeric.finiteMinimum).toEqual(expectedNumeric.finiteMinimum);
        expect(actualNumeric.finiteMaximum).toEqual(expectedNumeric.finiteMaximum);

        const actualCategory = category(hierarchy, start, end);
        const expectedCategory = categoryOracle(fixture, view, start, end);
        expect(actualCategory.exemplars).toEqual(expectedCategory.exemplars);
        expect(actualCategory.complete).toBe(expectedCategory.complete);
        expect(actualCategory.overflowWitness).toEqual(expectedCategory.overflowWitness);
      }
    }

    // Physical rows 13 and 17 both attain -9; row 17 wins because it is first in this view.
    expect(numeric(hierarchy, 0, view.rowCount).finiteMinimum?.physicalRow).toBe(17);
  });

  it("keeps the direct unpatched permutation path exact without a validity bitmap", async () => {
    const store = new GridDataStore();
    store.install({
      length: 8,
      columns: [
        {
          schema: { id: "value", kind: "number" },
          data: {
            kind: "number",
            values: {
              view: new Float64Array([
                5,
                Number.NaN,
                Number.POSITIVE_INFINITY,
                Number.NEGATIVE_INFINITY,
                -2,
                -2,
                9,
                0,
              ]),
            },
          },
        },
        {
          schema: { id: "category", kind: "category" },
          data: {
            kind: "category",
            codes: { view: new Uint8Array([0, 1, 2, 3, 4, 5, 0, 1]) },
            dictionary: utf8(["A", "B", "C", "D", "E", "F"]),
          },
        },
      ],
    });
    const physicalRows = new Uint32Array([5, 4, 3, 2, 1, 0, 7, 6]);
    const view = viewFor(store, physicalRows);
    const hierarchy = await buildCandidate(store, view, options(["value", "category"]));

    expect(numeric(hierarchy, 0, 8)).toMatchObject({
      nullCount: 0,
      finiteCount: 5,
      nanCount: 1,
      positiveInfinityCount: 1,
      negativeInfinityCount: 1,
      finiteMinimum: { value: -2, viewOrdinal: 0, physicalRow: 5, rowId: 5 },
      finiteMaximum: { value: 9, viewOrdinal: 7, physicalRow: 6, rowId: 6 },
    });
    expect(category(hierarchy, 0, 8)).toMatchObject({
      nullCount: 0,
      complete: false,
      exemplars: [
        { code: 5, label: "F", viewOrdinal: 0, physicalRow: 5, rowId: 5 },
        { code: 4, label: "E", viewOrdinal: 1, physicalRow: 4, rowId: 4 },
        { code: 3, label: "D", viewOrdinal: 2, physicalRow: 3, rowId: 3 },
        { code: 2, label: "C", viewOrdinal: 3, physicalRow: 2, rowId: 2 },
      ],
      overflowWitness: { code: 1, label: "B", viewOrdinal: 4, physicalRow: 1, rowId: 1 },
    });
  });

  it("reports nulls and every floating special separately without inventing extrema", async () => {
    const store = new GridDataStore();
    store.install({
      length: 6,
      columns: [
        {
          schema: { id: "value", kind: "number", nullable: true },
          data: {
            kind: "number",
            values: {
              view: new Float64Array([
                Number.NaN,
                Number.POSITIVE_INFINITY,
                Number.NEGATIVE_INFINITY,
                10,
                20,
                30,
              ]),
            },
            validity: { bits: { view: validity([true, true, true, false, false, false]) } },
          },
        },
      ],
    });
    const hierarchy = await buildCandidate(store, viewFor(store, null), options(["value"]));

    expect(numeric(hierarchy, 0, 6)).toMatchObject({
      rowCount: 6,
      nullCount: 3,
      finiteCount: 0,
      nanCount: 1,
      positiveInfinityCount: 1,
      negativeInfinityCount: 1,
      finiteMinimum: null,
      finiteMaximum: null,
    });
    expect(numeric(hierarchy, 3, 3)).toMatchObject({
      rowCount: 0,
      nullCount: 0,
      finiteCount: 0,
      nanCount: 0,
      positiveInfinityCount: 0,
      negativeInfinityCount: 0,
      finiteMinimum: null,
      finiteMaximum: null,
    });
  });

  it("rejects stale publication/query identities and obsolete datasets", async () => {
    const fixture = exactFixture();
    const view = viewFor(fixture.store, null);
    const hierarchy = await buildCandidate(fixture.store, view, options());
    const identity = summaryIdentity(hierarchy);

    expect(
      publishGridSummaryHierarchyCandidate(hierarchy, { ...identity, dataRevision: 6 }),
    ).toBeNull();
    const published = publishGridSummaryHierarchyCandidate(hierarchy, identity);
    expect(published).not.toBeNull();
    expect(published!.publishedAtMs).toBeGreaterThanOrEqual(
      hierarchy.buildStats.candidateReadyAtMs,
    );
    expect(published!.readyToPublishedMs).toBeGreaterThanOrEqual(0);
    expect(() => published!.query("value", 0, 1, identity)).not.toThrow();
    expect(() =>
      published!.query("value", 0, 1, { ...identity, viewRevision: identity.viewRevision + 1 }),
    ).toThrow(/expectation is stale/);

    fixture.store.install({
      length: 1,
      columns: [
        {
          schema: { id: "value", kind: "number" },
          data: { kind: "number", values: { view: new Float64Array([1]) } },
        },
      ],
    });
    expect(() => published!.query("value", 0, 1)).toThrow(/no longer installed/);
  });

  it("logically releases every allocated candidate byte after cancellation", async () => {
    const fixture = exactFixture();
    const view = viewFor(fixture.store, null);
    let polls = 0;
    const result = await buildGridSummaryHierarchyAsync(
      fixture.store,
      view,
      options(["value", "category"], {
        previousRetainedBytes: 1234,
        shouldCancel: () => ++polls > 3,
        chunkSize: 2,
        yieldControl: () => Promise.resolve(),
      }),
    );

    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") throw new Error("Expected cancellation.");
    expect(result.retainedBytes).toBe(0);
    expect(result.releasedCandidateBytes).toBeGreaterThan(0);
    expect(result.peakCandidateBytes).toBe(result.releasedCandidateBytes);
    expect(result.stagedReplacementPeakBytes).toBe(1234 + result.peakCandidateBytes);
  });

  it("yields cooperatively, cancels asynchronously, and builds the same exact result when resumed", async () => {
    const fixture = exactFixture();
    const view = viewFor(fixture.store, null);
    let cancelled = false;
    let yields = 0;
    const cancelledResult = await buildGridSummaryHierarchyAsync(fixture.store, view, {
      ...options(),
      chunkSize: 5,
      shouldCancel: () => cancelled,
      yieldControl: async () => {
        yields++;
        if (yields === 2) cancelled = true;
      },
    });
    expect(cancelledResult.status).toBe("cancelled");
    if (cancelledResult.status !== "cancelled") throw new Error("Expected cancellation.");
    expect(yields).toBe(2);
    expect(cancelledResult.retainedBytes).toBe(0);
    expect(cancelledResult.releasedCandidateBytes).toBeGreaterThan(0);

    const progress: { phase: string; completed: number; total: number }[] = [];
    const asyncResult = await buildGridSummaryHierarchyAsync(fixture.store, view, {
      ...options(),
      chunkSize: 5,
      yieldControl: async () => undefined,
      onProgress: (entry) => progress.push(entry),
    });
    const asyncHierarchy = candidate(asyncResult);
    const baselineHierarchy = await buildCandidate(fixture.store, view, options());
    expect(asyncHierarchy.buildStats.yieldCount).toBeGreaterThan(0);
    expect(progress.at(-1)).toEqual({
      phase: "merge",
      completed: progress.at(-1)!.total,
      total: progress.at(-1)!.total,
    });
    for (const [start, end] of [
      [0, 19],
      [1, 18],
      [5, 13],
      [8, 9],
    ] as const) {
      expect(asyncHierarchy.query("value", start, end)).toEqual(
        baselineHierarchy.query("value", start, end),
      );
      expect(asyncHierarchy.query("category", start, end)).toEqual(
        baselineHierarchy.query("category", start, end),
      );
    }
  });

  it("isolates a staged numeric extrema candidate and matches it after promotion", async () => {
    const store = new GridDataStore();
    store.install({
      length: 5,
      columns: [
        {
          schema: { id: "value", kind: "number", editable: true },
          data: { kind: "number", values: { view: new Float64Array([5, 1, 9, 2, 7]) } },
        },
      ],
    });
    const view = viewFor(store, null, 4);
    const oldHierarchy = await buildCandidate(store, view, options(["value"], { dataRevision: 1 }));
    const baseline = store.cellState(0, "value");
    const staged = store.stageCellPatch({
      datasetId: requireDatasetId(store),
      rowId: 0,
      columnId: "value",
      cellRevision: baseline.revision,
      previousValue: baseline.value,
      finalValue: -10,
    });
    if (!staged) throw new Error("Expected the numeric edit to stage.");
    const stagedHierarchy = await buildCandidate(
      store,
      view,
      options(["value"], { dataRevision: 2, stagedPatch: staged }),
    );

    expect(numeric(oldHierarchy, 0, 5).finiteMinimum).toMatchObject({ value: 1, rowId: 1 });
    expect(numeric(stagedHierarchy, 0, 5).finiteMinimum).toMatchObject({ value: -10, rowId: 0 });
    expect(
      publishGridSummaryHierarchyCandidate(stagedHierarchy, {
        ...summaryIdentity(stagedHierarchy),
        dataRevision: 1,
      }),
    ).toBeNull();
    expect(store.promoteCellPatch(staged)).toBe(true);
    const rebuilt = await buildCandidate(store, view, options(["value"], { dataRevision: 2 }));
    expect(rebuilt.query("value", 0, 5)).toEqual(stagedHierarchy.query("value", 0, 5));
    expect(numeric(oldHierarchy, 0, 5).finiteMinimum).toMatchObject({ value: 1, rowId: 1 });
  });

  it("isolates staged category witness reordering and matches it after promotion", async () => {
    const store = new GridDataStore();
    store.install({
      length: 6,
      columns: [
        {
          schema: { id: "category", kind: "category", editable: true },
          data: {
            kind: "category",
            codes: { view: new Uint8Array([0, 1, 2, 3, 4, 0]) },
            dictionary: utf8(["A", "B", "C", "D", "E"]),
          },
        },
      ],
    });
    const view = viewFor(store, null, 4);
    const oldHierarchy = await buildCandidate(
      store,
      view,
      options(["category"], { dataRevision: 1 }),
    );
    const baseline = store.cellState(0, "category");
    const staged = store.stageCellPatch({
      datasetId: requireDatasetId(store),
      rowId: 0,
      columnId: "category",
      cellRevision: baseline.revision,
      previousValue: baseline.value,
      finalValue: "E",
    });
    if (!staged) throw new Error("Expected the category edit to stage.");
    const stagedHierarchy = await buildCandidate(
      store,
      view,
      options(["category"], { dataRevision: 2, stagedPatch: staged }),
    );

    expect(category(oldHierarchy, 0, 6).exemplars.map((entry) => entry.label)).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
    expect(category(oldHierarchy, 0, 6).overflowWitness?.label).toBe("E");
    expect(category(stagedHierarchy, 0, 6).exemplars.map((entry) => entry.label)).toEqual([
      "E",
      "B",
      "C",
      "D",
    ]);
    expect(category(stagedHierarchy, 0, 6).overflowWitness?.label).toBe("A");
    expect(store.promoteCellPatch(staged)).toBe(true);
    const rebuilt = await buildCandidate(store, view, options(["category"], { dataRevision: 2 }));
    expect(rebuilt.query("category", 0, 6)).toEqual(stagedHierarchy.query("category", 0, 6));
    expect(category(oldHierarchy, 0, 6).exemplars[0]?.label).toBe("A");
  });

  it("validates the internal build and query boundaries", async () => {
    const fixture = exactFixture();
    const view = viewFor(fixture.store, null);
    await expect(
      buildGridSummaryHierarchyAsync(fixture.store, view, options(["value", "value"])),
    ).rejects.toThrow(/unique and non-empty/);
    await expect(
      buildGridSummaryHierarchyAsync(
        fixture.store,
        { ...view, physicalRows: new Uint32Array(2) },
        options(["value"]),
      ),
    ).rejects.toThrow(/permutation length/);
    await expect(
      buildGridSummaryHierarchyAsync(
        fixture.store,
        { ...view, rowCount: view.rowCount - 1 },
        options(["value"]),
      ),
    ).rejects.toThrow(/identity view.*complete dataset/i);
    await expect(
      buildGridSummaryHierarchyAsync(
        fixture.store,
        { ...view, viewRevision: -1 },
        options(["value"]),
      ),
    ).rejects.toThrow(/viewRevision.*non-negative/);
    await expect(
      buildGridSummaryHierarchyAsync(
        fixture.store,
        view,
        options(["value"], { previousRetainedBytes: -1 }),
      ),
    ).rejects.toThrow(/previousRetainedBytes.*non-negative/);
    const hierarchy = await buildCandidate(fixture.store, view, options(["value"]));
    expect(() => hierarchy.query("missing", 0, 1)).toThrow(/not indexed/);
    expect(() => hierarchy.query("value", -1, 1)).toThrow(/outside/);
    expect(() => hierarchy.query("value", 2, 1)).toThrow(/outside/);
    expect(() => hierarchy.query("value", 0, view.rowCount + 1)).toThrow(/outside/);
  });
});
