/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseChart } from "@sixtyfold/core/chart/BaseChart";
import {
  StockChart,
  STOCK_TIME_RANGE_CHANGE_EVENT,
  type StockCandleBatch,
  type StockChartOptions,
  type TimeRangeChangeDetail,
} from "./StockChart";
import { createStockChartEngine } from "./stockRenderer.js";
import { getStockEngineState } from "@test/support/engineState";
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
    useWorker: options.renderMode !== "main",
    resolvedRenderMode: options.renderMode === "main" ? "main" : "worker",
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

function createEngineBackedChart(options: StockChartOptions) {
  const harness = createChart(options);
  const rendererMessages: Record<string, any>[] = [];
  const commands: Record<string, any>[] = [];
  const context = new Proxy({} as CanvasRenderingContext2D, {
    get: (_target, property) => {
      if (property === "measureText") return () => ({ width: 40 });
      if (property === "createLinearGradient") return () => ({ addColorStop: () => {} });
      if (property === "createPattern") return () => null;
      return () => {};
    },
    set: () => true,
  });
  const createCanvas = (width = 800, height = 400) => ({
    width,
    height,
    getContext: () => context,
  });
  const engine = createStockChartEngine(
    { postMessage: (message) => rendererMessages.push(message) },
    { ssr: true, createCanvas },
  );
  engine.handleMessage("init", {
    canvas: createCanvas(),
    dpr: 1,
    config: { ...options, showVolume: false, rangeSelector: { visible: false } },
  });
  engine.handleMessage("resize", { width: 800, height: 400, dpr: 1 });
  const postMessage = harness.worker.postMessage.bind(harness.worker);
  vi.spyOn(harness.worker, "postMessage").mockImplementation((message, transfer) => {
    postMessage(message, transfer);
    commands.push(
      options.renderMode === "main"
        ? message
        : structuredClone(message, { transfer: transfer ?? [] }),
    );
  });
  return {
    ...harness,
    engine,
    flushRenderer() {
      for (const message of commands.splice(0)) {
        const { type, ...data } = message;
        engine.handleMessage(type, data);
      }
      for (const message of rendererMessages.splice(0)) {
        harness.worker.onmessage?.({ data: message } as MessageEvent);
      }
    },
    destroy() {
      harness.chart.destroy();
      engine.handleMessage("stop", {});
    },
  };
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

  it("does not post an empty addCandles message when timestamps is empty", () => {
    const frames = installAnimationFrameHarness();
    const { chart, messages } = createChart();
    chart.addCandle(1, 10, 12, 9, 11, 100);

    const empty = candleBatch([]);
    chart.addCandles(
      empty.timestamp,
      empty.open,
      empty.high,
      empty.low,
      empty.close,
      empty.volume,
      { initialTimeRange: "ALL" },
    );

    const sent = messages.filter(({ message }) => message.type === "addCandles");
    expect(sent).toHaveLength(1);
    expect(Array.from(sent[0].message.timestamps)).toEqual([1]);

    messages.length = 0;
    appendBatch(chart, candleBatch([]));
    expect(messages).toEqual([]);
    frames.flush();
    chart.destroy();
  });

  it("defers time-range callbacks and keeps market viewports synchronized with accepted renderer ranges", () => {
    const onTimeRangeChange = vi.fn();
    const { chart, worker, messages } = createChart({
      timeScale: "market",
      onTimeRangeChange,
    });

    worker.onmessage?.(
      new MessageEvent("message", {
        data: {
          type: "viewportSync",
          viewport: { xMin: 0, xMax: 100, yMin: 10, yMax: 20 },
          dataBounds: { xMin: 0, xMax: 100, yMin: 10, yMax: 20 },
          timeViewport: { xMin: 1_000, xMax: 5_000 },
          timeDataBounds: { xMin: 1_000, xMax: 10_000 },
          dataVersion: 0,
        },
      }),
    );
    onTimeRangeChange.mockClear();

    chart.batch(() => {
      // The renderer resolves reversed/out-of-bounds timestamps against its index.
      chart.setViewport({ xMin: 12_000, xMax: 500 });
      expect(onTimeRangeChange).not.toHaveBeenCalled();
    });

    expect(messages.at(-1)?.message).toMatchObject({ xMin: 12_000, xMax: 500 });
    expect(chart.getViewport()).toEqual({ xMin: 1_000, xMax: 5_000 });
    expect(onTimeRangeChange).toHaveBeenCalledOnce();
    expect(onTimeRangeChange).toHaveBeenCalledWith(null);

    onTimeRangeChange.mockClear();
    chart.batch(() => {
      chart.setTimeRange("5D");
      chart.setViewport({ xMin: 2_000, xMax: 4_000 });
      chart.reset();
      expect(onTimeRangeChange).not.toHaveBeenCalled();
    });

    expect(chart.getViewport()).toEqual({ xMin: 1_000, xMax: 10_000 });
    expect(onTimeRangeChange).toHaveBeenCalledTimes(3);
    expect(onTimeRangeChange).toHaveBeenNthCalledWith(1, "5D");
    expect(onTimeRangeChange).toHaveBeenNthCalledWith(2, null);
    expect(onTimeRangeChange).toHaveBeenNthCalledWith(3, "ALL");
    chart.destroy();
  });

  it.each(["continuous", "market"] as const)(
    "preserves a final preset after viewport and nested preset changes in %s time",
    (timeScale) => {
      const onTimeRangeChange = vi.fn();
      const { chart, canvas, messages } = createChart({ timeScale, onTimeRangeChange });
      const events: TimeRangeChangeDetail[] = [];
      canvas.addEventListener(STOCK_TIME_RANGE_CHANGE_EVENT, (event) => {
        events.push((event as CustomEvent<TimeRangeChangeDetail>).detail);
      });
      chart.batch(() => {
        chart.setViewport({ xMin: 3_600_000, xMax: 7_200_000 });
        chart.batch(() => {
          chart.setTimeRange("ALL");
          chart.setTimeRange("5D");
        });
        chart.setTimeRange("ALL");
        expect(onTimeRangeChange).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        expect(messages).toEqual([]);
      });

      expect(messages.map(({ message }) => [message.type, message.range])).toEqual([
        [
          timeScale === "continuous" ? "setViewportRangeAnimated" : "setTimeViewportRangeAnimated",
          undefined,
        ],
        ["setTimeRange", "ALL"],
        ["setTimeRange", "5D"],
        ["setTimeRange", "ALL"],
      ]);
      expect(onTimeRangeChange.mock.calls.map(([range]) => range)).toEqual([
        null,
        "ALL",
        "5D",
        "ALL",
      ]);
      expect(events).toEqual([
        { range: null, previousRange: "ALL", source: "api" },
        { range: "ALL", previousRange: null, source: "api" },
        { range: "5D", previousRange: "ALL", source: "api" },
        { range: "ALL", previousRange: "5D", source: "api" },
      ]);
      messages.length = 0;
      chart.setTimeRange("ALL");
      expect(messages).toEqual([]);
      chart.destroy();
    },
  );

  it("retains a reentrant preset change while delivering captured batch notifications", () => {
    let chart: StockChart;
    const onTimeRangeChange = vi.fn((range) => {
      if (range === null) chart.setTimeRange("5D");
    });
    const harness = createChart({ onTimeRangeChange });
    chart = harness.chart;
    const events: TimeRangeChangeDetail[] = [];
    harness.canvas.addEventListener(STOCK_TIME_RANGE_CHANGE_EVENT, (event) => {
      events.push((event as CustomEvent<TimeRangeChangeDetail>).detail);
    });
    chart.batch(() => {
      chart.setViewport({ xMin: 3_600_000, xMax: 7_200_000 });
      chart.setTimeRange("ALL");
    });
    expect(harness.messages.map(({ message }) => [message.type, message.range])).toEqual([
      ["setViewportRangeAnimated", undefined],
      ["setTimeRange", "ALL"],
      ["setTimeRange", "5D"],
    ]);
    expect(onTimeRangeChange.mock.calls.map(([range]) => range)).toEqual([null, "ALL", "5D"]);
    expect(events).toEqual([
      { range: null, previousRange: "ALL", source: "api" },
      { range: "ALL", previousRange: null, source: "api" },
      { range: "5D", previousRange: "ALL", source: "api" },
    ]);
    const count = harness.messages.length;
    chart.setTimeRange("5D");
    expect(harness.messages).toHaveLength(count);
    chart.destroy();
  });

  it.each(["setData", "initStreaming"] as const)(
    "orders a direct %s before queued presets and retains the final queued intent",
    (install) => {
      const onTimeRangeChange = vi.fn();
      const { chart, messages } = createChart({ onTimeRangeChange });
      chart.batch(() => {
        chart.setTimeRange("5D");
        if (install === "setData") {
          const data = candleBatch([1, 2]);
          chart.setData({ ...data, length: 2 });
        } else {
          chart.initStreaming(10);
        }
      });
      expect(messages.map(({ message }) => message.type)).toEqual([
        install === "setData" ? "setData" : "initRingBuffer",
        "start",
        "setTimeRange",
      ]);
      expect(onTimeRangeChange.mock.calls.map(([range]) => range)).toEqual(["5D"]);
      const count = messages.length;
      chart.setTimeRange("ALL");
      expect(messages).toHaveLength(count + 1);
      expect(messages.at(-1)?.message).toEqual({ type: "setTimeRange", range: "ALL" });
      chart.destroy();
    },
  );

  it("retains an already-custom viewport intent when a bulk install overtakes it", () => {
    const onTimeRangeChange = vi.fn();
    const { chart, messages } = createChart({ onTimeRangeChange });
    chart.setViewport({ xMin: 3_600_000, xMax: 7_200_000 });
    messages.length = 0;
    onTimeRangeChange.mockClear();
    chart.batch(() => {
      chart.setViewport({ xMin: 7_200_000, xMax: 10_800_000 });
      const data = candleBatch([1, 2]);
      chart.setData({ ...data, length: 2 });
    });
    expect(messages.map(({ message }) => message.type)).toEqual([
      "setData",
      "start",
      "setViewportRangeAnimated",
    ]);
    expect(onTimeRangeChange.mock.calls.map(([range]) => range)).toEqual(["ALL", null]);
    chart.setTimeRange("ALL");
    expect(messages.at(-1)?.message).toEqual({ type: "setTimeRange", range: "ALL" });
    chart.destroy();
  });

  it("orders a bulk initial range before queued preset notifications", () => {
    const onTimeRangeChange = vi.fn();
    const { chart, canvas, messages } = createChart({ onTimeRangeChange });
    const events: TimeRangeChangeDetail[] = [];
    canvas.addEventListener(STOCK_TIME_RANGE_CHANGE_EVENT, (event) => {
      events.push((event as CustomEvent<TimeRangeChangeDetail>).detail);
    });
    chart.initStreaming(10);
    messages.length = 0;
    chart.batch(() => {
      chart.setTimeRange("5D");
      const data = candleBatch([1, 2]);
      chart.addCandles(data.timestamp, data.open, data.high, data.low, data.close, data.volume, {
        initialTimeRange: "1D",
      });
      chart.setTimeRange("ALL");
    });
    expect(messages.map(({ message }) => message.type)).toEqual([
      "addCandles",
      "setTimeRange",
      "setTimeRange",
    ]);
    expect(onTimeRangeChange.mock.calls.map(([range]) => range)).toEqual(["1D", "5D", "ALL"]);
    expect(events).toEqual([
      { range: "1D", previousRange: "ALL", source: "api" },
      { range: "5D", previousRange: "1D", source: "api" },
      { range: "ALL", previousRange: "5D", source: "api" },
    ]);
    chart.destroy();
  });

  it("keeps a callback-induced nested batch behind earlier notifications", () => {
    let chart: StockChart;
    const onTimeRangeChange = vi.fn((range) => {
      if (range !== null) return;
      chart.batch(() => {
        chart.setTimeRange("1M");
        const data = candleBatch([1, 2]);
        chart.setData({ ...data, length: 2 });
      });
    });
    const harness = createChart({ onTimeRangeChange });
    chart = harness.chart;
    const events: TimeRangeChangeDetail[] = [];
    harness.canvas.addEventListener(STOCK_TIME_RANGE_CHANGE_EVENT, (event) => {
      events.push((event as CustomEvent<TimeRangeChangeDetail>).detail);
    });
    chart.batch(() => {
      chart.setViewport({ xMin: 3_600_000, xMax: 7_200_000 });
      chart.setTimeRange("5D");
    });
    expect(harness.messages.map(({ message }) => message.type)).toEqual([
      "setViewportRangeAnimated",
      "setTimeRange",
      "setData",
      "start",
      "setTimeRange",
    ]);
    expect(onTimeRangeChange.mock.calls.map(([range]) => range)).toEqual([null, "5D", "ALL", "1M"]);
    expect(events).toEqual([
      { range: null, previousRange: "ALL", source: "api" },
      { range: "5D", previousRange: null, source: "api" },
      { range: "ALL", previousRange: "5D", source: "data" },
      { range: "1M", previousRange: "ALL", source: "api" },
    ]);
    chart.destroy();
  });

  it("drains paired notifications after a callback throws and rethrows the first failure", () => {
    const failure = new Error("callback failed");
    const onTimeRangeChange = vi.fn((range) => {
      if (range === null) throw failure;
      if (range === "ALL") throw new Error("later callback failed");
    });
    const { chart, canvas } = createChart({ onTimeRangeChange });
    const events: TimeRangeChangeDetail[] = [];
    canvas.addEventListener(STOCK_TIME_RANGE_CHANGE_EVENT, (event) => {
      events.push((event as CustomEvent<TimeRangeChangeDetail>).detail);
    });
    expect(() =>
      chart.batch(() => {
        chart.setViewport({ xMin: 3_600_000, xMax: 7_200_000 });
        chart.setTimeRange("ALL");
        chart.setTimeRange("5D");
      }),
    ).toThrow(failure);
    expect(onTimeRangeChange.mock.calls.map(([range]) => range)).toEqual([null, "ALL", "5D"]);
    expect(events.map(({ range }) => range)).toEqual([null, "ALL", "5D"]);
    chart.setTimeRange("1M");
    expect(onTimeRangeChange).toHaveBeenLastCalledWith("1M");
    chart.destroy();
  });

  it.each(["callback", "event"] as const)(
    "stops queued notifications after destruction in a %s",
    (from) => {
      let chart: StockChart;
      const onTimeRangeChange = vi.fn(() => {
        if (from === "callback") chart.destroy();
      });
      const harness = createChart({ onTimeRangeChange });
      chart = harness.chart;
      const events: TimeRangeChangeDetail[] = [];
      harness.canvas.addEventListener(STOCK_TIME_RANGE_CHANGE_EVENT, (event) => {
        events.push((event as CustomEvent<TimeRangeChangeDetail>).detail);
        if (from === "event") chart.destroy();
      });
      chart.batch(() => {
        chart.setViewport({ xMin: 3_600_000, xMax: 7_200_000 });
        chart.setTimeRange("ALL");
        chart.setTimeRange("5D");
      });
      expect(onTimeRangeChange).toHaveBeenCalledExactlyOnceWith(null);
      expect(events.map(({ range }) => range)).toEqual(from === "callback" ? [] : [null]);
      expect(harness.worker.terminate).toHaveBeenCalledOnce();
      chart.destroy();
    },
  );

  for (const renderMode of ["main", "worker"] as const) {
    it.each([undefined, 300_000])(
      `resolves market partial updates after a rejected minimum span in ${renderMode} mode (minimum %s)`,
      (minViewportRange) => {
        const harness = createEngineBackedChart({
          renderMode,
          timeScale: "market",
          animated: false,
          minViewportRange,
        });
        const start = Date.UTC(2025, 0, 1);
        const minute = 60_000;
        const data = candleBatch(Array.from({ length: 180 }, (_, i) => start + i * minute));
        harness.chart.setData({ ...data, length: data.timestamp.length });
        harness.flushRenderer();
        const initialViewport = harness.chart.getViewport();
        harness.chart.batch(() => {
          harness.chart.setViewport({
            xMin: start + 60 * minute,
            xMax: start + 60 * minute + 1000,
          });
          harness.chart.setViewport({ xMax: start + 120 * minute });
        });
        expect(harness.chart.getViewport()).toEqual(initialViewport);
        harness.flushRenderer();
        expect(harness.chart.getViewport()).toEqual({ xMin: start, xMax: start + 120 * minute });
        harness.destroy();
      },
    );

    it(`validates compressed market spans and chains valid partial requests in ${renderMode} mode`, () => {
      const minute = 60_000;
      const start = Date.UTC(2025, 0, 1);
      const nextSession = start + 3 * 24 * 60 * minute;
      const harness = createEngineBackedChart({
        renderMode,
        timeScale: "market",
        animated: false,
        minViewportRange: 10 * minute,
      });
      const timestamps = [
        ...Array.from({ length: 120 }, (_, i) => start + i * minute),
        ...Array.from({ length: 120 }, (_, i) => nextSession + i * minute),
      ];
      const data = candleBatch(timestamps);
      harness.chart.setData({ ...data, length: data.timestamp.length });
      harness.flushRenderer();
      harness.chart.batch(() => {
        // A three-day timestamp span covers just one compressed minute.
        harness.chart.setViewport({ xMin: start + 119 * minute, xMax: nextSession });
        harness.chart.setViewport({ xMax: nextSession + 60 * minute });
      });
      harness.flushRenderer();
      expect(harness.chart.getViewport()).toEqual({ xMin: start, xMax: nextSession + 60 * minute });

      harness.chart.batch(() => {
        harness.chart.setViewport({ xMin: start + 30 * minute });
        harness.chart.setViewport({ xMax: nextSession + 30 * minute });
      });
      harness.flushRenderer();
      expect(harness.chart.getViewport()).toEqual({
        xMin: start + 30 * minute,
        xMax: nextSession + 30 * minute,
      });

      for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        harness.chart.batch(() => {
          harness.chart.setViewport({ xMin: invalid });
          harness.chart.setViewport({ xMax: nextSession + 45 * minute });
        });
        harness.flushRenderer();
        expect(harness.chart.getViewport()).toEqual({
          xMin: start + 30 * minute,
          xMax: nextSession + 45 * minute,
        });
      }

      harness.chart.setViewport({ xMin: nextSession + 200 * minute, xMax: start - minute });
      harness.flushRenderer();
      expect(harness.chart.getViewport()).toEqual({
        xMin: start,
        xMax: nextSession + 119 * minute,
      });
      harness.destroy();
    });
  }

  it("composes animated market partial requests against the accepted animation target", () => {
    const harness = createEngineBackedChart({ timeScale: "market", animated: true });
    const minute = 60_000;
    const start = Date.UTC(2025, 0, 1);
    const data = candleBatch(Array.from({ length: 180 }, (_, i) => start + i * minute));
    harness.chart.setData({ ...data, length: data.timestamp.length });
    harness.flushRenderer();
    harness.chart.batch(() => {
      harness.chart.setViewport({ xMin: start + 30 * minute });
      harness.chart.setViewport({ xMax: start + 120 * minute });
    });
    harness.flushRenderer();
    expect(getStockEngineState(harness.engine).viewportAnimation.toViewport).toMatchObject({
      xMin: 30 * minute,
      xMax: 120 * minute,
    });
    harness.chart.setViewport({ xMax: start + 150 * minute }, { animated: false });
    harness.flushRenderer();
    expect(getStockEngineState(harness.engine).viewportAnimation.active).toBe(false);
    expect(harness.chart.getViewport()).toEqual({
      xMin: start + 30 * minute,
      xMax: start + 150 * minute,
    });
    harness.destroy();
  });
});
