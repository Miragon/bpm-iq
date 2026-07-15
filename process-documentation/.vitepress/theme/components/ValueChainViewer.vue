<script setup lang="ts">
// Interim SVG renderer for *.vc.json (schemaVersion 1).
// Swap for @miragon/value-chain-renderer once it is published to npm —
// same pattern as WardleyViewer/TeamTopologyViewer.
import { computed } from "vue";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Element {
  id: string;
  name: string;
  elementType: "step" | "orgUnit";
  bounds: Bounds;
}
interface Connection {
  id: string;
  connectionType: string;
  source: string;
  target: string;
  waypoints: { x: number; y: number }[];
}

const props = defineProps<{ json: string }>();

const model = computed(() => {
  try {
    return JSON.parse(props.json) as { elements: Element[]; connections: Connection[]; meta?: { name?: string } };
  } catch {
    return null;
  }
});

const PAD = 24;
const viewBox = computed(() => {
  const els = model.value?.elements ?? [];
  if (els.length === 0) return "0 0 400 100";
  const xs = els.flatMap((e) => [e.bounds.x, e.bounds.x + e.bounds.width]);
  const ys = els.flatMap((e) => [e.bounds.y, e.bounds.y + e.bounds.height]);
  const minX = Math.min(...xs) - PAD;
  const minY = Math.min(...ys) - PAD;
  return `${minX} ${minY} ${Math.max(...xs) + PAD - minX} ${Math.max(...ys) + PAD - minY}`;
});

/** Chevron polygon in the style of the Value Chain Modeler's step shape. */
function chevronPoints(b: Bounds): string {
  const notch = Math.min(18, b.width / 4);
  return [
    [b.x, b.y],
    [b.x + b.width - notch, b.y],
    [b.x + b.width, b.y + b.height / 2],
    [b.x + b.width - notch, b.y + b.height],
    [b.x, b.y + b.height],
    [b.x + notch, b.y + b.height / 2],
  ]
    .map((p) => p.join(","))
    .join(" ");
}

function polyline(c: Connection): string {
  return c.waypoints.map((w) => `${w.x},${w.y}`).join(" ");
}
</script>

<template>
  <div class="model-viewer">
    <div v-if="!model" class="viewer-error">Value chain file is not valid JSON.</div>
    <svg v-else :viewBox="viewBox" class="vc-svg" role="img" :aria-label="model.meta?.name">
      <defs>
        <marker
          id="vc-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" class="vc-arrowhead" />
        </marker>
      </defs>
      <polyline
        v-for="c in model.connections"
        :key="c.id"
        :points="polyline(c)"
        class="vc-connection"
        marker-end="url(#vc-arrow)"
      />
      <g v-for="e in model.elements" :key="e.id">
        <polygon v-if="e.elementType === 'step'" :points="chevronPoints(e.bounds)" class="vc-step" />
        <ellipse
          v-else
          :cx="e.bounds.x + e.bounds.width / 2"
          :cy="e.bounds.y + e.bounds.height / 2"
          :rx="e.bounds.width / 2"
          :ry="e.bounds.height / 2"
          class="vc-orgunit"
        />
        <text :x="e.bounds.x + e.bounds.width / 2" :y="e.bounds.y + e.bounds.height / 2" class="vc-label">
          {{ e.name }}
        </text>
      </g>
    </svg>
    <div class="viewer-hint">
      Value chain — interim SVG rendering (switches to @miragon/value-chain-renderer once published)
    </div>
  </div>
</template>

<style scoped>
.vc-svg {
  display: block;
  width: 100%;
  max-height: 320px;
  padding: 8px 0;
}
.vc-step {
  fill: var(--vp-c-brand-soft);
  stroke: var(--vp-c-brand-1);
  stroke-width: 1.5;
}
.vc-orgunit {
  fill: var(--vp-c-default-soft);
  stroke: var(--vp-c-text-3);
  stroke-width: 1.5;
}
.vc-connection {
  fill: none;
  stroke: var(--vp-c-text-3);
  stroke-width: 1.5;
}
.vc-arrowhead {
  fill: var(--vp-c-text-3);
}
.vc-label {
  fill: var(--vp-c-text-1);
  font-size: 13px;
  text-anchor: middle;
  dominant-baseline: central;
  font-family: var(--vp-font-family-base);
}
</style>
