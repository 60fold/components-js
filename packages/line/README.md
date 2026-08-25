# `@sixtyfold/line`

Canvas2D line and multi-series charts built for interactive, very large
time-series datasets. Worker rendering uses `OffscreenCanvas` when available
and falls back to the main thread.

```bash
pnpm add @sixtyfold/line
```

## Million-point quickstart

```ts
import { LineChart } from "@sixtyfold/line";

function createSignals(count = 1_000_000) {
  const x = new Float64Array(count);
  const throughput = new Float64Array(count);
  const tailLatency = new Float64Array(count);
  const saturation = new Float64Array(count);
  const start = Date.UTC(2026, 0, 1);

  for (let index = 0; index < count; index++) {
    x[index] = start + index * 1_000;
    throughput[index] = 42_000 + Math.sin(index / 4_000) * 8_000;
    tailLatency[index] = 38 + Math.sin(index / 1_100) * 7 + Math.sin(index / 29_000) * 12;
    saturation[index] = 62 + Math.sin(index / 7_500) * 14;
  }

  return {
    x,
    series: [throughput, tailLatency, saturation],
    length: count,
    seriesCount: 3,
  };
}

const chart = new LineChart(document.querySelector<HTMLCanvasElement>("canvas")!, {
  series: [
    { name: "Throughput", color: "#7ce7ff" },
    { name: "p99 latency", color: "#ffcf7a" },
    { name: "Saturation", color: "#ff5ca8" },
  ],
  lod: { mode: "adaptive", density: 0.75 },
});

await chart.initialize();
chart.setMultiSeriesData(createSignals());

// Release the worker, observers, and event handlers when the view unmounts.
// chart.destroy();
```

This installs one million timestamps and three million generated series values.
The default `auto` render mode prefers an `OffscreenCanvas` worker and falls
back to the main thread when necessary. Worker rendering transfers the
typed-array buffers, so generate fresh arrays before installing the same
workload into another chart.

The package is ESM-only. The renderer engine is also available from
`@sixtyfold/line/engine` for SSR and advanced integrations.

Provide a localized canvas name and an adjacent summary or table for production
charts. Keyboard semantics and framework-specific attributes are documented in
the [accessibility integration guide](https://github.com/60fold/components-js/blob/main/ACCESSIBILITY.md).

For live dashboards that must not rescale as new extrema arrive, construct the
chart with `yDomain: { min: 0, max: 100 }`. Either edge may be omitted to keep
that side auto-scaled; omitting `yDomain` preserves the default visible-data
auto-scaling.

For version-aware coding-agent guidance, connect the optional local
`@sixtyfold/mcp` server. It is installed separately and never enters the chart
runtime or browser bundle.

## Third-party notices

Notices for generated runtime helper portions are in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Licensing

This package is source-available under the
[PolyForm Noncommercial License 1.0.0](./LICENSE).

For current licensing, commercial terms, and prices, see
[Licensing and Commercial Terms](https://sixtyfold.dev/en/commercial-terms)
and [Pricing](https://sixtyfold.dev/en/pricing).
