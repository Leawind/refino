<script setup lang="ts">
// Minimal form field: a small label row (with optional trailing extras,
// e.g. the markdown preview toggle) above the control. Hand-rolled instead
// of naive's NFormItem, whose label sizing fights custom layouts.
defineProps<{ label: string }>();
</script>

<template>
  <div class="form-field">
    <div class="label-row">
      <span class="label-text">{{ label }}</span>
      <slot name="extra" />
    </div>
    <div class="control">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.form-field {
  min-width: 0;
}

.label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
  font-size: 12px;
}

.control {
  font-size: 13px;
}
</style>
