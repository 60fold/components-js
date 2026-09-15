# @sixtyfold/angular

Angular Package Format adapters for Angular 20–22. Both adapters are standalone
components and are safe to render through Angular SSR because chart construction
runs only in the browser.

```bash
pnpm add @sixtyfold/angular @sixtyfold/line
```

```ts
import { Component } from "@angular/core";
import { SixtyfoldLineChartComponent } from "@sixtyfold/angular/line";

@Component({
  standalone: true,
  imports: [SixtyfoldLineChartComponent],
  template: `<sixtyfold-line-chart [data]="data" />`,
})
export class Example {
  data = {
    x: new Float64Array([0, 1, 2, 3]),
    y: new Float64Array([3, 7, 4, 9]),
    length: 4,
  };
}
```

Use `@sixtyfold/angular/stock` with `@sixtyfold/stock` for candles. Outputs are
`chartReady`, `chartError`, and `stats`; the line component also emits
`seriesVisibilityChange`. The public `chart` property exposes the complete
imperative API. Replace rather than mutate bulk data inputs because typed-array
buffers transfer to the renderer.

Renderer stats are collected only while something subscribes to the `stats`
output. Leaving `viewportAnimated` unset inherits the chart's own `animated`
option; setting it overrides that per update.

`chartError` reports construction errors, renderer startup/runtime failures,
and overlay resolution or renderer-delivery failures. Renderer and overlay
failures can be narrowed with `ChartRendererError` and `ChartOverlayError` from
the installed chart engine.

Angular's application builder must copy the packaged worker modules because it
does not transform Vite library worker URLs. Add these entries to the
application build's `assets` array:

```json
[
  { "glob": "**/*", "input": "node_modules/@sixtyfold/line/dist/assets", "output": "assets" },
  { "glob": "**/*", "input": "node_modules/@sixtyfold/stock/dist/assets", "output": "assets" }
]
```

`chartReady` fires once, after renderer initialization and the first successful
batch of data, appearance, and viewport props. It does not wait for a painted
frame. A rejected prop installation reports `chartError`; supply corrected props
to retry without remounting. Successfully installed data is not transferred again.
Renderer failures are terminal and require remounting the component.

## Licensing

This package is source-available under the
[PolyForm Noncommercial License 1.0.0](./LICENSE).

For current licensing, commercial terms, and prices, see
[Licensing and Commercial Terms](https://sixtyfold.dev/en/commercial-terms)
and [Pricing](https://sixtyfold.dev/en/pricing).
