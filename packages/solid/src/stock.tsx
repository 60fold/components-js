import { createEffect, onCleanup, onMount, type JSX } from "solid-js";
import type { DeepPartial, Viewport } from "@sixtyfold/core";
import {
  StockChart,
  type OHLCVData,
  type StockAppearanceOptions,
  type StockChartOptions,
  type StockChartStats,
} from "@sixtyfold/stock";
import { hasViewport, mergeCanvasStyle } from "./shared.js";

export interface SixtyfoldStockChartProps {
  options?: StockChartOptions;
  data?: OHLCVData;
  appearance?: DeepPartial<StockAppearanceOptions>;
  viewport?: Partial<Viewport>;
  viewportAnimated?: boolean;
  onReady?: (chart: StockChart) => void;
  /** Reports construction, renderer, and overlay-image failures. */
  onError?: (error: unknown) => void;
  onStats?: (stats: StockChartStats) => void;
  statsIntervalMs?: number;
  chartRef?: (chart: StockChart | null) => void;
  canvasProps?: JSX.CanvasHTMLAttributes<HTMLCanvasElement>;
}

/** SolidJS host for a Sixtyfold stock chart. */
export function SixtyfoldStockChart(props: SixtyfoldStockChartProps): JSX.Element {
  // Assigned by Solid's ref binding.
  // oxlint-disable-next-line no-unassigned-vars
  let canvas!: HTMLCanvasElement;
  let chart: StockChart | null = null;
  let ready = false;
  let readyNotified = false;
  let disposed = false;
  let rendererFailed = false;
  let reportedRendererError: unknown;
  let appliedData: OHLCVData | undefined;
  let appliedAppearance: DeepPartial<StockAppearanceOptions> | undefined;
  let appliedViewport: Partial<Viewport> | undefined;

  const apply = (): void => {
    if (!ready || !chart || disposed || rendererFailed) return;
    const instance = chart;
    try {
      instance.batch(() => {
        if (props.data && props.data !== appliedData) {
          chart!.setData(props.data);
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
    let instance: StockChart;
    try {
      instance = new StockChart(canvas, props.options ?? {});
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
      aria-label={props.options?.interactive === false ? "Stock chart" : "Interactive stock chart"}
      role={props.options?.interactive === false ? "img" : "application"}
      tabIndex={props.options?.interactive === false ? undefined : 0}
      {...props.canvasProps}
      ref={canvas}
      style={mergeCanvasStyle(props.canvasProps?.style)}
    />
  );
}
