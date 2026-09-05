// Stock chart renderer - shared engine used by worker or main-thread rendering
// Aggregates candles based on the source cadence and zoom level.

import type {
  CanvasLike,
  EngineCallbacks,
  RenderContext2D,
} from "@sixtyfold/core/internal/renderer";
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
  setViewportRangeAnimated,
  setYViewport,
  hasActiveGridAnimations,
  getCachedRgba,
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
  TooltipContent,
  createStatsState,
  applyStatsConfigFromMessage,
  shouldEmitStats,
  parseGridConfig,
  createRendererScheduler,
} from "@sixtyfold/core/internal/renderer";
import {
  HOUR,
  CANDLE_COLORS,
  ANIMATION,
  COLORS,
  DEFAULT_CURSOR_LABEL_COLOR,
  STOCK_MIN_RANGE,
} from "@sixtyfold/core/chart/chartConstants";
import {
  applyYDomain,
  formatPrice,
  formatVolume,
  formatTimeLabel,
  normalizeBounds,
  followViewportX,
  resolveMinViewportRange,
  resolveYDomain,
  type YDomainOptions,
} from "@sixtyfold/core/chart/chartUtils";
import { normalizeOHLCVData, type OHLCVData } from "./ohlcv";
import { type StockIndicator, type StockPriceSource } from "./analytics.js";
import {
  aggregateLevel,
  firstAggregationLevelIndex,
  formatAggregationInterval,
  STOCK_AGGREGATION_LEVELS,
} from "./engine/aggregation.js";
import {
  StockIndicatorRuntime,
  getIndicatorLine,
  getIndicatorLineColor,
  getIndicatorLineDash,
  type IndicatorRuntime,
  type RawCandleValues,
} from "./engine/indicatorRuntime.js";
import { StockLevelAccess, type AggregatedLevel } from "./engine/levels.js";
import {
  buildMarketCoordinates as buildMarketCoordinateState,
  collectMarketDayStarts,
  getContinuousRangeStart,
  getMarketRangeStart,
  inferMinimumInterval,
  marketXToTimestamp as interpolateMarketXToTimestamp,
  nextMinimumInterval,
  timestampToMarketX as interpolateTimestampToMarketX,
} from "./engine/marketTime.js";
import {
  DEFAULT_VOLUME_PROFILE,
  markerLowerBound,
  markerUpperBound,
  normalizeMarkers,
  normalizePriceLines,
  resolveVolumeProfileOptions,
} from "./engine/layerConfig.js";
import {
  buildStockTooltipContent,
  getIndicatorBaseId,
  getIndicatorBaseLabel,
  type StockIndicatorReading,
} from "./engine/stockTooltip.js";
import type { StockMarker, StockPriceLine, VolumeProfileOptions } from "./marketLayers.js";
import { accumulateEstimatedCandleVolume } from "./volumeProfile.js";

export interface StockChartEngine {
  handleMessage(type: string, data: Record<string, any>): void;
}

export function createStockChartEngine(
  callbacks: EngineCallbacks,
  options: {
    createCanvas?: (w: number, h: number) => CanvasLike;
    ssr?: boolean;
  } = {},
): StockChartEngine {
  const rendererScheduler = createRendererScheduler(callbacks);

  const MINUTE = 60_000;

  let minRange = STOCK_MIN_RANGE;
  let yDomain: YDomainOptions | undefined;

  // State
  const state = new WorkerState();
  if (options.createCanvas) state.createCanvas = options.createCanvas;
  const ssr = options.ssr ?? false;
  const stats = createStatsState();

  // Raw OHLCV data
  let dataTimestamp: Float64Array | null = null;
  let dataOpen: Float64Array | null = null;
  let dataHigh: Float64Array | null = null;
  let dataLow: Float64Array | null = null;
  let dataClose: Float64Array | null = null;
  let dataVolume: Float64Array | null = null;
  let dataMarketX: Float64Array | null = null;
  let dataLength = 0;
  let rawInterval = HOUR;
  let rawIntervalKnown = false;
  let configuredMinRange = STOCK_MIN_RANGE;
  let timeScale: "continuous" | "market" = "continuous";
  let marketDayStarts: number[] = [];
  let marketDayStartsDirty = false;

  // Aggregated LOD levels
  let lodLevels: AggregatedLevel[] = [];

  // LOD tracking
  let lodBuildComplete = false;
  let lodLevelsBuilt = 0;
  let lodLevelsTotal = 1;
  let currentLODIndex = 0;
  let currentAggregation = "RAW";
  let lastRenderedCandles = 0;
  // Initial bulk data must not paint progressively while its aggregation
  // hierarchy is being constructed. That progression changes candle grouping
  // (and therefore candle color) several times and looks like a chart reset.
  let deferInitialRenderUntilLODReady = false;

  // Stock-specific options
  let showVolume = true;
  let candleStyle: "filled" | "hollow" | "ohlc" = "filled";
  let candleStrokeWidth = 1;
  let customCandleColors: {
    up: string;
    down: string;
    wickUp: string;
    wickDown: string;
  } = { ...CANDLE_COLORS };
  let wickUpFollowsBody = true;
  let wickDownFollowsBody = true;
  let volumeOpacity = 0.35;
  let volumeHeightRatio = 0.15;
  let volumeColors: { up: string; down: string } | null = null;
  let previewLineColor = "#4a90d9";
  let priceUnit: UnitOptions | undefined = undefined;
  let volumeUnit: UnitOptions | undefined = undefined;

  let volumeProfile = { ...DEFAULT_VOLUME_PROFILE };
  let volumeProfileRevision = 0;
  let volumeProfileCacheRevision = -1;
  let volumeProfileCacheLevel: AggregatedLevel | null = null;
  let volumeProfileCacheStart = -1;
  let volumeProfileCacheEnd = -1;
  let volumeProfileCacheYMin = NaN;
  let volumeProfileCacheYMax = NaN;
  let volumeProfileUp = new Float64Array(DEFAULT_VOLUME_PROFILE.rows);
  let volumeProfileDown = new Float64Array(DEFAULT_VOLUME_PROFILE.rows);
  let volumeProfileMax = 0;
  let volumeProfileValueAreaLow = 0;
  let volumeProfileValueAreaHigh = -1;
  let volumeProfilePointOfControl = -1;
  let priceLines: StockPriceLine[] = [];
  let markers: StockMarker[] = [];
  let crosshairEventActive = false;

  let rawDataRevision = 1;
  let indicatorIndexCacheLevel: AggregatedLevel | null = null;
  let indicatorIndexCache = new Int32Array(0);
  let indicatorIndexCacheVersions = new Uint32Array(0);

  // Track whether axis label units were explicitly set (vs auto-defaulted from priceUnit)
  let leftAxisUnitExplicit = false;
  let rightAxisUnitExplicit = false;

  // Layout sync
  let lastLayoutKey = "";

  function postLayoutIfChanged(): void {
    const p = state.padding;
    const key = `${p.top}|${p.right}|${p.bottom}|${p.left}`;
    if (key === lastLayoutKey) return;
    lastLayoutKey = key;
    callbacks.postMessage({
      type: "layout",
      padding: { top: p.top, right: p.right, bottom: p.bottom, left: p.left },
      xAxisHeight: p.bottom,
    });
  }

  // Ring buffer state for streaming
  let ringBufferMode = false;
  let ringBufferMaxCandles = 1_000_000;
  let writeIndex = 0;
  let bufferFull = false;
  let totalCandlesReceived = 0;
  let previousDataLength = 0;
  let lodBuildGeneration = 0;
  interface LODBuild {
    generation: number;
    source: AggregatedLevel;
    borrowedPrefix: boolean;
    levels: AggregatedLevel[];
  }
  let activeLODBuild: LODBuild | null = null;
  let lodRebuildRequested = false;
  let lodBuildTimer: ReturnType<typeof setTimeout> | null = null;
  let lodRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  // Latest performance.now() by which a debounced LOD rebuild must run, so
  // sustained streaming can't keep resetting the debounce and starve it.
  // 0 means no rebuild is currently pending.
  let lodRebuildDeadline = 0;
  const LOD_REBUILD_MAX_WAIT_MS = 500;
  let stopped = false;

  const indicatorRuntime = new StockIndicatorRuntime({
    getStaticData: getStaticOHLCV,
    isRingBuffer: () => ringBufferMode,
    getDataLength: () => dataLength,
    getRingCapacity: () => ringBufferMaxCandles,
    getWriteIndex: () => writeIndex,
    logicalToPhysicalIndex: rawLogicalToPhysicalIndex,
    getSourceAtPhysical,
    getTimestampAtPhysical: (physicalIndex) => dataTimestamp![physicalIndex],
    getVolumeAtPhysical: (physicalIndex) => dataVolume![physicalIndex],
    onChange: () => {
      state.cacheValid = false;
    },
  });
  const indicators = indicatorRuntime.items;
  const levelAccess = new StockLevelAccess({
    logicalToPhysicalIndex: rawLogicalToPhysicalIndex,
    getRawMarketX,
    usesMarketTime: () => timeScale === "market",
  });

  function clearScheduledLODRebuild(): void {
    if (lodRebuildTimer !== null) {
      clearTimeout(lodRebuildTimer);
      lodRebuildTimer = null;
    }
  }

  function cancelLODWork(): void {
    clearScheduledLODRebuild();
    if (lodBuildTimer !== null) {
      clearTimeout(lodBuildTimer);
      lodBuildTimer = null;
    }
    lodRebuildDeadline = 0;
    lodBuildGeneration++;
    activeLODBuild = null;
    lodRebuildRequested = false;
  }

  function stopRenderer(): void {
    stopped = true;
    cancelLODWork();
    deferInitialRenderUntilLODReady = false;
    ringBufferMode = false;
    state.dataLoadStartTime = 0;
    state.viewportAnimation.active = false;
    state.yAnimation.active = false;
    state.revealProgress = 1;
    state.xGridAlphas.clear();
    state.yGridAlphas.clear();
    state.cacheValid = false;
    state.rangePreviewValid = false;
    parseOverlayConfig(state, undefined);
    replaceChartBackground(state, COLORS.background);
    if (state.rafId !== null && !ssr) {
      cancelAnimationFrame(state.rafId);
    }
    state.rafId = null;
    pendingViewportRequestId = undefined;
  }

  function rawLogicalToPhysicalIndex(index: number): number {
    if (!ringBufferMode || !bufferFull) return index;
    return (writeIndex + index) % ringBufferMaxCandles;
  }

  function getRawMarketX(index: number): number {
    if (!dataMarketX) return levelAccess.getTimestamp(lodLevels[0], index);
    return dataMarketX[rawLogicalToPhysicalIndex(index)];
  }

  function screenXForDataX(x: number): number {
    const xRange = state.viewport.xMax - state.viewport.xMin;
    return state.padding.left + ((x - state.viewport.xMin) / xRange) * state.chartWidth;
  }

  function screenXForLevel(level: AggregatedLevel, index: number): number {
    return screenXForDataX(levelAccess.getX(level, index));
  }

  function binarySearchRawRight(target: number): number {
    let lo = 0;
    let hi = Math.max(0, dataLength - 1);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (dataTimestamp![rawLogicalToPhysicalIndex(mid)] <= target) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function getIndicatorRawIndex(level: AggregatedLevel, levelIndex: number): number {
    if (level.rawSource) return levelIndex;
    if (indicatorIndexCacheLevel !== level) {
      indicatorIndexCacheLevel = level;
      indicatorIndexCache = new Int32Array(level.length);
      indicatorIndexCacheVersions = new Uint32Array(level.length);
    }
    if (indicatorIndexCacheVersions[levelIndex] !== rawDataRevision) {
      const sourceEndTimestamp = levelAccess.getSourceEndTimestamp(level, levelIndex);
      indicatorIndexCache[levelIndex] = binarySearchRawRight(sourceEndTimestamp);
      indicatorIndexCacheVersions[levelIndex] = rawDataRevision;
    }
    return indicatorIndexCache[levelIndex];
  }

  function bumpRawDataRevision(): void {
    rawDataRevision++;
    if (rawDataRevision === 0xffffffff) {
      rawDataRevision = 1;
      indicatorIndexCacheVersions.fill(0);
    }
  }

  function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.min(max, value))
      : fallback;
  }

  function setVolumeProfile(options: VolumeProfileOptions | false | null | undefined): void {
    volumeProfile = resolveVolumeProfileOptions(options);
    volumeProfileRevision++;
    volumeProfileCacheRevision = -1;
    state.cacheValid = false;
  }

  function setPriceLines(next: readonly StockPriceLine[] | null | undefined): void {
    priceLines = normalizePriceLines(next);
    state.cacheValid = false;
  }

  function setMarkers(next: readonly StockMarker[] | null | undefined): void {
    markers = normalizeMarkers(next);
    state.cacheValid = false;
  }

  function getStaticOHLCV(): OHLCVData | null {
    if (!dataTimestamp || !dataOpen || !dataHigh || !dataLow || !dataClose || !dataVolume) {
      return null;
    }
    return {
      timestamp: dataTimestamp.subarray(0, dataLength),
      open: dataOpen.subarray(0, dataLength),
      high: dataHigh.subarray(0, dataLength),
      low: dataLow.subarray(0, dataLength),
      close: dataClose.subarray(0, dataLength),
      volume: dataVolume.subarray(0, dataLength),
      length: dataLength,
    };
  }

  function getSourceAtPhysical(source: StockPriceSource | undefined, index: number): number {
    const open = dataOpen![index];
    const high = dataHigh![index];
    const low = dataLow![index];
    const close = dataClose![index];
    switch (source ?? "close") {
      case "open":
        return open;
      case "high":
        return high;
      case "low":
        return low;
      case "close":
        return close;
      case "hl2":
        return (high + low) / 2;
      case "hlc3":
        return (high + low + close) / 3;
      case "ohlc4":
        return (open + high + low + close) / 4;
    }
  }

  function rebuildIndicators(reuseCompatible = false): void {
    indicatorRuntime.rebuild(reuseCompatible);
  }

  function setIndicators(next: readonly StockIndicator[] | null | undefined): void {
    indicatorRuntime.setDefinitions(next);
    resetTooltipRatchet(state);
  }

  function appendIndicatorValues(physicalIndex: number, overwritten: RawCandleValues | null): void {
    indicatorRuntime.append(physicalIndex, overwritten);
  }

  function rebaseRollingIndicatorStates(latestPhysicalIndex: number): void {
    indicatorRuntime.rebaseRollingStates(latestPhysicalIndex);
  }

  function hasBuiltAggregations(): boolean {
    return lodLevels.length > 1;
  }

  function inferRawInterval(): number | null {
    if (!dataTimestamp) return null;
    return inferMinimumInterval(dataLength, getRawTimestamp);
  }

  function updateRawInterval(previousTimestamp: number, timestamp: number): void {
    const next = nextMinimumInterval(rawInterval, rawIntervalKnown, previousTimestamp, timestamp);
    rawInterval = next.interval;
    rawIntervalKnown = next.known;
  }

  function getRawTimestamp(index: number): number {
    return dataTimestamp?.[rawLogicalToPhysicalIndex(index)] ?? Number.NaN;
  }

  function marketGapCap(): number {
    return Math.max(rawInterval, MINUTE);
  }

  function rebuildMarketCoordinates(): void {
    marketDayStarts = [];
    marketDayStartsDirty = false;
    if (timeScale !== "market" || !dataTimestamp || dataLength === 0) {
      dataMarketX = null;
      minRange = configuredMinRange;
      return;
    }

    const rebuilt = buildMarketCoordinateState({
      length: dataLength,
      capacity: dataTimestamp.length,
      rawInterval,
      gapCap: marketGapCap(),
      existing: dataMarketX,
      logicalToPhysicalIndex: rawLogicalToPhysicalIndex,
      getTimestamp: getRawTimestamp,
    });
    dataMarketX = rebuilt.coordinates;
    marketDayStarts = rebuilt.dayStarts;
    minRange = configuredMinRange;
  }

  function ensureMarketDayStarts(): void {
    if (!marketDayStartsDirty) return;
    marketDayStarts = collectMarketDayStarts(dataLength, getRawTimestamp);
    marketDayStartsDirty = false;
  }

  function timestampToMarketX(timestamp: number): number {
    if (timeScale !== "market" || dataLength === 0) return timestamp;
    return interpolateTimestampToMarketX(timestamp, dataLength, getRawTimestamp, getRawMarketX);
  }

  function marketXToTimestamp(x: number): number {
    if (timeScale !== "market" || dataLength === 0) return x;
    return interpolateMarketXToTimestamp(x, dataLength, getRawTimestamp, getRawMarketX);
  }

  function currentTimeViewport(): { xMin: number; xMax: number } {
    return timeScale === "market"
      ? {
          xMin: marketXToTimestamp(state.viewport.xMin),
          xMax: marketXToTimestamp(state.viewport.xMax),
        }
      : { xMin: state.viewport.xMin, xMax: state.viewport.xMax };
  }

  function currentTimeDataBounds(): { xMin: number; xMax: number } {
    return timeScale === "market" && dataLength > 0
      ? { xMin: getRawTimestamp(0), xMax: getRawTimestamp(dataLength - 1) }
      : { xMin: state.dataBounds.xMin, xMax: state.dataBounds.xMax };
  }

  function formatMarketAxisLabel(x: number): string {
    const actual = marketXToTimestamp(x);
    const timeViewport = currentTimeViewport();
    return formatTimeLabel(actual, timeViewport.xMax - timeViewport.xMin);
  }

  function createRawLevel(): AggregatedLevel {
    const name = formatAggregationInterval(rawInterval);
    if (!dataTimestamp || !dataOpen || !dataHigh || !dataLow || !dataClose || !dataVolume) {
      return {
        name,
        interval: rawInterval,
        timestamp: new Float64Array(0),
        open: new Float64Array(0),
        high: new Float64Array(0),
        low: new Float64Array(0),
        close: new Float64Array(0),
        volume: new Float64Array(0),
        length: 0,
      };
    }

    return {
      name,
      interval: rawInterval,
      timestamp: dataTimestamp,
      open: dataOpen,
      high: dataHigh,
      low: dataLow,
      close: dataClose,
      volume: dataVolume,
      length: dataLength,
      rawSource: true,
    };
  }

  function resetToRawLODLevel(): void {
    lodLevels = [createRawLevel()];
    lodLevelsBuilt = dataLength > 0 ? 1 : 0;
    currentLODIndex = 0;
    currentAggregation = lodLevels[0].name;
  }

  function updateRawLODLevel(): void {
    const rawLevel = createRawLevel();
    if (lodLevels.length === 0) {
      lodLevels = [rawLevel];
    } else {
      lodLevels[0] = rawLevel;
    }
    lodLevelsBuilt = Math.max(lodLevelsBuilt, rawLevel.length > 0 ? 1 : 0);
  }

  function copyLODSource(source: AggregatedLevel, startIndex = 0): AggregatedLevel {
    const copyColumn = (column: Float64Array): Float64Array => {
      const copy = new Float64Array(source.length);
      const firstLength = Math.min(source.length, column.length - startIndex);
      copy.set(column.subarray(startIndex, startIndex + firstLength));
      if (firstLength < source.length) {
        copy.set(column.subarray(0, source.length - firstLength), firstLength);
      }
      return copy;
    };
    return {
      ...source,
      rawSource: false,
      timestamp: copyColumn(source.timestamp),
      open: copyColumn(source.open),
      high: copyColumn(source.high),
      low: copyColumn(source.low),
      close: copyColumn(source.close),
      volume: copyColumn(source.volume),
      ...(source.marketX ? { marketX: copyColumn(source.marketX) } : {}),
    };
  }

  function protectLODBuildPrefix(incomingCount: number): void {
    const build = activeLODBuild;
    if (
      !build?.borrowedPrefix ||
      incomingCount === 0 ||
      (!bufferFull && incomingCount <= ringBufferMaxCandles - writeIndex)
    ) {
      return;
    }
    // Growing rings have an immutable physical prefix. Copy only when an
    // incoming batch would overwrite it, before writing even its first candle.
    build.source = copyLODSource(build.source);
    build.borrowedPrefix = false;
  }

  let pendingViewportRequestId: number | undefined;

  function emitViewportSync(viewportRequestId?: number): void {
    const timeViewport = currentTimeViewport();
    const timeDataBounds = currentTimeDataBounds();
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
      ...(timeScale === "market"
        ? {
            timeViewport,
            timeDataBounds,
          }
        : {}),
    });
  }

  function setData(
    timestamp: Float64Array,
    open: Float64Array,
    high: Float64Array,
    low: Float64Array,
    close: Float64Array,
    volume: Float64Array,
  ) {
    ({ timestamp, open, high, low, close, volume } = normalizeOHLCVData({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
      length: timestamp.length,
    }));
    stopped = false;
    cancelLODWork();
    ringBufferMode = false;
    writeIndex = 0;
    bufferFull = false;
    previousDataLength = 0;
    state.dataLoadStartTime = performance.now();
    state.isFirstRender = true;
    resetTooltipRatchet(state);

    dataTimestamp = timestamp;
    dataOpen = open;
    dataHigh = high;
    dataLow = low;
    dataClose = close;
    dataVolume = volume;
    dataLength = timestamp.length;
    const inferredRawInterval = inferRawInterval();
    rawIntervalKnown = inferredRawInterval !== null;
    rawInterval = inferredRawInterval ?? HOUR;
    rebuildMarketCoordinates();
    bumpRawDataRevision();
    rebuildIndicators();
    resetToRawLODLevel();

    let yMin = Infinity;
    let yMax = -Infinity;

    for (let i = 0; i < dataLength; i++) {
      const lo = low[i];
      const hi = high[i];
      if (Number.isFinite(lo) && lo < yMin) yMin = lo;
      if (Number.isFinite(hi) && hi > yMax) yMax = hi;
    }

    // Shared normalization: NaN fallback + degenerate-span expansion. Also guards
    // an empty array (timestamp[-1] === undefined) via the dataLength check.
    const rawXMin = dataLength > 0 ? (timeScale === "market" ? getRawMarketX(0) : timestamp[0]) : 0;
    const rawXMax =
      dataLength > 0
        ? timeScale === "market"
          ? getRawMarketX(dataLength - 1)
          : timestamp[dataLength - 1]
        : 1;
    state.dataBounds = normalizeBounds(rawXMin, rawXMax, yMin, yMax, minRange);
    const initialY = applyYDomain(state.dataBounds.yMin, state.dataBounds.yMax, yDomain);
    state.viewport = {
      ...state.dataBounds,
      yMin: initialY.min,
      yMax: initialY.max,
    };

    emitViewportSync();

    startRevealAnimation(state, performance.now());

    buildLODLevels();
  }

  function initRingBuffer(maxCandles: number) {
    stopped = false;
    cancelLODWork();
    deferInitialRenderUntilLODReady = false;
    ringBufferMode = true;
    ringBufferMaxCandles = maxCandles;
    dataLength = 0;
    writeIndex = 0;
    bufferFull = false;
    previousDataLength = 0;
    totalCandlesReceived = 0;
    rawInterval = HOUR;
    rawIntervalKnown = false;

    // Pre-allocate buffers
    dataTimestamp = new Float64Array(maxCandles);
    dataOpen = new Float64Array(maxCandles);
    dataHigh = new Float64Array(maxCandles);
    dataLow = new Float64Array(maxCandles);
    dataClose = new Float64Array(maxCandles);
    dataVolume = new Float64Array(maxCandles);
    dataMarketX = timeScale === "market" ? new Float64Array(maxCandles) : null;
    marketDayStarts = [];
    marketDayStartsDirty = false;
    bumpRawDataRevision();
    rebuildIndicators();

    state.dataLoadStartTime = 0;
    state.isFirstRender = false;
    state.revealProgress = 1;

    // Initialize bounds
    state.dataBounds = { xMin: 0, xMax: 1, yMin: 0, yMax: 100 };
    const initialY = applyYDomain(0, 100, yDomain);
    state.viewport = {
      xMin: 0,
      xMax: 1,
      yMin: initialY.min,
      yMax: initialY.max,
    };

    resetToRawLODLevel();
    lodBuildComplete = false;
  }

  function addCandles(
    timestamps: Float64Array,
    opens: Float64Array,
    highs: Float64Array,
    lows: Float64Array,
    closes: Float64Array,
    volumes: Float64Array,
    deferLODRebuild = false,
    deferViewportSync = false,
  ) {
    if (!dataTimestamp || !ringBufferMode) return;

    const count = timestamps.length;
    protectLODBuildPrefix(count);
    let previousTimestamp =
      dataLength > 0 ? dataTimestamp[rawLogicalToPhysicalIndex(dataLength - 1)] : Number.NaN;
    let previousMarketX =
      timeScale === "market" && dataLength > 0 ? getRawMarketX(dataLength - 1) : 0;
    for (let i = 0; i < count; i++) {
      const overwritten: RawCandleValues | null = bufferFull
        ? {
            timestamp: dataTimestamp[writeIndex],
            open: dataOpen![writeIndex],
            high: dataHigh![writeIndex],
            low: dataLow![writeIndex],
            close: dataClose![writeIndex],
            volume: dataVolume![writeIndex],
          }
        : null;
      const timestamp = timestamps[i];
      updateRawInterval(previousTimestamp, timestamp);
      if (dataMarketX) {
        const delta = timestamp - previousTimestamp;
        dataMarketX[writeIndex] =
          totalCandlesReceived === 0
            ? 0
            : previousMarketX +
              (Number.isFinite(delta) && delta > 0 ? Math.min(delta, marketGapCap()) : rawInterval);
        previousMarketX = dataMarketX[writeIndex];
      }
      previousTimestamp = timestamp;
      dataTimestamp[writeIndex] = timestamp;
      dataOpen![writeIndex] = opens[i];
      dataHigh![writeIndex] = highs[i];
      dataLow![writeIndex] = lows[i];
      dataClose![writeIndex] = closes[i];
      dataVolume![writeIndex] = volumes[i];
      appendIndicatorValues(writeIndex, overwritten);

      const latestPhysicalIndex = writeIndex;
      writeIndex = (writeIndex + 1) % ringBufferMaxCandles;
      totalCandlesReceived++;
      if (writeIndex === 0) {
        if (!bufferFull) bufferFull = true;
        rebaseRollingIndicatorStates(latestPhysicalIndex);
      }
    }

    dataLength = bufferFull ? ringBufferMaxCandles : writeIndex;
    if (timeScale === "market") marketDayStartsDirty = true;
    bumpRawDataRevision();
    if (dataLength > 0) recalculateBounds(!deferViewportSync);

    updateRawLODLevel();

    if (!deferLODRebuild) {
      if (dataLength > 1000 && (!hasBuiltAggregations() || previousDataLength === 0)) {
        buildLODLevels();
      } else {
        scheduleLODRebuild();
      }
    }
    previousDataLength = dataLength;
    state.cacheValid = false;
    state.rangePreviewValid = false;
  }

  function recalculateBounds(emitSync = true) {
    if (!dataTimestamp || dataLength === 0) return;

    const previousBounds = state.dataBounds;
    const previousViewport = state.viewport;

    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = 0; i < dataLength; i++) {
      const idx = rawLogicalToPhysicalIndex(i);
      const lo = dataLow![idx];
      const hi = dataHigh![idx];
      // Skip non-finite values (matches setData); an unguarded ±Infinity from a
      // single bad streamed candle would otherwise wipe out the whole price scale.
      if (Number.isFinite(lo) && lo < yMin) yMin = lo;
      if (Number.isFinite(hi) && hi > yMax) yMax = hi;
    }

    // Shared normalization (NaN fallback + degenerate-span expansion).
    const bounds = normalizeBounds(
      timeScale === "market" ? getRawMarketX(0) : dataTimestamp[rawLogicalToPhysicalIndex(0)],
      timeScale === "market"
        ? getRawMarketX(dataLength - 1)
        : dataTimestamp[rawLogicalToPhysicalIndex(dataLength - 1)],
      yMin,
      yMax,
      minRange,
    );
    state.dataBounds = bounds;

    const nextX = followViewportX(
      previousViewport,
      previousBounds,
      previousDataLength,
      bounds.xMin,
      bounds.xMax,
      minRange,
    );
    const nextY = applyYDomain(bounds.yMin, bounds.yMax, yDomain);
    // Stock keeps the prior Y viewport while following X (Y rescales via its own
    // animation); only on a reset does it snap to the full data Y range.
    state.viewport = nextX.reset
      ? {
          xMin: nextX.xMin,
          xMax: nextX.xMax,
          yMin: nextY.min,
          yMax: nextY.max,
        }
      : { ...previousViewport, xMin: nextX.xMin, xMax: nextX.xMax };

    if (emitSync) emitViewportSync();
  }

  function buildLODLevels() {
    if (!dataTimestamp || stopped) return;
    if (activeLODBuild) {
      scheduleLODRebuild();
      return;
    }

    clearScheduledLODRebuild();
    lodRebuildDeadline = 0;
    lodRebuildRequested = false;
    const generation = ++lodBuildGeneration;
    lodBuildComplete = false;
    state.rangePreviewValid = false;

    // Build into a private hierarchy. The active hierarchy remains renderable
    // until the replacement is complete, so a streaming append never falls
    // back through raw/intermediate levels while the async rebuild advances.
    // Freeze the source length and indexing, not the live ring's write index.
    // A growing prefix can stay borrowed until its first eviction; a full ring
    // needs a logical-order snapshot immediately. Synchronous SSR can read the
    // live ring directly. None of these sources enters the active LODs.
    const source: AggregatedLevel = {
      ...createRawLevel(),
      rawSource: ssr,
      ...(dataMarketX ? { marketX: dataMarketX } : {}),
    };
    const build: LODBuild = {
      generation,
      source: !ssr && ringBufferMode && bufferFull ? copyLODSource(source, writeIndex) : source,
      borrowedPrefix: !ssr && ringBufferMode && !bufferFull,
      levels: [],
    };
    activeLODBuild = build;

    // Build only levels coarser than the source cadence. The previous hourly
    // source could safely skip the duplicate 1H level; second-resolution feeds
    // must start at 1m instead of treating raw records as hourly candles.
    const firstAggregationIndex = firstAggregationLevelIndex(STOCK_AGGREGATION_LEVELS, rawInterval);
    lodLevelsTotal =
      dataLength > 0 ? 1 + (STOCK_AGGREGATION_LEVELS.length - firstAggregationIndex) : 0;
    buildAggregatedLevel(firstAggregationIndex, ssr, build);
  }

  function buildAggregatedLevel(levelIdx: number, sync: boolean, build: LODBuild) {
    if (stopped || build.generation !== lodBuildGeneration || activeLODBuild !== build) return;

    const source = build.source;
    if (levelIdx >= STOCK_AGGREGATION_LEVELS.length || !source || source.length === 0) {
      // Keep the live raw tail while publishing all coarser snapshot levels at
      // once. A queued follow-up must never reinstate the first-paint barrier.
      lodLevels = [createRawLevel(), ...build.levels];
      lodLevelsBuilt = lodLevels.length;
      activeLODBuild = null;
      lodBuildComplete = true;
      deferInitialRenderUntilLODReady = false;
      // A completed asynchronous hierarchy is a semantic state transition, not
      // an ordinary frame sample. Force the next render to publish it even when
      // the previous in-progress stats event was inside the throttle interval;
      // otherwise the UI can remain stuck at an impossible "LOD 8/8" state.
      stats.nextEmitAt = 0;
      state.cacheValid = false; // Force re-render with all LODs available
      state.rangePreviewValid = false; // Re-render preview with final LOD levels
      scheduleRender();
      if (lodRebuildRequested) scheduleLODRebuild();
      return;
    }

    const level = STOCK_AGGREGATION_LEVELS[levelIdx];
    build.levels.push(aggregateLevel(source, level, levelAccess, timeScale === "market"));

    // Build next level
    if (sync) {
      buildAggregatedLevel(levelIdx + 1, true, build);
    } else {
      lodBuildTimer = rendererScheduler.scheduleTask(() => {
        if (activeLODBuild !== build) return;
        lodBuildTimer = null;
        buildAggregatedLevel(levelIdx + 1, false, build);
      }, 10);
    }
  }

  function scheduleLODRebuild(delayMs = 100): void {
    if (stopped || !dataTimestamp || dataLength === 0) return;
    if (ssr) {
      buildLODLevels();
      return;
    }
    lodRebuildRequested = true;
    const now = performance.now();
    if (lodRebuildDeadline === 0) lodRebuildDeadline = now + LOD_REBUILD_MAX_WAIT_MS;
    // New samples dirty the next build, not the one already making progress.
    // Preserve the original deadline while waiting for its atomic publication.
    if (activeLODBuild) return;
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

  function selectLODLevel(): number {
    if (lodLevels.length === 0) return 0;

    // Compact plots need a denser target so they do not jump an entire calendar
    // tier (for example, 1D straight to 1W). Four CSS pixels remain legible on
    // high-DPI mobile canvases; wider plots retain the calmer six-pixel target.
    // The renderer still caps the painted body at 80% of the available slot.
    const targetSpacing = state.chartWidth < 360 ? 4 : 6;
    const targetCandles = state.chartWidth / targetSpacing;

    for (let i = 0; i < lodLevels.length; i++) {
      const { startIdx, endIdx } = getVisibleCandles(i);
      const visibleCandles = Math.max(0, endIdx - startIdx + 1);
      if (visibleCandles <= targetCandles) return i;
    }

    return lodLevels.length - 1;
  }

  function getVisibleCandles(lodIdx: number): {
    startIdx: number;
    endIdx: number;
    level: AggregatedLevel;
  } {
    const level = lodLevels[lodIdx];
    if (!level || level.length === 0) {
      return { startIdx: 0, endIdx: -1, level: level ?? lodLevels[0] };
    }

    const startIdx = Math.max(
      0,
      levelAccess.binarySearchLeft(level, state.viewport.xMin, 0, level.length - 1) - 1,
    );
    const endIdx = Math.min(
      level.length - 1,
      levelAccess.binarySearchRight(level, state.viewport.xMax, startIdx, level.length - 1) + 1,
    );

    return { startIdx, endIdx, level };
  }

  function findYMinMax(
    level: AggregatedLevel,
    startIdx: number,
    endIdx: number,
  ): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;

    for (let i = startIdx; i <= endIdx; i++) {
      const lo = levelAccess.getLow(level, i);
      const hi = levelAccess.getHigh(level, i);
      if (Number.isFinite(lo) && lo < min) min = lo;
      if (Number.isFinite(hi) && hi > max) max = hi;
    }

    for (const line of priceLines) {
      if (line.extendScale !== true || !Number.isFinite(line.price)) continue;
      if (line.price < min) min = line.price;
      if (line.price > max) max = line.price;
    }

    for (const runtime of indicators) {
      if (runtime.definition.visible === false) continue;
      if (runtime.definition.includeInScale === false) continue;
      for (const line of runtime.computed.lines) {
        for (let i = startIdx; i <= endIdx; i++) {
          const value = line.values[rawLogicalToPhysicalIndex(getIndicatorRawIndex(level, i))];
          if (!Number.isFinite(value)) continue;
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
    }

    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 100;

    return { min, max };
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

    if (deferInitialRenderUntilLODReady && !lodBuildComplete) {
      if (ssr) {
        state.rafId = null;
        return;
      }
      state.rafId = rendererScheduler.scheduleFrame(render);
      return;
    }
    deferInitialRenderUntilLODReady = false;

    // Don't render until LOD levels are built
    if (lodLevels.length === 0) {
      if (ssr) {
        state.rafId = null;
        return;
      }
      if (stopped) {
        state.rafId = null;
        return;
      }
      state.rafId = rendererScheduler.scheduleFrame(render);
      return;
    }

    const frameStartTime = performance.now();
    updateFPS(state, timestamp);
    state.updateDimensions();
    postLayoutIfChanged();

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
      state.revealProgress < 1 ||
      state.yAnimation.active ||
      hasActiveGridAnimations(state)
    ) {
      state.cacheValid = false;
    }

    // Select LOD level
    const lodIdx = selectLODLevel();
    const { startIdx, endIdx, level } = getVisibleCandles(lodIdx);
    const visibleCount = endIdx - startIdx + 1;

    currentLODIndex = lodIdx;
    currentAggregation = level.name;

    if (visibleCount > 0) {
      const minMax = findYMinMax(level, startIdx, endIdx);
      const nextY = applyYDomain(minMax.min, minMax.max, yDomain);
      setYViewport(state, nextY.min, nextY.max, timestamp);
    }

    state.ensureCache();

    if (state.viewportChanged() || !state.cacheValid) {
      drawBackground(state.cacheCtx!, state.chartBackground, 0, 0, state.width, state.height);

      drawLabels(state.cacheCtx!, state);
      const marketFormatX = timeScale === "market" ? formatMarketAxisLabel : undefined;
      drawGrid(state.cacheCtx!, state, true);
      drawAxes(state.cacheCtx!, state, formatPrice, marketFormatX);
      drawVolumeProfile(state.cacheCtx!);
      drawVolumeBars(state.cacheCtx!, level, startIdx, endIdx);
      drawCandles(state.cacheCtx!, level, startIdx, endIdx);
      drawIndicators(state.cacheCtx!, level, startIdx, endIdx);
      drawPriceLines(state.cacheCtx!);
      drawMarkers(state.cacheCtx!, level);

      state.saveViewport();
      state.cacheValid = true;
      lastRenderedCandles = visibleCount;
    }

    state.ctx.setTransform(1, 0, 0, 1, 0, 0);
    state.ctx.drawImage(state.cacheCanvas as CanvasImageSource, 0, 0);
    state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    drawCustomLabels(state.ctx, state);

    if (state.mouseInChart) {
      drawCrosshair(state.ctx, level);
      drawAxisLabel(
        state.ctx,
        state,
        formatPrice,
        timeScale === "market" ? formatMarketAxisLabel : undefined,
      );
    }

    if (state.selectionStart !== null && state.selectionEnd !== null) {
      drawSelectionRect(state.ctx, state);
    }

    if (state.showRangeSelector) {
      drawRangeSelector(state.ctx);
    }

    state.frameTime = performance.now() - frameStartTime;

    if (state.isFirstRender) {
      state.firstRenderTime = performance.now() - state.dataLoadStartTime;
      state.isFirstRender = false;
    }

    if (shouldEmitStats(stats, timestamp)) {
      callbacks.postMessage({
        type: "stats",
        totalCandles: dataLength,
        visibleCandles: visibleCount,
        renderedCandles: lastRenderedCandles,
        fps: state.fps,
        viewport: { ...state.viewport },
        dataBounds: { ...state.dataBounds },
        lodLevel: currentLODIndex,
        aggregation: currentAggregation,
        frameTime: state.frameTime.toFixed(2),
        firstRenderTime: state.firstRenderTime.toFixed(0),
        lodReady: lodBuildComplete,
        lodBuilt: lodLevelsBuilt,
        lodTotal: lodLevelsTotal,
        ringBuffer: ringBufferMode,
        totalReceived: totalCandlesReceived,
        bufferUsage: bufferFull ? 100 : Math.round((writeIndex / ringBufferMaxCandles) * 100),
      });
    }

    if (ssr) {
      state.rafId = null;
      return;
    }

    // Continue loop only if animations are active
    if (needsContinuousRendering()) {
      state.rafId = rendererScheduler.scheduleFrame(render);
    } else {
      state.rafId = null;
    }
  }

  function rebuildVolumeProfile(level: AggregatedLevel, startIdx: number, endIdx: number): void {
    const rows = volumeProfile.rows;
    if (volumeProfileUp.length !== rows) {
      volumeProfileUp = new Float64Array(rows);
      volumeProfileDown = new Float64Array(rows);
    } else {
      volumeProfileUp.fill(0);
      volumeProfileDown.fill(0);
    }

    const yMin = state.viewport.yMin;
    const yMax = state.viewport.yMax;
    const yRange = yMax - yMin;
    let totalVolume = 0;
    let maxVolume = 0;
    let pointOfControl = -1;

    if (Number.isFinite(yRange) && yRange > 0) {
      for (let i = startIdx; i <= endIdx; i++) {
        const high = levelAccess.getHigh(level, i);
        const low = levelAccess.getLow(level, i);
        const close = levelAccess.getClose(level, i);
        const open = levelAccess.getOpen(level, i);
        const rawVolume = levelAccess.getVolume(level, i);
        if (
          !Number.isFinite(high) ||
          !Number.isFinite(low) ||
          !Number.isFinite(close) ||
          !Number.isFinite(open) ||
          !Number.isFinite(rawVolume) ||
          rawVolume <= 0
        ) {
          continue;
        }

        totalVolume += accumulateEstimatedCandleVolume(
          close >= open ? volumeProfileUp : volumeProfileDown,
          low,
          high,
          rawVolume,
          yMin,
          yMax,
        );
      }
    }

    for (let i = 0; i < rows; i++) {
      const binVolume = volumeProfileUp[i] + volumeProfileDown[i];
      if (binVolume > maxVolume) {
        maxVolume = binVolume;
        pointOfControl = i;
      }
    }

    let valueAreaLow = pointOfControl;
    let valueAreaHigh = pointOfControl;
    if (pointOfControl >= 0 && totalVolume > 0) {
      const target = totalVolume * volumeProfile.valueAreaPercent;
      let included = volumeProfileUp[pointOfControl] + volumeProfileDown[pointOfControl];
      while (included < target && (valueAreaLow > 0 || valueAreaHigh < rows - 1)) {
        const lowVolume =
          valueAreaLow > 0
            ? volumeProfileUp[valueAreaLow - 1] + volumeProfileDown[valueAreaLow - 1]
            : -1;
        const highVolume =
          valueAreaHigh < rows - 1
            ? volumeProfileUp[valueAreaHigh + 1] + volumeProfileDown[valueAreaHigh + 1]
            : -1;
        if (highVolume > lowVolume) {
          valueAreaHigh++;
          included += highVolume;
        } else {
          valueAreaLow--;
          included += lowVolume;
        }
      }
    }

    volumeProfileMax = maxVolume;
    volumeProfilePointOfControl = pointOfControl;
    volumeProfileValueAreaLow = Math.max(0, valueAreaLow);
    volumeProfileValueAreaHigh = valueAreaHigh;
    volumeProfileCacheRevision = volumeProfileRevision;
    volumeProfileCacheLevel = level;
    volumeProfileCacheStart = startIdx;
    volumeProfileCacheEnd = endIdx;
    volumeProfileCacheYMin = yMin;
    volumeProfileCacheYMax = yMax;
  }

  function getVolumeProfileSource(): {
    level: AggregatedLevel;
    startIdx: number;
    endIdx: number;
  } | null {
    const MAX_PROFILE_SOURCE_CANDLES = 4096;
    let fallback: ReturnType<typeof getVisibleCandles> | null = null;
    for (let lodIndex = 0; lodIndex < lodLevels.length; lodIndex++) {
      const visible = getVisibleCandles(lodIndex);
      fallback = visible;
      if (visible.endIdx - visible.startIdx + 1 <= MAX_PROFILE_SOURCE_CANDLES) {
        return visible;
      }
    }
    return fallback;
  }

  function drawVolumeProfile(ctx: RenderContext2D): void {
    if (!volumeProfile.visible) return;
    const source = getVolumeProfileSource();
    if (!source || source.startIdx > source.endIdx) return;
    const { level, startIdx, endIdx } = source;

    if (
      volumeProfileCacheRevision !== volumeProfileRevision ||
      volumeProfileCacheLevel !== level ||
      volumeProfileCacheStart !== startIdx ||
      volumeProfileCacheEnd !== endIdx ||
      volumeProfileCacheYMin !== state.viewport.yMin ||
      volumeProfileCacheYMax !== state.viewport.yMax
    ) {
      rebuildVolumeProfile(level, startIdx, endIdx);
    }
    if (volumeProfileMax <= 0) return;

    const rows = volumeProfile.rows;
    const binHeight = state.chartHeight / rows;
    const width = Math.min(volumeProfile.width, state.chartWidth * 0.4);
    const chartLeft = state.padding.left;
    const chartRight = chartLeft + state.chartWidth;
    const upBase = volumeProfile.upColor ?? volumeColors?.up ?? customCandleColors.up;
    const downBase = volumeProfile.downColor ?? volumeColors?.down ?? customCandleColors.down;
    const normalUp = getCachedRgba(upBase, volumeProfile.opacity * 0.48);
    const normalDown = getCachedRgba(downBase, volumeProfile.opacity * 0.48);
    const valueUp = getCachedRgba(upBase, volumeProfile.opacity);
    const valueDown = getCachedRgba(downBase, volumeProfile.opacity);

    ctx.save();
    for (let i = 0; i < rows; i++) {
      const up = volumeProfileUp[i];
      const down = volumeProfileDown[i];
      const total = up + down;
      if (total <= 0) continue;

      const totalWidth = (total / volumeProfileMax) * width;
      const upWidth = totalWidth * (up / total);
      const downWidth = totalWidth - upWidth;
      const y = state.chartTop + state.chartHeight - (i + 1) * binHeight;
      const inValueArea = i >= volumeProfileValueAreaLow && i <= volumeProfileValueAreaHigh;
      ctx.fillStyle = inValueArea ? valueDown : normalDown;

      if (volumeProfile.placement === "right") {
        const x = chartRight - totalWidth;
        if (downWidth > 0) ctx.fillRect(x, y, downWidth, Math.max(1, binHeight - 1));
        ctx.fillStyle = inValueArea ? valueUp : normalUp;
        if (upWidth > 0) {
          ctx.fillRect(x + downWidth, y, upWidth, Math.max(1, binHeight - 1));
        }
      } else {
        if (upWidth > 0) {
          ctx.fillStyle = inValueArea ? valueUp : normalUp;
          ctx.fillRect(chartLeft, y, upWidth, Math.max(1, binHeight - 1));
        }
        if (downWidth > 0) {
          ctx.fillStyle = inValueArea ? valueDown : normalDown;
          ctx.fillRect(chartLeft + upWidth, y, downWidth, Math.max(1, binHeight - 1));
        }
      }
    }

    if (volumeProfile.showPointOfControl && volumeProfilePointOfControl >= 0) {
      const y =
        state.chartTop + state.chartHeight - (volumeProfilePointOfControl + 0.5) * binHeight;
      ctx.strokeStyle = volumeProfile.pointOfControlColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      if (volumeProfile.placement === "right") {
        ctx.moveTo(chartRight - width, y);
        ctx.lineTo(chartRight, y);
      } else {
        ctx.moveTo(chartLeft, y);
        ctx.lineTo(chartLeft + width, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function indicatorValueAt(
    runtime: IndicatorRuntime,
    lineName: string,
    rawLogicalIndex: number,
  ): number {
    const values = getIndicatorLine(runtime, lineName);
    if (!values) return Number.NaN;
    return values[rawLogicalToPhysicalIndex(rawLogicalIndex)];
  }

  function hasLevelTimeGap(
    level: AggregatedLevel,
    previousIndex: number,
    currentIndex: number,
  ): boolean {
    if (timeScale === "market") return false;
    if (previousIndex < 0 || currentIndex <= previousIndex) return false;
    const previousTimestamp = levelAccess.getTimestamp(level, previousIndex);
    const currentTimestamp = levelAccess.getTimestamp(level, currentIndex);
    const difference = currentTimestamp - previousTimestamp;
    return !Number.isFinite(difference) || difference <= 0 || difference > level.interval * 1.5;
  }

  function drawIndicatorLine(
    ctx: RenderContext2D,
    runtime: IndicatorRuntime,
    lineName: string,
    level: AggregatedLevel,
    startIdx: number,
    endIdx: number,
  ): void {
    const definition = runtime.definition;
    const yRange = state.viewport.yMax - state.viewport.yMin;
    let started = false;

    ctx.strokeStyle = getIndicatorLineColor(definition, lineName);
    ctx.lineWidth = clampNumber(definition.lineWidth, 1.25, 0.25, 12);
    ctx.setLineDash(getIndicatorLineDash(definition));
    ctx.beginPath();
    for (let i = startIdx; i <= endIdx; i++) {
      const rawIndex = getIndicatorRawIndex(level, i);
      const value = indicatorValueAt(runtime, lineName, rawIndex);
      if (!Number.isFinite(value)) {
        started = false;
        continue;
      }
      const x = screenXForLevel(level, i);
      const y = state.chartTop + ((state.viewport.yMax - value) / yRange) * state.chartHeight;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        started = false;
        continue;
      }
      if (!started || hasLevelTimeGap(level, i - 1, i)) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  function drawBollingerFill(
    ctx: RenderContext2D,
    runtime: IndicatorRuntime,
    level: AggregatedLevel,
    startIdx: number,
    endIdx: number,
  ): void {
    if (runtime.definition.type !== "bollinger") return;
    const definition = runtime.definition;
    const opacity = clampNumber(definition.fillOpacity, 0.1, 0, 1);
    if (opacity <= 0) return;
    const yRange = state.viewport.yMax - state.viewport.yMin;
    ctx.fillStyle = getCachedRgba(definition.fillColor ?? definition.color ?? "#94a3b8", opacity);

    let i = startIdx;
    while (i <= endIdx) {
      while (i <= endIdx) {
        const rawIndex = getIndicatorRawIndex(level, i);
        if (
          Number.isFinite(indicatorValueAt(runtime, "upper", rawIndex)) &&
          Number.isFinite(indicatorValueAt(runtime, "lower", rawIndex))
        )
          break;
        i++;
      }
      if (i > endIdx) break;
      const segmentStart = i;
      i++;
      while (i <= endIdx) {
        const rawIndex = getIndicatorRawIndex(level, i);
        if (
          !Number.isFinite(indicatorValueAt(runtime, "upper", rawIndex)) ||
          !Number.isFinite(indicatorValueAt(runtime, "lower", rawIndex)) ||
          hasLevelTimeGap(level, i - 1, i)
        )
          break;
        i++;
      }
      const segmentEnd = i - 1;

      ctx.beginPath();
      for (let point = segmentStart; point <= segmentEnd; point++) {
        const rawIndex = getIndicatorRawIndex(level, point);
        const value = indicatorValueAt(runtime, "upper", rawIndex);
        const x = screenXForLevel(level, point);
        const y = state.chartTop + ((state.viewport.yMax - value) / yRange) * state.chartHeight;
        if (point === segmentStart) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let point = segmentEnd; point >= segmentStart; point--) {
        const rawIndex = getIndicatorRawIndex(level, point);
        const value = indicatorValueAt(runtime, "lower", rawIndex);
        const x = screenXForLevel(level, point);
        const y = state.chartTop + ((state.viewport.yMax - value) / yRange) * state.chartHeight;
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawIndicators(
    ctx: RenderContext2D,
    level: AggregatedLevel,
    startIdx: number,
    endIdx: number,
  ): void {
    if (indicators.length === 0 || startIdx > endIdx) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(state.padding.left, state.chartTop, state.chartWidth, state.chartHeight);
    ctx.clip();
    for (const runtime of indicators) {
      if (runtime.definition.visible === false) continue;
      if (runtime.definition.type === "bollinger") {
        drawBollingerFill(ctx, runtime, level, startIdx, endIdx);
      }
      for (const line of runtime.computed.lines) {
        drawIndicatorLine(ctx, runtime, line.name, level, startIdx, endIdx);
      }
    }
    ctx.restore();
  }

  function drawCandles(
    ctx: RenderContext2D,
    level: AggregatedLevel,
    startIdx: number,
    endIdx: number,
  ) {
    const yRange = state.viewport.yMax - state.viewport.yMin;

    // Calculate candle width based on interval and zoom
    const candleCount = endIdx - startIdx + 1;
    const candleWidthPx = Math.max(1, Math.min(20, (state.chartWidth / candleCount) * 0.8));
    const wickWidth = Math.max(1, candleWidthPx * 0.1);

    // Reveal animation progress (eased)
    const reveal = ANIMATION.revealEasing(state.revealProgress);

    const upBody = customCandleColors.up;
    const downBody = customCandleColors.down;
    const upWick = customCandleColors.wickUp;
    const downWick = customCandleColors.wickDown;

    for (let i = startIdx; i <= endIdx; i++) {
      const o = levelAccess.getOpen(level, i);
      const h = levelAccess.getHigh(level, i);
      const l = levelAccess.getLow(level, i);
      const c = levelAccess.getClose(level, i);

      // Skip candles with NaN values
      if (
        !Number.isFinite(o) ||
        !Number.isFinite(h) ||
        !Number.isFinite(l) ||
        !Number.isFinite(c)
      ) {
        continue;
      }

      const isUp = c >= o;
      const bodyColor = isUp ? upBody : downBody;
      const wickColor = isUp ? upWick : downWick;

      const screenX = screenXForLevel(level, i);
      const screenClose = state.chartTop + ((state.viewport.yMax - c) / yRange) * state.chartHeight;

      // Apply reveal animation: grow from close price
      const screenOpen =
        screenClose +
        (state.chartTop + ((state.viewport.yMax - o) / yRange) * state.chartHeight - screenClose) *
          reveal;
      const screenHigh =
        screenClose +
        (state.chartTop + ((state.viewport.yMax - h) / yRange) * state.chartHeight - screenClose) *
          reveal;
      const screenLow =
        screenClose +
        (state.chartTop + ((state.viewport.yMax - l) / yRange) * state.chartHeight - screenClose) *
          reveal;

      const bodyTop = Math.min(screenOpen, screenClose);
      const bodyBottom = Math.max(screenOpen, screenClose);
      const bodyHeight = Math.max(1, bodyBottom - bodyTop);
      const bodyLeft = screenX - candleWidthPx / 2;

      if (candleStyle === "ohlc") {
        // OHLC bars
        const tickWidth = candleWidthPx / 2;

        ctx.strokeStyle = bodyColor;
        ctx.lineWidth = candleStrokeWidth;

        // Vertical line
        ctx.beginPath();
        ctx.moveTo(screenX, screenHigh);
        ctx.lineTo(screenX, screenLow);
        ctx.stroke();

        // Open tick
        ctx.beginPath();
        ctx.moveTo(screenX - tickWidth, screenOpen);
        ctx.lineTo(screenX, screenOpen);
        ctx.stroke();

        // Close tick
        ctx.beginPath();
        ctx.moveTo(screenX, screenClose);
        ctx.lineTo(screenX + tickWidth, screenClose);
        ctx.stroke();
      } else if (candleStyle === "hollow") {
        // Hollow candles
        ctx.strokeStyle = wickColor;
        ctx.lineWidth = wickWidth;

        // Upper wick
        if (screenHigh < bodyTop) {
          ctx.beginPath();
          ctx.moveTo(screenX, screenHigh);
          ctx.lineTo(screenX, bodyTop);
          ctx.stroke();
        }

        // Lower wick
        if (screenLow > bodyBottom) {
          ctx.beginPath();
          ctx.moveTo(screenX, bodyBottom);
          ctx.lineTo(screenX, screenLow);
          ctx.stroke();
        }

        // Body outline
        ctx.strokeStyle = bodyColor;
        ctx.lineWidth = candleStrokeWidth;
        ctx.strokeRect(bodyLeft, bodyTop, candleWidthPx, bodyHeight);
      } else {
        // Filled candles (default)

        // Draw full wick
        ctx.strokeStyle = wickColor;
        ctx.lineWidth = wickWidth;
        ctx.beginPath();
        ctx.moveTo(screenX, screenHigh);
        ctx.lineTo(screenX, screenLow);
        ctx.stroke();

        // Filled body
        ctx.fillStyle = bodyColor;
        ctx.fillRect(bodyLeft, bodyTop, candleWidthPx, bodyHeight);
      }
    }
  }

  function drawVolumeBars(
    ctx: RenderContext2D,
    level: AggregatedLevel,
    startIdx: number,
    endIdx: number,
  ) {
    if (!showVolume || volumeHeightRatio <= 0) return;

    const chartBottom = state.chartTop + state.chartHeight;
    const volumeHeight = state.chartHeight * volumeHeightRatio;

    // Find max volume in visible range (skip NaN)
    let maxVolume = 0;
    for (let i = startIdx; i <= endIdx; i++) {
      const v = levelAccess.getVolume(level, i);
      if (Number.isFinite(v) && v > maxVolume) maxVolume = v;
    }
    if (maxVolume === 0) return;

    // Calculate bar width
    const candleCount = endIdx - startIdx + 1;
    const barWidthPx = Math.max(1, Math.min(20, (state.chartWidth / candleCount) * 0.8));

    // Reveal animation progress (eased)
    const reveal = ANIMATION.revealEasing(state.revealProgress);

    // Pre-calculate colors
    const upBaseColor = volumeColors?.up ?? customCandleColors.up;
    const downBaseColor = volumeColors?.down ?? customCandleColors.down;
    const upColorRgba = getCachedRgba(upBaseColor, volumeOpacity);
    const downColorRgba = getCachedRgba(downBaseColor, volumeOpacity);

    for (let i = startIdx; i <= endIdx; i++) {
      const v = levelAccess.getVolume(level, i);
      const o = levelAccess.getOpen(level, i);
      const c = levelAccess.getClose(level, i);

      // Skip bars with NaN values
      if (!Number.isFinite(v) || !Number.isFinite(o) || !Number.isFinite(c)) {
        continue;
      }

      const screenX = screenXForLevel(level, i);

      // Apply reveal animation: grow from bottom
      const barHeight = (v / maxVolume) * volumeHeight * reveal;
      const barTop = chartBottom - barHeight;

      const isUp = c >= o;
      ctx.fillStyle = isUp ? upColorRgba : downColorRgba;

      ctx.fillRect(screenX - barWidthPx / 2, barTop, barWidthPx, barHeight);
    }
  }

  function drawPriceLines(ctx: RenderContext2D): void {
    if (priceLines.length === 0) return;
    const yRange = state.viewport.yMax - state.viewport.yMin;
    if (!Number.isFinite(yRange) || yRange <= 0) return;

    const left = state.padding.left;
    const right = left + state.chartWidth;
    const top = state.chartTop;
    const bottom = top + state.chartHeight;

    ctx.save();
    ctx.font = `${state.rightAxisLabelFontWeight} ${state.rightAxisLabelFontSize}px ${state.rightAxisLabelFontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    for (const line of priceLines) {
      const y = top + ((state.viewport.yMax - line.price) / yRange) * state.chartHeight;
      if (!Number.isFinite(y) || y < top || y > bottom) continue;

      const color = line.color ?? "rgba(245, 158, 11, 0.92)";
      ctx.strokeStyle = color;
      ctx.lineWidth = clampNumber(line.lineWidth, 1, 0.25, 12);
      ctx.setLineDash(line.lineDash ?? [6, 4]);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();

      if (line.showAxisLabel === false) continue;
      const priceText = fmtPrice(line.price);
      const text = line.label ? `${line.label} · ${priceText}` : priceText;
      const height = state.rightAxisLabelFontSize + 8;
      const width = Math.min(state.chartWidth, ctx.measureText(text).width + 12);
      const labelX = right - width;
      const labelY = Math.max(top, Math.min(bottom - height, y - height / 2));
      ctx.fillStyle = line.axisLabelBackground ?? color;
      ctx.fillRect(labelX, labelY, width, height);
      ctx.fillStyle = line.axisLabelColor ?? "#ffffff";
      ctx.fillText(text, labelX + 6, labelY + height / 2, width - 12);
    }
    ctx.restore();
  }

  function nearestLevelIndex(level: AggregatedLevel, timestamp: number): number {
    if (level.length === 0) return -1;
    let index = levelAccess.binarySearchTimestampLeft(level, timestamp, 0, level.length - 1);
    if (index > 0) {
      const currentDistance = Math.abs(levelAccess.getTimestamp(level, index) - timestamp);
      const previousDistance = Math.abs(levelAccess.getTimestamp(level, index - 1) - timestamp);
      if (previousDistance < currentDistance) index--;
    }
    return index;
  }

  function drawMarkerShape(
    ctx: RenderContext2D,
    marker: StockMarker,
    x: number,
    y: number,
    size: number,
  ): void {
    const shape = marker.shape ?? "diamond";
    ctx.beginPath();
    switch (shape) {
      case "circle":
        ctx.arc(x, y, size, 0, Math.PI * 2);
        break;
      case "square":
        ctx.rect(x - size, y - size, size * 2, size * 2);
        break;
      case "triangle-up":
        ctx.moveTo(x, y - size);
        ctx.lineTo(x + size, y + size);
        ctx.lineTo(x - size, y + size);
        ctx.closePath();
        break;
      case "triangle-down":
        ctx.moveTo(x, y + size);
        ctx.lineTo(x + size, y - size);
        ctx.lineTo(x - size, y - size);
        ctx.closePath();
        break;
      case "diamond":
      default:
        ctx.moveTo(x, y - size);
        ctx.lineTo(x + size, y);
        ctx.lineTo(x, y + size);
        ctx.lineTo(x - size, y);
        ctx.closePath();
        break;
    }
    ctx.fill();
  }

  function drawMarkers(ctx: RenderContext2D, level: AggregatedLevel): void {
    if (markers.length === 0 || level.length === 0) return;
    const xRange = state.viewport.xMax - state.viewport.xMin;
    const yRange = state.viewport.yMax - state.viewport.yMin;
    if (xRange <= 0 || yRange <= 0) return;

    const timeViewport = currentTimeViewport();
    const first = markerLowerBound(markers, timeViewport.xMin);
    const last = markerUpperBound(markers, timeViewport.xMax);
    const top = state.chartTop;
    const bottom = top + state.chartHeight;

    ctx.save();
    ctx.font = `600 10px ${state.rightAxisLabelFontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let i = first; i < last; i++) {
      const marker = markers[i];
      const levelIndex = nearestLevelIndex(level, marker.timestamp);
      if (levelIndex < 0) continue;

      const position = marker.position ?? (Number.isFinite(marker.price) ? "price" : "above");
      const anchorX =
        position === "price"
          ? timestampToMarketX(marker.timestamp)
          : levelAccess.getX(level, levelIndex);
      const x = screenXForDataX(anchorX);
      const size = clampNumber(marker.size, 5, 2, 24);
      let y: number;
      if (position === "price" && Number.isFinite(marker.price)) {
        y = top + ((state.viewport.yMax - marker.price!) / yRange) * state.chartHeight;
      } else if (position === "below") {
        const low = levelAccess.getLow(level, levelIndex);
        if (!Number.isFinite(low)) continue;
        y = top + ((state.viewport.yMax - low) / yRange) * state.chartHeight + size + 5;
      } else {
        const high = levelAccess.getHigh(level, levelIndex);
        if (!Number.isFinite(high)) continue;
        y = top + ((state.viewport.yMax - high) / yRange) * state.chartHeight - size - 5;
      }
      if (!Number.isFinite(y) || y < top - size || y > bottom + size) continue;

      ctx.fillStyle = marker.color ?? "#38bdf8";
      drawMarkerShape(ctx, marker, x, y, size);

      if (marker.label) {
        const labelY = position === "below" ? y + size + 9 : y - size - 9;
        ctx.fillStyle = marker.textColor ?? marker.color ?? "#e0f2fe";
        ctx.fillText(marker.label, x, labelY);
      }
    }
    ctx.restore();
  }

  interface StockCandleData {
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    candleX: number;
    levelIndex: number;
  }

  function computeStockTooltipData(level: AggregatedLevel): StockCandleData | null {
    const chartBottom = state.chartTop + state.chartHeight;

    if (
      level.length === 0 ||
      state.mouseX < state.padding.left ||
      state.mouseX > state.width - state.padding.right ||
      state.mouseY < state.chartTop ||
      state.mouseY > chartBottom
    ) {
      return null;
    }

    const xRange = state.viewport.xMax - state.viewport.xMin;
    const dataX =
      state.viewport.xMin + ((state.mouseX - state.padding.left) / state.chartWidth) * xRange;

    let nearestIdx = levelAccess.binarySearchLeft(level, dataX, 0, level.length - 1);
    if (nearestIdx > 0) {
      const distCurrent = Math.abs(levelAccess.getX(level, nearestIdx) - dataX);
      const distPrev = Math.abs(levelAccess.getX(level, nearestIdx - 1) - dataX);
      if (distPrev < distCurrent) {
        nearestIdx = nearestIdx - 1;
      }
    }

    const candleX = screenXForLevel(level, nearestIdx);

    return {
      t: levelAccess.getTimestamp(level, nearestIdx),
      o: levelAccess.getOpen(level, nearestIdx),
      h: levelAccess.getHigh(level, nearestIdx),
      l: levelAccess.getLow(level, nearestIdx),
      c: levelAccess.getClose(level, nearestIdx),
      v: levelAccess.getVolume(level, nearestIdx),
      candleX,
      levelIndex: nearestIdx,
    };
  }

  function buildIndicatorCrosshairData(
    level: AggregatedLevel,
    levelIndex: number,
  ): StockIndicatorReading[] {
    if (indicators.length === 0) return [];
    const rawIndex = getIndicatorRawIndex(level, levelIndex);
    const result: StockIndicatorReading[] = [];
    for (let indicatorIndex = 0; indicatorIndex < indicators.length; indicatorIndex++) {
      const runtime = indicators[indicatorIndex];
      if (runtime.definition.visible === false) continue;
      const baseId = getIndicatorBaseId(runtime.definition, indicatorIndex);
      const baseLabel = getIndicatorBaseLabel(runtime.definition);
      for (const line of runtime.computed.lines) {
        const value = line.values[rawLogicalToPhysicalIndex(rawIndex)];
        if (!Number.isFinite(value)) continue;
        const isBandLine = runtime.definition.type === "bollinger";
        result.push({
          id: isBandLine ? `${baseId}:${line.name}` : baseId,
          label: isBandLine ? `${baseLabel} ${line.name}` : baseLabel,
          value,
          formattedValue: fmtPrice(value),
          color: getIndicatorLineColor(runtime.definition, line.name),
        });
      }
    }
    return result;
  }

  // Format helpers
  function fmtPrice(v: number): string {
    return priceUnit ? formatValue(v, priceUnit, 2) : formatPrice(v);
  }

  function fmtVol(v: number): string {
    return volumeUnit ? formatValue(v, volumeUnit, 0) : formatVolume(v);
  }

  function formatStockTooltipTitle(timestamp: number): string {
    return formatTooltipTitle(timestamp, state.tooltipTitleFormat);
  }

  function buildStockDefaultContent(
    candle: StockCandleData,
    indicatorReadings: ReturnType<typeof buildIndicatorCrosshairData>,
  ): TooltipContent {
    return buildStockTooltipContent({
      title: formatStockTooltipTitle(candle.t),
      candle,
      indicatorReadings,
      fields: state.tooltipFields,
      fieldLabels: state.stockTooltipFieldLabels,
      formatPrice: fmtPrice,
      formatVolume: fmtVol,
      upColor: customCandleColors.up,
      downColor: customCandleColors.down,
    });
  }

  function drawCrosshair(ctx: RenderContext2D, level: AggregatedLevel) {
    const candle = computeStockTooltipData(level);
    if (!candle) {
      if (crosshairEventActive) {
        crosshairEventActive = false;
        callbacks.postMessage({ type: "crosshairLeave" });
      }
      resetTooltipRatchet(state);
      return;
    }

    const isUp = candle.c >= candle.o;

    drawCrosshairLines(ctx, state, candle.candleX);

    // Crosshair data is a first-class integration event. It is emitted only when
    // the resolved candle changes, so external order tickets and analytics panels
    // do not receive a message for every pointer pixel.
    if (candle.t !== state.tooltipLastDataX) {
      state.tooltipLastDataX = candle.t;
      crosshairEventActive = true;
      const change = candle.c - candle.o;
      const changePercent = candle.o !== 0 ? (change / candle.o) * 100 : 0;
      callbacks.postMessage({
        type: "tooltipData",
        params: {
          timestamp: candle.t,
          screenX: candle.candleX,
          screenY: state.mouseY,
          candle: {
            open: candle.o,
            high: candle.h,
            low: candle.l,
            close: candle.c,
            volume: candle.v,
          },
          formatted: {
            open: fmtPrice(candle.o),
            high: fmtPrice(candle.h),
            low: fmtPrice(candle.l),
            close: fmtPrice(candle.c),
            volume: fmtVol(candle.v),
          },
          change,
          changePercent,
          formattedChange: fmtPrice(Math.abs(change)),
          bullish: isUp,
          color: isUp ? customCandleColors.up : customCandleColors.down,
          indicators: buildIndicatorCrosshairData(level, candle.levelIndex),
        },
        defaultTitle: formatStockTooltipTitle(candle.t),
      });
    }

    const content = state.tooltipHasCallback
      ? state.tooltipCustomContent
      : buildStockDefaultContent(candle, buildIndicatorCrosshairData(level, candle.levelIndex));
    if (content) {
      const borderOverride = state.tooltipCandleBorder
        ? isUp
          ? customCandleColors.up
          : customCandleColors.down
        : undefined;
      renderTooltipBox(ctx, state, content, candle.candleX, borderOverride);
    }
  }

  function renderRangePreview() {
    if (!dataTimestamp || !dataClose || lodLevels.length === 0) return;

    const previewLeft = state.rangeSelectorWidth === "canvas" ? 0 : state.padding.left;
    const previewRight =
      state.rangeSelectorWidth === "canvas" ? state.width : state.width - state.padding.right;
    const previewWidth = previewRight - previewLeft;
    const previewHeight = state.rangeSelectorHeight - 10;

    if (!state.rangePreviewCanvas || state.rangePreviewCanvas.width !== state.width * state.dpr) {
      state.rangePreviewCanvas = state.createCanvas(
        state.width * state.dpr,
        state.rangeSelectorHeight * state.dpr,
      );
      state.rangePreviewCtx = get2dContext(state.rangePreviewCanvas, {
        alpha: true,
      });
    }

    const previewCtx = state.rangePreviewCtx!;
    previewCtx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    // Clear with transparent - main chart background shows through
    previewCtx.clearRect(0, 0, state.width, state.rangeSelectorHeight);
    previewCtx.save();
    previewCtx.beginPath();
    previewCtx.rect(previewLeft, 0, previewWidth, state.rangeSelectorHeight);
    previewCtx.clip();

    // Use highest LOD level for preview
    const level = lodLevels[lodLevels.length - 1];
    const xRange = state.dataBounds.xMax - state.dataBounds.xMin;
    const previewY = applyYDomain(state.dataBounds.yMin, state.dataBounds.yMax, yDomain);
    const yRange = previewY.max - previewY.min;

    // Draw close price as line
    previewCtx.strokeStyle = previewLineColor;
    previewCtx.lineWidth = 1;
    previewCtx.beginPath();

    let needsMoveTo = true;
    let lastDrawnX = Number.NaN;
    const appendPoint = (x: number, y: number): void => {
      if (!Number.isFinite(y)) {
        needsMoveTo = true;
        return;
      }

      const screenX = previewLeft + ((x - state.dataBounds.xMin) / xRange) * previewWidth;
      const screenY = 5 + ((previewY.max - y) / yRange) * previewHeight;

      if (needsMoveTo) {
        previewCtx.moveTo(screenX, screenY);
        needsMoveTo = false;
      } else {
        previewCtx.lineTo(screenX, screenY);
      }
      lastDrawnX = x;
    };

    // Aggregated candles are positioned at their bucket midpoints. Without raw
    // endpoints, the coarsest preview therefore appears to have half a bucket of
    // unexplained horizontal padding on both sides even at the full range.
    // Anchor the overview to the actual first/last observations while retaining
    // the coarse interior path that keeps million-candle previews inexpensive.
    const firstRawX = timeScale === "market" ? getRawMarketX(0) : getRawTimestamp(0);
    const firstRawClose = dataClose[rawLogicalToPhysicalIndex(0)];
    appendPoint(firstRawX, firstRawClose);

    for (let i = 0; i < level.length; i++) {
      appendPoint(levelAccess.getX(level, i), levelAccess.getClose(level, i));
    }

    const lastRawIndex = dataLength - 1;
    const lastRawX =
      timeScale === "market" ? getRawMarketX(lastRawIndex) : getRawTimestamp(lastRawIndex);
    if (!Number.isFinite(lastDrawnX) || lastRawX > lastDrawnX) {
      appendPoint(lastRawX, dataClose[rawLogicalToPhysicalIndex(lastRawIndex)]);
    }

    previewCtx.stroke();
    previewCtx.restore();
    state.rangePreviewValid = true;
  }

  function drawRangeSelector(ctx: RenderContext2D) {
    if (!dataTimestamp || dataLength === 0) return;

    if (!state.rangePreviewValid) {
      renderRangePreview();
    }

    if (state.rangePreviewCanvas) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(state.rangePreviewCanvas as CanvasImageSource, 0, state.rangeTop * state.dpr);
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    }

    drawRangeSelectorOverlay(ctx, state);
  }

  function setTimeRange(rangeType: string, emitSync = true) {
    const now = state.dataBounds.xMax;
    let start: number;

    if (timeScale === "market") {
      ensureMarketDayStarts();
      start = getMarketRangeStart({
        rangeType,
        dataMin: state.dataBounds.xMin,
        dayStarts: marketDayStarts,
        lastTimestamp: getRawTimestamp(Math.max(0, dataLength - 1)),
        getRawMarketX,
        timestampToMarketX,
      });

      const previousViewportXMin = state.viewport.xMin;
      const previousViewportXMax = state.viewport.xMax;
      const animated = state.animated;
      if (state.isFirstRender) state.animated = false;
      setViewportRangeAnimated(
        state,
        Math.max(state.dataBounds.xMin, start),
        state.dataBounds.xMax,
        minRange,
        performance.now(),
      );
      state.animated = animated;
      if (
        emitSync &&
        (state.viewport.xMin !== previousViewportXMin ||
          state.viewport.xMax !== previousViewportXMax)
      ) {
        emitViewportSync();
      }
      return;
    }

    start = getContinuousRangeStart(rangeType, now, state.dataBounds.xMin);

    const xMin = Math.max(state.dataBounds.xMin, start);
    const xMax = state.dataBounds.xMax;

    // Use animated transition for time range changes
    const previousViewportXMin = state.viewport.xMin;
    const previousViewportXMax = state.viewport.xMax;
    const animated = state.animated;
    if (state.isFirstRender) state.animated = false;
    setViewportRangeAnimated(state, xMin, xMax, minRange, performance.now());
    state.animated = animated;
    if (
      emitSync &&
      (state.viewport.xMin !== previousViewportXMin || state.viewport.xMax !== previousViewportXMax)
    ) {
      emitViewportSync();
    }
  }

  function setTimeViewportRange(xMin: number, xMax: number, animated: boolean): void {
    if (timeScale !== "market") return;
    const internalMin = timestampToMarketX(xMin);
    const internalMax = timestampToMarketX(xMax);
    if (animated) {
      setViewportRangeAnimated(state, internalMin, internalMax, minRange, performance.now());
    } else {
      const previousAnimated = state.animated;
      state.animated = false;
      setViewportRangeAnimated(state, internalMin, internalMax, minRange, performance.now());
      state.animated = previousAnimated;
    }
    emitViewportSync();
  }

  function handleMessage(type: string, data: Record<string, any>): void {
    if (type === "stop") {
      stopRenderer();
      return;
    }

    if (type === "start") {
      stopped = false;
    }

    if (type === "mouseleave" && crosshairEventActive) {
      crosshairEventActive = false;
      callbacks.postMessage({ type: "crosshairLeave" });
    }

    if (type === "updateAppearance") {
      const patch = data.patch as Record<string, any>;
      if (patch.candleColors) {
        const cc = patch.candleColors;
        if (cc.up) customCandleColors.up = cc.up;
        if (cc.down) customCandleColors.down = cc.down;
        if (cc.wickUp) {
          customCandleColors.wickUp = cc.wickUp;
          wickUpFollowsBody = false;
        } else if (cc.up && wickUpFollowsBody) {
          customCandleColors.wickUp = cc.up;
        }
        if (cc.wickDown) {
          customCandleColors.wickDown = cc.wickDown;
          wickDownFollowsBody = false;
        } else if (cc.down && wickDownFollowsBody) {
          customCandleColors.wickDown = cc.down;
        }
      }
      if (patch.candleStrokeWidth !== undefined) {
        candleStrokeWidth = patch.candleStrokeWidth;
      }
      if (patch.previewLineColor !== undefined) {
        previewLineColor = patch.previewLineColor;
        state.rangePreviewValid = false;
      }
    }

    const previousViewportXMin = state.viewport.xMin;
    const previousViewportXMax = state.viewport.xMax;
    const viewportRequestId = readViewportRequestId(type, data);
    if (viewportRequestId !== undefined) pendingViewportRequestId = undefined;
    if (handleBaseMessage(state, type, data, minRange)) {
      // Instant viewport commands update state before a render frame. Sync them
      // here; animated commands are emitted by render as their values advance.
      if (
        state.viewport.xMin !== previousViewportXMin ||
        state.viewport.xMax !== previousViewportXMax
      ) {
        emitViewportSync(viewportRequestId);
      } else if (viewportRequestId !== undefined) {
        if (state.viewportAnimation.active) {
          pendingViewportRequestId = viewportRequestId;
        } else {
          emitViewportSync(viewportRequestId);
        }
      }
      if (type === "resize") {
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
        configuredMinRange = resolveMinViewportRange(config.minViewportRange, STOCK_MIN_RANGE);
        minRange = configuredMinRange;
        yDomain = resolveYDomain(config.yDomain);
        timeScale = config.timeScale === "market" ? "market" : "continuous";
        applyPadding(state, config);
        savePaddingBase(state);
        parseTextDirectionConfig(state, config);
        // Stock chart defaults (different from line chart)
        state.showLeftAxis = false;
        state.showRightAxis = true;
        state.showLeftAxisLabel = false;
        state.showRightAxisLabel = true;
        state.animated = config.animated ?? true;
        showVolume = config.showVolume ?? true;
        volumeOpacity = config.volumeOpacity ?? 0.35;
        volumeHeightRatio = config.volumeHeightRatio ?? 0.15;
        volumeColors = config.volumeColors ?? null;
        const crosshairMarkerColor =
          typeof config.crosshairMarkerColor === "string" && config.crosshairMarkerColor
            ? config.crosshairMarkerColor
            : DEFAULT_CURSOR_LABEL_COLOR;
        state.leftAxisLabelColor = crosshairMarkerColor;
        state.rightAxisLabelColor = crosshairMarkerColor;
        previewLineColor = config.previewLineColor ?? "#4a90d9";
        candleStyle = config.candleStyle ?? "filled";
        candleStrokeWidth = config.candleStrokeWidth ?? 1;
        if (config.candleColors) {
          const cc = config.candleColors;
          wickUpFollowsBody = cc.wickUp == null;
          wickDownFollowsBody = cc.wickDown == null;
          customCandleColors = {
            up: cc.up ?? CANDLE_COLORS.up,
            down: cc.down ?? CANDLE_COLORS.down,
            wickUp: cc.wickUp ?? cc.up ?? CANDLE_COLORS.wickUp,
            wickDown: cc.wickDown ?? cc.down ?? CANDLE_COLORS.wickDown,
          };
        } else {
          wickUpFollowsBody = true;
          wickDownFollowsBody = true;
          customCandleColors = { ...CANDLE_COLORS };
        }
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
        // Unit configuration for OHLC/volume formatting
        if ("priceUnit" in config) priceUnit = config.priceUnit ?? undefined;
        if ("volumeUnit" in config) volumeUnit = config.volumeUnit ?? undefined;
        // Auto-default cursor label units from priceUnit when not explicit
        const defaultUnit = priceUnit ?? null;
        if (!leftAxisUnitExplicit) state.leftAxisLabelUnit = defaultUnit;
        if (!rightAxisUnitExplicit) state.rightAxisLabelUnit = defaultUnit;
        // Chart labels
        if (config.labels) parseLabelsConfig(state, config.labels);
        // Overlay primitives
        if (config.overlay) parseOverlayConfig(state, config.overlay);
        setIndicators(config.indicators);
        setVolumeProfile(config.volumeProfile);
        setPriceLines(config.priceLines);
        setMarkers(config.markers);
        state.ctx = get2dContext(state.canvas, { alpha: false });
        measureLabelSpace(state);
        state.updateDimensions();
        postLayoutIfChanged();
        callbacks.postMessage({ type: "ready" });
        // Don't schedule render - no data yet
        break;
      }

      case "setData":
        deferInitialRenderUntilLODReady = true;
        setData(data.timestamp, data.open, data.high, data.low, data.close, data.volume);
        scheduleRender();
        break;

      case "setTimeRange":
        setTimeRange(data.range);
        scheduleRender();
        break;

      case "setTimeViewportRange":
        setTimeViewportRange(data.xMin, data.xMax, false);
        scheduleRender();
        break;

      case "setTimeViewportRangeAnimated":
        setTimeViewportRange(data.xMin, data.xMax, true);
        scheduleRender();
        break;

      case "setVolumeProfile":
        setVolumeProfile(data.volumeProfile);
        scheduleRender();
        break;

      case "setPriceLines":
        setPriceLines(data.priceLines);
        scheduleRender();
        break;

      case "setMarkers":
        setMarkers(data.markers);
        scheduleRender();
        break;

      case "setIndicators":
        setIndicators(data.indicators);
        scheduleRender();
        break;

      case "initRingBuffer":
        initRingBuffer(data.maxCandles);
        // Don't schedule render - start message will come after
        break;

      case "addCandles":
        if (data.initialTimeRange && dataLength === 0) {
          deferInitialRenderUntilLODReady = true;
        }
        addCandles(data.timestamps, data.opens, data.highs, data.lows, data.closes, data.volumes);
        if (data.initialTimeRange) {
          const animated = state.animated;
          state.animated = false;
          setTimeRange(data.initialTimeRange);
          state.animated = animated;
        }
        scheduleRender();
        break;

      case "addCandleBatches":
        if (dataLength === 0) deferInitialRenderUntilLODReady = true;
        for (let index = 0; index < data.batches.length; index++) {
          const batch = data.batches[index];
          addCandles(
            batch.timestamp,
            batch.open,
            batch.high,
            batch.low,
            batch.close,
            batch.volume,
            index < data.batches.length - 1,
            true,
          );
        }
        if (data.initialTimeRange) {
          const animated = state.animated;
          state.animated = false;
          setTimeRange(data.initialTimeRange, false);
          state.animated = animated;
        }
        emitViewportSync();
        scheduleRender();
        break;

      case "setStatsConfig":
        applyStatsConfigFromMessage(stats, data);
        break;

      case "tooltipContent": {
        handleTooltipContentMessage(state, data, "#eee");
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

  const engine: StockChartEngine = {
    handleMessage,
  };
  Object.defineProperty(engine, Symbol.for("sixtyfold:test:stock-engine-state"), {
    value: state,
  });
  return engine;
}
