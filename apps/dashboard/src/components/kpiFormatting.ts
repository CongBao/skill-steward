import type { KpiResult } from "../api/client.js";

export function formatKpiValue(kpi: KpiResult | undefined, locale: string): string {
  if (!kpi) return "—";
  if (typeof kpi.value === "number") {
    if (kpi.id === "finding-confidence") return `${kpi.value}%`;
    return new Intl.NumberFormat(locale, {
      notation: kpi.value >= 1_000 ? "compact" : "standard",
      maximumFractionDigits: 1
    }).format(kpi.value);
  }
  if (Array.isArray(kpi.value)) return String(kpi.value.at(0)?.value ?? 0);
  if ("available" in kpi.value && "total" in kpi.value) {
    return `${kpi.value.available}/${kpi.value.total}`;
  }
  if ("tokens" in kpi.value) {
    return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(
      kpi.value.tokens ?? 0
    );
  }
  return Object.entries(kpi.value).map(([key, value]) => `${key} ${value}`).join(" · ");
}
