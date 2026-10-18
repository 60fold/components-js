import type { CellScalar, CellScalarType, GridComparisonOperator } from "../types.js";

/** Validates one filter operand against the installed column representation. */
export function assertCompatibleFilterScalar(
  value: unknown,
  expectedType: CellScalarType,
  label: string,
): asserts value is CellScalar {
  const type = typeof value;
  if (type !== "string" && type !== "number" && type !== "boolean" && type !== "bigint") {
    throw new TypeError(`Grid ${label} must be a scalar.`);
  }
  if (type === "number" && Number.isNaN(value)) {
    throw new RangeError(`Grid ${label} must not be NaN.`);
  }
  if (type !== expectedType) {
    throw new TypeError(`Grid ${label} must have type ${expectedType}; received ${type}.`);
  }
}

/**
 * Filter comparison is deliberately distinct from the total ordering used by
 * sorting. It compares only like-typed values and treats data NaN as unordered.
 */
export function matchesFilterComparison(
  left: CellScalar,
  operator: GridComparisonOperator,
  right: CellScalar,
): boolean {
  if (operator === "eq") return left === right;
  if (operator === "ne") return left !== right;
  const comparison = compareRelationalFilterScalar(left, right);
  if (comparison === null) return false;
  if (operator === "lt") return comparison < 0;
  if (operator === "lte") return comparison <= 0;
  if (operator === "gt") return comparison > 0;
  return comparison >= 0;
}

export function matchesFilterBetween(
  value: CellScalar,
  lower: CellScalar,
  upper: CellScalar,
  includeLower: boolean,
  includeUpper: boolean,
): boolean {
  const lowerComparison = compareRelationalFilterScalar(value, lower);
  const upperComparison = compareRelationalFilterScalar(value, upper);
  if (lowerComparison === null || upperComparison === null) return false;
  return (
    (includeLower ? lowerComparison >= 0 : lowerComparison > 0) &&
    (includeUpper ? upperComparison <= 0 : upperComparison < 0)
  );
}

function compareRelationalFilterScalar(left: CellScalar, right: CellScalar): -1 | 0 | 1 | null {
  if (typeof left !== typeof right || isNaNScalar(left) || isNaNScalar(right)) return null;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isNaNScalar(value: CellScalar): boolean {
  return typeof value === "number" && Number.isNaN(value);
}
