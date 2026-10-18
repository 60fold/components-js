import { afterEach, describe, expect, it, vi } from "vitest";
import { createLineChartEngine, type LineChartEngine } from "./lineRenderer.js";

const pollutionKey = "sixtyfoldRendererPollution";
const engines: LineChartEngine[] = [];

function createHarness() {
  const marker: Record<string, unknown> = { shape: "circle", glow: { blur: 4 } };
  const engine = createLineChartEngine({ postMessage: () => {} }, { ssr: true });
  engines.push(engine);
  engine.handleMessage("updateSeriesAppearance", { index: 0, patch: { marker } });
  return { engine, marker };
}

function applyPatch(engine: LineChartEngine, patch: Record<string, unknown>) {
  engine.handleMessage("updateSeriesAppearance", { index: 0, patch });
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.handleMessage("stop", {});
  Reflect.deleteProperty(Object.prototype, pollutionKey);
});

describe("line renderer appearance merge", () => {
  it.each(["root", "marker", "glow"])(
    "does not merge JSON __proto__ keys at the %s level into Object.prototype",
    (level) => {
      const { engine, marker } = createHarness();
      const glow = marker.glow;
      const malicious = JSON.parse(`{"__proto__":{"${pollutionKey}":true}}`);
      const patch =
        level === "root"
          ? malicious
          : level === "marker"
            ? { marker: malicious }
            : { marker: { glow: malicious } };
      const before = JSON.stringify(patch);

      applyPatch(engine, patch);

      expect(Object.hasOwn(Object.prototype, pollutionKey)).toBe(false);
      expect(Object.getPrototypeOf(marker)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(glow)).toBe(Object.prototype);
      expect(JSON.stringify(patch)).toBe(before);
      expect(engine.getMarkerConfig(0)).toMatchObject({ shape: "circle", glow: { blur: 4 } });
    },
  );

  it.each(["__proto__", "constructor", "prototype"])(
    "skips %s before reading the source value at each merged level",
    (key) => {
      for (const level of ["root", "marker", "glow"]) {
        const { engine, marker } = createHarness();
        const read = vi.fn(() => {
          throw new Error("Unsafe property must not be evaluated");
        });
        const malicious = Object.defineProperty({}, key, { enumerable: true, get: read });
        const patch =
          level === "root"
            ? malicious
            : level === "marker"
              ? { marker: malicious }
              : { marker: { glow: malicious } };

        expect(() => applyPatch(engine, patch)).not.toThrow();
        expect(read).not.toHaveBeenCalled();
        expect(Object.hasOwn(marker, key)).toBe(false);
        expect(Object.hasOwn(marker.glow as object, key)).toBe(false);
      }
    },
  );

  it.each(["constructor", "prototype"])(
    "ignores JSON %s branches without changing chart object prototypes",
    (key) => {
      const { engine, marker } = createHarness();
      const patch = JSON.parse(
        `{"marker":{"${key}":{"prototype":{"${pollutionKey}":true}},"glow":{"${key}":{"${pollutionKey}":true}}}}`,
      );
      const before = JSON.stringify(patch);

      applyPatch(engine, patch);

      expect(Object.hasOwn(marker, key)).toBe(false);
      expect(Object.hasOwn(marker.glow as object, key)).toBe(false);
      expect(Object.hasOwn(Object.prototype, pollutionKey)).toBe(false);
      expect(Object.getPrototypeOf(marker)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(marker.glow)).toBe(Object.prototype);
      expect(JSON.stringify(patch)).toBe(before);
    },
  );

  it("also protects the chart-wide marker merge", () => {
    const { engine } = createHarness();
    const glow = { blur: 7 };
    engine.handleMessage("updateAppearance", { patch: { marker: { shape: "diamond", glow } } });
    const patch = JSON.parse(
      `{"marker":{"__proto__":{"${pollutionKey}":true},"glow":{"__proto__":{"${pollutionKey}":true},"color":"#123456"}}}`,
    );
    const before = JSON.stringify(patch);

    engine.handleMessage("updateAppearance", { patch });

    expect(Object.hasOwn(Object.prototype, pollutionKey)).toBe(false);
    expect(Object.getPrototypeOf(glow)).toBe(Object.prototype);
    expect(glow).toEqual({ blur: 7, color: "#123456" });
    expect(JSON.stringify(patch)).toBe(before);
  });

  it("blocks later attacks against newly assigned nested objects without cloning safe branches", () => {
    const { engine, marker } = createHarness();
    const fillColor = JSON.parse(
      `{"colors":["#123456","#abcdef"],"__proto__":{"${pollutionKey}":true}}`,
    );
    const before = JSON.stringify(fillColor);
    applyPatch(engine, { marker: { fillColor } });
    expect(marker.fillColor).toBe(fillColor);

    applyPatch(engine, {
      marker: {
        fillColor: JSON.parse(`{"__proto__":{"${pollutionKey}":true}}`),
      },
    });

    expect(Object.hasOwn(Object.prototype, pollutionKey)).toBe(false);
    expect(Object.getPrototypeOf(fillColor)).toBe(Object.prototype);
    expect(JSON.stringify(fillColor)).toBe(before);
  });

  it("continues merging legitimate nested marker settings and replacing arrays", () => {
    const { engine, marker } = createHarness();
    const patch = {
      marker: { size: 8, glow: { color: "#123456", opacity: 0.75, blur: undefined } },
      fillColor: { colors: ["#123456", "#abcdef"] },
    };
    const before = structuredClone(patch);
    applyPatch(engine, patch);
    const replacement = ["#ffffff"];
    applyPatch(engine, { fillColor: { colors: replacement } });

    expect(marker).toMatchObject({
      shape: "circle",
      size: 8,
      glow: { blur: 4, color: "#123456", opacity: 0.75 },
    });
    expect(engine.getMarkerConfig(0)).toMatchObject({
      shape: "circle",
      size: 8,
      glow: { enabled: true, blur: 4, color: "#123456", opacity: 0.75 },
    });
    expect(replacement).toEqual(["#ffffff"]);
    // Only the already-retained fillColor branch receives the second update.
    expect(patch.marker).toEqual(before.marker);
    expect(patch.fillColor.colors).toEqual(replacement);
    expect(patch.fillColor.colors).not.toBe(replacement);
  });
});
