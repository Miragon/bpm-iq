<script setup lang="ts">
import { computed } from "vue";
import { useData, withBase } from "vitepress";
import BpmnViewer from "./BpmnViewer.vue";
import DmnViewer from "./DmnViewer.vue";

const { params } = useData();
const p = computed(() => params.value ?? {});
const meta = computed(() => (p.value.meta ?? {}) as Record<string, any>);
const teams = computed(() => (p.value.teams ?? {}) as Record<string, { label: string; type: string }>);

const teamLabel = (id?: string) =>
  id && teams.value[id] ? `${teams.value[id].label} (${teams.value[id].type})` : (id ?? "—");
const docLink = (doc: string) => withBase(`/processes/${p.value.id}/${doc.replace(/\.md$/, "")}`);
</script>

<template>
  <div>
    <div class="badge-row">
      <span class="badge" :class="`status-${meta.status}`">{{ meta.status }}</span>
      <span class="badge">{{ meta.classification }}</span>
      <span class="badge">v{{ meta.version }}</span>
      <span class="badge">reviewed {{ meta.last_reviewed }}</span>
    </div>

    <p>{{ meta.purpose }}</p>

    <div class="process-facts">
      <table>
        <tbody>
          <tr>
            <th>Trigger</th>
            <td>{{ meta.trigger }}</td>
          </tr>
          <tr>
            <th>Outcome</th>
            <td>{{ meta.outcome }}</td>
          </tr>
          <tr>
            <th>Owner</th>
            <td>{{ teamLabel(meta.owner?.team) }} — {{ meta.owner?.role }}</td>
          </tr>
          <tr v-if="meta.participants?.length">
            <th>Participants</th>
            <td>
              <span v-for="(pt, i) in meta.participants" :key="pt.team">
                <template v-if="i > 0">, </template>{{ teamLabel(pt.team) }} · {{ pt.interaction }}
              </span>
            </td>
          </tr>
          <tr v-if="meta.systems?.length">
            <th>Systems</th>
            <td>
              <span v-for="(s, i) in meta.systems" :key="s.name">
                <template v-if="i > 0">, </template>{{ s.name }} <em>({{ s.role }})</em>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <h2>Process model</h2>
    <BpmnViewer :xml="p.bpmnXml" />

    <template v-if="p.subprocesses?.length">
      <h2>Sub-processes</h2>
      <template v-for="sp in p.subprocesses" :key="sp.id">
        <h3>{{ sp.name }}</h3>
        <BpmnViewer :xml="sp.xml" :height="380" />
      </template>
    </template>

    <template v-if="p.decisions?.length">
      <h2>Decisions</h2>
      <template v-for="d in p.decisions" :key="d.id">
        <h3>{{ d.name }}</h3>
        <DmnViewer :xml="d.xml" />
      </template>
    </template>

    <template v-if="meta.kpis?.length">
      <h2>KPIs</h2>
      <table>
        <thead>
          <tr>
            <th>KPI</th>
            <th>Target</th>
            <th>Latest actual</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="k in meta.kpis" :key="k.name">
            <td>{{ k.name }}</td>
            <td>{{ k.target }}</td>
            <td>
              <template v-if="k.actuals?.length"
                >{{ k.actuals[k.actuals.length - 1].value }}
                <em>(as of {{ k.actuals[k.actuals.length - 1].date }})</em></template
              >
              <template v-else>—</template>
            </td>
            <td>{{ k.source ?? "—" }}</td>
          </tr>
        </tbody>
      </table>
    </template>

    <template v-if="meta.exceptions?.length">
      <h2>Exceptions</h2>
      <ul>
        <li v-for="ex in meta.exceptions" :key="ex.name">
          <strong>{{ ex.name }}</strong
          ><template v-if="ex.frequency"> ({{ ex.frequency }})</template> — {{ ex.handling }}
        </li>
      </ul>
    </template>

    <template v-if="meta.docs?.length">
      <h2>Documentation</h2>
      <ul>
        <li v-for="doc in meta.docs" :key="doc">
          <a :href="docLink(doc)">{{ doc }}</a>
        </li>
      </ul>
    </template>

    <template v-if="meta.related_processes?.length">
      <h2>Related processes</h2>
      <ul>
        <li v-for="rp in meta.related_processes" :key="rp.id">
          <strong>{{ rp.id }}</strong> ({{ rp.relationship }})<template v-if="rp.note"> — {{ rp.note }}</template>
        </li>
      </ul>
    </template>
  </div>
</template>
