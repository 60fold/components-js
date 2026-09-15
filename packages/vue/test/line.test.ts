import { createApp, h, nextTick, shallowReactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeLineChart,
  lastChart,
  resetFakeCharts,
  type FakeChart,
} from "@test/support/chartDoubles.js";

vi.mock("@sixtyfold/line", () => ({ LineChart: FakeLineChart }));

const { SixtyfoldLineChart } = await import("../src/line.js");

type Props = Record<string, unknown>;

let container: HTMLDivElement;
let app: App | null = null;
let props: Props;

/** Mounts the component behind a reactive props object, so a test can change a
 *  prop and have the same chart instance receive the update. */
function mount(initial: Props = {}): FakeChart {
  props = shallowReactive({ ...initial });
  app = createApp({ render: () => h(SixtyfoldLineChart, { ...props }) });
  app.mount(container);
  return lastChart(FakeLineChart);
}

/** Apply a prop change and let the resulting watchers run. */
async function setProps(next: Props): Promise<void> {
  Object.assign(props, next);
  await nextTick();
  await nextTick();
}

/** Resolve initialize() and let the post-ready work settle. */
async function becomeReady(chart: FakeChart): Promise<void> {
  chart.becomeReady();
  await nextTick();
  await nextTick();
}

function unmount(): void {
  app?.unmount();
  app = null;
}

beforeEach(() => {
  resetFakeCharts();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  unmount();
  container.remove();
});

describe("SixtyfoldLineChart", () => {
  it.each(["after rejected initial props", "before the initialization reaction"] as const)(
    "does not publish readiness after a terminal renderer failure %s",
    async (timing) => {
      const onReady = vi.fn();
      const onError = vi.fn();
      const data = { x: new Float64Array([0, 1]), y: new Float64Array([2, 3]), length: 2 };
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
    const data = { x: new Float64Array([0, 1]), y: new Float64Array([2, 3]), length: 2 };
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
    const data = { x: new Float64Array([0, 1]), y: new Float64Array([2, 3]), length: 2 };
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

  it("installs a dataset exactly once when it arrives before the chart is ready", async () => {
    const chart = mount({});
    const data = { x: new Float64Array([0, 1]), y: new Float64Array([2, 3]) };

    await setProps({ data });
    expect(chart.callsTo("setData")).toHaveLength(0);

    await becomeReady(chart);

    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(chart.callsTo("setData")[0]?.args[0]).toBe(data);
  });

  it("does not re-install the same dataset when another prop changes", async () => {
    const data = { x: new Float64Array([0, 1]), y: new Float64Array([2, 3]) };
    const chart = mount({ data });
    await becomeReady(chart);

    await setProps({ appearance: { grid: { visible: false } } });

    expect(chart.callsTo("setData")).toHaveLength(1);
  });

  it("routes a multi-series dataset to setMultiSeriesData", async () => {
    const data = {
      x: new Float64Array([0, 1]),
      series: [new Float64Array([2, 3])],
      length: 2,
      seriesCount: 1,
    };
    const chart = mount({ data });
    await becomeReady(chart);

    expect(chart.callsTo("setMultiSeriesData")).toHaveLength(1);
    expect(chart.callsTo("setData")).toHaveLength(0);
  });

  it("leaves stats collection off when no listener is bound", async () => {
    const chart = mount({});
    await nextTick();

    expect(chart.statsCallback).toBeNull();
  });

  it("enables stats collection when a listener is bound", async () => {
    const onStats = vi.fn();
    const chart = mount({ onStats });
    await nextTick();

    expect(chart.statsCallback).toBeTypeOf("function");
    chart.statsCallback?.({ fps: 60 });
    expect(onStats).toHaveBeenCalledWith({ fps: 60 });
  });

  it("omits `animated` so the chart's configured default wins", async () => {
    const chart = mount({ viewport: { xMin: 0, xMax: 10 } });
    await becomeReady(chart);

    expect(chart.callsTo("setViewport")[0]?.args[1]).toEqual({ animated: undefined });
  });

  it("forwards an explicit viewportAnimated", async () => {
    const chart = mount({ viewport: { xMin: 0, xMax: 10 }, viewportAnimated: true });
    await becomeReady(chart);

    expect(chart.callsTo("setViewport")[0]?.args[1]).toEqual({ animated: true });
  });

  it("ignores a viewport patch with neither bound set", async () => {
    const chart = mount({ viewport: {} });
    await becomeReady(chart);

    expect(chart.callsTo("setViewport")).toHaveLength(0);
  });

  it("applies data, appearance, and viewport in a single batch", async () => {
    const chart = mount({
      data: { x: new Float64Array([0]), y: new Float64Array([1]) },
      appearance: { grid: { visible: false } },
      viewport: { xMin: 0, xMax: 5 },
    });
    await becomeReady(chart);

    const applied = chart.calls.filter((call) =>
      ["setData", "updateAppearance", "setViewport"].includes(call.method),
    );
    expect(applied).toHaveLength(3);
    expect(applied.every((call) => call.inBatch)).toBe(true);
  });

  it("batches later updates too, not just the initial install", async () => {
    const chart = mount({});
    await becomeReady(chart);

    await setProps({
      appearance: { grid: { visible: true } },
      viewport: { xMin: 1, xMax: 2 },
    });

    const applied = chart.calls.filter((call) =>
      ["updateAppearance", "setViewport"].includes(call.method),
    );
    expect(applied).toHaveLength(2);
    expect(applied.every((call) => call.inBatch)).toBe(true);
  });

  it("emits ready with the chart instance", async () => {
    const onReady = vi.fn();
    const chart = mount({ onReady });
    await becomeReady(chart);

    expect(onReady).toHaveBeenCalledWith(chart);
  });

  it("emits error when initialization fails", async () => {
    const onError = vi.fn();
    const failure = new Error("renderer failed");
    const chart = mount({ onError });
    chart.failInitialization(failure);
    await nextTick();
    await nextTick();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("emits error when the renderer fails after initialization", async () => {
    const onError = vi.fn();
    const chart = mount({ onError });
    await becomeReady(chart);
    const failure = new Error("renderer stopped");

    chart.failRuntime(failure);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("emits error when an overlay image fails", () => {
    const onError = vi.fn();
    const chart = mount({ onError });
    const failure = new Error("overlay image failed");

    chart.failOverlay(failure);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("stays silent when initialization is aborted by unmounting", async () => {
    const onError = vi.fn();
    mount({ onError });
    await nextTick();

    unmount();
    await nextTick();
    await nextTick();

    expect(onError).not.toHaveBeenCalled();
  });

  it("destroys the chart on unmount", async () => {
    const chart = mount({});
    await becomeReady(chart);

    unmount();

    expect(chart.destroyed).toBe(true);
  });

  it("gives the canvas an overridable accessible name", async () => {
    mount({});
    await nextTick();
    const canvas = container.querySelector("canvas");
    expect(canvas?.getAttribute("aria-label")).toBe("Interactive chart");
    expect(canvas?.getAttribute("role")).toBe("application");
    expect(canvas?.getAttribute("tabindex")).toBe("0");
  });

  it("lets an attribute override the default accessible name", async () => {
    mount({ "aria-label": "Revenue over time" });
    await nextTick();
    expect(container.querySelector("canvas")?.getAttribute("aria-label")).toBe("Revenue over time");
  });

  it("renders a view-only chart as a non-focusable image", async () => {
    mount({ options: { interactive: false } });
    await nextTick();
    const canvas = container.querySelector("canvas");
    expect(canvas?.getAttribute("aria-label")).toBe("Chart");
    expect(canvas?.getAttribute("role")).toBe("img");
    expect(canvas?.hasAttribute("tabindex")).toBe(false);
  });
});
