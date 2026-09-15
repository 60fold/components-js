import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLineChart, lastChart, resetFakeCharts } from "@test/support/chartDoubles.js";

vi.mock("@sixtyfold/line", () => ({ LineChart: FakeLineChart }));

const { SixtyfoldLineChart } = await import("../src/line.jsx");

let container: HTMLDivElement;
let dispose: (() => void) | null = null;

/** Let the microtask queue drain so a resolved initialize() is observed. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetFakeCharts();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  dispose?.();
  dispose = null;
  container.remove();
});

describe("SixtyfoldLineChart", () => {
  it.each(["after rejected initial props", "before the initialization reaction"] as const)(
    "does not publish readiness after a terminal renderer failure %s",
    async (timing) => {
      const onReady = vi.fn();
      const onError = vi.fn();
      const initial = { x: new Float64Array([0, 1]), y: new Float64Array([2, 3]), length: 2 };
      const [data, setData] = createSignal(initial);
      dispose = render(
        () => <SixtyfoldLineChart data={data()} onReady={onReady} onError={onError} />,
        container,
      );
      const chart = lastChart(FakeLineChart);
      const install = vi.spyOn(chart, "setData");
      const propError = new Error("invalid initial data");
      if (timing === "after rejected initial props") {
        install.mockImplementationOnce(() => {
          throw propError;
        });
        chart.becomeReady();
        await settle();
        expect(onError).toHaveBeenCalledExactlyOnceWith(propError);
      } else {
        chart.becomeReady();
      }
      const failure = new Error("terminal renderer failure");
      chart.failRuntime(failure);
      await settle();

      setData({ ...initial });

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
    const [appearance, setAppearance] = createSignal({});
    dispose = render(
      () => (
        <SixtyfoldLineChart
          data={data}
          appearance={appearance()}
          onReady={onReady}
          onError={onError}
        />
      ),
      container,
    );
    const chart = lastChart(FakeLineChart);
    vi.spyOn(chart, "updateAppearance").mockImplementationOnce(() => {
      throw new Error("invalid appearance");
    });
    chart.becomeReady();
    await settle();
    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    setAppearance({ grid: { color: "#123456" } });
    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
  });

  it("recovers from initial prop errors and notifies readiness only after a successful batch", async () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const initial = { x: new Float64Array([0, 1]), y: new Float64Array([2, 3]), length: 2 };
    const [data, setData] = createSignal(initial);
    dispose = render(
      () => <SixtyfoldLineChart data={data()} onReady={onReady} onError={onError} />,
      container,
    );
    const chart = lastChart(FakeLineChart);
    const error = new Error("invalid initial data");
    vi.spyOn(chart, "setData").mockImplementationOnce(() => {
      throw error;
    });
    chart.becomeReady();
    await settle();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(onReady).not.toHaveBeenCalled();
    expect(chart.destroyed).toBe(false);
    const replacement = { ...initial };
    setData(replacement);
    expect(chart.callsTo("setData").at(-1)?.args[0]).toBe(replacement);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
    setData({ ...initial });
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("installs a dataset exactly once when it arrives before the chart is ready", async () => {
    const [data, setData] = createSignal<object | undefined>(undefined);
    dispose = render(() => <SixtyfoldLineChart data={data() as never} />, container);
    const chart = lastChart(FakeLineChart);

    const next = {
      x: new Float64Array([0, 1]),
      y: new Float64Array([2, 3]),
      length: 2,
    };
    setData(next);
    expect(chart.callsTo("setData")).toHaveLength(0);

    chart.becomeReady();
    await settle();

    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(chart.callsTo("setData")[0]?.args[0]).toBe(next);
  });

  it("does not re-install the same dataset when another prop changes", async () => {
    const data = {
      x: new Float64Array([0, 1]),
      y: new Float64Array([2, 3]),
      length: 2,
    };
    const [appearance, setAppearance] = createSignal<object | undefined>(undefined);
    dispose = render(
      () => <SixtyfoldLineChart data={data} appearance={appearance() as never} />,
      container,
    );
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();

    setAppearance({ grid: { color: "#123456" } });

    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(chart.callsTo("updateAppearance")).toHaveLength(1);
  });

  it("routes a multi-series dataset to setMultiSeriesData", async () => {
    const data = {
      x: new Float64Array([0, 1]),
      series: [new Float64Array([2, 3])],
      length: 2,
      seriesCount: 1,
    };
    dispose = render(() => <SixtyfoldLineChart data={data} />, container);
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();

    expect(chart.callsTo("setMultiSeriesData")).toHaveLength(1);
    expect(chart.callsTo("setData")).toHaveLength(0);
  });

  it("leaves stats collection off when no listener is supplied", () => {
    dispose = render(() => <SixtyfoldLineChart />, container);
    expect(lastChart(FakeLineChart).statsCallback).toBeNull();
  });

  it("enables stats collection when a listener is supplied", () => {
    const onStats = vi.fn();
    dispose = render(() => <SixtyfoldLineChart onStats={onStats} />, container);
    const chart = lastChart(FakeLineChart);

    expect(chart.statsCallback).toBeTypeOf("function");
    chart.statsCallback?.({ fps: 60 });
    expect(onStats).toHaveBeenCalledWith({ fps: 60 });
  });

  it("omits `animated` so the chart's configured default wins", async () => {
    dispose = render(() => <SixtyfoldLineChart viewport={{ xMin: 0, xMax: 10 }} />, container);
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();

    expect(chart.callsTo("setViewport")[0]?.args[1]).toEqual({ animated: undefined });
  });

  it("forwards an explicit viewportAnimated", async () => {
    dispose = render(
      () => <SixtyfoldLineChart viewport={{ xMin: 0, xMax: 10 }} viewportAnimated />,
      container,
    );
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();

    expect(chart.callsTo("setViewport")[0]?.args[1]).toEqual({ animated: true });
  });

  it("applies data, appearance, and viewport in a single batch", async () => {
    dispose = render(
      () => (
        <SixtyfoldLineChart
          data={{ x: new Float64Array([0]), y: new Float64Array([1]), length: 1 }}
          appearance={{ grid: { color: "#123456" } }}
          viewport={{ xMin: 0, xMax: 5 }}
        />
      ),
      container,
    );
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();

    const applied = chart.calls.filter((call) =>
      ["setData", "updateAppearance", "setViewport"].includes(call.method),
    );
    expect(applied).toHaveLength(3);
    expect(applied.every((call) => call.inBatch)).toBe(true);
  });

  it("hands the chart to chartRef on mount and clears it on cleanup", async () => {
    const chartRef = vi.fn();
    dispose = render(() => <SixtyfoldLineChart chartRef={chartRef} />, container);
    const chart = lastChart(FakeLineChart);

    expect(chartRef).toHaveBeenCalledWith(chart);

    dispose();
    dispose = null;

    expect(chartRef).toHaveBeenLastCalledWith(null);
    expect(chart.destroyed).toBe(true);
  });

  it("reports an initialization failure through onError exactly once", async () => {
    const onError = vi.fn();
    dispose = render(() => <SixtyfoldLineChart onError={onError} />, container);
    const chart = lastChart(FakeLineChart);
    const failure = new Error("renderer failed");

    chart.failInitialization(failure);
    await settle();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("reports a post-initialization renderer failure through onError", async () => {
    const onError = vi.fn();
    dispose = render(() => <SixtyfoldLineChart onError={onError} />, container);
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();
    const failure = new Error("renderer stopped");

    chart.failRuntime(failure);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("reports an overlay image failure through onError", () => {
    const onError = vi.fn();
    dispose = render(() => <SixtyfoldLineChart onError={onError} />, container);
    const chart = lastChart(FakeLineChart);
    const failure = new Error("overlay image failed");

    chart.failOverlay(failure);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("stays silent when initialization is aborted by disposing", async () => {
    const onError = vi.fn();
    dispose = render(() => <SixtyfoldLineChart onError={onError} />, container);

    dispose();
    dispose = null;
    await settle();

    expect(onError).not.toHaveBeenCalled();
  });

  it("gives the canvas an overridable accessible name", () => {
    dispose = render(() => <SixtyfoldLineChart />, container);
    const canvas = container.querySelector("canvas");
    expect(canvas?.getAttribute("aria-label")).toBe("Interactive chart");
    expect(canvas?.getAttribute("role")).toBe("application");
    expect(canvas?.getAttribute("tabindex")).toBe("0");
  });

  it("lets canvasProps override the default accessible name", () => {
    dispose = render(
      () => <SixtyfoldLineChart canvasProps={{ "aria-label": "Revenue over time" }} />,
      container,
    );
    expect(container.querySelector("canvas")?.getAttribute("aria-label")).toBe("Revenue over time");
  });

  it("renders a view-only chart as a non-focusable image", () => {
    dispose = render(() => <SixtyfoldLineChart options={{ interactive: false }} />, container);
    const canvas = container.querySelector("canvas");
    expect(canvas?.getAttribute("aria-label")).toBe("Chart");
    expect(canvas?.getAttribute("role")).toBe("img");
    expect(canvas?.hasAttribute("tabindex")).toBe(false);
  });
});
