import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InlineGridPaintTransport,
  selectGridPaintTransport,
  type GridPaintTransport,
} from "./paintTransport";

function transport(): GridPaintTransport {
  return new InlineGridPaintTransport();
}

describe("grid paint transport selection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("honors explicit main mode without probing worker construction", () => {
    const canvas = document.createElement("canvas");
    const createWorker = vi.fn(transport);
    const main = transport();
    const selection = selectGridPaintTransport(canvas, "main", createWorker, () => main);
    expect(selection).toEqual({ transport: main, renderMode: "main", fallbackReason: null });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("reports unsupported OffscreenCanvas fallback", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const canvas = document.createElement("canvas");
    const main = transport();
    expect(selectGridPaintTransport(canvas, "auto", transport, () => main)).toEqual({
      transport: main,
      renderMode: "main",
      fallbackReason: "offscreen-unsupported",
    });
  });

  it("reports synchronous worker construction failure", () => {
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("Worker", class {});
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "transferControlToOffscreen", { value: vi.fn() });
    const main = transport();
    expect(
      selectGridPaintTransport(
        canvas,
        "worker",
        () => {
          throw new Error("CSP blocked worker");
        },
        () => main,
      ),
    ).toEqual({
      transport: main,
      renderMode: "main",
      fallbackReason: "worker-construction-failed",
    });
  });
});
