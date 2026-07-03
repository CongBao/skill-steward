import { useQuery } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Download, Search, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  fetchDashboard,
  fetchGovernanceTransactions,
  type InspectionResult
} from "../../api/client.js";
import { Dialog } from "../../components/Dialog.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatePanel } from "../../components/StatePanel.js";
import { useI18n } from "../../i18n/catalog.js";
import { InstallSkillFlow } from "../installer/InstallSkillFlow.js";
import { GovernanceDialog, type GovernanceDialogAction } from "./GovernanceDialog.js";
import "./skills.css";

function pathName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function SkillsPage() {
  const { locale, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const installationPreview = (location.state as { installationPreview?: InspectionResult } | null)?.installationPreview;
  const [search, setSearch] = useState("");
  const [installing, setInstalling] = useState(Boolean(installationPreview));
  const [governanceAction, setGovernanceAction] = useState<GovernanceDialogAction | null>(null);
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: fetchDashboard });
  const governance = useQuery({ queryKey: ["governance", "transactions"], queryFn: fetchGovernanceTransactions });
  const skills = useMemo(
    () => (dashboard.data?.skills ?? []).filter((skill) => `${skill.name} ${skill.description} ${skill.visibleTo.join(" ")}`.toLowerCase().includes(search.toLowerCase())),
    [dashboard.data?.skills, search]
  );
  const quarantined = useMemo(() => {
    const transactions = governance.data ?? [];
    const restored = new Set(transactions
      .filter((transaction) => transaction.action === "restore" && transaction.status === "restored")
      .map((transaction) => transaction.sourceTransactionId)
      .filter((id): id is string => Boolean(id)));
    return transactions.filter((transaction) =>
      transaction.action === "quarantine"
      && transaction.status === "quarantined"
      && !restored.has(transaction.id)
      && `${pathName(transaction.originalPath)} ${transaction.skillId} ${transaction.visibleAliases.map(({ harness }) => harness).join(" ")}`.toLowerCase().includes(search.toLowerCase())
    );
  }, [governance.data, search]);
  const failures = (governance.data ?? []).filter((transaction) => transaction.status === "failed");
  const completeGovernance = () => {
    setGovernanceAction(null);
    void dashboard.refetch();
    void governance.refetch();
  };
  const governanceTitle = governanceAction?.kind === "restore"
    ? t("governance.restoreTitle")
    : t("governance.quarantineTitle");

  return (
    <>
      <PageHeader title={t("page.skills.title")} description={t("page.skills.description")} actions={<button className="button primary" onClick={() => setInstalling(true)}><Download size={16} />{t("skills.install")}</button>} />
      <div className="toolbar"><label className="search-field"><Search size={16} /><span className="sr-only">{t("skills.search")}</span><input aria-label={t("skills.search")} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("skills.search")} /></label><span>{skills.length + quarantined.length}</span></div>
      {dashboard.isLoading ? <StatePanel title={t("page.skills.title")} description={t("app.scanning")} /> : (
        <div className="skill-state-stack">
          <section className="skill-state-section" role="region" aria-label={t("skills.active")}>
            <header><div><h2>{t("skills.active")}</h2><p>{t("skills.activeCopy")}</p></div><span>{skills.length}</span></header>
            {skills.length ? <div className="skills-table" role="table"><div className="skills-row head" role="row"><span>{t("skills.name")}</span><span>{t("skills.scope")}</span><span>{t("skills.harnesses")}</span><span>{t("skills.context")}</span><span>{t("skills.action")}</span></div>{skills.map((skill) => <article className="skills-row" role="row" key={skill.id}><div><strong>{skill.name}</strong><p>{skill.description}</p></div><span className="scope-pill">{skill.scope}</span><span className="harness-list">{skill.visibleTo.join(", ")}</span><strong className="numeric">{new Intl.NumberFormat(locale, { notation: "compact" }).format(skill.estimatedTokens)}</strong><button className="button governance-button" aria-label={`${t("governance.quarantine")} ${skill.name}`} onClick={() => setGovernanceAction({ kind: "quarantine", skill })}><Archive size={15} />{t("governance.quarantine")}</button></article>)}</div> : <div className="skill-state-empty">{t("skills.noActive")}</div>}
          </section>

          <section className="skill-state-section quarantined-section" role="region" aria-label={t("skills.quarantined")}>
            <header><div><h2>{t("skills.quarantined")}</h2><p>{t("skills.quarantinedCopy")}</p></div><span>{quarantined.length}</span></header>
            {quarantined.length ? <div className="quarantined-grid">{quarantined.map((transaction) => {
              const name = pathName(transaction.originalPath);
              return <article className="quarantined-card" key={transaction.id}><div className="quarantined-card-top"><span><Archive size={16} /></span><div><strong>{name}</strong><p>{transaction.visibleAliases.map(({ harness, scope }) => `${harness} · ${scope}`).join(", ")}</p></div><span className="quarantine-status">{t("skills.quarantinedStatus")}</span></div><code>{transaction.originalPath}</code><button className="button" aria-label={`${t("governance.restore")} ${name}`} onClick={() => setGovernanceAction({ kind: "restore", transaction })}><ArchiveRestore size={15} />{t("governance.restore")}</button></article>;
            })}</div> : <div className="skill-state-empty">{t("skills.noQuarantined")}</div>}
          </section>

          {failures.length > 0 ? <section className="governance-attention" role="status"><ShieldAlert size={17} /><div><strong>{t("skills.governanceAttention")}</strong><p>{t("skills.governanceAttentionCopy").replace("{count}", String(failures.length))}</p></div></section> : null}
          {governance.isError ? <p className="governance-error" role="alert">{governance.error.message}</p> : null}
          {skills.length === 0 && quarantined.length === 0 ? <StatePanel title={t("skills.empty")} description={t("page.skills.description")} /> : null}
        </div>
      )}
      {installing ? <Dialog title={t("install.title")} onClose={() => { setInstalling(false); navigate(location.pathname, { replace: true, state: null }); }}><InstallSkillFlow {...(installationPreview ? { initialInspection: installationPreview } : {})} onClose={() => { setInstalling(false); navigate(location.pathname, { replace: true, state: null }); }} /></Dialog> : null}
      {governanceAction ? <Dialog title={governanceTitle} onClose={() => setGovernanceAction(null)}><GovernanceDialog action={governanceAction} onComplete={completeGovernance} /></Dialog> : null}
    </>
  );
}
