// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createGridColumnLayout } from "../rendering/layout.js";
import type { GridData } from "../types.js";
import { InlineGridRuntimeTransport } from "./runtimeTransport.js";
import type { GridRuntimeOutputMessage } from "./runtimeProtocol.js";

function nextMessage<T extends GridRuntimeOutputMessage["type"]>(
  transport: InlineGridRuntimeTransport,
  type: T,
): Promise<Extract<GridRuntimeOutputMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    transport.onmessage = (event) => {
      if (event.data.type === type) {
        resolve(event.data as Extract<GridRuntimeOutputMessage, { type: T }>);
      } else if (event.data.type === "runtimeError") {
        reject(new Error(event.data.message));
      }
    };
    transport.onerror = (event) => reject(event.error ?? new Error(event.message));
    transport.onmessageerror = () => reject(new Error("messageerror"));
  });
}

describe("InlineGridRuntimeTransport", () => {
  it("emulates a real worker ownership boundary before worker-ingress adoption", async () => {
    const transport = new InlineGridRuntimeTransport();
    await nextMessage(transport, "ready");

    const values = new Float64Array([4, 5, 6]);
    const input: GridData = {
      length: values.length,
      columns: [
        {
          schema: { id: "value", kind: "number" },
          data: { kind: "number", values: { view: values, ownership: "transfer" } },
        },
      ],
    };
    const installed = nextMessage(transport, "installReady");
    transport.postMessage({ type: "install", requestId: 1, dataRevision: 1, data: input }, [
      values.buffer,
    ]);

    expect(values.byteLength).toBe(0);
    await expect(installed).resolves.toMatchObject({
      requestId: 1,
      descriptor: {
        rowCount: 3,
        installResult: {
          buffers: [
            {
              path: "columns[0].data.values",
              requested: "transfer",
              installed: "transferred",
              byteLength: 24,
            },
          ],
        },
      },
    });
    transport.terminate();
  });

  it("throws sender-side serialization failures synchronously without terminating", async () => {
    const transport = new InlineGridRuntimeTransport();
    await nextMessage(transport, "ready");

    expect(() =>
      transport.postMessage({
        type: "install",
        requestId: 1,
        dataRevision: 1,
        data: {
          length: 0,
          columns: [],
          uncloneable: () => undefined,
        } as GridData,
      }),
    ).toThrow();

    const installed = nextMessage(transport, "installReady");
    transport.postMessage({
      type: "install",
      requestId: 2,
      dataRevision: 1,
      data: { length: 0, columns: [] },
    });
    await expect(installed).resolves.toMatchObject({ requestId: 2 });
    transport.terminate();
  });

  it("clones worker summary payloads through the same transferable boundary", async () => {
    const transport = new InlineGridRuntimeTransport();
    await nextMessage(transport, "ready");
    const installed = nextMessage(transport, "installReady");
    transport.postMessage({
      type: "install",
      requestId: 3,
      dataRevision: 7,
      summaryColumnIds: ["value"],
      data: {
        length: 3,
        rowIds: {
          kind: "number",
          values: { view: new Int32Array([10, 20, 30]), ownership: "copy" },
        },
        columns: [
          {
            schema: { id: "value", kind: "number" },
            data: {
              kind: "number",
              values: { view: new Float64Array([4, 9, 6]), ownership: "copy" },
            },
          },
        ],
      },
    });
    const ready = await installed;
    const surfaceReady = nextMessage(transport, "surfaceReady");
    transport.postMessage({
      type: "surface",
      surfaceId: 3,
      commitToken: "surface:3",
      source: "data",
      target: { kind: "install", requestId: 3 },
      revision: {
        datasetId: ready.descriptor.datasetId,
        dataRevision: 7,
        viewRevision: 0,
        presentationRevision: 1,
      },
      viewportWidth: 320,
      viewportHeight: 160,
      pixelRatio: 1,
      scrollTop: 0,
      scrollLeft: 0,
      range: { rows: { start: 0, end: 3 }, columns: { start: 0, end: 1 } },
      layout: {
        rowHeight: 30,
        headerHeight: 38,
        columnWidth: 120,
        overscanRows: 1,
        overscanColumns: 1,
      },
      columnLayout: createGridColumnLayout([120], 1),
      rowNumberWidth: 64,
      rowNumberLabel: "Row number",
      minColumnWidth: 80,
      maxColumnWidth: 640,
      palette: {
        background: "#000",
        alternateBackground: "#010101",
        headerBackground: "#020202",
        line: "#333",
        text: "#fff",
        mutedText: "#aaa",
        accent: "#f90",
        selection: "rgb(255 153 0 / 0.2)",
        fontFamily: "monospace",
      },
      selection: null,
      focusedRowIndex: 0,
      focusedColumnIndex: 0,
    });
    await surfaceReady;
    const published = nextMessage(transport, "published");
    transport.postMessage({
      type: "finalizeSurface",
      surfaceId: 3,
      commitToken: "surface:3",
    });
    await published;

    const summary = nextMessage(transport, "summaryReady");
    transport.postMessage({
      type: "querySummary",
      queryId: 33,
      datasetId: ready.descriptor.datasetId,
      dataRevision: 7,
      viewRevision: 0,
      columnId: "value",
      ranges: new Uint32Array([0, 3]),
    });
    const result = await summary;
    expect(result.kind).toBe("numeric");
    if (result.kind !== "numeric") throw new Error("Expected a numeric summary.");
    expect(Array.from(result.finiteMaximumValues)).toEqual([9]);
    expect(Array.from(result.finiteMaximumViewOrdinals)).toEqual([1]);
    expect(result.finiteMaximumRowIds).toEqual([20]);
    expect(result.ranges.byteLength).toBeGreaterThan(0);
    expect(result.typedPayloadBytes).toBeGreaterThan(0);
    transport.terminate();
  });
});
