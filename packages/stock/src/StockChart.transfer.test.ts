/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseChart } from "@sixtyfold/core/chart/BaseChart";
import { StockChart, type StockCandleBatch, type StockChartOptions } from "./StockChart";
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

function packedColumns(startTimestamp = 0): Float64Array[] {
  const buffer = new ArrayBuffer(6 * 2 * Float64Array.BYTES_PER_ELEMENT);
  const columns = Array.from(
    { length: 6 },
    (_, index) => new Float64Array(buffer, index * 2 * Float64Array.BYTES_PER_ELEMENT, 2),
  );
  columns[0].set([startTimestamp, startTimestamp + 1]);
  return columns;
}

function candleBatch(timestamps: readonly number[]) {
  return {
    timestamp: Float64Array.from(timestamps),
    open: Float64Array.from(timestamps, () => 10),
    high: Float64Array.from(timestamps, () => 12),
    low: Float64Array.from(timestamps, () => 9),
    close: Float64Array.from(timestamps, () => 11),
    volume: Float64Array.from(timestamps, () => 100),
  };
}

function appendBatch(chart: StockChart, batch: StockCandleBatch): void {
  chart.addCandles(batch.timestamp, batch.open, batch.high, batch.low, batch.close, batch.volume);
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
    const second = packedColumns(2);

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
        const [timestamps, opens, highs, lows, closes, volumes] = packedColumns(2);
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
      chart.addCandle(4, 30, 32, 29, 31, 300);
      staleCallback(performance.now());
      expect(messages).toEqual([]);
      expect(frames.pending()).toBe(1);
      frames.flush();
      expect(messages).toHaveLength(1);
      expect(Array.from(messages[0].message.timestamps)).toEqual([4]);
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

describe("StockChart streaming validation", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1, 0])(
    "rejects scalar timestamp %s without changing pending candles",
    (timestamp) => {
      const frames = installAnimationFrameHarness();
      const { chart, messages } = createChart({ timeScale: "market" });
      chart.addCandle(1, 10, 12, 9, 11, 100);

      expect(() => chart.addCandle(timestamp, 20, 22, 19, 21, 200)).toThrow(
        Number.isFinite(timestamp) ? "strictly increasing" : "finite values",
      );

      expect(messages).toEqual([]);
      expect(frames.pending()).toBe(1);
      chart.addCandle(2, 30, 32, 29, 31, 300);
      frames.flush();
      expect(Array.from(messages[0].message.timestamps)).toEqual([1, 2]);
      expect(Array.from(messages[0].message.opens)).toEqual([10, 30]);
      chart.destroy();
    },
  );

  it.each([
    [1, 2],
    [0, 2],
    [2, 2],
    [3, 2],
    [2, Number.NaN],
    [2, Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY, 2],
  ])("rejects bulk timestamps %j before flushing queued candles", (...timestamps) => {
    const frames = installAnimationFrameHarness();
    const { chart, messages } = createChart({ timeScale: "market" });
    chart.addCandle(1, 10, 12, 9, 11, 100);
    const batch = candleBatch(timestamps);

    expect(() => appendBatch(chart, batch)).toThrow(/strictly increasing|finite values/);

    expect(messages).toEqual([]);
    expect(frames.pending()).toBe(1);
    expect(batch.timestamp.byteLength).toBe(timestamps.length * Float64Array.BYTES_PER_ELEMENT);
    chart.addCandle(2, 20, 22, 19, 21, 200);
    frames.flush();
    expect(Array.from(messages[0].message.timestamps)).toEqual([1, 2]);
    chart.destroy();
  });

  it.each(["open", "high", "low", "close", "volume"] as const)(
    "rejects a short %s column before flushing or transferring any candles",
    (column) => {
      const frames = installAnimationFrameHarness();
      const { chart, messages } = createChart();
      chart.addCandle(1, 10, 12, 9, 11, 100);
      const batch = candleBatch([2, 3]);
      batch[column] = batch[column].subarray(0, 1);

      expect(() => appendBatch(chart, batch)).toThrow("same length");

      expect(messages).toEqual([]);
      expect(frames.pending()).toBe(1);
      expect(batch.timestamp.byteLength).toBe(16);
      frames.flush();
      expect(Array.from(messages[0].message.timestamps)).toEqual([1]);
      chart.destroy();
    },
  );

  it.each(["overlap", "NaN", "short column", "invalid empty chunk"])(
    "rejects all chunks atomically when a later chunk contains %s",
    (problem) => {
      const frames = installAnimationFrameHarness();
      const { chart, messages } = createChart();
      chart.addCandle(1, 10, 12, 9, 11, 100);
      const first = candleBatch([2, 3]);
      const last = candleBatch([4, 5]);
      if (problem === "overlap") last.timestamp[0] = 3;
      if (problem === "NaN") last.timestamp[1] = Number.NaN;
      if (problem === "short column") last.close = new Float64Array(1);
      if (problem === "invalid empty chunk") last.timestamp = new Float64Array(0);

      expect(() => chart.addCandleBatches([first, last])).toThrow();

      expect(messages).toEqual([]);
      expect(frames.pending()).toBe(1);
      expect(first.timestamp.byteLength).toBe(16);
      expect(last.close.byteLength).toBeGreaterThan(0);
      chart.addCandle(2, 20, 22, 19, 21, 200);
      frames.flush();
      expect(Array.from(messages[0].message.timestamps)).toEqual([1, 2]);
      chart.destroy();
    },
  );

  it("tracks the accepted tail across scalar, bulk, chunked and empty appends", () => {
    const frames = installAnimationFrameHarness();
    const { chart, messages } = createChart();
    chart.initStreaming(2);
    chart.addCandle(-2, 10, 12, 9, 11, 100);
    frames.flush();
    appendBatch(chart, candleBatch([-1, 0]));
    expect(() => chart.addCandle(0, 10, 12, 9, 11, 100)).toThrow("strictly increasing");
    chart.addCandleBatches([candleBatch([1]), candleBatch([]), candleBatch([2])]);
    appendBatch(chart, candleBatch([]));
    chart.addCandleBatches([candleBatch([])]);
    expect(() => appendBatch(chart, candleBatch([2, 3]))).toThrow("strictly increasing");
    expect(() => chart.addCandleBatches([candleBatch([2, 3])])).toThrow("strictly increasing");
    chart.addCandle(3, 10, 12, 9, 11, 100);
    frames.flush();
    expect(Array.from(messages.at(-1)!.message.timestamps)).toEqual([3]);
    chart.destroy();
  });

  it("resets ordering on a new stream and follows the normalized replacement tail", () => {
    const frames = installAnimationFrameHarness();
    const { chart, messages } = createChart();
    chart.addCandle(100, 10, 12, 9, 11, 100);
    chart.initStreaming(10);
    chart.addCandle(1, 10, 12, 9, 11, 100);
    const replacement = candleBatch([20, 10]);
    chart.setData({ ...replacement, length: 2 });

    expect(() => chart.addCandle(20, 10, 12, 9, 11, 100)).toThrow("strictly increasing");
    chart.addCandle(21, 10, 12, 9, 11, 100);
    frames.flush();
    expect(Array.from(messages.at(-1)!.message.timestamps)).toEqual([21]);
    chart.setData({ ...candleBatch([]), length: 0 });
    chart.addCandle(0, 10, 12, 9, 11, 100);
    frames.flush();
    expect(Array.from(messages.at(-1)!.message.timestamps)).toEqual([0]);
    chart.destroy();
  });

  it("remembers transferred tails after actual worker-style buffer detachment", () => {
    const frames = installAnimationFrameHarness();
    const { chart, worker } = createChart();
    const postMessage = worker.postMessage.bind(worker);
    vi.spyOn(worker, "postMessage").mockImplementation((message, transfer) => {
      postMessage(message, transfer);
      if (transfer) structuredClone(message, { transfer });
    });
    const data = candleBatch([1, 2]);
    chart.setData({ ...data, length: 2 });
    expect(data.timestamp.byteLength).toBe(0);
    expect(() => chart.addCandle(2, 10, 12, 9, 11, 100)).toThrow("strictly increasing");
    chart.initStreaming(10);
    const first = candleBatch([3, 4]);
    appendBatch(chart, first);
    expect(first.timestamp.byteLength).toBe(0);
    const second = candleBatch([5, 6]);
    chart.addCandleBatches([second]);
    expect(second.timestamp.byteLength).toBe(0);
    expect(() => appendBatch(chart, candleBatch([6]))).toThrow("strictly increasing");
    chart.addCandle(7, 10, 12, 9, 11, 100);
    frames.flush();
    expect(() => chart.addCandle(7, 10, 12, 9, 11, 100)).toThrow("strictly increasing");
    chart.destroy();
  });
});
