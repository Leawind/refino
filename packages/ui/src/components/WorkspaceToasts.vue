<script setup lang="ts">
// Transient workspace notices (range-selection degradation) surface as
// toasts. Must mount inside <NMessageProvider>: useMessage resolves the
// provider from its own component tree, so App itself cannot call it.
import { watch } from "vue";
import { useI18n } from "vue-i18n";
import { useMessage } from "naive-ui";
import { injectRequired } from "../context";
import { workspaceKey } from "../workspace";

const workspace = injectRequired(workspaceKey, "workspace");

const { t } = useI18n();
const message = useMessage();

watch(
  () => workspace.state.notice,
  (notice) => {
    if (notice === null) return;
    message.info(t(`canvas.${notice}`));
    workspace.dismissNotice();
  },
);
</script>

<template>
  <span hidden />
</template>
