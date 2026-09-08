import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type CanvasHTMLAttributes,
} from "react";
import type { DeepPartial, Viewport } from "@sixtyfold/core";
import {
  LineChart,
  type LineAppearanceOptions,
  type LineChartOptions,
  type LineChartStats,
  type LineDataUpdateOptions,
  type SeriesVisibilityChangeEvent,
} from "@sixtyfold/line";
import { hasViewport, installLineData, type ChartHandle, type LineData } from "./shared.js";
import { useChartLifetime } from "./useChartLifetime.js";

export type LineChartHandle = ChartHandle<LineChart>;

export interface SixtyfoldLineChartProps extends Omit<
  CanvasHTMLAttributes<HTMLCanvasElement>,
  "children"
> {
  /** Construction-time options. Remount the component to replace them. */
  options?: LineChartOptions;
  /**
   * One-shot chart data. Supply a new object for each update. Worker mode
   * transfers and detaches its buffers; main-thread mode retains references.
   */
  data?: LineData;
  dataUpdateOptions?: LineDataUpdateOptions;
  /** Reactive visual patch applied without recreating the chart. */
  appearance?: DeepPartial<LineAppearanceOptions>;
  /** Reactive viewport patch. */
  viewport?: Partial<Viewport>;
  /** Leave undefined to inherit the chart's configured `animated` default. */
  viewportAnimated?: boolean;
  onReady?: (chart: LineChart) => void;
  /** Reports construction, renderer, and overlay-image failures. */
  onError?: (error: unknown) => void;
  onStats?: (stats: LineChartStats) => void;
  statsIntervalMs?: number;
  onSeriesVisibilityChange?: (event: SeriesVisibilityChangeEvent) => void;
}

/** React host for a Sixtyfold line chart. DOM work starts after mount, so SSR emits only the canvas. */
export const SixtyfoldLineChart = forwardRef<LineChartHandle, SixtyfoldLineChartProps>(
  function SixtyfoldLineChart(
    {
      options,
      data,
      dataUpdateOptions,
      appearance,
      viewport,
      viewportAnimated,
      onReady,
      onError,
      onStats,
      statsIntervalMs,
      onSeriesVisibilityChange,
      style,
      ...canvasProps
    },
    forwardedRef,
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const lifetimeRef = useChartLifetime<LineChart>();
    const initialOptionsRef = useRef(options);
    const latestRef = useRef({
      data,
      dataUpdateOptions,
      appearance,
      viewport,
      viewportAnimated,
      onReady,
      onError,
      onStats,
      statsIntervalMs,
      onSeriesVisibilityChange,
    });
    const appliedDataRef = useRef<LineData | undefined>(undefined);
    const appliedAppearanceRef = useRef<DeepPartial<LineAppearanceOptions> | undefined>(undefined);
    const appliedViewportRef = useRef<Partial<Viewport> | undefined>(undefined);

    useImperativeHandle(
      forwardedRef,
      () => ({
        get chart() {
          return lifetimeRef.current.active ? lifetimeRef.current.chart : null;
        },
      }),
      [lifetimeRef],
    );

    // Publish only committed props. Mutating this ref during render can expose
    // values from a concurrent render that React later abandons.
    useEffect(() => {
      latestRef.current = {
        data,
        dataUpdateOptions,
        appearance,
        viewport,
        viewportAnimated,
        onReady,
        onError,
        onStats,
        statsIntervalMs,
        onSeriesVisibilityChange,
      };
    }, [
      appearance,
      data,
      dataUpdateOptions,
      onError,
      onReady,
      onSeriesVisibilityChange,
      onStats,
      statsIntervalMs,
      viewport,
      viewportAnimated,
    ]);

    // Installs every reactive prop in a single engine update. Each dataset
    // object is applied at most once and never before the chart is ready.
    // Worker mode transfers its buffers; identity tracking also prevents
    // duplicate installs in main-thread mode.
    const applyReactiveProps = useCallback((): void => {
      const { chart, ready, active } = lifetimeRef.current;
      if (!active || !ready || !chart) return;
      const current = latestRef.current;
      chart.batch(() => {
        if (current.data && current.data !== appliedDataRef.current) {
          installLineData(chart, current.data, current.dataUpdateOptions);
          appliedDataRef.current = current.data;
        }
        if (current.appearance && current.appearance !== appliedAppearanceRef.current) {
          chart.updateAppearance(current.appearance);
          appliedAppearanceRef.current = current.appearance;
        }
        if (hasViewport(current.viewport) && current.viewport !== appliedViewportRef.current) {
          chart.setViewport(current.viewport, { animated: current.viewportAnimated });
          appliedViewportRef.current = current.viewport;
        }
      });
    }, [lifetimeRef]);

    const reportError = useCallback(
      (error: unknown): void => {
        const lifetime = lifetimeRef.current;
        if (lifetime.disposed) return;
        if (lifetime.active) latestRef.current.onError?.(error);
        else lifetime.pendingErrors.push(error);
      },
      [lifetimeRef],
    );

    const connectReadyChart = useCallback((): void => {
      const lifetime = lifetimeRef.current;
      if (!lifetime.active || !lifetime.ready || !lifetime.chart) return;
      const chart = lifetime.chart;
      applyReactiveProps();
      if (!lifetime.active || lifetime.disposed || lifetime.chart !== chart) return;
      if (!lifetime.readyNotified) {
        lifetime.readyNotified = true;
        latestRef.current.onReady?.(chart);
      }
    }, [applyReactiveProps, lifetimeRef]);

    useEffect(() => {
      const lifetime = lifetimeRef.current;
      lifetime.active = true;
      let disconnected = false;

      // Deferring construction by one microtask prevents React Strict Mode's
      // development-only setup/cleanup probe from installing data twice.
      queueMicrotask(() => {
        if (disconnected || lifetime.disposed || !canvasRef.current) return;
        while (lifetime.pendingErrors.length > 0) {
          const error = lifetime.pendingErrors.shift();
          latestRef.current.onError?.(error);
          // Error handlers may synchronously hide or unmount the host. Leave
          // any remaining errors queued for its next real reconnection.
          if (disconnected || lifetime.disposed || !canvasRef.current) return;
        }
        let chart = lifetime.chart;
        if (!chart) {
          try {
            chart = new LineChart(canvasRef.current, initialOptionsRef.current ?? {});
          } catch (error) {
            // Construction is deferred, so report rather than throwing outside React.
            reportError(error);
            return;
          }
          lifetime.chart = chart;
          let reportedRendererError: unknown;
          chart.setRendererErrorCallback((error) => {
            reportedRendererError = error;
            reportError(error);
          });
          chart.setOverlayErrorCallback(reportError);
          chart.setSeriesVisibilityCallback((event) => {
            if (lifetime.active) latestRef.current.onSeriesVisibilityChange?.(event);
          });

          void chart
            .initialize()
            .then(() => {
              if (lifetime.disposed || lifetime.chart !== chart) return;
              lifetime.ready = true;
              connectReadyChart();
            })
            .catch((error) => {
              if (error !== reportedRendererError) reportError(error);
            });
        }
        const latest = latestRef.current;
        chart.setStatsCallback(
          latest.onStats
            ? (stats) => {
                if (lifetime.active) latestRef.current.onStats?.(stats);
              }
            : null,
          { intervalMs: latest.statsIntervalMs },
        );
        try {
          connectReadyChart();
        } catch (error) {
          reportError(error);
        }
      });

      return () => {
        disconnected = true;
        lifetime.active = false;
        // Activity retains the renderer and its transferred data, but its
        // React-facing subscriptions stay disconnected until it is shown.
        lifetime.chart?.setStatsCallback(null);
      };
    }, [connectReadyChart, lifetimeRef, reportError]);

    useEffect(() => {
      applyReactiveProps();
    }, [applyReactiveProps, data, dataUpdateOptions, appearance, viewport, viewportAnimated]);

    useEffect(() => {
      const lifetime = lifetimeRef.current;
      if (!lifetime.active || !lifetime.chart) return;
      lifetime.chart.setStatsCallback(
        onStats
          ? (stats) => {
              if (lifetime.active) latestRef.current.onStats?.(stats);
            }
          : null,
        {
          intervalMs: statsIntervalMs,
        },
      );
    }, [lifetimeRef, onStats, statsIntervalMs]);

    return (
      <canvas
        aria-label={options?.interactive === false ? "Chart" : "Interactive chart"}
        role={options?.interactive === false ? "img" : "application"}
        tabIndex={options?.interactive === false ? undefined : 0}
        {...canvasProps}
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%", ...style }}
      />
    );
  },
);
