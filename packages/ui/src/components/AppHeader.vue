<script setup lang="ts">
// Top navigation bar: logo, title, refresh and global settings.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NIcon, NPopselect, NSwitch, NTooltip } from "naive-ui";
import { store } from "../store";

const { t, locale } = useI18n();

const emit = defineEmits<{ refresh: [] }>();

const themeChecked = computed({
  get: () => store.state.theme === "dark",
  set: (dark: boolean) => store.setTheme(dark ? "dark" : "light"),
});

const localeOptions = computed(() => [
  { label: "中文", value: "zh" },
  { label: "English", value: "en" },
]);
</script>

<template>
  <header class="app-header">
    <div class="brand">
      <svg class="logo" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="5" cy="12" r="2.4" fill="currentColor" opacity="0.55" />
        <circle cx="12" cy="6" r="2.4" fill="currentColor" />
        <circle cx="12" cy="18" r="2.4" fill="currentColor" />
        <circle cx="19" cy="12" r="2.4" fill="currentColor" />
        <path
          d="M7 11 10 7.2 M7 13 10 16.8 M13.8 7.2 17 11 M13.8 16.8 17 13"
          stroke="currentColor"
          stroke-width="1.4"
          fill="none"
        />
      </svg>
      <span class="title">{{ t("app.title") }}</span>
      <span class="subtitle">{{ t("app.subtitle") }}</span>
    </div>

    <div class="actions">
      <NTooltip>
        <template #trigger>
          <NButton quaternary circle :aria-label="t('app.refresh')" @click="emit('refresh')">
            <NIcon>
              <svg viewBox="0 0 24 24">
                <path
                  d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h7V4z"
                  fill="currentColor"
                />
              </svg>
            </NIcon>
          </NButton>
        </template>
        {{ t("app.refresh") }}
      </NTooltip>

      <div class="setting">
        <span class="setting-label">{{ t("app.theme") }}</span>
        <NTooltip>
          <template #trigger>
            <NSwitch v-model:value="themeChecked" size="small">
              <template #checked-icon>
                <span class="theme-dot dark" />
              </template>
              <template #unchecked-icon>
                <span class="theme-dot light" />
              </template>
            </NSwitch>
          </template>
          {{ themeChecked ? t("app.themeDark") : t("app.themeLight") }}
        </NTooltip>
      </div>

      <div class="setting">
        <span class="setting-label">{{ t("app.language") }}</span>
        <NPopselect
          :value="locale"
          :options="localeOptions"
          trigger="click"
          @update:value="store.setLocale($event)"
        >
          <NButton quaternary size="small">{{ locale === "zh" ? "中文" : "English" }}</NButton>
        </NPopselect>
      </div>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  height: 100%;
}

.brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.logo {
  width: 22px;
  height: 22px;
  align-self: center;
  color: var(--refino-primary, #18a058);
}

.title {
  font-size: 16px;
  font-weight: 600;
}

.subtitle {
  font-size: 12px;
  opacity: 0.6;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.setting {
  display: flex;
  align-items: center;
  gap: 6px;
}

.setting-label {
  font-size: 12px;
  opacity: 0.6;
}

.theme-dot {
  display: block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.theme-dot.dark {
  background: #1f1f1f;
}

.theme-dot.light {
  background: #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
}
</style>
