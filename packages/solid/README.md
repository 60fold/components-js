# @sixtyfold/solid

SolidJS hosts for Sixtyfold line and stock charts.

```bash
pnpm add @sixtyfold/solid @sixtyfold/line
```

```tsx
import { SixtyfoldLineChart } from "@sixtyfold/solid/line";

const data = {
  x: new Float64Array([0, 1, 2, 3]),
  y: new Float64Array([3, 7, 4, 9]),
  length: 4,
};

export const Chart = () => <SixtyfoldLineChart data={data} />;
```

Use `@sixtyfold/solid/stock` with `@sixtyfold/stock` for candles. Pass a
`chartRef` callback for the complete imperative instance. Construction options
are read once; data, appearance, viewport, and telemetry props are reactive.
Bulk typed arrays transfer to the renderer, so assign a fresh data object for
each update.

Renderer stats are collected only while `onStats` is supplied. Leaving
`viewportAnimated` unset inherits the chart's own `animated` option; setting it
overrides that per update.

`onError` reports construction errors, renderer startup/runtime failures, and
overlay resolution or renderer-delivery failures. Renderer and overlay failures
can be narrowed with `ChartRendererError` and `ChartOverlayError` from the
installed chart engine.

`onReady` fires once, after renderer initialization and the first successful
batch of data, appearance, and viewport props. It does not wait for a painted
frame. A rejected prop installation reports `onError`; supply corrected props
to retry without remounting. Successfully installed data is not transferred again.
Renderer failures are terminal and require remounting the component.

## Licensing

This package is source-available under the
[PolyForm Noncommercial License 1.0.0](./LICENSE).

For current licensing, commercial terms, and prices, see
[Licensing and Commercial Terms](https://sixtyfold.dev/en/commercial-terms)
and [Pricing](https://sixtyfold.dev/en/pricing).
