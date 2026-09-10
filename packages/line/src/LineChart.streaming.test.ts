import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseChart } from "@sixtyfold/core/chart/BaseChart";
import type { ChartWorkerLike } from "@sixtyfold/core/chart/workerInterface";
import { LineChart } from "./LineChart";

const charts: LineChart[] = [];

afterEach(() => {
  for (const chart of charts.splice(0)) chart.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createChart() {
  let nextFrameId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  });
  const cancelFrame = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);

  const postMessage = vi.fn<ChartWorkerLike["postMessage"]>();
  const worker: ChartWorkerLike = {
    onmessage: null,
    postMessage,
    terminate: vi.fn(),
  };
  vi.spyOn(BaseChart as any, "selectChartRenderer").mockReturnValue({
    renderer: () => worker,
    useWorker: false,
    resolvedRenderMode: "main",
  });
  const chart = new LineChart(document.createElement("canvas"), { animated: false });
  charts.push(chart);
  chart.initStreaming(2, 10);
  postMessage.mockClear();

  return {
    chart,
    postMessage,
    requestFrame,
    cancelFrame,
    frames,
    flushFrame() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    },
  };
}

describe("LineChart scalar streaming boundaries", () => {
  it("delivers queued scalars before bulk data without copying the bulk arrays", () => {
    const { chart, postMessage, frames, cancelFrame, flushFrame } = createChart();
    const timestamps = new Float64Array([3, 4]);
    const valuesBySeries = [new Float64Array([30, 40]), new Float64Array([300, 400])];

    chart.addVector(1, [10, 100]);
    chart.addVector(2, [20, 200]);
    chart.addVectors(timestamps, valuesBySeries);

    expect(postMessage.mock.calls.map(([message]) => Array.from(message.timestamps))).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(postMessage.mock.calls[0][0].valuesBySeries).toEqual([
      new Float64Array([10, 20]),
      new Float64Array([100, 200]),
    ]);
    const [bulkMessage, transfers] = postMessage.mock.calls[1];
    expect(bulkMessage.timestamps).toBe(timestamps);
    expect(bulkMessage.valuesBySeries).toBe(valuesBySeries);
    expect(transfers?.[0]).toBe(timestamps.buffer);
    expect(transfers?.[1]).toBe(valuesBySeries[0].buffer);
    expect(transfers?.[2]).toBe(valuesBySeries[1].buffer);
    expect(cancelFrame).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);

    flushFrame();
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it("does not let the canceled bulk-flush callback drain later scalar samples", () => {
    const { chart, postMessage, requestFrame, frames, flushFrame } = createChart();
    chart.addVector(1, [10, 100]);
    const staleCallback = requestFrame.mock.calls[0][0];
    chart.addVectors(new Float64Array([2]), [new Float64Array([20]), new Float64Array([200])]);
    postMessage.mockClear();

    chart.addVector(3, [30, 300]);
    staleCallback(0);
    expect(postMessage).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);

    flushFrame();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage.mock.calls[0][0].timestamps).toEqual(new Float64Array([3]));
  });

  it("discards old samples on reinitialization and protects the new stream's queue", () => {
    const { chart, postMessage, requestFrame, frames, flushFrame } = createChart();
    chart.addVector(1, [10, 100]);
    const staleCallback = requestFrame.mock.calls[0][0];

    chart.initStreaming(1, 20);
    expect(postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "initRingBuffer",
      "start",
    ]);
    expect(frames.size).toBe(0);
    postMessage.mockClear();

    chart.addVector(100, [42]);
    staleCallback(0);
    expect(postMessage).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);

    flushFrame();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage.mock.calls[0][0]).toEqual({
      type: "addDataPoints",
      timestamps: new Float64Array([100]),
      valuesBySeries: [new Float64Array([42])],
    });
  });

  it.each(["single", "multi"] as const)(
    "discards old samples when installing %s-series data",
    (kind) => {
      const { chart, postMessage, requestFrame, frames, flushFrame } = createChart();
      chart.addVector(1, [10, 100]);
      const staleCallback = requestFrame.mock.calls[0][0];
      const x = new Float64Array([100, 200]);
      const y = new Float64Array([10, 20]);

      if (kind === "single") chart.setData({ x, y, length: 2 });
      else chart.setMultiSeriesData({ x, series: [y], length: 2, seriesCount: 1 });

      expect(postMessage.mock.calls.map(([message]) => message.type)).toEqual(["setData", "start"]);
      expect(frames.size).toBe(0);
      staleCallback(0);
      flushFrame();
      expect(postMessage).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps the scalar queue intact when bulk validation fails", () => {
    const { chart, postMessage, frames, cancelFrame, flushFrame } = createChart();
    chart.addVector(1, [10, 100]);
    const timestamps = new Float64Array([2]);
    const values = new Float64Array([20]);

    expect(() => chart.addVectors(timestamps, [values])).toThrow("expected 2 series, got 1");
    expect(postMessage).not.toHaveBeenCalled();
    expect(cancelFrame).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    expect(timestamps.byteLength).toBe(8);
    expect(values.byteLength).toBe(8);

    flushFrame();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage.mock.calls[0][0].timestamps).toEqual(new Float64Array([1]));
  });

  it.each(["single", "multi"] as const)(
    "keeps the scalar queue intact when %s-series data is rejected",
    (kind) => {
      const { chart, postMessage, frames, cancelFrame, flushFrame } = createChart();
      chart.addVector(1, [10, 100]);
      const x = new Float64Array([100, 200]);
      const y = new Float64Array([10]);

      expect(() => {
        if (kind === "single") chart.setData({ x, y, length: 2 });
        else chart.setMultiSeriesData({ x, series: [y], length: 2, seriesCount: 1 });
      }).toThrow();
      expect(postMessage).not.toHaveBeenCalled();
      expect(cancelFrame).not.toHaveBeenCalled();
      expect(frames.size).toBe(1);

      flushFrame();
      expect(postMessage).toHaveBeenCalledOnce();
      expect(postMessage.mock.calls[0][0].timestamps).toEqual(new Float64Array([1]));
    },
  );

  it("cancels queued work on destroy and ignores both stale callbacks and new writes", () => {
    const { chart, postMessage, requestFrame, frames, flushFrame } = createChart();
    chart.addVector(1, [10, 100]);
    const staleCallback = requestFrame.mock.calls[0][0];

    chart.destroy();
    expect(frames.size).toBe(0);
    postMessage.mockClear();
    staleCallback(0);
    chart.addVector(2, [20, 200]);
    chart.addVectors(new Float64Array([3]), [new Float64Array([30]), new Float64Array([300])]);
    flushFrame();
    expect(postMessage).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });
});

describe("LineChart streaming initialization validation", () => {
  describe.each(["series count", "capacity"] as const)("invalid %s", (field) => {
    it.each([0, -1, 1.5, NaN, Infinity, -Infinity])(
      "rejects %s before changing the active stream or discarding queued samples",
      (value) => {
        const { chart, postMessage, frames, cancelFrame, flushFrame } = createChart();
        chart.addVector(1, [10, 100]);

        expect(() => {
          if (field === "series count") chart.initStreaming(value, 20);
          else chart.initStreaming(1, value);
        }).toThrow(new RangeError(`Line streaming ${field} must be a positive integer`));
        expect(postMessage).not.toHaveBeenCalled();
        expect(cancelFrame).not.toHaveBeenCalled();
        expect(frames.size).toBe(1);

        // The old stream's two-series contract and scalar queue remain usable.
        chart.addVector(2, [20, 200]);
        flushFrame();
        expect(postMessage).toHaveBeenCalledOnce();
        expect(postMessage.mock.calls[0][0]).toEqual({
          type: "addDataPoints",
          timestamps: new Float64Array([1, 2]),
          valuesBySeries: [new Float64Array([10, 20]), new Float64Array([100, 200])],
        });

        postMessage.mockClear();
        chart.initStreaming(1, 20);
        expect(postMessage.mock.calls[0][0]).toEqual({
          type: "initRingBuffer",
          maxPoints: 20,
          seriesCount: 1,
          // The rejected reset must not consume a dataset generation.
          dataVersion: 2,
        });
      },
    );
  });

  it.each([1, 5_000_000, undefined])(
    "accepts a positive capacity or the default: %s",
    (capacity) => {
      const { chart, postMessage } = createChart();

      chart.initStreaming(1, capacity);

      expect(postMessage.mock.calls.map(([message]) => message.type)).toEqual([
        "initRingBuffer",
        "start",
      ]);
      expect(postMessage.mock.calls[0][0]).toEqual({
        type: "initRingBuffer",
        maxPoints: capacity ?? 5_000_000,
        seriesCount: 1,
        dataVersion: 2,
      });
    },
  );

  it("keeps initialization a no-op after destruction, even for invalid arguments", () => {
    const { chart, postMessage, frames } = createChart();
    chart.destroy();
    postMessage.mockClear();

    expect(() => chart.initStreaming(NaN, 0)).not.toThrow();
    expect(postMessage).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });
});
