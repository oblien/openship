"use client";

import {
  Activity,
  AlertCircle,
  ArrowRight,
  Loader2,
  Mail,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { useI18n, interpolate } from "@/components/i18n-provider";

export interface MailServerListItem {
  id: string;
  name: string;
  host: string;
  domain: string | null;
  completed: boolean;
  active: boolean;
  /** Step an incomplete install paused at + its label, for the status line. */
  resumeStep?: number | null;
  resumeStepLabel?: string | null;
}

/** `ring` is a BORDER colour: the state marker is a hollow circle, same as the
 *  servers list — see STATUS in servers/page.tsx. */
type Tone = { text: string; ring: string; label: string; pulse?: boolean };

/**
 * The mail-server registry view: one row per server in the `mail_servers`
 * table. Shown when more than one mail server exists (a single one auto-opens).
 * A row opens that server's admin/status; "Add mail server" routes into the
 * provision/adopt flow; the row's ⋯ menu detaches a stale/mismarked entry
 * (DB-only, re-adoptable) — deliberately not a bare trash icon sitting in the
 * row, which put an irreversible-looking action one stray click from "open".
 */
export function MailServerList({
  servers,
  onOpen,
  onAddNew,
  onRemove,
}: {
  servers: MailServerListItem[];
  onOpen: (serverId: string) => void;
  onAddNew: () => void;
  onRemove: (server: MailServerListItem) => void;
}) {
  const { t } = useI18n();
  const sl = t.emails.serverList;

  const installing = servers.filter((s) => s.active).length;
  const running = servers.filter((s) => s.completed && !s.active).length;
  const incomplete = servers.length - running - installing;
  const runningPct = servers.length ? Math.round((running / servers.length) * 100) : 0;

  const toneOf = (s: MailServerListItem): Tone =>
    s.active
      ? { text: "text-info", ring: "border-info-solid", label: sl.installing, pulse: true }
      : s.completed
        ? { text: "text-success", ring: "border-success-solid", label: sl.running }
        : { text: "text-warning", ring: "border-warning-solid", label: sl.incomplete };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      {/* ── LEFT: the registry ── */}
      <div className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-4 px-1">
          <h2 className="inline-flex items-baseline gap-2 text-sm font-medium text-muted-foreground">
            {sl.title}
            <span className="tabular-nums text-muted-foreground/50">{servers.length}</span>
          </h2>
          <button
            type="button"
            onClick={onAddNew}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25"
          >
            <Plus className="size-4" />
            {sl.addServer}
          </button>
        </div>

        {/* No overflow-hidden: DropdownMenu renders in-flow, so it would clip the
            last row's menu. Corners come from first/last row rounding instead. */}
        <div className="rounded-2xl border border-border/50 bg-card">
          <ul className="divide-y divide-border/50">
            {servers.map((s) => {
              const label = s.domain || s.name;
              const tone = toneOf(s);
              const actions: MenuAction[] = [
                {
                  id: "open",
                  label: sl.open,
                  icon: <ArrowRight className="size-4 rtl:rotate-180" />,
                  onClick: () => onOpen(s.id),
                },
                { id: "sep", divider: true },
                {
                  id: "remove",
                  label: sl.removeFromList,
                  icon: <Trash2 className="size-4" />,
                  variant: "danger",
                  onClick: () => onRemove(s),
                },
              ];
              return (
                <li
                  key={s.id}
                  className="group relative flex items-center gap-4 px-5 py-4 transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-foreground/[0.03]"
                >
                  {/* The whole row opens the server; the action cluster below sits
                      above this overlay (z-10) so ⋯ never triggers navigation. */}
                  <button
                    type="button"
                    onClick={() => onOpen(s.id)}
                    aria-label={interpolate(sl.openAria, { name: label })}
                    className="absolute inset-0 z-0 cursor-pointer rounded-[inherit]"
                  />

                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
                    <Mail className="size-4" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{label}</p>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground/80">
                      {s.host}
                    </p>
                  </div>

                  {/* Where an incomplete install stopped — the "why" behind the
                      Incomplete state. Hidden on the narrowest screens (the dot
                      still conveys state there). */}
                  {!s.completed && !s.active && s.resumeStep ? (
                    <div className="hidden min-w-0 max-w-[38%] flex-col items-end text-end sm:flex">
                      <span className="text-xs font-medium text-warning">
                        {interpolate(sl.stoppedAt, { step: String(s.resumeStep) })}
                      </span>
                      {s.resumeStepLabel && (
                        <span className="mt-0.5 truncate text-xs text-muted-foreground/60">
                          {s.resumeStepLabel}
                        </span>
                      )}
                    </div>
                  ) : null}

                  <span
                    title={tone.label}
                    className={`inline-flex shrink-0 items-center gap-2 text-xs font-medium ${tone.text}`}
                  >
                    <span
                      className={`size-2.5 rounded-full border-2 ${tone.ring} ${tone.pulse ? "animate-pulse" : ""}`}
                    />
                    <span className="hidden sm:inline">{tone.label}</span>
                  </span>

                  <div
                    className="relative z-10 flex shrink-0 items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DropdownMenu
                      align="right"
                      actions={actions}
                      triggerLabel={interpolate(sl.actionsAria, { name: label })}
                    />
                    <ArrowRight className="size-4 text-muted-foreground/30 transition-colors group-hover:text-muted-foreground/60 rtl:rotate-180" />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* ── RIGHT: registry roll-up (app's list + right-rail pattern) ── */}
      <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <div className="rounded-2xl border border-border/50 bg-card p-5">
          <div className="mb-4 flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">{sl.overviewTitle}</h3>
          </div>

          <div className="flex items-baseline justify-between">
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold tabular-nums text-foreground">{running}</span>
              <span className="text-sm text-muted-foreground">
                / {servers.length} {sl.running}
              </span>
            </div>
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {runningPct}%
            </span>
          </div>
          <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-success-solid transition-[width] duration-500"
              style={{ width: `${runningPct}%` }}
            />
          </div>

          <div className="mt-4 space-y-0.5 border-t border-border/50 pt-4">
            <StatRow icon={Server} label={sl.title} value={servers.length} />
            {installing > 0 && (
              <StatRow icon={Loader2} spin tone="text-info" label={sl.installing} value={installing} />
            )}
            {incomplete > 0 && (
              <StatRow icon={AlertCircle} tone="text-warning" label={sl.incomplete} value={incomplete} />
            )}
          </div>

          <p className="mt-4 text-xs leading-relaxed text-muted-foreground/60">{sl.hint}</p>
        </div>
      </div>
    </div>
  );
}

function StatRow({
  icon: Icon,
  label,
  value,
  tone,
  spin,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  tone?: string;
  spin?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className={`inline-flex items-center gap-2.5 text-sm ${tone ?? "text-muted-foreground"}`}>
        <Icon
          className={`size-4 ${tone ?? "text-muted-foreground/60"} ${spin ? "animate-spin" : ""}`}
        />
        {label}
      </span>
      <span className="text-sm font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export default MailServerList;
