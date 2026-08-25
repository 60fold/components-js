import type {
  CellScalar,
  GridBetweenFilter,
  GridComparisonFilter,
  GridInFilter,
  GridNullFilter,
  GridSortDirection,
} from "../types.js";
import {
  assertCompatibleFilterScalar,
  matchesFilterBetween,
  matchesFilterComparison,
} from "./filterSemantics.js";
import { yieldWorkerTurn } from "./yieldWorkerTurn.js";

type NumberValues = Float32Array | Float64Array;
type IntegerValues =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array;
type CategoryCodes = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array;

export interface TypedKernelBitmap {
  readonly bits: Uint8Array;
  readonly bitOffset?: number;
}

interface TypedKernelColumnBase {
  readonly rowCount: number;
  readonly validity?: TypedKernelBitmap;
  /** Sparse values supersede both the physical payload and its validity bit. */
  readonly overrides?: ReadonlyMap<number, CellScalar | null>;
}

export interface TypedNumberKernelColumn extends TypedKernelColumnBase {
  readonly kind: "number";
  readonly values: NumberValues;
}

export interface TypedIntegerKernelColumn extends TypedKernelColumnBase {
  readonly kind: "integer";
  readonly values: IntegerValues;
}

export interface TypedTimestampKernelColumn extends TypedKernelColumnBase {
  readonly kind: "timestamp";
  readonly values: Float64Array | BigInt64Array;
}

export interface TypedBooleanKernelColumn extends TypedKernelColumnBase {
  readonly kind: "boolean";
  readonly values: Uint8Array;
  readonly encoding: "byte" | "bitmap";
  readonly bitOffset?: number;
}

export interface TypedCategoryKernelColumn extends TypedKernelColumnBase {
  readonly kind: "category";
  readonly codes: CategoryCodes;
  /** Decoded dictionary values indexed by the installed physical code. */
  readonly dictionary: readonly string[];
  /** Code-unit lexical rank indexed by physical code. Equal labels have equal ranks. */
  readonly lexicalRanks: Uint32Array;
  readonly codeByValue: ReadonlyMap<string, number>;
}

export type TypedViewKernelColumn =
  | TypedNumberKernelColumn
  | TypedIntegerKernelColumn
  | TypedTimestampKernelColumn
  | TypedBooleanKernelColumn
  | TypedCategoryKernelColumn;

export type TypedViewKernelFilter =
  GridComparisonFilter | GridBetweenFilter | GridInFilter | GridNullFilter;

export interface TypedViewKernelSortKey {
  readonly column: TypedViewKernelColumn;
  readonly direction: GridSortDirection;
  readonly nulls: "first" | "last";
}

export interface TypedViewKernelProgress {
  readonly phase: "filter" | "compact" | "sort";
  readonly completed: number;
  readonly total: number;
}

/** Chunk observations and cancellation checks run at bounded yield boundaries. */
export interface TypedViewKernelOptions {
  readonly chunkSize?: number;
  readonly shouldCancel?: () => boolean;
  readonly onChunk?: (progress: TypedViewKernelProgress) => void;
}

export interface TypedViewKernelAsyncOptions extends TypedViewKernelOptions {
  /** Defaults to a zero-delay task, allowing newer worker messages to arrive. */
  readonly yieldControl?: () => Promise<void>;
}

export class TypedViewKernelCancelledError extends Error {
  constructor() {
    super("Typed Grid view kernel was cancelled.");
    this.name = "TypedViewKernelCancelledError";
  }
}

export interface TypedFilterResult {
  readonly bitmap: Uint8Array;
  readonly physicalRows: Uint32Array;
}

type DenseNumericBetweenMode = "closed" | "open-lower" | "open-upper" | "open";

interface DenseNumericBetweenPlan {
  readonly values: NumberValues;
  readonly lower: number;
  readonly upper: number;
  readonly mode: DenseNumericBetweenMode;
}

const DEFAULT_CHUNK_SIZE = 16_384;
// Sixteen-bit digits halve full-width scans versus a byte radix while keeping
// the count table cache-friendly (256 KiB).
const RADIX_SIZE = 65_536;
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function denseNumericBetweenPlan(
  column: TypedViewKernelColumn,
  filter: TypedViewKernelFilter,
): DenseNumericBetweenPlan | null {
  if (
    column.kind !== "number" ||
    column.validity !== undefined ||
    column.overrides !== undefined ||
    filter.kind !== "between" ||
    typeof filter.lower !== "number" ||
    typeof filter.upper !== "number"
  ) {
    return null;
  }
  const includeLower = filter.includeLower !== false;
  const includeUpper = filter.includeUpper !== false;
  const mode: DenseNumericBetweenMode = includeLower
    ? includeUpper
      ? "closed"
      : "open-upper"
    : includeUpper
      ? "open-lower"
      : "open";
  return { values: column.values, lower: filter.lower, upper: filter.upper, mode };
}

/**
 * Scans one dense numeric range chunk without the generic scalar reader and
 * comparator chain. JavaScript's numeric relational operators preserve the
 * existing NaN, signed-zero, infinity, and inclusive-edge semantics here.
 */
function scanDenseNumericBetweenChunk(
  plan: DenseNumericBetweenPlan,
  bitmap: Uint8Array,
  start: number,
  end: number,
): number {
  const { values, lower, upper } = plan;
  let matches = 0;
  switch (plan.mode) {
    case "closed":
      for (let row = start; row < end; row++) {
        const value = values[row]!;
        if (value >= lower && value <= upper) {
          bitmap[row >>> 3]! |= 1 << (row & 7);
          matches++;
        }
      }
      break;
    case "open-lower":
      for (let row = start; row < end; row++) {
        const value = values[row]!;
        if (value > lower && value <= upper) {
          bitmap[row >>> 3]! |= 1 << (row & 7);
          matches++;
        }
      }
      break;
    case "open-upper":
      for (let row = start; row < end; row++) {
        const value = values[row]!;
        if (value >= lower && value < upper) {
          bitmap[row >>> 3]! |= 1 << (row & 7);
          matches++;
        }
      }
      break;
    case "open":
      for (let row = start; row < end; row++) {
        const value = values[row]!;
        if (value > lower && value < upper) {
          bitmap[row >>> 3]! |= 1 << (row & 7);
          matches++;
        }
      }
      break;
  }
  return matches;
}

/** Worker-safe filter path that yields between every bounded scan chunk. */
export async function filterTypedColumnAsync(
  column: TypedViewKernelColumn,
  filter: TypedViewKernelFilter,
  options: TypedViewKernelAsyncOptions = {},
): Promise<TypedFilterResult> {
  validateColumn(column);
  validateTypedFilter(column, filter);
  const denseNumericBetween = denseNumericBetweenPlan(column, filter);
  const rowPredicate = denseNumericBetween ? null : createTypedRowPredicate(column, filter);
  const bitmap = new Uint8Array(Math.ceil(column.rowCount / 8));
  const chunkSize = resolveChunkSize(options.chunkSize);
  let count = 0;
  checkpoint(options, "filter", 0, column.rowCount);
  for (let start = 0; start < column.rowCount; start += chunkSize) {
    const end = Math.min(column.rowCount, start + chunkSize);
    if (denseNumericBetween) {
      count += scanDenseNumericBetweenChunk(denseNumericBetween, bitmap, start, end);
    } else {
      for (let row = start; row < end; row++) {
        if (rowPredicate!(row)) {
          setBit(bitmap, row);
          count++;
        }
      }
    }
    await asyncCheckpoint(options, "filter", end, column.rowCount, end < column.rowCount);
  }

  checkpoint(options, "compact", 0, column.rowCount);
  const physicalRows = new Uint32Array(count);
  let ordinal = 0;
  for (let start = 0; start < column.rowCount; start += chunkSize) {
    const end = Math.min(column.rowCount, start + chunkSize);
    for (let row = start; row < end; row++) {
      if (bitIsSet(bitmap, row)) physicalRows[ordinal++] = row;
    }
    await asyncCheckpoint(options, "compact", end, column.rowCount, end < column.rowCount);
  }
  return { bitmap, physicalRows };
}

/** Worker-safe identity argsort with real event-loop yields between chunks. */
export async function stableTypedRadixArgsortAsync(
  rowCount: number,
  keys: readonly TypedViewKernelSortKey[],
  options: TypedViewKernelAsyncOptions = {},
): Promise<Uint32Array> {
  assertRowCount(rowCount);
  const rows = new Uint32Array(rowCount);
  const chunkSize = resolveChunkSize(options.chunkSize);
  checkpoint(options, "sort", 0, rowCount);
  for (let start = 0; start < rowCount; start += chunkSize) {
    const end = Math.min(rowCount, start + chunkSize);
    for (let row = start; row < end; row++) rows[row] = row;
    await asyncCheckpoint(options, "sort", end, rowCount, end < rowCount);
  }
  return stableTypedRadixSortRowsAsync(rows, keys, options, true);
}

/**
 * Worker-safe filtered-row sort. Intermediate permutations remain in the
 * caller-owned candidate buffer and are never returned after cancellation.
 */
export async function stableTypedRadixSortRowsAsync(
  physicalRows: Uint32Array,
  keys: readonly TypedViewKernelSortKey[],
  options: TypedViewKernelAsyncOptions = {},
  alreadyPhysicalAscending = false,
): Promise<Uint32Array> {
  if (keys.length === 0 || physicalRows.length < 2) return physicalRows;
  validateSortInputs(physicalRows, keys);
  const accessors = keys.map(({ column }) => createRadixAccessor(column));
  const physicalPasses = alreadyPhysicalAscending ? 0 : 2;
  const totalPasses =
    physicalPasses +
    accessors.reduce(
      (sum, accessor) => sum + accessor.radixPasses + (accessor.hasNulls ? 1 : 0),
      0,
    );
  const total = totalPasses * physicalRows.length * 2;
  const scratch = new Uint32Array(physicalRows.length);
  const counts = new Uint32Array(RADIX_SIZE);
  const chunkSize = resolveChunkSize(options.chunkSize);
  let source: Uint32Array<ArrayBufferLike> = physicalRows;
  let target: Uint32Array<ArrayBufferLike> = scratch;
  let completed = 0;
  checkpoint(options, "sort", 0, total);

  const pass = async (digitAt: (row: number) => number): Promise<void> => {
    counts.fill(0);
    let distinctDigits = 0;
    for (let start = 0; start < source.length; start += chunkSize) {
      const end = Math.min(source.length, start + chunkSize);
      for (let index = start; index < end; index++) {
        const digit = digitAt(source[index]!);
        if (counts[digit] === 0) distinctDigits++;
        counts[digit]!++;
      }
      completed += end - start;
      await asyncCheckpoint(options, "sort", completed, total, end < source.length);
    }
    if (distinctDigits <= 1) {
      completed += source.length;
      await asyncCheckpoint(options, "sort", completed, total, true);
      return;
    }
    let offset = 0;
    for (let digit = 0; digit < RADIX_SIZE; digit++) {
      const count = counts[digit]!;
      counts[digit] = offset;
      offset += count;
    }
    for (let start = 0; start < source.length; start += chunkSize) {
      const end = Math.min(source.length, start + chunkSize);
      for (let index = start; index < end; index++) {
        const row = source[index]!;
        const digit = digitAt(row);
        target[counts[digit]!] = row;
        counts[digit]!++;
      }
      completed += end - start;
      await asyncCheckpoint(options, "sort", completed, total, end < source.length);
    }
    [source, target] = [target, source];
    // Always yield between complete radix passes, including short datasets.
    await asyncCheckpoint(options, "sort", completed, total, true);
  };

  const denseFloat64Pass = async (
    words: Uint32Array,
    passIndex: number,
    directionMask: number,
  ): Promise<void> => {
    counts.fill(0);
    let distinctDigits = 0;
    for (let start = 0; start < source.length; start += chunkSize) {
      const end = Math.min(source.length, start + chunkSize);
      distinctDigits += countDenseFloat64Digits(
        source,
        start,
        end,
        words,
        passIndex,
        directionMask,
        counts,
      );
      completed += end - start;
      await asyncCheckpoint(options, "sort", completed, total, end < source.length);
    }
    if (distinctDigits <= 1) {
      completed += source.length;
      await asyncCheckpoint(options, "sort", completed, total, true);
      return;
    }
    let offset = 0;
    for (let digit = 0; digit < RADIX_SIZE; digit++) {
      const count = counts[digit]!;
      counts[digit] = offset;
      offset += count;
    }
    for (let start = 0; start < source.length; start += chunkSize) {
      const end = Math.min(source.length, start + chunkSize);
      scatterDenseFloat64Digits(
        source,
        target,
        start,
        end,
        words,
        passIndex,
        directionMask,
        counts,
      );
      completed += end - start;
      await asyncCheckpoint(options, "sort", completed, total, end < source.length);
    }
    [source, target] = [target, source];
    await asyncCheckpoint(options, "sort", completed, total, true);
  };

  if (!alreadyPhysicalAscending) {
    for (let digit = 0; digit < 2; digit++) {
      const shift = digit * 16;
      await pass((row) => (row >>> shift) & 0xffff);
    }
  }
  for (let keyIndex = keys.length - 1; keyIndex >= 0; keyIndex--) {
    const key = keys[keyIndex]!;
    const accessor = accessors[keyIndex]!;
    if (accessor.denseFloat64Words) {
      const directionMask = key.direction === "ascending" ? 0 : 0xffff;
      for (let digit = 0; digit < accessor.radixPasses; digit++) {
        await denseFloat64Pass(accessor.denseFloat64Words, digit, directionMask);
      }
    } else {
      for (let digit = 0; digit < accessor.radixPasses; digit++) {
        const passIndex = digit;
        if (key.direction === "ascending") {
          await pass((row) => accessor.digit(row, passIndex));
        } else {
          await pass((row) => 0xffff - accessor.digit(row, passIndex));
        }
      }
    }
    if (accessor.hasNulls) {
      if (key.nulls === "first") await pass((row) => (accessor.isNull(row) ? 0 : 1));
      else await pass((row) => (accessor.isNull(row) ? 1 : 0));
    }
  }
  if (source !== physicalRows) physicalRows.set(source);
  checkpoint(options, "sort", total, total);
  return physicalRows;
}

interface RadixAccessor {
  readonly radixPasses: number;
  readonly hasNulls: boolean;
  /** Direct-word fast path for dense, unpatched Float64 number columns. */
  readonly denseFloat64Words?: Uint32Array;
  isNull(row: number): boolean;
  digit(row: number, pass: number): number;
}

function createRadixAccessor(column: TypedViewKernelColumn): RadixAccessor {
  const overrideKeys = buildOverrideKeys(column);
  const hasNulls =
    column.validity !== undefined || [...overrideKeys.values()].some((value) => value === null);
  const overrideMask = overrideKeys.size > 0 ? overrideBitmap(column.rowCount, overrideKeys) : null;
  const overrideAt = (row: number): readonly number[] | null | undefined =>
    overrideMask && bitIsSet(overrideMask, row) ? overrideKeys.get(row) : undefined;
  const baseIsNull = (row: number): boolean => !isValid(column.validity, row);
  const isNull = (row: number): boolean => {
    const override = overrideAt(row);
    return override !== undefined ? override === null : baseIsNull(row);
  };

  switch (column.kind) {
    case "number": {
      if (column.values instanceof Float32Array) {
        const words = new Uint32Array(
          column.values.buffer,
          column.values.byteOffset,
          column.values.length,
        );
        // Sparse patches retain the host's exact JS number. Promote the base
        // Float32 bit pattern to an exact Float64 key so an unrounded patch is
        // never compared as though it had been written into the base buffer.
        const exactPatchKeys = overrideKeys.size > 0;
        return {
          radixPasses: exactPatchKeys ? 4 : 2,
          hasNulls,
          isNull,
          digit(row, pass) {
            const override = overrideAt(row);
            if (override !== undefined) return override?.[pass] ?? 0;
            if (baseIsNull(row)) return 0;
            return exactPatchKeys
              ? float32AsFloat64Digit(words[row]!, pass)
              : float32Digit(words[row]!, pass);
          },
        };
      }
      const words = new Uint32Array(
        column.values.buffer,
        column.values.byteOffset,
        column.values.length * 2,
      );
      return {
        radixPasses: 4,
        hasNulls,
        ...(column.validity === undefined && overrideKeys.size === 0
          ? { denseFloat64Words: words }
          : {}),
        isNull,
        digit(row, pass) {
          const override = overrideAt(row);
          if (override !== undefined) return override?.[pass] ?? 0;
          if (baseIsNull(row)) return 0;
          return float64Digit(words, row, pass);
        },
      };
    }
    case "integer":
      return integerAccessor(column, isNull, baseIsNull, overrideAt, hasNulls);
    case "timestamp": {
      if (column.values instanceof Float64Array) {
        const words = new Uint32Array(
          column.values.buffer,
          column.values.byteOffset,
          column.values.length * 2,
        );
        return {
          radixPasses: 4,
          hasNulls,
          isNull,
          digit(row, pass) {
            const override = overrideAt(row);
            if (override !== undefined) return override?.[pass] ?? 0;
            if (baseIsNull(row)) return 0;
            return float64Digit(words, row, pass);
          },
        };
      }
      return integerAccessor(
        { ...column, kind: "integer", values: column.values },
        isNull,
        baseIsNull,
        overrideAt,
        hasNulls,
      );
    }
    case "boolean":
      return {
        radixPasses: 1,
        hasNulls,
        isNull,
        digit(row) {
          const override = overrideAt(row);
          if (override !== undefined) return override?.[0] ?? 0;
          if (baseIsNull(row)) return 0;
          return readBoolean(column, row) ? 1 : 0;
        },
      };
    case "category":
      return {
        radixPasses: 2,
        hasNulls,
        isNull,
        digit(row, pass) {
          const override = overrideAt(row);
          if (override !== undefined) return override?.[pass] ?? 0;
          if (baseIsNull(row)) return 0;
          const rank = column.lexicalRanks[column.codes[row]!]!;
          return (rank >>> (pass * 16)) & 0xffff;
        },
      };
  }
}

function integerAccessor(
  column: TypedIntegerKernelColumn,
  isNull: (row: number) => boolean,
  baseIsNull: (row: number) => boolean,
  overrideAt: (row: number) => readonly number[] | null | undefined,
  hasNulls: boolean,
): RadixAccessor {
  const values = column.values;
  const bytes = values.BYTES_PER_ELEMENT;
  if (bytes === 8) {
    const words = new Uint32Array(values.buffer, values.byteOffset, values.length * 2);
    const signed = values instanceof BigInt64Array;
    return {
      radixPasses: 4,
      hasNulls,
      isNull,
      digit(row, pass) {
        const override = overrideAt(row);
        if (override !== undefined) return override?.[pass] ?? 0;
        if (baseIsNull(row)) return 0;
        const loIndex = row * 2 + (IS_LITTLE_ENDIAN ? 0 : 1);
        const hiIndex = row * 2 + (IS_LITTLE_ENDIAN ? 1 : 0);
        const word = pass < 2 ? words[loIndex]! : words[hiIndex]! ^ (signed ? 0x8000_0000 : 0);
        return (word >>> ((pass & 1) * 16)) & 0xffff;
      },
    };
  }
  const signed =
    values instanceof Int8Array || values instanceof Int16Array || values instanceof Int32Array;
  const signMask = signed ? 1 << (bytes * 8 - 1) : 0;
  const widthMask = bytes === 4 ? 0xffff_ffff : (1 << (bytes * 8)) - 1;
  return {
    radixPasses: Math.ceil(bytes / 2),
    hasNulls,
    isNull,
    digit(row, pass) {
      const override = overrideAt(row);
      if (override !== undefined) return override?.[pass] ?? 0;
      if (baseIsNull(row)) return 0;
      const word = ((Number(values[row]) & widthMask) ^ signMask) >>> 0;
      return (word >>> (pass * 16)) & 0xffff;
    },
  };
}

function buildOverrideKeys(
  column: TypedViewKernelColumn,
): ReadonlyMap<number, readonly number[] | null> {
  const result = new Map<number, readonly number[] | null>();
  column.overrides?.forEach((value, row) => {
    if (!Number.isSafeInteger(row) || row < 0 || row >= column.rowCount) {
      throw new RangeError(`Sparse typed Grid override row ${row} is outside the column.`);
    }
    if (value === null) {
      result.set(row, null);
      return;
    }
    switch (column.kind) {
      case "number":
        if (typeof value !== "number") throw invalidOverride(column.kind, value);
        result.set(
          row,
          numberOverrideDigits(
            value,
            column.values instanceof Float32Array ? 8 : column.values.BYTES_PER_ELEMENT,
          ),
        );
        return;
      case "integer":
      case "timestamp":
        if (typeof value !== "number" && typeof value !== "bigint") {
          throw invalidOverride(column.kind, value);
        }
        result.set(row, integerOverrideDigits(value, column.values));
        return;
      case "boolean":
        if (typeof value !== "boolean") throw invalidOverride(column.kind, value);
        result.set(row, [value ? 1 : 0]);
        return;
      case "category": {
        if (typeof value !== "string") throw invalidOverride(column.kind, value);
        const code = column.codeByValue.get(value);
        if (code === undefined) throw new RangeError(`Unknown sparse category override: ${value}`);
        const rank = column.lexicalRanks[code]!;
        result.set(row, uint32Digits(rank));
        return;
      }
    }
  });
  return result;
}

function overrideBitmap(
  rowCount: number,
  overrides: ReadonlyMap<number, readonly number[] | null>,
): Uint8Array {
  const bits = new Uint8Array(Math.ceil(rowCount / 8));
  overrides.forEach((_value, row) => setBit(bits, row));
  return bits;
}

function numberOverrideDigits(value: number, byteLength: number): readonly number[] {
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  if (byteLength === 4) {
    view.setFloat32(0, value, true);
    const word = view.getUint32(0, true);
    return [0, 1].map((pass) => float32Digit(word, pass));
  }
  view.setFloat64(0, value, IS_LITTLE_ENDIAN);
  const words = new Uint32Array(buffer);
  return [0, 1, 2, 3].map((pass) => float64Digit(words, 0, pass));
}

function integerOverrideDigits(
  value: number | bigint,
  physical: IntegerValues | Float64Array,
): readonly number[] {
  if (physical instanceof Float64Array) return numberOverrideDigits(Number(value), 8);
  const bytes = physical.BYTES_PER_ELEMENT;
  if (bytes === 8) {
    const normalized = BigInt(value);
    const unsigned = BigInt.asUintN(64, normalized);
    const transformed = physical instanceof BigInt64Array ? unsigned ^ (1n << 63n) : unsigned;
    return Array.from({ length: 4 }, (_entry, pass) =>
      Number((transformed >> BigInt(pass * 16)) & 0xffffn),
    );
  }
  const signed =
    physical instanceof Int8Array ||
    physical instanceof Int16Array ||
    physical instanceof Int32Array;
  const signMask = signed ? 1 << (bytes * 8 - 1) : 0;
  const widthMask = bytes === 4 ? 0xffff_ffff : (1 << (bytes * 8)) - 1;
  const transformed = ((Number(value) & widthMask) ^ signMask) >>> 0;
  return Array.from(
    { length: Math.ceil(bytes / 2) },
    (_entry, pass) => (transformed >>> (pass * 16)) & 0xffff,
  );
}

function uint32Digits(value: number): readonly number[] {
  return [value & 0xffff, value >>> 16];
}

function invalidOverride(kind: TypedViewKernelColumn["kind"], value: CellScalar): TypeError {
  return new TypeError(`Sparse ${kind} override has incompatible ${typeof value} value.`);
}

function float32Digit(rawWord: number, pass: number): number {
  const absolute = rawWord & 0x7fff_ffff;
  const isNaN = absolute > 0x7f80_0000;
  let transformed: number;
  if (isNaN) transformed = 0xffff_ffff;
  else if (absolute === 0) transformed = 0x8000_0000;
  else transformed = (rawWord & 0x8000_0000) !== 0 ? ~rawWord : rawWord ^ 0x8000_0000;
  return (transformed >>> (pass * 16)) & 0xffff;
}

function float32AsFloat64Digit(rawWord: number, pass: number): number {
  const sign = rawWord & 0x8000_0000;
  const exponent = (rawWord >>> 23) & 0xff;
  const fraction = rawWord & 0x007f_ffff;
  let rawLo = 0;
  let rawHi: number;
  if (exponent === 0xff) {
    rawHi = sign | (fraction === 0 ? 0x7ff0_0000 : 0x7ff8_0000);
  } else if (exponent === 0) {
    if (fraction === 0) {
      rawHi = sign;
    } else {
      const leadingBit = 31 - Math.clz32(fraction);
      const exponent64 = leadingBit + 874;
      const remainder = fraction - 2 ** leadingBit;
      const fraction64 = remainder * 2 ** (52 - leadingBit);
      const highFraction = Math.floor(fraction64 / 0x1_0000_0000);
      rawLo = (fraction64 - highFraction * 0x1_0000_0000) >>> 0;
      rawHi = sign | (exponent64 << 20) | highFraction;
    }
  } else {
    rawHi = sign | ((exponent + 896) << 20) | (fraction >>> 3);
    rawLo = (fraction & 7) << 29;
  }
  return orderedFloat64Digit(rawLo >>> 0, rawHi >>> 0, pass);
}

function float64Digit(words: Uint32Array, row: number, pass: number): number {
  const loIndex = row * 2 + (IS_LITTLE_ENDIAN ? 0 : 1);
  const hiIndex = row * 2 + (IS_LITTLE_ENDIAN ? 1 : 0);
  const rawLo = words[loIndex]!;
  const rawHi = words[hiIndex]!;
  return orderedFloat64Digit(rawLo, rawHi, pass);
}

function orderedFloat64Digit(rawLo: number, rawHi: number, pass: number): number {
  const absoluteHi = rawHi & 0x7fff_ffff;
  const isNaN = absoluteHi > 0x7ff0_0000 || (absoluteHi === 0x7ff0_0000 && rawLo !== 0);
  const isZero = absoluteHi === 0 && rawLo === 0;
  let lo: number;
  let hi: number;
  if (isNaN) {
    lo = 0xffff_ffff;
    hi = 0xffff_ffff;
  } else if (isZero) {
    lo = 0;
    hi = 0x8000_0000;
  } else if ((rawHi & 0x8000_0000) !== 0) {
    lo = ~rawLo;
    hi = ~rawHi;
  } else {
    lo = rawLo;
    hi = rawHi ^ 0x8000_0000;
  }
  const word = pass < 2 ? lo : hi;
  return (word >>> ((pass & 1) * 16)) & 0xffff;
}

/**
 * Counts one dense Float64 radix chunk without the generic accessor callback
 * chain. Keep this transform byte-for-byte equivalent to
 * `orderedFloat64Digit`: all NaNs and both signed zeros remain stable ties.
 */
function countDenseFloat64Digits(
  source: Uint32Array,
  start: number,
  end: number,
  words: Uint32Array,
  pass: number,
  directionMask: number,
  counts: Uint32Array,
): number {
  const lowOffset = IS_LITTLE_ENDIAN ? 0 : 1;
  const highOffset = IS_LITTLE_ENDIAN ? 1 : 0;
  const highWord = pass >= 2;
  const shift = (pass & 1) * 16;
  let distinctDigits = 0;
  for (let index = start; index < end; index++) {
    const row = source[index]!;
    const pairOffset = row * 2;
    const rawLo = words[pairOffset + lowOffset]!;
    const rawHi = words[pairOffset + highOffset]!;
    const absoluteHi = rawHi & 0x7fff_ffff;
    const rawWord = highWord ? rawHi : rawLo;
    let orderedWord: number;
    if (absoluteHi > 0x7ff0_0000 || (absoluteHi === 0x7ff0_0000 && rawLo !== 0)) {
      orderedWord = 0xffff_ffff;
    } else if (absoluteHi === 0 && rawLo === 0) {
      orderedWord = highWord ? 0x8000_0000 : 0;
    } else if ((rawHi & 0x8000_0000) !== 0) {
      orderedWord = ~rawWord;
    } else {
      orderedWord = highWord ? rawWord ^ 0x8000_0000 : rawWord;
    }
    const digit = (((orderedWord >>> shift) & 0xffff) ^ directionMask) >>> 0;
    if (counts[digit] === 0) distinctDigits++;
    counts[digit]!++;
  }
  return distinctDigits;
}

/** Stable scatter companion to {@link countDenseFloat64Digits}. */
function scatterDenseFloat64Digits(
  source: Uint32Array,
  target: Uint32Array,
  start: number,
  end: number,
  words: Uint32Array,
  pass: number,
  directionMask: number,
  counts: Uint32Array,
): void {
  const lowOffset = IS_LITTLE_ENDIAN ? 0 : 1;
  const highOffset = IS_LITTLE_ENDIAN ? 1 : 0;
  const highWord = pass >= 2;
  const shift = (pass & 1) * 16;
  for (let index = start; index < end; index++) {
    const row = source[index]!;
    const pairOffset = row * 2;
    const rawLo = words[pairOffset + lowOffset]!;
    const rawHi = words[pairOffset + highOffset]!;
    const absoluteHi = rawHi & 0x7fff_ffff;
    const rawWord = highWord ? rawHi : rawLo;
    let orderedWord: number;
    if (absoluteHi > 0x7ff0_0000 || (absoluteHi === 0x7ff0_0000 && rawLo !== 0)) {
      orderedWord = 0xffff_ffff;
    } else if (absoluteHi === 0 && rawLo === 0) {
      orderedWord = highWord ? 0x8000_0000 : 0;
    } else if ((rawHi & 0x8000_0000) !== 0) {
      orderedWord = ~rawWord;
    } else {
      orderedWord = highWord ? rawWord ^ 0x8000_0000 : rawWord;
    }
    const digit = (((orderedWord >>> shift) & 0xffff) ^ directionMask) >>> 0;
    const targetIndex = counts[digit]!;
    target[targetIndex] = row;
    counts[digit] = targetIndex + 1;
  }
}

function createTypedValueReader(column: TypedViewKernelColumn): (row: number) => CellScalar | null {
  const override = column.overrides;
  switch (column.kind) {
    case "number":
    case "integer":
    case "timestamp":
      return (row) => {
        if (override?.has(row)) return override.get(row) ?? null;
        return isValid(column.validity, row) ? column.values[row]! : null;
      };
    case "boolean":
      return (row) => {
        if (override?.has(row)) return override.get(row) ?? null;
        return isValid(column.validity, row) ? readBoolean(column, row) : null;
      };
    case "category":
      return (row) => {
        if (override?.has(row)) return override.get(row) ?? null;
        return isValid(column.validity, row) ? column.dictionary[column.codes[row]!]! : null;
      };
  }
}

function createTypedRowPredicate(
  column: TypedViewKernelColumn,
  filter: TypedViewKernelFilter,
): (row: number) => boolean {
  const predicate = compileValuePredicate(filter);
  if (column.kind === "category") {
    const codeMatches = compileCategoryInCodes(column, filter);
    if (codeMatches) {
      return (row) => {
        if (column.overrides?.has(row)) return predicate(column.overrides.get(row)!);
        return isValid(column.validity, row) && codeMatches[column.codes[row]!] !== 0;
      };
    }
  }
  const readValue = createTypedValueReader(column);
  return (row) => predicate(readValue(row));
}

function compileCategoryInCodes(
  column: TypedCategoryKernelColumn,
  filter: TypedViewKernelFilter,
): Uint8Array | null {
  if (filter.kind !== "in") return null;
  const matches = new Uint8Array(column.dictionary.length);
  for (const value of filter.values) {
    if (typeof value !== "string") continue;
    const code = column.codeByValue.get(value);
    if (code !== undefined) matches[code] = 1;
  }
  return matches;
}

function compileValuePredicate(
  filter: TypedViewKernelFilter,
): (value: CellScalar | null) => boolean {
  switch (filter.kind) {
    case "is-null":
      return (value) => value === null;
    case "is-not-null":
      return (value) => value !== null;
    case "comparison":
      return (value) =>
        value !== null && matchesFilterComparison(value, filter.operator, filter.value);
    case "between": {
      const includeLower = filter.includeLower ?? true;
      const includeUpper = filter.includeUpper ?? true;
      return (value) => {
        return (
          value !== null &&
          matchesFilterBetween(value, filter.lower, filter.upper, includeLower, includeUpper)
        );
      };
    }
    case "in": {
      // Set lookup is exact for every scalar except NaN; strict `in` semantics
      // intentionally never match NaN, so omit it from the compiled set.
      const values = new Set(filter.values.filter((value) => !isNaNScalar(value)));
      return (value) => value !== null && !isNaNScalar(value) && values.has(value);
    }
  }
}

function isNaNScalar(value: CellScalar): boolean {
  return typeof value === "number" && Number.isNaN(value);
}

function validateTypedFilter(column: TypedViewKernelColumn, filter: TypedViewKernelFilter): void {
  if (filter.kind === "is-null" || filter.kind === "is-not-null") return;
  const scalarType = typedColumnScalarType(column);
  if (filter.kind === "comparison") {
    assertCompatibleFilterScalar(filter.value, scalarType, "typed comparison value");
    return;
  }
  if (filter.kind === "between") {
    assertCompatibleFilterScalar(filter.lower, scalarType, "typed between lower value");
    assertCompatibleFilterScalar(filter.upper, scalarType, "typed between upper value");
    return;
  }
  if (filter.kind !== "in") return;
  for (let index = 0; index < filter.values.length; index++) {
    assertCompatibleFilterScalar(
      filter.values[index],
      scalarType,
      `typed in filter value ${index}`,
    );
  }
}

function typedColumnScalarType(
  column: TypedViewKernelColumn,
): "string" | "number" | "boolean" | "bigint" {
  switch (column.kind) {
    case "number":
      return "number";
    case "integer":
      return column.values instanceof BigInt64Array || column.values instanceof BigUint64Array
        ? "bigint"
        : "number";
    case "timestamp":
      return column.values instanceof BigInt64Array ? "bigint" : "number";
    case "boolean":
      return "boolean";
    case "category":
      return "string";
  }
}

function readBoolean(column: TypedBooleanKernelColumn, row: number): boolean {
  if (column.encoding === "byte") return column.values[row] !== 0;
  const bit = (column.bitOffset ?? 0) + row;
  return (column.values[bit >> 3]! & (1 << (bit & 7))) !== 0;
}

function isValid(validity: TypedKernelBitmap | undefined, row: number): boolean {
  if (!validity) return true;
  const bit = (validity.bitOffset ?? 0) + row;
  return (validity.bits[bit >> 3]! & (1 << (bit & 7))) !== 0;
}

function setBit(bitmap: Uint8Array, row: number): void {
  bitmap[row >> 3]! |= 1 << (row & 7);
}

function bitIsSet(bitmap: Uint8Array, row: number): boolean {
  return (bitmap[row >> 3]! & (1 << (row & 7))) !== 0;
}

function validateColumn(column: TypedViewKernelColumn): void {
  assertRowCount(column.rowCount);
  if (column.validity) {
    const offset = column.validity.bitOffset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError("Typed Grid validity bitOffset must be a non-negative safe integer.");
    }
    if (column.validity.bits.length * 8 < offset + column.rowCount) {
      throw new RangeError("Typed Grid validity bitmap is shorter than the column.");
    }
  }
  if (column.kind === "boolean" && column.encoding === "bitmap") {
    const offset = column.bitOffset ?? 0;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      column.values.length * 8 < offset + column.rowCount
    ) {
      throw new RangeError("Typed Grid boolean bitmap is shorter than the column.");
    }
  } else {
    const length = column.kind === "category" ? column.codes.length : column.values.length;
    if (length < column.rowCount)
      throw new RangeError("Typed Grid values are shorter than the column.");
  }
  if (column.kind === "category") {
    if (column.lexicalRanks.length < column.dictionary.length) {
      throw new RangeError("Typed Grid category lexical ranks are shorter than the dictionary.");
    }
  }
}

function validateSortInputs(
  physicalRows: Uint32Array,
  keys: readonly TypedViewKernelSortKey[],
): void {
  for (const key of keys) {
    validateColumn(key.column);
    if (key.direction !== "ascending" && key.direction !== "descending") {
      throw new TypeError(`Invalid typed Grid radix direction: ${String(key.direction)}`);
    }
    if (key.nulls !== "first" && key.nulls !== "last") {
      throw new TypeError(`Invalid typed Grid radix null placement: ${String(key.nulls)}`);
    }
    for (let index = 0; index < physicalRows.length; index++) {
      if (physicalRows[index]! >= key.column.rowCount) {
        throw new RangeError(`Physical row ${physicalRows[index]} is outside a radix sort column.`);
      }
    }
  }
}

function assertRowCount(rowCount: number): void {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > 0xffff_ffff) {
    throw new RangeError("Typed Grid row count must fit a Uint32 physical-row domain.");
  }
}

function resolveChunkSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CHUNK_SIZE;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Typed Grid kernel chunkSize must be a positive safe integer.");
  }
  return value;
}

function checkpoint(
  options: TypedViewKernelOptions,
  phase: TypedViewKernelProgress["phase"],
  completed: number,
  total: number,
): void {
  if (options.shouldCancel?.()) throw new TypedViewKernelCancelledError();
  options.onChunk?.({ phase, completed, total });
}

async function asyncCheckpoint(
  options: TypedViewKernelAsyncOptions,
  phase: TypedViewKernelProgress["phase"],
  completed: number,
  total: number,
  yieldNow: boolean,
): Promise<void> {
  checkpoint(options, phase, completed, total);
  if (!yieldNow) return;
  if (options.yieldControl) await options.yieldControl();
  else await yieldWorkerTurn();
  if (options.shouldCancel?.()) throw new TypedViewKernelCancelledError();
}
