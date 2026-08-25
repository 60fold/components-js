import { describe, expect, it } from "vitest";
import { GridDataStore } from "../data/store";
import type { CellScalar, GridComparisonOperator, Utf8Buffers } from "../types";
import {
  filterTypedColumnAsync,
  stableTypedRadixArgsortAsync,
  stableTypedRadixSortRowsAsync,
  TypedViewKernelCancelledError,
  type TypedCategoryKernelColumn,
  type TypedViewKernelColumn,
  type TypedViewKernelFilter,
  type TypedViewKernelSortKey,
} from "./typedViewKernels";

function bitmap(valid: readonly boolean[], bitOffset = 0): { bits: Uint8Array; bitOffset: number } {
  const bits = new Uint8Array(Math.ceil((bitOffset + valid.length) / 8));
  valid.forEach((value, row) => {
    if (value) bits[(bitOffset + row) >> 3]! |= 1 << ((bitOffset + row) & 7);
  });
  return { bits, bitOffset };
}

function categoryColumn(
  values: readonly (string | null)[],
  dictionary: readonly string[],
  overrides?: ReadonlyMap<number, CellScalar | null>,
): TypedCategoryKernelColumn {
  const codeByValue = new Map(dictionary.map((value, code) => [value, code]));
  const codes = Uint16Array.from(values, (value) => (value === null ? 0 : codeByValue.get(value)!));
  const lexicalOrder = dictionary
    .map((_value, code) => code)
    .sort((left, right) => (dictionary[left]! < dictionary[right]! ? -1 : 1));
  const lexicalRanks = new Uint32Array(dictionary.length);
  lexicalOrder.forEach((code, rank) => (lexicalRanks[code] = rank));
  return {
    kind: "category",
    rowCount: values.length,
    codes,
    dictionary,
    lexicalRanks,
    codeByValue,
    validity: bitmap(
      values.map((value) => value !== null),
      3,
    ),
    ...(overrides ? { overrides } : {}),
  };
}

function read(column: TypedViewKernelColumn, row: number): CellScalar | null {
  if (column.overrides?.has(row)) return column.overrides.get(row) ?? null;
  if (column.validity) {
    const bit = column.validity.bitOffset! + row;
    if ((column.validity.bits[bit >> 3]! & (1 << (bit & 7))) === 0) return null;
  }
  if (column.kind === "category") return column.dictionary[column.codes[row]!]!;
  if (column.kind === "boolean") {
    if (column.encoding === "byte") return column.values[row] !== 0;
    const bit = (column.bitOffset ?? 0) + row;
    return (column.values[bit >> 3]! & (1 << (bit & 7))) !== 0;
  }
  return column.values[row]!;
}

function compareScalar(left: CellScalar, right: CellScalar): number {
  if (left === right) return 0;
  const leftNaN = typeof left === "number" && Number.isNaN(left);
  const rightNaN = typeof right === "number" && Number.isNaN(right);
  if (leftNaN) return rightNaN ? 0 : 1;
  if (rightNaN) return -1;
  if (
    typeof left === typeof right ||
    ((typeof left === "number" || typeof left === "bigint") &&
      (typeof right === "number" || typeof right === "bigint"))
  ) {
    if (left < right) return -1;
    if (right < left) return 1;
    return 0;
  }
  const rank = (value: CellScalar): number =>
    typeof value === "boolean" ? 0 : typeof value === "string" ? 2 : 1;
  return rank(left) < rank(right) ? -1 : 1;
}

function referenceSort(rows: Uint32Array, keys: readonly TypedViewKernelSortKey[]): number[] {
  return [...rows].sort((leftRow, rightRow) => {
    for (const key of keys) {
      const left = read(key.column, leftRow);
      const right = read(key.column, rightRow);
      if (left === null || right === null) {
        const comparison =
          left === null
            ? right === null
              ? 0
              : key.nulls === "first"
                ? -1
                : 1
            : key.nulls === "first"
              ? 1
              : -1;
        if (comparison !== 0) return comparison;
      } else {
        const comparison = compareScalar(left, right);
        if (comparison !== 0) return key.direction === "ascending" ? comparison : -comparison;
      }
    }
    return leftRow - rightRow;
  });
}

function sortRows(
  rows: Uint32Array,
  keys: readonly TypedViewKernelSortKey[],
): Promise<Uint32Array> {
  return stableTypedRadixSortRowsAsync(rows, keys, {
    yieldControl: () => Promise.resolve(),
  });
}

function argsort(rowCount: number, keys: readonly TypedViewKernelSortKey[]): Promise<Uint32Array> {
  return stableTypedRadixArgsortAsync(rowCount, keys, {
    yieldControl: () => Promise.resolve(),
  });
}

/**
 * Characterization oracle for generic/typed kernel parity. Contract
 * correctness is established independently in filterContract.test.ts.
 */
function referenceFilter(value: CellScalar | null, filter: TypedViewKernelFilter): boolean {
  if (filter.kind === "is-null") return value === null;
  if (filter.kind === "is-not-null") return value !== null;
  if (value === null) return false;
  if (filter.kind === "in") return filter.values.some((candidate) => value === candidate);
  if (filter.kind === "between") {
    const lower = contractFilterOrder(value, filter.lower);
    const upper = contractFilterOrder(value, filter.upper);
    if (lower === null || upper === null) return false;
    return (
      (filter.includeLower === false ? lower > 0 : lower >= 0) &&
      (filter.includeUpper === false ? upper < 0 : upper <= 0)
    );
  }
  if (filter.kind !== "comparison") throw new Error("Unexpected typed filter in reference.");
  if (filter.operator === "eq") return value === filter.value;
  if (filter.operator === "ne") return value !== filter.value;
  const comparison = contractFilterOrder(value, filter.value);
  if (comparison === null) return false;
  if (filter.operator === "lt") return comparison < 0;
  if (filter.operator === "lte") return comparison <= 0;
  if (filter.operator === "gt") return comparison > 0;
  return comparison >= 0;
}

function contractFilterOrder(left: CellScalar, right: CellScalar): -1 | 0 | 1 | null {
  if (typeof left !== typeof right) return null;
  if (typeof left === "number" && typeof right === "number") {
    if (Number.isNaN(left) || Number.isNaN(right)) return null;
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === "bigint" && typeof right === "bigint") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === right ? 0 : left ? 1 : -1;
  }
  return null;
}

async function expectFilter(
  column: TypedViewKernelColumn,
  filter: TypedViewKernelFilter,
): Promise<void> {
  const result = await filterTypedColumnAsync(column, filter, {
    yieldControl: () => Promise.resolve(),
  });
  const expected = Array.from({ length: column.rowCount }, (_entry, row) => row).filter((row) =>
    referenceFilter(read(column, row), filter),
  );
  expect([...result.physicalRows]).toEqual(expected);
  for (let row = 0; row < column.rowCount; row++) {
    expect((result.bitmap[row >> 3]! & (1 << (row & 7))) !== 0).toBe(expected.includes(row));
  }
}

function utf8(values: readonly string[]): Utf8Buffers {
  const encoder = new TextEncoder();
  const encoded = values.map((value) => encoder.encode(value));
  const offsets = new Uint32Array(values.length + 1);
  let length = 0;
  encoded.forEach((value, index) => {
    length += value.length;
    offsets[index + 1] = length;
  });
  const data = new Uint8Array(length);
  let offset = 0;
  encoded.forEach((value) => {
    data.set(value, offset);
    offset += value.length;
  });
  return { offsets: { view: offsets }, data: { view: data } };
}

describe("typed view filter kernels", () => {
  const values = new Float64Array([
    Number.NEGATIVE_INFINITY,
    -5,
    -0,
    0,
    2,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    9,
  ]);
  const numberColumn: TypedViewKernelColumn = {
    kind: "number",
    rowCount: values.length,
    values,
    validity: bitmap([true, true, true, true, false, true, true, true], 5),
    overrides: new Map<number, CellScalar | null>([
      [1, 7],
      [2, null],
      [4, -3],
    ]),
  };

  it.each(["eq", "ne", "lt", "lte", "gt", "gte"] as const)(
    "matches scalar semantics for the %s comparison",
    async (operator: GridComparisonOperator) => {
      await expectFilter(numberColumn, {
        kind: "comparison",
        columnId: "unused",
        operator,
        value: 0,
      });
    },
  );

  it("matches null, set, and bounded range semantics with sparse overrides", async () => {
    const filters: TypedViewKernelFilter[] = [
      { kind: "is-null", columnId: "unused" },
      { kind: "is-not-null", columnId: "unused" },
      { kind: "in", columnId: "unused", values: [-3, 0] },
      { kind: "between", columnId: "unused", lower: -3, upper: 7 },
      {
        kind: "between",
        columnId: "unused",
        lower: -3,
        upper: 7,
        includeLower: false,
        includeUpper: false,
      },
    ];
    for (const filter of filters) await expectFilter(numberColumn, filter);
  });

  it("matches dense Float32 and Float64 between semantics through the yielding kernel", async () => {
    const sourceValues = [
      Number.NEGATIVE_INFINITY,
      -1,
      -0,
      0,
      Number.MIN_VALUE,
      1,
      5,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ];
    const float32Backing = new Float32Array(sourceValues.length + 3);
    const float32Values = float32Backing.subarray(2, 2 + sourceValues.length);
    float32Values.set(sourceValues);
    const float64Backing = new Float64Array(sourceValues.length + 3);
    const float64Values = float64Backing.subarray(1, 1 + sourceValues.length);
    float64Values.set(sourceValues);
    const filters: TypedViewKernelFilter[] = [
      { kind: "between", columnId: "unused", lower: -0, upper: 5 },
      {
        kind: "between",
        columnId: "unused",
        lower: -0,
        upper: 5,
        includeLower: false,
      },
      {
        kind: "between",
        columnId: "unused",
        lower: -0,
        upper: 5,
        includeUpper: false,
      },
      {
        kind: "between",
        columnId: "unused",
        lower: -0,
        upper: 5,
        includeLower: false,
        includeUpper: false,
      },
      { kind: "between", columnId: "unused", lower: 0, upper: 0 },
      { kind: "between", columnId: "unused", lower: 5, upper: -1 },
      {
        kind: "between",
        columnId: "unused",
        lower: Number.NEGATIVE_INFINITY,
        upper: Number.POSITIVE_INFINITY,
      },
    ];

    for (const values of [float32Values, float64Values]) {
      const column: TypedViewKernelColumn = {
        kind: "number",
        rowCount: values.length,
        values,
      };
      for (const filter of filters) {
        const expected = Array.from({ length: column.rowCount }, (_entry, row) => row).filter(
          (row) => referenceFilter(read(column, row), filter),
        );
        const progress: string[] = [];
        let yields = 0;
        const actual = await filterTypedColumnAsync(column, filter, {
          chunkSize: 3,
          onChunk: ({ phase, completed }) => progress.push(`${phase}:${completed}`),
          yieldControl: async () => {
            yields++;
          },
        });

        expect([...actual.physicalRows]).toEqual(expected);
        for (let row = 0; row < column.rowCount; row++) {
          expect((actual.bitmap[row >> 3]! & (1 << (row & 7))) !== 0).toBe(expected.includes(row));
        }
        expect(progress).toEqual([
          "filter:0",
          "filter:3",
          "filter:6",
          "filter:9",
          "compact:0",
          "compact:3",
          "compact:6",
          "compact:9",
        ]);
        expect(yields).toBe(4);
      }
    }
  });

  it("keeps dense numeric between cancellation at a real yielding boundary", async () => {
    const values = Float64Array.from({ length: 32 }, (_entry, row) => row);
    const column: TypedViewKernelColumn = { kind: "number", rowCount: values.length, values };
    let cancelled = false;
    let yields = 0;

    await expect(
      filterTypedColumnAsync(
        column,
        { kind: "between", columnId: "unused", lower: 4, upper: 24 },
        {
          chunkSize: 8,
          shouldCancel: () => cancelled,
          yieldControl: async () => {
            yields++;
            cancelled = true;
          },
        },
      ),
    ).rejects.toBeInstanceOf(TypedViewKernelCancelledError);
    expect(yields).toBe(1);
  });

  it("lets a real event-loop task cancel the message-yielded dense filter", async () => {
    const rowCount = 100_000;
    const column: TypedViewKernelColumn = {
      kind: "number",
      rowCount,
      values: Float64Array.from({ length: rowCount }, (_entry, row) => row),
    };
    let cancelled = false;
    const cancellationTimer = setTimeout(() => {
      cancelled = true;
    }, 0);

    await expect(
      filterTypedColumnAsync(
        column,
        { kind: "between", columnId: "unused", lower: 10_000, upper: 90_000 },
        { chunkSize: 1_024, shouldCancel: () => cancelled },
      ),
    ).rejects.toBeInstanceOf(TypedViewKernelCancelledError);
    clearTimeout(cancellationTimer);
  });

  it("retains the generic numeric between path for validity and overrides", async () => {
    await expectFilter(numberColumn, {
      kind: "between",
      columnId: "unused",
      lower: -3,
      upper: 7,
    });
  });

  it("rejects NaN and physical scalar-type mismatches at the typed-kernel boundary", async () => {
    const invalidNumberFilters: TypedViewKernelFilter[] = [
      { kind: "comparison", columnId: "unused", operator: "eq", value: Number.NaN },
      { kind: "between", columnId: "unused", lower: Number.NaN, upper: 5 },
      { kind: "in", columnId: "unused", values: [0, Number.NaN] },
      { kind: "in", columnId: "unused", values: new Array<CellScalar>(1) },
      { kind: "comparison", columnId: "unused", operator: "eq", value: 1n },
    ];
    for (const filter of invalidNumberFilters) {
      await expect(filterTypedColumnAsync(numberColumn, filter)).rejects.toThrow();
    }

    const bigintColumn: TypedViewKernelColumn = {
      kind: "integer",
      rowCount: 2,
      values: new BigInt64Array([1n, 2n]),
    };
    await expect(
      filterTypedColumnAsync(bigintColumn, {
        kind: "comparison",
        columnId: "unused",
        operator: "eq",
        value: 1,
      }),
    ).rejects.toThrow(/type bigint/);
  });

  it("specializes boolean bitmap and lexically ranked category columns", async () => {
    const booleanValues = bitmap([false, true, true, false, true, false], 2).bits;
    const booleanColumn: TypedViewKernelColumn = {
      kind: "boolean",
      rowCount: 6,
      values: booleanValues,
      encoding: "bitmap",
      bitOffset: 2,
      validity: bitmap([true, true, false, true, true, true], 1),
      overrides: new Map([[2, true]]),
    };
    const category = categoryColumn(
      ["zeta", "alpha", null, "middle", "alpha", "zeta"],
      ["zeta", "middle", "alpha"],
      new Map([[2, "middle"]]),
    );
    await expectFilter(booleanColumn, {
      kind: "comparison",
      columnId: "unused",
      operator: "eq",
      value: true,
    });
    await expectFilter(category, {
      kind: "between",
      columnId: "unused",
      lower: "alpha",
      upper: "middle",
    });
    await expectFilter(category, {
      kind: "in",
      columnId: "unused",
      values: ["zeta"],
    });
  });

  it("compacts only the logical row range and reports bounded chunks", async () => {
    const column: TypedViewKernelColumn = {
      kind: "boolean",
      rowCount: 7,
      values: new Uint8Array([1, 0, 1, 0, 0, 1, 1]),
      encoding: "byte",
    };
    const progress: { phase: string; completed: number; total: number }[] = [];
    const result = await filterTypedColumnAsync(
      column,
      { kind: "comparison", columnId: "unused", operator: "eq", value: true },
      {
        chunkSize: 2,
        onChunk: (entry) => progress.push(entry),
        yieldControl: () => Promise.resolve(),
      },
    );
    expect([...result.physicalRows]).toEqual([0, 2, 5, 6]);
    expect(result.bitmap).toEqual(new Uint8Array([0b0110_0101]));
    expect(progress.at(-1)).toEqual({ phase: "compact", completed: 7, total: 7 });
  });

  it("accepts the store's direct typed-column contract without adaptation", async () => {
    const store = new GridDataStore();
    store.install({
      length: 4,
      columns: [
        {
          schema: { id: "category", kind: "category", nullable: true },
          data: {
            kind: "category",
            codes: { view: new Uint8Array([1, 0, 2, 1]) },
            dictionary: utf8(["z", "a", "m"]),
            validity: { bits: { view: new Uint8Array([0b1101]) } },
          },
        },
      ],
    });
    const column = store.typedColumnAt("category");
    if (!column) throw new Error("expected typed category access");
    await expectFilter(column, {
      kind: "comparison",
      columnId: "category",
      operator: "lt",
      value: "z",
    });
  });
});

describe("stable typed radix argsort", () => {
  it("orders every Float64 edge exactly, with null placement independent of direction", async () => {
    const values = new Float64Array([
      Number.NaN,
      0,
      -0,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      -4.5,
      4.5,
      Number.NaN,
      4.5,
      99,
    ]);
    const column: TypedViewKernelColumn = {
      kind: "number",
      rowCount: values.length,
      values,
      validity: bitmap([true, true, true, true, true, true, true, true, true, false], 4),
      overrides: new Map<number, CellScalar | null>([
        [5, 4.5],
        [9, -12],
        [6, null],
      ]),
    };
    const shuffled = Uint32Array.from([8, 0, 7, 6, 5, 4, 3, 2, 1, 9]);
    for (const direction of ["ascending", "descending"] as const) {
      for (const nulls of ["first", "last"] as const) {
        const key = { column, direction, nulls } satisfies TypedViewKernelSortKey;
        const expected = referenceSort(shuffled, [key]);
        const actual = await sortRows(shuffled.slice(), [key]);
        expect([...actual]).toEqual(expected);
      }
    }
  });

  it("differentially sorts dense Float64 edges through the yielding path", async () => {
    const source = [
      Number.NaN,
      0,
      -0,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      -4.5,
      4.5,
      Number.NaN,
      4.5,
      -4.5,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
    ];
    // Exercise direct word access from a non-zero typed-array byte offset.
    const values = new Float64Array(new ArrayBuffer((source.length + 1) * 8), 8, source.length);
    values.set(source);
    const column: TypedViewKernelColumn = {
      kind: "number",
      rowCount: values.length,
      values,
    };
    const shuffled = Uint32Array.from([8, 0, 11, 7, 6, 5, 4, 3, 2, 1, 10, 9]);

    for (const direction of ["ascending", "descending"] as const) {
      const key = { column, direction, nulls: "last" } satisfies TypedViewKernelSortKey;
      const expected = referenceSort(shuffled, [key]);
      expect([
        ...(await stableTypedRadixSortRowsAsync(shuffled.slice(), [key], {
          chunkSize: 3,
          yieldControl: () => Promise.resolve(),
        })),
      ]).toEqual(expected);
    }
  });

  it("matches comparator sorting for arbitrary dense Float64 bit patterns", async () => {
    const rowCount = 1_001;
    const values = new Float64Array(rowCount);
    const words = new Uint32Array(values.buffer);
    let state = 0x9e37_79b9;
    for (let word = 0; word < words.length; word++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      words[word] = state;
    }
    const column: TypedViewKernelColumn = {
      kind: "number",
      rowCount,
      values,
    };
    const shuffled = Uint32Array.from({ length: rowCount }, (_entry, row) => rowCount - row - 1);
    for (const direction of ["ascending", "descending"] as const) {
      const key = { column, direction, nulls: "last" } satisfies TypedViewKernelSortKey;
      expect([...(await sortRows(shuffled.slice(), [key]))]).toEqual(
        referenceSort(shuffled, [key]),
      );
    }
  });

  it("composes dense Float64 above and below a categorical radix key", async () => {
    const numbers: TypedViewKernelColumn = {
      kind: "number",
      rowCount: 10,
      values: new Float64Array([2, 1, 2, Number.NaN, -0, 0, 1, Number.NaN, 2, -1]),
    };
    const category = categoryColumn(
      ["b", "a", "a", "c", "b", "a", "b", "a", "c", "c"],
      ["c", "a", "b"],
    );
    const shuffled = Uint32Array.from([8, 0, 7, 6, 5, 4, 3, 2, 1, 9]);
    const keySets = [
      [
        { column: numbers, direction: "ascending", nulls: "last" },
        { column: category, direction: "descending", nulls: "first" },
      ],
      [
        { column: category, direction: "ascending", nulls: "last" },
        { column: numbers, direction: "descending", nulls: "first" },
      ],
    ] satisfies readonly (readonly TypedViewKernelSortKey[])[];

    for (const keys of keySets) {
      const expected = referenceSort(shuffled, keys);
      expect([
        ...(await stableTypedRadixSortRowsAsync(shuffled.slice(), keys, {
          chunkSize: 3,
          yieldControl: () => Promise.resolve(),
        })),
      ]).toEqual(expected);
    }
  });

  it("keeps dense Float64 cancellation at bounded yielding chunk boundaries", async () => {
    const rowCount = 64;
    const column: TypedViewKernelColumn = {
      kind: "number",
      rowCount,
      values: Float64Array.from({ length: rowCount }, (_entry, row) => rowCount - row),
    };
    const key = {
      column,
      direction: "ascending",
      nulls: "last",
    } satisfies TypedViewKernelSortKey;
    const rows = Uint32Array.from({ length: rowCount }, (_entry, row) => row);

    let yields = 0;
    await expect(
      stableTypedRadixSortRowsAsync(
        rows.slice(),
        [key],
        {
          chunkSize: 8,
          shouldCancel: () => yields > 0,
          yieldControl: () => {
            yields++;
            return Promise.resolve();
          },
        },
        true,
      ),
    ).rejects.toBeInstanceOf(TypedViewKernelCancelledError);
    expect(yields).toBe(1);
  });

  it.each([
    new Int8Array([-128, -1, 0, 1, 127, -1]),
    new Uint8Array([255, 0, 1, 128, 1, 0]),
    new Int16Array([-32768, 99, -1, 0, 32767, 99]),
    new Uint16Array([65535, 7, 0, 32768, 7, 1]),
    new Int32Array([-2147483648, -1, 0, 2147483647, 4, -1]),
    new Uint32Array([4294967295, 0, 2147483648, 1, 0, 9]),
    new BigInt64Array([-(1n << 63n), -1n, 0n, 1n << 62n, -1n, (1n << 63n) - 1n]),
    new BigUint64Array([0n, (1n << 64n) - 1n, 2n, 1n << 63n, 0n, 9n]),
  ])("differentially sorts %s", async (values) => {
    const column: TypedViewKernelColumn = {
      kind: "integer",
      rowCount: values.length,
      values,
      validity: bitmap([true, true, false, true, true, true], 2),
      overrides: new Map([[2, values[0]!]]),
    };
    for (const direction of ["ascending", "descending"] as const) {
      const key = { column, direction, nulls: "last" } satisfies TypedViewKernelSortKey;
      expect([...(await argsort(values.length, [key]))]).toEqual(
        referenceSort(Uint32Array.from([0, 1, 2, 3, 4, 5]), [key]),
      );
    }
  });

  it("canonicalizes Float32 NaNs and signed zero as stable ties", async () => {
    const values = new Float32Array([Number.NaN, -0, 0, 4, -4, Number.NaN, 4]);
    const column: TypedViewKernelColumn = {
      kind: "number",
      rowCount: values.length,
      values,
    };
    const key = {
      column,
      direction: "ascending",
      nulls: "last",
    } satisfies TypedViewKernelSortKey;
    expect([...(await argsort(values.length, [key]))]).toEqual(
      referenceSort(Uint32Array.from([0, 1, 2, 3, 4, 5, 6]), [key]),
    );
  });

  it("keeps an exact sparse JS number distinct from its Float32 base representation", async () => {
    const values = new Float32Array([0, 1, 1 + 2 ** -22]);
    const column: TypedViewKernelColumn = {
      kind: "number",
      rowCount: values.length,
      values,
      // This rounds to 1 in Float32, but committed sparse patches intentionally
      // retain the exact host-normalized JS number.
      overrides: new Map([[0, 1 + 2 ** -25]]),
    };
    const key = {
      column,
      direction: "ascending",
      nulls: "last",
    } satisfies TypedViewKernelSortKey;
    expect([...(await argsort(values.length, [key]))]).toEqual([1, 0, 2]);

    const edgeValues = new Float32Array([-(2 ** -149), -0, 0, 2 ** -149, -3.5, 3.5]);
    const edgeColumn: TypedViewKernelColumn = {
      kind: "number",
      rowCount: edgeValues.length,
      values: edgeValues,
      overrides: new Map([[5, 3.5000000001]]),
    };
    const edgeKey = { ...key, column: edgeColumn };
    expect([...(await argsort(edgeValues.length, [edgeKey]))]).toEqual(
      referenceSort(Uint32Array.from([0, 1, 2, 3, 4, 5]), [edgeKey]),
    );
  });

  it("differentially promotes arbitrary Float32 bit patterns when sparse patches exist", async () => {
    const rowCount = 1_001;
    const values = new Float32Array(rowCount);
    const words = new Uint32Array(values.buffer);
    let state = 0x6d2b_79f5;
    for (let row = 0; row < rowCount; row++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      words[row] = state;
    }
    const column: TypedViewKernelColumn = {
      kind: "number",
      rowCount,
      values,
      overrides: new Map<number, CellScalar | null>([
        [0, Math.PI],
        [113, -0],
        [229, Number.NaN],
        [337, null],
      ]),
    };
    for (const direction of ["ascending", "descending"] as const) {
      const key = { column, direction, nulls: "last" } satisfies TypedViewKernelSortKey;
      expect([...(await argsort(rowCount, [key]))]).toEqual(
        referenceSort(
          Uint32Array.from({ length: rowCount }, (_entry, row) => row),
          [key],
        ),
      );
    }
  });

  it("composes category and boolean keys while retaining the physical-row tie break", async () => {
    const category = categoryColumn(
      ["z", "a", "z", "m", "a", "a", null, "m"],
      ["z", "m", "a"],
      new Map([[6, "a"]]),
    );
    const bools: TypedViewKernelColumn = {
      kind: "boolean",
      rowCount: 8,
      values: new Uint8Array([1, 1, 0, 1, 1, 1, 0, 1]),
      encoding: "byte",
      validity: bitmap([true, true, true, true, false, true, true, true], 0),
    };
    const keys = [
      { column: category, direction: "ascending", nulls: "last" },
      { column: bools, direction: "descending", nulls: "first" },
    ] satisfies readonly TypedViewKernelSortKey[];
    const shuffled = Uint32Array.from([7, 6, 5, 4, 3, 2, 1, 0]);
    expect([...(await sortRows(shuffled.slice(), keys))]).toEqual(referenceSort(shuffled, keys));
  });

  it("matches comparator sorting over randomized numbers, nulls, NaNs, and overrides", async () => {
    let state = 0x12ab_34cd;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const rowCount = 1_003;
    const values = new Float64Array(rowCount);
    const valid = new Array<boolean>(rowCount);
    for (let row = 0; row < rowCount; row++) {
      values[row] = row % 97 === 0 ? Number.NaN : Math.trunc((random() - 0.5) * 500) / 4;
      valid[row] = row % 31 !== 0;
    }
    const column: TypedViewKernelColumn = {
      kind: "number",
      rowCount,
      values,
      validity: bitmap(valid, 7),
      overrides: new Map<number, CellScalar | null>([
        [0, -0],
        [31, Number.POSITIVE_INFINITY],
        [62, null],
        [93, Number.NaN],
      ]),
    };
    const shuffled = Uint32Array.from(
      Array.from({ length: rowCount }, (_entry, row) => row).sort(() => random() - 0.5),
    );
    for (const direction of ["ascending", "descending"] as const) {
      for (const nulls of ["first", "last"] as const) {
        const key = { column, direction, nulls } satisfies TypedViewKernelSortKey;
        expect([...(await sortRows(shuffled.slice(), [key]))]).toEqual(
          referenceSort(shuffled, [key]),
        );
      }
    }
  });

  it("checks cancellation only at bounded yielding chunk boundaries", async () => {
    const column: TypedViewKernelColumn = {
      kind: "integer",
      rowCount: 64,
      values: Uint32Array.from({ length: 64 }, (_entry, row) => 64 - row),
    };
    let checkpoints = 0;
    await expect(
      stableTypedRadixArgsortAsync(64, [{ column, direction: "ascending", nulls: "last" }], {
        chunkSize: 8,
        shouldCancel: () => ++checkpoints === 4,
        yieldControl: () => Promise.resolve(),
      }),
    ).rejects.toBeInstanceOf(TypedViewKernelCancelledError);
    expect(checkpoints).toBe(4);

    await expect(
      filterTypedColumnAsync(
        column,
        { kind: "is-not-null", columnId: "unused" },
        { shouldCancel: () => true, yieldControl: () => Promise.resolve() },
      ),
    ).rejects.toBeInstanceOf(TypedViewKernelCancelledError);
  });

  it("yields to the event loop so a real superseding worker message can cancel", async () => {
    const rowCount = 100_000;
    const column: TypedViewKernelColumn = {
      kind: "number",
      rowCount,
      values: Float64Array.from({ length: rowCount }, (_entry, row) => rowCount - row),
    };
    let cancelled = false;
    setTimeout(() => {
      cancelled = true;
    }, 0);
    await expect(
      stableTypedRadixArgsortAsync(rowCount, [{ column, direction: "ascending", nulls: "last" }], {
        chunkSize: 1_024,
        shouldCancel: () => cancelled,
      }),
    ).rejects.toBeInstanceOf(TypedViewKernelCancelledError);
  });

  it("builds exact candidates through the yielding filter and radix paths", async () => {
    const column: TypedViewKernelColumn = {
      kind: "integer",
      rowCount: 9,
      values: new Int16Array([9, -2, 7, 0, -2, 8, 1, 7, -9]),
      validity: bitmap([true, true, false, true, true, true, true, true, true], 3),
      overrides: new Map([[2, 6]]),
    };
    const filter = {
      kind: "comparison",
      columnId: "unused",
      operator: "gte",
      value: 0,
    } as const;
    const filtered = await filterTypedColumnAsync(column, filter, {
      chunkSize: 2,
      yieldControl: () => Promise.resolve(),
    });
    const expectedRows = Array.from({ length: column.rowCount }, (_entry, row) => row).filter(
      (row) => referenceFilter(read(column, row), filter),
    );
    expect([...filtered.physicalRows]).toEqual(expectedRows);

    const key = {
      column,
      direction: "descending",
      nulls: "first",
    } satisfies TypedViewKernelSortKey;
    const sorted = await stableTypedRadixSortRowsAsync(filtered.physicalRows.slice(), [key], {
      chunkSize: 2,
      yieldControl: () => Promise.resolve(),
    });
    expect([...sorted]).toEqual(referenceSort(filtered.physicalRows, [key]));
  });
});
