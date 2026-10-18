# Sixtyfold Components

**High-performance TypeScript components for AI, observability, industrial IoT,
and financial markets.**

[![npm: line](https://img.shields.io/npm/v/%40sixtyfold%2Fline?label=line)](https://www.npmjs.com/package/@sixtyfold/line)
[![npm: stock](https://img.shields.io/npm/v/%40sixtyfold%2Fstock?label=stock)](https://www.npmjs.com/package/@sixtyfold/stock)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-2f5f9f)](./LICENSE.md)

## Charts

**20M data points in one interactive chart.**
[See the live demo →](https://sixtyfold.dev)

[Documentation →](https://sixtyfold.dev/docs)

### Line

![Sixtyfold Line chart in the light theme](./docs/assets/line-light.webp#gh-light-mode-only)
![Sixtyfold Line chart in the dark theme](./docs/assets/line-dark.webp#gh-dark-mode-only)

### Stock

![Sixtyfold Stock chart in the light theme](./docs/assets/stock-light.webp#gh-light-mode-only)
![Sixtyfold Stock chart in the dark theme](./docs/assets/stock-dark.webp#gh-dark-mode-only)

## Level of detail

Sixtyfold Charts began with an idea borrowed from 3D games: if a renderer
changes an object's level of detail (LOD) as its distance from the camera
changes, could a chart change its data detail as the user zooms?

The line renderer precalculates extrema-preserving summaries at exponentially
increasing bucket sizes and selects a screen-appropriate level for the current
viewport. Finer detail returns as the user zooms in; coarser summaries bound the
work when zoomed out while retaining important peaks and gaps. These summaries
are rendered on demand rather than stored as pre-rendered images. Stock charts
apply the same principle through OHLCV aggregation levels selected for the
visible time range.

## Available packages

| Package              | Purpose                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `@sixtyfold/core`    | Shared Canvas2D runtime and interaction primitives                                 |
| `@sixtyfold/line`    | Dense time-series and multi-series line charts                                     |
| `@sixtyfold/stock`   | OHLCV, candlestick, and market analytics charts                                    |
| `@sixtyfold/ssr`     | Server-side Canvas2D rendering for line and stock charts in Node.js, Bun, and Deno |
| `@sixtyfold/themes`  | Immutable chart appearance presets                                                 |
| `@sixtyfold/react`   | React line and stock chart adapters                                                |
| `@sixtyfold/vue`     | Vue line and stock chart adapters                                                  |
| `@sixtyfold/angular` | Angular standalone line and stock chart components                                 |
| `@sixtyfold/svelte`  | Svelte line and stock chart components                                             |
| `@sixtyfold/solid`   | SolidJS line and stock chart adapters                                              |
| `@sixtyfold/mcp`     | Local, read-only MCP guidance for packages, APIs, examples, and performance        |

Installing `@sixtyfold/line` never installs `@sixtyfold/stock` or a framework
adapter. Framework packages expose separate `/line` and `/stock` entry points
and declare chart engines as optional peers, so applications add only the
engine and adapter they use.
Themes follow the same boundary through `@sixtyfold/themes/line` and
`@sixtyfold/themes/stock`; either entry point works without installing the
other renderer.

Install the stable packages from npm. For example, a React line-chart
application installs:

```bash
pnpm add @sixtyfold/line @sixtyfold/react
```

## MCP

Coding agents can connect to the independently installed MCP developer tool
without adding anything to the application bundle:

- **Codex:** `codex mcp add sixtyfold -- npx -y @sixtyfold/mcp@1`
- **Claude Code:** `claude mcp add sixtyfold -- npx -y @sixtyfold/mcp@1`
- **Gemini CLI:** `gemini mcp add --scope user sixtyfold npx -y @sixtyfold/mcp@1`

Other MCP hosts can use the equivalent JSON configuration:

```json
{
  "mcpServers": {
    "sixtyfold": {
      "command": "npx",
      "args": ["-y", "@sixtyfold/mcp@1"]
    }
  }
}
```

The local server is read-only, contains its versioned API catalog, makes no
network requests, and never becomes a dependency of a chart package.

## Example

```ts
import { LineChart } from "@sixtyfold/line";

function createSignals(count = 1_000_000) {
  const x = new Float64Array(count);
  const throughput = new Float64Array(count);
  const tailLatency = new Float64Array(count);

  for (let index = 0; index < count; index++) {
    x[index] = Date.UTC(2026, 0, 1) + index * 1_000;
    throughput[index] = 42_000 + Math.sin(index / 4_000) * 8_000;
    tailLatency[index] = 38 + Math.sin(index / 1_100) * 7 + Math.sin(index / 29_000) * 12;
  }

  return {
    x,
    series: [throughput, tailLatency],
    length: count,
    seriesCount: 2,
  };
}

const chart = new LineChart(document.querySelector("canvas")!, {
  renderMode: "worker",
  series: [{ name: "Throughput" }, { name: "p99 latency" }],
});

await chart.initialize();
chart.setMultiSeriesData(createSignals());
```

This sends two million generated series values to the chart. Worker rendering
transfers the typed-array buffers, so generate fresh arrays before installing
the same workload into another chart.

See [sixtyfold.dev](https://sixtyfold.dev) for product documentation, live
examples, commercial licensing, and support.

## Development

This is a pnpm monorepo, but the monorepo is a source-management boundary—not a
consumer installation unit.

Run the complete local release verification with:

```bash
pnpm install
pnpm run predeploy
```

`predeploy` regenerates the MCP guidance and API catalog before running the
complete type, test, package, example, and clean-consumer release checks.

To run an individual gate while diagnosing a failure:

```bash
pnpm run build
pnpm run typecheck
pnpm run test:unit
pnpm run check:mcp-catalog
pnpm run check:examples
pnpm run check:package-release
```

`check:package-release` packs every npm package and installs the tarballs into
clean browser, framework-type, worker, tree-shaking, and server-runtime SSR
consumers. Real Canvas2D PNG output is also verified in pinned Node.js, Bun, and
Deno CI environments.

`check:examples` builds and opens the React, Vue, Angular, Svelte, and SolidJS
examples in Chromium and requires both chart workers to become ready without
console errors or external network requests. See [`examples/`](./examples/).

Report suspected vulnerabilities privately as described in
[SECURITY.md](./SECURITY.md).

## Licensing

Sixtyfold Components is source-available under the
[PolyForm Noncommercial License 1.0.0](./LICENSE.md).

For current licensing, commercial terms, and prices, see
[Licensing and Commercial Terms](https://sixtyfold.dev/en/commercial-terms)
and [Pricing](https://sixtyfold.dev/en/pricing).

Contributions require acceptance of the
[Sixtyfold Contributor License Agreement](./CONTRIBUTOR_LICENSE_AGREEMENT.md),
which permits accepted contributions to be used in both public noncommercial
and commercial editions. See [CONTRIBUTING.md](./CONTRIBUTING.md).
