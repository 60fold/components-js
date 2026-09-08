import { useInsertionEffect, useRef } from "react";

interface ChartLifetime<TChart> {
  chart: TChart | null;
  active: boolean;
  ready: boolean;
  readyNotified: boolean;
  disposed: boolean;
  pendingErrors: unknown[];
}

/** Owns a transferred canvas/renderer independently of temporary Effect disconnection. */
export function useChartLifetime<TChart extends { destroy(): void }>() {
  const lifetimeRef = useRef<ChartLifetime<TChart>>({
    chart: null,
    active: false,
    ready: false,
    readyNotified: false,
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
    return () => {
      const lifetime = lifetimeRef.current;
      lifetime.disposed = true;
      lifetime.active = false;
      lifetime.ready = false;
      lifetime.pendingErrors.length = 0;
      const chart = lifetime.chart;
      lifetime.chart = null;
      chart?.destroy();
    };
  }, []);

  return lifetimeRef;
}
