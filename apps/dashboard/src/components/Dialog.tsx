import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { useI18n } from "../i18n/catalog.js";

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) {
  const { t } = useI18n();
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <header><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label={t("dialog.close")} onClick={onClose}><X size={18} /></button></header>
        {children}
      </section>
    </div>
  );
}
