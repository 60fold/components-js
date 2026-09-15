import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLineEngineState } from "@test/support/engineState";
import { createLineChartEngine, type LineChartEngine } from "./lineRenderer.js";

const colors = ["#12abcd", "#ab12cd"];
type PathPoint = [string, string, ...number[]];
const frames = new Map<number, FrameRequestCallback>();
const engines: LineChartEngine[] = [];
let nextFrame = 0;

function samples(start: number, count: number) {
  return {
    timestamps: Float64Array.from({ length: count }, (_, index) => start + index),
    valuesBySeries: [0, 1].map((series) =>
      Float64Array.from({ length: count }, (_, index) => {
        const value = start + index;
        return value % (series ? 53 : 37) === 0
          ? NaN
          : Math.sin(value / (series ? 19 : 7)) * 50 + (value % 101) - 50;
      }),
    ),
  };
}

function harness(
  capacity: number,
  ssr = false,
  mode: "adaptive" | "pyramid" = "adaptive",
  type = "line",
  fixedY = true,
) {
  const points: PathPoint[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const reportError = vi.fn();
  const canvas = (width = 400, height = 300) => {
    const context = new Proxy({} as CanvasRenderingContext2D, {
      get(target, property) {
        if (property === "measureText") return () => ({ width: 30 }) as TextMetrics;
        if (property === "createLinearGradient") return () => ({ addColorStop() {} });
        if (property === "createPattern") return () => null;
        if (property === "moveTo" || property === "lineTo" || property === "arc") {
          return (...args: number[]) => {
            const color = String(target.strokeStyle);
            if (colors.includes(color)) points.push([property, color, ...args]);
          };
        }
        return Reflect.get(target, property) ?? (() => {});
      },
      set: (target, property, value) => Reflect.set(target, property, value),
    });
    return { width, height, getContext: () => context };
  };
  const engine = createLineChartEngine(
    { postMessage: (message) => messages.push(message), reportError },
    { ssr, createCanvas: canvas },
  );
  engines.push(engine);
  engine.handleMessage("init", {
    canvas: canvas(),
    dpr: 1,
    config: {
      animated: false,
      minViewportRange: 1,
      ...(fixedY ? { yDomain: { min: -100, max: 100 } } : {}),
      rangeSelector: { visible: false },
      legend: { visible: false },
      axes: { left: { visible: false }, right: { visible: false } },
      lod: { mode, density: 0.5 },
      seriesOptions: colors.map((color) => ({ type, color, width: 1 })),
    },
  });
  engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
  engine.handleMessage("initRingBuffer", { maxPoints: capacity, seriesCount: 2 });
  return {
    engine,
    reportError,
    append(start: number, count = 1) {
      engine.handleMessage("addDataPoints", samples(start, count));
    },
    render(start: number, end: number) {
      points.length = 0;
      messages.length = 0;
      const state = getLineEngineState(engine);
      state.cacheValid = false;
      engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
      engine.handleMessage("setViewportRange", { xMin: start, xMax: end });
      if (!ssr) {
        engine.handleMessage("start", {});
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(performance.now());
      }
      expect(reportError).not.toHaveBeenCalled();
      const stats = messages.find((message) => message.type === "stats");
      expect(stats).toBeDefined();
      return { points: [...points], stats: stats! };
    },
  };
}

describe("line streaming LOD snapshots", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });

  afterEach(() => {
    for (const engine of engines.splice(0)) engine.handleMessage("stop", {});
    frames.clear();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([2, 4, 16])("completes repeated full-ring builds during %dms appends", (cadence) => {
    const chart = harness(2048);
    chart.append(0, 2048);
    let next = 2048;
    let completeBuilds = 0;
    let wasReady = false;
    for (let elapsed = 0; elapsed < 1800; elapsed += cadence) {
      chart.append(next++);
      vi.advanceTimersByTime(cadence);
      const { stats } = chart.render(next - 2048, next - 1);
      if (stats.lodReady && !wasReady) completeBuilds++;
      wasReady = Boolean(stats.lodReady);
      if (stats.lodReady) expect(stats.lodBuilt).toBe(stats.lodTotal);
    }
    expect(completeBuilds).toBeGreaterThanOrEqual(3);
    vi.advanceTimersByTime(200);
    expect(chart.render(next - 2048, next - 1).stats).toMatchObject({
      lodReady: true,
      lodBuilt: 7,
      totalReceived: next,
    });
  });

  it.each([16, 17, 2100])(
    "protects a borrowed prefix when appending %d points at its boundary",
    (count) => {
      const chart = harness(2016);
      chart.append(0, 2000);
      vi.advanceTimersByTime(15);
      chart.append(2000, count);
      if (count === 16) chart.append(2016, 1);
      const received = 2000 + count + (count === 16 ? 1 : 0);
      vi.advanceTimersByTime(40);
      const actual = chart.render(received - 2016, received - 1);
      expect(actual.stats).toMatchObject({ lodReady: true, lodBuilt: 7 });

      const reference = harness(2016, true);
      reference.append(0, received);
      const expected = reference.render(received - 2016, received - 1);
      expect(actual.points.length).toBeGreaterThan(0);
      expect(actual.points).toEqual(expected.points);
    },
  );

  it("keeps adaptive snapshots accelerated and geometrically current after multiple wraps", () => {
    const chart = harness(16_384);
    chart.append(0, 16_384);
    vi.advanceTimersByTime(60);
    let received = 16_384;
    for (const count of [19, 512, 17_001, 31, 97]) {
      chart.append(received, count);
      received += count;
      vi.advanceTimersByTime(60);
      const actual = chart.render(received - 16_384, received - 1);
      const reference = harness(16_384, true);
      reference.append(0, received);
      const expected = reference.render(received - 16_384, received - 1);
      expect(actual.points).toEqual(expected.points);
      if (count < 512) expect(actual.stats.presentationLargestBucket).toBeGreaterThan(1);
      reference.engine.handleMessage("stop", {});
      vi.advanceTimersByTime(150);
    }
  });

  it("includes new raw tail samples in pyramid rendering while its snapshot rebuild waits", () => {
    const chart = harness(4096, false, "pyramid");
    chart.append(0, 4096);
    vi.advanceTimersByTime(60);
    chart.append(4096, 3);
    const actual = chart.render(4090, 4098);
    const reference = harness(4096, true, "pyramid");
    reference.append(0, 4099);
    expect(actual.points).toEqual(reference.render(4090, 4098).points);
  });

  it.each(["line", "stacked-area"])(
    "keeps a reduced %s pyramid with raw head and tail fringes",
    (type) => {
      const chart = harness(16_384, false, "pyramid", type);
      chart.append(0, 16_384);
      vi.advanceTimersByTime(60);
      chart.append(16_384, 3);
      const actual = chart.render(3, 16_386);
      expect(actual.stats.bucketSize).toBeGreaterThan(1);
      expect(actual.stats.renderedPoints as number).toBeLessThan(16_384);
      const reference = harness(16_384, true, "pyramid", type);
      reference.append(0, 16_387);
      const expected = reference.render(3, 16_386);
      // The frozen hierarchy and current hierarchy may choose different extrema
      // within interior buckets, but both must include the newest actual sample.
      const lastActual = actual.points.filter((point) => point[0] === "lineTo").at(-1);
      const lastExpected = expected.points.filter((point) => point[0] === "lineTo").at(-1);
      expect(lastActual).toEqual(lastExpected);
    },
  );

  it("does not autoscale to an evicted spike in a partial snapshot bucket", () => {
    const chart = harness(8192, false, "pyramid", "line", false);
    const initial = samples(0, 8192);
    initial.valuesBySeries[0][0] = 1_000_000;
    chart.engine.handleMessage("addDataPoints", initial);
    vi.advanceTimersByTime(60);
    chart.append(8192);
    chart.render(1, 7000);
    const state = getLineEngineState(chart.engine);
    expect(state.yAnimation.toYMax).toBeLessThan(1000);
  });

  it("autoscale queries use snapshot buckets plus raw fringes instead of rescanning a full ring", () => {
    const chart = harness(100_000, false, "adaptive", "line", false);
    chart.engine.handleMessage("addDataPoints", {
      timestamps: Float64Array.from({ length: 100_000 }, (_, index) => index),
      valuesBySeries: [new Float64Array(100_000).fill(10), new Float64Array(100_000).fill(20)],
    });
    vi.advanceTimersByTime(60);
    chart.append(100_000);
    const finiteChecks = vi.spyOn(Number, "isFinite");
    chart.render(1, 100_000);
    // A raw bounds pass alone performs 200,000 checks. Complete retained
    // buckets plus the two tiny fringes leave room for drawing and axes too.
    expect(finiteChecks.mock.calls.length).toBeLessThan(30_000);
  });
});
