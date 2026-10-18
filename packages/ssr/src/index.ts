import type { MultiSeriesData } from "@sixtyfold/core/data/seriesTypes";
import type { OHLCVData } from "@sixtyfold/stock/ohlcv";
import type { StockIndicator } from "@sixtyfold/stock/analytics";
import type {
  StockMarker,
  StockPriceLine,
  VolumeProfileOptions,
} from "@sixtyfold/stock/market-layers";
import type { CanvasLike, EngineCallbacks } from "@sixtyfold/core/internal/renderer";
import { DEFAULT_CURSOR_LABEL_COLOR } from "@sixtyfold/core/chart/chartConstants";
import { createLineChartEngine } from "@sixtyfold/line/engine";
import { createStockChartEngine } from "@sixtyfold/stock/engine";

/**
 * Minimal canvas contract required by the SSR renderer.
 *
 * This deliberately avoids DOM canvas globals so server-runtime TypeScript
 * projects can consume `@sixtyfold/ssr` without adding the DOM library.
 */
export interface SSRCanvas {
  width: number;
  height: number;
  getContext(type: "2d", options?: unknown): unknown;
}

/** Renderer-facing chart options accepted by the static render helpers. */
export interface SSRBaseChartOptions {
  padding?: { top?: number; right?: number; bottom?: number; left?: number };
  /**
   * Initial reveal setting (default: false). Leave disabled for complete static
   * output because an SSR render does not advance animation frames.
   */
  animated?: boolean;
  /** Smallest X viewport span, in the same units as the X data. */
  minViewportRange?: number;
  /** Fixed rendered Y-domain edges; omitted edges remain auto-scaled. */
  yDomain?: { min?: number; max?: number };
  textDirection?: "ltr" | "rtl" | "auto" | "inherit";
  grid?: object;
  axis?: object;
  chartBackground?: string | object;
  rangeSelector?: object;
  tooltip?: object;
  crosshairStyle?: object;
  labels?: object;
  overlay?: object;
}

/** Line-chart options supported by the SSR renderer. */
export interface SSRLineChartOptions extends SSRBaseChartOptions {
  interpolation?: "none" | "linear" | "spline";
  series?: readonly object[];
  marker?: object;
  legend?: object;
  lod?: {
    mode?: "adaptive" | "pyramid";
    density?: number;
    rebaseRatio?: number;
    quantizationStep?: number;
  };
}

/** Stock-chart options supported by the SSR renderer. */
export interface SSRStockChartOptions extends SSRBaseChartOptions {
  timeScale?: "continuous" | "market";
  showVolume?: boolean;
  volumeOpacity?: number;
  volumeHeightRatio?: number;
  volumeColors?: object;
  crosshairMarkerColor?: string;
  showLeftPriceMarker?: boolean;
  showRightPriceMarker?: boolean;
  candleStyle?: "filled" | "hollow" | "ohlc";
  candleColors?: object;
  candleStrokeWidth?: number;
  previewLineColor?: string;
  priceUnit?: object;
  volumeUnit?: object;
  indicators?: readonly StockIndicator[];
  volumeProfile?: VolumeProfileOptions | false;
  priceLines?: readonly StockPriceLine[];
  markers?: readonly StockMarker[];
}

export interface SSRRenderOptions {
  width: number;
  height: number;
  dpr?: number;
  createCanvas?: (width: number, height: number) => SSRCanvas;
}

function createCallbacks(): EngineCallbacks {
  return {
    postMessage: () => {
      // no-op for SSR
    },
  };
}

function resolveCreateCanvas(
  canvas: SSRCanvas,
  configured?: SSRRenderOptions["createCanvas"],
): NonNullable<SSRRenderOptions["createCanvas"]> {
  if (configured) return configured;
  return (width, height) => {
    const Ctor = (canvas as any).constructor;
    if (Ctor) {
      return new Ctor(width, height) as SSRCanvas;
    }
    // A spread copy ({ ...canvas }) would drop the prototype getContext and
    // produce a non-functional canvas. If we can't construct one, the caller
    // must supply renderOptions.createCanvas.
    throw new Error(
      "Unable to create an off-screen canvas for SSR. Pass renderOptions.createCanvas.",
    );
  };
}

export function renderLineChartSSR(
  canvas: SSRCanvas,
  data: MultiSeriesData,
  options: SSRLineChartOptions = {},
  renderOptions: SSRRenderOptions,
): SSRCanvas {
  const dpr = renderOptions.dpr ?? 1;
  canvas.width = Math.floor(renderOptions.width * dpr);
  canvas.height = Math.floor(renderOptions.height * dpr);

  const createCanvas = resolveCreateCanvas(canvas, renderOptions.createCanvas);

  const engine = createLineChartEngine(createCallbacks(), {
    createCanvas: createCanvas as unknown as (w: number, h: number) => CanvasLike,
    ssr: true,
  });

  engine.handleMessage("init", {
    canvas: canvas as unknown as CanvasLike,
    dpr,
    config: {
      padding: options.padding,
      animated: options.animated ?? false,
      minViewportRange: options.minViewportRange,
      yDomain: options.yDomain,
      grid: options.grid,
      axis: options.axis,
      chartBackground: options.chartBackground,
      textDirection: options.textDirection,
      rangeSelector: options.rangeSelector,
      tooltip: options.tooltip,
      crosshairStyle: options.crosshairStyle,
      labels: options.labels,
      overlay: options.overlay,
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
  });

  engine.handleMessage("resize", {
    width: renderOptions.width,
    height: renderOptions.height,
    dpr,
  });

  engine.handleMessage("setData", {
    x: data.x,
    series: data.series,
  });

  return canvas;
}

export function renderStockChartSSR(
  canvas: SSRCanvas,
  data: OHLCVData,
  options: SSRStockChartOptions = {},
  renderOptions: SSRRenderOptions,
): SSRCanvas {
  const dpr = renderOptions.dpr ?? 1;
  canvas.width = Math.floor(renderOptions.width * dpr);
  canvas.height = Math.floor(renderOptions.height * dpr);

  const createCanvas = resolveCreateCanvas(canvas, renderOptions.createCanvas);

  const engine = createStockChartEngine(createCallbacks(), {
    createCanvas: createCanvas as unknown as (w: number, h: number) => CanvasLike,
    ssr: true,
  });

  const axisOption = options.axis as Record<string, any> | undefined;
  const resolvedAxis =
    options.showLeftPriceMarker !== undefined || options.showRightPriceMarker !== undefined
      ? {
          ...axisOption,
          left: {
            ...axisOption?.left,
            cursorLabel: {
              ...axisOption?.left?.cursorLabel,
              visible: axisOption?.left?.cursorLabel?.visible ?? options.showLeftPriceMarker,
            },
          },
          right: {
            ...axisOption?.right,
            cursorLabel: {
              ...axisOption?.right?.cursorLabel,
              visible: axisOption?.right?.cursorLabel?.visible ?? options.showRightPriceMarker,
            },
          },
        }
      : options.axis;

  engine.handleMessage("init", {
    canvas: canvas as unknown as CanvasLike,
    dpr,
    config: {
      padding: options.padding,
      animated: options.animated ?? false,
      minViewportRange: options.minViewportRange,
      yDomain: options.yDomain,
      timeScale: options.timeScale ?? "continuous",
      grid: options.grid,
      axis: resolvedAxis,
      chartBackground: options.chartBackground,
      textDirection: options.textDirection,
      rangeSelector: options.rangeSelector,
      tooltip: options.tooltip,
      crosshairStyle: options.crosshairStyle,
      labels: options.labels,
      overlay: options.overlay,
      showVolume: options.showVolume ?? true,
      volumeOpacity: options.volumeOpacity ?? 0.35,
      volumeHeightRatio: options.volumeHeightRatio ?? 0.15,
      volumeColors: options.volumeColors,
      crosshairMarkerColor: options.crosshairMarkerColor ?? DEFAULT_CURSOR_LABEL_COLOR,
      candleStyle: options.candleStyle ?? "filled",
      candleColors: options.candleColors,
      candleStrokeWidth: options.candleStrokeWidth ?? 1,
      previewLineColor: options.previewLineColor ?? "#4a90d9",
      priceUnit: options.priceUnit,
      volumeUnit: options.volumeUnit,
      indicators: options.indicators,
      volumeProfile: options.volumeProfile,
      priceLines: options.priceLines,
      markers: options.markers,
    },
  });

  engine.handleMessage("resize", {
    width: renderOptions.width,
    height: renderOptions.height,
    dpr,
  });

  engine.handleMessage("setData", {
    timestamp: data.timestamp,
    open: data.open,
    high: data.high,
    low: data.low,
    close: data.close,
    volume: data.volume,
  });

  return canvas;
}
