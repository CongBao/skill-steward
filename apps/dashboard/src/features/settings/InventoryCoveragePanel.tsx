import { ChevronDown, Database, TriangleAlert } from "lucide-react";
import type {
  DashboardSnapshot,
  HarnessCoverage,
  InventorySource
} from "../../api/client.js";
import { useI18n, type TranslationKey } from "../../i18n/catalog.js";

const coreHarnesses = ["codex", "claude", "github-copilot"] as const;

function replaceCount(value: string, count: number): string {
  return value.replace("{count}", String(count));
}

function harnessName(harness: string, t: (key: TranslationKey) => string): string {
  const keyByHarness: Record<string, TranslationKey> = {
    codex: "harness.codex",
    claude: "harness.claude",
    "github-copilot": "harness.github-copilot",
    agents: "harness.agents"
  };
  const key = keyByHarness[harness];
  return key ? t(key) : harness;
}

function statusLabel(status: HarnessCoverage["status"], t: (key: TranslationKey) => string): string {
  return t(`settings.inventory.status.${status}` as TranslationKey);
}

function guidanceKey(source: InventorySource): TranslationKey {
  if (source.status === "invalid") return "settings.inventory.guidance.invalid";
  if (source.status === "unreadable") return "settings.inventory.guidance.unreadable";
  if (source.status === "truncated") return "settings.inventory.guidance.truncated";
  if (source.status === "ambiguous") return "settings.inventory.guidance.ambiguous";
  if (source.status === "missing") return "settings.inventory.guidance.missing";
  if (source.status === "disabled" || source.status === "stale") {
    return "settings.inventory.guidance.inactive";
  }
  return "settings.inventory.guidance.review";
}

function SourceDetail({ source }: { source: InventorySource }) {
  const { t } = useI18n();
  return (
    <li className="inventory-source" data-status={source.status}>
      <div className="inventory-source-title">
        <span>{t(`settings.inventory.sourceStatus.${source.status}` as TranslationKey)}</span>
        <strong>{t(`settings.inventory.kind.${source.kind}` as TranslationKey)}</strong>
        <span>{t(`scope.${source.scope}` as TranslationKey)}</span>
      </div>
      <code className="inventory-source-path">{source.path}</code>
      {source.plugin ? (
        <div className="inventory-source-plugin">
          <span>{t("settings.inventory.plugin")}</span>
          <code>{source.plugin.id}{source.plugin.version ? ` · v${source.plugin.version}` : ""}</code>
        </div>
      ) : null}
      {source.diagnostic ? (
        <div className="inventory-diagnostic">
          <TriangleAlert size={13} />
          <div>
            <code>{source.diagnostic.code}</code>
            <p>{t(guidanceKey(source))}</p>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function CoverageCard({
  coverage,
  sources
}: {
  coverage: HarnessCoverage;
  sources: InventorySource[];
}) {
  const { locale, t } = useI18n();
  const harness = harnessName(coverage.harness, t);
  const status = statusLabel(coverage.status, t);
  const ariaLabel = `${harness}${locale === "zh-CN" ? "：" : ": "}${status}`;
  return (
    <article className="inventory-coverage-card" data-status={coverage.status} aria-label={ariaLabel}>
      <header>
        <strong>{harness}</strong>
        <span className="inventory-coverage-status">{status}</span>
      </header>
      <div className="inventory-counts">
        <span><strong>{sources.length}</strong> {replaceCount(t("settings.inventory.sources"), sources.length)}</span>
        <span><strong>{coverage.skillCount}</strong> {t("settings.inventory.skills")}</span>
        <span><strong>{coverage.effectiveSkillCount}</strong> {t("settings.inventory.effective")}</span>
      </div>
      {sources.length > 0 ? (
        <details className="inventory-source-disclosure">
          <summary>
            <span>{replaceCount(t("settings.inventory.inspectAll"), sources.length)}</span>
            <ChevronDown size={15} />
          </summary>
          <ul>{sources.map((source) => <SourceDetail key={source.id} source={source} />)}</ul>
        </details>
      ) : null}
    </article>
  );
}

function CoverageGroup({
  title,
  coverages,
  sourceById,
  collapsible = false
}: {
  title: string;
  coverages: HarnessCoverage[];
  sourceById: ReadonlyMap<string, InventorySource>;
  collapsible?: boolean;
}) {
  if (coverages.length === 0) return null;
  const cards = coverages.map((coverage) => (
    <CoverageCard
      key={coverage.harness}
      coverage={coverage}
      sources={coverage.sourceIds.flatMap((sourceId) => {
        const source = sourceById.get(sourceId);
        return source ? [source] : [];
      })}
    />
  ));
  if (collapsible) {
    return (
      <details
        className="inventory-coverage-group inventory-coverage-group-disclosure"
        role="region"
        aria-label={title}
      >
        <summary>
          <span className="inventory-coverage-group-title" role="heading" aria-level={3}>{title}</span>
          <span className="inventory-coverage-group-count">{coverages.length}</span>
          <ChevronDown size={15} />
        </summary>
        <div className="inventory-coverage-grid">{cards}</div>
      </details>
    );
  }
  return (
    <section className="inventory-coverage-group" role="region" aria-label={title}>
      <h3>{title}</h3>
      <div className="inventory-coverage-grid">{cards}</div>
    </section>
  );
}

export function InventoryCoveragePanel({
  inventory,
  loading = false,
  error = false
}: {
  inventory: DashboardSnapshot["inventory"] | undefined;
  loading?: boolean;
  error?: boolean;
}) {
  const { t } = useI18n();
  const sourceById = new Map((inventory?.sources ?? []).map((source) => [source.id, source]));
  const coverageByHarness = new Map((inventory?.harnesses ?? []).map((coverage) => [coverage.harness, coverage]));
  const core = coreHarnesses.map((harness): HarnessCoverage => coverageByHarness.get(harness) ?? ({
    harness,
    status: "unavailable",
    sourceIds: [],
    skillCount: 0,
    effectiveSkillCount: 0
  }));
  const conventions = (inventory?.harnesses ?? []).filter(({ harness }) =>
    !coreHarnesses.includes(harness as (typeof coreHarnesses)[number])
  );

  return (
    <section className="settings-card inventory-coverage-panel" role="region" aria-label={t("settings.inventory.title")}>
      <header>
        <div><Database size={17} /><div><h2>{t("settings.inventory.title")}</h2><p>{t("settings.inventory.copy")}</p></div></div>
      </header>
      {loading ? <p className="inventory-coverage-empty">{t("app.loadingLocalData")}</p> : error ? (
        <p className="inventory-coverage-empty">{t("settings.inventory.unavailable")}</p>
      ) : !inventory ? (
        <p className="inventory-coverage-empty">{t("settings.inventory.rescan")}</p>
      ) : (
        <div className="inventory-coverage-groups">
          <CoverageGroup title={t("settings.inventory.core")} coverages={core} sourceById={sourceById} />
          <CoverageGroup
            title={t("settings.inventory.conventions")}
            coverages={conventions}
            sourceById={sourceById}
            collapsible
          />
        </div>
      )}
    </section>
  );
}
