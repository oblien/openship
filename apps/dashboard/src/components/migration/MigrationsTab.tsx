"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  Plus,
  XCircle,
} from "lucide-react";
import {
  dockerMigrationApi,
  type MigrationRun,
  type MigrationStatus,
} from "@/lib/api/server-migration";
import { systemApi } from "@/lib/api";
import { formatBytes } from "@/lib/formatBytes";
import { useI18n } from "@/components/i18n-provider";
import { ServerConnectionCard } from "@/app/(dashboard)/servers/[serverId]/_components/connection-card";
import { ServerMigrationWizard } from "./ServerMigrationWizard";

const IN_FLIGHT: MigrationStatus[] = [
  "queued",
  "adopting",
  "moving_data",
  "deploying",
  "verifying",
  "awaiting_cutover",
  "cutover",
];
const isInFlight = (s: MigrationStatus) => IN_FLIGHT.includes(s);

/** Status → theme-aware tone + icon (semantic tokens, never hardcoded colors). */
function statusTone(status: MigrationStatus): {
  text: string;
  bg: string;
  Icon: React.ElementType;
  spin?: boolean;
} {
  if (status === "succeeded")
    return { text: "text-success", bg: "bg-success-bg", Icon: CheckCircle2 };
  if (status === "failed" || status === "rolled_back")
    return { text: "text-danger", bg: "bg-danger-bg", Icon: XCircle };
  if (status === "awaiting_cutover" || status === "partial")
    return { text: "text-warning", bg: "bg-warning-bg", Icon: AlertTriangle };
  if (status === "queued")
    return { text: "text-muted-foreground", bg: "bg-muted", Icon: Clock };
  return { text: "text-warning", bg: "bg-warning-bg", Icon: Loader2, spin: true };
}

function relTime(iso?: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "";
  }
}

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
  const anyInFlight = Boolean(runs?.some((r) => isInFlight(r.status)));
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

  const peerName = (run: MigrationRun): string | null => {
    if (run.mode === "same_server") return tab.inPlace;
    const peerId = run.targetServerId === serverId ? run.sourceServerId : run.targetServerId;
    return peerId ? (names[peerId] ?? tab.crossServer) : tab.crossServer;
  };

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
        <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/50 bg-card">
          {runs.map((run) => {
            const tone = statusTone(run.status);
            const bytes = run.bytesMoved ? formatBytes(run.bytesMoved) : null;
            return (
              <button
                key={run.id}
                onClick={() => setFlow({ runId: run.id })}
                className="flex w-full items-center gap-3.5 px-5 py-4 text-left transition hover:bg-muted/40"
              >
                <span
                  className={`inline-flex size-9 shrink-0 items-center justify-center rounded-full ${tone.bg} ${tone.text}`}
                >
                  <tone.Icon className={`size-[18px] ${tone.spin ? "animate-spin" : ""}`} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[15px] font-medium text-foreground">
                      {run.projectName || "—"}
                    </span>
                    <span className={`shrink-0 text-xs font-medium ${tone.text}`}>
                      {tab.status[run.status] ?? run.status}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      {names[serverId] ?? tab.crossServer}
                      <ArrowRight className="size-3" />
                      {peerName(run)}
                    </span>
                    <span>·</span>
                    <span>{relTime(run.startedAt)}</span>
                    {bytes && (
                      <>
                        <span>·</span>
                        <span className="tabular-nums">{bytes}</span>
                      </>
                    )}
                  </div>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </div>
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
