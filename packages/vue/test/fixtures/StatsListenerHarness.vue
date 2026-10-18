<script setup lang="ts">
import { SixtyfoldLineChart } from "../../src/line.js";
import { SixtyfoldStockChart } from "../../src/stock.js";

defineProps<{
  kind: "line" | "stock";
  listener?: (stats: unknown) => void;
}>();
</script>

<template>
  <SixtyfoldLineChart v-if="kind === 'line'" @stats="listener" />
  <SixtyfoldStockChart v-else @stats="listener" />
</template>
