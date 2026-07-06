import { useMutation, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode
} from "react";
import { runScan } from "../../api/client.js";
import { useI18n } from "../../i18n/catalog.js";

interface ScanValue {
  isPending: boolean;
  failed: boolean;
  run(): void;
}

const ScanContext = createContext<ScanValue | null>(null);

export function ScanProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);
  const active = useRef(false);
  const scan = useMutation({
    mutationFn: runScan,
    onError: () => setFailed(true),
    onSuccess: (data) => {
      queryClient.setQueryData(["dashboard"], data);
      setFailed(false);
    },
    onSettled: () => { active.current = false; }
  });
  const run = () => {
    if (active.current) return;
    active.current = true;
    scan.mutate();
  };

  return (
    <ScanContext.Provider
      value={{
        failed,
        isPending: scan.isPending,
        run
      }}
    >
      {children}
    </ScanContext.Provider>
  );
}

export function useScan(): ScanValue {
  const value = useContext(ScanContext);
  if (!value) throw new Error("useScan must be used within ScanProvider");
  return value;
}

export function ScanStatusAlert() {
  const { t } = useI18n();
  const scan = useScan();
  if (!scan.failed) return null;

  return (
    <section className="global-scan-alert" role="alert" aria-atomic="true">
      <TriangleAlert size={18} aria-hidden="true" />
      <div>
        <strong>{t("app.scanErrorTitle")}</strong>
        <p>{t("app.scanErrorCopy")}</p>
      </div>
      <button className="button" type="button" disabled={scan.isPending} onClick={scan.run}>
        {scan.isPending ? t("app.scanning") : t("app.retryScan")}
      </button>
    </section>
  );
}
