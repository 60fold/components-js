// Base Renderer - shared infrastructure for chart rendering
// Used by both worker and main-thread rendering paths

import type { RenderContext2D } from "./types.js";
export type { RenderContext2D } from "./types.js";

export type CanvasLike =
  | HTMLCanvasElement
  | OffscreenCanvas
  | {
      width: number;
      height: number;
      getContext: (
        type: "2d",
        options?: CanvasRenderingContext2DSettings,
      ) => RenderContext2D | null;
    };

import {
  PADDING,
  RANGE_HEIGHT,
  RANGE_HANDLE_WIDTH,
  COLORS,
  ANIMATION,
  DASH_PATTERNS,
  DEFAULT_CURSOR_LABEL_COLOR,
  DEFAULT_CHART_FONT_FAMILY,
} from "../chart/chartConstants.js";
import {
  calculateStep,
  calculateTimeStep,
  formatTimeLabel,
  ensurePositiveSpan,
} from "../chart/chartUtils.js";
import type { TimeFormatOptions } from "../chart/chartUtils.js";
import type { UnitOptions, TextDirection, TextAlign } from "../types/units.js";
import { formatValue } from "../types/units.js";
import type {
  GradientOptions,
  ImageOptions,
  BackgroundOptions,
  CrosshairOptions,
} from "../types/chart.js";
import type { TooltipContent, StockTooltipField } from "../types/tooltip.js";

export { PADDING, RANGE_HEIGHT, RANGE_HANDLE_WIDTH, COLORS, DASH_PATTERNS };

type ViewportInputCommand =
  { type: "pan"; dx: number } | { type: "zoom"; factor: number; centerX: number };
export type { UnitOptions, FontStyle, TextDirection, TextAlign } from "../types/units.js";
export { formatValue } from "../types/units.js";
export type { TooltipContent, StockTooltipField } from "../types/tooltip.js";
export type {
  GradientOptions,
  ImageOptions,
  BackgroundOptions,
  CrosshairLineStyle,
  CrosshairOptions,
} from "../types/chart.js";

/** X-axis format type */
export type XAxisFormat = "time" | "number" | TimeFormatOptions | UnitOptions;

/** Default values for crosshair lines */
export const CROSSHAIR_DEFAULTS: {
  color: string;
  style: "solid" | "dashed" | "dotted";
  visible: boolean;
} = {
  color: "rgba(255, 255, 255, 0.3)",
  style: "dashed",
  visible: true,
};

// Viewport and bounds
export interface Viewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface Bounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

type OverlayCoordUnit = "ratio" | "px";
type OverlayRelativeTo = "chart" | "canvas";
type OverlayXAnchor = "left" | "right";
type OverlayYAnchor = "top" | "bottom";

interface OverlayItemBaseState {
  kind: "text" | "rect" | "circle" | "line" | "image";
  visible: boolean;
  z: number;
  opacity: number;
  x: number;
  y: number;
  xUnit: OverlayCoordUnit;
  yUnit: OverlayCoordUnit;
  xAnchor: OverlayXAnchor;
  yAnchor: OverlayYAnchor;
  relativeTo: OverlayRelativeTo;
  rotate: number;
}

interface OverlayTextItemState extends OverlayItemBaseState {
  kind: "text";
  text: string;
  fontSize: number;
  fontWeight: string | number;
  fontColor: string;
  fontFamily: string;
  align: TextAlign;
  baseline: "top" | "middle" | "bottom";
  direction: TextDirection;
  maxWidth?: number;
}

interface OverlayRectItemState extends OverlayItemBaseState {
  kind: "rect";
  width: number;
  height: number;
  radius: number;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth: number;
  strokeDash: number[];
}

interface OverlayCircleItemState extends OverlayItemBaseState {
  kind: "circle";
  radius: number;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth: number;
  strokeDash: number[];
}

interface OverlayLineItemState extends OverlayItemBaseState {
  kind: "line";
  x2: number;
  y2: number;
  x2Unit: OverlayCoordUnit;
  y2Unit: OverlayCoordUnit;
  x2Anchor: OverlayXAnchor;
  y2Anchor: OverlayYAnchor;
  strokeColor: string;
  strokeWidth: number;
  strokeDash: number[];
}

interface OverlayImageItemState extends OverlayItemBaseState {
  kind: "image";
  image: CanvasImageSource;
  width: number;
  height: number;
  fit: "fill" | "contain" | "cover";
  ownsImageBitmap: boolean;
}

type OverlayItemState =
  | OverlayTextItemState
  | OverlayRectItemState
  | OverlayCircleItemState
  | OverlayLineItemState
  | OverlayImageItemState;

/** Callbacks for engine → host communication (worker postMessage or direct calls) */
export interface EngineCallbacks {
  postMessage(message: Record<string, unknown>): void;
  /**
   * Report an exception raised by renderer-owned asynchronous work.
   *
   * Worker engines may omit this callback because an uncaught exception already
   * reaches the worker error boundary. The main-thread fallback supplies it so
   * requestAnimationFrame and timer failures use the same host-visible channel.
   */
  reportError?(error: unknown): void;
}

/** Shared stats emission configuration/state for chart renderers */
export interface StatsState {
  enabled: boolean;
  intervalMs: number;
  nextEmitAt: number;
}

export const MIN_STATS_INTERVAL_MS = 16;
export const DEFAULT_STATS_INTERVAL_MS = 250;

export function createStatsState(): StatsState {
  return {
    enabled: false,
    intervalMs: DEFAULT_STATS_INTERVAL_MS,
    nextEmitAt: 0,
  };
}

/** Apply partial stats config message.
 * - `enabled` omitted: keep previous enabled state
 * - `intervalMs` omitted/invalid: keep previous interval
 */
export function applyStatsConfigFromMessage(
  stats: StatsState,
  data: Record<string, unknown>,
): void {
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(data, "enabled")) {
    stats.enabled = Boolean(data.enabled);
    changed = true;
  }

  if (
    Object.prototype.hasOwnProperty.call(data, "intervalMs") &&
    typeof data.intervalMs === "number" &&
    Number.isFinite(data.intervalMs)
  ) {
    stats.intervalMs = Math.max(MIN_STATS_INTERVAL_MS, data.intervalMs);
    changed = true;
  }

  if (changed) {
    // Allow immediate emission after config changes (or disable takes effect immediately).
    stats.nextEmitAt = 0;
  }
}

export function shouldEmitStats(stats: StatsState, timestamp: number): boolean {
  if (!stats.enabled) return false;
  if (stats.nextEmitAt !== 0 && timestamp < stats.nextEmitAt) return false;
  stats.nextEmitAt = timestamp + stats.intervalMs;
  return true;
}

export function get2dContext(
  canvas: CanvasLike,
  options?: CanvasRenderingContext2DSettings,
): RenderContext2D {
  const ctx = canvas.getContext(
    "2d",
    options as CanvasRenderingContext2DSettings,
  ) as RenderContext2D | null;
  if (!ctx) throw new Error("Failed to acquire 2D rendering context.");
  return ctx;
}

export type ResolvedTextDirection = "ltr" | "rtl" | "inherit";

const RTL_STRONG_CHAR_RE = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
const LTR_STRONG_CHAR_RE = /[A-Za-z\u00C0-\u02AF\u0370-\u052F\u1E00-\u1EFF]/;

function parseTextDirection(value: unknown): TextDirection {
  return value === "ltr" || value === "rtl" || value === "auto" || value === "inherit"
    ? value
    : "inherit";
}

export function parseTextDirectionConfig(
  state: WorkerState,
  config: Record<string, unknown>,
): void {
  if ("textDirection" in config) {
    state.textDirection = parseTextDirection(config.textDirection);
  }
}

export function resolveCanvasTextDirection(
  direction: TextDirection,
  text = "",
): ResolvedTextDirection {
  if (direction === "ltr" || direction === "rtl") return direction;
  if (direction !== "auto") return "inherit";

  for (const char of text) {
    if (RTL_STRONG_CHAR_RE.test(char)) return "rtl";
    if (LTR_STRONG_CHAR_RE.test(char)) return "ltr";
  }
  return "inherit";
}

export function applyCanvasTextDirection(
  ctx: RenderContext2D,
  state: WorkerState,
  text = "",
  direction: TextDirection = state.textDirection,
): ResolvedTextDirection {
  const resolved = resolveCanvasTextDirection(direction, text);
  (ctx as CanvasRenderingContext2D).direction = resolved;
  return resolved;
}

export function isRtlTextDirection(direction: ResolvedTextDirection): boolean {
  return direction === "rtl";
}

export function resolveCanvasTextAlign(
  align: TextAlign,
  direction: ResolvedTextDirection,
): CanvasTextAlign {
  if (align === "start") return isRtlTextDirection(direction) ? "right" : "left";
  if (align === "end") return isRtlTextDirection(direction) ? "left" : "right";
  return align;
}

function resolveLogicalEdgeX(
  align: TextAlign,
  direction: ResolvedTextDirection,
  left: number,
  right: number,
): number {
  if (align === "center") return (left + right) / 2;
  if (align === "start") return isRtlTextDirection(direction) ? right : left;
  if (align === "end") return isRtlTextDirection(direction) ? left : right;
  return align === "right" ? right : left;
}

function writeTextInsideBox(
  ctx: RenderContext2D,
  state: WorkerState,
  text: string,
  x: number,
  y: number,
  width: number,
  inset: number,
  direction: TextDirection = state.textDirection,
): void {
  const resolved = applyCanvasTextDirection(ctx, state, text, direction);
  if (isRtlTextDirection(resolved)) {
    ctx.textAlign = "right";
    ctx.fillText(text, x + width - inset, y);
  } else {
    ctx.textAlign = "left";
    ctx.fillText(text, x + inset, y);
  }
}

// Base worker state
export class WorkerState {
  canvas: CanvasLike | null = null;
  ctx: RenderContext2D | null = null;
  dpr = 1;

  // Cache
  cacheCanvas: CanvasLike | null = null;
  cacheCtx: RenderContext2D | null = null;
  cacheValid = false;
  lastViewport: Viewport = { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };

  // Range preview cache
  rangePreviewCanvas: CanvasLike | null = null;
  rangePreviewCtx: RenderContext2D | null = null;
  rangePreviewValid = false;

  // Canvas factory (overridden for main-thread rendering)
  createCanvas: (w: number, h: number) => CanvasLike = (w, h) => new OffscreenCanvas(w, h);

  // Viewport
  viewport: Viewport = { xMin: 0, xMax: 1, yMin: 0, yMax: 100 };
  dataBounds: Bounds = { xMin: 0, xMax: 1, yMin: 0, yMax: 100 };

  // Mouse
  mouseX = -1;
  mouseY = -1;
  mouseInChart = false;
  pointerType: "mouse" | "touch" = "mouse";

  // Selection
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  selectionColor = COLORS.selection;
  selectionBorderColor = COLORS.selectionBorder;
  selectionBorderWidth = 2;
  selectionBorderStyle: "solid" | "dashed" | "dotted" = "dashed";

  // Animation
  rafId: number | null = null;
  fps = 0;
  frameCount = 0;
  fpsUpdateTime = 0;

  // Performance
  dataLoadStartTime = 0;
  firstRenderTime = 0;
  isFirstRender = true;
  frameTime = 0;

  // Instance padding (replaces global PADDING — safe for multi-chart main-thread use)
  padding = {
    top: PADDING.top,
    right: PADDING.right,
    bottom: PADDING.bottom,
    left: PADDING.left,
  };
  // Options
  showRangeSelector = true;
  rangeSelectorWidth: "plot" | "canvas" = "plot";
  rangeSelectorPosition: "top" | "bottom" = "bottom";
  textDirection: TextDirection = "inherit";
  showLeftAxis = true;
  showRightAxis = false;
  showLeftAxisLabel = false;
  showRightAxisLabel = false;
  leftAxisLabelColor = DEFAULT_CURSOR_LABEL_COLOR;
  rightAxisLabelColor = DEFAULT_CURSOR_LABEL_COLOR;
  leftAxisLabelFontColor = "#ffffff";
  leftAxisLabelFontSize = 11;
  leftAxisLabelFontWeight: string | number = "normal";
  leftAxisLabelFontFamily = DEFAULT_CHART_FONT_FAMILY;
  rightAxisLabelFontColor = "#ffffff";
  rightAxisLabelFontSize = 11;
  rightAxisLabelFontWeight: string | number = "normal";
  rightAxisLabelFontFamily = DEFAULT_CHART_FONT_FAMILY;
  leftAxisLabelUnit: UnitOptions | null = null;
  rightAxisLabelUnit: UnitOptions | null = null;
  showBottomAxisLabel = false;
  bottomAxisLabelColor = DEFAULT_CURSOR_LABEL_COLOR;
  bottomAxisLabelFontColor = "#ffffff";
  bottomAxisLabelFontSize = 11;
  bottomAxisLabelFontWeight: string | number = "normal";
  bottomAxisLabelFontFamily = DEFAULT_CHART_FONT_FAMILY;
  bottomAxisLabelUnit: UnitOptions | null = null;
  showTopAxisLabel = false;
  topAxisLabelColor = DEFAULT_CURSOR_LABEL_COLOR;
  topAxisLabelFontColor = "#ffffff";
  topAxisLabelFontSize = 11;
  topAxisLabelFontWeight: string | number = "normal";
  topAxisLabelFontFamily = DEFAULT_CHART_FONT_FAMILY;
  topAxisLabelUnit: UnitOptions | null = null;
  animated = true;

  // Animation state
  revealProgress = 0; // 0-1 for initial data reveal
  revealStartTime = 0;
  viewportAnimation: {
    active: boolean;
    startTime: number;
    duration: number;
    fromViewport: Viewport;
    toViewport: Viewport;
  } = {
    active: false,
    startTime: 0,
    duration: ANIMATION.viewportResetDuration,
    fromViewport: { xMin: 0, xMax: 1, yMin: 0, yMax: 100 },
    toViewport: { xMin: 0, xMax: 1, yMin: 0, yMax: 100 },
  };

  // Y-axis animation state
  yAnimation: {
    active: boolean;
    startTime: number;
    duration: number;
    fromYMin: number;
    fromYMax: number;
    toYMin: number;
    toYMax: number;
  } = {
    active: false,
    startTime: 0,
    duration: ANIMATION.yAxisDuration,
    fromYMin: 0,
    fromYMax: 100,
    toYMin: 0,
    toYMax: 100,
  };

  // Grid value opacity tracking (for fade in/out animations)
  xGridAlphas: Map<number, number> = new Map(); // value -> alpha
  yGridAlphas: Map<number, number> = new Map(); // value -> alpha

  // Grid customization
  gridColor = COLORS.grid;
  gridLineWidth = 0.5;
  gridVerticalVisible = true;
  gridHorizontalVisible = true;
  // Cached RGB values for grid color (avoid parsing every frame)
  private _gridRgb: { r: number; g: number; b: number } | null = null;
  private _gridColorCached = "";

  getGridRgb(): { r: number; g: number; b: number } {
    if (this._gridColorCached !== this.gridColor) {
      this._gridColorCached = this.gridColor;
      const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(this.gridColor);
      this._gridRgb = result
        ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16),
          }
        : { r: 45, g: 74, b: 124 };
    }
    return this._gridRgb!;
  }

  // Axis customization
  axisColor = COLORS.axes;
  bottomAxisWidth = 1;
  topAxisWidth = 1;
  leftAxisWidth = 1;
  rightAxisWidth = 1;
  bottomAxisTickColor = "";
  bottomAxisTickWidth = 1;
  bottomAxisTickLength = 0;
  topAxisTickColor = "";
  topAxisTickWidth = 1;
  topAxisTickLength = 0;
  leftAxisTickColor = "";
  leftAxisTickWidth = 1;
  leftAxisTickLength = 0;
  rightAxisTickColor = "";
  rightAxisTickWidth = 1;
  rightAxisTickLength = 0;
  showBottomAxis = true;
  showTopAxis = false;
  // Bottom X-axis format: "time" | "number" | UnitOptions
  bottomAxisFormat: XAxisFormat = "time";
  // Bottom X-axis label font settings
  bottomXLabelColor = COLORS.gridText;
  bottomXLabelFontSize = 11;
  bottomXLabelFontWeight: string | number = "normal";
  bottomXLabelFontFamily = DEFAULT_CHART_FONT_FAMILY;
  // Top X-axis format: "time" | "number" | UnitOptions
  topAxisFormat: XAxisFormat = "time";
  // Top X-axis label font settings
  topXLabelColor = COLORS.gridText;
  topXLabelFontSize = 11;
  topXLabelFontWeight: string | number = "normal";
  topXLabelFontFamily = DEFAULT_CHART_FONT_FAMILY;
  // Left Y-axis label font settings
  leftYLabelColor = COLORS.gridText;
  leftYLabelFontSize = 11;
  leftYLabelFontWeight: string | number = "normal";
  leftYLabelFontFamily = DEFAULT_CHART_FONT_FAMILY;
  // Right Y-axis label font settings
  rightYLabelColor = COLORS.gridText;
  rightYLabelFontSize = 11;
  rightYLabelFontWeight: string | number = "normal";
  rightYLabelFontFamily = DEFAULT_CHART_FONT_FAMILY;
  // Y-axis tick label format (null = use formatY callback default)
  leftYFormat: UnitOptions | null = null;
  rightYFormat: UnitOptions | null = null;
  // Tooltip customization
  tooltipBackgroundColor = "rgba(22, 33, 62, 0.95)";
  tooltipBorderColor = "#4a6fa1";
  tooltipBorderWidth = 1;
  tooltipBorderRadius = 0;
  tooltipBorderStyle: "solid" | "dashed" | "dotted" = "solid";
  tooltipPosition:
    | "cursor-top"
    | "cursor-bottom"
    | "cursor"
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right" = "cursor-top";
  // Tooltip font customization
  tooltipTitleFontSize = 12;
  tooltipTitleFontWeight: string | number = "bold";
  tooltipTitleFontColor = "#aaa";
  tooltipTitleFontFamily = DEFAULT_CHART_FONT_FAMILY;
  tooltipLabelFontSize = 12;
  tooltipLabelFontWeight: string | number = "normal";
  tooltipLabelFontColor = "#eee";
  tooltipLabelFontFamily = DEFAULT_CHART_FONT_FAMILY;
  tooltipValueFontSize = 12;
  tooltipValueFontWeight: string | number = "bold";
  tooltipValueFontColor = ""; // empty = use series color
  tooltipValueFontFamily = DEFAULT_CHART_FONT_FAMILY;
  tooltipDirection: TextDirection = "inherit";
  tooltipShowSwatch = true;
  tooltipPaddingTop = 8;
  tooltipPaddingRight = 8;
  tooltipPaddingBottom = 8;
  tooltipPaddingLeft = 8;
  tooltipBackdropBlur = 0;
  tooltipShadowEnabled = false;
  tooltipShadowColor = "rgba(0, 0, 0, 0.18)";
  tooltipShadowBlur = 8;
  tooltipShadowOffsetX = 0;
  tooltipShadowOffsetY = 2;
  tooltipBackdropCanvas: CanvasLike | null = null;
  tooltipBackdropCtx: RenderContext2D | null = null;
  canvasFilterSupported: boolean | null = null; // lazy-detected
  tooltipCandleBorder = false;
  tooltipFields: string[] | null = null; // null = show all (stock chart)
  tooltipVisibleSeries: number[] | null = null; // null = show all (line chart)
  tooltipTitleFormat: XAxisFormat | null = null; // null = auto-detect from data
  // Custom tooltip content (from onRender callback)
  tooltipCustomContent: TooltipContent | null = null;
  tooltipHasCallback = false;
  tooltipLastDataX = NaN;
  tooltipFixedWidth = 0; // 0 = auto (ratchet mode)
  tooltipRatchetWidth = 0; // high-water mark for stable tooltip width
  stockTooltipFieldLabels: Partial<Record<StockTooltipField, string>> = {};
  // Crosshair lines customization
  crosshairVerticalColor = CROSSHAIR_DEFAULTS.color;
  crosshairVerticalStyle: "solid" | "dashed" | "dotted" = CROSSHAIR_DEFAULTS.style;
  crosshairVerticalVisible = CROSSHAIR_DEFAULTS.visible;
  crosshairHorizontalColor = CROSSHAIR_DEFAULTS.color;
  crosshairHorizontalStyle: "solid" | "dashed" | "dotted" = CROSSHAIR_DEFAULTS.style;
  crosshairHorizontalVisible = CROSSHAIR_DEFAULTS.visible;

  // Background customization
  chartBackground: string | GradientOptions | ImageOptions = COLORS.background;

  // Range selector style
  rangeBorderRadius = 4;
  rangeOverlayColor = COLORS.rangeOverlay;
  rangeHandleColor = "#4a90d9";
  rangeGripColor = "#fff";
  rangeHandleBorderRadius = 2;
  rangeBorderColor = COLORS.rangeBorder;
  rangeSelectorHeight = RANGE_HEIGHT;
  rangeSelectorGap = 0;
  rangeSelectorEffect: "none" | "glass" = "none";

  // Chart labels
  labelTopText = "";
  labelTopFontSize = 16;
  labelTopFontWeight: string | number = "bold";
  labelTopFontColor = "#ffffff";
  labelTopFontFamily = DEFAULT_CHART_FONT_FAMILY;
  labelTopAlign: TextAlign = "center";
  labelTopDirection: TextDirection = "inherit";
  labelTopPad = { top: 6, right: 6, bottom: 6, left: 6 };

  labelBottomText = "";
  labelBottomFontSize = 12;
  labelBottomFontWeight: string | number = "normal";
  labelBottomFontColor = "#6b8cae";
  labelBottomFontFamily = DEFAULT_CHART_FONT_FAMILY;
  labelBottomAlign: TextAlign = "center";
  labelBottomDirection: TextDirection = "inherit";
  labelBottomPad = { top: 6, right: 6, bottom: 6, left: 6 };

  labelLeftText = "";
  labelLeftFontSize = 12;
  labelLeftFontWeight: string | number = "normal";
  labelLeftFontColor = "#6b8cae";
  labelLeftFontFamily = DEFAULT_CHART_FONT_FAMILY;
  labelLeftAlign: "top" | "middle" | "bottom" = "middle";
  labelLeftDirection: TextDirection = "inherit";
  labelLeftPad = { top: 6, right: 6, bottom: 6, left: 6 };

  labelRightText = "";
  labelRightFontSize = 12;
  labelRightFontWeight: string | number = "normal";
  labelRightFontColor = "#6b8cae";
  labelRightFontFamily = DEFAULT_CHART_FONT_FAMILY;
  labelRightAlign: "top" | "middle" | "bottom" = "middle";
  labelRightDirection: TextDirection = "inherit";
  labelRightPad = { top: 6, right: 6, bottom: 6, left: 6 };

  // Custom free-form labels
  customLabels: Array<{
    text: string;
    x: number;
    y: number;
    fontSize: number;
    fontWeight: string | number;
    fontColor: string;
    fontFamily: string;
    align: TextAlign;
    baseline: "top" | "middle" | "bottom";
    direction: TextDirection;
    rotate: number;
    relativeTo: "chart" | "canvas";
  }> = [];

  // Declarative overlay primitives (text/shapes/lines)
  overlayItems: OverlayItemState[] = [];
  ownedImageBitmapRefCounts = new Map<object, number>();

  // Measured space reserved by labels (pixels)
  labelTopSpace = 0;
  labelBottomSpace = 0;
  labelLeftSpace = 0;
  labelRightSpace = 0;

  // Base padding snapshot (before label space is added)
  paddingBase = { top: 0, right: 0, bottom: 0, left: 0 };

  // Dimensions (calculated)
  width = 0;
  height = 0;
  chartWidth = 0;
  chartHeight = 0;
  chartTop = 0;
  rangeTop = 0;

  updateDimensions(): void {
    if (!this.canvas) return;

    this.width = this.canvas.width / this.dpr;
    this.height = this.canvas.height / this.dpr;
    this.chartWidth = Math.floor(this.width - this.padding.left - this.padding.right);
    const rangeArea = this.showRangeSelector ? this.rangeSelectorGap + this.rangeSelectorHeight : 0;
    this.chartHeight = this.height - this.padding.top - this.padding.bottom - rangeArea;

    if (this.rangeSelectorPosition === "top" && this.showRangeSelector) {
      this.rangeTop = this.padding.top;
      this.chartTop = this.padding.top + this.rangeSelectorHeight + this.rangeSelectorGap;
    } else {
      this.rangeTop = this.height - this.rangeSelectorHeight;
      this.chartTop = this.padding.top;
    }
  }

  viewportChanged(): boolean {
    return (
      this.viewport.xMin !== this.lastViewport.xMin ||
      this.viewport.xMax !== this.lastViewport.xMax ||
      this.viewport.yMin !== this.lastViewport.yMin ||
      this.viewport.yMax !== this.lastViewport.yMax
    );
  }

  ensureCache(): void {
    if (!this.canvas) return;

    if (
      !this.cacheCanvas ||
      this.cacheCanvas.width !== this.canvas.width ||
      this.cacheCanvas.height !== this.canvas.height
    ) {
      this.cacheCanvas = this.createCanvas(this.canvas.width, this.canvas.height);
      this.cacheCtx = get2dContext(this.cacheCanvas, { alpha: false });
      this.cacheCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.cacheValid = false;
    }
  }

  saveViewport(): void {
    this.lastViewport = { ...this.viewport };
  }
}

export function drawBackground(
  ctx: RenderContext2D,
  background: BackgroundOptions,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (typeof background === "string") {
    ctx.fillStyle = background;
    ctx.fillRect(x, y, width, height);
  } else if (background.type === "gradient") {
    const colors = background.colors;
    if (colors.length === 0) return;
    if (colors.length === 1) {
      ctx.fillStyle = colors[0];
      ctx.fillRect(x, y, width, height);
      return;
    }

    const gradient =
      background.direction === "vertical"
        ? ctx.createLinearGradient(x, y, x, y + height)
        : ctx.createLinearGradient(x, y, x + width, y);

    const offsets = background.offsets;
    for (let i = 0; i < colors.length; i++) {
      const rawOffset = offsets ? offsets[i] : i / (colors.length - 1);
      const offset = Number.isFinite(rawOffset)
        ? Math.max(0, Math.min(1, rawOffset))
        : i / (colors.length - 1);
      // See lineRenderer: an unparseable stop must not tear down the renderer.
      try {
        gradient.addColorStop(offset, colors[i]);
      } catch {
        // Unparseable stop; the remaining stops still define the gradient.
      }
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, width, height);
  } else if (background.type === "image") {
    const img = background.image;
    const fit = background.fit ?? "cover";

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();

    if (fit === "fill") {
      ctx.drawImage(img, x, y, width, height);
    } else if (fit === "tile") {
      const pattern = ctx.createPattern(img, "repeat");
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(x, y, width, height);
      }
    } else {
      const imgRatio = img.width / img.height;
      const areaRatio = width / height;
      let drawWidth: number, drawHeight: number, drawX: number, drawY: number;

      if (
        (fit === "cover" && imgRatio < areaRatio) ||
        (fit === "contain" && imgRatio > areaRatio)
      ) {
        drawWidth = width;
        drawHeight = width / imgRatio;
        drawX = x;
        drawY = y + (height - drawHeight) / 2;
      } else {
        drawHeight = height;
        drawWidth = height * imgRatio;
        drawX = x + (width - drawWidth) / 2;
        drawY = y;
      }
      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
    }
    ctx.restore();
  }
}

/** Replace a renderer background, releasing an ImageBitmap owned by this renderer. */
export function replaceChartBackground(state: WorkerState, background: BackgroundOptions): void {
  const previous = state.chartBackground as ImageOptions & {
    __sixtyfoldOwnsImageBitmap?: boolean;
  };
  const next = background as ImageOptions & { __sixtyfoldOwnsImageBitmap?: boolean };
  const previousOwned =
    typeof previous === "object" &&
    previous.type === "image" &&
    previous.__sixtyfoldOwnsImageBitmap === true;
  const nextOwned =
    typeof next === "object" && next.type === "image" && next.__sixtyfoldOwnsImageBitmap === true;
  if (nextOwned && (!previousOwned || previous.image !== next.image)) {
    retainOwnedImageBitmap(state, next.image);
  }
  if (previousOwned && (!nextOwned || previous.image !== next.image)) {
    releaseOwnedImageBitmap(state, previous.image);
  }
  state.chartBackground = background;
}

function retainOwnedImageBitmap(state: WorkerState, image: object): void {
  state.ownedImageBitmapRefCounts.set(image, (state.ownedImageBitmapRefCounts.get(image) ?? 0) + 1);
}

function releaseOwnedImageBitmap(state: WorkerState, image: object): void {
  const nextCount = (state.ownedImageBitmapRefCounts.get(image) ?? 1) - 1;
  if (nextCount > 0) {
    state.ownedImageBitmapRefCounts.set(image, nextCount);
    return;
  }
  state.ownedImageBitmapRefCounts.delete(image);
  (image as { close?: () => void }).close?.();
}

export { colorCache, getCachedRgba, isOpaqueColor, normalizeColor } from "./colorCache.js";

// Reused because drawGrid is not reentrant and runs on every frame.
const gridScratchXValues = new Set<number>();
const gridScratchYValues = new Set<number>();

// Avoid overlapping tick labels during direct viewport input.
const gridSnapStates = new WeakSet<WorkerState>();

// Prevent a degenerate step from producing an unbounded tick loop.
const MAX_GRID_LINES = 10000;

export function drawGrid(ctx: RenderContext2D, state: WorkerState, useTimeAxis = false): void {
  const snapGridToViewport = gridSnapStates.has(state);
  ctx.lineWidth = state.gridLineWidth;

  const xRange = state.viewport.xMax - state.viewport.xMin;
  const xStep = useTimeAxis
    ? calculateTimeStep(xRange, state.chartWidth / 70, state.viewport.xMin)
    : calculateStep(xRange, state.chartWidth / 70);
  const canDrawXGrid =
    Number.isFinite(xRange) &&
    xRange > 0 &&
    Number.isFinite(state.chartWidth) &&
    state.chartWidth > 0 &&
    Number.isFinite(xStep) &&
    xStep > 0;

  const currentXValues = gridScratchXValues;
  currentXValues.clear();
  if (canDrawXGrid) {
    const firstXIndex = Math.ceil(state.viewport.xMin / xStep);
    for (let i = firstXIndex, n = 0; n < MAX_GRID_LINES; i++, n++) {
      const x = i * xStep;
      if (x > state.viewport.xMax) break;
      currentXValues.add(x);
    }
  }

  if (state.animated && !snapGridToViewport && canDrawXGrid) {
    for (const x of currentXValues) {
      const currentAlpha = state.xGridAlphas.get(x) ?? 0;
      state.xGridAlphas.set(x, Math.min(1, currentAlpha + ANIMATION.gridFadeSpeed));
    }
    for (const [x, alpha] of state.xGridAlphas) {
      if (!currentXValues.has(x)) {
        const newAlpha = alpha - ANIMATION.gridFadeSpeed;
        if (newAlpha <= 0) {
          state.xGridAlphas.delete(x);
        } else {
          state.xGridAlphas.set(x, newAlpha);
        }
      }
    }
  } else if (canDrawXGrid) {
    state.xGridAlphas.clear();
    for (const x of currentXValues) {
      state.xGridAlphas.set(x, 1);
    }
  } else {
    state.xGridAlphas.clear();
  }

  if (state.gridVerticalVisible && canDrawXGrid) {
    ctx.strokeStyle = state.gridColor;
    ctx.beginPath();
    for (const [x, alpha] of state.xGridAlphas) {
      ctx.globalAlpha = alpha;

      const screenX = state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;

      ctx.beginPath();
      ctx.moveTo(screenX, state.chartTop);
      ctx.lineTo(screenX, state.chartTop + state.chartHeight);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  const yRange = state.viewport.yMax - state.viewport.yMin;
  const yStep = calculateStep(yRange, state.chartHeight / 50);
  const canDrawYGrid =
    Number.isFinite(yRange) &&
    yRange > 0 &&
    Number.isFinite(state.chartHeight) &&
    state.chartHeight > 0 &&
    Number.isFinite(yStep) &&
    yStep > 0;

  const currentYValues = gridScratchYValues;
  currentYValues.clear();
  if (canDrawYGrid) {
    const firstYIndex = Math.ceil(state.viewport.yMin / yStep);
    for (let i = firstYIndex, n = 0; n < MAX_GRID_LINES; i++, n++) {
      const y = i * yStep;
      if (y > state.viewport.yMax) break;
      currentYValues.add(y);
    }
  }

  if (state.animated && !snapGridToViewport && canDrawYGrid) {
    for (const y of currentYValues) {
      const currentAlpha = state.yGridAlphas.get(y) ?? 0;
      state.yGridAlphas.set(y, Math.min(1, currentAlpha + ANIMATION.gridFadeSpeed));
    }
    for (const [y, alpha] of state.yGridAlphas) {
      if (!currentYValues.has(y)) {
        const newAlpha = alpha - ANIMATION.gridFadeSpeed;
        if (newAlpha <= 0) {
          state.yGridAlphas.delete(y);
        } else {
          state.yGridAlphas.set(y, newAlpha);
        }
      }
    }
  } else if (canDrawYGrid) {
    state.yGridAlphas.clear();
    for (const y of currentYValues) {
      state.yGridAlphas.set(y, 1);
    }
  } else {
    state.yGridAlphas.clear();
  }

  if (state.gridHorizontalVisible && canDrawYGrid) {
    ctx.strokeStyle = state.gridColor;
    for (const [y, alpha] of state.yGridAlphas) {
      ctx.globalAlpha = alpha;
      const screenY = state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;
      ctx.beginPath();
      ctx.moveTo(state.padding.left, screenY);
      ctx.lineTo(state.width - state.padding.right, screenY);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  ctx.globalAlpha = 1;
  gridSnapStates.delete(state);
}

/** Format tooltip title from a data X value.
 *  When format is null, auto-detects: values > 1e9 are treated as timestamps. */
export function formatTooltipTitle(value: number, format: XAxisFormat | null): string {
  if (format === "time" || isTimeFormatOptions(format) || (format === null && value > 1e9)) {
    const isMilliseconds = value > 1e11;
    const tsMs = isMilliseconds ? value : value * 1000;
    const timeOptions = isTimeFormatOptions(format) ? format : undefined;
    return new Date(tsMs).toLocaleString(
      timeOptions?.locale,
      buildIntlDateTimeOptions(timeOptions),
    );
  } else if (format === "number" || format === null) {
    return value.toFixed(0);
  } else {
    return formatValue(value, format, 0);
  }
}

function isTimeFormatOptions(format: XAxisFormat | null): format is TimeFormatOptions {
  return !!format && typeof format === "object" && (format as TimeFormatOptions).type === "time";
}

function buildIntlDateTimeOptions(
  options: TimeFormatOptions | undefined,
): Intl.DateTimeFormatOptions | undefined {
  if (!options?.timeZone && typeof options?.hour12 !== "boolean") return undefined;
  const out: Intl.DateTimeFormatOptions = {};
  if (options.timeZone) out.timeZone = options.timeZone;
  if (typeof options.hour12 === "boolean") out.hour12 = options.hour12;
  return out;
}

// Format X-axis label based on axis format
function formatXLabel(x: number, xRange: number, format: XAxisFormat): string {
  if (format === "time" || isTimeFormatOptions(format)) {
    return formatTimeLabel(x, xRange, isTimeFormatOptions(format) ? format : undefined);
  } else if (format === "number") {
    return x.toFixed(0);
  } else {
    // UnitOptions
    return formatValue(x, format, 0);
  }
}

function getGridLabelDecimalPlaces(gridValues: ReadonlyMap<number, number>): number {
  const values = [...gridValues.keys()].sort((left, right) => left - right);
  let minimumStep = Infinity;
  for (let index = 1; index < values.length; index++) {
    const first = values[index - 1];
    const second = values[index];
    const difference = second - first;
    const equalityTolerance = Math.max(1, Math.abs(first), Math.abs(second)) * 1e-12;
    if (difference > equalityTolerance && difference < minimumStep) {
      minimumStep = difference;
    }
  }
  if (!Number.isFinite(minimumStep)) return 1;

  // Keep the established single-decimal default for whole-number scales,
  // increasing precision only when the active grid step requires it.
  for (let decimals = 1; decimals <= 12; decimals++) {
    const scale = 10 ** decimals;
    const scaledStep = minimumStep * scale;
    if (Math.abs(scaledStep - Math.round(scaledStep)) <= Math.max(1, Math.abs(scaledStep)) * 1e-9) {
      return decimals;
    }
  }
  return 12;
}

export function drawAxes(
  ctx: RenderContext2D,
  state: WorkerState,
  formatY?: (y: number) => string,
  formatXOverride?: (x: number, xRange: number) => string,
): void {
  ctx.strokeStyle = state.axisColor;

  const chartBottom = state.chartTop + state.chartHeight;
  const chartRight = state.width - state.padding.right;

  const drawAxisLine = (x1: number, y1: number, x2: number, y2: number, width: number): void => {
    if (!(Number.isFinite(width) && width > 0)) return;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };

  if (state.showLeftAxis) {
    drawAxisLine(
      state.padding.left,
      state.chartTop,
      state.padding.left,
      chartBottom,
      state.leftAxisWidth,
    );
  }
  if (state.showBottomAxis) {
    drawAxisLine(state.padding.left, chartBottom, chartRight, chartBottom, state.bottomAxisWidth);
  }
  if (state.showTopAxis) {
    drawAxisLine(
      state.padding.left,
      state.chartTop,
      chartRight,
      state.chartTop,
      state.topAxisWidth,
    );
  }
  if (state.showRightAxis) {
    drawAxisLine(chartRight, chartBottom, chartRight, state.chartTop, state.rightAxisWidth);
  }

  // X axis labels
  const xRange = state.viewport.xMax - state.viewport.xMin;

  const drawTickSegmentsBatched = (
    segmentsByAlpha: Map<number, number[]>,
    width: number,
    color: string,
  ): void => {
    if (segmentsByAlpha.size === 0) return;
    if (!Number.isFinite(width) || width <= 0) return;
    ctx.strokeStyle = color || state.axisColor;
    ctx.lineWidth = width;
    for (const [alpha, coords] of segmentsByAlpha) {
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      for (let i = 0; i + 3 < coords.length; i += 4) {
        ctx.moveTo(coords[i], coords[i + 1]);
        ctx.lineTo(coords[i + 2], coords[i + 3]);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  const drawXAxisTicks = (
    y: number,
    direction: 1 | -1,
    length: number,
    width: number,
    color: string,
  ): void => {
    if (!Number.isFinite(length) || length <= 0) return;
    const segmentsByAlpha = new Map<number, number[]>();
    for (const [x, alpha] of state.xGridAlphas) {
      const screenX = state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
      const coords = segmentsByAlpha.get(alpha);
      if (coords) {
        coords.push(screenX, y, screenX, y + direction * length);
      } else {
        segmentsByAlpha.set(alpha, [screenX, y, screenX, y + direction * length]);
      }
    }
    drawTickSegmentsBatched(segmentsByAlpha, width, color);
  };

  // Bottom X-axis labels
  if (state.showBottomAxis) {
    drawXAxisTicks(
      chartBottom,
      1,
      state.bottomAxisTickLength,
      state.bottomAxisTickWidth,
      state.bottomAxisTickColor,
    );

    ctx.font = `${state.bottomXLabelFontWeight} ${state.bottomXLabelFontSize}px ${state.bottomXLabelFontFamily}`;
    ctx.textAlign = "center";
    ctx.fillStyle = state.bottomXLabelColor;
    const bottomLabelY = chartBottom + 20 + Math.max(0, state.bottomAxisTickLength);
    for (const [x, alpha] of state.xGridAlphas) {
      ctx.globalAlpha = alpha;
      const screenX = state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
      const label = formatXOverride
        ? formatXOverride(x, xRange)
        : formatXLabel(x, xRange, state.bottomAxisFormat);
      applyCanvasTextDirection(ctx, state, label);
      ctx.fillText(label, screenX, bottomLabelY);
    }
    ctx.globalAlpha = 1;
  }

  // Top X-axis labels
  if (state.showTopAxis) {
    drawXAxisTicks(
      state.chartTop,
      -1,
      state.topAxisTickLength,
      state.topAxisTickWidth,
      state.topAxisTickColor,
    );

    ctx.font = `${state.topXLabelFontWeight} ${state.topXLabelFontSize}px ${state.topXLabelFontFamily}`;
    ctx.textAlign = "center";
    ctx.fillStyle = state.topXLabelColor;
    const topLabelY = state.chartTop - 8 - Math.max(0, state.topAxisTickLength);
    for (const [x, alpha] of state.xGridAlphas) {
      ctx.globalAlpha = alpha;
      const screenX = state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
      const label = formatXOverride
        ? formatXOverride(x, xRange)
        : formatXLabel(x, xRange, state.topAxisFormat);
      applyCanvasTextDirection(ctx, state, label);
      ctx.fillText(label, screenX, topLabelY);
    }
    ctx.globalAlpha = 1;
  }

  // Y axis labels - single loop for both sides
  const yRange = state.viewport.yMax - state.viewport.yMin;
  const showLeft = state.showLeftAxis;
  const showRight = state.showRightAxis;

  if (showLeft || showRight) {
    const automaticYDecimals = formatY ? 1 : getGridLabelDecimalPlaces(state.yGridAlphas);
    const leftTickLength = Math.max(0, state.leftAxisTickLength);
    const rightTickLength = Math.max(0, state.rightAxisTickLength);
    const leftTickSegmentsByAlpha = new Map<number, number[]>();
    const rightTickSegmentsByAlpha = new Map<number, number[]>();

    const leftFont = showLeft
      ? `${state.leftYLabelFontWeight} ${state.leftYLabelFontSize}px ${state.leftYLabelFontFamily}`
      : "";
    const rightFont = showRight
      ? `${state.rightYLabelFontWeight} ${state.rightYLabelFontSize}px ${state.rightYLabelFontFamily}`
      : "";

    for (const [y, alpha] of state.yGridAlphas) {
      ctx.globalAlpha = alpha;
      const screenY = state.chartTop + ((state.viewport.yMax - y) / yRange) * state.chartHeight;

      if (showLeft) {
        if (leftTickLength > 0 && state.leftAxisTickWidth > 0) {
          const coords = leftTickSegmentsByAlpha.get(alpha);
          if (coords) {
            coords.push(state.padding.left, screenY, state.padding.left - leftTickLength, screenY);
          } else {
            leftTickSegmentsByAlpha.set(alpha, [
              state.padding.left,
              screenY,
              state.padding.left - leftTickLength,
              screenY,
            ]);
          }
        }
        const label = state.leftYFormat
          ? formatValue(y, state.leftYFormat)
          : formatY
            ? formatY(y)
            : y.toFixed(automaticYDecimals);
        ctx.font = leftFont;
        ctx.fillStyle = state.leftYLabelColor;
        applyCanvasTextDirection(ctx, state, label);
        ctx.textAlign = "right";
        ctx.fillText(label, state.padding.left - 8 - leftTickLength, screenY + 4);
      }
      if (showRight) {
        if (rightTickLength > 0 && state.rightAxisTickWidth > 0) {
          const coords = rightTickSegmentsByAlpha.get(alpha);
          if (coords) {
            coords.push(chartRight, screenY, chartRight + rightTickLength, screenY);
          } else {
            rightTickSegmentsByAlpha.set(alpha, [
              chartRight,
              screenY,
              chartRight + rightTickLength,
              screenY,
            ]);
          }
        }
        const label = state.rightYFormat
          ? formatValue(y, state.rightYFormat)
          : formatY
            ? formatY(y)
            : y.toFixed(automaticYDecimals);
        ctx.font = rightFont;
        ctx.fillStyle = state.rightYLabelColor;
        applyCanvasTextDirection(ctx, state, label);
        ctx.textAlign = "left";
        ctx.fillText(label, chartRight + 8 + rightTickLength, screenY + 4);
      }
    }

    if (showLeft) {
      drawTickSegmentsBatched(
        leftTickSegmentsByAlpha,
        state.leftAxisTickWidth,
        state.leftAxisTickColor,
      );
    }
    if (showRight) {
      drawTickSegmentsBatched(
        rightTickSegmentsByAlpha,
        state.rightAxisTickWidth,
        state.rightAxisTickColor,
      );
    }
  }

  ctx.globalAlpha = 1;
}

// Marker drawing lives in ./markers; re-exported here so the renderers can keep
// importing it from the baseRenderer barrel.
export { drawMarker } from "./markers.js";
export type { MarkerGlowStyle } from "./markers.js";

export function drawRoundedRect(
  ctx: RenderContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawCrosshairLines(
  ctx: RenderContext2D,
  state: WorkerState,
  verticalX: number,
): void {
  const chartBottom = state.chartTop + state.chartHeight;

  ctx.lineWidth = 1;

  if (state.crosshairVerticalVisible) {
    ctx.strokeStyle = state.crosshairVerticalColor;
    ctx.setLineDash(DASH_PATTERNS[state.crosshairVerticalStyle] ?? DASH_PATTERNS.dashed);
    ctx.beginPath();
    ctx.moveTo(verticalX, state.chartTop);
    ctx.lineTo(verticalX, chartBottom);
    ctx.stroke();
  }

  if (state.crosshairHorizontalVisible) {
    ctx.strokeStyle = state.crosshairHorizontalColor;
    ctx.setLineDash(DASH_PATTERNS[state.crosshairHorizontalStyle] ?? DASH_PATTERNS.dashed);
    ctx.beginPath();
    ctx.moveTo(state.padding.left, state.mouseY);
    ctx.lineTo(state.width - state.padding.right, state.mouseY);
    ctx.stroke();
  }

  ctx.setLineDash(DASH_PATTERNS.solid);
}

export function parseCrosshairStyle(state: WorkerState, cs: CrosshairOptions): void {
  if (cs.vertical) {
    if ("color" in cs.vertical)
      state.crosshairVerticalColor = cs.vertical.color || CROSSHAIR_DEFAULTS.color;
    if ("style" in cs.vertical)
      state.crosshairVerticalStyle = cs.vertical.style || CROSSHAIR_DEFAULTS.style;
    if ("visible" in cs.vertical)
      state.crosshairVerticalVisible = cs.vertical.visible ?? CROSSHAIR_DEFAULTS.visible;
  }
  if (cs.horizontal) {
    if ("color" in cs.horizontal)
      state.crosshairHorizontalColor = cs.horizontal.color || CROSSHAIR_DEFAULTS.color;
    if ("style" in cs.horizontal)
      state.crosshairHorizontalStyle = cs.horizontal.style || CROSSHAIR_DEFAULTS.style;
    if ("visible" in cs.horizontal)
      state.crosshairHorizontalVisible = cs.horizontal.visible ?? CROSSHAIR_DEFAULTS.visible;
  }
}

export function calculateTooltipPosition(
  state: WorkerState,
  chartBottom: number,
  boxWidth: number,
  boxHeight: number,
  crosshairScreenX: number,
): { x: number; y: number } {
  const margin = 10;
  const cursorOffset = state.pointerType === "touch" ? 24 : 15;
  const pos = state.tooltipPosition;

  let x: number;
  let y: number;

  if (pos === "cursor-bottom" || pos === "bottom-left" || pos === "bottom-right") {
    y = chartBottom - boxHeight - margin;
  } else if (pos === "cursor") {
    if (state.pointerType === "touch") {
      const aboveFinger = state.mouseY - boxHeight - cursorOffset;
      const belowFinger = state.mouseY + cursorOffset;
      if (aboveFinger >= state.chartTop + margin) {
        y = aboveFinger;
      } else if (belowFinger <= chartBottom - boxHeight - margin) {
        y = belowFinger;
      } else {
        y = state.mouseY - boxHeight / 2;
        y = Math.max(state.chartTop + margin, y);
        y = Math.min(y, chartBottom - boxHeight - margin);
      }
    } else {
      y = state.mouseY - boxHeight / 2;
      y = Math.max(state.chartTop + margin, y);
      y = Math.min(y, chartBottom - boxHeight - margin);
    }
  } else {
    y = state.chartTop + margin;
  }

  if (pos === "top-left" || pos === "bottom-left") {
    x = state.padding.left + margin;
  } else if (pos === "top-right" || pos === "bottom-right") {
    x = state.width - state.padding.right - boxWidth - margin;
  } else if (pos === "cursor") {
    x = state.mouseX + cursorOffset;
    if (x + boxWidth > state.width - state.padding.right) {
      x = state.mouseX - boxWidth - cursorOffset;
    }
  } else {
    x = crosshairScreenX + cursorOffset;
    if (x + boxWidth > state.width - state.padding.right) {
      x = crosshairScreenX - boxWidth - cursorOffset;
    }
  }

  return { x, y };
}

export function drawSelectionRect(ctx: RenderContext2D, state: WorkerState): void {
  if (state.selectionStart === null || state.selectionEnd === null) return;

  const xRange = state.viewport.xMax - state.viewport.xMin;
  const startX =
    state.padding.left + ((state.selectionStart - state.viewport.xMin) / xRange) * state.chartWidth;
  const endX =
    state.padding.left + ((state.selectionEnd - state.viewport.xMin) / xRange) * state.chartWidth;

  const left = Math.min(startX, endX);
  const right = Math.max(startX, endX);
  const selWidth = right - left;

  ctx.fillStyle = state.selectionColor;
  ctx.fillRect(left, state.chartTop, selWidth, state.chartHeight);

  if (state.selectionBorderWidth > 0) {
    ctx.strokeStyle = state.selectionBorderColor;
    ctx.lineWidth = state.selectionBorderWidth;
    ctx.setLineDash(DASH_PATTERNS[state.selectionBorderStyle] ?? DASH_PATTERNS.dashed);
    ctx.beginPath();
    ctx.moveTo(left, state.chartTop);
    ctx.lineTo(left, state.chartTop + state.chartHeight);
    ctx.moveTo(right, state.chartTop);
    ctx.lineTo(right, state.chartTop + state.chartHeight);
    ctx.stroke();
    ctx.setLineDash(DASH_PATTERNS.solid);
  }
}

export function drawAxisLabel(
  ctx: RenderContext2D,
  state: WorkerState,
  defaultFormat: (y: number) => string = (y) => y.toFixed(2),
  formatXOverride?: (x: number, xRange: number) => string,
): void {
  if (
    !state.showLeftAxisLabel &&
    !state.showRightAxisLabel &&
    !state.showBottomAxisLabel &&
    !state.showTopAxisLabel
  )
    return;

  const chartBottom = state.chartTop + state.chartHeight;

  if (
    state.mouseX < state.padding.left ||
    state.mouseX > state.width - state.padding.right ||
    state.mouseY < state.chartTop ||
    state.mouseY > chartBottom
  ) {
    return;
  }

  if (state.showLeftAxisLabel || state.showRightAxisLabel) {
    const yRange = state.viewport.yMax - state.viewport.yMin;
    const valueAtCursor =
      state.viewport.yMax - ((state.mouseY - state.chartTop) / state.chartHeight) * yRange;

    if (state.showRightAxisLabel) {
      ctx.font = `${state.rightAxisLabelFontWeight} ${state.rightAxisLabelFontSize}px ${state.rightAxisLabelFontFamily}`;
      const labelHeight = state.rightAxisLabelFontSize + 7;
      const rightText = state.rightAxisLabelUnit
        ? formatValue(valueAtCursor, state.rightAxisLabelUnit)
        : defaultFormat(valueAtCursor);
      applyCanvasTextDirection(ctx, state, rightText);
      const rightWidth = ctx.measureText(rightText).width + 10;
      const rightLabelX = state.width - state.padding.right + 2;
      const labelY = state.mouseY - labelHeight / 2;
      ctx.fillStyle = state.rightAxisLabelColor;
      ctx.fillRect(rightLabelX, labelY, rightWidth, labelHeight);
      ctx.fillStyle = state.rightAxisLabelFontColor;
      writeTextInsideBox(ctx, state, rightText, rightLabelX, state.mouseY + 4, rightWidth, 5);
    }

    if (state.showLeftAxisLabel) {
      ctx.font = `${state.leftAxisLabelFontWeight} ${state.leftAxisLabelFontSize}px ${state.leftAxisLabelFontFamily}`;
      const labelHeight = state.leftAxisLabelFontSize + 7;
      const leftText = state.leftAxisLabelUnit
        ? formatValue(valueAtCursor, state.leftAxisLabelUnit)
        : defaultFormat(valueAtCursor);
      applyCanvasTextDirection(ctx, state, leftText);
      const leftWidth = ctx.measureText(leftText).width + 10;
      const leftLabelX = state.padding.left - leftWidth - 2;
      const labelY = state.mouseY - labelHeight / 2;
      ctx.fillStyle = state.leftAxisLabelColor;
      ctx.fillRect(leftLabelX, labelY, leftWidth, labelHeight);
      ctx.fillStyle = state.leftAxisLabelFontColor;
      writeTextInsideBox(ctx, state, leftText, leftLabelX, state.mouseY + 4, leftWidth, 5);
    }
  }

  if (state.showBottomAxisLabel) {
    ctx.font = `${state.bottomAxisLabelFontWeight} ${state.bottomAxisLabelFontSize}px ${state.bottomAxisLabelFontFamily}`;
    const labelHeight = state.bottomAxisLabelFontSize + 7;
    const xRange = state.viewport.xMax - state.viewport.xMin;
    const dataX =
      state.viewport.xMin + ((state.mouseX - state.padding.left) / state.chartWidth) * xRange;

    const xText = state.bottomAxisLabelUnit
      ? formatValue(dataX, state.bottomAxisLabelUnit)
      : formatXOverride
        ? formatXOverride(dataX, xRange)
        : formatXLabel(dataX, xRange, state.bottomAxisFormat);
    applyCanvasTextDirection(ctx, state, xText);
    const xWidth = ctx.measureText(xText).width + 10;
    const minX = state.padding.left;
    const maxX = state.width - state.padding.right - xWidth;
    const labelX = Math.max(minX, Math.min(maxX, state.mouseX - xWidth / 2));
    const labelTop = chartBottom + 2;
    ctx.fillStyle = state.bottomAxisLabelColor;
    ctx.fillRect(labelX, labelTop, xWidth, labelHeight);
    ctx.fillStyle = state.bottomAxisLabelFontColor;
    writeTextInsideBox(ctx, state, xText, labelX, labelTop + labelHeight / 2 + 4, xWidth, 5);
  }

  if (state.showTopAxisLabel) {
    ctx.font = `${state.topAxisLabelFontWeight} ${state.topAxisLabelFontSize}px ${state.topAxisLabelFontFamily}`;
    const labelHeight = state.topAxisLabelFontSize + 7;
    const xRange = state.viewport.xMax - state.viewport.xMin;
    const dataX =
      state.viewport.xMin + ((state.mouseX - state.padding.left) / state.chartWidth) * xRange;

    const xText = state.topAxisLabelUnit
      ? formatValue(dataX, state.topAxisLabelUnit)
      : formatXOverride
        ? formatXOverride(dataX, xRange)
        : formatXLabel(dataX, xRange, state.topAxisFormat);
    applyCanvasTextDirection(ctx, state, xText);
    const xWidth = ctx.measureText(xText).width + 10;
    const minX = state.padding.left;
    const maxX = state.width - state.padding.right - xWidth;
    const labelX = Math.max(minX, Math.min(maxX, state.mouseX - xWidth / 2));
    const labelTop = state.chartTop - labelHeight - 2;
    ctx.fillStyle = state.topAxisLabelColor;
    ctx.fillRect(labelX, labelTop, xWidth, labelHeight);
    ctx.fillStyle = state.topAxisLabelFontColor;
    writeTextInsideBox(ctx, state, xText, labelX, labelTop + labelHeight / 2 + 4, xWidth, 5);
  }
}

// roundRect - wrapper around drawRoundedRect with dimension guard
function roundRect(
  ctx: RenderContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  if (w <= 0 || h <= 0) return;
  drawRoundedRect(ctx, x, y, w, h, r);
}

function drawHandle(
  ctx: RenderContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  side: "left" | "right",
): void {
  if (w <= 0 || h <= 0) return;
  if (r <= 0) {
    ctx.fillRect(x, y, w, h);
    return;
  }
  r = Math.min(r, w, h / 2);
  ctx.beginPath();
  if (side === "left") {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
  } else {
    ctx.moveTo(x, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x, y + h);
  }
  ctx.closePath();
  ctx.fill();
}

function drawRangeLensEffect(
  ctx: RenderContext2D,
  state: WorkerState,
  leftX: number,
  rightX: number,
): void {
  const selectionWidth = rightX - leftX;
  if (selectionWidth <= 1) return;

  const dpr = state.dpr;
  const x = leftX * dpr;
  const y = state.rangeTop * dpr;
  const w = selectionWidth * dpr;
  const h = state.rangeSelectorHeight * dpr;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  const gloss = ctx.createLinearGradient(0, y, 0, y + h);
  gloss.addColorStop(0, "rgba(255,255,255,0.10)");
  gloss.addColorStop(1, "rgba(0,0,0,0.06)");
  ctx.fillStyle = gloss;
  ctx.fillRect(x, y, w, h);

  ctx.restore();
}

export function drawRangeSelectorOverlay(ctx: RenderContext2D, state: WorkerState): void {
  const selectorLeft = state.rangeSelectorWidth === "canvas" ? 0 : state.padding.left;
  const selectorWidth = state.rangeSelectorWidth === "canvas" ? state.width : state.chartWidth;
  const selectorRight = selectorLeft + selectorWidth;
  const xRange = state.dataBounds.xMax - state.dataBounds.xMin;
  const leftX =
    selectorLeft + ((state.viewport.xMin - state.dataBounds.xMin) / xRange) * selectorWidth;
  const rightX =
    selectorLeft + ((state.viewport.xMax - state.dataBounds.xMin) / xRange) * selectorWidth;

  if (state.rangeSelectorEffect === "glass") {
    drawRangeLensEffect(ctx, state, leftX, rightX);
  }

  const r = state.rangeBorderRadius;

  ctx.fillStyle = state.rangeOverlayColor;
  if (r > 0) {
    ctx.beginPath();
    roundRect(
      ctx,
      selectorLeft,
      state.rangeTop,
      leftX - selectorLeft,
      state.rangeSelectorHeight,
      r,
    );
    ctx.fill();
    ctx.beginPath();
    roundRect(ctx, rightX, state.rangeTop, selectorRight - rightX, state.rangeSelectorHeight, r);
    ctx.fill();
  } else {
    ctx.fillRect(selectorLeft, state.rangeTop, leftX - selectorLeft, state.rangeSelectorHeight);
    ctx.fillRect(rightX, state.rangeTop, selectorRight - rightX, state.rangeSelectorHeight);
  }

  ctx.strokeStyle = state.rangeBorderColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(leftX, state.rangeTop, rightX - leftX, state.rangeSelectorHeight);

  ctx.fillStyle = state.rangeHandleColor;
  const hr = state.rangeHandleBorderRadius;
  drawHandle(
    ctx,
    leftX - RANGE_HANDLE_WIDTH / 2,
    state.rangeTop,
    RANGE_HANDLE_WIDTH,
    state.rangeSelectorHeight,
    hr,
    "left",
  );
  drawHandle(
    ctx,
    rightX - RANGE_HANDLE_WIDTH / 2,
    state.rangeTop,
    RANGE_HANDLE_WIDTH,
    state.rangeSelectorHeight,
    hr,
    "right",
  );

  ctx.strokeStyle = state.rangeGripColor;
  ctx.lineWidth = 1;
  const gripY = state.rangeTop + state.rangeSelectorHeight / 2;

  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(leftX + i * 2, gripY - 8);
    ctx.lineTo(leftX + i * 2, gripY + 8);
    ctx.stroke();
  }

  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(rightX + i * 2, gripY - 8);
    ctx.lineTo(rightX + i * 2, gripY + 8);
    ctx.stroke();
  }
}

// Zoom function (instant)
export function zoom(state: WorkerState, factor: number, centerX: number, minRange: number): void {
  const xRange = state.viewport.xMax - state.viewport.xMin;
  const xRatio = (centerX - state.viewport.xMin) / xRange;

  const newXRange = xRange * factor;
  if (newXRange < minRange) return;

  const maxXRange = state.dataBounds.xMax - state.dataBounds.xMin;
  const clampedXRange = Math.min(newXRange, maxXRange);

  let newXMin = centerX - xRatio * clampedXRange;
  let newXMax = centerX + (1 - xRatio) * clampedXRange;

  if (newXMin < state.dataBounds.xMin) {
    newXMax += state.dataBounds.xMin - newXMin;
    newXMin = state.dataBounds.xMin;
  }
  if (newXMax > state.dataBounds.xMax) {
    newXMin -= newXMax - state.dataBounds.xMax;
    newXMax = state.dataBounds.xMax;
  }

  if (newXMin === state.viewport.xMin && newXMax === state.viewport.xMax) {
    // A clamped request can also arrive while an opposite animation is still
    // queued from the same viewport. Cancel it instead of letting that stale
    // target move an otherwise unchanged chart.
    state.viewportAnimation.active = false;
    return;
  }

  state.viewport.xMin = newXMin;
  state.viewport.xMax = newXMax;

  state.cacheValid = false;
}

// Zoom function with animation
export function zoomAnimated(
  state: WorkerState,
  factor: number,
  centerX: number,
  minRange: number,
  timestamp: number,
): void {
  if (!state.animated) {
    zoom(state, factor, centerX, minRange);
    return;
  }

  const xRange = state.viewport.xMax - state.viewport.xMin;
  const xRatio = (centerX - state.viewport.xMin) / xRange;

  const newXRange = xRange * factor;
  if (newXRange < minRange) return;

  const maxXRange = state.dataBounds.xMax - state.dataBounds.xMin;
  const clampedXRange = Math.min(newXRange, maxXRange);

  let newXMin = centerX - xRatio * clampedXRange;
  let newXMax = centerX + (1 - xRatio) * clampedXRange;

  // Clamp to data bounds
  if (newXMin < state.dataBounds.xMin) {
    newXMax += state.dataBounds.xMin - newXMin;
    newXMin = state.dataBounds.xMin;
  }
  if (newXMax > state.dataBounds.xMax) {
    newXMin -= newXMax - state.dataBounds.xMax;
    newXMax = state.dataBounds.xMax;
  }

  if (newXMin === state.viewport.xMin && newXMax === state.viewport.xMax) {
    state.viewportAnimation.active = false;
    return;
  }

  state.viewportAnimation.active = true;
  state.viewportAnimation.startTime = timestamp;
  state.viewportAnimation.duration = ANIMATION.viewportDuration;
  state.viewportAnimation.fromViewport = { ...state.viewport };
  state.viewportAnimation.toViewport = {
    xMin: newXMin,
    xMax: newXMax,
    yMin: state.viewport.yMin,
    yMax: state.viewport.yMax,
  };
}

// Pan function (instant)
export function pan(state: WorkerState, dx: number): void {
  const xRange = state.viewport.xMax - state.viewport.xMin;

  state.viewport.xMin += dx * xRange;
  state.viewport.xMax += dx * xRange;

  if (state.viewport.xMin < state.dataBounds.xMin) {
    state.viewport.xMax += state.dataBounds.xMin - state.viewport.xMin;
    state.viewport.xMin = state.dataBounds.xMin;
  }
  if (state.viewport.xMax > state.dataBounds.xMax) {
    state.viewport.xMin -= state.viewport.xMax - state.dataBounds.xMax;
    state.viewport.xMax = state.dataBounds.xMax;
  }

  state.cacheValid = false;
}

// Pan function with animation
export function panAnimated(state: WorkerState, dx: number, timestamp: number): void {
  if (!state.animated) {
    pan(state, dx);
    return;
  }

  const xRange = state.viewport.xMax - state.viewport.xMin;
  let newXMin = state.viewport.xMin + dx * xRange;
  let newXMax = state.viewport.xMax + dx * xRange;

  // Clamp to data bounds
  if (newXMin < state.dataBounds.xMin) {
    newXMax += state.dataBounds.xMin - newXMin;
    newXMin = state.dataBounds.xMin;
  }
  if (newXMax > state.dataBounds.xMax) {
    newXMin -= newXMax - state.dataBounds.xMax;
    newXMax = state.dataBounds.xMax;
  }

  if (newXMin === state.viewport.xMin && newXMax === state.viewport.xMax) {
    state.viewportAnimation.active = false;
    return;
  }

  state.viewportAnimation.active = true;
  state.viewportAnimation.startTime = timestamp;
  state.viewportAnimation.duration = ANIMATION.viewportDuration;
  state.viewportAnimation.fromViewport = { ...state.viewport };
  state.viewportAnimation.toViewport = {
    xMin: newXMin,
    xMax: newXMax,
    yMin: state.viewport.yMin,
    yMax: state.viewport.yMax,
  };
}

export function reset(state: WorkerState): void {
  state.viewport.xMin = state.dataBounds.xMin;
  state.viewport.xMax = state.dataBounds.xMax;
  state.cacheValid = false;
}

export function resetAnimated(state: WorkerState, timestamp: number): void {
  if (!state.animated) {
    reset(state);
    return;
  }

  if (
    state.viewport.xMin === state.dataBounds.xMin &&
    state.viewport.xMax === state.dataBounds.xMax
  ) {
    state.viewportAnimation.active = false;
    return;
  }

  state.viewportAnimation.active = true;
  state.viewportAnimation.startTime = timestamp;
  state.viewportAnimation.duration = ANIMATION.viewportResetDuration;
  state.viewportAnimation.fromViewport = { ...state.viewport };
  state.viewportAnimation.toViewport = {
    xMin: state.dataBounds.xMin,
    xMax: state.dataBounds.xMax,
    yMin: state.viewport.yMin,
    yMax: state.viewport.yMax,
  };
}

// Set viewport range (instant). Supports partial updates — omit xMin or xMax
// to keep the current value (used for single-handle drags).
export function setViewportRange(
  state: WorkerState,
  xMin: number | undefined,
  xMax: number | undefined,
  minRange: number,
): void {
  const newXMin =
    xMin !== undefined
      ? Math.max(state.dataBounds.xMin, Math.min(state.dataBounds.xMax, xMin))
      : state.viewport.xMin;
  const newXMax =
    xMax !== undefined
      ? Math.max(state.dataBounds.xMin, Math.min(state.dataBounds.xMax, xMax))
      : state.viewport.xMax;

  // Ensure min < max (safety net for handle crossover)
  const lo = Math.min(newXMin, newXMax);
  const hi = Math.max(newXMin, newXMax);

  if (hi - lo < minRange) return;

  state.viewport.xMin = lo;
  state.viewport.xMax = hi;
  state.viewportAnimation.active = false;
  state.cacheValid = false;
}

export function setViewportRangeAnimated(
  state: WorkerState,
  xMin: number,
  xMax: number,
  minRange: number,
  timestamp: number,
): void {
  xMin = Math.max(state.dataBounds.xMin, xMin);
  xMax = Math.min(state.dataBounds.xMax, xMax);

  if (xMax - xMin < minRange) return;

  if (!state.animated) {
    state.viewport.xMin = xMin;
    state.viewport.xMax = xMax;
    state.cacheValid = false;
    return;
  }

  if (xMin === state.viewport.xMin && xMax === state.viewport.xMax) {
    state.viewportAnimation.active = false;
    return;
  }

  state.viewportAnimation.active = true;
  state.viewportAnimation.startTime = timestamp;
  state.viewportAnimation.duration = ANIMATION.viewportResetDuration;
  state.viewportAnimation.fromViewport = { ...state.viewport };
  state.viewportAnimation.toViewport = {
    xMin,
    xMax,
    yMin: state.viewport.yMin,
    yMax: state.viewport.yMax,
  };
}

export function updateViewportAnimation(state: WorkerState, timestamp: number): void {
  if (!state.viewportAnimation.active) return;

  const elapsed = Math.max(0, timestamp - state.viewportAnimation.startTime);
  const progress = Math.min(1, elapsed / state.viewportAnimation.duration);
  const from = state.viewportAnimation.fromViewport;
  const to = state.viewportAnimation.toViewport;

  if (progress >= 1) {
    // Assign the stored target directly so the final host sync is bit-for-bit
    // identical to the requested range, even when interpolation would round.
    state.viewport.xMin = to.xMin;
    state.viewport.xMax = to.xMax;
    state.viewportAnimation.active = false;
  } else {
    const eased = ANIMATION.viewportEasing(progress);
    state.viewport.xMin = from.xMin + (to.xMin - from.xMin) * eased;
    state.viewport.xMax = from.xMax + (to.xMax - from.xMax) * eased;
  }

  state.cacheValid = false;
}

export function startRevealAnimation(state: WorkerState, timestamp: number): void {
  if (!state.animated) {
    state.revealProgress = 1;
    return;
  }
  state.revealProgress = 0;
  state.revealStartTime = timestamp;
}

export function updateRevealAnimation(state: WorkerState, timestamp: number): void {
  if (state.revealProgress >= 1) return;

  const elapsed = Math.max(0, timestamp - state.revealStartTime);
  state.revealProgress = Math.min(1, elapsed / ANIMATION.revealDuration);
}

export function setYViewport(
  state: WorkerState,
  yMin: number,
  yMax: number,
  timestamp: number,
): void {
  // Expand a degenerate target span (single value / flat series). The per-frame
  // auto-fit funnels through here, so without this a constant series collapses
  // yMin === yMax and every screenY divides by a zero range -> NaN.
  const span = ensurePositiveSpan(yMin, yMax, 0);
  yMin = span.min;
  yMax = span.max;

  // If already animating, check against animation target (not current values)
  if (state.yAnimation.active) {
    const targetRange = state.yAnimation.toYMax - state.yAnimation.toYMin;
    const tolerance = Math.max(targetRange * 0.0001, 0.001);
    if (
      Math.abs(state.yAnimation.toYMin - yMin) < tolerance &&
      Math.abs(state.yAnimation.toYMax - yMax) < tolerance
    ) {
      return; // Already animating to same target
    }
  }

  // Skip if current values already match target
  const currentRange = state.viewport.yMax - state.viewport.yMin;
  const tolerance = Math.max(currentRange * 0.0001, 0.001);
  if (
    Math.abs(state.viewport.yMin - yMin) < tolerance &&
    Math.abs(state.viewport.yMax - yMax) < tolerance
  ) {
    return;
  }

  if (!state.animated) {
    state.viewport.yMin = yMin;
    state.viewport.yMax = yMax;
    return;
  }

  // Use current animated values as starting point
  state.yAnimation.active = true;
  state.yAnimation.startTime = timestamp;
  state.yAnimation.duration = ANIMATION.yAxisDuration;
  state.yAnimation.fromYMin = state.viewport.yMin;
  state.yAnimation.fromYMax = state.viewport.yMax;
  state.yAnimation.toYMin = yMin;
  state.yAnimation.toYMax = yMax;
}

export function updateYAnimation(state: WorkerState, timestamp: number): void {
  if (!state.yAnimation.active) return;

  const elapsed = Math.max(0, timestamp - state.yAnimation.startTime);
  const progress = Math.min(1, elapsed / state.yAnimation.duration);
  const eased = ANIMATION.yAxisEasing(progress);

  state.viewport.yMin =
    state.yAnimation.fromYMin + (state.yAnimation.toYMin - state.yAnimation.fromYMin) * eased;
  state.viewport.yMax =
    state.yAnimation.fromYMax + (state.yAnimation.toYMax - state.yAnimation.fromYMax) * eased;

  state.cacheValid = false;

  if (progress >= 1) {
    state.yAnimation.active = false;
  }
}

export function hasActiveGridAnimations(state: WorkerState): boolean {
  if (!state.animated) return false;
  for (const alpha of state.xGridAlphas.values()) {
    if (alpha > 0 && alpha < 1) return true;
  }
  for (const alpha of state.yGridAlphas.values()) {
    if (alpha > 0 && alpha < 1) return true;
  }
  return false;
}

export function updateFPS(state: WorkerState, timestamp: number): void {
  state.frameCount++;
  if (timestamp - state.fpsUpdateTime >= 1000) {
    state.fps = state.frameCount;
    state.frameCount = 0;
    state.fpsUpdateTime = timestamp;
  }
}

/** Apply custom padding from config */
export function applyPadding(state: WorkerState, config: Record<string, unknown>): void {
  const p = config.padding as Record<string, number> | undefined;
  if (!p) return;
  if (p.top !== undefined) state.padding.top = p.top;
  if (p.right !== undefined) state.padding.right = p.right;
  if (p.bottom !== undefined) state.padding.bottom = p.bottom;
  if (p.left !== undefined) state.padding.left = p.left;
}

/** Snapshot current padding as the base (call after applyPadding, before measureLabelSpace) */
export function savePaddingBase(state: WorkerState): void {
  state.paddingBase = { ...state.padding };
}

/** Apply a partial runtime padding patch to the unreserved base padding. */
function patchPaddingBase(state: WorkerState, padding: Record<string, number>): void {
  if (padding.top !== undefined) state.paddingBase.top = padding.top;
  if (padding.right !== undefined) state.paddingBase.right = padding.right;
  if (padding.bottom !== undefined) state.paddingBase.bottom = padding.bottom;
  if (padding.left !== undefined) state.paddingBase.left = padding.left;
}

/** Restore padding to the base snapshot (before re-measuring label space) */
function resetPaddingFromBase(state: WorkerState): void {
  state.padding.top = state.paddingBase.top;
  state.padding.right = state.paddingBase.right;
  state.padding.bottom = state.paddingBase.bottom;
  state.padding.left = state.paddingBase.left;
}

/** Reset all label state fields to defaults (before re-parsing) */
function resetLabelState(state: WorkerState): void {
  state.labelTopText = "";
  state.labelTopFontSize = 16;
  state.labelTopFontWeight = "bold";
  state.labelTopFontColor = "#ffffff";
  state.labelTopFontFamily = DEFAULT_CHART_FONT_FAMILY;
  state.labelTopAlign = "center";
  state.labelTopDirection = "inherit";
  state.labelTopPad = { top: 6, right: 6, bottom: 6, left: 6 };

  state.labelBottomText = "";
  state.labelBottomFontSize = 12;
  state.labelBottomFontWeight = "normal";
  state.labelBottomFontColor = "#6b8cae";
  state.labelBottomFontFamily = DEFAULT_CHART_FONT_FAMILY;
  state.labelBottomAlign = "center";
  state.labelBottomDirection = "inherit";
  state.labelBottomPad = { top: 6, right: 6, bottom: 6, left: 6 };

  state.labelLeftText = "";
  state.labelLeftFontSize = 12;
  state.labelLeftFontWeight = "normal";
  state.labelLeftFontColor = "#6b8cae";
  state.labelLeftFontFamily = DEFAULT_CHART_FONT_FAMILY;
  state.labelLeftAlign = "middle";
  state.labelLeftDirection = "inherit";
  state.labelLeftPad = { top: 6, right: 6, bottom: 6, left: 6 };

  state.labelRightText = "";
  state.labelRightFontSize = 12;
  state.labelRightFontWeight = "normal";
  state.labelRightFontColor = "#6b8cae";
  state.labelRightFontFamily = DEFAULT_CHART_FONT_FAMILY;
  state.labelRightAlign = "middle";
  state.labelRightDirection = "inherit";
  state.labelRightPad = { top: 6, right: 6, bottom: 6, left: 6 };

  state.customLabels = [];

  state.labelTopSpace = 0;
  state.labelBottomSpace = 0;
  state.labelLeftSpace = 0;
  state.labelRightSpace = 0;
}

/** Apply labelFont config to a set of state fields */
function applyLabelFont(
  font: Record<string, any>,
  target: {
    color: (v: string) => void;
    size: (v: number) => void;
    weight: (v: string | number) => void;
    family: (v: string) => void;
  },
): void {
  if (font.color) target.color(font.color);
  if (font.size !== undefined) target.size(font.size);
  if (font.weight !== undefined) target.weight(font.weight);
  if (font.family) target.family(font.family);
}

/** Apply cursorLabel config to a set of state fields */
function applyCursorLabel(
  cl: Record<string, any>,
  target: {
    visible: (v: boolean) => void;
    bgColor: (v: string) => void;
    fontColor: (v: string) => void;
    fontSize: (v: number) => void;
    fontWeight: (v: string | number) => void;
    fontFamily: (v: string) => void;
  },
): void {
  if ("visible" in cl) target.visible(cl.visible);
  if (cl.backgroundColor) target.bgColor(cl.backgroundColor);
  if (cl.labelFont) {
    const f = cl.labelFont;
    if (f.color) target.fontColor(f.color);
    if (f.size !== undefined) target.fontSize(f.size);
    if (f.weight !== undefined) target.fontWeight(f.weight);
    if (f.family) target.fontFamily(f.family);
  }
}

/** Parse axis config and apply to worker state */
export function parseAxisConfig(state: WorkerState, ax: Record<string, any>): void {
  if (ax.color) state.axisColor = ax.color;
  if (Number.isFinite(ax.width) && ax.width >= 0) {
    state.bottomAxisWidth = ax.width;
    state.topAxisWidth = ax.width;
    state.leftAxisWidth = ax.width;
    state.rightAxisWidth = ax.width;
  }
  // Bottom X-axis config
  if (ax.bottom) {
    if ("visible" in ax.bottom) state.showBottomAxis = ax.bottom.visible ?? state.showBottomAxis;
    if (Number.isFinite(ax.bottom.width) && ax.bottom.width >= 0) {
      state.bottomAxisWidth = ax.bottom.width;
    }
    if (ax.bottom.format) state.bottomAxisFormat = ax.bottom.format;
    if (ax.bottom.ticks) {
      const t = ax.bottom.ticks;
      // Reset to axis color fallback unless a valid tick color is provided.
      state.bottomAxisTickColor = "";
      if (typeof t.color === "string" && t.color) state.bottomAxisTickColor = t.color;
      if (Number.isFinite(t.width) && t.width >= 0) state.bottomAxisTickWidth = t.width;
      if (Number.isFinite(t.length) && t.length >= 0) state.bottomAxisTickLength = t.length;
    }
    if (ax.bottom.labelFont)
      applyLabelFont(ax.bottom.labelFont, {
        color: (v) => {
          state.bottomXLabelColor = v;
        },
        size: (v) => {
          state.bottomXLabelFontSize = v;
        },
        weight: (v) => {
          state.bottomXLabelFontWeight = v;
        },
        family: (v) => {
          state.bottomXLabelFontFamily = v;
        },
      });
    if (ax.bottom.cursorLabel)
      applyCursorLabel(ax.bottom.cursorLabel, {
        visible: (v) => {
          state.showBottomAxisLabel = v ?? state.showBottomAxisLabel;
        },
        bgColor: (v) => {
          state.bottomAxisLabelColor = v;
        },
        fontColor: (v) => {
          state.bottomAxisLabelFontColor = v;
        },
        fontSize: (v) => {
          state.bottomAxisLabelFontSize = v;
        },
        fontWeight: (v) => {
          state.bottomAxisLabelFontWeight = v;
        },
        fontFamily: (v) => {
          state.bottomAxisLabelFontFamily = v;
        },
      });
  }
  // Top X-axis config
  if (ax.top) {
    if ("visible" in ax.top) state.showTopAxis = ax.top.visible ?? state.showTopAxis;
    if (Number.isFinite(ax.top.width) && ax.top.width >= 0) {
      state.topAxisWidth = ax.top.width;
    }
    if (ax.top.format) state.topAxisFormat = ax.top.format;
    if (ax.top.ticks) {
      const t = ax.top.ticks;
      // Reset to axis color fallback unless a valid tick color is provided.
      state.topAxisTickColor = "";
      if (typeof t.color === "string" && t.color) state.topAxisTickColor = t.color;
      if (Number.isFinite(t.width) && t.width >= 0) state.topAxisTickWidth = t.width;
      if (Number.isFinite(t.length) && t.length >= 0) state.topAxisTickLength = t.length;
    }
    if (ax.top.labelFont)
      applyLabelFont(ax.top.labelFont, {
        color: (v) => {
          state.topXLabelColor = v;
        },
        size: (v) => {
          state.topXLabelFontSize = v;
        },
        weight: (v) => {
          state.topXLabelFontWeight = v;
        },
        family: (v) => {
          state.topXLabelFontFamily = v;
        },
      });
    if (ax.top.cursorLabel)
      applyCursorLabel(ax.top.cursorLabel, {
        visible: (v) => {
          state.showTopAxisLabel = v ?? state.showTopAxisLabel;
        },
        bgColor: (v) => {
          state.topAxisLabelColor = v;
        },
        fontColor: (v) => {
          state.topAxisLabelFontColor = v;
        },
        fontSize: (v) => {
          state.topAxisLabelFontSize = v;
        },
        fontWeight: (v) => {
          state.topAxisLabelFontWeight = v;
        },
        fontFamily: (v) => {
          state.topAxisLabelFontFamily = v;
        },
      });
  }
  // Left Y-axis config
  if (ax.left) {
    if ("visible" in ax.left) state.showLeftAxis = ax.left.visible ?? state.showLeftAxis;
    if (Number.isFinite(ax.left.width) && ax.left.width >= 0) {
      state.leftAxisWidth = ax.left.width;
    }
    if (ax.left.ticks) {
      const t = ax.left.ticks;
      // Reset to axis color fallback unless a valid tick color is provided.
      state.leftAxisTickColor = "";
      if (typeof t.color === "string" && t.color) state.leftAxisTickColor = t.color;
      if (Number.isFinite(t.width) && t.width >= 0) state.leftAxisTickWidth = t.width;
      if (Number.isFinite(t.length) && t.length >= 0) state.leftAxisTickLength = t.length;
    }
    if (ax.left.format) state.leftYFormat = ax.left.format;
    if (ax.left.labelFont)
      applyLabelFont(ax.left.labelFont, {
        color: (v) => {
          state.leftYLabelColor = v;
        },
        size: (v) => {
          state.leftYLabelFontSize = v;
        },
        weight: (v) => {
          state.leftYLabelFontWeight = v;
        },
        family: (v) => {
          state.leftYLabelFontFamily = v;
        },
      });
    if (ax.left.cursorLabel)
      applyCursorLabel(ax.left.cursorLabel, {
        visible: (v) => {
          state.showLeftAxisLabel = v ?? state.showLeftAxisLabel;
        },
        bgColor: (v) => {
          state.leftAxisLabelColor = v;
        },
        fontColor: (v) => {
          state.leftAxisLabelFontColor = v;
        },
        fontSize: (v) => {
          state.leftAxisLabelFontSize = v;
        },
        fontWeight: (v) => {
          state.leftAxisLabelFontWeight = v;
        },
        fontFamily: (v) => {
          state.leftAxisLabelFontFamily = v;
        },
      });
  }
  // Right Y-axis config
  if (ax.right) {
    if ("visible" in ax.right) state.showRightAxis = ax.right.visible ?? state.showRightAxis;
    if (Number.isFinite(ax.right.width) && ax.right.width >= 0) {
      state.rightAxisWidth = ax.right.width;
    }
    if (ax.right.ticks) {
      const t = ax.right.ticks;
      // Reset to axis color fallback unless a valid tick color is provided.
      state.rightAxisTickColor = "";
      if (typeof t.color === "string" && t.color) state.rightAxisTickColor = t.color;
      if (Number.isFinite(t.width) && t.width >= 0) state.rightAxisTickWidth = t.width;
      if (Number.isFinite(t.length) && t.length >= 0) state.rightAxisTickLength = t.length;
    }
    if (ax.right.format) state.rightYFormat = ax.right.format;
    if (ax.right.labelFont)
      applyLabelFont(ax.right.labelFont, {
        color: (v) => {
          state.rightYLabelColor = v;
        },
        size: (v) => {
          state.rightYLabelFontSize = v;
        },
        weight: (v) => {
          state.rightYLabelFontWeight = v;
        },
        family: (v) => {
          state.rightYLabelFontFamily = v;
        },
      });
    if (ax.right.cursorLabel)
      applyCursorLabel(ax.right.cursorLabel, {
        visible: (v) => {
          state.showRightAxisLabel = v ?? state.showRightAxisLabel;
        },
        bgColor: (v) => {
          state.rightAxisLabelColor = v;
        },
        fontColor: (v) => {
          state.rightAxisLabelFontColor = v;
        },
        fontSize: (v) => {
          state.rightAxisLabelFontSize = v;
        },
        fontWeight: (v) => {
          state.rightAxisLabelFontWeight = v;
        },
        fontFamily: (v) => {
          state.rightAxisLabelFontFamily = v;
        },
      });
  }
}

/** Extract cursor label unit config from axis config.
 *  Returns explicit flags and unit values for left, right, bottom, and top axes. */
export function parseAxisCursorUnits(ax: Record<string, any>): {
  left?: UnitOptions | null;
  leftExplicit: boolean;
  right?: UnitOptions | null;
  rightExplicit: boolean;
  bottom?: UnitOptions | null;
  bottomExplicit: boolean;
  top?: UnitOptions | null;
  topExplicit: boolean;
} {
  let left: UnitOptions | null | undefined;
  let leftExplicit = false;
  let right: UnitOptions | null | undefined;
  let rightExplicit = false;
  let bottom: UnitOptions | null | undefined;
  let bottomExplicit = false;
  let top: UnitOptions | null | undefined;
  let topExplicit = false;

  if (ax.left?.cursorLabel && "unit" in ax.left.cursorLabel) {
    const val = ax.left.cursorLabel.unit;
    if (val === "auto") {
      leftExplicit = false;
    } else if (val !== undefined) {
      left = val;
      leftExplicit = true;
    }
  }

  if (ax.right?.cursorLabel && "unit" in ax.right.cursorLabel) {
    const val = ax.right.cursorLabel.unit;
    if (val === "auto") {
      rightExplicit = false;
    } else if (val !== undefined) {
      right = val;
      rightExplicit = true;
    }
  }

  if (ax.bottom?.cursorLabel && "unit" in ax.bottom.cursorLabel) {
    const val = ax.bottom.cursorLabel.unit;
    if (val === "auto") {
      bottomExplicit = false;
    } else if (val !== undefined) {
      bottom = val;
      bottomExplicit = true;
    }
  }

  if (ax.top?.cursorLabel && "unit" in ax.top.cursorLabel) {
    const val = ax.top.cursorLabel.unit;
    if (val === "auto") {
      topExplicit = false;
    } else if (val !== undefined) {
      top = val;
      topExplicit = true;
    }
  }

  return { left, leftExplicit, right, rightExplicit, bottom, bottomExplicit, top, topExplicit };
}

/** Parse tooltip config and apply to worker state */
export function parseTooltipConfig(state: WorkerState, ls: Record<string, any>): void {
  if ("backgroundColor" in ls)
    state.tooltipBackgroundColor = ls.backgroundColor || "rgba(22, 33, 62, 0.95)";
  if ("borderColor" in ls) state.tooltipBorderColor = ls.borderColor || "#4a6fa1";
  if ("borderWidth" in ls) {
    const borderWidth = ls.borderWidth;
    state.tooltipBorderWidth = Number.isFinite(borderWidth) && borderWidth >= 0 ? borderWidth : 1;
  }
  if ("borderRadius" in ls) state.tooltipBorderRadius = ls.borderRadius ?? 0;
  if ("borderStyle" in ls) state.tooltipBorderStyle = ls.borderStyle || "solid";
  if ("position" in ls) state.tooltipPosition = ls.position || "cursor-top";
  if (ls.titleFont) {
    const tf = ls.titleFont;
    if (tf.size !== undefined) state.tooltipTitleFontSize = tf.size;
    if (tf.weight !== undefined) state.tooltipTitleFontWeight = tf.weight;
    if (tf.color) state.tooltipTitleFontColor = tf.color;
    if (tf.family) state.tooltipTitleFontFamily = tf.family;
  }
  if (ls.labelFont) {
    const lf = ls.labelFont;
    if (lf.size !== undefined) state.tooltipLabelFontSize = lf.size;
    if (lf.weight !== undefined) state.tooltipLabelFontWeight = lf.weight;
    if (lf.color) state.tooltipLabelFontColor = lf.color;
    if (lf.family) state.tooltipLabelFontFamily = lf.family;
  }
  if (ls.valueFont) {
    const vf = ls.valueFont;
    if (vf.size !== undefined) state.tooltipValueFontSize = vf.size;
    if (vf.weight !== undefined) state.tooltipValueFontWeight = vf.weight;
    if (vf.color) state.tooltipValueFontColor = vf.color;
    if (vf.family) state.tooltipValueFontFamily = vf.family;
  }
  if ("direction" in ls) state.tooltipDirection = parseTextDirection(ls.direction);
  if ("hasCallback" in ls) state.tooltipHasCallback = !!ls.hasCallback;
  if ("showSwatch" in ls) state.tooltipShowSwatch = ls.showSwatch ?? true;
  if (ls.padding) {
    const p = ls.padding;
    if (Number.isFinite(p.top) && p.top >= 0) state.tooltipPaddingTop = p.top;
    if (Number.isFinite(p.right) && p.right >= 0) state.tooltipPaddingRight = p.right;
    if (Number.isFinite(p.bottom) && p.bottom >= 0) state.tooltipPaddingBottom = p.bottom;
    if (Number.isFinite(p.left) && p.left >= 0) state.tooltipPaddingLeft = p.left;
  }
  if ("backdropBlur" in ls && Number.isFinite(ls.backdropBlur) && ls.backdropBlur >= 0) {
    state.tooltipBackdropBlur = ls.backdropBlur;
  }
  if ("shadow" in ls) {
    const shadow = ls.shadow;
    if (shadow === false) {
      state.tooltipShadowEnabled = false;
    } else if (shadow === true) {
      state.tooltipShadowEnabled = true;
    } else if (typeof shadow === "object") {
      if ("enabled" in shadow) state.tooltipShadowEnabled = shadow.enabled !== false;
      else state.tooltipShadowEnabled = true;

      if ("color" in shadow) {
        state.tooltipShadowColor =
          typeof shadow.color === "string" && shadow.color ? shadow.color : "rgba(0, 0, 0, 0.18)";
      }
      if ("blur" in shadow) {
        const blur = shadow.blur;
        if (Number.isFinite(blur) && blur >= 0) state.tooltipShadowBlur = blur;
      }
      if ("offsetX" in shadow) {
        const offsetX = shadow.offsetX;
        if (Number.isFinite(offsetX)) state.tooltipShadowOffsetX = offsetX;
      }
      if ("offsetY" in shadow) {
        const offsetY = shadow.offsetY;
        if (Number.isFinite(offsetY)) state.tooltipShadowOffsetY = offsetY;
      }
    }
  }
  // Stock-specific fields
  if ("candleBorder" in ls) state.tooltipCandleBorder = !!ls.candleBorder;
  if ("fields" in ls) state.tooltipFields = ls.fields ?? null;
  if (ls.fieldLabels && typeof ls.fieldLabels === "object") {
    for (const field of Object.keys(ls.fieldLabels) as StockTooltipField[]) {
      const label = ls.fieldLabels[field];
      if (label === null || label === undefined) {
        delete state.stockTooltipFieldLabels[field];
      } else {
        state.stockTooltipFieldLabels[field] = String(label);
      }
    }
  }
  // Line-specific fields
  if ("visibleSeries" in ls) state.tooltipVisibleSeries = ls.visibleSeries ?? null;
  // Fixed width
  if ("width" in ls) {
    const w = ls.width;
    state.tooltipFixedWidth = Number.isFinite(w) && w > 0 ? w : 0;
  }
  // Title format (decoupled from axis format)
  if (ls.titleFormat) state.tooltipTitleFormat = ls.titleFormat;
}

/** Parse grid config and apply to worker state */
export function parseGridConfig(state: WorkerState, grid: Record<string, any>): void {
  if (grid.color) state.gridColor = grid.color;
  if (grid.lineWidth !== undefined) state.gridLineWidth = grid.lineWidth;
  if (grid.vertical !== undefined) state.gridVerticalVisible = grid.vertical;
  if (grid.horizontal !== undefined) state.gridHorizontalVisible = grid.horizontal;
}

/** Parse range selector config and apply to worker state */
export function parseRangeSelectorConfig(state: WorkerState, config: Record<string, any>): void {
  if (config.rangeSelector) {
    const rs = config.rangeSelector;
    if (typeof rs.visible === "boolean") {
      state.showRangeSelector = rs.visible;
    }
    if (rs.width === "plot" || rs.width === "canvas") {
      if (state.rangeSelectorWidth !== rs.width) {
        state.rangeSelectorWidth = rs.width;
        state.rangePreviewValid = false;
      }
    }
    if (rs.position === "top" || rs.position === "bottom") {
      state.rangeSelectorPosition = rs.position;
    }
    if (rs.height !== undefined) state.rangeSelectorHeight = rs.height;
    if (rs.gap !== undefined) state.rangeSelectorGap = rs.gap;
    if (rs.effect) state.rangeSelectorEffect = rs.effect;
    if (rs.borderRadius !== undefined) state.rangeBorderRadius = rs.borderRadius;
    if (rs.overlayColor) state.rangeOverlayColor = rs.overlayColor;
    if (rs.handleColor) state.rangeHandleColor = rs.handleColor;
    if (rs.gripColor) state.rangeGripColor = rs.gripColor;
    if (rs.handleBorderRadius !== undefined) state.rangeHandleBorderRadius = rs.handleBorderRadius;
    if (rs.borderColor) state.rangeBorderColor = rs.borderColor;
  }
}

/** Parse selection range styling config */
export function parseSelectionConfig(state: WorkerState, config: Record<string, any>): void {
  if (!config.selection) return;
  const s = config.selection;
  if (s.color) state.selectionColor = s.color;
  if (s.borderColor) state.selectionBorderColor = s.borderColor;
  if (Number.isFinite(s.borderWidth) && s.borderWidth >= 0)
    state.selectionBorderWidth = s.borderWidth;
  if (s.borderStyle === "solid" || s.borderStyle === "dashed" || s.borderStyle === "dotted")
    state.selectionBorderStyle = s.borderStyle;
}

/** Parse labels config and apply to worker state */
export function parseLabelsConfig(state: WorkerState, labels: Record<string, any>): void {
  if (labels.top) {
    state.labelTopText = labels.top.text ?? "";
    if (labels.top.font) {
      const f = labels.top.font;
      if (f.size !== undefined) state.labelTopFontSize = f.size;
      if (f.weight !== undefined) state.labelTopFontWeight = f.weight;
      if (f.color) state.labelTopFontColor = f.color;
      if (f.family) state.labelTopFontFamily = f.family;
    }
    if (labels.top.align) state.labelTopAlign = labels.top.align;
    if ("direction" in labels.top)
      state.labelTopDirection = parseTextDirection(labels.top.direction);
    if (labels.top.padding) {
      const p = labels.top.padding;
      if (p.top !== undefined) state.labelTopPad.top = p.top;
      if (p.right !== undefined) state.labelTopPad.right = p.right;
      if (p.bottom !== undefined) state.labelTopPad.bottom = p.bottom;
      if (p.left !== undefined) state.labelTopPad.left = p.left;
    }
  }
  if (labels.bottom) {
    state.labelBottomText = labels.bottom.text ?? "";
    if (labels.bottom.font) {
      const f = labels.bottom.font;
      if (f.size !== undefined) state.labelBottomFontSize = f.size;
      if (f.weight !== undefined) state.labelBottomFontWeight = f.weight;
      if (f.color) state.labelBottomFontColor = f.color;
      if (f.family) state.labelBottomFontFamily = f.family;
    }
    if (labels.bottom.align) state.labelBottomAlign = labels.bottom.align;
    if ("direction" in labels.bottom)
      state.labelBottomDirection = parseTextDirection(labels.bottom.direction);
    if (labels.bottom.padding) {
      const p = labels.bottom.padding;
      if (p.top !== undefined) state.labelBottomPad.top = p.top;
      if (p.right !== undefined) state.labelBottomPad.right = p.right;
      if (p.bottom !== undefined) state.labelBottomPad.bottom = p.bottom;
      if (p.left !== undefined) state.labelBottomPad.left = p.left;
    }
  }
  if (labels.left) {
    state.labelLeftText = labels.left.text ?? "";
    if (labels.left.font) {
      const f = labels.left.font;
      if (f.size !== undefined) state.labelLeftFontSize = f.size;
      if (f.weight !== undefined) state.labelLeftFontWeight = f.weight;
      if (f.color) state.labelLeftFontColor = f.color;
      if (f.family) state.labelLeftFontFamily = f.family;
    }
    if (labels.left.align) state.labelLeftAlign = labels.left.align;
    if ("direction" in labels.left)
      state.labelLeftDirection = parseTextDirection(labels.left.direction);
    if (labels.left.padding) {
      const p = labels.left.padding;
      if (p.top !== undefined) state.labelLeftPad.top = p.top;
      if (p.right !== undefined) state.labelLeftPad.right = p.right;
      if (p.bottom !== undefined) state.labelLeftPad.bottom = p.bottom;
      if (p.left !== undefined) state.labelLeftPad.left = p.left;
    }
  }
  if (labels.right) {
    state.labelRightText = labels.right.text ?? "";
    if (labels.right.font) {
      const f = labels.right.font;
      if (f.size !== undefined) state.labelRightFontSize = f.size;
      if (f.weight !== undefined) state.labelRightFontWeight = f.weight;
      if (f.color) state.labelRightFontColor = f.color;
      if (f.family) state.labelRightFontFamily = f.family;
    }
    if (labels.right.align) state.labelRightAlign = labels.right.align;
    if ("direction" in labels.right)
      state.labelRightDirection = parseTextDirection(labels.right.direction);
    if (labels.right.padding) {
      const p = labels.right.padding;
      if (p.top !== undefined) state.labelRightPad.top = p.top;
      if (p.right !== undefined) state.labelRightPad.right = p.right;
      if (p.bottom !== undefined) state.labelRightPad.bottom = p.bottom;
      if (p.left !== undefined) state.labelRightPad.left = p.left;
    }
  }
  if (Array.isArray(labels.custom)) {
    state.customLabels = labels.custom.map((l: any) => ({
      text: l.text ?? "",
      x: l.x ?? 0,
      y: l.y ?? 0,
      fontSize: l.font?.size ?? 12,
      fontWeight: l.font?.weight ?? "normal",
      fontColor: l.font?.color ?? "#ffffff",
      fontFamily: l.font?.family ?? DEFAULT_CHART_FONT_FAMILY,
      align: l.align ?? "left",
      baseline: l.baseline ?? "top",
      direction: parseTextDirection(l.direction),
      rotate: l.rotate ?? 0,
      relativeTo: l.relativeTo ?? "chart",
    }));
  }
}

function parseOverlayCoordUnit(unit: unknown): OverlayCoordUnit {
  return unit === "px" ? "px" : "ratio";
}

function parseOverlayRelativeTo(value: unknown): OverlayRelativeTo {
  return value === "canvas" ? "canvas" : "chart";
}

function parseOverlayXAnchor(value: unknown): OverlayXAnchor {
  if (value === "right" || value === "end") return "right";
  return "left";
}

function parseOverlayYAnchor(value: unknown): OverlayYAnchor {
  if (value === "bottom" || value === "end") return "bottom";
  return "top";
}

function clampOverlayOpacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function parseOverlayStrokeDash(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const dash = value.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0,
  );
  return dash.length > 0 ? dash : [];
}

/** Parse overlay primitive config and apply to worker state */
export function parseOverlayConfig(
  state: WorkerState,
  overlay: Record<string, any> | null | undefined,
): void {
  const previousItems = state.overlayItems;
  if (!overlay) {
    state.overlayItems = [];
    releaseOwnedOverlayImages(state, previousItems);
    return;
  }

  const rawItems = Array.isArray(overlay) ? overlay : overlay.items;
  const receivedOwnedImages = collectReceivedOwnedOverlayImages(rawItems);
  if (!Array.isArray(rawItems)) {
    closeUnretainedOwnedOverlayImages(state, receivedOwnedImages);
    state.overlayItems = [];
    releaseOwnedOverlayImages(state, previousItems);
    return;
  }

  const parsed: OverlayItemState[] = [];

  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;

    const kind =
      raw.kind === "rect" ||
      raw.kind === "circle" ||
      raw.kind === "line" ||
      raw.kind === "image" ||
      raw.kind === "text"
        ? raw.kind
        : "text";

    const x = Number.isFinite(raw.x) ? raw.x : 0;
    const y = Number.isFinite(raw.y) ? raw.y : 0;

    const common: OverlayItemBaseState = {
      kind,
      visible: raw.visible !== false,
      z: Number.isFinite(raw.z) ? raw.z : 0,
      opacity: clampOverlayOpacity(raw.opacity),
      x,
      y,
      xUnit: parseOverlayCoordUnit(raw.xUnit),
      yUnit: parseOverlayCoordUnit(raw.yUnit),
      xAnchor: parseOverlayXAnchor(raw.xAnchor),
      yAnchor: parseOverlayYAnchor(raw.yAnchor),
      relativeTo: parseOverlayRelativeTo(raw.relativeTo),
      rotate: Number.isFinite(raw.rotate) ? raw.rotate : 0,
    };

    if (kind === "text") {
      const text = raw.text ?? "";
      if (text === "") continue;
      parsed.push({
        ...common,
        kind: "text",
        text: String(text),
        fontSize: Number.isFinite(raw.font?.size) && raw.font.size > 0 ? raw.font.size : 12,
        fontWeight: raw.font?.weight ?? "normal",
        fontColor: raw.color ?? raw.font?.color ?? "#ffffff",
        fontFamily: raw.font?.family ?? DEFAULT_CHART_FONT_FAMILY,
        align: raw.align ?? "left",
        baseline: raw.baseline ?? "top",
        direction: parseTextDirection(raw.direction),
        maxWidth: Number.isFinite(raw.maxWidth) && raw.maxWidth > 0 ? raw.maxWidth : undefined,
      });
      continue;
    }

    if (kind === "rect") {
      if (!Number.isFinite(raw.width) || raw.width <= 0) continue;
      if (!Number.isFinite(raw.height) || raw.height <= 0) continue;
      parsed.push({
        ...common,
        kind: "rect",
        width: raw.width,
        height: raw.height,
        radius: Number.isFinite(raw.radius) && raw.radius > 0 ? raw.radius : 0,
        fillColor: raw.fill?.color,
        strokeColor: raw.stroke?.color,
        strokeWidth:
          Number.isFinite(raw.stroke?.width) && raw.stroke.width > 0 ? raw.stroke.width : 0,
        strokeDash: parseOverlayStrokeDash(raw.stroke?.dash),
      });
      continue;
    }

    if (kind === "circle") {
      if (!Number.isFinite(raw.radius) || raw.radius <= 0) continue;
      parsed.push({
        ...common,
        kind: "circle",
        radius: raw.radius,
        fillColor: raw.fill?.color,
        strokeColor: raw.stroke?.color,
        strokeWidth:
          Number.isFinite(raw.stroke?.width) && raw.stroke.width > 0 ? raw.stroke.width : 0,
        strokeDash: parseOverlayStrokeDash(raw.stroke?.dash),
      });
      continue;
    }

    if (kind === "line") {
      if (!Number.isFinite(raw.x2) || !Number.isFinite(raw.y2)) continue;
      parsed.push({
        ...common,
        kind: "line",
        x2: raw.x2,
        y2: raw.y2,
        x2Unit: parseOverlayCoordUnit(raw.x2Unit),
        y2Unit: parseOverlayCoordUnit(raw.y2Unit),
        x2Anchor: parseOverlayXAnchor(raw.x2Anchor),
        y2Anchor: parseOverlayYAnchor(raw.y2Anchor),
        strokeColor: raw.stroke?.color ?? "#ffffff",
        strokeWidth:
          Number.isFinite(raw.stroke?.width) && raw.stroke.width > 0 ? raw.stroke.width : 1,
        strokeDash: parseOverlayStrokeDash(raw.stroke?.dash),
      });
      continue;
    }

    if (kind === "image") {
      if (!Number.isFinite(raw.width) || raw.width <= 0) continue;
      if (!Number.isFinite(raw.height) || raw.height <= 0) continue;

      const source = raw.image ?? raw.src;
      if (!source || typeof source !== "object") continue;

      parsed.push({
        ...common,
        kind: "image",
        image: source as CanvasImageSource,
        width: raw.width,
        height: raw.height,
        fit: raw.fit === "contain" || raw.fit === "cover" || raw.fit === "fill" ? raw.fit : "fill",
        ownsImageBitmap: raw.__sixtyfoldOwnsImageBitmap === true,
      });
    }
  }

  parsed.sort((a, b) => a.z - b.z);
  for (const item of parsed) {
    if (item.kind === "image" && item.ownsImageBitmap) {
      retainOwnedImageBitmap(state, item.image as object);
    }
  }
  // An internally decoded/transferred bitmap can arrive in a malformed item.
  // It never enters `parsed`, so close it unless another live renderer surface
  // already owns the same object. Do this before releasing the previous overlay
  // so a rejected replacement of an existing image is still closed exactly once.
  closeUnretainedOwnedOverlayImages(state, receivedOwnedImages);
  state.overlayItems = parsed;
  releaseOwnedOverlayImages(state, previousItems);
}

function collectReceivedOwnedOverlayImages(rawItems: unknown): Set<object> {
  const images = new Set<object>();
  const candidates = Array.isArray(rawItems) ? rawItems : [rawItems];
  for (const raw of candidates) {
    if (
      !raw ||
      typeof raw !== "object" ||
      (raw as Record<string, any>).kind !== "image" ||
      (raw as Record<string, any>).__sixtyfoldOwnsImageBitmap !== true
    ) {
      continue;
    }
    const source = (raw as Record<string, any>).image ?? (raw as Record<string, any>).src;
    if (source && typeof source === "object") images.add(source);
  }
  return images;
}

function closeUnretainedOwnedOverlayImages(state: WorkerState, images: ReadonlySet<object>): void {
  for (const image of images) {
    if (!state.ownedImageBitmapRefCounts.has(image)) {
      (image as { close?: () => void }).close?.();
    }
  }
}

function releaseOwnedOverlayImages(state: WorkerState, items: readonly OverlayItemState[]): void {
  for (const item of items) {
    if (item.kind !== "image" || !item.ownsImageBitmap) continue;
    const image = item.image;
    if (!image || typeof image !== "object") continue;
    releaseOwnedImageBitmap(state, image);
  }
}

/** Measure label text and adjust padding to reserve space.
 *  Idempotent: resets padding to base before adding label space.
 *  Must be called after applyPadding() + savePaddingBase(). */
export function measureLabelSpace(state: WorkerState): void {
  resetPaddingFromBase(state);
  if (state.labelTopText) {
    state.labelTopSpace = state.labelTopPad.top + state.labelTopFontSize + state.labelTopPad.bottom;
    state.padding.top += state.labelTopSpace;
  }
  if (state.labelBottomText) {
    state.labelBottomSpace =
      state.labelBottomPad.top + state.labelBottomFontSize + state.labelBottomPad.bottom;
    state.padding.bottom += state.labelBottomSpace;
  }
  if (state.labelLeftText) {
    state.labelLeftSpace =
      state.labelLeftPad.left + state.labelLeftFontSize + state.labelLeftPad.right;
    state.padding.left += state.labelLeftSpace;
  }
  if (state.labelRightText) {
    state.labelRightSpace =
      state.labelRightPad.left + state.labelRightFontSize + state.labelRightPad.right;
    state.padding.right += state.labelRightSpace;
  }
  // Reserve space for axis ticks that extend outward from the chart area
  state.padding.top += Math.max(0, state.topAxisTickLength);
  state.padding.right += Math.max(0, state.rightAxisTickLength);
  state.padding.bottom += Math.max(0, state.bottomAxisTickLength);
  state.padding.left += Math.max(0, state.leftAxisTickLength);
}

/** Draw chart labels (title, axis labels) in the padding area */
export function drawLabels(ctx: RenderContext2D, state: WorkerState): void {
  const chartLeft = state.padding.left;
  const chartRight = state.width - state.padding.right;

  // Top label (title)
  if (state.labelTopText) {
    ctx.font = `${state.labelTopFontWeight} ${state.labelTopFontSize}px ${state.labelTopFontFamily}`;
    ctx.fillStyle = state.labelTopFontColor;
    // Text baseline at top of reserved space + top padding + font ascent
    const y =
      state.padding.top - state.labelTopSpace + state.labelTopPad.top + state.labelTopFontSize;

    const direction = applyCanvasTextDirection(
      ctx,
      state,
      state.labelTopText,
      state.labelTopDirection === "inherit" ? state.textDirection : state.labelTopDirection,
    );
    ctx.textAlign = resolveCanvasTextAlign(state.labelTopAlign, direction);
    const x = resolveLogicalEdgeX(state.labelTopAlign, direction, chartLeft, chartRight);
    ctx.fillText(state.labelTopText, x, y);
  }

  // Bottom label
  if (state.labelBottomText) {
    ctx.font = `${state.labelBottomFontWeight} ${state.labelBottomFontSize}px ${state.labelBottomFontFamily}`;
    ctx.fillStyle = state.labelBottomFontColor;
    // Original bottom padding (without label space) positions x-axis labels
    const chartBottom = state.chartTop + state.chartHeight;
    const originalBottomPad = state.padding.bottom - state.labelBottomSpace;
    const y =
      chartBottom + originalBottomPad + state.labelBottomPad.top + state.labelBottomFontSize;

    const direction = applyCanvasTextDirection(
      ctx,
      state,
      state.labelBottomText,
      state.labelBottomDirection === "inherit" ? state.textDirection : state.labelBottomDirection,
    );
    ctx.textAlign = resolveCanvasTextAlign(state.labelBottomAlign, direction);
    const x = resolveLogicalEdgeX(state.labelBottomAlign, direction, chartLeft, chartRight);
    ctx.fillText(state.labelBottomText, x, y);
  }

  // Left label (rotated CCW)
  if (state.labelLeftText) {
    ctx.save();
    ctx.font = `${state.labelLeftFontWeight} ${state.labelLeftFontSize}px ${state.labelLeftFontFamily}`;
    ctx.fillStyle = state.labelLeftFontColor;
    ctx.textBaseline = "middle";

    const cTop = state.chartTop;
    const cBottom = state.chartTop + state.chartHeight;
    const align = state.labelLeftAlign;
    const direction = applyCanvasTextDirection(
      ctx,
      state,
      state.labelLeftText,
      state.labelLeftDirection === "inherit" ? state.textDirection : state.labelLeftDirection,
    );
    const posY = align === "top" ? cTop : align === "bottom" ? cBottom : (cTop + cBottom) / 2;
    // After CCW rotation: textAlign right → anchored at chart top, left → at chart bottom
    const physicalAlign = align === "top" ? "right" : align === "bottom" ? "left" : "center";
    ctx.textAlign = resolveCanvasTextAlign(physicalAlign, direction);
    // X position: left edge of reserved space + left padding + half font size (center of glyph)
    const x =
      state.padding.left -
      state.labelLeftSpace +
      state.labelLeftPad.left +
      state.labelLeftFontSize / 2;

    ctx.translate(x, posY);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(state.labelLeftText, 0, 0);
    ctx.restore();
  }

  // Right label (rotated CW)
  if (state.labelRightText) {
    ctx.save();
    ctx.font = `${state.labelRightFontWeight} ${state.labelRightFontSize}px ${state.labelRightFontFamily}`;
    ctx.fillStyle = state.labelRightFontColor;
    ctx.textBaseline = "middle";

    const cTop = state.chartTop;
    const cBottom = state.chartTop + state.chartHeight;
    const align = state.labelRightAlign;
    const direction = applyCanvasTextDirection(
      ctx,
      state,
      state.labelRightText,
      state.labelRightDirection === "inherit" ? state.textDirection : state.labelRightDirection,
    );
    const posY = align === "top" ? cTop : align === "bottom" ? cBottom : (cTop + cBottom) / 2;
    // After CW rotation: textAlign left → anchored at chart top, right → at chart bottom
    const physicalAlign = align === "top" ? "left" : align === "bottom" ? "right" : "center";
    ctx.textAlign = resolveCanvasTextAlign(physicalAlign, direction);
    // X position: right edge of chart + right padding from axis + half font size
    const x =
      state.width - state.padding.right + state.labelRightPad.left + state.labelRightFontSize / 2;

    ctx.translate(x, posY);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(state.labelRightText, 0, 0);
    ctx.restore();
  }

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/** Draw custom free-form labels (foreground overlay, drawn on main canvas) */
function getOverlayImageNaturalSize(
  image: CanvasImageSource,
): { width: number; height: number } | null {
  const anyImage = image as any;
  const width = Number(anyImage.width ?? anyImage.naturalWidth ?? 0);
  const height = Number(anyImage.height ?? anyImage.naturalHeight ?? 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function resolveOverlayCoord(
  origin: number,
  area: number,
  value: number,
  unit: OverlayCoordUnit,
  anchorFromEnd: boolean,
): number {
  if (unit === "px") {
    return anchorFromEnd ? origin + area - value : origin + value;
  }
  return anchorFromEnd ? origin + area * (1 - value) : origin + value * area;
}

export function drawCustomLabels(ctx: RenderContext2D, state: WorkerState): void {
  for (const label of state.customLabels) {
    if (!label.text) continue;

    let originX: number, originY: number, areaW: number, areaH: number;
    if (label.relativeTo === "canvas") {
      originX = 0;
      originY = 0;
      areaW = state.width;
      areaH = state.height;
    } else {
      originX = state.padding.left;
      originY = state.chartTop;
      areaW = state.chartWidth;
      areaH = state.chartHeight;
    }

    // [0,1] → fraction of area, otherwise pixels offset from origin
    const px = label.x >= 0 && label.x <= 1 ? originX + label.x * areaW : originX + label.x;
    const py = label.y >= 0 && label.y <= 1 ? originY + label.y * areaH : originY + label.y;

    ctx.save();
    ctx.font = `${label.fontWeight} ${label.fontSize}px ${label.fontFamily}`;
    ctx.fillStyle = label.fontColor;
    const direction = applyCanvasTextDirection(
      ctx,
      state,
      label.text,
      label.direction === "inherit" ? state.textDirection : label.direction,
    );
    ctx.textAlign = resolveCanvasTextAlign(label.align, direction);
    ctx.textBaseline = label.baseline;

    if (label.rotate !== 0) {
      ctx.translate(px, py);
      ctx.rotate((label.rotate * Math.PI) / 180);
      ctx.fillText(label.text, 0, 0);
    } else {
      ctx.fillText(label.text, px, py);
    }
    ctx.restore();
  }

  // Draw declarative overlay primitives
  for (const item of state.overlayItems) {
    if (!item.visible) continue;

    let originX: number, originY: number, areaW: number, areaH: number;
    if (item.relativeTo === "canvas") {
      originX = 0;
      originY = 0;
      areaW = state.width;
      areaH = state.height;
    } else {
      originX = state.padding.left;
      originY = state.chartTop;
      areaW = state.chartWidth;
      areaH = state.chartHeight;
    }

    const px = resolveOverlayCoord(originX, areaW, item.x, item.xUnit, item.xAnchor === "right");
    const py = resolveOverlayCoord(originY, areaH, item.y, item.yUnit, item.yAnchor === "bottom");

    ctx.save();
    if (item.opacity < 1) {
      ctx.globalAlpha = ctx.globalAlpha * item.opacity;
    }

    if (item.kind === "text") {
      ctx.font = `${item.fontWeight} ${item.fontSize}px ${item.fontFamily}`;
      ctx.fillStyle = item.fontColor;
      const direction = applyCanvasTextDirection(
        ctx,
        state,
        item.text,
        item.direction === "inherit" ? state.textDirection : item.direction,
      );
      ctx.textAlign = resolveCanvasTextAlign(item.align, direction);
      ctx.textBaseline = item.baseline;

      if (item.rotate !== 0) {
        ctx.translate(px, py);
        ctx.rotate((item.rotate * Math.PI) / 180);
        if (item.maxWidth !== undefined) ctx.fillText(item.text, 0, 0, item.maxWidth);
        else ctx.fillText(item.text, 0, 0);
      } else if (item.maxWidth !== undefined) {
        ctx.fillText(item.text, px, py, item.maxWidth);
      } else {
        ctx.fillText(item.text, px, py);
      }

      ctx.restore();
      continue;
    }

    if (item.kind === "rect") {
      if (item.rotate !== 0) {
        ctx.translate(px, py);
        ctx.rotate((item.rotate * Math.PI) / 180);
      }
      const rx = item.rotate !== 0 ? 0 : px;
      const ry = item.rotate !== 0 ? 0 : py;

      if (item.fillColor) {
        ctx.beginPath();
        drawRoundedRect(ctx, rx, ry, item.width, item.height, item.radius);
        ctx.fillStyle = item.fillColor;
        ctx.fill();
      }

      if (item.strokeColor && item.strokeWidth > 0) {
        ctx.beginPath();
        drawRoundedRect(ctx, rx, ry, item.width, item.height, item.radius);
        ctx.strokeStyle = item.strokeColor;
        ctx.lineWidth = item.strokeWidth;
        ctx.setLineDash(item.strokeDash);
        ctx.stroke();
      }

      ctx.restore();
      continue;
    }

    if (item.kind === "circle") {
      const cx = px;
      const cy = py;

      if (item.fillColor) {
        ctx.beginPath();
        ctx.arc(cx, cy, item.radius, 0, Math.PI * 2);
        ctx.fillStyle = item.fillColor;
        ctx.fill();
      }

      if (item.strokeColor && item.strokeWidth > 0) {
        ctx.beginPath();
        ctx.arc(cx, cy, item.radius, 0, Math.PI * 2);
        ctx.strokeStyle = item.strokeColor;
        ctx.lineWidth = item.strokeWidth;
        ctx.setLineDash(item.strokeDash);
        ctx.stroke();
      }

      ctx.restore();
      continue;
    }

    if (item.kind === "line") {
      const px2 = resolveOverlayCoord(
        originX,
        areaW,
        item.x2,
        item.x2Unit,
        item.x2Anchor === "right",
      );
      const py2 = resolveOverlayCoord(
        originY,
        areaH,
        item.y2,
        item.y2Unit,
        item.y2Anchor === "bottom",
      );

      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px2, py2);
      ctx.strokeStyle = item.strokeColor;
      ctx.lineWidth = item.strokeWidth;
      ctx.setLineDash(item.strokeDash);
      ctx.stroke();
      ctx.restore();
      continue;
    }

    if (item.kind === "image") {
      const drawImageWithFit = (x: number, y: number): void => {
        const targetW = item.width;
        const targetH = item.height;

        if (item.fit === "fill") {
          ctx.drawImage(item.image, x, y, targetW, targetH);
          return;
        }

        const size = getOverlayImageNaturalSize(item.image);
        if (!size) {
          ctx.drawImage(item.image, x, y, targetW, targetH);
          return;
        }

        const srcRatio = size.width / size.height;
        const dstRatio = targetW / targetH;
        let drawW = targetW;
        let drawH = targetH;
        let drawX = x;
        let drawY = y;

        const containByWidth = item.fit === "contain" ? srcRatio > dstRatio : srcRatio < dstRatio;

        if (containByWidth) {
          drawW = targetW;
          drawH = targetW / srcRatio;
          drawY = y + (targetH - drawH) / 2;
        } else {
          drawH = targetH;
          drawW = targetH * srcRatio;
          drawX = x + (targetW - drawW) / 2;
        }

        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, targetW, targetH);
        ctx.clip();
        ctx.drawImage(item.image, drawX, drawY, drawW, drawH);
        ctx.restore();
      };

      if (item.rotate !== 0) {
        ctx.translate(px, py);
        ctx.rotate((item.rotate * Math.PI) / 180);
        drawImageWithFit(0, 0);
      } else {
        drawImageWithFit(px, py);
      }
      ctx.restore();
      continue;
    }

    ctx.restore();
  }
}

/** Detect whether the canvas 2D context supports the `filter` property. */
function detectCanvasFilterSupport(state: WorkerState): boolean {
  if (state.canvasFilterSupported !== null) return state.canvasFilterSupported;
  try {
    const testCanvas = state.createCanvas(1, 1);
    const testCtx = get2dContext(testCanvas);
    if (!("filter" in testCtx)) {
      state.canvasFilterSupported = false;
      return false;
    }
    (testCtx as any).filter = "blur(1px)";
    state.canvasFilterSupported = (testCtx as any).filter === "blur(1px)";
  } catch {
    state.canvasFilterSupported = false;
  }
  return state.canvasFilterSupported;
}

function drawTooltipBackdropBlur(
  ctx: RenderContext2D,
  state: WorkerState,
  boxX: number,
  boxY: number,
  boxWidth: number,
  boxHeight: number,
): void {
  const blurRadius = state.tooltipBackdropBlur;
  if (!(blurRadius > 0) || !state.canvas) return;
  if (!detectCanvasFilterSupport(state)) return;

  // Capture a slightly larger area to avoid hard blur cut-offs at the tooltip edge.
  const spread = Math.max(2, Math.ceil(blurRadius * 2));
  let srcX = Math.floor(boxX - spread);
  let srcY = Math.floor(boxY - spread);
  let srcW = Math.ceil(boxWidth + spread * 2);
  let srcH = Math.ceil(boxHeight + spread * 2);

  if (srcX < 0) {
    srcW += srcX;
    srcX = 0;
  }
  if (srcY < 0) {
    srcH += srcY;
    srcY = 0;
  }
  if (srcX + srcW > state.width) srcW = state.width - srcX;
  if (srcY + srcH > state.height) srcH = state.height - srcY;
  if (srcW <= 0 || srcH <= 0) return;

  const srcXpx = Math.max(0, Math.floor(srcX * state.dpr));
  const srcYpx = Math.max(0, Math.floor(srcY * state.dpr));
  let srcWpx = Math.max(1, Math.ceil(srcW * state.dpr));
  let srcHpx = Math.max(1, Math.ceil(srcH * state.dpr));

  if (srcXpx + srcWpx > state.canvas.width) srcWpx = state.canvas.width - srcXpx;
  if (srcYpx + srcHpx > state.canvas.height) srcHpx = state.canvas.height - srcYpx;
  if (srcWpx <= 0 || srcHpx <= 0) return;

  if (
    !state.tooltipBackdropCanvas ||
    state.tooltipBackdropCanvas.width !== srcWpx ||
    state.tooltipBackdropCanvas.height !== srcHpx
  ) {
    state.tooltipBackdropCanvas = state.createCanvas(srcWpx, srcHpx);
    state.tooltipBackdropCtx = get2dContext(state.tooltipBackdropCanvas);
  }

  const blurCtx = state.tooltipBackdropCtx;
  if (!blurCtx) return;

  blurCtx.setTransform(1, 0, 0, 1, 0, 0);
  blurCtx.clearRect(0, 0, srcWpx, srcHpx);
  blurCtx.drawImage(
    state.canvas as CanvasImageSource,
    srcXpx,
    srcYpx,
    srcWpx,
    srcHpx,
    0,
    0,
    srcWpx,
    srcHpx,
  );

  ctx.save();
  ctx.beginPath();
  drawRoundedRect(ctx, boxX, boxY, boxWidth, boxHeight, state.tooltipBorderRadius);
  ctx.clip();
  (ctx as any).filter = `blur(${blurRadius}px) saturate(112%)`;
  ctx.drawImage(
    state.tooltipBackdropCanvas as CanvasImageSource,
    0,
    0,
    srcWpx,
    srcHpx,
    srcX,
    srcY,
    srcW,
    srcH,
  );
  (ctx as any).filter = "none";
  ctx.restore();
}

/** Reset the tooltip width ratchet (call when tooltip is no longer shown). */
export function resetTooltipRatchet(state: WorkerState): void {
  state.tooltipRatchetWidth = 0;
}

/** Render tooltip box with two-column layout (shared between line and stock workers) */
export function renderTooltipBox(
  ctx: RenderContext2D,
  state: WorkerState,
  content: TooltipContent,
  crosshairScreenX: number,
  borderColorOverride?: string,
): void {
  if (!content.visible) {
    state.tooltipRatchetWidth = 0;
    return;
  }

  const chartBottom = state.chartTop + state.chartHeight;
  const padTop = state.tooltipPaddingTop;
  const padRight = state.tooltipPaddingRight;
  const padBottom = state.tooltipPaddingBottom;
  const padLeft = state.tooltipPaddingLeft;
  const showSwatch = state.tooltipShowSwatch;
  const swatchSize = showSwatch ? 8 : 0;
  const swatchGap = showSwatch ? 6 : 0;
  const rowGap = 4;
  const columnGap = 12;

  // Measure title
  const titleFont = `${state.tooltipTitleFontWeight} ${state.tooltipTitleFontSize}px ${state.tooltipTitleFontFamily}`;
  ctx.font = titleFont;
  const tooltipDirection = applyCanvasTextDirection(
    ctx,
    state,
    content.title || content.rows[0]?.label || content.rows[0]?.value || "",
    state.tooltipDirection === "inherit" ? state.textDirection : state.tooltipDirection,
  );
  const isRtl = isRtlTextDirection(tooltipDirection);
  const titleWidth = ctx.measureText(content.title).width;
  const titleHeight = state.tooltipTitleFontSize + 4;

  // Measure rows to find column widths
  const labelFont = `${state.tooltipLabelFontWeight} ${state.tooltipLabelFontSize}px ${state.tooltipLabelFontFamily}`;
  const valueFont = `${state.tooltipValueFontWeight} ${state.tooltipValueFontSize}px ${state.tooltipValueFontFamily}`;
  const rowHeight = Math.max(state.tooltipLabelFontSize, state.tooltipValueFontSize) + rowGap;

  let maxLabelWidth = 0;
  let maxValueWidth = 0;

  for (const row of content.rows) {
    ctx.font = labelFont;
    applyCanvasTextDirection(
      ctx,
      state,
      row.label,
      state.tooltipDirection === "inherit" ? state.textDirection : state.tooltipDirection,
    );
    const lw = ctx.measureText(row.label).width;
    if (lw > maxLabelWidth) maxLabelWidth = lw;

    ctx.font = valueFont;
    applyCanvasTextDirection(
      ctx,
      state,
      row.value,
      state.tooltipDirection === "inherit" ? state.textDirection : state.tooltipDirection,
    );
    const vw = ctx.measureText(row.value).width;
    if (vw > maxValueWidth) maxValueWidth = vw;
  }

  // Box dimensions — fixed width if set, otherwise ratchet prevents shrinking
  const rowContentWidth = swatchSize + swatchGap + maxLabelWidth + columnGap + maxValueWidth;
  const innerWidth = Math.max(titleWidth, rowContentWidth);
  const naturalWidth = padLeft + innerWidth + padRight;
  const boxWidth =
    state.tooltipFixedWidth > 0
      ? state.tooltipFixedWidth
      : Math.max(naturalWidth, state.tooltipRatchetWidth);
  state.tooltipRatchetWidth = boxWidth;
  const boxHeight = padTop + titleHeight + content.rows.length * rowHeight + padBottom;

  // Position box
  const boxPos = calculateTooltipPosition(
    state,
    chartBottom,
    boxWidth,
    boxHeight,
    crosshairScreenX,
  );
  const boxX = boxPos.x;
  const boxY = boxPos.y;

  drawTooltipBackdropBlur(ctx, state, boxX, boxY, boxWidth, boxHeight);

  // Draw box background (with optional shadow)
  ctx.save();
  if (state.tooltipShadowEnabled) {
    ctx.shadowColor = state.tooltipShadowColor;
    ctx.shadowBlur = state.tooltipShadowBlur;
    ctx.shadowOffsetX = state.tooltipShadowOffsetX;
    ctx.shadowOffsetY = state.tooltipShadowOffsetY;
  }
  ctx.beginPath();
  drawRoundedRect(ctx, boxX, boxY, boxWidth, boxHeight, state.tooltipBorderRadius);
  ctx.fillStyle = state.tooltipBackgroundColor;
  ctx.fill();
  ctx.restore();

  // Draw border without shadow so it doesn't create a second dark outline
  const borderWidth =
    Number.isFinite(state.tooltipBorderWidth) && state.tooltipBorderWidth > 0
      ? state.tooltipBorderWidth
      : 0;
  if (borderWidth > 0) {
    ctx.save();
    ctx.beginPath();
    drawRoundedRect(ctx, boxX, boxY, boxWidth, boxHeight, state.tooltipBorderRadius);
    ctx.strokeStyle = borderColorOverride ?? state.tooltipBorderColor;
    ctx.lineWidth = borderWidth;
    ctx.setLineDash(DASH_PATTERNS[state.tooltipBorderStyle] ?? DASH_PATTERNS.solid);
    ctx.stroke();
    ctx.restore();
  }

  // Draw title
  ctx.font = titleFont;
  ctx.fillStyle = state.tooltipTitleFontColor;
  applyCanvasTextDirection(
    ctx,
    state,
    content.title,
    state.tooltipDirection === "inherit" ? state.textDirection : state.tooltipDirection,
  );
  ctx.textAlign = isRtl ? "right" : "left";
  ctx.fillText(
    content.title,
    isRtl ? boxX + boxWidth - padRight : boxX + padLeft,
    boxY + padTop + state.tooltipTitleFontSize,
  );

  // Draw rows (two-column layout)
  const rowStartY = boxY + padTop + titleHeight;
  const valueEdgeX = isRtl ? boxX + padLeft : boxX + boxWidth - padRight;
  const labelEdgeX = isRtl
    ? boxX + boxWidth - padRight - swatchSize - swatchGap
    : boxX + padLeft + swatchSize + swatchGap;

  for (let i = 0; i < content.rows.length; i++) {
    const row = content.rows[i];
    const y =
      rowStartY + i * rowHeight + Math.max(state.tooltipLabelFontSize, state.tooltipValueFontSize);

    const alpha = row.dimmed ? 0.6 : 1.0;
    ctx.globalAlpha = alpha;

    // Color swatch
    if (showSwatch) {
      ctx.fillStyle = row.color;
      ctx.fillRect(isRtl ? boxX + boxWidth - padRight - swatchSize : boxX + padLeft, y - 8, 8, 8);
    }

    // Label
    ctx.font = labelFont;
    ctx.fillStyle = state.tooltipLabelFontColor;
    applyCanvasTextDirection(
      ctx,
      state,
      row.label,
      state.tooltipDirection === "inherit" ? state.textDirection : state.tooltipDirection,
    );
    ctx.textAlign = isRtl ? "right" : "left";
    ctx.fillText(row.label, labelEdgeX, y);

    // Value
    ctx.font = valueFont;
    ctx.fillStyle = state.tooltipValueFontColor || row.color;
    applyCanvasTextDirection(
      ctx,
      state,
      row.value,
      state.tooltipDirection === "inherit" ? state.textDirection : state.tooltipDirection,
    );
    ctx.textAlign = isRtl ? "left" : "right";
    ctx.fillText(row.value, valueEdgeX, y);

    ctx.globalAlpha = 1;
  }

  ctx.textAlign = "left"; // Reset
}

/** Handle tooltipContent message from main thread.
 *  Returns true if handled. */
export function handleTooltipContentMessage(
  state: WorkerState,
  data: Record<string, unknown>,
  defaultColor: string | ((index: number) => string),
): boolean {
  // Ignore stale responses from a previous data point
  if (data.dataX !== undefined && data.dataX !== state.tooltipLastDataX) return true;
  const result = data.content as any;
  if (!result) {
    state.tooltipCustomContent = null;
  } else {
    const rows: TooltipContent["rows"] = [];
    if (result.rows) {
      for (let i = 0; i < result.rows.length; i++) {
        const row = result.rows[i];
        const fallbackColor = typeof defaultColor === "function" ? defaultColor(i) : defaultColor;
        rows.push({
          label: row.label,
          value: row.value,
          color: row.color || fallbackColor,
          dimmed: row.dimmed ?? false,
        });
      }
    }
    state.tooltipCustomContent = {
      visible: result.visible !== false,
      title: result.title ?? "",
      rows,
    };
  }
  return true;
}

// Handle common messages
export function handleBaseMessage(
  state: WorkerState,
  type: string,
  data: Record<string, unknown>,
  minRange: number,
): boolean {
  switch (type) {
    case "resize":
      if (state.canvas && state.ctx) {
        // The device pixel ratio can change without the element resizing
        // (window dragged to another monitor, browser zoom). Honor an updated
        // dpr supplied with the resize so the backing store stays crisp.
        if (Number.isFinite(data.dpr as number) && (data.dpr as number) > 0) {
          state.dpr = data.dpr as number;
        }
        // Floor the backing-store size. Browsers coerce canvas.width/height to
        // an integer (truncating) anyway; flooring here keeps node-canvas (SSR)
        // consistent with both the browser and the SSR pre-size.
        state.canvas.width = Math.floor((data.width as number) * state.dpr);
        state.canvas.height = Math.floor((data.height as number) * state.dpr);
        state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
        state.updateDimensions();
        state.cacheValid = false;
        state.rangePreviewValid = false;
      }
      return true;

    case "zoom":
      zoom(state, data.factor as number, data.centerX as number, minRange);
      gridSnapStates.add(state);
      return true;

    case "viewportInputBatch": {
      if (!Array.isArray(data.commands)) return true;
      let handledViewportInput = false;
      for (const input of data.commands as ViewportInputCommand[]) {
        if (!input || typeof input !== "object") continue;
        if (input.type === "pan") {
          if (Number.isFinite(input.dx)) {
            pan(state, input.dx);
            handledViewportInput = true;
          }
        } else if (
          input.type === "zoom" &&
          Number.isFinite(input.factor) &&
          input.factor > 0 &&
          Number.isFinite(input.centerX)
        ) {
          zoom(state, input.factor, input.centerX, minRange);
          handledViewportInput = true;
        }
      }
      if (handledViewportInput) gridSnapStates.add(state);
      return true;
    }

    case "zoomAnimated":
      zoomAnimated(
        state,
        data.factor as number,
        data.centerX as number,
        minRange,
        performance.now(),
      );
      return true;

    case "pan":
      pan(state, data.dx as number);
      gridSnapStates.add(state);
      return true;

    case "panAnimated":
      panAnimated(state, data.dx as number, performance.now());
      return true;

    case "reset":
      reset(state);
      gridSnapStates.add(state);
      return true;

    case "resetAnimated":
      resetAnimated(state, performance.now());
      return true;

    case "setViewportRange":
      setViewportRange(
        state,
        data.xMin as number | undefined,
        data.xMax as number | undefined,
        minRange,
      );
      gridSnapStates.add(state);
      return true;

    case "setViewportRangeAnimated":
      setViewportRangeAnimated(
        state,
        data.xMin as number,
        data.xMax as number,
        minRange,
        performance.now(),
      );
      return true;

    case "setSelection":
      state.selectionStart = data.start as number;
      state.selectionEnd = data.end as number;
      return true;

    case "clearSelection":
      state.selectionStart = null;
      state.selectionEnd = null;
      return true;

    case "mousemove":
      state.mouseX = data.x as number;
      state.mouseY = data.y as number;
      state.pointerType = data.pointerType === "touch" ? "touch" : "mouse";
      state.mouseInChart = true;
      return true;

    case "mouseleave":
      state.mouseInChart = false;
      state.pointerType = "mouse";
      state.tooltipCustomContent = null;
      state.tooltipLastDataX = NaN;
      return true;

    case "start":
      return true; // Handled by specific worker

    case "setLabels":
      resetLabelState(state);
      parseLabelsConfig(state, data.labels as Record<string, any>);
      measureLabelSpace(state);
      state.updateDimensions();
      state.cacheValid = false;
      state.rangePreviewValid = false;
      return true;

    case "setOverlay":
      parseOverlayConfig(state, data.overlay as Record<string, any>);
      return true;

    case "setAnimated":
      state.animated = data.animated === true;
      if (!state.animated) {
        if (state.viewportAnimation.active) {
          state.viewport.xMin = state.viewportAnimation.toViewport.xMin;
          state.viewport.xMax = state.viewportAnimation.toViewport.xMax;
        }
        if (state.yAnimation.active) {
          state.viewport.yMin = state.yAnimation.toYMin;
          state.viewport.yMax = state.yAnimation.toYMax;
        }
        state.viewportAnimation.active = false;
        state.yAnimation.active = false;
        state.revealProgress = 1;
        state.cacheValid = false;
        state.rangePreviewValid = false;
      }
      return true;

    case "updateAppearance": {
      const patch = data.patch as Record<string, any>;
      parseTextDirectionConfig(state, patch);
      if (patch.tooltip) parseTooltipConfig(state, patch.tooltip);
      if (patch.crosshairStyle) parseCrosshairStyle(state, patch.crosshairStyle);
      if (patch.grid) parseGridConfig(state, patch.grid);
      if (patch.axis) parseAxisConfig(state, patch.axis);
      if (patch.chartBackground !== undefined) {
        replaceChartBackground(state, patch.chartBackground);
      }
      if (patch.rangeSelector)
        parseRangeSelectorConfig(state, { rangeSelector: patch.rangeSelector });
      if (patch.selection) parseSelectionConfig(state, { selection: patch.selection });
      if (patch.labels) {
        resetLabelState(state);
        parseLabelsConfig(state, patch.labels);
        measureLabelSpace(state);
      }
      if (patch.overlay) parseOverlayConfig(state, patch.overlay);
      if (patch.padding) {
        patchPaddingBase(state, patch.padding);
        measureLabelSpace(state);
      }
      state.updateDimensions();
      state.cacheValid = false;
      state.rangePreviewValid = false;
      return true;
    }

    case "invalidateCache":
      // Force full redraw - fixes Safari canvas corruption after tab backgrounded
      // Safari aggressively releases GPU resources, so we need to recreate cache canvases
      state.cacheCanvas = null;
      state.cacheCtx = null;
      state.cacheValid = false;
      state.rangePreviewCanvas = null;
      state.rangePreviewCtx = null;
      state.rangePreviewValid = false;
      // Retain the primary context: Firefox 159 rejects repeated getContext()
      // calls on transferred canvases. Only the disposable caches need rebuilding.
      // Leave primary context creation to init, even if the canvas is installed.
      if (state.ctx) {
        state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      }
      // Stop any active animations which may be in corrupted state
      state.viewportAnimation.active = false;
      state.yAnimation.active = false;
      state.revealProgress = 1; // Mark reveal as complete
      return true;

    default:
      return false;
  }
}
