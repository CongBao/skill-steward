import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchDashboard, labelFinding } from "../../api/client.js";
import { PageHeader } from "../../components/PageHeader.js";
import { SeverityBadge } from "../../components/SeverityBadge.js";
import { StatePanel } from "../../components/StatePanel.js";
import { useI18n, type TranslationKey } from "../../i18n/catalog.js";
import { resolveFindingSkillNames } from "./findingSkills.js";
import "./findings.css";

export function FindingsPage() {
  const { t } = useI18n();
  const [severity, setSeverity] = useState("all");
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: fetchDashboard });
  const feedback = useMutation({ mutationFn: ({ id, label }: { id: string; label: "useful" | "incorrect" | "unclear" | "already-known" }) => labelFinding(id, label) });
  const findings = (dashboard.data?.priorityFindings ?? []).filter((finding) => severity === "all" || finding.severity === severity);
  const header = <PageHeader title={t("page.findings.title")} description={t("page.findings.description")} actions={<select className="filter-select" value={severity} onChange={(event) => setSeverity(event.target.value)} aria-label={t("findings.all")}><option value="all">{t("findings.all")}</option>{["critical", "error", "warning", "info"].map((level) => <option key={level} value={level}>{t(`severity.${level}` as TranslationKey)}</option>)}</select>} />;
  if (dashboard.isPending) {
    return <>{header}<StatePanel title={t("page.findings.title")} description={t("app.loadingLocalData")} /></>;
  }
  if (dashboard.isError) {
    return <>{header}<StatePanel title={t("app.loadError")} description={t("app.loadErrorCopy")} action={<button className="button" onClick={() => dashboard.refetch()}>{t("app.retry")}</button>} /></>;
  }
  return (
    <>{header}<p className="page-scope-note">{t("findings.priorityLimit")}</p>
      {findings.length ? <div className="findings-grid">{findings.map((finding) => {
        const skillNames = resolveFindingSkillNames(finding, dashboard.data?.skills ?? []);
        return <article className="finding-card" key={finding.id}><header><SeverityBadge severity={finding.severity} /><code>{finding.code}</code><span>{t("findings.confidence")} {Math.round(finding.confidence * 100)}%</span></header><h2>{finding.summary}</h2>{skillNames.length > 0 ? <section><strong>{t("findings.affectedSkills")}</strong><p>{skillNames.join(", ")}</p></section> : null}<section><strong>{t("findings.evidence")}</strong><ul>{finding.evidence.map((item) => <li key={item}><code>{item}</code></li>)}</ul></section><section><strong>{t("findings.recommendation")}</strong><p>{finding.recommendation}</p></section><footer><button onClick={() => feedback.mutate({ id: finding.id, label: "useful" })}>{t("findings.useful")}</button><button onClick={() => feedback.mutate({ id: finding.id, label: "incorrect" })}>{t("findings.incorrect")}</button><button onClick={() => feedback.mutate({ id: finding.id, label: "unclear" })}>{t("findings.unclear")}</button><button onClick={() => feedback.mutate({ id: finding.id, label: "already-known" })}>{t("findings.known")}</button></footer></article>;
      })}</div> : <StatePanel title={t("findings.empty")} description={t("page.findings.description")} />}
    </>
  );
}
