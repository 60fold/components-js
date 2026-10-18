import type { CellScalar, GridColumnKind } from "../types.js";

export interface CellFormatDescriptor {
  readonly kind: GridColumnKind;
  readonly timestampUnit?: "s" | "ms" | "us" | "ns";
}

export function formatCellValue(
  value: CellScalar | null,
  descriptor: CellFormatDescriptor,
): string {
  if (value === null) return "—";
  if (descriptor.kind === "timestamp") {
    return formatTimestamp(value, descriptor.timestampUnit ?? "ms");
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Number.POSITIVE_INFINITY) return "+∞";
    if (value === Number.NEGATIVE_INFINITY) return "−∞";
    if (Object.is(value, -0)) return "−0";
  }
  return String(value);
}

function formatTimestamp(value: CellScalar, unit: "s" | "ms" | "us" | "ns"): string {
  if (typeof value !== "number" && typeof value !== "bigint") return String(value);
  let milliseconds: number;
  if (typeof value === "bigint") {
    const divisor = unit === "us" ? 1_000n : unit === "ns" ? 1_000_000n : 1n;
    const scaled = unit === "s" ? value * 1_000n : value / divisor;
    milliseconds = Number(scaled);
  } else {
    milliseconds = value;
  }
  if (!Number.isFinite(milliseconds)) return formatCellValue(value, { kind: "number" });
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return `${String(value)} ${unit}`;
  try {
    return date.toISOString();
  } catch {
    return `${String(value)} ${unit}`;
  }
}
