import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseZap, Eraser, ShieldCheck } from "lucide-react";
import {
  applyEvidenceErase,
  applyEvidencePolicy,
  compactEvidence,
  fetchEvidencePolicy,
  planEvidenceErase,
  planEvidencePolicy,
  type EvidenceErasePlan,
  type EvidenceMode,
  type EvidencePolicyPlan
} from "../../api/client.js";
import { useI18n } from "../../i18n/catalog.js";

function ErrorCopy({ value }: { value: unknown }) {
  return value instanceof Error ? <p className="policy-error" role="alert">{value.message}</p> : null;
}

export function DataPolicyPanel() {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const policy = useQuery({ queryKey: ["evidence", "policy"], queryFn: fetchEvidencePolicy });
  const [mode, setMode] = useState<EvidenceMode>("minimal");
  const [retentionDays, setRetentionDays] = useState(30);
  const [maxEvents, setMaxEvents] = useState(5_000);
  const [policyPlan, setPolicyPlan] = useState<EvidencePolicyPlan | null>(null);
  const [erasePlan, setErasePlan] = useState<EvidenceErasePlan | null>(null);
  const [compactMessage, setCompactMessage] = useState<string | null>(null);
  const [erased, setErased] = useState(false);

  useEffect(() => {
    if (!policy.data || policyPlan) return;
    setMode(policy.data.mode);
    setRetentionDays(policy.data.retentionDays);
    setMaxEvents(policy.data.maxEvents);
  }, [policy.data, policyPlan]);

  const planPolicy = useMutation({
    mutationFn: () => planEvidencePolicy({ mode, retentionDays, maxEvents }),
    onSuccess: setPolicyPlan
  });
  const applyPolicy = useMutation({
    mutationFn: (planId: string) => applyEvidencePolicy(planId),
    onSuccess: (next) => {
      queryClient.setQueryData(["evidence", "policy"], next);
      setPolicyPlan(null);
    }
  });
  const compact = useMutation({
    mutationFn: compactEvidence,
    onSuccess: (result) => {
      setCompactMessage(t("settings.dataPolicy.compactResult")
        .replace("{removed}", String(result.removed))
        .replace("{before}", String(result.before)));
      void queryClient.invalidateQueries({ queryKey: ["evidence", "summary"] });
    }
  });
  const planErase = useMutation({ mutationFn: planEvidenceErase, onSuccess: setErasePlan });
  const erase = useMutation({
    mutationFn: (planId: string) => applyEvidenceErase(planId),
    onSuccess: () => {
      setErasePlan(null);
      setErased(true);
      void queryClient.invalidateQueries({ queryKey: ["evidence"] });
    }
  });
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);

  return (
    <section className="settings-card data-policy-card">
      <header>
        <div><ShieldCheck size={18} aria-hidden="true" /><div><h2>{t("settings.dataPolicy.title")}</h2><p>{t("settings.dataPolicy.copy")}</p></div></div>
        <span className="source-status ready">{t("settings.dataPolicy.local")}</span>
      </header>
      {policy.isPending ? <p className="muted-copy">{t("settings.dataPolicy.loading")}</p> : null}
      {policy.isError ? <ErrorCopy value={policy.error} /> : null}
      {policy.data ? (
        <>
          <div className="policy-fields">
            <label>{t("settings.dataPolicy.mode")}<select aria-label={t("settings.dataPolicy.mode")} value={mode} onChange={(event) => { setMode(event.target.value as EvidenceMode); setPolicyPlan(null); }}><option value="minimal">{t("settings.dataPolicy.minimal")}</option><option value="learning">{t("settings.dataPolicy.learning")}</option></select></label>
            <label>{t("settings.dataPolicy.retention")}<input aria-label={t("settings.dataPolicy.retention")} type="number" min="7" max="365" value={retentionDays} onChange={(event) => { setRetentionDays(Number(event.target.value)); setPolicyPlan(null); }} /></label>
            <label>{t("settings.dataPolicy.maxEvents")}<input aria-label={t("settings.dataPolicy.maxEvents")} type="number" min="100" max="10000" value={maxEvents} onChange={(event) => { setMaxEvents(Number(event.target.value)); setPolicyPlan(null); }} /></label>
          </div>
          <p className="policy-mode-copy">{mode === "minimal" ? t("settings.dataPolicy.minimalCopy") : t("settings.dataPolicy.learningCopy")}</p>
          <div className="policy-actions"><button className="button" type="button" disabled={planPolicy.isPending || retentionDays < 7 || retentionDays > 365 || maxEvents < 100 || maxEvents > 10_000} onClick={() => planPolicy.mutate()}>{t("settings.dataPolicy.review")}</button></div>
          <ErrorCopy value={planPolicy.error} />
        </>
      ) : null}

      {policyPlan ? (
        <section className="policy-plan" aria-label={t("settings.dataPolicy.preview")}>
          <header><div><strong>{t("settings.dataPolicy.preview")}</strong><span>{t("settings.dataPolicy.expires")}</span></div></header>
          <dl>
            <div><dt>{t("settings.dataPolicy.mode")}</dt><dd>{policyPlan.before.mode} → {policyPlan.after.mode}</dd></div>
            <div><dt>{t("settings.dataPolicy.retention")}</dt><dd>{policyPlan.before.retentionDays} → {policyPlan.after.retentionDays} {t("settings.dataPolicy.days")}</dd></div>
            <div><dt>{t("settings.dataPolicy.maxEvents")}</dt><dd>{number(policyPlan.before.maxEvents)} → {number(policyPlan.after.maxEvents)} {t("settings.dataPolicy.events")}</dd></div>
          </dl>
          <footer><button className="button" type="button" onClick={() => setPolicyPlan(null)}>{t("settings.cancel")}</button><button className="button primary" type="button" disabled={applyPolicy.isPending} onClick={() => applyPolicy.mutate(policyPlan.id)}>{t("settings.dataPolicy.apply")}</button></footer>
          <ErrorCopy value={applyPolicy.error} />
        </section>
      ) : null}

      <div className="policy-maintenance">
        <div><DatabaseZap size={17} aria-hidden="true" /><div><strong>{t("settings.dataPolicy.compactTitle")}</strong><p>{t("settings.dataPolicy.compactCopy")}</p></div><button className="button" type="button" disabled={compact.isPending} onClick={() => compact.mutate()}>{t("settings.dataPolicy.compact")}</button></div>
        {compactMessage ? <p className="policy-result" role="status">{compactMessage}</p> : null}
        <ErrorCopy value={compact.error} />
        <div className="erase-row"><Eraser size={17} aria-hidden="true" /><div><strong>{t("settings.dataPolicy.eraseTitle")}</strong><p>{t("settings.dataPolicy.eraseCopy")}</p></div><button className="button danger" type="button" disabled={planErase.isPending} onClick={() => { setErased(false); planErase.mutate(); }}>{t("settings.dataPolicy.eraseReview")}</button></div>
        {erased ? <p className="policy-result" role="status">{t("settings.dataPolicy.erased")}</p> : null}
        <ErrorCopy value={planErase.error ?? erase.error} />
      </div>

      {erasePlan ? (
        <section className="policy-plan erase-plan" aria-label={t("settings.dataPolicy.erasePreview")}>
          <header><div><strong>{t("settings.dataPolicy.erasePreview")}</strong><span>{t("settings.dataPolicy.eraseWarning")}</span></div></header>
          <ul>{erasePlan.paths.map((item) => <li key={item.kind}><span data-exists={item.exists}>{item.exists ? t("settings.dataPolicy.present") : t("settings.dataPolicy.absent")}</span><code>{item.path}</code></li>)}</ul>
          <footer><button className="button" type="button" onClick={() => setErasePlan(null)}>{t("settings.cancel")}</button><button className="button danger" type="button" disabled={erase.isPending} onClick={() => erase.mutate(erasePlan.id)}>{t("settings.dataPolicy.eraseApply")}</button></footer>
        </section>
      ) : null}
    </section>
  );
}
