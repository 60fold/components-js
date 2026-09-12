import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLineChartEngine, type LineChartEngine } from "./lineRenderer.js";

function createCanvasStub(width = 800, height = 600) {
  const gradient = { addColorStop: () => {} } as CanvasGradient;
  const context = new Proxy({} as CanvasRenderingContext2D, {
    get: (target, property) => {
      if (property === "measureText") return () => ({ width: 40 }) as TextMetrics;
      if (property === "createLinearGradient") return () => gradient;
      if (property === "createPattern") return () => null;
      return Reflect.get(target, property) ?? (() => {});
    },
    set: (target, property, value) => Reflect.set(target, property, value),
  });
  return { width, height, getContext: () => context };
}

const engines: LineChartEngine[] = [];
const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;

function createHarness() {
  const messages: Array<Record<string, unknown>> = [];
  const reportError = vi.fn();
  const engine = createLineChartEngine(
    { postMessage: (message) => messages.push(message), reportError },
    { createCanvas: createCanvasStub },
  );
  engines.push(engine);
  engine.handleMessage("init", {
    canvas: createCanvasStub(),
    dpr: 1,
    config: {
      animated: false,
      minViewportRange: 1,
      rangeSelector: { visible: false },
      legend: { visible: false },
    },
  });
  engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
  return {
    engine,
    reportError,
    readStats() {
      messages.length = 0;
      engine.handleMessage("start", {});
      const pendingFrames = Array.from(frames.values());
      frames.clear();
      expect(pendingFrames.length).toBeGreaterThan(0);
      for (const callback of pendingFrames) callback(performance.now());
      expect(reportError).not.toHaveBeenCalled();
      const stats = messages.find((message) => message.type === "stats");
      expect(stats).toBeDefined();
      return stats!;
    },
  };
}

function append(engine: LineChartEngine, start: number, count: number) {
  engine.handleMessage("addDataPoints", {
    timestamps: Float64Array.from({ length: count }, (_, index) => start + index),
    valuesBySeries: [Float64Array.from({ length: count }, (_, index) => 10 + (index % 7))],
  });
}

describe("line streaming LOD reset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nextFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
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

  it.each(["static", "streaming"])(
    "discards staged LOD jobs from a replaced %s dataset",
    (source) => {
      const harness = createHarness();
      if (source === "static") {
        harness.engine.handleMessage("setData", {
          x: Float64Array.from({ length: 20_000 }, (_, index) => index),
          series: [Float64Array.from({ length: 20_000 }, (_, index) => index % 11)],
        });
      } else {
        harness.engine.handleMessage("initRingBuffer", { maxPoints: 40_000, seriesCount: 1 });
        append(harness.engine, 0, 20_000);
      }

      harness.engine.handleMessage("initRingBuffer", { maxPoints: 256, seriesCount: 1 });
      append(harness.engine, 100_000, 200);
      vi.advanceTimersByTime(60);

      expect(harness.readStats()).toMatchObject({
        totalPoints: 200,
        totalReceived: 200,
        lodBuilt: 1,
        lodReady: false,
        ringBuffer: true,
        dataBounds: { xMin: 100_000, xMax: 100_199, yMin: 10, yMax: 16 },
      });

      vi.advanceTimersByTime(100);
      const stats = harness.readStats();
      expect(stats).toMatchObject({ totalPoints: 200, lodReady: true });
      expect(stats.lodBuilt).toBe(stats.lodTotal);
      expect(harness.reportError).not.toHaveBeenCalled();
    },
  );

  it("cancels a pending streaming rebuild when the replacement ring is empty", () => {
    const harness = createHarness();
    harness.engine.handleMessage("initRingBuffer", { maxPoints: 256, seriesCount: 1 });
    append(harness.engine, 0, 200);
    expect(vi.getTimerCount()).toBe(1);

    harness.engine.handleMessage("initRingBuffer", { maxPoints: 64, seriesCount: 1 });

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(200);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it("starts a fresh rebuild deadline for a replacement streaming dataset", () => {
    const harness = createHarness();
    harness.engine.handleMessage("initRingBuffer", { maxPoints: 256, seriesCount: 1 });
    append(harness.engine, 0, 1);
    for (let index = 1; index <= 5; index++) {
      vi.advanceTimersByTime(90);
      append(harness.engine, index, 1);
    }

    // The old stream's 500ms deadline must not shorten the replacement's
    // normal 100ms debounce, which begins at 450ms.
    harness.engine.handleMessage("initRingBuffer", { maxPoints: 64, seriesCount: 1 });
    append(harness.engine, 100_000, 20);
    vi.advanceTimersByTime(99);
    expect(harness.readStats()).toMatchObject({
      totalPoints: 20,
      totalReceived: 20,
      lodBuilt: 1,
      lodReady: false,
    });

    vi.advanceTimersByTime(61);
    const stats = harness.readStats();
    expect(stats).toMatchObject({ totalPoints: 20, lodReady: true });
    expect(stats.lodBuilt).toBe(stats.lodTotal);
  });
});
