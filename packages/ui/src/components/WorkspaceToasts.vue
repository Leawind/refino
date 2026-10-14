<script setup lang="ts">
// Transient workspace notices (range-selection degradation) surface as
// toasts, and the component registers the shared message seam so plain
// modules (node operations) can toast too. Must mount inside
// <NMessageProvider>: useMessage resolves the provider from its own
// component tree, so App itself cannot call it.
import { onBeforeUnmount, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useMessage } from "naive-ui";
import { injectRequired } from "../context";
import { setMessenger, type NoticeType } from "../feedback";
import { workspaceKey } from "../workspace";

const workspace = injectRequired(workspaceKey, "workspace");

const { t } = useI18n();
const message = useMessage();

onMounted(() => {
  setMessenger((text, type: NoticeType) => {
    if (type === "success") message.success(text);
    else if (type === "warning") message.warning(text);
    else if (type === "error") message.error(text);
    else message.info(text);
  });
});
onBeforeUnmount(() => setMessenger(null));

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
