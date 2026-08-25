import { describe, expect, it } from "vitest";
import type { BufferOwnership, GridColumnData, GridData, Utf8Buffers } from "../types";
import { GridDataStore, acquireGridRuntimeIngress, preflightGridDataAsync } from "./store";

const ASYNC_TEST_VALUE_COUNT = 131_072;

function utf8(values: readonly string[], ownership?: BufferOwnership): Utf8Buffers {
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
  return {
    offsets: { view: offsets, ...(ownership ? { ownership } : {}) },
    data: { view: data, ...(ownership ? { ownership } : {}) },
  };
}

function column(id: string, data: GridColumnData, nullable = false): GridData["columns"][number] {
  return {
    schema: { id, kind: data.kind, ...(nullable ? { nullable: true } : {}) },
    data,
  };
}

function fullFixture(): GridData {
  return {
    length: 3,
    rowIds: { kind: "string", ...utf8(["row-a", "", "row-c"]) },
    columns: [
      column(
        "number",
        {
          kind: "number",
          values: { view: new Float64Array([1.5, 2.5, Number.NaN]) },
          validity: { bits: { view: new Uint8Array([0b0000_0101]) } },
        },
        true,
      ),
      column("integer", {
        kind: "integer",
        values: { view: new BigInt64Array([1n, -2n, 3n]) },
      }),
      column("boolean", {
        kind: "boolean",
        encoding: "byte",
        values: { view: new Uint8Array([1, 0, 1]) },
      }),
      column("timestamp", {
        kind: "timestamp",
        values: { data: { view: new BigInt64Array([1n, 2n, 3n]) }, unit: "ns" },
        timezone: "UTC",
      }),
      column("category", {
        kind: "category",
        codes: { view: new Uint8Array([0, 1, 0]) },
        dictionary: utf8(["alpha", "βeta"]),
      }),
      column("id", {
        kind: "id",
        values: { encoding: "integer", data: { view: new Uint32Array([10, 20, 30]) } },
      }),
      column("text", {
        kind: "text",
        values: utf8(["north", "", "south"]),
      }),
    ],
  };
}

function oneNumber(values: Float64Array, ownership?: BufferOwnership): GridData {
  return {
    length: values.length,
    columns: [
      column("value", {
        kind: "number",
        values: { view: values, ...(ownership ? { ownership } : {}) },
      }),
    ],
  };
}

describe("GridDataStore", () => {
  it("installs every v1 physical kind with stable row IDs and null-aware lookup", () => {
    const store = new GridDataStore();
    const result = store.install(fullFixture());

    expect(result.datasetId).toMatch(/^sixtyfold:grid:dataset:/);
    expect(store.rowCount).toBe(3);
    expect(store.columnIds).toEqual([
      "number",
      "integer",
      "boolean",
      "timestamp",
      "category",
      "id",
      "text",
    ]);
    expect([store.rowIdAt(0), store.rowIdAt(1), store.rowIdAt(2)]).toEqual(["row-a", "", "row-c"]);
    expect(store.rowIndexOf("")).toBe(1);
    expect(store.rowIndexOf("missing")).toBe(-1);
    expect(store.rowIndexOf(0)).toBe(-1);
    expect(store.cellAt(0, "number")).toBe(1.5);
    expect(store.cellAt(1, "number")).toBeNull();
    expect(store.cellAt(2, "number")).toBeNaN();
    expect(store.cellAt(1, "integer")).toBe(-2n);
    expect(store.cellAt(1, "boolean")).toBe(false);
    expect(store.cellAt(2, "timestamp")).toBe(3n);
    expect(store.cellAt(1, "category")).toBe("βeta");
    expect(store.cellAt(2, "id")).toBe(30);
    expect(store.cellAt(1, "text")).toBe("");
  });

  it("exposes zero-decoding typed columns while unsupported kinds fall back", () => {
    const store = new GridDataStore();
    store.install(fullFixture());

    const number = store.typedColumnAt("number");
    expect(number?.kind).toBe("number");
    if (!number || number.kind !== "number") throw new Error("Expected a typed number column.");
    expect(number.rowCount).toBe(3);
    expect(number.values).toBeInstanceOf(Float64Array);
    expect(Array.from(number.values)).toEqual([1.5, 2.5, Number.NaN]);
    expect(number.validity).toEqual({ bits: new Uint8Array([0b0000_0101]), bitOffset: 0 });
    expect(number.overrides).toBeUndefined();

    const integer = store.typedColumnAt("integer");
    expect(integer?.kind).toBe("integer");
    if (!integer || integer.kind !== "integer") throw new Error("Expected a typed integer column.");
    expect(integer.values).toBeInstanceOf(BigInt64Array);
    if (!(integer.values instanceof BigInt64Array)) throw new Error("Expected bigint storage.");
    expect(Array.from(integer.values)).toEqual([1n, -2n, 3n]);

    const boolean = store.typedColumnAt("boolean");
    expect(boolean?.kind).toBe("boolean");
    if (!boolean || boolean.kind !== "boolean") throw new Error("Expected a typed boolean column.");
    expect(boolean.encoding).toBe("byte");
    expect(boolean.bitOffset).toBe(0);
    expect(Array.from(boolean.values)).toEqual([1, 0, 1]);

    const timestamp = store.typedColumnAt("timestamp");
    expect(timestamp?.kind).toBe("timestamp");
    if (!timestamp || timestamp.kind !== "timestamp") {
      throw new Error("Expected a typed timestamp column.");
    }
    expect(timestamp.unit).toBe("ns");
    if (!(timestamp.values instanceof BigInt64Array)) throw new Error("Expected bigint storage.");
    expect(Array.from(timestamp.values)).toEqual([1n, 2n, 3n]);

    expect(store.typedColumnAt("id")).toBeNull();
    expect(store.typedColumnAt("text")).toBeNull();
  });

  it("caches category codes, decoded labels, lookup, and code-unit lexical ranks", () => {
    const store = new GridDataStore();
    store.install({
      length: 4,
      columns: [
        column("category", {
          kind: "category",
          codes: { view: new Uint8Array([0, 1, 2, 3]) },
          dictionary: utf8(["zeta", "alpha", "βeta", "Alpha"]),
        }),
      ],
    });

    const category = store.typedColumnAt("category");
    expect(category?.kind).toBe("category");
    if (!category || category.kind !== "category") {
      throw new Error("Expected a typed category column.");
    }
    expect(Array.from(category.codes)).toEqual([0, 1, 2, 3]);
    expect(category.dictionary).toEqual(["zeta", "alpha", "βeta", "Alpha"]);
    expect(category.codeByValue.get("βeta")).toBe(2);
    expect(Array.from(category.lexicalRanks)).toEqual([2, 1, 3, 0]);
    expect(store.categoryValuesAt("category")).toBe(category.dictionary);

    const again = store.typedColumnAt(0);
    expect(again?.kind).toBe("category");
    if (!again || again.kind !== "category") throw new Error("Expected cached category access.");
    expect(again.dictionary).toBe(category.dictionary);
    expect(again.lexicalRanks).toBe(category.lexicalRanks);
    expect(again.codeByValue).toBe(category.codeByValue);
  });

  it("generates ingestion ordinals and preserves RowId type identity", () => {
    const generated = new GridDataStore();
    generated.install(oneNumber(new Float64Array([4, 5, 6])));
    expect([generated.rowIdAt(0), generated.rowIdAt(2)]).toEqual([0, 2]);
    expect(generated.rowIndexOf(2)).toBe(2);
    expect(generated.rowIndexOf(2n)).toBe(-1);
    expect(generated.rowIndexOf(-0)).toBe(-1);

    const numeric = new GridDataStore();
    numeric.install({
      ...oneNumber(new Float64Array([1])),
      rowIds: { kind: "number", values: { view: new Float64Array([1]) } },
    });
    const big = new GridDataStore();
    big.install({
      ...oneNumber(new Float64Array([1])),
      rowIds: { kind: "bigint", values: { view: new BigInt64Array([1n]) } },
    });
    const string = new GridDataStore();
    string.install({
      ...oneNumber(new Float64Array([1])),
      rowIds: { kind: "string", ...utf8(["1"]) },
    });

    expect(numeric.rowIdAt(0)).toBe(1);
    expect(big.rowIdAt(0)).toBe(1n);
    expect(string.rowIdAt(0)).toBe("1");
    expect(numeric.rowIndexOf(1n)).toBe(-1);
    expect(big.rowIndexOf(1)).toBe(-1);
    expect(string.rowIndexOf(1)).toBe(-1);
  });

  it("copies only the referenced view and isolates installed values", () => {
    const backing = new Float64Array([111, 1, 2, 999]);
    const view = new Float64Array(backing.buffer, Float64Array.BYTES_PER_ELEMENT, 2);
    const store = new GridDataStore();
    const result = store.install(oneNumber(view, "copy"));

    view[0] = 77;
    backing[2] = 88;
    expect(store.cellAt(0, 0)).toBe(1);
    expect(store.cellAt(1, 0)).toBe(2);
    expect(result.buffers).toEqual([
      {
        path: "columns[0].data.values",
        requested: "copy",
        installed: "copied",
        byteLength: 16,
      },
    ]);
  });

  it("transfers a shared backing ArrayBuffer once while retaining aliased views", () => {
    const backing = new Float64Array([10, 20, 30, 40]);
    const first = new Float64Array(backing.buffer, 0, 2);
    const second = new Float64Array(backing.buffer, 16, 2);
    const store = new GridDataStore();
    const result = store.install({
      length: 2,
      columns: [
        column("first", {
          kind: "number",
          values: { view: first, ownership: "transfer" },
        }),
        column("second", {
          kind: "number",
          values: { view: second, ownership: "transfer" },
        }),
      ],
    });

    expect(backing.buffer.byteLength).toBe(0);
    expect([store.cellAt(0, "first"), store.cellAt(1, "second")]).toEqual([10, 40]);
    expect(result.buffers.map((entry) => entry.byteLength)).toEqual([16, 16]);
    expect(result.buffers.every((entry) => entry.installed === "transferred")).toBe(true);
  });

  it.runIf(typeof SharedArrayBuffer !== "undefined")("retains explicitly shared buffers", () => {
    const buffer = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT * 2);
    const values = new Float64Array(buffer);
    values.set([7, 8]);
    const store = new GridDataStore();
    const result = store.install(oneNumber(values, "shared"));

    expect(store.cellAt(0, 0)).toBe(7);
    values[0] = 9;
    expect(store.cellAt(0, 0)).toBe(9);
    expect(result.buffers[0]).toMatchObject({ requested: "shared", installed: "shared" });
  });

  it("returns a fresh opaque dataset ID for identical bytes", () => {
    const store = new GridDataStore();
    const first = store.install(oneNumber(new Float64Array([1, 2]))).datasetId;
    const second = store.install(oneNumber(new Float64Array([1, 2]))).datasetId;
    expect(second).not.toBe(first);
  });

  it("keeps the prior dataset active and buffers attached after failed preflight", async () => {
    const store = new GridDataStore();
    const prior = store.install(oneNumber(new Float64Array([3, 4]))).datasetId;
    const backing = new Float64Array([5, 6]);
    const shared = new Float64Array(backing.buffer);

    const candidate: GridData = {
      length: 2,
      columns: [
        column("a", {
          kind: "number",
          values: { view: backing, ownership: "transfer" },
        }),
        column("b", {
          kind: "number",
          values: { view: shared, ownership: "copy" },
        }),
      ],
    };

    expect(() => store.install(candidate)).toThrow(/conflicting ownership/);
    await expect(preflightGridDataAsync(candidate, { yieldIntervalMs: 0 })).rejects.toThrow(
      /conflicting ownership/,
    );
    expect(backing.buffer.byteLength).toBe(16);
    expect(store.datasetId).toBe(prior);
    expect(store.cellAt(1, 0)).toBe(4);
  });

  it("reads bit-packed booleans with offsets", () => {
    const store = new GridDataStore();
    store.install({
      length: 4,
      columns: [
        column("flag", {
          kind: "boolean",
          encoding: "bitmap",
          bitOffset: 2,
          values: { view: new Uint8Array([0b0010_1100]) },
        }),
      ],
    });
    expect([0, 1, 2, 3].map((row) => store.cellAt(row, 0))).toEqual([true, true, false, true]);
  });

  it("accepts every declared integer width and floating precision", () => {
    const numberArrays = [new Float32Array([1]), new Float64Array([2])];
    const integerArrays = [
      new Int8Array([-1]),
      new Uint8Array([1]),
      new Int16Array([-2]),
      new Uint16Array([2]),
      new Int32Array([-3]),
      new Uint32Array([3]),
      new BigInt64Array([-4n]),
      new BigUint64Array([4n]),
    ];

    for (const values of numberArrays) {
      const store = new GridDataStore();
      store.install({
        length: 1,
        columns: [column("value", { kind: "number", values: { view: values } })],
      });
      expect(Number(store.cellAt(0, 0))).toBe(Number(values[0]));
    }
    for (const values of integerArrays) {
      const store = new GridDataStore();
      store.install({
        length: 1,
        columns: [column("value", { kind: "integer", values: { view: values } })],
      });
      expect(store.cellAt(0, 0)).toBe(values[0]);
    }
  });

  it("accepts millisecond Float64 timestamps and UTF-8 identifier columns", () => {
    const store = new GridDataStore();
    store.install({
      length: 2,
      columns: [
        column("time", {
          kind: "timestamp",
          values: { data: { view: new Float64Array([1_000, 2_000]) }, unit: "ms" },
        }),
        column("id", {
          kind: "id",
          values: { encoding: "utf8", ...utf8(["node-1", "node-2"]) },
        }),
      ],
    });
    expect(store.cellAt(1, "time")).toBe(2_000);
    expect(store.cellAt(0, "id")).toBe("node-1");
  });

  it("honors validity bit offsets", () => {
    const store = new GridDataStore();
    store.install({
      length: 3,
      columns: [
        column(
          "value",
          {
            kind: "number",
            values: { view: new Float64Array([1, 2, 3]) },
            validity: { bits: { view: new Uint8Array([0b0000_1010]) }, bitOffset: 1 },
          },
          true,
        ),
      ],
    });
    expect([0, 1, 2].map((row) => store.cellAt(row, 0))).toEqual([1, null, 3]);
  });

  it.each([
    {
      name: "invalid length",
      data: { length: -1, columns: [] },
      message: /non-negative safe integer/,
    },
    {
      name: "empty column ID",
      data: {
        length: 1,
        columns: [column("", { kind: "number", values: { view: new Float64Array([1]) } })],
      },
      message: /non-empty string/,
    },
    {
      name: "duplicate column ID",
      data: {
        length: 1,
        columns: [
          column("value", { kind: "number", values: { view: new Float64Array([1]) } }),
          column("value", { kind: "number", values: { view: new Float64Array([2]) } }),
        ],
      },
      message: /Duplicate grid column ID/,
    },
    {
      name: "schema/data mismatch",
      data: {
        length: 1,
        columns: [
          {
            schema: { id: "value", kind: "text" },
            data: { kind: "number", values: { view: new Float64Array([1]) } },
          },
        ],
      },
      message: /declares kind text/,
    },
    {
      name: "invalid nullable schema flag",
      data: {
        length: 1,
        columns: [
          {
            schema: { id: "value", kind: "number", nullable: "yes" },
            data: { kind: "number", values: { view: new Float64Array([1]) } },
          },
        ],
      },
      message: /nullable must be a boolean/,
    },
    {
      name: "column length mismatch",
      data: oneNumber(new Float64Array([1, 2])),
      mutate: (data: GridData) => ({ ...data, length: 3 }),
      message: /expected 3/,
    },
    {
      name: "short validity bitmap",
      data: {
        length: 9,
        columns: [
          column(
            "value",
            {
              kind: "number",
              values: { view: new Float64Array(9) },
              validity: { bits: { view: new Uint8Array([0xff]) } },
            },
            true,
          ),
        ],
      },
      message: /enough bits/,
    },
    {
      name: "null in non-nullable column",
      data: {
        length: 2,
        columns: [
          column("value", {
            kind: "number",
            values: { view: new Float64Array([1, 2]) },
            validity: { bits: { view: new Uint8Array([0b01]) } },
          }),
        ],
      },
      message: /not nullable/,
    },
    {
      name: "invalid boolean byte",
      data: {
        length: 2,
        columns: [
          column("flag", {
            kind: "boolean",
            encoding: "byte",
            values: { view: new Uint8Array([0, 2]) },
          }),
        ],
      },
      message: /zero or one/,
    },
    {
      name: "out-of-range category code",
      data: {
        length: 1,
        columns: [
          column("category", {
            kind: "category",
            codes: { view: new Uint8Array([1]) },
            dictionary: utf8(["only"]),
          }),
        ],
      },
      message: /outside the dictionary/,
    },
    {
      name: "duplicate dictionary entry",
      data: {
        length: 1,
        columns: [
          column("category", {
            kind: "category",
            codes: { view: new Uint8Array([0]) },
            dictionary: utf8(["same", "same"]),
          }),
        ],
      },
      message: /duplicate value/,
    },
    {
      name: "invalid UTF-8",
      data: {
        length: 1,
        columns: [
          column("text", {
            kind: "text",
            values: {
              offsets: { view: new Uint32Array([0, 1]) },
              data: { view: new Uint8Array([0xff]) },
            },
          }),
        ],
      },
      message: /not valid UTF-8/,
    },
    {
      name: "non-monotone UTF-8 offsets",
      data: {
        length: 2,
        columns: [
          column("text", {
            kind: "text",
            values: {
              offsets: { view: new Int32Array([0, 2, 1]) },
              data: { view: new Uint8Array([97, 98]) },
            },
          }),
        ],
      },
      message: /not monotone/,
    },
    {
      name: "unsafe numeric RowId",
      data: {
        ...oneNumber(new Float64Array([1])),
        rowIds: {
          kind: "number",
          values: { view: new Float64Array([Number.MAX_SAFE_INTEGER + 1]) },
        },
      },
      message: /valid numeric RowId/,
    },
    {
      name: "non-finite numeric RowId",
      data: {
        ...oneNumber(new Float64Array([1])),
        rowIds: { kind: "number", values: { view: new Float64Array([Number.NaN]) } },
      },
      message: /valid numeric RowId/,
    },
    {
      name: "negative-zero RowId",
      data: {
        ...oneNumber(new Float64Array([1])),
        rowIds: { kind: "number", values: { view: new Float64Array([-0]) } },
      },
      message: /valid numeric RowId/,
    },
    {
      name: "duplicate RowId",
      data: {
        ...oneNumber(new Float64Array([1, 2])),
        rowIds: { kind: "string", ...utf8(["same", "same"]) },
      },
      message: /duplicate value/,
    },
  ])("rejects $name before activation", async ({ data, mutate, message }) => {
    const store = new GridDataStore();
    const candidate = mutate ? mutate(data as GridData) : data;
    expect(() => store.install(candidate as GridData)).toThrow(message);
    await expect(
      preflightGridDataAsync(candidate as GridData, { yieldIntervalMs: 0 }),
    ).rejects.toThrow(message);
    expect(store.datasetId).toBeNull();
  });

  it("rejects invalid shared ownership declarations", async () => {
    const store = new GridDataStore();
    const data = oneNumber(new Float64Array([1]), "shared");
    expect(() => store.install(data)).toThrow(/without SharedArrayBuffer/);
    await expect(preflightGridDataAsync(data, { yieldIntervalMs: 0 })).rejects.toThrow(
      /without SharedArrayBuffer/,
    );
  });

  it("adopts message-owned copy and transfer views without a second acquisition", async () => {
    const copied = new Float64Array([1, 2]);
    const transferBacking = new Float64Array([3, 4, 5, 6]);
    const transferred = new Float64Array(transferBacking.buffer, 0, 2);
    const transferredAlias = new Float64Array(
      transferBacking.buffer,
      Float64Array.BYTES_PER_ELEMENT * 2,
      2,
    );
    const data: GridData = {
      length: 2,
      columns: [
        column("copied", {
          kind: "number",
          values: { view: copied, ownership: "copy" },
        }),
        column("transferred", {
          kind: "number",
          values: { view: transferred, ownership: "transfer" },
        }),
        column("transferred-alias", {
          kind: "number",
          values: { view: transferredAlias, ownership: "transfer" },
        }),
      ],
    };

    const preflight = await preflightGridDataAsync(data, { yieldIntervalMs: 0 });
    expect(transferred.buffer.byteLength).toBe(32);
    const store = new GridDataStore();
    const result = store.installWorkerIngress(data, preflight);

    const copiedColumn = store.typedColumnAt("copied");
    const transferredColumn = store.typedColumnAt("transferred");
    const transferredAliasColumn = store.typedColumnAt("transferred-alias");
    expect(copiedColumn?.kind).toBe("number");
    expect(transferredColumn?.kind).toBe("number");
    expect(transferredAliasColumn?.kind).toBe("number");
    if (
      copiedColumn?.kind !== "number" ||
      transferredColumn?.kind !== "number" ||
      transferredAliasColumn?.kind !== "number"
    ) {
      throw new Error("Expected numeric worker-ingress columns.");
    }
    expect(copiedColumn.values).toBe(copied);
    expect(transferredColumn.values).toBe(transferred);
    expect(transferredAliasColumn.values).toBe(transferredAlias);
    expect(transferred.buffer.byteLength).toBe(32);
    expect(result.buffers).toEqual([
      {
        path: "columns[0].data.values",
        requested: "copy",
        installed: "copied",
        byteLength: 16,
      },
      {
        path: "columns[1].data.values",
        requested: "transfer",
        installed: "transferred",
        byteLength: 16,
      },
      {
        path: "columns[2].data.values",
        requested: "transfer",
        installed: "transferred",
        byteLength: 16,
      },
    ]);
  });

  it("captures an exact-range copy and immutable metadata before asynchronous dispatch", () => {
    const backing = new Float64Array([99, 1, 2, 88]);
    const source = new Float64Array(backing.buffer, Float64Array.BYTES_PER_ELEMENT, 2);
    const data = oneNumber(source, "copy");

    const ingress = acquireGridRuntimeIngress(data);
    const values = ingress.data.columns[0]!.data;
    if (values.kind !== "number") throw new Error("Expected a numeric ingress column.");

    expect(source.buffer.byteLength).toBe(32);
    expect(values.values.view).toEqual(new Float64Array([1, 2]));
    expect(values.values.view.byteOffset).toBe(0);
    expect(values.values.view.buffer.byteLength).toBe(16);
    expect(values.values.ownership).toBe("copy");
    expect(ingress.transfer).toEqual([values.values.view.buffer]);

    source.set([7, 8]);
    (data.columns[0]!.schema as { id: string }).id = "mutated";
    expect(values.values.view).toEqual(new Float64Array([1, 2]));
    expect(ingress.data.columns[0]!.schema.id).toBe("value");
  });

  it("consumes an aliased transfer once while preserving its subview geometry", () => {
    const backing = new Float64Array([1, 2, 3, 4]);
    const left = new Float64Array(backing.buffer, 0, 2);
    const right = new Float64Array(backing.buffer, Float64Array.BYTES_PER_ELEMENT * 2, 2);
    const data: GridData = {
      length: 2,
      columns: [
        column("left", {
          kind: "number",
          values: { view: left, ownership: "transfer" },
        }),
        column("right", {
          kind: "number",
          values: { view: right, ownership: "transfer" },
        }),
      ],
    };

    const ingress = acquireGridRuntimeIngress(data);
    expect(backing.buffer.byteLength).toBe(0);
    expect(ingress.transfer).toHaveLength(1);
    const leftData = ingress.data.columns[0]!.data;
    const rightData = ingress.data.columns[1]!.data;
    if (leftData.kind !== "number" || rightData.kind !== "number") {
      throw new Error("Expected numeric ingress columns.");
    }
    expect(leftData.values.view.buffer).toBe(rightData.values.view.buffer);
    expect(leftData.values.view.byteOffset).toBe(0);
    expect(rightData.values.view.byteOffset).toBe(Float64Array.BYTES_PER_ELEMENT * 2);
    expect(leftData.values.view).toEqual(new Float64Array([1, 2]));
    expect(rightData.values.view).toEqual(new Float64Array([3, 4]));
  });

  it("defers semantic validation to the runtime after transfer ingress is consumed", async () => {
    const values = new Uint8Array([0, 2]);
    const data: GridData = {
      length: 2,
      columns: [
        column("flag", {
          kind: "boolean",
          encoding: "byte",
          values: { view: values, ownership: "transfer" },
        }),
      ],
    };

    const ingress = acquireGridRuntimeIngress(data);
    expect(values.buffer.byteLength).toBe(0);
    await expect(preflightGridDataAsync(ingress.data, { yieldIntervalMs: 0 })).rejects.toThrow(
      /zero or one/,
    );
  });

  it("rejects structural alias conflicts before consuming transfer ownership", () => {
    const backing = new Float64Array([1, 2]);
    const data: GridData = {
      length: 2,
      columns: [
        column("copied", {
          kind: "number",
          values: { view: backing, ownership: "copy" },
        }),
        column("transferred", {
          kind: "number",
          values: { view: backing, ownership: "transfer" },
        }),
      ],
    };

    expect(() => acquireGridRuntimeIngress(data)).toThrow(/conflicting ownership/);
    expect(backing.buffer.byteLength).toBe(16);
  });

  it.runIf(typeof SharedArrayBuffer !== "undefined")(
    "adopts shared worker ingress while retaining the shared manifest",
    async () => {
      const backing = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT * 2);
      const shared = new Float64Array(backing);
      shared.set([5, 6]);
      const data = oneNumber(shared, "shared");
      const preflight = await preflightGridDataAsync(data, { yieldIntervalMs: 0 });
      const store = new GridDataStore();
      const result = store.installWorkerIngress(data, preflight);

      const installed = store.typedColumnAt(0);
      expect(installed?.kind).toBe("number");
      if (installed?.kind !== "number") throw new Error("Expected a numeric shared column.");
      expect(installed.values).toBe(shared);
      expect(result.buffers[0]).toMatchObject({
        requested: "shared",
        installed: "shared",
      });
    },
  );

  it("does not detach transfer buffers when asynchronous preflight fails", async () => {
    const values = new Uint8Array([0, 2]);
    const data: GridData = {
      length: 2,
      columns: [
        column("flag", {
          kind: "boolean",
          encoding: "byte",
          values: { view: values, ownership: "transfer" },
        }),
      ],
    };

    await expect(preflightGridDataAsync(data, { yieldIntervalMs: 0 })).rejects.toThrow(
      /zero or one/,
    );
    expect(values.buffer.byteLength).toBe(2);
  });

  it("yields between validation slices and aborts without issuing a preflight proof", async () => {
    const values = new Uint8Array(ASYNC_TEST_VALUE_COUNT);
    const controller = new AbortController();
    let scheduledAbort = false;
    let abortTaskRan = false;
    const progress: number[] = [];

    const pending = preflightGridDataAsync(
      {
        length: values.length,
        columns: [
          column("flag", {
            kind: "boolean",
            encoding: "byte",
            values: { view: values, ownership: "transfer" },
          }),
        ],
      },
      {
        signal: controller.signal,
        yieldIntervalMs: 0,
        onProgress(update) {
          if (update.phase !== "column" || update.path !== "columns[0].data.values") return;
          progress.push(update.completed);
          if (scheduledAbort) return;
          scheduledAbort = true;
          setTimeout(() => {
            abortTaskRan = true;
            controller.abort("test cancellation");
          }, 0);
        },
      },
    );

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(abortTaskRan).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toBeLessThan(values.length);
    expect(values.buffer.byteLength).toBe(ASYNC_TEST_VALUE_COUNT);
  });

  it("guards inactive and out-of-range access", () => {
    const store = new GridDataStore();
    expect(() => store.rowIdAt(0)).toThrow(/No grid dataset/);
    store.install(oneNumber(new Float64Array([1])));
    expect(() => store.cellAt(1, 0)).toThrow(/outside the active dataset/);
    expect(() => store.cellAt(0, "missing")).toThrow(/Unknown grid column/);
  });

  it("stages, discards, and promotes one sparse patch without mutating base arrays", () => {
    const values = new Float64Array([1, 2]);
    const store = new GridDataStore();
    const { datasetId } = store.install({
      length: 2,
      rowIds: { kind: "string", ...utf8(["a", "b"]) },
      columns: [
        {
          schema: { id: "value", kind: "number", editable: true },
          data: { kind: "number", values: { view: values } },
        },
      ],
    });
    const baseline = {
      datasetId,
      rowId: "a",
      columnId: "value",
      cellRevision: 0,
      previousValue: 1,
    } as const;

    const discarded = store.stageCellPatch({ ...baseline, finalValue: 7 });
    expect(discarded).not.toBeNull();
    expect(store.cellAt(0, "value")).toBe(1);
    expect(store.stagedCellAt(discarded!, 0, "value")).toBe(7);
    expect(store.stagedCellAt(discarded!, 1, "value")).toBe(2);
    expect(values).toEqual(new Float64Array([1, 2]));
    expect(() => store.stageCellPatch({ ...baseline, finalValue: 8 })).toThrow(
      /already has a staged cell patch/,
    );
    expect(store.discardCellPatch(discarded!)).toBe(true);
    expect(store.cellState("a", "value")).toEqual({ value: 1, revision: 0 });

    const promoted = store.stageCellPatch({ ...baseline, finalValue: 9 });
    expect(promoted).not.toBeNull();
    expect(store.promoteCellPatch(promoted!)).toBe(true);
    expect(store.cellAt(0, "value")).toBe(9);
    expect(store.cellState("a", "value")).toEqual({ value: 9, revision: 1 });
    expect(values).toEqual(new Float64Array([1, 2]));
    expect(store.stageCellPatch({ ...baseline, finalValue: 10 })).toBeNull();
  });

  it("keeps typed sparse overrides private, immutable by generation, and base-preserving", () => {
    const source = new Float64Array([1, 2]);
    const store = new GridDataStore();
    const { datasetId } = store.install({
      length: 2,
      columns: [
        {
          schema: { id: "value", kind: "number", editable: true, nullable: true },
          data: { kind: "number", values: { view: source } },
        },
      ],
    });

    const first = store.stageCellPatch({
      datasetId,
      rowId: 0,
      columnId: "value",
      cellRevision: 0,
      previousValue: 1,
      finalValue: 7,
    });
    expect(first).not.toBeNull();
    expect(store.typedColumnAt("value")?.overrides).toBeUndefined();
    expect(store.typedColumnAt("value", first!)?.overrides?.get(0)).toBe(7);
    expect(store.promoteCellPatch(first!)).toBe(true);

    const committed = store.typedColumnAt("value");
    expect(committed?.overrides?.get(0)).toBe(7);
    const firstGeneration = committed?.overrides;

    const nullable = store.stageCellPatch({
      datasetId,
      rowId: 0,
      columnId: "value",
      cellRevision: 1,
      previousValue: 7,
      finalValue: null,
    });
    expect(nullable).not.toBeNull();
    expect(store.typedColumnAt("value")?.overrides?.get(0)).toBe(7);
    const nullableCandidate = store.typedColumnAt("value", nullable!);
    expect(nullableCandidate?.overrides?.has(0)).toBe(true);
    expect(nullableCandidate?.overrides?.get(0)).toBeNull();
    expect(store.discardCellPatch(nullable!)).toBe(true);

    const second = store.stageCellPatch({
      datasetId,
      rowId: 1,
      columnId: "value",
      cellRevision: 0,
      previousValue: 2,
      finalValue: 9,
    });
    expect(store.promoteCellPatch(second!)).toBe(true);
    expect(store.typedColumnAt("value")?.overrides).toEqual(
      new Map([
        [0, 7],
        [1, 9],
      ]),
    );
    expect(firstGeneration).toEqual(new Map([[0, 7]]));
    expect(source).toEqual(new Float64Array([1, 2]));
  });

  it("surfaces category edit overrides as sparse scalar values without decoding base rows", () => {
    const store = new GridDataStore();
    const { datasetId } = store.install({
      length: 2,
      columns: [
        {
          schema: { id: "region", kind: "category", editable: true },
          data: {
            kind: "category",
            codes: { view: new Uint8Array([0, 1]) },
            dictionary: utf8(["north", "south"]),
          },
        },
      ],
    });
    const staged = store.stageCellPatch({
      datasetId,
      rowId: 0,
      columnId: "region",
      cellRevision: 0,
      previousValue: "north",
      finalValue: "south",
    });
    const category = store.typedColumnAt("region", staged!);
    expect(category?.kind).toBe("category");
    if (!category || category.kind !== "category") throw new Error("Expected category access.");
    expect(category.overrides?.get(0)).toBe("south");
    expect(category.codeByValue.get(category.overrides?.get(0) as string)).toBe(1);
    expect(Array.from(category.codes)).toEqual([0, 1]);
  });

  it("uses type-sensitive baselines and invalidates staged patches on replacement", () => {
    const store = new GridDataStore();
    const { datasetId } = store.install({
      length: 1,
      columns: [
        {
          schema: { id: "value", kind: "number", editable: true },
          data: { kind: "number", values: { view: new Float64Array([-0]) } },
        },
      ],
    });
    expect(
      store.isCellBaselineCurrent({
        datasetId,
        rowId: 0,
        columnId: "value",
        cellRevision: 0,
        previousValue: 0,
      }),
    ).toBe(false);
    const staged = store.stageCellPatch({
      datasetId,
      rowId: 0,
      columnId: "value",
      cellRevision: 0,
      previousValue: -0,
      finalValue: 4,
    });
    expect(staged).not.toBeNull();

    store.install(oneNumber(new Float64Array([5])));
    expect(store.promoteCellPatch(staged!)).toBe(false);
    expect(() => store.stagedCellAt(staged!, 0, 0)).toThrow(/no longer active/);
    expect(() => store.typedColumnAt(0, staged!)).toThrow(/no longer active/);
    expect(store.cellAt(0, 0)).toBe(5);
    expect(store.cellState(0, "value").revision).toBe(0);
  });

  it("validates nullable, integer-width, category, and immutable edit values", () => {
    const store = new GridDataStore();
    store.install({
      length: 1,
      columns: [
        {
          schema: { id: "small", kind: "integer", editable: true },
          data: { kind: "integer", values: { view: new Int8Array([1]) } },
        },
        {
          schema: { id: "region", kind: "category", editable: true },
          data: {
            kind: "category",
            codes: { view: new Uint8Array([0]) },
            dictionary: utf8(["north", "south"]),
          },
        },
        {
          schema: { id: "note", kind: "text", editable: true, nullable: true },
          data: { kind: "text", values: utf8(["ok"]) },
        },
      ],
    });

    expect(() => store.validateEditableCellValue(0, "small", 127)).not.toThrow();
    expect(() => store.validateEditableCellValue(0, "small", 128)).toThrow(/physical width/);
    expect(() => store.validateEditableCellValue(0, "small", 1.5)).toThrow(/an integer/);
    expect(() => store.validateEditableCellValue(0, "region", "south")).not.toThrow();
    expect(() => store.validateEditableCellValue(0, "region", "west")).toThrow(
      /installed category label/,
    );
    expect(() => store.validateEditableCellValue(0, "note", null)).not.toThrow();
  });

  it("parses built-in editor values without locale or implicit-null coercion", () => {
    const store = new GridDataStore();
    store.install({
      length: 1,
      columns: [
        {
          schema: { id: "float", kind: "number", editable: true },
          data: { kind: "number", values: { view: new Float64Array([1]) } },
        },
        {
          schema: { id: "large", kind: "integer", editable: true },
          data: { kind: "integer", values: { view: new BigUint64Array([1n]) } },
        },
        {
          schema: { id: "enabled", kind: "boolean", editable: true },
          data: { kind: "boolean", encoding: "byte", values: { view: new Uint8Array([1]) } },
        },
        {
          schema: { id: "region", kind: "category", editable: true },
          data: {
            kind: "category",
            codes: { view: new Uint8Array([0]) },
            dictionary: utf8(["north", "south"]),
          },
        },
        {
          schema: { id: "note", kind: "text", editable: true, nullable: true },
          data: { kind: "text", values: utf8(["ok"]) },
        },
      ],
    });

    expect(store.parseEditableCellValue(0, "float", "-1.25e2")).toBe(-125);
    expect(() => store.parseEditableCellValue(0, "float", " 1 ")).toThrow(/decimal number/);
    expect(() => store.parseEditableCellValue(0, "float", "Infinity")).toThrow(/decimal number/);
    expect(store.parseEditableCellValue(0, "large", "18446744073709551615")).toBe(
      18_446_744_073_709_551_615n,
    );
    expect(() => store.parseEditableCellValue(0, "large", "18446744073709551616")).toThrow(
      /physical width/,
    );
    expect(store.parseEditableCellValue(0, "enabled", "false")).toBe(false);
    expect(store.categoryValuesAt("region")).toEqual(["north", "south"]);
    expect(Object.isFrozen(store.categoryValuesAt("region"))).toBe(true);
    expect(store.parseEditableCellValue(0, "region", "south")).toBe("south");
    expect(() => store.parseEditableCellValue(0, "region", "west")).toThrow(
      /installed category label/,
    );
    expect(store.parseEditableCellValue(0, "note", "")).toBe("");
    expect(store.parseEditableCellValue(0, "note", "ignored", true)).toBeNull();
    expect(() => store.parseEditableCellValue(0, "float", "", true)).toThrow(/not nullable/);
    expect(() => store.categoryValuesAt("note")).toThrow(/not category/);
  });

  it.each([
    {
      name: "non-boolean editable flag",
      schema: { id: "value", kind: "number", editable: "yes" },
      data: { kind: "number", values: { view: new Float64Array([1]) } },
      message: /editable must be a boolean/,
    },
    {
      name: "editor options on a read-only column",
      schema: { id: "value", kind: "number", edit: { label: "Value" } },
      data: { kind: "number", values: { view: new Float64Array([1]) } },
      message: /requires editable: true/,
    },
    {
      name: "editable timestamp",
      schema: { id: "time", kind: "timestamp", editable: true },
      data: {
        kind: "timestamp",
        values: { data: { view: new Float64Array([1]) }, unit: "ms" },
      },
      message: /immutable timestamp/,
    },
  ])("rejects $name", async ({ schema, data, message }) => {
    const store = new GridDataStore();
    const candidate = {
      length: 1,
      columns: [{ schema, data }],
    } as GridData;
    expect(() => store.install(candidate)).toThrow(message);
    await expect(preflightGridDataAsync(candidate, { yieldIntervalMs: 0 })).rejects.toThrow(
      message,
    );
  });
});
