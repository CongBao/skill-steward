import {
  MoonStar,
  ScanLine,
  Sun,
  SunMoon
} from "lucide-react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "../components/Sidebar.js";
import {
  ScanProvider,
  ScanStatusAlert,
  useScan
} from "../features/scan/ScanProvider.js";
import { useI18n } from "../i18n/catalog.js";
import { usePreferences, type ThemePreference } from "../theme/preferences.js";

const themeOrder: ThemePreference[] = ["system", "light", "dark"];

function AppShellContent() {
  const { locale, t } = useI18n();
  const { preferences, update } = usePreferences();
  const scan = useScan();
  const nextTheme = themeOrder[(themeOrder.indexOf(preferences.theme) + 1) % themeOrder.length] ?? "system";
  const ThemeIcon = preferences.theme === "light" ? Sun : preferences.theme === "dark" ? MoonStar : SunMoon;
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>{t("app.name")}</span>
          <span className="brand-context">/ {t("app.local")}</span>
        </div>
        <div className="top-actions">
          <button
            className="button"
            type="button"
            onClick={() => update({ locale: locale === "en-US" ? "zh-CN" : "en-US" })}
          >
            {locale === "en-US" ? t("locale.switchToChinese") : t("locale.switchToEnglish")}
          </button>
          <button
            className="button"
            type="button"
            aria-label={t(`theme.${preferences.theme}`)}
            title={t(`theme.${preferences.theme}`)}
            onClick={() => update({ theme: nextTheme })}
          >
            <ThemeIcon size={16} aria-hidden="true" />
          </button>
          <button
            className="button primary"
            type="button"
            aria-label={t("app.scanNow")}
            disabled={scan.isPending}
            onClick={scan.run}
          >
            <ScanLine size={16} aria-hidden="true" />
            <span className="button-label">
              {scan.isPending ? t("app.scanning") : t("app.scanNow")}
            </span>
          </button>
        </div>
      </header>
      <div className="global-scan-status"><ScanStatusAlert /></div>
      <div className="workspace">
        <Sidebar />
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}

export function AppShell() {
  return <ScanProvider><AppShellContent /></ScanProvider>;
}
