import { useMutation } from "@tanstack/react-query";
import { Download, ExternalLink, ShieldAlert } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  inspectCatalogCandidate,
  type PreflightCandidate
} from "../../api/client.js";
import { SeverityBadge } from "../../components/SeverityBadge.js";
import { useI18n, type TranslationKey } from "../../i18n/catalog.js";
import { preflightReasonDetail } from "./reasonDetail.js";

export function AvailableCandidateCard({
  candidate,
  preflightId
}: {
  candidate: PreflightCandidate;
  preflightId?: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const inspect = useMutation({
    mutationFn: () => inspectCatalogCandidate(
      candidate.catalogSkillId ?? candidate.candidateId,
      preflightId
    ),
    onSuccess: (installationPreview) => navigate("/skills", { state: { installationPreview } })
  });
  const source = candidate.source;
  const trust = source?.trust ?? "user";
  const installable = candidate.decision === "install";

  return (
    <article className="preflight-candidate available-candidate" data-decision={candidate.decision}>
      <header>
        <div><h3>{candidate.name}</h3><p>{candidate.description}</p></div>
        {candidate.highestSeverity ? <SeverityBadge severity={candidate.highestSeverity} /> : null}
      </header>
      <div className="available-source">
        <span>{t(`preflight.trust.${trust}` as TranslationKey)}</span>
        <strong>{source?.sourceId ?? t("preflight.unknownSource")}</strong>
        {source?.revision ? <code>{source.revision.slice(0, 8)}</code> : null}
      </div>
      <div className="preflight-metadata">
        <span>{t("preflight.compatibility")}: <strong>{t(`preflight.compatibility.${candidate.compatibility}` as TranslationKey)}</strong></span>
        <span>{t("preflight.harnesses")}: <strong>{candidate.compatibleHarnesses.join(", ") || "—"}</strong></span>
        <span>{t("preflight.tokens")}: <strong>{candidate.contextTokens}</strong></span>
      </div>
      {(candidate.scripts.length || candidate.executables.length) ? (
        <div className="available-risk"><ShieldAlert size={15} /><span>{t("preflight.executableNotice").replace("{count}", String(new Set([...candidate.scripts, ...candidate.executables]).size))}</span></div>
      ) : null}
      <ul className="preflight-reasons">
        {candidate.reasons.map((reason, index) => <li key={`${reason.code}-${index}`}><span>{t(`preflight.reason.${reason.code}` as TranslationKey)}</span><p>{preflightReasonDetail(candidate, reason, t)}</p></li>)}
      </ul>
      <footer>
        {source ? <a className="source-link" href={source.url} rel="noreferrer" target="_blank"><ExternalLink size={13} />{t("preflight.source")}</a> : <span />}
        {installable ? <button className="button primary" aria-label={`${t("preflight.inspectInstallation")} ${candidate.name}`} disabled={inspect.isPending} onClick={() => inspect.mutate()}>
          <Download size={15} />{inspect.isPending ? t("preflight.inspectingInstallation") : t("preflight.inspectInstallation")}
        </button> : null}
      </footer>
      {inspect.error ? <p className="form-error" role="alert">{inspect.error.message}</p> : null}
    </article>
  );
}
