import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  addCatalogSource,
  fetchCatalogSources,
  refreshCatalog,
  removeCatalogSource,
  setCatalogSourceEnabled,
  type CatalogSource
} from "../../api/client.js";
import { useI18n, type TranslationKey } from "../../i18n/catalog.js";

function publisherLabel(trust: CatalogSource["trust"], t: (key: TranslationKey) => string) {
  return t(`settings.catalogSources.trust.${trust}` as TranslationKey);
}

export function CatalogSourcesPanel() {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ id: "", name: "", url: "", ref: "", subdirectory: "" });
  const sourcesQuery = useQuery({ queryKey: ["catalog-sources"], queryFn: fetchCatalogSources });
  const refresh = useMutation({
    mutationFn: refreshCatalog,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["catalog-sources"] })
  });
  const toggle = useMutation({
    mutationFn: ({ source, enabled }: { source: CatalogSource; enabled: boolean }) => {
      if (enabled && !window.confirm(t("settings.catalogSources.enableConfirm").replace("{name}", source.name))) {
        return Promise.resolve(source);
      }
      return setCatalogSourceEnabled(source.id, enabled);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["catalog-sources"] })
  });
  const add = useMutation({
    mutationFn: () => addCatalogSource({
      id: form.id,
      name: form.name,
      url: form.url,
      ...(form.ref ? { ref: form.ref } : {}),
      ...(form.subdirectory ? { subdirectory: form.subdirectory } : {})
    }),
    onSuccess: async () => {
      setForm({ id: "", name: "", url: "", ref: "", subdirectory: "" });
      setAdding(false);
      await queryClient.invalidateQueries({ queryKey: ["catalog-sources"] });
    }
  });
  const remove = useMutation({
    mutationFn: (source: CatalogSource) => removeCatalogSource(source.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["catalog-sources"] })
  });
  const data = sourcesQuery.data && !Array.isArray(sourcesQuery.data) ? sourcesQuery.data : null;
  const stateBySource = new Map(data?.snapshot?.sources.map((state) => [state.sourceId, state]) ?? []);

  const refreshExplicitly = () => {
    if (window.confirm(t("settings.catalogSources.refreshConfirm"))) refresh.mutate();
  };

  return (
    <section className="settings-card catalog-sources-card" id="catalog-sources" tabIndex={-1}>
      <header>
        <div><Database size={17} /><div><h2>{t("settings.catalogSources.title")}</h2><p>{t("settings.catalogSources.copy")}</p></div></div>
        <button className="button" aria-label={t("settings.catalogSources.refresh")} disabled={refresh.isPending} onClick={refreshExplicitly}>
          <RefreshCw size={15} />{refresh.isPending ? t("settings.catalogSources.refreshing") : t("settings.catalogSources.refresh")}
        </button>
      </header>
      <div className="catalog-source-list">
        {(data?.sources ?? []).map((source) => {
          const state = stateBySource.get(source.id);
          return (
            <article className="catalog-source-row" key={source.id} data-enabled={source.enabled}>
              <div className="catalog-source-main">
                <div><strong>{source.name}</strong><span className={`source-status ${state?.status ?? "disabled"}`}>{state?.status ?? t("settings.catalogSources.notRefreshed")}</span></div>
                <p>{publisherLabel(source.trust, t)}</p>
                <code>{source.url}</code>
              </div>
              <div className="catalog-source-meta">
                {state?.commitSha ? <code>{state.commitSha.slice(0, 8)}</code> : null}
                {state?.refreshedAt ? <time dateTime={state.refreshedAt}>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(state.refreshedAt))}</time> : null}
                <span>{state?.skillCount ?? 0} Skills</span>
              </div>
              <div className="catalog-source-actions">
                <button className="button" aria-label={`${source.enabled ? t("settings.catalogSources.disable") : t("settings.catalogSources.enable")} ${source.name}`} disabled={toggle.isPending} onClick={() => toggle.mutate({ source, enabled: !source.enabled })}>
                  {source.enabled ? t("settings.catalogSources.disable") : t("settings.catalogSources.enable")}
                </button>
                {!source.preset ? <button className="icon-button" aria-label={`${t("settings.catalogSources.remove")} ${source.name}`} onClick={() => window.confirm(t("settings.catalogSources.removeConfirm").replace("{name}", source.name)) && remove.mutate(source)}><Trash2 size={15} /></button> : null}
              </div>
            </article>
          );
        })}
      </div>
      {adding ? (
        <form className="catalog-source-form" onSubmit={(event) => { event.preventDefault(); add.mutate(); }}>
          <label>{t("settings.catalogSources.id")}<input required pattern="[a-z0-9][a-z0-9-]{1,63}" value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} /></label>
          <label>{t("settings.catalogSources.name")}<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label className="wide">{t("settings.catalogSources.url")}<input required type="url" placeholder="https://github.com/owner/repository.git" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} /></label>
          <label>{t("settings.catalogSources.ref")}<input value={form.ref} onChange={(event) => setForm({ ...form, ref: event.target.value })} /></label>
          <label>{t("settings.catalogSources.subdirectory")}<input value={form.subdirectory} onChange={(event) => setForm({ ...form, subdirectory: event.target.value })} /></label>
          <p className="wide">{t("settings.catalogSources.addNotice")}</p>
          <footer className="wide"><button className="button" type="button" onClick={() => setAdding(false)}>{t("settings.cancel")}</button><button className="button primary" disabled={add.isPending} type="submit">{t("settings.catalogSources.add")}</button></footer>
        </form>
      ) : <button className="text-action" onClick={() => setAdding(true)}><Plus size={15} />{t("settings.catalogSources.add")}</button>}
      {(sourcesQuery.error || refresh.error || toggle.error || add.error || remove.error) ? <p className="form-error" role="alert">{String(sourcesQuery.error ?? refresh.error ?? toggle.error ?? add.error ?? remove.error)}</p> : null}
    </section>
  );
}
