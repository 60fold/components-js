import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeLineChart,
  FakeStockChart,
  lastChart,
  resetFakeCharts,
} from "@test/support/chartDoubles.js";

vi.mock("@sixtyfold/line", () => ({ LineChart: FakeLineChart }));
vi.mock("@sixtyfold/stock", () => ({ StockChart: FakeStockChart }));

const { SixtyfoldLineChart } = await import("../src/line.js");
const { SixtyfoldStockChart } = await import("../src/stock.js");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetFakeCharts();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function render(element: ReactElement): Promise<void> {
  await act(async () => root.render(element));
}

describe.each(["line", "stock"] as const)("React %s initial prop recovery", (kind) => {
  const ChartType = kind === "line" ? FakeLineChart : FakeStockChart;
  const Chart = kind === "line" ? SixtyfoldLineChart : SixtyfoldStockChart;

  it("recovers from a rejected initial dataset when a new dataset arrives", async () => {
    const onError = vi.fn();
    const onReady = vi.fn();
    const withData = (value: number) =>
      kind === "line" ? (
        <SixtyfoldLineChart
          data={{ x: new Float64Array([0]), y: new Float64Array([value]), length: 1 }}
          onError={onError}
          onReady={onReady}
        />
      ) : (
        <SixtyfoldStockChart
          data={{
            timestamp: new Float64Array([0]),
            open: new Float64Array([value]),
            high: new Float64Array([value]),
            low: new Float64Array([value]),
            close: new Float64Array([value]),
            volume: new Float64Array([1]),
            length: 1,
          }}
          onError={onError}
          onReady={onReady}
        />
      );
    await render(withData(1));
    const chart = lastChart(ChartType);
    const failure = new Error("initial dataset rejected");
    vi.spyOn(chart, "setData").mockImplementationOnce(() => {
      throw failure;
    });
    await act(async () => chart.becomeReady());
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(onReady).not.toHaveBeenCalled();

    await render(withData(2));

    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
    expect(ChartType.instances).toHaveLength(1);
  });

  it.each(["updateAppearance", "setViewport"] as const)(
    "delivers onReady only after a rejected %s recovers on a later prop batch",
    async (method) => {
      const onError = vi.fn();
      const onReady = vi.fn();
      const appearance = { grid: { color: "#111111" } };
      const viewport = { xMin: 0, xMax: 10 };
      await render(
        <Chart appearance={appearance} viewport={viewport} onError={onError} onReady={onReady} />,
      );
      const chart = lastChart(ChartType);
      const failure = new Error("initial prop rejected");
      vi.spyOn(chart, method).mockImplementationOnce(() => {
        throw failure;
      });
      await act(async () => chart.becomeReady());

      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(onReady).not.toHaveBeenCalled();
      expect(chart.destroyed).toBe(false);

      await render(
        <Chart
          appearance={{ grid: { color: "#222222" } }}
          viewport={{ xMin: 2, xMax: 8 }}
          onError={onError}
          onReady={onReady}
        />,
      );
      expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
      expect(chart.callsTo("setViewport").at(-1)?.args[0]).toEqual({ xMin: 2, xMax: 8 });
      expect(chart.callsTo("updateAppearance").at(-1)?.args[0]).toEqual({
        grid: { color: "#222222" },
      });
      expect(ChartType.instances).toHaveLength(1);

      await render(<Chart appearance={appearance} onError={onError} onReady={onReady} />);
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
    },
  );

  it("routes later prop failures through onError without repeating a successful onReady", async () => {
    const onError = vi.fn();
    const onReady = vi.fn();
    await render(<Chart onError={onError} onReady={onReady} />);
    const chart = lastChart(ChartType);
    await act(async () => chart.becomeReady());
    const failure = new Error("updated prop rejected");
    vi.spyOn(chart, "updateAppearance").mockImplementationOnce(() => {
      throw failure;
    });

    await render(
      <Chart appearance={{ grid: { color: "#111111" } }} onError={onError} onReady={onReady} />,
    );
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
    await render(
      <Chart appearance={{ grid: { color: "#222222" } }} onError={onError} onReady={onReady} />,
    );
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(ChartType.instances).toHaveLength(1);
  });

  it("does not recover a pending onReady after a terminal renderer failure", async () => {
    const onError = vi.fn();
    const onReady = vi.fn();
    await render(
      <Chart appearance={{ grid: { color: "#111111" } }} onError={onError} onReady={onReady} />,
    );
    const chart = lastChart(ChartType);
    const propFailure = new Error("initial prop rejected");
    vi.spyOn(chart, "updateAppearance").mockImplementationOnce(() => {
      throw propFailure;
    });
    await act(async () => chart.becomeReady());
    const rendererFailure = new Error("renderer terminated");
    act(() => chart.failRuntime(rendererFailure));

    await render(
      <Chart appearance={{ grid: { color: "#222222" } }} onError={onError} onReady={onReady} />,
    );

    expect(onError.mock.calls.map(([error]) => error)).toEqual([propFailure, rendererFailure]);
    expect(onReady).not.toHaveBeenCalled();
    expect(chart.callsTo("updateAppearance")).toHaveLength(0);
  });

  it("ignores initialization resolution if the renderer fails before its continuation", async () => {
    const onError = vi.fn();
    const onReady = vi.fn();
    await render(
      <Chart appearance={{ grid: { color: "#111111" } }} onError={onError} onReady={onReady} />,
    );
    const chart = lastChart(ChartType);
    const failure = new Error("renderer terminated just after initialization");
    await act(async () => {
      chart.becomeReady();
      chart.failRuntime(failure);
    });

    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(onReady).not.toHaveBeenCalled();
    expect(chart.callsTo("updateAppearance")).toHaveLength(0);
  });
});
