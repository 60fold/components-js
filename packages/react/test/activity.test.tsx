import { Activity, StrictMode, act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChart, lastChart } from "@test/support/chartDoubles.js";
import type { TimeSeriesData } from "@sixtyfold/core";
import type { OHLCVData } from "@sixtyfold/stock";
import type { LineChartHandle } from "../src/line.js";
import type { StockChartHandle } from "../src/stock.js";

/** Simulate worker ownership without constructing a browser renderer. */
class TransferringChart extends FakeChart {
  readonly receivedData: unknown[] = [];

  private transfer(data: unknown): void {
    const values = Object.values(data as Record<string, unknown>).flat();
    const buffers = [
      ...new Set(
        values.filter((value) => value instanceof Float64Array).map((value) => value.buffer),
      ),
    ];
    if (buffers.some((buffer) => buffer.byteLength === 0)) {
      throw new Error("A previously transferred chart dataset was installed again.");
    }
    this.receivedData.push(structuredClone(data, { transfer: buffers }));
  }

  override setData(data: unknown, options?: unknown): void {
    super.setData(data, options);
    this.transfer(data);
  }

  override setMultiSeriesData(data: unknown, options?: unknown): void {
    super.setMultiSeriesData(data, options);
    this.transfer(data);
  }
}

class TransferringLineChart extends TransferringChart {
  static override instances: FakeChart[] = [];
}

class TransferringStockChart extends TransferringChart {
  static override instances: FakeChart[] = [];
}

vi.mock("@sixtyfold/line", () => ({ LineChart: TransferringLineChart }));
vi.mock("@sixtyfold/stock", () => ({ StockChart: TransferringStockChart }));

const { SixtyfoldLineChart } = await import("../src/line.js");
const { SixtyfoldStockChart } = await import("../src/stock.js");

type ChartKind = "line" | "stock";
type Dataset = TimeSeriesData | OHLCVData;
type Handle = LineChartHandle | StockChartHandle;

function createData(kind: ChartKind): Dataset {
  if (kind === "line") {
    return { x: new Float64Array([0, 1]), y: new Float64Array([2, 3]), length: 2 };
  }
  return {
    timestamp: new Float64Array([0, 1]),
    open: new Float64Array([1, 2]),
    high: new Float64Array([2, 3]),
    low: new Float64Array([0, 1]),
    close: new Float64Array([1.5, 2.5]),
    volume: new Float64Array([10, 20]),
    length: 2,
  };
}

function dataBuffer(data: Dataset): ArrayBufferLike {
  return "x" in data ? data.x.buffer : data.timestamp.buffer;
}

interface TestProps {
  data?: Dataset;
  appearance?: { grid: { color: string } };
  viewport?: { xMin: number; xMax: number };
  onReady?: (chart: unknown) => void;
  onError?: (error: unknown) => void;
  onStats?: (stats: unknown) => void;
  statsIntervalMs?: number;
  ref?: (handle: Handle | null) => void;
}

function renderChart(kind: ChartKind, props: TestProps): ReactElement {
  const { data, ...shared } = props;
  return kind === "line" ? (
    <SixtyfoldLineChart {...shared} data={data as TimeSeriesData | undefined} />
  ) : (
    <SixtyfoldStockChart {...shared} data={data as OHLCVData | undefined} />
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  TransferringLineChart.instances = [];
  TransferringStockChart.instances = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(element: ReactElement): Promise<void> {
  await act(async () => root.render(element));
}

async function unmount(): Promise<void> {
  await act(async () => root.unmount());
  root = createRoot(container);
}

describe.each(["line", "stock"] as const)("React Activity %s chart lifecycle", (kind) => {
  const ChartType = kind === "line" ? TransferringLineChart : TransferringStockChart;
  const getChart = () => lastChart(ChartType) as TransferringChart;
  const activity = (mode: "visible" | "hidden", props: TestProps) => (
    <Activity mode={mode}>{renderChart(kind, props)}</Activity>
  );

  it("retains its chart and canvas across repeated hide/show without replaying transferred data", async () => {
    const data = createData(kind);
    const onReady = vi.fn();
    const onError = vi.fn();
    let handle: Handle | null = null;
    const ref = (next: Handle | null) => {
      handle = next;
    };
    const props = { data, onReady, onError, ref };
    await render(activity("visible", props));
    const chart = getChart();
    const canvas = chart.canvas;
    await act(async () => chart.becomeReady());
    expect(dataBuffer(data).byteLength).toBe(0);
    expect(chart.callsTo("setData")[0]?.args[0]).toBe(data);
    expect(chart.receivedData).toHaveLength(1);

    for (let cycle = 0; cycle < 3; cycle++) {
      const visibleHandle = handle as Handle | null;
      await render(activity("hidden", props));
      expect(handle).toBeNull();
      expect(visibleHandle?.chart).toBeNull();
      expect(chart.destroyed).toBe(false);
      expect(container.querySelector("canvas")).toBe(canvas);
      await render(activity("visible", props));
      expect(getChart()).toBe(chart);
      expect((handle as Handle | null)?.chart).toBe(chart);
      expect(container.querySelector("canvas")).toBe(canvas);
    }

    expect(ChartType.instances).toHaveLength(1);
    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
    expect(onError).not.toHaveBeenCalled();
    await unmount();
    expect(chart.callsTo("destroy")).toHaveLength(1);
    expect(handle).toBeNull();
  });

  it("installs only the newest props on reveal and keeps hidden datasets untransferred", async () => {
    const initialData = createData(kind);
    const skippedData = createData(kind);
    const newestData = createData(kind);
    const initialAppearance = { grid: { color: "#111111" } };
    const newestAppearance = { grid: { color: "#333333" } };
    const initialViewport = { xMin: 0, xMax: 1 };
    const newestViewport = { xMin: 1, xMax: 2 };
    await render(
      activity("visible", {
        data: initialData,
        appearance: initialAppearance,
        viewport: initialViewport,
      }),
    );
    const chart = getChart();
    await act(async () => chart.becomeReady());
    await render(
      activity("hidden", {
        data: skippedData,
        appearance: { grid: { color: "#222222" } },
        viewport: { xMin: 0, xMax: 2 },
      }),
    );
    const newest = { data: newestData, appearance: newestAppearance, viewport: newestViewport };
    await render(activity("hidden", newest));

    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(chart.callsTo("updateAppearance")).toHaveLength(1);
    expect(chart.callsTo("setViewport")).toHaveLength(1);
    expect(dataBuffer(skippedData).byteLength).toBeGreaterThan(0);
    expect(dataBuffer(newestData).byteLength).toBeGreaterThan(0);
    await render(activity("visible", newest));

    expect(getChart()).toBe(chart);
    expect(chart.callsTo("setData")).toHaveLength(2);
    expect(chart.callsTo("setData")[1]?.args[0]).toBe(newestData);
    expect(chart.callsTo("updateAppearance")[1]?.args[0]).toBe(newestAppearance);
    expect(chart.callsTo("setViewport")[1]?.args[0]).toBe(newestViewport);
    expect(dataBuffer(newestData).byteLength).toBe(0);
    expect(dataBuffer(skippedData).byteLength).toBeGreaterThan(0);
    expect(
      chart.calls
        .filter((call) => ["setData", "updateAppearance", "setViewport"].includes(call.method))
        .every((call) => call.inBatch),
    ).toBe(true);
    await render(activity("hidden", newest));
    await render(activity("visible", newest));
    expect(chart.callsTo("setData")).toHaveLength(2);
    expect(chart.callsTo("updateAppearance")).toHaveLength(2);
    expect(chart.callsTo("setViewport")).toHaveLength(2);
  });

  it("defers readiness and installation if initialization completes while hidden", async () => {
    const data = createData(kind);
    const initialOnReady = vi.fn();
    const onReady = vi.fn();
    const props = { data, onReady };
    await render(activity("visible", { data, onReady: initialOnReady }));
    const chart = getChart();
    await render(activity("hidden", props));
    await act(async () => chart.becomeReady());
    expect(onReady).not.toHaveBeenCalled();
    expect(chart.callsTo("setData")).toHaveLength(0);
    expect(dataBuffer(data).byteLength).toBeGreaterThan(0);

    await render(activity("visible", props));
    expect(getChart()).toBe(chart);
    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(dataBuffer(data).byteLength).toBe(0);
    expect(initialOnReady).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
  });

  it("reports an initialization failure that occurs while hidden once on reveal", async () => {
    const data = createData(kind);
    const onReady = vi.fn();
    const initialOnError = vi.fn();
    const onError = vi.fn();
    await render(activity("visible", { data, onReady, onError: initialOnError }));
    const chart = getChart();
    const props = { data, onReady, onError };
    await render(activity("hidden", props));
    const error = new Error("worker initialization failed while hidden");
    await act(async () => chart.failInitialization(error));
    expect(initialOnError).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    await render(activity("visible", props));
    expect(getChart()).toBe(chart);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(initialOnError).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(chart.callsTo("setData")).toHaveLength(0);
    expect(dataBuffer(data).byteLength).toBeGreaterThan(0);
    await render(activity("hidden", props));
    await render(activity("visible", props));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("drains hidden errors when the next visible render has no error listener", async () => {
    const previousOnError = vi.fn();
    const nextOnError = vi.fn();
    const onReady = vi.fn();
    await render(activity("visible", { onReady, onError: previousOnError }));
    const chart = getChart();
    await act(async () => chart.becomeReady());
    await render(activity("hidden", { onReady, onError: previousOnError }));
    act(() => chart.failOverlay(new Error("hidden overlay failure")));
    await render(activity("visible", { onReady }));
    expect(getChart()).toBe(chart);
    expect(previousOnError).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
    await render(activity("hidden", { onReady, onError: nextOnError }));
    await render(activity("visible", { onReady, onError: nextOnError }));
    expect(nextOnError).not.toHaveBeenCalled();
  });

  it("does not construct an initially hidden chart until its first reveal", async () => {
    const data = createData(kind);
    const onReady = vi.fn();
    await render(activity("hidden", { data, onReady }));
    expect(ChartType.instances).toHaveLength(0);
    expect(onReady).not.toHaveBeenCalled();
    expect(dataBuffer(data).byteLength).toBeGreaterThan(0);
    await render(activity("visible", { data, onReady }));
    const chart = getChart();
    await act(async () => chart.becomeReady());
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
    expect(dataBuffer(data).byteLength).toBe(0);
  });

  it("pauses callbacks and stats while hidden, then uses the current callbacks", async () => {
    const onStats = vi.fn();
    const onError = vi.fn();
    const nextOnStats = vi.fn();
    const nextOnError = vi.fn();
    await render(activity("visible", { onStats, onError }));
    const chart = getChart();
    await act(async () => chart.becomeReady());
    const oldStatsCallback = chart.statsCallback;
    const oldErrorCallback = chart.overlayErrorCallback;
    const hiddenError = new Error("late hidden callback");
    await render(activity("hidden", { onStats: nextOnStats, onError: nextOnError }));
    expect(chart.statsCallback).toBeNull();
    act(() => {
      oldStatsCallback?.({ fps: 60 });
      oldErrorCallback?.(hiddenError);
    });
    expect(onStats).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(nextOnStats).not.toHaveBeenCalled();
    expect(nextOnError).not.toHaveBeenCalled();
    await render(
      activity("visible", { onStats: nextOnStats, onError: nextOnError, statsIntervalMs: 500 }),
    );
    const error = new Error("visible overlay callback");
    act(() => {
      chart.statsCallback?.({ fps: 59 });
      chart.overlayErrorCallback?.(error);
    });
    expect(nextOnStats).toHaveBeenCalledExactlyOnceWith({ fps: 59 });
    expect(nextOnError).toHaveBeenCalledTimes(2);
    expect(nextOnError).toHaveBeenNthCalledWith(1, hiddenError);
    expect(nextOnError).toHaveBeenNthCalledWith(2, error);
    expect(onError).not.toHaveBeenCalled();
    expect(chart.callsTo("setStatsCallback").at(-1)?.args[1]).toEqual({ intervalMs: 500 });
  });

  it("destroys a hidden chart exactly once on actual unmount", async () => {
    await render(activity("visible", {}));
    const chart = getChart();
    await act(async () => chart.becomeReady());
    await render(activity("hidden", {}));
    expect(chart.callsTo("destroy")).toHaveLength(0);
    await unmount();
    expect(chart.callsTo("destroy")).toHaveLength(1);
    expect(ChartType.instances).toHaveLength(1);
  });

  it("silences initialization when unmounted before readiness, including while hidden", async () => {
    const data = createData(kind);
    const onReady = vi.fn();
    const onError = vi.fn();
    await render(activity("visible", { data, onReady, onError }));
    const chart = getChart();
    await render(activity("hidden", { data, onReady, onError }));
    await unmount();
    await act(async () => chart.becomeReady());
    expect(chart.callsTo("destroy")).toHaveLength(1);
    expect(chart.callsTo("setData")).toHaveLength(0);
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(dataBuffer(data).byteLength).toBeGreaterThan(0);
  });

  it("constructs and transfers only once in StrictMode, including Activity reconnects", async () => {
    const data = createData(kind);
    const onReady = vi.fn();
    const content = (mode: "visible" | "hidden") => (
      <StrictMode>{activity(mode, { data, onReady })}</StrictMode>
    );
    await render(content("visible"));
    expect(ChartType.instances).toHaveLength(1);
    const chart = getChart();
    await act(async () => chart.becomeReady());
    await render(content("hidden"));
    await render(content("visible"));
    expect(ChartType.instances).toHaveLength(1);
    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
    await unmount();
    expect(chart.callsTo("destroy")).toHaveLength(1);
  });
});

describe("React Activity line-specific lifecycle", () => {
  it("retains a transferred multi-series dataset without copying or replaying it", async () => {
    const data = {
      x: new Float64Array([0, 1]),
      series: [new Float64Array([2, 3]), new Float64Array([4, 5])],
      length: 2,
      seriesCount: 2,
    };
    const dataUpdateOptions = { preservePreviousFrame: true };
    const content = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <SixtyfoldLineChart data={data} dataUpdateOptions={dataUpdateOptions} />
      </Activity>
    );
    await render(content("visible"));
    const chart = lastChart(TransferringLineChart) as TransferringChart;
    await act(async () => chart.becomeReady());
    expect(data.x.byteLength).toBe(0);
    expect(data.series.every((series) => series.byteLength === 0)).toBe(true);
    await render(content("hidden"));
    await render(content("visible"));

    expect(TransferringLineChart.instances).toHaveLength(1);
    expect(chart.callsTo("setData")).toHaveLength(0);
    expect(chart.callsTo("setMultiSeriesData")).toHaveLength(1);
    expect(chart.callsTo("setMultiSeriesData")[0]?.args[0]).toBe(data);
    expect(chart.callsTo("setMultiSeriesData")[0]?.args[1]).toBe(dataUpdateOptions);
    expect(chart.receivedData).toHaveLength(1);
    const received = chart.receivedData[0] as typeof data;
    expect(Array.from(received.x)).toEqual([0, 1]);
    expect(received.series.map((series) => Array.from(series))).toEqual([
      [2, 3],
      [4, 5],
    ]);
    expect(received.length).toBe(2);
    expect(received.seriesCount).toBe(2);
  });

  it("pauses series-visibility callbacks while hidden and reconnects to the current listener", async () => {
    const firstCallback = vi.fn();
    const nextCallback = vi.fn();
    const content = (
      mode: "visible" | "hidden",
      onSeriesVisibilityChange: typeof firstCallback,
    ) => (
      <Activity mode={mode}>
        <SixtyfoldLineChart onSeriesVisibilityChange={onSeriesVisibilityChange} />
      </Activity>
    );
    await render(content("visible", firstCallback));
    const chart = lastChart(TransferringLineChart);
    await act(async () => chart.becomeReady());
    const event = { seriesIndex: 0, visible: false };
    act(() => chart.seriesVisibilityCallback?.(event));
    expect(firstCallback).toHaveBeenCalledExactlyOnceWith(event);
    await render(content("hidden", nextCallback));
    act(() => chart.seriesVisibilityCallback?.(event));
    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(nextCallback).not.toHaveBeenCalled();
    await render(content("visible", nextCallback));
    act(() => chart.seriesVisibilityCallback?.(event));
    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(nextCallback).toHaveBeenCalledExactlyOnceWith(event);
  });
});
