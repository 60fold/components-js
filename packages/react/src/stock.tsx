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
  StockChart,
  type OHLCVData,
  type StockAppearanceOptions,
  type StockChartOptions,
  type StockChartStats,
} from "@sixtyfold/stock";
import { hasViewport, type ChartHandle } from "./shared.js";
import { useChartLifetime } from "./useChartLifetime.js";

export type StockChartHandle = ChartHandle<StockChart>;

export interface SixtyfoldStockChartProps extends Omit<
  CanvasHTMLAttributes<HTMLCanvasElement>,
  "children"
> {
  /** Construction-time options. Remount the component to replace them. */
  options?: StockChartOptions;
  /**
   * One-shot chart data. Supply a new object for each update. Worker mode
   * transfers and detaches its buffers; main-thread mode retains references.
   */
  data?: OHLCVData;
  appearance?: DeepPartial<StockAppearanceOptions>;
  viewport?: Partial<Viewport>;
  /** Leave undefined to inherit the chart's configured `animated` default. */
  viewportAnimated?: boolean;
  onReady?: (chart: StockChart) => void;
  /** Reports construction, renderer, and overlay-image failures. */
  onError?: (error: unknown) => void;
  onStats?: (stats: StockChartStats) => void;
  statsIntervalMs?: number;
}

/** React host for a Sixtyfold stock chart. */
export const SixtyfoldStockChart = forwardRef<StockChartHandle, SixtyfoldStockChartProps>(
  function SixtyfoldStockChart(
    {
      options,
      data,
      appearance,
      viewport,
      viewportAnimated,
      onReady,
      onError,
      onStats,
      statsIntervalMs,
      style,
      ...canvasProps
    },
    forwardedRef,
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const lifetimeRef = useChartLifetime<StockChart>();
    const initialOptionsRef = useRef(options);
    const latestRef = useRef({
      data,
      appearance,
      viewport,
      viewportAnimated,
      onReady,
      onError,
      onStats,
      statsIntervalMs,
    });
    const appliedDataRef = useRef<OHLCVData | undefined>(undefined);
    const appliedAppearanceRef = useRef<DeepPartial<StockAppearanceOptions> | undefined>(undefined);
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
        appearance,
        viewport,
        viewportAnimated,
        onReady,
        onError,
        onStats,
        statsIntervalMs,
      };
    }, [appearance, data, onError, onReady, onStats, statsIntervalMs, viewport, viewportAnimated]);

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
          chart.setData(current.data);
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
      // Skip Strict Mode's development-only setup/cleanup probe.
      queueMicrotask(() => {
        if (disconnected || lifetime.disposed || !canvasRef.current) return;
        while (lifetime.pendingErrors.length > 0) {
          const error = lifetime.pendingErrors.shift();
          latestRef.current.onError?.(error);
          // Error handlers may synchronously hide or unmount the host.
          if (disconnected || lifetime.disposed || !canvasRef.current) return;
        }
        let chart = lifetime.chart;
        if (!chart) {
          try {
            chart = new StockChart(canvasRef.current, initialOptionsRef.current ?? {});
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
        // Keep the renderer across Activity hiding, but disconnect telemetry.
        lifetime.chart?.setStatsCallback(null);
      };
    }, [connectReadyChart, lifetimeRef, reportError]);

    useEffect(() => {
      applyReactiveProps();
    }, [applyReactiveProps, data, appearance, viewport, viewportAnimated]);

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
        aria-label={options?.interactive === false ? "Stock chart" : "Interactive stock chart"}
        role={options?.interactive === false ? "img" : "application"}
        tabIndex={options?.interactive === false ? undefined : 0}
        {...canvasProps}
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%", ...style }}
      />
    );
  },
);
