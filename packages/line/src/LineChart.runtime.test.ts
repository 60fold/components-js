/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseChart } from "@sixtyfold/core/chart/BaseChart";
import type { ChartWorkerLike } from "@sixtyfold/core/chart/workerInterface";
import { markViewportInputBatchRenderer } from "../../core/src/chart/internalRendererCapabilities";
import { LineChart } from "./LineChart";

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({
      top: 0,
      left: 0,
      right: 800,
      bottom: 400,
      width: 800,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  return canvas;
}

function installAnimationFrameHarness(): { pending(): number } {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      callbacks.delete(id);
    }),
  );
  return {
    pending() {
      return callbacks.size;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LineChart viewport/data ordering", () => {
  it("flushes pending wheel input before setData", () => {
    const frames = installAnimationFrameHarness();
    const messages: Record<string, any>[] = [];
    const worker = markViewportInputBatchRenderer<ChartWorkerLike>({
      onmessage: null,
      postMessage(message) {
        messages.push(message);
      },
      terminate: vi.fn(),
    });
    vi.spyOn(BaseChart as any, "selectChartRenderer").mockReturnValue({
      renderer: () => worker,
      useWorker: false,
      resolvedRenderMode: "main",
    });
    const canvas = createCanvas();
    const chart = new LineChart(canvas, { interactive: true });
    messages.length = 0;

    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -120,
        clientX: 100,
        clientY: 100,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(messages).toEqual([]);
    expect(frames.pending()).toBe(1);

    chart.setData({
      x: new Float64Array([1, 2]),
      y: new Float64Array([10, 20]),
      length: 2,
    });

    expect(messages.map((message) => message.type)).toEqual([
      "viewportInputBatch",
      "setData",
      "start",
    ]);
    expect(frames.pending()).toBe(0);
    chart.destroy();
  });
});

describe("LineChart construction lifecycle", () => {
  it("rejects malformed construction labels before selecting a renderer", () => {
    const selectRenderer = vi.spyOn(BaseChart as any, "selectChartRenderer");

    expect(
      () =>
        new LineChart(createCanvas(), {
          labels: { top: "Quarterly revenue" } as never,
        }),
    ).toThrow("Invalid labels");
    expect(selectRenderer).toHaveReturnedTimes(0);
  });

  it("terminates a renderer that reports failure during base construction", async () => {
    const terminate = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const worker: ChartWorkerLike = {
      onmessage: null,
      postMessage(message) {
        if ((message as { type?: string }).type === "init") {
          this.onmessage?.(
            new MessageEvent("message", {
              data: { type: "initError", error: { message: "synchronous init failure" } },
            }),
          );
        }
      },
      terminate,
    };
    vi.spyOn(BaseChart as any, "selectChartRenderer").mockReturnValue({
      renderer: () => worker,
      useWorker: false,
      resolvedRenderMode: "main",
    });

    const canvas = createCanvas();
    const addEventListener = vi.spyOn(canvas, "addEventListener");
    const chart = new LineChart(canvas, { legend: { interactive: true } });

    await expect(chart.initialize()).rejects.toMatchObject({
      name: "ChartRendererError",
      phase: "initialization",
      message: "synchronous init failure",
    });
    expect(terminate).toHaveBeenCalledOnce();
    expect(addEventListener.mock.calls.filter(([type]) => type === "click")).toHaveLength(0);
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ChartRendererError",
        phase: "initialization",
        message: "synchronous init failure",
      }),
    );
  });
});

describe("LineChart runtime tooltip appearance", () => {
  it("updates the callback and visible-series filter", () => {
    const chart = new LineChart(createCanvas(), { renderMode: "main" });
    const rows: string[][] = [];
    const onRender = vi.fn((params) => {
      rows.push(params.defaults.rows.map((row: { label: string }) => row.label));
      return { visible: false as const };
    });

    chart.updateAppearance({
      tooltip: { onRender, visibleSeries: [1] },
    });
    (chart as any).handleWorkerMessage({
      data: {
        type: "tooltipData",
        params: {
          dataX: 10,
          screenX: 100,
          screenY: 80,
          series: [
            { index: 0, name: "First", value: 1, formattedValue: "1", color: "red" },
            { index: 1, name: "Second", value: 2, formattedValue: "2", color: "blue" },
          ],
        },
        defaultTitle: "10",
      },
    });

    expect(onRender).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([["Second"]]);
    chart.destroy();
  });
});

describe("LineChart runtime legend interaction", () => {
  it("enables and disables the legend click listener", () => {
    const canvas = createCanvas();
    const chart = new LineChart(canvas, { renderMode: "main" });
    const postMessage = vi.fn();
    (chart as any).worker = {
      postMessage,
      terminate: vi.fn(),
      onmessage: null,
    };

    chart.updateAppearance({ legend: { interactive: true } });
    postMessage.mockClear();
    canvas.dispatchEvent(new MouseEvent("click", { clientX: 120, clientY: 80 }));
    expect(postMessage).toHaveBeenCalledWith({
      type: "legendClick",
      x: 120,
      y: 80,
    });

    chart.updateAppearance({ legend: { interactive: false } });
    postMessage.mockClear();
    canvas.dispatchEvent(new MouseEvent("click", { clientX: 120, clientY: 80 }));
    expect(postMessage).not.toHaveBeenCalled();

    chart.destroy();
  });
});

describe("LineChart runtime series appearance", () => {
  it("snapshots recursively frozen series patches", () => {
    const chart = new LineChart(createCanvas(), { renderMode: "main" });
    const postMessage = vi.fn();
    (chart as any).worker = {
      postMessage,
      terminate: vi.fn(),
      onmessage: null,
    };
    const glow = Object.freeze({ color: "#abcdef", blur: 12, opacity: 0.5 });
    const patch = Object.freeze({
      marker: Object.freeze({ shape: "circle" as const, glow }),
    });

    chart.updateSeriesAppearance(0, patch);

    expect(postMessage).toHaveBeenCalledTimes(1);
    const message = postMessage.mock.calls[0]?.[0];
    expect(message.patch).not.toBe(patch);
    expect(message.patch.marker.glow).not.toBe(glow);
    expect(Object.isFrozen(message.patch.marker.glow)).toBe(false);

    message.patch.marker.glow.blur = 4;
    expect(glow.blur).toBe(12);
    chart.destroy();
  });
});

describe("LineChart runtime LOD tuning", () => {
  it("uses the denser public presentation default", () => {
    const chart = new LineChart(createCanvas(), { renderMode: "main" });

    expect(chart.getOptions().lod).toEqual({
      mode: "adaptive",
      density: 0.75,
      rebaseRatio: 1.25,
      quantizationStep: 0.25,
    });
    chart.destroy();
  });

  it("updates the renderer and normalized option shadow", () => {
    const chart = new LineChart(createCanvas(), { renderMode: "main" });
    const postMessage = vi.fn();
    (chart as any).worker = {
      postMessage,
      terminate: vi.fn(),
      onmessage: null,
    };

    chart.setLODOptions({
      density: 1,
      rebaseRatio: 1.15,
      quantizationStep: 0.1,
    });

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "setLODConfig",
        lod: {
          density: 1,
          rebaseRatio: 1.15,
          quantizationStep: 0.1,
        },
      },
      undefined,
    );
    expect(chart.getOptions().lod).toEqual({
      mode: "adaptive",
      density: 1,
      rebaseRatio: 1.15,
      quantizationStep: 0.1,
    });
    chart.destroy();
  });
});
