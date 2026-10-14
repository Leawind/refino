<script setup lang="ts">
// Registers the shared confirm seam with naive's dialog API so plain
// modules (node deletion) can raise a confirmation. Must mount inside
// <NDialogProvider> — the same provider-scoping rule as WorkspaceToasts.
import { onBeforeUnmount, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useDialog } from "naive-ui";
import { setConfirmer } from "../feedback";

const { t } = useI18n();
const dialog = useDialog();

onMounted(() => {
  setConfirmer(({ title, content, positiveText, onConfirm }) => {
    dialog.error({
      title,
      content,
      positiveText,
      negativeText: t("node.cancel"),
      closable: true,
      onPositiveClick: () => onConfirm(),
    });
  });
});
onBeforeUnmount(() => setConfirmer(null));
</script>

<template>
  <span hidden />
</template>
