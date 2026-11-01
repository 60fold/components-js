import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasLike, EngineCallbacks } from "@sixtyfold/core/internal/renderer";
import { createLineChartEngine } from "../packages/line/src/lineRenderer.js";
import { createStockChartEngine } from "../packages/stock/src/stockRenderer.js";
import { getLineEngineState, getStockEngineState } from "./support/engineState.js";

function createCanvasRecorder(width: number, height: number, singleContext = false) {
  const drawImage = vi.fn();
  const setTransform = vi.fn();
  const gradient = { addColorStop: () => {} } as CanvasGradient;
  const context = new Proxy({} as CanvasRenderingContext2D, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      if (property === "measureText") return () => ({ width: 40 }) as TextMetrics;
      if (property === "createLinearGradient") return () => gradient;
      if (property === "createPattern") return () => null;
      if (property === "drawImage") return drawImage;
      if (property === "setTransform") return setTransform;
      return () => {};
    },
    set: (target, property, value) => Reflect.set(target, property, value),
  });
  const getContext = vi.fn((): CanvasRenderingContext2D => {
    // Firefox 159 accepts the first context on a transferred HTML canvas but
    // rejects a second acquisition, even when it comes from the same worker.
    if (singleContext && getContext.mock.calls.length > 1) {
      throw new DOMException(
        "OffscreenCanvas.getContext: Cannot update created context to different thread",
        "InvalidStateError",
      );
    }
    return context;
  });
  return { canvas: { width, height, getContext }, context, drawImage, setTransform };
}

const timestamps = Float64Array.from({ length: 96 }, (_, index) => index * 60_000);
const values = Float64Array.from({ length: 96 }, (_, index) => 100 + Math.sin(index / 4));
const cases = [
  {
    name: "Line",
    create(callbacks: EngineCallbacks, createCanvas: (w: number, h: number) => CanvasLike) {
      const engine = createLineChartEngine(callbacks, { createCanvas });
      return { engine, state: getLineEngineState(engine) };
    },
    data: { x: timestamps, series: [values] },
  },
  {
    name: "Stock",
    create(callbacks: EngineCallbacks, createCanvas: (w: number, h: number) => CanvasLike) {
      const engine = createStockChartEngine(callbacks, { createCanvas });
      return { engine, state: getStockEngineState(engine) };
    },
    data: {
      timestamp: timestamps,
      open: values,
      high: values.map((value) => value + 2),
      low: values.map((value) => value - 2),
      close: values.map((value) => value + 1),
      volume: new Float64Array(96).fill(10),
    },
  },
];

describe("renderer primary context lifetime", () => {
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
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(cases)(
    "$name redraws after repeated invalidation without reacquiring its context",
    ({ create, data }) => {
      const primary = createCanvasRecorder(800, 600, true);
      const caches: ReturnType<typeof createCanvasRecorder>[] = [];
      const postMessage = vi.fn();
      const reportError = vi.fn();
      const { engine, state } = create({ postMessage, reportError }, (width, height) => {
        const cache = createCanvasRecorder(width, height);
        caches.push(cache);
        return cache.canvas;
      });

      try {
        engine.handleMessage("init", {
          canvas: primary.canvas,
          dpr: 1,
          config: { animated: false, rangeSelector: { visible: true } },
        });
        expect(postMessage).toHaveBeenCalledWith({ type: "ready" });
        engine.handleMessage("resize", { width: 800, height: 600, dpr: 1 });
        engine.handleMessage("setData", data);
        vi.advanceTimersByTime(500);
        expect(primary.drawImage).toHaveBeenCalled();

        for (const dpr of [1, 2, 1]) {
          engine.handleMessage("resize", { width: 900, height: 480, dpr });
          vi.advanceTimersByTime(32);
          const previousCache = state.cacheCanvas;
          const previousPreview = state.rangePreviewCanvas;
          const previousFrames = primary.drawImage.mock.calls.length;
          expect(previousCache).not.toBeNull();
          expect(previousPreview).not.toBeNull();

          engine.handleMessage("invalidateCache", {});
          expect(state.ctx).toBe(primary.context);
          expect(primary.canvas.getContext).toHaveBeenCalledTimes(1);
          expect(primary.setTransform).toHaveBeenLastCalledWith(dpr, 0, 0, dpr, 0, 0);
          expect(state.cacheCanvas).toBeNull();
          expect(state.rangePreviewCanvas).toBeNull();
          vi.advanceTimersByTime(32);

          expect(primary.drawImage.mock.calls.length).toBeGreaterThan(previousFrames);
          expect(state.cacheCanvas).not.toBe(previousCache);
          expect(state.rangePreviewCanvas).not.toBe(previousPreview);
          expect(state.cacheValid).toBe(true);
          expect(state.rangePreviewValid).toBe(true);
        }

        expect(reportError).not.toHaveBeenCalled();
        expect(primary.canvas.getContext).toHaveBeenCalledTimes(1);
        expect(caches.every((cache) => cache.canvas !== primary.canvas)).toBe(true);
      } finally {
        engine.handleMessage("stop", {});
      }
    },
  );
});
