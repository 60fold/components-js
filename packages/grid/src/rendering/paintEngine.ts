import {
  DEFAULT_GRID_PAINT_LIMITS,
  GRID_PAINT_CELL_SELECTED,
  assertGridPaintFrame,
  type GridPaintCanvas,
  type GridPaintContext,
  type GridPaintFrame,
  type GridPaintInputMessage,
  type GridPaintLimits,
  type GridPaintOutputMessage,
} from "./paintProtocol.js";

export interface GridPaintEngine {
  handleMessage(message: GridPaintInputMessage): void;
  dispose(): void;
}

export interface GridPaintEngineCallbacks {
  postMessage(message: GridPaintOutputMessage): void;
  now?: () => number;
}

export function createGridPaintEngine(
  callbacks: GridPaintEngineCallbacks,
  limits: GridPaintLimits = DEFAULT_GRID_PAINT_LIMITS,
): GridPaintEngine {
  let canvas: GridPaintCanvas | null = null;
  let context: GridPaintContext | null = null;
  let preparedCanvas: GridPaintCanvas | null = null;
  let preparedContext: GridPaintContext | null = null;
  let prepared: { frame: GridPaintFrame; paintedCells: number; durationMs: number } | null = null;
  let lastPreparedFrameId = -1;
  let lastPresentedFrameId = -1;
  let disposed = false;

  return {
    handleMessage(message): void {
      if (disposed) throw new Error("Grid paint engine has been disposed.");
      switch (message.type) {
        case "init": {
          if (canvas) throw new Error("Grid paint engine is already initialized.");
          const nextContext = message.canvas.getContext("2d", { alpha: false });
          if (!nextContext) throw new Error("Canvas2D is unavailable to the grid paint engine.");
          canvas = message.canvas;
          context = nextContext as GridPaintContext;
          callbacks.postMessage({ type: "ready" });
          return;
        }
        case "prepare": {
          if (!canvas || !context) throw new Error("Grid paint engine is not initialized.");
          assertGridPaintFrame(message.frame, limits);
          if (message.frame.frameId <= lastPreparedFrameId) {
            callbacks.postMessage({
              type: "dropped",
              frameId: message.frame.frameId,
              commitToken: message.frame.commitToken,
              reason: "stale-frame",
            });
            return;
          }
          const physicalWidth = Math.max(
            1,
            Math.round(message.frame.viewportWidth * message.frame.pixelRatio),
          );
          const physicalHeight = Math.max(
            1,
            Math.round(message.frame.viewportHeight * message.frame.pixelRatio),
          );
          if (
            !preparedCanvas ||
            preparedCanvas.width !== physicalWidth ||
            preparedCanvas.height !== physicalHeight
          ) {
            preparedCanvas = createStagingCanvas(canvas, physicalWidth, physicalHeight);
            const nextPreparedContext = preparedCanvas.getContext("2d", { alpha: false });
            if (!nextPreparedContext) {
              throw new Error("Canvas2D is unavailable to the grid paint staging surface.");
            }
            preparedContext = nextPreparedContext as GridPaintContext;
          }
          const startedAt = callbacks.now?.() ?? performance.now();
          paintGridFrame(preparedCanvas, preparedContext!, message.frame);
          const finishedAt = callbacks.now?.() ?? performance.now();
          lastPreparedFrameId = message.frame.frameId;
          prepared = {
            frame: message.frame,
            paintedCells: message.frame.cellText.length,
            durationMs: Math.max(0, finishedAt - startedAt),
          };
          callbacks.postMessage({
            type: "prepared",
            frameId: message.frame.frameId,
            commitToken: message.frame.commitToken,
            revision: message.frame.revision,
            paintedCells: message.frame.cellText.length,
            durationMs: Math.max(0, finishedAt - startedAt),
          });
          return;
        }
        case "commit": {
          if (!canvas || !context) throw new Error("Grid paint engine is not initialized.");
          if (
            !prepared ||
            !preparedCanvas ||
            prepared.frame.frameId !== message.frameId ||
            prepared.frame.commitToken !== message.commitToken ||
            message.frameId <= lastPresentedFrameId
          ) {
            callbacks.postMessage({
              type: "dropped",
              frameId: message.frameId,
              commitToken: message.commitToken,
              reason: "unprepared-commit",
            });
            return;
          }
          presentPreparedFrame(canvas, context, preparedCanvas, prepared.frame);
          lastPresentedFrameId = message.frameId;
          callbacks.postMessage({
            type: "presented",
            frameId: prepared.frame.frameId,
            commitToken: prepared.frame.commitToken,
            revision: prepared.frame.revision,
            paintedCells: prepared.paintedCells,
            durationMs: prepared.durationMs,
          });
          prepared = null;
          return;
        }
        case "dispose":
          disposed = true;
          canvas = null;
          context = null;
          preparedCanvas = null;
          preparedContext = null;
          prepared = null;
          callbacks.postMessage({ type: "disposed" });
          return;
      }
    },
    dispose(): void {
      disposed = true;
      canvas = null;
      context = null;
      preparedCanvas = null;
      preparedContext = null;
      prepared = null;
    },
  };
}

function createStagingCanvas(
  presentationCanvas: GridPaintCanvas,
  width: number,
  height: number,
): GridPaintCanvas {
  if ("ownerDocument" in presentationCanvas && presentationCanvas.ownerDocument) {
    const canvas = presentationCanvas.ownerDocument.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  throw new Error("OffscreenCanvas is unavailable to the grid paint staging surface.");
}

function presentPreparedFrame(
  canvas: GridPaintCanvas,
  context: GridPaintContext,
  preparedCanvas: GridPaintCanvas,
  frame: GridPaintFrame,
): void {
  const physicalWidth = Math.max(1, Math.round(frame.viewportWidth * frame.pixelRatio));
  const physicalHeight = Math.max(1, Math.round(frame.viewportHeight * frame.pixelRatio));
  if (canvas.width !== physicalWidth) canvas.width = physicalWidth;
  if (canvas.height !== physicalHeight) canvas.height = physicalHeight;
  setCanvasCssSize(canvas, frame.viewportWidth, frame.viewportHeight);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, physicalWidth, physicalHeight);
  context.drawImage(preparedCanvas, 0, 0);
}

export function paintGridFrame(
  canvas: GridPaintCanvas,
  context: GridPaintContext,
  frame: GridPaintFrame,
): void {
  const physicalWidth = Math.max(1, Math.round(frame.viewportWidth * frame.pixelRatio));
  const physicalHeight = Math.max(1, Math.round(frame.viewportHeight * frame.pixelRatio));
  if (canvas.width !== physicalWidth) canvas.width = physicalWidth;
  if (canvas.height !== physicalHeight) canvas.height = physicalHeight;
  setCanvasCssSize(canvas, frame.viewportWidth, frame.viewportHeight);

  context.setTransform(frame.pixelRatio, 0, 0, frame.pixelRatio, 0, 0);
  context.clearRect(0, 0, frame.viewportWidth, frame.viewportHeight);
  context.fillStyle = frame.palette.background;
  context.fillRect(0, 0, frame.viewportWidth, frame.viewportHeight);
  context.font = `500 12px ${frame.palette.fontFamily}`;
  context.textBaseline = "middle";
  const rowNumberWidth = frame.rowNumberColumn?.width ?? 0;

  context.save();
  context.beginPath();
  context.rect(
    rowNumberWidth,
    frame.headerHeight,
    Math.max(0, frame.viewportWidth - rowNumberWidth),
    Math.max(0, frame.viewportHeight - frame.headerHeight),
  );
  context.clip();
  for (let rowOffset = 0; rowOffset < frame.rows.length; rowOffset++) {
    const row = frame.rows[rowOffset]!;
    context.fillStyle =
      row.viewOrdinal % 2 === 0 ? frame.palette.background : frame.palette.alternateBackground;
    context.fillRect(0, row.y, frame.viewportWidth, row.height);
    for (let columnOffset = 0; columnOffset < frame.columns.length; columnOffset++) {
      const column = frame.columns[columnOffset]!;
      const cellOffset = rowOffset * frame.columns.length + columnOffset;
      if ((frame.cellState?.[cellOffset] ?? 0) & GRID_PAINT_CELL_SELECTED) {
        context.fillStyle = frame.palette.selection;
        context.fillRect(column.x, row.y, column.width, row.height);
      }
      context.strokeStyle = frame.palette.line;
      context.lineWidth = 1;
      context.strokeRect(column.x + 0.5, row.y + 0.5, column.width, row.height);
      context.fillStyle = frame.cellTone?.[cellOffset]
        ? frame.palette.mutedText
        : frame.palette.text;
      drawClippedText(
        context,
        frame.cellText[cellOffset]!,
        column.x + 10,
        row.y + row.height / 2,
        column.width - 20,
      );
    }
  }
  if (frame.focusedCell !== undefined && frame.columns.length > 0) {
    const rowOffset = Math.floor(frame.focusedCell / frame.columns.length);
    const columnOffset = frame.focusedCell % frame.columns.length;
    const row = frame.rows[rowOffset];
    const column = frame.columns[columnOffset];
    if (row && column) {
      context.strokeStyle = frame.palette.accent;
      context.lineWidth = 2;
      context.strokeRect(column.x + 1, row.y + 1, column.width - 2, row.height - 2);
    }
  }
  context.restore();

  context.fillStyle = frame.palette.headerBackground;
  context.fillRect(0, 0, frame.viewportWidth, frame.headerHeight);
  context.font = `700 11px ${frame.palette.fontFamily}`;
  context.fillStyle = frame.palette.text;
  context.save();
  context.beginPath();
  context.rect(
    rowNumberWidth,
    0,
    Math.max(0, frame.viewportWidth - rowNumberWidth),
    frame.headerHeight,
  );
  context.clip();
  for (const column of frame.columns) {
    context.strokeStyle = frame.palette.line;
    context.lineWidth = 1;
    context.strokeRect(column.x + 0.5, 0.5, column.width, frame.headerHeight);
    const indicator =
      column.sortDirection === "ascending" ? "↑" : column.sortDirection === "descending" ? "↓" : "";
    drawClippedText(
      context,
      column.label,
      column.x + 10,
      frame.headerHeight / 2,
      column.width - (indicator ? 40 : 20),
    );
    if (indicator) {
      context.fillStyle = frame.palette.accent;
      context.fillText(indicator, column.x + column.width - 20, frame.headerHeight / 2);
      context.fillStyle = frame.palette.text;
    }
  }
  context.restore();

  const rowNumberColumn = frame.rowNumberColumn;
  if (rowNumberColumn && frame.rowNumberText) {
    context.save();
    context.beginPath();
    context.rect(
      rowNumberColumn.x,
      frame.headerHeight,
      rowNumberColumn.width,
      Math.max(0, frame.viewportHeight - frame.headerHeight),
    );
    context.clip();
    context.font = `600 11px ${frame.palette.fontFamily}`;
    for (let rowOffset = 0; rowOffset < frame.rows.length; rowOffset++) {
      const row = frame.rows[rowOffset]!;
      context.fillStyle =
        row.viewOrdinal % 2 === 0 ? frame.palette.background : frame.palette.alternateBackground;
      context.fillRect(rowNumberColumn.x, row.y, rowNumberColumn.width, row.height);
      context.strokeStyle = frame.palette.line;
      context.lineWidth = 1;
      context.strokeRect(rowNumberColumn.x + 0.5, row.y + 0.5, rowNumberColumn.width, row.height);
      context.fillStyle = frame.palette.mutedText;
      drawClippedText(
        context,
        frame.rowNumberText[rowOffset]!,
        rowNumberColumn.x + 10,
        row.y + row.height / 2,
        rowNumberColumn.width - 20,
      );
    }
    context.restore();

    context.fillStyle = frame.palette.headerBackground;
    context.fillRect(0, 0, rowNumberColumn.width, frame.headerHeight);
    context.strokeStyle = frame.palette.line;
    context.lineWidth = 1;
    context.strokeRect(rowNumberColumn.x + 0.5, 0.5, rowNumberColumn.width, frame.headerHeight);
    context.font = `700 11px ${frame.palette.fontFamily}`;
    context.fillStyle = frame.palette.mutedText;
    drawClippedText(
      context,
      rowNumberColumn.label,
      rowNumberColumn.x + 10,
      frame.headerHeight / 2,
      rowNumberColumn.width - 20,
    );
  }
}

function drawClippedText(
  context: GridPaintContext,
  value: string,
  x: number,
  y: number,
  maxWidth: number,
): void {
  if (maxWidth <= 0) return;
  if (context.measureText(value).width <= maxWidth) {
    context.fillText(value, x, y);
    return;
  }
  let lower = 0;
  let upper = value.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (context.measureText(`${value.slice(0, middle)}…`).width <= maxWidth) lower = middle;
    else upper = middle - 1;
  }
  context.fillText(`${value.slice(0, lower)}…`, x, y);
}

function setCanvasCssSize(canvas: GridPaintCanvas, width: number, height: number): void {
  if (!("style" in canvas)) return;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}
