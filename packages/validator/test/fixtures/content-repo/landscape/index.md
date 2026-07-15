---
title: Landscape
outline: 2
---

<script setup>
import { data } from './landscape.data.ts'
</script>

# Landscape

The strategic context every process links into — four artifacts, four questions.
The identifier contract between these models and `process.yaml` is documented
[here](./README).

## Value chain — _where_ is value created?

<ValueChainViewer :json="data.valueChain" />

## Wardley map — _why_ build, buy, or automate?

<ClientOnly>
  <WardleyViewer :dsl="data.wardley" />
</ClientOnly>

## Team topology — _who_ owns it, how do teams interact?

<ClientOnly>
  <TeamTopologyViewer :json="data.teamTopology" />
</ClientOnly>

## Glossary — the shared language

<table>
  <thead><tr><th>Term</th><th>Definition</th><th>Synonyms</th></tr></thead>
  <tbody>
    <tr v-for="t in data.glossary" :key="t.term">
      <td><strong>{{ t.term }}</strong></td>
      <td>{{ t.definition }}</td>
      <td>{{ (t.synonyms ?? []).join(', ') }}</td>
    </tr>
  </tbody>
</table>
