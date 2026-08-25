import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Grid } from "./index";
import type {
  GridRuntimeDatasetDescriptor,
  GridRuntimeInputMessage,
  GridRuntimeOutputMessage,
  GridRuntimeTransport,
} from "./runtime/runtimeProtocol";
import {
  GRID_INTERNAL_SURFACE_TELEMETRY,
  type GridInternalSurfaceTelemetryOptions,
  type GridSurfaceTelemetryEvent,
} from "./internal/surfaceTelemetry";
import type {
  BufferOwnership,
  EditDecision,
  EditRequest,
  GridData,
  GridOptions,
  Utf8Buffers,
} from "./types";

type GridSurfacePhaseEvent = Exclude<GridSurfaceTelemetryEvent, { readonly type: "intent" }>;

function isGridSurfacePhaseEvent(event: GridSurfaceTelemetryEvent): event is GridSurfacePhaseEvent {
  return event.type !== "intent";
}

const nativeStructuredClone = globalThis.structuredClone;

function utf8(values: readonly string[]): Utf8Buffers {
  const encoder = new TextEncoder();
  const chunks = values.map((value) => encoder.encode(value));
  const offsets = new Uint32Array(values.length + 1);
  let length = 0;
  for (let index = 0; index < chunks.length; index++) {
    length += chunks[index]!.length;
    offsets[index + 1] = length;
  }
  const data = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    data.set(chunk, cursor);
    cursor += chunk.length;
  }
  return { offsets: { view: offsets }, data: { view: data } };
}

function fixture(values: readonly number[] = [3, 1, 2, 4], editable = false): GridData {
  return {
    length: values.length,
    columns: [
      {
        schema: { id: "value", kind: "number", ...(editable ? { editable: true } : {}) },
        data: { kind: "number", values: { view: new Float64Array(values) } },
      },
      {
        schema: { id: "label", kind: "text", ...(editable ? { editable: true } : {}) },
        data: { kind: "text", values: utf8(values.map((value) => `row-${value}`)) },
      },
    ],
  };
}

function summaryFixture(): GridData {
  return {
    length: 8,
    columns: [
      {
        schema: { id: "value", kind: "number", nullable: true },
        data: {
          kind: "number",
          values: {
            view: new Float64Array([
              3,
              Number.NaN,
              1,
              Number.POSITIVE_INFINITY,
              Number.NEGATIVE_INFINITY,
              -0,
              4,
              2,
            ]),
          },
          validity: { bits: { view: new Uint8Array([0xbf]) } },
        },
      },
      {
        schema: { id: "category", kind: "category", nullable: true },
        data: {
          kind: "category",
          codes: { view: new Uint8Array([0, 1, 0, 2, 3, 4, 1, 2]) },
          dictionary: utf8(["A", "B", "C", "D", "E"]),
          validity: { bits: { view: new Uint8Array([0xbf]) } },
        },
      },
    ],
  };
}

function booleanFixture(values: Uint8Array, ownership: BufferOwnership): GridData {
  return {
    length: values.length,
    columns: [
      {
        schema: { id: "flag", kind: "boolean" },
        data: {
          kind: "boolean",
          encoding: "byte",
          values: { view: values, ownership },
        },
      },
    ],
  };
}

function numberBufferFixture(values: Float64Array, ownership: BufferOwnership): GridData {
  return {
    length: values.length,
    columns: [
      {
        schema: { id: "value", kind: "number" },
        data: { kind: "number", values: { view: values, ownership } },
      },
    ],
  };
}

function fakeContext(): CanvasRenderingContext2D {
  return {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: (value: string) => ({ width: value.length * 7 }) as TextMetrics,
    rect: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn(),
    strokeRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

function cloneInTestRealm<T>(value: T): T {
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    const source = new Uint8Array(value as ArrayBuffer);
    const copy = new ArrayBuffer(source.byteLength);
    new Uint8Array(copy).set(source);
    return copy as T;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as { constructor: { name: string } };
    const constructor = (globalThis as unknown as Record<string, Function>)[view.constructor.name];
    if (typeof constructor !== "function") throw new Error("Unknown typed-array constructor.");
    return Reflect.construct(constructor, [value]) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => cloneInTestRealm(entry)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneInTestRealm(entry)]),
    ) as T;
  }
  return value;
}

function nativeCloneInTestRealm<T>(value: T, options?: StructuredSerializeOptions): T {
  return cloneInTestRealm(nativeStructuredClone(value, options));
}

function host(): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperties(element, {
    clientWidth: { value: 640 },
    clientHeight: { value: 260 },
  });
  document.body.append(element);
  return element;
}

function dispatchPointer(
  target: EventTarget,
  type: string,
  { clientX, pointerId = 1 }: { clientX: number; pointerId?: number },
): void {
  const event = new MouseEvent(type, { bubbles: true, button: 0, buttons: 1, clientX });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "mouse" },
  });
  target.dispatchEvent(event);
}

function afterAnimationFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    const advance = (remaining: number): void => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => advance(remaining - 1));
    };
    advance(count);
  });
}

async function expectPromptRejection(operation: Promise<unknown>, message: string): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error("The Grid operation did not settle.")), 100);
  });
  try {
    await expect(Promise.race([operation, timeout])).rejects.toThrow(message);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function openAndSubmitNumber(gridHost: HTMLElement, value: string): Promise<void> {
  const control = await openNumberEditor(gridHost);
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

async function openNumberEditor(gridHost: HTMLElement): Promise<HTMLInputElement> {
  gridHost
    .querySelector('[role="grid"]')!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
  await vi.waitFor(() => expect(gridHost.querySelector("[data-grid-editor-control]")).toBeTruthy());
  return gridHost.querySelector<HTMLInputElement>("[data-grid-editor-control]")!;
}

describe("Grid canonical runtime facade", () => {
  let contextSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("structuredClone", cloneInTestRealm);
    contextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeContext());
  });

  afterEach(() => {
    contextSpy.mockRestore();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("publishes data, sorting, and offscreen RowId focus through bounded surfaces", async () => {
    const gridHost = host();
    const grid = new Grid(gridHost, { renderMode: "main", overscanRows: 0 });
    await grid.initialize();
    const install = await grid.setData(fixture());

    expect(install.datasetId).toBe(grid.getViewport().datasetId);
    expect(gridHost.querySelector('[role="grid"]')?.getAttribute("aria-rowcount")).toBe("5");
    expect(grid.getDiagnostics()).toMatchObject({
      dataOwnershipMode: "main-fallback",
      paintPipeline: "worker-formatted-bounded-viewport",
      physicalRowCount: 4,
      viewRowCount: 4,
    });

    await expect(
      grid.setView({ sort: [{ columnId: "value", direction: "ascending" }] }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(
      [...gridHost.querySelectorAll('[role="gridcell"][data-grid-column-id="value"]')].map(
        (cell) => cell.textContent,
      ),
    ).toEqual(["1", "2", "3", "4"]);
    await expect(grid.focusCell({ rowId: 2, columnId: "label" })).resolves.toBe(true);
    expect(grid.getFocusedCell()).toEqual({ rowId: 2, columnId: "label" });
    await expect(grid.focusCell({ rowId: "missing", columnId: "label" })).resolves.toBe(false);
    grid.destroy();
  });

  it("normalizes contradictory public column-width bounds before painting", async () => {
    const gridHost = host();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      columnWidth: 100_000,
      minColumnWidth: 100_000,
      maxColumnWidth: 64,
    });
    await grid.initialize();
    await grid.setData(fixture());

    const separator = gridHost.querySelector<HTMLElement>('[role="separator"]')!;
    expect(separator.getAttribute("aria-valuemin")).toBe("4096");
    expect(separator.getAttribute("aria-valuemax")).toBe("4096");
    expect(separator.getAttribute("aria-valuenow")).toBe("4096");
    expect(grid.getDiagnostics().paintError).toBeNull();
    grid.destroy();
  });

  it("sorts from headers, reverses the active column, and resizes by dragging", async () => {
    const gridHost = host();
    const grid = new Grid(gridHost, { renderMode: "main", columnWidth: 160 });
    await grid.initialize();
    await grid.setData(fixture());
    await grid.setView({
      filter: { kind: "comparison", columnId: "value", operator: "gte", value: 2 },
    });

    const semantics = gridHost.querySelector<HTMLElement>('[role="grid"]')!;
    const valueHeader = () =>
      semantics.querySelector<HTMLElement>('[role="columnheader"][data-grid-column-id="value"]')!;
    const values = () =>
      [
        ...semantics.querySelectorAll<HTMLElement>(
          '[role="gridcell"][data-grid-column-id="value"]',
        ),
      ].map((cell) => cell.textContent);
    expect(valueHeader().hasAttribute("aria-sort")).toBe(false);

    const firstSortButton =
      valueHeader().querySelector<HTMLButtonElement>("[data-grid-sort-button]")!;
    firstSortButton.focus();
    firstSortButton.click();
    await vi.waitFor(() =>
      expect(grid.getView()).toMatchObject({ status: "ready", viewRevision: 2 }),
    );
    expect(valueHeader().getAttribute("aria-sort")).toBe("ascending");
    expect(document.activeElement).toBe(
      valueHeader().querySelector<HTMLButtonElement>("[data-grid-sort-button]"),
    );
    expect(values()).toEqual(["2", "3", "4"]);
    expect(grid.getView().spec.filter).toEqual({
      kind: "comparison",
      columnId: "value",
      operator: "gte",
      value: 2,
    });

    valueHeader().querySelector<HTMLButtonElement>("[data-grid-sort-button]")!.click();
    await vi.waitFor(() =>
      expect(grid.getView()).toMatchObject({ status: "ready", viewRevision: 3 }),
    );
    expect(valueHeader().getAttribute("aria-sort")).toBe("descending");
    expect(values()).toEqual(["4", "3", "2"]);
    expect(
      [...semantics.querySelectorAll('[role="rowheader"]')].map((cell) => cell.textContent),
    ).toEqual(["1", "2", "3"]);

    const separator = () =>
      semantics.querySelector<HTMLElement>('[role="separator"][data-grid-column-id="value"]')!;
    const before = Number(separator().getAttribute("aria-valuenow"));
    separator().focus();
    dispatchPointer(separator(), "pointerdown", { clientX: 160, pointerId: 17 });
    dispatchPointer(window, "pointermove", { clientX: 208, pointerId: 17 });
    dispatchPointer(window, "pointerup", { clientX: 208, pointerId: 17 });
    await vi.waitFor(() =>
      expect(Number(separator().getAttribute("aria-valuenow"))).toBe(before + 48),
    );

    expect(valueHeader().style.width).toBe(`${before + 48}px`);
    expect(document.activeElement).toBe(separator());
    grid.destroy();
  });

  it("keeps rejected and structurally invalid proposals in the DOM editor", async () => {
    const gridHost = host();
    const onEditRequest = vi.fn((): EditDecision => ({
      outcome: "rejected",
      code: "outside-policy",
      message: "Value is outside the host policy.",
    }));
    const grid = new Grid(gridHost, {
      renderMode: "main",
      editing: {
        mode: "controlled",
        onEditRequest,
        onReconcileRequired: vi.fn(),
      },
    });
    await grid.initialize();
    await grid.setData(fixture([3, 1, 2], true));

    const editor = await openNumberEditor(gridHost);
    editor.value = "not-a-number";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(editor.getAttribute("aria-invalid")).toBe("true"));
    expect(onEditRequest).not.toHaveBeenCalled();

    editor.value = "7";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(onEditRequest).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(editor.getAttribute("aria-invalid")).toBe("true"));
    expect(gridHost.querySelector("[data-grid-editor-error]")?.textContent).toBe(
      "Value is outside the host policy.",
    );
    expect(grid.cancelEdit()).toBe(true);
    expect(gridHost.querySelector("[data-grid-editor]")).toBeNull();
    grid.destroy();
  });

  it("keeps Escape available while host validation is pending", async () => {
    const gridHost = host();
    let request: EditRequest | null = null;
    let resolveDecision!: (decision: EditDecision) => void;
    const decision = new Promise<EditDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const onEditComplete = vi.fn();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      editing: {
        mode: "controlled",
        onEditRequest: (nextRequest) => {
          request = nextRequest;
          return decision;
        },
        onReconcileRequired: vi.fn(),
        onEditComplete,
      },
    });
    await grid.initialize();
    await grid.setData(fixture([3, 1, 2], true));

    const editor = await openNumberEditor(gridHost);
    editor.value = "7";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(request).not.toBeNull());

    expect(editor.disabled).toBe(false);
    expect(editor.readOnly).toBe(true);
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(request!.signal.aborted).toBe(true);
    expect(gridHost.querySelector("[data-grid-editor]")).toBeNull();
    expect(onEditComplete).toHaveBeenCalledTimes(1);
    expect(onEditComplete.mock.calls[0]![0]).toMatchObject({ outcome: "cancelled" });
    resolveDecision({ outcome: "rejected", code: "late", message: "Late response" });
    await Promise.resolve();
    expect(onEditComplete).toHaveBeenCalledTimes(1);
    grid.destroy();
  });

  it("lets IME consume Escape without cancelling the editor", async () => {
    const gridHost = host();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      editing: {
        mode: "controlled",
        onEditRequest: () => ({ outcome: "rejected", code: "unused", message: "unused" }),
        onReconcileRequired: vi.fn(),
      },
    });
    await grid.initialize();
    await grid.setData(fixture([3, 1, 2], true));

    const editor = await openNumberEditor(gridHost);
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(gridHost.querySelector("[data-grid-editor]")).not.toBeNull();

    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(gridHost.querySelector("[data-grid-editor]")).toBeNull();
    grid.destroy();
  });

  it("returns bounded exact numeric and category bands from the published snapshot", async () => {
    const grid = new Grid(host(), {
      renderMode: "main",
      summary: { columns: ["value", "category"] },
    });
    await grid.initialize();
    const install = await grid.setData(summaryFixture());

    const numeric = await grid.getSummaryBands({ columnId: "value", bandCount: 2 });
    expect(numeric).toMatchObject({
      status: "applied",
      kind: "numeric",
      datasetId: install.datasetId,
      dataRevision: 1,
      viewRevision: 0,
      start: 0,
      end: 8,
      rowCount: 8,
      exact: true,
    });
    if (numeric.status !== "applied" || numeric.kind !== "numeric") {
      throw new Error("Expected an applied numeric summary.");
    }
    expect(numeric.presentationRevision).toBeGreaterThan(0);
    expect(numeric.bands).toEqual([
      {
        kind: "numeric",
        start: 0,
        end: 4,
        rowCount: 4,
        exact: true,
        nullCount: 0,
        finiteCount: 2,
        nanCount: 1,
        positiveInfinityCount: 1,
        negativeInfinityCount: 0,
        finiteMinimum: { value: 1, viewOrdinal: 2, rowId: 2 },
        finiteMaximum: { value: 3, viewOrdinal: 0, rowId: 0 },
      },
      {
        kind: "numeric",
        start: 4,
        end: 8,
        rowCount: 4,
        exact: true,
        nullCount: 1,
        finiteCount: 2,
        nanCount: 0,
        positiveInfinityCount: 0,
        negativeInfinityCount: 1,
        finiteMinimum: { value: -0, viewOrdinal: 5, rowId: 5 },
        finiteMaximum: { value: 2, viewOrdinal: 7, rowId: 7 },
      },
    ]);
    expect(Object.is(numeric.bands[1]!.finiteMinimum!.value, -0)).toBe(true);
    expect(numeric.queryStats).toMatchObject({
      durationMs: expect.any(Number),
      nodeVisits: expect.any(Number),
      rawRowsScanned: expect.any(Number),
      summaryVertices: 4,
      typedPayloadBytes: expect.any(Number),
    });

    const category = await grid.getSummaryBands({
      columnId: "category",
      bandCount: 2,
    });
    if (category.status !== "applied" || category.kind !== "category") {
      throw new Error("Expected an applied category summary.");
    }
    expect(category.bands).toEqual([
      {
        kind: "category",
        start: 0,
        end: 4,
        rowCount: 4,
        exact: true,
        nullCount: 0,
        exemplars: [
          { code: 0, label: "A", viewOrdinal: 0, rowId: 0 },
          { code: 1, label: "B", viewOrdinal: 1, rowId: 1 },
          { code: 2, label: "C", viewOrdinal: 3, rowId: 3 },
        ],
        complete: true,
      },
      {
        kind: "category",
        start: 4,
        end: 8,
        rowCount: 4,
        exact: true,
        nullCount: 1,
        exemplars: [
          { code: 3, label: "D", viewOrdinal: 4, rowId: 4 },
          { code: 4, label: "E", viewOrdinal: 5, rowId: 5 },
          { code: 2, label: "C", viewOrdinal: 7, rowId: 7 },
        ],
        complete: true,
      },
    ]);
    expect(grid.getDiagnostics()).toMatchObject({
      summaryBlockSize: 256,
      summaryConfiguredColumnCount: 2,
      summaryRetainedBytes: expect.any(Number),
      summaryStagedReplacementPeakBytes: expect.any(Number),
      lastSummaryBuildDurationMs: expect.any(Number),
      lastSummaryQueryDurationMs: category.queryStats.durationMs,
      lastSummaryQueryBandCount: 2,
      lastSummaryQueryNodeVisits: category.queryStats.nodeVisits,
      lastSummaryQueryRawRowsScanned: category.queryStats.rawRowsScanned,
      lastSummaryQueryVertices: category.queryStats.summaryVertices,
      lastSummaryQueryTypedPayloadBytes: category.queryStats.typedPayloadBytes,
    });
    expect(grid.getDiagnostics().summaryRetainedBytes).toBeGreaterThan(0);
    expect(category.queryStats.typedPayloadBytes).toBeGreaterThan(0);
    grid.destroy();
  });

  it("keeps the old published summary queryable while a new view is private", async () => {
    const grid = new Grid(host(), {
      renderMode: "main",
      summary: { columns: ["value"] },
    });
    await grid.initialize();
    await grid.setData(fixture([1, 2, 3, 4]));

    const applying = grid.setView({
      sort: [{ columnId: "value", direction: "descending" }],
    });
    const old = await grid.getSummaryBands({
      columnId: "value",
      bandCount: 1,
      start: 0,
      end: 2,
    });
    expect(old).toMatchObject({ status: "applied", kind: "numeric", viewRevision: 0 });
    if (old.status !== "applied" || old.kind !== "numeric") {
      throw new Error("Expected the prior numeric summary.");
    }
    expect(old.bands[0]).toMatchObject({
      finiteMinimum: { value: 1, rowId: 0 },
      finiteMaximum: { value: 2, rowId: 1 },
    });

    await expect(applying).resolves.toMatchObject({ status: "applied" });
    const current = await grid.getSummaryBands({
      columnId: "value",
      bandCount: 1,
      start: 0,
      end: 2,
    });
    if (current.status !== "applied" || current.kind !== "numeric") {
      throw new Error("Expected the replacement numeric summary.");
    }
    expect(current.viewRevision).toBeGreaterThan(old.viewRevision);
    expect(current.bands[0]).toMatchObject({
      finiteMinimum: { value: 3, rowId: 2 },
      finiteMaximum: { value: 4, rowId: 3 },
    });
    grid.destroy();
  });

  it("supersedes an old-snapshot query at publication and ignores its late reply", async () => {
    const grid = new Grid(host(), {
      renderMode: "main",
      summary: { columns: ["value"] },
    });
    await grid.initialize();
    await grid.setData(fixture([1, 2, 3, 4]));
    const internals = grid as unknown as {
      runtimeTransport: GridRuntimeTransport;
      handleRuntimeMessage(message: GridRuntimeOutputMessage): void;
    };
    const held: Extract<GridRuntimeInputMessage, { type: "querySummary" }>[] = [];
    const postMessage = internals.runtimeTransport.postMessage.bind(internals.runtimeTransport);
    internals.runtimeTransport.postMessage = (message, transfer = []) => {
      if (message.type === "querySummary") {
        held.push(message);
        return;
      }
      postMessage(message, transfer);
    };

    const pending = grid.getSummaryBands({
      columnId: "value",
      bandCount: 1,
      start: 0,
      end: 2,
    });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await grid.setView({ sort: [{ columnId: "value", direction: "descending" }] });
    await expect(pending).resolves.toMatchObject({ status: "superseded" });

    const stale = held[0]!;
    internals.handleRuntimeMessage({
      type: "summaryReady",
      kind: "numeric",
      queryId: stale.queryId,
      datasetId: stale.datasetId,
      dataRevision: stale.dataRevision,
      viewRevision: stale.viewRevision,
      columnId: stale.columnId,
      exact: true,
      bandCount: 1,
      ranges: stale.ranges,
      rowCounts: new Uint32Array([2]),
      nullCounts: new Uint32Array([0]),
      nodeVisits: 0,
      rawRowsScanned: 2,
      summaryVertices: 2,
      queryDurationMs: 1,
      typedPayloadBytes: 64,
      finiteCounts: new Uint32Array([2]),
      nanCounts: new Uint32Array([0]),
      positiveInfinityCounts: new Uint32Array([0]),
      negativeInfinityCounts: new Uint32Array([0]),
      finiteMinimumValues: new Float64Array([1]),
      finiteMaximumValues: new Float64Array([2]),
      finiteMinimumViewOrdinals: new Uint32Array([0]),
      finiteMaximumViewOrdinals: new Uint32Array([1]),
      finiteMinimumRowIds: [0],
      finiteMaximumRowIds: [1],
    });
    expect(grid.getDiagnostics()).toMatchObject({
      lastSummaryQueryDurationMs: null,
      lastSummaryQueryBandCount: null,
    });
    grid.destroy();
  });

  it("settles a summary query started inside the paint commit lease before a stale runtime error", async () => {
    const grid = new Grid(host(), {
      renderMode: "main",
      summary: { columns: ["value"] },
    });
    await grid.initialize();
    await grid.setData(fixture([1, 2, 3, 4]));
    const internals = grid as unknown as { runtimeTransport: GridRuntimeTransport };
    const runtime = internals.runtimeTransport;
    const postMessage = runtime.postMessage.bind(runtime);
    const received: GridRuntimeOutputMessage["type"][] = [];
    const onmessage = runtime.onmessage!;
    runtime.onmessage = (event) => {
      if (
        event.data.type === "published" ||
        (event.data.type === "runtimeError" && event.data.operation === "summary")
      ) {
        received.push(event.data.type);
      }
      onmessage(event);
    };
    let finalize: Extract<GridRuntimeInputMessage, { type: "finalizeSurface" }> | null = null;
    let query: Extract<GridRuntimeInputMessage, { type: "querySummary" }> | null = null;
    runtime.postMessage = (message, transfer = []) => {
      if (message.type === "finalizeSurface" && finalize === null) {
        finalize = message;
        return;
      }
      if (message.type === "querySummary" && query === null) {
        query = message;
        return;
      }
      postMessage(message, transfer);
    };

    const applying = grid.setView({
      sort: [{ columnId: "value", direction: "descending" }],
    });
    await vi.waitFor(() => expect(finalize).not.toBeNull());
    const pending = grid.getSummaryBands({ columnId: "value", bandCount: 1 });
    await vi.waitFor(() => expect(query).not.toBeNull());

    runtime.postMessage = postMessage;
    postMessage(finalize!);
    postMessage(query!);

    await expect(applying).resolves.toMatchObject({ status: "applied" });
    await expect(pending).resolves.toMatchObject({ status: "superseded" });
    await vi.waitFor(() => expect(received).toContain("runtimeError"));
    expect(received.indexOf("published")).toBeLessThan(received.indexOf("runtimeError"));
    grid.destroy();
  });

  it("cancels bounded summary queries on AbortSignal and settles them on destroy", async () => {
    const grid = new Grid(host(), {
      renderMode: "main",
      summary: { columns: ["value"] },
    });
    await grid.initialize();
    await grid.setData(fixture());
    const internals = grid as unknown as { runtimeTransport: GridRuntimeTransport };
    const held: Extract<GridRuntimeInputMessage, { type: "querySummary" }>[] = [];
    const cancellations: Extract<GridRuntimeInputMessage, { type: "cancelSummary" }>[] = [];
    const postMessage = internals.runtimeTransport.postMessage.bind(internals.runtimeTransport);
    internals.runtimeTransport.postMessage = (message, transfer = []) => {
      if (message.type === "querySummary") {
        held.push(message);
        return;
      }
      if (message.type === "cancelSummary") cancellations.push(message);
      postMessage(message, transfer);
    };

    const controller = new AbortController();
    const aborted = grid.getSummaryBands({
      columnId: "value",
      bandCount: 1,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(cancellations).toContainEqual({ type: "cancelSummary", queryId: held[0]!.queryId });

    const destroyed = grid.getSummaryBands({ columnId: "value", bandCount: 1 });
    await vi.waitFor(() => expect(held).toHaveLength(2));
    const destroyedExpectation = expect(destroyed).rejects.toThrow(/destroyed/);
    grid.destroy();
    await destroyedExpectation;
  });

  it("validates summary configuration, bounds, active ranges, and configured subsets", async () => {
    expect(
      () =>
        new Grid(host(), {
          renderMode: "main",
          summary: { columns: ["value", "value"] },
        }),
    ).toThrow(/unique/);

    const unconfigured = new Grid(host(), { renderMode: "main" });
    await unconfigured.initialize();
    await unconfigured.setData(fixture());
    expect(() => unconfigured.getSummaryBands({ columnId: "value", bandCount: 0 })).toThrow(
      /1 through 2048/,
    );
    await expect(unconfigured.getSummaryBands({ columnId: "value", bandCount: 1 })).rejects.toThrow(
      /not configured/,
    );
    unconfigured.destroy();

    const configured = new Grid(host(), {
      renderMode: "main",
      summary: { columns: ["value"] },
    });
    await configured.initialize();
    await configured.setData(summaryFixture());
    await expect(
      configured.getSummaryBands({ columnId: "category", bandCount: 1 }),
    ).rejects.toThrow(/not configured/);
    await expect(
      configured.getSummaryBands({ columnId: "value", bandCount: 1, start: 2, end: 9 }),
    ).rejects.toThrow(/outside the published view/);
    configured.destroy();

    const unsupported = new Grid(host(), {
      renderMode: "main",
      summary: { columns: ["label"] },
    });
    await unsupported.initialize();
    await expect(unsupported.setData(fixture())).rejects.toThrow(/numeric or categorical/);
    unsupported.destroy();
  });

  it("reports correlated bounded surface phases without letting telemetry failures wedge publication", async () => {
    const events: GridSurfaceTelemetryEvent[] = [];
    const options: GridOptions & GridInternalSurfaceTelemetryOptions = {
      renderMode: "main",
      overscanRows: 0,
      [GRID_INTERNAL_SURFACE_TELEMETRY]: (event) => {
        events.push(event);
        throw new Error("instrumentation failure");
      },
    };
    const grid = new Grid(host(), options);
    await grid.initialize();
    await expect(grid.setData(fixture())).resolves.toMatchObject({
      datasetId: expect.stringContaining("sixtyfold:grid:dataset:"),
    });

    const published = events.find(
      (event) => event.type === "published" && event.targetKind === "install",
    );
    expect(published).toBeDefined();
    if (!published || published.type !== "published") throw new Error("Missing publication.");
    const phases = events
      .filter(isGridSurfacePhaseEvent)
      .filter((event) => event.surfaceId === published.surfaceId);
    expect(phases.map((event) => event.type)).toEqual([
      "requested",
      "runtime-ready",
      "paint-presented",
      "published",
    ]);
    expect(new Set(phases.map((event) => event.commitToken))).toEqual(
      new Set([published.commitToken]),
    );
    expect(new Set(phases.map((event) => event.intentId))).toEqual(new Set([published.intentId]));
    const intent = events.find(
      (event) => event.type === "intent" && event.intentId === published.intentId,
    );
    expect(intent).toMatchObject({ type: "intent", scrollTop: 0, scrollLeft: 0 });
    expect(published.intentAtMs).toBe(intent?.observedAtMs);
    expect(published.latestIntentId).toBeGreaterThanOrEqual(published.intentId);
    expect(published.latestIntentLagMs).toBeGreaterThanOrEqual(0);
    expect(phases.find((event) => event.type === "runtime-ready")).toMatchObject({
      cellCount: 8,
      visibleRows: 4,
      visibleColumns: 2,
      firstRenderedRowIndex: 0,
      lastRenderedRowIndex: 3,
      firstRenderedColumnIndex: 0,
      lastRenderedColumnIndex: 1,
    });
    const runtimeReady = phases.find((event) => event.type === "runtime-ready");
    expect(runtimeReady?.type === "runtime-ready" && runtimeReady.textCodeUnits).toBeGreaterThan(0);
    const paintPresented = phases.find((event) => event.type === "paint-presented");
    expect(
      paintPresented?.type === "paint-presented" && paintPresented.semanticDurationMs,
    ).toBeGreaterThanOrEqual(0);
    if (paintPresented?.type === "paint-presented") {
      expect(paintPresented.semanticCompleteAtMs).toBeGreaterThanOrEqual(
        paintPresented.observedAtMs,
      );
    }
    expect(grid.getDiagnostics().paintError).toBeNull();
    grid.destroy();
  });

  it("keeps the prior published dataset until replacement publication settles", async () => {
    const grid = new Grid(host(), { renderMode: "main" });
    await grid.initialize();
    const first = await grid.setData(fixture([1, 2]));
    const replacement = grid.setData(fixture([8, 9, 10]));
    expect(grid.getViewport().datasetId).toBe(first.datasetId);
    const second = await replacement;
    expect(grid.getViewport().datasetId).toBe(second.datasetId);
    expect(second.datasetId).not.toBe(first.datasetId);
    grid.destroy();
  });

  it("consumes transfer ingress synchronously and keeps the prior dataset on deep rejection", async () => {
    vi.stubGlobal("structuredClone", nativeCloneInTestRealm);
    const gridHost = host();
    const grid = new Grid(gridHost, { renderMode: "main" });
    await grid.initialize();
    const first = await grid.setData(fixture([1, 2]));
    const invalid = new Uint8Array([0, 2]);

    const rejected = grid.setData(booleanFixture(invalid, "transfer"));
    expect(invalid.buffer.byteLength).toBe(0);
    await expect(rejected).rejects.toThrow(/zero or one/);
    expect(grid.getViewport().datasetId).toBe(first.datasetId);
    expect(
      [...gridHost.querySelectorAll('[role="gridcell"][data-grid-column-id="value"]')].map(
        (cell) => cell.textContent,
      ),
    ).toEqual(["1", "2"]);
    grid.destroy();
  });

  it("retains a caller copy when deep validation rejects the private snapshot", async () => {
    vi.stubGlobal("structuredClone", nativeCloneInTestRealm);
    const grid = new Grid(host(), { renderMode: "main" });
    await grid.initialize();
    const first = await grid.setData(fixture([1, 2]));
    const invalid = new Uint8Array([0, 2]);

    const rejected = grid.setData(booleanFixture(invalid, "copy"));
    expect(invalid.buffer.byteLength).toBe(2);
    await expect(rejected).rejects.toThrow(/zero or one/);
    expect(invalid.buffer.byteLength).toBe(2);
    expect(grid.getViewport().datasetId).toBe(first.datasetId);
    grid.destroy();
  });

  it("captures copy bytes and metadata at invocation before initialization can yield", async () => {
    vi.stubGlobal("structuredClone", nativeCloneInTestRealm);
    const gridHost = host();
    const grid = new Grid(gridHost, { renderMode: "main" });
    const values = new Float64Array([1, 2]);
    const data = numberBufferFixture(values, "copy");
    const install = grid.setData(data);

    values.set([7, 8]);
    (data.columns[0]!.schema as { id: string }).id = "mutated";
    await install;
    expect(
      [...gridHost.querySelectorAll('[role="gridcell"][data-grid-column-id="value"]')].map(
        (cell) => cell.textContent,
      ),
    ).toEqual(["1", "2"]);
    expect(gridHost.querySelector('[data-grid-column-id="mutated"]')).toBeNull();
    grid.destroy();
  });

  it("rejects a concurrent install before consuming its transfer buffers", async () => {
    vi.stubGlobal("structuredClone", nativeCloneInTestRealm);
    const grid = new Grid(host(), { renderMode: "main" });
    await grid.initialize();
    const first = grid.setData(fixture([1, 2]));
    const secondValues = new Uint8Array([0, 1]);
    const second = grid.setData(booleanFixture(secondValues, "transfer"));

    await expect(second).rejects.toThrow(/already in progress/);
    expect(secondValues.buffer.byteLength).toBe(2);
    await first;
    grid.destroy();
  });

  it("keeps the published dataset focusable and scrollable during replacement preflight", async () => {
    const gridHost = host();
    const grid = new Grid(gridHost, { renderMode: "main", overscanRows: 0 });
    await grid.initialize();
    const first = await grid.setData(fixture(Array.from({ length: 200 }, (_, index) => index)));

    const replacement = grid.setData(fixture([8, 9, 10]));
    await Promise.resolve();

    expect(grid.getViewport().datasetId).toBe(first.datasetId);
    gridHost
      .querySelector('[role="grid"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(grid.getFocusedCell()).toEqual({ rowId: 1, columnId: "value" });
    await expect(grid.focusCell({ rowId: 0, columnId: "label" })).resolves.toBe(true);
    await expect(grid.scrollToCell({ rowId: 150, columnId: "value" })).resolves.toBe(true);
    expect(grid.getFocusedCell()).toEqual({ rowId: 0, columnId: "label" });

    await replacement;
    grid.destroy();
  });

  it("quiesces after publication instead of repainting an unchanged active surface", async () => {
    const viewportChanged = vi.fn();
    const grid = new Grid(host(), { renderMode: "main", onViewportChange: viewportChanged });
    await grid.initialize();
    await grid.setData(fixture());
    const publishedCount = viewportChanged.mock.calls.length;

    await afterAnimationFrames(3);

    expect(publishedCount).toBe(1);
    expect(viewportChanged).toHaveBeenCalledTimes(publishedCount);
    grid.destroy();
  });

  it("treats an unchanged active-runtime stale drop as terminal instead of retrying forever", async () => {
    const viewportChanged = vi.fn();
    const events: GridSurfaceTelemetryEvent[] = [];
    const options: GridOptions & GridInternalSurfaceTelemetryOptions = {
      renderMode: "main",
      onViewportChange: viewportChanged,
      [GRID_INTERNAL_SURFACE_TELEMETRY]: (event) => events.push(event),
    };
    const grid = new Grid(host(), options);
    await grid.initialize();
    await grid.setData(fixture());
    viewportChanged.mockClear();
    events.length = 0;
    const internals = grid as unknown as {
      render(): void;
      runtimeSurfaceInFlight: { readonly surfaceId: number; readonly commitToken: string } | null;
      handleRuntimeMessage(message: GridRuntimeOutputMessage): void;
    };

    grid.resize();
    internals.render();
    const requested = internals.runtimeSurfaceInFlight!;
    internals.handleRuntimeMessage({
      type: "surfaceDropped",
      surfaceId: requested.surfaceId,
      commitToken: requested.commitToken,
      reason: "stale",
    });
    await afterAnimationFrames(3);

    expect(viewportChanged).not.toHaveBeenCalled();
    expect(grid.getDiagnostics().paintError).toContain("revision no longer matches");
    expect(
      events.find((event) => event.type === "dropped" && event.surfaceId === requested.surfaceId),
    ).toMatchObject({
      type: "dropped",
      commitToken: requested.commitToken,
      reason: "runtime-stale",
    });
    grid.destroy();
  });

  it("reports a correlated active-surface runtime error and quiesces the stale surface", async () => {
    const diagnosticsChanged = vi.fn();
    const viewportChanged = vi.fn();
    const gridHost = host();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      onDiagnosticsChange: diagnosticsChanged,
      onViewportChange: viewportChanged,
    });
    await grid.initialize();
    await grid.setData(fixture());
    diagnosticsChanged.mockClear();
    viewportChanged.mockClear();

    const internals = grid as unknown as {
      runtimeTransport: GridRuntimeTransport;
      runtimeSurfaceInFlight: { readonly surfaceId: number; readonly commitToken: string } | null;
      handleRuntimeMessage(message: GridRuntimeOutputMessage): void;
    };
    const transport = internals.runtimeTransport;
    const postMessage = transport.postMessage.bind(transport);
    const surfaces: Extract<GridRuntimeInputMessage, { type: "surface" }>[] = [];
    transport.postMessage = (message, transfer = []) => {
      if (message.type === "surface") {
        surfaces.push(message);
        return;
      }
      postMessage(message, transfer);
    };

    grid.resize();
    await vi.waitFor(() => expect(surfaces).toHaveLength(1));
    const requested = surfaces[0]!;
    internals.handleRuntimeMessage({
      type: "runtimeError",
      operation: "surface",
      requestId: requested.surfaceId + 1,
      message: "unrelated surface failure",
    });
    expect(internals.runtimeSurfaceInFlight?.surfaceId).toBe(requested.surfaceId);
    expect(grid.getDiagnostics().paintError).toBeNull();

    internals.handleRuntimeMessage({
      type: "runtimeError",
      operation: "surface",
      requestId: requested.surfaceId,
      message: "active surface exceeded its bounded frame",
    });
    await afterAnimationFrames(2);

    expect(internals.runtimeSurfaceInFlight).toBeNull();
    expect(surfaces).toHaveLength(1);
    expect(viewportChanged).not.toHaveBeenCalled();
    expect(grid.getDiagnostics().paintError).toBe("active surface exceeded its bounded frame");
    expect(diagnosticsChanged).toHaveBeenCalledTimes(1);
    expect(diagnosticsChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ paintError: "active surface exceeded its bounded frame" }),
    );
    expect(
      gridHost.querySelector('[role="gridcell"][data-grid-column-id="value"]')?.textContent,
    ).toBe("3");

    transport.postMessage = postMessage;
    grid.resize();
    await vi.waitFor(() => expect(grid.getDiagnostics().paintError).toBeNull());
    expect(viewportChanged).toHaveBeenCalledTimes(1);
    expect(diagnosticsChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ paintError: null }),
    );
    grid.destroy();
  });

  it("publishes and clears an active-surface error reached through public resize input", async () => {
    let height = 260;
    const gridHost = document.createElement("div");
    Object.defineProperties(gridHost, {
      clientWidth: { get: () => 640 },
      clientHeight: { get: () => height },
    });
    document.body.append(gridHost);
    const diagnosticsChanged = vi.fn();
    const viewportChanged = vi.fn();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      onDiagnosticsChange: diagnosticsChanged,
      onViewportChange: viewportChanged,
    });
    await grid.initialize();
    await grid.setData(fixture());
    diagnosticsChanged.mockClear();
    viewportChanged.mockClear();

    height = 20_000;
    grid.resize();
    await vi.waitFor(() => expect(grid.getDiagnostics().paintError).not.toBeNull());

    expect(grid.getDiagnostics().paintError).toMatch(/viewportHeight/);
    expect(diagnosticsChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ paintError: expect.stringMatching(/viewportHeight/) }),
    );
    expect(viewportChanged).not.toHaveBeenCalled();

    height = 260;
    grid.resize();
    await vi.waitFor(() => expect(grid.getDiagnostics().paintError).toBeNull());
    expect(viewportChanged).toHaveBeenCalledTimes(1);
    expect(diagnosticsChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ paintError: null }),
    );
    grid.destroy();
  });

  it("rejects runtime requests promptly after a fatal transport failure without leaking entries", async () => {
    const gridHost = host();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      overscanRows: 0,
      summary: { columns: ["value"] },
    });
    await grid.initialize();
    await grid.setData(
      fixture(
        Array.from({ length: 200 }, (_, index) => index),
        true,
      ),
    );

    const internals = grid as unknown as {
      handleRuntimeFailure(reason: unknown): void;
      resolveOrdinal(viewOrdinal: number): Promise<unknown>;
      inspectCell(rowId: number, columnId: string): Promise<unknown>;
      rowQueries: Map<number, unknown>;
      cellInspectionQueries: Map<number, unknown>;
    };
    internals.handleRuntimeFailure(new Error("fatal runtime transport failure"));

    await expectPromptRejection(grid.initialize(), "fatal runtime transport failure");
    await expectPromptRejection(grid.setView({}), "fatal runtime transport failure");
    await expectPromptRejection(grid.setData(fixture()), "fatal runtime transport failure");
    await expectPromptRejection(
      grid.getSummaryBands({ columnId: "value", bandCount: 1 }),
      "fatal runtime transport failure",
    );
    await expectPromptRejection(
      grid.focusCell({ rowId: 199, columnId: "value" }),
      "fatal runtime transport failure",
    );
    await expectPromptRejection(
      grid.scrollToCell({ rowId: 199, columnId: "value" }),
      "fatal runtime transport failure",
    );
    await expectPromptRejection(internals.resolveOrdinal(199), "fatal runtime transport failure");
    await expectPromptRejection(
      internals.inspectCell(0, "value"),
      "fatal runtime transport failure",
    );

    const keyboardEvent = new KeyboardEvent("keydown", {
      key: "End",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    gridHost.querySelector('[role="grid"]')!.dispatchEvent(keyboardEvent);
    expect(keyboardEvent.defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(internals.rowQueries.size).toBe(0);
    expect(internals.cellInspectionQueries.size).toBe(0);
    expect(grid.getDiagnostics().paintError).toBe("fatal runtime transport failure");
    grid.destroy();
  });

  it("retries an active host drop with the same intent and a fresh surface identity", async () => {
    const events: GridSurfaceTelemetryEvent[] = [];
    const options: GridOptions & GridInternalSurfaceTelemetryOptions = {
      renderMode: "main",
      [GRID_INTERNAL_SURFACE_TELEMETRY]: (event) => events.push(event),
    };
    const grid = new Grid(host(), options);
    await grid.initialize();
    await grid.setData(fixture());
    events.length = 0;

    const internals = grid as unknown as {
      runtimeTransport: GridRuntimeTransport;
      runtimeSurfaceInFlight: { readonly surfaceId: number; readonly commitToken: string } | null;
      handleRuntimeMessage(message: GridRuntimeOutputMessage): void;
    };
    const postedSurfaces: Extract<GridRuntimeInputMessage, { type: "surface" }>[] = [];
    const postMessage = internals.runtimeTransport.postMessage.bind(internals.runtimeTransport);
    internals.runtimeTransport.postMessage = (message, transfer = []) => {
      if (message.type === "surface") {
        postedSurfaces.push(message);
        return;
      }
      postMessage(message, transfer);
    };

    grid.resize();
    await vi.waitFor(() => expect(postedSurfaces).toHaveLength(1));
    const first = postedSurfaces[0]!;
    internals.handleRuntimeMessage({
      type: "surfaceDropped",
      surfaceId: first.surfaceId,
      commitToken: first.commitToken,
      reason: "host",
    });
    await vi.waitFor(() => expect(postedSurfaces).toHaveLength(2));
    const retry = postedSurfaces[1]!;

    expect(retry.surfaceId).toBeGreaterThan(first.surfaceId);
    expect(retry.commitToken).not.toBe(first.commitToken);
    const requested = events.filter((event) => event.type === "requested");
    expect(requested).toHaveLength(2);
    expect(requested[1]).toMatchObject({
      intentId: requested[0]!.intentId,
      intentAtMs: requested[0]!.intentAtMs,
    });
    expect(events.filter((event) => event.type === "intent")).toHaveLength(1);
    expect(events.filter((event) => event.type === "dropped")).toHaveLength(1);
    expect(internals.runtimeSurfaceInFlight).toMatchObject({
      surfaceId: retry.surfaceId,
      commitToken: retry.commitToken,
    });
    grid.destroy();
  });

  it.each(["publication-validation", "runtime-failure"] as const)(
    "terminates a paint-presented surface exactly once after %s",
    async (failure) => {
      const events: GridSurfaceTelemetryEvent[] = [];
      const options: GridOptions & GridInternalSurfaceTelemetryOptions = {
        renderMode: "main",
        [GRID_INTERNAL_SURFACE_TELEMETRY]: (event) => events.push(event),
      };
      const grid = new Grid(host(), options);
      await grid.initialize();
      await grid.setData(fixture());
      events.length = 0;

      const internals = grid as unknown as {
        runtimeTransport: GridRuntimeTransport;
        dataset: GridRuntimeDatasetDescriptor;
        runtimeSurfaceInFlight: unknown;
        paintInFlight: unknown;
        awaitingRuntimePublication: {
          readonly runtime: {
            readonly surfaceId: number;
            readonly commitToken: string;
          };
        } | null;
        handleRuntimeMessage(message: GridRuntimeOutputMessage): void;
        handleRuntimeFailure(reason: unknown): void;
      };
      const postMessage = internals.runtimeTransport.postMessage.bind(internals.runtimeTransport);
      let heldFinalize: Extract<GridRuntimeInputMessage, { type: "finalizeSurface" }> | null = null;
      internals.runtimeTransport.postMessage = (message, transfer = []) => {
        if (message.type === "finalizeSurface") {
          heldFinalize = message;
          return;
        }
        postMessage(message, transfer);
      };

      grid.resize();
      await vi.waitFor(() => expect(heldFinalize).not.toBeNull());
      const surface = internals.awaitingRuntimePublication!;
      expect(
        events.find(
          (event) =>
            event.type === "paint-presented" && event.surfaceId === surface.runtime.surfaceId,
        ),
      ).toBeDefined();

      if (failure === "publication-validation") {
        internals.handleRuntimeMessage({
          type: "published",
          surfaceId: surface.runtime.surfaceId,
          commitToken: surface.runtime.commitToken,
          publicationKind: "data",
          descriptor: internals.dataset,
          viewRevision: grid.getViewport().viewRevision,
          spec: grid.getView().spec,
          rowCount: grid.getDiagnostics().viewRowCount,
          summary: {
            blockSize: 256,
            columnCount: 0,
            buildDurationMs: 0,
            retainedBytes: 0,
            stagedReplacementPeakBytes: 0,
          },
        });
      } else {
        internals.handleRuntimeFailure(new Error("controlled runtime failure"));
      }

      const terminal = events
        .filter(isGridSurfacePhaseEvent)
        .filter((event) => event.surfaceId === surface.runtime.surfaceId);
      expect(terminal.map((event) => event.type)).toEqual([
        "requested",
        "runtime-ready",
        "paint-presented",
        "dropped",
      ]);
      expect(terminal.filter((event) => event.type === "dropped")).toEqual([
        expect.objectContaining({ reason: "runtime-failure" }),
      ]);
      expect(internals.runtimeSurfaceInFlight).toBeNull();
      expect(internals.paintInFlight).toBeNull();
      expect(internals.awaitingRuntimePublication).toBeNull();
      grid.destroy();
    },
  );

  it("keeps committed viewport metadata and old-view interaction live while a view builds", async () => {
    const values = Array.from({ length: 2_000 }, (_, index) => index);
    const gridHost = host();
    const grid = new Grid(gridHost, { renderMode: "main", overscanRows: 0 });
    await grid.initialize();
    await grid.setData(fixture(values));
    const committedViewport = grid.getViewport();

    const applying = grid.setView({
      sort: [{ columnId: "value", direction: "descending" }],
    });
    await Promise.resolve();

    expect(grid.getView().status).toBe("building");
    expect(grid.getViewport().viewRevision).toBe(committedViewport.viewRevision);
    expect(grid.getDiagnostics().viewRevision).toBe(committedViewport.viewRevision);
    gridHost
      .querySelector('[role="grid"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(grid.getFocusedCell()).toEqual({ rowId: 1, columnId: "value" });
    await expect(grid.focusCell({ rowId: 0, columnId: "label" })).resolves.toBe(true);
    await expect(grid.scrollToCell({ rowId: 1_500, columnId: "value" })).resolves.toBe(true);

    await expect(applying).resolves.toMatchObject({ status: "applied" });
    grid.destroy();
  });

  it("preserves an F2 edit intent while a view publication settles", async () => {
    const gridHost = host();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      editing: {
        mode: "controlled",
        onEditRequest: async () => ({ outcome: "rejected", code: "test", message: "test" }),
        onReconcileRequired: vi.fn(),
      },
    });
    await grid.initialize();
    await grid.setData(
      fixture(
        Array.from({ length: 2_000 }, (_, index) => index),
        true,
      ),
    );
    await grid.focusCell({ rowId: 0, columnId: "value" });

    const applying = grid.setView({
      sort: [{ columnId: "value", direction: "descending" }],
    });
    await Promise.resolve();
    gridHost
      .querySelector('[role="grid"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));

    await expect(applying).resolves.toMatchObject({ status: "applied" });
    await vi.waitFor(() =>
      expect(gridHost.querySelector("[data-grid-editor-control]")).toBeTruthy(),
    );
    grid.destroy();
  });

  it("holds a newer view behind the canonical acknowledgement of a presented view", async () => {
    const grid = new Grid(host(), { renderMode: "main" });
    await grid.initialize();
    await grid.setData(fixture());

    const internals = grid as unknown as {
      runtimeTransport: GridRuntimeTransport;
    };
    const transport = internals.runtimeTransport;
    const postMessage = transport.postMessage.bind(transport);
    let heldFinalize: Extract<GridRuntimeInputMessage, { type: "finalizeSurface" }> | null = null;
    let viewRequests = 0;
    transport.postMessage = (message, transfer = []) => {
      if (message.type === "setView") viewRequests++;
      if (message.type === "finalizeSurface" && heldFinalize === null) {
        heldFinalize = message;
        return;
      }
      postMessage(message, transfer);
    };

    const first = grid.setView({
      sort: [{ columnId: "value", direction: "ascending" }],
    });
    await vi.waitFor(() => expect(heldFinalize).not.toBeNull());
    expect(viewRequests).toBe(1);

    const second = grid.setView({
      sort: [{ columnId: "value", direction: "descending" }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(viewRequests).toBe(1);

    postMessage(
      heldFinalize as unknown as Extract<GridRuntimeInputMessage, { type: "finalizeSurface" }>,
    );
    await expect(first).resolves.toMatchObject({
      status: "applied",
      state: { viewRevision: 1 },
    });
    await vi.waitFor(() => expect(viewRequests).toBe(2));
    await expect(second).resolves.toMatchObject({
      status: "applied",
      state: { viewRevision: 2 },
    });
    expect(grid.getDiagnostics().paintError).toBeNull();
    grid.destroy();
  });

  it("installs semantics and fires publication callbacks before setData settles", async () => {
    const order: string[] = [];
    let semanticValueAtViewportCallback: string | null = null;
    const gridHost = host();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      onViewChange: (state) => {
        if (state.status === "ready") order.push("view");
      },
      onViewportChange: ({ source }) => {
        order.push(`viewport:${source}`);
        semanticValueAtViewportCallback =
          gridHost.querySelector('[role="gridcell"][data-grid-column-id="value"]')?.textContent ??
          null;
      },
    });
    await grid.initialize();

    const installation = grid.setData(fixture()).then((result) => {
      order.push("settled");
      return result;
    });
    await installation;

    expect(order).toEqual(["view", "viewport:data", "settled"]);
    expect(semanticValueAtViewportCallback).toBe("3");
    grid.destroy();
  });

  it("grants a worker reservation and publishes one controlled inline edit", async () => {
    let request: EditRequest | null = null;
    const completed = vi.fn();
    const gridHost = host();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      summary: { columns: ["value"] },
      editing: {
        mode: "controlled",
        onEditRequest: async (next) => {
          request = next;
          const lease = await next.beginAuthoritativeCommit();
          return lease.granted
            ? { outcome: "accepted", leaseId: lease.leaseId }
            : { outcome: "rejected", code: lease.reason, message: lease.message ?? lease.reason };
        },
        onReconcileRequired: vi.fn(),
        onEditComplete: completed,
      },
    });
    await grid.initialize();
    await grid.setData(fixture([3, 1, 2], true));
    await grid.focusCell({ rowId: 0, columnId: "value" });
    await openAndSubmitNumber(gridHost, "0");

    await vi.waitFor(() =>
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({ outcome: "accepted" })),
    );
    expect(request).not.toBeNull();
    expect(grid.getDiagnostics().dataRevision).toBe(2);
    expect(
      gridHost.querySelector('[role="gridcell"][data-grid-column-id="value"]')?.textContent,
    ).toBe("0");
    const summary = await grid.getSummaryBands({ columnId: "value", bandCount: 1 });
    if (summary.status !== "applied" || summary.kind !== "numeric") {
      throw new Error("Expected the accepted edit summary.");
    }
    expect(summary).toMatchObject({ dataRevision: 2, viewRevision: 0 });
    expect(summary.bands[0]).toMatchObject({
      finiteMinimum: { value: 0, rowId: 0 },
      finiteMaximum: { value: 2, rowId: 2 },
    });
    grid.destroy();
  });

  it("commits with Tab and advances across editable columns", async () => {
    const completed = vi.fn();
    const gridHost = host();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      editing: {
        mode: "controlled",
        onEditRequest: async (request) => {
          const lease = await request.beginAuthoritativeCommit();
          return lease.granted
            ? { outcome: "accepted", leaseId: lease.leaseId }
            : { outcome: "rejected", code: lease.reason, message: lease.message ?? lease.reason };
        },
        onReconcileRequired: vi.fn(),
        onEditComplete: completed,
      },
    });
    await grid.initialize();
    await grid.setData(fixture([3, 1, 2], true));
    await grid.focusCell({ rowId: 0, columnId: "value" });

    const valueEditor = await openNumberEditor(gridHost);
    valueEditor.value = "5";
    valueEditor.dispatchEvent(new Event("input", { bubbles: true }));
    valueEditor.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    await vi.waitFor(() =>
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({ outcome: "accepted" })),
    );
    await vi.waitFor(() => expect(grid.getFocusedCell()).toEqual({ rowId: 0, columnId: "label" }));
    expect(gridHost.querySelector("[data-grid-editor]")).toBeNull();
    expect(document.activeElement).toBe(gridHost.querySelector('[role="grid"]'));

    const labelEditor = await openNumberEditor(gridHost);
    labelEditor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    await vi.waitFor(() => expect(grid.getFocusedCell()).toEqual({ rowId: 0, columnId: "value" }));
    expect(gridHost.querySelector("[data-grid-editor]")).toBeNull();
    grid.destroy();
  });

  it("commits click-away edits and preserves their pointer destination", async () => {
    const completed = vi.fn();
    const gridHost = host();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      editing: {
        mode: "controlled",
        onEditRequest: async (request) => {
          const lease = await request.beginAuthoritativeCommit();
          return lease.granted
            ? { outcome: "accepted", leaseId: lease.leaseId }
            : { outcome: "rejected", code: lease.reason, message: lease.message ?? lease.reason };
        },
        onReconcileRequired: vi.fn(),
        onEditComplete: completed,
      },
    });
    await grid.initialize();
    await grid.setData(fixture([3, 1, 2], true));
    await grid.focusCell({ rowId: 0, columnId: "value" });

    const firstEditor = await openNumberEditor(gridHost);
    firstEditor.value = "5";
    firstEditor.dispatchEvent(new Event("input", { bubbles: true }));
    const canvas = gridHost.querySelector<HTMLCanvasElement>("[data-grid-canvas]")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 640,
      bottom: 260,
      width: 640,
      height: 260,
      toJSON: () => ({}),
    });
    canvas.dispatchEvent(
      new MouseEvent("pointerdown", {
        button: 0,
        clientX: 80 + 176 + 12,
        clientY: 38 + 30 + 12,
        bubbles: true,
      }),
    );

    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(grid.getFocusedCell()).toEqual({ rowId: 1, columnId: "label" }));
    expect(gridHost.querySelector("[data-grid-editor]")).toBeNull();

    await grid.focusCell({ rowId: 0, columnId: "value" });
    const secondEditor = await openNumberEditor(gridHost);
    secondEditor.value = "6";
    secondEditor.dispatchEvent(new Event("input", { bubbles: true }));
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
    outside.focus();

    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(gridHost.querySelector("[data-grid-editor]")).toBeNull());
    expect(document.activeElement).toBe(outside);
    grid.destroy();
  });

  it("keeps view revisions strictly monotonic after a mapping-changing edit", async () => {
    const completed = vi.fn();
    const gridHost = host();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      summary: { columns: ["value"] },
      editing: {
        mode: "controlled",
        onEditRequest: async (request) => {
          const lease = await request.beginAuthoritativeCommit();
          return lease.granted
            ? { outcome: "accepted", leaseId: lease.leaseId }
            : { outcome: "rejected", code: lease.reason, message: lease.message ?? lease.reason };
        },
        onReconcileRequired: vi.fn(),
        onEditComplete: completed,
      },
    });
    await grid.initialize();
    await grid.setData(fixture([3, 1, 2, 4], true));
    const initial = await grid.setView({
      filter: {
        kind: "comparison",
        columnId: "value",
        operator: "gte",
        value: 2,
      },
      sort: [{ columnId: "value", direction: "ascending" }],
    });
    if (initial.status !== "applied") throw new Error("Expected the initial filtered view.");

    await grid.focusCell({ rowId: 2, columnId: "value" });
    await openAndSubmitNumber(gridHost, "5");
    await vi.waitFor(() =>
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({ outcome: "accepted" })),
    );
    expect(grid.getFocusedCell()).toEqual({ rowId: 2, columnId: "value" });
    const editViewRevision = grid.getDiagnostics().viewRevision;
    expect(editViewRevision).toBeGreaterThan(initial.state.viewRevision);

    const next = await grid.setView({
      filter: {
        kind: "comparison",
        columnId: "value",
        operator: "gte",
        value: 3,
      },
      sort: [{ columnId: "value", direction: "descending" }],
    });
    if (next.status !== "applied") throw new Error("Expected the explicit replacement view.");
    expect(next.state.viewRevision).toBeGreaterThan(editViewRevision);

    const summary = await grid.getSummaryBands({ columnId: "value", bandCount: 1 });
    if (summary.status !== "applied" || summary.kind !== "numeric") {
      throw new Error("Expected the replacement view summary.");
    }
    expect(summary).toMatchObject({
      dataRevision: 2,
      viewRevision: next.state.viewRevision,
      rowCount: 3,
    });
    expect(summary.bands[0]).toMatchObject({
      start: 0,
      end: 3,
      finiteMinimum: { value: 3, viewOrdinal: 2, rowId: 0 },
      finiteMaximum: { value: 5, viewOrdinal: 0, rowId: 2 },
    });
    grid.destroy();
  });

  it("allocates a replacement revision after an authoritative edit settles", async () => {
    let acceptHost!: (decision: { outcome: "accepted"; leaseId: string }) => void;
    const hostDecision = new Promise<{ outcome: "accepted"; leaseId: string }>((resolve) => {
      acceptHost = resolve;
    });
    let grantedLeaseId: string | null = null;
    let leaseGranted!: () => void;
    const leaseReady = new Promise<void>((resolve) => {
      leaseGranted = resolve;
    });
    const completed = vi.fn();
    const gridHost = host();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      editing: {
        mode: "controlled",
        onEditRequest: async (request) => {
          const lease = await request.beginAuthoritativeCommit();
          if (!lease.granted) {
            return { outcome: "rejected", code: lease.reason, message: lease.reason };
          }
          grantedLeaseId = lease.leaseId;
          leaseGranted();
          return hostDecision;
        },
        onReconcileRequired: vi.fn(),
        onEditComplete: completed,
      },
    });
    await grid.initialize();
    await grid.setData(fixture([3, 1, 2], true));
    await grid.focusCell({ rowId: 0, columnId: "value" });
    await openAndSubmitNumber(gridHost, "0");
    await leaseReady;

    const replacement = grid.setData(fixture([9, 8], true));
    acceptHost({ outcome: "accepted", leaseId: grantedLeaseId! });
    await vi.waitFor(() =>
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "accepted", publishedDataRevision: 2 }),
      ),
    );
    await expect(replacement).resolves.toMatchObject({ datasetId: expect.any(String) });
    expect(grid.getDiagnostics().dataRevision).toBe(3);
    grid.destroy();
  });

  it("keeps reconciliation locked through a failed replacement and unlocks on publication", async () => {
    const reconcile = vi.fn();
    const gridHost = host();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      editing: {
        mode: "controlled",
        onEditRequest: async (request) => {
          const lease = await request.beginAuthoritativeCommit();
          if (!lease.granted) {
            return { outcome: "rejected", code: lease.reason, message: lease.reason };
          }
          return { outcome: "accepted", leaseId: `${lease.leaseId}:wrong` };
        },
        onReconcileRequired: reconcile,
      },
    });
    await grid.initialize();
    const first = await grid.setData(fixture([3, 1, 2], true));
    await grid.focusCell({ rowId: 0, columnId: "value" });
    await openAndSubmitNumber(gridHost, "0");
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    const root = gridHost.querySelector<HTMLElement>("[data-sixtyfold-grid]")!;
    expect(root.dataset.gridEditState).toBe("reconcile-required");
    expect(gridHost.querySelector("[data-grid-editor]")).not.toBeNull();

    await expect(grid.setData(booleanFixture(new Uint8Array([0, 2]), "copy"))).rejects.toThrow(
      /zero or one/,
    );
    expect(grid.getViewport().datasetId).toBe(first.datasetId);
    expect(root.dataset.gridEditState).toBe("reconcile-required");
    expect(gridHost.querySelector("[data-grid-editor]")).not.toBeNull();

    const replacement = await grid.setData(fixture([9, 8], true));
    expect(grid.getViewport().datasetId).toBe(replacement.datasetId);
    expect(root.dataset.gridEditState).toBe("idle");
    expect(gridHost.querySelector("[data-grid-editor]")).toBeNull();
    grid.destroy();
  });

  it("cancels a reserving edit once and hides any late worker lease grant", async () => {
    let request: EditRequest | null = null;
    let settleHost!: (decision: { outcome: "rejected"; code: string; message: string }) => void;
    const hostDecision = new Promise<{ outcome: "rejected"; code: string; message: string }>(
      (resolve) => {
        settleHost = resolve;
      },
    );
    const completed = vi.fn();
    const gridHost = host();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      editing: {
        mode: "controlled",
        onEditRequest: (next) => {
          request = next;
          return hostDecision;
        },
        onReconcileRequired: vi.fn(),
        onEditComplete: completed,
      },
    });
    await grid.initialize();
    await grid.setData(fixture([3, 1, 2], true));
    await grid.focusCell({ rowId: 0, columnId: "value" });
    await openAndSubmitNumber(gridHost, "0");
    await vi.waitFor(() => expect(request).not.toBeNull());

    const lease = request!.beginAuthoritativeCommit();
    expect(grid.cancelEdit(request!.operationId)).toBe(true);
    expect(request!.signal.aborted).toBe(true);
    await expect(lease).resolves.toEqual({ granted: false, reason: "cancelled" });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ outcome: "cancelled" }));

    settleHost({ outcome: "rejected", code: "late", message: "late settlement" });
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toHaveBeenCalledTimes(1);
    grid.destroy();
  });

  it("becomes uncancellable before a granted lease promise resumes host code", async () => {
    let cancelAfterGrant: boolean | null = null;
    let signalAbortedAfterGrant: boolean | null = null;
    const completed = vi.fn();
    const gridHost = host();
    const grid = new Grid(gridHost, {
      renderMode: "main",
      editing: {
        mode: "controlled",
        onEditRequest: async (request) => {
          const lease = await request.beginAuthoritativeCommit();
          if (!lease.granted) {
            return { outcome: "rejected", code: lease.reason, message: lease.reason };
          }
          cancelAfterGrant = grid.cancelEdit(request.operationId);
          signalAbortedAfterGrant = request.signal.aborted;
          return { outcome: "accepted", leaseId: lease.leaseId };
        },
        onReconcileRequired: vi.fn(),
        onEditComplete: completed,
      },
    });
    await grid.initialize();
    await grid.setData(fixture([3, 1, 2], true));
    await grid.focusCell({ rowId: 0, columnId: "value" });
    await openAndSubmitNumber(gridHost, "0");

    await vi.waitFor(() =>
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({ outcome: "accepted" })),
    );
    expect(cancelAfterGrant).toBe(false);
    expect(signalAbortedAfterGrant).toBe(false);
    expect(completed).toHaveBeenCalledTimes(1);
    grid.destroy();
  });

  it("settles offscreen focus and scroll requests harmlessly when destroyed", async () => {
    const grid = new Grid(host(), { renderMode: "main", overscanRows: 0 });
    await grid.initialize();
    await grid.setData(fixture(Array.from({ length: 200 }, (_, index) => index)));

    const focus = grid.focusCell({ rowId: 150, columnId: "label" });
    const scroll = grid.scrollToCell({ rowId: 175, columnId: "value" });
    grid.destroy();

    await expect(focus).resolves.toBe(false);
    await expect(scroll).resolves.toBe(false);
  });

  it("observes an ignored setData teardown rejection without hiding it from later awaiters", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const grid = new Grid(host(), { renderMode: "main" });
      await grid.initialize();
      const installation = grid.setData(fixture(Array.from({ length: 200 }, (_, index) => index)));
      grid.destroy();

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      await expect(installation).rejects.toThrow("destroyed");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
