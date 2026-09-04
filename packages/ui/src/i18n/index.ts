import { createI18n } from "vue-i18n";
import zh from "./zh";
import en from "./en";
import type { Locale } from "../types";

/** One i18n instance per mounted shell, seeded with the store's locale; the
 * app shell keeps the two in sync when the user switches language. */
export function createRefinoI18n(locale: Locale) {
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: "en",
    messages: { zh, en },
  });
}
