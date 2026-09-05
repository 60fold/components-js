/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseChart } from "@sixtyfold/core/chart/BaseChart";
import { StockChart, type StockChartOptions } from "./StockChart";
import type { ChartWorkerLike } from "@sixtyfold/core/chart/workerInterface";
import { markViewportInputBatchRenderer } from "../../core/src/chart/internalRendererCapabilities";

interface RecordedMessage {
  message: Record<string, any>;
  transfer?: Transferable[];
}

function createChart(options: StockChartOptions = {}, initError?: string) {
  const messages: RecordedMessage[] = [];
  const worker: ChartWorkerLike = {
    onmessage: null,
    postMessage(message, transfer) {
      messages.push({ message, transfer });
      if (message.type === "init" && initError) {
        this.onmessage?.(
          new MessageEvent("message", {
            data: { type: "initError", error: { message: initError } },
          }),
        );
      }
    },
    terminate: vi.fn(),
  };
  markViewportInputBatchRenderer(worker);
  vi.spyOn(BaseChart as any, "selectChartRenderer").mockReturnValue({
    renderer: () => worker,
    useWorker: true,
    resolvedRenderMode: "worker",
  });

  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 800,
        bottom: 400,
        width: 800,
        height: 400,
        toJSON: () => ({}),
      }) as DOMRect,
  });
  document.body.appendChild(canvas);

  const chart = new StockChart(canvas, options);
  messages.length = 0;
  return { canvas, chart, messages, worker };
}

function installAnimationFrameHarness(): {
  pending(): number;
  nextCallback(): FrameRequestCallback;
  flush(): void;
} {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      callbacks.delete(id);
    }),
  );
  return {
    pending() {
      return callbacks.size;
    },
    nextCallback() {
      const callback = callbacks.values().next().value;
      if (!callback) throw new Error("No animation frame is pending");
      return callback;
    },
    flush() {
      const pending = [...callbacks];
      for (const [id, callback] of pending) {
        if (!callbacks.delete(id)) continue;
        callback(performance.now());
      }
    },
  };
}

function packedColumns(): Float64Array[] {
  const buffer = new ArrayBuffer(6 * 2 * Float64Array.BYTES_PER_ELEMENT);
  return Array.from(
    { length: 6 },
    (_, index) => new Float64Array(buffer, index * 2 * Float64Array.BYTES_PER_ELEMENT, 2),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("StockChart transfer lists", () => {
  it("flushes pending wheel input before setData", () => {
    const frames = installAnimationFrameHarness();
    const { canvas, chart, messages } = createChart({ interactive: true });

    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -120,
        clientX: 100,
        clientY: 100,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(messages).toEqual([]);
    expect(frames.pending()).toBe(1);

    const [timestamp, open, high, low, close, volume] = packedColumns();
    chart.setData({ timestamp, open, high, low, close, volume, length: 2 });

    expect(messages.map(({ message }) => message.type)).toEqual([
      "viewportInputBatch",
      "setData",
      "start",
    ]);
    expect(frames.pending()).toBe(0);
    chart.destroy();
  });

  it("deduplicates packed OHLCV buffers in setData", () => {
    const { chart, messages } = createChart();
    const [timestamp, open, high, low, close, volume] = packedColumns();

    chart.setData({ timestamp, open, high, low, close, volume, length: 2 });

    const sent = messages.find(({ message }) => message.type === "setData");
    expect(sent?.transfer).toEqual([timestamp.buffer]);
    chart.destroy();
  });

  it("deduplicates packed OHLCV buffers in addCandles", () => {
    const { chart, messages } = createChart();
    const [timestamps, opens, highs, lows, closes, volumes] = packedColumns();

    chart.addCandles(timestamps, opens, highs, lows, closes, volumes);

    const sent = messages.find(({ message }) => message.type === "addCandles");
    expect(sent?.transfer).toEqual([timestamps.buffer]);
    chart.destroy();
  });

  it("sends an initial streaming range with the bulk candle transfer", () => {
    const { chart, messages } = createChart();
    const [timestamps, opens, highs, lows, closes, volumes] = packedColumns();

    chart.addCandles(timestamps, opens, highs, lows, closes, volumes, {
      initialTimeRange: "5D",
    });

    const sent = messages.find(({ message }) => message.type === "addCandles");
    expect(sent?.message.initialTimeRange).toBe("5D");
    expect(sent?.transfer).toEqual([timestamps.buffer]);
    chart.destroy();
  });

  it("transfers multiple initial candle batches in one renderer message", () => {
    const { chart, messages } = createChart();
    const first = packedColumns();
    const second = packedColumns();

    chart.addCandleBatches(
      [
        {
          timestamp: first[0],
          open: first[1],
          high: first[2],
          low: first[3],
          close: first[4],
          volume: first[5],
        },
        {
          timestamp: second[0],
          open: second[1],
          high: second[2],
          low: second[3],
          close: second[4],
          volume: second[5],
        },
      ],
      { initialTimeRange: "5D" },
    );

    const sent = messages.find(({ message }) => message.type === "addCandleBatches");
    expect(sent?.message.batches).toHaveLength(2);
    expect(sent?.message.initialTimeRange).toBe("5D");
    expect(sent?.transfer).toEqual([first[0].buffer, second[0].buffer]);
    chart.destroy();
  });

  it("normalizes descending data before transferring it", () => {
    const { chart, messages } = createChart();
    const timestamp = new Float64Array([3, 2, 1]);
    const open = new Float64Array([30, 20, 10]);
    const high = new Float64Array([31, 21, 11]);
    const low = new Float64Array([29, 19, 9]);
    const close = new Float64Array([30.5, 20.5, 10.5]);
    const volume = new Float64Array([300, 200, 100]);

    chart.setData({ timestamp, open, high, low, close, volume, length: 3 });

    const sent = messages.find(({ message }) => message.type === "setData");
    expect(Array.from(sent!.message.timestamp)).toEqual([1, 2, 3]);
    expect(Array.from(sent!.message.open)).toEqual([10, 20, 30]);
    expect(sent?.transfer).toContain(sent!.message.timestamp.buffer);
    expect(Array.from(timestamp)).toEqual([3, 2, 1]);
    chart.destroy();
  });
});

describe("StockChart scalar candle batching", () => {
  it("flushes earlier scalar candles before a bulk append without copying its columns", () => {
    const frames = installAnimationFrameHarness();
    const { chart, messages } = createChart();
    chart.addCandle(1, 10, 12, 9, 11, 100);
    chart.addCandle(2, 11, 13, 10, 12, 200);
    const [timestamps, opens, highs, lows, closes, volumes] = packedColumns();
    timestamps.set([3, 4]);

    chart.addCandles(timestamps, opens, highs, lows, closes, volumes, { initialTimeRange: "5D" });

    const sent = messages.filter(({ message }) => message.type === "addCandles");
    expect(sent.map(({ message }) => Array.from(message.timestamps))).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(Array.from(sent[0].message.opens)).toEqual([10, 11]);
    expect(Array.from(sent[0].message.highs)).toEqual([12, 13]);
    expect(Array.from(sent[0].message.lows)).toEqual([9, 10]);
    expect(Array.from(sent[0].message.closes)).toEqual([11, 12]);
    expect(Array.from(sent[0].message.volumes)).toEqual([100, 200]);
    expect(sent[0].message.initialTimeRange).toBeUndefined();
    expect(sent[1].message.initialTimeRange).toBe("5D");
    for (const [key, column] of Object.entries({
      timestamps,
      opens,
      highs,
      lows,
      closes,
      volumes,
    })) {
      expect(sent[1].message[key]).toBe(column);
    }
    expect(sent[1].transfer).toEqual([timestamps.buffer]);
    frames.flush();
    expect(messages.filter(({ message }) => message.type === "addCandles")).toHaveLength(2);
    chart.destroy();
  });

  it("flushes scalar candles before multiple bulk chunks and retains the initial range on the bulk message", () => {
    const frames = installAnimationFrameHarness();
    const { chart, messages } = createChart();
    chart.addCandle(1, 10, 12, 9, 11, 100);
    const batches = [2, 4].map((start) => {
      const [timestamp, open, high, low, close, volume] = packedColumns();
      timestamp.set([start, start + 1]);
      return { timestamp, open, high, low, close, volume };
    });

    chart.addCandleBatches(batches, { initialTimeRange: "5D" });

    expect(messages.map(({ message }) => message.type)).toEqual(["addCandles", "addCandleBatches"]);
    expect(Array.from(messages[0].message.timestamps)).toEqual([1]);
    expect(messages[0].message.initialTimeRange).toBeUndefined();
    expect(messages[1].message.initialTimeRange).toBe("5D");
    expect(messages[1].message.batches[0]).toBe(batches[0]);
    expect(messages[1].message.batches[1]).toBe(batches[1]);
    expect(messages[1].transfer).toEqual(batches.map((batch) => batch.timestamp.buffer));
    frames.flush();
    expect(messages.filter(({ message }) => message.type === "addCandles")).toHaveLength(1);
    chart.destroy();
  });

  it("leaves scalar batching intact when a bulk batch list is empty", () => {
    const frames = installAnimationFrameHarness();
    const { chart, messages } = createChart();
    chart.addCandle(1, 10, 12, 9, 11, 100);
    chart.addCandleBatches([]);
    expect(messages).toEqual([]);
    expect(frames.pending()).toBe(1);
    frames.flush();
    expect(Array.from(messages[0].message.timestamps)).toEqual([1]);
    chart.destroy();
  });

  it.each(["bulk flush", "initStreaming", "setData"] as const)(
    "prevents a canceled scalar callback from draining newer samples after %s",
    (boundary) => {
      const frames = installAnimationFrameHarness();
      const { chart, messages } = createChart();
      chart.addCandle(1, 10, 12, 9, 11, 100);
      const staleCallback = frames.nextCallback();
      if (boundary === "bulk flush") {
        const [timestamps, opens, highs, lows, closes, volumes] = packedColumns();
        chart.addCandles(timestamps, opens, highs, lows, closes, volumes);
      } else if (boundary === "initStreaming") {
        chart.initStreaming(10);
      } else {
        const [timestamp, open, high, low, close, volume] = packedColumns();
        chart.setData({ timestamp, open, high, low, close, volume, length: 2 });
      }
      expect(frames.pending()).toBe(0);
      if (boundary !== "bulk flush") {
        expect(messages.map(({ message }) => message.type)).toEqual([
          boundary === "setData" ? "setData" : "initRingBuffer",
          "start",
        ]);
      }
      messages.length = 0;
      chart.addCandle(3, 30, 32, 29, 31, 300);
      staleCallback(performance.now());
      expect(messages).toEqual([]);
      expect(frames.pending()).toBe(1);
      frames.flush();
      expect(messages).toHaveLength(1);
      expect(Array.from(messages[0].message.timestamps)).toEqual([3]);
      chart.destroy();
    },
  );

  it("preserves pending samples when data normalization rejects a replacement", () => {
    const frames = installAnimationFrameHarness();
    const { chart, messages } = createChart();
    chart.addCandle(1, 10, 12, 9, 11, 100);
    const [timestamp, open, high, low, close, volume] = packedColumns();
    expect(() =>
      chart.setData({
        timestamp,
        open: open.subarray(0, 1),
        high,
        low,
        close,
        volume,
        length: 2,
      }),
    ).toThrow("same length");
    expect(messages).toEqual([]);
    expect(frames.pending()).toBe(1);
    frames.flush();
    expect(Array.from(messages[0].message.timestamps)).toEqual([1]);
    chart.destroy();
  });

  it.each([0, 2])(
    "preserves pending samples when streaming capacity %i is rejected",
    (capacity) => {
      const frames = installAnimationFrameHarness();
      const { chart, messages } = createChart({ indicators: [{ type: "sma", period: 3 }] });
      chart.addCandle(1, 10, 12, 9, 11, 100);
      expect(() => chart.initStreaming(capacity)).toThrow(RangeError);
      expect(messages).toEqual([]);
      expect(frames.pending()).toBe(1);
      frames.flush();
      expect(Array.from(messages[0].message.timestamps)).toEqual([1]);
      chart.destroy();
    },
  );

  it("cancels its scalar frame when destroyed", () => {
    const frames = installAnimationFrameHarness();
    const { chart, messages } = createChart();
    chart.addCandle(1, 10, 12, 9, 11, 100);
    const staleCallback = frames.nextCallback();
    chart.destroy();
    expect(frames.pending()).toBe(0);
    messages.length = 0;
    staleCallback(performance.now());
    frames.flush();
    expect(messages).toEqual([]);
  });

  it("can discard an uninitialized scalar queue when the renderer fails during base construction", async () => {
    const frames = installAnimationFrameHarness();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { chart, worker } = createChart({}, "synchronous init failure");

    await expect(chart.initialize()).rejects.toMatchObject({
      name: "ChartRendererError",
      phase: "initialization",
      message: "synchronous init failure",
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(0);
    chart.destroy();
  });
});
