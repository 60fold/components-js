import * as React from "react";
import { StrictMode, Suspense, act, type ReactElement } from "react";
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
});

async function render(element: ReactElement | null): Promise<void> {
  await act(async () => root.render(element));
}

const neverResolves = new Promise<void>(() => {});

function Suspend({ suspended }: { suspended: boolean }) {
  if (suspended) throw neverResolves;
  return null;
}

it("runs against the supported React 18 runtime, not an Activity-capable alias", () => {
  expect(React.version).toBe("18.3.1");
  expect(typeof React.Activity).toBe("undefined");
});

describe.each(["line", "stock"] as const)("React 18 %s chart lifetime", (kind) => {
  const ChartType = kind === "line" ? FakeLineChart : FakeStockChart;
  const Chart = kind === "line" ? SixtyfoldLineChart : SixtyfoldStockChart;
  const harness = (suspended: boolean, onError = vi.fn(), onReady = vi.fn()) => (
    <StrictMode>
      <Suspense fallback={<span>Loading</span>}>
        <Chart onError={onError} onReady={onReady} />
        <Suspend suspended={suspended} />
      </Suspense>
    </StrictMode>
  );

  it("destroys an already-hidden Suspense chart exactly once on unmount", async () => {
    await render(harness(false));
    const chart = lastChart(ChartType);
    await act(async () => chart.becomeReady());
    expect(ChartType.instances).toHaveLength(1);

    await render(harness(true));
    expect(chart.canvas.style.display).toBe("none");
    expect(chart.destroyed).toBe(false);
    await render(null);

    expect(chart.callsTo("destroy")).toHaveLength(1);
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("destroys a hidden chart that has not finished initialization without reporting an error", async () => {
    const onError = vi.fn();
    const onReady = vi.fn();
    await render(harness(false, onError, onReady));
    const chart = lastChart(ChartType);
    await render(harness(true, onError, onReady));
    expect(chart.canvas.style.display).toBe("none");
    await render(null);

    expect(chart.callsTo("destroy")).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("keeps the same chart through Suspense hide/reveal and cleans up a visible unmount", async () => {
    const onError = vi.fn();
    const onReady = vi.fn();
    await render(harness(false, onError, onReady));
    const chart = lastChart(ChartType);
    await act(async () => chart.becomeReady());
    for (let cycle = 0; cycle < 2; cycle++) {
      await render(harness(true, onError, onReady));
      await render(harness(false, onError, onReady));
      expect(chart.destroyed).toBe(false);
      expect(lastChart(ChartType)).toBe(chart);
    }
    expect(ChartType.instances).toHaveLength(1);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
    await render(null);
    expect(chart.callsTo("destroy")).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
