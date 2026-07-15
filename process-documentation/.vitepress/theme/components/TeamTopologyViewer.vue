<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

const props = withDefaults(defineProps<{ json: string; height?: number }>(), { height: 560 });
const el = ref<HTMLElement>();
const error = ref("");
let viewer: { destroy(): void } | undefined;

onMounted(async () => {
  try {
    const [{ NavigatedViewer }, { parseDocument }] = await Promise.all([
      import("@miragon/team-topologies-renderer"),
      import("@miragon/team-topologies-schema-model"),
    ]);
    const parsed = parseDocument(JSON.parse(props.json));
    if (!parsed.ok) throw new Error(parsed.error);
    const v = new NavigatedViewer({ container: el.value!, height: props.height });
    viewer = v;
    v.importDocument(parsed.document);
  } catch (e) {
    error.value = `Team topology could not be rendered: ${(e as Error).message}`;
  }
});
onUnmounted(() => viewer?.destroy());
</script>

<template>
  <div class="model-viewer">
    <div v-if="error" class="viewer-error">{{ error }}</div>
    <div v-else ref="el" class="viewer-canvas" :style="{ height: `${height}px` }" />
    <div class="viewer-hint">Team topology — rendered by @miragon/team-topologies-renderer</div>
  </div>
</template>
