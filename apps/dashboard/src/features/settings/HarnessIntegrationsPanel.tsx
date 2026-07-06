import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Check, ShieldAlert, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ApiRequestError,
  ApiTransportError,
  applyIntegrationRecovery,
  applyHarnessIntegration,
  disconnectHarnessIntegration,
  fetchIntegrationCapabilities,
  fetchIntegrationRecovery,
  fetchIntegrations,
  planIntegrationRecovery,
  planHarnessDisconnect,
  planHarnessIntegration,
  type IntegrationDisconnectPlan,
  type IntegrationHarness,
  type IntegrationMutationResult,
  type IntegrationPlan,
  type IntegrationRecoveryPlan,
  type IntegrationRecoveryReceipt,
  type IntegrationTransactionReceipt
} from "../../api/client.js";
import { useI18n, type TranslationKey } from "../../i18n/catalog.js";
import {
  createIntegrationOperationGuard,
  type IntegrationOperationState
} from "./integrationOperationState.js";

const harnesses: IntegrationHarness[] = ["codex", "claude-code", "github-copilot"];
const harnessName = (harness: IntegrationHarness) => harness === "codex"
  ? "Codex"
  : harness === "claude-code"
    ? "Claude Code"
    : "GitHub Copilot CLI";

type ReviewedIntegrationPlan = IntegrationPlan | IntegrationDisconnectPlan;
type IntegrationArtifact = ReviewedIntegrationPlan["artifacts"][number];

const unavailableReasonKeys: Readonly<Record<string, TranslationKey>> = {
  COMPANION_CONFLICT: "settings.integrations.reason.COMPANION_CONFLICT",
  COMPANION_SOURCE_UNPROVABLE: "settings.integrations.reason.COMPANION_SOURCE_UNPROVABLE",
  COMPANION_RECOVERY_REQUIRED: "settings.integrations.reason.COMPANION_RECOVERY_REQUIRED",
  COMPANION_RECOVERY_UNAVAILABLE: "settings.integrations.reason.COMPANION_RECOVERY_UNAVAILABLE",
  INTEGRATION_RECOVERY_REQUIRED: "settings.integrations.reason.INTEGRATION_RECOVERY_REQUIRED",
  INTEGRATION_PLATFORM_UNSUPPORTED: "settings.integrations.reason.INTEGRATION_PLATFORM_UNSUPPORTED",
  INTEGRATION_NATIVE_CAPABILITY_UNAVAILABLE: "settings.integrations.reason.INTEGRATION_NATIVE_CAPABILITY_UNAVAILABLE",
  INTEGRATION_PLAN_PROTOCOL_UNSUPPORTED: "settings.integrations.reason.INTEGRATION_PLAN_PROTOCOL_UNSUPPORTED"
};
const artifactRoleKeys: Record<IntegrationArtifact["role"], TranslationKey> = {
  "companion-skill": "settings.integrations.artifactRole.companion-skill",
  "harness-configuration": "settings.integrations.artifactRole.harness-configuration"
};
const artifactActionKeys: Record<IntegrationArtifact["operation"], TranslationKey> = {
  create: "settings.integrations.artifactAction.create",
  upgrade: "settings.integrations.artifactAction.upgrade",
  connect: "settings.integrations.artifactAction.connect",
  disconnect: "settings.integrations.artifactAction.disconnect"
};
const receiptOutcomeKeys: Record<IntegrationTransactionReceipt["outcome"], TranslationKey> = {
  ready: "settings.integrations.receipt.outcome.ready",
  "rolled-back": "settings.integrations.receipt.outcome.rolled-back",
  "recovery-required": "settings.integrations.receipt.outcome.recovery-required"
};
const receiptHookKeys: Record<IntegrationTransactionReceipt["hook"], TranslationKey> = {
  unchanged: "settings.integrations.receipt.hook.unchanged",
  installed: "settings.integrations.receipt.hook.installed",
  removed: "settings.integrations.receipt.hook.removed",
  restored: "settings.integrations.receipt.hook.restored",
  unknown: "settings.integrations.receipt.hook.unknown"
};
const receiptCompanionKeys: Record<IntegrationTransactionReceipt["companion"], TranslationKey> = {
  unchanged: "settings.integrations.receipt.companion.unchanged",
  created: "settings.integrations.receipt.companion.created",
  upgraded: "settings.integrations.receipt.companion.upgraded",
  retained: "settings.integrations.receipt.companion.retained",
  removed: "settings.integrations.receipt.companion.removed",
  restored: "settings.integrations.receipt.companion.restored",
  unknown: "settings.integrations.receipt.companion.unknown"
};
const receiptCleanupKeys: Record<IntegrationTransactionReceipt["cleanup"], TranslationKey> = {
  clean: "settings.integrations.receipt.cleanup.clean",
  pending: "settings.integrations.receipt.cleanup.pending"
};
const receiptNextActionKeys: Record<
  IntegrationTransactionReceipt["nextSafeAction"],
  TranslationKey
> = {
  none: "settings.integrations.receipt.next.none",
  "create-new-plan": "settings.integrations.receipt.next.create-new-plan",
  "recover-transaction": "settings.integrations.receipt.next.recover-transaction"
};
const integrationErrorKeys: Readonly<Record<string, TranslationKey>> = {
  INVALID_INTEGRATION_HARNESS: "settings.integrations.error.invalidHarness",
  INVALID_INTEGRATION_PLAN_REQUEST: "settings.integrations.error.invalidPlan",
  REVIEWED_PLAN_NOT_FOUND: "settings.integrations.error.planNotFound",
  REVIEWED_PLAN_EXPIRED: "settings.integrations.error.planExpired",
  REVIEWED_PLAN_KIND_MISMATCH: "settings.integrations.error.invalidPlan",
  REVIEWED_PLAN_INVALID: "settings.integrations.error.invalidPlan",
  REVIEWED_PLAN_CONFLICT: "settings.integrations.error.invalidPlan",
  REVIEWED_PLAN_UNSAFE_STATE: "settings.integrations.error.invalidPlan",
  INTEGRATION_PLAN_EXPIRED: "settings.integrations.error.planExpired",
  INTEGRATION_PLAN_INVALID: "settings.integrations.error.invalidPlan",
  INTEGRATION_PLAN_MISMATCH: "settings.integrations.error.planMismatch",
  INTEGRATION_DRIFTED: "settings.integrations.error.drifted",
  INTEGRATION_TRANSACTION_FAILED: "settings.integrations.error.transactionFailed",
  INTEGRATION_RECOVERY_REQUIRED: "settings.integrations.error.recoveryRequired",
  INTEGRATION_RECOVERY_NOT_REQUIRED: "settings.integrations.error.recoveryNotRequired",
  INTEGRATION_RECOVERY_UNAVAILABLE: "settings.integrations.error.recoveryUnavailable",
  INTEGRATION_RECOVERY_RECORD_CONTRADICTORY: "settings.integrations.error.recoveryUnavailable",
  INTEGRATION_RECOVERY_PLAN_STALE: "settings.integrations.error.recoveryStale",
  INTEGRATION_RECOVERY_INCOMPLETE: "settings.integrations.error.recoveryIncomplete",
  INTEGRATION_PLATFORM_UNSUPPORTED: "settings.integrations.error.recoveryPlatform"
};

interface IntegrationUiError {
  code: string;
  transport: boolean;
  retainedPlan: boolean;
}

export function HarnessIntegrationsPanel() {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const [plan, setPlan] = useState<ReviewedIntegrationPlan | null>(null);
  const [result, setResult] = useState<IntegrationMutationResult | null>(null);
  const [operation, setOperation] = useState<IntegrationOperationState>("idle");
  const [operationError, setOperationError] = useState<IntegrationUiError | null>(null);
  const [recoveryPlan, setRecoveryPlan] = useState<IntegrationRecoveryPlan | null>(null);
  const [recoveryResult, setRecoveryResult] = useState<IntegrationRecoveryReceipt | null>(null);
  const operationGuard = useRef(createIntegrationOperationGuard());
  const recoveryConfirmRef = useRef<HTMLButtonElement>(null);
  const integrations = useQuery({ queryKey: ["integrations"], queryFn: fetchIntegrations });
  const capabilities = useQuery({
    queryKey: ["integrations", "capabilities"],
    queryFn: fetchIntegrationCapabilities
  });
  const recovery = useQuery({
    queryKey: ["integration-recovery"],
    queryFn: fetchIntegrationRecovery
  });
  useEffect(() => () => operationGuard.current.invalidate(), []);
  useEffect(() => {
    if (recoveryPlan) recoveryConfirmRef.current?.focus();
  }, [recoveryPlan]);

  const reviewPlan = async (harness: IntegrationHarness, disconnect: boolean) => {
    const token = operationGuard.current.begin("reviewing");
    if (!token) return;
    setOperation("reviewing");
    setOperationError(null);
    try {
      const reviewed = await (disconnect
        ? planHarnessDisconnect(harness)
        : planHarnessIntegration(harness));
      operationGuard.current.commit(token, () => {
        setResult(null);
        setPlan(reviewed);
      });
    } catch (error) {
      if (operationGuard.current.commit(token, () => {
        setOperationError(uiError(error));
        if (!(error instanceof ApiTransportError)) {
          setPlan(null);
          setResult(null);
        }
      }) && !(error instanceof ApiTransportError)) {
        await queryClient.invalidateQueries({ queryKey: ["integrations"] });
      }
    } finally {
      if (operationGuard.current.finish(token)) setOperation("idle");
    }
  };

  const applyPlan = async (reviewed: ReviewedIntegrationPlan) => {
    const token = operationGuard.current.begin("applying");
    if (!token) return;
    setOperation("applying");
    setOperationError(null);
    try {
      const value = await (reviewed.action === "disconnect"
        ? disconnectHarnessIntegration({ harness: reviewed.harness, planId: reviewed.planId })
        : applyHarnessIntegration({ harness: reviewed.harness, planId: reviewed.planId }));
      if (operationGuard.current.commit(token, () => {
        setResult(value);
        setPlan(null);
      })) {
        await queryClient.invalidateQueries({ queryKey: ["integrations"] });
        await queryClient.invalidateQueries({ queryKey: ["integration-recovery"] });
      }
    } catch (error) {
      const transport = error instanceof ApiTransportError;
      if (operationGuard.current.commit(token, () => {
        setOperationError(uiError(error, transport));
        if (!transport) {
          const receipt = receiptFromError(error);
          setResult(receipt ? {
            planId: reviewed.planId,
            action: reviewed.action === "blocked" ? "connect" : reviewed.action,
            receipt
          } : null);
          setPlan(null);
        }
      }) && !transport) {
        await queryClient.invalidateQueries({ queryKey: ["integrations"] });
      }
    } finally {
      if (operationGuard.current.finish(token)) setOperation("idle");
    }
  };

  const reviewRecovery = async () => {
    const token = operationGuard.current.begin("reviewing");
    if (!token) return;
    setOperation("reviewing");
    setOperationError(null);
    try {
      const reviewed = await planIntegrationRecovery();
      operationGuard.current.commit(token, () => {
        setRecoveryResult(null);
        setRecoveryPlan(reviewed);
      });
    } catch (error) {
      operationGuard.current.commit(token, () => {
        setOperationError(uiError(error));
        if (!(error instanceof ApiTransportError)) setRecoveryPlan(null);
      });
    } finally {
      if (operationGuard.current.finish(token)) setOperation("idle");
    }
  };

  const confirmRecovery = async () => {
    if (!recoveryPlan) return;
    const token = operationGuard.current.begin("applying");
    if (!token) return;
    setOperation("applying");
    setOperationError(null);
    try {
      const receipt = await applyIntegrationRecovery(recoveryPlan.planId);
      if (operationGuard.current.commit(token, () => {
        setRecoveryResult(receipt);
        setRecoveryPlan(null);
      })) {
        await queryClient.invalidateQueries({ queryKey: ["integrations"] });
        await queryClient.invalidateQueries({ queryKey: ["integration-recovery"] });
      }
    } catch (error) {
      const transport = error instanceof ApiTransportError;
      operationGuard.current.commit(token, () => {
        setOperationError(uiError(error, transport));
        if (!transport) setRecoveryPlan(null);
      });
      if (!transport) {
        await queryClient.invalidateQueries({ queryKey: ["integration-recovery"] });
      }
    } finally {
      if (operationGuard.current.finish(token)) setOperation("idle");
    }
  };

  const cancelPlan = () => {
    if (operationGuard.current.state() !== "idle") return;
    setPlan(null);
    setOperationError(null);
  };
  const statuses = Array.isArray(integrations.data) ? integrations.data : [];
  const recoveryStatus = recovery.data && !Array.isArray(recovery.data)
    ? recovery.data
    : undefined;
  const recoveryBlocksChanges = recoveryStatus !== undefined && recoveryStatus.state !== "clear";
  const queryError = integrations.error ?? capabilities.error ?? recovery.error;
  const planName = plan ? actionName(plan.action, t) : "";
  const selectedHarnessName = plan ? harnessName(plan.harness) : "";
  const confirmLabel = plan
    ? locale === "zh-CN"
      ? `确认为 ${selectedHarnessName} ${planName}`
      : `Confirm ${planName} for ${selectedHarnessName}`
    : "";

  return (
    <section className="settings-card integrations-card">
      <header>
        <div>
          <Cable size={17} />
          <div>
            <h2>{t("settings.integrations.title")}</h2>
            <p>{t("settings.integrations.copy")}</p>
          </div>
        </div>
      </header>
      {recoveryStatus ? (
        <section
          className="integration-recovery-banner"
          data-state={recoveryStatus.state}
          role={recoveryStatus.state === "unknown" ? "alert" : "status"}
          aria-live="polite"
        >
          <div className="integration-recovery-heading">
            <TriangleAlert size={18} />
            <div>
              <h3>{t(recoveryStatus.state === "clear"
                ? "settings.integrations.recovery.clearTitle"
                : "settings.integrations.recovery.title")}</h3>
              <p>{t(`settings.integrations.recovery.copy.${recoveryStatus.state}` as TranslationKey)}</p>
            </div>
          </div>
          {"transaction" in recoveryStatus && recoveryStatus.transaction ? (
            <dl>
              <div><dt>{t("settings.integrations.recovery.harness")}</dt><dd>{harnessName(recoveryStatus.transaction.harness)}</dd></div>
              <div><dt>{t("settings.integrations.recovery.phase")}</dt><dd>{recoveryStatus.transaction.phase}</dd></div>
              <div><dt>{t("settings.integrations.recovery.transaction")}</dt><dd><code>{recoveryStatus.transaction.transactionId}</code></dd></div>
            </dl>
          ) : null}
          {recoveryStatus.recoverable ? (
            <button
              className="button"
              disabled={operation !== "idle" || recoveryPlan !== null}
              onClick={() => void reviewRecovery()}
            >
              {t("settings.integrations.recovery.review")}
            </button>
          ) : null}
        </section>
      ) : null}
      {recoveryPlan ? (
        <section className="integration-recovery-plan" aria-live="polite">
          <header>
            <div>
              <h3>{t("settings.integrations.recovery.planTitle")}</h3>
              <p>{t(`settings.integrations.recovery.action.${recoveryPlan.action}` as TranslationKey)}</p>
            </div>
            <span>{recoveryPlan.transaction.phase}</span>
          </header>
          <p>{t("settings.integrations.recovery.planNotice")}</p>
          <footer className="integration-plan-actions">
            <button
              className="button"
              disabled={operation !== "idle"}
              onClick={() => setRecoveryPlan(null)}
            >
              {t("settings.cancel")}
            </button>
            <button
              ref={recoveryConfirmRef}
              className="button primary"
              disabled={operation !== "idle" || !recoveryPlan.availability.available}
              onClick={() => void confirmRecovery()}
            >
              {t("settings.integrations.recovery.confirm")}
            </button>
          </footer>
        </section>
      ) : null}
      {recoveryResult ? (
        <p
          className="integration-recovery-result"
          data-outcome={recoveryResult.outcome}
          role={recoveryResult.outcome === "recovered" ? "status" : "alert"}
          tabIndex={-1}
        >
          {t(recoveryResult.outcome === "recovered"
            ? "settings.integrations.recovery.completed"
            : "settings.integrations.recovery.incomplete")}
        </p>
      ) : null}
      <div className="integration-list">
        {harnesses.map((harness) => {
          const status = statuses.find((item) => item.harness === harness);
          const capability = capabilities.data?.find((item) => item.harness === harness);
          const statusFallback = integrations.isPending ? "loading" : "unavailable";
          const hookStatus = status?.hook.status ?? statusFallback;
          const companionStatus = status?.companion.status ?? statusFallback;
          const name = capability?.displayName ?? harnessName(harness);
          const articleLabel = t("settings.integrations.articleLabel").replace("{name}", name);
          const disconnect = status !== undefined
            && (hookStatus === "installed" || hookStatus === "needs-trust")
            && companionStatus === "current";
          const reviewLabel = disconnect
            ? locale === "zh-CN"
              ? `检查 ${name} 断开连接`
              : `Review disconnect for ${name}`
            : locale === "zh-CN"
              ? `检查 ${name} 集成`
              : `Review ${name} integration`;
          return (
            <article
              className="integration-row"
              key={harness}
              data-status={hookStatus}
              aria-label={articleLabel}
            >
              <div className="integration-identity">
                <span>{hookStatus === "installed"
                  ? <Check size={17} />
                  : hookStatus === "needs-trust"
                    ? <ShieldAlert size={17} />
                    : <Cable size={17} />}</span>
                <div>
                  <strong>{name}</strong>
                  <div className="integration-domain-status">
                    <p>{`${t("settings.integrations.hook")}: ${t(`settings.integrations.status.${hookStatus}` as TranslationKey)}`}</p>
                    <p data-companion-status={companionStatus}>{`${t("settings.integrations.companion")}: ${t(`settings.integrations.companionStatus.${companionStatus}` as TranslationKey)}`}</p>
                  </div>
                </div>
              </div>
              <div className="integration-capabilities">
                <span data-mode={capability?.mode ?? "unknown"}>{capability?.mode === "observe-only"
                  ? t("settings.integrations.observeOnly")
                  : t("settings.integrations.recommendObserve")}</span>
                <span>{capability?.events?.join(" · ") ?? t("settings.integrations.capabilityLoading")}</span>
                {capability?.mode === "observe-only"
                  ? <span className="companion-capability">{t("settings.integrations.companionRecommendation")}</span>
                  : null}
              </div>
              <div className="integration-actions">
                <button
                  className="button"
                  aria-label={reviewLabel}
                  disabled={operation !== "idle" || status === undefined || recoveryBlocksChanges}
                  onClick={() => void reviewPlan(harness, disconnect)}
                >
                  {disconnect
                    ? t("settings.integrations.reviewDisconnect")
                    : t("settings.integrations.review")}
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {plan ? (
        <section className="integration-plan" aria-live="polite">
          <header>
            <h3>{planName}</h3>
            <span>{selectedHarnessName}</span>
          </header>
          <dl className="integration-targets">
            <div>
              <dt>{t("settings.integrations.hookTarget")}</dt>
              <dd><code>{plan.targets.hook}</code></dd>
            </div>
            <div>
              <dt>{t("settings.integrations.companionTarget")}</dt>
              <dd><code>{plan.targets.companion}</code></dd>
            </div>
          </dl>
          <ul>{plan.artifacts.map((artifact) => (
            <li key={`${artifact.role}:${artifact.operation}`}>
              <span>{t(artifactActionKeys[artifact.operation])}</span>
              <span>{t(artifactRoleKeys[artifact.role])}</span>
            </li>
          ))}</ul>
          {plan.action === "disconnect"
            ? <p className="integration-retained-note">{t(plan.companion === "removed"
                ? "settings.integrations.lastConsumerRemoved"
                : "settings.integrations.companionRetainedForOthers")}</p>
            : null}
          {plan.availability.available ? (
            <footer className="integration-plan-actions">
              <button
                className="button"
                disabled={operation !== "idle"}
                onClick={cancelPlan}
              >
                {t("settings.cancel")}
              </button>
              <button
                className="button primary"
                aria-label={confirmLabel}
                disabled={operation !== "idle"}
                onClick={() => void applyPlan(plan)}
              >
                {t("settings.integrations.confirm")}
              </button>
            </footer>
          ) : (
            <p className="integration-unavailable" role="status">
              {unavailableReason(plan.availability.reason, t)}
            </p>
          )}
        </section>
      ) : null}
      {result ? (
        <p
          className="integration-result"
          data-cleanup={result.receipt.cleanup}
          role={result.receipt.cleanup === "pending" ? "alert" : "status"}
        >
          {receiptText(result, t)}
        </p>
      ) : null}
      {operationError
        ? <p className="form-error" role="alert">{integrationErrorText(operationError, t)}</p>
        : null}
      {queryError
        ? <p className="form-error" role="alert">{integrationErrorText(uiError(queryError), t)}</p>
        : null}
    </section>
  );
}

function actionName(
  action: ReviewedIntegrationPlan["action"],
  t: (key: TranslationKey) => string
): string {
  return t(`settings.integrations.action.${action}` as TranslationKey);
}

function unavailableReason(
  reason: string | null,
  t: (key: TranslationKey) => string
): string {
  return t(reason && unavailableReasonKeys[reason]
    ? unavailableReasonKeys[reason]
    : "settings.integrations.reason.unknown");
}

function receiptText(
  result: IntegrationMutationResult,
  t: (key: TranslationKey) => string
): string {
  return [
    receiptOutcomeKeys[result.receipt.outcome],
    receiptCompanionKeys[result.receipt.companion],
    receiptHookKeys[result.receipt.hook],
    receiptCleanupKeys[result.receipt.cleanup],
    receiptNextActionKeys[result.receipt.nextSafeAction]
  ].map(t).join(" · ");
}

function uiError(error: unknown, retainedPlan = false): IntegrationUiError {
  if (error instanceof ApiTransportError) {
    return {
      code: "INTEGRATION_TRANSPORT_FAILED",
      transport: true,
      retainedPlan
    };
  }
  return {
    code: error instanceof ApiRequestError ? error.code : "INTEGRATION_OPERATION_FAILED",
    transport: false,
    retainedPlan: false
  };
}

function integrationErrorText(
  error: IntegrationUiError,
  t: (key: TranslationKey) => string
): string {
  if (error.transport) {
    return t(error.retainedPlan
      ? "settings.integrations.error.transport"
      : "settings.integrations.error.queryTransport");
  }
  return t(integrationErrorKeys[error.code] ?? "settings.integrations.error.generic");
}

function receiptFromError(error: unknown): IntegrationTransactionReceipt | null {
  if (!(error instanceof ApiRequestError) || !isObject(error.data)) return null;
  const receipt = error.data.receipt;
  if (!isObject(receipt)) return null;
  if (
    !isOneOf(receipt.outcome, ["ready", "rolled-back", "recovery-required"])
    || !isOneOf(receipt.hook, ["unchanged", "installed", "removed", "restored", "unknown"])
    || !isOneOf(receipt.companion, [
      "unchanged",
      "created",
      "upgraded",
      "retained",
      "removed",
      "restored",
      "unknown"
    ])
    || !isOneOf(receipt.cleanup, ["clean", "pending"])
    || !isOneOf(receipt.nextSafeAction, [
      "none",
      "create-new-plan",
      "recover-transaction"
    ])
    || typeof receipt.transactionId !== "string"
    || typeof receipt.recordId !== "string"
    || typeof receipt.reasonCode !== "string"
  ) {
    return null;
  }
  return receipt as unknown as IntegrationTransactionReceipt;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T
): value is T[number] {
  return typeof value === "string" && choices.includes(value);
}
