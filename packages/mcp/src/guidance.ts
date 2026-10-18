import {
  DATA_SHAPE_FORMATS,
  DATA_TIME_UNITS,
  DEVELOPER_GUIDANCE,
} from "./developer-guidance.generated.js";

export { DATA_SHAPE_FORMATS, DATA_TIME_UNITS };

export const COMPONENTS = ["line", "stock"] as const;
export const FRAMEWORKS = ["vanilla", "react", "vue", "angular", "svelte", "solid"] as const;
export const RENDER_MODES = ["auto", "worker", "main"] as const;

export type ComponentKind = (typeof COMPONENTS)[number];
export type FrameworkKind = (typeof FRAMEWORKS)[number];
export type ChartRenderMode = (typeof RENDER_MODES)[number];
export type DataShapeFormat = (typeof DATA_SHAPE_FORMATS)[number];
export type DataTimeUnit = (typeof DATA_TIME_UNITS)[number];

export interface DataShapeDescription {
  /** Shape presented by the application before conversion to chart-owned typed arrays. */
  readonly format?: DataShapeFormat;
  /** Source field containing time values. */
  readonly timeField?: string;
  /** Unit or representation used by the source time field. */
  readonly timeUnit?: DataTimeUnit;
  /** Line value fields. One field creates TimeSeriesData; several create MultiSeriesData. */
  readonly valueFields?: readonly string[];
  /** Stock source-field mappings. */
  readonly openField?: string;
  readonly highField?: string;
  readonly lowField?: string;
  readonly closeField?: string;
  readonly volumeField?: string;
  /** Used only for performance notes; source data itself is never sent to the MCP server. */
  readonly estimatedRows?: number;
}

export interface PackageRecommendation {
  readonly packages: readonly string[];
  readonly installCommand: string;
  readonly rationale: readonly string[];
}

export interface IntegrationRecipe extends PackageRecommendation {
  readonly component: ComponentKind;
  readonly framework: FrameworkKind;
  readonly code: string;
  readonly notes: readonly string[];
  readonly dataShape?: DataShapeDescription;
}

export interface OptionsValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly unknownKeys: readonly string[];
}

export interface PerformanceRecommendation {
  readonly renderMode: ChartRenderMode;
  readonly lod?: {
    readonly mode: "adaptive";
    readonly density: number;
    readonly rebaseRatio: number;
    readonly quantizationStep: number;
  };
  readonly recommendations: readonly string[];
  readonly caveat: string;
}

const FRAMEWORK_PACKAGE: Readonly<Record<Exclude<FrameworkKind, "vanilla">, string>> = {
  react: "@sixtyfold/react",
  vue: "@sixtyfold/vue",
  angular: "@sixtyfold/angular",
  svelte: "@sixtyfold/svelte",
  solid: "@sixtyfold/solid",
};

const ENGINE_PACKAGE: Readonly<Record<ComponentKind, string>> = {
  line: "@sixtyfold/line",
  stock: "@sixtyfold/stock",
};

const FRAMEWORK_ENTRY_POINT: Readonly<
  Record<Exclude<FrameworkKind, "vanilla">, Readonly<Record<ComponentKind, string>>>
> = {
  react: {
    line: "@sixtyfold/react/line",
    stock: "@sixtyfold/react/stock",
  },
  vue: {
    line: "@sixtyfold/vue/line",
    stock: "@sixtyfold/vue/stock",
  },
  angular: {
    line: "@sixtyfold/angular/line",
    stock: "@sixtyfold/angular/stock",
  },
  svelte: {
    line: "@sixtyfold/svelte/line",
    stock: "@sixtyfold/svelte/stock",
  },
  solid: {
    line: "@sixtyfold/solid/line",
    stock: "@sixtyfold/solid/stock",
  },
};

const BASE_OPTION_KEYS = new Set([
  "padding",
  "animated",
  "keepAliveInterval",
  "wheelZoomSpeed",
  "wheelZoomDirection",
  "minViewportRange",
  "yDomain",
  "keyboardZoomSpeed",
  "keyboardPanSpeed",
  "keyboardActivation",
  "interactive",
  "renderMode",
  "textDirection",
  "grid",
  "axis",
  "chartBackground",
  "rangeSelector",
  "tooltip",
  "crosshairStyle",
  "selection",
  "labels",
  "overlay",
]);

const LINE_OPTION_KEYS = new Set([
  ...BASE_OPTION_KEYS,
  "interpolation",
  "series",
  "marker",
  "legend",
  "lod",
]);

const STOCK_OPTION_KEYS = new Set([
  ...BASE_OPTION_KEYS,
  "showVolume",
  "volumeOpacity",
  "volumeHeightRatio",
  "volumeColors",
  "crosshairMarkerColor",
  "candleStyle",
  "candleColors",
  "candleStrokeWidth",
  "previewLineColor",
  "priceUnit",
  "volumeUnit",
  "indicators",
  "volumeProfile",
  "priceLines",
  "markers",
  "timeScale",
  "showLeftPriceMarker",
  "showRightPriceMarker",
  "onCrosshairMove",
  "onTimeRangeChange",
  "onVisibleRangeChange",
]);

function assertComponent(value: unknown): asserts value is ComponentKind {
  if (!COMPONENTS.includes(value as ComponentKind)) {
    throw new TypeError(`Unknown chart component: ${String(value)}`);
  }
}

function assertFramework(value: unknown): asserts value is FrameworkKind {
  if (!FRAMEWORKS.includes(value as FrameworkKind)) {
    throw new TypeError(`Unknown framework: ${String(value)}`);
  }
}

function assertRenderMode(value: unknown): asserts value is ChartRenderMode {
  if (!RENDER_MODES.includes(value as ChartRenderMode)) {
    throw new TypeError(`Unknown render mode: ${String(value)}`);
  }
}

/** Recommend only the independently published packages needed by an application. */
export function recommendPackages(input: {
  component: ComponentKind;
  framework?: FrameworkKind;
  ssr?: boolean;
  themes?: boolean;
}): PackageRecommendation {
  return recommendPackagesForVersion(input);
}

export function recommendPackagesForVersion(
  input: Parameters<typeof recommendPackages>[0],
  releaseVersion?: string,
): PackageRecommendation {
  assertComponent(input.component);
  const framework = input.framework ?? "vanilla";
  assertFramework(framework);
  const packages = [`@sixtyfold/${input.component}`];
  const rationale = [`@sixtyfold/${input.component} provides the ${input.component} chart engine.`];

  if (framework !== "vanilla") {
    packages.push(FRAMEWORK_PACKAGE[framework]);
    rationale.push(
      `${FRAMEWORK_PACKAGE[framework]} owns ${framework} mount, cleanup and reactive updates.`,
    );
  }
  if (input.themes) {
    packages.push("@sixtyfold/themes");
    rationale.push("@sixtyfold/themes provides immutable line and stock appearance presets.");
  }
  if (input.ssr) {
    packages.push("@sixtyfold/ssr");
    rationale.push("@sixtyfold/ssr provides DOM-independent Node.js rendering.");
  }

  return {
    packages,
    installCommand: `pnpm add ${packages
      .map((packageName) => (releaseVersion?.includes("-") ? `${packageName}@next` : packageName))
      .join(" ")}`,
    rationale,
  };
}

interface NormalizedDataShape {
  readonly format: DataShapeFormat;
  readonly timeField: string;
  readonly timeUnit: DataTimeUnit;
  readonly valueFields: readonly string[];
  readonly openField: string;
  readonly highField: string;
  readonly lowField: string;
  readonly closeField: string;
  readonly volumeField: string;
  readonly estimatedRows?: number;
}

function normalizeField(value: string | undefined, fallback: string): string {
  const field = value?.trim() || fallback;
  // Control characters and closing tags cannot be safe source identifiers.
  // oxlint-disable-next-line no-control-regex
  if (field.length > 80 || /[\u0000-\u001f\u007f]|<\//u.test(field)) {
    throw new TypeError(`Invalid source field name: ${JSON.stringify(field)}`);
  }
  return field;
}

function normalizeDataShape(
  component: ComponentKind,
  input: DataShapeDescription,
): NormalizedDataShape {
  const lineDefaults = DEVELOPER_GUIDANCE.scaffold.defaults.line;
  const stockDefaults = DEVELOPER_GUIDANCE.scaffold.defaults.stock;
  if (!DATA_SHAPE_FORMATS.includes(input.format ?? "object-rows")) {
    throw new TypeError(`Unknown data shape format: ${String(input.format)}`);
  }
  if (!DATA_TIME_UNITS.includes(input.timeUnit ?? "epoch-milliseconds")) {
    throw new TypeError(`Unknown time unit: ${String(input.timeUnit)}`);
  }
  const valueFields = [
    ...new Set(
      (input.valueFields ?? (component === "line" ? lineDefaults.valueFields : []))
        .map((field) => normalizeField(field, ""))
        .filter(Boolean),
    ),
  ];
  if (component === "line" && valueFields.length === 0) {
    throw new TypeError("A line data shape needs at least one value field");
  }
  if (valueFields.length > 16) {
    throw new TypeError("A line data shape supports at most 16 value fields");
  }
  const timeField = normalizeField(
    input.timeField,
    component === "line" ? lineDefaults.timeField : stockDefaults.timeField,
  );
  const openField = normalizeField(input.openField, stockDefaults.openField);
  const highField = normalizeField(input.highField, stockDefaults.highField);
  const lowField = normalizeField(input.lowField, stockDefaults.lowField);
  const closeField = normalizeField(input.closeField, stockDefaults.closeField);
  const volumeField = normalizeField(input.volumeField, stockDefaults.volumeField);
  if (component === "line" && valueFields.includes(timeField)) {
    throw new TypeError("The line time field cannot also be a value field");
  }
  if (
    component === "stock" &&
    new Set([timeField, openField, highField, lowField, closeField, volumeField]).size !== 6
  ) {
    throw new TypeError("Stock time and OHLCV source fields must be distinct");
  }
  return {
    format: input.format ?? "object-rows",
    timeField,
    timeUnit: input.timeUnit ?? "epoch-milliseconds",
    valueFields,
    openField,
    highField,
    lowField,
    closeField,
    volumeField,
    estimatedRows:
      input.estimatedRows === undefined ? undefined : Math.max(0, Math.trunc(input.estimatedRows)),
  };
}

function fieldAccess(owner: string, field: string): string {
  return `${owner}[${JSON.stringify(field)}]`;
}

function timestampExpression(value: string, unit: DataTimeUnit): string {
  if (unit === "iso-string") return `Date.parse(String(${value}))`;
  if (unit === "epoch-seconds") return `Number(${value}) * 1_000`;
  return `Number(${value})`;
}

function sampleTime(index: number, unit: DataTimeUnit): number | string {
  if (unit === "iso-string") return `2026-01-0${index + 1}T00:00:00.000Z`;
  const milliseconds = Date.UTC(2026, 0, index + 1);
  return unit === "epoch-seconds" ? milliseconds / 1_000 : milliseconds;
}

function objectLiteral(entries: ReadonlyArray<readonly [string, number | string]>): string {
  return `{ ${entries
    .map(([field, value]) => `[${JSON.stringify(field)}]: ${JSON.stringify(value)}`)
    .join(", ")} }`;
}

function sourceRows(component: ComponentKind, shape: NormalizedDataShape): string {
  return [0, 1, 2]
    .map((index) => {
      const entries: Array<readonly [string, number | string]> = [
        [shape.timeField, sampleTime(index, shape.timeUnit)],
      ];
      if (component === "line") {
        shape.valueFields.forEach((field, fieldIndex) => {
          entries.push([field, 10 + index * 3 + fieldIndex * 5]);
        });
      } else {
        const open = 100 + index * 2;
        entries.push(
          [shape.openField, open],
          [shape.highField, open + 3],
          [shape.lowField, open - 2],
          [shape.closeField, open + 1],
          [shape.volumeField, 1_000 + index * 120],
        );
      }
      return `  ${objectLiteral(entries)}`;
    })
    .join(",\n");
}

function sourceColumns(component: ComponentKind, shape: NormalizedDataShape): string {
  const fields: Array<readonly [string, readonly (number | string)[]]> = [
    [shape.timeField, [0, 1, 2].map((index) => sampleTime(index, shape.timeUnit))],
  ];
  if (component === "line") {
    shape.valueFields.forEach((field, fieldIndex) => {
      fields.push([field, [10 + fieldIndex * 5, 13 + fieldIndex * 5, 16 + fieldIndex * 5]]);
    });
  } else {
    fields.push(
      [shape.openField, [100, 102, 104]],
      [shape.highField, [103, 105, 107]],
      [shape.lowField, [98, 100, 102]],
      [shape.closeField, [101, 103, 105]],
      [shape.volumeField, [1_000, 1_120, 1_240]],
    );
  }
  return fields
    .map(([field, values]) => `  [${JSON.stringify(field)}]: ${JSON.stringify(values)}`)
    .join(",\n");
}

function scaffoldSource(
  component: ComponentKind,
  shape: NormalizedDataShape,
): {
  readonly declaration: string;
  readonly argument: string;
  readonly parameterType: string;
  readonly length: string;
  readonly row: string;
  readonly value: (field: string) => string;
} {
  if (shape.format === "object-rows") {
    return {
      declaration: `type SourceRow = Readonly<Record<string, unknown>>;
const sourceRows: readonly SourceRow[] = [
${sourceRows(component, shape)}
];`,
      argument: "sourceRows",
      parameterType: "readonly SourceRow[]",
      length: "source.length",
      row: "    const row = source[index];\n",
      value: (field) => fieldAccess("row", field),
    };
  }
  return {
    declaration: `type SourceColumns = Readonly<Record<string, ArrayLike<unknown>>>;
const sourceColumns: SourceColumns = {
${sourceColumns(component, shape)}
};`,
    argument: "sourceColumns",
    parameterType: "SourceColumns",
    length: `${fieldAccess("source", shape.timeField)}.length`,
    row: "",
    value: (field) => `${fieldAccess("source", field)}[index]`,
  };
}

function lineShapeData(shape: NormalizedDataShape): string {
  const source = scaffoldSource("line", shape);
  const declarations = shape.valueFields
    .map((_, index) => `  const values${index} = new Float64Array(length);`)
    .join("\n");
  const conversions = shape.valueFields
    .map((field, index) => {
      const sourceValue = source.value(field);
      return `    const value${index} = Number(${sourceValue});
    if (!Number.isFinite(value${index})) throw new TypeError(${JSON.stringify(`Invalid ${field} value at row `)} + index);
    values${index}[index] = value${index};`;
    })
    .join("\n");
  const result =
    shape.valueFields.length === 1
      ? "  return { x, y: values0, length };"
      : `  return {
    x,
    series: [${shape.valueFields.map((_, index) => `values${index}`).join(", ")}],
    length,
    seriesCount: ${shape.valueFields.length},
  };`;
  return `${source.declaration}

function toLineChartData(source: ${source.parameterType}) {
  const length = ${source.length};
  const x = new Float64Array(length);
${declarations}

  for (let index = 0; index < length; index += 1) {
${source.row}    const timestamp = ${timestampExpression(source.value(shape.timeField), shape.timeUnit)};
    if (!Number.isFinite(timestamp)) throw new TypeError("Invalid timestamp at row " + index);
    x[index] = timestamp;
${conversions}
  }

${result}
}

const data = toLineChartData(${source.argument});`;
}

function stockShapeData(shape: NormalizedDataShape): string {
  const source = scaffoldSource("stock", shape);
  const fields = [
    ["open", shape.openField],
    ["high", shape.highField],
    ["low", shape.lowField],
    ["close", shape.closeField],
    ["volume", shape.volumeField],
  ] as const;
  const conversions = fields
    .map(
      ([column, field]) => `    const ${column}Value = Number(${source.value(field)});
    if (!Number.isFinite(${column}Value)) throw new TypeError(${JSON.stringify(`Invalid ${field} value at row `)} + index);
    ${column}[index] = ${column}Value;`,
    )
    .join("\n");
  return `${source.declaration}

function toStockChartData(source: ${source.parameterType}) {
  const length = ${source.length};
  const timestamp = new Float64Array(length);
  const open = new Float64Array(length);
  const high = new Float64Array(length);
  const low = new Float64Array(length);
  const close = new Float64Array(length);
  const volume = new Float64Array(length);

  for (let index = 0; index < length; index += 1) {
${source.row}    const timestampValue = ${timestampExpression(source.value(shape.timeField), shape.timeUnit)};
    if (!Number.isFinite(timestampValue)) throw new TypeError("Invalid timestamp at row " + index);
    timestamp[index] = timestampValue;
${conversions}
  }

  return { timestamp, open, high, low, close, volume, length };
}

const data = toStockChartData(${source.argument});`;
}

function integrationData(component: ComponentKind, shape: NormalizedDataShape | undefined): string {
  if (!shape) return component === "line" ? lineData() : stockData();
  return component === "line" ? lineShapeData(shape) : stockShapeData(shape);
}

function lineData(): string {
  return `const data = {
  x: new Float64Array([0, 1, 2, 3]),
  y: new Float64Array([4, 8, 6, 12]),
  length: 4,
};`;
}

function stockData(): string {
  return `const data = {
  timestamp: new Float64Array([0, 60_000, 120_000]),
  open: new Float64Array([10, 11, 12]),
  high: new Float64Array([12, 13, 14]),
  low: new Float64Array([9, 10, 11]),
  close: new Float64Array([11, 12, 13]),
  volume: new Float64Array([100, 120, 140]),
  length: 3,
};`;
}

function vanillaRecipe(
  component: ComponentKind,
  renderMode: ChartRenderMode,
  shape?: NormalizedDataShape,
): string {
  const className = component === "line" ? "LineChart" : "StockChart";
  const installMethod =
    component === "line" && shape && shape.valueFields.length > 1
      ? "setMultiSeriesData"
      : "setData";
  return `import { ${className} } from "${ENGINE_PACKAGE[component]}";

${integrationData(component, shape)}

const canvas = document.querySelector<HTMLCanvasElement>("#chart");
if (!canvas) throw new Error("Chart canvas was not found");

const chart = new ${className}(canvas, {
  renderMode: "${renderMode}",
});

await chart.initialize();
chart.${installMethod}(data);

// Call this when the view is permanently removed.
export function disposeChart() {
  chart.destroy();
}`;
}

function reactRecipe(
  component: ComponentKind,
  renderMode: ChartRenderMode,
  shape?: NormalizedDataShape,
): string {
  const name = component === "line" ? "SixtyfoldLineChart" : "SixtyfoldStockChart";
  return `import { ${name} } from "${FRAMEWORK_ENTRY_POINT.react[component]}";

${integrationData(component, shape)}

export function ChartPanel() {
  return (
    <div style={{ height: 420 }}>
      <${name}
        data={data}
        options={{ renderMode: "${renderMode}" }}
        onError={(error) => console.error(error)}
      />
    </div>
  );
}`;
}

function vueRecipe(
  component: ComponentKind,
  renderMode: ChartRenderMode,
  shape?: NormalizedDataShape,
): string {
  const name = component === "line" ? "SixtyfoldLineChart" : "SixtyfoldStockChart";
  return `<script setup lang="ts">
import { shallowRef } from "vue";
import { ${name} } from "${FRAMEWORK_ENTRY_POINT.vue[component]}";

${integrationData(component, shape)}
const chartData = shallowRef(data);
</script>

<template>
  <div style="height: 420px">
    <${name}
      :data="chartData"
      :options="{ renderMode: '${renderMode}' }"
      @error="console.error"
    />
  </div>
</template>`;
}

function angularRecipe(
  component: ComponentKind,
  renderMode: ChartRenderMode,
  shape?: NormalizedDataShape,
): string {
  const className =
    component === "line" ? "SixtyfoldLineChartComponent" : "SixtyfoldStockChartComponent";
  const selector = component === "line" ? "sixtyfold-line-chart" : "sixtyfold-stock-chart";
  return `import { Component } from "@angular/core";
import { ${className} } from "${FRAMEWORK_ENTRY_POINT.angular[component]}";

${shape ? `${integrationData(component, shape)}\n\n` : ""}
@Component({
  standalone: true,
  imports: [${className}],
  template: \`
    <div style="height:420px">
      <${selector} [data]="data" [options]="options" />
    </div>
  \`,
})
export class ChartPanel {
  readonly options = { renderMode: "${renderMode}" as const };
  readonly data = ${shape ? "data;" : component === "line" ? lineData().replace("const data = ", "") : stockData().replace("const data = ", "")}
}`;
}

function svelteRecipe(
  component: ComponentKind,
  renderMode: ChartRenderMode,
  shape?: NormalizedDataShape,
): string {
  const name = component === "line" ? "LineChart" : "StockChart";
  return `<script lang="ts">
  import ${name} from "${FRAMEWORK_ENTRY_POINT.svelte[component]}";

  ${integrationData(component, shape).replace(/\n/g, "\n  ")}
</script>

<div style="height: 420px">
  <${name}
    {data}
    options={{ renderMode: "${renderMode}" }}
    onError={(error) => console.error(error)}
  />
</div>`;
}

function solidRecipe(
  component: ComponentKind,
  renderMode: ChartRenderMode,
  shape?: NormalizedDataShape,
): string {
  const name = component === "line" ? "SixtyfoldLineChart" : "SixtyfoldStockChart";
  return `import { ${name} } from "${FRAMEWORK_ENTRY_POINT.solid[component]}";

${integrationData(component, shape)}

export function ChartPanel() {
  return (
    <div style={{ height: "420px" }}>
      <${name}
        data={data}
        options={{ renderMode: "${renderMode}" }}
        onError={(error) => console.error(error)}
      />
    </div>
  );
}`;
}

/** Generate a small integration recipe from the same imports exercised by framework CI. */
export function generateIntegration(input: {
  component: ComponentKind;
  framework?: FrameworkKind;
  renderMode?: ChartRenderMode;
  ssr?: boolean;
  themes?: boolean;
  dataShape?: DataShapeDescription;
}): IntegrationRecipe {
  return generateIntegrationForVersion(input);
}

export function generateIntegrationForVersion(
  input: Parameters<typeof generateIntegration>[0],
  releaseVersion?: string,
): IntegrationRecipe {
  assertComponent(input.component);
  const framework = input.framework ?? "vanilla";
  assertFramework(framework);
  const renderMode = input.renderMode ?? "auto";
  assertRenderMode(renderMode);
  const dataShape = input.dataShape
    ? normalizeDataShape(input.component, input.dataShape)
    : undefined;
  const recommendation = recommendPackagesForVersion(
    {
      component: input.component,
      framework,
      ssr: input.ssr,
      themes: input.themes,
    },
    releaseVersion,
  );
  const recipes: Record<FrameworkKind, () => string> = {
    vanilla: () => vanillaRecipe(input.component, renderMode, dataShape),
    react: () => reactRecipe(input.component, renderMode, dataShape),
    vue: () => vueRecipe(input.component, renderMode, dataShape),
    angular: () => angularRecipe(input.component, renderMode, dataShape),
    svelte: () => svelteRecipe(input.component, renderMode, dataShape),
    solid: () => solidRecipe(input.component, renderMode, dataShape),
  };
  const notes = [
    "Give the canvas host a concrete height; width can remain responsive.",
    "Typed-array buffers are transferred in worker mode. Clone them first if the application must retain a readable copy.",
    "Framework adapters destroy their chart automatically. Vanilla integrations must call destroy() when the view is permanently removed.",
  ];
  if (framework !== "vanilla") {
    notes.push(
      "Readiness fires once after renderer initialization and the first successful batch of data, appearance, and viewport props. It does not wait for a painted frame.",
      "Rejected prop installations report the adapter error callback/event; corrected props can recover without remounting and successfully installed data is not transferred again. Renderer failures are terminal and require a remount.",
    );
  }
  if (framework === "react") {
    notes.push(
      "React 19.2+ Activity retains the chart and worker while hidden. The forwarded ref is disconnected and a captured handle's .chart is null; prop updates and readiness/error notifications wait for reveal, while stats and series-visibility callbacks are disconnected. Permanent unmount destroys the retained chart. React 18 and earlier React 19 releases dispose on unmount, including hidden Suspense trees.",
    );
  }
  if (framework === "vue") {
    notes.push(
      "Stats collection follows listener presence, including reactive listener-array mutations. A sole @stats.once listener disables collection after its event; regular listeners keep collection enabled.",
    );
  }
  if (framework === "angular") {
    notes.push(
      "Stats collection follows active stats output subscriptions, including programmatic subscribe/unsubscribe changes; statsIntervalMs is the minimum emission interval.",
    );
  }
  if (input.component === "stock") {
    notes.push(
      "StockChart does not insert time-range controls. Render any buttons or menus in the host application, call setTimeRange() for exported presets, or setViewport() for arbitrary timestamp intervals.",
      "Streaming appends require finite, strictly increasing timestamps across calls and chunks, and six equally sized OHLCV columns. Invalid stock input is rejected before transferring buffers; duplicate timestamps are not in-place candle updates. Static setData can normalize ascending or descending monotonic history.",
    );
  } else {
    notes.push(
      "Line streaming requires finite timestamps and one value per configured series. addVectors validates aligned Float64Array columns before flushing queued scalar samples or transferring buffers. addVector snapshots its values, so callers may reuse the input array.",
    );
  }
  if (dataShape) {
    notes.push(
      `The generated ${dataShape.format} adapter converts ${dataShape.timeUnit} source time values into epoch-millisecond Float64Array data.`,
      "Validate and sort complete observations before conversion. The generated adapter rejects invalid timestamps and numeric values.",
    );
    if ((dataShape.estimatedRows ?? 0) >= 100_000) {
      notes.push(
        `For approximately ${dataShape.estimatedRows?.toLocaleString("en-US")} rows, run the generated conversion in a dedicated data worker and transfer the resulting typed arrays once.`,
      );
    }
  }
  if (input.themes) {
    notes.push(
      `Load a preset with getThemePreset() and apply its ${input.component}.appearance patch after readiness.`,
    );
  }
  if (input.ssr) {
    notes.push(
      "Use @sixtyfold/ssr for the server image and let the browser wrapper initialize its own interactive canvas after mount.",
    );
  }

  return {
    ...recommendation,
    component: input.component,
    framework,
    code: recipes[framework](),
    notes,
    dataShape: input.dataShape,
  };
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Run a deterministic top-level configuration preflight; TypeScript remains authoritative. */
export function validateChartOptions(
  component: ComponentKind,
  options: Readonly<Record<string, unknown>>,
): OptionsValidation {
  assertComponent(component);
  const errors: string[] = [];
  const warnings: string[] = [];
  const allowed = component === "line" ? LINE_OPTION_KEYS : STOCK_OPTION_KEYS;
  const unknownKeys = Object.keys(options)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unknownKeys.length > 0) {
    errors.push(
      `Unknown ${component} option${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`,
    );
  }

  const renderMode = options.renderMode;
  if (renderMode !== undefined && !RENDER_MODES.includes(renderMode as ChartRenderMode)) {
    errors.push('renderMode must be "auto", "worker", or "main".');
  }
  if (options.minViewportRange !== undefined && !finitePositive(options.minViewportRange)) {
    errors.push("minViewportRange must be a finite positive number in X-data units.");
  }
  if (options.yDomain !== undefined) {
    if (!options.yDomain || typeof options.yDomain !== "object" || Array.isArray(options.yDomain)) {
      errors.push("yDomain must be an object.");
    } else {
      const yDomain = options.yDomain as Record<string, unknown>;
      const unknownYDomain = Object.keys(yDomain)
        .filter((key) => key !== "min" && key !== "max")
        .sort();
      if (unknownYDomain.length > 0) {
        errors.push(`Unknown yDomain option(s): ${unknownYDomain.join(", ")}.`);
      }
      const min = yDomain.min;
      const max = yDomain.max;
      if (min !== undefined && (typeof min !== "number" || !Number.isFinite(min))) {
        errors.push("yDomain.min must be finite.");
      }
      if (max !== undefined && (typeof max !== "number" || !Number.isFinite(max))) {
        errors.push("yDomain.max must be finite.");
      }
      if (
        typeof min === "number" &&
        Number.isFinite(min) &&
        typeof max === "number" &&
        Number.isFinite(max) &&
        max <= min
      ) {
        errors.push("yDomain.max must be greater than yDomain.min.");
      }
    }
  }
  if (component === "line" && options.lod !== undefined) {
    if (!options.lod || typeof options.lod !== "object" || Array.isArray(options.lod)) {
      errors.push("lod must be an object.");
    } else {
      const lod = options.lod as Record<string, unknown>;
      const unknownLod = Object.keys(lod)
        .filter((key) => !["mode", "density", "rebaseRatio", "quantizationStep"].includes(key))
        .sort();
      if (unknownLod.length > 0) errors.push(`Unknown lod option(s): ${unknownLod.join(", ")}.`);
      if (lod.mode !== undefined && lod.mode !== "adaptive" && lod.mode !== "pyramid") {
        errors.push('lod.mode must be "adaptive" or "pyramid".');
      }
      if (
        lod.density !== undefined &&
        (typeof lod.density !== "number" || lod.density < 0.25 || lod.density > 2)
      ) {
        errors.push("lod.density must be between 0.25 and 2.");
      }
      if (
        lod.rebaseRatio !== undefined &&
        (typeof lod.rebaseRatio !== "number" || lod.rebaseRatio < 1.05 || lod.rebaseRatio > 2)
      ) {
        errors.push("lod.rebaseRatio must be between 1.05 and 2.");
      }
      if (
        lod.quantizationStep !== undefined &&
        (typeof lod.quantizationStep !== "number" ||
          lod.quantizationStep < 0.05 ||
          lod.quantizationStep > 1)
      ) {
        errors.push("lod.quantizationStep must be between 0.05 and 1.");
      }
    }
  }

  if (options.renderMode === "worker") {
    warnings.push(
      'Forced worker mode still falls back to the main thread when Worker or OffscreenCanvas is unavailable. Use "auto" unless the distinction is important to diagnostics.',
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    unknownKeys,
  };
}

/** Recommend bounded defaults from workload shape without claiming a device-independent FPS. */
export function recommendPerformanceSettings(input: {
  component: ComponentKind;
  points: number;
  series?: number;
  rangeSeries?: number;
  streaming?: boolean;
}): PerformanceRecommendation {
  assertComponent(input.component);
  const points = Math.max(0, Math.trunc(input.points));
  const series = Math.max(1, Math.trunc(input.series ?? 1));
  const rangeSeries = Math.max(0, Math.trunc(input.rangeSeries ?? 0));
  const totalValues = points * series;
  const recommendations = [
    "Start with renderMode: auto so capable browsers select the OffscreenCanvas worker path.",
    "Pass structure-of-arrays typed data and avoid creating one JavaScript object per observation.",
  ];
  if (totalValues >= 100_000) {
    recommendations.push(
      "Decode or generate bulk data in a dedicated data worker, then transfer the final typed arrays once.",
    );
  }
  if (input.streaming) {
    recommendations.push(
      "Use the bounded streaming APIs and append in batches instead of replacing the full history for every observation.",
    );
  }

  if (input.component === "stock") {
    recommendations.push(
      "Keep indicators on raw candles and let the stock engine choose its visible-range OHLC aggregation.",
    );
    return {
      renderMode: "auto",
      recommendations,
      caveat:
        "Measure the target browsers and devices. Frame rate depends on hardware, browser, pixel ratio, data shape and enabled layers.",
    };
  }

  const density = rangeSeries > 0 || totalValues >= 20_000_000 ? 0.25 : 0.75;
  recommendations.push(
    density === 0.25
      ? "Begin at lod.density 0.25 because range fills or very high aggregate work require multiple Canvas passes."
      : "Begin with the line-chart default lod.density 0.75 and tune only from representative interaction traces.",
    "Keep rebaseRatio 1.25 and quantizationStep 0.25 initially; change one coefficient at a time while testing zoom transitions.",
  );
  return {
    renderMode: "auto",
    lod: {
      mode: "adaptive",
      density,
      rebaseRatio: 1.25,
      quantizationStep: 0.25,
    },
    recommendations,
    caveat:
      "60 FPS is a design target, not a device-independent guarantee. Measure representative browsers, DPRs, series counts and gestures.",
  };
}

/** Map a reported symptom to focused, public-API troubleshooting steps. */
export function diagnoseChart(input: {
  component: ComponentKind;
  symptom: string;
}): readonly string[] {
  assertComponent(input.component);
  const symptom = input.symptom.toLocaleLowerCase("en-US");
  const matches = DEVELOPER_GUIDANCE.failureModes.filter(
    (mode) =>
      (mode.components as readonly string[]).includes(input.component) &&
      mode.keywords.some((keyword) => symptom.includes(keyword.toLocaleLowerCase("en-US"))),
  );
  if (matches.length === 0) {
    return [
      "Inspect the exact option or method with inspect_component_api, then reproduce with renderMode: main and animated: false to separate renderer timing from data/configuration issues.",
    ];
  }
  return matches.flatMap((mode) => [
    `${mode.title}: ${mode.cause}`,
    ...mode.checks,
    ...mode.fixes,
    `${mode.snippet.label}:\n${mode.snippet.code}`,
  ]);
}

export const LICENSING_GUIDE = `# Sixtyfold licensing

This bundled resource provides guardrails only. It is not a copy of the commercial terms and must not be used to infer current plans, prices, scope, refunds, support, or version coverage.

- Public Sixtyfold packages are source-available under the PolyForm Noncommercial License 1.0.0, not OSI-approved open source.
- Separate Sixtyfold terms permit non-production commercial development and testing; obtain the required license before Production Use or Commercial Redistribution.
- The packages and local MCP server implement no account, activation key, or runtime phone-home check.

Use the live website as the authoritative source:

- Pricing: sixtyfold.dev/en/pricing
- Licensing and Commercial Terms: sixtyfold.dev/en/commercial-terms

Reading this resource performs no network request. Open the links separately for current information.
`;

export const PERFORMANCE_GUIDE = `# Sixtyfold performance baseline

- Prefer renderMode: "auto"; large interactive datasets normally resolve to a worker when supported.
- Use Float64Array columns and structure-of-arrays data.
- Decode or generate bulk data in a dedicated data worker.
- Transfer final arrays once, then terminate the data worker.
- Line LOD defaults: adaptive mode, density 0.75, rebase ratio 1.25, quantization step 0.25.
- Range fills and extremely large multi-series work may benefit from density 0.25.
- Measure representative browsers, DPRs and gesture sequences. 60 FPS is a target, not a universal guarantee.
`;

export const OWNERSHIP_GUIDE = `# Typed-array ownership

Bulk chart data is transferred to the renderer in worker mode. Transferred buffers become detached in the caller.
Clone a typed array before setData or setMultiSeriesData only when another subsystem must retain a readable copy.
Framework wrappers follow the same ownership contract and deliberately do not reshape or duplicate bulk data.
`;
