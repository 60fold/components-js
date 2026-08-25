/// <reference lib="webworker" />

import { buildBenchmarkDataset } from "@grid-lifecycle/profiles";
import type { GridData } from "@grid-benchmark/types";
import type {
  GridLifecycleGeneratedDataset,
  GridLifecycleGeneratorInput,
  GridLifecycleGeneratorOutput,
  GridLifecycleOwnership,
} from "./contracts";

self.onmessage = (event: MessageEvent<GridLifecycleGeneratorInput>) => {
  try {
    const request = event.data;
    const dataset = buildBenchmarkDataset(request.profile, request.rowScale);
    const data = applyRowIdMode(dataset.data, request.rowIdMode, request.generation);
    applyOwnership(data, request.ownership);
    perturbReplacement(data, request.profile, request.generation);
    const oracle = buildOracle(data, request.profile);
    const buffers = collectArrayBuffers(data);
    const explicitRowIdBytes = request.rowIdMode === "explicit-number" ? data.length * 8 : 0;
    const output: GridLifecycleGeneratorOutput = {
      type: "generated",
      data,
      profile: {
        ...dataset.profile,
        id: request.profile,
        stableRowIds:
          request.rowIdMode === "explicit-number"
            ? "explicit-unique-float64"
            : "implicit-physical-index",
        installedTypedArrayBytes: dataset.profile.installedTypedArrayBytes + explicitRowIdBytes,
        syntheticGeneratedTypedArrayBytes:
          dataset.profile.syntheticGeneratedTypedArrayBytes + explicitRowIdBytes,
        notes: [
          ...dataset.profile.notes,
          ...(request.rowIdMode === "explicit-number"
            ? [
                "A unique Float64 RowId is present for every row so runtime validation must exercise its temporary uniqueness Set before activation.",
              ]
            : []),
        ],
      },
      sourceBufferCount: buffers.length,
      sourceUniqueArrayBufferBytes: buffers.reduce((total, buffer) => total + buffer.byteLength, 0),
      oracle,
    };
    self.postMessage(output, { transfer: buffers });
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const output: GridLifecycleGeneratorOutput = {
      type: "error",
      message: normalized.message,
      ...(normalized.stack ? { stack: normalized.stack } : {}),
    };
    self.postMessage(output);
  }
};

function buildOracle(
  data: GridData,
  profile: "narrow-10m" | "wide-1m",
): GridLifecycleGeneratedDataset["oracle"] {
  const sortColumnId = profile === "narrow-10m" ? "value0" : "number0";
  const column = data.columns.find((entry) => entry.schema.id === sortColumnId);
  if (column?.data.kind !== "number") {
    throw new Error(`Numeric sort oracle column ${sortColumnId} is missing.`);
  }
  const values = column.data.values.view;
  const first: Array<{ value: number; row: number }> = [];
  const compare = (
    left: { readonly value: number; readonly row: number },
    right: { readonly value: number; readonly row: number },
  ): number => left.value - right.value || left.row - right.row;
  for (let row = 0; row < values.length; row++) {
    const candidate = { value: Number(values[row]), row };
    if (first.length === 32 && compare(candidate, first[first.length - 1]!) >= 0) continue;
    let lower = 0;
    let upper = first.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if (compare(first[middle]!, candidate) <= 0) lower = middle + 1;
      else upper = middle;
    }
    first.splice(lower, 0, candidate);
    if (first.length > 32) first.pop();
  }
  return {
    sortColumnId,
    firstSortedValues: first.map((entry) => entry.value),
    physicalRowZeroValue: values.length > 0 ? Number(values[0]) : null,
    physicalRowZeroRowId:
      data.length === 0
        ? null
        : data.rowIds?.kind === "number"
          ? Number(data.rowIds.values.view[0])
          : 0,
  };
}

function applyRowIdMode(
  data: GridData,
  rowIdMode: GridLifecycleGeneratorInput["rowIdMode"],
  generation: number,
): GridData {
  if (rowIdMode === "implicit") return data;
  const values = new Float64Array(data.length);
  const generationBase = generation * 1_000_000_000;
  for (let row = 0; row < data.length; row++) values[row] = generationBase + row + 1;
  return {
    ...data,
    rowIds: {
      kind: "number",
      values: { view: values },
    },
  };
}

function applyOwnership(data: GridData, ownership: GridLifecycleOwnership): void {
  visit(data, (value) => {
    if (!("view" in value) || !ArrayBuffer.isView(value.view)) return;
    (value as { ownership?: GridLifecycleOwnership }).ownership = ownership;
  });
}

function perturbReplacement(
  data: GridData,
  profile: "narrow-10m" | "wide-1m",
  generation: number,
): void {
  if (generation === 0 || data.length === 0) return;
  const columnId = profile === "narrow-10m" ? "value0" : "number0";
  const column = data.columns.find((entry) => entry.schema.id === columnId);
  if (column?.data.kind === "number") column.data.values.view[0] = generation;
}

function visit(value: unknown, callback: (value: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return;
  const record = value as Record<string, unknown>;
  callback(record);
  for (const child of Object.values(record)) visit(child, callback);
}

function collectArrayBuffers(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  visitBuffers(value, buffers);
  return [...buffers];
}

function visitBuffers(value: unknown, buffers: Set<ArrayBuffer>): void {
  if (!value || typeof value !== "object") return;
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
    return;
  }
  if (value instanceof ArrayBuffer) {
    buffers.add(value);
    return;
  }
  for (const child of Object.values(value)) visitBuffers(child, buffers);
}
