import { describe, it, expect, vi } from "vitest";
import {
  calculateStep,
  calculateTimeStep,
  formatPrice,
  formatTimeLabel,
  formatVolume,
  ensurePositiveSpan,
  applyYDomain,
  resolveMinViewportRange,
  resolveYDomain,
} from "./chartUtils";

describe("chartUtils", () => {
  it("calculates numeric step sizes", () => {
    expect(calculateStep(100, 5)).toBe(20);
    expect(calculateStep(95, 5)).toBe(20);
  });

  it("returns a finite step for non-positive/non-finite ranges", () => {
    // range 0 would otherwise produce NaN (log10(0) = -Infinity) and erase ticks
    expect(calculateStep(0, 5)).toBe(1);
    expect(calculateStep(-10, 5)).toBe(1);
    expect(calculateStep(Infinity, 5)).toBe(1);
    expect(calculateStep(100, 0)).toBe(1);
  });

  describe("ensurePositiveSpan", () => {
    it("passes through an already-positive span", () => {
      expect(ensurePositiveSpan(0, 100, 0)).toEqual({ min: 0, max: 100 });
    });

    it("expands a degenerate span using an explicit fallback", () => {
      expect(ensurePositiveSpan(500, 500, 10)).toEqual({ min: 495, max: 505 });
    });

    it("expands a flat span around its value when no fallback given", () => {
      // |center| * 2% = 100, so span is 100 centered on 5000
      const { min, max } = ensurePositiveSpan(5000, 5000, 0);
      expect(min).toBe(4950);
      expect(max).toBe(5050);
      expect(max - min).toBeGreaterThan(0);
    });

    it("expands a flat span at zero to a unit span", () => {
      expect(ensurePositiveSpan(0, 0, 0)).toEqual({ min: -0.5, max: 0.5 });
    });

    it("coerces non-finite bounds to a finite positive span", () => {
      const { min, max } = ensurePositiveSpan(NaN, NaN, 0);
      expect(Number.isFinite(min)).toBe(true);
      expect(Number.isFinite(max)).toBe(true);
      expect(max).toBeGreaterThan(min);
    });
  });

  describe("resolveMinViewportRange", () => {
    it("uses a positive finite override in X-axis units", () => {
      expect(resolveMinViewportRange(60_000, 10)).toBe(60_000);
    });

    it("falls back for non-positive or non-finite overrides", () => {
      expect(resolveMinViewportRange(0, 10)).toBe(10);
      expect(resolveMinViewportRange(-1, 10)).toBe(10);
      expect(resolveMinViewportRange(Number.NaN, 10)).toBe(10);
      expect(resolveMinViewportRange(Number.POSITIVE_INFINITY, 10)).toBe(10);
    });
  });

  describe("Y domains", () => {
    it("keeps omitted edges automatic and pins configured edges", () => {
      expect(resolveYDomain({ min: 0, max: 100 })).toEqual({
        min: 0,
        max: 100,
      });
      expect(applyYDomain(20, 80, { min: 0, max: 100 })).toEqual({
        min: 0,
        max: 100,
      });
      expect(applyYDomain(20, 80, { max: 100 })).toEqual({
        min: 20,
        max: 100,
      });
    });

    it("ignores invalid domains and preserves a positive partial span", () => {
      expect(resolveYDomain({ min: 100, max: 0 })).toBeUndefined();
      expect(resolveYDomain({ min: Number.NaN })).toBeUndefined();
      expect(applyYDomain(120, 140, { max: 100 })).toEqual({
        min: 98,
        max: 100,
      });
    });

    it("keeps direct applyYDomain calls positive for invalid fixed spans", () => {
      expect(applyYDomain(20, 80, { min: 5, max: 5 })).toEqual({
        min: 20,
        max: 80,
      });
      expect(applyYDomain(20, 80, { min: 10, max: 5 })).toEqual({
        min: 20,
        max: 80,
      });
      expect(applyYDomain(20, 80, { min: Number.NaN, max: Number.NaN })).toEqual({
        min: 20,
        max: 80,
      });
    });
  });

  it("calculates time step sizes", () => {
    expect(calculateTimeStep(3600, 6, 0)).toBe(600);
  });

  it("formats volume with bounded precision and suffixes", () => {
    expect(formatVolume(509.41990000000004)).toBe("509.4199");
    expect(formatVolume(500)).toBe("500");
    expect(formatVolume(0.00001)).toBe("1.00e-5");
    expect(formatVolume(1_200)).toBe("1.20K");
    expect(formatVolume(2_500_000)).toBe("2.50M");
  });

  it("formats grouped prices and small volumes like toLocaleString", () => {
    for (const price of [1000, 1234.5, 98_765.49, -4_200.5, 1e9]) {
      expect(formatPrice(price)).toBe(
        price.toLocaleString(undefined, { maximumFractionDigits: 0 }),
      );
    }
    expect(formatPrice(12.345)).toBe("12.35");
    expect(formatPrice(0.5)).toBe("0.5000");
    for (const volume of [0.5, 12.34567, 999.99994, -3.25]) {
      expect(formatVolume(volume)).toBe(
        volume.toLocaleString(undefined, { maximumFractionDigits: 4 }),
      );
    }
  });

  it("reuses one number formatter across repeated price and volume labels", () => {
    formatPrice(1500);
    formatVolume(12.5);
    const numberFormat = vi.spyOn(Intl, "NumberFormat");
    const toLocaleString = vi.spyOn(Number.prototype, "toLocaleString");
    try {
      for (let index = 0; index < 50; index++) {
        formatPrice(1000 + index);
        formatVolume(index + 0.25);
      }
      expect(numberFormat).not.toHaveBeenCalled();
      expect(toLocaleString).not.toHaveBeenCalled();
    } finally {
      numberFormat.mockRestore();
      toLocaleString.mockRestore();
    }
  });

  it("formats time labels with an explicit locale", () => {
    const timestamp = Date.UTC(2020, 5, 7, 12, 0, 0) / 1000;
    const range = 120 * 24 * 60 * 60;

    expect(formatTimeLabel(timestamp, range, { type: "time", locale: "ar", timeZone: "UTC" })).toBe(
      "7 يونيو",
    );
  });

  it("reuses equivalent date-time formatters across axis labels", () => {
    const DateTimeFormat = Intl.DateTimeFormat;
    function MockDateTimeFormat(
      locale?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ): Intl.DateTimeFormat {
      return new DateTimeFormat(locale, options);
    }
    const formatter = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(MockDateTimeFormat as typeof Intl.DateTimeFormat);
    const timestamp = Date.UTC(2026, 7, 8, 12, 34, 0) / 1000;
    const options = { type: "time" as const, locale: "en-GB", timeZone: "Pacific/Kiritimati" };

    formatTimeLabel(timestamp, 3_600, options);
    formatTimeLabel(timestamp + 60, 3_600, { ...options });

    expect(formatter).toHaveBeenCalledOnce();
    formatter.mockRestore();
  });
});
