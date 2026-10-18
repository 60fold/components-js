import { Activity, act, type ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
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
});

async function render(element: ReactElement): Promise<void> {
  await act(async () => root.render(element));
}

describe.each(["line", "stock"] as const)("React %s chart lifetime boundaries", (kind) => {
  const ChartType = kind === "line" ? FakeLineChart : FakeStockChart;
  const Chart = kind === "line" ? SixtyfoldLineChart : SixtyfoldStockChart;
  const activity = (mode: "visible" | "hidden", onError?: (error: unknown) => void) => (
    <Activity mode={mode}>
      <Chart onError={onError} />
    </Activity>
  );

  it("stops reconnecting if a queued error callback synchronously removes the chart", async () => {
    const first = new Error("first hidden overlay failure");
    const second = new Error("second hidden overlay failure");
    const onError = vi.fn(() => {
      flushSync(() => root.render(null));
    });
    await render(activity("visible", onError));
    const chart = lastChart(ChartType);
    await act(async () => chart.becomeReady());
    await render(activity("hidden", onError));
    act(() => {
      chart.failOverlay(first);
      chart.failOverlay(second);
    });
    expect(onError).not.toHaveBeenCalled();

    await render(activity("visible", onError));

    expect(onError).toHaveBeenCalledExactlyOnceWith(first);
    expect(ChartType.instances).toHaveLength(1);
    expect(chart.callsTo("destroy")).toHaveLength(1);
    expect(container.querySelector("canvas")).toBeNull();
    expect(chart.methodOrder.at(-1)).toBe("destroy");
  });

  it("retains undelivered errors if a queued error callback synchronously hides the chart again", async () => {
    const first = new Error("first hidden overlay failure");
    const second = new Error("second hidden overlay failure");
    const onError = vi.fn((error: unknown) => {
      if (error === first) flushSync(() => root.render(activity("hidden", onError)));
    });
    await render(activity("visible", onError));
    const chart = lastChart(ChartType);
    await act(async () => chart.becomeReady());
    await render(activity("hidden", onError));
    act(() => {
      chart.failOverlay(first);
      chart.failOverlay(second);
    });

    await render(activity("visible", onError));

    expect(onError).toHaveBeenCalledExactlyOnceWith(first);
    expect(ChartType.instances).toHaveLength(1);
    expect(chart.destroyed).toBe(false);
    expect(chart.statsCallback).toBeNull();
    await render(activity("visible", onError));
    expect(onError.mock.calls.map(([error]) => error)).toEqual([first, second]);
    expect(ChartType.instances).toHaveLength(1);
  });

  it("retains a chart in a detached React root until its actual hidden unmount", async () => {
    container.remove();
    await render(activity("visible"));
    const chart = lastChart(ChartType);
    await act(async () => chart.becomeReady());
    expect(chart.canvas.isConnected).toBe(false);
    await render(activity("hidden"));
    expect(chart.destroyed).toBe(false);
    await render(activity("visible"));
    expect(ChartType.instances).toHaveLength(1);
    await render(activity("hidden"));
    await act(async () => root.render(null));
    expect(chart.callsTo("destroy")).toHaveLength(1);
  });

  it("cancels deferred construction when the component is removed before its microtask runs", async () => {
    await act(async () => {
      flushSync(() => root.render(<Chart />));
      flushSync(() => root.render(null));
    });
    expect(ChartType.instances).toHaveLength(0);
  });

  it("renders an SSR canvas without constructing a chart or invoking callbacks", () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const html = renderToString(
      <Chart aria-label="Server chart" onReady={onReady} onError={onError} />,
    );
    expect(html).toContain("<canvas");
    expect(html).toContain('aria-label="Server chart"');
    expect(ChartType.instances).toHaveLength(0);
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
