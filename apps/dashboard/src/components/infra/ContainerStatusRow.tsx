"use client";

import { ArrowUpCircle, RefreshCw, CheckCircle2, CircleSlash, Wrench, Download } from "lucide-react";
import { type ServerContainerStatus } from "@/lib/api/system";
import { useI18n } from "@/components/i18n-provider";
import { useInfraFix } from "@/hooks/useInfraFix";
import { useServerEdgeInstallModal } from "@/hooks/useSystemPrepareModal";

/**
 * One managed-container row (edge / mail): label, running→pinned version, and the
 * right-hand state — Update (behind), Fix (down but startable), Stopped (down and
 * gone), or Up to date. The single presentational unit shared by the per-server
 * Components view and the fleet views so all of them render drift identically, and
 * every action goes through {@link useInfraFix} so a click resumes the same
 * replayable server-side session no matter which surface started it.
 */
export function ContainerStatusRow({
  serverId,
  row,
  onApplied,
}: {
  serverId: string;
  row: ServerContainerStatus;
  onApplied?: () => void;
}) {
  const fix = useInfraFix();
  const { t } = useI18n();
  const c = t.servers.containers;
  const label = row.component === "mail" ? c.componentMail : c.componentEdge;
  const busy = row.latestInProgress;
  const down = Boolean(row.detail?.down);
  // A LEGACY host-native mail engine: systemd Postfix/Dovecot, no image at all. It
  // has no version to show and can never be "behind", so the version line names the
  // topology instead of rendering an empty ref, and a healthy one reads "Running"
  // rather than "Up to date" (it isn't on the pinned image — there is no image).
  // It is still startable in place, so it keeps the same Fix button.
  const legacy = row.detail?.flavor === "host";
  // A down component is one-click fixable while its container still EXISTS: the
  // edge recreates itself through the takeover-aware install path, and a stopped
  // mail engine just needs starting. A MISSING mail container is not offered a fix
  // — recreating it needs the secrets only mail setup holds, so it would clobber a
  // live mailbox. `behind` takes precedence: an update also restarts the container.
  const fixable = down && !row.behind && !(row.component === "mail" && row.detail?.containerMissing);

  return (
    <div className="flex items-center gap-3 rounded-xl bg-muted/30 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {down && (
            <span className="rounded-full bg-danger-bg px-1.5 py-0.5 text-[10px] font-medium text-danger">
              {c.down}
            </span>
          )}
        </div>
        {legacy ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{c.legacyEngine}</p>
        ) : (
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            {row.runningVersion ?? "—"}
            {row.behind && <span className="text-warning"> → {row.pinnedVersion ?? "—"}</span>}
          </p>
        )}
        {down && !fixable && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {row.component === "mail" ? c.goneMail : c.goneEdge}
          </p>
        )}
      </div>
      {row.behind ? (
        <button
          type="button"
          onClick={() =>
            fix({ serverId, component: row.component, action: "update", label }, { onDone: onApplied })
          }
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-warning-bg px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/20 disabled:opacity-50"
        >
          {busy ? (
            <RefreshCw className="size-3.5 animate-spin" />
          ) : (
            <ArrowUpCircle className="size-3.5" />
          )}
          {busy ? c.updating : c.update}
        </button>
      ) : fixable ? (
        <button
          type="button"
          onClick={() =>
            fix({ serverId, component: row.component, action: "repair", label }, { onDone: onApplied })
          }
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-danger-bg px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
        >
          {busy ? <RefreshCw className="size-3.5 animate-spin" /> : <Wrench className="size-3.5" />}
          {busy ? c.starting : c.fix}
        </button>
      ) : down ? (
        // Down with no safe fix: don't claim "Up to date" (it isn't serving).
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <CircleSlash className="size-3.5" />
          {c.stopped}
        </span>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-success">
          <CheckCircle2 className="size-3.5" />
          {legacy ? c.running : c.upToDate}
        </span>
      )}
    </div>
  );
}

/**
 * Absent-edge affordance: there is no {@link ServerContainerStatus} row when a
 * server has no edge at all, so the group-level view renders this instead — a
 * one-click **Install** that runs the SAME first-install path (install + 80/443
 * takeover consent). `emphasize` styles it as an alarm (the server hosts projects
 * so it's a real issue); otherwise it's a quiet offer.
 */
export function EdgeInstallRow({
  serverId,
  emphasize,
  onInstalled,
}: {
  serverId: string;
  emphasize?: boolean;
  onInstalled?: () => void;
}) {
  const openEdgeInstall = useServerEdgeInstallModal();
  const { t } = useI18n();
  const c = t.servers.containers;
  return (
    <div className="flex items-center gap-3 rounded-xl bg-muted/30 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium text-foreground">{c.componentEdge}</span>
        <p className={`mt-0.5 text-xs ${emphasize ? "text-warning" : "text-muted-foreground"}`}>
          {c.notInstalled}
        </p>
      </div>
      <button
        type="button"
        onClick={() => openEdgeInstall(serverId, { onDone: onInstalled })}
        className={
          emphasize
            ? "inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-warning-bg px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/20"
            : "inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-muted/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        }
      >
        <Download className="size-3.5" />
        {c.installEdge}
      </button>
    </div>
  );
}
