# @sixtyfold/vue

Vue 3 hosts for Sixtyfold line and stock charts.

```bash
pnpm add @sixtyfold/vue @sixtyfold/line
```

```vue
<script setup lang="ts">
import { shallowRef } from "vue";
import { SixtyfoldLineChart } from "@sixtyfold/vue/line";

const data = shallowRef({
  x: new Float64Array([0, 1, 2, 3]),
  y: new Float64Array([3, 7, 4, 9]),
  length: 4,
});
</script>

<template>
  <SixtyfoldLineChart :data="data" />
</template>
```

Use `@sixtyfold/vue/stock` with `@sixtyfold/stock` for candles. The component
emits `ready`, `error`, and `stats`; line charts also emit
`seriesVisibilityChange`. Construction options are read once.

Hold datasets in `shallowRef` or `markRaw`, and assign a fresh transferable
object for each update. `ref` and `reactive` deep-proxy the surrounding object
graph, which costs more than it buys for bulk data the renderer only reads
once.

Renderer stats are collected only while a `stats` listener can receive them.
A sole `@stats.once` listener stops collection after its first event; ordinary
listeners keep collection enabled. Leaving
`viewportAnimated` unset inherits the chart's own `animated` option; setting it
overrides that per update.

The `error` event reports construction errors, renderer startup/runtime
failures, and overlay resolution or renderer-delivery failures. Renderer and
overlay failures can be narrowed with `ChartRendererError` and
`ChartOverlayError` from the installed chart engine.

`ready` fires once, after renderer initialization and the first successful
batch of data, appearance, and viewport props. It does not wait for a painted
frame. A rejected prop installation reports `error`; supply corrected props
to retry without remounting. Successfully installed data is not transferred again.
Renderer failures are terminal and require remounting the component.

## Licensing

This package is source-available under the
[PolyForm Noncommercial License 1.0.0](./LICENSE).

For current licensing, commercial terms, and prices, see
[Licensing and Commercial Terms](https://sixtyfold.dev/en/commercial-terms)
and [Pricing](https://sixtyfold.dev/en/pricing).
