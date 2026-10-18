import { describe, expect, it } from "vitest";
import { GridDataStore } from "../data/store";
import type {
  CellScalar,
  GridComparisonOperator,
  GridFilter,
  GridViewSpec,
  Utf8Buffers,
} from "../types";
import { buildGridViewCandidateAsync, normalizeGridViewSpec } from "./activeView";

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

function contractStore(): GridDataStore {
  const store = new GridDataStore();
  store.install({
    length: 3,
    columns: [
      {
        schema: { id: "number", kind: "number" },
        data: { kind: "number", values: { view: new Float64Array([-1, 0, 1]) } },
      },
      {
        schema: { id: "integer-number", kind: "integer" },
        data: { kind: "integer", values: { view: new Int32Array([-1, 0, 1]) } },
      },
      {
        schema: { id: "integer-bigint", kind: "integer" },
        data: { kind: "integer", values: { view: new BigInt64Array([-1n, 0n, 1n]) } },
      },
      {
        schema: { id: "boolean", kind: "boolean" },
        data: {
          kind: "boolean",
          encoding: "byte",
          values: { view: new Uint8Array([0, 1, 0]) },
        },
      },
      {
        schema: { id: "timestamp-number", kind: "timestamp" },
        data: {
          kind: "timestamp",
          values: { data: { view: new Float64Array([1_000, 2_000, 3_000]) }, unit: "ms" },
        },
      },
      {
        schema: { id: "timestamp-bigint", kind: "timestamp" },
        data: {
          kind: "timestamp",
          values: { data: { view: new BigInt64Array([1n, 2n, 3n]) }, unit: "ns" },
        },
      },
      {
        schema: { id: "category", kind: "category" },
        data: {
          kind: "category",
          codes: { view: new Uint8Array([0, 1, 2]) },
          dictionary: utf8(["a", "b", "c"]),
        },
      },
      {
        schema: { id: "id-number", kind: "id" },
        data: {
          kind: "id",
          values: { encoding: "integer", data: { view: new Uint32Array([1, 2, 3]) } },
        },
      },
      {
        schema: { id: "id-bigint", kind: "id" },
        data: {
          kind: "id",
          values: { encoding: "integer", data: { view: new BigInt64Array([1n, 2n, 3n]) } },
        },
      },
      {
        schema: { id: "id-string", kind: "id" },
        data: { kind: "id", values: { encoding: "utf8", ...utf8(["a", "b", "c"]) } },
      },
      {
        schema: { id: "text", kind: "text" },
        data: { kind: "text", values: utf8(["a", "b", "c"]) },
      },
    ],
  });
  return store;
}

async function rowsFor(
  store: GridDataStore,
  spec: GridViewSpec,
  kernel: "generic" | "typed",
): Promise<number[]> {
  const result = await buildGridViewCandidateAsync(store, spec, {
    requestId: 1,
    viewRevision: 1,
    kernel,
    yieldControl: () => Promise.resolve(),
  });
  if (result.status !== "complete") throw new Error("Expected a completed contract view.");
  return [...result.candidate.physicalRows];
}

describe("Grid filter contract", () => {
  const columns = [
    { id: "number", type: "number", lower: -1, upper: 1, incompatible: 1n },
    { id: "integer-number", type: "number", lower: -1, upper: 1, incompatible: 1n },
    { id: "integer-bigint", type: "bigint", lower: -1n, upper: 1n, incompatible: 1 },
    { id: "boolean", type: "boolean", lower: false, upper: true, incompatible: 1 },
    { id: "timestamp-number", type: "number", lower: 1_000, upper: 3_000, incompatible: 1n },
    { id: "timestamp-bigint", type: "bigint", lower: 1n, upper: 3n, incompatible: 1 },
    { id: "category", type: "string", lower: "a", upper: "c", incompatible: 1 },
    { id: "id-number", type: "number", lower: 1, upper: 3, incompatible: 1n },
    { id: "id-bigint", type: "bigint", lower: 1n, upper: 3n, incompatible: 1 },
    { id: "id-string", type: "string", lower: "a", upper: "c", incompatible: 1 },
    { id: "text", type: "string", lower: "a", upper: "c", incompatible: 1 },
  ] as const satisfies readonly {
    id: string;
    type: "string" | "number" | "boolean" | "bigint";
    lower: CellScalar;
    upper: CellScalar;
    incompatible: CellScalar;
  }[];

  it("derives the exact physical scalar type for every schema kind and representation", () => {
    const store = contractStore();
    for (const { id, type } of columns) expect(store.columnScalarTypeAt(id)).toBe(type);
  });

  it("accepts every comparison operator, ranges, sets, and null predicates with exact types", () => {
    const store = contractStore();
    const operators: readonly GridComparisonOperator[] = ["eq", "ne", "lt", "lte", "gt", "gte"];
    for (const { id, lower, upper } of columns) {
      for (const operator of operators) {
        expect(() =>
          normalizeGridViewSpec(store, {
            filter: { kind: "comparison", columnId: id, operator, value: lower },
          }),
        ).not.toThrow();
      }
      expect(() =>
        normalizeGridViewSpec(store, {
          filter: { kind: "between", columnId: id, lower, upper },
        }),
      ).not.toThrow();
      expect(() =>
        normalizeGridViewSpec(store, {
          filter: { kind: "in", columnId: id, values: [lower, upper] },
        }),
      ).not.toThrow();
      expect(() =>
        normalizeGridViewSpec(store, { filter: { kind: "is-null", columnId: id } }),
      ).not.toThrow();
      expect(() =>
        normalizeGridViewSpec(store, { filter: { kind: "is-not-null", columnId: id } }),
      ).not.toThrow();
    }
  });

  it("rejects incompatible comparison, range, and set operands for every physical type", () => {
    const store = contractStore();
    for (const { id, incompatible } of columns) {
      const invalid: readonly GridFilter[] = [
        { kind: "comparison", columnId: id, operator: "eq", value: incompatible },
        { kind: "between", columnId: id, lower: incompatible, upper: incompatible },
        { kind: "in", columnId: id, values: [incompatible] },
      ];
      for (const filter of invalid) {
        expect(() => normalizeGridViewSpec(store, { filter })).toThrow(TypeError);
      }
    }
  });

  it("allows text predicates only on string-backed text, category, and UTF-8 ID columns", () => {
    const store = contractStore();
    for (const id of ["category", "id-string", "text"]) {
      for (const kind of ["contains", "starts-with", "ends-with"] as const) {
        expect(() =>
          normalizeGridViewSpec(store, { filter: { kind, columnId: id, value: "a" } }),
        ).not.toThrow();
      }
    }
    for (const id of ["number", "integer-bigint", "boolean", "timestamp-number", "id-number"]) {
      expect(() =>
        normalizeGridViewSpec(store, {
          filter: { kind: "contains", columnId: id, value: "a" },
        }),
      ).toThrow(/string-backed/);
    }
  });

  it("rejects NaN wherever a filter operand can occur", () => {
    const store = contractStore();
    const invalid: readonly GridFilter[] = [
      { kind: "comparison", columnId: "number", operator: "eq", value: Number.NaN },
      { kind: "between", columnId: "number", lower: Number.NaN, upper: 1 },
      { kind: "between", columnId: "number", lower: -1, upper: Number.NaN },
      { kind: "in", columnId: "number", values: [0, Number.NaN] },
    ];
    for (const filter of invalid) {
      expect(() => normalizeGridViewSpec(store, { filter })).toThrow(/must not be NaN/);
    }
  });

  it("rejects sparse in-filter operands instead of skipping holes", () => {
    const store = contractStore();
    const values = new Array<CellScalar>(1);
    expect(() =>
      normalizeGridViewSpec(store, {
        filter: { kind: "in", columnId: "number", values },
      }),
    ).toThrow(/must be a scalar/);
  });

  it("keeps sortable data NaN out of every relational predicate", async () => {
    const store = new GridDataStore();
    store.install({
      length: 7,
      columns: [
        {
          schema: { id: "value", kind: "number" },
          data: {
            kind: "number",
            values: {
              view: new Float64Array([
                Number.NEGATIVE_INFINITY,
                -1,
                -0,
                0,
                3,
                Number.NaN,
                Number.POSITIVE_INFINITY,
              ]),
            },
          },
        },
      ],
    });
    const cases: readonly [GridFilter, readonly number[]][] = [
      [{ kind: "comparison", columnId: "value", operator: "lt", value: 0 }, [0, 1]],
      [{ kind: "comparison", columnId: "value", operator: "lte", value: 0 }, [0, 1, 2, 3]],
      [{ kind: "comparison", columnId: "value", operator: "gt", value: 3 }, [6]],
      [{ kind: "comparison", columnId: "value", operator: "gte", value: 3 }, [4, 6]],
      [
        {
          kind: "between",
          columnId: "value",
          lower: Number.NEGATIVE_INFINITY,
          upper: Number.POSITIVE_INFINITY,
        },
        [0, 1, 2, 3, 4, 6],
      ],
      [{ kind: "comparison", columnId: "value", operator: "ne", value: 3 }, [0, 1, 2, 3, 5, 6]],
    ];
    for (const [filter, expected] of cases) {
      expect(await rowsFor(store, { filter }, "generic")).toEqual(expected);
      expect(await rowsFor(store, { filter }, "typed")).toEqual(expected);
    }
    const sorted = [0, 1, 2, 3, 4, 6, 5];
    expect(
      await rowsFor(store, { sort: [{ columnId: "value", direction: "ascending" }] }, "generic"),
    ).toEqual(sorted);
    expect(
      await rowsFor(store, { sort: [{ columnId: "value", direction: "ascending" }] }, "typed"),
    ).toEqual(sorted);
  });

  it("matches a native-operator contract oracle over seeded numeric properties", async () => {
    let state = 0x8d12_47a3;
    const random = (): number => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x1_0000_0000;
    };
    const values = Float64Array.from({ length: 257 }, (_entry, row) => {
      if (row % 29 === 0) return Number.NaN;
      if (row % 47 === 0) return Number.NEGATIVE_INFINITY;
      if (row % 53 === 0) return Number.POSITIVE_INFINITY;
      if (row % 31 === 0) return -0;
      return Math.trunc((random() - 0.5) * 2_000) / 4;
    });
    const store = new GridDataStore();
    store.install({
      length: values.length,
      columns: [
        {
          schema: { id: "value", kind: "number" },
          data: { kind: "number", values: { view: values } },
        },
      ],
    });
    const operand = (): number => {
      const selector = Math.floor(random() * 12);
      if (selector === 0) return Number.NEGATIVE_INFINITY;
      if (selector === 1) return Number.POSITIVE_INFINITY;
      if (selector === 2) return -0;
      return Math.trunc((random() - 0.5) * 2_000) / 4;
    };
    const operators: readonly GridComparisonOperator[] = ["eq", "ne", "lt", "lte", "gt", "gte"];
    const filters: GridFilter[] = [];
    for (let index = 0; index < 96; index++) {
      const mode = index % 3;
      if (mode === 0) {
        filters.push({
          kind: "comparison",
          columnId: "value",
          operator: operators[Math.floor(random() * operators.length)]!,
          value: operand(),
        });
      } else if (mode === 1) {
        filters.push({
          kind: "between",
          columnId: "value",
          lower: operand(),
          upper: operand(),
          includeLower: random() < 0.5,
          includeUpper: random() < 0.5,
        });
      } else {
        filters.push({ kind: "in", columnId: "value", values: [operand(), operand(), operand()] });
      }
    }

    for (const filter of filters) {
      const expected = Array.from(values, (value, row) => ({ value, row }))
        .filter(({ value }) => contractNumberMatch(value, filter))
        .map(({ row }) => row);
      expect(await rowsFor(store, { filter }, "generic")).toEqual(expected);
      expect(await rowsFor(store, { filter }, "typed")).toEqual(expected);
    }
  });
});

function contractNumberMatch(value: number, filter: GridFilter): boolean {
  if (filter.kind === "in") return filter.values.some((candidate) => value === candidate);
  if (filter.kind === "between") {
    const lower = filter.lower as number;
    const upper = filter.upper as number;
    return (
      (filter.includeLower === false ? value > lower : value >= lower) &&
      (filter.includeUpper === false ? value < upper : value <= upper)
    );
  }
  if (filter.kind !== "comparison") throw new Error("Unexpected property filter kind.");
  const operand = filter.value as number;
  switch (filter.operator) {
    case "eq":
      return value === operand;
    case "ne":
      return value !== operand;
    case "lt":
      return value < operand;
    case "lte":
      return value <= operand;
    case "gt":
      return value > operand;
    case "gte":
      return value >= operand;
  }
}
