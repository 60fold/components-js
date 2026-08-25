/// <reference lib="webworker" />

import { buildBenchmarkDataset } from "@grid-interaction/profiles";
import type { GridInteractionGeneratorInput, GridInteractionGeneratorOutput } from "./contracts";

self.onmessage = (event: MessageEvent<GridInteractionGeneratorInput>) => {
  try {
    const request = event.data;
    const generated = buildBenchmarkDataset(request.profile, request.rowScale);
    const buffers = collectArrayBuffers(generated.data);
    const output: GridInteractionGeneratorOutput = {
      type: "generated",
      data: generated.data,
      profile: { ...generated.profile, id: request.profile },
    };
    self.postMessage(output, { transfer: buffers });
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const output: GridInteractionGeneratorOutput = {
      type: "error",
      message: normalized.message,
      stack: normalized.stack,
    };
    self.postMessage(output);
  }
};

function collectArrayBuffers(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (ArrayBuffer.isView(candidate)) {
      if (candidate.buffer instanceof ArrayBuffer) buffers.add(candidate.buffer);
      return;
    }
    if (candidate instanceof ArrayBuffer) {
      buffers.add(candidate);
      return;
    }
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(value);
  return [...buffers];
}
