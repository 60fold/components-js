// @vitest-environment node

import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  COMPONENTS,
  diagnoseChart,
  FRAMEWORKS,
  generateIntegration,
  recommendPackages,
  recommendPackagesForVersion,
  recommendPerformanceSettings,
  validateChartOptions,
} from "./guidance.js";

function scriptSource(
  code: string,
  framework: (typeof FRAMEWORKS)[number],
): { source: string; kind: ts.ScriptKind } {
  if (framework === "vue" || framework === "svelte") {
    const match = code.match(/<script(?:\s+setup)?\s+lang="ts">([\s\S]*?)<\/script>/u);
    if (!match) throw new Error(`Generated ${framework} integration has no TypeScript script`);
    return { source: match[1], kind: ts.ScriptKind.TS };
  }
  return {
    source: code,
    kind: framework === "react" || framework === "solid" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  };
}

function expectSafeSfcEnvelope(code: string, framework: (typeof FRAMEWORKS)[number]): void {
  if (framework !== "vue" && framework !== "svelte") return;
  expect(code.match(/<script\b/giu)).toHaveLength(1);
  expect(code.match(/<\/script>/giu)).toHaveLength(1);
  const withoutScript = code.replace(/<script\b[^>]*>[\s\S]*?<\/script>/iu, "");
  expect(withoutScript).not.toMatch(/<\/?script\b/iu);
}

describe("@sixtyfold/mcp guidance", () => {
  it("recommends only the requested engine and wrapper", () => {
    const result = recommendPackages({ component: "line", framework: "react" });
    expect(result.packages).toEqual(["@sixtyfold/line", "@sixtyfold/react"]);
    expect(result.installCommand).not.toContain("@sixtyfold/stock");
  });

  it("uses the next channel for prerelease installs and the default channel for stable installs", () => {
    const input = { component: "line" as const, framework: "react" as const };

    expect(recommendPackagesForVersion(input, "1.0.0-rc.2").installCommand).toBe(
      "pnpm add @sixtyfold/line@next @sixtyfold/react@next",
    );
    expect(recommendPackagesForVersion(input, "1.0.0").installCommand).toBe(
      "pnpm add @sixtyfold/line @sixtyfold/react",
    );
  });

  it("generates imports exercised by framework examples", () => {
    const result = generateIntegration({
      component: "stock",
      framework: "svelte",
      renderMode: "auto",
    });
    expect(result.code).toContain('from "@sixtyfold/svelte/stock"');
    expect(result.code).toContain("timestamp: new Float64Array");
  });

  it.each(COMPONENTS)("defaults to vanilla lifecycle guidance for %s", (component) => {
    expect(generateIntegration({ component })).toEqual(
      generateIntegration({ component, framework: "vanilla" }),
    );
  });

  it.each(
    COMPONENTS.flatMap((component) =>
      FRAMEWORKS.map((framework) => [component, framework] as const),
    ),
  )("preserves the reduced-motion default in the %s/%s recipe", (component, framework) => {
    const result = generateIntegration({
      component,
      framework,
      renderMode: "auto",
    });

    expect(result.code).not.toContain("animated:");
  });

  it("scaffolds mapped row data into aligned typed arrays", () => {
    const result = generateIntegration({
      component: "line",
      framework: "react",
      dataShape: {
        format: "object-rows",
        timeField: "recorded_at",
        timeUnit: "iso-string",
        valueFields: ["temperature", "humidity"],
        estimatedRows: 2_000_000,
      },
    });
    expect(result.code).toContain('row["recorded_at"]');
    expect(result.code).toContain('row["temperature"]');
    expect(result.code).toContain("Date.parse");
    expect(result.code).toContain("seriesCount: 2");
    expect(result.notes.join(" ")).toContain("dedicated data worker");
  });

  it("scaffolds mapped stock columns", () => {
    const result = generateIntegration({
      component: "stock",
      framework: "vue",
      dataShape: {
        format: "columnar",
        timeField: "time_s",
        timeUnit: "epoch-seconds",
        openField: "o",
        highField: "h",
        lowField: "l",
        closeField: "c",
        volumeField: "v",
      },
    });
    expect(result.code).toContain('source["time_s"][index]');
    expect(result.code).toContain('source["c"][index]');
    expect(result.code).toContain("* 1_000");
  });

  describe.each([
    {
      component: "line" as const,
      dataShape: {
        format: "object-rows" as const,
        timeField: "recorded_at",
        valueFields: ['value"); globalThis.lineInjected = true; //'],
      },
      injectedIdentifier: "lineInjected",
    },
    {
      component: "stock" as const,
      dataShape: {
        format: "columnar" as const,
        timeField: "time",
        openField: "open",
        highField: "high",
        lowField: "low",
        closeField: 'close"); globalThis.stockInjected = true; //',
        volumeField: "volume",
      },
      injectedIdentifier: "stockInjected",
    },
  ])("adversarial $component source fields", ({ component, dataShape, injectedIdentifier }) => {
    it.each(FRAMEWORKS)("remain string data in the %s recipe", (framework) => {
      const result = generateIntegration({
        component,
        framework,
        dataShape,
      });
      expectSafeSfcEnvelope(result.code, framework);
      const generated = scriptSource(result.code, framework);
      const transpiled = ts.transpileModule(generated.source, {
        compilerOptions: {
          jsx: ts.JsxEmit.Preserve,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        reportDiagnostics: true,
      });
      const errors = (transpiled.diagnostics ?? []).filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      );
      expect(errors).toEqual([]);

      const source = ts.createSourceFile(
        `generated-integration.${generated.kind === ts.ScriptKind.TSX ? "tsx" : "ts"}`,
        generated.source,
        ts.ScriptTarget.ES2022,
        true,
        generated.kind,
      );
      const identifiers: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) identifiers.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(identifiers).not.toContain(injectedIdentifier);
    });
  });

  it("rejects source fields that can terminate generated script blocks", () => {
    expect(() =>
      generateIntegration({
        component: "line",
        framework: "vue",
        dataShape: {
          format: "object-rows",
          timeField: "time",
          valueFields: ["value</script><script>globalThis.injected = true"],
        },
      }),
    ).toThrow("Invalid source field name");
    expect(() =>
      generateIntegration({
        component: "stock",
        framework: "svelte",
        dataShape: {
          format: "columnar",
          timeField: "time",
          openField: "open",
          highField: "high",
          lowField: "low",
          closeField: "close</ScRiPt><script>globalThis.injected = true",
          volumeField: "volume",
        },
      }),
    ).toThrow("Invalid source field name");
  });

  it("rejects unknown package recommendation inputs at the runtime boundary", () => {
    expect(() => recommendPackages({ component: "grid" as never })).toThrow(
      "Unknown chart component",
    );
    expect(() => recommendPackages({ component: "line", framework: "ember" as never })).toThrow(
      "Unknown framework",
    );
  });

  it("rejects unknown integration inputs at the runtime boundary", () => {
    expect(() => generateIntegration({ component: "grid" as never })).toThrow(
      "Unknown chart component",
    );
    expect(() => generateIntegration({ component: "line", framework: "ember" as never })).toThrow(
      "Unknown framework",
    );
    expect(() => generateIntegration({ component: "line", renderMode: "gpu" as never })).toThrow(
      "Unknown render mode",
    );
  });

  it("checks public LOD bounds and unknown options", () => {
    expect(() => validateChartOptions("grid" as never, {})).toThrow("Unknown chart component");

    const invalid = validateChartOptions("line", {
      lod: { density: 4, rebaseRatio: 1.25 },
      madeUp: true,
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.unknownKeys).toEqual(["madeUp"]);
    expect(invalid.errors.join(" ")).toContain("between 0.25 and 2");

    const valid = validateChartOptions("line", {
      renderMode: "auto",
      yDomain: { min: 0, max: 100 },
      lod: {
        mode: "adaptive",
        density: 0.5,
        rebaseRatio: 1.25,
        quantizationStep: 0.25,
      },
    });
    expect(valid.valid).toBe(true);

    const invalidDomain = validateChartOptions("stock", {
      yDomain: { min: 100, max: 0 },
    });
    expect(invalidDomain.valid).toBe(false);
    expect(invalidDomain.errors.join(" ")).toContain("yDomain.max must be greater");
  });

  it("uses the documented lower density for expensive range work", () => {
    const result = recommendPerformanceSettings({
      component: "line",
      points: 5_000_000,
      series: 4,
      rangeSeries: 1,
    });
    expect(result.lod?.density).toBe(0.25);
    expect(result.caveat).toContain("design target");
  });

  it("rejects unknown components in performance recommendations", () => {
    expect(() =>
      recommendPerformanceSettings({
        component: "grid" as never,
        points: 1_000,
      }),
    ).toThrow("Unknown chart component: grid");
  });

  it("returns focused diagnosis for LOD transitions", () => {
    const result = diagnoseChart({
      component: "line",
      symptom: "The view jumps abruptly after zoom animation",
    });
    expect(result.join(" ")).toContain("setLODOptions");
  });

  it("uses the generated failure-mode registry for diagnostics", () => {
    const result = diagnoseChart({
      component: "stock",
      symptom: "The canvas is blank and has zero height",
    });
    expect(result.join(" ")).toContain("getBoundingClientRect");
    expect(result.join(" ")).toContain("min-height");
  });

  it("rejects unknown components in diagnostics", () => {
    expect(() =>
      diagnoseChart({
        component: "grid" as never,
        symptom: "The view is blank",
      }),
    ).toThrow("Unknown chart component: grid");
  });
});
