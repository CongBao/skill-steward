import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { I18nContext, translation, type Locale } from "../i18n/catalog.js";

export type ThemePreference = "system" | "light" | "dark";
export type SidebarPreference = "auto" | "expanded" | "collapsed";

export interface DashboardPreferencesV1 {
  version: 1;
  locale: Locale;
  theme: ThemePreference;
  sidebar: SidebarPreference;
  showFirstValueGuide: boolean;
  kpiCount: number;
  kpiOrder: string[];
  enabledKpis: string[];
}

export const PREFERENCES_KEY = "skill-steward:preferences";
const recommendedKpis = [
  "health-score",
  "open-findings",
  "installed-skills",
  "estimated-context",
  "harness-coverage",
  "inventory-coverage"
];

const initialLocale: Locale =
  typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")
    ? "zh-CN"
    : "en-US";

export const DEFAULT_PREFERENCES: DashboardPreferencesV1 = {
  version: 1,
  locale: initialLocale,
  theme: "system",
  sidebar: "auto",
  showFirstValueGuide: true,
  kpiCount: 6,
  kpiOrder: recommendedKpis,
  enabledKpis: recommendedKpis
};

export function parsePreferences(value: unknown): DashboardPreferencesV1 {
  if (!value || typeof value !== "object") return DEFAULT_PREFERENCES;
  const input = value as Partial<DashboardPreferencesV1>;
  if (
    input.version !== 1 ||
    (input.locale !== "en-US" && input.locale !== "zh-CN") ||
    !["system", "light", "dark"].includes(input.theme ?? "") ||
    !["auto", "expanded", "collapsed"].includes(input.sidebar ?? "") ||
    (input.showFirstValueGuide !== undefined && typeof input.showFirstValueGuide !== "boolean") ||
    !Number.isInteger(input.kpiCount) ||
    (input.kpiCount ?? 0) < 3 ||
    (input.kpiCount ?? 0) > 17 ||
    !Array.isArray(input.kpiOrder) ||
    !input.kpiOrder.every((item) => typeof item === "string") ||
    !Array.isArray(input.enabledKpis) ||
    !input.enabledKpis.every((item) => typeof item === "string")
  ) {
    return DEFAULT_PREFERENCES;
  }
  return {
    ...(input as DashboardPreferencesV1),
    showFirstValueGuide: input.showFirstValueGuide ?? true
  };
}

export function resolveTheme(
  preference: ThemePreference,
  systemIsDark: boolean
): "light" | "dark" {
  return preference === "system" ? (systemIsDark ? "dark" : "light") : preference;
}

function systemDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

function loadPreferences(): DashboardPreferencesV1 {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    return stored ? parsePreferences(JSON.parse(stored)) : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export interface PreferencesValue {
  preferences: DashboardPreferencesV1;
  update(patch: Partial<Omit<DashboardPreferencesV1, "version">>): void;
  reset(): void;
}

const PreferencesContext = createContext<PreferencesValue>({
  preferences: DEFAULT_PREFERENCES,
  update: () => undefined,
  reset: () => undefined
});

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(loadPreferences);
  const update = (patch: Partial<Omit<DashboardPreferencesV1, "version">>) =>
    setPreferences((current) => parsePreferences({ ...current, ...patch, version: 1 }));
  const reset = () => setPreferences(DEFAULT_PREFERENCES);

  useEffect(() => {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    document.documentElement.lang = preferences.locale;
    document.documentElement.dataset.theme = resolveTheme(preferences.theme, systemDark());
  }, [preferences]);

  const i18n = useMemo(
    () => ({
      locale: preferences.locale,
      t: (key: Parameters<typeof translation>[1]) => translation(preferences.locale, key)
    }),
    [preferences.locale]
  );

  return (
    <PreferencesContext.Provider value={{ preferences, update, reset }}>
      <I18nContext.Provider value={i18n}>{children}</I18nContext.Provider>
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): PreferencesValue {
  return useContext(PreferencesContext);
}
