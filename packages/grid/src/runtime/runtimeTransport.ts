import { createGridRuntimeEngine } from "./gridRuntimeEngine.js";
import type {
  GridRuntimeInputMessage,
  GridRuntimeOutputMessage,
  GridRuntimeTransport,
} from "./runtimeProtocol.js";

/** Worker-shaped main-thread fallback for the canonical runtime engine. */
export class InlineGridRuntimeTransport implements GridRuntimeTransport {
  onmessage: ((event: MessageEvent<GridRuntimeOutputMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  private terminated = false;
  private readonly engine = createGridRuntimeEngine({
    postMessage: (message, transfer = []) => this.deliver(message, transfer),
  });

  postMessage(message: GridRuntimeInputMessage, transfer: Transferable[] = []): void {
    if (this.terminated) return;
    // Match Worker.postMessage: sender-side serialization failures throw
    // synchronously so the owning operation can reject without killing the
    // entire runtime transport.
    const cloned = structuredClone(message, { transfer });
    queueMicrotask(() => {
      if (this.terminated) return;
      try {
        this.engine.handleMessage(cloned);
      } catch (error) {
        this.onerror?.(
          new ErrorEvent("error", {
            error,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
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

  private deliver(message: GridRuntimeOutputMessage, transfer: Transferable[]): void {
    const cloned = structuredClone(message, { transfer });
    queueMicrotask(() => {
      if (this.terminated) return;
      this.onmessage?.(new MessageEvent("message", { data: cloned }));
    });
  }
}

export function bindGridRuntimeTransport(
  transport: GridRuntimeTransport,
  handlers: {
    readonly message: (message: GridRuntimeOutputMessage) => void;
    readonly error: (error: Error) => void;
  },
): void {
  transport.onmessage = (event) => handlers.message(event.data);
  transport.onerror = (event) =>
    handlers.error(event.error instanceof Error ? event.error : new Error(event.message));
  transport.onmessageerror = () =>
    handlers.error(new Error("The Grid runtime transport could not deserialize a message."));
}
