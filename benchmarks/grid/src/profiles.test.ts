import { describe, expect, it } from "vitest";
import type {
  CellScalar,
  GridColumnData,
  GridData,
  GridFilter,
  GridViewSpec,
} from "@grid-benchmark/types";
import type { GridBenchmarkOrdinaryCaseId } from "./contracts";
import { validateBenchmarkCandidate } from "./oracle";
import { buildBenchmarkDataset } from "./profiles";

const ORDINARY_CASES = [
  "filter-numeric",
  "filter-category",
  "sort-1-key",
  "filter-sort-3-key-25pct",
] as const satisfies readonly GridBenchmarkOrdinaryCaseId[];

describe("canonical narrow benchmark profiles", () => {
  it("builds narrow-10m as a seven-column evidence profile", () => {
    const dataset = buildBenchmarkDataset("narrow-10m", 0.001);

    expect(dataset.profile).toMatchObject({
      id: "narrow-10m",
      declaredRows: 10_000_000,
      rows: 10_000,
      rowScale: 0.001,
      logicalColumns: 7,
      visibleColumns: 7,
      dataTypes: { timestamp: 1, number: 4, category: 2 },
      nullDensity: 0,
      installedTypedArrayBytes: 420_281,
      syntheticGeneratedTypedArrayBytes: 420_281,
    });
    expect(dataset.data.length).toBe(10_000);
    expect(dataset.data.columns.map((column) => [column.schema.id, column.data.kind])).toEqual([
      ["timestamp", "timestamp"],
      ["value0", "number"],
      ["value1", "number"],
      ["value2", "number"],
      ["value3", "number"],
      ["category0", "category"],
      ["category1", "category"],
    ]);
    expect(dataset.transfer.bytes).toBe(420_281);
    expect(dataset.transfer.buffers).toHaveLength(11);
  });

  it.each(ORDINARY_CASES)("passes the independent narrow oracle for %s", (caseId) => {
    const dataset = buildBenchmarkDataset("narrow-10m", 0.0001);
    const candidate = candidateFor(dataset.data, dataset.cases[caseId]);

    expect(validateBenchmarkCandidate(dataset.profile, caseId, candidate)).toMatchObject({
      passed: true,
      actualRowCount: candidate.physicalRows.length,
      firstFailure: null,
    });
  });
});

function candidateFor(
  data: GridData,
  view: GridViewSpec,
): { readonly physicalRows: Uint32Array; readonly filterBitmap: Uint8Array | null } {
  const rows: number[] = [];
  const filterBitmap = view.filter ? new Uint8Array(Math.ceil(data.length / 8)) : null;
  for (let row = 0; row < data.length; row++) {
    if (!matchesFilter(data, view.filter, row)) continue;
    rows.push(row);
    if (filterBitmap) filterBitmap[row >> 3]! |= 1 << (row & 7);
  }
  rows.sort((left, right) => compareRows(data, view, left, right));
  return { physicalRows: Uint32Array.from(rows), filterBitmap };
}

function matchesFilter(data: GridData, filter: GridFilter | undefined, row: number): boolean {
  if (!filter) return true;
  if (filter.kind === "between") {
    const value = scalarAt(data, filter.columnId, row);
    const lower = compareScalars(value, filter.lower);
    const upper = compareScalars(value, filter.upper);
    return (
      (filter.includeLower === false ? lower > 0 : lower >= 0) &&
      (filter.includeUpper === false ? upper < 0 : upper <= 0)
    );
  }
  if (filter.kind === "in") {
    const value = scalarAt(data, filter.columnId, row);
    return filter.values.includes(value);
  }
  throw new Error(`Unexpected canonical filter ${filter.kind}.`);
}

function compareRows(
  data: GridData,
  view: GridViewSpec,
  leftRow: number,
  rightRow: number,
): number {
  for (const sort of view.sort ?? []) {
    const compared = compareScalars(
      scalarAt(data, sort.columnId, leftRow),
      scalarAt(data, sort.columnId, rightRow),
    );
    if (compared !== 0) return sort.direction === "ascending" ? compared : -compared;
  }
  return leftRow - rightRow;
}

function scalarAt(data: GridData, columnId: string, row: number): CellScalar {
  const column = data.columns.find((candidate) => candidate.schema.id === columnId)?.data;
  if (!column) throw new Error(`Missing test column ${columnId}.`);
  if (column.kind === "number" || column.kind === "integer") return column.values.view[row]!;
  if (column.kind === "timestamp") return column.values.data.view[row]!;
  if (column.kind === "category") {
    const code = Number(column.codes.view[row]!);
    return decodeDictionaryValue(column, code);
  }
  throw new Error(`Unsupported test column kind ${column.kind}.`);
}

function decodeDictionaryValue(
  column: Extract<GridColumnData, { readonly kind: "category" }>,
  code: number,
): string {
  const start = Number(column.dictionary.offsets.view[code]!);
  const end = Number(column.dictionary.offsets.view[code + 1]!);
  return new TextDecoder().decode(column.dictionary.data.view.subarray(start, end));
}

function compareScalars(left: CellScalar, right: CellScalar): number {
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "bigint" && typeof right === "bigint") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}
