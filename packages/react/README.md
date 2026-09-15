# @sixtyfold/react

Thin React 18/19 hosts for Sixtyfold line and stock charts. The wrapper owns the
canvas lifecycle and destroys workers on unmount; the chart engine remains
available through a ref.

```bash
pnpm add @sixtyfold/react @sixtyfold/line
```

```tsx
import { useMemo, useRef } from "react";
import { SixtyfoldLineChart, type LineChartHandle } from "@sixtyfold/react/line";

export function Chart() {
  const ref = useRef<LineChartHandle>(null);
  const data = useMemo(
    () => ({
      x: new Float64Array([0, 1, 2, 3]),
      y: new Float64Array([3, 7, 4, 9]),
      length: 4,
    }),
    [],
  );

  return <SixtyfoldLineChart ref={ref} data={data} />;
}
```

Import stock support from `@sixtyfold/react/stock` and install
`@sixtyfold/stock`. Construction `options` are read once. `data`, `appearance`,
`viewport`, and telemetry props are reactive. Bulk data buffers transfer to the
renderer; use a fresh data object for every update. React Strict Mode's
development effect probe is handled without transferring the initial data twice,
and a dataset supplied before the chart finishes initializing is installed once
it is ready rather than sent twice.

React 19.2+'s `Activity` can hide and reveal a mounted chart without recreating its
canvas or renderer, copying data, or retransferring detached buffers. Prop updates
and readiness/error notifications wait until reveal; stats and series-visibility
callbacks are disconnected while hidden. `onReady` runs once per chart instance.
It runs only after the first successful reactive prop batch. A rejected prop
install reports `onError`; replacement valid props can recover without remounting
and deliver the pending `onReady` notification.
Renderer failures are terminal and require a remount; they do not become ready
again when props change.
The retained renderer still owns its memory and worker until the component is
actually unmounted, including when it is unmounted while hidden.
React disconnects the forwarded ref while hidden; a previously captured handle
also returns `null` from `.chart` until reveal. React 18 and earlier React 19
releases use passive cleanup to destroy charts on unmount, including charts
hidden by a re-suspended `Suspense` boundary.

Renderer stats are collected only while `onStats` is supplied. Leaving
`viewportAnimated` unset inherits the chart's own `animated` option; setting it
overrides that per update.

`onError` reports construction errors, renderer startup/runtime failures, and
overlay resolution or renderer-delivery failures. Renderer and overlay failures
can be narrowed with `ChartRendererError` and `ChartOverlayError` from the
installed chart engine.

## Licensing

This package is source-available under the
[PolyForm Noncommercial License 1.0.0](./LICENSE).

For current licensing, commercial terms, and prices, see
[Licensing and Commercial Terms](https://sixtyfold.dev/en/commercial-terms)
and [Pricing](https://sixtyfold.dev/en/pricing).
