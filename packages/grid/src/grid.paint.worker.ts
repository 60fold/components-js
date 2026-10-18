import { createGridPaintEngine } from "./rendering/paintEngine.js";
import { serializeGridPaintError, type GridPaintInputMessage } from "./rendering/paintProtocol.js";

const engine = createGridPaintEngine({
  postMessage: (message) => self.postMessage(message),
});
let initialized = false;

self.onmessage = (event: MessageEvent<GridPaintInputMessage>) => {
  try {
    engine.handleMessage(event.data);
    if (event.data.type === "init") initialized = true;
  } catch (error) {
    self.postMessage({
      type: event.data.type === "init" || !initialized ? "initError" : "runtimeError",
      error: serializeGridPaintError(error),
    });
  }
};

self.onmessageerror = () => {
  self.postMessage({
    type: initialized ? "runtimeError" : "initError",
    error: serializeGridPaintError(
      new Error("The grid paint worker could not deserialize an incoming message."),
    ),
  });
};
