"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, RefreshCw } from "lucide-react";
import { systemApi, type ServerContainerStatus } from "@/lib/api/system";
import { ContainerStatusRow, EdgeInstallRow } from "@/components/infra/ContainerStatusRow";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useReattachActiveFix } from "@/hooks/useReattachActiveFix";

/**
 * Per-server managed-container versions (edge / mail). Unlike ServerModuleUpdates
 * — which only surfaces when something is behind — this ALWAYS renders when a
 * container is detected, so opening a server shows the running version vs the
 * version this control plane pins (the target), whether or not an update is due.
 * Rows are the shared `ContainerStatusRow` (identical rendering to the global
 * Infrastructure tab). Self-contained (fetches its own row set) so it doesn't
 * thread through the ComponentsTab prop list.
 *
 * The header carries a Scan that re-probes THIS box and refreshes its cached
 * rows (detect-only — never applies). The scan is the only per-server write path
 * to the drift cache the operator can trigger by hand; the roll-up in Settings →
 * Infrastructure does the same across the whole fleet.
 */
export function ServerContainerUpdates({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<ServerContainerStatus[]>([]);
  const [projectCount, setProjectCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await systemApi.listServerContainers(serverId));
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh recovery for an in-flight image swap (edge/mail update or mail
  // repair). Container-apply ONLY — NOT install: the parent server page already
  // re-attaches the install/repair session into the setup wizard, so passing
  // install here would open a second UI for the same run. Pre-filter to rows the
  // cache marks in-progress to skip a request per idle row.
  const applyTargets = useMemo(
    () =>
      rows
        .filter((r) => r.latestInProgress)
        .map((r) => ({ serverId, component: r.component })),
    [rows, serverId],
  );
  useReattachActiveFix({ containerTargets: applyTargets });

  // projectCount decides whether an ABSENT edge is an issue (box hosts projects)
  // or just an offer — same rule the fleet view uses. Read once; cheap.
  useEffect(() => {
    void systemApi
      .getServerById(serverId)
      .then((s) => setProjectCount(s.projectCount ?? 0))
      .catch(() => {});
  }, [serverId]);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      await systemApi.scanServerContainers(serverId);
      await load();
    } catch {
      // Best-effort: a transient probe failure leaves the cached rows in place
      // (the server never wipes a row it couldn't re-confirm), so keep showing them.
    } finally {
      setScanning(false);
    }
  }, [serverId, load]);

  const hasEdge = rows.some((r) => r.component === "edge");
  // Render once loaded if there's anything to show OR an edge to offer. A bare,
  // never-scanned box with an edge already present (nothing else) stays hidden.
  if (loading || (rows.length === 0 && hasEdge)) return null;

  const behindCount = rows.filter((r) => r.behind).length;
  const c = t.servers.containers;

  return (
    <div className="mb-5 rounded-2xl border border-border/50 bg-card">
      <div className="flex items-center gap-3 border-b border-border/50 px-5 py-4">
        <div className="flex size-9 items-center justify-center rounded-xl bg-muted">
          <Boxes className="size-[18px] text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-foreground">
            {t.servers.list.infra.title}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {behindCount === 0
              ? c.subtitle
              : behindCount === 1
                ? c.updatesAvailableOne
                : interpolate(c.updatesAvailableMany, { n: String(behindCount) })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void scan()}
          disabled={scanning}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${scanning ? "animate-spin" : ""}`} />
          {scanning ? c.scanning : c.scan}
        </button>
      </div>
      <div className="space-y-2 p-5">
        {rows.map((r) => (
          <ContainerStatusRow key={r.id} serverId={serverId} row={r} onApplied={() => void load()} />
        ))}
        {!hasEdge && (
          <EdgeInstallRow
            serverId={serverId}
            emphasize={projectCount > 0}
            onInstalled={() => void load()}
          />
        )}
      </div>
    </div>
  );
}
