import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import solid from "vite-plugin-solid";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { coverageIncludePatterns, coverageThresholds } from "./scripts/coverage-policy.mjs";

const fromRoot = (path: string) => resolve(import.meta.dirname, path);

const alias = [
  { find: /^@sixtyfold\/core\/(.*)$/, replacement: fromRoot("packages/core/src/$1") },
  { find: "@sixtyfold/core", replacement: fromRoot("packages/core/src/index.ts") },
  { find: /^@sixtyfold\/grid\/(.*)$/, replacement: fromRoot("packages/grid/src/$1") },
  { find: "@sixtyfold/grid", replacement: fromRoot("packages/grid/src/index.ts") },
  { find: /^@sixtyfold\/line\/(.*)$/, replacement: fromRoot("packages/line/src/$1") },
  { find: "@sixtyfold/line", replacement: fromRoot("packages/line/src/index.ts") },
  {
    find: "@sixtyfold/stock/market-layers",
    replacement: fromRoot("packages/stock/src/marketLayers.ts"),
  },
  { find: /^@sixtyfold\/stock\/(.*)$/, replacement: fromRoot("packages/stock/src/$1") },
  { find: "@sixtyfold/stock", replacement: fromRoot("packages/stock/src/index.ts") },
  { find: "@sixtyfold/ssr", replacement: fromRoot("packages/ssr/src/index.ts") },
  { find: "@sixtyfold/themes", replacement: fromRoot("packages/themes/src/index.ts") },
  { find: /^@sixtyfold\/mcp\/(.*)$/, replacement: fromRoot("packages/mcp/src/$1") },
  { find: "@sixtyfold/mcp", replacement: fromRoot("packages/mcp/src/index.ts") },
  { find: "@test/support", replacement: fromRoot("test/support") },
];

const gridBenchmarkAlias = [
  ...alias,
  { find: "@grid-benchmark/types", replacement: fromRoot("packages/grid/src/types.ts") },
];

// One project per framework: the adapter packages need mutually incompatible
// JSX transforms and compiler plugins, so they cannot share a single config.
export default defineConfig({
  test: {
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary", "html"],
      include: coverageIncludePatterns,
      thresholds: coverageThresholds,
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: "engines",
          environment: "jsdom",
          include: ["packages/{core,grid,line,stock,ssr,themes,mcp}/src/**/*.test.ts"],
        },
      },
      {
        resolve: { alias: gridBenchmarkAlias },
        test: {
          name: "grid-benchmarks",
          environment: "node",
          include: ["benchmarks/grid/src/**/*.test.ts", "benchmarks/grid-summary/src/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "invariants",
          environment: "node",
          include: ["test/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "react",
          environment: "jsdom",
          include: ["packages/react/test/**/*.test.tsx"],
        },
      },
      {
        plugins: [vue()],
        resolve: { alias },
        test: {
          name: "vue",
          environment: "jsdom",
          include: ["packages/vue/test/**/*.test.ts"],
        },
      },
      {
        plugins: [solid()],
        resolve: { alias, conditions: ["development", "browser"] },
        test: {
          name: "solid",
          environment: "jsdom",
          include: ["packages/solid/test/**/*.test.tsx"],
        },
      },
      {
        plugins: [svelte({ configFile: false })],
        resolve: { alias, conditions: ["browser"] },
        test: {
          name: "svelte",
          environment: "jsdom",
          include: ["packages/svelte/test/**/*.test.svelte.ts"],
        },
      },
      {
        resolve: { alias },
        // Angular still uses the legacy TypeScript decorator semantics, which
        // oxc does not enable from the package's own tsconfig.lib.json.
        oxc: { decorator: { legacy: true } },
        test: {
          name: "angular",
          environment: "jsdom",
          include: ["packages/angular/test/**/*.test.ts"],
          setupFiles: ["packages/angular/test/setup.ts"],
        },
      },
    ],
  },
});
