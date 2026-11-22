<script setup lang="ts">
// Single renderer for the canvas edge controls: mounts the manifest's
// groups (canvasFloats.ts) into the float layer of each corner, controls
// in registration order. Controls never position themselves.
import { computed, type Component } from "vue";
import { canvasFloatGroups } from "../canvasFloats";
import { injectRequired } from "../context";
import type { FloatPlacement } from "../types";
import { workspaceKey } from "../workspace";
import GraphFloat from "./GraphFloat.vue";

const workspace = injectRequired(workspaceKey, "workspace");

// Corners in use — empty groups render no float layer at all; the orbit view
// hides the planar-only controls through the manifest's view filter.
const placedGroups = computed(() =>
  (
    Object.entries(canvasFloatGroups(workspace.state.config.canvasView)) as Array<
      [FloatPlacement, Component[]]
    >
  ).filter(([, components]) => components.length > 0),
);
</script>

<template>
  <GraphFloat
    v-for="[placement, components] in placedGroups"
    :key="placement"
    :placement="placement"
  >
    <component :is="component" v-for="(component, index) in components" :key="index" />
  </GraphFloat>
</template>
