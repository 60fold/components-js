// StockChart component - extends BaseChart for OHLCV candlestick rendering

import { normalizeOHLCVData, type OHLCVData } from "./ohlcv.js";
import {
  BaseChart,
  BaseChartOptions,
  UnitOptions,
  type TooltipOptions,
  type DeepReadonly,
  type BaseAppearanceOptions,
  type StockTooltipField,
  type Viewport,
} from "@sixtyfold/core/chart/BaseChart";
import { deepClone } from "@sixtyfold/core/chart/chartStateUtils";
import type {
  StockTooltipRenderParams,
  StockTooltipRenderResult,
} from "@sixtyfold/core/types/tooltip";
import StockWorker from "./stock.worker.ts?worker";
import { deserializeRendererError } from "@sixtyfold/core/internal/renderer";
import { DEFAULT_CURSOR_LABEL_COLOR, STOCK_MIN_RANGE } from "@sixtyfold/core/chart/chartConstants";
import type { StockIndicator } from "./analytics.js";
import type { StockMarker, StockPriceLine, VolumeProfileOptions } from "./marketLayers.js";

export type {
  StockMarker,
  StockMarkerPosition,
  StockMarkerShape,
  StockPriceLine,
  VolumeProfileOptions,
} from "./marketLayers.js";

// Debounce window after reset to ignore viewport change events from animation
const RESET_DEBOUNCE_MS = 100;
export const STOCK_TIME_RANGE_CHANGE_EVENT = "sixtyfold:time-range-change";
export const STOCK_CROSSHAIR_MOVE_EVENT = "sixtyfold:crosshair-move";
export const STOCK_VISIBLE_RANGE_CHANGE_EVENT = "sixtyfold:visible-range-change";

export const STOCK_TIME_RANGES = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "5Y", "ALL"] as const;
export type TimeRange = (typeof STOCK_TIME_RANGES)[number];
export type StockTimeScale = "continuous" | "market";
type TimeRangeChangeSource = "api" | "reset" | "data" | "interaction";
export type StockTooltipFieldLabels = Partial<Record<StockTooltipField, string>>;

export interface TimeRangeChangeDetail {
  range: TimeRange | null;
  previousRange: TimeRange | null;
  source: TimeRangeChangeSource;
}

export interface StockCrosshairIndicatorValue {
  id: string;
  label: string;
  value: number;
  formattedValue: string;
  color: string;
}

/** Stock candle and derived values under the active crosshair. */
export interface StockCrosshairMoveDetail {
  timestamp: number;
  screenX: number;
  screenY: number;
  candle: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  formatted: {
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  };
  change: number;
  changePercent: number;
  formattedChange: string;
  bullish: boolean;
  color: string;
  indicators?: StockCrosshairIndicatorValue[];
}

/** Renderer-synchronized visible X range and complete data extent. */
export interface StockVisibleRangeChangeDetail {
  viewport: { xMin: number; xMax: number };
  dataBounds: { xMin: number; xMax: number };
}

/** Style for rendering price data */
export type CandleStyle = "filled" | "hollow" | "ohlc";

export interface CandleColors {
  /** Color for up (bullish) candles - close >= open */
  up?: string;
  /** Color for down (bearish) candles - close < open */
  down?: string;
  /** Wick color for up candles (defaults to up color) */
  wickUp?: string;
  /** Wick color for down candles (defaults to down color) */
  wickDown?: string;
}

export interface VolumeColors {
  /** Color for volume bars when close >= open (defaults to candle up color) */
  up?: string;
  /** Color for volume bars when close < open (defaults to candle down color) */
  down?: string;
}

/** Tooltip options for stock charts - overrides onRender with stock-specific params */
export interface StockTooltipOptions extends Omit<TooltipOptions, "onRender"> {
  /** Custom render callback for stock tooltip content (called on main thread) */
  onRender?: (params: StockTooltipRenderParams) => StockTooltipRenderResult;
}

export interface StockChartOptions extends Omit<BaseChartOptions, "tooltip"> {
  /** Tooltip options with stock-specific onRender params */
  tooltip?: StockTooltipOptions;
  /** X-axis behavior. `market` compresses intervals without observations while preserving real timestamps in labels and events. */
  timeScale?: StockTimeScale;
  /** Called with the active preset, or `null` when the viewport no longer matches a named preset. */
  onTimeRangeChange?: (range: TimeRange | null) => void;
  /** Built-in worker-rendered technical indicators. */
  indicators?: StockIndicator[];
  /** Estimated candle-derived visible-range volume-by-price profile, or false to disable it. */
  volumeProfile?: VolumeProfileOptions | false;
  /** Horizontal data-anchored price levels. */
  priceLines?: StockPriceLine[];
  /** Sparse timestamp/price event markers. */
  markers?: StockMarker[];
  /** Called as the crosshair moves between candles, and with null when it leaves. */
  onCrosshairMove?: (detail: StockCrosshairMoveDetail | null) => void;
  /** Called when the renderer reports a changed visible range or data extent. */
  onVisibleRangeChange?: (detail: StockVisibleRangeChangeDetail) => void;
  showVolume?: boolean;
  /** Opacity of volume bars (0-1, default: 0.35) */
  volumeOpacity?: number;
  /** Height of volume area as fraction of chart height (0-1, default: 0.15) */
  volumeHeightRatio?: number;
  /** Custom colors for volume bars (defaults to candle colors) */
  volumeColors?: VolumeColors;
  /** Legacy fallback color for left and right Y-axis cursor labels. Explicit axis cursor-label colors take precedence. */
  crosshairMarkerColor?: string;
  /** Alias for showLeftAxisLabel - show price marker on left Y-axis */
  showLeftPriceMarker?: boolean;
  /** Alias for showRightAxisLabel - show price marker on right Y-axis */
  showRightPriceMarker?: boolean;
  /**
   * Style for rendering price data:
   * - 'filled': solid filled candles (default)
   * - 'hollow': candles with stroke outline only
   * - 'ohlc': classic OHLC bars with horizontal ticks
   */
  candleStyle?: CandleStyle;
  /** Custom colors for candles */
  candleColors?: CandleColors;
  /** Stroke width for candle outlines and OHLC bars (default: 1) */
  candleStrokeWidth?: number;
  /** Color for the preview line in range selector (default: '#4a90d9') */
  previewLineColor?: string;
  /** Unit config for price values (OHLC) in tooltip and axis labels */
  priceUnit?: UnitOptions;
  /** Unit config for volume values in tooltip */
  volumeUnit?: UnitOptions;
}

export interface StockChartStats {
  totalCandles: number;
  visibleCandles: number;
  renderedCandles: number;
  renderMode: "worker" | "main";
  fps: number;
  lodLevel: number;
  aggregation: string;
  frameTime: string;
  firstRenderTime: string;
  lodReady: boolean;
  lodBuilt: number;
  lodTotal: number;
  ringBuffer: boolean;
  totalReceived: number;
  bufferUsage: number;
}

export interface StockChartStatsOptions {
  /** Minimum interval between stats updates in milliseconds (default: 250) */
  intervalMs?: number;
}

export interface StockAddCandlesOptions {
  /** Apply a preset before the initial streamed dataset can render. */
  initialTimeRange?: TimeRange;
}

export interface StockCandleBatch {
  readonly timestamp: Float64Array;
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly volume: Float64Array;
}

/** Stock chart appearance — base appearance + stock-specific visual fields */
export interface StockAppearanceOptions extends BaseAppearanceOptions {
  /** Colors used for candle bodies and wicks. */
  candleColors?: CandleColors;
  /** Candle outline and OHLC-bar width in CSS pixels. */
  candleStrokeWidth?: number;
  /** Line color used by the range-selector preview. */
  previewLineColor?: string;
}

const STOCK_PRICE_SOURCES = new Set(["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"]);
const STOCK_INDICATOR_TYPES = new Set(["sma", "ema", "bollinger", "vwap"]);

function assertValidIndicators(
  indicators: readonly StockIndicator[],
  streamingCapacity?: number,
): void {
  const explicitIds = new Set<string>();
  for (let index = 0; index < indicators.length; index++) {
    const indicator = indicators[index] as StockIndicator & Record<string, unknown>;
    if (!indicator || typeof indicator !== "object") {
      throw new TypeError(`Stock indicator at index ${index} must be an object`);
    }
    if (!STOCK_INDICATOR_TYPES.has(String(indicator.type))) {
      throw new RangeError(`Stock indicator at index ${index} has an unsupported type`);
    }
    if (indicator.id !== undefined) {
      if (typeof indicator.id !== "string" || indicator.id.length === 0) {
        throw new TypeError(`Stock indicator at index ${index} requires a non-empty string id`);
      }
      if (explicitIds.has(indicator.id)) {
        throw new RangeError(`Stock indicator id "${indicator.id}" must be unique`);
      }
      explicitIds.add(indicator.id);
    }
    if (indicator.source !== undefined && !STOCK_PRICE_SOURCES.has(String(indicator.source))) {
      throw new RangeError(`Stock indicator at index ${index} has an unsupported price source`);
    }
    if (indicator.type === "vwap") {
      if (
        indicator.reset !== undefined &&
        indicator.reset !== "day" &&
        indicator.reset !== "week" &&
        indicator.reset !== "none"
      ) {
        throw new RangeError(`VWAP indicator at index ${index} has an unsupported reset`);
      }
      if (
        indicator.resetOffsetMs !== undefined &&
        (typeof indicator.resetOffsetMs !== "number" || !Number.isFinite(indicator.resetOffsetMs))
      ) {
        throw new RangeError(`VWAP indicator at index ${index} requires a finite resetOffsetMs`);
      }
    } else {
      if (!Number.isInteger(indicator.period) || Number(indicator.period) <= 0) {
        throw new RangeError(
          `Stock indicator at index ${index} requires a positive integer period`,
        );
      }
      if (streamingCapacity !== undefined && Number(indicator.period) > streamingCapacity) {
        throw new RangeError(
          `Stock indicator at index ${index} period exceeds the streaming capacity`,
        );
      }
      if (
        indicator.type === "bollinger" &&
        indicator.deviation !== undefined &&
        (typeof indicator.deviation !== "number" ||
          !Number.isFinite(indicator.deviation) ||
          indicator.deviation < 0)
      ) {
        throw new RangeError(
          `Bollinger indicator at index ${index} requires a finite non-negative deviation`,
        );
      }
    }
    if (
      indicator.lineWidth !== undefined &&
      (typeof indicator.lineWidth !== "number" ||
        !Number.isFinite(indicator.lineWidth) ||
        indicator.lineWidth <= 0)
    ) {
      throw new RangeError(`Stock indicator at index ${index} requires a positive lineWidth`);
    }
    if (
      indicator.fillOpacity !== undefined &&
      (typeof indicator.fillOpacity !== "number" ||
        !Number.isFinite(indicator.fillOpacity) ||
        indicator.fillOpacity < 0 ||
        indicator.fillOpacity > 1)
    ) {
      throw new RangeError(`Stock indicator at index ${index} fillOpacity must be between 0 and 1`);
    }
  }
}

export class StockChart extends BaseChart<StockChartOptions> {
  private onStatsUpdate: ((stats: StockChartStats) => void) | null = null;
  private tooltipOnRender: ((params: StockTooltipRenderParams) => StockTooltipRenderResult) | null =
    null;
  private tooltipFields: string[] | null = null;
  private tooltipFieldLabels: StockTooltipFieldLabels = {};
  private activeTimeRange: TimeRange | null = "ALL";
  private onTimeRangeChange?: (range: TimeRange | null) => void;
  private onCrosshairMove?: (detail: StockCrosshairMoveDetail | null) => void;
  private onVisibleRangeChange?: (detail: StockVisibleRangeChangeDetail) => void;
  private lastResetTime = -Infinity;
  private readonly timeScale: StockTimeScale;
  private timeViewport = { xMin: 0, xMax: 1 };
  private timeDataBounds = { xMin: 0, xMax: 1 };

  // Batching for high-frequency addCandle calls
  private pendingCandles: {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[] = [];
  private batchFlushFrame: number | null = null;
  private streamingCapacity: number | null = null;

  constructor(canvas: HTMLCanvasElement, options: StockChartOptions = {}) {
    const { cleaned, onRender, onLeave } = BaseChart.stripTooltipCallbacks(options.tooltip);
    const initialIndicators = deepClone(options.indicators ?? []);
    assertValidIndicators(initialIndicators);
    const initialVolumeProfile = deepClone(options.volumeProfile ?? false);
    const initialPriceLines = deepClone(options.priceLines ?? []);
    const initialMarkers = deepClone(options.markers ?? []);

    // Support price marker aliases - merge into axis config
    const resolvedOptions: Record<string, any> = {
      ...options,
      ...(cleaned !== undefined ? { tooltip: cleaned } : {}),
      indicators: initialIndicators,
      volumeProfile: initialVolumeProfile,
      priceLines: initialPriceLines,
      markers: initialMarkers,
    };
    if (options.showLeftPriceMarker !== undefined || options.showRightPriceMarker !== undefined) {
      resolvedOptions.axis = {
        ...options.axis,
        left: {
          ...options.axis?.left,
          cursorLabel: {
            ...options.axis?.left?.cursorLabel,
            visible: options.axis?.left?.cursorLabel?.visible ?? options.showLeftPriceMarker,
          },
        },
        right: {
          ...options.axis?.right,
          cursorLabel: {
            ...options.axis?.right?.cursorLabel,
            visible: options.axis?.right?.cursorLabel?.visible ?? options.showRightPriceMarker,
          },
        },
      };
    }

    const { renderer, useWorker, resolvedRenderMode } = BaseChart.selectChartRenderer(
      canvas,
      options,
      () => new StockWorker(),
      () => import("./stockRenderer.js").then((m) => m.createStockChartEngine),
      true,
    );

    super(
      canvas,
      renderer,
      resolvedOptions as BaseChartOptions,
      {
        defaultLeftAxis: false,
        defaultRightAxis: true,
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
        indicators: initialIndicators,
        volumeProfile: initialVolumeProfile,
        priceLines: initialPriceLines,
        markers: initialMarkers,
        timeScale: options.timeScale ?? "continuous",
      },
      useWorker,
      resolvedRenderMode,
      STOCK_MIN_RANGE,
    );

    this.tooltipOnRender = onRender ?? null;
    this.tooltipOnLeave = onLeave ?? null;
    this.tooltipFields = (options.tooltip?.fields as string[]) ?? null;
    this.tooltipFieldLabels = { ...options.tooltip?.fieldLabels };
    this.onTimeRangeChange = options.onTimeRangeChange;
    this.onCrosshairMove = options.onCrosshairMove;
    this.onVisibleRangeChange = options.onVisibleRangeChange;
    this.timeScale = options.timeScale ?? "continuous";
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
          this.onStatsUpdate({
            totalCandles: data.totalCandles,
            visibleCandles: data.visibleCandles,
            renderedCandles: data.renderedCandles,
            renderMode: this.resolvedRenderMode,
            fps: data.fps,
            lodLevel: data.lodLevel,
            aggregation: data.aggregation,
            frameTime: data.frameTime,
            firstRenderTime: data.firstRenderTime,
            lodReady: data.lodReady,
            lodBuilt: data.lodBuilt,
            lodTotal: data.lodTotal,
            ringBuffer: data.ringBuffer || false,
            totalReceived: data.totalReceived || 0,
            bufferUsage: data.bufferUsage || 0,
          });
        }
        break;

      case "viewportSync":
        {
          const previousViewport = { ...this.lastKnownViewport };
          const previousDataBounds = { ...this.dataBounds };
          const previousTimeViewport = { ...this.timeViewport };
          const previousTimeDataBounds = { ...this.timeDataBounds };
          this.handleViewportSyncMessage(data);
          if (data.timeViewport && data.timeDataBounds) {
            this.timeViewport = {
              xMin: data.timeViewport.xMin,
              xMax: data.timeViewport.xMax,
            };
            this.timeDataBounds = {
              xMin: data.timeDataBounds.xMin,
              xMax: data.timeDataBounds.xMax,
            };
          } else {
            this.timeViewport = { ...this.lastKnownViewport };
            this.timeDataBounds = { ...this.dataBounds };
          }
          if (
            previousViewport.xMin !== this.lastKnownViewport.xMin ||
            previousViewport.xMax !== this.lastKnownViewport.xMax ||
            previousDataBounds.xMin !== this.dataBounds.xMin ||
            previousDataBounds.xMax !== this.dataBounds.xMax ||
            previousTimeViewport.xMin !== this.timeViewport.xMin ||
            previousTimeViewport.xMax !== this.timeViewport.xMax ||
            previousTimeDataBounds.xMin !== this.timeDataBounds.xMin ||
            previousTimeDataBounds.xMax !== this.timeDataBounds.xMax
          ) {
            this.emitVisibleRangeChange();
          }
        }
        break;

      case "layout":
        this.syncLayoutFromRenderer(data);
        break;

      case "tooltipData": {
        this.emitCrosshairMove(this.createCrosshairMoveDetail(data.params));
        if (!this.tooltipOnRender) break;
        const fieldsFilter = this.tooltipFields;
        this.dispatchTooltipData(
          data,
          this.tooltipOnRender,
          (params, defaultTitle) => {
            const sign = params.change >= 0 ? "+" : "-";
            const allRows: Record<
              string,
              { label: string; value: string; color?: string; dimmed?: boolean }
            > = {
              open: { label: this.getTooltipFieldLabel("open"), value: params.formatted.open },
              high: { label: this.getTooltipFieldLabel("high"), value: params.formatted.high },
              low: { label: this.getTooltipFieldLabel("low"), value: params.formatted.low },
              close: { label: this.getTooltipFieldLabel("close"), value: params.formatted.close },
              change: {
                label: this.getTooltipFieldLabel("change"),
                value: `${sign}${params.formattedChange}`,
                color: params.color,
              },
              changePercent: {
                label: this.getTooltipFieldLabel("changePercent"),
                value: `${sign}${Math.abs(params.changePercent).toFixed(2)}%`,
                color: params.color,
              },
              volume: {
                label: this.getTooltipFieldLabel("volume"),
                value: params.formatted.volume,
              },
            };
            const keys = fieldsFilter ?? [
              "open",
              "high",
              "low",
              "close",
              "change",
              "changePercent",
              "volume",
            ];
            const rows: { label: string; value: string; color?: string; dimmed?: boolean }[] = [];
            for (const key of keys) {
              const row = allRows[key];
              if (row) rows.push(row);
            }
            if (Array.isArray(params.indicators)) {
              for (const indicator of params.indicators) {
                rows.push({
                  label: indicator.label,
                  value: indicator.formattedValue,
                  color: indicator.color,
                });
              }
            }
            return { title: defaultTitle, rows };
          },
          "timestamp",
        );
        break;
      }

      case "crosshairLeave":
        this.emitCrosshairMove(null);
        break;
    }
  }

  private createCrosshairMoveDetail(params: Record<string, any>): StockCrosshairMoveDetail {
    return {
      timestamp: params.timestamp,
      screenX: params.screenX,
      screenY: params.screenY,
      candle: deepClone(params.candle),
      formatted: deepClone(params.formatted),
      change: params.change,
      changePercent: params.changePercent,
      formattedChange: params.formattedChange,
      bullish: params.bullish,
      color: params.color,
      ...(Array.isArray(params.indicators) ? { indicators: deepClone(params.indicators) } : {}),
    };
  }

  private emitCrosshairMove(detail: StockCrosshairMoveDetail | null): void {
    this.onCrosshairMove?.(detail);
    this.canvas.dispatchEvent(
      new CustomEvent<StockCrosshairMoveDetail | null>(STOCK_CROSSHAIR_MOVE_EVENT, {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitVisibleRangeChange(): void {
    const viewport = this.timeScale === "market" ? this.timeViewport : this.lastKnownViewport;
    const dataBounds = this.timeScale === "market" ? this.timeDataBounds : this.dataBounds;
    const detail: StockVisibleRangeChangeDetail = {
      viewport: { ...viewport },
      dataBounds: { ...dataBounds },
    };
    this.onVisibleRangeChange?.(detail);
    this.canvas.dispatchEvent(
      new CustomEvent<StockVisibleRangeChangeDetail>(STOCK_VISIBLE_RANGE_CHANGE_EVENT, {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected onReset(): void {
    if (this.timeScale === "market") {
      this.timeViewport = { ...this.timeDataBounds };
    }
    this.lastResetTime = performance.now();
    this.emitTimeRangeChange("ALL", "reset", true);
  }

  protected onViewportManualChange(): void {
    // Ignore if reset was just called (handles double-tap race condition)
    if (performance.now() - this.lastResetTime < RESET_DEBOUNCE_MS) return;

    // A manual viewport change no longer represents a named preset.
    if (this.activeTimeRange !== null) {
      this.emitTimeRangeChange(null, "interaction");
    }
  }

  /**
   * Installs an OHLCV dataset and gives the renderer ownership of its normalized
   * typed arrays. Worker mode transfers and detaches their buffers; main-thread
   * mode retains the arrays by reference. Descending input is copied while it
   * is normalized. Do not reuse or mutate ascending input after this call.
   *
   * Posts directly rather than through the batch queue, and starts the renderer
   * straight away, so the first frame is drawn as early as possible while the
   * derived work continues in the background. Do not route this through
   * postMessageBatched.
   */
  setData(data: OHLCVData): void {
    if (this.destroyed) return;
    data = normalizeOHLCVData(data);
    this.flushViewportInputs();
    const transferList = collectTransferables([
      data.timestamp,
      data.open,
      data.high,
      data.low,
      data.close,
      data.volume,
    ]);
    this.discardPendingCandles();
    this.streamingCapacity = null;
    this.worker.postMessage(
      {
        type: "setData",
        timestamp: data.timestamp,
        open: data.open,
        high: data.high,
        low: data.low,
        close: data.close,
        volume: data.volume,
      },
      transferList,
    );
    this.worker.postMessage({ type: "start" });
    this.emitTimeRangeChange("ALL", "data");
  }

  /** Initialize streaming mode with a ring buffer of fixed capacity */
  initStreaming(maxCandles: number = 1_000_000): void {
    if (this.destroyed) return;
    if (!Number.isInteger(maxCandles) || maxCandles <= 0) {
      throw new RangeError("Stock streaming capacity must be a positive integer");
    }
    assertValidIndicators(this.optionsShadow.indicators as StockIndicator[], maxCandles);
    this.flushViewportInputs();
    this.discardPendingCandles();
    this.streamingCapacity = maxCandles;
    this.worker.postMessage({
      type: "initRingBuffer",
      maxCandles,
    });
    this.worker.postMessage({ type: "start" });
    this.emitTimeRangeChange("ALL", "data");
  }

  /** Add a single candle (batched via rAF for high-frequency updates) */
  addCandle(
    timestamp: number,
    open: number,
    high: number,
    low: number,
    close: number,
    volume: number,
  ): void {
    if (this.destroyed) return;
    this.flushViewportInputs();
    this.pendingCandles.push({ timestamp, open, high, low, close, volume });

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
    if (this.batchFlushFrame != null) cancelAnimationFrame(this.batchFlushFrame);
    this.batchFlushFrame = null;
  }

  private discardPendingCandles(): void {
    this.cancelBatchFlush();
    // BaseChart may call destroy() before subclass field initialization.
    this.pendingCandles = [];
  }

  private flushBatch(): void {
    this.cancelBatchFlush();
    const pendingCandles = this.pendingCandles;
    this.pendingCandles = [];
    const count = pendingCandles.length;
    if (this.destroyed || count === 0) return;

    const timestamps = new Float64Array(count);
    const opens = new Float64Array(count);
    const highs = new Float64Array(count);
    const lows = new Float64Array(count);
    const closes = new Float64Array(count);
    const volumes = new Float64Array(count);

    for (let i = 0; i < count; i++) {
      const c = pendingCandles[i];
      timestamps[i] = c.timestamp;
      opens[i] = c.open;
      highs[i] = c.high;
      lows[i] = c.low;
      closes[i] = c.close;
      volumes[i] = c.volume;
    }

    this.flushViewportInputs();
    this.sendCandles(timestamps, opens, highs, lows, closes, volumes, {}, [
      timestamps.buffer,
      opens.buffer,
      highs.buffer,
      lows.buffer,
      closes.buffer,
      volumes.buffer,
    ]);
  }

  /**
   * Adds multiple candles in one renderer update.
   *
   * Worker mode transfers and detaches the supplied buffers; main-thread mode
   * retains the arrays by reference. Treat these arrays as one-shot input.
   */
  addCandles(
    timestamps: Float64Array,
    opens: Float64Array,
    highs: Float64Array,
    lows: Float64Array,
    closes: Float64Array,
    volumes: Float64Array,
    options: StockAddCandlesOptions = {},
  ): void {
    if (this.destroyed) return;
    this.flushViewportInputs();
    const transferList = collectTransferables([timestamps, opens, highs, lows, closes, volumes]);
    this.flushBatch();
    this.sendCandles(timestamps, opens, highs, lows, closes, volumes, options, transferList);
  }

  private sendCandles(
    timestamps: Float64Array,
    opens: Float64Array,
    highs: Float64Array,
    lows: Float64Array,
    closes: Float64Array,
    volumes: Float64Array,
    options: StockAddCandlesOptions,
    transferList: Transferable[],
  ): void {
    this.worker.postMessage(
      {
        type: "addCandles",
        timestamps,
        opens,
        highs,
        lows,
        closes,
        volumes,
        initialTimeRange: options.initialTimeRange,
      },
      transferList,
    );
    if (options.initialTimeRange) {
      this.deferInBatch(() => this.emitTimeRangeChange(options.initialTimeRange!, "api"));
    }
  }

  /**
   * Installs multiple streaming chunks in one renderer turn.
   *
   * Worker mode transfers and detaches each chunk's buffers; main-thread mode
   * retains the arrays by reference. Treat every chunk as one-shot input.
   */
  addCandleBatches(
    batches: readonly StockCandleBatch[],
    options: StockAddCandlesOptions = {},
  ): void {
    if (this.destroyed) return;
    const nonEmptyBatches = batches.filter((batch) => batch.timestamp.length > 0);
    if (nonEmptyBatches.length === 0) return;
    this.flushViewportInputs();
    const transferList = collectTransferables(
      nonEmptyBatches.flatMap((batch) => [
        batch.timestamp,
        batch.open,
        batch.high,
        batch.low,
        batch.close,
        batch.volume,
      ]),
    );
    this.flushBatch();
    this.worker.postMessage(
      {
        type: "addCandleBatches",
        batches: nonEmptyBatches,
        initialTimeRange: options.initialTimeRange,
      },
      transferList,
    );
    if (options.initialTimeRange) {
      this.deferInBatch(() => this.emitTimeRangeChange(options.initialTimeRange!, "api"));
    }
  }

  setStatsCallback(
    callback: ((stats: StockChartStats) => void) | null,
    options: StockChartStatsOptions = {},
  ): void {
    if (this.destroyed) return;
    this.onStatsUpdate = callback;
    this.configureStats(Boolean(callback), options.intervalMs);
  }

  /** Replace the built-in technical indicator definitions. */
  setIndicators(indicators: StockIndicator[]): void {
    if (this.destroyed) return;
    assertValidIndicators(indicators, this.streamingCapacity ?? undefined);
    const snapshot = deepClone(indicators);
    this.optionsShadow.indicators = snapshot;
    this.postMessageBatched({
      type: "setIndicators",
      indicators: deepClone(snapshot),
    });
  }

  /** Replace or disable the estimated candle-derived visible-range volume profile. */
  setVolumeProfile(volumeProfile: VolumeProfileOptions | false): void {
    if (this.destroyed) return;
    const snapshot = deepClone(volumeProfile);
    this.optionsShadow.volumeProfile = snapshot;
    this.postMessageBatched({
      type: "setVolumeProfile",
      volumeProfile: deepClone(snapshot),
    });
  }

  /** Replace all horizontal data-anchored price levels. */
  setPriceLines(priceLines: StockPriceLine[]): void {
    if (this.destroyed) return;
    const snapshot = deepClone(priceLines);
    this.optionsShadow.priceLines = snapshot;
    this.postMessageBatched({
      type: "setPriceLines",
      priceLines: deepClone(snapshot),
    });
  }

  /** Replace all sparse timestamp/price markers. */
  setMarkers(markers: StockMarker[]): void {
    if (this.destroyed) return;
    const snapshot = deepClone(markers);
    this.optionsShadow.markers = snapshot;
    this.postMessageBatched({
      type: "setMarkers",
      markers: deepClone(snapshot),
    });
  }

  /**
   * Applies one of the exported calendar/session presets.
   *
   * The chart does not render controls. Application-owned controls may call
   * this method for a preset or `setViewport()` for any timestamp range.
   */
  setTimeRange(range: TimeRange): void {
    if (this.destroyed) return;
    if (this.activeTimeRange === range) return;

    this.postMessageBatched({ type: "setTimeRange", range });
    this.deferInBatch(() => this.emitTimeRangeChange(range, "api"));
  }

  override getViewport(): Viewport {
    return this.timeScale === "market" ? { ...this.timeViewport } : super.getViewport();
  }

  override setViewport(viewport: Partial<Viewport>, options?: { animated?: boolean }): void {
    if (this.destroyed) return;
    if (this.timeScale !== "market") {
      super.setViewport(viewport, options);
      this.emitTimeRangeChange(null, "api");
      return;
    }
    const xMin = viewport.xMin ?? this.timeViewport.xMin;
    const xMax = viewport.xMax ?? this.timeViewport.xMax;
    this.postMessageBatched({
      type:
        (options?.animated ?? this.animated)
          ? "setTimeViewportRangeAnimated"
          : "setTimeViewportRange",
      xMin,
      xMax,
    });
    this.emitTimeRangeChange(null, "api");
  }

  override reset(options?: { animated?: boolean }): void {
    super.reset(options);
  }

  private emitTimeRangeChange(
    range: TimeRange | null,
    source: TimeRangeChangeSource,
    force = false,
  ): void {
    const previousRange = this.activeTimeRange;
    if (!force && previousRange === range) return;
    this.activeTimeRange = range;
    this.onTimeRangeChange?.(range);
    this.canvas.dispatchEvent(
      new CustomEvent<TimeRangeChangeDetail>(STOCK_TIME_RANGE_CHANGE_EVENT, {
        detail: { range, previousRange, source },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private getTooltipFieldLabel(field: StockTooltipField): string {
    return this.tooltipFieldLabels[field] ?? "";
  }

  // ── Appearance API ──────────────────────────────────────────────────

  protected override buildExtraShadow(extraConfig: Record<string, unknown>): Record<string, any> {
    return {
      showVolume: extraConfig.showVolume,
      volumeOpacity: extraConfig.volumeOpacity,
      volumeHeightRatio: extraConfig.volumeHeightRatio,
      volumeColors: extraConfig.volumeColors,
      crosshairMarkerColor: extraConfig.crosshairMarkerColor,
      candleStyle: extraConfig.candleStyle,
      candleColors: extraConfig.candleColors
        ? { ...(extraConfig.candleColors as object) }
        : undefined,
      candleStrokeWidth: extraConfig.candleStrokeWidth,
      previewLineColor: extraConfig.previewLineColor,
      priceUnit: extraConfig.priceUnit,
      volumeUnit: extraConfig.volumeUnit,
      indicators: deepClone(extraConfig.indicators ?? []),
      volumeProfile: deepClone(extraConfig.volumeProfile ?? false),
      priceLines: deepClone(extraConfig.priceLines ?? []),
      markers: deepClone(extraConfig.markers ?? []),
      timeScale: extraConfig.timeScale,
    };
  }

  override getOptions(): DeepReadonly<StockChartOptions> {
    return super.getOptions() as unknown as DeepReadonly<StockChartOptions>;
  }

  override getAppearance(): DeepReadonly<StockAppearanceOptions> {
    const base = super.getAppearance() as Record<string, any>;
    const s = this.optionsShadow;
    base.candleColors = s.candleColors ? { ...s.candleColors } : undefined;
    base.candleStrokeWidth = s.candleStrokeWidth;
    base.previewLineColor = s.previewLineColor;
    return base as DeepReadonly<StockAppearanceOptions>;
  }

  protected override applyTooltipAppearancePatch(patch: Record<string, any>): void {
    super.applyTooltipAppearancePatch(patch);
    if (Object.prototype.hasOwnProperty.call(patch, "onRender") && patch.onRender !== undefined) {
      this.tooltipOnRender = typeof patch.onRender === "function" ? patch.onRender : null;
    }
    if (Array.isArray(patch.fields)) {
      this.tooltipFields = [...patch.fields];
    }
    if (patch.fieldLabels) {
      for (const field of Object.keys(patch.fieldLabels) as StockTooltipField[]) {
        const label = patch.fieldLabels[field];
        if (label === null || label === undefined) delete this.tooltipFieldLabels[field];
        else this.tooltipFieldLabels[field] = String(label);
      }
    }
  }

  destroy(): void {
    this.discardPendingCandles();
    super.destroy();
    this.onStatsUpdate = null;
    this.onTimeRangeChange = undefined;
    this.onCrosshairMove = undefined;
    this.onVisibleRangeChange = undefined;
    this.tooltipOnRender = null;
    this.tooltipOnLeave = null;
  }
}

function collectTransferables(arrays: readonly Float64Array[]): Transferable[] {
  const transferList: Transferable[] = [];
  const seen = new Set<ArrayBuffer>();

  for (const array of arrays) {
    const { buffer } = array;
    if (!(buffer instanceof ArrayBuffer) || seen.has(buffer)) continue;
    seen.add(buffer);
    transferList.push(buffer);
  }

  return transferList;
}
