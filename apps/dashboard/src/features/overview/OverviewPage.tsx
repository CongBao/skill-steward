import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { fetchDashboard, runScan, type KpiResult } from "../../api/client.js";
import { KpiCard } from "../../components/KpiCard.js";
import { PageHeader } from "../../components/PageHeader.js";
import { SeverityBadge } from "../../components/SeverityBadge.js";
import { StatePanel } from "../../components/StatePanel.js";
import { useI18n, type TranslationKey } from "../../i18n/catalog.js";
import { usePreferences } from "../../theme/preferences.js";
import "./overview.css";

function kpiLabel(id: string): TranslationKey {
  return `kpi.${id}` as TranslationKey;
}

function formatValue(kpi: KpiResult, locale: string): string {
  if (typeof kpi.value === "number") {
    if (kpi.id === "finding-confidence") return `${kpi.value}%`;
    return new Intl.NumberFormat(locale, {
      notation: kpi.value >= 1_000 ? "compact" : "standard",
      maximumFractionDigits: 1
    }).format(kpi.value);
  }
  if (Array.isArray(kpi.value)) return String(kpi.value.at(-1)?.value ?? 0);
  if ("available" in kpi.value && "total" in kpi.value) {
    return `${kpi.value.available}/${kpi.value.total}`;
  }
  if ("tokens" in kpi.value) {
    return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(
      kpi.value.tokens ?? 0
    );
  }
  return Object.entries(kpi.value).map(([key, value]) => `${key} ${value}`).join(" · ");
}

export function OverviewPage() {
  const { locale, t } = useI18n();
  const { preferences } = usePreferences();
  const queryClient = useQueryClient();
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: fetchDashboard });
  const scan = useMutation({
    mutationFn: runScan,
    onSuccess: (data) => queryClient.setQueryData(["dashboard"], data)
  });

  if (dashboard.isError) {
    return <StatePanel title={t("overview.loadError")} description={String(dashboard.error)} action={<button className="button" onClick={() => dashboard.refetch()}>Retry</button>} />;
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
          action={<button className="button primary" onClick={() => scan.mutate()}>{scan.isPending ? t("app.scanning") : t("overview.firstRun.action")}</button>}
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
        actions={<button className="button primary" onClick={() => scan.mutate()} disabled={scan.isPending}><RefreshCw size={16} />{scan.isPending ? t("app.scanning") : t("app.scanNow")}</button>}
      />
      <div className="scan-freshness">
        <span className="live-dot" /> {t("overview.updated")} {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(dashboard.data.latest?.generatedAt ?? ""))}
      </div>
      <section className="kpi-grid" aria-label="Portfolio KPIs">
        {selected.map((kpi, index) => (
          <KpiCard
            key={kpi.id}
            label={t(kpiLabel(kpi.id))}
            value={formatValue(kpi, locale)}
            status={kpi.status}
            hero={index === 0}
            {...(kpi.comparison
              ? { detail: `${kpi.comparison > 0 ? "+" : ""}${kpi.comparison}` }
              : {})}
          />
        ))}
      </section>
      <section className="overview-panel">
        <header><div><span className="section-eyebrow">Audit queue</span><h2>{t("overview.priority")}</h2></div><span className="count-badge">{dashboard.data.priorityFindings.length}</span></header>
        {dashboard.data.priorityFindings.length ? (
          <div className="finding-list">
            {dashboard.data.priorityFindings.map((finding) => (
              <article className="finding-row" key={finding.id}>
                <SeverityBadge severity={finding.severity} />
                <div><strong>{finding.summary}</strong><code>{finding.code}</code></div>
                <span className="confidence">{Math.round(finding.confidence * 100)}%</span>
              </article>
            ))}
          </div>
        ) : <p className="empty-copy">{t("overview.noFindings")}</p>}
      </section>
    </>
  );
}
