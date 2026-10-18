import { describe, expect, it } from "vitest";
import { formatCellValue } from "./formatCell";

describe("formatCellValue", () => {
  it("formats nulls, booleans, bigints, and special numbers deterministically", () => {
    expect(formatCellValue(null, { kind: "number" })).toBe("—");
    expect(formatCellValue(true, { kind: "boolean" })).toBe("true");
    expect(formatCellValue(42n, { kind: "integer" })).toBe("42");
    expect(formatCellValue(Number.NaN, { kind: "number" })).toBe("NaN");
    expect(formatCellValue(Number.POSITIVE_INFINITY, { kind: "number" })).toBe("+∞");
    expect(formatCellValue(Number.NEGATIVE_INFINITY, { kind: "number" })).toBe("−∞");
    expect(formatCellValue(-0, { kind: "number" })).toBe("−0");
  });

  it("normalizes supported timestamp units to UTC ISO strings", () => {
    expect(formatCellValue(0, { kind: "timestamp", timestampUnit: "ms" })).toBe(
      "1970-01-01T00:00:00.000Z",
    );
    expect(formatCellValue(1_000_000_000n, { kind: "timestamp", timestampUnit: "ns" })).toBe(
      "1970-01-01T00:00:01.000Z",
    );
  });
});
