import { describe, expect, it } from "vitest";
import { StreamingBoundsIndex } from "./streamingBounds.js";

function scanBounds(series: readonly Float64Array[], length: number, stacked: readonly boolean[]) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < length; i++) {
    let positive = 0;
    let negative = 0;
    let hasStackValue = false;
    for (let s = 0; s < series.length; s++) {
      const value = series[s][i];
      if (!Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
      if (stacked[s]) {
        hasStackValue = true;
        if (value >= 0) positive += value;
        else negative += value;
      }
    }
    if (hasStackValue) {
      min = Math.min(min, negative);
      max = Math.max(max, positive);
    }
  }
  return { min, max };
}

function countReads(values: Float64Array) {
  let reads = 0;
  return {
    values: new Proxy(values, {
      get(target, property) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, target);
      },
    }),
    takeReads() {
      const count = reads;
      reads = 0;
      return count;
    },
  };
}

describe("StreamingBoundsIndex", () => {
  it("keeps an unpopulated index empty and excludes unwritten zero-filled capacity", () => {
    const values = new Float64Array(769);
    values.set([10, 20]);
    const index = new StreamingBoundsIndex([values], values.length, [false]);
    expect(index.min).toBe(Infinity);
    expect(index.max).toBe(-Infinity);
    index.rebuild(2);
    expect(index.min).toBe(10);
    expect(index.max).toBe(20);

    values[2] = 15;
    index.markDirty(2);
    index.flush(3);
    expect(index.min).toBe(10);
    expect(index.max).toBe(20);
    index.rebuild(0);
    expect(index.min).toBe(Infinity);
    expect(index.max).toBe(-Infinity);
  });

  it("removes extrema overwritten on either side of a block boundary and in the final slot", () => {
    const values = new Float64Array(769).fill(20);
    values[255] = -9000;
    values[256] = 9000;
    values[768] = -700;
    const index = new StreamingBoundsIndex([values], values.length, [false]);
    index.rebuild(values.length);
    expect(index.min).toBe(-9000);
    expect(index.max).toBe(9000);

    values[255] = 21;
    values[256] = 22;
    index.markDirty(255);
    index.markDirty(256);
    index.flush(values.length);
    expect(index.min).toBe(-700);
    expect(index.max).toBe(22);

    values[768] = 20;
    index.markDirty(768);
    index.flush(values.length);
    expect(index.min).toBe(20);
    expect(index.max).toBe(22);
  });

  it("only scans the populated portion of a partial block and expands it on append", () => {
    const values = new Float64Array(521).fill(-9999);
    values.fill(10, 0, 257);
    const index = new StreamingBoundsIndex([values], values.length, [false]);
    index.rebuild(257);
    expect(index.min).toBe(10);
    expect(index.max).toBe(10);

    values[256] = 123;
    index.markDirty(256);
    index.flush(257);
    expect(index.min).toBe(10);
    expect(index.max).toBe(123);

    values[257] = 88;
    values[258] = 77;
    index.markDirty(257);
    index.markDirty(258);
    index.flush(259);
    expect(index.min).toBe(10);
    expect(index.max).toBe(123);
  });

  it("deduplicates dirty blocks and bounds incremental reads independently of retained length", () => {
    const capacity = 4097;
    const first = countReads(new Float64Array(capacity).fill(5));
    const second = countReads(new Float64Array(capacity).fill(7));
    const index = new StreamingBoundsIndex([first.values, second.values], capacity, [false, false]);
    index.rebuild(capacity);
    expect(first.takeReads()).toBe(capacity);
    expect(second.takeReads()).toBe(capacity);

    for (let repeat = 0; repeat < 1000; repeat++) index.markDirty(10);
    index.markDirty(255);
    index.flush(capacity);
    expect(first.takeReads()).toBe(256);
    expect(second.takeReads()).toBe(256);
    index.flush(capacity);
    expect(first.takeReads()).toBe(0);
    expect(second.takeReads()).toBe(0);

    index.markDirty(4096);
    index.flush(capacity);
    expect(first.takeReads()).toBe(1);
    expect(second.takeReads()).toBe(1);
  });

  it("ignores nonfinite scalar values, including in stacked series", () => {
    const values = Float64Array.from([NaN, Infinity, -Infinity]);
    const index = new StreamingBoundsIndex([values], values.length, [true]);
    index.rebuild(values.length);
    expect(index.min).toBe(Infinity);
    expect(index.max).toBe(-Infinity);

    values[1] = 7;
    index.markDirty(1);
    index.flush(values.length);
    expect(index.min).toBe(0);
    expect(index.max).toBe(7);
  });

  it("combines all scalar values with only the configured positive and negative stack sums", () => {
    const series = [
      Float64Array.from([2, -4, NaN]),
      Float64Array.from([3, -6, 7]),
      Float64Array.from([4, -8, 6]),
    ];
    const index = new StreamingBoundsIndex(series, 3, [true, true, false]);
    index.rebuild(3);
    expect(index.min).toBe(-10);
    expect(index.max).toBe(7);

    series[2][0] = 50;
    index.markDirty(0);
    index.flush(3);
    expect(index.min).toBe(-10);
    expect(index.max).toBe(50);
  });

  it("preserves signed stack overflow and removes it once the contributing slots are overwritten", () => {
    const series = [Float64Array.from([1e308, -1e308]), Float64Array.from([1e308, -1e308])];
    const index = new StreamingBoundsIndex(series, 2, [true, true]);
    index.rebuild(2);
    expect(index.min).toBe(-Infinity);
    expect(index.max).toBe(Infinity);

    series[0].set([2, -3]);
    series[1].set([4, -5]);
    index.markDirty(0);
    index.markDirty(1);
    index.flush(2);
    expect(index.min).toBe(-8);
    expect(index.max).toBe(6);
  });

  it("matches retained physical data after oversized batches reuse slots across multiple wraps", () => {
    const capacity = 513;
    const series = Array.from({ length: 3 }, () => new Float64Array(capacity));
    const stacked = [true, false, true];
    const index = new StreamingBoundsIndex(series, capacity, stacked);
    let received = 0;
    for (const batchLength of [255, 1, 257, 1, 1027, 2, 514]) {
      for (let point = 0; point < batchLength; point++) {
        const physicalIndex = received % capacity;
        for (let s = 0; s < series.length; s++) {
          const seed = received * (s + 1) + s * 17;
          series[s][physicalIndex] =
            seed % 41 === 0 ? NaN : seed % 43 === 0 ? Infinity : (seed % 113) - 56;
        }
        index.markDirty(physicalIndex);
        received++;
      }
      const populatedLength = Math.min(received, capacity);
      index.flush(populatedLength);
      const expected = scanBounds(series, populatedLength, stacked);
      expect({ min: index.min, max: index.max }).toEqual(expected);
    }
  });

  it("clears stale leaves and dirty work when rebuilding a shorter population", () => {
    const tracked = countReads(new Float64Array(513).fill(1));
    tracked.values[512] = 999;
    const index = new StreamingBoundsIndex([tracked.values], 513, [false]);
    index.rebuild(513);
    expect(index.max).toBe(999);
    index.markDirty(512);
    index.rebuild(2);
    expect(index.min).toBe(1);
    expect(index.max).toBe(1);
    tracked.takeReads();
    index.flush(2);
    expect(tracked.takeReads()).toBe(0);
  });

  it("keeps metadata block-sized rather than point-sized", () => {
    const index = new StreamingBoundsIndex([], 5_000_000, []);
    const metadataBytes = Object.values(index).reduce(
      (sum, value) => sum + (ArrayBuffer.isView(value) ? value.byteLength : 0),
      0,
    );
    expect(metadataBytes).toBeLessThan(1_200_000);
    index.rebuild(0);
    expect(index.min).toBe(Infinity);
    expect(index.max).toBe(-Infinity);
  });
});
