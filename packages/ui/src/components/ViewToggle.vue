<script setup lang="ts">
// Canvas presentation switch (ui DESIGN.md, "三维视图"): flips between the
// planar graph and the orbit view. The choice is a persisted canvas config
// entry, so a reload keeps the last view.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NIcon } from "naive-ui";
import { CubeOutline, GridOutline } from "@vicons/ionicons5";
import { injectRequired } from "../context";
import { workspaceKey } from "../workspace";

const workspace = injectRequired(workspaceKey, "workspace");
const { t } = useI18n();

const orbit = computed(() => workspace.state.config.canvasView === "orbit");

function toggle(): void {
  workspace.setConfig({ canvasView: orbit.value ? "planar" : "orbit" });
}
</script>

<template>
  <NButton
    circle
    class="view-toggle"
    :type="orbit ? 'primary' : 'default'"
    :title="orbit ? t('canvas.viewPlanar') : t('canvas.viewOrbit')"
    @click="toggle"
  >
    <NIcon :component="orbit ? GridOutline : CubeOutline" />
  </NButton>
</template>
