import { describe, expect, it } from "vitest";
import { GridDataStore } from "../data/store";
import type { GridViewSpec, Utf8Buffers } from "../types";
import { buildGridViewCandidateAsync, publishGridViewCandidate } from "./activeView";

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

function fixture(): GridDataStore {
  const store = new GridDataStore();
  store.install({
    length: 6,
    rowIds: { kind: "number", values: { view: new Uint32Array([10, 11, 12, 13, 14, 15]) } },
    columns: [
      {
        schema: { id: "score", kind: "number", nullable: true },
        data: {
          kind: "number",
          values: { view: new Float64Array([2, 99, 2, 1, 2, 1]) },
          validity: { bits: { view: new Uint8Array([0b0011_1101]) } },
        },
      },
      {
        schema: { id: "team", kind: "text" },
        data: { kind: "text", values: utf8(["b", "a", "a", "b", "a", "a"]) },
      },
    ],
  });
  return store;
}

function typedFixture(): GridDataStore {
  const store = new GridDataStore();
  store.install({
    length: 10,
    columns: [
      {
        schema: { id: "score", kind: "number", nullable: true },
        data: {
          kind: "number",
          values: { view: new Float64Array([-0, 0, Number.NaN, 4, 2, 4, -5, 2, 8, 1]) },
          validity: { bits: { view: new Uint8Array([0xff, 0b0000_0010]) } },
        },
      },
      {
        schema: { id: "category", kind: "category" },
        data: {
          kind: "category",
          codes: { view: new Uint8Array([0, 2, 1, 3, 0, 1, 2, 3, 1, 0]) },
          dictionary: utf8(["zeta", "alpha", "βeta", "Alpha"]),
        },
      },
      {
        schema: { id: "label", kind: "text" },
        data: {
          kind: "text",
          values: utf8(["oak", "pine", "oak", "fir", "oak", "pine", "fir", "oak", "pine", "fir"]),
        },
      },
    ],
  });
  return store;
}

async function complete(
  store: GridDataStore,
  spec: GridViewSpec,
  requestId = 1,
  viewRevision = 1,
): Promise<
  Extract<
    Awaited<ReturnType<typeof buildGridViewCandidateAsync>>,
    { status: "complete" }
  >["candidate"]
> {
  const result = await buildGridViewCandidateAsync(store, spec, {
    requestId,
    viewRevision,
    yieldControl: () => Promise.resolve(),
  });
  if (result.status !== "complete") throw new Error("Expected a completed view.");
  return result.candidate;
}

async function completedWithKernel(
  store: GridDataStore,
  spec: GridViewSpec,
  kernel: "auto" | "generic" | "typed",
): Promise<
  Extract<Awaited<ReturnType<typeof buildGridViewCandidateAsync>>, { status: "complete" }>
> {
  const result = await buildGridViewCandidateAsync(store, spec, {
    requestId: 1,
    viewRevision: 1,
    kernel,
    yieldControl: () => Promise.resolve(),
  });
  if (result.status !== "complete") throw new Error("Expected a completed view.");
  return result;
}

describe("active view", () => {
  it("reports its selected kernel and keeps generic, typed, and auto output byte-identical", async () => {
    const store = typedFixture();
    const spec: GridViewSpec = {
      filter: { kind: "between", columnId: "score", lower: -0, upper: 4 },
      sort: [
        { columnId: "category", direction: "ascending" },
        { columnId: "score", direction: "descending", nulls: "last" },
      ],
    };

    const generic = await completedWithKernel(store, spec, "generic");
    const typed = await completedWithKernel(store, spec, "typed");
    const automatic = await completedWithKernel(store, spec, "auto");

    expect(generic.kernel).toBe("generic");
    expect(typed.kernel).toBe("typed");
    expect(automatic.kernel).toBe("typed");
    expect([...generic.candidate.physicalRows]).toEqual([3, 7, 5, 4, 9, 0, 1]);
    expect(typed.candidate.physicalRows).toEqual(generic.candidate.physicalRows);
    expect(automatic.candidate.physicalRows).toEqual(generic.candidate.physicalRows);
    expect(generic.candidate.filterBitmap).toEqual(new Uint8Array([0xbb, 0x02]));
    expect(typed.candidate.filterBitmap).toEqual(generic.candidate.filterBitmap);
    expect(automatic.candidate.filterBitmap).toEqual(generic.candidate.filterBitmap);
  });

  it("falls back per operation and reports hybrid for unsupported text filter/sort mixes", async () => {
    const store = typedFixture();
    const cases: readonly { spec: GridViewSpec; expected: readonly number[] }[] = [
      {
        spec: {
          filter: { kind: "contains", columnId: "label", value: "i" },
          sort: [{ columnId: "score", direction: "ascending", nulls: "last" }],
        },
        expected: [6, 1, 9, 3, 5, 8],
      },
      {
        spec: {
          filter: { kind: "between", columnId: "score", lower: -0, upper: 4 },
          sort: [{ columnId: "label", direction: "ascending" }],
        },
        expected: [3, 9, 0, 4, 7, 1, 5],
      },
    ];

    for (const { spec, expected } of cases) {
      const generic = await completedWithKernel(store, spec, "generic");
      const typed = await completedWithKernel(store, spec, "typed");
      expect(generic.kernel).toBe("generic");
      expect(typed.kernel).toBe("hybrid");
      expect([...typed.candidate.physicalRows]).toEqual(expected);
      expect(typed.candidate.physicalRows).toEqual(generic.candidate.physicalRows);
      expect(typed.candidate.filterBitmap).toEqual(generic.candidate.filterBitmap);
    }
  });

  it("sorts shuffled category codes by decoded lexical value through the typed radix path", async () => {
    const store = typedFixture();
    const spec: GridViewSpec = {
      sort: [{ columnId: "category", direction: "ascending" }],
    };
    const generic = await completedWithKernel(store, spec, "generic");
    const typed = await completedWithKernel(store, spec, "typed");

    expect(typed.kernel).toBe("typed");
    expect([...typed.candidate.physicalRows]).toEqual([3, 7, 2, 5, 8, 0, 4, 9, 1, 6]);
    expect(typed.candidate.physicalRows).toEqual(generic.candidate.physicalRows);
  });

  it("builds a stable multi-sort with direction-independent null placement", async () => {
    const store = fixture();
    const candidate = await complete(store, {
      sort: [
        { columnId: "team", direction: "ascending" },
        { columnId: "score", direction: "descending", nulls: "last" },
      ],
    });

    expect([...candidate.physicalRows]).toEqual([2, 4, 5, 1, 0, 3]);
    expect(
      [...Array(candidate.rowCount)].map((_, ordinal) => candidate.rowIdAt(ordinal, store)),
    ).toEqual([12, 14, 15, 11, 10, 13]);
  });

  it("keeps nulls out of value predicates and supports explicit null membership", async () => {
    const store = fixture();
    const nonTwo = await complete(store, {
      filter: { kind: "comparison", columnId: "score", operator: "ne", value: 2 },
    });
    const nullOnly = await complete(
      store,
      { filter: { kind: "is-null", columnId: "score" } },
      2,
      2,
    );

    expect([...nonTwo.physicalRows]).toEqual([3, 5]);
    expect([...nullOnly.physicalRows]).toEqual([1]);
  });

  it.each([
    ["eq", 2, [0, 2, 4]],
    ["lt", 2, [3, 5]],
    ["lte", 1, [3, 5]],
    ["gt", 1, [0, 2, 4]],
    ["gte", 2, [0, 2, 4]],
  ] as const)(
    "applies the %s comparison with typed scalar semantics",
    async (operator, value, rows) => {
      const candidate = await complete(fixture(), {
        filter: { kind: "comparison", columnId: "score", operator, value },
      });
      expect([...candidate.physicalRows]).toEqual(rows);
    },
  );

  it("supports logical, set, and remaining text predicates", async () => {
    const candidate = await complete(fixture(), {
      filter: {
        kind: "all",
        filters: [
          {
            kind: "not",
            filter: { kind: "ends-with", columnId: "team", value: "z" },
          },
          {
            kind: "any",
            filters: [
              { kind: "in", columnId: "score", values: [1] },
              { kind: "contains", columnId: "team", value: "a" },
            ],
          },
        ],
      },
    });

    expect([...candidate.physicalRows]).toEqual([1, 2, 3, 4, 5]);
  });

  it("composes typed range and string filters without changing physical identity", async () => {
    const store = fixture();
    const candidate = await complete(store, {
      filter: {
        kind: "all",
        filters: [
          { kind: "between", columnId: "score", lower: 1, upper: 2 },
          { kind: "starts-with", columnId: "team", value: "a" },
        ],
      },
      sort: [{ columnId: "score", direction: "ascending" }],
    });

    expect([...candidate.physicalRows]).toEqual([5, 2, 4]);
    expect(candidate.viewOrdinalOfPhysicalRow(2)).toBe(1);
    expect(candidate.viewOrdinalOfPhysicalRow(0)).toBe(-1);
    expect(candidate.viewOrdinalOfRowId(14, store)).toBe(2);
    expect(candidate.viewOrdinalOfRowId(10, store)).toBe(-1);
  });

  it("publishes only the current dataset/request/revision tuple", async () => {
    const store = fixture();
    const candidate = await complete(store, {}, 7, 3);

    expect(
      publishGridViewCandidate(candidate, {
        datasetId: store.datasetId!,
        requestId: 8,
        viewRevision: 3,
      }),
    ).toBeNull();
    const published = publishGridViewCandidate(candidate, {
      datasetId: store.datasetId!,
      requestId: 7,
      viewRevision: 3,
    });
    expect(published?.physicalRows).toBe(candidate.physicalRows);
    expect(published?.physicalRowAt(5)).toBe(5);
  });

  it("returns cancelled from an in-flight typed filter", async () => {
    const store = new GridDataStore();
    store.install({
      length: 5_000,
      columns: [
        {
          schema: { id: "value", kind: "number" },
          data: { kind: "number", values: { view: new Float64Array(5_000) } },
        },
      ],
    });
    let polls = 0;
    const result = await buildGridViewCandidateAsync(
      store,
      { filter: { kind: "comparison", columnId: "value", operator: "eq", value: 0 } },
      {
        requestId: 4,
        viewRevision: 2,
        kernel: "typed",
        chunkSize: 1_024,
        shouldCancel: () => ++polls >= 3,
        yieldControl: () => Promise.resolve(),
      },
    );

    expect(result).toEqual({
      status: "cancelled",
      datasetId: store.datasetId,
      requestId: 4,
      viewRevision: 2,
    });
  });

  it("builds the same exact filtered stable sort through the chunked worker path", async () => {
    const store = fixture();
    const spec = {
      filter: { kind: "is-not-null", columnId: "score" } as const,
      sort: [
        { columnId: "team", direction: "ascending" as const },
        { columnId: "score", direction: "descending" as const, nulls: "last" as const },
      ],
    };
    const baseline = await complete(store, spec, 8, 4);
    const asynchronous = await buildGridViewCandidateAsync(store, spec, {
      requestId: 8,
      viewRevision: 4,
      chunkSize: 2,
      yieldControl: () => Promise.resolve(),
    });

    expect(asynchronous.status).toBe("complete");
    if (asynchronous.status !== "complete") return;
    expect([...asynchronous.candidate.physicalRows]).toEqual([...baseline.physicalRows]);
    expect(asynchronous.candidate.filterBitmap).toEqual(baseline.filterBitmap);
  });

  it("really yields during a typed radix sort and cancels before exposing a result", async () => {
    const rowCount = 4_096;
    const values = new Float64Array(rowCount);
    for (let row = 0; row < rowCount; row++) values[row] = rowCount - row;
    const store = new GridDataStore();
    store.install({
      length: rowCount,
      columns: [
        {
          schema: { id: "value", kind: "number" },
          data: { kind: "number", values: { view: values } },
        },
      ],
    });
    let cancelled = false;
    let cancellationTimerFired = false;
    const phases: string[] = [];

    const cancellationTimer = setTimeout(() => {
      cancellationTimerFired = true;
      cancelled = true;
    }, 0);

    const result = await buildGridViewCandidateAsync(
      store,
      { sort: [{ columnId: "value", direction: "ascending" }] },
      {
        requestId: 9,
        viewRevision: 5,
        kernel: "typed",
        chunkSize: rowCount,
        shouldCancel: () => cancelled,
        onProgress: ({ phase }) => phases.push(phase),
      },
    );

    clearTimeout(cancellationTimer);
    expect(cancellationTimerFired).toBe(true);
    expect(phases).toContain("sort");
    expect(result).toEqual({
      status: "cancelled",
      datasetId: store.datasetId,
      requestId: 9,
      viewRevision: 5,
    });
  });

  it("rejects ambiguous duplicate sort keys before building", async () => {
    const store = fixture();
    await expect(
      complete(store, {
        sort: [
          { columnId: "score", direction: "ascending" },
          { columnId: "score", direction: "descending" },
        ],
      }),
    ).rejects.toThrow(/appears more than once/);
  });
});
