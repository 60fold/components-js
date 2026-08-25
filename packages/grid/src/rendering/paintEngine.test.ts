import { describe, expect, it, vi } from "vitest";
import { createGridPaintEngine } from "./paintEngine";
import {
  GRID_PAINT_CELL_SELECTED,
  assertGridPaintFrame,
  type GridPaintFrame,
  type GridPaintOutputMessage,
} from "./paintProtocol";

function fakeContext(): CanvasRenderingContext2D {
  return {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: (value: string) => ({ width: value.length * 7 }) as TextMetrics,
    rect: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn(),
    strokeRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

function frame(frameId = 1): GridPaintFrame {
  return {
    frameId,
    commitToken: `commit-${frameId}`,
    revision: {
      datasetId: "dataset-1",
      dataRevision: 1,
      viewRevision: 2,
      presentationRevision: frameId,
    },
    viewportWidth: 320,
    viewportHeight: 180,
    pixelRatio: 2,
    headerHeight: 36,
    columns: [
      {
        columnIndex: 2,
        columnId: "value",
        label: "Value",
        x: 0,
        width: 160,
        minWidth: 88,
        maxWidth: 640,
      },
    ],
    rows: [{ viewOrdinal: 9, y: 36, height: 30 }],
    cellText: ["42"],
    cellTone: new Uint8Array([0]),
    cellState: new Uint8Array([GRID_PAINT_CELL_SELECTED]),
    focusedCell: 0,
    palette: {
      background: "#000",
      alternateBackground: "#111",
      headerBackground: "#222",
      line: "#333",
      text: "#fff",
      mutedText: "#888",
      accent: "#fc0",
      selection: "rgba(255, 204, 0, .2)",
      fontFamily: "monospace",
    },
  };
}

describe("grid paint engine", () => {
  it("prepares a bounded frame without touching the visible canvas, then presents it", () => {
    const context = fakeContext();
    const stagingContext = fakeContext();
    const stagingCanvas = {
      width: 0,
      height: 0,
      style: { width: "", height: "" },
      getContext: vi.fn(() => stagingContext),
    } as unknown as HTMLCanvasElement;
    const canvas = {
      width: 0,
      height: 0,
      style: { width: "", height: "" },
      ownerDocument: { createElement: vi.fn(() => stagingCanvas) },
      getContext: vi.fn(() => context),
    } as unknown as HTMLCanvasElement;
    const messages: GridPaintOutputMessage[] = [];
    const times = [10, 13];
    const engine = createGridPaintEngine({
      postMessage: (message) => messages.push(message),
      now: () => times.shift() ?? 13,
    });

    engine.handleMessage({ type: "init", canvas });
    engine.handleMessage({ type: "prepare", frame: frame() });

    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(stagingContext.fillText).toHaveBeenCalledWith("42", 10, 51);
    expect(messages).toEqual([
      { type: "ready" },
      {
        type: "prepared",
        frameId: 1,
        commitToken: "commit-1",
        revision: frame().revision,
        paintedCells: 1,
        durationMs: 3,
      },
    ]);

    engine.handleMessage({ type: "commit", frameId: 1, commitToken: "commit-1" });

    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
    expect(context.drawImage).toHaveBeenCalledWith(stagingCanvas, 0, 0);
    expect(messages.at(-1)).toEqual({
      type: "presented",
      frameId: 1,
      commitToken: "commit-1",
      revision: frame().revision,
      paintedCells: 1,
      durationMs: 3,
    });
  });

  it("drops an older frame without drawing it", () => {
    const context = fakeContext();
    const canvas = {
      width: 0,
      height: 0,
      style: { width: "", height: "" },
      ownerDocument: {
        createElement: () =>
          ({
            width: 0,
            height: 0,
            style: {},
            getContext: () => fakeContext(),
          }) as unknown as HTMLCanvasElement,
      },
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const messages: GridPaintOutputMessage[] = [];
    const engine = createGridPaintEngine({ postMessage: (message) => messages.push(message) });
    engine.handleMessage({ type: "init", canvas });
    engine.handleMessage({ type: "prepare", frame: frame(4) });
    const calls = vi.mocked(context.fillRect).mock.calls.length;

    engine.handleMessage({ type: "prepare", frame: frame(3) });

    expect(vi.mocked(context.fillRect).mock.calls).toHaveLength(calls);
    expect(messages.at(-1)).toEqual({
      type: "dropped",
      frameId: 3,
      commitToken: "commit-3",
      reason: "stale-frame",
    });
  });

  it("paints renderer-confirmed row numbers and sort direction", () => {
    const presentation = fakeContext();
    const staging = fakeContext();
    const stagingCanvas = {
      width: 0,
      height: 0,
      style: {},
      getContext: () => staging,
    } as unknown as HTMLCanvasElement;
    const canvas = {
      width: 0,
      height: 0,
      style: {},
      ownerDocument: { createElement: () => stagingCanvas },
      getContext: () => presentation,
    } as unknown as HTMLCanvasElement;
    const engine = createGridPaintEngine({ postMessage: vi.fn() });
    const candidate: GridPaintFrame = {
      ...frame(),
      rowNumberColumn: {
        label: "#",
        accessibleLabel: "Row number",
        x: 0,
        width: 80,
      },
      rowNumberText: ["10"],
      columns: [{ ...frame().columns[0]!, x: 80, sortDirection: "ascending" }],
    };

    engine.handleMessage({ type: "init", canvas });
    engine.handleMessage({ type: "prepare", frame: candidate });

    expect(staging.fillText).toHaveBeenCalledWith("↑", 220, 18);
    expect(staging.fillText).toHaveBeenCalledWith("10", 10, 51);
    expect(staging.fillText).toHaveBeenCalledWith("#", 10, 18);
  });

  it("rejects a commit that does not match the prepared candidate", () => {
    const context = fakeContext();
    const canvas = {
      width: 0,
      height: 0,
      style: { width: "", height: "" },
      ownerDocument: {
        createElement: () =>
          ({
            width: 0,
            height: 0,
            style: {},
            getContext: () => fakeContext(),
          }) as unknown as HTMLCanvasElement,
      },
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const messages: GridPaintOutputMessage[] = [];
    const engine = createGridPaintEngine({ postMessage: (message) => messages.push(message) });
    engine.handleMessage({ type: "init", canvas });
    engine.handleMessage({ type: "prepare", frame: frame(2) });

    engine.handleMessage({ type: "commit", frameId: 2, commitToken: "wrong" });

    expect(context.drawImage).not.toHaveBeenCalled();
    expect(messages.at(-1)).toEqual({
      type: "dropped",
      frameId: 2,
      commitToken: "wrong",
      reason: "unprepared-commit",
    });
  });

  it("rejects malformed and unbounded payloads before painting", () => {
    expect(() => assertGridPaintFrame({ ...frame(), cellText: [] })).toThrow(/expected 1/);
    expect(() =>
      assertGridPaintFrame({
        ...frame(),
        columns: [{ ...frame().columns[0]!, width: 80 }],
      }),
    ).toThrow(/declared minWidth and maxWidth/);
    expect(() =>
      assertGridPaintFrame({
        ...frame(),
        rows: Array.from({ length: 4_097 }, (_, viewOrdinal) => ({
          viewOrdinal,
          y: viewOrdinal * 30,
          height: 30,
        })),
        cellText: Array.from({ length: 4_097 }, () => "x"),
        cellTone: undefined,
        cellState: undefined,
        focusedCell: undefined,
      }),
    ).toThrow(/4096-row/);
  });
});
