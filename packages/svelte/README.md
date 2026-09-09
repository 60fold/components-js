# @sixtyfold/svelte

Svelte 5 components for Sixtyfold line and stock charts.

```bash
pnpm add @sixtyfold/svelte @sixtyfold/line
```

```svelte
<script lang="ts">
  import LineChart from "@sixtyfold/svelte/line";

  const data = {
    x: new Float64Array([0, 1, 2, 3]),
    y: new Float64Array([3, 7, 4, 9]),
    length: 4,
  };
</script>

<LineChart {data} />
```

Use `@sixtyfold/svelte/stock` with `@sixtyfold/stock` for candles. The `chart`
prop is bindable, DOM work is deferred to `onMount`, and workers are destroyed
automatically. Construction options are read once; data, appearance, viewport,
and callback props are reactive. Use a fresh data object for each transferable
bulk update.

`onReady` runs after renderer initialization and after the current data,
appearance, and viewport props have been submitted in one batch. Imperative
changes made inside the callback are not overwritten by the pending initial
reactive update. This callback does not wait for the resulting canvas frame.

Prefer `$state.raw` for datasets. `$state` deep-proxies the surrounding object
graph, which costs more than it buys for bulk data the renderer only reads
once.

Renderer stats are collected only when you supply `onStats`. Leaving
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
