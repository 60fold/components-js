// Line chart renderer - shared engine used by worker or main-thread rendering
// Uses pre-computed LOD levels for stable rendering during pan/zoom

import type {
  CanvasLike,
  EngineCallbacks,
  RenderContext2D,
} from "@sixtyfold/core/internal/renderer";
import type { LineSeriesData } from "@sixtyfold/core/data/seriesTypes";
import { StreamingBoundsIndex } from "./engine/streamingBounds.js";
import {
  WorkerState,
  drawGrid,
  drawAxes,
  drawSelectionRect,
  drawAxisLabel,
  drawBackground,
  drawRangeSelectorOverlay,
  handleBaseMessage,
  updateFPS,
  updateViewportAnimation,
  updateRevealAnimation,
  updateYAnimation,
  startRevealAnimation,
  setYViewport,
  hasActiveGridAnimations,
  getCachedRgba,
  isOpaqueColor,
  formatValue,
  formatTooltipTitle,
  drawCrosshairLines,
  parseCrosshairStyle,
  applyPadding,
  savePaddingBase,
  parseAxisConfig,
  parseAxisCursorUnits,
  parseTextDirectionConfig,
  parseTooltipConfig,
  parseGridConfig,
  parseRangeSelectorConfig,
  parseSelectionConfig,
  parseLabelsConfig,
  parseOverlayConfig,
  measureLabelSpace,
  drawLabels,
  drawCustomLabels,
  renderTooltipBox,
  replaceChartBackground,
  resetTooltipRatchet,
  handleTooltipContentMessage,
  get2dContext,
  UnitOptions,
  createStatsState,
  applyStatsConfigFromMessage,
  shouldEmitStats,
  drawMarker,
  createRendererScheduler,
} from "@sixtyfold/core/internal/renderer";
import {
  ANIMATION,
  COLORS,
  DASH_PATTERNS,
  LINE_MIN_RANGE,
} from "@sixtyfold/core/chart/chartConstants";
import {
  applyYDomain,
  normalizeBounds,
  followViewportX,
  resolveMinViewportRange,
  resolveYDomain,
  type YDomainOptions,
} from "@sixtyfold/core/chart/chartUtils";
import {
  DEFAULT_PRESENTATION_QUANTIZATION_STEP,
  DEFAULT_PRESENTATION_REBASE_RATIO,
  DEFAULT_PUBLIC_PRESENTATION_COLUMNS_PER_CSS_PIXEL,
  isBarSeriesType,
  isDiscreteSeriesType,
  isRangeSeriesInput,
  isScatterSeriesType,
  isStackedAreaSeriesType,
  isStepSeriesType,
  parseDashStyle,
  parseStackCurveStyle,
  resolvePresentationDensity,
  resolvePresentationQuantizationStep,
  resolvePresentationRebaseRatio,
  reverseStackCurve,
  stackCurveToSeriesType,
  type LineDashStyle,
  type LineSeriesType,
  type StackCurveStyle,
} from "./engine/lineOptions.js";
import {
  appendSplineSegment,
  catmullRomInterpolate,
  fillHorizontalStepSegment,
  fillVerticalStepSegment,
  formatRangeValue,
} from "./engine/lineMath.js";
import {
  createSeriesConfigState,
  ensureSeriesVisibility as ensureConfiguredSeriesVisibility,
  getBarBaselineForBounds as getConfiguredBarBaselineForBounds,
  getSeriesColor as getConfiguredSeriesColor,
  getSeriesLineWidth as getConfiguredSeriesLineWidth,
  getSeriesMarker as getConfiguredSeriesMarker,
  getSeriesName as getConfiguredSeriesName,
  getSeriesType as getConfiguredSeriesType,
  getSeriesUnit as getConfiguredSeriesUnit,
  getVisibleSeriesCount as getConfiguredVisibleSeriesCount,
  isSeriesVisible as isConfiguredSeriesVisible,
  resetMarkerCache as resetConfiguredMarkerCache,
  resolveSeriesMarker as resolveConfiguredSeriesMarker,
  resolveSeriesPointOptions as resolveConfiguredSeriesPointOptions,
  type BandOptions,
  type BarOptions,
  type MarkerOptions,
  type ResolvedMarkerOptions,
  type ResolvedPointOptions,
  type SeriesGradient,
  type SeriesOptions,
} from "./engine/seriesConfig.js";
import { LegendRuntime, type LegendLayoutItem } from "./engine/legend.js";
import {
  buildLineTooltipContent,
  getDisplayRange,
  getDisplayY,
  getMarkerY,
  type DataPointResult,
} from "./engine/lineInteraction.js";

declare const __SIXTYFOLD_LINE_BENCHMARK__: boolean;

const LINE_RENDER_BENCHMARK_ENABLED =
  typeof __SIXTYFOLD_LINE_BENCHMARK__ !== "undefined" && __SIXTYFOLD_LINE_BENCHMARK__;
const BENCHMARK_SETUP_LAYOUT_ANIMATION = 0;
const BENCHMARK_VIEWPORT_INDICES = 1;
const BENCHMARK_Y_BOUNDS = 2;
const BENCHMARK_CACHE_PREP = 3;
const BENCHMARK_RENDER_DATA = 4;
const BENCHMARK_CHROME_GRID_AXES = 5;
const BENCHMARK_RANGE_DRAW = 6;
const BENCHMARK_RANGE_RASTER_COMPOSITE = 7;
const BENCHMARK_ORDINARY_FILL = 8;
const BENCHMARK_FILL_EFFECTS = 9;
const BENCHMARK_STACKED_AREAS = 10;
const BENCHMARK_BARS = 11;
const BENCHMARK_CONNECTED_SERIES = 12;
const BENCHMARK_LEGEND_CACHE_FINALIZE = 13;
const BENCHMARK_CACHE_RASTERIZATION_SYNC = 14;
const BENCHMARK_FINAL_CACHE_BLIT = 15;
const BENCHMARK_OVERLAYS_CROSSHAIR = 16;
const BENCHMARK_RANGE_SELECTOR = 17;
const BENCHMARK_TOTAL = 18;
const BENCHMARK_PHASE_COUNT = 19;
const BENCHMARK_WORK_RANGE_RASTER_USED = 0;
const BENCHMARK_WORK_CENTER_PRESENTATION_POINTS = 1;
const BENCHMARK_WORK_RANGE_PRESENTATION_POINTS = 2;
const BENCHMARK_WORK_DENSE_STEP_RECTANGLE_CALLS = 3;
const BENCHMARK_WORK_BAR_RECTANGLE_COUNT = 4;
const BENCHMARK_WORK_COUNT = 5;

export interface LineChartEngine {
  handleMessage(type: string, data: Record<string, any>): void;
  getMarkerConfig(seriesIndex: number): {
    shape: string;
    size: number;
    borderColor: string;
    borderWidth: number;
    glow: {
      enabled: boolean;
      color?: string;
      blur: number;
      opacity: number;
    };
  };
}

export function createLineChartEngine(
  callbacks: EngineCallbacks,
  options: {
    createCanvas?: (w: number, h: number) => CanvasLike;
    ssr?: boolean;
  } = {},
): LineChartEngine {
  const rendererScheduler = createRendererScheduler(callbacks);

  // LOD bucket sizes
  const LOD_BUCKET_SIZES = [1, 8, 32, 128, 512, 2048, 8192];
  // A min/max LOD level only renders as a continuous texture when its buckets
  // are at least as dense as the pixel grid; below that, per-bucket strokes
  // separate into a comb of disconnected columns.
  const LOD_MIN_BUCKETS_PER_PIXEL = 1;
  // Deadband around the level-selection boundary so a few pixels of resize
  // cannot flip the chart between two levels with different textures.
  const LOD_SWITCH_HYSTERESIS = 0.15;
  const PRESENTATION_MAX_COLUMNS_PER_TARGET = 1.5;
  const STAGED_RAW_WORK_BUDGET_MULTIPLIER = 50;
  // Range series can revisit every retained sample for an upper/lower polygon,
  // upper/lower borders, and a center stroke. Keep that multi-pass work bounded
  // during animated full-range interactions without changing the established
  // density choice for ordinary line series.
  const RANGE_RENDER_WORK_PER_PIXEL_LIMIT = 6;
  const DENSE_STEP_RECT_MIN_POINTS = 256;
  const DENSE_STEP_RECT_MAX_WIDTH = 2;
  // Preserve a bounded set of meaningful finite runs inside a coarse bucket.
  // Fragmented connected series retain the runs containing global extrema and
  // the longest run; singleton-only buckets collapse to a break.
  const MAX_COMPACT_GAP_RUNS = 3;
  const GAP_RUN_FIELD_COUNT = 5;
  const PRESENTATION_RUN_FIELD_COUNT = 14;
  const PRESENTATION_RUN_ID = 0;
  const PRESENTATION_RUN_FIRST_INDEX = 1;
  const PRESENTATION_RUN_LAST_INDEX = 2;
  const PRESENTATION_RUN_FIRST_X = 3;
  const PRESENTATION_RUN_FIRST_Y = 4;
  const PRESENTATION_RUN_MIN_X = 5;
  const PRESENTATION_RUN_MIN_Y = 6;
  const PRESENTATION_RUN_MIN_ORDER = 7;
  const PRESENTATION_RUN_MAX_X = 8;
  const PRESENTATION_RUN_MAX_Y = 9;
  const PRESENTATION_RUN_MAX_ORDER = 10;
  const PRESENTATION_RUN_LAST_X = 11;
  const PRESENTATION_RUN_LAST_Y = 12;
  const PRESENTATION_RUN_LENGTH = 13;
  const PRESENTATION_FIRST_RUN_SLOT = 0;
  const PRESENTATION_MIN_RUN_SLOT = 3;
  const PRESENTATION_MAX_RUN_SLOT = 4;
  const PRESENTATION_LONGEST_RUN_SLOT = 5;
  const PRESENTATION_CURRENT_RUN_SLOT = 8;
  const PRESENTATION_RUN_SCRATCH_SLOTS = 9;
  const PRESENTATION_MAX_POINTS_PER_COLUMN =
    MAX_COMPACT_GAP_RUNS * 4 + (MAX_COMPACT_GAP_RUNS - 1) + 2;
  const RANGE_PRESENTATION_RUN_FIELD_COUNT = 18;
  const RANGE_RUN_ID = 0;
  const RANGE_RUN_FIRST_INDEX = 1;
  const RANGE_RUN_LAST_INDEX = 2;
  const RANGE_RUN_FIRST_X = 3;
  const RANGE_RUN_FIRST_LOW = 4;
  const RANGE_RUN_FIRST_HIGH = 5;
  const RANGE_RUN_MIN_X = 6;
  const RANGE_RUN_MIN_LOW = 7;
  const RANGE_RUN_MIN_HIGH = 8;
  const RANGE_RUN_MIN_ORDER = 9;
  const RANGE_RUN_MAX_X = 10;
  const RANGE_RUN_MAX_LOW = 11;
  const RANGE_RUN_MAX_HIGH = 12;
  const RANGE_RUN_MAX_ORDER = 13;
  const RANGE_RUN_LAST_X = 14;
  const RANGE_RUN_LAST_LOW = 15;
  const RANGE_RUN_LAST_HIGH = 16;
  const RANGE_RUN_LENGTH = 17;
  const COLLAPSED_GAP_BUCKET = 2;
  const REPRESENTATIVE_GAP_BUCKET = 3;
  const GAP_BREAK_SOURCE_INDEX = 0xffff_ffff;
  const PRESENTATION_BUCKET_INVALID = 0;
  const PRESENTATION_BUCKET_NORMAL = 1;
  const PRESENTATION_BUCKET_COMPACT_GAP = 2;
  const PRESENTATION_BUCKET_BREAK = 3;
  let hierarchicalPresentationLOD = false;
  let presentationColumnsPerCssPixel = DEFAULT_PUBLIC_PRESENTATION_COLUMNS_PER_CSS_PIXEL;
  let presentationRebaseRatio = DEFAULT_PRESENTATION_REBASE_RATIO;
  let presentationQuantizationStep = DEFAULT_PRESENTATION_QUANTIZATION_STEP;
  let minRange = LINE_MIN_RANGE;
  let yDomain: YDomainOptions | undefined;

  /** Recursive deep merge for plain objects. Arrays replace wholesale. */
  function rendererDeepMerge(target: Record<string, any>, source: Record<string, any>): void {
    for (const key of Object.keys(source)) {
      const val = source[key];
      if (val === undefined) continue;
      if (Array.isArray(val)) {
        target[key] = val.slice();
      } else if (
        val !== null &&
        typeof val === "object" &&
        target[key] !== null &&
        typeof target[key] === "object" &&
        !Array.isArray(target[key])
      ) {
        rendererDeepMerge(target[key], val);
      } else {
        target[key] = val;
      }
    }
  }

  // State
  const state = new WorkerState();
  if (options.createCanvas) state.createCanvas = options.createCanvas;
  // Caches
  const gradientCache = new Map<string, CanvasGradient>();
  const MAX_GRADIENT_CACHE_SIZE = 256;
  let gradientDefinitionRevision = 0;
  const gradientDefinitionSignatures = new WeakMap<
    SeriesGradient,
    { revision: number; signature: string }
  >();
  const gradientGeometrySignatures: Array<{
    top: number;
    bottom: number;
    left: number;
    right: number;
    signature: string;
  }> = [];
  const MAX_GRADIENT_GEOMETRY_SIGNATURES = 8;

  // Config
  let interpolation: "none" | "linear" | "spline" = "linear";
  const ssr = options.ssr ?? false;
  const stats = createStatsState();
  const benchmarkPhaseDurations = LINE_RENDER_BENCHMARK_ENABLED
    ? new Float64Array(BENCHMARK_PHASE_COUNT)
    : null;
  const benchmarkWorkMetrics = LINE_RENDER_BENCHMARK_ENABLED
    ? new Float64Array(BENCHMARK_WORK_COUNT)
    : null;

  function recordBenchmarkPhase(phase: number, startedAt: number): number {
    const endedAt = performance.now();
    benchmarkPhaseDurations![phase] += endedAt - startedAt;
    return endedAt;
  }

  function snapshotBenchmarkPhases() {
    return {
      setupLayoutAnimationMs: benchmarkPhaseDurations![BENCHMARK_SETUP_LAYOUT_ANIMATION],
      viewportIndicesMs: benchmarkPhaseDurations![BENCHMARK_VIEWPORT_INDICES],
      yBoundsMs: benchmarkPhaseDurations![BENCHMARK_Y_BOUNDS],
      cachePrepMs: benchmarkPhaseDurations![BENCHMARK_CACHE_PREP],
      getRenderDataMs: benchmarkPhaseDurations![BENCHMARK_RENDER_DATA],
      chromeGridAxesMs: benchmarkPhaseDurations![BENCHMARK_CHROME_GRID_AXES],
      rangeDrawMs: benchmarkPhaseDurations![BENCHMARK_RANGE_DRAW],
      rangeRasterCompositeMs: benchmarkPhaseDurations![BENCHMARK_RANGE_RASTER_COMPOSITE],
      rangeDrawingMs:
        benchmarkPhaseDurations![BENCHMARK_RANGE_DRAW] +
        benchmarkPhaseDurations![BENCHMARK_RANGE_RASTER_COMPOSITE],
      ordinaryFillMs: benchmarkPhaseDurations![BENCHMARK_ORDINARY_FILL],
      fillEffectsMs: benchmarkPhaseDurations![BENCHMARK_FILL_EFFECTS],
      stackedAreasMs: benchmarkPhaseDurations![BENCHMARK_STACKED_AREAS],
      barsMs: benchmarkPhaseDurations![BENCHMARK_BARS],
      connectedSeriesMs: benchmarkPhaseDurations![BENCHMARK_CONNECTED_SERIES],
      ordinarySeriesMs:
        benchmarkPhaseDurations![BENCHMARK_ORDINARY_FILL] +
        benchmarkPhaseDurations![BENCHMARK_FILL_EFFECTS] +
        benchmarkPhaseDurations![BENCHMARK_STACKED_AREAS] +
        benchmarkPhaseDurations![BENCHMARK_BARS] +
        benchmarkPhaseDurations![BENCHMARK_CONNECTED_SERIES],
      legendCacheFinalizeMs: benchmarkPhaseDurations![BENCHMARK_LEGEND_CACHE_FINALIZE],
      cacheDrawSubmissionMs:
        benchmarkPhaseDurations![BENCHMARK_CHROME_GRID_AXES] +
        benchmarkPhaseDurations![BENCHMARK_RANGE_DRAW] +
        benchmarkPhaseDurations![BENCHMARK_RANGE_RASTER_COMPOSITE] +
        benchmarkPhaseDurations![BENCHMARK_ORDINARY_FILL] +
        benchmarkPhaseDurations![BENCHMARK_FILL_EFFECTS] +
        benchmarkPhaseDurations![BENCHMARK_STACKED_AREAS] +
        benchmarkPhaseDurations![BENCHMARK_BARS] +
        benchmarkPhaseDurations![BENCHMARK_CONNECTED_SERIES] +
        benchmarkPhaseDurations![BENCHMARK_LEGEND_CACHE_FINALIZE],
      cacheRasterizationSyncMs: benchmarkPhaseDurations![BENCHMARK_CACHE_RASTERIZATION_SYNC],
      finalCacheBlitMs: benchmarkPhaseDurations![BENCHMARK_FINAL_CACHE_BLIT],
      overlaysCrosshairMs: benchmarkPhaseDurations![BENCHMARK_OVERLAYS_CROSSHAIR],
      rangeSelectorMs: benchmarkPhaseDurations![BENCHMARK_RANGE_SELECTOR],
      totalMs: benchmarkPhaseDurations![BENCHMARK_TOTAL],
    };
  }

  function snapshotBenchmarkWork() {
    return {
      rangeRasterUsed: benchmarkWorkMetrics![BENCHMARK_WORK_RANGE_RASTER_USED] === 1,
      centerPresentationPoints: benchmarkWorkMetrics![BENCHMARK_WORK_CENTER_PRESENTATION_POINTS],
      rangePresentationPoints: benchmarkWorkMetrics![BENCHMARK_WORK_RANGE_PRESENTATION_POINTS],
      denseStepRectangleCalls: benchmarkWorkMetrics![BENCHMARK_WORK_DENSE_STEP_RECTANGLE_CALLS],
      barRectangleCount: benchmarkWorkMetrics![BENCHMARK_WORK_BAR_RECTANGLE_COUNT],
    };
  }

  interface ResolvedBarOptions {
    fillStyle: string | CanvasGradient | null;
    borderColor: string;
    borderWidth: number;
    borderStyle: LineDashStyle;
    widthRatio: number;
    minWidth: number;
    maxWidth: number;
    baseline: number;
  }

  interface ResolvedStackOptions {
    fillStyle: string | CanvasGradient | null;
    borderColor: string;
    borderWidth: number;
    borderStyle: LineDashStyle;
    curve: StackCurveStyle;
  }

  interface ResolvedBandBorderOptions {
    upperColor: string;
    lowerColor: string;
    width: number;
    style: LineDashStyle;
  }

  const seriesConfig = createSeriesConfigState();
  const legend = new LegendRuntime(state, {
    getSeriesCount: () => seriesConfig.count,
    getSeriesName,
    getSeriesColor,
    isSeriesVisible,
    setSeriesVisibility: setSeriesVisibilityValue,
    postMessage: (message) => callbacks.postMessage(message),
  });

  function resetMarkerCache(): void {
    resetConfiguredMarkerCache(seriesConfig);
  }

  // Track whether axis label units were explicitly set (vs auto-defaulted from series)
  let leftAxisUnitExplicit = false;
  let rightAxisUnitExplicit = false;

  function getSeriesColor(index: number): string {
    return getConfiguredSeriesColor(seriesConfig, index);
  }

  function getSeriesType(index: number): LineSeriesType {
    return getConfiguredSeriesType(seriesConfig, index);
  }

  function getBarBaselineForBounds(index: number): number | null {
    return getConfiguredBarBaselineForBounds(seriesConfig, index);
  }

  function includeStackedAreaBounds(
    startIdx: number,
    endIdx: number,
    includeSeries: (index: number) => boolean,
    includeValue: (value: number) => void,
  ): boolean {
    const stackedSeries: number[] = [];
    for (let s = 0; s < seriesConfig.count; s++) {
      if (includeSeries(s) && isStackedAreaSeriesType(getSeriesType(s)) && dataSeries[s]) {
        stackedSeries.push(s);
      }
    }
    if (stackedSeries.length === 0) return false;

    includeValue(0);

    for (let i = startIdx; i <= endIdx; i++) {
      let positiveStack = 0;
      let negativeStack = 0;
      let hasValue = false;

      for (const s of stackedSeries) {
        const value = getYAt(s, i);
        if (!Number.isFinite(value)) continue;
        hasValue = true;
        if (value >= 0) positiveStack += value;
        else negativeStack += value;
      }

      if (hasValue) {
        includeValue(positiveStack);
        includeValue(negativeStack);
      }
    }

    return true;
  }

  function resolveSeriesPointOptions(index: number): ResolvedPointOptions {
    return resolveConfiguredSeriesPointOptions(seriesConfig, index);
  }

  function getSeriesUnit(index: number): UnitOptions | undefined {
    return getConfiguredSeriesUnit(seriesConfig, index);
  }

  function resolveSeriesMarker(index: number): ResolvedMarkerOptions {
    return resolveConfiguredSeriesMarker(seriesConfig, index);
  }

  function getSeriesMarker(index: number): ResolvedMarkerOptions {
    return getConfiguredSeriesMarker(seriesConfig, index);
  }

  function getSeriesName(index: number): string {
    return getConfiguredSeriesName(seriesConfig, index);
  }

  function isSeriesVisible(index: number): boolean {
    return isConfiguredSeriesVisible(seriesConfig, index);
  }

  function ensureSeriesVisibility(count: number): boolean {
    return ensureConfiguredSeriesVisibility(seriesConfig, count);
  }

  function emitSeriesVisibility(
    source: "init" | "api" | "legend",
    changedIndex: number | null,
  ): void {
    callbacks.postMessage({
      type: "seriesVisibility",
      visibility: [...seriesConfig.visibility],
      source,
      changedIndex,
    });
  }

  function getVisibleSeriesCount(): number {
    return getConfiguredVisibleSeriesCount(seriesConfig);
  }

  function getSeriesLineWidth(index: number, fallback = 1.5): number {
    return getConfiguredSeriesLineWidth(seriesConfig, index, fallback);
  }

  function hasRangeBandFill(index: number): boolean {
    const config = seriesConfig.options[index];
    return (config?.band?.fill ?? config?.fill) !== false;
  }

  function getRangeBandBorderWidth(index: number): number {
    const band = seriesConfig.options[index]?.band;
    if (!hasBandBorderConfig(band)) return 0;

    const rawWidth = band?.borderWidth;
    return rawWidth !== undefined ? (Number.isFinite(rawWidth) && rawWidth >= 0 ? rawWidth : 1) : 1;
  }

  function hasRangeBandBorder(index: number): boolean {
    return getRangeBandBorderWidth(index) > 0;
  }

  function getRangeRenderWorkWeight(index: number): number {
    let weight = getSeriesLineWidth(index) > 0 ? 1 : 0;
    // A fill traverses both boundaries, then asks Canvas2D to rasterize and
    // composite the resulting polygon. Count that final fill as work too.
    if (hasRangeBandFill(index)) weight += 3;
    // Configured range borders stroke the upper and lower boundaries.
    if (hasRangeBandBorder(index)) weight += 2;
    return weight;
  }

  function getVisibleRangeBandRenderWorkWeight(): number {
    let weight = 0;
    for (let index = 0; index < seriesConfig.count; index++) {
      if (!isSeriesVisible(index) || !canReduceRangePresentationDensity(index)) {
        continue;
      }
      if (hasRangeBandFill(index)) weight += 3;
      if (hasRangeBandBorder(index)) weight += 2;
    }
    return weight;
  }

  function getVisibleRenderWorkWeight(): number {
    let weight = 0;
    for (let index = 0; index < seriesConfig.count; index++) {
      if (!isSeriesVisible(index)) continue;

      if (!hasRangeData(index)) {
        const seriesType = getSeriesType(index);
        if (
          isStackedAreaSeriesType(seriesType) ||
          isDiscreteSeriesType(seriesType) ||
          getSeriesLineWidth(index) > 0
        )
          weight++;
        continue;
      }

      weight += getRangeRenderWorkWeight(index);
    }
    return weight;
  }

  function hasVisibleMultiPassRange(): boolean {
    for (let index = 0; index < seriesConfig.count; index++) {
      if (isSeriesVisible(index) && hasRangeData(index) && getRangeRenderWorkWeight(index) > 1)
        return true;
    }
    return false;
  }

  function invalidateDataCaches(): void {
    resetCachedYMinMax();
    presentationResolvedRangeGridDelta = NaN;
    state.cacheValid = false;
    state.rangePreviewValid = false;
    state.tooltipLastDataX = NaN;
  }

  function setSeriesVisibilityValue(
    index: number,
    visible: boolean,
    source: "api" | "legend",
  ): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= seriesConfig.count) return false;

    const nextVisible = !!visible;
    const previous = isSeriesVisible(index);
    if (previous === nextVisible) return false;

    if (!nextVisible && !legend.allowHideAll && previous && getVisibleSeriesCount() <= 1) {
      return false;
    }

    seriesConfig.visibility[index] = nextVisible;
    if (isStackedAreaSeriesType(getSeriesType(index))) {
      rebuildStackedBoundsIndex();
    }
    emitSeriesVisibility(source, index);
    invalidateDataCaches();
    return true;
  }

  function setVisibleSeriesIndices(indices: unknown, source: "api" | "legend"): boolean {
    if (!Array.isArray(indices) || seriesConfig.count === 0) return false;

    const next = new Array<boolean>(seriesConfig.count).fill(false);
    for (let i = 0; i < indices.length; i++) {
      const raw = indices[i];
      if (!Number.isInteger(raw)) continue;
      const index = raw as number;
      if (index >= 0 && index < seriesConfig.count) {
        next[index] = true;
      }
    }

    if (!legend.allowHideAll && next.every((v) => !v)) {
      const fallback = seriesConfig.visibility.findIndex((v) => v !== false);
      next[fallback >= 0 ? fallback : 0] = true;
    }

    let changed = false;
    let stackedVisibilityChanged = false;
    for (let i = 0; i < seriesConfig.count; i++) {
      if ((seriesConfig.visibility[i] ?? true) !== next[i]) {
        changed = true;
        if (isStackedAreaSeriesType(getSeriesType(i))) {
          stackedVisibilityChanged = true;
        }
      }
    }
    if (!changed) return false;

    seriesConfig.visibility = next;
    if (stackedVisibilityChanged) rebuildStackedBoundsIndex();
    emitSeriesVisibility(source, null);
    invalidateDataCaches();
    return true;
  }

  function buildFillStyle(
    ctx: RenderContext2D,
    index: number,
    cachePrefix: string,
    fillSetting: boolean | number | undefined,
    fillColor: string | SeriesGradient | undefined,
    defaultOpacity: number,
    chartTop: number,
    chartBottom: number,
    chartLeft: number,
    chartRight: number,
  ): string | CanvasGradient | null {
    if (fillSetting === false) return null;

    if (!fillColor) {
      const opacity = typeof fillSetting === "number" ? fillSetting : defaultOpacity;
      return getCachedRgba(getSeriesColor(index), opacity);
    }

    if (typeof fillColor === "string") {
      return fillColor;
    }

    const colors = fillColor.colors;
    if (!colors || colors.length < 2) return null;

    const direction = fillColor.direction ?? "vertical";
    let definition = gradientDefinitionSignatures.get(fillColor);
    if (definition?.revision !== gradientDefinitionRevision) {
      definition = {
        revision: gradientDefinitionRevision,
        // Renderer-owned appearance objects change only through an explicit
        // series-appearance message. Serialize once per revision instead of
        // joining both arrays for every gradient series on every frame.
        signature: JSON.stringify([direction, colors, fillColor.offsets ?? null]),
      };
      gradientDefinitionSignatures.set(fillColor, definition);
    }
    const keyPrefix = cachePrefix ? `${cachePrefix}-` : "";
    let geometrySignature = "";
    for (let entryIndex = 0; entryIndex < gradientGeometrySignatures.length; entryIndex++) {
      const entry = gradientGeometrySignatures[entryIndex];
      if (
        entry.top === chartTop &&
        entry.bottom === chartBottom &&
        entry.left === chartLeft &&
        entry.right === chartRight
      ) {
        geometrySignature = entry.signature;
        break;
      }
    }
    if (!geometrySignature) {
      geometrySignature =
        `${chartTop.toFixed(1)}-${chartBottom.toFixed(1)}-` +
        `${chartLeft.toFixed(1)}-${chartRight.toFixed(1)}`;
      if (gradientGeometrySignatures.length >= MAX_GRADIENT_GEOMETRY_SIGNATURES) {
        gradientGeometrySignatures.shift();
      }
      gradientGeometrySignatures.push({
        top: chartTop,
        bottom: chartBottom,
        left: chartLeft,
        right: chartRight,
        signature: geometrySignature,
      });
    }
    const cacheKey = `${keyPrefix}${index}-${geometrySignature}-${definition.signature}`;
    let gradient = gradientCache.get(cacheKey);

    if (gradient) return gradient;

    const offsets = fillColor.offsets;

    if (direction === "vertical") {
      gradient = ctx.createLinearGradient(0, chartTop, 0, chartBottom);
    } else {
      gradient = ctx.createLinearGradient(chartLeft, 0, chartRight, 0);
    }

    for (let i = 0; i < colors.length; i++) {
      const offset = offsets?.[i] ?? i / (colors.length - 1);
      // addColorStop throws on a colour it cannot parse, and an unhandled throw
      // here tears the whole renderer down. Skip the bad stop instead: a
      // degraded gradient is recoverable, a destroyed chart is not.
      try {
        gradient.addColorStop(offset, colors[i]);
      } catch {
        // Unparseable stop; the remaining stops still define the gradient.
      }
    }

    if (gradientCache.size >= MAX_GRADIENT_CACHE_SIZE) {
      gradientCache.clear();
    }
    gradientCache.set(cacheKey, gradient);
    return gradient;
  }

  // Get fill style for series (solid color or gradient)
  function getSeriesFillStyle(
    ctx: RenderContext2D,
    index: number,
    chartTop: number,
    chartBottom: number,
    chartLeft: number,
    chartRight: number,
  ): string | CanvasGradient | null {
    const config = seriesConfig.options[index];
    if (!config?.fill) return null;
    return buildFillStyle(
      ctx,
      index,
      "",
      config.fill,
      config.fillColor,
      0.4,
      chartTop,
      chartBottom,
      chartLeft,
      chartRight,
    );
  }

  function getRangeBandFillStyle(
    ctx: RenderContext2D,
    index: number,
    chartTop: number,
    chartBottom: number,
    chartLeft: number,
    chartRight: number,
  ): string | CanvasGradient | null {
    const config = seriesConfig.options[index];
    const band = config?.band;
    const fillSetting = band?.fill ?? config?.fill;
    if (fillSetting === false) return null;

    return buildFillStyle(
      ctx,
      index,
      "range",
      fillSetting,
      band?.fillColor ?? config?.fillColor,
      0.18,
      chartTop,
      chartBottom,
      chartLeft,
      chartRight,
    );
  }

  function hasBorderConfig(
    options:
      { borderColor?: string; borderWidth?: number; borderStyle?: LineDashStyle } | undefined,
  ): boolean {
    return !!(
      options &&
      (options.borderColor ||
        options.borderWidth !== undefined ||
        options.borderStyle !== undefined)
    );
  }

  function hasBandBorderConfig(band: BandOptions | undefined): boolean {
    return !!(band && (hasBorderConfig(band) || band.upperBorderColor || band.lowerBorderColor));
  }

  function getRangeBandBorderOptions(index: number): ResolvedBandBorderOptions | null {
    const band = seriesConfig.options[index]?.band;
    const width = getRangeBandBorderWidth(index);
    if (width <= 0) return null;

    const color = band?.borderColor ?? getSeriesColor(index);
    return {
      upperColor: band?.upperBorderColor ?? color,
      lowerColor: band?.lowerBorderColor ?? color,
      width,
      style: parseDashStyle(band?.borderStyle),
    };
  }

  function getBarFillStyle(
    ctx: RenderContext2D,
    index: number,
    chartTop: number,
    chartBottom: number,
    chartLeft: number,
    chartRight: number,
  ): string | CanvasGradient | null {
    const bar = seriesConfig.options[index]?.bar;
    const fillSetting = bar?.fill ?? true;
    if (fillSetting === false) return null;

    return buildFillStyle(
      ctx,
      index,
      "bar",
      fillSetting,
      bar?.fillColor,
      0.75,
      chartTop,
      chartBottom,
      chartLeft,
      chartRight,
    );
  }

  function hasBarBorderConfig(bar: BarOptions | undefined): boolean {
    return hasBorderConfig(bar);
  }

  function resolveSeriesBarOptions(
    ctx: RenderContext2D,
    index: number,
    chartTop: number,
    chartBottom: number,
    chartLeft: number,
    chartRight: number,
  ): ResolvedBarOptions {
    const bar = seriesConfig.options[index]?.bar;
    const rawBorderWidth = bar?.borderWidth;
    const hasBorder = hasBarBorderConfig(bar);
    const borderWidth = hasBorder
      ? rawBorderWidth !== undefined
        ? Number.isFinite(rawBorderWidth) && rawBorderWidth >= 0
          ? rawBorderWidth
          : 1
        : 1
      : 0;

    const rawWidthRatio = bar?.widthRatio;
    const rawMinWidth = bar?.minWidth;
    const rawMaxWidth = bar?.maxWidth;
    const minWidth = Number.isFinite(rawMinWidth) && rawMinWidth! >= 0 ? rawMinWidth! : 1;
    const rawResolvedMaxWidth =
      Number.isFinite(rawMaxWidth) && rawMaxWidth! >= 0 ? rawMaxWidth! : 24;
    const maxWidth = Math.max(minWidth, rawResolvedMaxWidth);
    const rawBaseline = bar?.baseline;

    return {
      fillStyle: getBarFillStyle(ctx, index, chartTop, chartBottom, chartLeft, chartRight),
      borderColor: bar?.borderColor ?? getSeriesColor(index),
      borderWidth,
      borderStyle: parseDashStyle(bar?.borderStyle),
      widthRatio: Number.isFinite(rawWidthRatio) && rawWidthRatio! >= 0 ? rawWidthRatio! : 0.7,
      minWidth,
      maxWidth,
      baseline: Number.isFinite(rawBaseline) ? rawBaseline! : 0,
    };
  }

  function getStackedAreaFillStyle(
    ctx: RenderContext2D,
    index: number,
    chartTop: number,
    chartBottom: number,
    chartLeft: number,
    chartRight: number,
  ): string | CanvasGradient | null {
    const config = seriesConfig.options[index];
    const stack = config?.stack;
    const fillSetting = stack?.fill ?? config?.fill ?? true;
    if (fillSetting === false) return null;

    return buildFillStyle(
      ctx,
      index,
      "stack",
      fillSetting,
      stack?.fillColor ?? config?.fillColor,
      0.58,
      chartTop,
      chartBottom,
      chartLeft,
      chartRight,
    );
  }

  function getSeriesStackCurve(index: number): StackCurveStyle {
    return parseStackCurveStyle(seriesConfig.options[index]?.stack?.curve);
  }

  function resolveSeriesStackOptions(
    ctx: RenderContext2D,
    index: number,
    chartTop: number,
    chartBottom: number,
    chartLeft: number,
    chartRight: number,
  ): ResolvedStackOptions {
    const stack = seriesConfig.options[index]?.stack;
    const rawBorderWidth = stack?.borderWidth ?? seriesConfig.options[index]?.width;
    const borderWidth =
      rawBorderWidth !== undefined
        ? Number.isFinite(rawBorderWidth) && rawBorderWidth >= 0
          ? rawBorderWidth
          : 1.5
        : 1.5;

    return {
      fillStyle: getStackedAreaFillStyle(ctx, index, chartTop, chartBottom, chartLeft, chartRight),
      borderColor: stack?.borderColor ?? getSeriesColor(index),
      borderWidth,
      borderStyle: parseDashStyle(stack?.borderStyle),
      curve: getSeriesStackCurve(index),
    };
  }

  // Draw layered fill effect for depth
  function drawLayeredFill(
    ctx: RenderContext2D,
    data: RenderSeriesData,
    color: string,
    baseOpacity: number,
    fillToZero: boolean,
    seriesType: LineSeriesType,
  ) {
    if (data.length < 2) return;

    const xRange = state.viewport.xMax - state.viewport.xMin;
    const yRange = state.viewport.yMax - state.viewport.yMin;
    const chartBottom = state.chartTop + state.chartHeight;

    // Calculate baseline Y position
    let baselineY: number;
    if (fillToZero) {
      const zeroScreenY = state.chartTop + ((state.viewport.yMax - 0) / yRange) * state.chartHeight;
      baselineY = Math.max(state.chartTop, Math.min(chartBottom, zeroScreenY));
    } else {
      baselineY = chartBottom;
    }

    // Layers from outer (more transparent) to inner (more opaque)
    const layers = [
      { scale: 1.0, opacity: 0.15 },
      { scale: 0.7, opacity: 0.25 },
      { scale: 0.4, opacity: 0.35 },
      { scale: 0.15, opacity: 0.5 },
    ];

    const useStepPath = isStepSeriesType(seriesType);

    for (const layer of layers) {
      ctx.fillStyle = getCachedRgba(color, layer.opacity * baseOpacity);

      if (!useStepPath && interpolation === "spline") {
        drawSplineFillSegments(ctx, data, xRange, yRange, baselineY, layer.scale);
        continue;
      }

      // Draw fill segments, breaking at gaps
      let inSegment = false;
      let lastValidScreenX = 0;

      if (!useStepPath) {
        forEachRenderPoint(data, (x, y) => {
          const screenX =
            state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;

          if (!Number.isFinite(y)) {
            // Gap - close current segment
            if (inSegment) {
              ctx.lineTo(lastValidScreenX, baselineY);
              ctx.closePath();
              ctx.fill();
              inSegment = false;
            }
            return;
          }

          const fullScreenY =
            state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;
          const screenY = baselineY + (fullScreenY - baselineY) * layer.scale;

          if (!inSegment) {
            ctx.beginPath();
            ctx.moveTo(screenX, baselineY);
            ctx.lineTo(screenX, screenY);
            inSegment = true;
          } else {
            ctx.lineTo(screenX, screenY);
          }
          lastValidScreenX = screenX;
        });
      } else {
        let lastValidScreenY = 0;

        forEachRenderPoint(data, (x, y) => {
          const screenX =
            state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;

          if (!Number.isFinite(y)) {
            // Gap - close current segment
            if (inSegment) {
              ctx.lineTo(lastValidScreenX, baselineY);
              ctx.closePath();
              ctx.fill();
              inSegment = false;
            }
            return;
          }

          const fullScreenY =
            state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;
          const screenY = baselineY + (fullScreenY - baselineY) * layer.scale;

          if (!inSegment) {
            ctx.beginPath();
            ctx.moveTo(screenX, baselineY);
            ctx.lineTo(screenX, screenY);
            inSegment = true;
          } else {
            appendSeriesLineTo(
              ctx,
              seriesType,
              lastValidScreenX,
              lastValidScreenY,
              screenX,
              screenY,
            );
          }
          lastValidScreenX = screenX;
          lastValidScreenY = screenY;
        });
      }

      // Close final segment
      if (inSegment) {
        ctx.lineTo(lastValidScreenX, baselineY);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // Draw glow effect emanating from the line
  function drawLineGlow(
    ctx: RenderContext2D,
    data: RenderSeriesData,
    color: string,
    baseOpacity: number,
    seriesType: LineSeriesType,
  ) {
    if (data.length < 2) return;

    const xRange = state.viewport.xMax - state.viewport.xMin;
    const yRange = state.viewport.yMax - state.viewport.yMin;

    // Glow layers - wider and more transparent as we go out
    const glowLayers = [
      { width: 20, opacity: 0.03 },
      { width: 14, opacity: 0.05 },
      { width: 10, opacity: 0.08 },
      { width: 6, opacity: 0.12 },
      { width: 4, opacity: 0.18 },
    ];

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const useStepPath = isStepSeriesType(seriesType);

    for (const layer of glowLayers) {
      ctx.strokeStyle = getCachedRgba(color, layer.opacity * baseOpacity);
      ctx.lineWidth = layer.width;

      ctx.beginPath();
      let needsMoveTo = true;

      if (!useStepPath && interpolation === "spline") {
        appendSplineLinePath(ctx, data, xRange, yRange);
      } else if (!useStepPath) {
        forEachRenderPoint(data, (x, y) => {
          if (!Number.isFinite(y)) {
            needsMoveTo = true;
            return;
          }

          const screenX =
            state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
          const screenY = state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;

          if (needsMoveTo) {
            ctx.moveTo(screenX, screenY);
            needsMoveTo = false;
          } else {
            ctx.lineTo(screenX, screenY);
          }
        });
      } else {
        let lastScreenX = 0;
        let lastScreenY = 0;

        forEachRenderPoint(data, (x, y) => {
          if (!Number.isFinite(y)) {
            needsMoveTo = true;
            return;
          }

          const screenX =
            state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
          const screenY = state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;

          if (needsMoveTo) {
            ctx.moveTo(screenX, screenY);
            needsMoveTo = false;
          } else {
            appendSeriesLineTo(ctx, seriesType, lastScreenX, lastScreenY, screenX, screenY);
          }
          lastScreenX = screenX;
          lastScreenY = screenY;
        });
      }
      ctx.stroke();
    }
  }

  interface RangeSeriesStorage {
    low: Float64Array;
    high: Float64Array;
  }

  // Data stored in JS arrays
  let dataX: Float64Array | null = null;
  let dataSeries: Float64Array[] = [];
  let rangeSeriesData: Array<RangeSeriesStorage | null> = [];
  // Reduced adaptive band density is safe only when every low/high sample is
  // finite. Gap-bearing columns can retain several runs and therefore more than
  // the ordinary four representatives.
  let rangeSeriesBandFullyFinite: boolean[] = [];
  let dataLength = 0;
  let dataVersion = 0;

  // Exact stacked-area autoscaling uses a range index instead of rescanning every
  // visible point for every stacked series after each pan/zoom. Leaves aggregate
  // fixed-size physical-data blocks; the segment tree combines fully covered
  // blocks, while only the two partial edge blocks are read from raw series data.
  // Ring-buffer queries can wrap, so they are split into at most two physical
  // ranges (and therefore at most four partial edge blocks). A viewport lookup is
  // O(block size * stacked series + log(block count)), independent of its span.
  const STACKED_BOUNDS_BLOCK_SIZE = 256;

  interface StackedBoundsIndex {
    seriesIndices: number[];
    blockCount: number;
    treeBase: number;
    minTree: Float64Array;
    maxTree: Float64Array;
    dirtyBlocks: Uint8Array;
    dirtyBlockIndices: number[];
  }

  let stackedBoundsIndex: StackedBoundsIndex | null = null;
  // Global streaming bounds include hidden series and full stack totals, unlike
  // the visible-stack viewport index above. Only written physical blocks change.
  let streamingBoundsIndex: StreamingBoundsIndex | null = null;

  // Ring buffer state
  let ringBufferMode = false;
  let ringBufferMaxPoints = 5_000_000;
  let writeIndex = 0;
  let bufferFull = false;
  let totalPointsReceived = 0;
  let previousDataLength = 0;
  // Advances whenever the logical data sequence changes. A full ring-buffer
  // append shifts every logical index even when its physical write index wraps
  // back to the same slot, so writeIndex alone cannot validate an older LOD.
  let lodSourceRevision = 0;

  // LOD data
  interface LODLevel {
    bucketSize: number;
    bucketCount: number;
    sourceDataLength: number;
    sourceRevision: number;
    data: Float64Array;
    internalGapBuckets: Uint8Array;
    // Compact first/min/max/last summaries for each finite run inside an
    // internal-gap bucket. Offsets are measured in x/y points, not floats.
    gapData: Float64Array;
    // Exact raw source index for each compact point. Gap sentinels use
    // GAP_BREAK_SOURCE_INDEX so irregular or repeated X values remain unambiguous.
    gapSourceIndices: Uint32Array;
    gapOffsets: Uint32Array;
    // Cumulative rendered point counts. Ordinary buckets use four points;
    // internal-gap buckets use their compact run summaries.
    renderOffsets: Uint32Array;
  }
  let lodLevelsBySeries: LODLevel[][] = [];

  interface RangeLODLevel {
    bucketSize: number;
    bucketCount: number;
    sourceDataLength: number;
    sourceRevision: number;
    data: Float64Array;
    internalGapBuckets: Uint8Array;
    // Compact x/low/high summaries for finite runs inside gap buckets.
    gapData: Float64Array;
    gapSourceIndices: Uint32Array;
    gapOffsets: Uint32Array;
    // Matches the variable per-bucket layout used by range rendering.
    renderOffsets: Uint32Array;
  }
  let rangeLodLevelsBySeries: Array<RangeLODLevel[] | null> = [];

  interface PresentationColumnBuffer {
    data: Float64Array;
    capacity: number;
    runScratch: Float64Array;
    selectionScratch: Int32Array;
  }

  interface RangePresentationColumnBuffer {
    data: Float64Array;
    capacity: number;
    runScratch: Float64Array;
    selectionScratch: Int32Array;
  }

  let presentationColumnBuffers: Array<PresentationColumnBuffer | null> = [];
  let rangePresentationColumnBuffers: Array<RangePresentationColumnBuffer | null> = [];
  const emptyPresentationColumnData = new Float64Array(0);
  // Stable for the lifetime of an installed dataset. Ring-buffer eviction must
  // not move the presentation grid underneath a constant-span pan.
  let presentationGridAnchorX = 0;
  let presentationGridQuantumX = 1;
  let presentationResolvedGridDelta = NaN;
  let presentationResolvedRangeGridDelta = NaN;

  let lastPresentationMode: "pyramid" | "columns" = "pyramid";
  let lastPresentationColumnCount = 0;
  let lastPresentationVertexCount = 0;
  let lastPresentationQueryVisits = 0;
  let lastPresentationLargestBucket = 1;
  let lastPresentationGridDelta = NaN;

  // LOD building progress
  let lodBuildComplete = false;
  let lodLevelsBuilt = 0;
  let lodBuildGeneration = 0;
  let lodRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  // Latest performance.now() by which a debounced LOD rebuild must run. Caps the
  // debounce so sustained streaming (which re-arms the timer every append) can't
  // starve the rebuild forever. 0 means no rebuild is currently pending.
  let lodRebuildDeadline = 0;
  const LOD_REBUILD_MAX_WAIT_MS = 500;
  let stopped = false;

  // Track current LOD
  let currentLODIndex = 0;
  // Final selected level from the previous frame, used for switch hysteresis.
  // -1 only while no selection exists; raw is a real level at index 0.
  let lastSelectedLODIndex = -1;
  let currentBucketSize = 1;
  let lastRenderedPoints = 0;

  interface RetainedPlotFrame {
    canvas: CanvasLike;
    left: number;
    top: number;
    width: number;
    height: number;
  }

  let retainedPlotFrame: RetainedPlotFrame | null = null;

  // Cache for Y min/max
  let cachedYMinMax = { min: 0, max: 0, startIdx: -1, endIdx: -1 };

  function resetCachedYMinMax(): void {
    cachedYMinMax = { min: 0, max: 0, startIdx: -1, endIdx: -1 };
  }

  function resetPresentationGridState(): void {
    presentationResolvedGridDelta = NaN;
    presentationResolvedRangeGridDelta = NaN;
    lastPresentationGridDelta = NaN;
  }

  function resolvePresentationGridQuantum(
    firstX: number,
    lastX: number,
    pointCount: number,
  ): number {
    if (pointCount <= 1) return 1;
    const cadence = (lastX - firstX) / (pointCount - 1);
    return Number.isFinite(cadence) && cadence > 0 ? cadence : 1;
  }

  function logicalToPhysicalIndex(index: number): number {
    if (!ringBufferMode || !bufferFull) return index;
    return (writeIndex + index) % ringBufferMaxPoints;
  }

  function getXAt(index: number): number {
    return dataX![logicalToPhysicalIndex(index)];
  }

  function getYAt(seriesIndex: number, index: number): number {
    return dataSeries[seriesIndex][logicalToPhysicalIndex(index)];
  }

  function getVisibleStackedSeriesIndices(): number[] {
    const indices: number[] = [];
    for (let s = 0; s < seriesConfig.count; s++) {
      if (isSeriesVisible(s) && isStackedAreaSeriesType(getSeriesType(s)) && dataSeries[s]) {
        indices.push(s);
      }
    }
    return indices;
  }

  function getStoredPhysicalLength(): number {
    if (ringBufferMode && bufferFull) return ringBufferMaxPoints;
    return dataLength;
  }

  function rebuildStreamingBoundsIndex(): void {
    if (!ringBufferMode) {
      streamingBoundsIndex = null;
      return;
    }
    streamingBoundsIndex = new StreamingBoundsIndex(
      dataSeries,
      ringBufferMaxPoints,
      dataSeries.map((_, index) => isStackedAreaSeriesType(getSeriesType(index))),
    );
    streamingBoundsIndex.rebuild(getStoredPhysicalLength());
  }

  function updateStackedBoundsTreeAncestors(blockIndex: number): void {
    const index = stackedBoundsIndex;
    if (!index) return;

    for (let node = (index.treeBase + blockIndex) >> 1; node > 0; node >>= 1) {
      const left = node * 2;
      const right = left + 1;
      index.minTree[node] = Math.min(index.minTree[left], index.minTree[right]);
      index.maxTree[node] = Math.max(index.maxTree[left], index.maxTree[right]);
    }
  }

  function recomputeStackedBoundsBlock(blockIndex: number, updateAncestors: boolean): void {
    const index = stackedBoundsIndex;
    if (!index || blockIndex < 0 || blockIndex >= index.blockCount) return;

    const start = blockIndex * STACKED_BOUNDS_BLOCK_SIZE;
    const end = Math.min(start + STACKED_BOUNDS_BLOCK_SIZE, getStoredPhysicalLength());
    let blockMin = Infinity;
    let blockMax = -Infinity;

    for (let physicalIndex = start; physicalIndex < end; physicalIndex++) {
      let positiveStack = 0;
      let negativeStack = 0;
      let hasValue = false;

      for (let i = 0; i < index.seriesIndices.length; i++) {
        const value = dataSeries[index.seriesIndices[i]][physicalIndex];
        if (!Number.isFinite(value)) continue;
        hasValue = true;
        if (value >= 0) positiveStack += value;
        else negativeStack += value;
      }

      if (hasValue) {
        if (negativeStack < blockMin) blockMin = negativeStack;
        if (positiveStack > blockMax) blockMax = positiveStack;
      }
    }

    const leaf = index.treeBase + blockIndex;
    index.minTree[leaf] = blockMin;
    index.maxTree[leaf] = blockMax;
    if (updateAncestors) updateStackedBoundsTreeAncestors(blockIndex);
  }

  function rebuildStackedBoundsIndex(): void {
    const seriesIndices = getVisibleStackedSeriesIndices();
    const capacity = ringBufferMode ? ringBufferMaxPoints : dataLength;
    if (seriesIndices.length === 0 || capacity <= 0) {
      stackedBoundsIndex = null;
      return;
    }

    const blockCount = Math.ceil(capacity / STACKED_BOUNDS_BLOCK_SIZE);
    let treeBase = 1;
    while (treeBase < blockCount) treeBase *= 2;

    const minTree = new Float64Array(treeBase * 2);
    const maxTree = new Float64Array(treeBase * 2);
    minTree.fill(Infinity);
    maxTree.fill(-Infinity);
    stackedBoundsIndex = {
      seriesIndices,
      blockCount,
      treeBase,
      minTree,
      maxTree,
      dirtyBlocks: new Uint8Array(blockCount),
      dirtyBlockIndices: [],
    };

    const populatedBlockCount = Math.ceil(getStoredPhysicalLength() / STACKED_BOUNDS_BLOCK_SIZE);
    for (let block = 0; block < populatedBlockCount; block++) {
      recomputeStackedBoundsBlock(block, false);
    }
    for (let node = treeBase - 1; node > 0; node--) {
      const left = node * 2;
      const right = left + 1;
      minTree[node] = Math.min(minTree[left], minTree[right]);
      maxTree[node] = Math.max(maxTree[left], maxTree[right]);
    }
  }

  function markStackedBoundsBlockDirty(physicalIndex: number): void {
    const index = stackedBoundsIndex;
    if (!index) return;
    const block = Math.floor(physicalIndex / STACKED_BOUNDS_BLOCK_SIZE);
    if (block < 0 || block >= index.blockCount || index.dirtyBlocks[block] === 1) {
      return;
    }
    index.dirtyBlocks[block] = 1;
    index.dirtyBlockIndices.push(block);
  }

  function flushDirtyStackedBoundsBlocks(): void {
    const index = stackedBoundsIndex;
    if (!index) return;

    for (let i = 0; i < index.dirtyBlockIndices.length; i++) {
      const block = index.dirtyBlockIndices[i];
      recomputeStackedBoundsBlock(block, true);
      index.dirtyBlocks[block] = 0;
    }
    index.dirtyBlockIndices.length = 0;
  }

  function includeRawStackedPhysicalBounds(
    startPhysicalIndex: number,
    endPhysicalIndex: number,
    index: StackedBoundsIndex,
    includeValue: (value: number) => void,
  ): void {
    for (
      let physicalIndex = startPhysicalIndex;
      physicalIndex <= endPhysicalIndex;
      physicalIndex++
    ) {
      let positiveStack = 0;
      let negativeStack = 0;
      let hasValue = false;

      for (let i = 0; i < index.seriesIndices.length; i++) {
        const value = dataSeries[index.seriesIndices[i]][physicalIndex];
        if (!Number.isFinite(value)) continue;
        hasValue = true;
        if (value >= 0) positiveStack += value;
        else negativeStack += value;
      }

      if (hasValue) {
        includeValue(positiveStack);
        includeValue(negativeStack);
      }
    }
  }

  function includeStackedBoundsTreeRange(
    startBlock: number,
    endBlock: number,
    index: StackedBoundsIndex,
    includeValue: (value: number) => void,
  ): void {
    let left = index.treeBase + startBlock;
    let right = index.treeBase + endBlock;

    while (left <= right) {
      if ((left & 1) === 1) {
        const min = index.minTree[left];
        const max = index.maxTree[left];
        if (Number.isFinite(min)) includeValue(min);
        if (Number.isFinite(max)) includeValue(max);
        left++;
      }
      if ((right & 1) === 0) {
        const min = index.minTree[right];
        const max = index.maxTree[right];
        if (Number.isFinite(min)) includeValue(min);
        if (Number.isFinite(max)) includeValue(max);
        right--;
      }
      left >>= 1;
      right >>= 1;
    }
  }

  function includeStackedPhysicalRangeBounds(
    startPhysicalIndex: number,
    endPhysicalIndex: number,
    index: StackedBoundsIndex,
    includeValue: (value: number) => void,
  ): void {
    if (startPhysicalIndex > endPhysicalIndex) return;

    const firstFullBlock = Math.ceil(startPhysicalIndex / STACKED_BOUNDS_BLOCK_SIZE);
    const fullBlockEndExclusive = Math.floor((endPhysicalIndex + 1) / STACKED_BOUNDS_BLOCK_SIZE);

    if (firstFullBlock >= fullBlockEndExclusive) {
      includeRawStackedPhysicalBounds(startPhysicalIndex, endPhysicalIndex, index, includeValue);
      return;
    }

    const leadingEnd = firstFullBlock * STACKED_BOUNDS_BLOCK_SIZE - 1;
    if (startPhysicalIndex <= leadingEnd) {
      includeRawStackedPhysicalBounds(startPhysicalIndex, leadingEnd, index, includeValue);
    }

    includeStackedBoundsTreeRange(firstFullBlock, fullBlockEndExclusive - 1, index, includeValue);

    const trailingStart = fullBlockEndExclusive * STACKED_BOUNDS_BLOCK_SIZE;
    if (trailingStart <= endPhysicalIndex) {
      includeRawStackedPhysicalBounds(trailingStart, endPhysicalIndex, index, includeValue);
    }
  }

  function includeIndexedStackedAreaBounds(
    startIdx: number,
    endIdx: number,
    includeValue: (value: number) => void,
  ): boolean {
    const index = stackedBoundsIndex;
    if (!index || startIdx > endIdx) return false;

    includeValue(0);
    if (!ringBufferMode || !bufferFull) {
      includeStackedPhysicalRangeBounds(startIdx, endIdx, index, includeValue);
      return true;
    }

    const startPhysicalIndex = logicalToPhysicalIndex(startIdx);
    const endPhysicalIndex = logicalToPhysicalIndex(endIdx);
    if (startPhysicalIndex <= endPhysicalIndex) {
      includeStackedPhysicalRangeBounds(startPhysicalIndex, endPhysicalIndex, index, includeValue);
    } else {
      includeStackedPhysicalRangeBounds(
        startPhysicalIndex,
        ringBufferMaxPoints - 1,
        index,
        includeValue,
      );
      includeStackedPhysicalRangeBounds(0, endPhysicalIndex, index, includeValue);
    }
    return true;
  }

  function hasRangeData(seriesIndex: number): boolean {
    return !!rangeSeriesData[seriesIndex];
  }

  function canReduceRangePresentationDensity(seriesIndex: number): boolean {
    return (
      hasRangeData(seriesIndex) &&
      rangeSeriesBandFullyFinite[seriesIndex] === true &&
      getSeriesLineWidth(seriesIndex) === 0 &&
      (hasRangeBandFill(seriesIndex) || hasRangeBandBorder(seriesIndex))
    );
  }

  function getRangeLowerAt(seriesIndex: number, index: number): number {
    const range = rangeSeriesData[seriesIndex];
    if (!range) return NaN;
    const physicalIndex = logicalToPhysicalIndex(index);
    const low = range.low[physicalIndex];
    const high = range.high[physicalIndex];
    if (!Number.isFinite(low) || !Number.isFinite(high)) return NaN;
    return low <= high ? low : high;
  }

  function getRangeUpperAt(seriesIndex: number, index: number): number {
    const range = rangeSeriesData[seriesIndex];
    if (!range) return NaN;
    const physicalIndex = logicalToPhysicalIndex(index);
    const low = range.low[physicalIndex];
    const high = range.high[physicalIndex];
    if (!Number.isFinite(low) || !Number.isFinite(high)) return NaN;
    return low <= high ? high : low;
  }

  function binarySearchDataXLeft(target: number, start = 0, end = dataLength - 1): number {
    let lo = start;
    let hi = end;

    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (getXAt(mid) < target) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  function binarySearchDataXRight(target: number, start = 0, end = dataLength - 1): number {
    let lo = start;
    let hi = end;

    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (getXAt(mid) <= target) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  function resetRawLODLevels(): void {
    lodLevelsBySeries = [];
    rangeLodLevelsBySeries = [];
    for (let s = 0; s < seriesConfig.count; s++) {
      lodLevelsBySeries.push([
        {
          bucketSize: 1,
          bucketCount: dataLength,
          sourceDataLength: dataLength,
          sourceRevision: lodSourceRevision,
          data: new Float64Array(0),
          internalGapBuckets: new Uint8Array(0),
          gapData: new Float64Array(0),
          gapSourceIndices: new Uint32Array(0),
          gapOffsets: new Uint32Array(0),
          renderOffsets: new Uint32Array(0),
        },
      ]);
      rangeLodLevelsBySeries.push(
        hasRangeData(s)
          ? [
              {
                bucketSize: 1,
                bucketCount: dataLength,
                sourceDataLength: dataLength,
                sourceRevision: lodSourceRevision,
                data: new Float64Array(0),
                internalGapBuckets: new Uint8Array(0),
                gapData: new Float64Array(0),
                gapSourceIndices: new Uint32Array(0),
                gapOffsets: new Uint32Array(0),
                renderOffsets: new Uint32Array(0),
              },
            ]
          : null,
      );
    }
    currentLODIndex = 0;
    currentBucketSize = 1;
    lastSelectedLODIndex = -1;
  }

  function updateRawLODLevelLengths(): void {
    if (lodLevelsBySeries.length !== seriesConfig.count) {
      resetRawLODLevels();
      return;
    }

    for (let s = 0; s < seriesConfig.count; s++) {
      const levels = lodLevelsBySeries[s];
      if (!levels || levels.length === 0 || levels[0].bucketSize !== 1) {
        resetRawLODLevels();
        return;
      }
      levels[0] = {
        bucketSize: 1,
        bucketCount: dataLength,
        sourceDataLength: dataLength,
        sourceRevision: lodSourceRevision,
        data: levels[0].data,
        internalGapBuckets: levels[0].internalGapBuckets,
        gapData: levels[0].gapData,
        gapSourceIndices: levels[0].gapSourceIndices,
        gapOffsets: levels[0].gapOffsets,
        renderOffsets: levels[0].renderOffsets,
      };

      const rangeLevels = rangeLodLevelsBySeries[s];
      if (hasRangeData(s)) {
        if (!rangeLevels || rangeLevels.length === 0 || rangeLevels[0].bucketSize !== 1) {
          resetRawLODLevels();
          return;
        }
        rangeLevels[0] = {
          bucketSize: 1,
          bucketCount: dataLength,
          sourceDataLength: dataLength,
          sourceRevision: lodSourceRevision,
          data: rangeLevels[0].data,
          internalGapBuckets: rangeLevels[0].internalGapBuckets,
          gapData: rangeLevels[0].gapData,
          gapSourceIndices: rangeLevels[0].gapSourceIndices,
          gapOffsets: rangeLevels[0].gapOffsets,
          renderOffsets: rangeLevels[0].renderOffsets,
        };
      } else {
        rangeLodLevelsBySeries[s] = null;
      }
    }
  }

  function clearScheduledLODRebuild(): void {
    if (lodRebuildTimer !== null) {
      clearTimeout(lodRebuildTimer);
      lodRebuildTimer = null;
    }
  }

  function prepareRetainedPlotFrame(preservePreviousFrame: boolean): void {
    retainedPlotFrame = null;
    if (
      !preservePreviousFrame ||
      ssr ||
      !state.animated ||
      !state.cacheValid ||
      !state.cacheCanvas
    ) {
      return;
    }

    const dpr = state.dpr;
    const left = state.padding.left * dpr;
    const top = state.chartTop * dpr;
    const width = state.chartWidth * dpr;
    const height = state.chartHeight * dpr;
    if (
      !Number.isFinite(left) ||
      !Number.isFinite(top) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return;
    }

    retainedPlotFrame = {
      canvas: state.cacheCanvas,
      left,
      top,
      width,
      height,
    };
    // Detach the prior cache instead of copying its pixels. The next render
    // allocates a fresh cache for the replacement dataset.
    state.cacheCanvas = null;
    state.cacheCtx = null;
    state.cacheValid = false;
  }

  function stopRenderer(): void {
    stopped = true;
    clearScheduledLODRebuild();
    lodRebuildDeadline = 0;
    lodBuildGeneration++;
    ringBufferMode = false;
    streamingBoundsIndex = null;
    state.dataLoadStartTime = 0;
    state.viewportAnimation.active = false;
    state.yAnimation.active = false;
    state.xGridAlphas.clear();
    state.yGridAlphas.clear();
    retainedPlotFrame = null;
    gradientCache.clear();
    state.cacheValid = false;
    state.rangePreviewValid = false;
    parseOverlayConfig(state, undefined);
    replaceChartBackground(state, COLORS.background);
    resetCachedYMinMax();
    if (state.rafId !== null && !ssr) {
      cancelAnimationFrame(state.rafId);
    }
    state.rafId = null;
    pendingViewportRequestId = undefined;
  }

  function hasBuiltLOD(): boolean {
    const levels = lodLevelsBySeries[0];
    return !!levels && levels.some((level) => level.bucketSize > 1 && level.bucketCount > 0);
  }

  let pendingViewportRequestId: number | undefined;

  function emitViewportSync(viewportRequestId?: number): void {
    callbacks.postMessage({
      type: "viewportSync",
      viewport: {
        xMin: state.viewport.xMin,
        xMax: state.viewport.xMax,
      },
      dataBounds: {
        xMin: state.dataBounds.xMin,
        xMax: state.dataBounds.xMax,
      },
      ...(viewportRequestId === undefined ? {} : { viewportRequestId }),
    });
  }

  function assignDataVersion(nextDataVersion?: number): void {
    dataVersion =
      typeof nextDataVersion === "number" &&
      Number.isSafeInteger(nextDataVersion) &&
      nextDataVersion > 0
        ? nextDataVersion
        : dataVersion + 1;
  }

  function setData(
    x: Float64Array,
    seriesData: LineSeriesData[],
    nextDataVersion?: number,
    preservePreviousFrame = false,
  ) {
    stopped = false;
    prepareRetainedPlotFrame(preservePreviousFrame);
    assignDataVersion(nextDataVersion);
    lodSourceRevision++;
    clearScheduledLODRebuild();
    lodBuildGeneration++;
    ringBufferMode = false;
    streamingBoundsIndex = null;
    writeIndex = 0;
    bufferFull = false;
    previousDataLength = 0;
    state.dataLoadStartTime = performance.now();
    state.isFirstRender = true;

    dataX = x;
    dataLength = x.length;
    dataSeries = [];
    rangeSeriesData = [];
    rangeSeriesBandFullyFinite = [];
    seriesConfig.count = seriesData.length;
    presentationGridAnchorX = Number.isFinite(x[0]) ? x[0] : 0;
    presentationGridQuantumX = resolvePresentationGridQuantum(x[0], x[x.length - 1], x.length);
    presentationColumnBuffers.length = seriesConfig.count;
    rangePresentationColumnBuffers.length = seriesConfig.count;
    resetPresentationGridState();

    for (let s = 0; s < seriesConfig.count; s++) {
      const series = seriesData[s];
      if (isRangeSeriesInput(series)) {
        let center = series.y;
        if (!center) {
          center = new Float64Array(dataLength);
          for (let i = 0; i < dataLength; i++) {
            const low = series.low[i];
            const high = series.high[i];
            center[i] = Number.isFinite(low) && Number.isFinite(high) ? (low + high) * 0.5 : NaN;
          }
        }
        dataSeries.push(center);
        rangeSeriesData.push({ low: series.low, high: series.high });
        rangeSeriesBandFullyFinite.push(true);
      } else {
        dataSeries.push(series);
        rangeSeriesData.push(null);
        rangeSeriesBandFullyFinite.push(false);
      }
    }

    if (ensureSeriesVisibility(seriesConfig.count)) {
      emitSeriesVisibility("init", null);
    }
    rebuildStackedBoundsIndex();

    // Calculate bounds (skip NaN values)
    let globalYMin = Infinity;
    let globalYMax = -Infinity;

    for (let s = 0; s < seriesConfig.count; s++) {
      const y = dataSeries[s];
      const range = rangeSeriesData[s];
      const barBaseline = getBarBaselineForBounds(s);
      if (barBaseline !== null) {
        if (barBaseline < globalYMin) globalYMin = barBaseline;
        if (barBaseline > globalYMax) globalYMax = barBaseline;
      }
      for (let i = 0; i < dataLength; i++) {
        if (range) {
          const low = getRangeLowerAt(s, i);
          const high = getRangeUpperAt(s, i);
          if (Number.isFinite(low) && Number.isFinite(high)) {
            if (low < globalYMin) globalYMin = low;
            if (high > globalYMax) globalYMax = high;
          } else {
            rangeSeriesBandFullyFinite[s] = false;
          }
        }

        const val = y[i];
        if (Number.isFinite(val)) {
          if (val < globalYMin) globalYMin = val;
          if (val > globalYMax) globalYMax = val;
        }
      }
    }

    includeStackedAreaBounds(
      0,
      dataLength - 1,
      () => true,
      (value) => {
        if (value < globalYMin) globalYMin = value;
        if (value > globalYMax) globalYMax = value;
      },
    );

    // Normalize: NaN fallback + degenerate-span expansion (shared with streaming).
    state.dataBounds = normalizeBounds(x[0], x[dataLength - 1], globalYMin, globalYMax, minRange);
    const initialY = applyYDomain(state.dataBounds.yMin, state.dataBounds.yMax, yDomain);
    state.viewport = {
      ...state.dataBounds,
      yMin: initialY.min,
      yMax: initialY.max,
    };
    if (ssr) {
      state.revealProgress = 1;
    } else {
      startRevealAnimation(state, performance.now());
    }

    emitViewportSync();

    buildLODLevels();
  }

  function initRingBuffer(maxPoints: number, count: number, nextDataVersion?: number) {
    stopped = false;
    retainedPlotFrame = null;
    assignDataVersion(nextDataVersion);
    lodSourceRevision++;
    ringBufferMode = true;
    ringBufferMaxPoints = maxPoints;
    dataLength = 0;
    writeIndex = 0;
    bufferFull = false;
    previousDataLength = 0;
    totalPointsReceived = 0;
    seriesConfig.count = count;
    presentationGridAnchorX = NaN;
    presentationGridQuantumX = 1;
    presentationColumnBuffers.length = seriesConfig.count;
    rangePresentationColumnBuffers.length = seriesConfig.count;
    resetPresentationGridState();
    state.dataLoadStartTime = 0;
    state.isFirstRender = false;
    state.revealProgress = 1;
    if (ensureSeriesVisibility(seriesConfig.count)) {
      emitSeriesVisibility("init", null);
    }

    dataX = new Float64Array(maxPoints);
    dataSeries = [];
    rangeSeriesData = new Array<RangeSeriesStorage | null>(count).fill(null);
    rangeSeriesBandFullyFinite = new Array<boolean>(count).fill(false);
    for (let s = 0; s < count; s++) {
      dataSeries.push(new Float64Array(maxPoints));
    }
    rebuildStackedBoundsIndex();
    rebuildStreamingBoundsIndex();

    state.dataBounds = { xMin: 0, xMax: 1, yMin: 0, yMax: 100 };
    const initialY = applyYDomain(0, 100, yDomain);
    state.viewport = {
      ...state.dataBounds,
      yMin: initialY.min,
      yMax: initialY.max,
    };

    resetRawLODLevels();
    lodBuildComplete = false;
    lodLevelsBuilt = 1;
  }

  function addDataPoints(timestamps: Float64Array, valuesBySeries: Float64Array[]) {
    if (!dataX || !ringBufferMode) return;

    const count = timestamps.length;
    if (totalPointsReceived === 0 && count > 0 && Number.isFinite(timestamps[0])) {
      presentationGridAnchorX = timestamps[0];
      presentationGridQuantumX = resolvePresentationGridQuantum(
        timestamps[0],
        timestamps[count - 1],
        count,
      );
    } else if (totalPointsReceived === 1 && count > 0 && Number.isFinite(presentationGridAnchorX)) {
      presentationGridQuantumX = resolvePresentationGridQuantum(
        presentationGridAnchorX,
        timestamps[0],
        2,
      );
    }
    for (let i = 0; i < count; i++) {
      dataX[writeIndex] = timestamps[i];
      for (let s = 0; s < seriesConfig.count; s++) {
        dataSeries[s][writeIndex] = valuesBySeries[s][i];
      }
      markStackedBoundsBlockDirty(writeIndex);
      streamingBoundsIndex?.markDirty(writeIndex);
      writeIndex = (writeIndex + 1) % ringBufferMaxPoints;
      totalPointsReceived++;
      if (!bufferFull && writeIndex === 0) bufferFull = true;
    }

    dataLength = bufferFull ? ringBufferMaxPoints : writeIndex;
    lodSourceRevision++;
    flushDirtyStackedBoundsBlocks();
    streamingBoundsIndex?.flush(dataLength);
    if (dataLength > 0) recalculateBounds();

    updateRawLODLevelLengths();
    invalidateDataCaches();

    if (dataLength > 1000 && (!hasBuiltLOD() || previousDataLength === 0)) {
      buildLODLevels();
    } else {
      scheduleLODRebuild();
    }
    previousDataLength = dataLength;
  }

  function recalculateBounds() {
    if (!dataX || dataLength === 0) return;

    const previousBounds = state.dataBounds;
    const previousViewport = state.viewport;

    let yMin = streamingBoundsIndex?.min ?? Infinity;
    let yMax = streamingBoundsIndex?.max ?? -Infinity;
    for (let s = 0; s < seriesConfig.count; s++) {
      const barBaseline = getBarBaselineForBounds(s);
      if (barBaseline !== null) {
        if (barBaseline < yMin) yMin = barBaseline;
        if (barBaseline > yMax) yMax = barBaseline;
      }
      if (isStackedAreaSeriesType(getSeriesType(s))) {
        if (0 < yMin) yMin = 0;
        if (0 > yMax) yMax = 0;
      }
    }

    // Shared normalization (NaN fallback + degenerate-span expansion).
    const bounds = normalizeBounds(getXAt(0), getXAt(dataLength - 1), yMin, yMax, minRange);
    state.dataBounds = bounds;

    // Line charts snap the Y range to the data on each recompute; only the X
    // range follows/preserves the prior viewport.
    const nextX = followViewportX(
      previousViewport,
      previousBounds,
      previousDataLength,
      bounds.xMin,
      bounds.xMax,
      minRange,
    );
    const nextY = applyYDomain(bounds.yMin, bounds.yMax, yDomain);
    state.viewport = {
      xMin: nextX.xMin,
      xMax: nextX.xMax,
      yMin: nextY.min,
      yMax: nextY.max,
    };

    emitViewportSync();
  }

  function buildLODLevels() {
    if (!dataX || stopped) return;

    clearScheduledLODRebuild();
    lodRebuildDeadline = 0;
    const generation = ++lodBuildGeneration;
    const sourceDataLength = dataLength;
    const sourceRevision = lodSourceRevision;
    lodBuildComplete = false;
    lodLevelsBuilt = 1;
    state.rangePreviewValid = false;
    resetCachedYMinMax();

    resetRawLODLevels();

    const coarsestIdx = LOD_BUCKET_SIZES.length - 1;
    buildLODLevel(coarsestIdx, sourceDataLength, sourceRevision);
    resetCachedYMinMax();
    lodLevelsBuilt = 2;

    buildRemainingLODs(coarsestIdx - 1, generation, sourceDataLength, sourceRevision);
  }

  function writeRangeLODPoint(
    target: Float64Array,
    baseIdx: number,
    seriesIndex: number,
    sourceIdx: number,
  ): void {
    target[baseIdx] = getXAt(sourceIdx);
    target[baseIdx + 1] = getRangeLowerAt(seriesIndex, sourceIdx);
    target[baseIdx + 2] = getRangeUpperAt(seriesIndex, sourceIdx);
  }

  function writeRangeLODNaN(target: Float64Array, baseIdx: number): void {
    target[baseIdx] = NaN;
    target[baseIdx + 1] = NaN;
    target[baseIdx + 2] = NaN;
  }

  function appendLineLODRun(
    target: number[],
    sourceIndices: number[],
    seriesIndex: number,
    firstIdx: number,
    minIdx: number,
    maxIdx: number,
    lastIdx: number,
  ): void {
    const firstExtremeIdx = minIdx <= maxIdx ? minIdx : maxIdx;
    const secondExtremeIdx = minIdx <= maxIdx ? maxIdx : minIdx;
    let previousIdx = -1;

    for (let slot = 0; slot < 4; slot++) {
      const sourceIdx =
        slot === 0
          ? firstIdx
          : slot === 1
            ? firstExtremeIdx
            : slot === 2
              ? secondExtremeIdx
              : lastIdx;
      if (sourceIdx === previousIdx) continue;
      target.push(getXAt(sourceIdx), getYAt(seriesIndex, sourceIdx));
      sourceIndices.push(sourceIdx);
      previousIdx = sourceIdx;
    }
  }

  function appendLineGapBreak(target: number[], sourceIndices: number[]): void {
    target.push(NaN, NaN);
    sourceIndices.push(GAP_BREAK_SOURCE_INDEX);
  }

  function storeGapRun(
    scratch: Int32Array,
    candidateIndex: number,
    firstIdx: number,
    minIdx: number,
    maxIdx: number,
    lastIdx: number,
  ): void {
    const base = candidateIndex * GAP_RUN_FIELD_COUNT;
    scratch[base] = firstIdx;
    scratch[base + 1] = minIdx;
    scratch[base + 2] = maxIdx;
    scratch[base + 3] = lastIdx;
    scratch[base + 4] = lastIdx - firstIdx + 1;
  }

  function captureRepresentativeGapRun(
    scratch: Int32Array,
    globalMinIdx: number,
    globalMaxIdx: number,
    firstIdx: number,
    minIdx: number,
    maxIdx: number,
    lastIdx: number,
  ): void {
    const containsGlobalMin = globalMinIdx >= firstIdx && globalMinIdx <= lastIdx;
    const containsGlobalMax = globalMaxIdx >= firstIdx && globalMaxIdx <= lastIdx;
    if (containsGlobalMin) {
      storeGapRun(scratch, 0, firstIdx, minIdx, maxIdx, lastIdx);
    }
    if (containsGlobalMax) {
      storeGapRun(scratch, 1, firstIdx, minIdx, maxIdx, lastIdx);
    }
    const longestBase = 2 * GAP_RUN_FIELD_COUNT;
    const runLength = lastIdx - firstIdx + 1;
    if (!containsGlobalMin && !containsGlobalMax && runLength > scratch[longestBase + 4]) {
      storeGapRun(scratch, 2, firstIdx, minIdx, maxIdx, lastIdx);
    }
  }

  function prepareRepresentativeGapRuns(scratch: Int32Array, preserveSingletons: boolean): number {
    let candidateCount = 0;
    for (let candidate = 0; candidate < MAX_COMPACT_GAP_RUNS; candidate++) {
      const base = candidate * GAP_RUN_FIELD_COUNT;
      const firstIdx = scratch[base];
      const lastIdx = scratch[base + 3];
      if (firstIdx < 0 || (!preserveSingletons && lastIdx <= firstIdx)) {
        scratch[base] = -1;
        continue;
      }

      let duplicate = false;
      for (let previous = 0; previous < candidate; previous++) {
        const previousBase = previous * GAP_RUN_FIELD_COUNT;
        if (scratch[previousBase] === firstIdx && scratch[previousBase + 3] === lastIdx) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) {
        scratch[base] = -1;
        continue;
      }
      candidateCount++;
    }
    return candidateCount;
  }

  function appendRepresentativeLineGapBucket(
    target: number[],
    sourceIndices: number[],
    seriesIndex: number,
    start: number,
    end: number,
    globalMinIdx: number,
    globalMaxIdx: number,
    scratch: Int32Array,
    preserveSingletons: boolean,
  ): number {
    const startPoint = target.length / 2;
    scratch.fill(-1);

    let firstIdx = -1;
    let lastIdx = -1;
    let minIdx = -1;
    let maxIdx = -1;
    let minY = NaN;
    let maxY = NaN;

    for (let i = start; i < end; i++) {
      const value = getYAt(seriesIndex, i);
      if (Number.isFinite(value)) {
        if (firstIdx === -1) {
          firstIdx = i;
          minIdx = i;
          maxIdx = i;
          minY = value;
          maxY = value;
        }
        lastIdx = i;
        if (value < minY) {
          minY = value;
          minIdx = i;
        }
        if (value > maxY) {
          maxY = value;
          maxIdx = i;
        }
        continue;
      }

      if (firstIdx !== -1) {
        captureRepresentativeGapRun(
          scratch,
          globalMinIdx,
          globalMaxIdx,
          firstIdx,
          minIdx,
          maxIdx,
          lastIdx,
        );
        firstIdx = -1;
        lastIdx = -1;
        minIdx = -1;
        maxIdx = -1;
        minY = NaN;
        maxY = NaN;
      }
    }

    if (firstIdx !== -1) {
      captureRepresentativeGapRun(
        scratch,
        globalMinIdx,
        globalMaxIdx,
        firstIdx,
        minIdx,
        maxIdx,
        lastIdx,
      );
    }

    if (prepareRepresentativeGapRuns(scratch, preserveSingletons) === 0) {
      return -1;
    }

    // Representative runs may omit data on either side, so isolate the compact
    // summary from neighboring buckets as well as from the other selected runs.
    appendLineGapBreak(target, sourceIndices);
    let emitted = 0;
    for (let slot = 0; slot < MAX_COMPACT_GAP_RUNS; slot++) {
      let selected = -1;
      let selectedFirstIdx = Number.POSITIVE_INFINITY;
      for (let candidate = 0; candidate < MAX_COMPACT_GAP_RUNS; candidate++) {
        const base = candidate * GAP_RUN_FIELD_COUNT;
        const candidateFirstIdx = scratch[base];
        if (candidateFirstIdx >= 0 && candidateFirstIdx < selectedFirstIdx) {
          selected = candidate;
          selectedFirstIdx = candidateFirstIdx;
        }
      }
      if (selected < 0) break;

      if (emitted > 0) appendLineGapBreak(target, sourceIndices);
      const base = selected * GAP_RUN_FIELD_COUNT;
      appendLineLODRun(
        target,
        sourceIndices,
        seriesIndex,
        scratch[base],
        scratch[base + 1],
        scratch[base + 2],
        scratch[base + 3],
      );
      scratch[base] = -1;
      emitted++;
    }
    appendLineGapBreak(target, sourceIndices);
    return -(target.length / 2 - startPoint) - 1;
  }

  function appendLineGapBucket(
    target: number[],
    sourceIndices: number[],
    seriesIndex: number,
    start: number,
    end: number,
    globalMinIdx: number,
    globalMaxIdx: number,
    scratch: Int32Array,
    preserveSingletons: boolean,
  ): number {
    const initialFloatLength = target.length;
    const initialSourceIndexLength = sourceIndices.length;
    const startPoint = target.length / 2;
    let runCount = 0;
    let firstIdx = -1;
    let lastIdx = -1;
    let minIdx = -1;
    let maxIdx = -1;
    let minY = NaN;
    let maxY = NaN;

    if (!Number.isFinite(getYAt(seriesIndex, start))) {
      appendLineGapBreak(target, sourceIndices);
    }

    for (let i = start; i < end; i++) {
      const value = getYAt(seriesIndex, i);
      if (Number.isFinite(value)) {
        if (firstIdx === -1) {
          firstIdx = i;
          minIdx = i;
          maxIdx = i;
          minY = value;
          maxY = value;
        }
        lastIdx = i;
        if (value < minY) {
          minY = value;
          minIdx = i;
        }
        if (value > maxY) {
          maxY = value;
          maxIdx = i;
        }
        continue;
      }

      if (firstIdx !== -1) {
        if (preserveSingletons || lastIdx > firstIdx || firstIdx === start || lastIdx === end - 1) {
          appendLineLODRun(target, sourceIndices, seriesIndex, firstIdx, minIdx, maxIdx, lastIdx);
        }
        runCount++;
        if (runCount > MAX_COMPACT_GAP_RUNS) {
          target.length = initialFloatLength;
          sourceIndices.length = initialSourceIndexLength;
          return appendRepresentativeLineGapBucket(
            target,
            sourceIndices,
            seriesIndex,
            start,
            end,
            globalMinIdx,
            globalMaxIdx,
            scratch,
            preserveSingletons,
          );
        }
        appendLineGapBreak(target, sourceIndices);
        firstIdx = -1;
        lastIdx = -1;
        minIdx = -1;
        maxIdx = -1;
        minY = NaN;
        maxY = NaN;
      }
    }

    if (firstIdx !== -1) {
      if (preserveSingletons || lastIdx > firstIdx || firstIdx === start || lastIdx === end - 1) {
        appendLineLODRun(target, sourceIndices, seriesIndex, firstIdx, minIdx, maxIdx, lastIdx);
      }
      runCount++;
      if (runCount > MAX_COMPACT_GAP_RUNS) {
        target.length = initialFloatLength;
        sourceIndices.length = initialSourceIndexLength;
        return appendRepresentativeLineGapBucket(
          target,
          sourceIndices,
          seriesIndex,
          start,
          end,
          globalMinIdx,
          globalMaxIdx,
          scratch,
          preserveSingletons,
        );
      }
    }

    return target.length / 2 - startPoint;
  }

  function appendRangeLODRun(
    target: number[],
    sourceIndices: number[],
    seriesIndex: number,
    firstIdx: number,
    minLowIdx: number,
    maxHighIdx: number,
    lastIdx: number,
  ): void {
    const firstExtremeIdx = minLowIdx <= maxHighIdx ? minLowIdx : maxHighIdx;
    const secondExtremeIdx = minLowIdx <= maxHighIdx ? maxHighIdx : minLowIdx;
    let previousIdx = -1;

    for (let slot = 0; slot < 4; slot++) {
      const sourceIdx =
        slot === 0
          ? firstIdx
          : slot === 1
            ? firstExtremeIdx
            : slot === 2
              ? secondExtremeIdx
              : lastIdx;
      if (sourceIdx === previousIdx) continue;
      target.push(
        getXAt(sourceIdx),
        getRangeLowerAt(seriesIndex, sourceIdx),
        getRangeUpperAt(seriesIndex, sourceIdx),
      );
      sourceIndices.push(sourceIdx);
      previousIdx = sourceIdx;
    }
  }

  function appendRangeGapBreak(target: number[], sourceIndices: number[]): void {
    target.push(NaN, NaN, NaN);
    sourceIndices.push(GAP_BREAK_SOURCE_INDEX);
  }

  function appendRepresentativeRangeGapBucket(
    target: number[],
    sourceIndices: number[],
    seriesIndex: number,
    start: number,
    end: number,
    globalMinLowIdx: number,
    globalMaxHighIdx: number,
    scratch: Int32Array,
  ): number {
    const startPoint = target.length / 3;
    scratch.fill(-1);

    let firstIdx = -1;
    let lastIdx = -1;
    let minLowIdx = -1;
    let maxHighIdx = -1;
    let minLow = NaN;
    let maxHigh = NaN;

    for (let i = start; i < end; i++) {
      const low = getRangeLowerAt(seriesIndex, i);
      const high = getRangeUpperAt(seriesIndex, i);
      if (Number.isFinite(low) && Number.isFinite(high)) {
        if (firstIdx === -1) {
          firstIdx = i;
          minLowIdx = i;
          maxHighIdx = i;
          minLow = low;
          maxHigh = high;
        }
        lastIdx = i;
        if (low < minLow) {
          minLow = low;
          minLowIdx = i;
        }
        if (high > maxHigh) {
          maxHigh = high;
          maxHighIdx = i;
        }
        continue;
      }

      if (firstIdx !== -1) {
        captureRepresentativeGapRun(
          scratch,
          globalMinLowIdx,
          globalMaxHighIdx,
          firstIdx,
          minLowIdx,
          maxHighIdx,
          lastIdx,
        );
        firstIdx = -1;
        lastIdx = -1;
        minLowIdx = -1;
        maxHighIdx = -1;
        minLow = NaN;
        maxHigh = NaN;
      }
    }

    if (firstIdx !== -1) {
      captureRepresentativeGapRun(
        scratch,
        globalMinLowIdx,
        globalMaxHighIdx,
        firstIdx,
        minLowIdx,
        maxHighIdx,
        lastIdx,
      );
    }

    if (prepareRepresentativeGapRuns(scratch, false) === 0) return -1;

    appendRangeGapBreak(target, sourceIndices);
    let emitted = 0;
    for (let slot = 0; slot < MAX_COMPACT_GAP_RUNS; slot++) {
      let selected = -1;
      let selectedFirstIdx = Number.POSITIVE_INFINITY;
      for (let candidate = 0; candidate < MAX_COMPACT_GAP_RUNS; candidate++) {
        const base = candidate * GAP_RUN_FIELD_COUNT;
        const candidateFirstIdx = scratch[base];
        if (candidateFirstIdx >= 0 && candidateFirstIdx < selectedFirstIdx) {
          selected = candidate;
          selectedFirstIdx = candidateFirstIdx;
        }
      }
      if (selected < 0) break;

      if (emitted > 0) appendRangeGapBreak(target, sourceIndices);
      const base = selected * GAP_RUN_FIELD_COUNT;
      appendRangeLODRun(
        target,
        sourceIndices,
        seriesIndex,
        scratch[base],
        scratch[base + 1],
        scratch[base + 2],
        scratch[base + 3],
      );
      scratch[base] = -1;
      emitted++;
    }
    appendRangeGapBreak(target, sourceIndices);
    return -(target.length / 3 - startPoint) - 1;
  }

  function appendRangeGapBucket(
    target: number[],
    sourceIndices: number[],
    seriesIndex: number,
    start: number,
    end: number,
    globalMinLowIdx: number,
    globalMaxHighIdx: number,
    scratch: Int32Array,
  ): number {
    const initialFloatLength = target.length;
    const initialSourceIndexLength = sourceIndices.length;
    const startPoint = target.length / 3;
    let runCount = 0;
    let firstIdx = -1;
    let lastIdx = -1;
    let minLowIdx = -1;
    let maxHighIdx = -1;
    let minLow = NaN;
    let maxHigh = NaN;

    const firstLow = getRangeLowerAt(seriesIndex, start);
    const firstHigh = getRangeUpperAt(seriesIndex, start);
    if (!Number.isFinite(firstLow) || !Number.isFinite(firstHigh)) {
      appendRangeGapBreak(target, sourceIndices);
    }

    for (let i = start; i < end; i++) {
      const low = getRangeLowerAt(seriesIndex, i);
      const high = getRangeUpperAt(seriesIndex, i);
      if (Number.isFinite(low) && Number.isFinite(high)) {
        if (firstIdx === -1) {
          firstIdx = i;
          minLowIdx = i;
          maxHighIdx = i;
          minLow = low;
          maxHigh = high;
        }
        lastIdx = i;
        if (low < minLow) {
          minLow = low;
          minLowIdx = i;
        }
        if (high > maxHigh) {
          maxHigh = high;
          maxHighIdx = i;
        }
        continue;
      }

      if (firstIdx !== -1) {
        appendRangeLODRun(
          target,
          sourceIndices,
          seriesIndex,
          firstIdx,
          minLowIdx,
          maxHighIdx,
          lastIdx,
        );
        runCount++;
        if (runCount > MAX_COMPACT_GAP_RUNS) {
          target.length = initialFloatLength;
          sourceIndices.length = initialSourceIndexLength;
          return appendRepresentativeRangeGapBucket(
            target,
            sourceIndices,
            seriesIndex,
            start,
            end,
            globalMinLowIdx,
            globalMaxHighIdx,
            scratch,
          );
        }
        appendRangeGapBreak(target, sourceIndices);
        firstIdx = -1;
        lastIdx = -1;
        minLowIdx = -1;
        maxHighIdx = -1;
        minLow = NaN;
        maxHigh = NaN;
      }
    }

    if (firstIdx !== -1) {
      appendRangeLODRun(
        target,
        sourceIndices,
        seriesIndex,
        firstIdx,
        minLowIdx,
        maxHighIdx,
        lastIdx,
      );
      runCount++;
      if (runCount > MAX_COMPACT_GAP_RUNS) {
        target.length = initialFloatLength;
        sourceIndices.length = initialSourceIndexLength;
        return appendRepresentativeRangeGapBucket(
          target,
          sourceIndices,
          seriesIndex,
          start,
          end,
          globalMinLowIdx,
          globalMaxHighIdx,
          scratch,
        );
      }
    }

    return target.length / 3 - startPoint;
  }

  function buildRangeLODLevelForSeries(
    seriesIndex: number,
    bucketSize: number,
    bucketCount: number,
    sourceDataLength: number,
    sourceRevision: number,
  ): RangeLODLevel {
    // 12 floats per bucket: first(x,low,high), two extrema points ordered by x,
    // last(x,low,high).
    const lodData = new Float64Array(bucketCount * 12);
    const internalGapBuckets = new Uint8Array(bucketCount);
    const gapValues: number[] = [];
    const gapSourceIndices: number[] = [];
    let gapOffsets: Uint32Array | null = null;
    const renderOffsets = new Uint32Array(bucketCount + 1);
    const representativeRunScratch = new Int32Array(MAX_COMPACT_GAP_RUNS * GAP_RUN_FIELD_COUNT);

    for (let b = 0; b < bucketCount; b++) {
      const start = b * bucketSize;
      const end = Math.min(start + bucketSize, sourceDataLength);

      let firstIdx = -1;
      let lastIdx = -1;
      let minLow = NaN;
      let maxHigh = NaN;
      let minLowIdx = -1;
      let maxHighIdx = -1;
      let validCount = 0;

      for (let i = start; i < end; i++) {
        const low = getRangeLowerAt(seriesIndex, i);
        const high = getRangeUpperAt(seriesIndex, i);
        if (!Number.isFinite(low) || !Number.isFinite(high)) continue;

        validCount++;
        if (firstIdx === -1) {
          firstIdx = i;
          minLow = low;
          maxHigh = high;
          minLowIdx = i;
          maxHighIdx = i;
        }

        lastIdx = i;

        if (low < minLow) {
          minLow = low;
          minLowIdx = i;
        }
        if (high > maxHigh) {
          maxHigh = high;
          maxHighIdx = i;
        }
      }

      const baseIdx = b * 12;
      if (firstIdx === -1) {
        lodData.fill(NaN, baseIdx, baseIdx + 12);
        if (gapOffsets) gapOffsets[b + 1] = gapValues.length / 3;
        renderOffsets[b + 1] = renderOffsets[b] + 4;
        continue;
      }

      const hasLeadingGap = firstIdx > start;
      const hasInternalGap = validCount < lastIdx - firstIdx + 1;
      const hasTrailingGap = lastIdx < end - 1;

      if (hasLeadingGap) {
        writeRangeLODNaN(lodData, baseIdx);
      } else {
        writeRangeLODPoint(lodData, baseIdx, seriesIndex, firstIdx);
      }

      const firstExtremeIdx = minLowIdx <= maxHighIdx ? minLowIdx : maxHighIdx;
      const secondExtremeIdx = minLowIdx <= maxHighIdx ? maxHighIdx : minLowIdx;
      writeRangeLODPoint(lodData, baseIdx + 3, seriesIndex, firstExtremeIdx);
      writeRangeLODPoint(lodData, baseIdx + 6, seriesIndex, secondExtremeIdx);

      if (hasInternalGap || hasTrailingGap) {
        writeRangeLODNaN(lodData, baseIdx + 9);
      } else {
        writeRangeLODPoint(lodData, baseIdx + 9, seriesIndex, lastIdx);
      }

      let gapPointCount = 0;
      if (hasInternalGap) {
        gapPointCount = appendRangeGapBucket(
          gapValues,
          gapSourceIndices,
          seriesIndex,
          start,
          end,
          minLowIdx,
          maxHighIdx,
          representativeRunScratch,
        );
        if (gapPointCount === -1) {
          internalGapBuckets[b] = COLLAPSED_GAP_BUCKET;
          gapPointCount = 1;
        } else {
          if (gapPointCount < -1) {
            internalGapBuckets[b] = REPRESENTATIVE_GAP_BUCKET;
            gapPointCount = -gapPointCount - 1;
          } else {
            internalGapBuckets[b] = 1;
          }
          gapOffsets ??= new Uint32Array(bucketCount + 1);
        }
      }
      if (gapOffsets) gapOffsets[b + 1] = gapValues.length / 3;
      renderOffsets[b + 1] = renderOffsets[b] + (hasInternalGap ? gapPointCount : 4);
    }

    return {
      bucketSize,
      bucketCount,
      sourceDataLength,
      sourceRevision,
      data: lodData,
      internalGapBuckets,
      gapData: new Float64Array(gapValues),
      gapSourceIndices: new Uint32Array(gapSourceIndices),
      gapOffsets: gapOffsets ?? new Uint32Array(0),
      renderOffsets,
    };
  }

  function buildLODLevel(levelIdx: number, sourceDataLength: number, sourceRevision: number) {
    if (!dataX) return;

    const bucketSize = LOD_BUCKET_SIZES[levelIdx];
    if (bucketSize >= sourceDataLength) return;

    for (let s = 0; s < seriesConfig.count; s++) {
      const bucketCount = Math.ceil(sourceDataLength / bucketSize);
      // 8 floats per bucket: first(x,y), min/max ordered by x (x,y,x,y), last(x,y)
      const lodData = new Float64Array(bucketCount * 8);
      const internalGapBuckets = new Uint8Array(bucketCount);
      const gapValues: number[] = [];
      const gapSourceIndices: number[] = [];
      let gapOffsets: Uint32Array | null = null;
      const renderOffsets = new Uint32Array(bucketCount + 1);
      const representativeRunScratch = new Int32Array(MAX_COMPACT_GAP_RUNS * GAP_RUN_FIELD_COUNT);
      const preserveSingletonRuns = isDiscreteSeriesType(getSeriesType(s));

      for (let b = 0; b < bucketCount; b++) {
        const start = b * bucketSize;
        const end = Math.min(start + bucketSize, sourceDataLength);

        // Find first valid, last valid, min, max, and count valid points
        let firstIdx = -1,
          lastIdx = -1;
        let minY = NaN,
          maxY = NaN;
        let minIdx = -1,
          maxIdx = -1;
        let validCount = 0;

        for (let i = start; i < end; i++) {
          const val = getYAt(s, i);
          if (!Number.isFinite(val)) continue;

          validCount++;

          if (firstIdx === -1) {
            firstIdx = i;
            minY = maxY = val;
            minIdx = maxIdx = i;
          }

          lastIdx = i;

          if (val < minY) {
            minY = val;
            minIdx = i;
          }
          if (val > maxY) {
            maxY = val;
            maxIdx = i;
          }
        }

        const baseIdx = b * 8;
        if (firstIdx === -1) {
          // No valid data in bucket - all NaN
          for (let i = 0; i < 8; i++) lodData[baseIdx + i] = NaN;
        } else {
          // Check for gaps: leading (before first valid), internal, trailing (after last valid)
          const hasLeadingGap = firstIdx > start;
          const hasInternalGap = validCount < lastIdx - firstIdx + 1;
          const hasTrailingGap = lastIdx < end - 1;

          // First point - NaN if leading gap to break connection from previous bucket
          if (hasLeadingGap) {
            lodData[baseIdx] = NaN;
            lodData[baseIdx + 1] = NaN;
          } else {
            lodData[baseIdx] = getXAt(firstIdx);
            lodData[baseIdx + 1] = getYAt(s, firstIdx);
          }

          // Min/Max in temporal order
          if (minIdx <= maxIdx) {
            lodData[baseIdx + 2] = getXAt(minIdx);
            lodData[baseIdx + 3] = minY;
            lodData[baseIdx + 4] = getXAt(maxIdx);
            lodData[baseIdx + 5] = maxY;
          } else {
            lodData[baseIdx + 2] = getXAt(maxIdx);
            lodData[baseIdx + 3] = maxY;
            lodData[baseIdx + 4] = getXAt(minIdx);
            lodData[baseIdx + 5] = minY;
          }

          // Last point - NaN if internal or trailing gaps to break connection to next bucket
          if (hasInternalGap || hasTrailingGap) {
            lodData[baseIdx + 6] = NaN;
            lodData[baseIdx + 7] = NaN;
          } else {
            lodData[baseIdx + 6] = getXAt(lastIdx);
            lodData[baseIdx + 7] = getYAt(s, lastIdx);
          }

          let gapPointCount = 0;
          if (hasInternalGap) {
            gapPointCount = appendLineGapBucket(
              gapValues,
              gapSourceIndices,
              s,
              start,
              end,
              minIdx,
              maxIdx,
              representativeRunScratch,
              preserveSingletonRuns,
            );
            if (gapPointCount === -1) {
              internalGapBuckets[b] = COLLAPSED_GAP_BUCKET;
              gapPointCount = 1;
            } else {
              if (gapPointCount < -1) {
                internalGapBuckets[b] = REPRESENTATIVE_GAP_BUCKET;
                gapPointCount = -gapPointCount - 1;
              } else {
                internalGapBuckets[b] = 1;
              }
              gapOffsets ??= new Uint32Array(bucketCount + 1);
            }
          }
          if (gapOffsets) gapOffsets[b + 1] = gapValues.length / 2;
          renderOffsets[b + 1] = renderOffsets[b] + (hasInternalGap ? gapPointCount : 4);
        }

        if (firstIdx === -1) {
          if (gapOffsets) gapOffsets[b + 1] = gapValues.length / 2;
          renderOffsets[b + 1] = renderOffsets[b] + 4;
        }
      }

      const insertIdx = lodLevelsBySeries[s].findIndex((l) => l.bucketSize > bucketSize);
      const lodLevel: LODLevel = {
        bucketSize,
        bucketCount,
        sourceDataLength,
        sourceRevision,
        data: lodData,
        internalGapBuckets,
        gapData: new Float64Array(gapValues),
        gapSourceIndices: new Uint32Array(gapSourceIndices),
        gapOffsets: gapOffsets ?? new Uint32Array(0),
        renderOffsets,
      };
      if (insertIdx === -1) {
        lodLevelsBySeries[s].push(lodLevel);
      } else {
        lodLevelsBySeries[s].splice(insertIdx, 0, lodLevel);
      }

      const rangeLevels = rangeLodLevelsBySeries[s];
      if (rangeLevels) {
        const rangeLODLevel = buildRangeLODLevelForSeries(
          s,
          bucketSize,
          bucketCount,
          sourceDataLength,
          sourceRevision,
        );
        const rangeInsertIdx = rangeLevels.findIndex((l) => l.bucketSize > bucketSize);
        if (rangeInsertIdx === -1) {
          rangeLevels.push(rangeLODLevel);
        } else {
          rangeLevels.splice(rangeInsertIdx, 0, rangeLODLevel);
        }
      }
    }
  }

  function buildRemainingLODs(
    startIdx: number,
    generation: number,
    sourceDataLength: number,
    sourceRevision: number,
  ) {
    if (stopped || generation !== lodBuildGeneration) return;

    if (startIdx < 1) {
      lodBuildComplete = sourceRevision === lodSourceRevision;
      state.cacheValid = false; // Force re-render with all LODs available
      state.rangePreviewValid = false; // Re-render preview with final LOD levels
      resetCachedYMinMax();
      scheduleRender();
      return;
    }

    if (ssr) {
      for (let idx = startIdx; idx >= 1; idx--) {
        if (stopped || generation !== lodBuildGeneration) return;
        buildLODLevel(idx, sourceDataLength, sourceRevision);
        resetCachedYMinMax();
        lodLevelsBuilt++;
      }
      lodBuildComplete = sourceRevision === lodSourceRevision;
      state.cacheValid = false;
      state.rangePreviewValid = false;
      resetCachedYMinMax();
      scheduleRender();
      return;
    }

    rendererScheduler.scheduleTask(() => {
      if (stopped || generation !== lodBuildGeneration) return;
      buildLODLevel(startIdx, sourceDataLength, sourceRevision);
      resetCachedYMinMax();
      lodLevelsBuilt++;
      buildRemainingLODs(startIdx - 1, generation, sourceDataLength, sourceRevision);
    }, 10);
  }

  function scheduleLODRebuild(delayMs = 100): void {
    if (stopped || !dataX || dataLength === 0) return;
    if (ssr) {
      buildLODLevels();
      return;
    }
    lodBuildComplete = false;
    // A growing, not-yet-full ring has an immutable logical prefix. Let a
    // staged build finish that snapshot while new tail samples arrive; its
    // revision metadata keeps the tail raw and the next bounded rebuild catches
    // up. Once eviction starts, logical indices shift and the in-flight snapshot
    // must be cancelled immediately.
    if (!ringBufferMode || bufferFull) lodBuildGeneration++;

    const now = performance.now();
    if (lodRebuildDeadline === 0) lodRebuildDeadline = now + LOD_REBUILD_MAX_WAIT_MS;
    // Honor the debounce, but never wait past the deadline.
    const wait = Math.max(0, Math.min(delayMs, lodRebuildDeadline - now));

    clearScheduledLODRebuild();
    lodRebuildTimer = rendererScheduler.scheduleTask(() => {
      lodRebuildTimer = null;
      if (stopped) return;
      buildLODLevels();
      scheduleRender();
    }, wait);
  }

  // Stateless ideal-level choice for the given viewport and width, combining
  // the density floor, the range work refinement, and the staged-build
  // fallback. selectLODLevel wraps this with switch hysteresis.
  function computeIdealLODIndex(visiblePoints: number, chartWidth: number): number {
    if (lodLevelsBySeries.length === 0) return 0;
    const lodLevels = lodLevelsBySeries[0];

    const baseTargetPerPixel = 2;
    const visibleSeriesCount = getVisibleSeriesCount();
    const targetPointsPerPixel = baseTargetPerPixel / Math.max(1, visibleSeriesCount / 2);
    const targetPoints = chartWidth * targetPointsPerPixel;

    // Continuity floor: a level is acceptable only when its visible buckets are
    // at least as dense as the pixel grid. Counting retained points instead
    // (four per bucket) accepts levels that are 4x too coarse and disintegrate
    // into separated per-bucket strokes. Pick the coarsest acceptable level.
    const targetBuckets = chartWidth * LOD_MIN_BUCKETS_PER_PIXEL;

    let selectedIndex = 0;

    for (let i = lodLevels.length - 1; i >= 1; i--) {
      const level = lodLevels[i];
      const visibleBuckets = visiblePoints / level.bucketSize;
      if (visibleBuckets >= targetBuckets) {
        selectedIndex = i;
        break;
      }
    }

    // Ordinary series render one path per retained point and keep the exact
    // historical selection above. A range series can render several paths for
    // every retained point, so refine an over-budget completed LOD using the
    // actual visible render-pass weight. Comparing only coarser levels preserves
    // extrema while avoiding Firefox's dense Canvas2D fill/stroke cliff.
    if (lodBuildComplete) {
      const renderWorkWeight = getVisibleRenderWorkWeight();
      const selectedLevel = lodLevels[selectedIndex];
      const selectedPoints =
        selectedIndex === 0 ? visiblePoints : (visiblePoints / selectedLevel.bucketSize) * 4;
      const selectedWork = selectedPoints * renderWorkWeight;
      const renderWorkLimit = chartWidth * RANGE_RENDER_WORK_PER_PIXEL_LIMIT;

      if (hasVisibleMultiPassRange() && selectedWork > renderWorkLimit) {
        const targetWork = targetPoints * visibleSeriesCount;
        let bestIndex = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        let coarsestCandidate = -1;

        for (let i = selectedIndex + 1; i < lodLevels.length; i++) {
          const level = lodLevels[i];
          coarsestCandidate = i;
          const estimatedPoints = (visiblePoints / level.bucketSize) * 4;
          const estimatedWork = estimatedPoints * renderWorkWeight;
          if (estimatedWork > renderWorkLimit) continue;
          const distance = Math.abs(estimatedWork - targetWork);
          if (distance < bestDistance) {
            bestIndex = i;
            bestDistance = distance;
          }
        }

        if (bestIndex >= 0) return bestIndex;
        if (coarsestCandidate >= 0) return coarsestCandidate;
      }
    }

    if (selectedIndex > 0) return selectedIndex;

    // During a staged build, rendering a dense RAW range before intermediate
    // levels exist can turn the first frame into a multi-million-point stall.
    // Binary-search culling keeps small visible ranges cheap, though, and those
    // must remain RAW while streaming rebuilds are pending to avoid fidelity
    // flicker. targetPoints already accounts for the visible-series count, so
    // use it directly as the temporary RAW-work budget.
    const rawWouldBeExpensive =
      targetPoints > 0 && visiblePoints > targetPoints * STAGED_RAW_WORK_BUDGET_MULTIPLIER;
    return !lodBuildComplete && lodLevels.length > 1 && rawWouldBeExpensive
      ? lodLevels.length - 1
      : 0;
  }

  function selectLODLevel(visiblePoints: number, chartWidth: number): number {
    const ideal = computeIdealLODIndex(visiblePoints, chartWidth);
    let selected = ideal;

    // Switch hysteresis over the FINAL choice (density floor and range work
    // refinement alike): keep the previous level while it lies between the
    // levels a slightly narrower and slightly wider chart would pick. Every
    // selection boundary scales with chart width, so this deadband stops zoom
    // jitter from flapping any of them, and switches happen once, decisively.
    // During a staged build, RAW may be rejected by the safety fallback even
    // though the ideal completed-build choice is RAW. Do not let remembered RAW
    // delay that fallback; once the hierarchy is complete, level 0 participates
    // in the same deadband as every non-raw level.
    const canApplyHysteresis = lodBuildComplete || (ideal >= 1 && lastSelectedLODIndex >= 1);
    if (
      canApplyHysteresis &&
      lastSelectedLODIndex >= 0 &&
      lastSelectedLODIndex < lodLevelsBySeries[0].length &&
      lastSelectedLODIndex !== ideal
    ) {
      const idealNarrow = computeIdealLODIndex(
        visiblePoints,
        chartWidth * (1 - LOD_SWITCH_HYSTERESIS),
      );
      const idealWide = computeIdealLODIndex(
        visiblePoints,
        chartWidth * (1 + LOD_SWITCH_HYSTERESIS),
      );
      const finest = Math.min(idealNarrow, idealWide, ideal);
      const coarsest = Math.max(idealNarrow, idealWide, ideal);
      if (lastSelectedLODIndex >= finest && lastSelectedLODIndex <= coarsest) {
        selected = lastSelectedLODIndex;
      }
    }

    lastSelectedLODIndex = selected;
    return selected;
  }

  interface RawRenderSeriesData {
    mode: "raw";
    seriesIndex: number;
    startIdx: number;
    endIdx: number;
    length: number;
  }

  interface LODRenderSeriesData {
    mode: "lod";
    lodData: Float64Array;
    internalGapBuckets: Uint8Array;
    gapData: Float64Array;
    gapOffsets: Uint32Array;
    startBucket: number;
    endBucket: number;
    length: number;
  }

  interface ColumnRenderSeriesData {
    mode: "columns";
    columnData: Float64Array;
    columnCount: number;
    length: number;
    rangeColumnData?: Float64Array;
    rangeColumnCount?: number;
    rangeLength?: number;
  }

  interface RawRangeRenderSeriesData {
    mode: "raw";
    seriesIndex: number;
    startIdx: number;
    endIdx: number;
    length: number;
  }

  interface LODRangeRenderSeriesData {
    mode: "lod";
    lodData: Float64Array;
    internalGapBuckets: Uint8Array;
    gapData: Float64Array;
    gapOffsets: Uint32Array;
    renderOffsets: Uint32Array;
    startBucket: number;
    endBucket: number;
    length: number;
    cachedOrdinal: number;
    cachedBucket: number;
    cachedPointBase: number;
    cachedGapPointBase: number;
  }

  interface ColumnRangeRenderSeriesData {
    mode: "columns";
    columnData: Float64Array;
    length: number;
  }

  interface RangePresentationColumnData extends ColumnRangeRenderSeriesData {
    columnCount: number;
  }

  type RangeRenderSeriesData =
    RawRangeRenderSeriesData | LODRangeRenderSeriesData | ColumnRangeRenderSeriesData;

  type RenderSeriesData = (RawRenderSeriesData | LODRenderSeriesData | ColumnRenderSeriesData) & {
    rangeRenderData?: RangeRenderSeriesData | null;
  };

  function ensurePresentationColumnBuffer(
    seriesIndex: number,
    requiredColumns: number,
  ): PresentationColumnBuffer {
    const existing = presentationColumnBuffers[seriesIndex];
    if (existing && existing.capacity >= requiredColumns) return existing;

    let capacity = existing?.capacity ?? 0;
    if (capacity === 0) capacity = 256;
    while (capacity < requiredColumns) capacity *= 2;

    const next: PresentationColumnBuffer = {
      data: new Float64Array(capacity * PRESENTATION_MAX_POINTS_PER_COLUMN * 2),
      capacity,
      runScratch:
        existing?.runScratch ??
        new Float64Array(PRESENTATION_RUN_SCRATCH_SLOTS * PRESENTATION_RUN_FIELD_COUNT),
      selectionScratch: existing?.selectionScratch ?? new Int32Array(MAX_COMPACT_GAP_RUNS),
    };
    presentationColumnBuffers[seriesIndex] = next;
    return next;
  }

  function ensureRangePresentationColumnBuffer(
    seriesIndex: number,
    requiredColumns: number,
  ): RangePresentationColumnBuffer {
    const existing = rangePresentationColumnBuffers[seriesIndex];
    if (existing && existing.capacity >= requiredColumns) return existing;

    let capacity = existing?.capacity ?? 0;
    if (capacity === 0) capacity = 256;
    while (capacity < requiredColumns) capacity *= 2;

    const next: RangePresentationColumnBuffer = {
      data: new Float64Array(capacity * PRESENTATION_MAX_POINTS_PER_COLUMN * 3),
      capacity,
      runScratch:
        existing?.runScratch ??
        new Float64Array(PRESENTATION_RUN_SCRATCH_SLOTS * RANGE_PRESENTATION_RUN_FIELD_COUNT),
      selectionScratch: existing?.selectionScratch ?? new Int32Array(MAX_COMPACT_GAP_RUNS),
    };
    rangePresentationColumnBuffers[seriesIndex] = next;
    return next;
  }

  function classifyPresentationLODBucket(level: LODLevel, bucket: number): number {
    if (bucket < 0 || bucket >= level.bucketCount || !isLODSourceCurrentForBucket(level, bucket)) {
      return PRESENTATION_BUCKET_INVALID;
    }

    const gapKind = level.internalGapBuckets[bucket];
    if (gapKind === COLLAPSED_GAP_BUCKET) {
      return PRESENTATION_BUCKET_BREAK;
    }
    if (gapKind === 1) {
      if (
        level.gapOffsets.length <= bucket + 1 ||
        level.gapOffsets[bucket] > level.gapOffsets[bucket + 1] ||
        level.gapOffsets[bucket + 1] > level.gapSourceIndices.length ||
        level.gapOffsets[bucket + 1] * 2 > level.gapData.length
      ) {
        return PRESENTATION_BUCKET_INVALID;
      }
      return PRESENTATION_BUCKET_COMPACT_GAP;
    }
    if (gapKind !== 0) return PRESENTATION_BUCKET_INVALID;

    const base = bucket * 8;
    let finiteValues = 0;
    for (let offset = 0; offset < 8; offset++) {
      if (Number.isFinite(level.data[base + offset])) finiteValues++;
    }
    if (finiteValues === 8) return PRESENTATION_BUCKET_NORMAL;
    if (finiteValues === 0) return PRESENTATION_BUCKET_BREAK;
    // Leading- or trailing-only gaps have no compact run summary. Descend until
    // exact finite and break-only child buckets can represent both sides.
    return PRESENTATION_BUCKET_INVALID;
  }

  function isLODSourceCurrentForBucket(
    level: Pick<LODLevel, "bucketSize" | "sourceDataLength" | "sourceRevision">,
    bucket: number,
  ): boolean {
    // A summary may replace raw points only when the complete source bucket was
    // present when that summary was built. This deliberately leaves a growing
    // partial tail raw until it reaches the next bucket boundary.
    if ((bucket + 1) * level.bucketSize > level.sourceDataLength) return false;

    // Before a ring fills, existing logical indices never move and summaries for
    // its immutable prefix remain valid. Once it fills, every append shifts the
    // logical origin, so only a hierarchy built from the current revision is
    // safe to query.
    return !ringBufferMode || !bufferFull || level.sourceRevision === lodSourceRevision;
  }

  function isLODSourceCurrentForRange(
    level: Pick<LODLevel, "sourceDataLength" | "sourceRevision">,
    endIdx: number,
  ): boolean {
    if (endIdx >= level.sourceDataLength) return false;
    return !ringBufferMode || !bufferFull || level.sourceRevision === lodSourceRevision;
  }

  function largestContainedLODIndex(
    levels: Array<{ bucketSize: number }>,
    cursor: number,
    remaining: number,
  ): number {
    // Staged builds contain a sparse subset such as [raw, 8192], so an array
    // index is not a bucket-size exponent. Inspect the six possible hierarchy
    // entries directly and accept one only when this screen column contains the
    // whole aligned source bucket.
    for (let index = levels.length - 1; index >= 1; index--) {
      const bucketSize = levels[index].bucketSize;
      if (bucketSize <= remaining && cursor % bucketSize === 0) return index;
    }
    return 0;
  }

  function presentationRunBase(slot: number): number {
    return slot * PRESENTATION_RUN_FIELD_COUNT;
  }

  function clearPresentationRun(scratch: Float64Array, slot: number): void {
    scratch[presentationRunBase(slot) + PRESENTATION_RUN_ID] = -1;
  }

  function copyPresentationRun(
    scratch: Float64Array,
    sourceSlot: number,
    targetSlot: number,
  ): void {
    const sourceBase = presentationRunBase(sourceSlot);
    const targetBase = presentationRunBase(targetSlot);
    scratch.copyWithin(targetBase, sourceBase, sourceBase + PRESENTATION_RUN_FIELD_COUNT);
  }

  function beginPresentationRun(
    scratch: Float64Array,
    runId: number,
    sourceIndex: number,
    x: number,
    y: number,
    order: number,
  ): void {
    const base = presentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
    scratch[base + PRESENTATION_RUN_ID] = runId;
    scratch[base + PRESENTATION_RUN_FIRST_INDEX] = sourceIndex;
    scratch[base + PRESENTATION_RUN_LAST_INDEX] = sourceIndex;
    scratch[base + PRESENTATION_RUN_FIRST_X] = x;
    scratch[base + PRESENTATION_RUN_FIRST_Y] = y;
    scratch[base + PRESENTATION_RUN_MIN_X] = x;
    scratch[base + PRESENTATION_RUN_MIN_Y] = y;
    scratch[base + PRESENTATION_RUN_MIN_ORDER] = order;
    scratch[base + PRESENTATION_RUN_MAX_X] = x;
    scratch[base + PRESENTATION_RUN_MAX_Y] = y;
    scratch[base + PRESENTATION_RUN_MAX_ORDER] = order;
    scratch[base + PRESENTATION_RUN_LAST_X] = x;
    scratch[base + PRESENTATION_RUN_LAST_Y] = y;
    scratch[base + PRESENTATION_RUN_LENGTH] = 1;
  }

  function appendPresentationRunPoint(
    scratch: Float64Array,
    x: number,
    y: number,
    order: number,
  ): void {
    const base = presentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
    scratch[base + PRESENTATION_RUN_LAST_X] = x;
    scratch[base + PRESENTATION_RUN_LAST_Y] = y;
    if (y < scratch[base + PRESENTATION_RUN_MIN_Y]) {
      scratch[base + PRESENTATION_RUN_MIN_X] = x;
      scratch[base + PRESENTATION_RUN_MIN_Y] = y;
      scratch[base + PRESENTATION_RUN_MIN_ORDER] = order;
    }
    if (y > scratch[base + PRESENTATION_RUN_MAX_Y]) {
      scratch[base + PRESENTATION_RUN_MAX_X] = x;
      scratch[base + PRESENTATION_RUN_MAX_Y] = y;
      scratch[base + PRESENTATION_RUN_MAX_ORDER] = order;
    }
  }

  function finishPresentationRunSpan(scratch: Float64Array, lastSourceIndex: number): void {
    const base = presentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
    scratch[base + PRESENTATION_RUN_LAST_INDEX] = lastSourceIndex;
    scratch[base + PRESENTATION_RUN_LENGTH] =
      lastSourceIndex - scratch[base + PRESENTATION_RUN_FIRST_INDEX] + 1;
  }

  function capturePresentationRun(scratch: Float64Array, runOrdinal: number): void {
    const currentBase = presentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
    if (runOrdinal < MAX_COMPACT_GAP_RUNS) {
      copyPresentationRun(
        scratch,
        PRESENTATION_CURRENT_RUN_SLOT,
        PRESENTATION_FIRST_RUN_SLOT + runOrdinal,
      );
    }

    const minBase = presentationRunBase(PRESENTATION_MIN_RUN_SLOT);
    if (
      scratch[minBase + PRESENTATION_RUN_ID] < 0 ||
      scratch[currentBase + PRESENTATION_RUN_MIN_Y] < scratch[minBase + PRESENTATION_RUN_MIN_Y]
    ) {
      copyPresentationRun(scratch, PRESENTATION_CURRENT_RUN_SLOT, PRESENTATION_MIN_RUN_SLOT);
    }

    const maxBase = presentationRunBase(PRESENTATION_MAX_RUN_SLOT);
    if (
      scratch[maxBase + PRESENTATION_RUN_ID] < 0 ||
      scratch[currentBase + PRESENTATION_RUN_MAX_Y] > scratch[maxBase + PRESENTATION_RUN_MAX_Y]
    ) {
      copyPresentationRun(scratch, PRESENTATION_CURRENT_RUN_SLOT, PRESENTATION_MAX_RUN_SLOT);
    }

    const currentLength = scratch[currentBase + PRESENTATION_RUN_LENGTH];
    for (let rank = 0; rank < MAX_COMPACT_GAP_RUNS; rank++) {
      const slot = PRESENTATION_LONGEST_RUN_SLOT + rank;
      const base = presentationRunBase(slot);
      if (
        scratch[base + PRESENTATION_RUN_ID] >= 0 &&
        currentLength <= scratch[base + PRESENTATION_RUN_LENGTH]
      ) {
        continue;
      }
      for (let shift = MAX_COMPACT_GAP_RUNS - 1; shift > rank; shift--) {
        copyPresentationRun(
          scratch,
          PRESENTATION_LONGEST_RUN_SLOT + shift - 1,
          PRESENTATION_LONGEST_RUN_SLOT + shift,
        );
      }
      copyPresentationRun(scratch, PRESENTATION_CURRENT_RUN_SLOT, slot);
      break;
    }
  }

  function addSelectedPresentationRun(
    scratch: Float64Array,
    selected: Int32Array,
    selectedCount: number,
    slot: number,
    preserveSingletons: boolean,
  ): number {
    const base = presentationRunBase(slot);
    const runId = scratch[base + PRESENTATION_RUN_ID];
    if (runId < 0 || (!preserveSingletons && scratch[base + PRESENTATION_RUN_LENGTH] <= 1)) {
      return selectedCount;
    }
    for (let index = 0; index < selectedCount; index++) {
      const selectedBase = presentationRunBase(selected[index]);
      if (scratch[selectedBase + PRESENTATION_RUN_ID] === runId) {
        return selectedCount;
      }
    }
    selected[selectedCount] = slot;
    return selectedCount + 1;
  }

  function selectPresentationRuns(
    scratch: Float64Array,
    selected: Int32Array,
    runCount: number,
    preserveSingletons: boolean,
  ): number {
    selected.fill(-1);
    let selectedCount = 0;

    if (runCount <= MAX_COMPACT_GAP_RUNS) {
      for (let run = 0; run < runCount; run++) {
        selectedCount = addSelectedPresentationRun(
          scratch,
          selected,
          selectedCount,
          PRESENTATION_FIRST_RUN_SLOT + run,
          preserveSingletons,
        );
      }
    } else {
      selectedCount = addSelectedPresentationRun(
        scratch,
        selected,
        selectedCount,
        PRESENTATION_MIN_RUN_SLOT,
        preserveSingletons,
      );
      selectedCount = addSelectedPresentationRun(
        scratch,
        selected,
        selectedCount,
        PRESENTATION_MAX_RUN_SLOT,
        preserveSingletons,
      );

      const minRunId =
        scratch[presentationRunBase(PRESENTATION_MIN_RUN_SLOT) + PRESENTATION_RUN_ID];
      const maxRunId =
        scratch[presentationRunBase(PRESENTATION_MAX_RUN_SLOT) + PRESENTATION_RUN_ID];
      for (let rank = 0; rank < MAX_COMPACT_GAP_RUNS; rank++) {
        const slot = PRESENTATION_LONGEST_RUN_SLOT + rank;
        const base = presentationRunBase(slot);
        const runId = scratch[base + PRESENTATION_RUN_ID];
        if (runId >= 0 && runId !== minRunId && runId !== maxRunId) {
          selectedCount = addSelectedPresentationRun(
            scratch,
            selected,
            selectedCount,
            slot,
            preserveSingletons,
          );
          break;
        }
      }
    }

    for (let index = 1; index < selectedCount; index++) {
      const slot = selected[index];
      const firstIndex = scratch[presentationRunBase(slot) + PRESENTATION_RUN_FIRST_INDEX];
      let insertion = index;
      while (insertion > 0) {
        const previousFirstIndex =
          scratch[presentationRunBase(selected[insertion - 1]) + PRESENTATION_RUN_FIRST_INDEX];
        if (previousFirstIndex <= firstIndex) break;
        selected[insertion] = selected[insertion - 1];
        insertion--;
      }
      selected[insertion] = slot;
    }
    return selectedCount;
  }

  function appendPresentationBreak(target: Float64Array, targetOffset: number): number {
    target[targetOffset] = NaN;
    target[targetOffset + 1] = NaN;
    return targetOffset + 2;
  }

  function appendPresentationRunSummary(
    target: Float64Array,
    targetOffset: number,
    scratch: Float64Array,
    slot: number,
  ): number {
    const base = presentationRunBase(slot);
    let previousX = NaN;
    let previousY = NaN;
    let hasPrevious = false;

    for (let point = 0; point < 4; point++) {
      let x: number;
      let y: number;
      if (point === 0) {
        x = scratch[base + PRESENTATION_RUN_FIRST_X];
        y = scratch[base + PRESENTATION_RUN_FIRST_Y];
      } else if (point === 3) {
        x = scratch[base + PRESENTATION_RUN_LAST_X];
        y = scratch[base + PRESENTATION_RUN_LAST_Y];
      } else {
        const minFirst =
          scratch[base + PRESENTATION_RUN_MIN_ORDER] <= scratch[base + PRESENTATION_RUN_MAX_ORDER];
        const useMinimum = point === 1 ? minFirst : !minFirst;
        x = scratch[base + (useMinimum ? PRESENTATION_RUN_MIN_X : PRESENTATION_RUN_MAX_X)];
        y = scratch[base + (useMinimum ? PRESENTATION_RUN_MIN_Y : PRESENTATION_RUN_MAX_Y)];
      }
      if (hasPrevious && x === previousX && y === previousY) continue;
      target[targetOffset++] = x;
      target[targetOffset++] = y;
      previousX = x;
      previousY = y;
      hasPrevious = true;
    }
    return targetOffset;
  }

  function writeHierarchicalPresentationColumn(
    seriesIndex: number,
    startIdx: number,
    endIdx: number,
    target: Float64Array,
    targetBase: number,
    scratch: Float64Array,
    selected: Int32Array,
    preserveSingletons: boolean,
  ): number {
    if (targetBase + PRESENTATION_MAX_POINTS_PER_COLUMN * 2 > target.length) {
      return -1;
    }

    for (let slot = 0; slot < PRESENTATION_RUN_SCRATCH_SLOTS; slot++) {
      clearPresentationRun(scratch, slot);
    }

    const levels = lodLevelsBySeries[seriesIndex];
    let cursor = startIdx;
    let order = 0;
    let runCount = 0;
    let hasGap = false;

    while (cursor <= endIdx) {
      let selectedLevel: LODLevel | null = null;
      let selectedBucket = -1;
      let selectedBucketKind = PRESENTATION_BUCKET_INVALID;
      const remaining = endIdx - cursor + 1;

      for (
        let levelIndex = largestContainedLODIndex(levels, cursor, remaining);
        levelIndex >= 1;
        levelIndex--
      ) {
        lastPresentationQueryVisits++;
        const level = levels[levelIndex];
        const bucketSize = level.bucketSize;
        const bucket = cursor / bucketSize;
        const bucketKind = classifyPresentationLODBucket(level, bucket);
        if (bucketKind === PRESENTATION_BUCKET_INVALID) continue;
        selectedLevel = level;
        selectedBucket = bucket;
        selectedBucketKind = bucketKind;
        break;
      }

      if (selectedLevel) {
        const bucketStart = cursor;
        const bucketEnd = cursor + selectedLevel.bucketSize - 1;
        if (selectedBucketKind === PRESENTATION_BUCKET_NORMAL) {
          const sourceBase = selectedBucket * 8;
          for (let point = 0; point < 4; point++) {
            const pointBase = sourceBase + point * 2;
            const x = selectedLevel.data[pointBase];
            const y = selectedLevel.data[pointBase + 1];
            const currentBase = presentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
            if (scratch[currentBase + PRESENTATION_RUN_ID] < 0) {
              beginPresentationRun(scratch, runCount, bucketStart, x, y, order);
            } else {
              appendPresentationRunPoint(scratch, x, y, order);
            }
            order++;
          }
          finishPresentationRunSpan(scratch, bucketEnd);
        } else if (selectedBucketKind === PRESENTATION_BUCKET_COMPACT_GAP) {
          const startPoint = selectedLevel.gapOffsets[selectedBucket];
          const endPoint = selectedLevel.gapOffsets[selectedBucket + 1];
          for (let point = startPoint; point < endPoint; point++) {
            const sourceIndex = selectedLevel.gapSourceIndices[point];
            if (sourceIndex === GAP_BREAK_SOURCE_INDEX) {
              hasGap = true;
              const currentBase = presentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
              if (scratch[currentBase + PRESENTATION_RUN_ID] >= 0) {
                capturePresentationRun(scratch, runCount++);
                clearPresentationRun(scratch, PRESENTATION_CURRENT_RUN_SLOT);
              }
              continue;
            }
            if (sourceIndex < bucketStart || sourceIndex > bucketEnd) return -1;
            const pointBase = point * 2;
            const x = selectedLevel.gapData[pointBase];
            const y = selectedLevel.gapData[pointBase + 1];
            if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
            const currentBase = presentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
            if (scratch[currentBase + PRESENTATION_RUN_ID] < 0) {
              beginPresentationRun(scratch, runCount, sourceIndex, x, y, order);
            } else {
              appendPresentationRunPoint(scratch, x, y, order);
            }
            finishPresentationRunSpan(scratch, sourceIndex);
            order++;
          }
        } else {
          hasGap = true;
          const currentBase = presentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
          if (scratch[currentBase + PRESENTATION_RUN_ID] >= 0) {
            capturePresentationRun(scratch, runCount++);
            clearPresentationRun(scratch, PRESENTATION_CURRENT_RUN_SLOT);
          }
        }
        cursor += selectedLevel.bucketSize;
        if (selectedLevel.bucketSize > lastPresentationLargestBucket) {
          lastPresentationLargestBucket = selectedLevel.bucketSize;
        }
        continue;
      }

      lastPresentationQueryVisits++;
      const x = getXAt(cursor);
      const y = getYAt(seriesIndex, cursor);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        const currentBase = presentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
        if (scratch[currentBase + PRESENTATION_RUN_ID] < 0) {
          beginPresentationRun(scratch, runCount, cursor, x, y, order);
        } else {
          appendPresentationRunPoint(scratch, x, y, order);
        }
        finishPresentationRunSpan(scratch, cursor);
        order++;
      } else {
        hasGap = true;
        const currentBase = presentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
        if (scratch[currentBase + PRESENTATION_RUN_ID] >= 0) {
          capturePresentationRun(scratch, runCount++);
          clearPresentationRun(scratch, PRESENTATION_CURRENT_RUN_SLOT);
        }
      }
      cursor++;
    }

    const currentBase = presentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
    if (scratch[currentBase + PRESENTATION_RUN_ID] >= 0) {
      capturePresentationRun(scratch, runCount++);
      clearPresentationRun(scratch, PRESENTATION_CURRENT_RUN_SLOT);
    }

    if (!hasGap) {
      if (runCount !== 1) return -1;
      const base = presentationRunBase(PRESENTATION_FIRST_RUN_SLOT);
      target[targetBase] = scratch[base + PRESENTATION_RUN_FIRST_X];
      target[targetBase + 1] = scratch[base + PRESENTATION_RUN_FIRST_Y];
      if (
        scratch[base + PRESENTATION_RUN_MIN_ORDER] <= scratch[base + PRESENTATION_RUN_MAX_ORDER]
      ) {
        target[targetBase + 2] = scratch[base + PRESENTATION_RUN_MIN_X];
        target[targetBase + 3] = scratch[base + PRESENTATION_RUN_MIN_Y];
        target[targetBase + 4] = scratch[base + PRESENTATION_RUN_MAX_X];
        target[targetBase + 5] = scratch[base + PRESENTATION_RUN_MAX_Y];
      } else {
        target[targetBase + 2] = scratch[base + PRESENTATION_RUN_MAX_X];
        target[targetBase + 3] = scratch[base + PRESENTATION_RUN_MAX_Y];
        target[targetBase + 4] = scratch[base + PRESENTATION_RUN_MIN_X];
        target[targetBase + 5] = scratch[base + PRESENTATION_RUN_MIN_Y];
      }
      target[targetBase + 6] = scratch[base + PRESENTATION_RUN_LAST_X];
      target[targetBase + 7] = scratch[base + PRESENTATION_RUN_LAST_Y];
      return 4;
    }

    const selectedCount = selectPresentationRuns(scratch, selected, runCount, preserveSingletons);
    if (selectedCount === 0) {
      appendPresentationBreak(target, targetBase);
      return 1;
    }

    let targetOffset = targetBase;
    const firstBase = presentationRunBase(selected[0]);
    const isolateRepresentatives = runCount > MAX_COMPACT_GAP_RUNS;
    if (isolateRepresentatives || scratch[firstBase + PRESENTATION_RUN_FIRST_INDEX] > startIdx) {
      targetOffset = appendPresentationBreak(target, targetOffset);
    }
    for (let index = 0; index < selectedCount; index++) {
      if (index > 0) {
        targetOffset = appendPresentationBreak(target, targetOffset);
      }
      targetOffset = appendPresentationRunSummary(target, targetOffset, scratch, selected[index]);
    }
    const lastBase = presentationRunBase(selected[selectedCount - 1]);
    if (isolateRepresentatives || scratch[lastBase + PRESENTATION_RUN_LAST_INDEX] < endIdx) {
      targetOffset = appendPresentationBreak(target, targetOffset);
    }
    return (targetOffset - targetBase) / 2;
  }

  function rangePresentationRunBase(slot: number): number {
    return slot * RANGE_PRESENTATION_RUN_FIELD_COUNT;
  }

  function clearRangePresentationRun(scratch: Float64Array, slot: number): void {
    scratch[rangePresentationRunBase(slot) + RANGE_RUN_ID] = -1;
  }

  function copyRangePresentationRun(
    scratch: Float64Array,
    sourceSlot: number,
    targetSlot: number,
  ): void {
    const sourceBase = rangePresentationRunBase(sourceSlot);
    const targetBase = rangePresentationRunBase(targetSlot);
    scratch.copyWithin(targetBase, sourceBase, sourceBase + RANGE_PRESENTATION_RUN_FIELD_COUNT);
  }

  function beginRangePresentationRun(
    scratch: Float64Array,
    runId: number,
    sourceIndex: number,
    x: number,
    low: number,
    high: number,
    order: number,
  ): void {
    const base = rangePresentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
    scratch[base + RANGE_RUN_ID] = runId;
    scratch[base + RANGE_RUN_FIRST_INDEX] = sourceIndex;
    scratch[base + RANGE_RUN_LAST_INDEX] = sourceIndex;
    scratch[base + RANGE_RUN_FIRST_X] = x;
    scratch[base + RANGE_RUN_FIRST_LOW] = low;
    scratch[base + RANGE_RUN_FIRST_HIGH] = high;
    scratch[base + RANGE_RUN_MIN_X] = x;
    scratch[base + RANGE_RUN_MIN_LOW] = low;
    scratch[base + RANGE_RUN_MIN_HIGH] = high;
    scratch[base + RANGE_RUN_MIN_ORDER] = order;
    scratch[base + RANGE_RUN_MAX_X] = x;
    scratch[base + RANGE_RUN_MAX_LOW] = low;
    scratch[base + RANGE_RUN_MAX_HIGH] = high;
    scratch[base + RANGE_RUN_MAX_ORDER] = order;
    scratch[base + RANGE_RUN_LAST_X] = x;
    scratch[base + RANGE_RUN_LAST_LOW] = low;
    scratch[base + RANGE_RUN_LAST_HIGH] = high;
    scratch[base + RANGE_RUN_LENGTH] = 1;
  }

  function appendRangePresentationRunPoint(
    scratch: Float64Array,
    x: number,
    low: number,
    high: number,
    order: number,
  ): void {
    const base = rangePresentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
    scratch[base + RANGE_RUN_LAST_X] = x;
    scratch[base + RANGE_RUN_LAST_LOW] = low;
    scratch[base + RANGE_RUN_LAST_HIGH] = high;
    if (low < scratch[base + RANGE_RUN_MIN_LOW]) {
      scratch[base + RANGE_RUN_MIN_X] = x;
      scratch[base + RANGE_RUN_MIN_LOW] = low;
      scratch[base + RANGE_RUN_MIN_HIGH] = high;
      scratch[base + RANGE_RUN_MIN_ORDER] = order;
    }
    if (high > scratch[base + RANGE_RUN_MAX_HIGH]) {
      scratch[base + RANGE_RUN_MAX_X] = x;
      scratch[base + RANGE_RUN_MAX_LOW] = low;
      scratch[base + RANGE_RUN_MAX_HIGH] = high;
      scratch[base + RANGE_RUN_MAX_ORDER] = order;
    }
  }

  function finishRangePresentationRunSpan(scratch: Float64Array, lastSourceIndex: number): void {
    const base = rangePresentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
    scratch[base + RANGE_RUN_LAST_INDEX] = lastSourceIndex;
    scratch[base + RANGE_RUN_LENGTH] = lastSourceIndex - scratch[base + RANGE_RUN_FIRST_INDEX] + 1;
  }

  function captureRangePresentationRun(scratch: Float64Array, runOrdinal: number): void {
    const currentBase = rangePresentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
    if (runOrdinal < MAX_COMPACT_GAP_RUNS) {
      copyRangePresentationRun(
        scratch,
        PRESENTATION_CURRENT_RUN_SLOT,
        PRESENTATION_FIRST_RUN_SLOT + runOrdinal,
      );
    }

    const minBase = rangePresentationRunBase(PRESENTATION_MIN_RUN_SLOT);
    if (
      scratch[minBase + RANGE_RUN_ID] < 0 ||
      scratch[currentBase + RANGE_RUN_MIN_LOW] < scratch[minBase + RANGE_RUN_MIN_LOW]
    ) {
      copyRangePresentationRun(scratch, PRESENTATION_CURRENT_RUN_SLOT, PRESENTATION_MIN_RUN_SLOT);
    }

    const maxBase = rangePresentationRunBase(PRESENTATION_MAX_RUN_SLOT);
    if (
      scratch[maxBase + RANGE_RUN_ID] < 0 ||
      scratch[currentBase + RANGE_RUN_MAX_HIGH] > scratch[maxBase + RANGE_RUN_MAX_HIGH]
    ) {
      copyRangePresentationRun(scratch, PRESENTATION_CURRENT_RUN_SLOT, PRESENTATION_MAX_RUN_SLOT);
    }

    const currentLength = scratch[currentBase + RANGE_RUN_LENGTH];
    for (let rank = 0; rank < MAX_COMPACT_GAP_RUNS; rank++) {
      const slot = PRESENTATION_LONGEST_RUN_SLOT + rank;
      const base = rangePresentationRunBase(slot);
      if (scratch[base + RANGE_RUN_ID] >= 0 && currentLength <= scratch[base + RANGE_RUN_LENGTH]) {
        continue;
      }
      for (let shift = MAX_COMPACT_GAP_RUNS - 1; shift > rank; shift--) {
        copyRangePresentationRun(
          scratch,
          PRESENTATION_LONGEST_RUN_SLOT + shift - 1,
          PRESENTATION_LONGEST_RUN_SLOT + shift,
        );
      }
      copyRangePresentationRun(scratch, PRESENTATION_CURRENT_RUN_SLOT, slot);
      break;
    }
  }

  function addSelectedRangePresentationRun(
    scratch: Float64Array,
    selected: Int32Array,
    selectedCount: number,
    slot: number,
  ): number {
    const base = rangePresentationRunBase(slot);
    const runId = scratch[base + RANGE_RUN_ID];
    if (runId < 0 || scratch[base + RANGE_RUN_LENGTH] <= 1) {
      return selectedCount;
    }
    for (let index = 0; index < selectedCount; index++) {
      const selectedBase = rangePresentationRunBase(selected[index]);
      if (scratch[selectedBase + RANGE_RUN_ID] === runId) {
        return selectedCount;
      }
    }
    selected[selectedCount] = slot;
    return selectedCount + 1;
  }

  function selectRangePresentationRuns(
    scratch: Float64Array,
    selected: Int32Array,
    runCount: number,
  ): number {
    selected.fill(-1);
    let selectedCount = 0;
    if (runCount <= MAX_COMPACT_GAP_RUNS) {
      for (let run = 0; run < runCount; run++) {
        selectedCount = addSelectedRangePresentationRun(
          scratch,
          selected,
          selectedCount,
          PRESENTATION_FIRST_RUN_SLOT + run,
        );
      }
    } else {
      selectedCount = addSelectedRangePresentationRun(
        scratch,
        selected,
        selectedCount,
        PRESENTATION_MIN_RUN_SLOT,
      );
      selectedCount = addSelectedRangePresentationRun(
        scratch,
        selected,
        selectedCount,
        PRESENTATION_MAX_RUN_SLOT,
      );
      const minRunId = scratch[rangePresentationRunBase(PRESENTATION_MIN_RUN_SLOT) + RANGE_RUN_ID];
      const maxRunId = scratch[rangePresentationRunBase(PRESENTATION_MAX_RUN_SLOT) + RANGE_RUN_ID];
      for (let rank = 0; rank < MAX_COMPACT_GAP_RUNS; rank++) {
        const slot = PRESENTATION_LONGEST_RUN_SLOT + rank;
        const runId = scratch[rangePresentationRunBase(slot) + RANGE_RUN_ID];
        if (runId >= 0 && runId !== minRunId && runId !== maxRunId) {
          selectedCount = addSelectedRangePresentationRun(scratch, selected, selectedCount, slot);
          break;
        }
      }
    }

    for (let index = 1; index < selectedCount; index++) {
      const slot = selected[index];
      const firstIndex = scratch[rangePresentationRunBase(slot) + RANGE_RUN_FIRST_INDEX];
      let insertion = index;
      while (insertion > 0) {
        const previousFirstIndex =
          scratch[rangePresentationRunBase(selected[insertion - 1]) + RANGE_RUN_FIRST_INDEX];
        if (previousFirstIndex <= firstIndex) break;
        selected[insertion] = selected[insertion - 1];
        insertion--;
      }
      selected[insertion] = slot;
    }
    return selectedCount;
  }

  function appendRangePresentationBreak(target: Float64Array, targetOffset: number): number {
    target[targetOffset] = NaN;
    target[targetOffset + 1] = NaN;
    target[targetOffset + 2] = NaN;
    return targetOffset + 3;
  }

  function appendRangePresentationRunSummary(
    target: Float64Array,
    targetOffset: number,
    scratch: Float64Array,
    slot: number,
  ): number {
    const base = rangePresentationRunBase(slot);
    let previousX = NaN;
    let previousLow = NaN;
    let previousHigh = NaN;
    let hasPrevious = false;

    for (let point = 0; point < 4; point++) {
      let x: number;
      let low: number;
      let high: number;
      if (point === 0) {
        x = scratch[base + RANGE_RUN_FIRST_X];
        low = scratch[base + RANGE_RUN_FIRST_LOW];
        high = scratch[base + RANGE_RUN_FIRST_HIGH];
      } else if (point === 3) {
        x = scratch[base + RANGE_RUN_LAST_X];
        low = scratch[base + RANGE_RUN_LAST_LOW];
        high = scratch[base + RANGE_RUN_LAST_HIGH];
      } else {
        const minFirst = scratch[base + RANGE_RUN_MIN_ORDER] <= scratch[base + RANGE_RUN_MAX_ORDER];
        const useMinimum = point === 1 ? minFirst : !minFirst;
        x = scratch[base + (useMinimum ? RANGE_RUN_MIN_X : RANGE_RUN_MAX_X)];
        low = scratch[base + (useMinimum ? RANGE_RUN_MIN_LOW : RANGE_RUN_MAX_LOW)];
        high = scratch[base + (useMinimum ? RANGE_RUN_MIN_HIGH : RANGE_RUN_MAX_HIGH)];
      }
      if (hasPrevious && x === previousX && low === previousLow && high === previousHigh) {
        continue;
      }
      target[targetOffset++] = x;
      target[targetOffset++] = low;
      target[targetOffset++] = high;
      previousX = x;
      previousLow = low;
      previousHigh = high;
      hasPrevious = true;
    }
    return targetOffset;
  }

  function classifyPresentationRangeLODBucket(level: RangeLODLevel, bucket: number): number {
    if (bucket < 0 || bucket >= level.bucketCount || !isLODSourceCurrentForBucket(level, bucket)) {
      return PRESENTATION_BUCKET_INVALID;
    }
    const gapKind = level.internalGapBuckets[bucket];
    if (gapKind === COLLAPSED_GAP_BUCKET) {
      return PRESENTATION_BUCKET_BREAK;
    }
    if (gapKind === 1) {
      if (
        level.gapOffsets.length <= bucket + 1 ||
        level.gapOffsets[bucket] > level.gapOffsets[bucket + 1] ||
        level.gapOffsets[bucket + 1] > level.gapSourceIndices.length ||
        level.gapOffsets[bucket + 1] * 3 > level.gapData.length
      ) {
        return PRESENTATION_BUCKET_INVALID;
      }
      return PRESENTATION_BUCKET_COMPACT_GAP;
    }
    if (gapKind !== 0) return PRESENTATION_BUCKET_INVALID;

    const base = bucket * 12;
    let finiteValues = 0;
    for (let offset = 0; offset < 12; offset++) {
      if (Number.isFinite(level.data[base + offset])) finiteValues++;
    }
    if (finiteValues === 12) return PRESENTATION_BUCKET_NORMAL;
    if (finiteValues === 0) return PRESENTATION_BUCKET_BREAK;
    return PRESENTATION_BUCKET_INVALID;
  }

  function writeHierarchicalRangePresentationColumn(
    seriesIndex: number,
    startIdx: number,
    endIdx: number,
    target: Float64Array,
    targetBase: number,
    scratch: Float64Array,
    selected: Int32Array,
  ): number {
    if (targetBase + PRESENTATION_MAX_POINTS_PER_COLUMN * 3 > target.length) {
      return -1;
    }
    const levels = rangeLodLevelsBySeries[seriesIndex];
    if (!levels) return -1;
    for (let slot = 0; slot < PRESENTATION_RUN_SCRATCH_SLOTS; slot++) {
      clearRangePresentationRun(scratch, slot);
    }

    let cursor = startIdx;
    let order = 0;
    let runCount = 0;
    let hasGap = false;

    while (cursor <= endIdx) {
      let selectedLevel: RangeLODLevel | null = null;
      let selectedBucket = -1;
      let selectedBucketKind = PRESENTATION_BUCKET_INVALID;
      const remaining = endIdx - cursor + 1;
      for (
        let levelIndex = largestContainedLODIndex(levels, cursor, remaining);
        levelIndex >= 1;
        levelIndex--
      ) {
        lastPresentationQueryVisits++;
        const level = levels[levelIndex];
        const bucketSize = level.bucketSize;
        const bucket = cursor / bucketSize;
        const bucketKind = classifyPresentationRangeLODBucket(level, bucket);
        if (bucketKind === PRESENTATION_BUCKET_INVALID) continue;
        selectedLevel = level;
        selectedBucket = bucket;
        selectedBucketKind = bucketKind;
        break;
      }

      if (selectedLevel) {
        const bucketStart = cursor;
        const bucketEnd = cursor + selectedLevel.bucketSize - 1;
        if (selectedBucketKind === PRESENTATION_BUCKET_NORMAL) {
          const sourceBase = selectedBucket * 12;
          for (let point = 0; point < 4; point++) {
            const pointBase = sourceBase + point * 3;
            const x = selectedLevel.data[pointBase];
            const low = selectedLevel.data[pointBase + 1];
            const high = selectedLevel.data[pointBase + 2];
            const currentBase = rangePresentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
            if (scratch[currentBase + RANGE_RUN_ID] < 0) {
              beginRangePresentationRun(scratch, runCount, bucketStart, x, low, high, order);
            } else {
              appendRangePresentationRunPoint(scratch, x, low, high, order);
            }
            order++;
          }
          finishRangePresentationRunSpan(scratch, bucketEnd);
        } else if (selectedBucketKind === PRESENTATION_BUCKET_COMPACT_GAP) {
          const startPoint = selectedLevel.gapOffsets[selectedBucket];
          const endPoint = selectedLevel.gapOffsets[selectedBucket + 1];
          for (let point = startPoint; point < endPoint; point++) {
            const sourceIndex = selectedLevel.gapSourceIndices[point];
            if (sourceIndex === GAP_BREAK_SOURCE_INDEX) {
              hasGap = true;
              const currentBase = rangePresentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
              if (scratch[currentBase + RANGE_RUN_ID] >= 0) {
                captureRangePresentationRun(scratch, runCount++);
                clearRangePresentationRun(scratch, PRESENTATION_CURRENT_RUN_SLOT);
              }
              continue;
            }
            if (sourceIndex < bucketStart || sourceIndex > bucketEnd) return -1;
            const pointBase = point * 3;
            const x = selectedLevel.gapData[pointBase];
            const low = selectedLevel.gapData[pointBase + 1];
            const high = selectedLevel.gapData[pointBase + 2];
            if (!Number.isFinite(x) || !Number.isFinite(low) || !Number.isFinite(high)) {
              return -1;
            }
            const currentBase = rangePresentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
            if (scratch[currentBase + RANGE_RUN_ID] < 0) {
              beginRangePresentationRun(scratch, runCount, sourceIndex, x, low, high, order);
            } else {
              appendRangePresentationRunPoint(scratch, x, low, high, order);
            }
            finishRangePresentationRunSpan(scratch, sourceIndex);
            order++;
          }
        } else {
          hasGap = true;
          const currentBase = rangePresentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
          if (scratch[currentBase + RANGE_RUN_ID] >= 0) {
            captureRangePresentationRun(scratch, runCount++);
            clearRangePresentationRun(scratch, PRESENTATION_CURRENT_RUN_SLOT);
          }
        }
        cursor += selectedLevel.bucketSize;
        if (selectedLevel.bucketSize > lastPresentationLargestBucket) {
          lastPresentationLargestBucket = selectedLevel.bucketSize;
        }
        continue;
      }

      lastPresentationQueryVisits++;
      const x = getXAt(cursor);
      const low = getRangeLowerAt(seriesIndex, cursor);
      const high = getRangeUpperAt(seriesIndex, cursor);
      if (Number.isFinite(x) && Number.isFinite(low) && Number.isFinite(high)) {
        const currentBase = rangePresentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
        if (scratch[currentBase + RANGE_RUN_ID] < 0) {
          beginRangePresentationRun(scratch, runCount, cursor, x, low, high, order);
        } else {
          appendRangePresentationRunPoint(scratch, x, low, high, order);
        }
        finishRangePresentationRunSpan(scratch, cursor);
        order++;
      } else {
        hasGap = true;
        const currentBase = rangePresentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
        if (scratch[currentBase + RANGE_RUN_ID] >= 0) {
          captureRangePresentationRun(scratch, runCount++);
          clearRangePresentationRun(scratch, PRESENTATION_CURRENT_RUN_SLOT);
        }
      }
      cursor++;
    }

    const currentBase = rangePresentationRunBase(PRESENTATION_CURRENT_RUN_SLOT);
    if (scratch[currentBase + RANGE_RUN_ID] >= 0) {
      captureRangePresentationRun(scratch, runCount++);
      clearRangePresentationRun(scratch, PRESENTATION_CURRENT_RUN_SLOT);
    }

    if (!hasGap) {
      if (runCount !== 1) return -1;
      const base = rangePresentationRunBase(PRESENTATION_FIRST_RUN_SLOT);
      const minFirst = scratch[base + RANGE_RUN_MIN_ORDER] <= scratch[base + RANGE_RUN_MAX_ORDER];
      target[targetBase] = scratch[base + RANGE_RUN_FIRST_X];
      target[targetBase + 1] = scratch[base + RANGE_RUN_FIRST_LOW];
      target[targetBase + 2] = scratch[base + RANGE_RUN_FIRST_HIGH];
      const firstExtremeOffset = minFirst ? RANGE_RUN_MIN_X : RANGE_RUN_MAX_X;
      const secondExtremeOffset = minFirst ? RANGE_RUN_MAX_X : RANGE_RUN_MIN_X;
      for (let value = 0; value < 3; value++) {
        target[targetBase + 3 + value] = scratch[base + firstExtremeOffset + value];
        target[targetBase + 6 + value] = scratch[base + secondExtremeOffset + value];
      }
      target[targetBase + 9] = scratch[base + RANGE_RUN_LAST_X];
      target[targetBase + 10] = scratch[base + RANGE_RUN_LAST_LOW];
      target[targetBase + 11] = scratch[base + RANGE_RUN_LAST_HIGH];
      return 4;
    }

    const selectedCount = selectRangePresentationRuns(scratch, selected, runCount);
    if (selectedCount === 0) {
      appendRangePresentationBreak(target, targetBase);
      return 1;
    }
    let targetOffset = targetBase;
    const firstBase = rangePresentationRunBase(selected[0]);
    const isolateRepresentatives = runCount > MAX_COMPACT_GAP_RUNS;
    if (isolateRepresentatives || scratch[firstBase + RANGE_RUN_FIRST_INDEX] > startIdx) {
      targetOffset = appendRangePresentationBreak(target, targetOffset);
    }
    for (let index = 0; index < selectedCount; index++) {
      if (index > 0) {
        targetOffset = appendRangePresentationBreak(target, targetOffset);
      }
      targetOffset = appendRangePresentationRunSummary(
        target,
        targetOffset,
        scratch,
        selected[index],
      );
    }
    const lastBase = rangePresentationRunBase(selected[selectedCount - 1]);
    if (isolateRepresentatives || scratch[lastBase + RANGE_RUN_LAST_INDEX] < endIdx) {
      targetOffset = appendRangePresentationBreak(target, targetOffset);
    }
    return (targetOffset - targetBase) / 3;
  }

  function lowerBoundDataX(target: number, startIdx: number, endExclusive: number): number {
    let low = startIdx;
    let high = endExclusive;
    while (low < high) {
      const middle = low + ((high - low) >> 1);
      if (getXAt(middle) < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function isPresentationColumnSeries(seriesIndex: number): boolean {
    const seriesType = getSeriesType(seriesIndex);
    return !isStackedAreaSeriesType(seriesType);
  }

  function quantizePresentationGridDelta(desiredDelta: number): number {
    const quantum =
      Number.isFinite(presentationGridQuantumX) && presentationGridQuantumX > 0
        ? presentationGridQuantumX
        : 1;
    const normalizedDelta = desiredDelta / quantum;
    const exponent = Math.floor(Math.log2(normalizedDelta));
    const octave = 2 ** exponent;
    const mantissa = normalizedDelta / octave;
    const intervalIndex = Math.max(0, Math.floor((mantissa - 1) / presentationQuantizationStep));
    const lowerMantissa = Math.min(2, 1 + intervalIndex * presentationQuantizationStep);
    const upperMantissa = Math.min(2, lowerMantissa + presentationQuantizationStep);
    const selectedMantissa =
      upperMantissa > lowerMantissa && mantissa >= Math.sqrt(lowerMantissa * upperMantissa)
        ? upperMantissa
        : lowerMantissa;
    const selected = octave * selectedMantissa;
    const quantized = quantum * selected;
    return Number.isFinite(quantized) && quantized > 0 ? quantized : desiredDelta;
  }

  function resolvePresentationGridDelta(desiredDelta: number): number {
    if (!Number.isFinite(presentationResolvedGridDelta) || presentationResolvedGridDelta <= 0) {
      presentationResolvedGridDelta = quantizePresentationGridDelta(desiredDelta);
    } else {
      const projectedColumnWidth = presentationResolvedGridDelta / desiredDelta;
      if (
        projectedColumnWidth < 1 / presentationRebaseRatio ||
        projectedColumnWidth > presentationRebaseRatio
      ) {
        // Keep the grid sticky across animation completion and unrelated
        // redraws. Rebin only when continued zoom would leave the bounded visual
        // density band; there is deliberately no post-animation settle frame.
        presentationResolvedGridDelta = quantizePresentationGridDelta(desiredDelta);
      }
    }

    lastPresentationGridDelta = presentationResolvedGridDelta;
    return presentationResolvedGridDelta;
  }

  function quantizePresentationGridDeltaAtLeast(desiredDelta: number): number {
    const quantum =
      Number.isFinite(presentationGridQuantumX) && presentationGridQuantumX > 0
        ? presentationGridQuantumX
        : 1;
    const normalizedDelta = desiredDelta / quantum;
    const exponent = Math.floor(Math.log2(normalizedDelta));
    const octave = 2 ** exponent;
    const mantissa = normalizedDelta / octave;
    const stepCount = Math.max(
      0,
      Math.ceil((mantissa - 1) / presentationQuantizationStep - Number.EPSILON * 8),
    );
    const selectedMantissa = Math.min(2, 1 + stepCount * presentationQuantizationStep);
    let quantized = quantum * octave * selectedMantissa;
    if (!Number.isFinite(quantized) || quantized <= 0 || quantized < desiredDelta) {
      quantized = desiredDelta;
    }
    return quantized;
  }

  function resolveReducedRangePresentationGridDelta(desiredDelta: number): number {
    if (
      !Number.isFinite(presentationResolvedRangeGridDelta) ||
      presentationResolvedRangeGridDelta <= 0 ||
      presentationResolvedRangeGridDelta < desiredDelta
    ) {
      presentationResolvedRangeGridDelta = quantizePresentationGridDeltaAtLeast(desiredDelta);
    } else {
      const projectedColumnWidth = presentationResolvedRangeGridDelta / desiredDelta;
      if (projectedColumnWidth > presentationRebaseRatio) {
        presentationResolvedRangeGridDelta = quantizePresentationGridDeltaAtLeast(desiredDelta);
      }
    }
    lastPresentationGridDelta = presentationResolvedRangeGridDelta;
    return presentationResolvedRangeGridDelta;
  }

  function buildHierarchicalPresentationColumns(
    seriesIndex: number,
    startIdx: number,
    endIdx: number,
    chartWidth: number,
  ): ColumnRenderSeriesData | null {
    if (
      !hierarchicalPresentationLOD ||
      (!lodBuildComplete && !ringBufferMode) ||
      !isPresentationColumnSeries(seriesIndex)
    ) {
      return null;
    }

    const targetColumns = Math.max(1, Math.floor(chartWidth * presentationColumnsPerCssPixel));
    const visibleLength = endIdx - startIdx + 1;
    if (visibleLength <= targetColumns) return null;

    const viewportSpan = state.viewport.xMax - state.viewport.xMin;
    const desiredDelta = viewportSpan / targetColumns;
    const anchor = Number.isFinite(presentationGridAnchorX) ? presentationGridAnchorX : getXAt(0);
    if (!Number.isFinite(desiredDelta) || desiredDelta <= 0 || !Number.isFinite(anchor)) {
      return null;
    }
    const delta = resolvePresentationGridDelta(desiredDelta);

    const firstGridIndex = Math.floor((state.viewport.xMin - anchor) / delta);
    const lastGridIndex = Math.floor((state.viewport.xMax - anchor) / delta);
    if (
      !Number.isSafeInteger(firstGridIndex) ||
      !Number.isSafeInteger(lastGridIndex) ||
      lastGridIndex < firstGridIndex ||
      lastGridIndex - firstGridIndex >
        Math.ceil(
          targetColumns * Math.max(PRESENTATION_MAX_COLUMNS_PER_TARGET, presentationRebaseRatio),
        ) +
          2
    ) {
      return null;
    }

    const buffer = ensurePresentationColumnBuffer(seriesIndex, lastGridIndex - firstGridIndex + 1);
    let columnCount = 0;
    let pointCount = 0;
    let columnStartIdx = startIdx;
    const preserveSingletons = isDiscreteSeriesType(getSeriesType(seriesIndex));

    for (
      let gridIndex = firstGridIndex;
      gridIndex <= lastGridIndex && columnStartIdx <= endIdx;
      gridIndex++
    ) {
      const isLastGridColumn = gridIndex === lastGridIndex;
      const columnRight = anchor + (gridIndex + 1) * delta;
      const nextColumnStart = isLastGridColumn
        ? endIdx + 1
        : lowerBoundDataX(columnRight, columnStartIdx, endIdx + 1);
      const columnEndIdx = nextColumnStart - 1;

      if (columnEndIdx >= columnStartIdx) {
        const written = writeHierarchicalPresentationColumn(
          seriesIndex,
          columnStartIdx,
          columnEndIdx,
          buffer.data,
          pointCount * 2,
          buffer.runScratch,
          buffer.selectionScratch,
          preserveSingletons,
        );
        if (written < 0) {
          return null;
        }
        pointCount += written;
        columnCount++;
      }

      columnStartIdx = nextColumnStart;
    }

    if (columnStartIdx <= endIdx) {
      const written = writeHierarchicalPresentationColumn(
        seriesIndex,
        columnStartIdx,
        endIdx,
        buffer.data,
        pointCount * 2,
        buffer.runScratch,
        buffer.selectionScratch,
        preserveSingletons,
      );
      if (written < 0) {
        return null;
      }
      pointCount += written;
      columnCount++;
    }

    if (columnCount === 0) return null;
    return {
      mode: "columns",
      columnData: buffer.data,
      columnCount,
      length: pointCount,
    };
  }

  function buildHierarchicalRangePresentationColumns(
    seriesIndex: number,
    startIdx: number,
    endIdx: number,
    chartWidth: number,
  ): RangePresentationColumnData | null {
    if (
      !hierarchicalPresentationLOD ||
      (!lodBuildComplete && !ringBufferMode) ||
      !hasRangeData(seriesIndex)
    ) {
      return null;
    }

    const reducedDensity = canReduceRangePresentationDensity(seriesIndex);
    const rangeBandWorkWeight = reducedDensity
      ? Math.max(1, getVisibleRangeBandRenderWorkWeight())
      : 1;
    const effectiveDensity = reducedDensity
      ? Math.min(
          presentationColumnsPerCssPixel,
          RANGE_RENDER_WORK_PER_PIXEL_LIMIT / (4 * rangeBandWorkWeight),
        )
      : presentationColumnsPerCssPixel;
    const densityTargetColumns = Math.max(1, Math.floor(chartWidth * effectiveDensity));
    // An anchored inclusive grid can contain the two partially visible edge
    // columns in addition to its requested interior count. Reserve them inside
    // the hard multi-band work budget rather than hiding them in test tolerance.
    const budgetTargetColumns = reducedDensity
      ? Math.max(
          1,
          Math.floor((chartWidth * RANGE_RENDER_WORK_PER_PIXEL_LIMIT) / (4 * rangeBandWorkWeight)) -
            2,
        )
      : densityTargetColumns;
    const targetColumns = Math.min(densityTargetColumns, budgetTargetColumns);
    if (endIdx - startIdx + 1 <= targetColumns) return null;

    const viewportSpan = state.viewport.xMax - state.viewport.xMin;
    const desiredDelta = viewportSpan / targetColumns;
    const anchor = Number.isFinite(presentationGridAnchorX) ? presentationGridAnchorX : getXAt(0);
    if (!Number.isFinite(desiredDelta) || desiredDelta <= 0 || !Number.isFinite(anchor)) {
      return null;
    }
    const delta = reducedDensity
      ? resolveReducedRangePresentationGridDelta(desiredDelta)
      : resolvePresentationGridDelta(desiredDelta);
    const firstGridIndex = Math.floor((state.viewport.xMin - anchor) / delta);
    const lastGridIndex = Math.floor((state.viewport.xMax - anchor) / delta);
    if (
      !Number.isSafeInteger(firstGridIndex) ||
      !Number.isSafeInteger(lastGridIndex) ||
      lastGridIndex < firstGridIndex ||
      lastGridIndex - firstGridIndex >
        Math.ceil(
          targetColumns * Math.max(PRESENTATION_MAX_COLUMNS_PER_TARGET, presentationRebaseRatio),
        ) +
          2
    ) {
      return null;
    }

    const buffer = ensureRangePresentationColumnBuffer(
      seriesIndex,
      lastGridIndex - firstGridIndex + 1,
    );
    let columnCount = 0;
    let pointCount = 0;
    let columnStartIdx = startIdx;
    for (
      let gridIndex = firstGridIndex;
      gridIndex <= lastGridIndex && columnStartIdx <= endIdx;
      gridIndex++
    ) {
      const nextColumnStart =
        gridIndex === lastGridIndex
          ? endIdx + 1
          : lowerBoundDataX(anchor + (gridIndex + 1) * delta, columnStartIdx, endIdx + 1);
      const columnEndIdx = nextColumnStart - 1;
      if (columnEndIdx >= columnStartIdx) {
        const written = writeHierarchicalRangePresentationColumn(
          seriesIndex,
          columnStartIdx,
          columnEndIdx,
          buffer.data,
          pointCount * 3,
          buffer.runScratch,
          buffer.selectionScratch,
        );
        if (written < 0) return null;
        pointCount += written;
        columnCount++;
      }
      columnStartIdx = nextColumnStart;
    }
    if (columnStartIdx <= endIdx) {
      const written = writeHierarchicalRangePresentationColumn(
        seriesIndex,
        columnStartIdx,
        endIdx,
        buffer.data,
        pointCount * 3,
        buffer.runScratch,
        buffer.selectionScratch,
      );
      if (written < 0) return null;
      pointCount += written;
      columnCount++;
    }
    if (pointCount === 0) return null;
    return {
      mode: "columns",
      columnData: buffer.data,
      columnCount,
      length: pointCount,
    };
  }

  function forEachRenderPoint(
    data: RenderSeriesData,
    visit: (x: number, y: number, dataIndex: number) => void,
  ): void {
    if (data.mode === "columns") {
      for (let point = 0; point < data.length; point++) {
        const pointBase = point * 2;
        visit(data.columnData[pointBase], data.columnData[pointBase + 1], -1);
      }
      return;
    }

    if (data.mode === "lod") {
      for (let b = data.startBucket; b <= data.endBucket; b++) {
        if (data.internalGapBuckets[b] === COLLAPSED_GAP_BUCKET) {
          visit(NaN, NaN, -1);
          continue;
        }

        // Internal gaps use compact first/min/max/last summaries per finite run.
        // This preserves breaks and extrema without expanding a large LOD bucket
        // back to thousands of raw points on every interaction frame.
        if (
          data.internalGapBuckets[b] === 1 ||
          data.internalGapBuckets[b] === REPRESENTATIVE_GAP_BUCKET
        ) {
          const startPoint = data.gapOffsets[b];
          const endPoint = data.gapOffsets[b + 1];
          for (let point = startPoint; point < endPoint; point++) {
            const pointBase = point * 2;
            visit(data.gapData[pointBase], data.gapData[pointBase + 1], -1);
          }
          continue;
        }

        const baseIdx = b * 8;
        for (let p = 0; p < 4; p++) {
          const pointBase = baseIdx + p * 2;
          visit(data.lodData[pointBase], data.lodData[pointBase + 1], -1);
        }
      }
      return;
    }

    for (let i = data.startIdx; i <= data.endIdx; i++) {
      visit(getXAt(i), getYAt(data.seriesIndex, i), i);
    }
  }

  function getRenderData(startIdx: number, endIdx: number, chartWidth: number): RenderSeriesData[] {
    lastPresentationMode = "pyramid";
    lastPresentationColumnCount = 0;
    lastPresentationVertexCount = 0;
    lastPresentationQueryVisits = 0;
    lastPresentationLargestBucket = 1;
    lastPresentationGridDelta = NaN;
    if (!dataX || lodLevelsBySeries.length === 0) return [];

    const visibleLength = endIdx - startIdx + 1;
    const lodIndex = selectLODLevel(visibleLength, chartWidth);
    currentLODIndex = lodIndex;
    currentBucketSize = lodLevelsBySeries[0]?.[lodIndex]?.bucketSize ?? 1;

    const results: RenderSeriesData[] = [];

    for (let s = 0; s < seriesConfig.count; s++) {
      if (!isSeriesVisible(s)) {
        results.push({
          mode: "raw",
          seriesIndex: s,
          startIdx: 0,
          endIdx: -1,
          length: 0,
        });
        continue;
      }

      const rangeSeries = hasRangeData(s);
      const hasVisibleRangeCenter = !rangeSeries || getSeriesLineWidth(s) > 0;
      let presentationColumns = hasVisibleRangeCenter
        ? buildHierarchicalPresentationColumns(s, startIdx, endIdx, chartWidth)
        : null;

      if (rangeSeries && presentationColumns) {
        const rangeColumns = buildHierarchicalRangePresentationColumns(
          s,
          startIdx,
          endIdx,
          chartWidth,
        );
        if (!rangeColumns) {
          presentationColumns = null;
        } else {
          presentationColumns.rangeColumnData = rangeColumns.columnData;
          presentationColumns.rangeColumnCount = rangeColumns.columnCount;
          presentationColumns.rangeLength = rangeColumns.length;
        }
      } else if (rangeSeries && !hasVisibleRangeCenter) {
        const rangeColumns = buildHierarchicalRangePresentationColumns(
          s,
          startIdx,
          endIdx,
          chartWidth,
        );
        if (rangeColumns) {
          presentationColumns = {
            mode: "columns",
            columnData: emptyPresentationColumnData,
            columnCount: 0,
            length: 0,
            rangeColumnData: rangeColumns.columnData,
            rangeColumnCount: rangeColumns.columnCount,
            rangeLength: rangeColumns.length,
          };
        }
      }
      if (presentationColumns) {
        results.push(presentationColumns);
        lastPresentationMode = "columns";
        lastPresentationColumnCount += Math.max(
          presentationColumns.columnCount,
          presentationColumns.rangeColumnCount ?? 0,
        );
        lastPresentationVertexCount +=
          presentationColumns.length + (presentationColumns.rangeLength ?? 0) * 2;
        continue;
      }

      const lodLevels = lodLevelsBySeries[s];
      const lod = lodLevels[lodIndex];

      if (lodIndex === 0) {
        results.push({
          mode: "raw",
          seriesIndex: s,
          startIdx,
          endIdx,
          length: visibleLength,
        });
      } else {
        const startBucket = Math.floor(startIdx / lod.bucketSize);
        const endBucket = Math.min(Math.ceil(endIdx / lod.bucketSize), lod.bucketCount - 1);

        results.push({
          mode: "lod",
          lodData: lod.data,
          internalGapBuckets: lod.internalGapBuckets,
          gapData: lod.gapData,
          gapOffsets: lod.gapOffsets,
          startBucket,
          endBucket,
          length: lod.renderOffsets[endBucket + 1] - lod.renderOffsets[startBucket],
        });
      }
    }

    return results;
  }

  function getRangeRenderData(
    seriesIndex: number,
    renderData: RenderSeriesData,
  ): RangeRenderSeriesData | null {
    if (renderData.rangeRenderData !== undefined) {
      return renderData.rangeRenderData;
    }
    if (!hasRangeData(seriesIndex)) {
      renderData.rangeRenderData = null;
      return null;
    }

    if (renderData.mode === "columns") {
      if (!renderData.rangeColumnData || !renderData.rangeLength) {
        renderData.rangeRenderData = null;
        return null;
      }
      renderData.rangeRenderData = {
        mode: "columns",
        columnData: renderData.rangeColumnData,
        length: renderData.rangeLength,
      };
      return renderData.rangeRenderData;
    }

    if (renderData.length <= 0) {
      renderData.rangeRenderData = null;
      return null;
    }

    if (renderData.mode === "raw") {
      renderData.rangeRenderData = {
        mode: "raw",
        seriesIndex,
        startIdx: renderData.startIdx,
        endIdx: renderData.endIdx,
        length: renderData.length,
      };
      return renderData.rangeRenderData;
    }

    const rangeLevels = rangeLodLevelsBySeries[seriesIndex];
    const lod = rangeLevels?.[currentLODIndex];
    if (!lod || lod.bucketSize !== currentBucketSize) {
      renderData.rangeRenderData = null;
      return null;
    }

    renderData.rangeRenderData = {
      mode: "lod",
      lodData: lod.data,
      internalGapBuckets: lod.internalGapBuckets,
      gapData: lod.gapData,
      gapOffsets: lod.gapOffsets,
      renderOffsets: lod.renderOffsets,
      startBucket: renderData.startBucket,
      endBucket: renderData.endBucket,
      length:
        lod.renderOffsets[renderData.endBucket + 1] - lod.renderOffsets[renderData.startBucket],
      cachedOrdinal: -1,
      cachedBucket: renderData.startBucket,
      cachedPointBase: -1,
      cachedGapPointBase: -1,
    };
    return renderData.rangeRenderData;
  }

  function resolveRangeRenderPoint(data: LODRangeRenderSeriesData, ordinal: number): void {
    if (data.cachedOrdinal === ordinal) return;

    const absoluteOrdinal = data.renderOffsets[data.startBucket] + ordinal;
    let bucket = data.cachedBucket;
    if (
      bucket < data.startBucket ||
      bucket > data.endBucket ||
      absoluteOrdinal < data.renderOffsets[bucket] ||
      absoluteOrdinal >= data.renderOffsets[bucket + 1]
    ) {
      let low = data.startBucket;
      let high = data.endBucket;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (absoluteOrdinal < data.renderOffsets[mid + 1]) high = mid;
        else low = mid + 1;
      }
      bucket = low;
    }

    const pointInBucket = absoluteOrdinal - data.renderOffsets[bucket];
    data.cachedOrdinal = ordinal;
    data.cachedBucket = bucket;
    if (data.internalGapBuckets[bucket] === COLLAPSED_GAP_BUCKET) {
      data.cachedPointBase = -1;
      data.cachedGapPointBase = -2;
    } else if (
      data.internalGapBuckets[bucket] === 1 ||
      data.internalGapBuckets[bucket] === REPRESENTATIVE_GAP_BUCKET
    ) {
      data.cachedPointBase = -1;
      data.cachedGapPointBase = (data.gapOffsets[bucket] + pointInBucket) * 3;
    } else {
      data.cachedPointBase = bucket * 12 + pointInBucket * 3;
      data.cachedGapPointBase = -1;
    }
  }

  function getRangeRenderX(data: RangeRenderSeriesData, ordinal: number): number {
    if (data.mode === "columns") return data.columnData[ordinal * 3];
    if (data.mode === "lod") {
      resolveRangeRenderPoint(data, ordinal);
      if (data.cachedGapPointBase === -2) return NaN;
      return data.cachedGapPointBase >= 0
        ? data.gapData[data.cachedGapPointBase]
        : data.lodData[data.cachedPointBase];
    }
    return getXAt(data.startIdx + ordinal);
  }

  function getRangeRenderLow(data: RangeRenderSeriesData, ordinal: number): number {
    if (data.mode === "columns") return data.columnData[ordinal * 3 + 1];
    if (data.mode === "lod") {
      resolveRangeRenderPoint(data, ordinal);
      if (data.cachedGapPointBase === -2) return NaN;
      return data.cachedGapPointBase >= 0
        ? data.gapData[data.cachedGapPointBase + 1]
        : data.lodData[data.cachedPointBase + 1];
    }
    return getRangeLowerAt(data.seriesIndex, data.startIdx + ordinal);
  }

  function getRangeRenderHigh(data: RangeRenderSeriesData, ordinal: number): number {
    if (data.mode === "columns") return data.columnData[ordinal * 3 + 2];
    if (data.mode === "lod") {
      resolveRangeRenderPoint(data, ordinal);
      if (data.cachedGapPointBase === -2) return NaN;
      return data.cachedGapPointBase >= 0
        ? data.gapData[data.cachedGapPointBase + 2]
        : data.lodData[data.cachedPointBase + 2];
    }
    return getRangeUpperAt(data.seriesIndex, data.startIdx + ordinal);
  }

  function rangeRenderPointIsValid(data: RangeRenderSeriesData, ordinal: number): boolean {
    return (
      Number.isFinite(getRangeRenderX(data, ordinal)) &&
      Number.isFinite(getRangeRenderLow(data, ordinal)) &&
      Number.isFinite(getRangeRenderHigh(data, ordinal))
    );
  }

  function getViewportIndices(): { startIdx: number; endIdx: number } {
    if (!dataX || dataLength === 0) return { startIdx: 0, endIdx: -1 };

    const startIdx = Math.max(0, binarySearchDataXLeft(state.viewport.xMin, 0, dataLength - 1) - 1);
    const endIdx = Math.min(
      dataLength - 1,
      binarySearchDataXRight(state.viewport.xMax, startIdx, dataLength - 1) + 1,
    );

    return { startIdx, endIdx };
  }

  function findMinMax(startIdx: number, endIdx: number): { min: number; max: number } {
    if (lodLevelsBySeries.length === 0) return { min: 0, max: 0 };

    if (cachedYMinMax.startIdx === startIdx && cachedYMinMax.endIdx === endIdx) {
      return { min: cachedYMinMax.min, max: cachedYMinMax.max };
    }

    const length = endIdx - startIdx + 1;
    if (length <= 0) return { min: 0, max: 0 };

    let globalMin = Infinity;
    let globalMax = -Infinity;

    const lodThreshold = 1000;

    for (let s = 0; s < seriesConfig.count; s++) {
      if (!isSeriesVisible(s)) continue;

      const barBaseline = getBarBaselineForBounds(s);
      if (barBaseline !== null) {
        if (barBaseline < globalMin) globalMin = barBaseline;
        if (barBaseline > globalMax) globalMax = barBaseline;
      }

      const rangeLevels = rangeLodLevelsBySeries[s];
      if (rangeLevels) {
        let rangeLod: RangeLODLevel | null = null;
        if (length > lodThreshold && rangeLevels.length > 1) {
          for (let i = rangeLevels.length - 1; i >= 1; i--) {
            const candidate = rangeLevels[i];
            const bucketCount = Math.ceil(length / candidate.bucketSize);
            if (bucketCount >= 100 && isLODSourceCurrentForRange(candidate, endIdx)) {
              rangeLod = candidate;
              break;
            }
          }
        }

        if (rangeLod) {
          const startBucket = Math.floor(startIdx / rangeLod.bucketSize);
          const endBucket = Math.min(
            Math.floor(endIdx / rangeLod.bucketSize),
            rangeLod.bucketCount - 1,
          );

          for (let b = startBucket; b <= endBucket; b++) {
            const baseIdx = b * 12;
            for (let p = 0; p < 4; p++) {
              const pointBase = baseIdx + p * 3;
              const low = rangeLod.data[pointBase + 1];
              const high = rangeLod.data[pointBase + 2];
              if (Number.isFinite(low)) {
                if (low < globalMin) globalMin = low;
                if (low > globalMax) globalMax = low;
              }
              if (Number.isFinite(high)) {
                if (high < globalMin) globalMin = high;
                if (high > globalMax) globalMax = high;
              }
            }
          }
        } else {
          for (let i = startIdx; i <= endIdx; i++) {
            const low = getRangeLowerAt(s, i);
            const high = getRangeUpperAt(s, i);
            if (Number.isFinite(low)) {
              if (low < globalMin) globalMin = low;
              if (low > globalMax) globalMax = low;
            }
            if (Number.isFinite(high)) {
              if (high < globalMin) globalMin = high;
              if (high > globalMax) globalMax = high;
            }
          }
        }
      }

      const lodLevels = lodLevelsBySeries[s];

      let lod: LODLevel | null = null;
      if (length > lodThreshold && lodLevels.length > 1) {
        for (let i = lodLevels.length - 1; i >= 1; i--) {
          const candidate = lodLevels[i];
          const bucketCount = Math.ceil(length / candidate.bucketSize);
          if (bucketCount >= 100 && isLODSourceCurrentForRange(candidate, endIdx)) {
            lod = candidate;
            break;
          }
        }
      }

      if (lod) {
        const startBucket = Math.floor(startIdx / lod.bucketSize);
        const endBucket = Math.min(Math.floor(endIdx / lod.bucketSize), lod.bucketCount - 1);

        for (let b = startBucket; b <= endBucket; b++) {
          const baseIdx = b * 8;
          // Min/max are at indices 3 and 5 (the middle two points)
          const y1 = lod.data[baseIdx + 3];
          const y2 = lod.data[baseIdx + 5];
          if (Number.isFinite(y1)) {
            if (y1 < globalMin) globalMin = y1;
            if (y1 > globalMax) globalMax = y1;
          }
          if (Number.isFinite(y2)) {
            if (y2 < globalMin) globalMin = y2;
            if (y2 > globalMax) globalMax = y2;
          }
        }
      } else {
        for (let i = startIdx; i <= endIdx; i++) {
          const y = getYAt(s, i);
          if (Number.isFinite(y)) {
            if (y < globalMin) globalMin = y;
            if (y > globalMax) globalMax = y;
          }
        }
      }
    }

    includeIndexedStackedAreaBounds(startIdx, endIdx, (value) => {
      if (value < globalMin) globalMin = value;
      if (value > globalMax) globalMax = value;
    });

    if (!Number.isFinite(globalMin)) globalMin = 0;
    if (!Number.isFinite(globalMax)) globalMax = 100;

    cachedYMinMax = { min: globalMin, max: globalMax, startIdx, endIdx };
    return { min: globalMin, max: globalMax };
  }

  function needsContinuousRendering(): boolean {
    if (state.dataLoadStartTime > 0 && performance.now() - state.dataLoadStartTime < 2000) {
      return true;
    }

    return (
      state.viewportAnimation.active ||
      state.yAnimation.active ||
      hasActiveGridAnimations(state) ||
      state.revealProgress < 1
    );
  }

  // Schedule a single render frame (wakes up idle loop)
  function scheduleRender() {
    if (stopped) {
      state.rafId = null;
      return;
    }
    if (ssr) {
      render(performance.now());
      state.rafId = null;
      return;
    }
    if (state.rafId === null) {
      state.rafId = rendererScheduler.scheduleFrame(render);
    }
  }

  function render(timestamp: number) {
    if (stopped) {
      state.rafId = null;
      return;
    }
    if (!state.ctx || !state.canvas) return;

    const frameStartTime = performance.now();
    let benchmarkFrameStartedAt = 0;
    let benchmarkPhaseStartedAt = 0;
    let cacheRedrawnThisFrame = false;
    if (LINE_RENDER_BENCHMARK_ENABLED) {
      benchmarkPhaseDurations!.fill(0);
      benchmarkWorkMetrics!.fill(0);
      benchmarkFrameStartedAt = frameStartTime;
      benchmarkPhaseStartedAt = frameStartTime;
    }
    updateFPS(state, timestamp);
    const legendMeasuredItems = legend.getMeasuredItems(state.ctx);
    const legendReserveSize = legend.getCachedReserveSize(legendMeasuredItems);
    legend.applyDynamicPadding(legendReserveSize);
    state.updateDimensions();
    const legendLayoutItems: LegendLayoutItem[] = legend.getCachedLayout(
      legendMeasuredItems,
      legendReserveSize,
    );
    legend.postLayoutIfChanged();

    const wasRevealing = state.revealProgress < 1;
    const previousViewportXMin = state.viewport.xMin;
    const previousViewportXMax = state.viewport.xMax;
    updateViewportAnimation(state, timestamp);
    updateRevealAnimation(state, timestamp);
    updateYAnimation(state, timestamp);

    // Keep the host viewport exact throughout animations, including the frame
    // that completes one. Change detection avoids a duplicate at animation start.
    if (
      state.viewport.xMin !== previousViewportXMin ||
      state.viewport.xMax !== previousViewportXMax
    ) {
      const viewportRequestId = state.viewportAnimation.active
        ? undefined
        : pendingViewportRequestId;
      if (!state.viewportAnimation.active) pendingViewportRequestId = undefined;
      emitViewportSync(viewportRequestId);
    }

    // Invalidate cache during animations (including grid fade animations)
    if (
      state.viewportAnimation.active ||
      wasRevealing ||
      state.revealProgress < 1 ||
      state.yAnimation.active ||
      hasActiveGridAnimations(state)
    ) {
      state.cacheValid = false;
    }

    if (LINE_RENDER_BENCHMARK_ENABLED) {
      benchmarkPhaseStartedAt = recordBenchmarkPhase(
        BENCHMARK_SETUP_LAYOUT_ANIMATION,
        benchmarkPhaseStartedAt,
      );
    }
    const { startIdx, endIdx } = getViewportIndices();
    const visibleLength = endIdx - startIdx + 1;
    if (LINE_RENDER_BENCHMARK_ENABLED) {
      benchmarkPhaseStartedAt = recordBenchmarkPhase(
        BENCHMARK_VIEWPORT_INDICES,
        benchmarkPhaseStartedAt,
      );
    }

    if (visibleLength > 0) {
      if (yDomain?.min !== undefined && yDomain.max !== undefined) {
        setYViewport(state, yDomain.min, yDomain.max, timestamp);
      } else {
        const minMax = findMinMax(startIdx, endIdx);
        const nextY = applyYDomain(minMax.min, minMax.max, yDomain);
        setYViewport(state, nextY.min, nextY.max, timestamp);
      }
    }
    if (LINE_RENDER_BENCHMARK_ENABLED) {
      benchmarkPhaseStartedAt = recordBenchmarkPhase(BENCHMARK_Y_BOUNDS, benchmarkPhaseStartedAt);
    }

    state.ensureCache();
    if (LINE_RENDER_BENCHMARK_ENABLED) {
      benchmarkPhaseStartedAt = recordBenchmarkPhase(BENCHMARK_CACHE_PREP, benchmarkPhaseStartedAt);
    }

    if (state.viewportChanged() || !state.cacheValid) {
      cacheRedrawnThisFrame = true;
      const renderDataSeries = getRenderData(startIdx, endIdx, state.chartWidth);
      if (LINE_RENDER_BENCHMARK_ENABLED) {
        benchmarkPhaseStartedAt = recordBenchmarkPhase(
          BENCHMARK_RENDER_DATA,
          benchmarkPhaseStartedAt,
        );
        for (let s = 0; s < renderDataSeries.length; s++) {
          const renderData = renderDataSeries[s];
          if (renderData.length > 0 && (!hasRangeData(s) || getSeriesLineWidth(s) > 0)) {
            benchmarkWorkMetrics![BENCHMARK_WORK_CENTER_PRESENTATION_POINTS] += renderData.length;
          }
        }
        // Work counters are deliberately outside the phase timings.
        benchmarkPhaseStartedAt = performance.now();
      }

      drawBackground(state.cacheCtx!, state.chartBackground, 0, 0, state.width, state.height);
      drawLabels(state.cacheCtx!, state);
      drawGrid(state.cacheCtx!, state, true);
      drawAxes(state.cacheCtx!, state);
      if (LINE_RENDER_BENCHMARK_ENABLED) {
        benchmarkPhaseStartedAt = recordBenchmarkPhase(
          BENCHMARK_CHROME_GRID_AXES,
          benchmarkPhaseStartedAt,
        );
      }

      lastRenderedPoints = 0;
      const revealingData = beginDataReveal(state.cacheCtx!);

      // Draw fills first (so lines appear on top)
      const chartBottom = state.chartTop + state.chartHeight;
      for (let s = 0; s < renderDataSeries.length; s++) {
        const seriesPhaseStartedAt = LINE_RENDER_BENCHMARK_ENABLED ? performance.now() : 0;
        const renderData = renderDataSeries[s];
        const config = seriesConfig.options[s];

        const rangeData = getRangeRenderData(s, renderData);
        if (rangeData) {
          lastRenderedPoints += drawStyledRangeBand(
            state.cacheCtx!,
            s,
            rangeData,
            state.chartTop,
            chartBottom,
            state.padding.left,
            state.width - state.padding.right,
          );
          if (LINE_RENDER_BENCHMARK_ENABLED) {
            recordBenchmarkPhase(BENCHMARK_RANGE_DRAW, seriesPhaseStartedAt);
            benchmarkWorkMetrics![BENCHMARK_WORK_RANGE_PRESENTATION_POINTS] += rangeData.length * 2;
          }
          continue;
        }

        const seriesType = getSeriesType(s);
        if (
          !isStackedAreaSeriesType(seriesType) &&
          !isDiscreteSeriesType(seriesType) &&
          renderData.length > 1 &&
          config?.fill
        ) {
          const fillToZero = config?.fillToZero ?? true;
          const opacity = typeof config.fill === "number" ? config.fill : 0.4;

          if (config.fillEffect === "layered") {
            // Layered fill handles its own drawing
            drawLayeredFill(
              state.cacheCtx!,
              renderData,
              getSeriesColor(s),
              opacity * 2,
              fillToZero,
              seriesType,
            );
          } else {
            // Regular fill
            const fillStyle = getSeriesFillStyle(
              state.cacheCtx!,
              s,
              state.chartTop,
              chartBottom,
              state.padding.left,
              state.width - state.padding.right,
            );
            if (fillStyle) {
              drawFill(state.cacheCtx!, renderData, fillStyle, fillToZero, seriesType);
            }
          }
        }
        if (LINE_RENDER_BENCHMARK_ENABLED) {
          recordBenchmarkPhase(BENCHMARK_ORDINARY_FILL, seriesPhaseStartedAt);
        }
      }

      // Draw fill effects (between fill and line)
      const fillEffectsStartedAt = LINE_RENDER_BENCHMARK_ENABLED ? performance.now() : 0;
      for (let s = 0; s < renderDataSeries.length; s++) {
        const renderData = renderDataSeries[s];
        const config = seriesConfig.options[s];
        if (getRangeRenderData(s, renderData)) continue;
        const seriesType = getSeriesType(s);
        if (isStackedAreaSeriesType(seriesType)) continue;
        if (isDiscreteSeriesType(seriesType)) continue;
        if (renderData.length > 1 && config?.fill && config?.fillEffect) {
          const opacity = typeof config.fill === "number" ? config.fill : 0.4;
          if (config.fillEffect === "glow") {
            drawLineGlow(state.cacheCtx!, renderData, getSeriesColor(s), opacity * 2.5, seriesType);
          }
        }
      }
      if (LINE_RENDER_BENCHMARK_ENABLED) {
        recordBenchmarkPhase(BENCHMARK_FILL_EFFECTS, fillEffectsStartedAt);
      }

      // Draw stacked areas as cumulative filled bands
      const stackedAreasStartedAt = LINE_RENDER_BENCHMARK_ENABLED ? performance.now() : 0;
      lastRenderedPoints += drawStackedAreas(state.cacheCtx!, renderDataSeries);
      if (LINE_RENDER_BENCHMARK_ENABLED) {
        recordBenchmarkPhase(BENCHMARK_STACKED_AREAS, stackedAreasStartedAt);
      }

      // Draw bars above area fills and below line/scatter overlays
      const barsStartedAt = LINE_RENDER_BENCHMARK_ENABLED ? performance.now() : 0;
      let barRectangleCount = 0;
      for (let s = 0; s < renderDataSeries.length; s++) {
        const renderData = renderDataSeries[s];
        const seriesType = getSeriesType(s);
        if (isBarSeriesType(seriesType)) {
          const renderedBars = drawBars(state.cacheCtx!, renderData, s);
          lastRenderedPoints += renderedBars;
          if (LINE_RENDER_BENCHMARK_ENABLED) {
            barRectangleCount += renderedBars;
          }
        }
      }
      if (LINE_RENDER_BENCHMARK_ENABLED) {
        recordBenchmarkPhase(BENCHMARK_BARS, barsStartedAt);
        benchmarkWorkMetrics![BENCHMARK_WORK_BAR_RECTANGLE_COUNT] = barRectangleCount;
      }

      // Draw lines and scatter points on top
      const linesStartedAt = LINE_RENDER_BENCHMARK_ENABLED ? performance.now() : 0;
      let denseStepRectangleCalls = 0;
      for (let s = 0; s < renderDataSeries.length; s++) {
        const renderData = renderDataSeries[s];
        const seriesType = getSeriesType(s);
        if (isStackedAreaSeriesType(seriesType)) continue;
        if (isBarSeriesType(seriesType)) continue;
        if (isScatterSeriesType(seriesType)) {
          drawScatter(state.cacheCtx!, renderData, s);
          lastRenderedPoints += renderData.length;
          continue;
        }
        const lineWidth = getSeriesLineWidth(s);
        if (renderData.length > 1 && lineWidth > 0) {
          const rectangleCalls = drawLine(
            state.cacheCtx!,
            renderData,
            getSeriesColor(s),
            lineWidth,
            seriesType,
          );
          if (LINE_RENDER_BENCHMARK_ENABLED) {
            denseStepRectangleCalls += rectangleCalls;
          }
          lastRenderedPoints += renderData.length;
        }
      }
      if (LINE_RENDER_BENCHMARK_ENABLED) {
        recordBenchmarkPhase(BENCHMARK_CONNECTED_SERIES, linesStartedAt);
        benchmarkWorkMetrics![BENCHMARK_WORK_DENSE_STEP_RECTANGLE_CALLS] = denseStepRectangleCalls;
      }

      const legendCacheFinalizeStartedAt = LINE_RENDER_BENCHMARK_ENABLED ? performance.now() : 0;
      if (revealingData) state.cacheCtx!.restore();

      legend.draw(state.cacheCtx!, legendLayoutItems);

      state.saveViewport();
      state.cacheValid = true;
      if (LINE_RENDER_BENCHMARK_ENABLED) {
        benchmarkPhaseStartedAt = recordBenchmarkPhase(
          BENCHMARK_LEGEND_CACHE_FINALIZE,
          legendCacheFinalizeStartedAt,
        );
      }
    } else if (LINE_RENDER_BENCHMARK_ENABLED) {
      // Keep sequential timing anchored to the beginning of the always-drawn
      // final composite when the plot cache is reused.
      benchmarkPhaseStartedAt = performance.now();
    }

    if (
      LINE_RENDER_BENCHMARK_ENABLED &&
      cacheRedrawnThisFrame &&
      state.cacheCanvas!.width > 0 &&
      state.cacheCanvas!.height > 0
    ) {
      // Canvas implementations may defer cache-canvas rasterization until the
      // cache is read by drawImage. A one-pixel benchmark-only readback creates
      // an explicit synchronization boundary, separating aggregate cache
      // rasterization/readback from the fixed-size final blit. Individual draw
      // phase timers still describe command submission, not GPU raster cost.
      state.cacheCtx!.getImageData(0, 0, 1, 1);
      benchmarkPhaseStartedAt = recordBenchmarkPhase(
        BENCHMARK_CACHE_RASTERIZATION_SYNC,
        benchmarkPhaseStartedAt,
      );
    }

    state.ctx.setTransform(1, 0, 0, 1, 0, 0);
    state.ctx.drawImage(state.cacheCanvas as CanvasImageSource, 0, 0);
    drawRetainedPlotFrame(state.ctx);
    state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    if (LINE_RENDER_BENCHMARK_ENABLED) {
      benchmarkPhaseStartedAt = recordBenchmarkPhase(
        BENCHMARK_FINAL_CACHE_BLIT,
        benchmarkPhaseStartedAt,
      );
    }

    drawCustomLabels(state.ctx, state);

    if (state.mouseInChart) {
      drawCrosshair(state.ctx);
      drawAxisLabel(state.ctx, state);
    }

    if (state.selectionStart !== null && state.selectionEnd !== null) {
      drawSelectionRect(state.ctx, state);
    }
    if (LINE_RENDER_BENCHMARK_ENABLED) {
      benchmarkPhaseStartedAt = recordBenchmarkPhase(
        BENCHMARK_OVERLAYS_CROSSHAIR,
        benchmarkPhaseStartedAt,
      );
    }

    if (state.showRangeSelector) {
      drawRangeSelector(state.ctx);
    }
    if (LINE_RENDER_BENCHMARK_ENABLED) {
      recordBenchmarkPhase(BENCHMARK_RANGE_SELECTOR, benchmarkPhaseStartedAt);
    }

    state.frameTime = performance.now() - frameStartTime;
    if (LINE_RENDER_BENCHMARK_ENABLED) {
      benchmarkPhaseDurations![BENCHMARK_TOTAL] = performance.now() - benchmarkFrameStartedAt;
    }

    if (state.isFirstRender) {
      state.firstRenderTime = performance.now() - state.dataLoadStartTime;
      state.isFirstRender = false;
    }

    if (shouldEmitStats(stats, timestamp)) {
      const visibleSeriesCount = getVisibleSeriesCount();
      callbacks.postMessage({
        type: "stats",
        dataVersion,
        totalPoints: dataLength * seriesConfig.count,
        visiblePoints: visibleLength * visibleSeriesCount,
        renderedPoints: lastRenderedPoints,
        fps: state.fps,
        viewport: { ...state.viewport },
        dataBounds: { ...state.dataBounds },
        lodLevel: currentLODIndex,
        bucketSize: currentBucketSize,
        presentationMode: lastPresentationMode,
        presentationGridPolicy: hierarchicalPresentationLOD ? "gesture-stable" : "pyramid",
        presentationColumns: lastPresentationColumnCount,
        presentationVertices: lastPresentationVertexCount,
        presentationQueryVisits: lastPresentationQueryVisits,
        presentationLargestBucket: lastPresentationLargestBucket,
        presentationGridDelta: lastPresentationGridDelta,
        presentationDensity: presentationColumnsPerCssPixel,
        presentationRebaseRatio,
        presentationQuantizationStep,
        seriesCount: seriesConfig.count,
        frameTime: state.frameTime.toFixed(2),
        firstRenderTime: state.firstRenderTime.toFixed(0),
        revealProgress: state.revealProgress,
        lodReady: lodBuildComplete,
        lodBuilt: lodLevelsBuilt,
        lodTotal: LOD_BUCKET_SIZES.length,
        ringBuffer: ringBufferMode,
        totalReceived: totalPointsReceived,
        bufferUsage: bufferFull ? 100 : Math.round((writeIndex / ringBufferMaxPoints) * 100),
        ...(LINE_RENDER_BENCHMARK_ENABLED
          ? {
              benchmarkPhases: snapshotBenchmarkPhases(),
              benchmarkWork: snapshotBenchmarkWork(),
            }
          : {}),
      });
    }

    if (ssr) {
      state.rafId = null;
      return;
    }

    // Continue loop only if animations are active or streaming data
    if (needsContinuousRendering()) {
      state.rafId = rendererScheduler.scheduleFrame(render);
    } else {
      state.rafId = null;
    }
  }

  function hasMinimumFiniteRenderPoints(data: RenderSeriesData, minimum: number): boolean {
    let finitePoints = 0;

    if (data.mode === "raw") {
      for (let index = data.startIdx; index <= data.endIdx; index++) {
        if (Number.isFinite(getYAt(data.seriesIndex, index))) {
          finitePoints++;
          if (finitePoints >= minimum) return true;
        }
      }
      return false;
    }

    if (data.mode === "columns") {
      for (let column = 0; column < data.columnCount; column++) {
        const baseIndex = column * 8;
        for (let point = 0; point < 4; point++) {
          if (Number.isFinite(data.columnData[baseIndex + point * 2 + 1])) {
            finitePoints++;
            if (finitePoints >= minimum) return true;
          }
        }
      }
      return false;
    }

    for (let bucket = data.startBucket; bucket <= data.endBucket; bucket++) {
      if (data.internalGapBuckets[bucket] === COLLAPSED_GAP_BUCKET) continue;

      if (
        data.internalGapBuckets[bucket] === 1 ||
        data.internalGapBuckets[bucket] === REPRESENTATIVE_GAP_BUCKET
      ) {
        const startPoint = data.gapOffsets[bucket];
        const endPoint = data.gapOffsets[bucket + 1];
        for (let point = startPoint; point < endPoint; point++) {
          if (Number.isFinite(data.gapData[point * 2 + 1])) {
            finitePoints++;
            if (finitePoints >= minimum) return true;
          }
        }
        continue;
      }

      const baseIndex = bucket * 8;
      for (let point = 0; point < 4; point++) {
        if (Number.isFinite(data.lodData[baseIndex + point * 2 + 1])) {
          finitePoints++;
          if (finitePoints >= minimum) return true;
        }
      }
    }

    return false;
  }

  function drawDenseStepLine(
    ctx: RenderContext2D,
    data: RenderSeriesData,
    color: string,
    width: number,
    seriesType: LineSeriesType,
  ): number {
    const xRange = state.viewport.xMax - state.viewport.xMin;
    const yRange = state.viewport.yMax - state.viewport.yMin;
    let hasPrevious = false;
    let lastScreenX = 0;
    let lastScreenY = 0;
    let rectangleCalls = 0;

    ctx.fillStyle = color;
    forEachRenderPoint(data, (x, y) => {
      if (!Number.isFinite(y)) {
        hasPrevious = false;
        return;
      }

      const screenX = state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
      const screenY = state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;

      if (hasPrevious) {
        if (seriesType === "step-before") {
          fillVerticalStepSegment(ctx, lastScreenX, lastScreenY, screenY, width);
          fillHorizontalStepSegment(ctx, lastScreenX, screenX, screenY, width);
          if (LINE_RENDER_BENCHMARK_ENABLED) {
            if (lastScreenY !== screenY) rectangleCalls++;
            if (lastScreenX !== screenX) rectangleCalls++;
          }
        } else if (seriesType === "step-mid") {
          const midScreenX = lastScreenX + (screenX - lastScreenX) * 0.5;
          fillHorizontalStepSegment(ctx, lastScreenX, midScreenX, lastScreenY, width);
          fillVerticalStepSegment(ctx, midScreenX, lastScreenY, screenY, width);
          fillHorizontalStepSegment(ctx, midScreenX, screenX, screenY, width);
          if (LINE_RENDER_BENCHMARK_ENABLED) {
            if (lastScreenX !== midScreenX) rectangleCalls++;
            if (lastScreenY !== screenY) rectangleCalls++;
            if (midScreenX !== screenX) rectangleCalls++;
          }
        } else {
          fillHorizontalStepSegment(ctx, lastScreenX, screenX, lastScreenY, width);
          fillVerticalStepSegment(ctx, screenX, lastScreenY, screenY, width);
          if (LINE_RENDER_BENCHMARK_ENABLED) {
            if (lastScreenX !== screenX) rectangleCalls++;
            if (lastScreenY !== screenY) rectangleCalls++;
          }
        }
      }

      hasPrevious = true;
      lastScreenX = screenX;
      lastScreenY = screenY;
    });
    return rectangleCalls;
  }

  /**
   * Trace finite runs as Catmull–Rom splines without allocating a point array.
   * The first and last control points are clamped exactly like hover lookup.
   */
  function appendSplineLinePath(
    ctx: RenderContext2D,
    data: RenderSeriesData,
    xRange: number,
    yRange: number,
  ): void {
    let runLength = 0;
    let p0Y = 0;
    let p1X = 0;
    let p1Y = 0;
    let p2X = 0;
    let p2Y = 0;

    forEachRenderPoint(data, (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        if (runLength >= 2) {
          appendSplineSegment(ctx, p0Y, p1X, p1Y, p2X, p2Y, p2Y);
        }
        runLength = 0;
        return;
      }

      const screenX = state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
      const screenY = state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;

      if (runLength === 0) {
        ctx.moveTo(screenX, screenY);
        p0Y = screenY;
        p1X = screenX;
        p1Y = screenY;
        runLength = 1;
        return;
      }
      if (runLength === 1) {
        p2X = screenX;
        p2Y = screenY;
        runLength = 2;
        return;
      }

      appendSplineSegment(ctx, p0Y, p1X, p1Y, p2X, p2Y, screenY);
      p0Y = p1Y;
      p1X = p2X;
      p1Y = p2Y;
      p2X = screenX;
      p2Y = screenY;
      runLength++;
    });

    if (runLength >= 2) {
      appendSplineSegment(ctx, p0Y, p1X, p1Y, p2X, p2Y, p2Y);
    }
  }

  function closeSplineFillRun(
    ctx: RenderContext2D,
    runLength: number,
    p0Y: number,
    p1X: number,
    p1Y: number,
    p2X: number,
    p2Y: number,
    baselineY: number,
  ): void {
    if (runLength === 0) return;
    if (runLength >= 2) {
      appendSplineSegment(ctx, p0Y, p1X, p1Y, p2X, p2Y, p2Y);
    }
    ctx.lineTo(runLength === 1 ? p1X : p2X, baselineY);
    ctx.closePath();
    ctx.fill();
  }

  function drawSplineFillSegments(
    ctx: RenderContext2D,
    data: RenderSeriesData,
    xRange: number,
    yRange: number,
    baselineY: number,
    verticalScale = 1,
  ): void {
    let runLength = 0;
    let p0Y = 0;
    let p1X = 0;
    let p1Y = 0;
    let p2X = 0;
    let p2Y = 0;

    forEachRenderPoint(data, (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        closeSplineFillRun(ctx, runLength, p0Y, p1X, p1Y, p2X, p2Y, baselineY);
        runLength = 0;
        return;
      }

      const screenX = state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
      const fullScreenY = state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;
      const screenY = baselineY + (fullScreenY - baselineY) * verticalScale;

      if (runLength === 0) {
        ctx.beginPath();
        ctx.moveTo(screenX, baselineY);
        ctx.lineTo(screenX, screenY);
        p0Y = screenY;
        p1X = screenX;
        p1Y = screenY;
        runLength = 1;
        return;
      }
      if (runLength === 1) {
        p2X = screenX;
        p2Y = screenY;
        runLength = 2;
        return;
      }

      appendSplineSegment(ctx, p0Y, p1X, p1Y, p2X, p2Y, screenY);
      p0Y = p1Y;
      p1X = p2X;
      p1Y = p2Y;
      p2X = screenX;
      p2Y = screenY;
      runLength++;
    });

    closeSplineFillRun(ctx, runLength, p0Y, p1X, p1Y, p2X, p2Y, baselineY);
  }

  function drawLine(
    ctx: RenderContext2D,
    data: RenderSeriesData,
    color: string,
    width: number = 1.5,
    seriesType: LineSeriesType = "line",
  ): number {
    if (data.length < 2 || !Number.isFinite(width) || width <= 0) return 0;

    const useStepPath = isStepSeriesType(seriesType);
    const densePointThreshold = Math.max(DENSE_STEP_RECT_MIN_POINTS, state.chartWidth);
    // Firefox's Canvas2D path stroking becomes disproportionately slow for dense
    // orthogonal paths. Thin opaque steps can use axis-aligned rectangles without
    // changing blended joint opacity or visibly replacing wide round joins.
    if (
      useStepPath &&
      width > 0 &&
      width <= DENSE_STEP_RECT_MAX_WIDTH &&
      isOpaqueColor(color) &&
      data.length >= densePointThreshold &&
      hasMinimumFiniteRenderPoints(data, densePointThreshold)
    ) {
      return drawDenseStepLine(ctx, data, color, width, seriesType);
    }

    const xRange = state.viewport.xMax - state.viewport.xMin;
    const yRange = state.viewport.yMax - state.viewport.yMin;

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    ctx.beginPath();
    let needsMoveTo = true;

    if (!useStepPath && interpolation === "spline") {
      appendSplineLinePath(ctx, data, xRange, yRange);
    } else if (!useStepPath) {
      forEachRenderPoint(data, (x, y) => {
        if (!Number.isFinite(y)) {
          needsMoveTo = true;
          return;
        }

        const screenX =
          state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
        const screenY = state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;

        if (needsMoveTo) {
          ctx.moveTo(screenX, screenY);
          needsMoveTo = false;
        } else {
          ctx.lineTo(screenX, screenY);
        }
      });
    } else {
      let lastScreenX = 0;
      let lastScreenY = 0;

      forEachRenderPoint(data, (x, y) => {
        if (!Number.isFinite(y)) {
          needsMoveTo = true;
          return;
        }

        const screenX =
          state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
        const screenY = state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;

        if (needsMoveTo) {
          ctx.moveTo(screenX, screenY);
          needsMoveTo = false;
        } else {
          appendSeriesLineTo(ctx, seriesType, lastScreenX, lastScreenY, screenX, screenY);
        }
        lastScreenX = screenX;
        lastScreenY = screenY;
      });
    }
    ctx.stroke();
    return 0;
  }

  function drawScatter(
    ctx: RenderContext2D,
    data: RenderSeriesData,
    seriesIndex: number,
    sizeScale = 1,
  ): void {
    if (data.length < 1) return;

    const point = resolveSeriesPointOptions(seriesIndex);
    const size = point.size * sizeScale;
    if (size <= 0 || point.opacity <= 0) return;

    const xRange = state.viewport.xMax - state.viewport.xMin;
    const yRange = state.viewport.yMax - state.viewport.yMin;
    const currentAlpha = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1;

    ctx.save();
    ctx.globalAlpha = currentAlpha * point.opacity;

    // LOD buckets repeat a sample when first/min/max/last coincide; drawing the
    // duplicate again composites translucent marks darker.
    let lastX = NaN;
    let lastY = NaN;

    forEachRenderPoint(data, (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x === lastX && y === lastY) return;
      lastX = x;
      lastY = y;

      const screenX = state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
      const screenY = state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;

      drawMarker(
        ctx,
        screenX,
        screenY,
        point.shape,
        size,
        point.color,
        point.borderColor,
        point.borderWidth,
      );
    });

    ctx.restore();
  }

  function getBarPixelWidth(data: RenderSeriesData, options: ResolvedBarOptions): number {
    let previousScreenX: number | undefined;
    let minSpacing = Number.POSITIVE_INFINITY;
    const xRange = state.viewport.xMax - state.viewport.xMin;

    forEachRenderPoint(data, (x) => {
      if (!Number.isFinite(x)) return;

      const screenX = state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
      if (previousScreenX !== undefined) {
        const spacing = Math.abs(screenX - previousScreenX);
        if (spacing > 0 && spacing < minSpacing) minSpacing = spacing;
      }
      previousScreenX = screenX;
    });

    const availableSpacing = Number.isFinite(minSpacing) ? minSpacing : state.chartWidth;
    const rawWidth = availableSpacing * options.widthRatio;
    return Math.max(options.minWidth, Math.min(options.maxWidth, rawWidth));
  }

  function drawBars(ctx: RenderContext2D, data: RenderSeriesData, seriesIndex: number): number {
    if (data.length < 1) return 0;

    const chartBottom = state.chartTop + state.chartHeight;
    const chartLeft = state.padding.left;
    const chartRight = state.width - state.padding.right;
    const options = resolveSeriesBarOptions(
      ctx,
      seriesIndex,
      state.chartTop,
      chartBottom,
      chartLeft,
      chartRight,
    );
    if (!options.fillStyle && options.borderWidth <= 0) return 0;

    const barWidth = getBarPixelWidth(data, options);
    if (barWidth <= 0) return 0;

    const xRange = state.viewport.xMax - state.viewport.xMin;
    const yRange = state.viewport.yMax - state.viewport.yMin;
    const baselineScreenY =
      state.chartTop + ((state.viewport.yMax - options.baseline) / yRange) * state.chartHeight;
    const baselineY = Math.max(state.chartTop, Math.min(chartBottom, baselineScreenY));

    if (options.fillStyle) ctx.fillStyle = options.fillStyle;
    if (options.borderWidth > 0) {
      ctx.strokeStyle = options.borderColor;
      ctx.lineWidth = options.borderWidth;
      ctx.setLineDash(DASH_PATTERNS[options.borderStyle] ?? DASH_PATTERNS.solid);
    }

    // LOD buckets repeat a sample when first/min/max/last coincide; drawing the
    // duplicate again composites translucent bars darker.
    let lastX = NaN;
    let lastY = NaN;

    let rendered = 0;
    forEachRenderPoint(data, (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x === lastX && y === lastY) return;
      lastX = x;
      lastY = y;

      const screenX = state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
      const rawScreenY = state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;
      const screenY = Math.max(state.chartTop, Math.min(chartBottom, rawScreenY));
      const left = Math.max(chartLeft, screenX - barWidth * 0.5);
      const right = Math.min(chartRight, screenX + barWidth * 0.5);
      const width = right - left;
      const top = Math.min(screenY, baselineY);
      const height = Math.abs(baselineY - screenY);

      if (width <= 0 || height <= 0) return;
      if (options.fillStyle) ctx.fillRect(left, top, width, height);
      if (options.borderWidth > 0) ctx.strokeRect(left, top, width, height);
      rendered++;
    });

    if (options.borderWidth > 0) {
      ctx.setLineDash(DASH_PATTERNS.solid);
    }
    return rendered;
  }

  interface StackedAreaBandPoint {
    screenX: number;
    lowerScreenY: number;
    upperScreenY: number;
    sign: 1 | -1;
  }

  function getNearestDataIndexForX(x: number): number {
    if (!dataX || dataLength === 0) return -1;
    if (x <= getXAt(0)) return 0;
    if (x >= getXAt(dataLength - 1)) return dataLength - 1;

    const rightIdx = binarySearchDataXLeft(x, 0, dataLength - 1);
    const leftIdx = Math.max(0, rightIdx - 1);
    return Math.abs(getXAt(leftIdx) - x) <= Math.abs(getXAt(rightIdx) - x) ? leftIdx : rightIdx;
  }

  function getStackedAreaBandAtIndex(
    seriesIndex: number,
    dataIndex: number,
    includeSeries: (index: number) => boolean,
  ): { lower: number; upper: number; sign: 1 | -1 } | null {
    const value = getYAt(seriesIndex, dataIndex);
    if (!Number.isFinite(value)) return null;

    let positiveStack = 0;
    let negativeStack = 0;

    for (let s = 0; s < seriesIndex; s++) {
      if (!includeSeries(s) || !isStackedAreaSeriesType(getSeriesType(s)) || !dataSeries[s]) {
        continue;
      }

      const previous = getYAt(s, dataIndex);
      if (!Number.isFinite(previous)) continue;
      if (previous >= 0) positiveStack += previous;
      else negativeStack += previous;
    }

    if (value >= 0) {
      return {
        lower: positiveStack,
        upper: positiveStack + value,
        sign: 1,
      };
    }

    return {
      lower: negativeStack,
      upper: negativeStack + value,
      sign: -1,
    };
  }

  function interpolateRawYAt(
    seriesIndex: number,
    leftIdx: number,
    rightIdx: number,
    t: number,
  ): number {
    const y0 = getYAt(seriesIndex, leftIdx);
    const y1 = getYAt(seriesIndex, rightIdx);
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) return NaN;
    return y0 + (y1 - y0) * t;
  }

  // Step-curve stacked areas hold sample values between points, so hover values
  // must follow each series' own curve rather than a linear blend that is never
  // drawn.
  function interpolateStackComponentAt(
    seriesIndex: number,
    leftIdx: number,
    rightIdx: number,
    t: number,
  ): number {
    switch (getSeriesStackCurve(seriesIndex)) {
      case "step":
      case "step-after":
        return getYAt(seriesIndex, leftIdx);
      case "step-before":
        return getYAt(seriesIndex, rightIdx);
      case "step-mid":
        return getYAt(seriesIndex, t < 0.5 ? leftIdx : rightIdx);
      default:
        return interpolateRawYAt(seriesIndex, leftIdx, rightIdx, t);
    }
  }

  function getStackedAreaBandAtInterpolatedX(
    seriesIndex: number,
    leftIdx: number,
    rightIdx: number,
    t: number,
    includeSeries: (index: number) => boolean,
  ): { lower: number; upper: number; sign: 1 | -1 } | null {
    const value = interpolateStackComponentAt(seriesIndex, leftIdx, rightIdx, t);
    if (!Number.isFinite(value)) return null;

    let positiveStack = 0;
    let negativeStack = 0;

    for (let s = 0; s < seriesIndex; s++) {
      if (!includeSeries(s) || !isStackedAreaSeriesType(getSeriesType(s)) || !dataSeries[s]) {
        continue;
      }

      const previous = interpolateStackComponentAt(s, leftIdx, rightIdx, t);
      if (!Number.isFinite(previous)) continue;
      if (previous >= 0) positiveStack += previous;
      else negativeStack += previous;
    }

    if (value >= 0) {
      return {
        lower: positiveStack,
        upper: positiveStack + value,
        sign: 1,
      };
    }

    return {
      lower: negativeStack,
      upper: negativeStack + value,
      sign: -1,
    };
  }

  function appendStackedAreaBoundaryTo(
    ctx: RenderContext2D,
    curve: StackCurveStyle,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): void {
    appendSeriesLineTo(ctx, stackCurveToSeriesType(curve), fromX, fromY, toX, toY);
  }

  function drawStackedAreaSeries(
    ctx: RenderContext2D,
    data: RenderSeriesData,
    seriesIndex: number,
  ): number {
    if (data.length < 2) return 0;

    const chartBottom = state.chartTop + state.chartHeight;
    const chartLeft = state.padding.left;
    const chartRight = state.width - state.padding.right;
    const options = resolveSeriesStackOptions(
      ctx,
      seriesIndex,
      state.chartTop,
      chartBottom,
      chartLeft,
      chartRight,
    );
    if (!options.fillStyle && options.borderWidth <= 0) return 0;

    const xRange = state.viewport.xMax - state.viewport.xMin;
    const yRange = state.viewport.yMax - state.viewport.yMin;
    const points: StackedAreaBandPoint[] = [];
    let rendered = 0;
    let currentSign: 1 | -1 | null = null;

    const flush = () => {
      if (points.length < 2) {
        points.length = 0;
        currentSign = null;
        return;
      }

      if (options.fillStyle) {
        ctx.fillStyle = options.fillStyle;
        ctx.beginPath();
        ctx.moveTo(points[0].screenX, points[0].upperScreenY);
        for (let i = 1; i < points.length; i++) {
          appendStackedAreaBoundaryTo(
            ctx,
            options.curve,
            points[i - 1].screenX,
            points[i - 1].upperScreenY,
            points[i].screenX,
            points[i].upperScreenY,
          );
        }
        const lastPoint = points[points.length - 1];
        ctx.lineTo(lastPoint.screenX, lastPoint.lowerScreenY);
        const lowerCurve = reverseStackCurve(options.curve);
        for (let i = points.length - 2; i >= 0; i--) {
          appendStackedAreaBoundaryTo(
            ctx,
            lowerCurve,
            points[i + 1].screenX,
            points[i + 1].lowerScreenY,
            points[i].screenX,
            points[i].lowerScreenY,
          );
        }
        ctx.closePath();
        ctx.fill();
      }

      if (options.borderWidth > 0) {
        ctx.strokeStyle = options.borderColor;
        ctx.lineWidth = options.borderWidth;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.setLineDash(DASH_PATTERNS[options.borderStyle] ?? DASH_PATTERNS.solid);
        ctx.beginPath();
        ctx.moveTo(points[0].screenX, points[0].upperScreenY);
        for (let i = 1; i < points.length; i++) {
          appendStackedAreaBoundaryTo(
            ctx,
            options.curve,
            points[i - 1].screenX,
            points[i - 1].upperScreenY,
            points[i].screenX,
            points[i].upperScreenY,
          );
        }
        ctx.stroke();
        ctx.setLineDash(DASH_PATTERNS.solid);
      }

      rendered += points.length;
      points.length = 0;
      currentSign = null;
    };

    forEachRenderPoint(data, (x, _y, rawDataIndex) => {
      if (!Number.isFinite(x)) {
        flush();
        return;
      }

      const dataIndex = rawDataIndex >= 0 ? rawDataIndex : getNearestDataIndexForX(x);
      if (dataIndex < 0) {
        flush();
        return;
      }

      const band = getStackedAreaBandAtIndex(seriesIndex, dataIndex, isSeriesVisible);
      if (!band) {
        flush();
        return;
      }

      if (currentSign !== null && band.sign !== currentSign) {
        flush();
      }
      currentSign = band.sign;

      const screenX = state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
      const lowerScreenY =
        state.chartTop + ((state.viewport.yMax - band.lower) / yRange) * state.chartHeight;
      const upperScreenY =
        state.chartTop + ((state.viewport.yMax - band.upper) / yRange) * state.chartHeight;

      if (
        !Number.isFinite(screenX) ||
        !Number.isFinite(lowerScreenY) ||
        !Number.isFinite(upperScreenY)
      ) {
        flush();
        return;
      }

      points.push({ screenX, lowerScreenY, upperScreenY, sign: band.sign });
    });

    flush();
    return rendered;
  }

  function drawStackedAreas(ctx: RenderContext2D, renderDataSeries: RenderSeriesData[]): number {
    let rendered = 0;
    for (let s = 0; s < renderDataSeries.length; s++) {
      if (
        isSeriesVisible(s) &&
        isStackedAreaSeriesType(getSeriesType(s)) &&
        renderDataSeries[s].length > 0
      ) {
        rendered += drawStackedAreaSeries(ctx, renderDataSeries[s], s);
      }
    }
    return rendered;
  }

  function getEasedDataRevealProgress(): number {
    if (!state.animated || state.revealProgress >= 1) return 1;
    return Math.max(0, Math.min(1, ANIMATION.revealEasing(state.revealProgress)));
  }

  function drawRetainedPlotFrame(ctx: RenderContext2D): void {
    const retained = retainedPlotFrame;
    if (!retained) return;

    const revealProgress = getEasedDataRevealProgress();
    if (revealProgress >= 1) {
      retainedPlotFrame = null;
      return;
    }

    const remaining = 1 - revealProgress;
    const sourceX = retained.left + retained.width * revealProgress;
    const sourceWidth = retained.width * remaining;
    const destinationX = (state.padding.left + state.chartWidth * revealProgress) * state.dpr;
    const destinationY = state.chartTop * state.dpr;
    const destinationWidth = state.chartWidth * state.dpr * remaining;
    const destinationHeight = state.chartHeight * state.dpr;
    if (sourceWidth <= 0 || destinationWidth <= 0 || destinationHeight <= 0) {
      retainedPlotFrame = null;
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(destinationX, destinationY, destinationWidth, destinationHeight);
    ctx.clip();
    ctx.drawImage(
      retained.canvas as CanvasImageSource,
      sourceX,
      retained.top,
      sourceWidth,
      retained.height,
      destinationX,
      destinationY,
      destinationWidth,
      destinationHeight,
    );
    ctx.restore();
  }

  function beginDataReveal(ctx: RenderContext2D): boolean {
    const revealProgress = getEasedDataRevealProgress();
    if (revealProgress >= 1) return false;

    ctx.save();
    ctx.beginPath();
    ctx.rect(
      state.padding.left,
      state.chartTop,
      state.chartWidth * revealProgress,
      state.chartHeight,
    );
    ctx.clip();
    return true;
  }

  function appendSeriesLineTo(
    ctx: RenderContext2D,
    seriesType: LineSeriesType,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): void {
    switch (seriesType) {
      case "step":
      case "step-after":
        ctx.lineTo(toX, fromY);
        ctx.lineTo(toX, toY);
        break;
      case "step-before":
        ctx.lineTo(fromX, toY);
        ctx.lineTo(toX, toY);
        break;
      case "step-mid": {
        const midX = fromX + (toX - fromX) * 0.5;
        ctx.lineTo(midX, fromY);
        ctx.lineTo(midX, toY);
        ctx.lineTo(toX, toY);
        break;
      }
      default:
        ctx.lineTo(toX, toY);
        break;
    }
  }

  function drawFill(
    ctx: RenderContext2D,
    data: RenderSeriesData,
    fillStyle: string | CanvasGradient,
    fillToZero: boolean,
    seriesType: LineSeriesType,
  ) {
    if (data.length < 2) return;

    const xRange = state.viewport.xMax - state.viewport.xMin;
    const yRange = state.viewport.yMax - state.viewport.yMin;
    const chartBottom = state.chartTop + state.chartHeight;

    // Calculate baseline Y position (zero line or chart bottom)
    let baselineY: number;
    if (fillToZero) {
      // Calculate where y=0 is on screen, clamped to chart area
      const zeroScreenY = state.chartTop + ((state.viewport.yMax - 0) / yRange) * state.chartHeight;
      baselineY = Math.max(state.chartTop, Math.min(chartBottom, zeroScreenY));
    } else {
      baselineY = chartBottom;
    }

    ctx.fillStyle = fillStyle;

    if (!isStepSeriesType(seriesType) && interpolation === "spline") {
      drawSplineFillSegments(ctx, data, xRange, yRange, baselineY);
      return;
    }

    // Draw fill segments, breaking at gaps (NaN values)
    let inSegment = false;
    let lastValidScreenX = 0;
    const useStepPath = isStepSeriesType(seriesType);

    if (!useStepPath) {
      forEachRenderPoint(data, (x, y) => {
        const screenX =
          state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;

        if (!Number.isFinite(y)) {
          // Gap - close current segment if we have one
          if (inSegment) {
            ctx.lineTo(lastValidScreenX, baselineY);
            ctx.closePath();
            ctx.fill();
            inSegment = false;
          }
          return;
        }

        const screenY = state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;

        if (!inSegment) {
          // Start new segment
          ctx.beginPath();
          ctx.moveTo(screenX, baselineY);
          ctx.lineTo(screenX, screenY);
          inSegment = true;
        } else {
          ctx.lineTo(screenX, screenY);
        }
        lastValidScreenX = screenX;
      });
    } else {
      let lastValidScreenY = 0;

      forEachRenderPoint(data, (x, y) => {
        const screenX =
          state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;

        if (!Number.isFinite(y)) {
          // Gap - close current segment if we have one
          if (inSegment) {
            ctx.lineTo(lastValidScreenX, baselineY);
            ctx.closePath();
            ctx.fill();
            inSegment = false;
          }
          return;
        }

        const screenY = state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;

        if (!inSegment) {
          // Start new segment
          ctx.beginPath();
          ctx.moveTo(screenX, baselineY);
          ctx.lineTo(screenX, screenY);
          inSegment = true;
        } else {
          appendSeriesLineTo(ctx, seriesType, lastValidScreenX, lastValidScreenY, screenX, screenY);
        }
        lastValidScreenX = screenX;
        lastValidScreenY = screenY;
      });
    }

    // Close final segment
    if (inSegment) {
      ctx.lineTo(lastValidScreenX, baselineY);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawRangeBand(
    ctx: RenderContext2D,
    data: RangeRenderSeriesData,
    fillStyle: string | CanvasGradient,
  ) {
    if (data.length < 2) return;

    const xRange = state.viewport.xMax - state.viewport.xMin;
    const yRange = state.viewport.yMax - state.viewport.yMin;

    ctx.fillStyle = fillStyle;

    let ordinal = 0;
    while (ordinal < data.length) {
      while (ordinal < data.length && !rangeRenderPointIsValid(data, ordinal)) {
        ordinal++;
      }
      if (ordinal >= data.length) break;

      const segmentStart = ordinal;
      while (ordinal < data.length && rangeRenderPointIsValid(data, ordinal)) {
        ordinal++;
      }
      const segmentEnd = ordinal - 1;

      ctx.beginPath();
      appendRangeBoundaryPath(ctx, data, segmentStart, segmentEnd, "high", 1, true, xRange, yRange);
      appendRangeBoundaryPath(
        ctx,
        data,
        segmentStart,
        segmentEnd,
        "low",
        -1,
        false,
        xRange,
        yRange,
      );

      ctx.closePath();
      ctx.fill();
    }
  }

  function appendRangeBoundaryPath(
    ctx: RenderContext2D,
    data: RangeRenderSeriesData,
    segmentStart: number,
    segmentEnd: number,
    boundary: "low" | "high",
    direction: 1 | -1,
    moveToStart: boolean,
    xRange: number,
    yRange: number,
  ): void {
    const firstOrdinal = direction === 1 ? segmentStart : segmentEnd;
    const lastOrdinal = direction === 1 ? segmentEnd : segmentStart;

    const firstX = getRangeBoundaryScreenX(data, firstOrdinal, xRange);
    const firstY = getRangeBoundaryScreenY(data, firstOrdinal, boundary, yRange);
    if (moveToStart) ctx.moveTo(firstX, firstY);
    else ctx.lineTo(firstX, firstY);
    if (firstOrdinal === lastOrdinal) return;

    for (let ordinal = firstOrdinal; ordinal !== lastOrdinal; ordinal += direction) {
      const nextOrdinal = ordinal + direction;
      const nextX = getRangeBoundaryScreenX(data, nextOrdinal, xRange);
      const nextY = getRangeBoundaryScreenY(data, nextOrdinal, boundary, yRange);
      if (interpolation === "spline") {
        const previousOrdinal = ordinal === firstOrdinal ? ordinal : ordinal - direction;
        const followingOrdinal =
          nextOrdinal === lastOrdinal ? nextOrdinal : nextOrdinal + direction;
        appendSplineSegment(
          ctx,
          getRangeBoundaryScreenY(data, previousOrdinal, boundary, yRange),
          getRangeBoundaryScreenX(data, ordinal, xRange),
          getRangeBoundaryScreenY(data, ordinal, boundary, yRange),
          nextX,
          nextY,
          getRangeBoundaryScreenY(data, followingOrdinal, boundary, yRange),
        );
      } else {
        ctx.lineTo(nextX, nextY);
      }
    }
  }

  function getRangeBoundaryScreenX(
    data: RangeRenderSeriesData,
    ordinal: number,
    xRange: number,
  ): number {
    return (
      state.padding.left +
      ((getRangeRenderX(data, ordinal) - state.viewport.xMin) / xRange) * state.chartWidth
    );
  }

  function getRangeBoundaryScreenY(
    data: RangeRenderSeriesData,
    ordinal: number,
    boundary: "low" | "high",
    yRange: number,
  ): number {
    const value =
      boundary === "high" ? getRangeRenderHigh(data, ordinal) : getRangeRenderLow(data, ordinal);
    return state.chartTop + ((state.viewport.yMax - value) / yRange) * state.chartHeight;
  }

  function drawRangeBoundaryLine(
    ctx: RenderContext2D,
    data: RangeRenderSeriesData,
    boundary: "upper" | "lower",
    color: string,
    width: number,
    style: "solid" | "dashed" | "dotted",
  ) {
    if (data.length < 2 || width <= 0) return;

    const xRange = state.viewport.xMax - state.viewport.xMin;
    const yRange = state.viewport.yMax - state.viewport.yMin;

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash(DASH_PATTERNS[style] ?? DASH_PATTERNS.solid);

    ctx.beginPath();
    let ordinal = 0;
    while (ordinal < data.length) {
      while (ordinal < data.length && !rangeRenderPointIsValid(data, ordinal)) {
        ordinal++;
      }
      if (ordinal >= data.length) break;
      const segmentStart = ordinal;
      while (ordinal < data.length && rangeRenderPointIsValid(data, ordinal)) {
        ordinal++;
      }
      appendRangeBoundaryPath(
        ctx,
        data,
        segmentStart,
        ordinal - 1,
        boundary === "upper" ? "high" : "low",
        1,
        true,
        xRange,
        yRange,
      );
    }

    ctx.stroke();
    ctx.setLineDash(DASH_PATTERNS.solid);
  }

  function drawRangeBandBorders(
    ctx: RenderContext2D,
    data: RangeRenderSeriesData,
    border: ResolvedBandBorderOptions,
  ) {
    drawRangeBoundaryLine(ctx, data, "upper", border.upperColor, border.width, border.style);
    drawRangeBoundaryLine(ctx, data, "lower", border.lowerColor, border.width, border.style);
  }

  function drawStyledRangeBand(
    ctx: RenderContext2D,
    seriesIndex: number,
    rangeData: RangeRenderSeriesData,
    chartTop: number,
    chartBottom: number,
    chartLeft: number,
    chartRight: number,
  ): number {
    let renderedPoints = 0;
    const fillStyle = getRangeBandFillStyle(
      ctx,
      seriesIndex,
      chartTop,
      chartBottom,
      chartLeft,
      chartRight,
    );
    if (fillStyle) {
      drawRangeBand(ctx, rangeData, fillStyle);
      renderedPoints += rangeData.length * 2;
    }

    const border = getRangeBandBorderOptions(seriesIndex);
    if (border) {
      drawRangeBandBorders(ctx, rangeData, border);
      renderedPoints += rangeData.length * 2;
    }

    return renderedPoints;
  }

  interface TooltipDataResult {
    points: Array<DataPointResult | null>;
    dataXVal: number;
    crosshairScreenX: number;
  }

  function computeTooltipData(): TooltipDataResult | null {
    const chartBottom = state.chartTop + state.chartHeight;

    if (
      state.mouseX < state.padding.left ||
      state.mouseX > state.width - state.padding.right ||
      state.mouseY < state.chartTop ||
      state.mouseY > chartBottom
    ) {
      return null;
    }

    const xRange = state.viewport.xMax - state.viewport.xMin;

    const dataXVal =
      state.viewport.xMin + ((state.mouseX - state.padding.left) / state.chartWidth) * xRange;

    const points: Array<DataPointResult | null> = new Array(seriesConfig.count).fill(null);
    for (let s = 0; s < seriesConfig.count; s++) {
      if (!isSeriesVisible(s)) continue;
      const point = findNearestDataPoint(dataXVal, s);
      if (point) points[s] = point;
    }

    const firstPoint = points.find((p): p is DataPointResult => !!p);
    if (!firstPoint) return null;

    const anyInterpolated = interpolation !== "none" && points.some((p) => !!p && p.isInterpolated);
    const crosshairScreenX = anyInterpolated
      ? state.mouseX
      : state.padding.left + ((firstPoint.x - state.viewport.xMin) / xRange) * state.chartWidth;

    return { points, dataXVal, crosshairScreenX };
  }

  function formatLineTooltipTitle(dataXVal: number): string {
    return formatTooltipTitle(dataXVal, state.tooltipTitleFormat);
  }

  function buildDefaultTooltipContent(
    dataXVal: number,
    points: Array<DataPointResult | null>,
  ): ReturnType<typeof buildLineTooltipContent> {
    return buildLineTooltipContent({
      title: formatLineTooltipTitle(dataXVal),
      points,
      seriesCount: seriesConfig.count,
      visibleSeries: state.tooltipVisibleSeries,
      isSeriesVisible,
      getSeriesUnit,
      getSeriesName,
      getSeriesColor,
    });
  }

  function drawCrosshair(ctx: RenderContext2D) {
    const tooltipData = computeTooltipData();
    if (!tooltipData) {
      resetTooltipRatchet(state);
      return;
    }

    const { points, dataXVal, crosshairScreenX } = tooltipData;

    const yRange = state.viewport.yMax - state.viewport.yMin;

    drawCrosshairLines(ctx, state, crosshairScreenX);

    for (let s = 0; s < seriesConfig.count; s++) {
      if (!isSeriesVisible(s)) continue;
      const point = points[s];
      if (!point) continue;

      const color = getSeriesColor(s);
      const displayY = getMarkerY(point);
      const pointScreenY =
        state.chartTop + ((state.viewport.yMax - displayY) / yRange) * state.chartHeight;

      const marker = resolveSeriesMarker(s);
      drawMarker(
        ctx,
        crosshairScreenX,
        pointScreenY,
        marker.shape,
        marker.size,
        color,
        marker.borderColor,
        marker.borderWidth,
        marker.glow,
      );
    }

    // Send tooltip data to main thread if callback is registered and dataX changed
    if (state.tooltipHasCallback && dataXVal !== state.tooltipLastDataX) {
      state.tooltipLastDataX = dataXVal;
      const seriesData = [];
      for (let s = 0; s < seriesConfig.count; s++) {
        if (!isSeriesVisible(s)) continue;
        const point = points[s];
        if (!point) continue;
        const displayY = getDisplayY(point);
        const range = getDisplayRange(point);
        const unit = getSeriesUnit(s);
        seriesData.push({
          index: s,
          name: getSeriesName(s),
          value: displayY,
          formattedValue: range
            ? formatRangeValue(range.low, range.high, unit)
            : formatValue(displayY, unit),
          ...(range
            ? {
                low: range.low,
                high: range.high,
                formattedLow: formatValue(range.low, unit),
                formattedHigh: formatValue(range.high, unit),
              }
            : {}),
          color: getSeriesColor(s),
          interpolated: point.isInterpolated,
        });
      }
      callbacks.postMessage({
        type: "tooltipData",
        params: {
          dataX: dataXVal,
          screenX: crosshairScreenX,
          screenY: state.mouseY,
          series: seriesData,
        },
        defaultTitle: formatLineTooltipTitle(dataXVal),
      });
    }

    // Render tooltip: use custom content if callback registered, otherwise default
    const content = state.tooltipHasCallback
      ? state.tooltipCustomContent
      : buildDefaultTooltipContent(dataXVal, points);
    if (content) renderTooltipBox(ctx, state, content, crosshairScreenX);
  }

  function attachNearestRangeValues(
    result: DataPointResult,
    seriesIndex: number,
    idx: number,
  ): void {
    if (!hasRangeData(seriesIndex)) return;
    const low = getRangeLowerAt(seriesIndex, idx);
    const high = getRangeUpperAt(seriesIndex, idx);
    if (!Number.isFinite(low) || !Number.isFinite(high)) return;
    result.low = low;
    result.high = high;
  }

  function attachNearestStackedAreaValue(
    result: DataPointResult,
    seriesIndex: number,
    idx: number,
  ): void {
    if (!isStackedAreaSeriesType(getSeriesType(seriesIndex))) return;
    const band = getStackedAreaBandAtIndex(seriesIndex, idx, isSeriesVisible);
    if (!band || !Number.isFinite(band.upper)) return;
    result.stackedY = band.upper;
  }

  function getRangeBoundaryAt(seriesIndex: number, idx: number, boundary: "low" | "high"): number {
    return boundary === "low"
      ? getRangeLowerAt(seriesIndex, idx)
      : getRangeUpperAt(seriesIndex, idx);
  }

  function interpolateRangeBoundary(
    seriesIndex: number,
    leftIdx: number,
    rightIdx: number,
    t: number,
    boundary: "low" | "high",
    seriesType: LineSeriesType,
  ): number {
    if (seriesType === "step" || seriesType === "step-after") {
      return getRangeBoundaryAt(seriesIndex, leftIdx, boundary);
    }
    if (seriesType === "step-before") {
      return getRangeBoundaryAt(seriesIndex, rightIdx, boundary);
    }
    if (seriesType === "step-mid") {
      return getRangeBoundaryAt(seriesIndex, t < 0.5 ? leftIdx : rightIdx, boundary);
    }

    if (interpolation === "spline") {
      const i0 = Math.max(0, leftIdx - 1);
      const i3 = Math.min(dataLength - 1, rightIdx + 1);
      const p1 = getRangeBoundaryAt(seriesIndex, leftIdx, boundary);
      const p2 = getRangeBoundaryAt(seriesIndex, rightIdx, boundary);
      const candidateP0 = getRangeBoundaryAt(seriesIndex, i0, boundary);
      const candidateP3 = getRangeBoundaryAt(seriesIndex, i3, boundary);
      return catmullRomInterpolate(
        Number.isFinite(candidateP0) ? candidateP0 : p1,
        p1,
        p2,
        Number.isFinite(candidateP3) ? candidateP3 : p2,
        t,
      );
    }

    const y0 = getRangeBoundaryAt(seriesIndex, leftIdx, boundary);
    const y1 = getRangeBoundaryAt(seriesIndex, rightIdx, boundary);
    return y0 + (y1 - y0) * t;
  }

  function findNearestDataPoint(dataXVal: number, seriesIndex: number): DataPointResult | null {
    if (!dataX || dataSeries.length === 0 || dataLength === 0) return null;

    if (dataXVal <= getXAt(0)) {
      const result = {
        x: getXAt(0),
        y: getYAt(seriesIndex, 0),
        idx: 0,
        isInterpolated: false,
      };
      attachNearestRangeValues(result, seriesIndex, 0);
      attachNearestStackedAreaValue(result, seriesIndex, 0);
      return result;
    }
    if (dataXVal >= getXAt(dataLength - 1)) {
      const result = {
        x: getXAt(dataLength - 1),
        y: getYAt(seriesIndex, dataLength - 1),
        idx: dataLength - 1,
        isInterpolated: false,
      };
      attachNearestRangeValues(result, seriesIndex, dataLength - 1);
      attachNearestStackedAreaValue(result, seriesIndex, dataLength - 1);
      return result;
    }

    const rightIdx = binarySearchDataXLeft(dataXVal, 0, dataLength - 1);
    const leftIdx = rightIdx > 0 ? rightIdx - 1 : 0;

    const leftX = getXAt(leftIdx);
    const rightX = getXAt(rightIdx);
    const distLeft = Math.abs(leftX - dataXVal);
    const distRight = Math.abs(rightX - dataXVal);

    const idx = distLeft < distRight ? leftIdx : rightIdx;
    const nearestX = getXAt(idx);
    const nearestY = getYAt(seriesIndex, idx);

    // Calculate interpolation if enabled and cursor is between points
    let interpolatedY: number | undefined;
    let interpolatedStackedY: number | undefined;
    let interpolatedLow: number | undefined;
    let interpolatedHigh: number | undefined;
    let isInterpolated = false;

    if (interpolation !== "none" && leftIdx !== rightIdx) {
      const x0 = leftX;
      const x1 = rightX;
      const t = (dataXVal - x0) / (x1 - x0);
      const seriesType = getSeriesType(seriesIndex);

      if (seriesType === "step" || seriesType === "step-after") {
        interpolatedY = getYAt(seriesIndex, leftIdx);
        isInterpolated = dataXVal > leftX && dataXVal < rightX;
      } else if (seriesType === "step-before") {
        interpolatedY = getYAt(seriesIndex, rightIdx);
        isInterpolated = dataXVal > leftX && dataXVal < rightX;
      } else if (seriesType === "step-mid") {
        const midX = x0 + (x1 - x0) * 0.5;
        interpolatedY = getYAt(seriesIndex, dataXVal < midX ? leftIdx : rightIdx);
        isInterpolated = dataXVal > leftX && dataXVal < rightX;
      } else if (isDiscreteSeriesType(seriesType)) {
        // Discrete marks have no connecting line; snap hover to the nearest
        // sample instead of interpolating along a line not drawn.
        interpolatedY = undefined;
        isInterpolated = false;
      } else if (
        isStackedAreaSeriesType(seriesType) &&
        getSeriesStackCurve(seriesIndex) !== "linear"
      ) {
        interpolatedY = interpolateStackComponentAt(seriesIndex, leftIdx, rightIdx, t);
        isInterpolated = dataXVal > leftX && dataXVal < rightX;
      } else {
        if (interpolation === "spline") {
          // Catmull-Rom spline interpolation using 4 points
          // Get indices for p0, p1, p2, p3 (clamped to data bounds)
          const i0 = Math.max(0, leftIdx - 1);
          const i1 = leftIdx;
          const i2 = rightIdx;
          const i3 = Math.min(dataLength - 1, rightIdx + 1);
          const p1 = getYAt(seriesIndex, i1);
          const p2 = getYAt(seriesIndex, i2);
          const candidateP0 = getYAt(seriesIndex, i0);
          const candidateP3 = getYAt(seriesIndex, i3);

          interpolatedY = catmullRomInterpolate(
            Number.isFinite(candidateP0) ? candidateP0 : p1,
            p1,
            p2,
            Number.isFinite(candidateP3) ? candidateP3 : p2,
            t,
          );
        } else {
          // Linear interpolation: y = y0 + (y1 - y0) * t
          const y0 = getYAt(seriesIndex, leftIdx);
          const y1 = getYAt(seriesIndex, rightIdx);
          interpolatedY = y0 + (y1 - y0) * t;
        }

        // Between samples, the marker and tooltip must remain on the rendered
        // curve all the way to each exact endpoint. A proximity snap creates a
        // visible discontinuity and reports a value that is not on the spline.
        isInterpolated = dataXVal > leftX && dataXVal < rightX;
      }

      if (hasRangeData(seriesIndex)) {
        const low = interpolateRangeBoundary(seriesIndex, leftIdx, rightIdx, t, "low", seriesType);
        const high = interpolateRangeBoundary(
          seriesIndex,
          leftIdx,
          rightIdx,
          t,
          "high",
          seriesType,
        );
        if (Number.isFinite(low) && Number.isFinite(high)) {
          interpolatedLow = low <= high ? low : high;
          interpolatedHigh = low <= high ? high : low;
        }
      }

      if (isStackedAreaSeriesType(seriesType)) {
        const band = getStackedAreaBandAtInterpolatedX(
          seriesIndex,
          leftIdx,
          rightIdx,
          t,
          isSeriesVisible,
        );
        if (band && Number.isFinite(band.upper)) {
          interpolatedStackedY = band.upper;
        }
      }
    }

    const result = {
      x: nearestX,
      y: nearestY,
      idx,
      interpolatedY,
      interpolatedStackedY,
      interpolatedLow,
      interpolatedHigh,
      isInterpolated,
    };
    attachNearestRangeValues(result, seriesIndex, idx);
    attachNearestStackedAreaValue(result, seriesIndex, idx);
    return result;
  }

  function renderRangePreview() {
    if (!dataX || lodLevelsBySeries.length === 0) return;

    const previewCanvasHeight = state.rangeSelectorHeight;
    const previewHeight = previewCanvasHeight - 10;
    const previewLeft = state.rangeSelectorWidth === "canvas" ? 0 : state.padding.left;
    const previewRight =
      state.rangeSelectorWidth === "canvas" ? state.width : state.width - state.padding.right;
    const previewWidth = previewRight - previewLeft;

    if (!state.rangePreviewCanvas || state.rangePreviewCanvas.width !== state.width * state.dpr) {
      state.rangePreviewCanvas = state.createCanvas(
        state.width * state.dpr,
        previewCanvasHeight * state.dpr,
      );
      state.rangePreviewCtx = get2dContext(state.rangePreviewCanvas, {
        alpha: true,
      });
    }

    const ctx = state.rangePreviewCtx!;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.width, previewCanvasHeight);
    ctx.save();
    ctx.beginPath();
    ctx.rect(previewLeft, 0, previewWidth, previewCanvasHeight);
    ctx.clip();

    // Save main chart layout state
    const savedViewport = state.viewport;
    const savedChartTop = state.chartTop;
    const savedChartHeight = state.chartHeight;
    const savedChartWidth = state.chartWidth;
    const savedPaddingLeft = state.padding.left;
    const savedPaddingRight = state.padding.right;
    const savedLODIndex = currentLODIndex;
    const savedBucketSize = currentBucketSize;
    const savedSelectedLODIndex = lastSelectedLODIndex;
    const savedPresentationMode = lastPresentationMode;
    const savedPresentationColumnCount = lastPresentationColumnCount;
    const savedPresentationVertexCount = lastPresentationVertexCount;
    const savedPresentationQueryVisits = lastPresentationQueryVisits;
    const savedPresentationLargestBucket = lastPresentationLargestBucket;
    const savedPresentationGridDelta = lastPresentationGridDelta;
    const savedPresentationResolvedGridDelta = presentationResolvedGridDelta;
    const savedPresentationResolvedRangeGridDelta = presentationResolvedRangeGridDelta;

    // Swap to preview layout: full data range, preview dimensions
    const previewY = applyYDomain(state.dataBounds.yMin, state.dataBounds.yMax, yDomain);
    state.viewport = {
      xMin: state.dataBounds.xMin,
      xMax: state.dataBounds.xMax,
      yMin: previewY.min,
      yMax: previewY.max,
    };
    state.chartTop = 5;
    state.chartHeight = previewHeight;
    state.chartWidth = previewWidth;
    state.padding.left = previewLeft;
    state.padding.right = state.width - previewRight;

    // Get render data at full range
    const renderDataSeries = getRenderData(0, dataLength - 1, state.chartWidth);

    // Draw fills
    const chartBottom = state.chartTop + state.chartHeight;
    for (let s = 0; s < renderDataSeries.length; s++) {
      const renderData = renderDataSeries[s];
      const config = seriesConfig.options[s];

      const rangeData = getRangeRenderData(s, renderData);
      if (rangeData) {
        drawStyledRangeBand(
          ctx,
          s,
          rangeData,
          state.chartTop,
          chartBottom,
          previewLeft,
          previewRight,
        );
        continue;
      }

      const seriesType = getSeriesType(s);
      if (isStackedAreaSeriesType(seriesType)) continue;
      if (isDiscreteSeriesType(seriesType)) continue;

      if (renderData.length > 1 && config?.fill) {
        const fillToZero = config?.fillToZero ?? true;

        if (config.fillEffect === "layered") {
          drawLayeredFill(ctx, renderData, getSeriesColor(s), 0.8, fillToZero, seriesType);
        } else {
          const fillStyle = getSeriesFillStyle(
            ctx,
            s,
            state.chartTop,
            chartBottom,
            previewLeft,
            previewRight,
          );
          if (fillStyle) {
            drawFill(ctx, renderData, fillStyle, fillToZero, seriesType);
          }
        }
      }
    }

    // Draw fill effects
    for (let s = 0; s < renderDataSeries.length; s++) {
      const renderData = renderDataSeries[s];
      const config = seriesConfig.options[s];
      if (getRangeRenderData(s, renderData)) continue;
      const seriesType = getSeriesType(s);
      if (isStackedAreaSeriesType(seriesType)) continue;
      if (isDiscreteSeriesType(seriesType)) continue;
      if (renderData.length > 1 && config?.fill && config?.fillEffect === "glow") {
        const opacity = typeof config.fill === "number" ? config.fill : 0.4;
        drawLineGlow(ctx, renderData, getSeriesColor(s), opacity * 2.5, seriesType);
      }
    }

    // Draw stacked areas as cumulative filled bands
    drawStackedAreas(ctx, renderDataSeries);

    // Draw bars above area fills and below line/scatter overlays
    for (let s = 0; s < renderDataSeries.length; s++) {
      const renderData = renderDataSeries[s];
      const seriesType = getSeriesType(s);
      if (isBarSeriesType(seriesType)) {
        drawBars(ctx, renderData, s);
      }
    }

    // Draw lines and scatter points on top
    for (let s = 0; s < renderDataSeries.length; s++) {
      const renderData = renderDataSeries[s];
      const seriesType = getSeriesType(s);
      if (isStackedAreaSeriesType(seriesType)) continue;
      if (isBarSeriesType(seriesType)) continue;
      if (isScatterSeriesType(seriesType)) {
        drawScatter(ctx, renderData, s, 0.75);
        continue;
      }
      if (renderData.length > 1 && getSeriesLineWidth(s) > 0) {
        drawLine(ctx, renderData, getSeriesColor(s), 1, seriesType);
      }
    }

    // Restore main chart layout state
    state.viewport = savedViewport;
    state.chartTop = savedChartTop;
    state.chartHeight = savedChartHeight;
    state.chartWidth = savedChartWidth;
    state.padding.left = savedPaddingLeft;
    state.padding.right = savedPaddingRight;
    currentLODIndex = savedLODIndex;
    currentBucketSize = savedBucketSize;
    lastSelectedLODIndex = savedSelectedLODIndex;
    lastPresentationMode = savedPresentationMode;
    lastPresentationColumnCount = savedPresentationColumnCount;
    lastPresentationVertexCount = savedPresentationVertexCount;
    lastPresentationQueryVisits = savedPresentationQueryVisits;
    lastPresentationLargestBucket = savedPresentationLargestBucket;
    lastPresentationGridDelta = savedPresentationGridDelta;
    presentationResolvedGridDelta = savedPresentationResolvedGridDelta;
    presentationResolvedRangeGridDelta = savedPresentationResolvedRangeGridDelta;

    ctx.restore();
    state.rangePreviewValid = true;
  }

  function drawRangeSelector(ctx: RenderContext2D) {
    if (!dataX || dataLength === 0) return;

    if (!state.rangePreviewValid) renderRangePreview();

    if (state.rangePreviewCanvas) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(state.rangePreviewCanvas as CanvasImageSource, 0, state.rangeTop * state.dpr);
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    }

    drawRangeSelectorOverlay(ctx, state);
  }

  function handleMessage(type: string, data: Record<string, any>): void {
    if (type === "stop") {
      stopRenderer();
      return;
    }

    if (type === "start") {
      stopped = false;
    }

    if (type === "updateAppearance") {
      const patch = data.patch as Record<string, any>;
      if (patch.legend) legend.patchConfig(patch.legend);
      if (patch.marker) {
        const merged = { ...seriesConfig.chartMarker } as Record<string, any>;
        rendererDeepMerge(merged, patch.marker);
        seriesConfig.chartMarker = merged as MarkerOptions;
        resetMarkerCache();
      }
    }

    if (type === "updateSeriesAppearance") {
      const index = data.index as number;
      const patch = data.patch as Record<string, any>;
      if (Number.isInteger(index) && index >= 0) {
        const wasStacked =
          index < seriesConfig.count && isStackedAreaSeriesType(getSeriesType(index));
        while (seriesConfig.options.length <= index) seriesConfig.options.push({});
        const current = (seriesConfig.options[index] ?? {}) as Record<string, any>;
        rendererDeepMerge(current, patch);
        seriesConfig.options[index] = current as SeriesOptions;
        // Measured legend items retain the series label and colour, so any
        // appearance update must advance the scalar cache revision.
        legend.invalidateMeasurements();
        gradientDefinitionRevision++;
        gradientCache.clear();
        const isStacked =
          index < seriesConfig.count && isStackedAreaSeriesType(getSeriesType(index));
        if (wasStacked !== isStacked) {
          rebuildStackedBoundsIndex();
          rebuildStreamingBoundsIndex();
        }
        if (patch.marker) resetMarkerCache();
        presentationResolvedRangeGridDelta = NaN;
        state.cacheValid = false;
        state.rangePreviewValid = false;
        resetCachedYMinMax();
      }
      scheduleRender();
      return;
    }

    if (type === "setLODConfig") {
      const lod = data.lod;
      if (lod && typeof lod === "object") {
        if (lod.mode === "adaptive" || lod.mode === "pyramid") {
          hierarchicalPresentationLOD = lod.mode === "adaptive";
        }
        presentationColumnsPerCssPixel = resolvePresentationDensity(
          lod.density,
          presentationColumnsPerCssPixel,
        );
        presentationRebaseRatio = resolvePresentationRebaseRatio(
          lod.rebaseRatio,
          presentationRebaseRatio,
        );
        presentationQuantizationStep = resolvePresentationQuantizationStep(
          lod.quantizationStep,
          presentationQuantizationStep,
        );
        resetPresentationGridState();
        state.cacheValid = false;
        state.rangePreviewValid = false;
        scheduleRender();
      }
      return;
    }

    const previousViewportXMin = state.viewport.xMin;
    const previousViewportXMax = state.viewport.xMax;
    const viewportRequestId = readViewportRequestId(type, data);
    if (viewportRequestId !== undefined) pendingViewportRequestId = undefined;
    if (handleBaseMessage(state, type, data, minRange)) {
      const viewportChanged =
        state.viewport.xMin !== previousViewportXMin ||
        state.viewport.xMax !== previousViewportXMax;
      // Instant viewport commands update state before a render frame. Sync them
      // here; animated commands are emitted by render as their values advance.
      if (viewportChanged) {
        emitViewportSync(viewportRequestId);
      } else if (viewportRequestId !== undefined) {
        if (state.viewportAnimation.active) {
          pendingViewportRequestId = viewportRequestId;
        } else {
          emitViewportSync(viewportRequestId);
        }
      }
      if (type === "resize") {
        gradientCache.clear();
        render(performance.now());
      } else {
        scheduleRender();
      }
      return;
    }

    switch (type) {
      case "init": {
        state.canvas = data.canvas as CanvasLike;
        state.dpr = data.dpr || 1;
        const config = data.config || {};
        const lod = config.lod;
        if (lod && typeof lod === "object") {
          hierarchicalPresentationLOD = lod.mode !== "pyramid";
          presentationColumnsPerCssPixel = resolvePresentationDensity(
            lod.density,
            DEFAULT_PUBLIC_PRESENTATION_COLUMNS_PER_CSS_PIXEL,
          );
          presentationRebaseRatio = resolvePresentationRebaseRatio(lod.rebaseRatio);
          presentationQuantizationStep = resolvePresentationQuantizationStep(lod.quantizationStep);
          resetPresentationGridState();
        }
        minRange = resolveMinViewportRange(config.minViewportRange, LINE_MIN_RANGE);
        yDomain = resolveYDomain(config.yDomain);
        applyPadding(state, config);
        savePaddingBase(state);
        parseTextDirectionConfig(state, config);
        if ("animated" in config) state.animated = config.animated ?? true;
        if ("interpolation" in config) interpolation = config.interpolation ?? "linear";
        if ("seriesOptions" in config) {
          seriesConfig.options = config.seriesOptions ?? [];
          gradientDefinitionRevision++;
          gradientCache.clear();
        }
        if ("marker" in config) seriesConfig.chartMarker = config.marker ?? {};
        legend.parseConfig(config);
        resetMarkerCache();
        // Grid customization
        if (config.grid) parseGridConfig(state, config.grid);
        // Axis customization
        if (config.axis) {
          parseAxisConfig(state, config.axis);
          const units = parseAxisCursorUnits(config.axis);
          if (units.leftExplicit) {
            state.leftAxisLabelUnit = units.left!;
            leftAxisUnitExplicit = true;
          } else {
            leftAxisUnitExplicit = false;
          }
          if (units.rightExplicit) {
            state.rightAxisLabelUnit = units.right!;
            rightAxisUnitExplicit = true;
          } else {
            rightAxisUnitExplicit = false;
          }
          if (units.bottomExplicit) {
            state.bottomAxisLabelUnit = units.bottom!;
          }
          if (units.topExplicit) {
            state.topAxisLabelUnit = units.top!;
          }
        }
        // Auto-default cursor label units from first series when not explicit
        const firstSeriesUnit = seriesConfig.options[0]?.unit ?? null;
        if (!leftAxisUnitExplicit) state.leftAxisLabelUnit = firstSeriesUnit;
        if (!rightAxisUnitExplicit) state.rightAxisLabelUnit = firstSeriesUnit;
        // Tooltip customization
        if (config.tooltip) parseTooltipConfig(state, config.tooltip);
        // Crosshair style customization
        if (config.crosshairStyle) parseCrosshairStyle(state, config.crosshairStyle);
        // Background customization
        if (config.chartBackground) replaceChartBackground(state, config.chartBackground);
        // Range selector config
        parseRangeSelectorConfig(state, config);
        // Selection range styling
        parseSelectionConfig(state, config);
        // Labels config
        if (config.labels) parseLabelsConfig(state, config.labels);
        // Overlay primitives config
        if (config.overlay) parseOverlayConfig(state, config.overlay);
        state.ctx = get2dContext(state.canvas, { alpha: false });
        // Measure label space and adjust padding (must be after applyPadding and ctx creation)
        measureLabelSpace(state);
        state.updateDimensions();
        legend.postLayoutIfChanged();
        callbacks.postMessage({ type: "ready" });
        // Don't schedule render - no data yet
        break;
      }

      case "setData":
        setData(data.x, data.series, data.dataVersion, data.preservePreviousFrame === true);
        scheduleRender();
        break;

      case "initRingBuffer":
        initRingBuffer(data.maxPoints, data.seriesCount, data.dataVersion);
        // Don't schedule render - start message will come after
        break;

      case "addDataPoints":
        addDataPoints(data.timestamps, data.valuesBySeries);
        scheduleRender();
        break;

      case "setSeriesVisible":
        if (setSeriesVisibilityValue(data.index as number, Boolean(data.visible), "api")) {
          scheduleRender();
        }
        break;

      case "toggleSeriesVisibility": {
        const index = data.index as number;
        if (setSeriesVisibilityValue(index, !isSeriesVisible(index), "api")) {
          scheduleRender();
        }
        break;
      }

      case "setVisibleSeries":
        if (setVisibleSeriesIndices(data.indices, "api")) {
          scheduleRender();
        }
        break;

      case "legendClick": {
        const x = typeof data.x === "number" ? data.x : NaN;
        const y = typeof data.y === "number" ? data.y : NaN;
        if (Number.isFinite(x) && Number.isFinite(y) && legend.handleClick(x, y)) {
          scheduleRender();
        }
        break;
      }

      case "setStatsConfig":
        applyStatsConfigFromMessage(stats, data);
        break;

      case "tooltipContent": {
        handleTooltipContentMessage(state, data, getSeriesColor);
        scheduleRender();
        break;
      }
    }
  }

  function readViewportRequestId(type: string, data: Record<string, any>): number | undefined {
    if (
      type !== "zoom" &&
      type !== "zoomAnimated" &&
      type !== "pan" &&
      type !== "panAnimated" &&
      type !== "reset" &&
      type !== "resetAnimated" &&
      type !== "setViewportRange" &&
      type !== "setViewportRangeAnimated"
    ) {
      return undefined;
    }
    const value = data.viewportRequestId;
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : undefined;
  }

  const engine: LineChartEngine = {
    handleMessage,
    getMarkerConfig: getSeriesMarker,
  };
  Object.defineProperty(engine, Symbol.for("sixtyfold:test:line-engine-state"), {
    value: state,
  });
  return engine;
}
