import { ElementRef, Injector, PLATFORM_ID, runInInjectionContext } from "@angular/core";
import { Subscriber, take, type Observable } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeLineChart,
  FakeStockChart,
  lastChart,
  resetFakeCharts,
  type FakeChart,
} from "@test/support/chartDoubles.js";

vi.mock("@sixtyfold/line", () => ({ LineChart: FakeLineChart }));
vi.mock("@sixtyfold/stock", () => ({ StockChart: FakeStockChart }));

const { SixtyfoldLineChartComponent } = await import("../line/src/line.component.js");
const { SixtyfoldStockChartComponent } = await import("../stock/src/stock.component.js");

type Component =
  | InstanceType<typeof SixtyfoldLineChartComponent>
  | InstanceType<typeof SixtyfoldStockChartComponent>;

const cases = [
  {
    name: "Line",
    chartType: FakeLineChart,
    create: () => {
      const component = new SixtyfoldLineChartComponent();
      component.data = {
        x: new Float64Array([0, 1]),
        y: new Float64Array([2, 3]),
        length: 2,
      };
      return component;
    },
  },
  {
    name: "Stock",
    chartType: FakeStockChart,
    create: () => {
      const component = new SixtyfoldStockChartComponent();
      component.data = {
        timestamp: new Float64Array([0, 1]),
        open: new Float64Array([1, 2]),
        high: new Float64Array([2, 3]),
        low: new Float64Array([0, 1]),
        close: new Float64Array([1.5, 2.5]),
        volume: new Float64Array([10, 20]),
        length: 2,
      };
      return component;
    },
  },
];

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe.each(cases)("Angular $name stats lifecycle", ({ create, chartType }) => {
  let component: Component;

  function createComponent(platform = "browser"): Component {
    const injector = Injector.create({
      providers: [{ provide: PLATFORM_ID, useValue: platform }],
    });
    component = runInInjectionContext<Component>(injector, create);
    (component as unknown as { canvasRef: ElementRef<HTMLCanvasElement> }).canvasRef =
      new ElementRef(document.createElement("canvas"));
    return component;
  }

  function mount(): FakeChart {
    component.ngAfterViewInit();
    return lastChart(chartType);
  }

  beforeEach(() => {
    resetFakeCharts();
    createComponent();
  });

  afterEach(() => {
    component.ngOnDestroy();
  });

  it("starts and stops collection when subscribers change without any input changes", async () => {
    const data = component.data;
    const chart = mount();
    chart.becomeReady();
    await settle();
    expect(chart.statsCallback).toBeNull();
    const initialCalls = chart.callsTo("setStatsCallback").length;
    const received = vi.fn();

    const subscription = component.stats.subscribe(received);

    expect(chart.statsCallback).toBeTypeOf("function");
    expect(chart.callsTo("setStatsCallback")).toHaveLength(initialCalls + 1);
    chart.statsCallback?.({ fps: 60 });
    expect(received).toHaveBeenCalledExactlyOnceWith({ fps: 60 });

    subscription.unsubscribe();

    expect(chart.statsCallback).toBeNull();
    expect(chart.callsTo("setStatsCallback")).toHaveLength(initialCalls + 2);
    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(chart.callsTo("setData")[0]?.args[0]).toBe(data);
    expect(chartType.instances).toHaveLength(1);
  });

  it("keeps collection enabled until the last subscriber leaves", () => {
    const first = vi.fn();
    const second = vi.fn();
    const firstSubscription = component.stats.subscribe(first);
    const chart = mount();
    const initialCalls = chart.callsTo("setStatsCallback").length;

    const secondSubscription = component.stats.subscribe({ next: second });
    firstSubscription.unsubscribe();

    expect(chart.statsCallback).toBeTypeOf("function");
    expect(chart.callsTo("setStatsCallback")).toHaveLength(initialCalls);
    chart.statsCallback?.({ fps: 45 });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith({ fps: 45 });

    secondSubscription.unsubscribe();
    secondSubscription.unsubscribe();

    expect(chart.statsCallback).toBeNull();
    expect(chart.callsTo("setStatsCallback")).toHaveLength(initialCalls + 1);
  });

  it("restarts collection for a new subscriber after the previous one unsubscribes", () => {
    const previous = vi.fn();
    const next = vi.fn();
    const subscription = component.stats.subscribe(previous);
    const chart = mount();

    subscription.unsubscribe();
    expect(chart.statsCallback).toBeNull();
    component.stats.subscribe(next);

    expect(chart.statsCallback).toBeTypeOf("function");
    chart.statsCallback?.({ fps: 30 });
    expect(previous).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledExactlyOnceWith({ fps: 30 });
  });

  it("tracks subscriptions added and removed while initialization is pending", async () => {
    const chart = mount();
    const subscription = component.stats.subscribe(() => {});
    expect(chart.statsCallback).toBeTypeOf("function");

    subscription.unsubscribe();
    expect(chart.statsCallback).toBeNull();
    const settledCalls = chart.callsTo("setStatsCallback").length;

    chart.becomeReady();
    await settle();

    expect(chart.statsCallback).toBeNull();
    expect(chart.callsTo("setStatsCallback")).toHaveLength(settledCalls);
    expect(chart.callsTo("setData")).toHaveLength(1);
  });

  it("uses only subscriptions still active when the chart mounts", () => {
    const subscription = component.stats.subscribe(() => {});
    subscription.unsubscribe();

    const chart = mount();

    expect(chart.statsCallback).toBeNull();
    expect(chart.callsTo("setStatsCallback")).toHaveLength(1);
  });

  it("applies the latest stats interval during initialization without reinstalling data", async () => {
    component.statsIntervalMs = 100;
    component.stats.subscribe(() => {});
    const chart = mount();
    expect(chart.callsTo("setStatsCallback").at(-1)?.args[1]).toEqual({ intervalMs: 100 });

    component.statsIntervalMs = 250;
    component.ngOnChanges({});
    component.statsIntervalMs = 500;
    component.ngOnChanges({});
    expect(chart.callsTo("setData")).toHaveLength(0);

    chart.becomeReady();
    await settle();

    expect(chart.callsTo("setStatsCallback").at(-1)?.args[1]).toEqual({ intervalMs: 500 });
    expect(chart.callsTo("setData")).toHaveLength(1);
    const settledCalls = chart.callsTo("setStatsCallback").length;
    component.ngOnChanges({});
    expect(chart.callsTo("setStatsCallback")).toHaveLength(settledCalls);
  });

  it("restores the default interval when the input is cleared before initialization finishes", async () => {
    component.statsIntervalMs = 750;
    component.stats.subscribe(() => {});
    const chart = mount();

    component.statsIntervalMs = undefined;
    component.ngOnChanges({});
    chart.becomeReady();
    await settle();

    expect(chart.callsTo("setStatsCallback").at(-1)?.args[1]).toEqual({ intervalMs: undefined });
  });

  it("uses the latest interval for a subscriber added during initialization", async () => {
    component.statsIntervalMs = 100;
    const chart = mount();
    component.statsIntervalMs = 400;
    component.ngOnChanges({});

    component.stats.subscribe(() => {});

    expect(chart.statsCallback).toBeTypeOf("function");
    expect(chart.callsTo("setStatsCallback").at(-1)?.args[1]).toEqual({ intervalMs: 400 });
    chart.becomeReady();
    await settle();
    expect(chart.callsTo("setStatsCallback").at(-1)?.args[1]).toEqual({ intervalMs: 400 });
  });

  it("stops collection when an RxJS operator automatically unsubscribes", () => {
    const received = vi.fn();
    take<unknown>(1)(component.stats).subscribe(received);
    const chart = mount();

    chart.statsCallback?.({ fps: 60 });

    expect(received).toHaveBeenCalledExactlyOnceWith({ fps: 60 });
    expect(component.stats.observed).toBe(false);
    expect(chart.statsCallback).toBeNull();
  });

  it("tracks subscriptions through the public Observable view", () => {
    const chart = mount();
    const received = vi.fn();
    const output: Observable<unknown> = component.stats.asObservable();

    const subscription = output.subscribe(received);

    expect(chart.statsCallback).toBeTypeOf("function");
    chart.statsCallback?.({ fps: 24 });
    expect(received).toHaveBeenCalledExactlyOnceWith({ fps: 24 });
    subscription.unsubscribe();
    expect(chart.statsCallback).toBeNull();
  });

  it("does not start collection for an already closed RxJS Subscriber", () => {
    const subscriber = new Subscriber<unknown>();
    subscriber.unsubscribe();
    const chart = mount();
    const initialCalls = chart.callsTo("setStatsCallback").length;

    component.stats.subscribe(subscriber);

    expect(component.stats.observed).toBe(false);
    expect(chart.statsCallback).toBeNull();
    expect(chart.callsTo("setStatsCallback")).toHaveLength(initialCalls);
  });

  it("stops collection when the output completes", () => {
    const completed = vi.fn();
    component.stats.subscribe({ complete: completed });
    const chart = mount();

    component.stats.complete();

    expect(completed).toHaveBeenCalledOnce();
    expect(chart.statsCallback).toBeNull();
    component.stats.subscribe(() => {});
    expect(chart.statsCallback).toBeNull();
  });

  it("stops collection when the output errors", () => {
    const received = vi.fn();
    component.stats.subscribe({ error: received });
    const chart = mount();
    const error = new Error("stats output closed");

    component.stats.error(error);

    expect(received).toHaveBeenCalledExactlyOnceWith(error);
    expect(chart.statsCallback).toBeNull();
  });

  it("stops collection when the EventEmitter itself is unsubscribed", () => {
    const subscription = component.stats.subscribe(() => {});
    const chart = mount();

    component.stats.unsubscribe();

    expect(chart.statsCallback).toBeNull();
    const settledCalls = chart.callsTo("setStatsCallback").length;
    subscription.unsubscribe();
    expect(chart.callsTo("setStatsCallback")).toHaveLength(settledCalls);
  });

  it("does not update a destroyed chart when subscriptions later change", async () => {
    const subscription = component.stats.subscribe(() => {});
    const chart = mount();
    component.ngOnDestroy();
    const callsAtDestroy = chart.calls.length;

    subscription.unsubscribe();
    const lateSubscription = component.stats.subscribe(() => {});
    lateSubscription.unsubscribe();
    component.statsIntervalMs = 500;
    component.ngOnChanges({});
    chart.becomeReady();
    await settle();

    expect(chart.calls).toHaveLength(callsAtDestroy);
    expect(chart.callsTo("setData")).toHaveLength(0);
    expect(chartType.instances).toHaveLength(1);
    expect(component.chart).toBeNull();
  });

  it("keeps subscription changes safe during server rendering", () => {
    component.ngOnDestroy();
    createComponent("server");
    const subscription = component.stats.subscribe(() => {});
    component.ngAfterViewInit();
    subscription.unsubscribe();

    expect(chartType.instances).toHaveLength(0);
    expect(component.chart).toBeNull();
  });
});
