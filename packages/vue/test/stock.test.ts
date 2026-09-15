import { createApp, h, nextTick, shallowReactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeStockChart,
  lastChart,
  resetFakeCharts,
  type FakeChart,
} from "@test/support/chartDoubles.js";

vi.mock("@sixtyfold/stock", () => ({ StockChart: FakeStockChart }));

const { SixtyfoldStockChart } = await import("../src/stock.js");

let container: HTMLDivElement;
let app: App | null = null;
let props: Record<string, unknown>;

function mount(initial: Record<string, unknown> = {}): FakeChart {
  props = shallowReactive({ ...initial });
  app = createApp({ render: () => h(SixtyfoldStockChart, { ...props }) });
  app.mount(container);
  return lastChart(FakeStockChart);
}

async function setProps(next: Record<string, unknown>): Promise<void> {
  Object.assign(props, next);
  await nextTick();
  await nextTick();
}

async function becomeReady(chart: FakeChart): Promise<void> {
  chart.becomeReady();
  await nextTick();
  await nextTick();
}

beforeEach(() => {
  resetFakeCharts();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  app?.unmount();
  app = null;
  container.remove();
});

describe("SixtyfoldStockChart", () => {
  it.each(["after rejected initial props", "before the initialization reaction"] as const)(
    "does not publish readiness after a terminal renderer failure %s",
    async (timing) => {
      const onReady = vi.fn();
      const onError = vi.fn();
      const data = {
        timestamp: new Float64Array([0, 1]),
        open: new Float64Array([1, 2]),
        high: new Float64Array([2, 3]),
        low: new Float64Array([0, 1]),
        close: new Float64Array([1.5, 2.5]),
        volume: new Float64Array([10, 20]),
        length: 2,
      };
      const chart = mount({ data, onReady, onError });
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
      await nextTick();
      await nextTick();

      await setProps({ data: { ...data } });

      expect(install).toHaveBeenCalledTimes(timing === "after rejected initial props" ? 1 : 0);
      expect(chart.callsTo("setData")).toHaveLength(0);
      expect(onReady).not.toHaveBeenCalled();
      expect(onError).toHaveBeenLastCalledWith(failure);
      expect(onError).toHaveBeenCalledTimes(timing === "after rejected initial props" ? 2 : 1);
    },
  );

  it("does not reinstall transferred data when a later initial prop fails", async () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const data = {
      timestamp: new Float64Array([0, 1]),
      open: new Float64Array([1, 2]),
      high: new Float64Array([2, 3]),
      low: new Float64Array([0, 1]),
      close: new Float64Array([1.5, 2.5]),
      volume: new Float64Array([10, 20]),
      length: 2,
    };
    const chart = mount({ data, appearance: {}, onReady, onError });
    vi.spyOn(chart, "updateAppearance").mockImplementationOnce(() => {
      throw new Error("invalid appearance");
    });
    await becomeReady(chart);
    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    await setProps({ appearance: { grid: { color: "#123456" } } });
    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
  });

  it("recovers from initial prop errors and notifies readiness only after a successful batch", async () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const data = {
      timestamp: new Float64Array([0, 1]),
      open: new Float64Array([1, 2]),
      high: new Float64Array([2, 3]),
      low: new Float64Array([0, 1]),
      close: new Float64Array([1.5, 2.5]),
      volume: new Float64Array([10, 20]),
      length: 2,
    };
    const chart = mount({ data, onReady, onError });
    const error = new Error("invalid initial data");
    vi.spyOn(chart, "setData").mockImplementationOnce(() => {
      throw error;
    });
    await becomeReady(chart);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(onReady).not.toHaveBeenCalled();
    expect(chart.destroyed).toBe(false);
    const replacement = { ...data };
    await setProps({ data: replacement });
    expect(chart.callsTo("setData").at(-1)?.args[0]).toBe(replacement);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
    await setProps({ data: { ...data } });
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("installs a dataset once when it arrives before the chart is ready", async () => {
    const chart = mount();
    const data = {
      timestamp: new Float64Array([0, 1]),
      open: new Float64Array([1, 2]),
      high: new Float64Array([2, 3]),
      low: new Float64Array([0, 1]),
      close: new Float64Array([1.5, 2.5]),
      volume: new Float64Array([10, 20]),
      length: 2,
    };

    await setProps({ data });
    expect(chart.callsTo("setData")).toHaveLength(0);
    await becomeReady(chart);

    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(chart.callsTo("setData")[0]?.args[0]).toBe(data);
  });

  it("batches data, appearance, and viewport updates", async () => {
    const chart = mount({
      data: {
        timestamp: new Float64Array([0]),
        open: new Float64Array([1]),
        high: new Float64Array([2]),
        low: new Float64Array([0]),
        close: new Float64Array([1.5]),
        volume: new Float64Array([10]),
        length: 1,
      },
      appearance: { grid: { vertical: false, horizontal: false } },
      viewport: { xMin: 0, xMax: 5 },
    });
    await becomeReady(chart);

    const applied = chart.calls.filter((call) =>
      ["setData", "updateAppearance", "setViewport"].includes(call.method),
    );
    expect(applied).toHaveLength(3);
    expect(applied.every((call) => call.inBatch)).toBe(true);
  });

  it("collects stats only when a listener is bound", async () => {
    const onStats = vi.fn();
    const chart = mount({ onStats });
    await nextTick();

    expect(chart.statsCallback).toBeTypeOf("function");
    chart.statsCallback?.({ fps: 60 });
    expect(onStats).toHaveBeenCalledWith({ fps: 60 });
  });

  it("emits an initialization failure exactly once", async () => {
    const onError = vi.fn();
    const chart = mount({ onError });
    const failure = new Error("renderer failed");

    chart.failInitialization(failure);
    await nextTick();
    await nextTick();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("emits a renderer failure after initialization", async () => {
    const onError = vi.fn();
    const chart = mount({ onError });
    await becomeReady(chart);
    const failure = new Error("renderer stopped");

    chart.failRuntime(failure);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("emits an overlay image failure", () => {
    const onError = vi.fn();
    const chart = mount({ onError });
    const failure = new Error("overlay image failed");

    chart.failOverlay(failure);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("destroys the chart on unmount", async () => {
    const chart = mount();
    await becomeReady(chart);

    app?.unmount();
    app = null;

    expect(chart.destroyed).toBe(true);
  });
});
