import { expectTypeOf, it } from "vitest";
import type { LineChartStats } from "@sixtyfold/line";
import type { StockChartStats } from "@sixtyfold/stock";
import type { SixtyfoldLineChart } from "../src/line.js";
import type { SixtyfoldStockChart } from "../src/stock.js";

type LineProps = InstanceType<typeof SixtyfoldLineChart>["$props"];
type StockProps = InstanceType<typeof SixtyfoldStockChart>["$props"];
type Listener<T> = ((stats: T) => void) | ((stats: T) => void)[] | null | undefined;

it("exposes accurate line stats listener and once-listener prop types", () => {
  expectTypeOf<LineProps["onStats"]>().toEqualTypeOf<Listener<LineChartStats>>();
  expectTypeOf<LineProps["onStatsOnce"]>().toEqualTypeOf<Listener<LineChartStats>>();

  // Exercise contextual typing for both single handlers and handler arrays.
  const props = {
    onStats: (stats) => {
      expectTypeOf(stats).toEqualTypeOf<LineChartStats>();
    },
    onStatsOnce: [
      (stats) => {
        expectTypeOf(stats).toEqualTypeOf<LineChartStats>();
      },
    ],
  } satisfies Pick<LineProps, "onStats" | "onStatsOnce">;

  expectTypeOf(props).toExtend<LineProps>();
});

it("exposes accurate stock stats listener and once-listener prop types", () => {
  expectTypeOf<StockProps["onStats"]>().toEqualTypeOf<Listener<StockChartStats>>();
  expectTypeOf<StockProps["onStatsOnce"]>().toEqualTypeOf<Listener<StockChartStats>>();

  const props = {
    onStats: [
      (stats) => {
        expectTypeOf(stats).toEqualTypeOf<StockChartStats>();
      },
    ],
    onStatsOnce: (stats) => {
      expectTypeOf(stats).toEqualTypeOf<StockChartStats>();
    },
  } satisfies Pick<StockProps, "onStats" | "onStatsOnce">;

  expectTypeOf(props).toExtend<StockProps>();
});
