import { Cable, Database, Route, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useI18n } from "../../i18n/catalog.js";
import { usePreferences } from "../../theme/preferences.js";

const titleId = "overview-first-value-guide-title";

export function FirstValueGuide() {
  const { t } = useI18n();
  const { update } = usePreferences();

  return (
    <section className="first-value-guide" role="region" aria-labelledby={titleId}>
      <header>
        <div>
          <span className="section-eyebrow">{t("overview.guide.eyebrow")}</span>
          <h2 id={titleId}>{t("overview.guide.title")}</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label={t("overview.guide.dismiss")}
          onClick={() => update({ showFirstValueGuide: false })}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="first-value-guide-actions">
        <Link className="first-value-guide-card primary" to="/preflight" aria-label={t("overview.guide.preflightAction")}>
          <Route size={18} aria-hidden="true" />
          <span><strong>{t("overview.guide.preflightTitle")}</strong><small>{t("overview.guide.preflightCopy")}</small></span>
        </Link>
        <Link className="first-value-guide-card" to="/settings#catalog-sources" aria-label={t("overview.guide.catalogAction")}>
          <Database size={18} aria-hidden="true" />
          <span><strong>{t("overview.guide.catalogTitle")}</strong><small>{t("overview.guide.catalogCopy")}</small></span>
        </Link>
        <Link className="first-value-guide-card" to="/settings#harness-integrations" aria-label={t("overview.guide.integrationAction")}>
          <Cable size={18} aria-hidden="true" />
          <span><strong>{t("overview.guide.integrationTitle")}</strong><small>{t("overview.guide.integrationCopy")}</small></span>
        </Link>
      </div>
    </section>
  );
}
