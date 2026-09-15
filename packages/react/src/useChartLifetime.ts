import * as React from "react";
import { useEffect, useInsertionEffect, useRef } from "react";

// Activity is a symbol, not a function. Earlier supported React releases do
// not run insertion cleanups when deleting an already-hidden Suspense tree.
const canRetainHidden = typeof React.Activity !== "undefined";

interface ChartLifetime<TChart> {
  chart: TChart | null;
  active: boolean;
  ready: boolean;
  readyNotified: boolean;
  rendererFailed: boolean;
  disposed: boolean;
  pendingErrors: unknown[];
}

function disposeChart<TChart extends { destroy(): void }>(lifetime: ChartLifetime<TChart>): void {
  lifetime.disposed = true;
  lifetime.active = false;
  lifetime.ready = false;
  lifetime.pendingErrors.length = 0;
  const chart = lifetime.chart;
  lifetime.chart = null;
  chart?.destroy();
}

/** Owns a transferred canvas/renderer independently of temporary Effect disconnection. */
export function useChartLifetime<TChart extends { destroy(): void }>() {
  const lifetimeRef = useRef<ChartLifetime<TChart>>({
    chart: null,
    active: false,
    ready: false,
    readyNotified: false,
    rendererFailed: false,
    disposed: false,
    pendingErrors: [],
  });

  // Layout/passive Effects and callback refs disconnect when Activity hides
  // the host. Destroying then would discard worker-owned data and leave a
  // canvas that cannot be transferred again. An insertion Effect is used ONLY
  // as a final-disposal hook: it survives hiding and cleans up even if React
  // deletes an already-hidden tree. Construction and prop work stay passive;
  // this setup neither reads DOM refs nor schedules React state updates.
  useInsertionEffect(() => {
    if (!canRetainHidden) return;
    return () => {
      disposeChart(lifetimeRef.current);
    };
  }, []);

  // React 18 and pre-Activity React 19 keep passive Effects connected while
  // Suspense hides an existing tree, and reliably clean them up on deletion.
  // Resetting the flag permits Strict Mode's setup/cleanup/setup probe;
  // deferred construction means that probe has no renderer to dispose.
  useEffect(() => {
    if (canRetainHidden) return;
    lifetimeRef.current.disposed = false;
    return () => {
      disposeChart(lifetimeRef.current);
    };
  }, []);

  return lifetimeRef;
}
