"use client";

import { Activity } from "lucide-react";

import type { IssueScope, IssueSeverity, SystemIssue } from "@/lib/api/issues";
import { useI18n } from "@/components/i18n-provider";
import { SCOPE_ICON, SCOPE_ORDER } from "./issueMeta";

/**
 * The feed's right rail — a read-only roll-up of the same list the panels show.
 *
 * It reads the UNFILTERED list on purpose, so the summary stays a fixed picture of
 * the whole while a severity filter narrows the panels beside it — the rule the facet
 * strip already follows. Two cuts the panels don't give you at a glance: the severity
 * MIX as one bar, and the blast radius BY AREA, worst-scope first.
 *
 * Nothing here decides anything — severity and scope arrived on each item; this only
 * counts them. When there are no issues the page shows its empty state instead, so
 * this never renders a column of zeros.
 */

/** Severity order (worst first) + the tone each carries in the bar and the dot.
 *  Advisory is neutral, never amber — the same call `AlertPanel` makes for a group
 *  that sits beside a louder one. */
const SEVERITY_ROWS: Array<{
  key: IssueSeverity;
  filter: "outage" | "action_required" | "advisory";
  bar: string;
  dot: string;
}> = [
  { key: "outage", filter: "outage", bar: "bg-danger-solid", dot: "bg-danger-solid" },
  { key: "action_required", filter: "action_required", bar: "bg-warning-solid", dot: "bg-warning-solid" },
  { key: "advisory", filter: "advisory", bar: "bg-muted-foreground/40", dot: "bg-muted-foreground/50" },
];

export function IssueSummary({
  issues,
  tab,
}: {
  issues: SystemIssue[];
  tab: "open" | "resolved";
}) {
  const { t } = useI18n();
  const c = t.issues;

  const total = issues.length;
  const sevCount: Record<IssueSeverity, number> = {
    outage: 0,
    action_required: 0,
    advisory: 0,
  };
  const scopeCount = {} as Record<IssueScope, number>;
  for (const issue of issues) {
    sevCount[issue.severity] += 1;
    scopeCount[issue.scope] = (scopeCount[issue.scope] ?? 0) + 1;
  }
  // Only the scopes that actually carry something, worst-blast-radius first — a "0"
  // beside "Domains" is not an issue area, it's noise.
  const areas = SCOPE_ORDER.map((scope) => ({ scope, n: scopeCount[scope] ?? 0 })).filter(
    (a) => a.n > 0,
  );

  return (
    <div className="rounded-2xl border border-border/50 bg-card">
      <div className="flex items-center gap-3 border-b border-border/50 px-5 py-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
          <Activity className="size-[18px] text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-foreground">{c.summary.title}</h2>
          <p className="text-xs text-muted-foreground">{c.summary.subtitle}</p>
        </div>
      </div>

      <div className="space-y-5 p-5">
        {/* Headline + severity mix as one bar. */}
        <div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold tabular-nums text-foreground">{total}</span>
            <span className="text-sm text-muted-foreground">
              {tab === "resolved" ? c.summary.totalResolved : c.summary.totalOpen}
            </span>
          </div>
          <div className="mt-2.5 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
            {SEVERITY_ROWS.map((s) =>
              sevCount[s.key] > 0 ? (
                <div
                  key={s.key}
                  className={`h-full ${s.bar} transition-[width] duration-500`}
                  style={{ width: `${(sevCount[s.key] / total) * 100}%` }}
                />
              ) : null,
            )}
          </div>
        </div>

        {/* By severity — all three stay listed so "0 outages" reads as reassurance,
            greyed rather than tinted so an empty tier never looks like an alarm. */}
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
            {c.summary.bySeverity}
          </p>
          <div className="space-y-0.5">
            {SEVERITY_ROWS.map((s) => {
              const n = sevCount[s.key];
              return (
                <div key={s.key} className="flex items-center justify-between py-1.5">
                  <span className="inline-flex items-center gap-2.5 text-sm">
                    <span
                      className={`size-2 rounded-full ${n > 0 ? s.dot : "bg-muted-foreground/25"}`}
                    />
                    <span className={n > 0 ? "text-muted-foreground" : "text-muted-foreground/50"}>
                      {c.filters[s.filter]}
                    </span>
                  </span>
                  <span
                    className={`text-sm font-medium tabular-nums ${
                      n > 0 ? "text-foreground" : "text-muted-foreground/40"
                    }`}
                  >
                    {n}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* By area — the blast radius, worst scope first. */}
        {areas.length > 0 && (
          <div className="border-t border-border/50 pt-4">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
              {c.summary.byArea}
            </p>
            <div className="space-y-0.5">
              {areas.map(({ scope, n }) => {
                const Icon = SCOPE_ICON[scope];
                return (
                  <div key={scope} className="flex items-center justify-between py-1.5">
                    <span className="inline-flex items-center gap-2.5 text-sm text-muted-foreground">
                      <Icon className="size-4 text-muted-foreground/60" />
                      {c.scopes[scope]}
                    </span>
                    <span className="text-sm font-medium tabular-nums text-foreground">{n}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
