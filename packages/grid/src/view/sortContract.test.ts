import { describe, expect, it } from "vitest";
import { GridDataStore } from "../data/store";
import type {
  GridColumnData,
  GridSortDirection,
  GridViewSpec,
  Utf8Buffers,
  ValidityBitmap,
} from "../types";
import { buildGridViewCandidateAsync } from "./activeView";

interface SortContractCase {
  readonly name: string;
  readonly data: GridColumnData;
  readonly rowCount: number;
  /** Explicit non-null physical-row permutation for ascending value order. */
  readonly ascending: readonly number[];
  /** Explicit non-null physical-row permutation for descending value order. */
  readonly descending: readonly number[];
  readonly nullRows: readonly number[];
}

type IntegerValues = Extract<GridColumnData, { kind: "integer" }>["values"]["view"];
type CategoryCodeValues = Extract<GridColumnData, { kind: "category" }>["codes"]["view"];

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

function validity(rowCount: number, nullRows: readonly number[]): ValidityBitmap {
  const bits = new Uint8Array(Math.ceil(rowCount / 8));
  for (let row = 0; row < rowCount; row++) bits[row >> 3]! |= 1 << (row & 7);
  for (const row of nullRows) bits[row >> 3]! &= ~(1 << (row & 7));
  return { bits: { view: bits } };
}

function nullableData<T extends GridColumnData>(
  data: T,
  rowCount: number,
  nullRows: readonly number[],
): T {
  return { ...data, validity: validity(rowCount, nullRows) } as T;
}

function packedBooleans(values: readonly boolean[], bitOffset: number): Uint8Array {
  const bits = new Uint8Array(Math.ceil((bitOffset + values.length) / 8));
  for (let row = 0; row < values.length; row++) {
    if (values[row]) bits[(bitOffset + row) >> 3]! |= 1 << ((bitOffset + row) & 7);
  }
  return bits;
}

function storeFor(data: GridColumnData, rowCount: number, editable = false): GridDataStore {
  const store = new GridDataStore();
  store.install({
    length: rowCount,
    columns: [
      {
        schema: {
          id: "value",
          kind: data.kind,
          nullable: data.validity !== undefined,
          ...(editable ? { editable: true } : {}),
        },
        data,
      },
    ],
  });
  return store;
}

async function sortedRows(
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
  if (result.status !== "complete") throw new Error("Expected a completed sort contract view.");
  return [...result.candidate.physicalRows];
}

function expectedRows(
  contract: SortContractCase,
  direction: GridSortDirection,
  nulls: "first" | "last",
): number[] {
  const ordered = direction === "ascending" ? contract.ascending : contract.descending;
  return nulls === "first"
    ? [...contract.nullRows, ...ordered]
    : [...ordered, ...contract.nullRows];
}

function signedValues(): readonly { name: string; view: IntegerValues }[] {
  return [
    { name: "Int8", view: new Int8Array([127, -1, 0, -128, 2, 2, 0]) },
    { name: "Int16", view: new Int16Array([32_767, -1, 0, -32_768, 2, 2, 0]) },
    {
      name: "Int32",
      view: new Int32Array([2_147_483_647, -1, 0, -2_147_483_648, 2, 2, 0]),
    },
    {
      name: "BigInt64",
      view: new BigInt64Array([(1n << 63n) - 1n, -1n, 0n, -(1n << 63n), 2n, 2n, 0n]),
    },
  ];
}

function unsignedValues(): readonly { name: string; view: IntegerValues }[] {
  return [
    { name: "Uint8", view: new Uint8Array([255, 0, 1, 128, 2, 2, 0]) },
    { name: "Uint16", view: new Uint16Array([65_535, 0, 1, 32_768, 2, 2, 0]) },
    {
      name: "Uint32",
      view: new Uint32Array([4_294_967_295, 0, 1, 2_147_483_648, 2, 2, 0]),
    },
    {
      name: "BigUint64",
      view: new BigUint64Array([(1n << 64n) - 1n, 0n, 1n, 1n << 63n, 2n, 2n, 0n]),
    },
  ];
}

function categoryCodes(): readonly { name: string; view: CategoryCodeValues }[] {
  const values = [2, 1, 4, 0, 1, 3, 5];
  return [
    { name: "Int8", view: new Int8Array(values) },
    { name: "Uint8", view: new Uint8Array(values) },
    { name: "Int16", view: new Int16Array(values) },
    { name: "Uint16", view: new Uint16Array(values) },
    { name: "Int32", view: new Int32Array(values) },
    { name: "Uint32", view: new Uint32Array(values) },
  ];
}

function contractCases(): readonly SortContractCase[] {
  const cases: SortContractCase[] = [];
  const numberValues = [
    Number.NaN,
    -0,
    0,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    2,
    2,
    -3,
    99,
  ];
  for (const [name, view] of [
    ["Float32", new Float32Array(numberValues)],
    ["Float64", new Float64Array(numberValues)],
  ] as const) {
    cases.push({
      name: `number/${name}`,
      data: nullableData({ kind: "number", values: { view } }, 9, [8]),
      rowCount: 9,
      ascending: [3, 7, 1, 2, 5, 6, 4, 0],
      descending: [0, 4, 5, 6, 1, 2, 7, 3],
      nullRows: [8],
    });
  }

  for (const { name, view } of signedValues()) {
    cases.push({
      name: `integer/${name}`,
      data: nullableData({ kind: "integer", values: { view } }, 7, [6]),
      rowCount: 7,
      ascending: [3, 1, 2, 4, 5, 0],
      descending: [0, 4, 5, 2, 1, 3],
      nullRows: [6],
    });
  }
  for (const { name, view } of unsignedValues()) {
    cases.push({
      name: `integer/${name}`,
      data: nullableData({ kind: "integer", values: { view } }, 7, [6]),
      rowCount: 7,
      ascending: [1, 2, 4, 5, 3, 0],
      descending: [0, 3, 4, 5, 2, 1],
      nullRows: [6],
    });
  }

  const booleanValues = [true, false, true, false, true, false];
  cases.push({
    name: "boolean/byte",
    data: nullableData(
      { kind: "boolean", encoding: "byte", values: { view: new Uint8Array([1, 0, 1, 0, 1, 0]) } },
      6,
      [5],
    ),
    rowCount: 6,
    ascending: [1, 3, 0, 2, 4],
    descending: [0, 2, 4, 1, 3],
    nullRows: [5],
  });
  cases.push({
    name: "boolean/bitmap",
    data: nullableData(
      {
        kind: "boolean",
        encoding: "bitmap",
        bitOffset: 3,
        values: { view: packedBooleans(booleanValues, 3) },
      },
      6,
      [5],
    ),
    rowCount: 6,
    ascending: [1, 3, 0, 2, 4],
    descending: [0, 2, 4, 1, 3],
    nullRows: [5],
  });

  cases.push({
    name: "timestamp/Float64-ms",
    data: nullableData(
      {
        kind: "timestamp",
        values: {
          data: { view: new Float64Array([3_000, 1_000, 2_000, 1_000, 4_000, 0]) },
          unit: "ms",
        },
      },
      6,
      [5],
    ),
    rowCount: 6,
    ascending: [1, 3, 2, 0, 4],
    descending: [4, 0, 2, 1, 3],
    nullRows: [5],
  });
  cases.push({
    name: "timestamp/BigInt64-ns",
    data: nullableData(
      {
        kind: "timestamp",
        values: {
          data: { view: new BigInt64Array([3_000n, 1_000n, 2_000n, 1_000n, 4_000n, 0n]) },
          unit: "ns",
        },
      },
      6,
      [5],
    ),
    rowCount: 6,
    ascending: [1, 3, 2, 0, 4],
    descending: [4, 0, 2, 1, 3],
    nullRows: [5],
  });

  const dictionary = utf8(["βeta", "alpha", "zeta", "", "Alpha", "ignored"]);
  for (const { name, view } of categoryCodes()) {
    cases.push({
      name: `category/${name}-codes`,
      data: nullableData({ kind: "category", codes: { view }, dictionary }, 7, [6]),
      rowCount: 7,
      ascending: [5, 2, 1, 4, 0, 3],
      descending: [3, 0, 1, 4, 2, 5],
      nullRows: [6],
    });
  }

  for (const { name, view } of [...signedValues(), ...unsignedValues()]) {
    const signed = name.startsWith("Int") || name === "BigInt64";
    cases.push({
      name: `id/${name}`,
      data: nullableData({ kind: "id", values: { encoding: "integer", data: { view } } }, 7, [6]),
      rowCount: 7,
      ascending: signed ? [3, 1, 2, 4, 5, 0] : [1, 2, 4, 5, 3, 0],
      descending: signed ? [0, 4, 5, 2, 1, 3] : [0, 3, 4, 5, 2, 1],
      nullRows: [6],
    });
  }
  const strings = ["zeta", "alpha", "Alpha", "βeta", "alpha", "", "ignored"];
  cases.push({
    name: "id/UTF-8",
    data: nullableData({ kind: "id", values: { encoding: "utf8", ...utf8(strings) } }, 7, [6]),
    rowCount: 7,
    ascending: [5, 2, 1, 4, 0, 3],
    descending: [3, 0, 1, 4, 2, 5],
    nullRows: [6],
  });
  cases.push({
    name: "text/UTF-8",
    data: nullableData({ kind: "text", values: utf8(strings) }, 7, [6]),
    rowCount: 7,
    ascending: [5, 2, 1, 4, 0, 3],
    descending: [3, 0, 1, 4, 2, 5],
    nullRows: [6],
  });
  return cases;
}

describe("Grid sort contract", () => {
  it.each(contractCases())("sorts $name by its explicit contract permutation", async (contract) => {
    const store = storeFor(contract.data, contract.rowCount);
    for (const direction of ["ascending", "descending"] as const) {
      for (const nulls of ["first", "last"] as const) {
        const spec = { sort: [{ columnId: "value", direction, nulls }] } satisfies GridViewSpec;
        const expected = expectedRows(contract, direction, nulls);
        expect(await sortedRows(store, spec, "generic"), `${contract.name} generic`).toEqual(
          expected,
        );
        expect(await sortedRows(store, spec, "typed"), `${contract.name} typed`).toEqual(expected);
      }
    }
  });

  it("composes independent key groups while preserving physical order inside ties", async () => {
    const store = new GridDataStore();
    store.install({
      length: 8,
      columns: [
        {
          schema: { id: "group", kind: "category", nullable: true },
          data: {
            kind: "category",
            codes: { view: new Uint8Array([0, 1, 0, 1, 1, 0, 1, 0]) },
            dictionary: utf8(["b", "a"]),
            validity: validity(8, [7]),
          },
        },
        {
          schema: { id: "score", kind: "number" },
          data: {
            kind: "number",
            values: { view: new Float64Array([2, 2, Number.NaN, 1, 1, 2, Number.NaN, 100]) },
          },
        },
      ],
    });
    const spec = {
      sort: [
        { columnId: "group", direction: "ascending", nulls: "last" },
        { columnId: "score", direction: "descending", nulls: "last" },
      ],
    } satisfies GridViewSpec;
    const expected = [6, 1, 3, 4, 2, 0, 5, 7];
    expect(await sortedRows(store, spec, "generic")).toEqual(expected);
    expect(await sortedRows(store, spec, "typed")).toEqual(expected);
  });

  it("sorts a committed exact sparse edit without rounding it into the Float32 base", async () => {
    const store = storeFor(
      { kind: "number", values: { view: new Float32Array([0, 1, 1 + 2 ** -22]) } },
      3,
      true,
    );
    const datasetId = store.datasetId!;
    const staged = store.stageCellPatch({
      datasetId,
      rowId: 0,
      columnId: "value",
      cellRevision: 0,
      previousValue: 0,
      finalValue: 1 + 2 ** -25,
    });
    if (!staged || !store.promoteCellPatch(staged)) throw new Error("Expected a committed edit.");
    const spec = {
      sort: [{ columnId: "value", direction: "ascending", nulls: "last" }],
    } satisfies GridViewSpec;
    expect(await sortedRows(store, spec, "generic")).toEqual([1, 0, 2]);
    expect(await sortedRows(store, spec, "typed")).toEqual([1, 0, 2]);
  });
});
