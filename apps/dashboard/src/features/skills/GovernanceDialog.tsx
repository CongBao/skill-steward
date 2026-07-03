import { useMutation } from "@tanstack/react-query";
import { ArchiveRestore, FileCheck2, ShieldAlert } from "lucide-react";
import { useState } from "react";
import {
  applyGovernancePlan,
  planGovernance,
  type GovernanceApplyResult,
  type GovernanceOperation,
  type GovernancePlan,
  type GovernanceTransaction,
  type SkillSummary
} from "../../api/client.js";
import { useI18n } from "../../i18n/catalog.js";

export type GovernanceDialogAction =
  | { kind: "quarantine"; skill: SkillSummary }
  | { kind: "restore"; transaction: GovernanceTransaction };

function operationPaths(operation: GovernanceOperation): string[] {
  if ("from" in operation) return [operation.from, operation.to];
  if ("path" in operation) return [operation.path];
  return [];
}

export function GovernanceDialog({
  action,
  onComplete
}: {
  action: GovernanceDialogAction;
  onComplete(result: GovernanceApplyResult): void;
}) {
  const { t } = useI18n();
  const [plan, setPlan] = useState<GovernancePlan | null>(null);
  const name = action.kind === "quarantine"
    ? action.skill.name
    : action.transaction.originalPath.split(/[\\/]/).filter(Boolean).at(-1) ?? action.transaction.skillId;
  const review = useMutation({
    mutationFn: () => planGovernance(action.kind === "quarantine"
      ? { action: "quarantine", skillId: action.skill.id }
      : { action: "restore", transactionId: action.transaction.id }),
    onSuccess: setPlan
  });
  const apply = useMutation({
    mutationFn: (planId: string) => applyGovernancePlan(planId),
    onSuccess: onComplete
  });
  const kindLabel = action.kind === "quarantine" ? t("governance.quarantine") : t("governance.restore");

  return (
    <div className="governance-dialog-content">
      <section className="governance-intro" data-kind={action.kind}>
        <span>{action.kind === "quarantine" ? <ShieldAlert size={20} /> : <ArchiveRestore size={20} />}</span>
        <div><strong>{kindLabel}: {name}</strong><p>{action.kind === "quarantine" ? t("governance.quarantineCopy") : t("governance.restoreCopy")}</p></div>
      </section>
      <div className="governance-boundaries">
        <div><FileCheck2 size={16} /><p><strong>{t("governance.verifiedCopy")}</strong><span>{t("governance.verifiedCopyCopy")}</span></p></div>
        <div><ArchiveRestore size={16} /><p><strong>{t("governance.noDelete")}</strong><span>{t("governance.noDeleteCopy")}</span></p></div>
      </div>

      {!plan ? <button className="button primary governance-review" type="button" disabled={review.isPending} onClick={() => review.mutate()}>{action.kind === "quarantine" ? t("governance.reviewQuarantine") : t("governance.reviewRestore")}</button> : null}
      {review.error ? <p className="governance-error" role="alert">{review.error.message}</p> : null}

      {plan ? (
        <section className="governance-plan">
          <header><div><strong>{t("governance.exactPlan")}</strong><span>{t("governance.expiry")}</span></div><span className="source-status ready">{plan.kind}</span></header>
          <dl className="governance-paths">
            <div><dt>{t("governance.activePath")}</dt><dd><code>{plan.activePath}</code></dd></div>
            <div><dt>{t("governance.vaultPath")}</dt><dd><code>{plan.vaultPath}</code></dd></div>
            <div><dt>{t("governance.fingerprint")}</dt><dd><code>{plan.sourceFingerprint}</code></dd></div>
          </dl>
          <div className="governance-aliases"><strong>{t("governance.aliases")}</strong><div>{plan.visibleAliases.map((alias) => <span key={`${alias.harness}:${alias.scope}:${alias.rootPath}`}>{alias.harness} · {alias.scope}</span>)}</div></div>
          <ol className="governance-operations">{plan.operations.map((operation, index) => (
            <li key={`${operation.operation}:${index}`}>
              <span>{index + 1}</span>
              <div><strong>{operation.operation.replaceAll("-", " ")}</strong>{operationPaths(operation).map((path, pathIndex) => <code key={`${path}:${pathIndex}`}>{path}</code>)}</div>
            </li>
          ))}</ol>
          <p className="governance-drift-notice">{t("governance.driftNotice")}</p>
          <footer><button className="button" type="button" onClick={() => setPlan(null)}>{t("settings.cancel")}</button><button className="button primary" type="button" disabled={apply.isPending} onClick={() => apply.mutate(plan.id)}>{plan.kind === "quarantine" ? t("governance.applyQuarantine") : t("governance.applyRestore")}</button></footer>
          {apply.error ? <p className="governance-error" role="alert">{apply.error.message}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
