// Duplicated per adapter package on purpose. Every @sixtyfold/core import
// here is type-only, so a built adapter carries no runtime dependency on
// core — it is declared an optional peer. Sharing these helpers through core
// would turn that into a real one.
import { EventEmitter } from "@angular/core";
import type { MultiSeriesData, TimeSeriesData, Viewport } from "@sixtyfold/core";
import type { LineChart, LineDataUpdateOptions } from "@sixtyfold/line";

export type LineData = TimeSeriesData | MultiSeriesData;

/** Track subscription changes without changing Angular/RxJS event semantics. */
export function createStatsEmitter<T>(onObservedChange: () => void): EventEmitter<T> {
  const emitter = new EventEmitter<T>();
  const subscribe = emitter.subscribe.bind(emitter);
  emitter.subscribe = (...args: Parameters<EventEmitter<T>["subscribe"]>) => {
    const subscription = subscribe(...args);
    // Native teardown removes the observer first. This also covers operators
    // such as take(1), completion, errors, and already-closed subscribers.
    subscription.add(onObservedChange);
    onObservedChange();
    return subscription;
  };
  const unsubscribe = emitter.unsubscribe.bind(emitter);
  emitter.unsubscribe = () => {
    // Closing the Subject itself does not run its subscribers' finalizers.
    unsubscribe();
    onObservedChange();
  };
  return emitter;
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
