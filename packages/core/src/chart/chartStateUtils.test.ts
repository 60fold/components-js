import { describe, expect, it, vi } from "vitest";

import { deepClone, deepMerge } from "./chartStateUtils";

describe("chartStateUtils", () => {
  describe("isPlainObject() boundaries via cloning", () => {
    it("preserves class instances by reference", () => {
      class FakeImageBitmap {}

      const bitmap = new FakeImageBitmap();
      const cloned = deepClone({ bitmap });

      expect(cloned.bitmap).toBe(bitmap);
    });
  });

  describe("deepClone()", () => {
    it("clones top-level arrays recursively", () => {
      const source = [{ color: "#111" }, ["a", { color: "#222" }]];

      const cloned = deepClone(source);

      expect(cloned).toEqual(source);
      expect(cloned).not.toBe(source);
      expect(cloned[0]).not.toBe(source[0]);
      expect(cloned[1]).not.toBe(source[1]);
      expect((cloned[1] as Array<unknown>)[1]).not.toBe((source[1] as Array<unknown>)[1]);
    });

    it("clones null-prototype data without retaining its nested references", () => {
      const source = Object.create(null) as Record<string, unknown>;
      source.color = { value: "#123" };

      const cloned = deepClone(source);

      expect(cloned).toEqual({ color: { value: "#123" } });
      expect(cloned.color).not.toBe(source.color);
    });

    it("drops unsafe keys throughout nested objects and arrays", () => {
      const source = JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true},"safe":{"color":"#123"},"rows":[{"__proto__":{"polluted":true},"constructor":{},"prototype":{},"value":2}]}',
      ) as Record<string, unknown>;

      const cloned = deepClone(source);

      expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype);
      expect(cloned).toEqual({ safe: { color: "#123" }, rows: [{ value: 2 }] });
      expect(Object.getPrototypeOf((cloned.rows as unknown[])[0])).toBe(Object.prototype);
      for (const key of ["__proto__", "constructor", "prototype"]) {
        expect(Object.prototype.hasOwnProperty.call(cloned, key)).toBe(false);
      }
    });

    it.each(["__proto__", "constructor", "prototype"])(
      "does not read an unsafe %s getter",
      (key) => {
        const getter = vi.fn(() => {
          throw new Error("unsafe getter was read");
        });
        const source = Object.defineProperty({ color: "#123" }, key, {
          enumerable: true,
          get: getter,
        });

        expect(deepClone(source)).toEqual({ color: "#123" });
        expect(getter).not.toHaveBeenCalled();
      },
    );
  });

  describe("deepMerge()", () => {
    it("does not mutate Object.prototype while still merging safe siblings", () => {
      const target = { legend: { color: "#123", visible: true } };
      const source = JSON.parse(
        '{"__proto__":{"__sixtyfoldMergePolluted":true},"legend":{"color":"#456"}}',
      ) as Record<string, unknown>;

      try {
        deepMerge(target, source);

        expect(Object.prototype).not.toHaveProperty("__sixtyfoldMergePolluted");
        expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
        expect(target.legend).toEqual({ color: "#456", visible: true });
      } finally {
        delete (Object.prototype as Record<string, unknown>).__sixtyfoldMergePolluted;
      }
    });

    it.each(["__proto__", "constructor", "prototype"])(
      "does not read an unsafe %s getter while merging safe siblings",
      (key) => {
        const getter = vi.fn(() => {
          throw new Error("unsafe getter was read");
        });
        const source = Object.defineProperty({ color: "#456" }, key, {
          enumerable: true,
          get: getter,
        });
        const target = { color: "#123" };

        deepMerge(target, source);

        expect(target).toEqual({ color: "#456" });
        expect(getter).not.toHaveBeenCalled();
      },
    );

    it("drops unsafe keys when cloning replacement objects and arrays", () => {
      const target: Record<string, unknown> = { legend: { visible: true } };
      const source = JSON.parse(
        '{"legend":{"constructor":{},"prototype":{},"color":"#123"},"rows":[{"__proto__":{"polluted":true},"constructor":{},"prototype":{},"value":2}]}',
      ) as Record<string, unknown>;

      deepMerge(target, source);

      expect(target).toEqual({ legend: { visible: true, color: "#123" }, rows: [{ value: 2 }] });
      expect(Object.getPrototypeOf((target.rows as unknown[])[0])).toBe(Object.prototype);
    });

    it("replaces inherited target objects without mutating them", () => {
      const inheritedLegend = { color: "#123", visible: true };
      const target = Object.create({ legend: inheritedLegend }) as Record<string, unknown>;

      deepMerge(target, { legend: { color: "#456" } });

      expect(inheritedLegend).toEqual({ color: "#123", visible: true });
      expect(target.legend).toEqual({ color: "#456" });
      expect(Object.prototype.hasOwnProperty.call(target, "legend")).toBe(true);
    });

    it("does not retain object references when replacing a scalar with an object", () => {
      const target: Record<string, unknown> = { chartBackground: "#050505" };
      const noirBackground = {
        type: "gradient",
        direction: "vertical",
        colors: ["#050505", "#151515", "#080808"],
      };

      deepMerge(target, { chartBackground: noirBackground });

      expect(target.chartBackground).toEqual(noirBackground);
      expect(target.chartBackground).not.toBe(noirBackground);
    });

    it("does not mutate previously merged source objects on later merges", () => {
      const target: Record<string, unknown> = { chartBackground: "#050505" };
      const noirBackground = {
        type: "gradient",
        direction: "vertical",
        colors: ["#050505", "#151515", "#080808"],
      };
      const technicolorBackground = {
        type: "gradient",
        direction: "vertical",
        colors: ["#12061d", "#2b1452", "#a32c5a", "#ff914d"],
        offsets: [0, 0.34, 0.74, 1],
      };

      deepMerge(target, { chartBackground: noirBackground });
      deepMerge(target, { chartBackground: technicolorBackground });

      expect(noirBackground).toEqual({
        type: "gradient",
        direction: "vertical",
        colors: ["#050505", "#151515", "#080808"],
      });
      expect("offsets" in noirBackground).toBe(false);
    });
  });
});
