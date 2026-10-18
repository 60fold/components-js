import { createGridPaintEngine } from "./paintEngine.js";
import {
  serializeGridPaintError,
  type GridPaintInputMessage,
  type GridPaintOutputMessage,
} from "./paintProtocol.js";

export type GridPaintRenderMode = "auto" | "worker" | "main";
export type ResolvedGridPaintRenderMode = "worker" | "main";
export type GridPaintFallbackReason =
  "offscreen-unsupported" | "worker-construction-failed" | "offscreen-transfer-failed" | null;

export interface GridPaintTransport {
  postMessage(message: GridPaintInputMessage, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<GridPaintOutputMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

export interface GridPaintTransportSelection {
  readonly transport: GridPaintTransport;
  readonly renderMode: ResolvedGridPaintRenderMode;
  readonly fallbackReason: GridPaintFallbackReason;
}

export function canUseOffscreenGridPaint(canvas: HTMLCanvasElement): boolean {
  return (
    typeof OffscreenCanvas !== "undefined" &&
    typeof canvas.transferControlToOffscreen === "function" &&
    typeof Worker !== "undefined"
  );
}

export function selectGridPaintTransport(
  canvas: HTMLCanvasElement,
  requestedMode: GridPaintRenderMode,
  createWorker: () => GridPaintTransport,
  createMain: () => GridPaintTransport = () => new InlineGridPaintTransport(),
): GridPaintTransportSelection {
  if (requestedMode === "main") {
    return { transport: createMain(), renderMode: "main", fallbackReason: null };
  }
  if (!canUseOffscreenGridPaint(canvas)) {
    return {
      transport: createMain(),
      renderMode: "main",
      fallbackReason: "offscreen-unsupported",
    };
  }
  try {
    return { transport: createWorker(), renderMode: "worker", fallbackReason: null };
  } catch {
    return {
      transport: createMain(),
      renderMode: "main",
      fallbackReason: "worker-construction-failed",
    };
  }
}

/** Worker-shaped transport for the shared engine's main-thread fallback. */
export class InlineGridPaintTransport implements GridPaintTransport {
  onmessage: ((event: MessageEvent<GridPaintOutputMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  private terminated = false;
  private initialized = false;
  private readonly engine = createGridPaintEngine({
    postMessage: (message) => this.deliver(message),
  });

  postMessage(message: GridPaintInputMessage): void {
    if (this.terminated) return;
    queueMicrotask(() => {
      if (this.terminated) return;
      try {
        this.engine.handleMessage(message);
        if (message.type === "init") this.initialized = true;
      } catch (error) {
        this.deliver({
          type: message.type === "init" || !this.initialized ? "initError" : "runtimeError",
          error: serializeGridPaintError(error),
        });
      }
    });
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.engine.dispose();
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
  }

  private deliver(message: GridPaintOutputMessage): void {
    queueMicrotask(() => {
      if (this.terminated) return;
      this.onmessage?.(new MessageEvent("message", { data: message }));
    });
  }
}
