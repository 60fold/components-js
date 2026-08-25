import { describe, expect, it } from "vitest";
import { createGridColumnLayout, type VisibleGridRange } from "../rendering/layout.js";
import type { GridPaintPalette } from "../rendering/paintProtocol.js";
import type { GridData, Utf8Buffers } from "../types.js";
import { createGridRuntimeEngine } from "./gridRuntimeEngine.js";
import type {
  GridRuntimeInputMessage,
  GridRuntimeOutputMessage,
  GridRuntimeSurfaceMessage,
} from "./runtimeProtocol.js";

const palette: GridPaintPalette = {
  background: "#000",
  alternateBackground: "#010101",
  headerBackground: "#020202",
  line: "#333",
  text: "#fff",
  mutedText: "#aaa",
  accent: "#f90",
  selection: "rgb(255 153 0 / 0.2)",
  fontFamily: "monospace",
};

function data(editable = false): GridData {
  return {
    length: 3,
    rowIds: {
      kind: "number",
      values: { view: new Int32Array([10, 20, 30]), ownership: "copy" },
    },
    columns: [
      {
        schema: { id: "value", kind: "number", ...(editable ? { editable: true } : {}) },
        data: {
          kind: "number",
          values: { view: new Float64Array([1, 3, 2]), ownership: "copy" },
        },
      },
    ],
  };
}

function utf8(values: readonly string[]): Utf8Buffers {
  const encoder = new TextEncoder();
  const encoded = values.map((value) => encoder.encode(value));
  const offsets = new Uint32Array(values.length + 1);
  let byteLength = 0;
  for (let index = 0; index < encoded.length; index++) {
    byteLength += encoded[index]!.length;
    offsets[index + 1] = byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const value of encoded) {
    bytes.set(value, offset);
    offset += value.length;
  }
  return { offsets: { view: offsets }, data: { view: bytes } };
}

function summaryData(
  values: Float64Array = new Float64Array([1, 3, 2, 6, 4, 5]),
  editable = false,
): GridData {
  return {
    length: values.length,
    rowIds: {
      kind: "number",
      values: { view: new Int32Array([10, 20, 30, 40, 50, 60]), ownership: "copy" },
    },
    columns: [
      {
        schema: { id: "value", kind: "number", ...(editable ? { editable: true } : {}) },
        data: { kind: "number", values: { view: values, ownership: "copy" } },
      },
      {
        schema: {
          id: "category",
          kind: "category",
          ...(editable ? { editable: true } : {}),
        },
        data: {
          kind: "category",
          codes: { view: new Uint8Array([0, 1, 2, 3, 4, 5]), ownership: "copy" },
          dictionary: utf8(["A", "B", "C", "D", "E", "F"]),
        },
      },
    ],
  };
}

class RuntimeHarness {
  readonly messages: GridRuntimeOutputMessage[] = [];
  readonly engine = createGridRuntimeEngine({
    postMessage: (message) => {
      this.messages.push(message);
      this.flush();
    },
  });
  private waiters: Array<{
    readonly matches: (message: GridRuntimeOutputMessage) => boolean;
    readonly resolve: (message: GridRuntimeOutputMessage) => void;
  }> = [];

  send(message: GridRuntimeInputMessage): void {
    this.engine.handleMessage(message);
  }

  async next<T extends GridRuntimeOutputMessage["type"]>(
    type: T,
    predicate: (message: Extract<GridRuntimeOutputMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<GridRuntimeOutputMessage, { type: T }>> {
    const index = this.messages.findIndex(
      (message) => message.type === type && predicate(message as never),
    );
    if (index >= 0) {
      return this.messages.splice(index, 1)[0] as Extract<GridRuntimeOutputMessage, { type: T }>;
    }
    return new Promise((resolve) => {
      this.waiters.push({
        matches: (message) => message.type === type && predicate(message as never),
        resolve: (message) => resolve(message as Extract<GridRuntimeOutputMessage, { type: T }>),
      });
    });
  }

  private flush(): void {
    for (let messageIndex = 0; messageIndex < this.messages.length; messageIndex++) {
      const message = this.messages[messageIndex]!;
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.matches(message));
      if (waiterIndex < 0) continue;
      this.messages.splice(messageIndex, 1);
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      waiter!.resolve(message);
      messageIndex--;
    }
  }
}

function surface(
  datasetId: string,
  options: {
    surfaceId: number;
    dataRevision?: number;
    viewRevision?: number;
    target: GridRuntimeSurfaceMessage["target"];
    range?: VisibleGridRange;
  },
): GridRuntimeSurfaceMessage {
  const surfaceId = options.surfaceId;
  return {
    type: "surface",
    surfaceId,
    commitToken: `surface:${surfaceId}`,
    source: options.target.kind === "install" ? "data" : "view",
    target: options.target,
    revision: {
      datasetId,
      dataRevision: options.dataRevision ?? 1,
      viewRevision: options.viewRevision ?? 0,
      presentationRevision: surfaceId,
    },
    viewportWidth: 320,
    viewportHeight: 160,
    pixelRatio: 1,
    scrollTop: 0,
    scrollLeft: 0,
    range: options.range ?? { rows: { start: 0, end: 3 }, columns: { start: 0, end: 1 } },
    layout: {
      rowHeight: 30,
      headerHeight: 38,
      columnWidth: 120,
      overscanRows: 1,
      overscanColumns: 1,
    },
    columnLayout: createGridColumnLayout([120], 1),
    rowNumberWidth: 64,
    rowNumberLabel: "Row number",
    minColumnWidth: 80,
    maxColumnWidth: 640,
    palette,
    selection: null,
    focusedRowIndex: 0,
    focusedColumnIndex: 0,
  };
}

async function prepareInstall(harness: RuntimeHarness, requestId = 1) {
  harness.send({ type: "install", requestId, dataRevision: 1, data: data() });
  return harness.next("installReady", (message) => message.requestId === requestId);
}

async function publishInstall(
  harness: RuntimeHarness,
  install: Extract<GridRuntimeOutputMessage, { type: "installReady" }>,
  surfaceId = install.requestId,
) {
  harness.send(
    surface(install.descriptor.datasetId, {
      surfaceId,
      dataRevision: install.descriptor.dataRevision,
      target: { kind: "install", requestId: install.requestId },
    }),
  );
  await harness.next("surfaceReady", (message) => message.surfaceId === surfaceId);
  harness.send({
    type: "finalizeSurface",
    surfaceId,
    commitToken: `surface:${surfaceId}`,
  });
  return harness.next("published", (message) => message.surfaceId === surfaceId);
}

describe("Grid canonical runtime engine", () => {
  it("deeply rejects a structurally valid but semantically invalid direct install", async () => {
    const harness = new RuntimeHarness();
    harness.send({
      type: "install",
      requestId: 7,
      dataRevision: 1,
      data: {
        length: 2,
        columns: [
          {
            schema: { id: "flag", kind: "boolean" },
            data: {
              kind: "boolean",
              encoding: "byte",
              values: { view: new Uint8Array([0, 2]), ownership: "transfer" },
            },
          },
        ],
      },
    });

    await expect(
      harness.next("runtimeError", (message) => message.requestId === 7),
    ).resolves.toMatchObject({
      operation: "install",
      message: expect.stringMatching(/zero or one/),
    });
    expect(harness.messages.some((message) => message.type === "installReady")).toBe(false);
  });

  it("keeps exact summaries opt-in and rejects unsupported configurations", async () => {
    const harness = new RuntimeHarness();
    const unconfigured = await prepareInstall(harness);
    expect(unconfigured.summary).toEqual({
      blockSize: 256,
      columnCount: 0,
      buildDurationMs: 0,
      retainedBytes: 0,
      stagedReplacementPeakBytes: 0,
    });
    expect(unconfigured).not.toHaveProperty("physicalRows");
    await publishInstall(harness, unconfigured);
    harness.send({
      type: "querySummary",
      queryId: 91,
      datasetId: unconfigured.descriptor.datasetId,
      dataRevision: 1,
      viewRevision: 0,
      columnId: "value",
      ranges: new Uint32Array([0, 3]),
    });
    await expect(
      harness.next("runtimeError", (message) => message.queryId === 91),
    ).resolves.toMatchObject({
      operation: "summary",
      message: expect.stringMatching(/configured/),
    });

    const invalid = new RuntimeHarness();
    invalid.send({
      type: "install",
      requestId: 2,
      dataRevision: 1,
      data: data(),
      summaryColumnIds: ["value", "value"],
    });
    await expect(
      invalid.next("runtimeError", (message) => message.requestId === 2),
    ).resolves.toMatchObject({
      operation: "install",
      message: expect.stringMatching(/duplicated/),
    });
    invalid.send({
      type: "install",
      requestId: 3,
      dataRevision: 1,
      summaryColumnIds: ["note"],
      data: {
        length: 1,
        columns: [
          {
            schema: { id: "note", kind: "text" },
            data: { kind: "text", values: utf8(["hello"]) },
          },
        ],
      },
    });
    await expect(
      invalid.next("runtimeError", (message) => message.requestId === 3),
    ).resolves.toMatchObject({
      operation: "install",
      message: expect.stringMatching(/numeric or categorical/),
    });
  });

  it("publishes bounded exact numeric and categorical bands without leaking worker state", async () => {
    const harness = new RuntimeHarness();
    harness.send({
      type: "install",
      requestId: 10,
      dataRevision: 1,
      data: summaryData(new Float64Array([7, Number.NaN, -3, Infinity, -3, 11])),
      summaryColumnIds: ["value", "category"],
    });
    const install = await harness.next("installReady", (message) => message.requestId === 10);
    expect(install.summary).toMatchObject({ blockSize: 256, columnCount: 2 });
    expect(install.summary.retainedBytes).toBeGreaterThan(0);
    expect(install.summary.buildDurationMs).toBeGreaterThanOrEqual(0);
    expect(install).not.toHaveProperty("physicalRows");
    expect(install).not.toHaveProperty("filterBitmap");
    expect(install).not.toHaveProperty("hierarchy");

    harness.send({
      type: "querySummary",
      queryId: 100,
      datasetId: install.descriptor.datasetId,
      dataRevision: 1,
      viewRevision: 0,
      columnId: "value",
      ranges: new Uint32Array([0, 6]),
    });
    await expect(
      harness.next("runtimeError", (message) => message.queryId === 100),
    ).resolves.toMatchObject({ operation: "summary", message: expect.stringMatching(/stale/) });

    const published = await publishInstall(harness, install, 10);
    expect(published.summary).toEqual(install.summary);

    harness.send({
      type: "querySummary",
      queryId: 101,
      datasetId: install.descriptor.datasetId,
      dataRevision: 1,
      viewRevision: 0,
      columnId: "value",
      ranges: new Uint32Array([0, 3, 3, 6, 1, 5]),
    });
    const numeric = await harness.next("summaryReady", (message) => message.queryId === 101);
    expect(numeric.kind).toBe("numeric");
    if (numeric.kind !== "numeric") throw new Error("Expected a numeric summary.");
    expect(numeric).not.toHaveProperty("physicalRows");
    expect(numeric).not.toHaveProperty("filterBitmap");
    expect(numeric).not.toHaveProperty("hierarchy");
    expect(numeric.bandCount).toBe(3);
    expect(Array.from(numeric.ranges)).toEqual([0, 3, 3, 6, 1, 5]);
    expect(Array.from(numeric.rowCounts)).toEqual([3, 3, 4]);
    expect(Array.from(numeric.nullCounts)).toEqual([0, 0, 0]);
    expect(Array.from(numeric.finiteCounts)).toEqual([2, 2, 2]);
    expect(Array.from(numeric.nanCounts)).toEqual([1, 0, 1]);
    expect(Array.from(numeric.positiveInfinityCounts)).toEqual([0, 1, 1]);
    expect(Array.from(numeric.negativeInfinityCounts)).toEqual([0, 0, 0]);
    expect(Array.from(numeric.finiteMinimumValues)).toEqual([-3, -3, -3]);
    expect(Array.from(numeric.finiteMaximumValues)).toEqual([7, 11, -3]);
    expect(Array.from(numeric.finiteMinimumViewOrdinals)).toEqual([2, 4, 2]);
    expect(Array.from(numeric.finiteMaximumViewOrdinals)).toEqual([0, 5, 2]);
    expect(numeric.finiteMinimumRowIds).toEqual([30, 50, 30]);
    expect(numeric.finiteMaximumRowIds).toEqual([10, 60, 30]);
    expect(numeric.nodeVisits).toBeGreaterThanOrEqual(0);
    expect(numeric.rawRowsScanned).toBe(10);
    expect(numeric.summaryVertices).toBeGreaterThanOrEqual(3);
    expect(numeric.queryDurationMs).toBeGreaterThanOrEqual(0);
    expect(numeric.typedPayloadBytes).toBe(
      numeric.ranges.byteLength +
        numeric.rowCounts.byteLength +
        numeric.nullCounts.byteLength +
        numeric.finiteCounts.byteLength +
        numeric.nanCounts.byteLength +
        numeric.positiveInfinityCounts.byteLength +
        numeric.negativeInfinityCounts.byteLength +
        numeric.finiteMinimumValues.byteLength +
        numeric.finiteMaximumValues.byteLength +
        numeric.finiteMinimumViewOrdinals.byteLength +
        numeric.finiteMaximumViewOrdinals.byteLength,
    );

    harness.send({
      type: "querySummary",
      queryId: 102,
      datasetId: install.descriptor.datasetId,
      dataRevision: 1,
      viewRevision: 0,
      columnId: "category",
      ranges: new Uint32Array([0, 6, 0, 4]),
    });
    const categorical = await harness.next("summaryReady", (message) => message.queryId === 102);
    expect(categorical.kind).toBe("category");
    if (categorical.kind !== "category") throw new Error("Expected a category summary.");
    expect(Array.from(categorical.exemplarCounts)).toEqual([4, 4]);
    expect(Array.from(categorical.complete)).toEqual([0, 1]);
    expect(Array.from(categorical.exemplarCodes)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(Array.from(categorical.exemplarViewOrdinals)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(categorical.exemplarRowIds).toEqual([10, 20, 30, 40, 10, 20, 30, 40]);
    expect(categorical.labels).toEqual(["A", "B", "C", "D"]);
    expect(Array.from(categorical.exemplarLabelIndexes)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(categorical.typedPayloadBytes).toBe(
      categorical.ranges.byteLength +
        categorical.rowCounts.byteLength +
        categorical.nullCounts.byteLength +
        categorical.exemplarCounts.byteLength +
        categorical.exemplarCodes.byteLength +
        categorical.exemplarViewOrdinals.byteLength +
        categorical.exemplarLabelIndexes.byteLength +
        categorical.complete.byteLength,
    );
  });

  it("keeps a dataset private until its bounded first surface is finalized", async () => {
    const harness = new RuntimeHarness();
    const ready = await prepareInstall(harness);
    const datasetId = ready.descriptor.datasetId;

    harness.send({ type: "resolveRow", queryId: 1, datasetId, rowId: 20 });
    const beforePublication = await harness.next(
      "runtimeError",
      (message) => message.queryId === 1,
    );
    expect(beforePublication.operation).toBe("resolve");

    harness.send(
      surface(datasetId, {
        surfaceId: 1,
        target: { kind: "install", requestId: 1 },
        range: { rows: { start: 1, end: 2 }, columns: { start: 0, end: 1 } },
      }),
    );
    const candidate = await harness.next("surfaceReady");
    expect(candidate.frame.cellText).toEqual(["3"]);
    expect(candidate.visibleRowIds).toEqual([20]);
    expect(candidate.rowCount).toBe(3);
    expect(candidate.frame.cellText).toHaveLength(1);

    harness.send({
      type: "finalizeSurface",
      surfaceId: candidate.surfaceId,
      commitToken: candidate.commitToken,
    });
    const published = await harness.next("published");
    expect(published.publicationKind).toBe("data");
    expect(published.descriptor.installResult.buffers).toEqual(
      expect.arrayContaining([expect.objectContaining({ requested: "copy", installed: "copied" })]),
    );

    harness.send({ type: "resolveRow", queryId: 2, datasetId, rowId: 20 });
    await expect(
      harness.next("resolvedRow", (message) => message.queryId === 2),
    ).resolves.toMatchObject({ physicalRow: 1, viewOrdinal: 1 });
  });

  it("keeps sort mappings private and publishes the sorted surface atomically", async () => {
    const harness = new RuntimeHarness();
    const install = await prepareInstall(harness);
    const datasetId = install.descriptor.datasetId;
    harness.send(surface(datasetId, { surfaceId: 1, target: { kind: "install", requestId: 1 } }));
    await harness.next("surfaceReady");
    harness.send({ type: "finalizeSurface", surfaceId: 1, commitToken: "surface:1" });
    await harness.next("published");

    harness.send({
      type: "setView",
      requestId: 2,
      datasetId,
      viewRevision: 1,
      spec: { sort: [{ columnId: "value", direction: "descending", nulls: "last" }] },
    });
    const viewReady = await harness.next("viewReady");
    expect(viewReady).not.toHaveProperty("physicalRows");
    expect(viewReady.rowCount).toBe(3);

    harness.send(
      surface(datasetId, {
        surfaceId: 2,
        viewRevision: 1,
        target: { kind: "view", requestId: 2 },
      }),
    );
    const sorted = await harness.next("surfaceReady", (message) => message.surfaceId === 2);
    expect(sorted.frame.cellText).toEqual(["3", "2", "1"]);
    expect(sorted.visibleRowIds).toEqual([20, 30, 10]);

    harness.send({ type: "finalizeSurface", surfaceId: 2, commitToken: "surface:2" });
    const published = await harness.next("published", (message) => message.surfaceId === 2);
    expect(published).toMatchObject({ publicationKind: "view", viewRevision: 1, rowCount: 3 });
    harness.send({ type: "resolveRow", queryId: 3, datasetId, rowId: 30 });
    await expect(
      harness.next("resolvedRow", (message) => message.queryId === 3),
    ).resolves.toMatchObject({ physicalRow: 2, viewOrdinal: 1 });

    harness.send({ type: "resolveOrdinal", queryId: 4, datasetId, viewOrdinal: 1 });
    await expect(
      harness.next("resolvedOrdinal", (message) => message.queryId === 4),
    ).resolves.toMatchObject({ physicalRow: 2, viewOrdinal: 1, rowId: 30 });
    harness.send({ type: "resolveOrdinal", queryId: 5, datasetId, viewOrdinal: 99 });
    await expect(
      harness.next("resolvedOrdinal", (message) => message.queryId === 5),
    ).resolves.toMatchObject({ physicalRow: -1, viewOrdinal: 99, rowId: null });
  });

  it("keeps a replacement summary private, cancels stale work, and publishes matching ordinals", async () => {
    const harness = new RuntimeHarness();
    harness.send({
      type: "install",
      requestId: 20,
      dataRevision: 1,
      data: summaryData(),
      summaryColumnIds: ["value"],
    });
    const install = await harness.next("installReady", (message) => message.requestId === 20);
    await publishInstall(harness, install, 20);
    const datasetId = install.descriptor.datasetId;

    harness.send({
      type: "setView",
      requestId: 21,
      datasetId,
      viewRevision: 1,
      spec: { sort: [{ columnId: "value", direction: "descending" }] },
    });
    const viewReady = await harness.next("viewReady", (message) => message.requestId === 21);
    expect(viewReady.summary).toMatchObject({ blockSize: 256, columnCount: 1 });
    expect(viewReady.summary.retainedBytes).toBeGreaterThan(0);
    expect(viewReady.summary.stagedReplacementPeakBytes).toBeGreaterThanOrEqual(
      install.summary.retainedBytes + viewReady.summary.retainedBytes,
    );
    expect(viewReady).not.toHaveProperty("physicalRows");

    harness.send({
      type: "querySummary",
      queryId: 201,
      datasetId,
      dataRevision: 1,
      viewRevision: 0,
      columnId: "value",
      ranges: new Uint32Array([0, 6]),
    });
    const old = await harness.next("summaryReady", (message) => message.queryId === 201);
    expect(old.kind).toBe("numeric");
    if (old.kind !== "numeric") throw new Error("Expected a numeric summary.");
    expect(Array.from(old.finiteMaximumViewOrdinals)).toEqual([3]);
    expect(old.finiteMaximumRowIds).toEqual([40]);

    harness.send({
      type: "querySummary",
      queryId: 202,
      datasetId,
      dataRevision: 1,
      viewRevision: 1,
      columnId: "value",
      ranges: new Uint32Array([0, 6]),
    });
    await expect(
      harness.next("runtimeError", (message) => message.queryId === 202),
    ).resolves.toMatchObject({ operation: "summary", message: expect.stringMatching(/stale/) });

    const manyRanges = new Uint32Array(2_048 * 2);
    manyRanges.fill(0);
    harness.send({
      type: "querySummary",
      queryId: 203,
      datasetId,
      dataRevision: 1,
      viewRevision: 0,
      columnId: "value",
      ranges: manyRanges,
    });
    harness.send(
      surface(datasetId, {
        surfaceId: 21,
        viewRevision: 1,
        target: { kind: "view", requestId: 21 },
      }),
    );
    harness.send({ type: "finalizeSurface", surfaceId: 21, commitToken: "surface:21" });
    await expect(
      harness.next("summaryCancelled", (message) => message.queryId === 203),
    ).resolves.toMatchObject({ reason: "stale" });
    const published = await harness.next("published", (message) => message.surfaceId === 21);
    expect(published.summary).toEqual(viewReady.summary);

    harness.send({
      type: "querySummary",
      queryId: 204,
      datasetId,
      dataRevision: 1,
      viewRevision: 1,
      columnId: "value",
      ranges: new Uint32Array([0, 6]),
    });
    const sorted = await harness.next("summaryReady", (message) => message.queryId === 204);
    expect(sorted.kind).toBe("numeric");
    if (sorted.kind !== "numeric") throw new Error("Expected a numeric summary.");
    expect(Array.from(sorted.finiteMaximumViewOrdinals)).toEqual([0]);
    expect(sorted.finiteMaximumRowIds).toEqual([40]);
  });

  it("bounds and cooperatively cancels summary batches", async () => {
    const harness = new RuntimeHarness();
    harness.send({
      type: "install",
      requestId: 30,
      dataRevision: 1,
      data: summaryData(),
      summaryColumnIds: ["value"],
    });
    const install = await harness.next("installReady", (message) => message.requestId === 30);
    await publishInstall(harness, install, 30);
    const datasetId = install.descriptor.datasetId;

    harness.send({
      type: "querySummary",
      queryId: 301,
      datasetId,
      dataRevision: 1,
      viewRevision: 0,
      columnId: "value",
      ranges: new Uint32Array(2_049 * 2),
    });
    await expect(
      harness.next("runtimeError", (message) => message.queryId === 301),
    ).resolves.toMatchObject({ operation: "summary", message: expect.stringMatching(/1 to 2048/) });

    const ranges = new Uint32Array(2_048 * 2);
    for (let band = 0; band < 2_048; band++) {
      ranges[band * 2] = band % 6;
      ranges[band * 2 + 1] = (band % 6) + 1;
    }
    harness.send({
      type: "querySummary",
      queryId: 302,
      datasetId,
      dataRevision: 1,
      viewRevision: 0,
      columnId: "value",
      ranges,
    });
    harness.send({ type: "cancelSummary", queryId: 302 });
    await expect(
      harness.next("summaryCancelled", (message) => message.queryId === 302),
    ).resolves.toMatchObject({ reason: "host" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      harness.messages.some(
        (message) => message.type === "summaryReady" && message.queryId === 302,
      ),
    ).toBe(false);
  });

  it("coalesces surface pressure without discarding a private view candidate", async () => {
    const harness = new RuntimeHarness();
    const install = await prepareInstall(harness);
    const datasetId = install.descriptor.datasetId;
    harness.send(surface(datasetId, { surfaceId: 1, target: { kind: "install", requestId: 1 } }));
    await harness.next("surfaceReady");

    harness.send(surface(datasetId, { surfaceId: 2, target: { kind: "install", requestId: 1 } }));
    harness.send(surface(datasetId, { surfaceId: 3, target: { kind: "install", requestId: 1 } }));
    await expect(
      harness.next("surfaceDropped", (message) => message.surfaceId === 2),
    ).resolves.toMatchObject({ reason: "coalesced" });

    harness.send({ type: "dropSurface", surfaceId: 1, commitToken: "surface:1" });
    await expect(
      harness.next("surfaceDropped", (message) => message.surfaceId === 1),
    ).resolves.toMatchObject({ reason: "host" });
    const latest = await harness.next("surfaceReady", (message) => message.surfaceId === 3);
    harness.send({
      type: "finalizeSurface",
      surfaceId: latest.surfaceId,
      commitToken: latest.commitToken,
    });
    await expect(harness.next("published")).resolves.toMatchObject({ publicationKind: "data" });
  });

  it("cancels superseded installs and view builds without publishing stale state", async () => {
    const harness = new RuntimeHarness();
    harness.send({
      type: "install",
      requestId: 1,
      dataRevision: 1,
      data: data(),
      summaryColumnIds: ["value"],
    });
    harness.send({
      type: "install",
      requestId: 2,
      dataRevision: 1,
      data: data(),
      summaryColumnIds: ["value"],
    });
    await expect(
      harness.next(
        "cancelled",
        (message) => message.scope === "install" && message.requestId === 1,
      ),
    ).resolves.toMatchObject({ requestId: 1 });
    const install = await harness.next("installReady", (message) => message.requestId === 2);
    const datasetId = install.descriptor.datasetId;
    harness.send(surface(datasetId, { surfaceId: 1, target: { kind: "install", requestId: 2 } }));
    await harness.next("surfaceReady");
    harness.send({ type: "finalizeSurface", surfaceId: 1, commitToken: "surface:1" });
    await harness.next("published");

    harness.send({
      type: "setView",
      requestId: 3,
      datasetId,
      viewRevision: 1,
      spec: { sort: [{ columnId: "value", direction: "ascending" }] },
    });
    harness.send({
      type: "setView",
      requestId: 4,
      datasetId,
      viewRevision: 2,
      spec: { sort: [{ columnId: "value", direction: "descending" }] },
    });
    await expect(
      harness.next("cancelled", (message) => message.scope === "view" && message.requestId === 3),
    ).resolves.toMatchObject({ requestId: 3 });
    await expect(
      harness.next("viewReady", (message) => message.requestId === 4),
    ).resolves.toMatchObject({ viewRevision: 2, summary: { columnCount: 1 } });
    expect(
      harness.messages.some(
        (message) => message.type === "installReady" && message.requestId === 1,
      ),
    ).toBe(false);
  });

  it("keeps an accepted edit private until its exact surface is finalized", async () => {
    const harness = new RuntimeHarness();
    harness.send({ type: "install", requestId: 1, dataRevision: 1, data: data(true) });
    const install = await harness.next("installReady");
    const datasetId = install.descriptor.datasetId;
    harness.send(surface(datasetId, { surfaceId: 1, target: { kind: "install", requestId: 1 } }));
    await harness.next("surfaceReady");
    harness.send({ type: "finalizeSurface", surfaceId: 1, commitToken: "surface:1" });
    await harness.next("published");

    harness.send({
      type: "inspectCell",
      queryId: 1,
      datasetId,
      rowId: 10,
      columnId: "value",
    });
    const baseline = await harness.next("cellInspected", (message) => message.queryId === 1);
    expect(baseline).toMatchObject({ value: 1, cellRevision: 0 });

    harness.send({
      type: "reserveEdit",
      operationId: "edit:1",
      datasetId,
      rowId: 10,
      columnId: "value",
      cellRevision: baseline.cellRevision,
      previousValue: baseline.value,
      finalValue: 9,
    });
    const lease = await harness.next("editLease", (message) => message.operationId === "edit:1");
    expect(lease.result).toMatchObject({ granted: true, finalValue: 9 });
    if (!lease.result.granted) throw new Error("Expected the edit reservation to be granted.");

    harness.send({
      type: "applyEdit",
      operationId: "edit:1",
      leaseId: lease.result.leaseId,
    });
    const ready = await harness.next("editReady", (message) => message.operationId === "edit:1");
    expect(ready).toMatchObject({ dataRevision: 2, editedRowIndex: 0, viewChanged: false });

    harness.send({
      type: "inspectCell",
      queryId: 2,
      datasetId,
      rowId: 10,
      columnId: "value",
    });
    await expect(
      harness.next("cellInspected", (message) => message.queryId === 2),
    ).resolves.toMatchObject({ value: 1, cellRevision: 0 });

    harness.send(
      surface(datasetId, {
        surfaceId: 2,
        dataRevision: 2,
        target: { kind: "edit", operationId: "edit:1" },
      }),
    );
    const candidate = await harness.next("surfaceReady", (message) => message.surfaceId === 2);
    expect(candidate.frame.cellText).toEqual(["9", "3", "2"]);

    harness.send({ type: "finalizeSurface", surfaceId: 2, commitToken: "surface:2" });
    await expect(
      harness.next("published", (message) => message.surfaceId === 2),
    ).resolves.toMatchObject({ publicationKind: "edit", descriptor: { dataRevision: 2 } });
    harness.send({
      type: "inspectCell",
      queryId: 3,
      datasetId,
      rowId: 10,
      columnId: "value",
    });
    await expect(
      harness.next("cellInspected", (message) => message.queryId === 3),
    ).resolves.toMatchObject({ value: 9, cellRevision: 1 });
  });

  it("rejects a second reservation without invalidating the authoritative owner", async () => {
    const harness = new RuntimeHarness();
    harness.send({ type: "install", requestId: 1, dataRevision: 1, data: data(true) });
    const install = await harness.next("installReady");
    const datasetId = install.descriptor.datasetId;
    await publishInstall(harness, install);

    harness.send({
      type: "reserveEdit",
      operationId: "edit:owner",
      datasetId,
      rowId: 10,
      columnId: "value",
      cellRevision: 0,
      previousValue: 1,
      finalValue: 7,
    });
    const owner = await harness.next(
      "editLease",
      (message) => message.operationId === "edit:owner",
    );
    expect(owner.result).toMatchObject({ granted: true, finalValue: 7 });
    if (!owner.result.granted) throw new Error("Expected the first edit reservation.");

    harness.send({
      type: "reserveEdit",
      operationId: "edit:contender",
      datasetId,
      rowId: 20,
      columnId: "value",
      cellRevision: 0,
      previousValue: 3,
      finalValue: 8,
    });
    await expect(
      harness.next("editLease", (message) => message.operationId === "edit:contender"),
    ).resolves.toMatchObject({
      result: {
        granted: false,
        reason: "stale",
        message: expect.stringMatching(/already owns/),
      },
    });

    harness.send({
      type: "applyEdit",
      operationId: "edit:owner",
      leaseId: owner.result.leaseId,
    });
    await expect(
      harness.next("editReady", (message) => message.operationId === "edit:owner"),
    ).resolves.toMatchObject({ dataRevision: 2, editedRowIndex: 0 });
    harness.send(
      surface(datasetId, {
        surfaceId: 2,
        dataRevision: 2,
        target: { kind: "edit", operationId: "edit:owner" },
      }),
    );
    await harness.next("surfaceReady", (message) => message.surfaceId === 2);
    harness.send({ type: "finalizeSurface", surfaceId: 2, commitToken: "surface:2" });
    await expect(
      harness.next("published", (message) => message.surfaceId === 2),
    ).resolves.toMatchObject({ publicationKind: "edit", descriptor: { dataRevision: 2 } });

    harness.send({
      type: "inspectCell",
      queryId: 3,
      datasetId,
      rowId: 10,
      columnId: "value",
    });
    await expect(
      harness.next("cellInspected", (message) => message.queryId === 3),
    ).resolves.toMatchObject({ value: 7, cellRevision: 1 });
  });

  it("publishes staged numeric and category summaries atomically with their edits", async () => {
    const harness = new RuntimeHarness();
    harness.send({
      type: "install",
      requestId: 40,
      dataRevision: 1,
      data: summaryData(undefined, true),
      summaryColumnIds: ["value", "category"],
    });
    const install = await harness.next("installReady", (message) => message.requestId === 40);
    await publishInstall(harness, install, 40);
    const datasetId = install.descriptor.datasetId;

    harness.send({
      type: "reserveEdit",
      operationId: "summary:number",
      datasetId,
      rowId: 10,
      columnId: "value",
      cellRevision: 0,
      previousValue: 1,
      finalValue: 9,
    });
    const numberLease = await harness.next(
      "editLease",
      (message) => message.operationId === "summary:number",
    );
    if (!numberLease.result.granted) throw new Error("Expected a numeric edit lease.");
    harness.send({
      type: "applyEdit",
      operationId: "summary:number",
      leaseId: numberLease.result.leaseId,
    });
    const numberReady = await harness.next(
      "editReady",
      (message) => message.operationId === "summary:number",
    );
    expect(numberReady).toMatchObject({ dataRevision: 2, viewRevision: 0, viewChanged: false });
    expect(numberReady.summary).toMatchObject({ blockSize: 256, columnCount: 2 });

    harness.send({
      type: "querySummary",
      queryId: 401,
      datasetId,
      dataRevision: 1,
      viewRevision: 0,
      columnId: "value",
      ranges: new Uint32Array([0, 6]),
    });
    const oldNumber = await harness.next("summaryReady", (message) => message.queryId === 401);
    expect(oldNumber.kind).toBe("numeric");
    if (oldNumber.kind !== "numeric") throw new Error("Expected a numeric summary.");
    expect(Array.from(oldNumber.finiteMaximumValues)).toEqual([6]);
    harness.send({
      type: "querySummary",
      queryId: 402,
      datasetId,
      dataRevision: 2,
      viewRevision: 0,
      columnId: "value",
      ranges: new Uint32Array([0, 6]),
    });
    await expect(
      harness.next("runtimeError", (message) => message.queryId === 402),
    ).resolves.toMatchObject({ operation: "summary", message: expect.stringMatching(/stale/) });

    harness.send(
      surface(datasetId, {
        surfaceId: 41,
        dataRevision: 2,
        target: { kind: "edit", operationId: "summary:number" },
      }),
    );
    harness.send({ type: "finalizeSurface", surfaceId: 41, commitToken: "surface:41" });
    const numberPublished = await harness.next("published", (message) => message.surfaceId === 41);
    expect(numberPublished.summary).toEqual(numberReady.summary);
    harness.send({
      type: "querySummary",
      queryId: 403,
      datasetId,
      dataRevision: 2,
      viewRevision: 0,
      columnId: "value",
      ranges: new Uint32Array([0, 6]),
    });
    const newNumber = await harness.next("summaryReady", (message) => message.queryId === 403);
    expect(newNumber.kind).toBe("numeric");
    if (newNumber.kind !== "numeric") throw new Error("Expected a numeric summary.");
    expect(Array.from(newNumber.finiteMaximumValues)).toEqual([9]);
    expect(Array.from(newNumber.finiteMaximumViewOrdinals)).toEqual([0]);
    expect(newNumber.finiteMaximumRowIds).toEqual([10]);

    harness.send({
      type: "reserveEdit",
      operationId: "summary:category",
      datasetId,
      rowId: 10,
      columnId: "category",
      cellRevision: 0,
      previousValue: "A",
      finalValue: "E",
    });
    const categoryLease = await harness.next(
      "editLease",
      (message) => message.operationId === "summary:category",
    );
    if (!categoryLease.result.granted) throw new Error("Expected a category edit lease.");
    harness.send({
      type: "applyEdit",
      operationId: "summary:category",
      leaseId: categoryLease.result.leaseId,
    });
    const categoryReady = await harness.next(
      "editReady",
      (message) => message.operationId === "summary:category",
    );
    expect(categoryReady).toMatchObject({ dataRevision: 3, viewRevision: 0 });

    harness.send({
      type: "querySummary",
      queryId: 404,
      datasetId,
      dataRevision: 2,
      viewRevision: 0,
      columnId: "category",
      ranges: new Uint32Array([0, 6]),
    });
    const oldCategory = await harness.next("summaryReady", (message) => message.queryId === 404);
    expect(oldCategory.kind).toBe("category");
    if (oldCategory.kind !== "category") throw new Error("Expected a category summary.");
    expect(oldCategory.labels[oldCategory.exemplarLabelIndexes[0]!]).toBe("A");

    harness.send(
      surface(datasetId, {
        surfaceId: 42,
        dataRevision: 3,
        target: { kind: "edit", operationId: "summary:category" },
      }),
    );
    harness.send({ type: "finalizeSurface", surfaceId: 42, commitToken: "surface:42" });
    const categoryPublished = await harness.next(
      "published",
      (message) => message.surfaceId === 42,
    );
    expect(categoryPublished.summary).toEqual(categoryReady.summary);
    harness.send({
      type: "querySummary",
      queryId: 405,
      datasetId,
      dataRevision: 3,
      viewRevision: 0,
      columnId: "category",
      ranges: new Uint32Array([0, 6]),
    });
    const newCategory = await harness.next("summaryReady", (message) => message.queryId === 405);
    expect(newCategory.kind).toBe("category");
    if (newCategory.kind !== "category") throw new Error("Expected a category summary.");
    expect(Array.from(newCategory.exemplarCodes.slice(0, 4))).toEqual([4, 1, 2, 3]);
    expect(newCategory.labels[newCategory.exemplarLabelIndexes[0]!]).toBe("E");
    expect(newCategory.exemplarRowIds.slice(0, 4)).toEqual([10, 20, 30, 40]);
  });

  it("lets cancellation beat an unobserved edit reservation", async () => {
    const harness = new RuntimeHarness();
    harness.send({ type: "install", requestId: 1, dataRevision: 1, data: data(true) });
    const install = await harness.next("installReady");
    const datasetId = install.descriptor.datasetId;
    harness.send(surface(datasetId, { surfaceId: 1, target: { kind: "install", requestId: 1 } }));
    await harness.next("surfaceReady");
    harness.send({ type: "finalizeSurface", surfaceId: 1, commitToken: "surface:1" });
    await harness.next("published");

    harness.send({
      type: "reserveEdit",
      operationId: "edit:cancel",
      datasetId,
      rowId: 10,
      columnId: "value",
      cellRevision: 0,
      previousValue: 1,
      finalValue: 7,
    });
    const lease = await harness.next("editLease");
    expect(lease.result).toMatchObject({ granted: true });
    harness.send({ type: "cancelEdit", operationId: "edit:cancel" });
    harness.send({
      type: "applyEdit",
      operationId: "edit:cancel",
      leaseId: lease.result.granted ? lease.result.leaseId : "missing",
    });
    await expect(
      harness.next("runtimeError", (message) => message.operationId === "edit:cancel"),
    ).resolves.toMatchObject({ operation: "edit" });
  });

  it("stops publishing after disposal", async () => {
    const harness = new RuntimeHarness();
    await harness.next("ready");
    harness.send({ type: "dispose" });
    await expect(harness.next("disposed")).resolves.toMatchObject({ type: "disposed" });
    harness.send({ type: "install", requestId: 1, dataRevision: 1, data: data() });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.messages).toEqual([]);
  });

  it("releases an active summary and suppresses pending query output on destroy", async () => {
    const harness = new RuntimeHarness();
    harness.send({
      type: "install",
      requestId: 50,
      dataRevision: 1,
      data: summaryData(),
      summaryColumnIds: ["value", "category"],
    });
    const install = await harness.next("installReady", (message) => message.requestId === 50);
    expect(install.summary.retainedBytes).toBeGreaterThan(0);
    await publishInstall(harness, install, 50);
    harness.messages.length = 0;
    harness.send({
      type: "querySummary",
      queryId: 501,
      datasetId: install.descriptor.datasetId,
      dataRevision: 1,
      viewRevision: 0,
      columnId: "value",
      ranges: new Uint32Array(2_048 * 2),
    });
    harness.send({ type: "dispose" });
    await expect(harness.next("disposed")).resolves.toMatchObject({ type: "disposed" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.messages).toEqual([]);
  });
});
