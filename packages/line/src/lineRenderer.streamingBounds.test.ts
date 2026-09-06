import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyYDomain,
  normalizeBounds,
  type YDomainOptions,
} from "@sixtyfold/core/chart/chartUtils";
import { getLineEngineState } from "@test/support/engineState";
import { createLineChartEngine, type LineChartEngine } from "./lineRenderer.js";
import type { SeriesOptions } from "./engine/seriesConfig.js";

interface Point {
  x: number;
  values: number[];
}

function referenceBounds(points: Point[], options: SeriesOptions[]) {
  let min = Infinity;
  let max = -Infinity;
  const include = (value: number) => {
    min = Math.min(min, value);
    max = Math.max(max, value);
  };
  const stacks: number[] = [];
  for (let series = 0; series < options.length; series++) {
    const option = options[series]!;
    if (option.type === "bar" || option.type === "column") {
      include(Number.isFinite(option.bar?.baseline) ? option.bar!.baseline! : 0);
    }
    if (option.type === "stacked-area" || option.type === "stackedArea") stacks.push(series);
  }
  if (stacks.length > 0) include(0);
  for (const point of points) {
    for (const value of point.values) if (Number.isFinite(value)) include(value);
    let positive = 0;
    let negative = 0;
    for (const series of stacks) {
      const value = point.values[series]!;
      if (!Number.isFinite(value)) continue;
      if (value >= 0) positive += value;
      else negative += value;
    }
    if (stacks.length > 0) {
      include(positive);
      include(negative);
    }
  }
  return normalizeBounds(points[0]!.x, points[points.length - 1]!.x, min, max, 1);
}

function points(start: number, count: number, seriesCount: number, gaps = false): Point[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    return {
      x: index * 10,
      values: Array.from({ length: seriesCount }, (_, series) => {
        if (gaps && (index + series * 3) % 17 === 0) return NaN;
        if (gaps && (index + series * 5) % 29 === 0) return Infinity;
        if (gaps && (index + series * 7) % 31 === 0) return -Infinity;
        return ((index * 37 + series * 13) % 101) - 50;
      }),
    };
  });
}

function append(engine: LineChartEngine, batch: Point[], seriesCount: number) {
  engine.handleMessage("addDataPoints", {
    timestamps: Float64Array.from(batch, (point) => point.x),
    valuesBySeries: Array.from({ length: seriesCount }, (_, series) =>
      Float64Array.from(batch, (point) => point.values[series]!),
    ),
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

const engines: LineChartEngine[] = [];

function createHarness(capacity: number, options: SeriesOptions[], yDomain?: YDomainOptions) {
  const reportError = vi.fn();
  const engine = createLineChartEngine(
    { postMessage: () => {}, reportError },
    { createCanvas: createCanvasStub },
  );
  engines.push(engine);
  engine.handleMessage("init", {
    canvas: createCanvasStub(),
    dpr: 1,
    config: {
      animated: false,
      minViewportRange: 1,
      seriesOptions: options,
      yDomain,
      rangeSelector: { visible: false },
    },
  });
  // Isolate synchronous data-bound updates from visible-range autoscaling and
  // drawing. The real async LOD scheduler remains available to settle the seed.
  const state = getLineEngineState(engine);
  state.ctx = null;
  engine.handleMessage("initRingBuffer", { maxPoints: capacity, seriesCount: options.length });
  let retained: Point[] = [];
  return {
    engine,
    state,
    reportError,
    append(batch: Point[]) {
      append(engine, batch, options.length);
      retained = retained.concat(batch).slice(-capacity);
      if (retained.length > 0) {
        const expected = referenceBounds(retained, options);
        expect(state.dataBounds).toEqual(expected);
        const domain = applyYDomain(expected.yMin, expected.yMax, yDomain);
        expect(state.viewport).toMatchObject({ yMin: domain.min, yMax: domain.max });
      }
      expect(reportError).not.toHaveBeenCalled();
    },
  };
}

describe("line streaming retained-window bounds", () => {
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

  it("expires old extrema and preserves duplicate extrema across single-point wraps", () => {
    const harness = createHarness(5, [{}, {}, {}]);
    harness.append([
      { x: 0, values: [-900, 10, 800] },
      { x: 10, values: [-900, 10, 800] },
      { x: 20, values: [2, -50, 3] },
      { x: 30, values: [3, -40, 4] },
      { x: 40, values: [4, -30, 5] },
    ]);
    for (let index = 5; index < 20; index++) harness.append(points(index, 1, 3));
  });

  it("matches a retained-window scan for growing, wrapped, oversized, and empty batches", () => {
    const harness = createHarness(257, [{}, {}, {}, {}]);
    let nextIndex = 0;
    for (const size of [1, 255, 1, 2, 511, 3, 777, 0, 257, 1]) {
      harness.append(points(nextIndex, size, 4, true));
      nextIndex += size;
    }
  });

  it.each([1, 257])(
    "excludes unfilled storage from one-sided bounds at capacity %i",
    (capacity) => {
      const harness = createHarness(capacity, [{}, {}]);
      harness.append([{ x: 0, values: [7, 8] }]);
      expect(harness.state.dataBounds).toMatchObject({ yMin: 7, yMax: 8 });
      harness.append(
        Array.from({ length: capacity }, (_, index) => ({
          x: (index + 1) * 10,
          values: [-7, -8],
        })),
      );
      expect(harness.state.dataBounds).toMatchObject({ yMin: -8, yMax: -7 });
    },
  );

  it("drops nonfinite samples without allowing overwritten extrema to survive", () => {
    const harness = createHarness(3, [{}, {}]);
    harness.append([{ x: 0, values: [-1000, 1000] }]);
    harness.append([
      { x: 10, values: [NaN, Infinity] },
      { x: 20, values: [-Infinity, NaN] },
      { x: 30, values: [NaN, NaN] },
    ]);
    expect(harness.state.dataBounds).toMatchObject({ yMin: 0, yMax: 100 });
    harness.append([{ x: 40, values: [7, 7] }]);
    expect(harness.state.dataBounds).toMatchObject({ yMin: 6.5, yMax: 7.5 });
  });

  it("includes bar and column baselines, including hidden series and invalid-baseline fallback", () => {
    const harness = createHarness(4, [
      { type: "bar", bar: { baseline: -250 } },
      { type: "column", bar: { baseline: 400 } },
      { type: "bar", bar: { baseline: Infinity } },
    ]);
    harness.engine.handleMessage("setSeriesVisible", { index: 1, visible: false });
    harness.append(points(0, 3, 3));
    harness.append(points(3, 9, 3));
    expect(harness.state.dataBounds).toMatchObject({ yMin: -250, yMax: 400 });
  });

  it("includes positive and negative cumulative stacks even when stack series are hidden", () => {
    const options: SeriesOptions[] = [
      { type: "stacked-area" },
      { type: "stackedArea" },
      { type: "stacked-area" },
      {},
    ];
    const harness = createHarness(257, options);
    harness.append(points(0, 257, 4, true));
    harness.engine.handleMessage("setVisibleSeries", { indices: [3] });
    harness.append(points(257, 2, 4, true));
    harness.append(points(259, 700, 4, true));
    harness.engine.handleMessage("setVisibleSeries", { indices: [0, 2, 3] });
    harness.append(points(959, 17, 4, true));
  });

  it("keeps zero as the baseline of entirely nonfinite stacks", () => {
    const harness = createHarness(3, [{ type: "stacked-area" }, { type: "stackedArea" }]);
    harness.append([
      { x: 0, values: [NaN, Infinity] },
      { x: 10, values: [-Infinity, NaN] },
    ]);
    expect(harness.state.dataBounds).toMatchObject({ yMin: -0.5, yMax: 0.5 });
  });

  it.each([
    { name: "minimum only", domain: { min: 100 } },
    { name: "maximum only", domain: { max: -100 } },
    { name: "both edges", domain: { min: -10, max: 10 } },
  ])("preserves $name yDomain independently of raw data bounds", ({ domain }) => {
    const harness = createHarness(5, [{}, {}], domain);
    harness.append(points(0, 5, 2));
    harness.append([{ x: 50, values: [-500, 500] }]);
    harness.append(points(6, 7, 2));
  });

  it("updates accumulated bounds when a live series changes into and out of a stack", () => {
    const options: SeriesOptions[] = [{}, { type: "stacked-area" }];
    const harness = createHarness(8, options);
    harness.append([
      { x: 0, values: [100, 200] },
      { x: 10, values: [-70, -80] },
    ]);
    harness.engine.handleMessage("updateSeriesAppearance", {
      index: 0,
      patch: { type: "stackedArea" },
    });
    options[0] = { type: "stackedArea" };
    harness.append([{ x: 20, values: [1, 2] }]);
    expect(harness.state.dataBounds).toMatchObject({ yMin: -150, yMax: 300 });
    harness.engine.handleMessage("updateSeriesAppearance", { index: 1, patch: { type: "line" } });
    options[1] = { type: "line" };
    harness.append([{ x: 30, values: [3, 4] }]);
    expect(harness.state.dataBounds).toMatchObject({ yMin: -80, yMax: 200 });
  });

  it("uses changed bar baselines without retaining a removed bar's old baseline", () => {
    const options: SeriesOptions[] = [{ type: "bar", bar: { baseline: -900 } }];
    const harness = createHarness(3, options);
    harness.append([{ x: 0, values: [10] }]);
    harness.engine.handleMessage("updateSeriesAppearance", {
      index: 0,
      patch: { bar: { baseline: 700 } },
    });
    options[0] = { type: "bar", bar: { baseline: 700 } };
    harness.append([{ x: 10, values: [20] }]);
    harness.engine.handleMessage("updateSeriesAppearance", { index: 0, patch: { type: "line" } });
    options[0] = { type: "line" };
    harness.append([{ x: 20, values: [30] }]);
    expect(harness.state.dataBounds).toMatchObject({ yMin: 10, yMax: 30 });
  });

  it("resets retained extrema and capacity across init and static-data transitions", () => {
    const harness = createHarness(3, [{}, {}]);
    harness.append([{ x: 0, values: [-900, 800] }]);
    harness.engine.handleMessage("initRingBuffer", { maxPoints: 2, seriesCount: 1 });
    expect(harness.state.dataBounds).toEqual({ xMin: 0, xMax: 1, yMin: 0, yMax: 100 });
    append(
      harness.engine,
      [
        { x: 100, values: [10] },
        { x: 110, values: [20] },
      ],
      1,
    );
    expect(harness.state.dataBounds).toEqual({ xMin: 100, xMax: 110, yMin: 10, yMax: 20 });

    harness.engine.handleMessage("setData", {
      x: new Float64Array([500, 510]),
      series: [{ low: new Float64Array([-300, -200]), high: new Float64Array([200, 400]) }],
    });
    expect(harness.state.dataBounds).toEqual({ xMin: 500, xMax: 510, yMin: -300, yMax: 400 });
    append(harness.engine, [{ x: 520, values: [9999] }], 1);
    expect(harness.state.dataBounds).toEqual({ xMin: 500, xMax: 510, yMin: -300, yMax: 400 });

    harness.engine.handleMessage("initRingBuffer", { maxPoints: 3, seriesCount: 1 });
    append(
      harness.engine,
      [
        { x: 900, values: [30] },
        { x: 910, values: [40] },
      ],
      1,
    );
    expect(harness.state.dataBounds).toEqual({ xMin: 900, xMax: 910, yMin: 30, yMax: 40 });
  });

  it.each(["ordinary", "hidden stacked"] as const)(
    "does not scan retained %s series on each single-point append",
    (kind) => {
      const readsForCapacity = (capacity: number) => {
        const options: SeriesOptions[] = Array.from({ length: 6 }, (_, index) =>
          kind === "hidden stacked" && index < 5 ? { type: "stacked-area" } : {},
        );
        const harness = createHarness(capacity, options);
        if (kind === "hidden stacked")
          harness.engine.handleMessage("setVisibleSeries", { indices: [5] });
        append(harness.engine, points(0, capacity, 6), 6);
        vi.advanceTimersByTime(1000);
        expect(harness.reportError).not.toHaveBeenCalled();
        const isFinite = Number.isFinite;
        let reads = 0;
        const finiteChecks = vi.spyOn(Number, "isFinite").mockImplementation((value) => {
          reads++;
          return isFinite(value);
        });
        // No timer/frame runs here: these checks come only from the append and
        // synchronous bounds maintenance, not rendering or deferred LOD rebuilds.
        append(harness.engine, points(capacity, 1, 6), 6);
        finiteChecks.mockRestore();
        harness.engine.handleMessage("stop", {});
        return reads;
      };
      const small = readsForCapacity(4096);
      const large = readsForCapacity(65_536);
      expect(large).toBeLessThanOrEqual(small + 4096);
    },
  );
});
