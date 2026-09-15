import { ElementRef, Injector, PLATFORM_ID, runInInjectionContext } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLineChart, lastChart, resetFakeCharts } from "@test/support/chartDoubles.js";

vi.mock("@sixtyfold/line", () => ({ LineChart: FakeLineChart }));

const { SixtyfoldLineChartComponent } = await import("../line/src/line.component.js");

type Component = InstanceType<typeof SixtyfoldLineChartComponent>;

/** Drives the component's lifecycle directly. Rendering the template would
 *  need the Angular platform and a zone; the logic under test is the mount /
 *  ngOnChanges / ngOnDestroy sequence, which does not need either. */
function createComponent(platform: string = "browser"): Component {
  const injector = Injector.create({
    providers: [{ provide: PLATFORM_ID, useValue: platform }],
  });
  const component = runInInjectionContext(injector, () => new SixtyfoldLineChartComponent());
  const canvas = document.createElement("canvas");
  (component as unknown as { canvasRef: ElementRef<HTMLCanvasElement> }).canvasRef = new ElementRef(
    canvas,
  );
  return component;
}

function getCanvas(value: Component): HTMLCanvasElement {
  return (value as unknown as { canvasRef: ElementRef<HTMLCanvasElement> }).canvasRef.nativeElement;
}

/** Let the microtask queue drain so a resolved initialize() is observed. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let component: Component | null = null;

beforeEach(() => {
  resetFakeCharts();
});

afterEach(() => {
  component?.ngOnDestroy();
  component = null;
});

describe("SixtyfoldLineChartComponent", () => {
  it.each(["after rejected initial props", "before the initialization reaction"] as const)(
    "does not publish readiness after a terminal renderer failure %s",
    async (timing) => {
      component = createComponent();
      const onReady = vi.fn();
      const onError = vi.fn();
      component.chartReady.subscribe(onReady);
      component.chartError.subscribe(onError);
      const data = { x: new Float64Array([0, 1]), y: new Float64Array([2, 3]), length: 2 };
      component.data = data;
      component.ngAfterViewInit();
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

      component.data = { ...data };
      component.ngOnChanges({});

      expect(install).toHaveBeenCalledTimes(timing === "after rejected initial props" ? 1 : 0);
      expect(chart.callsTo("setData")).toHaveLength(0);
      expect(onReady).not.toHaveBeenCalled();
      expect(onError).toHaveBeenLastCalledWith(failure);
      expect(onError).toHaveBeenCalledTimes(timing === "after rejected initial props" ? 2 : 1);
    },
  );

  it("does not reinstall transferred data when a later initial prop fails", async () => {
    component = createComponent();
    const onReady = vi.fn();
    const onError = vi.fn();
    component.chartReady.subscribe(onReady);
    component.chartError.subscribe(onError);
    component.data = { x: new Float64Array([0, 1]), y: new Float64Array([2, 3]), length: 2 };
    component.appearance = {};
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);
    vi.spyOn(chart, "updateAppearance").mockImplementationOnce(() => {
      throw new Error("invalid appearance");
    });
    chart.becomeReady();
    await settle();
    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    component.appearance = { grid: { color: "#123456" } };
    component.ngOnChanges({});
    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
  });

  it("recovers from initial prop errors and notifies readiness only after a successful batch", async () => {
    component = createComponent();
    const onReady = vi.fn();
    const onError = vi.fn();
    component.chartReady.subscribe(onReady);
    component.chartError.subscribe(onError);
    const data = { x: new Float64Array([0, 1]), y: new Float64Array([2, 3]), length: 2 };
    component.data = data;
    component.ngAfterViewInit();
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
    const replacement = { ...data };
    component.data = replacement;
    component.ngOnChanges({});
    expect(chart.callsTo("setData").at(-1)?.args[0]).toBe(replacement);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(chart);
    component.data = { ...data };
    component.ngOnChanges({});
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("installs a dataset exactly once when it arrives before the chart is ready", async () => {
    component = createComponent();
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);

    component.data = {
      x: new Float64Array([0, 1]),
      y: new Float64Array([2, 3]),
      length: 2,
    };
    component.ngOnChanges({});
    expect(chart.callsTo("setData")).toHaveLength(0);

    chart.becomeReady();
    await settle();

    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(chart.callsTo("setData")[0]?.args[0]).toBe(component.data);
  });

  it("does not re-install the same dataset on a later change pass", async () => {
    component = createComponent();
    component.data = {
      x: new Float64Array([0, 1]),
      y: new Float64Array([2, 3]),
      length: 2,
    };
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();

    component.canvasClass = "changed";
    component.ngOnChanges({});

    expect(chart.callsTo("setData")).toHaveLength(1);
  });

  it("does not construct a chart when rendering on the server", () => {
    component = createComponent("server");
    component.ngAfterViewInit();

    expect(FakeLineChart.instances).toHaveLength(0);
    expect(component.chart).toBeNull();
  });

  it("routes a multi-series dataset to setMultiSeriesData", async () => {
    component = createComponent();
    component.data = {
      x: new Float64Array([0, 1]),
      series: [new Float64Array([2, 3])],
      length: 2,
      seriesCount: 1,
    };
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();

    expect(chart.callsTo("setMultiSeriesData")).toHaveLength(1);
    expect(chart.callsTo("setData")).toHaveLength(0);
  });

  it("leaves stats collection off when nothing subscribes to the output", () => {
    component = createComponent();
    component.ngAfterViewInit();

    expect(lastChart(FakeLineChart).statsCallback).toBeNull();
  });

  it("enables stats collection when the output is subscribed", () => {
    component = createComponent();
    const received: unknown[] = [];
    component.stats.subscribe((value) => received.push(value));
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);

    expect(chart.statsCallback).toBeTypeOf("function");
    chart.statsCallback?.({ fps: 60 });
    expect(received).toEqual([{ fps: 60 }]);
  });

  it("does not re-send the stats config when an unrelated input changes", async () => {
    component = createComponent();
    component.stats.subscribe(() => {});
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();
    const before = chart.callsTo("setStatsCallback").length;

    component.canvasClass = "changed";
    component.ngOnChanges({});
    component.ariaLabel = "Something else";
    component.ngOnChanges({});

    expect(chart.callsTo("setStatsCallback")).toHaveLength(before);
  });

  it("resolves interactive and view-only canvas semantics", () => {
    component = createComponent();
    expect(component.resolvedAriaLabel).toBe("Interactive chart");
    expect(component.resolvedCanvasRole).toBe("application");
    expect(component.resolvedCanvasTabIndex).toBe(0);

    component.options = { interactive: false };
    expect(component.resolvedAriaLabel).toBe("Chart");
    expect(component.resolvedCanvasRole).toBe("img");
    expect(component.resolvedCanvasTabIndex).toBeNull();

    component.ariaLabel = "Revenue over time";
    component.canvasRole = "figure";
    component.canvasTabIndex = -1;
    expect(component.resolvedAriaLabel).toBe("Revenue over time");
    expect(component.resolvedCanvasRole).toBe("figure");
    expect(component.resolvedCanvasTabIndex).toBe(-1);
  });

  it("applies and removes additional canvas attributes without overriding managed fields", () => {
    component = createComponent();
    component.canvasAttributes = {
      "data-chart-id": "latency",
      draggable: true,
      title: "Latency history",
      role: "presentation",
      width: 320,
    };
    component.ngAfterViewInit();
    const canvas = getCanvas(component);

    expect(canvas.getAttribute("data-chart-id")).toBe("latency");
    expect(canvas.getAttribute("draggable")).toBe("");
    expect(canvas.getAttribute("title")).toBe("Latency history");
    expect(canvas.hasAttribute("role")).toBe(false);
    expect(canvas.hasAttribute("width")).toBe(false);

    component.canvasAttributes = { "data-chart-id": "throughput", draggable: false };
    component.ngOnChanges({});

    expect(canvas.getAttribute("data-chart-id")).toBe("throughput");
    expect(canvas.hasAttribute("draggable")).toBe(false);
    expect(canvas.hasAttribute("title")).toBe(false);
  });

  it("re-sends the stats config when the interval changes", async () => {
    component = createComponent();
    component.stats.subscribe(() => {});
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();
    const before = chart.callsTo("setStatsCallback").length;

    component.statsIntervalMs = 500;
    component.ngOnChanges({});

    const calls = chart.callsTo("setStatsCallback");
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)?.args[1]).toEqual({ intervalMs: 500 });
  });

  it("omits `animated` so the chart's configured default wins", async () => {
    component = createComponent();
    component.viewport = { xMin: 0, xMax: 10 };
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();

    expect(chart.callsTo("setViewport")[0]?.args[1]).toEqual({ animated: undefined });
  });

  it("forwards an explicit viewportAnimated", async () => {
    component = createComponent();
    component.viewport = { xMin: 0, xMax: 10 };
    component.viewportAnimated = true;
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();

    expect(chart.callsTo("setViewport")[0]?.args[1]).toEqual({ animated: true });
  });

  it("applies data, appearance, and viewport in a single batch", async () => {
    component = createComponent();
    component.data = {
      x: new Float64Array([0]),
      y: new Float64Array([1]),
      length: 1,
    };
    component.appearance = { grid: { color: "#123456" } };
    component.viewport = { xMin: 0, xMax: 5 };
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();

    const applied = chart.calls.filter((call) =>
      ["setData", "updateAppearance", "setViewport"].includes(call.method),
    );
    expect(applied).toHaveLength(3);
    expect(applied.every((call) => call.inBatch)).toBe(true);
  });

  it("emits chartReady with the chart instance", async () => {
    component = createComponent();
    const ready: unknown[] = [];
    component.chartReady.subscribe((value) => ready.push(value));
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();

    expect(ready).toEqual([chart]);
  });

  it("emits chartError when initialization fails", async () => {
    component = createComponent();
    const errors: unknown[] = [];
    component.chartError.subscribe((value) => errors.push(value));
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);
    const failure = new Error("renderer failed");
    chart.failInitialization(failure);
    await settle();

    expect(errors).toEqual([failure]);
  });

  it("emits chartError when the renderer fails after initialization", async () => {
    component = createComponent();
    const errors: unknown[] = [];
    component.chartError.subscribe((value) => errors.push(value));
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);
    chart.becomeReady();
    await settle();
    const failure = new Error("renderer stopped");

    chart.failRuntime(failure);

    expect(errors).toEqual([failure]);
  });

  it("emits chartError when an overlay image fails", () => {
    component = createComponent();
    const errors: unknown[] = [];
    component.chartError.subscribe((value) => errors.push(value));
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);
    const failure = new Error("overlay image failed");

    chart.failOverlay(failure);

    expect(errors).toEqual([failure]);
  });

  it("stays silent when initialization is aborted by destroying", async () => {
    component = createComponent();
    const errors: unknown[] = [];
    component.chartError.subscribe((value) => errors.push(value));
    component.ngAfterViewInit();
    const chart = lastChart(FakeLineChart);

    component.ngOnDestroy();
    component = null;
    await settle();

    expect(chart.destroyed).toBe(true);
    expect(errors).toEqual([]);
  });
});
