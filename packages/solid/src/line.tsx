import { createEffect, onCleanup, onMount, type JSX } from "solid-js";
import type { DeepPartial, Viewport } from "@sixtyfold/core";
import {
  LineChart,
  type LineAppearanceOptions,
  type LineChartOptions,
  type LineChartStats,
  type LineDataUpdateOptions,
  type SeriesVisibilityChangeEvent,
} from "@sixtyfold/line";
import { hasViewport, installLineData, mergeCanvasStyle, type LineData } from "./shared.js";

export interface SixtyfoldLineChartProps {
  options?: LineChartOptions;
  data?: LineData;
  dataUpdateOptions?: LineDataUpdateOptions;
  appearance?: DeepPartial<LineAppearanceOptions>;
  viewport?: Partial<Viewport>;
  viewportAnimated?: boolean;
  onReady?: (chart: LineChart) => void;
  /** Reports construction, renderer, and overlay-image failures. */
  onError?: (error: unknown) => void;
  onStats?: (stats: LineChartStats) => void;
  statsIntervalMs?: number;
  onSeriesVisibilityChange?: (event: SeriesVisibilityChangeEvent) => void;
  chartRef?: (chart: LineChart | null) => void;
  canvasProps?: JSX.CanvasHTMLAttributes<HTMLCanvasElement>;
}

/** SolidJS host for a Sixtyfold line chart. */
export function SixtyfoldLineChart(props: SixtyfoldLineChartProps): JSX.Element {
  // Assigned by Solid's ref binding.
  // oxlint-disable-next-line no-unassigned-vars
  let canvas!: HTMLCanvasElement;
  let chart: LineChart | null = null;
  let ready = false;
  let readyNotified = false;
  let disposed = false;
  let rendererFailed = false;
  let reportedRendererError: unknown;
  let appliedData: LineData | undefined;
  let appliedAppearance: DeepPartial<LineAppearanceOptions> | undefined;
  let appliedViewport: Partial<Viewport> | undefined;

  const apply = (): void => {
    if (!ready || !chart || disposed || rendererFailed) return;
    const instance = chart;
    try {
      instance.batch(() => {
        if (props.data && props.data !== appliedData) {
          installLineData(chart!, props.data, props.dataUpdateOptions);
          appliedData = props.data;
        }
        if (props.appearance && props.appearance !== appliedAppearance) {
          chart!.updateAppearance(props.appearance);
          appliedAppearance = props.appearance;
        }
        if (hasViewport(props.viewport) && props.viewport !== appliedViewport) {
          chart!.setViewport(props.viewport, { animated: props.viewportAnimated });
          appliedViewport = props.viewport;
        }
      });
    } catch (error) {
      if (!disposed && error !== reportedRendererError) props.onError?.(error);
      return;
    }
    if (!disposed && !rendererFailed && chart === instance && !readyNotified) {
      readyNotified = true;
      try {
        props.onReady?.(instance);
      } catch (error) {
        if (!disposed) props.onError?.(error);
      }
    }
  };

  createEffect(() => {
    void props.data;
    void props.dataUpdateOptions;
    void props.appearance;
    void props.viewport;
    void props.viewportAnimated;
    apply();
  });
  createEffect(() => {
    const onStats = props.onStats;
    const intervalMs = props.statsIntervalMs;
    if (chart)
      chart.setStatsCallback(onStats ? (stats) => props.onStats?.(stats) : null, { intervalMs });
  });

  onMount(() => {
    let instance: LineChart;
    try {
      instance = new LineChart(canvas, props.options ?? {});
    } catch (error) {
      if (!disposed) props.onError?.(error);
      return;
    }
    chart = instance;
    props.chartRef?.(instance);
    instance.setRendererErrorCallback((error) => {
      rendererFailed = true;
      reportedRendererError = error;
      if (!disposed) props.onError?.(error);
    });
    instance.setOverlayErrorCallback((error) => {
      if (!disposed) props.onError?.(error);
    });
    instance.setStatsCallback(props.onStats ? (stats) => props.onStats?.(stats) : null, {
      intervalMs: props.statsIntervalMs,
    });
    instance.setSeriesVisibilityCallback((event) => props.onSeriesVisibilityChange?.(event));
    void instance
      .initialize()
      .then(() => {
        if (disposed || chart !== instance) return;
        ready = true;
        apply();
      })
      .catch((error) => {
        if (!disposed && error !== reportedRendererError) props.onError?.(error);
      });
  });

  onCleanup(() => {
    disposed = true;
    ready = false;
    chart?.destroy();
    chart = null;
    props.chartRef?.(null);
  });

  return (
    <canvas
      aria-label={props.options?.interactive === false ? "Chart" : "Interactive chart"}
      role={props.options?.interactive === false ? "img" : "application"}
      tabIndex={props.options?.interactive === false ? undefined : 0}
      {...props.canvasProps}
      ref={canvas}
      style={mergeCanvasStyle(props.canvasProps?.style)}
    />
  );
}
