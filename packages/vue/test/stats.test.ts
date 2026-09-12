import { createApp, h, nextTick, shallowReactive, type App, type Component } from "vue";
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

const { SixtyfoldLineChart } = await import("../src/line.js");
const { SixtyfoldStockChart } = await import("../src/stock.js");
const { default: StatsListenerHarness } = await import("./fixtures/StatsListenerHarness.vue");

const adapters = [
  {
    name: "SixtyfoldLineChart",
    component: SixtyfoldLineChart as Component,
    chartType: FakeLineChart,
    data: () => ({ x: new Float64Array([0, 1]), y: new Float64Array([2, 3]) }),
  },
  {
    name: "SixtyfoldStockChart",
    component: SixtyfoldStockChart as Component,
    chartType: FakeStockChart,
    data: () => ({
      timestamp: new Float64Array([0, 1]),
      open: new Float64Array([1, 2]),
      high: new Float64Array([2, 3]),
      low: new Float64Array([0, 1]),
      close: new Float64Array([1.5, 2.5]),
      volume: new Float64Array([10, 20]),
      length: 2,
    }),
  },
];

type Props = Record<string, unknown>;

let app: App | null = null;
let container: HTMLDivElement;
let props: Props;

function mount(adapter: (typeof adapters)[number], initial: Props = {}): FakeChart {
  props = shallowReactive({ ...initial });
  app = createApp({ render: () => h(adapter.component, { ...props }) });
  app.mount(container);
  return lastChart(adapter.chartType);
}

async function settle(): Promise<void> {
  await nextTick();
  await nextTick();
}

async function setProps(next: Props): Promise<void> {
  Object.assign(props, next);
  await settle();
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

describe.each(adapters)("$name stats listeners", (adapter) => {
  it("enables, replaces, and removes a stats listener without changing any chart prop", async () => {
    const data = adapter.data();
    // A compiled conditional @stats binding keeps the listener prop present
    // with an undefined value while disabled. No key-count change forces Vue
    // to update the child when this is its only changed input.
    const chart = mount(adapter, { data, statsIntervalMs: 250, onStats: undefined });
    chart.becomeReady();
    await settle();
    expect(chart.statsCallback).toBeNull();

    const first = vi.fn();
    await setProps({ onStats: first });
    expect(chart.statsCallback).toBeTypeOf("function");
    expect(chart.callsTo("setStatsCallback").at(-1)?.args[1]).toEqual({ intervalMs: 250 });
    const stats = { fps: 60 };
    chart.statsCallback?.(stats);
    expect(first).toHaveBeenCalledExactlyOnceWith(stats);

    const second = vi.fn();
    await setProps({ onStats: second });
    const nextStats = { fps: 59 };
    chart.statsCallback?.(nextStats);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledExactlyOnceWith(nextStats);

    delete props.onStats;
    await settle();
    expect(chart.statsCallback).toBeNull();
    expect(chart.callsTo("setStatsCallback").at(-1)?.args).toEqual([null, { intervalMs: 250 }]);
    expect(adapter.chartType.instances).toEqual([chart]);
    expect(chart.destroyed).toBe(false);
    expect(chart.callsTo("setData")).toHaveLength(1);
    expect(chart.callsTo("setData")[0]?.args[0]).toBe(data);
  });

  it("disables collection when an initially bound listener becomes undefined", async () => {
    const chart = mount(adapter, { onStats: vi.fn() });
    await settle();
    expect(chart.statsCallback).toBeTypeOf("function");

    await setProps({ onStats: undefined });

    expect(chart.statsCallback).toBeNull();
  });

  it("tracks listener-only changes from a compiled @stats template binding", async () => {
    const listener = vi.fn();
    props = shallowReactive<Props>({ listener: undefined });
    app = createApp({
      render: () =>
        h(StatsListenerHarness, {
          ...props,
          kind: adapter.chartType === FakeLineChart ? "line" : "stock",
        }),
    });
    app.mount(container);
    const chart = lastChart(adapter.chartType);
    await settle();
    expect(chart.statsCallback).toBeNull();

    await setProps({ listener });
    expect(chart.statsCallback).toBeTypeOf("function");
    chart.statsCallback?.({ fps: 60 });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ fps: 60 });

    await setProps({ listener: undefined });
    expect(chart.statsCallback).toBeNull();
  });

  it("uses the latest listener without reinstalling an enabled collection callback", async () => {
    const first = vi.fn();
    const chart = mount(adapter, { onStats: first });
    await settle();
    const installedCallback = chart.statsCallback;
    const registrations = chart.callsTo("setStatsCallback").length;

    const second = vi.fn();
    await setProps({ onStats: second });
    const stats = { fps: 58 };
    installedCallback?.(stats);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith(stats);
    expect(chart.statsCallback).toBe(installedCallback);
    expect(chart.callsTo("setStatsCallback")).toHaveLength(registrations);
  });

  it("updates the interval while enabled and uses its latest value when re-enabled", async () => {
    const listener = vi.fn();
    const chart = mount(adapter, { onStats: listener, statsIntervalMs: 100 });
    await settle();

    await setProps({ statsIntervalMs: 300 });
    expect(chart.callsTo("setStatsCallback").at(-1)?.args[1]).toEqual({ intervalMs: 300 });
    expect(chart.statsCallback).toBeTypeOf("function");

    await setProps({ onStats: undefined });
    expect(chart.statsCallback).toBeNull();
    await setProps({ statsIntervalMs: 500 });
    expect(chart.statsCallback).toBeNull();
    await setProps({ onStats: listener });
    expect(chart.statsCallback).toBeTypeOf("function");
    expect(chart.callsTo("setStatsCallback").at(-1)?.args[1]).toEqual({ intervalMs: 500 });
  });

  it("tracks listener changes before initialization completes", async () => {
    const chart = mount(adapter, { onStats: undefined });
    const listener = vi.fn();

    await setProps({ onStats: listener });
    expect(chart.statsCallback).toBeTypeOf("function");
    await setProps({ onStats: undefined });
    expect(chart.statsCallback).toBeNull();

    chart.becomeReady();
    await settle();
    expect(chart.statsCallback).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps stats component events off the native canvas", async () => {
    const onStats = vi.fn();
    const onStatsOnce = vi.fn();
    const chart = mount(adapter, { onStats, onStatsOnce });
    await settle();

    chart.canvas.dispatchEvent(new CustomEvent("stats", { detail: { fps: 1 } }));
    expect(onStats).not.toHaveBeenCalled();
    expect(onStatsOnce).not.toHaveBeenCalled();

    const stats = { fps: 60 };
    chart.statsCallback?.(stats);
    expect(onStats).toHaveBeenCalledExactlyOnceWith(stats);
    expect(onStatsOnce).toHaveBeenCalledExactlyOnceWith(stats);
  });

  it("supports arrays of component event listeners and their replacement", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const chart = mount(adapter, { onStats: [first, second] });
    await settle();
    const stats = { fps: 60 };
    chart.statsCallback?.(stats);
    expect(first).toHaveBeenCalledExactlyOnceWith(stats);
    expect(second).toHaveBeenCalledExactlyOnceWith(stats);

    const replacement = vi.fn();
    await setProps({ onStats: [replacement] });
    chart.statsCallback?.(stats);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledExactlyOnceWith(stats);
  });

  it("collects for a once-only stats listener and preserves Vue's once semantics", async () => {
    const chart = mount(adapter);
    const onStatsOnce = vi.fn();

    await setProps({ onStatsOnce });
    expect(chart.statsCallback).toBeTypeOf("function");
    chart.statsCallback?.({ fps: 60 });
    chart.statsCallback?.({ fps: 59 });
    expect(onStatsOnce).toHaveBeenCalledExactlyOnceWith({ fps: 60 });

    delete props.onStatsOnce;
    await settle();
    expect(chart.statsCallback).toBeNull();
  });
});
