export interface VisibleRange {
  readonly start: number;
  readonly end: number;
}

export interface GridLayout {
  readonly rowHeight: number;
  readonly headerHeight: number;
  readonly columnWidth: number;
  readonly overscanRows: number;
  readonly overscanColumns: number;
}

/** Immutable horizontal geometry for the installed data columns. */
export interface GridColumnLayout {
  readonly widths: readonly number[];
  readonly offsets: readonly number[];
  readonly totalWidth: number;
  readonly revision: number;
}

export interface VisibleGridRange {
  readonly rows: VisibleRange;
  readonly columns: VisibleRange;
}

export interface GridHit {
  readonly rowIndex: number;
  readonly columnIndex: number;
}

export interface LogicalScrollGeometry {
  /** Complete logical content height, including the header. */
  readonly logicalExtent: number;
  /** Bounded DOM spacer height used by the browser scrollport. */
  readonly physicalExtent: number;
  readonly logicalMax: number;
  readonly physicalMax: number;
  readonly compressed: boolean;
}

/**
 * Browser engines clamp very tall scrolling elements at implementation-defined
 * limits. Keep the DOM extent comfortably below the lowest supported limit and
 * map it onto the complete logical row range.
 */
export const MAX_GRID_SCROLL_EXTENT = 16_000_000;

export function logicalScrollGeometry(
  rowCount: number,
  rowHeight: number,
  headerHeight: number,
  viewportHeight: number,
  maximumPhysicalExtent = MAX_GRID_SCROLL_EXTENT,
): LogicalScrollGeometry {
  const logicalExtent = Math.max(1, headerHeight + rowCount * rowHeight);
  const physicalExtent = Math.min(logicalExtent, Math.max(viewportHeight, maximumPhysicalExtent));
  return {
    logicalExtent,
    physicalExtent,
    logicalMax: Math.max(0, logicalExtent - viewportHeight),
    physicalMax: Math.max(0, physicalExtent - viewportHeight),
    compressed: physicalExtent < logicalExtent,
  };
}

export function physicalToLogicalScroll(
  physicalOffset: number,
  geometry: LogicalScrollGeometry,
): number {
  if (geometry.logicalMax === 0 || geometry.physicalMax === 0) return 0;
  const bounded = Math.max(0, Math.min(geometry.physicalMax, physicalOffset));
  return (bounded / geometry.physicalMax) * geometry.logicalMax;
}

export function logicalToPhysicalScroll(
  logicalOffset: number,
  geometry: LogicalScrollGeometry,
): number {
  if (geometry.logicalMax === 0 || geometry.physicalMax === 0) return 0;
  const bounded = Math.max(0, Math.min(geometry.logicalMax, logicalOffset));
  return (bounded / geometry.logicalMax) * geometry.physicalMax;
}

export function visibleItemRange(
  scrollOffset: number,
  viewportSize: number,
  itemSize: number,
  itemCount: number,
  overscan: number,
): VisibleRange {
  if (itemCount === 0 || viewportSize <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollOffset) / itemSize);
  const last = Math.ceil((Math.max(0, scrollOffset) + viewportSize) / itemSize);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(itemCount, last + overscan),
  };
}

export function visibleGridRange(
  scrollTop: number,
  scrollLeft: number,
  viewportWidth: number,
  viewportHeight: number,
  rowCount: number,
  columnCount: number,
  layout: GridLayout,
  columns?: GridColumnLayout,
): VisibleGridRange {
  return {
    rows: visibleItemRange(
      scrollTop,
      Math.max(0, viewportHeight - layout.headerHeight),
      layout.rowHeight,
      rowCount,
      layout.overscanRows,
    ),
    columns: columns
      ? visibleColumnRange(scrollLeft, viewportWidth, columns, layout.overscanColumns)
      : visibleItemRange(
          scrollLeft,
          viewportWidth,
          layout.columnWidth,
          columnCount,
          layout.overscanColumns,
        ),
  };
}

export function hitTestGrid(
  x: number,
  y: number,
  scrollTop: number,
  scrollLeft: number,
  rowCount: number,
  columnCount: number,
  layout: GridLayout,
  columns?: GridColumnLayout,
): GridHit | null {
  if (x < 0 || y < layout.headerHeight) return null;
  const rowIndex = Math.floor((scrollTop + y - layout.headerHeight) / layout.rowHeight);
  const columnIndex = columns
    ? columnIndexAtOffset(scrollLeft + x, columns)
    : Math.floor((scrollLeft + x) / layout.columnWidth);
  if (rowIndex < 0 || rowIndex >= rowCount || columnIndex < 0 || columnIndex >= columnCount) {
    return null;
  }
  return { rowIndex, columnIndex };
}

export function createGridColumnLayout(widths: readonly number[], revision = 0): GridColumnLayout {
  const copiedWidths = new Array<number>(widths.length);
  const offsets = new Array<number>(widths.length);
  let totalWidth = 0;
  for (let index = 0; index < widths.length; index++) {
    const width = widths[index];
    if (!Number.isFinite(width) || width <= 0) {
      throw new RangeError(`Column width ${index} must be a positive finite number.`);
    }
    offsets[index] = totalWidth;
    copiedWidths[index] = width;
    totalWidth += width;
  }
  return Object.freeze({
    widths: Object.freeze(copiedWidths),
    offsets: Object.freeze(offsets),
    totalWidth,
    revision,
  });
}

export function visibleColumnRange(
  scrollOffset: number,
  viewportSize: number,
  columns: GridColumnLayout,
  overscan: number,
): VisibleRange {
  const count = columns.widths.length;
  if (count === 0 || viewportSize <= 0) return { start: 0, end: 0 };
  const startOffset = Math.max(0, scrollOffset);
  const endOffset = startOffset + viewportSize;
  const first = firstColumnEndingAfter(startOffset, columns);
  const end = firstColumnStartingAtOrAfter(endOffset, columns);
  return {
    start: Math.max(0, Math.min(count, first) - overscan),
    end: Math.min(count, Math.max(first, end) + overscan),
  };
}

export function columnIndexAtOffset(offset: number, columns: GridColumnLayout): number {
  if (offset < 0 || offset >= columns.totalWidth || columns.widths.length === 0) return -1;
  const index = firstColumnEndingAfter(offset, columns);
  return index < columns.widths.length ? index : -1;
}

function firstColumnEndingAfter(offset: number, columns: GridColumnLayout): number {
  let lower = 0;
  let upper = columns.widths.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const end = columns.offsets[middle]! + columns.widths[middle]!;
    if (end > offset) upper = middle;
    else lower = middle + 1;
  }
  return lower;
}

function firstColumnStartingAtOrAfter(offset: number, columns: GridColumnLayout): number {
  let lower = 0;
  let upper = columns.offsets.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (columns.offsets[middle]! >= offset) upper = middle;
    else lower = middle + 1;
  }
  return lower;
}

export function alignedScrollOffset(
  itemStart: number,
  itemSize: number,
  currentOffset: number,
  viewportSize: number,
  align: "start" | "center" | "end" | "nearest",
): number {
  const itemEnd = itemStart + itemSize;
  const viewportEnd = currentOffset + viewportSize;
  if (align === "nearest") {
    if (itemStart >= currentOffset && itemEnd <= viewportEnd) return currentOffset;
    return itemStart < currentOffset ? itemStart : itemEnd - viewportSize;
  }
  if (align === "center") return itemStart - (viewportSize - itemSize) / 2;
  if (align === "end") return itemEnd - viewportSize;
  return itemStart;
}

export function finiteDimension(value: number, fallback: number, minimum: number): number {
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

export function finiteOverscan(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
