import { describe, expect, it } from "vitest";
import { GridDataStore } from "../data/store";
import { createGridColumnLayout } from "./layout";
import { buildRawGridPaintFrame } from "./rawPaintFrame";

describe("buildRawGridPaintFrame", () => {
  it("serializes only the visible raw cells with selection and focus state", () => {
    const store = new GridDataStore();
    const result = store.install({
      length: 3,
      columns: [
        {
          schema: { id: "value", kind: "number" },
          data: { kind: "number", values: { view: new Float64Array([10, 20, 30]) } },
        },
      ],
    });
    const payload = buildRawGridPaintFrame({
      frameId: 8,
      commitToken: "commit-8",
      revision: {
        datasetId: result.datasetId,
        dataRevision: 0,
        viewRevision: 0,
        presentationRevision: 8,
      },
      store,
      viewportWidth: 200,
      viewportHeight: 90,
      pixelRatio: 1,
      scrollTop: 30,
      scrollLeft: 0,
      range: { rows: { start: 1, end: 3 }, columns: { start: 0, end: 1 } },
      layout: {
        rowHeight: 30,
        headerHeight: 30,
        columnWidth: 160,
        overscanRows: 0,
        overscanColumns: 0,
      },
      columnLayout: createGridColumnLayout([160], 3),
      rowNumberWidth: 80,
      rowNumberLabel: "Row number",
      minColumnWidth: 88,
      maxColumnWidth: 640,
      palette: {
        background: "#000",
        alternateBackground: "#111",
        headerBackground: "#222",
        line: "#333",
        text: "#fff",
        mutedText: "#888",
        accent: "#fc0",
        selection: "#444",
        fontFamily: "monospace",
      },
      selection: {
        kind: "range",
        datasetId: result.datasetId,
        viewRevision: 0,
        anchor: { rowId: 1, columnId: "value" },
        focus: { rowId: 2, columnId: "value" },
      },
      focusedRowIndex: 2,
      focusedColumnIndex: 0,
    });

    expect(payload.rows).toEqual([
      { viewOrdinal: 1, y: 30, height: 30 },
      { viewOrdinal: 2, y: 60, height: 30 },
    ]);
    expect(payload.rowNumberColumn).toEqual({
      label: "#",
      accessibleLabel: "Row number",
      x: 0,
      width: 80,
    });
    expect(payload.rowNumberText).toEqual(["2", "3"]);
    expect(payload.columns).toEqual([
      {
        columnIndex: 0,
        columnId: "value",
        label: "value",
        x: 80,
        width: 160,
        minWidth: 88,
        maxWidth: 640,
      },
    ]);
    expect(payload.cellText).toEqual(["20", "30"]);
    expect([...payload.cellState!]).toEqual([1, 1]);
    expect(payload.focusedCell).toBe(1);
  });
});
