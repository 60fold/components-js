import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStockEngineState } from "@test/support/engineState";
import { createStockChartEngine, type StockChartEngine } from "./stockRenderer.js";
import * as aggregation from "./engine/aggregation.js";
import { StockLevelAccess, type AggregatedLevel } from "./engine/levels.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const aggregateLevel = aggregation.aggregateLevel;

function candles(timestamps: readonly number[]) {
  return {
    timestamp: Float64Array.from(timestamps),
    open: Float64Array.from(timestamps, () => 100),
    high: Float64Array.from(timestamps, () => 105),
    low: Float64Array.from(timestamps, () => 95),
    close: Float64Array.from(timestamps, () => 102),
    volume: Float64Array.from(timestamps, () => 10),
  };
}

function append(engine: StockChartEngine, timestamps: readonly number[]) {
  const data = candles(timestamps);
  engine.handleMessage("addCandles", {
    timestamps: data.timestamp,
    opens: data.open,
    highs: data.high,
    lows: data.low,
    closes: data.close,
    volumes: data.volume,
  });
}

function createCanvasStub(width = 800, height = 600) {
  const gradient = { addColorStop: () => {} } as CanvasGradient;
  const context = new Proxy({} as CanvasRenderingContext2D, {
    get: (_target, property) => {
      if (property === "measureText") return () => ({ width: 40 }) as TextMetrics;
      if (property === "createLinearGradient") return () => gradient;
      if (property === "createPattern") return () => null;
      return () => {};
    },
    set: () => true,
  });
  return { width, height, getContext: () => context };
}

const engines: StockChartEngine[] = [];

function createHarness(ssr = true, animated = false, minViewportRange = 1) {
  const messages: Array<Record<string, unknown>> = [];
  const reportError = vi.fn();
  const engine = createStockChartEngine(
    { postMessage: (message) => messages.push(message), reportError },
    { ssr, createCanvas: createCanvasStub },
  );
  engines.push(engine);
  engine.handleMessage("init", {
    canvas: createCanvasStub(),
    dpr: 1,
    config: {
      animated,
      timeScale: "market",
      // Keep timestamp-anchoring assertions independent of the stock default
      // minimum range: a compressed one-minute window is valid in these tests.
      minViewportRange,
      showVolume: false,
      rangeSelector: { visible: false },
      yDomain: { min: 0, max: 200 },
    },
  });
  engine.handleMessage("resize", { width: 800, height: 600, dpr: 1 });
  messages.length = 0;
  return {
    engine,
    messages,
    reportError,
    state: () => getStockEngineState(engine),
    lastSync: () => messages.filter((message) => message.type === "viewportSync").at(-1),
    lastStats: () => messages.filter((message) => message.type === "stats").at(-1),
  };
}

describe("stock market-time streaming cadence", () => {
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

  it.each(["bulk", "separate appends", "candle batches"] as const)(
    "matches static gap compression when the initial cadence is learned through %s",
    (installation) => {
      const timestamps = [0, 3 * DAY, 3 * DAY + MINUTE];
      const reference = createHarness();
      reference.engine.handleMessage("setData", candles(timestamps));
      const streaming = createHarness();
      streaming.engine.handleMessage("initRingBuffer", { maxCandles: 10 });

      if (installation === "bulk") {
        append(streaming.engine, timestamps);
      } else if (installation === "separate appends") {
        for (const timestamp of timestamps) append(streaming.engine, [timestamp]);
      } else {
        streaming.engine.handleMessage("addCandleBatches", {
          batches: [candles(timestamps.slice(0, 2)), candles(timestamps.slice(2))],
          initialTimeRange: "ALL",
        });
      }

      expect(reference.state().dataBounds).toMatchObject({ xMin: 0, xMax: 2 * MINUTE });
      expect(streaming.state().dataBounds).toEqual(reference.state().dataBounds);
      expect(streaming.lastSync()).toMatchObject({
        timeDataBounds: { xMin: timestamps[0], xMax: timestamps[2] },
      });
      expect(streaming.reportError).not.toHaveBeenCalled();
    },
  );

  it("keeps a historical viewport anchored to timestamps when later input lowers the cadence", () => {
    const harness = createHarness();
    harness.engine.handleMessage("initRingBuffer", { maxCandles: 10 });
    append(harness.engine, [0, HOUR, 3 * DAY, 3 * DAY + HOUR]);
    harness.engine.handleMessage("setTimeViewportRange", { xMin: 0, xMax: HOUR });
    expect(harness.lastSync()).toMatchObject({ timeViewport: { xMin: 0, xMax: HOUR } });

    append(harness.engine, [3 * DAY + HOUR + MINUTE]);

    expect(harness.state().dataBounds).toMatchObject({ xMin: 0, xMax: 4 * MINUTE });
    expect(harness.state().viewport).toMatchObject({ xMin: 0, xMax: MINUTE });
    expect(harness.lastSync()).toMatchObject({ timeViewport: { xMin: 0, xMax: HOUR } });
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it("honors the configured minimum range when a historical window becomes narrower", () => {
    const harness = createHarness(true, false, 2 * MINUTE);
    harness.engine.handleMessage("initRingBuffer", { maxCandles: 10 });
    append(harness.engine, [0, HOUR, 3 * DAY, 3 * DAY + HOUR]);
    harness.engine.handleMessage("setTimeViewportRange", { xMin: 0, xMax: HOUR });
    expect(harness.lastSync()).toMatchObject({ timeViewport: { xMin: 0, xMax: HOUR } });

    append(harness.engine, [3 * DAY + HOUR + MINUTE]);

    // Preserving both original endpoints would yield only one market minute.
    // Retain the left anchor and expand to the configured two-minute minimum.
    expect(harness.state().viewport).toMatchObject({ xMin: 0, xMax: 2 * MINUTE });
    expect(harness.lastSync()).toMatchObject({ timeViewport: { xMin: 0, xMax: 3 * DAY } });
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it("remaps live selection anchors and clears grid fades from the old coordinates", () => {
    const harness = createHarness(false);
    harness.engine.handleMessage("initRingBuffer", { maxCandles: 10 });
    append(harness.engine, [0, HOUR, 3 * DAY, 3 * DAY + HOUR]);
    vi.advanceTimersByTime(500);
    harness.engine.handleMessage("setSelection", { start: HOUR, end: 2 * HOUR });
    const state = harness.state();
    state.xGridAlphas.set(HOUR, 0.5);
    state.xGridAlphas.set(2 * HOUR, 0.75);

    append(harness.engine, [3 * DAY + HOUR + MINUTE]);

    // The selection still spans the same HOUR and 3 * DAY observations.
    expect(state.selectionStart).toBe(MINUTE);
    expect(state.selectionEnd).toBe(2 * MINUTE);
    expect(state.xGridAlphas.size).toBe(0);
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it("recompresses retained candles in chronological order after the ring wraps", () => {
    const timestamps = [0, HOUR, 3 * DAY, 3 * DAY + HOUR, 3 * DAY + HOUR + MINUTE];
    const harness = createHarness();
    harness.engine.handleMessage("initRingBuffer", { maxCandles: 4 });
    append(harness.engine, timestamps.slice(0, 4));
    append(harness.engine, timestamps.slice(4));
    const reference = createHarness();
    reference.engine.handleMessage("setData", candles(timestamps.slice(1)));
    const actualBounds = harness.state().dataBounds;
    const expectedBounds = reference.state().dataBounds;

    // Rings may retain a nonzero coordinate origin; the retained market span
    // and timestamp mapping must still match the same static candles.
    expect(actualBounds.xMax - actualBounds.xMin).toBe(expectedBounds.xMax - expectedBounds.xMin);
    expect(harness.lastSync()).toMatchObject({
      timeDataBounds: { xMin: HOUR, xMax: timestamps[4] },
    });
    harness.engine.handleMessage("setTimeViewportRange", {
      xMin: 3 * DAY,
      xMax: 3 * DAY + HOUR,
    });
    const viewport = harness.state().viewport;
    expect(viewport.xMax - viewport.xMin).toBe(MINUTE);
    expect(harness.lastSync()).toMatchObject({
      timeViewport: { xMin: 3 * DAY, xMax: 3 * DAY + HOUR },
    });
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it("keeps an active viewport animation aimed at the same timestamps after recompression", () => {
    const harness = createHarness(false, true);
    harness.engine.handleMessage("initRingBuffer", { maxCandles: 10 });
    append(harness.engine, [0, HOUR, 3 * DAY, 3 * DAY + HOUR]);
    vi.advanceTimersByTime(500);
    harness.engine.handleMessage("setTimeViewportRangeAnimated", { xMin: 0, xMax: HOUR });
    expect(harness.state().viewportAnimation).toMatchObject({
      active: true,
      fromViewport: { xMin: 0, xMax: 3 * HOUR },
      toViewport: { xMin: 0, xMax: HOUR },
    });

    append(harness.engine, [3 * DAY + HOUR + MINUTE]);

    expect(harness.state().viewportAnimation).toMatchObject({
      active: true,
      fromViewport: { xMin: 0, xMax: 3 * MINUTE },
      toViewport: { xMin: 0, xMax: MINUTE },
    });
    vi.advanceTimersByTime(1000);
    expect(harness.state().viewportAnimation.active).toBe(false);
    expect(harness.lastSync()).toMatchObject({ timeViewport: { xMin: 0, xMax: HOUR } });
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it("drops a settled hierarchy with obsolete coordinates until its replacement is published", () => {
    const timestamps = Array.from({ length: 1100 }, (_, index) => index * HOUR);
    const harness = createHarness(false);
    harness.engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    harness.engine.handleMessage("initRingBuffer", { maxCandles: 4096 });
    append(harness.engine, timestamps);
    vi.advanceTimersByTime(500);
    expect(harness.lastStats()).toMatchObject({ lodReady: true, lodBuilt: 5 });
    expect(harness.lastStats()?.lodLevel).toBeGreaterThan(0);
    harness.messages.length = 0;

    append(harness.engine, [timestamps[timestamps.length - 1]! + MINUTE]);
    // One frame elapses while the replacement's remaining tiers are in flight.
    vi.advanceTimersByTime(16);

    expect(harness.lastStats()).toMatchObject({
      totalCandles: 1101,
      lodReady: false,
      lodBuilt: 1,
      lodLevel: 0,
      aggregation: "1m",
    });
    vi.advanceTimersByTime(1000);
    expect(harness.lastStats()).toMatchObject({ lodReady: true, lodBuilt: 8 });
    expect(harness.lastStats()?.lodLevel).toBeGreaterThan(0);
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it("keeps a wrapped coordinate origin and settled hierarchy when cadence is unchanged", () => {
    const capacity = 1100;
    const harness = createHarness(false);
    harness.engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    harness.engine.handleMessage("initRingBuffer", { maxCandles: capacity });
    append(
      harness.engine,
      Array.from({ length: capacity + 10 }, (_, index) => index * MINUTE),
    );
    vi.advanceTimersByTime(500);
    expect(harness.state().dataBounds).toMatchObject({ xMin: 10 * MINUTE, xMax: 1109 * MINUTE });
    expect(harness.lastStats()).toMatchObject({ lodReady: true, lodBuilt: 8 });
    expect(harness.lastStats()?.lodLevel).toBeGreaterThan(0);
    harness.messages.length = 0;

    append(harness.engine, [1110 * MINUTE]);
    vi.advanceTimersByTime(16);

    expect(harness.state().dataBounds).toMatchObject({ xMin: 11 * MINUTE, xMax: 1110 * MINUTE });
    // An ordinary append keeps the old hierarchy usable through the debounce;
    // it must not trigger the raw-only fallback required for coordinate rebases.
    expect(harness.lastStats()).toMatchObject({
      totalCandles: capacity,
      totalReceived: capacity + 11,
      lodReady: true,
      lodBuilt: 8,
    });
    expect(harness.lastStats()?.lodLevel).toBeGreaterThan(0);
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it("publishes a consistent replacement hierarchy after cadence changes during an LOD build", () => {
    const levels: AggregatedLevel[] = [];
    vi.spyOn(aggregation, "aggregateLevel").mockImplementation((...args) => {
      const level = aggregateLevel(...args);
      levels.push(level);
      return level;
    });
    const initial = Array.from({ length: 1100 }, (_, index) =>
      index < 2 ? index * HOUR : 3 * DAY + (index - 2) * HOUR,
    );
    const timestamps = [...initial, initial[initial.length - 1]! + MINUTE];
    const harness = createHarness(false);
    harness.engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    harness.engine.handleMessage("initRingBuffer", { maxCandles: 4096 });
    append(harness.engine, initial);
    // The first tier is synchronous; remaining tiers are scheduled 10 ms apart.
    expect(levels).toHaveLength(1);
    expect(levels[0]!.name).toBe("4H");
    append(harness.engine, timestamps.slice(-1));
    vi.advanceTimersByTime(1000);

    const source: AggregatedLevel = {
      ...candles(timestamps),
      name: "1m",
      interval: MINUTE,
      length: timestamps.length,
      marketX: Float64Array.from(timestamps, (_, index) => index * MINUTE),
    };
    const access = new StockLevelAccess({
      logicalToPhysicalIndex: (index) => index,
      getRawMarketX: (index) => index * MINUTE,
      usesMarketTime: () => true,
    });
    for (const definition of aggregation.STOCK_AGGREGATION_LEVELS) {
      if (definition.interval <= MINUTE) continue;
      const latest = levels.filter((level) => level.name === definition.name).at(-1);
      expect(latest, `latest ${definition.name} hierarchy`).toEqual(
        aggregateLevel(source, definition, access, true),
      );
    }
    expect(harness.state().dataBounds).toMatchObject({
      xMin: 0,
      xMax: (timestamps.length - 1) * MINUTE,
    });
    expect(harness.messages.filter((message) => message.type === "stats").at(-1)).toMatchObject({
      totalCandles: timestamps.length,
      totalReceived: timestamps.length,
      lodReady: true,
    });
    expect(harness.reportError).not.toHaveBeenCalled();
  });
});
