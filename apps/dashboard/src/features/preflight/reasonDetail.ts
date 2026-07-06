import type { PreflightCandidate } from "../../api/client.js";
import type { TranslationKey } from "../../i18n/catalog.js";

export function preflightReasonDetail(
  candidate: PreflightCandidate,
  reason: PreflightCandidate["reasons"][number],
  t: (key: TranslationKey) => string
): string {
  const percent = (value: number) => String(Math.round(value * 100));
  switch (reason.code) {
    case "NAME_MATCH":
      return t("preflight.reasonDetail.NAME_MATCH").replace("{name}", candidate.name);
    case "HIGH_CONFIDENCE_TRIGGER":
      return t("preflight.reasonDetail.HIGH_CONFIDENCE_TRIGGER");
    case "PROJECT_SCOPE_FIT":
      return t("preflight.reasonDetail.PROJECT_SCOPE_FIT");
    case "UNIQUE_COVERAGE":
      return t("preflight.reasonDetail.UNIQUE_COVERAGE")
        .replace("{percent}", percent(candidate.uniqueCoverage));
    case "REDUNDANT_WITH_SELECTED":
      return t("preflight.reasonDetail.REDUNDANT_WITH_SELECTED")
        .replace("{percent}", percent(candidate.redundancyPenalty));
    case "LOW_RELEVANCE":
      return t("preflight.reasonDetail.LOW_RELEVANCE");
    case "PORTFOLIO_RISK":
      return t("preflight.reasonDetail.PORTFOLIO_RISK")
        .replace("{percent}", percent(candidate.riskPenalty));
    case "INSTALL_REQUIRED":
      return t("preflight.reasonDetail.INSTALL_REQUIRED");
    case "CRITICAL_RISK":
      return t("preflight.reasonDetail.CRITICAL_RISK");
    case "HARNESS_INCOMPATIBLE":
      return t("preflight.reasonDetail.HARNESS_INCOMPATIBLE");
    case "NEGATIVE_TRIGGER":
      return t("preflight.reasonDetail.NEGATIVE_TRIGGER");
    case "CAPABILITY_MATCH":
      return t("preflight.reasonDetail.CAPABILITY_MATCH");
    case "EXACT_TRIGGER_MATCH":
      return t("preflight.reasonDetail.EXACT_TRIGGER_MATCH");
    case "MARGINAL_CAPABILITY":
      return t("preflight.reasonDetail.MARGINAL_CAPABILITY");
    case "REDUNDANT_CAPABILITY":
      return t("preflight.reasonDetail.REDUNDANT_CAPABILITY")
        .replace("{percent}", percent(candidate.redundancyPenalty));
    default:
      return reason.detail;
  }
}
