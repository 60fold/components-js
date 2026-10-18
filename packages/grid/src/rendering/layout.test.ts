import { describe, expect, it } from "vitest";
import {
  alignedScrollOffset,
  columnIndexAtOffset,
  createGridColumnLayout,
  hitTestGrid,
  logicalScrollGeometry,
  logicalToPhysicalScroll,
  physicalToLogicalScroll,
  visibleGridRange,
  visibleColumnRange,
  visibleItemRange,
  type GridLayout,
} from "./layout";

const layout: GridLayout = {
  rowHeight: 30,
  headerHeight: 38,
  columnWidth: 160,
  overscanRows: 2,
  overscanColumns: 1,
};

describe("grid layout", () => {
  it("maps a huge logical row range onto a bounded browser scroll extent", () => {
    const geometry = logicalScrollGeometry(10_000_000, 30, 38, 620);

    expect(geometry.logicalExtent).toBe(300_000_038);
    expect(geometry.physicalExtent).toBe(16_000_000);
    expect(geometry.compressed).toBe(true);
    expect(physicalToLogicalScroll(0, geometry)).toBe(0);
    expect(physicalToLogicalScroll(geometry.physicalMax, geometry)).toBe(geometry.logicalMax);
    expect(logicalToPhysicalScroll(geometry.logicalMax, geometry)).toBe(geometry.physicalMax);

    const logicalMiddle = geometry.logicalMax / 2;
    expect(
      physicalToLogicalScroll(logicalToPhysicalScroll(logicalMiddle, geometry), geometry),
    ).toBe(logicalMiddle);
  });

  it("keeps ordinary datasets on a one-to-one physical scroll range", () => {
    const geometry = logicalScrollGeometry(100_000, 30, 38, 620);

    expect(geometry.compressed).toBe(false);
    expect(geometry.physicalExtent).toBe(geometry.logicalExtent);
    expect(physicalToLogicalScroll(45_000, geometry)).toBe(45_000);
    expect(logicalToPhysicalScroll(45_000, geometry)).toBe(45_000);
  });

  it("computes bounded half-open visible ranges with overscan", () => {
    expect(visibleItemRange(90, 90, 30, 10, 1)).toEqual({ start: 2, end: 7 });
    expect(visibleItemRange(0, 300, 30, 0, 2)).toEqual({ start: 0, end: 0 });
    expect(visibleGridRange(300, 320, 640, 338, 100, 12, layout)).toEqual({
      rows: { start: 8, end: 22 },
      columns: { start: 1, end: 7 },
    });
  });

  it("includes the final row when the viewport exposes only part of it", () => {
    expect(visibleItemRange(0, 31, 30, 10, 0)).toEqual({ start: 0, end: 2 });
  });

  it("hit-tests body cells while excluding headers and overflow", () => {
    expect(hitTestGrid(12, 10, 0, 0, 5, 3, layout)).toBeNull();
    expect(hitTestGrid(10, 40, 60, 160, 5, 3, layout)).toEqual({
      rowIndex: 2,
      columnIndex: 1,
    });
    expect(hitTestGrid(800, 40, 0, 0, 5, 3, layout)).toBeNull();
  });

  it("uses prefix-sum column geometry for visibility and hit testing", () => {
    const columns = createGridColumnLayout([80, 220, 120, 300], 4);

    expect(columns).toMatchObject({
      widths: [80, 220, 120, 300],
      offsets: [0, 80, 300, 420],
      totalWidth: 720,
      revision: 4,
    });
    expect(visibleColumnRange(100, 250, columns, 0)).toEqual({ start: 1, end: 3 });
    expect(columnIndexAtOffset(79, columns)).toBe(0);
    expect(columnIndexAtOffset(80, columns)).toBe(1);
    expect(columnIndexAtOffset(720, columns)).toBe(-1);
    expect(hitTestGrid(15, 40, 0, 295, 5, 4, layout, columns)).toEqual({
      rowIndex: 0,
      columnIndex: 2,
    });
  });

  it("aligns items without moving already visible cells", () => {
    expect(alignedScrollOffset(120, 30, 90, 120, "nearest")).toBe(90);
    expect(alignedScrollOffset(240, 30, 90, 120, "nearest")).toBe(150);
    expect(alignedScrollOffset(240, 30, 90, 120, "center")).toBe(195);
    expect(alignedScrollOffset(240, 30, 90, 120, "start")).toBe(240);
  });
});
