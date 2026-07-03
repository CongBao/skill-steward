import { useI18n, type TranslationKey } from "../i18n/catalog.js";

export function SeverityBadge({ severity }: { severity: "info" | "warning" | "error" | "critical" }) {
  const { t } = useI18n();
  return <span className="severity-badge" data-severity={severity}>{t(`severity.${severity}` as TranslationKey)}</span>;
}
