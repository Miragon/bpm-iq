<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

const props = withDefaults(defineProps<{ xml: string; height?: number }>(), { height: 420 });
const el = ref<HTMLElement>();
const error = ref("");
let viewer: { destroy(): void } | undefined;

onMounted(async () => {
  try {
    const { default: Viewer } = await import("dmn-js/lib/Viewer");
    const v = new Viewer({ container: el.value! });
    viewer = v;
    await v.importXML(props.xml);
    // Open the decision table view when there is one — that's what readers want to see.
    const views = v.getViews();
    const table = views.find((view: { type: string }) => view.type === "decisionTable");
    if (table) await v.open(table);
  } catch (e) {
    error.value = `DMN model could not be rendered: ${(e as Error).message}`;
  }
});
onUnmounted(() => viewer?.destroy());
</script>

<template>
  <div class="model-viewer">
    <div v-if="error" class="viewer-error">{{ error }}</div>
    <div v-else ref="el" class="viewer-canvas" :style="{ height: `${height}px` }" />
    <div class="viewer-hint">
      DMN decision — use the tabs (bottom left) to switch between table and requirements diagram
    </div>
  </div>
</template>
