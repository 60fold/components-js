import { ElementRef, Injector, PLATFORM_ID, runInInjectionContext } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeStockChart,
  lastChart,
  resetFakeCharts,
  type FakeChart,
} from "@test/support/chartDoubles.js";

vi.mock("@sixtyfold/stock", () => ({ StockChart: FakeStockChart }));

const { SixtyfoldStockChartComponent } = await import("../stock/src/stock.component.js");

type Component = InstanceType<typeof SixtyfoldStockChartComponent>;

function createComponent(platform: string = "browser"): Component {
  const injector = Injector.create({
    providers: [{ provide: PLATFORM_ID, useValue: platform }],
  });
  const component = runInInjectionContext(injector, () => new SixtyfoldStockChartComponent());
  (component as unknown as { canvasRef: ElementRef<HTMLCanvasElement> }).canvasRef = new ElementRef(
    document.createElement("canvas"),
  );
  return component;
}

function getCanvas(value: Component): HTMLCanvasElement {
  return (value as unknown as { canvasRef: ElementRef<HTMLCanvasElement> }).canvasRef.nativeElement;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function ohlcv() {
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

let component: Component | null = null;

beforeEach(() => {
  resetFakeCharts();
});

afterEach(() => {
  component?.ngOnDestroy();
  component = null;
});

describe("SixtyfoldStockChartComponent", () => {
  it.each(["after rejected initial props", "before the initialization reaction"] as const)(
    "does not publish readiness after a terminal renderer failure %s",
    async (timing) => {
      component = createComponent();
      const onReady = vi.fn();
      const onError = vi.fn();
      component.chartReady.subscribe(onReady);
      component.chartError.subscribe(onError);
      const data = ohlcv();
      component.data = data;
      component.ngAfterViewInit();
      const chart = lastChart(FakeStockChart);
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
    component.data = {
      timestamp: new Float64Array([0, 1]),
      open: new Float64Array([1, 2]),
      high: new Float64Array([2, 3]),
      low: new Float64Array([0, 1]),
      close: new Float64Array([1.5, 2.5]),
      volume: new Float64Array([10, 20]),
      length: 2,
    };
    component.appearance = {};
    component.ngAfterViewInit();
    const chart = lastChart(FakeStockChart);
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
    const data = {
      timestamp: new Float64Array([0, 1]),
      open: new Float64Array([1, 2]),
      high: new Float64Array([2, 3]),
      low: new Float64Array([0, 1]),
      close: new Float64Array([1.5, 2.5]),
      volume: new Float64Array([10, 20]),
      length: 2,
    };
    component.data = data;
    component.ngAfterViewInit();
    const chart = lastChart(FakeStockChart);
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

  function mount(): FakeChart {
    component = createComponent();
    component.ngAfterViewInit();
    return lastChart(FakeStockChart);
  }

  it("does not construct a chart during server rendering", () => {
    component = createComponent("server");
    component.ngAfterViewInit();

    expect(FakeStockChart.instances).toHaveLength(0);
    expect(component.chart).toBeNull();
  });

  it("installs a dataset once when it arrives before the chart is ready", async () => {
    const chart = mount();
    component!.data = ohlcv();
    component!.ngOnChanges({});
    expect(chart.callsTo("setData")).toHaveLength(0);

    chart.becomeReady();
    await settle();

    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(chart.callsTo("setData")[0]?.args[0]).toBe(component!.data);
  });

  it("batches data, appearance, and viewport updates", async () => {
    component = createComponent();
    component.data = ohlcv();
    component.appearance = { grid: { vertical: false, horizontal: false } };
    component.viewport = { xMin: 0, xMax: 5 };
    component.ngAfterViewInit();
    const chart = lastChart(FakeStockChart);
    chart.becomeReady();
    await settle();

    const applied = chart.calls.filter((call) =>
      ["setData", "updateAppearance", "setViewport"].includes(call.method),
    );
    expect(applied).toHaveLength(3);
    expect(applied.every((call) => call.inBatch)).toBe(true);
  });

  it("collects stats only when the output is observed", () => {
    component = createComponent();
    const values: unknown[] = [];
    component.stats.subscribe((value) => values.push(value));
    component.ngAfterViewInit();
    const chart = lastChart(FakeStockChart);

    expect(chart.statsCallback).toBeTypeOf("function");
    chart.statsCallback?.({ fps: 60 });
    expect(values).toEqual([{ fps: 60 }]);
  });

  it("emits an initialization failure exactly once", async () => {
    const errors: unknown[] = [];
    component = createComponent();
    component.chartError.subscribe((error) => errors.push(error));
    component.ngAfterViewInit();
    const chart = lastChart(FakeStockChart);
    const failure = new Error("renderer failed");

    chart.failInitialization(failure);
    await settle();

    expect(errors).toEqual([failure]);
  });

  it("emits a renderer failure after initialization", async () => {
    const errors: unknown[] = [];
    component = createComponent();
    component.chartError.subscribe((error) => errors.push(error));
    component.ngAfterViewInit();
    const chart = lastChart(FakeStockChart);
    chart.becomeReady();
    await settle();
    const failure = new Error("renderer stopped");

    chart.failRuntime(failure);

    expect(errors).toEqual([failure]);
  });

  it("emits an overlay image failure", () => {
    const errors: unknown[] = [];
    component = createComponent();
    component.chartError.subscribe((error) => errors.push(error));
    component.ngAfterViewInit();
    const chart = lastChart(FakeStockChart);
    const failure = new Error("overlay image failed");

    chart.failOverlay(failure);

    expect(errors).toEqual([failure]);
  });

  it("reactively applies generic canvas attributes while preserving chart-owned fields", () => {
    component = createComponent();
    component.canvasAttributes = {
      "data-symbol": "BTCUSDT",
      title: "Bitcoin price",
      tabindex: 4,
      style: "opacity: 0",
    };
    component.ngAfterViewInit();
    const canvas = getCanvas(component);

    expect(canvas.getAttribute("data-symbol")).toBe("BTCUSDT");
    expect(canvas.getAttribute("title")).toBe("Bitcoin price");
    expect(canvas.hasAttribute("tabindex")).toBe(false);
    expect(canvas.hasAttribute("style")).toBe(false);

    component.canvasAttributes = { "data-symbol": null, "data-market": "spot" };
    component.ngOnChanges({});

    expect(canvas.hasAttribute("data-symbol")).toBe(false);
    expect(canvas.getAttribute("data-market")).toBe("spot");
    expect(canvas.hasAttribute("title")).toBe(false);
  });

  it("destroys the stock chart on teardown", () => {
    const chart = mount();

    component?.ngOnDestroy();

    expect(chart.destroyed).toBe(true);
  });
});
