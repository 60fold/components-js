import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeLineChart,
  FakeStockChart,
  lastChart,
  resetFakeCharts,
  type FakeChart,
  type RecordedCall,
} from "@test/support/chartDoubles.js";

vi.mock("@sixtyfold/line", () => ({ LineChart: FakeLineChart }));
vi.mock("@sixtyfold/stock", () => ({ StockChart: FakeStockChart }));

const LineChartComponent = (await import("../src/line.svelte")).default;
const StockChartComponent = (await import("../src/stock.svelte")).default;

type Kind = "line" | "stock";
type Props = Record<string, unknown>;

let container: HTMLDivElement;
let component: Record<string, unknown> | null = null;
const props: Props = $state({});

function render(kind: Kind, initial: Props = {}): FakeChart {
  for (const key of Object.keys(props)) delete props[key];
  Object.assign(props, initial);
  component =
    kind === "line"
      ? mount(LineChartComponent, { target: container, props })
      : mount(StockChartComponent, { target: container, props });
  flushSync();
  return lastChart(kind === "line" ? FakeLineChart : FakeStockChart);
}

function setProps(next: Props): void {
  Object.assign(props, next);
  flushSync();
}

async function becomeReady(chart: FakeChart): Promise<void> {
  chart.becomeReady();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

function dataFor(kind: Kind, offset = 0) {
  if (kind === "line") {
    return { x: new Float64Array([0, 1]), y: new Float64Array([2 + offset, 3 + offset]) };
  }
  return {
    timestamp: new Float64Array([0, 1]),
    open: new Float64Array([1 + offset, 2 + offset]),
    high: new Float64Array([2 + offset, 3 + offset]),
    low: new Float64Array([offset, 1 + offset]),
    close: new Float64Array([1.5 + offset, 2.5 + offset]),
    volume: new Float64Array([10, 20]),
    length: 2,
  };
}

function appliedCalls(chart: FakeChart): RecordedCall[] {
  return chart.calls.filter((call) =>
    ["setData", "setMultiSeriesData", "updateAppearance", "setViewport"].includes(call.method),
  );
}

beforeEach(() => {
  resetFakeCharts();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (component) void unmount(component);
  component = null;
  container.remove();
  vi.restoreAllMocks();
});

describe.each(["line", "stock"] as const)("%s.svelte readiness", (kind) => {
  it.each(["after rejected initial props", "before the initialization reaction"] as const)(
    "does not publish readiness after a terminal renderer failure %s",
    async (timing) => {
      const onReady = vi.fn();
      const onError = vi.fn();
      const chart = render(kind, { data: dataFor(kind), onReady, onError });
      const install = vi.spyOn(chart, "setData");
      const propError = new Error("invalid initial data");
      if (timing === "after rejected initial props") {
        install.mockImplementationOnce(() => {
          throw propError;
        });
        await becomeReady(chart);
        expect(onError).toHaveBeenCalledExactlyOnceWith(propError);
      } else {
        chart.becomeReady();
      }
      const failure = new Error("terminal renderer failure");
      chart.failRuntime(failure);
      await Promise.resolve();
      await Promise.resolve();
      flushSync();

      setProps({ data: dataFor(kind, 100) });

      expect(install).toHaveBeenCalledTimes(timing === "after rejected initial props" ? 1 : 0);
      expect(chart.callsTo("setData")).toHaveLength(0);
      expect(onReady).not.toHaveBeenCalled();
      expect(onError).toHaveBeenLastCalledWith(failure);
      expect(onError).toHaveBeenCalledTimes(timing === "after rejected initial props" ? 2 : 1);
    },
  );

  it("reports a throwing readiness callback without notifying readiness again", async () => {
    const failure = new Error("readiness callback failed");
    const onReady = vi.fn(() => {
      throw failure;
    });
    const onError = vi.fn();
    const chart = render(kind, { data: dataFor(kind), onReady, onError });

    await becomeReady(chart);

    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(chart.callsTo("setData")).toHaveLength(1);
    setProps({ appearance: { grid: { visible: false } } });
    expect(onReady).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(chart.callsTo("updateAppearance")).toHaveLength(1);
  });

  it("does not reinstall transferred data when a later initial prop fails", async () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const chart = render(kind, { data: dataFor(kind), appearance: {}, onReady, onError });
    vi.spyOn(chart, "updateAppearance").mockImplementationOnce(() => {
      throw new Error("invalid appearance");
    });
    await becomeReady(chart);
    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    setProps({ appearance: { grid: { color: "#123456" } } });
    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
  });

  it("recovers from initial prop errors and notifies readiness only after a successful batch", async () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const chart = render(kind, { data: dataFor(kind), onReady, onError });
    const error = new Error("invalid initial data");
    vi.spyOn(chart, "setData").mockImplementationOnce(() => {
      throw error;
    });
    await becomeReady(chart);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(onReady).not.toHaveBeenCalled();
    expect(chart.destroyed).toBe(false);
    const replacement = dataFor(kind, 100);
    setProps({ data: replacement });
    expect(chart.callsTo("setData").at(-1)?.args[0]).toBe(props.data);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
    setProps({ data: dataFor(kind, 200) });
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("installs initial props in one completed batch before calling onReady", async () => {
    let callsAtReady: RecordedCall[] = [];
    let batchesAtReady = 0;
    const onReady = vi.fn((instance: FakeChart) => {
      // Capture synchronously; the adapter reports callback errors through
      // onError, so asserting inside the callback could hide the regression.
      callsAtReady = appliedCalls(instance);
      batchesAtReady = batch.mock.calls.length;
    });
    const chart = render(kind, {
      data: dataFor(kind),
      appearance: { grid: { visible: false } },
      viewport: { xMin: 0, xMax: 5 },
      viewportAnimated: false,
      onReady,
    });
    const batch = vi.spyOn(chart, "batch");

    await becomeReady(chart);

    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
    expect(callsAtReady.map((call) => call.method)).toEqual([
      "setData",
      "updateAppearance",
      "setViewport",
    ]);
    expect(callsAtReady.every((call) => call.inBatch)).toBe(true);
    expect(batchesAtReady).toBe(1);
    expect(callsAtReady[0]?.args[0]).toBe(props.data);
    expect(callsAtReady[1]?.args[0]).toBe(props.appearance);
    expect(callsAtReady[2]?.args).toEqual([props.viewport, { animated: false }]);
    expect(appliedCalls(chart)).toEqual(callsAtReady);
  });

  it("uses the latest props and readiness callback received during initialization", async () => {
    const oldReady = vi.fn();
    let callsAtReady: RecordedCall[] = [];
    const latestReady = vi.fn((instance: FakeChart) => {
      callsAtReady = appliedCalls(instance);
    });
    const chart = render(kind, {
      data: dataFor(kind),
      appearance: { grid: { visible: true } },
      viewport: { xMin: 0, xMax: 5 },
      viewportAnimated: false,
      onReady: oldReady,
    });
    const oldData = props.data;

    setProps({
      data: dataFor(kind, 100),
      appearance: { grid: { visible: false } },
      viewport: { xMin: 1, xMax: 2 },
      viewportAnimated: true,
      onReady: latestReady,
    });
    expect(appliedCalls(chart)).toHaveLength(0);
    await becomeReady(chart);

    expect(oldReady).not.toHaveBeenCalled();
    expect(latestReady).toHaveBeenCalledExactlyOnceWith(chart);
    expect(callsAtReady).toHaveLength(3);
    expect(callsAtReady[0]?.args[0]).toBe(props.data);
    expect(callsAtReady[0]?.args[0]).not.toBe(oldData);
    expect(callsAtReady[1]?.args[0]).toBe(props.appearance);
    expect(callsAtReady[2]?.args).toEqual([props.viewport, { animated: true }]);
    expect(chart.callsTo("setData")).toHaveLength(1);
  });

  it("does not overwrite imperative data or viewport changes made in onReady", async () => {
    const overrideData = dataFor(kind, 100);
    const overrideViewport = { xMin: 10, xMax: 20 };
    const onReady = vi.fn((instance: FakeChart) => {
      instance.setData(overrideData);
      instance.setViewport(overrideViewport, { animated: false });
    });
    const chart = render(kind, {
      data: dataFor(kind),
      appearance: { grid: { visible: true } },
      viewport: { xMin: 0, xMax: 5 },
      onReady,
    });

    await becomeReady(chart);
    setProps({ appearance: { grid: { visible: false } } });

    expect(chart.callsTo("setData")).toHaveLength(2);
    expect(chart.callsTo("setData")[0]?.args[0]).toBe(props.data);
    expect(chart.callsTo("setData")[1]?.args[0]).toBe(overrideData);
    expect(chart.callsTo("setData")[1]?.inBatch).toBe(false);
    expect(chart.callsTo("setViewport")).toHaveLength(2);
    expect(chart.callsTo("setViewport")[0]?.args[0]).toBe(props.viewport);
    expect(chart.callsTo("setViewport")[1]?.args[0]).toBe(overrideViewport);
    expect(chart.callsTo("setViewport")[1]?.inBatch).toBe(false);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("keeps reporting rejected current props without publishing readiness", async () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const chart = render(kind, { data: dataFor(kind), onReady, onError });
    const failure = new Error("data installation rejected");
    const install = vi.spyOn(chart, "setData").mockImplementation(() => {
      throw failure;
    });

    await becomeReady(chart);
    setProps({ appearance: { grid: { visible: false } } });

    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenLastCalledWith(failure);
    expect(onReady).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledTimes(2);
    expect(chart.callsTo("updateAppearance")).toHaveLength(0);
  });

  it("does not publish readiness if initial installation unmounts the component", async () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const chart = render(kind, { data: dataFor(kind), onReady, onError });
    const install = chart.setData.bind(chart);
    vi.spyOn(chart, "setData").mockImplementation((...args) => {
      install(...args);
      if (component) void unmount(component);
      component = null;
    });

    await becomeReady(chart);

    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(chart.callsTo("destroy")).toHaveLength(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("allows absent initial props and installs subsequent props normally", async () => {
    let callsAtReady: RecordedCall[] = [];
    const onReady = vi.fn((instance: FakeChart) => {
      callsAtReady = appliedCalls(instance);
    });
    const chart = render(kind, { onReady, viewport: {} });

    await becomeReady(chart);

    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
    expect(callsAtReady).toHaveLength(0);
    expect(appliedCalls(chart)).toHaveLength(0);
    const batch = vi.spyOn(chart, "batch");
    setProps({
      data: dataFor(kind),
      appearance: { grid: { visible: false } },
      viewport: { xMin: 1, xMax: 2 },
    });

    const calls = appliedCalls(chart);
    expect(calls.map((call) => call.method)).toEqual([
      "setData",
      "updateAppearance",
      "setViewport",
    ]);
    expect(calls.every((call) => call.inBatch)).toBe(true);
    expect(batch).toHaveBeenCalledOnce();
    expect(calls[0]?.args[0]).toBe(props.data);
    expect(calls[2]?.args).toEqual([props.viewport, { animated: undefined }]);

    setProps({ data: dataFor(kind, 100), viewport: { xMin: 2, xMax: 3 } });

    expect(chart.callsTo("setData")).toHaveLength(2);
    expect(chart.callsTo("setData")[1]?.args[0]).toBe(props.data);
    expect(chart.callsTo("setViewport")).toHaveLength(2);
    expect(chart.callsTo("updateAppearance")).toHaveLength(1);
    expect(onReady).toHaveBeenCalledOnce();
  });
});

describe("line.svelte readiness data options", () => {
  it.each(["single", "multi"] as const)(
    "forwards the latest update options for %s-series data before onReady",
    async (shape) => {
      const data =
        shape === "single"
          ? dataFor("line")
          : {
              x: new Float64Array([0, 1]),
              series: [new Float64Array([2, 3]), new Float64Array([4, 5])],
              length: 2,
              seriesCount: 2,
            };
      let callsAtReady: RecordedCall[] = [];
      const onReady = vi.fn((instance: FakeChart) => {
        callsAtReady = appliedCalls(instance);
      });
      const chart = render("line", {
        data,
        dataUpdateOptions: { preservePreviousFrame: false },
        onReady,
      });
      setProps({ dataUpdateOptions: { preservePreviousFrame: true } });

      await becomeReady(chart);

      const method = shape === "single" ? "setData" : "setMultiSeriesData";
      expect(callsAtReady).toHaveLength(1);
      expect(callsAtReady[0]?.method).toBe(method);
      expect(callsAtReady[0]?.args[0]).toBe(props.data);
      expect(callsAtReady[0]?.args[1]).toBe(props.dataUpdateOptions);
      expect(callsAtReady[0]?.inBatch).toBe(true);

      setProps({ dataUpdateOptions: { preservePreviousFrame: false } });
      setProps({ appearance: { grid: { visible: false } } });

      expect(chart.callsTo(method)).toHaveLength(1);
      expect(onReady).toHaveBeenCalledOnce();
    },
  );
});
