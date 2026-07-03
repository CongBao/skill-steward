import { createContext, useContext } from "react";
import { enUS } from "./en-US.js";
import { zhCN } from "./zh-CN.js";

export type Locale = "en-US" | "zh-CN";
export type TranslationKey = keyof typeof enUS;

const catalogs = { "en-US": enUS, "zh-CN": zhCN };

export interface I18nValue {
  locale: Locale;
  t(key: TranslationKey): string;
}

export const I18nContext = createContext<I18nValue>({
  locale: "en-US",
  t: (key) => enUS[key]
});

export function translation(locale: Locale, key: TranslationKey): string {
  return catalogs[locale][key] ?? enUS[key];
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
