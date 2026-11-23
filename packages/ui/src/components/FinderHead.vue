<script setup lang="ts">
// The finder's head: identity on the left, the few global actions on the
// right. The former top navigation bar dissolved into this row and the
// system menu — chrome that is not about the current node does not get a
// band of its own (ui DESIGN.md, "布局").
import { computed, h, ref } from "vue";
import { useI18n } from "vue-i18n";
import { NDropdown, NIcon } from "naive-ui";
import {
  ChevronBackOutline,
  HelpCircleOutline,
  LanguageOutline,
  MoonOutline,
  RefreshOutline,
  SearchOutline,
  SunnyOutline,
} from "@vicons/ionicons5";
import { MOD_LABEL } from "../commands";
import { injectRequired } from "../context";
import { toggleHelp } from "../help";
import { openPalette } from "../palette";
import { storeKey } from "../store";
import { workspaceKey } from "../workspace";
import ReviewDrawer from "./ReviewDrawer.vue";

defineEmits<{ collapse: [] }>();

const { t, locale } = useI18n();
const store = injectRequired(storeKey, "store");
const workspace = injectRequired(workspaceKey, "workspace");

const isDark = computed(() => store.state.theme === "dark");
const menuOpen = ref(false);

const icon = (component: unknown) => () => h(NIcon, null, { default: () => h(component as never) });

const menuOptions = computed(() => [
  {
    label: `${t("palette.title")}   ${MOD_LABEL}K`,
    key: "palette",
    icon: icon(SearchOutline),
  },
  { label: t("app.refresh"), key: "refresh", icon: icon(RefreshOutline) },
  { label: t("app.shortcuts"), key: "help", icon: icon(HelpCircleOutline) },
  { type: "divider" as const, key: "divider" },
  {
    label: t("app.language"),
    key: "language",
    icon: icon(LanguageOutline),
    children: [
      { label: `中文${locale.value === "zh" ? "  ✓" : ""}`, key: "zh" },
      { label: `English (US)${locale.value === "en" ? "  ✓" : ""}`, key: "en" },
    ],
  },
]);

function onSelect(key: string): void {
  if (key === "palette") openPalette();
  else if (key === "refresh") void workspace.reload();
  else if (key === "help") toggleHelp();
  else if (key === "zh" || key === "en") store.setLocale(key);
}
</script>

<template>
  <header class="finder-head">
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
    <span class="brand">{{ t("app.title") }}</span>
    <span class="spacer" />
    <ReviewDrawer />
    <button
      class="ui-icon-btn"
      :aria-label="isDark ? t('app.themeLight') : t('app.themeDark')"
      :title="isDark ? t('app.themeLight') : t('app.themeDark')"
      @click="store.setTheme(isDark ? 'light' : 'dark')"
    >
      <NIcon :component="isDark ? SunnyOutline : MoonOutline" />
    </button>
    <NDropdown
      v-model:show="menuOpen"
      trigger="click"
      placement="bottom-end"
      :options="menuOptions"
      @select="onSelect"
    >
      <button class="ui-icon-btn" :aria-label="t('app.settings')" :title="t('app.settings')">
        <svg class="dots" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3" cy="8" r="1.3" fill="currentColor" />
          <circle cx="8" cy="8" r="1.3" fill="currentColor" />
          <circle cx="13" cy="8" r="1.3" fill="currentColor" />
        </svg>
      </button>
    </NDropdown>
    <button
      class="ui-icon-btn"
      :aria-label="t('app.collapse')"
      :title="t('app.collapse')"
      @click="$emit('collapse')"
    >
      <NIcon :component="ChevronBackOutline" />
    </button>
  </header>
</template>

<style scoped>
.finder-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 44px;
  padding: 0 6px 0 12px;
  border-bottom: 1px solid var(--refino-border);
}

.logo {
  width: 18px;
  height: 18px;
  flex: none;
  color: var(--refino-primary);
}

.brand {
  margin-left: 7px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
  user-select: none;
}

.spacer {
  flex: 1;
}

.dots {
  width: 16px;
  height: 16px;
}
</style>
