<script setup lang="ts">
// Single renderer for the canvas edge controls: mounts the manifest's
// groups (canvasFloats.ts) into the float layer of each corner, controls
// in registration order. Controls never position themselves.
import type { Component } from "vue";
import { canvasFloatGroups } from "../canvasFloats";
import type { FloatPlacement } from "../types";
import GraphFloat from "./GraphFloat.vue";

// Corners in use — empty groups render no float layer at all.
const placedGroups = (
  Object.entries(canvasFloatGroups) as Array<[FloatPlacement, Component[]]>
).filter(([, components]) => components.length > 0);
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
