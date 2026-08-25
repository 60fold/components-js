import { resolve } from "node:path";
import { defineConfig } from "vite";

const buildTarget = ["chrome87", "edge88", "firefox78", "safari15"];

export default defineConfig({
  base: "./",
  publicDir: false,
  worker: { format: "es" },
  build: {
    outDir: "dist",
    target: buildTarget,
    sourcemap: true,
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
