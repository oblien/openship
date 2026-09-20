"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { dockerMigrationApi, type MigrationRun } from "@/lib/api/server-migration";
import { systemApi } from "@/lib/api";
import { useI18n } from "@/components/i18n-provider";
import { ServerConnectionCard } from "@/app/(dashboard)/servers/[serverId]/_components/connection-card";
import { ServerMigrationWizard } from "./ServerMigrationWizard";
// The rows themselves are shared with the project's own migration history — one list, two
// viewpoints. See MigrationRunList.
import { MigrationRunList, isRunInFlight } from "./MigrationRunList";

/**
 * Server-detail "Migrations" tab. Two in-page states, no modals:
 *   • list  — recent runs as rows (durable server truth) like a project's
 *             deployments; "New migration" starts the flow, a row opens that run.
 *   • flow  — the SAME `ServerMigrationWizard` (variant="tab") rendered in-page:
 *             a fresh scan-first migration when `runId` is unset, or an existing
 *             run's steps + logs when a row was clicked (incl. an ongoing one —
 *             it drops straight into the live progress, like a deployment).
 *
 * The wizard is one reusable component (tab here, modal elsewhere e.g. Library);
 * this tab adds only the list — no duplicated flow/progress/detail code.
 */
export function MigrationsTab({
  serverId,
  server,
}: {
  serverId: string;
  server?: {
    sshHost: string;
    sshPort?: number | null;
    sshUser?: string | null;
    sshAuthMethod?: string | null;
  } | null;
}) {
  const { t } = useI18n();
  const m = t.migration;
  const tab = m.tab;

  const [runs, setRuns] = useState<MigrationRun[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  // null = list; {} = new migration (scan first); {runId} = open that run.
  const [flow, setFlow] = useState<{ runId?: string } | null>(null);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await dockerMigrationApi.list(serverId);
      setRuns(res.runs);
    } catch {
      setRuns((prev) => prev ?? []);
    }
  }, [serverId]);

  useEffect(() => {
    void fetchRuns();
    void systemApi
      .listServers()
      .then((list) => {
        const map: Record<string, string> = {};
        for (const s of list) if (s.name) map[s.id] = s.name;
        setNames(map);
      })
      .catch(() => {});
  }, [fetchRuns]);

  // Poll while anything is in flight (and only while showing the list) so the
  // rows reflect live status without a second stream.
  const anyInFlight = Boolean(runs?.some((r) => isRunInFlight(r.status)));
  useEffect(() => {
    if (flow || !anyInFlight) return;
    const iv = setInterval(() => void fetchRuns(), 3500);
    return () => clearInterval(iv);
  }, [flow, anyInFlight, fetchRuns]);

  const backToList = () => {
    setFlow(null);
    void fetchRuns();
  };

  // ── In-page flow (reused wizard) ── the wizard renders the "← Back" inline in
  // its own header rows (via onBack), so it never adds a row that pushes down.
  if (flow) {
    return (
      <ServerMigrationWizard
        variant="tab"
        serverId={serverId}
        server={server}
        initialRunId={flow.runId}
        onClose={backToList}
        onBack={backToList}
      />
    );
  }

  if (runs === null) {
    return (
      <div className="flex items-center justify-center rounded-2xl border border-border/50 bg-card py-16 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  // No migrations yet → land STRAIGHT on the scan view (no separate "New
  // migration" step). The wizard shows the main migration illustration + the
  // scan card, renders found containers inline, and drops into live progress on
  // start; Close returns to the now-populated list. `flow` is only used once
  // runs exist — to open a row, or to start another via "New migration".
  if (runs.length === 0) {
    return <ServerMigrationWizard variant="tab" serverId={serverId} server={server} onClose={backToList} />;
  }

  // ── List ── existing runs on the left; Connection card + "New migration"
  // (which opens the same scan view, with a Back) on the right. The tab spans
  // full width, so the right column lives here, not the page's global sidebar.
  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0">
        <MigrationRunList
          runs={runs}
          serverNames={names}
          viewpoint={{ kind: "server", serverId }}
          onOpen={(runId) => setFlow({ runId })}
        />
      </div>

      <div className="space-y-3 lg:sticky lg:top-6 lg:self-start">
        {server && <ServerConnectionCard server={server} />}
        <button
          onClick={() => setFlow({})}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
        >
          <Plus className="size-4" />
          {tab.new}
        </button>
      </div>
    </div>
  );
}
