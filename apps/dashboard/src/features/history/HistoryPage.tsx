import { useQuery } from "@tanstack/react-query";
import { fetchHistory } from "../../api/client.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Sparkline } from "../../components/Sparkline.js";
import { StatePanel } from "../../components/StatePanel.js";
import { useI18n } from "../../i18n/catalog.js";
import "./history.css";

export function HistoryPage() {
  const { locale, t } = useI18n();
  const history = useQuery({ queryKey: ["history"], queryFn: fetchHistory });
  const items = history.data ?? [];
  return (
    <><PageHeader title={t("page.history.title")} description={t("page.history.description")} />
      {items.length ? <><section className="history-summary"><div><span>{t("history.health")}</span><strong>{items[0]?.healthScore}</strong><Sparkline values={[...items].reverse().map((item) => item.healthScore)} label={t("history.health")} /></div><div><span>{t("history.skills")}</span><strong>{items[0]?.skillCount}</strong></div><div><span>{t("history.findings")}</span><strong>{items[0]?.findingCount}</strong></div><div><span>{t("history.context")}</span><strong>{new Intl.NumberFormat(locale, { notation: "compact" }).format(items[0]?.estimatedTokens ?? 0)}</strong></div></section><ol className="history-list">{items.map((item) => <li key={item.generatedAt}><time>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.generatedAt))}</time><span>{t("history.health")} <strong>{item.healthScore}</strong></span><span>{item.skillCount} {t("history.skills")}</span><span>{item.findingCount} {t("history.findings")}</span></li>)}</ol></> : <StatePanel title={t("history.empty")} description={t("page.history.description")} />}
    </>
  );
}
