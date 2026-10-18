/** Validate before changing a queue, transferring buffers, or updating the ring. */
export function validateCandleTimestamp(timestamp: number, previous: number | null): void {
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Stock streaming timestamps must contain only finite values");
  }
  if (previous !== null && timestamp <= previous) {
    throw new RangeError("Stock streaming timestamps must be strictly increasing");
  }
}

export function validateCandleAppend(
  timestamps: Float64Array,
  columns: readonly Float64Array[],
  previous: number | null,
): number | null {
  if (columns.some((column) => column.length !== timestamps.length)) {
    throw new RangeError("OHLCV columns must all have the same length");
  }
  for (const timestamp of timestamps) {
    validateCandleTimestamp(timestamp, previous);
    previous = timestamp;
  }
  return previous;
}
