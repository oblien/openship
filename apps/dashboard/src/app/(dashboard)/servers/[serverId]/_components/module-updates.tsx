"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, RefreshCw, AlertTriangle } from "lucide-react";
import { systemApi, type ServerModuleStatus } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";
import { useModal } from "@/context/ModalContext";

/**
 * Per-server native-module updates. Self-contained (fetches its own data) so it
 * doesn't thread through the large ComponentsTab prop list. Renders nothing when
 * no module is behind — it only appears when there's something to do. Mirrors the
 * home UpdatesBlock's "current → available + Update" pattern; consent-tier
 * migrations show their warning and require a confirm before applying.
 */
export function ServerModuleUpdates({ serverId }: { serverId: string }) {
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const [mods, setMods] = useState<ServerModuleStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMods(await systemApi.listServerModules(serverId));
    } catch {
      setMods([]);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runApply = useCallback(
    async (m: ServerModuleStatus) => {
      setBusy(m.moduleName);
      try {
        const res = await systemApi.applyServerModule(serverId, m.moduleName);
        if (res.ok) {
          showToast(`${m.moduleName}: ${res.fromVersion} → ${res.toVersion}`, "success");
        } else {
          showToast(res.error || `${m.moduleName} update failed`, "error");
        }
      } catch {
        showToast(`${m.moduleName} update failed`, "error");
      } finally {
        setBusy(null);
        await load();
      }
    },
    [serverId, showToast, load],
  );

  const onUpdate = useCallback(
    (m: ServerModuleStatus) => {
      const consent = m.detail?.pendingConsent ?? [];
      if (consent.length === 0) return void runApply(m);
      // Consent-tier: surface the warning(s) and require an explicit confirm.
      const id = showModal({
        title: `Update ${m.moduleName}?`,
        message:
          "This update includes changes that need your OK:\n\n" +
          consent.map((c) => `• ${c.warning ?? c.id} (v${c.version})`).join("\n"),
        buttons: [
          { label: "Cancel", variant: "secondary", onClick: () => hideModal(id) },
          {
            label: "Update",
            variant: "danger",
            onClick: () => {
              hideModal(id);
              void runApply(m);
            },
          },
        ],
      });
    },
    [runApply, showModal, hideModal],
  );

  const behind = mods.filter((m) => m.behind);
  if (loading || behind.length === 0) return null;

  return (
    <div className="rounded-2xl border border-warning-border bg-warning-bg/40 p-4 mb-5">
      <div className="flex items-center gap-2 mb-3">
        <ArrowUpCircle className="size-4 text-warning" />
        <h3 className="text-sm font-semibold text-foreground">
          Module updates available
        </h3>
        <span className="text-xs text-muted-foreground">({behind.length})</span>
      </div>
      <div className="space-y-2">
        {behind.map((m) => {
          const consent = m.detail?.pendingConsent ?? [];
          const isBusy = busy === m.moduleName || m.latestInProgress;
          return (
            <div
              key={m.moduleName}
              className="flex items-center gap-3 rounded-xl border border-border/50 bg-card px-3.5 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground capitalize">{m.moduleName}</span>
                  {consent.length > 0 && (
                    <span
                      title={consent.map((c) => c.warning ?? c.id).join("; ")}
                      className="inline-flex items-center gap-1 rounded-full bg-warning-bg px-1.5 py-0.5 text-[10px] font-medium text-warning"
                    >
                      <AlertTriangle className="size-2.5" />
                      needs confirmation
                    </span>
                  )}
                </div>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {m.currentLabel ?? m.migrationVersion ?? "—"} → {m.latestLabel ?? m.availableVersion ?? "—"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onUpdate(m)}
                disabled={isBusy}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-warning-border bg-warning-bg px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning-bg disabled:opacity-50"
              >
                {isBusy ? <RefreshCw className="size-3.5 animate-spin" /> : <ArrowUpCircle className="size-3.5" />}
                {isBusy ? "Updating…" : "Update"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
