import { GRID_PAINT_CELL_SELECTED, type GridPaintFrame } from "../rendering/paintProtocol.js";

let nextSemanticGridId = 0;

export class SemanticGrid {
  readonly element: HTMLDivElement;
  private readonly instanceId = `sixtyfold-grid-${++nextSemanticGridId}`;
  private editableColumns = new Set<string>();

  constructor(ariaLabel: string) {
    const element = document.createElement("div");
    element.dataset.gridSemantics = "";
    element.setAttribute("role", "grid");
    element.setAttribute("aria-label", ariaLabel);
    element.setAttribute("aria-readonly", "true");
    element.setAttribute("aria-multiselectable", "true");
    element.tabIndex = 0;
    Object.assign(element.style, {
      position: "absolute",
      inset: "0 auto auto 0",
      overflow: "hidden",
      color: "transparent",
      background: "transparent",
      pointerEvents: "none",
      outline: "none",
    });
    this.element = element;
  }

  setViewportSize(width: number, height: number): void {
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
  }

  setEditableColumns(columnIds: readonly string[]): void {
    this.editableColumns = new Set(columnIds);
    this.element.setAttribute("aria-readonly", String(this.editableColumns.size === 0));
  }

  /** Installs the semantic twin of one renderer-confirmed paint frame. */
  updateFrame(frame: GridPaintFrame, totalRows: number, totalColumns: number): void {
    const activeElement = this.element.ownerDocument.activeElement;
    const focusedControl =
      activeElement instanceof HTMLElement && this.element.contains(activeElement)
        ? activeElement.dataset.gridSortButton !== undefined
          ? { kind: "sort" as const, columnId: activeElement.dataset.gridColumnId }
          : activeElement.dataset.gridResizeHandle !== undefined
            ? { kind: "resize" as const, columnId: activeElement.dataset.gridColumnId }
            : null
        : null;
    const hasRowNumbers = frame.rowNumberColumn !== undefined && frame.rowNumberText !== undefined;
    this.element.setAttribute("aria-rowcount", String(totalRows + 1));
    this.element.setAttribute("aria-colcount", String(totalColumns + (hasRowNumbers ? 1 : 0)));
    const fragment = document.createDocumentFragment();
    const header = document.createElement("div");
    header.setAttribute("role", "row");
    header.setAttribute("aria-rowindex", "1");
    Object.assign(header.style, {
      position: "absolute",
      inset: "0 0 auto 0",
      height: `${frame.headerHeight}px`,
      pointerEvents: "none",
    });
    if (frame.rowNumberColumn) {
      const corner = document.createElement("div");
      corner.dataset.gridRowNumberHeader = "";
      corner.setAttribute("role", "columnheader");
      corner.setAttribute("aria-colindex", "1");
      corner.setAttribute("aria-label", frame.rowNumberColumn.accessibleLabel);
      corner.textContent = frame.rowNumberColumn.label;
      Object.assign(corner.style, {
        position: "absolute",
        left: `${frame.rowNumberColumn.x}px`,
        top: "0",
        width: `${frame.rowNumberColumn.width}px`,
        height: `${frame.headerHeight}px`,
        zIndex: "2",
        pointerEvents: "auto",
        touchAction: "pan-x pan-y",
      });
      header.append(corner);
    }
    for (const column of frame.columns) {
      const cell = document.createElement("div");
      cell.dataset.gridColumnId = column.columnId;
      cell.setAttribute("role", "columnheader");
      cell.setAttribute("aria-colindex", String(column.columnIndex + (hasRowNumbers ? 2 : 1)));
      cell.setAttribute("aria-label", column.label);
      if (column.sortDirection) cell.setAttribute("aria-sort", column.sortDirection);
      Object.assign(cell.style, {
        position: "absolute",
        left: `${column.x}px`,
        top: "0",
        width: `${column.width}px`,
        height: `${frame.headerHeight}px`,
        zIndex: "1",
        pointerEvents: "none",
      });

      const sortButton = document.createElement("button");
      sortButton.type = "button";
      sortButton.dataset.gridSortButton = "";
      sortButton.dataset.gridColumnId = column.columnId;
      sortButton.setAttribute("aria-label", column.label);
      sortButton.textContent = column.label;
      Object.assign(sortButton.style, {
        position: "absolute",
        inset: "0 16px 0 0",
        width: "auto",
        padding: "0",
        border: "0",
        color: "transparent",
        background: "transparent",
        font: "inherit",
        cursor: "pointer",
        touchAction: "manipulation",
        pointerEvents: "auto",
      });
      cell.append(sortButton);

      const resizeHandle = document.createElement("div");
      resizeHandle.dataset.gridResizeHandle = "";
      resizeHandle.dataset.gridColumnId = column.columnId;
      resizeHandle.setAttribute("role", "separator");
      resizeHandle.setAttribute("aria-label", column.label);
      resizeHandle.setAttribute("aria-orientation", "vertical");
      resizeHandle.setAttribute("aria-valuemin", String(Math.round(column.minWidth)));
      resizeHandle.setAttribute("aria-valuemax", String(Math.round(column.maxWidth)));
      resizeHandle.setAttribute("aria-valuenow", String(Math.round(column.width)));
      resizeHandle.tabIndex = 0;
      Object.assign(resizeHandle.style, {
        position: "absolute",
        top: "0",
        right: "0",
        width: "20px",
        height: `${frame.headerHeight}px`,
        zIndex: "3",
        cursor: "col-resize",
        touchAction: "none",
        pointerEvents: "auto",
      });
      cell.append(resizeHandle);
      header.append(cell);
    }
    fragment.append(header);

    let activeId: string | null = null;
    for (let rowOffset = 0; rowOffset < frame.rows.length; rowOffset++) {
      const rowData = frame.rows[rowOffset]!;
      const row = document.createElement("div");
      row.setAttribute("role", "row");
      row.setAttribute("aria-rowindex", String(rowData.viewOrdinal + 2));
      if (frame.rowNumberColumn && frame.rowNumberText) {
        const rowNumber = document.createElement("div");
        rowNumber.dataset.gridRowNumber = "";
        rowNumber.setAttribute("role", "rowheader");
        rowNumber.setAttribute("aria-colindex", "1");
        rowNumber.textContent = frame.rowNumberText[rowOffset] ?? "";
        row.append(rowNumber);
      }
      for (let columnOffset = 0; columnOffset < frame.columns.length; columnOffset++) {
        const column = frame.columns[columnOffset]!;
        const offset = rowOffset * frame.columns.length + columnOffset;
        const cell = document.createElement("div");
        cell.dataset.gridColumnId = column.columnId;
        cell.dataset.gridViewOrdinal = String(rowData.viewOrdinal);
        cell.setAttribute("role", "gridcell");
        cell.setAttribute("aria-colindex", String(column.columnIndex + (hasRowNumbers ? 2 : 1)));
        cell.setAttribute("aria-readonly", String(!this.editableColumns.has(column.columnId)));
        cell.textContent = frame.cellText[offset] ?? "";
        if ((frame.cellState?.[offset] ?? 0) & GRID_PAINT_CELL_SELECTED) {
          cell.setAttribute("aria-selected", "true");
        }
        if (frame.focusedCell === offset) {
          activeId = `${this.instanceId}-r${rowData.viewOrdinal}-c${column.columnIndex}`;
          cell.id = activeId;
        }
        row.append(cell);
      }
      fragment.append(row);
    }
    this.element.replaceChildren(fragment);
    if (focusedControl?.columnId) {
      const selector =
        focusedControl.kind === "sort" ? "[data-grid-sort-button]" : "[data-grid-resize-handle]";
      const replacement = Array.from(this.element.querySelectorAll<HTMLElement>(selector)).find(
        (candidate) => candidate.dataset.gridColumnId === focusedControl.columnId,
      );
      (replacement ?? this.element).focus({ preventScroll: true });
    }
    if (activeId) this.element.setAttribute("aria-activedescendant", activeId);
    else this.element.removeAttribute("aria-activedescendant");
  }
}
