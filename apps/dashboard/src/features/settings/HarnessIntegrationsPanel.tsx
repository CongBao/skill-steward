import { useMutation, useQuery } from "@tanstack/react-query";
import { Cable, Check, ShieldAlert } from "lucide-react";
import { useState } from "react";
import {
  fetchIntegrationCapabilities,
  fetchIntegrations,
  planHarnessIntegration,
  type IntegrationHarness,
  type IntegrationPlan
} from "../../api/client.js";
import { useI18n, type TranslationKey } from "../../i18n/catalog.js";

const harnesses: IntegrationHarness[] = ["codex", "claude-code", "github-copilot"];
const harnessName = (harness: IntegrationHarness) => harness === "codex" ? "Codex" : harness === "claude-code" ? "Claude Code" : "GitHub Copilot CLI";

export function HarnessIntegrationsPanel() {
  const { t } = useI18n();
  const [plan, setPlan] = useState<IntegrationPlan | null>(null);
  const integrations = useQuery({ queryKey: ["integrations"], queryFn: fetchIntegrations });
  const capabilities = useQuery({ queryKey: ["integrations", "capabilities"], queryFn: fetchIntegrationCapabilities });
  const review = useMutation({
    mutationFn: planHarnessIntegration,
    onSuccess: setPlan
  });
  const statuses = Array.isArray(integrations.data) ? integrations.data : [];

  return (
    <section className="settings-card integrations-card">
      <header><div><Cable size={17} /><div><h2>{t("settings.integrations.title")}</h2><p>{t("settings.integrations.copy")}</p></div></div></header>
      <div className="integration-list">
        {harnesses.map((harness) => {
          const status = statuses.find((item) => item.harness === harness);
          const capability = capabilities.data?.find((item) => item.harness === harness);
          const statusFallback = integrations.isPending ? "loading" : "unavailable";
          const value = status?.status;
          const companionValue = status?.companion?.status;
          const renderedStatus = value ?? statusFallback;
          const renderedCompanionStatus = companionValue ?? statusFallback;
          const name = capability?.displayName ?? harnessName(harness);
          return (
            <article className="integration-row" key={harness} data-status={renderedStatus} aria-label={`${name} integration`}>
              <div className="integration-identity">
                <span>{value === "installed" ? <Check size={17} /> : value === "needs-trust" ? <ShieldAlert size={17} /> : <Cable size={17} />}</span>
                <div>
                  <strong>{name}</strong>
                  <div className="integration-domain-status">
                    <p>{`${t("settings.integrations.hook")}: ${t(`settings.integrations.status.${renderedStatus}` as TranslationKey)}`}</p>
                    <p data-companion-status={renderedCompanionStatus}>{`${t("settings.integrations.companion")}: ${t(`settings.integrations.companionStatus.${renderedCompanionStatus}` as TranslationKey)}`}</p>
                  </div>
                </div>
              </div>
              <div className="integration-capabilities">
                <span data-mode={capability?.mode ?? "unknown"}>{capability?.mode === "observe-only" ? t("settings.integrations.observeOnly") : t("settings.integrations.recommendObserve")}</span>
                <span>{capability?.events.join(" · ") ?? t("settings.integrations.capabilityLoading")}</span>
                {capability?.mode === "observe-only" ? <span className="companion-capability">{t("settings.integrations.companionRecommendation")}</span> : null}
              </div>
              <div className="integration-actions">
                <button className="button" aria-label={`${t("settings.integrations.review")} ${name} integration`} onClick={() => review.mutate(harness)}>{t("settings.integrations.review")}</button>
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
          <p>{`${t("settings.integrations.companionAction")}: ${t(`settings.integrations.companionAction.${plan.companion.action}` as TranslationKey)}`}</p>
          <code>{plan.companion.path}</code>
          <p className="integration-readonly-note">{t("settings.integrations.applyUnavailable")}</p>
        </section>
      ) : null}
      {(integrations.error || capabilities.error || review.error) ? <p className="form-error" role="alert">{String(integrations.error ?? capabilities.error ?? review.error)}</p> : null}
    </section>
  );
}
