export function SeverityBadge({ severity }: { severity: "info" | "warning" | "error" | "critical" }) {
  return <span className="severity-badge" data-severity={severity}>{severity}</span>;
}
