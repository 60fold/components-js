import { describe, expect, it, vi } from "vitest";
import { HOUR } from "@sixtyfold/core/chart/chartConstants";
import { getStockEngineState } from "@test/support/engineState";
import { createStockChartEngine } from "./stockRenderer.js";

interface RecordedPathPoint {
  command: "moveTo" | "lineTo";
  x: number;
  y: number;
}

interface RecordedText {
  text: string;
  x: number;
  y: number;
}

interface RecordedContextCall {
  command: "save" | "beginPath" | "rect" | "clip" | "restore";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

function createContextStub(
  pathPoints?: RecordedPathPoint[],
  textDraws?: RecordedText[],
  contextCalls?: RecordedContextCall[],
): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => {} } as CanvasGradient;
  return new Proxy({} as CanvasRenderingContext2D, {
    get: (_target, prop) => {
      if (prop === "measureText") return () => ({ width: 40 }) as TextMetrics;
      if (prop === "createLinearGradient") return () => gradient;
      if (prop === "createPattern") return () => null;
      if ((prop === "moveTo" || prop === "lineTo") && pathPoints) {
        return (x: number, y: number) => {
          pathPoints.push({ command: prop, x, y });
        };
      }
      if (prop === "fillText" && textDraws) {
        return (text: string, x: number, y: number) => {
          textDraws.push({ text, x, y });
        };
      }
      if (prop === "clearRect" && pathPoints) {
        return () => {
          pathPoints.length = 0;
        };
      }
      if (
        contextCalls &&
        (prop === "save" || prop === "beginPath" || prop === "clip" || prop === "restore")
      ) {
        return () => {
          contextCalls.push({ command: prop });
        };
      }
      if (prop === "rect" && contextCalls) {
        return (x: number, y: number, width: number, height: number) => {
          contextCalls.push({ command: "rect", x, y, width, height });
        };
      }
      return () => {};
    },
    set: () => true,
  });
}

function createCanvasStub(
  width = 800,
  height = 600,
  pathPoints?: RecordedPathPoint[],
  textDraws?: RecordedText[],
  contextCalls?: RecordedContextCall[],
) {
  const context = createContextStub(pathPoints, textDraws, contextCalls);
  return { width, height, getContext: () => context };
}

function createHarness(
  animated = false,
  minViewportRange?: number,
  width = 800,
  timeScale: "continuous" | "market" = "continuous",
  textDraws?: RecordedText[],
  yDomain?: { min?: number; max?: number },
) {
  const messages: Array<Record<string, unknown>> = [];
  const engine = createStockChartEngine(
    { postMessage: (message) => messages.push(message) },
    {
      ssr: true,
      createCanvas: (width, height) => createCanvasStub(width, height, undefined, textDraws),
    },
  );

  engine.handleMessage("init", {
    canvas: createCanvasStub(width, 600, undefined, textDraws),
    dpr: 1,
    config: {
      animated,
      minViewportRange,
      yDomain,
      timeScale,
      rangeSelector: { visible: false },
    },
  });
  engine.handleMessage("resize", { width, height: 600, dpr: 1 });
  messages.length = 0;

  return { engine, messages };
}

function expectOnlyViewportSync(
  messages: Array<Record<string, unknown>>,
  xMin: number,
  xMax: number,
  dataXMin = xMin,
  dataXMax = xMax,
  viewportRequestId?: number,
) {
  expect(messages.filter((message) => message.type === "stats")).toHaveLength(0);
  expect(messages.filter((message) => message.type === "viewportSync")).toEqual([
    {
      type: "viewportSync",
      viewport: { xMin, xMax },
      dataBounds: { xMin: dataXMin, xMax: dataXMax },
      ...(viewportRequestId === undefined ? {} : { viewportRequestId }),
    },
  ]);
}

describe("stock renderer viewport synchronization", () => {
  it("keeps a fixed Y domain stable across streamed candle extrema", () => {
    const { engine } = createHarness(false, undefined, 800, "continuous", undefined, {
      min: 50,
      max: 250,
    });
    engine.handleMessage("initRingBuffer", { maxCandles: 1_024 });
    engine.handleMessage("addCandles", {
      timestamps: new Float64Array([1, 2, 3]),
      opens: new Float64Array([100, 110, 120]),
      highs: new Float64Array([110, 120, 130]),
      lows: new Float64Array([90, 100, 110]),
      closes: new Float64Array([105, 115, 125]),
      volumes: new Float64Array([1, 2, 3]),
    });
    expect(getStockEngineState(engine).viewport).toMatchObject({
      yMin: 50,
      yMax: 250,
    });

    engine.handleMessage("addCandles", {
      timestamps: new Float64Array([4]),
      opens: new Float64Array([500]),
      highs: new Float64Array([600]),
      lows: new Float64Array([-100]),
      closes: new Float64Array([550]),
      volumes: new Float64Array([4]),
    });
    expect(getStockEngineState(engine).viewport).toMatchObject({
      yMin: 50,
      yMax: 250,
    });
  });

  it("infers one-second source cadence and renders an intraday aggregation", () => {
    const { engine, messages } = createHarness(false, 1_000);
    const length = 6 * 60 * 60;
    const timestamp = new Float64Array(length);
    const open = new Float64Array(length);
    const high = new Float64Array(length);
    const low = new Float64Array(length);
    const close = new Float64Array(length);
    const volume = new Float64Array(length);
    for (let index = 0; index < length; index++) {
      timestamp[index] = index * 1_000;
      open[index] = 100 + Math.sin(index / 600);
      high[index] = open[index] + 1;
      low[index] = open[index] - 1;
      close[index] = open[index] + 0.25;
      volume[index] = 10 + (index % 7);
    }

    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 0 });
    engine.handleMessage("setData", {
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    });

    const stats = messages.filter((message) => message.type === "stats").at(-1);
    expect(stats).toMatchObject({
      totalCandles: length,
      aggregation: "5m",
      lodBuilt: 9,
      lodTotal: 9,
    });
    expect(Number(stats?.visibleCandles)).toBeGreaterThanOrEqual(70);
    expect(Number(stats?.visibleCandles)).toBeLessThan(80);
  });

  it("preserves hourly raw-candle selection without a duplicate 1H level", () => {
    const { engine, messages } = createHarness();
    const length = 96;
    const timestamp = Float64Array.from({ length }, (_, index) => index * HOUR);
    const open = Float64Array.from({ length }, (_, index) => 100 + index);
    const high = Float64Array.from(open, (value) => value + 2);
    const low = Float64Array.from(open, (value) => value - 2);
    const close = Float64Array.from(open, (value) => value + 1);
    const volume = Float64Array.from({ length }, () => 1_000);

    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 0 });
    engine.handleMessage("setData", {
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    });

    expect(messages.filter((message) => message.type === "stats").at(-1)).toMatchObject({
      totalCandles: length,
      aggregation: "1H",
      lodBuilt: 5,
      lodTotal: 5,
    });
  });

  it("keeps a compact one-month viewport at daily candle density", () => {
    const { engine, messages } = createHarness(false, undefined, 320);
    const minute = 60_000;
    const length = 31 * 24 * 60;
    const timestamp = Float64Array.from({ length }, (_, index) => index * minute);
    const open = Float64Array.from({ length }, (_, index) => 100 + Math.sin(index / 1_440));
    const high = Float64Array.from(open, (value) => value + 1);
    const low = Float64Array.from(open, (value) => value - 1);
    const close = Float64Array.from(open, (value) => value + 0.25);
    const volume = Float64Array.from({ length }, () => 100);

    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 0 });
    engine.handleMessage("setData", {
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    });

    expect(messages.filter((message) => message.type === "stats").at(-1)).toMatchObject({
      totalCandles: length,
      aggregation: "1D",
    });
  });

  it("compresses inactive market gaps and resolves presets by observed sessions", () => {
    const minute = 60_000;
    const day = 24 * HOUR;
    const sessions = 30;
    const candlesPerSession = 60;
    const length = sessions * candlesPerSession;
    const timestamp = new Float64Array(length);
    for (let session = 0; session < sessions; session++) {
      const sessionStart = Date.UTC(2024, 0, 2, 14, 30) + session * day;
      for (let candle = 0; candle < candlesPerSession; candle++) {
        timestamp[session * candlesPerSession + candle] = sessionStart + candle * minute;
      }
    }
    const open = Float64Array.from({ length }, (_, index) => 100 + index / 100);
    const high = Float64Array.from(open, (value) => value + 1);
    const low = Float64Array.from(open, (value) => value - 1);
    const close = Float64Array.from(open, (value) => value + 0.25);
    const volume = Float64Array.from({ length }, () => 100);
    const { engine, messages } = createHarness(false, minute * 30, 800, "market");

    engine.handleMessage("setData", {
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    });

    const elapsedRange = timestamp[length - 1] - timestamp[0];
    const marketRange =
      getStockEngineState(engine).dataBounds.xMax - getStockEngineState(engine).dataBounds.xMin;
    expect(marketRange).toBeLessThan(elapsedRange / 10);

    messages.length = 0;
    engine.handleMessage("setTimeRange", { range: "1M" });
    const monthSync = messages.filter((message) => message.type === "viewportSync").at(-1);
    expect(monthSync).toMatchObject({
      timeViewport: {
        xMin: timestamp[(sessions - 21) * candlesPerSession],
        xMax: timestamp[length - 1],
      },
    });
    expect(monthSync).not.toHaveProperty("timeRangeAvailability");

    messages.length = 0;
    engine.handleMessage("setTimeRange", { range: "1D" });
    expect(messages.filter((message) => message.type === "viewportSync").at(-1)).toMatchObject({
      timeViewport: {
        xMin: timestamp[(sessions - 1) * candlesPerSession],
        xMax: timestamp[length - 1],
      },
    });
  });

  it("moves data-anchored market-time grid labels while panning", () => {
    const textDraws: RecordedText[] = [];
    const { engine } = createHarness(false, HOUR, 800, "market", textDraws);
    const length = 10 * 24;
    const timestamp = Float64Array.from(
      { length },
      (_, index) => Date.UTC(2024, 0, 1) + index * HOUR,
    );
    const open = Float64Array.from({ length }, (_, index) => 100 + index / 10);
    const high = Float64Array.from(open, (value) => value + 1);
    const low = Float64Array.from(open, (value) => value - 1);
    const close = Float64Array.from(open, (value) => value + 0.25);
    const volume = Float64Array.from({ length }, () => 100);

    engine.handleMessage("setData", {
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    });
    textDraws.length = 0;
    engine.handleMessage("setTimeRange", { range: "1D" });

    const state = getStockEngineState(engine);
    const labelY =
      state.chartTop + state.chartHeight + 20 + Math.max(0, state.bottomAxisTickLength);
    const before = textDraws
      .filter((draw) => Math.abs(draw.y - labelY) < 0.01)
      .map((draw) => Number(draw.x.toFixed(3)));
    expect(before.length).toBeGreaterThan(2);

    textDraws.length = 0;
    engine.handleMessage("pan", { dx: -0.1 });
    const after = textDraws
      .filter((draw) => Math.abs(draw.y - labelY) < 0.01)
      .map((draw) => Number(draw.x.toFixed(3)));

    expect(after.length).toBeGreaterThan(2);
    expect(after).not.toEqual(before);
  });

  it("anchors the coarse range preview to the full raw data extent", () => {
    const width = 800;
    const previewPath: RecordedPathPoint[] = [];
    const previewCalls: RecordedContextCall[] = [];
    const engine = createStockChartEngine(
      { postMessage: () => {} },
      {
        ssr: true,
        createCanvas: (canvasWidth, canvasHeight) =>
          createCanvasStub(
            canvasWidth,
            canvasHeight,
            canvasHeight === 60 ? previewPath : undefined,
            undefined,
            canvasHeight === 60 ? previewCalls : undefined,
          ),
      },
    );
    engine.handleMessage("init", {
      canvas: createCanvasStub(width, 600),
      dpr: 1,
      config: {
        animated: false,
        timeScale: "market",
        rangeSelector: { visible: true, height: 60 },
      },
    });
    engine.handleMessage("resize", { width, height: 600, dpr: 1 });

    const length = 365;
    const timestamp = Float64Array.from(
      { length },
      (_, index) => Date.UTC(2024, 0, 2) + index * 24 * HOUR,
    );
    const open = Float64Array.from({ length }, (_, index) => 100 + index);
    const high = Float64Array.from(open, (value) => value + 2);
    const low = Float64Array.from(open, (value) => value - 2);
    const close = Float64Array.from(open, (value) => value + 1);
    const volume = Float64Array.from({ length }, () => 1_000);
    engine.handleMessage("setData", {
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    });

    const state = getStockEngineState(engine);
    expect(previewPath[0]).toMatchObject({
      command: "moveTo",
      x: state.padding.left,
    });
    expect(previewPath.at(-1)).toMatchObject({
      command: "lineTo",
      x: width - state.padding.right,
    });
    expect(previewCalls).toEqual(
      expect.arrayContaining([
        { command: "save" },
        { command: "beginPath" },
        {
          command: "rect",
          x: state.padding.left,
          y: 0,
          width: width - state.padding.left - state.padding.right,
          height: 60,
        },
        { command: "clip" },
        { command: "restore" },
      ]),
    );
  });

  it("honors a configured minimum X viewport range", () => {
    const { engine, messages } = createHarness(false, 4 * HOUR);
    engine.handleMessage("setData", {
      timestamp: new Float64Array([0, 5 * HOUR, 10 * HOUR]),
      open: new Float64Array([100, 101, 102]),
      high: new Float64Array([102, 103, 104]),
      low: new Float64Array([99, 100, 101]),
      close: new Float64Array([101, 102, 103]),
      volume: new Float64Array([1_000, 2_000, 3_000]),
    });

    engine.handleMessage("zoom", { factor: 0.5, centerX: 5 * HOUR });
    expect(
      getStockEngineState(engine).viewport.xMax - getStockEngineState(engine).viewport.xMin,
    ).toBe(5 * HOUR);

    messages.length = 0;
    engine.handleMessage("zoom", { factor: 0.5, centerX: 5 * HOUR });
    expect(
      getStockEngineState(engine).viewport.xMax - getStockEngineState(engine).viewport.xMin,
    ).toBe(5 * HOUR);
    expect(messages.filter((message) => message.type === "viewportSync")).toHaveLength(0);
  });

  it("synchronizes static data bounds without enabling stats", () => {
    const { engine, messages } = createHarness();

    engine.handleMessage("setData", {
      timestamp: new Float64Array([10, 20]),
      open: new Float64Array([100, 101]),
      high: new Float64Array([102, 103]),
      low: new Float64Array([99, 100]),
      close: new Float64Array([101, 102]),
      volume: new Float64Array([1_000, 2_000]),
    });

    expectOnlyViewportSync(messages, 10, 20);
  });

  it("synchronizes streamed data bounds without enabling stats", () => {
    const { engine, messages } = createHarness();

    engine.handleMessage("initRingBuffer", { maxCandles: 4 });
    engine.handleMessage("addCandles", {
      timestamps: new Float64Array([100, 200]),
      opens: new Float64Array([100, 101]),
      highs: new Float64Array([102, 103]),
      lows: new Float64Array([99, 100]),
      closes: new Float64Array([101, 102]),
      volumes: new Float64Array([1_000, 2_000]),
    });

    expectOnlyViewportSync(messages, 100, 200);
  });

  it("synchronizes every instant viewport command without stats or duplicate frames", () => {
    const { engine, messages } = createHarness();
    engine.handleMessage("setData", {
      timestamp: new Float64Array([0, 5 * HOUR, 10 * HOUR]),
      open: new Float64Array([100, 101, 102]),
      high: new Float64Array([102, 103, 104]),
      low: new Float64Array([99, 100, 101]),
      close: new Float64Array([101, 102, 103]),
      volume: new Float64Array([1_000, 2_000, 3_000]),
    });

    messages.length = 0;
    engine.handleMessage("zoom", { factor: 0.5, centerX: 5 * HOUR });
    expectOnlyViewportSync(messages, 2.5 * HOUR, 7.5 * HOUR, 0, 10 * HOUR);

    messages.length = 0;
    engine.handleMessage("pan", { dx: 0.1 });
    expectOnlyViewportSync(messages, 3 * HOUR, 8 * HOUR, 0, 10 * HOUR);

    messages.length = 0;
    engine.handleMessage("reset", {});
    expectOnlyViewportSync(messages, 0, 10 * HOUR, 0, 10 * HOUR);

    messages.length = 0;
    engine.handleMessage("setViewportRange", { xMin: 2 * HOUR, xMax: 6 * HOUR });
    expectOnlyViewportSync(messages, 2 * HOUR, 6 * HOUR, 0, 10 * HOUR);
  });

  it("synchronizes an instant stock time-range command", () => {
    const { engine, messages } = createHarness();
    engine.handleMessage("setData", {
      timestamp: new Float64Array([0, 24 * HOUR, 48 * HOUR]),
      open: new Float64Array([100, 101, 102]),
      high: new Float64Array([102, 103, 104]),
      low: new Float64Array([99, 100, 101]),
      close: new Float64Array([101, 102, 103]),
      volume: new Float64Array([1_000, 2_000, 3_000]),
    });

    messages.length = 0;
    engine.handleMessage("setTimeRange", { range: "1D" });
    expectOnlyViewportSync(messages, 24 * HOUR, 48 * HOUR, 0, 48 * HOUR);
  });

  it("correlates an animated command only with its settled viewport", () => {
    const { engine, messages } = createHarness(true);
    engine.handleMessage("setData", {
      timestamp: new Float64Array([0, 5 * HOUR, 10 * HOUR]),
      open: new Float64Array([100, 101, 102]),
      high: new Float64Array([102, 103, 104]),
      low: new Float64Array([99, 100, 101]),
      close: new Float64Array([101, 102, 103]),
      volume: new Float64Array([1_000, 2_000, 3_000]),
    });
    messages.length = 0;

    engine.handleMessage("setViewportRangeAnimated", {
      xMin: 2 * HOUR,
      xMax: 6 * HOUR,
      viewportRequestId: 73,
    });
    const state = getStockEngineState(engine);
    messages.length = 0;

    state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration / 2;
    engine.handleMessage("setSelection", {
      start: 2 * HOUR,
      end: 6 * HOUR,
      viewportRequestId: 99,
    });
    const intermediateSyncs = messages.filter((message) => message.type === "viewportSync");
    expect(intermediateSyncs).toHaveLength(1);
    expect(intermediateSyncs[0]).not.toHaveProperty("viewportRequestId");
    expect(state.viewportAnimation.active).toBe(true);

    messages.length = 0;
    state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration - 1;

    engine.handleMessage("setSelection", { start: 2 * HOUR, end: 6 * HOUR });
    expect(state.viewportAnimation.active).toBe(false);
    expectOnlyViewportSync(messages, 2 * HOUR, 6 * HOUR, 0, 10 * HOUR, 73);

    messages.length = 0;
    engine.handleMessage("setSelection", { start: 2 * HOUR, end: 6 * HOUR });
    expect(messages.filter((message) => message.type === "viewportSync")).toHaveLength(0);
  });

  it("does not replay a consumed correlation id on a later uncorrelated animation", () => {
    const { engine, messages } = createHarness(true);
    engine.handleMessage("setData", {
      timestamp: new Float64Array([0, 5 * HOUR, 10 * HOUR]),
      open: new Float64Array([100, 101, 102]),
      high: new Float64Array([102, 103, 104]),
      low: new Float64Array([99, 100, 101]),
      close: new Float64Array([101, 102, 103]),
      volume: new Float64Array([1_000, 2_000, 3_000]),
    });
    engine.handleMessage("setViewportRangeAnimated", {
      xMin: 2 * HOUR,
      xMax: 6 * HOUR,
      viewportRequestId: 73,
    });
    const state = getStockEngineState(engine);
    state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration - 1;
    messages.length = 0;
    engine.handleMessage("setSelection", { start: 2 * HOUR, end: 6 * HOUR });
    expectOnlyViewportSync(messages, 2 * HOUR, 6 * HOUR, 0, 10 * HOUR, 73);

    engine.handleMessage("setViewportRangeAnimated", {
      xMin: 3 * HOUR,
      xMax: 7 * HOUR,
    });
    state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration - 1;
    messages.length = 0;
    engine.handleMessage("setSelection", { start: 3 * HOUR, end: 7 * HOUR });

    expectOnlyViewportSync(messages, 3 * HOUR, 7 * HOUR, 0, 10 * HOUR);
  });

  it("does not replay a superseded correlation id on a later uncorrelated animation", () => {
    const { engine, messages } = createHarness(true);
    engine.handleMessage("setData", {
      timestamp: new Float64Array([0, 5 * HOUR, 10 * HOUR]),
      open: new Float64Array([100, 101, 102]),
      high: new Float64Array([102, 103, 104]),
      low: new Float64Array([99, 100, 101]),
      close: new Float64Array([101, 102, 103]),
      volume: new Float64Array([1_000, 2_000, 3_000]),
    });
    engine.handleMessage("setViewportRangeAnimated", {
      xMin: 2 * HOUR,
      xMax: 6 * HOUR,
      viewportRequestId: 73,
    });
    messages.length = 0;
    engine.handleMessage("setViewportRange", {
      xMin: HOUR,
      xMax: 5 * HOUR,
      viewportRequestId: 74,
    });
    expectOnlyViewportSync(messages, HOUR, 5 * HOUR, 0, 10 * HOUR, 74);

    engine.handleMessage("setViewportRangeAnimated", {
      xMin: 3 * HOUR,
      xMax: 7 * HOUR,
    });
    const state = getStockEngineState(engine);
    state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration - 1;
    messages.length = 0;
    engine.handleMessage("setSelection", { start: 3 * HOUR, end: 7 * HOUR });

    expectOnlyViewportSync(messages, 3 * HOUR, 7 * HOUR, 0, 10 * HOUR);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "73"])(
    "does not correlate an invalid viewport request id (%s)",
    (viewportRequestId) => {
      const { engine, messages } = createHarness(false);
      engine.handleMessage("setData", {
        timestamp: new Float64Array([0, 5 * HOUR, 10 * HOUR]),
        open: new Float64Array([100, 101, 102]),
        high: new Float64Array([102, 103, 104]),
        low: new Float64Array([99, 100, 101]),
        close: new Float64Array([101, 102, 103]),
        volume: new Float64Array([1_000, 2_000, 3_000]),
      });
      engine.handleMessage("zoom", { factor: 0.5, centerX: 5 * HOUR });
      messages.length = 0;

      engine.handleMessage("pan", { dx: 0.1, viewportRequestId });

      expectOnlyViewportSync(messages, 3 * HOUR, 8 * HOUR, 0, 10 * HOUR);
    },
  );

  it("clears a pending viewport request when the renderer stops", () => {
    const { engine, messages } = createHarness(true);
    const data = {
      timestamp: new Float64Array([0, 5 * HOUR, 10 * HOUR]),
      open: new Float64Array([100, 101, 102]),
      high: new Float64Array([102, 103, 104]),
      low: new Float64Array([99, 100, 101]),
      close: new Float64Array([101, 102, 103]),
      volume: new Float64Array([1_000, 2_000, 3_000]),
    };
    engine.handleMessage("setData", data);
    engine.handleMessage("setViewportRangeAnimated", {
      xMin: 2 * HOUR,
      xMax: 6 * HOUR,
      viewportRequestId: 73,
    });
    engine.handleMessage("stop", {});
    engine.handleMessage("setData", data);
    messages.length = 0;

    engine.handleMessage("setViewportRangeAnimated", {
      xMin: 3 * HOUR,
      xMax: 7 * HOUR,
    });
    const state = getStockEngineState(engine);
    messages.length = 0;
    state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration - 1;
    engine.handleMessage("setSelection", { start: 3 * HOUR, end: 7 * HOUR });

    expectOnlyViewportSync(messages, 3 * HOUR, 7 * HOUR, 0, 10 * HOUR);
  });

  it.each(["static", "streaming"])(
    "discards old viewport animations and requests when installing %s data",
    (replacement) => {
      const { engine, messages } = createHarness(true);
      const data = {
        timestamp: new Float64Array([0, 5 * HOUR, 10 * HOUR]),
        open: new Float64Array([100, 101, 102]),
        high: new Float64Array([102, 103, 104]),
        low: new Float64Array([99, 100, 101]),
        close: new Float64Array([101, 102, 103]),
        volume: new Float64Array([1_000, 2_000, 3_000]),
      };
      engine.handleMessage("setData", data);
      engine.handleMessage("setViewportRangeAnimated", {
        xMin: 2 * HOUR,
        xMax: 6 * HOUR,
        viewportRequestId: 73,
      });
      const state = getStockEngineState(engine);
      expect(state.viewportAnimation.active).toBe(true);

      const timestamp = new Float64Array([100 * HOUR, 105 * HOUR, 110 * HOUR]);
      messages.length = 0;
      if (replacement === "static") {
        engine.handleMessage("setData", { ...data, timestamp });
      } else {
        engine.handleMessage("initRingBuffer", { maxCandles: 10 });
        expect(state.viewportAnimation.active).toBe(false);
        engine.handleMessage("addCandles", {
          timestamps: timestamp,
          opens: data.open,
          highs: data.high,
          lows: data.low,
          closes: data.close,
          volumes: data.volume,
        });
      }

      expect(state.viewportAnimation.active).toBe(false);
      expect(state.viewport).toMatchObject({ xMin: 100 * HOUR, xMax: 110 * HOUR });
      expect(state.dataBounds).toMatchObject({ xMin: 100 * HOUR, xMax: 110 * HOUR });
      state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration - 1;
      engine.handleMessage("setSelection", { start: 102 * HOUR, end: 106 * HOUR });
      expect(state.viewport).toMatchObject({ xMin: 100 * HOUR, xMax: 110 * HOUR });

      engine.handleMessage("setViewportRangeAnimated", {
        xMin: 102 * HOUR,
        xMax: 106 * HOUR,
      });
      state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration - 1;
      engine.handleMessage("setSelection", { start: 102 * HOUR, end: 106 * HOUR });
      expect(state.viewport).toMatchObject({ xMin: 102 * HOUR, xMax: 106 * HOUR });
      expect(messages.filter((message) => message.type === "viewportSync")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ viewport: { xMin: 102 * HOUR, xMax: 106 * HOUR } }),
        ]),
      );
      for (const message of messages) expect(message).not.toHaveProperty("viewportRequestId");
    },
  );

  it("closes an owned background bitmap when the renderer stops", () => {
    const { engine } = createHarness();
    const image = { close: vi.fn() } as unknown as ImageBitmap;
    engine.handleMessage("updateAppearance", {
      patch: {
        chartBackground: {
          type: "image",
          image,
          __sixtyfoldOwnsImageBitmap: true,
        },
      },
    });

    engine.handleMessage("stop", {});

    expect(image.close).toHaveBeenCalledOnce();
  });
});
