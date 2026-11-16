export function isSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
}

// Ensure a [min, max] span is strictly positive so downstream divisions by the
// range never produce Infinity/NaN (e.g. flat/constant series or a single point).
// When degenerate, expand symmetrically around the center. A positive
// `fallbackSpan` forces that absolute span; a non-positive `fallbackSpan` derives
// a span from the value's magnitude so the axis stays readable.
export function ensurePositiveSpan(
  min: number,
  max: number,
  fallbackSpan: number,
): { min: number; max: number } {
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) ? max : 0;
  if (hi > lo) return { min: lo, max: hi };
  const center = (lo + hi) / 2;
  const span = fallbackSpan > 0 ? fallbackSpan : Math.max(Math.abs(center) * 0.02, 1);
  return { min: center - span / 2, max: center + span / 2 };
}

/**
 * Resolve a construction-time minimum X viewport span. Values use the same
 * units as the chart's X data; invalid or non-positive overrides retain the
 * chart-type fallback.
 */
export function resolveMinViewportRange(value: unknown, fallback: number): number {
  const safeFallback = Number.isFinite(fallback) && fallback >= 0 ? fallback : 0;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : safeFallback;
}

/** Optional fixed edges for the rendered Y domain. */
export interface YDomainOptions {
  /** Fixed lower edge. Omit to derive it from the visible data. */
  min?: number;
  /** Fixed upper edge. Omit to derive it from the visible data. */
  max?: number;
}

/**
 * Sanitize a construction-time Y domain. Missing edges remain auto-scaled.
 * An inverted fully fixed domain is ignored so renderers retain a valid span.
 */
export function resolveYDomain(value: unknown): YDomainOptions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const min =
    typeof candidate.min === "number" && Number.isFinite(candidate.min) ? candidate.min : undefined;
  const max =
    typeof candidate.max === "number" && Number.isFinite(candidate.max) ? candidate.max : undefined;
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && max <= min) return undefined;
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

/**
 * Apply fixed Y-domain edges after a renderer calculates its visible extrema.
 * A single fixed edge remains authoritative even when all visible data lies
 * beyond it; the auto edge is expanded just enough to retain a positive span.
 */
export function applyYDomain(
  yMin: number,
  yMax: number,
  domain: YDomainOptions | undefined,
): { min: number; max: number } {
  const automatic = ensurePositiveSpan(yMin, yMax, 0);
  const resolved = resolveYDomain(domain);
  if (!resolved) return automatic;
  if (resolved.min !== undefined && resolved.max !== undefined) {
    return { min: resolved.min, max: resolved.max };
  }
  if (resolved.min !== undefined) {
    const min = resolved.min;
    const span = Math.max(Math.abs(min) * 0.02, 1);
    return {
      min,
      max: automatic.max > min ? automatic.max : min + span,
    };
  }
  const max = resolved.max as number;
  const span = Math.max(Math.abs(max) * 0.02, 1);
  return {
    min: automatic.min < max ? automatic.min : max - span,
    max,
  };
}

export interface AxisBounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface TimeFormatOptions {
  type: "time";
  locale?: string | string[];
  timeZone?: string;
  hour12?: boolean;
}

function dateTimeFormatOptions(
  options: TimeFormatOptions | undefined,
): Pick<Intl.DateTimeFormatOptions, "timeZone" | "hour12"> {
  const out: Pick<Intl.DateTimeFormatOptions, "timeZone" | "hour12"> = {};
  if (options?.timeZone) out.timeZone = options.timeZone;
  if (typeof options?.hour12 === "boolean") out.hour12 = options.hour12;
  return out;
}

type AxisDateTimeStyle = "hms" | "hm" | "weekday" | "monthDay" | "month" | "monthYear";

const AXIS_DATE_TIME_STYLES: Record<AxisDateTimeStyle, Intl.DateTimeFormatOptions> = {
  hms: { hour: "2-digit", minute: "2-digit", second: "2-digit" },
  hm: { hour: "2-digit", minute: "2-digit" },
  weekday: { weekday: "short", day: "numeric" },
  monthDay: { month: "short", day: "numeric" },
  month: { month: "short" },
  monthYear: { month: "short", year: "2-digit" },
};

const MAX_AXIS_DATE_TIME_FORMATTERS = 64;
const axisDateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatAxisDateTime(
  date: Date,
  options: TimeFormatOptions | undefined,
  style: AxisDateTimeStyle,
): string {
  const key = `${options?.locale ?? ""}\u0000${options?.timeZone ?? ""}\u0000${String(options?.hour12 ?? "")}\u0000${style}`;
  let formatter = axisDateTimeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(options?.locale, {
      ...dateTimeFormatOptions(options),
      ...AXIS_DATE_TIME_STYLES[style],
    });
    if (axisDateTimeFormatters.size >= MAX_AXIS_DATE_TIME_FORMATTERS) {
      axisDateTimeFormatters.delete(axisDateTimeFormatters.keys().next().value!);
    }
    axisDateTimeFormatters.set(key, formatter);
  }
  return formatter.format(date);
}

// Shared batch and streaming bounds normalization.
export function normalizeBounds(
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number,
  xFallbackSpan: number,
): AxisBounds {
  // Keep pairwise differences finite for extreme input magnitudes.
  const safeYMin = clampMagnitude(yMin, 0);
  const safeYMax = clampMagnitude(yMax, 100);
  const xs = ensurePositiveSpan(clampMagnitude(xMin, 0), clampMagnitude(xMax, 0), xFallbackSpan);
  const ys = ensurePositiveSpan(safeYMin, safeYMax, 0);
  return { xMin: xs.min, xMax: xs.max, yMin: ys.min, yMax: ys.max };
}

const SAFE_COORD_LIMIT = Number.MAX_VALUE / 4;

function clampMagnitude(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.max(-SAFE_COORD_LIMIT, Math.min(SAFE_COORD_LIMIT, v));
}

// Right-pinned streaming views follow new data; other views stay fixed and clamp.
export function followViewportX(
  prevViewport: { xMin: number; xMax: number },
  prevDataBounds: { xMin: number; xMax: number },
  prevDataLength: number,
  xMin: number,
  xMax: number,
  minRange: number,
): { xMin: number; xMax: number; reset: boolean } {
  const previousRange = prevViewport.xMax - prevViewport.xMin;
  if (prevDataLength === 0 || !Number.isFinite(previousRange) || previousRange <= 0) {
    return { xMin, xMax, reset: true };
  }

  const previousDataRange = prevDataBounds.xMax - prevDataBounds.xMin;
  const wasFollowingRight =
    Math.abs(prevViewport.xMax - prevDataBounds.xMax) <= Math.max(1, previousDataRange * 0.001);
  const dataRange = xMax - xMin;
  const nextRange = Math.min(previousRange, Math.max(dataRange, minRange));

  if (wasFollowingRight) {
    return { xMin: Math.max(xMin, xMax - nextRange), xMax, reset: false };
  }

  let nextXMin = prevViewport.xMin;
  let nextXMax = prevViewport.xMax;
  if (nextXMin < xMin) {
    nextXMin = xMin;
    nextXMax = Math.min(xMax, xMin + nextRange);
  } else if (nextXMax > xMax) {
    nextXMax = xMax;
    nextXMin = Math.max(xMin, xMax - nextRange);
  }
  return { xMin: nextXMin, xMax: nextXMax, reset: false };
}

// Calculate nice step values for numeric axes
export function calculateStep(range: number, targetSteps: number): number {
  // Guard against non-positive/non-finite ranges: log10(0) = -Infinity yields a
  // NaN step that silently erases all ticks (and can stall tick loops).
  if (!(range > 0) || !Number.isFinite(range) || !(targetSteps > 0)) {
    return 1;
  }

  const rawStep = range / targetSteps;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;

  let step: number;
  if (normalized <= 1) step = 1;
  else if (normalized <= 2) step = 2;
  else if (normalized <= 5) step = 5;
  else step = 10;

  return step * magnitude;
}

// Calculate nice step values for time axes
// Pass xMin to help auto-detect if timestamps are in seconds or milliseconds
export function calculateTimeStep(range: number, targetSteps: number, xMin?: number): number {
  // If xMin > 1e11, timestamps are in milliseconds (any ms date after ~1973 is > 1e11)
  // If xMin < 1e11, timestamps are in seconds (any second date before ~5138 is < 1e11)
  const isMilliseconds = xMin !== undefined ? xMin > 1e11 : range > 1e11;

  // Base units
  const SECOND = isMilliseconds ? 1000 : 1;
  const MINUTE = SECOND * 60;
  const HOUR_UNIT = MINUTE * 60;
  const DAY = HOUR_UNIT * 24;
  const YEAR = DAY * 365;

  const intervals = [
    // Sub-second intervals
    SECOND / 1000, // 1 ms
    SECOND / 500, // 2 ms
    SECOND / 200, // 5 ms
    SECOND / 100, // 10 ms
    SECOND / 50, // 20 ms
    SECOND / 20, // 50 ms
    SECOND / 10, // 100 ms
    SECOND / 5, // 200 ms
    SECOND / 2, // 500 ms

    SECOND, // 1 second
    SECOND * 2, // 2 seconds
    SECOND * 5, // 5 seconds
    SECOND * 10, // 10 seconds
    SECOND * 15, // 15 seconds
    SECOND * 30, // 30 seconds
    MINUTE, // 1 minute
    MINUTE * 2, // 2 minutes
    MINUTE * 5, // 5 minutes
    MINUTE * 10, // 10 minutes
    MINUTE * 15, // 15 minutes
    MINUTE * 30, // 30 minutes
    HOUR_UNIT, // 1 hour
    HOUR_UNIT * 2, // 2 hours
    HOUR_UNIT * 3, // 3 hours
    HOUR_UNIT * 4, // 4 hours
    HOUR_UNIT * 6, // 6 hours
    HOUR_UNIT * 8, // 8 hours
    HOUR_UNIT * 12, // 12 hours
    DAY, // 1 day
    DAY * 2, // 2 days
    DAY * 3, // 3 days
    DAY * 4, // 4 days
    DAY * 5, // 5 days
    DAY * 7, // 1 week
    DAY * 10, // 10 days
    DAY * 14, // 2 weeks
    DAY * 21, // 3 weeks
    DAY * 30, // 1 month
    DAY * 45, // 1.5 months
    DAY * 60, // 2 months
    DAY * 90, // 3 months
    DAY * 120, // 4 months
    DAY * 180, // 6 months
    DAY * 270, // 9 months
    YEAR, // 1 year
    YEAR * 2, // 2 years
    YEAR * 5, // 5 years
    YEAR * 10, // 10 years
    YEAR * 20, // 20 years
    YEAR * 50, // 50 years
    YEAR * 100, // 100 years
  ];

  const rawStep = range / targetSteps;

  // Find the first interval that is >= rawStep
  for (const interval of intervals) {
    if (interval >= rawStep) return interval;
  }

  // Exceeded largest interval - generate multiples of 100 years
  const lastInterval = intervals[intervals.length - 1];
  return Math.ceil(rawStep / lastInterval) * lastInterval;
}

// Number.prototype.toLocaleString builds a new Intl.NumberFormat on every call.
// Axis and tooltip labels are formatted on every redraw, so reuse one formatter
// per shape. Each is created lazily and formats exactly like toLocaleString.
let wholePriceFormatter: Intl.NumberFormat | undefined;
let smallVolumeFormatter: Intl.NumberFormat | undefined;

// Format price for display
export function formatPrice(price: number): string {
  if (Math.abs(price) >= 1000) {
    wholePriceFormatter ??= new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
    return wholePriceFormatter.format(price);
  }
  if (Math.abs(price) >= 1) return price.toFixed(2);
  if (Math.abs(price) < 0.000001 && price !== 0) return price.toExponential(2);
  return price.toFixed(4);
}

// Format volume for display
export function formatVolume(vol: number): string {
  const absVolume = Math.abs(vol);
  const sign = vol < 0 ? "-" : "";
  if (absVolume >= 1e9) return sign + (absVolume / 1e9).toFixed(2) + "B";
  if (absVolume >= 1e6) return sign + (absVolume / 1e6).toFixed(2) + "M";
  if (absVolume >= 1e3) return sign + (absVolume / 1e3).toFixed(2) + "K";
  if (absVolume < 0.0001 && absVolume !== 0) return vol.toExponential(2);
  smallVolumeFormatter ??= new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
  return smallVolumeFormatter.format(vol);
}

// Format time label based on range
// Auto-detects if timestamp is in seconds or milliseconds based on magnitude
export function formatTimeLabel(
  timestamp: number,
  xRange: number,
  options?: TimeFormatOptions,
): string {
  // If timestamp > 1e11, it's in milliseconds (any ms date after ~1973 is > 1e11)
  const isMilliseconds = timestamp > 1e11;
  const tsMs = isMilliseconds ? timestamp : timestamp * 1000;
  const rangeMs = isMilliseconds ? xRange : xRange * 1000;
  const date = new Date(tsMs);

  const SECOND_MS = 1000;
  const MINUTE_MS = 60 * SECOND_MS;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  const WEEK_MS = 7 * DAY_MS;
  const MONTH_MS = 30 * DAY_MS;
  const YEAR_MS = 365 * DAY_MS;

  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const ms = date.getMilliseconds();
  const isMidnight = hours === 0 && minutes === 0 && seconds === 0 && ms === 0;
  const isFirstOfMonth = date.getDate() === 1;

  if (rangeMs < SECOND_MS) {
    // < 1 second: show SS.mss
    return `${formatAxisDateTime(date, options, "hms")}.${ms.toString().padStart(3, "0")}`;
  } else if (rangeMs < MINUTE_MS) {
    // < 1 minute: show HH:mm:ss
    return formatAxisDateTime(date, options, "hms");
  } else if (rangeMs < DAY_MS) {
    // < 1 day: show HH:mm
    return formatAxisDateTime(date, options, "hm");
  } else if (rangeMs < WEEK_MS) {
    // < 1 week: show Day HH:mm or Day only if midnight
    if (isMidnight) {
      return formatAxisDateTime(date, options, "weekday");
    }
    return formatAxisDateTime(date, options, "hm");
  } else if (rangeMs < MONTH_MS * 3) {
    // < 3 months: show Month Day
    return formatAxisDateTime(date, options, "monthDay");
  } else if (rangeMs < YEAR_MS) {
    // < 1 year: show Month (if 1st) or Month Day
    if (isFirstOfMonth) {
      return formatAxisDateTime(date, options, "month");
    }
    return formatAxisDateTime(date, options, "monthDay");
  } else if (rangeMs < YEAR_MS * 5) {
    // 1-5 years: Month Year
    return formatAxisDateTime(date, options, "monthYear");
  } else {
    // > 5 years: Year only
    return date.getFullYear().toString();
  }
}
