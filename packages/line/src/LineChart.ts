// LineChart component - extends BaseChart for line/multi-series rendering

import type {
  TimeSeriesData,
  MultiSeriesData,
  LineSeriesData,
  RangeSeriesData,
} from "@sixtyfold/core/data/seriesTypes";
import {
  BaseChart,
  BaseChartOptions,
  UnitOptions,
  type DeepPartial,
  type DeepReadonly,
  type BaseAppearanceOptions,
  deepMerge,
} from "@sixtyfold/core/chart/BaseChart";
import { LINE_MIN_RANGE } from "@sixtyfold/core/chart/chartConstants";
import { deepClone } from "@sixtyfold/core/chart/chartStateUtils";
import type { TooltipRenderParams, TooltipRenderResult } from "@sixtyfold/core/types/tooltip";
import ChartWorker from "./chart.worker.ts?worker";
import { deserializeRendererError } from "@sixtyfold/core/internal/renderer";

declare const __SIXTYFOLD_LINE_BENCHMARK__: boolean;
const LINE_RENDER_BENCHMARK_ENABLED =
  typeof __SIXTYFOLD_LINE_BENCHMARK__ !== "undefined" && __SIXTYFOLD_LINE_BENCHMARK__;

/** Gradient definition for series fill */
export interface SeriesGradient {
  /** CSS color stops (minimum 2); invalid colors are skipped. */
  colors: string[];
  /** Gradient direction (default: 'vertical' - top to bottom) */
  direction?: "vertical" | "horizontal";
  /** Optional offset positions for each color (0-1), defaults to evenly distributed */
  offsets?: number[];
}

/** Marker shape for hover point indicators */
export type MarkerShape = "circle" | "square" | "diamond" | "triangle" | "cross" | "x";

/** Line-series drawing style. "band" is an alias for "range"; "points" is an alias for "scatter"; "column" is an alias for "bar"; "stackedArea" is an alias for "stacked-area". */
export type LineSeriesType =
  | "line"
  | "range"
  | "band"
  | "scatter"
  | "points"
  | "bar"
  | "column"
  | "stacked-area"
  | "stackedArea"
  | "step"
  | "step-before"
  | "step-after"
  | "step-mid";

/** Stroke pattern for range/band borders */
export type BandBorderStyle = "solid" | "dashed" | "dotted";

/** Stroke pattern for bar/column borders */
export type BarBorderStyle = "solid" | "dashed" | "dotted";

/** Stroke pattern for stacked-area borders */
export type StackBorderStyle = "solid" | "dashed" | "dotted";

/** Boundary shape for stacked-area fills and borders */
export type StackCurveStyle = "linear" | "step" | "step-before" | "step-after" | "step-mid";

/** Range/band-specific visual options */
export interface BandOptions {
  /** Fill the band.
   *  - false: no band fill
   *  - true: fill with series color at default opacity
   *  - number (0-1): fill with series color at specified opacity */
  fill?: boolean | number;
  /** Band fill color - solid color string or gradient object.
   *  Overrides the fill opacity if specified */
  fillColor?: string | SeriesGradient;
  /** Shared border color for upper and lower boundaries (defaults to series color when a border is enabled) */
  borderColor?: string;
  /** Override color for the upper boundary */
  upperBorderColor?: string;
  /** Override color for the lower boundary */
  lowerBorderColor?: string;
  /** Border width in pixels. Set to 0 to disable borders. */
  borderWidth?: number;
  /** Border line style (default: "solid" when a border is enabled) */
  borderStyle?: BandBorderStyle;
}

/** Bar/column-specific visual options */
export interface BarOptions {
  /** Fill the bars.
   *  - false: no bar fill
   *  - true: fill with series color at default opacity
   *  - number (0-1): fill with series color at specified opacity */
  fill?: boolean | number;
  /** Bar fill color - solid color string or gradient object.
   *  Overrides the fill opacity if specified */
  fillColor?: string | SeriesGradient;
  /** Shared bar border color (defaults to series color when a border is enabled) */
  borderColor?: string;
  /** Border width in pixels. Set to 0 to disable borders. */
  borderWidth?: number;
  /** Border line style (default: "solid" when a border is enabled) */
  borderStyle?: BarBorderStyle;
  /** Fraction of the available sample spacing used by each bar (default: 0.7) */
  widthRatio?: number;
  /** Minimum bar width in pixels (default: 1) */
  minWidth?: number;
  /** Maximum bar width in pixels (default: 24) */
  maxWidth?: number;
  /** Data value that bars grow from (default: 0) */
  baseline?: number;
}

/** Stacked-area-specific visual options */
export interface StackOptions {
  /** Fill the stacked area.
   *  - false: no area fill
   *  - true: fill with series color at default opacity
   *  - number (0-1): fill with series color at specified opacity */
  fill?: boolean | number;
  /** Area fill color - solid color string or gradient object.
   *  Overrides the fill opacity if specified */
  fillColor?: string | SeriesGradient;
  /** Top boundary color (defaults to series color) */
  borderColor?: string;
  /** Top boundary width in pixels (defaults to series width). Set to 0 to disable. */
  borderWidth?: number;
  /** Top boundary line style (default: "solid") */
  borderStyle?: StackBorderStyle;
  /** Boundary shape for the filled band and top border (default: "linear"). */
  curve?: StackCurveStyle;
}

/** Scatter/points-specific visual options */
export interface PointOptions {
  /** Point shape (default: "circle") */
  shape?: MarkerShape;
  /** Point size in pixels — radius for circle, half-width for others (default: 3) */
  size?: number;
  /** Point fill color (defaults to series color) */
  color?: string;
  /** Point opacity 0-1 (default: 1) */
  opacity?: number;
  /** Point border/stroke color (default: "#fff") */
  borderColor?: string;
  /** Point border/stroke width in pixels (default: 0) */
  borderWidth?: number;
}

/** Optional glow effect for hover markers */
export interface MarkerGlowOptions {
  /** Glow color (defaults to marker fill/series color) */
  color?: string;
  /** Glow blur radius in pixels (default: 12) */
  blur?: number;
  /** Glow opacity 0-1 (default: 0.45) */
  opacity?: number;
}

/** Marker options for hover point indicators */
export interface MarkerOptions {
  /** Marker shape (default: "circle") */
  shape?: MarkerShape;
  /** Marker size in pixels — radius for circle, half-width for others (default: 5) */
  size?: number;
  /** Border/stroke color (default: "#fff") */
  borderColor?: string;
  /** Border/stroke width in pixels (default: 1) */
  borderWidth?: number;
  /** Optional glow around the marker */
  glow?: boolean | MarkerGlowOptions;
}

/** Configuration for a single series */
export interface SeriesOptions {
  /** Series display name (used in legend and tooltip). */
  name?: string;
  /** Series drawing style (default: "line"). "step" is an alias for "step-after"; "band" is an alias for "range"; "points" is an alias for "scatter"; "column" is an alias for "bar"; "stackedArea" is an alias for "stacked-area". */
  type?: LineSeriesType;
  /** Line color (falls back to default palette if not specified) */
  color?: string;
  /** Fill the area under the line.
   *  - false: no fill (default)
   *  - true: fill with line color at 40% opacity
   *  - number (0-1): fill with line color at specified opacity */
  fill?: boolean | number;
  /** Fill color - solid color string or gradient object.
   *  Overrides the fill opacity if specified */
  fillColor?: string | SeriesGradient;
  /** Fill to zero baseline instead of chart bottom (default: true)
   *  When true: positive values fill down to zero, negative fill up to zero
   *  When false: always fill to chart bottom */
  fillToZero?: boolean;
  /** Fill style effect
   *  - 'none': flat color fill (default)
   *  - 'glow': soft glow emanating from the line
   *  - 'layered': stacked fills with varying opacity for depth */
  fillEffect?: "none" | "glow" | "layered";
  /** Range/band-specific fill and border styling */
  band?: BandOptions;
  /** Bar/column-specific fill, border, width, and baseline styling */
  bar?: BarOptions;
  /** Stacked-area-specific fill and top-boundary styling */
  stack?: StackOptions;
  /** Scatter/points-specific marker styling */
  point?: PointOptions;
  /** Line stroke width in pixels (default: 1.5). Set to 0 to suppress the
   *  stroke while retaining range fills, tooltips, and other series layers. */
  width?: number;
  /** Unit configuration for this series (used in tooltip and axis labels) */
  unit?: UnitOptions;
  /** Marker style for this series' hover point (overrides chart-level marker) */
  marker?: MarkerOptions;
}

/** Legend placement around chart area */
export type LegendPosition = "left" | "top" | "right" | "bottom";
/** Legend item flow */
export type LegendLayout = "row" | "column";
/** Legend alignment in available legend area */
export type LegendAlign = "left" | "center" | "right" | "middle";
/** Legend swatch shape */
export type LegendSwatchShape = MarkerShape | "line";

export interface LegendSwatchOptions {
  /** Swatch shape (default: "circle") */
  shape?: LegendSwatchShape;
  /** Swatch size in px (default: 10) */
  size?: number;
  /** Swatch border color (default: transparent) */
  borderColor?: string;
  /** Swatch border width in px (default: 0) */
  borderWidth?: number;
}

export interface LegendLabelFontOptions {
  /** Font size in px (default: 12) */
  size?: number;
  /** Font weight (default: "normal") */
  weight?: string | number;
  /** Font style (default: "normal") */
  style?: "normal" | "italic" | "oblique";
  /** Font color (default: "#cfd6e6") */
  color?: string;
  /** Font family (default: DEFAULT_CHART_FONT_FAMILY) */
  family?: string;
  /** Max label text width in px (default: auto/content width) */
  width?: number;
}

export interface LegendOptions {
  /** Show the legend. Defaults to true when `legend` is provided; omitting `legend` disables it. */
  visible?: boolean;
  /** Legend position around chart area (default: "right") */
  position?: LegendPosition;
  /** Alignment in the legend area (default: "center") */
  align?: LegendAlign;
  /** Item layout (default: "column") */
  layout?: LegendLayout;
  /** Enable click-to-toggle interaction (default: false) */
  interactive?: boolean;
  /** Allow hiding all series (default: false) */
  allowHideAll?: boolean;
  /** Legend label font style */
  labelFont?: LegendLabelFontOptions;
  /** Gap between items in px (default: 12) */
  itemGap?: number;
  /** Gap between swatch and label in px (default: 6) */
  swatchGap?: number;
  /** Padding inside legend area in px (default: 8 on all sides) */
  padding?: { top?: number; right?: number; bottom?: number; left?: number };
  /** Opacity for hidden series legend items (default: 0.45) */
  inactiveOpacity?: number;
  /** Swatch style options */
  swatch?: LegendSwatchOptions;
}

export interface LineChartOptions extends BaseChartOptions {
  /** Interpolation mode for values between data points (default: 'linear')
   *  - 'none': no interpolation, snap to nearest data point
   *  - 'linear': linear interpolation between adjacent points
   *  - 'spline': Catmull-Rom spline interpolation for smooth curves */
  interpolation?: "none" | "linear" | "spline";
  /** Per-series configuration (colors, fill, gradients) */
  series?: SeriesOptions[];
  /** Default marker style for hover points (can be overridden per-series) */
  marker?: MarkerOptions;
  /** Series legend options */
  legend?: LegendOptions;
  /** Level-of-detail presentation policy. */
  lod?: LineLODOptions;
}

export interface LineLODOptions {
  /** `adaptive` uses stable viewport-aware screen-space presentation where
   *  supported. `pyramid` selects among the prebuilt global LOD levels. */
  mode?: "adaptive" | "pyramid";
  /** Target presentation columns per CSS pixel and the primary fidelity/work
   *  control (default: 0.75, clamped 0.25–2). Higher values retain more local
   *  detail and increase rendering work. */
  density?: number;
  /** Maximum projected column-width drift before the sticky grid rebases
   *  (default: 1.25, clamped 1.05–2). The lower bound is its reciprocal.
   *  Lower values produce smaller, more frequent representation changes. */
  rebaseRatio?: number;
  /** Additive grid interval inside each binary octave (default: 0.25,
   *  clamped 0.05–1). Smaller values make closer grid widths available and
   *  reduce texture jumps at higher query cost. For smooth transitions, pair
   *  this with a similar rebase scale (for example 0.1 with 1.1–1.12). */
  quantizationStep?: number;
}

/** Line chart appearance — base appearance + legend + marker */
export interface LineAppearanceOptions extends BaseAppearanceOptions {
  legend?: LegendOptions;
  marker?: MarkerOptions;
}

/** Per-series appearance fields — visual + presentation only */
export type SeriesAppearanceOptions = Pick<
  SeriesOptions,
  | "type"
  | "color"
  | "fill"
  | "fillColor"
  | "fillToZero"
  | "fillEffect"
  | "band"
  | "bar"
  | "stack"
  | "point"
  | "width"
  | "name"
  | "unit"
  | "marker"
>;

export interface LineChartStats {
  /** Monotonic generation assigned when the current dataset was installed. */
  dataVersion: number;
  totalPoints: number;
  visiblePoints: number;
  renderedPoints: number;
  renderMode: "worker" | "main";
  fps: number;
  lodLevel: number;
  bucketSize: number;
  /** Active presentation path. Additive diagnostic; bucketSize keeps its storage meaning. */
  presentationMode: "pyramid" | "columns";
  /** Active column-grid policy, or `pyramid` when presentation is inactive. */
  presentationGridPolicy: "pyramid" | "gesture-stable";
  presentationColumns: number;
  presentationVertices: number;
  presentationQueryVisits: number;
  presentationLargestBucket: number;
  presentationGridDelta: number;
  presentationDensity: number;
  presentationRebaseRatio: number;
  presentationQuantizationStep: number;
  frameTime: string;
  firstRenderTime: string;
  /** Current initial-data reveal progress, from 0 to 1. */
  revealProgress: number;
  lodReady: boolean;
  lodBuilt: number;
  lodTotal: number;
  ringBuffer: boolean;
  totalReceived: number;
  bufferUsage: number;
}

export interface LineChartStatsOptions {
  /** Minimum interval between stats updates in milliseconds (default: 250) */
  intervalMs?: number;
}

export interface LineDataUpdateOptions {
  /**
   * Keep the previously rendered plot visible ahead of the reveal boundary
   * while an animated replacement dataset is drawn. The default is false.
   * Wait for the previous reveal to finish before using this option; otherwise
   * its partially revealed frame, including any blank remainder, is retained.
   * The retained pixels are static, so pan or zoom during the new reveal can
   * create a temporary grid/data seam until the transition completes.
   */
  preservePreviousFrame?: boolean;
}

export interface SeriesVisibilityChangeEvent {
  visibility: boolean[];
  changedIndex: number | null;
  visible: boolean | null;
  source: "init" | "api" | "legend";
}

export class LineChart extends BaseChart<LineChartOptions> {
  private onStatsUpdate: ((stats: LineChartStats) => void) | null = null;
  private tooltipOnRender: ((params: TooltipRenderParams) => TooltipRenderResult) | null = null;
  private tooltipVisibleSeries: number[] | null = null;
  private seriesVisibility: boolean[] = [];
  private onSeriesVisibilityChange: ((event: SeriesVisibilityChangeEvent) => void) | null = null;
  private legendEventsAbortController = new AbortController();
  private legendClickInteractionEnabled = false;

  // Batching for high-frequency addVector calls
  private pendingTimestamps: number[] = [];
  private pendingValues: number[][] = [];
  private batchFlushFrame: number | null = null;
  private expectedSeriesCount = 0;
  private dataVersion = 0;

  constructor(canvas: HTMLCanvasElement, options: LineChartOptions = {}) {
    const { cleaned, onRender, onLeave } = BaseChart.stripTooltipCallbacks(options.tooltip);

    const { renderer, useWorker, resolvedRenderMode } = BaseChart.selectChartRenderer(
      canvas,
      options,
      () => new ChartWorker(),
      () => import("./lineRenderer.js").then((m) => m.createLineChartEngine),
      true,
    );

    super(
      canvas,
      renderer,
      {
        ...options,
        ...(cleaned !== undefined ? { tooltip: cleaned } : {}),
      } as LineChartOptions,
      {
        defaultLeftAxis: true,
        defaultRightAxis: false,
        interpolation: options.interpolation ?? "linear",
        seriesOptions: options.series,
        marker: options.marker,
        legend: options.legend,
        lod: {
          mode: "adaptive",
          density: 0.75,
          rebaseRatio: 1.25,
          quantizationStep: 0.25,
          ...options.lod,
        },
      },
      useWorker,
      resolvedRenderMode,
      LINE_MIN_RANGE,
    );
    this.tooltipOnRender = onRender ?? null;
    this.tooltipOnLeave = onLeave ?? null;
    this.tooltipVisibleSeries = options.tooltip?.visibleSeries ?? null;
    this.setLegendClickInteraction(options.legend?.interactive ?? false);
  }

  private handleLegendClick = (event: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.worker.postMessage({
      type: "legendClick",
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  private setLegendClickInteraction(enabled: boolean): void {
    if (this.legendClickInteractionEnabled === enabled) return;
    this.legendEventsAbortController.abort();
    this.legendEventsAbortController = new AbortController();
    this.legendClickInteractionEnabled = enabled;
    if (enabled) {
      this.canvas.addEventListener("click", this.handleLegendClick, {
        signal: this.legendEventsAbortController.signal,
      });
    }
  }

  protected handleWorkerMessage(e: MessageEvent): void {
    const { type, ...data } = e.data;

    switch (type) {
      case "ready":
        this.resolveReady();
        break;

      case "initError":
        this.failRenderer(deserializeRendererError(data.error), "initialization");
        break;

      case "runtimeError":
        this.failRenderer(deserializeRendererError(data.error), "runtime");
        break;

      case "stats":
        this.handleStatsMessage(data);
        if (this.onStatsUpdate) {
          const callbackStats: LineChartStats & {
            benchmarkPhases?: unknown;
            benchmarkWork?: unknown;
          } = {
            dataVersion: data.dataVersion,
            totalPoints: data.totalPoints,
            visiblePoints: data.visiblePoints,
            renderedPoints: data.renderedPoints,
            renderMode: this.resolvedRenderMode,
            fps: data.fps,
            lodLevel: data.lodLevel,
            bucketSize: data.bucketSize,
            presentationMode: data.presentationMode,
            presentationGridPolicy: data.presentationGridPolicy,
            presentationColumns: data.presentationColumns,
            presentationVertices: data.presentationVertices,
            presentationQueryVisits: data.presentationQueryVisits,
            presentationLargestBucket: data.presentationLargestBucket,
            presentationGridDelta: data.presentationGridDelta,
            presentationDensity: data.presentationDensity,
            presentationRebaseRatio: data.presentationRebaseRatio,
            presentationQuantizationStep: data.presentationQuantizationStep,
            frameTime: data.frameTime,
            firstRenderTime: data.firstRenderTime,
            revealProgress: data.revealProgress,
            lodReady: data.lodReady,
            lodBuilt: data.lodBuilt,
            lodTotal: data.lodTotal,
            ringBuffer: data.ringBuffer || false,
            totalReceived: data.totalReceived || 0,
            bufferUsage: data.bufferUsage || 0,
          };
          if (LINE_RENDER_BENCHMARK_ENABLED && data.benchmarkPhases !== undefined) {
            callbackStats.benchmarkPhases = data.benchmarkPhases;
          }
          if (LINE_RENDER_BENCHMARK_ENABLED && data.benchmarkWork !== undefined) {
            callbackStats.benchmarkWork = data.benchmarkWork;
          }
          this.onStatsUpdate(callbackStats);
        }
        break;

      case "viewportSync":
        this.handleViewportSyncMessage(data);
        break;

      case "layout":
        this.syncLayoutFromRenderer(data);
        this.syncLegendInteractionFromRenderer(data);
        break;

      case "tooltipData": {
        if (!this.tooltipOnRender) break;
        const visibleFilter = this.tooltipVisibleSeries;
        this.dispatchTooltipData(
          data,
          this.tooltipOnRender,
          (params, defaultTitle) => {
            const allSeries = params.series;
            const seriesList = visibleFilter
              ? visibleFilter
                  .map((idx: number) => allSeries.find((s: any) => s.index === idx))
                  .filter(Boolean)
              : allSeries;
            return {
              title: defaultTitle,
              rows: seriesList.map((s: any) => ({
                label: s.name ?? String(s.index + 1),
                value: s.formattedValue ?? String(s.value),
                color: s.color,
                dimmed: s.interpolated,
              })),
            };
          },
          "dataX",
        );
        break;
      }

      case "seriesVisibility": {
        this.seriesVisibility = Array.isArray(data.visibility) ? data.visibility.map(Boolean) : [];
        const changedIndex = Number.isInteger(data.changedIndex)
          ? (data.changedIndex as number)
          : null;
        const visible =
          changedIndex !== null && changedIndex >= 0 && changedIndex < this.seriesVisibility.length
            ? this.seriesVisibility[changedIndex]
            : null;
        const source =
          data.source === "api" || data.source === "legend" || data.source === "init"
            ? data.source
            : "api";
        this.onSeriesVisibilityChange?.({
          visibility: [...this.seriesVisibility],
          changedIndex,
          visible,
          source,
        });
        break;
      }
    }
  }

  initStreaming(seriesCount: number, maxPoints: number = 5_000_000): void {
    if (this.destroyed) return;
    this.flushViewportInputs();
    this.discardPendingBatch();
    this.expectedSeriesCount = seriesCount;
    const dataVersion = ++this.dataVersion;
    this.worker.postMessage({
      type: "initRingBuffer",
      maxPoints,
      seriesCount,
      dataVersion,
    });
    this.worker.postMessage({ type: "start" });
  }

  addVector(timestamp: number, values: number[]): void {
    if (this.destroyed) return;
    if (this.expectedSeriesCount && values.length !== this.expectedSeriesCount) {
      throw new Error(
        `addVector: expected ${this.expectedSeriesCount} values, got ${values.length}`,
      );
    }
    this.flushViewportInputs();
    // Snapshot the scalar sample so callers can reuse values before the batched flush.
    this.pendingTimestamps.push(timestamp);
    this.pendingValues.push(values.slice());

    // Schedule flush if not already scheduled
    if (this.batchFlushFrame === null) {
      const frame = requestAnimationFrame(() => {
        if (this.batchFlushFrame !== frame) return;
        this.batchFlushFrame = null;
        this.flushBatch();
      });
      this.batchFlushFrame = frame;
    }
  }

  private cancelBatchFlush(): void {
    // Invalidate callbacks that were already selected for an animation frame.
    // Cleanup may run during super(), before the subclass fields initialize.
    if (this.batchFlushFrame != null) cancelAnimationFrame(this.batchFlushFrame);
    this.batchFlushFrame = null;
  }

  private discardPendingBatch(): void {
    this.cancelBatchFlush();
    this.pendingTimestamps = [];
    this.pendingValues = [];
  }

  private flushBatch(): void {
    this.cancelBatchFlush();

    const count = this.pendingTimestamps.length;
    if (count === 0) return;

    const timestamps = new Float64Array(this.pendingTimestamps);
    const valuesBySeries: Float64Array[] = [];
    const seriesCount = this.pendingValues[0].length;

    for (let s = 0; s < seriesCount; s++) {
      const seriesValues = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        seriesValues[i] = this.pendingValues[i][s];
      }
      valuesBySeries.push(seriesValues);
    }

    this.pendingTimestamps.length = 0;
    this.pendingValues.length = 0;

    this.postVectors(timestamps, valuesBySeries);
  }

  addVectors(timestamps: Float64Array, valuesBySeries: Float64Array[]): void {
    if (this.destroyed) return;
    if (this.expectedSeriesCount > 0 && valuesBySeries.length !== this.expectedSeriesCount) {
      throw new Error(
        `addVectors: expected ${this.expectedSeriesCount} series, got ${valuesBySeries.length}`,
      );
    }
    for (let seriesIndex = 0; seriesIndex < valuesBySeries.length; seriesIndex++) {
      const values = valuesBySeries[seriesIndex];
      if (values.length !== timestamps.length) {
        throw new Error(
          `addVectors: timestamps contain ${timestamps.length} points, but series ${seriesIndex} contains ${values.length}`,
        );
      }
    }
    this.flushBatch();
    this.postVectors(timestamps, valuesBySeries);
  }

  private postVectors(timestamps: Float64Array, valuesBySeries: Float64Array[]): void {
    this.flushViewportInputs();
    const transferList = collectTransferables([timestamps, ...valuesBySeries]);
    this.worker.postMessage(
      {
        type: "addDataPoints",
        timestamps,
        valuesBySeries,
      },
      transferList,
    );
  }

  /**
   * Installs a single-series dataset and gives the renderer ownership of its
   * typed arrays. Worker mode transfers and detaches their buffers; main-thread
   * mode retains the arrays by reference. Do not reuse or mutate the arrays
   * after this call. When `animated` is enabled, this restarts the data reveal.
   *
   * Posts directly rather than through the batch queue, and starts the renderer
   * straight away, so the first frame is drawn as early as possible while the
   * derived work continues in the background. Do not route this through
   * postMessageBatched.
   *
   * @throws TypeError or RangeError when typed-array columns or declared lengths
   * are malformed or misaligned.
   * @returns The monotonic dataset generation. If the chart is already
   * destroyed, no data is installed and the last assigned generation is
   * returned unchanged.
   */
  setData(data: TimeSeriesData, options: LineDataUpdateOptions = {}): number {
    if (this.destroyed) return this.dataVersion;
    assertValidLineData(data, false);
    this.flushViewportInputs();
    this.discardPendingBatch();
    const dataVersion = ++this.dataVersion;
    const transferList = collectTransferables([data.x, data.y]);
    this.worker.postMessage(
      {
        type: "setData",
        x: data.x,
        series: [data.y],
        dataVersion,
        preservePreviousFrame: options.preservePreviousFrame === true,
      },
      transferList,
    );
    this.worker.postMessage({ type: "start" });
    return dataVersion;
  }

  /**
   * Installs a multi-series dataset and gives the renderer ownership of its
   * typed arrays. Worker mode transfers and detaches their buffers; main-thread
   * mode retains the arrays by reference. Do not reuse or mutate the arrays
   * after this call. When `animated` is enabled, this restarts the data reveal.
   *
   * Bypasses the batch queue and starts the renderer immediately, for the same
   * first-frame reason as {@link setData}.
   *
   * @throws TypeError or RangeError when typed-array columns, series metadata,
   * or declared lengths are malformed or misaligned.
   * @returns The monotonic dataset generation. If the chart is already
   * destroyed, no data is installed and the last assigned generation is
   * returned unchanged.
   */
  setMultiSeriesData(data: MultiSeriesData, options: LineDataUpdateOptions = {}): number {
    if (this.destroyed) return this.dataVersion;
    assertValidLineData(data, true);
    this.flushViewportInputs();
    this.discardPendingBatch();
    const dataVersion = ++this.dataVersion;
    const transferList = collectTransferables([data.x, ...data.series]);
    this.worker.postMessage(
      {
        type: "setData",
        x: data.x,
        series: data.series,
        dataVersion,
        preservePreviousFrame: options.preservePreviousFrame === true,
      },
      transferList,
    );
    this.worker.postMessage({ type: "start" });
    return dataVersion;
  }

  setStatsCallback(
    callback: ((stats: LineChartStats) => void) | null,
    options: LineChartStatsOptions = {},
  ): void {
    if (this.destroyed) return;
    this.onStatsUpdate = callback;
    this.configureStats(Boolean(callback), options.intervalMs);
  }

  /** Apply a partial update to mode, density, rebase ratio, or grid
   *  quantization without recreating the chart or rebuilding its hierarchy. */
  setLODOptions(patch: LineLODOptions): void {
    if (this.destroyed) return;
    const current =
      this.optionsShadow.lod && typeof this.optionsShadow.lod === "object"
        ? (this.optionsShadow.lod as LineLODOptions)
        : {};
    this.optionsShadow.lod = { ...current, ...patch };
    this.postMessageBatched({ type: "setLODConfig", lod: patch });
  }

  setSeriesVisible(index: number, visible: boolean): void {
    this.postMessageBatched({
      type: "setSeriesVisible",
      index,
      visible,
    });
  }

  toggleSeriesVisibility(index: number): void {
    this.postMessageBatched({
      type: "toggleSeriesVisibility",
      index,
    });
  }

  setVisibleSeries(indices: number[]): void {
    this.postMessageBatched({
      type: "setVisibleSeries",
      indices,
    });
  }

  getSeriesVisibility(): boolean[] {
    return [...this.seriesVisibility];
  }

  setSeriesVisibilityCallback(
    callback: ((event: SeriesVisibilityChangeEvent) => void) | null,
  ): void {
    this.onSeriesVisibilityChange = callback;
  }

  // ── Appearance API ──────────────────────────────────────────────────

  protected override buildExtraShadow(extraConfig: Record<string, unknown>): Record<string, any> {
    return {
      interpolation: extraConfig.interpolation,
      series: extraConfig.seriesOptions
        ? JSON.parse(JSON.stringify(extraConfig.seriesOptions))
        : [],
      marker: extraConfig.marker ? JSON.parse(JSON.stringify(extraConfig.marker)) : {},
      legend: extraConfig.legend ? JSON.parse(JSON.stringify(extraConfig.legend)) : undefined,
      lod: extraConfig.lod ? JSON.parse(JSON.stringify(extraConfig.lod)) : undefined,
    };
  }

  override getOptions(): DeepReadonly<LineChartOptions> {
    return super.getOptions() as DeepReadonly<LineChartOptions>;
  }

  override getAppearance(): DeepReadonly<LineAppearanceOptions> {
    const base = super.getAppearance() as Record<string, any>;
    const s = this.optionsShadow;
    base.legend = s.legend ? JSON.parse(JSON.stringify(s.legend)) : undefined;
    base.marker = s.marker ? JSON.parse(JSON.stringify(s.marker)) : undefined;
    return base as DeepReadonly<LineAppearanceOptions>;
  }

  protected override applyTooltipAppearancePatch(patch: Record<string, any>): void {
    super.applyTooltipAppearancePatch(patch);
    if (Object.prototype.hasOwnProperty.call(patch, "onRender") && patch.onRender !== undefined) {
      this.tooltipOnRender = typeof patch.onRender === "function" ? patch.onRender : null;
    }
    if (Array.isArray(patch.visibleSeries)) {
      this.tooltipVisibleSeries = [...patch.visibleSeries];
    }
  }

  override updateAppearance(patch: DeepPartial<LineAppearanceOptions>): void {
    if (this.destroyed) return;
    if (typeof patch.legend?.interactive === "boolean") {
      this.setLegendClickInteraction(patch.legend.interactive);
    }
    super.updateAppearance(patch);
  }

  /** Patch visual config for a single series by index. */
  updateSeriesAppearance(index: number, patch: DeepPartial<SeriesAppearanceOptions>): void {
    if (this.destroyed) return;
    // Update shadow (deep merge to preserve nested fields like marker.glow)
    if (Number.isInteger(index) && index >= 0) {
      const series = Array.isArray(this.optionsShadow.series)
        ? (this.optionsShadow.series as SeriesOptions[])
        : ((this.optionsShadow.series = []) as SeriesOptions[]);
      while (series.length <= index) series.push({});
      deepMerge(series[index] as Record<string, any>, patch as Record<string, any>);
    }
    this.postMessageBatched({
      type: "updateSeriesAppearance",
      index,
      patch: deepClone(patch),
    });
  }

  override destroy(): void {
    this.discardPendingBatch();
    this.legendEventsAbortController?.abort();
    super.destroy();
    this.onStatsUpdate = null;
    this.tooltipOnRender = null;
    this.onSeriesVisibilityChange = null;
  }
}

function invalidLineData(): never {
  throw new TypeError("Invalid line data");
}

function assertLineColumn(value: unknown, expectedLength: number): void {
  if (!(value instanceof Float64Array)) invalidLineData();
  if (value.length !== expectedLength) throw new RangeError("Line data length mismatch");
}

function assertValidLineData(data: unknown, multiSeries: boolean): void {
  if (data === null || typeof data !== "object") {
    invalidLineData();
  }
  const candidate = data as Partial<TimeSeriesData & MultiSeriesData>;
  if (!(candidate.x instanceof Float64Array)) invalidLineData();
  const expectedLength = candidate.x.length;

  if (multiSeries) {
    if (!Array.isArray(candidate.series)) invalidLineData();
    for (const series of candidate.series) {
      if (series instanceof Float64Array) {
        assertLineColumn(series, expectedLength);
        continue;
      }
      if (series === null || typeof series !== "object" || Array.isArray(series)) {
        invalidLineData();
      }
      const range = series as Partial<RangeSeriesData>;
      assertLineColumn(range.low, expectedLength);
      assertLineColumn(range.high, expectedLength);
      if (range.y !== undefined) assertLineColumn(range.y, expectedLength);
    }
  } else {
    assertLineColumn(candidate.y, expectedLength);
  }

  if (
    !Number.isSafeInteger(candidate.length) ||
    candidate.length! < 0 ||
    (multiSeries && (!Number.isSafeInteger(candidate.seriesCount) || candidate.seriesCount! < 0))
  ) {
    invalidLineData();
  }
  if (
    candidate.length !== expectedLength ||
    (multiSeries && candidate.seriesCount !== candidate.series!.length)
  ) {
    throw new RangeError("Line data length mismatch");
  }
}

function isRangeSeriesData(series: LineSeriesData): series is RangeSeriesData {
  return (
    !(series instanceof Float64Array) &&
    series !== null &&
    typeof series === "object" &&
    series.low instanceof Float64Array &&
    series.high instanceof Float64Array
  );
}

function addTransferableBuffer(
  transferList: Transferable[],
  seen: Set<ArrayBuffer>,
  buffer: ArrayBufferLike,
): void {
  if (!(buffer instanceof ArrayBuffer) || seen.has(buffer)) return;
  seen.add(buffer);
  transferList.push(buffer);
}

function collectTransferables(items: Array<Float64Array | LineSeriesData>): Transferable[] {
  const transferList: Transferable[] = [];
  const seen = new Set<ArrayBuffer>();

  for (const item of items) {
    if (item instanceof Float64Array) {
      addTransferableBuffer(transferList, seen, item.buffer);
      continue;
    }

    if (isRangeSeriesData(item)) {
      addTransferableBuffer(transferList, seen, item.low.buffer);
      addTransferableBuffer(transferList, seen, item.high.buffer);
      if (item.y) addTransferableBuffer(transferList, seen, item.y.buffer);
    }
  }

  return transferList;
}
