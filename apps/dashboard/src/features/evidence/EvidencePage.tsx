import { useQuery } from "@tanstack/react-query";
import { Activity, Beaker, Database, GitCompareArrows, MessageSquareText } from "lucide-react";
import {
  fetchEvidenceSummary,
  type EvidenceBreakdown,
  type EvidenceMetric
} from "../../api/client.js";
import { KpiCard, type SemanticStatus } from "../../components/KpiCard.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatePanel } from "../../components/StatePanel.js";
import { useI18n, type TranslationKey } from "../../i18n/catalog.js";
import "./evidence.css";

function percentage(metric: EvidenceMetric): string {
  return metric.value === null ? "—" : `${Math.round(metric.value * 100)}%`;
}

function MetricCard({
  label,
  metric,
  denominatorLabel,
  status = "neutral",
  icon
}: {
  label: string;
  metric: EvidenceMetric;
  denominatorLabel: string;
  status?: SemanticStatus;
  icon: React.ReactNode;
}) {
  const { t } = useI18n();
  const detail = t("evidence.metricDetail")
    .replace("{numerator}", String(metric.numerator))
    .replace("{denominator}", String(metric.denominator))
    .replace("{label}", denominatorLabel);
  return (
    <KpiCard
      label={label}
      value={percentage(metric)}
      detail={detail}
      status={status}
      icon={icon}
    />
  );
}

function Comparison({ seven, thirty, label }: { seven: EvidenceMetric; thirty: EvidenceMetric; label: string }) {
  const thirtyValue = thirty.value ?? 0;
  const sevenValue = seven.value ?? 0;
  return (
    <div className="evidence-comparison">
      <svg viewBox="0 0 180 64" role="img" aria-label={label} preserveAspectRatio="none">
        <line x1="8" y1="55" x2="172" y2="55" />
        <rect x="34" y={55 - thirtyValue * 46} width="38" height={thirtyValue * 46} rx="5" />
        <rect className="recent" x="108" y={55 - sevenValue * 46} width="38" height={sevenValue * 46} rx="5" />
      </svg>
      <div><span>30d <strong>{percentage(thirty)}</strong></span><span>7d <strong>{percentage(seven)}</strong></span></div>
    </div>
  );
}

function BreakdownTable({ title, rows, algorithm = false }: { title: string; rows: EvidenceBreakdown[]; algorithm?: boolean }) {
  const { t } = useI18n();
  return (
    <section className="evidence-panel breakdown-panel">
      <header><h2>{title}</h2><span>{rows.length}</span></header>
      {rows.length === 0 ? <p className="muted-copy">{t("evidence.noBreakdown")}</p> : (
        <div className="evidence-table-wrap">
          <table>
            <thead><tr><th>{algorithm ? t("evidence.algorithm") : t("evidence.harness")}</th><th>{t("evidence.preflights")}</th><th>{t("evidence.feedback")}</th><th>{t("evidence.useful")}</th><th>{t("evidence.installConversion")}</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.key}><th>{algorithm ? `v${row.key}` : row.key}</th><td>{row.totals.preflights}</td><td>{percentage(row.metrics.feedbackRate)}</td><td>{percentage(row.metrics.usefulRate)}</td><td>{percentage(row.metrics.installConversion)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const reasonKeys: Record<string, TranslationKey> = {
  "Need 100 labeled preflights": "evidence.reason.labels",
  "Need 30 corrected candidate sets": "evidence.reason.corrections",
  "Need 20 portfolio fingerprints": "evidence.reason.portfolios"
};

const lifecycleReasonKeys: Record<string, TranslationKey> = {
  complete: "evidence.lifecycle.complete",
  abort: "evidence.lifecycle.abort",
  error: "evidence.lifecycle.error",
  timeout: "evidence.lifecycle.timeout",
  other: "evidence.lifecycle.other",
  "user-exit": "evidence.lifecycle.userExit"
};

export function EvidencePage() {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ["evidence", "summary"], queryFn: fetchEvidenceSummary });
  const summary = query.data;
  if (query.isPending) return <StatePanel title={t("evidence.loading")} description={t("evidence.loadingCopy")} />;
  if (query.isError || !summary) return <StatePanel title={t("evidence.error")} description={t("evidence.errorCopy")} />;

  if (summary.totals.preflights === 0 && summary.totals.events === 0) {
    return (
      <>
        <PageHeader title={t("page.evidence.title")} description={t("page.evidence.description")} />
        <StatePanel title={t("evidence.empty")} description={t("evidence.emptyCopy")} />
      </>
    );
  }

  const ready = summary.readiness.status === "ready-for-calibration";
  const lifecycle = Object.entries(summary.lifecycleReasons).sort((left, right) => right[1] - left[1]);
  const lifecycleCount = lifecycle.reduce((total, [, count]) => total + count, 0);
  return (
    <>
      <PageHeader title={t("page.evidence.title")} description={t("page.evidence.description")} />
      <section className="evidence-readiness" data-ready={ready}>
        <div><Beaker size={18} aria-hidden="true" /><div><strong>{ready ? t("evidence.ready") : t("evidence.insufficient")}</strong><p>{ready ? t("evidence.readyCopy") : t("evidence.insufficientCopy")}</p></div></div>
        {!ready ? <ul>{summary.readiness.reasons.map((reason) => <li key={reason}>{reasonKeys[reason] ? t(reasonKeys[reason]) : reason}</li>)}</ul> : null}
      </section>

      <section className="evidence-kpis" aria-label={t("evidence.labelMetrics")}>
        <MetricCard label={t("evidence.feedbackRate")} metric={summary.metrics.feedbackRate} denominatorLabel={t("evidence.preflightDenominator")} icon={<MessageSquareText size={17} />} />
        <MetricCard label={t("evidence.usefulRate")} metric={summary.metrics.usefulRate} denominatorLabel={t("evidence.labelDenominator")} status="positive" icon={<Activity size={17} />} />
        <MetricCard label={t("evidence.correctionF1")} metric={summary.metrics.correctionF1} denominatorLabel={t("evidence.setDecisionDenominator")} icon={<GitCompareArrows size={17} />} />
        <MetricCard label={t("evidence.installConversion")} metric={summary.metrics.installConversion} denominatorLabel={t("evidence.recommendationDenominator")} icon={<Database size={17} />} />
      </section>

      <section className="evidence-grid">
        <section className="evidence-panel trend-panel">
          <header><div><h2>{t("evidence.trend")}</h2><p>{t("evidence.trendCopy")}</p></div></header>
          <Comparison seven={summary.windows.last7Days.metrics.usefulRate} thirty={summary.windows.last30Days.metrics.usefulRate} label={t("evidence.trendAria")} />
          <div className="window-totals"><span>7d · {summary.windows.last7Days.totals.labeled} {t("evidence.labels")}</span><span>30d · {summary.windows.last30Days.totals.labeled} {t("evidence.labels")}</span></div>
        </section>
        <section className="evidence-panel lifecycle-panel">
          <header><div><h2>{t("evidence.lifecycle")}</h2><p>{t("evidence.lifecycleCopy")}</p></div><span>{lifecycleCount}</span></header>
          {lifecycle.length > 0 ? <div className="lifecycle-list">{lifecycle.map(([reason, count]) => <div key={reason}><span>{lifecycleReasonKeys[reason] ? t(lifecycleReasonKeys[reason]) : reason}</span><strong>{count}</strong></div>)}</div> : <p className="muted-copy">{t("evidence.noLifecycle")}</p>}
        </section>
      </section>

      <div className="evidence-breakdowns">
        <BreakdownTable title={t("evidence.harnessBreakdown")} rows={summary.harnesses} />
        <BreakdownTable title={t("evidence.algorithmBreakdown")} rows={summary.algorithms} algorithm />
      </div>

      <section className="evidence-method">
        <strong>{t("evidence.methodTitle")}</strong>
        <p>{t("evidence.methodCopy")}</p>
      </section>
    </>
  );
}
