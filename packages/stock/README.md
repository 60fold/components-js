# `@sixtyfold/stock`

Canvas2D OHLCV and candlestick charts with indicators, price lines, event
markers, volume profiles, and continuous or compressed market-time scales.

```bash
pnpm add @sixtyfold/stock
```

## Million-candle quickstart

Range buttons are ordinary application UI. For example:

```html
<nav aria-label="Chart range">
  <button type="button" data-stock-range="1D">1D</button>
  <button type="button" data-stock-range="1M">1M</button>
  <button type="button" data-stock-range="6M">6M</button>
  <button type="button" data-stock-range="ALL">All</button>
  <button type="button" data-stock-days="14">14 days</button>
</nav>
<canvas id="market-chart" aria-label="Synthetic million-candle market history"></canvas>
```

```ts
import { StockChart, type TimeRange } from "@sixtyfold/stock";

const MINUTE = 60_000;
const DAY = 86_400_000;

function createMarketData(count = 1_000_000) {
  const timestamp = new Float64Array(count);
  const open = new Float64Array(count);
  const high = new Float64Array(count);
  const low = new Float64Array(count);
  const close = new Float64Array(count);
  const volume = new Float64Array(count);
  const start = Date.UTC(2024, 0, 1);
  let previous = 420;

  for (let index = 0; index < count; index++) {
    const target = 420 + Math.sin(index / 80_000) * 34 + Math.sin(index / 17_000) * 16;
    const movement =
      (target - previous) * 0.002 + Math.sin(index * 0.73) * 0.42 + Math.sin(index * 0.017) * 0.18;
    const next = Math.max(20, previous + movement);
    const spread = 0.25 + Math.abs(Math.sin(index * 0.13)) * 0.9;

    timestamp[index] = start + index * MINUTE;
    open[index] = previous;
    close[index] = next;
    high[index] = Math.max(previous, next) + spread;
    low[index] = Math.min(previous, next) - spread;
    volume[index] = 2_400 + Math.abs(movement) * 7_500 + (index % 1_440) * 0.8;
    previous = next;
  }

  return { timestamp, open, high, low, close, volume, length: count };
}

const data = createMarketData();
const latestTimestamp = data.timestamp[data.length - 1];
const chart = new StockChart(document.querySelector<HTMLCanvasElement>("#market-chart")!, {
  timeScale: "market",
  showVolume: true,
  candleColors: { up: "#26a69a", down: "#ef5350" },
});

await chart.initialize();
chart.setData(data);
chart.setTimeRange("6M");

const ranges: Record<string, TimeRange> = {
  "[data-stock-range='1D']": "1D",
  "[data-stock-range='1M']": "1M",
  "[data-stock-range='6M']": "6M",
  "[data-stock-range='ALL']": "ALL",
};

for (const [selector, range] of Object.entries(ranges)) {
  document.querySelector(selector)?.addEventListener("click", () => {
    chart.setTimeRange(range);
  });
}

document.querySelector("[data-stock-days='14']")?.addEventListener("click", () => {
  chart.setViewport({
    xMin: latestTimestamp - 14 * DAY,
    xMax: latestTimestamp,
  });
});

// Release the worker, observers, and event handlers when the view unmounts.
// chart.destroy();
```

This installs one million candles across six typed-array columns—six million
generated OHLCV values. Worker rendering transfers the supplied buffers, which
is why the example captures `latestTimestamp` before calling `setData()`.

`StockChart` never inserts buttons or other controls around the supplied
canvas. Build any labels and control set in your application, call
`setTimeRange()` for the exported calendar/session presets, or call
`setViewport()` with timestamps for an arbitrary range. Omit application
controls entirely when direct wheel, pointer, touch, and keyboard navigation is
enough.

Provide a localized canvas name and an adjacent summary or table for production
charts. Keyboard semantics and framework-specific attributes are documented in
the [accessibility integration guide](https://github.com/60fold/components-js/blob/main/ACCESSIBILITY.md).

Pure OHLCV utilities, analytics, and market-layer types are exported from
`@sixtyfold/stock/ohlcv`, `/analytics`, and `/market-layers`.

For live dashboards that must not rescale as new extrema arrive, construct the
chart with `yDomain: { min, max }`. Either edge may be omitted to keep that side
auto-scaled; omitting `yDomain` preserves the default visible-candle
auto-scaling.

## Estimated volume profiles

The optional visible-range volume profile is derived from OHLCV candles. It
distributes each candle's volume uniformly across the candle's reported
low-to-high range, separates bullish and bearish volume, highlights the
point-of-control row, and derives the configured value area from adjacent price
rows. Wider horizontal bars represent more estimated volume around that price.

OHLCV candles do not contain individual trades-at-price, so this layer is an
approximation rather than exact order-flow data. Long visible ranges use a
bounded aggregated source; zoomed-in ranges use raw candles.

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
