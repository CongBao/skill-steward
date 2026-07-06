import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { fetchDashboard, type KpiResult } from "../../api/client.js";
import { KpiCard } from "../../components/KpiCard.js";
import { formatKpiValue } from "../../components/kpiFormatting.js";
import { PageHeader } from "../../components/PageHeader.js";
import { SeverityBadge } from "../../components/SeverityBadge.js";
import { StatePanel } from "../../components/StatePanel.js";
import { useI18n, type TranslationKey } from "../../i18n/catalog.js";
import { usePreferences } from "../../theme/preferences.js";
import { resolveFindingSkillNames } from "../findings/findingSkills.js";
import { useScan } from "../scan/ScanProvider.js";
import { FirstValueGuide } from "./FirstValueGuide.js";
import "./overview.css";

function kpiLabel(id: string): TranslationKey {
  return `kpi.${id}` as TranslationKey;
}

export function OverviewPage() {
  const { locale, t } = useI18n();
  const { preferences } = usePreferences();
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: fetchDashboard });
  const scan = useScan();

  if (dashboard.isError) {
    return <StatePanel title={t("app.loadError")} description={t("app.loadErrorCopy")} action={<button className="button" onClick={() => dashboard.refetch()}>{t("app.retry")}</button>} />;
  }
  if (!dashboard.data) {
    return <StatePanel title={t("page.overview.title")} description={t("app.scanning")} />;
  }
  if (dashboard.data.status === "first-run") {
    return (
      <>
        <PageHeader title={t("page.overview.title")} description={t("page.overview.description")} />
        <StatePanel
          title={t("overview.firstRun.title")}
          description={t("overview.firstRun.description")}
          action={<button className="button primary" disabled={scan.isPending} onClick={scan.run}>{scan.isPending ? t("app.scanning") : t("overview.firstRun.action")}</button>}
        />
      </>
    );
  }

  if (dashboard.data.latest?.skillCount === 0) {
    return (
      <>
        <PageHeader
          title={t("page.overview.title")}
          description={t("page.overview.description")}
          actions={<button className="button primary" onClick={scan.run} disabled={scan.isPending}><RefreshCw size={16} />{scan.isPending ? t("app.scanning") : t("app.scanNow")}</button>}
        />
        <div className="scan-freshness">
          <span className="live-dot" /> {t("overview.updated")} {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(dashboard.data.latest.generatedAt))}
        </div>
        {preferences.showFirstValueGuide ? <FirstValueGuide /> : null}
        <StatePanel
          title={t("overview.noSkills.title")}
          description={t("overview.noSkills.description")}
          action={<div className="state-actions"><a className="button primary" href="/settings#catalog-sources">{t("overview.noSkills.settingsAction")}</a><a className="button" href="/skills">{t("overview.noSkills.skillsAction")}</a></div>}
        />
      </>
    );
  }

  const byId = new Map(dashboard.data.kpis.map((kpi) => [kpi.id, kpi]));
  const selected = preferences.kpiOrder
    .filter((id) => preferences.enabledKpis.includes(id))
    .slice(0, preferences.kpiCount)
    .flatMap((id) => (byId.get(id) ? [byId.get(id) as KpiResult] : []));

  return (
    <>
      <PageHeader
        title={t("page.overview.title")}
        description={t("page.overview.description")}
        actions={<button className="button primary" onClick={scan.run} disabled={scan.isPending}><RefreshCw size={16} />{scan.isPending ? t("app.scanning") : t("app.scanNow")}</button>}
      />
      <div className="scan-freshness">
        <span className="live-dot" /> {t("overview.updated")} {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(dashboard.data.latest?.generatedAt ?? ""))}
      </div>
      {preferences.showFirstValueGuide ? <FirstValueGuide /> : null}
      <section className="kpi-grid" aria-label="Portfolio KPIs">
        {selected.map((kpi, index) => (
          <KpiCard
            key={kpi.id}
            label={t(kpiLabel(kpi.id))}
            value={formatKpiValue(kpi, locale)}
            status={kpi.status}
            hero={index === 0}
            {...(kpi.comparison
              ? { detail: `${kpi.comparison > 0 ? "+" : ""}${kpi.comparison}` }
              : {})}
          />
        ))}
      </section>
      <section className="overview-panel">
        <header><div><span className="section-eyebrow">{t("overview.auditQueue")}</span><h2>{t("overview.priority")}</h2></div><span className="count-badge">{dashboard.data.priorityFindings.length}</span></header>
        {dashboard.data.priorityFindings.length ? (
          <div className="finding-list">
            {dashboard.data.priorityFindings.map((finding) => {
              const skillNames = resolveFindingSkillNames(finding, dashboard.data.skills);
              return <article className="finding-row" key={finding.id}>
                <SeverityBadge severity={finding.severity} />
                <div><strong>{finding.summary}</strong><code>{finding.code}</code>{skillNames.length > 0 ? <span className="affected-skills">{skillNames.join(", ")}</span> : null}</div>
                <span className="confidence">{Math.round(finding.confidence * 100)}%</span>
              </article>;
            })}
          </div>
        ) : <p className="empty-copy">{t("overview.noFindings")}</p>}
      </section>
    </>
  );
}
