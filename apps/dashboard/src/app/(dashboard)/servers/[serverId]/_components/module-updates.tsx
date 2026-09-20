"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, RefreshCw, AlertTriangle } from "lucide-react";
import { systemApi, type ServerModuleStatus } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";
import { useModal } from "@/context/ModalContext";
import { useI18n, interpolate } from "@/components/i18n-provider";

/**
 * Rows this card has something to say about: an update is due, or the check that
 * would have told us couldn't answer (`detail.note`).
 *
 * A note-only row has to be here. `behind` is false whenever the dry run failed —
 * a refused host channel, an unreadable manifest, a catalog with no verified
 * signature — so filtering on `behind` alone rendered nothing, and a card that says
 * nothing is read as "up to date" on a box we never managed to check.
 */
export function visibleModuleRows(mods: ServerModuleStatus[]): ServerModuleStatus[] {
  return mods.filter((m) => m.behind || Boolean(m.detail?.note));
}

/**
 * The card itself, separated from the fetch so it renders from a fixed row set
 * (and can be asserted on without a DOM).
 */
export function ModuleUpdatesCard({
  rows,
  busy,
  onUpdate,
}: {
  rows: ServerModuleStatus[];
  busy: string | null;
  onUpdate: (m: ServerModuleStatus) => void;
}) {
  const { t } = useI18n();
  const m = t.servers.modules;
  const behindCount = rows.filter((r) => r.behind).length;
  const HeadIcon = behindCount > 0 ? ArrowUpCircle : AlertTriangle;

  return (
    <div className="rounded-2xl border border-warning-border bg-warning-bg/40 p-4 mb-5">
      <div className="flex items-center gap-2 mb-3">
        <HeadIcon className="size-4 text-warning" />
        <h3 className="text-sm font-semibold text-foreground">
          {behindCount > 0 ? m.title : m.checkFailedTitle}
        </h3>
        <span className="text-xs text-muted-foreground">
          ({behindCount > 0 ? behindCount : rows.length})
        </span>
      </div>
      <div className="space-y-2">
        {rows.map((row) => {
          const consent = row.detail?.pendingConsent ?? [];
          const note = row.detail?.note;
          const isBusy = busy === row.moduleName || row.latestInProgress;
          return (
            <div
              key={row.moduleName}
              className="flex items-center gap-3 rounded-xl border border-border/50 bg-card px-3.5 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground capitalize">{row.moduleName}</span>
                  {consent.length > 0 && (
                    <span
                      title={consent.map((c) => c.warning ?? c.id).join("; ")}
                      className="inline-flex items-center gap-1 rounded-full bg-warning-bg px-1.5 py-0.5 text-[10px] font-medium text-warning"
                    >
                      <AlertTriangle className="size-2.5" />
                      {m.needsConfirmation}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {row.currentLabel ?? row.migrationVersion ?? "—"} →{" "}
                  {row.latestLabel ?? row.availableVersion ?? "—"}
                </p>
                {/* Verbatim: the API's own diagnosis, in the words of whichever layer
                    classified it — re-wording it here would make one fault read
                    differently on every surface. */}
                {note && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-warning">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                    <span className="min-w-0 break-words">{note}</span>
                  </p>
                )}
              </div>
              {row.behind && (
                <button
                  type="button"
                  onClick={() => onUpdate(row)}
                  disabled={isBusy}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-warning-bg px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/20 disabled:opacity-50"
                >
                  {isBusy ? <RefreshCw className="size-3.5 animate-spin" /> : <ArrowUpCircle className="size-3.5" />}
                  {isBusy ? m.updating : m.update}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Per-server native-module updates. Self-contained (fetches its own data) so it
 * doesn't thread through the large ComponentsTab prop list. Renders nothing when
 * there's neither an update nor a failed check — it only appears when there's
 * something to do or something to know. Mirrors the home UpdatesBlock's
 * "current → available + Update" pattern; consent-tier migrations show their
 * warning and require a confirm before applying.
 */
export function ServerModuleUpdates({ serverId }: { serverId: string }) {
  const { t } = useI18n();
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
          showToast(
            res.error || interpolate(t.servers.modules.updateFailed, { module: m.moduleName }),
            "error",
          );
        }
      } catch {
        showToast(interpolate(t.servers.modules.updateFailed, { module: m.moduleName }), "error");
      } finally {
        setBusy(null);
        await load();
      }
    },
    [serverId, showToast, load, t],
  );

  const onUpdate = useCallback(
    (m: ServerModuleStatus) => {
      const consent = m.detail?.pendingConsent ?? [];
      if (consent.length === 0) return void runApply(m);
      // Consent-tier: surface the warning(s) and require an explicit confirm.
      const copy = t.servers.modules;
      const id = showModal({
        title: interpolate(copy.confirmTitle, { module: m.moduleName }),
        message:
          `${copy.confirmIntro}\n\n` +
          consent.map((c) => `• ${c.warning ?? c.id} (v${c.version})`).join("\n"),
        buttons: [
          { label: copy.cancel, variant: "secondary", onClick: () => hideModal(id) },
          {
            label: copy.update,
            variant: "danger",
            onClick: () => {
              hideModal(id);
              void runApply(m);
            },
          },
        ],
      });
    },
    [runApply, showModal, hideModal, t],
  );

  const rows = visibleModuleRows(mods);
  if (loading || rows.length === 0) return null;

  return <ModuleUpdatesCard rows={rows} busy={busy} onUpdate={onUpdate} />;
}
