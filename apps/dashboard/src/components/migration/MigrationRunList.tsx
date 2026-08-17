"use client";

import { AlertTriangle, ArrowRight, CheckCircle2, ChevronRight, Clock, Loader2, XCircle } from "lucide-react";

import { useI18n } from "@/components/i18n-provider";
import { formatBytes } from "@/lib/formatBytes";
import type { MigrationRun, MigrationStatus } from "@/lib/api/server-migration";

/**
 * Migration history as rows — the ONE list, rendered from either entry point.
 *
 * A run is a fact about two servers and (for a project move) a project, so "recent migrations"
 * is a question a server tab and a project tab both ask. They were only ever going to differ in
 * one line of each row: on a server you already know one end, so the row reads "this server →
 * the other one"; on a project neither end is implied, so it reads "source → target". That is
 * the `viewpoint` below, and it is the entire difference — status tone, bytes, timestamps and
 * the click target are shared, which is why this is a component and not a second list.
 */
const IN_FLIGHT: MigrationStatus[] = [
  "queued",
  "adopting",
  "moving_data",
  "deploying",
  "verifying",
  "awaiting_cutover",
  "cutover",
];

/** Is this run still going (or parked waiting for someone)? Drives the caller's poll. */
export const isRunInFlight = (s: MigrationStatus) => IN_FLIGHT.includes(s);

/** Status → theme-aware tone + icon (semantic tokens, never hardcoded colors). */
export function statusTone(status: MigrationStatus): {
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
  if (status === "queued") return { text: "text-muted-foreground", bg: "bg-muted", Icon: Clock };
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

export type RunListViewpoint =
  /** A server's tab: one end of every run is this server, so name only the other end. */
  | { kind: "server"; serverId: string }
  /** A project's tab: name both ends, since neither is implied by where you are. */
  | { kind: "project" };

export function MigrationRunList({
  runs,
  serverNames,
  viewpoint,
  onOpen,
}: {
  runs: MigrationRun[];
  /** server id → display name. Missing ids fall back to a generic label, never a raw id. */
  serverNames: Record<string, string>;
  viewpoint: RunListViewpoint;
  onOpen: (runId: string) => void;
}) {
  const { t } = useI18n();
  const tab = t.migration.tab;

  /** The "A → B" line, which is the only part that depends on where you're standing. */
  const route = (run: MigrationRun): { from: string; to: string } | null => {
    const name = (id?: string | null) => (id ? (serverNames[id] ?? tab.crossServer) : tab.crossServer);
    if (viewpoint.kind === "project") {
      // Same-server runs can't happen for a project move (it's refused up front), so there is
      // no in-place case to special-case here.
      return { from: name(run.sourceServerId), to: name(run.targetServerId) };
    }
    if (run.mode === "same_server") return null; // rendered as "in place" instead
    const peerId =
      run.targetServerId === viewpoint.serverId ? run.sourceServerId : run.targetServerId;
    return { from: name(viewpoint.serverId), to: name(peerId) };
  };

  return (
    <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/50 bg-card">
      {runs.map((run) => {
        const tone = statusTone(run.status);
        const bytes = run.bytesMoved ? formatBytes(run.bytesMoved) : null;
        const path = route(run);
        return (
          <button
            key={run.id}
            onClick={() => onOpen(run.id)}
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
                  {path ? (
                    <>
                      {path.from}
                      <ArrowRight className="size-3" />
                      {path.to}
                    </>
                  ) : (
                    tab.inPlace
                  )}
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
  );
}
