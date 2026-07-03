import { Route, Routes } from "react-router-dom";
import { useI18n, type TranslationKey } from "../i18n/catalog.js";
import { AppShell } from "./AppShell.js";
import { OverviewPage } from "../features/overview/OverviewPage.js";
import { SkillsPage } from "../features/skills/SkillsPage.js";
import { FindingsPage } from "../features/findings/FindingsPage.js";
import { HistoryPage } from "../features/history/HistoryPage.js";
import { SettingsPage } from "../features/settings/SettingsPage.js";
import { PreflightPage } from "../features/preflight/PreflightPage.js";

function Placeholder({ title, description }: { title: TranslationKey; description: TranslationKey }) {
  const { t } = useI18n();
  return (
    <>
      <header className="page-header">
        <div><h1>{t(title)}</h1><p>{t(description)}</p></div>
      </header>
      <section className="placeholder">{t(description)}</section>
    </>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="preflight" element={<PreflightPage />} />
        <Route path="skills" element={<SkillsPage />} />
        <Route path="findings" element={<FindingsPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
