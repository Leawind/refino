import { watchEffect } from "vue";
import { createI18n } from "vue-i18n";
import zh from "./zh";
import en from "./en";
import { store } from "../store";

export const i18n = createI18n({
  legacy: false,
  locale: store.state.locale,
  fallbackLocale: "en",
  messages: { zh, en },
});

// Preference changes made through the settings UI apply immediately.
watchEffect(() => {
  i18n.global.locale.value = store.state.locale;
});
