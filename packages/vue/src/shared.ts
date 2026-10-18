// Duplicated per adapter package on purpose. Every @sixtyfold/core import
// here is type-only, so a built adapter carries no runtime dependency on
// core — it is declared an optional peer. Sharing these helpers through core
// would turn that into a real one.
import type { MultiSeriesData, TimeSeriesData, Viewport } from "@sixtyfold/core";
import type { LineChart, LineDataUpdateOptions } from "@sixtyfold/line";

export type LineData = TimeSeriesData | MultiSeriesData;

export type StatsListener<T> = ((stats: T) => void) | ((stats: T) => void)[] | null;

export function hasStatsListener<T>(listener: StatsListener<T> | undefined): boolean {
  return (
    typeof listener === "function" ||
    (Array.isArray(listener) && listener.some((fn) => typeof fn === "function"))
  );
}

export function clearUnconsumedStatsOnce(vm: unknown): void {
  const emitted = (vm as { emitted?: Record<string, unknown> | null } | null)?.emitted;
  if (emitted) delete emitted.onStats;
}

export function installLineData(
  chart: LineChart,
  data: LineData,
  options?: LineDataUpdateOptions,
): void {
  if ("series" in data) chart.setMultiSeriesData(data, options);
  else chart.setData(data, options);
}

export function hasViewport(
  viewport: Partial<Viewport> | undefined,
): viewport is Partial<Viewport> {
  return viewport !== undefined && (viewport.xMin !== undefined || viewport.xMax !== undefined);
}
