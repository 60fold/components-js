import { describe, expect, it, vi } from "vitest";
import { HOUR } from "@sixtyfold/core/chart/chartConstants";
import { createStockChartEngine } from "./stockRenderer.js";

interface CanvasRecorder {
  canvas: { width: number; height: number; getContext: () => CanvasRenderingContext2D };
  styles: Array<{ property: PropertyKey; value: unknown }>;
  calls: Array<{ method: PropertyKey; args: unknown[] }>;
}

function createCanvasRecorder(width = 800, height = 600): CanvasRecorder {
  const styles: CanvasRecorder["styles"] = [];
  const calls: CanvasRecorder["calls"] = [];
  const gradient = { addColorStop: () => {} } as CanvasGradient;
  const target: Record<PropertyKey, unknown> = {};
  const context = new Proxy(target as unknown as CanvasRenderingContext2D, {
    get(current, property) {
      if (property in current) return Reflect.get(current, property);
      if (property === "measureText") {
        return (value: string) => ({ width: value.length * 6 }) as TextMetrics;
      }
      if (property === "createLinearGradient") return () => gradient;
      if (property === "createPattern") return () => null;
      return (...args: unknown[]) => calls.push({ method: property, args });
    },
    set(current, property, value) {
      styles.push({ property, value });
      Reflect.set(current, property, value);
      return true;
    },
  });
  return {
    canvas: { width, height, getContext: () => context },
    styles,
    calls,
  };
}

function createHarness(config: Record<string, unknown> = {}) {
  const messages: Array<Record<string, any>> = [];
  const recorder = createCanvasRecorder();
  const engine = createStockChartEngine(
    { postMessage: (message) => messages.push(message) },
    {
      ssr: true,
      createCanvas: () => recorder.canvas,
    },
  );
  engine.handleMessage("init", {
    canvas: recorder.canvas,
    dpr: 1,
    config: {
      animated: false,
      rangeSelector: { visible: false },
      ...config,
    },
  });
  engine.handleMessage("resize", { width: 800, height: 600, dpr: 1 });
  messages.length = 0;
  recorder.styles.length = 0;
  recorder.calls.length = 0;
  return { engine, messages, recorder };
}

function makeCandles(length: number, start = 0) {
  const timestamp = new Float64Array(length);
  const open = new Float64Array(length);
  const high = new Float64Array(length);
  const low = new Float64Array(length);
  const close = new Float64Array(length);
  const volume = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    timestamp[i] = start + i * HOUR;
    open[i] = 100 + i;
    high[i] = 103 + i;
    low[i] = 98 + i;
    close[i] = 101 + i;
    volume[i] = 1_000 + i * 10;
  }
  return { timestamp, open, high, low, close, volume };
}

describe("stock renderer professional layers", () => {
  it("applies an explicit RTL direction to stock chart text", () => {
    const title = "سعر السوق";
    const { engine, recorder } = createHarness({
      textDirection: "rtl",
      labels: {
        top: {
          text: title,
          align: "start",
        },
      },
    });

    engine.handleMessage("setData", makeCandles(20));

    expect(recorder.styles).toContainEqual({
      property: "direction",
      value: "rtl",
    });
    expect(
      recorder.calls.some((call) => call.method === "fillText" && call.args[0] === title),
    ).toBe(true);
  });

  it("renders indicators, volume profile, price lines, and sparse markers", () => {
    const { engine, recorder } = createHarness({
      indicators: [
        { type: "sma", period: 3, color: "#123456" },
        {
          type: "bollinger",
          period: 4,
          middleColor: "#234567",
          upperColor: "#345678",
          lowerColor: "#456789",
          fillColor: "#56789a",
          fillOpacity: 0.2,
        },
      ],
      volumeProfile: {
        visible: true,
        rows: 24,
        valueAreaPercent: 70,
        pointOfControlColor: "#fedcba",
      },
      priceLines: [{ price: 112, color: "#abcdef", label: "Alert", lineDash: [3, 2] }],
      markers: [
        {
          timestamp: 8 * HOUR,
          price: 109,
          position: "price",
          color: "#00ffaa",
          label: "BUY",
        },
      ],
    });

    engine.handleMessage("setData", makeCandles(20));

    const strokeStyles = recorder.styles
      .filter((entry) => entry.property === "strokeStyle")
      .map((entry) => entry.value);
    const fillStyles = recorder.styles
      .filter((entry) => entry.property === "fillStyle")
      .map((entry) => entry.value);
    expect(strokeStyles).toContain("#123456");
    expect(strokeStyles).toContain("#234567");
    expect(strokeStyles).toContain("#345678");
    expect(strokeStyles).toContain("#456789");
    expect(strokeStyles).toContain("#fedcba");
    expect(strokeStyles).toContain("#abcdef");
    expect(fillStyles).toContain("#00ffaa");
  });

  it("emits crosshair readings without requiring a custom tooltip callback", () => {
    const { engine, messages, recorder } = createHarness({
      indicators: [{ id: "trend", label: "Trend", type: "sma", period: 3, color: "#123456" }],
    });
    engine.handleMessage("setData", makeCandles(20));
    messages.length = 0;

    engine.handleMessage("mousemove", { x: 400, y: 200 });

    const crosshair = messages.find((message) => message.type === "tooltipData");
    expect(crosshair).toBeDefined();
    expect(crosshair!.params.indicators).toEqual([
      expect.objectContaining({
        id: "trend",
        label: "Trend",
        color: "#123456",
      }),
    ]);
    expect(Number.isFinite(crosshair!.params.indicators[0].value)).toBe(true);
    expect(
      recorder.calls.some((call) => call.method === "fillText" && call.args[0] === "Trend"),
    ).toBe(true);

    engine.handleMessage("mouseleave", {});
    expect(messages.at(-1)).toEqual({ type: "crosshairLeave" });
  });

  it("bounds OHLCV display precision in crosshair events and the default tooltip", () => {
    const { engine, messages, recorder } = createHarness();
    const candles = makeCandles(20);
    candles.open.fill(1_860.9300000000003);
    candles.high.fill(1_863.3700000000001);
    candles.low.fill(1_858.4900000000002);
    candles.close.fill(1_860.6400000000003);
    candles.volume.fill(509.41990000000004);
    engine.handleMessage("setData", candles);
    messages.length = 0;
    recorder.calls.length = 0;

    engine.handleMessage("mousemove", { x: 400, y: 200 });

    const crosshair = messages.find((message) => message.type === "tooltipData");
    expect(crosshair?.params.formatted.volume).toBe("509.4199");
    for (const value of Object.values(crosshair?.params.formatted ?? {})) {
      expect(value).not.toMatch(/\.\d{5,}/);
    }
    expect(
      recorder.calls.some((call) => call.method === "fillText" && call.args[0] === "509.4199"),
    ).toBe(true);
    expect(
      recorder.calls.some(
        (call) => call.method === "fillText" && call.args[0] === "509.41990000000004",
      ),
    ).toBe(false);
  });

  it("updates moving averages incrementally as a streaming ring wraps", () => {
    const { engine, messages } = createHarness({
      indicators: [{ id: "sma", type: "sma", period: 3 }],
    });
    engine.handleMessage("initRingBuffer", { maxCandles: 4 });
    engine.handleMessage("addCandles", {
      timestamps: new Float64Array([HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR]),
      opens: new Float64Array([1, 2, 3, 4]),
      highs: new Float64Array([1, 2, 3, 4]),
      lows: new Float64Array([1, 2, 3, 4]),
      closes: new Float64Array([1, 2, 3, 4]),
      volumes: new Float64Array([1, 1, 1, 1]),
    });
    messages.length = 0;
    engine.handleMessage("mousemove", { x: 720, y: 200 });
    expect(
      messages.find((message) => message.type === "tooltipData")?.params.indicators[0].value,
    ).toBe(3);

    messages.length = 0;
    engine.handleMessage("addCandles", {
      timestamps: new Float64Array([5 * HOUR]),
      opens: new Float64Array([5]),
      highs: new Float64Array([5]),
      lows: new Float64Array([5]),
      closes: new Float64Array([5]),
      volumes: new Float64Array([1]),
    });
    const update = messages.find((message) => message.type === "tooltipData");
    expect(update?.params.timestamp).toBe(5 * HOUR);
    expect(update?.params.indicators[0].value).toBe(4);
  });

  it("rebases rolling accumulators after long streaming sessions", () => {
    const capacity = 64;
    const period = 31;
    const length = capacity * 100;
    const values = new Float64Array(length);
    const timestamps = new Float64Array(length);
    const volumes = new Float64Array(length);
    for (let i = 0; i < length; i++) {
      timestamps[i] = (i + 1) * HOUR;
      values[i] = 1_000_000 + (((i * 17) % 23) - 11) * 0.1;
      volumes[i] = 1;
    }

    const { engine, messages } = createHarness({
      indicators: [
        { id: "sma", type: "sma", period },
        { id: "bands", type: "bollinger", period, deviation: 2 },
      ],
    });
    engine.handleMessage("initRingBuffer", { maxCandles: capacity });
    engine.handleMessage("addCandles", {
      timestamps,
      opens: values.slice(),
      highs: values.slice(),
      lows: values.slice(),
      closes: values,
      volumes,
    });
    messages.length = 0;
    engine.handleMessage("mousemove", { x: 720, y: 200 });

    let sum = 0;
    for (let i = length - period; i < length; i++) {
      sum += values[i];
    }
    const mean = sum / period;
    let squaredDeviationSum = 0;
    for (let i = length - period; i < length; i++) {
      const deviation = values[i] - mean;
      squaredDeviationSum += deviation * deviation;
    }
    const variance = squaredDeviationSum / period;
    const width = 2 * Math.sqrt(variance);
    const readings = Object.fromEntries(
      messages
        .find((message) => message.type === "tooltipData")!
        .params.indicators.map((reading: { id: string; value: number }) => [
          reading.id,
          reading.value,
        ]),
    );

    expect(readings.sma).toBeCloseTo(mean, 9);
    expect(readings["bands:middle"]).toBeCloseTo(mean, 9);
    expect(readings["bands:upper"]).toBeCloseTo(mean + width, 9);
    expect(readings["bands:lower"]).toBeCloseTo(mean - width, 9);
  });

  it("keeps hidden streaming studies warm across ring wrap", () => {
    const definitions = [
      { id: "ema", type: "ema" as const, period: 3 },
      { id: "bands", type: "bollinger" as const, period: 3 },
      { id: "vwap", type: "vwap" as const, reset: "none" as const },
    ];
    const { engine, messages } = createHarness({ indicators: definitions });
    engine.handleMessage("initRingBuffer", { maxCandles: 4 });
    engine.handleMessage("addCandles", {
      timestamps: new Float64Array([HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR]),
      opens: new Float64Array([1, 2, 3, 4]),
      highs: new Float64Array([1, 2, 3, 4]),
      lows: new Float64Array([1, 2, 3, 4]),
      closes: new Float64Array([1, 2, 3, 4]),
      volumes: new Float64Array([1, 1, 1, 1]),
    });

    engine.handleMessage("setIndicators", {
      indicators: definitions.map((definition) => ({ ...definition, visible: false })),
    });
    engine.handleMessage("addCandles", {
      timestamps: new Float64Array([5 * HOUR]),
      opens: new Float64Array([5]),
      highs: new Float64Array([5]),
      lows: new Float64Array([5]),
      closes: new Float64Array([5]),
      volumes: new Float64Array([1]),
    });
    engine.handleMessage("setIndicators", { indicators: definitions });
    messages.length = 0;
    engine.handleMessage("mousemove", { x: 720, y: 200 });

    const readings = Object.fromEntries(
      messages
        .find((message) => message.type === "tooltipData")!
        .params.indicators.map((reading: { id: string; value: number }) => [
          reading.id,
          reading.value,
        ]),
    );
    expect(readings.ema).toBeCloseTo(4, 10);
    expect(readings["bands:middle"]).toBeCloseTo(4, 10);
    expect(readings["bands:upper"]).toBeCloseTo(4 + 2 * Math.sqrt(2 / 3), 10);
    expect(readings["bands:lower"]).toBeCloseTo(4 - 2 * Math.sqrt(2 / 3), 10);
    // Full-stream anchored VWAP remains (1+2+3+4+5)/5, rather than jumping
    // to the retained-ring average (2+3+4+5)/4 when the study is re-shown.
    expect(readings.vwap).toBeCloseTo(3, 10);
  });

  it("never aliases duplicate direct-engine indicator runtimes", () => {
    const definitions = [
      { id: "duplicate", type: "sma" as const, period: 3 },
      { id: "duplicate", type: "sma" as const, period: 3 },
    ];
    const { engine, messages } = createHarness({ indicators: definitions });
    engine.handleMessage("initRingBuffer", { maxCandles: 4 });
    engine.handleMessage("addCandles", {
      timestamps: new Float64Array([HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR]),
      opens: new Float64Array([1, 2, 3, 4]),
      highs: new Float64Array([1, 2, 3, 4]),
      lows: new Float64Array([1, 2, 3, 4]),
      closes: new Float64Array([1, 2, 3, 4]),
      volumes: new Float64Array([1, 1, 1, 1]),
    });

    engine.handleMessage("setIndicators", {
      indicators: definitions.map((definition) => ({
        ...definition,
        visible: false,
      })),
    });
    engine.handleMessage("addCandles", {
      timestamps: new Float64Array([5 * HOUR]),
      opens: new Float64Array([5]),
      highs: new Float64Array([5]),
      lows: new Float64Array([5]),
      closes: new Float64Array([5]),
      volumes: new Float64Array([1]),
    });
    engine.handleMessage("setIndicators", { indicators: definitions });
    messages.length = 0;
    engine.handleMessage("mousemove", { x: 720, y: 200 });

    const values = messages
      .find((message) => message.type === "tooltipData")!
      .params.indicators.map((reading: { value: number }) => reading.value);
    expect(values).toEqual([4, 4]);
  });

  it("skips coarse LOD buckets at or before firstRawX when rendering range preview after ring wrap", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (handle: ReturnType<typeof setTimeout>) =>
      clearTimeout(handle),
    );
    try {
      const previewColor = "#987654";
      const pathXs: number[] = [];
      let currentStroke = "";
      const makeTrackingCanvas = (width = 800, height = 600) => {
        const context = new Proxy({} as CanvasRenderingContext2D, {
          get(_target, property) {
            if (property === "measureText") return () => ({ width: 30 }) as TextMetrics;
            if (property === "createLinearGradient") return () => ({ addColorStop: () => {} });
            if (property === "createPattern") return () => null;
            if (property === "moveTo" || property === "lineTo") {
              return (x: number) => {
                if (currentStroke === previewColor) pathXs.push(x);
              };
            }
            return () => {};
          },
          set(_target, property, value) {
            if (property === "strokeStyle") currentStroke = String(value);
            return true;
          },
        });
        return { width, height, getContext: () => context };
      };

      const engine = createStockChartEngine(
        { postMessage: () => {} },
        {
          ssr: false,
          createCanvas: (w, h) => makeTrackingCanvas(w, h),
        },
      );
      engine.handleMessage("init", {
        canvas: makeTrackingCanvas(800, 600),
        dpr: 1,
        config: {
          animated: false,
          previewLineColor: previewColor,
          rangeSelector: { visible: true, height: 48 },
        },
      });
      engine.handleMessage("resize", { width: 800, height: 600, dpr: 1 });
      engine.handleMessage("initRingBuffer", { maxCandles: 120 });

      const initial = makeCandles(120, HOUR);
      engine.handleMessage("addCandles", {
        timestamps: initial.timestamp,
        opens: initial.open,
        highs: initial.high,
        lows: initial.low,
        closes: initial.close,
        volumes: initial.volume,
        initialTimeRange: "ALL",
      });
      vi.advanceTimersByTime(300);

      // Append 24 more hourly candles to wrap the ring buffer by 1 day while the coarse 1M/1W LOD
      // snapshot still starts at the evicted firstRawX; render before the 500ms LOD rebuild fires.
      const next = makeCandles(24, 121 * HOUR);
      pathXs.length = 0;

      engine.handleMessage("addCandles", {
        timestamps: next.timestamp,
        opens: next.open,
        highs: next.high,
        lows: next.low,
        closes: next.close,
        volumes: next.volume,
      });
      vi.advanceTimersByTime(20);

      expect(pathXs.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < pathXs.length; i++) {
        expect(pathXs[i]).toBeGreaterThan(pathXs[i - 1]);
      }
      engine.handleMessage("stop", {});
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
