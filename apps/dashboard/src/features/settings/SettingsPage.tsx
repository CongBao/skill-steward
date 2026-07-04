import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check } from "lucide-react";
import { fetchDashboard } from "../../api/client.js";
import { KpiCard } from "../../components/KpiCard.js";
import { formatKpiValue } from "../../components/kpiFormatting.js";
import { PageHeader } from "../../components/PageHeader.js";
import { useI18n, type TranslationKey } from "../../i18n/catalog.js";
import {
  DEFAULT_PREFERENCES,
  usePreferences
} from "../../theme/preferences.js";
import { CatalogSourcesPanel } from "./CatalogSourcesPanel.js";
import { HarnessIntegrationsPanel } from "./HarnessIntegrationsPanel.js";
import { DataPolicyPanel } from "./DataPolicyPanel.js";
import { InventoryCoveragePanel } from "./InventoryCoveragePanel.js";
import "./settings.css";

const KPI_IDS = ["health-score", "open-findings", "installed-skills", "estimated-context", "harness-coverage", "inventory-coverage", "bundle-size", "tracked-files", "broken-references", "overlap-groups", "parse-failures", "scope-distribution", "portfolio-change", "health-trend", "largest-skill", "root-availability", "finding-confidence"];

export function SettingsPage() {
  const { locale, t } = useI18n();
  const { preferences, update } = usePreferences();
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: fetchDashboard });
  const toggle = (id: string) => {
    const enabled = preferences.enabledKpis.includes(id);
    update({
      enabledKpis: enabled ? preferences.enabledKpis.filter((item) => item !== id) : [...preferences.enabledKpis, id],
      kpiOrder: preferences.kpiOrder.includes(id) ? preferences.kpiOrder : [...preferences.kpiOrder, id]
    });
  };
  const move = (id: string, offset: number) => {
    const order = [...preferences.kpiOrder];
    const from = order.indexOf(id);
    const to = Math.max(0, Math.min(order.length - 1, from + offset));
    if (from < 0 || from === to) return;
    const [item] = order.splice(from, 1);
    if (item) order.splice(to, 0, item);
    update({ kpiOrder: order });
  };
  const restore = () => update({
    kpiCount: DEFAULT_PREFERENCES.kpiCount,
    kpiOrder: DEFAULT_PREFERENCES.kpiOrder,
    enabledKpis: DEFAULT_PREFERENCES.enabledKpis
  });
  const label = (id: string) => t(`kpi.${id}` as TranslationKey);
  const selected = preferences.kpiOrder.filter((id) => preferences.enabledKpis.includes(id));
  const kpisById = new Map((dashboard.data?.kpis ?? []).map((kpi) => [kpi.id, kpi]));

  return (
    <><PageHeader title={t("page.settings.title")} description={t("page.settings.description")} actions={<button className="button" onClick={restore}>{t("settings.restore")}</button>} />
      <div className="settings-layout"><div className="settings-stack">
        <section className="settings-card"><header><h2>{t("settings.appearance")}</h2></header><div className="settings-fields"><label>{t("settings.language")}<select value={preferences.locale} onChange={(event) => update({ locale: event.target.value as "en-US" | "zh-CN" })}><option value="en-US">English</option><option value="zh-CN">中文</option></select></label><label>{t("settings.theme")}<select value={preferences.theme} onChange={(event) => update({ theme: event.target.value as "system" | "light" | "dark" })}><option value="system">{t("theme.system")}</option><option value="light">{t("theme.light")}</option><option value="dark">{t("theme.dark")}</option></select></label><label>{t("settings.sidebar")}<select value={preferences.sidebar} onChange={(event) => update({ sidebar: event.target.value as "auto" | "expanded" | "collapsed" })}><option value="auto">{t("settings.auto")}</option><option value="expanded">{t("settings.expanded")}</option><option value="collapsed">{t("settings.collapsed")}</option></select></label></div></section>
        <InventoryCoveragePanel inventory={dashboard.data?.inventory} loading={dashboard.isLoading} error={dashboard.isError} />
        <HarnessIntegrationsPanel />
        <DataPolicyPanel />
        <CatalogSourcesPanel />
        <section className="settings-card"><header><div><h2>{t("settings.kpis")}</h2><span className="recommended-badge">{t("settings.recommended")}</span></div></header><label className="count-control">{t("settings.visibleCount")}<input aria-label={t("settings.visibleCount")} type="number" min="3" max="17" value={preferences.kpiCount} onChange={(event) => update({ kpiCount: Math.max(3, Math.min(17, Number(event.target.value) || 3)) })} /></label><h3>{t("settings.selected")}</h3><div className="selected-kpis">{selected.map((id, index) => <div key={id}><span>{label(id)}</span><button aria-label={`${t("settings.moveUp")} ${label(id)}`} disabled={!index} onClick={() => move(id, -1)}><ArrowUp size={14} /></button><button aria-label={`${t("settings.moveDown")} ${label(id)}`} disabled={index === selected.length - 1} onClick={() => move(id, 1)}><ArrowDown size={14} /></button></div>)}</div><h3>{t("settings.catalog")}</h3><div className="kpi-catalog">{KPI_IDS.map((id) => <label key={id} data-enabled={preferences.enabledKpis.includes(id)}><input type="checkbox" checked={preferences.enabledKpis.includes(id)} onChange={() => toggle(id)} aria-label={label(id)} /><span className="catalog-check">{preferences.enabledKpis.includes(id) ? <Check size={12} /> : null}</span>{label(id)}</label>)}</div></section>
      </div><aside className="settings-preview"><section className="settings-card sticky"><header><h2>{t("settings.preview")}</h2><span>{preferences.kpiCount}</span></header><div className="preview-grid">{selected.slice(0, preferences.kpiCount).map((id) => {
        const storedKpi = kpisById.get(id);
        const validHealthTimestamps = new Set(
          (dashboard.data?.history ?? [])
            .filter(({ skillCount }) => skillCount > 0)
            .map(({ generatedAt }) => generatedAt)
        );
        const kpi = id === "health-score" && dashboard.data?.latest?.skillCount === 0
          ? undefined
          : id === "health-trend" && storedKpi && Array.isArray(storedKpi.value)
            ? (() => {
                const value = storedKpi.value.filter(({ generatedAt }) =>
                  validHealthTimestamps.has(generatedAt)
                );
                return value.length > 0 ? { ...storedKpi, value } : undefined;
              })()
            : storedKpi;
        return <KpiCard key={id} label={label(id)} value={formatKpiValue(kpi, locale)} status={kpi?.status ?? "neutral"} />;
      })}</div></section></aside></div>
    </>
  );
}
