<script lang="ts">
  import { onMount } from "svelte";
  import type { DeepPartial, Viewport } from "@sixtyfold/core";
  import {
    StockChart,
    type OHLCVData,
    type StockAppearanceOptions,
    type StockChartOptions,
    type StockChartStats,
  } from "@sixtyfold/stock";
  import { hasViewport } from "./shared.js";

  export let options: StockChartOptions = {};
  export let data: OHLCVData | undefined = undefined;
  export let appearance: DeepPartial<StockAppearanceOptions> | undefined = undefined;
  export let viewport: Partial<Viewport> | undefined = undefined;
  /** Leave undefined to inherit the chart's configured `animated` default. */
  export let viewportAnimated: boolean | undefined = undefined;
  export let statsIntervalMs: number | undefined = undefined;
  export let onReady: ((chart: StockChart) => void) | undefined = undefined;
  /** Reports construction, renderer, and overlay-image failures. */
  export let onError: ((error: unknown) => void) | undefined = undefined;
  export let onStats: ((stats: StockChartStats) => void) | undefined = undefined;
  export let canvasClass = "";
  export let canvasStyle = "";
  export let ariaLabel: string | undefined = undefined;
  export let ariaDescribedBy: string | undefined = undefined;
  export let canvasRole: string | undefined = undefined;
  export let canvasTabIndex: number | undefined = undefined;
  export let chart: StockChart | null = null;

  // Assigned by Svelte's bind:this directive.
  // oxlint-disable-next-line no-unassigned-vars
  let canvas: HTMLCanvasElement;
  let ready = false;
  let disposed = false;
  let reportedRendererError: unknown;
  let appliedData: OHLCVData | undefined;
  let appliedAppearance: DeepPartial<StockAppearanceOptions> | undefined;
  let appliedViewport: Partial<Viewport> | undefined;

  // The arguments are the reactive dependencies; the body reads them directly
  // so a single change installs data, appearance, and viewport in one update.
  $: applyReactiveProps(ready, chart, data, appearance, viewport, viewportAnimated);
  $: if (chart) {
    chart.setStatsCallback(onStats ? (stats) => onStats?.(stats) : null, {
      intervalMs: statsIntervalMs,
    });
  }

  // Each dataset object is applied at most once. Worker mode transfers its
  // buffers; identity tracking also prevents duplicate installs in main-thread
  // mode.
  function applyReactiveProps(
    isReady: boolean,
    instance: StockChart | null,
    nextData: OHLCVData | undefined,
    nextAppearance: DeepPartial<StockAppearanceOptions> | undefined,
    nextViewport: Partial<Viewport> | undefined,
    animated: boolean | undefined,
  ): void {
    if (!isReady || !instance) return;
    instance.batch(() => {
      if (nextData && nextData !== appliedData) {
        instance.setData(nextData);
        appliedData = nextData;
      }
      if (nextAppearance && nextAppearance !== appliedAppearance) {
        instance.updateAppearance(nextAppearance);
        appliedAppearance = nextAppearance;
      }
      if (hasViewport(nextViewport) && nextViewport !== appliedViewport) {
        instance.setViewport(nextViewport, { animated });
        appliedViewport = nextViewport;
      }
    });
  }

  onMount(() => {
    let instance: StockChart;
    try {
      instance = new StockChart(canvas, options);
    } catch (error) {
      if (!disposed) onError?.(error);
      return;
    }
    chart = instance;
    instance.setRendererErrorCallback((error) => {
      reportedRendererError = error;
      if (!disposed) onError?.(error);
    });
    instance.setOverlayErrorCallback((error) => {
      if (!disposed) onError?.(error);
    });
    void instance
      .initialize()
      .then(() => {
        if (disposed || chart !== instance) return;
        // Install props before publishing readiness; the scheduled reactive
        // pass must not overwrite imperative changes made inside onReady.
        applyReactiveProps(true, instance, data, appearance, viewport, viewportAnimated);
        if (disposed || chart !== instance) return;
        ready = true;
        onReady?.(instance);
      })
      .catch((error) => {
        if (!disposed && error !== reportedRendererError) onError?.(error);
      });
    return () => {
      disposed = true;
      ready = false;
      instance.destroy();
      if (chart === instance) chart = null;
    };
  });
</script>

<canvas
  bind:this={canvas}
  class={canvasClass}
  style={`display:block;width:100%;height:100%;${canvasStyle}`}
  aria-label={ariaLabel ??
    (options.interactive === false ? "Stock chart" : "Interactive stock chart")}
  aria-describedby={ariaDescribedBy}
  role={canvasRole ?? (options.interactive === false ? "img" : "application")}
  tabindex={canvasTabIndex ?? (options.interactive === false ? undefined : 0)}
></canvas>
