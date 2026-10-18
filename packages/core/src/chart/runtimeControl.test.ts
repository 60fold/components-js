/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BaseChart,
  ChartOverlayError,
  ChartRendererError,
  type BaseChartOptions,
  type RendererFailurePhase,
  type Viewport,
} from "./BaseChart";
import { markViewportInputBatchRenderer } from "./internalRendererCapabilities";
import type { ChartWorkerLike } from "./workerInterface";

function createCanvas(width = 800, height = 400): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        width,
        height,
        toJSON: () => ({}),
      }) as DOMRect,
  });
  return canvas;
}

interface PostedMessage {
  message: Record<string, any>;
  transfer?: Transferable[];
}

function createWorkerStub(): {
  worker: ChartWorkerLike;
  messages: Record<string, any>[];
  posted: PostedMessage[];
} {
  const messages: Record<string, any>[] = [];
  const posted: PostedMessage[] = [];
  const worker: ChartWorkerLike = {
    onmessage: null,
    postMessage: (message: Record<string, any>, transfer?: Transferable[]) => {
      messages.push(message);
      posted.push({ message, transfer });
    },
    terminate: vi.fn(),
  };
  return { worker, messages, posted };
}

function installAnimationFrameHarness(): {
  flush(): void;
  pending(): number;
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
    flush() {
      const frame = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of frame) callback(16);
    },
    pending() {
      return callbacks.size;
    },
  };
}

function installMediaQueries(reducedMotion: boolean): {
  setReducedMotion(matches: boolean): void;
  reducedMotionListenerCount(): number;
} {
  let reducedMotionMatches = reducedMotion;
  const reducedMotionListeners = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => {
      const listeners = new Set<(event: MediaQueryListEvent) => void>();
      const isReducedMotion = media === "(prefers-reduced-motion: reduce)";
      return {
        get matches() {
          return isReducedMotion && reducedMotionMatches;
        },
        media,
        onchange: null,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          (isReducedMotion ? reducedMotionListeners : listeners).add(listener);
        },
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          (isReducedMotion ? reducedMotionListeners : listeners).delete(listener);
        },
        addListener: (listener: (event: MediaQueryListEvent) => void) => {
          (isReducedMotion ? reducedMotionListeners : listeners).add(listener);
        },
        removeListener: (listener: (event: MediaQueryListEvent) => void) => {
          (isReducedMotion ? reducedMotionListeners : listeners).delete(listener);
        },
        dispatchEvent: () => true,
      } as unknown as MediaQueryList;
    }),
  );
  return {
    setReducedMotion(matches) {
      reducedMotionMatches = matches;
      const event = {
        matches,
        media: "(prefers-reduced-motion: reduce)",
      } as MediaQueryListEvent;
      for (const listener of reducedMotionListeners) listener(event);
    },
    reducedMotionListenerCount() {
      return reducedMotionListeners.size;
    },
  };
}

class TestChart extends BaseChart {
  constructor(
    canvas: HTMLCanvasElement,
    worker: ChartWorkerLike,
    options: BaseChartOptions = {},
    minViewportRange = 0,
    useOffscreen = false,
  ) {
    markViewportInputBatchRenderer(worker);
    super(canvas, () => worker, options, {}, useOffscreen, "main", minViewportRange);
  }

  protected handleWorkerMessage(e: MessageEvent): void {
    const { type, error } = e.data as {
      type?: string;
      error?: string;
    };
    if (type === "ready") {
      this.resolveReady();
    } else if (type === "initError") {
      this.failRenderer(new Error(error), "initialization");
    } else if (type === "runtimeError") {
      this.failRenderer(new Error(error), "runtime");
    }
  }

  /** Simulate the worker sending back stats with viewport and dataBounds */
  simulateStatsMessage(viewport: Viewport, dataBounds?: Viewport): void {
    this.handleStatsMessage({ viewport, dataBounds });
  }

  /** Simulate the renderer confirming an interactive viewport change. */
  simulateViewportSync(
    viewport: Viewport,
    dataBounds?: Viewport,
    viewportRequestId?: number,
  ): void {
    this.handleViewportSyncMessage({ viewport, dataBounds, viewportRequestId });
  }

  /** Exercise data and lifecycle paths that flush queued viewport inputs. */
  testFlushViewportInputs(): void {
    this.flushViewportInputs();
  }

  /** Set dataBounds directly for testing */
  setDataBounds(bounds: Viewport): void {
    this.dataBounds = { ...bounds };
    this.hasDataBounds = true;
  }

  /** Simulate the renderer publishing interactive legend geometry. */
  simulateLegendLayout(
    hitboxes: Array<{ x: number; y: number; width: number; height: number }>,
  ): void {
    this.syncLegendInteractionFromRenderer({
      legendInteractive: true,
      legendHitboxes: hitboxes,
    });
  }

  /** Expose deferInBatch for testing side-effect deferral */
  testDeferInBatch(fn: () => void): void {
    this.deferInBatch(fn);
  }

  /** Expose postMessageBatched for testing */
  testPostMessageBatched(message: Record<string, any>): void {
    this.postMessageBatched(message);
  }

  /** Expose shadow for testing */
  getShadow(): Record<string, any> {
    return this.optionsShadow;
  }
}

function setup(options: BaseChartOptions = {}) {
  const canvas = createCanvas();
  const { worker, messages, posted } = createWorkerStub();
  const chart = new TestChart(canvas, worker, options);
  // Clear init messages (init, resize, etc.)
  messages.length = 0;
  posted.length = 0;
  return { canvas, chart, messages, posted, worker };
}

type RendererFailureSource = "error" | "messageerror" | "initError" | "runtimeError";

function emitRendererFailure(
  worker: ChartWorkerLike,
  source: RendererFailureSource,
  message: string,
): void {
  if (source === "error") {
    worker.onerror?.(
      new ErrorEvent("error", {
        message,
        error: new Error(message),
      }),
    );
    return;
  }
  if (source === "messageerror") {
    worker.onmessageerror?.(new MessageEvent("messageerror"));
    return;
  }
  worker.onmessage?.(
    new MessageEvent("message", {
      data: { type: source, error: message },
    }),
  );
}

function dispatchTouch(
  canvas: HTMLCanvasElement,
  type: "touchstart" | "touchmove" | "touchend",
  points: Array<{ x: number; y: number }>,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: points.map(({ x, y }) => ({
      clientX: x,
      clientY: y,
    })),
  });
  canvas.dispatchEvent(event);
  return event;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Runtime Control API", () => {
  it("constructs when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { chart } = setup();

    chart.destroy();
  });

  it("observes and disconnects the canvas when IntersectionObserver is available", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = observe;
        disconnect = disconnect;
      },
    );
    const { canvas, chart } = setup();

    expect(observe).toHaveBeenCalledWith(canvas);
    chart.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("snapshots frozen construction config before renderer delivery", () => {
    const canvas = createCanvas();
    const { worker, messages } = createWorkerStub();
    const vertical = Object.freeze({ color: "#abcdef" });
    const crosshairStyle = Object.freeze({ vertical });
    const options = Object.freeze({ crosshairStyle }) as BaseChartOptions;

    const chart = new TestChart(canvas, worker, options);
    const init = messages.find((message) => message.type === "init");

    expect(init).toBeDefined();
    expect(init!.config.crosshairStyle).not.toBe(crosshairStyle);
    expect(init!.config.crosshairStyle.vertical).not.toBe(vertical);
    expect(Object.isFrozen(init!.config.crosshairStyle.vertical)).toBe(false);

    init!.config.crosshairStyle.vertical.color = "#123456";
    expect(vertical.color).toBe("#abcdef");
    chart.destroy();
  });

  it("forwards the chart text direction to the renderer", () => {
    const canvas = createCanvas();
    const { worker, messages } = createWorkerStub();
    const chart = new TestChart(canvas, worker, { textDirection: "rtl" });
    const init = messages.find((message) => message.type === "init");

    expect(init?.config.textDirection).toBe("rtl");
    chart.destroy();
  });

  describe("getRenderMode()", () => {
    it("returns 'main' when constructed with useOffscreen=false", () => {
      const { chart } = setup();
      expect(chart.getRenderMode()).toBe("main");
      chart.destroy();
    });
  });

  describe("initialize() lifecycle", () => {
    it("rejects and tears down when the renderer never becomes ready", async () => {
      vi.useFakeTimers();
      try {
        const { chart, worker } = setup();
        const initialized = chart.initialize();
        const rejection = expect(initialized).rejects.toMatchObject({
          name: "ChartRendererError",
          phase: "initialization",
          message: "Timeout: 15000 ms",
        });

        await vi.advanceTimersByTimeAsync(15_000);
        await rejection;
        expect(worker.terminate).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("starts the startup watchdog during construction with a configurable timeout", async () => {
      vi.useFakeTimers();
      try {
        const { chart, worker } = setup({ rendererInitializationTimeout: 25 });
        const callback = vi.fn();
        chart.setRendererErrorCallback(callback);

        await vi.advanceTimersByTimeAsync(25);

        expect(callback).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "ChartRendererError",
            phase: "initialization",
            message: "Timeout: 25 ms",
          }),
        );
        expect(worker.terminate).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("allows the startup watchdog to be disabled", async () => {
      vi.useFakeTimers();
      try {
        const { chart, worker } = setup({ rendererInitializationTimeout: 0 });
        const callback = vi.fn();
        chart.setRendererErrorCallback(callback);

        await vi.advanceTimersByTimeAsync(60_000);

        expect(callback).not.toHaveBeenCalled();
        expect(worker.terminate).not.toHaveBeenCalled();
        chart.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    describe.each([
      {
        source: "error" as const,
        expectedMessage: "worker chunk failed",
        phaseBeforeReady: "initialization" as const,
        phaseAfterReady: "runtime" as const,
      },
      {
        source: "messageerror" as const,
        expectedMessage: "Invalid renderer message",
        phaseBeforeReady: "initialization" as const,
        phaseAfterReady: "runtime" as const,
      },
      {
        source: "initError" as const,
        expectedMessage: "worker chunk failed",
        phaseBeforeReady: "initialization" as const,
        phaseAfterReady: "initialization" as const,
      },
      {
        source: "runtimeError" as const,
        expectedMessage: "worker chunk failed",
        phaseBeforeReady: "runtime" as const,
        phaseAfterReady: "runtime" as const,
      },
    ])(
      "$source renderer failures",
      ({ source, expectedMessage, phaseBeforeReady, phaseAfterReady }) => {
        it.each(["before", "after"] as const)(
          "notifies exactly once when signalled %s readiness and then tears down",
          async (timing) => {
            const { chart, worker } = setup();
            const expectedPhase: RendererFailurePhase =
              timing === "before" ? phaseBeforeReady : phaseAfterReady;
            const callback = vi.fn((error: ChartRendererError) => {
              expect(error.message).toBe(expectedMessage);
              expect(error.phase).toBe(expectedPhase);
              expect(worker.terminate).not.toHaveBeenCalled();
            });
            chart.setRendererErrorCallback(callback);
            const initialized = chart.initialize();

            if (timing === "after") {
              worker.onmessage?.(new MessageEvent("message", { data: { type: "ready" } }));
              await initialized;
            }

            emitRendererFailure(worker, source, "worker chunk failed");
            // A second failure signal after teardown must not notify again.
            emitRendererFailure(worker, "error", "duplicate worker failure");

            if (timing === "before") {
              await expect(initialized).rejects.toMatchObject({
                message: expectedMessage,
                name: "ChartRendererError",
                phase: expectedPhase,
              });
            } else {
              await expect(chart.initialize()).resolves.toBeUndefined();
            }
            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith(expect.any(ChartRendererError));
            expect(worker.terminate).toHaveBeenCalledTimes(1);
          },
        );
      },
    );

    it("rejects when destroyed before ready", async () => {
      const { chart, worker } = setup();
      const initialized = chart.initialize();
      const callback = vi.fn();
      chart.setRendererErrorCallback(callback);

      chart.destroy();
      emitRendererFailure(worker, "error", "late worker failure");

      await expect(initialized).rejects.toMatchObject({ name: "AbortError" });
      expect(callback).not.toHaveBeenCalled();
    });

    it("allows callers to cancel renderer failure notification", () => {
      const { chart, worker } = setup();
      const callback = vi.fn();
      chart.setRendererErrorCallback(callback);
      chart.setRendererErrorCallback(null);

      emitRendererFailure(worker, "error", "worker chunk failed");

      expect(callback).not.toHaveBeenCalled();
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it("reports an otherwise-unhandled renderer failure to the console", async () => {
      const { chart, worker } = setup();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const initialized = chart.initialize();
      worker.onmessage?.(new MessageEvent("message", { data: { type: "ready" } }));
      await initialized;

      emitRendererFailure(worker, "runtimeError", "renderer data rejected");

      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "ChartRendererError",
          phase: "runtime",
          message: "renderer data rejected",
        }),
      );
      expect(worker.terminate).toHaveBeenCalledOnce();
      consoleError.mockRestore();
    });
  });

  describe("getViewport()", () => {
    it("returns a copy of the current viewport", () => {
      const { chart } = setup();
      chart.simulateStatsMessage({ xMin: 100, xMax: 500 }, { xMin: 0, xMax: 1000 });

      const v = chart.getViewport();
      expect(v).toEqual({ xMin: 100, xMax: 500 });

      // Mutating the returned object should not affect internal state
      v.xMin = 999;
      expect(chart.getViewport().xMin).toBe(100);
      chart.destroy();
    });

    it("copies only x bounds from renderer viewport messages", () => {
      const { chart } = setup();
      chart.simulateStatsMessage(
        { xMin: 100, xMax: 500, yMin: -20, yMax: 80 } as Viewport,
        { xMin: 0, xMax: 1000, yMin: -100, yMax: 100 } as Viewport,
      );

      expect(chart.getViewport()).toEqual({ xMin: 100, xMax: 500 });
      expect(Object.keys(chart.getViewport())).toEqual(["xMin", "xMax"]);
      chart.destroy();
    });

    it("returns default viewport before any stats", () => {
      const { chart } = setup();
      const v = chart.getViewport();
      expect(v).toEqual({ xMin: 0, xMax: 1 });
      chart.destroy();
    });

    it("reflects instant setViewport immediately without waiting for stats", () => {
      const { chart } = setup({ animated: false });
      chart.setDataBounds({ xMin: 0, xMax: 1000 });
      chart.simulateStatsMessage({ xMin: 0, xMax: 1000 });

      chart.setViewport({ xMin: 100, xMax: 500 }, { animated: false });
      expect(chart.getViewport()).toEqual({ xMin: 100, xMax: 500 });
      chart.destroy();
    });

    it("reflects partial setViewport merged with current state", () => {
      const { chart } = setup({ animated: false });
      chart.setDataBounds({ xMin: 0, xMax: 1000 });
      chart.simulateStatsMessage({ xMin: 0, xMax: 1000 });

      chart.setViewport({ xMin: 200 }, { animated: false });
      expect(chart.getViewport()).toEqual({ xMin: 200, xMax: 1000 });
      chart.destroy();
    });

    it("reflects reset to dataBounds immediately", () => {
      const { chart } = setup({ animated: false });
      chart.simulateStatsMessage({ xMin: 100, xMax: 500 });
      // Simulate dataBounds update
      chart.setDataBounds({ xMin: 0, xMax: 2000 });

      chart.reset({ animated: false });
      expect(chart.getViewport()).toEqual({ xMin: 0, xMax: 2000 });
      chart.destroy();
    });

    it("clamps out-of-bounds viewport to dataBounds", () => {
      const { chart } = setup({ animated: false });
      (chart as any).dataBounds = { xMin: 0, xMax: 1000 };

      chart.setViewport({ xMin: -500, xMax: 2000 }, { animated: false });
      expect(chart.getViewport()).toEqual({ xMin: 0, xMax: 1000 });
      chart.destroy();
    });

    it("swaps inverted min/max", () => {
      const { chart } = setup({ animated: false });
      chart.setDataBounds({ xMin: 0, xMax: 1000 });

      chart.setViewport({ xMin: 800, xMax: 200 }, { animated: false });
      // Should swap to lo=200, hi=800
      expect(chart.getViewport()).toEqual({ xMin: 200, xMax: 800 });
      chart.destroy();
    });

    it("does not update local viewport when range collapses to zero", () => {
      const { chart } = setup({ animated: false });
      chart.setDataBounds({ xMin: 0, xMax: 1000 });
      chart.simulateStatsMessage({ xMin: 100, xMax: 500 });

      // Both values clamped to same point → degenerate range
      chart.setViewport({ xMin: 500, xMax: 500 }, { animated: false });
      // Local viewport should remain unchanged
      expect(chart.getViewport()).toEqual({ xMin: 100, xMax: 500 });
      chart.destroy();
    });

    it("does not update local viewport when range is below minViewportRange", () => {
      const canvas = createCanvas();
      const { worker, messages } = createWorkerStub();
      const chart = new TestChart(canvas, worker, {}, 100);
      messages.length = 0;
      chart.setDataBounds({ xMin: 0, xMax: 1000 });
      chart.simulateStatsMessage({ xMin: 0, xMax: 1000 });

      // Range of 50 is below minViewportRange of 100
      chart.setViewport({ xMin: 400, xMax: 450 }, { animated: false });
      // Local viewport should remain unchanged
      expect(chart.getViewport()).toEqual({ xMin: 0, xMax: 1000 });
      // Message should still be sent (renderer does its own rejection)
      expect(messages.some((m) => m.type === "setViewportRange")).toBe(true);
      chart.destroy();
    });

    it("uses a configured minimum range in both host state and renderer init", () => {
      const canvas = createCanvas();
      const { worker, messages } = createWorkerStub();
      const chart = new TestChart(
        canvas,
        worker,
        { animated: false, minViewportRange: 60_000 },
        10,
      );
      const init = messages.find((message) => message.type === "init");

      expect(init?.config.minViewportRange).toBe(60_000);
      expect(chart.getOptions().minViewportRange).toBe(60_000);

      chart.setDataBounds({ xMin: 0, xMax: 1_000_000 });
      chart.simulateStatsMessage({ xMin: 0, xMax: 1_000_000 });
      chart.setViewport({ xMin: 400_000, xMax: 400_010 }, { animated: false });
      expect(chart.getViewport()).toEqual({ xMin: 0, xMax: 1_000_000 });
      chart.destroy();
    });

    it("sanitizes a fixed Y domain for renderer init and options inspection", () => {
      const canvas = createCanvas();
      const { worker, messages } = createWorkerStub();
      const chart = new TestChart(canvas, worker, {
        yDomain: { min: 0, max: 100 },
      });
      const init = messages.find((message) => message.type === "init");

      expect(init?.config.yDomain).toEqual({ min: 0, max: 100 });
      expect(chart.getOptions().yDomain).toEqual({ min: 0, max: 100 });
      chart.destroy();
    });

    it("animated partial update uses locally updated viewport, not stale state", () => {
      const { chart, messages } = setup({ animated: true });
      chart.setDataBounds({ xMin: 0, xMax: 1000 });
      chart.simulateStatsMessage({ xMin: 0, xMax: 1000 });

      // First: instant setViewport changes xMax
      chart.setViewport({ xMax: 500 }, { animated: false });
      messages.length = 0;

      // Second: animated partial setViewport changes xMin only
      // xMax should resolve from the locally updated 500, not the stale 1000
      chart.setViewport({ xMin: 100 });
      const msg = messages.find((m) => m.type === "setViewportRangeAnimated");
      expect(msg).toBeDefined();
      expect(msg!.xMin).toBe(100);
      expect(msg!.xMax).toBe(500);
      chart.destroy();
    });
  });

  describe("setViewport()", () => {
    it("sends setViewportRangeAnimated by default when animated=true", () => {
      const { chart, messages } = setup({ animated: true });
      chart.setDataBounds({ xMin: 0, xMax: 100 });
      chart.setViewport({ xMin: 10, xMax: 50 });

      const msg = messages.find((m) => m.type === "setViewportRangeAnimated");
      expect(msg).toBeDefined();
      expect(msg!.xMin).toBe(10);
      expect(msg!.xMax).toBe(50);
      chart.destroy();
    });

    it("sends setViewportRange when animated=false", () => {
      const { chart, messages } = setup({ animated: false });
      chart.setViewport({ xMin: 10, xMax: 50 });

      const msg = messages.find((m) => m.type === "setViewportRange");
      expect(msg).toBeDefined();
      expect(msg!.xMin).toBe(10);
      expect(msg!.xMax).toBe(50);
      chart.destroy();
    });

    it("sends clamped bounds for full instant viewport updates", () => {
      const { chart, messages } = setup({ animated: false });
      chart.setDataBounds({ xMin: 0, xMax: 1000 });
      messages.length = 0;

      chart.setViewport({ xMin: -500, xMax: 2000 }, { animated: false });

      const msg = messages.find((m) => m.type === "setViewportRange");
      expect(msg).toBeDefined();
      expect(msg!.xMin).toBe(0);
      expect(msg!.xMax).toBe(1000);
      chart.destroy();
    });

    it("respects per-call animated override", () => {
      const { chart, messages } = setup({ animated: true });
      chart.setViewport({ xMin: 0, xMax: 100 }, { animated: false });

      const msg = messages.find((m) => m.type === "setViewportRange");
      expect(msg).toBeDefined();
      chart.destroy();
    });

    it("supports partial viewport (xMin only) in instant mode", () => {
      const { chart, messages } = setup({ animated: false });
      chart.setViewport({ xMin: 25 });

      const msg = messages.find((m) => m.type === "setViewportRange");
      expect(msg).toBeDefined();
      expect(msg!.xMin).toBe(25);
      expect(msg!.xMax).toBeUndefined();
      chart.destroy();
    });

    it("resolves partial viewport from lastKnownViewport in animated mode", () => {
      const { chart, messages } = setup({ animated: true });
      chart.setDataBounds({ xMin: 0, xMax: 1000 });
      chart.simulateStatsMessage({ xMin: 100, xMax: 500 });

      chart.setViewport({ xMin: 200 });

      const msg = messages.find((m) => m.type === "setViewportRangeAnimated");
      expect(msg).toBeDefined();
      expect(msg!.xMin).toBe(200);
      // xMax should be resolved from lastKnownViewport, not undefined
      expect(msg!.xMax).toBe(500);
      chart.destroy();
    });

    it("resolves partial viewport (xMax only) in animated mode", () => {
      const { chart, messages } = setup({ animated: true });
      chart.setDataBounds({ xMin: 0, xMax: 1000 });
      chart.simulateStatsMessage({ xMin: 100, xMax: 500 });

      chart.setViewport({ xMax: 300 });

      const msg = messages.find((m) => m.type === "setViewportRangeAnimated");
      expect(msg).toBeDefined();
      expect(msg!.xMin).toBe(100);
      expect(msg!.xMax).toBe(300);
      chart.destroy();
    });

    it("no-ops after destroy", () => {
      const { chart, messages } = setup();
      chart.destroy();
      messages.length = 0;

      chart.setViewport({ xMin: 10, xMax: 50 });
      // Only messages should be from destroy, not setViewport
      expect(
        messages.filter(
          (m) => m.type === "setViewportRange" || m.type === "setViewportRangeAnimated",
        ),
      ).toHaveLength(0);
    });
  });

  describe("range selector interactions", () => {
    it("does not emit non-finite viewport updates at zero chart width", () => {
      const canvas = createCanvas(0, 400);
      const { worker, messages } = createWorkerStub();
      const chart = new TestChart(canvas, worker, { animated: false });
      chart.setDataBounds({ xMin: 0, xMax: 1000 });
      chart.simulateStatsMessage({ xMin: 100, xMax: 500 }, { xMin: 0, xMax: 1000 });
      (chart as any).chartWidth = 0;
      messages.length = 0;

      const paddingLeft = (chart as any).padding.left;
      const rangeTop = (chart as any).getRangeSelectorTop();
      canvas.dispatchEvent(
        new MouseEvent("mousedown", {
          clientX: paddingLeft,
          clientY: rangeTop + 1,
          bubbles: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new MouseEvent("mousemove", {
          clientX: paddingLeft + 50,
          clientY: rangeTop + 1,
          bubbles: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      const viewportMessages = messages.filter((m) => m.type === "setViewportRange");
      expect(viewportMessages).toHaveLength(0);
      chart.destroy();
    });
  });

  describe("reset()", () => {
    it("sends resetAnimated when chart is animated", () => {
      const { chart, messages } = setup({ animated: true });
      chart.reset();

      expect(messages.some((m) => m.type === "resetAnimated")).toBe(true);
      chart.destroy();
    });

    it("sends reset when animated=false", () => {
      const { chart, messages } = setup({ animated: false });
      chart.reset();

      expect(messages.some((m) => m.type === "reset")).toBe(true);
      chart.destroy();
    });

    it("respects per-call animated override", () => {
      const { chart, messages } = setup({ animated: true });
      chart.reset({ animated: false });

      expect(messages.some((m) => m.type === "reset")).toBe(true);
      expect(messages.some((m) => m.type === "resetAnimated")).toBe(false);
      chart.destroy();
    });

    it("does not mutate local viewport before data bounds are known", () => {
      const { chart } = setup({ animated: false });
      chart.simulateStatsMessage({ xMin: 10, xMax: 50 });

      chart.reset({ animated: false });

      expect(chart.getViewport()).toEqual({ xMin: 10, xMax: 50 });
      chart.destroy();
    });
  });

  describe("resize()", () => {
    it("sends resize message to worker", () => {
      const { chart, messages } = setup();
      messages.length = 0;
      chart.resize();

      const msg = messages.find((m) => m.type === "resize");
      expect(msg).toBeDefined();
      expect(msg!.width).toBe(800);
      expect(msg!.height).toBe(400);
      chart.destroy();
    });

    it("no-ops after destroy", () => {
      const { chart, messages } = setup();
      chart.destroy();
      messages.length = 0;

      chart.resize();
      expect(messages).toHaveLength(0);
    });
  });

  describe("batch()", () => {
    it("defers messages until batch completes", () => {
      const { chart, messages } = setup({ animated: false });
      chart.batch(() => {
        chart.setViewport({ xMin: 10, xMax: 50 });
        chart.setViewport({ xMin: 20, xMax: 60 });
        // During batch, no messages should have been sent yet
        expect(messages.filter((m) => m.type === "setViewportRange")).toHaveLength(0);
      });

      // After batch, both messages should be flushed
      const viewportMsgs = messages.filter((m) => m.type === "setViewportRange");
      expect(viewportMsgs).toHaveLength(2);
      expect(viewportMsgs[0].xMin).toBe(10);
      expect(viewportMsgs[1].xMin).toBe(20);
      chart.destroy();
    });

    it("nested batches flatten — only outermost flushes", () => {
      const { chart, messages } = setup({ animated: false });
      chart.batch(() => {
        chart.setViewport({ xMin: 1, xMax: 10 });
        chart.batch(() => {
          chart.setViewport({ xMin: 2, xMax: 20 });
          // Still inside outer batch, nothing flushed
          expect(messages.filter((m) => m.type === "setViewportRange")).toHaveLength(0);
        });
        // Inner batch returned but outer still active — still nothing flushed
        expect(messages.filter((m) => m.type === "setViewportRange")).toHaveLength(0);
      });

      // Now both flushed
      const viewportMsgs = messages.filter((m) => m.type === "setViewportRange");
      expect(viewportMsgs).toHaveLength(2);
      chart.destroy();
    });

    it("flushes even if callback throws", () => {
      const { chart, messages } = setup({ animated: false });
      expect(() => {
        chart.batch(() => {
          chart.setViewport({ xMin: 5, xMax: 50 });
          throw new Error("test error");
        });
      }).toThrow("test error");

      // Message should still have been flushed
      const viewportMsgs = messages.filter((m) => m.type === "setViewportRange");
      expect(viewportMsgs).toHaveLength(1);
      chart.destroy();
    });

    it("continues flushing later messages and callbacks when postMessage throws", () => {
      const { chart, messages, worker } = setup({ animated: false });
      const originalPostMessage = worker.postMessage.bind(worker);
      const callback = vi.fn();
      worker.postMessage = (message, transfer) => {
        if (message.type === "uncloneable")
          throw new DOMException("Cannot clone", "DataCloneError");
        originalPostMessage(message, transfer);
      };

      expect(() =>
        chart.batch(() => {
          chart.testPostMessageBatched({ type: "uncloneable" });
          chart.testPostMessageBatched({ type: "afterFailure" });
          chart.testDeferInBatch(callback);
        }),
      ).toThrowError(expect.objectContaining({ name: "DataCloneError" }));

      expect(messages.some((message) => message.type === "afterFailure")).toBe(true);
      expect(callback).toHaveBeenCalledOnce();
      chart.destroy();
    });

    it("no-ops after destroy", () => {
      const { chart, messages } = setup({ animated: false });
      chart.destroy();
      messages.length = 0;

      chart.batch(() => {
        chart.setViewport({ xMin: 10, xMax: 50 });
      });
      expect(messages).toHaveLength(0);
    });

    it("defers side-effect callbacks until after message flush", () => {
      const { chart, messages } = setup({ animated: false });
      const callOrder: string[] = [];

      chart.batch(() => {
        chart.testPostMessageBatched({ type: "testMsg" });
        chart.testDeferInBatch(() => callOrder.push("callback"));
        // During batch: no messages sent, no callbacks fired
        expect(messages.filter((m) => m.type === "testMsg")).toHaveLength(0);
        expect(callOrder).toHaveLength(0);
      });

      // After batch: message flushed first, then callback
      expect(messages.filter((m) => m.type === "testMsg")).toHaveLength(1);
      expect(callOrder).toEqual(["callback"]);
      chart.destroy();
    });

    it("fires callbacks immediately outside batch", () => {
      const { chart } = setup({ animated: false });
      const called: boolean[] = [];

      chart.testDeferInBatch(() => called.push(true));
      expect(called).toEqual([true]);
      chart.destroy();
    });
  });

  describe("destroy()", () => {
    it("is idempotent — second call does not throw or re-terminate", () => {
      const { chart, worker } = setup();
      chart.destroy();
      chart.destroy(); // should not throw

      expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it("sends stop message before terminating", () => {
      const { chart, messages } = setup();
      chart.destroy();

      expect(messages[messages.length - 1].type).toBe("stop");
    });

    it("post-destroy methods no-op silently", () => {
      const { chart, messages } = setup();
      chart.destroy();
      messages.length = 0;

      // None of these should throw or send messages
      chart.setViewport({ xMin: 0, xMax: 1 });
      chart.reset();
      chart.resize();
      chart.batch(() => {
        chart.setViewport({ xMin: 5, xMax: 10 });
      });

      expect(messages).toHaveLength(0);
    });

    it("getViewport() and getRenderMode() still work after destroy", () => {
      const { chart } = setup();
      chart.simulateStatsMessage({ xMin: 10, xMax: 100 }, { xMin: 0, xMax: 200 });
      chart.destroy();

      // Read-only accessors should still work
      expect(chart.getRenderMode()).toBe("main");
      expect(chart.getViewport()).toEqual({ xMin: 10, xMax: 100 });
    });

    it("destroy inside batch discards queued messages and callbacks", () => {
      const { chart, messages } = setup({ animated: false });
      const callbackFired: boolean[] = [];

      chart.batch(() => {
        chart.testPostMessageBatched({ type: "queued" });
        chart.testDeferInBatch(() => callbackFired.push(true));
        chart.destroy();
      });

      // Queued message and callback should NOT have been flushed
      expect(messages.filter((m) => m.type === "queued")).toHaveLength(0);
      expect(callbackFired).toHaveLength(0);
    });
  });

  describe("getOptions()", () => {
    it("returns a normalized snapshot with defaults filled in", () => {
      const { chart } = setup();
      const opts = chart.getOptions();

      // Base defaults should be present
      expect(opts.padding).toEqual({ top: 20, right: 80, bottom: 40, left: 80 });
      expect(opts.animated).toBe(true);
      expect(opts.interactive).toBe(true);
      expect(opts.renderMode).toBe("auto");
      expect(opts.wheelZoomSpeed).toBe(0.1);
      expect(opts.wheelZoomDirection).toBe("up-in");
      expect(opts.keyboardZoomSpeed).toBe(0.1);
      expect(opts.keyboardPanSpeed).toBe(0.1);
      expect(opts.keyboardActivation).toBe("focus");
      expect(opts.keyboardAnnouncements).toMatchObject({
        panLeft: expect.any(String),
        panRight: expect.any(String),
        zoomIn: expect.any(String),
        zoomOut: expect.any(String),
        reset: expect.any(String),
        selectionCancelled: expect.any(String),
        viewport: expect.any(String),
      });
      expect(opts.rendererInitializationTimeout).toBe(15_000);
      expect(opts.keepAliveInterval).toBe(0);
      chart.destroy();
    });

    it("returns normalized keyboard announcement overrides and disabled state", () => {
      const { chart } = setup({
        keyboardAnnouncements: { panRight: "Later." },
      });
      const { chart: disabledChart } = setup({
        keyboardAnnouncements: false,
      });

      expect(chart.getOptions().keyboardAnnouncements).toMatchObject({
        panLeft: expect.any(String),
        panRight: "Later.",
      });
      expect(disabledChart.getOptions().keyboardAnnouncements).toBe(false);
      chart.destroy();
      disabledChart.destroy();
    });

    it("disables implicit animation when the user prefers reduced motion", () => {
      installMediaQueries(true);
      const canvas = createCanvas();
      const { worker, messages } = createWorkerStub();
      const chart = new TestChart(canvas, worker);
      const init = messages.find((message) => message.type === "init");

      expect(chart.getOptions().animated).toBe(false);
      expect(init?.config.animated).toBe(false);
      chart.destroy();
    });

    it("keeps an explicit animation choice authoritative over reduced motion", () => {
      const media = installMediaQueries(true);
      const canvas = createCanvas();
      const { worker, messages } = createWorkerStub();
      const chart = new TestChart(canvas, worker, { animated: true });
      const init = messages.find((message) => message.type === "init");

      expect(chart.getOptions().animated).toBe(true);
      expect(init?.config.animated).toBe(true);
      expect(media.reducedMotionListenerCount()).toBe(0);
      chart.destroy();
    });

    it("follows reduced-motion changes while mounted when animation is implicit", () => {
      const media = installMediaQueries(false);
      const canvas = createCanvas();
      const { worker, messages } = createWorkerStub();
      const chart = new TestChart(canvas, worker);
      messages.length = 0;

      media.setReducedMotion(true);
      media.setReducedMotion(false);

      expect(messages).toEqual([
        { type: "setAnimated", animated: false },
        { type: "setAnimated", animated: true },
      ]);
      expect(chart.getOptions().animated).toBe(true);
      chart.destroy();
      expect(media.reducedMotionListenerCount()).toBe(0);
    });

    it("announces keyboard navigation through a polite live region", async () => {
      const { canvas, chart, messages } = setup({
        keyboardAnnouncements: { panRight: "Moved to later samples." },
      });
      chart.simulateStatsMessage({ xMin: 100, xMax: 500 }, { xMin: 0, xMax: 1_000 });

      canvas.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
      const pan = messages.find((message) => String(message.type).startsWith("pan"));
      const region = document.querySelector<HTMLElement>("[data-sixtyfold-keyboard-announcements]");
      expect(region).not.toBeNull();
      expect(region?.textContent).toBe("");

      chart.simulateViewportSync({ xMin: 180, xMax: 580 }, undefined, pan?.viewportRequestId);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(region).not.toBeNull();
      expect(region?.getAttribute("role")).toBe("status");
      expect(region?.getAttribute("aria-live")).toBe("polite");
      expect(region?.textContent).toBe(
        "Moved to later samples. Showing 40% of the available range, from 18% to 58%.",
      );

      chart.destroy();
      expect(document.querySelector("[data-sixtyfold-keyboard-announcements]")).toBeNull();
    });

    it("does not announce a renderer-clamped keyboard action that leaves the viewport unchanged", async () => {
      const { canvas, chart, messages } = setup({
        keyboardAnnouncements: { panRight: "Moved to later samples.", viewport: "" },
      });
      chart.simulateStatsMessage({ xMin: 600, xMax: 1_000 }, { xMin: 0, xMax: 1_000 });

      canvas.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
      const pan = messages.find((message) => String(message.type).startsWith("pan"));
      chart.simulateViewportSync({ xMin: 600, xMax: 1_000 }, undefined, pan?.viewportRequestId);
      // A later, unrelated viewport update must not be attributed to the
      // already-confirmed no-op keyboard command.
      chart.simulateViewportSync({ xMin: 500, xMax: 900 });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(
        document.querySelector<HTMLElement>("[data-sixtyfold-keyboard-announcements]")?.textContent,
      ).toBe("");
      chart.destroy();
    });

    it("re-announces an identical message after a later confirmed action", async () => {
      const { canvas, chart, messages } = setup({
        keyboardAnnouncements: { panRight: "Moved to later samples.", viewport: "" },
      });
      chart.simulateStatsMessage({ xMin: 100, xMax: 500 }, { xMin: 0, xMax: 1_000 });

      const pressRight = (): void => {
        canvas.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowRight",
            bubbles: true,
            cancelable: true,
          }),
        );
      };

      pressRight();
      const firstPan = messages.find((message) => String(message.type).startsWith("pan"));
      chart.simulateViewportSync({ xMin: 180, xMax: 580 }, undefined, firstPan?.viewportRequestId);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const region = document.querySelector<HTMLElement>("[data-sixtyfold-keyboard-announcements]");
      expect(region?.textContent).toBe("Moved to later samples.");

      pressRight();
      const panMessages = messages.filter((message) => String(message.type).startsWith("pan"));
      chart.simulateViewportSync(
        { xMin: 260, xMax: 660 },
        undefined,
        panMessages.at(-1)?.viewportRequestId,
      );
      expect(region?.textContent).toBe("");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(region?.textContent).toBe("Moved to later samples.");

      chart.destroy();
    });

    it("matches viewport confirmations to the latest keyboard command", async () => {
      const { canvas, chart, messages } = setup({
        keyboardAnnouncements: {
          panLeft: "Moved earlier.",
          panRight: "Moved later.",
          viewport: "",
        },
      });
      chart.simulateStatsMessage({ xMin: 100, xMax: 500 }, { xMin: 0, xMax: 1_000 });

      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      const pans = messages.filter((message) => String(message.type).startsWith("pan"));

      chart.simulateViewportSync({ xMin: 20, xMax: 420 }, undefined, pans[0]?.viewportRequestId);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const region = document.querySelector<HTMLElement>("[data-sixtyfold-keyboard-announcements]");
      expect(region?.textContent).toBe("");

      chart.simulateViewportSync({ xMin: 180, xMax: 580 }, undefined, pans[1]?.viewportRequestId);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(region?.textContent).toBe("Moved later.");
      chart.destroy();
    });

    it("keeps a keyboard acknowledgement pending across unrelated input flushes", async () => {
      const { canvas, chart, messages } = setup({
        keyboardAnnouncements: { panRight: "Moved later.", viewport: "" },
      });
      chart.simulateStatsMessage({ xMin: 100, xMax: 500 }, { xMin: 0, xMax: 1_000 });

      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      const pan = messages.find((message) => String(message.type).startsWith("pan"));
      chart.testFlushViewportInputs();
      chart.simulateViewportSync({ xMin: 180, xMax: 580 }, undefined, pan?.viewportRequestId);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(
        document.querySelector<HTMLElement>("[data-sixtyfold-keyboard-announcements]")?.textContent,
      ).toBe("Moved later.");
      chart.destroy();
    });

    it("allows keyboard announcements to be disabled", async () => {
      const { canvas, chart } = setup({ keyboardAnnouncements: false });

      canvas.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Home",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();

      expect(document.querySelector("[data-sixtyfold-keyboard-announcements]")).toBeNull();
      chart.destroy();
    });

    it("updates keyboard announcements without recreating the chart", async () => {
      const { canvas, chart, messages } = setup({ keyboardAnnouncements: false });
      chart.simulateStatsMessage({ xMin: 100, xMax: 500 }, { xMin: 0, xMax: 1_000 });

      chart.setKeyboardAnnouncements({ panRight: "Later.", viewport: "" });
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      const pan = messages.find((message) => String(message.type).startsWith("pan"));
      chart.simulateViewportSync({ xMin: 180, xMax: 580 }, undefined, pan?.viewportRequestId);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(
        document.querySelector<HTMLElement>("[data-sixtyfold-keyboard-announcements]")?.textContent,
      ).toBe("Later.");
      chart.setKeyboardAnnouncements(false);
      expect(document.querySelector("[data-sixtyfold-keyboard-announcements]")).toBeNull();
      chart.destroy();
    });

    it("includes grid defaults", () => {
      const { chart } = setup();
      const opts = chart.getOptions();

      expect(opts.grid).toEqual({
        color: "#2d4a7c",
        lineWidth: 0.5,
        vertical: true,
        horizontal: true,
      });
      chart.destroy();
    });

    it("includes axis defaults", () => {
      const { chart } = setup();
      const opts = chart.getOptions();

      expect(opts.axis!.color).toBe("#4a6fa1");
      expect(opts.axis!.width).toBe(1);
      chart.destroy();
    });

    it("includes crosshairStyle defaults", () => {
      const { chart } = setup();
      const opts = chart.getOptions();

      expect(opts.crosshairStyle).toEqual({
        vertical: { color: "rgba(255, 255, 255, 0.3)", style: "dashed", visible: true },
        horizontal: { color: "rgba(255, 255, 255, 0.3)", style: "dashed", visible: true },
      });
      chart.destroy();
    });

    it("includes rangeSelector defaults", () => {
      const { chart } = setup();
      const opts = chart.getOptions();

      expect(opts.rangeSelector!.visible).toBe(true);
      expect(opts.rangeSelector!.position).toBe("bottom");
      expect(opts.rangeSelector!.height).toBe(60);
      expect(opts.rangeSelector!.gap).toBe(0);
      chart.destroy();
    });

    it("preserves user-supplied values over defaults", () => {
      const { chart } = setup({
        padding: { top: 10 },
        grid: { color: "#ff0000" },
        animated: false,
      });
      const opts = chart.getOptions();

      expect(opts.padding!.top).toBe(10);
      expect(opts.padding!.right).toBe(80); // default preserved
      expect(opts.grid!.color).toBe("#ff0000");
      expect(opts.grid!.lineWidth).toBe(0.5); // default preserved
      expect(opts.animated).toBe(false);
      chart.destroy();
    });

    it("returns a deep clone — mutations do not affect internal state", () => {
      const { chart } = setup();
      const opts1 = chart.getOptions();
      (opts1 as any).grid.color = "mutated";

      const opts2 = chart.getOptions();
      expect(opts2.grid!.color).toBe("#2d4a7c");
      chart.destroy();
    });
  });

  describe("getAppearance()", () => {
    it("returns only appearance fields, not construction-only fields", () => {
      const { chart } = setup({ animated: false, wheelZoomSpeed: 0.5 });
      const appearance = chart.getAppearance();

      // Appearance fields present
      expect(appearance.grid).toBeDefined();
      expect(appearance.crosshairStyle).toBeDefined();
      expect(appearance.rangeSelector).toBeDefined();

      // Construction-only fields absent
      expect((appearance as any).animated).toBeUndefined();
      expect((appearance as any).wheelZoomSpeed).toBeUndefined();
      expect((appearance as any).renderMode).toBeUndefined();
      expect((appearance as any).interactive).toBeUndefined();
      chart.destroy();
    });
  });

  describe("keyboardActivation hover mode", () => {
    it("handles keyboard navigation while hovered without DOM focus", () => {
      const { canvas, chart, messages } = setup({
        animated: false,
        keyboardActivation: "hover",
      });

      canvas.dispatchEvent(new MouseEvent("mouseenter"));
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );

      expect(messages.some((m) => m.type === "pan" && m.dx === 0.1)).toBe(true);
      chart.destroy();
    });

    it("flushes queued wheel input before recognized keyboard navigation", () => {
      const frames = installAnimationFrameHarness();
      const { canvas, chart, messages } = setup({
        animated: false,
      });

      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -120,
          clientX: 200,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(frames.pending()).toBe(1);
      expect(messages).toEqual([]);

      canvas.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );

      expect(frames.pending()).toBe(0);
      expect(messages.map((message) => message.type)).toEqual(["viewportInputBatch", "pan"]);
      chart.destroy();
    });

    it("does not flush queued input for unrelated keyboard keys", () => {
      const frames = installAnimationFrameHarness();
      const { canvas, chart, messages } = setup({ animated: false });

      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -120,
          clientX: 200,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      canvas.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "a",
          bubbles: true,
          cancelable: true,
        }),
      );

      expect(messages).toEqual([]);
      expect(frames.pending()).toBe(1);
      frames.flush();
      expect(messages.map((message) => message.type)).toEqual(["viewportInputBatch"]);
      chart.destroy();
    });
  });

  describe("pointer pan/select interactions", () => {
    it("flushes queued wheel input before a legend activation", () => {
      const frames = installAnimationFrameHarness();
      const { canvas, chart, messages } = setup({
        animated: false,
        rangeSelector: { visible: false },
      });
      chart.simulateLegendLayout([{ x: 120, y: 60, width: 100, height: 40 }]);

      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -120,
          clientX: 200,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(frames.pending()).toBe(1);
      expect(messages).toEqual([]);

      canvas.dispatchEvent(
        new MouseEvent("mousedown", {
          button: 0,
          clientX: 150,
          clientY: 80,
          bubbles: true,
          cancelable: true,
        }),
      );

      expect(frames.pending()).toBe(0);
      expect(messages).toEqual([
        {
          type: "viewportInputBatch",
          commands: [
            {
              type: "zoom",
              factor: 0.9,
              centerX: 0.1875,
            },
          ],
        },
      ]);
      chart.destroy();
    });

    it("pans the main chart with a primary-button drag", () => {
      const frames = installAnimationFrameHarness();
      const { canvas, chart, messages } = setup({
        animated: false,
        rangeSelector: { visible: false },
      });
      (chart as any).chartWidth = 640;
      messages.length = 0;

      canvas.dispatchEvent(
        new MouseEvent("mousedown", {
          button: 0,
          clientX: 200,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new MouseEvent("mousemove", {
          clientX: 100,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );

      expect(messages).toEqual([]);
      expect(frames.pending()).toBe(1);
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      expect(frames.pending()).toBe(0);
      expect(messages).toEqual([
        {
          type: "viewportInputBatch",
          commands: [{ type: "pan", dx: 100 / 640 }],
        },
        {
          type: "mousemove",
          x: 100,
          y: 100,
          pointerType: "mouse",
        },
      ]);
      chart.destroy();
    });

    it("suppresses crosshair mousemove tasks while a pointer pan is active", () => {
      const frames = installAnimationFrameHarness();
      const { canvas, chart, messages } = setup({
        animated: false,
        rangeSelector: { visible: false },
      });
      (chart as any).chartWidth = 640;
      messages.length = 0;

      canvas.dispatchEvent(
        new MouseEvent("mousedown", {
          button: 0,
          clientX: 200,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      canvas.dispatchEvent(
        new MouseEvent("mousemove", {
          clientX: 100,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );

      expect(messages.filter((message) => message.type === "mousemove")).toEqual([]);
      window.dispatchEvent(
        new MouseEvent("mousemove", {
          clientX: 100,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(frames.pending()).toBe(1);
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      expect(messages).toEqual([
        {
          type: "viewportInputBatch",
          commands: [{ type: "pan", dx: 100 / 640 }],
        },
        {
          type: "mousemove",
          x: 100,
          y: 100,
          pointerType: "mouse",
        },
      ]);
      chart.destroy();
    });

    it("preserves ordered reversing pan commands in one frame", () => {
      const frames = installAnimationFrameHarness();
      const { canvas, chart, messages } = setup({
        animated: false,
        rangeSelector: { visible: false },
      });
      (chart as any).chartWidth = 640;
      messages.length = 0;

      canvas.dispatchEvent(
        new MouseEvent("mousedown", {
          button: 0,
          clientX: 300,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      for (const clientX of [200, 260, 100]) {
        window.dispatchEvent(
          new MouseEvent("mousemove", {
            clientX,
            clientY: 100,
            bubbles: true,
            cancelable: true,
          }),
        );
      }

      expect(messages).toEqual([]);
      expect(frames.pending()).toBe(1);
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      expect(messages).toEqual([
        {
          type: "viewportInputBatch",
          commands: [
            { type: "pan", dx: 100 / 640 },
            { type: "pan", dx: -60 / 640 },
            { type: "pan", dx: 160 / 640 },
          ],
        },
        {
          type: "mousemove",
          x: 100,
          y: 100,
          pointerType: "mouse",
        },
      ]);
      chart.destroy();
    });

    it("selects a main-chart range with shift-drag", () => {
      const { canvas, chart, messages } = setup({
        animated: false,
        rangeSelector: { visible: false },
      });
      (chart as any).chartWidth = 640;
      messages.length = 0;

      canvas.dispatchEvent(
        new MouseEvent("mousedown", {
          button: 0,
          shiftKey: true,
          clientX: 200,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new MouseEvent("mousemove", {
          clientX: 300,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      const range = messages.find((m) => m.type === "setViewportRange");
      expect(range).toBeDefined();
      expect(range!.xMin).toBeCloseTo(120 / 640);
      expect(range!.xMax).toBeCloseTo(220 / 640);
      chart.destroy();
    });
  });

  describe("touch viewport input ordering", () => {
    it("does not capture touch gestures or change the viewport for a view-only chart", () => {
      const { canvas, chart, messages } = setup({
        animated: false,
        interactive: false,
      });
      messages.length = 0;

      const start = dispatchTouch(canvas, "touchstart", [
        { x: 160, y: 120 },
        { x: 360, y: 120 },
      ]);
      const move = dispatchTouch(canvas, "touchmove", [
        { x: 140, y: 120 },
        { x: 380, y: 120 },
      ]);
      dispatchTouch(canvas, "touchend", []);

      expect(start.defaultPrevented).toBe(false);
      expect(move.defaultPrevented).toBe(false);
      expect(messages.some((message) => message.type === "setViewportRange")).toBe(false);
      chart.destroy();
    });

    it("flushes queued input at pinch start and before a pinch viewport update", () => {
      const frames = installAnimationFrameHarness();
      const { canvas, chart, messages } = setup({
        animated: false,
        interactive: true,
      });

      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -120,
          clientX: 200,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(frames.pending()).toBe(1);

      dispatchTouch(canvas, "touchstart", [
        { x: 160, y: 120 },
        { x: 360, y: 120 },
      ]);

      expect(frames.pending()).toBe(0);
      expect(messages[0]?.type).toBe("viewportInputBatch");

      messages.length = 0;
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -120,
          clientX: 240,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(frames.pending()).toBe(1);

      dispatchTouch(canvas, "touchmove", [
        { x: 140, y: 120 },
        { x: 380, y: 120 },
      ]);

      expect(frames.pending()).toBe(0);
      expect(messages.map((message) => message.type)).toEqual([
        "viewportInputBatch",
        "setViewportRange",
      ]);
      dispatchTouch(canvas, "touchend", []);
      chart.destroy();
    });

    it("ignores coincident pinch points instead of posting invalid viewport bounds", () => {
      const { canvas, chart, messages } = setup({
        animated: false,
        interactive: true,
      });
      messages.length = 0;

      dispatchTouch(canvas, "touchstart", [
        { x: 240, y: 120 },
        { x: 240, y: 120 },
      ]);
      messages.length = 0;
      const move = dispatchTouch(canvas, "touchmove", [
        { x: 240, y: 120 },
        { x: 240, y: 120 },
      ]);

      expect(move.defaultPrevented).toBe(true);
      expect(messages.some((message) => message.type === "setViewportRange")).toBe(false);
      dispatchTouch(canvas, "touchend", []);
      chart.destroy();
    });

    it("does not reinterpret a remaining finger as a tooltip gesture after a pinch", () => {
      const { canvas, chart, messages } = setup({
        animated: false,
        interactive: true,
      });

      dispatchTouch(canvas, "touchstart", [
        { x: 160, y: 120 },
        { x: 360, y: 120 },
      ]);
      dispatchTouch(canvas, "touchend", [{ x: 240, y: 120 }]);
      messages.length = 0;

      dispatchTouch(canvas, "touchmove", [{ x: 260, y: 120 }]);

      expect(messages.some((message) => message.type === "mousemove")).toBe(false);
      expect(messages.some((message) => message.type === "setViewportRange")).toBe(false);
      dispatchTouch(canvas, "touchend", []);
      chart.destroy();
    });
  });

  describe("updateAppearance()", () => {
    it("ignores prototype-changing keys in appearance state and renderer messages", () => {
      const { chart, messages } = setup({ grid: { lineWidth: 2 } });
      const patch = JSON.parse(`{
        "__proto__": { "__sixtyfoldAppearancePolluted": true },
        "constructor": { "prototype": { "__sixtyfoldAppearancePolluted": true } },
        "prototype": { "__sixtyfoldAppearancePolluted": true },
        "grid": {
          "color": "#123456",
          "__proto__": { "__sixtyfoldAppearancePolluted": true },
          "constructor": {},
          "prototype": {}
        }
      }`);

      try {
        chart.updateAppearance(patch);

        expect(Object.hasOwn(Object.prototype, "__sixtyfoldAppearancePolluted")).toBe(false);
        expect(chart.getOptions().grid).toMatchObject({ color: "#123456", lineWidth: 2 });
        const message = messages.find((entry) => entry.type === "updateAppearance");
        expect(message).toBeDefined();
        for (const value of [
          chart.getShadow(),
          chart.getShadow().grid,
          message!.patch,
          message!.patch.grid,
        ]) {
          expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
          for (const key of ["__proto__", "constructor", "prototype"]) {
            expect(Object.hasOwn(value, key)).toBe(false);
          }
        }
        expect(Object.hasOwn(patch, "__proto__")).toBe(true);
      } finally {
        Reflect.deleteProperty(Object.prototype, "__sixtyfoldAppearancePolluted");
        chart.destroy();
      }
    });

    it("snapshots recursively frozen appearance patches", () => {
      const { chart, messages } = setup();
      const vertical = Object.freeze({ color: "#abcdef" });
      const patch = Object.freeze({
        crosshairStyle: Object.freeze({ vertical }),
      });

      chart.updateAppearance(patch);

      const msg = messages.find((entry) => entry.type === "updateAppearance");
      expect(msg).toBeDefined();
      expect(msg!.patch).not.toBe(patch);
      expect(msg!.patch.crosshairStyle.vertical).not.toBe(vertical);
      expect(Object.isFrozen(msg!.patch.crosshairStyle.vertical)).toBe(false);

      msg!.patch.crosshairStyle.vertical.color = "#123456";
      expect(vertical.color).toBe("#abcdef");
      chart.destroy();
    });

    it("sends updateAppearance message to worker", () => {
      const { chart, messages } = setup();
      chart.updateAppearance({ grid: { color: "#ff0000" } });

      const msg = messages.find((m) => m.type === "updateAppearance");
      expect(msg).toBeDefined();
      expect(msg!.patch.grid.color).toBe("#ff0000");
      chart.destroy();
    });

    it("deep-merges into shadow state", () => {
      const { chart } = setup({ grid: { color: "#aaa", lineWidth: 2 } });
      chart.updateAppearance({ grid: { color: "#bbb" } });

      const opts = chart.getOptions();
      expect(opts.grid!.color).toBe("#bbb");
      expect(opts.grid!.lineWidth).toBe(2); // preserved
      chart.destroy();
    });

    it("updates are reflected in subsequent getAppearance()", () => {
      const { chart } = setup();
      chart.updateAppearance({
        crosshairStyle: { vertical: { color: "#00ff00" } },
      });

      const appearance = chart.getAppearance();
      expect(appearance.crosshairStyle!.vertical!.color).toBe("#00ff00");
      // Other crosshair defaults preserved
      expect(appearance.crosshairStyle!.horizontal!.color).toBe("rgba(255, 255, 255, 0.3)");
      chart.destroy();
    });

    it("no-ops after destroy", () => {
      const { chart, messages } = setup();
      chart.destroy();
      messages.length = 0;

      chart.updateAppearance({ grid: { color: "#red" } });
      expect(messages).toHaveLength(0);
    });

    it("works inside batch — message deferred until flush", () => {
      const { chart, messages } = setup();
      chart.batch(() => {
        chart.updateAppearance({ grid: { color: "#123" } });
        // Not yet sent
        expect(messages.find((m) => m.type === "updateAppearance")).toBeUndefined();
      });
      // Flushed after batch
      expect(messages.find((m) => m.type === "updateAppearance")).toBeDefined();
      chart.destroy();
    });

    it("keeps tooltip callbacks on the main thread", () => {
      const { canvas, chart, messages } = setup();
      const onRender = vi.fn(() => ({ visible: false as const }));
      const onLeave = vi.fn();

      chart.updateAppearance({ tooltip: { onRender, onLeave } });

      const msg = messages.find((entry) => entry.type === "updateAppearance");
      expect(msg!.patch.tooltip).toEqual({ hasCallback: true });
      expect(chart.getOptions().tooltip!.onRender).toBe(onRender);

      canvas.dispatchEvent(new MouseEvent("mouseleave"));
      expect(onLeave).toHaveBeenCalledTimes(1);
      chart.destroy();
    });
  });

  describe("setLabels() shadow update", () => {
    it("ignores prototype-changing keys in labels and their renderer snapshots", () => {
      const { chart, messages } = setup({ labels: { top: { text: "Original" } } });
      const labels = JSON.parse(`{
        "__proto__": { "__sixtyfoldLabelsPolluted": true },
        "constructor": { "prototype": { "__sixtyfoldLabelsPolluted": true } },
        "prototype": {},
        "top": {
          "text": "Updated",
          "font": { "size": 18, "__proto__": { "__sixtyfoldLabelsPolluted": true } }
        }
      }`);

      try {
        chart.setLabels(labels);

        expect(Object.hasOwn(Object.prototype, "__sixtyfoldLabelsPolluted")).toBe(false);
        expect(chart.getOptions().labels?.top?.text).toBe("Updated");
        const message = messages.find((entry) => entry.type === "setLabels");
        expect(message).toBeDefined();
        for (const value of [chart.getShadow().labels, message!.labels, message!.labels.top.font]) {
          expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
          for (const key of ["__proto__", "constructor", "prototype"]) {
            expect(Object.hasOwn(value, key)).toBe(false);
          }
        }
        expect(Object.hasOwn(labels, "__proto__")).toBe(true);
      } finally {
        Reflect.deleteProperty(Object.prototype, "__sixtyfoldLabelsPolluted");
        chart.destroy();
      }
    });

    it("updates shadow state so getOptions reflects new labels", () => {
      const { chart } = setup({
        labels: { top: { text: "Original", font: { size: 14 } } },
      });
      chart.setLabels({ top: { text: "Updated" } });

      const opts = chart.getOptions();
      expect(opts.labels!.top!.text).toBe("Updated");
      chart.destroy();
    });

    it("merges into existing labels — setLabels({ top }) preserves bottom", () => {
      const { chart } = setup({
        labels: {
          top: { text: "Title" },
          bottom: { text: "Footer" },
        },
      });
      chart.setLabels({ top: { text: "New Title" } });

      const opts = chart.getOptions();
      expect(opts.labels!.top!.text).toBe("New Title");
      expect(opts.labels!.bottom!.text).toBe("Footer");
      chart.destroy();
    });

    it("sends full merged labels to renderer", () => {
      const { chart, messages } = setup({
        labels: {
          top: { text: "Title" },
          bottom: { text: "Footer" },
        },
      });
      messages.length = 0;
      chart.setLabels({ top: { text: "New Title" } });

      const msg = messages.find((m) => m.type === "setLabels");
      expect(msg).toBeDefined();
      expect(msg!.labels.top.text).toBe("New Title");
      expect(msg!.labels.bottom.text).toBe("Footer");
      chart.destroy();
    });

    it("rejects malformed label objects before changing state or posting", () => {
      const { chart, messages } = setup({
        labels: { top: { text: "Original" } },
      });
      messages.length = 0;

      expect(() => chart.setLabels({ top: "Quarterly revenue" } as never)).toThrow(
        "Invalid labels",
      );
      expect(messages).toEqual([]);
      expect(chart.getOptions().labels?.top?.text).toBe("Original");

      chart.setLabels({ top: { text: "Recovered" } });
      expect(messages.some((message) => message.type === "setLabels")).toBe(true);
      expect(chart.getOptions().labels?.top?.text).toBe("Recovered");
      chart.destroy();
    });

    it.each([
      ["an explicit undefined entry", [{ text: "ok" }, undefined]],
      ["a null entry", [{ text: "ok" }, null]],
      ["a primitive entry", [{ text: "ok" }, "nope"]],
    ])("rejects labels.custom containing %s", (_label, custom) => {
      const { chart, messages } = setup();
      messages.length = 0;

      expect(() => chart.setLabels({ custom } as never)).toThrow("Invalid labels");
      expect(messages).toEqual([]);
      chart.destroy();
    });

    it("rejects a sparse labels.custom array, whose holes `some` would skip", () => {
      const { chart, messages } = setup();
      messages.length = 0;
      const custom: unknown[] = [{ text: "ok" }];
      custom[2] = { text: "also ok" };

      expect(() => chart.setLabels({ custom } as never)).toThrow("Invalid labels");
      expect(messages).toEqual([]);
      chart.destroy();
    });

    it("re-sends an overlay that only differs from a sparse predecessor by a hole", () => {
      const { chart, messages } = setup();
      const sparse: unknown[] = [{ kind: "rect", x: 0, y: 0, width: 1, height: 1 }];
      sparse[2] = { kind: "rect", x: 2, y: 2, width: 1, height: 1 };
      chart.updateAppearance({ overlay: { items: sparse } } as never);
      messages.length = 0;

      // Same length, but every slot populated. `every` skips the hole, so this
      // would compare equal and be dropped as unchanged.
      chart.updateAppearance({
        overlay: {
          items: [
            { kind: "rect", x: 0, y: 0, width: 1, height: 1 },
            { kind: "rect", x: 1, y: 1, width: 1, height: 1 },
            { kind: "rect", x: 2, y: 2, width: 1, height: 1 },
          ],
        },
      } as never);

      const msg = messages.find((m) => m.type === "setOverlay");
      expect(msg).toBeDefined();
      expect(msg!.overlay.items).toHaveLength(3);
      chart.destroy();
    });

    it("does not treat an inherited array slot as an owned snapshot entry", () => {
      const { chart, messages } = setup();
      const items: unknown[] = [{ kind: "rect", x: 0, y: 0, width: 1, height: 1 }];
      items.length = 2;
      const prototype = Object.create(Array.prototype) as unknown[];
      prototype[1] = { kind: "rect", x: 1, y: 1, width: 1, height: 1 };
      Object.setPrototypeOf(items, prototype);

      chart.updateAppearance({ overlay: { items } } as never);
      messages.length = 0;
      chart.updateAppearance({ overlay: { items } } as never);

      expect(messages.some((message) => message.type === "setOverlay")).toBe(true);
      chart.destroy();
    });

    it("accepts a fully populated labels.custom array", () => {
      const { chart, messages } = setup();
      messages.length = 0;

      chart.setLabels({
        custom: [
          { text: "a", x: 0, y: 0 },
          { text: "b", x: 1, y: 1 },
        ],
      });

      const msg = messages.find((m) => m.type === "setLabels");
      expect(msg!.labels.custom).toHaveLength(2);
      chart.destroy();
    });
  });

  describe("updateAppearance() labels renderer sync", () => {
    it("rejects malformed partial labels before renderer delivery", () => {
      const { chart, messages } = setup();
      messages.length = 0;

      expect(() => chart.updateAppearance({ labels: { top: "Title" } } as never)).toThrow(
        "Invalid labels",
      );
      expect(messages).toEqual([]);
      chart.destroy();
    });

    it("sends full merged labels to renderer, not just the patch", () => {
      const { chart, messages } = setup({
        labels: {
          top: { text: "Title" },
          bottom: { text: "Footer" },
        },
      });

      // Patch only top label
      chart.updateAppearance({ labels: { top: { text: "New Title" } } });

      const msg = messages.find((m) => m.type === "updateAppearance");
      expect(msg).toBeDefined();
      // Renderer should receive both labels (full merged state)
      expect(msg!.patch.labels.top.text).toBe("New Title");
      expect(msg!.patch.labels.bottom.text).toBe("Footer");
      chart.destroy();
    });
  });

  describe("getOptions() tooltip and selection defaults", () => {
    it("includes tooltip defaults", () => {
      const { chart } = setup();
      const opts = chart.getOptions();

      expect(opts.tooltip!.backgroundColor).toBe("rgba(22, 33, 62, 0.95)");
      expect(opts.tooltip!.borderColor).toBe("#4a6fa1");
      expect(opts.tooltip!.borderWidth).toBe(1);
      expect(opts.tooltip!.position).toBe("cursor-top");
      chart.destroy();
    });

    it("includes selection defaults", () => {
      const { chart } = setup();
      const opts = chart.getOptions();

      expect(opts.selection!.color).toBe("rgba(78, 204, 163, 0.2)");
      expect(opts.selection!.borderColor).toBe("#4ecca3");
      expect(opts.selection!.borderWidth).toBe(2);
      expect(opts.selection!.borderStyle).toBe("dashed");
      chart.destroy();
    });
  });

  describe("malformed overlay items", () => {
    it("installs valid siblings when setOverlay receives a nullish item", async () => {
      const { chart, messages } = setup();
      const failures: ChartOverlayError[] = [];
      chart.setOverlayErrorCallback((error) => failures.push(error));

      await chart.setOverlay({
        items: [null as any, { kind: "rect" as const, x: 0, y: 0, width: 100, height: 50 }],
      });

      const overlayMsg = messages.find((m) => m.type === "setOverlay");
      expect(overlayMsg).toBeDefined();
      expect(overlayMsg!.overlay.items.some((item: any) => item?.kind === "rect")).toBe(true);
      expect(failures).toHaveLength(0);
      chart.destroy();
    });

    it("reports the failing image source when a construction overlay carries a nullish item", async () => {
      vi.stubGlobal("createImageBitmap", vi.fn());
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob() })),
      );

      const canvas = createCanvas();
      (canvas as any).transferControlToOffscreen = () => canvas;
      const { worker, posted } = createWorkerStub();
      // Worker mode, so the DOM <img> fallback stays disabled: jsdom never
      // settles an image element load, which would hang the resolver.
      const chart = new TestChart(
        canvas,
        worker,
        {
          overlay: {
            items: [
              null as any,
              { kind: "rect" as const, x: 0, y: 0, width: 100, height: 50 },
              {
                kind: "image" as const,
                src: "https://example.test/missing.png",
                x: 0,
                y: 0,
                width: 10,
                height: 10,
              },
            ],
          },
        },
        0,
        true,
      );
      // The callback can only be registered after the constructor returns, so a
      // synchronous throw in setOverlay's prologue would be swallowed unreported.
      const failures: ChartOverlayError[] = [];
      chart.setOverlayErrorCallback((error) => failures.push(error));
      worker.onmessage?.(new MessageEvent("message", { data: { type: "ready" } }));

      await vi.waitFor(() => expect(failures).toHaveLength(1));

      expect(failures[0]!.sources).toEqual(["https://example.test/missing.png"]);
      const overlayPost = posted.find((entry) => entry.message.type === "setOverlay");
      expect(overlayPost).toBeDefined();
      expect(overlayPost!.message.overlay.items.some((item: any) => item?.kind === "rect")).toBe(
        true,
      );
      chart.destroy();
    });
  });

  describe("updateAppearance() overlay routing", () => {
    it("routes overlay through setOverlay instead of direct post", () => {
      const { chart, messages } = setup();

      chart.updateAppearance({
        overlay: {
          items: [{ kind: "rect" as const, x: 0, y: 0, width: 100, height: 50 }],
        },
      });

      // Non-image overlay resolves synchronously via postMessageBatched
      const appearanceMsg = messages.find((m) => m.type === "updateAppearance");
      expect(appearanceMsg).toBeUndefined();

      const overlayMsg = messages.find((m) => m.type === "setOverlay");
      expect(overlayMsg).toBeDefined();
      expect(overlayMsg!.overlay.items).toHaveLength(1);
      chart.destroy();
    });

    it("overlay participates in batch semantics for non-image items", () => {
      const { chart, messages } = setup();

      chart.batch(() => {
        chart.updateAppearance({ grid: { color: "#333" } });
        chart.updateAppearance({
          overlay: {
            items: [{ kind: "rect" as const, x: 0, y: 0, width: 100, height: 50 }],
          },
        });
      });

      // Both renderer operations should be flushed together at batch end.
      const appearanceMsgs = messages.filter((m) => m.type === "updateAppearance");
      const overlayMsg = messages.find((m) => m.type === "setOverlay");
      expect(appearanceMsgs).toHaveLength(1);
      expect(overlayMsg).toBeDefined();
      expect(appearanceMsgs[0].patch.grid).toEqual({ color: "#333" });
      expect(appearanceMsgs[0].patch.overlay).toBeUndefined();
      chart.destroy();
    });

    it("structured-clones ImageBitmap sources in worker mode overlay", () => {
      // Stub ImageBitmap in test env (not available in jsdom)
      const FakeImageBitmap = class ImageBitmap {};
      const prevIB = (globalThis as any).ImageBitmap;
      (globalThis as any).ImageBitmap = FakeImageBitmap;

      try {
        const canvas = createCanvas();
        // Add transferControlToOffscreen so workerTransferEnabled = true
        (canvas as any).transferControlToOffscreen = () => canvas;
        const { worker, messages, posted } = createWorkerStub();
        const chart = new TestChart(canvas, worker, {}, 0, true);
        messages.length = 0;
        posted.length = 0;

        const fakeBitmap = new FakeImageBitmap();
        chart.updateAppearance({
          overlay: {
            items: [
              { kind: "image" as any, src: fakeBitmap, x: 0, y: 0, width: 50, height: 50 } as any,
            ],
          },
        });

        const overlayPost = posted.find((p) => p.message.type === "setOverlay");
        expect(overlayPost).toBeDefined();
        expect(overlayPost!.transfer).toBeUndefined();
        expect(overlayPost!.message.overlay.items[0].__sixtyfoldOwnsImageBitmap).toBe(true);
        chart.destroy();
      } finally {
        if (prevIB === undefined) delete (globalThis as any).ImageBitmap;
        else (globalThis as any).ImageBitmap = prevIB;
      }
    });

    it("marks main-thread ImageBitmap snapshots as renderer-owned", () => {
      const FakeImageBitmap = class ImageBitmap {};
      const prevIB = (globalThis as any).ImageBitmap;
      (globalThis as any).ImageBitmap = FakeImageBitmap;

      try {
        const canvas = createCanvas();
        const { worker, posted } = createWorkerStub();
        const chart = new TestChart(canvas, worker);
        posted.length = 0;
        const bitmap = new FakeImageBitmap();

        chart.updateAppearance({
          chartBackground: { type: "image", image: bitmap as any },
          overlay: {
            items: [
              { kind: "image" as any, src: bitmap, x: 0, y: 0, width: 50, height: 50 } as any,
            ],
          },
        });

        const appearancePost = posted.find((entry) => entry.message.type === "updateAppearance");
        expect(appearancePost!.message.patch.chartBackground.__sixtyfoldOwnsImageBitmap).toBe(true);
        expect(appearancePost!.message.patch.overlay.items[0].__sixtyfoldOwnsImageBitmap).toBe(
          true,
        );
        chart.destroy();
      } finally {
        if (prevIB === undefined) delete (globalThis as any).ImageBitmap;
        else (globalThis as any).ImageBitmap = prevIB;
      }
    });

    it("keeps repeated ImageBitmap overlay references in one clone graph", () => {
      const FakeImageBitmap = class ImageBitmap {};
      const prevIB = (globalThis as any).ImageBitmap;
      (globalThis as any).ImageBitmap = FakeImageBitmap;

      try {
        const canvas = createCanvas();
        (canvas as any).transferControlToOffscreen = () => canvas;
        const { worker, posted } = createWorkerStub();
        const chart = new TestChart(canvas, worker, {}, 0, true);
        posted.length = 0;
        const bitmap = new FakeImageBitmap();

        chart.updateAppearance({
          overlay: {
            items: [
              { kind: "image" as any, src: bitmap, x: 0, y: 0, width: 10, height: 10 } as any,
              { kind: "image" as any, src: bitmap, x: 20, y: 0, width: 10, height: 10 } as any,
            ],
          },
        });

        const overlayPost = posted.find((entry) => entry.message.type === "setOverlay");
        expect(overlayPost!.transfer).toBeUndefined();
        expect(overlayPost!.message.overlay.items[0].src).toBe(bitmap);
        expect(overlayPost!.message.overlay.items[1].src).toBe(bitmap);
        chart.destroy();
      } finally {
        if (prevIB === undefined) delete (globalThis as any).ImageBitmap;
        else (globalThis as any).ImageBitmap = prevIB;
      }
    });

    it.each([
      { mode: "main", useOffscreen: false },
      { mode: "worker", useOffscreen: true },
    ])("marks caller-owned ImageBitmap clones during $mode initialization", ({ useOffscreen }) => {
      const FakeImageBitmap = class ImageBitmap {};
      const prevIB = (globalThis as any).ImageBitmap;
      (globalThis as any).ImageBitmap = FakeImageBitmap;

      try {
        const canvas = createCanvas();
        if (useOffscreen) (canvas as any).transferControlToOffscreen = () => canvas;
        const { worker, posted } = createWorkerStub();
        const bitmap = new FakeImageBitmap();
        const chart = new TestChart(
          canvas,
          worker,
          {
            chartBackground: { type: "image", image: bitmap as any },
            overlay: {
              items: [
                { kind: "image" as any, src: bitmap, x: 0, y: 0, width: 10, height: 10 } as any,
              ],
            },
          },
          0,
          useOffscreen,
        );

        const initPost = posted.find((entry) => entry.message.type === "init");
        expect(initPost!.transfer ?? []).not.toContain(bitmap);
        expect(initPost!.message.config.chartBackground.__sixtyfoldOwnsImageBitmap).toBe(true);
        expect(initPost!.message.config.overlay.items[0].__sixtyfoldOwnsImageBitmap).toBe(true);
        chart.destroy();
      } finally {
        if (prevIB === undefined) delete (globalThis as any).ImageBitmap;
        else (globalThis as any).ImageBitmap = prevIB;
      }
    });

    it("keeps a shared runtime background and overlay bitmap reusable", () => {
      const FakeImageBitmap = class ImageBitmap {};
      const prevIB = (globalThis as any).ImageBitmap;
      (globalThis as any).ImageBitmap = FakeImageBitmap;

      try {
        const canvas = createCanvas();
        (canvas as any).transferControlToOffscreen = () => canvas;
        const { worker, posted } = createWorkerStub();
        const chart = new TestChart(canvas, worker, {}, 0, true);
        posted.length = 0;
        const bitmap = new FakeImageBitmap();

        chart.updateAppearance({
          chartBackground: { type: "image", image: bitmap as any },
          overlay: {
            items: [{ kind: "image", src: bitmap as any, x: 0, y: 0, width: 10, height: 10 }],
          },
        });

        const appearancePost = posted.find((entry) => entry.message.type === "updateAppearance");
        expect(appearancePost!.transfer).toBeUndefined();
        expect(appearancePost!.message.patch.chartBackground.__sixtyfoldOwnsImageBitmap).toBe(true);
        expect(appearancePost!.message.patch.overlay.items[0].__sixtyfoldOwnsImageBitmap).toBe(
          true,
        );
        expect(posted.some((entry) => entry.message.type === "setOverlay")).toBe(false);

        chart.updateAppearance({
          chartBackground: { type: "image", image: bitmap as any },
          overlay: {
            items: [{ kind: "image", src: bitmap as any, x: 0, y: 0, width: 10, height: 10 }],
          },
        });
        const repeatedAppearancePosts = posted.filter(
          (entry) => entry.message.type === "updateAppearance",
        );
        expect(repeatedAppearancePosts).toHaveLength(1);
        chart.destroy();
      } finally {
        if (prevIB === undefined) delete (globalThis as any).ImageBitmap;
        else (globalThis as any).ImageBitmap = prevIB;
      }
    });

    it("suppresses a repeated image background after a background type transition", () => {
      const FakeImageBitmap = class ImageBitmap {};
      const prevIB = (globalThis as any).ImageBitmap;
      (globalThis as any).ImageBitmap = FakeImageBitmap;

      try {
        const canvas = createCanvas();
        const { worker, posted } = createWorkerStub();
        const chart = new TestChart(canvas, worker);
        posted.length = 0;
        const bitmap = new FakeImageBitmap();
        const imageBackground = { type: "image" as const, image: bitmap as any };

        chart.updateAppearance({
          chartBackground: {
            type: "gradient",
            direction: "vertical",
            colors: ["#101010", "#202020"],
          },
        });
        chart.updateAppearance({ chartBackground: imageBackground });
        chart.updateAppearance({ chartBackground: imageBackground });

        expect(posted.filter((entry) => entry.message.type === "updateAppearance")).toHaveLength(2);
        expect(chart.getAppearance().chartBackground).toEqual(imageBackground);
        chart.destroy();
      } finally {
        if (prevIB === undefined) delete (globalThis as any).ImageBitmap;
        else (globalThis as any).ImageBitmap = prevIB;
      }
    });

    it("snapshots overlay in batch so later updates do not corrupt earlier messages", () => {
      const FakeImageBitmap = class ImageBitmap {};
      const prevIB = (globalThis as any).ImageBitmap;
      (globalThis as any).ImageBitmap = FakeImageBitmap;

      try {
        const canvas = createCanvas();
        (canvas as any).transferControlToOffscreen = () => canvas;
        const { worker, messages, posted } = createWorkerStub();
        const chart = new TestChart(canvas, worker, {}, 0, true);
        messages.length = 0;
        posted.length = 0;

        const bitmap1 = new FakeImageBitmap();
        const bitmap2 = new FakeImageBitmap();

        chart.batch(() => {
          chart.updateAppearance({
            overlay: {
              items: [
                { kind: "image" as any, src: bitmap1, x: 0, y: 0, width: 50, height: 50 } as any,
              ],
            },
          });
          chart.updateAppearance({
            overlay: {
              items: [
                { kind: "image" as any, src: bitmap2, x: 10, y: 10, width: 60, height: 60 } as any,
              ],
            },
          });
        });

        const overlayPosts = posted.filter((p) => p.message.type === "setOverlay");
        expect(overlayPosts).toHaveLength(2);
        // First message should still reference bitmap1, not bitmap2
        expect((overlayPosts[0].message.overlay as any).items[0].src).toBe(bitmap1);
        expect((overlayPosts[1].message.overlay as any).items[0].src).toBe(bitmap2);
        chart.destroy();
      } finally {
        if (prevIB === undefined) delete (globalThis as any).ImageBitmap;
        else (globalThis as any).ImageBitmap = prevIB;
      }
    });

    it("reports unsupported worker overlay images after installing successful items", async () => {
      const FakeImageBitmap = class ImageBitmap {};
      const prevIB = (globalThis as any).ImageBitmap;
      (globalThis as any).ImageBitmap = FakeImageBitmap;

      try {
        const canvas = createCanvas();
        (canvas as any).transferControlToOffscreen = () => canvas;
        const { worker, messages, posted } = createWorkerStub();
        const chart = new TestChart(canvas, worker, {}, 0, true);
        const onError = vi.fn();
        chart.setOverlayErrorCallback(onError);
        messages.length = 0;
        posted.length = 0;

        // A DOM-like image source that is NOT an ImageBitmap
        const domSource = { nodeName: "IMG", width: 100, height: 100 };

        const update = chart.setOverlay({
          items: [
            { kind: "rect" as const, x: 0, y: 0, width: 5, height: 5 },
            { kind: "image" as any, src: domSource, x: 0, y: 0, width: 50, height: 50 } as any,
          ],
        });

        // Should go through async setOverlay path, not sync postMessageBatched
        // Synchronously there should be no setOverlay message yet
        const syncOverlay = messages.find((m) => m.type === "setOverlay");
        expect(syncOverlay).toBeUndefined();

        await expect(update).rejects.toMatchObject({
          name: "ChartOverlayError",
          sources: ["[unsupported overlay image source]"],
        });

        // The supported rectangle still reaches the renderer.
        const asyncOverlay = messages.find((m) => m.type === "setOverlay");
        expect(asyncOverlay).toBeDefined();
        expect((asyncOverlay as any).overlay.items).toHaveLength(1);
        expect(onError).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith(expect.any(ChartOverlayError));
        chart.destroy();
      } finally {
        if (prevIB === undefined) delete (globalThis as any).ImageBitmap;
        else (globalThis as any).ImageBitmap = prevIB;
      }
    });

    it("preserves the rendered overlay when every requested item fails", async () => {
      const FakeImageBitmap = class ImageBitmap {};
      const prevIB = (globalThis as any).ImageBitmap;
      (globalThis as any).ImageBitmap = FakeImageBitmap;

      try {
        const canvas = createCanvas();
        (canvas as any).transferControlToOffscreen = () => canvas;
        const { worker, messages } = createWorkerStub();
        const chart = new TestChart(canvas, worker, {}, 0, true);
        const previousOverlay = {
          items: [{ kind: "rect" as const, x: 0, y: 0, width: 5, height: 5 }],
        };
        chart.updateAppearance({ overlay: previousOverlay });
        expect(chart.getAppearance().overlay).toEqual(previousOverlay);
        messages.length = 0;
        const onError = vi.fn();
        chart.setOverlayErrorCallback(onError);

        await expect(
          chart.setOverlay({
            items: [
              {
                kind: "image" as any,
                src: { nodeName: "IMG", width: 100, height: 100 },
                x: 0,
                y: 0,
                width: 50,
                height: 50,
              } as any,
            ],
          }),
        ).rejects.toMatchObject({
          name: "ChartOverlayError",
          sources: ["[unsupported overlay image source]"],
        });

        expect(messages.find((message) => message.type === "setOverlay")).toBeUndefined();
        expect(chart.getAppearance().overlay).toEqual(previousOverlay);
        expect(onError).toHaveBeenCalledOnce();
        chart.destroy();
      } finally {
        if (prevIB === undefined) delete (globalThis as any).ImageBitmap;
        else (globalThis as any).ImageBitmap = prevIB;
      }
    });

    it("reports overlay delivery failures without destroying the renderer", async () => {
      class FakeImageBitmap {}

      vi.stubGlobal("ImageBitmap", FakeImageBitmap);
      const { chart, worker } = setup();
      const originalPostMessage = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer) => {
        if (message.type === "setOverlay") {
          throw new DOMException("Cannot clone overlay", "DataCloneError");
        }
        originalPostMessage(message, transfer);
      };
      const onError = vi.fn();
      chart.setOverlayErrorCallback(onError);

      await expect(
        chart.setOverlay({
          items: [
            {
              kind: "image",
              src: new FakeImageBitmap() as unknown as ImageBitmap,
              x: 0,
              y: 0,
              width: 10,
              height: 10,
            },
          ],
        }),
      ).rejects.toMatchObject({
        name: "ChartOverlayError",
        sources: ["[overlay renderer delivery]"],
        cause: expect.objectContaining({ name: "DataCloneError" }),
      });

      expect(onError).toHaveBeenCalledOnce();
      expect(worker.terminate).not.toHaveBeenCalled();
      chart.destroy();
    });

    it("installs valid overlay items when a sibling bitmap detaches before delivery", async () => {
      class FakeImageBitmap {
        width = 8;
        height = 8;

        close(): void {
          this.width = 0;
          this.height = 0;
        }
      }

      vi.stubGlobal("ImageBitmap", FakeImageBitmap);
      const { chart, messages } = setup();
      messages.length = 0;
      const source = new FakeImageBitmap();
      const onError = vi.fn();
      chart.setOverlayErrorCallback(onError);
      const validItem = { kind: "rect" as const, x: 0, y: 0, width: 5, height: 5 };
      source.close();

      const update = chart.setOverlay({
        items: [
          validItem,
          {
            kind: "image",
            src: source as unknown as ImageBitmap,
            x: 10,
            y: 10,
            width: 8,
            height: 8,
          },
        ],
      });

      await expect(update).rejects.toMatchObject({
        name: "ChartOverlayError",
        sources: ["[detached ImageBitmap]"],
      });
      const overlayMessage = messages.find((message) => message.type === "setOverlay");
      expect(overlayMessage?.overlay.items).toEqual([validItem]);
      expect(onError).toHaveBeenCalledOnce();
      chart.destroy();
    });

    it("drops stale async overlay when a newer one is issued", async () => {
      const FakeImageBitmap = class ImageBitmap {};
      const prevIB = (globalThis as any).ImageBitmap;
      (globalThis as any).ImageBitmap = FakeImageBitmap;
      const prevFetch = (globalThis as any).fetch;
      const prevCIB = (globalThis as any).createImageBitmap;

      // Controllable fetch/createImageBitmap stubs
      let resolveA: ((v: any) => void) | null = null;
      let resolveB: ((v: any) => void) | null = null;
      let fetchCallCount = 0;

      (globalThis as any).fetch = () => {
        fetchCallCount++;
        const p = new Promise((r) => {
          if (fetchCallCount === 1) resolveA = r;
          else resolveB = r;
        });
        return p;
      };
      (globalThis as any).createImageBitmap = () => Promise.resolve(new FakeImageBitmap());

      try {
        const { chart, messages } = setup();
        messages.length = 0;

        // Two async overlay updates — A then B
        chart.updateAppearance({
          overlay: {
            items: [
              {
                kind: "image" as any,
                src: "http://a.png",
                x: 0,
                y: 0,
                width: 10,
                height: 10,
              } as any,
            ],
          },
        });
        await vi.waitFor(() => expect(resolveA).not.toBeNull());
        chart.updateAppearance({
          overlay: {
            items: [
              {
                kind: "image" as any,
                src: "http://b.png",
                x: 0,
                y: 0,
                width: 20,
                height: 20,
              } as any,
            ],
          },
        });
        await vi.waitFor(() => expect(resolveB).not.toBeNull());

        // Resolve B first, then A (out of order)
        resolveB!({ blob: () => Promise.resolve(new Blob()) });
        await new Promise((r) => setTimeout(r, 0));

        resolveA!({ blob: () => Promise.resolve(new Blob()) });
        await new Promise((r) => setTimeout(r, 0));

        // Only B's overlay should be posted (A is stale and dropped)
        const overlayMsgs = messages.filter((m) => m.type === "setOverlay");
        expect(overlayMsgs).toHaveLength(1);

        // Shadow state should reflect B (the latest call)
        const opts = chart.getOptions();
        expect((opts.overlay!.items[0] as any).src).toBe("http://b.png");
        chart.destroy();
      } finally {
        if (prevIB === undefined) delete (globalThis as any).ImageBitmap;
        else (globalThis as any).ImageBitmap = prevIB;
        (globalThis as any).fetch = prevFetch;
        (globalThis as any).createImageBitmap = prevCIB;
      }
    });

    it("resolves a superseded setOverlay update without installing it", async () => {
      class FakeImageBitmap {}

      vi.stubGlobal("ImageBitmap", FakeImageBitmap);
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => new FakeImageBitmap()),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            }),
        ),
      );

      const { chart, messages } = setup();
      const superseded = chart.setOverlay({
        items: [
          {
            kind: "image",
            src: "https://example.test/slow.png",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
          },
        ],
      });
      await chart.setOverlay({
        items: [{ kind: "rect", x: 0, y: 0, width: 10, height: 10 }],
      });
      await expect(superseded).resolves.toBeUndefined();

      const overlayMessages = messages.filter((message) => message.type === "setOverlay");
      expect(overlayMessages).toHaveLength(1);
      expect(overlayMessages[0]?.overlay.items).toEqual([
        expect.objectContaining({ kind: "rect" }),
      ]);
      chart.destroy();
    });

    it("resolves an unresolved setOverlay update when the chart is destroyed", async () => {
      vi.stubGlobal("createImageBitmap", vi.fn());
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            }),
        ),
      );

      const { chart } = setup();
      const pending = chart.setOverlay({
        items: [
          {
            kind: "image",
            src: "https://example.test/slow.png",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
          },
        ],
      });
      chart.destroy();
      await expect(pending).resolves.toBeUndefined();
    });

    it("updates shadow state for overlay", () => {
      const { chart } = setup();

      chart.updateAppearance({
        overlay: {
          items: [{ kind: "rect" as const, x: 10, y: 20, width: 100, height: 50 }],
        },
      });

      const opts = chart.getOptions();
      expect(opts.overlay!.items).toHaveLength(1);
      expect((opts.overlay!.items[0] as any).x).toBe(10);
      chart.destroy();
    });
  });
});
