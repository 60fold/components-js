import { describe, expect, it } from "vitest";
import type { GridPaintFrame } from "../rendering/paintProtocol";
import { SemanticGrid } from "./semanticGrid";

const frame: GridPaintFrame = {
  frameId: 1,
  commitToken: "semantic-frame-1",
  revision: {
    datasetId: "dataset-1",
    dataRevision: 0,
    viewRevision: 0,
    presentationRevision: 1,
  },
  viewportWidth: 160,
  viewportHeight: 90,
  pixelRatio: 1,
  headerHeight: 30,
  columns: [
    {
      columnIndex: 0,
      columnId: "value",
      label: "Value",
      x: 0,
      width: 160,
      minWidth: 80,
      maxWidth: 320,
    },
  ],
  rows: [
    { viewOrdinal: 0, y: 30, height: 30 },
    { viewOrdinal: 999_999, y: 60, height: 30 },
  ],
  cellText: ["first", "last"],
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
};

describe("SemanticGrid", () => {
  it("reserves ARIA row index 1 for the header and offsets virtual view ordinals by two", () => {
    const semantics = new SemanticGrid("Dataset");

    semantics.updateFrame(frame, 1_000_000, 1);

    expect(semantics.element.getAttribute("aria-rowcount")).toBe("1000001");
    expect(
      [...semantics.element.querySelectorAll<HTMLElement>('[role="row"]')].map((row) =>
        row.getAttribute("aria-rowindex"),
      ),
    ).toEqual(["1", "2", "1000001"]);
  });
});
