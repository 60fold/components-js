import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStockChartEngine, type StockChartEngine } from "./stockRenderer.js";
import * as aggregation from "./engine/aggregation.js";
import { StockLevelAccess, type AggregatedLevel } from "./engine/levels.js";

const MINUTE = 60_000;
const START = Date.UTC(2025, 0, 1);
const aggregateLevel = aggregation.aggregateLevel;

function recordAggregations() {
  const levels: AggregatedLevel[] = [];
  vi.spyOn(aggregation, "aggregateLevel").mockImplementation((...args) => {
    const level = aggregateLevel(...args);
    levels.push(level);
    return level;
  });
  return levels;
}

function expectedAggregations(startIndex: number, count: number, marketTime = false) {
  const source: AggregatedLevel = {
    ...candles(startIndex, count),
    name: "1m",
    interval: MINUTE,
    length: count,
    ...(marketTime
      ? {
          marketX: Float64Array.from(
            { length: count },
            (_, index) => (startIndex + index) * MINUTE,
          ),
        }
      : {}),
  };
  const access = new StockLevelAccess({
    logicalToPhysicalIndex: (index) => index,
    getRawMarketX: (index) => (startIndex + index) * MINUTE,
    usesMarketTime: () => marketTime,
  });
  return aggregation.STOCK_AGGREGATION_LEVELS.filter((level) => level.interval > MINUTE).map(
    (level) => aggregateLevel(source, level, access, marketTime),
  );
}

interface StatsMessage {
  type: "stats";
  totalCandles: number;
  totalReceived: number;
  renderedCandles: number;
  lodReady: boolean;
  lodBuilt: number;
  lodTotal: number;
  dataBounds: { xMin: number; xMax: number; yMin: number; yMax: number };
}

function candles(startIndex: number, count: number) {
  return {
    timestamp: Float64Array.from(
      { length: count },
      (_, index) => START + (startIndex + index) * MINUTE,
    ),
    open: Float64Array.from({ length: count }, (_, index) => 100 + ((startIndex + index) % 37)),
    high: Float64Array.from({ length: count }, (_, index) => 106 + ((startIndex + index) % 37)),
    low: Float64Array.from({ length: count }, (_, index) => 97 + ((startIndex + index) % 37)),
    close: Float64Array.from({ length: count }, (_, index) => 103 + ((startIndex + index) % 37)),
    volume: Float64Array.from({ length: count }, (_, index) => 10 + ((startIndex + index) % 11)),
  };
}

function append(engine: StockChartEngine, startIndex: number, count = 1, initial = false) {
  const data = candles(startIndex, count);
  engine.handleMessage("addCandles", {
    timestamps: data.timestamp,
    opens: data.open,
    highs: data.high,
    lows: data.low,
    closes: data.close,
    volumes: data.volume,
    ...(initial ? { initialTimeRange: "ALL" } : {}),
  });
}

function createCanvasStub(width = 800, height = 600, drawImage = vi.fn()) {
  const gradient = { addColorStop: () => {} } as CanvasGradient;
  const context = new Proxy({} as CanvasRenderingContext2D, {
    get: (_target, property) => {
      if (property === "measureText") return () => ({ width: 40 }) as TextMetrics;
      if (property === "createLinearGradient") return () => gradient;
      if (property === "createPattern") return () => null;
      if (property === "drawImage") return drawImage;
      return () => {};
    },
    set: () => true,
  });
  return { width, height, getContext: () => context };
}

const engines: StockChartEngine[] = [];

function createHarness(capacity = 4096, timeScale: "continuous" | "market" = "continuous") {
  const messages: Array<Record<string, unknown>> = [];
  const drawImage = vi.fn();
  const reportError = vi.fn();
  const engine = createStockChartEngine(
    { postMessage: (message) => messages.push(message), reportError },
    { createCanvas: (width, height) => createCanvasStub(width, height) },
  );
  engines.push(engine);
  engine.handleMessage("init", {
    canvas: createCanvasStub(800, 600, drawImage),
    dpr: 1,
    config: {
      animated: false,
      showVolume: false,
      timeScale,
      rangeSelector: { visible: false },
      yDomain: { min: 0, max: 200 },
    },
  });
  engine.handleMessage("resize", { width: 800, height: 600, dpr: 1 });
  engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
  engine.handleMessage("initRingBuffer", { maxCandles: capacity });
  messages.length = 0;
  return {
    engine,
    messages,
    drawImage,
    reportError,
    stats: () =>
      messages.filter((message) => message.type === "stats") as unknown as StatsMessage[],
  };
}

describe("stock renderer streaming LOD lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (handle: ReturnType<typeof setTimeout>) =>
      clearTimeout(handle),
    );
  });

  afterEach(() => {
    for (const engine of engines.splice(0)) engine.handleMessage("stop", {});
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([10, 1100])(
    "paints an ALL-range initial batch of %i candles while 16 ms appends continue",
    (initialCount) => {
      const harness = createHarness();
      append(harness.engine, 0, initialCount, true);
      let nextIndex = initialCount;
      const stream = setInterval(() => append(harness.engine, nextIndex++), 16);

      vi.advanceTimersByTime(1000);

      expect(harness.reportError).not.toHaveBeenCalled();
      expect(harness.drawImage).toHaveBeenCalled();
      expect(harness.stats().some((stats) => stats.renderedCandles > 0 && stats.lodReady)).toBe(
        true,
      );
      clearInterval(stream);
    },
  );

  it.each([1104, 4096])(
    "publishes LOD repeatedly during a 16 ms stream with capacity %i",
    (capacity) => {
      const harness = createHarness(capacity);
      const levels = recordAggregations();
      append(harness.engine, 0, 1100, true);
      vi.advanceTimersByTime(200);
      expect(harness.stats().some((stats) => stats.lodReady)).toBe(true);
      harness.messages.length = 0;
      levels.length = 0;

      let nextIndex = 1100;
      const stream = setInterval(() => append(harness.engine, nextIndex++), 16);
      const publishedCounts: number[] = [];
      const aggregatedEnds: number[] = [];
      for (let window = 0; window < 3; window++) {
        vi.advanceTimersByTime(1000);
        const completed = harness.stats().filter((stats) => stats.lodReady);
        expect(completed.length).toBeGreaterThan(0);
        const latest = completed[completed.length - 1]!;
        expect(latest.lodBuilt).toBe(latest.lodTotal);
        expect(latest.lodBuilt).toBeGreaterThan(1);
        publishedCounts.push(latest.totalReceived);
        // Live stats counters alone cannot prove that a coarse hierarchy was rebuilt.
        const completedTiers = levels.filter((level) => level.name === "1M");
        expect(completedTiers.length).toBeGreaterThan(0);
        const finalTier = completedTiers[completedTiers.length - 1]!;
        aggregatedEnds.push(finalTier.sourceEndTimestamp![finalTier.length - 1]!);
        harness.messages.length = 0;
        levels.length = 0;
      }

      expect(publishedCounts[0]).toBeGreaterThan(1100);
      expect(publishedCounts[1]).toBeGreaterThan(publishedCounts[0]!);
      expect(publishedCounts[2]).toBeGreaterThan(publishedCounts[1]!);
      expect(aggregatedEnds[0]).toBeGreaterThan(START + 1099 * MINUTE);
      expect(aggregatedEnds[1]).toBeGreaterThan(aggregatedEnds[0]!);
      expect(aggregatedEnds[2]).toBeGreaterThan(aggregatedEnds[1]!);
      expect(harness.reportError).not.toHaveBeenCalled();
      clearInterval(stream);

      vi.advanceTimersByTime(1000);
      const finalTier = levels.filter((level) => level.name === "1M").at(-1)!;
      expect(finalTier.sourceEndTimestamp![finalTier.length - 1]).toBe(
        START + (nextIndex - 1) * MINUTE,
      );
      expect(harness.stats().at(-1)).toMatchObject({ lodReady: true, totalReceived: nextIndex });
    },
  );

  for (const timeScale of ["continuous", "market"] as const) {
    it.each([
      { description: "reaches capacity, then evicts a candle", firstAppend: 4, secondAppend: 1 },
      { description: "crosses its first wrap in one batch", firstAppend: 8, secondAppend: 0 },
      { description: "wraps multiple times in one batch", firstAppend: 2300, secondAppend: 0 },
    ])(
      "keeps one coherent $description snapshot in " + timeScale + " time",
      ({ firstAppend, secondAppend }) => {
        const harness = createHarness(1104, timeScale);
        const levels = recordAggregations();
        const expected = expectedAggregations(0, 1100, timeScale === "market");
        append(harness.engine, 0, 1100, true);
        vi.advanceTimersByTime(16);
        append(harness.engine, 1100, firstAppend);
        if (secondAppend > 0) {
          vi.advanceTimersByTime(16);
          append(harness.engine, 1100 + firstAppend, secondAppend);
        }

        vi.advanceTimersByTime(80);

        expect(harness.reportError).not.toHaveBeenCalled();
        expect(harness.drawImage).toHaveBeenCalled();
        // The real reducer runs at every tier. All first-build OHLCV, timestamps,
        // source-end timestamps and market coordinates must describe the same seed.
        expect(levels.slice(0, expected.length)).toEqual(expected);
      },
    );

    it("keeps a full, already-rotated ring snapshot coherent in " + timeScale + " time", () => {
      const harness = createHarness(1104, timeScale);
      append(harness.engine, 0, 1100, true);
      vi.advanceTimersByTime(200);
      append(harness.engine, 1100, 8);
      const levels = recordAggregations();
      const expected = expectedAggregations(4, 1104, timeScale === "market");
      vi.advanceTimersByTime(116);
      append(harness.engine, 1108, 8);

      vi.advanceTimersByTime(80);

      expect(harness.reportError).not.toHaveBeenCalled();
      expect(levels.slice(0, expected.length)).toEqual(expected);
    });

    it("protects the snapshot between deferred bulk chunks in " + timeScale + " time", () => {
      const harness = createHarness(1104, timeScale);
      const levels = recordAggregations();
      const expected = expectedAggregations(0, 1100, timeScale === "market");
      append(harness.engine, 0, 1100, true);
      vi.advanceTimersByTime(16);

      harness.engine.handleMessage("addCandleBatches", {
        batches: [candles(1100, 4), candles(1104, 2300)],
        initialTimeRange: "ALL",
      });
      vi.advanceTimersByTime(80);

      expect(harness.reportError).not.toHaveBeenCalled();
      expect(harness.drawImage).toHaveBeenCalled();
      expect(levels.slice(0, expected.length)).toEqual(expected);
    });
  }

  it("does not publish an interrupted streaming build after setData replaces it", () => {
    const harness = createHarness();
    const levels = recordAggregations();
    append(harness.engine, 0, 1100, true);
    vi.advanceTimersByTime(15);
    const replacement = candles(10_000, 1200);
    levels.length = 0;
    harness.engine.handleMessage("setData", replacement);
    harness.messages.length = 0;

    vi.advanceTimersByTime(1000);

    const completed = harness.stats().filter((stats) => stats.lodReady);
    expect(completed.length).toBeGreaterThan(0);
    for (const stats of completed) {
      expect(stats.totalCandles).toBe(1200);
      expect(stats.dataBounds.xMin).toBe(replacement.timestamp[0]);
      expect(stats.dataBounds.xMax).toBe(replacement.timestamp[1199]);
    }
    expect(harness.reportError).not.toHaveBeenCalled();
    expect(levels).toEqual(expectedAggregations(10_000, 1200));
  });

  it("does not publish an interrupted build after reinitializing streaming", () => {
    const harness = createHarness();
    const levels = recordAggregations();
    append(harness.engine, 0, 1100, true);
    vi.advanceTimersByTime(15);
    levels.length = 0;
    harness.engine.handleMessage("initRingBuffer", { maxCandles: 2048 });
    append(harness.engine, 20_000, 1200, true);
    harness.messages.length = 0;

    vi.advanceTimersByTime(1000);

    const completed = harness.stats().filter((stats) => stats.lodReady);
    expect(completed.length).toBeGreaterThan(0);
    for (const stats of completed) {
      expect(stats.totalCandles).toBe(1200);
      expect(stats.totalReceived).toBe(1200);
      expect(stats.dataBounds.xMin).toBe(START + 20_000 * MINUTE);
      expect(stats.dataBounds.xMax).toBe(START + 21_199 * MINUTE);
    }
    expect(harness.reportError).not.toHaveBeenCalled();
    expect(levels).toEqual(expectedAggregations(20_000, 1200));
  });

  it("stops pending aggregation and render callbacks without later publications", () => {
    const harness = createHarness();
    const levels = recordAggregations();
    append(harness.engine, 0, 1100, true);
    vi.advanceTimersByTime(15);
    harness.engine.handleMessage("stop", {});
    expect(vi.getTimerCount()).toBe(0);
    harness.messages.length = 0;
    harness.drawImage.mockClear();
    levels.length = 0;

    vi.advanceTimersByTime(1000);

    expect(harness.messages).toEqual([]);
    expect(harness.drawImage).not.toHaveBeenCalled();
    expect(harness.reportError).not.toHaveBeenCalled();
    expect(levels).toEqual([]);
  });
});
