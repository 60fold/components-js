import type { GridColumnData, GridData, GridTypedArray, Utf8Buffers } from "@grid-benchmark/types";
import type {
  GridBenchmarkDataset,
  GridBenchmarkProfileId,
  GridBenchmarkProfileMetadata,
} from "./contracts";

const NARROW_ROWS = 10_000_000;
const WIDE_ROWS = 1_000_000;
const encoder = new TextEncoder();
// Physical code order is deliberately unrelated to lexical label order. This
// catches category sorts that accidentally radix-sort raw dictionary codes.
const CATEGORY_32_LABEL_BY_CODE = Object.freeze([
  17, 3, 1, 30, 2, 14, 9, 31, 7, 15, 11, 0, 20, 6, 13, 23, 4, 19, 5, 22, 21, 10, 16, 29, 25, 28, 27,
  8, 12, 26, 18, 24,
]);
const CATEGORY_7_LABEL_BY_CODE = Object.freeze([6, 2, 3, 4, 5, 1, 0]);

export function buildBenchmarkDataset(
  profileId: GridBenchmarkProfileId,
  rowScale: number,
): GridBenchmarkDataset {
  if (isNarrowProfile(profileId)) return buildNarrow(rowScale);
  return buildWide(rowScale);
}

function buildNarrow(rowScale: number): GridBenchmarkDataset {
  const declaredRows = NARROW_ROWS;
  const rows = scaledRows(declaredRows, rowScale);
  const timestamp = new Float64Array(rows);
  const numeric = Array.from({ length: 4 }, () => new Float64Array(rows));
  const categories = [new Uint8Array(rows), new Uint8Array(rows)];

  for (let row = 0; row < rows; row++) {
    const mixed = mix32(row);
    timestamp[row] = 1_700_000_000_000 + row * 1_000;
    numeric[0]![row] = mixed % 100_003;
    numeric[1]![row] = ((mixed >>> 7) + (row % 997)) % 65_521;
    numeric[2]![row] = (row % 20_001) - 10_000;
    numeric[3]![row] = ((mixed & 0xffff) * 0.125 + (row % 17)) % 8_192;
    categories[0]![row] = mixed & 31;
    categories[1]![row] = (mixed >>> 5) % 7;
  }

  const data: GridData = {
    length: rows,
    columns: [
      column("timestamp", "timestamp", {
        kind: "timestamp",
        values: { data: transfer(timestamp), unit: "ms" },
      }),
      ...numeric.map((values, index) =>
        column(`value${index}`, "number", { kind: "number", values: transfer(values) }),
      ),
      column("category0", "category", {
        kind: "category",
        codes: transfer(categories[0]!),
        dictionary: transferUtf8(shuffledDictionary("c", CATEGORY_32_LABEL_BY_CODE)),
      }),
      column("category1", "category", {
        kind: "category",
        codes: transfer(categories[1]!),
        dictionary: transferUtf8(shuffledDictionary("g", CATEGORY_7_LABEL_BY_CODE)),
      }),
    ],
  };
  return finalizeDataset(data, {
    id: "narrow-10m",
    declaredRows,
    rows,
    rowScale,
    logicalColumns: 7,
    visibleColumns: 7,
    stableRowIds: "implicit-physical-index",
    dataTypes: { timestamp: 1, number: 4, category: 2 },
    nullDensity: 0,
    installedTypedArrayBytes: byteLengthOfGridData(data),
    syntheticGeneratedTypedArrayBytes: byteLengthOfGridData(data),
    notes: [
      "Four Float64 numeric columns, one Float64 millisecond timestamp, and two low-cardinality Uint8 dictionary columns.",
      `Implicit physical-index RowIds avoid a redundant ${(declaredRows * Uint32Array.BYTES_PER_ELEMENT) / 1_000_000} MB identifier column while retaining stable identity.`,
      "Category dictionaries use a fixed shuffled physical-code order, so lexical category sorting cannot pass by sorting raw codes.",
      "The filter-sort-3-key-25pct case filters to approximately 25% before sorting to keep the generic categorical comparator runnable.",
    ],
  });
}

function buildWide(rowScale: number): GridBenchmarkDataset {
  const rows = scaledRows(WIDE_ROWS, rowScale);
  const columns: GridData["columns"][number][] = [];

  for (let columnIndex = 0; columnIndex < 48; columnIndex++) {
    const values = new Float32Array(rows);
    for (let row = 0; row < rows; row++) {
      values[row] = (mix32(row + columnIndex * 0x9e37) % 100_003) + columnIndex / 64;
    }
    columns.push(
      column(`number${columnIndex}`, "number", { kind: "number", values: transfer(values) }),
    );
  }
  for (let columnIndex = 0; columnIndex < 24; columnIndex++) {
    const values = new Int32Array(rows);
    for (let row = 0; row < rows; row++) {
      values[row] = ((mix32(row ^ (columnIndex * 0x45d9)) % 20_001) - 10_000) | 0;
    }
    columns.push(
      column(`integer${columnIndex}`, "integer", {
        kind: "integer",
        values: transfer(values),
      }),
    );
  }
  for (let columnIndex = 0; columnIndex < 16; columnIndex++) {
    const values = new Uint8Array(rows);
    for (let row = 0; row < rows; row++) values[row] = (row + columnIndex) & 1;
    columns.push(
      column(`boolean${columnIndex}`, "boolean", {
        kind: "boolean",
        values: transfer(values),
        encoding: "byte",
      }),
    );
  }
  for (let columnIndex = 0; columnIndex < 8; columnIndex++) {
    const values = new Float64Array(rows);
    for (let row = 0; row < rows; row++) {
      values[row] = 1_700_000_000_000 + row * 1_000 + columnIndex;
    }
    columns.push(
      column(`timestamp${columnIndex}`, "timestamp", {
        kind: "timestamp",
        values: { data: transfer(values), unit: "ms" },
      }),
    );
  }
  for (let columnIndex = 0; columnIndex < 16; columnIndex++) {
    const codes = new Uint8Array(rows);
    for (let row = 0; row < rows; row++) codes[row] = mix32(row + columnIndex * 131) & 31;
    columns.push(
      column(`category${columnIndex}`, "category", {
        kind: "category",
        codes: transfer(codes),
        dictionary: transferUtf8(shuffledDictionary("c", CATEGORY_32_LABEL_BY_CODE)),
      }),
    );
  }
  for (let columnIndex = 0; columnIndex < 8; columnIndex++) {
    const values = new Uint32Array(rows);
    for (let row = 0; row < rows; row++) values[row] = row + columnIndex;
    columns.push(
      column(`id${columnIndex}`, "id", {
        kind: "id",
        values: { encoding: "integer", data: transfer(values) },
      }),
    );
  }
  for (let columnIndex = 0; columnIndex < 8; columnIndex++) {
    const offsets = new Uint32Array(rows + 1);
    const bytes = new Uint8Array(rows);
    for (let row = 0; row < rows; row++) {
      offsets[row] = row;
      bytes[row] = 97 + ((row + columnIndex) % 26);
    }
    offsets[rows] = rows;
    columns.push(
      column(`text${columnIndex}`, "text", {
        kind: "text",
        values: { offsets: transfer(offsets), data: transfer(bytes) },
      }),
    );
  }

  const data: GridData = { length: rows, columns };
  return finalizeDataset(data, {
    id: "wide-1m",
    declaredRows: WIDE_ROWS,
    rows,
    rowScale,
    logicalColumns: 128,
    visibleColumns: 16,
    stableRowIds: "implicit-physical-index",
    dataTypes: {
      number: 48,
      integer: 24,
      boolean: 16,
      timestamp: 8,
      category: 16,
      id: 8,
      text: 8,
    },
    nullDensity: 0,
    installedTypedArrayBytes: byteLengthOfGridData(data),
    syntheticGeneratedTypedArrayBytes: byteLengthOfGridData(data),
    notes: [
      "The 128 logical columns comprise 48 Float32 numbers, 24 Int32 integers, 16 byte booleans, 8 Float64 timestamps, 16 Uint8 dictionaries, 8 Uint32 IDs, and 8 one-byte UTF-8 text columns.",
      "Only benchmark key columns are touched after installation; the remaining columns measure wide-store retention and lazy-column behavior.",
      "Category dictionaries use a fixed shuffled physical-code order, so lexical category sorting cannot pass by sorting raw codes.",
      "Implicit physical-index RowIds retain stable identity without building a million-entry JavaScript RowId map.",
    ],
  });
}

function finalizeDataset(
  data: GridData,
  profile: GridBenchmarkProfileMetadata,
): GridBenchmarkDataset {
  const buffers = collectArrayBuffers(data);
  return {
    data,
    profile,
    cases: {
      "filter-numeric": {
        filter: {
          kind: "between",
          columnId: isNarrowProfile(profile.id) ? "value0" : "number0",
          lower: 25_000,
          upper: 74_999,
        },
      },
      "filter-category": {
        filter: {
          kind: "in",
          columnId: "category0",
          values: ["c03", "c07", "c11", "c19"],
        },
      },
      "sort-1-key": {
        sort: [
          {
            columnId: isNarrowProfile(profile.id) ? "value0" : "number0",
            direction: "ascending",
            nulls: "last",
          },
        ],
      },
      "filter-sort-3-key-25pct": {
        filter: {
          kind: "between",
          columnId: isNarrowProfile(profile.id) ? "value1" : "number1",
          lower: 0,
          upper: 16_383,
        },
        sort: [
          { columnId: "category0", direction: "ascending", nulls: "last" },
          {
            columnId: isNarrowProfile(profile.id) ? "value2" : "integer0",
            direction: "descending",
            nulls: "last",
          },
          {
            columnId: isNarrowProfile(profile.id) ? "value0" : "number0",
            direction: "ascending",
            nulls: "last",
          },
        ],
      },
    },
    transfer: { buffers, bytes: buffers.reduce((total, buffer) => total + buffer.byteLength, 0) },
  };
}

function column<K extends GridColumnData["kind"]>(
  id: string,
  kind: K,
  data: Extract<GridColumnData, { kind: K }>,
): GridData["columns"][number] {
  return { schema: { id, kind }, data };
}

function transfer<T extends GridTypedArray>(view: T): { view: T; ownership: "transfer" } {
  return { view, ownership: "transfer" };
}

function transferUtf8(value: Utf8Buffers): Utf8Buffers {
  return {
    offsets: transfer(value.offsets.view),
    data: transfer(value.data.view),
  };
}

function shuffledDictionary(prefix: string, labelByCode: readonly number[]): Utf8Buffers {
  const values = labelByCode.map((label) => `${prefix}${String(label).padStart(2, "0")}`);
  const encoded = values.map((value) => encoder.encode(value));
  const offsets = new Uint32Array(values.length + 1);
  const bytes = new Uint8Array(encoded.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (let index = 0; index < encoded.length; index++) {
    offsets[index] = offset;
    bytes.set(encoded[index]!, offset);
    offset += encoded[index]!.length;
  }
  offsets[values.length] = offset;
  return { offsets: { view: offsets }, data: { view: bytes } };
}

function collectArrayBuffers(data: GridData): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
      return;
    }
    if (value instanceof ArrayBuffer) {
      buffers.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(data);
  return [...buffers];
}

function byteLengthOfGridData(data: GridData): number {
  return collectArrayBuffers(data).reduce((total, buffer) => total + buffer.byteLength, 0);
}

function scaledRows(declared: number, scale: number): number {
  return Math.max(1, Math.round(declared * scale));
}

function isNarrowProfile(profileId: GridBenchmarkProfileId): profileId is "narrow-10m" {
  return profileId === "narrow-10m";
}

function mix32(value: number): number {
  let mixed = value | 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}
