<script lang="ts">
  import { onMount } from "svelte";
  import type { DeepPartial, Viewport } from "@sixtyfold/core";
  import {
    LineChart,
    type LineAppearanceOptions,
    type LineChartOptions,
    type LineChartStats,
    type LineDataUpdateOptions,
    type SeriesVisibilityChangeEvent,
  } from "@sixtyfold/line";
  import { hasViewport, installLineData, type LineData } from "./shared.js";

  /** Construction-time options. Remount the component to replace them. */
  export let options: LineChartOptions = {};
  /**
   * One-shot chart data. Assign a new object for each update. Worker mode
   * transfers and detaches its buffers; main-thread mode retains references.
   */
  export let data: LineData | undefined = undefined;
  export let dataUpdateOptions: LineDataUpdateOptions | undefined = undefined;
  export let appearance: DeepPartial<LineAppearanceOptions> | undefined = undefined;
  export let viewport: Partial<Viewport> | undefined = undefined;
  /** Leave undefined to inherit the chart's configured `animated` default. */
  export let viewportAnimated: boolean | undefined = undefined;
  export let statsIntervalMs: number | undefined = undefined;
  export let onReady: ((chart: LineChart) => void) | undefined = undefined;
  /** Reports construction, renderer, and overlay-image failures. */
  export let onError: ((error: unknown) => void) | undefined = undefined;
  export let onStats: ((stats: LineChartStats) => void) | undefined = undefined;
  export let onSeriesVisibilityChange: ((event: SeriesVisibilityChangeEvent) => void) | undefined =
    undefined;
  export let canvasClass = "";
  export let canvasStyle = "";
  export let ariaLabel: string | undefined = undefined;
  export let ariaDescribedBy: string | undefined = undefined;
  export let canvasRole: string | undefined = undefined;
  export let canvasTabIndex: number | undefined = undefined;
  /** Bindable access to the mounted imperative chart. */
  export let chart: LineChart | null = null;

  // Assigned by Svelte's bind:this directive.
  // oxlint-disable-next-line no-unassigned-vars
  let canvas: HTMLCanvasElement;
  let ready = false;
  let disposed = false;
  let reportedRendererError: unknown;
  let appliedData: LineData | undefined;
  let appliedAppearance: DeepPartial<LineAppearanceOptions> | undefined;
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
    instance: LineChart | null,
    nextData: LineData | undefined,
    nextAppearance: DeepPartial<LineAppearanceOptions> | undefined,
    nextViewport: Partial<Viewport> | undefined,
    animated: boolean | undefined,
  ): void {
    if (!isReady || !instance) return;
    instance.batch(() => {
      if (nextData && nextData !== appliedData) {
        installLineData(instance, nextData, dataUpdateOptions);
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
    let instance: LineChart;
    try {
      instance = new LineChart(canvas, options);
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
    instance.setSeriesVisibilityCallback((event) => onSeriesVisibilityChange?.(event));
    void instance
      .initialize()
      .then(() => {
        if (disposed || chart !== instance) return;
        // Publish readiness only after the initial batch succeeds. Setting
        // ready alone schedules a later reactive update, which would run after
        // onReady and could overwrite changes made by the callback.
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
  aria-label={ariaLabel ?? (options.interactive === false ? "Chart" : "Interactive chart")}
  aria-describedby={ariaDescribedBy}
  role={canvasRole ?? (options.interactive === false ? "img" : "application")}
  tabindex={canvasTabIndex ?? (options.interactive === false ? undefined : 0)}
></canvas>
