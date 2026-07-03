import {
  AlertTriangle,
  Boxes,
  ChevronLeft,
  ChevronRight,
  History,
  LayoutDashboard,
  Settings2
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { useI18n } from "../i18n/catalog.js";
import { usePreferences } from "../theme/preferences.js";

function useNarrowLayout(): boolean {
  const query = "(max-width: 900px)";
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia === "function" && matchMedia(query).matches
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia(query);
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return narrow;
}

export function Sidebar() {
  const { t } = useI18n();
  const { preferences, update } = usePreferences();
  const narrow = useNarrowLayout();
  const expanded =
    preferences.sidebar === "expanded" ||
    (preferences.sidebar === "auto" && !narrow);
  const overlay = narrow && expanded;
  const close = () => update({ sidebar: "collapsed" });

  useEffect(() => {
    if (!overlay) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlay]);

  const navigation = [
    ["/", t("nav.overview"), LayoutDashboard],
    ["/skills", t("nav.skills"), Boxes],
    ["/findings", t("nav.findings"), AlertTriangle],
    ["/history", t("nav.history"), History],
    ["/settings", t("nav.settings"), Settings2]
  ] as const;

  return (
    <>
      {overlay ? (
        <button className="sidebar-scrim" aria-label={t("sidebar.collapse")} onClick={close} />
      ) : null}
      <aside className="sidebar" data-expanded={expanded} data-overlay={overlay}>
        <nav
          className="nav-list"
          aria-label={t("nav.primary")}
          data-overlay={overlay}
        >
          {navigation.map(([to, label, Icon]) => (
            <NavLink
              className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
              end={to === "/"}
              key={to}
              onClick={() => { if (overlay) close(); }}
              title={label}
              to={to}
            >
              <Icon size={18} aria-hidden="true" />
              {expanded ? <span className="nav-label">{label}</span> : null}
            </NavLink>
          ))}
        </nav>
        <button
          className="sidebar-toggle"
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")}
          title={expanded ? t("sidebar.collapse") : t("sidebar.expand")}
          onClick={() => update({ sidebar: expanded ? "collapsed" : "expanded" })}
        >
          {expanded ? <ChevronLeft size={17} /> : <ChevronRight size={17} />}
          {expanded ? <span>{t("sidebar.collapse")}</span> : null}
        </button>
      </aside>
    </>
  );
}
