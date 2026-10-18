import { createGridRuntimeEngine } from "./runtime/gridRuntimeEngine.js";
import type {
  GridRuntimeInputMessage,
  GridRuntimeOutputMessage,
} from "./runtime/runtimeProtocol.js";

const engine = createGridRuntimeEngine({
  postMessage: (message: GridRuntimeOutputMessage, transfer: Transferable[] = []) =>
    self.postMessage(message, { transfer }),
  close: () => self.close(),
});

self.onmessage = (event: MessageEvent<GridRuntimeInputMessage>) => {
  try {
    engine.handleMessage(event.data);
  } catch (error) {
    self.postMessage({
      type: "runtimeError",
      operation: "protocol",
      message: error instanceof Error ? error.message : String(error),
    } satisfies GridRuntimeOutputMessage);
  }
};

self.onmessageerror = () => {
  self.postMessage({
    type: "runtimeError",
    operation: "protocol",
    message: "The Grid runtime worker could not deserialize an incoming message.",
  } satisfies GridRuntimeOutputMessage);
};
