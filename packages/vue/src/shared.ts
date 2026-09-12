// Duplicated per adapter package on purpose. Every @sixtyfold/core import
// here is type-only, so a built adapter carries no runtime dependency on
// core — it is declared an optional peer. Sharing these helpers through core
// would turn that into a real one.
import type { MultiSeriesData, TimeSeriesData, Viewport } from "@sixtyfold/core";
import type { LineChart, LineDataUpdateOptions } from "@sixtyfold/line";

export type LineData = TimeSeriesData | MultiSeriesData;

export type StatsListener<T> = ((stats: T) => void) | ((stats: T) => void)[] | null;

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
