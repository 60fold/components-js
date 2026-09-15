import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CHART_FONT_FAMILY } from "@sixtyfold/core/chart/chartConstants";
import { getLineEngineState } from "@test/support/engineState";
import { createLineChartEngine } from "./lineRenderer";

interface FillTextCall {
  text: string;
  x: number;
  y: number;
  maxWidth?: number;
  font?: string;
  textAlign?: CanvasTextAlign;
  direction?: CanvasDirection;
}

interface PathCall {
  op:
    | "moveTo"
    | "lineTo"
    | "bezierCurveTo"
    | "stroke"
    | "closePath"
    | "fill"
    | "fillRect"
    | "strokeRect"
    | "rect"
    | "clip"
    | "save"
    | "restore";
  x?: number;
  y?: number;
  cp1x?: number;
  cp1y?: number;
  cp2x?: number;
  cp2y?: number;
  width?: number;
  height?: number;
  strokeStyle?: string;
  fillStyle?: string;
  lineWidth?: number;
  lineDash?: number[];
}

interface RecordingContext extends CanvasRenderingContext2D {
  fillTextCalls: FillTextCall[];
  drawImageCalls: unknown[][];
  createLinearGradientCalls: number;
  pathCalls: PathCall[];
}

interface StubCanvas {
  width: number;
  height: number;
  getContext: (type: "2d", options?: CanvasRenderingContext2DSettings) => RecordingContext | null;
}

function createRecordingContext(): RecordingContext {
  const target: Record<string, unknown> & {
    fillTextCalls: FillTextCall[];
    fillText: (text: string, x: number, y: number, maxWidth?: number) => void;
    measureText: (text: string) => TextMetrics;
    createLinearGradient: (x0: number, y0: number, x1: number, y1: number) => CanvasGradient;
    createPattern: () => CanvasPattern | null;
    setLineDash: (segments: number[]) => void;
    getLineDash: () => number[];
    currentLineDash: number[];
    createLinearGradientCalls: number;
    drawImageCalls: unknown[][];
    drawImage: (...args: unknown[]) => void;
    pathCalls: PathCall[];
    moveTo: (x: number, y: number) => void;
    lineTo: (x: number, y: number) => void;
    bezierCurveTo: (
      cp1x: number,
      cp1y: number,
      cp2x: number,
      cp2y: number,
      x: number,
      y: number,
    ) => void;
    stroke: () => void;
    closePath: () => void;
    fill: () => void;
    fillRect: (x: number, y: number, width: number, height: number) => void;
    strokeRect: (x: number, y: number, width: number, height: number) => void;
    rect: (x: number, y: number, width: number, height: number) => void;
    clip: () => void;
    save: () => void;
    restore: () => void;
  } = {
    fillTextCalls: [],
    drawImageCalls: [],
    createLinearGradientCalls: 0,
    pathCalls: [],
    drawImage: (...args: unknown[]) => {
      target.drawImageCalls.push(args);
    },
    fillText: (text: string, x: number, y: number, maxWidth?: number) => {
      target.fillTextCalls.push({
        text,
        x,
        y,
        maxWidth,
        font: String(target.font ?? ""),
        textAlign: target.textAlign as CanvasTextAlign,
        direction: target.direction as CanvasDirection,
      });
    },
    measureText: (text: string) =>
      ({
        width: text.length * 7,
        actualBoundingBoxAscent: 7,
        actualBoundingBoxDescent: 2,
      }) as TextMetrics,
    createLinearGradient: () => {
      target.createLinearGradientCalls++;
      return {
        addColorStop: () => {},
      } as CanvasGradient;
    },
    createPattern: () => null,
    currentLineDash: [],
    setLineDash: (segments: number[]) => {
      target.currentLineDash = [...segments];
    },
    getLineDash: () => target.currentLineDash,
    moveTo: (x: number, y: number) => {
      target.pathCalls.push({
        op: "moveTo",
        x,
        y,
        strokeStyle: String(target.strokeStyle ?? ""),
        lineWidth: Number(target.lineWidth ?? 0),
        lineDash: [...target.currentLineDash],
      });
    },
    lineTo: (x: number, y: number) => {
      target.pathCalls.push({
        op: "lineTo",
        x,
        y,
        strokeStyle: String(target.strokeStyle ?? ""),
        lineWidth: Number(target.lineWidth ?? 0),
        lineDash: [...target.currentLineDash],
      });
    },
    bezierCurveTo: (
      cp1x: number,
      cp1y: number,
      cp2x: number,
      cp2y: number,
      x: number,
      y: number,
    ) => {
      target.pathCalls.push({
        op: "bezierCurveTo",
        cp1x,
        cp1y,
        cp2x,
        cp2y,
        x,
        y,
        strokeStyle: String(target.strokeStyle ?? ""),
        lineWidth: Number(target.lineWidth ?? 0),
        lineDash: [...target.currentLineDash],
      });
    },
    stroke: () => {
      target.pathCalls.push({
        op: "stroke",
        strokeStyle: String(target.strokeStyle ?? ""),
        lineWidth: Number(target.lineWidth ?? 0),
        lineDash: [...target.currentLineDash],
      });
    },
    closePath: () => {
      target.pathCalls.push({
        op: "closePath",
        fillStyle: String(target.fillStyle ?? ""),
      });
    },
    fill: () => {
      target.pathCalls.push({
        op: "fill",
        fillStyle: String(target.fillStyle ?? ""),
      });
    },
    fillRect: (x: number, y: number, width: number, height: number) => {
      target.pathCalls.push({
        op: "fillRect",
        x,
        y,
        width,
        height,
        fillStyle: String(target.fillStyle ?? ""),
      });
    },
    strokeRect: (x: number, y: number, width: number, height: number) => {
      target.pathCalls.push({
        op: "strokeRect",
        x,
        y,
        width,
        height,
        strokeStyle: String(target.strokeStyle ?? ""),
        lineWidth: Number(target.lineWidth ?? 0),
        lineDash: [...target.currentLineDash],
      });
    },
    rect: (x: number, y: number, width: number, height: number) => {
      target.pathCalls.push({ op: "rect", x, y, width, height });
    },
    clip: () => {
      target.pathCalls.push({ op: "clip" });
    },
    save: () => {
      target.pathCalls.push({ op: "save" });
    },
    restore: () => {
      target.pathCalls.push({ op: "restore" });
    },
  };
  target.textAlign = "start";
  target.direction = "inherit";

  return new Proxy(target, {
    get(obj, prop: string) {
      if (prop in obj) return obj[prop];
      return () => {};
    },
    set(obj, prop: string, value: unknown) {
      obj[prop] = value;
      return true;
    },
  }) as unknown as RecordingContext;
}

function createStubCanvas(width = 900, height = 480): StubCanvas {
  const ctx = createRecordingContext();
  return {
    width,
    height,
    getContext: () => ctx,
  };
}

function createHarness(config: Record<string, unknown> = {}, width = 900) {
  const messages: Array<Record<string, unknown>> = [];
  const contexts: RecordingContext[] = [];

  const mainCanvas = createStubCanvas(width);
  const mainContext = mainCanvas.getContext("2d");
  if (!mainContext) throw new Error("Failed to create main context");
  contexts.push(mainContext);

  const engine = createLineChartEngine(
    {
      postMessage: (message) => {
        messages.push(message);
      },
    },
    {
      ssr: true,
      createCanvas: (w, h) => {
        const canvas = createStubCanvas(w, h);
        const context = canvas.getContext("2d");
        if (context) contexts.push(context);
        return canvas;
      },
    },
  );

  engine.handleMessage("init", {
    canvas: mainCanvas,
    dpr: 1,
    config,
  });

  messages.length = 0;
  return { engine, messages, contexts };
}

function createPresentationHarness(config: Record<string, unknown> = {}, width = 900) {
  const harness = createHarness(
    {
      lod: { mode: "adaptive", density: 1 },
      ...config,
    },
    width,
  );
  harness.engine.handleMessage("setStatsConfig", {
    enabled: true,
    intervalMs: 16,
  });
  return harness;
}

function setTwoSeriesData(engine: ReturnType<typeof createLineChartEngine>): void {
  const x = new Float64Array([1, 2, 3, 4, 5]);
  const a = new Float64Array([10, 12, 11, 13, 14]);
  const b = new Float64Array([20, 22, 21, 19, 18]);
  engine.handleMessage("setData", {
    x,
    series: [a, b],
  });
}

function createSimpleRangeData(count: number): {
  x: Float64Array;
  low: Float64Array;
  high: Float64Array;
} {
  const x = new Float64Array(count);
  const low = new Float64Array(count);
  const high = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    x[index] = index;
    low[index] = Math.sin(index / 31) - 2;
    high[index] = Math.sin(index / 31) + 2;
  }
  return { x, low, high };
}

function getStrokeSegments(contexts: RecordingContext[], strokeStyle: string): PathCall[][] {
  const segments: PathCall[][] = [];
  let current: PathCall[] = [];

  for (const call of contexts.flatMap((context) => context.pathCalls)) {
    if (call.strokeStyle !== strokeStyle) continue;
    if (call.op === "moveTo") {
      if (current.length > 0) segments.push(current);
      current = [call];
    } else if (call.op === "lineTo" && current.length > 0) {
      current.push(call);
    } else if (call.op === "stroke" && current.length > 0) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function expectFirstGapSegmentEndsBefore(
  engine: ReturnType<typeof createLineChartEngine>,
  contexts: RecordingContext[],
  strokeStyle: string,
  lastDataX: number,
): void {
  const state = getLineEngineState(engine);
  const screenX = (dataX: number) =>
    state.padding.left +
    ((dataX - state.viewport.xMin) / (state.viewport.xMax - state.viewport.xMin)) *
      state.chartWidth;
  const firstX = screenX(0);
  const maxExpectedX = screenX(lastDataX);
  const firstSegments = getStrokeSegments(contexts, strokeStyle).filter(
    (segment) => Math.abs((segment[0].x ?? Infinity) - firstX) < 0.01,
  );

  expect(firstSegments.length).toBeGreaterThan(0);
  for (const segment of firstSegments) {
    expect(Math.max(...segment.map((call) => call.x ?? -Infinity))).toBeLessThanOrEqual(
      maxExpectedX + 0.01,
    );
  }
}

function expectGapSegmentRestartsAt(
  engine: ReturnType<typeof createLineChartEngine>,
  contexts: RecordingContext[],
  strokeStyle: string,
  nextDataX: number,
): void {
  const state = getLineEngineState(engine);
  const expectedX =
    state.padding.left +
    ((nextDataX - state.viewport.xMin) / (state.viewport.xMax - state.viewport.xMin)) *
      state.chartWidth;
  const segments = getStrokeSegments(contexts, strokeStyle);

  expect(segments.some((segment) => Math.abs((segment[0]?.x ?? Infinity) - expectedX) < 0.01)).toBe(
    true,
  );
}

describe("lineRenderer legend visibility", () => {
  it("synchronizes viewport and data bounds without enabling stats", () => {
    const { engine, messages } = createHarness();

    engine.handleMessage("setData", {
      x: new Float64Array([10, 20, 30]),
      series: [new Float64Array([1, 2, 3])],
    });

    expect(messages.filter((message) => message.type === "stats")).toHaveLength(0);
    expect(messages.find((message) => message.type === "viewportSync")).toEqual({
      type: "viewportSync",
      viewport: { xMin: 10, xMax: 30 },
      dataBounds: { xMin: 10, xMax: 30 },
    });

    messages.length = 0;
    engine.handleMessage("initRingBuffer", { maxPoints: 4, seriesCount: 1 });
    engine.handleMessage("addDataPoints", {
      timestamps: new Float64Array([100, 200]),
      valuesBySeries: [new Float64Array([5, 6])],
    });

    expect(messages.filter((message) => message.type === "stats")).toHaveLength(0);
    expect(messages.find((message) => message.type === "viewportSync")).toEqual({
      type: "viewportSync",
      viewport: { xMin: 100, xMax: 200 },
      dataBounds: { xMin: 100, xMax: 200 },
    });
  });

  it("emits initial series visibility after data is set", () => {
    const { engine, messages } = createHarness({
      seriesOptions: [{ name: "Alpha" }, { name: "Beta" }],
    });

    setTwoSeriesData(engine);

    const initEvent = messages.find((m) => m.type === "seriesVisibility");
    expect(initEvent).toEqual({
      type: "seriesVisibility",
      visibility: [true, true],
      source: "init",
      changedIndex: null,
    });
  });

  it("selects LOD density from the visible series count", () => {
    const { engine, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      legend: { allowHideAll: true },
      seriesOptions: Array.from({ length: 6 }, (_, index) => ({
        name: `Series ${index + 1}`,
      })),
    });
    const count = 10_000;
    const x = new Float64Array(count);
    const series = Array.from({ length: 6 }, () => new Float64Array(count));
    for (let i = 0; i < count; i++) {
      x[i] = i;
      for (let s = 0; s < series.length; s++) series[s][i] = i + s;
    }
    engine.handleMessage("setData", { x, series });
    for (let index = 1; index < series.length; index++) {
      engine.handleMessage("setSeriesVisible", { index, visible: false });
    }

    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    expect(messages.find((message) => message.type === "stats")).toMatchObject({
      bucketSize: 8,
      seriesCount: 6,
    });
  });

  it("bounds completed LOD work for a filled range series", () => {
    const { engine, messages } = createHarness(
      {
        animated: false,
        padding: { top: 4, right: 30, bottom: 16, left: 72 },
        rangeSelector: { visible: false },
        seriesOptions: [
          {
            type: "range",
            width: 0,
            band: {
              fill: 0.15,
              borderWidth: 0,
            },
          },
          { type: "line" },
          { type: "line" },
        ],
      },
      1_200,
    );
    const count = 17_544;
    const x = new Float64Array(count);
    const low = new Float64Array(count);
    const high = new Float64Array(count);
    const mean = new Float64Array(count);
    const feeder = new Float64Array(count);
    for (let index = 0; index < count; index++) {
      x[index] = index;
      const seasonal = Math.sin(index / 240);
      low[index] = seasonal * 8 - 12;
      high[index] = seasonal * 8 + 12;
      mean[index] = seasonal * 8;
      feeder[index] = seasonal * 9 + Math.sin(index / 17);
    }

    engine.handleMessage("setData", {
      x,
      series: [{ low, high }, mean, feeder],
    });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    const allSeriesStats = messages.find((message) => message.type === "stats");
    expect(allSeriesStats).toMatchObject({
      bucketSize: 128,
      lodLevel: 3,
      visiblePoints: count * 3,
    });
    expect(allSeriesStats?.renderedPoints as number).toBeLessThan(5_000);

    engine.handleMessage("setSeriesVisible", { index: 1, visible: false });
    engine.handleMessage("setSeriesVisible", { index: 2, visible: false });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    const rangeOnlyStats = messages.find((message) => message.type === "stats");
    expect(rangeOnlyStats).toMatchObject({
      bucketSize: 128,
      lodLevel: 3,
      visiblePoints: count,
    });
    expect(rangeOnlyStats?.renderedPoints as number).toBeLessThanOrEqual(
      allSeriesStats?.renderedPoints as number,
    );
  });

  it("bounds completed LOD work for a border-only range series", () => {
    const { engine, messages } = createHarness(
      {
        animated: false,
        padding: { top: 4, right: 30, bottom: 16, left: 72 },
        rangeSelector: { visible: false },
        seriesOptions: [
          {
            type: "range",
            band: {
              fill: false,
              borderColor: "#62d7ff",
              borderWidth: 1,
            },
          },
        ],
      },
      1_200,
    );
    const count = 17_544;
    const { x, low, high } = createSimpleRangeData(count);

    engine.handleMessage("setData", { x, series: [{ low, high }] });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    expect(messages.find((message) => message.type === "stats")).toMatchObject({
      bucketSize: 128,
      lodLevel: 3,
      visiblePoints: count,
    });
  });

  it("uses the coarsest completed range LOD when none fits the work budget", () => {
    const { engine, messages } = createHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        seriesOptions: [
          {
            type: "range",
            band: {
              fill: true,
              borderColor: "#62d7ff",
              borderWidth: 1,
            },
          },
        ],
      },
      180,
    );
    const count = getLineEngineState(engine).chartWidth * 3_072;
    const { x, low, high } = createSimpleRangeData(count);

    engine.handleMessage("setData", { x, series: [{ low, high }] });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    expect(messages.find((message) => message.type === "stats")).toMatchObject({
      bucketSize: 8_192,
      lodLevel: 6,
      visiblePoints: count,
    });
  });

  it("keeps the established LOD density for ordinary line series", () => {
    const { engine, messages } = createHarness(
      {
        animated: false,
        padding: { top: 4, right: 30, bottom: 16, left: 72 },
        rangeSelector: { visible: false },
        seriesOptions: [{ type: "line" }, { type: "line" }, { type: "line" }],
      },
      1_200,
    );
    const count = 17_544;
    const x = new Float64Array(count);
    const series = Array.from({ length: 3 }, () => new Float64Array(count));
    for (let index = 0; index < count; index++) {
      x[index] = index;
      for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
        series[seriesIndex][index] = Math.sin(index / (17 + seriesIndex));
      }
    }

    engine.handleMessage("setData", { x, series });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    expect(messages.find((message) => message.type === "stats")).toMatchObject({
      bucketSize: 8,
      lodLevel: 1,
      visiblePoints: count * 3,
    });
  });

  it("prevents hiding the last visible series when allowHideAll is false", () => {
    const { engine, messages } = createHarness({
      legend: { visible: true, allowHideAll: false },
      seriesOptions: [{ name: "Alpha" }, { name: "Beta" }],
    });

    setTwoSeriesData(engine);
    messages.length = 0;

    engine.handleMessage("setSeriesVisible", { index: 0, visible: false });

    expect(messages.find((m) => m.type === "seriesVisibility")).toEqual({
      type: "seriesVisibility",
      visibility: [false, true],
      source: "api",
      changedIndex: 0,
    });

    messages.length = 0;
    engine.handleMessage("setSeriesVisible", { index: 1, visible: false });
    expect(messages.find((m) => m.type === "seriesVisibility")).toBeUndefined();
  });

  it("toggles series from legend click when interactive", () => {
    const { engine, messages, contexts } = createHarness({
      legend: {
        visible: true,
        interactive: true,
        position: "right",
      },
      seriesOptions: [{ name: "Legend One" }, { name: "Legend Two" }],
    });

    setTwoSeriesData(engine);
    messages.length = 0;

    const legendLabelCall = contexts
      .flatMap((ctx) => ctx.fillTextCalls)
      .find((call) => call.text === "Legend One");
    expect(legendLabelCall).toBeDefined();
    if (!legendLabelCall) return;

    engine.handleMessage("legendClick", {
      x: legendLabelCall.x + 1,
      y: legendLabelCall.y,
    });

    expect(messages.find((m) => m.type === "seriesVisibility")).toEqual({
      type: "seriesVisibility",
      visibility: [false, true],
      source: "legend",
      changedIndex: 0,
    });
  });

  it("uses the shared default font family for legend labels", () => {
    const { engine, contexts } = createHarness({
      legend: { visible: true },
      seriesOptions: [{ name: "Default Font" }, { name: "Two" }],
    });

    setTwoSeriesData(engine);

    const labelCall = contexts
      .flatMap((ctx) => ctx.fillTextCalls)
      .find((call) => call.text === "Default Font");

    expect(labelCall?.font).toBe(`normal normal 12px ${DEFAULT_CHART_FONT_FAMILY}`);
  });

  it("honors an explicit legend font family override", () => {
    const { engine, contexts } = createHarness({
      legend: {
        visible: true,
        labelFont: { family: "Georgia, serif", size: 13, weight: 700 },
      },
      seriesOptions: [{ name: "Custom Font" }, { name: "Two" }],
    });

    setTwoSeriesData(engine);

    const labelCall = contexts
      .flatMap((ctx) => ctx.fillTextCalls)
      .find((call) => call.text === "Custom Font");

    expect(labelCall?.font).toBe("normal 700 13px Georgia, serif");
  });

  it("reuses legend measurements until label or font inputs change", () => {
    const { engine, contexts } = createHarness({
      legend: {
        visible: true,
        labelFont: { family: "Georgia, serif", size: 13 },
      },
      seriesOptions: [{ name: "Alpha" }, { name: "Beta" }],
    });
    const measureSpies = contexts.map((context) => vi.spyOn(context, "measureText"));
    const legendMeasurementCount = () =>
      measureSpies.reduce(
        (count, spy) =>
          count +
          spy.mock.calls.filter(([text]) => text === "Alpha" || text === "Beta" || text === "Gamma")
            .length,
        0,
      );

    setTwoSeriesData(engine);
    expect(legendMeasurementCount()).toBe(2);

    engine.handleMessage("invalidateCache", {});
    expect(legendMeasurementCount()).toBe(2);

    engine.handleMessage("updateSeriesAppearance", {
      index: 0,
      patch: { name: "Gamma" },
    });
    expect(legendMeasurementCount()).toBe(4);

    engine.handleMessage("updateAppearance", {
      patch: {
        legend: {
          labelFont: { family: "Arial, sans-serif", size: 14 },
        },
      },
    });
    expect(legendMeasurementCount()).toBe(6);
  });

  it("applies legend label max width in text drawing", () => {
    const { engine, contexts } = createHarness({
      legend: {
        visible: true,
        labelFont: {
          style: "italic",
          width: 24,
          color: "#ffffff",
        },
      },
      seriesOptions: [{ name: "VeryLongSeriesName" }, { name: "Two" }],
    });

    setTwoSeriesData(engine);

    const longLabelCall = contexts
      .flatMap((ctx) => ctx.fillTextCalls)
      .find((call) => call.text === "VeryLongSeriesName");

    expect(longLabelCall).toBeDefined();
    expect(longLabelCall?.maxWidth).toBe(24);
  });

  it("uses language-neutral numeric fallback labels when series names are omitted", () => {
    const { engine, contexts } = createHarness({
      legend: { visible: true },
    });

    setTwoSeriesData(engine);

    const labels = contexts.flatMap((ctx) => ctx.fillTextCalls).map((call) => call.text);
    expect(labels).toContain("1");
    expect(labels).toContain("2");
    expect(labels).not.toContain("Series 1");
    expect(labels).not.toContain("Series 2");
  });

  it("renders right-to-left legend labels with logical start alignment", () => {
    const rtlLabel = "العائد";
    const { engine, contexts } = createHarness({
      textDirection: "auto",
      legend: { visible: true },
      seriesOptions: [{ name: rtlLabel }, { name: "מדד" }],
    });

    setTwoSeriesData(engine);

    const labelCall = contexts
      .flatMap((ctx) => ctx.fillTextCalls)
      .find((call) => call.text === rtlLabel);

    expect(labelCall).toBeDefined();
    expect(labelCall?.direction).toBe("rtl");
    expect(labelCall?.textAlign).toBe("right");
  });

  it("accepts line swatch shape in legend config", () => {
    const { engine, contexts } = createHarness({
      legend: {
        visible: true,
        swatch: {
          shape: "line",
          size: 14,
        },
      },
      seriesOptions: [{ name: "Line Swatch Series" }, { name: "Two" }],
    });

    setTwoSeriesData(engine);

    const labelCall = contexts
      .flatMap((ctx) => ctx.fillTextCalls)
      .find((call) => call.text === "Line Swatch Series");

    expect(labelCall).toBeDefined();
  });

  it("positions right legend away from right-axis labels by default", () => {
    const { engine, contexts } = createHarness({
      axis: {
        right: { visible: true },
      },
      legend: {
        visible: true,
        position: "right",
      },
      seriesOptions: [{ name: "Right Legend" }, { name: "Second" }],
    });

    setTwoSeriesData(engine);

    const state = getLineEngineState(engine);
    const chartRight = state.width - state.padding.right;
    const legendCall = contexts
      .flatMap((ctx) => ctx.fillTextCalls)
      .find((call) => call.text === "Right Legend");

    expect(legendCall).toBeDefined();
    expect(legendCall!.x).toBeGreaterThan(chartRight + 20);
  });

  it("emits layout message with updated padding when bottom legend is enabled", () => {
    const { engine, messages } = createHarness({
      legend: {
        visible: true,
        position: "bottom",
        interactive: true,
      },
      seriesOptions: [{ name: "Alpha" }, { name: "Beta" }],
    });

    setTwoSeriesData(engine);

    const layoutMessages = messages.filter((m) => m.type === "layout");
    expect(layoutMessages.length).toBeGreaterThan(0);
    const last = layoutMessages[layoutMessages.length - 1];
    const padding = last.padding as { top: number; right: number; bottom: number; left: number };
    expect(padding.bottom).toBeGreaterThan(40);
    expect(last.legendInteractive).toBe(true);
    const hitboxes = last.legendHitboxes as Array<{ width: number; height: number }>;
    expect(Array.isArray(hitboxes)).toBe(true);
    expect(hitboxes.length).toBe(2);
    expect(hitboxes[0].width).toBeGreaterThan(0);
    expect(hitboxes[0].height).toBeGreaterThan(0);
  });

  it("wraps horizontal top legends within the available chart width", () => {
    const { engine, contexts } = createHarness(
      {
        legend: {
          visible: true,
          position: "top",
          layout: "row",
          align: "center",
          itemGap: 8,
        },
        seriesOptions: [{ name: "Primary Current" }, { name: "Secondary Current" }],
      },
      260,
    );

    setTwoSeriesData(engine);

    const calls = contexts.flatMap((context) => context.fillTextCalls);
    const primary = calls.filter((call) => call.text === "Primary Current").at(-1);
    const secondary = calls.filter((call) => call.text === "Secondary Current").at(-1);

    expect(primary).toBeDefined();
    expect(secondary).toBeDefined();
    expect(primary!.y).not.toBe(secondary!.y);
    expect(primary!.x).toBeGreaterThanOrEqual(0);
    expect(secondary!.x).toBeLessThan(260);
  });
});

describe("lineRenderer gradient cache", () => {
  it("skips an unparseable series gradient stop without aborting the render", () => {
    const acceptedColors: string[] = [];
    const { engine, contexts } = createHarness({
      animated: false,
      seriesOptions: [
        {
          fill: true,
          fillColor: {
            colors: ["#49d3ff", "#16213e"],
            direction: "vertical",
          },
        },
      ],
    });
    engine.handleMessage("setData", {
      x: new Float64Array([0, 1]),
      series: [new Float64Array([1, 2])],
    });
    for (const context of contexts) {
      context.createLinearGradient = () =>
        ({
          addColorStop(_offset: number, color: string) {
            if (color === "notacolor") throw new DOMException("Invalid color", "SyntaxError");
            acceptedColors.push(color);
          },
        }) as CanvasGradient;
    }

    expect(() =>
      engine.handleMessage("updateSeriesAppearance", {
        index: 0,
        patch: {
          fillColor: {
            colors: ["#49d3ff", "notacolor", "#16213e"],
          },
        },
      }),
    ).not.toThrow();
    expect(new Set(acceptedColors)).toEqual(new Set(["#49d3ff", "#16213e"]));
  });

  it("reuses a gradient definition signature until appearance changes", () => {
    let colorValueReads = 0;
    const colors = new Proxy(["#49d3ff", "#16213e"], {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          colorValueReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const { engine, contexts } = createHarness({
      animated: false,
      seriesOptions: [
        {
          fill: true,
          fillColor: {
            colors,
            direction: "vertical",
          },
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 1]),
      series: [new Float64Array([1, 2])],
    });
    const initialReads = colorValueReads;
    const initialGradientCount = contexts.reduce(
      (count, context) => count + context.createLinearGradientCalls,
      0,
    );
    expect(initialReads).toBeGreaterThan(0);

    engine.handleMessage("invalidateCache", {});
    expect(colorValueReads).toBe(initialReads);
    expect(contexts.reduce((count, context) => count + context.createLinearGradientCalls, 0)).toBe(
      initialGradientCount,
    );

    engine.handleMessage("updateSeriesAppearance", {
      index: 0,
      patch: {
        fillColor: {
          colors: ["#ffcf7a", "#16213e"],
        },
      },
    });
    expect(
      contexts.reduce((count, context) => count + context.createLinearGradientCalls, 0),
    ).toBeGreaterThan(initialGradientCount);
  });

  it("evicts cached series gradients after the bounded capacity is reached", () => {
    const seriesCount = 300;
    const seriesOptions = Array.from({ length: seriesCount }, (_, index) => ({
      name: String(index + 1),
      fill: true,
      fillColor: {
        type: "gradient" as const,
        direction: "vertical" as const,
        colors: [`hsl(${index} 70% 45%)`, `hsl(${index} 70% 20%)`],
      },
    }));
    const { engine, contexts } = createHarness({
      animated: false,
      seriesOptions,
    });
    const x = new Float64Array([0, 1]);
    const dataSeries = Array.from(
      { length: seriesCount },
      (_, index) => new Float64Array([index, index + 1]),
    );

    engine.handleMessage("setData", { x, series: dataSeries });
    const firstPassCount = contexts.reduce(
      (count, context) => count + context.createLinearGradientCalls,
      0,
    );
    expect(firstPassCount).toBeGreaterThanOrEqual(seriesCount);

    engine.handleMessage("invalidateCache", {});
    const secondPassCount = contexts.reduce(
      (count, context) => count + context.createLinearGradientCalls,
      0,
    );
    expect(secondPassCount).toBeGreaterThan(firstPassCount);
  });
});

describe("updateSeriesAppearance deep merge", () => {
  it("creates missing renderer series options before applying a patch", () => {
    const { engine } = createHarness();
    setTwoSeriesData(engine);

    engine.handleMessage("updateSeriesAppearance", {
      index: 0,
      patch: { marker: { shape: "triangle", size: 9 } },
    });

    expect(engine.getMarkerConfig(0)).toMatchObject({
      shape: "triangle",
      size: 9,
    });
  });

  it("preserves existing marker fields when patching a nested sub-field", () => {
    const { engine } = createHarness({
      seriesOptions: [
        {
          name: "A",
          color: "#ff0000",
          marker: { shape: "diamond", size: 8, glow: { blur: 12, opacity: 0.5 } },
        },
        { name: "B" },
      ],
    });

    setTwoSeriesData(engine);

    // Patch only marker.glow.blur
    engine.handleMessage("updateSeriesAppearance", {
      index: 0,
      patch: { marker: { glow: { blur: 20 } } },
    });

    const marker = engine.getMarkerConfig(0);
    // glow.blur updated
    expect(marker.glow.blur).toBe(20);
    // glow.opacity preserved from original
    expect(marker.glow.opacity).toBe(0.5);
    // shape preserved from original
    expect(marker.shape).toBe("diamond");
  });

  it("preserves marker shape when patching only marker size", () => {
    const { engine } = createHarness({
      seriesOptions: [{ name: "A", marker: { shape: "square", size: 6 } }, { name: "B" }],
    });

    setTwoSeriesData(engine);

    engine.handleMessage("updateSeriesAppearance", {
      index: 0,
      patch: { marker: { size: 10 } },
    });

    const marker = engine.getMarkerConfig(0);
    expect(marker.size).toBe(10);
    expect(marker.shape).toBe("square"); // preserved
  });
});

describe("lineRenderer hierarchical presentation LOD", () => {
  const color = "#2468ac";

  function createDenseIrregularData(count: number): {
    x: Float64Array;
    y: Float64Array;
  } {
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    x[0] = 10;
    for (let index = 0; index < count; index++) {
      if (index > 0) x[index] = x[index - 1] + (index % 11 === 0 ? 5 : 1);
      y[index] = ((index * 97) % 997) + index * 1e-6;
    }
    y[1_337] = -500;
    y[12_345] = 1_500;
    return { x, y };
  }

  function lowerBound(
    values: Float64Array,
    target: number,
    start: number,
    endExclusive: number,
  ): number {
    let low = start;
    let high = endExclusive;
    while (low < high) {
      const middle = low + ((high - low) >> 1);
      if (values[middle] < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function summarizeRawColumn(
    x: Float64Array,
    y: Float64Array,
    start: number,
    end: number,
  ): Array<{ x: number; y: number }> {
    let minIndex = start;
    let maxIndex = start;
    for (let index = start + 1; index <= end; index++) {
      if (y[index] < y[minIndex]) minIndex = index;
      if (y[index] > y[maxIndex]) maxIndex = index;
    }
    const first = { x: x[start], y: y[start] };
    const minimum = { x: x[minIndex], y: y[minIndex] };
    const maximum = { x: x[maxIndex], y: y[maxIndex] };
    const last = { x: x[end], y: y[end] };
    return minIndex <= maxIndex ? [first, minimum, maximum, last] : [first, maximum, minimum, last];
  }

  interface RawGapRun {
    first: number;
    last: number;
    minimum: number;
    maximum: number;
  }

  function summarizeRawGapColumn(
    x: Float64Array,
    y: Float64Array,
    start: number,
    end: number,
  ): Array<{ x: number; y: number }> {
    const runs: RawGapRun[] = [];
    let hasGap = false;
    for (let index = start; index <= end;) {
      if (!Number.isFinite(y[index])) {
        hasGap = true;
        index++;
        continue;
      }
      const run: RawGapRun = {
        first: index,
        last: index,
        minimum: index,
        maximum: index,
      };
      index++;
      while (index <= end && Number.isFinite(y[index])) {
        run.last = index;
        if (y[index] < y[run.minimum]) run.minimum = index;
        if (y[index] > y[run.maximum]) run.maximum = index;
        index++;
      }
      runs.push(run);
    }

    if (!hasGap) return summarizeRawColumn(x, y, start, end);
    if (runs.length === 0) return [{ x: NaN, y: NaN }];

    let selected: RawGapRun[];
    if (runs.length <= 3) {
      selected = runs.filter((run) => run.last > run.first);
    } else {
      const minRun = runs.reduce((best, run) => (y[run.minimum] < y[best.minimum] ? run : best));
      const maxRun = runs.reduce((best, run) => (y[run.maximum] > y[best.maximum] ? run : best));
      const longest = runs
        .filter((run) => run !== minRun && run !== maxRun)
        .reduce<RawGapRun | null>((best, run) => {
          if (!best) return run;
          return run.last - run.first > best.last - best.first ? run : best;
        }, null);
      selected = [minRun, maxRun, ...(longest ? [longest] : [])]
        .filter(
          (run, index, candidates) => run.last > run.first && candidates.indexOf(run) === index,
        )
        .sort((left, right) => left.first - right.first);
    }

    if (selected.length === 0) return [{ x: NaN, y: NaN }];
    const points: Array<{ x: number; y: number }> = [];
    const isolate = runs.length > 3;
    if (isolate || selected[0].first > start) {
      points.push({ x: NaN, y: NaN });
    }
    for (let runIndex = 0; runIndex < selected.length; runIndex++) {
      if (runIndex > 0) points.push({ x: NaN, y: NaN });
      const run = selected[runIndex];
      const ordered =
        run.minimum <= run.maximum
          ? [run.first, run.minimum, run.maximum, run.last]
          : [run.first, run.maximum, run.minimum, run.last];
      for (const sourceIndex of ordered) {
        const previous = points.at(-1);
        if (previous && previous.x === x[sourceIndex] && previous.y === y[sourceIndex]) {
          continue;
        }
        points.push({ x: x[sourceIndex], y: y[sourceIndex] });
      }
    }
    if (isolate || selected.at(-1)!.last < end) {
      points.push({ x: NaN, y: NaN });
    }
    return points;
  }

  function buildRawColumnReference(
    engine: ReturnType<typeof createLineChartEngine>,
    x: Float64Array,
    y: Float64Array,
    delta: number,
  ): Array<{ x: number; y: number }> {
    const state = getLineEngineState(engine);
    const anchor = x[0];
    const firstGridIndex = Math.floor((state.viewport.xMin - anchor) / delta);
    const lastGridIndex = Math.floor((state.viewport.xMax - anchor) / delta);
    const points: Array<{ x: number; y: number }> = [];
    let columnStart = 0;

    for (
      let gridIndex = firstGridIndex;
      gridIndex <= lastGridIndex && columnStart < x.length;
      gridIndex++
    ) {
      const nextColumnStart =
        gridIndex === lastGridIndex
          ? x.length
          : lowerBound(x, anchor + (gridIndex + 1) * delta, columnStart, x.length);
      if (nextColumnStart > columnStart) {
        points.push(...summarizeRawColumn(x, y, columnStart, nextColumnStart - 1));
      }
      columnStart = nextColumnStart;
    }
    return points;
  }

  function buildRawRangeColumnReference(
    engine: ReturnType<typeof createLineChartEngine>,
    x: Float64Array,
    low: Float64Array,
    high: Float64Array,
    delta: number,
  ): Array<{ x: number; low: number; high: number }> {
    const state = getLineEngineState(engine);
    const anchor = x[0];
    const firstGridIndex = Math.floor((state.viewport.xMin - anchor) / delta);
    const lastGridIndex = Math.floor((state.viewport.xMax - anchor) / delta);
    const points: Array<{ x: number; low: number; high: number }> = [];
    let columnStart = 0;

    for (
      let gridIndex = firstGridIndex;
      gridIndex <= lastGridIndex && columnStart < x.length;
      gridIndex++
    ) {
      const nextColumnStart =
        gridIndex === lastGridIndex
          ? x.length
          : lowerBound(x, anchor + (gridIndex + 1) * delta, columnStart, x.length);
      if (nextColumnStart > columnStart) {
        const end = nextColumnStart - 1;
        let minLowIndex = columnStart;
        let maxHighIndex = columnStart;
        for (let index = columnStart + 1; index <= end; index++) {
          if (low[index] < low[minLowIndex]) minLowIndex = index;
          if (high[index] > high[maxHighIndex]) maxHighIndex = index;
        }
        const ordered =
          minLowIndex <= maxHighIndex
            ? [columnStart, minLowIndex, maxHighIndex, end]
            : [columnStart, maxHighIndex, minLowIndex, end];
        for (const index of ordered) {
          points.push({ x: x[index], low: low[index], high: high[index] });
        }
      }
      columnStart = nextColumnStart;
    }
    return points;
  }

  function buildRawGapColumnReference(
    engine: ReturnType<typeof createLineChartEngine>,
    x: Float64Array,
    y: Float64Array,
    delta: number,
  ): Array<{ x: number; y: number }> {
    const state = getLineEngineState(engine);
    const anchor = x[0];
    const firstGridIndex = Math.floor((state.viewport.xMin - anchor) / delta);
    const lastGridIndex = Math.floor((state.viewport.xMax - anchor) / delta);
    const points: Array<{ x: number; y: number }> = [];
    let columnStart = 0;

    for (
      let gridIndex = firstGridIndex;
      gridIndex <= lastGridIndex && columnStart < x.length;
      gridIndex++
    ) {
      const nextColumnStart =
        gridIndex === lastGridIndex
          ? x.length
          : lowerBound(x, anchor + (gridIndex + 1) * delta, columnStart, x.length);
      if (nextColumnStart > columnStart) {
        points.push(...summarizeRawGapColumn(x, y, columnStart, nextColumnStart - 1));
      }
      columnStart = nextColumnStart;
    }
    return points;
  }

  function buildReferenceScreenSegments(
    engine: ReturnType<typeof createLineChartEngine>,
    points: Array<{ x: number; y: number }>,
  ): Array<Array<{ x: number; y: number }>> {
    const state = getLineEngineState(engine);
    const segments: Array<Array<{ x: number; y: number }>> = [];
    let segment: Array<{ x: number; y: number }> = [];
    for (const point of points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        if (segment.length > 0) segments.push(segment);
        segment = [];
        continue;
      }
      segment.push({
        x:
          state.padding.left +
          ((point.x - state.viewport.xMin) / (state.viewport.xMax - state.viewport.xMin)) *
            state.chartWidth,
        y:
          state.chartTop +
          ((state.viewport.yMax - point.y) / (state.viewport.yMax - state.viewport.yMin)) *
            state.chartHeight,
      });
    }
    if (segment.length > 0) segments.push(segment);
    return segments;
  }

  function expectSegmentsToMatchReference(
    actual: PathCall[][],
    expected: Array<Array<{ x: number; y: number }>>,
  ): void {
    expect(actual).toHaveLength(expected.length);
    for (let segment = 0; segment < expected.length; segment++) {
      expect(actual[segment]).toHaveLength(expected[segment].length);
      for (let point = 0; point < expected[segment].length; point++) {
        expect(actual[segment][point].x).toBeCloseTo(expected[segment][point].x, 8);
        expect(actual[segment][point].y).toBeCloseTo(expected[segment][point].y, 8);
      }
    }
  }

  it("matches direct raw first/min/max/last columns with irregular X", () => {
    const { engine, messages, contexts } = createPresentationHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [{ type: "line", color, width: 1 }],
      },
      420,
    );
    const { x, y } = createDenseIrregularData(20_000);
    const reads = { count: 0 };
    const countedY = new Proxy(y, {
      get(target, property) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          reads.count++;
        }
        return Reflect.get(target, property, target);
      },
    });

    engine.handleMessage("setData", { x, series: [countedY] });
    const presentationGridDelta = messages.filter((message) => message.type === "stats").at(-1)
      ?.presentationGridDelta as number;
    const expectedDataPoints = buildRawColumnReference(engine, x, y, presentationGridDelta);
    const state = getLineEngineState(engine);
    const expectedScreenPoints = expectedDataPoints.map((point) => ({
      x:
        state.padding.left +
        ((point.x - state.viewport.xMin) / (state.viewport.xMax - state.viewport.xMin)) *
          state.chartWidth,
      y:
        state.chartTop +
        ((state.viewport.yMax - point.y) / (state.viewport.yMax - state.viewport.yMin)) *
          state.chartHeight,
    }));

    for (const context of contexts) context.pathCalls.length = 0;
    messages.length = 0;
    reads.count = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    const segment = getStrokeSegments(contexts, color).sort(
      (left, right) => right.length - left.length,
    )[0];
    expect(segment).toHaveLength(expectedScreenPoints.length);
    for (let index = 0; index < expectedScreenPoints.length; index++) {
      expect(segment[index].x).toBeCloseTo(expectedScreenPoints[index].x, 8);
      expect(segment[index].y).toBeCloseTo(expectedScreenPoints[index].y, 8);
    }
    expect(messages.find((message) => message.type === "stats")).toMatchObject({
      renderedPoints: expectedScreenPoints.length,
    });
    expect(reads.count).toBeLessThan(x.length / 10);
  });

  it("matches direct raw gap compaction without bridging the gap", () => {
    const { engine, messages, contexts } = createPresentationHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [{ type: "line", color, width: 1 }],
      },
      420,
    );
    const { x, y } = createDenseIrregularData(20_000);
    y[4_321] = NaN;
    engine.handleMessage("setData", { x, series: [y] });
    const presentationGridDelta = messages.filter((message) => message.type === "stats").at(-1)
      ?.presentationGridDelta as number;
    const expectedPoints = buildRawGapColumnReference(engine, x, y, presentationGridDelta);
    const expectedSegments = buildReferenceScreenSegments(engine, expectedPoints);

    for (const context of contexts) context.pathCalls.length = 0;
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    expectSegmentsToMatchReference(getStrokeSegments(contexts, color), expectedSegments);
    expect(messages.find((message) => message.type === "stats")).toMatchObject({
      presentationMode: "columns",
      renderedPoints: expectedPoints.length,
    });
  });

  it("matches direct raw representative selection in fragmented columns", () => {
    const { engine, messages, contexts } = createPresentationHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [{ type: "line", color, width: 1 }],
      },
      180,
    );
    const count = 20_000;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    y.fill(NaN);
    for (let index = 0; index < count; index++) {
      x[index] = index;
      const phase = index % 80;
      if (
        phase < 4 ||
        (phase >= 8 && phase < 17) ||
        (phase >= 23 && phase < 28) ||
        (phase >= 40 && phase < 54)
      ) {
        y[index] = Math.sin(index / 17) * 20;
      }
    }
    y[88] = -1_000;
    y[123] = 1_000;

    engine.handleMessage("setData", { x, series: [y] });
    const presentationGridDelta = messages.filter((message) => message.type === "stats").at(-1)
      ?.presentationGridDelta as number;
    const expectedPoints = buildRawGapColumnReference(engine, x, y, presentationGridDelta);
    const expectedSegments = buildReferenceScreenSegments(engine, expectedPoints);
    for (const context of contexts) context.pathCalls.length = 0;
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    expectSegmentsToMatchReference(getStrokeSegments(contexts, color), expectedSegments);
    const stats = messages.find((message) => message.type === "stats");
    expect(stats).toMatchObject({
      presentationMode: "columns",
      renderedPoints: expectedPoints.length,
    });
    expect(stats?.presentationVertices as number).toBeLessThanOrEqual(
      (stats?.presentationColumns as number) * 16,
    );
  });

  it("collapses singleton-only fragmentation instead of fabricating lines", () => {
    const { engine, messages, contexts } = createPresentationHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [{ type: "line", color, width: 1 }],
      },
      180,
    );
    const count = 20_000;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    for (let index = 0; index < count; index++) {
      x[index] = index;
      y[index] = index % 2 === 0 ? index % 100 : NaN;
    }

    engine.handleMessage("setData", { x, series: [y] });
    for (const context of contexts) context.pathCalls.length = 0;
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    expect(getStrokeSegments(contexts, color)).toEqual([]);
    const stats = messages.find((message) => message.type === "stats");
    expect(stats).toMatchObject({ presentationMode: "columns" });
    expect(stats?.presentationVertices).toBe(stats?.presentationColumns);
  });

  it("retains singleton representatives for dense scatter presentation", () => {
    const { engine, messages, contexts } = createPresentationHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        legend: { visible: false },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [
          {
            type: "scatter",
            point: { shape: "square", size: 2, color },
          },
        ],
      },
      180,
    );
    const count = 20_000;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    for (let index = 0; index < count; index++) {
      x[index] = index;
      y[index] = index % 2 === 0 ? index % 100 : NaN;
    }

    engine.handleMessage("setData", { x, series: [y] });
    for (const context of contexts) context.pathCalls.length = 0;
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    const stats = messages.find((message) => message.type === "stats");
    expect(stats).toMatchObject({ presentationMode: "columns" });
    expect(stats?.presentationVertices as number).toBeLessThanOrEqual(
      (stats?.presentationColumns as number) * 16,
    );
    expect(
      contexts.flatMap((context) => context.pathCalls).some((call) => call.op === "rect"),
    ).toBe(true);
  });

  it("uses bounded screen-space representatives for dense bars", () => {
    const { engine, messages, contexts } = createPresentationHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        legend: { visible: false },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [{ type: "bar", color }],
      },
      180,
    );
    const { x, y } = createDenseIrregularData(20_000);
    engine.handleMessage("setData", { x, series: [y] });
    for (const context of contexts) context.pathCalls.length = 0;
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    const stats = messages.find((message) => message.type === "stats");
    expect(stats).toMatchObject({ presentationMode: "columns" });
    expect(stats?.presentationVertices as number).toBeLessThanOrEqual(
      (stats?.presentationColumns as number) * 4,
    );
    expect(
      contexts
        .flatMap((context) => context.pathCalls)
        .some((call) => call.op === "fillRect" || call.op === "fill"),
    ).toBe(true);
  });

  it("keeps stacked areas on the cumulative-geometry-safe pyramid path", () => {
    const { engine, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      lod: { mode: "adaptive", density: 0.5 },
      seriesOptions: [
        { type: "stacked-area", stack: { group: "total" } },
        { type: "stacked-area", stack: { group: "total" } },
      ],
    });
    const count = 20_000;
    const x = new Float64Array(count);
    const base = new Float64Array(count);
    const top = new Float64Array(count);
    for (let index = 0; index < count; index++) {
      x[index] = index;
      base[index] = 10 + Math.sin(index / 31);
      top[index] = 5 + Math.cos(index / 47);
    }

    engine.handleMessage("setData", { x, series: [base, top] });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    expect(messages.find((message) => message.type === "stats")).toMatchObject({
      presentationMode: "pyramid",
      presentationColumns: 0,
      presentationDensity: 0.5,
    });
  });

  it("rebuilds screen-space columns after a streaming ring buffer wraps", () => {
    const { engine, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      lod: { mode: "adaptive", density: 0.5 },
      seriesOptions: [{ type: "line" }],
    });
    const maxPoints = 20_000;
    engine.handleMessage("initRingBuffer", { maxPoints, seriesCount: 1 });

    const append = (start: number, count: number) => {
      const timestamps = new Float64Array(count);
      const values = new Float64Array(count);
      for (let index = 0; index < count; index++) {
        timestamps[index] = start + index;
        values[index] = Math.sin((start + index) / 31);
      }
      engine.handleMessage("addDataPoints", {
        timestamps,
        valuesBySeries: [values],
      });
    };

    append(0, maxPoints);
    append(maxPoints, 5_000);
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    const stats = messages.find((message) => message.type === "stats");
    expect(stats).toMatchObject({
      presentationMode: "columns",
      presentationDensity: 0.5,
      ringBuffer: true,
      totalReceived: 25_000,
    });
    expect(stats?.presentationColumns as number).toBeGreaterThan(0);
    expect(stats?.renderedPoints as number).toBeLessThan(maxPoints / 2);
  });

  it("keeps sparse Feeder-style gaps and an interior anomaly bounded", () => {
    const { engine, messages, contexts } = createPresentationHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [{ type: "line", color, width: 1 }],
      },
      420,
    );
    const count = 100_000;
    const anomalyIndex = 52_631;
    const startTime = Date.UTC(2023, 9, 20);
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    for (let index = 0; index < count; index++) {
      x[index] = startTime + index * 60_000;
      y[index] = 60 + Math.sin(index / 1_100) * 12;
    }
    for (let index = 997; index < count; index += 997) y[index] = NaN;
    y[anomalyIndex] = -10;
    const reads = { count: 0 };
    const countedY = new Proxy(y, {
      get(target, property) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          reads.count++;
        }
        return Reflect.get(target, property, target);
      },
    });

    engine.handleMessage("setData", { x, series: [countedY] });
    for (const context of contexts) context.pathCalls.length = 0;
    messages.length = 0;
    reads.count = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    const stats = messages.find((message) => message.type === "stats");
    expect(stats).toMatchObject({ presentationMode: "columns" });
    expect(stats?.presentationVertices as number).toBeLessThanOrEqual(
      (stats?.presentationColumns as number) * 16,
    );
    expect(reads.count).toBeLessThan(count / 10);

    const state = getLineEngineState(engine);
    const anomalyX =
      state.padding.left +
      ((x[anomalyIndex] - state.viewport.xMin) / (state.viewport.xMax - state.viewport.xMin)) *
        state.chartWidth;
    const anomalyY =
      state.chartTop +
      ((state.viewport.yMax - y[anomalyIndex]) / (state.viewport.yMax - state.viewport.yMin)) *
        state.chartHeight;
    expect(
      getStrokeSegments(contexts, color).some((segment) =>
        segment.some(
          (point) =>
            Math.abs((point.x ?? Infinity) - anomalyX) < 0.01 &&
            Math.abs((point.y ?? Infinity) - anomalyY) < 0.01,
        ),
      ),
    ).toBe(true);
  });

  it("queries compact landing-demo gaps without bridging their finite runs", () => {
    const { engine, messages, contexts } = createPresentationHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [{ type: "line", color, width: 1 }],
      },
      420,
    );
    const count = 200_000;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    for (let index = 0; index < count; index++) {
      x[index] = index;
      y[index] = index % 5_000 < 2_000 ? NaN : Math.sin(index / 37);
    }

    engine.handleMessage("setData", { x, series: [y] });
    for (const context of contexts) context.pathCalls.length = 0;
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    const stats = messages.find((message) => message.type === "stats");
    expect(stats).toMatchObject({ presentationMode: "columns" });
    expect(stats?.presentationLargestBucket as number).toBeGreaterThan(1);
    expect(stats?.presentationQueryVisits as number).toBeLessThanOrEqual(
      (stats?.presentationColumns as number) * 64,
    );
    expect(stats?.presentationQueryVisits as number).toBeLessThan(count / 20);

    const state = getLineEngineState(engine);
    const screenX = (dataX: number) =>
      state.padding.left +
      ((dataX - state.viewport.xMin) / (state.viewport.xMax - state.viewport.xMin)) *
        state.chartWidth;
    const gapLeft = screenX(4_999);
    const gapRight = screenX(7_000);
    const segments = getStrokeSegments(contexts, color);
    expect(
      segments.some((segment) => Math.abs((segment[0]?.x ?? Infinity) - gapRight) < 0.01),
    ).toBe(true);
    expect(
      segments.some(
        (segment) =>
          segment.some((point) => (point.x ?? Infinity) <= gapLeft + 0.01) &&
          segment.some((point) => (point.x ?? -Infinity) >= gapRight - 0.01),
      ),
    ).toBe(false);
  });

  it("matches direct raw low/high range columns", () => {
    const fillColor = "#13579b";
    const { engine, messages, contexts } = createPresentationHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        lod: { mode: "adaptive", density: 0.5 },
        legend: { visible: false },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [
          {
            type: "range",
            width: 0,
            band: { fillColor, fill: 1, borderWidth: 0 },
          },
        ],
      },
      420,
    );
    const { x } = createDenseIrregularData(20_000);
    const low = new Float64Array(x.length);
    const high = new Float64Array(x.length);
    for (let index = 0; index < x.length; index++) {
      low[index] = -20 + Math.sin(index / 17) * 8;
      high[index] = 25 + Math.cos(index / 23) * 11;
    }
    low[1_337] = -100;
    high[12_345] = 120;

    engine.handleMessage("setData", {
      x,
      series: [{ low, high }],
    });
    const presentationGridDelta = messages.filter((message) => message.type === "stats").at(-1)
      ?.presentationGridDelta as number;
    const expected = buildRawRangeColumnReference(engine, x, low, high, presentationGridDelta);
    const state = getLineEngineState(engine);
    const expectedPolygon = [
      ...expected.map((point) => ({
        x:
          state.padding.left +
          ((point.x - state.viewport.xMin) / (state.viewport.xMax - state.viewport.xMin)) *
            state.chartWidth,
        y:
          state.chartTop +
          ((state.viewport.yMax - point.high) / (state.viewport.yMax - state.viewport.yMin)) *
            state.chartHeight,
      })),
      ...[...expected].reverse().map((point) => ({
        x:
          state.padding.left +
          ((point.x - state.viewport.xMin) / (state.viewport.xMax - state.viewport.xMin)) *
            state.chartWidth,
        y:
          state.chartTop +
          ((state.viewport.yMax - point.low) / (state.viewport.yMax - state.viewport.yMin)) *
            state.chartHeight,
      })),
    ];

    for (const context of contexts) context.pathCalls.length = 0;
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});
    const polygon = contexts
      .flatMap((context) => context.pathCalls)
      .filter((call) => call.op === "moveTo" || call.op === "lineTo");
    expect(polygon).toHaveLength(expectedPolygon.length);
    for (let index = 0; index < expectedPolygon.length; index++) {
      expect(polygon[index].x).toBeCloseTo(expectedPolygon[index].x, 8);
      expect(polygon[index].y).toBeCloseTo(expectedPolygon[index].y, 8);
    }
    expect(messages.find((message) => message.type === "stats")).toMatchObject({
      presentationMode: "columns",
      renderedPoints: expected.length * 2,
    });
  });

  it("keeps fragmented range presentation bounded and disconnected", () => {
    const { engine, messages, contexts } = createPresentationHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        legend: { visible: false },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [
          {
            type: "range",
            width: 0,
            band: { fillColor: "#13579b", fill: 1, borderWidth: 0 },
          },
        ],
      },
      180,
    );
    const count = 20_000;
    const x = new Float64Array(count);
    const low = new Float64Array(count);
    const high = new Float64Array(count);
    low.fill(NaN);
    high.fill(NaN);
    for (let index = 0; index < count; index++) {
      x[index] = index;
      if (index % 6 < 3) {
        low[index] = Math.sin(index / 19) - 5;
        high[index] = Math.cos(index / 23) + 5;
      }
    }

    engine.handleMessage("setData", { x, series: [{ low, high }] });
    for (const context of contexts) context.pathCalls.length = 0;
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    const stats = messages.find((message) => message.type === "stats");
    expect(stats).toMatchObject({ presentationMode: "columns" });
    expect(stats?.presentationVertices as number).toBeLessThanOrEqual(
      (stats?.presentationColumns as number) * 32,
    );
    expect(
      contexts.flatMap((context) => context.pathCalls).filter((call) => call.op === "moveTo")
        .length,
    ).toBeGreaterThan(1);
  });

  it("budgets adaptive range fill and border geometry separately", () => {
    const width = 420;
    const count = 20_000;
    const x = new Float64Array(count);
    const center = new Float64Array(count);
    const low = new Float64Array(count);
    const high = new Float64Array(count);
    for (let index = 0; index < count; index++) {
      x[index] = index;
      center[index] = Math.sin(index / 37) * 10;
      low[index] = center[index] - 5 - Math.cos(index / 41);
      high[index] = center[index] + 5 + Math.sin(index / 43);
    }

    const render = (range: false | "band-only" | "centered") => {
      const { engine, messages } = createPresentationHarness(
        {
          animated: false,
          rangeSelector: { visible: false },
          legend: { visible: false },
          lod: { mode: "adaptive", density: 0.75 },
          grid: { vertical: false, horizontal: false },
          axis: {
            bottom: { visible: false },
            top: { visible: false },
            left: { visible: false },
            right: { visible: false },
          },
          seriesOptions: [
            range
              ? {
                  type: "range",
                  width: range === "centered" ? 1 : 0,
                  band: {
                    fill: 0.2,
                    borderColor: "#abcdef",
                    borderWidth: 1,
                  },
                }
              : { type: "line", width: 1 },
          ],
        },
        width,
      );
      engine.handleMessage("setData", {
        x,
        series: range ? [{ y: center, low, high }] : [center],
      });
      messages.length = 0;
      engine.handleMessage("setStatsConfig", {
        enabled: true,
        intervalMs: 16,
      });
      engine.handleMessage("invalidateCache", {});
      return {
        chartWidth: getLineEngineState(engine).chartWidth,
        stats: messages.find((message) => message.type === "stats"),
      };
    };

    const ordinary = render(false);
    const range = render("band-only");
    const centeredRange = render("centered");
    expect(range.stats).toMatchObject({
      presentationMode: "columns",
      presentationDensity: 0.75,
    });
    expect(range.stats?.presentationColumns as number).toBeGreaterThan(0);
    expect(range.stats?.presentationColumns as number).toBeLessThan(
      ordinary.stats?.presentationColumns as number,
    );
    const bandVertices = range.stats?.presentationVertices as number;
    expect(bandVertices).toBeGreaterThan(0);
    // Each range point contributes two unique presentation vertices. A filled
    // band with two borders has five render-work units per range point, so the
    // unique-vertex equivalent is 2.5 work units.
    expect(bandVertices * 2.5).toBeLessThanOrEqual(range.chartWidth * 6 + 64);
    // A visible independent center stays on the ordinary grid, and its band
    // contributes two boundary vertices for each center vertex.
    expect(centeredRange.stats?.presentationVertices).toBe(
      (ordinary.stats?.presentationVertices as number) * 3,
    );
  });

  it("rebuilds zero-width range center presentation after live width changes", () => {
    const width = 420;
    const count = 20_000;
    const centerColor = "#123456";
    const fillColor = "#13579b";
    const x = new Float64Array(count);
    const center = new Float64Array(count);
    const low = new Float64Array(count);
    const high = new Float64Array(count);
    for (let index = 0; index < count; index++) {
      x[index] = index;
      center[index] = Math.sin(index / 37) * 10;
      low[index] = center[index] - 5;
      high[index] = center[index] + 5;
    }

    const { engine, messages, contexts } = createPresentationHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        legend: { visible: false },
        lod: { mode: "adaptive", density: 0.75 },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [
          {
            type: "range",
            color: centerColor,
            width: 0,
            band: { fillColor, fill: 1, borderWidth: 0 },
          },
        ],
      },
      width,
    );
    engine.handleMessage("setData", {
      x,
      series: [{ y: center, low, high }],
    });

    const capture = () => {
      for (const context of contexts) context.pathCalls.length = 0;
      messages.length = 0;
      engine.handleMessage("setStatsConfig", {
        enabled: true,
        intervalMs: 16,
      });
      engine.handleMessage("invalidateCache", {});
      const calls = contexts.flatMap((context) => context.pathCalls);
      return {
        stats: messages.find((message) => message.type === "stats"),
        bandVisible: calls.some((call) => call.op === "fill" && call.fillStyle === fillColor),
        centerVisible: calls.some(
          (call) => call.op === "stroke" && call.strokeStyle === centerColor,
        ),
      };
    };

    const hidden = capture();
    engine.handleMessage("updateSeriesAppearance", {
      index: 0,
      patch: { width: 1 },
    });
    const visible = capture();
    engine.handleMessage("updateSeriesAppearance", {
      index: 0,
      patch: { width: 0 },
    });
    const hiddenAgain = capture();

    expect(hidden.bandVisible).toBe(true);
    expect(visible.bandVisible).toBe(true);
    expect(hiddenAgain.bandVisible).toBe(true);
    expect(hidden.centerVisible).toBe(false);
    expect(visible.centerVisible).toBe(true);
    expect(hiddenAgain.centerVisible).toBe(false);

    expect(visible.stats?.presentationVertices as number).toBeGreaterThan(
      hidden.stats?.presentationVertices as number,
    );
    expect(hiddenAgain.stats?.presentationVertices).toBe(hidden.stats?.presentationVertices);
    expect(hiddenAgain.stats?.presentationColumns).toBe(hidden.stats?.presentationColumns);
    expect(hidden.stats?.dataVersion).toBe(visible.stats?.dataVersion);
    expect(hiddenAgain.stats?.dataVersion).toBe(hidden.stats?.dataVersion);
  });

  it("re-budgets clean band-only ranges after visibility changes", () => {
    const width = 420;
    const count = 20_000;
    const x = new Float64Array(count);
    const firstLow = new Float64Array(count);
    const firstHigh = new Float64Array(count);
    const secondLow = new Float64Array(count);
    const secondHigh = new Float64Array(count);
    for (let index = 0; index < count; index++) {
      x[index] = index;
      const center = Math.sin(index / 43) * 8;
      firstLow[index] = center - 5;
      firstHigh[index] = center + 5;
      secondLow[index] = center - 12;
      secondHigh[index] = center - 7;
    }
    const band = {
      fill: 0.2,
      borderColor: "#abcdef",
      borderWidth: 1,
    };
    const { engine, messages } = createPresentationHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        legend: { visible: false },
        lod: { mode: "adaptive", density: 0.75 },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [
          { type: "range", width: 0, band },
          { type: "range", width: 0, band },
        ],
      },
      width,
    );
    engine.handleMessage("setData", {
      x,
      series: [
        { low: firstLow, high: firstHigh },
        { low: secondLow, high: secondHigh },
      ],
    });
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    messages.length = 0;
    engine.handleMessage("invalidateCache", {});
    const bothVisible = messages.find((message) => message.type === "stats");

    messages.length = 0;
    engine.handleMessage("setSeriesVisible", { index: 1, visible: false });
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});
    const oneVisible = messages.filter((message) => message.type === "stats").at(-1);

    const workFor = (stats: Record<string, unknown> | undefined) =>
      ((stats?.renderedPoints as number) * 5) / 4;
    const workLimit = getLineEngineState(engine).chartWidth * 6 + 64;
    expect(workFor(bothVisible)).toBeLessThanOrEqual(workLimit);
    expect(workFor(oneVisible)).toBeLessThanOrEqual(workLimit);
    // Once one band is hidden, the remaining band may use the freed density
    // instead of retaining the previous two-band grid indefinitely.
    expect(oneVisible?.renderedPoints as number).toBeGreaterThan(
      (bothVisible?.renderedPoints as number) * 0.75,
    );
  });

  it("keeps inclusive edge columns inside a narrow multi-band budget", () => {
    const count = 20_000;
    const x = new Float64Array(count);
    const bands = Array.from({ length: 5 }, (_, bandIndex) => {
      const low = new Float64Array(count);
      const high = new Float64Array(count);
      for (let index = 0; index < count; index++) {
        const center = Math.sin(index / 37) * 2 + bandIndex * 8;
        x[index] = index;
        low[index] = center - 3;
        high[index] = center + 3;
      }
      return { low, high };
    });
    const { engine, messages } = createPresentationHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        legend: { visible: false },
        lod: { mode: "adaptive", density: 0.75 },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: bands.map(() => ({
          type: "range",
          width: 0,
          band: {
            fill: 0.2,
            borderColor: "#abcdef",
            borderWidth: 1,
          },
        })),
      },
      180,
    );
    engine.handleMessage("setData", { x, series: bands });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});
    const stats = messages.find((message) => message.type === "stats");
    const weightedBandWork = ((stats?.renderedPoints as number) * 5) / 4;
    expect(weightedBandWork).toBeLessThanOrEqual(getLineEngineState(engine).chartWidth * 6);
  });

  it("lets chart configuration control presentation density and opt out", () => {
    const render = (mode: "adaptive" | "pyramid", density: number) => {
      const { engine, messages } = createHarness({
        animated: false,
        rangeSelector: { visible: false },
        lod: { mode, density },
        seriesOptions: [{ type: "line" }],
      });
      const { x, y } = createDenseIrregularData(20_000);
      engine.handleMessage("setData", { x, series: [y] });
      messages.length = 0;
      engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
      engine.handleMessage("invalidateCache", {});
      return messages.find((message) => message.type === "stats");
    };

    const half = render("adaptive", 0.5);
    const full = render("adaptive", 1);
    const pyramid = render("pyramid", 1);
    expect(half).toMatchObject({
      presentationMode: "columns",
      presentationGridPolicy: "gesture-stable",
      presentationDensity: 0.5,
      presentationRebaseRatio: 1.25,
      presentationQuantizationStep: 0.25,
    });
    expect(full).toMatchObject({
      presentationMode: "columns",
      presentationDensity: 1,
    });
    expect(half?.presentationColumns as number).toBeLessThan(full?.presentationColumns as number);
    expect(pyramid).toMatchObject({ presentationMode: "pyramid" });
  });

  it("updates and clamps presentation tuning without rebuilding the chart", () => {
    const { engine, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      lod: {
        mode: "adaptive",
        density: 0.5,
        rebaseRatio: 1.4,
        quantizationStep: 0.1,
      },
      seriesOptions: [{ type: "line" }],
    });
    const { x, y } = createDenseIrregularData(20_000);
    engine.handleMessage("setData", { x, series: [y] });

    engine.handleMessage("setLODConfig", {
      lod: {
        density: 3,
        rebaseRatio: 1.01,
        quantizationStep: 0.01,
      },
    });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});
    expect(messages.find((message) => message.type === "stats")).toMatchObject({
      presentationMode: "columns",
      presentationDensity: 2,
      presentationRebaseRatio: 1.05,
      presentationQuantizationStep: 0.05,
    });

    engine.handleMessage("setStatsConfig", { enabled: false });
    engine.handleMessage("setLODConfig", { lod: { mode: "pyramid" } });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});
    expect(messages.find((message) => message.type === "stats")).toMatchObject({
      presentationMode: "pyramid",
      presentationDensity: 2,
      presentationRebaseRatio: 1.05,
      presentationQuantizationStep: 0.05,
    });
  });

  it("keeps the bounded grid after viewport animation completion", () => {
    const { engine, messages } = createPresentationHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        seriesOptions: [{ type: "line" }],
      },
      420,
    );

    const { x, y } = createDenseIrregularData(20_000);
    engine.handleMessage("setData", { x, series: [y] });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", {
      enabled: true,
      intervalMs: 16,
    });
    engine.handleMessage("invalidateCache", {});
    const initial = messages.filter((message) => message.type === "stats").at(-1)
      ?.presentationGridDelta as number;
    const gestureXMin = x[1_000];
    const gestureXMax = gestureXMin + (initial / 1.24) * getLineEngineState(engine).chartWidth;

    engine.handleMessage("setStatsConfig", { enabled: false });
    engine.handleMessage("setViewportRange", {
      xMin: gestureXMin,
      xMax: gestureXMax,
    });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", {
      enabled: true,
      intervalMs: 16,
    });
    engine.handleMessage("invalidateCache", {});
    const afterViewport = messages.filter((message) => message.type === "stats").at(-1);
    expect(afterViewport).toMatchObject({
      presentationMode: "columns",
      presentationGridPolicy: "gesture-stable",
      viewport: { xMin: gestureXMin, xMax: gestureXMax },
      presentationGridDelta: initial,
    });

    // A later non-viewport redraw must not trigger a deferred settle rebin.
    engine.handleMessage("setStatsConfig", { enabled: false });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", {
      enabled: true,
      intervalMs: 16,
    });
    engine.handleMessage("invalidateCache", {});
    expect(messages.filter((message) => message.type === "stats").at(-1)).toMatchObject({
      presentationGridDelta: initial,
    });
  });

  it("does not let the full-range preview replace the main LOD memory", () => {
    const { engine, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: true },
      seriesOptions: [{ type: "line" }],
    });
    const count = 10_000;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    for (let index = 0; index < count; index++) {
      x[index] = index;
      y[index] = Math.sin(index / 31);
    }
    engine.handleMessage("setData", { x, series: [y] });
    engine.handleMessage("setViewportRange", { xMin: 0, xMax: 4_499 });

    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("setViewportRange", { xMin: 0, xMax: 6_499 });

    expect(messages.find((message) => message.type === "stats")).toMatchObject({
      bucketSize: 1,
      lodLevel: 0,
    });
  });

  it("clips the range preview to the plot rectangle", () => {
    const rangeSelectorHeight = 52;
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: true, height: rangeSelectorHeight },
      seriesOptions: [{ type: "line" }],
    });
    engine.handleMessage("setData", {
      x: new Float64Array([0, 1, 2, 3]),
      series: [new Float64Array([2, 4, 3, 5])],
    });

    const state = getLineEngineState(engine);
    const clipRect = {
      op: "rect",
      x: state.padding.left,
      y: 0,
      width: state.width - state.padding.left - state.padding.right,
      height: rangeSelectorHeight,
    };
    const previewContext = contexts.find((context) =>
      context.pathCalls.some(
        (call) =>
          call.op === clipRect.op &&
          call.x === clipRect.x &&
          call.y === clipRect.y &&
          call.width === clipRect.width &&
          call.height === clipRect.height,
      ),
    );

    expect(previewContext?.pathCalls).toEqual(
      expect.arrayContaining([{ op: "save" }, clipRect, { op: "clip" }, { op: "restore" }]),
    );
  });
});

describe("lineRenderer staged LOD", () => {
  it("keeps the streaming range preview on stable adaptive columns", () => {
    vi.useFakeTimers();
    let queuedFrame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const color = "#2468ac";
    const contexts: RecordingContext[] = [];
    const mainCanvas = createStubCanvas(900);
    const mainContext = mainCanvas.getContext("2d");
    if (!mainContext) throw new Error("Failed to create main context");
    contexts.push(mainContext);
    const engine = createLineChartEngine(
      { postMessage: () => {} },
      {
        ssr: false,
        createCanvas: (width, height) => {
          const canvas = createStubCanvas(width, height);
          const context = canvas.getContext("2d");
          if (context) contexts.push(context);
          return canvas;
        },
      },
    );

    const longestPreviewSegment = (): number => {
      const previewContext = contexts[2];
      expect(previewContext).toBeDefined();
      return Math.max(
        0,
        ...getStrokeSegments([previewContext], color).map((segment) => segment.length),
      );
    };

    try {
      engine.handleMessage("init", {
        canvas: mainCanvas,
        dpr: 1,
        config: {
          animated: false,
          lod: { mode: "adaptive", density: 1.1 },
          rangeSelector: { visible: true },
          grid: { vertical: false, horizontal: false },
          axis: {
            bottom: { visible: false },
            top: { visible: false },
            left: { visible: false },
            right: { visible: false },
          },
          seriesOptions: [{ type: "line", color, width: 1 }],
        },
      });
      engine.handleMessage("initRingBuffer", {
        maxPoints: 100_000,
        seriesCount: 1,
      });

      const count = 50_000;
      const timestamps = new Float64Array(count);
      const values = new Float64Array(count);
      for (let index = 0; index < count; index++) {
        timestamps[index] = index;
        values[index] = 50 + Math.sin(index / 17) * 10 + Math.sin(index / 97) * 4;
      }
      engine.handleMessage("addDataPoints", {
        timestamps,
        valuesBySeries: [values],
      });
      const firstFrame = queuedFrame as FrameRequestCallback | null;
      expect(firstFrame).not.toBeNull();
      queuedFrame = null;
      firstFrame!(performance.now() + 20);

      const stagedPointCount = longestPreviewSegment();
      expect(stagedPointCount).toBeGreaterThan(500);
      contexts[2].pathCalls.length = 0;

      vi.runAllTimers();
      engine.handleMessage("addDataPoints", {
        timestamps: new Float64Array([count]),
        valuesBySeries: [new Float64Array([values[count - 1]])],
      });
      const pendingFrame = queuedFrame as FrameRequestCallback | null;
      expect(pendingFrame).not.toBeNull();
      queuedFrame = null;
      pendingFrame!(performance.now() + 40);

      const rebuiltPointCount = longestPreviewSegment();
      expect(rebuiltPointCount).toBeGreaterThan(500);
      expect(rebuiltPointCount / stagedPointCount).toBeGreaterThan(0.8);
      expect(rebuiltPointCount / stagedPointCount).toBeLessThan(1.25);
    } finally {
      engine.handleMessage("stop", {});
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("keeps adaptive streaming presentation dense while hierarchy rebuilds", () => {
    vi.useFakeTimers();
    let queuedFrame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const messages: Array<Record<string, unknown>> = [];
    const mainCanvas = createStubCanvas(900);
    const engine = createLineChartEngine(
      {
        postMessage: (message) => messages.push(message),
      },
      {
        ssr: false,
        createCanvas: (width, height) => createStubCanvas(width, height),
      },
    );

    try {
      engine.handleMessage("init", {
        canvas: mainCanvas,
        dpr: 1,
        config: {
          animated: false,
          rangeSelector: { visible: false },
          lod: { mode: "adaptive", density: 1.1 },
          seriesOptions: Array.from({ length: 4 }, () => ({ type: "line" })),
        },
      });
      engine.handleMessage("setStatsConfig", {
        enabled: true,
        intervalMs: 16,
      });
      engine.handleMessage("initRingBuffer", {
        maxPoints: 100_000,
        seriesCount: 4,
      });

      const count = 50_000;
      const timestamps = new Float64Array(count);
      const series = Array.from({ length: 4 }, () => new Float64Array(count));
      for (let index = 0; index < count; index++) {
        timestamps[index] = index;
        for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
          series[seriesIndex][index] = 50 + Math.sin(index / (17 + seriesIndex * 7)) * 10;
        }
      }

      messages.length = 0;
      engine.handleMessage("addDataPoints", {
        timestamps,
        valuesBySeries: series,
      });
      const firstFrame = queuedFrame as FrameRequestCallback | null;
      expect(firstFrame).not.toBeNull();
      queuedFrame = null;
      firstFrame!(performance.now() + 20);

      const firstStats = messages.find((message) => message.type === "stats");
      expect(firstStats).toMatchObject({
        presentationMode: "columns",
        presentationLargestBucket: 1,
        lodReady: false,
      });
      expect(firstStats?.renderedPoints as number).toBeLessThan(count);

      // Finish the hierarchy, append into its growing tail, then render before
      // the debounced replacement hierarchy starts. Existing complete prefix
      // buckets may still help, but no bucket wider than a screen column may
      // replace the new samples.
      vi.runAllTimers();
      messages.length = 0;
      engine.handleMessage("setStatsConfig", {
        enabled: true,
        intervalMs: 16,
      });
      engine.handleMessage("addDataPoints", {
        timestamps: new Float64Array([count]),
        valuesBySeries: series.map((values) => new Float64Array([values[count - 1]])),
      });
      const pendingFrame = queuedFrame as FrameRequestCallback | null;
      expect(pendingFrame).not.toBeNull();
      queuedFrame = null;
      pendingFrame!(performance.now() + 40);

      const pendingStats = messages.find((message) => message.type === "stats");
      expect(pendingStats).toMatchObject({
        presentationMode: "columns",
        lodReady: true,
      });
      expect(pendingStats?.presentationLargestBucket as number).toBeGreaterThanOrEqual(8);
      expect(pendingStats?.presentationLargestBucket as number).toBeLessThanOrEqual(128);
      expect(pendingStats?.renderedPoints as number).toBeLessThan(count);
    } finally {
      engine.handleMessage("stop", {});
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("starts adaptive reduction only after visible X exceeds its column width", () => {
    const { engine, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      lod: { mode: "adaptive", density: 1.1 },
      seriesOptions: [{ type: "line" }],
    });
    engine.handleMessage("setStatsConfig", {
      enabled: true,
      intervalMs: 16,
    });
    const targetColumns = Math.floor(getLineEngineState(engine).chartWidth * 1.1);
    engine.handleMessage("initRingBuffer", {
      maxPoints: targetColumns + 10,
      seriesCount: 1,
    });

    const timestamps = new Float64Array(targetColumns);
    const values = new Float64Array(targetColumns);
    for (let index = 0; index < targetColumns; index++) {
      timestamps[index] = index;
      values[index] = Math.sin(index / 11);
    }

    messages.length = 0;
    engine.handleMessage("addDataPoints", {
      timestamps,
      valuesBySeries: [values],
    });
    expect(messages.filter((message) => message.type === "stats").at(-1)).toMatchObject({
      presentationMode: "pyramid",
      bucketSize: 1,
      renderedPoints: targetColumns,
    });

    engine.handleMessage("setStatsConfig", { enabled: false });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", {
      enabled: true,
      intervalMs: 16,
    });
    engine.handleMessage("addDataPoints", {
      timestamps: new Float64Array([targetColumns]),
      valuesBySeries: [new Float64Array([0])],
    });
    const reduced = messages.filter((message) => message.type === "stats").at(-1);
    expect(reduced).toMatchObject({
      presentationMode: "columns",
      presentationLargestBucket: 1,
    });
    expect(reduced?.presentationColumns as number).toBeGreaterThan(0);
  });

  it("ignores stale hierarchy bounds after a streaming ring wraps", () => {
    vi.useFakeTimers();
    let queuedFrame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const engine = createLineChartEngine(
      { postMessage: () => {} },
      {
        ssr: false,
        createCanvas: (width, height) => createStubCanvas(width, height),
      },
    );

    try {
      engine.handleMessage("init", {
        canvas: createStubCanvas(900),
        dpr: 1,
        config: {
          animated: false,
          rangeSelector: { visible: false },
          lod: { mode: "adaptive", density: 1.1 },
          seriesOptions: [{ type: "line" }],
        },
      });
      const maxPoints = 4_096;
      engine.handleMessage("initRingBuffer", {
        maxPoints,
        seriesCount: 1,
      });
      const timestamps = new Float64Array(maxPoints);
      const values = new Float64Array(maxPoints);
      values.fill(10);
      for (let index = 0; index < maxPoints; index++) {
        timestamps[index] = index;
      }
      engine.handleMessage("addDataPoints", {
        timestamps,
        valuesBySeries: [values],
      });
      vi.runAllTimers();
      const stableFrame = queuedFrame as FrameRequestCallback | null;
      expect(stableFrame).not.toBeNull();
      queuedFrame = null;
      stableFrame!(performance.now() + 20);

      engine.handleMessage("addDataPoints", {
        timestamps: new Float64Array([maxPoints]),
        valuesBySeries: [new Float64Array([1_000])],
      });
      const pendingFrame = queuedFrame as FrameRequestCallback | null;
      expect(pendingFrame).not.toBeNull();
      queuedFrame = null;
      pendingFrame!(performance.now() + 40);

      expect(getLineEngineState(engine).viewport.yMax).toBeGreaterThan(900);
    } finally {
      engine.handleMessage("stop", {});
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("uses the coarsest staged LOD before finer levels finish building", () => {
    let queuedFrame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const messages: Array<Record<string, unknown>> = [];
    const mainCanvas = createStubCanvas(900);
    const engine = createLineChartEngine(
      {
        postMessage: (message) => messages.push(message),
      },
      {
        ssr: false,
        createCanvas: (width, height) => createStubCanvas(width, height),
      },
    );

    try {
      engine.handleMessage("init", {
        canvas: mainCanvas,
        dpr: 1,
        config: {
          animated: false,
          rangeSelector: { visible: false },
          seriesOptions: Array.from({ length: 4 }, () => ({ type: "step" })),
        },
      });
      engine.handleMessage("setStatsConfig", {
        enabled: true,
        intervalMs: 16,
      });

      const count = 100_000;
      const x = new Float64Array(count);
      const series = Array.from({ length: 4 }, () => new Float64Array(count));
      for (let index = 0; index < count; index++) {
        x[index] = index;
        for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
          series[seriesIndex][index] = index + seriesIndex;
        }
      }

      messages.length = 0;
      engine.handleMessage("setData", { x, series });
      const firstFrame = queuedFrame as FrameRequestCallback | null;
      expect(firstFrame).not.toBeNull();
      queuedFrame = null;
      firstFrame!(performance.now() + 20);

      const stats = messages.find((message) => message.type === "stats");
      expect(stats).toMatchObject({
        bucketSize: 8192,
        lodReady: false,
      });
      expect(stats?.renderedPoints as number).toBeLessThan(count / 10);
    } finally {
      engine.handleMessage("stop", {});
      vi.unstubAllGlobals();
    }
  });

  it("keeps a small streaming viewport raw while its LOD rebuild is pending", () => {
    vi.useFakeTimers();
    let queuedFrame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const messages: Array<Record<string, unknown>> = [];
    const mainCanvas = createStubCanvas(900);
    const engine = createLineChartEngine(
      {
        postMessage: (message) => messages.push(message),
      },
      {
        ssr: false,
        createCanvas: (width, height) => createStubCanvas(width, height),
      },
    );

    try {
      engine.handleMessage("init", {
        canvas: mainCanvas,
        dpr: 1,
        config: {
          animated: false,
          rangeSelector: { visible: false },
          seriesOptions: [{ type: "step" }],
        },
      });
      engine.handleMessage("setStatsConfig", {
        enabled: true,
        intervalMs: 16,
      });
      engine.handleMessage("initRingBuffer", {
        maxPoints: 100_000,
        seriesCount: 1,
      });

      const count = 50_000;
      const timestamps = new Float64Array(count);
      const values = new Float64Array(count);
      for (let index = 0; index < count; index++) {
        timestamps[index] = index;
        values[index] = index % 100;
      }

      engine.handleMessage("addDataPoints", {
        timestamps,
        valuesBySeries: [values],
      });
      vi.runAllTimers();

      engine.handleMessage("setViewportRange", {
        xMin: 20_000,
        xMax: 20_999,
      });
      const stableFrame = queuedFrame as FrameRequestCallback | null;
      expect(stableFrame).not.toBeNull();
      queuedFrame = null;
      stableFrame!(performance.now() + 20);
      expect(messages.find((message) => message.type === "stats")).toMatchObject({
        lodReady: true,
        bucketSize: 1,
        visiblePoints: 1002,
        renderedPoints: 1002,
      });

      messages.length = 0;
      engine.handleMessage("addDataPoints", {
        timestamps: new Float64Array([count]),
        valuesBySeries: [new Float64Array([0])],
      });

      const pendingFrame = queuedFrame as FrameRequestCallback | null;
      expect(pendingFrame).not.toBeNull();
      queuedFrame = null;
      pendingFrame!(performance.now() + 40);

      expect(messages.find((message) => message.type === "stats")).toMatchObject({
        lodReady: true,
        bucketSize: 1,
        visiblePoints: 1002,
        renderedPoints: 1002,
      });
    } finally {
      engine.handleMessage("stop", {});
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("lineRenderer LOD extrema", () => {
  it("keeps an isolated negative anomaly in a coarse step-series bucket", () => {
    const color = "#123456";
    const { engine, contexts, messages } = createHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [
          { color, type: "step" },
          { color: "#abcdef", type: "step" },
          { color: "#fedcba", type: "step" },
          { color: "#654321", type: "step" },
        ],
      },
      200,
    );
    const count = 100_000;
    const anomalyIndex = 50_003;
    const x = new Float64Array(count);
    const series = Array.from({ length: 4 }, () => new Float64Array(count));
    for (let index = 0; index < count; index++) {
      x[index] = index;
      for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
        series[seriesIndex][index] = 50 + seriesIndex * 10 + Math.sin(index / 100) * 5;
      }
    }
    series[0][anomalyIndex] = -10;

    engine.handleMessage("setData", { x, series });
    for (const context of contexts) context.pathCalls.length = 0;
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    const stats = messages.find((message) => message.type === "stats");
    expect(stats).toMatchObject({ bucketSize: 2048 });
    expect(stats?.renderedPoints as number).toBeLessThan(count / 100);

    const state = getLineEngineState(engine);
    const expectedX =
      state.padding.left +
      ((anomalyIndex - state.viewport.xMin) / (state.viewport.xMax - state.viewport.xMin)) *
        state.chartWidth;
    const expectedY =
      state.chartTop +
      ((state.viewport.yMax - series[0][anomalyIndex]) /
        (state.viewport.yMax - state.viewport.yMin)) *
        state.chartHeight;
    const anomalyWasRendered = getStrokeSegments(contexts, color)
      .flat()
      .some(
        (call) =>
          Math.abs((call.x ?? Infinity) - expectedX) < 0.01 &&
          Math.abs((call.y ?? Infinity) - expectedY) < 0.01,
      );
    expect(anomalyWasRendered).toBe(true);
  });
});

describe("lineRenderer LOD gaps", () => {
  it("summarizes a NaN-containing line bucket while preserving both segments", () => {
    const { engine, contexts, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [{ color: "#123456" }],
    });
    const count = 100_000;
    const gapIndex = 50_003;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      x[i] = i;
      y[i] = i;
    }
    y[gapIndex] = NaN;

    engine.handleMessage("setData", { x, series: [y] });

    expectFirstGapSegmentEndsBefore(engine, contexts, "#123456", gapIndex - 1);
    expectGapSegmentRestartsAt(engine, contexts, "#123456", gapIndex + 1);

    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    const stats = messages.find((message) => message.type === "stats");
    expect(stats).toMatchObject({ bucketSize: 128 });
    expect(stats?.renderedPoints).toEqual(expect.any(Number));
    expect(stats?.renderedPoints as number).toBeLessThan(count / 10);
  });

  it("keeps recurring gaps compact at coarse LOD levels", () => {
    const { engine, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [{ color: "#123456" }],
    });
    const count = 100_000;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      x[i] = i;
      y[i] = i % 100 >= 30 && i % 100 < 70 ? NaN : i;
    }

    engine.handleMessage("setData", { x, series: [y] });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    const stats = messages.find((message) => message.type === "stats");
    expect(stats).toMatchObject({ bucketSize: 128 });
    expect(stats?.renderedPoints).toEqual(expect.any(Number));
    expect(stats?.renderedPoints as number).toBeLessThan(count / 10);
  });

  it("keeps the six-series demo gap cadence compact at LOD8192", () => {
    const { engine, messages } = createHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: Array.from({ length: 6 }, (_, index) => ({
          color: `series-${index}`,
        })),
      },
      120,
    );
    const count = 100_000;
    const x = new Float64Array(count);
    const series = Array.from({ length: 6 }, () => new Float64Array(count));
    for (let i = 0; i < count; i++) {
      x[i] = i;
      for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
        const hasDemoGap = (seriesIndex === 0 || seriesIndex === 5) && i % 5_000 < 2_000;
        series[seriesIndex][i] = hasDemoGap ? NaN : i + seriesIndex;
      }
    }

    engine.handleMessage("setData", { x, series });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    const stats = messages.find((message) => message.type === "stats");
    expect(stats).toMatchObject({ bucketSize: 8192 });
    expect(stats?.renderedPoints).toEqual(expect.any(Number));
    expect(stats?.renderedPoints as number).toBeLessThan(2_000);
  });

  it("keeps representative multi-point runs visible in fragmented buckets", () => {
    const { engine, contexts, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [{ color: "#123456" }],
    });
    const count = 100_000;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      x[i] = i;
      y[i] = i % 3 === 2 ? NaN : i;
    }

    engine.handleMessage("setData", { x, series: [y] });

    expect(
      getStrokeSegments(contexts, "#123456").some((segment) =>
        segment.some((call) => call.op === "lineTo"),
      ),
    ).toBe(true);

    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});
    const stats = messages.find((message) => message.type === "stats");
    expect(stats).toMatchObject({ bucketSize: 128 });
    expect(stats?.renderedPoints as number).toBeLessThan(count / 10);
  });

  it("selects the longest run outside a shared-extrema run", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [{ color: "#123456" }],
    });
    const count = 100_000;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    y.fill(NaN);
    for (let i = 0; i < count; i++) {
      x[i] = i;
      const bucketOffset = i % 128;
      if (bucketOffset < 40) {
        y[i] = bucketOffset === 0 ? -100 : bucketOffset === 1 ? 100 : 0;
      } else if (bucketOffset >= 41 && bucketOffset < 71) y[i] = 10;
      else if (bucketOffset >= 72 && bucketOffset < 92) y[i] = 20;
      else if (bucketOffset >= 93 && bucketOffset < 103) y[i] = 30;
    }

    engine.handleMessage("setData", { x, series: [y] });

    expectGapSegmentRestartsAt(engine, contexts, "#123456", 41);
  });

  it("omits fast-path singleton runs from connected line summaries", () => {
    const { engine, contexts, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [{ color: "#123456" }],
    });
    const count = 100_000;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    y.fill(NaN);
    for (let i = 0; i < count; i++) {
      x[i] = i;
      const bucketOffset = i % 128;
      if (bucketOffset < 2 || (bucketOffset >= 7 && bucketOffset < 9)) {
        y[i] = i;
      } else if (bucketOffset === 4) {
        y[i] = i;
      }
    }

    engine.handleMessage("setData", { x, series: [y] });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    expect(messages.find((message) => message.type === "stats")).toMatchObject({
      bucketSize: 128,
    });
    expectFirstGapSegmentEndsBefore(engine, contexts, "#123456", 1);
    expectGapSegmentRestartsAt(engine, contexts, "#123456", 7);

    const state = getLineEngineState(engine);
    const singletonScreenX =
      state.padding.left +
      ((4 - state.viewport.xMin) / (state.viewport.xMax - state.viewport.xMin)) * state.chartWidth;
    expect(
      getStrokeSegments(contexts, "#123456").some(
        (segment) =>
          segment.length === 1 && Math.abs((segment[0].x ?? Infinity) - singletonScreenX) < 0.01,
      ),
    ).toBe(false);
  });

  it("preserves fast-path singleton runs for discrete series", () => {
    const { engine, contexts, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          type: "scatter",
          point: { color: "#123456", shape: "square", size: 3 },
        },
      ],
    });
    const count = 100_000;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    y.fill(NaN);
    for (let i = 0; i < count; i++) {
      x[i] = i;
      const bucketOffset = i % 128;
      if (bucketOffset < 2 || (bucketOffset >= 7 && bucketOffset < 9)) {
        y[i] = i;
      } else if (bucketOffset === 4) {
        y[i] = i;
      }
    }

    engine.handleMessage("setData", { x, series: [y] });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    expect(messages.find((message) => message.type === "stats")).toMatchObject({
      bucketSize: 128,
    });
    const state = getLineEngineState(engine);
    const singletonScreenX =
      state.padding.left +
      ((4 - state.viewport.xMin) / (state.viewport.xMax - state.viewport.xMin)) * state.chartWidth;
    expect(
      contexts
        .flatMap((context) => context.pathCalls)
        .some(
          (call) =>
            call.op === "rect" &&
            call.width === 6 &&
            Math.abs((call.x ?? Infinity) + 3 - singletonScreenX) < 0.01,
        ),
    ).toBe(true);
  });

  it("collapses fragmented singleton runs instead of retaining raw-sized LOD data", () => {
    const { engine, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [{ color: "#123456" }],
    });
    const count = 100_000;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      x[i] = i;
      y[i] = i % 2 === 0 ? i : NaN;
    }

    engine.handleMessage("setData", { x, series: [y] });
    messages.length = 0;
    engine.handleMessage("setStatsConfig", { enabled: true, intervalMs: 16 });
    engine.handleMessage("invalidateCache", {});

    const stats = messages.find((message) => message.type === "stats");
    expect(stats).toMatchObject({ bucketSize: 128 });
    expect(stats?.renderedPoints).toEqual(expect.any(Number));
    expect(stats?.renderedPoints as number).toBeLessThan(count / 20);
  });

  it("summarizes range buckets with internal NaN gaps", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          type: "range",
          band: {
            fill: false,
            upperBorderColor: "#abcdef",
            lowerBorderColor: "#fedcba",
            borderWidth: 2,
          },
        },
      ],
    });
    const count = 10_000;
    const x = new Float64Array(count);
    const low = new Float64Array(count);
    const high = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      x[i] = i;
      low[i] = i;
      high[i] = i + 10;
    }
    low[3] = NaN;
    high[3] = NaN;

    engine.handleMessage("setData", {
      x,
      series: [{ low, high }],
    });

    expectFirstGapSegmentEndsBefore(engine, contexts, "#abcdef", 2);
    expectFirstGapSegmentEndsBefore(engine, contexts, "#fedcba", 2);
    expectGapSegmentRestartsAt(engine, contexts, "#abcdef", 4);
    expectGapSegmentRestartsAt(engine, contexts, "#fedcba", 4);
  });

  it("keeps representative fragmented range runs visible", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          type: "range",
          band: {
            fill: false,
            upperBorderColor: "#abcdef",
            lowerBorderColor: "#fedcba",
            borderWidth: 2,
          },
        },
      ],
    });
    // Hold this semantic probe at LOD128: the density floor picks LOD32 and
    // the range work limit then refines to LOD128 as the nearest affordable
    // level. Separate range-work tests cover deliberate coarsening beyond it.
    const count = getLineEngineState(engine).chartWidth * 32;
    const x = new Float64Array(count);
    const low = new Float64Array(count);
    const high = new Float64Array(count);
    low.fill(NaN);
    high.fill(NaN);
    for (let i = 0; i < count; i++) {
      x[i] = i;
      const bucketOffset = i % 128;
      if (bucketOffset < 40) {
        low[i] = bucketOffset === 0 ? -100 : 0;
        high[i] = bucketOffset === 1 ? 100 : 1;
      } else if (bucketOffset >= 41 && bucketOffset < 71) {
        low[i] = 10;
        high[i] = 11;
      } else if (bucketOffset >= 72 && bucketOffset < 92) {
        low[i] = 20;
        high[i] = 21;
      } else if (bucketOffset >= 93 && bucketOffset < 103) {
        low[i] = 30;
        high[i] = 31;
      }
    }

    engine.handleMessage("setData", {
      x,
      series: [{ low, high }],
    });

    for (const color of ["#abcdef", "#fedcba"]) {
      expect(
        getStrokeSegments(contexts, color).some((segment) =>
          segment.some((call) => call.op === "lineTo"),
        ),
      ).toBe(true);
      expectGapSegmentRestartsAt(engine, contexts, color, 41);
    }
  });
});

describe("lineRenderer range series", () => {
  function createRangeRasterHarness({
    dpr,
    ssr,
    animated = false,
    includeLine = false,
  }: {
    dpr: number;
    ssr: boolean;
    animated?: boolean;
    includeLine?: boolean;
  }) {
    let queuedFrame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const contexts: RecordingContext[] = [];
    const canvases: StubCanvas[] = [];
    const mainCanvas = createStubCanvas(900 * dpr, 480 * dpr);
    canvases.push(mainCanvas);
    const mainContext = mainCanvas.getContext("2d");
    if (!mainContext) throw new Error("Failed to create main context");
    contexts.push(mainContext);

    const engine = createLineChartEngine(
      { postMessage: () => {} },
      {
        ssr,
        createCanvas: (width, height) => {
          const canvas = createStubCanvas(width, height);
          canvases.push(canvas);
          const context = canvas.getContext("2d");
          if (context) contexts.push(context);
          return canvas;
        },
      },
    );
    const fillColor = "rgba(18, 52, 86, 0.25)";
    const crosshairColor = "#ff00ff";
    const lineColor = "#11cc88";
    const seriesOptions: Record<string, unknown>[] = [
      {
        type: "range",
        width: 0,
        band: {
          fill: 0.2,
          fillColor,
          borderColor: "#abcdef",
          borderWidth: 1,
          borderStyle: "dashed",
        },
      },
    ];
    if (includeLine) {
      seriesOptions.push({
        type: "line",
        width: 1.5,
        color: lineColor,
      });
    }
    engine.handleMessage("init", {
      canvas: mainCanvas,
      dpr,
      config: {
        animated,
        rangeSelector: { visible: false },
        legend: { visible: false },
        grid: { vertical: false, horizontal: false },
        crosshairStyle: {
          vertical: { color: crosshairColor },
          horizontal: { color: crosshairColor },
        },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions,
      },
    });

    const runQueuedFrame = (timestamp = performance.now()): void => {
      const frame = queuedFrame as FrameRequestCallback | null;
      expect(frame).not.toBeNull();
      queuedFrame = null;
      frame!(timestamp);
    };

    return {
      engine,
      canvases,
      contexts,
      crosshairColor,
      fillColor,
      includeLine,
      lineColor,
      hasQueuedFrame: () => queuedFrame !== null,
      runQueuedFrame,
    };
  }

  function installRangeRasterData(
    harness: ReturnType<typeof createRangeRasterHarness>,
    gapped = false,
  ): void {
    const count = harness.includeLine ? 20_000 : 200;
    const { x, low, high } = createSimpleRangeData(count);
    if (gapped) {
      const gapIndex = Math.floor(count / 2);
      low[gapIndex] = NaN;
      high[gapIndex] = NaN;
    }
    const series: Array<Float64Array | { low: Float64Array; high: Float64Array }> = [{ low, high }];
    if (harness.includeLine) {
      const line = new Float64Array(count);
      for (let index = 0; index < count; index++) {
        line[index] = Math.sin(index / 37) * 4 + index / count;
      }
      series.push(line);
    }
    harness.engine.handleMessage("setData", {
      x,
      series,
    });
  }

  function stabilizeRangeRasterHarness(
    harness: ReturnType<typeof createRangeRasterHarness>,
    ssr: boolean,
    gapped = false,
  ): void {
    installRangeRasterData(harness, gapped);
    if (ssr) return;

    // Let the initial-load render window and staged LOD work finish so the
    // following frame is caused only by the viewport interaction under test.
    vi.advanceTimersByTime(2_100);
    expect(harness.hasQueuedFrame()).toBe(true);
    let timestamp = performance.now() + 20;
    for (let frame = 0; frame < 20 && harness.hasQueuedFrame(); frame++) {
      harness.runQueuedFrame(timestamp);
      timestamp += 100;
    }
    expect(harness.hasQueuedFrame()).toBe(false);
  }

  function mouseXForDataValue(
    engine: ReturnType<typeof createLineChartEngine>,
    dataX: number,
  ): number {
    const state = getLineEngineState(engine);
    const xRange = state.viewport.xMax - state.viewport.xMin;
    return state.padding.left + ((dataX - state.viewport.xMin) / xRange) * state.chartWidth;
  }

  it("draws a low/high range band below the center line", () => {
    const fillColor = "rgba(18, 52, 86, 0.25)";
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          name: "Envelope",
          type: "range",
          color: "#123456",
          band: {
            fillColor,
            borderColor: "#abcdef",
            borderWidth: 3,
            borderStyle: "dashed",
          },
          width: 2,
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20]),
      series: [
        {
          low: new Float64Array([0, 2, 1]),
          high: new Float64Array([10, 14, 12]),
          y: new Float64Array([5, 8, 6]),
        },
      ],
    });

    const calls = contexts.flatMap((ctx) => ctx.pathCalls);
    expect(calls.some((call) => call.op === "fill" && call.fillStyle === fillColor)).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.op === "stroke" &&
          call.strokeStyle === "#abcdef" &&
          call.lineWidth === 3 &&
          JSON.stringify(call.lineDash) === JSON.stringify([5, 3]),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.op === "stroke" && call.strokeStyle === "#123456")).toBe(true);
  });

  it("keeps a zero-width range center hidden in the plot and preview", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: true },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          name: "Envelope",
          type: "range",
          color: "#123456",
          width: 0,
          band: { fillColor: "rgba(18, 52, 86, 0.25)" },
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20]),
      series: [
        {
          low: new Float64Array([0, 2, 1]),
          high: new Float64Array([10, 14, 12]),
        },
      ],
    });

    expect(
      contexts
        .flatMap((context) => context.pathCalls)
        .some((call) => call.op === "stroke" && call.strokeStyle === "#123456"),
    ).toBe(false);
  });

  it("supports separate upper and lower range band border colors", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          name: "Envelope",
          type: "range",
          color: "#123456",
          band: {
            fill: false,
            upperBorderColor: "#ff0000",
            lowerBorderColor: "#00ff00",
            borderWidth: 2,
            borderStyle: "dotted",
          },
          width: 2,
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20]),
      series: [
        {
          low: new Float64Array([0, 2, 1]),
          high: new Float64Array([10, 14, 12]),
          y: new Float64Array([5, 8, 6]),
        },
      ],
    });

    const strokes = contexts.flatMap((ctx) => ctx.pathCalls).filter((call) => call.op === "stroke");

    expect(
      strokes.some(
        (call) =>
          call.strokeStyle === "#ff0000" &&
          call.lineWidth === 2 &&
          JSON.stringify(call.lineDash) === JSON.stringify([2, 2]),
      ),
    ).toBe(true);
    expect(
      strokes.some(
        (call) =>
          call.strokeStyle === "#00ff00" &&
          call.lineWidth === 2 &&
          JSON.stringify(call.lineDash) === JSON.stringify([2, 2]),
      ),
    ).toBe(true);
  });

  it("does not apply legacy line glow fill effects to range series", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          name: "Envelope",
          type: "range",
          color: "#123456",
          fill: true,
          fillEffect: "glow",
          width: 2,
          band: {
            fillColor: "rgba(18, 52, 86, 0.25)",
          },
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20]),
      series: [
        {
          low: new Float64Array([0, 2, 1]),
          high: new Float64Array([10, 14, 12]),
          y: new Float64Array([5, 8, 6]),
        },
      ],
    });

    const strokes = contexts.flatMap((ctx) => ctx.pathCalls).filter((call) => call.op === "stroke");

    expect(strokes.some((call) => (call.lineWidth ?? 0) > 2)).toBe(false);
    expect(strokes.some((call) => call.strokeStyle === "#123456" && call.lineWidth === 2)).toBe(
      true,
    );
  });

  it("includes range low/high values in data bounds", () => {
    const { engine } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      seriesOptions: [{ name: "Envelope", type: "range" }],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 1, 2]),
      series: [
        {
          low: new Float64Array([-15, -5, 0]),
          high: new Float64Array([10, 80, 20]),
          y: new Float64Array([2, 3, 4]),
        },
      ],
    });

    const bounds = getLineEngineState(engine).dataBounds;
    expect(bounds.yMin).toBeLessThanOrEqual(-15);
    expect(bounds.yMax).toBeGreaterThanOrEqual(80);
  });

  it("emits center value and formatted range values for tooltip callbacks", () => {
    const { engine, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      tooltip: { hasCallback: true },
      seriesOptions: [
        {
          name: "Envelope",
          type: "range",
          unit: { prefix: "$", decimals: 1 },
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10]),
      series: [
        {
          low: new Float64Array([0, 10]),
          high: new Float64Array([100, 110]),
          y: new Float64Array([50, 60]),
        },
      ],
    });
    messages.length = 0;

    engine.handleMessage("mousemove", {
      x: mouseXForDataValue(engine, 5),
      y: getLineEngineState(engine).chartTop + 20,
    });

    const tooltip = messages.find((m) => m.type === "tooltipData") as
      | {
          params?: {
            series?: Array<{
              value: number;
              low: number;
              high: number;
              formattedValue: string;
              formattedLow: string;
              formattedHigh: string;
              interpolated: boolean;
            }>;
          };
        }
      | undefined;
    const point = tooltip?.params?.series?.[0];

    expect(point?.value).toBeCloseTo(55);
    expect(point?.low).toBeCloseTo(5);
    expect(point?.high).toBeCloseTo(105);
    expect(point?.formattedValue).toBe("$5.0 - $105.0");
    expect(point?.formattedLow).toBe("$5.0");
    expect(point?.formattedHigh).toBe("$105.0");
    expect(point?.interpolated).toBe(true);
  });

  it("uses spline geometry for both range boundaries and tooltip values", () => {
    const upperColor = "#ff0000";
    const lowerColor = "#00ff00";
    const { engine, contexts, messages } = createHarness({
      animated: false,
      interpolation: "spline",
      rangeSelector: { visible: false },
      tooltip: { hasCallback: true },
      seriesOptions: [
        {
          name: "Envelope",
          type: "range",
          width: 0,
          band: {
            fill: false,
            upperBorderColor: upperColor,
            lowerBorderColor: lowerColor,
            borderWidth: 1,
          },
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20, 30]),
      series: [
        {
          low: new Float64Array([0, 10, 0, 20]),
          high: new Float64Array([20, 30, 20, 40]),
        },
      ],
    });

    const calls = contexts.flatMap((context) => context.pathCalls);
    expect(
      calls.filter((call) => call.op === "bezierCurveTo" && call.strokeStyle === upperColor),
    ).toHaveLength(3);
    expect(
      calls.filter((call) => call.op === "bezierCurveTo" && call.strokeStyle === lowerColor),
    ).toHaveLength(3);

    messages.length = 0;
    engine.handleMessage("mousemove", {
      x: mouseXForDataValue(engine, 15),
      y: getLineEngineState(engine).chartTop + 20,
    });
    const tooltip = messages.find((message) => message.type === "tooltipData") as
      | {
          params?: {
            series?: Array<{ low: number; high: number }>;
          };
        }
      | undefined;
    expect(tooltip?.params?.series?.[0]?.low).toBeCloseTo(4.375);
    expect(tooltip?.params?.series?.[0]?.high).toBeCloseTo(24.375);
  });

  it("keeps the configured DPR and backing store during wheel interaction", () => {
    vi.useFakeTimers();
    const harness = createRangeRasterHarness({ dpr: 2, ssr: false });

    try {
      stabilizeRangeRasterHarness(harness, false);
      expect(harness.contexts).toHaveLength(2);
      for (const context of harness.contexts) context.pathCalls.length = 0;

      const state = getLineEngineState(harness.engine);
      harness.engine.handleMessage("mousemove", {
        x: state.padding.left + state.chartWidth / 2,
        y: state.chartTop + state.chartHeight / 2,
      });
      harness.engine.handleMessage("viewportInputBatch", {
        commands: [
          {
            type: "zoom",
            factor: 0.8,
            centerX: (state.viewport.xMin + state.viewport.xMax) / 2,
          },
        ],
      });
      expect(vi.getTimerCount()).toBe(0);
      harness.runQueuedFrame(performance.now() + 20);

      expect(state.dpr).toBe(2);
      expect(harness.canvases[0]).toMatchObject({
        width: 1_800,
        height: 960,
      });
      expect(harness.contexts).toHaveLength(2);
      const cacheContext = harness.contexts[1];
      expect(
        cacheContext.pathCalls.some(
          (call) => call.op === "fill" && call.fillStyle === harness.fillColor,
        ),
      ).toBe(true);
      vi.advanceTimersByTime(180);
      expect(state.dpr).toBe(2);
      expect(harness.canvases[0]).toMatchObject({
        width: 1_800,
        height: 960,
      });
      expect(harness.contexts).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.engine.handleMessage("stop", {});
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("keeps the configured DPR during range-selector navigation", () => {
    vi.useFakeTimers();
    const harness = createRangeRasterHarness({ dpr: 2, ssr: false });

    try {
      stabilizeRangeRasterHarness(harness, false);
      const state = getLineEngineState(harness.engine);

      harness.engine.handleMessage("setViewportRange", {
        xMin: state.viewport.xMin + 1,
        xMax: state.viewport.xMax - 1,
        interactionSource: "rangeSelector",
      });

      expect(vi.getTimerCount()).toBe(0);
      expect(state.dpr).toBe(2);
      expect(harness.canvases[0]).toMatchObject({
        width: 1_800,
        height: 960,
      });
      harness.runQueuedFrame(performance.now() + 20);
      expect(state.dpr).toBe(2);
    } finally {
      harness.engine.handleMessage("stop", {});
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("keeps the configured DPR after a range width changes at runtime", () => {
    vi.useFakeTimers();
    const harness = createRangeRasterHarness({ dpr: 2, ssr: false });

    try {
      harness.engine.handleMessage("updateSeriesAppearance", {
        index: 0,
        patch: { width: 1.95 },
      });
      stabilizeRangeRasterHarness(harness, false);
      expect(harness.contexts).toHaveLength(2);

      let state = getLineEngineState(harness.engine);
      harness.engine.handleMessage("zoom", {
        factor: 0.9,
        centerX: (state.viewport.xMin + state.viewport.xMax) / 2,
      });
      expect(vi.getTimerCount()).toBe(0);
      harness.runQueuedFrame(performance.now() + 20);
      expect(harness.contexts).toHaveLength(2);

      let timestamp = performance.now() + 120;
      for (let frame = 0; frame < 20 && harness.hasQueuedFrame(); frame++) {
        harness.runQueuedFrame(timestamp);
        timestamp += 100;
      }
      expect(harness.hasQueuedFrame()).toBe(false);

      harness.engine.handleMessage("updateSeriesAppearance", {
        index: 0,
        patch: { width: 0 },
      });
      harness.runQueuedFrame(timestamp);
      timestamp += 100;
      for (let frame = 0; frame < 20 && harness.hasQueuedFrame(); frame++) {
        harness.runQueuedFrame(timestamp);
        timestamp += 100;
      }
      expect(harness.hasQueuedFrame()).toBe(false);

      state = getLineEngineState(harness.engine);
      harness.engine.handleMessage("zoom", {
        factor: 0.9,
        centerX: (state.viewport.xMin + state.viewport.xMax) / 2,
      });
      expect(vi.getTimerCount()).toBe(0);
      harness.runQueuedFrame(performance.now() + 20);

      expect(state.dpr).toBe(2);
      expect(harness.contexts).toHaveLength(2);
      expect(
        harness.contexts[1].pathCalls.some(
          (call) => call.op === "fill" && call.fillStyle === harness.fillColor,
        ),
      ).toBe(true);
    } finally {
      harness.engine.handleMessage("stop", {});
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("uses a new configured DPR immediately after resize", () => {
    vi.useFakeTimers();
    const harness = createRangeRasterHarness({ dpr: 2, ssr: false });

    try {
      stabilizeRangeRasterHarness(harness, false);
      const state = getLineEngineState(harness.engine);
      harness.engine.handleMessage("zoom", {
        factor: 0.8,
        centerX: (state.viewport.xMin + state.viewport.xMax) / 2,
      });
      harness.runQueuedFrame(performance.now() + 20);

      expect(state.dpr).toBe(2);
      expect(harness.canvases[0]).toMatchObject({
        width: 1_800,
        height: 960,
      });

      harness.engine.handleMessage("resize", {
        width: 1_000,
        height: 500,
        dpr: 2.5,
      });
      expect(state.dpr).toBe(2.5);
      expect(harness.canvases[0]).toMatchObject({
        width: 2_500,
        height: 1_250,
      });

      vi.advanceTimersByTime(180);
      expect(state.dpr).toBe(2.5);
      expect(harness.canvases[0]).toMatchObject({
        width: 2_500,
        height: 1_250,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.engine.handleMessage("stop", {});
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("keeps the configured DPR for a gapped zero-width range", () => {
    vi.useFakeTimers();
    const harness = createRangeRasterHarness({ dpr: 2, ssr: false });

    try {
      stabilizeRangeRasterHarness(harness, false, true);
      expect(harness.contexts).toHaveLength(2);

      const state = getLineEngineState(harness.engine);
      harness.engine.handleMessage("zoom", {
        factor: 0.9,
        centerX: (state.viewport.xMin + state.viewport.xMax) / 2,
      });
      expect(vi.getTimerCount()).toBe(0);
      harness.runQueuedFrame(performance.now() + 20);

      expect(harness.contexts).toHaveLength(2);
      expect(
        harness.contexts[1].pathCalls.some(
          (call) => call.op === "fill" && call.fillStyle === harness.fillColor,
        ),
      ).toBe(true);
    } finally {
      harness.engine.handleMessage("stop", {});
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("keeps co-resident line presentation detail at the configured DPR", () => {
    vi.useFakeTimers();
    const harness = createRangeRasterHarness({
      dpr: 2,
      ssr: false,
      includeLine: true,
    });

    try {
      stabilizeRangeRasterHarness(harness, false);
      for (const context of harness.contexts) context.pathCalls.length = 0;

      const state = getLineEngineState(harness.engine);
      harness.engine.handleMessage("zoom", {
        factor: 0.8,
        centerX: (state.viewport.xMin + state.viewport.xMax) / 2,
      });
      harness.runQueuedFrame(performance.now() + 20);

      const cacheContext = harness.contexts[1];
      const lineVertices = cacheContext.pathCalls.filter(
        (call) =>
          (call.op === "moveTo" || call.op === "lineTo") && call.strokeStyle === harness.lineColor,
      ).length;
      expect(lineVertices).toBeGreaterThan(0);
      expect(state.dpr).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.engine.handleMessage("stop", {});
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it.each([
    { label: "DPR1", dpr: 1, ssr: false },
    { label: "SSR", dpr: 2, ssr: true },
  ])("keeps configured resolution for $label rendering", ({ dpr, ssr }) => {
    vi.useFakeTimers();
    const harness = createRangeRasterHarness({ dpr, ssr });

    try {
      stabilizeRangeRasterHarness(harness, ssr);
      expect(harness.contexts).toHaveLength(2);
      for (const context of harness.contexts) context.pathCalls.length = 0;

      const state = getLineEngineState(harness.engine);
      harness.engine.handleMessage("zoom", {
        factor: 0.8,
        centerX: (state.viewport.xMin + state.viewport.xMax) / 2,
      });
      if (!ssr) harness.runQueuedFrame(performance.now() + 20);

      expect(harness.contexts).toHaveLength(2);
      expect(
        harness.contexts[1].pathCalls.some(
          (call) => call.op === "fill" && call.fillStyle === harness.fillColor,
        ),
      ).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.engine.handleMessage("stop", {});
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("does not resize the backing store for a clamped no-op zoom", () => {
    vi.useFakeTimers();
    const harness = createRangeRasterHarness({ dpr: 2, ssr: false });

    try {
      stabilizeRangeRasterHarness(harness, false);
      expect(harness.contexts).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);

      const state = getLineEngineState(harness.engine);
      harness.engine.handleMessage("zoom", {
        factor: 1.1,
        centerX: (state.viewport.xMin + state.viewport.xMax) / 2,
      });
      expect(vi.getTimerCount()).toBe(0);
      harness.runQueuedFrame(performance.now() + 20);

      expect(harness.contexts).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.engine.handleMessage("stop", {});
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("keeps the configured DPR for animated viewport navigation", () => {
    vi.useFakeTimers();
    const harness = createRangeRasterHarness({
      dpr: 2,
      ssr: false,
      animated: true,
    });

    try {
      stabilizeRangeRasterHarness(harness, false);
      expect(harness.contexts).toHaveLength(2);

      const state = getLineEngineState(harness.engine);
      harness.engine.handleMessage("zoomAnimated", {
        factor: 0.8,
        centerX: (state.viewport.xMin + state.viewport.xMax) / 2,
      });
      expect(vi.getTimerCount()).toBe(0);
      harness.runQueuedFrame(performance.now() + 20);

      expect(state.dpr).toBe(2);
      expect(harness.contexts).toHaveLength(2);
      expect(
        harness.contexts[1].pathCalls.some(
          (call) => call.op === "fill" && call.fillStyle === harness.fillColor,
        ),
      ).toBe(true);
    } finally {
      harness.engine.handleMessage("stop", {});
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("lineRenderer spline interpolation", () => {
  function mouseXForDataValue(
    engine: ReturnType<typeof createLineChartEngine>,
    dataX: number,
  ): number {
    const state = getLineEngineState(engine);
    const xRange = state.viewport.xMax - state.viewport.xMin;
    return state.padding.left + ((dataX - state.viewport.xMin) / xRange) * state.chartWidth;
  }

  it("paints the same Catmull–Rom value reported by the tooltip", () => {
    const color = "#abcdef";
    const { engine, contexts, messages } = createHarness({
      animated: false,
      interpolation: "spline",
      rangeSelector: { visible: false },
      tooltip: { hasCallback: true },
      seriesOptions: [{ name: "Spline", type: "line", color }],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20, 30]),
      series: [new Float64Array([0, 10, 0, 20])],
    });

    const splineSegments = contexts
      .flatMap((context) => context.pathCalls)
      .filter((call) => call.op === "bezierCurveTo" && call.strokeStyle === color);
    expect(splineSegments).toHaveLength(3);

    const firstSegment = splineSegments[0];
    const middleSegment = splineSegments[1];
    const state = getLineEngineState(engine);
    for (const t of [0.02, 0.5]) {
      messages.length = 0;
      engine.handleMessage("mousemove", {
        x: mouseXForDataValue(engine, 10 + t * 10),
        y: state.chartTop + 20,
      });

      const tooltip = messages.find((message) => message.type === "tooltipData") as
        { params?: { series?: Array<{ value: number }> } } | undefined;
      const tooltipValue = tooltip?.params?.series?.[0]?.value;
      if (t === 0.5) expect(tooltipValue).toBeCloseTo(4.375);

      const inverseT = 1 - t;
      const paintedY =
        inverseT ** 3 * firstSegment.y! +
        3 * inverseT ** 2 * t * middleSegment.cp1y! +
        3 * inverseT * t ** 2 * middleSegment.cp2y! +
        t ** 3 * middleSegment.y!;
      const tooltipScreenY =
        state.chartTop +
        ((state.viewport.yMax - tooltipValue!) / (state.viewport.yMax - state.viewport.yMin)) *
          state.chartHeight;

      expect(paintedY).toBeCloseTo(tooltipScreenY, 6);
    }
  });

  it("does not bridge explicit gaps with spline segments", () => {
    const color = "#fedcba";
    const { engine, contexts } = createHarness({
      animated: false,
      interpolation: "spline",
      rangeSelector: { visible: false },
      seriesOptions: [{ name: "Gapped spline", type: "line", color }],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20, 30, 40]),
      series: [new Float64Array([0, 10, Number.NaN, 20, 30])],
    });

    const calls = contexts
      .flatMap((context) => context.pathCalls)
      .filter((call) => call.strokeStyle === color);
    expect(calls.filter((call) => call.op === "moveTo")).toHaveLength(2);
    expect(calls.filter((call) => call.op === "bezierCurveTo")).toHaveLength(2);
  });

  it("keeps automatic Y-axis labels distinct for sub-decimal spline values", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      interpolation: "spline",
      rangeSelector: { visible: false },
      seriesOptions: [{ name: "Fractional spline", type: "line" }],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 1, 2, 3]),
      series: [new Float64Array([0.13, 0.25, 0.45, 0.55])],
    });

    const labels = contexts
      .flatMap((context) => context.fillTextCalls)
      .filter((call) => call.textAlign === "right" && /^-?\d+(?:\.\d+)?$/.test(call.text))
      .map((call) => call.text);

    expect(labels.length).toBeGreaterThan(2);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.some((label) => /\.\d{2}$/.test(label))).toBe(true);
  });
});

describe("lineRenderer stacked area series", () => {
  function mouseXForDataValue(
    engine: ReturnType<typeof createLineChartEngine>,
    dataX: number,
  ): number {
    const state = getLineEngineState(engine);
    const xRange = state.viewport.xMax - state.viewport.xMin;
    return state.padding.left + ((dataX - state.viewport.xMin) / xRange) * state.chartWidth;
  }

  it("includes cumulative stack totals in data bounds", () => {
    const { engine } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      seriesOptions: [
        { name: "Base", type: "stacked-area" },
        { name: "Top", type: "stacked-area" },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 1, 2]),
      series: [new Float64Array([100, 120, 140]), new Float64Array([20, 40, 60])],
    });

    const bounds = getLineEngineState(engine).dataBounds;
    expect(bounds.yMin).toBeLessThanOrEqual(0);
    expect(bounds.yMax).toBeGreaterThanOrEqual(200);
  });

  it("includes cumulative stacked-area spikes at every visible index", () => {
    const { engine } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      seriesOptions: [
        { name: "Base", type: "stacked-area" },
        { name: "Top", type: "stacked-area" },
      ],
    });

    const count = 10_000;
    const x = new Float64Array(count);
    const base = new Float64Array(count);
    const top = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      x[i] = i;
      base[i] = 1;
      top[i] = 1;
    }
    // Index 5000 falls between the old stride-aligned samples. Per-series LOD
    // still sees each 600 peak, but only an exact cumulative scan sees 1200.
    base[5000] = 600;
    top[5000] = 600;

    engine.handleMessage("setData", { x, series: [base, top] });

    engine.handleMessage("setViewportRange", { xMin: 0, xMax: 8998 });
    expect(getLineEngineState(engine).viewport.yMax).toBeGreaterThan(1000);

    engine.handleMessage("setViewportRange", { xMin: 2, xMax: 9000 });
    expect(getLineEngineState(engine).viewport.yMax).toBeGreaterThan(1000);
  });

  it("keeps stacked autoscale work bounded for wide viewport changes", () => {
    const { engine } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      seriesOptions: [
        {
          name: "Base",
          type: "stacked-area",
          stack: { fill: false, borderWidth: 0 },
        },
        {
          name: "Top",
          type: "stacked-area",
          stack: { fill: false, borderWidth: 0 },
        },
      ],
    });

    const count = 20_000;
    const x = new Float64Array(count);
    const baseValues = new Float64Array(count);
    const topValues = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      x[i] = i;
      baseValues[i] = 1;
      topValues[i] = 2;
    }

    const reads = { count: 0 };
    const countReads = (values: Float64Array): Float64Array =>
      new Proxy(values, {
        get(target, property) {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            reads.count++;
          }
          return Reflect.get(target, property, target);
        },
      });

    engine.handleMessage("setData", {
      x,
      series: [countReads(baseValues), countReads(topValues)],
    });
    reads.count = 0;

    engine.handleMessage("setViewportRange", { xMin: 137, xMax: 18_731 });

    // A raw cumulative scan would read roughly 37k values here. The exact
    // range index only touches fixed-size edge blocks; the interior is queried
    // from its aggregate tree.
    expect(reads.count).toBeLessThanOrEqual(2_048);
  });

  it("preserves exact positive and negative cumulative extrema", () => {
    const { engine } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      seriesOptions: [
        { name: "Base", type: "stacked-area" },
        { name: "Top", type: "stacked-area" },
      ],
    });

    const count = 4_096;
    const x = new Float64Array(count);
    const base = new Float64Array(count);
    const top = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      x[i] = i;
      base[i] = 4;
      top[i] = 5;
    }
    base[777] = 700;
    top[777] = 800;
    base[3333] = -600;
    top[3333] = -700;

    engine.handleMessage("setData", { x, series: [base, top] });
    engine.handleMessage("setViewportRange", { xMin: 513, xMax: 3583 });

    const viewport = getLineEngineState(engine).viewport;
    expect(viewport.yMax).toBeGreaterThanOrEqual(1500);
    expect(viewport.yMin).toBeLessThanOrEqual(-1300);
  });

  it("refreshes stacked aggregates when a streaming ring buffer wraps", () => {
    const { engine } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      seriesOptions: [
        { name: "Base", type: "stacked-area" },
        { name: "Top", type: "stacked-area" },
      ],
    });

    const maxPoints = 2_048;
    engine.handleMessage("initRingBuffer", {
      maxPoints,
      seriesCount: 2,
    });

    const firstCount = 2_500;
    const firstX = new Float64Array(firstCount);
    const firstBase = new Float64Array(firstCount).fill(1);
    const firstTop = new Float64Array(firstCount).fill(1);
    for (let i = 0; i < firstCount; i++) firstX[i] = i;
    firstBase[1000] = 700;
    firstTop[1000] = 800;
    engine.handleMessage("addDataPoints", {
      timestamps: firstX,
      valuesBySeries: [firstBase, firstTop],
    });
    engine.handleMessage("setViewportRange", { xMin: 452, xMax: 2499 });
    expect(getLineEngineState(engine).viewport.yMax).toBeGreaterThanOrEqual(1500);

    const secondCount = 1_000;
    const secondX = new Float64Array(secondCount);
    const secondBase = new Float64Array(secondCount).fill(1);
    const secondTop = new Float64Array(secondCount).fill(1);
    for (let i = 0; i < secondCount; i++) secondX[i] = firstCount + i;
    secondBase[700] = -600;
    secondTop[700] = -700;
    engine.handleMessage("addDataPoints", {
      timestamps: secondX,
      valuesBySeries: [secondBase, secondTop],
    });
    engine.handleMessage("setViewportRange", { xMin: 1452, xMax: 3499 });

    const viewport = getLineEngineState(engine).viewport;
    expect(viewport.yMin).toBeLessThanOrEqual(-1300);
    expect(viewport.yMax).toBeLessThan(300);
  });

  it("draws stacked area fills and top borders", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          name: "Base",
          type: "stacked-area",
          stack: {
            fillColor: "#123456",
            borderColor: "#abcdef",
            borderWidth: 2,
            borderStyle: "dotted",
          },
        },
        {
          name: "Top",
          type: "stackedArea",
          stack: {
            fillColor: "#654321",
            borderWidth: 0,
          },
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20]),
      series: [new Float64Array([10, 12, 14]), new Float64Array([3, 4, 5])],
    });

    const calls = contexts.flatMap((ctx) => ctx.pathCalls);
    expect(calls.some((call) => call.op === "fill" && call.fillStyle === "#123456")).toBe(true);
    expect(calls.some((call) => call.op === "fill" && call.fillStyle === "#654321")).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.op === "stroke" &&
          call.strokeStyle === "#abcdef" &&
          call.lineWidth === 2 &&
          JSON.stringify(call.lineDash) === JSON.stringify([2, 2]),
      ),
    ).toBe(true);
  });

  it("clips stacked area fills during reveal animation", () => {
    const { engine, contexts } = createHarness({
      animated: true,
      rangeSelector: { visible: false },
      seriesOptions: [
        {
          name: "Base",
          type: "stacked-area",
          stack: { fill: true },
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20]),
      series: [new Float64Array([10, 12, 14])],
    });

    const state = getLineEngineState(engine);
    state.revealProgress = 0;
    state.revealStartTime = performance.now() - 300;
    state.cacheValid = false;

    engine.handleMessage("setViewportRange", { xMin: 0, xMax: 20 });

    const calls = contexts.flatMap((ctx) => ctx.pathCalls);
    const revealClipRect = calls.find(
      (call) =>
        call.op === "rect" &&
        call.x === state.padding.left &&
        call.y === state.chartTop &&
        (call.width ?? 0) > 0 &&
        (call.width ?? 0) < state.chartWidth &&
        call.height === state.chartHeight,
    );

    expect(revealClipRect).toBeDefined();
    expect(calls.some((call) => call.op === "clip")).toBe(true);
  });

  it("clips ordinary line series during reveal animation", () => {
    const { engine, contexts } = createHarness({
      animated: true,
      rangeSelector: { visible: false },
      seriesOptions: [{ name: "Series A", type: "line" }],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20]),
      series: [new Float64Array([10, 12, 14])],
    });

    const state = getLineEngineState(engine);
    state.revealProgress = 0;
    state.revealStartTime = performance.now() - 300;
    state.cacheValid = false;

    engine.handleMessage("setViewportRange", { xMin: 0, xMax: 20 });

    const calls = contexts.flatMap((ctx) => ctx.pathCalls);
    const revealClipRect = calls.find(
      (call) =>
        call.op === "rect" &&
        call.x === state.padding.left &&
        call.y === state.chartTop &&
        (call.width ?? 0) > 0 &&
        (call.width ?? 0) < state.chartWidth &&
        call.height === state.chartHeight,
    );

    expect(revealClipRect).toBeDefined();
    expect(calls.some((call) => call.op === "clip")).toBe(true);
  });

  it("honors stacked area curve geometry", () => {
    function getBorderPathOps(curve: "linear" | "step-after") {
      const { engine, contexts } = createHarness({
        animated: false,
        rangeSelector: { visible: false },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [
          {
            name: "Base",
            type: "stacked-area",
            stack: {
              fillColor: "#123456",
              borderColor: "#abcdef",
              borderWidth: 1,
              curve,
            },
          },
        ],
      });

      engine.handleMessage("setData", {
        x: new Float64Array([0, 10, 20]),
        series: [new Float64Array([10, 18, 12])],
      });

      return contexts
        .flatMap((ctx) => ctx.pathCalls)
        .filter(
          (call) =>
            call.strokeStyle === "#abcdef" && (call.op === "moveTo" || call.op === "lineTo"),
        )
        .map((call) => call.op);
    }

    expect(getBorderPathOps("linear")).toEqual(["moveTo", "lineTo", "lineTo"]);
    expect(getBorderPathOps("step-after")).toEqual([
      "moveTo",
      "lineTo",
      "lineTo",
      "lineTo",
      "lineTo",
    ]);
  });

  it("reports raw component values for tooltip callbacks", () => {
    const { engine, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      tooltip: { hasCallback: true },
      seriesOptions: [
        { name: "Base", type: "stacked-area" },
        { name: "Top", type: "stacked-area" },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10]),
      series: [new Float64Array([10, 10]), new Float64Array([20, 20])],
    });
    messages.length = 0;

    engine.handleMessage("mousemove", {
      x: mouseXForDataValue(engine, 5),
      y: getLineEngineState(engine).chartTop + 20,
    });

    const tooltip = messages.find((m) => m.type === "tooltipData") as
      { params?: { series?: Array<{ value: number; interpolated: boolean }> } } | undefined;

    expect(tooltip?.params?.series?.[0]).toMatchObject({
      value: 10,
      interpolated: true,
    });
    expect(tooltip?.params?.series?.[1]).toMatchObject({
      value: 20,
      interpolated: true,
    });
  });

  it("holds step-curve tooltip values between samples", () => {
    const { engine, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      tooltip: { hasCallback: true },
      seriesOptions: [
        { name: "Base", type: "stacked-area", stack: { curve: "step-after" } },
        { name: "Top", type: "stacked-area", stack: { curve: "step-after" } },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10]),
      series: [new Float64Array([10, 30]), new Float64Array([20, 40])],
    });
    messages.length = 0;

    engine.handleMessage("mousemove", {
      x: mouseXForDataValue(engine, 5),
      y: getLineEngineState(engine).chartTop + 20,
    });

    const tooltip = messages.find((m) => m.type === "tooltipData") as
      { params?: { series?: Array<{ value: number; interpolated: boolean }> } } | undefined;

    // step-after draws flat treads holding the left sample, so hovering
    // mid-segment must report the held values (10/20), not the linear
    // blend (20/30).
    expect(tooltip?.params?.series?.[0]).toMatchObject({
      value: 10,
      interpolated: true,
    });
    expect(tooltip?.params?.series?.[1]).toMatchObject({
      value: 20,
      interpolated: true,
    });
  });
});

describe("lineRenderer bar series", () => {
  function mouseXForDataValue(
    engine: ReturnType<typeof createLineChartEngine>,
    dataX: number,
  ): number {
    const state = getLineEngineState(engine);
    const xRange = state.viewport.xMax - state.viewport.xMin;
    return state.padding.left + ((dataX - state.viewport.xMin) / xRange) * state.chartWidth;
  }

  it("draws bars with fill and dashed borders", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          name: "Volume",
          type: "bar",
          color: "#123456",
          bar: {
            fillColor: "#abcdef",
            borderColor: "#334455",
            borderWidth: 2,
            borderStyle: "dashed",
            widthRatio: 0.8,
            minWidth: 2,
            maxWidth: 20,
          },
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20]),
      series: [new Float64Array([1, 3, 2])],
    });

    const calls = contexts.flatMap((ctx) => ctx.pathCalls);
    expect(
      calls.some(
        (call) =>
          call.op === "fillRect" &&
          call.fillStyle === "#abcdef" &&
          (call.width ?? 0) > 0 &&
          (call.height ?? 0) > 0,
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.op === "strokeRect" &&
          call.strokeStyle === "#334455" &&
          call.lineWidth === 2 &&
          JSON.stringify(call.lineDash) === JSON.stringify([5, 3]),
      ),
    ).toBe(true);
  });

  it("does not apply line fill or glow effects to bar series", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          name: "Volume",
          type: "bar",
          color: "#123456",
          fill: true,
          fillColor: "#ff0000",
          fillEffect: "glow",
          width: 2,
          bar: {
            fillColor: "#abcdef",
            borderWidth: 0,
          },
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20]),
      series: [new Float64Array([1, 3, 2])],
    });

    const calls = contexts.flatMap((ctx) => ctx.pathCalls);
    expect(calls.some((call) => call.op === "fillRect" && call.fillStyle === "#abcdef")).toBe(true);
    expect(calls.some((call) => call.op === "fill" && call.fillStyle === "#ff0000")).toBe(false);
    expect(calls.some((call) => call.op === "stroke" && (call.lineWidth ?? 0) > 2)).toBe(false);
  });

  it("treats column as a bar alias", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          name: "Volume",
          type: "column",
          bar: {
            fillColor: "#55cc88",
          },
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20]),
      series: [new Float64Array([1, 3, 2])],
    });

    const calls = contexts.flatMap((ctx) => ctx.pathCalls);
    expect(calls.some((call) => call.op === "fillRect" && call.fillStyle === "#55cc88")).toBe(true);
  });

  it("does not double-draw coincident LOD samples", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [{ name: "Volume", type: "bar" }],
    });

    // Enough points to activate a non-raw LOD level; a monotonic ramp makes
    // every bucket's first/min and max/last samples coincide, which must not
    // draw the same translucent bar twice.
    const pointCount = 10_000;
    const x = new Float64Array(pointCount);
    const y = new Float64Array(pointCount);
    for (let i = 0; i < pointCount; i++) {
      x[i] = i;
      y[i] = i;
    }
    engine.handleMessage("setData", { x, series: [y] });

    const barRects = contexts
      .flatMap((ctx) => ctx.pathCalls)
      .filter((call) => call.op === "fillRect" && (call.width ?? 0) <= 24);
    expect(barRects.length).toBeGreaterThan(0);

    for (let i = 1; i < barRects.length; i++) {
      const previous = barRects[i - 1];
      const current = barRects[i];
      const identical =
        previous.x === current.x &&
        previous.y === current.y &&
        previous.width === current.width &&
        previous.height === current.height;
      expect(identical).toBe(false);
    }
  });

  it("includes the bar baseline in the data bounds", () => {
    const { engine } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      seriesOptions: [{ name: "Volume", type: "bar" }],
    });

    // All-positive values far from the default baseline of 0; without
    // baseline inclusion the Y range would start at the data minimum (100)
    // and the shortest bars would clamp to the chart edge.
    engine.handleMessage("setData", {
      x: new Float64Array([0, 1, 2]),
      series: [new Float64Array([100, 180, 140])],
    });

    expect(getLineEngineState(engine).dataBounds.yMin).toBeLessThanOrEqual(0);
  });

  it("snaps tooltip values to the nearest bar sample", () => {
    const { engine, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      tooltip: { hasCallback: true },
      seriesOptions: [{ name: "Volume", type: "bar" }],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10]),
      series: [new Float64Array([100, 200])],
    });
    messages.length = 0;

    engine.handleMessage("mousemove", {
      x: mouseXForDataValue(engine, 6),
      y: getLineEngineState(engine).chartTop + 20,
    });

    const tooltip = messages.find((m) => m.type === "tooltipData") as
      | {
          params?: {
            screenX?: number;
            series?: Array<{ value: number; interpolated: boolean }>;
          };
        }
      | undefined;
    const point = tooltip?.params?.series?.[0];

    expect(point).toMatchObject({ value: 200, interpolated: false });
    expect(tooltip?.params?.screenX).toBeCloseTo(mouseXForDataValue(engine, 10));
  });
});

describe("lineRenderer scatter series", () => {
  it("draws point marks without connecting strokes", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          name: "Samples",
          type: "scatter",
          color: "#123456",
          point: {
            color: "#abcdef",
            shape: "square",
            size: 6,
            borderColor: "#ffffff",
            borderWidth: 2,
          },
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20]),
      series: [new Float64Array([1, 3, 2])],
    });

    const calls = contexts.flatMap((ctx) => ctx.pathCalls);
    expect(calls.some((call) => call.op === "fill" && call.fillStyle === "#abcdef")).toBe(true);
    expect(
      calls.some(
        (call) => call.op === "stroke" && call.strokeStyle === "#ffffff" && call.lineWidth === 2,
      ),
    ).toBe(true);
    expect(calls.some((call) => call.op === "stroke" && call.strokeStyle === "#123456")).toBe(
      false,
    );
  });

  it("does not apply line fill or glow effects to scatter series", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          name: "Samples",
          type: "scatter",
          color: "#123456",
          fill: true,
          fillColor: "#ff0000",
          fillEffect: "glow",
          width: 2,
          point: {
            color: "#abcdef",
            shape: "circle",
            size: 5,
            borderWidth: 0,
          },
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20]),
      series: [new Float64Array([1, 3, 2])],
    });

    const calls = contexts.flatMap((ctx) => ctx.pathCalls);
    expect(calls.some((call) => call.op === "fill" && call.fillStyle === "#ff0000")).toBe(false);
    expect(calls.some((call) => call.op === "stroke" && (call.lineWidth ?? 0) > 2)).toBe(false);
    expect(calls.some((call) => call.op === "fill" && call.fillStyle === "#abcdef")).toBe(true);
  });

  it("does not double-draw coincident LOD samples", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          name: "Samples",
          type: "scatter",
          point: { shape: "square", size: 4, opacity: 0.5 },
        },
      ],
    });

    // Enough points to activate a non-raw LOD level; a monotonic ramp makes
    // every bucket's first/min and max/last samples coincide, which must not
    // draw the same translucent mark twice.
    const pointCount = 10_000;
    const x = new Float64Array(pointCount);
    const y = new Float64Array(pointCount);
    for (let i = 0; i < pointCount; i++) {
      x[i] = i;
      y[i] = i;
    }
    engine.handleMessage("setData", { x, series: [y] });

    const markRects = contexts.flatMap((ctx) => ctx.pathCalls).filter((call) => call.op === "rect");
    expect(markRects.length).toBeGreaterThan(0);

    for (let i = 1; i < markRects.length; i++) {
      const previous = markRects[i - 1];
      const current = markRects[i];
      const identical =
        previous.x === current.x &&
        previous.y === current.y &&
        previous.width === current.width &&
        previous.height === current.height;
      expect(identical).toBe(false);
    }
  });

  it("treats points as a scatter alias", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          name: "Samples",
          type: "points",
          point: {
            color: "#55cc88",
            size: 5,
          },
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20]),
      series: [new Float64Array([1, 3, 2])],
    });

    const calls = contexts.flatMap((ctx) => ctx.pathCalls);
    expect(calls.some((call) => call.op === "fill" && call.fillStyle === "#55cc88")).toBe(true);
  });
});

describe("lineRenderer step series", () => {
  const denseStepCount = 300;

  function mouseXForDataValue(
    engine: ReturnType<typeof createLineChartEngine>,
    dataX: number,
  ): number {
    const state = getLineEngineState(engine);
    const xRange = state.viewport.xMax - state.viewport.xMin;
    return state.padding.left + ((dataX - state.viewport.xMin) / xRange) * state.chartWidth;
  }

  function renderDenseStepSeries(
    type: "step" | "step-after" | "step-before" | "step-mid",
    options: {
      color?: string;
      lineWidth?: number;
      values?: Float64Array;
    } = {},
  ) {
    const color = options.color ?? "#654321";
    const x = new Float64Array(denseStepCount);
    const y = options.values ?? new Float64Array(denseStepCount);
    for (let index = 0; index < denseStepCount; index++) {
      x[index] = index;
      if (!options.values) y[index] = index % 2 === 0 ? 10 : 20;
    }

    const { engine, contexts } = createHarness(
      {
        animated: false,
        rangeSelector: { visible: false },
        grid: { vertical: false, horizontal: false },
        axis: {
          bottom: { visible: false },
          top: { visible: false },
          left: { visible: false },
          right: { visible: false },
        },
        seriesOptions: [{ type, color, width: options.lineWidth ?? 2 }],
      },
      320,
    );

    engine.handleMessage("setData", { x, series: [y] });
    const calls = contexts
      .flatMap((context) => context.pathCalls)
      .filter((call) => call.op === "fillRect" && call.fillStyle === color);
    const state = getLineEngineState(engine);
    const screenX = (value: number) =>
      state.padding.left +
      ((value - state.viewport.xMin) / (state.viewport.xMax - state.viewport.xMin)) *
        state.chartWidth;
    const screenY = (value: number) =>
      state.chartTop +
      ((state.viewport.yMax - value) / (state.viewport.yMax - state.viewport.yMin)) *
        state.chartHeight;

    return { calls, color, contexts, screenX, screenY };
  }

  function expectRect(
    call: PathCall | undefined,
    expected: { x: number; y: number; width: number; height: number },
  ): void {
    expect(call).toBeDefined();
    expect(call?.x).toBeCloseTo(expected.x);
    expect(call?.y).toBeCloseTo(expected.y);
    expect(call?.width).toBeCloseTo(expected.width);
    expect(call?.height).toBeCloseTo(expected.height);
  }

  it("draws step series as horizontal and vertical path segments", () => {
    const { engine, contexts } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      grid: { vertical: false, horizontal: false },
      axis: {
        bottom: { visible: false },
        top: { visible: false },
        left: { visible: false },
        right: { visible: false },
      },
      seriesOptions: [
        {
          name: "Stepped",
          type: "step",
          color: "#123456",
          width: 2,
        },
      ],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10, 20]),
      series: [new Float64Array([0, 10, 0])],
    });

    const calls = contexts
      .flatMap((ctx) => ctx.pathCalls)
      .filter(
        (call) => call.strokeStyle === "#123456" && (call.op === "moveTo" || call.op === "lineTo"),
      );

    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(calls[0].op).toBe("moveTo");
    expect(calls[1].op).toBe("lineTo");
    expect(calls[2].op).toBe("lineTo");

    expect(calls[1].x).toBeGreaterThan(calls[0].x ?? 0);
    expect(calls[1].y).toBeCloseTo(calls[0].y ?? Number.NaN);
    expect(calls[2].x).toBeCloseTo(calls[1].x ?? Number.NaN);
    expect(calls[2].y).not.toBeCloseTo(calls[1].y ?? Number.NaN);
  });

  it.each(["step", "step-after"] as const)(
    "rasterizes dense %s geometry as horizontal-then-vertical rectangles",
    (type) => {
      const { calls, contexts, color, screenX, screenY } = renderDenseStepSeries(type);
      const width = 2;
      const halfWidth = width / 2;
      const x0 = screenX(0);
      const x1 = screenX(1);
      const y0 = screenY(10);
      const y1 = screenY(20);

      expectRect(calls[0], {
        x: x0 - halfWidth,
        y: y0 - halfWidth,
        width: x1 - x0 + width,
        height: width,
      });
      expectRect(calls[1], {
        x: x1 - halfWidth,
        y: Math.min(y0, y1) - halfWidth,
        width,
        height: Math.abs(y1 - y0) + width,
      });
      expect(
        contexts
          .flatMap((context) => context.pathCalls)
          .some((call) => call.op === "stroke" && call.strokeStyle === color),
      ).toBe(false);
    },
  );

  it("rasterizes dense step-before geometry at the left edge", () => {
    const { calls, screenX, screenY } = renderDenseStepSeries("step-before");
    const width = 2;
    const halfWidth = width / 2;
    const x0 = screenX(0);
    const x1 = screenX(1);
    const y0 = screenY(10);
    const y1 = screenY(20);

    expectRect(calls[0], {
      x: x0 - halfWidth,
      y: Math.min(y0, y1) - halfWidth,
      width,
      height: Math.abs(y1 - y0) + width,
    });
    expectRect(calls[1], {
      x: x0 - halfWidth,
      y: y1 - halfWidth,
      width: x1 - x0 + width,
      height: width,
    });
  });

  it("rasterizes dense step-mid geometry around the midpoint", () => {
    const { calls, screenX, screenY } = renderDenseStepSeries("step-mid");
    const width = 2;
    const halfWidth = width / 2;
    const x0 = screenX(0);
    const x1 = screenX(1);
    const midX = (x0 + x1) / 2;
    const y0 = screenY(10);
    const y1 = screenY(20);

    expectRect(calls[0], {
      x: x0 - halfWidth,
      y: y0 - halfWidth,
      width: midX - x0 + width,
      height: width,
    });
    expectRect(calls[1], {
      x: midX - halfWidth,
      y: Math.min(y0, y1) - halfWidth,
      width,
      height: Math.abs(y1 - y0) + width,
    });
    expectRect(calls[2], {
      x: midX - halfWidth,
      y: y1 - halfWidth,
      width: x1 - midX + width,
      height: width,
    });
  });

  it("does not bridge NaN gaps in the dense step raster path", () => {
    const values = new Float64Array(denseStepCount);
    for (let index = 0; index < denseStepCount; index++) {
      values[index] = index % 2 === 0 ? 10 : 20;
    }
    values.fill(NaN, 120, 140);

    const { calls, screenX } = renderDenseStepSeries("step", { values });
    expect(calls.length).toBeGreaterThan(0);
    const gapLeft = screenX(119) + 1;
    const gapRight = screenX(140) - 1;
    expect(
      calls.some(
        (call) =>
          (call.x ?? Infinity) < gapLeft && (call.x ?? -Infinity) + (call.width ?? 0) > gapRight,
      ),
    ).toBe(false);
  });

  it("keeps sparse gappy step data on the stroked path", () => {
    const color = "#654321";
    const values = new Float64Array(denseStepCount);
    values.fill(NaN);
    values[10] = 10;
    values[11] = 20;
    values[280] = 20;
    values[281] = 10;

    const { calls, contexts } = renderDenseStepSeries("step", {
      color,
      values,
    });
    expect(calls).toHaveLength(0);
    expect(
      contexts
        .flatMap((context) => context.pathCalls)
        .some((call) => call.op === "stroke" && call.strokeStyle === color),
    ).toBe(true);
  });

  it.each([
    { color: "rgba(101, 67, 33, 0.5)", lineWidth: 2 },
    { color: "#654321", lineWidth: 3 },
  ])("keeps the stroked path for blended or wide dense steps", ({ color, lineWidth }) => {
    const { calls, contexts } = renderDenseStepSeries("step", {
      color,
      lineWidth,
    });
    expect(calls).toHaveLength(0);
    expect(
      contexts
        .flatMap((context) => context.pathCalls)
        .some((call) => call.op === "stroke" && call.strokeStyle === color),
    ).toBe(true);
  });

  it("keeps step-after tooltip value on the held left value near the right point", () => {
    const { engine, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      tooltip: { hasCallback: true },
      seriesOptions: [{ name: "Step After", type: "step" }],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10]),
      series: [new Float64Array([100, 200])],
    });
    messages.length = 0;

    engine.handleMessage("mousemove", {
      x: mouseXForDataValue(engine, 9.8),
      y: getLineEngineState(engine).chartTop + 20,
    });

    const tooltip = messages.find((m) => m.type === "tooltipData") as
      { params?: { series?: Array<{ value: number; interpolated: boolean }> } } | undefined;
    const point = tooltip?.params?.series?.[0];
    expect(point).toMatchObject({ value: 100, interpolated: true });
  });

  it("keeps step-before tooltip value on the held right value near the left point", () => {
    const { engine, messages } = createHarness({
      animated: false,
      rangeSelector: { visible: false },
      tooltip: { hasCallback: true },
      seriesOptions: [{ name: "Step Before", type: "step-before" }],
    });

    engine.handleMessage("setData", {
      x: new Float64Array([0, 10]),
      series: [new Float64Array([100, 200])],
    });
    messages.length = 0;

    engine.handleMessage("mousemove", {
      x: mouseXForDataValue(engine, 0.2),
      y: getLineEngineState(engine).chartTop + 20,
    });

    const tooltip = messages.find((m) => m.type === "tooltipData") as
      { params?: { series?: Array<{ value: number; interpolated: boolean }> } } | undefined;
    const point = tooltip?.params?.series?.[0];
    expect(point).toMatchObject({ value: 200, interpolated: true });
  });
});
