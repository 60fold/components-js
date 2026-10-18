import { describe, expect, it, vi } from "vitest";
import { getLineEngineState } from "@test/support/engineState";
import { createLineChartEngine } from "./lineRenderer.js";

function createContextStub(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => {} } as CanvasGradient;
  return new Proxy({} as CanvasRenderingContext2D, {
    get: (_target, prop) => {
      if (prop === "measureText") return () => ({ width: 40 }) as TextMetrics;
      if (prop === "createLinearGradient") return () => gradient;
      if (prop === "createPattern") return () => null;
      return () => {};
    },
    set: () => true,
  });
}

function createCanvasStub(width = 800, height = 600) {
  const context = createContextStub();
  return { width, height, getContext: () => context };
}

function createHarness(
  animated: boolean,
  minViewportRange?: number,
  yDomain?: { min?: number; max?: number },
) {
  const messages: Array<Record<string, unknown>> = [];
  const engine = createLineChartEngine(
    { postMessage: (message) => messages.push(message) },
    {
      ssr: true,
      createCanvas: (width, height) => createCanvasStub(width, height),
    },
  );

  engine.handleMessage("init", {
    canvas: createCanvasStub(),
    dpr: 1,
    config: {
      animated,
      minViewportRange,
      yDomain,
      rangeSelector: { visible: false },
    },
  });
  engine.handleMessage("resize", { width: 800, height: 600, dpr: 1 });
  messages.length = 0;

  return { engine, messages };
}

function setData(engine: ReturnType<typeof createLineChartEngine>): void {
  engine.handleMessage("setData", {
    x: new Float64Array([0, 50, 100]),
    series: [new Float64Array([10, 20, 30])],
  });
}

function expectOnlyViewportSync(
  messages: Array<Record<string, unknown>>,
  xMin: number,
  xMax: number,
  viewportRequestId?: number,
): void {
  expect(messages.filter((message) => message.type === "stats")).toHaveLength(0);
  expect(messages.filter((message) => message.type === "viewportSync")).toEqual([
    {
      type: "viewportSync",
      viewport: { xMin, xMax },
      dataBounds: { xMin: 0, xMax: 100 },
      ...(viewportRequestId === undefined ? {} : { viewportRequestId }),
    },
  ]);
}

describe("line renderer viewport synchronization", () => {
  it("keeps a fixed Y domain stable across streamed extrema", () => {
    const { engine } = createHarness(false, undefined, {
      min: 0,
      max: 100,
    });
    engine.handleMessage("initRingBuffer", {
      maxPoints: 1_024,
      seriesCount: 1,
    });
    engine.handleMessage("addDataPoints", {
      timestamps: new Float64Array([1, 2, 3]),
      valuesBySeries: [new Float64Array([20, 40, 60])],
    });
    expect(getLineEngineState(engine).viewport).toMatchObject({
      yMin: 0,
      yMax: 100,
    });

    engine.handleMessage("addDataPoints", {
      timestamps: new Float64Array([4, 5]),
      valuesBySeries: [new Float64Array([-200, 900])],
    });
    expect(getLineEngineState(engine).viewport).toMatchObject({
      yMin: 0,
      yMax: 100,
    });
  });

  it("rejects zoom and direct ranges below a configured X-data cadence", () => {
    const minuteMs = 60_000;
    const start = Date.UTC(2023, 2, 31, 22);
    const { engine, messages } = createHarness(false, minuteMs);
    engine.handleMessage("setData", {
      x: new Float64Array([start, start + minuteMs, start + minuteMs * 2]),
      series: [new Float64Array([10, 20, 30])],
    });

    messages.length = 0;
    engine.handleMessage("zoom", {
      factor: 0.5,
      centerX: start + minuteMs,
    });
    expect(
      getLineEngineState(engine).viewport.xMax - getLineEngineState(engine).viewport.xMin,
    ).toBe(minuteMs);

    messages.length = 0;
    engine.handleMessage("zoom", {
      factor: 0.5,
      centerX: start + minuteMs,
    });
    expect(
      getLineEngineState(engine).viewport.xMax - getLineEngineState(engine).viewport.xMin,
    ).toBe(minuteMs);
    expect(messages.filter((message) => message.type === "viewportSync")).toHaveLength(0);

    engine.handleMessage("setViewportRange", {
      xMin: start + 25_000,
      xMax: start + 25_010,
    });
    expect(
      getLineEngineState(engine).viewport.xMax - getLineEngineState(engine).viewport.xMin,
    ).toBe(minuteMs);
    expect(messages.filter((message) => message.type === "viewportSync")).toHaveLength(0);
  });

  it("synchronizes every instant viewport command without stats or duplicate frames", () => {
    const { engine, messages } = createHarness(false);
    setData(engine);

    messages.length = 0;
    engine.handleMessage("zoom", { factor: 0.5, centerX: 50 });
    expectOnlyViewportSync(messages, 25, 75);

    messages.length = 0;
    engine.handleMessage("pan", { dx: 0.1 });
    expectOnlyViewportSync(messages, 30, 80);

    messages.length = 0;
    engine.handleMessage("reset", {});
    expectOnlyViewportSync(messages, 0, 100);

    messages.length = 0;
    engine.handleMessage("setViewportRange", { xMin: 20, xMax: 60 });
    expectOnlyViewportSync(messages, 20, 60);
  });

  it("correlates an animated command only with its settled viewport", () => {
    const { engine, messages } = createHarness(true);
    setData(engine);
    messages.length = 0;

    engine.handleMessage("setViewportRangeAnimated", {
      xMin: 20,
      xMax: 60,
      viewportRequestId: 41,
    });
    const state = getLineEngineState(engine);
    messages.length = 0;

    state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration / 2;
    engine.handleMessage("setSelection", {
      start: 20,
      end: 60,
      viewportRequestId: 99,
    });
    const intermediateSyncs = messages.filter((message) => message.type === "viewportSync");
    expect(intermediateSyncs).toHaveLength(1);
    expect(intermediateSyncs[0]).not.toHaveProperty("viewportRequestId");
    expect(state.viewportAnimation.active).toBe(true);

    messages.length = 0;
    state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration - 1;

    engine.handleMessage("setSelection", { start: 20, end: 60 });
    expect(state.viewportAnimation.active).toBe(false);
    expectOnlyViewportSync(messages, 20, 60, 41);

    messages.length = 0;
    engine.handleMessage("setSelection", { start: 20, end: 60 });
    expect(messages.filter((message) => message.type === "viewportSync")).toHaveLength(0);
  });

  it("does not replay a consumed correlation id on a later uncorrelated animation", () => {
    const { engine, messages } = createHarness(true);
    setData(engine);
    engine.handleMessage("setViewportRangeAnimated", {
      xMin: 20,
      xMax: 60,
      viewportRequestId: 41,
    });
    const state = getLineEngineState(engine);
    state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration - 1;
    messages.length = 0;
    engine.handleMessage("setSelection", { start: 20, end: 60 });
    expectOnlyViewportSync(messages, 20, 60, 41);

    engine.handleMessage("setViewportRangeAnimated", { xMin: 30, xMax: 70 });
    state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration - 1;
    messages.length = 0;
    engine.handleMessage("setSelection", { start: 30, end: 70 });

    expectOnlyViewportSync(messages, 30, 70);
  });

  it("does not replay a superseded correlation id on a later uncorrelated animation", () => {
    const { engine, messages } = createHarness(true);
    setData(engine);
    engine.handleMessage("setViewportRangeAnimated", {
      xMin: 20,
      xMax: 60,
      viewportRequestId: 41,
    });
    messages.length = 0;
    engine.handleMessage("setViewportRange", {
      xMin: 10,
      xMax: 50,
      viewportRequestId: 42,
    });
    expectOnlyViewportSync(messages, 10, 50, 42);

    engine.handleMessage("setViewportRangeAnimated", { xMin: 30, xMax: 70 });
    const state = getLineEngineState(engine);
    state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration - 1;
    messages.length = 0;
    engine.handleMessage("setSelection", { start: 30, end: 70 });

    expectOnlyViewportSync(messages, 30, 70);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "41"])(
    "does not correlate an invalid viewport request id (%s)",
    (viewportRequestId) => {
      const { engine, messages } = createHarness(false);
      setData(engine);
      engine.handleMessage("zoom", { factor: 0.5, centerX: 50 });
      messages.length = 0;

      engine.handleMessage("pan", { dx: 0.1, viewportRequestId });

      expectOnlyViewportSync(messages, 30, 80);
    },
  );

  it("clears a pending viewport request when the renderer stops", () => {
    const { engine, messages } = createHarness(true);
    setData(engine);
    engine.handleMessage("setViewportRangeAnimated", {
      xMin: 20,
      xMax: 60,
      viewportRequestId: 41,
    });
    engine.handleMessage("stop", {});
    setData(engine);
    messages.length = 0;

    engine.handleMessage("setViewportRangeAnimated", { xMin: 10, xMax: 50 });
    const state = getLineEngineState(engine);
    messages.length = 0;
    state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration - 1;
    engine.handleMessage("setSelection", { start: 10, end: 50 });

    expectOnlyViewportSync(messages, 10, 50);
  });

  it.each(["static", "streaming"])(
    "discards old viewport animations and requests when installing %s data",
    (replacement) => {
      const { engine, messages } = createHarness(true, 1);
      setData(engine);
      engine.handleMessage("setViewportRangeAnimated", {
        xMin: 20,
        xMax: 60,
        viewportRequestId: 41,
      });
      const state = getLineEngineState(engine);
      expect(state.viewportAnimation.active).toBe(true);

      const timestamps = new Float64Array([10_000, 10_050, 10_100]);
      const values = new Float64Array([1_000, 1_010, 1_020]);
      messages.length = 0;
      if (replacement === "static") {
        engine.handleMessage("setData", { x: timestamps, series: [values] });
      } else {
        engine.handleMessage("initRingBuffer", { maxPoints: 10, seriesCount: 1 });
        expect(state.viewportAnimation.active).toBe(false);
        engine.handleMessage("addDataPoints", {
          timestamps,
          valuesBySeries: [values],
        });
      }

      expect(state.viewportAnimation.active).toBe(false);
      expect(state.viewport).toMatchObject({ xMin: 10_000, xMax: 10_100 });
      expect(state.dataBounds).toMatchObject({ xMin: 10_000, xMax: 10_100 });
      state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration - 1;
      engine.handleMessage("setSelection", { start: 10_020, end: 10_060 });
      expect(state.viewport).toMatchObject({ xMin: 10_000, xMax: 10_100 });

      // Completing a new, uncorrelated animation must not acknowledge the old dataset's request.
      engine.handleMessage("setViewportRangeAnimated", { xMin: 10_020, xMax: 10_060 });
      state.viewportAnimation.startTime = performance.now() - state.viewportAnimation.duration - 1;
      engine.handleMessage("setSelection", { start: 10_020, end: 10_060 });
      expect(state.viewport).toMatchObject({ xMin: 10_020, xMax: 10_060 });
      expect(messages.filter((message) => message.type === "viewportSync")).not.toHaveLength(0);
      expect(messages.filter((message) => message.type === "viewportSync")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ viewport: { xMin: 10_020, xMax: 10_060 } }),
        ]),
      );
      for (const message of messages) expect(message).not.toHaveProperty("viewportRequestId");
    },
  );

  it("closes an owned background bitmap when the renderer stops", () => {
    const { engine } = createHarness(false);
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
