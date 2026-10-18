import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Grid } from "./index";
import {
  GRID_INTERNAL_SURFACE_TELEMETRY,
  type GridInternalSurfaceTelemetryOptions,
  type GridSurfaceTelemetryEvent,
} from "./internal/surfaceTelemetry";
import type { GridPaintFrame, GridPaintOutputMessage } from "./rendering/paintProtocol";
import type { GridData, GridOptions, Utf8Buffers } from "./types";

type PaintFailure = "prepare" | "commit" | "unauthorized-present";

interface PostedMessage {
  readonly message: unknown;
  readonly transfer: readonly Transferable[];
}

function cloneInTestRealm<T>(value: T): T {
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    const source = new Uint8Array(value as ArrayBuffer);
    const copy = new ArrayBuffer(source.byteLength);
    new Uint8Array(copy).set(source);
    return copy as T;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as { constructor: { name: string } };
    const constructor = (globalThis as unknown as Record<string, Function>)[view.constructor.name];
    if (typeof constructor !== "function") throw new Error("Unknown typed-array constructor.");
    return Reflect.construct(constructor, [value]) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => cloneInTestRealm(entry)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneInTestRealm(entry)]),
    ) as T;
  }
  return value;
}

class ControlledPaintWorker {
  static instances: ControlledPaintWorker[] = [];
  static failure: PaintFailure = "prepare";

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly posted: PostedMessage[] = [];
  terminated = false;

  constructor() {
    // The first construction is the paint worker. Force the canonical data
    // runtime onto its real inline engine so only paint delivery is controlled.
    if (ControlledPaintWorker.instances.length > 0) {
      throw new Error("controlled runtime-worker construction failure");
    }
    ControlledPaintWorker.instances.push(this);
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.posted.push({ message, transfer });
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "init") {
      queueMicrotask(() => this.emit({ type: "ready" }));
      return;
    }
    if (message.type === ControlledPaintWorker.failure && message.type !== "init") {
      throw new Error(`controlled paint ${message.type} failure`);
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: GridPaintOutputMessage): void {
    this.onmessage?.(new MessageEvent("message", { data: message }));
  }

  messages(type: string): PostedMessage[] {
    return this.posted.filter(({ message }) =>
      Boolean(message && typeof message === "object" && "type" in message && message.type === type),
    );
  }
}

function utf8(values: readonly string[]): Utf8Buffers {
  const encoder = new TextEncoder();
  const chunks = values.map((value) => encoder.encode(value));
  const offsets = new Uint32Array(values.length + 1);
  let length = 0;
  for (let index = 0; index < chunks.length; index++) {
    length += chunks[index]!.length;
    offsets[index + 1] = length;
  }
  const data = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    data.set(chunk, cursor);
    cursor += chunk.length;
  }
  return { offsets: { view: offsets }, data: { view: data } };
}

function fixture(): GridData {
  return {
    length: 4,
    columns: [
      {
        schema: { id: "value", kind: "number" },
        data: { kind: "number", values: { view: new Float64Array([3, 1, 2, 4]) } },
      },
      {
        schema: { id: "label", kind: "text" },
        data: { kind: "text", values: utf8(["row-3", "row-1", "row-2", "row-4"]) },
      },
    ],
  };
}

function host(): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperties(element, {
    clientWidth: { value: 640 },
    clientHeight: { value: 260 },
  });
  document.body.append(element);
  return element;
}

function frame(worker: ControlledPaintWorker): GridPaintFrame {
  const prepare = worker.messages("prepare")[0];
  if (!prepare) throw new Error("Missing controlled paint prepare message.");
  return (prepare.message as { readonly frame: GridPaintFrame }).frame;
}

function prepared(value: GridPaintFrame): GridPaintOutputMessage {
  return {
    type: "prepared",
    frameId: value.frameId,
    commitToken: value.commitToken,
    revision: value.revision,
    paintedCells: value.cellText.length,
    durationMs: 1,
  };
}

function presented(value: GridPaintFrame): GridPaintOutputMessage {
  return {
    type: "presented",
    frameId: value.frameId,
    commitToken: value.commitToken,
    revision: value.revision,
    paintedCells: value.cellText.length,
    durationMs: 1,
  };
}

describe("Grid canonical runtime controlled paint failures", () => {
  let originalTransferDescriptor: PropertyDescriptor | undefined;
  const offscreen = {} as OffscreenCanvas;

  beforeEach(() => {
    ControlledPaintWorker.instances = [];
    ControlledPaintWorker.failure = "prepare";
    vi.stubGlobal("Worker", ControlledPaintWorker);
    vi.stubGlobal("OffscreenCanvas", class OffscreenCanvas {});
    vi.stubGlobal("structuredClone", cloneInTestRealm);
    originalTransferDescriptor = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "transferControlToOffscreen",
    );
    Object.defineProperty(HTMLCanvasElement.prototype, "transferControlToOffscreen", {
      configurable: true,
      value: vi.fn(() => offscreen),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalTransferDescriptor) {
      Object.defineProperty(
        HTMLCanvasElement.prototype,
        "transferControlToOffscreen",
        originalTransferDescriptor,
      );
    } else {
      delete (HTMLCanvasElement.prototype as Partial<HTMLCanvasElement>).transferControlToOffscreen;
    }
    document.body.replaceChildren();
  });

  it.each(["prepare", "commit", "unauthorized-present"] as const)(
    "drops and clears the exact pending surface after a controlled %s failure",
    async (failure) => {
      ControlledPaintWorker.failure = failure;
      const events: GridSurfaceTelemetryEvent[] = [];
      const options: GridOptions & GridInternalSurfaceTelemetryOptions = {
        renderMode: "worker",
        [GRID_INTERNAL_SURFACE_TELEMETRY]: (event) => events.push(event),
      };
      const grid = new Grid(host(), options);
      await grid.initialize();
      expect(grid.getDiagnostics()).toMatchObject({
        renderMode: "worker",
        viewExecutionMode: "main",
      });
      const paintWorker = ControlledPaintWorker.instances[0]!;
      const installation = grid.setData(fixture());

      await vi.waitFor(() => expect(paintWorker.messages("prepare")).toHaveLength(1));
      const pendingFrame = frame(paintWorker);
      const internals = grid as unknown as {
        runtimeSurfaceInFlight: unknown;
        paintInFlight: unknown;
        awaitingRuntimePublication: unknown;
        paintCommitLease: {
          readonly surfaceId: number;
          readonly commitToken: string;
          readonly settled: Promise<void>;
          readonly settle: () => void;
        } | null;
      };

      if (failure !== "prepare") {
        paintWorker.emit(prepared(pendingFrame));
      }
      if (failure === "unauthorized-present") {
        const lease = internals.paintCommitLease!;
        internals.paintCommitLease = {
          ...lease,
          commitToken: `${lease.commitToken}:unauthorized`,
        };
        paintWorker.emit(presented(pendingFrame));
      }

      await expect(installation).rejects.toThrow(
        failure === "unauthorized-present" ? /unauthorized frame/ : `controlled paint ${failure}`,
      );
      await Promise.resolve();
      const surfaceEvents = events.filter(
        (event) => event.type !== "intent" && event.surfaceId === pendingFrame.frameId,
      );
      expect(surfaceEvents.filter((event) => event.type === "dropped")).toEqual([
        expect.objectContaining({ reason: "paint-failure" }),
      ]);
      expect(surfaceEvents.some((event) => event.type === "published")).toBe(false);
      expect(internals.runtimeSurfaceInFlight).toBeNull();
      expect(internals.paintInFlight).toBeNull();
      expect(internals.awaitingRuntimePublication).toBeNull();
      grid.destroy();
    },
  );
});
