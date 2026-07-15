<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

const props = withDefaults(defineProps<{ xml: string; height?: number }>(), { height: 460 });
const el = ref<HTMLElement>();
const error = ref("");
let viewer: { destroy(): void } | undefined;

onMounted(async () => {
  try {
    const { default: NavigatedViewer } = await import("bpmn-js/lib/NavigatedViewer");
    const v = new NavigatedViewer({ container: el.value! });
    viewer = v;
    await v.importXML(props.xml);
    (v.get("canvas") as { zoom(mode: string): void }).zoom("fit-viewport");
  } catch (e) {
    error.value = `BPMN model could not be rendered: ${(e as Error).message}`;
  }
});
onUnmounted(() => viewer?.destroy());
</script>

<template>
  <div class="model-viewer">
    <div v-if="error" class="viewer-error">{{ error }}</div>
    <div v-else ref="el" class="viewer-canvas" :style="{ height: `${height}px` }" />
    <div class="viewer-hint">BPMN 2.0 — drag to pan, scroll to zoom</div>
  </div>
</template>
