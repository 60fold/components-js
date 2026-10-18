import { expectTypeOf, it } from "vitest";
import type { EventEmitter } from "@angular/core";
import type { LineChartStats } from "@sixtyfold/line";
import type { StockChartStats } from "@sixtyfold/stock";
import type { SixtyfoldLineChartComponent } from "../line/public-api.js";
import type { SixtyfoldStockChartComponent } from "../stock/public-api.js";

it("preserves the line stats output and interval input types", () => {
  expectTypeOf<SixtyfoldLineChartComponent["stats"]>().toEqualTypeOf<
    EventEmitter<LineChartStats>
  >();
  expectTypeOf<Pick<SixtyfoldLineChartComponent, "stats">>().toEqualTypeOf<{
    readonly stats: EventEmitter<LineChartStats>;
  }>();
  expectTypeOf<Pick<SixtyfoldLineChartComponent, "statsIntervalMs">>().toEqualTypeOf<{
    statsIntervalMs?: number;
  }>();
});

it("preserves the stock stats output and interval input types", () => {
  expectTypeOf<SixtyfoldStockChartComponent["stats"]>().toEqualTypeOf<
    EventEmitter<StockChartStats>
  >();
  expectTypeOf<Pick<SixtyfoldStockChartComponent, "stats">>().toEqualTypeOf<{
    readonly stats: EventEmitter<StockChartStats>;
  }>();
  expectTypeOf<Pick<SixtyfoldStockChartComponent, "statsIntervalMs">>().toEqualTypeOf<{
    statsIntervalMs?: number;
  }>();
});
