import { afterEach, describe, expect, it, vi } from "vitest";
import type { MultiSeriesData } from "@sixtyfold/core/data/seriesTypes";
import type { OHLCVData } from "@sixtyfold/stock";
import * as lineEngineModule from "@sixtyfold/line/engine";
import * as stockEngineModule from "@sixtyfold/stock/engine";
import { renderLineChartSSR, renderStockChartSSR, type SSRCanvas } from "./index";

afterEach(() => {
  vi.restoreAllMocks();
});

interface RecordingCanvas extends SSRCanvas {
  fillTextCalls: string[];
}

function createRecordingCanvas(width = 320, height = 180): RecordingCanvas {
  const fillTextCalls: string[] = [];
  const gradient = { addColorStop: () => {} } as CanvasGradient;
  const context = new Proxy({} as CanvasRenderingContext2D, {
    get: (_target, property) => {
      if (property === "fillText") {
        return (text: string) => fillTextCalls.push(text);
      }
      if (property === "measureText") {
        return (text: string) => ({ width: text.length * 7 }) as TextMetrics;
      }
      if (property === "createLinearGradient") return () => gradient;
      if (property === "createPattern") return () => null;
      if (property === "getLineDash") return () => [];
      return () => {};
    },
    set: () => true,
  });

  return {
    width,
    height,
    fillTextCalls,
    getContext: () => context,
  } as RecordingCanvas;
}

const overlay = {
  items: [
    {
      kind: "text" as const,
      text: "SSR watermark",
      x: 12,
      y: 16,
      xUnit: "px" as const,
      yUnit: "px" as const,
      relativeTo: "canvas" as const,
    },
  ],
};

describe("SSR overlays", () => {
  it("renders line-chart overlays", () => {
    const canvas = createRecordingCanvas();
    const data: MultiSeriesData = {
      x: new Float64Array([0, 10, 20]),
      series: [new Float64Array([1, 2, 3])],
      length: 3,
      seriesCount: 1,
    };

    renderLineChartSSR(
      canvas,
      data,
      { overlay },
      {
        width: 320,
        height: 180,
        createCanvas: createRecordingCanvas,
      },
    );

    expect(canvas.fillTextCalls).toContain("SSR watermark");
  });

  it("forwards marker option in renderLineChartSSR", () => {
    const canvas = createRecordingCanvas();
    const data: MultiSeriesData = {
      x: new Float64Array([0, 10, 20]),
      series: [new Float64Array([1, 2, 3])],
      length: 3,
      seriesCount: 1,
    };
    const origCreate = lineEngineModule.createLineChartEngine;
    let capturedEngine: ReturnType<typeof origCreate> | undefined;
    vi.spyOn(lineEngineModule, "createLineChartEngine").mockImplementation((...args) => {
      capturedEngine = origCreate(...args);
      return capturedEngine;
    });

    const markerConfig = { shape: "diamond", size: 9, borderColor: "#ff0055" };
    renderLineChartSSR(
      canvas,
      data,
      { marker: markerConfig },
      {
        width: 320,
        height: 180,
        createCanvas: createRecordingCanvas,
      },
    );

    expect(capturedEngine?.getMarkerConfig(0)).toMatchObject(markerConfig);
  });

  it("renders stock-chart overlays", () => {
    const canvas = createRecordingCanvas();
    const data: OHLCVData = {
      timestamp: new Float64Array([0, 3_600_000]),
      open: new Float64Array([10, 11]),
      high: new Float64Array([12, 13]),
      low: new Float64Array([9, 10]),
      close: new Float64Array([11, 12]),
      volume: new Float64Array([100, 200]),
      length: 2,
    };

    renderStockChartSSR(
      canvas,
      data,
      { overlay },
      {
        width: 320,
        height: 180,
        createCanvas: createRecordingCanvas,
      },
    );

    expect(canvas.fillTextCalls).toContain("SSR watermark");
  });

  it("forwards timeScale, showLeftPriceMarker, and showRightPriceMarker in renderStockChartSSR", () => {
    const data: OHLCVData = {
      timestamp: new Float64Array([0, 3_600_000]),
      open: new Float64Array([10, 11]),
      high: new Float64Array([12, 13]),
      low: new Float64Array([9, 10]),
      close: new Float64Array([11.25, 12.75]),
      volume: new Float64Array([100, 200]),
      length: 2,
    };

    const origCreate = stockEngineModule.createStockChartEngine;
    let initConfig: Record<string, any> | undefined;
    vi.spyOn(stockEngineModule, "createStockChartEngine").mockImplementation((...args) => {
      const engine = origCreate(...args);
      const origHandleMessage = engine.handleMessage.bind(engine);
      engine.handleMessage = (type, payload) => {
        if (type === "init") initConfig = payload.config;
        origHandleMessage(type, payload);
      };
      return engine;
    });

    const canvas = createRecordingCanvas();
    renderStockChartSSR(
      canvas,
      data,
      {
        timeScale: "market",
        showLeftPriceMarker: true,
        showRightPriceMarker: false,
      },
      {
        width: 320,
        height: 180,
        createCanvas: createRecordingCanvas,
      },
    );

    expect(initConfig).toBeDefined();
    expect(initConfig!.timeScale).toBe("market");
    expect(initConfig!.axis).toMatchObject({
      left: { cursorLabel: { visible: true } },
      right: { cursorLabel: { visible: false } },
    });
  });
});
