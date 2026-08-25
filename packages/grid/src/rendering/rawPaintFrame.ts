import type { GridDataStore } from "../data/store.js";
import type { GridRangeSelection } from "../types.js";
import type { GridPublishedView } from "../view/activeView.js";
import { formatCellValue } from "./formatCell.js";
import type { GridColumnLayout, GridLayout, VisibleGridRange } from "./layout.js";
import {
  GRID_PAINT_CELL_SELECTED,
  type GridPaintFrame,
  type GridPaintPalette,
  type GridPaintRevision,
} from "./paintProtocol.js";

export interface BuildRawGridPaintFrameOptions {
  readonly frameId: number;
  readonly commitToken: string;
  readonly revision: GridPaintRevision;
  readonly store: GridDataStore;
  readonly view?: GridPublishedView | null;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly pixelRatio: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly range: VisibleGridRange;
  readonly layout: GridLayout;
  readonly columnLayout: GridColumnLayout;
  readonly rowNumberWidth: number;
  readonly rowNumberLabel: string;
  readonly minColumnWidth: number;
  readonly maxColumnWidth: number;
  readonly palette: GridPaintPalette;
  readonly selection: GridRangeSelection | null;
  readonly focusedRowIndex: number;
  readonly focusedColumnIndex: number;
  /** Candidate-only accessor used while an accepted sparse edit awaits publication. */
  readonly cellAt?: (
    physicalRow: number,
    columnIndex: number,
  ) => ReturnType<GridDataStore["cellAt"]>;
}

/** Builds the bounded paint payload for the current unpermuted raw view. */
export function buildRawGridPaintFrame(options: BuildRawGridPaintFrameOptions): GridPaintFrame {
  const {
    store,
    view,
    range,
    layout,
    columnLayout,
    scrollTop,
    scrollLeft,
    selection,
    focusedRowIndex,
    focusedColumnIndex,
  } = options;
  const primarySort = view?.spec.sort?.[0];
  const columns = [];
  for (let columnIndex = range.columns.start; columnIndex < range.columns.end; columnIndex++) {
    const descriptor = store.columnDescriptorAt(columnIndex);
    columns.push({
      columnIndex,
      columnId: descriptor.schema.id,
      label: descriptor.schema.id,
      x: options.rowNumberWidth + columnLayout.offsets[columnIndex]! - scrollLeft,
      width: columnLayout.widths[columnIndex]!,
      minWidth: options.minColumnWidth,
      maxWidth: options.maxColumnWidth,
      ...(primarySort?.columnId === descriptor.schema.id
        ? { sortDirection: primarySort.direction }
        : {}),
    });
  }
  const rows = [];
  for (let rowIndex = range.rows.start; rowIndex < range.rows.end; rowIndex++) {
    rows.push({
      viewOrdinal: rowIndex,
      y: layout.headerHeight + rowIndex * layout.rowHeight - scrollTop,
      height: layout.rowHeight,
    });
  }

  const cellCount = rows.length * columns.length;
  const rowNumberText = rows.map((row) => String(row.viewOrdinal + 1));
  const cellText = new Array<string>(cellCount);
  const cellTone = new Uint8Array(cellCount);
  const cellState = new Uint8Array(cellCount);
  const selectionBounds = selection ? resolveSelectionBounds(store, view, selection) : null;
  const cellAt =
    options.cellAt ??
    ((physicalRow: number, columnIndex: number) => store.cellAt(physicalRow, columnIndex));
  let focusedCell: number | undefined;
  for (let rowOffset = 0; rowOffset < rows.length; rowOffset++) {
    const rowIndex = rows[rowOffset]!.viewOrdinal;
    const physicalRow = view?.physicalRowAt(rowIndex) ?? rowIndex;
    for (let columnOffset = 0; columnOffset < columns.length; columnOffset++) {
      const columnIndex = columns[columnOffset]!.columnIndex;
      const cellOffset = rowOffset * columns.length + columnOffset;
      const descriptor = store.columnDescriptorAt(columnIndex);
      const text = formatCellValue(cellAt(physicalRow, columnIndex), {
        kind: descriptor.schema.kind,
        ...(descriptor.timestampUnit ? { timestampUnit: descriptor.timestampUnit } : {}),
      });
      cellText[cellOffset] = text;
      if (text === "—") cellTone[cellOffset] = 1;
      if (
        selectionBounds &&
        rowIndex >= selectionBounds.rowStart &&
        rowIndex <= selectionBounds.rowEnd &&
        columnIndex >= selectionBounds.columnStart &&
        columnIndex <= selectionBounds.columnEnd
      ) {
        cellState[cellOffset] |= GRID_PAINT_CELL_SELECTED;
      }
      if (rowIndex === focusedRowIndex && columnIndex === focusedColumnIndex) {
        focusedCell = cellOffset;
      }
    }
  }

  return {
    frameId: options.frameId,
    commitToken: options.commitToken,
    revision: options.revision,
    viewportWidth: options.viewportWidth,
    viewportHeight: options.viewportHeight,
    pixelRatio: options.pixelRatio,
    headerHeight: layout.headerHeight,
    rowNumberColumn: {
      label: "#",
      accessibleLabel: options.rowNumberLabel,
      x: 0,
      width: options.rowNumberWidth,
    },
    rowNumberText,
    columns,
    rows,
    cellText,
    cellTone,
    cellState,
    ...(focusedCell === undefined ? {} : { focusedCell }),
    palette: options.palette,
  };
}

function resolveSelectionBounds(
  store: GridDataStore,
  view: GridPublishedView | null | undefined,
  selection: GridRangeSelection,
) {
  if (
    selection.datasetId !== store.datasetId ||
    selection.viewRevision !== (view?.viewRevision ?? 0)
  ) {
    return null;
  }
  const anchorRow = view
    ? view.viewOrdinalOfRowId(selection.anchor.rowId, store)
    : store.rowIndexOf(selection.anchor.rowId);
  const focusRow = view
    ? view.viewOrdinalOfRowId(selection.focus.rowId, store)
    : store.rowIndexOf(selection.focus.rowId);
  const anchorColumn = store.columnIndexOf(selection.anchor.columnId);
  const focusColumn = store.columnIndexOf(selection.focus.columnId);
  if (anchorRow < 0 || focusRow < 0 || anchorColumn < 0 || focusColumn < 0) return null;
  return {
    rowStart: Math.min(anchorRow, focusRow),
    rowEnd: Math.max(anchorRow, focusRow),
    columnStart: Math.min(anchorColumn, focusColumn),
    columnEnd: Math.max(anchorColumn, focusColumn),
  };
}
