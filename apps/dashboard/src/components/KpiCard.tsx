import type { ReactNode } from "react";

export type SemanticStatus = "neutral" | "positive" | "attention" | "risk";

export function KpiCard({
  label,
  value,
  detail,
  status = "neutral",
  hero = false,
  icon
}: {
  label: string;
  value: string;
  detail?: string;
  status?: SemanticStatus;
  hero?: boolean;
  icon?: ReactNode;
}) {
  const summary = `${label}: ${value}${detail ? `. ${detail}` : ""}`;
  return (
    <article
      className={`kpi-card${hero ? " hero" : ""}`}
      data-status={status}
      aria-label={summary}
    >
      <div className="kpi-topline"><span>{label}</span>{icon}</div>
      <strong className="kpi-value">{value}</strong>
      {detail ? <span className="kpi-detail">{detail}</span> : null}
    </article>
  );
}
