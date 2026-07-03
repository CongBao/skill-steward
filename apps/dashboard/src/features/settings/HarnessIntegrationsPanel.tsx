import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Check, ShieldAlert, Unplug } from "lucide-react";
import { useState } from "react";
import {
  applyHarnessIntegration,
  fetchIntegrationCapabilities,
  fetchIntegrations,
  planHarnessIntegration,
  removeHarnessIntegration,
  type IntegrationHarness,
  type IntegrationPlan
} from "../../api/client.js";
import { useI18n, type TranslationKey } from "../../i18n/catalog.js";

const harnesses: IntegrationHarness[] = ["codex", "claude-code", "github-copilot"];
const harnessName = (harness: IntegrationHarness) => harness === "codex" ? "Codex" : harness === "claude-code" ? "Claude Code" : "GitHub Copilot CLI";

export function HarnessIntegrationsPanel() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [plan, setPlan] = useState<IntegrationPlan | null>(null);
  const integrations = useQuery({ queryKey: ["integrations"], queryFn: fetchIntegrations });
  const capabilities = useQuery({ queryKey: ["integrations", "capabilities"], queryFn: fetchIntegrationCapabilities });
  const review = useMutation({
    mutationFn: planHarnessIntegration,
    onSuccess: setPlan
  });
  const apply = useMutation({
    mutationFn: async (harness: IntegrationHarness) => {
      if (!window.confirm(t("settings.integrations.applyConfirm").replace("{harness}", harnessName(harness)))) return null;
      return applyHarnessIntegration(harness);
    },
    onSuccess: async (result) => {
      if (!result) return;
      setPlan(null);
      await queryClient.invalidateQueries({ queryKey: ["integrations"] });
    }
  });
  const remove = useMutation({
    mutationFn: async (harness: IntegrationHarness) => {
      if (!window.confirm(t("settings.integrations.removeConfirm").replace("{harness}", harnessName(harness)))) return null;
      return removeHarnessIntegration(harness);
    },
    onSuccess: (result) => result && queryClient.invalidateQueries({ queryKey: ["integrations"] })
  });
  const statuses = Array.isArray(integrations.data) ? integrations.data : [];

  return (
    <section className="settings-card integrations-card">
      <header><div><Cable size={17} /><div><h2>{t("settings.integrations.title")}</h2><p>{t("settings.integrations.copy")}</p></div></div></header>
      <div className="integration-list">
        {harnesses.map((harness) => {
          const status = statuses.find((item) => item.harness === harness);
          const capability = capabilities.data?.find((item) => item.harness === harness);
          const value = status?.status ?? "not-installed";
          const name = capability?.displayName ?? harnessName(harness);
          return (
            <article className="integration-row" key={harness} data-status={value} aria-label={`${name} integration`}>
              <div className="integration-identity">
                <span>{value === "installed" ? <Check size={17} /> : value === "needs-trust" ? <ShieldAlert size={17} /> : <Cable size={17} />}</span>
                <div><strong>{name}</strong><p>{t(`settings.integrations.status.${value}` as TranslationKey)}</p></div>
              </div>
              <div className="integration-capabilities">
                <span data-mode={capability?.mode ?? "unknown"}>{capability?.mode === "observe-only" ? t("settings.integrations.observeOnly") : t("settings.integrations.recommendObserve")}</span>
                <span>{capability?.events.join(" · ") ?? t("settings.integrations.capabilityLoading")}</span>
                {capability?.mode === "observe-only" ? <span className="companion-capability">{t("settings.integrations.companionRecommendation")}</span> : null}
              </div>
              <div className="integration-actions">
                <button className="button" aria-label={`${t("settings.integrations.review")} ${name} integration`} onClick={() => review.mutate(harness)}>{t("settings.integrations.review")}</button>
                {value !== "not-installed" ? <button className="icon-button" aria-label={`${t("settings.integrations.remove")} ${name} integration`} onClick={() => remove.mutate(harness)}><Unplug size={15} /></button> : null}
              </div>
            </article>
          );
        })}
      </div>
      {plan ? (
        <section className="integration-plan">
          <header><strong>{t("settings.integrations.plan")}</strong><span>{harnessName(plan.harness)}</span></header>
          <code>{plan.targetPath}</code>
          <ul>{plan.changes.map((change, index) => <li key={`${change.operation}:${index}`}><span>{change.operation}</span>{change.path !== plan.targetPath ? <code>{change.path}</code> : null}</li>)}</ul>
          <p>{plan.harness === "codex" ? t("settings.integrations.codexTrust") : t("settings.integrations.reviewNotice")}</p>
          <button className="button primary" aria-label={`${t("settings.integrations.apply")} ${harnessName(plan.harness)} integration`} disabled={apply.isPending} onClick={() => apply.mutate(plan.harness)}>{t("settings.integrations.apply")}</button>
        </section>
      ) : null}
      {(integrations.error || capabilities.error || review.error || apply.error || remove.error) ? <p className="form-error" role="alert">{String(integrations.error ?? capabilities.error ?? review.error ?? apply.error ?? remove.error)}</p> : null}
    </section>
  );
}
