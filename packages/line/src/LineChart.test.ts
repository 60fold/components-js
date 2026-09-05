import { afterEach, describe, expect, it, vi } from "vitest";
import { LineChart } from "./LineChart";

type PostMessageMock = ReturnType<typeof vi.fn>;

interface SeriesAppearanceHarness {
  destroyed: boolean;
  optionsShadow: Record<string, any>;
  postMessageBatched: PostMessageMock;
  updateSeriesAppearance: LineChart["updateSeriesAppearance"];
}

interface AddVectorsHarness {
  destroyed: boolean;
  expectedSeriesCount: number;
  pendingTimestamps: number[];
  pendingValues: number[][];
  batchFlushFrame: number | null;
  flushViewportInputs: PostMessageMock;
  worker: { postMessage: PostMessageMock };
  addVectors: LineChart["addVectors"];
}

interface AddVectorHarness extends AddVectorsHarness {
  addVector: LineChart["addVector"];
}

interface DatasetHarness {
  destroyed: boolean;
  dataVersion: number;
  flushViewportInputs: PostMessageMock;
  worker: { postMessage: PostMessageMock };
  setData: LineChart["setData"];
  setMultiSeriesData: LineChart["setMultiSeriesData"];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LineChart.updateSeriesAppearance", () => {
  it("creates missing host series options before applying a patch", () => {
    const chart = Object.create(LineChart.prototype) as SeriesAppearanceHarness;
    chart.destroyed = false;
    chart.optionsShadow = { series: [] };
    chart.postMessageBatched = vi.fn();

    chart.updateSeriesAppearance(0, {
      color: "#123456",
      marker: { shape: "diamond" },
    });

    expect(chart.optionsShadow.series).toEqual([
      { color: "#123456", marker: { shape: "diamond" } },
    ]);
    expect(chart.postMessageBatched).toHaveBeenCalledWith({
      type: "updateSeriesAppearance",
      index: 0,
      patch: { color: "#123456", marker: { shape: "diamond" } },
    });
  });
});

describe("LineChart.addVector", () => {
  function makeChart() {
    const callbacks: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => callbacks.push(callback));
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    const postMessage = vi.fn();
    const chart = Object.create(LineChart.prototype) as AddVectorHarness;
    chart.destroyed = false;
    chart.expectedSeriesCount = 2;
    chart.pendingTimestamps = [];
    chart.pendingValues = [];
    chart.batchFlushFrame = null;
    chart.flushViewportInputs = vi.fn();
    chart.worker = { postMessage };
    return {
      chart,
      postMessage,
      requestFrame,
      flushFrame() {
        for (const callback of callbacks.splice(0)) callback(0);
      },
    };
  }

  it("snapshots each sample when the caller reuses an array before the batched flush", () => {
    const { chart, postMessage, requestFrame, flushFrame } = makeChart();
    const values = [10, 100];

    chart.addVector(1, values);
    values[0] = 20;
    values[1] = 200;
    chart.addVector(2, values);
    values[0] = 30;
    values[1] = 300;

    expect(postMessage).not.toHaveBeenCalled();
    expect(requestFrame).toHaveBeenCalledOnce();
    flushFrame();

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage.mock.calls[0][0]).toEqual({
      type: "addDataPoints",
      timestamps: new Float64Array([1, 2]),
      valuesBySeries: [new Float64Array([10, 20]), new Float64Array([100, 200])],
    });
    expect(values).toEqual([30, 300]);
  });

  it("preserves the queued sample shape when the caller clears its array", () => {
    const { chart, postMessage, flushFrame } = makeChart();
    const values = [10, 100];

    chart.addVector(1, values);
    values.length = 0;
    flushFrame();

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage.mock.calls[0][0]).toEqual({
      type: "addDataPoints",
      timestamps: new Float64Array([1]),
      valuesBySeries: [new Float64Array([10]), new Float64Array([100])],
    });
    expect(values).toEqual([]);
  });
});

describe("LineChart.addVectors", () => {
  function makeChart(expectedSeriesCount: number) {
    const postMessage = vi.fn();
    const chart = Object.create(LineChart.prototype) as AddVectorsHarness;
    chart.destroyed = false;
    chart.expectedSeriesCount = expectedSeriesCount;
    chart.pendingTimestamps = [];
    chart.pendingValues = [];
    chart.batchFlushFrame = null;
    chart.flushViewportInputs = vi.fn();
    chart.worker = { postMessage };
    return { chart, postMessage };
  }

  it("passes bulk arrays and their original buffers through without copying", () => {
    const { chart, postMessage } = makeChart(2);
    const timestamps = new Float64Array([1, 2]);
    const first = new Float64Array([10, 20]);
    const second = new Float64Array([100, 200]);
    const valuesBySeries = [first, second];

    chart.addVectors(timestamps, valuesBySeries);

    expect(postMessage).toHaveBeenCalledOnce();
    const [message, transferables] = postMessage.mock.calls[0];
    expect(message.timestamps).toBe(timestamps);
    expect(message.valuesBySeries).toBe(valuesBySeries);
    expect(transferables).toHaveLength(3);
    expect(transferables[0]).toBe(timestamps.buffer);
    expect(transferables[1]).toBe(first.buffer);
    expect(transferables[2]).toBe(second.buffer);
  });

  it("rejects a mismatched series count before posting transferables", () => {
    const { chart, postMessage } = makeChart(2);
    const timestamps = new Float64Array([1, 2]);
    const onlySeries = new Float64Array([10, 20]);

    expect(() => chart.addVectors(timestamps, [onlySeries])).toThrow(
      "addVectors: expected 2 series, got 1",
    );
    expect(postMessage).not.toHaveBeenCalled();
    expect(timestamps.byteLength).toBe(16);
    expect(onlySeries.byteLength).toBe(16);
  });

  it("rejects mismatched vector lengths before posting transferables", () => {
    const { chart, postMessage } = makeChart(2);
    const timestamps = new Float64Array([1, 2]);
    const first = new Float64Array([10, 20]);
    const second = new Float64Array([30]);

    expect(() => chart.addVectors(timestamps, [first, second])).toThrow(
      "addVectors: timestamps contain 2 points, but series 1 contains 1",
    );
    expect(postMessage).not.toHaveBeenCalled();
    expect(timestamps.byteLength).toBe(16);
    expect(first.byteLength).toBe(16);
    expect(second.byteLength).toBe(8);
  });
});

describe("LineChart dataset generations", () => {
  it("assigns a distinct generation to each transferred dataset", () => {
    const postMessage = vi.fn();
    const chart = Object.create(LineChart.prototype) as DatasetHarness;
    chart.destroyed = false;
    chart.dataVersion = 0;
    chart.flushViewportInputs = vi.fn();
    chart.worker = { postMessage };

    const firstVersion = chart.setData({
      x: new Float64Array([1, 2]),
      y: new Float64Array([10, 20]),
      length: 2,
    });
    const secondVersion = chart.setMultiSeriesData(
      {
        x: new Float64Array([1, 2]),
        series: [new Float64Array([30, 40])],
        seriesCount: 1,
        length: 2,
      },
      { preservePreviousFrame: true },
    );

    expect([firstVersion, secondVersion]).toEqual([1, 2]);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      type: "setData",
      dataVersion: 1,
      preservePreviousFrame: false,
    });
    expect(postMessage.mock.calls[2][0]).toMatchObject({
      type: "setData",
      dataVersion: 2,
      preservePreviousFrame: true,
    });
  });
});

describe("LineChart dataset validation", () => {
  function makeChart() {
    const postMessage = vi.fn();
    const chart = Object.create(LineChart.prototype) as DatasetHarness;
    chart.destroyed = false;
    chart.dataVersion = 0;
    chart.flushViewportInputs = vi.fn();
    chart.worker = { postMessage };
    return { chart, postMessage };
  }

  it("rejects a missing single-series Y column before renderer delivery", () => {
    const { chart, postMessage } = makeChart();

    expect(() => chart.setData({ x: new Float64Array([1, 2]), length: 2 } as never)).toThrow(
      TypeError,
    );
    expect(postMessage).not.toHaveBeenCalled();
    expect(chart.flushViewportInputs).not.toHaveBeenCalled();
    expect(chart.dataVersion).toBe(0);
  });

  it("rejects nullish multi-series entries before renderer delivery", () => {
    const { chart, postMessage } = makeChart();

    expect(() =>
      chart.setMultiSeriesData({
        x: new Float64Array([1, 2]),
        series: [new Float64Array([3, 4]), null],
        length: 2,
        seriesCount: 2,
      } as never),
    ).toThrow(TypeError);
    expect(postMessage).not.toHaveBeenCalled();
    expect(chart.dataVersion).toBe(0);
  });

  it("rejects misaligned columns and declared metadata", () => {
    const { chart } = makeChart();

    expect(() =>
      chart.setData({
        x: new Float64Array([1, 2]),
        y: new Float64Array([3]),
        length: 2,
      }),
    ).toThrow(RangeError);

    expect(() =>
      chart.setMultiSeriesData({
        x: new Float64Array([1, 2]),
        series: [new Float64Array([3, 4])],
        length: 1,
        seriesCount: 1,
      }),
    ).toThrow(RangeError);
  });
});
