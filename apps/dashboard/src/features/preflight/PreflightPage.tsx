import { useMutation } from "@tanstack/react-query";
import { Check, Info, Route, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  runPreflight,
  submitPreflightFeedback,
  type PreflightCandidate,
  type PreflightReasonCode,
  type PreflightResult
} from "../../api/client.js";
import { PageHeader } from "../../components/PageHeader.js";
import { SeverityBadge } from "../../components/SeverityBadge.js";
import { useI18n, type TranslationKey } from "../../i18n/catalog.js";
import { AvailableCandidateCard } from "./AvailableCandidateCard.js";
import { preflightReasonDetail } from "./reasonDetail.js";
import "./preflight.css";

const reasonKeys: Record<PreflightReasonCode, TranslationKey> = {
  TASK_TERM_MATCH: "preflight.reason.TASK_TERM_MATCH",
  NAME_MATCH: "preflight.reason.NAME_MATCH",
  HIGH_CONFIDENCE_TRIGGER: "preflight.reason.HIGH_CONFIDENCE_TRIGGER",
  PROJECT_SCOPE_FIT: "preflight.reason.PROJECT_SCOPE_FIT",
  UNIQUE_COVERAGE: "preflight.reason.UNIQUE_COVERAGE",
  REDUNDANT_WITH_SELECTED: "preflight.reason.REDUNDANT_WITH_SELECTED",
  LOW_RELEVANCE: "preflight.reason.LOW_RELEVANCE",
  PORTFOLIO_RISK: "preflight.reason.PORTFOLIO_RISK",
  INSTALL_REQUIRED: "preflight.reason.INSTALL_REQUIRED",
  CRITICAL_RISK: "preflight.reason.CRITICAL_RISK",
  NEGATIVE_TRIGGER: "preflight.reason.NEGATIVE_TRIGGER",
  HARNESS_INCOMPATIBLE: "preflight.reason.HARNESS_INCOMPATIBLE",
  HARNESS_SHADOWED: "preflight.reason.HARNESS_SHADOWED",
  HARNESS_INACTIVE: "preflight.reason.HARNESS_INACTIVE",
  HARNESS_AMBIGUOUS: "preflight.reason.HARNESS_AMBIGUOUS",
  INVENTORY_RESCAN_REQUIRED: "preflight.reason.INVENTORY_RESCAN_REQUIRED",
  CAPABILITY_MATCH: "preflight.reason.CAPABILITY_MATCH",
  EXACT_TRIGGER_MATCH: "preflight.reason.EXACT_TRIGGER_MATCH",
  MARGINAL_CAPABILITY: "preflight.reason.MARGINAL_CAPABILITY",
  REDUNDANT_CAPABILITY: "preflight.reason.REDUNDANT_CAPABILITY"
};

function ScoreBar({ label, value }: { label: string; value: number }) {
  const percent = Math.round(value * 100);
  return <div className="preflight-score" aria-label={`${label}: ${percent}%`}><div><span>{label}</span><strong>{percent}%</strong></div><span className="preflight-score-track"><span style={{ width: `${percent}%` }} /></span></div>;
}

function CandidateCard({ candidate }: { candidate: PreflightCandidate }) {
  const { t } = useI18n();
  return (
    <article className="preflight-candidate" data-decision={candidate.decision}>
      <header><div><h3>{candidate.name}</h3><p>{candidate.description}</p></div><span className="preflight-token-cost">{candidate.contextTokens} {t("preflight.tokens")}</span></header>
      <div className="preflight-scores"><ScoreBar label={t("preflight.relevance")} value={candidate.relevance} /><ScoreBar label={t("preflight.capabilityCoverage")} value={candidate.features.capabilityCoverage} /><ScoreBar label={t("preflight.uniqueCoverage")} value={candidate.uniqueCoverage} /></div>
      <div className="preflight-metadata"><span>{t("preflight.scope")}: <strong>{t(`scope.${candidate.scope}` as TranslationKey)}</strong></span><span>{t("preflight.harnesses")}: <strong>{candidate.compatibleHarnesses.join(", ") || "—"}</strong></span></div>
      <ul className="preflight-reasons">{candidate.reasons.map((reason, index) => <li key={`${reason.code}-${index}`}><span>{t(reasonKeys[reason.code])}</span><p>{preflightReasonDetail(candidate, reason, t)}</p></li>)}</ul>
    </article>
  );
}

export function PreflightPage() {
  const { locale, t } = useI18n();
  const [task, setTask] = useState("");
  const [maxSkills, setMaxSkills] = useState(5);
  const [harness, setHarness] = useState("codex");
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [resultHarness, setResultHarness] = useState("codex");
  const [feedbackMode, setFeedbackMode] = useState<"incomplete" | null>(null);
  const [corrected, setCorrected] = useState<Set<string>>(new Set());
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const validTask = task.replace(/\s/g, "").length >= 8 && task.length <= 20_000;
  const analysis = useMutation({
    mutationFn: (request: { task: string; maxSkills: number; harness: string }) =>
      runPreflight(request.task, request.maxSkills, request.harness, true),
    onSuccess: (next, request) => {
      setResult(next);
      setResultHarness(request.harness);
      setCorrected(new Set([...next.useCandidateIds, ...next.installCandidateIds]));
      setFeedbackMode(null);
      setFeedbackSaved(false);
    }
  });
  const feedback = useMutation({
    mutationFn: ({ label, candidateIds }: { label: "useful" | "incomplete" | "incorrect"; candidateIds: string[] }) => {
      if (!result) throw new Error("Preflight result is unavailable");
      return submitPreflightFeedback(result.id, label, candidateIds);
    },
    onSuccess: () => { setFeedbackSaved(true); setFeedbackMode(null); }
  });
  const useNow = useMemo(() => result?.candidates.filter(({ decision }) => decision === "use") ?? [], [result]);
  const install = useMemo(() => result?.candidates.filter(({ decision }) => decision === "install") ?? [], [result]);
  const excluded = useMemo(() => result?.candidates.filter(({ decision }) => decision === "excluded") ?? [], [result]);
  const correctedIds = result?.candidates.filter(({ candidateId }) => corrected.has(candidateId)).map(({ candidateId }) => candidateId) ?? [];
  const recommendedIds = result ? [...result.useCandidateIds, ...result.installCandidateIds] : [];
  const number = new Intl.NumberFormat(locale, { notation: "compact" });
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const submitFeedback = (label: "useful" | "incorrect") => feedback.mutate({ label, candidateIds: recommendedIds });

  return (
    <>
      <PageHeader title={t("page.preflight.title")} description={t("page.preflight.description")} />
      <section className="preflight-input-card">
        <div className="preflight-input-heading"><div><Route size={18} /><strong>{t("preflight.taskLabel")}</strong></div><span>{task.length.toLocaleString(locale)} {t("preflight.characters")}</span></div>
        <textarea aria-label={t("preflight.taskLabel")} maxLength={20_000} onChange={(event) => setTask(event.target.value)} placeholder={t("preflight.taskPlaceholder")} rows={5} value={task} />
        <div className="preflight-privacy"><ShieldCheck size={16} /><span>{t("preflight.privacy")}</span></div>
        <footer><div className="preflight-controls"><label>{t("preflight.targetHarness")}<select value={harness} onChange={(event) => setHarness(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="github-copilot">GitHub Copilot</option></select></label><label>{t("preflight.maxSkills")}<select value={maxSkills} onChange={(event) => setMaxSkills(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label></div><button className="button primary" disabled={!validTask || analysis.isPending} onClick={() => analysis.mutate({ task, maxSkills, harness })}>{analysis.isPending ? t("preflight.analyzing") : t("preflight.analyze")}</button></footer>
      </section>
      <section className="preflight-method-note"><Info size={17} /><div><strong>{t("preflight.deterministic")}</strong><p>{t("preflight.deterministicCopy")}</p></div></section>
      {analysis.error ? <section className="preflight-error" role="alert"><TriangleAlert size={18} /><div><strong>{analysis.error.message}</strong><button className="button" onClick={() => analysis.mutate({ task, maxSkills, harness })}>{t("preflight.retry")}</button></div></section> : null}
      {result ? (
        <div className="preflight-result" aria-live="polite">
          <section className="preflight-summary">
            <article><span>{t("preflight.useCount")}</span><strong>{useNow.length}</strong></article>
            <article><span>{t("preflight.installCount")}</span><strong>{install.length}</strong></article>
            <article><span>{t("preflight.installedCoverage")}</span><strong>{percent.format(result.installedCoverage)}</strong></article>
            <article><span>{t("preflight.projectedCoverage")}</span><strong>{percent.format(result.projectedCoverage)}</strong></article>
            <article><span>{t("preflight.selectedContext")}</span><strong>{number.format(result.selectedContextTokens)}</strong></article>
            <article><span>{t("preflight.contextSaved")}</span><strong>{number.format(result.estimatedContextSaved)}</strong></article>
          </section>
          {result.inventoryWarnings.length ? <section className="preflight-section preflight-conflicts" aria-labelledby="preflight-inventory-warnings"><header><div><TriangleAlert size={18} /><h2 id="preflight-inventory-warnings">{t("preflight.inventoryWarnings")}</h2></div><span>{result.inventoryWarnings.length}</span></header>{result.inventoryWarnings.map((warning) => <article key={`${warning.harness}-${warning.code}`}><code>{warning.code}</code><p>{warning.detail}</p></article>)}</section> : null}
          {useNow.length ? <section className="preflight-section preflight-use" aria-labelledby="preflight-use"><header><div><Check size={18} /><h2 id="preflight-use">{t("preflight.useNow")}</h2></div><span>{useNow.length}</span></header><div className="preflight-selected-grid">{useNow.map((candidate) => <CandidateCard candidate={candidate} key={candidate.candidateId} />)}</div></section> : null}
          {install.length ? <section className="preflight-section preflight-install" aria-labelledby="preflight-install"><header><div><Sparkles size={18} /><h2 id="preflight-install">{t("preflight.considerInstalling")}</h2></div><span>{install.length}</span></header><p className="preflight-section-copy">{t("preflight.installCopy")}</p><div className="preflight-selected-grid">{install.map((candidate) => <AvailableCandidateCard candidate={candidate} preflightId={result.id} targetHarness={resultHarness} key={candidate.candidateId} />)}</div></section> : null}
          {result.capabilityGaps.length ? <section className="preflight-section preflight-gaps" aria-labelledby="preflight-gaps"><header><div><TriangleAlert size={18} /><h2 id="preflight-gaps">{t("preflight.capabilityGaps")}</h2></div><span>{result.capabilityGaps.length}</span></header><p>{t("preflight.gapsCopy")}</p><div>{result.capabilityGaps.map((gap) => <span key={gap}>{gap}</span>)}</div></section> : null}
          {!useNow.length && !install.length ? <section className="preflight-no-match"><h2>{t("preflight.noMatch")}</h2><p>{t("preflight.noMatchCopy")}</p><div className="state-actions"><Link className="button primary" to="/skills">{t("preflight.openSkills")}</Link><Link className="button" to="/settings#catalog-sources">{t("preflight.catalogSettings")}</Link></div></section> : null}
          {(useNow.length || install.length) ? <section className="preflight-section preflight-conflicts" aria-labelledby="preflight-conflicts"><header><div><TriangleAlert size={18} /><h2 id="preflight-conflicts">{t("preflight.conflicts")}</h2></div><span>{result.conflicts.length}</span></header>{result.conflicts.length ? result.conflicts.map((conflict) => <article key={conflict.id}><SeverityBadge severity={conflict.severity} /><code>{conflict.code}</code><p>{conflict.summary}</p></article>) : <p className="preflight-muted">{t("preflight.noConflicts")}</p>}</section> : null}
          {excluded.length ? <details className="preflight-excluded"><summary>{t("preflight.excluded")} ({excluded.length})</summary><div className="preflight-excluded-grid">{excluded.map((candidate) => candidate.availability === "available" ? <AvailableCandidateCard candidate={candidate} key={candidate.candidateId} /> : <CandidateCard candidate={candidate} key={candidate.candidateId} />)}</div></details> : null}
          <section className="preflight-feedback"><div><h2>{t("preflight.feedbackTitle")}</h2><p>{t("preflight.feedbackCopy")}</p></div>{feedbackSaved ? <span className="preflight-feedback-saved"><Check size={16} />{t("preflight.feedbackSaved")}</span> : <div className="preflight-feedback-actions"><button className="button" disabled={feedback.isPending} onClick={() => submitFeedback("useful")}>{t("preflight.useful")}</button><button className="button" disabled={feedback.isPending} onClick={() => setFeedbackMode("incomplete")}>{t("preflight.incomplete")}</button><button className="button" disabled={feedback.isPending} onClick={() => submitFeedback("incorrect")}>{t("preflight.incorrect")}</button></div>}
            {feedbackMode === "incomplete" ? <div className="preflight-correction"><strong>{t("preflight.correctSelection")}</strong><div>{result.candidates.map((candidate) => <label key={candidate.candidateId}><input aria-label={`${t("preflight.include")} ${candidate.name}`} checked={corrected.has(candidate.candidateId)} onChange={() => setCorrected((current) => { const next = new Set(current); if (next.has(candidate.candidateId)) next.delete(candidate.candidateId); else next.add(candidate.candidateId); return next; })} type="checkbox" /><span>{candidate.name}</span></label>)}</div><button className="button primary" disabled={feedback.isPending} onClick={() => feedback.mutate({ label: "incomplete", candidateIds: correctedIds })}>{feedback.isPending ? t("preflight.savingFeedback") : t("preflight.saveFeedback")}</button></div> : null}
          </section>
        </div>
      ) : null}
    </>
  );
}
