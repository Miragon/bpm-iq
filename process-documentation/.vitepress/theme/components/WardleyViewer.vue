<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

const props = withDefaults(defineProps<{ dsl: string; height?: number }>(), { height: 560 });
const el = ref<HTMLElement>();
const error = ref("");
let viewer: { destroy(): void } | undefined;

onMounted(async () => {
  try {
    const [{ NavigatedViewer }, { default: CommandModule }] = await Promise.all([
      import("@miragon/wardley-renderer"),
      // wardley-renderer 0.3.0: the read-only viewer's importer resolves `commandStack`
      // but the module list omits diagram-js's command module — provide it explicitly
      // via the documented additionalModules extension point.
      import("diagram-js/lib/command"),
    ]);
    const v = new NavigatedViewer({
      container: el.value!,
      height: props.height,
      additionalModules: [CommandModule],
    });
    viewer = v;
    await v.importDSL(props.dsl);
  } catch (e) {
    error.value = `Wardley map could not be rendered: ${(e as Error).message}`;
  }
});
onUnmounted(() => viewer?.destroy());
</script>

<template>
  <div class="model-viewer">
    <div v-if="error" class="viewer-error">{{ error }}</div>
    <div v-else ref="el" class="viewer-canvas" :style="{ height: `${height}px` }" />
    <div class="viewer-hint">Wardley map (OWM) — rendered by @miragon/wardley-renderer</div>
  </div>
</template>
