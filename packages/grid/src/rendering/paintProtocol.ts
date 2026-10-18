import type { GridPalette } from "./mainRenderer.js";

export type GridPaintCanvas = HTMLCanvasElement | OffscreenCanvas;
export type GridPaintContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type GridPaintPalette = GridPalette;

/** A committed grid state represented by one paint frame. */
export interface GridPaintRevision {
  readonly datasetId: string | null;
  readonly dataRevision: number;
  readonly viewRevision: number;
  readonly presentationRevision: number;
}

/** One visible column in viewport-local CSS-pixel coordinates. */
export interface GridPaintColumn {
  readonly columnIndex: number;
  readonly columnId: string;
  readonly label: string;
  readonly x: number;
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly sortDirection?: "ascending" | "descending";
}

/** Presentation-only pinned gutter; it never enters typed data operations. */
export interface GridPaintRowNumberColumn {
  readonly label: string;
  readonly accessibleLabel: string;
  readonly x: number;
  readonly width: number;
}

/** One visible row in viewport-local CSS-pixel coordinates. */
export interface GridPaintRow {
  readonly viewOrdinal: number;
  readonly y: number;
  readonly height: number;
}

export const GRID_PAINT_CELL_SELECTED = 1;

/**
 * A bounded, already-formatted viewport frame.
 *
 * Cells use row-major order. The paint worker deliberately receives no full
 * dataset in this first transport slice: formatting and active-view work still
 * happen on the host thread, while Canvas2D commands run off-thread.
 */
export interface GridPaintFrame {
  readonly frameId: number;
  readonly commitToken: string;
  readonly revision: GridPaintRevision;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly pixelRatio: number;
  readonly headerHeight: number;
  readonly rowNumberColumn?: GridPaintRowNumberColumn;
  readonly rowNumberText?: readonly string[];
  readonly columns: readonly GridPaintColumn[];
  readonly rows: readonly GridPaintRow[];
  readonly cellText: readonly string[];
  /** One byte per cell. Zero uses ordinary text; one uses muted text. */
  readonly cellTone?: Uint8Array;
  /** Bit flags per cell. Currently only {@link GRID_PAINT_CELL_SELECTED}. */
  readonly cellState?: Uint8Array;
  /** Row-major cell offset, or absent when focus is outside this frame. */
  readonly focusedCell?: number;
  readonly palette: GridPaintPalette;
}

export interface GridPaintInitMessage {
  readonly type: "init";
  readonly canvas: GridPaintCanvas;
}

export interface GridPaintPrepareMessage {
  readonly type: "prepare";
  readonly frame: GridPaintFrame;
}

/** Publish a previously prepared candidate onto the transferred visible canvas. */
export interface GridPaintCommitMessage {
  readonly type: "commit";
  readonly frameId: number;
  readonly commitToken: string;
}

export interface GridPaintDisposeMessage {
  readonly type: "dispose";
}

export type GridPaintInputMessage =
  GridPaintInitMessage | GridPaintPrepareMessage | GridPaintCommitMessage | GridPaintDisposeMessage;

export interface GridPaintReadyMessage {
  readonly type: "ready";
}

export interface GridPaintPreparedMessage {
  readonly type: "prepared";
  readonly frameId: number;
  readonly commitToken: string;
  readonly revision: GridPaintRevision;
  readonly paintedCells: number;
  readonly durationMs: number;
}

/** The exact prepared candidate is now visible on the presentation canvas. */
export interface GridPaintPresentedMessage {
  readonly type: "presented";
  readonly frameId: number;
  readonly commitToken: string;
  readonly revision: GridPaintRevision;
  readonly paintedCells: number;
  readonly durationMs: number;
}

export interface GridPaintDroppedMessage {
  readonly type: "dropped";
  readonly frameId: number;
  readonly commitToken: string;
  readonly reason: "stale-frame" | "unprepared-commit";
}

export interface GridPaintDisposedMessage {
  readonly type: "disposed";
}

export interface SerializedGridPaintError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

export interface GridPaintErrorMessage {
  readonly type: "initError" | "runtimeError";
  readonly error: SerializedGridPaintError;
}

export type GridPaintOutputMessage =
  | GridPaintReadyMessage
  | GridPaintPreparedMessage
  | GridPaintPresentedMessage
  | GridPaintDroppedMessage
  | GridPaintDisposedMessage
  | GridPaintErrorMessage;

export interface GridPaintLimits {
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxCells: number;
  readonly maxTextCodeUnits: number;
  readonly maxViewportDimension: number;
  readonly maxPixelRatio: number;
  readonly maxPhysicalPixels: number;
}

/** Limits are intentionally far above an ordinary overscanned viewport. */
export const DEFAULT_GRID_PAINT_LIMITS: GridPaintLimits = Object.freeze({
  maxRows: 4_096,
  maxColumns: 512,
  maxCells: 131_072,
  maxTextCodeUnits: 8 * 1024 * 1024,
  maxViewportDimension: 16_384,
  maxPixelRatio: 4,
  maxPhysicalPixels: 67_108_864,
});

export function assertGridPaintFrame(
  frame: GridPaintFrame,
  limits: GridPaintLimits = DEFAULT_GRID_PAINT_LIMITS,
): void {
  if (!frame || typeof frame !== "object") throw new TypeError("Paint frame must be an object.");
  assertSafeNonNegativeInteger(frame.frameId, "frameId");
  if (typeof frame.commitToken !== "string" || frame.commitToken.length === 0) {
    throw new TypeError("Paint frame commitToken must be a non-empty string.");
  }
  assertRevision(frame.revision);
  assertFiniteRange(frame.viewportWidth, 0, limits.maxViewportDimension, "viewportWidth");
  assertFiniteRange(frame.viewportHeight, 0, limits.maxViewportDimension, "viewportHeight");
  assertFiniteRange(frame.pixelRatio, 0.25, limits.maxPixelRatio, "pixelRatio");
  assertFiniteRange(frame.headerHeight, 0, limits.maxViewportDimension, "headerHeight");
  if (!Array.isArray(frame.columns) || frame.columns.length > limits.maxColumns) {
    throw new RangeError(`Paint frame exceeds the ${limits.maxColumns}-column viewport limit.`);
  }
  if (!Array.isArray(frame.rows) || frame.rows.length > limits.maxRows) {
    throw new RangeError(`Paint frame exceeds the ${limits.maxRows}-row viewport limit.`);
  }
  const cellCount = frame.rows.length * frame.columns.length;
  if (!Number.isSafeInteger(cellCount) || cellCount > limits.maxCells) {
    throw new RangeError(`Paint frame exceeds the ${limits.maxCells}-cell viewport limit.`);
  }
  if (!Array.isArray(frame.cellText) || frame.cellText.length !== cellCount) {
    throw new RangeError(
      `Paint frame contains ${frame.cellText.length} cell labels; expected ${cellCount}.`,
    );
  }

  let textCodeUnits = 0;
  if ((frame.rowNumberColumn === undefined) !== (frame.rowNumberText === undefined)) {
    throw new RangeError("Paint frame row-number geometry and labels must be supplied together.");
  }
  if (frame.rowNumberColumn) {
    if (typeof frame.rowNumberColumn.label !== "string") {
      throw new TypeError("Paint frame row-number label must be a string.");
    }
    if (
      typeof frame.rowNumberColumn.accessibleLabel !== "string" ||
      frame.rowNumberColumn.accessibleLabel.length === 0
    ) {
      throw new TypeError("Paint frame row-number accessibleLabel must be non-empty.");
    }
    assertFinite(frame.rowNumberColumn.x, "rowNumberColumn.x");
    assertFiniteRange(
      frame.rowNumberColumn.width,
      Number.EPSILON,
      limits.maxViewportDimension,
      "rowNumberColumn.width",
    );
    textCodeUnits +=
      frame.rowNumberColumn.label.length + frame.rowNumberColumn.accessibleLabel.length;
  }
  if (frame.rowNumberText) {
    if (!Array.isArray(frame.rowNumberText) || frame.rowNumberText.length !== frame.rows.length) {
      throw new RangeError("Paint frame must contain one row-number label per visible row.");
    }
    for (let index = 0; index < frame.rowNumberText.length; index++) {
      const value = frame.rowNumberText[index];
      if (typeof value !== "string") {
        throw new TypeError(`rowNumberText[${index}] must be a string.`);
      }
      textCodeUnits += value.length;
    }
  }
  for (let index = 0; index < frame.columns.length; index++) {
    const column = frame.columns[index]!;
    assertSafeNonNegativeInteger(column.columnIndex, `columns[${index}].columnIndex`);
    if (typeof column.columnId !== "string" || column.columnId.length === 0) {
      throw new TypeError(`columns[${index}].columnId must be a non-empty string.`);
    }
    if (typeof column.label !== "string") {
      throw new TypeError(`columns[${index}].label must be a string.`);
    }
    assertFinite(column.x, `columns[${index}].x`);
    assertFiniteRange(
      column.width,
      Number.EPSILON,
      limits.maxViewportDimension,
      `columns[${index}].width`,
    );
    assertFiniteRange(
      column.minWidth,
      Number.EPSILON,
      limits.maxViewportDimension,
      `columns[${index}].minWidth`,
    );
    assertFiniteRange(
      column.maxWidth,
      column.minWidth,
      limits.maxViewportDimension,
      `columns[${index}].maxWidth`,
    );
    if (column.width < column.minWidth || column.width > column.maxWidth) {
      throw new RangeError(
        `columns[${index}].width must be within its declared minWidth and maxWidth.`,
      );
    }
    if (
      column.sortDirection !== undefined &&
      column.sortDirection !== "ascending" &&
      column.sortDirection !== "descending"
    ) {
      throw new TypeError(`columns[${index}].sortDirection is invalid.`);
    }
    textCodeUnits += column.columnId.length + column.label.length;
  }
  if (textCodeUnits > limits.maxTextCodeUnits) {
    throw new RangeError(
      `Paint frame exceeds the ${limits.maxTextCodeUnits}-code-unit text limit.`,
    );
  }
  for (let index = 0; index < frame.rows.length; index++) {
    const row = frame.rows[index]!;
    assertSafeNonNegativeInteger(row.viewOrdinal, `rows[${index}].viewOrdinal`);
    assertFinite(row.y, `rows[${index}].y`);
    assertFiniteRange(
      row.height,
      Number.EPSILON,
      limits.maxViewportDimension,
      `rows[${index}].height`,
    );
  }
  for (let index = 0; index < frame.cellText.length; index++) {
    const value = frame.cellText[index];
    if (typeof value !== "string") throw new TypeError(`cellText[${index}] must be a string.`);
    textCodeUnits += value.length;
    if (textCodeUnits > limits.maxTextCodeUnits) {
      throw new RangeError(
        `Paint frame exceeds the ${limits.maxTextCodeUnits}-code-unit text limit.`,
      );
    }
  }
  assertCellBytes(frame.cellTone, cellCount, "cellTone");
  assertCellBytes(frame.cellState, cellCount, "cellState");
  if (frame.focusedCell !== undefined) {
    assertSafeNonNegativeInteger(frame.focusedCell, "focusedCell");
    if (frame.focusedCell >= cellCount) {
      throw new RangeError("Paint frame focusedCell is outside its bounded cell payload.");
    }
  }
  assertPalette(frame.palette);

  const physicalWidth = Math.max(1, Math.round(frame.viewportWidth * frame.pixelRatio));
  const physicalHeight = Math.max(1, Math.round(frame.viewportHeight * frame.pixelRatio));
  if (physicalWidth * physicalHeight > limits.maxPhysicalPixels) {
    throw new RangeError(
      `Paint frame exceeds the ${limits.maxPhysicalPixels}-pixel physical canvas limit.`,
    );
  }
}

export function serializeGridPaintError(error: unknown): SerializedGridPaintError {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function assertRevision(revision: GridPaintRevision): void {
  if (!revision || typeof revision !== "object") {
    throw new TypeError("Paint frame revision must be an object.");
  }
  if (revision.datasetId !== null && typeof revision.datasetId !== "string") {
    throw new TypeError("Paint frame revision datasetId must be a string or null.");
  }
  assertSafeNonNegativeInteger(revision.dataRevision, "revision.dataRevision");
  assertSafeNonNegativeInteger(revision.viewRevision, "revision.viewRevision");
  assertSafeNonNegativeInteger(revision.presentationRevision, "revision.presentationRevision");
}

function assertCellBytes(value: Uint8Array | undefined, cellCount: number, name: string): void {
  if (value === undefined) return;
  if (!(value instanceof Uint8Array) || value.length !== cellCount) {
    throw new RangeError(`Paint frame ${name} must contain exactly ${cellCount} bytes.`);
  }
}

function assertPalette(palette: GridPaintPalette): void {
  if (!palette || typeof palette !== "object") throw new TypeError("Paint palette is required.");
  for (const key of [
    "background",
    "alternateBackground",
    "headerBackground",
    "line",
    "text",
    "mutedText",
    "accent",
    "selection",
    "fontFamily",
  ] as const) {
    if (typeof palette[key] !== "string" || palette[key].length === 0) {
      throw new TypeError(`Paint palette ${key} must be a non-empty string.`);
    }
  }
}

function assertSafeNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Paint frame ${name} must be a non-negative safe integer.`);
  }
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`Paint frame ${name} must be finite.`);
}

function assertFiniteRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`Paint frame ${name} must be between ${minimum} and ${maximum}.`);
  }
}
