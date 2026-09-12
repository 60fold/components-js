import type { DefineComponent } from "vue";

/** Test fixture compiled by Vite's Vue plugin, rather than TypeScript. */
declare const component: DefineComponent<{
  kind: "line" | "stock";
  listener?: (stats: unknown) => void;
}>;

export default component;
