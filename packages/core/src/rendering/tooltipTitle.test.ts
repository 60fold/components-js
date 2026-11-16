import { describe, expect, it, vi } from "vitest";
import { formatTooltipTitle } from "./baseRenderer";

describe("formatTooltipTitle", () => {
  const timestampMs = Date.UTC(2026, 2, 29, 1, 30, 15);

  it("formats timestamps exactly like Date.prototype.toLocaleString", () => {
    expect(formatTooltipTitle(timestampMs, null)).toBe(new Date(timestampMs).toLocaleString());
    expect(formatTooltipTitle(timestampMs, "time")).toBe(new Date(timestampMs).toLocaleString());
    expect(formatTooltipTitle(timestampMs / 1000, "time")).toBe(
      new Date(timestampMs).toLocaleString(),
    );

    const cases = [
      { locale: "en-US", timeZone: "UTC", hour12: false },
      { locale: "de-DE", timeZone: "Europe/Lisbon" },
      { locale: ["ja-JP", "en"], hour12: true },
      { timeZone: "Australia/Lord_Howe" },
      { locale: "ar-EG" },
    ];
    for (const options of cases) {
      const intlOptions: Intl.DateTimeFormatOptions = {};
      if (options.timeZone) intlOptions.timeZone = options.timeZone;
      if (typeof options.hour12 === "boolean") intlOptions.hour12 = options.hour12;
      const expected = new Date(timestampMs).toLocaleString(
        options.locale,
        Object.keys(intlOptions).length > 0 ? intlOptions : undefined,
      );
      expect(formatTooltipTitle(timestampMs, { type: "time", ...options })).toBe(expected);
    }
  });

  it("keeps the invalid-date text instead of throwing", () => {
    expect(formatTooltipTitle(Number.POSITIVE_INFINITY, "time")).toBe("Invalid Date");
    expect(formatTooltipTitle(9e15, { type: "time", locale: "en-US" })).toBe("Invalid Date");
  });

  it("reuses the date formatter across hover frames with the same options", () => {
    const format = { type: "time", locale: "en-GB", timeZone: "UTC" } as const;
    formatTooltipTitle(timestampMs, format);
    const dateTimeFormat = vi.spyOn(Intl, "DateTimeFormat");
    const toLocaleString = vi.spyOn(Date.prototype, "toLocaleString");
    try {
      for (let index = 0; index < 50; index++) {
        formatTooltipTitle(timestampMs + index * 1000, { ...format });
      }
      expect(dateTimeFormat).not.toHaveBeenCalled();
      expect(toLocaleString).not.toHaveBeenCalled();
    } finally {
      dateTimeFormat.mockRestore();
      toLocaleString.mockRestore();
    }
  });

  it("formats numeric and unit titles without a date formatter", () => {
    expect(formatTooltipTitle(42.4, "number")).toBe("42");
    expect(formatTooltipTitle(1234, null)).toBe("1234");
  });
});
