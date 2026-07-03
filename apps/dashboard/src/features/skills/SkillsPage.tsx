import { useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { fetchDashboard, type InspectionResult } from "../../api/client.js";
import { Dialog } from "../../components/Dialog.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatePanel } from "../../components/StatePanel.js";
import { useI18n } from "../../i18n/catalog.js";
import { InstallSkillFlow } from "../installer/InstallSkillFlow.js";
import "./skills.css";

export function SkillsPage() {
  const { locale, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const installationPreview = (location.state as { installationPreview?: InspectionResult } | null)?.installationPreview;
  const [search, setSearch] = useState("");
  const [installing, setInstalling] = useState(Boolean(installationPreview));
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: fetchDashboard });
  const skills = useMemo(
    () => (dashboard.data?.skills ?? []).filter((skill) => `${skill.name} ${skill.description} ${skill.visibleTo.join(" ")}`.toLowerCase().includes(search.toLowerCase())),
    [dashboard.data?.skills, search]
  );

  return (
    <>
      <PageHeader title={t("page.skills.title")} description={t("page.skills.description")} actions={<button className="button primary" onClick={() => setInstalling(true)}><Download size={16} />{t("skills.install")}</button>} />
      <div className="toolbar"><label className="search-field"><Search size={16} /><span className="sr-only">{t("skills.search")}</span><input aria-label={t("skills.search")} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("skills.search")} /></label><span>{skills.length}</span></div>
      {dashboard.isLoading ? <StatePanel title={t("page.skills.title")} description={t("app.scanning")} /> : skills.length ? (
        <div className="skills-table" role="table"><div className="skills-row head" role="row"><span>{t("skills.name")}</span><span>{t("skills.scope")}</span><span>{t("skills.harnesses")}</span><span>{t("skills.context")}</span></div>{skills.map((skill) => <article className="skills-row" role="row" key={skill.id}><div><strong>{skill.name}</strong><p>{skill.description}</p></div><span className="scope-pill">{skill.scope}</span><span className="harness-list">{skill.visibleTo.join(", ")}</span><strong className="numeric">{new Intl.NumberFormat(locale, { notation: "compact" }).format(skill.estimatedTokens)}</strong></article>)}</div>
      ) : <StatePanel title={t("skills.empty")} description={t("page.skills.description")} />}
      {installing ? <Dialog title={t("install.title")} onClose={() => { setInstalling(false); navigate(location.pathname, { replace: true, state: null }); }}><InstallSkillFlow {...(installationPreview ? { initialInspection: installationPreview } : {})} onClose={() => { setInstalling(false); navigate(location.pathname, { replace: true, state: null }); }} /></Dialog> : null}
    </>
  );
}
