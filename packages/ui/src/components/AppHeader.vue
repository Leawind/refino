<script setup lang="ts">
// Top navigation bar: logo, title, refresh and global settings. Theme and
// language follow the VitePress pattern: small icon buttons with dropdowns.
import { computed, h } from "vue";
import { useI18n } from "vue-i18n";
import { NDropdown, NIcon } from "naive-ui";
import {
  LanguageOutline,
  MoonOutline,
  SunnyOutline,
  RefreshOutline,
  ChevronDownOutline,
  CheckmarkOutline,
} from "@vicons/ionicons5";
import { store } from "../store";

const { t, locale } = useI18n();

const emit = defineEmits<{ refresh: [] }>();

const isDark = computed(() => store.state.theme === "dark");

function toggleTheme(): void {
  store.setTheme(isDark.value ? "light" : "dark");
}

const localeOptions = computed(() =>
  (["zh", "en"] as const).map((value) => ({
    key: value,
    label: value === "zh" ? "中文" : "English (US)",
    icon:
      locale.value === value
        ? () =>
            h(NIcon, null, {
              default: () => h(CheckmarkOutline),
            })
        : undefined,
  })),
);
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
      <button class="nav-btn" :aria-label="t('app.refresh')" @click="emit('refresh')">
        <NIcon :component="RefreshOutline" />
      </button>
      <button
        class="nav-btn"
        :aria-label="isDark ? t('app.themeLight') : t('app.themeDark')"
        @click="toggleTheme"
      >
        <NIcon :component="isDark ? SunnyOutline : MoonOutline" />
      </button>
      <NDropdown
        :options="localeOptions"
        trigger="hover"
        :value="locale"
        :show-arrow="false"
        placement="bottom"
        @select="store.setLocale($event)"
      >
        <button class="nav-btn" :aria-label="t('app.language')">
          <NIcon :component="LanguageOutline" />
          <NIcon :size="12" class="chevron">
            <ChevronDownOutline />
          </NIcon>
        </button>
      </NDropdown>
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
  align-items: stretch;
  height: 100%;
}

/* Rectangular, header-high icon buttons; hovering recolors the icon only. */
.nav-btn {
  width: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: inherit;
  font: inherit;
  padding: 0;
}

.nav-btn:hover {
  color: var(--refino-primary, #18a058);
}

.chevron {
  opacity: 0.6;
}

.lang-button .chevron {
  margin-left: 2px;
  opacity: 0.6;
}
</style>
