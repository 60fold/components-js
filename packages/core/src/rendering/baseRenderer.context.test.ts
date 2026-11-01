import { describe, expect, it, vi } from "vitest";
import { get2dContext, handleBaseMessage, WorkerState } from "./baseRenderer";

function createTransferredCanvas() {
  const setTransform = vi.fn();
  const context = { setTransform } as unknown as CanvasRenderingContext2D;
  const getContext = vi.fn(() => {
    if (getContext.mock.calls.length > 1) {
      throw new DOMException(
        "OffscreenCanvas.getContext: Cannot update created context to different thread",
        "InvalidStateError",
      );
    }
    return context;
  });
  const canvas = {
    width: 1_330,
    height: 581,
    getContext,
  } as unknown as OffscreenCanvas;
  return { canvas, context, getContext, setTransform };
}

function createInitializedState() {
  const primary = createTransferredCanvas();
  const state = new WorkerState();
  state.canvas = primary.canvas;
  state.ctx = get2dContext(primary.canvas, { alpha: false });
  state.dpr = 2;
  return { state, ...primary };
}

describe("primary canvas context lifetime", () => {
  it("reuses the transferred context across repeated invalidations and resize", () => {
    const { state, context, getContext, setTransform } = createInitializedState();

    for (const dpr of [1, 2, 3]) {
      handleBaseMessage(state, "resize", { width: 665, height: 290, dpr }, 10);
      expect(() => handleBaseMessage(state, "invalidateCache", {}, 10)).not.toThrow();
      expect(state.ctx).toBe(context);
      expect(setTransform).toHaveBeenLastCalledWith(dpr, 0, 0, dpr, 0, 0);
    }

    expect(getContext).toHaveBeenCalledExactlyOnceWith("2d", { alpha: false });
  });

  it("still discards disposable caches and finishes interrupted animations", () => {
    const { state, context } = createInitializedState();
    const plotCache = createTransferredCanvas();
    const previewCache = createTransferredCanvas();
    state.cacheCanvas = plotCache.canvas;
    state.cacheCtx = plotCache.context;
    state.cacheValid = true;
    state.rangePreviewCanvas = previewCache.canvas;
    state.rangePreviewCtx = previewCache.context;
    state.rangePreviewValid = true;
    state.viewportAnimation.active = true;
    state.yAnimation.active = true;
    state.revealProgress = 0.4;

    expect(handleBaseMessage(state, "invalidateCache", {}, 10)).toBe(true);

    expect(state.ctx).toBe(context);
    expect(state.cacheCanvas).toBeNull();
    expect(state.cacheCtx).toBeNull();
    expect(state.cacheValid).toBe(false);
    expect(state.rangePreviewCanvas).toBeNull();
    expect(state.rangePreviewCtx).toBeNull();
    expect(state.rangePreviewValid).toBe(false);
    expect(state.viewportAnimation.active).toBe(false);
    expect(state.yAnimation.active).toBe(false);
    expect(state.revealProgress).toBe(1);
  });

  it("rebuilds a fresh plot cache without reacquiring the primary context", () => {
    const { state, context, getContext } = createInitializedState();
    const firstCache = createTransferredCanvas();
    const nextCache = createTransferredCanvas();
    const createCanvas = vi
      .fn()
      .mockReturnValueOnce(firstCache.canvas)
      .mockReturnValueOnce(nextCache.canvas);
    state.createCanvas = createCanvas;

    state.ensureCache();
    expect(state.cacheCanvas).toBe(firstCache.canvas);
    handleBaseMessage(state, "invalidateCache", {}, 10);
    state.ensureCache();

    expect(state.cacheCanvas).toBe(nextCache.canvas);
    expect(state.cacheCtx).toBe(nextCache.context);
    expect(state.ctx).toBe(context);
    expect(createCanvas).toHaveBeenCalledTimes(2);
    expect(firstCache.getContext).toHaveBeenCalledOnce();
    expect(nextCache.getContext).toHaveBeenCalledOnce();
    expect(getContext).toHaveBeenCalledOnce();
  });

  it("acquires a missing context once, then retains it", () => {
    const { canvas, context, getContext, setTransform } = createTransferredCanvas();
    const state = new WorkerState();
    state.canvas = canvas;
    state.dpr = 2;

    handleBaseMessage(state, "invalidateCache", {}, 10);
    handleBaseMessage(state, "invalidateCache", {}, 10);

    expect(state.ctx).toBe(context);
    expect(getContext).toHaveBeenCalledExactlyOnceWith("2d", { alpha: false });
    expect(setTransform).toHaveBeenCalledTimes(2);
    expect(setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
  });

  it("does not acquire a context before a canvas is installed", () => {
    const state = new WorkerState();

    expect(handleBaseMessage(state, "invalidateCache", {}, 10)).toBe(true);

    expect(state.canvas).toBeNull();
    expect(state.ctx).toBeNull();
  });
});
