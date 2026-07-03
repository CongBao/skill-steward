import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, FolderOpen, GitBranch, PackageOpen } from "lucide-react";
import { useState } from "react";
import {
  commitInstallation,
  inspectInstallation,
  requestInstallationPlan,
  type InspectionResult,
  type InstallCandidate,
  type InstallationPlanResult,
  type InstallationTransaction
} from "../../api/client.js";
import { SeverityBadge } from "../../components/SeverityBadge.js";
import { useI18n } from "../../i18n/catalog.js";
import "./installer.css";

type SourceKind = "folder" | "zip" | "git";
type Step = "source" | "inspect" | "destination" | "conflicts" | "confirm" | "result";

const harnesses = [
  "agents", "amazon-q", "antigravity", "auggie", "bob", "claude", "cline",
  "codebuddy", "codex", "forgecode", "continue", "costrict", "crush", "cursor",
  "factory", "gemini", "github-copilot", "iflow", "junie", "kilocode", "kimi",
  "kiro", "lingma", "vibe", "opencode", "pi", "qoder", "qwen", "roocode",
  "trae", "windsurf"
];

async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function InstallSkillFlow({ onClose, initialInspection }: { onClose(): void; initialInspection?: InspectionResult }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const initialCandidate = initialInspection?.candidates.find(({ fingerprint }) => fingerprint) ?? initialInspection?.candidates[0];
  const [step, setStep] = useState<Step>(initialInspection ? "inspect" : "source");
  const [sourceKind, setSourceKind] = useState<SourceKind>("folder");
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [git, setGit] = useState({ url: "", ref: "", subdirectory: "" });
  const [inspection, setInspection] = useState<InspectionResult | null>(initialInspection ?? null);
  const [candidateId, setCandidateId] = useState(initialCandidate?.id ?? "");
  const [harness, setHarness] = useState("claude");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [workspace, setWorkspace] = useState("");
  const [targetName, setTargetName] = useState(initialCandidate?.name ?? "");
  const [plan, setPlan] = useState<InstallationPlanResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<InstallationTransaction | null>(null);
  const candidate = inspection?.candidates.find(({ id }) => id === candidateId) ?? null;

  const inspect = useMutation({
    mutationFn: async () => {
      if (sourceKind === "git") {
        return inspectInstallation({ source: { kind: "git", url: git.url, ...(git.ref ? { ref: git.ref } : {}), ...(git.subdirectory ? { subdirectory: git.subdirectory } : {}) } });
      }
      if (sourceKind === "zip" && zipFile) {
        return inspectInstallation({ source: { kind: "zip", fileName: zipFile.name }, archiveBase64: await base64(zipFile) });
      }
      const files = await Promise.all(folderFiles.map(async (file) => ({
        relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        contentBase64: await base64(file)
      })));
      return inspectInstallation({ source: { kind: "folder", label: folderFiles[0]?.name ?? "local-skill" }, files });
    },
    onSuccess: (data) => {
      setInspection(data);
      const first = data.candidates.find(({ fingerprint }) => fingerprint) ?? data.candidates[0];
      setCandidateId(first?.id ?? "");
      setTargetName(first?.name ?? "");
      setStep("inspect");
    }
  });

  const planMutation = useMutation({
    mutationFn: (conflictAction?: "replace") => requestInstallationPlan({
      previewId: inspection?.previewId,
      candidateId,
      harness,
      scope,
      targetName,
      ...(scope === "project" ? { workspace } : {}),
      ...(conflictAction ? { conflictAction } : {})
    }),
    onSuccess: (data) => {
      setPlan(data);
      setStep(data.status === "conflict" ? "conflicts" : "confirm");
    }
  });

  const commit = useMutation({
    mutationFn: () => commitInstallation(plan?.id ?? ""),
    onSuccess: async (data) => {
      setResult(data);
      setStep("result");
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }
  });

  const steps: Step[] = ["source", "inspect", "destination", "conflicts", "confirm", "result"];
  return (
    <div className="install-flow">
      <ol className="install-steps">
        {steps.map((item, index) => (
          <li key={item} data-active={item === step} data-complete={steps.indexOf(step) > index}>
            <span>{steps.indexOf(step) > index ? <Check size={12} /> : index + 1}</span>{t(`install.${item}`)}
          </li>
        ))}
      </ol>

      {step === "source" ? (
        <section className="install-section">
          <div className="source-tabs">
            <button className={sourceKind === "folder" ? "selected" : ""} onClick={() => setSourceKind("folder")}><FolderOpen size={17} />{t("install.folder")}</button>
            <button className={sourceKind === "zip" ? "selected" : ""} onClick={() => setSourceKind("zip")}><PackageOpen size={17} />{t("install.zip")}</button>
            <button className={sourceKind === "git" ? "selected" : ""} onClick={() => setSourceKind("git")}><GitBranch size={17} />{t("install.git")}</button>
          </div>
          {sourceKind === "folder" ? (
            <label className="file-drop">{t("install.chooseFolder")}<input type="file" multiple ref={(node) => node?.setAttribute("webkitdirectory", "")} onChange={(event) => setFolderFiles([...event.target.files ?? []])} /></label>
          ) : sourceKind === "zip" ? (
            <label className="file-drop">{t("install.chooseZip")}<input type="file" accept=".zip,application/zip" onChange={(event) => setZipFile(event.target.files?.[0] ?? null)} /></label>
          ) : (
            <div className="form-grid">
              <label>{t("install.repoUrl")}<input value={git.url} onChange={(event) => setGit({ ...git, url: event.target.value })} placeholder="https://github.com/owner/repository" /></label>
              <label>{t("install.ref")}<input value={git.ref} onChange={(event) => setGit({ ...git, ref: event.target.value })} placeholder="main / v1.0.0 / SHA" /></label>
              <label>{t("install.subdirectory")}<input value={git.subdirectory} onChange={(event) => setGit({ ...git, subdirectory: event.target.value })} placeholder="skills/review" /></label>
            </div>
          )}
          <div className="risk-notice"><AlertTriangle size={17} /><span>{t("install.riskNotice")}</span></div>
          <footer><button className="button primary" disabled={inspect.isPending || (sourceKind === "git" ? !git.url : sourceKind === "zip" ? !zipFile : !folderFiles.length)} onClick={() => inspect.mutate()}>{inspect.isPending ? t("install.inspecting") : t("install.inspectSource")}</button></footer>
        </section>
      ) : null}

      {step === "inspect" && inspection ? (
        <section className="install-section">
          <h3>{t("install.candidate")}</h3>
          <div className="candidate-list">
            {inspection.candidates.map((item) => (
              <label className="candidate-card" key={item.id} data-selected={candidateId === item.id}>
                <input type="radio" name="candidate" checked={candidateId === item.id} onChange={() => { setCandidateId(item.id); setTargetName(item.name); }} aria-label={`${item.name} — ${item.description}`} />
                <div><strong>{item.name}</strong><p>{item.description}</p><span>{item.files.length} {t("install.files")} · {item.estimatedTokens} {t("install.tokens")}</span></div>
                <code>{item.fingerprint?.slice(0, 18) ?? "invalid"}</code>
              </label>
            ))}
          </div>
          {candidate ? <div className="candidate-findings">{candidate.findings.length ? candidate.findings.map((finding) => <div key={finding.id}><SeverityBadge severity={finding.severity} />{finding.summary}</div>) : t("install.noFindings")}</div> : null}
          <footer><button className="button primary" disabled={!candidate?.fingerprint} onClick={() => setStep("destination")}>{t("install.continue")}</button></footer>
        </section>
      ) : null}

      {step === "destination" ? (
        <section className="install-section"><div className="form-grid two">
          <label>{t("install.targetHarness")}<select value={harness} onChange={(event) => setHarness(event.target.value)}>{harnesses.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label>{t("install.scope")}<select value={scope} onChange={(event) => setScope(event.target.value as "global" | "project")}><option value="global">{t("install.global")}</option><option value="project">{t("install.project")}</option></select></label>
          {scope === "project" ? <label>{t("install.workspace")}<input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="/path/to/project" /></label> : null}
          <label>{t("install.targetName")}<input value={targetName} onChange={(event) => setTargetName(event.target.value)} /></label>
        </div><footer><button className="button primary" disabled={!targetName || (scope === "project" && !workspace) || planMutation.isPending} onClick={() => planMutation.mutate(undefined)}>{t("install.reviewPlan")}</button></footer></section>
      ) : null}

      {step === "conflicts" ? (
        <section className="install-section"><div className="conflict-panel"><AlertTriangle size={24} /><h3>{t("install.conflicts")}</h3><p>{t("install.conflictCopy")}</p></div><footer><button className="button" onClick={() => setStep("destination")}>{t("install.rename")}</button><button className="button primary danger" onClick={() => planMutation.mutate("replace")}>{t("install.replace")}</button></footer></section>
      ) : null}

      {step === "confirm" && plan ? (
        <section className="install-section"><div className="plan-summary"><span>{plan.action}</span><code>{plan.destination}</code>{plan.changes.map((change, index) => <div key={`${change.operation}-${index}`}><strong>{change.operation}</strong><code>{change.path}</code></div>)}</div><label className="confirmation"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t("install.reviewed")}</label><footer><button className="button primary" disabled={!confirmed || commit.isPending} onClick={() => commit.mutate()}>{commit.isPending ? t("install.installing") : t("install.submit")}</button></footer></section>
      ) : null}

      {step === "result" && result ? (
        <section className="install-section result-panel"><span className="success-icon"><Check size={24} /></span><h3>{t("install.success")}</h3><p>{t("install.successCopy")}</p><code>{result.id}</code><footer><button className="button primary" onClick={onClose}>{t("install.done")}</button></footer></section>
      ) : null}
      {(inspect.error || planMutation.error || commit.error) ? <p className="form-error" role="alert">{String(inspect.error ?? planMutation.error ?? commit.error)}</p> : null}
    </div>
  );
}
